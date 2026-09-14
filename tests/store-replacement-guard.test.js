import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLocale, translate, STORE_DICT } from '../lib/i18n.js'
import { MemoryStore } from '../lib/store.js'

/** Mirror lib/store.js's own `st()` so tests pin the exact rendered warning. */
const st = (key, params) => translate(STORE_DICT, key, params, setLocale())

// U+FFFD 写入检测（2026-09-14 实证驱动）：持久化记忆里的替换字符来自上游写入
// 链路的有损字节→文本解码（多字节字符在传输/解码边界被截断）。store.write 记录
// 本次写入的损坏计数，memory 工具结果随写随报（consume-once），让写它的会话当场
// 修复。此前 45 处损坏静默累积四天才在整理时被发现。

setLocale('zh')

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-mem-guard-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

test('clean write: no corrupt-write record', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    const result = store.add('memory', '干净的条目内容')
    assert.equal(result.ok, true)
    assert.equal(store.takeCorruptWrite(), null)
  } finally {
    clean(dir)
  }
})

test('corrupted write detected with entry/char counts; consume-once', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    // 模拟传输层损坏：一个三字节汉字被拆成两个 U+FFFD（2026-09-14 实证形态）
    const result = store.add('memory', '工具兜\uFFFD\uFFFD已过时的旧记录')
    assert.equal(result.ok, true)
    assert.deepEqual(store.takeCorruptWrite(), { target: 'memory', entries: 1, chars: 2 })
    // consume-once：读后即清，不会在后续读操作里重复报
    assert.equal(store.takeCorruptWrite(), null)
  } finally {
    clean(dir)
  }
})

test('replace funnels through the same guard; clean write clears the record', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    assert.equal(store.add('memory', '旧记录甲').ok, true)
    assert.equal(store.takeCorruptWrite(), null)
    // 损坏版 replace → 检出
    const bad = store.replace('memory', '旧记录甲', '修订版含损\uFFFD\uFFFD\uFFFD坏')
    assert.equal(bad.ok, true)
    assert.deepEqual(store.takeCorruptWrite(), { target: 'memory', entries: 1, chars: 3 })
    // 干净版 replace → 记录归零
    const good = store.replace('memory', '修订版含损\uFFFD\uFFFD\uFFFD坏', '修订版已修复')
    assert.equal(good.ok, true)
    assert.equal(store.takeCorruptWrite(), null)
  } finally {
    clean(dir)
  }
})

test('warning formats in the add() locale (zh); note rides the tool result layer', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    const result = store.add('memory', '带损坏字符的条目\uFFFD')
    assert.equal(result.ok, true)
    // 告警文案在工具层（index.js 出口）用同一 i18n 格式化拼接进 result.message；
    // store 层负责检出与计数，这里钉住两者的拼接素材
    const hit = store.takeCorruptWrite()
    assert.deepEqual(hit, { target: 'memory', entries: 1, chars: 1 })
    assert.match(st('store.replacementChars', hit), /U\+FFFD/)
    assert.match(st('store.replacementChars', hit), /1 个/)
  } finally {
    clean(dir)
  }
})

test('english locale formats the same warning', () => {
  const dir = tempDir()
  try {
    setLocale('en')
    const store = new MemoryStore(dir)
    const result = store.add('memory', 'corrupted entry \uFFFD\uFFFD')
    assert.equal(result.ok, true)
    const hit = store.takeCorruptWrite()
    assert.deepEqual(hit, { target: 'memory', entries: 1, chars: 2 })
    assert.match(st('store.replacementChars', hit), /replacement character/)
    assert.match(st('store.replacementChars', hit), /\b2\b/)
  } finally {
    setLocale('zh')
    clean(dir)
  }
})
