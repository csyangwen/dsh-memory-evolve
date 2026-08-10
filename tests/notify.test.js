/**
 * 渠道通知模块（de_notify + de_channel_send）测试。
 *
 * 覆盖（2026-08-09 一期：飞书单渠道，方案 A 全局注册表）：
 *  - sendChannelNotify 发送内核：成功 / 渠道未注册 / 无最近交互 / 显式
 *    target / all 遍历 / send 抛异常（不中断其他渠道）/ 无注册表零影响
 *  - notifyToolDefinition：schema 与 DSH 兼容（单一 type、顶层 required）、
 *    render 输出（时间锚点、失败如实呈现、不掩盖）
 *  - 2026-08-10 扩展（用户拍板：DSH→飞书单向发送图片/文件）：
 *    sendChannelNotify attachments 附件（sendMedia 槽位/版本不支持报错）、
 *    sendChannelDirect 直发内核（content 作附件 caption / 纯文本 / 缺参报错 / 多渠道）、
 *    channelSendToolDefinition schema 与 execute、channelSendEnabled 开关
 *  - buildNotify（COI 完成自动通知）：命令+渠道组合 / 只渠道 / 无配置
 *    undefined / 渠道未启用静默跳过 / 内容模板断言
 */

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  sendChannelNotify,
  sendChannelDirect,
  notifyToolDefinition,
  channelSendToolDefinition,
  scanSessionImageRefs,
  resolveSessionImage,
  querySessionImages,
  sessionImagesToolDefinition,
} from '../lib/notify.js'
import { buildNotify, buildChannelContent } from '../lib/coi/index.js'
import { resolveConfig, validateRuntimePatch, RUNTIME_KEYS } from '../lib/index.js'

const REGISTRY_KEY = '__dshChannelNotify'

// 每个用例前后清理注册表，防止测试间相互污染
beforeEach(() => { delete globalThis[REGISTRY_KEY] })
afterEach(() => { delete globalThis[REGISTRY_KEY] })

/** 便捷构造：一个可断言的 mock 飞书渠道（含 sendMedia 槽位，2026-08-10 扩展）。 */
function feishuEntry(overrides = {}) {
  const calls = []
  const entry = {
    calls,
    send: async (chat, content, opts) => { calls.push({ chat, content, opts }); return { ok: true, messageId: 'om_1' } },
    sendMedia: async (chat, media, opts) => { calls.push({ chat, media, opts }); return { ok: true, messageId: 'om_media' } },
    recentChat: () => ({ kind: 'p2p', id: 'oc_1', userId: 'ou_1' }),
    status: () => ({ configured: true, connected: true }),
    ...overrides,
  }
  return entry
}

// ---------------------------------------------------------------------------
// sendChannelNotify：发送内核
// ---------------------------------------------------------------------------

test('notify: no registry at all → per-channel "unregistered" errors, no crash', async () => {
  const r = await sendChannelNotify({ channels: 'feishu', content: 'hi' })
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0].channel, 'feishu')
  assert.equal(r.results[0].ok, false)
  assert.match(r.results[0].error, /渠道未注册/)
  assert.equal(r.summary, '渠道通知：0/1 个发送成功')
})

test('notify: successful send returns messageId and target', async () => {
  const entry = feishuEntry()
  globalThis[REGISTRY_KEY] = { feishu: entry }
  const r = await sendChannelNotify({ channels: 'feishu', content: '完成啦' })
  assert.equal(r.results[0].ok, true)
  assert.equal(r.results[0].messageId, 'om_1')
  assert.equal(r.results[0].target, 'p2p:oc_1')
  // 发送内容原样透传
  assert.equal(entry.calls[0].content, '完成啦')
  assert.equal(r.summary, '渠道通知：1/1 个发送成功')
})

test('notify: default channels = feishu when omitted', async () => {
  const entry = feishuEntry()
  globalThis[REGISTRY_KEY] = { feishu: entry }
  const r = await sendChannelNotify({ content: '默认渠道' })
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0].channel, 'feishu')
  assert.equal(r.results[0].ok, true)
})

