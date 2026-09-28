/**
 * issue #59 回归：**展示层剥离的程序元数据，匹配层必须同样免疫**。
 *
 * 记忆 Tab 下发的是「展示文本」（`buildMemoryFiles()` 剥掉 `[summary:…]` 与
 * `[id:…]`），前端把这份文本当作 raw 回传；而磁盘上存的是含元数据的原文。
 * 历史上匹配层只对 `[id:…]` 免疫（2026-08-11），`[summary:…]` 引入时
 * （2026-08-17 渐进式披露）漏了同步扩展，于是：
 *
 *   - 主轨：带 `[summary:…]` 的条目删除 / 编辑 / 分支范围 / `[dsh-only]`
 *     四个按钮全部报「条目不存在」，归档按钮报「主轨不存在该条目」；
 *   - 归档页：`ArchiveStore.removeExact` 是 `entries.indexOf()` **严格相等**，
 *     连 `[id:…]` 都不免疫——启用 Git 同步后写入身份证的归档条目一律删不掉；
 *     `promoteArchived` 的 `includes` 子串又被 `[summary:…]` 从中间截断。
 *
 * 本文件刻意**调用真实的 `buildMemoryFiles()`** 取展示文本，而不是在测试里
 * 复刻一遍剥离逻辑——否则展示层再剥一种新元数据时，测试会跟着一起漂移，
 * 又变成"测试全绿、线上仍坏"。新增元数据剥离时这里必须跟着红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ArchiveStore, MemoryStore, normalizeForMatch, projectHash } from '../lib/store.js'
import { promoteArchived } from '../lib/review.js'
import { buildMemoryFiles } from '../lib/memory-tab.js'
import { setLocale } from '../lib/i18n.js'

// This suite pins the legacy Chinese output contract; i18n.test.js covers English.
setLocale('zh')

const CWD = '/work/issue-59'
const AGENT = { session: { header: { cwd: CWD } } }

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-me-59-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/**
 * 造一个项目：KEY.md / KEY-archive.md 写入给定条目，返回 store / archive 与该
 * 项目的 cwd。目录取自 store 自己的定位（`pathOf`），保证测试与实现同一处。
 * @param {string[]} keyEntries - 主轨 KEY.md 的条目。
 * @param {string[]} archiveEntries - KEY-archive.md 的条目。
 * @returns {{dir: string, store: MemoryStore, archive: ArchiveStore}} 测试夹具。
 */
function fixture(keyEntries = [], archiveEntries = []) {
  const dir = tempDir()
  const store = new MemoryStore(dir)
  const archive = new ArchiveStore(dir)
  const projectDir = dirname(store.pathOf('key', AGENT))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'KEY.md'), keyEntries.length === 0 ? '' : keyEntries.join('\n§\n') + '\n')
  writeFileSync(join(projectDir, 'KEY-archive.md'), archiveEntries.length === 0 ? '' : archiveEntries.join('\n§\n') + '\n')
  return { dir, store, archive }
}

/**
 * 记忆 Tab 真正下发给前端的某一行文本（前端就是把这份 `content` 当 raw 回传）。
 * @param {object} deps - fixture 的返回值（`{ dir, store }`；`dir` 是记忆根目录）。
 * @param {'key' | 'archive-key'} rowKey - 目标行。
 * @returns {string} 展示文本（已剥离 `[summary:…]` 与 `[id:…]`）。
 */
function displayText({ dir, store }, rowKey) {
  const rows = buildMemoryFiles({ memoryDir: dir }, store, CWD)
  const row = rows.find((entry) => entry.key === rowKey)
  assert.ok(row !== undefined, `记忆 Tab 缺少 ${rowKey} 行`)
  assert.equal(row.exists, true, `${rowKey} 行应存在（路径：${row.path}）`)
  return row.content
}

const WITH_SUMMARY = '[2026-01-01] [summary:一句话摘要] 带摘要的条目正文'
const PLAIN = '[2026-01-02] 不带摘要的条目正文'

// --------------------------------------------------------------------------
// 归一化本身

test('normalizeForMatch：剥掉 [id:…] 与 [summary:…]，正文里的同名字面量不动', () => {
  assert.equal(normalizeForMatch(WITH_SUMMARY), '[2026-01-01] 带摘要的条目正文')
  assert.equal(
    normalizeForMatch('[id:deadbeef] [2026-01-01] [branch:main] [dsh-only] [summary:摘要] 正文'),
    '[2026-01-01] [branch:main] [dsh-only] 正文',
  )
  // 控制组：正文里的 [summary:…] 不是 head token，不得被剥（否则两条不同
  // 条目会被归一化成同一条 → 误删/误匹配）
  assert.equal(
    normalizeForMatch('[2026-01-01] 正文提到 [summary:正文文本] 不算'),
    '[2026-01-01] 正文提到 [summary:正文文本] 不算',
  )
  // 空值兜底
  assert.equal(normalizeForMatch(null), '')
})

