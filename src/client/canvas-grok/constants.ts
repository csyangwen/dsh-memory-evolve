/**
 * 画板常量：尺寸、LOD 阈值、存储键、模拟数据、当前「会话/项目」身份。
 * 全部集中在这里，方便后续接宿主时整块替换模拟身份。
 */
import type {
  CanvasNode,
  CanvasNodeType,
  CanvasPersistState,
  CanvasPlacement,
  CanvasViewport,
  CatalogItem,
} from './types.ts'

/**
 * localStorage 键（正式键）。此前双外援并存验收期用过分键
 * `memory-evolve.canvas.grok.v1`，2026-08-13 用户拍板选 Grok 版后统一
 * 回正式键；历史分键数据不再读取（验收期演示数据，无保留价值）。
 */
export const STORAGE_KEY = 'memory-evolve.canvas.v1'

/** 样式标签标记，卸载时按这个选择器清理。 */
export const STYLE_ATTR = 'data-cg-canvas-css'

/** 参考项目 ResourceNodeCard 的 LOD 阈值：scale < 0.36 只渲染图标。 */
export const LOD_SCALE = 0.36

/** 缩放范围：过小看不见、过大单卡撑满也没意义。 */
export const MIN_SCALE = 0.15
export const MAX_SCALE = 2.8

/** 滚轮单次缩放倍率。 */
export const ZOOM_STEP = 1.08

/** 视口虚拟化外边距（世界坐标）。平移时提前挂上即将入屏的卡片。 */
export const VIRT_PAD = 280

/** 画板内搜索命中闪烁时长。 */
export const FLASH_MS = 1400

/** 新节点 / AI 投放高亮时长。 */
export const HIGHLIGHT_MS = 1800

/** 持久化防抖。 */
export const PERSIST_DEBOUNCE_MS = 220

/**
 * 模拟「当前会话 / 当前项目」。
 * 纯前端一期写死；主会话接入后改为从 ConvViewProps / sessions 读取。
 */
export const CURRENT_SESSION_ID = 'sess-demo-current'
export const CURRENT_SESSION_LABEL = '当前会话'
export const OTHER_SESSION_ID = 'sess-demo-other'
export const OTHER_SESSION_LABEL = '上周评审会'
export const CURRENT_PROJECT_ID = 'proj-demo'
export const CURRENT_PROJECT_LABEL = 'dsh-memory-evolve'
export const OTHER_PROJECT_ID = 'proj-other'
export const OTHER_PROJECT_LABEL = '客户合同库'

/** AI 投放区（世界坐标）。AI 新节点只落在这里，用户再拖走。 */
export const AI_ZONE = { x: 80, y: 40, width: 560, height: 300 } as const

/** 各类型默认卡片尺寸（比参考项目略小，适配会话 Tab 而不是 Electron 全屏）。 */
export const DEFAULT_SIZE: Record<CanvasNodeType, { width: number; height: number }> = {
  folder: { width: 248, height: 168 },
  markdown: { width: 268, height: 208 },
  plainText: { width: 248, height: 176 },
  image: { width: 252, height: 196 },
  media: { width: 252, height: 176 },
  file: { width: 236, height: 156 },
}

/** 类型展示名。 */
export const TYPE_LABEL: Record<CanvasNodeType, string> = {
  folder: '文件夹',
  markdown: 'Markdown',
  plainText: '纯文本',
  image: '图片',
  media: '音视频',
  file: '文件',
}

/** LOD / 卡片标题栏用的类型符号。 */
export const TYPE_GLYPH: Record<CanvasNodeType, string> = {
  folder: '📁',
  markdown: '📝',
  plainText: '📄',
  image: '🖼',
  media: '🎬',
  file: '📦',
}

/** 扩展名 → 类型。没匹配上且不像目录就归 file。 */
export const EXT_TYPE: Record<string, CanvasNodeType> = {
  md: 'markdown',
  markdown: 'markdown',
  txt: 'plainText',
  text: 'plainText',
  log: 'plainText',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  ico: 'image',
  mp3: 'media',
  wav: 'media',
  m4a: 'media',
  aac: 'media',
  ogg: 'media',
  flac: 'media',
  mp4: 'media',
  mov: 'media',
  webm: 'media',
  avi: 'media',
  mkv: 'media',
}

