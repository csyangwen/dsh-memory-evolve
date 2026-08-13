/**
 * 纯函数工具：id、路径推断类型、视角可见性、引用串、剪贴板、几何。
 * 不碰 React / DOM（除 copyText 用 navigator.clipboard）。
 */
import {
  CURRENT_PROJECT_ID,
  CURRENT_SESSION_ID,
  EXT_TYPE,
  TYPE_LABEL,
} from './constants.ts'
import type {
  CanvasNode,
  CanvasNodeType,
  CanvasViewMode,
  CanvasViewport,
} from './types.ts'

/** 稳定节点 id。标题会撞车，引用一律走 id。 */
export function createNodeId(): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `canvas_${Date.now().toString(36)}_${rand}`
}

/** 去掉包裹引号、首尾空白。 */
export function normalizePath(raw: string): string {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/** 从路径猜类型：以 / 或 \\ 结尾、无扩展名 → 文件夹；否则按扩展名表。 */
export function inferTypeFromPath(path: string): CanvasNodeType {
  const cleaned = normalizePath(path).replace(/\\/g, '/')
  if (!cleaned) return 'file'
  if (cleaned.endsWith('/')) return 'folder'
  const base = cleaned.split('/').pop() ?? cleaned
  if (!base.includes('.') || base.startsWith('.')) return 'folder'
  const ext = base.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TYPE[ext] ?? 'file'
}

export function titleFromPath(path: string): string {
  const cleaned = normalizePath(path).replace(/\\/g, '/').replace(/\/+$/, '')
  const base = cleaned.split('/').pop()
  return base && base.length > 0 ? base : cleaned || '未命名'
}

/** 人引用串：粘贴给 AI「去画板拿这个」。 */
export function toReferenceText(node: CanvasNode): string {
  return `[canvas:${node.id}] ${node.title}`
}

export function scopeBadgeText(node: CanvasNode): string {
  if (node.scope === 'global') return `🌐 ${node.scopeLabel || '全局'}`
  if (node.scope === 'project') return `📁 ${node.scopeLabel}`
  return `💬 ${node.scopeLabel}`
}

/**
 * 单板 + 视角筛选（调研拍板 C 方案）：
 * - 会话：当前会话 + 当前项目 + 全局（看不到其他会话）
 * - 项目：该项目下所有会话节点 + 项目节点 + 全局
 * - 全局：全部
 */
export function isNodeVisible(
  node: CanvasNode,
  viewMode: CanvasViewMode,
  sessionId: string = CURRENT_SESSION_ID,
  projectId: string = CURRENT_PROJECT_ID,
): boolean {
  if (viewMode === 'global') return true
  if (node.scope === 'global') return true
  if (viewMode === 'project') {
    if (node.scope === 'project') return (node.projectId ?? projectId) === projectId
    return node.projectId === projectId
  }
  // session 视角
  if (node.scope === 'project') return (node.projectId ?? projectId) === projectId
  return node.sessionId === sessionId
}

export function matchesQuery(node: CanvasNode, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const typeName = TYPE_LABEL[node.type]
  return (
    node.title.toLowerCase().includes(q)
    || node.type.toLowerCase().includes(q)
    || typeName.toLowerCase().includes(q)
    || (node.path?.toLowerCase().includes(q) ?? false)
    || node.id.toLowerCase().includes(q)
  )
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** 屏幕坐标 → 世界坐标。 */
export function screenToWorld(
  sx: number,
  sy: number,
  vp: CanvasViewport,
): { x: number; y: number } {
  return {
    x: (sx - vp.x) / vp.scale,
    y: (sy - vp.y) / vp.scale,
  }
}

/** 以屏幕点 (cx, cy) 为缩放中心，得到新的视口。 */
export function zoomAt(
  vp: CanvasViewport,
  cx: number,
  cy: number,
  nextScale: number,
): CanvasViewport {
  const worldX = (cx - vp.x) / vp.scale
  const worldY = (cy - vp.y) / vp.scale
  return {
    x: cx - worldX * nextScale,
    y: cy - worldY * nextScale,
    scale: nextScale,
  }
}

/** 让节点中心落到视口中心。 */
export function viewportToNode(
  node: CanvasNode,
  vp: CanvasViewport,
  viewW: number,
  viewH: number,
): CanvasViewport {
  const cx = node.placement.x + node.placement.width / 2
  const cy = node.placement.y + node.placement.height / 2
  return {
    x: viewW / 2 - cx * vp.scale,
    y: viewH / 2 - cy * vp.scale,
    scale: vp.scale,
  }
}

/** 世界矩形是否与视口（加 padding）相交。 */
export function intersectsViewport(
  node: CanvasNode,
  vp: CanvasViewport,
  viewW: number,
  viewH: number,
  pad: number,
): boolean {
  const { x, y, width, height } = node.placement
  const left = (-vp.x) / vp.scale - pad
  const top = (-vp.y) / vp.scale - pad
  const right = left + viewW / vp.scale + pad * 2
  const bottom = top + viewH / vp.scale + pad * 2
  return x + width >= left && x <= right && y + height >= top && y <= bottom
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 降级到 execCommand
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', 'true')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

/** 根据 id 生成稳定的占位渐变，让每张图片卡看起来不一样。 */
export function placeholderHue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 360
}

/** 事件目标是否正在输入（空格平移要避开）。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}
