/**
 * dsh-memory-evolve — 左侧会话列表「仅显示进行中」筛选 + 运行状态提示注入。
 *
 * 纯客户端 DOM 增强（不改 DSH 框架源码）。原理（调研文档
 * docs-local/DSH-UI设置模块-调研-20260809.md）：
 *
 * - 会话行 DOM：`div[role="treeitem"][aria-selected]`——工作区分组行有
 *   `aria-expanded` 无 `aria-selected`，搜索结果行是 `<button>`（天然排除
 *   `div` 选择器，搜索模式下筛选不生效）；
 * - 状态标记：StateDot 渲染稳定属性 `data-state`（ongoing=正在生成 /
 *   warning=等审批等回答 / error=出错 / done=已完成未查看）；**纯 idle 的
 *   会话行没有任何状态点**（Rows.tsx：done 且未 completed 时不渲染）；
 * - 过滤规则是纯 CSS（挂 `html[data-dsh-ui-filter="on"]`），React 状态变化
 *   重渲染后选择器实时生效，**无需 JS 轮询会话状态**：
 *   `html[data-dsh-ui-filter="on"] [role="tree"] div[role="treeitem"][aria-selected]:not(:has([data-state])) { display: none }`
 *   （:has() 需 Chrome 105+，2022-08 起现代浏览器无问题）
 *
 * 本文件负责 JS 侧的事：
 *   1. 注入筛选条（「仅进行中 / 全部」分段按钮）到会话列表顶部；
 *   2. MutationObserver 保活——React 重渲染会清掉注入 DOM，观察变化后
 *      重新注入（技能经验：先匹配目标特征再标记，避免错过更新）；
 *   3. 筛选条模式偏好持久化（localStorage）：功能开启后无记录默认「仅
 *      进行中」（用户拍板"默认只显示进行中的会话"），切换后记忆；
 *   4. **功能开关**（用户拍板：模块内每个功能默认关闭、由用户主动开启，
 *      独立小开关在「综合」子 tab）：setEnabled(false) 时整体停用（移除
 *      筛选条与 html 属性、停止观察），开启时恢复——由 index.ts 监听
 *      功能开关事件驱动；
 *   5. **运行计数**（用户拍板）：「仅进行中」按钮文字带括号实时显示当前
 *      正在执行的会话数（如「仅进行中 (3)」）——不管筛选选没选中都显示；
 *   6. **折叠工作区运行徽标**（用户拍板）：工作区折叠后看不到里面会话的
 *      运行状态，在折叠的分组行上注入「● N 运行中」徽标。
 *
 * **数据源**：运行计数与徽标数据来自宿主端 GET /api/ui-settings/running
 * （agents.roots 状态 + workspace.sessionIds 归属，5 秒轮询）——折叠的
 * 工作区分组不渲染会话行（tree.ts：sessions: expanded ? ... : []），DOM
 * 计数会漏，必须宿主端精确统计。
 */

/** 筛选条容器 id（保活查重用）。 */
export const FILTER_BAR_ID = 'dsh-ui-filter-bar'

/** localStorage 偏好键。 */
const PREF_KEY = 'dsh-memory-evolve:ui-settings:filter'

/** 运行快照轮询间隔（ms）。 */
const RUNNING_POLL_MS = 5000

/** 筛选状态：on=仅显示进行中（默认） / off=显示全部。 */
export type FilterMode = 'on' | 'off'

/** 宿主端运行快照（GET /api/ui-settings/running）。 */
export interface RunningSnapshot {
  total: number
  groups: Array<{ title: string | null; workspaceId: string | null; running: number }>
}

/** 已翻译文案（由调用方经 t() 取得，zh/en 跟随界面语言）。 */
export interface SessionFilterTexts {
  /** 筛选条容器的 aria-label / title。 */
  barTitle: string
  /** 「仅进行中」按钮文案。 */
  on: string
  /** 「全部」按钮文案。 */
  off: string
  /** 折叠行运行徽标模板（{count} 运行中）。 */
  runningLabel: string
  /** 未分组（ungrouped）工作区行的显示名（行标题匹配用）。 */
  ungroupedLabel: string
}

/** 读取筛选条模式偏好；无记录 → 'on'（功能开启后默认只显示进行中）。 */
function readPref(): FilterMode {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    return raw === 'off' ? 'off' : 'on'
  } catch {
    return 'on' // localStorage 不可用（隐私模式等）时按默认处理
  }
}

/** 保存偏好（localStorage 异常静默忽略——筛选仍可本次会话内工作）。 */
function writePref(mode: FilterMode): void {
  try {
    localStorage.setItem(PREF_KEY, mode)
  } catch { /* best-effort */ }
}

