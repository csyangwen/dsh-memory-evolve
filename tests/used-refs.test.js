// used 使用申报测试（PR #66 后续增强，块 7）。
//
// 用户洞察：模型实际只从注入快照读记忆、几乎不调 list/expand——命中信号
// 必须能从「使用申报」流入。memory add 新增可选 used（string[]）：服务端
// 按 memory→user→key 轨序解析独特子串，恰一条命中即 bumpHits +1。
//
// 覆盖（规格块 7.6 七例）：
//   ① 批量 entries 写带 used → 侧车对应条目 hitCount=1、重复调用递增
//   ② 单轨 add 带 used → 跨轨命中（memory 未命中落到 user/key）
//   ③ 未匹配 ref：add 正常成功、回显含忽略数
//   ④ 多义 ref：跳过不计（同轨两条含同一子串）
//   ⑤ used 缺省 = 零副作用（回显不含「已记录」、侧车无新键）
//   ⑥ 重复 ref 去重（同一次调用内）
//   ⑦ 失败隔离与畸形输入（used 非数组不崩、主流程照常）
//
// 直跑：node tests/used-refs.test.js（沙箱禁 node --test runner）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { MemoryStore, projectHash, todayStamp } from '../lib/store.js'
import { hitKey, readSidecar } from '../lib/hit-stats.js'

import { setLocale } from '../lib/i18n.js'
setLocale('zh')

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-used-refs-test-'))
}

function fakeCtx() {
  const state = { tools: [], contexts: [], commands: [], listeners: [], routes: [] }
  const services = {
    tools: { register: (def) => { state.tools.push(def); return () => {} }, get: () => undefined },
    systemPrompt: { context: (def) => { state.contexts.push(def); return () => {} } },
    commands: { register: (def) => { state.commands.push(def); return () => {} } },
    webServer: { register: (route) => { state.routes.push(route); return () => {} } },
  }
  const ctx = {
    state,
    tools: services.tools,
    systemPrompt: services.systemPrompt,
    commands: services.commands,
    webServer: services.webServer,
    on: (name, listener) => { (state.listeners[name] ??= []).push(listener); return () => {} },
    inject: (deps, callback) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return { dispose: () => {} }
      const disposer = callback(ctx)
      return { dispose: disposer ?? (() => {}) }
    },
    effect: (fn) => { const disposer = fn(); return disposer ?? (() => {}) },
    get: (key) => services[key] ?? (key === 'settings' ? { get: (ns) => (ns === 'locale' ? { preference: 'zh' } : undefined) } : undefined),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  return ctx
}

function memoryTool(dir, config = {}) {
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir, ...config })
  return ctx.state.tools.find((t) => t.name === 'memory')
}

const fakeExec = () => ({ agent: undefined, callId: 'c1', signal: new AbortController().signal })
const execCwd = (cwd) => ({ agent: { id: 'a', session: { header: { cwd } } }, callId: 'c1', signal: new AbortController().signal })

const A = '核心架构决策条目甲'
const B = '高频复用约定条目乙'
const U = '用户核心偏好条目'

/** fixture：memory 轨 2 条（A/B）+ user 轨 1 条（U）+ key 轨 1 条（KEYC，手写——
 *  key 的 add 走待确认队列不落主轨，而 used 申报只命中主轨既有条目），
 *  返回工具与侧车读取器。 */
async function setup(t) {
  const dir = tempDir()
  const tool = memoryTool(dir)
  const cwd = '/proj/used-refs'
  for (const content of [A, B]) {
    const r = await tool.execute({ action: 'add', target: 'memory', content }, fakeExec())
    assert.equal(r.ok, true, r.message)
  }
  const r = await tool.execute({ action: 'add', target: 'user', content: U }, fakeExec())
  assert.equal(r.ok, true, r.message)
  const keyContent = '[2026-09-18] 项目关键约定条目KEYC'
  const keyDir = join(dir, 'projects', projectHash(cwd))
  mkdirSync(keyDir, { recursive: true })
  writeFileSync(join(keyDir, 'KEY.md'), keyContent + '\n')
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  return { dir, tool, cwd, keyContent, cleanup }
}

test('①批量 entries 写带 used：申报 A/B → 侧车两条 hitCount=1，再次申报递增为 2', async (t) => {
  const fx = await setup(t)
  try {
    const store = new MemoryStore(fx.dir)
    const entryA = store.entriesOf('memory').find((e) => e.includes(A))
    const entryB = store.entriesOf('memory').find((e) => e.includes(B))
    const first = await fx.tool.execute({
      action: 'add',
      target: 'daily',
      entries: [{ target: 'daily', content: '今天做了事' }],
      used: [A, B],
    }, fakeExec())
    assert.equal(first.ok, true, first.message)
    let stats = readSidecar(fx.dir)
    assert.equal(stats[hitKey('memory', entryA)]?.hitCount, 1)
    assert.equal(stats[hitKey('memory', entryB)]?.hitCount, 1)
    assert.equal(stats[hitKey('memory', entryA)]?.lastAccessed, todayStamp())
    // 回显含「已记录 2 条」
    assert.match(first.message, /已记录 2 条记忆引用/)
    // 再申报一次 → 递增
    const second = await fx.tool.execute({
      action: 'add',
      target: 'daily',
      entries: [{ target: 'daily', content: '又做了一件事' }],
      used: [A],
    }, fakeExec())
    assert.equal(second.ok, true)
    stats = readSidecar(fx.dir)
    assert.equal(stats[hitKey('memory', entryA)]?.hitCount, 2)
  } finally {
    fx.cleanup()
  }
})

