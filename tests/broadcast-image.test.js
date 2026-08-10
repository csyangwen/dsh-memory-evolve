/**
 * 广播图片附件测试（P3 2026-08-11，260810 快照图片机制）。
 *
 * 覆盖：
 *  - sniffImage 魔数嗅探（PNG/JPEG/GIF/WebP + 非图片）
 *  - resolveAttachments 附件解析落盘（base64/path/url 三来源、大小/数量
 *    限制、非图片拒绝、失败清理原子性）
 *  - BroadcastStore.send 带附件（元数据存储、广播 JSON 只存引用）
 *  - list/read 返回附件元数据（read 含文件路径）
 *  - remove/adminRemove/read 自动删除 → 附件文件一并清理
 *  - messageToolDefinition.execute：send 附件成功 / broadcastImageEnabled
 *    关闭明确报错 / schema 与 DSH 兼容
 */

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BroadcastStore,
  sniffImage,
  resolveAttachments,
  messageToolDefinition,
} from '../lib/coi/broadcast.js'
import { resolveConfig, validateRuntimePatch, RUNTIME_KEYS } from '../lib/index.js'

/** 1x1 透明 PNG 的 base64（真实可解码的最小 PNG）。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 临时广播目录（每个用例独立，自动清理）。 */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'bcast-img-'))
  return dir
}

// ---------------------------------------------------------------------------
// sniffImage：魔数嗅探
// ---------------------------------------------------------------------------

test('sniffImage: 识别 PNG/JPEG/GIF/WebP 魔数', () => {
  assert.deepEqual(sniffImage(Buffer.from(PNG_B64, 'base64')), { mime: 'image/png', ext: '.png' })
  // JPEG：FF D8 FF
  assert.deepEqual(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])), { mime: 'image/jpeg', ext: '.jpg' })
  // GIF：'GIF8'
  assert.deepEqual(sniffImage(Buffer.from('GIF89a1234567890')), { mime: 'image/gif', ext: '.gif' })
  // WebP：RIFF....WEBP
  assert.deepEqual(sniffImage(Buffer.from('RIFF0000WEBPxxxx')), { mime: 'image/webp', ext: '.webp' })
})

test('sniffImage: 非图片/短字节返回 null', () => {
  assert.equal(sniffImage(Buffer.from('hello world this is not an image at all!')), null)
  assert.equal(sniffImage(Buffer.from([0x01, 0x02])), null) // 不足 12 字节
  assert.equal(sniffImage(Buffer.alloc(0)), null)
})

// ---------------------------------------------------------------------------
// resolveAttachments：附件解析与落盘
// ---------------------------------------------------------------------------

test('resolveAttachments: base64 来源成功落盘并返回元数据', async () => {
  const dir = tempDir()
  const r = await resolveAttachments(dir, 'msg-test-1', [{ base64: PNG_B64, fileName: '截图.png' }])
  assert.equal(r.ok, true)
  assert.equal(r.attachments.length, 1)
  const a = r.attachments[0]
  assert.equal(a.mime, 'image/png')
  assert.equal(a.name, '截图.png')
  assert.equal(a.size, Buffer.from(PNG_B64, 'base64').length)
  // 文件真实落盘在 attachments/ 子目录，文件名 = 消息id-序号.ext
  assert.ok(existsSync(a.file))
  assert.ok(a.file.includes(`msg-test-1-0.png`))
  // 落盘字节 = 解码后的图片字节（可被魔数识别）
  assert.equal(sniffImage(readFileSync(a.file)).mime, 'image/png')
  rmSync(dir, { recursive: true, force: true })
})

test('resolveAttachments: 本地路径来源成功', async () => {
  const dir = tempDir()
  const pngPath = join(dir, 'src.png')
  writeFileSync(pngPath, Buffer.from(PNG_B64, 'base64'))
  const r = await resolveAttachments(dir, 'msg-p', [{ path: pngPath, fileName: '本地图.png' }])
  assert.equal(r.ok, true)
  assert.equal(r.attachments[0].mime, 'image/png')
  rmSync(dir, { recursive: true, force: true })
})

test('resolveAttachments: http(s) URL 来源（mock fetch）成功', async () => {
  const dir = tempDir()
  const realFetch = globalThis.fetch
  // ⚠️ 不能直接返回 Buffer.from(...).buffer：Buffer 可能来自共享池，其
  // byteOffset 非零，arrayBuffer 会包含无关前缀字节（真实 fetch 的
  // arrayBuffer 是独立拷贝，无此问题——这里是 mock 的坑）
  const pngBytes = Buffer.from(PNG_B64, 'base64')
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => {
      const copy = new Uint8Array(pngBytes.length)
      copy.set(pngBytes)
      return copy.buffer
    },
  })
  try {
    const r = await resolveAttachments(dir, 'msg-u', [{ url: 'https://example.com/a.png', fileName: '远程图.png' }])
    assert.equal(r.ok, true)
    assert.equal(r.attachments[0].mime, 'image/png')
  } finally {
    globalThis.fetch = realFetch
  }
  rmSync(dir, { recursive: true, force: true })
})

