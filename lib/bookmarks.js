/**
 * dsh-memory-evolve — 会话书签（第一阶段：标记 + 列表 + 跳转）。
 *
 * **独立子模块**（用户拍板纪律：独立领域不挂别的模块下）。职责：
 *   1. 独立开关 bookmarkEnabled（默认关，在「Memory Evolve 设置」Tab 的
 *      「配置」里切换，applyRuntimePatch sync 链即时安装/卸载）；
 *   2. 宿主端 sidecar 存储：<memoryDir>/session-bookmarks.json，按
 *      sessionId 隔离、按轮次 seq 定位（第二阶段 fork 复用 seq 字段）；
 *   3. HTTP API：列表 / 创建 / 改名 / 删除 + 状态探测端点（关闭时 404，
 *      客户端探测失败即隐藏全部注入）。
 *
 * 本阶段**不做**分支（第二阶段才做「从此处新建官方分支」）；数据预留
 * seq（官方 session.fork 边界）与 turn 号、摘要等展示字段。
 *
 * 零运行时依赖（只 import node 内置模块）。
 *
 * @module dsh-memory-evolve/bookmarks
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

/** 书签标签名最大字符数（过长会撑爆列表行，前端也做同等截断）。 */
export const BOOKMARK_LABEL_MAX = 80

/** 内容摘要最大字符数（该轮首条用户消息预览）。 */
export const BOOKMARK_SUMMARY_MAX = 200

/** 单会话书签数量上限（防止 sidecar 无限膨胀）。 */
export const BOOKMARKS_PER_SESSION_MAX = 500

/**
 * 书签 sidecar 文件路径（<memoryDir>/session-bookmarks.json）。
 * @param {object} config - resolved plugin config（需含 memoryDir）。
 * @returns {string}
 */
export function bookmarksPath(config) {
  return join(config.memoryDir, 'session-bookmarks.json')
}

/**
 * 生成书签 id（短随机串，前缀 bm_ 便于识别）。
 * @returns {string}
 */
function newBookmarkId() {
  return `bm_${randomBytes(6).toString('hex')}`
}

/**
 * 归一化标签：trim + 截断；空串返回 null（调用方决定默认名）。
 * @param {unknown} label
 * @returns {string | null}
 */
function normalizeLabel(label) {
  if (typeof label !== 'string') return null
  const trimmed = label.trim()
  if (trimmed === '') return null
  return trimmed.length > BOOKMARK_LABEL_MAX
    ? trimmed.slice(0, BOOKMARK_LABEL_MAX)
    : trimmed
}

/**
 * 归一化摘要：非字符串 → ''；截断到上限。
 * @param {unknown} summary
 * @returns {string}
 */
function normalizeSummary(summary) {
  if (typeof summary !== 'string') return ''
  const trimmed = summary.replace(/\s+/g, ' ').trim()
  return trimmed.length > BOOKMARK_SUMMARY_MAX
    ? `${trimmed.slice(0, BOOKMARK_SUMMARY_MAX - 1)}…`
    : trimmed
}

/**
 * 校验 seq：必须是有限正整数（DSH 事件 seq 从 1 起；0/负数/浮点非法）。
 * @param {unknown} seq
 * @returns {number}
 */
function assertSeq(seq) {
  if (typeof seq !== 'number' || !Number.isFinite(seq) || !Number.isInteger(seq) || seq < 1) {
    throw new Error('seq 必须是正整数（已完成轮的 closing assistant seq）')
  }
  return seq
}

/**
 * 校验 sessionId：非空字符串。
 * @param {unknown} sessionId
 * @returns {string}
 */
function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new Error('sessionId 必须是非空字符串')
  }
  return sessionId.trim()
}

/**
 * 磁盘上的文件形状（版本号便于日后迁移）。
 * @typedef {{ version: number, sessions: Record<string, BookmarkRecord[]> }} BookmarkFile
 */

/**
 * 单条书签记录。
 * @typedef {{
 *   id: string,
 *   sessionId: string,
 *   seq: number,
 *   label: string,
 *   summary: string,
 *   turn: number | null,
 *   createdAt: string,
 *   updatedAt: string,
 * }} BookmarkRecord
 */

