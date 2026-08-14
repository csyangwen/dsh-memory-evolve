/**
 * 会话评审悬浮面板。
 *
 * AdvisorHost 是唯一 slot 入口：它在会话 header 中渲染开合按钮，并把面板
 * createPortal 到 document.body，从而避开会话子树可能形成的 containing block。
 * AdvisorPanel 只负责五区 UI；数据与副作用全部由 advisor-store.ts 管理。
 */
import { Component, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  LEVEL_LABEL,
  type AdvisorConfig,
  type AdvisorScopes,
  type AdvisorHistoryFilters,
  type AdvisorNoteSeverity,
  type AdvisorReviewItem,
  type AdvisorRuntimeStatus,
  type AdvisorSeverity,
  type AdvisorSessionStore,
  type AdvisorStoreSnapshot,
  useAdvisorSessionStore,
} from './advisor-store.ts'

export type AdvisorHostProps = PropsRuntime<'conversation.session.header.actions'> & {
  /** index.ts 传入的插件 locale 翻译函数；面板主体按需求固定中文。 */
  t?: Translate
}

export interface AdvisorPanelProps {
  store: AdvisorSessionStore
  snapshot: AdvisorStoreSnapshot
  onCollapse: () => void
}

type PanelTab = 'scopes' | 'live' | 'history' | 'settings'

const STATUS_META: Record<AdvisorRuntimeStatus, { icon: string; label: string; cls: string }> = {
  disabled: { icon: '✖', label: '已停用', cls: 'advisor-status-disabled' },
  idle: { icon: '●', label: '空闲', cls: 'advisor-status-idle' },
  reviewing: { icon: '◐', label: '评审中', cls: 'advisor-status-reviewing' },
  quota_exhausted: { icon: '⏸', label: '已暂停', cls: 'advisor-status-paused' },
  halted: { icon: '⚠', label: '已终止', cls: 'advisor-status-halted' },
}

const SEVERITY_META: Record<AdvisorNoteSeverity, { label: string; cls: string }> = {
  // Q1：info 最低等级（默认仅记录不注入，面板照常展示）
  info: { label: 'info · 记录', cls: 'advisor-severity-info' },
  nit: { label: 'nit · 建议', cls: 'advisor-severity-nit' },
  concern: { label: 'concern · 关注', cls: 'advisor-severity-concern' },
  blocker: { label: 'blocker · 阻断', cls: 'advisor-severity-blocker' },
  // Q4：问答回复（用户提问的直接回答，非评审建议）
  answer: { label: '回答', cls: 'advisor-severity-answer' },
}

const OUTCOME_LABEL = {
  delivered: '已送达',
  // Q1：info 级默认仅记录（事件照发、面板可见，会话流不受打扰）
  recorded: '已记录',
  // Q4：问答回答已注入会话流
  answered: '已回答',
  suppressed: '已抑制',
  'no-note': '无建议',
  dropped: '已丢弃',
  failed: '评审失败',
  cancelled: '已取消',
} as const

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function formatClock(ts: number): string {
  const date = new Date(ts)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

function formatDateTime(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatClock(ts)}`
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function formatAgo(ts: number | null): string {
  if (ts === null) return '暂无活动'
  const delta = Math.max(0, Date.now() - ts)
  if (delta < 5_000) return '刚刚'
  if (delta < 60_000) return `${Math.floor(delta / 1_000)} 秒前`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  return `${Math.floor(delta / 3_600_000)} 小时前`
}

function shortSession(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 8)}…` : sessionId
}

function timeCutoff(range: AdvisorHistoryFilters['timeRange']): number | null {
  const day = 24 * 60 * 60 * 1_000
  if (range === '24h') return Date.now() - day
  if (range === '7d') return Date.now() - 7 * day
  if (range === '30d') return Date.now() - 30 * day
  return null
}

/**
 * strict-session slot 入口。窄屏初始折叠；桌面初始展开。header 与 body portal
 * 共用同一个 session store，因此双入口开合不会造成第二份轮询。
 */
