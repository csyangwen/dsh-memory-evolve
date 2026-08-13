/**
 * 画板持久化：整板快照写入 localStorage。
 *
 * 一期没有后端，刷新不丢全靠这里。写入做了：
 * - 形状校验（坏数据回落到预置种子，避免白屏）
 * - 防抖（拖卡片时不要每帧 JSON.stringify）
 */
import { createSeedState, STORAGE_KEY } from './constants.ts'
import type { CanvasNode, CanvasPersistState } from './types.ts'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isNode(v: unknown): v is CanvasNode {
  if (!isRecord(v)) return false
  const p = v.placement
  if (!isRecord(p)) return false
  return (
    typeof v.id === 'string'
    && typeof v.type === 'string'
    && typeof v.title === 'string'
    && typeof v.scope === 'string'
    && typeof v.scopeLabel === 'string'
    && typeof v.createdAt === 'number'
    && typeof p.x === 'number'
    && typeof p.y === 'number'
    && typeof p.width === 'number'
    && typeof p.height === 'number'
    && typeof p.zIndex === 'number'
  )
}

function parseState(raw: string): CanvasPersistState | null {
  try {
    const data: unknown = JSON.parse(raw)
    if (!isRecord(data) || data.version !== 1) return null
    if (!Array.isArray(data.nodes) || !data.nodes.every(isNode)) return null
    const vp = data.viewport
    if (!isRecord(vp)) return null
    if (typeof vp.x !== 'number' || typeof vp.y !== 'number' || typeof vp.scale !== 'number') {
      return null
    }
    const viewMode = data.viewMode
    if (viewMode !== 'session' && viewMode !== 'project' && viewMode !== 'global') return null
    return {
      version: 1,
      nodes: data.nodes,
      viewport: { x: vp.x, y: vp.y, scale: vp.scale },
      viewMode,
      lastAiNodeId: typeof data.lastAiNodeId === 'string' ? data.lastAiNodeId : null,
    }
  } catch {
    return null
  }
}

/** 读取本地快照；没有或损坏则返回预置 4 张示例卡。 */
export function loadCanvasState(): CanvasPersistState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return createSeedState()
    return parseState(raw) ?? createSeedState()
  } catch {
    return createSeedState()
  }
}

export function saveCanvasState(state: CanvasPersistState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 配额满或隐私模式：静默失败，不打断拖拽
  }
}

/**
 * 防抖封装，组件卸载时要 cancel。
 *
 * schedule 支持两种载荷：
 *   - CanvasPersistState：localStorage 快照保存（纯前端降级模式）；
 *   - () => void 回调：后端模式（CanvasView 传 persistBackend 闭包，
 *     宿主 API 保存，带 rev 乐观锁）。
 */
export function createDebouncedSaver(ms: number): {
  schedule: (payload: CanvasPersistState | (() => void)) => void
  flush: (payload: CanvasPersistState | (() => void)) => void
  cancel: () => void
} {
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  const run = (payload: CanvasPersistState | (() => void)): void => {
    if (typeof payload === 'function') {
      payload()
    } else {
      saveCanvasState(payload)
    }
  }
  return {
    schedule(payload) {
      cancel()
      timer = setTimeout(() => {
        timer = null
        run(payload)
      }, ms)
    },
    flush(payload) {
      cancel()
      run(payload)
    },
    cancel,
  }
}
