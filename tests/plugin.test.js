import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply, resolveConfig, renderSnapshot, resolveRevealTarget, toWindowsPath } from '../lib/index.js'
import { MemoryStore, projectHash } from '../lib/store.js'
import { buildReviewPrompt } from '../lib/review.js'

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
  assert.equal(config.memoryCharLimit, 2200)
  assert.equal(config.reviewEnabled, false)
  assert.equal(config.reviewMode, 'suggest')
  assert.equal(config.reviewInterval, 5)
  assert.equal(config.entryDatePrefix, true)
  assert.equal(config.skillReviewEnabled, false)
  assert.equal(config.skillManageToolName, 'skill_manage')
  assert.ok(config.memoryDir.endsWith('memories'))
  assert.ok(config.skillDir.endsWith(join('.agents', 'skills')))
  assert.throws(() => resolveConfig({ nope: 1 }), /未知配置项/)
  assert.throws(() => resolveConfig({ reviewInterval: 0 }), /正数/)
  assert.throws(() => resolveConfig({ reviewMode: 'x' }), /suggest/)
  assert.throws(() => resolveConfig({ reviewTools: [] }), /非空/)
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
  const listed = await tool.execute({ action: 'list', target: 'user' }, fakeExec())
  assert.equal(listed.entries.length, 1)
  assert.equal(listed.limit, 1375)

  const replaced = await tool.execute({ action: 'replace', target: 'user', content: '用户喜欢中文简洁回答', match: '简洁回答' }, fakeExec())
  assert.equal(replaced.ok, true)
  assert.equal(readFileSync(join(dir, 'USER.md'), 'utf8').includes('中文简洁回答'), true)

  const removed = await tool.execute({ action: 'remove', target: 'user', match: '中文简洁回答' }, fakeExec())
  assert.equal(removed.ok, true)
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

