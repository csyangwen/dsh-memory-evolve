/**
 * 渠道通知模块（de_notify）——**独立子模块**（用户拍板纪律：独立领域
 * 不挂别的模块下，不借其他模块的开关）。
 *
 * 功能：AI 完成任务后通过 IM 渠道（一期：飞书）主动发通知给用户。
 * 两种触发方式（用户拍板 2026-08-09 两者都要）：
 *  ① 手动工具 de_notify：模型在任何会话里自主调用（随时可发、无频率
 *     约束——用户拍板不做频率限制）；
 *  ② COI 完成自动通知：COI 调度模块任务终态时按 coiNotifyChannels
 *     配置自动发送（复用 scheduler 的 notify 回调，见 lib/coi/index.js）。
 *
 * 架构（用户拍板方案 A：渠道插件全局注册表）：
 *  - 渠道插件（dsh-feishu 等，公共插件）在 apply 时把自己的主动发送
 *    能力登记到 globalThis.__dshChannelNotify（无侵入钩子，见
 *    ~/.dsh/plugins/dsh-feishu/lib/channel-registry.js 头部注释）；
 *  - 本模块工具执行时读取该注册表调用。渠道插件没装/旧版无钩子 →
 *    注册表缺项 → de_notify 如实报「渠道未注册」，主插件零影响；
 *  - 本模块也不依赖任何渠道插件的 cordis 服务（无静态 inject，避开
 *    "cannot get property without inject" 硬依赖问题）。
 *
 * 开关：notifyEnabled（默认关，与其他独立模块一致——注册即占模型工具
 * 列表，需要时再开）。
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
 * 发送内核：按 channels 遍历注册表发送，逐渠道收集结果，永不抛错。
 * @param {object} args - { channels, content, target? }。
 *   channels：'feishu'|'qq'|'weixin'|'wecom'|'all'（all=全部已注册渠道）。
 * @returns {{ results: Array, summary: string }}
 */
export async function sendChannelNotify(args) {
  const registry = getRegistry()
  const wanted = args.channels && args.channels !== 'all'
    ? [args.channels]
    : Object.keys(registry)
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
    try {
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
      const result = await entry.send(target, args.content, {})
      results.push({
        channel,
        ok: result?.ok === true,
        error: result?.ok ? '' : String(result?.error ?? '发送失败（渠道未返回原因）'),
        messageId: result?.messageId ?? '',
        target: `${target.kind}:${target.id}`,
      })
    } catch (error) {
      // 渠道实现异常（未连接、网络错误等）：捕获后如实报告，不中断其他渠道
      results.push({
        channel,
        ok: false,
        error: String(error instanceof Error ? error.message : error),
        messageId: '',
        target: '',
      })
    }
  }
  const okCount = results.filter((r) => r.ok).length
  return { results, summary: `渠道通知：${okCount}/${results.length} 个渠道发送成功` }
}

/** 统一日期时间格式：YYYY-MM-DD HH:mm:ss（render 时间锚点，精确到秒）。 */
function fmtDateTime(ts) {
  const d = new Date(ts)
  const pad2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** de_notify 工具定义（output 必须声明 { schema, render }，DSH 硬要求）。 */
export function notifyToolDefinition(send) {
  return {
    name: 'de_notify',
    description: '渠道通知：把消息通过 IM 渠道（一期支持飞书）**主动发给你**，让你在电脑前/手机上立刻知道（任务完成等需要用户知晓的节点用）。channels 选渠道：feishu/qq/weixin/wecom/all（缺省 feishu；**渠道未安装会如实报错**，不会假装成功）；content 为消息正文（**建议按邮件式组织：📮主题/📝简介/👤发送人/🕐时间，完整内容写在最后面**——与 COI 任务完成自动通知同款样式，美观且一眼可读）；target 可选：缺省=该渠道「最近交互的对话」（零配置，最常用），也可显式传 chatKey（如 p2p:oc_xxx）发给指定对话。**随时可发、无频率限制（用户拍板）**；但注意消息是发给真实用户的，只在该发的时候发（任务完成/重要进展/需要用户处理），不要为无关琐事刷屏。返回逐渠道结果（成功/失败原因/消息 id），失败如实呈现。',
    parameters: {
      type: 'object',
      properties: {
        channels: { type: 'string', enum: ['feishu', 'qq', 'weixin', 'wecom', 'all'], description: '发送渠道（缺省 feishu；all=全部已注册渠道；未注册渠道会如实报错）' },
        content: { type: 'string', description: '通知消息正文（必填；建议带任务/结果概要）' },
        target: { type: 'string', description: '可选：缺省 recent=该渠道最近交互的对话；显式传 chatKey（如 p2p:oc_xxx）' },
      },
      required: ['content'],
    },
    output: {
      schema: {
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
          summary: { type: 'string', description: '汇总：几个渠道发送成功' },
        },
        required: ['results', 'summary'],
      },
      render(_args, value) {
        // render 把结构化结果渲染成模型可见文本：时间锚点（调用时刻，
        // 秒级）+ 逐渠道结果 + 汇总——失败原因必须原样呈现（不掩盖）
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
      },
    },
    // 工具执行入口：直接转发发送内核（sendChannelNotify 永不抛错、
    // 逐渠道回执，见函数注释）。不需要 exec（不依赖调用方会话）。
    execute: (args) => send(args),
  }
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
