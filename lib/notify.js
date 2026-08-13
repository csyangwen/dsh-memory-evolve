/**
 * 渠道通知模块（de_notify + de_channel_send）——**独立子模块**（用户拍板纪律：
 * 独立领域不挂别的模块下，不借其他模块的开关）。
 *
 * 功能（2026-08-10 用户拍板扩展：DSH→飞书单向发送文本/图片/文件）：
 * ① de_notify：AI 完成任务后通过 IM 渠道（一期：飞书）**主动发通知**给用户，
 *   文本走渠道 entry.send（通知语义，内容带「非对话」标注）；
 *   支持 attachments 附件（图片/文件，走渠道 entry.sendMedia 槽位）。
 * ② de_channel_send（独立开关 channelSendEnabled，默认开）：AI **主动发送**
 *   文本/图片/文件到飞书（直发语义，不带通知标注），文本/附件统一走
 *   entry.sendMedia；有 content + 附件时 content 自动作为第一条附件的说明。
 * ③ COI 完成自动通知：COI 调度模块任务终态时按 coiNotifyChannels 配置自动
 *   发送（复用 sendChannelNotify，见 lib/coi/index.js）。
 *
 * 架构（用户拍板方案 A：渠道插件全局注册表）：
 *  - 渠道插件（dsh-feishu 等，公共插件）在 apply 时把自己的主动发送
 *    能力登记到 globalThis.__dshChannelNotify（无侵入钩子，见
 *    ~/.dsh/plugins/dsh-feishu/lib/channel-registry.js 头部注释）；
 *  - 本模块工具执行时读取该注册表调用。渠道插件没装/旧版无钩子 →
 *    注册表缺项 → 如实报「渠道未注册/不支持附件」，主插件零影响；
 *  - 本模块也不依赖任何渠道插件的 cordis 服务（无静态 inject，避开
 *    "cannot get property without inject" 硬依赖问题）。
 *
 * 开关：notifyEnabled（默认关，与其他独立模块一致——注册即占模型工具
 * 列表，需要时再开）；channelSendEnabled（默认**开**，2026-08-10 用户拍板
 * 要的功能，开箱即用——de_channel_send 与 de_notify 语义不同：直发 vs 通知，
 * 开关粒度独立，互不影响）。
 *
 * ⚠️ 本模块**零依赖**渠道插件：不 import 任何渠道插件代码、不声明任何
 * 渠道 cordis 服务（公共插件不保证被安装）。读取注册表的实现直接内联
 * 在本文件（globalThis.__dshChannelNotify 与 dsh-feishu 的
 * CHANNEL_REGISTRY_KEY 约定一致）。
 */

// web 站内通知（通知模块的「web 渠道」）：落盘存储 + 宿主端 API。
// 发送内核在识别到 'web' 渠道时走内置分支写 NotificationStore（不查外部注册表）。
import { NotificationStore, installNotifyWebApi } from './notify-web.js'

/** globalThis 注册表键名（与 dsh-feishu 的 CHANNEL_REGISTRY_KEY 约定一致）。 */
const CHANNEL_REGISTRY_KEY = '__dshChannelNotify'

/** 读取当前渠道注册表（渠道插件 apply 时登记；不存在=没有渠道可用）。 */
function getRegistry() {
  return globalThis[CHANNEL_REGISTRY_KEY] ?? {}
}

/**
 * 解析发送目标：默认「最近交互的对话」（渠道插件 recentChat()），
 * 或显式 chatKey（如 "p2p:oc_xxx" / "group:oc_xxx"）。
 * @param {object} entry - 渠道注册表条目 { send, recentChat, status }。
 * @param {string} [target] - 'recent'（缺省）或 "kind:id" 显式目标。
 * @returns {{kind: string, id: string} | null} 解析失败返回 null。
 */
