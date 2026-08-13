/**
 * dsh-memory-evolve — 无限画板（canvas）**独立子模块**（后端一期）。
 *
 * 用户拍板（2026-08-13）：本地路径引用、单板+视角筛选、AI 双向拉取式
 * 不注入快照、AI 只加/查/改内容不碰摆放、AI 产物默认便签（写会话板
 * 中央区）、写入免确认（只加会话便签）、安全从简（AI 只读已上板节点）。
 *
 * 职责：
 *   1. 独立开关 canvasEnabled（默认关，在「Memory Evolve 设置」Tab 的
 *      「配置」里切换，applyRuntimePatch sync 链即时安装/卸载）；
 *   2. 宿主端存储：<memoryDir>/canvas/boards.json —— **单板**模型，
 *      所有节点带 scope（session/project/global）+ sessionId/projectId
 *      归属键，前端按视角筛选；整板原子写 + rev 乐观锁（防多会话并发
 *      整文件覆盖丢便签——Grok 评审指出，已采纳）；
 *   3. HTTP API（/memory-evolve/api/canvas/*）：状态探测 / 整板读写 /
 *      已上板路径文件代理（预览/缩略图，仅允许读**已在画板上的节点**，
 *      不做任意路径读取）/ 真实本地搜索上板（复用 search-docs 的
 *      provider 实现，未启用搜索模块时走内置 walk 兜底）；
 *   4. de_canvas 工具：list / get / add_note —— AI 只能查画板、按稳定
 *      id 读内容、往**当前会话板中央区**放便签；不能改已有节点、不能
 *      写项目/全局、不能加路径节点、不碰摆放（视觉操作留人）。
 *
 * 零运行时依赖（只 import node 内置模块）。
 * @module dsh-memory-evolve/canvas
 */

import {
  createReadStream, existsSync, mkdirSync, readFileSync, realpathSync,
  renameSync, statSync, writeFileSync,
} from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { basename, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

// ---------------------------------------------------------------------------
// 常量与路径
// ---------------------------------------------------------------------------

/** 画板文件路径（<memoryDir>/canvas/boards.json）。 */
export function canvasPath(config) {
  return join(config.memoryDir, 'canvas', 'boards.json')
}

/** 画板数据目录（<memoryDir>/canvas/）。 */
export function canvasDir(config) {
  return join(config.memoryDir, 'canvas')
}

/** 单板节点上限（防无限膨胀；一期够用）。 */
export const CANVAS_NODES_MAX = 500

/** 便签单条内容上限（128 KiB，画板是轻量陈列，不承载大文档）。 */
export const CANVAS_NOTE_MAX_BYTES = 128 * 1024

/** AI 便签条数软上限（防 AI 一轮写爆；超出拒绝并提示）。 */
export const CANVAS_AI_NOTES_MAX = 50

/** 文件代理读取上限（预览用，超过只给元信息不给内容）。 */
export const CANVAS_FILE_PROXY_MAX_BYTES = 32 * 1024 * 1024

/** 文本预览上限（文本类内容截断用）。 */
export const CANVAS_TEXT_PREVIEW_MAX = 256 * 1024

/** AI 便签落点（会话板中央区固定坐标，与前端 AI_ZONE 对齐）。 */
export const CANVAS_AI_ZONE = Object.freeze({ x: 0, y: 0, width: 560, height: 220 })

/** 文件代理允许的 MIME 白名单（图片/音视频/文本/PDF；其他一律拒绝内容，只给元信息）。 */
export const CANVAS_MIME_ALLOW = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
})

/** 拒绝代理的敏感路径片段（安全从简但保留基础边界：私钥/凭据/配置不进浏览器）。 */
export const CANVAS_PATH_DENY = Object.freeze([
  '/.ssh/', '/.gnupg/', '/.aws/', '/.config/', '/.git/', '/node_modules/',
  '/Library/Keychains/', '/AppData/', '/.env', '/.pem', '/.key', '/.p12',
])

// ---------------------------------------------------------------------------
// 存储（单板 + rev 乐观锁）
// ---------------------------------------------------------------------------

