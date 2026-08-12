import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installAdvisor } from '../lib/advisor/index.js'
import { DEFAULT_ADVISOR_SYSTEM_PROMPT } from '../lib/advisor/prompt.js'
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
        if (e.type === 'assistant/message') {
          if (e.data.message.content.length === 0) continue
          out.push(e.data.message)
        }
        if (e.type === 'tool/result') out.push(e.data.message)
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
    steer: (message) => { agent.steers.push(message) },
    inject: (message) => { agent.injects.push(message) },
  }
  return { agent, session, events }
}

/**
 * feed：事件逐个追加进 session.events 再派发（与真实 DSH 的 session surface
 * 实时增长一致——deriveMessages 只看到已发生的事件；旧实现"先全 push 再喂"
 * 会让 agentic 门在 turn/end 之前误触发评审）。
 */
function feed(rig, session, event) {
  session.events.push(event)
  rig.listeners['session/event']?.forEach((fn) => fn(session, event))
}

/** stub llm：按序回复；calls 暴露调用记录（含 messages）；replies 可运行时替换。 */
function stubLlm(replies = ['{"note":"建议补单测","severity":"concern"}']) {
  const calls = []
  const llm = {
    calls,
    replies,
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
    stream(options) {
      calls.push(options)
      // ⚠️ 读 llm.replies（对象属性）而非闭包参数——测试可运行时替换
      const text = llm.replies.length > 0 ? llm.replies.shift() : '{"note":"建议","severity":"nit"}'
      return {
        [Symbol.asyncIterator]() {
          let done = false
          return {
            next: async () => {
              if (done) return { done: true, value: undefined }
              done = true
              return { done: false, value: { type: 'text-delta', text } }
            },
          }
        },
      }
    },
  }
  return llm
}

