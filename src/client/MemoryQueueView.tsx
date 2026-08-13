/**
 * dsh-memory-evolve — session memory tab feature panels.
 *
 * The three sub-tabs of the session memory tab, migrated from the former
 * settings-panel section (MemoryPanel, now removed): the pending memory
 * suggestion queue, the pending skill queue, and the runtime-config form.
 * Styling reuses the `me-` class prefix from styles.css.
 *
 * Every mutation re-loads its data and calls `onChanged` so the owning tab
 * can refresh the badge counts (and the session-tab red dot).
 */
import { useEffect, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** Which feature sub-tab is active. */
export type MemoryFeature = 'guide' | 'suggestions' | 'todo-suggestions' | 'skills' | 'config'

/** Locale-bound props for the feature panels. */
export interface MemoryQueueViewProps {
  t: Translate
  feature: MemoryFeature
  /** Called after any queue/config mutation so the parent can re-poll badges. */
  onChanged: () => void
}

/** 待办建议 target 的展示名（todo-life → 待办·生活）。 */
function todoTargetLabel(t: Translate, target: string): string {
  const track = target.slice(5)
  if (track === 'life') return `待办·${t('todo.track.life')}`
  if (track === 'work') return `待办·${t('todo.track.work')}`
  if (track === 'project') return `待办·${t('todo.track.project')}`
  if (track === 'daily') return `待办·${t('todo.track.daily')}`
  return target
}

/** 建议目标 → 友好显示名（长期记忆/用户档案/项目关键记忆/待办·…）。 */
function suggestTargetLabel(t: Translate, target: string): string {
  if (target.startsWith('todo-')) return todoTargetLabel(t, target)
  if (target === 'memory') return t('panel.suggestions.target.memory')
  if (target === 'user') return t('panel.suggestions.target.user')
  if (target === 'key') return t('panel.suggestions.target.key')
  return target
}

/** 建议目标 → 徽标着色类后缀（memory/user/key/todo）。 */
function suggestTargetClass(target: string): string {
  return target.startsWith('todo-') ? 'todo' : target
}

/** 采纳时可选的目标轨（仅记忆三轨：默认=AI 推荐；可改到更合适的分类）。
 *  待办建议不提供改分类下拉——直接采纳即按推荐写入待办轨。 */
const SUGGEST_TARGETS = ['memory', 'user', 'key'] as const

/** One pending suggestion entry (subset of the queue record). */
interface SuggestionEntry {
  time: string
  sessionId?: string | null
  /** 建议产生时的会话工作目录（项目级条目定位用；可能为 null=无 cwd 的老条目）。 */
  cwd?: string | null
  target: string
  content: string
  reason?: string
  /** How many times this fact resurfaced in reviews (deduped queue). */
  hits?: number
}

/**
 * 一条建议 + 服务端原始队列下标。
 *
 * 展示层按 hits 倒序排列（反复出现的建议最可能值得确认），但操作时必须
 * 回传服务端磁盘队列的原始 1-based 序号——服务端 approve/reject/archive
 * 按原始顺序解释序号（lib/review.js）。若只排序不改号，任一 hits>1 的
 * 条目排到前面后，「采纳第 1 条」实际处理的是另一条（误采纳/误拒绝）。
 */
interface SuggestionRow {
  entry: SuggestionEntry
  /** 服务端队列中的原始下标（0-based；对外操作时 +1 转 1-based 序号）。 */
  origIndex: number
}

/**
 * 项目级建议（target=key / todo-project）显示项目标识：取 cwd 的最后一段
 * 作为项目名（兼容 / 与 \ 分隔的路径），完整路径放 title 悬浮提示。
 */
function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((part) => part.length > 0)
  return parts.length > 0 ? (parts[parts.length - 1] as string) : cwd
}

/** One pending skill awaiting user confirmation. */
interface PendingSkill {
  name: string
  description: string
  content: string
}

