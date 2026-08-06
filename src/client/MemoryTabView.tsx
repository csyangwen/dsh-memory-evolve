/**
 * dsh-memory-evolve — session memory tab (conversation.view entry).
 *
 * Shows the global rule file and the five memory tracks inline, read-only,
 * plus an "open with system tool" button per file. Editing happens through
 * the memory tool, the system editor, or two tab-level helpers: the KEY
 * track's manual-add box and the pretty view's per-entry delete button
 * (both go through the host API, never raw text edits — hand-editing the
 * §-delimited files in a textarea could corrupt the entry format the
 * memory tool parses). Pure reader of the host API — the tab itself never
 * changes injected context, so it has zero effect on LLM prefix caching.
 *
 * Two view modes: the default "pretty" view parses each §-delimited file
 * into entry cards (timestamp badge + optional project tag + text, delete
 * button per entry), while the "raw" view keeps the original <pre> dump.
 * The toolbar search filters entries (pretty) or whole files (raw)
 * case-insensitively.
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

/** 视图模式：美观（条目卡片）/ 纯文本（原始 <pre>）。 */
type ViewMode = 'pretty' | 'raw'

/** 一条解析后的 § 条目：可选时间戳 + 可选项目标签 + 正文 + 原始全文。 */
interface MemoryEntry {
  time: string | null
  tag: string | null
  text: string
  /** 剥离前/解析前的完整条目原文（含时间戳），删除时按它精确匹配。 */
  raw: string
}

/** § 条目分隔符，与 lib/store.js 的 ENTRY_DELIMITER 保持一致。 */
const ENTRY_DELIMITER = '\n§\n'

/** 各轨时间戳前缀：project 带日期时间，daily 只有时分，其余为日期。 */
const TIME_PREFIX = {
  project: /^\[(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(?::\d{2})?)\]\s*/,
  daily: /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/,
  date: /^\[(\d{4}-\d{2}-\d{2})\]\s*/,
} as const

/** 美观视图下按 § 条目解析的文件（AGENTS.md 始终纯文本）。 */
const ENTRY_KEYS = new Set(['memory', 'user', 'archive-memory', 'archive-user', 'project', 'key', 'daily'])

/** 把文件内容拆成 § 条目，剥离时间戳前缀（daily 再剥离程序标注的项目标签）。 */
function parseEntries(row: MemoryFileRow): MemoryEntry[] {
  const prefix = row.key === 'project' ? TIME_PREFIX.project
    : row.key === 'daily' ? TIME_PREFIX.daily
      : TIME_PREFIX.date
  const entries: MemoryEntry[] = []
  for (const raw of row.content.split(ENTRY_DELIMITER)) {
    let text = raw.trim()
    if (text === '') continue
    const rawText = text // 完整原文（含时间戳），删除时精确匹配用
    let time: string | null = null
    let tag: string | null = null
    const timeMatch = prefix.exec(text)
    if (timeMatch !== null) {
      time = timeMatch[1]
      text = text.slice(timeMatch[0].length)
      if (row.key === 'daily') {
        const tagMatch = /^\[([^\]]+)\]\s*/.exec(text)
        if (tagMatch !== null) {
          tag = tagMatch[1]
          text = text.slice(tagMatch[0].length)
        }
      }
    }
    entries.push({ time, tag, text, raw: rawText })
  }
  return entries
}

