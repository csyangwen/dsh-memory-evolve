/**
 * Advisor 悬浮面板的数据层。
 *
 * 这里刻意把轮询、游标、请求取消、started→finished 合并、gap 重建和写操作
 * 全部收拢到一个 session 级外部 store 中。React 组件只订阅快照并发出动作，
 * 不自行保存第二份服务端状态，避免面板折叠/Tab 切换后出现数据分叉。
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'

/** index.ts 将 DSH 的 connection/reset 桥接为这个浏览器事件。 */
export const ADVISOR_CONNECTION_RESET_EVENT = 'dsh-memory-evolve:advisor-connection-reset'

const API = '/memory-evolve/api/advisor'

/** 约束层级显示名（面板约束 Tab）。 */
export const LEVEL_LABEL: Record<'global' | 'project' | 'session' | 'conversation', string> = {
  conversation: '本次评审会话约束',
  session: '本会话约束',
  project: '本项目约束',
  global: '全局约束',
}
const POLL_MS = 1_000
const LIVE_LIMIT = 100
const LIVE_REVIEW_LIMIT = 100
const RECORDS_PAGE_SIZE = 50

export type AdvisorSeverity = 'info' | 'nit' | 'concern' | 'blocker'
/** note 的 severity：评审建议四档；问答回复为 'answer'（Q4）。 */
export type AdvisorNoteSeverity = AdvisorSeverity | 'answer'
export type AdvisorOutcome = 'delivered' | 'recorded' | 'answered' | 'suppressed' | 'no-note' | 'dropped' | 'failed' | 'cancelled'
export type AdvisorRuntimeStatus = 'disabled' | 'idle' | 'reviewing' | 'quota_exhausted' | 'halted'

export interface AdvisorNote {
  severity: AdvisorNoteSeverity
  text: string
}

export interface AdvisorErrorDetail {
  code: string
  message: string
  retryable: boolean
}

export interface AdvisorInput {
  messageCount: number
  charCount: number
  markdown: string
  /** Q4：问答评审的输入为"用户问题"（mode='qa'），无可见表面。 */
  mode?: 'qa'
  /** Q3 重构：评审员持续会话上下文统计（历史消息条数 / 会话代数）。 */
  contextCount: number
  epoch: number
}

export interface AdvisorReviewStarted {
  seq: number
  type: 'review-started'
  reviewId: string
  ts: number
  sessionId: string
  sessionName: string | null
  workspace: string | null
  input: AdvisorInput
}

export interface AdvisorReviewFinished {
  seq: number
  type: 'review-finished'
  reviewId: string
  ts: number
  sessionId: string
  outcome: AdvisorOutcome
  /** Q1/Q4：投递通道——steer（实时打断）/ inject（注入不打断）；recorded/失败为 null */
  delivery: 'steer' | 'inject' | null
  note: AdvisorNote | null
  elapsedMs: number
  instructions: string[]
  error: AdvisorErrorDetail | null
}

export interface AdvisorRuntimeEvent {
  seq: number
  type: 'runtime-status'
  ts: number
  sessionId: string
  runtimeStatus: AdvisorRuntimeStatus
  pendingCount: number
  phase: string
}

export type AdvisorLiveEvent = AdvisorReviewStarted | AdvisorReviewFinished | AdvisorRuntimeEvent

/**
 * 冻结契约中的历史记录是 finished 终态同构数据：没有 seq，也不承诺 input。
 * 因而历史卡片只能在 host 真正返回的字段范围内展示，不在前端臆造输入快照。
 */
export interface AdvisorReviewRecord {
  type: 'review-finished'
  reviewId: string
  ts: number
  sessionId: string
  sessionName: string | null
  workspace: string | null
  outcome: AdvisorOutcome
  delivery: 'steer' | 'inject' | null
  note: AdvisorNote | null
  elapsedMs: number
  instructions: string[]
  error: AdvisorErrorDetail | null
}

