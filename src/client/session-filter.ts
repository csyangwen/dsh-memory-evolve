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
 * 本文件负责 JS 侧的两件事：
 *   1. 注入筛选条（「仅进行中 / 全部」分段按钮）到会话列表顶部；
 *   2. MutationObserver 保活——React 重渲染会清掉注入 DOM，观察变化后
 *      重新注入（技能经验：先匹配目标特征再标记，避免错过更新）；
 *   3. 偏好持久化（localStorage）：无记录默认开启筛选（用户拍板"默认只
 *      显示进行中的会话"），切换后记忆、下次打开自动恢复。
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

/** 读取偏好；无记录 → 'on'（默认只显示进行中）。 */
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
 * 激活会话筛选（模块启用时调用一次）。
 *
 * @param texts - 已翻译文案。
 * @returns dispose：模块卸载/关闭时移除注入与监听。
 */
export function activateSessionFilter(texts: SessionFilterTexts): () => void {
  // ——当前状态（模块级快照；点击切换时更新）——
  let mode: FilterMode = readPref()
  let disposed = false

  applyToDocument(mode)

  /** 建筛选条 DOM（分段按钮：「仅进行中」/「全部」）。 */
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
        if (disposed) return
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
    if (disposed) return
    if (document.getElementById(FILTER_BAR_ID) !== null) return
    const tree = document.querySelector<HTMLElement>('[role="tree"]')
    if (tree === null || tree.parentNode === null) return
    tree.parentNode.insertBefore(buildBar(), tree)
  }

  // 首次尝试（DOM 可能还没渲染完，靠 observer 兜底）。
  ensureBar()

  // ——MutationObserver 保活：筛选条被 React 重渲染清掉后重新注入——
  // 观察整个 body（childList + subtree）；回调里先做 O(1) 的存在性检查，
  // 只有缺失才走查找/插入，避免高频 mutation（聊天流）造成开销。
  const observer = new MutationObserver(() => {
    if (disposed) return
    if (document.getElementById(FILTER_BAR_ID) === null) ensureBar()
  })
  observer.observe(document.body, { childList: true, subtree: true })

  return () => {
    disposed = true
    observer.disconnect()
    document.getElementById(FILTER_BAR_ID)?.remove()
    delete document.documentElement.dataset.dshUiFilter
  }
}
