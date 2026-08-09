/**
 * 工作区冲突协调（ws-coord）测试——会话广播模块的子功能组。
 *
 * 覆盖：
 *  - WsCoordStore：declare（声明/重复刷新/conflicts）/ observe（自动登记/
 *    续期）/ conflictFor（自己放行、他人命中、路径归一化、过期）/ release /
 *    clearObserved / list（cwd/sessionId/paths 过滤）/ activeFor（活动概览）/
 *    prune（过期清理）
 *  - buildWsCoordBlock：开关关=null、无视角=null、1 活跃=null、≥2 活跃=
 *    注入一行（含时间与显示名）
 *  - wsToolDefinitions：三工具 schema 结构（type 单一字符串、required 顶层
 *    数组、additionalProperties:false——DSH 硬约束）
 *  - installWsCoord：事件监听注册/dispose 清理；pre-execute 软模式（放行+
 *    记录警告）/ 硬模式（deny）；post-execute 警告注入（additionalContexts）；
 *    fs/observed 自动登记；turn-stopping 释放 observed 锁
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WsCoordStore, buildWsCoordBlock, wsToolDefinitions, installWsCoord } from '../lib/coi/ws-coord.js'

/** 独立临时目录（每个测试隔离）。 */
function tempDir() {
  return join(tmpdir(), `dsh-ws-coord-test-${process.pid}-${Math.random().toString(36).slice(2, 10)}`)
}

/** 构造 installWsCoord 的 fake ctx（effect 立即执行、on 记录监听器）。 */
function fakeCtx() {
  const state = { listeners: {}, tools: [], toolDisposers: [] }
  const ctx = {
    state,
    on(name, listener) {
      state.listeners[name] = listener
      return () => { delete state.listeners[name] }
    },
    effect(fn) {
      const disposer = fn()
      return disposer ?? (() => {})
    },
    tools: {
      register(def) {
        state.tools.push(def)
        const disposer = () => { state.tools = state.tools.filter((d) => d !== def) }
        state.toolDisposers.push(disposer)
        return disposer
      },
    },
  }
  return ctx
}

/** 基础 config（广播目录 + 记忆目录指向临时目录）。 */
function baseConfig(dir) {
  return {
    wsCoordEnabled: true,
    wsCoordSnapshot: true,
    wsCoordEnforceWrite: false,
    wsCoordAutoRegister: true,
    wsCoordNotifyConflict: true,
    broadcastDataDir: dir,
    memoryDir: dir,
  }
}

/** 构造一个工具调用 exec（write 写入目标文件）。 */
function writeExec(sessionId, filePath, cwd = '/w', callId = 'c1') {
  return {
    name: 'write',
    callId,
    agent: { session: { id: sessionId, header: { cwd } } },
    arguments: { file_path: filePath, content: 'x' },
  }
}

test('declare：登记文件/服务 + TTL + 重复声明刷新 + conflicts 检测', async () => {
  const dir = tempDir()
  const store = new WsCoordStore(dir)
  // 会话 A 先占用 /w/a.js
  const first = store.declare({ sessionId: 'A', cwd: '/w', targets: [{ path: 'a.js', note: '重构' }], ttlMinutes: 60 })
  assert.equal(first.declared.length, 1)
  assert.equal(first.conflicts.length, 0)
  assert.equal(first.declared[0].target, '/w/a.js')
  assert.equal(first.declared[0].kind, 'file')
  assert.equal(first.declared[0].source, 'declared')
  assert.ok(first.declared[0].expiresAt > Date.now())
  // 服务声明
  const svc = store.declare({ sessionId: 'A', cwd: '/w', services: [{ name: 'dev 服务', action: '重启' }] })
  assert.equal(svc.declared.length, 1)
  assert.equal(svc.declared[0].kind, 'service')
  // 同会话重复声明同一文件：刷新不新增（declared 1 条，note 更新）
  const again = store.declare({ sessionId: 'A', cwd: '/w', targets: [{ path: '/w/a.js', note: '重构 v2' }], ttlMinutes: 30 })
  assert.equal(again.declared.length, 1)
  assert.equal(again.declared[0].note, '重构 v2')
  assert.equal(store.list({ cwd: '/w' }).length, 2)
  // 会话 B 声明同一文件 → conflicts 命中（但照常登记，交给 AI 判断）
  const b = store.declare({ sessionId: 'B', cwd: '/w', targets: [{ path: 'a.js', note: 'B 也要改' }] })
  assert.equal(b.conflicts.length, 1)
  assert.equal(b.conflicts[0].sessionId, 'A')
  rmSync(dir, { recursive: true, force: true })
})