export interface AdvisorStatus {
  defaultEnabled: boolean
  override: boolean | null
  effectiveEnabled: boolean
  /** 2026-08-12 用户反馈：owner 展示兜底（评审卡片未产生时也能显示） */
  sessionName: string | null
  workspace: string | null
  /** 评审员持续会话占用（消息条数 + 字符数，估算 K） */
  conversationStats: { messageCount: number; charCount: number } | null
  gateStatus: 'ok' | 'config-incomplete' | 'session-model-unavailable'
  provider: string | null
  model: string | null
  /** 复审中7：门禁未通过时为 null（前端类型必须允许） */
  routeSource: 'configured' | 'session' | null
  runtimeStatus: AdvisorRuntimeStatus
  phase: string
  /** 复审中7：host 契约为 0/1（当前是否有评审在飞，非队列长度） */
  inFlight: number
  pendingCount: number
  panelEnabled: boolean
  disabledReason?: string
}

/** 2026-08-12 用户拍板五层约束：全局/项目/会话/评审会话（+设置里的系统提示词）。 */
export interface AdvisorScopes {
  global: { text: string }
  project: { workspace: string | null; text: string }
  session: { text: string }
  conversation: { text: string }
}

export interface AdvisorInstruction {
  id: string
  createdAt: number
  text: string
  state: 'pending' | 'reserved' | 'consumed'
}

export interface AdvisorConfig {
  advisorEnabled: boolean
  advisorProvider: string | null
  advisorModel: string | null
  advisorSystemPrompt: string
  /** Q5：内置默认评审提示词全文（空配置时前端回填显示）。 */
  defaultSystemPrompt: string
  advisorPanelEnabled: boolean
  advisorImmuneTurns: number
  advisorSteerSeverities: AdvisorSeverity[]
  /** Q1：info 级是否注入（默认 false=仅记录不注入）。 */
  advisorInfoInject: boolean
  advisorMaxMessages: number
  advisorMaxQueued: number
  advisorCallTimeoutMs: number
}

/** 实时列表的一行：started 与 finished 按 reviewId 合并后的视图模型。 */
export interface AdvisorReviewItem {
  reviewId: string
  started: AdvisorReviewStarted | null
  finished: AdvisorReviewFinished | null
  /** gap 重建出来的终态记录；与 live finished 分开，避免伪造 seq。 */
  record: AdvisorReviewRecord | null
  /** 浏览器收到该卡片的时间，只用于新卡片入场高亮。 */
  arrivedAt: number
}

export interface AdvisorHistoryFilters {
  session: 'current' | 'all'
  workspace: string
  /** 复审低10：answer（问答回复）也纳入严重度筛选 */
  severity: '' | AdvisorSeverity | 'answer'
  timeRange: 'all' | '24h' | '7d' | '30d'
}

export interface AdvisorStoreSnapshot {
  sessionId: string
  status: AdvisorStatus | null
  statusLoading: boolean
  statusError: string | null
  reviews: AdvisorReviewItem[]
  eventsLoading: boolean
  eventsError: string | null
  pending: AdvisorInstruction[]
  instructionsLoading: boolean
  instructionsError: string | null
  instructionMutating: boolean
  records: AdvisorReviewRecord[]
  recordsLoading: boolean
  recordsError: string | null
  recordsHasMore: boolean
  recordsCursor: string | null
  recordsFilters: AdvisorHistoryFilters
  config: AdvisorConfig | null
  configLoading: boolean
  configError: string | null
  configSaving: boolean
  scopes: AdvisorScopes | null
  scopesLoading: boolean
  scopesError: string | null
  scopesSaving: boolean
  unreadCount: number
  panelVisible: boolean
  lastActivityAt: number | null
  notice: { kind: 'ok' | 'error'; text: string } | null
}

const DEFAULT_FILTERS: AdvisorHistoryFilters = {
  session: 'current',
  workspace: '',
  severity: '',
  timeRange: 'all',
}

