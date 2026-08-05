/**
 * dsh-memory-evolve — session memory tab (conversation.view entry).
 *
 * Shows the global rule file and the four memory tracks inline (read-only
 * for agents/memory/user; project and daily are editable) plus an
 * "open with system tool" button per file. Pure reader of the host API —
 * the tab itself never changes injected context, so it has zero effect on
 * LLM prefix caching.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** One memory-file row from the host. */
interface MemoryFileRow {
  key: string
  title: string
  editable: boolean
  available: boolean
  exists: boolean
  truncated: boolean
  path?: string
  content: string
}

/** Locale-bound props (the `memoryEvolve` namespace). */
export interface MemoryTabViewProps {
  t: Translate
}

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

/** The conversation view tab component. */
export function MemoryTabView(props: ConvViewProps & MemoryTabViewProps): JSX.Element {
  const { sessionId, t } = props
  const [files, setFiles] = useState<MemoryFileRow[] | null>(null)
  /** Editable-track drafts keyed by row key. */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [cwd, setCwd] = useState<string | null>(null)

  const load = useCallback((keep: boolean): void => {
    if (!keep) setFiles(null)
    void api<{ files: MemoryFileRow[]; cwd: string | null }>(
      `/api/memory-files?sessionId=${encodeURIComponent(String(sessionId))}`,
    ).then((res) => {
      setFiles(res.files)
      setCwd(res.cwd)
      // Editable tracks start in edit mode prefilled with their current
      // content, so the user sees what they are about to change.
      const initial: Record<string, string> = {}
      for (const file of res.files) {
        if (file.editable && file.available) initial[file.key] = file.content
      }
      setDrafts(initial)
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: error.message })
      if (!keep) setFiles([])
    })
  }, [sessionId])

  useEffect(() => {
    load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Transient ok notice: auto-dismiss so it never lingers. */
  const flash = (text: string): void => {
    setNotice({ kind: 'ok', text })
    window.setTimeout(() => {
      setNotice((current) => (current?.text === text ? null : current))
    }, 3500)
  }

  const openWithSystem = (row: MemoryFileRow): void => {
    const target = row.key === 'memory' ? 'memoryFile'
      : row.key === 'user' ? 'userFile'
        : row.key === 'daily' ? 'dailyFile'
          : row.key === 'project' ? 'projectsDir'
            : 'agentsFile'
    void api<{ ok: boolean }>('/api/reveal', { method: 'POST', body: JSON.stringify({ target }) })
      .then(() => flash(t('memoryTab.opened')))
      .catch((error: Error) => setNotice({ kind: 'error', text: error.message }))
  }

  const save = (row: MemoryFileRow): void => {
    setSaving(row.key)
    setNotice(null)
    void api<{ ok: boolean }>('/api/memory-files/save', {
      method: 'POST',
      body: JSON.stringify({
        key: row.key,
        content: drafts[row.key] ?? '',
        sessionId: String(sessionId),
      }),
    }).then(() => {
      flash(t('memoryTab.saved'))
      // Silent refresh: keep the current list rendered, just re-fetch rows.
      load(true)
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: error.message })
    }).finally(() => setSaving(null))
  }

  return (
    <div className="mt-panel">
      {notice !== null && (
        <div className={`mt-notice mt-notice-${notice.kind}`}>{notice.text}</div>
      )}
      {cwd !== null && <p className="mt-cwd">{t('memoryTab.cwd')}: {cwd}</p>}
      {files === null ? (
        <p className="mt-muted">{t('memoryTab.loading')}</p>
      ) : (
        <div className="mt-list">
          {files.map((row) => {
            const dirty = row.available && (drafts[row.key] ?? row.content) !== row.content
            return (
              <div key={row.key} className="mt-card">
                <div className="mt-card-head">
                  <span className="mt-card-title">{row.title}</span>
                  <span className={`mt-badge ${row.editable ? 'mt-badge-edit' : 'mt-badge-ro'}`}>
                    {row.editable ? t('memoryTab.editable') : t('memoryTab.readonly')}
                  </span>
                  {row.path !== undefined && <span className="mt-card-path" title={row.path}>{row.path}</span>}
                  {row.available && (
                    <span className="mt-card-actions">
                      <button type="button" className="mt-btn" onClick={() => openWithSystem(row)}>
                        {t('memoryTab.open')}
                      </button>
                    </span>
                  )}
                </div>
                {!row.available ? (
                  <p className="mt-muted">{t('memoryTab.noCwd')}</p>
                ) : row.editable ? (
                  <div className="mt-edit">
                    {!row.exists && <p className="mt-muted">{t('memoryTab.willCreate')}</p>}
                    <textarea
                      className="mt-textarea"
                      rows={8}
                      value={drafts[row.key] ?? row.content}
                      onChange={(event) => setDrafts((prev) => ({ ...prev, [row.key]: event.target.value }))}
                    />
                    <div className="mt-edit-actions">
                      <button
                        type="button"
                        className="mt-btn mt-btn-primary"
                        disabled={saving === row.key || !dirty || row.truncated}
                        title={row.truncated ? t('memoryTab.truncatedSaveBlocked') : undefined}
                        onClick={() => save(row)}
                      >
                        {saving === row.key ? t('memoryTab.saving') : t('memoryTab.save')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <pre className="mt-content">
                    {row.exists ? row.content : t('memoryTab.empty')}
                  </pre>
                )}
                {row.truncated && <p className="mt-muted">{t('memoryTab.truncated')}</p>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