test('notify: channels=all iterates every registered channel', async () => {
  globalThis[REGISTRY_KEY] = {
    feishu: feishuEntry(),
    qq: feishuEntry(),
  }
  const r = await sendChannelNotify({ channels: 'all', content: 'x' })
  assert.deepEqual(r.results.map((x) => x.channel), ['feishu', 'qq'])
  assert.equal(r.results.every((x) => x.ok), true)
  assert.equal(r.summary, '渠道通知：2/2 个发送成功')
})

test('notify: unregistered channel reports honestly alongside registered ones', async () => {
  globalThis[REGISTRY_KEY] = { feishu: feishuEntry() }
  const r = await sendChannelNotify({ channels: 'weixin', content: 'x' })
  assert.equal(r.results[0].ok, false)
  assert.match(r.results[0].error, /渠道未注册/)
})

test('notify: no recent chat → clear error suggesting explicit target', async () => {
  const entry = feishuEntry({ recentChat: () => null })
  globalThis[REGISTRY_KEY] = { feishu: entry }
  const r = await sendChannelNotify({ channels: 'feishu', content: 'x' })
  assert.equal(r.results[0].ok, false)
  assert.match(r.results[0].error, /无通知目标/)
})

test('notify: explicit target (p2p:oc_9) bypasses recentChat', async () => {
  const entry = feishuEntry()
  globalThis[REGISTRY_KEY] = { feishu: entry }
  const r = await sendChannelNotify({ channels: 'feishu', content: 'x', target: 'p2p:oc_9' })
  assert.equal(r.results[0].ok, true)
  assert.equal(r.results[0].target, 'p2p:oc_9')
  assert.deepEqual(entry.calls[0].chat, { kind: 'p2p', id: 'oc_9' })
})

test('notify: malformed explicit target → error', async () => {
  const entry = feishuEntry()
  globalThis[REGISTRY_KEY] = { feishu: entry }
  const r = await sendChannelNotify({ channels: 'feishu', content: 'x', target: 'garbage' })
  assert.equal(r.results[0].ok, false)
  assert.equal(entry.calls.length, 0) // 没有发起任何发送
})

test('notify: send throwing does not break other channels', async () => {
  globalThis[REGISTRY_KEY] = {
    feishu: feishuEntry({ send: async () => { throw new Error('网络炸了') } }),
    qq: feishuEntry(),
  }
  const r = await sendChannelNotify({ channels: 'all', content: 'x' })
  assert.equal(r.results[0].ok, false)
  assert.match(r.results[0].error, /网络炸了/)
  assert.equal(r.results[1].ok, true) // 第二个渠道不受影响
})

test('notify: send returning ok:false surfaces the channel error verbatim', async () => {
  const entry = feishuEntry({ send: async () => ({ ok: false, error: 'Feishu API 99999: token expired' }) })
  globalThis[REGISTRY_KEY] = { feishu: entry }
  const r = await sendChannelNotify({ channels: 'feishu', content: 'x' })
  assert.equal(r.results[0].ok, false)
  assert.equal(r.results[0].error, 'Feishu API 99999: token expired')
})

// ---------------------------------------------------------------------------
// notifyToolDefinition：工具定义
// ---------------------------------------------------------------------------

test('notify tool: schema stays DSH-compatible (no type arrays, top-level required only)', async () => {
  const tool = notifyToolDefinition(sendChannelNotify)
  // 与 coi.test.js 同款递归检查：type 必须单一字符串、required 只能是数组
  const walk = (node, path, container = false) => {
    if (node === null || typeof node !== 'object') return
    if (!container) {
      if (typeof node.type === 'object') throw new Error(`schema ${path}.type 必须是单一字符串: ${JSON.stringify(node.type)}`)
      if (Object.hasOwn(node, 'required') && !Array.isArray(node.required)) {
        throw new Error(`schema ${path}.required 必须是数组: ${JSON.stringify(node.required)}`)
      }
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, `${path}.${key}`, key === 'properties')
    }
  }
  walk(tool.parameters, tool.name)
  walk(tool.output.schema, `${tool.name}.output`)
  // content 必填；channels 枚举含一期飞书与二期扩展
  assert.ok(tool.parameters.required.includes('content'))
  assert.deepEqual(tool.parameters.properties.channels.enum, ['feishu', 'qq', 'weixin', 'wecom', 'all'])
  // output 必须声明 schema + render（DSH 硬要求）
  assert.ok(tool.output.schema && typeof tool.output.render === 'function')
  // execute 必须存在（2026-08-09 实测踩坑：漏写 execute 导致
  // "tool.execute is not a function"，工具注册成功但一调用就报错）
  assert.ok(typeof tool.execute === 'function', 'de_notify 工具必须有 execute')
  // execute 转发发送内核：直接调用（不依赖 exec）
  const entry = feishuEntry()
  globalThis[REGISTRY_KEY] = { feishu: entry }
  const r = await tool.execute({ channels: 'feishu', content: '通过 execute 发送' })
  assert.equal(r.results[0].ok, true)
  assert.equal(entry.calls[0].content, '通过 execute 发送')
})

