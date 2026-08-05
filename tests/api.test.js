import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, SuggestionQueue } from '../lib/store.js'
import { installApi } from '../lib/api.js'
import { validateRuntimePatch } from '../lib/index.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-api-test-'))
}

/** Boot a real HTTP server over installApi's handler. */
async function bootApi(overrides = {}) {
  const dir = tempDir()
  const store = new MemoryStore(dir)
  const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
  const state = { reviewEnabled: true, reviewInterval: 10, reviewMode: 'suggest' }
  const getRuntime = () => ({ ...state })
  const updateRuntime = (patch) => {
    for (const [key, value] of Object.entries(patch)) validateRuntimePatch(key, value)
    Object.assign(state, patch)
    return { ...state }
  }
  const ctx = {
    httpServer: {
      register: ({ handler }) => {
        ctx.handler = handler
        return () => {}
      },
    },
  }
  const revealTargets = {
    memoryDir: dir,
    nope: undefined,
  }
  installApi(ctx, {
    store, queue, getRuntime, updateRuntime,
    resolveRevealTarget: (target) => revealTargets[target],
    revealPath: overrides.revealPath ?? (() => {}),
  })
  const server = createServer((req, res) => ctx.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, data }
  }
  return { base, queue, store, request, dir, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('api badge and suggestions endpoints', async () => {
  const api = await bootApi()
  try {
    const badge = await api.request('GET', '/memory-evolve/api/badge')
    assert.equal(badge.status, 200)
    assert.equal(badge.data.count, 0)
    api.queue.append({ time: 't', target: 'user', content: '候选记忆', reason: 'r', cwd: null })
    const badge2 = await api.request('GET', '/memory-evolve/api/badge')
    assert.equal(badge2.data.count, 1)
    const list = await api.request('GET', '/memory-evolve/api/suggestions')
    assert.equal(list.data.entries.length, 1)
    assert.equal(list.data.entries[0].content, '候选记忆')
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api approve/reject/approve-all/reject-all', async () => {
  const api = await bootApi()
  try {
    api.queue.append({ time: 't1', target: 'user', content: '第一条', reason: 'r', cwd: null })
    api.queue.append({ time: 't2', target: 'memory', content: '第二条', reason: 'r', cwd: null })
    const approve = await api.request('POST', '/memory-evolve/api/suggestions/approve', { indices: [1] })
    assert.equal(approve.status, 200)
    assert.equal(approve.data.remaining, 1)
    assert.equal(api.store.entriesOf('user').length, 1)
    const reject = await api.request('POST', '/memory-evolve/api/suggestions/reject', { indices: [1] })
    assert.equal(reject.data.remaining, 0)
    // approve-all on empty queue is a no-op
    const all = await api.request('POST', '/memory-evolve/api/suggestions/approve-all')
    assert.equal(all.status, 200)
    // invalid indices
    const bad = await api.request('POST', '/memory-evolve/api/suggestions/approve', { indices: [0] })
    assert.equal(bad.status, 400)
    const bad2 = await api.request('POST', '/memory-evolve/api/suggestions/approve', { indices: [] })
    assert.equal(bad2.status, 400)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api config get/update with validation', async () => {
  const api = await bootApi()
  try {
    const got = await api.request('GET', '/memory-evolve/api/config')
    assert.equal(got.data.config.reviewEnabled, true)
    // Only runtime-changeable keys are exposed — static config keys are not
    // valid patch keys, and echoing them back must not 400 on save.
    assert.equal('memoryDir' in got.data.config, false)
    assert.equal('toolName' in got.data.config, false)
    const updated = await api.request('POST', '/memory-evolve/api/config', { patch: { reviewInterval: 5 } })
    assert.equal(updated.data.config.reviewInterval, 5)
    const bad = await api.request('POST', '/memory-evolve/api/config', { patch: { reviewInterval: 0 } })
    assert.equal(bad.status, 400)
    const unknown = await api.request('POST', '/memory-evolve/api/config', { patch: { nope: 1 } })
    assert.equal(unknown.status, 400)
    // Static keys are still rejected when a caller sends them explicitly.
    const staticKey = await api.request('POST', '/memory-evolve/api/config', { patch: { memoryDir: '/tmp/x' } })
    assert.equal(staticKey.status, 400)
    const notPatch = await api.request('POST', '/memory-evolve/api/config', { patch: [1] })
    assert.equal(notPatch.status, 400)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api 404 for unknown routes', async () => {
  const api = await bootApi()
  try {
    const res = await api.request('GET', '/memory-evolve/api/nope')
    assert.equal(res.status, 404)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api approve supports edited contents', async () => {
  const api = await bootApi()
  try {
    api.queue.append({ time: 't', target: 'user', content: '原始建议文本', reason: 'r', cwd: null })
    const res = await api.request('POST', '/memory-evolve/api/suggestions/approve', {
      indices: [1],
      contents: ['修改后的入库文本'],
    })
    assert.equal(res.status, 200)
    assert.equal(api.store.entriesOf('user')[0].includes('修改后的入库文本'), true)
    assert.equal(api.store.entriesOf('user')[0].includes('原始建议文本'), false)
    // contents/indices length mismatch → 400
    api.queue.append({ time: 't2', target: 'memory', content: 'x', reason: 'r', cwd: null })
    const bad = await api.request('POST', '/memory-evolve/api/suggestions/approve', {
      indices: [1],
      contents: ['a', 'b'],
    })
    assert.equal(bad.status, 400)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api approve with empty contents falls back to the suggested content', async () => {
  const api = await bootApi()
  try {
    // The panel sends contents: [''] when the textarea was never edited —
    // that must not overwrite the suggestion with an empty entry.
    api.queue.append({ time: 't', target: 'memory', content: '原始建议文本', reason: 'r', cwd: null })
    const res = await api.request('POST', '/memory-evolve/api/suggestions/approve', {
      indices: [1],
      contents: [''],
    })
    assert.equal(res.status, 200)
    assert.equal(api.store.entriesOf('memory').length, 1)
    assert.equal(api.store.entriesOf('memory')[0].includes('原始建议文本'), true)
    assert.equal(api.queue.read().length, 0)
    // Whitespace-only edits fall back the same way.
    api.queue.append({ time: 't2', target: 'user', content: '另一条建议', reason: 'r', cwd: null })
    const ws = await api.request('POST', '/memory-evolve/api/suggestions/approve', {
      indices: [1],
      contents: ['   '],
    })
    assert.equal(ws.status, 200)
    assert.equal(api.store.entriesOf('user')[0].includes('另一条建议'), true)
    assert.equal(api.queue.read().length, 0)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api reveal resolves whitelisted targets and rejects unknown ones', async () => {
  const api = await bootApi()
  try {
    const res = await api.request('POST', '/memory-evolve/api/reveal', { target: 'memoryDir' })
    assert.equal(res.status, 200)
    assert.equal(res.data.ok, true)
    assert.equal(res.data.path, api.dir)
    const bad = await api.request('POST', '/memory-evolve/api/reveal', { target: '/etc' })
    assert.equal(bad.status, 400)
    const missing = await api.request('POST', '/memory-evolve/api/reveal', { target: 'nope' })
    assert.equal(missing.status, 400)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api reveal surfaces open-command failures instead of swallowing them', async () => {
  const api = await bootApi({
    // No open command available (the WSL-without-xdg-utils case): the panel
    // must see a 400 with a reason, not a silent no-op.
    revealPath: async () => { throw new Error('没有可用的打开命令（Linux/WSL 请安装 xdg-utils 或 wslu）') },
  })
  try {
    const res = await api.request('POST', '/memory-evolve/api/reveal', { target: 'memoryDir' })
    assert.equal(res.status, 400)
    assert.ok(res.data.error.includes('xdg-utils'))
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})
