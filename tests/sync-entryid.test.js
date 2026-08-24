/**
 * tests/sync-entryid.test.js — 条目身份证（entryId）单元测试（施工图 §7 第 2 步验收）
 *
 * 覆盖：
 *   - entryid.js 纯函数：genEntryId 格式、extract/strip、ensureEntryIds
 *     确定性（同内容同 ID、已带 ID 不动）、normalizeContent；
 *   - store.js 集成：entryIdMode=off 行为零变化（默认路径）；entryIdMode=on
 *     时 add 生成随机 ID（仅项目轨 key/project）、replace 继承 ID、去重
 *     判比较剥离 ID、splitEntryHead 最优先剥离 [id:]。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { MemoryStore, projectHash, splitEntryHead } from '../lib/store.js'
import {
  ENTRY_ID_RE, extractEntryId, ensureEntryIds, genEntryId, normalizeContent, stripEntryId,
} from '../lib/sync/entryid.js'

// This suite pins the legacy Chinese output contract; i18n.test.js covers English.
import { setLocale } from '../lib/i18n.js'
setLocale('zh')

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-sync-entryid-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** 确定性补发的期望 ID：sha1(normalizeContent) 前 8 位。 */
function expectedLegacyId(entry) {
  return createHash('sha1').update(normalizeContent(entry)).digest('hex').slice(0, 8)
}

/* ---------------- entryid.js 纯函数 ---------------- */

test('genEntryId 产出 8 位 hex，且两次调用不同', () => {
  const a = genEntryId()
  const b = genEntryId()
  assert.match(a, /^[0-9a-f]{8}$/)
  assert.match(b, /^[0-9a-f]{8}$/)
  assert.notEqual(a, b)
})

test('extract/strip：只认条目最前的 [id:xxxxxxxx]', () => {
  assert.equal(extractEntryId('[id:abcdef12] [2026-08-11] 内容'), 'abcdef12')
  assert.equal(extractEntryId('[id:abcdef12] 内容'), 'abcdef12')
  assert.equal(extractEntryId('[2026-08-11] 内容'), null)
  assert.equal(extractEntryId('正文提到 [id:12345678] 不算'), null)
  assert.equal(extractEntryId(''), null)
  assert.equal(extractEntryId(undefined), null)
  assert.equal(stripEntryId('[id:abcdef12] [2026-08-11] 内容'), '[2026-08-11] 内容')
  assert.equal(stripEntryId('[2026-08-11] 内容'), '[2026-08-11] 内容')
  assert.equal(stripEntryId('[id:abcdef12]'), '')
  // 正则与实现一致性（8 位 hex 限定）
  assert.ok(ENTRY_ID_RE.test('[id:01234567] x'))
  assert.ok(!ENTRY_ID_RE.test('[id:xyz] x'))
})

test('normalizeContent：trim + 连续空白折叠为单空格', () => {
  assert.equal(normalizeContent('  a   b\n\n c  '), 'a b c')
  assert.equal(normalizeContent('a'), 'a')
})

test('ensureEntryIds：确定性补发（同内容 → 同 ID），已带 ID 不动', () => {
  const a = '[2026-08-11] 项目使用 pnpm'
  const b = '[2026-08-11] 项目使用 pnpm'
  const r1 = ensureEntryIds([a])
  const r2 = ensureEntryIds([b])
  assert.equal(r1.backfilled, 1)
  // 同内容 → 同 ID（双设备补发一致的关键）
  assert.equal(r1.entries[0], r2.entries[0])
  assert.equal(extractEntryId(r1.entries[0]), expectedLegacyId(a))
  assert.ok(r1.entries[0].startsWith(`[id:${expectedLegacyId(a)}] `))
  // 幂等：再跑一次不再补发
  const again = ensureEntryIds(r1.entries)
  assert.equal(again.backfilled, 0)
  assert.deepEqual(again.entries, r1.entries)
  // 空白差异不影响 ID（归一化抹平）
  const r3 = ensureEntryIds(['[2026-08-11] 项目使用  pnpm'])
  assert.equal(extractEntryId(r3.entries[0]), expectedLegacyId(a))
  // 混合：已带 ID 的保留原样
  const mixed = ensureEntryIds(['[id:deadbeef] [2026-08-11] 已有身份证', '[2026-08-11] 无身份证'])
  assert.equal(mixed.backfilled, 1)
  assert.equal(mixed.entries[0], '[id:deadbeef] [2026-08-11] 已有身份证')
  assert.equal(extractEntryId(mixed.entries[1]), expectedLegacyId('[2026-08-11] 无身份证'))
})

/* ---------------- store.js 集成：默认路径零变化 ---------------- */