test('notify tool: render shows time anchor, per-channel result and summary', () => {
  const tool = notifyToolDefinition(sendChannelNotify)
  const blocks = tool.output.render({}, {
    results: [
      { channel: 'feishu', ok: true, error: '', messageId: 'om_9', target: 'p2p:oc_1' },
      { channel: 'qq', ok: false, error: '渠道未注册：对应插件未安装，或插件版本不含通知钩子', messageId: '', target: '' },
    ],
    summary: '渠道通知：1/2 个发送成功',
  })
  const text = blocks[0].text
  assert.match(text, /⏰ 当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/) // 秒级时间锚点
  assert.match(text, /✅ feishu：已发送（目标 p2p:oc_1，消息 id om_9）/)
  assert.match(text, /❌ qq：发送失败——渠道未注册/) // 失败如实呈现不掩盖
  assert.match(text, /📊 渠道通知：1\/2 个发送成功/)
})

// ---------------------------------------------------------------------------
// 运行时开关
// ---------------------------------------------------------------------------

test('notifyEnabled: RUNTIME_KEYS + validateRuntimePatch + 默认关', () => {
  assert.ok(RUNTIME_KEYS.includes('notifyEnabled'))
  validateRuntimePatch('notifyEnabled', true)
  validateRuntimePatch('notifyEnabled', false)
  assert.throws(() => validateRuntimePatch('notifyEnabled', 'yes'), /布尔/)
  const config = resolveConfig({})
  assert.equal(config.notifyEnabled, false) // 独立开关默认关（与其他模块一致）
})

// ---------------------------------------------------------------------------
// buildNotify：COI 完成自动通知（lib/coi/index.js）
// ---------------------------------------------------------------------------

test('buildNotify: no config at all → undefined (zero overhead)', () => {
  assert.equal(buildNotify({ coiNotifyCommand: null, coiNotifyChannels: null }, {}), undefined)
  assert.equal(buildNotify({ coiNotifyCommand: null, coiNotifyChannels: '' }, {}), undefined)
})

