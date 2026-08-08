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
import { TabGuideView } from './TabGuideView.tsx'

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
    // 「指南」子 tab：提示词注入功能的详细介绍（本 Tab 专属）。
    guide: '指南',
    library: '提示词库',
    guideIntro: '提示词注入 = 可复用的「指令范式资产库 + 注入执行器」：把常用工作范式（代码审查 / 调试 / PRD / 测试等）固化成提示词，选中即注入——模型下一轮自动看到、不打断回复。',
    guideLibTitle: '提示词库',
    guideLibBody: '可复用的指令范式资产，来源以用户自写为主：',
    guideLibItem1: 'CRUD：新建 / 编辑 / 删除，名称 + 分类 + 标签 + 正文（Markdown），新建时分类留空自动归入「临时」；',
    guideLibItem2: '分类管理：内置分类 + 自定义添加 / 重命名 / 删除（删除时该分类下提示词自动移到未分类）；',
    guideLibItem3: '搜索（名称/分类/标签/内容）+ 复制到剪贴板 + 使用统计；',
    guideLibItem4: '内置 13 条来自 GitHub 真实提示词资产的冷启动示例（SpecRoute / Claude-Code-Promts-Skills），并附范式库链接供自取。',
    guideInjectTitle: '注入机制',
    guideInjectBody: '选中提示词配置「次数 × 间隔」即注入（次数/间隔可输入任意数字）：',
    guideInjectItem1: '次数：一次性（1 轮）/ 有限 N 次 / 无限（0 = 持续注入直到手动停止）；',
    guideInjectItem2: '间隔：每回合（1）/ 每 M 回合出现 1 次（如"每 3 回合提醒一次"）；',
    guideInjectItem3: '写后即时注入、不打断回复：内容写入注入轨，模型下一轮生成时自动看到；',
    guideInjectItem4: '正文支持 {{date}} / {{time}} 变量，注入时自动展开。',
    guideInjectItem5: '临时注入：不建提示词也能注入——详情栏直接输入内容点「注入」，自动存入提示词库（分类留空归入「临时」），一次操作同时入库并生效；',
    guideTrackTitle: '注入状态',
    guideTrackBody: '每个提示词有明确状态（未注入 / 注入中·剩 N 次 / 持续注入中），可随时停止；「注入中」浮层实时展示；会话页 Tab 栏有活跃注入时显示红点 🔴。',
    guideSwitchTitle: '开关',
    guideSwitchBody: '提示词管理器默认关闭：在「Memory Evolve 设置」Tab 的「配置」里打开「提示词管理器」开关，刷新后本 Tab 出现。',
    search: '搜索名称、分类、标签或内容…',
    new: '新建提示词',
    all: '全部',
    uncategorized: '未分类',
    inject: '注入',
    injectRound: '注入 {n} 次',
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
    formNew: '新建提示词',
    formEdit: '编辑提示词',
    name: '名称',
    namePh: '如：代码审查（Code Review）',
    category: '分类',
    categoryPh: '如：开发流程（留空自动归入「临时」）',
    tags: '标签',
    tagsPh: '逗号分隔，如：review, 质量',
    content: '内容',
    contentPh: '在这里编写提示词正文…\n支持 {{date}}、{{time}} 变量，注入时自动展开。',
    usage: '已注入 {n} 次',
    lastUsed: '最近注入：{time}',
    neverUsed: '从未注入过',
    rounds: '次数',
    cadence: '间隔',
    roundsHint: '0 = 无限次',
    everyHint: '1 = 每回合',
    roundsInvalid: '次数必须是 ≥0 的整数（0 = 无限次）',
    everyInvalid: '间隔必须是 ≥1 的整数',
    quickTitle: '临时注入',
    quickDesc: '不建提示词也能注入：直接输入内容点「注入」，会自动存入提示词库（分类留空归入「临时」），一次操作同时入库并生效。',
    quickNamePh: '名称（可选，留空取内容首行）',
    quickCategoryPh: '分类（可选，留空归入「临时」）',
    contentRequired: '内容不能为空',
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
    // "Guide" sub-tab: detailed introduction of the prompt injection feature.
    guide: 'Guide',
    library: 'Prompt library',
    guideIntro: 'Prompt injection = a reusable "instruction pattern library + injection executor": turn recurring work paradigms (code review / debugging / PRD / testing…) into prompts, then inject one with a click — the model sees it next turn without interrupting the reply.',
    guideLibTitle: 'Prompt library',
    guideLibBody: 'Reusable instruction patterns, mostly user-written:',
    guideLibItem1: 'CRUD: create / edit / delete, name + category + tags + body (Markdown); new prompts with an empty category go to Temp automatically;',
    guideLibItem2: 'Category management: built-in categories + custom add / rename / delete (prompts in a deleted category move to Uncategorized);',
    guideLibItem3: 'Search (name/category/tags/content) + copy to clipboard + usage stats;',
    guideLibItem4: '13 cold-start examples from real GitHub prompt assets (SpecRoute / Claude-Code-Promts-Skills) plus links to public pattern libraries.',
    guideInjectTitle: 'Injection mechanics',
    guideInjectBody: 'Select a prompt, configure "count × cadence" (any integers) and inject:',
    guideInjectItem1: 'Count: once (1 turn) / finite N turns / unlimited (0 = keeps injecting until stopped);',
    guideInjectItem2: 'Cadence: every turn (1) / once every M turns (e.g. "remind every 3 turns");',
    guideInjectItem3: 'Injects without interrupting the reply: written to the injection track, visible to the model on the next turn;',
    guideInjectItem4: '{{date}} / {{time}} variables expand at injection time.',
    guideInjectItem5: 'Quick inject: no need to save a prompt first — type content and inject; it is auto-saved to the library (empty category → Temp) in one step;',
    guideTrackTitle: 'Injection state',
    guideTrackBody: 'Every prompt has an explicit state (not injected / injecting·N left / injecting·ongoing) and can be stopped anytime; the "Injecting" overlay shows live entries; the session tab shows a red dot 🔴 while anything is active.',
    guideSwitchTitle: 'Switch',
    guideSwitchBody: 'The prompt manager is off by default: enable the "Prompt manager" toggle under "Config" in the "Memory Evolve Settings" tab, then refresh to reveal this tab.',
    search: 'Search name, category, tags or content…',
    new: 'New prompt',
    all: 'All',
    uncategorized: 'Uncategorized',
    inject: 'Inject',
    injectRound: 'Inject {n} times',
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
    formNew: 'New prompt',
    formEdit: 'Edit prompt',
    name: 'Name',
    namePh: 'e.g. Code Review',
    category: 'Category',
    categoryPh: 'e.g. workflow (empty = Temp category)',
    tags: 'Tags',
    tagsPh: 'Comma-separated, e.g. review, quality',
    content: 'Content',
    contentPh: 'Write the prompt body here…\n{{date}} and {{time}} variables expand on inject.',
    usage: 'Injected {n} times',
    lastUsed: 'Last injected: {time}',
    neverUsed: 'Never injected',
    rounds: 'Count',
    cadence: 'Cadence',
    roundsHint: '0 = unlimited',
    everyHint: '1 = every turn',
    roundsInvalid: 'Count must be an integer ≥ 0 (0 = unlimited)',
    everyInvalid: 'Cadence must be an integer ≥ 1',
    quickTitle: 'Quick inject',
    quickDesc: 'Inject without saving a prompt first: type content and hit Inject — it is auto-saved to the library (empty category goes to Temp) in one step.',
    quickNamePh: 'Name (optional; defaults to first content line)',
    quickCategoryPh: 'Category (optional; empty = Temp)',
    contentRequired: 'Content is required',
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

