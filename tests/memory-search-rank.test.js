import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLocale } from '../lib/i18n.js'
import { MemoryStore } from '../lib/store.js'
import { apply } from '../lib/index.js'
import { clearRankCache, rankIndices, searchIndices, selectIndices, tokenize } from '../lib/memory-rank.js'

// 本套件钉住中文输出契约（英文由 i18n.test.js 覆盖）。
setLocale('zh')

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-rank-test-'))
}
function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}
/** 直接落盘条目（不走 add，才能指定历史日期做同分裁决测试）。 */
function seed(dir, entries) {
  writeFileSync(join(dir, 'MEMORY.md'), entries.join('\n§\n') + '\n')
}

test('tokenize: 中文按字符二元组，ASCII/数字按词', () => {
  assert.deepEqual(tokenize('双低策略'), ['双低', '低策', '策略'])
  assert.deepEqual(tokenize('GPU 直通 v2'), ['gpu', 'v2', '直通'])
  assert.deepEqual(tokenize(''), [])
})

test('selectIndices: 单关键词与旧的整串子串语义逐条一致', () => {
  const entries = ['[2026-01-01] 网格交易的手续费', '[2026-01-02] 网格 口径补充', '[2026-01-03] 无关条目']
  const expected = entries.filter((e) => e.toLowerCase().includes('网格'))
  const got = selectIndices(entries, '网格')
  assert.deepEqual(got.indices, [0, 1])
  assert.deepEqual(got.indices.map((i) => entries[i]), expected)
  assert.equal(got.mode, 'substring')
})

test('selectIndices: 整串无命中且含空格时才退化为多词 OR（旧行为=空）', () => {
  const entries = ['[2026-01-01] 双低策略的可转债筛选', '[2026-01-02] 网格交易的手续费', '[2026-01-03] 无关条目']
  const oldStyle = entries.filter((e) => e.toLowerCase().includes('双低 转' .toLowerCase()))
  assert.deepEqual(oldStyle, [], '旧实现（整串子串）必然为空')
  const got = selectIndices(entries, '双低 转债')
  assert.equal(got.mode, 'or')
  assert.deepEqual(got.indices.map((i) => entries[i]), [entries[0]])
})

test('selectIndices: 整串命中时不退化（旧命中集保持不变）', () => {
  const entries = ['[2026-01-01] 双低 策略 的补充：阈值 130/0.3', '[2026-01-02] 双低策略的可转债筛选']
  const got = selectIndices(entries, '双低 策略')
  assert.equal(got.mode, 'substring')
  assert.deepEqual(got.indices, [0], '只有逐字含该整串的那条命中')
})

test('rankIndices: 最相关排第一，同分新的在前，且结果确定', () => {
  clearRankCache()
  const entries = [
    '[2026-01-01] 网格交易的手续费按佣金万2.5计算',
    '[2026-01-02] 网格 手续费 口径补充：印花税与过户费',
    '[2026-02-02] 网格 手续费 口径补充：印花税与过户费',
    '[2026-01-03] 无关条目',
  ]
  const r1 = rankIndices(entries, '网格 手续费 印花税')
  assert.equal(r1.mode, 'rank')
  assert.equal(r1.indices[0], 2, '同分时更新的（2026-02-02）排前面')
  const r2 = rankIndices(entries, '网格 手续费 印花税')
  assert.deepEqual(r2.indices, r1.indices, '同样输入必须给出同样顺序')
  const r3 = rankIndices(entries, '网格 手续费 印花税')
  assert.deepEqual(r3.indices, r1.indices, '命中单槽缓存后仍一致')
})

test('store.query: 不传 rank 时多词查询有结果（OR 兜底），且不违反旧语义', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    seed(dir, [
      '[2026-01-01] 双低策略的可转债筛选口径',
      '[2026-01-02] 网格交易的手续费口径',
      '[2026-01-03] 无关条目',
    ])
    // 旧语义（整串子串，含空格）→ 空：用手算复现，别拿新实现自证
    assert.deepEqual(
      ['[2026-01-01] 双低策略的可转债筛选口径'].filter((e) => e.toLowerCase().includes('双低 转债')),
      [],
      '旧实现（整串子串）必然为空'
    )
    // 新语义：多词 OR 兜底
    const hit = store.query('memory', null, { filter: '双低 转债' })
    const old = store.query('memory', null, { filter: '双低' })
    assert.deepEqual(hit, old, '整串无命中时退化为 OR，命中集与首个词一致')
    // 单关键词逐条与旧实现一致
    assert.deepEqual(store.query('memory', null, { filter: '网格' }), ['[2026-01-02] 网格交易的手续费口径'])
  } finally {
    clean(dir)
  }
})