test('buildNotify: channels-only config sends channel notification with template', async () => {
  const sent = []
  const notify = buildNotify(
    { coiNotifyCommand: null, coiNotifyChannels: 'feishu' },
    { sendChannelNotify: async (opts) => { sent.push(opts) } },
  )
  assert.ok(typeof notify === 'function')
  await notify({ taskId: 't-1', coi: 'grok', status: 'completed', summary: '搞定了一个大活\n第二行' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].channels, 'feishu')
  // 邮件式模板断言（用户拍板 2026-08-09）：开头保留 [COI] 标记行；
  // 主题/简介/发送人/时间齐全；summary 压缩换行、简介 60 字、内容放最后
  const c = sent[0].content
  assert.match(c, /^\[COI\] 任务 t-1（grok）completed\n/)
  assert.match(c, /📮 主题：任务完成：t-1（grok）/)
  assert.match(c, /📝 简介：搞定了一个大活 第二行/)
  assert.match(c, /👤 发送人：DSH AI 助手/)
  assert.match(c, /🕐 时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
  assert.match(c, /📄 内容\n搞定了一个大活 第二行$/)
})

test('buildChannelContent: email-style template slices intro to 60 and body to 120', () => {
  const long = '甲'.repeat(80) + '|' + '乙'.repeat(80)
  const c = buildChannelContent('t-5', 'codex', 'completed', long)
  // 简介=前 60 字；内容=前 120 字放最后；发送人/时间字段存在
  assert.ok(c.includes(`📝 简介：${'甲'.repeat(60)}`))
  assert.ok(c.includes(`📄 内容\n${'甲'.repeat(80)}|${'乙'.repeat(39)}`))
  assert.ok(c.includes('👤 发送人：DSH AI 助手（dsh-memory-evolve）'))
})

test('buildNotify: command + channels coexist', async () => {
  const sent = []
  const notify = buildNotify(
    { coiNotifyCommand: 'echo done', coiNotifyChannels: 'feishu,qq' },
    { sendChannelNotify: async (opts) => { sent.push(opts) } },
  )
  assert.ok(typeof notify === 'function')
  await notify({ taskId: 't-2', coi: 'codex', status: 'failed', summary: 'x' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].channels, 'feishu,qq') // 逗号分隔多渠道原样透传
})

test('buildNotify: channels configured but sendChannelNotify absent → silent skip', async () => {
  // notify 模块未启用时主插件传 undefined 回调：必须静默跳过、不抛错
  const notify = buildNotify({ coiNotifyCommand: null, coiNotifyChannels: 'feishu' }, {})
  assert.ok(typeof notify === 'function')
  await notify({ taskId: 't-3', coi: 'kimi', status: 'completed', summary: 'x' }) // 不抛即通过
})

test('buildNotify: sendChannelNotify throwing → notification failure does not crash', async () => {
  const notify = buildNotify(
    { coiNotifyCommand: null, coiNotifyChannels: 'feishu' },
    { sendChannelNotify: async () => { throw new Error('boom') } },
  )
  await notify({ taskId: 't-4', coi: 'grok', status: 'completed', summary: 'x' }) // 不抛即通过
})

// ---------------------------------------------------------------------------
// 2026-08-10 扩展：attachments 附件（de_notify）+ de_channel_send 直发（四渠道）
// ---------------------------------------------------------------------------

test('notify: attachments send via sendMedia after content, one result per item', async () => {
  const entry = feishuEntry()
  globalThis[REGISTRY_KEY] = { feishu: entry }
  const r = await sendChannelNotify({
    channels: 'feishu',
    content: '任务完成',
    attachments: [
      { kind: 'image', path: '/tmp/a.png', caption: '截图' },
      { kind: 'file', url: 'https://x.com/r.pdf' },
    ],
  })
  // content 1 条 + 附件 2 条 = 3 个结果
  assert.equal(r.results.length, 3)
  assert.equal(r.results.every((x) => x.ok), true)
  assert.equal(entry.calls.length, 3)
  assert.equal(entry.calls[0].content, '任务完成') // 文本走 send
  assert.equal(entry.calls[1].media.kind, 'image') // 附件走 sendMedia
  assert.equal(entry.calls[2].media.kind, 'file')
  assert.equal(r.summary, '渠道通知：3/3 个发送成功')
})

test('notify: attachments with channel lacking sendMedia → honest version error', async () => {
  // 旧版渠道插件：只有 send 没有 sendMedia
  const entry = feishuEntry({ sendMedia: undefined })
  globalThis[REGISTRY_KEY] = { feishu: entry }
  const r = await sendChannelNotify({
    channels: 'feishu',
    content: '正文照发',
    attachments: [{ kind: 'image', path: '/tmp/a.png' }],
  })
  // 文本照发成功，附件如实报「版本不支持」
  assert.equal(r.results.length, 2)
  assert.equal(r.results[0].ok, true)
  assert.equal(r.results[1].ok, false)
  assert.match(r.results[1].error, /不支持附件发送/)
  assert.equal(entry.calls.length, 1) // 只有文本调用
})

test('feishu direct: content only → single text sendMedia (no notify annotation)', async () => {
  const entry = feishuEntry()
  globalThis[REGISTRY_KEY] = { feishu: entry }
  const r = await sendChannelDirect({ content: '直接发给你' })
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0].ok, true)
  assert.equal(entry.calls.length, 1)
  assert.equal(entry.calls[0].media.kind, 'text')
  assert.equal(entry.calls[0].media.content, '直接发给你')
  assert.equal(r.summary, '渠道直发：1/1 个发送成功')
})

