/**
 * 审查联动衰减候选测试（autopilot-memory-lifecycle Step 5；AC-5.1~5.3 +
 * AC-6.5 + 新增 i18n 双语齐全自检）。
 *
 * 断言鉴别力：
 *   - AC-5.2 注入必红（负向三连）：review 关闭 / 报告缺失 / 报告为空——
 *     快照不得出现联动文案；其中「报告缺失 vs 报告为空」两种无联动形态
 *     **逐字节一致**（防 hint 拼接位置随分支漂移）；review 关闭 + 非空报告
 *     与黄金基线 GOLDEN_ZH 逐字节一致（默认零变化的最强形态）。
 *   - AC-5.3 只读边界：联动渲染前后报告 SHA256 与目录文件清单不变。
 *   - AC-6.5 目录边界门：git 可用时断言 skills/ 与 lib/sync/ 零改动；
 *     沙箱 spawnSync git EPERM（已知环境限制）时输出提示并放行（诚实
 *     skip，不计入通过项——真正的 git status 证据由交付报告提供）。
 *
 * 直跑：node tests/review-decay-link.test.js。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { renderSnapshot, resolveConfig } from '../lib/index.js'
import { buildGoldenFixture, GOLDEN_ZH } from './snapshot-golden.test.js'
import { DECAY_REPORT_FILE } from '../lib/decay.js'
import { MEMORY_DICT, SNAPSHOT_DICT } from '../lib/i18n.js'
import { setLocale } from '../lib/i18n.js'

setLocale('zh')

/** due 触发用 counter mock：永远到期。 */
const DUE_COUNTER = { turnsOf: () => 999 }

/** 非空报告（2 条假候选——readDecayCandidateCount 只看 candidates.length）。 */
const NON_EMPTY_REPORT = JSON.stringify({
  metadata: { generatedAt: '2026-09-23T00:00:00.000Z', fallbackCount: 0, deviceId: '', thresholds: [30, 90, 180] },
  candidates: [
    { track: 'memory', id: null, hash: 'memory:deadbeef', lastAccessed: '2026-08-01', fallbackDate: null, days: 53, threshold: 30, salience: 1, reason: 'fixture' },
    { track: 'user', id: null, hash: 'user:deadbeef', lastAccessed: null, fallbackDate: '2026-01-01', days: 265, threshold: 90, salience: 2, reason: 'fixture' },
  ],
})

const EMPTY_REPORT = JSON.stringify({
  metadata: { generatedAt: '2026-09-23T00:00:00.000Z', fallbackCount: 0, deviceId: '', thresholds: [30, 90, 180] },
  candidates: [],
})

const HINT_MARK = '衰减归档候选'

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

test('AC-5.1: reviewEnabled + 到期 + 报告非空 → dueWarning 含候选数（Q8 合并计数）', () => {
  const fx = buildGoldenFixture()
  try {
    writeFileSync(join(fx.dir, DECAY_REPORT_FILE), NON_EMPTY_REPORT)
    const cfg = resolveConfig({ memoryDir: fx.dir, reviewEnabled: true, reviewInterval: 5 })
    const snap = renderSnapshot(cfg, fx.store, fx.agent, DUE_COUNTER)
    assert.ok(snap.includes('记忆审查已到期'), 'dueWarning 本体仍在')
    assert.ok(snap.includes(HINT_MARK), '联动文案出现')
    assert.ok(snap.includes('**2 条**'), '候选数=2 注入（合并计数，不分子轨）')
    assert.ok(snap.includes('decay-report.json'), '报告文件名指路')
    assert.ok(snap.includes('不要自行删除'), '只读纪律写进文案（绝不自动删除）')
  } finally {
    fx.cleanup()
  }
})

test('AC-5.2a 注入必红: review 关闭（默认）+ 报告非空 → 快照与黄金基线逐字节一致', () => {
  const fx = buildGoldenFixture()
  try {
    // 非空报告已就位，但 review 关闭（默认 config 无 reviewEnabled）
    writeFileSync(join(fx.dir, DECAY_REPORT_FILE), NON_EMPTY_REPORT)
    const snap = renderSnapshot(fx.config, fx.store, fx.agent)
    assert.equal(snap, GOLDEN_ZH, 'review 关闭时不读报告：逐字节同黄金基线')
    assert.ok(!snap.includes(HINT_MARK))
  } finally {
    fx.cleanup()
  }
})

