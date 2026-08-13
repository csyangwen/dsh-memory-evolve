import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotificationStore } from '../lib/notify-web.js'

/** 临时目录夹具。 */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-notify-web-test-'))
}

/** 组装一条最小通知输入。 */
function makeInput(overrides = {}) {
  return { sender: 'session-abc123', subject: '', content: '通知正文', ...overrides }
}

test('NotificationStore：写入/未读数/列表/已读批量/全部已读/删除', async () => {
  const dir = tempDir()
  try {
    const store = new NotificationStore(dir)
    const a = await store.add(makeInput({ content: '第一条通知' }))
    assert.equal(a.ok, true)
    const b = await store.add(makeInput({ content: '第二条通知', subject: '自定义主题' }))
    assert.equal(store.unreadCount(), 2)

    // 列表：未读视图（缺省）与全部视图
    const unread = store.list('unread')
    assert.equal(unread.length, 2)
    assert.equal(unread[0].subject, '自定义主题', '显式主题优先于首行')
    // 主题缺省 = 内容首行
    assert.equal(unread[1].subject, '第一条通知')

    // 批量已读（ids 数组）+ 未读数变化
    const hit = store.read([a.id, '不存在的 id'])
    assert.equal(hit, 1)
    assert.equal(store.unreadCount(), 1)
    assert.equal(store.list('unread').length, 1)

    // 全部已读
    assert.equal(store.readAll(), 1)
    assert.equal(store.unreadCount(), 0)

    // 删除
    assert.equal(store.remove(b.id).ok, true)
    assert.equal(store.remove(b.id).ok, false, '重复删除应报不存在')
    assert.equal(store.list('all').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('NotificationStore：长文落文件，full() 取回全文（稳定版复审覆盖：200~8KB 中长截断修复）', async () => {
  const dir = tempDir()
  try {
    const store = new NotificationStore(dir)
    // >300 字的中长文：列表预览截断、isLong=true、full() 返回全文
    const longText = '长'.repeat(500)
    const a = await store.add(makeInput({ content: longText }))
    const view = store.list('all')[0]
    assert.equal(view.isLong, true, '中长文应标记 isLong（前端据此显示查看详情）')
    assert.ok(view.content.length <= 300, '列表预览应截断')
    assert.equal(store.full(a.id), longText, 'full() 必须返回完整原文')

    // >8KB 超长文：落 bodyFile 文件，JSON 只存预览
    const huge = 'x'.repeat(9000)
    const b = await store.add(makeInput({ content: huge }))
    const viewB = store.list('all').find((v) => v.id === b.id)
    assert.equal(viewB.hasBody, true, '超长文应落 bodyFile')
    assert.equal(store.full(b.id), huge, 'bodyFile 命中时 full() 返回文件全文')
    // 删除时连带清理正文文件（不留孤儿）
    store.remove(b.id)
    const bodyFiles = readFileSync(join(dir, 'notifications', 'notifications.json'), 'utf8')
    assert.ok(!bodyFiles.includes('.txt'), '被删通知的正文文件应一并清理')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('NotificationStore：损坏的 notifications.json 按空表处理，不丢后续写入', async () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir, 'notifications'), { recursive: true })
    writeFileSync(join(dir, 'notifications', 'notifications.json'), '{ 坏 JSON')
    const store = new NotificationStore(dir)
    assert.equal(store.list('all').length, 0)
    await store.add(makeInput({ content: '恢复后写入' }))
    assert.equal(store.unreadCount(), 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('NotificationStore：附件解析失败时整条通知不落盘（含已写正文文件清理）', async () => {
  const dir = tempDir()
  try {
    const store = new NotificationStore(dir)
    // 超长正文 + 不存在的附件路径：正文文件先写、附件失败 → 整条丢弃
    const result = await store.add(makeInput({
      content: 'x'.repeat(9000),
      attachments: [{ kind: 'image', path: join(dir, 'no-such-file.png') }],
    }))
    assert.equal(result.ok, false, '附件失败应如实报错')
    assert.equal(store.list('all').length, 0, '附件失败的通知不得落盘')
    // 无孤儿 bodyFile（整条未落盘 → notifications.json 不存在或不含 .txt）
    const notifDir = join(dir, 'notifications')
    if (existsSync(join(notifDir, 'notifications.json'))) {
      const leftovers = readFileSync(join(notifDir, 'notifications.json'), 'utf8')
      assert.ok(!leftovers.includes('.txt'))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
