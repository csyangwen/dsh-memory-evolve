/**
 * 会话编排模块（de_session）测试：
 *  - SessionOrchStore：spawn 记录落盘/查找
 *  - SessionOrch：spawn（建会话+派任务+可选入房）/ wake（live 直发、
 *    offline resume 后发、resume 失败报错）/ status / list / 卸载清理
 *  - sessionToolDefinition：工具 schema 与 execute 分发（fake agents 注入）
 */
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionOrch, SessionOrchStore, sessionToolDefinition, installSession } from '../lib/session-orch.js'

/** 独立临时目录（每个测试隔离）。 */
function tempDir() {
  return join(tmpdir(), `dsh-session-orch-test-${process.pid}-${Math.random().toString(36).slice(2, 10)}`)
}

/** 构造一个 fake agent（记录 followup 收到的消息，status 可切换）。 */
function makeAgent(id, cwd = '/w') {
  return {
    id,
    status: 'idle',
    followups: [],
    session: { header: { cwd }, events: [{ time: 1700000000000 }] },
    followup(message) {
      this.followups.push(message)
      this.status = 'running'
    },
  }
}

/** 构造 fake agents 服务（create/resume/get/list + 调用记录）。 */
function makeFakeAgents() {
  const live = new Map()
  const state = { created: [], resumed: [] }
  return {
    state,
    live,
    async create(opts) {
      const agent = makeAgent(opts.sessionId, opts.meta?.cwd ?? '/w')
      live.set(opts.sessionId, agent)
      state.created.push(opts)
      return { agent, dispose: async () => { live.delete(opts.sessionId) } }
    },
    async resume(opts) {
      if (opts.resumeSessionId === 'session-missing') throw new Error('session not found')
      const agent = makeAgent(opts.resumeSessionId, '/r')
      live.set(opts.resumeSessionId, agent)
      state.resumed.push(opts)
      return { agent, dispose: async () => { live.delete(opts.resumeSessionId) } }
    },
    get(id) { return live.get(id) },
    list() { return [...live.values()] },
  }
}

/** fake ctx：tools.register 捕获 + effect 执行 + inject 同步回调（模拟
 *  agents 服务已就绪；与真实 cordis 行为一致——agents 必须经 inject 拿）。 */
function makeCtx(agents) {
  const registered = []
  const ctx = {
    agents,
    registered,
    tools: { register: (def) => { registered.push(def); return () => {} } },
    effect: (fn) => { fn(); return () => {} },
    inject: (services, cb) => {
      if (services.includes('agents')) cb(ctx)
      return () => {}
    },
  }
  return ctx
}

test('SessionOrchStore: spawn 记录落盘/查找/列表', () => {
  const dir = tempDir()
  mkdirSync(dir, { recursive: true })
  const store = new SessionOrchStore(dir)
  store.add({ sessionId: 'session-a', spawnedBy: 'session-pm', prompt: '你是美工', cwd: null, roomId: null, createdAt: 1 })
  store.add({ sessionId: 'session-b', spawnedBy: 'session-pm', prompt: '你是测试', cwd: '/p', roomId: 'room-1', createdAt: 2 })
  assert.equal(store.find('session-a').prompt, '你是美工')
  assert.equal(store.find('session-nope'), undefined)
  assert.equal(store.list()[0].sessionId, 'session-b', '列表新→旧')
  // 重启后从盘恢复
  const store2 = new SessionOrchStore(dir)
  assert.equal(store2.list().length, 2)
  assert.equal(store2.find('session-b').roomId, 'room-1')
  rmSync(dir, { recursive: true, force: true })
})