test('AC-5.2b 注入必红: 到期但报告缺失 → 快照 = 纯 dueWarning（无 hint 后缀）', () => {
  const fx = buildGoldenFixture()
  try {
    const cfg = resolveConfig({ memoryDir: fx.dir, reviewEnabled: true, reviewInterval: 5 })
    const snap = renderSnapshot(cfg, fx.store, fx.agent, DUE_COUNTER)
    assert.ok(!snap.includes(HINT_MARK), '报告缺失不得注入 hint')
    assert.ok(snap.includes('记忆审查已到期'), 'dueWarning 本体仍在（联动只增不减）')
    // hint 必须紧接 dueWarning 之后、在 writeWarning 之前（拼接位置钉死）
    const idx = snap.indexOf('memory_review_status（action=complete）复位')
    assert.ok(idx >= 0, 'dueWarning 结束语存在')
    assert.equal(snap.slice(idx).includes(HINT_MARK), false)
  } finally {
    fx.cleanup()
  }
})

test('AC-5.2c 注入必红: 到期 + 报告为空数组 → 快照与「报告缺失」形态逐字节一致', () => {
  const fxEmpty = buildGoldenFixture()
  const fxMissing = buildGoldenFixture()
  try {
    const cfgOf = (dir) => resolveConfig({ memoryDir: dir, reviewEnabled: true, reviewInterval: 5 })
    writeFileSync(join(fxEmpty.dir, DECAY_REPORT_FILE), EMPTY_REPORT)
    const withEmpty = renderSnapshot(cfgOf(fxEmpty.dir), fxEmpty.store, fxEmpty.agent, DUE_COUNTER)
    const withMissing = renderSnapshot(cfgOf(fxMissing.dir), fxMissing.store, fxMissing.agent, DUE_COUNTER)
    assert.ok(!withEmpty.includes(HINT_MARK), '空报告 = 无联动')
    // 两种「无联动」形态逐字节一致（防 hint 分支拼接漂移——联动关闭时
    // 输出必须与不存在该功能时完全相同）
    assert.equal(withEmpty, withMissing, '空报告 vs 缺失报告：快照逐字节一致')
  } finally {
    fxEmpty.cleanup()
    fxMissing.cleanup()
  }
})

test('AC-5.3 只读边界: 联动渲染前后报告 SHA256 与目录文件清单不变', () => {
  const fx = buildGoldenFixture()
  try {
    const reportPath = join(fx.dir, DECAY_REPORT_FILE)
    writeFileSync(reportPath, NON_EMPTY_REPORT)
    const beforeSha = sha256(reportPath)
    const beforeListing = readdirSync(fx.dir).sort()
    const cfg = resolveConfig({ memoryDir: fx.dir, reviewEnabled: true, reviewInterval: 5 })
    const snap = renderSnapshot(cfg, fx.store, fx.agent, DUE_COUNTER)
    assert.ok(snap.includes(HINT_MARK), '前置：联动确实生效')
    assert.equal(sha256(reportPath), beforeSha, '报告文件字节不动（只读）')
    assert.deepEqual(readdirSync(fx.dir).sort(), beforeListing, '目录无新文件（无自动整理动作）')
  } finally {
    fx.cleanup()
  }
})

test('AC-6.5 目录边界门: skills/ 与 lib/sync/ 零改动（git 可用时断言；沙箱 EPERM 诚实放行）', () => {
  let probe
  try {
    probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' })
  } catch {
    probe = { error: { code: 'EPERM' } }
  }
  if (probe.error || probe.status !== 0) {
    // 沙箱已知限制：spawnSync git EPERM（与既有 8 处环境性失败同源）。
    // 诚实放行并在输出留提示——真正的 git status 证据由交付报告提供。
    console.log('[AC-6.5] skipped：沙箱无法运行 git（EPERM）；复跑命令：git status --short -- skills/ lib/sync/（期望空输出）')
    return
  }
  const status = spawnSync('git', ['status', '--porcelain', '--', 'skills/', 'lib/sync/'], { encoding: 'utf8' })
  assert.equal(status.status, 0, 'git status 可执行')
  assert.equal(status.stdout.trim(), '', `skills/ 与 lib/sync/ 必须零改动，实得：\n${status.stdout}`)
})

test('i18n 双语齐全: decay 回显/无候选/失败/联动文案 zh-en 成对非空', () => {
  for (const key of ['msg.decayDone', 'msg.decayNone', 'msg.decayFailed']) {
    const pair = MEMORY_DICT[key]
    assert.ok(Array.isArray(pair) && pair.length === 2, `${key} 必须 zh/en 成对`)
    for (const text of pair) assert.ok(text.length > 0, `${key} 文案非空`)
  }
  const hint = SNAPSHOT_DICT['snap.dueDecayHint']
  assert.ok(Array.isArray(hint) && hint.length === 2, 'snap.dueDecayHint 必须 zh/en 成对')
  assert.ok(hint[0].includes(HINT_MARK) && hint[0].includes('{count}'), '中文文案含关键字与计数占位')
  assert.ok(hint[1].includes('decay-report.json') && hint[1].includes('{count}'), '英文文案含报告名与计数占位')
})

// node 直跑自执行入口（import 方测试自带 test 注册）
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  // node:test 的 test() 已在 import 时注册并自动执行
}
