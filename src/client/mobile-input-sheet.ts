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
 * （mobile.css 据此把 .tools 与模型选择以 fixed 底栏形式显示，见第 10 节）；
 * ③**实测当前模型 chip 与 visualViewport 几何，写入菜单 fixed 定位变量**
 * （left/width/top/bottom/max-height 全部与 --dsh-composer-height 解耦）；
 * ④capture 阶段保存 sheet 内点击的 composedPath，避免 React 换 pane 后旧节点
 * 脱离 DOM、document bubble 阶段误判为外部点击。
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
 * 菜单限高 CSS 变量名（写在 <html> style 上，mobile.css 消费）。
 * 值 = chip 顶边以上可用高度（px），与 --dsh-composer-height 无关。
 */
export const MENU_MAX_H_VAR = '--dsh-mobile-menu-max-h'

/**
 * 菜单的视口定位变量。
 *
 * 菜单统一使用 position:fixed；enhance 按当前实际触发/展开的 ModelSelect
 * 与 visualViewport 实测 left / width / top / bottom。这样真机 WebView 不再
 * 需要组合“fixed 模型根 + absolute 子菜单”两个定位上下文。
 */
export const MENU_LEFT_VAR = '--dsh-mobile-menu-left'
export const MENU_WIDTH_VAR = '--dsh-mobile-menu-width'
export const MENU_TOP_VAR = '--dsh-mobile-menu-top'
export const MENU_BOTTOM_VAR = '--dsh-mobile-menu-bottom'

/**
 * 极端高座位 flip 标记（html 属性）：chip 上方放不下一级两行（~88px）时，
 * JS 把 fixed 菜单的 top/bottom 变量切到视口顶模式；属性保留作真机诊断标记。
 */
export const MENU_FLIP_ATTR = 'data-dsh-mobile-menu-flip'

/** 一级两行 cell + padding 的最小舒适高度；低于此走 flip 浮层。 */
const MENU_COMFORT_MIN = 100

/**
 * 工具栏行选择器：限定在 composer 卡片内，避免误伤其它 data-input-scroll。
 * data-composer-card 是 InputBar 卡片的稳定属性；其内 scroll 的下一个兄弟 div 即 .row。
 */
const ROW_SELECTOR = '[data-composer-card] > [data-input-scroll] + div'

/**
 * 模型选择根节点选择器（.trailing 内、带 haspopup 触发按钮的 div）。
 * 与 mobile.css 第 10 节模型收纳规则保持同一锚点，供"点外部关闭"判断 + 几何实测。
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

/** 菜单限高上限（px）：对齐原生 ModelSelect.module.css 的 360。 */
const MENU_MAX_H_CAP = 360
/** 视口顶边呼吸边距（px），避免菜单贴齐状态栏/刘海。 */
const MENU_TOP_MARGIN = 12
/** 菜单底边与模型 chip 顶边之间的视觉间距（px）。 */
const MENU_TRIGGER_GAP = 8

/**
 * 清除全部菜单几何状态。
 *
 * sheet 关闭、移动适配卸载、或当前没有实际展开实例时必须整组清除，避免把
 * 上一会话 / 上一方向 / 键盘弹起态的坐标带到下一次菜单首帧。
 */