test('feishu direct: content + attachments merges content into first caption', async () => {
  const entry = feishuEntry()
  globalThis[REGISTRY_KEY] = { feishu: entry }
  const r = await sendChannelDirect({
    content: '这是报告',
    attachments: [
      { kind: 'file', path: '/tmp/r.pdf' },
      { kind: 'image', path: '/tmp/p.png', caption: '原说明' },
    ],
  })
  assert.equal(r.results.length, 2)
  assert.equal(entry.calls.length, 2) // 不单独发文本，只有两条附件
  assert.equal(entry.calls[0].media.caption, '这是报告') // content 并入第一条 caption
  assert.equal(entry.calls[1].media.caption, '原说明') // 第二条保留自己的 caption
})

test('feishu direct: neither content nor attachments → clear error', async () => {
  globalThis[REGISTRY_KEY] = { feishu: feishuEntry() }
  const r = await sendChannelDirect({})
  assert.equal(r.results[0].ok, false)
  assert.match(r.results[0].error, /至少提供 content/)
})

test('feishu direct: channel missing or lacking sendMedia → honest error', async () => {
  const r1 = await sendChannelDirect({ content: 'x' }) // 无注册表
  assert.equal(r1.results[0].ok, false)
  assert.match(r1.results[0].error, /渠道未注册/)
  globalThis[REGISTRY_KEY] = { feishu: feishuEntry({ sendMedia: undefined }) }
  const r2 = await sendChannelDirect({ content: 'x' }) // 旧版插件
  assert.equal(r2.results[0].ok, false)
  assert.match(r2.results[0].error, /不支持主动发送/)
})

test('feishu send tool: DSH-compatible schema and execute forwarding', async () => {
  const tool = channelSendToolDefinition(sendChannelDirect)
  const walk = (node, path, container = false) => {
    if (node === null || typeof node !== 'object') return
    if (!container) {
      if (typeof node.type === 'object') throw new Error(`schema ${path}.type 必须是单一字符串`)
      if (Object.hasOwn(node, 'required') && !Array.isArray(node.required)) {
        throw new Error(`schema ${path}.required 必须是数组`)
      }
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, `${path}.${key}`, key === 'properties')
    }
  }
  walk(tool.parameters, tool.name)
  walk(tool.output.schema, `${tool.name}.output`)
  assert.ok(tool.output.schema && typeof tool.output.render === 'function')
  assert.ok(typeof tool.execute === 'function')
  assert.equal(tool.name, 'de_channel_send')
  assert.deepEqual(tool.parameters.properties.channels.enum, ['feishu', 'qq', 'weixin', 'wecom', 'all'])
  assert.deepEqual(tool.parameters.properties.attachments.items.properties.kind.enum, ['image', 'file'])
  // execute 转发直发内核
  const entry = feishuEntry()
  globalThis[REGISTRY_KEY] = { feishu: entry }
  const r = await tool.execute({ content: 'execute 直发' })
  assert.equal(r.results[0].ok, true)
  assert.equal(entry.calls[0].media.content, 'execute 直发')
})

test('channelSendEnabled: RUNTIME_KEYS + validateRuntimePatch + 默认开', () => {
  assert.ok(RUNTIME_KEYS.includes('channelSendEnabled'))
  validateRuntimePatch('channelSendEnabled', true)
  validateRuntimePatch('channelSendEnabled', false)
  assert.throws(() => validateRuntimePatch('channelSendEnabled', 'yes'), /布尔/)
  const config = resolveConfig({})
  // 2026-08-10 用户拍板：直发功能默认开启（开箱即用），与 notifyEnabled 默认关不同
  assert.equal(config.channelSendEnabled, true)
})

test('channel direct: channels=qq routes to the qq entry (四渠道泛化)', async () => {
  const qqEntry = feishuEntry()
  globalThis[REGISTRY_KEY] = { qq: qqEntry }
  const r = await sendChannelDirect({ channels: 'qq', content: '发给QQ' })
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0].channel, 'qq')
  assert.equal(r.results[0].ok, true)
  assert.equal(qqEntry.calls[0].media.kind, 'text')
  assert.equal(qqEntry.calls[0].media.content, '发给QQ')
  assert.equal(r.summary, '渠道直发：1/1 个发送成功')
})