// --------------------------------------------------------------------------
// 主轨：Tab 展示文本必须能完成全部精确操作

test('主轨：带 [summary:…] 的条目，用 Tab 展示文本可完成四个精确操作', () => {
  // 展示文本确实被剥过（前提自检：不剥的话本用例测不到东西）
  const { dir, store } = fixture([WITH_SUMMARY])
  const shown = displayText({ dir, store }, 'key')
  assert.equal(shown, '[2026-01-01] 带摘要的条目正文')
  assert.notEqual(shown, WITH_SUMMARY, '前提自检：展示层必须已经剥掉 [summary:…]')
  clean(dir)

  // ① 删除（归档前校验 + 删除按钮）
  {
    const f = fixture([WITH_SUMMARY])
    const text = displayText(f, 'key')
    assert.equal(f.store.peekExact('key', text, AGENT).ok, true, 'peekExact 必须命中')
    const removed = f.store.removeExact('key', text, AGENT)
    assert.equal(removed.ok, true)
    assert.equal(f.store.entriesOf('key', AGENT).length, 0)
    clean(f.dir)
  }
  // ② 编辑正文：时间戳与 [summary:…] 原样保留
  {
    const f = fixture([WITH_SUMMARY])
    const text = displayText(f, 'key')
    assert.equal(f.store.updateEntryContent('key', text, '改写后的正文', AGENT).ok, true)
    const after = f.store.entriesOf('key', AGENT)
    assert.equal(after.length, 1)
    assert.match(after[0], /^\[2026-01-01\] \[summary:一句话摘要\] 改写后的正文$/)
    clean(f.dir)
  }
  // ③ 分支范围（branches 是数组；[] = 全部分支可见，标记被移除）
  {
    const f = fixture([WITH_SUMMARY])
    const text = displayText(f, 'key')
    assert.equal(f.store.setEntryBranches('key', text, ['main'], AGENT).ok, true)
    assert.match(f.store.entriesOf('key', AGENT)[0], /\[branch:main\]/)
    clean(f.dir)
  }
  // ④ [dsh-only] 开关
  {
    const f = fixture([WITH_SUMMARY])
    const text = displayText(f, 'key')
    assert.equal(f.store.setEntryDshOnly('key', text, true, AGENT).ok, true)
    assert.match(f.store.entriesOf('key', AGENT)[0], /\[dsh-only\]/)
    clean(f.dir)
  }
})

test('主轨：不带 [summary:…] 的条目行为不变（控制组）', () => {
  const f = fixture([PLAIN])
  const text = displayText(f, 'key')
  assert.equal(text, PLAIN, '无元数据时展示文本 === 磁盘原文')
  assert.equal(f.store.removeExact('key', text, AGENT).ok, true)
  clean(f.dir)
})

test('peekExact：命中后返回**磁盘原文**（归档「先写后删」不丢元数据）', () => {
  const raw = `[id:deadbeef] ${WITH_SUMMARY}`
  const f = fixture([raw])
  const peeked = f.store.peekExact('key', displayText(f, 'key'), AGENT)
  assert.equal(peeked.ok, true)
  assert.equal(peeked.entry, raw, '返回的必须是磁盘原文，而不是调用方传入的展示文本')
  assert.ok(peeked.entry.includes('[id:deadbeef]'))
  assert.ok(peeked.entry.includes('[summary:一句话摘要]'))
  clean(f.dir)
})

test('主轨歧义：两条仅身份证不同的条目，展示文本匹配按「不存在」保守拒绝', () => {
  const f = fixture(['[id:aaaaaaaa] [2026-01-01] 同内容', '[id:bbbbbbbb] [2026-01-01] 同内容'])
  const result = f.store.removeExact('key', '[2026-01-01] 同内容', AGENT)
  assert.equal(result.ok, false, '归一化后多条命中 → 拒绝，绝不猜')
  assert.equal(f.store.entriesOf('key', AGENT).length, 2, '拒绝时必须一条都不动')
  clean(f.dir)
})

// --------------------------------------------------------------------------
// 归档页：删除（含只有 [id:…] 的条目）与移回主记忆

