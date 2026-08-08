/**
 * 会话广播模块（broadcast.json + de_broadcast 工具）— DSH 会话间消息传递。
 *
 * **独立子模块**（用户拍板 2026-08-08：两个明显独立的子模块不要坐在一起，
 * 曾因挂在 COI 调度下导致开关联动/工具上下文污染，故拆出）：
 * - 独立开关 broadcastEnabled（默认关，记忆 Tab 运行时配置）
 * - 独立装配 installBroadcast（lib/coi/index.js）：不依赖 coiEnabled，
 *   开启即注册 de_broadcast 工具 + prune 定时器
 * - 独立存储目录 broadcastDataDir（null → <memoryDir>/broadcast/）
 * - 快照「会话广播」段按 broadcastEnabled 注入（lib/index.js）
 * - 会话头部「复制会话 ID」按钮按 broadcastEnabled 独立探测
 *
 * 机制：会话 A 给会话 B（可多个）发消息，快照对接收方会话**定点注入**
 * 未读清单（收件箱式：id+主题+发送者+时间；只有接收者看得到，其他会话
 * 无感知）；read 返回全文并标记已读，**全部接收者已读后消息自动删除**
 * （读即消费）。内容不注入快照（克制）。
 *
 * 消息模型：
 *   { id, sender（发送方会话 ID）, recipients: [会话ID...]（数组，
 *     兼容多会话广播；未来可扩展 project:<路径>/global 伪接收者）,
 *     subject（主题，缺省取内容首行）, content（≤8KB 内联；超长落文件
 *     broadcasts/<id>.txt）, createdAt, readBy: [已读会话ID...] }
 *
 * 清理：30 天自动过期（prune 调用）+ 手动删除（发送方或任一接收方可删）。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readAliases } from '../aliases.js'

/** 内容内联上限：超过则写入 broadcasts/<id>.txt（消息体不膨胀 JSON）。 */
const INLINE_MAX = 8192
/** 消息保留时长（30 天；用户主动触发通常实时处理，留档供回看）。 */
const RETENTION_MS = 30 * 24 * 3600 * 1000

let sequence = 0
/** 生成消息 id：msg-<时间戳36>-<序号36>。 */
export function newMessageId() {
  sequence += 1
  return `msg-${Date.now().toString(36)}-${sequence.toString(36)}`
}

let roomSeq = 0
/** 生成房间 id：room-<时间戳36>-<序号36>。 */
export function newRoomId() {
  roomSeq += 1
  return `room-${Date.now().toString(36)}-${roomSeq.toString(36)}`
}

/**
 * 房间仓库（rooms.json）— 聊天室（自定义群）的成员名单。
 *
 * 房间 = 群 id → { id, name, members: [会话ID...], createdAt, createdBy,
 *   status: 'active' | 'dissolved', dissolvedAt? }。
 * 成员是**会话 ID 数组**（全局唯一），与工作目录无关——**天然支持跨工作
 * 目录协作**（A 在 /p1、B 在 /p2 可同群）。
 * 消息引用房间用伪接收者 `room:<id>`（BroadcastStore 按成员判断可见），
 * 发送方无需知道成员名单；加入/退出由成员自己操作。
 * **软删除**（用户拍板：面板可追溯）：解散=标记 status:'dissolved' +
 * dissolvedAt，记录保留 30 天（prune 清理）供面板追溯；已解散房间拒绝
 * 加入/发消息；解散/踢人时由调用方发系统通知（sender='system'）。
 */
