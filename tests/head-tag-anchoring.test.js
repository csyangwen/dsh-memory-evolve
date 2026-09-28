// 头部标签锚定回归（2026-09-24 审计批次 1 · D⑤⑥，f483163 同族残留）。
//
// 缺陷背景：BRANCH_TAG_RE / DSH_ONLY_RE 未锚定头部——正文字面
// [branch:main] 会被 parseEntryBranches 当作用域（注入分支过滤静默误滤），
// 正文字面 [dsh-only] 会让 COI 注入静默跳过；setEntryDshOnly 的裸 replace
// 更会删掉正文字面（单向数据丢失，探针 S5 实证）。
// 修复：parse 全部锚定头部 token 序列；setEntryDshOnly 经 stripEntryDshOnly
// 只剥头部 token。
// 直跑：node tests/head-tag-anchoring.test.js。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryStore, parseEntryBranches, parseEntryDshOnly, stripEntryDshOnly, parseEntries,
} from '../lib/store.js'

function setup(memoryText = '') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-headtag-test-'))
  if (memoryText !== '') writeFileSync(join(dir, 'MEMORY.md'), memoryText)
  return { dir, store: new MemoryStore(dir) }
}

test('⑤a 正文字面 [branch:main] 不算作用域（parseEntryBranches → null）', () => {
  assert.equal(parseEntryBranches('[2026-09-24] 笔记提到 [branch:main] 标签的用法'), null)
  assert.equal(parseEntryBranches('[id:ab12cd34] [2026-09-24] 记录 [branch:dev] 的语义'), null)
  // 头部真 tag 照常解析
  assert.deepEqual(parseEntryBranches('[2026-09-24] [branch:main] 正文'), ['main'])
  assert.deepEqual(parseEntryBranches('[id:ab12cd34] [2026-09-24] [branch:main,dev] 正文'), ['main', 'dev'])
  // 无日期裸头部 tag（手写容错）保持旧行为
  assert.deepEqual(parseEntryBranches('[branch:main] 无时间戳正文'), ['main'])
})

test('⑤b 正文字面 [dsh-only] 不算标记（parseEntryDshOnly → false）', () => {
  assert.equal(parseEntryDshOnly('[2026-09-24] 说明 [dsh-only] 标签的笔记'), false)
  assert.equal(parseEntryDshOnly('[id:ab12cd34] [2026-09-24] 记录 [dsh-only] 机制'), false)
  // 头部真 tag 照常
  assert.equal(parseEntryDshOnly('[2026-09-24] [dsh-only] 真标记条目'), true)
  assert.equal(parseEntryDshOnly('[id:ab12cd34] [2026-09-24] [branch:dev] [dsh-only] 复合头部'), true)
})

test('⑥a setEntryDshOnly 开→关一轮后，正文字面 [dsh-only] 逐字保留（探针 S5 场景）', () => {
  const fx = setup('[2026-09-24] 说明 [dsh-only] 标签的笔记\n')
  try {
    const DISPLAY = '[2026-09-24] 说明 [dsh-only] 标签的笔记'
    const on = fx.store.setEntryDshOnly('memory', DISPLAY, true, undefined)
    assert.equal(on.ok, true, on.message)
    let entries = parseEntries(readFileSync(join(fx.dir, 'MEMORY.md'), 'utf8'))
    assert.match(entries[0], /^\[2026-09-24\] \[dsh-only\] 说明 \[dsh-only\] 标签的笔记$/, '打标后头部带 tag 且正文字面保留')
    const off = fx.store.setEntryDshOnly('memory', entries[0], false, undefined)
    assert.equal(off.ok, true, off.message)
    entries = parseEntries(readFileSync(join(fx.dir, 'MEMORY.md'), 'utf8'))
    assert.equal(entries[0], '[2026-09-24] 说明 [dsh-only] 标签的笔记', '取消后逐字还原（含正文字面）')
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('⑥b stripEntryDshOnly 只剥头部 token，正文不动且幂等', () => {
  const raw = '[id:ab12cd34] [2026-09-24] [dsh-only] 说明 [dsh-only] 标签的笔记'
  const once = stripEntryDshOnly(raw)
  assert.equal(once, '[id:ab12cd34] [2026-09-24] 说明 [dsh-only] 标签的笔记')
  assert.equal(stripEntryDshOnly(once), once, '幂等')
  assert.equal(stripEntryDshOnly('[2026-09-24] 无标记正文 [dsh-only] 字面'), '[2026-09-24] 无标记正文 [dsh-only] 字面')
})