/** 关键词匹配：内容 / 时间 / 标签，大小写不敏感（q 已转小写）。 */
function entryMatches(entry: MemoryEntry, q: string): boolean {
  return entry.text.toLowerCase().includes(q)
    || (entry.time ?? '').toLowerCase().includes(q)
    || (entry.tag ?? '').toLowerCase().includes(q)
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
  const [view, setView] = useState<ViewMode>('pretty')
  const [query, setQuery] = useState('')
  /** 当前激活的文件 key（tab 切换）。 */
  const [activeKey, setActiveKey] = useState<string | null>(null)
  /** 手动添加项目关键记忆的草稿与保存状态。 */
  const [keyDraft, setKeyDraft] = useState('')
  const [keySaving, setKeySaving] = useState(false)
  /** 删除条目进行中（防止连点并发删除）。 */
  const [deleting, setDeleting] = useState(false)

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

  // 默认选中第一个可用文件；激活 key 失效时自动回退到可用文件
  useEffect(() => {
    if (files === null || files.length === 0) return
    if (activeKey !== null && files.some((row) => row.key === activeKey)) return
    const fallback = files.find((row) => row.available) ?? files[0]
    setActiveKey(fallback.key)
  }, [files, activeKey])

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
          : row.key === 'project' || row.key === 'key' ? 'projectsDir'
            : row.key === 'archive-memory' ? 'archiveMemoryFile'
              : row.key === 'archive-user' ? 'archiveUserFile'
                : 'agentsFile'
    void api<{ ok: boolean }>('/api/reveal', { method: 'POST', body: JSON.stringify({ target }) })
      .then(() => flash(t('memoryTab.opened')))
      .catch((error: Error) => setNotice({ kind: 'error', text: error.message }))
  }

  /** 手动写入一条项目关键记忆：走宿主 API 的 store.add，保持 § 格式与程序盖戳。 */
  const saveKey = (): void => {
    const content = keyDraft.trim()
    if (content === '' || keySaving) return
    setKeySaving(true)
    void api<{ ok: boolean }>('/api/memory/key', {
      method: 'POST',
      body: JSON.stringify({ sessionId: String(sessionId), content }),
    }).then(() => {
      setKeyDraft('')
      load()
      flash(t('memoryTab.keyAdded'))
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: error.message })
    }).finally(() => setKeySaving(false))
  }

  /**
   * 删除一条记忆条目：先让用户确认，再把【完整条目原文】交给宿主
   * 精确删除（removeExact，整条相等匹配）——短条目不会误删长条目。
   */
  const deleteEntry = (entry: MemoryEntry): void => {
    if (activeRow === null || deleting) return
    const snippet = entry.text.length > 60 ? `${entry.text.slice(0, 60)}…` : entry.text
    if (!window.confirm(t('memoryTab.deleteConfirm', { snippet }))) return
    setDeleting(true)
    void api<{ ok: boolean }>('/api/memory/delete', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: String(sessionId),
        target: activeRow.key,
        match: entry.raw,
      }),
    }).then(() => {
      load()
      flash(t('memoryTab.deleted'))
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: error.message })
    }).finally(() => setDeleting(false))
  }

  /** 搜索词（小写）；空串表示不过滤。 */
  const q = query.trim().toLowerCase()

  /** 当前激活的文件；条目按需解析（raw/AGENTS 为 null）。 */
  const activeRow = (files ?? []).find((row) => row.key === activeKey) ?? null
  let activeEntries: MemoryEntry[] | null = null
  let activeHidden = false
  if (activeRow !== null && activeRow.available && activeRow.exists) {
    if (view === 'raw' || !ENTRY_KEYS.has(activeRow.key)) {
      // 纯文本视图 / AGENTS.md：按整个文件文本过滤
      activeHidden = q !== '' && !activeRow.content.toLowerCase().includes(q)
    } else {
      const all = parseEntries(activeRow)
      activeEntries = q === '' ? all : all.filter((entry) => entryMatches(entry, q))
      activeHidden = q !== '' && activeEntries.length === 0
    }
  }

  return (
    <div className="mt-panel">
      {notice !== null && (
        <div className={`mt-notice mt-notice-${notice.kind}`}>{notice.text}</div>
      )}
      <p className="mt-warning">⚠️ {t('memoryTab.warning')}</p>
      {cwd !== null && <p className="mt-cwd">{t('memoryTab.cwd')}: {cwd}</p>}
      {files === null ? (
        <p className="mt-muted">{t('memoryTab.loading')}</p>
      ) : (
        <>
          <div className="mt-file-tabs" role="tablist">
            {(files ?? []).map((row) => (
              <button
                key={row.key}
                type="button"
                role="tab"
                aria-selected={row.key === activeKey}
                className={row.key === activeKey ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
                onClick={() => setActiveKey(row.key)}
              >
                {row.title}
              </button>
            ))}
          </div>
          <div className="mt-toolbar">
            <div className="mt-view-toggle" role="group">
              <button
                type="button"
                className={view === 'pretty' ? 'mt-view-btn mt-view-btn-active' : 'mt-view-btn'}
                onClick={() => setView('pretty')}
              >
                {t('memoryTab.viewPretty')}
              </button>
              <button
                type="button"
                className={view === 'raw' ? 'mt-view-btn mt-view-btn-active' : 'mt-view-btn'}
                onClick={() => setView('raw')}
              >
                {t('memoryTab.viewRaw')}
              </button>
            </div>
            <input
              type="search"
              className="mt-search"
              value={query}
              placeholder={t('memoryTab.searchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {q !== '' && activeHidden && (
            <p className="mt-empty">{t('memoryTab.noResults')}</p>
          )}
          {activeRow !== null && (
            <div className="mt-card">
              <div className="mt-card-head">
                <span className="mt-card-title">{activeRow.title}</span>
                <span className="mt-badge mt-badge-ro">{t('memoryTab.readonly')}</span>
                {activeEntries !== null && (
                  <span className="mt-badge mt-badge-count">
                    {t('memoryTab.entryCount', { count: activeEntries.length })}
                  </span>
                )}
                {activeRow.path !== undefined && <span className="mt-card-path" title={activeRow.path}>{activeRow.path}</span>}
                {activeRow.available && (
                  <span className="mt-card-actions">
                    <button type="button" className="mt-btn" onClick={() => openWithSystem(activeRow)}>
                      {t('memoryTab.open')}
                    </button>
                  </span>
                )}
              </div>
              {activeRow.key === 'key' && activeRow.available && (
                <div className="mt-key-add">
                  <textarea
                    className="mt-key-input"
                    rows={2}
                    value={keyDraft}
                    placeholder={t('memoryTab.keyAddPlaceholder')}
                    onChange={(event) => setKeyDraft(event.target.value)}
                  />
                  <div className="mt-key-add-foot">
                    <span className="mt-key-help">{t('memoryTab.keyAddHelp')}</span>
                    <button
                      type="button"
                      className="mt-btn mt-btn-primary"
                      disabled={keySaving || keyDraft.trim() === ''}
                      onClick={saveKey}
                    >
                      {t('memoryTab.keyAdd')}
                    </button>
                  </div>
                </div>
              )}
              {!activeRow.available ? (
                <p className="mt-muted">{t('memoryTab.noCwd')}</p>
              ) : !activeRow.exists ? (
                <pre className="mt-content">{t('memoryTab.empty')}</pre>
              ) : activeEntries === null ? (
                <pre className="mt-content">{activeRow.content}</pre>
              ) : (
                <div className="mt-entries">
                  {[...activeEntries].reverse().map((entry, index) => (
                    <div key={index} className="mt-entry">
                      <div className="mt-entry-head">
                        {entry.time !== null && <span className="mt-entry-time">{entry.time}</span>}
                        {entry.tag !== null && (
                          <span className="mt-entry-tag" title={t('memoryTab.projectTag')}>{entry.tag}</span>
                        )}
                        <button
                          type="button"
                          className="mt-btn mt-entry-del"
                          title={t('memoryTab.delete')}
                          disabled={deleting}
                          onClick={() => deleteEntry(entry)}
                        >
                          {t('memoryTab.delete')}
                        </button>
                      </div>
                      <p className="mt-entry-text">{entry.text}</p>
                    </div>
                  ))}
                </div>
              )}
              {activeRow.truncated && <p className="mt-muted">{t('memoryTab.truncated')}</p>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