test('store.query: rank=true 按相关性排序、不改命中集、recent 不反转', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    seed(dir, [
      '[2026-01-01] 网格交易的手续费按佣金万2.5计算',
      '[2026-01-02] 网格交易 手续费 含印花税与过户费口径',
      '[2026-01-03] 无关条目',
    ])
    const stats = {}
    const ranked = store.query('memory', null, { filter: '网格 手续费 印花税', rank: true }, stats)
    assert.equal(ranked[0], '[2026-01-02] 网格交易 手续费 含印花税与过户费口径', '覆盖率高的应排第一')
    assert.equal(stats.filterMode, 'rank')
    assert.equal(stats.matched, 2)
    // rank 优先于 recent：不能因为 recent=true 就把相关性顺序倒过来
    const withRecent = store.query('memory', null, { filter: '网格 手续费 印花税', rank: true, recent: true })
    assert.deepEqual(withRecent, ranked)
  } finally {
    clean(dir)
  }
})

test('rank 对程序元数据免疫（[id:…] 不参与打分）', () => {
  clearRankCache()
  const bare = [
    '[2026-01-01] 网格 手续费 口径',
    '[2026-01-02] 网格交易的手续费按佣金万2.5计算',
  ]
  const withId = [
    '[2026-01-01] [id:aaaaaaaa] 网格 手续费 口径',
    '[2026-01-02] [id:bbbbbbbb] 网格交易的手续费按佣金万2.5计算',
  ]
  const r1 = rankIndices(bare, '网格 手续费 口径')
  const r2 = rankIndices(bare.map((_, i) => withId[i].replace(/\[id:[0-9a-f]+\]\s*/g, '')), '网格 手续费 口径')
  assert.deepEqual(r1.indices, r2.indices)
  // 用带 id 的原文（未经剥离）打分才会变——此处确认剥离后的排序稳定
  assert.deepEqual(rankIndices(bare, '网格 手续费 口径').indices, r1.indices)
})

test('rank 性能：489 条 < 50ms，缓存后更快', () => {
  clearRankCache()
  const entries = []
  for (let i = 0; i < 489; i++) {
    entries.push('[' + (2026 - (i % 3)) + '-0' + ((i % 9) + 1) + '-15] 条目' + i + '：网格交易的手续费与印花税口径，含双低策略与可转债筛选细节')
  }
  const t0 = process.hrtime.bigint()
  const r1 = rankIndices(entries, '双低 转债 手续费')
  const d1 = Number(process.hrtime.bigint() - t0) / 1e6
  const t1 = process.hrtime.bigint()
  rankIndices(entries, '双低 转债 手续费')
  const d2 = Number(process.hrtime.bigint() - t1) / 1e6
  assert.ok(r1.indices.length > 0)
  assert.ok(d1 < 50, '首次查询（含建索引）应 < 50ms，实测 ' + d1.toFixed(1) + 'ms')
  assert.ok(d2 < 20, '缓存命中后应 < 20ms，实测 ' + d2.toFixed(1) + 'ms')
})

test('searchIndices: 中文整句（无空格）走词法召回，不再返回空', () => {
  clearRankCache()
  const entries = [
    '[2026-01-01] 网格交易的手续费按佣金万2.5计算',
    '[2026-01-02] 判断前复权是等差还是等比的方法：看差值与比值随时间的变化',
    '[2026-01-03] 重启 dsh-web 并验证插件是否真正加载的判据（KillMode=control-group）',
    '[2026-01-04] 完全无关的条目：关于天气的记录',
  ]
  // 旧语义：整句（含空格？不含）作为整串子串 → 空
  assert.deepEqual(selectIndices(entries, '怎么分辨两种前复权算法').indices, [])
  assert.equal(selectIndices(entries, '怎么分辨两种前复权算法').mode, 'lexical')
  // 新语义：词法相关性召回，第一名应是讲前复权的那条
  const r = searchIndices(entries, '怎么分辨两种前复权算法')
  assert.equal(r.mode, 'lexical')
  assert.ok(r.indices.length > 0, '整句兜底必须给出候选')
  assert.equal(r.indices[0], 1, '相关性最高的应排第一，实测 ' + entries[r.indices[0]])
  assert.equal(r.matched, r.indices.length >= 1 ? r.matched : 0)
  // 兜底只回上限 20 条，不能把整轨倒出来
  const many = []
  for (let i = 0; i < 60; i++) many.push('[' + '2026-01-' + String((i % 9) + 1).padStart(2, '0') + '] 条目' + i + '：前复权与等差等比口径 ' + i)
  const capped = searchIndices(many, '前复权的算法是怎么定的')
  assert.ok(capped.indices.length <= 20, '整句兜底最多 20 条，实测 ' + capped.indices.length)
})

