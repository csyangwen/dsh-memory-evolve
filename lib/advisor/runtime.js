/**
 * 评审运行时（实施规划 §三 runtime.js，移植自 dsh-advisor advisor-runtime.ts
 * 并扩展事件模型；第一轮优化 Q1/Q3/Q4）。
 *
 * 每会话一个 AdvisorRuntime，职责：
 *
 * - **有界队列**（maxQueued 默认 32，满=drop-newest + runtime-status 事件）
 *   与串行异步 drain——永不阻塞主循环（fire-and-forget）；
 * - **两阶段事件**（契约 v2）：每个 delta 先发 `review-started`（含
 *   reviewId + 可见表面输入），模型调用结束后发 `review-finished`
 *   （outcome: delivered|recorded|answered|suppressed|no-note|dropped|
 *   failed|cancelled）；quota/permanent 失败发 `runtime-status`；
 * - **评审调用**：`llm.stream({ provider, model, system, messages, maxTokens,
 *   signal, reasoningEffort? })`——reasoningEffort:'off' 能力门控
 *   （resolveModelInfo 声明才传）；maxTokens 5120（避免推理吃光预算）；
 * - **评审员持续会话（Q3 重构）**：每会话一条完整对话上下文
 *   （AdvisorConversation）——世界事件（可见消息/指令/问题）为 user
 *   消息、她自己的输出（建议/回答回放）为 assistant 消息；**每次评审
 *   全量重放、无截断**（用户拍板：默认评审模型 1000k 上下文足够），
 *   评审模式末尾追加 `### Session update` 本轮增量段。`resetConversation`
 *   新建评审会话（清上下文+guard，epoch 自增）；
 * - **指令即时问答（Q4）**：`ask(meta, instructionId)` 入队问答任务
 *   ——用户发指令后立即触发（不等待下个主回合）；问题进持续会话
 *   （### User question），system 追加 QA 后缀（输出自由文本回答而非
 *   JSON 帧）；**跳过发射闸门**（用户明确提问必须回答）；回答**只通过
 *   finished 事件在面板展示、回放进评审员会话**（2026-08-12 用户反馈：
 *   不注入主会话，避免污染 agent 下一轮上下文）；
 * - **JSON 帧提取**（KD-2）：回复中第一个平衡 `{…}`，note 非空校验，
 *   severity 缺省 nit，解析失败不重试；note ≤1000 字符；
 * - **失败策略**（KD-5）：transient→重试 1 次(backoff 可取消)→丢；
 *   3 连丢清 backlog；quota→暂停（batch 保留、指令释放、无自动恢复）；
 *   permanent→终止；调用级超时（callTimeoutMs，覆盖能力查询/stream
 *   建立/每次 next，provider 忽略 AbortSignal 也能退出）；
 * - **指令消费**：drain 开始时 reserve → 并入评审输入；完成（无论
 *   outcome）consume；失败/quota/permanent 释放回 pending；
 * - **dispose generation**：dispose 后迟到回调丢弃（不写事件、不投递）。
 *
 * 事件通过注入的 `onEvent` 回调交给 store（seq 分配 + ring + 终态落盘
 * JSONL）；note 通过 `onNote` 交给投递层（guard 已在 runtime 内执行）；
 * 问答回答不投递（面板事件 + 会话回放，见上）。
 *
 * @module dsh-memory-evolve/advisor/runtime
 */

import { CONTENT_FREE_PHRASES, createEmissionGuard, normalizeNote } from './guard.js'
import { translate, getLocale, MISC2_DICT } from '../i18n.js'

/** Translate through MISC2_DICT in the active host locale. */
const art = (key, params) => translate(MISC2_DICT, key, params, getLocale())
import { QA_SYSTEM_PROMPT_SUFFIX } from './prompt.js'
import { AdvisorConversation } from './conversation.js'
// 角色包裹标记（2026-08-13 用户反馈：评审员必须分清谁对谁说话）
import { ROLE_MARKERS, wrapRoleEntry } from './visible-surface.js'

/** 输出 token 上限（256 的 20 倍超驰——reasoning 模型空回复教训）。 */
export const ADVISOR_MAX_TOKENS = 5_120

/** 单条 note 长度上限（截断加省略号）。 */
export const ADVISOR_NOTE_MAX_CHARS = 1_000

/** 问答回复文本上限（Q4：注入消息不宜过长，截断加省略号）。 */
export const ADVISOR_ANSWER_MAX_CHARS = 2_000

const DEFAULT_MAX_QUEUED = 32
const DEFAULT_RETRY_BACKOFF_MS = 1_000
const DEFAULT_CALL_TIMEOUT_MS = 60_000
const MAX_TRANSIENT_ATTEMPTS = 1 // transient 重试次数（第 2 次尝试仍失败即丢）
const MAX_CONSECUTIVE_DROPS = 3 // 连续失败阈值，达到后清空 backlog

