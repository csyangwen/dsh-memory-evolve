/**
 * dsh-memory-evolve — 左侧会话列表「仅显示进行中」筛选注入。
 *
 * 纯客户端 DOM 增强（不改 DSH 框架源码）。原理（调研文档
 * docs/DSH-UI设置模块-调研-20260809.md）：
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
 *      rAF 节流 + 复用 MutationObserver，会话开始/结束运行即时刷新。
 */

/** 筛选条容器 id（保活查重用）。 */
export const FILTER_BAR_ID = 'dsh-ui-filter-bar'

/** localStorage 偏好键。 */
const PREF_KEY = 'dsh-memory-evolve:ui-settings:filter'

/** 筛选状态：on=仅显示进行中（默认） / off=显示全部。 */
export type FilterMode = 'on' | 'off'

/** 已翻译文案（由调用方经 t() 取得，zh/en 跟随界面语言）。 */
export interface SessionFilterTexts {
  /** 筛选条容器的 aria-label / title。 */
  barTitle: string
  /** 「仅进行中」按钮文案。 */
  on: string
  /** 「全部」按钮文案。 */
  off: string
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
  let countRaf = 0 // rAF 句柄（计数更新节流）

  /** 统计当前「正在执行」的会话数：会话行内存在 ongoing 状态点（正在
   *  生成或子代理在跑；StateDot data-state 属性，与过滤规则同源锚点）。
   *  DOM 计数只覆盖已渲染的会话行（折叠分组不渲染）——轻量够用。 */
  const countRunning = (): number => {
    try {
      return document.querySelectorAll(
        '[role="tree"] div[role="treeitem"][aria-selected]:has([data-state="ongoing"])',
      ).length
    } catch {
      return 0
    }
  }

  /** 更新「仅进行中」按钮文字：`仅进行中 (N)`——不管筛选选没选中都显示
   *  当前正在执行的会话数（用户拍板：对用户友好的实时提示）。rAF 节流：
   *  聊天流高频 mutation 时合并到下一帧只算一次。 */
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
      const n = countRunning()
      button.textContent = `${texts.on} (${n})`
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

    // 先建「全部」按钮（其后的计数更新通过 querySelector 定位，顺序无关）。
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
    // 新建后立即刷一次计数（避免等到下一次 DOM 变化）。
    updateCount()
  }

  /** 启动保活观察（body childList+subtree；回调先 O(1) 存在性检查）。
   *  任何 DOM 变化同时触发计数刷新（rAF 节流）——会话开始/结束运行、
   *  状态点出现/消失都会反映到按钮括号里。 */
  const startObserver = (): void => {
    if (observer !== null || disposed) return
    observer = new MutationObserver(() => {
      if (disposed || !enabled) return
      if (document.getElementById(FILTER_BAR_ID) === null) {
        ensureBar()
        return
      }
      updateCount()
    })
    observer.observe(document.body, { childList: true, subtree: true })
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
      } else {
        // 停用：摘掉过滤属性与筛选条（观察停止，下次开启时重新建立）。
        observer?.disconnect()
        observer = null
        document.getElementById(FILTER_BAR_ID)?.remove()
        delete document.documentElement.dataset.dshUiFilter
      }
    },
    dispose(): void {
      disposed = true
      if (countRaf !== 0) {
        cancelAnimationFrame(countRaf)
        countRaf = 0
      }
      observer?.disconnect()
      observer = null
      document.getElementById(FILTER_BAR_ID)?.remove()
      delete document.documentElement.dataset.dshUiFilter
    },
  }
}
