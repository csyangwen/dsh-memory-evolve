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
 * 房间 = 群 id → { id, name, members: [会话ID...], createdAt, createdBy }。
 * 成员是**会话 ID 数组**（全局唯一），与工作目录无关——**天然支持跨工作
 * 目录协作**（A 在 /p1、B 在 /p2 可同群）。
 * 消息引用房间用伪接收者 `room:<id>`（BroadcastStore 按成员判断可见），
 * 发送方无需知道成员名单；加入/退出由成员自己操作。
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

  /** 按 id 取房间；不存在返回 undefined。 */
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
      createdBy: creator,
    }
    this.rooms[id] = room
    this.#save()
    return { ok: true, message: `房间「${room.name}」已创建（你是成员；告诉其他人房间 id ${id} 让它们 room-join）`, room }
  }

  /** 加入房间（幂等）。 */
  join(id, sessionId) {
    const room = this.rooms[id]
    if (!room) return { ok: false, message: `房间 ${id} 不存在（请向创建者确认房间 id）` }
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
      delete this.rooms[id]
      this.#save()
      return { ok: true, message: `已退出，房间 ${id} 无成员已删除` }
    }
    this.#save()
    return { ok: true, message: `已退出房间「${room.name}」（剩 ${room.members.length} 人）`, room }
  }

  /** 我所在的房间列表（按创建时间倒序）。 */
  list(sessionId) {
    if (!sessionId) return []
    return Object.values(this.rooms)
      .filter((r) => r.members.includes(sessionId))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 删除房间（仅创建者）。 */
  remove(id, sessionId) {
    const room = this.rooms[id]
    if (!room) return { ok: false, message: `房间 ${id} 不存在` }
    if (room.createdBy !== sessionId) return { ok: false, message: '只有创建者可以删除房间' }
    delete this.rooms[id]
    this.#save()
    return { ok: true, message: `房间「${room.name}」已删除` }
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
    // 2) 房间清理：30 天无活动（lastActiveAt；从未拉人/无人再说话都算）
    //    的房间删除——连同引用它的消息（房间解散 = 讨论作废，消息一并清）
    const staleRooms = Object.values(this.rooms.rooms)
      .filter((r) => (r.lastActiveAt ?? r.createdAt) < cutoff)
    for (const room of staleRooms) {
      this.rooms.remove(room.id, room.createdBy)
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
export function messageToolDefinition(broadcast) {
  return {
    name: 'de_broadcast',
    description: '会话广播：DSH 会话之间传递消息（独立模块，开关见记忆 Tab 运行时配置「会话广播」）。send：给其他会话发消息，recipients 传**接收方会话 ID 数组**（用户会告诉你对方的会话 ID；支持同时发给多个会话），content 为消息内容（超长自动写文件），subject 为主题（可选，缺省取内容首行）；**伪接收者（仅用户明确要求时用，默认一对一不要擅自扩大发送范围）**：recipients 可混入 room:<群id>（房间内所有成员可见——聊天室，跨工作目录，成员用 room-create/join/leave 管理；发送者须是成员）与 project:<绝对路径>（该目录内所有会话可见）。list：列出当前会话的消息（**收件箱式：每条只显示主题+简短简介，像邮件列表**；显式接收者消息 read 后自动删除，房间/项目消息保留 30 天供回看）；read：查看消息全文并标记已读（快照「会话广播」提示随之消失）；delete：删除消息（发送方或可见者）。房间管理：room-create（name 可选，创建者自动入房）/ room-join（拿房间 id 加入）/ room-leave（退出）/ room-list（我所在的房间）/ room-rm（解散房间，仅创建者）。**消息只对接收方/房间成员/项目内会话可见（定点注入提示）**，其他会话无感知。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['send', 'list', 'read', 'delete', 'room-create', 'room-join', 'room-leave', 'room-list', 'room-rm'], description: 'send=发送；list=列出消息（主题+简介）；read=查看全文并标记已读；delete=删除；room-create=创建房间；room-join=加入房间；room-leave=退出房间；room-list=我所在的房间；room-rm=解散房间（仅创建者）' },
        recipients: { type: 'array', items: { type: 'string' }, description: 'send 必填：接收方会话 ID 数组（可混入 room:<群id> / project:<绝对路径> 伪接收者；默认一对一）' },
        subject: { type: 'string', description: 'send 可选：消息主题（列表只显示主题+简介；缺省取内容首行）' },
        content: { type: 'string', description: 'send 必填：消息内容（超长自动写文件，接收方 read 时取全文）' },
        id: { type: 'string', description: 'read/delete 必填：消息 id' },
        roomId: { type: 'string', description: 'room-join/leave 必填：房间 id（用户告知，形如 room-xxx）' },
        name: { type: 'string', description: 'room-create 可选：房间名（缺省=房间 id）' },
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
                unread: { type: 'boolean', description: '当前会话是否未读' },
              },
              required: ['id', 'sender', 'recipients', 'subject', 'content', 'createdAt', 'unread'],
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
              },
              required: ['id', 'name', 'members', 'createdAt'],
            },
          },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => {
        if (value.messages !== undefined) {
          const lines = value.messages.map((m) => {
            // 收件箱式行：年份+月日+时分，主题 + 简介/全文（数据层已按场景截好）
            const when = new Date(m.createdAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
            const head = `${m.unread ? '📨' : '📄'} ${m.id} ${m.sender} → ${m.recipients.join(',')} ${when}\n【${m.subject}】`
            const body = String(m.content ?? '')
            return body !== '' ? `${head}\n${body}` : head
          })
          return [{ type: 'text', text: `${value.message}\n${lines.join('\n\n')}` }]
        }
        if (value.rooms !== undefined) {
          const lines = value.rooms.map((r) => `🛠 ${r.id}【${r.name}】成员 ${r.members.length} 人`)
          return [{ type: 'text', text: `${value.message}\n${lines.join('\n')}` }]
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
        const items = broadcast.forSession(sessionId, cwd).map((m) => ({
          id: m.id,
          sender: m.sender,
          recipients: m.recipients,
          subject: subjectOf(m),
          content: String(m.content ?? '').slice(0, 60), // 收件箱式：只给简短简介
          createdAt: m.createdAt,
          unread: broadcast.visibleTo(m, sessionId, cwd) && !m.readBy.includes(sessionId),
        }))
        return { ok: true, message: `消息（${items.length} 条）`, messages: items }
      }
      if (action === 'read') {
        const result = broadcast.read(args.id, sessionId, cwd)
        if (!result.ok) return { ok: false, message: result.message }
        return {
          ok: true,
          message: result.message,
          messages: [{
            id: result.item.id,
            sender: result.item.sender,
            recipients: result.item.recipients,
            subject: subjectOf(result.item),
            content: result.item.content, // 全文（render 不再截断）
            createdAt: result.item.createdAt,
            unread: false,
          }],
        }
      }
      if (action === 'delete') {
        return broadcast.remove(args.id, sessionId, cwd)
      }
      // rooms 输出只允许 schema 声明的 id/name/members/createdAt——剥离
      // createdBy 等内部字段（P0：曾回传完整 room 对象，additionalProperties
      // 冲突会被模型 API 拒绝）
      const roomView = (r) => ({ id: r.id, name: r.name, members: r.members, createdAt: r.createdAt })
      if (action === 'room-create') {
        const result = broadcast.rooms.create({ name: args.name, createdBy: sessionId })
        return { ok: result.ok, message: result.message, rooms: result.ok ? [roomView(result.room)] : undefined }
      }
      if (action === 'room-join') {
        const result = broadcast.rooms.join(args.roomId, sessionId)
        return { ok: result.ok, message: result.message, rooms: result.ok && result.room ? [roomView(result.room)] : undefined }
      }
      if (action === 'room-leave') {
        const result = broadcast.rooms.leave(args.roomId, sessionId)
        return { ok: result.ok, message: result.message, rooms: result.ok && result.room ? [roomView(result.room)] : undefined }
      }
      if (action === 'room-list') {
        const list = broadcast.rooms.list(sessionId)
        return { ok: true, message: `房间（${list.length} 个）`, rooms: list.map(roomView) }
      }
      if (action === 'room-rm') {
        const result = broadcast.rooms.remove(args.roomId, sessionId)
        return { ok: result.ok, message: result.message }
      }
      return { ok: false, message: `未知 action "${action}"` }
    },
  }
}
