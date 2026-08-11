/**
 * tests/sync-merge.test.js — 三路合并器单元测试（施工图 §6 测试矩阵）
 *
 * 每行规则 ≥1 用例：单侧新增 / 双侧同新增去重 / 未动 / 单侧修改 /
 * 双侧同改一致 / 双侧改冲突 / 单侧删除 / 双侧删除 / 改vs删冲突 /
 * location 归档单侧 / location 双侧冲突 / 无 ID 文本兜底 /
 * 双设备补发同内容同 ID 后对齐 / 输出 canonical 校验。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeEntries } from '../lib/sync/merge.js'
import { isCanonical, parseEntries, serializeEntries } from '../lib/store.js'
import { extractEntryId, ensureEntryIds } from '../lib/sync/entryid.js'

/** 快速构造一条带 ID 的条目（ID 补齐为 8 位 hex——身份证格式硬约束）。 */
const E = (id, text) => `[id:${String(id).padEnd(8, '0')}] [2026-08-11] ${text}`
const KEY = 'KEY.md'
const ARCH = 'KEY-archive.md'

/** 断言合并结果 files[path] 可 canonical 往返。 */
function assertCanonical(files) {
  for (const [path, entries] of Object.entries(files)) {
    const text = serializeEntries(entries)
    assert.equal(isCanonical(text), true, `${path} 应 canonical 往返`)
    assert.deepEqual(parseEntries(text), entries, `${path} 往返一致`)
  }
}

/* ── 新增 ── */

test('单侧新增：ours 新增保留；theirs 新增保留', () => {
  const base = { [KEY]: [E('a', '旧条目')] }
  const ours = { [KEY]: [E('a', '旧条目'), E('b', '本机新增')] }
  const theirs = { [KEY]: [E('a', '旧条目')] }
  const r = mergeEntries(base, ours, theirs)
  assert.deepEqual(r.files[KEY], [E('a', '旧条目'), E('b', '本机新增')])
  assert.equal(r.conflicts.length, 0)

  const theirs2 = { [KEY]: [E('a', '旧条目'), E('c', '远端新增')] }
  const r2 = mergeEntries(base, base, theirs2)
  assert.deepEqual(r2.files[KEY], [E('a', '旧条目'), E('c', '远端新增')])
  assert.equal(r2.conflicts.length, 0)
})

test('双侧同新增：同 ID 同内容去重一条', () => {
  const base = { [KEY]: [] }
  const ours = { [KEY]: [E('b', '两边各自新增同一条')] }
  const theirs = { [KEY]: [E('b', '两边各自新增同一条')] }
  const r = mergeEntries(base, ours, theirs)
  assert.deepEqual(r.files[KEY], [E('b', '两边各自新增同一条')])
  assert.equal(r.conflicts.length, 0)
})

/* ── 未动 / 单侧修改 ── */

test('未动：三方一致保留 base', () => {
  const base = { [KEY]: [E('a', '旧条目')] }
  const r = mergeEntries(base, base, base)
  assert.deepEqual(r.files[KEY], [E('a', '旧条目')])
  assert.equal(r.conflicts.length, 0)
})

test('单侧修改：ours 改采用 ours；theirs 改采用 theirs', () => {
  const base = { [KEY]: [E('a', '旧内容')] }
  const ours = { [KEY]: [E('a', '本机改的新内容')] }
  const r = mergeEntries(base, ours, base)
  assert.deepEqual(r.files[KEY], [E('a', '本机改的新内容')])
  assert.equal(r.conflicts.length, 0)

  const theirs = { [KEY]: [E('a', '远端改的新内容')] }
  const r2 = mergeEntries(base, base, theirs)
  assert.deepEqual(r2.files[KEY], [E('a', '远端改的新内容')])
  assert.equal(r2.conflicts.length, 0)
})

test('双侧同改一致：收敛一条不冲突', () => {
  const base = { [KEY]: [E('a', '旧内容')] }
  const ours = { [KEY]: [E('a', '两边都改成一样')] }
  const theirs = { [KEY]: [E('a', '两边都改成一样')] }
  const r = mergeEntries(base, ours, theirs)
  assert.deepEqual(r.files[KEY], [E('a', '两边都改成一样')])
  assert.equal(r.conflicts.length, 0)
})

test('双侧改不同：content 冲突进人工（不落盘、输出无该条）', () => {
  const base = { [KEY]: [E('a', '旧内容')] }
  const ours = { [KEY]: [E('a', '本机版本')] }
  const theirs = { [KEY]: [E('a', '远端版本')] }
  const r = mergeEntries(base, ours, theirs)
  assert.equal(r.conflicts.length, 1)
  const c = r.conflicts[0]
  assert.equal(c.entryKey, 'a0000000')
  assert.equal(c.file, KEY)
  assert.equal(c.base, E('a', '旧内容'))
  assert.equal(c.ours, E('a', '本机版本'))
  assert.equal(c.theirs, E('a', '远端版本'))
  assert.match(c.reason, /内容双侧不同/)
  assert.equal(r.files[KEY].length, 0, '冲突条目不进工作树')
})

/* ── 删除 ── */

test('单侧删除：ours 删 / theirs 删 → 删除生效并报告', () => {
  const base = { [KEY]: [E('a', '旧条目')] }
  const ours = { [KEY]: [] }
  const r = mergeEntries(base, ours, base)
  assert.deepEqual(r.files[KEY], [])
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.removed.length, 1)

  const theirs = { [KEY]: [] }
  const r2 = mergeEntries(base, base, theirs)
  assert.deepEqual(r2.files[KEY], [])
  assert.equal(r2.removed.length, 1)
})