test('entryIdMode=off（默认）：add 不生成 ID，splitEntryHead 行为不变', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    store.add('key', '项目决策 A', { session: { header: { cwd: '/work/x' } } })
    const entries = store.entriesOf('key', { session: { header: { cwd: '/work/x' } } })
    assert.equal(entries.length, 1)
    assert.doesNotMatch(entries[0], /^\[id:/)
    // splitEntryHead 不变：无 [id:] 时 head/body 与旧行为一致
    const { head, body } = splitEntryHead('[2026-08-11] 内容', 'memory')
    assert.equal(head, '[2026-08-11] ')
    assert.equal(body, '内容')
  } finally {
    clean(dir)
  }
})

/* ---------------- store.js 集成：entryIdMode=on ---------------- */

const agent = { session: { header: { cwd: '/work/x' } } }

/** 模拟已 bootstrap 的 sync 项目：在项目目录写 PROVENANCE（新判定要求）。 */
function syncInit(dir, cwd = '/work/x') {
  const projectDir = join(dir, 'projects', projectHash(cwd))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'PROVENANCE'), JSON.stringify({ projectId: 'aaaaaaaaaaaa', displayName: 'x', version: 1 }) + '\n')
}

test('entryIdMode=on：key/project 轨 add 生成随机 ID；memory 轨不生成（一期仅项目轨）', () => {
  const dir = tempDir()
  try {
    syncInit(dir)
    const store = new MemoryStore(dir, { entryIdMode: 'on' })
    const r1 = store.add('key', '决策 X', agent)
    const r2 = store.add('project', '进展 Y', agent)
    const r3 = store.add('memory', '全局事实 Z')
    const keyEntries = store.entriesOf('key', agent)
    const projectEntries = store.entriesOf('project', agent)
    const memoryEntries = store.entriesOf('memory')
    assert.ok(r1.ok && r2.ok && r3.ok)
    assert.match(keyEntries[0], /^\[id:[0-9a-f]{8}\] \[/)
    assert.match(projectEntries[0], /^\[id:[0-9a-f]{8}\] \[/)
    assert.doesNotMatch(memoryEntries[0], /^\[id:/)
    // ID 随机：两条不同内容 ID 不同
    assert.notEqual(extractEntryId(keyEntries[0]), extractEntryId(projectEntries[0]))
  } finally {
    clean(dir)
  }
})

test('entryIdMode=on：同内容重复 add 判重（剥离 ID 比较，不重复添加）', () => {
  const dir = tempDir()
  try {
    syncInit(dir)
    const store = new MemoryStore(dir, { entryIdMode: 'on' })
    const r1 = store.add('key', '唯一事实', agent)
    const r2 = store.add('key', '唯一事实', agent)
    assert.ok(r1.ok)
    assert.ok(r2.ok)
    assert.match(r2.message, /已存在/)
    assert.equal(store.entriesOf('key', agent).length, 1)
  } finally {
    clean(dir)
  }
})

test('entryIdMode=on：replace 继承旧条目 ID（替换不换身份）', () => {
  const dir = tempDir()
  try {
    syncInit(dir)
    const store = new MemoryStore(dir, { entryIdMode: 'on' })
    store.add('key', '原始内容', agent)
    const oldId = extractEntryId(store.entriesOf('key', agent)[0])
    const r = store.replace('key', '原始内容', '新内容', agent)
    assert.ok(r.ok)
    const replaced = store.entriesOf('key', agent)[0]
    // ID 不变、内容已换
    assert.equal(extractEntryId(replaced), oldId)
    assert.ok(replaced.includes('新内容'))
    assert.ok(!replaced.includes('原始内容'))
  } finally {
    clean(dir)
  }
})

test('splitEntryHead：最优先剥离 [id:]（先于时间戳），head 保留 ID', () => {
  const { head, body } = splitEntryHead('[id:abcdef12] [2026-08-11] 内容', 'memory')
  assert.equal(head, '[id:abcdef12] [2026-08-11] ')
  assert.equal(body, '内容')
  // project 轨：ID 在 [日期 时间] 之前
  const p = splitEntryHead('[id:abcdef12] [2026-08-11 09:30] [git main] 日志', 'project')
  assert.equal(p.head, '[id:abcdef12] [2026-08-11 09:30] [git main] ')
  assert.equal(p.body, '日志')
  // 无 ID 时行为不变
  const plain = splitEntryHead('[2026-08-11] 内容', 'memory')
  assert.equal(plain.head, '[2026-08-11] ')
  assert.equal(plain.body, '内容')
})

test('entryIdMode=on：list 出口剥离由展示层负责（stripEntryId 单测已覆盖）——store 原文保留 ID', () => {
  const dir = tempDir()
  try {
    syncInit(dir)
    const store = new MemoryStore(dir, { entryIdMode: 'on' })
    store.add('key', '原文保留', agent)
    const raw = store.entriesOf('key', agent)[0]
    assert.match(raw, /^\[id:/)
    // 展示层剥离后无 ID、内容完整
    assert.equal(stripEntryId(raw), raw.replace(/^\[id:[0-9a-f]{8}\] /, ''))
    assert.ok(!stripEntryId(raw).startsWith('[id:'))
    assert.ok(stripEntryId(raw).includes('原文保留'))
  } finally {
    clean(dir)
  }
})