/**
 * 会话书签存储（sidecar JSON + 原子写）。
 *
 * 文件结构：
 * ```json
 * {
 *   "version": 1,
 *   "sessions": {
 *     "<sessionId>": [
 *       { "id", "sessionId", "seq", "label", "summary", "turn", "createdAt", "updatedAt" }
 *     ]
 *   }
 * }
 * ```
 *
 * - 按 sessionId 隔离；列表按 createdAt 倒序（最新在上）。
 * - 同 session + 同 seq 只允许一条（再打星 = 更新标签/摘要，不重复建）。
 * - seq 预留给第二阶段官方 fork（session.fork atSeq）。
 */
export class BookmarkStore {
  /**
   * @param {string} filePath - sidecar 绝对路径。
   */
  constructor(filePath) {
    this.filePath = filePath
    /** @type {BookmarkFile | null} 内存缓存（写后刷新；读时懒加载）。 */
    this._cache = null
  }

  /**
   * 读取完整文件；不存在时返回空骨架（不预创建文件）。
   * @returns {BookmarkFile}
   */
  load() {
    if (this._cache !== null) return this._cache
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this._cache = { version: 1, sessions: {} }
        return this._cache
      }
      const sessions = parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
        ? parsed.sessions
        : {}
      // 防御：保证每个 session 的值是数组。
      const clean = {}
      for (const [sid, list] of Object.entries(sessions)) {
        if (Array.isArray(list)) clean[sid] = list
      }
      this._cache = { version: 1, sessions: clean }
      return this._cache
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this._cache = { version: 1, sessions: {} }
        return this._cache
      }
      throw error
    }
  }

  /**
   * 原子写回磁盘（先写临时文件再 rename；同 pid 清理残留 tmp）。
   * @param {BookmarkFile} data
   */
  save(data) {
    const path = this.filePath
    mkdirSync(dirname(path), { recursive: true })
    const tmpPath = `${path}.tmp.${process.pid}`
    try { unlinkSync(tmpPath) } catch { /* 无残留，忽略 */ }
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmpPath, path)
    this._cache = data
  }

  /**
   * 列出某会话的全部书签（按 createdAt 倒序）。
   * @param {string} sessionId
   * @returns {BookmarkRecord[]}
   */
  list(sessionId) {
    const sid = assertSessionId(sessionId)
    const data = this.load()
    const list = data.sessions[sid] ?? []
    // 不改原数组：拷贝后按时间倒序。
    return [...list].sort((a, b) => {
      const ta = Date.parse(a.createdAt) || 0
      const tb = Date.parse(b.createdAt) || 0
      return tb - ta
    })
  }

  /**
   * 按 id 查找（跨会话；找不到返回 null）。
   * @param {string} sessionId
   * @param {string} id
   * @returns {BookmarkRecord | null}
   */
  get(sessionId, id) {
    const sid = assertSessionId(sessionId)
    if (typeof id !== 'string' || id === '') return null
    const list = this.load().sessions[sid] ?? []
    return list.find((b) => b.id === id) ?? null
  }

  /**
   * 按 seq 查找（同会话同轮只允许一条）。
   * @param {string} sessionId
   * @param {number} seq
   * @returns {BookmarkRecord | null}
   */
  findBySeq(sessionId, seq) {
    const sid = assertSessionId(sessionId)
    const s = assertSeq(seq)
    const list = this.load().sessions[sid] ?? []
    return list.find((b) => b.seq === s) ?? null
  }

  /**
   * 创建或更新书签（同 session+seq 已存在时更新 label/summary，返回 existing=true）。
   *
   * @param {object} input
   * @param {string} input.sessionId
   * @param {number} input.seq - 该轮 closing assistant 的 seq（跳转锚点 + 第二阶段 fork 边界）。
   * @param {string} [input.label] - 标签名；缺省 / 空 → 「轮次 N」（N=turn 或 seq）。
   * @param {string} [input.summary] - 该轮首条消息预览。
   * @param {number | null} [input.turn] - 轮次号（展示用；可空）。
   * @returns {{ bookmark: BookmarkRecord, created: boolean }}
   */
  upsert(input) {
    const sessionId = assertSessionId(input.sessionId)
    const seq = assertSeq(input.seq)
    const turn = (typeof input.turn === 'number' && Number.isFinite(input.turn) && input.turn >= 1)
      ? Math.floor(input.turn)
      : null
    const summary = normalizeSummary(input.summary)
    // 默认名：优先「轮次 N」，无 turn 时退回「轮次 seq」。
    const defaultLabel = `轮次 ${turn ?? seq}`
    const label = normalizeLabel(input.label) ?? defaultLabel

    const data = this.load()
    const list = data.sessions[sessionId] ? [...data.sessions[sessionId]] : []
    const existing = list.find((b) => b.seq === seq)
    const now = new Date().toISOString()

    if (existing) {
      // 已打星：更新标签/摘要/轮次，不新建（避免重复）。
      existing.label = label
      existing.summary = summary !== '' ? summary : existing.summary
      if (turn !== null) existing.turn = turn
      existing.updatedAt = now
      data.sessions[sessionId] = list
      this.save(data)
      return { bookmark: existing, created: false }
    }

    if (list.length >= BOOKMARKS_PER_SESSION_MAX) {
      throw new Error(`该会话书签已达上限（${BOOKMARKS_PER_SESSION_MAX} 条）`)
    }

    /** @type {BookmarkRecord} */
    const bookmark = {
      id: newBookmarkId(),
      sessionId,
      seq,
      label,
      summary,
      turn,
      createdAt: now,
      updatedAt: now,
    }
    list.push(bookmark)
    data.sessions[sessionId] = list
    this.save(data)
    return { bookmark, created: true }
  }

  /**
   * 改名。
   * @param {string} sessionId
   * @param {string} id
   * @param {string} label
   * @returns {BookmarkRecord}
   */
  rename(sessionId, id, label) {
    const sid = assertSessionId(sessionId)
    if (typeof id !== 'string' || id === '') throw new Error('id 必须是非空字符串')
    const nextLabel = normalizeLabel(label)
    if (nextLabel === null) throw new Error('label 不能为空')

    const data = this.load()
    const list = data.sessions[sid] ?? []
    const found = list.find((b) => b.id === id)
    if (!found) throw new Error(`书签不存在：${id}`)
    found.label = nextLabel
    found.updatedAt = new Date().toISOString()
    data.sessions[sid] = list
    this.save(data)
    return found
  }

  /**
   * 删除。
   * @param {string} sessionId
   * @param {string} id
   * @returns {{ ok: true, removed: BookmarkRecord } | { ok: false, error: string }}
   */
  remove(sessionId, id) {
    const sid = assertSessionId(sessionId)
    if (typeof id !== 'string' || id === '') {
      return { ok: false, error: 'id 必须是非空字符串' }
    }
    const data = this.load()
    const list = data.sessions[sid] ?? []
    const index = list.findIndex((b) => b.id === id)
    if (index < 0) return { ok: false, error: `书签不存在：${id}` }
    const [removed] = list.splice(index, 1)
    if (list.length === 0) {
      // 空会话数组直接删掉，避免 sessions 字典堆空键。
      delete data.sessions[sid]
    } else {
      data.sessions[sid] = list
    }
    this.save(data)
    return { ok: true, removed }
  }
}

