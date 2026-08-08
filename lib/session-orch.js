/**
 * 会话编排模块（de_session）——**独立子模块**（用户拍板纪律 2026-08-08：
 * 明显独立的子模块不挂在别的模块下；广播当初就是因此从 COI 拆出）。
 *
 * 能力（回答"会话能不能启动另一个会话"——DSH 原生支持，本模块封装成工具）：
 *  - spawn：程序化创建**标准 DSH 会话**——与 GUI 手动打开完全同构
 *    （同样的系统提示词/工具/记忆快照注入/持久化，会出现在左侧会话列表，
 *    可随时接管）。首条用户消息 = **完整提示词**（自由组合的长文本，
 *    如"你是美工，负责…现在开始执行：…"）；创建后立即自动开跑（等价
 *    替用户发消息）；可选 cwd（工作目录）/ roomId（加入广播房间，需广播
 *    模块启用）/ model（覆盖模型）
 *  - wake：唤醒已有会话——sessionId + 提示词，等价替用户给对方发一条
 *    消息，对方 AI 自动醒来处理（正在跑则排队）；进程重启后的会话自动
 *    resume 再唤醒
 *  - status / list：查会话状态（running=正在生成 / idle=空闲 /
 *    offline=不在本进程）与 spawn 记录
 *
 * 与广播**松耦合**：仅通过 deps.getBroadcastStore() 桥接"加入房间"
 * （广播未启用/房间不存在时忽略并提示，不影响 spawn 本身）。
 *
 * 边界：仅**同进程**会话可唤醒（跨 dsh 实例/跨机器无法程序化唤醒）；
 * 唤醒 = 替用户发消息，对方 GUI 可见全过程（可审计）。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 新会话 ID 前缀（与 DSH GUI 会话同格式 session-<uuid>）。 */
function newSessionId() {
  return `session-${randomUUID()}`
}

/** 构造一条用户消息（等价用户发消息；id 必须稳定唯一，DSH 用它追踪）。 */
function userMessage(text) {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'user' },
  }
}

function errText(err) {
  const text = err instanceof Error ? err.message : String(err)
  return text !== undefined && text.trim() !== '' ? text : '未知错误'
}

/**
 * spawn 记录存储（落盘 <dir>/sessions.json）——"谁在什么时候创建了哪个
 * 会话、任务是什么"，供 list 追溯与状态展示。
 */
export class SessionOrchStore {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'sessions.json')
    /** @type {Array<{sessionId:string, spawnedBy:string, prompt:string, cwd:string|null, roomId:string|null, createdAt:number}>} */
    this.records = []
    this.#load()
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (Array.isArray(parsed)) this.records = parsed
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[dsh-memory-evolve] 会话编排记录加载失败（忽略）: ${error.message}`)
      }
    }
  }

  #save() {
    try {
      mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.file}.tmp.${process.pid}`
      writeFileSync(tmp, JSON.stringify(this.records, null, 2) + '\n')
      renameSync(tmp, this.file)
    } catch (error) {
      console.warn(`[dsh-memory-evolve] 会话编排记录保存失败（忽略）: ${error.message}`)
    }
  }

  /** 记录一次 spawn。 */
  add(record) {
    this.records.push(record)
    this.#save()
  }

  /** 全部 spawn 记录（新→旧）。 */
  list() {
    return [...this.records].reverse()
  }

  /** 按会话 ID 查 spawn 记录。 */
  find(sessionId) {
    return this.records.find((r) => r.sessionId === sessionId)
  }
}

/**
 * 会话编排核心：封装 DSH 的 agents 服务（create/resume/get/list）为
 * 工具可调的动作。agents 服务必须已注入 ctx（DSH 核心提供）。
 *
 * ⚠️ 访问方式（2026-08-09 教训）：agents 由主插件**声明式注入**
 * （lib/index.js `export const inject = ['tools', 'systemPrompt', 'agents']`），
 * 因此插件 ctx 上 ctx.agents 直接可用——与 ctx.tools 同款。曾尝试
 * ctx.inject(['agents']) 动态注入（回调时序不可靠，工具未注册）与
 * 未声明直接读取（启动崩溃），均已弃用。
 */
export class SessionOrch {
  /**
   * @param {object} ctx - 已注入 agents 服务的 cordis ctx。
   * @param {object} deps - { store, getBroadcastStore }
   *   store：SessionOrchStore（spawn 记录）；
   *   getBroadcastStore：可选函数，返回广播 BroadcastStore（用于加入房间，
   *   广播未启用时返回 undefined）。
   */
  constructor(ctx, deps) {
    this.ctx = ctx
    this.agents = ctx.agents
    this.store = deps.store
    this.getBroadcastStore = deps.getBroadcastStore
    /** 本模块 spawn 出的 live AgentHandle（模块卸载时清理，防泄漏）。 */
    this.spawnedHandles = new Map()
  }

