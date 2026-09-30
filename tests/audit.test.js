import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveStore, MemoryStore, SuggestionQueue, projectHash } from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'
import { auditMemoryUsage } from '../lib/audit.js'
import { installApi } from '../lib/api.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-audit-test-'))
}

test('auditMemoryUsage reports memory/user and skips key without cwd', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    const report = auditMemoryUsage({ store })

    assert.deepEqual(report.tracks.map((row) => row.target), ['memory', 'user'])
    assert.equal(report.tracks.every((row) => row.entries === 0), true)
    assert.equal(report.overBudget.length, 0)
    assert.equal(report.needsHygiene, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('auditMemoryUsage flags over-budget tracks with byte size', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    writeFileSync(join(dir, 'MEMORY.md'), '0123456789', 'utf8')

    const report = auditMemoryUsage({ store, budgets: { memory: 4 } })
    const memory = report.tracks.find((row) => row.target === 'memory')

    assert.equal(memory.entries, 1)
    assert.equal(memory.bytes, 10)
    assert.equal(memory.overBudget, true)
    assert.deepEqual(report.overBudget, ['memory'])
    assert.equal(report.needsHygiene, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('auditMemoryUsage includes key when cwd is provided', () => {
  const dir = tempDir()
  try {
    const cwd = join(dir, 'proj')
    const keyDir = join(dir, 'projects', projectHash(cwd))
    mkdirSync(keyDir, { recursive: true })
    writeFileSync(join(keyDir, 'KEY.md'), 'project fact', 'utf8')

    const store = new MemoryStore(dir)
    const report = auditMemoryUsage({ store, cwd })

    assert.deepEqual(report.tracks.map((row) => row.target), ['memory', 'user', 'key'])
    assert.equal(report.tracks.find((row) => row.target === 'key').entries, 1)
    assert.equal(report.tracks.find((row) => row.target === 'key').bytes, 12)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function bootApi(overrides = {}) {
  const dir = tempDir()
  const store = new MemoryStore(dir)
  const archive = new ArchiveStore(dir)
  const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
  const todoStore = new TodoStore(dir)
  const state = { reviewEnabled: true, reviewInterval: 10, reviewMode: 'suggest', memoryTabEnabled: true }
  const getRuntime = () => ({ ...state })
  const updateRuntime = (patch) => {
    Object.assign(state, patch)
    return { ...state }
  }
  const ctx = {
    webServer: {
      register: ({ handler }) => {
        ctx.handler = handler
        return () => {}
      },
    },
  }
  installApi(ctx, {
    store,
    archive,
    queue,
    todoStore,
    getRuntime,
    updateRuntime,
    resolveRevealTarget: () => undefined,
    revealPath: () => {},
    config: overrides.config ?? { memoryDir: dir },
    resolveCwd: overrides.resolveCwd ?? (() => undefined),
    syncStatus: () => ({ enabled: false }),
    syncOps: null,
  })
  const server = createServer((req, res) => ctx.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (method, path) => {
    const res = await fetch(base + path, { method })
    return { status: res.status, data: await res.json().catch(() => ({})) }
  }
  return { base, request, dir, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('GET /api/audit returns a usage report', async () => {
  const api = await bootApi()
  try {
    writeFileSync(join(api.dir, 'USER.md'), 'profile fact', 'utf8')
    const res = await api.request('GET', '/memory-evolve/api/audit')

    assert.equal(res.status, 200)
    assert.equal(res.data.needsHygiene, false)
    assert.deepEqual(
      res.data.tracks.map((row) => row.target).sort(),
      ['memory', 'user'],
    )
    assert.equal(res.data.tracks.find((row) => row.target === 'user').entries, 1)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})
