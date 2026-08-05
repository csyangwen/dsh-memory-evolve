/**
 * dsh-memory-evolve — settings section panel.
 *
 * Two blocks: the pending-suggestion queue (approve/reject, backed by
 * /memory-evolve/api/suggestions) and the runtime-config form
 * (/memory-evolve/api/config). Styling uses DSH design tokens and the
 * `me-` class prefix. The root fills the settings content column
 * (`height: 100%` — the panel's scroll box is a block container).
 */
import { useEffect, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** Injected business face from the section registration. */
export interface MemoryPanelProps {
  /** Locale-bound translator for the memory-evolve namespace. */
  t: Translate
  /** Re-poll the badge and refresh the nav label. */
  refresh: () => void
}

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

/** Runtime config view (subset returned by /api/config). */
interface RuntimeConfig {
  reviewEnabled: boolean
  reviewInterval: number
  skillReviewEnabled: boolean
  autoApproveGlobal: boolean
  memoryTabEnabled: boolean
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

/** The settings section component. */
export function MemoryPanel(props: MemoryPanelProps): JSX.Element {
  const { t, refresh } = props
  const [entries, setEntries] = useState<SuggestionEntry[] | null>(null)
  /** Edited text per 1-based suggestion index (textarea values). */
  const [edits, setEdits] = useState<Record<number, string>>({})
  const [config, setConfig] = useState<RuntimeConfig | null>(null)
  const [draft, setDraft] = useState<RuntimeConfig | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = (): void => {
    void Promise.all([
      api<{ entries: SuggestionEntry[] }>('/api/suggestions'),
      api<{ config: RuntimeConfig }>('/api/config'),
    ]).then(([s, c]) => {
      // Facts that resurfaced in several reviews are the most likely to be
      // worth confirming — show them first.
      const entries = [...s.entries].sort((a, b) => (b.hits ?? 1) - (a.hits ?? 1))
      setEntries(entries)
      setEdits({})
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

  const runSuggestions = (op: 'approve' | 'reject' | 'approve-all' | 'reject-all', indices?: number[]): void => {
    setBusy(true)
    const body: { indices?: number[]; contents?: string[] } = {}
    if (indices !== undefined) {
      body.indices = indices
      if (op === 'approve') {
        const contents = indices.map((index) => edits[index] ?? '')
        // Send contents only when the user actually edited some entry; an
        // all-empty contents array would otherwise be treated as a real edit
        // of every entry ("" is not nullish), overwriting the suggestion.
        if (contents.some((content) => content !== '')) body.contents = contents
      }
    }
    void api<{ lines?: string[]; removed?: number; remaining: number }>(`/api/suggestions/${op}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((report) => {
      setNotice({ kind: 'ok', text: summarizeReport(report) })
      load()
      refresh()
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
      autoApproveGlobal: draft.autoApproveGlobal,
      memoryTabEnabled: draft.memoryTabEnabled,
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

  const revealTargets: Array<[string, string]> = [
    ['memoryDir', t('panel.reveal.memoryDir')],
    ['memoryFile', t('panel.reveal.memoryFile')],
    ['userFile', t('panel.reveal.userFile')],
    ['dailyFile', t('panel.reveal.dailyFile')],
    ['dailyDir', t('panel.reveal.dailyDir')],
    ['projectsDir', t('panel.reveal.projectsDir')],
    ['skillDir', t('panel.reveal.skillDir')],
    ['agentsFile', t('panel.reveal.agentsFile')],
  ]
  const reveal = (target: string): void => {
    void api<{ ok: boolean }>('/api/reveal', { method: 'POST', body: JSON.stringify({ target }) })
      .catch((error: Error) => {
        setNotice({ kind: 'error', text: t('panel.config.failed', { message: error.message }) })
      })
  }

  return (
    <div className="me-panel">
      {notice !== null && (
        <div className={`me-notice me-notice-${notice.kind}`}>{notice.text}</div>
      )}

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
                    <span className="me-badge me-badge-target">{entry.target}</span>
                    {(entry.hits ?? 1) > 1 && (
                      <span className="me-badge me-badge-hits" title={t('panel.suggestions.hitsHint')}>
                        {t('panel.suggestions.hits', { count: entry.hits ?? 1 })}
                      </span>
                    )}
                    <span className="me-item-time" title={entry.time}>{formatTime(entry.time)}</span>
                    <span className="me-item-actions">
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
                <span className="me-field-label">{t('panel.config.skillReviewEnabled')}</span>
                <input
                  type="checkbox"
                  className="me-switch"
                  checked={draft.skillReviewEnabled}
                  onChange={(event) => patchDraft({ skillReviewEnabled: event.target.checked })}
                />
              </label>
              <label className="me-field">
                <span className="me-field-label">
                  {t('panel.config.autoApproveGlobal')}
                  <em className="me-field-hint">{t('panel.config.autoApproveGlobal.hint')}</em>
                </span>
                <input
                  type="checkbox"
                  className="me-switch"
                  checked={draft.autoApproveGlobal}
                  onChange={(event) => patchDraft({ autoApproveGlobal: event.target.checked })}
                />
              </label>
              <label className="me-field">
                <span className="me-field-label">
                  {t('panel.config.memoryTabEnabled')}
                  <em className="me-field-hint">{t('panel.config.memoryTabEnabled.hint')}</em>
                </span>
                <input
                  type="checkbox"
                  className="me-switch"
                  checked={draft.memoryTabEnabled}
                  onChange={(event) => patchDraft({ memoryTabEnabled: event.target.checked })}
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

      <section className="me-block">
        <div className="me-block-head">
          <h3 className="me-heading">{t('panel.reveal.title')}</h3>
        </div>
        <p className="me-help">{t('panel.reveal.help')}</p>
        <div className="me-reveal-grid">
          {revealTargets.map(([target, label]) => (
            <button key={target} type="button" className="me-btn me-btn-reveal" onClick={() => reveal(target)}>
              {label}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
