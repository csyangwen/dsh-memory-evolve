/**
 * dsh-memory-evolve — session memory tab (conversation.view entry).
 *
 * Shows the global rule file and the four memory tracks inline, read-only,
 * plus an "open with system tool" button per file. Editing happens through
 * the memory tool or the system editor (the tab never writes: hand-editing
 * the §-delimited files in a textarea could corrupt the entry format the
 * memory tool parses). Pure reader of the host API — the tab itself never
 * changes injected context, so it has zero effect on LLM prefix caching.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** One memory-file row from the host. */
interface MemoryFileRow {
  key: string
  title: string
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
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [cwd, setCwd] = useState<string | null>(null)

  const load = useCallback((): void => {
    setFiles(null)
    void api<{ files: MemoryFileRow[]; cwd: string | null }>(
      `/api/memory-files?sessionId=${encodeURIComponent(String(sessionId))}`,
    ).then((res) => {
      setFiles(res.files)
      setCwd(res.cwd)
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: error.message })
      setFiles([])
    })
  }, [sessionId])

  useEffect(() => {
    load()
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
          {files.map((row) => (
            <div key={row.key} className="mt-card">
              <div className="mt-card-head">
                <span className="mt-card-title">{row.title}</span>
                <span className="mt-badge mt-badge-ro">{t('memoryTab.readonly')}</span>
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
              ) : (
                <pre className="mt-content">
                  {row.exists ? row.content : t('memoryTab.empty')}
                </pre>
              )}
              {row.truncated && <p className="mt-muted">{t('memoryTab.truncated')}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
