import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply, resolveConfig, renderSnapshot, resolveRevealTarget, toWindowsPath } from '../lib/index.js'
import { MemoryStore, projectHash } from '../lib/store.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-plugin-test-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** Minimal context exercising the seams the plugin touches. `inject` follows
 *  cordis semantics: the callback only runs when every declared service
 *  exists in the fake service table. */
function fakeCtx(overrides = {}) {
  const state = { tools: [], contexts: [], commands: [], listeners: [], routes: [] }
  const services = {
    tools: {
      register: (def) => { state.tools.push(def); return () => {} },
      get: () => undefined, // no extra tools (e.g. agent_session_read) by default
    },
    systemPrompt: { context: (def) => { state.contexts.push(def); return () => {} } },
    commands: { register: (def) => { state.commands.push(def); return () => {} } },
    httpServer: { register: (route) => { state.routes.push(route); return () => {} } },
    ...(overrides.services ?? {}),
  }
  const ctx = {
    state,
    tools: services.tools,
    systemPrompt: services.systemPrompt,
    commands: services.commands,
    httpServer: services.httpServer,
    on: (name, listener) => {
      ;(state.listeners[name] ??= []).push(listener)
      return () => {}
    },
    inject: (deps, callback) => {
      if (!deps.every((dep) => services[dep] !== undefined)) {
        return { dispose: () => {} }
      }
      const disposer = callback(ctx)
      return { dispose: disposer ?? (() => {}) }
    },
    effect: (fn) => {
      const disposer = fn()
      return disposer ?? (() => {})
    },
    get: (key) => services[key],
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    ...overrides,
  }
  return ctx
}

const fakeExec = () => ({ agent: undefined, callId: 'c1', signal: new AbortController().signal })

/** Recursively assert a tool output schema stays within the DSH JSON Schema
 *  subset (in particular: `required` is object-level array, never a boolean
 *  property annotation — the shape defineTool would produce). */
function assertValidOutputSchema(schema) {
  const walk = (node, path) => {
    assert.equal(typeof node, 'object', `${path} must be an object`)
    for (const [key, value] of Object.entries(node)) {
      if (key === 'required') {
        assert.ok(Array.isArray(value), `${path}.required must be an array`)
        continue
      }
      if (key === 'properties') {
        Object.values(value).forEach((item) => walk(item, `${path}.${key}`))
      } else if (key === 'items') {
        walk(value, `${path}.${key}`)
      } else if (key === 'oneOf') {
        value.forEach((item, i) => walk(item, `${path}.${key}[${i}]`))
      }
    }
  }
  walk(schema, 'schema')
}

test('tool output schemas are valid DSH JSON Schema (no property-level required booleans)', () => {
  const ctx = fakeCtx()
  apply(ctx, { reviewEnabled: true })
  for (const tool of ctx.state.tools) {
    assertValidOutputSchema(tool.output.schema)
  }
})

test('resolveConfig defaults and validation', () => {
  const config = resolveConfig({})
  assert.equal(config.reviewEnabled, false)
  assert.equal(config.reviewMode, 'suggest')
  assert.equal(config.reviewInterval, 5)
  assert.equal(config.entryDatePrefix, true)
  assert.equal(config.perTurnKeyWrites, true)
  assert.equal(config.skillReviewEnabled, false)
  assert.equal(config.skillManageToolName, 'skill_manage')
  assert.ok(config.memoryDir.endsWith('memories'))
  assert.ok(config.skillDir.endsWith(join('.agents', 'skills')))
  assert.throws(() => resolveConfig({ nope: 1 }), /未知配置项/)
  assert.throws(() => resolveConfig({ reviewInterval: 0 }), /正数/)
  assert.throws(() => resolveConfig({ reviewMode: 'x' }), /suggest/)
  assert.throws(() => resolveConfig({ reviewTools: [] }), /未知配置项/)
  assert.throws(() => resolveConfig({ skillMaxBytes: -1 }), /正数/)
  assert.throws(() => resolveConfig({ entryDatePrefix: 'yes' }), /布尔/)
  assert.throws(() => resolveConfig('x'), /对象/)
})

