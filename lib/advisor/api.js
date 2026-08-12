/**
 * Advisor HTTP API（实施规划 §五 契约 v2）。
 *
 * Base：/memory-evolve/api/advisor。端点：
 *
 *   GET    /status?sessionId=            → 会话状态（契约字段）
 *   GET    /events?sessionId=&after=&limit= → live 事件（seq 游标 + gap）
 *   GET    /records?sessionId=&workspace=&severity=&before=&limit= → 终态记录
 *   POST   /instructions   { sessionId, text } → 发指令
 *   GET    /instructions?sessionId=      → 待处理指令
 *   DELETE /instructions?sessionId=      → 清空 pending
 *   POST   /toggle         { sessionId, enabled } → 会话级开关
 *   GET    /config                       → 全局配置（只读）
 *   PATCH  /config         { patch }     → 写全局配置（走 ctrl.reconfigure）
 *   GET    /scopes?sessionId=            → 四层级约束（项目/会话/评审会话）
 *   PUT    /scopes         { sessionId, level, text } → 保存某层约束
 *
 * 安全（双审 MAJOR-9）：写接口强制 application/json + Origin/Host 同源 +
 * body ≤64KB；错误统一 { ok:false, code, error } + 恰当状态码；未知端点
 * 404。同源校验模式复制自 lib/api.js sameOriginGuard（本地副本，注释保留）。
 *
 * @module dsh-memory-evolve/advisor/api
 */

import { URL } from 'node:url'

const BASE = '/memory-evolve/api/advisor'
const BODY_MAX_BYTES = 64 * 1024
const EVENTS_MAX_LIMIT = 200

/** 读 JSON body（有上限；非法 JSON 抛错）。 */
async function readBody(req, maxBytes = BODY_MAX_BYTES) {
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

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/** 错误统一体。 */
function sendError(res, status, code, error) {
  sendJson(res, status, { ok: false, code, error })
}

/**
 * 同源校验（写操作）：带 body 的请求要求 Content-Type 精确 JSON + Origin
 * 与 Host 一致。无 body 的写操作（DELETE）跳过 content-type 检查（浏览器
 * 无 body fetch 不带该头），Origin 校验仍强制。返回错误文案或 null。
 * 模式复制自 lib/api.js（保持本项目同款防护）。
 */
/**
 * 同源校验（写操作）：返回 [status, code, message] 或 null。
 * MAJOR-8（复审）：带 body 的请求 content-type 非 JSON → 415；缺/跨站
 * Origin → 403；body 非对象 → 400。无 body 的写操作（DELETE）跳过
 * content-type 检查（浏览器无 body fetch 不带该头）。
 */
function sameOriginGuard(req, body) {
  const hasBody = String(req.headers['content-length'] ?? '0') !== '0' || req.method === 'POST' || req.method === 'PATCH'
  if (hasBody) {
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') return [415, 'UNSUPPORTED_MEDIA_TYPE', '请求必须为 application/json']
  }
  const host = String(req.headers.host ?? '')
  const origin = String(req.headers.origin ?? '')
  if (origin === '') return [403, 'FORBIDDEN', '缺少 Origin 头，已拒绝（写操作必须由 Web UI 发起）']
  let originHost = ''
  try {
    originHost = new URL(origin).host
  } catch {
    return [403, 'FORBIDDEN', '跨站请求已拒绝']
  }
  if (originHost !== host) return [403, 'FORBIDDEN', '跨站请求已拒绝']
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    return [400, 'BAD_BODY', '请求体必须是 JSON 对象']
  }
  return null
}

/** 会话存在性校验（无效 sessionId 返回 null，避免制造孤儿状态）。 */
function sessionExists(ctrl, sessionId) {
  return typeof sessionId === 'string' && sessionId !== '' && ctrl.sessionExists(sessionId)
}

/**
 * @param {object} ctx - web 上下文（httpServer）
 * @param {object} ctrl - installAdvisor 返回的控制器（扩充 sessionExists）
 * @returns {() => void} httpServer 注销函数
 */
