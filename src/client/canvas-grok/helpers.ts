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

export function scopeBadgeText(node: CanvasNode, currentSessionId?: string): string {
  if (node.scope === 'global') return `🌐 ${node.scopeLabel || '全局'}`
  if (node.scope === 'project') return `📁 ${node.scopeLabel}`
  // 会话级节点：归属文案必须按**查看者视角**呈现（2026-08-14 修复）——
  // 后端存的是「放置者视角」的 scopeLabel（add_note 时写死『当前会话』），
  // 其他会话看全局筛选时会出现「这张不是我的便签却标着当前会话」的迷惑。
  // 这里用节点归属 sessionId 与查看者 sessionId 比对：
  //   相同 → 我自己会话的便签，显示「当前会话」；
  //   不同 → 其他会话放的，显示「其他会话」+ **会话显示名**（后端
  //     解析：别名→会话标题；2026-08-14 用户要求不再显示长 sessionId，
  //     解析不到才兜底短 id）。
  if (currentSessionId && node.sessionId && node.sessionId === currentSessionId) {
    return `💬 当前会话`
  }
  if (node.sessionId) {
    const name = node.sessionName || shortSessionId(node.sessionId)
    return `💬 其他会话 ${name}`
  }
  return `💬 ${node.scopeLabel || '会话'}`
}

/** 会话短 id：取 session- 后的前 8 位（徽标防过长，够区分即可）。 */
export function shortSessionId(sessionId: string): string {
  const m = /^session-(.+)$/.exec(sessionId)
  return (m ? m[1] : sessionId).slice(0, 8)
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

/**
 * 把画板文本/便签内容保存到本机文件（2026-08-14 用户要求：AI 和用户
 * 加的文本/markdown 标签都能保存落地）。
 * 优先用 File System Access API 的 showSaveFilePicker——弹出**系统原生
 * 保存对话框**让用户选路径（Chrome 系浏览器；localhost/127.0.0.1 属
 * secure context 可用）；API 不可用/失败时降级为 Blob 下载（存到
 * 浏览器默认下载目录）。
 * @param {string} title - 建议文件名（自动清洗非法字符 + 补扩展名）
 * @param {string} content - 文件内容
 * @returns {Promise<{ ok: boolean; canceled?: boolean; message?: string }>}
 */
export async function saveTextToFile(title: string, content: string): Promise<{ ok: boolean; canceled?: boolean; message?: string }> {
  const safeName = sanitizeFileName(title) || '便签'
  const fileName = /\.(md|txt)$/i.test(safeName) ? safeName : `${safeName}.md`
  // 首选：系统原生保存对话框（File System Access API）。
  const picker = (window as unknown as { showSaveFilePicker?: (opts: object) => Promise<{
    createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>
  }> }).showSaveFilePicker
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName: fileName,
        types: [{
          description: 'Markdown 文本',
          accept: { 'text/markdown': ['.md', '.txt'] },
        }],
      })
      const writable = await handle.createWritable()
      await writable.write(content)
      await writable.close()
      return { ok: true }
    } catch (error) {
      // 用户取消（AbortError）不算失败；其他错误降级下载
      if ((error as { name?: string })?.name === 'AbortError') {
        return { ok: false, canceled: true }
      }
    }
  }
  // 降级：Blob 下载（存浏览器默认下载目录）。
  try {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    return { ok: true, message: '已下载到浏览器默认下载目录' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 清洗文件名非法字符（Windows/macOS 通用保留字符）。 */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120)
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
