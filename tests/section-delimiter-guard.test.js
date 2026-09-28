// § 分隔符防线回归（2026-09-24 审计批次 1 · C④）。
//
// 缺陷背景：add/replace 此前不拒 §。探针实证两条破坏路径：
//   S1 正文含独立成行 § → 写盘后 parse 静默拆两条，且拆后仍 canonical
//      （drift guard 永远侦测不到）；
//   S2 正文以 § 结尾 → 文件非 canonical，下次 parse 丢字，此后全部写操作
//      被 drift guard 拒绝（锁死）。
// updateEntryContent 早有同口径拒绝（stt('storetail.sectionDelimiter')），
// 本批把防线延伸到 add/replace 两条主写入路径。
// 直跑：node tests/section-delimiter-guard.test.js。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, parseEntries } from '../lib/store.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sec-guard-'))
  writeFileSync(join(dir, 'MEMORY.md'), '')
  return { dir, store: new MemoryStore(dir) }
}

test('①add 拒绝含独立成行 § 的内容（S1 路径），文件保持 canonical', () => {
  const fx = setup()
  try {
    const r = fx.store.add('memory', '正文前半\n§\n正文后半', undefined)
    assert.equal(r.ok, false, '含 § 的 add 必须被拒绝')
    assert.match(r.message, /§/)
    // 文件未被写入、保持空（canonical）
    assert.equal(parseEntries(readFileSync(join(fx.dir, 'MEMORY.md'), 'utf8')).length, 0)
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('②add 拒绝尾随 § 的内容（S2 路径），不落盘', () => {
  const fx = setup()
  try {
    const r = fx.store.add('memory', '正常内容\n§', undefined)
    assert.equal(r.ok, false, '尾随 § 的 add 必须被拒绝')
    assert.equal(parseEntries(readFileSync(join(fx.dir, 'MEMORY.md'), 'utf8')).length, 0)
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('③replace 拒绝含 § 的新内容，旧条目原样保留', () => {
  const fx = setup()
  try {
    const first = fx.store.add('memory', '旧条目正文', undefined)
    assert.equal(first.ok, true, first.message)
    const r = fx.store.replace('memory', '旧条目正文', '新内容\n§\n后半', undefined)
    assert.equal(r.ok, false, '含 § 的 replace 必须被拒绝')
    const entries = parseEntries(readFileSync(join(fx.dir, 'MEMORY.md'), 'utf8'))
    assert.equal(entries.length, 1)
    assert.match(entries[0], /旧条目正文/, '拒绝后旧条目不被破坏')
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('④合法内容不受影响（正文无 § 正常写入）', () => {
  const fx = setup()
  try {
    const r = fx.store.add('memory', '完全正常的内容，含特殊字符 ！@#￥%……&*（）', undefined)
    assert.equal(r.ok, true, r.message)
    assert.equal(parseEntries(readFileSync(join(fx.dir, 'MEMORY.md'), 'utf8')).length, 1)
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})
