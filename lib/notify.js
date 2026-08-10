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
 * 发送内核（de_notify）：按 channels 遍历注册表发送，逐渠道收集结果，永不抛错。
 * @param {object} args - { channels, content?, target?, attachments? }。
 *   channels：'feishu'|'qq'|'weixin'|'wecom'|'all'（all=全部已注册渠道）。
 *   content：通知正文（走渠道 entry.send，通知语义带标注）。
 *   attachments：可选附件列表（2026-08-10 扩展），每条
 *     {kind:'image'|'file', path?|url?|base64?, fileName?, caption?}，
 *     走渠道 entry.sendMedia 槽位（渠道插件无此槽位 → 如实报「版本不支持附件」）。
 * @returns {{ results: Array, summary: string }}
 */
export async function sendChannelNotify(args) {
  const registry = getRegistry()
  const wanted = args.channels && args.channels !== 'all'
    ? [args.channels]
    : Object.keys(registry)
  const attachments = Array.isArray(args.attachments) ? args.attachments.filter(Boolean) : []
  const results = []
  if (wanted.length === 0) {
    return {
      results: [],
      summary: '没有已注册的渠道（对应渠道插件未安装，或插件版本不含通知钩子）',
    }
  }
  for (const channel of wanted) {
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
      if (typeof entry.sendMedia !== 'function') {
        results.push({
          channel,
          ok: false,
          error: '渠道插件版本不支持附件发送（需升级渠道插件到支持 sendMedia 的版本）',
          messageId: '',
          target: targetLabel,
        })
      } else {
        for (const media of attachments) {
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
 *   attachments：附件列表 {kind:'image'|'file', path?|url?|base64?, fileName?, caption?}。
 *   target：缺省=最近交互对话；显式 "p2p:oc_xxx"。
 * @returns {{ results: Array, summary: string }} 与 sendChannelNotify 同构。
 */
export async function sendChannelDirect(args) {
  const registry = getRegistry()
  // 渠道解析：显式单渠道 / all=全部已注册 / 缺省 feishu
  let channels
  if (args.channels && args.channels !== 'all') {
    channels = [args.channels]
  } else if (args.channels === 'all') {
    channels = Object.keys(registry)
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
  for (const channel of channels) {
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
    // 组合发送序列：
    //  - 无附件：content 单独作为文本消息；
    //  - 有附件：content 并入第一条附件的 caption（已有 caption 则换行拼接），
    //    不单独发文本——一条媒体消息即「说明 + 附件」，体验一致。
    const mediaList = attachments.map((a) => ({ kind: a.kind === 'image' ? 'image' : 'file', ...a }))
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
 * 来源三选一：path（本地路径）/ url（远程地址，自动下载）/ base64（内联内容）。
 */
const ATTACHMENTS_SCHEMA = {
  type: 'array',
  description: '附件列表（图片或文件）；每条来源三选一：path=本地文件绝对路径 / url=http(s) 远程地址（自动下载后发送）/ base64=内联内容（必须配 fileName）；图片/文件可带 caption 说明文字（图文混排展示）。飞书限制：图片≤10MB、文件≤30MB',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['image', 'file'], description: '附件类型：image=图片（≤10MB），file=文件（≤30MB）' },
      path: { type: 'string', description: '本地文件绝对路径（与 url/base64 三选一）' },
      url: { type: 'string', description: 'http/https 远程地址，自动下载后发送（与 path/base64 三选一）' },
      base64: { type: 'string', description: '内联 base64 内容，必须配 fileName（与 path/url 三选一；适用于小文件）' },
      fileName: { type: 'string', description: '目标文件名（base64 来源必填；path/url 缺省自动推断）' },
      caption: { type: 'string', description: '说明文字（附件在飞书里图文混排展示）' },
    },
    required: ['kind'],
  },
}

/** de_notify 工具定义（output 必须声明 { schema, render }，DSH 硬要求）。 */
export function notifyToolDefinition(send) {
  return {
    name: 'de_notify',
    description: '渠道通知：把消息通过 IM 渠道（一期支持飞书）**主动发给你**，让你在电脑前/手机上立刻知道（任务完成等需要用户知晓的节点用）。channels 选渠道：feishu/qq/weixin/wecom/all（缺省 feishu；**渠道未安装会如实报错**，不会假装成功）；content 为消息正文（**建议按邮件式组织：📮主题/📝简介/👤发送人/🕐时间，完整内容写在最后面**——与 COI 任务完成自动通知同款样式，美观且一眼可读）；attachments 可选：附件列表（图片/文件，来源 path/url/base64，需渠道插件支持附件能力，不支持会如实报错）；target 可选：缺省=该渠道「最近交互的对话」（零配置，最常用），也可显式传 chatKey（如 p2p:oc_xxx）发给指定对话。**随时可发、无频率限制（用户拍板）**；但注意消息是发给真实用户的，只在该发的时候发（任务完成/重要进展/需要用户处理），不要为无关琐事刷屏。返回逐渠道结果（成功/失败原因/消息 id），失败如实呈现。',
    parameters: {
      type: 'object',
      properties: {
        channels: { type: 'string', enum: ['feishu', 'qq', 'weixin', 'wecom', 'all'], description: '发送渠道（缺省 feishu；all=全部已注册渠道；未注册渠道会如实报错）' },
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
    // 工具执行入口：直接转发发送内核（sendChannelNotify 永不抛错、
    // 逐渠道回执，见函数注释）。不需要 exec（不依赖调用方会话）。
    execute: (args) => send(args),
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
    description: '渠道直发：**主动发送**文本/图片/文件到 IM 渠道（DSH→渠道单向，不带「这是通知」标注，语义=直接把内容发给你）。channels 选渠道：feishu/qq/weixin/wecom（缺省 feishu；all=全部已注册渠道；**渠道插件未装会如实报错**）。content=文本正文；attachments=附件列表（图片或文件，来源三选一：path=本地文件绝对路径 / url=远程地址自动下载 / base64=内联内容必须配 fileName；可带 caption 说明文字；**有 content + 附件时 content 自动作为第一条附件的说明**，不单独发文本）；target 可选：缺省=该渠道最近交互的对话，也可显式传 chatKey（如 p2p:oc_xxx）。各渠道限制：飞书图片≤10MB/文件≤30MB；QQ 本地文件≤10MB（更大用 url 来源）；企微 ≤50MB；微信由平台限制。适合「把生成的图片/文档/报告发给我」场景；与 de_notify 的区别：de_notify 是通知（带标注、需开启通知开关），本工具是直发（不带标注、默认开启）。',
    parameters: {
      type: 'object',
      properties: {
        channels: { type: 'string', enum: ['feishu', 'qq', 'weixin', 'wecom', 'all'], description: '发送渠道（缺省 feishu；all=全部已注册渠道；未注册渠道会如实报错）' },
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
    // 直接转发直发内核（sendChannelDirect 永不抛错、逐条回执）
    execute: (args) => send(args),
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
 * @param {object} ctx - 插件上下文（tools 已注入）。
 * @returns {{ dispose: Function, sendChannelNotify: Function }}
 *   dispose：整体卸载（工具注销）；
 *   sendChannelNotify：发送内核（COI 自动通知经主插件注入给调度器，
 *   未启用本模块时主插件传 undefined，COI 侧静默跳过）。
 */
export function installNotify(ctx) {
  // 工具注册（卸载时自动注销）
  const dispose = ctx.effect(() => {
    const tool = notifyToolDefinition(sendChannelNotify)
    return ctx.tools.register(tool)
  }, 'dsh-memory-evolve: de_notify tool')

  return { dispose, sendChannelNotify }
}

/**
 * 安装渠道直发模块（channelSendEnabled 开关控制，独立装配——与 de_notify
 * 语义不同：直发 vs 通知，开关粒度独立；2026-08-10 由 de_feishu_send
 * 泛化为四渠道：feishu/qq/weixin/wecom）。
 * @param {object} ctx - 插件上下文（tools 已注入）。
 * @returns {{ dispose: Function, sendChannelDirect: Function }}
 */
export function installChannelSend(ctx) {
  const dispose = ctx.effect(() => {
    const tool = channelSendToolDefinition(sendChannelDirect)
    return ctx.tools.register(tool)
  }, 'dsh-memory-evolve: de_channel_send tool')

  return { dispose, sendChannelDirect }
}
