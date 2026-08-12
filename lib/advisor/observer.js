/**
 * 会话观察器（实施规划 §三 observer.js）。
 *
 * 订阅 `session/event`（装配层转发，监听 {global:true}），两种触发模式把
 * 可见消息渲染成评审 delta 交给运行时：
 *
 * 1. **标准 stepped 会话**：每个 `turn/end`（reason.kind ∈ completed /
 *    max-tokens / error）且是**最新进入过 step 的 turn**——被用户掐断的
 *    回合（aborted/blocked/interrupted）不评审；
 * 2. **agentic / harness 会话**（从不发 turn/end）：人类输入到达
 *    （user/message 且 source.kind==='user'，或 inbox 拼接含 user 消息）
 *    且存在未评审的 assistant 增量时评审。**模式闩锁**：会话一旦发过
 *    任意 turn/end 就锁定为标准模式。
 *
 * 消息获取：通过注入的 `getSession(sessionId)` 调 `session.deriveMessages()`
 * （DSH 会话服务的投影方法：处理 surfaceOp replace/compact，带缓存，
 * O(新增节点)）——**零依赖**（memory-evolve 不 import @deepseek-ai/*，
 * 宿主运行时提供）。增量 = cursor 之后的消息；`messages.length < cursor`
 * （重写导致投影回退）或可见 rewrite 事件（compact/*、非 append
 * surfaceOp）→ 全量重放 + 回调 `onRewrite`（装配层重置 guard）。
 *
 * 渲染交给 visible-surface（只取前台可见文本表面），有界窗口 + 截断
 * 标记；`onSteppedTurnEnd` 在渲染前触发（投递冷却计数用，本期未启用
 * 冷却但保留钩子）；`seedTo`（/advisor on 中途开启）不全量回放。
 *
 * 纯类（cordis-free），`handleEvent(sessionId, events, event)` 由装配层
 * 从 `session/event` 监听转发；events 为会话日志快照（用于 turn 检测）。
 *
 * @module dsh-memory-evolve/advisor/observer
 */

import { renderVisibleEntries, renderVisibleSurface, DEFAULT_MAX_MESSAGES } from './visible-surface.js'
import { isAdvisorMessage } from './kinds.js'

/** 评审的 turn 结束原因（跳过用户掐断的回合）。 */
const REVIEWABLE_TURN_END_KINDS = new Set(['completed', 'max-tokens', 'error'])

/** turn/end 是否为可评审结束。 */
export function isReviewableTurnEnd(event) {
  return event?.type === 'turn/end' && REVIEWABLE_TURN_END_KINDS.has(event.data?.reason?.kind)
}

/** 事件是否触发表面重写（compact/* 或非 append surfaceOp）。 */
export function isRewriteEvent(event) {
  if (event?.type?.startsWith('compact/')) return true
  if (event?.type === 'user/message' || event?.type === 'assistant/message' || event?.type === 'tool/result') {
    return event.surfaceOp !== 'append'
  }
  return false
}

/** 事件是否人类输入到达（agentic 触发信号）。 */
export function isHumanInputEvent(event) {
  if (event?.type === 'user/message') return event.data?.source?.kind === 'user'
  if (event?.type === 'agent/inbox/spliced') {
    return Array.isArray(event.data?.inserted) && event.data.inserted.some((m) => m?.source?.kind === 'user')
  }
  return false
}

/**
 * 找最新一条"进入过至少一个 step"的已关闭 turn 的 turn/end 事件。
 * @param {Array} events - 会话事件日志
 */
export function findLastMessageTurnEnd(events) {
  const steppedTurns = new Set()
  let latest
  for (const event of events) {
    if (event?.type === 'step/start') {
      steppedTurns.add(event.data?.turn)
      continue
    }
    if (event?.type === 'turn/end' && steppedTurns.delete(event.data?.turn)) latest = event
  }
  return latest
}

/** 每个会话的观察状态（渲染器）。 */
class SessionRenderer {
  /** 已消费的 deriveMessages 条数（增量游标）。 */
  cursor = 0
  /** 窗口截断标记（有界窗口生效过）。 */
  droppedPrefix = false
  /** 上一轮 deriveMessages 的消息 id 前缀（防御性指纹）。 */
  fingerprint = ''
  /** 是否处于"重建待定"（rewrite 事件后下一次触发全量重放）。 */
  pendingRebuild = false
  maxMessages

