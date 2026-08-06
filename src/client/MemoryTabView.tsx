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
import { MemoryQueueView, type MemoryFeature } from './MemoryQueueView.tsx'
import { SkillsBrowser } from './skills-browser/SkillsBrowser.tsx'
import { TodoView } from './TodoView.tsx'

/** 功能子 tab：待确认记忆/技能/运行时配置 + 技能管理（合并自 dsh-skill-browser）+ 待办。 */
type TabFeature = MemoryFeature | 'skill-browser' | 'todo'

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

/** 一条解析后的 § 条目：可选时间戳 + 可选项目标签 + 可选 git 分支 + 正文 + 原始全文。 */
interface MemoryEntry {
  time: string | null
  tag: string | null
  /** 程序标注的 git 分支（[git main]），daily/project 日志来源分支。 */
  branch: string | null
  /** key 轨的分支范围：null=全部，否则为分支名列表（来自 [branch:...] 标记）。 */
  branches: string[] | null
  /** 剥离前缀后的正文。 */
  text: string
  /** 剥离前/解析前的完整条目原文（含时间戳），删除时按它精确匹配。 */
  raw: string
}

/** § 条目分隔符，与 lib/store.js 的 ENTRY_DELIMITER 保持一致。 */
const ENTRY_DELIMITER = '\n§\n'

/** key 条目分支标记：`[2026-08-06] [branch:main,dev] 内容`。 */
const BRANCH_TAG_RE = /(?:^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*)?\[branch:([^\]]*)\]\s*/

/** 各轨时间戳前缀：project 带日期时间，daily 只有时分，其余为日期。 */
const TIME_PREFIX = {
  project: /^\[(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(?::\d{2})?)\]\s*/,
  daily: /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/,
  date: /^\[(\d{4}-\d{2}-\d{2})\]\s*/,
} as const

/** 美观视图下按 § 条目解析的文件（AGENTS.md 始终纯文本）。 */
const ENTRY_KEYS = new Set(['memory', 'user', 'archive-memory', 'archive-user', 'archive-key', 'project', 'key', 'daily'])

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
    let branch: string | null = null
    let branches: string[] | null = null
    const timeMatch = prefix.exec(text)
    if (timeMatch !== null) {
      time = timeMatch[1]
      text = text.slice(timeMatch[0].length)
      // daily/project 的程序分支 tag：[git main]（时间戳之后、项目标签/内容之前）
      if (row.key === 'daily' || row.key === 'project') {
        const gitMatch = /^\[git ([^\]]+)\]\s*/.exec(text)
        if (gitMatch !== null) {
          branch = gitMatch[1]
          text = text.slice(gitMatch[0].length)
        }
      }
      if (row.key === 'daily') {
        const tagMatch = /^\[([^\]]+)\]\s*/.exec(text)
        if (tagMatch !== null) {
          tag = tagMatch[1]
          text = text.slice(tagMatch[0].length)
        }
      } else if (row.key === 'key') {
        const branchMatch = BRANCH_TAG_RE.exec(rawText)
        if (branchMatch !== null) {
          const list = branchMatch[1].split(',').map((b) => b.trim()).filter(Boolean)
          branches = list.length > 0 ? list : null
          text = text.replace(BRANCH_TAG_RE, '')
        }
      }
    }
    entries.push({ time, tag, branch, text, branches, raw: rawText })
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

/** 跨重挂持久化的 tab 选择（模块级：badge 刷新导致的组件重挂后恢复）。 */
let persistedFeature: TabFeature | null = null
let persistedFileKey: string | null = null