export class RoomStore {
  /**
   * @param {string} dir - 数据目录（与 broadcast.json 同目录）。
   */
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'rooms.json')
    this.rooms = this.#load()
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (error) {
      if (error.code === 'ENOENT') return {}
      throw error
    }
  }

  #save() {
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(this.rooms, null, 2) + '\n')
    renameSync(tmp, this.file)
  }

  /** 按 id 取房间（含已解散，面板追溯用）；不存在返回 undefined。 */
  get(id) {
    return this.rooms[id]
  }

  /** 记录房间活动（发消息/加入时调用）：刷新 lastActiveAt 并落盘。 */
  touch(id) {
    const room = this.rooms[id]
    if (room) {
      room.lastActiveAt = Date.now()
      this.#save()
    }
  }

  /**
   * 创建房间（创建者自动成为首个成员）。
   * @param {object} req - { name?, createdBy }
   * @returns {{ok:boolean, message:string, room?:object}}
   */
  create({ name, createdBy } = {}) {
    const creator = String(createdBy ?? '').trim()
    if (!creator) return { ok: false, message: '创建者会话 id 不能为空' }
    const id = newRoomId()
    const now = Date.now()
    const room = {
      id,
      name: String(name ?? '').trim() !== '' ? String(name).trim() : id,
      members: [creator],
      createdAt: now,
      lastActiveAt: now, // 最近活动（消息/加入）时间——30 天无活动自动清理
      status: 'active',
      createdBy: creator,
    }
    this.rooms[id] = room
    this.#save()
    return { ok: true, message: `房间「${room.name}」已创建（你是成员；告诉其他人房间 id ${id} 让它们 room-join）`, room }
  }

  /** 加入房间（幂等；已解散房间拒绝）。 */
  join(id, sessionId) {
    const room = this.rooms[id]
    if (!room) return { ok: false, message: `房间 ${id} 不存在（请向创建者确认房间 id）` }
    if (room.status === 'dissolved') return { ok: false, message: `房间「${room.name}」已解散，无法加入` }
    if (!room.members.includes(sessionId)) {
      room.members.push(sessionId)
      this.#save()
    }
    this.touch(id) // 加入算活动（刷新清理计时）
    return { ok: true, message: `已加入房间「${room.name}」（成员 ${room.members.length} 人）`, room }
  }

  /** 退出房间（最后一个成员退出后房间自动删除）。 */
  leave(id, sessionId) {
    const room = this.rooms[id]
    if (!room) return { ok: false, message: `房间 ${id} 不存在` }
    room.members = room.members.filter((s) => s !== sessionId)
    if (room.members.length === 0) {
      // 最后一人退出 = 房间解散（**软删除**，与 room-rm 一致：标记
      // status/dissolvedAt，记录保留供追溯——曾物理删除导致房间凭空
      // 消失、无法追溯；已解散房间 join/send 均拒绝）
      room.status = 'dissolved'
      room.dissolvedAt = Date.now()
      this.#save()
      return { ok: true, message: `已退出，房间 ${id} 无成员已解散（记录保留可追溯）` }
    }
    this.#save()
    return { ok: true, message: `已退出房间「${room.name}」（剩 ${room.members.length} 人）`, room }
  }

  /**
   * 某会话所在的**未解散**房间列表（状态通知用：成员 running/idle 切换
   * 时，装配层据此通知同房其他成员；已解散房间不再产生动态）。
   * @param {string} sessionId
   * @returns {object[]} 房间对象数组（空数组 = 非任何房间成员）
   */
  roomsOf(sessionId) {
    if (!sessionId) return []
    return Object.values(this.rooms).filter((r) => r.status !== 'dissolved' && r.members.includes(sessionId))
  }

  /**
   * 我所在的房间列表（按创建时间倒序），支持筛选与分页：
   * @param {string} sessionId
   * @param {object} [opts]
   *   opts.type：'active'=只显示未解散（**缺省**，收件箱视角）/ 'all'=含已解散（带 status）
   *   opts.query：房间名子串（大小写不敏感）
   *   opts.sinceDays：只显示最近 N 天创建的（createdAt >= now-N*86400000）
   *   opts.page / opts.pageSize：分页（缺省 page=1, pageSize=10）
   * @returns {{rooms: object[], total: number}} rooms=当前页；total=过滤后总数（分页前）
   */
  list(sessionId, opts = {}) {
    if (!sessionId) return { rooms: [], total: 0 }
    const type = opts.type ?? 'active'
    const query = String(opts.query ?? '').trim().toLowerCase()
    const sinceDays = Number(opts.sinceDays ?? 0)
    const page = Math.max(1, Number(opts.page ?? 1) || 1)
    const pageSize = Math.max(1, Number(opts.pageSize ?? 10) || 10)
    const since = sinceDays > 0 ? Date.now() - sinceDays * 86400000 : 0
    const filtered = Object.values(this.rooms)
      .filter((r) => r.members.includes(sessionId))
      .filter((r) => type === 'all' || r.status !== 'dissolved')
      .filter((r) => query === '' || String(r.name ?? '').toLowerCase().includes(query))
      .filter((r) => since === 0 || r.createdAt >= since)
      .sort((a, b) => b.createdAt - a.createdAt)
    return {
      rooms: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
    }
  }

  /**
   * 解散房间（软删除：标记 status/dissolvedAt，记录保留供面板追溯；
   * 已解散后 join/send 均拒绝）。调用方负责向全体成员发系统通知。
   * @param {string} id
   * @param {string} sessionId - 操作者（仅创建者，用户超管走 API 不校验）。
   * @returns {{ok:boolean, message:string, room?:object}}
   */
  dissolve(id, sessionId) {
    const room = this.rooms[id]
    if (!room) return { ok: false, message: `房间 ${id} 不存在` }
    if (sessionId && room.createdBy !== sessionId) return { ok: false, message: '只有创建者可以解散房间' }
    if (room.status === 'dissolved') return { ok: true, message: `房间「${room.name}」已是解散状态`, room }
    room.status = 'dissolved'
    room.dissolvedAt = Date.now()
    this.#save()
    return { ok: true, message: `房间「${room.name}」已解散`, room }
  }

  /**
   * 踢出成员（被踢者失去房间访问；调用方负责发系统通知被踢者）。
   * 最后一个成员被踢后房间解散（空房不留）。
   * @param {string} id
   * @param {string} member - 被踢的会话 id。
   * @returns {{ok:boolean, message:string, room?:object}}
   */
  kick(id, member) {
    const room = this.rooms[id]
    if (!room) return { ok: false, message: `房间 ${id} 不存在` }
    if (room.status === 'dissolved') return { ok: false, message: `房间「${room.name}」已解散` }
    if (!room.members.includes(member)) return { ok: false, message: `成员 ${member} 不在房间中` }
    room.members = room.members.filter((s) => s !== member)
    if (room.members.length === 0) {
      // 最后一个成员被踢：直接解散（空房不留，等同全员退出）
      room.status = 'dissolved'
      room.dissolvedAt = Date.now()
      this.#save()
      return { ok: true, message: `已踢出 ${member}，房间无成员已解散`, room }
    }
    this.#save()
    return { ok: true, message: `已踢出成员 ${member}（剩 ${room.members.length} 人）`, room }
  }
}

/**
 * 伪接收者前缀判断：room:<群id> / project:<绝对路径>（显式会话 ID 之外
 * 的广播目标；未来可扩展 global）。
 */
const isPseudo = (r) => typeof r === 'string' && (r.startsWith('room:') || r.startsWith('project:'))
const isRoomRef = (r) => typeof r === 'string' && r.startsWith('room:')
const isProjectRef = (r) => typeof r === 'string' && r.startsWith('project:')

