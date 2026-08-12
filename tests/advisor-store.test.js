import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendFile } from 'node:fs/promises'
import { InstructionQueue, INSTRUCTION_MAX_CHARS, PENDING_MAX } from '../lib/advisor/instructions.js'
import { ReviewStore, RING_CAPACITY, RECORDS_MAX_LIMIT } from '../lib/advisor/store.js'

function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), `dsh-advisor-${tag}-`))
}

/** 内存文件系统（指令队列持久化注入）。 */
function memFs() {
  const files = new Map()
  return {
    files,
    writeFile: (path, data) => { files.set(path, data) },
    readFile: (path) => files.get(path) ?? '',
  }
}

// ---------------------------------------------------------------------------
// InstructionQueue
// ---------------------------------------------------------------------------

function makeQueue() {
  const fs = memFs()
  const queue = new InstructionQueue({
    writeFile: fs.writeFile,
    fileFor: (sessionId) => `/mem/instructions/${sessionId}.json`,
    readFile: fs.readFile,
    now: () => 1000,
  })
  return { queue, fs }
}

test('指令：add/pending 基本流 + 持久化', () => {
  const { queue, fs } = makeQueue()
  const item = queue.add('s1', '重点检查安全漏洞')
  assert.equal(item.text, '重点检查安全漏洞')
  assert.equal(item.state, 'pending')
  assert.equal(queue.pending('s1').length, 1)
  // 持久化文件存在且含指令
  assert.ok(fs.files.get('/mem/instructions/s1.json').includes('重点检查安全漏洞'))
  // 重新加载（新实例）恢复
  const queue2 = new InstructionQueue({ writeFile: fs.writeFile, fileFor: (id) => `/mem/instructions/${id}.json`, readFile: fs.readFile })
  assert.equal(queue2.pending('s1').length, 1)
})

test('指令：reserve → consume（评审成功路径）', () => {
  const { queue } = makeQueue()
  queue.add('s1', '指令一')
  queue.add('s1', '指令二')
  const reserved = queue.reserve('s1', 'review-1')
  assert.equal(reserved.length, 2)
  assert.equal(queue.pending('s1').length, 0)
  queue.consume('review-1')
  // consumed 不再出现
  assert.equal(queue.pending('s1').length, 0)
  // 其它 reviewId 的 reserve 拿不到已消费的
  assert.equal(queue.reserve('s1', 'review-2').length, 0)
})

test('指令：reserve → release（评审失败路径，释放回 pending）', () => {
  const { queue } = makeQueue()
  queue.add('s1', '指令一')
  const reserved = queue.reserve('s1', 'review-1')
  queue.release('review-1', reserved)
  assert.equal(queue.pending('s1').length, 1) // 回到 pending
  // 再次 reserve 可拿到
  const reserved2 = queue.reserve('s1', 'review-2')
  assert.equal(reserved2.length, 1)
})

// ---------------------------------------------------------------------------
// 复审修复：指令事务（高1/中3/中4）
// ---------------------------------------------------------------------------

test('指令：bind → 普通评审 reserve 跳过（Q4 防抢）；问答 reserve(ids) 精确消费', () => {
  const { queue } = makeQueue()
  const item = queue.add('s1', '问题一')
  queue.bind('s1', item.id)
  // 普通评审（无 ids）：跳过已绑定问答的指令
  assert.equal(queue.reserve('s1', 'review-1').length, 0)
  // 问答（指定 ids）：精确消费
  const reserved = queue.reserve('s1', 'review-2', { ids: [item.id] })
  assert.equal(reserved.length, 1)
  assert.equal(reserved[0].reviewId, 'review-2')
  assert.equal(reserved[0].id, item.id)
  // 绑定标记已消费（指令不再 bound）
  assert.equal(queue.pending('s1').length, 0)
})

test('指令：unbind 解除绑定（问答被拒时指令回到普通 pending 流）', () => {
  const { queue } = makeQueue()
  const item = queue.add('s1', '问题一')
  queue.bind('s1', item.id)
  queue.unbind('s1', item.id)
  // 解除后普通评审可正常 reserve
  assert.equal(queue.reserve('s1', 'review-1').length, 1)
})

test('指令：崩溃恢复——reserved 加载时恢复为 pending（不永久卡住）', () => {
  const { queue, fs } = makeQueue()
  queue.add('s1', '指令一')
  queue.reserve('s1', 'review-1') // 模拟崩溃前已 reserve
  // 模拟进程重启：同一文件系统上建新实例（旧进程 review 不可能完成）
  const queue2 = new InstructionQueue({
    writeFile: fs.writeFile,
    fileFor: (sessionId) => `/mem/instructions/${sessionId}.json`,
    readFile: fs.readFile,
  })
  // 加载后旧 reserved 应恢复为 pending（不永久卡住）
  assert.equal(queue2.pending('s1').length, 1)
  // 重新 reserve 成功（at-least-once 不丢）
  assert.equal(queue2.reserve('s1', 'review-2').length, 1)
})