/**
 * 生成节点 id（前缀 canvas_ + 随机）。
 * @returns {string}
 */
export function createCanvasId() {
  return `canvas_${randomBytes(6).toString('hex')}`
}

/**
 * 从路径推断节点类型（与前端 inferTypeFromPath 对齐；无法确认降级 file）。
 * @param {string} path
 * @returns {'folder'|'markdown'|'plainText'|'image'|'media'|'file'}
 */
export function inferNodeTypeFromPath(path) {
  const lower = String(path).trim().toLowerCase()
  if (lower.endsWith('/') || lower.endsWith('\\')) return 'folder'
  if (/\.md(?:own)?$/.test(lower)) return 'markdown'
  if (/\.(?:txt|log|csv|json|ya?ml)$/.test(lower)) return 'plainText'
  if (/\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/.test(lower)) return 'image'
  if (/\.(?:mp3|wav|m4a|aac|ogg|mp4|mov|mkv|webm)$/.test(lower)) return 'media'
  return 'file'
}

/**
 * 读取画板整板状态；文件不存在返回空板。任何损坏都回退空板
 * （不抛——前端有种子兜底，后端空板是合法初始态）。
 * @param {object} config - resolved plugin config。
 * @returns {{ version: number, nodes: any[], rev: number, viewport: object|null, viewMode: string }}
 */
export function readCanvas(config) {
  const file = canvasPath(config)
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw && typeof raw === 'object' && Array.isArray(raw.nodes)) {
      return {
        version: 1,
        nodes: raw.nodes,
        rev: Number.isFinite(Number(raw.rev)) ? Number(raw.rev) : 0,
        viewport: raw.viewport ?? null,
        viewMode: typeof raw.viewMode === 'string' ? raw.viewMode : 'session',
        lastAiNodeId: typeof raw.lastAiNodeId === 'string' ? raw.lastAiNodeId : null,
      }
    }
  } catch {
    // 文件缺失或损坏 → 空板
  }
  return { version: 1, nodes: [], rev: 0, viewport: null, viewMode: 'session', lastAiNodeId: null }
}

/**
 * 原子写整板（先写 tmp 再 rename）；返回新 rev。
 * @param {object} config
 * @param {{ nodes: any[], viewport?: object|null, viewMode?: string }} patch
 * @param {number} rev - 乐观锁：期望的当前 rev（不匹配则抛 ConflictError）。
 * @returns {number} 新 rev
 */
export function writeCanvas(config, patch, rev) {
  const current = readCanvas(config)
  if (current.rev !== rev) {
    const error = new Error(`画板已被其他会话修改（当前 rev=${current.rev}，期望 ${rev}），请刷新后重试`)
    error.code = 'CANVAS_CONFLICT'
    throw error
  }
  if (!Array.isArray(patch.nodes) || patch.nodes.length > CANVAS_NODES_MAX) {
    throw new Error(`节点数量超出上限（${CANVAS_NODES_MAX}）`)
  }
  // 整板保存的节点做形状归一：前端可能携带 meta 等附加字段（localStorage
  // 时代遗留），统一剥成后端契约字段，保证 boards.json 结构稳定
  // （与 normalizeNode 产出对齐；未知字段丢弃，缺省字段补默认）。
  const nodes = patch.nodes.map((n) => {
    if (!n || typeof n !== 'object') throw new Error('节点必须是对象')
    const TYPES = ['folder', 'markdown', 'plainText', 'image', 'media', 'file']
    const SCOPES = ['session', 'project', 'global']
    const p = n.placement ?? {}
    return {
      id: typeof n.id === 'string' && n.id.startsWith('canvas_') ? n.id : createCanvasId(),
      type: TYPES.includes(n.type) ? n.type : 'file',
      title: String(n.title ?? '').slice(0, 200) || '未命名素材',
      scope: SCOPES.includes(n.scope) ? n.scope : 'session',
      scopeLabel: String(n.scopeLabel ?? ''),
      sessionId: typeof n.sessionId === 'string' ? n.sessionId : undefined,
      projectId: typeof n.projectId === 'string' ? n.projectId : undefined,
      path: typeof n.path === 'string' && n.path !== '' ? n.path.slice(0, 1024) : undefined,
      content: typeof n.content === 'string' ? n.content.slice(0, CANVAS_NOTE_MAX_BYTES) : undefined,
      placement: {
        x: Number.isFinite(Number(p.x)) ? Number(p.x) : 0,
        y: Number.isFinite(Number(p.y)) ? Number(p.y) : 0,
        width: Number.isFinite(Number(p.width)) ? Number(p.width) : 320,
        height: Number.isFinite(Number(p.height)) ? Number(p.height) : 240,
        zIndex: Number.isFinite(Number(p.zIndex)) ? Number(p.zIndex) : 1,
      },
      aiPlaced: n.aiPlaced === true,
      unverified: Boolean(n.path) && !existsSync(n.path),
      createdAt: Number.isFinite(Number(n.createdAt)) ? Number(n.createdAt) : Date.now(),
    }
  })
  const next = {
    version: 1,
    nodes,
    rev: rev + 1,
    viewport: patch.viewport ?? current.viewport,
    viewMode: patch.viewMode ?? current.viewMode,
    lastAiNodeId: patch.lastAiNodeId === undefined ? current.lastAiNodeId : patch.lastAiNodeId,
  }
  const dir = canvasDir(config)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `boards.json.tmp.${process.pid}`)
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  renameSync(tmp, canvasPath(config))
  return next.rev
}