/**
 * 解析一个接收者引用为 { type, value }：
 *   - room:<id> 或裸房间 id（room-xxx 宽容识别——room-list 返回的 id
 *     可直接用于 recipients，AI 不易拼错）→ { type:'room', value:id }
 *   - project:<绝对路径> → { type:'project', value:路径 }
 *   - 其余 → { type:'direct', value:原值 }（显式会话 ID）
 */
function parseRef(r) {
  if (typeof r !== 'string') return { type: 'direct', value: r }
  if (r.startsWith('room:')) return { type: 'room', value: r.slice(5) }
  if (/^room-[0-9a-z-]+$/.test(r)) return { type: 'room', value: r }
  if (r.startsWith('project:')) return { type: 'project', value: r.slice(8) }
  return { type: 'direct', value: r }
}

/**
 * @param {string} dir - 数据目录（broadcastDataDir，独立于 coiDataDir；
 *   null → <memoryDir>/broadcast）。
 * @param {RoomStore} [rooms] - 房间仓库（缺省同目录新建；伪接收者
 *   room:<id> 的成员判断依赖它）。
 */
export class BroadcastStore {
  constructor(dir, rooms) {
    this.dir = dir
    this.file = join(dir, 'broadcast.json')
    this.items = this.#load()
    this.rooms = rooms ?? new RoomStore(dir)
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  #save() {
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(this.items, null, 2) + '\n')
    renameSync(tmp, this.file)
  }

  /** 长内容落文件目录。 */
  bodyPath(id) {
    return join(this.dir, 'broadcasts', `${id}.txt`)
  }

  /**
   * 消息对某会话是否可见：直接接收者（显式会话 ID）/ 房间成员
   * （room:<id> 且该会话在成员名单）/ 项目内（project:<路径> 且会话
   * cwd 与路径一致，跨目录不可见）。
   * @param {object} m - 消息记录。
   * @param {string} sessionId
   * @param {string} [cwd] - 查看会话的工作目录（project: 伪接收者判断用）。
   */
  visibleTo(m, sessionId, cwd) {
    if (m.recipients.includes(sessionId)) return true
    for (const r of m.recipients) {
      const ref = parseRef(r)
      if (ref.type === 'room') {
        const room = this.rooms.get(ref.value)
        if (room && room.members.includes(sessionId)) return true
      } else if (ref.type === 'project') {
        if (cwd && cwd === ref.value) return true
      }
    }
    return false
  }

  /**
   * 发送一条广播消息。
   * @param {object} req - { sender, recipients, content, subject? }
   *   recipients 可混用：显式会话 ID / `room:<群id>`（发送者须是成员）/
   *   `project:<绝对路径>`（该目录内所有会话可见）。
   *   subject 可选：主题（列表只显示主题+简介，像邮件收件箱）；缺省取
   *   内容首行（去 markdown 符号后截 40 字符）。
   * @returns {{ok:boolean, message:string, item?:object}}
   */
  send(req) {
    const sender = String(req.sender ?? '').trim()
    if (!sender) return { ok: false, message: '发送方会话 id 不能为空' }
    let recipients = Array.isArray(req.recipients)
      ? [...new Set(req.recipients.map((r) => String(r).trim()).filter((r) => r !== ''))]
      : []
    if (recipients.length === 0) return { ok: false, message: 'recipients 必须是非空数组（会话 ID 或 room:/project: 伪接收者）' }
    // 伪接收者校验 + 规范化存储（裸房间 id room-xxx 统一存 room:<id> 形式，
    // 便于显示与后续判断一致）：房间必须存在且发送者是成员；project: 路径非空
    const normalized = []
    for (const r of recipients) {
      const ref = parseRef(r)
      if (ref.type === 'room') {
        const room = this.rooms.get(ref.value)
        if (!room) return { ok: false, message: `房间 ${r} 不存在（先 room-create，或向创建者确认房间 id 后 room-join）` }
        if (room.status === 'dissolved') return { ok: false, message: `房间「${room.name}」已解散，无法发消息` }
        if (!room.members.includes(sender)) {
          return { ok: false, message: `你不是房间「${room.name}」的成员（先 room-join 加入）` }
        }
        normalized.push(`room:${ref.value}`)
        this.rooms.touch(ref.value) // 发消息到房间 = 房间活动（刷新清理计时）
      } else if (ref.type === 'project') {
        if (ref.value === '') return { ok: false, message: 'project: 后必须跟工作目录绝对路径，如 project:/Volumes/data/proj' }
        normalized.push(`project:${ref.value}`)
      } else {
        normalized.push(r)
      }
    }
    recipients = normalized
    const content = String(req.content ?? '').trim()
    if (!content) return { ok: false, message: '消息内容不能为空' }
    // 主题：显式传入优先；缺省取内容首行（strip markdown 标题符号）截 40 字符
    const subject = String(req.subject ?? '').trim() !== ''
      ? String(req.subject).trim()
      : content.split('\n').map((l) => l.trim()).find((l) => l !== '')?.replace(/^[#>*\-`\s]+/, '').slice(0, 40) ?? ''
    const id = newMessageId()
    // 超长内容落文件：content 存「文件路径 + 首行预览」（接收方 read 时给全文）
    let stored = content
    let bodyFile = null
    if (content.length > INLINE_MAX) {
      bodyFile = this.bodyPath(id)
      mkdirSync(dirname(bodyFile), { recursive: true })
      writeFileSync(bodyFile, content, 'utf8')
      const preview = content.slice(0, 200)
      stored = `（完整内容已写入文件 ${bodyFile}）\n${preview}`
    }
    const msg = {
      id,
      sender,
      recipients,
      subject,
      content: stored,
      bodyFile,
      createdAt: Date.now(),
      readBy: [],
    }
    this.items.push(msg)
    this.#save()
    // 注意：消息对象放 item 字段（message 字段被 DSH 工具 schema 要求为
    // string——曾误用 message: msg 覆盖提示文本导致工具输出校验失败）
    return { ok: true, message: `广播已发送（${recipients.length} 个接收目标）`, item: msg }
  }

  /**
   * 当前会话可见的消息：**接收者只返回未读**（read 即消费，读后从列表
   * 消失——消息传递语义）；发送者返回自己发出的（留痕，可确认/删除）。
   * 可见性含伪接收者：房间成员 / 项目内会话。
   * @param {string} sessionId
   * @param {string} [cwd] - 查看会话的工作目录（project: 判断用）。
   * @returns {object[]} 按 createdAt 倒序。
   */
  forSession(sessionId, cwd) {
    if (!sessionId) return []
    return this.items
      .filter((m) => {
        if (this.visibleTo(m, sessionId, cwd)) {
          // 伪接收者消息（房间/项目）是共享讨论：**已读也保留在列表**（回看
          // 需要，unread 标记区分）；显式接收者消息只显示未读（read 即消费）
          const hasPseudo = m.recipients.some((r) => isPseudo(r))
          if (hasPseudo) return true
          return !m.readBy.includes(sessionId)
        }
        return m.sender === sessionId // 发送者视角：自己发的
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 当前会话未读消息数（快照「会话广播」提示用；含伪接收者可见）。 */
  unreadCount(sessionId, cwd) {
    if (!sessionId) return 0
    return this.items.filter((m) => this.visibleTo(m, sessionId, cwd) && !m.readBy.includes(sessionId)).length
  }

  /**
   * 读消息全文并标记已读（幂等；可见者才可读，防止窥探他人消息）。
   * **自动删除仅限纯显式接收者消息**（全部显式接收者已读后删除）：
   * 含伪接收者（room:/project:）的消息是共享讨论/公告，不自动删——
   * 保留给成员回看，30 天清理 + 手动 delete。
   * @param {string} id
   * @param {string} sessionId
   * @param {string} [cwd]
   * @returns {{ok:boolean, message:string, item?:object}}
   */
  read(id, sessionId, cwd) {
    const msg = this.items.find((m) => m.id === id)
    if (!msg) return { ok: false, message: `消息 ${id} 不存在` }
    if (!this.visibleTo(msg, sessionId, cwd)) return { ok: false, message: '该消息对当前会话不可见，无法读取' }
    // 长内容：先取全文（消息可能随后被自动删除，文件会被一并清理）
    let content = msg.content
    if (msg.bodyFile) {
      try {
        content = readFileSync(msg.bodyFile, 'utf8')
      } catch { /* 文件缺失：退回内联预览 */ }
    }
    // 已读标记（幂等）
    if (!msg.readBy.includes(sessionId)) {
      msg.readBy.push(sessionId)
      // 纯显式接收者消息：全员已读 = 使命完成 → 自动删除（读即消费）；
      // 伪接收者消息不删（共享语义），30 天 prune 兜底
      const allDirect = msg.recipients.every((r) => !isPseudo(r))
      if (allDirect) {
        const allRead = msg.recipients.every((r) => msg.readBy.includes(r))
        if (allRead) {
          const index = this.items.indexOf(msg)
          if (index >= 0) this.items.splice(index, 1)
          if (msg.bodyFile) {
            try { rmSync(msg.bodyFile, { force: true }) } catch { /* 忽略 */ }
          }
        }
      }
      this.#save()
    }
    return { ok: true, message: `消息 ${msg.id}（${msg.sender} → ${msg.recipients.join(',')}）`, item: { ...msg, content } }
  }

  /**
   * 删除消息（发送方或可见者——直接接收者/房间成员/项目内会话可删；
   * 顺带清理长内容文件）。
   * @param {string} id
   * @param {string} sessionId
   * @param {string} [cwd]
   * @returns {{ok:boolean, message:string}}
   */
  remove(id, sessionId, cwd) {
    const index = this.items.findIndex((m) => m.id === id)
    if (index < 0) return { ok: false, message: `消息 ${id} 不存在` }
    const msg = this.items[index]
    if (msg.sender !== sessionId && !this.visibleTo(msg, sessionId, cwd)) {
      return { ok: false, message: '只有发送方或接收方可删除该消息' }
    }
    this.items.splice(index, 1)
    this.#save()
    if (msg.bodyFile) {
      try { rmSync(msg.bodyFile, { force: true }) } catch { /* 忽略 */ }
    }
    return { ok: true, message: `已删除消息 ${id}` }
  }

  /**
   * 超管删除任意消息（管理面板用；不走 remove 的成员权限检查）。
   * @param {string} id
   * @returns {{ok:boolean, message:string}}
   */
  adminRemove(id) {
    const index = this.items.findIndex((m) => m.id === id)
    if (index < 0) return { ok: false, message: `消息 ${id} 不存在` }
    const [msg] = this.items.splice(index, 1)
    this.#save()
    if (msg.bodyFile) {
      try { rmSync(msg.bodyFile, { force: true }) } catch { /* 忽略 */ }
    }
    return { ok: true, message: `已删除消息 ${id}` }
  }

  /**
   * 清理超过 30 天的消息（含长内容文件）。
   * @returns {number} 清理条数。
   */
  prune() {
    const cutoff = Date.now() - RETENTION_MS
    let removed = 0
    const removeMsg = (m) => {
      if (m.bodyFile) {
        try { rmSync(m.bodyFile, { force: true }) } catch { /* 忽略 */ }
      }
      removed += 1
    }
    // 1) 消息清理：30 天前的消息删除（含长内容文件）
    const stale = this.items.filter((m) => m.createdAt < cutoff)
    if (stale.length > 0) {
      this.items = this.items.filter((m) => m.createdAt >= cutoff)
      stale.forEach(removeMsg)
    }
    // 2) 房间清理：已解散房间按 dissolvedAt、活动房间按 30 天无活动
    //    （lastActiveAt）清理——连同引用它的消息（讨论作废，消息一并清）
    const staleRooms = Object.values(this.rooms.rooms)
      .filter((r) => (r.status === 'dissolved' ? (r.dissolvedAt ?? r.createdAt) : (r.lastActiveAt ?? r.createdAt)) < cutoff)
    for (const room of staleRooms) {
      delete this.rooms.rooms[room.id] // 真删（prune 为最终清理，不再保留追溯）
      const ref = `room:${room.id}`
      const doomed = this.items.filter((m) => m.recipients.includes(ref))
      this.items = this.items.filter((m) => !m.recipients.includes(ref))
      doomed.forEach(removeMsg)
    }
    if (stale.length > 0 || staleRooms.length > 0) this.#save()
    return removed
  }
}

/**
 * de_broadcast 工具定义（独立模块：由 installBroadcast 注册，不依赖
 * COI 调度器）。execute 用 exec.agent.session.id 自动取当前会话 ID——
 * sender 服务端自动填，AI 无需知道自己的 ID。
 * @param {BroadcastStore} broadcast
 * @returns {object} 工具定义（ctx.tools.register 可直接消费）。
 */
export function messageToolDefinition(broadcast, presence, memoryDir) {
  // 成员显示名（系统通知文案/发件人显示共用）：别名优先（读
  // aliases.json），无别名截短 ID——通知里"谁"一目了然
  const displayMember = (sid) => {
    const aliases = memoryDir ? readAliases(memoryDir) : {}
    const alias = aliases[sid]
    const short = sid.length > 12 ? `${sid.slice(0, 12)}…` : sid
    return alias !== undefined ? `${alias}（${short}）` : short
  }
  // 统一日期时间格式：YYYY-MM-DD HH:mm:ss（精确到秒）。
  // 两处用途：①render 输出最前面的「当前时间」锚点（模型判断消息
  // 新旧的关键参照，实时取调用时刻）；②每条消息/活跃时间的事件时间
  // （与锚点同格式，模型一眼对比就知道哪些是以前发生的）
  const pad2 = (n) => String(n).padStart(2, '0')
  const fmtDateTime = (ts) => {
    const d = new Date(ts)
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  }
  return {
    name: 'de_broadcast',
    description: '会话广播：DSH 会话之间传递消息（独立模块，开关见记忆 Tab 运行时配置「会话广播」）。send：给其他会话发消息，recipients 传**接收方会话 ID 数组**（用户会告诉你对方的会话 ID；支持同时发给多个会话），content 为消息内容（超长自动写文件），subject 为主题（可选，缺省取内容首行）；**伪接收者（仅用户明确要求时用，默认一对一不要擅自扩大发送范围）**：recipients 可混入 room:<群id>（房间内所有成员可见——聊天室，跨工作目录，成员用 room-create/join/leave 管理；发送者须是成员）与 project:<绝对路径>（该目录内所有会话可见）。list：列出当前会话的消息（**收件箱式：每条只显示主题+简短简介，像邮件列表**；可选 **type 参数**：unread=只显示未读（**缺省**，收件箱视角省上下文）、all=全部（含已读的房间/项目消息与历史）、read=只看已读回看；显式接收者消息 read 后自动删除，房间/项目消息保留 30 天供回看）；read：查看消息全文并标记已读（快照「会话广播」提示随之消失；**批量：ids 传多个消息 id 数组一次读完**，返回全部全文，不可见/不存在自动跳过——AI 清空收件箱不必逐个调用）；delete：删除消息（发送方或可见者）。房间管理：room-create（name 可选，创建者自动入房）/ room-join（拿房间 id 加入）/ room-leave（退出——**最后一人退出 = 房间解散**，记录保留可追溯）/ room-list（我所在的房间，**缺省只显示未解散**；可选 roomType=all 含已解散、query 房间名搜索、sinceDays 最近 N 天、page/pageSize 分页，返回 total 供翻页）/ room-rm（解散房间，仅创建者——向全体成员发系统通知）/ room-kick（踢出成员，仅创建者——向被踢者发系统通知）。**presence（在线状态查询）**：传 roomId 列出房间成员谁在线（running=正在生成可等它/发消息它回合内可见）、谁已结束回合（idle=等用户驱动，相当于离线，**不要傻等**）；传 sessionId 查单个会话；返回 lastActiveAt 供判断多久没动。**状态变化自动通知**：房间成员 running⇄idle 切换（开始干活/干完闲了）会**自动注入快照「房间动态」段**（成员下一次生成时直接看到，不用手动 read）——**要据此行动**：idle 表示已结束回合、要它干活需 wake；running 表示正在生成、可直接发消息它回合内可见。不需要手动发，也不要把别人的状态变化当普通消息发；**加入/离开房间**则发收件箱系统通知（sender=system，read 一次即删）。**每次输出最前面附当前时间（精确到秒）**，用它与各条消息自带的事件时间对比即可判断新旧——旧消息（如昨天的状态通知）不是刚发生的，注意时效。**消息只对接收方/房间成员/项目内会话可见（定点注入提示）**，其他会话无感知。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['send', 'list', 'read', 'delete', 'room-create', 'room-join', 'room-leave', 'room-list', 'room-rm', 'room-kick', 'presence'], description: 'send=发送；list=列出消息（主题+简介）；read=查看全文并标记已读；delete=删除；room-create=创建房间；room-join=加入房间；room-leave=退出房间；room-list=我所在的房间；room-rm=解散房间（仅创建者，通知全体）；room-kick=踢出成员（仅创建者，通知被踢者）；presence=查询会话/房间成员的在线状态' },
        recipients: { type: 'array', items: { type: 'string' }, description: 'send 必填：接收方会话 ID 数组（可混入 room:<群id> / project:<绝对路径> 伪接收者；默认一对一）' },
        subject: { type: 'string', description: 'send 可选：消息主题（列表只显示主题+简介；缺省取内容首行）' },
        content: { type: 'string', description: 'send 必填：消息内容（超长自动写文件，接收方 read 时取全文）' },
        id: { type: 'string', description: 'read/delete 必填：消息 id（read 单条用；批量请用 ids）' },
        ids: { type: 'array', items: { type: 'string' }, description: 'read 可选：**批量读取的消息 id 数组**——传多个一次读完（全部标记已读并返回全文，与单条同构；不可见/不存在自动跳过并在 message 说明），AI 清空收件箱不必逐个调用' },
        type: { type: 'string', enum: ['unread', 'all', 'read'], description: 'list 可选：unread=只显示未读（**缺省**，收件箱视角省上下文）；all=全部（含已读的房间/项目消息与历史）；read=只看已读（回看）' },
        roomId: { type: 'string', description: 'room-join/leave/rm/presence 用：房间 id（用户告知，形如 room-xxx）' },
        sessionId: { type: 'string', description: 'presence 可选：查询单个会话的在线状态（缺省配合 roomId 列出房间成员）' },
        member: { type: 'string', description: 'room-kick 必填：被踢出的成员会话 id' },
        name: { type: 'string', description: 'room-create 可选：房间名（缺省=房间 id）' },
        type: { type: 'string', enum: ['unread', 'all', 'read'], description: 'list 可选：unread=只显示未读（**缺省**，收件箱视角省上下文）；all=全部（含已读的房间/项目消息与历史）；read=只看已读（回看）' },
        query: { type: 'string', description: 'room-list 可选：房间名搜索（子串，大小写不敏感）' },
        sinceDays: { type: 'integer', description: 'room-list 可选：只显示最近 N 天创建的房间（如 7=最近一周；缺省=不限）' },
        page: { type: 'integer', description: 'room-list 可选：页码（从 1 起，缺省 1）' },
        pageSize: { type: 'integer', description: 'room-list 可选：每页条数（缺省 10，上限 50）' },
        roomType: { type: 'string', enum: ['active', 'all'], description: 'room-list 可选：active=只显示未解散房间（**缺省**）；all=含已解散（追溯用，带 status）' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                sender: { type: 'string' },
                recipients: { type: 'array', items: { type: 'string' } },
                subject: { type: 'string', description: '主题' },
                content: { type: 'string', description: 'list=简短简介；read=全文' },
                createdAt: { type: 'integer' },
                status: { type: 'string', enum: ['unread', 'read'], description: '本条消息的状态：unread=未读（快照提示还在，应 read）/ read=已读' },
                unread: { type: 'boolean', description: '当前会话是否未读（status 的布尔等价）' },
              },
              required: ['id', 'sender', 'recipients', 'subject', 'content', 'createdAt', 'status', 'unread'],
            },
          },
          rooms: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                members: { type: 'array', items: { type: 'string' } },
                createdAt: { type: 'integer' },
                status: { type: 'string', description: 'active=未解散 / dissolved=已解散（type=all 时可见）' },
              },
              required: ['id', 'name', 'members', 'createdAt', 'status'],
            },
          },
          total: { type: 'integer', description: 'room-list：符合条件的房间总数（分页前，AI 据此翻页）' },
          presence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                status: { type: 'string', description: 'running=正在生成（在线）/ idle=已结束回合（等用户驱动）/ unknown=未记录' },
                online: { type: 'boolean', description: 'running=在线；idle/unknown=不在线（不应傻等）' },
                lastActiveAt: { oneOf: [{ type: 'integer' }, { type: 'null' }], description: '最后活跃时间戳（null=未记录）' },
              },
              required: ['sessionId', 'status', 'online', 'lastActiveAt'],
            },
          },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => {
        // ⏰ 当前时间锚点：实时取**调用工具的那一刻**（不是事件时间），
        // 精确到秒，放在输出最前面——模型拿它对比每条消息的事件时间
        // 就知道哪些是以前发生的（如昨天的状态通知），不会误判"刚发生"。
        // 只在此刻生成一次：不占快照、不破坏快照 diff/前缀缓存
        const nowLine = `⏰ 当前时间：${fmtDateTime(Date.now())}`
        if (value.messages !== undefined) {
          const lines = value.messages.map((m) => {
            // 收件箱式行：事件时间精确到秒（与当前时间锚点同格式），
            // 「来自 X → 收件人：…」可读标注（谁发给谁的直观化）：
            // 显式会话 ID 原样、room:→房间名、project:→路径
            const when = fmtDateTime(m.createdAt)
            const to = (m.recipients ?? []).map((r) => {
              if (typeof r === 'string' && (r.startsWith('room:') || /^room-[0-9a-z-]+$/.test(r))) {
                const rid = r.startsWith('room:') ? r.slice(5) : r
                const room = broadcast.rooms.get(rid)
                return `房间「${room && room.name ? room.name : rid}」`
              }
              if (typeof r === 'string' && r.startsWith('project:')) return `项目「${r.slice(8)}」`
              return r
            }).join(', ')
            // 发件人显示：系统=「系统」；否则会话别名优先（别名（短ID））
            let from
            if (m.sender === 'system') {
              from = '系统'
            } else {
              from = displayMember(m.sender)
            }
            const head = `${m.unread ? '📨' : '📄'} ${m.id}【${m.subject}】来自 ${from} → 收件人：${to} ${when}`
            const body = String(m.content ?? '')
            return body !== '' ? `${head}\n${body}` : head
          })
          return [{ type: 'text', text: `${nowLine}\n${value.message}\n${lines.join('\n\n')}` }]
        }
        if (value.presence !== undefined) {
          const lines = value.presence.map((p) => {
            const mark = p.online ? '🟢' : '⚪'
            const when = p.lastActiveAt ? fmtDateTime(p.lastActiveAt) : '—'
            return `${mark} ${p.sessionId} ${p.status}（${p.online ? '在线' : '不在线'}）最后活跃 ${when}`
          })
          return [{ type: 'text', text: `${nowLine}\n${value.message}\n${lines.join('\n')}` }]
        }
        if (value.rooms !== undefined) {
          const lines = value.rooms.map((r) => `🛠 ${r.id}【${r.name}】成员 ${r.members.length} 人`)
          return [{ type: 'text', text: `${nowLine}\n${value.message}\n${lines.join('\n')}` }]
        }
        return [{ type: 'text', text: `${value.ok ? '✅' : '❌'} ${value.message}` }]
      },
    },
    execute: (args, exec) => {
      const sessionId = exec?.agent?.session?.id
      const cwd = exec?.agent?.session?.header?.cwd // project: 伪接收者判断用
      const action = args.action
      // 老消息无 subject 字段：兜底取内容首行（strip markdown 符号，截 40 字符）
      const subjectOf = (m) => {
        if (m.subject !== undefined && m.subject !== '') return m.subject
        const first = String(m.content ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '')
        return first !== undefined ? first.replace(/^[#>*\-`\s]+/, '').slice(0, 40) : ''
      }
      if (action === 'send') {
        // 只回传 ok/message（store 的 item 字段不在输出 schema 内，
        // additionalProperties:false 下多字段会被模型 API 拒绝）
        const result = broadcast.send({ sender: sessionId, recipients: args.recipients, content: args.content, subject: args.subject })
        return { ok: result.ok, message: result.message }
      }
      if (action === 'list') {
        // type 过滤（AI 高频场景是"查有没有未读"——缺省只看未读，省上下文）：
        //   unread=只显示未读（收件箱视角）；all=全部（含已读的房间/项目
        //   消息与历史）；read=只看已读（房间/项目消息回看）
        const type = args.type ?? 'unread'
        const isUnread = (m) => broadcast.visibleTo(m, sessionId, cwd) && !m.readBy.includes(sessionId)
        const items = broadcast.forSession(sessionId, cwd)
          .filter((m) => {
            if (type === 'unread') return isUnread(m)
            if (type === 'read') return m.readBy.includes(sessionId)
            return true // all
          })
          .map((m) => {
            const unread = isUnread(m)
            return {
              id: m.id,
              sender: m.sender,
              recipients: m.recipients,
              subject: subjectOf(m),
              content: String(m.content ?? '').slice(0, 60), // 收件箱式：只给简短简介
              createdAt: m.createdAt,
              // 每条的状态（AI 判断读不读的直接依据，不用靠记忆猜）：
              // unread=未读（快照提示还在）/ read=已读
              status: unread ? 'unread' : 'read',
              unread,
            }
          })
        const label = type === 'unread' ? '未读' : type === 'read' ? '已读' : '全部'
        return { ok: true, message: `消息（${label} ${items.length} 条）`, messages: items }
      }
      if (action === 'read') {
        // 单条（id）或批量（ids 数组）——AI 清空收件箱高频场景：传多个
        // id 一次读完，全部标记已读并返回全文（每条与单条 read 同构）。
        // 宽容处理：不可见/不存在的跳过（去重），message 里说明跳过数。
        const idList = Array.isArray(args.ids) && args.ids.length > 0
          ? [...new Set(args.ids)]
          : (args.id ? [args.id] : [])
        if (idList.length === 0) return { ok: false, message: 'read 必填 id 或 ids（消息 id）' }
        const results = []
        let skipped = 0
        for (const mid of idList) {
          const result = broadcast.read(mid, sessionId, cwd)
          if (!result.ok) { skipped += 1; continue }
          results.push({
            id: result.item.id,
            sender: result.item.sender,
            recipients: result.item.recipients,
            subject: subjectOf(result.item),
            content: result.item.content, // 全文（render 不再截断）
            createdAt: result.item.createdAt,
            status: 'read', // 刚读完必然已读（schema 要求，与 list 同构）
            unread: false,
          })
        }
        if (results.length === 0) {
          return { ok: false, message: skipped > 0 ? `读取失败：${skipped} 条不可见或不存在` : '没有可读消息' }
        }
        return {
          ok: true,
          message: `已读取 ${results.length} 条${skipped > 0 ? `，跳过 ${skipped} 条（不可见/不存在）` : ''}`,
          messages: results,
        }
      }
      if (action === 'delete') {
        return broadcast.remove(args.id, sessionId, cwd)
      }
      // rooms 输出只允许 schema 声明的 id/name/members/createdAt——剥离
      // createdBy 等内部字段（P0：曾回传完整 room 对象，additionalProperties
      // 冲突会被模型 API 拒绝）
      const roomView = (r) => ({ id: r.id, name: r.name, members: r.members, createdAt: r.createdAt, status: r.status ?? 'active' })
      if (action === 'room-create') {
        const result = broadcast.rooms.create({ name: args.name, createdBy: sessionId })
        return { ok: result.ok, message: result.message, rooms: result.ok ? [roomView(result.room)] : undefined }
      }
      if (action === 'room-join') {
        const result = broadcast.rooms.join(args.roomId, sessionId)
        // 新成员加入 → 系统通知其他成员（"谁来了"主动感知；recipients
        // 用**显式会话 ID** 数组——read 一次即删，实时协作不留历史；
        // 若误用 room: 伪接收者会保留 30 天，语义不符）
        if (result.ok && result.room) {
          const others = result.room.members.filter((m) => m !== sessionId)
          if (others.length > 0) {
            const who = displayMember(sessionId)
            broadcast.send({
              sender: 'system',
              recipients: others,
              subject: `🔔 ${who} 加入了房间「${result.room.name}」`,
              content: `${who}（${sessionId}）加入了房间「${result.room.name}」，现有成员 ${result.room.members.length} 人。`,
            })
          }
        }
        return { ok: result.ok, message: result.message, rooms: result.ok && result.room ? [roomView(result.room)] : undefined }
      }
      if (action === 'room-leave') {
        const result = broadcast.rooms.leave(args.roomId, sessionId)
        // 成员离开 → 系统通知剩余成员（最后一人退出 = 房间解散时
        // result.room 为 undefined、无剩余接收者 → 不通知）
        if (result.ok && result.room && result.room.members.length > 0) {
          const who = displayMember(sessionId)
          broadcast.send({
            sender: 'system',
            recipients: result.room.members,
            subject: `🔔 ${who} 离开了房间「${result.room.name}」`,
            content: `${who}（${sessionId}）退出了房间「${result.room.name}」（剩 ${result.room.members.length} 人）。`,
          })
        }
        return { ok: result.ok, message: result.message, rooms: result.ok && result.room ? [roomView(result.room)] : undefined }
      }
      if (action === 'room-list') {
        // 筛选/分页（房间多了以后列表失控——分页 + 名字搜索 + 最近 N 天；
        // 缺省只显示未解散房间，已解散的追溯用 roomType='all'）
        const result = broadcast.rooms.list(sessionId, {
          type: args.roomType,
          query: args.query,
          sinceDays: args.sinceDays,
          page: args.page,
          pageSize: args.pageSize,
        })
        const label = result.total > 0 ? `房间（共 ${result.total} 个，本页 ${result.rooms.length} 个）` : '房间（0 个）'
        return { ok: true, message: label, rooms: result.rooms.map(roomView), total: result.total }
      }
      if (action === 'room-rm') {
        // 软删除（标记 dissolved 供面板追溯）+ 系统通知全体成员
        // （recipients 用显式会话 ID——房间解散后 room: 引用会失效）。
        // 注意：get 返回对象引用，dissolve 原地改 status——通知条件必须用
        // **操作前的快照**（否则 before.status 也被改成 dissolved 而不发）
        const before = broadcast.rooms.get(args.roomId)
        const snap = before ? { name: before.name, members: [...before.members], status: before.status } : null
        const result = broadcast.rooms.dissolve(args.roomId, sessionId)
        if (result.ok && snap && snap.status !== 'dissolved' && snap.members.length > 0) {
          broadcast.send({ sender: 'system', recipients: snap.members, content: `房间「${snap.name}」已解散（由创建者操作）。房间内消息不再可见。`, subject: `房间「${snap.name}」已解散` })
        }
        return { ok: result.ok, message: result.message }
      }
      if (action === 'room-kick') {
        const room = broadcast.rooms.get(args.roomId)
        if (!room) return { ok: false, message: `房间 ${args.roomId} 不存在` }
        if (room.createdBy !== sessionId) return { ok: false, message: '只有创建者可以踢人' }
        const result = broadcast.rooms.kick(args.roomId, args.member)
        // 系统通知被踢者（可感知：踢出不是无声消失）
        if (result.ok) {
          broadcast.send({ sender: 'system', recipients: [args.member], content: `你已被移出房间「${result.room ? result.room.name : args.roomId}」（由创建者操作）。`, subject: `你已被移出房间「${result.room ? result.room.name : args.roomId}」` })
        }
        return { ok: result.ok, message: result.message }
      }
      if (action === 'presence') {
        // 在线状态查询：roomId → 房间成员列表；sessionId → 单个会话
        if (presence === undefined) return { ok: false, message: '在线状态追踪未启用' }
        if (args.sessionId) {
          return { ok: true, message: `会话 ${args.sessionId} 状态`, presence: [presence.get(args.sessionId)] }
        }
        const room = broadcast.rooms.get(args.roomId)
        if (!room) return { ok: false, message: `房间 ${args.roomId} 不存在` }
        const list = presence.roomStatus(room)
        return { ok: true, message: `房间「${room.name}」成员在线状态（${list.filter((p) => p.online).length}/${list.length} 在线）`, presence: list }
      }
      return { ok: false, message: `未知 action "${action}"` }
    },
  }
}