function initialSnapshot(sessionId: string): AdvisorStoreSnapshot {
  return {
    sessionId,
    status: null,
    statusLoading: true,
    statusError: null,
    reviews: [],
    eventsLoading: true,
    eventsError: null,
    pending: [],
    instructionsLoading: true,
    instructionsError: null,
    instructionMutating: false,
    records: [],
    recordsLoading: false,
    recordsError: null,
    recordsHasMore: false,
    recordsCursor: null,
    recordsFilters: DEFAULT_FILTERS,
    config: null,
    configLoading: true,
    configError: null,
    configSaving: false,
    scopes: null,
    scopesLoading: true,
    scopesError: null,
    scopesSaving: false,
    unreadCount: 0,
    panelVisible: false,
    lastActivityAt: null,
    notice: null,
  }
}

/** 与 CoIView 一致的统一请求封装：优先显示 host 的冻结错误体 error。 */
async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const body = (await res.json().catch(() => ({}))) as {
    error?: string
    message?: string
    code?: string
  }
  if (!res.ok) throw new Error(body.error ?? body.message ?? body.code ?? `HTTP ${res.status}`)
  return body as T
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return fetchJson<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

function patchJson<T>(path: string, body: unknown): Promise<T> {
  return fetchJson<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
}

function deleteJson<T>(path: string): Promise<T> {
  return fetchJson<T>(path, { method: 'DELETE' })
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.trim() === '' ? '操作失败（无错误详情）' : text
}

function recordsPath(
  sessionId: string,
  filters: AdvisorHistoryFilters,
  before?: string | null,
  limit = RECORDS_PAGE_SIZE,
): string {
  const params = new URLSearchParams()
  if (filters.session === 'current') params.set('sessionId', sessionId)
  if (filters.workspace.trim() !== '') params.set('workspace', filters.workspace.trim())
  if (filters.severity !== '') params.set('severity', filters.severity)
  if (before !== undefined && before !== null && before !== '') params.set('before', before)
  params.set('limit', String(limit))
  return `/records?${params.toString()}`
}

/** 将 records 的 finished 终态转换为实时区可复用的卡片模型。 */
function recordToReview(record: AdvisorReviewRecord): AdvisorReviewItem {
  return {
    reviewId: record.reviewId,
    started: null,
    finished: null,
    record,
    arrivedAt: Date.now(),
  }
}

/**
 * 一个 AdvisorSessionStore 对应一个 strict-session header entry。
 * 所有可变状态都通过不可变 snapshot 发布，useSyncExternalStore 因此能可靠比较引用。
 */
export class AdvisorSessionStore {
  private snapshot: AdvisorStoreSnapshot
  private readonly listeners = new Set<() => void>()
  private started = false
  private generation = 0
  private cursor = 0
  private pollTimer: number | null = null
  private pollAbort: AbortController | null = null
  private recordsAbort: AbortController | null = null
  /** reset 后首次 after=0 是重放而非新到达，不能把旧卡片重复计入未读。 */
  private suppressUnreadUntilSynced = false

  constructor(sessionId: string) {
    this.snapshot = initialSnapshot(sessionId)
  }