/**
 * 按 id 找节点。
 * @param {any[]} nodes
 * @param {string} id
 * @returns {any|undefined}
 */
export function findNode(nodes, id) {
  return nodes.find((n) => n && n.id === id)
}

/**
 * 校验节点字段（新建/更新共用）：返回规范化节点；非法抛错。
 * @param {object} input - { type, title, scope, sessionId, projectId, path?, content?, placement?, aiPlaced? }
 * @param {{ sessionId: string, projectId: string, projectLabel: string, sessionLabel: string }} owner - 当前会话归属上下文
 * @returns {object}
 */
export function normalizeNode(input, owner) {
  const TYPES = ['folder', 'markdown', 'plainText', 'image', 'media', 'file']
  const SCOPES = ['session', 'project', 'global']
  const type = TYPES.includes(input?.type) ? input.type : 'file'
  const scope = SCOPES.includes(input?.scope) ? input.scope : 'session'
  const title = String(input?.title ?? '').trim().slice(0, 200) || '未命名素材'
  // 归属键：global 无归属；project 挂 projectId；session 挂 sessionId+projectId。
  const sessionId = scope === 'session' ? String(input?.sessionId ?? owner.sessionId) : undefined
  const projectId = scope === 'project' || scope === 'session'
    ? String(input?.projectId ?? owner.projectId)
    : undefined
  const scopeLabel = scope === 'global' ? '全局'
    : scope === 'project' ? (input?.projectLabel ?? owner.projectLabel)
      : (input?.sessionLabel ?? owner.sessionLabel)
  const path = typeof input?.path === 'string' && input.path.trim() !== '' ? input.path.trim().slice(0, 1024) : undefined
  const content = typeof input?.content === 'string'
    ? input.content.slice(0, CANVAS_NOTE_MAX_BYTES)
    : undefined
  const placement = input?.placement && typeof input.placement === 'object'
    ? {
        x: Number.isFinite(Number(input.placement.x)) ? Number(input.placement.x) : 0,
        y: Number.isFinite(Number(input.placement.y)) ? Number(input.placement.y) : 0,
        width: Number.isFinite(Number(input.placement.width)) ? Number(input.placement.width) : 320,
        height: Number.isFinite(Number(input.placement.height)) ? Number(input.placement.height) : 240,
        zIndex: Number.isFinite(Number(input.placement.zIndex)) ? Number(input.placement.zIndex) : 1,
      }
    : { x: 0, y: 0, width: 320, height: 240, zIndex: 1 }
  return {
    id: createCanvasId(),
    type,
    title,
    scope,
    scopeLabel,
    sessionId,
    projectId,
    path,
    content,
    placement,
    aiPlaced: input?.aiPlaced === true,
    unverified: Boolean(path) && !existsSync(path),
    createdAt: Date.now(),
  }
}

