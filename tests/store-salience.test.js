// salience 全链路测试（autopilot-memory-lifecycle Step 3；AC-2.1~2.5 + AC-6.1~6.4）
//
// 覆盖：
//   - AC-2.1 add 带 salience → 头部 [salience:N] 位于 [summary:…] 之后、正文之前；
//     splitEntryHead 剥进 head（编辑正文 tag 原样保留）
//   - AC-2.2 不带参数 → 无 tag
//   - AC-2.3 解析矩阵（≥3 元素）+ 注入必红负向：正文含字面 [salience:9] 不误解析
//   - AC-2.4 stripEntrySalience 导出 + 快照注入与工具回显不含 [salience:…]
//   - AC-2.5 0/4/-1/'x' → 钳制 [1,3] 或拒绝并回显，不产生非法 tag
//   - AC-6.1 旧头部形态（≥3 种）文件 isCanonical=true，add/replace/list/archive 全通
//   - AC-6.2 含 [salience] 文件 parse→serialize round-trip isCanonical=true
//   - AC-6.3 改造前 ENTRY_HEAD_RE（嵌测试留档）解析新文件：不抛错、条目数不变、
//     [salience:x] 作为正文前缀保留
//   - AC-6.4 package.json 无 dependencies/devDependencies 字段新增
//
// 直跑：node tests/store-salience.test.js（沙箱禁 node --test runner）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, buildMemoryContext, renderSnapshot, resolveConfig } from '../lib/index.js'
import {
  MemoryStore, SuggestionQueue, isCanonical, parseEntries, serializeEntries,
  parseEntrySalience, stripEntrySalience, stripEntrySummary, splitEntryHead, projectHash,
  autoSummary,
} from '../lib/store.js'
import { approveSuggestions } from '../lib/review.js'
import { TodoStore } from '../lib/todo.js'
import { setLocale } from '../lib/i18n.js'

// 本套件钉中文输出契约（钳制/拒绝回显文案）；英文键对齐由 i18n.test.js 覆盖。
setLocale('zh')

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-sal-test-'))
}
function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** Minimal fake context（与 plugin.test.js / progressive-disclosure.test.js 同款）。 */
function fakeCtx(overrides = {}) {
  const state = { tools: [], contexts: [], commands: [], listeners: [], routes: [] }
  const services = {
    tools: { register: (def) => { state.tools.push(def); return () => {} }, get: () => undefined },
    systemPrompt: { context: (def) => { state.contexts.push(def); return () => {} } },
    commands: { register: (def) => { state.commands.push(def); return () => {} } },
    webServer: { register: (route) => { state.routes.push(route); return () => {} } },
    ...(overrides.services ?? {}),
  }
  const ctx = {
    state,
    tools: services.tools,
    systemPrompt: services.systemPrompt,
    commands: services.commands,
    webServer: services.webServer,
    on: (name, listener) => { (state.listeners[name] ??= []).push(listener); return () => {} },
    inject: (deps, callback) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return { dispose: () => {} }
      const disposer = callback(ctx)
      return { dispose: disposer ?? (() => {}) }
    },
    effect: (fn) => { const disposer = fn(); return disposer ?? (() => {}) },
    get: (key) => services[key] ?? (key === 'settings' ? { get: (ns) => (ns === 'locale' ? { preference: 'zh' } : undefined) } : undefined),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    ...overrides,
  }
  return ctx
}

function memoryFileOf(dir) {
  return join(dir, 'MEMORY.md')
}

test('AC-2.1 add 带 salience：[salience:N] 位于时间戳之后、正文之前；summary 之后形态', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    const agent = { id: 'a', session: { header: { cwd: '/proj/sal1' } } }
    const added = store.add('memory', '重要性一条的正文', agent, 1)
    assert.equal(added.ok, true)
    const entries = store.entriesOf('memory')
    assert.equal(entries.length, 1)
    // 头部形态：[YYYY-MM-DD] [salience:1] 正文（tag 在正文之前）
    assert.match(entries[0], /^\[\d{4}-\d{2}-\d{2}\] \[salience:1\] 重要性一条的正文$/)
    // 带头部 tag 的条目经 splitEntryHead：tag 剥进 head、正文纯净（编辑保留语义）
    const { head, body } = splitEntryHead(entries[0], 'memory')
    assert.ok(head.includes('[salience:1]'), 'salience tag must be stripped into head')
    assert.equal(body, '重要性一条的正文')
  } finally {
    clean(dir)
  }
})