/**
 * 计算 fork 的 seed 边界（复刻官方 api-proxy.ts fork RPC 的算法）：
 * - 传入 atSeq（消息事件 seq）→ 取 **>= atSeq 的第一个 turn/end** 作为边界
 *   （锚定到该轮轮尾，不会把中间轮切一半）；省略或超尾 → 最后一个已完成轮；
 * - 边界后顺延吸收尾部 out-of-band 事件（session/title、注入等）直到下一个
 *   turn/start——seed 保持"完成轮"平衡，子会话继承标题。
 *
 * @param {readonly Array<{ type: string, seq: number }>} events - 源会话事件日志
 *   （agent.session.events，core Session 公开只读属性）。
 * @param {number | undefined} atSeq - 目标轮内任意消息 seq（可选）。
 * @returns {{ seed: Array<object>, cut: number } | null} seed 与截断长度；
 *   null = 无已完成轮 / 目标轮未完成（无法分支）。
 */
export function buildForkSeed(events, atSeq) {
  const lastSeq = events.at(-1)?.seq ?? -1
  // 显式锚点：>= atSeq 的第一个轮尾；无 atSeq 或超尾 → 最后一个轮尾。
  const anchored = atSeq === undefined
    ? undefined
    : events.find((e) => e.type === 'turn/end' && e.seq >= atSeq)
  const boundary = anchored ?? (atSeq === undefined || atSeq > lastSeq
    ? [...events].reverse().find((e) => e.type === 'turn/end')
    : undefined)
  if (boundary === undefined) return null
  // 顺延吸收尾部 out-of-band 事件（到下一个 turn/start 为止）。
  let cut = boundary.seq + 1
  while (cut < events.length && events[cut]?.type !== 'turn/start') cut++
  return { seed: events.slice(0, cut), cut }
}

