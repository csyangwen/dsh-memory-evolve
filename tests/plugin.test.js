import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, resolveConfig, renderSnapshot } from '../lib/index.js'
import { MemoryStore, projectHash } from '../lib/store.js'
import { buildReviewPrompt } from '../lib/review.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-plugin-test-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** Minimal context exercising the seams the plugin touches. */
function fakeCtx(overrides = {}) {
  const state = { tools: [], contexts: [], commands: [], listeners: {} }
  const ctx = {
    state,
    tools: { register: (def) => { state.tools.push(def); return () => {} } },
    systemPrompt: { context: (def) => { state.contexts.push(def); return () => {} } },
    commands: { register: (def) => { state.commands.push(def); return () => {} } },
    on: (name, listener) => {
      ;(state.listeners[name] ??= []).push(listener)
      return () => {}
    },
    inject: (deps, callback) => {
      const disposer = callback(ctx)
      return { dispose: disposer ?? (() => {}) }
    },
    effect: (fn) => {
      const disposer = fn()
      return disposer ?? (() => {})
    },
    get: () => undefined,
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
  assert.equal(config.reviewInterval, 10)
  assert.equal(config.entryDatePrefix, true)
  assert.equal(config.skillReviewEnabled, true)
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
  const ctx = fakeCtx()
  apply(ctx, {})
  const tool = ctx.state.tools.find((t) => t.name === 'memory')
  assert.ok(tool, 'memory tool registered')
  assert.ok(ctx.state.tools.some((t) => t.name === 'skill_manage'), 'skill tool registered by default')
  assert.ok(ctx.state.contexts.some((c) => c.name === 'memory:snapshot'), 'snapshot context registered')
  assert.ok(!ctx.state.tools.some((t) => t.name === 'memory_suggest'), 'suggest tool off by default')
  assert.ok(ctx.state.commands.some((c) => c.name === 'memory_review'), 'review command registered')
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
  apply(ctx, { memoryDir: dir, reviewEnabled: true, reviewInterval: 2 })
  const tool = ctx.state.tools.find((t) => t.name === 'memory_suggest')
  assert.ok(tool, 'suggest tool registered when review enabled')

  const settled = ctx.state.listeners['agent/settled'][0]
  assert.ok(settled, 'settled listener installed')

  const agent = (id, turns) => ({
    id,
    session: {
      header: { origin: undefined },
      events: turns.map((turn) => ({ type: 'turn/start', data: { turn, trigger: { kind: 'message' } } })),
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
  assert.deepEqual(started[0].request.toolFilter, { allow: ['memory', 'memory_suggest', 'skill_manage'] })
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

test('renderSnapshot includes hermes read-only block when present', () => {
  const dir = tempDir()
  const hermesDir = tempDir()
  writeFileSync(join(hermesDir, 'MEMORY.md'), 'Hermes 事实一\n§\nHermes 事实二\n')
  const config = resolveConfig({ memoryDir: dir, hermesMemoriesDir: hermesDir })
  const store = new MemoryStore(config.memoryDir, config)
  const snapshot = renderSnapshot(config, store)
  assert.ok(snapshot.includes('Hermes 记忆（只读'))
  assert.ok(snapshot.includes('Hermes 事实一'))
  clean(dir)
  clean(hermesDir)
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
  const agent = { id: 's1', session: { header: { origin: undefined }, events: [{ type: 'turn/start', data: { turn: 1, trigger: { kind: 'message' } } }] } }

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
      events: [{ type: 'user/message', data: { message: { content: [{ type: 'text', text: '你好' }] } } }],
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

test('renderSnapshot layers project and daily blocks and defaults hermes off', async () => {
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
  assert.ok(snapshot.includes('## 项目记忆（/proj/x）'))
  assert.ok(snapshot.includes('X 项目事实'))
  assert.ok(snapshot.includes('## 今日记忆'))
  assert.ok(snapshot.includes('今日已记录 1 条'))
  assert.ok(!snapshot.includes('Hermes 记忆'), 'hermes injection off by default')
  // other agent cwd: no project block
  const other = renderSnapshot(config, store, { id: 'b', session: { header: { cwd: '/proj/other' } } })
  assert.ok(!other.includes('## 项目记忆'))
  clean(dir)
})