test('spawn: 创建标准会话 + 首条消息=完整提示词 + 记录落盘', async () => {
  const dir = tempDir()
  const agents = makeFakeAgents()
  const ctx = makeCtx(agents)
  const orch = new SessionOrch(ctx, { store: new SessionOrchStore(dir), getBroadcastStore: () => undefined })
  const tool = sessionToolDefinition(orch)
  // prompt 必填
  const noPrompt = await tool.execute({ action: 'spawn' }, { agent: { session: { id: 'session-pm' } } })
  assert.equal(noPrompt.ok, false)
  assert.match(noPrompt.message, /prompt/)
  // 正常 spawn（requester=发起会话：继承它的 provider/model + cwd——
  // 新会话无历史配置必须显式给，否则 {{model}} 无值回合失败/落默认工作区）
  const prompt = '你是美工，负责网站视觉。现在开始执行任务：设计首页 Banner，要求……（长文本自由组合）'
  const requesterAgent = { session: { id: 'session-pm', header: { cwd: '/project/blog' } }, options: { provider: 'deepseek', model: 'deepseek-chat' } }
  const res = await tool.execute({ action: 'spawn', prompt }, { agent: requesterAgent })
  assert.equal(res.ok, true)
  assert.match(res.sessionId, /^session-[0-9a-f-]+$/)
  // create 参数正确（agentOptions 继承 model；meta.cwd 继承发起会话）
  const created = agents.state.created[0]
  assert.equal(created.sessionId, res.sessionId)
  assert.equal(created.meta.cwd, '/project/blog', 'cwd 继承发起会话（否则新会话落默认工作区）')
  assert.equal(created.agentOptions.provider, 'deepseek', 'provider 继承发起会话')
  assert.equal(created.agentOptions.model, 'deepseek-chat', 'model 继承发起会话')
  // 显式 cwd/model 优先于继承
  const res2 = await tool.execute({ action: 'spawn', prompt: '任务2', cwd: '/other', model: 'my-model' }, { agent: requesterAgent })
  assert.equal(agents.state.created[1].meta.cwd, '/other')
  assert.equal(agents.state.created[1].agentOptions.model, 'my-model')
  assert.equal(agents.state.created[1].agentOptions.provider, 'deepseek')
  // 首条消息 = 完整提示词（等价替用户发消息）
  const agent = agents.live.get(res.sessionId)
  assert.equal(agent.followups.length, 1)
  const msg = agent.followups[0]
  assert.equal(msg.role, 'user')
  assert.equal(msg.content[0].type, 'text')
  assert.equal(msg.content[0].text, prompt)
  assert.equal(msg.source.kind, 'user')
  assert.ok(msg.id, '消息必须带稳定 id')
  // 记录落盘（含 model/cwd 留档）
  const saved = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'))
  assert.equal(saved[0].sessionId, res.sessionId)
  assert.equal(saved[0].spawnedBy, 'session-pm')
  assert.equal(saved[0].prompt, prompt)
  assert.equal(saved[0].model, 'deepseek-chat')
  assert.equal(saved[0].cwd, '/project/blog')
  rmSync(dir, { recursive: true, force: true })
})