test('AC-2.1 key 轨（队列路径）：salience 位于 [summary:…] 之后、正文之前；splitEntryHead 剥进 head', async () => {
  const dir = tempDir()
  try {
    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir })
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    const cwd = '/proj/sal2'
    const exec = { agent: { id: 'a', session: { header: { cwd } } }, callId: 'c1', signal: new AbortController().signal }
    const added = await tool.execute({ action: 'add', target: 'key', content: '关键正文', summary: '关键摘要', salience: 3 }, exec)
    assert.equal(added.ok, true)
    // 队列是 JSONL：逐行 parse 取 content 字段断言（文件里的 \n 是转义序列）
    const queuedLines = readFileSync(join(dir, 'SUGGESTIONS.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '')
    const queuedEntry = JSON.parse(queuedLines[queuedLines.length - 1])
    assert.ok(
      /\[summary:[^\]]*\]\s*\n?\[salience:3\] 关键正文/.test(queuedEntry.content),
      `queued content must carry [salience:3] after the summary tag: ${JSON.stringify(queuedEntry.content)}`,
    )
    // 用户确认 → 落盘 KEY.md，tag 原样保留
    const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
    approveSuggestions(new MemoryStore(dir), new TodoStore(dir), queue, [1], undefined)
    const keyFile = join(dir, 'projects', projectHash(cwd), 'KEY.md')
    const entries = readFileSync(keyFile, 'utf8').split('\n§\n').map((e) => e.trim()).filter(Boolean)
    assert.equal(entries.length, 1)
    const { head, body } = splitEntryHead(entries[0], 'key')
    assert.ok(head.includes('[summary:关键摘要]'), 'summary tag stays in head')
    assert.ok(head.includes('[salience:3]'), 'salience tag stripped into head after summary')
    assert.equal(body, '关键正文')
  } finally {
    clean(dir)
  }
})

test('AC-2.2 add 不带 salience：不产生 tag', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    const agent = { id: 'a', session: { header: { cwd: '/proj/sal3' } } }
    store.add('memory', '无重要性参数的正文', agent)
    const entries = store.entriesOf('memory')
    assert.equal(entries.length, 1)
    assert.match(entries[0], /^\[\d{4}-\d{2}-\d{2}\] 无重要性参数的正文$/)
    assert.equal(parseEntrySalience(entries[0]), null)
  } finally {
    clean(dir)
  }
})

test('AC-2.3 解析矩阵（≥3 元素）+ 注入必红负向：正文字面 [salience:9] 不误解析', () => {
  // 表驱动：[条目, 期望档位（null=无 tag）]
  const matrix = [
    ['[2026-09-20] 无 tag 条目', null],                                     // 无 tag
    ['[2026-09-20] [salience:2] 中档条目', 2],                              // 仅 salience
    ['[2026-09-20] [summary:摘] [salience:3] 高档条目', 3],                 // summary + salience（stampEntry 固定顺序）
    ['[2026-09-20] 正文引用了 [salience:9] 这个字面文本', null],            // 负向：越界字面不误解析
    ['[2026-09-20] [salience:3] 正文里提到 [salience:9] 字面', 3],          // 头部合法 + 正文越界共存
    ['[2026-09-20] [summary:只有摘要] 无 salience', null],                  // 仅 summary
  ]
  for (const [entry, expected] of matrix) {
    assert.equal(parseEntrySalience(entry), expected, `parseEntrySalience(${JSON.stringify(entry)})`)
  }
  // 负向必红：stripEntrySalience 对正文里的字面 [salience:9] 原样保留（不剥正文）
  const literal = '[2026-09-20] 正文引用了 [salience:9] 这个字面文本'
  assert.equal(stripEntrySalience(literal), literal)
  // 组合链（展示链的实际用法）：头部 tag 剥净、正文字面不动
  const mixed = '[2026-09-20] [summary:摘] [salience:3] 正文提到 [salience:9]'
  assert.equal(stripEntrySalience(stripEntrySummary(mixed)), '[2026-09-20] 正文提到 [salience:9]')
})

