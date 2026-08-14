/**
 * 画板后端客户端（canvas-grok → 宿主 API 对接层）。
 *
 * 职责：探测宿主 canvas API 是否可用（canvasEnabled 开关打开时注册），
 * 可用则整板读写/真实搜索/文件代理全走后端；不可用则回退 localStorage
 * 纯前端模式（前端一期验收期行为，数据不落盘到宿主）。
 *
 * 与后端契约（lib/canvas.js）：
 *   GET  /memory-evolve/api/canvas/state        → { enabled }
 *   GET  /memory-evolve/api/canvas?sessionId=   → { nodes, rev, viewport, viewMode }
 *   POST /memory-evolve/api/canvas              → { ok, rev }（body: nodes/rev/viewport/viewMode）
 *   GET  /memory-evolve/api/canvas/file?nodeId= → 文件字节（MIME 白名单）
 *   GET  /memory-evolve/api/canvas/search?q=&dir=&limit= → { items, provider }
 *
 * 乐观锁：整板保存带 rev，409 冲突时返回 { ok:false, conflict:true }，
 * 前端提示刷新（不静默覆盖——Grok 评审采纳）。
 */
import type { CanvasNode, CanvasPersistState } from './types.ts'

/** 宿主 API 前缀。 */
const API_BASE = '/memory-evolve/api/canvas'

/** 后端可用性缓存（每 Tab 生命周期探测一次）。 */
let availability: boolean | null = null

/**
 * 探测宿主 canvas API 是否可用（模块开关 canvasEnabled 开启时 200）。
 * 结果缓存：同一 Tab 生命周期内不重复探测。
 * @returns {Promise<boolean>}
 */
export async function detectBackend(): Promise<boolean> {
  if (availability !== null) return availability
  try {
    const res = await fetch(`${API_BASE}/state`, { method: 'GET' })
    availability = res.ok
  } catch {
    availability = false
  }
  return availability
}

/** 重置探测缓存（测试/重挂载用）。 */
export function resetBackendDetection(): void {
  availability = null
}

/**
 * 后端整板读取。返回 null = 后端不可用或空板（调用方决定回退种子）。
 * @param {string} sessionId - 当前会话 id（后端按需解析归属，前端只透传）
 * @returns {Promise<CanvasPersistState & { rev: number } | null>}
 */
export async function loadCanvasFromBackend(sessionId: string): Promise<(CanvasPersistState & { rev: number }) | null> {
  try {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    const res = await fetch(`${API_BASE}${query}`, { method: 'GET' })
    if (!res.ok) return null
    const data: unknown = await res.json()
    if (!data || typeof data !== 'object') return null
    const row = data as {
      nodes?: unknown
      rev?: unknown
      viewport?: unknown
      viewMode?: unknown
      lastAiNodeId?: unknown
      // 2026-08-14 新增：当前会话项目归属（后端按会话工作目录解析，
      // 前端视角筛选/新增节点归属用真实值——曾用模拟常量 'proj-demo'
      // 导致「本会话/本项目」视角筛选错乱）
      currentProjectId?: unknown
      currentProjectLabel?: unknown
    }
    if (!Array.isArray(row.nodes)) return null
    const vp = row.viewport as { x?: unknown; y?: unknown; scale?: unknown } | null
    return {
      version: 1,
      nodes: row.nodes as CanvasNode[],
      viewport: vp && typeof vp.x === 'number' && typeof vp.y === 'number' && typeof vp.scale === 'number'
        ? { x: vp.x, y: vp.y, scale: vp.scale }
        : { x: 520, y: 330, scale: 0.9 },
      viewMode: row.viewMode === 'project' || row.viewMode === 'global' ? row.viewMode : 'session',
      lastAiNodeId: typeof row.lastAiNodeId === 'string' ? row.lastAiNodeId : null,
      // 乐观锁 rev：必须取后端当前值，否则保存带旧 rev 会被 409 拒绝
      // （曾硬编码 0 导致一切保存被拒——"加上去有、刷新没"的根因）。
      rev: Number.isFinite(Number(row.rev)) ? Number(row.rev) : 0,
      currentProjectId: typeof row.currentProjectId === 'string' ? row.currentProjectId : undefined,
      currentProjectLabel: typeof row.currentProjectLabel === 'string' ? row.currentProjectLabel : undefined,
    }
  } catch {
    return null
  }
}

