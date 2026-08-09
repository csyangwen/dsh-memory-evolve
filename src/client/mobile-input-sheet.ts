/**
 * dsh-memory-evolve — 输入栏上拉弹窗增强（DSH 移动端适配·enhance）。
 *
 * ## 背景（用户拍板 2026-08-09）
 * 手机端输入栏工具栏：左侧（加号 + 权限选择）与模型选择默认隐藏，只常驻
 * 右侧（发送/停止 + 上下文圆环）+ 「⋯」入口；点击「⋯」→ 弹出上拉弹窗
 * （bottom sheet），弹窗里显示被隐藏的加号 / 权限 / **模型选择**。
 *
 * ## 为什么是 enhance 而不是纯 css
 * 弹窗开关需要 JS（点击切换 html 属性）；但按钮本体**不移动、不复制 DOM**——
 * .tools / ModelSelect 是 React 渲染的（权限 Menu、加号、模型下拉的 React
 * 事件），复制节点会丢失 React 事件（React 17+ 事件委托在根上）。因此本模块
 * 只做：①注入「⋯」入口按钮；②切换 html 属性 data-dsh-mobile-sheet
 * （mobile.css 据此把 .tools 与模型选择以 fixed 底栏形式显示，见第 10 节）。
 *
 * ## 生命周期（协议）
 * 本函数作为 dshMobile.enhance 导出（index.ts），由 dsh-android-edapp
 * （dsh-mobileweb-adapter）在移动模式（≤767px）激活时调用一次，返回 dispose
 * 供退出移动模式 / 卸载时清理。
 *
 * ## DOM 锚点（不依赖 CSS modules 哈希类名）
 * InputBar.tsx 结构保证：
 *   card[data-composer-card]
 *     > scroll[data-input-scroll]
 *     > row（scroll 的下一个兄弟 div）
 *       > div:first-child  = .tools（加号 + 权限）
 *       > div:last-of-type = .trailing（rightItems + 模型 + 圆环 + 发送）
 *         > div:has(> button[aria-haspopup="menu"]) = ModelSelect 根
 *           （ModelSelect.tsx：根 div 下唯一直接子 button 带 aria-haspopup="menu"；
 *            ContextMeter 是 span、发送是 button，均不是"直接子 button 带 haspopup 的 div"）
 * 「⋯」按钮 append 到 row 尾（button 不参与 div:first-child / last-of-type），
 * CSS order:-1 视觉排最左。
 */

/** html 属性名：上拉弹窗开关（mobile.css 的 fixed 底栏规则作用域）。 */
export const SHEET_ATTR = 'data-dsh-mobile-sheet'

/** 入口按钮类名（mobile.css 提供样式）。 */
export const MORE_BTN_CLASS = 'dsh-mobile-more-btn'

/**
 * 工具栏行选择器：限定在 composer 卡片内，避免误伤其它 data-input-scroll。
 * data-composer-card 是 InputBar 卡片的稳定属性；其内 scroll 的下一个兄弟 div 即 .row。
 */
const ROW_SELECTOR = '[data-composer-card] > [data-input-scroll] + div'

/**
 * 模型选择根节点选择器（.trailing 内、带 haspopup 触发按钮的 div）。
 * 与 mobile.css 第 10 节模型收纳规则保持同一锚点，供"点外部关闭"判断。
 */
const MODEL_SELECTOR =
  `${ROW_SELECTOR} > div:last-of-type > div:has(> button[aria-haspopup="menu"])`

/** .tools 选择器（row 第一个 div 子元素）。 */
const TOOLS_SELECTOR = `${ROW_SELECTOR} > div:first-child`

/** 入口按钮内联 SVG（三个圆点，16px 描边风格，跟随 currentColor）。 */
const MORE_BTN_SVG =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
  '<circle cx="3" cy="8" r="1.5" fill="currentColor"/>' +
  '<circle cx="8" cy="8" r="1.5" fill="currentColor"/>' +
  '<circle cx="13" cy="8" r="1.5" fill="currentColor"/></svg>'

/** 弹窗当前是否打开（html 属性是否存在）。 */
function isSheetOpen(): boolean {
  return document.documentElement.hasAttribute(SHEET_ATTR)
}

/** 切换弹窗开关（mobile.css 消费该属性显示/隐藏 .tools + 模型底栏）。 */
function setSheetOpen(open: boolean): void {
  const el = document.documentElement
  if (open) el.setAttribute(SHEET_ATTR, 'on')
  else el.removeAttribute(SHEET_ATTR)
}

/**
 * 创建输入栏上拉弹窗增强。
 *
 * @returns dispose：移动模式退出/卸载时调用，清理按钮与监听。
 */