/** Runtime config view (subset returned by /api/config). */
interface RuntimeConfig {
  reviewEnabled: boolean
  reviewInterval: number
  skillReviewEnabled: boolean
  perTurnProjectWrites: boolean
  perTurnDailyWrites: boolean
  perTurnKeyWrites: boolean
  searchDocsEnabled: boolean
  /** 本地搜索四档模式：all / filename / content / off。 */
  searchDocsMode: string
  coiEnabled: boolean
  broadcastEnabled: boolean
  sessionSearchEnabled: boolean
  sessionEnabled: boolean
  scratchEnabled: boolean
  promptsEnabled: boolean
  modelsEnabled: boolean
  uiSettingsEnabled: boolean
  /** 会话书签（独立子模块，默认关）。 */
  bookmarkEnabled: boolean
  /** 渠道通知（de_notify，独立子模块，默认关）：AI 完成任务后经 IM 渠道主动发通知。 */
  notifyEnabled: boolean
  /** 项目记忆跨设备同步（/memory_sync，独立子模块，默认关）：Git 对账。 */
  syncEnabled: boolean
  /** 会话评审 Advisor（独立子模块，默认关）：评审员挂每个会话实时评审。 */
  advisorEnabled: boolean
  /** 无限画板（独立子模块，默认关）：素材集中台 + de_canvas 双向。 */
  canvasEnabled: boolean
}

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

/** Summarize an approve/reject report into one line. */
function summarizeReport(report: { lines?: string[]; removed?: number; remaining: number }): string {
  const head = report.lines?.join('；') ?? `已处理 ${report.removed ?? 0} 条`
  return `${head}（剩余 ${report.remaining} 条）`
}

/** Display-side formatting of the ISO timestamp; falls back to the raw string. */
function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