/**
 * 从指定轮次创建官方分支会话（第二阶段核心，用户拍板本期实现）。
 *
 * 路径与官方 fork RPC 完全一致：events 找轮尾边界 → agents.create(seed) →
 * workspace.attachSession 挂到左侧列表（源会话的 cwd 工作区）。不修改源
 * 会话任何数据；子会话通过 meta.parentSession 进入官方谱系树。
 *
 * @param {object} ctx - 插件 cordis ctx（agents 已声明式注入；workspace 可选）。
 * @param {string} sessionId - 源会话 id。
 * @param {number | undefined} atSeq - 目标轮内消息 seq（省略=最后一轮）。
 * @returns {Promise<{ sessionId: string, parentSession: string, cwd: string | null }>}
 */
export async function forkSession(ctx, sessionId, atSeq) {
  const sid = assertSessionId(sessionId)
  const agent = ctx.agents?.get?.(sid)
  const events = agent?.session?.events
  if (!agent || !Array.isArray(events) || events.length === 0) {
    throw new Error(`会话不存在或无可分支记录：${sid}`)
  }
  const built = buildForkSeed(events, atSeq)
  if (built === null) {
    throw new Error(
      atSeq === undefined
        ? '该会话尚无已完成轮次，无法分支'
        : `轮次 ${atSeq} 尚未完成，无法分支`,
    )
  }
  const childId = `session-${randomUUID()}`
  const cwd = agent.session?.header?.cwd
  await ctx.agents.create({
    sessionId: childId,
    seed: built.seed,
    meta: {
      ...(typeof cwd === 'string' ? { cwd } : {}),
      parentSession: sid,
      seedLength: built.cut,
    },
  })
  // 挂到工作区（与官方 fork 同款；attach 失败只影响左侧分组，不阻断）。
  const workspaceRegistry = typeof ctx.get === 'function'
    ? ctx.get('workspaceRegistry')
    : ctx.workspaceRegistry
  if (typeof cwd === 'string' && workspaceRegistry) {
    try {
      const ws = await workspaceRegistry.resolveByPath(cwd)
      if (ws !== undefined) await ws.attachSession(childId)
    } catch (error) {
      console.warn(`[dsh-memory-evolve] 分支会话 ${childId} 挂接工作区失败（忽略）: ${String(error)}`)
    }
  }
  return { sessionId: childId, parentSession: sid, cwd: typeof cwd === 'string' ? cwd : null }
}

/** 发送 JSON 响应。 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/**
 * 读取 JSON 请求体（上限 64 KiB，与本插件其他 API 同量级）。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<object>}
 */