function clearMenuGeometry(): void {
  const html = document.documentElement
  html.style.removeProperty(MENU_MAX_H_VAR)
  html.style.removeProperty(MENU_LEFT_VAR)
  html.style.removeProperty(MENU_WIDTH_VAR)
  html.style.removeProperty(MENU_TOP_VAR)
  html.style.removeProperty(MENU_BOTTOM_VAR)
  html.removeAttribute(MENU_FLIP_ATTR)
}

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
 * 根据模型 chip（底栏右侧 fixed 层）的实测几何，写入菜单完整 fixed 坐标与
 * 限高 CSS 变量，并在 chip 上方空间不足时切换 flip 浮层模式。
 *
 * ## 为什么必须 JS 实测（v1 教训）
 * v1 用 `max-height: 100dvh - var(--dsh-composer-height) - 80` 推算可用高度。
 * --dsh-composer-height 是整个 composerSeat 高度（含 dock 卡/统计行/多行草稿），
 * 真机正常会话 / 键盘弹起后视觉视口变矮时，公式把 max-height 压到 ≤60px，
 * 一级菜单看起来「没出来」。本函数直接量 chip 的 getBoundingClientRect()，
 * 明确写入菜单横向范围、底边与可用高度，与座位高度变量完全解耦。
 *
 * ## 两种模式
 * - **正常**（chip 上方 ≥ ~100px）：fixed 菜单 bottom 贴 chip 顶，向上生长。
 * - **flip**（chip 被高座位顶到视口上半、上方不够一级两行）：html 挂
 *   data-dsh-mobile-menu-flip，top 贴视觉视口顶、bottom=auto，并按视口限高。
 *   仍不读 --dsh-composer-height；牺牲「贴 chip」换取菜单完整可见。
 *
 * ## 坐标系
 * - 使用 visualViewport（键盘弹起时 layout 高度不缩，视觉视口会缩）；
 * - visualViewport.offsetTop/offsetLeft 用来换算视觉窗口在 layout 中的位置；
 * - 无 visualViewport 时退回 window.innerWidth/innerHeight 与零偏移。
 *
 * sheet 关闭时清除变量与 flip 属性，避免残留。
 */
