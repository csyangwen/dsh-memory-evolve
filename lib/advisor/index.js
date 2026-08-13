/**
 * Advisor 模块装配（实施规划 §三 index.js）。
 *
 * installAdvisor(ctx, config, deps) 安装完整的评审能力：
 *
 * - **single-reviewer claim**（双审 B5/MAJOR-5）：进程级 globalThis 标志，
 *   配置解析成功后领取，fiber dispose 释放；非 owner fiber 不装
 *   observer/runtime/delivery/命令/API（多 fiber 组合时防重复评审）；
 * - **resolveAdvisorRoute**（双审 B2）：唯一模型解析算法——双配置→
 *   configured；双空→继承 agent.options（会话模型）；只配一个→
 *   config-incomplete 禁用；继承失败→session-model-unavailable 禁用；
 * - 事件接线（全 {global:true}）：session/event → observer；
 *   agent/created|disposed、session/disposed → 生命周期对称清理；
 * - per-session 运行时管理：ensureRuntime（门禁后创建）/ disposeRuntime
 *   （先删 map 再 abort，generation 防迟到回调）/ 签名对比热更新；
 * - /advisor 命令（on/off/status/tell，ctx.inject(['commands']) 条件注册）；
 * - HTTP API（installAdvisorApi，ctx.inject(['webServer']) 条件注册）；
 * - 幂等 dispose：统一清理 runtime/监听/命令/API/claim。
 *
 * 数据目录：<memoryDir>/advisor/{records.jsonl, instructions/<sid>.json}。
 *
 * @module dsh-memory-evolve/advisor/index
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AdvisorRuntime } from './runtime.js'
import { AdvisorConversation } from './conversation.js'
import { ScopeStore } from './scopes.js'
import { buildAdvisorSystemPrompt } from './prompt.js'
import { ADVISOR_ROLE_PREFIX, DEFAULT_ADVISOR_SYSTEM_PROMPT } from './prompt.js'
import { SessionTranscriptObserver } from './observer.js'
import { AdvisorDelivery } from './delivery.js'
import { InstructionQueue } from './instructions.js'
import { ReviewStore } from './store.js'
import { installAdvisorApi } from './api.js'

/** 进程级 single-reviewer claim 键（多 fiber 防重）。 */
const REVIEWER_KEY = '__dshMemoryEvolveAdvisorReviewer__'
/** 参考实现 dsh-advisor 的 claim 键（并存检测，MAJOR-12）。 */
const DSHA_ADVISOR_REVIEWER_KEY = '__dshAdvisorReviewer__'

/**
 * 领取 single-reviewer 角色（B14 修订）：claim 保存 owner token，
 * 释放时 compare-and-delete——A dispose 后 B 接管，A 再 dispose 不会误清
 * B 的 claim（旧实现全局 boolean 会误清）。
 */
function claimReviewer() {
  const g = globalThis
  const existing = g[REVIEWER_KEY]
  if (existing !== undefined) return { ok: false, token: null }
  const token = crypto.randomUUID()
  g[REVIEWER_KEY] = token
  return { ok: true, token }
}

function releaseReviewer(token) {
  if (token !== null && globalThis[REVIEWER_KEY] === token) {
    delete globalThis[REVIEWER_KEY]
  }
}

/**
 * 唯一模型解析算法（双审 B2 修订）。
 *
 * @param {string} sessionId - 会话 id（继承路径需要）
 * @param {object} config - 合并后的插件配置（含 advisorProvider/advisorModel）
 * @param {(sessionId: string) => object | undefined} getAgent - ctx.agents.get
 * @returns {{ gate: 'ok', provider: string, model: string, routeSource: 'configured'|'session' } |
 *           { gate: 'config-incomplete'|'session-model-unavailable', reason: string, routeSource: null }}
 */
export function resolveAdvisorRoute(sessionId, config, getAgent) {
  const provider = typeof config.advisorProvider === 'string' && config.advisorProvider.trim() !== '' ? config.advisorProvider.trim() : null
  const model = typeof config.advisorModel === 'string' && config.advisorModel.trim() !== '' ? config.advisorModel.trim() : null
  if (provider !== null && model !== null) {
    return { gate: 'ok', provider, model, routeSource: 'configured' }
  }
  if (provider !== null || model !== null) {
    return {
      gate: 'config-incomplete',
      reason: 'advisorProvider 与 advisorModel 必须同时配置（当前只配置了其中一个）',
      routeSource: null,
    }
  }
  // 双空 → 继承会话模型（agent.options 为请求所用模型）
  const agent = getAgent?.(sessionId)
  const inheritedProvider = agent?.options?.provider
  const inheritedModel = agent?.options?.model
  if (typeof inheritedProvider === 'string' && inheritedProvider !== '' && typeof inheritedModel === 'string' && inheritedModel !== '') {
    return { gate: 'ok', provider: inheritedProvider, model: inheritedModel, routeSource: 'session' }
  }
  return {
    gate: 'session-model-unavailable',
    reason: '未配置评审模型且无法解析当前会话模型（agent.options 缺失）',
    routeSource: null,
  }
}

