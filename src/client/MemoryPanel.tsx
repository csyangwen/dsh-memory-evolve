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
}

/** Runtime config view (subset returned by /api/config). */
interface RuntimeConfig {
  reviewEnabled: boolean
  reviewInterval: number
  reviewMode: string
  skillReviewEnabled: boolean
  injectProjectMemory: boolean
  injectDailySummary: boolean
  autoApproveGlobal: boolean
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
      setEntries(s.entries)
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
        body.contents = indices.map((index) => edits[index] ?? '')
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
    void api<{ config: RuntimeConfig }>('/api/config', {
      method: 'POST',
      body: JSON.stringify({ patch: draft }),
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
        <h3 className="me-heading">{t('panel.suggestions.title')}</h3>
        <p className="me-help">{t('panel.suggestions.help')}</p>
        {entries === null ? (
          <p className="me-muted">{t('panel.loading')}</p>
        ) : entries.length === 0 ? (
          <p className="me-muted">{t('panel.suggestions.empty')}</p>
        ) : (
          <>
            <ul className="me-list">
              {entries.map((entry, index) => (
                <li key={`${entry.time}-${index}`} className="me-item">
                  <div className="me-item-head">
                    <span className="me-badge me-badge-target">{entry.target}</span>
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
                        className="me-btn"
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
            <div className="me-item-actions me-actions-bulk">
              <button type="button" className="me-btn me-btn-ok" disabled={busy} onClick={() => runSuggestions('approve-all')}>
                {t('panel.suggestions.approveAll')}
              </button>
              <button type="button" className="me-btn" disabled={busy} onClick={() => runSuggestions('reject-all')}>
                {t('panel.suggestions.rejectAll')}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="me-block">
        <h3 className="me-heading">{t('panel.config.title')}</h3>
        <p className="me-help">{t('panel.config.help')}</p>
        {draft === null ? (
          <p className="me-muted">{t('panel.loading')}</p>
        ) : (
          <div className="me-form">
            <label className="me-field">
              <span className="me-field-label">
                {t('panel.config.reviewEnabled')}
                <em className="me-field-hint">{t('panel.config.reviewEnabled.hint')}</em>
              </span>
              <input
                type="checkbox"
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
                min={1}
                value={draft.reviewInterval}
                onChange={(event) => patchDraft({ reviewInterval: Number(event.target.value) })}
              />
            </label>
            <label className="me-field">
              <span className="me-field-label">{t('panel.config.reviewMode')}</span>
              <select
                value={draft.reviewMode}
                onChange={(event) => patchDraft({ reviewMode: event.target.value })}
              >
                <option value="suggest">{t('panel.config.reviewMode.suggest')}</option>
                <option value="auto">{t('panel.config.reviewMode.auto')}</option>
              </select>
            </label>
            <label className="me-field">
              <span className="me-field-label">{t('panel.config.skillReviewEnabled')}</span>
              <input
                type="checkbox"
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
                checked={draft.autoApproveGlobal}
                onChange={(event) => patchDraft({ autoApproveGlobal: event.target.checked })}
              />
            </label>
            <label className="me-field">
              <span className="me-field-label">{t('panel.config.injectProjectMemory')}</span>
              <input
                type="checkbox"
                checked={draft.injectProjectMemory}
                onChange={(event) => patchDraft({ injectProjectMemory: event.target.checked })}
              />
            </label>
            <label className="me-field">
              <span className="me-field-label">{t('panel.config.injectDailySummary')}</span>
              <input
                type="checkbox"
                checked={draft.injectDailySummary}
                onChange={(event) => patchDraft({ injectDailySummary: event.target.checked })}
              />
            </label>
            <div className="me-actions">
              <button type="button" className="me-btn me-btn-primary" disabled={busy} onClick={saveConfig}>
                {t('panel.config.save')}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="me-block">
        <h3 className="me-heading">{t('panel.reveal.title')}</h3>
        <p className="me-help">{t('panel.reveal.help')}</p>
        <div className="me-actions me-reveal-actions">
          {revealTargets.map(([target, label]) => (
            <button key={target} type="button" className="me-btn" onClick={() => reveal(target)}>
              {label}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
