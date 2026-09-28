// 快照分层注入测试（autopilot-memory-lifecycle Step 4；AC-3.1~3.5 + AC-6.8）
//
// 覆盖：
//   - AC-3.1（默认零变化，负向）：off/缺省 → renderSnapshot 输出与黄金基线
//     （tests/snapshot-golden.test.js，strip 链改动前捕获）逐字节一致
//   - AC-3.2：auto + 超阈值 → 无标记与低/中 salience 摘要注入（[summary] 优先、
//     autoSummary 兜底）、[salience:3] 恒全文
//   - AC-3.3：auto + 未超阈值 → 全量注入（与 off 输出一致）
//   - AC-3.4（注入必红，防旋钮失效假绿）：同一 store 开/关两份快照必须不同
//   - AC-3.5：摘要注入段头部文案告知模型可用 list 取全文
//   - AC-6.8：新增 i18n key zh/en 齐全 + 新旋钮值合法性校验
//   - 块 6（渐进式披露 v2，2026-09-28）：memorySummaryMinChars 按条目长度折叠
//     ——正文 > 阈值折一行摘要、短条目保持全文；[salience:3] 恒全文；
//     off 模式不受本旋钮影响（仍逐字节同 golden）
//
// ⚠️ 口径说明（v2 起）：旧用例（AC-3.2 / 块5-①~④）的 fixture 条目都是**短条目**
// （< 400 字符），在 v2 的按长度折叠规则下它们本应保持全文——那会让这些用例
// 失去鉴别力（它们考的是 salience 豁免/命中豁免/显式摘要优先，不是长度规则）。
// 因此这些用例显式传 memorySummaryMinChars: 1（= 所有条目可折叠，等价 v1 的
// 「整轨全折」语义），把长度维度隔离出去，由块 6 专门覆盖。
//
// 直跑：node tests/memory-progressive-disclosure.test.js（沙箱禁 node --test runner）。
// 注：import golden 模块会连带执行其黄金基线测试（幂等只读，无害）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, renderSnapshot, resolveConfig, validateRuntimePatch } from '../lib/index.js'
import { MemoryStore, projectHash, todayStamp } from '../lib/store.js'
import { hitKey } from '../lib/hit-stats.js'
import { SNAPSHOT_DICT } from '../lib/i18n.js'
import { buildGoldenFixture, GOLDEN_ZH } from './snapshot-golden.test.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-mpd-test-'))
}
function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/**
 * 分层注入专用 fixture：memory 轨四类条目（高档/低档/显式摘要/无标记），
 * 除高档外全部为两行正文——摘要注入只保留首行（或摘要），第二行的
 * 在与不在即是「摘要化是否发生」的逐条鉴别断言。user 轨一条两行。
 */