test('channel direct: channels=all iterates every registered channel', async () => {
  const feishu = feishuEntry()
  const wecom = feishuEntry()
  globalThis[REGISTRY_KEY] = { feishu, wecom }
  const r = await sendChannelDirect({ channels: 'all', content: '群发', attachments: [{ kind: 'image', path: '/tmp/x.png' }] })
  assert.deepEqual(r.results.map((x) => x.channel), ['feishu', 'wecom'])
  assert.equal(r.results.length, 2) // 各渠道 1 条媒体
  assert.equal(r.results.every((x) => x.ok), true)
  assert.equal(feishu.calls[0].media.kind, 'image')
  assert.equal(wecom.calls[0].media.kind, 'image')
})

test('channel direct: channels=all iterates only registered channels', async () => {
  // 'all' 语义与 de_notify 一致：只遍历**已注册**的渠道（未注册的不出现）
  globalThis[REGISTRY_KEY] = { feishu: feishuEntry() }
  const r = await sendChannelDirect({ channels: 'all', content: 'x' })
  assert.deepEqual(r.results.map((x) => x.channel), ['feishu'])
  assert.equal(r.results[0].ok, true)
})

// ---------------------------------------------------------------------------
// 2026-08-11 P1：「输入框图片→渠道」桥——本会话图片引用（sessionImage / attachmentId）
// ---------------------------------------------------------------------------

/** 构造一个 260810 风格的本会话事件列表（含 ImageBlock 的四个载体）。 */
function makeEvents() {
  return [
    // ① user/message 直接 content 带 image block
    { type: 'user/message', seq: 0, time: 1000, data: { content: [
      { type: 'text', text: '看图' },
      { type: 'image', attachment: { attachmentId: 'sha256:aaa', mediaType: 'image/png', bytes: 100, width: 10, height: 10, name: 'a.png' } },
    ] } },
    // ② assistant/message 的 message.content
    { type: 'assistant/message', seq: 1, time: 2000, data: { message: { content: [
      { type: 'image', attachment: { attachmentId: 'sha256:bbb', mediaType: 'image/jpeg', bytes: 200, width: 20, height: 20 } },
    ] } } },
    // ③ inserted 数组载体
    { type: 'user/message', seq: 2, time: 3000, data: { inserted: [
      { content: [{ type: 'image', attachment: { attachmentId: 'sha256:ccc', mediaType: 'image/webp', bytes: 300, width: 30, height: 30 } }] },
    ] } },
    // ④ assistant/chunk block-end（与 ② 同图去重场景）
    { type: 'assistant/chunk', seq: 3, time: 2000, data: { chunk: { type: 'block-end', block: { type: 'image', attachment: { attachmentId: 'sha256:bbb', mediaType: 'image/jpeg', bytes: 200, width: 20, height: 20 } } } } },
    // ⑤ tool-result 嵌套 image
    { type: 'assistant/message', seq: 4, time: 4000, data: { message: { content: [
      { type: 'tool-result', content: [{ type: 'image', attachment: { attachmentId: 'sha256:ddd', mediaType: 'image/gif', bytes: 400, width: 40, height: 40 } }] },
    ] } } },
  ]
}

test('scanSessionImageRefs: collects image blocks from all four carriers, dedup-free raw order', () => {
  const refs = scanSessionImageRefs(makeEvents())
  assert.equal(refs.length, 5) // aaa/bbb(message)/ccc/bbb(chunk)/ddd——chunk 与 message 同图不算去重（扫描层不去重）
  assert.deepEqual(refs.map((r) => String(r.ref.attachmentId)), ['sha256:aaa', 'sha256:bbb', 'sha256:ccc', 'sha256:bbb', 'sha256:ddd'])
  assert.equal(refs[0].role, 'user')
  assert.equal(refs[1].role, 'assistant')
  assert.equal(refs[4].role, 'assistant')
  assert.equal(refs[0].time, 1000)
})

test('scanSessionImageRefs: non-array / empty input → empty list', () => {
  assert.deepEqual(scanSessionImageRefs(undefined), [])
  assert.deepEqual(scanSessionImageRefs([]), [])
  assert.deepEqual(scanSessionImageRefs([{ type: 'user/message', data: { content: [{ type: 'text', text: 'x' }] } }]), [])
})