test('指令：release 校验 reviewId——旧 runtime 迟到释放不误伤新 reservation', () => {
  const { queue } = makeQueue()
  const item = queue.add('s1', '指令一')
  // 旧 runtime R1 reserve 后释放（正常）
  const r1 = queue.reserve('s1', 'review-1')
  queue.release('review-1', r1)
  // 新 runtime R2 重新 reserve
  const r2 = queue.reserve('s1', 'review-2')
  assert.equal(r2.length, 1)
  // R1 的迟到 release（错误 reviewId）不得把 R2 的 reservation 恢复为 pending
  queue.release('review-1', r1)
  assert.equal(queue.pending('s1').length, 0)
  // R2 自己的 release 正常
  queue.release('review-2', r2)
  assert.equal(queue.pending('s1').length, 1)
})

test('指令：consume 只消费同 reviewId 的 reservation', () => {
  const { queue } = makeQueue()
  queue.add('s1', 'a')
  queue.reserve('s1', 'r1')
  queue.add('s1', 'b')
  queue.reserve('s1', 'r2')
  queue.consume('r1')
  // r1 的 a 已消费；r2 的 b 仍 reserved——两者都不再 pending
  assert.equal(queue.pending('s1').length, 0)
  assert.equal(queue.reserve('s1', 'r3').length, 0) // 两条都不再 pending
})

test('指令：clearPending 只清 pending，不动 reserved', () => {
  const { queue } = makeQueue()
  queue.add('s1', 'a')
  const reserved = queue.reserve('s1', 'r1')
  queue.add('s1', 'b')
  const cleared = queue.clearPending('s1')
  assert.equal(cleared, 1) // 只有 b 被清
  // a 仍 reserved，release 后可恢复
  queue.release('r1', reserved)
  assert.equal(queue.pending('s1').length, 1)
})

test('指令：校验（空/超长/pending 上限）', () => {
  const { queue } = makeQueue()
  assert.throws(() => queue.add('s1', '   '), /不能为空/)
  assert.throws(() => queue.add('s1', 'x'.repeat(INSTRUCTION_MAX_CHARS + 1)), /超长/)
  for (let i = 0; i < PENDING_MAX; i++) queue.add('s1', `指令${i}`)
  assert.throws(() => queue.add('s1', '第 21 条'), /上限/)
})

test('指令：disposeSession 清内存缓存（磁盘记录保留，可恢复）', () => {
  const { queue } = makeQueue()
  queue.add('s1', 'x')
  queue.disposeSession('s1')
  // 内存缓存已清；pending 会从磁盘重新加载（持久化语义）
  assert.equal(queue.pending('s1').length, 1)
})

// ---------------------------------------------------------------------------
// ReviewStore
// ---------------------------------------------------------------------------

/** 内存追加文件（单 writer 可测）。 */
function memAppend() {
  const chunks = []
  return {
    chunks,
    appendFile: async (path, data) => { chunks.push(String(data)) },
  }
}

function makeStore() {
  const dir = tempDir('store')
  const appender = memAppend()
  const storageErrors = []
  const store = new ReviewStore({
    recordsFile: join(dir, 'records.jsonl'),
    appendFile: appender.appendFile,
    onStorageError: (e) => storageErrors.push(e),
    readFile: (path) => appender.chunks.join(''),
    now: () => 2000,
  })
  return { store, appender, storageErrors, dir }
}

function finishedEvent(reviewId, sessionId = 's1', severity = 'nit', ts = 1000) {
  return {
    type: 'review-finished',
    reviewId,
    ts,
    sessionId,
    sessionName: '会话',
    workspace: '/proj',
    outcome: 'delivered',
    delivery: 'steer',
    note: { severity, text: '建议' },
    elapsedMs: 10,
    instructions: [],
    error: null,
  }
}

test('store：emit 分配单调 seq + 进 ring + events 游标查询', async () => {
  const { store } = makeStore()
  const e1 = store.emit({ type: 'review-started', reviewId: 'r1', ts: 1, sessionId: 's1', input: { messageCount: 1 } })
  // B12：finished 先落盘成功才进 ring——需等 writeChain
  store.emit({ type: 'review-finished', reviewId: 'r1', ts: 2, sessionId: 's1', outcome: 'delivered' }, { persist: true })
  await store.writeChain
  const q = store.queryEvents('s1')
  assert.equal(q.events.length, 2)
  assert.equal(q.gap, false)
  // after 游标
  const q2 = store.queryEvents('s1', e1.seq)
  assert.equal(q2.events.length, 1)
  assert.equal(q2.events[0].reviewId, 'r1')
  // 分会话隔离
  assert.equal(store.queryEvents('s2').events.length, 0)
})

test('store：ring 容量有界 + gap 检测', () => {
  const { store } = makeStore()
  for (let i = 0; i < RING_CAPACITY + 50; i++) {
    store.emit({ type: 'review-started', reviewId: `r${i}`, ts: i, sessionId: 's1', input: {} })
  }
  // limit 0 = 不截断（默认 limit 100 会截断）
  assert.equal(store.queryEvents('s1', undefined, 0).events.length, RING_CAPACITY)
  // 游标早于最老 → gap
  const q = store.queryEvents('s1', 1, 0)
  assert.equal(q.gap, true)
  assert.equal(q.events.length, RING_CAPACITY)
})