test('review enabled registers suggest tool and trigger; counting gates on message turns', async () => {
  const dir = tempDir()
  const started = []
  const fakeSubagents = {
    getProvider: (name) => ({ name }),
    start: async (name, request) => {
      started.push({ name, request })
      return {
        result: Promise.resolve({ stopReason: 'completed', output: [] }),
        dispose: async () => {},
      }
    },
  }
  const ctx = fakeCtx({ get: (key) => (key === 'subagents' ? fakeSubagents : undefined) })
  apply(ctx, { memoryDir: dir, reviewEnabled: true, reviewInterval: 2, skillReviewEnabled: true })
  const tool = ctx.state.tools.find((t) => t.name === 'memory_suggest')
  assert.ok(tool, 'suggest tool registered when review enabled')

  const settled = ctx.state.listeners['agent/settled'][0]
  assert.ok(settled, 'settled listener installed')

  const agent = (id, turns) => ({
    id,
    session: {
      header: { origin: undefined },
      // A real turn always carries a user message with source.kind 'user';
      // the review digest skips sessions without human input rows. Events
      // carry contiguous seqs (the digest's incremental window keys on them).
      events: turns.flatMap((turn) => [
        { type: 'turn/start', data: { turn, trigger: { kind: 'message' } } },
        { type: 'user/message', data: { id: `u${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `问题${turn}` }] } },
      ]).map((event, seq) => ({ ...event, seq })),
    },
  })

  // turn 1: count 1, no trigger
  settled(agent('s1', [1]), 1, { kind: 'completed' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(started.length, 0)

  // turn 2: count 2 → trigger (scheduled via microtask)
  settled(agent('s1', [1, 2]), 2, { kind: 'completed' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(started.length, 1)
  assert.deepEqual(started[0].request.toolFilter, { allow: ['memory_suggest', 'skill_manage'] })
  assert.equal(started[0].request.label, 'memory-review')
  assert.ok(started[0].request.prompt[0].text.includes('技能审查'), 'prompt covers the skill track')

  // non-message turns and subagent origins never trigger
  const retryAgent = { id: 's2', session: { header: { origin: undefined }, events: [{ type: 'turn/start', data: { turn: 3, trigger: { kind: 'retry' } } }] } }
  settled(retryAgent, 3, { kind: 'completed' })
  const childAgent = { id: 'child', session: { header: { origin: 'subagent' }, events: [{ type: 'turn/start', data: { turn: 4, trigger: { kind: 'message' } } }] } }
  settled(childAgent, 4, { kind: 'completed' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(started.length, 1)
  clean(dir)
})

test('reviews are incremental: later reviews only see new turns', async () => {
  const dir = tempDir()
  const started = []
  const fakeSubagents = {
    getProvider: (name) => ({ name }),
    start: async (name, request) => {
      started.push({ name, request })
      return { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
    },
  }
  const ctx = fakeCtx({ get: (key) => (key === 'subagents' ? fakeSubagents : undefined) })
  apply(ctx, { memoryDir: dir, reviewEnabled: true, reviewInterval: 2 })
  const settled = ctx.state.listeners['agent/settled'][0]
  const agent = (turns) => ({
    id: 's1',
    session: {
      header: { origin: undefined },
      events: turns.flatMap((turn) => [
        { type: 'turn/start', data: { turn, trigger: { kind: 'message' } } },
        { type: 'user/message', data: { id: `u${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `问题${turn}` }] } },
      ]).map((event, seq) => ({ ...event, seq })),
    },
  })

  // First review after turn 2: sees turns 1-2.
  settled(agent([1]), 1, { kind: 'completed' })
  settled(agent([1, 2]), 2, { kind: 'completed' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(started.length, 1)
  const first = started[0].request.prompt[0].text
  assert.ok(first.includes('问题1'), 'first review sees turn 1')
  assert.ok(first.includes('问题2'), 'first review sees turn 2')

  // Second review after turn 4: only turns 3-4, never re-reads the past.
  settled(agent([1, 2, 3]), 3, { kind: 'completed' })
  settled(agent([1, 2, 3, 4]), 4, { kind: 'completed' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(started.length, 2)
  const second = started[1].request.prompt[0].text
  assert.ok(second.includes('问题3'), 'second review sees turn 3')
  assert.ok(second.includes('问题4'), 'second review sees turn 4')
  assert.ok(!second.includes('问题1'), 'second review skips already-reviewed turns')
  assert.ok(!second.includes('问题2'), 'second review skips already-reviewed turns')
  clean(dir)
})

test('review watermarks survive a process restart', async () => {
  const dir = tempDir()
  const makeHarness = () => {
    const started = []
    const fakeSubagents = {
      getProvider: (name) => ({ name }),
      start: async (name, request) => {
        started.push({ name, request })
        return { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
      },
    }
    const ctx = fakeCtx({ get: (key) => (key === 'subagents' ? fakeSubagents : undefined) })
    apply(ctx, { memoryDir: dir, reviewEnabled: true, reviewInterval: 2 })
    const agent = (turns) => ({
      id: 's1',
      session: {
        header: { origin: undefined },
        events: turns.flatMap((turn) => [
          { type: 'turn/start', data: { turn, trigger: { kind: 'message' } } },
          { type: 'user/message', data: { id: `u${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `问题${turn}` }] } },
        ]).map((event, seq) => ({ ...event, seq })),
      },
    })
    return { ctx, started, agent }
  }

  // First process: review after turn 2 advances the watermark to seq 4.
  const first = makeHarness()
  first.ctx.state.listeners['agent/settled'][0](first.agent([1]), 1, { kind: 'completed' })
  first.ctx.state.listeners['agent/settled'][0](first.agent([1, 2]), 2, { kind: 'completed' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(first.started.length, 1)

  // Second process (restart): the persisted watermark means the next review
  // still only sees turns 3-4, never re-reads the whole session.
  const second = makeHarness()
  second.ctx.state.listeners['agent/settled'][0](second.agent([1, 2, 3]), 3, { kind: 'completed' })
  second.ctx.state.listeners['agent/settled'][0](second.agent([1, 2, 3, 4]), 4, { kind: 'completed' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(second.started.length, 1)
  const prompt = second.started[0].request.prompt[0].text
  assert.ok(prompt.includes('问题3'), 'restarted review sees turn 3')
  assert.ok(prompt.includes('问题4'), 'restarted review sees turn 4')
  assert.ok(!prompt.includes('问题1'), 'restarted review skips already-reviewed turns')
  clean(dir)
})

test('review whitelist includes agent_session_read when the tool exists', async () => {
  const dir = tempDir()
  const started = []
  const fakeSubagents = {
    getProvider: (name) => ({ name }),
    start: async (name, request) => {
      started.push({ name, request })
      return { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
    },
  }
  const ctx = fakeCtx({
    get: (key) => (key === 'subagents'
      ? fakeSubagents
      : key === 'tools'
        ? { get: (name) => (name === 'agent_session_read' ? { name } : undefined) }
        : undefined),
    services: {
      tools: {
        register: (def) => { ctx.state.tools.push(def); return () => {} },
        get: (name) => (name === 'agent_session_read' ? { name } : undefined),
      },
    },
  })
  apply(ctx, { memoryDir: dir, reviewEnabled: true, reviewInterval: 1, skillReviewEnabled: true })
  const settled = ctx.state.listeners['agent/settled'][0]
  const agent = {
    id: 's1',
    session: {
      header: { origin: undefined, id: 'sess-x', cwd: '/work' },
      events: [
        { seq: 0, type: 'turn/start', data: { turn: 1, trigger: { kind: 'message' } } },
        { seq: 1, type: 'user/message', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '问题1' }] } },
      ],
    },
  }
  settled(agent, 1, { kind: 'completed' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(started.length, 1)
  assert.deepEqual(started[0].request.toolFilter.allow, ['memory_suggest', 'skill_manage', 'agent_session_read'])
  // The digest header carries the session id for tracing.
  assert.ok(started[0].request.prompt[0].text.includes('sess-x'))
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

test('buildReviewPrompt embeds existing global memory for dedup', async () => {
  const dir = tempDir()
  const store = new MemoryStore(dir)
  store.add('memory', '已有环境事实')
  store.add('user', '已有用户偏好')
  const prompt = buildReviewPrompt('转录内容', resolveConfig({ reviewMode: 'suggest' }), store)
  assert.ok(prompt.includes('【当前已有全局记忆】'))
  assert.ok(prompt.includes('已有环境事实'))
  assert.ok(prompt.includes('已有用户偏好'))
  assert.ok(prompt.includes('不要重复建议'))
  // Without a store the section degrades to a placeholder.
  const bare = buildReviewPrompt('转录内容', resolveConfig({ reviewMode: 'suggest' }))
  assert.ok(bare.includes('【当前已有全局记忆】'))
  assert.ok(bare.includes('未提供已有记忆数据'))
  clean(dir)
})


test('buildReviewPrompt covers both tracks and honors skillReviewEnabled', () => {
  const on = buildReviewPrompt('转录内容', resolveConfig({ reviewMode: 'suggest', skillReviewEnabled: true }))
  assert.ok(on.includes('技能审查'))
  assert.ok(on.includes('skill_manage'))
  assert.ok(on.includes('memory_suggest'))
  assert.ok(on.includes('类级名称'))

  const off = buildReviewPrompt('转录内容', resolveConfig({ reviewMode: 'suggest', skillReviewEnabled: false }))
  assert.ok(!off.includes('技能审查'))
  assert.ok(off.includes('memory_suggest'))

  const auto = buildReviewPrompt('转录内容', resolveConfig({ reviewMode: 'auto' }))
  assert.ok(auto.includes('memory 工具直接写入'))
})

test('buildReviewPrompt: global track only — daily/project moved to per-turn writes', () => {
  const prompt = buildReviewPrompt('转录内容', resolveConfig({ reviewMode: 'suggest' }))
  // daily/project writes are no longer part of the review round (the main
  // session performs them every turn via the snapshot hint)
  assert.ok(!prompt.includes('target: "daily"'))
  assert.ok(!prompt.includes('每个会话至少写 1 条'))
  assert.ok(!prompt.includes('target: "project"'))
  assert.ok(!prompt.includes('target=project'))
  assert.ok(!prompt.includes('target=daily'))
  // global: strict, max 2, via suggest tool
  assert.ok(prompt.includes('最多 2 条'))
  assert.ok(prompt.includes('写全局会被拒绝'))
  // no hand-written date/time prefixes — the program stamps accurately
  assert.ok(prompt.includes('不要在内容中自行添加任何时间/日期前缀'))
  assert.ok(prompt.includes('你无法确知当前日期'))
  // nothing-to-save only for pure small talk
  assert.ok(prompt.includes('Nothing to save'))
  assert.ok(prompt.includes('纯属寒暄'))
  // one-off task narratives are banned for the global track only
  assert.ok(prompt.includes('仅针对全局轨'))
  assert.ok(prompt.includes('"写了篇短文"这类'))
  // the reviewer must extract key points before judging
  assert.ok(prompt.includes('【转录要点】'))
  assert.ok(prompt.includes('不要脑补被省略的内容'))
  // traceability: the reviewer may read the full session when needed
  assert.ok(prompt.includes('agent_session_read'))
  assert.ok(prompt.includes('【会话信息】'))
})

test('final review fires on agent/disposed for unreviewed sessions', async () => {
  const dir = tempDir()
  const started = []
  const fakeSubagents = {
    getProvider: (name) => ({ name }),
    start: async (name, request) => {
      started.push({ name, request })
      return { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
    },
  }
  const ctx = fakeCtx({ get: (key) => (key === 'subagents' ? fakeSubagents : undefined) })
  apply(ctx, { memoryDir: dir, reviewEnabled: true, reviewInterval: 10, reviewFinalOnDispose: true })
  const settled = ctx.state.listeners['agent/settled'][0]
  const disposed = ctx.state.listeners['agent/disposed'][0]
  const agent = {
    id: 's1',
    session: {
      header: { origin: undefined },
      events: [
        { type: 'turn/start', data: { turn: 1, trigger: { kind: 'message' } } },
        { type: 'user/message', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '问题1' }] } },
      ],
    },
  }

  // one user turn, session ends before the interval → final review fires
  settled(agent, 1, { kind: 'completed' })
  disposed(agent)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(started.length, 1)
  assert.equal(started[0].request.label, 'memory-review')
  clean(dir)
})

test('final review skips sessions without user turns and subagent origins', async () => {
  const dir = tempDir()
  const started = []
  const fakeSubagents = {
    getProvider: (name) => ({ name }),
    start: async (name, request) => {
      started.push({ name, request })
      return { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
    },
  }
  const ctx = fakeCtx({ get: (key) => (key === 'subagents' ? fakeSubagents : undefined) })
  apply(ctx, { memoryDir: dir, reviewEnabled: true, reviewInterval: 10 })
  const disposed = ctx.state.listeners['agent/disposed'][0]

  // no turns at all
  disposed({ id: 's1', session: { header: { origin: undefined }, events: [] } })
  // subagent origin
  disposed({ id: 'child', session: { header: { origin: 'subagent' }, events: [{ type: 'turn/start', data: { turn: 1, trigger: { kind: 'message' } } }] } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(started.length, 0)
  clean(dir)
})

test('memory_now command triggers a review through the review api', async () => {
  const dir = tempDir()
  let triggerCalled = null
  const ctx = fakeCtx()
  const realApply = (await import('../lib/index.js')).apply
  // capture the review api by patching installReview via a spy: simpler to
  // exercise the command through the real plugin with a fake subagents
  const started = []
  const fakeSubagents = {
    getProvider: (name) => ({ name }),
    start: async (name, request) => {
      started.push({ name, request })
      return { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
    },
  }
  const ctx2 = fakeCtx({ get: (key) => (key === 'subagents' ? fakeSubagents : undefined) })
  apply(ctx2, { memoryDir: dir, reviewEnabled: true })
  const command = ctx2.state.commands.find((c) => c.name === 'memory_now')
  assert.ok(command, 'memory_now command registered')

  // trigger via command: returns success and schedules a review
  const agent = {
    id: 's1',
    session: {
      header: { origin: undefined },
      events: [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } }],
    },
  }
  const result = command.handler({ rawInput: '', agent })
  assert.equal(result.kind, 'success')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(started.length, 1)
  assert.equal(started[0].request.parent, agent)
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

test('renderSnapshot keeps project and daily on-demand (cache-friendly)', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  const tool = ctx.state.tools.find((t) => t.name === 'memory')
  const agent = { id: 'a', session: { header: { cwd: '/proj/x' } } }
  await tool.execute({ action: 'add', target: 'project', content: 'X 项目事实' }, { agent, callId: 'c11', signal: new AbortController().signal })
  await tool.execute({ action: 'add', target: 'daily', content: '今天完成了 Y' }, { agent, callId: 'c12', signal: new AbortController().signal })
  const config = resolveConfig({ memoryDir: dir })
  const store = new MemoryStore(config.memoryDir, config)
  const snapshot = renderSnapshot(config, store, agent)
  // Project/daily content must NOT enter the runtime-context snapshot: it
  // changes on every write, and injecting it would append a new tail
  // snapshot per turn and defeat LLM prefix caching. A stable hint keeps the
  // model aware the tracks exist (content is read on demand via the tool)
  // and requires a per-turn check for record-worthy facts.
  assert.ok(!snapshot.includes('X 项目事实'))
  assert.ok(!snapshot.includes('今天完成了 Y'))
  assert.ok(!snapshot.includes('## 项目记忆'))
  assert.ok(!snapshot.includes('## 今日记忆'))
  assert.ok(snapshot.includes('## 按需记忆'))
  assert.ok(snapshot.includes('target=project'))
  // per-turn proactive write duty + format discipline (no guessed dates)
  assert.ok(snapshot.includes('每个回合结束前主动检查一次'))
  assert.ok(snapshot.includes('不要为写而写'))
  assert.ok(snapshot.includes('不要在内容中自行添加任何时间/日期前缀'))
  assert.ok(snapshot.includes('你无法确知当前日期'))
  // subagent sessions get the restrained wording instead of the per-turn duty
  const subSnapshot = renderSnapshot(config, store, { id: 's', session: { header: { origin: 'subagent' } } })
  assert.ok(subSnapshot.includes('独立成果'))
  assert.ok(!subSnapshot.includes('每个回合结束前主动检查一次'))
  clean(dir)
})

test('renderSnapshot per-turn write switches compose the hint per track', () => {
  const dir = tempDir()
  const config = resolveConfig({ memoryDir: dir })
  const store = new MemoryStore(config.memoryDir, config)
  const agent = { id: 'a', session: { header: { cwd: '/proj/x' } } }
  // default: both tracks carry the write duty
  const both = renderSnapshot(config, store, agent)
  assert.ok(both.includes('- 项目相关 → target=project'))
  assert.ok(both.includes('- 当天进展 → target=daily'))
  // project off: only daily keeps the write duty; reads stay for both
  const noProject = renderSnapshot(resolveConfig({ memoryDir: dir, perTurnProjectWrites: false }), store, agent)
  assert.ok(!noProject.includes('- 项目相关 → target=project'))
  assert.ok(noProject.includes('- 当天进展 → target=daily'))
  assert.ok(noProject.includes('target=project'), 'read hint for project stays')
  // daily off: only project keeps the write duty
  const noDaily = renderSnapshot(resolveConfig({ memoryDir: dir, perTurnDailyWrites: false }), store, agent)
  assert.ok(noDaily.includes('- 项目相关 → target=project'))
  assert.ok(!noDaily.includes('- 当天进展 → target=daily'))
  // both off: no write duty at all, hint degrades to on-demand reads
  const none = renderSnapshot(resolveConfig({ memoryDir: dir, perTurnProjectWrites: false, perTurnDailyWrites: false }), store, agent)
  assert.ok(!none.includes('写入要求'))
  assert.ok(none.includes('target=project'))
  assert.ok(none.includes('target=daily'))
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

test('autoApproveGlobal lets subagents write global tracks directly', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir, reviewMode: 'suggest', autoApproveGlobal: true })
  const tool = ctx.state.tools.find((t) => t.name === 'memory')
  const subExec = {
    agent: { id: 'child', session: { header: { origin: 'subagent', cwd: '/tmp/x' } } },
    callId: 'c20',
    signal: new AbortController().signal,
  }
  const result = await tool.execute({ action: 'add', target: 'memory', content: '自动沉淀的全局事实' }, subExec)
  assert.equal(result.ok, true)
  assert.ok(readFileSync(join(dir, 'MEMORY.md'), 'utf8').includes('自动沉淀的全局事实'))
  clean(dir)
})

test('autoApproveGlobal off still refuses subagent global writes in suggest mode', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir, reviewMode: 'suggest', autoApproveGlobal: false })
  const tool = ctx.state.tools.find((t) => t.name === 'memory')
  const subExec = {
    agent: { id: 'child', session: { header: { origin: 'subagent', cwd: '/tmp/x' } } },
    callId: 'c21',
    signal: new AbortController().signal,
  }
  const result = await tool.execute({ action: 'add', target: 'user', content: 'x' }, subExec)
  assert.equal(result.ok, false)
  assert.ok(result.message.includes('memory_suggest'))
  clean(dir)
})