async function readBody(req, maxBytes = 64 * 1024) {
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

/**
 * 安装会话书签模块的宿主端部分（HTTP API + 存储）。
 *
 * httpServer 是 web-only 服务，必须在内部 ctx.inject 动态注入（模块级
 * inject 声明会导致 TUI 面上永久 pending）。
 *
 * 路由前缀：/memory-evolve/api/bookmarks
 *   - GET  /state                          → { enabled: true }（客户端探测）
 *   - GET  /?sessionId=                    → { bookmarks: [...] }
 *   - POST /  body:{sessionId,seq,label?,summary?,turn?} → { bookmark, created }
 *   - PATCH / body:{sessionId,id,label}    → { bookmark }
 *   - DELETE / body:{sessionId,id} 或 ?sessionId=&id= → { ok, removed? }
 *
 * @param {object} ctx - cordis 上下文（各面通用）。
 * @param {object} config - resolved plugin config（需 memoryDir）。
 * @returns {{ dispose: () => void, store: BookmarkStore }} 卸载句柄 + store（测试用）。
 */
export function installBookmarks(ctx, config) {
  const store = new BookmarkStore(bookmarksPath(config))
  let cancel = null
  const base = '/memory-evolve/api/bookmarks'

  // 状态与 CRUD 端点：模块开启才注册（关闭时 404，客户端探测失败即隐藏）。
  ctx.inject(['webServer'], (webCtx) => {
    cancel = webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: base,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname
        try {
          // 状态探测：客户端决定是否注入 turnTail 星标与「书签」Tab。
          if (req.method === 'GET' && path === `${base}/state`) {
            sendJson(res, 200, { enabled: true })
            return
          }

          // 列表：GET /memory-evolve/api/bookmarks?sessionId=
          if (req.method === 'GET' && path === base) {
            const sessionId = url.searchParams.get('sessionId')
            if (!sessionId) {
              sendJson(res, 400, { error: '缺少 sessionId 查询参数' })
              return
            }
            const bookmarks = store.list(sessionId)
            sendJson(res, 200, { bookmarks })
            return
          }

          // 创建/更新：POST body
          if (req.method === 'POST' && path === base) {
            const body = await readBody(req)
            const result = store.upsert({
              sessionId: body.sessionId,
              seq: body.seq,
              label: body.label,
              summary: body.summary,
              turn: body.turn,
            })
            sendJson(res, result.created ? 201 : 200, {
              bookmark: result.bookmark,
              created: result.created,
            })
            return
          }

          // 分支：POST /fork body { sessionId, seq? }——从指定轮（或缺省=最后
          // 一轮）创建官方分支会话（agents.create + seed，见 forkSession）。
          if (req.method === 'POST' && path === `${base}/fork`) {
            const body = await readBody(req)
            const result = await forkSession(ctx, body.sessionId, body.seq)
            sendJson(res, 201, result)
            return
          }

          // 改名：PATCH body
          if (req.method === 'PATCH' && path === base) {
            const body = await readBody(req)
            const bookmark = store.rename(body.sessionId, body.id, body.label)
            sendJson(res, 200, { bookmark })
            return
          }

          // 删除：DELETE body 或 query
          if (req.method === 'DELETE' && path === base) {
            let sessionId = url.searchParams.get('sessionId')
            let id = url.searchParams.get('id')
            // 优先 body（可带 JSON）；query 作 fallback（便于 curl）。
            if (!sessionId || !id) {
              try {
                const body = await readBody(req)
                sessionId = sessionId || body.sessionId
                id = id || body.id
              } catch {
                // 无 body 且 query 不全 → 下面统一 400。
              }
            }
            if (!sessionId || !id) {
              sendJson(res, 400, { error: '缺少 sessionId 或 id' })
              return
            }
            const result = store.remove(sessionId, id)
            if (!result.ok) {
              sendJson(res, 404, { error: result.error })
              return
            }
            sendJson(res, 200, { ok: true, removed: result.removed })
            return
          }

          sendJson(res, 404, { error: 'not found' })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // 参数/业务错误 → 400；未知 → 500。
          const status = /必须|不能|上限|缺少|无效|不存在|尚未完成|无法分支|invalid|too large/i.test(message) ? 400 : 500
          sendJson(res, status, { error: message })
        }
      },
    }), 'dsh-memory-evolve: bookmarks route')
  })

  return {
    store,
    dispose() {
      cancel?.()
      cancel = null
    },
  }
}