function buildTieredFixture() {
  const dir = tempDir()
  const memoryEntries = [
    '[2026-09-20] [salience:3] 高档条目全文第一行\n高档条目全文第二行',
    '[2026-09-21] [salience:1] 低档条目第一行\n低档条目第二行',
    '[2026-09-22] [summary:显式摘要示例] 显式摘要条目第一行\n显式摘要条目第二行',
    '[2026-09-23] 无标记条目第一行\n无标记条目第二行',
  ]
  const userEntries = [
    '[2026-09-19] 用户档案条目第一行\n用户档案条目第二行',
  ]
  const CWD = '/proj/mpd-cwd'
  writeFileSync(join(dir, 'MEMORY.md'), memoryEntries.join('\n§\n') + '\n')
  writeFileSync(join(dir, 'USER.md'), userEntries.join('\n§\n') + '\n')
  const keyDir = join(dir, 'projects', projectHash(CWD))
  mkdirSync(keyDir, { recursive: true })
  writeFileSync(join(keyDir, 'KEY.md'), '[2026-09-18] 关键条目\n')
  return {
    dir,
    store: new MemoryStore(dir),
    agent: { id: 'a', session: { header: { cwd: CWD } } },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('AC-3.1 默认零变化：off/缺省的快照输出与黄金基线逐字节一致', () => {
  const fx = buildGoldenFixture()
  try {
    const byDefault = renderSnapshot(fx.config, fx.store, fx.agent)
    assert.equal(byDefault, GOLDEN_ZH, '缺省（无旋钮）= off：与 golden 基线逐字节一致')
    const offExplicit = renderSnapshot({ ...fx.config, memoryProgressiveDisclosure: 'off' }, fx.store, fx.agent)
    assert.equal(offExplicit, GOLDEN_ZH, '显式 off：与 golden 基线逐字节一致')
  } finally {
    fx.cleanup()
  }
})

test('AC-3.2 auto+超阈值：低/中/无标记摘要注入（显式 summary 优先、autoSummary 兜底），salience:3 恒全文', () => {
  const fx = buildTieredFixture()
  try {
    const cfg = resolveConfig({ memoryDir: fx.dir, memoryProgressiveDisclosure: 'auto', memoryFullInjectCharLimit: 1, memorySummaryMinChars: 1 })
    const snap = renderSnapshot(cfg, fx.store, fx.agent)
    // 摘要头文案出现（AC-3.5 一部分：含 list 指引）
    assert.ok(snap.includes('摘要模式'), 'summary-mode head must appear')
    // [salience:3] 恒全文：两行正文都在（重要性豁免）
    assert.ok(snap.includes('高档条目全文第一行'), 'salience:3 first line stays full')
    assert.ok(snap.includes('高档条目全文第二行'), 'salience:3 second line stays full')
    // 低档 [salience:1]：只留首行摘要（短 id 前缀形态），第二行不得泄漏
    assert.ok(!snap.includes('低档条目第二行'), 'salience:1 second line must be dropped in summary mode')
    assert.ok(snap.includes('低档条目第一行'), 'salience:1 first line feeds autoSummary')
    // 显式摘要优先：注入「显式摘要示例」而非正文任何一行
    assert.ok(snap.includes('显式摘要示例'), 'explicit summary wins')
    assert.ok(!snap.includes('显式摘要条目第一行') && !snap.includes('显式摘要条目第二行'), 'explicit-summary entry body must not leak')
    // 无标记条目：autoSummary 兜底取首行
    assert.ok(!snap.includes('无标记条目第二行'), 'untagged second line must be dropped')
    assert.ok(snap.includes('无标记条目第一行'), 'untagged first line feeds autoSummary')
    // user 轨同机制（连带分层）
    assert.ok(snap.includes('## 用户档案（摘要模式'), 'user track summary head appears')
    assert.ok(!snap.includes('用户档案条目第二行'), 'user track second line dropped')
  } finally {
    fx.cleanup()
  }
})

test('AC-3.3 auto+未超阈值：全量注入（与 off 输出一致）', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'MEMORY.md'), '[2026-09-20] 短条目一\n§\n[2026-09-21] 短条目二\n')
    const store = new MemoryStore(dir)
    const agent = { id: 'a', session: { header: { cwd: '/proj/mpd-small' } } }
    // 2 条 ≤ 阈值 3 且字符 ≤ 1500 → auto 全量
    const auto = renderSnapshot(resolveConfig({ memoryDir: dir, memoryProgressiveDisclosure: 'auto' }), store, agent)
    const off = renderSnapshot(resolveConfig({ memoryDir: dir, memoryProgressiveDisclosure: 'off' }), store, agent)
    assert.equal(auto, off, 'small data under auto must render exactly like off (full injection)')
    assert.ok(!auto.includes('摘要模式'))
    assert.ok(auto.includes('短条目一') && auto.includes('短条目二'))
  } finally {
    clean(dir)
  }
})

test('AC-3.4 注入必红：同一 store 开/关两份快照必须不同（防旋钮失效恒同现状的假绿）', () => {
  const fx = buildTieredFixture()
  try {
    const base = resolveConfig({ memoryDir: fx.dir })
    const off = renderSnapshot(base, fx.store, fx.agent)
    const on = renderSnapshot({ ...base, memoryProgressiveDisclosure: 'on', memorySummaryMinChars: 1 }, fx.store, fx.agent)
    assert.notStrictEqual(off, on, 'on vs off must differ — if equal the knob is dead (false green)')
    // 反向也验：auto（超阈值）与 off 必不同
    const auto = renderSnapshot({ ...base, memoryProgressiveDisclosure: 'auto', memoryFullInjectCharLimit: 1, memorySummaryMinChars: 1 }, fx.store, fx.agent)
    assert.notStrictEqual(off, auto)
  } finally {
    fx.cleanup()
  }
})