/** 构造插件上下文 stub（cordis 最小面）。 */
function makeCtx() {
  const listeners = {} // event → [fn]
  const agents = new Map()
  const llm = stubLlm()
  const ctx = {
    get: (key) => {
      if (key === 'agents') return { get: (id) => agents.get(id) }
      if (key === 'llm') return llm
      if (key === 'root') return undefined
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
    emit: async (event, ...args) => {
      for (const fn of [...(listeners[event] ?? [])]) {
        // 支持 next 回调的水瀑事件：无 next 则直接调用
        if (fn.length > args.length) await fn(...args, () => {})
        else await fn(...args)
      }
    },
    inject: (keys, cb) => {
      // 测试直接执行（commands/httpServer 都可用）
      const sub = {
        commands: { register: (def) => { ctx.commands.push(def); return () => {} } },
        httpServer: { register: ({ handler }) => { ctx.handler = handler; return () => {} } },
        effect: (fn, label) => {
          const disposers = fn()
          if (typeof disposers === 'function') ctx.effectDisposers.push(disposers)
          return () => {}
        },
      }
      return cb(sub)
    },
    commands: [],
    handler: null,
    effectDisposers: [],
    sessionTitle: { get: () => ({ title: '测试会话' }) },
  }
  return { ctx, agents, llm, listeners }
}

/** 装好 advisor 的测试台。 */
function makeRig(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-advisor-api-'))
  const { ctx, agents, llm, listeners } = makeCtx()
  const config = {
    advisorEnabled: true,
    advisorDataDir: dir,
    advisorProvider: null, // 继承会话模型
    advisorModel: null,
    advisorSystemPrompt: '',
    advisorPanelEnabled: true,
    advisorImmuneTurns: 0,
    advisorSteerSeverities: ['nit', 'concern', 'blocker'],
    advisorMaxMessages: 60,
    advisorMaxQueued: 32,
    advisorCallTimeoutMs: 5000,
    ...overrides.config,
  }
  const installed = installAdvisor(ctx, config, {
    dataDir: dir,
    sessionName: () => '测试会话',
    logger: { debug() {}, warn() {}, info() {} },
    validatePatch: validateRuntimePatch,
  })
  const ctrl = installed.ctrl
  return { ctx, agents, llm, listeners, ctrl, installed, dir, config }
}


/** 测试用 rig 工厂：t.after 统一清理（dispose + 删目录），防 claim 泄漏。 */
function rigFor(t, overrides) {
  const rig = makeRig(overrides)
  t.after(() => {
    try { rig.installed.dispose() } catch { /* 忽略清理错误 */ }
    try { rmSync(rig.dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })
  return rig
}

/** 通过 http 发请求。 */
async function makeServer(ctx) {
  const server = createServer((req, res) => ctx.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    server,
    base,
    async request(method, path, body, headers = {}) {
      // 模拟浏览器同源 fetch：写操作自动携带 Origin（同源防护要求）
      const res = await fetch(base + path, {
        method,
        headers: { origin: new URL(base).origin, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const json = await res.json()
      return { status: res.status, json }
    },
  }
}

/** 模拟一个 agent 注册 + 一轮完整会话。 */
function setupSession(rig, sessionId = 'session-1', userText = '帮我写个函数', agentText = '好的，我来写') {
  const { agent, session, events } = stubAgent(sessionId)
  rig.agents.set(sessionId, agent)
  // agent/created
  const created = rig.listeners['agent/created']?.[0]
  created?.({ agent })
  // 喂一轮事件（user → step → assistant → turn/end；逐个 feed）
  const event = (type, data, surfaceOp) => ({ type, seq: nextSeq(), data, surfaceOp })
  feed(rig, session, event('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' } }, 'append'))
  feed(rig, session, event('step/start', { turn: 1 }))
  feed(rig, session, event('assistant/message', { message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: agentText }], source: { kind: 'model' } } }, 'append'))
  feed(rig, session, event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  return { agent, session, events }
}

test('装配：启用后 agent/created 建运行时，turn/end 触发评审并 steer', async (t) => {
  const rig = rigFor(t)
  const { agent } = setupSession(rig)
  // 等 drain
  await new Promise((resolve) => setTimeout(resolve, 20))
  // 状态
  const status = rig.ctrl.status('session-1')
  assert.equal(status.effectiveEnabled, true)
  assert.equal(status.gateStatus, 'ok')
  assert.equal(status.routeSource, 'session') // 继承会话模型
  assert.equal(status.provider, 'deepseek-official')
  assert.equal(status.model, 'deepseek-v4-flash')
  // steer 已投递（全量 steer）
  assert.equal(agent.steers.length, 1)
  // 2026-08-13 设计反转：注入伪装成用户指令——文本=note 正文（无
  // advisor 前缀）；机器层 source.kind='advisor' 保留（Agent 不可见）
  assert.equal(agent.steers[0].content[0].text, '建议补单测')
  assert.equal(agent.steers[0].source.kind, 'advisor')
  // 事件已入 ring + 落盘
  const events = rig.ctrl.queryEvents('session-1', undefined, 0)
  assert.ok(events.events.some((e) => e.type === 'review-started'))
  const records = rig.ctrl.queryRecords({ sessionId: 'session-1' })
  assert.equal(records.records.length, 1)
  assert.equal(records.records[0].outcome, 'delivered')
  assert.equal(records.records[0].delivery, 'steer')
})

test('门禁：只配 provider 缺 model → config-incomplete，绝不调用模型', (t) => {
  const rig = rigFor(t, { config: { advisorProvider: 'deepseek-official', advisorModel: null } })
  setupSession(rig)
  // B3：effectiveEnabled 只表示开关（true）；门禁由 gateStatus 表达
  const status = rig.ctrl.status('session-1')
  assert.equal(status.effectiveEnabled, true)
  assert.equal(status.gateStatus, 'config-incomplete')
  assert.equal(status.runtimeStatus, 'disabled') // 门禁拦截：runtime 不可运行
  assert.ok(status.disabledReason !== undefined)
  // llm 从未被调用
  assert.equal(rig.llm.calls.length, 0)
})

test('指令：tell 入队 → 立即问答评审（Q4）→ answered 记录 + 会话流注入', async (t) => {
  const rig = rigFor(t)
  const { agent } = setupSession(rig)
  await new Promise((resolve) => setTimeout(resolve, 20))
  // 问答回复用普通文本（问答模式不提取 JSON 帧，全文即回答）
  rig.llm.replies = ['好的，我会重点关注安全边界。']
  // 发指令 → 立即触发问答评审（不等待下个主回合）
  rig.ctrl.tell('session-1', '重点检查安全漏洞')
  await new Promise((resolve) => setTimeout(resolve, 30))
  // 指令已被问答评审消费（reserve → answered → consume）
  assert.equal(rig.ctrl.instructionsOf('session-1').length, 0)
  // 最新记录：answered + note=回答全文 + delivery=null（不注入主会话）+ 带指令
  const records = rig.ctrl.queryRecords({ sessionId: 'session-1' })
  const latest = records.records[0]
  assert.equal(latest.outcome, 'answered')
  assert.equal(latest.note.text, '好的，我会重点关注安全边界。')
  assert.equal(latest.note.severity, 'answer')
  assert.equal(latest.delivery, null)
  assert.deepEqual(latest.instructions, ['重点检查安全漏洞'])
  // 问答调用输入：### User question 段 + 无 [advisor instruction] 重复
  const lastCall = rig.llm.calls[rig.llm.calls.length - 1]
  const qaText = lastCall.messages.map((m) => m.content[0].text).join('\n')
  assert.ok(qaText.includes('### User question\n<用户对评审员提问>\n重点检查安全漏洞\n</用户对评审员提问>'))
  assert.ok(!qaText.includes('<用户对评审员指令>'))
  // 2026-08-12 用户反馈：回答**不注入主会话**（避免污染 agent 上下文），
  // 只在面板事件/记录中展示
  assert.equal(agent.injects.length, 0)
  // 第一轮评审的 concern 走 steer（正常）；问答回答不新增任何注入
  assert.equal(agent.steers.length, 1)
})

test('API：status/events/records/instructions/toggle/config 全端点', async (t) => {
  const rig = rigFor(t)
  setupSession(rig)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const { server, base, request } = await makeServer(rig.ctx)
  t.after(() => server.close())

  // status
  const st = await request('GET', '/memory-evolve/api/advisor/status?sessionId=session-1')
  assert.equal(st.status, 200)
  assert.equal(st.json.ok, true)
  assert.equal(st.json.effectiveEnabled, true)
  assert.equal(st.json.runtimeStatus, 'idle')

  // events
  const ev = await request('GET', '/memory-evolve/api/advisor/events?sessionId=session-1')
  assert.equal(ev.status, 200)
  assert.ok(ev.json.events.length >= 2)

  // records
  const rec = await request('GET', '/memory-evolve/api/advisor/records?sessionId=session-1')
  assert.equal(rec.status, 200)
  assert.equal(rec.json.records.length, 1)

  // instructions POST + GET + DELETE（Q4：POST 后立即问答评审并消费）
  rig.llm.replies = ['已检查边界条件。']
  const ins = await request('POST', '/memory-evolve/api/advisor/instructions', { sessionId: 'session-1', text: '检查边界条件' })
  assert.equal(ins.status, 200)
  // 指令异步被问答评审消费（稍候）
  await new Promise((resolve) => setTimeout(resolve, 30))
  const insGet = await request('GET', '/memory-evolve/api/advisor/instructions?sessionId=session-1')
  assert.equal(insGet.status, 200)
  assert.equal(insGet.json.pending.length, 0)
  const del = await request('DELETE', '/memory-evolve/api/advisor/instructions?sessionId=session-1')
  assert.equal(del.json.cleared, 0)

  // toggle off
  const toggled = await request('POST', '/memory-evolve/api/advisor/toggle', { sessionId: 'session-1', enabled: false })
  assert.equal(toggled.json.effectiveEnabled, false)
  assert.equal(toggled.json.override, false)
  // 重新打开（后续端点不受影响）
  await request('POST', '/memory-evolve/api/advisor/toggle', { sessionId: 'session-1', enabled: true })

  // config GET + PATCH
  const cfg = await request('GET', '/memory-evolve/api/advisor/config')
  assert.equal(cfg.json.config.advisorEnabled, true)
  const patched = await request('PATCH', '/memory-evolve/api/advisor/config', { patch: { advisorMaxMessages: 30 } })
  assert.equal(patched.status, 200)
  assert.equal(patched.json.config.advisorMaxMessages, 30)

  // 未知端点 404
  const nf = await request('GET', '/memory-evolve/api/advisor/nope')
  assert.equal(nf.status, 404)
  assert.equal(nf.json.ok, false)

})

test('API：错误路径（BAD_SESSION、同源 403、非法 patch）', async (t) => {
  const rig = rigFor(t)
  setupSession(rig)
  const { server, base, request } = await makeServer(rig.ctx)
  t.after(() => server.close())

  // 无效会话
  const bad = await request('GET', '/memory-evolve/api/advisor/status?sessionId=nope')
  assert.equal(bad.status, 400)
  assert.equal(bad.json.code, 'BAD_SESSION')

  // 写操作缺 Origin（同源防护）
  const noOrigin = await fetch(base + '/memory-evolve/api/advisor/toggle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-1', enabled: true }),
  })
  const noOriginJson = await noOrigin.json()
  assert.equal(noOrigin.status, 403)
  assert.equal(noOriginJson.code, 'FORBIDDEN')

  // 跨站 Origin
  const cross = await fetch(base + '/memory-evolve/api/advisor/toggle', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example.com' },
    body: JSON.stringify({ sessionId: 'session-1', enabled: true }),
  })
  assert.equal(cross.status, 403)

  // 非法 patch 值
  const badPatch = await request('PATCH', '/memory-evolve/api/advisor/config', { patch: { advisorMaxMessages: -5 } })
  assert.equal(badPatch.status, 400)
  assert.equal(badPatch.json.code, 'BAD_PATCH')

})