function resolveTarget(entry, target) {
  if (!target || target === 'recent') {
    // 默认目标：最近交互（渠道插件维护，重启后从持久化 state 兜底恢复）
    try {
      return typeof entry.recentChat === 'function' ? entry.recentChat() : null
    } catch {
      return null
    }
  }
  const sep = target.indexOf(':')
  if (sep <= 0) return null
  return { kind: target.slice(0, sep), id: target.slice(sep + 1) }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 「输入框图片→渠道」桥（2026-08-11 P1 任务，DSH 260810 快照配套）：
 * 用户在 DSH 输入框粘贴/拖入的图片，经 host 校验后持久化为 content-addressed
 * 附件（$DSH_HOME/attachments/v1/objects/），会话事件只含 ImageBlock 引用
 * （{type:'image', attachment:{attachmentId,mediaType,bytes,width,height,name?}}）。
 * 本模块把「引用本会话图片」作为附件新来源（sessionImage=true 取最近一张 /
 * attachmentId 显式引用），从本会话事件扫描 ImageBlock → attachment 服务读
 * 字节 → base64 → 复用渠道注册表 entry.sendMedia 发送。
 *
 * 授权语义与 host `session.attachment` RPC 一致：attachmentId 必须被本会话
 * 事件引用才可读（不会越权读其他会话的图）。260809 进程无 attachments 服务
 * （ctx.get 返回 undefined）→ 如实报错，不影响 path/url/base64 既有来源。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * 从会话事件里扫描所有 ImageBlock 引用（复刻 host api-proxy 的 imageInEvent：
 * 事件 data 里 content / message.content / inserted[].content /
 * assistant/chunk block-end 四个载体，含 tool-result 嵌套）。
 * @param {Array<object>} events - SessionEvent[]（agent.session.events）。
 * @returns {Array<{ref: object, role: string, time: number}>}
 *   图片引用列表（按事件顺序，旧→新；ref=ImageAttachmentRef）。
 */
export function scanSessionImageRefs(events) {
  const found = []
  if (!Array.isArray(events)) return found
  // 递归收集 content 数组里的 image block（含 tool-result 嵌套）
  const collect = (content, role, time) => {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'image' && block.attachment && typeof block.attachment === 'object') {
        found.push({ ref: block.attachment, role, time })
      } else if (block.type === 'tool-result' && Array.isArray(block.content)) {
        collect(block.content, role, time)
      }
    }
  }
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const data = event.data
    const time = typeof event.time === 'number' ? event.time : 0
    const role = event.type === 'assistant/message' ? 'assistant' : 'user'
    if (!data || typeof data !== 'object') continue
    // ① user/message 直接 content；assistant/message 的 message.content
    if (Array.isArray(data.content)) collect(data.content, role, time)
    if (data.message && Array.isArray(data.message.content)) collect(data.message.content, 'assistant', time)
    // ② inserted 数组（user 消息的插入内容载体）
    if (Array.isArray(data.inserted)) {
      for (const msg of data.inserted) {
        if (msg && Array.isArray(msg.content)) collect(msg.content, role, time)
      }
    }
    // ③ assistant/chunk 的 block-end（chunk.block 是一个完成的 block）
    if (event.type === 'assistant/chunk' && data.chunk && data.chunk.type === 'block-end' && data.chunk.block) {
      collect([data.chunk.block], 'assistant', time)
    }
  }
  return found
}

/** mediaType → 扩展名（sessionImage/attachmentId 来源 fileName 缺省推断用）。 */
const MEDIA_TYPE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * 解析「本会话图片」附件来源：扫描本会话事件 → 匹配 attachmentId（缺省取
 * 最近一张）→ attachment 服务读字节 → base64。
 * @param {object} ctx - 插件上下文（agents 已注入；attachments 动态 ctx.get）。
 * @param {string} sessionId - 当前会话 ID（来自工具执行上下文 exec.agent）。
 * @param {object} media - 附件项 {kind, sessionImage?, attachmentId?, fileName?, caption?}。
 * @returns {Promise<object>} 归一化附件 {kind:'image', base64, fileName, caption}。
 * @throws {Error} 服务缺失/会话无事件/无图片/attachmentId 未引用——如实报错。
 */
