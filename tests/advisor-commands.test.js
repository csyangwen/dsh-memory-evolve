import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installAdvisor } from '../lib/advisor/index.js'
import { validateRuntimePatch } from '../lib/index.js'

/** 最小 cordis ctx（commands 注册捕获）。 */
function makeCtx() {
  const listeners = {}
  const agents = new Map()
  const commands = []
  const llm = {
    calls: [],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
    stream() {
      this.calls.push(1)
      const text = '{"note":"建议","severity":"nit"}'
      return {
        [Symbol.asyncIterator]() {
          let done = false
          return {
            next: async () => done ? { done: true } : (done = true, { done: false, value: { type: 'text-delta', text } }),
          }
        },
      }
    },
  }
  const ctx = {
    get: (k) => (k === 'agents' ? { get: (id) => agents.get(id) } : k === 'llm' ? llm : undefined),
    root: undefined,
    llm,
    logger: () => console,
    on: (e, fn) => { (listeners[e] ??= []).push(fn); return () => {} },
    inject: (keys, cb) => cb({
      commands: { register: (def) => { commands.push(def); return () => {} } },
      httpServer: { register: ({ handler }) => { ctx.handler = handler; return () => {} } },
      effect: (fn) => { fn(); return () => {} },
    }),
    sessionTitle: { get: () => ({ title: '测试会话' }) },
  }
  return { ctx, agents, listeners, commands, llm }
}

/** 命令测试台。 */
function makeRig() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-advisor-cmd-'))
  const { ctx, agents, listeners, commands, llm } = makeCtx()
  const config = {
    advisorEnabled: true,
    advisorProvider: null,
    advisorModel: null,
    advisorSystemPrompt: '',
    advisorPanelEnabled: true,
    advisorImmuneTurns: 0,
    advisorSteerSeverities: ['nit'],
    advisorMaxMessages: 60,
    advisorMaxQueued: 32,
    advisorCallTimeoutMs: 5000,
  }
  const installed = installAdvisor(ctx, config, {
    dataDir: dir,
    sessionName: () => '测试会话',
    logger: { debug() {}, warn() {}, info() {} },
    validatePatch: validateRuntimePatch,
  })
  const ctrl = installed.ctrl
  return { ctx, agents, listeners, commands, llm, ctrl, installed, dir }
}

/** 注册一个 agent + 一轮事件，返回 invocation 模拟。 */
function setup(rig) {
  const events = []
  const session = {
    id: 's1',
    header: { cwd: '/proj' },
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
  const agent = { id: 's1', options: { provider: 'p', model: 'm' }, session, steers: [], injects: [], steer: (m) => agent.steers.push(m), inject: (m) => agent.injects.push(m) }
  rig.agents.set('s1', agent)
  rig.listeners['agent/created']?.[0]?.({ agent })
  const ev = (type, data, surfaceOp) => ({ type, seq: (seq = seq + 1), data, surfaceOp })
  let seq = 0
  events.push(ev('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: '帮我' }], source: { kind: 'user' } }, 'append'))
  events.push(ev('step/start', { turn: 1 }))
  events.push(ev('assistant/message', { message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '好的' }], source: { kind: 'model' } } }, 'append'))
  events.push(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  for (const e of events) rig.listeners['session/event']?.forEach((fn) => fn(session, e))
  return { agent, session }
}

/** 模拟命令调用。 */
function invoke(rig, rawInput) {
  const def = rig.commands.find((d) => d.name === 'advisor')
  assert.ok(def, '/advisor 命令已注册')
  return def.handler({
    rawInput,
    agent: { session: { id: 's1' } },
  })
}

test('/advisor 命令：注册 + status/on/off/tell 全流程', async (t) => {
  const rig = makeRig()
  t.after(() => { rig.installed.dispose(); rmSync(rig.dir, { recursive: true, force: true }) })
  setup(rig)
  await new Promise((r) => setTimeout(r, 20))

  // status
  const st = invoke(rig, 'status')
  assert.equal(st.kind, 'success')
  assert.ok(st.text.includes('Advisor: enabled'))

  // off
  const off = invoke(rig, 'off')
  assert.equal(off.text, 'Advisor off for this session.')
  assert.equal(rig.ctrl.status('s1').effectiveEnabled, false)

  // on（恢复）
  const on = invoke(rig, 'on')
  assert.ok(on.text.includes('Advisor on'))

  // tell（发指令）→ Q4：入队后立即触发问答评审并消费（异步，稍候）
  const tell = invoke(rig, 'tell 重点检查安全')
  assert.equal(tell.kind, 'success')
  assert.ok(tell.text.includes('重点检查安全'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(rig.ctrl.instructionsOf('s1').length, 0)

  // tell 空 → 拒绝
  const empty = invoke(rig, 'tell')
  assert.equal(empty.kind, 'error')

  // usage
  const usage = invoke(rig, 'bogus')
  assert.ok(usage.text.includes('Usage'))
})

test('/advisor toggle：翻转生效', (t) => {
  const rig = makeRig()
  t.after(() => { rig.installed.dispose(); rmSync(rig.dir, { recursive: true, force: true }) })
  setup(rig)
  assert.ok(rig.ctrl.status('s1').effectiveEnabled)
  invoke(rig, 'toggle')
  assert.equal(rig.ctrl.status('s1').effectiveEnabled, false)
  invoke(rig, 'toggle')
  assert.ok(rig.ctrl.status('s1').effectiveEnabled)
})