/** 便捷构造：mock 插件 ctx（agents + attachments 服务）。 */
function makeSessionCtx({ events, attachments = true, readBytes = Buffer.from('fake-image-bytes') } = {}) {
  const svc = {
    get(name) {
      if (name === 'agents') {
        return { get: (sid) => sid === 'session-1' ? { session: { events } } : undefined }
      }
      if (name === 'attachments') {
        if (!attachments) return undefined
        return {
          readImage: async (ref) => ({ ref, data: new Uint8Array(readBytes) }),
        }
      }
      return undefined
    },
  }
  return svc
}

test('resolveSessionImage: sessionImage defaults to most recent image, returns base64 + inferred fileName', async () => {
  const ctx = makeSessionCtx({ events: makeEvents() })
  const media = await resolveSessionImage(ctx, 'session-1', { kind: 'image', sessionImage: true })
  assert.equal(media.kind, 'image')
  assert.equal(media.base64, Buffer.from('fake-image-bytes').toString('base64'))
  // 最近一张 = ddd（tool-result 嵌套，seq 4）→ mediaType image/gif → .gif；
  // fileName 用 attachmentId 前 8 位字母数字短名（sha256ddd → sha256dd）
  assert.equal(media.fileName, 'sha256dd.gif')
})

test('resolveSessionImage: explicit attachmentId matches only session-referenced image', async () => {
  const ctx = makeSessionCtx({ events: makeEvents() })
  const media = await resolveSessionImage(ctx, 'session-1', { kind: 'image', attachmentId: 'sha256:bbb' })
  assert.equal(media.fileName, 'sha256bb.jpg') // jpeg → .jpg
  // 未引用的 attachmentId → 如实报错（与 host session.attachment 授权一致）
  await assert.rejects(
    () => resolveSessionImage(ctx, 'session-1', { kind: 'image', attachmentId: 'sha256:zzz' }),
    /不在本会话引用中/,
  )
})

test('resolveSessionImage: honest degradation on old snapshot / no session / no image', async () => {
  // 260809 进程：attachments 服务不存在（ctx.get 返回 undefined）
  const noAtt = makeSessionCtx({ events: makeEvents(), attachments: false })
  await assert.rejects(
    () => resolveSessionImage(noAtt, 'session-1', { kind: 'image', sessionImage: true }),
    /260810/,
  )
  // 会话不在本进程（无 events）
  const noSess = makeSessionCtx({ events: undefined })
  await assert.rejects(
    () => resolveSessionImage(noSess, 'session-1', { kind: 'image', sessionImage: true }),
    /无法读取本会话事件/,
  )
  // 本会话没有图片
  const empty = makeSessionCtx({ events: [{ type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'x' }] } }] })
  await assert.rejects(
    () => resolveSessionImage(empty, 'session-1', { kind: 'image', sessionImage: true }),
    /本会话没有图片/,
  )
})

test('sendChannelDirect: sessionImage attachment resolved via exec.agent and sent as base64 image', async () => {
  const entry = feishuEntry()
  globalThis[REGISTRY_KEY] = { feishu: entry }
  const ctx = makeSessionCtx({ events: makeEvents() })
  // execute 语义：第二参 exec 携带当前会话 agent
  const exec = { agent: { session: { id: 'session-1' } } }
  const r = await sendChannelDirect(
    { channels: 'feishu', content: '转发', attachments: [{ kind: 'image', sessionImage: true }] },
    { ctx, exec },
  )
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0].ok, true)
  // 发送的是最近一张图（ddd）的 base64，content 并入 caption
  assert.equal(entry.calls[0].media.kind, 'image')
  assert.equal(entry.calls[0].media.base64, Buffer.from('fake-image-bytes').toString('base64'))
  assert.match(entry.calls[0].media.caption, /转发/)
})

test('sendChannelDirect: sessionImage without tool context (COI path) → honest error, no crash', async () => {
  const entry = feishuEntry()
  globalThis[REGISTRY_KEY] = { feishu: entry }
  // 无 ctx/exec（如 COI 自动通知调用 sendChannelNotify 的路径）
  const r = await sendChannelDirect({ channels: 'feishu', attachments: [{ kind: 'image', sessionImage: true }] }, {})
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0].ok, false)
  assert.match(r.results[0].error, /工具调用上下文/)
})

