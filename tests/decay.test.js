/**
 * 衰减候选报告测试（autopilot-memory-lifecycle Step 5；AC-4.1~4.6）。
 *
 * 断言鉴别力（测试策略第 3 条）：
 *   - AC-4.1 ≥3 元素输入：5 条构造（3 条超阈值：1 侧车口径 + 2 fallback
 *     口径；2 条近期/未超阈值）→ 报告含且仅含那 3 条、字段齐全；
 *   - AC-4.5 阈值边界：threshold=0 永不进候选 + salience:3 按 threshold[3]
 *     判定（180 天档）；
 *   - AC-4.4 注入必红（只读不删）：报告生成前后三个主轨文件 SHA256 不变
 *     ——删掉实现里的「只读」语义（如误调用 store.remove）此组必红。
 *
 * fixture 特性：手写主轨 + 手写侧车（hit-stats.json），日期全部静态；
 * buildDecayReport 注入 today 保证断言与真实时钟解耦。
 *
 * 直跑：node tests/decay.test.js（沙箱禁 node --test runner）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { MemoryStore, projectHash } from '../lib/store.js'
import { hitKey } from '../lib/hit-stats.js'
import { buildDecayReport, daysBetween, DECAY_REPORT_FILE, DEFAULT_DECAY_THRESHOLDS, generateDecayReport, normalizeDecayThresholds, readDecayCandidateCount } from '../lib/decay.js'
import { setLocale } from '../lib/i18n.js'

setLocale('zh')

const TODAY = '2026-09-23'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-decay-test-'))
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const CWD = '/proj/decay-cwd'
const AGENT = { id: 'a', session: { header: { cwd: CWD } } }

/**
 * AC-4.1 fixture：5 条 memory 条目（today=2026-09-23 口径）——
 *   A: salience:1 + 侧车 2026-08-01 → 53 天 > 30 → 候选（侧车口径）
 *   B: salience:2 + 侧车 2026-09-20 → 3 天 ≤ 90 → 不候选（近期命中）
 *   C: salience:2 无侧车 + 条目日期 2026-03-01 → 206 天 > 90 → 候选（fallback）
 *   D: salience:1 无侧车 + 条目日期 2026-08-01 → 53 天 > 30 → 候选（fallback）
 *   E: salience:3 + 侧车 2026-09-01 → 22 天 ≤ 180 → 不候选（高档未超）
 * 期望：报告含且仅含 {A, C, D}，fallbackCount=2。
 */
const MEMORY_ENTRIES = [
  '[2026-05-01] [salience:1] 陈旧低档条目 A（侧车口径）',
  '[2026-05-02] [salience:2] 近期命中条目 B（不应进候选）',
  '[2026-03-01] [salience:2] 陈旧中档条目 C（fallback 口径）',
  '[2026-08-01] [salience:1] 陈旧低档条目 D（fallback 口径）',
  '[2026-06-01] [salience:3] 高档条目 E（高档未超阈值）',
]

/** 组装 fixture 目录：建 key 轨项目目录 + 近期 KEY.md（不应进候选）。 */
function setupStore(dir) {
  const keyDir = join(dir, 'projects', projectHash(CWD))
  rmSync(keyDir, { recursive: true, force: true })
  mkdirSync(keyDir, { recursive: true })
  writeFileSync(join(keyDir, 'KEY.md'), '[2026-09-22] 关键记忆近期条目（不应进候选）\n')
}

