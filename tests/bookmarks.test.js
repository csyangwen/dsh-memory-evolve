/**
 * dsh-memory-evolve — 会话书签模块测试。
 *
 * 覆盖：
 *   1. BookmarkStore：创建/同 seq 更新/改名/删除/按会话隔离/原子写；
 *   2. installBookmarks：状态探测、CRUD 端点、fork 端点、dispose 清理；
 *   3. buildForkSeed：fork 边界计算（atSeq 锚定/省略/超尾/无已完成轮/未完成轮）
 *      + seq 空洞回归（issue #39：seq 不是数组下标）；
 *   4. forkSession：agents.create + workspace attach 全链路；
 *   5. parseAnchorKey / resolveAnchorKey：DSH 0.1.1-rc.2 新锚点格式解析
 *      + 按事件日志反查 seq/turn（issue #39，fixture 采用官方真实事件形状）；
 *   6. validateRuntimePatch('bookmarkEnabled') 与 DEFAULTS 默认关。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BookmarkStore,
  bookmarksPath,
  installBookmarks,
  buildForkSeed,
  forkSession,
  parseAnchorKey,
  resolveAnchorKey,
  BOOKMARK_LABEL_MAX,
  BOOKMARKS_PER_SESSION_MAX,
} from '../lib/bookmarks.js'
import { resolveConfig, validateRuntimePatch, RUNTIME_KEYS } from '../lib/index.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-bookmarks-test-'))
}

/** 与 ui-settings.test.js 同款的 fake ctx。 */
function fakeCtx() {
  const state = { routes: [] }
  const services = {
    webServer: {
      register: (route) => {
        state.routes.push(route)
        return () => { state.routes = state.routes.filter((r) => r !== route) }
      },
    },
  }
  const ctx = {
    state,
    webServer: services.webServer,
    inject: (deps, callback) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return { dispose: () => {} }
      const disposer = callback(ctx)
      return { dispose: disposer ?? (() => {}) }
    },
    effect: (fn) => {
      const disposer = fn()
      return disposer ?? (() => {})
    },
    get: (key) => services[key],
  }
  return ctx
}

