/**
 * dsh-memory-evolve — 提示词 tab（conversation.view 第四个 entry）。
 *
 * 提示词管理器：可复用的指令范式资产库 + 注入执行器。
 *   - 库：CRUD + 分类 + 标签 + 搜索筛选 + 复制 + 使用统计；来源以用户
 *     自写为主，内置程序员范式示例，另附 GitHub 范式库链接（用户自取）。
 *   - 注入：选中提示词 → 选择轮数 → 写注入轨（host 端），模型**下一轮**
 *     自动看到（一次性 = 1 轮；持续 N 轮 = 每对话回合递减，归零移除）；
 *     「注入中」浮层可随时提前移除。
 *
 * 数据来自 host 的 /memory-evolve/api/prompts 路由；样式在
 * prompt-styles.css（pm- 前缀，由 index.ts 注入）。组件内部自带中英文案
 * （默认中文，与 CoIView/ScratchView 一致），不接全局 locale。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** 提示词条目（与 host 端 PromptStore 一致）。 */
interface Prompt {
  id: string
  name: string
  category: string
  tags: string[]
  content: string
  createdAt: number
  updatedAt: number
  usageCount: number
  lastUsedAt: number | null
}

/** 活跃注入条目（与 host 端 InjectionStore 一致）。roundsLeft=null 表示无限。 */
interface Injection {
  id: string
  sourcePromptId: string | null
  title: string
  content: string
  roundsLeft: number | null
  every: number
  countdown: number
  createdAt: number
}

/** GitHub 范式来源链接。 */
interface Source {
  name: string
  url: string
  desc: string
}

/** Locale-bound props（与 MemoryTabView 一致，宽类型 Translate）。 */
export interface PromptViewProps {
  t: Translate
}