/** 评审输入中 user 消息的 source（评审模型视角的普通用户输入）。 */
const REVIEW_USER_SOURCE = { kind: 'user' }

// ---------------------------------------------------------------------------
// JSON 帧提取（KD-2）
// ---------------------------------------------------------------------------

/** 产出回复文本中所有顶层平衡 {…} 区域（跳过字符串字面量内的括号）。 */
function* balancedObjects(text) {
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      if (start < 0) { start = index; depth = 1 } else depth += 1
    } else if (char === '}') {
      if (start >= 0 && --depth === 0) {
        yield text.slice(start, index + 1)
        start = -1
      }
    }
  }
}

/**
 * 从评审模型回复中提取一条建议（KD-2）。
 * @returns {{text:string,severity:'info'|'nit'|'concern'|'blocker'}|undefined}
 *   undefined=无可解析帧（调用方 drop + 日志，不重试）。
 *   **DTO 契约：{text, severity}**（与 kinds/delivery/store/前端一致——
 *   复审 B1：内部曾用 {note,severity} 导致投递内容变 undefined）
 *   **Q1：info 必须原样保留**（旧实现只认 concern/blocker，info 会被静默
 *   归一到 nit——info 默认仅记录不注入的语义就失效了）
 */
export function extractAdviceNote(reply) {
  for (const frame of balancedObjects(String(reply ?? ''))) {
    let parsed
    try {
      parsed = JSON.parse(frame)
    } catch {
      continue // 不是 JSON，试下一个平衡区域
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const note = parsed.note
    if (typeof note !== 'string' || note.trim().length === 0) continue
    const trimmed = note.trim()
    // 2026-08-12 用户反馈："Nothing to add" 是评审员"没有值得提的建议"
    // 的约定帧——在提取层归一化为无建议（outcome no-note，面板显示
    // "无建议"），而不是作为 note 展示给用户（guard 的空泛抑制保留为
    // 双保险）
    if (CONTENT_FREE_PHRASES.has(normalizeNote(trimmed))) continue
    const severity = parsed.severity
    return {
      text: trimmed.length > ADVISOR_NOTE_MAX_CHARS
        ? `${trimmed.slice(0, ADVISOR_NOTE_MAX_CHARS - 1)}…`
        : trimmed,
      severity: severity === 'info' || severity === 'concern' || severity === 'blocker' ? severity : 'nit',
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 失败分类（KD-5）
// ---------------------------------------------------------------------------

/** 永久拒绝类错误（重试无法修复，halt）。 */
const PERMANENT_FAILURE_PATTERN = /invalid_request_error|model[_ ]not[_ ]found|is not supported when|does not exist|NO_ADAPTER/i

function classifyFailure(failure) {
  const code = String(failure?.code ?? 'UNKNOWN')
  const message = String(failure?.message ?? '')
  if (code === 'QUOTA_EXCEEDED' || code === 'RATE_LIMIT' || /quota|rate[_ ]?limit/i.test(message)) {
    return 'quota'
  }
  if (code === 'INVALID_CREDENTIAL' || PERMANENT_FAILURE_PATTERN.test(message)) {
    return 'permanent'
  }
  return 'transient'
}

function normalizeFailure(value) {
  if (value instanceof Error) {
    return { message: value.message, code: typeof value.code === 'string' && value.code !== '' ? value.code : 'UNKNOWN' }
  }
  return { message: String(value), code: 'UNKNOWN' }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 把一次迭代器取值与超时信号竞争：信号先触发返回 'aborted'。provider
 * 忽略 AbortSignal 时，挂死的流也由本竞争兜底退出（不依赖 provider 配合）。
 */
function raceIteratorNext(iterator, signal) {
  if (signal.aborted) return Promise.resolve('aborted')
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve('aborted')
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve().then(() => iterator.next()).then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

// ---------------------------------------------------------------------------
// AdvisorRuntime
// ---------------------------------------------------------------------------

/** 评审运行时状态（契约 v2 冻结枚举）。 */
export const RUNTIME_STATUS = ['disabled', 'idle', 'reviewing', 'quota_exhausted', 'halted']

/**
 * @param {object} options
 * @param {string} options.provider - 生效供应商路由（resolveAdvisorRoute 解析后）
 * @param {string} options.model - 生效模型 id
 * @param {string} options.systemPrompt - 评审提示词（内置或用户覆盖）
 * @param {object} options.llm - { stream(options), resolveModelInfo?(provider,model,signal) }
 * @param {object} [options.guard] - 发射闸门（缺省新建）
 * @param {object} options.instructions - { reserve(sessionId), consume(reviewId, ids), release(ids) }
 * @param {(event: object) => void} options.onEvent - 事件回调（store.emit）
 * @param {(note: object, reviewId: string) => void} options.onNote - 放行 note 回调（delivery 投递）
 * @param {object} [options.logger] - { debug, warn }
 * @param {number} [options.maxQueued] - 队列上限（默认 32）
 * @param {number} [options.maxTokens] - 输出上限（默认 ADVISOR_MAX_TOKENS）
 * @param {number} [options.retryBackoffMs] - transient 重试退避（默认 1000ms）
 * @param {number} [options.callTimeoutMs] - 单次调用超时（默认 60000ms）
 * @param {boolean} [options.reasoningOff] - 是否发送 reasoningEffort:'off'（默认 true，能力门控）
 */
export class AdvisorRuntime {
  constructor(options) {
    this.provider = options.provider
    this.model = options.model
    /**
     * 评审 system 提示词提供者（2026-08-12 用户拍板四层级）：默认静态
     * systemPrompt；装配层可注入 systemPromptOf 动态拼接四层约束（保存
     * 约束后无需重建 runtime，下次评审调用立即生效）。
     */
    this.systemPromptOf = options.systemPromptOf ?? (() => options.systemPrompt)
    this.llm = options.llm
    this.guard = options.guard ?? createEmissionGuard()
    this.instructions = options.instructions
    this.onEvent = options.onEvent
    this.onNote = options.onNote
    this.logger = options.logger ?? console
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED
    this.maxTokens = options.maxTokens ?? ADVISOR_MAX_TOKENS
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    this.reasoningOff = options.reasoningOff !== false

    this.queue = []
    this.state = 'idle'
    this.draining = false
    this.disposed = false
    this.consecutiveDrops = 0
    this.controller = new AbortController()
    this.drainPromise = undefined
    this.pendingCountAt = 0
    /** 本轮 in-flight 的指令 reservation（B5：dispose 时释放）。 */
    this.activeReservation = undefined
    /** reasoning 能力缓存（provider+model 一次解析）。 */
    this.reasoningEffortCache = new Map()
    /** dispose 代数：abort 后 +1，迟到回调比对代数丢弃。 */
    this.generation = 0
    /**
     * 评审员持续会话（Q3 重构：用户拍板完整上下文、无截断）：
     * 完整对话历史（世界事件 + 她自己的输出回放），每次评审全量重放。
     * 取代旧机制的 recentNotes（3 条拼接）与 contextMarkdown 窗口。
     */
    this.conversation = options.conversation ?? new AdvisorConversation()
  }

  /** 当前状态（契约枚举）。 */
  status() {
    return this.state
  }

  /** phase（契约字段；与 status 同源，供 /status API 透出）。 */
  phase() {
    return this.state
  }

  /** 当前是否有评审在飞（0/1；契约 inFlight 语义，非队列长度）。 */
  get inFlightCount() {
    return this.draining ? 1 : 0
  }

  /** 待处理 delta 数。 */
  get pendingCount() {
    return this.queue.length
  }

  /** 评审员持续会话占用统计（面板显示用）。 */
  contextStats() {
    return this.conversation.stats()
  }

  /**
   * 入队一个评审 delta（fire-and-forget，绝不抛错）。
   * @param {object} delta - { markdown, messageCount, charCount }（visible-surface 渲染结果）
   * @param {object} meta - { sessionId, sessionName, workspace }
   */
  enqueue(delta, meta) {
    if (this.disposed) return
    if (this.state === 'halted') return
    if (this.queue.length >= this.maxQueued) {
      // 满队列：丢弃最新（最冗余），发 runtime-status 让面板可见积压变化
      this.logger.debug('advisor: enqueue dropped — backlog full', { maxQueued: this.maxQueued })
      this.emitStatus()
      return
    }
    this.queue.push({ delta, meta })
    if (this.state === 'quota_exhausted') return // 暂停：保留 batch，不自动恢复
    this.kickDrain()
  }

  /**
   * 指令即时问答（第一轮优化 Q4）：入队一个问答任务。
   *
   * 用户通过面板/`/advisor tell` 发指令后由装配层立即调用（不等待下个
   * 主回合）；问答与普通评审共用串行 drain——正在评审时排队等当前完成，
   * 通常秒级内轮到。Q3 重构：问题直接进评审员持续会话（### User
   * question 段），回答（assistant 回放）也进会话——她记得问答内容。
   *
   * 复审高1：问答任务**携带新增指令 id**（bound 绑定），普通评审的
   * reserve 会跳过它——排队中的评审不会抢走刚发的问题。
   *
   * @param {object} meta - { sessionId, sessionName, workspace }
   * @param {string|null} [instructionId] - 触发本次问答的指令 id（bound 绑定，可为 null）
   * @returns {boolean} true=已入队；false=被拒（队列满/halted——调用方应
   *   unbind 指令，让它回到普通 pending 流由下次评审消费）
   */
  ask(meta, instructionId = null) {
    if (this.disposed || this.state === 'halted') return false
    // 复审低9：问答与评审共用同一有界队列（满=拒绝，不绕过 maxQueued）
    if (this.queue.length >= this.maxQueued) {
      this.logger.debug('advisor: question enqueue dropped — backlog full', { maxQueued: this.maxQueued })
      this.emitStatus()
      return false
    }
    this.queue.push({ delta: { qa: true, instructionId }, meta, question: true })
    if (this.state === 'quota_exhausted') return true // 暂停：保留 batch，不自动恢复
    this.kickDrain()
    return true
  }

  /** 手动恢复（quota 暂停后 /advisor on 调起；halted 由装配层重建）。 */
  resume() {
    if (this.disposed || this.state === 'halted') return
    this.state = 'idle'
    this.kickDrain()
    this.emitStatus()
  }

  /** compact/表面重写：重置发射闸门去重历史（observer onRewrite 调起）。 */
  resetGuard() {
    this.guard.reset()
  }

  /**
   * 新建评审会话（Q3 重构：用户拍板——评审员是持续对话，用户通过新建
   * 会话控制上下文长度；新会话第一条指令给评审员背景信息）。
   *
   * 清空评审员持续会话上下文 + 发射闸门去重记忆（评审员"换新"，从零
   * 开始积累）。会话代数（epoch）自增，面板/记录以此区分"第几任评审员"。
   *
   * @returns {{ epoch: number } | null} 新代数（disposed 返回 null）
   */
  resetConversation() {
    if (this.disposed) return null
    // 稳定版复审 P1-7：换任前先作废 in-flight 旧评审——generation 自增 +
    // 中止请求 + 清空积压队列。正在执行的旧评审完成后因 gen 不匹配被
    // abortDelta 丢弃，绝不会写进已经清空的新 epoch（旧实现只清上下文
    // 不隔离在途调用，旧结果会污染新评审员的第一轮对话）。
    this.generation += 1
    this.controller.abort('advisor conversation reset')
    this.controller = new AbortController()
    this.queue.length = 0
    this.consecutiveDrops = 0
    const epoch = this.conversation.reset()
    this.guard.reset()
    this.emitStatus()
    return { epoch }
  }

  /** 中止 in-flight 并停止 drain（agent/session dispose 调起；幂等）。 */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.controller.abort('advisor disposed')
    this.queue.length = 0
    this.consecutiveDrops = 0
    this.state = 'disabled'
    // B5：释放 in-flight 指令（否则以 reserved 状态留在磁盘永不消费）
    // 复审中4：release 带 reviewId 校验（迟到释放不得误伤新 reservation）
    if (this.activeReservation !== undefined && this.activeReservation.length > 0) {
      try {
        const reservation = this.activeReservation
        this.instructions.release(reservation[0]?.reviewId, reservation)
      } catch (error) {
        this.logger.warn?.('advisor: dispose instruction release failed', { error })
      }
      this.activeReservation = undefined
    }
  }

  /** 测试钩子：等当前 drain 轮次结束。 */
  async waitForDrain() {
    await this.drainPromise
  }

  /** 测试钩子：当前代数（dispose 校验用）。 */
  get currentGeneration() {
    return this.generation
  }

  emitStatus() {
    this.onEvent?.({
      type: 'runtime-status',
      ts: Date.now(),
      runtimeStatus: this.state,
      pendingCount: this.queue.length,
    })
  }

  kickDrain() {
    if (this.draining || this.disposed || this.state === 'quota_exhausted' || this.state === 'halted') return
    this.state = 'reviewing'
    this.emitStatus()
    this.drainPromise = this.drain().catch((error) => {
      // fire-and-forget 兜底：drain 内部错误绝不允许成为 unhandled rejection
      this.logger.warn('advisor: drain loop failed — contained', { error })
    })
  }

  /** 串行 drain：逐个处理队列中的 delta。 */
  async drain() {
    this.draining = true
    const gen = this.generation
    try {
      while (!this.disposed && this.queue.length > 0 && this.state !== 'quota_exhausted' && this.state !== 'halted') {
        const { delta, meta } = this.queue.shift()
        await this.processDelta(delta, meta, gen)
      }
    } finally {
      this.draining = false
      if (!this.disposed && this.state === 'reviewing') {
        this.state = 'idle'
        this.emitStatus()
      }
    }
  }

  /** 处理一个任务：指令 reserve → started → 调用 → 提取 → guard → 投递 → finished。 */
  async processDelta(delta, meta, gen) {
    const reviewId = crypto.randomUUID()
    const startedAt = Date.now()
    // 问答模式（Q4）：输入=用户问题，不渲染可见表面；跳过发射闸门
    // （用户明确提问必须回答，不经过"每轮一条/去重/空泛抑制"）
    const isQa = delta.qa === true
    // 指令：drain 开始时 reserve（**绑定本 reviewId**——复审 B4：曾用两个
    // 不同 id 导致 consume 永不匹配，指令永久停在 reserved）
    // 复审高1：问答任务精确消费触发它的指令 id；普通评审跳过已绑定问答的
    const reserved = isQa && delta.instructionId != null
      ? this.instructions.reserve(meta.sessionId, reviewId, { ids: [delta.instructionId] })
      : this.instructions.reserve(meta.sessionId, reviewId)
    const instructionTexts = reserved.map((item) => item.text)
    // 跟踪活动 reservation：dispose/abort 时释放（复审 B5）
    this.activeReservation = reserved
    if (!isQa) this.guard.beginUpdate()

    // Q3 重构：评审员持续会话。2026-08-13 用户反馈修订：**每一轮评审只
    // 注入一次本轮观察到的 Agent/用户消息**——本轮输入（评审指令 + 增量
    // 可见条目）只出现在末尾的 `### Session update` 段，**不提前 append
    // 进历史**（旧实现先 appendUser 再重放，同一内容在历史尾部与 update
    // 段出现两次）；评审完成/失败后由 commitReviewInput 统一提交进持续
    // 会话（下轮重放时作为已看过的历史）。
    const contextCount = this.conversation.length
    const updateEntries = []
    if (isQa) {
      // 问答：问题进上下文（"### User question" 段，QA 提示词识别）；
      // 成对标签标明"用户直接对评审员提问"（2026-08-13 用户反馈）
      // 问答无 update 段——问题只在历史里出现一次，无需额外提交
      if (instructionTexts.length > 0) {
        this.conversation.appendUser(`### User question\n${wrapRoleEntry(ROLE_MARKERS.userToAdvisorQuestion, instructionTexts.join('\n'))}`)
      }
    } else {
      // 评审：评审指令（用户直接对评审员说的话）+ 本轮增量可见条目合并
      // 进 update 段（唯一出现）；指令用成对标签标明归属
      if (instructionTexts.length > 0) {
        updateEntries.push(wrapRoleEntry(ROLE_MARKERS.userToAdvisorInstruction, instructionTexts.join('\n')))
      }
      for (const entry of delta.entries ?? []) {
        updateEntries.push(entry.text)
      }
    }
    // 评审 update 段 = 本轮输入（模型聚焦最后新增内容）；问答无 update 段
    const updateText = updateEntries.length > 0
      ? `### Session update\n\n${updateEntries.join('\n\n')}`
      : null
    /** 评审收尾时把本轮输入提交进持续会话（只此一份，与 update 段同源）。
     * 所有退出路径（成功/中止/失败）都提交——评审员"见过"的内容不丢，
     * 下轮重放时作为历史；顺序保证在 assistant 建议之前（先 user 后
     * assistant，对话顺序正确）。 */
    const commitReviewInput = () => {
      if (isQa || updateEntries.length === 0) return
      for (const text of updateEntries) this.conversation.appendUser(text)
    }

    const inputSummary = isQa
      ? {
          // Q4：问答的"输入"=用户问题（charCount 计问题文本长度）
          messageCount: 0,
          charCount: instructionTexts.join('\n').length,
          markdown: instructionTexts.join('\n'),
          mode: 'qa',
          // Q3：评审员持续会话上下文统计（历史条数 / 会话代数）
          contextCount,
          epoch: this.conversation.epoch,
        }
      : {
          messageCount: delta.messageCount,
          charCount: delta.charCount,
          markdown: delta.markdown,
          contextCount,
          epoch: this.conversation.epoch,
        }
    this.onEvent?.({
      type: 'review-started',
      reviewId,
      ts: startedAt,
      sessionId: meta.sessionId,
      sessionName: meta.sessionName ?? null,
      workspace: meta.workspace ?? null,
      input: inputSummary,
    })

    for (let attempt = 0; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        if (this.disposed || gen !== this.generation) return this.abortDelta({ reviewId, meta, startedAt, instructionTexts, reserved })
        await sleep(this.retryBackoffMs, this.controller.signal)
        if (this.disposed || gen !== this.generation) return this.abortDelta({ reviewId, meta, startedAt, instructionTexts, reserved })
      }
      const result = isQa
        ? await this.callQuestionModel(gen)
        : await this.callModel(updateText, gen)
      if (result.kind === 'note' || result.kind === 'answer' || result.kind === 'no-note') {
        commitReviewInput()
        return this.finishDelta(result, { reviewId, meta, startedAt, instructionTexts, reserved, gen, isQa })
      }
      if (result.kind === 'aborted') {
        commitReviewInput()
        return this.abortDelta({ reviewId, meta, startedAt, instructionTexts, reserved })
      }
      // 失败分类（B6：quota/permanent 必须发 finished 闭合 started）
      const failure = result.failure
      switch (classifyFailure(failure)) {
        case 'quota':
          commitReviewInput()
          this.state = 'quota_exhausted'
          this.instructions.release(reserved[0]?.reviewId, reserved)
          this.activeReservation = undefined
          this.logger.warn('advisor: quota/rate-limit — paused, batch retained', { failure })
          this.emitStatus('quota_exhausted')
          this.emitFinished(reviewId, meta, startedAt, instructionTexts, 'failed', null, {
            code: 'QUOTA_EXCEEDED',
            message: art('adv.rateLimited', { detail: failure.message }),
            retryable: true,
          })
          return
        case 'permanent':
          commitReviewInput()
          this.state = 'halted'
          this.instructions.release(reserved[0]?.reviewId, reserved)
          this.activeReservation = undefined
          this.logger.warn('advisor: permanent model error — halted', { failure })
          this.emitStatus('halted')
          this.emitFinished(reviewId, meta, startedAt, instructionTexts, 'failed', null, {
            code: failure.code ?? 'PERMANENT_FAILURE',
            message: failure.message,
            retryable: false,
          })
          return
        case 'transient':
          break // 重试一次（循环下一轮）
      }
    }
    // transient 重试耗尽：drop + 指令释放 + finished(failed)
    commitReviewInput()
    this.consecutiveDrops += 1
    this.instructions.release(reserved[0]?.reviewId, reserved)
    this.activeReservation = undefined
    const dropped = this.consecutiveDrops >= MAX_CONSECUTIVE_DROPS
    if (dropped) {
      this.flushBacklog()
    } else {
      this.logger.warn('advisor: dropping delta after transient failures', { attempts: MAX_TRANSIENT_ATTEMPTS + 1 })
    }
    this.emitFinished(reviewId, meta, startedAt, instructionTexts, 'failed', null, {
      code: 'TRANSIENT_FAILURE',
      message: art('adv.droppedAfterRetries'),
      retryable: true,
    })
  }

  /** abort 路径：释放指令 + 发 cancelled 闭合（B5/B6）。 */
  abortDelta({ reviewId, meta, startedAt, instructionTexts, reserved }) {
    // 复审中4：带 reviewId 校验（迟到释放不得误伤新 reservation）
    this.instructions.release(reserved[0]?.reviewId, reserved)
    this.activeReservation = undefined
    this.emitFinished(reviewId, meta, startedAt, instructionTexts, 'cancelled', null, {
      code: 'CANCELLED',
      message: art('adv.aborted'),
      retryable: false,
    })
  }

  /**
   * finished 事件统一发射（B6：每个 started 恰好一个 finished；B11：带会话
   * 元数据）。**不在 dispose 后静默**——abortDelta（dispose/中止路径）必须
   * 发 cancelled 闭合前端 skeleton；迟到回调（finishDelta gen 不匹配）由
   * 调用方决定不发，这里不拦截。
   *
   * @param {string|null} deliveryKind - 投递通道（'steer'|'inject'|null；
   *   Q1 起 answered/recorded 也如实标注通道，前端据此区分展示）
   */
  emitFinished(reviewId, meta, startedAt, instructionTexts, outcome, note, error, deliveryKind = null) {
    this.onEvent?.({
      type: 'review-finished',
      reviewId,
      ts: Date.now(),
      sessionId: meta.sessionId,
      sessionName: meta.sessionName ?? null,
      workspace: meta.workspace ?? null,
      outcome,
      delivery: deliveryKind,
      note,
      elapsedMs: Date.now() - startedAt,
      instructions: instructionTexts,
      error,
    })
  }

  /** 模型调用成功路径收尾：问答直接投递 / 评审 guard → 投递 → finished 事件。 */
  finishDelta(result, { reviewId, meta, startedAt, instructionTexts, reserved, gen, isQa = false }) {
    if (this.disposed || gen !== this.generation) {
      // 迟到回调：指令已由 dispose/abort 释放，这里只静默丢弃
      return
    }
    const elapsedMs = Date.now() - startedAt
    this.activeReservation = undefined
    // Q4：问答回答——跳过发射闸门（用户明确提问必须回答）。
    // 2026-08-12 用户反馈修订：回答**不注入主会话**（避免污染 agent 的
    // 下一轮上下文，如"上下文注入advisor [advisor]..."）——只通过
    // finished 事件在面板展示 + 回放进评审员持续会话。
    if (result.kind === 'answer') {
      this.consecutiveDrops = 0
      this.instructions.consume(reviewId, instructionTexts)
      // Q3：回答回放进评审员持续会话（她记得自己回答过什么）
      this.conversation.appendAssistant(`[advisor] ${result.text}`)
      const note = { text: result.text, severity: 'answer' }
      this.emitFinished(reviewId, meta, startedAt, instructionTexts, 'answered', note, null, null)
      return
    }
    if (result.kind === 'no-note') {
      // 评审完成但无可提取建议（含 Nothing to add 帧被提取为空等）/ 问答空回答
      this.consecutiveDrops = 0
      this.instructions.consume(reviewId, instructionTexts)
      this.emitFinished(reviewId, meta, startedAt, instructionTexts, 'no-note', null, null)
      return
    }
    // 提取到 note → 发射闸门
    let accepted = false
    try {
      accepted = this.guard.accept(result.note)
    } catch (error) {
      this.logger.warn('advisor: emission guard threw — contained', { error })
    }
    this.consecutiveDrops = 0
    this.instructions.consume(reviewId, instructionTexts)
    if (!accepted) {
      this.emitFinished(reviewId, meta, startedAt, instructionTexts, 'suppressed', result.note, null)
      return
    }
    // 放行 → 投递（Q1 契约：onNote 返回 'steer'|'inject'|'recorded'|false）
    let deliveryResult = false
    try {
      deliveryResult = this.onNote(result.note, reviewId)
    } catch (error) {
      deliveryResult = false
      this.logger.warn('advisor: delivery threw — contained', { error })
    }
    const outcome = deliveryResult === 'recorded' ? 'recorded' : deliveryResult !== false ? 'delivered' : 'dropped'
    const deliveryKind = deliveryResult === 'steer' ? 'steer' : deliveryResult === 'inject' ? 'inject' : null
    // Q3：投递成功（delivered/recorded）的 note 回放进评审员持续会话——
    // 她记得自己说过什么（旧机制的 recentNotes 3 条拼接已被完整历史取代）
    if (outcome === 'delivered' || outcome === 'recorded') {
      this.conversation.appendAssistant(`[${result.note.severity}] ${result.note.text}`)
    }
    this.emitFinished(reviewId, meta, startedAt, instructionTexts, outcome, result.note,
      outcome === 'dropped' ? { code: 'DELIVERY_FAILED', message: art('adv.deliveryFailed'), retryable: false } : null,
      deliveryKind)
  }

  /** KD-5：连续失败后清空 backlog（never stall）。 */
  flushBacklog() {
    this.consecutiveDrops = 0
    if (this.queue.length === 0) return
    const flushed = this.queue.length
    this.queue.length = 0
    this.logger.warn('advisor: flushed pending backlog after consecutive failures', { flushed })
  }

  /** 一次评审模型调用：公共流式骨架 + JSON 帧提取。 */
  async callModel(updateText, gen) {
    // Q3 重构：评审输入 = 评审员持续会话全量历史 + 本轮 update 段
    const messages = this.buildConversationMessages(updateText)
    const streamed = await this.streamText(messages, this.systemPromptOf(), gen)
    if (streamed.kind !== 'ok') return streamed
    const note = extractAdviceNote(streamed.text)
    if (note === undefined) {
      this.logger.debug('advisor: reply yielded no note — dropped (KD-2)')
      return { kind: 'no-note' }
    }
    return { kind: 'note', note }
  }

  /**
   * 一次问答模型调用（Q4 指令即时问答）：同超时/中止框架；system 追加
   * QA 后缀（输出自由文本回答而非 JSON 帧）。
   *
   * 复审高2：空回答按 transient 失败处理（重试一次）——模型偶发空输出
   * 时重试有机会成功；重试仍空才 failed + 指令 release 回 pending
   * （绝不把用户问题静默消费掉）。
   */
  async callQuestionModel(gen) {
    // Q3 重构：问答输入 = 持续会话全量历史（问题已作为最后一条 user 消息）
    const messages = this.buildConversationMessages(null)
    const streamed = await this.streamText(messages, `${this.systemPromptOf()}\n${QA_SYSTEM_PROMPT_SUFFIX}`, gen)
    if (streamed.kind !== 'ok') return streamed
    const answer = streamed.text.trim()
    if (answer === '') {
      this.logger.debug('advisor: question reply empty — transient failure (retry once)')
      return { kind: 'failure', failure: { message: art('adv.emptyAnswer'), code: 'EMPTY_ANSWER' } }
    }
    const bounded = answer.length > ADVISOR_ANSWER_MAX_CHARS
      ? `${answer.slice(0, ADVISOR_ANSWER_MAX_CHARS - 1)}…`
      : answer
    return { kind: 'answer', text: bounded }
  }

  /**
   * 构造评审员持续会话的模型输入（Q3 重构，取代 buildReviewMessages；
   * 2026-08-13 用户反馈修订：每轮只注入一次本轮消息）：
   *
   * 评审员上下文 = conversation 全量消息（世界事件 user + 她自己的输出
   * assistant），**无截断、全量重放**——模型视角是一条从第一条消息开始
   * 的完整连续对话。评审模式末尾追加本轮 `### Session update` 段——本轮
   * 输入（评审指令 + 增量可见条目）**只在此段出现一次**（历史重放不含
   * 本轮，本轮内容在评审收尾后由 processDelta 提交进 conversation，供
   * 下轮重放）；问答模式问题已在历史最后一条，无需追加。
   *
   * @param {string|null} updateText - 评审模式的本轮输入段（问答传 null）
   * @returns {Array<object>} llm 消息数组（user/assistant 角色保留）
   */
  buildConversationMessages(updateText) {
    const history = this.conversation.snapshot()
    const messages = history.map((message) => ({
      role: message.role,
      id: crypto.randomUUID(),
      content: [{ type: 'text', text: message.text }],
      // 世界事件=user 输入；她自己的输出=assistant（model 来源）
      source: message.role === 'assistant' ? { kind: 'model' } : REVIEW_USER_SOURCE,
    }))
    if (updateText !== null && updateText !== '') {
      messages.push({
        role: 'user',
        id: crypto.randomUUID(),
        content: [{ type: 'text', text: updateText }],
        source: REVIEW_USER_SOURCE,
      })
    }
    return messages
  }

  /**
   * 流式调用公共骨架：调用级超时（融合 dispose signal 与整调用定时器；
   * provider 忽略 AbortSignal 时挂死的流由 per-chunk 竞争兜底退出）→
   * 读完全部 text-delta。
   *
   * @returns {{kind:'ok',text:string}|{kind:'failure',failure:object}|{kind:'aborted'}}
   */
  async streamText(messages, system, gen) {
    const timeoutController = new AbortController()
    const timeoutTimer = setTimeout(() => timeoutController.abort('advisor call timeout'), this.callTimeoutMs)
    const onDispose = () => timeoutController.abort('advisor disposed')
    this.controller.signal.addEventListener('abort', onDispose, { once: true })
    const deadlineSignal = timeoutController.signal
    let text = ''
    try {
      const reasoningEffort = await this.resolveReasoningEffort(deadlineSignal)
      const options = {
        provider: this.provider,
        model: this.model,
        system,
        messages,
        maxTokens: this.maxTokens,
        signal: deadlineSignal,
      }
      if (reasoningEffort !== undefined) options.reasoningEffort = reasoningEffort
      const stream = this.llm.stream(options)
      const iterator = stream[Symbol.asyncIterator]()
      for (;;) {
        const next = await raceIteratorNext(iterator, deadlineSignal)
        if (next === 'aborted') {
          iterator.return?.().catch(() => {})
          if (timeoutController.signal.aborted && !this.controller.signal.aborted) {
            return {
              kind: 'failure',
              failure: { message: `advisor call timed out after ${this.callTimeoutMs}ms`, code: 'TIMEOUT' },
            }
          }
          return { kind: 'aborted' }
        }
        if (next.done) break
        const chunk = next.value
        if (chunk?.type === 'text-delta') text += chunk.text
      }
    } catch (error) {
      return { kind: 'failure', failure: normalizeFailure(error) }
    } finally {
      clearTimeout(timeoutTimer)
      this.controller.signal.removeEventListener('abort', onDispose)
    }
    if (gen !== this.generation || this.disposed) return { kind: 'aborted' }
    return { kind: 'ok', text }
  }

  /**
   * reasoning off 能力门控：仅当模型 adapter 声明 'off' 档位才传
   * reasoningEffort:'off'（非 deepseek 模型不炸）；缓存 per (provider,model)。
   */
  async resolveReasoningEffort(signal) {
    if (!this.reasoningOff) return undefined
    const key = `${this.provider}\u0000${this.model}`
    if (this.reasoningEffortCache.has(key)) return this.reasoningEffortCache.get(key)
    let effort
    try {
      // B9：能力查询也必须受调用级 deadline 约束（provider 忽略 AbortSignal
      // 时由竞争兜底，不挂住 drain）
      const infoPromise = this.llm.resolveModelInfo?.(this.provider, this.model, signal)
      const info = infoPromise === undefined ? undefined : await this.raceWithSignal(infoPromise, signal)
      if (info === 'aborted') return undefined
      effort = info?.reasoning?.efforts?.some((entry) => entry.id === 'off') ? 'off' : undefined
    } catch {
      effort = undefined // 解析失败：省略选项（不炸调用）
    }
    this.reasoningEffortCache.set(key, effort)
    return effort
  }

  /** 把任意 promise 与超时信号竞争（超时/中止返回 'aborted'；拒绝照常传播）。 */
  async raceWithSignal(promise, signal) {
    if (signal.aborted) return 'aborted'
    return await new Promise((resolve, reject) => {
      const onAbort = () => resolve('aborted')
      signal.addEventListener('abort', onAbort, { once: true })
      Promise.resolve(promise).then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }
}
