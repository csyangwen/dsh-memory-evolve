/**
 * 无限画板 Tab 对外入口。
 *
 * 主会话在 `src/client/index.ts` 里调用 `registerCanvasTab(ctx, { t })` 即可挂上
 * conversation.view 槽（id: canvas-hub, order: 80, label: 画板）。
 * 本目录自包含：不要改 index.ts / build / package.json / lib/client.js。
 */
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { CanvasView } from './CanvasView.tsx'
import { STYLE_ATTR } from './constants.ts'
import styles from './styles.css'

/**
 * 注册所需的最小 ctx 面。主会话传入的 cordis Context 结构兼容。
 * 不用值导入 cordis / runtime，避免踩 client bundle 白名单。
 */
export interface CanvasTabHost {
  slots: {
    inject: (key: 'conversation.view', callback: () => (() => void)) => () => void
    register: (
      spec: {
        name: 'conversation.view'
        id: string
        order: number
        label: () => string
      },
      render: (props: import('@deepseek-ai/dsh-client-ui-conversation/client').ConvViewProps) => JSX.Element,
    ) => () => void
  }
}

export interface RegisterCanvasTabOpts {
  t: Translate
  /** 可选覆盖：槽位 id（默认 canvas-hub；双实现并存对比时用不同 id） */
  id?: string
  /** 可选覆盖：Tab 显示名（默认 画板） */
  label?: string
  /** 可选覆盖：排序（默认 80） */
  order?: number
}

/** 注入 cg- 前缀样式。已存在则跳过，避免热更重复挂。 */
function injectCanvasStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[${STYLE_ATTR}]`)
  if (existing !== null) return () => {}
  const tag = document.createElement('style')
  tag.setAttribute(STYLE_ATTR, '1')
  tag.textContent = styles
  document.head.appendChild(tag)
  return () => { tag.remove() }
}

/**
 * 注册「画板」Tab，返回卸载函数（卸 slot + 卸样式）。
 *
 * @example
 *   const dispose = registerCanvasTab(ctx, { t })
 */
export function registerCanvasTab(ctx: CanvasTabHost, opts: RegisterCanvasTabOpts): () => void {
  const disposeStyle = injectCanvasStyles()
  const slotId = opts.id ?? 'canvas-hub'
  const slotLabel = opts.label ?? '画板'
  const slotOrder = opts.order ?? 80
  const disposeSlot = ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: slotId,
      order: slotOrder,
      label: () => slotLabel,
    }, (props) => CanvasView({ ...props, t: opts.t })))
  return () => {
    disposeSlot()
    disposeStyle()
  }
}

export type {
  CanvasNode,
  CanvasNodeType,
  CanvasPersistState,
  CanvasScope,
  CanvasViewMode,
  CanvasViewport,
} from './types.ts'
export { STORAGE_KEY } from './constants.ts'
