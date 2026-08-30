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

// This suite pins the legacy Chinese output contract; i18n.test.js covers English.
import { setLocale } from '../lib/i18n.js'
setLocale('zh')

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
    session: { id, header: { cwd }, events: [{ time: 1700000000000 }] },
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
 *  agents 服务已就绪；与真实 cordis 行为一致——agents 必须经 inject 拿）。
 *  workspace：fake 工作区注册表（/project/blog 已注册，attach 记录到 attached）。
 *  sessionTitle：fake 名称服务（rename 记录到 renamed）。
 *  sessionPersistence：fake 持久化（inspect 返回会话 log——
 *  wake offline 恢复时读会话自己最后使用的模型配置）。
 *  llm/settings：可选——提供 fake 模型目录（spawn 显式 model 按模型名
 *  解析 provider 用；不传=不可解析，退回继承发起会话 provider）。 */
function makeCtx(agents, persistence, llm) {
  const registered = []
  const attached = []
  const renamed = []
  const ctx = {
    agents,
    registered,
    attached,
    renamed,
    // fake 模型目录：settings 命名空间 → 各 provider 的模型列表
    // （与真实 settings.yaml 同构；settingsPath 指到单 provider 配置层）
    llm: llm ?? undefined,
    settings: llm
      ? {
        get: (ns) => {
          if (ns === 'llm-deepseek') return { providers: { 'deepseek-official': { models: [{ id: 'deepseek-v4-flash' }] } } }
          if (ns === 'llm-qtp') return { providers: { 'qwen-token-plan-cn': { models: [{ id: 'qwen3.7-plus' }, { id: 'glm-5.2' }] } } }
          return undefined
        },
      }
      : undefined,
    workspaceRegistry: {
      list: () => [{ id: 'ws-1', path: '/project/blog', title: '五', sessionIds: ['session-me'] }],
      // 模拟 attach 竞态失败次数（剩余；>0 时 attachSession 抛错并递减）
      attachFailures: 0,
      // create 调用记录（create 兜底断言用）
      created: [],
      // 模拟 cwd 目录不存在（工作区被删除/磁盘未挂载）：确定性失败
      missingPaths: [],
      resolveByPath: async (path) => {
        if (ctx.workspaceRegistry.missingPaths.includes(path)) {
          const e = new Error(`ENOENT: no such file or directory, realpath '${path}'`)
          e.code = 'ENOENT'
          throw e
        }
        if (path !== '/project/blog') return undefined
        return {
          id: 'ws-1',
          path,
          title: '五',
          attachSession: async (sid) => {
            if (ctx.workspaceRegistry.attachFailures > 0) {
              ctx.workspaceRegistry.attachFailures -= 1
              throw new Error('simulated attach race failure')
            }
            attached.push(sid)
          },
        }
      },
      // create 兜底：workspace 记录不存在时（显式 cwd 新目录）先建再 attach
      create: async (path) => {
        ctx.workspaceRegistry.created.push(path)
        return {
          id: 'ws-2',
          path,
          title: '新建组',
          attachSession: async (sid) => { attached.push(sid) },
        }
      },
    },
    sessionTitle: {
      rename: (session, title) => { renamed.push({ sid: session.id, title }); return { title } },
      get: (session) => (session?.id === 'session-gui' ? { title: '审查者' } : undefined),
    },
    sessionPersistence: persistence ?? {
      // 缺省：session-restored 有自身模型配置（含 webUI 改过的），
      // 其他会话无记录（events 空）
      inspect: async (sid) => ({
        meta: { id: sid },
        events: sid === 'session-restored'
          ? [{ type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-webui', reasoningEffort: 'high' } } } }]
          : [],
      }),
    },
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

test('SessionOrch resolves an optional workspace service lazily', () => {
  const dir = tempDir()
  const ctx = makeCtx(makeFakeAgents())
  const workspace = ctx.workspaceRegistry
  let published
  ctx.get = (name) => (name === 'workspaceRegistry' ? published : undefined)
  const orch = new SessionOrch(ctx, {
    store: new SessionOrchStore(dir),
    getBroadcastStore: () => undefined,
  })

  assert.equal(orch.workspace, undefined, 'headless starts without workspaceRegistry')
  published = workspace
  assert.equal(orch.workspace, workspace, 'a later web-host service is observed on demand')
  rmSync(dir, { recursive: true, force: true })
})

test('attachWorkspace keeps one optional-service generation per attempt', async () => {
  const dir = tempDir()
  const ctx = makeCtx(makeFakeAgents())
  let published
  let created = 0
  let attached = null
  const firstGeneration = {
    resolveByPath: async () => {
      published = undefined
      return undefined
    },
    create: async () => {
      created += 1
      return { id: 'ws-stable', title: 'stable', attachSession: async (sid) => { attached = sid } }
    },
  }
  published = firstGeneration
  ctx.get = (name) => (name === 'workspaceRegistry' ? published : undefined)
  const orch = new SessionOrch(ctx, {
    store: new SessionOrchStore(dir),
    getBroadcastStore: () => undefined,
    attachDelays: [0],
  })

  const result = await orch.attachWorkspace('session-child', dir)
  assert.equal(result.ok, true)
  assert.equal(created, 1, 'create must use the same provider captured before resolveByPath')
  assert.equal(attached, 'session-child')
  rmSync(dir, { recursive: true, force: true })
})

test('de_session schema: Code Mode 安全——模型可见文本不含 {{ 模板语法', () => {
  const dir = tempDir()
  const ctx = makeCtx(makeFakeAgents())
  const orch = new SessionOrch(ctx, { store: new SessionOrchStore(dir), getBroadcastStore: () => undefined })
  const tool = sessionToolDefinition(orch)
  // Code Mode 把工具 schema 文本序列化进 tools:sdk 提示词段，宿主渲染器将
  // {{...}} 当模板变量解析（未注册即 throw unknown prompt variable，见
  // issue #13 / PR #10）——插件侧 schema 文本绝不能泄漏该语法（与
  // de_prompts 同款回归）。回归断言：description/parameters/output
  // 均不得含 {{ 序列。
  const modelFacingSchema = JSON.stringify({
    description: tool.description,
    parameters: tool.parameters,
    output: tool.output?.schema,
  })
  assert.equal(modelFacingSchema.includes('{{'), false, 'de_session schema must be safe for Code Mode prompt rendering')
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
  // 正常 spawn（requester=发起会话：继承它的 provider/model + cwd +
  // 思考等级——新会话无历史配置必须显式给，否则 {{model}} 无值回合失败/
  // 落默认工作区/思考等级用模型默认）
  const prompt = '你是美工，负责网站视觉。现在开始执行任务：设计首页 Banner，要求……（长文本自由组合）'
  const requesterAgent = {
    session: {
      id: 'session-pm',
      header: { cwd: '/project/blog' },
      // 发起会话的历史请求头（含思考等级 high）——spawn 继承的依据
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }, adapterDefaults: {} }),
    },
    options: { provider: 'deepseek', model: 'deepseek-chat' },
  }
  const res = await tool.execute({ action: 'spawn', prompt }, { agent: requesterAgent })
  assert.equal(res.ok, true)
  assert.match(res.sessionId, /^session-[0-9a-f-]+$/)
  // create 参数正确（agentOptions 继承 model；meta.cwd 继承发起会话）
  const created = agents.state.created[0]
  assert.equal(created.sessionId, res.sessionId)
  assert.equal(created.meta.cwd, '/project/blog', 'cwd 继承发起会话（否则新会话落默认工作区）')
  assert.equal(created.agentOptions.provider, 'deepseek', 'provider 继承发起会话')
  assert.equal(created.agentOptions.model, 'deepseek-chat', 'model 继承发起会话')
  // 思考等级继承：seed 注入 request/header（AgentOptions 无 reasoningEffort，
  // 靠历史 header 恢复；新会话无历史 → 与产品经理思考等级不一致的坑）
  assert.ok(Array.isArray(created.seed), '同模型时 seed 注入 request/header')
  assert.equal(created.seed[0].type, 'request/header')
  assert.equal(created.seed[0].seq, 0, 'seed 事件 seq 必须从 0 开始（DSH 校验 contiguous from 0）')
  assert.equal(created.seed[0].data.header.config.model, 'deepseek-chat')
  assert.equal(created.seed[0].data.header.config.reasoningEffort, 'high', '思考等级继承发起会话')
  // 工作区挂接：cwd 对应已注册 workspace → attachSession 被调用
  // （左侧"项目"分组；曾漏 attach 导致 cwd 正确但会话在「未分组」）
  assert.deepEqual(ctx.attached, [res.sessionId], '新会话挂到 cwd 对应工作区')
  // ⚠️ attach 结果如实返回（2026-08-12 修复：失败不再静默吞掉）
  assert.equal(res.attach.ok, true, 'attach 成功')
  assert.equal(res.attach.workspaceId, 'ws-1')
  assert.equal(res.attach.workspaceTitle, '五')
  assert.equal(res.attach.attempts, 1, '首试成功无重试')
  assert.match(res.message, /已挂接工作区「五」/, 'message 提示挂接结果')
  // 显式 cwd/model 优先于继承；**换不同模型时思考等级不继承**
  // （目标模型可能不支持思考等级）
  const res2 = await tool.execute({ action: 'spawn', prompt: '任务2', cwd: '/other', model: 'my-model' }, { agent: requesterAgent })
  assert.equal(agents.state.created[1].meta.cwd, '/other')
  assert.equal(agents.state.created[1].agentOptions.model, 'my-model')
  assert.equal(agents.state.created[1].agentOptions.provider, 'deepseek')
  assert.ok(Array.isArray(agents.state.created[1].seed), '换模型时仍注入 header（provider/model 本身）')
  assert.equal(agents.state.created[1].seed[0].data.header.config.model, 'my-model')
  assert.equal(agents.state.created[1].seed[0].data.header.config.reasoningEffort, undefined, '换模型不继承思考等级')
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

test('spawn agentPreset：合法预设透传 agents.create meta + 留档 + list 可见', async () => {
  const dir = tempDir()
  // 假 preset roster：临时目录里造 code/ 与 minimal/ 两个预设目录
  // （真实部署时 shipped=~/.dsh/source/current/apps/cli/config/agent-presets，
  // user=~/.dsh/.agent-presets；测试用 presetRoots 注入隔离，不碰真实目录）
  const presetDir = join(dir, 'presets')
  mkdirSync(join(presetDir, 'code'), { recursive: true })
  mkdirSync(join(presetDir, 'minimal'), { recursive: true })
  const agents = makeFakeAgents()
  const ctx = makeCtx(agents)
  const orch = new SessionOrch(ctx, {
    store: new SessionOrchStore(dir),
    getBroadcastStore: () => undefined,
    presetRoots: [{ path: presetDir, shipped: false }],
  })
  const tool = sessionToolDefinition(orch)
  const requesterAgent = {
    session: { id: 'session-pm', header: { cwd: '/project/blog' }, requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }) },
    options: { provider: 'deepseek', model: 'deepseek-chat' },
  }
  const res = await tool.execute({ action: 'spawn', prompt: '任务', agentPreset: 'code' }, { agent: requesterAgent })
  assert.equal(res.ok, true)
  // ① 透传：agentPreset 进 create 的 **meta**（⚠️ 不是 agentOptions——
  // DSH CreateAgentOptions.meta.agentPreset，见 packages/core/agent/src/index.ts:99）
  const created = agents.state.created[0]
  assert.equal(created.meta.agentPreset, 'code', 'agentPreset 透传 agents.create meta')
  assert.equal(created.meta.cwd, '/project/blog', 'cwd 与 agentPreset 同在 meta，互不影响')
  // ② 返回如实带预设
  assert.equal(res.agentPreset, 'code')
  assert.match(res.message, /Agent 预设 code/, 'message 提示创建时用的预设')
  // ③ 记录留档（sessions.json：创建时配置属会话事实，list 追溯用）
  const saved = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'))
  assert.equal(saved[0].agentPreset, 'code')
  // ④ list() 输出 sessions 带 agentPreset（schema 已同步声明）
  const listRes = await tool.execute({ action: 'list' }, { agent: requesterAgent })
  const rec = listRes.sessions.find((s) => s.sessionId === res.sessionId)
  assert.equal(rec.agentPreset, 'code')
  // ⑤ 不传 agentPreset：行为不变（meta 无该字段、返回 null、记录 null）
  const res2 = await tool.execute({ action: 'spawn', prompt: '任务2' }, { agent: requesterAgent })
  assert.equal(res2.ok, true)
  assert.equal(res2.agentPreset, null)
  assert.equal(agents.state.created[1].meta.agentPreset, undefined, '不传=meta 无 agentPreset（走 DSH 默认预设）')
  const saved2 = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'))
  assert.equal(saved2[1].agentPreset, null)
  rmSync(dir, { recursive: true, force: true })
})

test('spawn agentPreset：格式不合法 / 不存在 → 明确报错并列出可用预设，不创建会话', async () => {
  const dir = tempDir()
  const presetDir = join(dir, 'presets')
  mkdirSync(join(presetDir, 'code'), { recursive: true })
  mkdirSync(join(presetDir, 'minimal'), { recursive: true })
  const agents = makeFakeAgents()
  const ctx = makeCtx(agents)
  const orch = new SessionOrch(ctx, {
    store: new SessionOrchStore(dir),
    getBroadcastStore: () => undefined,
    presetRoots: [{ path: presetDir, shipped: false }],
  })
  const tool = sessionToolDefinition(orch)
  const requester = { agent: { session: { id: 'session-pm' } } }
  // ① 格式不合法（含大写/下划线——DSH PRESET_ID 只允许小写字母数字连字符）
  const bad = await tool.execute({ action: 'spawn', prompt: '任务', agentPreset: 'Bad_Preset!' }, requester)
  assert.equal(bad.ok, false)
  assert.match(bad.message, /格式不合法/)
  assert.match(bad.message, /\[a-z0-9\]\[a-z0-9-\]\*/)
  // ② 格式合法但不存在：报错并列出可用预设（AI 可直接照抄重试）
  const missing = await tool.execute({ action: 'spawn', prompt: '任务', agentPreset: 'nope' }, requester)
  assert.equal(missing.ok, false)
  assert.match(missing.message, /"nope" 不存在/)
  assert.match(missing.message, /可用预设：code, minimal/)
  // ③ 两种失败都不创建会话（agents.create 未被调用，无残留）
  assert.equal(agents.state.created.length, 0, '校验失败不创建会话')
  rmSync(dir, { recursive: true, force: true })
})

test('spawn 显式 model：按模型名自动解析 provider（与 GUI 模型选择框同源）；显式 provider 优先；解析不到提示风险', async () => {
  const dir = tempDir()
  const agents = makeFakeAgents()
  // fake 模型目录（settings.yaml 同构）：qwen3.7-plus 属于 qwen-token-plan-cn
  const fakeLlm = {
    listConfigurableProviders: () => [
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: ['providers', 'deepseek-official'] },
      { provider: 'qwen-token-plan-cn', displayName: 'Qwen Token Plan CN', settingsNs: 'llm-qtp', settingsPath: ['providers', 'qwen-token-plan-cn'] },
    ],
  }
  const ctx = makeCtx(agents, undefined, fakeLlm)
  const orch = new SessionOrch(ctx, { store: new SessionOrchStore(dir), getBroadcastStore: () => undefined })
  const tool = sessionToolDefinition(orch)
  // 发起会话：deepseek-official / deepseek-v4-flash（历史 header 带思考等级）
  const requesterAgent = {
    session: {
      id: 'session-pm',
      header: { cwd: '/project/blog' },
      requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }, adapterDefaults: {} }),
    },
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  }
  // ① 显式传 model='qwen3.7-plus'（只在 qwen-token-plan-cn 目录）：
  //    provider 自动解析为 qwen-token-plan-cn（曾只换 model 不换 provider，
  //    把 qwen3.7-plus 发给 deepseek 接口报 INVALID_REQUEST——GUI 选择框
  //    =「provider 下选模型」天然带 provider 所以手动选能成功）
  const res = await tool.execute({ action: 'spawn', prompt: '任务', model: 'qwen3.7-plus' }, { agent: requesterAgent })
  assert.equal(res.ok, true)
  const created = agents.state.created[0]
  assert.equal(created.agentOptions.provider, 'qwen-token-plan-cn', 'provider 按模型名解析')
  assert.equal(created.agentOptions.model, 'qwen3.7-plus')
  assert.equal(res.provider, 'qwen-token-plan-cn', '返回带实际 provider')
  assert.match(res.message, /qwen-token-plan-cn/, 'message 提示解析结果')
  // seed：provider 与发起会话不同 → header 用新 provider/model、不带思考等级
  assert.equal(created.seed[0].data.header.config.provider, 'qwen-token-plan-cn')
  assert.equal(created.seed[0].data.header.config.model, 'qwen3.7-plus')
  assert.equal(created.seed[0].data.header.config.reasoningEffort, undefined, '不同 provider 不继承思考等级')
  // ② 显式 provider 参数优先于自动解析
  const res2 = await tool.execute({ action: 'spawn', prompt: '任务2', model: 'qwen3.7-plus', provider: 'zai-coding-cn' }, { agent: requesterAgent })
  assert.equal(res2.ok, true)
  assert.equal(agents.state.created[1].agentOptions.provider, 'zai-coding-cn', '显式 provider 最高优先')
  // ③ 解析不到：退回发起会话 provider + 明确风险提示（诚实原则）
  const res3 = await tool.execute({ action: 'spawn', prompt: '任务3', model: 'no-such-model' }, { agent: requesterAgent })
  assert.equal(res3.ok, true)
  assert.equal(agents.state.created[2].agentOptions.provider, 'deepseek-official', '解析不到退回继承')
  assert.match(res3.message, /INVALID_REQUEST/, '提示可能报错')
  // ④ 记录落盘含 provider（list 追溯/展示用）
  const saved = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'))
  assert.equal(saved[0].provider, 'qwen-token-plan-cn')
  assert.equal(saved[1].provider, 'zai-coding-cn')
  // ⑤ list 输出含 provider（旧记录缺字段补 null 不破 schema；列表新→旧）
  const list = await tool.execute({ action: 'list' }, {})
  assert.equal(list.ok, true)
  assert.equal(list.sessions.length, 3)
  assert.equal(list.sessions[0].provider, 'deepseek-official', '最新记录（no-such-model 退回继承）')
  assert.equal(list.sessions[2].provider, 'qwen-token-plan-cn', '最早记录（qwen3.7-plus 解析成功）')
  rmSync(dir, { recursive: true, force: true })
})