/** 规格 §5 规定的模拟搜索清单。 */
export const CATALOG: CatalogItem[] = [
  { title: '合同-甲乙方.pdf', path: '~/Documents/合同-甲乙方.pdf', type: 'file', size: '2.4 MB', hint: 'PDF 合同扫描件' },
  { title: '首页设计稿-v3.png', path: '~/Downloads/首页设计稿-v3.png', type: 'image', size: '1.8 MB', hint: '设计稿 PNG' },
  { title: '产品需求说明.md', path: '~/Notes/产品需求说明.md', type: 'markdown', size: '28 KB', hint: '需求 Markdown' },
  { title: '会议录音-0813.mp3', path: '~/Recordings/会议录音-0813.mp3', type: 'media', size: '18 MB', hint: '会议录音' },
  { title: '演示视频-cut.mp4', path: '~/Movies/演示视频-cut.mp4', type: 'media', size: '42 MB', hint: '演示视频切片' },
  { title: '项目规范文档.docx', path: '~/Documents/项目规范文档.docx', type: 'file', size: '340 KB', hint: 'Word 规范' },
  { title: '客户logo.svg', path: '~/Design/客户logo.svg', type: 'image', size: '12 KB', hint: '矢量 logo' },
  { title: 'README.txt', path: '~/Projects/demo/README.txt', type: 'plainText', size: '4 KB', hint: '纯文本说明' },
]

/** 默认视口：让 AI 投放区 + 预置卡片大致落在 Tab 中央偏上。 */
export const DEFAULT_VIEWPORT: CanvasViewport = { x: 48, y: 36, scale: 0.88 }

export function defaultPlacement(
  type: CanvasNodeType,
  x: number,
  y: number,
  zIndex = 1,
): CanvasPlacement {
  const size = DEFAULT_SIZE[type]
  return { x, y, width: size.width, height: size.height, zIndex }
}

/** 首次打开（无 localStorage）时预置的 4 张示例卡，覆盖三层归属 + 一条「其他会话」。 */
export function createSeedNodes(now: number): CanvasNode[] {
  return [
    {
      id: 'canvas_seed_global',
      type: 'file',
      title: '团队共享规范.pdf',
      scope: 'global',
      scopeLabel: '全局',
      path: '~/Shared/团队共享规范.pdf',
      placement: defaultPlacement('file', 720, 80, 1),
      meta: { size: '860 KB', mtime: '2026-08-01' },
      createdAt: now - 86_400_000,
    },
    {
      id: 'canvas_seed_project',
      type: 'folder',
      title: '本仓库 docs-local',
      scope: 'project',
      scopeLabel: CURRENT_PROJECT_LABEL,
      projectId: CURRENT_PROJECT_ID,
      path: '/Users/edgar/.dsh/plugins/dsh-memory-evolve/docs-local',
      placement: defaultPlacement('folder', 720, 280, 2),
      meta: { size: '12 项', mtime: '2026-08-13' },
      createdAt: now - 3_600_000,
    },
    {
      id: 'canvas_seed_session',
      type: 'markdown',
      title: '本次会话备忘',
      scope: 'session',
      scopeLabel: CURRENT_SESSION_LABEL,
      sessionId: CURRENT_SESSION_ID,
      projectId: CURRENT_PROJECT_ID,
      content: '画板一期要验收：平移缩放、LOD、三种上板、视角筛选、搜索闪烁、复制引用、AI 投放。',
      placement: defaultPlacement('markdown', 720, 490, 3),
      createdAt: now - 600_000,
    },
    {
      id: 'canvas_seed_other_session',
      type: 'image',
      title: '上周评审白板',
      scope: 'session',
      scopeLabel: OTHER_SESSION_LABEL,
      sessionId: OTHER_SESSION_ID,
      projectId: CURRENT_PROJECT_ID,
      path: '~/Pictures/评审白板.png',
      placement: defaultPlacement('image', 1000, 280, 2),
      meta: { size: '2.1 MB', mtime: '2026-08-06' },
      createdAt: now - 6_000_000,
    },
  ]
}

export function createSeedState(): CanvasPersistState {
  const now = Date.now()
  return {
    version: 1,
    nodes: createSeedNodes(now),
    viewport: { ...DEFAULT_VIEWPORT },
    viewMode: 'session',
    lastAiNodeId: null,
  }
}
