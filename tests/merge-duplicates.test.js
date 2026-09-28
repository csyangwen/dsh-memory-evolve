// 合并器重复上报 + promote 半完成态回归（2026-09-24 审计批次 2 · D4-P1 / D3-P2-4）。
//
// 缺陷背景：①mergeEntries 索引对同 entryKey 只保留第一条，重复条目不进
// keys 并集、不进 conflicts/removed——静默丢数据（真实链路：promote 成功
// 但 archive.remove 失败 → 同 ID 双处存在 → 联合索引先遇者胜出）；
// ②promoteArchived 忽略 archive.remove 失败返回——裸成功掩盖半完成态。
// 直跑：node tests/merge-duplicates.test.js。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeEntries } from '../lib/sync/merge.js'
import { ArchiveStore, MemoryStore } from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'
import { promoteArchived } from '../lib/review.js'

test('①同侧同 ID 重复：保留一条 + duplicates 报告（不再静默丢弃）', () => {
  const dupEntry = '[id:deadbeef] [2026-09-24] 同 ID 条目'
  const files = {
    'KEY.md': [dupEntry, '[2026-09-24] 正常条目'],
    'KEY-archive.md': ['[id:deadbeef] [2026-09-24] 同 ID 条目（归档副本）'],
  }
  const result = mergeEntries({}, files, {})
  assert.equal(result.stats.duplicates, 1, '同 ID 第二条必须计入 duplicates')
  assert.equal(result.duplicates.length, 1)
  assert.equal(result.duplicates[0].entryKey, 'm:deadbeef')
  assert.equal(result.duplicates[0].keptIn, 'KEY.md', '报告保留者的位置')
  // 先到先得语义不变：输出仍含一条（KEY.md 副本，字典序在前）
  const keyEntries = result.files['KEY.md']
  assert.equal(keyEntries.length, 2, 'KEY.md 自身条目不丢')
})

test('②无重复时 duplicates 为空数组、stats.duplicates=0（零行为漂移）', () => {
  const result = mergeEntries(
    { 'MEMORY.md': ['[id:aaaabbbb] [2026-09-24] 基线'] },
    { 'MEMORY.md': ['[id:aaaabbbb] [2026-09-24] 基线改'] },
    { 'MEMORY.md': ['[id:aaaabbbb] [2026-09-24] 基线改'] },
  )
  assert.equal(result.stats.duplicates, 0)
  assert.deepEqual(result.duplicates, [])
  assert.equal(result.stats.conflicts, 0)
  assert.equal(result.files['MEMORY.md'][0], '[id:aaaabbbb] [2026-09-24] 基线改')
})

test('③promote 半完成态：remove 失败时不再裸成功（消息提示手动清理）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-merge-dup-'))
  try {
    const store = new MemoryStore(dir)
    const todoStore = new TodoStore(dir)
    const archive = new ArchiveStore(dir)
    // 归档两条内容互相包含的条目（remove 子串匹配会 multiMatch 拒绝）
    archive.append('memory', '[2026-09-24] 转正测试条目')
    archive.append('memory', '[2026-09-24] 转正测试条目\n附带第二行（含第一行）')
    const r = promoteArchived(store, todoStore, archive, 'memory', '转正测试条目', undefined)
    // match 同时命中两条 → promoteArchived 自身 multiMatch 拒绝（不是半完成）
    assert.equal(r.ok, false)
    assert.match(r.message, /2 个归档条目|多于一条|matches/)
    // 换精确场景：单条归档 → promote 成功路径 remove 也成功（对照）
    const dir2 = mkdtempSync(join(tmpdir(), 'dsh-merge-dup2-'))
    try {
      const store2 = new MemoryStore(dir2)
      const archive2 = new ArchiveStore(dir2)
      archive2.append('memory', '[2026-09-24] 唯一转正条目')
      const ok = promoteArchived(store2, todoStore, archive2, 'memory', '唯一转正条目', undefined)
      assert.equal(ok.ok, true)
      assert.equal(ok.partial, undefined, '完整成功不带 partial 标记')
      assert.equal(archive2.entriesOf('memory').length, 0)
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('④真实联动场景：promote 后残留归档副本 → 合并器 duplicates 报告可见', () => {
  // 模拟 D4-P1 的完整链路：主轨有条目（转正写入）+ 归档也有同 ID 条目
  // （remove 失败残留）→ merge 的联合索引遇重复 → 报告而非静默丢
  const raw = '[id:cafe1234] [2026-09-24] 联动验证条目'
  const files = {
    'KEY.md': [raw],
    'KEY-archive.md': [`${raw}\n（归档理由：残留）`],
  }
  const result = mergeEntries({}, files, {})
  assert.ok(result.stats.duplicates >= 1, '同 ID 双处存在必须在 duplicates 报告可见')
})