/** 极简 req/res 双胞胎。 */
function fakeReqRes(method, url, body) {
  const res = { status: 0, body: '', ended: false, headers: null }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (text) => { res.body = text; res.ended = true }
  // 让 for await 能读 body（POST/PATCH/DELETE）。
  const chunks = body !== undefined
    ? [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')]
    : []
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  return { req, res }
}

// ---------------------------------------------------------------------------
// BookmarkStore
// ---------------------------------------------------------------------------

test('BookmarkStore: 创建 / 同 seq 更新 / 列表倒序 / 按会话隔离', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'session-bookmarks.json')
    assert.equal(bookmarksPath({ memoryDir: dir }), path)
    const store = new BookmarkStore(path)

    // 空列表
    assert.deepEqual(store.list('s1'), [])

    // 创建
    const a = store.upsert({
      sessionId: 's1',
      seq: 10,
      label: '关键决策',
      summary: '用户说要做书签',
      turn: 3,
    })
    assert.equal(a.created, true)
    assert.equal(a.bookmark.seq, 10)
    assert.equal(a.bookmark.label, '关键决策')
    assert.equal(a.bookmark.summary, '用户说要做书签')
    assert.equal(a.bookmark.turn, 3)
    assert.ok(a.bookmark.id.startsWith('bm_'))
    assert.ok(existsSync(path))
    // 原子写：无残留 tmp
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.tmp')), [])

    // 同 seq 再 upsert = 更新，不新建
    const b = store.upsert({
      sessionId: 's1',
      seq: 10,
      label: '改名后',
      summary: '新摘要',
      turn: 3,
    })
    assert.equal(b.created, false)
    assert.equal(b.bookmark.id, a.bookmark.id)
    assert.equal(b.bookmark.label, '改名后')
    assert.equal(store.list('s1').length, 1)

    // 另一轮
    store.upsert({ sessionId: 's1', seq: 20, turn: 5 })
    assert.equal(store.list('s1').length, 2)
    // 默认标签
    const second = store.findBySeq('s1', 20)
    assert.equal(second.label, '轮次 5')

    // 按会话隔离
    store.upsert({ sessionId: 's2', seq: 10, label: '别的会话' })
    assert.equal(store.list('s1').length, 2)
    assert.equal(store.list('s2').length, 1)
    assert.equal(store.list('s2')[0].label, '别的会话')

    // 列表倒序（最新在上）
    const list = store.list('s1')
    assert.ok(Date.parse(list[0].createdAt) >= Date.parse(list[1].createdAt))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BookmarkStore: 改名 / 删除 / 参数校验', () => {
  const dir = tempDir()
  try {
    const store = new BookmarkStore(join(dir, 'session-bookmarks.json'))
    const { bookmark } = store.upsert({ sessionId: 's1', seq: 1, label: '旧名' })

    const renamed = store.rename('s1', bookmark.id, '新名')
    assert.equal(renamed.label, '新名')
    assert.equal(store.get('s1', bookmark.id).label, '新名')

    // 空 label 拒绝
    assert.throws(() => store.rename('s1', bookmark.id, '   '), /不能为空/)
    // 不存在 id
    assert.throws(() => store.rename('s1', 'bm_nope', 'x'), /不存在/)

    // 删除
    const removed = store.remove('s1', bookmark.id)
    assert.equal(removed.ok, true)
    assert.equal(store.list('s1').length, 0)
    // 文件里 sessions.s1 被清掉
    const raw = JSON.parse(readFileSync(join(dir, 'session-bookmarks.json'), 'utf8'))
    assert.equal(raw.sessions.s1, undefined)

    // 再删一次
    assert.equal(store.remove('s1', bookmark.id).ok, false)

    // seq 校验
    assert.throws(() => store.upsert({ sessionId: 's1', seq: 0 }), /正整数/)
    assert.throws(() => store.upsert({ sessionId: 's1', seq: 1.5 }), /正整数/)
    assert.throws(() => store.upsert({ sessionId: '', seq: 1 }), /sessionId/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BookmarkStore: 标签截断与默认名', () => {
  const dir = tempDir()
  try {
    const store = new BookmarkStore(join(dir, 'b.json'))
    const long = '字'.repeat(BOOKMARK_LABEL_MAX + 20)
    const { bookmark } = store.upsert({ sessionId: 's', seq: 7, label: long })
    assert.equal(bookmark.label.length, BOOKMARK_LABEL_MAX)

    // 空 label → 默认「轮次 seq」
    const { bookmark: d } = store.upsert({ sessionId: 's', seq: 8, label: '  ' })
    assert.equal(d.label, '轮次 8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BookmarkStore: 单会话上限', () => {
  const dir = tempDir()
  try {
    const store = new BookmarkStore(join(dir, 'b.json'))
    // 直接塞满（不走真实 500 次 IO 过慢——写入内存后 save 一次不够，
    // upsert 每次都 save；用较小循环验证边界：先塞 max-1 条再触发上限）。
    // 为速度：临时改写 list 长度靠多次 upsert 会很慢，改用直接写 cache。
    const data = { version: 1, sessions: { s: [] } }
    for (let i = 1; i <= BOOKMARKS_PER_SESSION_MAX; i += 1) {
      data.sessions.s.push({
        id: `bm_${i}`,
        sessionId: 's',
        seq: i,
        label: `轮次 ${i}`,
        summary: '',
        turn: i,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }
    store.save(data)
    assert.throws(
      () => store.upsert({ sessionId: 's', seq: BOOKMARKS_PER_SESSION_MAX + 1 }),
      /上限/,
    )
    // 同 seq 更新仍允许（不占新槽）
    const r = store.upsert({ sessionId: 's', seq: 1, label: '更新' })
    assert.equal(r.created, false)
    assert.equal(r.bookmark.label, '更新')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// installBookmarks HTTP
// ---------------------------------------------------------------------------

test('installBookmarks: 状态探测 + CRUD 端点 + dispose', async () => {
  const dir = tempDir()
  try {
    const ctx = fakeCtx()
    const installed = installBookmarks(ctx, { memoryDir: dir })
    assert.equal(ctx.state.routes.length, 1)
    assert.equal(ctx.state.routes[0].path, '/memory-evolve/api/bookmarks')
    const handler = ctx.state.routes[0].handler

    // GET /state
    {
      const { req, res } = fakeReqRes('GET', '/memory-evolve/api/bookmarks/state')
      await handler(req, res)
      assert.equal(res.status, 200)
      assert.deepEqual(JSON.parse(res.body), { enabled: true })
    }

    // POST 创建
    {
      const { req, res } = fakeReqRes('POST', '/memory-evolve/api/bookmarks', {
        sessionId: 'sess-a',
        seq: 42,
        label: '里程碑',
        summary: '完成第一阶段',
        turn: 7,
      })
      await handler(req, res)
      assert.equal(res.status, 201)
      const body = JSON.parse(res.body)
      assert.equal(body.created, true)
      assert.equal(body.bookmark.seq, 42)
      assert.equal(body.bookmark.label, '里程碑')
    }

    // GET 列表
    {
      const { req, res } = fakeReqRes('GET', '/memory-evolve/api/bookmarks?sessionId=sess-a')
      await handler(req, res)
      assert.equal(res.status, 200)
      const body = JSON.parse(res.body)
      assert.equal(body.bookmarks.length, 1)
      assert.equal(body.bookmarks[0].label, '里程碑')
    }

    // GET 缺 sessionId → 400
    {
      const { req, res } = fakeReqRes('GET', '/memory-evolve/api/bookmarks')
      await handler(req, res)
      assert.equal(res.status, 400)
    }

    // PATCH 改名
    const id = installed.store.list('sess-a')[0].id
    {
      const { req, res } = fakeReqRes('PATCH', '/memory-evolve/api/bookmarks', {
        sessionId: 'sess-a',
        id,
        label: '改过的名',
      })
      await handler(req, res)
      assert.equal(res.status, 200)
      assert.equal(JSON.parse(res.body).bookmark.label, '改过的名')
    }

    // DELETE
    {
      const { req, res } = fakeReqRes('DELETE', '/memory-evolve/api/bookmarks', {
        sessionId: 'sess-a',
        id,
      })
      await handler(req, res)
      assert.equal(res.status, 200)
      assert.equal(JSON.parse(res.body).ok, true)
      assert.equal(installed.store.list('sess-a').length, 0)
    }

    // 未知路径 404
    {
      const { req, res } = fakeReqRes('GET', '/memory-evolve/api/bookmarks/other')
      await handler(req, res)
      assert.equal(res.status, 404)
    }

    // dispose 清理
    installed.dispose()
    assert.equal(ctx.state.routes.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('installBookmarks: 无 webServer 的面可安全 dispose', () => {
  const ctx = { inject: () => ({ dispose: () => {} }), effect: () => () => {} }
  const installed = installBookmarks(ctx, { memoryDir: tempDir() })
  installed.dispose()
})

// ---------------------------------------------------------------------------
// 运行时开关
// ---------------------------------------------------------------------------

test('bookmarkEnabled: RUNTIME_KEYS + validateRuntimePatch + 默认关', () => {
  assert.ok(RUNTIME_KEYS.includes('bookmarkEnabled'))
  validateRuntimePatch('bookmarkEnabled', true)
  validateRuntimePatch('bookmarkEnabled', false)
  assert.throws(() => validateRuntimePatch('bookmarkEnabled', 'yes'), /布尔/)
  const config = resolveConfig({})
  assert.equal(config.bookmarkEnabled, false)
})

// ---------------------------------------------------------------------------
// fork：buildForkSeed 边界计算 + forkSession 全链路
// ---------------------------------------------------------------------------

/** 构造一条事件序列（消息 + turn/start/turn/end 边界）。
 * ⚠️ DSH 事件 seq 是 **0-based**（core session：events[boundary].seq ===
 * boundary，数组索引即 seq），所以这里 seq 从 0 起。 */
/**
 * 官方真实事件形状的会话日志 fixture（issue #39 起替换旧的「假形状」：
 * 旧 fixture 把 turn/assistant.id 等放在事件顶层且 seq 从 0 起——与官方
 * SessionEventMap（data 包装、seq 从 1 起）不符，导致 resolve 类用例
 * 假阴性。形状实锚（DSH 0.1.2-rc.1 core SessionEventMap + ui-chat
 * message/assistant/tool Definition）：
 *   - turn/start|end     → data: { turn, ... }
 *   - user/message       → data: { id, turn, ... }（id 顶层！）
 *   - assistant/message  → data: { turn, step, message: { id, ... }, ... }
 *   - tool/call|result   → data: { turn, step, callId | message: { id }, ... }
 */
function makeEvents() {
  const events = []
  let seq = 0
  const push = (type, data = {}) => {
    events.push({ type, seq: ++seq, data })
    return events.at(-1)
  }
  // 轮 1：一轮一 step 的普通问答
  push('turn/start', { turn: 1 })
  push('user/message', { id: 'msg-u1', turn: 1, content: [] })
  push('step/start', { turn: 1, step: 1 })
  push('assistant/message', { turn: 1, step: 1, message: { id: 'msg-a1', content: [] } })
  push('step/end', { turn: 1, step: 1 })
  push('turn/end', { turn: 1 })
  // 轮 2：一轮一 step 且含工具调用
  push('turn/start', { turn: 2 })
  push('user/message', { id: 'msg-u2', turn: 2, content: [] })
  push('step/start', { turn: 2, step: 1 })
  push('tool/call', { turn: 2, step: 1, callId: 'call-1', name: 'x' })
  push('tool/result', { turn: 2, step: 1, message: { id: 'tr-1' } })
  push('assistant/message', { turn: 2, step: 1, message: { id: 'msg-a2', content: [] } })
  push('step/end', { turn: 2, step: 1 })
  push('turn/end', { turn: 2 })
  // 尾部 out-of-band（标题）——buildForkSeed 顺延吸收区
  push('session/title', { title: '测试' })
  return events
}

test('buildForkSeed: atSeq 锚定到 >= 该 seq 的第一个轮尾（整轮切，不切中间）', () => {
  const events = makeEvents()
  const built = buildForkSeed(events, 2) // 轮 1 user/message seq=2 → 轮 1 轮尾
  assert.notEqual(built, null)
  assert.equal(built.cut, 6) // 轮 1 完整（6 个事件，含 turn/start）
  assert.equal(built.seed.at(-1).type, 'turn/end')
})

test('buildForkSeed: 省略 atSeq = 最后一个已完成轮；尾部 out-of-band 顺延吸收', () => {
  const events = makeEvents()
  const built = buildForkSeed(events, undefined)
  assert.notEqual(built, null)
  assert.equal(built.cut, 15) // 轮 2 轮尾(14) + session/title(15) 顺延到结尾
  assert.equal(built.seed.length, 15)
})

test('buildForkSeed: atSeq 超尾回退最后一个已完成轮', () => {
  const events = makeEvents()
  const built = buildForkSeed(events, 999)
  assert.notEqual(built, null)
  assert.equal(built.cut, 15) // 最后轮尾 + session/title 顺延
})

test('buildForkSeed: 目标轮未完成（atSeq 之后无轮尾）返回 null', () => {
  const events = makeEvents()
  // 追加一个开放轮（turn/start 后无 turn/end）。
  events.push({ seq: events.length + 1, type: 'turn/start', data: { turn: 3 } })
  events.push({ seq: events.length + 2, type: 'user/message', data: { id: 'msg-u3', turn: 3 } })
  const built = buildForkSeed(events, 16) // 开放轮内的消息
  assert.equal(built, null)
})

test('buildForkSeed: 无任何已完成轮返回 null', () => {
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { id: 'u1', turn: 1 } },
  ]
  assert.equal(buildForkSeed(events, undefined), null)
})

test('buildForkSeed: seq 空洞会话（seq 非连续、非下标）仍按下标截断（issue #39 回归）', () => {
  // 把 seq 改成非线性（每隔一个事件 +7），模拟真实日志的 seq 空洞。
  const events = makeEvents().map((event, index) => ({ ...event, seq: index * 7 + 100000 }))
  const built = buildForkSeed(events, undefined)
  assert.notEqual(built, null)
  assert.equal(built.cut, 15, 'cut 必须与 seq 无关（按下标）')
  assert.equal(built.seed.length, 15)
  // 锚定轮 1：atSeq 用 seq 值（空洞后轮 1 user 的 seq=100007）。
  const anchored = buildForkSeed(events, 100007)
  assert.notEqual(anchored, null)
  assert.equal(anchored.cut, 6)
})

// ---------------------------------------------------------------------------
// parseAnchorKey / resolveAnchorKey（issue #39：DSH 0.1.1-rc.2 锚点格式重构）
// ---------------------------------------------------------------------------

test('parseAnchorKey: 新格式 `${kind.length}:${kind}${id}` 通用切分（不硬编码 kind 名）', () => {
  assert.deepEqual(parseAnchorKey('14:assistant-step1:1'), { kind: 'assistant-step', id: '1:1' })
  assert.deepEqual(parseAnchorKey('13:input-message911ad919-abcd'), { kind: 'input-message', id: '911ad919-abcd' })
  assert.deepEqual(parseAnchorKey('11:tool-resultcall-1'), { kind: 'tool-result', id: 'call-1' })
})

test('parseAnchorKey: 老格式 node:{seq} 与非法输入', () => {
  assert.deepEqual(parseAnchorKey('node:12'), { kind: 'node', id: '12' })
  assert.equal(parseAnchorKey('node:abc'), null)
  assert.equal(parseAnchorKey('assistant-step1:1'), null) // 无长度前缀
  assert.equal(parseAnchorKey('9:tool'), null) // kind 实际 4 字符 < 前缀声明 9
  assert.equal(parseAnchorKey('0:ok'), null) // 长度 0 非法
  assert.equal(parseAnchorKey(''), null)
  assert.equal(parseAnchorKey(null), null)
})

test('resolveAnchorKey: assistant-step 按 turn 圈定区间取轮尾 assistant/message seq', () => {
  const events = makeEvents()
  assert.deepEqual(resolveAnchorKey(events, '14:assistant-step1:1'), { seq: 4, turn: 1 })
  assert.deepEqual(resolveAnchorKey(events, '14:assistant-step2:1'), { seq: 12, turn: 2 })
  // 未知轮号 / 不在日志里 → null
  assert.equal(resolveAnchorKey(events, '14:assistant-step9:1'), null)
})

test('resolveAnchorKey: input-message 按 data.id（顶层）匹配', () => {
  const events = makeEvents()
  assert.deepEqual(resolveAnchorKey(events, '13:input-messagemsg-u1'), { seq: 2, turn: 1 })
  assert.deepEqual(resolveAnchorKey(events, '13:input-messagemsg-u2'), { seq: 8, turn: 2 })
  assert.equal(resolveAnchorKey(events, '13:input-messageunknown'), null)
})

test('resolveAnchorKey: 老格式 node:{seq} 直接还原；非法/空日志返回 null', () => {
  const events = makeEvents()
  assert.deepEqual(resolveAnchorKey(events, 'node:5'), { seq: 5, turn: null })
  assert.equal(resolveAnchorKey([], '14:assistant-step1:1'), null)
  assert.equal(resolveAnchorKey(events, 'garbage'), null)
})

test('resolveAnchorKey: 多 step 轮取最后一个 assistant/message（轮尾语义）', () => {
  const events = makeEvents()
  // 轮 3：两个 step 都有 assistant/message（step2 是最后落地内容）。
  const push = (type, data) => { events.push({ type, seq: events.length + 1, data }); return events.at(-1) }
  push('turn/start', { turn: 3 })
  push('user/message', { id: 'msg-u3', turn: 3 })
  push('step/start', { turn: 3, step: 1 })
  push('assistant/message', { turn: 3, step: 1, message: { id: 'msg-a3s1' } })
  push('step/end', { turn: 3, step: 1 })
  push('step/start', { turn: 3, step: 2 })
  push('assistant/message', { turn: 3, step: 2, message: { id: 'msg-a3s2' } })
  push('step/end', { turn: 3, step: 2 })
  push('turn/end', { turn: 3 })
  const resolved = resolveAnchorKey(events, '14:assistant-step3:2')
  assert.notEqual(resolved, null)
  assert.equal(resolved.turn, 3)
  // 轮尾锚点 = 该轮最后一个 assistant/message 的 seq。
  assert.equal(resolved.seq, events.find((e) => e.type === 'assistant/message' && e.data.step === 2).seq)
})

test('BookmarkStore: anchorKey 匹配（同 anchor 只一条）/ 旧记录 seq 回退', () => {
  const dir = tempDir()
  try {
    const store = new BookmarkStore(join(dir, 'session-bookmarks.json'))
    // 新式：带 anchorKey 创建，字段落盘。
    const a = store.upsert({
      sessionId: 's1', seq: 4, anchorKey: '14:assistant-step1:1', label: '第一轮', turn: 1,
    })
    assert.equal(a.created, true)
    assert.equal(a.bookmark.anchorKey, '14:assistant-step1:1')
    // 同 anchorKey（seq 变了也算同一轮）→ 更新不新建。
    const b = store.upsert({
      sessionId: 's1', seq: 6, anchorKey: '14:assistant-step1:1', label: '改名', turn: 1,
    })
    assert.equal(b.created, false)
    assert.equal(b.bookmark.label, '改名')
    assert.equal(store.list('s1').length, 1)
    // 旧式：无 anchorKey（seq 匹配去重，老客户端行为不变）。
    const old = store.upsert({ sessionId: 's2', seq: 8, label: '旧记录' })
    assert.equal(old.bookmark.anchorKey, null)
    const dup = store.upsert({ sessionId: 's2', seq: 8, label: '同 seq 更新' })
    assert.equal(dup.created, false)
    assert.equal(store.list('s2').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('forkSession: agents.create 收到 seed/meta，workspace attach 被调用（ownEvents 新式）', async () => {
  const events = makeEvents()
  let created = null
  let attached = null
  const ctx = {
    agents: {
      // 新式 Session：ownEvents() 返回事件日志（0.1.2-alpha.4+）。
      get: () => ({ session: { ownEvents: () => events, header: { cwd: '/tmp/proj' } } }),
      create: async (opts) => { created = opts },
    },
    workspaceRegistry: {
      resolveByPath: async () => ({ id: 'ws-1', attachSession: async (sid) => { attached = sid } }),
    },
  }
  const result = await forkSession(ctx, { sessionId: 'session-src', atSeq: 2 })
  assert.equal(result.parentSession, 'session-src')
  assert.match(result.sessionId, /^session-[0-9a-f-]+$/)
  assert.equal(created.seed.length, 6) // 轮 1 seed（含 turn/start）
  assert.equal(created.meta.parentSession, 'session-src')
  assert.equal(created.meta.seedLength, 6)
  assert.equal(created.meta.cwd, '/tmp/proj')
  assert.equal(attached, result.sessionId)

  // anchorKey 路径：反查出轮尾 seq 后再走同一 buildForkSeed 算法。
  created = null
  await forkSession(ctx, { sessionId: 'session-src', anchorKey: '14:assistant-step1:1' })
  assert.equal(created.seed.length, 6, 'anchorKey 反查后 seed 与 atSeq 路径一致')
})

test('forkSession: headless skips workspace attach and observes a later web service', async () => {
  const events = makeEvents()
  let published
  let attached = null
  const workspaceRegistry = {
    resolveByPath: async () => ({
      id: 'ws-late',
      attachSession: async (sid) => { attached = sid },
    }),
  }
  const ctx = {
    agents: {
      // 老式 Session：.events 属性（<= 0.1.1-rc 兼容路径）。
      get: () => ({ session: { events, header: { cwd: '/tmp/proj' } } }),
      create: async () => {},
    },
    get: (name) => (name === 'workspaceRegistry' ? published : undefined),
  }

  await forkSession(ctx, { sessionId: 'session-src', atSeq: 2 })
  assert.equal(attached, null, 'headless must still fork without a workspace service')

  published = workspaceRegistry
  const result = await forkSession(ctx, { sessionId: 'session-src', atSeq: 2 })
  assert.equal(attached, result.sessionId, 'a later web-host service is resolved at use time')
})

test('forkSession: 会话不存在 / 目标轮未完成 / 锚点无法解析 → 抛业务错误', async () => {
  const events = makeEvents()
  events.push({ seq: events.length + 1, type: 'turn/start', data: { turn: 3 } })
  const ctx = {
    // 'missing' 无 agent；其他返回带开放轮的 events。
    agents: {
      get: (sid) => (sid === 'missing' ? undefined : { session: { events, header: {} } }),
      create: async () => {},
    },
    workspaceRegistry: undefined,
  }
  await assert.rejects(() => forkSession(ctx, { sessionId: 'missing' }), /不存在/)
  await assert.rejects(() => forkSession(ctx, { sessionId: 'session-x', atSeq: 16 }), /尚未完成/)
  await assert.rejects(
    () => forkSession(ctx, { sessionId: 'session-x', anchorKey: '14:assistant-step9:1' }),
    /无法解析/,
  )
})

test('installBookmarks: POST /fork 端点走 forkSession 并回 201', async () => {
  const events = makeEvents()
  const state = { routes: [], created: null }
  const ctx = {
    state,
    agents: {
      get: () => ({ session: { events, header: { cwd: undefined } } }),
      create: async (opts) => { state.created = opts },
    },
    workspaceRegistry: undefined,
    webServer: {
      register: (route) => { state.routes.push(route); return () => {} },
    },
    inject: (deps, callback) => { callback(ctx); return { dispose: () => {} } },
    // effect 必须执行回调（installBookmarks 在 effect 里注册路由）。
    effect: (fn) => { fn(); return () => {} },
    get: () => undefined,
  }
  const installed = installBookmarks(ctx, { memoryDir: tempDir() })
  const handler = state.routes[0].handler
  // 模拟 POST /fork（老式 seq 直传，走兼容路径）。
  const res = { status: 0, body: '', ended: false }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => { res.body = text; res.ended = true }
  const req = { method: 'POST', url: '/memory-evolve/api/bookmarks/fork', on: () => {} }
  // readBody 需要 async iterator；用简单对象代替。
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify({ sessionId: 'session-src', seq: 2 }))
  }
  await handler(req, res)
  assert.equal(res.status, 201)
  const body = JSON.parse(res.body)
  assert.equal(body.parentSession, 'session-src')
  assert.ok(state.created, 'agents.create 被调用')
  installed.dispose()
})

test('installBookmarks: POST / 带 anchorKey 由宿主端反查 seq/turn，无法解析回 400', async () => {
  const events = makeEvents()
  const state = { routes: [] }
  const ctx = {
    state,
    agents: {
      get: () => ({ session: { ownEvents: () => events, header: { cwd: undefined } } }),
    },
    webServer: {
      register: (route) => { state.routes.push(route); return () => {} },
    },
    inject: (deps, callback) => { callback(ctx); return { dispose: () => {} } },
    effect: (fn) => { fn(); return () => {} },
    get: () => undefined,
  }
  const installed = installBookmarks(ctx, { memoryDir: tempDir() })
  const handler = state.routes[0].handler
  const post = async (body) => {
    const res = { status: 0, body: '', ended: false }
    res.writeHead = (status) => { res.status = status }
    res.end = (text) => { res.body = text; res.ended = true }
    const req = { method: 'POST', url: '/memory-evolve/api/bookmarks', on: () => {} }
    req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify(body)) }
    await handler(req, res)
    return { status: res.status, body: JSON.parse(res.body) }
  }
  // 新式：只传 anchorKey（DOM 无 seq）→ 服务端反查 seq=12 / turn=2。
  const ok = await post({ sessionId: 's1', anchorKey: '14:assistant-step2:1', label: '第二轮' })
  assert.equal(ok.status, 201)
  assert.equal(ok.body.bookmark.seq, 12)
  assert.equal(ok.body.bookmark.turn, 2)
  assert.equal(ok.body.bookmark.anchorKey, '14:assistant-step2:1')
  // anchorKey 在日志中不存在 → 400（无法解析，属于业务错误）。
  const bad = await post({ sessionId: 's1', anchorKey: '14:assistant-step9:1' })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /无法解析/)
  installed.dispose()
})