test('spawn 带 roomId：广播启用=入房成功；未启用=提示但创建不受影响', async () => {
  const dir = tempDir()
  // 广播已启用：rooms.join 被调用并成功
  let joined = null
  const broadcastStore = { rooms: { join: (id, sid) => { joined = { id, sid }; return { ok: true, message: 'ok', room: { name: '协作组', members: [] } } } } }
  const agents1 = makeFakeAgents()
  const orch1 = new SessionOrch(makeCtx(agents1), { store: new SessionOrchStore(dir), getBroadcastStore: () => broadcastStore })
  const tool1 = sessionToolDefinition(orch1)
  const res1 = await tool1.execute({ action: 'spawn', prompt: '任务', roomId: 'room-abc' }, { agent: { session: { id: 's-pm' } } })
  assert.equal(res1.ok, true)
  assert.equal(joined.id, 'room-abc')
  assert.equal(joined.sid, res1.sessionId)
  assert.match(res1.message, /已加入房间/)
  // 广播未启用：只提示，spawn 照常成功
  const agents2 = makeFakeAgents()
  const orch2 = new SessionOrch(makeCtx(agents2), { store: new SessionOrchStore(dir), getBroadcastStore: () => undefined })
  const tool2 = sessionToolDefinition(orch2)
  const res2 = await tool2.execute({ action: 'spawn', prompt: '任务', roomId: 'room-abc' }, { agent: { session: { id: 's-pm' } } })
  assert.equal(res2.ok, true)
  assert.match(res2.message, /加入房间失败：广播模块未启用/)
  assert.equal(agents2.live.get(res2.sessionId).followups.length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('wake: live 直接派发；offline 先 resume 再派发；resume 失败报错', async () => {
  const dir = tempDir()
  const agents = makeFakeAgents()
  const orch = new SessionOrch(makeCtx(agents), { store: new SessionOrchStore(dir), getBroadcastStore: () => undefined })
  const tool = sessionToolDefinition(orch)
  // 参数校验
  assert.equal((await tool.execute({ action: 'wake', prompt: '干活' }, {})).ok, false)
  assert.equal((await tool.execute({ action: 'wake', sessionId: 's-x' }, {})).ok, false)
  // live 会话：直接 followup，不 resume
  const liveAgent = makeAgent('session-live', '/p')
  agents.live.set('session-live', liveAgent)
  const wakeLive = await tool.execute({ action: 'wake', sessionId: 'session-live', prompt: '现在开始做测试报告' }, {})
  assert.equal(wakeLive.ok, true)
  assert.equal(liveAgent.followups.length, 1)
  assert.equal(liveAgent.followups[0].content[0].text, '现在开始做测试报告')
  assert.equal(agents.state.resumed.length, 0)
  // offline（进程重启后）：自动 resume 再派发
  const wakeOffline = await tool.execute({ action: 'wake', sessionId: 'session-restored', prompt: '继续' }, {})
  assert.equal(wakeOffline.ok, true)
  assert.equal(agents.state.resumed.length, 1)
  assert.equal(agents.state.resumed[0].resumeSessionId, 'session-restored')
  assert.equal(agents.live.get('session-restored').followups[0].content[0].text, '继续')
  // resume 失败（会话不存在）：明确报错
  const wakeMissing = await tool.execute({ action: 'wake', sessionId: 'session-missing', prompt: 'hi' }, {})
  assert.equal(wakeMissing.ok, false)
  assert.match(wakeMissing.message, /不在当前进程且自动恢复失败/)
  rmSync(dir, { recursive: true, force: true })
})

test('status / list: 状态视图（running/idle/offline + spawn 记录）', async () => {
  const dir = tempDir()
  const agents = makeFakeAgents()
  const orch = new SessionOrch(makeCtx(agents), { store: new SessionOrchStore(dir), getBroadcastStore: () => undefined })
  const tool = sessionToolDefinition(orch)
  // 建一个 spawn 会话（running）+ 一个 GUI 手动会话（idle）
  await tool.execute({ action: 'spawn', prompt: '你是前端' }, { agent: { session: { id: 's-pm' } } })
  const guiAgent = makeAgent('session-gui', '/g')
  guiAgent.status = 'idle'
  agents.live.set('session-gui', guiAgent)
  // status：spawn 会话 running
  const spawnedId = agents.state.created[0].sessionId
  const st1 = await tool.execute({ action: 'status', sessionId: spawnedId }, {})
  assert.equal(st1.ok, true)
  assert.equal(st1.status, 'running')
  assert.equal(st1.spawned, true)
  assert.equal(st1.cwd, '/w')
  assert.equal(st1.lastActiveAt, 1700000000000, 'live 会话附最后活动时间')
  // status：GUI 会话 idle
  const st2 = await tool.execute({ action: 'status', sessionId: 'session-gui' }, {})
  assert.equal(st2.status, 'idle')
  assert.equal(st2.spawned, false)
  assert.equal(st2.lastActiveAt, 1700000000000)
  // render 兜底：status 返回即使无 message 也渲染可读状态行（曾输出空
  // 字符串导致产品经理 status 查询"没有返回"）
  const rendered = tool.output.render({}, st1)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.ok(String(rendered[0].text).includes('running'), 'render 输出含状态')
  assert.ok(String(rendered[0].text).includes(spawnedId), 'render 输出含会话 ID')
  assert.ok(String(st1.message).includes('running'), 'status live 分支带 message 文案')
  // status：从未见过的会话 offline
  const st3 = await tool.execute({ action: 'status', sessionId: 'session-ghost' }, {})
  assert.equal(st3.status, 'offline')
  assert.equal(st3.spawned, false)
  assert.equal(st3.lastActiveAt, null)
  // list：live 全量 + spawn 记录（带状态与 lastActiveAt）
  const list = await tool.execute({ action: 'list' }, {})
  assert.equal(list.ok, true)
  assert.equal(list.live.length, 2)
  assert.equal(list.live[0].lastActiveAt, 1700000000000)
  assert.equal(list.sessions.length, 1)
  assert.equal(list.sessions[0].status, 'running')
  assert.equal(list.sessions[0].spawnedBy, 's-pm')
  assert.equal(list.sessions[0].lastActiveAt, 1700000000000)
  rmSync(dir, { recursive: true, force: true })
})

test('installSession: 注册 de_session 工具；卸载清理 spawn 出的 agent（用户会话不动）', async () => {
  const dir = tempDir()
  const agents = makeFakeAgents()
  const ctx = makeCtx(agents)
  const installed = installSession(ctx, { memoryDir: dir, sessionDataDir: dir }, { getBroadcastStore: () => undefined })
  assert.equal(ctx.registered.length, 1)
  assert.equal(ctx.registered[0].name, 'de_session')
  const tool = ctx.registered[0]
  // spawn 一个会话
  const res = await tool.execute({ action: 'spawn', prompt: '任务' }, { agent: { session: { id: 's-pm' } } })
  const spawnedId = res.sessionId
  assert.ok(agents.live.has(spawnedId))
  // 另放一个"用户自己的"会话（不归模块管）
  agents.live.set('session-user', makeAgent('session-user', '/u'))
  // 卸载：模块 spawn 的 agent 被 dispose，用户会话保留
  installed.dispose()
  assert.equal(agents.live.has(spawnedId), false, '模块 spawn 的 agent 应被清理')
  assert.equal(agents.live.has('session-user'), true, '用户自己的会话不受影响')
  rmSync(dir, { recursive: true, force: true })
})