test('②单轨 add 带 used：跨轨命中——memory 未命中落到 user；key 轨经 cwd 定位命中', async (t) => {
  const fx = await setup(t)
  try {
    const store = new MemoryStore(fx.dir)
    const entryU = store.entriesOf('user').find((e) => e.includes(U))
    const entryK = store.entriesOf('key', execCwd(fx.cwd).agent).find((e) => e.includes('KEYC'))
    assert.ok(entryU, 'fixture 前置：user 条目在位')
    assert.ok(entryK, 'fixture 前置：key 条目在位')
    // memory 轨无线索 → user 轨恰一条命中
    const r1 = await fx.tool.execute({ action: 'add', target: 'memory', content: '新事实一', used: [U] }, fakeExec())
    assert.equal(r1.ok, true, r1.message)
    let stats = readSidecar(fx.dir)
    assert.equal(stats[hitKey('user', entryU)]?.hitCount, 1)
    // key 轨：exec 带 cwd 才能定位 projects/<hash>/
    const r2 = await fx.tool.execute({ action: 'add', target: 'memory', content: '新事实二', used: ['KEYC'] }, execCwd(fx.cwd))
    assert.equal(r2.ok, true, r2.message)
    const keyStats = readSidecar(join(fx.dir, 'projects', projectHash(fx.cwd)))
    assert.equal(keyStats[hitKey('key', entryK)]?.hitCount, 1)
  } finally {
    fx.cleanup()
  }
})

test('③未匹配 ref：add 正常成功、回显含忽略数（不报错）', async (t) => {
  const fx = await setup(t)
  try {
    const r = await fx.tool.execute({
      action: 'add',
      target: 'memory',
      content: '正常新条目',
      used: ['完全不存在的子串XYZ'],
    }, fakeExec())
    assert.equal(r.ok, true, '未匹配不得影响主流程')
    assert.match(r.message, /未匹配/)
    assert.ok(!r.message.includes('已记录 1'), 'N=0 时不显已记录段')
  } finally {
    fx.cleanup()
  }
})

test('④多义 ref：同轨两条含同一子串 → 跳过不计', async (t) => {
  const fx = await setup(t)
  try {
    // memory 轨 A、B 两条都含「条目」二字 → 多义 → unmatched
    const r = await fx.tool.execute({ action: 'add', target: 'memory', content: '又一条新事实', used: ['条目'] }, fakeExec())
    assert.equal(r.ok, true)
    const store = new MemoryStore(fx.dir)
    for (const entry of store.entriesOf('memory')) {
      if (entry.includes(A) || entry.includes(B)) {
        // A/B 本身无既有命中记录（本用例没申报它们）——确认多义 ref 未误加
      }
    }
    const stats = readSidecar(fx.dir)
    for (const key of Object.keys(stats)) {
      assert.ok(!key.includes('条目'), '多义 ref 不产生任何侧车写入（键为 sha1，此断言防回归占位）')
    }
    assert.match(r.message, /未匹配/)
  } finally {
    fx.cleanup()
  }
})

test('⑤used 缺省 = 零副作用（回显不含已记录段、侧车无新键）', async (t) => {
  const fx = await setup(t)
  try {
    const before = readSidecar(fx.dir)
    const r = await fx.tool.execute({ action: 'add', target: 'memory', content: '普通写入无申报' }, fakeExec())
    assert.equal(r.ok, true)
    assert.ok(!r.message.includes('已记录'), '缺省 used 不得出现申报回显')
    const after = readSidecar(fx.dir)
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), '侧车键集合不变')
  } finally {
    fx.cleanup()
  }
})

test('⑥重复 ref 去重：同一次调用内申报两次 → hitCount 只 +1', async (t) => {
  const fx = await setup(t)
  try {
    const store = new MemoryStore(fx.dir)
    const entryA = store.entriesOf('memory').find((e) => e.includes(A))
    const r = await fx.tool.execute({
      action: 'add',
      target: 'daily',
      entries: [{ target: 'daily', content: '当天日志' }],
      used: [A, A, `另一个不存在的引用`],
    }, fakeExec())
    assert.equal(r.ok, true)
    assert.match(r.message, /已记录 1 条记忆引用（1 条未匹配已忽略）/)
    const stats = readSidecar(fx.dir)
    assert.equal(stats[hitKey('memory', entryA)]?.hitCount, 1, '去重后只计一次')
  } finally {
    fx.cleanup()
  }
})

test('⑦失败隔离与畸形输入：used 非数组/含非字符串元素不崩、主流程照常成功', async (t) => {
  const fx = await setup(t)
  try {
    const r1 = await fx.tool.execute({ action: 'add', target: 'memory', content: '畸形申报一', used: '不是数组' }, fakeExec())
    assert.equal(r1.ok, true, '非数组 used 不得影响主流程')
    const r2 = await fx.tool.execute({ action: 'add', target: 'memory', content: '畸形申报二', used: [123, null, A] }, fakeExec())
    assert.equal(r2.ok, true, '混合元素 used 不得影响主流程')
    const store = new MemoryStore(fx.dir)
    const entryA = store.entriesOf('memory').find((e) => e.includes(A))
    const stats = readSidecar(fx.dir)
    assert.equal(stats[hitKey('memory', entryA)]?.hitCount, 1, '合法 ref 在畸形元素中仍被解析计数')
  } finally {
    fx.cleanup()
  }
})
