import type { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { CanvasView } from './CanvasView.tsx'
import styles from './styles.css'

/** 主入口需要传入的最小选项；t 保持与现有各 Tab 的注册签名一致。 */
export interface RegisterCanvasTabOptions {
  t: Translate
  /** 可选覆盖：槽位 id（默认 canvas-hub；双实现并存对比时用不同 id） */
  id?: string
  /** 可选覆盖：Tab 显示名（默认 画板） */
  label?: string
  /** 可选覆盖：排序（默认 80） */
  order?: number
}

/** 结构化上下文避免绑定 Cordis 的包别名，主入口 ctx 可直接赋值。 */
export interface CanvasTabContext {
  slots: SlotRegistry
}

/** 模块级样式引用计数，防止同一页面重复注册时插入多个大样式标签。 */
let styleUsers = 0
let styleTag: HTMLStyleElement | null = null

function retainStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  styleUsers += 1
  if (styleTag === null || !styleTag.isConnected) {
    const existing = document.querySelector<HTMLStyleElement>('style[data-canvas-codex-css]')
    styleTag = existing ?? document.createElement('style')
    if (existing === null) {
      styleTag.dataset.canvasCodexCss = '1'
      styleTag.textContent = styles
      document.head.appendChild(styleTag)
    }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    styleUsers = Math.max(0, styleUsers - 1)
    if (styleUsers === 0) {
      styleTag?.remove()
      styleTag = null
    }
  }
}

/**
 * 注册「画板」conversation.view Tab，并返回幂等 disposer。
 *
 * slots.inject 会等待宿主声明 conversation.view 后再注册，兼容 DSH 当前的
 * ledger 生命周期；样式与槽位使用同一个 disposer 回收，不会在插件热卸载
 * 后残留。主会话只需在 apply(ctx) 中调用本函数，并把返回值纳入 ctx.effect。
 */
export function registerCanvasTab(
  ctx: CanvasTabContext,
  opts: RegisterCanvasTabOptions,
): () => void {
  const releaseStyles = retainStyles()
  let disposeSlot: (() => void) | undefined
  try {
    disposeSlot = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: opts.id ?? 'canvas-hub',
        order: opts.order ?? 80,
        label: () => opts.label ?? '画板',
      }, (slotProps) => CanvasView({ ...slotProps, t: opts.t })))
  } catch (error) {
    releaseStyles()
    throw error
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    disposeSlot?.()
    releaseStyles()
  }
}

export { CanvasView } from './CanvasView.tsx'
export type { CanvasNode, CanvasState } from './types.ts'