/** 会话 id 安全化为文件名（防路径穿越）。 */
function safeId(sessionId) {
  return String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** 原子写（temp+rename，temp 名含递增 nonce 防串写；temp 放目标文件同目录）。 */
function atomicWriteFactory() {
  let nonce = 0
  return (path, data) => {
    nonce += 1
    const tmp = join(dirname(path), `.tmp-${process.pid}-${nonce}`)
    writeFileSync(tmp, data)
    renameSync(tmp, path)
  }
}

/**
 * 评审员会话持久化读写（2026-08-12 用户拍板：重启恢复，仅 reset 清空）。
 * 文件结构 { epoch, messages, scopeText? }——scopeText 是评审会话约束
 * （四层级第 4 层），conversation 每次写入时保留它（reset 时自然清除）。
 */
const conversationNonce = { n: 0 }
const conversationFileOf = (dataDir, sessionId) => join(dataDir, 'conversations', `${safeId(sessionId)}.json`)
const readConversation = (dataDir, sessionId) => {
  try {
    const text = readFileSync(conversationFileOf(dataDir, sessionId), 'utf8')
    return text === '' ? null : JSON.parse(text)
  } catch {
    return null // 不存在/损坏：按空会话
  }
}
const writeConversation = (dataDir, sessionId, epoch, messages, scopeText = '') => {
  conversationNonce.n += 1
  const file = conversationFileOf(dataDir, sessionId)
  const tmp = join(dirname(file), `.tmp-${process.pid}-${conversationNonce.n}`)
  writeFileSync(tmp, JSON.stringify({ epoch, messages, ...(scopeText !== '' ? { scopeText } : {}) }))
  renameSync(tmp, file)
}

/**
 * 安装 advisor 模块。
 *
 * @param {object} ctx - 插件上下文（agents/llm/settings 顶层注入；commands/httpServer 动态注入）
 * @param {object} config - 合并后配置（resolveConfig 输出）
 * @param {object} [deps]
 * @param {string} deps.dataDir - 数据目录（<memoryDir>/advisor）
 * @param {(sessionId: string) => string | null | undefined} [deps.sessionName] - 会话名提供者
 * @param {object} [deps.logger]
 * @returns {{ dispose: () => void, ctrl: object }}
 */
export function installAdvisor(ctx, config, deps = {}) {
  const logger = deps.logger ?? ctx.logger?.('advisor') ?? console
  // MAJOR-12：与参考实现 dsh-advisor 并存检测（同挂全局评审角色会双评审双 steer）
  if (globalThis[DSHA_ADVISOR_REVIEWER_KEY] !== undefined) {
    logger.warn?.('advisor: 检测到 dsh-advisor 插件也在运行——两者会重复评审/投递，建议停用一个')
  }
  const dataDir = deps.dataDir
  mkdirSync(join(dataDir, 'instructions'), { recursive: true })
  // Q3 持久化（2026-08-12 用户拍板）：评审员会话落盘，重启恢复
  mkdirSync(join(dataDir, 'conversations'), { recursive: true })
  // 四层级约束（2026-08-12 用户拍板）：项目/会话/评审会话约束存储
  mkdirSync(join(dataDir, 'session-scopes'), { recursive: true })
  const disposers = []

  // ---- 约束存储（ScopeStore：项目按 cwd、会话按 sessionId、评审会话随 conversation 文件）----
  const atomicWrite = atomicWriteFactory()
  const scopes = new ScopeStore({
    // 路径约定：ScopeStore 内部用相对 dataDir 路径，这里统一拼前缀
    // ⚠️ 必须透传 data（曾漏传导致 writeFileSync(tmp, undefined)）
    writeFile: (rel, data) => atomicWrite(join(dataDir, rel), data),
    readFile: (rel) => {
      try {
        return readFileSync(join(dataDir, rel), 'utf8')
      } catch {
        return ''
      }
    },
    conversationFileOf: (sessionId) => `conversations/${safeId(sessionId)}.json`,
    writeConversation: (rel, data) => atomicWrite(join(dataDir, rel), data),
  })

  // ---- 存储与指令 ----
  const store = new ReviewStore({
    recordsFile: join(dataDir, 'records.jsonl'),
    appendFile: (path, data) => appendFile(path, data),
    onStorageError: (event) => {
      // MAJOR-2：存储失败转 runtime-status（前端 live union 只认识三类
      // 事件）；带 reviewId 的失败归属到对应会话
      store.emit({
        type: 'runtime-status',
        ts: event.ts ?? Date.now(),
        sessionId: event.sessionId ?? undefined,
        runtimeStatus: 'idle',
        phase: 'storage-error',
        // 复审中7：契约固定字段必须齐全（前端直接写入状态）
        pendingCount: 0,
        error: { code: event.code, message: event.message },
      })
    },
  })
  const instructions = new InstructionQueue({
    writeFile: atomicWriteFactory(dataDir),
    fileFor: (sessionId) => join(dataDir, 'instructions', `${safeId(sessionId)}.json`),
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return ''
      }
    },
  })

  // ---- 会话级 override（/advisor、面板 toggle）----
  const overrides = new Map() // sessionId → boolean
  // 2026-08-13 用户反馈：会话级开关必须跨刷新/重启保留。此前 override 是
  // 纯内存 Map，页面刷新会触发 agent 重建，agent/disposed 里 delete 掉
  // override 后，「总开关开、会话关」的状态丢失，刷新后本会话评审自动
  // 开启。现持久化到 <dataDir>/session-overrides.json：安装时加载、
  // setSessionOverride 时原子落盘；disposed 事件不再删除（agent 重建后
  // 由本 Map 直接恢复）。
  const overridesFile = join(dataDir, 'session-overrides.json')
  try {
    const raw = readFileSync(overridesFile, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [sessionId, value] of Object.entries(parsed)) {
        if (typeof value === 'boolean') overrides.set(sessionId, value)
      }
    }
  } catch {
    // 首次运行或文件损坏：从空 Map 开始，不阻断模块安装
  }
  const persistOverrides = () => {
    try {
      atomicWrite(overridesFile, JSON.stringify(Object.fromEntries(overrides)))
    } catch (error) {
      logger.warn?.('advisor: persist session overrides failed', { error })
    }
  }
  // B3：effectiveEnabled 只表达"开关结果"；模型可运行性由 gateStatus
  // 单独表达（配置不完整时开关仍可翻转）。
  // 2026-08-13 用户拍板（三轮迭代定稿）：
  // 1. 全局 advisorEnabled 是模块**总闸**——全局关闭时一律 false，整体停评；
  // 2. 全局开启后**每个会话默认关闭（opt-in）**——评审消耗模型调用，
  //    必须用户在悬浮面板里为本会话手动开启（override=true）才评审；
  // 3. 会话级 override 持久化（session-overrides.json），刷新/重启后
  //    保持用户选择（手动开过的会话保持开、关过的保持关）。
  const effectiveEnabled = (sessionId) => (
    config.advisorEnabled === true && overrides.get(sessionId) === true
  )

  // ---- single-reviewer claim（配置解析成功后领取；token 释放防误清）----
  const claim = claimReviewer()
  if (!claim.ok) {
    logger.debug('advisor: non-reviewer instance — observer/runtime/commands/API skipped')
    return { dispose: () => {}, ctrl: null }
  }
  disposers.push(() => releaseReviewer(claim.token))

  // ---- 会话元数据 ----
  const getAgent = (sessionId) => ctx.get('agents')?.get?.(sessionId)
  const sessionNameOf = deps.sessionName ?? (() => null)
  const resolveCwd = (sessionId) => getAgent(sessionId)?.session?.header?.cwd ?? null
  const sessionMeta = (sessionId) => ({
    sessionId,
    sessionName: sessionNameOf(sessionId) ?? null,
    workspace: resolveCwd(sessionId),
  })

  // ---- 投递（MAJOR-6：immuneTurns/steerSeverities 配置接入；Q1：infoInject）----
  const delivery = new AdvisorDelivery({
    lookupAgent: (sessionId) => getAgent(sessionId),
    immuneTurns: config.advisorImmuneTurns ?? 0,
    steerSeverities: config.advisorSteerSeverities ?? ['nit', 'concern', 'blocker'],
    infoInject: config.advisorInfoInject === true,
    logger,
  })

  // ---- 观察器 ----
  const getSession = (sessionId) => getAgent(sessionId)?.session
  const observer = new SessionTranscriptObserver({
    maxMessages: config.advisorMaxMessages,
    getSession,
    sessionMeta,
    onDelta: (sessionId, delta, meta) => {
      // ⚠️ 防抛防御：onDelta 回调抛错会被 session/event containment 静默
      // 吞掉（评审静默失败）——任何内部错误只丢本轮 delta，绝不外抛
      try {
        ensureRuntime(sessionId)?.enqueue(delta, meta)
      } catch (error) {
        logger.warn('advisor: onDelta failed — delta dropped', { sessionId, error })
      }
    },
    onSteppedTurnEnd: (sessionId) => {
      // MAJOR-6：steer 冷却递减（immuneTurns >0 时生效；0=不限制）
      delivery.onSteppedTurnEnd(sessionId)
    },
    onRewrite: (sessionId) => {
      runtimes.get(sessionId)?.resetGuard()
      delivery.reset(sessionId)
    },
    logger,
  })

  // ---- 运行时管理 ----
  const runtimes = new Map()
  const runtimeSignatures = new Map()
  const effectiveRoute = (sessionId) => resolveAdvisorRoute(sessionId, config, getAgent)
  const runtimeSignature = (sessionId) => {
    const route = effectiveRoute(sessionId)
    if (route.gate !== 'ok') return `gate:${route.gate}`
    // B8：队列/超时/冷却/severity/投递配置变化也要触发重建或原地更新
    return [route.provider, route.model, config.advisorSystemPrompt, config.advisorMaxQueued, config.advisorCallTimeoutMs, config.advisorImmuneTurns, JSON.stringify(config.advisorSteerSeverities), config.advisorInfoInject].join('\u0000')
  }
  const llm = (() => {
    // NO_ADAPTER 教训：llm 适配器注册在应用根；隔离作用域的 ctx.llm 可能缺适配器
    const root = ctx.get?.('root') ?? ctx.root
    return root?.get?.('llm') ?? ctx.get('llm') ?? ctx.llm
  })()
  const ensureRuntime = (sessionId) => {
    if (!effectiveEnabled(sessionId)) return undefined
    const route = effectiveRoute(sessionId)
    if (route.gate !== 'ok') return undefined // 硬门禁：绝不发起模型调用
    const existing = runtimes.get(sessionId)
    if (existing !== undefined) return existing
    const runtime = new AdvisorRuntime({
      provider: route.provider,
      model: route.model,
      systemPrompt: `${ADVISOR_ROLE_PREFIX}\n\n${config.advisorSystemPrompt || DEFAULT_ADVISOR_SYSTEM_PROMPT}`,
      // 2026-08-12 用户拍板四层级：每次评审调用动态拼接
      // [固定角色前缀 + 系统提示词] + 项目约束 + 会话约束 + 评审会话约束——
      // 约束保存后无需重建 runtime，下次评审立即生效
      systemPromptOf: () => {
        const workspace = resolveCwd(sessionId)
        return buildAdvisorSystemPrompt({
          system: `${ADVISOR_ROLE_PREFIX}\n\n${config.advisorSystemPrompt || DEFAULT_ADVISOR_SYSTEM_PROMPT}`,
          global: scopes.globalOf(logger),
          project: workspace !== null && workspace !== '' ? scopes.projectOf(workspace, logger) : '',
          session: scopes.sessionOf(sessionId, logger),
          conversation: scopes.conversationOf(sessionId, logger),
        })
      },
      // Q3 持久化：评审员会话落盘，重启恢复；仅「新建评审会话」清空
      conversation: new AdvisorConversation({
        load: () => readConversation(dataDir, sessionId),
        save: (epoch, messages, options) => {
          // 保留既有 scopeText（评审会话约束，第 4 层）；reset（clearScope）
          // 时合并旧文件会带回 scopeText——必须跳过合并
          const existing = options?.clearScope ? null : readConversation(dataDir, sessionId)
          const scopeText = existing !== null && typeof existing.scopeText === 'string' ? existing.scopeText : ''
          writeConversation(dataDir, sessionId, epoch, messages, scopeText)
        },
      }),
      llm,
      maxQueued: config.advisorMaxQueued ?? 32,
      callTimeoutMs: config.advisorCallTimeoutMs ?? 60000,
      instructions: {
        // ⚠️ 必须透传 options（问答按 id 精确 reserve 依赖第三参——曾只透传
        // (sid, reviewId) 导致问答的指令绑定失效、问题被空消费）
        reserve: (sid, reviewId, options) => instructions.reserve(sid, reviewId, options, logger),
        consume: (reviewId) => instructions.consume(reviewId, logger),
        release: (reviewId, items) => instructions.release(reviewId, items, logger),
      },
      onEvent: (event) => {
        // 事件统一走 store（seq/ring；finished 落盘由 store 先磁盘后 ring）
        store.emit({ ...event, sessionId: event.sessionId ?? sessionId }, {
          persist: event.type === 'review-finished',
        })
      },
      onNote: (note) => {
        // B7：返回投递结果（Q1 契约：'steer'|'inject'|'recorded'|false）
        // MAJOR-6：severity 不在 advisorSteerSeverities → 降级 inject（默认全量 steer）
        return delivery.route(sessionId, note, {
          steerSeverities: config.advisorSteerSeverities ?? ['nit', 'concern', 'blocker'],
        })
      },
      logger,
    })
    runtimes.set(sessionId, runtime)
    runtimeSignatures.set(sessionId, runtimeSignature(sessionId))
    return runtime
  }
  const disposeRuntime = (sessionId) => {
    const runtime = runtimes.get(sessionId)
    if (runtime === undefined) return
    runtimes.delete(sessionId)
    runtimeSignatures.delete(sessionId)
    // 先删 map 再 abort（generation 防迟到回调）
    runtime.dispose()
  }

  // ---- 事件接线（全 {global:true}：隔离作用域下也必须收到全部会话事件）----
  disposers.push(ctx.on('session/event', (session, event) => {
    observer.handleEvent(session.id, session.events, event)
  }, { global: true }))
  disposers.push(ctx.on('agent/created', ({ agent }) => {
    delivery.registerAgent(agent)
    ensureRuntime(agent.id)
  }, { global: true }))
  disposers.push(ctx.on('agent/disposed', ({ agent }) => {
    observer.disposeSession(agent.id)
    disposeRuntime(agent.id)
    delivery.unregisterAgent(agent.id)
    // 2026-08-13 用户反馈：**不删除会话级 override**——页面刷新/重连会
    // 触发 agent 重建（disposed→created），删除会让「会话关」的状态丢失、
    // 刷新后评审自动开启。override 已持久化，重建后 Map 直接保留原值。
    instructions.disposeSession(agent.id)
    scopes.disposeSession(agent.id)
  }, { global: true }))
  disposers.push(ctx.on('session/disposed', (session) => {
    observer.disposeSession(session.id)
    disposeRuntime(session.id)
    delivery.unregisterAgent(session.id)
    // 同 agent/disposed：保留 override（持久化），不因重建丢失会话级开关
    instructions.disposeSession(session.id)
    store.disposeSession(session.id)
  }, { global: true }))

  // ---- 控制器（命令/API/热更新共用）----
  const ctrl = {
    /** 会话存在性校验（API 层防孤儿状态）。 */
    sessionExists(sessionId) {
      return getSession(sessionId) !== undefined
    },

    /** live 事件查询（seq 游标）。 */
    queryEvents(sessionId, after, limit) {
      return store.queryEvents(sessionId, after, limit)
    },

    /** 终态记录查询（before 游标分页）。 */
    queryRecords(filters) {
      return store.queryRecords(filters)
    },

    /** 全局配置视图（API GET /config）。 */
    configSnapshot() {
      return {
        advisorEnabled: config.advisorEnabled === true,
        advisorProvider: typeof config.advisorProvider === 'string' && config.advisorProvider !== '' ? config.advisorProvider : null,
        advisorModel: typeof config.advisorModel === 'string' && config.advisorModel !== '' ? config.advisorModel : null,
        advisorSystemPrompt: config.advisorSystemPrompt ?? '',
        // Q5：内置默认提示词全文（前端空配置时回填显示，编辑保存即自定义）
        defaultSystemPrompt: DEFAULT_ADVISOR_SYSTEM_PROMPT,
        advisorPanelEnabled: config.advisorPanelEnabled !== false,
        advisorImmuneTurns: config.advisorImmuneTurns ?? 0,
        advisorSteerSeverities: Array.isArray(config.advisorSteerSeverities) ? config.advisorSteerSeverities : ['nit', 'concern', 'blocker'],
        // Q1：info 级默认仅记录不注入
        advisorInfoInject: config.advisorInfoInject === true,
        advisorMaxMessages: config.advisorMaxMessages ?? 60,
        advisorMaxQueued: config.advisorMaxQueued ?? 32,
        advisorCallTimeoutMs: config.advisorCallTimeoutMs ?? 60000,
      }
    },

    /**
     * 写全局配置（API PATCH /config）：本地 merge + reconfigure + 持久化
     * （deps.persistAdvisorPatch 走主配置通道 updateRuntime）。开关翻转时
     * 本实例由 reconfigure 停掉全部运行时；模块外壳在下次 sync 时卸载。
     */
    patchConfig(patch) {
      // 逐键校验（deps.validatePatch = lib/index.js 的 validateRuntimePatch；
      // 未注入时跳过——装配方负责保证校验链完整）
      if (typeof deps.validatePatch === 'function') {
        for (const [key, value] of Object.entries(patch)) deps.validatePatch(key, value)
      }
      const next = { ...config }
      for (const [key, value] of Object.entries(patch)) {
        next[key] = value
      }
      ctrl.reconfigure(next)
      deps.persistAdvisorPatch?.(patch)
      return ctrl.configSnapshot()
    },

    /** 会话级开关（/advisor、面板 toggle 同源）。 */
    setSessionOverride(sessionId, enabled) {
      // 2026-08-13 总闸语义：全局关闭时不接受会话级开启——直接返回现状
      // status（effectiveEnabled 仍 false），面板开关不会误显示为开。
      if (enabled && config.advisorEnabled !== true) {
        return ctrl.status(sessionId)
      }
      overrides.set(sessionId, enabled === true)
      // 2026-08-13 持久化：会话级开关跨刷新/重启保留（原子落盘）
      persistOverrides()
      if (enabled) {
        // 恢复路径：quota 暂停 → resume；halted → 重建
        const route = effectiveRoute(sessionId)
        const runtime = runtimes.get(sessionId)
        if (runtime !== undefined && route.gate === 'ok') {
          if (runtime.status() === 'halted') {
            disposeRuntime(sessionId)
            ensureRuntime(sessionId)
          } else {
            runtime.resume()
          }
        } else {
          ensureRuntime(sessionId)
        }
        // seedTo：中途开启不全量回放
        const session = getSession(sessionId)
        if (session !== undefined && typeof session.deriveMessages === 'function') {
          try {
            observer.seedTo(sessionId, session.deriveMessages().length)
          } catch {
            // 忽略：下轮触发自然推进
          }
        }
      } else {
        disposeRuntime(sessionId)
      }
      return ctrl.status(sessionId)
    },

    /** 会话状态快照（契约 v2 /status 字段；B3/MAJOR1 修订）。 */
    status(sessionId) {
      const route = effectiveRoute(sessionId)
      const runtime = runtimes.get(sessionId)
      const gateOk = route.gate === 'ok'
      // B3：effectiveEnabled 只表示开关（override ?? 全局），不含 gate——
      // 配置不完整时开关仍可翻转（toggle 可反向），gate 由 gateStatus 表达
      const switchOn = effectiveEnabled(sessionId)
      return {
        defaultEnabled: config.advisorEnabled === true,
        override: overrides.has(sessionId) ? overrides.get(sessionId) : null,
        effectiveEnabled: switchOn,
        // 2026-08-12 用户反馈：面板 owner 展示兜底（评审卡片未产生时也
        // 能显示会话名/工作空间，而不是"工作空间未知"）
        sessionName: sessionNameOf(sessionId) ?? null,
        workspace: resolveCwd(sessionId),
        gateStatus: gateOk ? 'ok' : route.gate,
        provider: gateOk ? route.provider : null,
        model: gateOk ? route.model : null,
        routeSource: gateOk ? route.routeSource : null,
        // MAJOR1：runtimeStatus 反映 gate 后的可运行性；phase 与 inFlight
        // 来自 runtime 实时状态（inFlight=当前是否有评审在飞，非队列长度）
        runtimeStatus: gateOk && switchOn ? (runtime?.status() ?? 'disabled') : 'disabled',
        phase: runtime?.phase?.() ?? (gateOk && switchOn ? 'idle' : 'disabled'),
        inFlight: runtime?.inFlightCount ?? 0,
        pendingCount: runtime?.pendingCount ?? 0,
        // 2026-08-12 用户反馈：评审员会话已占用上下文（消息条数+字符数）
        conversationStats: runtime?.contextStats?.() ?? null,
        panelEnabled: config.advisorPanelEnabled !== false,
        disabledReason: gateOk ? undefined : route.reason,
      }
    },

    /** 用户发指令（面板/命令同源；Q4：入队后立即触发即时问答）。 */
    tell(sessionId, text) {
      const item = instructions.add(sessionId, text, logger)
      // Q4：指令即时问答——入队后立即触发一次问答评审（不等待下个主回合），
      // 回答直接 inject 注入会话流。会话未启用/模型不可用/运行时不存在时
      // 指令保留在队列，由下次评审自然消费（不丢）。
      const runtime = runtimes.get(sessionId)
      if (runtime !== undefined && effectiveEnabled(sessionId) && effectiveRoute(sessionId).gate === 'ok') {
        try {
          // 复审高1：先 bind（防排队中的普通评审抢走刚发的问题），再入队；
          // ask 被拒（队列满等）时 unbind——指令回到普通 pending 流
          instructions.bind(sessionId, item.id, logger)
          // Q3 重构：问答输入=评审员持续会话全量历史（问题自动追加），
          // 不再需要 renderContext 上下文窗口
          const accepted = runtime.ask(sessionMeta(sessionId), item.id)
          if (!accepted) {
            instructions.unbind(sessionId, item.id, logger)
            logger.warn('advisor: question enqueue rejected (backlog full) — instruction kept pending', { sessionId })
          }
        } catch (error) {
          instructions.unbind(sessionId, item.id, logger)
          logger.warn('advisor: question enqueue failed — instruction kept pending', { sessionId, error })
        }
      }
      return { ok: true, item }
    },

    instructionsOf(sessionId) {
      return instructions.pending(sessionId)
    },

    clearInstructions(sessionId) {
      return { cleared: instructions.clearPending(sessionId, logger) }
    },

    /**
     * 新建评审会话（Q3 重构：评审员是持续对话，用户通过新建会话控制
     * 上下文长度；新会话第一条指令给评审员背景信息）。
     * 清空评审员持续会话 + 去重记忆（epoch 自增）。会话未启用/无运行时
     * 时返回 null（指令侧保持现状）。
     */
    resetConversation(sessionId) {
      const runtime = runtimes.get(sessionId)
      if (runtime === undefined) return null
      const result = runtime.resetConversation()
      if (result !== null) {
        logger.info('advisor: conversation reset', { sessionId, epoch: result.epoch })
        // 2026-08-13 用户反馈：清掉该会话 live ring——实时流只显示当前
        // 评审会话的活动；旧评审事件已落盘 records.jsonl（记录 Tab 可查）
        store.resetSessionEvents(sessionId)
      }
      return result
    },

    /** 约束读取（2026-08-12 用户拍板五层）：全局/项目/会话/评审会话。 */
    scopesOf(sessionId) {
      const workspace = resolveCwd(sessionId)
      return {
        global: { text: scopes.globalOf(logger) },
        project: {
          workspace,
          text: workspace !== null && workspace !== '' ? scopes.projectOf(workspace, logger) : '',
        },
        session: { text: scopes.sessionOf(sessionId, logger) },
        conversation: { text: scopes.conversationOf(sessionId, logger) },
      }
    },

    /**
     * 保存某层约束（level: 'project'|'session'|'conversation'；空文本=
     * 清除该层）。评审会话约束在「新建评审会话」时自动清空；项目/会话
     * 约束跨评审会话保留。
     */
    saveScope(sessionId, level, text) {
      const normalized = ScopeStore.normalize(text)
      if (level === 'global') {
        scopes.setGlobal(normalized, logger)
      } else if (level === 'project') {
        const workspace = resolveCwd(sessionId)
        if (workspace === null || workspace === '') {
          throw new Error('无法保存项目约束：当前会话无工作空间')
        }
        scopes.setProject(workspace, normalized, logger)
      } else if (level === 'session') {
        scopes.setSession(sessionId, normalized, logger)
      } else if (level === 'conversation') {
        scopes.setConversation(sessionId, normalized, logger)
      } else {
        throw new Error(`未知约束层级: ${level}`)
      }
      return ctrl.scopesOf(sessionId)
    },

    /** 配置热更新（applyRuntimePatch 调起）。 */
    reconfigure(nextConfig) {
      config = nextConfig
      observer.setMaxMessages(nextConfig.advisorMaxMessages)
      // MAJOR-6 + Q1：delivery 配置原地生效（冷却长度/severity 列表/info 注入）
      delivery.configure({
        immuneTurns: nextConfig.advisorImmuneTurns ?? 0,
        steerSeverities: nextConfig.advisorSteerSeverities ?? ['nit', 'concern', 'blocker'],
        infoInject: nextConfig.advisorInfoInject === true,
      })
      // 签名变化的运行时重建（route/prompt 变）；开关翻转时启停
      for (const sessionId of [...runtimes.keys()]) {
        if (!effectiveEnabled(sessionId)) {
          disposeRuntime(sessionId)
          continue
        }
        const route = effectiveRoute(sessionId)
        if (route.gate !== 'ok') {
          disposeRuntime(sessionId)
          continue
        }
        if (runtimeSignatures.get(sessionId) !== runtimeSignature(sessionId)) {
          disposeRuntime(sessionId)
          ensureRuntime(sessionId)
        }
      }
      // 新会话开关生效由 agent/created 触发 ensureRuntime
    },
  }

  // ---- /advisor 命令 ----
  ctx.inject(['commands'], (cmdCtx) => {
    const dispose = registerAdvisorCommands(cmdCtx.commands, ctrl, observer, getSession)
    disposers.push(dispose)
  })

  // ---- HTTP API ----
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const d = installAdvisorApi(webCtx, ctrl)
      disposers.push(d)
    }, 'dsh-memory-evolve: advisor web api')
  })

  let disposed = false
  return {
    dispose: () => {
      if (disposed) return // B14：幂等（重复 dispose 无副作用）
      disposed = true
      for (const d of [...disposers].reverse()) {
        try {
          d()
        } catch (error) {
          logger.warn?.('advisor: disposer threw', { error })
        }
      }
      for (const sessionId of [...runtimes.keys()]) disposeRuntime(sessionId)
      runtimes.clear()
    },
    ctrl,
  }
}

