/**
 * dsh-memory-evolve - memory usage audit panel (issue #57).
 *
 * Read-only view over GET /memory-evolve/api/audit: entry counts and byte
 * usage for the injected tracks compared against the default budgets.
 */
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** One audit track row returned by the host API. */
interface AuditTrack {
  target: 'memory' | 'user' | 'key'
  entries: number
  bytes: number
  budget: number
  /** Absent when the track could not be read (see the `error` field). */
  percent?: number
  overBudget: boolean
  error?: string
}

/** Audit report returned by GET /memory-evolve/api/audit. */
interface AuditReport {
  at: string
  tracks: AuditTrack[]
  /** Track targets currently above their byte budget (empty when all fit). */
  overBudget: AuditTrack['target'][]
  needsHygiene: boolean
}

/** Locale-bound props for the audit panel. */
export interface MemoryAuditViewProps {
  t: Translate
  sessionId: string
}

async function fetchAudit(path: string): Promise<AuditReport> {
  const res = await fetch(`/memory-evolve/api/audit${path}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<AuditReport>
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`
  }
  return `${bytes} B`
}

/** The memory hygiene sub-tab inside the session memory view. */
export function MemoryAuditView(props: MemoryAuditViewProps): JSX.Element {
  const { t, sessionId } = props
  const [report, setReport] = useState<AuditReport | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null)

  const load = (): void => {
    setReport(null)
    fetchAudit(`?sessionId=${encodeURIComponent(sessionId)}`)
      .then((value) => {
        setReport(value)
        setNotice(value.needsHygiene
          ? { kind: 'warn', text: t('memoryTab.audit.overBudget') }
          : { kind: 'ok', text: t('memoryTab.audit.within') })
      })
      .catch((error: Error) => {
        setNotice({ kind: 'error', text: error.message })
      })
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  return (
    <div className="me-panel">
      {notice !== null && (
        <div className={`me-notice me-notice-${notice.kind}`}>{notice.text}</div>
      )}
      <section className="me-block">
        <div className="me-block-head">
          <h3 className="me-heading">{t('memoryTab.audit.title')}</h3>
          <button
            type="button"
            className="me-btn"
            onClick={load}
          >
            {t('memoryTab.audit.refresh')}
          </button>
        </div>
        <p className="me-help">{t('memoryTab.audit.help')}</p>
        {report === null ? (
          <p className="me-muted">{t('memoryTab.audit.loading')}</p>
        ) : report.tracks.length === 0 ? (
          <p className="me-muted">{t('memoryTab.audit.noCwd')}</p>
        ) : (
          <div className="me-audit-grid" role="table" aria-label={t('memoryTab.audit.title')}>
            <div className="me-audit-row me-audit-row-head" role="row">
              <span role="columnheader">{t('memoryTab.audit.track')}</span>
              <span role="columnheader">{t('memoryTab.audit.entries')}</span>
              <span role="columnheader">{t('memoryTab.audit.bytes')}</span>
              <span role="columnheader">{t('memoryTab.audit.budget')}</span>
              <span role="columnheader">{t('memoryTab.audit.percent')}</span>
            </div>
            {report.tracks.map((track) => (
              <div
                key={track.target}
                className={`me-audit-row${track.overBudget ? ' me-audit-row-over' : ''}`}
                role="row"
              >
                <span role="cell" className="me-audit-track">{trackLabel(track.target, t)}</span>
                <span role="cell">{track.entries}</span>
                <span role="cell">{formatBytes(track.bytes)}</span>
                <span role="cell">{formatBytes(track.budget)}</span>
                <span role="cell">
                  {track.percent === undefined ? '—' : `${track.percent}%`}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      {report !== null && report.needsHygiene && (
        <p className="me-help">{t('memoryTab.audit.needsHygiene')}</p>
      )}
    </div>
  )
}

function trackLabel(target: AuditTrack['target'], t: Translate): string {
  if (target === 'memory') return t('memoryTab.audit.trackMemory')
  if (target === 'user') return t('memoryTab.audit.trackUser')
  return t('memoryTab.audit.trackKey')
}
