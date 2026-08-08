/**
 * dsh-memory-evolve — 会话书签模块测试。
 *
 * 覆盖：
 *   1. BookmarkStore：创建/同 seq 更新/改名/删除/按会话隔离/原子写；
 *   2. installBookmarks：状态探测、CRUD 端点、fork 端点、dispose 清理；
 *   3. buildForkSeed：fork 边界计算（atSeq 锚定/省略/超尾/无已完成轮/未完成轮）；
 *   4. forkSession：agents.create + workspace attach 全链路；
 *   5. validateRuntimePatch('bookmarkEnabled') 与 DEFAULTS 默认关。
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
    httpServer: {
      register: (route) => {
        state.routes.push(route)
        return () => { state.routes = state.routes.filter((r) => r !== route) }
      },
    },
  }
  const ctx = {
    state,
    httpServer: services.httpServer,
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

test('installBookmarks: 无 httpServer 的面可安全 dispose', () => {
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
function makeEvents() {
  const events = []
  let seq = 0
  const push = (type, extra = {}) => events.push({ seq: seq++, type, ...extra })
  // 轮 1：turn/start → user → assistant → turn/end
  push('turn/start', { turn: 1 })
  push('user/message', { turn: 1 })
  push('assistant/message', { turn: 1 })
  push('turn/end', { turn: 1 })
  // 轮 2：turn/start → user → assistant → turn/end → 尾部 out-of-band（title）
  push('turn/start', { turn: 2 })
  push('user/message', { turn: 2 })
  push('assistant/message', { turn: 2 })
  push('turn/end', { turn: 2 })
  push('session/title', {})
  return events
}

test('buildForkSeed: atSeq 锚定到 >= 该 seq 的第一个轮尾（整轮切，不切中间）', () => {
  const events = makeEvents()
  const built = buildForkSeed(events, 2) // 轮 1 assistant 消息 → 轮 1 轮尾
  assert.notEqual(built, null)
  assert.equal(built.cut, 4) // 轮 1 完整（含 turn/start）
  assert.equal(built.seed.at(-1).type, 'turn/end')
})

test('buildForkSeed: 省略 atSeq = 最后一个已完成轮；尾部 out-of-band 顺延吸收', () => {
  const events = makeEvents()
  const built = buildForkSeed(events, undefined)
  assert.notEqual(built, null)
  assert.equal(built.cut, 9) // 轮 2 轮尾 + session/title 顺延到结尾
  assert.equal(built.seed.length, 9)
})

test('buildForkSeed: atSeq 超尾回退最后一个已完成轮', () => {
  const events = makeEvents()
  const built = buildForkSeed(events, 999)
  assert.notEqual(built, null)
  assert.equal(built.cut, 9) // 最后轮尾 + session/title 顺延
})

test('buildForkSeed: 目标轮未完成（atSeq 之后无轮尾）返回 null', () => {
  const events = makeEvents()
  // 追加一个开放轮（turn/start 后无 turn/end）。
  events.push({ seq: events.length, type: 'turn/start', turn: 3 })
  events.push({ seq: events.length, type: 'user/message', turn: 3 })
  const built = buildForkSeed(events, 9) // 开放轮内的消息
  assert.equal(built, null)
})

test('buildForkSeed: 无任何已完成轮返回 null', () => {
  const events = [{ seq: 0, type: 'turn/start', turn: 1 }, { seq: 1, type: 'user/message', turn: 1 }]
  assert.equal(buildForkSeed(events, undefined), null)
})

test('forkSession: agents.create 收到 seed/meta，workspace attach 被调用', async () => {
  const events = makeEvents()
  let created = null
  let attached = null
  const ctx = {
    agents: {
      get: () => ({ session: { events, header: { cwd: '/tmp/proj' } } }),
      create: async (opts) => { created = opts },
    },
    workspace: {
      resolveByPath: async () => ({ id: 'ws-1', attachSession: async (sid) => { attached = sid } }),
    },
  }
  const result = await forkSession(ctx, 'session-src', 2)
  assert.equal(result.parentSession, 'session-src')
  assert.match(result.sessionId, /^session-[0-9a-f-]+$/)
  assert.equal(created.seed.length, 4) // 轮 1 seed（含 turn/start）
  assert.equal(created.meta.parentSession, 'session-src')
  assert.equal(created.meta.seedLength, 4)
  assert.equal(created.meta.cwd, '/tmp/proj')
  assert.equal(attached, result.sessionId)
})

test('forkSession: 会话不存在 / 目标轮未完成 → 抛业务错误', async () => {
  const events = makeEvents()
  events.push({ seq: events.length, type: 'turn/start', turn: 3 })
  const ctx = {
    // 'missing' 无 agent；其他返回带开放轮的 events。
    agents: {
      get: (sid) => (sid === 'missing' ? undefined : { session: { events, header: {} } }),
      create: async () => {},
    },
    workspace: undefined,
  }
  await assert.rejects(() => forkSession(ctx, 'missing', undefined), /不存在/)
  await assert.rejects(() => forkSession(ctx, 'session-x', 9), /尚未完成/)
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
    workspace: undefined,
    httpServer: {
      register: (route) => { state.routes.push(route); return () => {} },
    },
    inject: (deps, callback) => { callback(ctx); return { dispose: () => {} } },
    // effect 必须执行回调（installBookmarks 在 effect 里注册路由）。
    effect: (fn) => { fn(); return () => {} },
    get: () => undefined,
  }
  const installed = installBookmarks(ctx, { memoryDir: tempDir() })
  const handler = state.routes[0].handler
  // 模拟 POST /fork。
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