/** 中英文案（默认中文）。 */
const DICT = {
  zh: {
    search: '搜索名称、分类、标签或内容…',
    new: '新建提示词',
    all: '全部',
    uncategorized: '未分类',
    inject: '注入',
    injectRound: '注入 {n} 次',
    injectOnce: '注入 1 次（一次性）',
    injectInfinite: '无限次（持续注入）',
    injectCadence: '每 {n} 回合一次',
    everyTurn: '每回合',
    injectHint: '写入注入轨，模型下一轮自动看到；次数按对话回合消耗（可间隔注入），无限次则持续到手动停止',
    injecting: '注入中',
    injectingBadge: '注入中·剩{n}次',
    injectingBadgeInfinite: '注入中·持续',
    injectingIdle: '未注入',
    noInjection: '还没有注入中的提示词',
    removeInjection: '停止注入',
    stoppedInjection: '已停止注入',
    copy: '复制',
    copied: '已复制到剪贴板',
    save: '保存',
    saving: '保存中…',
    cancel: '取消',
    delete: '删除',
    deleteConfirm: '确定删除「{name}」？删除后不可恢复，其活跃注入会一并移除。',
    sources: 'GitHub 范式库来源',
    sourcesHint: '以下仓库有大量高质量提示词/规范（用户自取，不做自动导入）：',
    empty: '还没有提示词。点「新建提示词」开始，或从右侧来源链接获取灵感。',
    noMatch: '没有匹配的提示词',
    selectHint: '从左侧选择一个提示词查看，或点「新建提示词」',
    formNew: '新建提示词',
    formEdit: '编辑提示词',
    name: '名称',
    namePh: '如：代码审查（Code Review）',
    category: '分类',
    categoryPh: '如：开发流程（留空为「未分类」）',
    tags: '标签',
    tagsPh: '逗号分隔，如：review, 质量',
    content: '内容',
    contentPh: '在这里编写提示词正文…\n支持 {{date}}、{{time}} 变量，注入时自动展开。',
    usage: '已注入 {n} 次',
    lastUsed: '最近注入：{time}',
    neverUsed: '从未注入过',
    rounds: '次数',
    cadence: '间隔',
    error: '{message}',
    loadFailed: '加载失败：{message}',
    injected: '已注入「{name}」：{rounds}，{cadence}，模型下一轮生效',
    removed: '已移除注入',
    reload: '刷新',
    newCategory: '新分类',
    newCategoryPh: '输入分类名，回车确认',
    deleteCategory: '删除分类',
    renameCategory: '重命名分类',
    renamePh: '输入新分类名，回车确认',
    categoryRemoved: '已删除分类「{name}」{moved}',
    categoryDeleted: '已删除分类「{name}」',
    categoryMoved: '，{count} 条提示词已移到未分类',
    categoryExists: '分类「{name}」已存在，已为你选中',
    categoryRenamed: '已重命名「{from}」→「{to}」{renamed}',
    categoryRenamedSuffix: '，{count} 条提示词已同步',
  },
  en: {
    search: 'Search name, category, tags or content…',
    new: 'New prompt',
    all: 'All',
    uncategorized: 'Uncategorized',
    inject: 'Inject',
    injectRound: 'Inject {n} times',
    injectOnce: 'Inject once',
    injectInfinite: 'Unlimited (until stopped)',
    injectCadence: 'every {n} turns',
    everyTurn: 'every turn',
    injectHint: 'Writes to the injection track — visible to the model next turn; countdown consumes per conversation turn (interval injection supported); unlimited runs until stopped manually',
    injecting: 'Injecting',
    injectingBadge: 'injecting·{n} left',
    injectingBadgeInfinite: 'injecting·ongoing',
    injectingIdle: 'not injected',
    noInjection: 'Nothing is being injected right now',
    removeInjection: 'Stop',
    stoppedInjection: 'Injection stopped',
    copy: 'Copy',
    copied: 'Copied to clipboard',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    delete: 'Delete',
    deleteConfirm: 'Delete "{name}"? This cannot be undone and removes its active injections too.',
    sources: 'GitHub prompt sources',
    sourcesHint: 'These repos host high-quality prompts/specs (browse yourself — no auto import):',
    empty: 'No prompts yet. Click "New prompt" to start, or grab ideas from the source links.',
    noMatch: 'No matching prompts',
    selectHint: 'Select a prompt to view, or click "New prompt"',
    formNew: 'New prompt',
    formEdit: 'Edit prompt',
    name: 'Name',
    namePh: 'e.g. Code Review',
    category: 'Category',
    categoryPh: 'e.g. workflow (empty = Uncategorized)',
    tags: 'Tags',
    tagsPh: 'Comma-separated, e.g. review, quality',
    content: 'Content',
    contentPh: 'Write the prompt body here…\n{{date}} and {{time}} variables expand on inject.',
    usage: 'Injected {n} times',
    lastUsed: 'Last injected: {time}',
    neverUsed: 'Never injected',
    rounds: 'Count',
    cadence: 'Cadence',
    error: '{message}',
    loadFailed: 'Load failed: {message}',
    injected: 'Injected "{name}": {rounds}, {cadence} — visible to the model next turn',
    removed: 'Injection removed',
    reload: 'Reload',
    newCategory: 'New category',
    newCategoryPh: 'Type a category name, Enter to confirm',
    deleteCategory: 'Delete category',
    renameCategory: 'Rename category',
    renamePh: 'Type a new name, Enter to confirm',
    categoryRemoved: 'Category "{name}" deleted{moved}',
    categoryDeleted: 'Category "{name}" deleted',
    categoryMoved: ', {count} prompts moved to Uncategorized',
    categoryExists: 'Category "{name}" already exists — selected',
    categoryRenamed: 'Renamed "{from}" → "{to}"{renamed}',
    categoryRenamedSuffix: ', {count} prompts updated',
  },
} as const

type Lang = keyof typeof DICT

/** 选择文案的语言（默认中文）。 */
function pick(zhText: string, enText: string): string {
  return (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('en'))
    ? enText
    : zhText
}

/** 统一错误文本。 */
function errText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message || 'unknown error'
}

/** 格式化时间为本地字符串。 */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

/** 便捷 fetch：JSON 请求 + 统一错误抛出。 */
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  return data as T
}

/** 注入次数选项：0 = 无限（默认）。 */
const ROUND_OPTIONS = [0, 1, 3, 5, 10]
/** 注入间隔（回合数）选项：1 = 每回合（连续）。 */
const EVERY_OPTIONS = [1, 2, 3, 5, 10]

/**
 * 提示词 tab 组件。三栏信息架构：
 *   顶栏（搜索/筛选/注入中/新建/来源）→ 左分类树 → 中列表 → 右详情表单。
 * 操作成功（保存/删除/注入/移除）后重新拉取列表，保持数据一致。
 */