export async function resolveSessionImage(ctx, sessionId, media) {
  const attachments = ctx?.get?.('attachments')
  if (!attachments || typeof attachments.readImage !== 'function') {
    throw new Error('当前 DSH 版本无附件服务（需 260810+ 快照并重启进程），无法引用本会话图片')
  }
  const agents = ctx?.get?.('agents')
  const session = agents?.get?.(sessionId)?.session
  const events = session?.events
  if (!Array.isArray(events)) {
    throw new Error('无法读取本会话事件（会话不在本进程，或无可读事件）')
  }
  const refs = scanSessionImageRefs(events)
  let target
  if (media.attachmentId) {
    // 显式引用：必须被本会话事件引用（与 host session.attachment 授权一致）
    target = refs.find((r) => String(r.ref.attachmentId) === String(media.attachmentId))
    if (!target) throw new Error(`图片 ${media.attachmentId} 不在本会话引用中（仅能引用本会话输入框发送过的图片）`)
  } else {
    // 缺省：本会话最近一张图
    target = refs[refs.length - 1]
    if (!target) throw new Error('本会话没有图片（需先在 DSH 输入框粘贴/拖入图片发送后才有）')
  }
  const stored = await attachments.readImage(target.ref)
  const data = stored?.data
  if (!data || typeof data.byteLength !== 'number' || data.byteLength === 0) {
    throw new Error('读取图片字节失败（附件对象缺失或损坏）')
  }
  const ext = MEDIA_TYPE_EXT[target.ref.mediaType] ?? 'png'
  const base = String(target.ref.attachmentId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'img'
  return {
    kind: 'image',
    base64: Buffer.from(data).toString('base64'),
    fileName: media.fileName || target.ref.name || `${base}.${ext}`,
    caption: media.caption,
  }
}

/**
 * 附件预处理：把 attachments 里 sessionImage/attachmentId 来源解析为 base64
 * 图片附件（其他来源原样透传）。解析失败抛出（由调用方转失败回执）。
 * @param {object} ctx - 插件上下文。
 * @param {object|undefined} exec - 工具执行上下文（exec.agent.session.id=当前会话）。
 * @param {Array<object>} attachments - 原始附件列表。
 * @returns {Promise<Array<object>>} 归一化附件列表。
 */
async function resolveSessionImageAttachments(ctx, exec, attachments) {
  const needsSession = attachments.some((a) => a.sessionImage === true || a.attachmentId)
  if (!needsSession) return attachments
  const sessionId = exec?.agent?.session?.id
  if (!sessionId) {
    throw new Error('引用本会话图片需要工具调用上下文（当前会话），请通过 AI 工具调用触发')
  }
  const resolved = []
  for (const a of attachments) {
    if (a.sessionImage === true || a.attachmentId) {
      resolved.push(await resolveSessionImage(ctx, sessionId, a))
    } else {
      resolved.push(a)
    }
  }
  return resolved
}

/**
 * 发送内核（de_notify）：按 channels 遍历注册表发送，逐渠道收集结果，永不抛错。
 * @param {object} args - { channels, content?, target?, attachments? }。
 *   channels：'feishu'|'qq'|'weixin'|'wecom'|'all'（all=全部已注册渠道）。
 *   content：通知正文（走渠道 entry.send，通知语义带标注）。
 *   attachments：可选附件列表（2026-08-10 扩展），每条
 *     {kind:'image'|'file', path?|url?|base64?, fileName?, caption?}，
 *     2026-08-11 扩展 sessionImage/attachmentId（本会话图片引用，需 260810+），
 *     走渠道 entry.sendMedia 槽位（渠道插件无此槽位 → 如实报「版本不支持附件」）。
 * @param {object} [deps] - { ctx, exec }（工具调用上下文；COI 自动通知无 exec）。
 *   ctx：插件上下文（agents 已注入；attachments 动态 ctx.get，260809 无则报错）。
 *   exec：工具执行上下文（exec.agent.session.id=当前会话，sessionImage 引用必需）。
 * @returns {{ results: Array, summary: string }}
 */
export async function sendChannelNotify(args, deps = {}) {
  const { ctx, exec, webStore } = deps
  const registry = getRegistry()
  // web 是内置渠道（本插件自实现，不查外部注册表）：'all' 展开 = 外部已注册
  // 渠道 + web（web 模块启用时）；单渠道 'web' 直接进 wanted。
  const wanted = args.channels && args.channels !== 'all'
    ? [args.channels]
    : [...Object.keys(registry), ...(webStore ? ['web'] : [])]
  const attachments = Array.isArray(args.attachments) ? args.attachments.filter(Boolean) : []
  // 本会话图片引用（sessionImage/attachmentId）解析：一次解析、多渠道复用。
  // 解析失败（无附件服务/会话无图片/attachmentId 未引用）记入错误，逐渠道如实呈现。
  let resolvedAttachments = attachments
  let sessionImageError = ''
  if (attachments.some((a) => a.sessionImage === true || a.attachmentId)) {
    try {
      resolvedAttachments = await resolveSessionImageAttachments(ctx, exec, attachments)
    } catch (error) {
      sessionImageError = error instanceof Error ? error.message : String(error)
    }
  }
  const results = []
  if (wanted.length === 0) {
    return {
      results: [],
      summary: '没有可用的通知渠道（IM 渠道插件未安装，且 web 站内通知未启用）',
    }
  }
  for (const channel of wanted) {
    // —— web 内置渠道分支（2026-08-13 新增）：不查外部注册表，写本地通知存储。
    //    落盘记录 sender（exec.agent.session.id = 哪个会话发的），用户维度已读。
    if (channel === 'web') {
      if (!webStore) {
        results.push({ channel, ok: false, error: 'web 渠道未启用（需开启通知模块）', messageId: '', target: '' })
        continue
      }
      if (sessionImageError) {
        results.push({ channel, ok: false, error: sessionImageError, messageId: '', target: 'web' })
        continue
      }
      const added = await webStore.add({
        sender: exec?.agent?.session?.id ?? '',
        semantic: 'notify',
        subject: args.subject,
        content: args.content,
        attachments: resolvedAttachments,
      })
      results.push({ channel, ok: added.ok, error: added.ok ? '' : (added.message ?? ''), messageId: added.id ?? '', target: 'web' })
      continue
    }
    const entry = registry[channel]
    // 渠道未注册：如实报错（公共插件未装/旧版无钩子），不影响其他渠道
    if (!entry) {
      results.push({
        channel,
        ok: false,
        error: '渠道未注册：对应插件未安装，或插件版本不含通知钩子',
        messageId: '',
        target: '',
      })
      continue
    }
    const target = resolveTarget(entry, args.target)
    if (!target) {
      results.push({
        channel,
        ok: false,
        error: '无通知目标：该渠道没有最近交互的对话（可传 target 显式指定，如 p2p:oc_xxx）',
        messageId: '',
        target: '',
      })
      continue
    }
    const targetLabel = `${target.kind}:${target.id}`
    // ① 正文文本：走 entry.send（通知语义，渠道侧自动加「非对话」标注）
    if (args.content) {
      results.push(await sendOne(channel, target, targetLabel, () => entry.send(target, args.content, {})))
    }
    // ② 附件：走 entry.sendMedia 槽位；渠道插件版本不支持时如实报错
    if (attachments.length > 0) {
      if (sessionImageError) {
        // 本会话图片引用解析失败：整组附件无法发送（如实呈现失败原因）
        results.push({
          channel,
          ok: false,
          error: sessionImageError,
          messageId: '',
          target: targetLabel,
        })
      } else if (typeof entry.sendMedia !== 'function') {
        results.push({
          channel,
          ok: false,
          error: '渠道插件版本不支持附件发送（需升级渠道插件到支持 sendMedia 的版本）',
          messageId: '',
          target: targetLabel,
        })
      } else {
        for (const media of resolvedAttachments) {
          results.push(await sendOne(channel, target, targetLabel, () => entry.sendMedia(target, media, {})))
        }
      }
    }
  }
  const okCount = results.filter((r) => r.ok).length
  return { results, summary: `渠道通知：${okCount}/${results.length} 个发送成功` }
}

/**
 * 单条发送执行 + 回执构造（永不抛错：渠道实现异常捕获后如实报告）。
 * @param {string} channel - 渠道标识。
 * @param {object} target - {kind, id}。
 * @param {string} targetLabel - "kind:id" 展示串。
 * @param {Function} run - 执行一次发送（entry.send / entry.sendMedia）。
 * @returns {Promise<object>} 结果条目 {channel, ok, error, messageId, target}。
 */
async function sendOne(channel, target, targetLabel, run) {
  try {
    const result = await run()
    return {
      channel,
      ok: result?.ok === true,
      error: result?.ok ? '' : String(result?.error ?? '发送失败（渠道未返回原因）'),
      messageId: result?.messageId ?? '',
      target: targetLabel,
    }
  } catch (error) {
    return {
      channel,
      ok: false,
      error: String(error instanceof Error ? error.message : error),
      messageId: '',
      target: targetLabel,
    }
  }
}

/**
 * 发送内核（de_channel_send，2026-08-10 由 de_feishu_send 泛化）：
 * 渠道**直发**——主动发送文本/图片/文件到指定渠道（feishu/qq/weixin/wecom，
 * 缺省 feishu；'all'=全部已注册渠道），统一走渠道 entry.sendMedia 槽位
 * （不带「非对话」通知标注，语义=直接把内容发给用户，与 de_notify 的通知
 * 语义区分）。
 * @param {object} args - { channels?, content?, attachments?, target? }。
 *   channels：'feishu'|'qq'|'weixin'|'wecom'|'all'，缺省 'feishu'。
 *   content：文本正文（有附件时自动作为第一条附件的说明文字，不单独发）。
 *   attachments：附件列表 {kind:'image'|'file', path?|url?|base64?, fileName?, caption?}；
 *     2026-08-11 扩展 sessionImage/attachmentId（本会话图片引用，需 260810+）。
 *   target：缺省=最近交互对话；显式 "p2p:oc_xxx"。
 * @param {object} [deps] - { ctx, exec }（工具调用上下文，见 sendChannelNotify）。
 * @returns {{ results: Array, summary: string }} 与 sendChannelNotify 同构。
 */
export async function sendChannelDirect(args, deps = {}) {
  const { ctx, exec, webStore } = deps
  const registry = getRegistry()
  // 渠道解析：显式单渠道 / all=全部已注册 + web（内置渠道）/ 缺省 feishu
  let channels
  if (args.channels && args.channels !== 'all') {
    channels = [args.channels]
  } else if (args.channels === 'all') {
    channels = [...Object.keys(registry), ...(webStore ? ['web'] : [])]
  } else {
    channels = ['feishu']
  }
  const results = []
  const content = String(args.content ?? '').trim()
  const attachments = Array.isArray(args.attachments) ? args.attachments.filter(Boolean) : []
  if (!content && attachments.length === 0) {
    return {
      results: [{ channel: channels[0] ?? 'feishu', ok: false, error: '至少提供 content（文本）或 attachments（附件）之一', messageId: '', target: '' }],
      summary: `渠道直发：0/1 个发送成功`,
    }
  }
  // 本会话图片引用（sessionImage/attachmentId）解析：一次解析、多渠道复用；
  // 解析失败记入错误并逐渠道如实呈现（不阻断其他来源附件）。
  let resolvedAttachments = attachments
  let sessionImageError = ''
  if (attachments.some((a) => a.sessionImage === true || a.attachmentId)) {
    try {
      resolvedAttachments = await resolveSessionImageAttachments(ctx, exec, attachments)
    } catch (error) {
      sessionImageError = error instanceof Error ? error.message : String(error)
    }
  }
  for (const channel of channels) {
    // —— web 内置渠道分支（直发语义，2026-08-13）：写本地通知存储 ——
    if (channel === 'web') {
      if (!webStore) {
        results.push({ channel, ok: false, error: 'web 渠道未启用（需开启通知模块）', messageId: '', target: '' })
        continue
      }
      if (sessionImageError) {
        results.push({ channel, ok: false, error: sessionImageError, messageId: '', target: 'web' })
        continue
      }
      const added = await webStore.add({
        sender: exec?.agent?.session?.id ?? '',
        semantic: 'direct',
        subject: args.subject ?? '',
        content: args.content ?? '',
        attachments: resolvedAttachments,
      })
      results.push({ channel, ok: added.ok, error: added.ok ? '' : (added.message ?? ''), messageId: added.id ?? '', target: 'web' })
      continue
    }
    const entry = registry[channel]
    // 渠道未注册 / 无 sendMedia 槽位（旧版渠道插件）：如实报错，不影响其他渠道
    if (!entry) {
      results.push({ channel, ok: false, error: '渠道未注册：对应渠道插件未安装，或插件版本不含通知钩子', messageId: '', target: '' })
      continue
    }
    if (typeof entry.sendMedia !== 'function') {
      results.push({ channel, ok: false, error: '渠道插件版本不支持主动发送（需升级到支持 sendMedia 的版本）', messageId: '', target: '' })
      continue
    }
    const target = resolveTarget(entry, args.target)
    if (!target) {
      results.push({ channel, ok: false, error: '无发送目标：该渠道没有最近交互的对话（可传 target 显式指定，如 p2p:oc_xxx）', messageId: '', target: '' })
      continue
    }
    const targetLabel = `${target.kind}:${target.id}`
    // 本会话图片引用解析失败：整组附件无法发送（如实呈现失败原因）
    if (sessionImageError) {
      results.push({ channel, ok: false, error: sessionImageError, messageId: '', target: targetLabel })
      continue
    }
    // 组合发送序列：
    //  - 无附件：content 单独作为文本消息；
    //  - 有附件：content 并入第一条附件的 caption（已有 caption 则换行拼接），
    //    不单独发文本——一条媒体消息即「说明 + 附件」，体验一致。
    const mediaList = resolvedAttachments.map((a) => ({ kind: a.kind === 'image' ? 'image' : 'file', ...a }))
    if (content && mediaList.length > 0) {
      mediaList[0].caption = [mediaList[0].caption, content].filter(Boolean).join('\n')
    }
    const sends = []
    if (content && mediaList.length === 0) sends.push({ kind: 'text', content })
    sends.push(...mediaList)
    for (const media of sends) {
      results.push(await sendOne(channel, target, targetLabel, () => entry.sendMedia(target, media, {})))
    }
  }
  const okCount = results.filter((r) => r.ok).length
  return { results, summary: `渠道直发：${okCount}/${results.length} 个发送成功` }
}

/** 统一日期时间格式：YYYY-MM-DD HH:mm:ss（render 时间锚点，精确到秒）。 */
function fmtDateTime(ts) {
  const d = new Date(ts)
  const pad2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/**
 * 附件参数 schema（de_notify / de_channel_send 共用）。
 * 来源五选一：path（本地路径）/ url（远程地址，自动下载）/ base64（内联内容）/
 * sessionImage（本会话最近一张图，2026-08-11 P1 扩展）/ attachmentId（本会话
 * 某张图的显式引用，来自 de_session_images 查询）。
 * ⚠️ sessionImage / attachmentId 依赖 DSH 260810+ 快照的 attachments 服务与
 * 会话 ImageBlock 事件：旧版本（260809）下会如实报错，不影响其他来源。
 */
const ATTACHMENTS_SCHEMA = {
  type: 'array',
  description: '附件列表（图片或文件）；每条来源五选一：path=本地文件绝对路径 / url=http(s) 远程地址（自动下载后发送）/ base64=内联内容（必须配 fileName）/ sessionImage=true 引用本会话最近一张图（用户在 DSH 输入框贴的图，需 260810+ 快照）/ attachmentId=本会话某张图的引用 id（来自 de_session_images，需 260810+ 快照）；图片/文件可带 caption 说明文字（图文混排展示）。飞书限制：图片≤10MB、文件≤30MB',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['image', 'file'], description: '附件类型：image=图片（≤10MB），file=文件（≤30MB）' },
      path: { type: 'string', description: '本地文件绝对路径（与 url/base64/sessionImage/attachmentId 互斥）' },
      url: { type: 'string', description: 'http/https 远程地址，自动下载后发送（与 path/base64/sessionImage/attachmentId 互斥）' },
      base64: { type: 'string', description: '内联 base64 内容，必须配 fileName（与 path/url/sessionImage/attachmentId 互斥；适用于小文件）' },
      sessionImage: { type: 'boolean', description: 'true=引用本会话最近一张图片（用户在 DSH 输入框粘贴/拖入发送的图；需 DSH 260810+ 快照；与 path/url/base64/attachmentId 互斥）' },
      attachmentId: { type: 'string', description: '引用本会话某张图片的附件 id（形如 sha256:xxx，先查 de_session_images 获取；需 DSH 260810+ 快照；与 path/url/base64/sessionImage 互斥）' },
      fileName: { type: 'string', description: '目标文件名（base64 来源必填；path/url 缺省自动推断；sessionImage/attachmentId 缺省按媒体类型推断）' },
      caption: { type: 'string', description: '说明文字（附件在飞书里图文混排展示）' },
    },
    required: ['kind'],
  },
}