/** The conversation view tab component. */
export function MemoryTabView(props: ConvViewProps & MemoryTabViewProps): JSX.Element {
  const { sessionId, t } = props
  // 跨重挂持久化：badge 变化时宿主会 deferral.refresh()（dispose+重新注册），
  // 组件被卸载重挂——功能 tab / 文件 tab 的选择必须恢复，否则处理完一条
  // 建议后视图就跳回文件页（模块级变量在重挂间共享）。
  const [files, setFiles] = useState<MemoryFileRow[] | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [cwd, setCwd] = useState<string | null>(null)
  /** 当前 git 分支（null=非 git/无法获取）；branches=全部分支（下拉选项）。 */
  const [branch, setBranch] = useState<string | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [view, setView] = useState<ViewMode>('pretty')
  const [query, setQuery] = useState('')
  /** 当前激活的文件 key（tab 切换）。 */
  const [activeKey, setActiveKey] = useState<string | null>(persistedFileKey)
  /** 手动添加项目关键记忆的草稿与保存状态。 */
  const [keyDraft, setKeyDraft] = useState('')
  const [keySaving, setKeySaving] = useState(false)
  /** 手动添加时的分支范围选择：[] = 全部（与具体分支互斥，全部权重最大）。 */
  const [keyScope, setKeyScope] = useState<string[]>([])
  /** 正在编辑分支范围的条目 raw（null = 未在编辑）。 */
  const [scopeEdit, setScopeEdit] = useState<string | null>(null)
  const [scopeDraft, setScopeDraft] = useState<string[]>([])
  const [scopeSaving, setScopeSaving] = useState(false)
  /** 删除条目进行中（防止连点并发删除）。 */
  const [deleting, setDeleting] = useState(false)
  /** 功能子 tab：null = 文件视图；否则显示待确认记忆/技能/运行时配置/技能管理面板。 */
  const [feature, setFeature] = useState<TabFeature | null>(persistedFeature)
  /** 待确认计数（来自 /api/badge，用于功能 tab 的徽标文本）。 */
  const [badge, setBadge] = useState<{ suggestions: number; skills: number }>({ suggestions: 0, skills: 0 })

  /** 拉取待确认计数（功能 tab 徽标）。 */
  const pollBadge = useCallback((): void => {
    void api<{ suggestions?: number; skills?: number }>('/api/badge')
      .then((data) => setBadge({ suggestions: data.suggestions ?? 0, skills: data.skills ?? 0 }))
      .catch(() => { /* 徽标尽力而为 */ })
  }, [])

  useEffect(() => {
    pollBadge()
    const timer = window.setInterval(pollBadge, 30_000)
    return () => window.clearInterval(timer)
  }, [pollBadge])

  // 同步 tab 选择到模块级：badge 刷新导致的组件重挂（deferral.refresh()）
  // 后恢复，避免处理完一条建议视图跳回文件页。
  useEffect(() => { persistedFeature = feature }, [feature])
  useEffect(() => { persistedFileKey = activeKey }, [activeKey])

  const load = useCallback((): void => {
    setFiles(null)
    void api<{ files: MemoryFileRow[]; cwd: string | null; branch: string | null; branches: string[] }>(
      `/api/memory-files?sessionId=${encodeURIComponent(String(sessionId))}`,
    ).then((res) => {
      setFiles(res.files)
      setCwd(res.cwd)
      setBranch(res.branch)
      setBranches(res.branches ?? [])
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
                : row.key === 'archive-key' ? 'projectsDir'
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
      body: JSON.stringify({ sessionId: String(sessionId), content, branches: keyScope }),
    }).then(() => {
      setKeyDraft('')
      load()
      flash(t('memoryTab.keyAdded'))
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: error.message })
    }).finally(() => setKeySaving(false))
  }

  /** 分支选择互斥：勾「全部」→ 清空所有分支；勾具体分支 → 自动取消「全部」（全部权重最大）。 */
  const toggleScopeBranch = (b: string): void => {
    setScopeDraft((prev) => (prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b]))
  }

  const toggleKeyScopeBranch = (b: string): void => {
    setKeyScope((prev) => (prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b]))
  }

  /** 打开某条目的分支范围编辑（草稿=当前范围）。 */
  const openScope = (entry: MemoryEntry): void => {
    setScopeEdit(entry.raw)
    setScopeDraft(entry.branches ?? [])
  }

  /** 保存分支范围：[] = 全部（后端移除标记）。 */
  const saveScope = (): void => {
    if (scopeEdit === null || activeRow === null || scopeSaving) return
    setScopeSaving(true)
    void api<{ ok: boolean }>('/api/key/scope', {
      method: 'POST',
      body: JSON.stringify({ sessionId: String(sessionId), match: scopeEdit, branches: scopeDraft }),
    }).then(() => {
      setScopeEdit(null)
      load()
      flash(t('memoryTab.keyScopeSaved'))
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: error.message })
    }).finally(() => setScopeSaving(false))
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

  /**
   * 主记忆 ↔ 归档 双向移动：memory/user/key 页签的「归档」把条目移入归档
   * 文件（不再注入，可随时移回）；archive-* 页签的「移回主记忆」转正。
   * 归档需确认（不再注入会话），转正可逆、直接执行。均传完整条目原文。
   */
  const moveEntry = (entry: MemoryEntry, op: 'archive' | 'promote'): void => {
    if (activeRow === null || deleting) return
    if (op === 'archive') {
      const snippet = entry.text.length > 60 ? `${entry.text.slice(0, 60)}…` : entry.text
      if (!window.confirm(t('memoryTab.archiveConfirm', { snippet }))) return
    }
    setDeleting(true)
    const path = op === 'archive' ? '/api/memory/archive' : '/api/archive/promote'
    const target = op === 'archive' ? activeRow.key
      : activeRow.key === 'archive-memory' ? 'memory'
        : activeRow.key === 'archive-key' ? 'key' : 'user'
    void api<{ ok: boolean }>(path, {
      method: 'POST',
      body: JSON.stringify({ sessionId: String(sessionId), target, match: entry.raw }),
    }).then(() => {
      load()
      flash(op === 'archive' ? t('memoryTab.archived') : t('memoryTab.promoted'))
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
      {/* 功能 tab 与文件页签合并为一行：功能在前，竖线分隔；点功能 tab
          时文件页签仍可见，可随时切回文件视图 */}
      <div className="mt-file-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'suggestions'}
          className={feature === 'suggestions' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature(feature === 'suggestions' ? null : 'suggestions')}
        >
          {t('memoryTab.feature.suggestions')}
          {badge.suggestions > 0 && <span className="mt-feature-count">{badge.suggestions}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'skills'}
          className={feature === 'skills' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature(feature === 'skills' ? null : 'skills')}
        >
          {t('memoryTab.feature.skills')}
          {badge.skills > 0 && <span className="mt-feature-count">{badge.skills}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'config'}
          className={feature === 'config' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature(feature === 'config' ? null : 'config')}
        >
          {t('memoryTab.feature.config')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'skill-browser'}
          className={feature === 'skill-browser' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature(feature === 'skill-browser' ? null : 'skill-browser')}
        >
          {t('memoryTab.feature.skillBrowser')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'todo'}
          className={feature === 'todo' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature(feature === 'todo' ? null : 'todo')}
        >
          {t('memoryTab.feature.todo')}
        </button>
        <span className="mt-tab-sep" role="presentation" />
        {files !== null && (files ?? []).map((row) => (
          <button
            key={row.key}
            type="button"
            role="tab"
            aria-selected={row.key === activeKey}
            className={row.key === activeKey ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
            onClick={() => {
              // 点文件页签 → 切回文件视图并选中该文件（功能面板与文件视图互斥）
              setActiveKey(row.key)
              setFeature(null)
            }}
          >
            {row.title}
          </button>
        ))}
      </div>
      {feature !== null ? (
        feature === 'skill-browser' ? (
          <SkillsBrowser t={t} />
        ) : feature === 'todo' ? (
          <TodoView t={t} sessionId={String(sessionId)} />
        ) : (
          <MemoryQueueView
            t={t}
            feature={feature}
            onChanged={() => {
              // 队列/技能/配置变更后：刷新本组件计数，并通知宿主层（index.ts）
              // 立即重查 badge，让会话页标签的小红点即时更新（不等 30s 轮询）。
              pollBadge()
              window.dispatchEvent(new CustomEvent('dsh-memory-evolve:badge-change'))
            }}
          />
        )
      ) : files === null ? (
        <p className="mt-muted">{t('memoryTab.loading')}</p>
      ) : (
        <>
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
              {/* 每个文件页签顶部的一行小字：该记忆的作用与机制 */}
              <p className="mt-card-desc">
                {t(`memoryTab.desc.${activeRow.key}`)}
                {activeRow.key === 'key' && branch !== null && (
                  <span className="mt-card-desc-branch"> {t('memoryTab.keyBranchInfo', { branch })}</span>
                )}
              </p>
              {activeRow.key === 'key' && activeRow.available && (
                <div className="mt-key-add">
                  <textarea
                    className="mt-key-input"
                    rows={2}
                    value={keyDraft}
                    placeholder={t('memoryTab.keyAddPlaceholder')}
                    onChange={(event) => setKeyDraft(event.target.value)}
                  />
                  {branches.length > 0 && (
                    <div className="mt-key-scope">
                      <span className="mt-key-scope-label">{t('memoryTab.keyScope')}:</span>
                      <label className="mt-scope-opt">
                        <input
                          type="checkbox"
                          checked={keyScope.length === 0}
                          onChange={() => setKeyScope([])}
                        />
                        {t('memoryTab.keyScopeAll')}
                      </label>
                      {branches.map((b) => (
                        <label key={b} className="mt-scope-opt">
                          <input
                            type="checkbox"
                            checked={keyScope.includes(b)}
                            onChange={() => toggleKeyScopeBranch(b)}
                          />
                          {b}
                        </label>
                      ))}
                    </div>
                  )}
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
                        {entry.branch !== null && (
                          <span className="mt-entry-branch mt-entry-branch-tag" title={t('memoryTab.gitBranch')}>
                            {entry.branch}
                          </span>
                        )}
                        {entry.tag !== null && (
                          <span className="mt-entry-tag" title={t('memoryTab.projectTag')}>{entry.tag}</span>
                        )}
                        {activeRow.key === 'key' && branches.length > 0 && (
                          <button
                            type="button"
                            className={entry.branches === null ? 'mt-entry-branch mt-entry-branch-all' : 'mt-entry-branch'}
                            title={entry.branches === null ? t('memoryTab.keyScopeAllHint') : t('memoryTab.keyScopeHint')}
                            onClick={() => openScope(entry)}
                          >
                            {t('memoryTab.keyScopeLabel')}: {entry.branches === null ? t('memoryTab.keyScopeAll') : entry.branches.join(', ')} ▾
                          </button>
                        )}
                        <span className="mt-entry-ops">
                          {(activeRow.key === 'memory' || activeRow.key === 'user' || activeRow.key === 'key') && (
                            <button
                              type="button"
                              className="mt-btn mt-entry-op"
                              title={t('memoryTab.archive')}
                              disabled={deleting}
                              onClick={() => moveEntry(entry, 'archive')}
                            >
                              {t('memoryTab.archive')}
                            </button>
                          )}
                          {(activeRow.key === 'archive-memory' || activeRow.key === 'archive-user' || activeRow.key === 'archive-key') && (
                            <button
                              type="button"
                              className="mt-btn mt-entry-op"
                              title={t('memoryTab.promote')}
                              disabled={deleting}
                              onClick={() => moveEntry(entry, 'promote')}
                            >
                              {t('memoryTab.promote')}
                            </button>
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
                        </span>
                      </div>
                      <p className="mt-entry-text">{entry.text}</p>
                      {activeRow.key === 'key' && scopeEdit === entry.raw && branches.length > 0 && (
                        <div className="mt-scope">
                          <span className="mt-key-scope-label">{t('memoryTab.keyScope')}:</span>
                          <label className="mt-scope-opt">
                            <input
                              type="checkbox"
                              checked={scopeDraft.length === 0}
                              onChange={() => setScopeDraft([])}
                            />
                            {t('memoryTab.keyScopeAll')}
                            <em className="mt-scope-all-hint">{t('memoryTab.keyScopeAllWeight')}</em>
                          </label>
                          {branches.map((b) => (
                            <label key={b} className="mt-scope-opt">
                              <input
                                type="checkbox"
                                checked={scopeDraft.includes(b)}
                                onChange={() => toggleScopeBranch(b)}
                              />
                              {b}
                            </label>
                          ))}
                          <span className="mt-scope-actions">
                            <button
                              type="button"
                              className="mt-btn mt-btn-primary"
                              disabled={scopeSaving}
                              onClick={saveScope}
                            >
                              {t('memoryTab.keyScopeSave')}
                            </button>
                            <button type="button" className="mt-btn" disabled={scopeSaving} onClick={() => setScopeEdit(null)}>
                              {t('memoryTab.keyScopeCancel')}
                            </button>
                          </span>
                        </div>
                      )}
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