test('双侧删除：删除，无报告冲突', () => {
  const base = { [KEY]: [E('a', '旧条目')] }
  const r = mergeEntries(base, { [KEY]: [] }, { [KEY]: [] })
  assert.deepEqual(r.files[KEY], [])
  assert.equal(r.conflicts.length, 0)
})

test('改 vs 删：一侧改一侧删 → 冲突进人工（保守不猜）', () => {
  const base = { [KEY]: [E('a', '旧内容')] }
  const ours = { [KEY]: [E('a', '本机修改')] }
  const theirs = { [KEY]: [] }
  const r = mergeEntries(base, ours, theirs)
  assert.equal(r.conflicts.length, 1)
  assert.match(r.conflicts[0].reason, /一侧修改一侧删除/)

  const r2 = mergeEntries(base, { [KEY]: [] }, { [KEY]: [E('a', '远端修改')] })
  assert.equal(r2.conflicts.length, 1)
  assert.match(r2.conflicts[0].reason, /一侧修改一侧删除/)
})

/* ── location（归档/转正）── */

test('location 单侧变化：归档采用（KEY → KEY-archive）', () => {
  const base = { [KEY]: [E('a', '旧条目')] }
  const ours = { [KEY]: [], [ARCH]: [E('a', '旧条目')] } // 本机归档
  const theirs = { [KEY]: [E('a', '旧条目')] }
  const r = mergeEntries(base, ours, theirs)
  assert.deepEqual(r.files[KEY], [])
  assert.deepEqual(r.files[ARCH], [E('a', '旧条目')])
  assert.equal(r.conflicts.length, 0)

  // 对称：theirs 归档
  const r2 = mergeEntries(base, base, { [KEY]: [], [ARCH]: [E('a', '旧条目')] })
  assert.deepEqual(r2.files[KEY], [])
  assert.deepEqual(r2.files[ARCH], [E('a', '旧条目')])
})

test('location 双侧不同：归档/转正冲突进人工', () => {
  const base = { [KEY]: [E('a', '旧条目')] }
  const ours = { [KEY]: [], [ARCH]: [E('a', '旧条目')] } // ours 归档
  const theirs = { [KEY]: [E('a', '旧条目')], [ARCH]: [] } // theirs 转正（保持 KEY + 挪到 ARCH？）
  // 构造双侧 location 不同：ours 在 ARCH、theirs 在 KEY 且都有改动意图——
  // 更直接：theirs 把条目从 KEY 挪到 logs 场景，用第二个文件模拟
  const LOGS = 'logs/2026-08-11.md'
  const ours2 = { [KEY]: [], [ARCH]: [E('a', '旧条目')] }
  const theirs2 = { [KEY]: [], [LOGS]: [E('a', '旧条目')] }
  const r = mergeEntries(base, ours2, theirs2)
  assert.equal(r.conflicts.length, 1)
  assert.match(r.conflicts[0].reason, /位置双侧不同|归档\/转正冲突/)
})

/* ── 无 ID 兜底与确定性补发 ── */

test('无 ID 文本兜底：legacy 条目补发后按 ID 对齐（同内容同 ID）', () => {
  // 双设备各自补发 legacy 条目 → 同内容同 ID → 合并对齐
  const base = { [KEY]: ['[2026-08-10] 老记忆（无 ID）'] }
  const ours = { [KEY]: ['[2026-08-10] 老记忆（无 ID）改过'] }
  const theirs = { [KEY]: ['[2026-08-10] 老记忆（无 ID）'] }
  const r = mergeEntries(base, ours, theirs)
  // ours 修改单侧生效，且输出条目带确定性 ID
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.files[KEY].length, 1)
  const out = r.files[KEY][0]
  assert.ok(extractEntryId(out) !== null, '输出条目应有身份证')
  assert.ok(out.includes('改过'))
})

test('双设备补发同内容同 ID 后对齐：双侧新增同一 legacy 去重', () => {
  const base = {}
  const ours = { [KEY]: ['[2026-08-10] 两台设备都有的老条目'] }
  const theirs = { [KEY]: ['[2026-08-10] 两台设备都有的老条目'] }
  const r = mergeEntries(base, ours, theirs)
  assert.equal(r.files[KEY].length, 1)
  assert.equal(r.conflicts.length, 0)
  // 输出条目有 ID，且与 ensureEntryIds 补发结果一致
  const expected = ensureEntryIds(['[2026-08-10] 两台设备都有的老条目']).entries[0]
  assert.equal(r.files[KEY][0], expected)
})

/* ── 输出保证 ── */

test('输出 canonical：全部文件可往返（含空文件与多文件）', () => {
  const base = { [KEY]: [E('a', 'A')], 'logs/2026-08-10.md': [E('l', '日志')], [ARCH]: [] }
  const ours = { [KEY]: [E('a', 'A 改'), E('b', '新增')], 'logs/2026-08-10.md': [E('l', '日志')] }
  const theirs = { [KEY]: [E('a', 'A 改'), E('c', '远端新增')], 'logs/2026-08-11.md': [E('m', '远端日志')] }
  const r = mergeEntries(base, ours, theirs)
  assertCanonical(r.files)
  // 路径并集：ARCH 与远端新文件都存在（空数组占位）
  assert.ok(ARCH in r.files)
  assert.ok('logs/2026-08-11.md' in r.files)
})

test('同侧重复 ID 防御：先到先得，不抛错', () => {
  const base = {}
  const ours = { [KEY]: [E('a', '第一条'), E('a', '重复第二条')] }
  const r = mergeEntries(base, ours, {})
  assert.equal(r.files[KEY].length, 1)
  assert.equal(r.files[KEY][0], E('a', '第一条'))
})
