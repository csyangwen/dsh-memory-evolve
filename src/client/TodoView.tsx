/**
 * dsh-memory-evolve — todo sub-tab（待办）。
 *
 * 四轨待办管理器：生活 / 工作 / 项目（按工作目录隔离）/ 每日（按天）。
 * 支持两种视图：
 *   - 列表（list）：原有纵向列表 + 状态/象限筛选 + 行内编辑
 *   - 看板（board）：艾森豪威尔四象限四宫格，卡片按象限归位
 *
 * 数据均来自宿主 /memory-evolve/api/todo；样式复用 styles.css 的 me-/mt- 前缀。
 * 看板与列表共用同一套操作路径（完成/恢复、编辑、删除、快速添加），仅展示层不同。
 */
import { Fragment, useCallback, useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** 四条待办轨。 */
type TodoTarget = 'life' | 'work' | 'project' | 'daily'

/** 轨筛选：'all' 显示全部轨；'past' 仅显示过往每日。 */
type TodoTargetFilter = TodoTarget | 'all' | 'past'

/**
 * 展示视图模式：
 * - list：纵向列表（默认）
 * - board：四象限看板
 */
type TodoViewMode = 'list' | 'board'

/** 四象限标识（q1~q4）。 */
type QuadrantId = 'q1' | 'q2' | 'q3' | 'q4'

/** GET /api/todo 返回的单条待办。 */
interface TodoItem {
  id: string
  time: string
  /** 存储侧象限；null 表示未写 quadrant 标签。 */
  quadrant: string | null
  due: string | null
  status: string
  doneAt: string | null
  cat: string | null
  text: string
  target: TodoTarget
  /** daily 条目所属日期（今天或过往某天）。 */
  day?: string
  /** 过往 daily 条目（今天之前）。 */
  past?: boolean
  /**
   * 可选：重要/紧急布尔（宿主当前 API 通常不返回；
   * 若将来扩展或中间层注入，看板可据此在无 quadrant 时推断）。
   */
  important?: boolean
  urgent?: boolean
}

/** Locale-bound props。 */
export interface TodoViewProps {
  t: Translate
  sessionId: string
}

/** 轨页签顺序。 */
const TARGETS: TodoTarget[] = ['life', 'work', 'project', 'daily']

/** 已结束状态（完成/取消），快速视图中默认隐藏。 */
const DONE_STATUSES = new Set(['done', 'cancelled'])

/** 看板四宫格的固定顺序：左上 q1、右上 q2、左下 q3、右下 q4。 */
const BOARD_QUADRANTS: QuadrantId[] = ['q1', 'q2', 'q3', 'q4']

/**
 * 跨重挂持久化的视图模式（模块级）。
 * badge 刷新等导致组件重挂时，恢复用户上次选的「列表/看板」。
 */
let persistedViewMode: TodoViewMode | null = null

/** 统一请求宿主 API（/memory-evolve 前缀）。 */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/memory-evolve${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

/** 象限文案（q1..q4）；null = 未分类。 */
function quadrantLabel(t: Translate, quadrant: string | null): string {
  if (quadrant === null) return t('todo.quadrant.none')
  return t(`todo.quadrant.${quadrant}`)
}

/**
 * 解析条目归属象限（看板归位 + 展示用）。
 *
 * 规则（与需求一致）：
 * 1. 已有合法 quadrant（q1~q4）→ 直接使用；
 * 2. 否则按 important/urgent 推断：
 *    重要+紧急=q1，重要不紧急=q2，紧急不重要=q3，都不=q4。
 *
 * 注意：宿主 list 当前一般只返回 quadrant 字段；important/urgent 为扩展兼容。
 * 无 quadrant 且无布尔标记时按「都不」落入 q4，避免看板丢条目。
 */
function resolveItemQuadrant(item: TodoItem): QuadrantId {
  if (
    item.quadrant === 'q1'
    || item.quadrant === 'q2'
    || item.quadrant === 'q3'
    || item.quadrant === 'q4'
  ) {
    return item.quadrant
  }
  const important = item.important === true
  const urgent = item.urgent === true
  if (important && urgent) return 'q1'
  if (important && !urgent) return 'q2'
  if (!important && urgent) return 'q3'
  return 'q4'
}

/** 状态文案键：pending / doing / done / blocked / cancelled。 */
function statusLabel(t: Translate, status: string): string {
  const key = `todo.status.${status}`
  const label = t(key)
  // 未知状态时 locale 可能回落为 key 本身，直接展示原始 status
  return label === key ? status : label
}

/** 'YYYY-MM-DD' → '8月5日'（过往分组标题）。 */
function dayLabel(day: string): string {
  const [, month, date] = day.split('-')
  return `${Number(month)}月${Number(date)}日`
}

/**
 * 待办主视图：轨页签、筛选栏、快速添加、列表 / 四象限看板。
 * 每次变更后重新 load 当前轨数据。
 */
export function TodoView(props: TodoViewProps): JSX.Element {
  const { t, sessionId } = props
  const [target, setTarget] = useState<TodoTargetFilter>('all')
  /** 添加时的目标轨：全部视图下由用户选（缺省按 cwd 判定）；单轨视图固定当前轨。 */
  const [addTarget, setAddTarget] = useState<TodoTarget>('work')
  const [items, setItems] = useState<TodoItem[] | null>(null)
  const [cwd, setCwd] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'done'>('active')
  const [quadFilter, setQuadFilter] = useState<string>('all')
  /** 显示已过期的过往待办（默认 false：过往遗留默认不显示，不增加信息负担）。 */
  const [showExpired, setShowExpired] = useState(false)
  /** 列表 / 看板视图切换（默认列表；跨重挂用模块级持久化）。 */
  const [viewMode, setViewMode] = useState<TodoViewMode>(persistedViewMode ?? 'list')
  /** 快速添加框草稿。 */
  const [draft, setDraft] = useState('')
  const [draftQuad, setDraftQuad] = useState<string>('')
  const [draftDue, setDraftDue] = useState('')
  /** 行内编辑中的条目 id（null = 未在编辑）。 */
  const [editId, setEditId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editQuad, setEditQuad] = useState<string>('')
  const [editDue, setEditDue] = useState('')
  const [editStatus, setEditStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  // 视图模式跨重挂持久化
  useEffect(() => {
    persistedViewMode = viewMode
  }, [viewMode])

  const load = useCallback((): void => {
    setItems(null)
    const params = new URLSearchParams({ sessionId, all: '1' })
    if (target === 'past') params.set('target', 'daily')
    else if (target !== 'all') params.set('target', target)
    // 按需读取历史：只有点开「过往」页签，或「全部」视图勾选「显示已过期」时
    // 才请求 past（默认不读任何历史文件，零额外开销）
    const wantPast = target === 'past' || (target === 'all' && showExpired)
    if (wantPast) {
      params.set('past', '1')
      if (showExpired) params.set('expired', '1')
    }
    // 状态/象限筛选在前端做（all 视图需要跨轨过滤；active = 未完成的所有状态）
    void api<{ items: TodoItem[]; cwd: string | null }>(`/api/todo?${params.toString()}`)
      .then((res) => {
        setItems(res.items)
        setCwd(res.cwd)
        // 全部视图下添加默认轨跟随 cwd（与 dtodo 工具缺省一致）
        setAddTarget((prev) => {
          if (target !== 'all') return prev
          return res.cwd ? 'project' : 'work'
        })
      })
      .catch((error: Error) => setNotice({ kind: 'error', text: error.message }))
  }, [sessionId, target, showExpired])

  useEffect(() => {
    load()
  }, [load])

  /** 短暂成功提示。 */
  const flash = (text: string): void => {
    setNotice({ kind: 'ok', text })
    window.setTimeout(() => {
      setNotice((current) => (current?.text === text ? null : current))
    }, 3000)
  }

  /** 快速添加：用户口述直写（用户即确认者）。 */
  const addTodo = (): void => {
    const content = draft.trim()
    if (content === '' || busy) return
    setBusy(true)
    const addTrack = target === 'all' ? addTarget : target
    void api<{ ok: boolean; id: string }>('/api/todo', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        action: 'add',
        target: addTrack,
        content,
        quadrant: draftQuad === '' ? undefined : draftQuad,
        due: draftDue === '' ? undefined : draftDue,
      }),
    }).then(() => {
      setDraft('')
      setDraftQuad('')
      setDraftDue('')
      load()
      flash(t('todo.added'))
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: error.message })
    }).finally(() => setBusy(false))
  }

  /** 完成 / 恢复（列表与看板共用）。 */
  const toggleDone = (item: TodoItem): void => {
    if (busy) return
    setBusy(true)
    const done = !DONE_STATUSES.has(item.status)
    void api<{ ok: boolean }>('/api/todo', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        action: done ? 'done' : 'update',
        target: item.target,
        id: item.id,
        status: 'pending',
      }),
    }).then(() => {
      load()
      flash(done ? t('todo.done') : t('todo.undone'))
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: error.message })
    }).finally(() => setBusy(false))
  }

  /** 删除（确认后；列表与看板共用）。 */
  const removeTodo = (item: TodoItem): void => {
    if (busy) return
    const snippet = item.text.split('\n')[0].slice(0, 40)
    if (!window.confirm(t('todo.deleteConfirm', { snippet }))) return
    setBusy(true)
    void api<{ ok: boolean }>('/api/todo', {
      method: 'POST',
      body: JSON.stringify({ sessionId, action: 'remove', target: item.target, id: item.id }),
    }).then(() => {
      load()
      flash(t('todo.deleted'))
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: error.message })
    }).finally(() => setBusy(false))
  }

  /** 开始行内编辑。 */
  const startEdit = (item: TodoItem): void => {
    setEditId(item.id)
    setEditDraft(item.text)
    setEditQuad(item.quadrant ?? '')
    setEditDue(item.due ?? '')
    setEditStatus(item.status)
  }

  /** 保存行内编辑。 */
  const saveEdit = (item: TodoItem): void => {
    if (busy) return
    setBusy(true)
    void api<{ ok: boolean }>('/api/todo', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        action: 'update',
        target: item.target,
        id: item.id,
        content: editDraft.trim(),
        quadrant: editQuad === '' ? undefined : editQuad,
        due: editDue === '' ? undefined : editDue,
        status: editStatus,
      }),
    }).then(() => {
      setEditId(null)
      load()
      flash(t('todo.updated'))
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: error.message })
    }).finally(() => setBusy(false))
  }

  /**
   * 看板卡片上快捷切换状态（pending→doing→done→blocked→cancelled→pending 循环）。
   * 走与行内编辑相同的 update 路径，不另开 API。
   */
  const cycleStatus = (item: TodoItem): void => {
    if (busy) return
    const order = ['pending', 'doing', 'done', 'blocked', 'cancelled']
    const idx = order.indexOf(item.status)
    const next = order[(idx + 1) % order.length] ?? 'pending'
    setBusy(true)
    void api<{ ok: boolean }>('/api/todo', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        action: 'update',
        target: item.target,
        id: item.id,
        status: next,
      }),
    }).then(() => {
      load()
      flash(t('todo.updated'))
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: error.message })
    }).finally(() => setBusy(false))
  }

  /** 今天（本地），用于逾期标红。 */
  const today = new Date().toISOString().slice(0, 10)

  /** 前端筛选：状态（active=未完成全部状态）+ 象限 + 过往视图只看过往条目。 */
  const visible = (items ?? []).filter((item) => {
    if (target === 'past' && item.past !== true) return false
    if (statusFilter === 'active' && DONE_STATUSES.has(item.status)) return false
    if (statusFilter === 'done' && !DONE_STATUSES.has(item.status)) return false
    if (quadFilter === 'none' && item.quadrant !== null) return false
    if (quadFilter !== 'all' && quadFilter !== 'none' && item.quadrant !== quadFilter) return false
    return true
  })

  /** 过往条目按日期分组（倒序，后端已排序）；非过往条目单列一组。 */
  const groups: { day: string | null; items: TodoItem[] }[] = []
  for (const item of visible) {
    const day = item.past === true ? item.day ?? null : null
    const last = groups[groups.length - 1]
    if (day !== null && last !== undefined && last.day === day) last.items.push(item)
    else groups.push({ day, items: [item] })
  }

  /**
   * 看板：按解析后的象限分桶。
   * 注意：列表筛选仍用存储侧 quadrant（含 none）；看板归位用 resolveItemQuadrant。
   */
  const boardBuckets: Record<QuadrantId, TodoItem[]> = {
    q1: [],
    q2: [],
    q3: [],
    q4: [],
  }
  for (const item of visible) {
    boardBuckets[resolveItemQuadrant(item)].push(item)
  }

  /** 渲染单条卡片的元信息徽标区（轨 / 日期 / 截止 / 分类 / 状态）。 */
  const renderMetaBadges = (item: TodoItem, opts?: { showQuad?: boolean }): JSX.Element => {
    const done = DONE_STATUSES.has(item.status)
    const overdue = item.due !== null && item.due < today && !done
    return (
      <>
        {target === 'all' && (
          <span className="me-badge me-badge-target">
            {item.past === true ? t('todo.track.past') : t(`todo.track.${item.target}`)}
          </span>
        )}
        {item.past === true && target !== 'all' && (
          <span className="me-badge me-badge-day">{dayLabel(item.day ?? '')}</span>
        )}
        {opts?.showQuad === true && (
          <span className={`me-badge me-badge-quad me-badge-quad-${item.quadrant ?? 'none'}`}>
            {quadrantLabel(t, item.quadrant)}
          </span>
        )}
        {item.due !== null && (
          <span className={`me-badge ${overdue ? 'me-badge-overdue' : 'me-badge-due'}`}>
            {overdue ? `${t('todo.overdue')} ${item.due}` : `${t('todo.due')} ${item.due}`}
          </span>
        )}
        {item.cat !== null && <span className="me-badge me-badge-target">{item.cat}</span>}
        <button
          type="button"
          className={`me-badge me-badge-status me-badge-status-${item.status}`}
          title={t('todo.board.cycleStatus')}
          disabled={busy}
          onClick={(event) => {
            // 阻止冒泡，避免与卡片其它点击冲突
            event.stopPropagation()
            cycleStatus(item)
          }}
        >
          {statusLabel(t, item.status)}
        </button>
      </>
    )
  }

  /** 渲染完成/编辑/删除操作按钮（列表行与看板卡片共用）。 */
  const renderActions = (item: TodoItem): JSX.Element => {
    const done = DONE_STATUSES.has(item.status)
    return (
      <span className="me-item-actions">
        <button type="button" className="me-btn me-btn-ok" disabled={busy} onClick={() => toggleDone(item)}>
          {done ? t('todo.undone') : t('todo.done')}
        </button>
        {editId !== item.id && (
          <button type="button" className="me-btn" disabled={busy} onClick={() => startEdit(item)}>
            {t('todo.edit')}
          </button>
        )}
        <button type="button" className="me-btn me-btn-danger" disabled={busy} onClick={() => removeTodo(item)}>
          {t('memoryTab.delete')}
        </button>
      </span>
    )
  }

  /** 渲染行内编辑表单（列表与看板共用）。 */
  const renderEditForm = (item: TodoItem): JSX.Element => (
    <div className="me-todo-edit">
      <textarea
        className="me-item-edit"
        rows={2}
        value={editDraft}
        onChange={(event) => setEditDraft(event.target.value)}
      />
      <div className="me-todo-edit-row">
        <select value={editQuad} onChange={(event) => setEditQuad(event.target.value)}>
          <option value="">{t('todo.quadrant.none')}</option>
          <option value="q1">{t('todo.quadrant.q1')}</option>
          <option value="q2">{t('todo.quadrant.q2')}</option>
          <option value="q3">{t('todo.quadrant.q3')}</option>
          <option value="q4">{t('todo.quadrant.q4')}</option>
        </select>
        <input
          type="date"
          value={editDue}
          onChange={(event) => setEditDue(event.target.value)}
        />
        <select value={editStatus} onChange={(event) => setEditStatus(event.target.value)}>
          <option value="pending">{t('todo.status.pending')}</option>
          <option value="doing">{t('todo.status.doing')}</option>
          <option value="done">{t('todo.status.done')}</option>
          <option value="blocked">{t('todo.status.blocked')}</option>
          <option value="cancelled">{t('todo.status.cancelled')}</option>
        </select>
        <button
          type="button"
          className="me-btn me-btn-ok"
          disabled={busy || editDraft.trim() === ''}
          onClick={() => saveEdit(item)}
        >
          {t('todo.save')}
        </button>
        <button type="button" className="me-btn" disabled={busy} onClick={() => setEditId(null)}>
          {t('todo.cancel')}
        </button>
      </div>
    </div>
  )

  /** 看板单张卡片。 */
  const renderBoardCard = (item: TodoItem): JSX.Element => {
    const done = DONE_STATUSES.has(item.status)
    // 标题取首行，过长截断；完整内容在编辑或 title 悬停可见
    const titleLine = item.text.split('\n')[0] || item.text
    return (
      <article
        key={item.id}
        className={`me-todo-card${done ? ' me-todo-card--done' : ''}`}
      >
        <div className="me-todo-card-meta">
          {renderMetaBadges(item)}
        </div>
        {editId === item.id ? (
          renderEditForm(item)
        ) : (
          <>
            <p className="me-todo-card-title" title={item.text}>{titleLine}</p>
            {item.text.includes('\n') && (
              <p className="me-todo-card-body">{item.text.slice(titleLine.length).trim()}</p>
            )}
          </>
        )}
        <div className="me-todo-card-foot">
          <span className="me-item-time">{item.time}</span>
          {renderActions(item)}
        </div>
      </article>
    )
  }

  /** 看板四宫格主体。 */
  const renderBoard = (): JSX.Element => (
    <div className="me-todo-board" role="region" aria-label={t('todo.view.board')}>
      {BOARD_QUADRANTS.map((qid) => {
        const bucket = boardBuckets[qid]
        return (
          <section
            key={qid}
            className={`me-todo-quad me-todo-quad-${qid}`}
            aria-label={t(`todo.quadrant.${qid}`)}
          >
            <header className="me-todo-quad-head">
              <span className="me-todo-quad-title">{t(`todo.quadrant.${qid}`)}</span>
              <span className="me-todo-quad-count">{bucket.length}</span>
            </header>
            <div className="me-todo-quad-body">
              {bucket.length === 0 ? (
                <p className="me-todo-quad-empty">{t('todo.board.empty')}</p>
              ) : (
                bucket.map((item) => renderBoardCard(item))
              )}
            </div>
          </section>
        )
      })}
    </div>
  )

  /** 列表主体（原逻辑）。 */
  const renderList = (): JSX.Element => {
    if (visible.length === 0) {
      return (
        <p className="me-empty">
          {t('todo.empty')}
          {(target === 'all' || target === 'past') && !showExpired && ` ${t('todo.pastHint')}`}
        </p>
      )
    }
    return (
      <ul className="me-list">
        {groups.map((group) => (
          <Fragment key={group.day ?? group.items[0].id}>
            {group.day !== null && (
              <li className="me-todo-day">{dayLabel(group.day)}</li>
            )}
            {group.items.map((item) => {
              const done = DONE_STATUSES.has(item.status)
              return (
                <li key={item.id} className={`me-item me-todo-item${done ? ' me-todo-item--done' : ''}`}>
                  <div className="me-item-head">
                    {renderMetaBadges(item, { showQuad: true })}
                    <span className="me-item-time">{item.time}</span>
                    {renderActions(item)}
                  </div>
                  {editId === item.id ? renderEditForm(item) : (
                    <p className="me-todo-text">{item.text}</p>
                  )}
                </li>
              )
            })}
          </Fragment>
        ))}
      </ul>
    )
  }

  return (
    <div className="me-panel">
      {notice !== null && (
        <div className={`me-notice me-notice-${notice.kind}`}>{notice.text}</div>
      )}
      {/* 轨页签：全部 + 四轨 + 过往（默认全部） */}
      <div className="me-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={target === 'all'}
          className={target === 'all' ? 'me-tab me-tab-active' : 'me-tab'}
          onClick={() => setTarget('all')}
        >
          {t('todo.track.all')}
        </button>
        {TARGETS.map((track) => (
          <button
            key={track}
            type="button"
            role="tab"
            aria-selected={target === track}
            className={target === track ? 'me-tab me-tab-active' : 'me-tab'}
            onClick={() => setTarget(track)}
          >
            {t(`todo.track.${track}`)}
          </button>
        ))}
        <button
          type="button"
          role="tab"
          aria-selected={target === 'past'}
          className={target === 'past' ? 'me-tab me-tab-active' : 'me-tab'}
          onClick={() => setTarget('past')}
        >
          {t('todo.track.past')}
        </button>
      </div>
      <p className="me-muted me-todo-help">{t('todo.help')}</p>
      {target === 'project' && cwd === null && (
        <p className="me-muted">{t('todo.projectHint')}</p>
      )}
      {/* 快速添加：全部视图下可选目标轨；过往视图只查看历史不添加 */}
      {target !== 'past' && (
        <div className="me-todo-add">
          {target === 'all' && (
            <select
              className="me-todo-select"
              value={addTarget}
              onChange={(event) => setAddTarget(event.target.value as TodoTarget)}
              title={t('todo.track')}
            >
              {TARGETS.map((track) => (
                <option key={track} value={track}>{t(`todo.track.${track}`)}</option>
              ))}
            </select>
          )}
          <input
            type="text"
            className="me-todo-input"
            value={draft}
            placeholder={t('todo.addPlaceholder')}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') addTodo() }}
          />
          <select
            className="me-todo-select"
            value={draftQuad}
            onChange={(event) => setDraftQuad(event.target.value)}
            title={t('todo.quadrant')}
          >
            <option value="">{t('todo.quadrant.none')}</option>
            <option value="q1">{t('todo.quadrant.q1')}</option>
            <option value="q2">{t('todo.quadrant.q2')}</option>
            <option value="q3">{t('todo.quadrant.q3')}</option>
            <option value="q4">{t('todo.quadrant.q4')}</option>
          </select>
          <input
            type="date"
            className="me-todo-date"
            value={draftDue}
            onChange={(event) => setDraftDue(event.target.value)}
            title={t('todo.due')}
          />
          <button type="button" className="me-btn me-btn-ok" disabled={busy || draft.trim() === ''} onClick={addTodo}>
            {t('todo.add')}
          </button>
        </div>
      )}
      {/* 筛选 + 列表/看板视图切换 */}
      <div className="me-todo-filters">
        <label className="me-todo-filter">
          <span>{t('todo.filterStatus')}</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | 'active' | 'done')}>
            <option value="active">{t('todo.status.active')}</option>
            <option value="all">{t('todo.all')}</option>
            <option value="done">{t('todo.status.done')}</option>
          </select>
        </label>
        <label className="me-todo-filter">
          <span>{t('todo.filterQuadrant')}</span>
          <select value={quadFilter} onChange={(event) => setQuadFilter(event.target.value)}>
            <option value="all">{t('todo.all')}</option>
            <option value="q1">{t('todo.quadrant.q1')}</option>
            <option value="q2">{t('todo.quadrant.q2')}</option>
            <option value="q3">{t('todo.quadrant.q3')}</option>
            <option value="q4">{t('todo.quadrant.q4')}</option>
            <option value="none">{t('todo.quadrant.none')}</option>
          </select>
        </label>
        {(target === 'all' || target === 'past') && (
          <label className="me-todo-filter me-todo-filter-check">
            <input
              type="checkbox"
              checked={showExpired}
              onChange={(event) => setShowExpired(event.target.checked)}
            />
            <span>{t('todo.showExpired')}</span>
          </label>
        )}
        {/* 分段控件：列表 / 看板 */}
        <div className="me-todo-view-switch" role="group" aria-label={t('todo.view.mode')}>
          <button
            type="button"
            className={viewMode === 'list' ? 'me-todo-view-btn me-todo-view-btn-active' : 'me-todo-view-btn'}
            aria-pressed={viewMode === 'list'}
            onClick={() => setViewMode('list')}
          >
            {t('todo.view.list')}
          </button>
          <button
            type="button"
            className={viewMode === 'board' ? 'me-todo-view-btn me-todo-view-btn-active' : 'me-todo-view-btn'}
            aria-pressed={viewMode === 'board'}
            onClick={() => setViewMode('board')}
          >
            {t('todo.view.board')}
          </button>
        </div>
      </div>
      {/* 内容区：加载中 / 列表 / 看板 */}
      {items === null ? (
        <p className="me-muted">{t('panel.loading')}</p>
      ) : viewMode === 'board' ? (
        renderBoard()
      ) : (
        renderList()
      )}
    </div>
  )
}