test('resolveAttachments: 三来源都没有 → 报错', async () => {
  const dir = tempDir()
  const r = await resolveAttachments(dir, 'msg-x', [{ fileName: '无来源.png' }])
  assert.equal(r.ok, false)
  assert.match(r.message, /path（本地路径）\/ url（http\(s\)）\/ base64 之一/)
  rmSync(dir, { recursive: true, force: true })
})

test('resolveAttachments: 本地路径不存在 → 报错且无残留文件', async () => {
  const dir = tempDir()
  const r = await resolveAttachments(dir, 'msg-m', [{ path: join(dir, 'nope.png') }])
  assert.equal(r.ok, false)
  // 原子性：失败后 attachments 目录无文件残留（目录本身可能已创建，
  // 但绝不留孤儿附件文件——目录可能被其他消息共享，不能整目录删除）
  const attDir = join(dir, 'attachments')
  assert.equal(existsSync(attDir) && readdirSync(attDir).length > 0, false)
  rmSync(dir, { recursive: true, force: true })
})

test('resolveAttachments: 非图片字节 → 报错', async () => {
  const dir = tempDir()
  const r = await resolveAttachments(dir, 'msg-n', [{ base64: Buffer.from('not an image').toString('base64'), fileName: 'fake.png' }])
  assert.equal(r.ok, false)
  assert.match(r.message, /不是受支持的图片/)
  rmSync(dir, { recursive: true, force: true })
})

test('resolveAttachments: 超过 5 MiB → 报错', async () => {
  const dir = tempDir()
  // 构造一个超大的 PNG 魔数开头 + 填充（魔数识别成功但超大小限制）
  const big = Buffer.concat([Buffer.from(PNG_B64, 'base64'), Buffer.alloc(5 * 1024 * 1024)])
  const r = await resolveAttachments(dir, 'msg-b', [{ base64: big.toString('base64'), fileName: 'big.png' }])
  assert.equal(r.ok, false)
  assert.match(r.message, /超限/)
  rmSync(dir, { recursive: true, force: true })
})

test('resolveAttachments: 超过 10 张 → 报错', async () => {
  const dir = tempDir()
  const many = Array.from({ length: 11 }, () => ({ base64: PNG_B64, fileName: 'a.png' }))
  const r = await resolveAttachments(dir, 'msg-c', many)
  assert.equal(r.ok, false)
  assert.match(r.message, /数量超限/)
  rmSync(dir, { recursive: true, force: true })
})