test('AC-2.4 展示剥离：快照注入与 list/expand 回显不含 [salience:…]', async () => {
  const dir = tempDir()
  try {
    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir })
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    const cwd = '/proj/sal4'
    const agent = { id: 'a', session: { header: { cwd } } }
    const exec = { agent, callId: 'c1', signal: new AbortController().signal }
    const store = new MemoryStore(dir)
    store.add('memory', '[salience:1] 记忆轨低档条目正文', agent) // 直接构造头部带 tag 的条目
    store.add('user', '用户档案条目', agent)
    store.add('key', '[summary:关键摘] 关键正文', agent, 2)
    // 快照（memory/user/key 全量注入段）
    const snap = renderSnapshot(resolveConfig({ memoryDir: dir }), store, agent)
    assert.ok(!snap.includes('[salience:'), 'snapshot must not leak salience tags')
    assert.ok(snap.includes('记忆轨低档条目正文'), 'entry body stays')
    // list 回显
    const listed = await tool.execute({ action: 'list', target: 'memory' }, exec)
    assert.equal(listed.ok, true)
    for (const e of listed.entries) assert.ok(!e.includes('[salience:'), 'list output must strip salience')
    // expand 回显（key 轨）
    const keyEntries = store.entriesOf('key', agent)
    const { legacyIdFor } = await import('../lib/sync/entryid.js')
    const id = (await import('../lib/sync/entryid.js')).extractEntryId(keyEntries[0]) ?? legacyIdFor(keyEntries[0])
    const expanded = await tool.execute({ action: 'expand', target: 'key', id }, exec)
    assert.equal(expanded.ok, true)
    assert.ok(!expanded.entries[0].includes('[salience:'), 'expand output must strip salience')
    assert.ok(expanded.entries[0].includes('关键正文'))
  } finally {
    clean(dir)
  }
})

test('AC-2.5 钳制与拒绝：0/4/-1 钳制 [1,3] 并回显；非整数拒绝；非法 tag 不落盘', async () => {
  const dir = tempDir()
  try {
    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir })
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    const agent = { id: 'a', session: { header: { cwd: '/proj/sal5' } } }
    const exec = { agent, callId: 'c1', signal: new AbortController().signal }
    // 0 → 钳到 1
    const r0 = await tool.execute({ action: 'add', target: 'memory', content: '零档正文', salience: 0 }, exec)
    assert.equal(r0.ok, true)
    assert.ok(r0.message.includes('钳制'), `clamp echo expected, got: ${r0.message}`)
    // 4 → 钳到 3
    const r4 = await tool.execute({ action: 'add', target: 'memory', content: '四档正文', salience: 4 }, exec)
    assert.equal(r4.ok, true)
    assert.ok(r4.message.includes('钳制'))
    // -1 → 钳到 1
    const rm1 = await tool.execute({ action: 'add', target: 'memory', content: '负档正文', salience: -1 }, exec)
    assert.equal(rm1.ok, true)
    // 'x' → 拒绝
    const rx = await tool.execute({ action: 'add', target: 'memory', content: '字符串档正文', salience: 'x' }, exec)
    assert.equal(rx.ok, false)
    assert.ok(rx.message.includes('整数'), `reject echo expected, got: ${rx.message}`)
    // 磁盘核对：三个合法写入各归位、非法值未产生条目/tag
    const store = new MemoryStore(dir)
    const entries = store.entriesOf('memory')
    assert.equal(entries.length, 3, "rejected 'x' write must not land")
    const byBody = (body) => entries.find((e) => e.includes(body))
    assert.ok(byBody('零档正文').includes('[salience:1]'))
    assert.ok(byBody('四档正文').includes('[salience:3]'))
    assert.ok(byBody('负档正文').includes('[salience:1]'))
    assert.equal(parseEntrySalience(byBody('零档正文')), 1)
    assert.equal(parseEntrySalience(byBody('四档正文')), 3)
    // project/daily 日志轨：传 salience 忽略并诚实回显（修复轮 P1-3：不得
    // 出现「已钳制」的误导回显——该轨实际不写 tag）
    const rp = await tool.execute({ action: 'add', target: 'project', content: '项目日志正文', salience: 3 }, exec)
    assert.equal(rp.ok, true)
    assert.ok(rp.message.includes('忽略'), `ignored echo expected (P1-3), got: ${rp.message}`)
    assert.ok(!rp.message.includes('钳制'), 'no misleading clamp echo on project track')
    const projEntries = store.entriesOf('project', agent)
    assert.equal(projEntries.length, 1)
    assert.equal(parseEntrySalience(projEntries[0]), null, 'project track must not be tagged')
    assert.ok(!projEntries[0].includes('[salience:'))
  } finally {
    clean(dir)
  }
})

