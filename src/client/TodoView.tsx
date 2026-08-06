/**
 * dsh-memory-evolve — todo sub-tab (待办).
 *
 * The four-track todo manager inside the session memory tab: 生活 / 工作 /
 * 项目（按工作目录隔离）/ 每日（按天）. List with status/quadrant filters,
 * quick add (user is the confirmer — direct writes), per-entry done / edit /
 * delete. Data all comes from the host's /memory-evolve/api/todo routes;
 * styling reuses the me-/mt- prefixes from styles.css.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** The four todo tracks. */
type TodoTarget = 'life' | 'work' | 'project' | 'daily'

/** Track filter: 'all' shows every track (default view). */
type TodoTargetFilter = TodoTarget | 'all'

/** One todo row from GET /api/todo. */
interface TodoItem {
  id: string
  time: string
  quadrant: string | null
  due: string | null
  status: string
  doneAt: string | null
  cat: string | null
  text: string
  target: TodoTarget
}

/** Locale-bound props. */
export interface TodoViewProps {
  t: Translate
  sessionId: string
}

/** Track order for the tabs. */
const TARGETS: TodoTarget[] = ['life', 'work', 'project', 'daily']

/** Done-ish statuses (excluded from quick views). */
const DONE_STATUSES = new Set(['done', 'cancelled'])

/** One fetch helper against the node half's API prefix. */
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

/** Quadrant label (q1..q4); null = unclassified. */
function quadrantLabel(t: Translate, quadrant: string | null): string {
  if (quadrant === null) return t('todo.quadrant.none')
  return t(`todo.quadrant.${quadrant}`)
}

/**
 * The todo view: track tabs, filter bar, quick-add box, item list with
 * per-entry operations. Every mutation reloads the current track.
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

  const load = useCallback((): void => {
    setItems(null)
    const params = new URLSearchParams({ sessionId, all: '1' })
    if (target !== 'all') params.set('target', target)
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
  }, [sessionId, target])

  useEffect(() => {
    load()
  }, [load])

  /** Transient ok notice. */
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
    }).then((res) => {
      setDraft('')
      setDraftQuad('')
      setDraftDue('')
      load()
      flash(t('todo.added'))
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: error.message })
    }).finally(() => setBusy(false))
  }

  /** 完成 / 恢复。 */
  const toggleDone = (item: TodoItem): void => {
    if (busy) return
    setBusy(true)
    const done = !DONE_STATUSES.has(item.status)
    void api<{ ok: boolean }>('/api/todo', {
      method: 'POST',
      body: JSON.stringify({ sessionId, action: done ? 'done' : 'update', target: item.target, id: item.id, status: 'pending' }),
    }).then(() => {
      load()
      flash(done ? t('todo.done') : t('todo.undone'))
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: error.message })
    }).finally(() => setBusy(false))
  }

  /** 删除（确认后）。 */
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

  /** 今天（本地），用于逾期标红。 */
  const today = new Date().toISOString().slice(0, 10)

  /** 前端筛选：状态（active=未完成全部状态）+ 象限。 */
  const visible = (items ?? []).filter((item) => {
    if (statusFilter === 'active' && DONE_STATUSES.has(item.status)) return false
    if (statusFilter === 'done' && !DONE_STATUSES.has(item.status)) return false
    if (quadFilter === 'none' && item.quadrant !== null) return false
    if (quadFilter !== 'all' && quadFilter !== 'none' && item.quadrant !== quadFilter) return false
    return true
  })

  return (
    <div className="me-panel">
      {notice !== null && (
        <div className={`me-notice me-notice-${notice.kind}`}>{notice.text}</div>
      )}
      {/* 轨页签：全部 + 四轨（默认全部） */}
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
      </div>
      <p className="me-muted me-todo-help">{t('todo.help')}</p>
      {target === 'project' && cwd === null && (
        <p className="me-muted">{t('todo.projectHint')}</p>
      )}
      {/* 快速添加：全部视图下可选目标轨（缺省按 cwd 判定），单轨视图固定当前轨 */}
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
      {/* 筛选 */}
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
      </div>
      {/* 列表 */}
      {items === null ? (
        <p className="me-muted">{t('panel.loading')}</p>
      ) : visible.length === 0 ? (
        <p className="me-empty">{t('todo.empty')}</p>
      ) : (
        <ul className="me-list">
          {visible.map((item) => {
            const done = DONE_STATUSES.has(item.status)
            const overdue = item.due !== null && item.due < today && !done
            return (
              <li key={item.id} className={`me-item me-todo-item${done ? ' me-todo-item--done' : ''}`}>
                <div className="me-item-head">
                  {target === 'all' && (
                    <span className="me-badge me-badge-target">{t(`todo.track.${item.target}`)}</span>
                  )}
                  <span className={`me-badge me-badge-quad me-badge-quad-${item.quadrant ?? 'none'}`}>
                    {quadrantLabel(t, item.quadrant)}
                  </span>
                  {item.due !== null && (
                    <span className={`me-badge ${overdue ? 'me-badge-overdue' : 'me-badge-due'}`}>
                      {overdue ? `${t('todo.overdue')} ${item.due}` : `${t('todo.due')} ${item.due}`}
                    </span>
                  )}
                  {item.cat !== null && <span className="me-badge me-badge-target">{item.cat}</span>}
                  {done && <span className="me-badge me-badge-hits">{t('todo.status.done')}</span>}
                  <span className="me-item-time">{item.time}</span>
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
                </div>
                {editId === item.id ? (
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
                      <button type="button" className="me-btn me-btn-ok" disabled={busy || editDraft.trim() === ''} onClick={() => saveEdit(item)}>
                        {t('todo.save')}
                      </button>
                      <button type="button" className="me-btn" disabled={busy} onClick={() => setEditId(null)}>
                        {t('todo.cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="me-todo-text">{item.text}</p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
