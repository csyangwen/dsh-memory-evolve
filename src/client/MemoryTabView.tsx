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
import { MemoryQueueView } from './MemoryQueueView.tsx'
import { TabGuideView, type GuideSection } from './TabGuideView.tsx'

/**
 * 功能子 tab（记忆专属）：指南 / 待确认记忆建议。
 * 整体指南与运行时配置已抽到「Memory Evolve 设置」Tab（SettingsTabView）；
 * 本 Tab 的「指南」是记忆功能自己的详细介绍（非整体简介）。
 */
type TabFeature = 'guide' | 'suggestions'

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
  /** 「仅 DSH」标记（[dsh-only]）：该条目只注入 DSH 自身，注入外部执行器（COI）时跳过。 */
  dshOnly: boolean
  /** 剥离前缀后的正文。 */
  text: string
  /** 剥离前/解析前的完整条目原文（含时间戳），删除时按它精确匹配。 */
  raw: string
}

/** § 条目分隔符，与 lib/store.js 的 ENTRY_DELIMITER 保持一致。 */
const ENTRY_DELIMITER = '\n§\n'

/** key 条目分支标记：`[2026-08-06] [branch:main,dev] 内容`。 */
const BRANCH_TAG_RE = /(?:^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*)?\[branch:([^\]]*)\]\s*/

/** 「仅 DSH」标记：`[2026-08-06] [dsh-only] 内容`（任意位置出现即视为已标记）。 */
const DSH_ONLY_RE = /\[dsh-only\]\s*/

/** 各轨时间戳前缀：project 带日期时间，daily 只有时分，其余为日期。 */
const TIME_PREFIX = {
  project: /^\[(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(?::\d{2})?)\]\s*/,
  daily: /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/,
  date: /^\[(\d{4}-\d{2}-\d{2})\]\s*/,
} as const

/** 美观视图下按 § 条目解析的文件（AGENTS.md 始终纯文本）。 */
const ENTRY_KEYS = new Set(['memory', 'user', 'archive-memory', 'archive-user', 'archive-key', 'project', 'key', 'daily'])

/** 美观视图下可编辑正文的文件（五个主轨；归档只读，可移回后编辑）。 */
const EDIT_KEYS = new Set(['memory', 'user', 'project', 'key', 'daily'])

/** 注入轨：保存后会立即进入模型上下文（编辑保存需确认）。 */
const INJECTED_KEYS = new Set(['memory', 'user', 'key'])

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
    let dshOnly = false
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
      // 「仅 DSH」标记 [dsh-only]（branch/项目标签之后、正文之前；剥离显示，
      // 与 lib/store.js splitEntryHead 的解析顺序保持一致）
      if (DSH_ONLY_RE.test(text)) {
        dshOnly = true
        text = text.replace(DSH_ONLY_RE, '')
      }
    }
    entries.push({ time, tag, branch, text, branches, dshOnly, raw: rawText })
  }
  return entries
}

/** 关键词匹配：内容 / 时间 / 标签，大小写不敏感（q 已转小写）。 */
function entryMatches(entry: MemoryEntry, q: string): boolean {
  return entry.text.toLowerCase().includes(q)
    || (entry.time ?? '').toLowerCase().includes(q)
    || (entry.tag ?? '').toLowerCase().includes(q)
}

/**
 * 美观视图分页大小（2026-08-10）：项目日志/每日日志是追加增长型文件
 * （一年可达几千条），一次性渲染全部条目会卡顿；按条目分页，每页 50 条。
 */
const PAGE_SIZE = 50

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

/**
 * 记忆 Tab 专属指南内容（「指南」子 Tab）：
 * 详细介绍记忆功能本身——五轨记忆、文件页签、git 分支感知、编辑维护、
 * 待确认记忆建议机制。文案来自全局 locale（memoryTab.guide.* 键组）。
 */