test('AC-6.1 旧头部形态文件（≥3 形态）isCanonical 且 add/replace/list/archive 全通', async () => {
  const dir = tempDir()
  try {
    // 手写五类旧形态（无 salience，改造前形态）
    const legacy = [
      '[2026-09-20] 纯时间戳旧条目',
      '[2026-09-21] [git main] 带分支戳旧条目',
      '[2026-09-22] [summary:旧摘要] 带摘要旧条目',
      '[dsh-only] 仅 DSH 旧条目',
      '裸旧条目',
    ]
    writeFileSync(memoryFileOf(dir), legacy.join('\n§\n') + '\n')
    assert.equal(isCanonical(readFileSync(memoryFileOf(dir), 'utf8')), true, 'legacy file must be canonical')
    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir })
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    const agent = { id: 'a', session: { header: { cwd: '/proj/sal6' } } }
    const exec = { agent, callId: 'c1', signal: new AbortController().signal }
    // add
    const rAdd = await tool.execute({ action: 'add', target: 'memory', content: '新写条目', salience: 2 }, exec)
    assert.equal(rAdd.ok, true)
    // replace（精确匹配唯一旧条目）
    const rRep = await tool.execute({ action: 'replace', target: 'memory', match: '纯时间戳旧条目', content: '纯时间戳旧条目（已更新）' }, exec)
    assert.equal(rRep.ok, true)
    // list
    const rList = await tool.execute({ action: 'list', target: 'memory' }, exec)
    assert.equal(rList.ok, true)
    assert.equal(rList.entries.length, 6)
    // archive（最后执行：会移除条目）
    const rArc = await tool.execute({ action: 'archive', target: 'memory', match: '裸旧条目' }, exec)
    assert.equal(rArc.ok, true)
    const after = new MemoryStore(dir).entriesOf('memory')
    assert.equal(after.length, 5)
    assert.ok(!after.some((e) => e.includes('裸旧条目')), 'archived entry left the main track')
  } finally {
    clean(dir)
  }
})

test('AC-6.2 含 [salience] 文件 parse→serialize round-trip isCanonical=true', () => {
  const entries = [
    '[2026-09-20] [salience:1] 低档条目',
    '[2026-09-21] [summary:摘] [salience:3] 高档条目',
    '[2026-09-22] 无 tag 条目',
  ]
  const text = entries.join('\n§\n') + '\n'
  const roundTripped = serializeEntries(parseEntries(text)).replace(/\n$/, '')
  assert.equal(isCanonical(roundTripped + '\n'), true, 'salience-bearing file must round-trip canonically')
  assert.equal(parseEntries(roundTripped + '\n').length, entries.length, 'entry count preserved')
  assert.ok(roundTripped.includes('[salience:1]') && roundTripped.includes('[salience:3]'), 'tags survive round-trip')
})