/** de_notify 工具定义（output 必须声明 { schema, render }，DSH 硬要求）。 */
export function notifyToolDefinition(send) {
  return {
    name: 'de_notify',
    description: '渠道通知：把消息通过 IM 渠道（一期支持飞书）**主动发给你**，让你在电脑前/手机上立刻知道（任务完成等需要用户知晓的节点用）。channels 选渠道：feishu/qq/weixin/wecom/web/all（缺省 feishu；**web=发到本网页右上角站内通知铃铛**，需开启通知模块；渠道未安装会如实报错，不会假装成功）；content 为消息正文（**建议按邮件式组织：📮主题/📝简介/👤发送人/🕐时间，完整内容写在最后面**——与 COI 任务完成自动通知同款样式，美观且一眼可读）；attachments 可选：附件列表（图片/文件，来源五选一：path=本地路径 / url=远程地址 / base64=内联内容 / **sessionImage=true 引用本会话最近一张图（用户在 DSH 输入框粘贴/拖入发送的图，需 260810+ 快照）** / **attachmentId=本会话某张图的引用 id（先查 de_session_images 获取）**，需渠道插件支持附件能力，不支持会如实报错）；target 可选：缺省=该渠道「最近交互的对话」（零配置，最常用），也可显式传 chatKey（如 p2p:oc_xxx）发给指定对话。**随时可发、无频率限制（用户拍板）**；但注意消息是发给真实用户的，只在该发的时候发（任务完成/重要进展/需要用户处理），不要为无关琐事刷屏。返回逐渠道结果（成功/失败原因/消息 id），失败如实呈现。',
    parameters: {
      type: 'object',
      properties: {
        channels: { type: 'string', enum: ['feishu', 'qq', 'weixin', 'wecom', 'web', 'all'], description: '发送渠道（缺省 feishu；web=发到本网页右上角站内通知；all=全部已注册渠道+web；未注册渠道会如实报错）' },
        content: { type: 'string', description: '通知消息正文（必填；建议带任务/结果概要）' },
        attachments: ATTACHMENTS_SCHEMA,
        target: { type: 'string', description: '可选：缺省 recent=该渠道最近交互的对话；显式传 chatKey（如 p2p:oc_xxx）' },
      },
      required: ['content'],
    },
    output: {
      schema: CHANNEL_RESULTS_SCHEMA,
      render(_args, value) {
        return renderChannelResults(value)
      },
    },
    // 工具执行入口：转发发送内核（永不抛错、逐渠道回执）。exec 携带当前
    // 会话（exec.agent），sessionImage/attachmentId 来源需要它。
    execute: (args, exec) => send(args, exec),
  }
}