  /**
   * 创建新会话并派发初始任务（首条消息 = 完整提示词）。
   * @param {{prompt:string, cwd?:string, roomId?:string, model?:string, by?:string, requester?:object}} input
   *   requester：发起会话的 live Agent（新会话默认**继承它的配置**：
   *   ① provider/model——新会话无历史配置必须显式给，否则 {{model}} 无值
   *   回合失败；② cwd 工作目录——曾因不传 cwd 导致新会话落在默认工作区、
   *   不在发起会话的项目里。用户显式传 cwd/model 时优先）。
   * @returns {{ok:boolean, sessionId?:string, message?:string}}
   */
  async spawn({ prompt, cwd, roomId, model, by, requester } = {}) {
    const text = String(prompt ?? '').trim()
    if (text === '') {
      return { ok: false, message: 'spawn 必填 prompt（新会话的完整提示词，可长文本自由组合：角色/任务/要求一次写清）' }
    }
    const sessionId = newSessionId()
    // 模型配置：用户显式 model 优先；否则继承发起会话（产品经理）的
    // provider/model（新会话无历史 header，必须给——曾因空 agentOptions
    // 导致 {{model}} 无值回合失败）。⚠️ 模型选择机制（webUI 改模型等）
    // 后续再完善，当前先继承发起会话（见 TODO）。
    const base = requester?.options ?? {}
    const resolvedModel = model ?? base.model
    // 工作目录：用户显式 cwd 优先；否则继承发起会话（产品经理）的 cwd
    // （header.cwd）——保证员工会话落在同一个项目工作区
    const resolvedCwd = cwd ?? requester?.session?.header?.cwd ?? null
    let handle
    try {
      // 与 GUI 新建会话同一条路径（api-proxy 的 session.create 即调此）：
      // 系统提示词/工具/记忆快照/持久化由全局服务自动注入，无需 setup。
      handle = await this.agents.create({
        sessionId,
        agentOptions: {
          ...(base.provider ? { provider: base.provider } : {}),
          ...(resolvedModel ? { model: resolvedModel } : {}),
        },
        ...(resolvedCwd ? { meta: { cwd: resolvedCwd } } : {}),
      })
    } catch (error) {
      return { ok: false, message: `创建会话失败: ${errText(error)}` }
    }
    this.spawnedHandles.set(sessionId, handle)
    // 可选加入广播房间（松耦合桥接：广播未启用/房间不存在只提示不阻断）
    let roomNote = ''
    if (roomId) {
      const joined = this.#joinRoom(sessionId, roomId)
      roomNote = joined.ok ? `；已加入房间 ${roomId}` : `；加入房间失败：${joined.message}`
    }
    // 落盘 spawn 记录（list 追溯用；model/cwd 留档=创建时用的配置）
    this.store.add({
      sessionId,
      spawnedBy: by ?? '',
      prompt: text,
      cwd: resolvedCwd,
      roomId: roomId ?? null,
      model: resolvedModel ?? null,
      createdAt: Date.now(),
    })
    // 派发初始任务：followup = 唤醒并排队到下一回合（新会话空闲，立即开跑）
    try {
      handle.agent.followup(userMessage(text))
    } catch (error) {
      return { ok: false, message: `会话 ${sessionId} 已创建但派发初始任务失败: ${errText(error)}` }
    }
    return {
      ok: true,
      sessionId,
      message: `已创建会话 ${sessionId} 并开始执行任务${roomNote}`,
    }
  }

  /**
   * 唤醒已有会话并派发新指令（等价替用户给对方发一条消息）。
   * @param {{sessionId:string, prompt:string}} input
   * @returns {{ok:boolean, sessionId?:string, message?:string}}
   */
  async wake({ sessionId, prompt } = {}) {
    const sid = String(sessionId ?? '').trim()
    const text = String(prompt ?? '').trim()
    if (sid === '') return { ok: false, message: 'wake 必填 sessionId（要唤醒的会话 ID）' }
    if (text === '') return { ok: false, message: 'wake 必填 prompt（要对方做的事，如"现在开始执行：…"）' }
    let agent = this.agents.get(sid)
    if (agent === undefined) {
      // 进程重启后 agent 不在内存：从持久化恢复（需 sessionPersistence 已配置）。
      // ⚠️ 不传 agentOptions——被唤醒会话**用自己 log 里的模型配置**
      // （request/header 记录的最后的 provider/model，含 webUI 改过的）；
      // resume 内部以持久化 header 作为请求路由，绝不继承发起会话的模型。
      try {
        const handle = await this.agents.resume({ resumeSessionId: sid })
        agent = handle.agent
      } catch (error) {
        return {
          ok: false,
          message: `会话 ${sid} 不在当前进程且自动恢复失败（可能不存在/是跨实例会话/持久化不可用）: ${errText(error)}`,
        }
      }
    }
    try {
      agent.followup(userMessage(text))
    } catch (error) {
      return { ok: false, message: `唤醒会话 ${sid} 失败: ${errText(error)}` }
    }
    return { ok: true, sessionId: sid, message: `已唤醒会话 ${sid}，指令已送达（它正在处理；忙完前不要重复派活）` }
  }