test('AC-6.3 改造前 ENTRY_HEAD_RE（嵌测试留档）解析含 [salience] 文件：不抛错、条目数不变、tag 作为正文前缀保留', () => {
  // 改造前（HEAD=4d22c1f）的 ENTRY_HEAD_RE 字面量——旧版本插件解析器的留档。
  // 语义验证：salience 段不在该正则的 head 序列里，[salience:x] 会作为正文
  // 前缀保留（不抛错、内容不丢）——旧读新不炸（spec 向后兼容②）。
  const LEGACY_ENTRY_HEAD_RE = /^(?:\[id:[0-9a-f]{8}\]\s*)?(?:\[\d{4}-\d{2}-\d{2}(?: \d{1,2}:\d{2}(?::\d{2})?)?\]\s*|\[\d{1,2}:\d{2}(?::\d{2})?\]\s*)?(?:\[git [^\]]+\]\s*)*(?:\[branch:[^\]]*\]\s*)?(?:\[dsh-only\]\s*)?/
  const entries = [
    '[2026-09-20] [salience:1] 低档条目',
    '[2026-09-21] [summary:摘] [salience:3] 高档条目',
    '[2026-09-22] [git main] [salience:2] 带分支戳的中档条目',
  ]
  const parsed = serializeEntries(parseEntries(entries.join('\n§\n') + '\n'))
  const roundTripped = parseEntries(parsed)
  assert.equal(roundTripped.length, entries.length, 'legacy regex parse must not throw or lose entries')
  for (let i = 0; i < entries.length; i++) {
    const m = LEGACY_ENTRY_HEAD_RE.exec(roundTripped[i])
    assert.ok(m !== null, 'legacy regex must match')
    const rest = roundTripped[i].slice(m[0].length)
    // 旧解析器视角：[salience:x] 不在 head[0] 里——作为正文（前缀）保留不丢。
    // 带 [summary:] 的条目 summary 同样保留在正文侧（旧解析器不剥它），故用 includes。
    assert.ok(rest.includes('[salience:'), `entry ${i}: salience tag must survive as body prefix under the legacy parser (rest=${JSON.stringify(rest)})`)
  }
})

test('AC-6.4 package.json 无 dependencies/devDependencies 字段新增', () => {
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  assert.equal(pkg.dependencies === undefined, true, 'no dependencies field')
  assert.equal(pkg.devDependencies === undefined, true, 'no devDependencies field')
})

// ── 修复轮（Phase 4 评审处置）──────────────────────────────────────────

test('P1-1 stripEntrySalience 单独调用：只剥 salience、summary 原样保留（两形态矩阵+幂等+组合链）', () => {
  // 单独调用形态矩阵（≥3 元素）：[输入, 期望输出]——前两行是评审探针
  // ①a/①b 的复现形态（修复前分别误剥 summary / 连剥两者）。
  const matrix = [
    // 无 salience、有 summary → 原样返回（用户显式摘要不得丢失）
    ['[2026-09-20] [summary:工作摘要] 今天完成了重构', '[2026-09-20] [summary:工作摘要] 今天完成了重构'],
    // 乱序：salience 在 summary 前 → 只剥 salience，summary 保留
    ['[2026-09-20] [salience:2] [summary:乱序摘要] 乱序正文', '[2026-09-20] [summary:乱序摘要] 乱序正文'],
    // 程序写入顺序：summary 在 salience 前 → 只剥 salience，summary 保留
    ['[2026-09-20] [summary:摘] [salience:3] 高档正文', '[2026-09-20] [summary:摘] 高档正文'],
    // 仅 salience → 剥净
    ['[2026-09-20] [salience:1] 低档正文', '[2026-09-20] 低档正文'],
    // 无 tag → 原样（零变化契约）
    ['[2026-09-20] 无 tag 条目', '[2026-09-20] 无 tag 条目'],
  ]
  for (const [input, expected] of matrix) {
    assert.equal(stripEntrySalience(input), expected, `stripEntrySalience(${JSON.stringify(input)})`)
  }
  // 幂等：二次调用零变化
  const once = stripEntrySalience(matrix[1][0])
  assert.equal(stripEntrySalience(once), once, 'stripEntrySalience must be idempotent')
  // 组合链回归：两种组合顺序都等价于按序剥离（正文 [salience:9] 字面不动）
  const mixed = '[2026-09-20] [summary:摘] [salience:3] 正文提到 [salience:9]'
  assert.equal(stripEntrySalience(stripEntrySummary(mixed)), '[2026-09-20] 正文提到 [salience:9]')
  assert.equal(stripEntrySummary(stripEntrySalience(mixed)), '[2026-09-20] 正文提到 [salience:9]')
})

