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

/**
 * @param {string} dir - 数据目录（broadcastDataDir，独立于 coiDataDir；
 *   null → <memoryDir>/broadcast）。
 */
export class BroadcastStore {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'broadcast.json')
    this.items = this.#load()
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
   * 发送一条广播消息。
   * @param {object} req - { sender, recipients, content, subject? }
   *   subject 可选：主题（列表只显示主题+简介，像邮件收件箱）；缺省取
   *   内容首行（去 markdown 符号后截 40 字符）。
   * @returns {{ok:boolean, message:string, item?:object}}
   */
  send(req) {
    const sender = String(req.sender ?? '').trim()
    if (!sender) return { ok: false, message: '发送方会话 id 不能为空' }
    const recipients = Array.isArray(req.recipients)
      ? [...new Set(req.recipients.map((r) => String(r).trim()).filter((r) => r !== ''))]
      : []
    if (recipients.length === 0) return { ok: false, message: 'recipients 必须是非空会话 id 数组' }
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
    return { ok: true, message: `广播已发送（${recipients.length} 个接收会话）`, item: msg }
  }

  /**
   * 当前会话可见的消息：**接收者只返回未读**（read 即消费，读后从列表
   * 消失——消息传递语义）；发送者返回自己发出的（留痕，可确认/删除）。
   * @param {string} sessionId
   * @returns {object[]} 按 createdAt 倒序。
   */
  forSession(sessionId) {
    if (!sessionId) return []
    return this.items
      .filter((m) => {
        if (m.recipients.includes(sessionId)) {
          // 接收者视角：只显示未读（readBy 含自己 = 已消费，不再列出）
          return !m.readBy.includes(sessionId)
        }
        return m.sender === sessionId // 发送者视角：自己发的
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 当前会话未读消息数（快照「会话广播」提示用）。 */
  unreadCount(sessionId) {
    if (!sessionId) return 0
    return this.items.filter((m) => m.recipients.includes(sessionId) && !m.readBy.includes(sessionId)).length
  }

  /**
   * 读消息全文并标记已读（幂等；接收方会话才可读，防止窥探他人消息）。
   * @param {string} id
   * @param {string} sessionId
   * @returns {{ok:boolean, message:string, item?:object}}
   */
  read(id, sessionId) {
    const msg = this.items.find((m) => m.id === id)
    if (!msg) return { ok: false, message: `消息 ${id} 不存在` }
    if (!msg.recipients.includes(sessionId)) return { ok: false, message: '该消息不是发给当前会话的，无法读取' }
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
      // 全员已读 = 消息使命完成 → 自动删除（读即消费：单接收者=read 即删；
      // 多接收者各自读，最后一个读完触发删除——绝不提前删导致其他接收者
      // 收不到；发送者留痕随全部读完消失，广播是即时通信语义）
      const allRead = msg.recipients.every((r) => msg.readBy.includes(r))
      if (allRead) {
        const index = this.items.indexOf(msg)
        if (index >= 0) this.items.splice(index, 1)
        if (msg.bodyFile) {
          try { rmSync(msg.bodyFile, { force: true }) } catch { /* 忽略 */ }
        }
      }
      this.#save()
    }
    return { ok: true, message: `消息 ${msg.id}（${msg.sender} → ${msg.recipients.join(',')}）`, item: { ...msg, content } }
  }

  /**
   * 删除消息（发送方或任一接收方可删；顺带清理长内容文件）。
   * @param {string} id
   * @param {string} sessionId
   * @returns {{ok:boolean, message:string}}
   */
  remove(id, sessionId) {
    const index = this.items.findIndex((m) => m.id === id)
    if (index < 0) return { ok: false, message: `消息 ${id} 不存在` }
    const msg = this.items[index]
    if (msg.sender !== sessionId && !msg.recipients.includes(sessionId)) {
      return { ok: false, message: '只有发送方或接收方可以删除该消息' }
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
    const removed = this.items.filter((m) => m.createdAt < cutoff)
    if (removed.length > 0) {
      this.items = this.items.filter((m) => m.createdAt >= cutoff)
      this.#save()
      for (const msg of removed) {
        if (msg.bodyFile) {
          try { rmSync(msg.bodyFile, { force: true }) } catch { /* 忽略 */ }
        }
      }
    }
    return removed.length
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
    description: '会话广播：DSH 会话之间传递消息（独立模块，开关见记忆 Tab 运行时配置「会话广播」）。send：给其他会话发消息，recipients 传**接收方会话 ID 数组**（用户会告诉你对方的会话 ID；支持同时发给多个会话），content 为消息内容（超长自动写文件），subject 为主题（可选，缺省取内容首行）；list：列出当前会话的消息（**收件箱式：每条只显示主题+简短简介，像邮件列表**；接收方只列出未读，read 后自动删除）；read：查看消息全文并标记已读（快照「会话广播」提示随之消失）；delete：删除消息（发送方或接收方均可）。**消息只对接收方会话可见（定点注入提示）**，其他会话无感知；快照只提示未读数量，内容需用本工具查看。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['send', 'list', 'read', 'delete'], description: 'send=发送；list=列出消息（主题+简介）；read=查看全文并标记已读；delete=删除' },
        recipients: { type: 'array', items: { type: 'string' }, description: 'send 必填：接收方会话 ID 数组（用户告知；可多会话广播）' },
        subject: { type: 'string', description: 'send 可选：消息主题（列表只显示主题+简介；缺省取内容首行）' },
        content: { type: 'string', description: 'send 必填：消息内容（超长自动写文件，接收方 read 时取全文）' },
        id: { type: 'string', description: 'read/delete 必填：消息 id' },
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
        return [{ type: 'text', text: `${value.ok ? '✅' : '❌'} ${value.message}` }]
      },
    },
    execute: (args, exec) => {
      const sessionId = exec?.agent?.session?.id
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
        const items = broadcast.forSession(sessionId).map((m) => ({
          id: m.id,
          sender: m.sender,
          recipients: m.recipients,
          subject: subjectOf(m),
          content: String(m.content ?? '').slice(0, 60), // 收件箱式：只给简短简介
          createdAt: m.createdAt,
          unread: m.recipients.includes(sessionId) && !m.readBy.includes(sessionId),
        }))
        return { ok: true, message: `消息（${items.length} 条）`, messages: items }
      }
      if (action === 'read') {
        const result = broadcast.read(args.id, sessionId)
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
        return broadcast.remove(args.id, sessionId)
      }
      return { ok: false, message: `未知 action "${action}"` }
    },
  }
}