/**
 * 计算 AI 便签落点（会话板中央区：AI_ZONE 内按已有 AI 便签数错位摆放，
 * 与前端 aiSlot 对齐；不参与自由摆放区）。
 * @param {any[]} nodes - 当前全部节点（含 AI 便签）
 * @returns {{ x: number, y: number, width: number, height: number, zIndex: number }}
 */
export function aiSlotPlacement(nodes) {
  const aiCount = nodes.filter((n) => n && n.aiPlaced).length
  const col = aiCount % 2
  const row = Math.floor(aiCount / 2) % 2
  return {
    x: CANVAS_AI_ZONE.x + 20 + col * 300,
    y: CANVAS_AI_ZONE.y + 36 + row * 160,
    // 默认宽高放大（曾 260×100 内容挤成一团看不清，用户反馈 2026-08-13）；
    // 用户仍可用卡片右下角手柄继续调整。
    width: 420,
    height: 260,
    zIndex: 1,
  }
}

// ---------------------------------------------------------------------------
// 文件代理（只读已上板节点路径；安全从简但保留基础边界）
// ---------------------------------------------------------------------------

/**
 * 解析已上板节点的真实路径；做 realpath + 敏感路径拒绝 + 存在性校验。
 * @param {object} config
 * @param {string} nodeId
 * @returns {{ path: string, size: number, mtime: number, ext: string, denied: boolean } | { error: string }}
 */
export function resolveNodeFile(config, nodeId) {
  const board = readCanvas(config)
  const node = findNode(board.nodes, nodeId)
  if (!node || typeof node.path !== 'string' || node.path === '') {
    return { error: '节点不存在或没有路径引用' }
  }
  // 敏感路径检查**先于** realpath：即使文件已不存在，敏感目录路径也要
  // 报「已拒绝」而非误导性的「不存在」（防止用户把 .ssh 等显式上板后
  // 因文件不存在而误以为可以代理）。
  for (const denied of CANVAS_PATH_DENY) {
    if (node.path.includes(denied)) return { error: `路径含敏感目录片段（${denied}），已拒绝代理` }
  }
  // 只允许读**已上板节点**的路径——这是本模块的核心安全边界：
  // 没有"按任意路径读取"的 API（Grok 评审 §4.1 建议 2，用户拍板安全从简）。
  try {
    const real = realpathSync(node.path)
    const stat = statSync(real)
    if (!stat.isFile()) return { error: '不是常规文件' }
    return {
      path: real,
      size: stat.size,
      mtime: stat.mtimeMs,
      ext: extname(real).toLowerCase(),
      denied: false,
    }
  } catch (error) {
    return { error: `文件不可访问：${error.code === 'ENOENT' ? '路径不存在（源文件可能已被移动/删除）' : error.message}` }
  }
}

// ---------------------------------------------------------------------------
// 真实本地搜索（复用 search-docs 的 provider 能力）
// ---------------------------------------------------------------------------

/**
 * 真实本地文件搜索（上板入口之一）。优先复用 search-docs 的 provider
 * 注册表（mdfind/es/rg/walk）；模块未启用时用内置 walk 兜底（限目录、
 * 限数量，避免全盘慢扫）。
 * @param {object} config - resolved plugin config
 * @param {string} query - 文件名关键字
 * @param {object} [opts] - { dir?: string, limit?: number }
 * @returns {Promise<{ items: Array<{ title: string, path: string, type: string, size: string }>, provider: string }>}
 */