test('P1-3 project/daily 轨 add 传 salience：诚实回显「已忽略」、无「已钳制」误导、无 tag 落盘', async () => {
  const dir = tempDir()
  try {
    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir })
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    const agent = { id: 'a', session: { header: { cwd: '/proj/fix13' } } }
    const exec = { agent, callId: 'c1', signal: new AbortController().signal }
    // project 轨 + 越界值 5：修复前回显「已钳制为 3」但实际不写 tag（误导回显）
    const rp = await tool.execute({ action: 'add', target: 'project', content: '项目日志越界档', salience: 5 }, exec)
    assert.equal(rp.ok, true)
    assert.ok(rp.message.includes('忽略'), `ignored echo expected, got: ${rp.message}`)
    assert.ok(!rp.message.includes('钳制'), `must not echo "clamped" on project/daily tracks, got: ${rp.message}`)
    // daily 轨 + 合法值 1：同样诚实回显（该轨不写 tag）
    const rd = await tool.execute({ action: 'add', target: 'daily', content: '每日日志合法档', salience: 1 }, exec)
    assert.equal(rd.ok, true)
    assert.ok(rd.message.includes('忽略'), `daily ignored echo expected, got: ${rd.message}`)
    // 磁盘核对：两轨条目落盘且无 tag
    const store = new MemoryStore(dir)
    const projEntries = store.entriesOf('project', agent)
    const dailyEntries = store.entriesOf('daily', agent)
    assert.equal(projEntries.length, 1)
    assert.equal(parseEntrySalience(projEntries[0]), null, 'project track must not be tagged')
    assert.ok(!projEntries[0].includes('[salience:'))
    assert.equal(dailyEntries.length, 1)
    assert.equal(parseEntrySalience(dailyEntries[0]), null, 'daily track must not be tagged')
    assert.ok(!dailyEntries[0].includes('[salience:'))
    // 对照：memory 轨同值仍走钳制回显（分轨语义不降级）
    const rm = await tool.execute({ action: 'add', target: 'memory', content: '对照记忆越界档', salience: 5 }, exec)
    assert.equal(rm.ok, true)
    assert.ok(rm.message.includes('钳制'), 'memory track keeps the clamp echo')
  } finally {
    clean(dir)
  }
})

test('F-1 replace 与 add 同一归一链：salience 透传落 tag；越界钳制；非整数拒绝不动原条目', async () => {
  const dir = tempDir()
  try {
    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir })
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    const agent = { id: 'a', session: { header: { cwd: '/proj/fixf1' } } }
    const exec = { agent, callId: 'c1', signal: new AbortController().signal }
    const store = new MemoryStore(dir)
    store.add('memory', '被替换的原始条目', agent)
    // replace + salience=3：修复前被静默丢弃，现在透传落 tag
    const r3 = await tool.execute({ action: 'replace', target: 'memory', match: '被替换的原始条目', content: '替换后的新条目', salience: 3 }, exec)
    assert.equal(r3.ok, true)
    let entries = store.entriesOf('memory')
    assert.equal(entries.length, 1)
    assert.equal(parseEntrySalience(entries[0]), 3, 'replace must stamp the passed salience (F-1)')
    assert.ok(entries[0].includes('替换后的新条目'))
    // replace + 越界值 0：钳制回显 + 落 [salience:1]
    const r0 = await tool.execute({ action: 'replace', target: 'memory', match: '替换后的新条目', content: '再次替换条目', salience: 0 }, exec)
    assert.equal(r0.ok, true)
    assert.ok(r0.message.includes('钳制'), `clamp echo expected on replace, got: ${r0.message}`)
    entries = store.entriesOf('memory')
    assert.equal(parseEntrySalience(entries[0]), 1)
    // replace + 非整数：拒绝、原条目原样保留
    const rx = await tool.execute({ action: 'replace', target: 'memory', match: '再次替换条目', content: '不应写入的条目', salience: 'x' }, exec)
    assert.equal(rx.ok, false)
    assert.ok(rx.message.includes('整数'), `reject echo expected on replace, got: ${rx.message}`)
    entries = store.entriesOf('memory')
    assert.equal(entries.length, 1)
    assert.ok(entries[0].includes('再次替换条目'), 'rejected replace must not touch the entry')
    // project 轨 replace + salience：忽略回显、不落 tag（与 add 同语义）
    store.add('project', '项目日志原始条目', agent)
    const rproj = await tool.execute({ action: 'replace', target: 'project', match: '项目日志原始条目', content: '项目日志更新条目', salience: 2 }, exec)
    assert.equal(rproj.ok, true)
    assert.ok(rproj.message.includes('忽略'), `project ignored echo expected on replace, got: ${rproj.message}`)
    const projEntries = store.entriesOf('project', agent)
    assert.equal(parseEntrySalience(projEntries.find((e) => e.includes('项目日志更新条目'))), null)
  } finally {
    clean(dir)
  }
})