/**
 * de_channel_send 工具定义（2026-08-10 由 de_feishu_send 泛化：飞书 +
 * QQ + 微信 + 企业微信四渠道直发）。独立开关 channelSendEnabled（默认开）
 * 控制，与 de_notify 语义区分：直发不带「非对话」通知标注。
 */
export function channelSendToolDefinition(send) {
  return {
    name: 'de_channel_send',
    description: '渠道直发：**主动发送**文本/图片/文件到 IM 渠道（DSH→渠道单向，不带「这是通知」标注，语义=直接把内容发给你）。channels 选渠道：feishu/qq/weixin/wecom/web（缺省 feishu；all=全部已注册渠道+web；**web=发到本网页右上角站内通知**；渠道插件未装会如实报错）。content=文本正文；attachments=附件列表（图片或文件，来源五选一：path=本地文件绝对路径 / url=远程地址自动下载 / base64=内联内容必须配 fileName / **sessionImage=true 引用本会话最近一张图（用户在 DSH 输入框粘贴/拖入发送的图，需 260810+ 快照）** / **attachmentId=本会话某张图的引用 id（先查 de_session_images 获取，需 260810+ 快照）**；可带 caption 说明文字；**有 content + 附件时 content 自动作为第一条附件的说明**，不单独发文本）；target 可选：缺省=该渠道最近交互的对话，也可显式传 chatKey（如 p2p:oc_xxx）。各渠道限制：飞书图片≤10MB/文件≤30MB；QQ 本地文件≤10MB（更大用 url 来源）；企微 ≤50MB；微信由平台限制。适合「把生成的图片/文档/报告发给我」以及「把 DSH 输入框里贴的图转给渠道」场景；与 de_notify 的区别：de_notify 是通知（带标注、需开启通知开关），本工具是直发（不带标注、默认开启）。',
    parameters: {
      type: 'object',
      properties: {
        channels: { type: 'string', enum: ['feishu', 'qq', 'weixin', 'wecom', 'web', 'all'], description: '发送渠道（缺省 feishu；web=发到本网页右上角站内通知；all=全部已注册渠道+web；未注册渠道会如实报错）' },
        content: { type: 'string', description: '文本正文（无附件时单独发一条文本；有附件时自动作为第一条附件的说明文字）' },
        attachments: ATTACHMENTS_SCHEMA,
        target: { type: 'string', description: '可选：缺省=该渠道最近交互的对话；显式传 chatKey（如 p2p:oc_xxx）' },
      },
      required: [],
    },
    output: {
      schema: CHANNEL_RESULTS_SCHEMA,
      render(_args, value) {
        return renderChannelResults(value)
      },
    },
    // 直接转发直发内核（永不抛错、逐条回执）；exec 携带当前会话，
    // sessionImage/attachmentId 来源需要它。
    execute: (args, exec) => send(args, exec),
  }
}