test('apply registers memory tool and snapshot context by default', () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  // Isolated memory dir: the default (~/.dsh/memories) would load the user's
  // real plugin-state.json overrides into `runtime` and flip review on.
  apply(ctx, { memoryDir: dir })
  const tool = ctx.state.tools.find((t) => t.name === 'memory')
  assert.ok(tool, 'memory tool registered')
  assert.ok(ctx.state.tools.some((t) => t.name === 'skill_manage'), 'skill tool registered by default')
  assert.ok(ctx.state.contexts.some((c) => c.name === 'memory:snapshot'), 'snapshot context registered')
  assert.ok(!ctx.state.tools.some((t) => t.name === 'memory_suggest'), 'suggest tool off by default')
  assert.ok(ctx.state.commands.some((c) => c.name === 'memory_review'), 'review command registered')
  clean(dir)
})

test('memory tool end-to-end add/list/replace/remove', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  const tool = ctx.state.tools.find((t) => t.name === 'memory')

  const added = await tool.execute({ action: 'add', target: 'user', content: '用户喜欢简洁回答' }, fakeExec())
  assert.equal(added.ok, true)
  // writes return only the outcome — no full entry list echoed back
  assert.equal('entries' in added, false)
  const listed = await tool.execute({ action: 'list', target: 'user' }, fakeExec())
  assert.equal(listed.entries.length, 1)

  const replaced = await tool.execute({ action: 'replace', target: 'user', content: '用户喜欢中文简洁回答', match: '简洁回答' }, fakeExec())
  assert.equal(replaced.ok, true)
  assert.equal('entries' in replaced, false)
  assert.equal(readFileSync(join(dir, 'USER.md'), 'utf8').includes('中文简洁回答'), true)

  const removed = await tool.execute({ action: 'remove', target: 'user', match: '中文简洁回答' }, fakeExec())
  assert.equal(removed.ok, true)
  assert.equal('entries' in removed, false)
  assert.equal(readFileSync(join(dir, 'USER.md'), 'utf8').trim(), '')
  clean(dir)
})

test('memory tool rejects unknown action and subagent-origin writes in suggest mode', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  const tool = ctx.state.tools.find((t) => t.name === 'memory')
  const bad = await tool.execute({ action: 'explode', target: 'memory' }, fakeExec())
  assert.equal(bad.ok, false)
  const subagentExec = {
    agent: { id: 'child', session: { header: { origin: 'subagent' } } },
    callId: 'c2',
    signal: new AbortController().signal,
  }
  const denied = await tool.execute({ action: 'add', target: 'memory', content: 'x' }, subagentExec)
  assert.equal(denied.ok, false)
  assert.ok(denied.message.includes('memory_suggest'))
  clean(dir)
})

