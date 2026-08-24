/**
 * web 站内通知模块 —— 通知模块（de_notify / de_channel_send）的「web 渠道」。
 *
 * 定位（2026-08-13 用户拍板）：渠道通知原本只发到 IM 渠道（飞书/QQ/微信/
 * 企微，发完即忘、不落盘）；本模块新增一个**内置渠道 web**——AI 发通知时
 * channels 选 web（或 all 连带 web），通知就**落盘到本机**，网页右上角铃铛
 * 亮未读数字，用户点开看「哪个会话发来什么通知」并可标记已读。
 *
 * 与飞书等外部渠道的本质区别：
 *   - 外部渠道：发送内核读 globalThis.__dshChannelNotify 注册表，调渠道插件
 *     的 send/sendMedia，发完即完，**不落盘、无已读概念**；
 *   - web 渠道：本插件**自实现**（内置分支），写 notifications.json，**落盘
 *     + 用户维度已读水位**（区别于广播的 AI 维度 readBy）。
 *
 * 数据模型（扁平六字段，用户拍板不引入 type 硬分类）：
 *   { id, sender（来源会话 ID，空=系统自动）, semantic（notify/direct）,
 *     subject（主题，缺省取内容首行）, content（正文，超长落文件）,
 *     createdAt（毫秒）, read（用户是否看过）, bodyFile?, attachments? }
 *
 * 存储目录：<memoryDir>/notifications/notifications.json + attachments/。
 * 保留策略：30 天自动过期 + 最多 500 条（超出裁最旧）。
 *
 * 本文件职责：
 *   1. NotificationStore —— 通知的落盘存储（原子写、清理、已读水位）；
 *   2. installNotifyWebApi —— 宿主端 API（未读数/列表/已读/全部已读/删除/
 *      全文/附件下载），web 渠道关闭时**不挂载**（前端探测 404 即不注入铃铛）。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { translate, getLocale, MISC2_DICT } from './i18n.js'

/** Translate through MISC2_DICT in the active host locale. */
const nt2 = (key, params) => translate(MISC2_DICT, key, params, getLocale())
import { URL } from 'node:url'
// 附件落盘 + 魔数嗅探：复用广播模块已实现的能力（path/url/base64 三选一 +
// 魔数嗅探 + 安全文件名 + 失败清理），避免重复造轮子。广播的 resolveAttachments
// 仅支持图片（PNG/JPEG/WebP/GIF，≤5MiB、≤10 张）——通知场景图片是主要附件，
// 文件类型（PDF/文档）一期如实报「web 渠道暂只支持图片附件」。
import { resolveAttachments, sniffImage } from './coi/broadcast.js'

/** 内容内联上限：超过则写 notifications/<id>.txt（消息体不膨胀 JSON）。 */
const INLINE_MAX = 8192
/** 通知保留时长（30 天）。 */
const RETENTION_MS = 30 * 24 * 3600 * 1000
/** 最多保留条数（超出裁最旧，防无限堆积）。 */
const MAX_ITEMS = 500