export function PromptView(_props: ConvViewProps & PromptViewProps): JSX.Element {
  const lang: Lang = (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('en')) ? 'en' : 'zh'
  const D = DICT[lang]
  const say = (key: keyof typeof DICT.zh): string => D[key]

  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [injections, setInjections] = useState<Injection[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('全部')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [showInjections, setShowInjections] = useState(false)
  const [showSources, setShowSources] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [rounds, setRounds] = useState(0) // 默认无限次
  const [every, setEvery] = useState(1)
  const [busy, setBusy] = useState(false)
  /** 分类管理：正在添加新分类（显示输入框）。 */
  const [addingCategory, setAddingCategory] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  /** 分类管理：正在重命名的分类名（非 null = 行内编辑中）。 */
  const [renamingCategory, setRenamingCategory] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // 详情表单字段（选中或新建时填充；编辑直接改表单再保存）。
  const [name, setName] = useState('')
  const [formCategory, setFormCategory] = useState('')
  const [tags, setTags] = useState('')
  const [content, setContent] = useState('')

  // 浮层点击外部关闭。
  const overlayRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (overlayRef.current === null || overlayRef.current.contains(e.target as Node)) return
      setShowInjections(false)
      setShowSources(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const showError = useCallback((err: unknown): void => {
    setError(errText(err))
  }, [])
  const showNotice = useCallback((text: string): void => {
    setNotice(text)
    window.setTimeout(() => setNotice(null), 4000)
  }, [])

  const load = useCallback(async (): Promise<void> => {
    try {
      const [p, i, c] = await Promise.all([
        api<{ prompts: Prompt[] }>('/memory-evolve/api/prompts'),
        api<{ injections: Injection[] }>('/memory-evolve/api/prompts/injections'),
        api<{ categories: string[] }>('/memory-evolve/api/prompts/categories'),
      ])
      setPrompts(p.prompts)
      setInjections(i.injections)
      setCategories(c.categories)
    } catch (err) {
      showError(say('loadFailed').replace('{message}', errText(err)))
    }
  }, [showError])

  useEffect(() => {
    void load()
    void api<{ sources: Source[] }>('/memory-evolve/api/prompts/sources')
      .then((data) => setSources(data.sources))
      .catch(() => { /* 来源链接是锦上添花，失败静默 */ })
  }, [load])

  // 分类树展示列表：受管分类 + 提示词中出现的其他分类（老数据兜底，防隐身）。
  const displayCategories = useMemo(() => {
    const promptCats = prompts.map((p) => p.category).filter((c) => c && c !== '未分类')
    return [...new Set([...categories, ...promptCats])].sort((a, b) => a.localeCompare(b, 'zh'))
  }, [categories, prompts])

  /** 未分类条目数（分类树「未分类」视图用）。 */
  const uncategorizedCount = useMemo(
    () => prompts.filter((p) => p.category === '未分类').length,
    [prompts],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return prompts.filter((p) => {
      if (category !== '全部' && p.category !== category) return false
      if (!q) return true
      return p.name.toLowerCase().includes(q)
        || p.category.toLowerCase().includes(q)
        || p.tags.some((t) => t.toLowerCase().includes(q))
        || p.content.toLowerCase().includes(q)
    })
  }, [prompts, search, category])

  const selected = prompts.find((p) => p.id === selectedId) ?? null

  /** 选中一个提示词 → 填充表单（丢弃未保存的编辑）。 */
  const selectPrompt = (id: string): void => {
    const p = prompts.find((x) => x.id === id)
    if (!p) return
    setSelectedId(id)
    setCreating(false)
    setName(p.name)
    setFormCategory(p.category === '未分类' ? '' : p.category)
    setTags(p.tags.join(', '))
    setContent(p.content)
  }

  /** 进入新建模式：清空表单。 */
  const startCreate = (): void => {
    setSelectedId(null)
    setCreating(true)
    setName('')
    setFormCategory('')
    setTags('')
    setContent('')
    setError(null)
  }

  const savePrompt = async (): Promise<void> => {
    if (busy) return
    const body = {
      name,
      category: formCategory,
      tags: tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
      content,
    }
    setBusy(true)
    try {
      if (creating) {
        const created = await api<{ prompt: Prompt }>('/memory-evolve/api/prompts', { method: 'POST', body: JSON.stringify(body) })
        await load()
        setCreating(false)
        setSelectedId(created.prompt.id)
      } else if (selectedId !== null) {
        await api(`/memory-evolve/api/prompts/${encodeURIComponent(selectedId)}`, { method: 'PUT', body: JSON.stringify(body) })
        await load()
      }
    } catch (err) {
      showError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  const deletePrompt = async (): Promise<void> => {
    if (selectedId === null) return
    const text = say('deleteConfirm').replace('{name}', selected?.name ?? '')
    if (!window.confirm(text)) return
    try {
      await api(`/memory-evolve/api/prompts/${encodeURIComponent(selectedId)}`, { method: 'DELETE' })
      setSelectedId(null)
      setCreating(false)
      await load()
    } catch (err) {
      showError(errText(err))
    }
  }

  const injectPrompt = async (): Promise<void> => {
    if (selectedId === null) return
    try {
      const data = await api<{ injection: Injection }>(
        `/memory-evolve/api/prompts/${encodeURIComponent(selectedId)}/inject`,
        { method: 'POST', body: JSON.stringify({ rounds, every }) },
      )
      const cadence = (data.injection.every ?? 1) === 1
        ? say('everyTurn')
        : say('injectCadence').replace('{n}', String(data.injection.every))
      const times = data.injection.roundsLeft === null
        ? say('injectInfinite')
        : say('injectRound').replace('{n}', String(data.injection.roundsLeft))
      showNotice(say('injected')
        .replace('{name}', data.injection.title)
        .replace('{rounds}', times)
        .replace('{cadence}', cadence))
      await load()
      setShowInjections(true)
      window.dispatchEvent(new CustomEvent('dsh-memory-evolve:badge-change'))
    } catch (err) {
      showError(errText(err))
    }
  }

  const removeInjection = async (id: string): Promise<void> => {
    try {
      await api(`/memory-evolve/api/prompts/injections/${encodeURIComponent(id)}`, { method: 'DELETE' })
      showNotice(say('stoppedInjection'))
      await load()
      window.dispatchEvent(new CustomEvent('dsh-memory-evolve:badge-change'))
    } catch (err) {
      showError(errText(err))
    }
  }

  /** 该提示词当前是否有活跃注入（列表徽标 / 详情状态用）。 */
  const activeInjectionOf = (promptId: string): Injection | undefined =>
    injections.find((i) => i.sourcePromptId === promptId)

  /** 注入节奏文案（每回合 / 每 N 回合一次）。 */
  const cadenceLabel = (inj: Injection): string =>
    (inj.every ?? 1) === 1
      ? say('everyTurn')
      : say('injectCadence').replace('{n}', String(inj.every))

  /** 剩余次数文案（null = 无限）。 */
  const remainingLabel = (inj: Injection): string =>
    inj.roundsLeft === null ? say('injectInfinite') : say('injectRound').replace('{n}', String(inj.roundsLeft))

  /** 添加分类（受管列表）。**幂等**：同名已存在时不报错，提示并选中已有分类。 */
  const addCategory = async (): Promise<void> => {
    const name = newCategoryName.trim()
    if (!name) return
    try {
      const data = await api<{ categories: string[]; alreadyExists: boolean }>('/memory-evolve/api/prompts/categories', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      setCategories(data.categories)
      setCategory(name)
      setNewCategoryName('')
      setAddingCategory(false)
      if (data.alreadyExists) showNotice(say('categoryExists').replace('{name}', name))
    } catch (err) {
      showError(errText(err))
    }
  }

  /** 重命名分类：受管列表替换 + 该分类下提示词同步改名。 */
  const renameCategory = async (from: string): Promise<void> => {
    const to = renameValue.trim()
    if (!to || to === from) {
      setRenamingCategory(null)
      setRenameValue('')
      return
    }
    try {
      const data = await api<{ categories: string[]; renamed: number }>(
        `/memory-evolve/api/prompts/categories/${encodeURIComponent(from)}`,
        { method: 'PUT', body: JSON.stringify({ name: to }) },
      )
      setCategories(data.categories)
      if (category === from) setCategory(to)
      setRenamingCategory(null)
      setRenameValue('')
      await load()
      const suffix = data.renamed > 0 ? say('categoryRenamedSuffix').replace('{count}', String(data.renamed)) : ''
      showNotice(`${say('categoryRenamed').replace('{from}', from).replace('{to}', to).replace('{renamed}', '')}${suffix}`)
    } catch (err) {
      showError(errText(err))
    }
  }

  /** 删除分类：确认后调用 API（该分类下提示词自动移到未分类）。 */
  const removeCategory = async (name: string): Promise<void> => {
    const count = prompts.filter((p) => p.category === name).length
    const hint = count > 0 ? say('categoryMoved').replace('{count}', String(count)) : ''
    if (!window.confirm(`${say('deleteCategory')}「${name}」？${hint}`)) return
    try {
      const data = await api<{ removed: boolean; moved: number }>(
        `/memory-evolve/api/prompts/categories/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      )
      const cats = await api<{ categories: string[] }>('/memory-evolve/api/prompts/categories')
      setCategories(cats.categories)
      if (category === name) setCategory('全部')
      await load()
      const moved = data.moved > 0 ? say('categoryMoved').replace('{count}', String(data.moved)) : ''
      showNotice(`${say('categoryDeleted').replace('{name}', name)}${moved}`)
    } catch (err) {
      showError(errText(err))
    }
  }

  const copyPrompt = async (): Promise<void> => {
    const text = selected?.content ?? ''
    try {
      await navigator.clipboard.writeText(text)
      showNotice(say('copied'))
    } catch (err) {
      showError(errText(err))
    }
  }

  const summaryLine = (p: Prompt): string => {
    const first = p.content.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
    return first.length > 60 ? `${first.slice(0, 60)}…` : first
  }

  const selectedIsDirty = selected !== null && (
    name !== selected.name
    || (formCategory || '未分类') !== selected.category
    || tags !== selected.tags.join(', ')
    || content !== selected.content
  )

  return (
    <div className="pm-root">
      {/* 顶栏：搜索 / 筛选 / 注入中 / 来源 / 新建 */}
      <div className="pm-toolbar">
        <input
          className="pm-search"
          placeholder={say('search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="pm-select"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          title={say('category')}
        >
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button
          type="button"
          className="pm-tool-btn"
          onClick={() => { setShowInjections(!showInjections); setShowSources(false) }}
          title={say('injectHint')}
        >
          {say('injecting')}{injections.length > 0 ? ` (${injections.length})` : ''}
        </button>
        <button
          type="button"
          className="pm-tool-btn"
          onClick={() => { setShowSources(!showSources); setShowInjections(false) }}
        >
          {say('sources')}
        </button>
        <button type="button" className="pm-primary-btn" onClick={startCreate}>{say('new')}</button>
      </div>

      {/* 顶栏消息（错误 / 提示） */}
      {(error !== null || notice !== null) && (
        <div className={`pm-banner ${error !== null ? 'pm-banner-error' : ''}`}>
          {error !== null ? error : notice}
          {error !== null && (
            <button type="button" className="pm-banner-close" onClick={() => setError(null)}>×</button>
          )}
        </div>
      )}

      {/* 注入中浮层 */}
      {showInjections && (
        <div className="pm-overlay" ref={overlayRef}>
          <div className="pm-overlay-title">{say('injecting')}</div>
          {injections.length === 0 && <div className="pm-overlay-empty">{say('noInjection')}</div>}
          {injections.map((inj) => (
            <div key={inj.id} className="pm-overlay-item">
              <div className="pm-overlay-item-main">
                <div className="pm-overlay-item-title">「{inj.title}」</div>
                <div className="pm-overlay-item-sub">
                  {remainingLabel(inj)} · {cadenceLabel(inj)}
                </div>
              </div>
              <button type="button" className="pm-danger-btn pm-overlay-remove" onClick={() => void removeInjection(inj.id)}>
                {say('removeInjection')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* GitHub 来源浮层 */}
      {showSources && (
        <div className="pm-overlay pm-overlay-wide" ref={overlayRef}>
          <div className="pm-overlay-title">{say('sources')}</div>
          <div className="pm-overlay-sub">{say('sourcesHint')}</div>
          {sources.map((s) => (
            <div key={s.url} className="pm-source-item">
              <a className="pm-source-link" href={s.url} target="_blank" rel="noreferrer">{s.name}</a>
              <div className="pm-source-desc">{s.desc}</div>
            </div>
          ))}
        </div>
      )}

      {/* 三栏主体 */}
      <div className="pm-body">
        {/* 左：分类树（受管分类 + 未分类兜底 + 添加/删除管理） */}
        <div className="pm-pane-cats">
          <button
            type="button"
            className={`pm-cat ${category === '全部' ? 'pm-cat-active' : ''}`}
            onClick={() => setCategory('全部')}
          >
            <span className="pm-cat-name">{say('all')}</span>
            <span className="pm-cat-count">{prompts.length}</span>
          </button>
          {displayCategories.map((c) => {
            const count = prompts.filter((p) => p.category === c).length
            if (renamingCategory === c) {
              // 行内重命名编辑
              return (
                <div key={c} className="pm-cat-row">
                  <input
                    className="pm-cat-add-input"
                    autoFocus
                    placeholder={say('renamePh')}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void renameCategory(c)
                      if (e.key === 'Escape') { setRenamingCategory(null); setRenameValue('') }
                    }}
                  />
                  <button type="button" className="pm-cat-add-ok" onClick={() => void renameCategory(c)}>✓</button>
                </div>
              )
            }
            return (
              <div key={c} className="pm-cat-row">
                <button
                  type="button"
                  className={`pm-cat ${category === c ? 'pm-cat-active' : ''}`}
                  onClick={() => setCategory(c)}
                >
                  <span className="pm-cat-name">{c}</span>
                  <span className="pm-cat-count">{count}</span>
                </button>
                <button
                  type="button"
                  className="pm-cat-del"
                  title={say('renameCategory')}
                  onClick={() => { setRenamingCategory(c); setRenameValue(c) }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="pm-cat-del"
                  title={say('deleteCategory')}
                  onClick={() => void removeCategory(c)}
                >
                  ×
                </button>
              </div>
            )
          })}
          {uncategorizedCount > 0 && (
            <button
              type="button"
              className={`pm-cat ${category === '未分类' ? 'pm-cat-active' : ''}`}
              onClick={() => setCategory('未分类')}
            >
              <span className="pm-cat-name">{say('uncategorized')}</span>
              <span className="pm-cat-count">{uncategorizedCount}</span>
            </button>
          )}
          {addingCategory ? (
            <div className="pm-cat-add">
              <input
                className="pm-cat-add-input"
                autoFocus
                placeholder={say('newCategoryPh')}
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addCategory()
                  if (e.key === 'Escape') { setAddingCategory(false); setNewCategoryName('') }
                }}
              />
              <button type="button" className="pm-cat-add-ok" onClick={() => void addCategory()}>✓</button>
            </div>
          ) : (
            <button type="button" className="pm-cat-add-btn" onClick={() => setAddingCategory(true)}>
              ＋ {say('newCategory')}
            </button>
          )}
        </div>

        {/* 中：列表 */}
        <div className="pm-pane-list">
          {prompts.length === 0 && <div className="pm-pane-empty">{say('empty')}</div>}
          {prompts.length > 0 && filtered.length === 0 && <div className="pm-pane-empty">{say('noMatch')}</div>}
          {filtered.map((p) => {
            const active = activeInjectionOf(p.id)
            return (
              <button
                key={p.id}
                type="button"
                className={`pm-item ${selectedId === p.id && !creating ? 'pm-item-active' : ''}`}
                onClick={() => selectPrompt(p.id)}
              >
                <div className="pm-item-row1">
                  <span className="pm-item-name">{p.name}</span>
                  <span className="pm-item-badge">{p.category}</span>
                  {active !== undefined && (
                    <span className="pm-item-badge pm-item-badge-active" title={say('injectHint')}>
                      {active.roundsLeft === null
                        ? say('injectingBadgeInfinite')
                        : say('injectingBadge').replace('{n}', String(active.roundsLeft))}
                    </span>
                  )}
                </div>
                <div className="pm-item-summary">{summaryLine(p)}</div>
                <div className="pm-item-row3">
                  <span className="pm-item-usage">
                    {say('usage').replace('{n}', String(p.usageCount ?? 0))}
                  </span>
                  <span className="pm-item-used">
                    {p.lastUsedAt !== null
                      ? say('lastUsed').replace('{time}', formatTime(p.lastUsedAt))
                      : say('neverUsed')}
                  </span>
                </div>
              </button>
            )
          })}
        </div>

        {/* 右：详情表单 */}
        <div className="pm-pane-detail">
          {(selected === null && !creating) && (
            <div className="pm-detail-hint">{say('selectHint')}</div>
          )}
          {(selected !== null || creating) && (
            <div className="pm-form">
              <div className="pm-form-title">{creating ? say('formNew') : say('formEdit')}</div>
              <label className="pm-field">
                <span className="pm-field-label">{say('name')} *</span>
                <input
                  className="pm-input"
                  placeholder={say('namePh')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="pm-field">
                <span className="pm-field-label">{say('category')}</span>
                <input
                  className="pm-input"
                  list="pm-category-list"
                  placeholder={say('categoryPh')}
                  value={formCategory}
                  onChange={(e) => setFormCategory(e.target.value)}
                />
                <datalist id="pm-category-list">
                  {displayCategories.map((c) => <option key={c} value={c} />)}
                </datalist>
              </label>
              <label className="pm-field">
                <span className="pm-field-label">{say('tags')}</span>
                <input
                  className="pm-input"
                  placeholder={say('tagsPh')}
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                />
              </label>
              <label className="pm-field pm-field-grow">
                <span className="pm-field-label">{say('content')} *</span>
                <textarea
                  className="pm-textarea"
                  placeholder={say('contentPh')}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
              </label>
              <div className="pm-actions">
                {!creating && (() => {
                  const active = selected !== null ? activeInjectionOf(selected.id) : undefined
                  if (active !== undefined) {
                    // 注入中：显示状态 + 停止注入（已注入的提示词不可重复注入）
                    return (
                      <>
                        <span className="pm-inject-status">
                          {active.roundsLeft === null
                            ? say('injectingBadgeInfinite')
                            : say('injectingBadge').replace('{n}', String(active.roundsLeft))}
                          {' '}· {cadenceLabel(active)}
                        </span>
                        <button type="button" className="pm-danger-btn" onClick={() => void removeInjection(active.id)}>
                          {say('removeInjection')}
                        </button>
                      </>
                    )
                  }
                  return (
                    <>
                      <div className="pm-inject-group">
                        <select
                          className="pm-select pm-rounds"
                          value={rounds}
                          onChange={(e) => setRounds(Number(e.target.value))}
                          title={say('rounds')}
                        >
                          {ROUND_OPTIONS.map((r) => (
                            <option key={r} value={r}>
                              {r === 0 ? say('injectInfinite') : r === 1 ? say('injectOnce') : say('injectRound').replace('{n}', String(r))}
                            </option>
                          ))}
                        </select>
                        <select
                          className="pm-select pm-rounds"
                          value={every}
                          onChange={(e) => setEvery(Number(e.target.value))}
                          title={say('cadence')}
                        >
                          {EVERY_OPTIONS.map((e) => (
                            <option key={e} value={e}>{e === 1 ? say('everyTurn') : say('injectCadence').replace('{n}', String(e))}</option>
                          ))}
                        </select>
                        <button type="button" className="pm-primary-btn" onClick={() => void injectPrompt()}>
                          {say('inject')}
                        </button>
                      </div>
                      <button type="button" className="pm-tool-btn" onClick={() => void copyPrompt()}>{say('copy')}</button>
                    </>
                  )
                })()}
                <button type="button" className="pm-tool-btn" onClick={() => void savePrompt()} disabled={busy}>
                  {busy ? say('saving') : say('save')}
                </button>
                {!creating && (
                  <button type="button" className="pm-danger-btn" onClick={() => void deletePrompt()}>
                    {say('delete')}
                  </button>
                )}
                {creating && (
                  <button type="button" className="pm-tool-btn" onClick={() => { setCreating(false); setSelectedId(null) }}>
                    {say('cancel')}
                  </button>
                )}
              </div>
              {!creating && selected !== null && selectedIsDirty && (
                <div className="pm-dirty-hint">{pick('有未保存的修改', 'Unsaved changes')}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
