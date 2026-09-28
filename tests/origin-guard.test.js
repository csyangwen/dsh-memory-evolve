// 写端点统一同源守卫回归（2026-09-24 审计批次 2 · Origin 防护扩大）。
//
// 缺陷背景：sameOriginGuard 此前只在 /api/update 一个端点调用——其余约
// 20 个写端点可被跨站 no-cors 的 text/plain JSON 体驱动（fire-and-forget
// CSRF：改配置/删记忆/采纳技能/翻转同步开关）。修复：POST/PUT 且路径
// /memory-evolve/ 前缀统一前置守卫（DELETE 豁免——非简单方法必触发 CORS
// 预检，跨站不可达）。
// 直跑：node tests/origin-guard.test.js。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installApi } from '../lib/api.js'
import { MemoryStore, ArchiveStore, SuggestionQueue } from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-origin-guard-'))
  const store = new MemoryStore(dir)
  const archive = new ArchiveStore(dir)
  const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
  const todoStore = new TodoStore(dir)
  const state = { todoEnabled: true }
  const ctx = {}
  ctx.webServer = { register: ({ handler }) => { ctx.handler = handler; return () => {} } }
  installApi(ctx, {
    store, archive, queue, todoStore,
    getRuntime: () => state,
    updateRuntime: (patch) => { Object.assign(state, patch); return { ...state } },
    config: { memoryDir: dir, skillDir: join(dir, 'skills') },
    resolveCwd: () => undefined,
  })
  const server = createServer((req, res) => ctx.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
    clean: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('①跨站 POST（no-cors 形态：text/plain JSON 体）必须被 400 拒绝', async () => {
  const api = await boot()
  try {
    const res = await fetch(`${api.base}/memory-evolve/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'http://evil.example.com' },
      body: JSON.stringify({ patch: { memoryProgressiveDisclosure: 'on' } }),
    })
    assert.equal(res.status, 400)
    const data = await res.json()
    assert.equal(data.code, 'cross-origin')
  } finally {
    await api.close()
    api.clean()
  }
})

test('②同源 POST（JSON + Origin 与 Host 一致）正常通过', async () => {
  const api = await boot()
  try {
    const res = await fetch(`${api.base}/memory-evolve/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: api.base },
      body: JSON.stringify({ patch: {} }),
    })
    assert.equal(res.status, 200)
  } finally {
    await api.close()
    api.clean()
  }
})

test('③无 Origin 头的 POST（curl 形态）被拒绝——写必须由 Web UI 发起', async () => {
  const api = await boot()
  try {
    const res = await fetch(`${api.base}/memory-evolve/api/todo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'add', target: 'work', content: 'x' }),
    })
    assert.equal(res.status, 400)
    const data = await res.json()
    assert.equal(data.code, 'cross-origin')
  } finally {
    await api.close()
    api.clean()
  }
})

test('④GET 端点不受影响（读操作零额外要求）', async () => {
  const api = await boot()
  try {
    const res = await fetch(`${api.base}/memory-evolve/api/config`)
    assert.equal(res.status, 200)
  } finally {
    await api.close()
    api.clean()
  }
})

test('⑤memory-sync 写路由同样被守卫罩住（跨站 text/plain 拒绝）', async () => {
  const api = await boot()
  try {
    const res = await fetch(`${api.base}/memory-evolve/memory-sync/global-track`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'http://evil.example.com' },
      body: JSON.stringify({ track: 'memory', on: false }),
    })
    assert.equal(res.status, 400)
  } finally {
    await api.close()
    api.clean()
  }
})