function memoryGuideSections(t: Translate): GuideSection[] {
  return [
    {
      icon: '🧠',
      title: t('memoryTab.guide.tracks.title'),
      body: t('memoryTab.guide.tracks.body'),
      items: [
        t('memoryTab.guide.tracks.item1'),
        t('memoryTab.guide.tracks.item2'),
        t('memoryTab.guide.tracks.item3'),
        t('memoryTab.guide.tracks.item4'),
        t('memoryTab.guide.tracks.item5'),
      ],
    },
    {
      icon: '📂',
      title: t('memoryTab.guide.files.title'),
      body: t('memoryTab.guide.files.body'),
      items: [
        t('memoryTab.guide.files.item1'),
        t('memoryTab.guide.files.item2'),
        t('memoryTab.guide.files.item3'),
      ],
    },
    {
      icon: '🌿',
      title: t('memoryTab.guide.branch.title'),
      body: t('memoryTab.guide.branch.body'),
      items: [
        t('memoryTab.guide.branch.item1'),
        t('memoryTab.guide.branch.item2'),
      ],
    },
    {
      icon: '🛠️',
      title: t('memoryTab.guide.maintain.title'),
      body: t('memoryTab.guide.maintain.body'),
      items: [
        t('memoryTab.guide.maintain.item1'),
        t('memoryTab.guide.maintain.item2'),
        t('memoryTab.guide.maintain.item3'),
      ],
    },
    {
      icon: '✅',
      title: t('memoryTab.guide.suggestions.title'),
      body: t('memoryTab.guide.suggestions.body'),
      items: [
        t('memoryTab.guide.suggestions.item1'),
        t('memoryTab.guide.suggestions.item2'),
      ],
    },
    {
      icon: '🛡️',
      title: t('memoryTab.guide.confirm.title'),
      body: t('memoryTab.guide.confirm.body'),
    },
  ]
}

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
  // 美观视图分页（大文件如项目日志按条目分页渲染，每页 PAGE_SIZE 条）
  const [page, setPage] = useState(0)
  /** 当前激活的文件 key（tab 切换）。 */
  const [activeKey, setActiveKey] = useState<string | null>(persistedFileKey)
  /** 手动添加项目关键记忆的草稿与保存状态。 */
  const [keyDraft, setKeyDraft] = useState('')
  const [keySaving, setKeySaving] = useState(false)
  /** 手动添加时的「仅 DSH」勾选：勾上 = 条目带 [dsh-only] 标记（只注入 DSH 自身，外部执行器跳过）。 */
  const [keyDshOnly, setKeyDshOnly] = useState(false)
  /** 手动添加时的分支范围选择：[] = 全部（与具体分支互斥，全部权重最大）。 */
  const [keyScope, setKeyScope] = useState<string[]>([])
  /** 正在编辑分支范围的条目 raw（null = 未在编辑）。 */
  const [scopeEdit, setScopeEdit] = useState<string | null>(null)
  const [scopeDraft, setScopeDraft] = useState<string[]>([])
  const [scopeSaving, setScopeSaving] = useState(false)
  /** 正在编辑正文的条目 raw（null = 未在编辑）；草稿与保存状态。 */
  const [editEntryRaw, setEditEntryRaw] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  /** 删除条目进行中（防止连点并发删除）。 */
  const [deleting, setDeleting] = useState(false)
  /** 功能子 tab：null = 文件视图；否则显示待确认记忆/技能/运行时配置/技能管理面板。 */
  const [feature, setFeature] = useState<TabFeature | null>(persistedFeature)
  /** 待确认记忆建议计数（来自 /api/badge，用于功能 tab 的徽标文本）。 */
  const [badge, setBadge] = useState<{ suggestions: number }>({ suggestions: 0 })

  /** 拉取待确认记忆建议计数（功能 tab 徽标）。 */
  const pollBadge = useCallback((): void => {
    void api<{ suggestions?: number }>('/api/badge')
      .then((data) => setBadge({ suggestions: data.suggestions ?? 0 }))
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
      body: JSON.stringify({ sessionId: String(sessionId), content, branches: keyScope, dshOnly: keyDshOnly }),
    }).then(() => {
      setKeyDraft('')
      setKeyDshOnly(false)
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

  /** 切换一条目的「仅 DSH」标记（[dsh-only]）：标记 = 只注入 DSH 自身，
   *  注入外部执行器（COI 任务的 injectTracks）时整条跳过。整条原文精确匹配。 */
  const toggleDshOnly = (entry: MemoryEntry): void => {
    if (activeRow === null || deleting) return
    setDeleting(true)
    void api<{ ok: boolean }>('/api/memory/dsh-only', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: String(sessionId),
        target: activeRow.key,
        match: entry.raw,
        on: !entry.dshOnly,
      }),
    }).then(() => {
      load()
      flash(entry.dshOnly ? t('memoryTab.dshOnlyRemoved') : t('memoryTab.dshOnlySet'))
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: error.message })
    }).finally(() => setDeleting(false))
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

  /** 开始编辑某条正文（草稿=当前正文）。 */
  const startEdit = (entry: MemoryEntry): void => {
    setEditEntryRaw(entry.raw)
    setEditDraft(entry.text)
  }

  /** 保存正文编辑：只改内容，时间戳/tag 由宿主保留；§ 分隔符输入即过滤。
   *  注入轨（memory/user/key）保存后立即进入模型上下文，需用户确认。 */
  const saveEdit = (): void => {
    if (editEntryRaw === null || activeRow === null || editSaving) return
    const content = editDraft.trim()
    if (content === '') return
    if (INJECTED_KEYS.has(activeRow.key)) {
      const snippet = content.length > 60 ? `${content.slice(0, 60)}…` : content
      if (!window.confirm(t('memoryTab.editConfirm', { snippet }))) return
    }
    setEditSaving(true)
    void api<{ ok: boolean }>('/api/memory/update', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: String(sessionId),
        target: activeRow.key,
        match: editEntryRaw,
        content: editDraft,
      }),
    }).then(() => {
      setEditEntryRaw(null)
      load()
      flash(t('memoryTab.updated'))
    }).catch((error: Error) => {
      setNotice({ kind: 'error', text: error.message })
    }).finally(() => setEditSaving(false))
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
  // 分页：先倒序（最新在前）再切页——每页都是连续的最新条目；
  // 页码越界（搜索/删除后条目变少）时自动回退到最后一页。
  const pageCount = activeEntries === null ? 1 : Math.max(1, Math.ceil(activeEntries.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageEntries = activeEntries === null
    ? null
    : [...activeEntries].reverse().slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  return (
    <div className="mt-panel">
      {notice !== null && (
        <div className={`mt-notice mt-notice-${notice.kind}`}>{notice.text}</div>
      )}
      {/* 功能 tab 与文件页签合并为一行：功能在前，竖线分隔；点功能 tab
          时文件页签仍可见，可随时切回文件视图 */}
      <div className="mt-file-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'guide'}
          className={feature === 'guide' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature(feature === 'guide' ? null : 'guide')}
        >
          {t('memoryTab.feature.guide')}
        </button>
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
        <span className="mt-tab-sep" role="presentation" />
        {files !== null && (files ?? []).map((row) => (
          <button
            key={row.key}
            type="button"
            role="tab"
            aria-selected={row.key === activeKey}
            className={row.key === activeKey ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
            onClick={() => {
              // 点文件页签 → 切回文件视图并选中该文件（功能面板与文件视图互斥）；
              // 页码重置回第一页（新文件的条目列表从头开始）
              setActiveKey(row.key)
              setFeature(null)
              setPage(0)
            }}
          >
            {row.title}
          </button>
        ))}
      </div>
      <p className="mt-warning">⚠️ {t('memoryTab.warning')}</p>
      {cwd !== null && <p className="mt-cwd">{t('memoryTab.cwd')}: {cwd}</p>}
      {feature !== null ? (
        feature === 'guide' ? (
          // 记忆专属指南：详细介绍记忆 Tab 自己的功能（五轨/文件页签/分支/
          // 编辑维护/待确认建议机制）。整体插件指南在「Memory Evolve 设置」Tab。
          <TabGuideView sections={memoryGuideSections(t)} />
        ) : (
          <MemoryQueueView
            t={t}
            feature="suggestions"
            onChanged={() => {
              // 队列变更后：刷新本组件计数，并通知宿主层（index.ts）
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
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(0) // 搜索条件变化 → 回到第一页
              }}
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
                    <label className="mt-key-dsh-opt" title={t('memoryTab.dshOnlyHint')}>
                      <input
                        type="checkbox"
                        checked={keyDshOnly}
                        onChange={(event) => setKeyDshOnly(event.target.checked)}
                      />
                      {t('memoryTab.dshOnlyAdd')}
                    </label>
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
                  {(pageEntries ?? []).map((entry, index) => (
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
                        {entry.dshOnly && (
                          <span className="mt-entry-dsh-only" title={t('memoryTab.dshOnlyHint')}>
                            🔒 {t('memoryTab.dshOnly')}
                          </span>
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
                          {EDIT_KEYS.has(activeRow.key) && editEntryRaw !== entry.raw && (
                            <button
                              type="button"
                              className="mt-btn mt-entry-op"
                              title={t('memoryTab.edit')}
                              disabled={deleting}
                              onClick={() => startEdit(entry)}
                            >
                              {t('memoryTab.edit')}
                            </button>
                          )}
                          {(activeRow.key === 'memory' || activeRow.key === 'user' || activeRow.key === 'key') && (
                            <button
                              type="button"
                              className={`mt-btn mt-entry-op${entry.dshOnly ? ' mt-entry-dsh-on' : ''}`}
                              title={t('memoryTab.dshOnlyToggleHint')}
                              disabled={deleting}
                              onClick={() => toggleDshOnly(entry)}
                            >
                              {entry.dshOnly ? t('memoryTab.dshOnlyOff') : t('memoryTab.dshOnlyOn')}
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
                      {editEntryRaw === entry.raw ? (
                        <div className="mt-entry-edit">
                          <textarea
                            className="mt-item-edit"
                            rows={3}
                            value={editDraft}
                            onChange={(event) => setEditDraft(event.target.value.replaceAll('§', ''))}
                          />
                          <div className="mt-entry-edit-row">
                            <span className="mt-entry-edit-hint">{t('memoryTab.editHint')}</span>
                            <button
                              type="button"
                              className="mt-btn mt-btn-primary"
                              disabled={editSaving || editDraft.trim() === ''}
                              onClick={saveEdit}
                            >
                              {t('memoryTab.save')}
                            </button>
                            <button type="button" className="mt-btn" disabled={editSaving} onClick={() => setEditEntryRaw(null)}>
                              {t('memoryTab.cancel')}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="mt-entry-text">{entry.text}</p>
                      )}
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
              {/* 分页器：仅多页时显示；上一页/下一页 + 页码 + 总条数 */}
              {activeEntries !== null && pageCount > 1 && (
                <div className="mt-pager">
                  <button
                    type="button"
                    className="mt-btn"
                    disabled={safePage <= 0}
                    onClick={() => setPage(safePage - 1)}
                  >
                    {t('memoryTab.pagePrev')}
                  </button>
                  <span className="mt-pager-info">
                    {t('memoryTab.pageInfo', { page: safePage + 1, total: pageCount, count: activeEntries.length })}
                  </span>
                  <button
                    type="button"
                    className="mt-btn"
                    disabled={safePage >= pageCount - 1}
                    onClick={() => setPage(safePage + 1)}
                  >
                    {t('memoryTab.pageNext')}
                  </button>
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