export async function searchLocalFiles(config, query, opts = {}) {
  const keyword = String(query ?? '').trim()
  const limit = Math.min(Number(opts.limit) || 20, 50)
  if (keyword === '') return { items: [], provider: 'none' }

  // 优先复用 search-docs 的 provider 注册表（lib/search-docs.js 导出）。
  try {
    const { getSearchProviders } = await import('./search-docs.js')
    const providers = getSearchProviders()
    // search-docs 的 provider.search(params, ctx) 需要 config 里的
    // searchDocsExts 等；这里只做文件名搜索（不传 exts = 默认 md 文档），
    // 画板上板要的是任意文件 → 显式 allTypes。
    const providerNames = Array.from(providers.keys())
    for (const name of providerNames) {
      try {
        const provider = providers.get(name)
        const result = await provider.search(
          { query: keyword, allTypes: true, exts: ['*'], dir: opts.dir ?? null, limit },
          { config },
        )
        if (result && Array.isArray(result.items) && result.items.length > 0) {
          return {
            provider: name,
            items: result.items.slice(0, limit).map((item) => ({
              title: item.name ?? basename(item.path ?? ''),
              path: item.path ?? '',
              type: item.path ? inferNodeTypeFromPath(item.path) : 'file',
              size: formatBytes(item.size ?? 0),
            })),
          }
        }
      } catch {
        // provider 失败（如 es 未安装/权限）→ 换下一个
      }
    }
  } catch {
    // search-docs 不可用 → 走内置 walk
  }

  // 内置 walk 兜底：仅当前工作目录（不全盘扫描，防慢）。
  const dir = opts.dir ?? null
  const items = await walkFiles(dir, keyword, limit)
  return { provider: 'walk', items }
}

/** 简单文件大小格式化。 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 内置 walk 搜索（仅文件名匹配；目录深度 4 层、数量上限，防慢）。
 * @param {string|null} dir - 起始目录（null = 用户主目录一层，避免全盘）
 * @param {string} keyword - 文件名关键字（大小写不敏感子串）
 * @param {number} limit
 * @returns {Promise<Array<{ title: string, path: string, type: string, size: number }>>}
 */