export function AdvisorHost(props: AdvisorHostProps): JSX.Element {
  const sessionId = String(props.sessionId)
  const { store, snapshot } = useAdvisorSessionStore(sessionId)
  const [expanded, setExpanded] = useState(() => (
    typeof window === 'undefined' ? false : !window.matchMedia('(max-width: 767px)').matches
  ))
  // 2026-08-13 用户反馈：用户是否手动操作过面板（打开/收起）——未启用
  // 评审的会话刷新后默认不主动显示（面板收起、无悬浮胶囊）；用户手动
  // 点头部 toggle 后视为"点出来"，胶囊恢复显示
  const [userToggled, setUserToggled] = useState(false)
  const preferredExpanded = useRef(true)
  const manuallyExpanded = useRef(false)

  const panelEnabled = snapshot.config?.advisorPanelEnabled
    ?? snapshot.status?.panelEnabled
    ?? true

  // 2026-08-13 用户反馈（两轮迭代）：
  // 1. advisorEnabled 是模块**总闸**——总闸关闭时评审入口整体不渲染；
  //    status 未同步完成时用全局 config 兜底，避免刷新闪一下。
  // 2. 会话级开关只控制本会话是否评审，**不影响入口渲染**——会话级关闭
  //    后入口必须保留（否则用户无法再从面板把本会话开关打开；上一版把
  //    effectiveEnabled 当渲染条件引入了此回归）。
  const globalEnabled = snapshot.status?.defaultEnabled ?? (snapshot.config?.advisorEnabled === true)
  const enabled = snapshot.status?.effectiveEnabled ?? globalEnabled

  // 配置明确关闭面板时，首次加载自动收起；用户从 header 主动打开后仍可进入
  // 设置区恢复开关，避免“关闭后再也打不开”的死路。
  useEffect(() => {
    if (!panelEnabled && !userToggled) setExpanded(false)
  }, [panelEnabled, userToggled])

  // 2026-08-13 用户反馈：**本会话未启用评审时刷新页面不主动显示**——
  // status 同步后若 effectiveEnabled=false 且用户未手动操作过，自动收起
  // 面板（悬浮胶囊同样隐藏，见下方 portal 渲染条件）；用户手动点开后
  // 尊重用户选择，不再自动收起
  useEffect(() => {
    if (!enabled && !userToggled) setExpanded(false)
  }, [enabled, userToggled])

  // 窄屏自动收起仅是临时布局覆盖；返回桌面时恢复用户最后一次明确偏好。
  // 用户当前明确偏好展开时，后续进入窄屏不再强制折叠。
  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)')
    const onMediaChange = (event: MediaQueryListEvent): void => {
      if (!panelEnabled && !userToggled) {
        setExpanded(false)
        return
      }
      if (event.matches) {
        if (!manuallyExpanded.current) setExpanded(false)
        return
      }
      setExpanded(preferredExpanded.current)
    }

    mediaQuery.addEventListener('change', onMediaChange)
    return () => mediaQuery.removeEventListener('change', onMediaChange)
  }, [panelEnabled])

  useEffect(() => {
    store.setPanelVisible(expanded)
    return () => store.setPanelVisible(false)
  }, [expanded, store])

  const toggle = (): void => {
    setUserToggled(true)
    setExpanded((value) => {
      const next = !value
      preferredExpanded.current = next
      manuallyExpanded.current = next
      return next
    })
  }

  // 2026-08-12 用户反馈：悬浮按钮图标颜色反映评审状态——
  // disabled（灰）/ idle（绿）/ reviewing（蓝呼吸）/ quota·halted（橙红）
  const runtimeStatus = snapshot.status?.runtimeStatus ?? 'disabled'
  const capsuleStateClass = !enabled ? 'advisor-capsule-disabled'
    : runtimeStatus === 'reviewing' ? 'advisor-capsule-reviewing'
    : runtimeStatus === 'quota_exhausted' || runtimeStatus === 'halted' ? 'advisor-capsule-error'
    : 'advisor-capsule-idle'

  const headerTitle = panelEnabled
    ? (props.t?.('advisor.header.toggle.title') ?? '打开或折叠会话评审面板')
    : 'Advisor 面板显示已关闭；点击可打开设置'

  // 2026-08-13 用户反馈：设置 Tab 的「会话评审（Advisor）」是模块总闸——
  // **总闸关闭**时评审入口（头部按钮、悬浮胶囊、面板）整体不渲染，模块
  // 在界面上彻底消失；开启总闸后恢复。会话级关闭（override=false）只停
  // 本会话评审，入口照常保留（面板里可重新打开本会话开关）。
  // ⚠️ React 规则：本 early-return 位于所有 hooks 之后，不影响 hooks 顺序。
  if (!globalEnabled) return null

  const portal = typeof document === 'undefined' ? null : createPortal(
    expanded ? (
      <AdvisorPanel store={store} snapshot={snapshot} onCollapse={toggle} />
    ) : panelEnabled && (enabled || userToggled) ? (
      // 2026-08-13 用户反馈：悬浮胶囊默认不主动显示——本会话未启用评审
      // 且用户未手动操作过时隐藏（页面干净）；用户点头部 toggle 点开过
      // 面板（userToggled）或会话启用评审后，胶囊正常显示便于快速重开
      <button
        type="button"
        className={`advisor-capsule ${capsuleStateClass}`}
        onClick={toggle}
        aria-label="展开会话评审面板"
        title="展开会话评审面板"
      >
        <span className="advisor-capsule-icon" aria-hidden="true">◉</span>
        <span className="advisor-capsule-label">Advisor</span>
        {snapshot.unreadCount > 0 && (
          <span className="advisor-unread" aria-label={`${snapshot.unreadCount} 条未读评审`}>
            {snapshot.unreadCount > 99 ? '99+' : snapshot.unreadCount}
          </span>
        )}
      </button>
    ) : null,
    document.body,
  )

  return (
    <>
      <button
        type="button"
        className={`advisor-header-toggle${expanded ? ' advisor-header-toggle-active' : ''} ${capsuleStateClass}`}
        onClick={toggle}
        aria-expanded={expanded}
        aria-label={headerTitle}
        title={headerTitle}
      >
        <span aria-hidden="true">◉</span>
        <span>{props.t?.('advisor.header.toggle') ?? '会话评审'}</span>
        {snapshot.unreadCount > 0 && (
          <span className="advisor-header-unread" aria-hidden="true">
            {snapshot.unreadCount > 99 ? '99+' : snapshot.unreadCount}
          </span>
        )}
      </button>
      {portal}
    </>
  )
}