/** 把筛选状态写到 <html> 属性（CSS 过滤规则的作用域开关）。 */
function applyToDocument(mode: FilterMode): void {
  const root = document.documentElement
  if (mode === 'on') root.dataset.dshUiFilter = 'on'
  else delete root.dataset.dshUiFilter
}

/** 拉取宿主端运行快照；失败返回空（界面按 0 处理，不影响使用）。 */
async function fetchRunning(): Promise<RunningSnapshot> {
  try {
    const res = await fetch('/memory-evolve/api/ui-settings/running', { cache: 'no-store' })
    if (!res.ok) return { total: 0, groups: [] }
    const data = await res.json() as RunningSnapshot
    if (!Array.isArray(data.groups)) return { total: data.total ?? 0, groups: [] }
    return { total: data.total ?? 0, groups: data.groups }
  } catch {
    return { total: 0, groups: [] }
  }
}

/**
 * 创建会话筛选控制器（模块启用时调用一次）。
 *
 * @param texts - 已翻译文案。
 * @returns { setEnabled, dispose }：setEnabled 由功能开关事件驱动
 *   （false=整体停用，true=按偏好恢复）；dispose 模块卸载时清理。
 */
export function createSessionFilter(texts: SessionFilterTexts): {
  setEnabled: (enabled: boolean) => void
  dispose: () => void
} {
  // ——当前状态——
  let mode: FilterMode = readPref()
  let enabled = false // 功能开关（「综合」子 tab），默认由 index.ts 同步
  let disposed = false
  let observer: MutationObserver | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let countRaf = 0 // rAF 句柄（计数更新节流）
  /** 最近一次运行快照（缓存：observer 保活重注入徽标时直接用，不重复 fetch）。 */
  let snapshot: RunningSnapshot = { total: 0, groups: [] }

  /** 更新「仅进行中」按钮文字：`仅进行中 (N)`——不管筛选选没选中都显示
   *  当前正在执行的会话数（用户拍板：对用户友好的实时提示）。N 来自宿主
   *  端快照 total（含折叠组，比 DOM 计数准确）。rAF 节流：高频 mutation
   *  合并到下一帧只算一次。 */
  const updateCount = (): void => {
    if (disposed || !enabled) return
    if (countRaf !== 0) return
    countRaf = requestAnimationFrame(() => {
      countRaf = 0
      if (disposed || !enabled) return
      // 按钮可能被 React 重渲染清掉（筛选条保活会重建），重建后重查。
      const button = document.getElementById(FILTER_BAR_ID)
        ?.querySelector<HTMLButtonElement>('.dsh-ui-filter-btn[data-mode="on"]')
      if (button == null) return
      button.textContent = `${texts.on} (${snapshot.total})`
    })
  }

  /**
   * 折叠工作区行的运行徽标维护（数据 = snapshot.groups）：
   * - 行匹配：工作区行文本以其标题开头（workspace title 全局唯一，行文本
   *   = 标题 + 会话数，取最长匹配防前缀串味）；未分组行以 ungroupedLabel
   *   开头匹配（title=null 的组）；
   * - 折叠行（aria-expanded="false"）且该组 running>0 → 注入/更新
   *   「● N 运行中」徽标；否则移除已注入徽标（展开行不注入——会话行
   *   可见，无需冗余提示）。
   * React 重渲染会清掉徽标（行重建），observer 保活时重注入。
   */
  const ensureBadges = (): void => {
    if (disposed || !enabled) return
    const rows = document.querySelectorAll<HTMLElement>('div[role="treeitem"][aria-expanded]')
    for (const row of rows) {
      const collapsed = row.getAttribute('aria-expanded') === 'false'
      // 行文本匹配组（最长 title 命中，防 "a" 误配 "ab" 行）。
      const text = row.textContent ?? ''
      let matched: RunningSnapshot['groups'][number] | null = null
      let bestLen = -1
      for (const group of snapshot.groups) {
        const prefix = group.title ?? texts.ungroupedLabel
        if (prefix !== '' && text.startsWith(prefix) && prefix.length > bestLen) {
          matched = group
          bestLen = prefix.length
        }
      }
      const need = collapsed && matched !== null && matched.running > 0
      const badge = row.querySelector<HTMLElement>('.dsh-ui-ws-run-badge')
      if (need) {
        const label = texts.runningLabel.replace('{count}', String(matched!.running))
        if (badge !== null) {
          if (badge.textContent !== label) badge.textContent = label
        } else {
          const el = document.createElement('span')
          el.className = 'dsh-ui-ws-run-badge'
          el.textContent = label
          row.appendChild(el)
        }
      } else if (badge !== null) {
        badge.remove()
      }
    }
  }

  /** 刷新数据 + 界面（轮询与功能开启时调用）。 */
  const refresh = (): void => {
    if (disposed || !enabled) return
    void fetchRunning().then((next) => {
      if (disposed || !enabled) return
      snapshot = next
      updateCount()
      ensureBadges()
    })
  }

  /** 建筛选条 DOM（分段按钮：「仅进行中 (N)」/「全部」）。 */
  const buildBar = (): HTMLElement => {
    const bar = document.createElement('div')
    bar.id = FILTER_BAR_ID
    bar.className = 'dsh-ui-filter-bar'
    bar.setAttribute('role', 'group')
    bar.setAttribute('aria-label', texts.barTitle)
    bar.title = texts.barTitle

    const mkButton = (btnMode: FilterMode, label: string): HTMLButtonElement => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `dsh-ui-filter-btn${mode === btnMode ? ' dsh-ui-filter-btn-active' : ''}`
      button.dataset.mode = btnMode
      button.textContent = label
      button.setAttribute('aria-pressed', mode === btnMode ? 'true' : 'false')
      button.addEventListener('click', () => {
        if (disposed || !enabled) return
        mode = btnMode
        applyToDocument(mode)
        writePref(mode)
        // 同步两个按钮的 active 态与 aria-pressed。
        for (const btn of bar.querySelectorAll<HTMLButtonElement>('.dsh-ui-filter-btn')) {
          const isActive = btn.dataset.mode === mode
          btn.classList.toggle('dsh-ui-filter-btn-active', isActive)
          btn.setAttribute('aria-pressed', isActive ? 'true' : 'false')
        }
      })
      return button
    }

    bar.appendChild(mkButton('on', texts.on))
    bar.appendChild(mkButton('off', texts.off))
    return bar
  }

  /**
   * 确保筛选条存在于会话列表顶部。
   * 锚定 `[role="tree"]`（会话树/扁平列表容器），插入到它前面；rail 收起
   * 状态无 tree 时不插入，等展开后 observer 再触发。React 重渲染清掉
   * 筛选条后，下一次 mutation 回调会重新插入。
   */
  const ensureBar = (): void => {
    if (disposed || !enabled) return
    if (document.getElementById(FILTER_BAR_ID) !== null) return
    const tree = document.querySelector<HTMLElement>('[role="tree"]')
    if (tree === null || tree.parentNode === null) return
    tree.parentNode.insertBefore(buildBar(), tree)
    // 新建后立即刷一次计数（避免等到下一次 DOM 变化/轮询）。
    updateCount()
  }

  /**
   * 启动保活观察（body childList+subtree；回调先 O(1) 存在性检查）。
   * 任何 DOM 变化：筛选条缺失 → 重建；徽标被 React 重渲染清掉 → 用缓存
   * 快照重注入（不重复 fetch）。数据刷新由轮询负责。
   */
  const startObserver = (): void => {
    if (observer !== null || disposed) return
    observer = new MutationObserver(() => {
      if (disposed || !enabled) return
      if (document.getElementById(FILTER_BAR_ID) === null) {
        ensureBar()
        return
      }
      ensureBadges()
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  /** 启动运行快照轮询（5s；会话状态变化秒级感知足够）。 */
  const startPolling = (): void => {
    if (pollTimer !== null || disposed) return
    pollTimer = setInterval(refresh, RUNNING_POLL_MS)
  }

  return {
    /** 功能开关：false=整体停用（移除注入与观察），true=按偏好恢复。 */
    setEnabled(next: boolean): void {
      if (disposed) return
      enabled = next
      if (enabled) {
        applyToDocument(mode)
        ensureBar()
        startObserver()
        startPolling()
        refresh() // 立即拉一次数据（计数 + 徽标）
      } else {
        // 停用：摘掉过滤属性、筛选条、徽标，停观察与轮询。
        if (countRaf !== 0) {
          cancelAnimationFrame(countRaf)
          countRaf = 0
        }
        if (pollTimer !== null) {
          clearInterval(pollTimer)
          pollTimer = null
        }
        observer?.disconnect()
        observer = null
        document.getElementById(FILTER_BAR_ID)?.remove()
        document.querySelectorAll('.dsh-ui-ws-run-badge').forEach((el) => el.remove())
        delete document.documentElement.dataset.dshUiFilter
      }
    },
    dispose(): void {
      disposed = true
      if (countRaf !== 0) {
        cancelAnimationFrame(countRaf)
        countRaf = 0
      }
      if (pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      observer?.disconnect()
      observer = null
      document.getElementById(FILTER_BAR_ID)?.remove()
      document.querySelectorAll('.dsh-ui-ws-run-badge').forEach((el) => el.remove())
      delete document.documentElement.dataset.dshUiFilter
    },
  }
}