test('spawn attach：失败自动重试成功 / 一直失败如实报告不阻断 / 新目录 create 兜底', async () => {
  const dir = tempDir()
  mkdirSync(dir, { recursive: true })
  const agents = makeFakeAgents()
  const ctx = makeCtx(agents)
  // attachDelays 传 [0,…] 免测试等待（真实默认 [0,300,1200,4000]）
  const orch = new SessionOrch(ctx, { store: new SessionOrchStore(dir), getBroadcastStore: () => undefined, attachDelays: [0, 0, 0, 0] })
  const tool = sessionToolDefinition(orch)
  const requester = { session: { id: 's-pm', header: { cwd: '/project/blog' } }, options: {} }
  // ① 首次 attach 失败（模拟 readSessionHeader 竞态）→ 自动重试成功
  ctx.workspaceRegistry.attachFailures = 1
  const res = await tool.execute({ action: 'spawn', prompt: '任务' }, { agent: requester })
  assert.equal(res.ok, true)
  assert.equal(res.attach.ok, true, '重试后成功')
  assert.equal(res.attach.attempts, 2, '首试失败 + 重试 1 次')
  assert.equal(res.attach.error, undefined, '成功无 error')
  assert.equal(ctx.attached.includes(res.sessionId), true)
  assert.match(res.message, /已挂接工作区「五」/)
  // ② 一直失败：spawn 仍成功（attach 不阻断创建），attach.ok=false + message 警告
  ctx.workspaceRegistry.attachFailures = 99
  const res2 = await tool.execute({ action: 'spawn', prompt: '任务2' }, { agent: requester })
  assert.equal(res2.ok, true, 'attach 失败不阻断 spawn')
  assert.equal(res2.attach.ok, false)
  assert.equal(res2.attach.attempts, 4, '全部重试次数用尽')
  assert.match(res2.attach.error, /simulated/)
  assert.match(res2.message, /挂接工作区失败/, 'message 如实警告')
  // ③ 显式 cwd 的新目录（workspace 记录不存在）→ create 兜底后 attach 成功
  const res3 = await tool.execute({ action: 'spawn', prompt: '任务3', cwd: '/brand/new-dir' }, { agent: requester })
  assert.equal(res3.attach.ok, true, 'create 兜底后挂接成功')
  assert.deepEqual(ctx.workspaceRegistry.created, ['/brand/new-dir'], 'create 被调用（与 GUI 创建会话同款）')
  assert.equal(res3.attach.workspaceId, 'ws-2')
  assert.equal(ctx.attached.includes(res3.sessionId), true)
  rmSync(dir, { recursive: true, force: true })
})