/** 面板本体：Header、状态条、实时/历史主区、指令区、设置 disclosure。 */
export function AdvisorPanel({ store, snapshot, onCollapse }: AdvisorPanelProps): JSX.Element {
  const [tab, setTab] = useState<PanelTab>('live')
  const [instruction, setInstruction] = useState('')
  const [pendingOpen, setPendingOpen] = useState(true)
  const [filters, setFilters] = useState<AdvisorHistoryFilters>(snapshot.recordsFilters)
  const [following, setFollowing] = useState(true)
  const flowRef = useRef<HTMLDivElement | null>(null)

  // 第一次进入历史 Tab 时加载；后续返回保留筛选和翻页结果。
  useEffect(() => {
    if (tab === 'history' && snapshot.records.length === 0 && !snapshot.recordsLoading) {
      void store.loadRecords(filters)
    }
  }, [tab])

  // 新卡片或 started→finished 补全后，只有在用户未上滚时才自动跟随到底部。
  useEffect(() => {
    if (tab !== 'live' || !following) return
    const node = flowRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [snapshot.reviews, tab, following])

  const onFlowScroll = (): void => {
    const node = flowRef.current
    if (node === null) return
    setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 28)
  }

  const identity = useMemo(() => {
    for (let i = snapshot.reviews.length - 1; i >= 0; i -= 1) {
      const item = snapshot.reviews[i]
      if (item.started !== null) {
        return { sessionName: item.started.sessionName, workspace: item.started.workspace }
      }
      if (item.record !== null) {
        return { sessionName: item.record.sessionName, workspace: item.record.workspace }
      }
    }
    return { sessionName: null, workspace: null }
  }, [snapshot.reviews])

  // Q3 重构：最近的评审员会话代数与上下文条数（取自最新 started 的输入快照）
  const latestEpoch = useMemo(() => {
    for (let i = snapshot.reviews.length - 1; i >= 0; i -= 1) {
      const epoch = snapshot.reviews[i].started?.input?.epoch
      if (epoch !== undefined) return epoch
    }
    return null
  }, [snapshot.reviews])
  const latestContextCount = useMemo(() => {
    // 2026-08-12 用户反馈：优先 status 实时统计（含评审员自己的输出/指令）
    if (snapshot.status?.conversationStats !== null && snapshot.status?.conversationStats !== undefined) {
      return snapshot.status.conversationStats.messageCount
    }
    for (let i = snapshot.reviews.length - 1; i >= 0; i -= 1) {
      const count = snapshot.reviews[i].started?.input?.contextCount
      if (count !== undefined) return count
    }
    return 0
  }, [snapshot.reviews])
  /** 评审员会话已占用上下文（字符数估算，用于决定是否新建评审会话）。
   * 2026-08-13 用户反馈：旧实现 Math.round(charCount/1000) 会把 <500
   * 字符直接显示成 "≈0 K"（4 条消息几百字符 → 0 K，不直观）——改为
   * <1K 显示具体字数，≥1K 显示 K（<10K 保留一位小数）。 */
  const contextChars = useMemo(() => {
    const stats = snapshot.status?.conversationStats
    if (stats === null || stats === undefined) return null
    const k = stats.charCount / 1000
    if (k < 1) return `${stats.charCount} 字`
    return `${k >= 10 ? Math.round(k) : k.toFixed(1)} K`
  }, [snapshot.status?.conversationStats])

  const status = snapshot.status?.runtimeStatus ?? 'disabled'
  const statusMeta = STATUS_META[status]
  // 2026-08-12 用户反馈：owner 优先用 status 兜底（评审卡片未产生时
  // 也能显示会话名/工作空间），再回退评审卡片的 identity
  const ownerLabel = `${snapshot.status?.sessionName ?? identity.sessionName ?? shortSession(snapshot.sessionId)} · ${snapshot.status?.workspace ?? identity.workspace ?? '工作空间未知'}`
  const workspaceOptions = useMemo(() => {
    const values = new Set<string>()
    for (const record of snapshot.records) {
      if (record.workspace !== null && record.workspace !== '') values.add(record.workspace)
    }
    for (const item of snapshot.reviews) {
      const value = item.started?.workspace ?? item.record?.workspace
      if (value !== null && value !== undefined && value !== '') values.add(value)
    }
    return [...values]
  }, [snapshot.records, snapshot.reviews])

  const visibleRecords = useMemo(() => {
    const cutoff = timeCutoff(filters.timeRange)
    return cutoff === null ? snapshot.records : snapshot.records.filter((record) => record.ts >= cutoff)
  }, [snapshot.records, filters.timeRange])

  const submitInstruction = async (): Promise<void> => {
    const text = instruction.trim()
    if (text === '') return
    await store.sendInstruction(text)
    if (store.getSnapshot().instructionsError === null) setInstruction('')
  }

  const onInstructionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submitInstruction()
    }
  }

  return (
    <aside className="advisor-panel" aria-label="会话评审悬浮面板">
      <header className="advisor-panel-header">
        <div className="advisor-panel-heading">
          <div className="advisor-title-row">
            <strong className="advisor-title">会话评审</strong>
            <span className={`advisor-status-badge ${statusMeta.cls}`} title={snapshot.status?.phase || statusMeta.label}>
              <span className="advisor-status-icon" aria-hidden="true">{statusMeta.icon}</span>
              {statusMeta.label}
            </span>
          </div>
          <div className="advisor-owner" title={ownerLabel}>{ownerLabel}</div>
        </div>
        <button type="button" className="advisor-icon-button" onClick={onCollapse} aria-label="折叠 Advisor 面板" title="折叠">
          —
        </button>
      </header>

      <section className="advisor-status-strip" aria-label="Advisor 运行状态">
        <button
          type="button"
          role="switch"
          aria-checked={snapshot.status?.effectiveEnabled ?? false}
          className={`advisor-switch${snapshot.status?.effectiveEnabled ? ' advisor-switch-on' : ''}`}
          disabled={snapshot.statusLoading || snapshot.status === null}
          onClick={() => void store.toggleSession(!(snapshot.status?.effectiveEnabled ?? false))}
          title="仅切换当前会话；不会修改全局默认开关"
        >
          <span className="advisor-switch-track"><span className="advisor-switch-thumb" /></span>
          <span>{snapshot.status?.effectiveEnabled ? '本会话已启用' : '本会话未启用'}</span>
        </button>
        <div className="advisor-status-facts">
          <span className="advisor-model" title={`${snapshot.status?.provider ?? '—'} / ${snapshot.status?.model ?? '—'}`}>
            {snapshot.status?.model ?? '模型未解析'}
          </span>
          <span>{formatAgo(snapshot.lastActivityAt)}</span>
          {(snapshot.status?.pendingCount ?? 0) > 0 && (
            <span className="advisor-pending-count">pending {snapshot.status?.pendingCount}</span>
          )}
        </div>
      </section>

      {snapshot.status?.gateStatus !== undefined && snapshot.status.gateStatus !== 'ok' && (
        <div className="advisor-warning" role="status">
          模型门禁未通过：{snapshot.status.disabledReason ?? (snapshot.status.gateStatus === 'config-incomplete'
            ? 'provider/model 必须同时填写或同时留空'
            : '当前会话模型不可用')}
        </div>
      )}
      {snapshot.statusError !== null && (
        <ErrorNotice text={`状态加载失败：${snapshot.statusError}`} onRetry={() => void store.refreshStatus()} />
      )}
      {snapshot.notice !== null && (
        <div className={`advisor-notice advisor-notice-${snapshot.notice.kind}`} role="status">
          <span>{snapshot.notice.text}</span>
          <button type="button" className="advisor-notice-close" onClick={() => store.clearNotice()} aria-label="关闭提示">×</button>
        </div>
      )}

      <div className="advisor-tabs" role="tablist" aria-label="评审数据视图">
        {/* 2026-08-12 用户拍板：约束 Tab 放最前——对本会话评审员的层级约束 */}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'scopes'}
          className={`advisor-tab${tab === 'scopes' ? ' advisor-tab-active' : ''}`}
          onClick={() => setTab('scopes')}
        >
          约束
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'live'}
          className={`advisor-tab${tab === 'live' ? ' advisor-tab-active' : ''}`}
          onClick={() => setTab('live')}
        >
          实时
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'history'}
          className={`advisor-tab${tab === 'history' ? ' advisor-tab-active' : ''}`}
          onClick={() => setTab('history')}
        >
          记录
        </button>
        {/* 2026-08-12 用户反馈：设置移入独立 Tab（交互统一） */}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'settings'}
          className={`advisor-tab${tab === 'settings' ? ' advisor-tab-active' : ''}`}
          onClick={() => setTab('settings')}
        >
          设置
        </button>
      </div>

      {tab === 'scopes' ? (
        <ScopesErrorBoundary>
          <ScopesTab store={store} snapshot={snapshot} />
        </ScopesErrorBoundary>
      ) : tab === 'live' ? (
        /* 2026-08-12 用户反馈：指令区（发指令/新建评审会话）只在实时 tab 显示 */
        <div className="advisor-live">
        <section ref={flowRef} className="advisor-flow" onScroll={onFlowScroll} aria-label="实时评审流">
          {snapshot.eventsError !== null && (
            <ErrorNotice text={`实时流加载失败：${snapshot.eventsError}`} onRetry={() => store.resetCursorAndLive()} />
          )}
          {snapshot.eventsLoading && snapshot.reviews.length === 0 && <LoadingBlock text="正在连接 Advisor 实时流…" />}
          {!snapshot.eventsLoading && snapshot.reviews.length === 0 && snapshot.eventsError === null && (
            <div className="advisor-empty">
              {snapshot.status?.effectiveEnabled
                ? '暂无评审活动。新的评审会在这里实时出现。'
                : '未启用：可使用上方会话开关，或在下方设置中开启 Advisor。'}
            </div>
          )}
          {snapshot.reviews.map((item, index) => (
            <ReviewCard
              key={item.reviewId}
              item={item}
              defaultInputOpen={index === snapshot.reviews.length - 1}
            />
          ))}
          {!following && (
            <button
              type="button"
              className="advisor-follow-button"
              onClick={() => {
                setFollowing(true)
                const node = flowRef.current
                if (node !== null) node.scrollTop = node.scrollHeight
              }}
            >
              回到最新
            </button>
          )}
        </section>
                <section className="advisor-instructions" aria-label="Advisor 指令区">
        <div className="advisor-instruction-compose">
        <textarea
        className="advisor-textarea advisor-instruction-input"
        rows={2}
        maxLength={2_000}
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        onKeyDown={onInstructionKeyDown}
        placeholder="给会话评审发指令…（Enter 发送，Shift+Enter 换行）"
        />
        <button
        type="button"
        className="advisor-button advisor-button-primary"
        disabled={snapshot.instructionMutating || instruction.trim() === ''}
        onClick={() => void submitInstruction()}
        >
        发送
        </button>
        </div>
        <div className="advisor-steer-hint">
        评审建议按严重度实时送达（nit/concern/blocker 走 steer，info 默认仅记录）；
        指令框提问会立即触发 Advisor 回答并注入会话流。
        </div>
        {/* Q3 重构：评审员会话管理——上下文统计 + 新建评审会话 */}
        <div className="advisor-conversation-bar">
        <span className="advisor-conversation-stats" title="评审员持续会话已占用的上下文（字符数估算，中文 1 字≈1 token；对比模型上下文窗口判断是否新建评审会话）">
        {latestEpoch !== null ? `评审会话 #${latestEpoch}` : '评审会话'} · 上下文 {latestContextCount} 条
        {contextChars !== null && ` · ≈${contextChars}`}
        </span>
        <button
        type="button"
        className="advisor-new-conversation"
        disabled={snapshot.instructionMutating}
        onClick={() => {
        if (window.confirm('新建评审会话将清空评审员的全部上下文与记忆（评审员从零开始）。\n确认后可在第一条指令中告知背景信息。')) {
        void store.resetConversation()
        }
        }}
        title="清空评审员持续会话（上下文+记忆），从零开始；适合换任务/控制上下文长度"
        >
        🔄 新建评审会话
        </button>
        </div>
        <button
        type="button"
        className="advisor-pending-toggle"
        aria-expanded={pendingOpen}
        onClick={() => setPendingOpen((value) => !value)}
        >
        <span>待消费指令 ({snapshot.pending.length})</span>
        <span aria-hidden="true">{pendingOpen ? '▴' : '▾'}</span>
        </button>
        {pendingOpen && (
        <div className="advisor-pending-list">
        {snapshot.instructionsLoading && <span className="advisor-muted">加载中…</span>}
        {!snapshot.instructionsLoading && snapshot.pending.length === 0 && (
        <span className="advisor-muted">暂无待消费指令</span>
        )}
        {snapshot.pending.map((item) => (
        <div key={item.id} className="advisor-pending-item">
        <span className="advisor-pending-state">{item.state === 'reserved' ? '消费中' : '待消费'}</span>
        <span className="advisor-pending-text" title={item.text}>{item.text}</span>
        </div>
        ))}
        {snapshot.pending.length > 0 && (
        <button
        type="button"
        className="advisor-link advisor-link-danger"
        disabled={snapshot.instructionMutating}
        onClick={() => void store.clearInstructions()}
        >
        清空待消费指令
        </button>
        )}
        </div>
        )}
        {snapshot.instructionsError !== null && (
        <div className="advisor-inline-error">
        {snapshot.instructionsError}
        <button type="button" className="advisor-link" onClick={() => void store.refreshInstructions()}>重试</button>
        </div>
        )}
        </section>
        </div>
      ) : tab === 'settings' ? (
        /* 2026-08-12 用户反馈：会话评审设置移入独立 Tab（交互统一） */
        <SettingsDisclosure store={store} snapshot={snapshot} />
      ) : (
        <section className="advisor-history" aria-label="历史评审记录">
          <div className="advisor-history-filters">
            <select
              className="advisor-select"
              value={filters.session}
              onChange={(event) => setFilters({ ...filters, session: event.target.value as 'current' | 'all' })}
              aria-label="会话筛选"
            >
              <option value="current">当前会话</option>
              <option value="all">全部会话</option>
            </select>
            <select
              className="advisor-select"
              value={filters.severity}
              onChange={(event) => setFilters({ ...filters, severity: event.target.value as '' | AdvisorNoteSeverity })}
              aria-label="严重度筛选"
            >
              <option value="">全部严重度</option>
              <option value="info">info</option>
              <option value="nit">nit</option>
              <option value="concern">concern</option>
              <option value="blocker">blocker</option>
              <option value="answer">回答</option>
            </select>
            <select
              className="advisor-select"
              value={filters.timeRange}
              onChange={(event) => setFilters({ ...filters, timeRange: event.target.value as AdvisorHistoryFilters['timeRange'] })}
              aria-label="时间筛选"
            >
              <option value="all">全部时间</option>
              <option value="24h">最近 24 小时</option>
              <option value="7d">最近 7 天</option>
              <option value="30d">最近 30 天</option>
            </select>
            <div className="advisor-workspace-filter">
              <input
                className="advisor-input"
                list="advisor-workspaces"
                value={filters.workspace}
                onChange={(event) => setFilters({ ...filters, workspace: event.target.value })}
                placeholder="工作空间（可选）"
                aria-label="工作空间筛选"
              />
              <datalist id="advisor-workspaces">
                {workspaceOptions.map((workspace) => <option key={workspace} value={workspace} />)}
              </datalist>
              <button type="button" className="advisor-button" onClick={() => void store.loadRecords(filters)}>
                查询
              </button>
            </div>
          </div>
          {snapshot.recordsError !== null && (
            <ErrorNotice text={`历史加载失败：${snapshot.recordsError}`} onRetry={() => void store.loadRecords(filters)} />
          )}
          {snapshot.recordsLoading && snapshot.records.length === 0 && <LoadingBlock text="正在加载历史记录…" />}
          {!snapshot.recordsLoading && visibleRecords.length === 0 && snapshot.recordsError === null && (
            <div className="advisor-empty">当前筛选下暂无评审记录。</div>
          )}
          <div className="advisor-history-list">
            {visibleRecords.map((record, index) => (
              <ReviewCard
                key={record.reviewId}
                item={{ reviewId: record.reviewId, started: null, finished: null, record, arrivedAt: 0 }}
                defaultInputOpen={index === 0}
                history
              />
            ))}
          </div>
          {snapshot.recordsHasMore && (
            <button
              type="button"
              className="advisor-button advisor-load-more"
              disabled={snapshot.recordsLoading}
              onClick={() => void store.loadRecords(snapshot.recordsFilters, true)}
            >
              {snapshot.recordsLoading ? '加载中…' : '加载更多'}
            </button>
          )}
        </section>
      )}

    </aside>
  )
}

