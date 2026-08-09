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
 *    模块启用）/ model（覆盖模型——显式传时自动按模型名解析 provider，
 *    与 GUI 模型选择框同源）/ provider（显式指定供应商路由）
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
import { gitBranch } from './store.js'

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
 * 完整日期时间（YYYY-MM-DD HH:mm:ss，精确到秒）——status/list 输出前置的
 * 「⏰ 当前时间」锚点用（与 de_broadcast 输出锚点同格式，模型拿它对比
 * lastActiveAt 判断新旧）。工具输出在调用时刻生成=模型看到时刻，安全。
 */
function fmtDateTime(ts) {
  const d = new Date(ts)
  const pad2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/**
 * 判断是否为"目录缺失"类错误（ENOENT/ENOTDIR/realpath 失败）。
 * ⚠️ 2026-08-12 用户反馈：会话 cwd 指向已删除的工作区/未挂载的磁盘时，
 * workspace.resolveByPath/create 会抛 ENOENT——这是**确定性失败**（等多久
 * 都不会恢复），重试无意义且会刷屏；竞态类错误（readSessionHeader 未就绪
 * 等）才值得重试。node:fs 错误码在 err.code，realpath 包装后可能在 cause。
 */
function isDirMissingError(err) {
  if (!err) return false
  const code = err.code ?? err.cause?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return true
  const text = errText(err)
  return /ENOENT|no such file or directory|not a directory/i.test(text)
}

/**
 * spawn 记录存储（落盘 <dir>/sessions.json）——"谁在什么时候创建了哪个
 * 会话、任务是什么"，供 list 追溯与状态展示。
 */
export class SessionOrchStore {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'sessions.json')
    /** @type {Array<{sessionId:string, spawnedBy:string, prompt:string, cwd:string|null, provider:string|null, model:string|null, roomId:string|null, createdAt:number}>} */
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
    this.workspace = ctx.workspace // 工作区注册表（左侧会话列表"项目"分组依据）
    this.sessionTitle = ctx.sessionTitle // 会话名称服务（rename 改左侧列表标题）
    this.sessionPersistence = ctx.sessionPersistence // 会话持久化（wake offline 读自身模型配置）
    // ⚠️ 模型目录解析（2026-08-11 踩坑）：llm/settings 是主插件声明式注入的
    // 服务（lib/index.js export inject 已含）——spawn 显式传 model 时用它
    // **按模型名解析所属 provider**（与 GUI 模型选择框同源），否则 provider
    // 仍继承发起会话，把 qwen3.7-plus 发给 deepseek-official 接口会报
    // INVALID_REQUEST（"supported API model names are …"）。两者可能缺失
    // （测试/降级环境）——缺了就不解析，退回继承（行为同旧版）。
    this.llm = ctx.llm
    this.settings = ctx.settings
    // ⚠️ 挂接工作区重试间隔（2026-08-12 踩坑修复）：spawn 后立即 attach
    // 可能遇到 readSessionHeader 竞态（live 未注册/持久化未就绪）——失败
    // 曾被子静默吞掉，导致会话"创建后不在分组"（重启后 GUI 显示未分组，
    // 且 workspace 不会自动补录，分组永久丢失）。递增延迟重试解决；
    // deps.attachDelays 可覆盖（测试传 [0,…] 免等待）。
    this.attachDelays = Array.isArray(deps?.attachDelays) && deps.attachDelays.length > 0
      ? deps.attachDelays
      : [0, 300, 1200, 4000]
    this.store = deps.store
    this.getBroadcastStore = deps.getBroadcastStore
    this.aliasStore = deps.aliasStore // 会话别名存储（与 /api/aliases 共享实例）
    /** 本模块 spawn 出的 live AgentHandle（模块卸载时清理，防泄漏）。 */
    this.spawnedHandles = new Map()
  }

  /**
   * 修改会话名称（左侧会话列表标题）与/或会话别名（aliases.json）。
   * 会话名称走 DSH sessionTitle.rename（user source 会 pin 住标题，
   * 不会被自动生成覆盖）；**需要 live 会话**（offline 的会话可先 wake
   * 恢复再改）。别名走共享 AliasStore（alias 传空串 = 清除）。
   * @param {{sessionId:string, title?:string, alias?:string}} input
   * @returns {{ok:boolean, sessionId?:string, title?:string|null, alias?:string|null, message?:string}}
   */
  async rename({ sessionId, title, alias } = {}) {
    const sid = String(sessionId ?? '').trim()
    if (sid === '') return { ok: false, message: 'rename 必填 sessionId（要改名的会话）' }
    const hasTitle = title !== undefined && String(title).trim() !== ''
    const hasAlias = alias !== undefined
    if (!hasTitle && !hasAlias) {
      return { ok: false, message: 'rename 至少提供 title（会话名称）或 alias（会话别名）之一' }
    }
    const parts = []
    // ① 会话名称（左侧列表标题）：需要 live 会话
    if (hasTitle) {
      const agent = this.agents.get(sid)
      if (agent === undefined) {
        return { ok: false, message: `会话 ${sid} 不在当前进程，无法改名称（可先 wake 恢复再改，或用 list 确认 ID）` }
      }
      try {
        this.sessionTitle.rename(agent.session, String(title).trim())
        parts.push(`会话名称已设为「${String(title).trim()}」`)
      } catch (error) {
        return { ok: false, message: `改会话名称失败: ${errText(error)}` }
      }
    }
    // ② 会话别名（aliases.json，广播/快照显示；alias 空串 = 清除）
    if (hasAlias) {
      if (!this.aliasStore) return { ok: false, message: '别名存储不可用（aliases.json）' }
      const result = this.aliasStore.set(sid, alias)
      if (!result.ok) return { ok: false, message: result.message }
      parts.push(result.message)
    }
    return {
      ok: true,
      sessionId: sid,
      title: hasTitle ? String(title).trim() : null,
      alias: hasAlias ? String(alias).trim() : null,
      message: parts.join('；'),
    }
  }

  /**
   * 当前会话自身信息（"我是谁"）——调用方（发起工具调用的会话）的
   * session ID / 会话名称（sessionTitle）/ 别名 / 所属项目分组（workspace）/
   * cwd / git 分支 / provider+model / 创建时间 / 父会话 / 创建者 / 状态。
   * AI 常用它确认自己的身份，或把 ID/别名告知他人协作。
   * @param {object|undefined} requester - execute 的 ctx.agent（当前会话 live Agent）。
   * @returns {{ok:boolean, sessionId?:string, title?:string|null, alias?:string|null,
   *   status?:string, cwd?:string|null, workspaceId?:string|null,
   *   workspaceTitle?:string|null, gitBranch?:string|null, provider?:string|null,
   *   model?:string|null, createdAt?:number|null, parentSession?:string|null,
   *   spawned?:boolean, spawnedBy?:string|null, message?:string}}
   */
  me(requester) {
    if (!requester) return { ok: false, message: '无法获取当前会话信息（调用上下文缺少 agent）' }
    const agent = requester
    const sid = agent.id ?? agent.session?.id
    if (!sid) return { ok: false, message: '无法获取当前会话 ID' }
    let title = null
    try {
      title = this.sessionTitle?.get?.(agent.session)?.title ?? null
    } catch { /* 标题读取失败置 null */ }
    const alias = this.aliasStore?.get(sid) ?? null
    const header = agent.session?.header
    const cwd = header?.cwd ?? null
    const status = agent.status ?? 'idle'
    const provider = agent.options?.provider ?? null
    const model = agent.options?.model ?? null
    // 所属项目分组（左侧"项目"分组）：workspace 注册表按 sessionIds（
    // canonical cwd 索引）定位，同步查
    let workspaceId = null
    let workspaceTitle = null
    try {
      const ws = this.workspace?.list?.().find((w) => (w.sessionIds ?? []).includes(sid))
      if (ws) {
        workspaceId = ws.id
        workspaceTitle = ws.title
      }
    } catch { /* 分组读取失败置 null */ }
    // git 分支（按 cwd，spawnSync 同步；非 git 目录返回 null）
    let branch = null
    try {
      branch = cwd ? (gitBranch(cwd) ?? null) : null
    } catch { /* 分支读取失败置 null */ }
    const rec = this.store.find(sid)
    const spawned = rec !== undefined
    const spawnedBy = rec?.spawnedBy ?? null
    const bits = [
      `当前会话 ${sid}`,
      title ? `名称「${title}」` : null,
      alias ? `别名「${alias}」` : null,
      `状态 ${status}`,
      workspaceTitle ? `项目「${workspaceTitle}」` : null,
      cwd ? `cwd ${cwd}` : null,
      branch ? `git 分支 ${branch}` : null,
      provider && model ? `模型 ${provider}/${model}` : null,
      spawnedBy ? `创建者 ${spawnedBy}` : null,
    ].filter(Boolean)
    return {
      ok: true,
      sessionId: sid,
      title,
      alias,
      status,
      cwd,
      workspaceId,
      workspaceTitle,
      gitBranch: branch,
      provider,
      model,
      createdAt: header?.createdAt ?? null,
      parentSession: header?.parentSession ?? null,
      spawned,
      spawnedBy,
      message: bits.join('，'),
    }
  }

  /**
   * 把会话挂到 cwd 对应的工作区（左侧会话列表的"项目"分组）。
   * GUI 新建会话时 api-proxy 会显式 attachSession；spawn 曾漏掉这步，
   * 导致 cwd 正确但新会话仍显示在「未分组」。
   *
   * ⚠️ 2026-08-12 踩坑修复（用户实测"创建后不在分组，重启后永久未分组"）：
   * ① 失败**不再静默**——返回结构化结果，spawn 结果里如实报告；
   * ② **递增延迟重试**——attach 需要 readSessionHeader（live sessions 或
   *    会话持久化），spawn 后立即调用可能竞态（sessions 注册/持久化未
   *    就绪），实测当时抛错被 catch 吞掉后 workspace record 里从未写入，
   *    而 workspace 重启后不会从持久化自动补录 → 分组永久丢失；
   * ③ **workspace 不存在时 create 兜底**——GUI 创建会话对 cwd 会先
   *    create 工作区再 attach；spawn 曾只 resolveByPath，显式传新目录
   *    cwd 时返回 undefined → 永远失败。重试时 undefined → create。
   * ④ **目录不存在 = 确定性失败，不重试不刷屏**（2026-08-12 用户反馈：
   *    会话 cwd 指向已删除的工作区/目录时，之前每个会话重试 4 次 + 打
   *    warn 刷屏）——等多久都不会恢复，直接返回 skipped 标记；
   *    spawn 的 message 会如实提示。
   * @param {string} sessionId - 会话 ID。
   * @param {string|null|undefined} cwd - 会话工作目录（null=无 cwd 不挂接）。
   * @returns {Promise<{ok:boolean, workspaceId?:string|null, workspaceTitle?:string|null, error?:string, attempts:number, skipped?:boolean}>}
   *   skipped=true：cwd 目录不存在（确定性失败），没有重试价值。
   */
  async attachWorkspace(sessionId, cwd) {
    if (!cwd || !this.workspace) {
      return {
        ok: false,
        workspaceId: null,
        workspaceTitle: null,
        error: cwd ? 'workspace 服务不可用' : '无 cwd（无法确定所属分组）',
        attempts: 0,
      }
    }
    // 重试链：每次先 resolveByPath（无则 create），再 attachSession。
    // 失败原因保留最后一次；延迟递增（首试不等待）。
    let lastErr = '未知错误'
    let ws = undefined
    for (let i = 0; i < this.attachDelays.length; i++) {
      if (i > 0 && this.attachDelays[i] > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.attachDelays[i]))
      }
      try {
        ws = await this.workspace.resolveByPath(cwd)
        if (ws === undefined) {
          // workspace 记录不存在（显式 cwd 的新目录等）：create 兜底
          // （与 GUI 创建会话同款：先建工作区再 attach）
          ws = await this.workspace.create(cwd)
        }
        await ws.attachSession(sessionId)
        return {
          ok: true,
          workspaceId: ws.id,
          workspaceTitle: ws.title,
          attempts: i + 1,
        }
      } catch (error) {
        // ⚠️ 确定性失败（cwd 目录不存在，如外接卷卸载/工作区目录被删除）：
        // 不重试（等多久都不会恢复）、不打 warn（防刷屏）——直接返回
        // skipped 标记，由调用方（spawn message）如实提示即可
        if (isDirMissingError(error)) {
          return {
            ok: false,
            workspaceId: null,
            workspaceTitle: null,
            error: `cwd 目录不存在：${cwd}（工作区可能已被删除或磁盘未挂载，未挂接分组）`,
            attempts: i + 1,
            skipped: true,
          }
        }
        lastErr = errText(error)
      }
    }
    console.warn(`[dsh-memory-evolve] 会话 ${sessionId} 挂接工作区失败（已重试 ${this.attachDelays.length} 次，仅影响左侧分组显示，不影响会话本身）: ${lastErr}`)
    return {
      ok: false,
      workspaceId: ws?.id ?? null,
      workspaceTitle: ws?.title ?? null,
      error: lastErr,
      attempts: this.attachDelays.length,
    }
  }

  /**
   * 按模型名解析所属 provider（与 GUI 模型选择框同源：已配置 provider 的
   * settings 模型目录）。找不到返回 undefined（调用方退回继承发起会话）。
   * ⚠️ 2026-08-11 踩坑背景：spawn 显式传 model 时 provider 曾仍继承发起
   * 会话（如 deepseek-official），把 qwen3.7-plus 发给 deepseek 接口 →
   * "The supported API model names are deepseek-v4-pro or deepseek-v4-flash,
   * but you passed qwen3.7-plus" INVALID_REQUEST；手动 GUI 选择框是「在某个
   * provider 下选模型」天然带 provider，所以能成功。这里还原选择框的数据源。
   */
  async #resolveProviderForModel(model) {
    if (!this.llm || !this.settings) return undefined
    try {
      const entries = this.llm.listConfigurableProviders()
      for (const entry of entries) {
        let profile
        try {
          const value = this.settings.get(entry.settingsNs)
          profile = value !== undefined && entry.settingsPath.length > 0
            ? this.#getPath(value, entry.settingsPath)
            : value
        } catch { continue /* 该 provider 配置读不到，跳过 */ }
        // settingsPath 可能指到 providers 层或单个 provider 配置层，两种都兼容
        const rawModels = profile !== undefined && Array.isArray(profile.models)
          ? profile.models
          : Array.isArray(profile?.[entry.provider]?.models)
            ? profile[entry.provider].models
            : []
        if (rawModels.some((m) => String(m?.id ?? '') === model)) return entry.provider
      }
    } catch { /* 目录整体读取失败=解析不到 */ }
    return undefined
  }

  /** 取对象路径值（与 models.js getPath 同款，本地实现防跨模块耦合）。 */
  #getPath(root, path) {
    let node = root
    for (const key of path) {
      if (node === null || typeof node !== 'object') return undefined
      node = node[key]
    }
    return node
  }

  /**
   * 创建新会话并派发初始任务（首条消息 = 完整提示词）。
   * @param {{prompt:string, cwd?:string, roomId?:string, model?:string, provider?:string, by?:string, requester?:object}} input
   *   requester：发起会话的 live Agent（新会话默认**继承它的配置**：
   *   ① provider/model——新会话无历史配置必须显式给，否则 {{model}} 无值
   *   回合失败；② cwd 工作目录——曾因不传 cwd 导致新会话落在默认工作区、
   *   不在发起会话的项目里。用户显式传 cwd/model/provider 时优先）。
   *   model 显式传时**按模型名自动解析 provider**（GUI 选择框同源：
   *   settings 模型目录；解析不到退回发起会话 provider 并在 message 提示
   *   风险）；provider 显式传时直接用它（最高优先）。
   * @returns {{ok:boolean, sessionId?:string, provider?:string|null, attach?:object|null, message?:string}}
   *   attach：挂接工作区结果 { ok, workspaceId?, workspaceTitle?, error?, attempts }
   *   （cwd 为 null 时不挂接 → attach=null；失败不阻断 spawn，message 带警告）
   */
  async spawn({ prompt, cwd, roomId, model, provider, by, requester } = {}) {
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
    const explicitModel = model !== undefined && String(model).trim() !== '' ? String(model).trim() : undefined
    const explicitProvider = provider !== undefined && String(provider).trim() !== '' ? String(provider).trim() : undefined
    const resolvedModel = explicitModel ?? base.model
    // provider 解析顺序：显式 provider 参数 > 按 model 自动解析 > 继承发起会话
    // ⚠️ 2026-08-11 踩坑：曾只换 model 不换 provider（provider 恒=发起会话），
    // 把 qwen3.7-plus 发给 deepseek-official 报 INVALID_REQUEST；GUI 选择框
    // =「provider 下选模型」天然带 provider 所以手动选能成功。
    let resolvedProvider = explicitProvider
    let providerNote = ''
    if (!resolvedProvider) {
      if (explicitModel) {
        resolvedProvider = await this.#resolveProviderForModel(explicitModel)
        if (resolvedProvider) {
          // 解析到：与发起会话不同才提示（相同=无变化，不啰嗦）
          if (resolvedProvider !== base.provider) {
            providerNote = `（已按模型名解析 provider=${resolvedProvider}，与发起会话的 ${base.provider} 不同）`
          }
        } else {
          // 解析不到：退回继承，明确提示可能报错（诚实原则，不留黑盒）
          resolvedProvider = base.provider
          providerNote = resolvedProvider
            ? `（⚠️ 模型 ${explicitModel} 不在已配置 provider 的模型目录中，provider 沿用发起会话 ${resolvedProvider}——若该接口不支持此模型会报 INVALID_REQUEST）`
            : `（⚠️ 模型 ${explicitModel} 解析不到所属 provider，且发起会话无 provider 可继承）`
        }
      } else {
        resolvedProvider = base.provider
      }
    }
    // 工作目录：用户显式 cwd 优先；否则继承发起会话（产品经理）的 cwd
    // （header.cwd）——保证员工会话落在同一个项目工作区
    const resolvedCwd = cwd ?? requester?.session?.header?.cwd ?? null
    // 思考等级（reasoningEffort）继承（方案 A：seed 注入 request/header）：
    // AgentOptions 没有 reasoningEffort 字段，DSH 只在会话有历史
    // request/header 时恢复它——新会话无历史则用模型默认思考等级（曾与
    // 产品经理不一致）。把发起会话的 request/header 塞进新会话 seed，
    // 首回合即以同款配置运行（fork 会话同款机制）。
    // ⚠️ 仅当 provider+model 都一致时继承：显式覆盖了不同 model/provider 时
    // **不带** reasoningEffort（目标模型可能不支持思考等级，避免报错）。
    const requesterHeader = requester?.session?.requestHeader?.()
    let seed
    if (requesterHeader?.config?.provider && requesterHeader.config.model) {
      const sameConfig = resolvedProvider === requesterHeader.config.provider
        && resolvedModel === requesterHeader.config.model
      // 同配置：完整继承（含 reasoningEffort 等运行配置）；
      // 不同配置（显式换模型/provider）：header 用新的 provider/model、
      // **不带** reasoningEffort（目标模型可能不支持思考等级），也不带
      // adapterDefaults 标记
      const config = sameConfig
        ? { ...requesterHeader.config }
        : { provider: resolvedProvider ?? requesterHeader.config.provider, model: resolvedModel }
      seed = [{
        type: 'request/header',
        // ⚠️ seed 事件 seq 必须从 0 开始连续（DSH 校验：
        // "seed must be contiguous from 0"——曾用 1 导致 spawn 失败）
        seq: 0,
        time: Date.now(),
        data: {
          header: {
            ...(sameConfig && requesterHeader.adapterDefaults ? { adapterDefaults: requesterHeader.adapterDefaults } : {}),
            config,
          },
          reason: 'initial',
        },
      }]
    }
    let handle
    try {
      // 与 GUI 新建会话同一条路径（api-proxy 的 session.create 即调此）：
      // 系统提示词/工具/记忆快照/持久化由全局服务自动注入，无需 setup。
      handle = await this.agents.create({
        sessionId,
        agentOptions: {
          ...(resolvedProvider ? { provider: resolvedProvider } : {}),
          ...(resolvedModel ? { model: resolvedModel } : {}),
        },
        ...(resolvedCwd ? { meta: { cwd: resolvedCwd } } : {}),
        ...(seed ? { seed } : {}),
      })
    } catch (error) {
      return { ok: false, message: `创建会话失败: ${errText(error)}` }
    }
    this.spawnedHandles.set(sessionId, handle)
    // 挂到工作区（左侧"项目"分组；GUI 新建会 attach，spawn 曾漏掉导致
    // cwd 正确但会话显示在「未分组」）。⚠️ 2026-08-12：失败不再静默——
    // attachWorkspace 带重试 + create 兜底，结果如实放回 spawn 返回值
    // （attach.ok=false 时 message 也会带警告，AI 可见）；无 cwd 的会话
    // 没有分组概念 → attach=null 且不提示；cwd 目录不存在 → skipped
    // （确定性失败，不重试），message 提示原因即可
    const attach = resolvedCwd ? await this.attachWorkspace(sessionId, resolvedCwd) : null
    const attachNote = attach === null
      ? ''
      : attach.ok
        ? (attach.workspaceTitle ? `；已挂接工作区「${attach.workspaceTitle}」` : '；已挂接工作区')
        : attach.skipped
          ? `；未挂接分组：${attach.error}`
          : `；⚠️ 挂接工作区失败：${attach.error}（仅影响左侧分组显示，会话本身正常；可稍后手动修复）`
    // 可选加入广播房间（松耦合桥接：广播未启用/房间不存在只提示不阻断）
    let roomNote = ''
    if (roomId) {
      const joined = this.#joinRoom(sessionId, roomId)
      roomNote = joined.ok ? `；已加入房间 ${roomId}` : `；加入房间失败：${joined.message}`
    }
    // 落盘 spawn 记录（list 追溯用；provider/model/cwd 留档=创建时用的配置）
    this.store.add({
      sessionId,
      spawnedBy: by ?? '',
      prompt: text,
      cwd: resolvedCwd,
      roomId: roomId ?? null,
      provider: resolvedProvider ?? null,
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
      provider: resolvedProvider ?? null,
      attach,
      message: `已创建会话 ${sessionId} 并开始执行任务${roomNote}${providerNote}${attachNote}`,
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
      // ⚠️ 曾不传 agentOptions——resume 恢复的 agent.options 是**空对象**，
      // 回合组装时 {{model}}/{{provider}} 变量无值，报"prompt variable
      // {{model}} has no value for this assembly (deployment:persona)"，
      // 被唤醒会话本轮直接失败。修复：先 inspect 会话 log，读它**自己
      // 最后使用**的模型配置（request/header 事件，含 webUI 改过的），
      // 作为 agentOptions 传给 resume——既尊重"用会话自身配置"的设计
      // 决策，又保证 {{model}} 有值。
      let agentOptions
      try {
        const insp = this.sessionPersistence ? await this.sessionPersistence.inspect(sid) : null
        const headers = insp?.events?.filter((e) => e?.type === 'request/header') ?? []
        const cfg = headers[headers.length - 1]?.data?.header?.config
        if (cfg && cfg.provider && cfg.model) {
          agentOptions = { provider: cfg.provider, model: cfg.model }
        }
      } catch { /* 读不到配置则不传（保持原行为，失败信息会提示） */ }
      // ⚠️ 不传 agentOptions 的旧注释已移除——除非读不到自身配置，
      // 否则必须传：resume 内部以持久化 header 作为请求路由，agentOptions
      // 只负责填充 {{model}}/{{provider}} 变量与兜底路由，不覆盖会话配置。
      try {
        const handle = await this.agents.resume({
          resumeSessionId: sid,
          ...(agentOptions ? { agentOptions } : {}),
        })
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
    // ⚠️ 文案诚实原则（2026-08-11 用户拍板）：followup 只保证**送达**，
    // 不保证**成功**——对方不在本进程（离线恢复失败）或模型配置缺失时
    // 回合会失败（如 {{model}} 无值）。不能说"已唤醒/它正在处理"，
    // 那会让产品经理误以为对方在干活、一直等。必须提示：等几秒后
    // status 确认对方真的 running。
    return { ok: true, sessionId: sid, message: `指令已送达会话 ${sid}（已入队）。⚠️ 送达≠成功：对方实际能否跑起来需**稍后确认**——离线恢复或模型配置缺失时回合可能失败。等几秒后 de_session status 查它是否 running；忙完前不要重复派活` }
  }

  /**
   * 查单个会话状态（live=实际状态；不在本进程 = offline）。
   * 附 lastActiveAt（该会话最后一条事件时间，判断"停了多久"）与
   * now（当前时间锚点——2026-08-12 用户要求：lastActiveAt 可能是过往
   * 事件，AI 拿 now 对比就能判断是即时还是旧消息）。
   */
  status(sessionId) {
    const sid = String(sessionId ?? '').trim()
    if (sid === '') return { ok: false, message: 'status 必填 sessionId' }
    const now = Date.now()
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
        now,
        // 名称/别名：让产品经理一眼看出"这个会话是谁"。别名走文件存储
        // （offline 也可查）；名称需 live session（sessionTitle），offline=null
        title: null,
        alias: this.aliasStore?.get(sid) ?? null,
        message: '会话不在当前进程（离线或不存在；同实例会话重启后会自动恢复）',
      }
    }
    // status 的 live 分支曾**没有 message 字段** → render 只处理 message/
    // sessions/live，输出空字符串 → 产品经理 status 查询表现为"没有返回"
    // （list 正常因有数组）。补可读文案 + render 对 status 字段兜底渲染。
    let title = null
    try {
      title = this.sessionTitle?.get?.(agent.session)?.title ?? null
    } catch { /* 标题读取失败置 null */ }
    return {
      ok: true,
      sessionId: sid,
      status: agent.status, // running=正在生成 / idle=空闲（等用户或指令）
      cwd: agent.session?.header?.cwd ?? null,
      spawned: this.store.find(sid) !== undefined,
      lastActiveAt: this.#lastActiveAt(agent),
      now,
      title,
      alias: this.aliasStore?.get(sid) ?? null,
      message: `会话 ${sid} 状态：${agent.status}（${agent.status === 'running' ? '正在生成' : '空闲，等指令'}）`,
    }
  }

  /**
   * 列出会话：live 会话（含 GUI 手动开的，running/idle）+ 本模块 spawn
   * 过的记录（含状态/角色提示词/所属房间）。附 lastActiveAt。
   * 每个会话都带 **title（会话名称）与 alias（别名）**（2026-08-09 用户
   * 反馈：list 曾只有 ID，产品经理认不出"这个会话是谁"）：
   *   - title：live 会话从 sessionTitle 服务实时取（offline 会话标题在
   *     日志里，实时拿不到 → null，与 status 动作同语义）；
   *   - alias：aliases.json 全局存储，offline 也能查。
   * @returns {{ok:boolean, sessions?:Array, live?:Array}}
   */
  list() {
    const live = this.agents.list().map((agent) => {
      let title = null
      try {
        title = this.sessionTitle?.get?.(agent.session)?.title ?? null
      } catch { /* 标题读取失败置 null */ }
      return {
        sessionId: agent.id,
        status: agent.status,
        cwd: agent.session?.header?.cwd ?? null,
        spawned: this.store.find(agent.id) !== undefined,
        lastActiveAt: this.#lastActiveAt(agent),
        title,
        alias: this.aliasStore?.get?.(agent.id) ?? null,
      }
    })
    const sessions = this.store.list().map((rec) => {
      const liveRec = live.find((l) => l.sessionId === rec.sessionId)
      // 显式补全字段（旧记录可能缺 provider 等新字段——补 null 防 schema 校验失败）
      return {
        sessionId: rec.sessionId,
        spawnedBy: rec.spawnedBy,
        prompt: rec.prompt,
        cwd: rec.cwd ?? null,
        provider: rec.provider ?? null,
        model: rec.model ?? null,
        roomId: rec.roomId ?? null,
        createdAt: rec.createdAt,
        status: liveRec?.status ?? 'offline',
        lastActiveAt: liveRec?.lastActiveAt ?? null,
        // 标题：live 复用实时值，offline 拿不到 → null（与 status 同语义）；
        // 别名：全局存储，offline 也可查。
        title: liveRec?.title ?? null,
        alias: this.aliasStore?.get?.(rec.sessionId) ?? null,
      }
    })
    return { ok: true, sessions, live, now: Date.now() }
  }

  /**
   * 按名称/别名/ID 关键字查会话（2026-08-12 用户需求：微信/QQ 等无 GUI
   * 渠道无法主动知道会话 ID——说名字让 AI 查，一步到位）。
   * 匹配规则：query 对 sessionId / 名称（title，live 会话才有）/ 别名
   * （alias，文件存储 offline 也可查）做**子串匹配**（大小写不敏感；
   * 中文按子串）。数据源：live 会话（agents.list）+ 本模块 spawn 记录
   * （store.list，offline 会话：名称拿不到只按别名/ID 匹配——文档说明）。
   * @param {{query:string, limit?:number}} input
   * @returns {{ok:boolean, query?:string, count?:number, matches?:Array, message?:string}}
   */
  find({ query, limit } = {}) {
    const q = String(query ?? '').trim()
    if (q === '') return { ok: false, message: 'find 必填 query（要查找的名称/别名/ID 关键字）' }
    // 上限防御（默认 20，最大 50）
    const limitN = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 20
    const ql = q.toLowerCase()
    /** 任一字段包含关键字即命中（null/undefined 跳过）。 */
    const hit = (...fields) => fields.some((f) => f !== null && f !== undefined && String(f).toLowerCase().includes(ql))
    const matches = []
    const seen = new Set()
    const push = (m) => {
      matches.push(m)
      seen.add(m.sessionId)
    }
    // ① live 会话：名称/别名/ID 都可匹配（名称需 sessionTitle 服务）
    for (const agent of this.agents.list()) {
      if (matches.length >= limitN) break
      const sid = agent.id
      let title = null
      try {
        title = this.sessionTitle?.get?.(agent.session)?.title ?? null
      } catch { /* 标题读取失败置 null */ }
      const alias = this.aliasStore?.get?.(sid) ?? null
      if (!hit(sid, title, alias)) continue
      push({
        sessionId: sid,
        status: agent.status,
        title,
        alias,
        cwd: agent.session?.header?.cwd ?? null,
        spawned: this.store.find(sid) !== undefined,
        lastActiveAt: this.#lastActiveAt(agent),
      })
    }
    // ② spawn 记录（含 offline）：名称 live 才拿得到（这里补 live 已覆盖
    // 的不重复；offline 只按别名/ID 匹配——查 offline 名称可先 status/wake）
    if (matches.length < limitN) {
      for (const rec of this.store.list()) {
        if (matches.length >= limitN || seen.has(rec.sessionId)) continue
        const alias = this.aliasStore?.get?.(rec.sessionId) ?? null
        if (!hit(rec.sessionId, alias)) continue
        matches.push({
          sessionId: rec.sessionId,
          status: 'offline',
          title: null,
          alias,
          cwd: rec.cwd ?? null,
          spawned: true,
          lastActiveAt: null,
        })
      }
    }
    const summary = matches.length > 0
      ? `找到 ${matches.length} 个匹配「${q}」的会话`
      : `未找到匹配「${q}」的会话（可换名称/别名/ID 关键词，或用 list 看全部）`
    return {
      ok: true,
      query: q,
      count: matches.length,
      matches,
      message: summary,
    }
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
    description: '会话编排（独立模块，开关见记忆 Tab 运行时配置「会话编排」）：程序化创建/唤醒/标记 DSH 会话——spawn：**新建一个标准会话**（与 GUI 手动打开完全同构：同样的系统提示词/工具/记忆快照/持久化，会出现在左侧会话列表可随时接管；**自动挂到工作目录对应的工作区分组**（挂接失败会自动重试，结果见返回的 attach 字段；失败不阻断创建但要在汇报里说明）），prompt=**完整提示词（自由组合的长文本：角色/任务/要求一次写清，如"你是美工，负责网站视觉…现在开始执行任务：…"）**，创建后立即自动开跑（等价替用户发消息）；**默认继承发起会话的 provider/model 与 cwd 工作目录**；可选 roomId（加入广播房间，需广播模块启用；房间不存在/未启用只提示不阻断）、model/cwd（显式覆盖）。⚠️ **显式传 model 时按模型名自动解析所属 provider**（与 GUI 模型选择框同源：已配置 provider 的模型目录，如 qwen3.7-plus → qwen-token-plan-cn）——曾只换 model 不换 provider，把 qwen3.7-plus 发给 deepseek 接口报 INVALID_REQUEST；解析不到时 provider 沿用发起会话并在返回里提示风险。也可显式传 provider 强制指定路由（如 deepseek-official、qwen-token-plan-cn）。wake：**唤醒已有会话**——sessionId + prompt（要对方做的事），等价替用户给对方发一条消息，对方 AI 自动醒来处理（正在忙则排队；忙完前不要重复派活）；进程重启后的会话自动从持久化恢复再唤醒，**用会话自己的模型配置**；跨实例会话无法唤醒会明确报错。**⚠️ wake 只保证送达不保证成功**：返回"指令已送达"只代表已入队，不代表对方真的跑起来了——离线恢复失败/模型配置缺失时对方回合会失败（如 {{model}} 无值报错）。**派发后等几秒再用 status 确认对方 running**，不要看了返回就假定对方在干活。status：查单个会话（sessionId）状态——running=正在生成 / idle=空闲 / offline=不在本进程，附 lastActiveAt（最后活动时间）与 now（当前时间锚点，可对比判断新旧）。list：列出全部 live 会话（含 GUI 手动开的）与本模块创建过的会话（**每个会话都带名称 title 与别名 alias**，一眼认出"这是谁"；附角色提示词/任务/所属房间/状态/lastActiveAt——offline 会话 title=null，别名不受限）。find：**按名称/别名/ID 关键字查会话**（query 必填，子串匹配、大小写不敏感）——微信/QQ 等无 GUI 渠道"说名字查 ID"一步到位：如 find query="美工" → 返回匹配会话的 sessionId/状态/名称/别名/最后活动，拿到 ID 后即可 wake/status；live 会话按名称/别名/ID 匹配，offline 会话只按别名/ID 匹配（名称需 live）；可选 limit（默认 20 上限 50）。rename：**修改会话名称与/或别名做标记**——sessionId + title（新名称，左侧列表标题，需会话 live）+ alias（新别名 ≤10 字，广播/快照显示，空串=清除），两者至少给一个，可同时改。me：**查当前会话自身信息**（"我是谁"）——session ID / 会话名称 / 别名 / 所属项目分组 / cwd / git 分支（非 git 目录为 null）/ provider+model / 创建时间 / 父会话 / 创建者（spawn 记录）/ 状态，AI 确认自己身份或把 ID/别名告知他人协作时用它（快照「你的会话」段是常驻参考，工具查询更即时准确）。**员工编排纪律（重要）：本工具不会自动唤醒任何会话——必须由你（拍板人）有意识地 list/status 查状态、发现员工 idle/offline 后用 wake 主动唤醒，不要自作主张批量唤醒（会造成管理混乱）。**',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['spawn', 'wake', 'status', 'list', 'find', 'rename', 'me'], description: 'spawn=新建会话；wake=唤醒已有会话；status=查单个会话状态；list=列出会话；find=按名称/别名/ID 关键字查会话；rename=改会话名称/别名；me=查当前会话自身信息（ID/名称/别名/cwd/模型）' },
        prompt: { type: 'string', description: 'spawn：新会话的完整提示词（长文本自由组合）；wake：要对方做的事' },
        sessionId: { type: 'string', description: 'wake/status 必填：目标会话 ID（用户告知或 list/find 查得，形如 session-xxxx）' },
        query: { type: 'string', description: 'find 必填：要查找的会话名称/别名/ID 关键字（子串匹配，大小写不敏感）' },
        limit: { type: 'integer', description: 'find 可选：最多返回条数（默认 20，上限 50）' },
        cwd: { type: 'string', description: 'spawn 可选：新会话工作目录（绝对路径；缺省=继承发起会话的工作目录，保证同一项目内协作）' },
        roomId: { type: 'string', description: 'spawn 可选：加入的广播房间 id（形如 room-xxx；需广播模块启用）' },
        model: { type: 'string', description: 'spawn 可选：覆盖模型（缺省=继承发起会话的模型）。⚠️ 显式传时自动按模型名解析所属 provider（与 GUI 模型选择框同源：已配置 provider 的模型目录，如 qwen3.7-plus → qwen-token-plan-cn；解析不到沿用发起会话 provider 并在返回里提示风险）' },
        provider: { type: 'string', description: 'spawn 可选：显式指定供应商路由 id（如 deepseek-official、qwen-token-plan-cn；缺省=按 model 自动解析，解析不到用发起会话的 provider）' },
        title: { type: 'string', description: 'rename 可选：新会话名称（左侧会话列表标题；需会话在本进程 live，可先 wake 恢复再改）' },
        alias: { type: 'string', description: 'rename 可选：新会话别名（≤10 字，广播/快照显示；传空串=清除别名）' },
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
          now: { type: 'integer', description: 'status/list 结果：当前时间戳（时间锚点——拿它对比 lastActiveAt 判断是即时还是过往）' },
          provider: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'spawn 结果：新会话实际使用的 provider（显式参数/按模型解析/继承发起会话，三选一）' },
          attach: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ok: { type: 'boolean', description: '是否成功挂接工作区（左侧"项目"分组）' },
                  workspaceId: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '挂接的工作区 id' },
                  workspaceTitle: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '挂接的工作区名' },
                  error: { type: 'string', description: '失败原因（ok=false 时）' },
                  attempts: { type: 'integer', description: '实际尝试次数（含重试；skipped 时为 1）' },
                  skipped: { type: 'boolean', description: 'true=cwd 目录不存在（确定性失败，未重试；如工作区被删除/磁盘未挂载）' },
                },
                required: ['ok'],
              },
              { type: 'null' },
            ],
            description: 'spawn 结果：挂接工作区结果（cwd 为空=null；失败已自动重试，不阻断 spawn）',
          },
          status: { type: 'string', description: 'running=正在生成 / idle=空闲 / offline=不在本进程' },
          cwd: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          spawned: { type: 'boolean', description: '该会话是否由本模块创建' },
          lastActiveAt: { oneOf: [{ type: 'integer' }, { type: 'null' }], description: '最后活动时间（最后一条事件的时间戳）' },
          title: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'rename 结果：新会话名称；me 结果：当前会话名称' },
          alias: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'rename 结果：新会话别名（空串=已清除）；me 结果：当前会话别名' },
          provider: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'me 结果：当前会话 provider' },
          model: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'me 结果：当前会话 model' },
          workspaceId: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'me 结果：所属项目分组 id（左侧"项目"分组；未挂任何分组=null）' },
          workspaceTitle: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'me 结果：所属项目分组名' },
          gitBranch: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'me 结果：当前 git 分支（非 git 目录=null）' },
          createdAt: { oneOf: [{ type: 'integer' }, { type: 'null' }], description: 'me 结果：会话创建时间戳' },
          parentSession: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'me 结果：父会话 ID（派生/ fork 来源，无=null）' },
          spawnedBy: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'me 结果：创建者会话 ID（de_session spawn 记录的发起人，非 spawn 创建=null）' },
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
                provider: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '创建时实际使用的 provider' },
                model: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                createdAt: { type: 'integer' },
                spawned: { type: 'boolean' },
                lastActiveAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                title: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '会话名称（live 实时取；offline=null）' },
                alias: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '会话别名（aliases.json，offline 也可查）' },
              },
              required: ['sessionId', 'status', 'cwd', 'spawnedBy', 'prompt', 'roomId', 'provider', 'model', 'createdAt', 'lastActiveAt', 'title', 'alias'],
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
                title: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '会话名称（sessionTitle 实时取）' },
                alias: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '会话别名（aliases.json）' },
              },
              required: ['sessionId', 'status', 'cwd', 'spawned', 'lastActiveAt', 'title', 'alias'],
            },
          },
          query: { type: 'string', description: 'find 结果：本次查询关键字' },
          count: { type: 'integer', description: 'find 结果：匹配条数' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                status: { type: 'string', description: 'running=正在生成 / idle=空闲 / offline=不在本进程' },
                title: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '会话名称（仅 live 可读；offline=null）' },
                alias: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '会话别名（文件存储，offline 也可查）' },
                cwd: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                spawned: { type: 'boolean', description: '是否由本模块创建' },
                lastActiveAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              },
              required: ['sessionId', 'status', 'title', 'alias', 'cwd', 'spawned', 'lastActiveAt'],
            },
            description: 'find 结果：匹配的会话列表',
          },
        },
        required: ['ok'],
      },
      // render：把结构化结果渲染成模型可读文本（DSH 要求 output 必须声明
      // { schema, render, presentationMeta? }——曾只写 schema 导致工具注册
      // 失败 "must declare output { schema, render, presentationMeta? }"）
      render: (_args, value) => {
        const parts = []
        // ⏰ 当前时间锚点（2026-08-12 用户要求）：status/list 的 lastActiveAt
        // 是**事件时间**（可能是过往——如进程重启前的最后活动），锚点
        // 精确到秒，模型一眼对比就知道"这是刚发生的还是旧消息"。与
        // de_broadcast 输出前置时间锚点同格式同原则；工具输出在调用时刻
        // 生成=模型看到时刻，安全（快照段不可用此做法——见 key 记忆）。
        if (typeof value.now === 'number') {
          parts.push(`⏰ 当前时间：${fmtDateTime(value.now)}`)
        }
        if (value.message) parts.push(value.message)
        // status 查询结果兜底：即使没有 message 也渲染可读状态行
        // （曾因 live 分支无 message 输出空字符串 → 表现为"没有返回"）
        if (value.sessionId !== undefined && value.status !== undefined && !Array.isArray(value.sessions) && !Array.isArray(value.live)) {
          const mark = value.status === 'running' ? '🟢' : value.status === 'idle' ? '⚪' : '⚫'
          const when = value.lastActiveAt !== null && value.lastActiveAt !== undefined
            ? new Date(value.lastActiveAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
            : '—'
          // 名称/别名让产品经理一眼认出"这个会话是谁"
          const nameBits = [
            value.title ? `名称「${value.title}」` : null,
            value.alias ? `别名「${value.alias}」` : null,
          ].filter(Boolean).join(' ')
          parts.push(`${mark} ${value.sessionId} ${value.status}${nameBits ? ` ${nameBits}` : ''}${value.spawned ? '（本模块创建）' : ''} · 最后活动 ${when}${value.cwd ? ` · cwd ${value.cwd}` : ''}`)
        }
        if (Array.isArray(value.sessions)) {
          const lines = value.sessions.map((s) => {
            const mark = s.status === 'running' ? '🟢' : s.status === 'idle' ? '⚪' : '⚫'
            const when = s.lastActiveAt !== null && s.lastActiveAt !== undefined
              ? new Date(s.lastActiveAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
              : '—'
            const promptHead = String(s.prompt ?? '').replaceAll('\n', ' ').slice(0, 60)
            const route = s.provider ? ` · ${s.provider}` : ''
            // 名称/别名（2026-08-09 用户反馈：list 曾只有 ID 认不出"这是谁"）
            const nameBits = [
              s.title ? `名称「${s.title}」` : null,
              s.alias ? `别名「${s.alias}」` : null,
            ].filter(Boolean).join(' ')
            return `${mark} ${s.sessionId} ${s.status}${route}${nameBits ? ` ${nameBits}` : ''}${s.spawnedBy ? ` · 创建者 ${s.spawnedBy}` : ''} · 最后活动 ${when}\n    ${promptHead}`
          })
          parts.push(`spawn 记录（${lines.length}）：\n${lines.join('\n')}`)
        }
        if (Array.isArray(value.live)) {
          const lines = value.live.map((l) => {
            const mark = l.status === 'running' ? '🟢' : '⚪'
            const when = l.lastActiveAt !== null && l.lastActiveAt !== undefined
              ? new Date(l.lastActiveAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })
              : '—'
            // 名称/别名：产品经理/拍板人一眼认出"这个会话是谁"
            const nameBits = [
              l.title ? `名称「${l.title}」` : null,
              l.alias ? `别名「${l.alias}」` : null,
            ].filter(Boolean).join(' ')
            return `${mark} ${l.sessionId} ${l.status}${nameBits ? ` ${nameBits}` : ''}${l.spawned ? '（本模块创建）' : ''} · 最后活动 ${when}`
          })
          parts.push(`live 会话（${lines.length}）：\n${lines.join('\n')}`)
        }
        if (Array.isArray(value.matches)) {
          // find 结果：匹配列表（无匹配给提示，让模型引导换关键词）
          if (value.matches.length === 0) {
            parts.push(`未找到匹配「${value.query ?? ''}」的会话（可换名称/别名/ID 关键词，或用 list 看全部）`)
          } else {
            const lines = value.matches.map((m) => {
              const mark = m.status === 'running' ? '🟢' : m.status === 'idle' ? '⚪' : '⚫'
              const when = m.lastActiveAt !== null && m.lastActiveAt !== undefined
                ? new Date(m.lastActiveAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                : '—'
              const nameBits = [
                m.title ? `名称「${m.title}」` : null,
                m.alias ? `别名「${m.alias}」` : null,
              ].filter(Boolean).join(' ')
              return `${mark} ${m.sessionId} ${m.status}${nameBits ? ` ${nameBits}` : ''}${m.spawned ? '（本模块创建）' : ''} · 最后活动 ${when}${m.cwd ? ` · cwd ${m.cwd}` : ''}`
            })
            parts.push(`匹配「${value.query}」的会话（${value.matches.length}）：\n${lines.join('\n')}`)
          }
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
            // （新会话无历史配置必须显式给，否则 {{model}} 无值回合失败）；
            // 显式 model 时按模型名解析 provider（GUI 选择框同源）
            return await orch.spawn({ prompt: args.prompt, cwd: args.cwd, roomId: args.roomId, model: args.model, provider: args.provider, by, requester: ctx?.agent })
          case 'wake':
            return await orch.wake({ sessionId: args.sessionId, prompt: args.prompt })
          case 'status':
            return orch.status(args.sessionId)
          case 'list':
            return orch.list()
          case 'find':
            // 按名称/别名/ID 关键字查会话（微信/QQ 等无 GUI 渠道"说名字
            // 查 ID"一步到位——拿到 sessionId 后可 wake/status 干预）
            return orch.find({ query: args.query, limit: args.limit })
          case 'rename':
            return await orch.rename({ sessionId: args.sessionId, title: args.title, alias: args.alias })
          case 'me':
            // 当前会话自身信息（"我是谁"：ID/名称/别名/cwd/模型/状态）
            return orch.me(ctx?.agent)
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
    // agents/workspace/sessionTitle 已声明式注入，直接可用（同 tools）
    const instance = new SessionOrch(ctx, {
      store,
      getBroadcastStore: deps?.getBroadcastStore,
      aliasStore: deps?.aliasStore, // 共享别名存储（rename 改别名用）
    })
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