test('AC-4.1 + AC-4.2: 5 条筛出恰 3 条候选（≥3 元素），侧车/ fallback 口径字段齐全', () => {
  const dir = tempDir()
  try {
    setupStore(dir)
    writeFileSync(join(dir, 'MEMORY.md'), MEMORY_ENTRIES.join('\n§\n') + '\n')
    writeFileSync(join(dir, 'USER.md'), '[2026-09-22] 用户档案近期条目（不应进候选）\n')
    const store = new MemoryStore(dir)
    // 侧车：memory 的 A/B/E 有记录（按条目原文键），C/D 无记录（走 fallback）；
    // user/key 轨近期条目也给侧车（避免无谓 fallback 计数干扰断言）
    const entries = store.entriesOf('memory', AGENT)
    assert.equal(entries.length, 5, 'fixture 前置：memory 恰 5 条')
    const byMark = (mark) => entries.find((e) => e.includes(mark))
    const userEntries = store.entriesOf('user', AGENT)
    const keyEntries = store.entriesOf('key', AGENT)
    // 侧车目录约定（hit-stats.js 头注）：memory/user 落记忆根、key 落
    // 项目目录 projects/<id>/hit-stats.json——fixture 按约定分别落位。
    const sidecar = {
      [hitKey('memory', byMark('条目 A'))]: { hitCount: 3, lastAccessed: '2026-08-01' },
      [hitKey('memory', byMark('条目 B'))]: { hitCount: 9, lastAccessed: '2026-09-20' },
      [hitKey('memory', byMark('条目 E'))]: { hitCount: 1, lastAccessed: '2026-09-01' },
      [hitKey('user', userEntries[0])]: { hitCount: 2, lastAccessed: '2026-09-22' },
    }
    writeFileSync(join(dir, 'hit-stats.json'), JSON.stringify(sidecar, null, 2))
    writeFileSync(
      join(dir, 'projects', projectHash(CWD), 'hit-stats.json'),
      JSON.stringify({ [hitKey('key', keyEntries[0])]: { hitCount: 4, lastAccessed: '2026-09-22' } }),
    )

    const report = buildDecayReport(store, AGENT, DEFAULT_DECAY_THRESHOLDS, { today: TODAY })
    // 含且仅含 A/C/D（≥3 元素鉴别：串接实现会在报告里混入 B/E，取首个实现只会出 1 条）
    assert.equal(report.candidates.length, 3, `期望恰 3 条候选，实得 ${report.candidates.length}`)
    const marks = report.candidates.map((c) => c.hash)
    const expectHash = (mark) => hitKey('memory', byMark(mark))
    assert.ok(marks.includes(expectHash('条目 A')), 'A（侧车 53 天 > 30）必须是候选')
    assert.ok(marks.includes(expectHash('条目 C')), 'C（fallback 206 天 > 90）必须是候选')
    assert.ok(marks.includes(expectHash('条目 D')), 'D（fallback 53 天 > 30）必须是候选')
    assert.ok(!marks.includes(expectHash('条目 B')), 'B（近期命中 3 天）不得进候选')
    assert.ok(!marks.includes(expectHash('条目 E')), 'E（高档 22 天 < 180）不得进候选')
    // 字段契约（AC-4.1：track/hash/lastAccessed/days/threshold/salience/reason）
    for (const c of report.candidates) {
      for (const field of ['track', 'id', 'hash', 'lastAccessed', 'fallbackDate', 'days', 'threshold', 'salience', 'reason']) {
        assert.ok(Object.hasOwn(c, field), `候选条目缺字段 ${field}`)
      }
      assert.equal(c.track, 'memory')
      assert.ok(typeof c.days === 'number' && c.days > 0)
      assert.ok(c.days > c.threshold, '候选判据自洽：days > threshold')
      assert.ok([1, 2, 3].includes(c.salience))
      assert.ok(c.reason.length > 0, 'reason 非空')
    }
    // 侧车口径 vs fallback 口径逐条核对
    const candA = report.candidates.find((c) => c.hash === expectHash('条目 A'))
    assert.equal(candA.lastAccessed, '2026-08-01', 'A 用侧车日期')
    assert.equal(candA.fallbackDate, null, 'A 非 fallback')
    assert.equal(candA.threshold, 30, 'A 按 salience:1 → threshold[0]=30')
    assert.equal(candA.days, 53, 'A 距 today=2026-09-23 恰 53 天')
    const candC = report.candidates.find((c) => c.hash === expectHash('条目 C'))
    assert.equal(candC.lastAccessed, null, 'C 无侧车 → lastAccessed=null')
    assert.equal(candC.fallbackDate, '2026-03-01', 'C 回退条目时间戳')
    assert.equal(candC.threshold, 90, 'C 按 salience:2 → threshold[1]=90')
    assert.equal(candC.days, 206, 'C 距 today 恰 206 天')
    // AC-4.2：fallback 计数 = C + D
    assert.equal(report.metadata.fallbackCount, 2, 'fallbackCount 恰为 2')
    // metadata 契约
    assert.ok(typeof report.metadata.generatedAt === 'string' && report.metadata.generatedAt.length > 0)
    assert.equal(report.metadata.deviceId, '', 'deviceId 空串占位（Q2）')
    assert.deepEqual(report.metadata.thresholds, [30, 90, 180])
    // user/key 轨近期条目不进候选（扫描三轨但只有 memory 出候选）
    assert.ok(report.candidates.every((c) => c.track === 'memory'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AC-4.3 幂等：连跑两次 decay → 除 generatedAt 外报告逐字节一致（覆盖写不累积）', () => {
  const dir = tempDir()
  try {
    setupStore(dir)
    writeFileSync(join(dir, 'MEMORY.md'), MEMORY_ENTRIES.join('\n§\n') + '\n')
    writeFileSync(join(dir, 'USER.md'), '[2026-09-22] 用户档案近期条目\n')
    const store = new MemoryStore(dir)
    const entries = store.entriesOf('memory', AGENT)
    const byMark = (mark) => entries.find((e) => e.includes(mark))
    writeFileSync(join(dir, 'hit-stats.json'), JSON.stringify({
      [hitKey('memory', byMark('条目 A'))]: { hitCount: 3, lastAccessed: '2026-08-01' },
      [hitKey('memory', byMark('条目 C'))]: { hitCount: 1, lastAccessed: '2026-01-01' },
    }))
    const r1 = generateDecayReport(store, AGENT)
    const r2 = generateDecayReport(store, AGENT)
    assert.equal(r1.count, r2.count, '两次候选数一致')
    // candidates 逐字节一致（排序确定性）
    assert.equal(
      JSON.stringify(r1.report.candidates), JSON.stringify(r2.report.candidates),
      '两次 candidates JSON 逐字节一致',
    )
    // 除 generatedAt 外 metadata 一致（generatedAt 是生成时刻，必然随时间走）
    const m1 = { ...r1.report.metadata, generatedAt: null }
    const m2 = { ...r2.report.metadata, generatedAt: null }
    assert.deepEqual(m1, m2)
    // 报告文件确实落盘且为覆盖写（不累积、合法 JSON）
    const onDisk = JSON.parse(readFileSync(join(dir, DECAY_REPORT_FILE), 'utf8'))
    assert.deepEqual(onDisk, r2.report, '盘上报告 = 最后一次生成结果（覆盖写）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AC-4.4 只读派生：报告生成前后三个主轨文件 SHA256 不变', () => {
  const dir = tempDir()
  try {
    setupStore(dir)
    writeFileSync(join(dir, 'MEMORY.md'), MEMORY_ENTRIES.join('\n§\n') + '\n')
    writeFileSync(join(dir, 'USER.md'), '[2026-09-22] 用户档案近期条目\n')
    const store = new MemoryStore(dir)
    const entries = store.entriesOf('memory', AGENT)
    writeFileSync(join(dir, 'hit-stats.json'), JSON.stringify({
      [hitKey('memory', entries[0])]: { hitCount: 2, lastAccessed: '2026-05-01' },
    }))
    const keyFile = join(dir, 'projects', projectHash(CWD), 'KEY.md')
    const memoryFile = join(dir, 'MEMORY.md')
    const userFile = join(dir, 'USER.md')
    const before = [sha256(memoryFile), sha256(userFile), sha256(keyFile)]
    generateDecayReport(store, AGENT)
    const after = [sha256(memoryFile), sha256(userFile), sha256(keyFile)]
    assert.deepEqual(before, after, 'decay 只读派生：主轨文件字节不动')
    assert.ok(existsSync(join(dir, DECAY_REPORT_FILE)), '唯一新文件 = decay-report.json')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AC-4.5 阈值边界：threshold 配 0 该档永不进候选；salience:3 按 threshold[3]=180 判定', () => {
  const dir = tempDir()
  try {
    setupStore(dir)
    // 两条超旧条目：salience:1（若按 30 天早已候选）与 salience:3（按 180 判定）
    const entries = [
      '[2026-01-01] [salience:1] 极旧低档条目（threshold=0 时必须豁免）',
      '[2026-02-01] [salience:3] 极旧高档条目（按 180 天判定应候选）',
    ]
    writeFileSync(join(dir, 'MEMORY.md'), entries.join('\n§\n') + '\n')
    const store = new MemoryStore(dir)
    // 均无侧车 → fallback 口径（2026-01-01 距 today=2026-09-23 = 265 天）
    const zeroFirst = buildDecayReport(store, AGENT, [0, 90, 180], { today: TODAY })
    assert.equal(zeroFirst.candidates.length, 1, 'threshold[0]=0 → salience:1 永不进候选')
    assert.equal(zeroFirst.candidates[0].salience, 3, '唯一候选是 salience:3 条目')
    assert.equal(zeroFirst.candidates[0].threshold, 180, 'salience:3 按 threshold[2]=180 判定')
    assert.equal(zeroFirst.candidates[0].days, 234, '高档 234 天（02-01→09-23）> 180 → 候选')
    // 对照组：全部配 0 → 三档全部豁免 → 零候选
    const allZero = buildDecayReport(store, AGENT, [0, 0, 0], { today: TODAY })
    assert.equal(allZero.candidates.length, 0, '三档全 0 = 全部永不')
    // 非法阈值响亮拒绝
    assert.throws(() => normalizeDecayThresholds([30, 90]), /长度为 3/)
    assert.throws(() => normalizeDecayThresholds([30, -1, 180]), /非负整数/)
    assert.throws(() => normalizeDecayThresholds([30, 90, 'x']), /非负整数/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Minimal fake context（照 tests/hit-stats-backfill.test.js 先例：缺服务跳过 inject 回调）。 */
function fakeCtx(dir) {
  const state = { tools: [], contexts: [], commands: [], listeners: [], routes: [] }
  const services = {
    tools: { register: (def) => { state.tools.push(def); return () => {} } },
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
    get: (key) => services[key] ?? (key === 'settings' ? { get: () => ({ preference: 'zh' }) } : undefined),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  return ctx
}

function memoryTool(dir) {
  const ctx = fakeCtx(dir)
  apply(ctx, { memoryDir: dir })
  return ctx.state.tools.find((t) => t.name === 'memory')
}

const DECAY_EXEC = { agent: AGENT, callId: 'c1', signal: new AbortController().signal }

test('AC-4.6 零候选明示：空库 → 空数组报告 + decay 回显「无衰减候选」', async () => {
  const dir = tempDir()
  try {
    // 真空库：三轨全无文件（无 KEY.md——避免 KEY 条目走 fallback 干扰计数断言）
    const store = new MemoryStore(dir)
    const report = buildDecayReport(store, AGENT, DEFAULT_DECAY_THRESHOLDS, { today: TODAY })
    assert.equal(report.candidates.length, 0, '空库 → 0 候选')
    assert.equal(report.metadata.fallbackCount, 0)
    // 工具级回显（AC-4.6「工具回显明确无候选」）
    const tool = memoryTool(dir)
    assert.ok(tool, 'memory 工具已注册')
    const empty = await tool.execute({ action: 'decay', target: 'memory' }, DECAY_EXEC)
    assert.equal(empty.ok, true, 'decay 空库仍 ok')
    assert.ok(empty.message.includes('无衰减候选'), `零候选回显明示，实得: ${empty.message}`)
    assert.equal(empty.total, 0, '零候选 total=0')
    // 落盘空数组报告 + readDecayCandidateCount = 0
    const onDisk = JSON.parse(readFileSync(join(dir, DECAY_REPORT_FILE), 'utf8'))
    assert.deepEqual(onDisk.candidates, [], '空候选清单落盘')
    assert.equal(readDecayCandidateCount(dir), 0, '联动计数 0')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('decay 工具有候选回显：候选数入 message + total；报告文件可解析', async () => {
  const dir = tempDir()
  try {
    setupStore(dir)
    writeFileSync(join(dir, 'MEMORY.md'), MEMORY_ENTRIES.join('\n§\n') + '\n')
    writeFileSync(join(dir, 'USER.md'), '[2026-09-22] 用户档案近期条目\n')
    const store = new MemoryStore(dir)
    const entries = store.entriesOf('memory', AGENT)
    const byMark = (mark) => entries.find((e) => e.includes(mark))
    writeFileSync(join(dir, 'hit-stats.json'), JSON.stringify({
      [hitKey('memory', byMark('条目 A'))]: { hitCount: 3, lastAccessed: '2026-08-01' },
      [hitKey('memory', byMark('条目 B'))]: { hitCount: 9, lastAccessed: '2026-09-20' },
      [hitKey('memory', byMark('条目 C'))]: { hitCount: 0, lastAccessed: '2026-01-05' },
      [hitKey('memory', byMark('条目 D'))]: { hitCount: 0, lastAccessed: '2026-05-10' },
      [hitKey('memory', byMark('条目 E'))]: { hitCount: 1, lastAccessed: '2026-09-01' },
    }))
    const tool = memoryTool(dir)
    const out = await tool.execute({ action: 'decay', target: 'memory' }, DECAY_EXEC)
    assert.equal(out.ok, true)
    assert.equal(out.total, 3, '三轨共 3 条候选（A/C/D）')
    assert.ok(out.message.includes('3'), `回显含候选数，实得: ${out.message}`)
    const onDisk = JSON.parse(readFileSync(join(dir, DECAY_REPORT_FILE), 'utf8'))
    assert.equal(onDisk.candidates.length, 3)
    assert.equal(readDecayCandidateCount(dir), 3, '联动计数读盘 = 3')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('daysBetween 日期工具：口径与边界（负值/非法/同日/日历非法日期）', () => {
  assert.equal(daysBetween('2026-08-01', '2026-09-23'), 53)
  assert.equal(daysBetween('2026-09-23', '2026-09-23'), 0, '同日 = 0 天')
  assert.equal(daysBetween('2026-09-24', '2026-09-23'), -1, '未来日期 = 负数（恒不候选）')
  assert.equal(daysBetween('garbage', '2026-09-23'), null, '非法日期 = null')
  assert.equal(daysBetween('2026-8-1', '2026-09-23'), null, '非零填充格式不接受（侧车口径为 todayStamp）')
  assert.equal(daysBetween(null, '2026-09-23'), null)
  // P2-3 修复：日历非法日期——Date.UTC 对越界月/日自动进位（2026-13-45 →
  // 2027-02-14）产出貌似合理的天数误导候选筛选；往返校验后按解析失败返回 null。
  assert.equal(daysBetween('2026-13-45', '2026-09-23'), null, '越界月/日（Date.UTC 进位形态）= null')
  assert.equal(daysBetween('2026-02-30', '2026-09-23'), null, '2 月 30 日不存在 = null')
  assert.equal(daysBetween('2026-09-23', '2026-00-10'), null, 'to 侧非法同样 null')
})

test('key 轨无 cwd 时跳过不报错（buildDecayReport 兼容无 agent 调用）', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'MEMORY.md'), '[2026-01-01] 无 agent 场景的陈旧条目\n')
    const store = new MemoryStore(dir)
    const report = buildDecayReport(store, undefined, DEFAULT_DECAY_THRESHOLDS, { today: TODAY })
    assert.equal(report.candidates.length, 1, 'memory 轨照常扫描')
    assert.ok(report.candidates[0].track === 'memory')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('错误传播路径注入必红：主轨损坏形态（目录占位）→ decay 响亮失败回显 decayFailed（覆盖 readTrackEntries 重抛与 handler catch 兜底）', async () => {
  const dir = tempDir()
  try {
    setupStore(dir)
    const tool = memoryTool(dir)
    // 注入：MEMORY.md 占成目录 → readFileSync EISDIR（非 ENOENT）→
    // lib/decay.js readTrackEntries 的 throw error 行被触发（100% 覆盖目标），
    // 一路传到 index.js decay 分支的 catch（msg.decayFailed 回显）。
    mkdirSync(join(dir, 'MEMORY.md'))
    const out = await tool.execute({ action: 'decay', target: 'memory' }, DECAY_EXEC)
    assert.equal(out.ok, false, '损坏形态下 decay 响亮失败（不静默）')
    assert.ok(out.message.includes('衰减报告生成失败'), `实得: ${out.message}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readDecayCandidateCount 降级口径：缺失/损坏/形态不符一律 0（联动不注入的前提）', () => {
  const dir = tempDir()
  try {
    assert.equal(readDecayCandidateCount(dir), 0, '文件不存在 → 0')
    writeFileSync(join(dir, DECAY_REPORT_FILE), 'not json {{{')
    assert.equal(readDecayCandidateCount(dir), 0, '损坏 → 0')
    writeFileSync(join(dir, DECAY_REPORT_FILE), JSON.stringify({ metadata: {}, candidates: 'oops' }))
    assert.equal(readDecayCandidateCount(dir), 0, 'candidates 非数组 → 0')
    writeFileSync(join(dir, DECAY_REPORT_FILE), JSON.stringify({ metadata: {}, candidates: [{}, {}] }))
    assert.equal(readDecayCandidateCount(dir), 2, '合法报告 → 候选数')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// node 直跑自执行入口（import 方测试自带 test 注册）
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  // node:test 的 test() 已在 import 时注册并自动执行
}
