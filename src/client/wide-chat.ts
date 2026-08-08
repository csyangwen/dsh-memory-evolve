/**
 * dsh-memory-evolve — 对话区加宽功能（DSH UI 设置模块·功能 2）。
 *
 * 痛点（用户反馈 2026-08-09）：页面中间的对话历史/输入框区域只占右侧
 * 一半长度（居中对齐），左右空隙浪费。开启后把中间区域扩大到约 95%。
 *
 * 实现原理：DSH 对话区宽度由 CSS 变量 `--dsh-chat-content-width`
 * （ConversationRoot.module.css 定义 748px）控制——对话历史、统计行、
 * 审批面板等都引用它，输入框是 `+32px` 派生（--dsh-composer-card-max-width），
 * 全部自动跟随。因此只需在对话区根元素（`[data-phase]`，ConversationRoot
 * 根 div 的稳定锚点）上覆盖该变量为 `95%`（相对右侧区域宽），无需逐元素
 * 改样式；选择器带 html 属性前缀且 specificity 更高，稳胜原声明。
 *
 * 由「综合」子 tab 的功能开关驱动（ui-settings-features.ts）：
 * setEnabled(false)=摘掉 html[data-dsh-ui-wide-chat] 属性恢复 748px；
 * true=挂属性加宽。
 */

/** html 属性名（CSS 规则的作用域开关，ui-settings-styles.css）。 */
export const WIDE_CHAT_ATTR = 'data-dsh-ui-wide-chat'

/**
 * 创建对话区加宽控制器（模块启用时调用一次）。
 *
 * @returns { setEnabled, dispose }：setEnabled 由功能开关事件驱动；
 *   dispose 模块卸载时清理。
 */
export function createWideChat(): {
  setEnabled: (enabled: boolean) => void
  dispose: () => void
} {
  let disposed = false

  return {
    /** 功能开关：false=恢复默认 748px 窄栏，true=加宽到约 95%。 */
    setEnabled(next: boolean): void {
      if (disposed) return
      const root = document.documentElement
      if (next) root.setAttribute(WIDE_CHAT_ATTR, 'on')
      else root.removeAttribute(WIDE_CHAT_ATTR)
    },
    dispose(): void {
      disposed = true
      document.documentElement.removeAttribute(WIDE_CHAT_ATTR)
    },
  }
}

/** html 属性名（CSS 规则的作用域开关，ui-settings-styles.css）。 */
export const WIDE_BUBBLE_ATTR = 'data-dsh-ui-wide-bubble'

/**
 * 创建消息气泡加宽控制器（模块启用时调用一次）。
 *
 * 纯 CSS 生效（规则见 ui-settings-styles.css：挂 html[data-dsh-ui-wide-bubble]
 * 后 `[data-time-hover-root] > div:first-of-type { max-width: 80% }`——
 * 用户消息行 userRow 有恒定 data-time-hover-root 锚点，bubble 恒为其
 * 第一个 div 子元素（steering 是 span、actions 是第二个 div），唯一命中），
 * JS 只负责挂/摘 html 属性。
 *
 * @returns { setEnabled, dispose }：setEnabled 由功能开关事件驱动；
 *   dispose 模块卸载时清理。
 */
export function createWideBubble(): {
  setEnabled: (enabled: boolean) => void
  dispose: () => void
} {
  let disposed = false

  return {
    /** 功能开关：false=恢复默认 min(525px,82%)，true=气泡占内容框 80%。 */
    setEnabled(next: boolean): void {
      if (disposed) return
      const root = document.documentElement
      if (next) root.setAttribute(WIDE_BUBBLE_ATTR, 'on')
      else root.removeAttribute(WIDE_BUBBLE_ATTR)
    },
    dispose(): void {
      disposed = true
      document.documentElement.removeAttribute(WIDE_BUBBLE_ATTR)
    },
  }
}