async function walkFiles(dir, keyword, limit) {
  const { readdir } = await import('node:fs/promises')
  const start = dir && existsSync(dir) ? dir : homedir()
  const results = []
  const kw = keyword.toLowerCase()
  const stack = [{ path: start, depth: 0 }]
  let scanned = 0
  while (stack.length > 0 && results.length < limit && scanned < 5000) {
    const { path, depth } = stack.pop()
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      continue // 权限/不存在：跳过
    }
    for (const entry of entries) {
      scanned += 1
      const full = join(path, entry.name)
      if (entry.isDirectory()) {
        if (depth < 4) stack.push({ path: full, depth: depth + 1 })
        continue
      }
      if (entry.name.toLowerCase().includes(kw)) {
        try {
          const stat = statSync(full)
          results.push({ title: entry.name, path: full, type: inferNodeTypeFromPath(full), size: stat.size })
        } catch {
          // 无法 stat 的跳过
        }
        if (results.length >= limit) break
      }
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// de_canvas 工具（AI 双向拉取式：list / get / add_note）
// ---------------------------------------------------------------------------

/**
 * 构建 de_canvas 工具定义。AI 能力边界（用户拍板）：
 *   - list：查画板（按视角返回 id/标题/类型/归属）
 *   - get：按稳定 id 读节点（文本内容；路径节点只给路径与元信息，
 *     内容经文件代理文本预览返回，图片给"可预览"提示）
 *   - add_note：往**当前会话板**新增便签（落中央区，aiPlaced 标记）；
 *     不能改已有节点、不能写项目/全局、不能加路径节点、不碰摆放。
 * @param {object} config - resolved plugin config
 * @param {(sessionId: string) => string | null} resolveCwd - 会话 → 工作目录
 * @returns {object} ToolDefinition-shaped object
 */
export function canvasToolDefinition(config, resolveCwd) {
  return {
    name: 'de_canvas',
    description: '无限画板（素材集中台）：AI 与用户共享的画板工作台。list=查画板节点清单（按视角）；get=按节点 id 读内容；add_note=往当前会话画板放一张便签（落在画板中央固定区，用户可自行拖动）。画板内容不注入上下文，需要时主动查询。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'get', 'add_note'],
        description: '操作：list=列节点；get=读节点内容；add_note=放便签',
      },
      view: {
        type: 'string',
        enum: ['session', 'project', 'global'],
        description: 'list 用：视角（session=当前会话+当前项目+全局；project=该项目全部会话+全局；global=全部）',
      },
      id: {
        type: 'string',
        description: 'get 用：节点 id（list 返回的 id，形如 canvas_xxxx）',
      },
      title: {
        type: 'string',
        description: 'add_note 用：便签标题',
      },
      content: {
        type: 'string',
        description: 'add_note 用：便签正文（Markdown/纯文本）',
      },
    },
    // output schema 与 execute 返回严格一致（插件纪律：JSON Schema 硬约束、
    // 工具 output schema 一致——plugin.test.js 会校验每个注册工具的
    // output.schema 存在且合法；缺定义会导致 schema 校验测试失败）。
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: '操作是否成功' },
          error: { type: 'string', description: '失败原因（ok=false 时）' },
          // list 返回
          view: { type: 'string', description: 'list：实际使用的视角' },
          total: { type: 'integer', description: 'list：当前视角下节点总数' },
          nodes: {
            type: 'array',
            description: 'list：节点清单（id/标题/类型/归属）',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                type: { type: 'string' },
                scope: { type: 'string' },
                scopeLabel: { type: 'string' },
                aiPlaced: { type: 'boolean' },
              },
            },
          },
          hint: { type: 'string', description: 'list：使用提示（用 id 引用勿用标题）' },
          // get 返回
          id: { type: 'string', description: 'get/add_note：节点 id' },
          title: { type: 'string', description: 'get/add_note：节点标题' },
          type: { type: 'string', description: 'get：节点类型' },
          content: { type: 'string', description: 'get：文本内容（文本类节点）' },
          path: { type: 'string', description: 'get：路径节点的本地路径' },
          size: { type: 'string', description: 'get：路径节点大小（格式化）' },
          note: { type: 'string', description: 'get/add_note：补充说明' },
          // add_note 返回
          scope: { type: 'string', description: 'add_note：归属层级（session）' },
          placement: {
            type: 'object',
            description: 'add_note：落点坐标（画板中央区）',
            additionalProperties: false,
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              zIndex: { type: 'number' },
            },
          },
        },
      },
    },
    async execute(args, exec) {
      const action = String(args?.action ?? '')
      const agent = exec?.agent
      const sessionId = String(agent?.session?.id ?? '')
      const cwd = resolveCwd?.(sessionId) ?? agent?.session?.header?.cwd ?? null
      const projectId = cwd ?? 'project:local'
      const projectLabel = cwd ? basename(cwd) : '当前项目'
      const board = readCanvas(config)

      if (action === 'list') {
        const view = ['project', 'global'].includes(args?.view) ? args.view : 'session'
        const nodes = board.nodes
          .filter((n) => n && n.scope === 'global'
            || (view === 'global')
            || (view === 'project' && n.scope !== 'session')
            || (n.scope === 'session' && n.sessionId === sessionId)
            || (n.scope === 'project' && n.projectId === projectId))
          .map((n) => ({
            id: n.id,
            title: n.title,
            type: n.type,
            scope: n.scope,
            scopeLabel: n.scopeLabel,
            aiPlaced: n.aiPlaced === true,
          }))
        return {
          ok: true,
          view,
          total: nodes.length,
          nodes,
          hint: '用 get 按 id 读取节点内容；标题可能重复，务必用 id 引用',
        }
      }

      if (action === 'get') {
        const id = String(args?.id ?? '').trim()
        if (id === '') return { ok: false, error: '缺少 id（用 list 查询节点 id）' }
        const node = findNode(board.nodes, id)
        if (!node) return { ok: false, error: `画板上没有节点 ${id}（可能已被移除）` }
        // 文本类：直接给正文；路径节点：给路径/元信息 + 文本预览（可读时）
        if (typeof node.content === 'string' && node.content !== '') {
          return { ok: true, id: node.id, title: node.title, type: node.type, content: node.content.slice(0, CANVAS_TEXT_PREVIEW_MAX) }
        }
        if (typeof node.path === 'string' && node.path !== '') {
          const file = resolveNodeFile(config, node.id)
          if (file.error) return { ok: true, id: node.id, title: node.title, type: node.type, path: node.path, note: file.error }
          const ext = file.ext
          if (['.md', '.txt', '.log', '.json', '.csv', '.yaml', '.yml'].includes(ext) && file.size <= CANVAS_TEXT_PREVIEW_MAX) {
            try {
              const text = readFileSync(file.path, 'utf8')
              return { ok: true, id: node.id, title: node.title, type: node.type, path: file.path, content: text }
            } catch {
              // 读失败（编码等）→ 降级返回元信息
            }
          }
          return {
            ok: true, id: node.id, title: node.title, type: node.type, path: file.path,
            size: formatBytes(file.size),
            note: ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.webp'
              ? '图片节点：内容需在画板 GUI 中查看（模型侧无图像通道）'
              : '非文本文件：模型侧不读取内容，可在画板 GUI 预览',
          }
        }
        return { ok: true, id: node.id, title: node.title, type: node.type, note: '便签内容为空' }
      }

      if (action === 'add_note') {
        // AI 只能往当前会话板加便签（用户拍板收窄；免确认仅对此成立）。
        const title = String(args?.title ?? '').trim().slice(0, 100) || 'AI 便签'
        const content = String(args?.content ?? '').trim().slice(0, CANVAS_NOTE_MAX_BYTES)
        if (content === '') return { ok: false, error: '便签内容不能为空' }
        const aiCount = board.nodes.filter((n) => n && n.aiPlaced).length
        if (aiCount >= CANVAS_AI_NOTES_MAX) {
          return { ok: false, error: `AI 便签已达上限（${CANVAS_AI_NOTES_MAX} 张），请用户整理画板后再放` }
        }
        const node = normalizeNode(
          { type: 'markdown', title, scope: 'session', content, aiPlaced: true },
          { sessionId, projectId, projectLabel, sessionLabel: '当前会话' },
        )
        node.placement = aiSlotPlacement(board.nodes)
        const nodes = [...board.nodes, node]
        let rev
        try {
          rev = writeCanvas(config, { nodes }, board.rev)
        } catch (error) {
          return { ok: false, error: error.message }
        }
        return {
          ok: true,
          id: node.id,
          title: node.title,
          scope: 'session',
          placement: node.placement,
          note: `已放入当前会话画板中央区（rev=${rev}）；用户可在画板中拖动调整位置`,
        }
      }

      return { ok: false, error: `未知操作：${action}` }
    },
  }
}