/** 渠道发送结果 output schema（de_notify / de_channel_send 共用，与返回严格一致）。 */
const CHANNEL_RESULTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          channel: { type: 'string', description: '渠道标识（feishu/qq/weixin/wecom）' },
          ok: { type: 'boolean', description: '是否发送成功' },
          error: { type: 'string', description: '失败原因（成功为空字符串）' },
          messageId: { type: 'string', description: '渠道返回的消息 id（成功时；没有为空字符串）' },
          target: { type: 'string', description: '实际发送目标（kind:id 或空）' },
        },
        required: ['channel', 'ok', 'error', 'messageId', 'target'],
      },
    },
    summary: { type: 'string', description: '汇总：几个发送成功' },
  },
  required: ['results', 'summary'],
}

/**
 * 渠道发送结果 render（de_notify / de_channel_send 共用）：时间锚点（调用
 * 时刻，秒级）+ 逐条结果 + 汇总——失败原因必须原样呈现（不掩盖）。
 * @param {object} value - {results, summary}（工具输出）。
 * @returns {Array<{type: 'text', text: string}>} DSH 渲染块。
 */
function renderChannelResults(value) {
  const lines = [`⏰ 当前时间：${fmtDateTime(Date.now())}`]
  for (const r of value.results ?? []) {
    if (r.ok) {
      lines.push(`✅ ${r.channel}：已发送（目标 ${r.target}${r.messageId ? `，消息 id ${r.messageId}` : ''}）`)
    } else {
      lines.push(`❌ ${r.channel}：发送失败——${r.error}`)
    }
  }
  lines.push(`📊 ${value.summary}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 安装渠道通知模块（notifyEnabled 开关控制，独立装配）。
 * @param {object} ctx - 插件上下文（tools 已注入；agents 由主插件声明式
 *   inject；attachments 动态 ctx.get——260809 无该服务则 sessionImage 来源报错）。
 * @param {object} [deps] - { memoryDir }：memoryDir 用于 web 通知存储目录。
 * @returns {{ dispose: Function, sendChannelNotify: Function, webStore: NotificationStore }}
 *   dispose：整体卸载（工具注销 + web API 卸载）；
 *   sendChannelNotify：发送内核（COI 自动通知经主插件注入给调度器，
 *   未启用本模块时主插件传 undefined，COI 侧静默跳过）；
 *   webStore：web 通知存储（channelSend 直发复用同一实例）。
 */
export function installNotify(ctx, deps = {}) {
  const { memoryDir } = deps
  // web 站内通知：随 notifyEnabled 一起启用（2026-08-13 用户拍板：渠道通知
  // 与 web 通知合并为「通知模块」）。webStore 落盘 + API 挂载；发送内核的
  // 'web' 分支写它。channelSend（直发）由主插件注入同一 webStore 复用。
  const webStore = new NotificationStore(memoryDir)
  const apiDispose = installNotifyWebApi(ctx, { store: webStore, memoryDir })
  // 工具注册（卸载时自动注销）。execute 收到 exec（ToolRunContext，
  // exec.agent=当前会话）——sessionImage/attachmentId 来源需要它；
  // ctx/webStore 闭包绑定（发送内核需要 agents/attachments 服务 + web 存储）。
  const dispose = ctx.effect(() => {
    const tool = notifyToolDefinition((args, exec) => sendChannelNotify(args, { ctx, exec, webStore }))
    return ctx.tools.register(tool)
  }, 'dsh-memory-evolve: de_notify tool')

  return {
    dispose() { dispose(); apiDispose() },
    // COI 自动通知调用（无 exec）：传 ctx + webStore，sender 记空（系统自动）。
    sendChannelNotify: (args) => sendChannelNotify(args, { ctx, webStore }),
    webStore,
  }
}

/**
 * 安装渠道直发模块（channelSendEnabled 开关控制，独立装配——与 de_notify
 * 语义不同：直发 vs 通知，开关粒度独立；2026-08-10 由 de_feishu_send
 * 泛化为四渠道：feishu/qq/weixin/wecom）。
 * @param {object} ctx - 插件上下文（tools 已注入）。
 * @param {object} [deps] - { webStore }：web 通知存储（由 notify 模块提供；
 *   notify 未启用时为 null，de_channel_send 发 web 会如实报「渠道未启用」）。
 * @returns {{ dispose: Function }}
 */
export function installChannelSend(ctx, deps = {}) {
  const { webStore } = deps
  // execute 收到 exec（ToolRunContext，exec.agent=当前会话）——与
  // installNotify 同款：sessionImage/attachmentId 来源需要它；ctx/webStore 闭包绑定。
  const dispose = ctx.effect(() => {
    const tool = channelSendToolDefinition((args, exec) => sendChannelDirect(args, { ctx, exec, webStore }))
    return ctx.tools.register(tool)
  }, 'dsh-memory-evolve: de_channel_send tool')

  return { dispose }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * de_session_images：本会话图片查询工具（2026-08-11 P1 任务配套）。
 * 列出当前会话最近的图片引用（attachmentId/mediaType/尺寸/字节数/角色/时间），
 * AI 先查再发——多图场景用 attachmentId 显式引用转发到渠道。
 * 独立开关 sessionImageQueryEnabled（默认关）控制：语义独立（查询会话图片，
 * 不只服务渠道发送），不借 channelSendEnabled/notifyEnabled 的开关
 * （2026-08-08 用户纪律：独立领域独立开关）。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * 查询本会话最近的图片引用（de_session_images 执行内核，永不抛错）。
 * @param {object} ctx - 插件上下文（agents 已注入）。
 * @param {object|undefined} exec - 工具执行上下文（exec.agent.session.id=当前会话）。
 * @param {object} [args] - { limit? }（最多返回几张，默认 5，最大 10）。
 * @returns {Promise<{sessionId: string, images: Array, summary: string}>}
 *   images 每条 {attachmentId, mediaType, bytes, width, height, name, role, time}，
 *   按时间倒序（最近在前）。
 */
export async function querySessionImages(ctx, exec, args = {}) {
  const sessionId = exec?.agent?.session?.id ?? ''
  if (!sessionId) {
    return { sessionId: '', images: [], summary: '无法确定当前会话（工具调用上下文缺失）' }
  }
  const agents = ctx?.get?.('agents')
  const session = agents?.get?.(sessionId)?.session
  const events = session?.events
  if (!Array.isArray(events)) {
    return { sessionId, images: [], summary: '无法读取本会话事件（会话不在本进程）' }
  }
  const refs = scanSessionImageRefs(events)
  const limit = Math.max(1, Math.min(Number(args.limit) || 5, 10))
  // 按时间倒序（最近在前）；同一 attachmentId 去重（chunk 与 message 可能重复出现）
  const seen = new Set()
  const images = []
  for (let i = refs.length - 1; i >= 0 && images.length < limit; i--) {
    const item = refs[i]
    const id = String(item.ref.attachmentId ?? '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    images.push({
      attachmentId: id,
      mediaType: item.ref.mediaType ?? '',
      bytes: item.ref.bytes ?? 0,
      width: item.ref.width ?? 0,
      height: item.ref.height ?? 0,
      name: item.ref.name ?? '',
      role: item.role,
      time: item.time,
    })
  }
  const summary = images.length > 0
    ? `本会话最近 ${images.length} 张图片（attachmentId 可用于 de_channel_send/de_notify 的 attachments.attachmentId 引用转发）`
    : '本会话没有图片（需先在 DSH 输入框粘贴/拖入图片发送后才有；260809 及更早版本不支持）'
  return { sessionId, images, summary }
}

/** de_session_images 工具输出 schema（与返回严格一致，additionalProperties:false）。 */
const SESSION_IMAGES_RESULTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', description: '当前会话 ID（查询视角；空=无上下文）' },
    images: {
      type: 'array',
      description: '本会话最近的图片引用（按时间倒序，attachmentId 去重）',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string', description: '图片附件引用 id（形如 sha256:xxx；可用于 de_channel_send/de_notify attachments.attachmentId）' },
          mediaType: { type: 'string', description: '媒体类型（image/png 等）' },
          bytes: { type: 'integer', description: '编码字节数' },
          width: { type: 'integer', description: '像素宽' },
          height: { type: 'integer', description: '像素高' },
          name: { type: 'string', description: '显示名（无则为空字符串）' },
          role: { type: 'string', description: '所在消息角色：user（输入框贴图）/ assistant（模型生成）' },
          time: { type: 'integer', description: '所在消息时间（epoch 毫秒）' },
        },
        required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name', 'role', 'time'],
      },
    },
    summary: { type: 'string', description: '汇总：几张图 / 无图说明' },
  },
  required: ['sessionId', 'images', 'summary'],
}

/** de_session_images 工具定义（output 必须声明 { schema, render }，DSH 硬要求）。 */
export function sessionImagesToolDefinition(query) {
  return {
    name: 'de_session_images',
    description: '会话图片查询：列出**当前会话**最近的图片引用（用户在 DSH 输入框粘贴/拖入发送的图，或模型生成的图）。返回每张图的 attachmentId（形如 sha256:xxx）、媒体类型、尺寸、字节数与所在消息角色/时间——拿到 attachmentId 后可配合 de_channel_send / de_notify 的 attachments.attachmentId 把该图转发到飞书/QQ/微信/企微。**需 DSH 260810+ 快照**（旧版本无附件服务会如实报错）。limit 可选（默认 5，最多 10）。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多返回最近的几张图（默认 5，最大 10）' },
      },
      required: [],
    },
    output: {
      schema: SESSION_IMAGES_RESULTS_SCHEMA,
      render(_args, value) {
        return renderSessionImages(value)
      },
    },
    // 工具执行入口：query 闭包已绑定 ctx；exec 携带当前会话
    execute: (args, exec) => query(exec, args),
  }
}

/** de_session_images render：时间锚点 + 逐图元数据 + 汇总。 */
function renderSessionImages(value) {
  const lines = [`⏰ 当前时间：${fmtDateTime(Date.now())}`]
  if (!value.sessionId) {
    lines.push(`❌ ${value.summary}`)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  lines.push(`会话：${value.sessionId}`)
  for (const img of value.images ?? []) {
    const when = new Date(img.time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    const nameBit = img.name ? ` · ${img.name}` : ''
    const roleBit = img.role === 'assistant' ? '模型生成' : '用户输入框'
    lines.push(`🖼️ ${img.attachmentId}（${img.mediaType} ${img.width}×${img.height}，${(img.bytes / 1024).toFixed(1)}KB，${roleBit}，${when}${nameBit}）`)
  }
  lines.push(`📊 ${value.summary}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 安装本会话图片查询模块（sessionImageQueryEnabled 开关控制，独立装配——
 * 独立领域独立开关，见模块头注释）。
 * @param {object} ctx - 插件上下文（tools 已注入）。
 * @returns {{ dispose: Function }}
 */
export function installSessionImages(ctx) {
  const dispose = ctx.effect(() => {
    const tool = sessionImagesToolDefinition((exec, args) => querySessionImages(ctx, exec, args))
    return ctx.tools.register(tool)
  }, 'dsh-memory-evolve: de_session_images tool')

  return { dispose }
}
