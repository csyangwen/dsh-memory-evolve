// 记忆 Tab 条目级生命周期元数据测试（PR #66 后续增强，块 4）。
//
// 覆盖 buildMemoryFiles 附加的 entryMeta 字段（lib/memory-tab.js buildEntryMeta）：
//   - hitCount：从对应轨道 hit-stats.json 侧车按 hitKey join（键 = 原样条目串）；
//     无侧车/无记录 = 0；损坏侧车 = 0（失败隔离）。
//   - salience：服务端解析条目头部 [salience:N]；无 = null。
//   - key 轨侧车路径 = projects/<hash>/（写错位置会被判无记录）。
//   - 纯增量：既有行字段不受影响；content 展示剥离与 entryMeta 解析口径互不影响。
//
// 直跑：node tests/memory-tab-lifecycle.test.js（沙箱禁 node --test runner）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, projectHash } from '../lib/store.js'
import { bumpHits } from '../lib/hit-stats.js'
import { buildMemoryFiles } from '../lib/memory-tab.js'

const CWD = '/proj/lifecycle-cwd'

/** fixture：memory 轨 5 条（含 salience/summary 标记矩阵）+ user 轨 2 条 + key 轨 2 条，全部手写静态原文。 */
function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-tab-lifecycle-'))
  const memoryEntries = [
    '[2026-09-20] [salience:3] 核心架构决策条目（恒全文豁免档）',
    '[2026-09-21] [salience:2] 重要用户约定条目',
    '[2026-09-22] 普通进展条目甲',
    '[2026-09-23] 普通进展条目乙',
    '[2026-09-24] [summary:普通摘要] 带摘要的普通条目正文',
  ]
  const userEntries = [
    '[2026-09-19] 用户档案条目一',
    '[2026-09-20] [salience:3] 用户档案核心偏好',
  ]
  const keyEntries = [
    '[2026-09-18] 关键记忆条目甲',
    '[2026-09-19] 关键记忆条目乙',
  ]
  writeFileSync(join(dir, 'MEMORY.md'), memoryEntries.join('\n§\n') + '\n')
  writeFileSync(join(dir, 'USER.md'), userEntries.join('\n§\n') + '\n')
  const keyDir = join(dir, 'projects', projectHash(CWD))
  mkdirSync(keyDir, { recursive: true })
  writeFileSync(join(keyDir, 'KEY.md'), keyEntries.join('\n§\n') + '\n')
  return { dir, keyDir, memoryEntries, userEntries, keyEntries }
}

function setup() {
  const fx = buildFixture()
  const config = { memoryDir: fx.dir }
  const store = new MemoryStore(fx.dir)
  return { ...fx, config, store }
}

function byKey(files) {
  return Object.fromEntries(files.map((f) => [f.key, f]))
}

test('entryMeta：memory 轨 5 条目矩阵——侧车 join 计数 + salience 解析 + 展示剥离口径互证', () => {
  const fx = setup()
  try {
    // 命中布置：条目[0] 命中 1 次；条目[2] 命中 2 次（递增口径）；
    // 条目[1]/[3]/[4] 无记录 → 0。bumpHits 用**原样条目串**（含全部 head tag）。
    bumpHits(fx.dir, 'memory', [fx.memoryEntries[0]])
    bumpHits(fx.dir, 'memory', [fx.memoryEntries[2]])
    bumpHits(fx.dir, 'memory', [fx.memoryEntries[2]])
    const files = buildMemoryFiles(fx.config, fx.store, CWD)
    const row = byKey(files).memory
    assert.equal(row.exists, true)
    const meta = row.entryMeta
    // ≥3 元素矩阵断言（鉴别力：任何「只处理首条/漏 join」的实现都会在此红）
    assert.equal(Array.isArray(meta), true)
    assert.equal(meta.length, 5)
    assert.deepEqual(
      meta.map((m) => m.hitCount),
      [1, 0, 2, 0, 0],
    )
    assert.deepEqual(
      meta.map((m) => m.salience),
      [3, 2, null, null, null],
    )
    // 口径互证：content 展示形态已剥 [salience:N]（stripEntrySummary 链），
    // 而 entryMeta.salience 仍解析自原样条目——两者互不污染。
    assert.equal(row.content.includes('[salience:3]'), false)
    assert.equal(row.content.includes('核心架构决策条目'), true)
    // 纯增量：既有字段原样保留。
    assert.equal(row.key, 'memory')
    assert.equal(typeof row.title, 'string')
    assert.equal(row.available, true)
    assert.equal(typeof row.content, 'string')
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('entryMeta：无侧车轨全零 + user 轨 salience 解析', () => {
  const fx = setup()
  try {
    const files = buildMemoryFiles(fx.config, fx.store, CWD)
    const meta = byKey(files).user.entryMeta
    assert.equal(meta.length, 2)
    assert.deepEqual(meta.map((m) => m.hitCount), [0, 0]) // 无侧车文件 = 全 0
    assert.deepEqual(meta.map((m) => m.salience), [null, 3])
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('entryMeta：key 轨侧车在 projects/<hash>/ 下被正确 join（路径正确性）', () => {
  const fx = setup()
  try {
    // 写到 key 轨正确位置：projects/<hash>/hit-stats.json
    bumpHits(fx.keyDir, 'key', [fx.keyEntries[1]])
    const files = buildMemoryFiles(fx.config, fx.store, CWD)
    const meta = byKey(files).key.entryMeta
    assert.equal(meta.length, 2)
    assert.deepEqual(meta.map((m) => m.hitCount), [0, 1])
    assert.deepEqual(meta.map((m) => m.salience), [null, null])
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('entryMeta：侧车写错位置（记忆根放 key 键）→ key 轨判无记录走 0（口径守卫）', () => {
  const fx = setup()
  try {
    // 反向守卫：若实现误用记忆根侧车读 key 轨，这条注入会让它误报命中。
    bumpHits(fx.dir, 'key', [fx.keyEntries[0]])
    const files = buildMemoryFiles(fx.config, fx.store, CWD)
    const meta = byKey(files).key.entryMeta
    assert.deepEqual(meta.map((m) => m.hitCount), [0, 0])
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('entryMeta：损坏侧车 → 全 0 失败隔离（主流程不受影响）', () => {
  const fx = setup()
  try {
    writeFileSync(join(fx.dir, 'hit-stats.json'), '{不是 JSON')
    const files = buildMemoryFiles(fx.config, fx.store, CWD)
    const row = byKey(files).memory
    assert.deepEqual(row.entryMeta.map((m) => m.hitCount), [0, 0, 0, 0, 0])
    // 主流程不受影响：content 照常下发
    assert.equal(row.content.includes('普通进展条目甲'), true)
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('entryMeta：无 hit-stats 语义的轨（daily/archive/agents）不附 entryMeta', () => {
  const fx = setup()
  try {
    const files = buildMemoryFiles(fx.config, fx.store, CWD)
    const rows = byKey(files)
    assert.equal(rows.daily.entryMeta, undefined)
    assert.equal(rows['archive-memory'].entryMeta, undefined)
    assert.equal(rows.agents.entryMeta, undefined)
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})
