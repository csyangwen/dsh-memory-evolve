/**
 * 会话广播管理面板 API（/memory-evolve/api/broadcast）。
 *
 * **用户超管视角**（管理 Tab 用，不经 AI 工具）：全部消息可见/可删、
 * 全部房间可见（含已解散，追溯）、可解散任意房间、可踢任意成员——
 * 用户是最高权限，不受"仅创建者可操作"限制（AI 工具侧仍有权限校验）。
 * 踢人/解散会发**系统通知**给受影响成员（sender='system'，显式会话 ID
 * 接收者——房间解散后 room: 引用会失效，通知不依赖房间存在）。
 */
import { URL } from 'node:url'

/** Read the JSON request body (capped). */
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

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/**
 * @param {object} ctx - web context（含 httpServer）。
 * @param {object} svc - { broadcast, presence }（BroadcastStore + PresenceTracker）。
 */
export function installBroadcastApi(ctx, svc) {
  const base = '/memory-evolve/api/broadcast'
  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    try {
      // 消息列表（超管全量，倒序）
      if (req.method === 'GET' && path === `${base}/messages`) {
        const messages = svc.broadcast.items
          .map((m) => ({
            id: m.id,
            sender: m.sender,
            recipients: m.recipients,
            subject: m.subject ?? '',
            content: String(m.content ?? '').slice(0, 200), // 列表预览
            hasBody: m.bodyFile != null, // 长内容已落文件（全文需单独取）
            createdAt: m.createdAt,
            readBy: m.readBy ?? [],
          }))
          .sort((a, b) => b.createdAt - a.createdAt)
        return sendJson(res, 200, { ok: true, messages })
      }
      // 消息全文（含长内容文件）
      if (req.method === 'GET' && path.startsWith(`${base}/messages/`) && path.endsWith('/content')) {
        const id = decodeURIComponent(path.slice(`${base}/messages/`.length, -'/content'.length))
        const msg = svc.broadcast.items.find((m) => m.id === id)
        if (!msg) return sendJson(res, 404, { ok: false, message: `消息 ${id} 不存在` })
        let content = msg.content
        if (msg.bodyFile) {
          const { readFileSync } = await import('node:fs')
          try { content = readFileSync(msg.bodyFile, 'utf8') } catch { /* 文件缺失：退回内联预览 */ }
        }
        return sendJson(res, 200, { ok: true, content })
      }
      // 删除消息（超管任意删）
      if (req.method === 'DELETE' && path.startsWith(`${base}/messages/`)) {
        const id = decodeURIComponent(path.slice(`${base}/messages/`.length))
        const result = svc.broadcast.adminRemove(id)
        return sendJson(res, result.ok ? 200 : 404, result)
      }
      // 房间列表（含已解散，追溯；附在线聚合）
      if (req.method === 'GET' && path === `${base}/rooms`) {
        const rooms = Object.values(svc.broadcast.rooms.rooms)
          .map((r) => {
            const presence = svc.presence ? svc.presence.roomStatus(r) : []
            return {
              id: r.id,
              name: r.name,
              members: r.members,
              status: r.status ?? 'active',
              createdAt: r.createdAt,
              lastActiveAt: r.lastActiveAt ?? r.createdAt,
              dissolvedAt: r.dissolvedAt ?? null,
              createdBy: r.createdBy,
              onlineCount: presence.filter((p) => p.online).length,
            }
          })
          .sort((a, b) => b.createdAt - a.createdAt)
        return sendJson(res, 200, { ok: true, rooms })
      }
      // 房间成员在线状态（管理面板轮询）
      if (req.method === 'GET' && path.startsWith(`${base}/rooms/`) && path.endsWith('/presence')) {
        const id = decodeURIComponent(path.slice(`${base}/rooms/`.length, -'/presence'.length))
        const room = svc.broadcast.rooms.get(id)
        if (!room) return sendJson(res, 404, { ok: false, message: `房间 ${id} 不存在` })
        const presence = svc.presence ? svc.presence.roomStatus(room) : room.members.map((sid) => ({ sessionId: sid, status: 'unknown', online: false, lastActiveAt: null }))
        return sendJson(res, 200, { ok: true, presence })
      }
      // 解散房间（超管；软删除 + 系统通知全体成员）
      if (req.method === 'POST' && path.startsWith(`${base}/rooms/`) && path.endsWith('/dissolve')) {
        const id = decodeURIComponent(path.slice(`${base}/rooms/`.length, -'/dissolve'.length))
        const before = svc.broadcast.rooms.get(id)
        // 快照（get 返回引用，dissolve 原地改 status 会污染 before）
        const snap = before ? { name: before.name, members: [...before.members], status: before.status } : null
        const result = svc.broadcast.rooms.dissolve(id, undefined) // 用户超管：不校验创建者
        if (result.ok && snap && snap.status !== 'dissolved' && snap.members.length > 0) {
          svc.broadcast.send({ sender: 'system', recipients: snap.members, content: `房间「${snap.name}」已解散（由管理面板操作）。房间内消息不再可见。`, subject: `房间「${snap.name}」已解散` })
        }
        return sendJson(res, result.ok ? 200 : 400, result)
      }
      // 踢出成员（超管；系统通知被踢者）
      if (req.method === 'POST' && path.startsWith(`${base}/rooms/`) && path.endsWith('/kick')) {
        const id = decodeURIComponent(path.slice(`${base}/rooms/`.length, -'/kick'.length))
        const body = await readBody(req)
        const room = svc.broadcast.rooms.get(id)
        if (!room) return sendJson(res, 404, { ok: false, message: `房间 ${id} 不存在` })
        const result = svc.broadcast.rooms.kick(id, String(body.member ?? '').trim())
        if (result.ok) {
          svc.broadcast.send({
            sender: 'system',
            recipients: [String(body.member ?? '').trim()],
            content: `你已被移出房间「${result.room ? result.room.name : id}」（由管理面板操作）。`,
            subject: `你已被移出房间「${result.room ? result.room.name : id}」`,
          })
        }
        return sendJson(res, result.ok ? 200 : 400, result)
      }
      return sendJson(res, 404, { ok: false, message: `未知路由 ${path}` })
    } catch (error) {
      return sendJson(res, 400, { ok: false, message: error?.message ?? String(error) })
    }
  }
  return ctx.httpServer.register({ kind: 'prefix', path: base, handler })
}