test('resolveAttachments: 中途失败清理已写文件（原子性）', async () => {
  const dir = tempDir()
  // 第 1 张合法、第 2 张非法 → 整体失败且第 1 张的文件被清理
  const r = await resolveAttachments(dir, 'msg-a', [
    { base64: PNG_B64, fileName: 'ok.png' },
    { base64: Buffer.from('bad').toString('base64'), fileName: 'bad.png' },
  ])
  assert.equal(r.ok, false)
  // attachments 目录里不应残留任何文件（目录本身可能已创建，见上）
  const attDir = join(dir, 'attachments')
  assert.equal(existsSync(attDir) && readdirSync(attDir).length > 0, false)
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// BroadcastStore：send 附件 + list/read 元数据 + 清理
// ---------------------------------------------------------------------------

test('broadcast send: 带附件 → 消息存元数据、广播 JSON 只存引用', async () => {
  const dir = tempDir()
  const store = new BroadcastStore(dir)
  const resolved = await resolveAttachments(dir, 'msg-s1', [{ base64: PNG_B64, fileName: '架构图.png' }])
  const result = store.send({
    sender: 'session-a',
    recipients: ['session-b'],
    content: '看图',
    attachments: resolved.attachments,
  })
  assert.equal(result.ok, true)
  const msg = store.items.find((m) => m.id === result.item.id)
  assert.equal(msg.attachments.length, 1)
  assert.equal(msg.attachments[0].name, '架构图.png')
  assert.equal(msg.attachments[0].mime, 'image/png')
  // 广播 JSON 落盘后 attachments 仍是元数据（不含内容字节）
  const saved = JSON.parse(readFileSync(join(dir, 'broadcast.json'), 'utf8'))
  assert.equal(saved[0].attachments[0].name, '架构图.png')
  assert.equal(typeof saved[0].attachments[0].file, 'string')
  rmSync(dir, { recursive: true, force: true })
})

test('broadcast read: 返回附件元数据含文件路径；remove 一并清理附件文件', async () => {
  const dir = tempDir()
  const store = new BroadcastStore(dir)
  const resolved = await resolveAttachments(dir, 'msg-s2', [{ base64: PNG_B64, fileName: '截图.png' }])
  // 双接收者：read 一个不会触发"全员已读自动删除"（单接收者 read 即删除，
  // 附件会被自动清理，无法验证 remove 路径）
  const { item } = store.send({ sender: 'session-a', recipients: ['session-b', 'session-c'], content: 'hi', attachments: resolved.attachments })
  // read：附件元数据 + 文件路径（AI 可读/转发）
  const read = store.read(item.id, 'session-b')
  assert.equal(read.ok, true)
  assert.equal(read.item.attachments.length, 1)
  assert.equal(read.item.attachments[0].file, resolved.attachments[0].file)
  assert.ok(existsSync(resolved.attachments[0].file))
  // remove：附件文件一并清理（无孤儿文件）
  store.remove(item.id, 'session-a')
  assert.equal(existsSync(resolved.attachments[0].file), false)
  rmSync(dir, { recursive: true, force: true })
})

test('broadcast read: 显式接收者全读自动删除 → 附件文件一并清理', async () => {
  const dir = tempDir()
  const store = new BroadcastStore(dir)
  const resolved = await resolveAttachments(dir, 'msg-s3', [{ base64: PNG_B64, fileName: 'a.png' }])
  const { item } = store.send({ sender: 'session-a', recipients: ['session-b', 'session-c'], content: 'hi', attachments: resolved.attachments })
  store.read(item.id, 'session-b')
  assert.ok(existsSync(resolved.attachments[0].file)) // 未全读不删
  store.read(item.id, 'session-c')
  // 全员已读 → 消息自动删除 → 附件文件清理
  assert.equal(existsSync(resolved.attachments[0].file), false)
  assert.equal(store.items.find((m) => m.id === item.id), undefined)
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// messageToolDefinition：工具层
// ---------------------------------------------------------------------------

/** 最小工具 execute 环境（mock exec.agent）。 */
function execOf(sessionId, cwd = '/tmp') {
  return { agent: { session: { id: sessionId, header: { cwd } } } }
}

test('tool send: 附件成功发送（path 来源）', async () => {
  const dir = tempDir()
  const store = new BroadcastStore(dir)
  const tool = messageToolDefinition(store, undefined, undefined, undefined, true)
  const pngPath = join(dir, 'src.png')
  writeFileSync(pngPath, Buffer.from(PNG_B64, 'base64'))
  const r = await tool.execute({
    action: 'send',
    recipients: ['session-b'],
    content: '带图',
    attachments: [{ path: pngPath, fileName: '工具图.png' }],
  }, execOf('session-a'))
  assert.equal(r.ok, true)
  assert.match(r.message, /图片 1 张/)
  const msg = store.items[0]
  assert.equal(msg.attachments[0].name, '工具图.png')
  rmSync(dir, { recursive: true, force: true })
})

test('tool send: broadcastImageEnabled=false → 带附件明确报错、不创建消息', async () => {
  const dir = tempDir()
  const store = new BroadcastStore(dir)
  const tool = messageToolDefinition(store, undefined, undefined, undefined, false)
  const r = await tool.execute({
    action: 'send',
    recipients: ['session-b'],
    content: '带图',
    attachments: [{ base64: PNG_B64 }],
  }, execOf('session-a'))
  assert.equal(r.ok, false)
  assert.match(r.message, /broadcastImageEnabled=false/)
  assert.equal(store.items.length, 0) // 消息未创建
  rmSync(dir, { recursive: true, force: true })
})

test('tool send: 附件解析失败（非图片）→ 整体报错、消息未创建、无残留文件', async () => {
  const dir = tempDir()
  const store = new BroadcastStore(dir)
  const tool = messageToolDefinition(store, undefined, undefined, undefined, true)
  const r = await tool.execute({
    action: 'send',
    recipients: ['session-b'],
    content: '带图',
    attachments: [{ base64: Buffer.from('junk').toString('base64') }],
  }, execOf('session-a'))
  assert.equal(r.ok, false)
  assert.match(r.message, /附件处理失败/)
  assert.equal(store.items.length, 0)
  // 无孤儿附件文件（目录本身可能已创建）
  const attDir = join(dir, 'attachments')
  assert.equal(existsSync(attDir) && readdirSync(attDir).length > 0, false)
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// schema 与开关
// ---------------------------------------------------------------------------

test('tool schema: de_broadcast attachments 参数/output 与 DSH 兼容', () => {
  const store = new BroadcastStore(tempDir())
  const tool = messageToolDefinition(store, undefined, undefined, undefined, true)
  // 与 coi.test.js 同款递归检查：type 单一字符串、required 顶层数组
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
  // attachments 参数存在；output messages items 含 attachments 且 required
  assert.ok(tool.parameters.properties.attachments !== undefined)
  const msgItems = tool.output.schema.properties.messages.items
  assert.ok(msgItems.required.includes('attachments'))
})

test('broadcastImageEnabled: RUNTIME_KEYS + validateRuntimePatch + 默认开', () => {
  assert.ok(RUNTIME_KEYS.includes('broadcastImageEnabled'))
  validateRuntimePatch('broadcastImageEnabled', true)
  validateRuntimePatch('broadcastImageEnabled', false)
  assert.throws(() => validateRuntimePatch('broadcastImageEnabled', 'yes'), /布尔/)
  const config = resolveConfig({})
  assert.equal(config.broadcastImageEnabled, true) // 子开关默认开（依赖 broadcastEnabled 大开关）
})
