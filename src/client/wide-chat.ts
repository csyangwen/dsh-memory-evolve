/**
 * dsh-memory-evolve — 对话区加宽功能（DSH UI 设置模块·功能 2）。
 *
 * 痛点（用户反馈 2026-08-09）：页面中间的对话历史/输入框区域只占右侧
 * 一半长度（居中对齐），左右空隙浪费。开启后把中间区域铺满可用宽度。
 *
 * 注（2026-10-30）：DSH 0.2.x 起该变量声明在 .body（[data-conversation-
 * content]）而不是根 [data-phase]，锚点已随之下移并改取 100%——详见
 * ui-settings-styles.css 对应注释。
 *
 * 实现原理：DSH 对话区宽度由 CSS 变量 `--dsh-chat-content-width`
 * （ConversationRoot.module.css 定义 748px）控制——对话历史、统计行、
 * 审批面板等都引用它，输入框是 `+32px` 派生（--dsh-composer-card-max-width），
 * 全部自动跟随。因此只需在对话区**变量声明所在元素**上覆盖该变量即可，
 * 无需逐元素改样式。
 *
 * 锚点注意：0.1.x 声明在根 [data-phase]，0.2.x 下移到 .body
 * （[data-conversation-content]）。声明下移后写在外层的值会被子元素自己
 * 的声明遮蔽（CSS 自定义属性按最近的声明生效，不是 specificity 问题），
 * 所以规则改为双锚点并写、取值也随之改为 100%（0.2.x 另有 920px clamp
 * 上限，写 95% 在宽屏上只多出二十几像素，观感仍是「没变」）。
 *
 * 手机端适配不走本模块（见 src/client/mobile.css 第 10 节——经
 * dshMobile 协议导出给 dsh-android-edapp，窄屏下覆盖为 100% 满宽）。
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
    /** 功能开关：false=恢复默认窄栏，true=铺满可用宽度。 */
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
 * 手机端适配不走本模块（见 src/client/mobile.css 第 10 节——经
 * dshMobile 协议导出给 dsh-android-edapp，窄屏下气泡覆盖为 100% 满宽）。
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
    /** 功能开关：false=恢复默认上限，true=气泡占内容框约 92%。 */
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
