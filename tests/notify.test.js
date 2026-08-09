/**
 * 渠道通知模块（de_notify）测试。
 *
 * 覆盖（2026-08-09 一期：飞书单渠道，方案 A 全局注册表）：
 *  - sendChannelNotify 发送内核：成功 / 渠道未注册 / 无最近交互 / 显式
 *    target / all 遍历 / send 抛异常（不中断其他渠道）/ 无注册表零影响
 *  - notifyToolDefinition：schema 与 DSH 兼容（单一 type、顶层 required）、
 *    render 输出（时间锚点、失败如实呈现、不掩盖）
 *  - buildNotify（COI 完成自动通知）：命令+渠道组合 / 只渠道 / 无配置
 *    undefined / 渠道未启用静默跳过 / 内容模板断言
 */

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  sendChannelNotify,
  notifyToolDefinition,
} from '../lib/notify.js'
import { buildNotify } from '../lib/coi/index.js'
import { resolveConfig, validateRuntimePatch, RUNTIME_KEYS } from '../lib/index.js'

const REGISTRY_KEY = '__dshChannelNotify'

// 每个用例前后清理注册表，防止测试间相互污染
beforeEach(() => { delete globalThis[REGISTRY_KEY] })
afterEach(() => { delete globalThis[REGISTRY_KEY] })

/** 便捷构造：一个可断言的 mock 飞书渠道。 */
function feishuEntry(overrides = {}) {
  const calls = []
  const entry = {
    calls,
    send: async (chat, content, opts) => { calls.push({ chat, content, opts }); return { ok: true, messageId: 'om_1' } },
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
  assert.equal(r.summary, '渠道通知：0/1 个渠道发送成功')
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
  assert.equal(r.summary, '渠道通知：1/1 个渠道发送成功')
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
  assert.equal(r.summary, '渠道通知：2/2 个渠道发送成功')
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
    summary: '渠道通知：1/2 个渠道发送成功',
  })
  const text = blocks[0].text
  assert.match(text, /⏰ 当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/) // 秒级时间锚点
  assert.match(text, /✅ feishu：已发送（目标 p2p:oc_1，消息 id om_9）/)
  assert.match(text, /❌ qq：发送失败——渠道未注册/) // 失败如实呈现不掩盖
  assert.match(text, /📊 渠道通知：1\/2 个渠道发送成功/)
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
  // 模板断言：固定前缀 + 受控占位符；summary 压缩换行并截断
  assert.match(sent[0].content, /^\[COI\] 任务 t-1（grok）completed：搞定了一个大活 第二行$/)
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
