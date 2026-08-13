/**
 * 会话评审 opt-in 语义回归测试（2026-08-13 用户拍板）：
 * 1. 全局总闸开启后，每个会话**默认关闭**——不评审、不调模型；
 * 2. 用户在悬浮面板手动开启（override=true）后才评审；
 * 3. 总闸关闭时 override 不越权（setSessionOverride 拒绝、命令提示先开全局）；
 * 4. override 持久化：落盘 session-overrides.json，模块重建（重启）后恢复。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installAdvisor } from '../lib/advisor/index.js'
import { validateRuntimePatch } from '../lib/index.js'

let seq = 0
const nextSeq = () => seq++

/** stub agent（含 session 投影：deriveMessages 从 events 实时投影）。 */
function stubAgent(id) {
  const events = []
  const session = {
    id,
    header: { cwd: `/proj/${id}` },
    events,
    deriveMessages: () => {
      const out = []
      for (const e of events) {
        if (e.type === 'user/message') out.push(e.data)
        if (e.type === 'assistant/message') out.push(e.data.message)
      }
      return out
    },
  }
  const agent = {
    id,
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    session,
    steers: [],
    injects: [],
    steer: (m) => { agent.steers.push(m) },
    inject: (m) => { agent.injects.push(m) },
  }
  return { agent, session, events }
}

/** stub llm：记录调用；返回一条 nit 评审。 */
function stubLlm() {
  const calls = []
  return {
    calls,
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
    stream(options) {
      calls.push(options)
      const text = '{"note":"建议","severity":"nit"}'
      return {
        [Symbol.asyncIterator]() {
          let done = false
          return {
            next: async () => (done ? { done: true, value: undefined } : (done = true, { done: false, value: { type: 'text-delta', text } })),
          }
        },
      }
    },
  }
}

/** 构造插件上下文 stub（cordis 最小面）。 */
function makeCtx() {
  const listeners = {} // event → [fn]
  const agents = new Map()
  const llm = stubLlm()
  const ctx = {
    commands: [],
    get: (key) => {
      if (key === 'agents') return { get: (id) => agents.get(id) }
      if (key === 'llm') return llm
      return undefined
    },
    root: undefined,
    llm,
    logger: () => console,
    on: (event, fn) => {
      ;(listeners[event] ??= []).push(fn)
      return () => {
        listeners[event] = listeners[event].filter((f) => f !== fn)
      }
    },
    inject: (keys, cb) => cb({
      commands: { register: (def) => { ctx.commands.push(def); return () => {} } },
      webServer: { register: () => () => {} },
      effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    }),
    sessionTitle: { get: () => ({ title: '测试会话' }) },
  }
  return { ctx, agents, llm, listeners }
}

/** 装配 advisor 的测试台（dataDir 可固定传入，供持久化重建测试复用）。 */
function makeRig(configOverrides = {}, dataDir = mkdtempSync(join(tmpdir(), 'dsh-advisor-optin-'))) {
  const { ctx, agents, llm, listeners } = makeCtx()
  const config = {
    advisorEnabled: true,
    advisorProvider: null,
    advisorModel: null,
    advisorSystemPrompt: '',
    advisorPanelEnabled: true,
    advisorImmuneTurns: 0,
    advisorSteerSeverities: ['nit', 'concern', 'blocker'],
    advisorMaxMessages: 60,
    advisorMaxQueued: 32,
    advisorCallTimeoutMs: 5000,
    ...configOverrides,
  }
  const installed = installAdvisor(ctx, config, {
    dataDir,
    sessionName: () => '测试会话',
    logger: { debug() {}, warn() {}, info() {} },
    validatePatch: validateRuntimePatch,
  })
  return { ctx, agents, llm, listeners, ctrl: installed.ctrl, installed, dataDir, config }
}