/** 注入参数（次数/间隔）由用户自由输入任意整数，不再限定固定选项。 */

/**
 * 解析注入参数输入框文本 → 合法数字。
 *   rounds：空 = 0（无限）；必须 ≥0 整数。
 *   every：空 = 1（每回合）；必须 ≥1 整数。
 * host 端有同样的校验兜底，这里先拦一次给出友好文案。
 * @returns {{rounds: number, every: number}} 解析后的数字。
 */
function parseInjectNums(roundsText: string, everyText: string, say: (k: keyof typeof DICT.zh) => string): { rounds: number; every: number } {
  const rounds = roundsText.trim() === '' ? 0 : Number(roundsText)
  const every = everyText.trim() === '' ? 1 : Number(everyText)
  if (!Number.isInteger(rounds) || rounds < 0) throw new Error(say('roundsInvalid'))
  if (!Number.isInteger(every) || every < 1) throw new Error(say('everyInvalid'))
  return { rounds, every }
}

/** 注入次数/间隔数字输入框（type=number，任意整数；hint 展示语义说明）。 */
function NumInput(props: {
  label: string
  hint: string
  value: string
  min: number
  onChange: (v: string) => void
}): JSX.Element {
  return (
    <label className="pm-field pm-num-field">
      <span className="pm-field-label">
        {props.label}
        <span className="pm-field-hint">{props.hint}</span>
      </span>
      <input
        type="number"
        className="pm-input pm-num-input"
        min={props.min}
        step={1}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  )
}

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
  /** 子视图：guide=本 Tab 指南；main=提示词库（默认）。 */
  const [view, setView] = useState<'guide' | 'main'>('main')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('全部')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [showInjections, setShowInjections] = useState(false)
  const [showSources, setShowSources] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** 注入参数输入框文本（自由数字；'' 表示未输入，解析时回默认）。 */
  const [roundsText, setRoundsText] = useState('0') // 默认无限次
  const [everyText, setEveryText] = useState('1') // 默认每回合
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

  /** 注入成功后的统一收尾：提示 + 重拉 + 打开注入浮层 + 通知 Tab 红点刷新。 */
  const afterInjected = async (injection: Injection): Promise<void> => {
    const cadence = (injection.every ?? 1) === 1
      ? say('everyTurn')
      : say('injectCadence').replace('{n}', String(injection.every))
    const times = injection.roundsLeft === null
      ? say('injectInfinite')
      : say('injectRound').replace('{n}', String(injection.roundsLeft))
    showNotice(say('injected')
      .replace('{name}', injection.title)
      .replace('{rounds}', times)
      .replace('{cadence}', cadence))
    await load()
    setShowInjections(true)
    window.dispatchEvent(new CustomEvent('dsh-memory-evolve:badge-change'))
  }

  /** 注入选中提示词（次数/间隔来自自由数字输入框）。 */
  const injectPrompt = async (): Promise<void> => {
    if (selectedId === null) return
    let nums: { rounds: number; every: number }
    try {
      nums = parseInjectNums(roundsText, everyText, say)
    } catch (err) {
      showError(errText(err))
      return
    }
    try {
      const data = await api<{ injection: Injection }>(
        `/memory-evolve/api/prompts/${encodeURIComponent(selectedId)}/inject`,
        { method: 'POST', body: JSON.stringify(nums) },
      )
      await afterInjected(data.injection)
    } catch (err) {
      showError(errText(err))
    }
  }

  /**
   * 临时注入（详情栏未选中提示词时）：内容直接注入，一步完成"自动入库 +
   * 注入生效"，解决"必须先把提示词存进库才能注入"的流程问题。
   *   1. 校验内容非空、参数合法；
   *   2. POST /prompts 创建（分类留空 → host 自动归入「临时」；名称留空
   *      取内容首行前 20 字，保证注入轨与列表都有可读标题）；
   *   3. POST /:id/inject 注入 → 选中新条目（表单回填，可继续编辑/改名）。
   */
  const quickInject = async (): Promise<void> => {
    if (busy) return
    const text = content.trim()
    if (!text) {
      showError(say('contentRequired'))
      return
    }
    let nums: { rounds: number; every: number }
    try {
      nums = parseInjectNums(roundsText, everyText, say)
    } catch (err) {
      showError(errText(err))
      return
    }
    setBusy(true)
    try {
      // 名称留空 → 取内容首个非空行前 20 字（截断 + 省略号标识）
      const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
      const promptName = name.trim() || (firstLine.length > 20 ? `${firstLine.slice(0, 20)}…` : firstLine) || '未命名提示词'
      const created = await api<{ prompt: Prompt }>('/memory-evolve/api/prompts', {
        method: 'POST',
        body: JSON.stringify({
          name: promptName,
          category: formCategory.trim(),
          tags: tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
          content: text,
        }),
      })
      const data = await api<{ injection: Injection }>(
        `/memory-evolve/api/prompts/${encodeURIComponent(created.prompt.id)}/inject`,
        { method: 'POST', body: JSON.stringify(nums) },
      )
      await afterInjected(data.injection)
      selectPrompt(created.prompt.id) // 回填表单：新建条目已选中，可改名/改分类
    } catch (err) {
      showError(errText(err))
    } finally {
      setBusy(false)
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
      {/* 子 tab 条：指南 / 提示词库（复用 mt- 样式，与其他 Tab 一致） */}
      <div className="mt-file-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'guide'}
          className={view === 'guide' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setView('guide')}
        >
          {say('guide')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'main'}
          className={view === 'main' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setView('main')}
        >
          {say('library')}
        </button>
      </div>
      {view === 'guide' ? (
        // 提示词注入专属指南（本 Tab 功能详细介绍，文案见 DICT guide* 键）
        <TabGuideView sections={[
          { icon: '📌', title: say('guideIntro'), body: '' },
          { icon: '📚', title: say('guideLibTitle'), body: say('guideLibBody'), items: [say('guideLibItem1'), say('guideLibItem2'), say('guideLibItem3'), say('guideLibItem4')] },
          { icon: '💉', title: say('guideInjectTitle'), body: say('guideInjectBody'), items: [say('guideInjectItem1'), say('guideInjectItem2'), say('guideInjectItem3'), say('guideInjectItem4')] },
          { icon: '🔴', title: say('guideTrackTitle'), body: say('guideTrackBody') },
          { icon: '⚙️', title: say('guideSwitchTitle'), body: say('guideSwitchBody') },
        ]} />
      ) : (
        <>
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
            // 未选中提示词 → 「临时注入」快速表单：不建提示词也能直接注入
            // （自动入库 + 注入一步完成，分类留空归入「临时」）
            <div className="pm-form">
              <div className="pm-form-title">{say('quickTitle')}</div>
              <div className="pm-quick-sub">{say('quickDesc')}</div>
              <label className="pm-field">
                <span className="pm-field-label">{say('name')}</span>
                <input
                  className="pm-input"
                  placeholder={say('quickNamePh')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
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
              <label className="pm-field">
                <span className="pm-field-label">{say('category')}</span>
                <input
                  className="pm-input"
                  list="pm-category-list"
                  placeholder={say('quickCategoryPh')}
                  value={formCategory}
                  onChange={(e) => setFormCategory(e.target.value)}
                />
                <datalist id="pm-category-list">
                  {displayCategories.map((c) => <option key={c} value={c} />)}
                </datalist>
              </label>
              <div className="pm-num-row">
                <NumInput
                  label={say('rounds')}
                  hint={say('roundsHint')}
                  value={roundsText}
                  min={0}
                  onChange={setRoundsText}
                />
                <NumInput
                  label={say('cadence')}
                  hint={say('everyHint')}
                  value={everyText}
                  min={1}
                  onChange={setEveryText}
                />
              </div>
              <div className="pm-actions">
                <button type="button" className="pm-primary-btn" onClick={() => void quickInject()} disabled={busy}>
                  {busy ? say('saving') : say('inject')}
                </button>
              </div>
            </div>
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
                        <NumInput
                          label={say('rounds')}
                          hint={say('roundsHint')}
                          value={roundsText}
                          min={0}
                          onChange={setRoundsText}
                        />
                        <NumInput
                          label={say('cadence')}
                          hint={say('everyHint')}
                          value={everyText}
                          min={1}
                          onChange={setEveryText}
                        />
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
        </>
      )}
    </div>
  )
}
