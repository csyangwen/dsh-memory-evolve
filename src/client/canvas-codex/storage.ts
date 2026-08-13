import type {
  CanvasNode,
  CanvasNodeType,
  CanvasOwnerContext,
  CanvasPerspective,
  CanvasScope,
  CanvasState,
  CanvasViewport,
} from './types.ts'

/** 一期固定键名；未来后端接入后仍可用它做一次性迁移来源。 */
export const CANVAS_STORAGE_KEY = 'memory-evolve.canvas.v1'

export const DEFAULT_VIEWPORT: CanvasViewport = { x: 520, y: 330, scale: 0.9 }

/** 卡片尺寸按预览复杂度控制，避免图像节点无谓占据巨幅绘制区域。 */
const NODE_SIZES: Record<CanvasNodeType, { width: number; height: number }> = {
  folder: { width: 300, height: 190 },
  markdown: { width: 320, height: 240 },
  plainText: { width: 300, height: 220 },
  image: { width: 320, height: 240 },
  media: { width: 320, height: 220 },
  file: { width: 300, height: 190 },
}

/** 纯前端搜索清单。path 只是演示文本，不会被读取或校验。 */
export interface MockSearchAsset {
  title: string
  path: string
  type: CanvasNodeType
  size: string
}

export const MOCK_SEARCH_ASSETS: readonly MockSearchAsset[] = [
  { title: '合同-甲乙方.pdf', path: '/Users/demo/Documents/合同-甲乙方.pdf', type: 'file', size: '2.4 MB' },
  { title: '首页设计稿-v3.png', path: '/Users/demo/Design/首页设计稿-v3.png', type: 'image', size: '4.8 MB' },
  { title: '产品需求说明.md', path: '/Users/demo/Projects/产品需求说明.md', type: 'markdown', size: '18 KB' },
  { title: '会议录音-0813.mp3', path: '/Users/demo/Recordings/会议录音-0813.mp3', type: 'media', size: '36 MB' },
  { title: '演示视频-cut.mp4', path: '/Users/demo/Movies/演示视频-cut.mp4', type: 'media', size: '128 MB' },
  { title: '项目规范文档.docx', path: '/Users/demo/Documents/项目规范文档.docx', type: 'file', size: '860 KB' },
  { title: '客户logo.svg', path: '/Users/demo/Assets/客户logo.svg', type: 'image', size: '42 KB' },
  { title: 'README.txt', path: '/Users/demo/Projects/README.txt', type: 'plainText', size: '6 KB' },
] as const

/**
 * 内置 SVG 图片既能展示真实 img 懒加载链路，也不会引入外部请求、跨域或
 * 不稳定的演示资源。encodeURIComponent 让它可安全存进 localStorage。
 */
export function createDemoImageUrl(label = 'CANVAS'): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#5b8def"/><stop offset="1" stop-color="#9b6df2"/></linearGradient></defs><rect width="640" height="360" rx="28" fill="url(#g)"/><circle cx="510" cy="90" r="54" fill="white" opacity=".2"/><path d="M70 285 205 150l92 91 64-63 165 107z" fill="white" opacity=".28"/><text x="48" y="74" font-family="system-ui,sans-serif" font-size="34" fill="white">${escapeSvg(label)}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function escapeSvg(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char] ?? char)
}

/** 使用 crypto UUID 时仍保留前缀，便于人和 AI 在复制串中辨认节点。 */
export function createCanvasId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  return `canvas_${random}`
}

/** 根据路径后缀做一期前端分类；无法确认的都安全降级为普通文件。 */
export function inferNodeType(path: string): CanvasNodeType {
  const lower = path.trim().toLowerCase()
  if (lower.endsWith('/') || lower.endsWith('\\')) return 'folder'
  if (/\.md(?:own)?$/.test(lower)) return 'markdown'
  if (/\.(?:txt|log|csv|json|ya?ml)$/.test(lower)) return 'plainText'
  if (/\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/.test(lower)) return 'image'
  if (/\.(?:mp3|wav|m4a|aac|ogg|mp4|mov|mkv|webm)$/.test(lower)) return 'media'
  // 一期无法 stat 路径：没有扩展名的尾段更常见于文件夹，优先按文件夹
  // 展示；即使猜错也只影响卡片外观，后续宿主校验可修正真实类型。
  if (!titleFromPath(lower).includes('.')) return 'folder'
  return 'file'
}

/** 从 POSIX / Windows 路径取最后一段；空路径回退为易懂标题。 */
export function titleFromPath(path: string): string {
  const clean = path.trim().replace(/[\\/]+$/, '')
  return clean.split(/[\\/]/).filter(Boolean).pop() ?? '未命名素材'
}

export interface CreateNodeInput {
  type: CanvasNodeType
  title: string
  scope: CanvasScope
  owner: CanvasOwnerContext
  x: number
  y: number
  path?: string
  content?: string
  size?: string
  unverified?: boolean
  aiPlaced?: boolean
  zIndex?: number
}