test('store：先磁盘后 ring（B12）——append 成功后才可见；落盘 DTO 无 seq', async () => {
  const { store, appender } = makeStore()
  // 落盘完成前 ring 不可见
  store.emit(finishedEvent('r1'), { persist: true })
  assert.equal(store.queryEvents('s1').events.length, 0) // 磁盘未完成 → 不可见
  await store.writeChain
  assert.equal(appender.chunks.length, 1)
  const parsed = JSON.parse(appender.chunks[0].trim())
  assert.equal(parsed.reviewId, 'r1')
  assert.equal(parsed.seq, undefined) // 契约：ReviewRecord 无 seq
  assert.equal(store.queryEvents('s1').events.length, 1) // 落盘成功后才进 ring
})

test('store：records 查询（筛选 + before 游标分页 + 倒序）', async () => {
  const { store } = makeStore()
  for (let i = 0; i < 8; i++) {
    store.emit(finishedEvent(`r${i}`, i % 2 === 0 ? 's1' : 's2', i % 2 === 0 ? 'nit' : 'concern', 1000 + i), { persist: true })
  }
  await store.writeChain
  // 按会话筛选
  const s1 = store.queryRecords({ sessionId: 's1' })
  assert.equal(s1.records.length, 4)
  // 按严重度筛选
  const concern = store.queryRecords({ severity: 'concern' })
  assert.equal(concern.records.length, 4)
  // 倒序：ts 最大在前
  assert.equal(store.queryRecords({ sessionId: 's1' }).records[0].reviewId, 'r6')
  // before 分页：limit 2
  const page1 = store.queryRecords({ sessionId: 's1', limit: 2 })
  assert.equal(page1.records.length, 2)
  assert.equal(page1.hasMore, true)
  assert.ok(page1.nextCursor !== null)
  const page2 = store.queryRecords({ sessionId: 's1', before: page1.nextCursor, limit: 2 })
  assert.equal(page2.records.length, 2)
  // 两页不重叠
  const ids = new Set([...page1.records, ...page2.records].map((r) => r.reviewId))
  assert.equal(ids.size, 4)
})

test('store：落盘失败发 storage-error 且 finished 不进 ring（B12）', async () => {
  const dir = tempDir('store-fail')
  const errors = []
  const store = new ReviewStore({
    recordsFile: join(dir, 'records.jsonl'),
    appendFile: async () => { throw new Error('disk full') },
    onStorageError: (e) => errors.push(e),
    readFile: () => '',
  })
  store.emit(finishedEvent('r1', 's1'), { persist: true })
  await store.writeChain
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'APPEND_FAILED')
  assert.equal(errors[0].reviewId, 'r1')
  // 未持久化的 finished 不得出现在实时流
  assert.equal(store.queryEvents('s1').events.length, 0)
})

test('store：同毫秒记录 before 分页不丢（B13b）', async () => {
  const { store } = makeStore()
  // 三条同毫秒记录（a < b < c 按 reviewId 字典序）
  store.emit(finishedEvent('a', 's1', 'nit', 1000), { persist: true })
  store.emit(finishedEvent('b', 's1', 'nit', 1000), { persist: true })
  store.emit(finishedEvent('c', 's1', 'nit', 1000), { persist: true })
  await store.writeChain
  const page1 = store.queryRecords({ limit: 1 })
  assert.equal(page1.records[0].reviewId, 'c')
  assert.ok(page1.hasMore)
  const page2 = store.queryRecords({ before: page1.nextCursor, limit: 1 })
  assert.equal(page2.records[0].reviewId, 'b')
  const page3 = store.queryRecords({ before: page2.nextCursor, limit: 1 })
  assert.equal(page3.records[0].reviewId, 'a')
  assert.equal(page3.hasMore, false)
  // 三条全部覆盖，无丢失
  const ids = new Set([page1.records[0].reviewId, page2.records[0].reviewId, page3.records[0].reviewId])
  assert.deepEqual([...ids].sort(), ['a', 'b', 'c'])
})

test('store：坏行容错（中间坏行告警、尾行残缺忽略）', () => {
  const { store, storageErrors } = makeStore()
  const lines = [
    JSON.stringify(finishedEvent('r1', 's1', 'nit', 1000)),
    '{"broken json line',
    JSON.stringify(finishedEvent('r2', 's1', 'concern', 2000)),
  ].join('\n')
  store.readFile = () => `${lines}\n半行残`
  const q = store.queryRecords({})
  assert.equal(q.records.length, 2) // 两条完整记录
  // 中间坏行告警 1 次；尾行残缺不告警
  assert.equal(storageErrors.filter((e) => e.code === 'CORRUPT_LINE').length, 1)
})

test('store：disposeSession 清 ring', () => {
  const { store } = makeStore()
  store.emit({ type: 'review-started', reviewId: 'r1', ts: 1, sessionId: 's1' })
  store.disposeSession('s1')
  assert.equal(store.queryEvents('s1').events.length, 0)
})