  constructor(maxMessages) {
    this.maxMessages = maxMessages
  }

  setMaxMessages(value) {
    this.maxMessages = value
  }

  /**
   * 从 deriveMessages 结果渲染 delta。
   * @returns {object|null} { markdown, messageCount, charCount } 或 null（无可见内容）
   *   （Q3 重构：持续会话下不再携带 contextMarkdown 窗口——完整历史由
   *   runtime 的 AdvisorConversation 维护，observer 只产出本轮增量）
   */
  render(messages) {
    // 重写回退检测：投影结果比已消费的还短 → 全量重放
    if (!this.pendingRebuild && this.cursor > messages.length) this.pendingRebuild = true
    let delta
    if (this.pendingRebuild || this.cursor === 0) {
      // 全量（有界窗口截断）——重建/首次
      this.pendingRebuild = false
      delta = renderVisibleSurface(messages, { maxMessages: this.maxMessages })
    } else {
      // 增量：cursor 之后的消息
      const added = messages.slice(this.cursor)
      if (added.length === 0) return undefined
      delta = renderVisibleSurface(added, { maxMessages: this.maxMessages })
      if (delta === null) return undefined
    }
    this.cursor = messages.length
    this.fingerprint = fingerprintOf(messages)
    return delta
  }

  /** 是否存在未评审的 assistant 增量（agentic 门控谓词，只读）。 */
  hasUnreviewedAssistant(messages) {
    if (messages.length <= this.cursor) return false
    for (let i = this.cursor; i < messages.length; i++) {
      const m = messages[i]
      if (m?.role === 'assistant' && !isAdvisorMessage(m)) return true
    }
    return false
  }

  seedTo(length) {
    this.cursor = length
    this.pendingRebuild = false
    this.droppedPrefix = false
  }

  reset() {
    this.cursor = 0
    this.pendingRebuild = true
    this.droppedPrefix = false
    this.fingerprint = ''
  }
}

/** 消息 id 前缀指纹（防御性：重写可能不伴随可见事件）。 */
function fingerprintOf(messages) {
  let hash = 0
  for (let i = 0; i < messages.length; i++) {
    const id = messages[i]?.id ?? `e${i}`
    for (let j = 0; j < id.length; j++) hash = (hash * 31 + id.charCodeAt(j)) | 0
  }
  return hash.toString(36)
}

/**
 * @param {object} options
 * @param {number} [options.maxMessages] - 有界窗口（默认 60，0=无上限）
 * @param {(sessionId: string) => object | undefined} options.getSession - 会话提供者（ctx.sessions.get）
 * @param {(sessionId: string, meta: object) => object | undefined} options.sessionMeta - { sessionId, sessionName, workspace } 提供者
 * @param {(sessionId: string, delta: object) => void} options.onDelta - 渲染后的评审 delta 回调
 *   （Q3 重构：delta 增加 entries=本轮增量可见条目数组，runtime 追加进评审员持续会话）
 * @param {(sessionId: string) => void} [options.onSteppedTurnEnd] - 每个可评审回合结束回调（渲染前）
 * @param {(sessionId: string) => void} [options.onRewrite] - 表面重写回调（装配层重置 guard/冷却）
 * @param {object} [options.logger]
 */
export class SessionTranscriptObserver {
  constructor(options) {
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES
    this.getSession = options.getSession
    this.sessionMeta = options.sessionMeta ?? (() => undefined)
    this.onDelta = options.onDelta
    this.onSteppedTurnEnd = options.onSteppedTurnEnd
    this.onRewrite = options.onRewrite
    this.logger = options.logger ?? console
    this.renderers = new Map()
    this.pendingSeeds = new Map()
    this.turnEndSessions = new Set()
  }

  setMaxMessages(value) {
    this.maxMessages = value
    for (const renderer of this.renderers.values()) renderer.setMaxMessages(value)
  }