  /** useSyncExternalStore 所需的稳定函数引用。 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): AdvisorStoreSnapshot => this.snapshot

  private patch(patch: Partial<AdvisorStoreSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** 启动首屏数据和约 1 秒事件轮询；重复调用是幂等的。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.installBrowserResetListeners()
    void this.refreshAll()
    this.schedulePoll(0)
  }

  /** 卸载/切 session 时取消旧请求与定时器，防止旧会话响应污染新面板。 */
  stop(): void {
    if (!this.started) return
    this.started = false
    this.generation += 1
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer)
    this.pollTimer = null
    this.pollAbort?.abort()
    this.pollAbort = null
    this.recordsAbort?.abort()
    this.recordsAbort = null
    this.removeBrowserResetListeners()
  }

  private readonly handleConnectionReset = (): void => {
    this.resetCursorAndLive('连接已恢复，正在重新同步 Advisor 事件…')
  }

  private installBrowserResetListeners(): void {
    window.addEventListener(ADVISOR_CONNECTION_RESET_EVENT, this.handleConnectionReset)
    window.addEventListener('online', this.handleConnectionReset)
  }

  private removeBrowserResetListeners(): void {
    window.removeEventListener(ADVISOR_CONNECTION_RESET_EVENT, this.handleConnectionReset)
    window.removeEventListener('online', this.handleConnectionReset)
  }

  /**
   * connection/reset、重新联网、页面重新可见都从 after=0 重新对齐。
   * generation fence 与 AbortController 双保险：即使浏览器晚交付旧 Promise，也不会落库。
   */
  resetCursorAndLive(notice?: string): void {
    this.generation += 1
    this.cursor = 0
    this.suppressUnreadUntilSynced = true
    this.pollAbort?.abort()
    this.pollAbort = null
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer)
    this.pollTimer = null
    this.patch({
      reviews: [],
      eventsLoading: true,
      eventsError: null,
      lastActivityAt: null,
      ...(notice === undefined ? {} : { notice: { kind: 'ok' as const, text: notice } }),
    })
    if (this.started) {
      void this.refreshStatus()
      void this.refreshInstructions()
      this.schedulePoll(0)
    }
  }

  private schedulePoll(delay: number): void {
    if (!this.started) return
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer)
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null
      void this.pollEvents()
    }, delay)
  }

  private async pollEvents(): Promise<void> {
    if (!this.started) return
    // 每轮创建新 controller，并先取消可能残留的旧请求。
    this.pollAbort?.abort()
    const controller = new AbortController()
    this.pollAbort = controller
    const generation = this.generation
    const sessionId = this.snapshot.sessionId
    const params = new URLSearchParams({
      sessionId,
      after: String(this.cursor),
      limit: String(LIVE_LIMIT),
    })
    try {
      const data = await fetchJson<{ events: AdvisorLiveEvent[]; nextCursor: number; gap: boolean }>(
        `/events?${params.toString()}`,
        { signal: controller.signal },
      )
      if (!this.started || controller.signal.aborted || generation !== this.generation) return

      let rebuildSucceeded = true
      if (data.gap) {
        // 游标落后 ring：先用终态 records 重建基线，再叠加本次 live 事件。
        rebuildSucceeded = await this.rebuildLiveFromRecords(generation, controller.signal)
        if (!this.started || controller.signal.aborted || generation !== this.generation) return
      }
      this.cursor = data.nextCursor
      this.mergeLiveEvents(data.events)
      this.suppressUnreadUntilSynced = false
      this.patch({ eventsLoading: false, ...(rebuildSucceeded ? { eventsError: null } : {}) })
    } catch (error) {
      if (!controller.signal.aborted && generation === this.generation) {
        this.patch({ eventsLoading: false, eventsError: errorText(error) })
      }
    } finally {
      if (this.pollAbort === controller) this.pollAbort = null
      if (this.started && generation === this.generation) this.schedulePoll(POLL_MS)
    }
  }

  /** gap 重建只写实时区，不覆盖用户正在浏览的历史 Tab 查询结果。 */
  private async rebuildLiveFromRecords(generation: number, signal: AbortSignal): Promise<boolean> {
    const filters: AdvisorHistoryFilters = { ...DEFAULT_FILTERS, session: 'current' }
    try {
      const data = await fetchJson<{ records: AdvisorReviewRecord[]; nextCursor: string | null; hasMore: boolean }>(
        recordsPath(this.snapshot.sessionId, filters, null, LIVE_REVIEW_LIMIT),
        { signal },
      )
      if (!this.started || generation !== this.generation) return false
      // records 是 ts 倒序；实时流要求最新在底部，故反转为正序。
      const rebuilt = [...data.records].reverse().map(recordToReview)
      this.patch({ reviews: rebuilt.slice(-LIVE_REVIEW_LIMIT) })
      return true
    } catch (error) {
      if (generation !== this.generation) return false
      // 重建失败时仍让后续 live 事件进入，错误明确展示并允许用户重试。
      this.patch({ reviews: [], eventsError: `实时游标已过期，历史重建失败：${errorText(error)}` })
      return false
    }
  }

  /**
   * review-started 先建卡；review-finished 用 reviewId 原位补全。
   * runtime-status 不生成卡片，只更新状态条。重复 seq/重复 reviewId 都是幂等的。
   */
  private mergeLiveEvents(events: AdvisorLiveEvent[]): void {
    if (events.length === 0) return
    const reviews = [...this.snapshot.reviews]
    const index = new Map(reviews.map((item, i) => [item.reviewId, i]))
    let status = this.snapshot.status
    let unreadCount = this.snapshot.unreadCount
    let lastActivityAt = this.snapshot.lastActivityAt
    let consumedInstructions = false

    for (const event of events) {
      lastActivityAt = Math.max(lastActivityAt ?? 0, event.ts)
      if (event.type === 'runtime-status') {
        if (status !== null) {
          status = {
            ...status,
            runtimeStatus: event.runtimeStatus,
            pendingCount: event.pendingCount,
            phase: event.phase,
            inFlight: event.runtimeStatus === 'reviewing',
          }
        }
        continue
      }

      if (event.type === 'review-finished' && event.instructions.length > 0) {
        consumedInstructions = true
      }

      const position = index.get(event.reviewId)
      if (position === undefined) {
        const item: AdvisorReviewItem = {
          reviewId: event.reviewId,
          started: event.type === 'review-started' ? event : null,
          finished: event.type === 'review-finished' ? event : null,
          record: null,
          arrivedAt: Date.now(),
        }
        reviews.push(item)
        index.set(event.reviewId, reviews.length - 1)
        if (!this.snapshot.panelVisible && !this.suppressUnreadUntilSynced) unreadCount += 1
      } else {
        const old = reviews[position]
        reviews[position] = {
          ...old,
          started: event.type === 'review-started' ? event : old.started,
          finished: event.type === 'review-finished' ? event : old.finished,
          // started 自带归属与输入，可替换 gap record；若只补到 finished，则保留
          // record 的 sessionName/workspace，卡片仍优先展示更新鲜的 live 终态。
          record: event.type === 'review-started' ? null : old.record,
        }
      }
    }

    this.patch({
      reviews: reviews.slice(-LIVE_REVIEW_LIMIT),
      status,
      unreadCount: this.snapshot.panelVisible ? 0 : unreadCount,
      lastActivityAt,
    })
    if (consumedInstructions) void this.refreshInstructions()
  }

  async refreshAll(): Promise<void> {
    await Promise.allSettled([
      this.refreshStatus(),
      this.refreshInstructions(),
      this.refreshConfig(),
      this.refreshScopes(),
    ])
  }

  async refreshStatus(): Promise<void> {
    const sessionId = this.snapshot.sessionId
    this.patch({ statusLoading: true, statusError: null })
    try {
      const status = await fetchJson<AdvisorStatus>(`/status?sessionId=${encodeURIComponent(sessionId)}`)
      if (sessionId !== this.snapshot.sessionId) return
      this.patch({ status, statusLoading: false, statusError: null })
    } catch (error) {
      if (sessionId !== this.snapshot.sessionId) return
      this.patch({ statusLoading: false, statusError: errorText(error) })
    }
  }

  async refreshInstructions(): Promise<void> {
    const sessionId = this.snapshot.sessionId
    this.patch({ instructionsLoading: true, instructionsError: null })
    try {
      const data = await fetchJson<{ pending: AdvisorInstruction[] }>(
        `/instructions?sessionId=${encodeURIComponent(sessionId)}`,
      )
      if (sessionId !== this.snapshot.sessionId) return
      this.patch({ pending: data.pending, instructionsLoading: false, instructionsError: null })
    } catch (error) {
      if (sessionId !== this.snapshot.sessionId) return
      this.patch({ instructionsLoading: false, instructionsError: errorText(error) })
    }
  }

  async sendInstruction(text: string): Promise<void> {
    const trimmed = text.trim()
    if (trimmed === '') return
    this.patch({ instructionMutating: true, instructionsError: null })
    try {
      const data = await postJson<{ pending: AdvisorInstruction[] }>('/instructions', {
        sessionId: this.snapshot.sessionId,
        text: trimmed,
      })
      this.patch({
        pending: data.pending,
        instructionMutating: false,
        // Q4：指令入队后立即触发问答评审（回答注入会话流），不再是"等待下一轮"
        notice: { kind: 'ok', text: '指令已发送，Advisor 正在回答（回答会直接注入会话流）' },
      })
    } catch (error) {
      this.patch({
        instructionMutating: false,
        instructionsError: errorText(error),
        notice: { kind: 'error', text: errorText(error) },
      })
    }
  }

  /** Q3 重构：新建评审会话（清空评审员上下文 + 去重记忆，epoch 自增）。 */
  async resetConversation(): Promise<void> {
    this.patch({ instructionMutating: true, instructionsError: null })
    try {
      const data = await postJson<{ epoch: number }>('/conversation/reset', {
        sessionId: this.snapshot.sessionId,
      })
      this.patch({
        instructionMutating: false,
        notice: { kind: 'ok', text: `已新建评审会话（#${data.epoch}）——可在第一条指令中告知评审员背景信息` },
      })
      // 2026-08-13 用户反馈：新建评审会话后实时流应清空（旧评审活动属于
      // 上一评审会话，已落盘 records.jsonl 在「记录」Tab 可查）——重置
      // 游标从 after=0 重新同步，后端已清该会话 live ring，只会拉到新
      // 评审会话的事件
      this.resetCursorAndLive()
    } catch (error) {
      this.patch({
        instructionMutating: false,
        instructionsError: errorText(error),
        notice: { kind: 'error', text: errorText(error) },
      })
    }
  }

  async clearInstructions(): Promise<void> {
    this.patch({ instructionMutating: true, instructionsError: null })
    try {
      const data = await deleteJson<{ cleared: number }>(
        `/instructions?sessionId=${encodeURIComponent(this.snapshot.sessionId)}`,
      )
      await this.refreshInstructions()
      this.patch({
        instructionMutating: false,
        notice: { kind: 'ok', text: `已清空 ${data.cleared} 条待消费指令` },
      })
    } catch (error) {
      this.patch({
        instructionMutating: false,
        instructionsError: errorText(error),
        notice: { kind: 'error', text: errorText(error) },
      })
    }
  }

  /** 会话级开关：只写 override，不改全局 advisorEnabled。 */
  async toggleSession(enabled: boolean): Promise<void> {
    this.patch({ statusLoading: true, statusError: null })
    try {
      const status = await postJson<AdvisorStatus>('/toggle', {
        sessionId: this.snapshot.sessionId,
        enabled,
      })
      this.patch({
        status,
        statusLoading: false,
        notice: { kind: 'ok', text: enabled ? '本会话 Advisor 已启用' : '本会话 Advisor 已停用' },
      })
    } catch (error) {
      this.patch({
        statusLoading: false,
        statusError: errorText(error),
        notice: { kind: 'error', text: errorText(error) },
      })
    }
  }

  async refreshConfig(): Promise<void> {
    this.patch({ configLoading: true, configError: null })
    try {
      const data = await fetchJson<{ config: AdvisorConfig }>('/config')
      this.patch({ config: data.config, configLoading: false, configError: null })
    } catch (error) {
      this.patch({ configLoading: false, configError: errorText(error) })
    }
  }

  async saveConfig(patch: Partial<AdvisorConfig>): Promise<void> {
    this.patch({ configSaving: true, configError: null })
    try {
      const data = await patchJson<{ config: AdvisorConfig }>('/config', { patch })
      this.patch({
        config: data.config,
        configSaving: false,
        notice: { kind: 'ok', text: 'Advisor 设置已保存并生效' },
      })
      await this.refreshStatus()
    } catch (error) {
      this.patch({
        configSaving: false,
        configError: errorText(error),
        notice: { kind: 'error', text: errorText(error) },
      })
    }
  }

  /** 四层级约束读取（项目/会话/评审会话）。 */
  async refreshScopes(): Promise<void> {
    const sessionId = this.snapshot.sessionId
    this.patch({ scopesLoading: true, scopesError: null })
    try {
      const data = await fetchJson<{ scopes: AdvisorScopes }>(
        `/scopes?sessionId=${encodeURIComponent(sessionId)}`,
      )
      if (sessionId !== this.snapshot.sessionId) return
      this.patch({ scopes: data.scopes, scopesLoading: false, scopesError: null })
    } catch (error) {
      if (sessionId !== this.snapshot.sessionId) return
      this.patch({ scopesLoading: false, scopesError: errorText(error) })
    }
  }

  /** 保存某层约束（空文本=清除该层）。 */
  async saveScope(level: 'global' | 'project' | 'session' | 'conversation', text: string): Promise<void> {
    this.patch({ scopesSaving: true, scopesError: null })
    try {
      const data = await fetchJson<{ scopes: AdvisorScopes }>('/scopes', {
        method: 'PUT',
        body: JSON.stringify({ sessionId: this.snapshot.sessionId, level, text }),
      })
      this.patch({
        scopes: data.scopes,
        scopesSaving: false,
        notice: { kind: 'ok', text: `${LEVEL_LABEL[level]}已保存，下次评审立即生效` },
      })
    } catch (error) {
      this.patch({
        scopesSaving: false,
        scopesError: errorText(error),
        notice: { kind: 'error', text: errorText(error) },
      })
    }
  }

  /** 新筛选从第一页加载；“加载更多”严格使用响应的 before=reviewId 游标。 */
  async loadRecords(filters: AdvisorHistoryFilters, append = false): Promise<void> {
    this.recordsAbort?.abort()
    const controller = new AbortController()
    this.recordsAbort = controller
    const before = append ? this.snapshot.recordsCursor : null
    this.patch({
      recordsLoading: true,
      recordsError: null,
      recordsFilters: filters,
      ...(append ? {} : { records: [], recordsCursor: null, recordsHasMore: false }),
    })
    try {
      const data = await fetchJson<{ records: AdvisorReviewRecord[]; nextCursor: string | null; hasMore: boolean }>(
        recordsPath(this.snapshot.sessionId, filters, before),
        { signal: controller.signal },
      )
      if (controller.signal.aborted) return
      const merged = append ? [...this.snapshot.records, ...data.records] : data.records
      // before 分页正常不会重复；仍以 reviewId 去重，抵抗翻页期间新记录插入。
      const unique = [...new Map(merged.map((record) => [record.reviewId, record])).values()]
      this.patch({
        records: unique,
        recordsLoading: false,
        recordsError: null,
        recordsCursor: data.nextCursor,
        recordsHasMore: data.hasMore,
      })
    } catch (error) {
      if (!controller.signal.aborted) {
        this.patch({ recordsLoading: false, recordsError: errorText(error) })
      }
    } finally {
      if (this.recordsAbort === controller) this.recordsAbort = null
    }
  }

  setPanelVisible(visible: boolean): void {
    this.patch({ panelVisible: visible, ...(visible ? { unreadCount: 0 } : {}) })
  }

  clearNotice(): void {
    if (this.snapshot.notice !== null) this.patch({ notice: null })
  }
}

/** React 绑定：sessionId 变化即创建新 store，旧 store 的请求在 cleanup 中全部取消。 */
export function useAdvisorSessionStore(sessionId: string): {
  store: AdvisorSessionStore
  snapshot: AdvisorStoreSnapshot
} {
  const store = useMemo(() => new AdvisorSessionStore(sessionId), [sessionId])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  // 轮询启停（稳定版复审 P1-1）：config 明确关闭总闸（advisorEnabled=false）
  // 时停掉 1s 事件轮询——status 恒不可用，空转浪费请求；config 未知时先
  // 轮询（总闸可能开着，且 status.defaultEnabled 才是权威值），config 到位
  // 后若总闸关则 stop（stop 幂等；started=false 后 start 可重入，用户重开
  // 总闸时 config 变化触发本 effect，轮询自动恢复）。
  useEffect(() => {
    const totalOff = snapshot.config !== null && snapshot.config.advisorEnabled !== true
    if (totalOff) store.stop()
    else store.start()
    return () => store.stop()
  }, [store, snapshot.config])
  return { store, snapshot }
}
