/**
 * dsh-memory-evolve — DSH UI 设置模块：功能开关（共享状态）。
 *
 * 模块内每个功能都有**独立的小开关**（用户拍板：设置 Tab 的「综合」子
 * tab 里逐项开关）。开关是纯客户端偏好，存 localStorage；任何改动通过
 * 自定义事件广播，index.ts 的激活块监听后同步 DOM 注入（筛选条出现/
 * 消失、对话区加宽/恢复）。
 *
 * **默认值纪律（用户拍板 2026-08-09）：模块本身默认关（uiSettingsEnabled，
 * 插件配置里）**，**模块内每个功能也默认关**——一律由用户主动开启。
 * 注意：功能开启后，筛选条内部的模式偏好（仅进行中 vs 全部）单独记忆、
 * 无记录时默认「仅进行中」（见 session-filter.ts PREF_KEY）。
 */

/** 各功能开关的当前值。 */
export interface UiSettingsFeatures {
  /** 会话筛选：左侧会话列表只显示进行中的会话（关=筛选条不注入）。 */
  sessionFilter: boolean
  /** 对话区加宽：中间对话区域扩大到右侧约 95% 宽（关=默认 748px 居中窄栏）。 */
  wideChat: boolean
}

/** localStorage 键。 */
const FEATURES_KEY = 'dsh-memory-evolve:ui-settings:features'

/** 功能开关变更事件名（detail 为最新 features）。 */
export const FEATURES_EVENT = 'dsh-memory-evolve:ui-settings-features'

/** 默认值：全部功能默认关闭（用户拍板：由用户主动开启）。 */
const DEFAULTS: UiSettingsFeatures = { sessionFilter: false, wideChat: false }

/** 读取功能开关（localStorage 异常/缺字段时回落默认）。 */
export function readFeatures(): UiSettingsFeatures {
  try {
    const raw = localStorage.getItem(FEATURES_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<UiSettingsFeatures>
      return {
        sessionFilter: typeof parsed.sessionFilter === 'boolean' ? parsed.sessionFilter : DEFAULTS.sessionFilter,
        wideChat: typeof parsed.wideChat === 'boolean' ? parsed.wideChat : DEFAULTS.wideChat,
      }
    }
  } catch { /* 回落默认 */ }
  return { ...DEFAULTS }
}

/** 保存功能开关并广播变更事件（index.ts 监听后同步注入）。 */
export function writeFeatures(features: UiSettingsFeatures): void {
  try {
    localStorage.setItem(FEATURES_KEY, JSON.stringify(features))
  } catch { /* localStorage 不可用时仅本次会话内生效 */ }
  window.dispatchEvent(new CustomEvent<UiSettingsFeatures>(FEATURES_EVENT, { detail: { ...features } }))
}