  /**
   * 查单个会话状态（live=实际状态；不在本进程 = offline）。
   * 附 lastActiveAt（该会话最后一条事件时间，判断"停了多久"）。
   */
  status(sessionId) {
    const sid = String(sessionId ?? '').trim()
    if (sid === '') return { ok: false, message: 'status 必填 sessionId' }
    const agent = this.agents.get(sid)
    if (agent === undefined) {
      const rec = this.store.find(sid)
      return {
        ok: true,
        sessionId: sid,
        status: 'offline',
        cwd: rec?.cwd ?? null,
        spawned: rec !== undefined,
        lastActiveAt: null,
        message: '会话不在当前进程（离线或不存在；同实例会话重启后会自动恢复）',
      }
    }
    // status 的 live 分支曾**没有 message 字段** → render 只处理 message/
    // sessions/live，输出空字符串 → 产品经理 status 查询表现为"没有返回"
    // （list 正常因有数组）。补可读文案 + render 对 status 字段兜底渲染。
    return {
      ok: true,
      sessionId: sid,
      status: agent.status, // running=正在生成 / idle=空闲（等用户或指令）
      cwd: agent.session?.header?.cwd ?? null,
      spawned: this.store.find(sid) !== undefined,
      lastActiveAt: this.#lastActiveAt(agent),
      message: `会话 ${sid} 状态：${agent.status}（${agent.status === 'running' ? '正在生成' : '空闲，等指令'}）`,
    }
  }

  /**
   * 列出会话：live 会话（含 GUI 手动开的，running/idle）+ 本模块 spawn
   * 过的记录（含状态/角色提示词/所属房间）。附 lastActiveAt。
   * @returns {{ok:boolean, sessions?:Array, live?:Array}}
   */
  list() {
    const live = this.agents.list().map((agent) => ({
      sessionId: agent.id,
      status: agent.status,
      cwd: agent.session?.header?.cwd ?? null,
      spawned: this.store.find(agent.id) !== undefined,
      lastActiveAt: this.#lastActiveAt(agent),
    }))
    const sessions = this.store.list().map((rec) => {
      const liveRec = live.find((l) => l.sessionId === rec.sessionId)
      return {
        ...rec,
        status: liveRec?.status ?? 'offline',
        lastActiveAt: liveRec?.lastActiveAt ?? null,
      }
    })
    return { ok: true, sessions, live }
  }

  /** 会话最后活动时间（最后一条事件的时间戳；无事件 = null）。 */
  #lastActiveAt(agent) {
    const events = agent?.session?.events
    const last = events !== undefined && events.length > 0 ? events[events.length - 1] : undefined
    return last?.time ?? null
  }

  /** 模块卸载：清理本模块 spawn 出的 live agent（用户自己的会话不动）。 */
  disposeSpawned() {
    for (const handle of this.spawnedHandles.values()) {
      try { void handle.dispose?.() } catch { /* 忽略 */ }
    }
    this.spawnedHandles.clear()
  }

  /** 桥接广播房间（松耦合：getBroadcastStore 未提供 = 广播未启用）。 */
  #joinRoom(sessionId, roomId) {
    try {
      const broadcast = this.getBroadcastStore?.()
      if (!broadcast) return { ok: false, message: '广播模块未启用（可在运行时配置打开「会话广播」）' }
      const result = broadcast.rooms.join(roomId, sessionId)
      if (!result?.ok) return { ok: false, message: result?.message ?? '加入房间失败' }
      return { ok: true }
    } catch (error) {
      return { ok: false, message: errText(error) }
    }
  }
}