function updateMenuGeometry(preferredRoot?: HTMLElement): void {
  const html = document.documentElement
  if (!isSheetOpen()) {
    clearMenuGeometry()
    return
  }

  /*
   * 页面可能同时保留 hero 与当前会话 composer。旧版遍历所有可见根并取最靠上
   * 的一个，真机会被另一个仍在 DOM 中的 composer 抢走坐标，菜单随后被定位到
   * 用户没有点击的位置。
   *
   * - preferredRoot：来自 click capture；React 挂菜单前就锁定本次 trigger，
   *   确保首帧已有正确坐标。
   * - 常规重测：只认 aria-expanded=true 的实例；没有展开菜单就清除坐标，
   *   不再猜测“哪个可见 composer 可能是活动实例”。
   */
  const activeRoot = preferredRoot ?? document.querySelector<HTMLElement>(
    `${MODEL_SELECTOR}:has(> button[aria-expanded="true"])`,
  )
  if (activeRoot === null) {
    clearMenuGeometry()
    return
  }

  const cs = getComputedStyle(activeRoot)
  const rect = activeRoot.getBoundingClientRect()
  if (
    cs.display === 'none' ||
    cs.visibility === 'hidden' ||
    (rect.width <= 0 && rect.height <= 0)
  ) {
    clearMenuGeometry()
    return
  }

  const vv = window.visualViewport
  /*
   * getBoundingClientRect() / position:fixed 以 layout viewport 为 CSS 坐标系；
   * visualViewport.offsetTop/offsetLeft 给出键盘、缩放与动态工具栏变化后，真正
   * 可见窗口在 layout viewport 中的偏移。把所有值统一为 layout 坐标再写入
   * CSS，避免旧版只计算 max-height、实际位置仍交给嵌套定位自行推导。
   */
  const viewTop = vv?.offsetTop ?? 0
  const viewLeft = vv?.offsetLeft ?? 0
  const viewWidth = vv?.width ?? window.innerWidth
  const viewHeight = vv?.height ?? window.innerHeight
  const layoutHeight = document.documentElement.clientHeight || window.innerHeight
  const menuBottomY = rect.top - MENU_TRIGGER_GAP
  const available = Math.floor(menuBottomY - (viewTop + MENU_TOP_MARGIN))

  html.style.setProperty(MENU_LEFT_VAR, `${Math.round(viewLeft + MENU_TOP_MARGIN)}px`)
  html.style.setProperty(
    MENU_WIDTH_VAR,
    `${Math.max(1, Math.floor(viewWidth - MENU_TOP_MARGIN * 2))}px`,
  )

  if (available >= MENU_COMFORT_MIN) {
    /*
     * 正常模式：菜单底边精确落在 chip 顶边上方 8px，并向上生长。
     * top 必须显式写 auto，否则上一次 flip 的 top 值会与 bottom 同时约束盒子。
     */
    html.removeAttribute(MENU_FLIP_ATTR)
    html.style.setProperty(MENU_TOP_VAR, 'auto')
    html.style.setProperty(
      MENU_BOTTOM_VAR,
      `${Math.max(0, Math.round(layoutHeight - menuBottomY))}px`,
    )
    html.style.setProperty(MENU_MAX_H_VAR, `${Math.min(MENU_MAX_H_CAP, available)}px`)
    return
  }

  /*
   * 极端高座位 / 键盘态：chip 上方连一级两行都放不下。菜单固定到视觉视口
   * 顶部安全区并允许覆盖输入区；可见、可滚优先于继续紧贴 chip。
   */
  html.setAttribute(MENU_FLIP_ATTR, 'on')
  html.style.setProperty(MENU_TOP_VAR, `${Math.round(viewTop + MENU_TOP_MARGIN)}px`)
  html.style.setProperty(MENU_BOTTOM_VAR, 'auto')
  html.style.setProperty(
    MENU_MAX_H_VAR,
    `${Math.max(1, Math.min(MENU_MAX_H_CAP, Math.floor(viewHeight - MENU_TOP_MARGIN * 2)))}px`,
  )
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
  /** 几何更新 rAF 句柄（resize / vv / mutation 合并）。 */
  let geoRaf = 0
  /**
   * capture 阶段确认“本次 click 起点在 sheet 内”的事件集合。
   * WeakSet 不持有事件生命周期之外的引用，不需要定时清理。
   */
  const insideSheetClicks = new WeakSet<MouseEvent>()

  /** 调度菜单几何更新：同帧多次事件合并为一次实测。 */
  const scheduleMenuGeometry = (): void => {
    if (disposed || geoRaf !== 0) return
    geoRaf = requestAnimationFrame(() => {
      geoRaf = 0
      if (!disposed) updateMenuGeometry()
    })
  }

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
        // sheet 开/关后下一帧再量：fixed 底栏 layout 完成后 chip.top 才准
        scheduleMenuGeometry()
      })
      // ⚠️ 必须 append 到行尾而非 insertBefore(firstChild)：CSS 用
      // `> div:first-child` 选 .tools、`> div:last-of-type` 选 .trailing；
      // 按钮是 <button> 不参与 div 计数，插尾不影响两者匹配。
      // 视觉位置靠 CSS `order: -1` 排最左（space-between 下贴左）。
      row.appendChild(btn)
    }
    // 新 composer 挂载 / React 重渲后补一次几何（sheet 开着时 chip 可能刚出现）
    if (isSheetOpen()) scheduleMenuGeometry()
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
   * 在 React 的 bubble onClick 之前保存原始 composedPath 命中结果。
   *
   * 真机事件根因：点击一级“模型/思考强度”后，ModelSelect 的 React onClick
   * 会同步 setPane，旧按钮节点随即卸载。等 document bubble click 执行时，
   * event.target 已可能是脱离 DOM 的旧节点，contains() 与 closest('[role=menu]')
   * 都会返回 false，旧实现因此把菜单内点击误判成外部点击并关闭整个 sheet。
   * composedPath 在事件派发开始时已经生成，capture 阶段读取不会受随后 React
   * 替换 pane DOM 的影响。
   */
  const onDocClickCapture = (e: MouseEvent): void => {
    if (!isSheetOpen()) return

    let modelRoot: HTMLElement | undefined
    const inside = e.composedPath().some((node) => {
      if (!(node instanceof Element)) return false
      if (node.classList.contains(MORE_BTN_CLASS)) return true
      if (node.matches('[role="menu"], [role="listbox"], [role="dialog"]')) return true
      if (node.matches(TOOLS_SELECTOR)) return true
      if (node.matches(MODEL_SELECTOR)) {
        modelRoot = node as HTMLElement
        return true
      }
      return false
    })
    if (inside) insideSheetClicks.add(e)

    /*
     * 点击模型 trigger 时菜单尚未挂载，但模型根的 fixed 几何已经稳定；在
     * React 打开菜单前预写本实例坐标，确保真机首帧也不会使用 CSS 兜底位置。
     * 菜单内部点击会先遇到 role=menu 并短路，不会错误改选其它 composer。
     */
    if (modelRoot !== undefined) updateMenuGeometry(modelRoot)
  }

  /**
   * 点击弹窗外部 → 关闭弹窗。
   * 外部 = 非入口按钮、非 .tools 底栏、非模型选择（含其下拉菜单）。
   * 模型下拉菜单可能 portal 到 body，用 closest 兜底：触发按钮在 model 根内即可。
   */
  const onDocClick = (e: MouseEvent): void => {
    if (!isSheetOpen()) return
    // capture 命中优先：即使 React 已替换/卸载 target，也仍是 sheet 内点击。
    if (insideSheetClicks.has(e)) {
      // pane 切换会改变同一 menu 的内容高度，下一帧按新 DOM 再测一次。
      scheduleMenuGeometry()
      return
    }
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
    // 关 sheet 后下一帧清掉整组定位变量与 flip 标记。
    scheduleMenuGeometry()
  }

  /**
   * 窗口 / 视觉视口变化 → 重算菜单完整 fixed 坐标与限高。
   * 覆盖：旋转、地址栏显隐、软键盘弹起（visualViewport resize/scroll）、
   * 座位高度变化导致 chip 上下移动（此时 --dsh-composer-height 会变，但我们
   * 不读它，只重测 chip.top）。
   */
  const onViewportChange = (): void => {
    if (isSheetOpen()) scheduleMenuGeometry()
  }

  // 保活：React 重渲染会清掉注入的按钮，MutationObserver 观察 body 子树，
  // rAF 节流后 O(n rows) 检查补插（与 session-filter / tab-collapse 同款）。
  ensureButton()
  observer = new MutationObserver(scheduleEnsure)
  observer.observe(document.body, { childList: true, subtree: true })
  // capture 先保存稳定的 composedPath；bubble 再决定是否关闭，避免阻断目标控件。
  document.addEventListener('click', onDocClickCapture, true)
  document.addEventListener('click', onDocClick)
  window.addEventListener('resize', onViewportChange)
  // visualViewport：手机键盘/动态工具栏；部分桌面无此对象
  window.visualViewport?.addEventListener('resize', onViewportChange)
  window.visualViewport?.addEventListener('scroll', onViewportChange)

  return () => {
    disposed = true
    if (raf !== 0) {
      cancelAnimationFrame(raf)
      raf = 0
    }
    if (geoRaf !== 0) {
      cancelAnimationFrame(geoRaf)
      geoRaf = 0
    }
    if (observer !== null) observer.disconnect()
    document.removeEventListener('click', onDocClickCapture, true)
    document.removeEventListener('click', onDocClick)
    window.removeEventListener('resize', onViewportChange)
    window.visualViewport?.removeEventListener('resize', onViewportChange)
    window.visualViewport?.removeEventListener('scroll', onViewportChange)
    document.documentElement.removeAttribute(SHEET_ATTR)
    clearMenuGeometry()
    document.querySelectorAll(`.${MORE_BTN_CLASS}`).forEach((btn) => {
      btn.parentElement?.removeChild(btn)
    })
  }
}
