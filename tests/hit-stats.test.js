/**
 * hit-stats 侧车基建测试（autopilot-memory-lifecycle Step 1）。
 * 覆盖 AC-1.3（冷启动）/ AC-1.4（损坏降级）/ AC-1.7（不进同步 fileset）
 * + 原子性（残留 .tmp 不影响读写）+ 损坏注入必红负向 + ≥3 元素断言。
 * 直跑：node tests/hit-stats.test.js（沙箱禁 node --test runner）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hitKey, readSidecar, bumpHits, HIT_STATS_FILE } from '../lib/hit-stats.js'
import { isMemoryFile, GLOBAL_FILESETS, GLOBAL_FILESET_KEYS, PROJECT_SPEC } from '../lib/sync/filesets.js'
import { todayStamp } from '../lib/store.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-hit-stats-test-'))
}

// AC-1.7：hit-stats 不得出现在 lib/sync/filesets.js 任何 fileset 清单
// （文本级 grep 断言 + 结构级遍历断言双层，防未来新增 fileset 误卷入）。
test('AC-1.7: hit-stats 不出现在同步 fileset（文本 grep + 结构遍历双层）', () => {
  const filesetsSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'sync', 'filesets.js'),
    'utf8',
  )
  assert.equal(filesetsSrc.includes('hit-stats'), false, 'filesets.js 文本不得出现 hit-stats')
  // 结构级：PROJECT_SPEC 与全部 GLOBAL_FILESETS 的 memory/todo 清单都不含
  for (const f of PROJECT_SPEC.memory) assert.notEqual(f, HIT_STATS_FILE)
  for (const f of PROJECT_SPEC.todo) assert.notEqual(f, HIT_STATS_FILE)
  for (const key of GLOBAL_FILESET_KEYS) {
    for (const f of GLOBAL_FILESETS[key].memory) assert.notEqual(f, HIT_STATS_FILE)
    for (const f of GLOBAL_FILESETS[key].todo) assert.notEqual(f, HIT_STATS_FILE)
    assert.equal(isMemoryFile(HIT_STATS_FILE, key), false, `${key} fileset 不得放行 hit-stats.json`)
  }
  assert.equal(isMemoryFile(HIT_STATS_FILE, 'project'), false, 'project fileset 不得放行 hit-stats.json')
})

test('AC-1.3: 冷启动——无侧车的目录首次读写自动初始化，无异常', () => {
  const dir = tempDir()
  try {
    // 初始读取：无文件 → 空表，不抛
    assert.deepEqual(readSidecar(dir), {})
    // 首次回填：目录自动初始化
    bumpHits(dir, 'memory', '[2026-01-01] 条目甲')
    assert.equal(existsSync(join(dir, HIT_STATS_FILE)), true, '侧车文件已创建')
    const stats = readSidecar(dir)
    const keys = Object.keys(stats)
    assert.equal(keys.length, 1)
    assert.ok(keys[0].startsWith('memory:'), '键带 track 前缀')
    assert.equal(stats[keys[0]].hitCount, 1)
    assert.equal(stats[keys[0]].lastAccessed, todayStamp())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hitKey: ≥3 元素输入——3 条不同条目 3 个不同键；同条目同键；键形如 track:sha1(40hex)', () => {
  const entries = [
    '[2026-09-23] [id:aaaaaaaa] 第一条内容',
    '[2026-09-22] 第二条内容',
    '[2026-09-21] [summary:摘要] 第三条内容',
  ]
  const keys = entries.map((e) => hitKey('memory', e))
  assert.equal(new Set(keys).size, 3, '三条互异条目 → 三个互异键')
  assert.equal(hitKey('memory', entries[0]), keys[0], '同条目重复计算 → 同键')
  for (const [i, k] of keys.entries()) {
    assert.match(k, /^memory:[0-9a-f]{40}$/, '键 = track: + sha1 hex 40 位')
    assert.equal(k, `memory:${createHash('sha1').update(entries[i], 'utf8').digest('hex')}`, 'sha1 口径精确对齐')
  }
  // 展示剥离形态（stripEntryId 之后）必须得到**不同**的键——口径防漂移
  assert.notEqual(
    hitKey('memory', entries[0]),
    hitKey('memory', entries[0].replace('[id:aaaaaaaa] ', '')),
    '剥离 [id:…] 后的文本键必须不同（Q1：禁止用展示剥离形态回填）',
  )
  // 轨道前缀隔离：同条目在 user 轨与 key 轨是不同键
  assert.notEqual(hitKey('memory', entries[0]), hitKey('user', entries[0]))
  assert.notEqual(hitKey('key', entries[0]), hitKey('user', entries[0]))
})

test('bumpHits: ≥3 元素批量——3 条一次 +1；二次命中累计；空输入零写入', () => {
  const dir = tempDir()
  try {
    const e1 = '[2026-09-23] [id:b1] 甲'
    const e2 = '[2026-09-23] [id:b2] 乙'
    const e3 = '[2026-09-23] [id:b3] 丙'
    bumpHits(dir, 'memory', [e1, e2, e3])
    let stats = readSidecar(dir)
    for (const e of [e1, e2, e3]) {
      assert.equal(stats[hitKey('memory', e)].hitCount, 1, `${e} 首次命中 = 1`)
    }
    assert.equal(Object.keys(stats).length, 3, '恰 3 个键')
    // 二次命中同一批 → 累计 +1
    bumpHits(dir, 'memory', [e1, e3])
    stats = readSidecar(dir)
    assert.equal(stats[hitKey('memory', e1)].hitCount, 2)
    assert.equal(stats[hitKey('memory', e2)].hitCount, 1)
    assert.equal(stats[hitKey('memory', e3)].hitCount, 2)
    // 空数组 / 空串 / 非数组非字符串的空串化 → 不产生新键不写盘
    const before = readFileSync(join(dir, HIT_STATS_FILE), 'utf8')
    bumpHits(dir, 'memory', [])
    bumpHits(dir, 'memory', '')
    bumpHits(dir, 'memory', ['', '   '])
    assert.equal(readFileSync(join(dir, HIT_STATS_FILE), 'utf8'), before, '空输入零写入')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AC-1.4: 损坏降级——垃圾字节读侧返回空表+告警；写侧静默重置不抛', () => {
  const dir = tempDir()
  const errors = []
  const origError = console.error
  console.error = (...args) => { errors.push(args.join(' ')) }
  try {
    const path = join(dir, HIT_STATS_FILE)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, '\x00\xFF garbage bytes not json {{{')
    // 读侧：空表 + console.error 告警留档，不抛
    assert.deepEqual(readSidecar(dir), {})
    assert.ok(errors.some((m) => m.includes('hit-stats')), '读侧损坏有告警留档')
    // 写侧（注入必红负向：若 bumpHits 把损坏表当有效数据合并会写出垃圾——
    // 契约是静默重置为新统计）
    errors.length = 0
    bumpHits(dir, 'user', '[2026-09-23] 损坏后首个命中')
    const stats = readSidecar(dir)
    assert.equal(Object.keys(stats).length, 1, '损坏后统计重置，仅含新命中')
    const rec = Object.values(stats)[0]
    assert.equal(rec.hitCount, 1)
    assert.equal(rec.lastAccessed, todayStamp())
    assert.ok(errors.some((m) => m.includes('hit-stats')), '写侧损坏同样有告警留档')
  } finally {
    console.error = origError
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AC-1.4 变体: 侧车为合法 JSON 但非对象（数组/null/标量）→ 同样降级重置', () => {
  for (const garbage of ['[1,2,3]', 'null', '"text"', '42']) {
    const dir = tempDir()
    const errors = []
    const origError = console.error
    console.error = (...args) => { errors.push(args.join(' ')) }
    try {
      writeFileSync(join(dir, HIT_STATS_FILE), garbage)
      assert.deepEqual(readSidecar(dir), {}, `垃圾形态 ${garbage} → 空表`)
      assert.ok(errors.length > 0, `垃圾形态 ${garbage} 有告警`)
    } finally {
      console.error = origError
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('F-2: readSidecar 危险键收口——__proto__/constructor 自有键删除、正常键不受影响', () => {
  // 注入必红对照：删掉 readSidecar 里的两行 delete 后本用例必红。
  // 手写原始字符串构造该形态（JSON.stringify 不会产出 __proto__ 自有键；
  // JSON.parse 按 V8 语义把 __proto__ 解析为普通自有数据属性、不设原型）。
  const dir = tempDir()
  try {
    writeFileSync(
      join(dir, HIT_STATS_FILE),
      '{"__proto__":{"polluted":1},"constructor":{"x":1},"memory:abc":{"hitCount":1,"lastAccessed":"2026-09-23"}}',
    )
    const stats = readSidecar(dir)
    assert.equal(Object.prototype.hasOwnProperty.call(stats, '__proto__'), false, '__proto__ own key must be stripped (F-2)')
    assert.equal(Object.prototype.hasOwnProperty.call(stats, 'constructor'), false, 'constructor own key must be stripped (F-2)')
    // 收口不误伤：正常受限键形数据原样可用
    assert.equal(stats['memory:abc'].hitCount, 1)
    assert.equal(stats['memory:abc'].lastAccessed, '2026-09-23')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('原子性: 残留 .tmp 文件存在时读写不受影响', () => {
  const dir = tempDir()
  try {
    const e1 = '[2026-09-23] 正常条目'
    bumpHits(dir, 'memory', e1)
    // 模拟写中断：手动留一个 .tmp 残留（含陈旧数据）
    const staleTmp = `${join(dir, HIT_STATS_FILE)}.tmp.999999`
    writeFileSync(staleTmp, JSON.stringify({ stale: { hitCount: 999 } }))
    // 读：只认正式文件，.tmp 残留不参与
    const stats = readSidecar(dir)
    assert.equal(Object.keys(stats).length, 1)
    assert.equal(stats[hitKey('memory', e1)].hitCount, 1)
    // 写：再次回填正常完成，且正式文件不包含陈旧 tmp 内容
    bumpHits(dir, 'memory', e1)
    const after = readSidecar(dir)
    assert.equal(after[hitKey('memory', e1)].hitCount, 2)
    assert.equal(after.stale, undefined, '陈旧 tmp 数据不得混入')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('失败隔离: bumpHits 任何异常不上抛（dir 非法/锁不可得均静默）', () => {
  const errors = []
  const origError = console.error
  console.error = (...args) => { errors.push(args.join(' ')) }
  try {
    // dir 指向一个已存在的**文件**（非目录）→ withLock/写盘必失败
    const filePath = join(tempDir(), 'plain-file')
    writeFileSync(filePath, 'i am a file')
    assert.doesNotThrow(() => bumpHits(filePath, 'memory', '[2026-09-23] x'), '非法 dir 不上抛')
    assert.doesNotThrow(() => bumpHits(filePath, 'memory', ['a', 'b']), '批量同上')
    assert.ok(errors.length > 0, '失败有 console.error 留档')
    rmSync(filePath, { recursive: true, force: true })
  } finally {
    console.error = origError
  }
})

test('键空间隔离: 同目录双轨回填互不覆盖（memory 与 user 各自累计）', () => {
  const dir = tempDir()
  try {
    const e = '[2026-09-23] [id:cc] 双轨条目'
    bumpHits(dir, 'memory', e)
    bumpHits(dir, 'user', e)
    bumpHits(dir, 'memory', e)
    const stats = readSidecar(dir)
    assert.equal(stats[hitKey('memory', e)].hitCount, 2, 'memory 轨独立累计')
    assert.equal(stats[hitKey('user', e)].hitCount, 1, 'user 轨独立累计')
    assert.equal(Object.keys(stats).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('侧车目录嵌套创建: dir 不存在时 bumpHits 自动 mkdir', () => {
  const root = tempDir()
  const dir = join(root, 'deep', 'nested', 'track')
  try {
    bumpHits(dir, 'key', '[2026-09-23] key 轨条目')
    assert.equal(existsSync(join(dir, HIT_STATS_FILE)), true)
    assert.equal(readdirSync(dir).includes(HIT_STATS_FILE), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