/** 所有上板入口共用工厂，确保归属键、尺寸和模拟预览一致。 */
export function createNode(input: CreateNodeInput): CanvasNode {
  const size = NODE_SIZES[input.type]
  const ownership = input.scope === 'session'
    ? { sessionId: input.owner.sessionId, projectId: input.owner.projectId }
    : input.scope === 'project'
      ? { projectId: input.owner.projectId }
      : {}
  const scopeLabel = input.scope === 'session'
    ? input.owner.sessionLabel
    : input.scope === 'project'
      ? input.owner.projectLabel
      : '全局'
  return {
    id: createCanvasId(),
    type: input.type,
    title: input.title.trim() || '未命名素材',
    scope: input.scope,
    scopeLabel,
    ownership,
    path: input.path,
    content: input.content,
    previewUrl: input.type === 'image' ? createDemoImageUrl(input.title.slice(0, 18)) : undefined,
    placement: {
      x: input.x,
      y: input.y,
      width: size.width,
      height: size.height,
      zIndex: input.zIndex ?? 1,
    },
    meta: {
      size: input.size,
      mtime: new Date().toLocaleDateString(),
      unverified: input.unverified,
    },
    aiPlaced: input.aiPlaced,
    createdAt: Date.now(),
  }
}

/** 首次进入预置不同类型、不同归属的卡片，覆盖三视角演示。 */
export function createInitialState(owner: CanvasOwnerContext): CanvasState {
  const current = createNode({
    type: 'markdown',
    title: '本次会话的工作便签',
    scope: 'session',
    owner,
    x: -420,
    y: -250,
    content: '# 今日目标\n\n把散落素材集中到画板，并随时复制引用给 AI。',
    zIndex: 1,
  })
  const project = createNode({
    type: 'image',
    title: '首页设计稿-v3.png',
    scope: 'project',
    owner,
    x: 20,
    y: -270,
    path: `${owner.projectId}/design/首页设计稿-v3.png`,
    size: '4.8 MB',
    zIndex: 2,
  })
  const global = createNode({
    type: 'folder',
    title: '常用合同模板',
    scope: 'global',
    owner,
    x: -400,
    y: 80,
    path: '/Users/demo/Documents/Templates/',
    size: '12 项',
    zIndex: 3,
  })
  const otherSession = createNode({
    type: 'media',
    title: '其他会话 · 会议录音-0813.mp3',
    scope: 'session',
    owner: {
      ...owner,
      sessionId: `${owner.sessionId}:other`,
      sessionLabel: '需求评审会话',
    },
    x: 30,
    y: 70,
    path: '/Users/demo/Recordings/会议录音-0813.mp3',
    size: '36 MB',
    zIndex: 4,
  })
  return {
    version: 1,
    nodes: [current, project, global, otherSession],
    viewport: { ...DEFAULT_VIEWPORT },
    perspective: 'session',
  }
}

/**
 * localStorage 是用户可编辑且跨版本残留的输入，加载时做轻量结构校验；
 * 不合格就回退初始状态，避免一个坏节点让整个 Tab 白屏。
 */
export function loadCanvasState(owner: CanvasOwnerContext): CanvasState {
  if (typeof window === 'undefined') return createInitialState(owner)
  try {
    const raw = window.localStorage.getItem(CANVAS_STORAGE_KEY)
    if (raw === null) return createInitialState(owner)
    const value = JSON.parse(raw) as Partial<CanvasState>
    if (value.version !== 1 || !Array.isArray(value.nodes)) return createInitialState(owner)
    const nodes = value.nodes.filter(isValidNode)
    const viewport = isValidViewport(value.viewport) ? value.viewport : { ...DEFAULT_VIEWPORT }
    const perspective = isPerspective(value.perspective) ? value.perspective : 'session'
    return { version: 1, nodes, viewport, perspective, lastAiNodeId: value.lastAiNodeId }
  } catch {
    return createInitialState(owner)
  }
}

/** 写入失败（隐私模式/配额）不应破坏当前内存态，调用方只需提示。 */
export function saveCanvasState(state: CanvasState): boolean {
  if (typeof window === 'undefined') return false
  try {
    window.localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

function isValidViewport(value: unknown): value is CanvasViewport {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return [row.x, row.y, row.scale].every((item) => typeof item === 'number' && Number.isFinite(item))
    && (row.scale as number) >= 0.1
    && (row.scale as number) <= 4
}

function isPerspective(value: unknown): value is CanvasPerspective {
  return value === 'session' || value === 'project' || value === 'global'
}

function isValidNode(value: unknown): value is CanvasNode {
  if (value === null || typeof value !== 'object') return false
  const node = value as Partial<CanvasNode>
  const placement = node.placement as Partial<CanvasNode['placement']> | undefined
  return typeof node.id === 'string'
    && typeof node.title === 'string'
    && ['folder', 'markdown', 'plainText', 'image', 'media', 'file'].includes(node.type ?? '')
    && ['session', 'project', 'global'].includes(node.scope ?? '')
    && typeof node.scopeLabel === 'string'
    && node.ownership !== null
    && typeof node.ownership === 'object'
    && placement !== undefined
    && [placement.x, placement.y, placement.width, placement.height, placement.zIndex]
      .every((item) => typeof item === 'number' && Number.isFinite(item))
}