export function createInputSheetEnhance(): () => void {
  let disposed = false
  let observer: MutationObserver | null = null
  /** rAF 节流句柄：MutationObserver 高频触发时合并为每帧一次 ensure。 */
  let raf = 0

  /**
   * 确保每个工具栏行都有一个「⋯」按钮（幂等：已有则跳过）。
   * 可能存在多个 composer（hero 空会话 + 当前会话），全部注入。
   */
  const ensureButton = (): void => {
    if (disposed) return
    const rows = document.querySelectorAll<HTMLElement>(ROW_SELECTOR)
    for (const row of rows) {
      if (row.querySelector(`.${MORE_BTN_CLASS}`) !== null) continue

      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = MORE_BTN_CLASS
      btn.setAttribute('aria-label', '更多操作')
      btn.setAttribute('aria-haspopup', 'true')
      btn.setAttribute('aria-expanded', isSheetOpen() ? 'true' : 'false')
      btn.innerHTML = MORE_BTN_SVG
      btn.addEventListener('click', (e) => {
        e.stopPropagation() // 不冒泡到 document（避免与"点外部关闭"冲突）
        const next = !isSheetOpen()
        setSheetOpen(next)
        // 同步所有入口按钮的 expanded 态（多 composer 时一致）
        document.querySelectorAll(`.${MORE_BTN_CLASS}`).forEach((el) => {
          el.setAttribute('aria-expanded', next ? 'true' : 'false')
        })
      })
      // ⚠️ 必须 append 到行尾而非 insertBefore(firstChild)：CSS 用
      // `> div:first-child` 选 .tools、`> div:last-of-type` 选 .trailing；
      // 按钮是 <button> 不参与 div 计数，插尾不影响两者匹配。
      // 视觉位置靠 CSS `order: -1` 排最左（space-between 下贴左）。
      row.appendChild(btn)
    }
  }

  /** 调度 ensureButton：rAF 合并同帧内多次 mutation（与 tab-collapse 同款）。 */
  const scheduleEnsure = (): void => {
    if (disposed || raf !== 0) return
    raf = requestAnimationFrame(() => {
      raf = 0
      // 复查 disposed：cleanup 后若 rAF 已入队，不得再注入（宽屏残留踩坑同款）
      if (!disposed) ensureButton()
    })
  }

  /**
   * 点击弹窗外部 → 关闭弹窗。
   * 外部 = 非入口按钮、非 .tools 底栏、非模型选择（含其下拉菜单）。
   * 模型下拉菜单可能 portal 到 body，用 closest 兜底：触发按钮在 model 根内即可。
   */
  const onDocClick = (e: MouseEvent): void => {
    if (!isSheetOpen()) return
    const target = e.target as Node | null
    if (target === null) return
    const el = target instanceof Element ? target : target.parentElement
    if (el === null) return

    // 点「⋯」由按钮自身 handler 处理（stopPropagation 后通常到不了这）
    if (el.closest(`.${MORE_BTN_CLASS}`) !== null) return
    // 点在 .tools 底栏内（加号 / 权限 Menu 触发区）
    for (const tools of document.querySelectorAll(TOOLS_SELECTOR)) {
      if (tools.contains(target)) return
    }
    // 点在模型选择根内（触发 chip）；下拉菜单若仍挂在根下也覆盖
    for (const model of document.querySelectorAll(MODEL_SELECTOR)) {
      if (model.contains(target)) return
    }
    // 权限/模型的浮层菜单可能挂到 body（Menu portal）：带 role=menu 且
    // 仍在 sheet 打开期间点击菜单项时不关——否则选一项就关 sheet 体验差。
    if (el.closest('[role="menu"], [role="listbox"], [role="dialog"]') !== null) return

    setSheetOpen(false)
    document.querySelectorAll(`.${MORE_BTN_CLASS}`).forEach((b) => {
      b.setAttribute('aria-expanded', 'false')
    })
  }

  // 保活：React 重渲染会清掉注入的按钮，MutationObserver 观察 body 子树，
  // rAF 节流后 O(n rows) 检查补插（与 session-filter / tab-collapse 同款）。
  ensureButton()
  observer = new MutationObserver(scheduleEnsure)
  observer.observe(document.body, { childList: true, subtree: true })
  // capture=false：按钮 click 先 stopPropagation，再冒泡到这里处理外部关闭
  document.addEventListener('click', onDocClick)

  return () => {
    disposed = true
    if (raf !== 0) {
      cancelAnimationFrame(raf)
      raf = 0
    }
    if (observer !== null) observer.disconnect()
    document.removeEventListener('click', onDocClick)
    document.documentElement.removeAttribute(SHEET_ATTR)
    document.querySelectorAll(`.${MORE_BTN_CLASS}`).forEach((btn) => {
      btn.parentElement?.removeChild(btn)
    })
  }
}