/** 注册 agent（触发 agent/created）+ 喂一轮完整会话事件。 */
function sessionRound(rig, sessionId = 'session-1') {
  const { agent, session, events } = stubAgent(sessionId)
  rig.agents.set(sessionId, agent)
  rig.listeners['agent/created']?.[0]?.({ agent })
  const event = (type, data, surfaceOp) => ({ type, seq: nextSeq(), data, surfaceOp })
  const feed = (e) => {
    session.events.push(e)
    rig.listeners['session/event']?.forEach((fn) => fn(session, e))
  }
  feed(event('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: '帮我写个函数' }], source: { kind: 'user' } }, 'append'))
  feed(event('step/start', { turn: 1 }))
  feed(event('assistant/message', { message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '好的' }], source: { kind: 'model' } } }, 'append'))
  feed(event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  return { agent, session }
}

test('opt-in 默认关：总闸开后新会话不评审、不调模型', async (t) => {
  const rig = makeRig()
  t.after(() => { rig.installed.dispose(); rmSync(rig.dataDir, { recursive: true, force: true }) })
  sessionRound(rig)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const status = rig.ctrl.status('session-1')
  assert.equal(status.defaultEnabled, true) // 总闸开
  assert.equal(status.override, null) // 用户未手动开过
  assert.equal(status.effectiveEnabled, false) // 默认关（opt-in）
  assert.equal(status.runtimeStatus, 'disabled')
  assert.equal(rig.llm.calls.length, 0) // 从未调用模型
  const records = rig.ctrl.queryRecords({ sessionId: 'session-1' })
  assert.equal(records.records.length, 0) // 无评审记录
})

test('opt-in 手动开：override=true 后评审运行', async (t) => {
  const rig = makeRig()
  t.after(() => { rig.installed.dispose(); rmSync(rig.dataDir, { recursive: true, force: true }) })
  // 模拟用户在悬浮面板先开启本会话，再继续对话
  const opened = rig.ctrl.setSessionOverride('session-1', true)
  assert.equal(opened.effectiveEnabled, true)
  sessionRound(rig)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(rig.llm.calls.length > 0) // 评审已调模型
  const records = rig.ctrl.queryRecords({ sessionId: 'session-1' })
  assert.equal(records.records.length, 1)
})

test('总闸关：override 不越权，setSessionOverride 拒绝开启', (t) => {
  const rig = makeRig({ advisorEnabled: false })
  t.after(() => { rig.installed.dispose(); rmSync(rig.dataDir, { recursive: true, force: true }) })
  sessionRound(rig)
  // 全局关时尝试开会话级开关 → 拒绝，override 不落
  const s = rig.ctrl.setSessionOverride('session-1', true)
  assert.equal(s.effectiveEnabled, false)
  assert.equal(s.override, null) // 未写入
  // 显式 off 允许（写 override=false，持久化，无副作用）
  rig.ctrl.setSessionOverride('session-1', false)
  const st = rig.ctrl.status('session-1')
  assert.equal(st.override, false)
  assert.equal(st.effectiveEnabled, false)
})

test('总闸关：/advisor on 返回全局关闭提示', (t) => {
  const rig = makeRig({ advisorEnabled: false })
  t.after(() => { rig.installed.dispose(); rmSync(rig.dataDir, { recursive: true, force: true }) })
  sessionRound(rig)
  const def = rig.ctx.commands.find((d) => d.name === 'advisor')
  assert.ok(def, '/advisor 命令已注册')
  const result = def.handler({ rawInput: 'on', agent: { session: { id: 'session-1' } } })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('全局开关未开启'), result.text)
})

test('override 持久化：落盘 session-overrides.json，模块重建后恢复', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-advisor-optin-persist-'))
  const rig = makeRig({}, dir)
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  sessionRound(rig)
  rig.ctrl.setSessionOverride('session-1', true)
  // 落盘内容
  const raw = readFileSync(join(dir, 'session-overrides.json'), 'utf8')
  assert.deepEqual(JSON.parse(raw), { 'session-1': true })
  // 模拟 DSH 重启：释放 claim 后重新安装到同一 dataDir
  rig.installed.dispose()
  const rig2 = makeRig({}, dir)
  t.after(() => { rig2.installed.dispose() })
  const st = rig2.ctrl.status('session-1')
  assert.equal(st.override, true) // 重启后保持手动开启
  assert.equal(st.effectiveEnabled, true)
})
