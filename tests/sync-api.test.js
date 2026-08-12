/**
 * tests/sync-api.test.js — 记忆同步 UI API 路由测试（记忆同步 Tab 数据面）
 *
 * 覆盖 /memory-evolve/memory-sync/* 六条路由：
 *   status（含迁移提示）、setup（模式 A/B）、sync（含 push）、off、
 *   conflicts、resolve（参数校验与成功路径）。
 * 用 mock syncOps/syncStatus 验证路由行为（真实逻辑已由 sync-index/
 * sync-conflict 测试覆盖）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installApi } from '../lib/api.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-sync-api-'))
}

/** Boot installApi with mock sync deps（focus 路由层行为）。 */
async function bootSyncApi(overrides = {}) {
  const dir = tempDir()
  const store = {}
  const archive = {}
  const queue = {}
  const todoStore = {}
  const state = {}
  const getRuntime = () => ({ ...state })
  const updateRuntime = (patch) => Object.assign(state, patch)
  const calls = { setup: [], sync: [], resolve: [], off: 0 }
  const syncOps = {
    setup: async (cwd, url) => { calls.setup.push({ cwd, url }); return { kind: 'success', text: `setup:${url ?? 'A'}` } },
    sync: async (cwd, push) => { calls.sync.push({ cwd, push }); return { kind: 'success', text: `sync:${push ? 'push' : 'plain'}` } },
    off: () => { calls.off += 1; return { kind: 'success', text: 'off' } },
    resolve: async (cwd, index, choice) => { calls.resolve.push({ cwd, index, choice }); return { kind: 'success', text: `resolved:${index}`, remaining: 0 } },
    conflicts: (cwd) => (cwd === '/work/sync-project' ? [{ index: 1, entryKey: 'aaaa0000', file: 'KEY.md', reason: '内容双侧不同', base: 'b', ours: 'o', theirs: 't' }] : []),
    migrate: (cwd) => (cwd === '/work/legacy' ? '/tmp/legacy-dir' : null),
  }
  const syncStatus = (cwd) => (cwd === undefined
    ? { enabled: true, initialized: false } // 无 cwd：路由如实透传"未初始化"
    : {
        enabled: true,
        initialized: true,
        uncommitted: 2,
        behind: 1,
        conflicts: 1,
        remoteBranch: 'dsh-shared/memory',
        identity: { displayName: 'github.com/acme/alpha', kind: 'remote' },
      })
  const ctx = {
    webServer: { register: ({ handler }) => { ctx.handler = handler; return () => {} } },
  }
  installApi(ctx, {
    store, archive, queue, todoStore, getRuntime, updateRuntime,
    resolveRevealTarget: () => undefined,
    revealPath: () => {},
    config: { memoryDir: dir },
    resolveCwd: (sessionId) => (sessionId === 'session-1' ? '/work/sync-project' : sessionId === 'session-legacy' ? '/work/legacy' : undefined),
    syncStatus,
    syncOps,
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
  return { request, calls, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('sync/status：返回状态并附迁移提示', async () => {
  const api = await bootSyncApi()
  try {
    const r = await api.request('GET', '/memory-evolve/memory-sync/status?sessionId=session-legacy')
    assert.equal(r.status, 200)
    assert.equal(r.data.enabled, true)
    assert.equal(r.data.remoteBranch, 'dsh-shared/memory')
    assert.equal(r.data.migrateFrom, '/tmp/legacy-dir', '旧目录应提示迁移')
    const r2 = await api.request('GET', '/memory-evolve/memory-sync/status?sessionId=session-1')
    assert.equal(r2.data.migrateFrom, null)
    const r3 = await api.request('GET', '/memory-evolve/memory-sync/status')
    assert.equal(r3.data.initialized, false, '无 cwd 时如实返回未初始化')
  } finally {
    await api.close()
  }
})

test('sync/setup：模式 A（无 url）与模式 B（有 url）', async () => {
  const api = await bootSyncApi()
  try {
    const a = await api.request('POST', '/memory-evolve/memory-sync/setup', { sessionId: 'session-1' })
    assert.equal(a.status, 200)
    assert.equal(a.data.ok, true)
    assert.match(a.data.text, /setup:A/)
    const b = await api.request('POST', '/memory-evolve/memory-sync/setup', { sessionId: 'session-1', url: 'https://git.self.com/priv.git' })
    assert.equal(b.data.ok, true)
    assert.match(b.data.text, /setup:https:\/\/git\.self\.com\/priv\.git/)
    // 无 cwd → 400
    const bad = await api.request('POST', '/memory-evolve/memory-sync/setup', { sessionId: 'nope' })
    assert.equal(bad.status, 400)
  } finally {
    await api.close()
  }
})

test('sync/sync：push 显式传递（UI 点击即用户同意）', async () => {
  const api = await bootSyncApi()
  try {
    const plain = await api.request('POST', '/memory-evolve/memory-sync/sync', { sessionId: 'session-1' })
    assert.equal(plain.data.ok, true)
    assert.match(plain.data.text, /sync:plain/)
    const push = await api.request('POST', '/memory-evolve/memory-sync/sync', { sessionId: 'session-1', push: true })
    assert.match(push.data.text, /sync:push/)
    assert.equal(api.calls.sync[0].push, false)
    assert.equal(api.calls.sync[1].push, true)
  } finally {
    await api.close()
  }
})

test('sync/off 与 conflicts 列表', async () => {
  const api = await bootSyncApi()
  try {
    const off = await api.request('POST', '/memory-evolve/memory-sync/off', { sessionId: 'session-1' })
    assert.equal(off.data.ok, true)
    assert.equal(api.calls.off, 1)
    const conflicts = await api.request('GET', '/memory-evolve/memory-sync/conflicts?sessionId=session-1')
    assert.equal(conflicts.status, 200)
    assert.equal(conflicts.data.conflicts.length, 1)
    assert.equal(conflicts.data.conflicts[0].entryKey, 'aaaa0000')
    const empty = await api.request('GET', '/memory-evolve/memory-sync/conflicts')
    assert.deepEqual(empty.data.conflicts, [])
  } finally {
    await api.close()
  }
})

test('sync/resolve：参数校验与成功路径', async () => {
  const api = await bootSyncApi()
  try {
    const ok = await api.request('POST', '/memory-evolve/memory-sync/resolve', { sessionId: 'session-1', index: 1, choice: 'ours' })
    assert.equal(ok.data.ok, true)
    assert.match(ok.data.text, /resolved:1/)
    assert.equal(api.calls.resolve[0].choice, 'ours')
    // 非法参数
    const badIndex = await api.request('POST', '/memory-evolve/memory-sync/resolve', { sessionId: 'session-1', index: 0, choice: 'ours' })
    assert.equal(badIndex.status, 400)
    const badChoice = await api.request('POST', '/memory-evolve/memory-sync/resolve', { sessionId: 'session-1', index: 1, choice: 'merge' })
    assert.equal(badChoice.status, 400)
    const badCwd = await api.request('POST', '/memory-evolve/memory-sync/resolve', { sessionId: 'nope', index: 1, choice: 'ours' })
    assert.equal(badCwd.status, 400)
  } finally {
    await api.close()
  }
})