  /** 事件入口（装配层从 session/event 监听转发）。 */
  handleEvent(sessionId, events, event) {
    if (isRewriteEvent(event)) {
      // 权威重写触发：下一次渲染全量重放
      const renderer = this.rendererFor(sessionId)
      renderer.pendingRebuild = true
      this.onRewrite?.(sessionId)
    }
    if (event?.type === 'turn/end') this.turnEndSessions.add(sessionId)
    if (isReviewableTurnEnd(event)) {
      // 必须是最新进入过 step 的 turn（拒绝/空输入/取消产生的无 step 回合不评审）
      const latest = findLastMessageTurnEnd(events)
      if (latest === undefined || latest.seq !== event.seq) return
      this.onSteppedTurnEnd?.(sessionId)
      this.renderAndEmit(sessionId)
      return
    }
    // agentic 门（模式闩锁：标准会话此门休眠）
    if (this.turnEndSessions.has(sessionId)) return
    if (!isHumanInputEvent(event)) return
    const messages = this.messagesOf(sessionId)
    if (messages === undefined) return
    const renderer = this.rendererFor(sessionId)
    // 只读谓词：没有未评审的 assistant 增量则不渲染也不推进游标
    // （会话首条用户输入不触发——首轮评审发生在第一个 turn/end）
    if (!renderer.hasUnreviewedAssistant(messages)) return
    this.onSteppedTurnEnd?.(sessionId)
    // B10：排除触发输入（该输入进入下一轮增量）
    this.renderAndEmit(sessionId, { skipLast: true })
  }

  /** 渲染（增量或重建）并回调 onDelta。 */
  renderAndEmit(sessionId, options = {}) {
    const session = this.getSession(sessionId)
    if (session === undefined || typeof session.deriveMessages !== 'function') {
      this.logger.warn('advisor: session unavailable — delta skipped', { sessionId })
      return
    }
    let messages
    try {
      messages = session.deriveMessages()
    } catch (error) {
      this.logger.warn('advisor: deriveMessages threw — delta skipped', { sessionId, error })
      return
    }
    // B10：agentic 触发时排除"触发评审的下一轮用户输入"（skipLast）——
    // 该输入是下一轮的起点，不得进入本轮 delta；游标停在它之前
    const renderer = this.rendererFor(sessionId)
    const oldCursor = renderer.cursor
    const effective = options.skipLast ? messages.slice(0, -1) : messages
    const delta = renderer.render(effective)
    if (delta === undefined || delta === null) return
    // Q3 重构：本轮**新增**的可见条目（评审员持续会话按消息粒度追加；
    // 首次/重建 = 全部可见消息）
    const added = effective.slice(oldCursor)
    delta.entries = renderVisibleEntries(added.length > 0 ? added : effective)
    const meta = this.sessionMeta(sessionId) ?? {}
    this.onDelta(sessionId, delta, {
      sessionId,
      sessionName: meta.sessionName ?? null,
      workspace: meta.workspace ?? null,
    })
  }

  messagesOf(sessionId) {
    const session = this.getSession(sessionId)
    if (session === undefined || typeof session.deriveMessages !== 'function') return undefined
    try {
      return session.deriveMessages()
    } catch {
      return undefined
    }
  }

  rendererFor(sessionId) {
    let renderer = this.renderers.get(sessionId)
    if (renderer === undefined) {
      renderer = new SessionRenderer(this.maxMessages)
      const seed = this.pendingSeeds.get(sessionId)
      if (seed !== undefined) {
        renderer.seedTo(seed)
        this.pendingSeeds.delete(sessionId)
      }
      this.renderers.set(sessionId, renderer)
    }
    return renderer
  }

  /** 会话销毁：清理观察状态。 */
  disposeSession(sessionId) {
    this.renderers.delete(sessionId)
    this.pendingSeeds.delete(sessionId)
    this.turnEndSessions.delete(sessionId)
  }

  /** /advisor on 中途开启：seed 到当前长度（不全量回放）。 */
  seedTo(sessionId, length) {
    const renderer = this.renderers.get(sessionId)
    if (renderer === undefined) {
      this.pendingSeeds.set(sessionId, length)
      return
    }
    renderer.seedTo(length)
  }
}