test('多 fiber：single-reviewer 只装一个评审者', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-advisor-claim-'))
  const config = { advisorEnabled: true, advisorDataDir: dir, advisorProvider: null, advisorModel: null, advisorSystemPrompt: '', advisorPanelEnabled: true, advisorImmuneTurns: 0, advisorSteerSeverities: ['nit'], advisorMaxMessages: 60, advisorMaxQueued: 32, advisorCallTimeoutMs: 5000 }
  const r1 = makeCtx()
  const r2 = makeCtx()
  const i1 = installAdvisor(r1.ctx, config, { dataDir: dir, logger: { debug() {}, warn() {} } })
  const i2 = installAdvisor(r2.ctx, config, { dataDir: dir, logger: { debug() {}, warn() {} } })
  assert.ok(i1.ctrl !== null) // 第一个是 reviewer
  assert.equal(i2.ctrl, null) // 第二个非 reviewer（不装）
  // 释放后第三个可接管
  i1.dispose()
  const i3 = installAdvisor(r2.ctx, config, { dataDir: dir, logger: { debug() {}, warn() {} } })
  assert.ok(i3.ctrl !== null)
  i3.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('生命周期：agent/disposed 对称清理（runtime 释放、override 清除）', (t) => {
  const rig = rigFor(t)
  setupSession(rig)
  rig.ctrl.setSessionOverride('session-1', false)
  const disposed = rig.listeners['agent/disposed']?.[0]
  disposed?.({ agent: { id: 'session-1' } })
  // 重建 agent 后运行时重新创建
  const { agent } = setupSession(rig)
  assert.equal(rig.ctrl.status('session-1').effectiveEnabled, true)
})

// ---------------------------------------------------------------------------
// 第一轮优化 Q1/Q5：info 级投递行为 + 配置新字段
// ---------------------------------------------------------------------------

test('Q1：info 级默认仅记录（不注入会话流）；开启 advisorInfoInject 后走 inject', async (t) => {
  const rig = rigFor(t)
  const { agent } = setupSession(rig)
  await new Promise((resolve) => setTimeout(resolve, 20))
  // 让下一轮评审产出 info 级建议
  rig.llm.replies = ['{"note":"可选小提示","severity":"info"}']
  const session = rig.agents.get('session-1').session
  const event = (type, data, surfaceOp) => ({ type, seq: nextSeq(), data, surfaceOp })
  feed(rig, session, event('user/message', { id: 'm3', role: 'user', content: [{ type: 'text', text: '再来一轮' }], source: { kind: 'user' } }, 'append'))
  feed(rig, session, event('step/start', { turn: 2 }))
  feed(rig, session, event('assistant/message', { message: { id: 'm4', role: 'assistant', content: [{ type: 'text', text: '好的' }], source: { kind: 'model' } } }, 'append'))
  feed(rig, session, event('turn/end', { turn: 2, reason: { kind: 'completed' } }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  // 默认（infoInject=false）：记录落盘（outcome=recorded），会话流零打扰
  const records = rig.ctrl.queryRecords({ sessionId: 'session-1' })
  const latest = records.records[0]
  assert.equal(latest.outcome, 'recorded')
  assert.equal(latest.note.severity, 'info')
  assert.equal(latest.delivery, null)
  assert.equal(agent.injects.length, 0)
  assert.equal(agent.steers.length, 1) // 只有第一轮的 concern（steer）
  // 开启 infoInject：info 走 inject（永不 steer）
  rig.ctrl.patchConfig({ advisorInfoInject: true })
  rig.llm.replies = ['{"note":"另一个小提示","severity":"info"}']
  feed(rig, session, event('user/message', { id: 'm5', role: 'user', content: [{ type: 'text', text: '再再来一轮' }], source: { kind: 'user' } }, 'append'))
  feed(rig, session, event('step/start', { turn: 3 }))
  feed(rig, session, event('assistant/message', { message: { id: 'm6', role: 'assistant', content: [{ type: 'text', text: '好的' }], source: { kind: 'model' } } }, 'append'))
  feed(rig, session, event('turn/end', { turn: 3, reason: { kind: 'completed' } }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  const records2 = rig.ctrl.queryRecords({ sessionId: 'session-1' })
  assert.equal(records2.records[0].outcome, 'delivered')
  assert.equal(records2.records[0].delivery, 'inject')
  assert.equal(agent.injects.length, 1)
  assert.equal(agent.injects[0].content[0].text, '另一个小提示')
  assert.equal(agent.steers.length, 1) // steer 未被 info 占用
})

test('Q5：config GET 返回默认提示词全文 + 新配置字段；PATCH 校验生效', async (t) => {
  const rig = rigFor(t)
  setupSession(rig)
  const { server, base, request } = await makeServer(rig.ctx)
  t.after(() => server.close())
  const cfg = await request('GET', '/memory-evolve/api/advisor/config')
  assert.equal(cfg.json.config.defaultSystemPrompt, DEFAULT_ADVISOR_SYSTEM_PROMPT)
  assert.equal(cfg.json.config.advisorInfoInject, false)
  // PATCH 新字段
  const patched = await request('PATCH', '/memory-evolve/api/advisor/config', { patch: { advisorInfoInject: true } })
  assert.equal(patched.status, 200)
  assert.equal(patched.json.config.advisorInfoInject, true)
  // 非法值拒绝
  const bad = await request('PATCH', '/memory-evolve/api/advisor/config', { patch: { advisorInfoInject: 'yes' } })
  assert.equal(bad.status, 400)
})

test('2026-08-12 用户反馈：角色分离——固定前缀不可被自定义提示词覆盖；注入消息带身份标记', async (t) => {
  const rig = rigFor(t, { config: { advisorSystemPrompt: '我是用户，帮我盯着agent输出' } })
  setupSession(rig)
  await new Promise((resolve) => setTimeout(resolve, 20))
  // 评审调用 system = 固定角色前缀 + 用户自定义提示词
  const call = rig.llm.calls[0]
  assert.ok(call.system.startsWith('你是会话评审员 Advisor'))
  assert.ok(call.system.includes('我是用户，帮我盯着agent输出'))
  // 2026-08-13 用户反馈：独立会话声明必须在固定前缀里（自定义提示词
  // 覆盖不了）——评审员知道约束只对自己可见、不得质问 Agent 不记得
  assert.ok(call.system.includes('两个独立的会话'))
  assert.ok(call.system.includes('永远不要假设或质问 Agent 记得这些约束'))
  // 2026-08-13 设计反转：注入伪装成用户指令——文本=note 正文，不带
  // advisor 身份痕迹；source.kind='advisor' 仍在（自评审排除，Agent 不可见）
  const { agent } = rig
  const steered = rig.agents.get('session-1').steers[0]
  assert.equal(steered.content[0].text, '建议补单测')
  assert.equal(steered.source.kind, 'advisor')
  // 问答回答不注入主会话（advisor 对用户说的话只在面板）
  rig.llm.replies = ['好的，我知道了。']
  rig.ctrl.tell('session-1', '你好')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(rig.agents.get('session-1').injects.length, 0)
})

test('四层级约束：GET/PUT /scopes + 拼接注入 + 评审会话约束随 reset 清空', async (t) => {
  const rig = rigFor(t)
  setupSession(rig)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const { server, base, request } = await makeServer(rig.ctx)
  t.after(() => server.close())

  // GET 初始（三层全空）
  const get0 = await request('GET', '/memory-evolve/api/advisor/scopes?sessionId=session-1')
  assert.equal(get0.status, 200)
  assert.equal(get0.json.scopes.project.text, '')
  assert.equal(get0.json.scopes.session.text, '')
  assert.equal(get0.json.scopes.conversation.text, '')

  // 保存全局约束（所有项目所有会话生效）
  const putG = await request('PUT', '/memory-evolve/api/advisor/scopes', { sessionId: 'session-1', level: 'global', text: '评审意见一律用中文' })
  assert.equal(putG.status, 200)
  assert.equal(putG.json.scopes.global.text, '评审意见一律用中文')

  // 保存三层约束
  const putP = await request('PUT', '/memory-evolve/api/advisor/scopes', { sessionId: 'session-1', level: 'project', text: '本项目用 Vue npm 工程' })
  assert.equal(putP.status, 200)
  assert.equal(putP.json.scopes.project.text, '本项目用 Vue npm 工程')
  const putS = await request('PUT', '/memory-evolve/api/advisor/scopes', { sessionId: 'session-1', level: 'session', text: '本会话盯紧边界条件' })
  assert.equal(putS.json.scopes.session.text, '本会话盯紧边界条件')
  const putC = await request('PUT', '/memory-evolve/api/advisor/scopes', { sessionId: 'session-1', level: 'conversation', text: '本次评审会话重点看性能' })
  assert.equal(putC.json.scopes.conversation.text, '本次评审会话重点看性能')

  // 非法 level
  const bad = await request('PUT', '/memory-evolve/api/advisor/scopes', { sessionId: 'session-1', level: 'nope', text: 'x' })
  assert.equal(bad.status, 400)

  // 下一轮评审调用 system 包含四层拼接（动态生效，无需重建）
  rig.llm.replies = ['{"note":"约束生效","severity":"nit"}']
  const session = rig.agents.get('session-1').session
  const event = (type, data, surfaceOp) => ({ type, seq: nextSeq(), data, surfaceOp })
  feed(rig, session, event('user/message', { id: 'm3', role: 'user', content: [{ type: 'text', text: '再来一轮' }], source: { kind: 'user' } }, 'append'))
  feed(rig, session, event('step/start', { turn: 2 }))
  feed(rig, session, event('assistant/message', { message: { id: 'm4', role: 'assistant', content: [{ type: 'text', text: '好的' }], source: { kind: 'model' } } }, 'append'))
  feed(rig, session, event('turn/end', { turn: 2, reason: { kind: 'completed' } }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  const lastCall = rig.llm.calls[rig.llm.calls.length - 1]
  assert.ok(lastCall.system.includes('### 全局约束'))
  assert.ok(lastCall.system.includes('评审意见一律用中文'))
  assert.ok(lastCall.system.includes('### 项目约束'))
  assert.ok(lastCall.system.includes('本项目用 Vue npm 工程'))
  assert.ok(lastCall.system.includes('### 会话约束'))
  assert.ok(lastCall.system.includes('本会话盯紧边界条件'))
  assert.ok(lastCall.system.includes('### 本次评审会话约束'))
  assert.ok(lastCall.system.includes('本次评审会话重点看性能'))

  // 新建评审会话：评审会话约束清空；会话/项目约束保留
  const reset = await request('POST', '/memory-evolve/api/advisor/conversation/reset', { sessionId: 'session-1' })
  assert.equal(reset.status, 200)
  const get1 = await request('GET', '/memory-evolve/api/advisor/scopes?sessionId=session-1')
  assert.equal(get1.json.scopes.conversation.text, '') // 已清空
  assert.equal(get1.json.scopes.session.text, '本会话盯紧边界条件') // 保留
  assert.equal(get1.json.scopes.project.text, '本项目用 Vue npm 工程') // 保留
})

test('Q3 重构：POST /conversation/reset 新建评审会话（清上下文+记忆，epoch 自增）', async (t) => {
  const rig = rigFor(t)
  const { agent } = setupSession(rig)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const { server, base, request } = await makeServer(rig.ctx)
  t.after(() => server.close())
  // 无效会话
  const bad = await request('POST', '/memory-evolve/api/advisor/conversation/reset', { sessionId: 'nope' })
  assert.equal(bad.status, 400)
  // 正常 reset
  const reset = await request('POST', '/memory-evolve/api/advisor/conversation/reset', { sessionId: 'session-1' })
  assert.equal(reset.status, 200)
  assert.ok(reset.json.epoch >= 2)
  // reset 后新评审（评审员从零开始）：首轮评审的输入 contextCount=0
  rig.llm.replies = ['{"note":"新评审员的建议","severity":"nit"}']
  const session = rig.agents.get('session-1').session
  const event = (type, data, surfaceOp) => ({ type, seq: nextSeq(), data, surfaceOp })
  feed(rig, session, event('user/message', { id: 'm3', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }, 'append'))
  feed(rig, session, event('step/start', { turn: 2 }))
  feed(rig, session, event('assistant/message', { message: { id: 'm4', role: 'assistant', content: [{ type: 'text', text: '好的' }], source: { kind: 'model' } } }, 'append'))
  feed(rig, session, event('turn/end', { turn: 2, reason: { kind: 'completed' } }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  // reset 后首轮评审的输入快照：contextCount=0（评审员上下文已清空）
  const events2 = rig.ctrl.queryEvents('session-1', undefined, 100)
  const started = [...events2.events].reverse().find((e) => e.type === 'review-started')
  assert.equal(started.input.contextCount, 0)
})

// ---------------------------------------------------------------------------
// 复审修复：混合排队（评审 in-flight 时 tell 的问答不丢问题）
// ---------------------------------------------------------------------------

test('复审高1：in-flight 评审 + 排队评审 + tell → 问答仍精确拿到自己的问题', async (t) => {
  // callTimeoutMs 调小：hang 的评审 A 快速超时释放，队列轮到评审 B → 问答
  const rig = rigFor(t, { config: { advisorCallTimeoutMs: 200, advisorRetryBackoffMs: 5 } })
  const { agent } = setupSession(rig)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const session = rig.agents.get('session-1').session
  const event = (type, data, surfaceOp) => ({ type, seq: nextSeq(), data, surfaceOp })

  // 让评审 A（首次 + transient 重试）hang 住（模拟慢模型调用）——
  // hang 分支不消费 replies（stubLlm 的 stream 每次调用都会 shift 一条）
  const originalStream = rig.llm.stream.bind(rig.llm)
  let hangCalls = 2
  rig.llm.stream = (options) => {
    if (hangCalls > 0) {
      hangCalls -= 1
      return {
        [Symbol.asyncIterator]() {
          return { next: () => new Promise(() => {}) } // 永不返回（hang）
        },
      }
    }
    return originalStream(options)
  }

  // 评审 A（hang）in-flight
  feed(rig, session, event('user/message', { id: 'm3', role: 'user', content: [{ type: 'text', text: '第二轮' }], source: { kind: 'user' } }, 'append'))
  feed(rig, session, event('step/start', { turn: 2 }))
  feed(rig, session, event('assistant/message', { message: { id: 'm4', role: 'assistant', content: [{ type: 'text', text: '继续' }], source: { kind: 'model' } } }, 'append'))
  feed(rig, session, event('turn/end', { turn: 2, reason: { kind: 'completed' } }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  // 评审 B 排队（也会在队列里）
  feed(rig, session, event('user/message', { id: 'm5', role: 'user', content: [{ type: 'text', text: '第三轮' }], source: { kind: 'user' } }, 'append'))
  feed(rig, session, event('step/start', { turn: 3 }))
  feed(rig, session, event('assistant/message', { message: { id: 'm6', role: 'assistant', content: [{ type: 'text', text: '继续' }], source: { kind: 'model' } } }, 'append'))
  feed(rig, session, event('turn/end', { turn: 3, reason: { kind: 'completed' } }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  // tell：问答入队（排在评审 B 后）；评审 B 的 reserve 必须跳过这条 bound 指令
  // replies 顺序：评审 B 先调用（JSON 帧）→ 问答后调用（普通文本回答）
  rig.llm.replies = ['{"note":"评审B建议","severity":"nit"}', '已检查安全边界。']
  rig.ctrl.tell('session-1', '重点检查安全漏洞')
  // 等评审 A 超时（200ms）+ 重试退避（1000ms）+ 再次超时 + 评审 B + 问答全部完成
  await new Promise((resolve) => setTimeout(resolve, 2500))
  // 评审 B 不得抢走问答的问题：answered 记录的 instructions 是用户问题
  const records = rig.ctrl.queryRecords({ sessionId: 'session-1' })
  const answered = records.records.find((r) => r.outcome === 'answered')
  assert.ok(answered !== undefined, '问答应产生 answered 记录')
  assert.deepEqual(answered.instructions, ['重点检查安全漏洞'])
  assert.equal(answered.note.text, '已检查安全边界。')
  assert.equal(rig.ctrl.instructionsOf('session-1').length, 0) // 已消费
  // 2026-08-12 用户反馈：回答不注入主会话（面板展示）
  assert.equal(agent.injects.length, 0)
})