test('AC-3.5 摘要头文案告知取全文走 list；on 模式下 memory/user 轨摘要化', () => {
  const fx = buildTieredFixture()
  try {
    const cfg = resolveConfig({ memoryDir: fx.dir, memoryProgressiveDisclosure: 'on', memorySummaryMinChars: 1 })
    const snap = renderSnapshot(cfg, fx.store, fx.agent)
    assert.ok(snap.includes('list（target=memory）'), 'memory summary head must point to list target=memory')
    assert.ok(snap.includes('list（target=user）'), 'user summary head must point to list target=user')
  } finally {
    fx.cleanup()
  }
})

test('AC-6.8 新增 i18n key zh/en 成对齐全；新旋钮值校验生效', () => {
  // 新键成对（zh/en 非空——键对齐全量兜底在 tests/i18n.test.js）
  for (const key of ['snap.memorySummaryHead', 'snap.userSummaryHead']) {
    const pair = SNAPSHOT_DICT[key]
    assert.ok(Array.isArray(pair) && pair.length === 2, `${key} must carry a zh/en pair`)
    assert.ok(pair[0].length > 0 && pair[1].length > 0, `${key} zh/en both non-empty`)
  }
  // validateRuntimePatch：非法值响亮失败、合法值放行
  assert.throws(() => validateRuntimePatch('memoryProgressiveDisclosure', 'bogus'), /memoryProgressiveDisclosure/)
  assert.doesNotThrow(() => validateRuntimePatch('memoryProgressiveDisclosure', 'auto'))
  assert.doesNotThrow(() => validateRuntimePatch('memoryProgressiveDisclosure', 'on'))
  assert.doesNotThrow(() => validateRuntimePatch('memoryProgressiveDisclosure', 'off'))
  assert.throws(() => validateRuntimePatch('memoryFullInjectThreshold', 0), /正整数/)
  assert.throws(() => validateRuntimePatch('memoryFullInjectCharLimit', 1.5), /正整数/)
  assert.doesNotThrow(() => validateRuntimePatch('memoryFullInjectCharLimit', 1500))
  // resolveConfig：非法旋钮值响亮失败（配置文件路径的守门）
  assert.throws(() => resolveConfig({ memoryProgressiveDisclosure: 'sometimes' }), /memoryProgressiveDisclosure/)
  // 默认值 = off
  assert.equal(resolveConfig({}).memoryProgressiveDisclosure, 'off')
  assert.equal(resolveConfig({}).memoryFullInjectThreshold, 3)
  assert.equal(resolveConfig({}).memoryFullInjectCharLimit, 1500)
})

// ── 块 5（PR #66 后续增强）：命中驱动的存量记忆豁免 ──
// 摘要模式（auto 超阈/on）下，未标记 salience 的存量旧条目不应一刀切降为
// 一行摘要——近期被实际使用过的旧记忆保持全文注入（memoryHitExemptDays，
// 默认 30；0=关闭）。侧车手写（bumpHits 只会写今天的 lastAccessed，测试
// 需要 40 天前的超期样本）。

