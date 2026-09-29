/**
 * dsh-memory-evolve — 待确认队列的模块级状态容器。
 *
 * **为什么需要它**（2026-09-23 排查结论）：会话页 Tab 标题上的待确认红点数字
 * 只能靠「dispose + 重新注册 slot」刷新——DSH 的 `ui-slots` 只给 `register()`
 * 一个 dispose 返回值，没有就地更新 label 的 API——而重新注册会让整个 Tab
 * 卸载重建。记忆 / 技能 / 待办 / 设置四个 Tab 共用 `MemoryQueueView`，四个都
 * 受影响：状态留在组件里，重挂就回到 null，于是闪「加载中」、整块重新拉接口、
 * 把没提交的编辑一起清掉（旧代码正是靠 `setEdits({})` 全清来避免错位）。
 * 状态提到模块级后，重挂只是重渲染——数据、编辑草稿、目标轨选择都还在。
 *
 * **草稿 key 为什么不是服务端序号**：队列删掉一条后，后面条目的 1-based 序号
 * 会整体前移；草稿若按下标存，删掉 #1 之后原本 #2 的草稿就会落到新的 #1 上
 * （错位到别的条目、可能被误采纳）。所以草稿一律按「条目稳定键」存，
 * 序号只在构造请求体时按当下队列现算。
 *
 * **为什么可变状态收进一个对象**：客户端产物是**扁平单文件 bundle**，各模块的
 * 顶层绑定共享同一作用域——这里若直接 `let draft = …`，esbuild 就会把组件里
 * 同名的解构变量改名（实测 saveConfig 变成 `draft2.reviewEnabled`，产物里再也
 * grep 不到 `draft.`）。挂在对象属性上不产生作用域绑定，从根上避免这种改名。
 *
 * 本模块是纯状态容器：不做网络请求（拉取留在 MemoryQueueView，与本仓库其他
 * 客户端模块一样各自持有自己的 `api` helper），因此可以被四个 Tab 安全共用。
 */
import { useEffect, useState } from 'react'
import type { RuntimeConfig } from './MemoryQueueView.tsx'

/** One pending suggestion entry (subset of the queue record). */
export interface SuggestionEntry {
  time: string
  sessionId?: string | null
  /** 建议产生时的会话工作目录（项目级条目定位用；可能为 null=无 cwd 的老条目）。 */
  cwd?: string | null
  target: string
  content: string
  reason?: string
  /** How many times this fact resurfaced in reviews (deduped queue). */
  hits?: number
}

/** One pending skill awaiting user confirmation. */
export interface PendingSkill {
  name: string
  description: string
  content: string
}

/** 订阅到的快照：每次通知生成一份新对象，React 据此重渲染。 */
export interface QueueSnapshot {
  /** 服务端原始顺序的队列（展示排序由视图按 hits 现算，不影响操作序号）。 */
  entries: SuggestionEntry[] | null
  skills: PendingSkill[] | null
  config: RuntimeConfig | null
  /** 配置面板草稿（null=还没拿到服务端配置）。 */
  draft: RuntimeConfig | null
  /** 编辑草稿：稳定键 → textarea 文本。 */
  edits: Record<string, string>
  /** 采纳目标轨草稿：稳定键 → 目标轨。 */
  targetPicks: Record<string, string>
}

/**
 * 数据新鲜期：操作成功后本地队列已与服务端同步（见 applyRemovedIndices），
 * 紧随其后的 Tab 重挂不该再空拉一遍；超过这个间隔才后台刷新。
 */
const QUEUE_STALE_MS = 30_000

/** 全部可变状态的唯一载体（不收进对象会被 esbuild 改名，见文件头注释）。 */
interface QueueState {
  entries: SuggestionEntry[] | null
  skills: PendingSkill[] | null
  config: RuntimeConfig | null
  draft: RuntimeConfig | null
  edits: Record<string, string>
  targetPicks: Record<string, string>
  /** 上次与服务端同步（或本地已同步到服务端状态）的时刻。 */
  loadedAt: number
}

const queueState: QueueState = {
  entries: null,
  skills: null,
  config: null,
  draft: null,
  edits: {},
  targetPicks: {},
  loadedAt: 0,
}

const queueSubscribers = new Set<() => void>()

function notifyQueueSubscribers(): void {
  // 复制一份再遍历：监听器回调里可能同步触发订阅/退订
  for (const listener of [...queueSubscribers]) listener()
}

function readQueueSnapshot(): QueueSnapshot {
  return {
    entries: queueState.entries,
    skills: queueState.skills,
    config: queueState.config,
    draft: queueState.draft,
    edits: queueState.edits,
    targetPicks: queueState.targetPicks,
  }
}

/**
 * 条目稳定键：时间 + 轨 + 正文。
 * 三者合起来唯一定位一条建议（同一毫秒入队、同轨同正文的重复建议会被视为
 * 同一条——它们展示与编辑行为本就一致）。
 */
export function suggestionKey(entry: SuggestionEntry): string {
  return `${entry.time}\u0000${entry.target}\u0000${entry.content}`
}

/** 只保留「条目仍然存在」的草稿，其余随条目一起丢弃。 */
function pruneDrafts<T>(map: Record<string, T>, alive: Set<string>): Record<string, T> {
  const next: Record<string, T> = {}
  for (const key of Object.keys(map)) {
    if (alive.has(key)) next[key] = map[key] as T
  }
  return next
}

