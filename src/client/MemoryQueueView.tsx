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
export type MemoryFeature = 'suggestions' | 'skills' | 'config'

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
  target: string
  content: string
  reason?: string
  /** How many times this fact resurfaced in reviews (deduped queue). */
  hits?: number
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
  const [entries, setEntries] = useState<SuggestionEntry[] | null>(null)
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
      // worth confirming — show them first.
      const sorted = [...s.entries].sort((a, b) => (b.hits ?? 1) - (a.hits ?? 1))
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

  const runSuggestions = (op: 'approve' | 'archive' | 'reject' | 'approve-all' | 'reject-all', indices?: number[]): void => {
    setBusy(true)
    const body: { indices?: number[]; contents?: string[]; targets?: Record<string, string> } = {}
    if (indices !== undefined) {
      body.indices = indices
      if (op === 'approve') {
        const contents = indices.map((index) => edits[index] ?? '')
        // Send contents only when the user actually edited some entry; an
        // all-empty contents array would otherwise be treated as a real edit
        // of every entry ("" is not nullish), overwriting the suggestion.
        if (contents.some((content) => content !== '')) body.contents = contents
        // 目标覆盖：只传与推荐轨不同的选择（不选 = 推荐轨，行为不变）
        const overrides: Record<string, string> = {}
        for (const index of indices) {
          const pick = targetPicks[index]
          if (pick !== undefined && pick !== entries?.[index - 1]?.target) overrides[String(index)] = pick
        }
        if (Object.keys(overrides).length > 0) body.targets = overrides
      }
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

  return (
    <div className="me-panel">
      {notice !== null && (
        <div className={`me-notice me-notice-${notice.kind}`}>{notice.text}</div>
      )}

      {feature === 'suggestions' && (
        <section className="me-block">
          <div className="me-block-head">
            <h3 className="me-heading">{t('panel.suggestions.title')}</h3>
            {entries !== null && entries.length > 0 && (
              <span className="me-count">{entries.length}</span>
            )}
          </div>
          <p className="me-help">{t('panel.suggestions.help')}</p>
          {entries === null ? (
            <p className="me-muted">{t('panel.loading')}</p>
          ) : entries.length === 0 ? (
            <p className="me-empty">{t('panel.suggestions.empty')}</p>
          ) : (
            <>
              <ul className="me-list">
                {entries.map((entry, index) => (
                  <li key={`${entry.time}-${index}`} className="me-item">
                    <div className="me-item-head">
                      <span
                        className={`me-badge me-badge-suggest me-badge-suggest-${suggestTargetClass(entry.target)}`}
                        title={t('panel.suggestions.targetHint')}
                      >
                        {suggestTargetLabel(t, entry.target)}
                      </span>
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
                            value={targetPicks[index + 1] ?? entry.target}
                            onChange={(event) => setTargetPicks((prev) => ({ ...prev, [index + 1]: event.target.value }))}
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
                          onClick={() => runSuggestions('approve', [index + 1])}
                        >
                          {t('panel.suggestions.approve')}
                        </button>
                        <button
                          type="button"
                          className="me-btn me-btn-archive"
                          disabled={busy}
                          title={t('panel.suggestions.archiveHint')}
                          onClick={() => runSuggestions('archive', [index + 1])}
                        >
                          {t('panel.suggestions.archive')}
                        </button>
                        <button
                          type="button"
                          className="me-btn me-btn-danger"
                          disabled={busy}
                          onClick={() => runSuggestions('reject', [index + 1])}
                        >
                          {t('panel.suggestions.reject')}
                        </button>
                      </span>
                    </div>
                    <textarea
                      className="me-item-edit"
                      rows={3}
                      value={edits[index + 1] ?? entry.content}
                      onChange={(event) => setEdits((prev) => ({ ...prev, [index + 1]: event.target.value }))}
                    />
                    <p className="me-item-reason">
                      {entry.reason !== undefined && entry.reason !== '' ? entry.reason : t('panel.suggestions.editHint')}
                    </p>
                  </li>
                ))}
              </ul>
              <div className="me-bulk">
                <button type="button" className="me-btn me-btn-ok" disabled={busy} onClick={() => runSuggestions('approve-all')}>
                  {t('panel.suggestions.approveAll')}
                </button>
                <button type="button" className="me-btn me-btn-danger" disabled={busy} onClick={() => runSuggestions('reject-all')}>
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
                  <input
                    type="checkbox"
                    className="me-switch"
                    checked={draft.searchDocsEnabled}
                    onChange={(event) => patchDraft({ searchDocsEnabled: event.target.checked })}
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