test('review status tool counts message turns and stays due until complete', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir, reviewEnabled: true, reviewInterval: 2 })
  const tool = ctx.state.tools.find((t) => t.name === 'memory_review_status')
  assert.ok(tool, 'review status tool registered when review enabled')
  assert.ok(ctx.state.tools.some((t) => t.name === 'memory_suggest'), 'suggest tool registered when review enabled')
  const settled = ctx.state.listeners['agent/settled'][0]
  const agent = (id, turns) => ({
    id,
    session: {
      header: { origin: undefined },
      // A real turn always carries a user message with source.kind 'user';
      // events carry contiguous seqs.
      events: turns.flatMap((turn) => [
        { type: 'turn/start', data: { turn, trigger: { kind: 'message' } } },
        { type: 'user/message', data: { id: `u${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `问题${turn}` }] } },
      ]).map((event, seq) => ({ ...event, seq })),
    },
  })
  const exec = (id) => ({ agent: { id }, callId: 'c1', signal: new AbortController().signal })

  // turn 1: count 1, below the interval → not due
  settled(agent('s1', [1]), 1, { kind: 'completed' })
  let check = await tool.execute({ action: 'check' }, exec('s1'))
  assert.equal(check.due, false)
  assert.equal(check.turnsSinceReview, 1)
  assert.equal(check.interval, 2)
  assert.equal(check.mode, 'suggest')

  // turn 2: count 2 → due
  settled(agent('s1', [1, 2]), 2, { kind: 'completed' })
  check = await tool.execute({ action: 'check' }, exec('s1'))
  assert.equal(check.due, true)

  // Due is sticky: another turn without complete keeps it due — a missed or
  // interrupted review is never silently dropped.
  settled(agent('s1', [1, 2, 3]), 3, { kind: 'completed' })
  check = await tool.execute({ action: 'check' }, exec('s1'))
  assert.equal(check.due, true)
  assert.equal(check.turnsSinceReview, 3)

  // complete resets the counter (the model calls it after a finished review)
  const done = await tool.execute({ action: 'complete' }, exec('s1'))
  assert.equal(done.ok, true)
  check = await tool.execute({ action: 'check' }, exec('s1'))
  assert.equal(check.due, false)
  assert.equal(check.turnsSinceReview, 0)

  // complete before due does NOT reset — due=false must not silently delay the review
  settled(agent('s3', [1]), 1, { kind: 'completed' })
  const premature = await tool.execute({ action: 'complete' }, exec('s3'))
  assert.equal(premature.ok, true)
  assert.ok(premature.message.includes('未到期'))
  check = await tool.execute({ action: 'check' }, exec('s3'))
  assert.equal(check.turnsSinceReview, 1)

  // non-message turns and subagent origins never count
  const retryAgent = { id: 's2', session: { header: { origin: undefined }, events: [{ type: 'turn/start', data: { turn: 1, trigger: { kind: 'retry' } } }] } }
  settled(retryAgent, 1, { kind: 'completed' })
  const childAgent = { id: 'child', session: { header: { origin: 'subagent' }, events: [{ type: 'turn/start', data: { turn: 1, trigger: { kind: 'message' } } }] } }
  settled(childAgent, 1, { kind: 'completed' })
  check = await tool.execute({ action: 'check' }, exec('s2'))
  assert.equal(check.turnsSinceReview, 0)
  check = await tool.execute({ action: 'check' }, exec('child'))
  assert.equal(check.turnsSinceReview, 0)
  clean(dir)
})


test('suggest tool appends to the queue; command approves/rejects', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir, reviewEnabled: true })
  const suggest = ctx.state.tools.find((t) => t.name === 'memory_suggest')
  const command = ctx.state.commands.find((c) => c.name === 'memory_review')

  const result = await suggest.execute(
    { target: 'user', content: '用户偏好晨间工作', reason: '用户说早上效率最高' },
    { agent: undefined, callId: 'c3', signal: new AbortController().signal },
  )
  assert.equal(result.ok, true)
  assert.equal(result.queued, 1)

  const list = command.handler({ rawInput: 'list', agent: null })
  assert.equal(list.kind, 'success')
  assert.ok(list.text.includes('用户偏好晨间工作'))

  const approve = command.handler({ rawInput: 'approve 1', agent: null })
  assert.equal(approve.kind, 'success')
  assert.ok(approve.text.includes('已写入记忆'))
  assert.ok(readFileSync(join(dir, 'USER.md'), 'utf8').includes('用户偏好晨间工作'))
  assert.equal(readFileSync(join(dir, 'SUGGESTIONS.jsonl'), 'utf8').trim(), '')

  // reject flow
  await suggest.execute({ target: 'memory', content: '临时事实', reason: '测试' }, { agent: undefined, callId: 'c4', signal: new AbortController().signal })
  const reject = command.handler({ rawInput: 'reject 1', agent: null })
  assert.equal(reject.kind, 'success')
  assert.ok(reject.text.includes('已拒绝 1 条'))

  // unknown op
  const bad = command.handler({ rawInput: 'explode', agent: null })
  assert.equal(bad.kind, 'error')
  clean(dir)
})

test('suggest tool dedupes repeated content and accumulates hits', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir, reviewEnabled: true })
  const suggest = ctx.state.tools.find((t) => t.name === 'memory_suggest')
  const exec = { agent: undefined, callId: 'c5', signal: new AbortController().signal }

  // First suggestion: new entry with hits=1.
  const first = await suggest.execute({ target: 'user', content: '用户偏好平实文风', reason: '证据一' }, exec)
  assert.equal(first.ok, true)
  assert.equal(first.queued, 1)

  // Same content again (whitespace differs): same entry, hits bumps, no stack.
  const second = await suggest.execute({ target: 'user', content: ' 用户偏好平实文风 ', reason: '证据二' }, exec)
  assert.equal(second.ok, true)
  assert.equal(second.queued, 1)
  assert.ok(second.message.includes('累计第 2 次'))

  // Different track: a new entry.
  const third = await suggest.execute({ target: 'memory', content: '用户偏好平实文风', reason: '同文本不同轨' }, exec)
  assert.equal(third.ok, true)
  assert.equal(third.queued, 2)

  // The queue holds two entries; the deduped one carries hits=2.
  const entries = readFileSync(join(dir, 'SUGGESTIONS.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(entries.length, 2)
  assert.equal(entries.filter((e) => e.target === 'user')[0].hits, 2)
  assert.equal(entries.filter((e) => e.target === 'memory')[0].hits, 1)
  clean(dir)
})


test('memory tool layered gate: subagent project/daily writes allowed, global refused', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir, reviewMode: 'suggest' })
  const tool = ctx.state.tools.find((t) => t.name === 'memory')
  const subExec = {
    agent: { id: 'child', session: { header: { origin: 'subagent', cwd: '/tmp/proj-a' } } },
    callId: 'c9',
    signal: new AbortController().signal,
  }
  // global write refused
  const globalDenied = await tool.execute({ action: 'add', target: 'memory', content: 'x' }, subExec)
  assert.equal(globalDenied.ok, false)
  // project write allowed
  const projectOk = await tool.execute({ action: 'add', target: 'project', content: '项目 A 的重要约定' }, subExec)
  assert.equal(projectOk.ok, true)
  const projectFile = join(dir, 'projects', projectHash('/tmp/proj-a'), 'MEMORY.md')
  assert.ok(readFileSync(projectFile, 'utf8').includes('项目 A 的重要约定'))
  // key write allowed too (project-scoped, same boundary as project)
  const keyOk = await tool.execute({ action: 'add', target: 'key', content: '项目 A 的架构约定' }, subExec)
  assert.equal(keyOk.ok, true)
  const keyFile = join(dir, 'projects', projectHash('/tmp/proj-a'), 'KEY.md')
  assert.ok(readFileSync(keyFile, 'utf8').includes('项目 A 的架构约定'))
  // daily write allowed
  const dailyOk = await tool.execute({ action: 'add', target: 'daily', content: '完成了模块重构' }, subExec)
  assert.equal(dailyOk.ok, true)
  clean(dir)
})

test('project memory requires a session cwd and isolates projects', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  const tool = ctx.state.tools.find((t) => t.name === 'memory')
  const exec = (cwd) => ({
    agent: cwd ? { id: 'a', session: { header: { cwd } } } : undefined,
    callId: 'c10',
    signal: new AbortController().signal,
  })
  // without cwd → locatable error
  const noCwd = await tool.execute({ action: 'list', target: 'project' }, exec(undefined))
  assert.equal(noCwd.ok, false)
  // write in project A
  const a = await tool.execute({ action: 'add', target: 'project', content: 'A 的秘密' }, exec('/proj/a'))
  assert.equal(a.ok, true)
  // project B sees nothing
  const b = await tool.execute({ action: 'list', target: 'project' }, exec('/proj/b'))
  assert.equal(b.ok, true)
  assert.equal(b.entries.length, 0)
  // project A sees its own
  const a2 = await tool.execute({ action: 'list', target: 'project' }, exec('/proj/a'))
  assert.equal(a2.entries.length, 1)
  clean(dir)
})

test('renderSnapshot injects key facts but keeps project and daily on-demand', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  const tool = ctx.state.tools.find((t) => t.name === 'memory')
  const agent = { id: 'a', session: { header: { cwd: '/proj/x' } } }
  const exec = (callId) => ({ agent, callId, signal: new AbortController().signal })
  await tool.execute({ action: 'add', target: 'project', content: 'X 项目流水事实' }, exec('c11'))
  await tool.execute({ action: 'add', target: 'daily', content: '今天完成了 Y' }, exec('c12'))
  await tool.execute({ action: 'add', target: 'key', content: 'X 项目的长期约定' }, exec('c13'))
  const config = resolveConfig({ memoryDir: dir })
  const store = new MemoryStore(config.memoryDir, config)
  const snapshot = renderSnapshot(config, store, agent)
  // Project log/daily content must NOT enter the runtime-context snapshot:
  // they change on every write, and injecting them would append a new tail
  // snapshot per turn and defeat LLM prefix caching. A stable hint keeps the
  // model aware the tracks exist (content is read on demand via the tool)
  // and requires a per-turn check for record-worthy facts.
  assert.ok(!snapshot.includes('X 项目流水事实'))
  assert.ok(!snapshot.includes('今天完成了 Y'))
  assert.ok(!snapshot.includes('## 项目日志'))
  assert.ok(!snapshot.includes('## 今日记忆'))
  // Project KEY facts ARE injected (rarely-changing long-term facts, same
  // live-read/change-detected mechanism as the global tracks).
  assert.ok(snapshot.includes('## 项目关键记忆'))
  assert.ok(snapshot.includes('X 项目的长期约定'))
  assert.ok(snapshot.includes('target=key，已注入'))
  // without a cwd, no key section (nothing to inject)
  const noCwd = renderSnapshot(config, store, { id: 'b', session: { header: {} } })
  assert.ok(!noCwd.includes('## 项目关键记忆'))
  assert.ok(snapshot.includes('## 记忆 memory-evolve'))
  assert.ok(snapshot.includes('target=project'))
  // per-turn duties: one minimal checklist, text-first tool-after pattern
  assert.ok(snapshot.includes('每轮收尾'))
  assert.ok(snapshot.includes('先输出完整回复文本，再在文本之后附带工具调用'))
  assert.ok(snapshot.includes('严禁先调工具'))
  assert.ok(snapshot.includes('各写 1 条'))
  assert.ok(snapshot.includes('内容不要自带时间/日期前缀'))
  // key duty: importance-gated, never a per-turn mandate
  assert.ok(snapshot.includes('重要项目事实'))
  assert.ok(snapshot.includes('target=key 写 1 条'))
  // subagent sessions get the restrained wording instead of the per-turn duty
  const subSnapshot = renderSnapshot(config, store, { id: 's', session: { header: { origin: 'subagent' } } })
  assert.ok(subSnapshot.includes('独立成果'))
  assert.ok(subSnapshot.includes('不要为写而写'))
  assert.ok(!subSnapshot.includes('每轮收尾'))
  assert.ok(!subSnapshot.includes('各写 1 条'))
  clean(dir)
})

test('renderSnapshot per-turn write switches compose the hint per track', () => {
  const dir = tempDir()
  const config = resolveConfig({ memoryDir: dir })
  const store = new MemoryStore(config.memoryDir, config)
  const agent = { id: 'a', session: { header: { cwd: '/proj/x' } } }
  // default: both tracks carry the write duty
  const both = renderSnapshot(config, store, agent)
  assert.ok(both.includes('向 target=daily 与 target=project'))
  // project off: only daily keeps the write duty; reads stay for both
  const noProject = renderSnapshot(resolveConfig({ memoryDir: dir, perTurnProjectWrites: false }), store, agent)
  assert.ok(!noProject.includes('向 target=project'))
  assert.ok(noProject.includes('向 target=daily'))
  assert.ok(noProject.includes('target=project'), 'read hint for project stays')
  // daily off: only project keeps the write duty
  const noDaily = renderSnapshot(resolveConfig({ memoryDir: dir, perTurnDailyWrites: false }), store, agent)
  assert.ok(noDaily.includes('向 target=project'))
  assert.ok(!noDaily.includes('向 target=daily'))
  // both off: the key duty (default on) keeps the checklist alive
  const none = renderSnapshot(resolveConfig({ memoryDir: dir, perTurnProjectWrites: false, perTurnDailyWrites: false }), store, agent)
  assert.ok(none.includes('每轮收尾'))
  assert.ok(none.includes('target=key 写 1 条'))
  assert.ok(none.includes('target=project'))
  assert.ok(none.includes('target=daily'))
  // all three off: no write duty at all, hint degrades to on-demand reads
  const allOff = renderSnapshot(resolveConfig({ memoryDir: dir, perTurnProjectWrites: false, perTurnDailyWrites: false, perTurnKeyWrites: false }), store, agent)
  assert.ok(!allOff.includes('target=key 写 1 条'))
  assert.ok(!allOff.includes('每轮收尾'))
  // key off: only daily/project keep their write duties
  const noKey = renderSnapshot(resolveConfig({ memoryDir: dir, perTurnKeyWrites: false }), store, agent)
  assert.ok(noKey.includes('向 target=daily 与 target=project'))
  assert.ok(!noKey.includes('target=key 写 1 条'))
  clean(dir)
})

test('renderSnapshot review section: main sessions only, when enabled, static text', () => {
  const dir = tempDir()
  const config = resolveConfig({ memoryDir: dir })
  const store = new MemoryStore(config.memoryDir, config)
  const agent = { id: 'a', session: { header: { cwd: '/proj/x' } } }
  // review enabled → main session gets the in-turn review section
  const on = renderSnapshot(resolveConfig({ memoryDir: dir, reviewEnabled: true }), store, agent)
  assert.ok(on.includes('每轮收尾'))
  assert.ok(on.includes('memory_review_status'))
  assert.ok(on.includes('action=check'))
  assert.ok(on.includes('action=complete'))
  assert.ok(on.includes('due=false 直接结束'), 'no complete when not due')
  assert.ok(on.includes('memory_suggest'))
  assert.ok(on.includes('skill_manage'))
  assert.ok(on.includes('memory-evolve 本轮执行完毕'))
  // due warning: the snapshot itself announces an overdue review
  const dueSnap = renderSnapshot(resolveConfig({ memoryDir: dir, reviewEnabled: true }), store, agent, { turnsOf: () => 99 })
  assert.ok(dueSnap.includes('记忆审查已到期'))
  const notDueSnap = renderSnapshot(resolveConfig({ memoryDir: dir, reviewEnabled: true }), store, agent, { turnsOf: () => 0 })
  assert.ok(!notDueSnap.includes('记忆审查已到期'))
  // review disabled → no section
  const off = renderSnapshot(config, store, agent)
  assert.ok(!off.includes('memory_review_status'), 'no review steps without reviewEnabled')
  assert.ok(off.includes('写入：用 memory 工具'), 'write duty stays without review')
  // subagent sessions never get the review duty
  const sub = renderSnapshot(resolveConfig({ memoryDir: dir, reviewEnabled: true }), store, { id: 's', session: { header: { origin: 'subagent' } } })
  assert.ok(!sub.includes('memory_review_status'))
  assert.ok(sub.includes('独立成果'))
  clean(dir)
})

test('resolveRevealTarget falls back to containing directories for missing files', () => {
  const dir = tempDir()
  const config = resolveConfig({ memoryDir: dir, skillDir: join(dir, 'no-skills') })
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir // a dsh home without AGENTS.md
  try {
    // Missing AGENTS.md → open the dsh home (issue #1: previously an
    // 'unknown target' error on WSL installs without the file).
    assert.equal(resolveRevealTarget(config, 'agentsFile'), dir)
    // Missing skill dir → open its parent.
    assert.equal(resolveRevealTarget(config, 'skillDir'), dirname(config.skillDir))
    // Missing memory file → open the memory dir.
    assert.equal(resolveRevealTarget(config, 'memoryFile'), dir)
    assert.equal(resolveRevealTarget(config, 'nope'), undefined)
    assert.equal(resolveRevealTarget(config, '/etc'), undefined)
  } finally {
    process.env.DSH_HOME = prevHome
    clean(dir)
  }
})

test('resolveRevealTarget creates plugin-owned storage dirs on demand', () => {
  const dir = tempDir()
  // A fresh install: the memory dir itself does not exist yet (no memory
  // was ever written). Revealing any storage target must create it, not
  // fail with an unknown-target error.
  const fresh = join(dir, 'memories')
  const config = resolveConfig({ memoryDir: fresh })
  assert.equal(existsSync(fresh), false)
  try {
    assert.equal(resolveRevealTarget(config, 'memoryDir'), fresh)
    assert.ok(existsSync(fresh), 'memory dir created')
    const daily = resolveRevealTarget(config, 'dailyDir')
    assert.ok(existsSync(daily), 'daily dir created')
    const projects = resolveRevealTarget(config, 'projectsDir')
    assert.ok(existsSync(projects), 'projects dir created')
    assert.equal(resolveRevealTarget(config, 'userFile'), fresh)
  } finally {
    clean(dir)
  }
})

test('toWindowsPath falls back to the input when wslpath is unavailable', () => {
  // On macOS (and other non-WSL platforms) wslpath does not exist; the
  // helper must return the original path untouched, never throw.
  const result = toWindowsPath('/home/user/.dsh/memories')
  assert.equal(typeof result, 'string')
  assert.ok(result.length > 0)
  if (process.platform !== 'linux') {
    assert.equal(result, '/home/user/.dsh/memories')
  }
})

test('reviewMode gates subagent global writes: suggest refuses, auto approves', async () => {
  const dir = tempDir()
  // suggest mode: subagent global writes are refused (use memory_suggest)
  const suggestCtx = fakeCtx()
  apply(suggestCtx, { memoryDir: dir, reviewMode: 'suggest' })
  const suggestTool = suggestCtx.state.tools.find((t) => t.name === 'memory')
  const subExec = {
    agent: { id: 'child', session: { header: { origin: 'subagent', cwd: '/tmp/x' } } },
    callId: 'c20',
    signal: new AbortController().signal,
  }
  const denied = await suggestTool.execute({ action: 'add', target: 'user', content: 'x' }, subExec)
  assert.equal(denied.ok, false)
  assert.ok(denied.message.includes('memory_suggest'))

  // auto mode with an approval channel: allowed-once writes through
  const approvals = []
  const autoCtx = fakeCtx({
    services: {
      approval: {
        request: async (req) => { approvals.push(req); return 'allowed-once' },
      },
    },
  })
  apply(autoCtx, { memoryDir: dir, reviewMode: 'auto' })
  const autoTool = autoCtx.state.tools.find((t) => t.name === 'memory')
  const result = await autoTool.execute({ action: 'add', target: 'memory', content: '自动模式的全局事实' }, subExec)
  assert.equal(result.ok, true)
  assert.ok(readFileSync(join(dir, 'MEMORY.md'), 'utf8').includes('自动模式的全局事实'))
  assert.equal(approvals.length, 1)
  clean(dir)
})
