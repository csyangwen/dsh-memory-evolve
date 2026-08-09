/**
 * dsh-memory-evolve — 上下文占用提醒（DSH UI 设置模块·功能五）。
 *
 * 痛点（用户反馈 2026-08-09）：输入框右下侧的上下文使用量**圆环**
 * （ContextMeter）平时是灰色小环，占用率高时没有警示。需求：**≥30% 变
 * 黄色提醒、≥40% 变红色提醒**，低于阈值恢复原色。
 *
 * 实现原理（调研文档 docs/DSH-UI设置模块-调研-20260809.md）：
 * - ContextMeter（ui-conversation/src/client/skeleton/ContextMeter.tsx）
 *   的进度环是 SVG circle：`strokeDasharray = "${C·p/100} ${C}"`
 *   （C=2π×5.5≈34.56 恒定）→ **percent 可直接反推**：p = dash/34.56×100；
 * - 颜色由 hash class `.fill`（stroke: --dsw-alias-label-tertiary）控制，
 *   插件改不了 class → JS 设 inline stroke（优先级高于 class 声明）；
 * - 稳定锚点：`button[aria-haspopup="dialog"] svg circle[stroke-dasharray]`
 *   （trigger 的 aria-haspopup="dialog" 唯一；TodoPanel 的虚线圆环是固定
 *   `2.4 2.4` 且不在 dialog 按钮内，天然排除）；
 * - 保活：percent 变化走 React 属性更新（stroke-dasharray）→
 *   MutationObserver 监听 `attributes`（仅 stroke-dasharray）+ childList
 *   （圆环元素重建后重应用）；
 * - 颜色用 DSH 状态 token：黄=--dsw-alias-state-warn-primary、
 *   红=--dsw-alias-state-error-primary（深浅主题自适应）。
 */

/** 圆环周长常数（DSH ContextMeter 内部固定：RADIUS=5.5）。DSH 若改半径需同步。 */
const RING_CIRCUMFERENCE = 2 * Math.PI * 5.5

/** 阈值（%）：≥40 红 / ≥30 黄 / 以下恢复默认。 */
const WARN_PERCENT = 30
const ERROR_PERCENT = 40

/** 阈值颜色（CSS 变量名，运行时取计算值，深浅主题自适应）。 */
const WARN_COLOR_VAR = '--dsw-alias-state-warn-primary'
const ERROR_COLOR_VAR = '--dsw-alias-state-error-primary'

/** 定位 ContextMeter 的进度环元素（稳定锚点，见文件头注释）。 */
function findRings(): SVGElement[] {
  return [...document.querySelectorAll<SVGElement>(
    'button[aria-haspopup="dialog"] svg circle[stroke-dasharray]',
  )]
}

/** 从 stroke-dasharray 反推占用百分比（0-100，四舍五入）。 */
function percentFromDasharray(circle: SVGElement): number | null {
  const dash = Number.parseFloat((circle.getAttribute('stroke-dasharray') ?? '').split(' ')[0] ?? '')
  if (!Number.isFinite(dash) || dash <= 0) return null
  return Math.min(100, Math.round(dash / RING_CIRCUMFERENCE * 100))
}

/** 解析 CSS 变量为具体颜色（未定义时回落该语义色系兜底值）。 */
function resolveColor(varName: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return value === '' ? fallback : value
}

/**
 * 创建上下文占用提醒控制器（模块启用时调用一次）。
 *
 * @returns { setEnabled, dispose }：setEnabled 由功能开关事件驱动
 *   （false=恢复全部圆环默认色并停观察，true=按阈值着色并开始观察）；
 *   dispose 模块卸载时清理。
 */
export function createContextMeterWarn(): {
  setEnabled: (enabled: boolean) => void
  dispose: () => void
} {
  let enabled = false
  let disposed = false
  let observer: MutationObserver | null = null

  /** 对当前所有圆环应用阈值色（<30% 恢复默认——移除 inline stroke）。 */
  const apply = (): void => {
    if (disposed) return
    const warn = resolveColor(WARN_COLOR_VAR, '#d97706')
    const error = resolveColor(ERROR_COLOR_VAR, '#dc2626')
    for (const ring of findRings()) {
      const percent = percentFromDasharray(ring)
      if (percent === null) continue
      const color = percent >= ERROR_PERCENT ? error : percent >= WARN_PERCENT ? warn : null
      if (color === null) ring.style.removeProperty('stroke')
      else ring.style.stroke = color
    }
  }

  /** 启动观察：percent 更新 = stroke-dasharray 属性变化（attributes）；
   *  圆环元素可能被 React 重建（childList+subtree 保活重应用）。 */
  const startObserver = (): void => {
    if (observer !== null || disposed) return
    observer = new MutationObserver(() => { apply() })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['stroke-dasharray'],
    })
  }

  return {
    setEnabled(next: boolean): void {
      if (disposed) return
      enabled = next
      if (enabled) {
        apply()
        startObserver()
      } else {
        observer?.disconnect()
        observer = null
        // 停用：移除所有 inline stroke，恢复 DSH 默认灰环。
        for (const ring of findRings()) ring.style.removeProperty('stroke')
      }
    },
    dispose(): void {
      disposed = true
      observer?.disconnect()
      observer = null
      for (const ring of findRings()) ring.style.removeProperty('stroke')
    },
  }
}
