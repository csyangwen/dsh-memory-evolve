import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { MemoryStore } from '../lib/store.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-cfg-test-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** 与 plugin.test.js 同款 fakeCtx。webServer.register 收到 { prefix, handler } 形路由。 */
function fakeCtx() {
  const state = { tools: [], contexts: [], commands: [], listeners: [], routes: [] }
  const services = {
    tools: { register: (def) => { state.tools.push(def); return () => {} }, get: () => undefined },
    systemPrompt: { context: (def) => { state.contexts.push(def); return () => {} } },
    commands: { register: (def) => { state.commands.push(def); return () => {} } },
    webServer: { register: (route) => { state.routes.push(route); return () => {} } },
  }
  const ctx = {
    state,
    tools: services.tools,
    systemPrompt: services.systemPrompt,
    commands: services.commands,
    webServer: services.webServer,
    on: (name, listener) => { (state.listeners[name] ??= []).push(listener); return () => {} },
    inject: (deps, callback) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return { dispose: () => {} }
      const disposer = callback(ctx)
      return { dispose: disposer ?? (() => {}) }
    },
    effect: (fn) => { const disposer = fn(); return disposer ?? (() => {}) },
    // This suite pins Chinese snapshot output: expose a zh locale preference
    // so apply()'s boot-time resolveLocale() resolves to 'zh'.
    get: (key) => services[key] ?? (key === 'settings' ? { get: (ns) => (ns === 'locale' ? { preference: 'zh' } : undefined) } : undefined),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  return ctx
}

test('功能验证：Web 面板改 keyProgressiveDisclosure → 新会话快照立即用新值', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  const snapshotContext = ctx.state.contexts.find((c) => c.name === 'memory:snapshot')
  assert.ok(snapshotContext, 'memory snapshot context registered')
  const route = ctx.state.routes[0]
  assert.ok(route && typeof route.handler === 'function', 'web api route with handler')

  // 两个项目各自的 key 条目（模拟"多个项目都有 key 记忆"）
  const store = new MemoryStore(dir)
  const projA = { id: 'a', session: { header: { cwd: '/proj/alpha' } } }
  const projB = { id: 'b', session: { header: { cwd: '/proj/beta' } } }
  store.add('key', '[summary:甲项目约定] 甲项目的关键约定正文第一行，写得长一点才能验证摘要注入确实只用摘要', projA)
  store.add('key', '[summary:乙项目约定] 乙项目完全不同的关键约定', projB)

  const snapOf = (agent) => snapshotContext.text({ agent })

  // 1) 默认 off：A 项目会话 → 全量注入 A 的 key，绝无 B 的内容
  const before = snapOf(projA)
  assert.ok(before.includes('甲项目的关键约定正文第一行'), 'off 模式全量注入本项目 key')
  assert.ok(!before.includes('摘要模式'))
  assert.ok(!before.includes('乙项目'), '其他项目的 key 不得注入本项目会话')

  // 2) 模拟 Web 面板 POST /api/config { patch: { keyProgressiveDisclosure: 'on' } }
  // readBody 以 async-iterable 方式读请求体：用异步生成器提供一次性 body。
  const res = { body: '', statusCode: 0, writeHead(code) { res.statusCode = code; return res }, setHeader: () => {}, end: (s) => { res.body += s } }
  const bodyText = JSON.stringify({ patch: { keyProgressiveDisclosure: 'on' } })
  async function* bodyStream() { yield Buffer.from(bodyText) }
  await route.handler({
    method: 'POST',
    url: '/memory-evolve/api/config',
    headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: bodyStream,
  }, res)
  assert.ok(res.body.includes('"keyProgressiveDisclosure":"on"'), 'config POST accepted: ' + res.body.slice(0, 120))

  // 3) 同一进程内**新建**的项目会话（新 agent 对象）→ 快照立即是摘要模式
  const newAgentA = { id: 'a2', session: { header: { cwd: '/proj/alpha' } } }
  const after = snapOf(newAgentA)
  assert.ok(after.includes('摘要模式'), 'new session snapshot uses the updated config, not the default')
  assert.ok(after.includes('甲项目约定'), 'summary (not full body) injected')
  assert.ok(!after.includes('甲项目的关键约定正文第一行'), 'full body must not leak after switching to summary mode')
  assert.ok(!after.includes('乙项目'), 'cross-project isolation holds in summary mode')
  // 摘要行带 [id]，模型可用 expand 按需加载（仅当前项目的条目）
  assert.ok(/- \[[0-9a-f]{8}\] 甲项目约定/.test(after), 'summary line carries expand-able id')

  // 4) 持久化：state 文件写入，重启（重新 apply）后依然是 on
  const ctx2 = fakeCtx()
  apply(ctx2, { memoryDir: dir })
  const snapshotContext2 = ctx2.state.contexts.find((c) => c.name === 'memory:snapshot')
  const afterRestart = snapshotContext2.text({ agent: { id: 'a3', session: { header: { cwd: '/proj/alpha' } } } })
  assert.ok(afterRestart.includes('摘要模式'), 'config persisted across restart (stateFile)')
  assert.ok(afterRestart.includes('甲项目约定'))

  clean(dir)
})
