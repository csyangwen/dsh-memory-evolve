/**
 * hit-stats 命中回填测试（autopilot-memory-lifecycle Step 2）。
 * 覆盖 AC-1.1（≥3 元素：5 条命中 3）/ AC-1.2（主轨字节不动=前缀缓存保护）
 * / AC-1.5（expand 计数）/ AC-1.6（project/daily 日志轨豁免）
 * / archived=true 子分支不计数 + 失败隔离注入必红负向。
 * 直跑：node tests/hit-stats-backfill.test.js（沙箱禁 node --test runner）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { MemoryStore, projectHash, todayStamp } from '../lib/store.js'
import { extractEntryId, legacyIdFor } from '../lib/sync/entryid.js'
import { hitKey, readSidecar, HIT_STATS_FILE } from '../lib/hit-stats.js'

// This suite pins the legacy Chinese output contract; i18n.test.js covers English.
import { setLocale } from '../lib/i18n.js'
setLocale('zh')

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-hit-backfill-test-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** Minimal fake context（与 plugin.test.js / progressive-disclosure.test.js 同款）。 */
function fakeCtx(overrides = {}) {
  const state = { tools: [], contexts: [], commands: [], listeners: [], routes: [] }
  const services = {
    tools: {
      register: (def) => { state.tools.push(def); return () => {} },
      get: () => undefined,
    },
    systemPrompt: { context: (def) => { state.contexts.push(def); return () => {} } },
    commands: { register: (def) => { state.commands.push(def); return () => {} } },
    webServer: { register: (route) => { state.routes.push(route); return () => {} } },
    ...(overrides.services ?? {}),
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
    ...overrides,
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

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

test('AC-1.1 + AC-1.2: 5 条 list 命中 3 → 侧车恰 3 条 +1；MEMORY.md 逐字节不变', async () => {
  const dir = tempDir()
  try {
    const tool = memoryTool(dir)
    // fixture：5 条 memory 条目（3 条含「命中词」，2 条不含）
    for (const content of [
      '命中词 alpha 条目一',
      '命中词 beta 条目二',
      '命中词 gamma 条目三',
      '无关 delta 条目四',
      '无关 epsilon 条目五',
    ]) {
      const added = await tool.execute({ action: 'add', target: 'memory', content }, fakeExec())
      assert.equal(added.ok, true)
    }
    const store = new MemoryStore(dir)
    const allEntries = store.entriesOf('memory', fakeExec().agent)
    assert.equal(allEntries.length, 5, 'fixture 前置：主轨恰 5 条')
    const hitEntries = allEntries.filter((e) => e.includes('命中词'))
    const missEntries = allEntries.filter((e) => !e.includes('命中词'))
    assert.equal(hitEntries.length, 3)
    assert.equal(missEntries.length, 2)

    // AC-1.2 前置基线：list 前 MEMORY.md 的 SHA256
    const memoryFile = join(dir, 'MEMORY.md')
    const beforeSha = sha256(memoryFile)

    // list filter：命中 3 条
    const listed = await tool.execute({ action: 'list', target: 'memory', filter: '命中词' }, fakeExec())
    assert.equal(listed.ok, true)
    assert.equal(listed.entries.length, 3, 'list 命中恰 3 条')

    // AC-1.2：list 后 MEMORY.md 逐字节相同（前缀缓存保护——侧车方案主轨零感知）
    assert.equal(sha256(memoryFile), beforeSha, 'list 前后 MEMORY.md SHA256 必须相同')

    // AC-1.1：侧车中恰这 3 条 hitCount=1、lastAccessed=当日；未命中 2 条无记录
    const stats = readSidecar(dir)
    assert.equal(Object.keys(stats).length, 3, '侧车恰 3 个键')
    for (const entry of hitEntries) {
      const rec = stats[hitKey('memory', entry)]
      assert.ok(rec, '命中条目有侧车记录')
      assert.equal(rec.hitCount, 1)
      assert.equal(rec.lastAccessed, todayStamp())
    }
    for (const entry of missEntries) {
      assert.equal(stats[hitKey('memory', entry)], undefined, '未命中条目不得有侧车记录')
    }

    // 再命中一次：累计 +1（强化语义）
    await tool.execute({ action: 'list', target: 'memory', filter: '命中词' }, fakeExec())
    const stats2 = readSidecar(dir)
    for (const entry of hitEntries) {
      assert.equal(stats2[hitKey('memory', entry)].hitCount, 2, '二次命中累计 +1')
    }
  } finally {
    clean(dir)
  }
})

test('AC-1.5: key 轨 expand 一次 → 对应条目 hitCount +1（原文口径）', async () => {
  const dir = tempDir()
  const cwd = '/proj/hit-expand'
  try {
    const tool = memoryTool(dir)
    const store = new MemoryStore(dir)
    const agent = { session: { header: { cwd } } }
    store.add('key', '[summary:侧车验证] 展开计数的条目全文', agent)
    const entries = store.entriesOf('key', agent)
    assert.equal(entries.length, 1)
    const id = extractEntryId(entries[0]) ?? legacyIdFor(entries[0])
    const keyDir = join(dir, 'projects', projectHash(cwd))
    // expand 前无侧车
    assert.equal(existsSync(join(keyDir, HIT_STATS_FILE)), false, 'expand 前侧车不存在')
    const expanded = await tool.execute({ action: 'expand', target: 'key', id }, execCwd(cwd))
    assert.equal(expanded.ok, true)
    const stats = readSidecar(keyDir)
    const rec = stats[hitKey('key', entries[0])]
    assert.ok(rec, 'expand 命中条目有侧车记录')
    assert.equal(rec.hitCount, 1)
    assert.equal(rec.lastAccessed, todayStamp())
    // 再 expand：+1 累计
    await tool.execute({ action: 'expand', target: 'key', id }, execCwd(cwd))
    assert.equal(readSidecar(keyDir)[hitKey('key', entries[0])].hitCount, 2)
    // expand 未知 id：不计数（不产生新键）
    const miss = await tool.execute({ action: 'expand', target: 'key', id: 'ffffffff' }, execCwd(cwd))
    assert.equal(miss.ok, false)
    assert.equal(Object.keys(readSidecar(keyDir)).length, 1, '未命中 expand 不产生侧车键')
  } finally {
    clean(dir)
  }
})

test('AC-1.6: project/daily 的 list 不产生任何侧车写入', async () => {
  const dir = tempDir()
  const cwd = '/proj/hit-log'
  try {
    const tool = memoryTool(dir)
    const exec = execCwd(cwd)
    // 先各写一条日志轨条目（走 add 直写路径）
    const addedDaily = await tool.execute({ action: 'add', target: 'daily', content: '每日日志条目' }, exec)
    assert.equal(addedDaily.ok, true)
    const addedProject = await tool.execute({ action: 'add', target: 'project', content: '项目日志条目' }, exec)
    assert.equal(addedProject.ok, true)
    // list 两轨（显式 recent 避免 protectedView 无关断言）
    const dailyList = await tool.execute({ action: 'list', target: 'daily', recent: true }, exec)
    assert.equal(dailyList.ok, true)
    assert.equal(dailyList.entries.length, 1)
    const projectList = await tool.execute({ action: 'list', target: 'project', recent: true }, exec)
    assert.equal(projectList.ok, true)
    assert.equal(projectList.entries.length, 1)
    // 断言：记忆根目录、daily 目录、项目目录都不存在 hit-stats.json
    assert.equal(existsSync(join(dir, HIT_STATS_FILE)), false, '全局侧车不得存在')
    assert.equal(existsSync(join(dir, 'daily', HIT_STATS_FILE)), false, 'daily 轨侧车不得存在')
    assert.equal(existsSync(join(dir, 'projects', projectHash(cwd), HIT_STATS_FILE)), false, '项目轨侧车不得存在')
  } finally {
    clean(dir)
  }
})

test('archived=true 子分支不计数：归档 list 命中不写侧车', async () => {
  const dir = tempDir()
  try {
    const tool = memoryTool(dir)
    await tool.execute({ action: 'add', target: 'user', content: '要归档的旧习惯' }, fakeExec())
    const archived = await tool.execute({ action: 'archive', target: 'user', match: '要归档的旧习惯' }, fakeExec())
    assert.equal(archived.ok, true)
    // 归档后主轨 list 命中 0 条（不产生新键）——先记侧车基线（应为空/不存在）
    const beforeList = await tool.execute({ action: 'list', target: 'user' }, fakeExec())
    assert.equal(beforeList.ok, true)
    assert.equal(beforeList.entries.length, 0)
    assert.equal(existsSync(join(dir, HIT_STATS_FILE)), false, '零命中 list 不产生侧车')
    // archived=true 查询命中 1 条 → 不计数
    const archivedList = await tool.execute({ action: 'list', target: 'user', archived: true }, fakeExec())
    assert.equal(archivedList.ok, true)
    assert.equal(archivedList.entries.length, 1)
    assert.equal(existsSync(join(dir, HIT_STATS_FILE)), false, 'archived=true 子分支不得写侧车')
  } finally {
    clean(dir)
  }
})

test('失败隔离注入必红: 侧车写入路径被破坏（hit-stats.json 为目录）→ list 仍正常返回', async () => {
  const dir = tempDir()
  const errors = []
  const origError = console.error
  console.error = (...args) => { errors.push(args.join(' ')) }
  try {
    const tool = memoryTool(dir)
    await tool.execute({ action: 'add', target: 'memory', content: '故障注入前的正常条目' }, fakeExec())
    // 注入故障：把侧车路径占成一个**目录** → bumpHits 的 renameSync 必失败
    // （readSync EISDIR / rename EPERM）——失败注入点在真实写路径上。
    mkdirSync(join(dir, HIT_STATS_FILE), { recursive: true })
    const listed = await tool.execute({ action: 'list', target: 'memory', filter: '正常条目' }, fakeExec())
    // 契约：侧车任何异常不得影响 list 返回
    assert.equal(listed.ok, true, '侧车故障时 list 仍须正常返回')
    assert.equal(listed.entries.length, 1, '命中结果不受侧车故障影响')
    assert.ok(errors.some((m) => m.includes('hit-stats')), '故障有 console.error 留档（必红对照：删掉 bumpHits 内层 try/catch 此断言红）')
  } finally {
    console.error = origError
    clean(dir)
  }
})

test('失败隔离注入必红（expand）: 侧车路径被破坏 → expand 仍正常返回全文', async () => {
  const dir = tempDir()
  const cwd = '/proj/hit-broken'
  try {
    const tool = memoryTool(dir)
    const store = new MemoryStore(dir)
    const agent = { session: { header: { cwd } } }
    store.add('key', '破坏侧车后仍可展开的条目', agent)
    const entries = store.entriesOf('key', agent)
    const id = extractEntryId(entries[0]) ?? legacyIdFor(entries[0])
    // 注入故障：key 轨项目目录下的侧车路径占成目录
    mkdirSync(join(dir, 'projects', projectHash(cwd), HIT_STATS_FILE), { recursive: true })
    const expanded = await tool.execute({ action: 'expand', target: 'key', id }, execCwd(cwd))
    assert.equal(expanded.ok, true, '侧车故障时 expand 仍须正常返回')
    assert.equal(expanded.entries.length, 1)
    assert.ok(expanded.entries[0].includes('破坏侧车后仍可展开的条目'))
  } finally {
    clean(dir)
  }
})

test('user 轨 list 同样计数（三轨机制一致性抽查）', async () => {
  const dir = tempDir()
  try {
    const tool = memoryTool(dir)
    await tool.execute({ action: 'add', target: 'user', content: '用户偏好简洁回答' }, fakeExec())
    const store = new MemoryStore(dir)
    const entries = store.entriesOf('user', fakeExec().agent)
    assert.equal(entries.length, 1)
    const listed = await tool.execute({ action: 'list', target: 'user', filter: '简洁' }, fakeExec())
    assert.equal(listed.ok, true)
    assert.equal(listed.entries.length, 1)
    const stats = readSidecar(dir)
    const rec = stats[hitKey('user', entries[0])]
    assert.ok(rec, 'user 轨命中条目有侧车记录')
    assert.equal(rec.hitCount, 1)
  } finally {
    clean(dir)
  }
})