/** 后端整板保存结果。 */
export interface BackendSaveResult {
  ok: boolean
  conflict?: boolean
  rev?: number
  error?: string
}

/**
 * 后端整板保存（带 rev 乐观锁）。调用方需持有当前 rev（load 时返回）。
 * @param {CanvasPersistState} state
 * @param {number} rev - 期望的当前 rev（后端校验；不匹配 409）
 * @param {string} sessionId
 * @returns {Promise<BackendSaveResult>}
 */
export async function saveCanvasToBackend(
  state: CanvasPersistState,
  rev: number,
  sessionId: string,
): Promise<BackendSaveResult> {
  try {
    const res = await fetch(`${API_BASE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodes: state.nodes,
        rev,
        viewport: state.viewport,
        viewMode: state.viewMode,
        lastAiNodeId: state.lastAiNodeId,
        sessionId,
      }),
    })
    if (res.status === 409) {
      return { ok: false, conflict: true, error: '画板已被其他会话修改' }
    }
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null)
      const error = body && typeof body === 'object' && typeof (body as { error?: string }).error === 'string'
        ? (body as { error: string }).error
        : `HTTP ${res.status}`
      return { ok: false, error }
    }
    const body: unknown = await res.json()
    const revNext = body && typeof body === 'object' && typeof (body as { rev?: unknown }).rev === 'number'
      ? (body as { rev: number }).rev
      : rev + 1
    return { ok: true, rev: revNext }
  } catch {
    return { ok: false, error: '网络错误（宿主不可达）' }
  }
}

/**
 * 真实本地文件搜索（后端复用 search-docs provider / walk 兜底）。
 * 后端不可用时返回 null（前端用内置模拟清单）。
 * @param {string} query
 * @param {object} [opts] - { dir?, sessionId?, limit? }（dir 缺省时后端按
 *   sessionId 解析当前会话工作目录为搜索范围）
 * @returns {Promise<Array<{ title: string, path: string, type: string, size: string }> | null>}
 */
export async function searchFilesBackend(
  query: string,
  opts: { dir?: string; sessionId?: string; limit?: number } = {},
): Promise<Array<{ title: string; path: string; type: string; size: string }> | null> {
  try {
    const params = new URLSearchParams({ q: query })
    if (opts.dir) params.set('dir', opts.dir)
    if (opts.sessionId) params.set('sessionId', opts.sessionId)
    if (opts.limit) params.set('limit', String(opts.limit))
    const res = await fetch(`${API_BASE}/search?${params.toString()}`, { method: 'GET' })
    if (!res.ok) return null
    const data: unknown = await res.json()
    if (!data || typeof data !== 'object') return null
    const row = data as { items?: unknown }
    return Array.isArray(row.items) ? row.items as Array<{ title: string; path: string; type: string; size: string }> : null
  } catch {
    return null
  }
}

/**
 * 用系统注册的默认应用打开已上板节点路径（2026-08-14 用户要求：
 * 路径上板/搜索上板的本地文件一键打开。安全边界同 /file：
 * 只允许已上板节点）。
 * @param {string} nodeId
 * @returns {Promise<{ ok: boolean; error?: string }>}
 */
export async function openNodeFileBackend(nodeId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId }),
    })
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null)
      const error = body && typeof body === 'object' && typeof (body as { error?: string }).error === 'string'
        ? (body as { error: string }).error
        : `HTTP ${res.status}`
      return { ok: false, error }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: '网络错误（宿主不可达）' }
  }
}

/**
 * 文件代理预览 URL（只读已上板节点路径；MIME 白名单由后端校验）。
 * @param {string} nodeId
 * @returns {string}
 */
export function fileProxyUrl(nodeId: string): string {
  return `${API_BASE}/file?nodeId=${encodeURIComponent(nodeId)}`
}