/** The three feature panels (suggestions / skills / config). */
export function MemoryQueueView(props: MemoryQueueViewProps): JSX.Element {
  const { t, feature, onChanged } = props
  const [entries, setEntries] = useState<SuggestionRow[] | null>(null)
  const [skills, setSkills] = useState<PendingSkill[] | null>(null)
  const [config, setConfig] = useState<RuntimeConfig | null>(null)
  const [draft, setDraft] = useState<RuntimeConfig | null>(null)
  /** Edited text per 1-based suggestion index (textarea values). */
  const [edits, setEdits] = useState<Record<number, string>>({})
  /** 采纳时的目标轨选择（1-based index → 覆盖轨；缺省=AI 推荐的分类）。 */
  const [targetPicks, setTargetPicks] = useState<Record<number, string>>({})
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = (): void => {
    void Promise.all([
      api<{ entries: SuggestionEntry[] }>('/api/suggestions'),
      api<{ entries: PendingSkill[] }>('/api/pending-skills'),
      api<{ config: RuntimeConfig }>('/api/config'),
    ]).then(([s, sk, c]) => {
      // Facts that resurfaced in several reviews are the most likely to be
      // worth confirming — show them first. 每条携带服务端原始队列下标，
      // 操作时回传原始序号（见 SuggestionRow 注释），保证与服务端对齐。
      const sorted = [...s.entries]
        .map((entry, index) => ({ entry, origIndex: index }))
        .sort((a, b) => (b.entry.hits ?? 1) - (a.entry.hits ?? 1))
      setEntries(sorted)
      setSkills(sk.entries)
      setEdits({})
      setTargetPicks({})
      setConfig(c.config)
      setDraft((prev) => prev ?? c.config)
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: t('panel.config.failed', { message: error.message }) })
    })
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runSuggestions = (op: 'approve' | 'archive' | 'reject', indices: number[]): void => {
    setBusy(true)
    const body: { indices?: number[]; contents?: string[]; targets?: Record<string, string> } = {}
    body.indices = indices
    if (op === 'approve') {
      const contents = indices.map((index) => edits[index] ?? '')
      // Send contents only when the user actually edited some entry; an
      // all-empty contents array would otherwise be treated as a real edit
      // of every entry ("" is not nullish), overwriting the suggestion.
      if (contents.some((content) => content !== '')) body.contents = contents
      // 目标覆盖：只传与推荐轨不同的选择（不选 = 推荐轨，行为不变）。
      // 按原始序号定位条目（entries 是排序后的展示数组，不能直接按下标取）。
      const overrides: Record<string, string> = {}
      for (const index of indices) {
        const pick = targetPicks[index]
        const row = (entries ?? []).find((candidate) => candidate.origIndex + 1 === index)
        if (pick !== undefined && pick !== row?.entry.target) overrides[String(index)] = pick
      }
      if (Object.keys(overrides).length > 0) body.targets = overrides
    }
    void api<{ lines?: string[]; removed?: number; remaining: number }>(`/api/suggestions/${op}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((report) => {
      setNotice({ kind: 'ok', text: summarizeReport(report) })
      load()
      onChanged()
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: t('panel.config.failed', { message: error.message }) })
    }).finally(() => setBusy(false))
  }

  const runSkill = (op: 'approve' | 'reject', name: string): void => {
    setBusy(true)
    void api<{ ok: boolean }>(`/api/pending-skills/${op}`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }).then(() => {
      setNotice({ kind: 'ok', text: t('panel.skills.done', { op: op === 'approve' ? t('panel.skills.approve') : t('panel.skills.reject') }) })
      load()
      onChanged()
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: t('panel.config.failed', { message: error.message }) })
    }).finally(() => setBusy(false))
  }

  const saveConfig = (): void => {
    if (draft === null) return
    setBusy(true)
    // Send only the fields this panel edits: the GET response carries exactly
    // the runtime-changeable keys, but an explicit patch keeps the payload
    // stable if the host ever adds more (static config keys are rejected by
    // the host's validateRuntimePatch).
    const patch: RuntimeConfig = {
      reviewEnabled: draft.reviewEnabled,
      reviewInterval: draft.reviewInterval,
      skillReviewEnabled: draft.skillReviewEnabled,
      perTurnProjectWrites: draft.perTurnProjectWrites,
      perTurnDailyWrites: draft.perTurnDailyWrites,
      perTurnKeyWrites: draft.perTurnKeyWrites,
      searchDocsEnabled: draft.searchDocsEnabled,
      searchDocsMode: draft.searchDocsMode,
      coiEnabled: draft.coiEnabled,
      broadcastEnabled: draft.broadcastEnabled,
      advisorEnabled: draft.advisorEnabled,
      sessionSearchEnabled: draft.sessionSearchEnabled,
      sessionEnabled: draft.sessionEnabled,
      scratchEnabled: draft.scratchEnabled,
      promptsEnabled: draft.promptsEnabled,
      modelsEnabled: draft.modelsEnabled,
      uiSettingsEnabled: draft.uiSettingsEnabled,
      bookmarkEnabled: draft.bookmarkEnabled,
      notifyEnabled: draft.notifyEnabled,
      syncEnabled: draft.syncEnabled,
      canvasEnabled: draft.canvasEnabled,
    }
    void api<{ config: RuntimeConfig }>('/api/config', {
      method: 'POST',
      body: JSON.stringify({ patch }),
    }).then((res) => {
      setConfig(res.config)
      setDraft(res.config)
      setNotice({ kind: 'ok', text: t('panel.config.saved') })
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: t('panel.config.failed', { message: error.message }) })
    }).finally(() => setBusy(false))
  }

  const patchDraft = (patch: Partial<RuntimeConfig>): void => {
    setDraft((prev) => (prev === null ? prev : { ...prev, ...patch }))
  }

  /** 当前面板的建议行（序号=服务端原始队列的 1-based index）：记忆面板=非待办类，
   *  待办面板=todo-* 类。展示排序不影响序号——序号取 origIndex，与服务端对齐。 */
  const suggestionRows = (entries ?? [])
    .map((row) => ({ entry: row.entry, index: row.origIndex + 1 }))
    .filter(({ entry }) => (feature === 'todo-suggestions')
      ? entry.target.startsWith('todo-')
      : !entry.target.startsWith('todo-'))

  return (
    <div className="me-panel">
      {notice !== null && (
        <div className={`me-notice me-notice-${notice.kind}`}>{notice.text}</div>
      )}

      {feature === 'guide' && (
        <section className="me-block">
          <div className="me-block-head">
            <h3 className="me-heading">{t('panel.guide.title')}</h3>
          </div>
          <p className="me-help">{t('panel.guide.intro')}</p>
          <div className="me-guide">
            <div className="me-guide-row">
              <span className="me-guide-icon">🧠</span>
              <span className="me-guide-body">
                <strong>{t('panel.guide.memory.title')}</strong>
                <span>{t('panel.guide.memory.desc')}</span>
              </span>
            </div>
            <div className="me-guide-row">
              <span className="me-guide-icon">🔄</span>
              <span className="me-guide-body">
                <strong>{t('panel.guide.review.title')}</strong>
                <span>{t('panel.guide.review.desc')}</span>
              </span>
            </div>
            <div className="me-guide-row">
              <span className="me-guide-icon">✅</span>
              <span className="me-guide-body">
                <strong>{t('panel.guide.todo.title')}</strong>
                <span>{t('panel.guide.todo.desc')}</span>
              </span>
            </div>
            <div className="me-guide-row">
              <span className="me-guide-icon">🛠️</span>
              <span className="me-guide-body">
                <strong>{t('panel.guide.skill.title')}</strong>
                <span>{t('panel.guide.skill.desc')}</span>
              </span>
            </div>
            <div className="me-guide-row">
              <span className="me-guide-icon">🔍</span>
              <span className="me-guide-body">
                <strong>{t('panel.guide.search.title')}</strong>
                <span>{t('panel.guide.search.desc')}</span>
              </span>
            </div>
            <div className="me-guide-row">
              <span className="me-guide-icon">🚀</span>
              <span className="me-guide-body">
                <strong>{t('panel.guide.coi.title')}</strong>
                <span>{t('panel.guide.coi.desc')}</span>
              </span>
            </div>
            <div className="me-guide-row">
              <span className="me-guide-icon">📌</span>
              <span className="me-guide-body">
                <strong>{t('panel.guide.prompt.title')}</strong>
                <span>{t('panel.guide.prompt.desc')}</span>
              </span>
            </div>
            <div className="me-guide-row">
              <span className="me-guide-icon">🧩</span>
              <span className="me-guide-body">
                <strong>{t('panel.guide.models.title')}</strong>
                <span>{t('panel.guide.models.desc')}</span>
              </span>
            </div>
            <div className="me-guide-row">
              <span className="me-guide-icon">🧐</span>
              <span className="me-guide-body">
                <strong>{t('panel.guide.advisor.title')}</strong>
                <span>{t('panel.guide.advisor.desc')}</span>
              </span>
            </div>
            <div className="me-guide-row">
              <span className="me-guide-icon">📨</span>
              <span className="me-guide-body">
                <strong>{t('panel.guide.broadcast.title')}</strong>
                <span>{t('panel.guide.broadcast.desc')}</span>
              </span>
            </div>
            <div className="me-guide-row">
              <span className="me-guide-icon">📡</span>
              <span className="me-guide-body">
                <strong>{t('panel.guide.session.title')}</strong>
                <span>{t('panel.guide.session.desc')}</span>
              </span>
            </div>
            <div className="me-guide-row">
              <span className="me-guide-icon">🧭</span>
              <span className="me-guide-body">
                <strong>{t('panel.guide.sessionOrch.title')}</strong>
                <span>{t('panel.guide.sessionOrch.desc')}</span>
              </span>
            </div>
            <div className="me-guide-row">
              <span className="me-guide-icon">🎨</span>
              <span className="me-guide-body">
                <strong>{t('panel.guide.uiSettings.title')}</strong>
                <span>{t('panel.guide.uiSettings.desc')}</span>
              </span>
            </div>
            <div className="me-guide-row">
              <span className="me-guide-icon">⭐</span>
              <span className="me-guide-body">
                <strong>{t('panel.guide.bookmark.title')}</strong>
                <span>{t('panel.guide.bookmark.desc')}</span>
              </span>
            </div>
            <div className="me-guide-row">
              <span className="me-guide-icon">🛡️</span>
              <span className="me-guide-body">
                <strong>{t('panel.guide.confirm.title')}</strong>
                <span>{t('panel.guide.confirm.desc')}</span>
              </span>
            </div>
          </div>
          <h4 className="me-guide-sub">{t('panel.guide.best.title')}</h4>
          <ul className="me-guide-tips">
            <li>{t('panel.guide.best.1')}</li>
            <li>{t('panel.guide.best.2')}</li>
            <li>{t('panel.guide.best.3')}</li>
            <li>{t('panel.guide.best.4')}</li>
          </ul>
          <p className="me-guide-loop">{t('panel.guide.loop')}</p>
        </section>
      )}

      {(feature === 'suggestions' || feature === 'todo-suggestions') && (
        <section className="me-block">
          <div className="me-block-head">
            <h3 className="me-heading">
              {feature === 'todo-suggestions' ? t('panel.todoSuggestions.title') : t('panel.suggestions.title')}
            </h3>
            {suggestionRows.length > 0 && (
              <span className="me-count">{suggestionRows.length}</span>
            )}
          </div>
          <p className="me-help">
            {feature === 'todo-suggestions' ? t('panel.todoSuggestions.help') : t('panel.suggestions.help')}
          </p>
          {entries === null ? (
            <p className="me-muted">{t('panel.loading')}</p>
          ) : suggestionRows.length === 0 ? (
            <p className="me-empty">
              {feature === 'todo-suggestions' ? t('panel.todoSuggestions.empty') : t('panel.suggestions.empty')}
            </p>
          ) : (
            <>
              <ul className="me-list">
                {suggestionRows.map(({ entry, index }) => (
                  <li key={`${entry.time}-${index}`} className="me-item">
                    <div className="me-item-head">
                      <span
                        className={`me-badge me-badge-suggest me-badge-suggest-${suggestTargetClass(entry.target)}`}
                        title={t('panel.suggestions.targetHint')}
                      >
                        {suggestTargetLabel(t, entry.target)}
                      </span>
                      {/* 项目级建议（项目关键记忆/项目待办）：标注来源项目，
                          否则多条 key 建议看不出属于哪个项目的工作区间 */}
                      {entry.cwd && (entry.target === 'key' || entry.target === 'todo-project') && (
                        <span
                          className="me-badge me-badge-project"
                          title={t('panel.suggestions.projectHint', { path: entry.cwd })}
                        >
                          📁 {projectName(entry.cwd)}
                        </span>
                      )}
                      {(entry.hits ?? 1) > 1 && (
                        <span className="me-badge me-badge-hits" title={t('panel.suggestions.hitsHint')}>
                          {t('panel.suggestions.hits', { count: entry.hits ?? 1 })}
                        </span>
                      )}
                      <span className="me-item-time" title={entry.time}>{formatTime(entry.time)}</span>
                      <span className="me-item-actions">
                        {!entry.target.startsWith('todo-') && (
                          <select
                            className="me-pick-target"
                            title={t('panel.suggestions.targetHint')}
                            value={targetPicks[index] ?? entry.target}
                            onChange={(event) => setTargetPicks((prev) => ({ ...prev, [index]: event.target.value }))}
                          >
                            {SUGGEST_TARGETS.map((target) => (
                              <option key={target} value={target}>{suggestTargetLabel(t, target)}</option>
                            ))}
                          </select>
                        )}
                        <button
                          type="button"
                          className="me-btn me-btn-ok"
                          disabled={busy}
                          onClick={() => runSuggestions('approve', [index])}
                        >
                          {t('panel.suggestions.approve')}
                        </button>
                        <button
                          type="button"
                          className="me-btn me-btn-archive"
                          disabled={busy}
                          title={t('panel.suggestions.archiveHint')}
                          onClick={() => runSuggestions('archive', [index])}
                        >
                          {t('panel.suggestions.archive')}
                        </button>
                        <button
                          type="button"
                          className="me-btn me-btn-danger"
                          disabled={busy}
                          onClick={() => runSuggestions('reject', [index])}
                        >
                          {t('panel.suggestions.reject')}
                        </button>
                      </span>
                    </div>
                    <textarea
                      className="me-item-edit"
                      rows={3}
                      value={edits[index] ?? entry.content}
                      onChange={(event) => setEdits((prev) => ({ ...prev, [index]: event.target.value }))}
                    />
                    <p className="me-item-reason">
                      {entry.reason !== undefined && entry.reason !== '' ? entry.reason : t('panel.suggestions.editHint')}
                    </p>
                  </li>
                ))}
              </ul>
              <div className="me-bulk">
                <button
                  type="button"
                  className="me-btn me-btn-ok"
                  disabled={busy}
                  onClick={() => runSuggestions('approve', suggestionRows.map((row) => row.index))}
                >
                  {t('panel.suggestions.approveAll')}
                </button>
                <button
                  type="button"
                  className="me-btn me-btn-danger"
                  disabled={busy}
                  onClick={() => runSuggestions('reject', suggestionRows.map((row) => row.index))}
                >
                  {t('panel.suggestions.rejectAll')}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {feature === 'skills' && (
        <section className="me-block">
          <div className="me-block-head">
            <h3 className="me-heading">{t('panel.skills.title')}</h3>
            {skills !== null && skills.length > 0 && (
              <span className="me-count">{skills.length}</span>
            )}
          </div>
          <p className="me-help">{t('panel.skills.help')}</p>
          {skills === null ? (
            <p className="me-muted">{t('panel.loading')}</p>
          ) : skills.length === 0 ? (
            <p className="me-empty">{t('panel.skills.empty')}</p>
          ) : (
            <ul className="me-list">
              {skills.map((skill) => (
                <li key={skill.name} className="me-item">
                  <div className="me-item-head">
                    <span className="me-badge me-badge-target">{skill.name}</span>
                    <span className="me-item-time">{t('panel.skills.pending')}</span>
                    <span className="me-item-actions">
                      <button
                        type="button"
                        className="me-btn me-btn-ok"
                        disabled={busy}
                        onClick={() => runSkill('approve', skill.name)}
                      >
                        {t('panel.skills.approve')}
                      </button>
                      <button
                        type="button"
                        className="me-btn me-btn-danger"
                        disabled={busy}
                        onClick={() => runSkill('reject', skill.name)}
                      >
                        {t('panel.skills.reject')}
                      </button>
                    </span>
                  </div>
                  <p className="me-item-reason">{skill.description}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {feature === 'config' && (
        <section className="me-block">
          <div className="me-block-head">
            <h3 className="me-heading">{t('panel.config.title')}</h3>
          </div>
          <p className="me-help">{t('panel.config.help')}</p>
          {draft === null ? (
            <p className="me-muted">{t('panel.loading')}</p>
          ) : (
            <div className="me-form">
              <div className="me-group">
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.reviewEnabled')}
                    <em className="me-field-hint">{t('panel.config.reviewEnabled.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.reviewEnabled}
                    onChange={(event) => patchDraft({ reviewEnabled: event.target.checked })}
                  />
                </label>
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.reviewInterval')}
                    <em className="me-field-hint">{t('panel.config.reviewInterval.hint')}</em>
                  </span>
                  <input
                    type="number"
                    className="me-input"
                    min={1}
                    value={draft.reviewInterval}
                    onChange={(event) => patchDraft({ reviewInterval: Number(event.target.value) })}
                  />
                </label>
              </div>
              <div className="me-group">
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.skillReviewEnabled')}
                    <em className="me-field-hint">{t('panel.config.skillReviewEnabled.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.skillReviewEnabled}
                    onChange={(event) => patchDraft({ skillReviewEnabled: event.target.checked })}
                  />
                </label>
              </div>
              <div className="me-group">
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.perTurnProjectWrites')}
                    <em className="me-field-hint">{t('panel.config.perTurnProjectWrites.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.perTurnProjectWrites}
                    onChange={(event) => patchDraft({ perTurnProjectWrites: event.target.checked })}
                  />
                </label>
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.perTurnDailyWrites')}
                    <em className="me-field-hint">{t('panel.config.perTurnDailyWrites.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.perTurnDailyWrites}
                    onChange={(event) => patchDraft({ perTurnDailyWrites: event.target.checked })}
                  />
                </label>
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.perTurnKeyWrites')}
                    <em className="me-field-hint">{t('panel.config.perTurnKeyWrites.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.perTurnKeyWrites}
                    onChange={(event) => patchDraft({ perTurnKeyWrites: event.target.checked })}
                  />
                </label>
              </div>
              <div className="me-group">
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.searchDocsEnabled')}
                    <em className="me-field-hint">{t('panel.config.searchDocsEnabled.hint')}</em>
                  </span>
                  {/* 四档模式（用户拍板）：all=文件名+内容 / filename=仅文件名 /
                      content=仅内容 / off=工具不注册。select 比 checkbox 直观。 */}
                  <select
                    className="me-todo-select"
                    value={draft.searchDocsMode ?? (draft.searchDocsEnabled ? 'all' : 'off')}
                    onChange={(event) => {
                      const mode = event.target.value
                      patchDraft({
                        searchDocsMode: mode,
                        searchDocsEnabled: mode !== 'off', // 兼容旧键（驱动注册/卸载）
                      })
                    }}
                  >
                    <option value="all">{t('panel.config.searchDocsMode.all')}</option>
                    <option value="filename">{t('panel.config.searchDocsMode.filename')}</option>
                    <option value="content">{t('panel.config.searchDocsMode.content')}</option>
                    <option value="off">{t('panel.config.searchDocsMode.off')}</option>
                  </select>
                </label>
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.coiEnabled')}
                    <em className="me-field-hint">{t('panel.config.coiEnabled.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.coiEnabled}
                    onChange={(event) => patchDraft({ coiEnabled: event.target.checked })}
                  />
                </label>
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.broadcastEnabled')}
                    <em className="me-field-hint">{t('panel.config.broadcastEnabled.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.broadcastEnabled}
                    onChange={(event) => patchDraft({ broadcastEnabled: event.target.checked })}
                  />
                </label>
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.advisorEnabled')}
                    <em className="me-field-hint">{t('panel.config.advisorEnabled.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.advisorEnabled}
                    onChange={(event) => patchDraft({ advisorEnabled: event.target.checked })}
                  />
                </label>
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.notifyEnabled')}
                    <em className="me-field-hint">{t('panel.config.notifyEnabled.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.notifyEnabled}
                    onChange={(event) => patchDraft({ notifyEnabled: event.target.checked })}
                  />
                </label>
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.syncEnabled')}
                    <em className="me-field-hint">{t('panel.config.syncEnabled.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.syncEnabled}
                    onChange={(event) => patchDraft({ syncEnabled: event.target.checked })}
                  />
                </label>
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.canvasEnabled')}
                    <em className="me-field-hint">{t('panel.config.canvasEnabled.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.canvasEnabled}
                    onChange={(event) => patchDraft({ canvasEnabled: event.target.checked })}
                  />
                </label>
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.sessionEnabled')}
                    <em className="me-field-hint">{t('panel.config.sessionEnabled.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.sessionEnabled}
                    onChange={(event) => patchDraft({ sessionEnabled: event.target.checked })}
                  />
                </label>
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.sessionSearchEnabled')}
                    <em className="me-field-hint">{t('panel.config.sessionSearchEnabled.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.sessionSearchEnabled}
                    onChange={(event) => patchDraft({ sessionSearchEnabled: event.target.checked })}
                  />
                </label>
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.scratchEnabled')}
                    <em className="me-field-hint">{t('panel.config.scratchEnabled.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.scratchEnabled}
                    onChange={(event) => patchDraft({ scratchEnabled: event.target.checked })}
                  />
                </label>
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.promptsEnabled')}
                    <em className="me-field-hint">{t('panel.config.promptsEnabled.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.promptsEnabled}
                    onChange={(event) => patchDraft({ promptsEnabled: event.target.checked })}
                  />
                </label>
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.modelsEnabled')}
                    <em className="me-field-hint">{t('panel.config.modelsEnabled.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.modelsEnabled}
                    onChange={(event) => patchDraft({ modelsEnabled: event.target.checked })}
                  />
                </label>
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.uiSettingsEnabled')}
                    <em className="me-field-hint">{t('panel.config.uiSettingsEnabled.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.uiSettingsEnabled}
                    onChange={(event) => patchDraft({ uiSettingsEnabled: event.target.checked })}
                  />
                </label>
                <label className="me-field">
                  <span className="me-field-label">
                    {t('panel.config.bookmarkEnabled')}
                    <em className="me-field-hint">{t('panel.config.bookmarkEnabled.hint')}</em>
                  </span>
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.bookmarkEnabled}
                    onChange={(event) => patchDraft({ bookmarkEnabled: event.target.checked })}
                  />
                </label>
              </div>
              <div className="me-actions">
                <button type="button" className="me-btn me-btn-primary" disabled={busy} onClick={saveConfig}>
                  {t('panel.config.save')}
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
