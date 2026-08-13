/**
 * 无限画板一期的前端数据契约。
 *
 * 这里刻意把“素材内容”和“画布摆放”放在同一个小模型中：一期只使用
 * localStorage，后续接宿主 API 时可以直接把 CanvasState 当作传输对象，
 * 而视口虚拟化只需要读取 placement，不依赖卡片内部 DOM。
 */

/** 一期支持的六类卡片。音频与视频共用 media 类型。 */
export type CanvasNodeType = 'folder' | 'markdown' | 'plainText' | 'image' | 'media' | 'file'

/** 节点归属层级。 */
export type CanvasScope = 'session' | 'project' | 'global'

/** 单板的三个可见视角。 */
export type CanvasPerspective = 'session' | 'project' | 'global'

/** 世界坐标中的卡片矩形；x/y 是左上角，不跟随屏幕像素变化。 */
export interface CanvasPlacement {
  x: number
  y: number
  width: number
  height: number
  zIndex: number
}

/** 当前节点的真实归属键。标签只负责展示，键负责视角筛选。 */
export interface CanvasOwnership {
  sessionId?: string
  projectId?: string
}

/** 卡片节点。previewUrl 只存一期内置 data URL，不访问网络。 */
export interface CanvasNode {
  id: string
  type: CanvasNodeType
  title: string
  scope: CanvasScope
  scopeLabel: string
  ownership: CanvasOwnership
  path?: string
  content?: string
  previewUrl?: string
  placement: CanvasPlacement
  meta?: {
    size?: string
    mtime?: string
    unverified?: boolean
  }
  aiPlaced?: boolean
  createdAt: number
}

/** 画布视口使用屏幕平移量 + 世界缩放比例。 */
export interface CanvasViewport {
  x: number
  y: number
  scale: number
}

/** localStorage 中的完整一期状态。 */
export interface CanvasState {
  version: 1
  nodes: CanvasNode[]
  viewport: CanvasViewport
  perspective: CanvasPerspective
  lastAiNodeId?: string
}

/** 当前宿主会话派生出的前端归属上下文。 */
export interface CanvasOwnerContext {
  sessionId: string
  sessionLabel: string
  projectId: string
  projectLabel: string
}

