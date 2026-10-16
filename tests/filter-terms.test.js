// filter 多词 AND 匹配（2026-10-16）——splitFilterTerms / matchesAllTerms /
// store.query 集成。背景：旧实现 filter 是整串小写子串匹配，模型常传多词
// query（如「decay fallbackCount」）时只要条目里没有连续子串就假零命中。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, matchesAllTerms, splitFilterTerms } from '../lib/store.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-terms-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

test('splitFilterTerms: 基础分词', () => {
  assert.deepEqual(splitFilterTerms('decay fallbackCount'), ['decay', 'fallbackcount'])
  assert.deepEqual(splitFilterTerms('  多词   查询  '), ['多词', '查询'])
  assert.deepEqual(splitFilterTerms('single'), ['single'])
  assert.deepEqual(splitFilterTerms('SINGLE'), ['single'])
})

test('splitFilterTerms: 空/纯空白/缺参 → 空数组（不过滤）', () => {
  assert.deepEqual(splitFilterTerms(undefined), [])
  assert.deepEqual(splitFilterTerms(null), [])
  assert.deepEqual(splitFilterTerms(''), [])
  assert.deepEqual(splitFilterTerms('   \t  '), [])
  assert.deepEqual(splitFilterTerms(42), ['42'])
})

test('matchesAllTerms: AND 语义', () => {
  assert.equal(matchesAllTerms('decay 报告 fallbackCount 是 42', ['decay', 'fallbackcount']), true)
  assert.equal(matchesAllTerms('只有 decay 没有 fallback', ['decay', 'fallbackcount']), false)
  assert.equal(matchesAllTerms('任意内容', []), true)
  assert.equal(matchesAllTerms('大小写 FallbackCOUNT', ['fallbackcount']), true)
})

test('store.query: 多词 filter 命中分属两处的词（旧整串匹配会假零命中）', () => {
  const dir = tempDir()
  const store = new MemoryStore(dir)
  assert.equal(store.add('memory', 'decay 衰减报告：阈值 30 天').ok, true)
  assert.equal(store.add('memory', 'fallbackCount 语义见 decay 文档').ok, true)
  assert.equal(store.add('memory', '完全无关的一条').ok, true)
  const hits = store.query('memory', null, { filter: 'decay fallbackcount' })
  // AND 语义：两条都含 decay+fallbackcount 的只有第二条
  assert.equal(hits.length, 1)
  assert.match(hits[0], /fallbackCount 语义见 decay/)
  clean(dir)
})

test('store.query: 单词行为与整串匹配一致；纯空白不过滤', () => {
  const dir = tempDir()
  const store = new MemoryStore(dir)
  assert.equal(store.add('memory', 'hello world').ok, true)
  assert.equal(store.add('memory', '另一条').ok, true)
  assert.equal(store.query('memory', null, { filter: 'hello' }).length, 1)
  // 行为修正登记：旧实现纯空白 filter 会得到零结果（' '.includes 恒 false
  // 的反向），新实现视同未过滤——空过滤条件应放行全部。
  assert.equal(store.query('memory', null, { filter: '   ' }).length, 2)
  clean(dir)
})