test('归档页：带 [summary:…] 的条目可删除', () => {
  const raw = `[id:aaaaaaaa] ${WITH_SUMMARY}`
  const f = fixture([], [raw])
  assert.equal(displayText(f, 'archive-key'), '[2026-01-01] 带摘要的条目正文')
  assert.equal(f.archive.removeExact('key', displayText(f, 'archive-key'), CWD).ok, true)
  assert.deepEqual(f.archive.entriesOf('key', CWD), [])
  clean(f.dir)
})

test('归档页：只有 [id:…]（不带 summary）的条目也可删除', () => {
  // 这条单独钉住：ArchiveStore.removeExact 此前是严格 indexOf，连身份证都不免疫
  const raw = '[id:bbbbbbbb] [2026-01-03] 带身份证但不带摘要的归档条目正文'
  const f = fixture([], [raw])
  assert.equal(f.archive.removeExact('key', displayText(f, 'archive-key'), CWD).ok, true)
  assert.deepEqual(f.archive.entriesOf('key', CWD), [])
  clean(f.dir)
})

test('归档轨重复条目：removeExact 取首条（归档允许重复，不报歧义）', () => {
  const f = fixture([], [PLAIN, PLAIN])
  assert.equal(f.archive.entriesOf('key', CWD).length, 2)
  assert.equal(f.archive.removeExact('key', PLAIN, CWD).ok, true)
  assert.equal(f.archive.entriesOf('key', CWD).length, 1, '只删一条')
  clean(f.dir)
})

test('promoteArchived：展示文本可转正，且归档文件被清干净（不留重复）', () => {
  const raw = `[id:aaaaaaaa] ${WITH_SUMMARY}`
  const f = fixture([], [raw])
  const promoted = promoteArchived(f.store, {}, f.archive, 'key', displayText(f, 'archive-key'), CWD)
  assert.equal(promoted.ok, true)
  assert.deepEqual(
    f.archive.entriesOf('key', CWD), [],
    '转正成功后归档里那条必须消失——只修 hits 不修 archive.remove 会留下重复',
  )
  const key = f.store.entriesOf('key', AGENT)
  assert.equal(key.length, 1)
  // 元数据不丢：身份证保留、摘要保留、时间戳按转正日重盖
  assert.match(key[0], /^\[id:aaaaaaaa\] \[\d{4}-\d{2}-\d{2}\] \[summary:一句话摘要\] 带摘要的条目正文$/)
  clean(f.dir)
})

test('promoteArchived：不带 summary 的归档条目仍可转正（控制组）', () => {
  const f = fixture([], ['[id:bbbbbbbb] [2026-01-03] 归档条目正文'])
  assert.equal(promoteArchived(f.store, {}, f.archive, 'key', displayText(f, 'archive-key'), CWD).ok, true)
  assert.deepEqual(f.archive.entriesOf('key', CWD), [])
  assert.match(f.store.entriesOf('key', AGENT)[0], /^\[id:bbbbbbbb\] \[\d{4}-\d{2}-\d{2}\] 归档条目正文$/)
  clean(f.dir)
})

// --------------------------------------------------------------------------
// 控制组：正文里的元数据字面量不得参与匹配

test('控制组：正文里的 [summary:…] 字面量不被误剥、也不误匹配', () => {
  const withLiteral = '[2026-01-01] 正文提到 [summary:正文文本] 不算'
  const without = '[2026-01-01] 正文提到 [summary:正文文本] 算'
  const f = fixture([withLiteral])
  const text = displayText(f, 'key')
  assert.equal(text, withLiteral, '头部没有 summary tag → 展示层不剥正文里的字面量')
  assert.equal(f.store.removeExact('key', text, AGENT).ok, true)
  assert.equal(f.store.entriesOf('key', AGENT).length, 0)
  clean(f.dir)

  // 反向：两条正文只差一个字面量时，匹配必须仍然分得清
  const g = fixture([withLiteral, without])
  assert.equal(g.store.removeExact('key', without, AGENT).ok, true, '按唯一整条命中')
  assert.deepEqual(g.store.entriesOf('key', AGENT), [withLiteral], '另一条必须留下')
  clean(g.dir)
})

test('项目关键记忆落在 projects/<hash>/ 下（展示层与存储层同一目录）', () => {
  // 前提自检：displayText() 之所以能读到行，是因为 buildMemoryFiles 的
  // resolveProjectDir 与 store.pathOf 指向同一处；这条钉住该一致性。
  const f = fixture([PLAIN])
  assert.equal(dirname(f.store.pathOf('key', AGENT)), join(f.dir, 'projects', projectHash(CWD)))
  assert.ok(readFileSync(join(f.dir, 'projects', projectHash(CWD), 'KEY.md'), 'utf8').includes('不带摘要的条目正文'))
  clean(f.dir)
})