function ReviewCard(props: {
  item: AdvisorReviewItem
  defaultInputOpen: boolean
  history?: boolean
}): JSX.Element {
  const { item, history = false } = props
  const [inputOpen, setInputOpen] = useState(props.defaultInputOpen)
  useEffect(() => setInputOpen(props.defaultInputOpen), [props.defaultInputOpen])

  const terminal = item.finished ?? item.record
  const ts = item.started?.ts ?? terminal?.ts ?? 0
  const note = terminal?.note ?? null
  const severity = note === null ? null : SEVERITY_META[note.severity]
  const inProgress = terminal === null
  const identity = item.started === null && item.record !== null
    ? `${item.record.sessionName ?? shortSession(item.record.sessionId)} · ${item.record.workspace ?? '工作空间未知'}`
    : null

  return (
    <article
      className={`advisor-review-card${inProgress ? ' advisor-review-card-running' : ''}${history ? ' advisor-review-card-history' : ''}`}
      tabIndex={0}
      aria-label={`会话评审 ${item.reviewId}`}
    >
      <div className="advisor-review-meta">
        <time dateTime={new Date(ts).toISOString()} title={formatDateTime(ts)}>{history ? formatDateTime(ts) : formatClock(ts)}</time>
        {severity !== null && <span className={`advisor-severity ${severity.cls}`}>{severity.label}</span>}
        {terminal !== null && <span>{formatElapsed(terminal.elapsedMs)}</span>}
        {terminal?.delivery === 'steer' && <span className="advisor-delivery">已送达 ✓</span>}
        {terminal?.delivery === 'inject' && <span className="advisor-delivery">已注入 ✓</span>}
        {terminal !== null && terminal.delivery === null && <span>{OUTCOME_LABEL[terminal.outcome]}</span>}
      </div>

      {identity !== null && <div className="advisor-record-owner" title={identity}>{identity}</div>}

      {(terminal?.instructions.length ?? 0) > 0 && (
        <div className="advisor-consumed-instructions">
          <span className="advisor-instruction-tag">📋 执行指令 ×{terminal?.instructions.length}</span>
          {terminal?.instructions.map((text, index) => (
            <span key={`${index}-${text}`} className="advisor-consumed-text" title={text}>{text}</span>
          ))}
        </div>
      )}

      {item.started !== null ? (
        <div className="advisor-input-block">
          <button
            type="button"
            className="advisor-input-summary"
            aria-expanded={inputOpen}
            onClick={() => setInputOpen((value) => !value)}
          >
            {/* Q3 重构：上下文统计（历史条数 + 会话代数）+ 本轮增量条数 */}
            <span>
              会话 #{item.started.input.epoch} · 上下文 {item.started.input.contextCount} 条
              {item.started.input.mode === 'qa' ? ' · 问答' : ` · 本轮 ${item.started.input.messageCount} 条`}
            </span>
            <span aria-hidden="true">{inputOpen ? '收起 ▴' : '展开 ▾'}</span>
          </button>
          {inputOpen && <pre className="advisor-input-markdown">{item.started.input.markdown}</pre>}
        </div>
      ) : history ? (
        <div className="advisor-input-unavailable">历史终态记录不包含输入快照</div>
      ) : null}

      {inProgress ? (
        <div className="advisor-reviewing" aria-live="polite">
          <span>评审中…</span>
          <span className="advisor-skeleton-line" />
          <span className="advisor-skeleton-line advisor-skeleton-line-short" />
        </div>
      ) : note !== null ? (
        <div className="advisor-note">
          {/* 2026-08-12 用户反馈：说明"已抑制"含义（闸门拦截、未注入主会话） */}
          {terminal?.outcome === 'suppressed' && (
            <div className="advisor-note-meta">已抑制：此条建议被闸门拦截（去重 / 空泛抑制 / 每轮一条），未注入主会话</div>
          )}
          {note.text}
        </div>
      ) : (
        <div className="advisor-outcome-empty">{OUTCOME_LABEL[terminal.outcome]}</div>
      )}

      {terminal?.error !== null && terminal?.error !== undefined && (
        <div className="advisor-card-error">
          {terminal.error.code}：{terminal.error.message}
          {terminal.error.retryable && <span>（可重试）</span>}
        </div>
      )}
    </article>
  )
}