/**
 * 安装 canvas 子模块：HTTP API + de_canvas 工具注册。
 * @param {object} ctx - cordis ctx（tools/agents 已由主插件声明式注入）。
 * @param {object} config - resolved plugin config。
 * @param {(sessionId: string) => string | null} resolveCwd - 会话 → 工作目录。
 * @returns {{ dispose: () => void, store: { read: () => object } }}
 */
export function installCanvas(ctx, config, resolveCwd) {
  const base = '/memory-evolve/api/canvas'
  const disposers = []

  // 工具注册（tools 服务存在时）。
  ctx.inject(['tools'], (toolCtx) => {
    const cancel = toolCtx.tools.register(canvasToolDefinition(config, resolveCwd))
    disposers.push(cancel)
  })

  // HTTP API（web-only；TUI 上自动待机无副作用）。
  ctx.inject(['webServer'], (webCtx) => {
    const cancel = webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: base,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname
        try {
          // 状态探测：客户端决定是否挂画板 Tab。
          if (req.method === 'GET' && path === `${base}/state`) {
            sendJson(res, 200, { enabled: true })
            return
          }

          // 整板读取：GET ?sessionId=
          if (req.method === 'GET' && path === base) {
            const board = readCanvas(config)
            // 前端只消费节点与视图状态；内部字段不外发。
            sendJson(res, 200, {
              nodes: board.nodes.map((n) => ({
                id: n.id, type: n.type, title: n.title, scope: n.scope,
                scopeLabel: n.scopeLabel, sessionId: n.sessionId, projectId: n.projectId,
                path: n.path, content: n.content, placement: n.placement,
                aiPlaced: n.aiPlaced === true, unverified: n.unverified === true,
                createdAt: n.createdAt,
              })),
              rev: board.rev,
              viewport: board.viewport,
              viewMode: board.viewMode,
              lastAiNodeId: board.lastAiNodeId,
            })
            return
          }

          // 整板写入：POST body { nodes, rev, viewport?, viewMode?, lastAiNodeId? }（前端防抖批量保存）
          if (req.method === 'POST' && path === base) {
            const body = await readBody(req)
            const rev = Number.isFinite(Number(body?.rev)) ? Number(body.rev) : 0
            if (!Array.isArray(body?.nodes)) throw new Error('nodes 必须是数组')
            let nextRev
            try {
              nextRev = writeCanvas(config, {
                nodes: body.nodes,
                viewport: body.viewport ?? null,
                viewMode: body.viewMode,
                lastAiNodeId: typeof body.lastAiNodeId === 'string' ? body.lastAiNodeId : undefined,
              }, rev)
            } catch (error) {
              if (error.code === 'CANVAS_CONFLICT') {
                sendJson(res, 409, { ok: false, error: error.message })
                return
              }
              throw error
            }
            sendJson(res, 200, { ok: true, rev: nextRev })
            return
          }

          // 文件代理：GET /file?nodeId=（只读已上板节点路径；MIME 白名单）
          if (req.method === 'GET' && path === `${base}/file`) {
            const nodeId = url.searchParams.get('nodeId') ?? ''
            const file = resolveNodeFile(config, nodeId)
            if (file.error) { sendJson(res, 404, { error: file.error }); return }
            const mime = CANVAS_MIME_ALLOW[file.ext]
            if (!mime) {
              sendJson(res, 415, { error: `不支持预览的文件类型（${file.ext || '未知'}），请在画板中使用「打开」` })
              return
            }
            if (file.size > CANVAS_FILE_PROXY_MAX_BYTES) {
              sendJson(res, 413, { error: `文件过大（${formatBytes(file.size)}），超过预览上限` })
              return
            }
            // 流式响应（视频 Range 支持由 DSH 侧 HTTP 层处理；此处直接读流）。
            res.writeHead(200, {
              'content-type': mime,
              'content-length': file.size,
              'cache-control': 'private, max-age=60',
              'x-canvas-node': nodeId,
            })
            const stream = createReadStream(file.path)
            stream.on('error', () => { res.destroy() })
            stream.pipe(res)
            return
          }

          // 真实本地搜索：GET /search?q=&dir=&sessionId=&limit=（复用
          // search-docs provider / walk 兜底）
          if (req.method === 'GET' && path === `${base}/search`) {
            const q = url.searchParams.get('q') ?? ''
            let dir = url.searchParams.get('dir') ?? null
            // 缺省搜索范围：优先当前会话工作目录（用户当前项目）——
            // walk 兜底从主目录开始扫不到 /tmp 等临时目录，且项目文件
            // 才是上板主力来源（用户反馈 2026-08-13 搜索不到文件）。
            if (dir === null || dir === '') {
              const sessionId = url.searchParams.get('sessionId') ?? ''
              dir = resolveCwd?.(sessionId) ?? null
            }
            const result = await searchLocalFiles(config, q, { dir, limit: Number(url.searchParams.get('limit')) || 20 })
            sendJson(res, 200, result)
            return
          }

          sendJson(res, 404, { error: 'not found' })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const status = /必须|不能|上限|缺少|无效|不存在|超出|invalid|too large/i.test(message) ? 400 : 500
          sendJson(res, status, { error: message })
        }
      },
    }), 'dsh-memory-evolve: canvas route')
    disposers.push(cancel)
  })

  return {
    store: { read: () => readCanvas(config) },
    dispose() {
      for (const cancel of disposers.splice(0)) cancel?.()
    },
  }
}

/** 发送 JSON 响应。 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/** 读取 JSON 请求体（上限 256KiB，画板整板保存够用）。 */
async function readBody(req, maxBytes = 256 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid JSON body')
  }
}