test('sendChannelNotify: sessionImage attachments resolved once, reused across channels', async () => {
  const feishu = feishuEntry()
  const wecom = feishuEntry()
  globalThis[REGISTRY_KEY] = { feishu, wecom }
  const ctx = makeSessionCtx({ events: makeEvents() })
  const exec = { agent: { session: { id: 'session-1' } } }
  const r = await sendChannelNotify(
    { channels: 'all', content: '通知', attachments: [{ kind: 'image', attachmentId: 'sha256:aaa' }] },
    { ctx, exec },
  )
  // de_notify 语义：content 走 send（文本）+ 附件走 sendMedia，每渠道 2 条 → 共 4 条
  assert.equal(r.results.length, 4)
  assert.equal(r.results.every((x) => x.ok), true)
  // 附件部分（第 2、4 条）是解析后的 base64 图片
  assert.equal(feishu.calls[1].media.base64, Buffer.from('fake-image-bytes').toString('base64'))
  assert.equal(wecom.calls[1].media.base64, Buffer.from('fake-image-bytes').toString('base64'))
})

test('querySessionImages: lists recent images newest-first with dedup', async () => {
  const ctx = makeSessionCtx({ events: makeEvents() })
  const exec = { agent: { session: { id: 'session-1' } } }
  const r = await querySessionImages(ctx, exec, { limit: 3 })
  assert.equal(r.sessionId, 'session-1')
  // 最近在前（按事件 seq 倒序）+ chunk/message 同图去重：ddd(seq4), bbb(seq3 chunk, seq1 message 去重), ccc(seq2)
  assert.deepEqual(r.images.map((i) => i.attachmentId), ['sha256:ddd', 'sha256:bbb', 'sha256:ccc'])
  assert.equal(r.images[0].mediaType, 'image/gif')
  assert.equal(r.images[0].role, 'assistant')
  assert.equal(r.images[1].role, 'assistant')
  assert.equal(r.images[2].role, 'user')
  assert.match(r.summary, /attachmentId/)
})

test('querySessionImages: no session context / no events / no images → summary explains', async () => {
  // 无 exec（无工具调用上下文）
  const ctx = makeSessionCtx({ events: makeEvents() })
  const noExec = await querySessionImages(ctx, undefined, {})
  assert.equal(noExec.sessionId, '')
  assert.match(noExec.summary, /上下文/)
  // 无事件
  const noEvents = await querySessionImages(makeSessionCtx({ events: undefined }), { agent: { session: { id: 'session-1' } } }, {})
  assert.match(noEvents.summary, /无法读取本会话事件/)
  // 会话无图片
  const empty = await querySessionImages(makeSessionCtx({ events: [{ type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'x' }] } }] }), { agent: { session: { id: 'session-1' } } }, {})
  assert.deepEqual(empty.images, [])
  assert.match(empty.summary, /没有图片/)
})

test('session_images tool: DSH-compatible schema and execute forwarding', async () => {
  const tool = sessionImagesToolDefinition(async (exec, args) => ({ sessionId: 's', images: [], summary: 'ok' }))
  assert.equal(tool.name, 'de_session_images')
  assert.equal(tool.parameters.type, 'object') // 单一 type
  assert.ok(Array.isArray(tool.parameters.required)) // 顶层 required 数组
  assert.ok(tool.output.schema && typeof tool.output.render === 'function')
  // execute 转发 (args, exec) → query(exec, args)
  const value = await tool.execute({ limit: 2 }, { agent: { session: { id: 's1' } } })
  assert.equal(value.summary, 'ok')
})

test('sessionImageQueryEnabled: RUNTIME_KEYS + validateRuntimePatch + 默认关', () => {
  assert.ok(RUNTIME_KEYS.includes('sessionImageQueryEnabled'))
  validateRuntimePatch('sessionImageQueryEnabled', false)
  validateRuntimePatch('sessionImageQueryEnabled', true)
  assert.throws(() => validateRuntimePatch('sessionImageQueryEnabled', 'yes'), /布尔值/)
  assert.equal(resolveConfig({}).sessionImageQueryEnabled, false)
})