test('P2-1 buildMemoryContext 注入通道不含 [salience:（memory/user/key 三段全覆盖）', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    const cwd = '/proj/fixp21'
    const agent = { id: 'a', session: { header: { cwd } } }
    store.add('memory', '记忆轨条目正文', agent, 1)
    store.add('user', '用户档案条目正文', agent, 3)
    store.add('key', '关键条目正文', agent, 2)
    const ctxText = buildMemoryContext(store, { cwd })
    assert.ok(ctxText.includes('记忆轨条目正文'), 'memory entry body injected')
    assert.ok(ctxText.includes('用户档案条目正文'), 'user entry body injected')
    assert.ok(ctxText.includes('关键条目正文'), 'key entry body injected')
    assert.ok(!ctxText.includes('[salience:'), 'buildMemoryContext must not leak salience tags (P2-1)')
  } finally {
    clean(dir)
  }
})

test('P2-4 stampEntry 纵深防御：布尔/字符串形态的 salience 不落 tag（store API 直调收口）', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    const agent = { id: 'a', session: { header: { cwd: '/proj/fixp24' } } }
    // 安全评审 P2-4 探针形态：store.add 直传 true → 此前 Number(true)===1 落 [salience:1]
    store.add('memory', '布尔形态正文', agent, true)
    // 字符串形态同理（Number('2')===2 穿透整数检查）
    store.add('memory', '字符串形态正文', agent, '2')
    const entries = store.entriesOf('memory')
    assert.equal(entries.length, 2)
    for (const e of entries) {
      assert.equal(parseEntrySalience(e), null, `non-number salience must not stamp a tag: ${e}`)
      assert.ok(!e.includes('[salience:'))
    }
    // 对照：真数字仍正常落 tag（正常路径不受收口影响）
    store.add('memory', '真数字对照正文', agent, 2)
    assert.equal(parseEntrySalience(store.entriesOf('memory').find((e) => e.includes('真数字对照正文'))), 2)
  } finally {
    clean(dir)
  }
})

test('P2-5 autoSummary 乱序手写条目不残留 [summary:] 字面（循环剥两序全覆盖）', () => {
  // 表驱动（≥3 元素）：[输入, 期望摘要第一行]——首行是评审探针 ③ 形态
  // （修复前返回 '[summary:乱序摘要] 乱序正文第一行'）。
  const matrix = [
    ['[2026-09-20] [salience:2] [summary:乱序摘要] 乱序正文第一行\n第二行', '乱序正文第一行'],
    ['[2026-09-20] [summary:程序摘要] [salience:3] 程序正文', '程序正文'],
    ['[2026-09-20] [summary:仅摘要] 正文行', '正文行'],
    ['[2026-09-20] 无标记正文', '无标记正文'],
  ]
  for (const [entry, expected] of matrix) {
    assert.equal(autoSummary(entry), expected, `autoSummary(${JSON.stringify(entry)})`)
  }
})