/**
 * 约束区错误边界（2026-08-12 用户反馈：约束 Tab 抛错曾导致整个弹窗被
 * DSH 的 SlotErrorBoundary 移除）。这里兜底：约束区域出错只显示错误条，
 * 面板其余部分（实时/记录/指令区）不受影响；错误详情打印到 console。
 */
class ScopesErrorBoundary extends Component<{ children: ReactNode }, { failed: string | null }> {
  override state: { failed: string | null } = { failed: null }

  static getDerivedStateFromError(error: unknown): { failed: string | null } {
    return { failed: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown): void {
    console.error('advisor scopes tab crashed:', error)
  }

  override render(): ReactNode {
    if (this.state.failed !== null) {
      return (
        <section className="advisor-scopes" aria-label="评审员约束">
          <div className="advisor-card-error">约束区域渲染出错：{this.state.failed}（详见浏览器控制台）</div>
        </section>
      )
    }
    return this.props.children
  }
}

/**
 * 约束 Tab（2026-08-12 用户拍板四层级）：从上往下 = 本次评审会话约束 /
 * 本会话约束 / 本项目约束。每个输入框多行（可同时放多条指令），保存后
 * 下次评审立即生效（后端动态拼接，无需重建）。
 * 生命周期：评审会话约束随「新建评审会话」清空；会话/项目约束持久化。
 */
function ScopesTab({ store, snapshot }: {
  store: AdvisorSessionStore
  snapshot: AdvisorStoreSnapshot
}): JSX.Element {
  const [draft, setDraft] = useState<AdvisorScopes | null>(null)

  useEffect(() => {
    if (snapshot.scopes === null) return
    setDraft({
      global: { text: snapshot.scopes.global.text },
      project: { workspace: snapshot.scopes.project.workspace, text: snapshot.scopes.project.text },
      session: { text: snapshot.scopes.session.text },
      conversation: { text: snapshot.scopes.conversation.text },
    })
  }, [snapshot.scopes])

  if (draft === null) {
    return (
      <section className="advisor-scopes" aria-label="评审员约束">
        {snapshot.scopesLoading && <LoadingBlock text="正在加载约束…" />}
        {snapshot.scopesError !== null && (
          <ErrorNotice text={`约束加载失败：${snapshot.scopesError}`} onRetry={() => void store.refreshScopes()} />
        )}
      </section>
    )
  }

  const save = (level: 'global' | 'project' | 'session' | 'conversation', text: string): void => {
    void store.saveScope(level, text)
  }

  return (
    <section className="advisor-scopes" aria-label="评审员约束">
      {snapshot.scopesError !== null && (
        <ErrorNotice text={`约束保存失败：${snapshot.scopesError}`} onRetry={() => void store.refreshScopes()} />
      )}
      <div className="advisor-scope-hint">
        四层级约束拼接进评审员系统提示词（冲突时越局部越优先）；保存后立即生效。
      </div>

      {/* 第 4 层：本次评审会话约束（新建评审会话即清空） */}
      <ScopeField
        label={`${LEVEL_LABEL.conversation}（随「新建评审会话」清空）`}
        value={draft.conversation.text}
        placeholder="只对本次评审会话生效…（可多行，多条指令一次写）"
        saving={snapshot.scopesSaving}
        onSave={(text) => save('conversation', text)}
      />

      {/* 第 3 层：本会话约束（跨新建评审会话保留） */}
      <ScopeField
        label={`${LEVEL_LABEL.session}（本会话一直有效）`}
        value={draft.session.text}
        placeholder="只对本会话生效…"
        saving={snapshot.scopesSaving}
        onSave={(text) => save('session', text)}
      />

      {/* 第 2 层：本项目约束（本工作区所有会话共享） */}
      <ScopeField
        label={`${LEVEL_LABEL.project}（工作区 ${draft.project.workspace ?? '未知'} 的所有会话共享）`}
        value={draft.project.text}
        placeholder="对本项目所有会话生效…"
        saving={snapshot.scopesSaving}
        onSave={(text) => save('project', text)}
      />

      {/* 第 0 层：全局约束（所有项目所有会话生效）——2026-08-12 用户拍板：
          系统提示词一般不改，全局约束词是日常层 */}
      <ScopeField
        label={`${LEVEL_LABEL.global}（所有项目、所有会话都生效）`}
        value={draft.global.text}
        placeholder="对所有项目所有会话生效…（如：评审意见一律用中文、不要重复已提过的建议）"
        saving={snapshot.scopesSaving}
        onSave={(text) => save('global', text)}
      />
    </section>
  )
}

/** 单层约束输入框（多行 + 保存按钮）。 */
function ScopeField(props: {
  label: string
  value: string
  placeholder: string
  saving: boolean
  onSave: (text: string) => void
}): JSX.Element {
  const [value, setValue] = useState(props.value)
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    setValue(props.value)
    setDirty(false)
  }, [props.value])

  return (
    <label className="advisor-scope-field">
      <span className="advisor-scope-label">{props.label}</span>
      <textarea
        className="advisor-textarea advisor-scope-textarea"
        rows={4}
        maxLength={4_000}
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
          setDirty(true)
        }}
        placeholder={props.placeholder}
      />
      <button
        type="button"
        className="advisor-button advisor-scope-save"
        disabled={props.saving || (!dirty && value === props.value)}
        onClick={() => props.onSave(value)}
      >
        {props.saving ? '保存中…' : '保存'}
      </button>
    </label>
  )
}

