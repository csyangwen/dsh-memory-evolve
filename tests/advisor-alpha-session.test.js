/**
 * 回归测试（issue #49）：DSH 0.1.2-alpha.4+ 的 Session 形状
 * （ownEvents() 取代 .events 数组）。
 *
 * advisor 装配层（lib/advisor/index.js）的 `session/event` 监听器此前直接读
 * `session.events` 转发给 observer.handleEvent——新宿主下该字段为 undefined，
 * observer 的 findLastMessageTurnEnd 对 undefined 做 for...of 抛
 * TypeError（events is not iterable），每个可评审 turn/end 报一次
 * 「session/event 监听器抛错」。与 review.js 的 issue #42 同根因；修复用同款
 * 三档兜底：ownEvents?.() ?? .events ?? []（老宿主回退 .events）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installAdvisor } from '../lib/advisor/index.js'
import { validateRuntimePatch } from '../lib/index.js'

let seq = 0
const nextSeq = () => seq++

/** 构造插件上下文 stub（与 advisor-optin.test.js 同款最小 cordis 面）。 */
function makeCtx() {
  const listeners = {} // event → [fn]
  const agents = new Map()
  const llm = {
    calls: [],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
    stream() {
      return {
        [Symbol.asyncIterator]() {
          let done = false
          return {
            next: async () => (done ? { done: true, value: undefined } : (done = true, { done: false, value: { type: 'text-delta', text: '{"note":"建议","severity":"nit"}' } })),
          }
        },
      }
    },
  }
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

/** 装配 advisor 的测试台。 */
function makeRig(configOverrides = {}, dataDir = mkdtempSync(join(tmpdir(), 'dsh-advisor-alpha-'))) {
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

/** 投影消息（deriveMessages 返回值）。 */
const PROJECTED = [
  { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我写个函数' }] },
  { id: 'm2', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '好的' }] },
]

/**
 * 按指定形状构造会话 + agent（注册进 rig.agents），返回喂事件函数。
 * 会话基线字段 + 调用方给定的事件访问器（alpha=ownEvents / legacy=.events / bare=无）。
 */
function rigAgent(rig, id, accessors) {
  const events = []
  const session = {
    id,
    header: { cwd: `/proj/${id}` },
    deriveMessages: () => PROJECTED,
    ...accessors(events),
  }
  const agent = {
    id,
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    session,
    steer: () => {},
    inject: () => {},
  }
  rig.agents.set(id, agent)
  rig.listeners['agent/created']?.[0]?.({ agent })
  const feed = (e) => {
    events.push(e)
    rig.listeners['session/event']?.forEach((fn) => fn(session, e))
  }
  return { feed, session }
}

test('alpha session shape: 无 .events 只 ownEvents()——可评审 turn/end 不抛错（#49）', (t) => {
  const rig = makeRig()
  t.after(() => { rig.installed.dispose(); rmSync(rig.dataDir, { recursive: true, force: true }) })
  // alpha.4+ Session：没有 .events 字段（读它是 undefined），只有 ownEvents()
  const { feed } = rigAgent(rig, 'session-alpha', (events) => ({ ownEvents: () => events }))
  // 回归点：旧代码读 session.events（undefined）→ findLastMessageTurnEnd 对
  // undefined 做 for...of 抛 TypeError（events is not iterable）
  assert.doesNotThrow(() => {
    feed({ type: 'user/message', seq: nextSeq(), data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我写个函数' }] }, surfaceOp: 'append' })
    feed({ type: 'step/start', seq: nextSeq(), data: { turn: 1 } })
    feed({ type: 'assistant/message', seq: nextSeq(), data: { message: { id: 'm2', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '好的' }] } }, surfaceOp: 'append' })
    feed({ type: 'turn/end', seq: nextSeq(), data: { turn: 1, reason: { kind: 'completed' } } })
  })
  assert.equal(rig.llm.calls.length, 0) // 未 opt-in：接线干净跑完、无评审副作用
  assert.equal(rig.ctrl.status('session-alpha').effectiveEnabled, false)
})

test('legacy session shape: 只有 .events 无 ownEvents——兜底回退仍工作', (t) => {
  const rig = makeRig()
  t.after(() => { rig.installed.dispose(); rmSync(rig.dataDir, { recursive: true, force: true }) })
  // 老宿主：有 .events 数组、无 ownEvents
  const { feed } = rigAgent(rig, 'session-legacy', (events) => ({ events }))
  assert.doesNotThrow(() => {
    feed({ type: 'user/message', seq: nextSeq(), data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }, surfaceOp: 'append' })
    feed({ type: 'step/start', seq: nextSeq(), data: { turn: 1 } })
    feed({ type: 'assistant/message', seq: nextSeq(), data: { message: { id: 'm2', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'ok' }] } }, surfaceOp: 'append' })
    feed({ type: 'turn/end', seq: nextSeq(), data: { turn: 1, reason: { kind: 'completed' } } })
  })
})

test('defensive: 会话两者皆无——空数组兜底不抛错', (t) => {
  const rig = makeRig()
  t.after(() => { rig.installed.dispose(); rmSync(rig.dataDir, { recursive: true, force: true }) })
  const { feed } = rigAgent(rig, 'session-bare', () => ({}))
  assert.doesNotThrow(() => {
    feed({ type: 'step/start', seq: nextSeq(), data: { turn: 1 } })
    feed({ type: 'turn/end', seq: nextSeq(), data: { turn: 1, reason: { kind: 'completed' } } })
  })
})