/** React 绑定：订阅模块级状态；重挂时首帧就能拿到现有数据（不再是 null）。 */
export function useQueueStore(): QueueSnapshot {
  const [state, setState] = useState<QueueSnapshot>(() => readQueueSnapshot())
  useEffect(() => {
    const listener = (): void => setState(readQueueSnapshot())
    queueSubscribers.add(listener)
    // 订阅前可能刚发生过通知（多个 Tab 同时挂载），这里补一次对齐
    setState(readQueueSnapshot())
    return () => {
      queueSubscribers.delete(listener)
    }
  }, [])
  return state
}

/** 是否已有数据且仍在新鲜期内（供挂载时决定要不要后台刷新）。 */
export function isQueueFresh(): boolean {
  return queueState.entries !== null && Date.now() - queueState.loadedAt < QUEUE_STALE_MS
}

/** 服务端数据落地：覆盖三份数据，并按现存条目清理草稿。 */
export function hydrateQueue(next: {
  entries: SuggestionEntry[]
  skills: PendingSkill[]
  config: RuntimeConfig
}): void {
  queueState.entries = next.entries
  queueState.skills = next.skills
  queueState.config = next.config
  // 草稿只在首次拿到配置时初始化；此后后台刷新不得覆盖用户正在改的表单
  queueState.draft = queueState.draft ?? next.config
  const alive = new Set(queueState.entries.map(suggestionKey))
  queueState.edits = pruneDrafts(queueState.edits, alive)
  queueState.targetPicks = pruneDrafts(queueState.targetPicks, alive)
  queueState.loadedAt = Date.now()
  notifyQueueSubscribers()
}

/**
 * 采纳 / 拒绝 / 归档成功后：按服务端回报的「实际移除序号」就地删除。
 *
 * 服务端只回报真正落地的序号（写失败或待办功能关闭的条目会留在队列里），
 * 所以本地结果与服务端一致，不需要再整块重拉一遍列表。被移除条目的草稿
 * 随条目丢弃，其余条目未提交的编辑必须原样保留。
 */
export function applyRemovedIndices(indices: number[]): void {
  if (queueState.entries === null || indices.length === 0) return
  const removed = new Set(indices)
  const kept = queueState.entries.filter((_, index) => !removed.has(index + 1))
  if (kept.length === queueState.entries.length) return
  queueState.entries = kept
  const alive = new Set(kept.map(suggestionKey))
  queueState.edits = pruneDrafts(queueState.edits, alive)
  queueState.targetPicks = pruneDrafts(queueState.targetPicks, alive)
  // 本地已与服务端同步，刷新时间戳——紧随其后的 Tab 重挂不该再空拉一遍
  queueState.loadedAt = Date.now()
  notifyQueueSubscribers()
}

/** 待确认技能被采纳 / 拒绝后从列表移除（服务端回执已确定，无需重拉）。 */
export function removePendingSkill(name: string): void {
  if (queueState.skills === null) return
  const kept = queueState.skills.filter((skill) => skill.name !== name)
  if (kept.length === queueState.skills.length) return
  queueState.skills = kept
  queueState.loadedAt = Date.now()
  notifyQueueSubscribers()
}

/**
 * 只更新队列条目（操作成功后的静默对账）。
 *
 * `removedIndices` 报的是**服务端处理请求那一刻**的位次，而本地 `entries` 是
 * 上一次拉取时的快照：若期间别的会话往队列里入了新建议，两边位次就会漂移，
 * 本地乐观结果会少/多出条目。成功后就队列本身对账一次即可消掉这个窗口
 * ——只走 `/api/suggestions` 一个接口，不清空界面、不闪空窗、不丢草稿
 * （surviving 条目的编辑按稳定键保留）。skills / config / 配置草稿都不动。
 */
export function reconcileQueueEntries(next: SuggestionEntry[]): void {
  queueState.entries = next
  const alive = new Set(next.map(suggestionKey))
  queueState.edits = pruneDrafts(queueState.edits, alive)
  queueState.targetPicks = pruneDrafts(queueState.targetPicks, alive)
  queueState.loadedAt = Date.now()
  notifyQueueSubscribers()
}

/** 编辑某条建议的正文草稿（稳定键）。 */
export function setSuggestionEdit(key: string, value: string): void {
  queueState.edits = { ...queueState.edits, [key]: value }
  notifyQueueSubscribers()
}

/** 选择某条建议的采纳目标轨（稳定键）。 */
export function setSuggestionTarget(key: string, value: string): void {
  queueState.targetPicks = { ...queueState.targetPicks, [key]: value }
  notifyQueueSubscribers()
}

/** 配置面板草稿（拿到服务端配置前是 null，此时忽略）。 */
export function patchConfigDraft(patch: Partial<RuntimeConfig>): void {
  if (queueState.draft === null) return
  queueState.draft = { ...queueState.draft, ...patch }
  notifyQueueSubscribers()
}

/** 配置保存成功：以服务端回显为准，config 与 draft 一起对齐。 */
export function markConfigSaved(next: RuntimeConfig): void {
  queueState.config = next
  queueState.draft = next
  notifyQueueSubscribers()
}