/** de_session 工具定义（schema 遵守 DSH 硬约束：单一 type、顶层 required）。 */
export function sessionToolDefinition(orch) {
  return {
    name: 'de_session',
    description: '会话编排（独立模块，开关见记忆 Tab 运行时配置「会话编排」）：程序化创建/唤醒 DSH 会话——spawn：**新建一个标准会话**（与 GUI 手动打开完全同构：同样的系统提示词/工具/记忆快照/持久化，会出现在左侧会话列表可随时接管），prompt=**完整提示词（自由组合的长文本：角色/任务/要求一次写清，如"你是美工，负责网站视觉…现在开始执行任务：…"）**，创建后立即自动开跑（等价替用户发消息）；可选 cwd（工作目录，缺省=无即默认工作区）、roomId（加入广播房间，需广播模块启用；房间不存在/未启用只提示不阻断）、model（覆盖模型）。wake：**唤醒已有会话**——sessionId + prompt（要对方做的事），等价替用户给对方发一条消息，对方 AI 自动醒来处理（正在忙则排队；忙完前不要重复派活）；进程重启后的会话自动从持久化恢复再唤醒；跨实例会话无法唤醒会明确报错。status：查单个会话（sessionId）状态——running=正在生成 / idle=空闲（已结束回合，等指令）/ offline=不在本进程，附 lastActiveAt（最后活动时间）。list：列出全部 live 会话（含 GUI 手动开的）与本模块创建过的会话（角色提示词/任务/所属房间/状态/lastActiveAt）。**员工编排纪律（重要）：本工具不会自动唤醒任何会话——必须由你（拍板人）有意识地 list/status 查状态、发现员工 idle/offline 后用 wake 主动唤醒，不要自作主张批量唤醒（会造成管理混乱）。**',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['spawn', 'wake', 'status', 'list'], description: 'spawn=新建会话；wake=唤醒已有会话；status=查单个会话状态；list=列出会话' },
        prompt: { type: 'string', description: 'spawn：新会话的完整提示词（长文本自由组合）；wake：要对方做的事' },
        sessionId: { type: 'string', description: 'wake/status 必填：目标会话 ID（用户告知或 list 查得，形如 session-xxxx）' },
        cwd: { type: 'string', description: 'spawn 可选：新会话工作目录（绝对路径；缺省=继承发起会话的工作目录，保证同一项目内协作）' },
        roomId: { type: 'string', description: 'spawn 可选：加入的广播房间 id（形如 room-xxx；需广播模块启用）' },
        model: { type: 'string', description: 'spawn 可选：覆盖模型（缺省=会话默认模型）' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          sessionId: { type: 'string' },
          status: { type: 'string', description: 'running=正在生成 / idle=空闲 / offline=不在本进程' },
          cwd: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          spawned: { type: 'boolean', description: '该会话是否由本模块创建' },
          lastActiveAt: { oneOf: [{ type: 'integer' }, { type: 'null' }], description: '最后活动时间（最后一条事件的时间戳）' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                status: { type: 'string' },
                cwd: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                spawnedBy: { type: 'string' },
                prompt: { type: 'string' },
                roomId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                model: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                createdAt: { type: 'integer' },
                spawned: { type: 'boolean' },
                lastActiveAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              },
              required: ['sessionId', 'status', 'cwd', 'spawnedBy', 'prompt', 'roomId', 'model', 'createdAt', 'lastActiveAt'],
            },
          },
          live: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                status: { type: 'string' },
                cwd: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                spawned: { type: 'boolean' },
                lastActiveAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              },
              required: ['sessionId', 'status', 'cwd', 'spawned', 'lastActiveAt'],
            },
          },
        },
        required: ['ok'],
      },
      // render：把结构化结果渲染成模型可读文本（DSH 要求 output 必须声明
      // { schema, render, presentationMeta? }——曾只写 schema 导致工具注册
      // 失败 "must declare output { schema, render, presentationMeta? }"）
      render: (_args, value) => {
        const parts = []
        if (value.message) parts.push(value.message)
        // status 查询结果兜底：即使没有 message 也渲染可读状态行
        // （曾因 live 分支无 message 输出空字符串 → 表现为"没有返回"）
        if (value.sessionId !== undefined && value.status !== undefined && !Array.isArray(value.sessions) && !Array.isArray(value.live)) {
          const mark = value.status === 'running' ? '🟢' : value.status === 'idle' ? '⚪' : '⚫'
          const when = value.lastActiveAt !== null && value.lastActiveAt !== undefined
            ? new Date(value.lastActiveAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
            : '—'
          parts.push(`${mark} ${value.sessionId} ${value.status}${value.spawned ? '（本模块创建）' : ''} · 最后活动 ${when}${value.cwd ? ` · cwd ${value.cwd}` : ''}`)
        }
        if (Array.isArray(value.sessions)) {
          const lines = value.sessions.map((s) => {
            const mark = s.status === 'running' ? '🟢' : s.status === 'idle' ? '⚪' : '⚫'
            const when = s.lastActiveAt !== null && s.lastActiveAt !== undefined
              ? new Date(s.lastActiveAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
              : '—'
            const promptHead = String(s.prompt ?? '').replaceAll('\n', ' ').slice(0, 60)
            return `${mark} ${s.sessionId} ${s.status}${s.spawnedBy ? ` · 创建者 ${s.spawnedBy}` : ''} · 最后活动 ${when}\n    ${promptHead}`
          })
          parts.push(`spawn 记录（${lines.length}）：\n${lines.join('\n')}`)
        }
        if (Array.isArray(value.live)) {
          const lines = value.live.map((l) => {
            const mark = l.status === 'running' ? '🟢' : '⚪'
            const when = l.lastActiveAt !== null && l.lastActiveAt !== undefined
              ? new Date(l.lastActiveAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })
              : '—'
            return `${mark} ${l.sessionId} ${l.status}${l.spawned ? '（本模块创建）' : ''} · 最后活动 ${when}`
          })
          parts.push(`live 会话（${lines.length}）：\n${lines.join('\n')}`)
        }
        return [{ type: 'text', text: parts.join('\n\n') }]
      },
    },
    async execute(args, ctx) {
      if (!orch) return { ok: false, message: '会话编排未就绪（DSH agents 服务不可用）' }
      const by = ctx?.agent?.session?.id ?? ''
      const action = args.action
      try {
        switch (action) {
          case 'spawn':
            // requester=发起会话的 live Agent：新会话继承它的 provider/model
            // （新会话无历史配置必须显式给，否则 {{model}} 无值回合失败）
            return await orch.spawn({ prompt: args.prompt, cwd: args.cwd, roomId: args.roomId, model: args.model, by, requester: ctx?.agent })
          case 'wake':
            return await orch.wake({ sessionId: args.sessionId, prompt: args.prompt })
          case 'status':
            return orch.status(args.sessionId)
          case 'list':
            return orch.list()
          default:
            return { ok: false, message: `未知 action "${action}"` }
        }
      } catch (error) {
        return { ok: false, message: `de_session ${action} 失败: ${errText(error)}` }
      }
    },
  }
}

