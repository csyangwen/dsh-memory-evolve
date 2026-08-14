/**
 * 无限画板（canvas-grok）数据模型。
 *
 * 语义对齐规格 §4：节点带三层归属、自由摆放 placement、可选路径/正文。
 * 一期纯前端，不对接宿主 API；后续主会话接入后端时尽量保持这些字段。
 */

/** 一期 6 类卡片。音/视频合并为 media（规格：音视频一类）。 */
export type CanvasNodeType =
  | 'folder'
  | 'markdown'
  | 'plainText'
  | 'image'
  | 'media'
  | 'file'

/** 节点物理归属：会话 / 项目 / 全局。筛选只改视角，不改这个字段。 */
export type CanvasScope = 'session' | 'project' | 'global'

/** 视角筛选：会话视角 / 项目视角 / 全局视角。 */
export type CanvasViewMode = 'session' | 'project' | 'global'

/** 卡片在世界坐标系中的摆放（单位：世界 px，不受缩放影响）。 */
export interface CanvasPlacement {
  x: number
  y: number
  width: number
  height: number
  zIndex: number
}

/** 可选元信息（模拟值，后端接入后由真实 stat 填充）。 */
export interface CanvasNodeMeta {
  size?: string
  mtime?: string
}

/**
 * 画板节点。
 * `sessionId` / `projectId` 是规格模型上的扩展：没有它们就无法演示
 * 「其他会话的卡片在会话视角下隐藏、项目视角下可见」。
 */
export interface CanvasNode {
  id: string
  type: CanvasNodeType
  title: string
  scope: CanvasScope
  /** 徽标文案：会话名 / 项目名 / 「全局」。 */
  scopeLabel: string
  /** 归属到哪一次会话（scope=session 时有意义）。 */
  sessionId?: string
  /** 归属到哪个项目（scope=session|project 时有意义）。 */
  projectId?: string
  /** 路径上板留下的本地路径（不校验是否存在）。 */
  path?: string
  /** 文本类正文（markdown / 纯文本 / AI 便签）。 */
  content?: string
  placement: CanvasPlacement
  meta?: CanvasNodeMeta
  /** AI 模拟投放标记，卡片上显示「AI 放置」。 */
  aiPlaced?: boolean
  /** 路径上板未做存在性校验。 */
  unverified?: boolean
  createdAt: number
}

/**
 * 视口相机：世界层做 `translate3d(x,y,0) scale(s)`。
 * (x, y) 是世界原点落到屏幕上的位置（屏幕像素）。
 */
export interface CanvasViewport {
  x: number
  y: number
  scale: number
}

/** localStorage 整板快照。 */
export interface CanvasPersistState {
  version: 1
  nodes: CanvasNode[]
  viewport: CanvasViewport
  viewMode: CanvasViewMode
  /** 最近一次 AI 投放的节点 id，供「跳到最近 AI 写入」。 */
  lastAiNodeId: string | null
}

/** 工具条上打开的对话框种类。 */
export type CanvasDialogKind = 'path' | 'note' | 'catalog' | 'preview' | 'remove' | null
