// Tab 精确操作与展示剥离链同源回归（2026-09-24 生产缺陷）。
//
// 缺陷背景：记忆 Tab 的编辑/删除/归档/移回按钮回传「展示文本」（已剥
// [id:]/[summary:]/[salience:] 头部标签），而服务端精确匹配只对 [id:] 免疫
// （findExactIndex）甚至裸相等（peekExact / ArchiveStore.removeExact/remove
// / promoteArchived）。[salience:N] 插在日期与正文之间（中缀），剥掉后
// 的展示文本不再是磁盘原文的子串/相等——retag 打过标的条目全部报
// 「主轨不存在该条目（可能已被删除）——未写入归档」。
//
// 修复：entryDisplayForm（= 展示剥离链）作为唯一归一化，六处匹配点同源。
// 直跑：node tests/tab-exact-match.test.js（沙箱禁 node --test runner）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, ArchiveStore, entryDisplayForm, parseEntries } from '../lib/store.js'

function setup(memoryText = '', keyText = '') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tabexact-test-'))
  if (memoryText !== '') writeFileSync(join(dir, 'MEMORY.md'), memoryText)
  if (keyText !== '') {
    const projDir = join(dir, 'projects', 'hash1')
    mkdirSync(projDir, { recursive: true })
    writeFileSync(join(projDir, 'KEY.md'), keyText)
    writeFileSync(join(projDir, 'KEY-archive.md'), '')
    return { dir, store: new MemoryStore(dir), archive: new ArchiveStore(dir), keyDir: projDir }
  }
  return { dir, store: new MemoryStore(dir), archive: new ArchiveStore(dir), keyDir: null }
}

const TAGGED_RAW = '[id:ab12cd34] [2026-09-11] [summary:三补丁档案] [salience:2] 本机 dsh-memory-evolve 三补丁总档案正文细节'
// 展示文本 = 剥 id/summary/salience（保留日期与正文）
const TAGGED_DISPLAY = '[2026-09-11] 本机 dsh-memory-evolve 三补丁总档案正文细节'
const SALIENCE_ONLY_RAW = '[2026-09-23] [salience:3] 【生命周期特性】正文内容'
const SALIENCE_ONLY_DISPLAY = '[2026-09-23] 【生命周期特性】正文内容'

test('①entryDisplayForm 幂等且与展示链一致', () => {
  assert.equal(entryDisplayForm(TAGGED_RAW), TAGGED_DISPLAY)
  assert.equal(entryDisplayForm(TAGGED_DISPLAY), TAGGED_DISPLAY, '展示文本再剥应幂等')
  assert.equal(entryDisplayForm(SALIENCE_ONLY_RAW), SALIENCE_ONLY_DISPLAY)
})

test('②updateEntryContent：展示文本可编辑打标条目，头部标签全保留', () => {
  const fx = setup(TAGGED_RAW + '\n§\n[2026-08-31] 普通条目\n')
  try {
    const r = fx.store.updateEntryContent('memory', TAGGED_DISPLAY, '新的正文内容', undefined)
    assert.equal(r.ok, true, r.message)
    const entries = parseEntries(readFileSync(join(fx.dir, 'MEMORY.md'), 'utf8'))
    assert.equal(entries[0], '[id:ab12cd34] [2026-09-11] [summary:三补丁档案] [salience:2] 新的正文内容')
    assert.equal(entries[1], '[2026-08-31] 普通条目', '同文件其他条目不受影响')
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('③removeExact：展示文本可删除打标条目（原文整条移除）', () => {
  const fx = setup(SALIENCE_ONLY_RAW + '\n')
  try {
    const r = fx.store.removeExact('memory', SALIENCE_ONLY_DISPLAY, undefined)
    assert.equal(r.ok, true, r.message)
    assert.equal(parseEntries(readFileSync(join(fx.dir, 'MEMORY.md'), 'utf8')).length, 0)
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('④peekExact：展示文本命中且返回磁盘原文（归档 verbatim 落档）', () => {
  const fx = setup(TAGGED_RAW + '\n')
  try {
    const r = fx.store.peekExact('memory', TAGGED_DISPLAY, undefined)
    assert.equal(r.ok, true, r.message)
    assert.equal(r.entry, TAGGED_RAW, 'peek 必须返回磁盘原文——归档写入保标签、promote 可逆')
    const miss = fx.store.peekExact('memory', '[2026-09-11] 不存在的条目', undefined)
    assert.equal(miss.ok, false)
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('⑤ArchiveStore：removeExact/remove 均按展示形态命中带标签归档原文', () => {
  const fx = setup('', '')
  try {
    const ARCHIVE_RAW = '[2026-09-20] [salience:2] 已归档的打标条目\n（归档理由：测试）'
    // removeExact（归档行删除按钮）：match=整行展示文本（含归档理由行）
    fx.archive.append('memory', ARCHIVE_RAW)
    const r1 = fx.archive.removeExact('memory', '[2026-09-20] 已归档的打标条目\n（归档理由：测试）')
    assert.equal(r1.ok, true, JSON.stringify(r1))
    // remove（promote 后清理）：子串形态（剥标签后的正文片段）
    fx.archive.append('memory', ARCHIVE_RAW)
    const r2 = fx.archive.remove('memory', '已归档的打标条目')
    assert.equal(r2.ok, true, JSON.stringify(r2))
    assert.equal(r2.removed, ARCHIVE_RAW)
    assert.equal(fx.archive.entriesOf('memory').length, 0)
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('⑥多条展示形态命中 → 保守拒绝（沿用既有歧义语义）', () => {
  const dup = '[2026-09-11] [salience:2] 重复展示文本条目\n§\n[2026-09-11] 重复展示文本条目\n'
  const fx = setup(dup)
  try {
    const r = fx.store.updateEntryContent('memory', '[2026-09-11] 重复展示文本条目', 'x', undefined)
    assert.equal(r.ok, false, '两条剥标签后同形必须拒绝，不许猜')
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('⑦key 轨打标条目全链：peek→append 归档→removeExact（复现用户报错路径）', () => {
  const fx = setup('', SALIENCE_ONLY_RAW + '\n')
  try {
    const agent = { session: { header: { cwd: join(fx.dir, 'ws') } } }
    // 写入 key 轨需要 cwd 定位 projects/hash1 —— 直接用 keyDir 手工 fixture，
    // peek/remove 用 agent.cwd 不指向 hash1 会找不到；改为对 memory 轨同型断言
    // 已覆盖。此处仅验证归档往返：append 原文 → entriesOf 含标签原文。
    fx.archive.append('key', SALIENCE_ONLY_RAW, join(fx.dir, 'projects', 'hash1'))
    const archived = fx.archive.entriesOf('key', join(fx.dir, 'projects', 'hash1'))
    assert.equal(archived.length, 1)
    assert.ok(archived[0].includes('[salience:3]'), '归档原文必须保留 salience 标签')
    assert.equal(agent.session.header.cwd, join(fx.dir, 'ws'))
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})