/** n 天前的本地 YYYY-MM-DD（与 store.js todayStamp 同为本地日期口径）。 */
function daysAgoStamp(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 手写侧车：{ [hitKey]: {hitCount, lastAccessed} }（记忆根 hit-stats.json）。 */
function writeSidecar(dir, stats) {
  writeFileSync(join(dir, 'hit-stats.json'), `${JSON.stringify(stats, null, 2)}\n`)
}

test('块5-① 新鲜命中豁免：hitCount=1 且 lastAccessed=今天 → on 模式保持全文（memory+user 双轨）', () => {
  const fx = buildTieredFixture()
  try {
    const untagged = '[2026-09-23] 无标记条目第一行\n无标记条目第二行'
    const userEntry = '[2026-09-19] 用户档案条目第一行\n用户档案条目第二行'
    writeSidecar(fx.dir, {
      [hitKey('memory', untagged)]: { hitCount: 1, lastAccessed: todayStamp() },
      [hitKey('user', userEntry)]: { hitCount: 1, lastAccessed: todayStamp() },
    })
    const cfg = resolveConfig({ memoryDir: fx.dir, memoryProgressiveDisclosure: 'on', memorySummaryMinChars: 1 })
    const snap = renderSnapshot(cfg, fx.store, fx.agent)
    // memory 轨：无标记条目因新鲜命中全文豁免（第二行保留=未被摘要化）
    assert.ok(snap.includes('无标记条目第二行'), 'freshly-hit untracked entry stays full on the memory track')
    // user 轨同机制
    assert.ok(snap.includes('用户档案条目第二行'), 'freshly-hit user entry stays full')
    // 摘要头出现（确认确实运行在摘要模式，豁免是模式内的逐条豁免）
    assert.ok(snap.includes('摘要模式'))
    // 逐条对照：同快照内未命中的低档条目仍被摘要（豁免是个体的，不是全轨的）
    assert.ok(!snap.includes('低档条目第二行'), 'non-exempt entries still summarized in the same snapshot')
  } finally {
    fx.cleanup()
  }
})

test('块5-② 命中超期：lastAccessed=40 天前 → 被摘要（豁免窗口外）', () => {
  const fx = buildTieredFixture()
  try {
    const explicitEntry = '[2026-09-22] [summary:显式摘要示例] 显式摘要条目第一行\n显式摘要条目第二行'
    writeSidecar(fx.dir, {
      [hitKey('memory', explicitEntry)]: { hitCount: 1, lastAccessed: daysAgoStamp(40) },
    })
    const cfg = resolveConfig({ memoryDir: fx.dir, memoryProgressiveDisclosure: 'on', memorySummaryMinChars: 1 })
    const snap = renderSnapshot(cfg, fx.store, fx.agent)
    assert.ok(!snap.includes('显式摘要条目第二行'), 'stale-hit entry must be summarized (second line dropped)')
    assert.ok(snap.includes('显式摘要示例'), 'stale-hit entry falls back to its explicit summary')
  } finally {
    fx.cleanup()
  }
})

test('块5-③ memoryHitExemptDays=0 关闭豁免：新鲜命中也摘要', () => {
  const fx = buildTieredFixture()
  try {
    const untagged = '[2026-09-23] 无标记条目第一行\n无标记条目第二行'
    writeSidecar(fx.dir, {
      [hitKey('memory', untagged)]: { hitCount: 1, lastAccessed: todayStamp() },
    })
    const cfg = resolveConfig({ memoryDir: fx.dir, memoryProgressiveDisclosure: 'on', memoryHitExemptDays: 0, memorySummaryMinChars: 1 })
    const snap = renderSnapshot(cfg, fx.store, fx.agent)
    assert.ok(!snap.includes('无标记条目第二行'), 'exempt disabled (0) → fresh hits are summarized too')
  } finally {
    fx.cleanup()
  }
})

test('块5-④ 无侧车文件 = 无豁免（行为与块 5 之前一致）', () => {
  const fx = buildTieredFixture()
  try {
    const cfg = resolveConfig({ memoryDir: fx.dir, memoryProgressiveDisclosure: 'on', memorySummaryMinChars: 1 })
    const snap = renderSnapshot(cfg, fx.store, fx.agent)
    assert.ok(!snap.includes('无标记条目第二行'), 'no sidecar → no exemption')
    // 摘要行形态：`- [8位短id] 摘要`（extractEntryId / legacyIdFor）
    assert.ok(/\n- \[[0-9a-f]{8}\] /.test(snap), 'summary line form preserved')
  } finally {
    fx.cleanup()
  }
})

test('块5-⑤ salience:3 恒全文豁免不依赖侧车（重要性豁免与命中豁免双通道并存）', () => {
  const fx = buildTieredFixture()
  try {
    // 无任何侧车：高档条目两行仍然全文（AC-3.2 语义在块 5 后保持）
    const cfg = resolveConfig({ memoryDir: fx.dir, memoryProgressiveDisclosure: 'on', memorySummaryMinChars: 1 })
    const snap = renderSnapshot(cfg, fx.store, fx.agent)
    assert.ok(snap.includes('高档条目全文第一行') && snap.includes('高档条目全文第二行'),
      'salience:3 stays full without any hit record')
  } finally {
    fx.cleanup()
  }
})

test('块5-⑥ off / auto 全量路径完全不受影响：带侧车的 golden fixture 下 off 仍逐字节同基线', () => {
  const fx = buildGoldenFixture()
  try {
    // 侧车给 golden fixture 的部分条目命中（含今天的新鲜命中）
    const stats = {}
    for (const entry of [
      '[2026-09-20] 纯时间戳条目（无任何附加标记）',
      '[2026-09-22] [summary:显式摘要示例] 带摘要标记的条目，正文第一行',
    ]) {
      stats[hitKey('memory', entry)] = { hitCount: 1, lastAccessed: todayStamp() }
    }
    writeSidecar(fx.dir, stats)
    // off：全量路径，豁免集不参与（构建了也不改变输出）
    const off = renderSnapshot(fx.config, fx.store, fx.agent)
    assert.equal(off, GOLDEN_ZH, 'off path with sidecar present stays byte-identical to golden')
    // auto 未超阈（golden fixture 5 条 ≤ 大阈值）：全量路径同样逐字节同 off
    const auto = renderSnapshot({ ...fx.config, memoryProgressiveDisclosure: 'auto', memoryFullInjectThreshold: 50, memoryFullInjectCharLimit: 999999 }, fx.store, fx.agent)
    assert.equal(auto, GOLDEN_ZH, 'auto under thresholds with sidecar present stays byte-identical to golden')
  } finally {
    fx.cleanup()
  }
})

test('块5-⑦ 旋钮校验与默认值：memoryHitExemptDays 非负整数（0=关），默认 30', () => {
  assert.throws(() => validateRuntimePatch('memoryHitExemptDays', -1), /memoryHitExemptDays/)
  assert.throws(() => validateRuntimePatch('memoryHitExemptDays', 1.5), /memoryHitExemptDays/)
  assert.doesNotThrow(() => validateRuntimePatch('memoryHitExemptDays', 0))
  assert.doesNotThrow(() => validateRuntimePatch('memoryHitExemptDays', 30))
  assert.equal(resolveConfig({}).memoryHitExemptDays, 30)
})

// ── 块 6（渐进式披露 v2，2026-09-28 用户批准）：按条目长度折叠 ─────────────
// memorySummaryMinChars（默认 400）：摘要模式下**正文**（entryBodyOf，剥头部
// 元数据后）长于该值的条目折成一行摘要，短条目保持全文——不只是整轨模式。

/** 构造指定正文长度的条目（ASCII 填充，正文逐字可控）。 */
function entryWithBodyLength(chars, head = '[2026-09-24] ') {
  return `${head}${'x'.repeat(chars)}`
}

test('块6-① 按条目长度折叠：长条目折一行摘要、短条目保持全文（同轨共存）', () => {
  const dir = tempDir()
  try {
    const short = entryWithBodyLength(399) // 正文 399 ≤ 400
    const long = entryWithBodyLength(401) // 正文 401 > 400
    writeFileSync(join(dir, 'MEMORY.md'), `${short}\n§\n${long}\n`)
    const cfg = resolveConfig({
      memoryDir: dir,
      memoryProgressiveDisclosure: 'on',
      memorySummaryMinChars: 400,
    })
    const snap = renderSnapshot(cfg, new MemoryStore(dir), { id: 'a', session: { header: { cwd: '/proj/v2-threshold' } } })
    assert.ok(snap.includes('摘要模式'), 'summary mode active')
    // 短条目（399）保持全文：整段 x 出现
    assert.ok(snap.includes('x'.repeat(399)), 'short entry (399 chars) stays in full')
    // 长条目（401）折叠：401 个连续 x 不得出现（autoSummary 只留 120 字 + 省略号）
    assert.equal(snap.includes('x'.repeat(401)), false, 'long entry (401 chars) must be collapsed')
    assert.ok(snap.includes(`${'x'.repeat(119)}…`), 'long entry renders a 120-char autoSummary line')
  } finally {
    clean(dir)
  }
})

test('块6-② 阈值可配：memorySummaryMinChars=1000 → 原 401 字条目改为保持全文', () => {
  const dir = tempDir()
  try {
    const entry = entryWithBodyLength(401)
    writeFileSync(join(dir, 'MEMORY.md'), `${entry}\n`)
    const agent = { id: 'a', session: { header: { cwd: '/proj/v2-threshold-2' } } }
    const store = new MemoryStore(dir)
    const tight = renderSnapshot(resolveConfig({ memoryDir: dir, memoryProgressiveDisclosure: 'on', memorySummaryMinChars: 400 }), store, agent)
    const loose = renderSnapshot(resolveConfig({ memoryDir: dir, memoryProgressiveDisclosure: 'on', memorySummaryMinChars: 1000 }), store, agent)
    assert.equal(tight.includes('x'.repeat(401)), false)
    assert.ok(loose.includes('x'.repeat(401)), 'with a 1000-char threshold the same entry stays full (knob is live)')
  } finally {
    clean(dir)
  }
})

test('块6-③ [salience:3] 恒全文优先于长度规则（即便正文超阈值）', () => {
  const dir = tempDir()
  try {
    const entry = entryWithBodyLength(800, '[2026-09-24] [salience:3] ')
    writeFileSync(join(dir, 'MEMORY.md'), `${entry}\n`)
    const cfg = resolveConfig({ memoryDir: dir, memoryProgressiveDisclosure: 'on', memorySummaryMinChars: 400 })
    const snap = renderSnapshot(cfg, new MemoryStore(dir), { id: 'a', session: { header: { cwd: '/proj/v2-s3' } } })
    assert.ok(snap.includes('x'.repeat(800)), 'salience:3 stays full regardless of the length threshold')
    assert.equal(snap.includes('[salience:3]'), false, 'salience tag itself is stripped from display')
  } finally {
    clean(dir)
  }
})

test('块6-④ off 模式不受 memorySummaryMinChars 影响（仍逐字节同 golden）', () => {
  const fx = buildGoldenFixture()
  try {
    const a = renderSnapshot(resolveConfig({ memoryDir: fx.dir, memorySummaryMinChars: 1 }), fx.store, fx.agent)
    const b = renderSnapshot(resolveConfig({ memoryDir: fx.dir, memorySummaryMinChars: 100000 }), fx.store, fx.agent)
    assert.equal(a, GOLDEN_ZH, 'off + tiny threshold is still byte-identical to golden')
    assert.equal(b, GOLDEN_ZH, 'off + huge threshold is still byte-identical to golden')
  } finally {
    fx.cleanup()
  }
})

test('块6-⑤ 旋钮校验与默认值：memorySummaryMinChars 正整数，默认 400', () => {
  assert.throws(() => validateRuntimePatch('memorySummaryMinChars', 0), /memorySummaryMinChars/)
  assert.throws(() => validateRuntimePatch('memorySummaryMinChars', -5), /memorySummaryMinChars/)
  assert.throws(() => validateRuntimePatch('memorySummaryMinChars', 1.5), /memorySummaryMinChars/)
  assert.doesNotThrow(() => validateRuntimePatch('memorySummaryMinChars', 400))
  assert.equal(resolveConfig({}).memorySummaryMinChars, 400)
  assert.throws(() => resolveConfig({ memorySummaryMinChars: 0 }), /memorySummaryMinChars/)
  assert.throws(() => resolveConfig({ memorySummaryMinChars: 'x' }), /memorySummaryMinChars/)
})

test('块6-⑥ 注入必红：同一条目在阈值两侧必须产出不同快照（防长度旋钮空转）', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'MEMORY.md'), `${entryWithBodyLength(500)}\n`)
    const agent = { id: 'a', session: { header: { cwd: '/proj/v2-red' } } }
    const store = new MemoryStore(dir)
    const folded = renderSnapshot(resolveConfig({ memoryDir: dir, memoryProgressiveDisclosure: 'on', memorySummaryMinChars: 400 }), store, agent)
    const kept = renderSnapshot(resolveConfig({ memoryDir: dir, memoryProgressiveDisclosure: 'on', memorySummaryMinChars: 600 }), store, agent)
    assert.notStrictEqual(folded, kept, 'crossing the threshold must change the snapshot (else the knob is dead)')
  } finally {
    clean(dir)
  }
})