/**
 * 安装会话编排模块（sessionEnabled 打开时由主插件调用）。
 * @param {object} ctx - cordis ctx（tools/agents 已由主插件声明式注入，
 *   ctx.agents 直接可用——与 tools 同款，见 lib/index.js export inject）。
 * @param {object} config - resolved plugin config（含 sessionDataDir/memoryDir）。
 * @param {object} deps - { getBroadcastStore }
 *   getBroadcastStore：可选函数，返回广播 BroadcastStore（spawn 加房间用）。
 * @returns {{ orch: () => SessionOrch|null, store: SessionOrchStore, dispose: () => void }}
 *
 * ⚠️ 教训（2026-08-09）：曾用 ctx.inject(['agents'], cb) 动态注入——
 * 回调时序依赖 agents 服务就绪状态，实测工具未注册且产生 failed 插件
 * 实例。改为插件级声明式注入（export inject 加 'agents'）后与 tools
 * 同款：apply 时服务已就绪，同步创建编排器并注册工具，可靠无时序。
 */
export function installSession(ctx, config, deps) {
  const dir = config.sessionDataDir ?? join(config.memoryDir ?? '', 'session-orch')
  mkdirSync(dir, { recursive: true })
  const store = new SessionOrchStore(dir)
  const disposers = []
  /** 当前编排器实例（卸载时置 null）。 */
  let orch = null
  try {
    // agents 已声明式注入，直接可用（同 tools）
    const instance = new SessionOrch(ctx, { store, getBroadcastStore: deps?.getBroadcastStore })
    orch = instance
    disposers.push(ctx.effect(() => {
      const d = ctx.tools.register(sessionToolDefinition(instance))
      return () => d?.()
    }, 'dsh-memory-evolve: session tool'))
  } catch (error) {
    // 理论上不会发生（agents 声明式注入保证就绪）；防御兜底：不崩插件，
    // 工具不注册，调用时报"未就绪"（execute 顶部有检查）
    console.warn(`[dsh-memory-evolve] 会话编排初始化失败（de_session 未注册）: ${error.message}`)
  }
  return {
    /** 取当前编排器（初始化失败时为 null，工具调用会报错提示）。 */
    orch: () => orch,
    store,
    dispose() {
      for (const d of disposers) {
        try { d?.() } catch { /* 忽略 */ }
      }
      try { orch?.disposeSpawned() } catch { /* 忽略 */ }
    },
  }
}