// ---------------------------------------------------------------------------
// /advisor 命令
// ---------------------------------------------------------------------------

/**
 * 注册 /advisor 命令（on/off/status/tell）。
 * @returns {() => void} 命令注销函数
 */
function registerAdvisorCommands(commands, ctrl, observer, getSession) {
  const parse = (rawInput) => {
    const arg = String(rawInput ?? '').trim()
    if (arg === '' || arg === 'toggle') return { kind: 'toggle' }
    if (arg === 'on') return { kind: 'on' }
    if (arg === 'off') return { kind: 'off' }
    if (arg === 'status') return { kind: 'status' }
    if (arg === 'reset') return { kind: 'reset' }
    if (arg.startsWith('tell')) return { kind: 'tell', text: arg.slice(4).trim() } // 空文本由 handler 拒绝
    return { kind: 'usage' }
  }
  const statusText = (s) => {
    const lines = []
    lines.push(`Advisor: ${s.effectiveEnabled ? 'enabled' : 'disabled'}`)
    if (s.disabledReason !== undefined) lines.push(`Reason: ${s.disabledReason}`)
    if (s.provider && s.model) lines.push(`Model: ${s.provider}/${s.model} (${s.routeSource})`)
    lines.push(`Runtime: ${s.runtimeStatus}${s.pendingCount > 0 ? ` (${s.pendingCount} pending)` : ''}`)
    return lines.join('\n')
  }
  const handler = (invocation) => {
    const sessionId = invocation.agent?.session?.id
    if (sessionId === undefined) return { kind: 'error', text: '无法识别当前会话' }
    switch (parse(invocation.rawInput).kind) {
      case 'toggle': {
        // 2026-08-13 总闸：全局关闭时 toggle 不再能悄悄打开本会话评审
        if (ctrl.configSnapshot().advisorEnabled !== true) {
          return { kind: 'error', text: 'Advisor 全局开关未开启：请先在 设置 → 配置 打开「会话评审（Advisor）」，再为会话单独开关' }
        }
        const before = ctrl.status(sessionId)
        return ctrl.setSessionOverride(sessionId, !before.effectiveEnabled).effectiveEnabled
          ? { kind: 'success', text: 'Advisor on for this session.' }
          : { kind: 'success', text: 'Advisor off for this session.' }
      }
      case 'on': {
        // 2026-08-13 总闸：全局关闭时拒绝会话级开启，给出明确的开启路径
        if (ctrl.configSnapshot().advisorEnabled !== true) {
          return { kind: 'error', text: 'Advisor 全局开关未开启：请先在 设置 → 配置 打开「会话评审（Advisor）」，再为会话单独开启' }
        }
        const before = ctrl.status(sessionId)
        if (before.effectiveEnabled && before.runtimeStatus !== 'quota_exhausted' && before.runtimeStatus !== 'halted') {
          return { kind: 'success', text: 'Advisor is already on for this session.' }
        }
        const s = ctrl.setSessionOverride(sessionId, true)
        return {
          kind: 'success',
          text: s.disabledReason !== undefined
            ? `Advisor on for this session — but no model call can start: ${s.disabledReason}`
            : 'Advisor on for this session.',
        }
      }
      case 'off': {
        const before = ctrl.status(sessionId)
        if (!before.effectiveEnabled && !before.override) {
          return { kind: 'success', text: 'Advisor is already off for this session.' }
        }
        ctrl.setSessionOverride(sessionId, false)
        return { kind: 'success', text: 'Advisor off for this session.' }
      }
      case 'status':
        return { kind: 'success', text: statusText(ctrl.status(sessionId)) }
      case 'reset': {
        // Q3：新建评审会话——清空评审员持续上下文 + 去重记忆（epoch 自增）
        const result = ctrl.resetConversation(sessionId)
        if (result === null) {
          return { kind: 'error', text: '无法重置：本会话 Advisor 未启用或运行时不可用' }
        }
        return { kind: 'success', text: `已新建评审会话（#${result.epoch}）——评审员上下文已清空，可在第一条指令中告知背景信息。` }
      }
      case 'tell': {
        const text = parse(invocation.rawInput).text
        if (text === '') return { kind: 'error', text: '指令不能为空：/advisor tell <指令内容>' }
        try {
          ctrl.tell(sessionId, text)
          return { kind: 'success', text: `指令已入队：${text}` }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      }
      default:
        return {
          kind: 'success',
          text: ['Usage: /advisor [on|off|status|reset|tell <text>]',
            '  /advisor           toggle the advisor for this session',
            '  /advisor on        enable (resumes quota-paused, rebuilds halted)',
            '  /advisor off       disable',
            '  /advisor status    show state, model, runtime status',
            '  /advisor reset     start a fresh reviewer conversation (clear context + memory)',
            '  /advisor tell <text>  send an instruction/question to the advisor'].join('\n'),
        }
    }
  }
  return commands.register({
    name: 'advisor',
    description: 'Toggle, enable, disable, inspect, or instruct the per-session advisor',
    input: { hint: '[on|off|status|tell <text>]' },
    handler,
  })
}