export function installAdvisorApi(ctx, ctrl) {
  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const params = url.searchParams
    try {
      // MAJOR-8：先按 method/path 分发——未知端点 404 优先（不落入写操作
      // 的同源 guard，避免"未知 GET 无 Origin 返回 403"的错位）
      const sub = path.startsWith(BASE) ? path.slice(BASE.length) : null
      const known = sub !== null && (
        (req.method === 'GET' && ['/status', '/events', '/records', '/instructions', '/config', '/scopes'].includes(sub))
        || (req.method === 'POST' && ['/instructions', '/conversation/reset', '/toggle'].includes(sub))
        || (req.method === 'DELETE' && ['/instructions'].includes(sub))
        || (req.method === 'PATCH' && ['/config'].includes(sub))
        || (req.method === 'PUT' && ['/scopes'].includes(sub))
      )
      if (!known) return sendError(res, 404, 'NOT_FOUND', `未知端点: ${req.method} ${path}`)

      // ---- 读操作 ----
      if (req.method === 'GET' && sub === '/status') {
        const sessionId = params.get('sessionId')
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        return sendJson(res, 200, { ok: true, ...ctrl.status(sessionId) })
      }
      if (req.method === 'GET' && sub === '/events') {
        const sessionId = params.get('sessionId')
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        const afterRaw = params.get('after')
        const after = afterRaw === null ? undefined : Number(afterRaw)
        // MAJOR-8：after 必须是非负安全整数（旧实现 abc 可致游标错乱）
        if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) {
          return sendError(res, 400, 'BAD_CURSOR', 'after 必须是非负整数')
        }
        const limitRaw = Number(params.get('limit') ?? 100)
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), EVENTS_MAX_LIMIT) : 100
        const result = ctrl.queryEvents(sessionId, after, limit)
        return sendJson(res, 200, { ok: true, ...result })
      }
      if (req.method === 'GET' && sub === '/records') {
        const severity = params.get('severity')
        if (severity !== null && severity !== 'info' && severity !== 'nit' && severity !== 'concern' && severity !== 'blocker' && severity !== 'answer') {
          return sendError(res, 400, 'BAD_SEVERITY', 'severity 必须是 info/nit/concern/blocker/answer')
        }
        const limitRaw = params.get('limit')
        const limit = limitRaw === null ? undefined : Number(limitRaw)
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
          return sendError(res, 400, 'BAD_LIMIT', 'limit 必须是 1..100 的整数')
        }
        const result = ctrl.queryRecords({
          sessionId: params.get('sessionId') ?? undefined,
          workspace: params.get('workspace') ?? undefined,
          severity: severity ?? undefined,
          before: params.get('before') ?? undefined,
          limit,
        })
        return sendJson(res, 200, { ok: true, ...result })
      }
      if (req.method === 'GET' && sub === '/instructions') {
        const sessionId = params.get('sessionId')
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        return sendJson(res, 200, { ok: true, pending: ctrl.instructionsOf(sessionId) })
      }
      if (req.method === 'GET' && sub === '/config') {
        return sendJson(res, 200, { ok: true, config: ctrl.configSnapshot() })
      }
      if (req.method === 'GET' && sub === '/scopes') {
        const sessionId = params.get('sessionId')
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        return sendJson(res, 200, { ok: true, scopes: ctrl.scopesOf(sessionId) })
      }

      // ---- 写操作（同源防护 + 413/415）----
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        if (error instanceof Error && error.message === 'body too large') {
          return sendError(res, 413, 'PAYLOAD_TOO_LARGE', '请求体超限（≤64KB）')
        }
        return sendError(res, 400, 'BAD_JSON', '请求体不是合法 JSON')
      }
      const guard = sameOriginGuard(req, body)
      if (guard !== null) return sendError(res, guard[0], guard[1], guard[2])

      if (req.method === 'POST' && sub === '/instructions') {
        const { sessionId, text } = body
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        if (typeof text !== 'string') return sendError(res, 400, 'BAD_TEXT', 'text 必须为字符串')
        try {
          ctrl.tell(sessionId, text)
          return sendJson(res, 200, { ok: true, pending: ctrl.instructionsOf(sessionId) })
        } catch (error) {
          return sendError(res, 400, 'BAD_TEXT', error instanceof Error ? error.message : String(error))
        }
      }
      if (req.method === 'DELETE' && sub === '/instructions') {
        const sessionId = params.get('sessionId')
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        return sendJson(res, 200, { ok: true, ...ctrl.clearInstructions(sessionId) })
      }
      if (req.method === 'POST' && sub === '/conversation/reset') {
        // Q3：新建评审会话——清空评审员持续上下文 + 去重记忆（epoch 自增）
        const { sessionId } = body
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        const result = ctrl.resetConversation(sessionId)
        if (result === null) {
          return sendError(res, 400, 'NOT_RUNNING', '本会话 Advisor 未启用或运行时不可用，无法新建评审会话')
        }
        return sendJson(res, 200, { ok: true, ...result })
      }
      if (req.method === 'PUT' && sub === '/scopes') {
        const { sessionId, level, text } = body
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        if (typeof level !== 'string' || !['global', 'project', 'session', 'conversation'].includes(level)) {
          return sendError(res, 400, 'BAD_LEVEL', 'level 必须是 global/project/session/conversation')
        }
        if (typeof text !== 'string') return sendError(res, 400, 'BAD_TEXT', 'text 必须为字符串')
        try {
          const scopes = ctrl.saveScope(sessionId, level, text)
          return sendJson(res, 200, { ok: true, scopes })
        } catch (error) {
          return sendError(res, 400, 'BAD_SCOPE', error instanceof Error ? error.message : String(error))
        }
      }
      if (req.method === 'POST' && sub === '/toggle') {
        const { sessionId, enabled } = body
        if (!sessionExists(ctrl, sessionId)) return sendError(res, 400, 'BAD_SESSION', 'sessionId 无效或会话不存在')
        if (typeof enabled !== 'boolean') return sendError(res, 400, 'BAD_ENABLED', 'enabled 必须为布尔值')
        const s = ctrl.setSessionOverride(sessionId, enabled)
        return sendJson(res, 200, { ok: true, ...s })
      }
      if (req.method === 'PATCH' && sub === '/config') {
        const { patch } = body
        if (patch === undefined || typeof patch !== 'object' || Array.isArray(patch)) {
          return sendError(res, 400, 'BAD_PATCH', 'patch 必须是对象')
        }
        try {
          const config = ctrl.patchConfig(patch)
          return sendJson(res, 200, { ok: true, config })
        } catch (error) {
          return sendError(res, 400, 'BAD_PATCH', error instanceof Error ? error.message : String(error))
        }
      }

      return sendError(res, 404, 'NOT_FOUND', `未知端点: ${req.method} ${path}`)
    } catch (error) {
      return sendError(res, 400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
    }
  }
  return ctx.webServer.register({ kind: 'prefix', path: BASE, handler })
}