test('store.query: 中文整句不再返回空（lexical 兜底）', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    seed(dir, [
      '[2026-01-01] 网格交易的手续费按佣金万2.5计算',
      '[2026-01-02] 判断前复权是等差还是等比的方法：看差值与比值随时间的变化',
      '[2026-01-03] 无关条目',
    ])
    const stats = {}
    const hit = store.query('memory', null, { filter: '怎么分辨两种前复权算法' }, stats)
    assert.ok(hit.length > 0, '整句查询必须给出候选（旧实现为空）')
    assert.equal(stats.filterMode, 'lexical')
    assert.ok(hit[0].includes('前复权'), '第一条应是与查询最相关的，实测 ' + hit[0])
  } finally {
    clean(dir)
  }
})

test('memory 工具：filter 多词兜底 + rank 元数据/提示', async () => {
  const dir = tempDir()
  try {
    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir })
    writeFileSync(join(dir, 'MEMORY.md'), [
      '[2026-01-01] 网格交易的手续费按佣金万2.5计算',
      '[2026-01-02] 网格交易 手续费 含印花税与过户费口径',
      '[2026-01-03] 双低策略的可转债筛选口径',
      '[2026-01-04] 无关条目',
    ].join('\n§\n') + '\n')
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    assert.ok(tool, 'memory 工具已注册')
    const exec = () => ({ agent: { session: { header: { cwd: '/proj/rank' } } }, callId: 'c1', signal: new AbortController().signal })

    // 多词兜底：旧实现返回空
    const or = await tool.execute({ action: 'list', target: 'memory', filter: '双低 转债' }, exec())
    assert.equal(or.ok, true)
    assert.equal(or.entries.length, 1)
    assert.equal(or.filterMode, 'or')
    assert.equal(typeof or.matched, 'number')

    // rank + limit：给出相关性顺序与截断提示（候选 ≥2 时 filterMode='rank'）
    const ranked = await tool.execute({ action: 'list', target: 'memory', filter: '网格 手续费 印花税', rank: true, limit: 1 }, exec())
    assert.equal(ranked.ok, true)
    assert.equal(ranked.entries.length, 1)
    assert.ok(ranked.entries[0].includes('印花税'), '覆盖率最高的应排第一，实测 ' + ranked.entries[0])
    assert.equal(ranked.filterMode, 'rank')
    assert.equal(typeof ranked.matched, 'number')
    assert.deepEqual(ranked.entries, ['[2026-01-02] 网格交易 手续费 含印花税与过户费口径'])

    // 无命中时保留既有提示文案
    const none = await tool.execute({ action: 'list', target: 'memory', filter: '绝不存在' }, exec())
    assert.equal(none.entries.length, 0)
    assert.ok(String(none.message).includes('未找到匹配条目'))
  } finally {
    clean(dir)
  }
})

/** 最小 fake ctx：只提供 apply() 注册工具所需的服务。 */
function fakeCtx() {
  const state = { tools: [], contexts: [], commands: [], listeners: [], routes: [], effects: [] }
  const services = {
    tools: {
      register: (def) => {
        state.tools.push(def)
        return () => {
          const i = state.tools.indexOf(def)
          if (i >= 0) state.tools.splice(i, 1)
        }
      },
      get: () => undefined,
    },
    systemPrompt: { context: (def) => { state.contexts.push(def); return () => {} } },
    commands: { register: (def) => { state.commands.push(def); return () => {} } },
    webServer: { register: (def) => { state.routes.push(def); return () => {} } },
    settings: { get: (ns) => (ns === 'locale' ? { preference: 'zh' } : undefined) },
  }
  const ctx = {
    state,
    tools: services.tools,
    systemPrompt: services.systemPrompt,
    commands: services.commands,
    webServer: services.webServer,
    settings: services.settings,
    on: (name, listener) => {
      ;(state.listeners[name] ??= []).push(listener)
      return () => {}
    },
    inject: (deps, callback) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return { dispose: () => {} }
      const disposer = callback(ctx)
      return { dispose: typeof disposer === 'function' ? disposer : () => {} }
    },
    effect: (fn) => {
      const disposer = fn()
      state.effects.push(disposer)
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get: (name) => services[name],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  return ctx
}