function SettingsDisclosure({ store, snapshot }: {
  store: AdvisorSessionStore
  snapshot: AdvisorStoreSnapshot
}): JSX.Element {
  const [draft, setDraft] = useState<Pick<AdvisorConfig,
    'advisorProvider' | 'advisorModel' | 'advisorSystemPrompt' | 'advisorPanelEnabled'
    | 'advisorInfoInject'
  > | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (snapshot.config === null) return
    setDraft({
      advisorProvider: snapshot.config.advisorProvider,
      advisorModel: snapshot.config.advisorModel,
      advisorSystemPrompt: snapshot.config.advisorSystemPrompt,
      advisorPanelEnabled: snapshot.config.advisorPanelEnabled,
      advisorInfoInject: snapshot.config.advisorInfoInject,
    })
  }, [snapshot.config])

  const save = async (): Promise<void> => {
    if (draft === null) return
    const provider = draft.advisorProvider?.trim() ?? ''
    const model = draft.advisorModel?.trim() ?? ''
    if ((provider === '') !== (model === '')) {
      setLocalError('provider 与 model 必须同时填写，或同时留空以继承会话模型。')
      return
    }
    // Q5：提示词与内置默认相同 → 存 ''（等价内置，未来升级默认提示词自动跟随）；
    // 不同 → 存自定义（下次评审立即生效）
    const defaultPrompt = snapshot.config?.defaultSystemPrompt ?? ''
    const prompt = draft.advisorSystemPrompt.trim() === '' || draft.advisorSystemPrompt.trim() === defaultPrompt.trim()
      ? ''
      : draft.advisorSystemPrompt
    setLocalError(null)
    await store.saveConfig({
      ...draft,
      advisorProvider: provider === '' ? null : provider,
      advisorModel: model === '' ? null : model,
      advisorSystemPrompt: prompt,
    })
  }

  return (
    /* 2026-08-12 用户反馈：设置默认直接显示（去掉 details 折叠箭头） */
    <div className="advisor-settings">
      <div className="advisor-settings-title">会话评审设置</div>
      <div className="advisor-settings-body">
        {/* 2026-08-14 用户拍板：总闸开关收敛到 Memory Evolve 设置 Tab（此处
            曾与其重复）；面板设置只保留本模块的运行参数，不再重复总闸。 */}
        <div className="advisor-muted">模块总闸（启用/停用）在「Memory Evolve 设置」Tab 的配置区控制</div>
        {snapshot.configLoading && draft === null && <LoadingBlock text="正在加载设置…" />}
        {snapshot.configError !== null && (
          <ErrorNotice text={`设置加载失败：${snapshot.configError}`} onRetry={() => void store.refreshConfig()} />
        )}
        {draft !== null && (
          <>
            <div className="advisor-settings-switches">
              <label className="advisor-check-row">
                <input
                  type="checkbox"
                  checked={draft.advisorPanelEnabled}
                  onChange={(event) => setDraft({ ...draft, advisorPanelEnabled: event.target.checked })}
                />
                <span>显示悬浮面板</span>
              </label>
              {/* Q1：info 级建议默认仅记录不注入（面板可见、会话流零打扰） */}
              <label className="advisor-check-row" title="info 是最低等级建议：默认只记录不注入会话；开启后以注入（非打断）方式送达">
                <input
                  type="checkbox"
                  checked={draft.advisorInfoInject}
                  onChange={(event) => setDraft({ ...draft, advisorInfoInject: event.target.checked })}
                />
                <span>info 级建议也注入会话</span>
              </label>
            </div>
            <div className="advisor-settings-grid">
              <label className="advisor-field">
                <span>供应商（Provider）</span>
                <input
                  className="advisor-input"
                  value={draft.advisorProvider ?? ''}
                  onChange={(event) => setDraft({ ...draft, advisorProvider: event.target.value })}
                  placeholder="留空则继承会话"
                />
              </label>
              <label className="advisor-field">
                <span>模型（Model）</span>
                <input
                  className="advisor-input"
                  value={draft.advisorModel ?? ''}
                  onChange={(event) => setDraft({ ...draft, advisorModel: event.target.value })}
                  placeholder="留空则继承会话"
                />
              </label>
            </div>
            {/* Q5：提示词——空配置时回填显示内置默认全文，可编辑保存（=自定义），可一键恢复默认 */}
            <label className="advisor-field">
              <span>
                评审系统提示词
                <span className="advisor-prompt-mode">
                  {draft.advisorSystemPrompt === '' ? '（使用内置默认提示词，编辑后保存即为自定义）' : '（自定义）'}
                </span>
              </span>
              <textarea
                className="advisor-textarea advisor-prompt-textarea"
                rows={22}
                maxLength={8_192}
                value={draft.advisorSystemPrompt === '' ? (snapshot.config?.defaultSystemPrompt ?? '') : draft.advisorSystemPrompt}
                onChange={(event) => setDraft({ ...draft, advisorSystemPrompt: event.target.value })}
                placeholder="留空使用内置评审提示词"
              />
              <button
                type="button"
                className="advisor-link"
                disabled={draft === null || snapshot.configSaving}
                onClick={() => {
                  // 2026-08-13 用户反馈：恢复默认按钮不可点（配置为空时
                  // 禁用）。改为**始终可点**——点击即保存空配置（空=使用
                  // 内置默认）并立即生效；saveConfig 会刷新 config，
                  // 输入框随即显示 API 返回的最新内置默认提示词
                  void (async () => {
                    setDraft({ ...draft, advisorSystemPrompt: '' })
                    await store.saveConfig({ advisorSystemPrompt: '' })
                  })()
                }}
                title="恢复为内置默认提示词（保存后立即生效，输入框显示最新内置默认）"
              >
                恢复默认提示词
              </button>
            </label>
            <div className="advisor-settings-hint">
              全局默认开关不会清除当前会话 override；会话级启停请使用上方状态条。
            </div>
            {(localError ?? snapshot.configError) !== null && (
              <div className="advisor-inline-error">{localError ?? snapshot.configError}</div>
            )}
            <button
              type="button"
              className="advisor-button advisor-button-primary advisor-settings-save"
              disabled={snapshot.configSaving}
              onClick={() => void save()}
            >
              {snapshot.configSaving ? '保存中…' : '保存设置'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function ErrorNotice({ text, onRetry }: { text: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="advisor-error" role="alert">
      <span>{text}</span>
      <button type="button" className="advisor-link" onClick={onRetry}>重试</button>
    </div>
  )
}

function LoadingBlock({ text }: { text: string }): JSX.Element {
  return (
    <div className="advisor-loading" role="status">
      <span className="advisor-loading-dot" aria-hidden="true" />
      <span>{text}</span>
    </div>
  )
}