test('observe：自动登记（fs/observed）+ 同文件续期 + 非法输入跳过', async () => {
  const dir = tempDir()
  const store = new WsCoordStore(dir)
  // 第一次写：新建 observed 锁
  store.observe('A', '/w', '/w/a.js')
  let locks = store.list({ cwd: '/w' })
  assert.equal(locks.length, 1)
  assert.equal(locks[0].source, 'observed')
  assert.equal(locks[0].sessionId, 'A')
  const firstExpires = locks[0].expiresAt
  // 第二次写：续期（expiresAt 延后）不新增
  const t0 = Date.now()
  store.observe('A', '/w', '/w/a.js')
  locks = store.list({ cwd: '/w' })
  assert.equal(locks.length, 1)
  assert.ok(locks[0].expiresAt >= firstExpires)
  // 非法输入：无 sessionId / 空 targetKey 静默跳过
  store.observe('', '/w', '/w/x.js')
  store.observe('B', '/w', '')
  assert.equal(store.list({ cwd: '/w' }).length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('conflictFor：自己占用放行 / 他人占用命中 / 相对路径归一化 / 过期不命中', async () => {
  const dir = tempDir()
  const store = new WsCoordStore(dir)
  store.declare({ sessionId: 'A', cwd: '/w', targets: [{ path: 'a.js' }], ttlMinutes: 60 })
  // 他人占用命中（B 写 /w/a.js，相对路径也能命中）
  assert.ok(store.conflictFor('B', 'a.js', '/w'))
  assert.ok(store.conflictFor('B', '/w/a.js', '/w'))
  // 自己占用放行
  assert.equal(store.conflictFor('A', '/w/a.js', '/w'), null)
  // 不同文件不命中
  assert.equal(store.conflictFor('B', '/w/b.js', '/w'), null)
  // 过期不命中（直接改内部锁的 expiresAt 为过去，再 prune）
  store.locks[0].expiresAt = Date.now() - 1000
  store.prune()
  assert.equal(store.conflictFor('B', '/w/a.js', '/w'), null)
  rmSync(dir, { recursive: true, force: true })
})

test('release：按路径 / 全部释放 + remaining 计数', async () => {
  const dir = tempDir()
  const store = new WsCoordStore(dir)
  store.declare({ sessionId: 'A', cwd: '/w', targets: [{ path: 'a.js' }, { path: 'b.js' }] })
  assert.equal(store.list({ cwd: '/w' }).length, 2)
  // 按路径释放一个
  const r1 = store.release({ sessionId: 'A', paths: ['/w/a.js'] })
  assert.equal(r1.released.length, 1)
  assert.equal(r1.remaining, 1)
  // 释放别人的锁无效
  const r2 = store.release({ sessionId: 'B', paths: ['/w/b.js'] })
  assert.equal(r2.released.length, 0)
  // 全部释放
  const r3 = store.release({ sessionId: 'A', all: true })
  assert.equal(r3.released.length, 1)
  assert.equal(store.list({ cwd: '/w' }).length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('clearObserved：只清自动登记锁，保留声明锁', async () => {
  const dir = tempDir()
  const store = new WsCoordStore(dir)
  store.declare({ sessionId: 'A', cwd: '/w', targets: [{ path: 'a.js' }] })
  store.observe('A', '/w', '/w/b.js')
  store.clearObserved('A')
  const locks = store.list({ cwd: '/w' })
  assert.equal(locks.length, 1)
  assert.equal(locks[0].target, '/w/a.js')
  assert.equal(locks[0].source, 'declared')
  rmSync(dir, { recursive: true, force: true })
})

test('list：cwd 隔离 + sessionId 过滤 + paths 交集', async () => {
  const dir = tempDir()
  const store = new WsCoordStore(dir)
  store.declare({ sessionId: 'A', cwd: '/w1', targets: [{ path: 'a.js' }] })
  store.declare({ sessionId: 'B', cwd: '/w2', targets: [{ path: 'x.js' }] })
  // cwd 隔离：w1 只看到自己的
  const w1 = store.list({ cwd: '/w1' })
  assert.equal(w1.length, 1)
  assert.equal(w1[0].sessionId, 'A')
  // sessionId 过滤
  assert.equal(store.list({ cwd: '/w1', sessionId: 'B' }).length, 0)
  // paths 交集
  assert.equal(store.list({ cwd: '/w1', paths: ['/w1/b.js'] }).length, 0)
  assert.equal(store.list({ cwd: '/w1', paths: ['/w1/a.js'] }).length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('activeFor：活动概览——有锁会话 + running 会话合并，idle 无锁不展示', async () => {
  const dir = tempDir()
  const store = new WsCoordStore(dir)
  store.declare({ sessionId: 'A', cwd: '/w', targets: [{ path: 'a.js', note: '重构' }] })
  const meta = new Map([
    ['A', { cwd: '/w', status: 'idle', lastActiveAt: Date.now() }], // 有锁，idle 也展示
    ['B', { cwd: '/w', status: 'running', lastActiveAt: Date.now() }], // running 无锁也展示
    ['C', { cwd: '/w', status: 'idle', lastActiveAt: Date.now() }], // idle 无锁：不展示
    ['D', { cwd: '/other', status: 'running', lastActiveAt: Date.now() }], // 别的 cwd：不展示
  ])
  const active = store.activeFor('/w', meta)
  assert.equal(active.length, 2)
  const byId = Object.fromEntries(active.map((a) => [a.sessionId, a]))
  assert.equal(byId.A.note, '重构')
  assert.equal(byId.A.lockCount, 1)
  assert.equal(byId.B.status, 'running')
  rmSync(dir, { recursive: true, force: true })
})

test('buildWsCoordBlock：开关关/无视角/1 活跃 = null；≥2 活跃 = 注入一行（含时间）', async () => {
  const dir = tempDir()
  const store = new WsCoordStore(dir)
  store.declare({ sessionId: 'A', cwd: '/w', targets: [{ path: 'a.js', note: '重构' }] })
  const meta = new Map([
    ['A', { cwd: '/w', status: 'running', lastActiveAt: Date.now() }],
  ])
  const name = (sid) => (sid === 'A' ? '会话甲' : sid)
  // 开关关 = null
  assert.equal(buildWsCoordBlock({ wsCoordEnabled: false, wsCoordSnapshot: true }, 'S', '/w', store, meta, name), null)
  // 快照开关关 = null
  assert.equal(buildWsCoordBlock({ wsCoordEnabled: true, wsCoordSnapshot: false }, 'S', '/w', store, meta, name), null)
  // 无视角 = null
  assert.equal(buildWsCoordBlock({ wsCoordEnabled: true, wsCoordSnapshot: true }, '', '/w', store, meta, name), null)
  assert.equal(buildWsCoordBlock({ wsCoordEnabled: true, wsCoordSnapshot: true }, 'S', '', store, meta, name), null)
  // 只有 1 个活跃 = null（克制：单会话零开销）
  assert.equal(buildWsCoordBlock({ wsCoordEnabled: true, wsCoordSnapshot: true }, 'S', '/w', store, meta, name), null)
  // 第 2 个会话开始跑 → 注入一行
  meta.set('B', { cwd: '/w', status: 'running', lastActiveAt: Date.now() })
  const block = buildWsCoordBlock({ wsCoordEnabled: true, wsCoordSnapshot: true }, 'S', '/w', store, meta, name)
  assert.ok(block !== null)
  assert.ok(block.includes('【工作区活动】'))
  assert.ok(block.includes('会话甲（重构）'))
  assert.ok(/20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(block), '快照段必须带当前日期时间')
  assert.ok(block.includes('de_ws_status'))
  rmSync(dir, { recursive: true, force: true })
})

test('工具 schema：三工具符合 DSH 硬约束（单一 type/顶层 required/additionalProperties:false）', async () => {
  const store = new WsCoordStore(tempDir())
  const defs = wsToolDefinitions(store, (s) => s, new Map())
  assert.equal(defs.length, 3)
  const names = defs.map((d) => d.name)
  assert.deepEqual(names.sort(), ['de_ws_declare', 'de_ws_release', 'de_ws_status'].sort())
  // 递归 walk（照抄 coi.test.js 防回归模式）：type 必须是单一字符串、
  // required 只允许顶层数组（字段级 required: true 会被模型 API 拒绝）
  const walk = (node, path, container = false) => {
    if (node === null || typeof node !== 'object') return
    if (!container) {
      if (typeof node.type === 'object') {
        throw new Error(`schema ${path}.type 必须是单一字符串: ${JSON.stringify(node.type)}`)
      }
      if (Object.hasOwn(node, 'required') && !Array.isArray(node.required)) {
        throw new Error(`schema ${path}.required 必须是数组: ${JSON.stringify(node.required)}`)
      }
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, `${path}.${key}`, key === 'properties')
    }
  }
  for (const def of defs) {
    // 工具必须声明 output { schema, render }
    assert.ok(def.output && def.output.schema && typeof def.output.render === 'function', `${def.name}: output 必须含 schema+render`)
    walk(def.parameters, def.name)
    walk(def.output.schema, `${def.name}.output`)
    // output schema：顶层 additionalProperties:false + required 顶层数组
    assert.equal(def.output.schema.additionalProperties, false, `${def.name}: output additionalProperties 必须 false`)
    assert.ok(Array.isArray(def.output.schema.required), `${def.name}: output required 必须数组`)
  }
})

test('installWsCoord：事件注册 + 软模式 pre-execute 放行/记录 + post-execute 注入 + fs/observed 登记 + turn-stopping 释放', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  const config = baseConfig(dir)
  // 广播 store 假对象（记录 send 调用）
  const sent = []
  const installed = installWsCoord(ctx, config, {
    broadcastStore: { send: (req) => { sent.push(req); return { ok: true } } },
  })
  // 工具注册了 3 个
  assert.equal(ctx.state.tools.length, 3)
  // 事件监听齐了：agent/status、fs/observed、pre/post-execute、turn-stopping
  for (const ev of ['agent/status', 'fs/observed', 'tools/pre-execute', 'tools/post-execute', 'agent/turn-stopping']) {
    assert.equal(typeof ctx.state.listeners[ev], 'function', `缺少监听 ${ev}`)
  }
  // 会话 A 声明占用 /w/a.js
  installed.store.declare({ sessionId: 'A', cwd: '/w', targets: [{ path: 'a.js', note: '重构' }], ttlMinutes: 60 })
  const pre = ctx.state.listeners['tools/pre-execute']
  const post = ctx.state.listeners['tools/post-execute']
  // B 写 a.js（软模式）：放行（next 返回 'NEXT'），记录警告，并通知占用方
  const exec = writeExec('B', '/w/a.js', '/w', 'c1')
  const preResult = await pre(exec, async () => 'NEXT')
  assert.equal(preResult, 'NEXT', '软模式必须放行（调 next）')
  assert.equal(sent.length, 1, '应通知占用方 A')
  assert.equal(sent[0].recipients[0], 'A')
  // post-execute：写成功后注入警告上下文
  const injected = []
  const postResult = await post(exec, { isError: false }, async () => ({ kind: 'accept' }))
  assert.equal(postResult.kind, 'accept')
  assert.ok(Array.isArray(postResult.additionalContexts) && postResult.additionalContexts.length === 1)
  assert.ok(postResult.additionalContexts[0].content[0].text.includes('占用'))
  // 非冲突写入：B 写 b.js 无警告
  const exec2 = writeExec('B', '/w/b.js', '/w', 'c2')
  assert.equal(await pre(exec2, async () => 'NEXT2'), 'NEXT2')
  const post2 = await post(exec2, { isError: false }, async () => ({ kind: 'accept' }))
  assert.ok(!post2.additionalContexts || post2.additionalContexts.length === 0)
  // fs/observed：B 写 b.js 后自动登记
  ctx.state.listeners['fs/observed']({ targetKey: '/w/b.js' }, 'v1', { agent: { session: { id: 'B', header: { cwd: '/w' } } } })
  const bLocks = installed.store.list({ cwd: '/w', sessionId: 'B' })
  assert.equal(bLocks.length, 1)
  assert.equal(bLocks[0].source, 'observed')
  // turn-stopping：B 回合结束 → observed 锁释放
  ctx.state.listeners['agent/turn-stopping']({ agent: { session: { id: 'B' } } })
  assert.equal(installed.store.list({ cwd: '/w', sessionId: 'B' }).length, 0)
  // dispose：工具注销 + 监听清理
  installed.dispose()
  assert.equal(ctx.state.tools.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('installWsCoord：硬模式（enforceWrite=true）pre-execute 返回 deny', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  const config = { ...baseConfig(dir), wsCoordEnforceWrite: true }
  const installed = installWsCoord(ctx, config)
  installed.store.declare({ sessionId: 'A', cwd: '/w', targets: [{ path: 'a.js', note: '重构' }], ttlMinutes: 60 })
  const pre = ctx.state.listeners['tools/pre-execute']
  // B 写 a.js：deny + reason 含占用信息
  const result = await pre(writeExec('B', '/w/a.js', '/w', 'c1'), async () => 'NEXT')
  assert.equal(result.kind, 'deny')
  assert.ok(result.reason.includes('占用'))
  assert.ok(result.reason.includes('重构'))
  // 自己写自己的文件：放行
  const selfResult = await pre(writeExec('A', '/w/a.js', '/w', 'c2'), async () => 'NEXT')
  assert.equal(selfResult, 'NEXT')
  // 非 write/edit 工具：不检测直接放行
  const bashResult = await pre({ name: 'bash', callId: 'c3', agent: { session: { id: 'B' } }, arguments: { command: 'ls' } }, async () => 'NEXT')
  assert.equal(bashResult, 'NEXT')
  installed.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('installWsCoord：配置小开关关闭时跳过对应监听', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  // autoRegister=false → 不监听 fs/observed；notifyConflict=false → 不通知
  const config = { ...baseConfig(dir), wsCoordAutoRegister: false, wsCoordNotifyConflict: false }
  const installed = installWsCoord(ctx, config)
  assert.equal(typeof ctx.state.listeners['fs/observed'], 'undefined', 'autoRegister=false 不应监听 fs/observed')
  // 冲突时也不发通知（sent 保持 0）
  installed.store.declare({ sessionId: 'A', cwd: '/w', targets: [{ path: 'a.js' }] })
  const pre = ctx.state.listeners['tools/pre-execute']
  await pre(writeExec('B', '/w/a.js', '/w', 'c1'), async () => 'NEXT')
  assert.equal(installed.store.list({ cwd: '/w', sessionId: 'B' }).length, 0, 'B 未写（pre 只检测），无登记')
  installed.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('renderSnapshot 集成：wsCoord 活动段注入不抛错（防 2026-08-09 ReferenceError 回归）', async () => {
  // 回归保护：renderSnapshot 是模块级函数，wsCoord 实例必须经参数传入——
  // 曾在函数体内误写 apply 闭包的 wsCoordStoreRef 导致 ReferenceError
  // （"wsCoordStoreRef is not defined"，打开广播后任何会话快照渲染即崩）。
  const { resolveConfig, renderSnapshot } = await import('../lib/index.js')
  const { MemoryStore } = await import('../lib/store.js')
  const dir = tempDir()
  const cfg = resolveConfig({ wsCoordEnabled: true, wsCoordSnapshot: true, memoryDir: dir })
  const store = new WsCoordStore(join(dir, 'broadcast', 'ws-coord'))
  store.declare({ sessionId: 'A', cwd: '/w', targets: [{ path: 'a.js', note: '重构' }] })
  const meta = new Map([
    ['A', { cwd: '/w', status: 'running', lastActiveAt: Date.now() }],
    ['B', { cwd: '/w', status: 'running', lastActiveAt: Date.now() }],
  ])
  const agent = { session: { id: 'S', header: { cwd: '/w' } } }
  // 必须不抛错，且活动段带日期时间
  const out = renderSnapshot(cfg, new MemoryStore(dir), agent, {}, store, meta)
  assert.ok(out.includes('【工作区活动】'), '应注入活动段')
  assert.ok(/20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(out), '活动段必须带当前日期时间')
  // wsCoordEnabled=false 时零开销（不注入、不抛）
  const out2 = renderSnapshot({ ...cfg, wsCoordEnabled: false }, new MemoryStore(dir), agent, {}, store, meta)
  assert.ok(!out2.includes('【工作区活动】'))
  rmSync(dir, { recursive: true, force: true })
})