/** 生成通知 id：ntf-<时间戳36>-<随机6位>。 */
export function newNotificationId() {
  return `ntf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 读取 JSON 请求体（带上限）。 */
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

/** 发送 JSON 响应。 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/**
 * web 通知落盘存储。live-read/live-write：每次操作即时读文件、写原子落盘，
 * 无内存缓存漂移问题（通知量小，全量重读成本可忽略）。
 */
export class NotificationStore {
  /** @param {string} memoryDir - <dshHome>/memories（notifications 子目录在其下）。 */
  constructor(memoryDir) {
    this.dir = join(memoryDir, 'notifications')
    this.file = join(this.dir, 'notifications.json')
    this.items = []
    this.#load()
  }

  /** 从文件加载（缺失/损坏按空表处理）。 */
  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (parsed && Array.isArray(parsed.items)) this.items = parsed.items
    } catch {
      this.items = []
    }
  }

  /** 原子落盘（写临时文件后 rename，避免半写损坏 JSON）。 */
  #save() {
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 2) + '\n')
    renameSync(tmp, this.file)
  }

  /**
   * 写入一条通知（返回通知视图；发送内核 web 分支调用）。
   * @param {object} input - { sender, semantic, subject, content, attachments }。
   *   sender：来源会话 ID（空串 = 系统自动通知，如 COI 完成）。
   *   attachments：原始附件参数数组（path/url/base64），落盘到 attachments/。
   * @returns {{ok: boolean, id?: string, message?: string}}
   */
  async add(input) {
    this.#load()
    const sender = String(input.sender ?? '')
    const semantic = input.semantic === 'direct' ? 'direct' : 'notify'
    const content = String(input.content ?? '')
    // 主题：显式传用显式值，否则取内容首行（去空白）。
    const subject = String(input.subject ?? '').trim() !== ''
      ? String(input.subject ?? '').trim()
      : content.split('\n').map((s) => s.trim()).find((s) => s !== '') ?? ''
    // 超长正文落文件（JSON 里只存首 200 字预览 + bodyFile 路径）。
    let stored = content
    let bodyFile = null
    if (content.length > INLINE_MAX) {
      bodyFile = join(this.dir, `${newNotificationId()}.txt`)
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(bodyFile, content, 'utf8')
      stored = content.slice(0, 200)
    }
    // 附件落盘（图片专用；失败清理已写文件，原子不留孤儿）。
    let attachments = []
    if (Array.isArray(input.attachments) && input.attachments.length > 0) {
      const id = newNotificationId()
      const resolved = await resolveAttachments(this.dir, id, input.attachments)
      if (!resolved.ok) {
        // 附件失败：清理已写正文文件，整条通知不落盘（如实报错）。
        if (bodyFile) { try { rmSync(bodyFile, { force: true }) } catch { /* 忽略 */ } }
        return { ok: false, message: resolved.message }
      }
      // 附件记录去掉绝对路径（UI 通过下载端点取字节，路径不暴露）。
      attachments = (resolved.attachments ?? []).map((a) => ({ name: a.name, file: a.file, size: a.size, mime: a.mime }))
    }
    const id = newNotificationId()
    this.items.unshift({ id, sender, semantic, subject, content: stored, bodyFile, attachments, createdAt: Date.now(), read: false })
    this.#prune()
    this.#save()
    return { ok: true, id }
  }

  /** 未读数（铃铛数字）。 */
  unreadCount() {
    this.#load()
    return this.items.filter((i) => i.read !== true).length
  }

  /**
   * 通知列表视图（宿主端映射 sender 名称，前端直接渲染）。
   * @param {string} type - 'unread' | 'all'。
   * @param {Function} [resolveSenderName] - 发送方显示名解析回调
   *   （sessionId → 显示名：别名 → 会话名称 sessionTitle → 短 ID，由主插件
   *   提供，因为需要访问 agents/sessionTitle 服务；缺省回退短 ID）。
   */
  list(type, resolveSenderName) {
    this.#load()
    const wanted = type === 'all' ? this.items : this.items.filter((i) => i.read !== true)
    return wanted.map((m) => ({
      id: m.id,
      sender: m.sender ?? '',
      // 发送方显示名：别名优先 → 会话名称 → 短 ID（完整 ID 由前端悬停展示）。
      senderName: m.sender
        ? (typeof resolveSenderName === 'function' ? resolveSenderName(m.sender) : String(m.sender).slice(0, 8))
        : 'system',
      semantic: m.semantic === 'direct' ? 'direct' : 'notify',
      subject: m.subject ?? '',
      content: String(m.content ?? '').slice(0, 300), // 列表预览（短内容=完整）
      // 是否长文：>300 字或已落文件（>8KB）。前端据此决定「截断 + 查看详情」。
      isLong: m.bodyFile != null || String(m.content ?? '').length > 300,
      hasBody: m.bodyFile != null,
      attachments: Array.isArray(m.attachments)
        ? m.attachments.map((a) => ({ name: a.name, size: a.size, mime: a.mime }))
        : [],
      createdAt: m.createdAt,
      read: m.read === true,
    }))
  }

  /** 取单条原文（含长内容文件）。 */
  full(id) {
    this.#load()
    const m = this.items.find((i) => i.id === id)
    if (!m) return null
    let content = m.content
    if (m.bodyFile) {
      try { content = readFileSync(m.bodyFile, 'utf8') } catch { /* 文件缺失：退回预览 */ }
    }
    return content
  }

  /** 标记已读（批量 ids；返回实际命中数）。 */
  read(ids) {
    this.#load()
    const set = new Set(Array.isArray(ids) ? ids.map(String) : [])
    let hit = 0
    for (const m of this.items) {
      if (set.has(m.id) && m.read !== true) {
        m.read = true
        hit += 1
      }
    }
    if (hit > 0) this.#save()
    return hit
  }

  /** 全部标记已读。 */
  readAll() {
    this.#load()
    let hit = 0
    for (const m of this.items) {
      if (m.read !== true) { m.read = true; hit += 1 }
    }
    if (hit > 0) this.#save()
    return hit
  }

  /** 删除单条（连带正文文件与附件，不留孤儿）。 */
  remove(id) {
    this.#load()
    const at = this.items.findIndex((i) => i.id === id)
    if (at < 0) return { ok: false, message: nt2('notify.missing', { id }) }
    const m = this.items[at]
    if (m.bodyFile) { try { rmSync(m.bodyFile, { force: true }) } catch { /* 忽略 */ } }
    for (const a of m.attachments ?? []) {
      if (a.file) { try { rmSync(a.file, { force: true }) } catch { /* 忽略 */ } }
    }
    this.items.splice(at, 1)
    this.#save()
    return { ok: true }
  }

  /** 按 id 取附件（下载端点用）。 */
  attachment(id, index) {
    this.#load()
    const m = this.items.find((i) => i.id === id)
    const att = m && Array.isArray(m.attachments) ? m.attachments[index] : undefined
    return att && typeof att.file === 'string' ? att : null
  }

  /** 清理：30 天过期 + 超 500 条裁最旧（连带正文/附件文件）。 */
  #prune() {
    const cutoff = Date.now() - RETENTION_MS
    const alive = this.items.filter((m) => (m.createdAt ?? 0) >= cutoff)
    // 被裁掉的旧通知，连带清理其正文文件与附件（防孤儿堆积）。
    const removed = this.items.filter((m) => (m.createdAt ?? 0) < cutoff)
    for (const m of removed) {
      if (m.bodyFile) { try { rmSync(m.bodyFile, { force: true }) } catch { /* 忽略 */ } }
      for (const a of m.attachments ?? []) {
        if (a.file) { try { rmSync(a.file, { force: true }) } catch { /* 忽略 */ } }
      }
    }
    // 超上限：裁掉最旧的（alive 已是按时间倒序，尾部最旧）。
    while (alive.length > MAX_ITEMS) {
      const m = alive.pop()
      if (m.bodyFile) { try { rmSync(m.bodyFile, { force: true }) } catch { /* 忽略 */ } }
      for (const a of m.attachments ?? []) {
        if (a.file) { try { rmSync(a.file, { force: true }) } catch { /* 忽略 */ } }
      }
    }
    this.items = alive
  }
}

/**
 * 安装 web 通知宿主端 API。随 notifyEnabled 挂/卸（关闭时 404，前端探测
 * 失败即不注入铃铛）。webServer 是 web-only 服务，须 ctx.inject 动态注入。
 * @param {object} ctx - cordis 上下文。
 * @param {object} deps - { store: NotificationStore, resolveSenderName: Function }。
 *   resolveSenderName：发送方显示名解析（sessionId → 显示名，别名→会话名称→
 *   短 ID），由主插件提供（需访问 agents/sessionTitle 服务）。
 * @returns {() => void} 卸载句柄。
 */
export function installNotifyWebApi(ctx, deps) {
  const { store, resolveSenderName } = deps
  let cancel = null
  ctx.inject(['webServer'], (webCtx) => {
    cancel = webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/memory-evolve/api/notifications',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname
        const base = '/memory-evolve/api/notifications'
        try {
          // 未读数（铃铛数字）。
          if (req.method === 'GET' && path === `${base}/unread`) {
            return sendJson(res, 200, { count: store.unreadCount() })
          }
          // 列表（unread/all）；sender 名称用 resolveSenderName 映射。
          if (req.method === 'GET' && path === `${base}/list`) {
            const type = url.searchParams.get('type') === 'all' ? 'all' : 'unread'
            return sendJson(res, 200, { items: store.list(type, resolveSenderName) })
          }
          // 通知原文（含长内容文件）。
          if (req.method === 'GET' && path.startsWith(`${base}/`) && path.endsWith('/content')) {
            const id = decodeURIComponent(path.slice(`${base}/`.length, -'/content'.length))
            const content = store.full(id)
            if (content === null) return sendJson(res, 404, { error: `通知 ${id} 不存在` })
            return sendJson(res, 200, { content })
          }
          // 附件字节（图片缩略图/原图；路径不暴露，走端点取）。
          if (req.method === 'GET' && path.startsWith(`${base}/`) && path.includes('/attachment/')) {
            const rest = path.slice(`${base}/`.length)
            const index = Number(rest.slice(rest.lastIndexOf('/attachment/') + '/attachment/'.length))
            const id = decodeURIComponent(rest.slice(0, rest.lastIndexOf('/attachment/')))
            const att = store.attachment(id, index)
            if (!att) return sendJson(res, 404, { error: `附件不存在（通知 ${id} 第 ${index} 张）` })
            try {
              const buf = readFileSync(att.file)
              res.writeHead(200, {
                'content-type': att.mime ?? 'application/octet-stream',
                'content-length': buf.length,
                'cache-control': 'private, max-age=3600',
              })
              res.end(buf)
              return
            } catch {
              return sendJson(res, 404, { error: `附件文件缺失（${att.name}）` })
            }
          }
          // 标记已读（批量 ids）。
          if (req.method === 'POST' && path === `${base}/read`) {
            const body = await readBody(req)
            const hit = store.read(body.ids)
            return sendJson(res, 200, { ok: true, hit })
          }
          // 全部已读。
          if (req.method === 'POST' && path === `${base}/readAll`) {
            const hit = store.readAll()
            return sendJson(res, 200, { ok: true, hit })
          }
          // 删除单条。
          if (req.method === 'DELETE' && path.startsWith(`${base}/`)) {
            const id = decodeURIComponent(path.slice(`${base}/`.length))
            const result = store.remove(id)
            return sendJson(res, result.ok ? 200 : 404, result)
          }
          return sendJson(res, 404, { error: 'not found' })
        } catch (error) {
          return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'dsh-memory-evolve: web notify api')
  })

  return () => {
    cancel?.()
    cancel = null
  }
}