test('spawn attach：cwd 目录不存在（工作区被删/磁盘未挂载）→ 确定性跳过，不重试不刷屏', async () => {
  const dir = tempDir()
  mkdirSync(dir, { recursive: true })
  const agents = makeFakeAgents()
  const ctx = makeCtx(agents)
  const orch = new SessionOrch(ctx, { store: new SessionOrchStore(dir), getBroadcastStore: () => undefined, attachDelays: [0, 0, 0, 0] })
  const tool = sessionToolDefinition(orch)
  const requester = { session: { id: 's-pm', header: { cwd: '/project/blog' } }, options: {} }
  // cwd 目录不存在（如 /Volumes/data/260808/7 工作区被删除）：确定性失败
  // ⚠️ 2026-08-12 用户反馈：之前每个会话重试 4 次 + warn 刷屏——目录不存在
  // 等多久都不会恢复，直接 skipped 返回，不重试
  ctx.workspaceRegistry.missingPaths.push('/Volumes/gone-project')
  const res = await tool.execute({ action: 'spawn', prompt: '任务', cwd: '/Volumes/gone-project' }, { agent: requester })
  assert.equal(res.ok, true, 'spawn 本身不受影响')
  assert.equal(res.attach.ok, false)
  assert.equal(res.attach.skipped, true, '目录不存在=确定性跳过标记')
  assert.equal(res.attach.attempts, 1, '不重试（无意义的等待）')
  assert.match(res.attach.error, /不存在/, '错误说明原因')
  assert.match(res.message, /未挂接分组/, 'message 如实提示（不带⚠️刷屏）')
  assert.equal(ctx.attached.length, 0, '未写入任何分组')
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
  // ⚠️ 模型配置必须传给 resume：inspect 读会话自己最后使用的模型
  // （request/header，含 webUI 改过的）——否则恢复的 agent.options 为空，
  // {{model}} 变量无值导致被唤醒会话回合失败（2026-08-11 踩坑修复）
  assert.deepEqual(agents.state.resumed[0].agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-webui' }, 'resume 带会话自身模型配置')
  assert.equal(agents.live.get('session-restored').followups[0].content[0].text, '继续')
  // resume 失败（会话不存在）：明确报错
  const wakeMissing = await tool.execute({ action: 'wake', sessionId: 'session-missing', prompt: 'hi' }, {})
  assert.equal(wakeMissing.ok, false)
  assert.match(wakeMissing.message, /不在当前进程且自动恢复失败/)
  rmSync(dir, { recursive: true, force: true })
})

test('wake offline: 会话 log 无模型记录时 resume 不带 agentOptions（不崩）', async () => {
  const dir = tempDir()
  mkdirSync(dir, { recursive: true })
  const agents = makeFakeAgents()
  // 持久化：任何会话都无 request/header 记录
  const persistence = { inspect: async () => ({ meta: {}, events: [] }) }
  const { AliasStore } = await import('../lib/aliases.js')
  const orch = new SessionOrch(makeCtx(agents, persistence), { store: new SessionOrchStore(dir), aliasStore: new AliasStore(dir), getBroadcastStore: () => undefined })
  const tool = sessionToolDefinition(orch)
  const wake = await tool.execute({ action: 'wake', sessionId: 'session-restored', prompt: '继续' }, {})
  assert.equal(wake.ok, true)
  assert.equal(agents.state.resumed.length, 1)
  assert.equal(agents.state.resumed[0].agentOptions, undefined, '无模型记录不传 agentOptions（保持原行为）')
  // inspect 抛异常也不影响唤醒（防御）
  const persistence2 = { inspect: async () => { throw new Error('corrupt') } }
  const orch2 = new SessionOrch(makeCtx(agents, persistence2), { store: new SessionOrchStore(dir), aliasStore: new AliasStore(dir), getBroadcastStore: () => undefined })
  const tool2 = sessionToolDefinition(orch2)
  const wake2 = await tool2.execute({ action: 'wake', sessionId: 'session-restored2', prompt: '继续' }, {})
  assert.equal(wake2.ok, true)
  rmSync(dir, { recursive: true, force: true })
})

test('status / list: 状态视图（running/idle/offline + spawn 记录）', async () => {
  const dir = tempDir()
  mkdirSync(dir, { recursive: true })
  const agents = makeFakeAgents()
  const { AliasStore } = await import('../lib/aliases.js')
  const orch = new SessionOrch(makeCtx(agents), { store: new SessionOrchStore(dir), aliasStore: new AliasStore(dir), getBroadcastStore: () => undefined })
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
  // status：GUI 会话 idle（带名称/别名——产品经理一眼认出是谁）
  const st2 = await tool.execute({ action: 'status', sessionId: 'session-gui' }, {})
  assert.equal(st2.status, 'idle')
  assert.equal(st2.spawned, false)
  assert.equal(st2.lastActiveAt, 1700000000000)
  assert.equal(st2.title, '审查者', 'status 返回会话名称（live 可查）')
  assert.equal(st2.alias, null, 'status 返回别名（未设置=null）')
  // 别名：设置后 status 也能查到（offline 也查得到——文件存储）
  const st2b = await tool.execute({ action: 'rename', sessionId: 'session-gui', alias: '小张' }, {})
  assert.equal(st2b.ok, true)
  const st2c = await tool.execute({ action: 'status', sessionId: 'session-gui' }, {})
  assert.equal(st2c.alias, '小张')
  // offline 会话：别名可查、名称 null（需 live）
  const st3b = await tool.execute({ action: 'status', sessionId: 'session-ghost' }, {})
  assert.equal(st3b.alias, null)
  assert.equal(st3b.title, null)
  // render 兜底：status 返回即使无 message 也渲染可读状态行（曾输出空
  // 字符串导致产品经理 status 查询"没有返回"）
  const rendered = tool.output.render({}, st1)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.ok(String(rendered[0].text).includes('running'), 'render 输出含状态')
  assert.ok(String(rendered[0].text).includes(spawnedId), 'render 输出含会话 ID')
  assert.ok(String(st1.message).includes('running'), 'status live 分支带 message 文案')
  // ⏰ 当前时间锚点（2026-08-12 用户要求）：lastActiveAt 是事件时间（可能
  // 是过往），now 让模型对比判断新旧；render 输出前置「⏰ 当前时间」精确到秒
  assert.equal(typeof st1.now, 'number', 'status 返回当前时间锚点')
  assert.equal(typeof st3b.now, 'number', 'offline status 也带锚点')
  const renderedText = String(rendered[0].text)
  assert.match(renderedText, /^⏰ 当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/m, 'render 输出以当前时间锚点开头（精确到秒）')
  // status：从未见过的会话 offline
  const st3 = await tool.execute({ action: 'status', sessionId: 'session-ghost' }, {})
  assert.equal(st3.status, 'offline')
  assert.equal(st3.spawned, false)
  assert.equal(st3.lastActiveAt, null)
  // list：live 全量 + spawn 记录（带状态与 lastActiveAt + now 锚点）
  const list = await tool.execute({ action: 'list' }, {})
  assert.equal(list.ok, true)
  assert.equal(list.live.length, 2)
  assert.equal(list.live[0].lastActiveAt, 1700000000000)
  assert.equal(list.sessions.length, 1)
  assert.equal(list.sessions[0].status, 'running')
  assert.equal(list.sessions[0].spawnedBy, 's-pm')
  assert.equal(list.sessions[0].lastActiveAt, 1700000000000)
  assert.equal(typeof list.now, 'number', 'list 也带当前时间锚点')
  const listRendered = tool.output.render({}, list)
  assert.match(String(listRendered[0].text), /^⏰ 当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/m, 'list render 同样前置时间锚点')
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

test('rename: 改会话名称（live 必需）+ 改/清别名（共享 AliasStore）', async () => {
  const dir = tempDir()
  mkdirSync(dir, { recursive: true })
  const agents = makeFakeAgents()
  const ctx = makeCtx(agents)
  // 用真实 AliasStore 作为共享别名存储（同 /api/aliases 实例行为）
  const { AliasStore } = await import('../lib/aliases.js')
  const aliasStore = new AliasStore(dir)
  const orch = new SessionOrch(ctx, { store: new SessionOrchStore(dir), aliasStore, getBroadcastStore: () => undefined })
  const tool = sessionToolDefinition(orch)
  // 参数校验：无 sessionId / 既无 title 也无 alias
  assert.equal((await tool.execute({ action: 'rename', title: 'x' }, {})).ok, false)
  assert.equal((await tool.execute({ action: 'rename', sessionId: 's-x' }, {})).ok, false)
  // live 会话：同时改名称 + 别名
  const liveAgent = makeAgent('session-live', '/p')
  agents.live.set('session-live', liveAgent)
  const res = await tool.execute({ action: 'rename', sessionId: 'session-live', title: '美工-小张', alias: '小张' }, {})
  assert.equal(res.ok, true)
  assert.equal(ctx.renamed.length, 1)
  assert.equal(ctx.renamed[0].sid, 'session-live')
  assert.equal(ctx.renamed[0].title, '美工-小张')
  assert.equal(aliasStore.get('session-live'), '小张', '别名写入共享存储')
  // 别名传空串 = 清除
  const cleared = await tool.execute({ action: 'rename', sessionId: 'session-live', alias: '' }, {})
  assert.equal(cleared.ok, true)
  assert.equal(aliasStore.get('session-live'), undefined, '空串清除别名')
  // 只改别名（无 title）
  const aliasOnly = await tool.execute({ action: 'rename', sessionId: 'session-live', alias: '美工' }, {})
  assert.equal(aliasOnly.ok, true)
  assert.equal(aliasOnly.title, null)
  assert.equal(ctx.renamed.length, 1, '未传 title 不触发名称服务')
  // offline 会话改名称：明确报错（可先 wake 恢复）
  const offline = await tool.execute({ action: 'rename', sessionId: 'session-ghost', title: '幽灵' }, {})
  assert.equal(offline.ok, false)
  assert.match(offline.message, /不在当前进程/)
  // 别名对 offline 会话仍可用（别名是文件存储，不依赖 live）
  const aliasOffline = await tool.execute({ action: 'rename', sessionId: 'session-ghost', alias: '幽灵别名' }, {})
  assert.equal(aliasOffline.ok, true)
  assert.equal(aliasStore.get('session-ghost'), '幽灵别名')
  rmSync(dir, { recursive: true, force: true })
})

test('find: 按名称/别名/ID 关键字查会话（无 GUI 渠道"说名字查 ID"）', async () => {
  const dir = tempDir()
  mkdirSync(dir, { recursive: true })
  const agents = makeFakeAgents()
  const ctx = makeCtx(agents)
  const { AliasStore } = await import('../lib/aliases.js')
  const aliasStore = new AliasStore(dir)
  const store = new SessionOrchStore(dir)
  const orch = new SessionOrch(ctx, { store, aliasStore, getBroadcastStore: () => undefined })
  const tool = sessionToolDefinition(orch)
  // ① live 会话：名称「审查者」（makeCtx sessionTitle fake）+ 别名「审查员小张」
  const guiAgent = makeAgent('session-gui', '/g')
  guiAgent.status = 'idle'
  agents.live.set('session-gui', guiAgent)
  aliasStore.set('session-gui', '审查员小张')
  // ② spawn 记录（offline）：别名「美工」，无名称（offline 拿不到）
  store.add({ sessionId: 'session-art', spawnedBy: 's-pm', prompt: '你是美工', cwd: '/p', roomId: null, model: null, createdAt: 1 })
  aliasStore.set('session-art', '美工')
  // 参数校验：query 必填
  assert.equal((await tool.execute({ action: 'find' }, {})).ok, false)
  assert.equal((await tool.execute({ action: 'find', query: '  ' }, {})).ok, false)
  // 按名称查（live）：命中 session-gui
  const r1 = await tool.execute({ action: 'find', query: '审查者' }, {})
  assert.equal(r1.ok, true)
  assert.equal(r1.count, 1)
  assert.equal(r1.matches[0].sessionId, 'session-gui')
  assert.equal(r1.matches[0].status, 'idle')
  assert.equal(r1.matches[0].title, '审查者')
  assert.equal(r1.matches[0].alias, '审查员小张')
  // 按别名查（offline 也命中——文件存储不依赖 live）
  const r2 = await tool.execute({ action: 'find', query: '美工' }, {})
  assert.equal(r2.count, 1)
  assert.equal(r2.matches[0].sessionId, 'session-art')
  assert.equal(r2.matches[0].status, 'offline')
  assert.equal(r2.matches[0].title, null, 'offline 名称不可读=null')
  assert.equal(r2.matches[0].spawned, true)
  // 按 ID 子串查
  const r3 = await tool.execute({ action: 'find', query: 'session-gui' }, {})
  assert.equal(r3.count, 1)
  assert.equal(r3.matches[0].sessionId, 'session-gui')
  // 别名子串（"小张"命中"审查员小张"）
  const r3b = await tool.execute({ action: 'find', query: '小张' }, {})
  assert.equal(r3b.count, 1)
  // 无匹配：count=0 + message 引导
  const r4 = await tool.execute({ action: 'find', query: '不存在的人' }, {})
  assert.equal(r4.count, 0)
  assert.deepEqual(r4.matches, [])
  assert.match(r4.message, /未找到匹配/)
  // render：匹配列表可读、无匹配有引导
  const rendered = tool.output.render({}, r1)
  assert.ok(String(rendered[0].text).includes('session-gui'))
  assert.ok(String(rendered[0].text).includes('审查员小张'))
  const renderedEmpty = tool.output.render({}, r4)
  assert.match(String(renderedEmpty[0].text), /未找到匹配/)
  rmSync(dir, { recursive: true, force: true })
})

test('me: 查当前会话自身信息（ID/名称/别名/分组/git/模型/创建者）', async () => {
  const dir = tempDir()
  mkdirSync(dir, { recursive: true })
  const agents = makeFakeAgents()
  const ctx = makeCtx(agents)
  const { AliasStore } = await import('../lib/aliases.js')
  const aliasStore = new AliasStore(dir)
  aliasStore.set('session-me', '老张')
  const store = new SessionOrchStore(dir)
  // 记录 spawn 关系：session-me 由 session-pm 创建（spawnedBy 溯源）
  store.add({ sessionId: 'session-me', spawnedBy: 'session-pm', prompt: '你是美工', cwd: '/project/blog', roomId: null, model: null, createdAt: 1 })
  const orch = new SessionOrch(ctx, { store, aliasStore, getBroadcastStore: () => undefined })
  const tool = sessionToolDefinition(orch)
  // 无 agent 上下文：报错
  const noAgent = await tool.execute({ action: 'me' }, {})
  assert.equal(noAgent.ok, false)
  // 正常查询：当前会话 = 调用方 agent
  const meAgent = {
    id: 'session-me',
    status: 'running',
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    session: { id: 'session-me', header: { cwd: '/project/blog', createdAt: 1700000000000, parentSession: 'session-parent' } },
  }
  const res = await tool.execute({ action: 'me' }, { agent: meAgent })
  assert.equal(res.ok, true)
  assert.equal(res.sessionId, 'session-me')
  assert.equal(res.alias, '老张', '别名来自共享存储')
  assert.equal(res.status, 'running')
  assert.equal(res.cwd, '/project/blog')
  assert.equal(res.provider, 'deepseek')
  assert.equal(res.model, 'deepseek-chat')
  assert.equal(res.spawned, true)
  assert.equal(res.spawnedBy, 'session-pm', '创建者溯源（spawn 记录）')
  assert.equal(res.createdAt, 1700000000000, '创建时间')
  assert.equal(res.parentSession, 'session-parent', '父会话')
  assert.equal(res.workspaceId, 'ws-1', '所属项目分组')
  assert.equal(res.workspaceTitle, '五')
  // git 分支：/project/blog 不存在 → gitBranch 返回 undefined → null（非 git 目录也正常）
  assert.equal(res.gitBranch, null, '非 git 目录 gitBranch=null 不报错')
  assert.ok(res.message.includes('项目「五」'), 'message 含项目分组')
  assert.ok(res.message.includes('session-pm'), 'message 含创建者')
  rmSync(dir, { recursive: true, force: true })
})
