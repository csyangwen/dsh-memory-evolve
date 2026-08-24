import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { apply, gitBranch, gitBranchList, resolveConfig, renderSnapshot, resolveRevealTarget, toWindowsPath } from '../lib/index.js'
import { installCanvas } from '../lib/canvas.js'
import { MemoryStore, projectHash } from '../lib/store.js'

/** Whether `git` is available in this environment (skip git tests otherwise). */
function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

/** Create a real git worktree with one commit on `test-main` (null on failure). */
function initGitRepo(dir) {
  const init = spawnSync('git', ['init', '-q', '-b', 'test-main'], { cwd: dir, stdio: 'ignore' })
  if (init.status !== 0) return null
  // A commit materializes refs/heads/test-main so `git branch` lists it.
  const commit = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir, stdio: 'ignore' })
  return commit.status === 0 ? 'test-main' : null
}

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
      register: (def) => {
        state.tools.push(def)
        // 返回真正移除的 disposer（与 DSH tools.register 一致）：测试
        // installCanvas().dispose() 注销工具需要它（2026-08-14 PR #8）。
        return () => {
          const i = state.tools.indexOf(def)
          if (i >= 0) state.tools.splice(i, 1)
        }
      },
      get: () => undefined, // no extra tools (e.g. agent_session_read) by default
    },
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

test('tool output declares render (DSH tools.register hard requirement)', () => {
  // 2026-08-14 回归护栏：DSH register() 要求 output = { schema, render }，
  // render 必须是函数，否则抛 TypeError 且工具静默不注册（de_canvas 曾
  // 因此缺失导致所有会话看不到该工具，而前端 Tab/API 一切正常）。
  const ctx = fakeCtx()
  apply(ctx, { reviewEnabled: true })
  for (const tool of ctx.state.tools) {
    assert.equal(
      typeof tool.output.render,
      'function',
      `tool "${tool.name}" output.render must be a function`,
    )
  }
})

test('tool parameters use standard JSON Schema wrapper (DSH tools.register contract)', () => {
  // 2026-08-14 回归护栏：parameters 必须是标准 JSON Schema 包装
  // {type:'object', properties, required}。扁平 DSL 格式
  // （{action:{...}, title:{...}}）会让 LLM API 把 title/content 等键
  // 当 JSON Schema 关键字解析，报「Invalid schema for function ...」，
  // 整个会话工具面崩溃（de_canvas 曾因此导致插件整体禁用才能启动）。
  const ctx = fakeCtx()
  apply(ctx, { reviewEnabled: true })
  for (const tool of ctx.state.tools) {
    const p = tool.parameters
    assert.equal(typeof p, 'object', `tool "${tool.name}" parameters must be an object`)
    assert.equal(p.type, 'object', `tool "${tool.name}" parameters must declare type:'object' (got ${JSON.stringify(p.type)})`)
    assert.equal(typeof p.properties, 'object', `tool "${tool.name}" parameters must declare properties object`)
    if (p.required !== undefined) {
      assert.ok(Array.isArray(p.required), `tool "${tool.name}" parameters.required must be an array`)
      for (const key of p.required) {
        assert.ok(key in p.properties, `tool "${tool.name}" required key "${key}" must exist in properties`)
      }
    }
  }
})

test('installCanvas：de_canvas 注册 + dispose 注销（PR #8 回归护栏）', () => {
  // 2026-08-14 回归护栏（PR #8）：de_canvas 必须经 ctx.effect 直接注册
  // ——ctx.inject(['tools'], cb) 是 ctx.plugin({inject, apply}) 简写，创建
  // 子 fiber 等待 'tools' 在 cordis 服务注册表解析；但 DSH 的 ctx.tools
  // 不是 cordis registry 服务（靠插件声明式 inject 挂载），子 fiber 永远
  // PENDING、回调永不触发，工具从未注册（与 session-orch.js 2026-08-09
  // 「ctx.inject 动态注入不可靠」教训同源）。
  // 且 installCanvas().dispose() 必须注销工具——否则用户关闭 canvasEnabled
  // 后 de_canvas 仍残留到插件重载，违反「关闭时 Tab 与工具完全不可见」。
  const ctx = fakeCtx()
  const installed = installCanvas(ctx, { memoryDir: 'tmp' }, () => null, () => null)
  const names = () => ctx.state.tools.map((t) => t.name)
  assert.ok(names().includes('de_canvas'), '安装后 de_canvas 必须已注册')
  assert.ok(ctx.state.routes.some((r) => r.kind === 'prefix'), '安装后画板 HTTP API 必须已注册')
  installed.dispose()
  assert.ok(!names().includes('de_canvas'), 'dispose 后 de_canvas 必须已注销（开关关闭场景）')
})

test('resolveConfig defaults and validation', () => {
  const config = resolveConfig({})
  assert.equal(config.reviewEnabled, false)
  assert.equal(config.reviewMode, 'suggest')
  assert.equal(config.reviewInterval, 5)
  assert.equal(config.entryDatePrefix, true)
  assert.equal(config.perTurnKeyWrites, true)
  assert.equal(config.memoryTabEnabled, true)
  assert.equal(config.skillReviewEnabled, false)
  assert.equal(config.skillManageToolName, 'skill_manage')
  assert.ok(config.memoryDir.endsWith('memories'))
  assert.ok(config.skillDir.endsWith(join('.agents', 'skills')))
  assert.deepEqual(config.searchDocsExts, ['md'])
  assert.equal(config.searchDocsProviders, 'auto')
  assert.equal(config.searchDocsEnabled, false)
  assert.throws(() => resolveConfig({ nope: 1 }), /未知配置项/)
  assert.throws(() => resolveConfig({ reviewInterval: 0 }), /正数/)
  assert.throws(() => resolveConfig({ reviewMode: 'x' }), /suggest/)
  assert.throws(() => resolveConfig({ reviewTools: [] }), /未知配置项/)
  assert.throws(() => resolveConfig({ skillMaxBytes: -1 }), /正数/)
  assert.throws(() => resolveConfig({ entryDatePrefix: 'yes' }), /布尔/)
  assert.throws(() => resolveConfig({ searchDocsExts: [] }), /searchDocsExts/)
  assert.throws(() => resolveConfig({ searchDocsExts: ['BAD*'] }), /searchDocsExts/)
  assert.throws(() => resolveConfig({ searchDocsProviders: [] }), /searchDocsProviders/)
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

test('search docs tool: 默认禁用不注册；配置/运行时 state 开启后注册；命令始终注册', () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  assert.ok(!ctx.state.tools.some((t) => t.name === 'memory_evolve_search_local_files'), '默认禁用：工具不注册（模型不可见）')
  assert.ok(ctx.state.commands.some((c) => c.name === 'memory_evolve_search_files'), '开关命令始终注册')
  clean(dir)

  const ctx2 = fakeCtx()
  apply(ctx2, { memoryDir: dir, searchDocsEnabled: true })
  assert.ok(ctx2.state.tools.some((t) => t.name === 'memory_evolve_search_local_files'), '配置开启后注册工具')
  clean(dir)

  // 运行时 state 文件开启（Web 面板 / slash 命令的持久化通道）
  const dir3 = tempDir()
  writeFileSync(join(dir3, 'plugin-state.json'), JSON.stringify({ searchDocsEnabled: true }))
  const ctx3 = fakeCtx()
  apply(ctx3, { memoryDir: dir3 })
  assert.ok(ctx3.state.tools.some((t) => t.name === 'memory_evolve_search_local_files'), '运行时状态开启后注册工具')
  clean(dir3)
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

test('memory tool archive + archived list round-trip', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  const tool = ctx.state.tools.find((t) => t.name === 'memory')
  const execCwd = (cwd) => ({ agent: { session: { header: { cwd } } }, callId: 'c1', signal: new AbortController().signal })

  // 归档一条 user 记忆：主轨移除、归档文件可见
  await tool.execute({ action: 'add', target: 'user', content: '要归档的旧习惯' }, fakeExec())
  const archived = await tool.execute({ action: 'archive', target: 'user', match: '要归档的旧习惯' }, fakeExec())
  assert.equal(archived.ok, true)
  const listed = await tool.execute({ action: 'list', target: 'user' }, fakeExec())
  assert.equal(listed.entries.length, 0) // 主轨已移除
  const archivedList = await tool.execute({ action: 'list', target: 'user', archived: true }, fakeExec())
  assert.equal(archivedList.ok, true)
  assert.equal(archivedList.entries.length, 1)
  assert.match(archivedList.entries[0], /要归档的旧习惯/)
  // 归档查询过滤：filter / recent / limit
  const filtered = await tool.execute({ action: 'list', target: 'user', archived: true, filter: '不存在的词' }, fakeExec())
  assert.equal(filtered.entries.length, 0)
  const filteredHit = await tool.execute({ action: 'list', target: 'user', archived: true, filter: '旧习惯' }, fakeExec())
  assert.equal(filteredHit.entries.length, 1)
  // project/daily 无归档 → 明确报错
  const bad = await tool.execute({ action: 'list', target: 'project', archived: true }, fakeExec())
  assert.equal(bad.ok, false)
  assert.match(bad.message, /不归档/)
  // key 归档查询需要 cwd；给 cwd 后走项目归档文件。
  // key 轨 add 走待确认队列（不落盘），这里直接写 KEY.md 构造主轨条目。
  const keyCwd = '/proj/x'
  const keyDir = join(dir, 'projects', projectHash(keyCwd))
  mkdirSync(keyDir, { recursive: true })
  writeFileSync(join(keyDir, 'KEY.md'), '[2026-08-08] 旧的项目约定\n')
  const noCwd = await tool.execute({ action: 'list', target: 'key', archived: true }, fakeExec())
  assert.equal(noCwd.ok, false)
  assert.match(noCwd.message, /工作目录/)
  const keyArchived = await tool.execute({ action: 'archive', target: 'key', match: '旧的项目约定' }, execCwd(keyCwd))
  assert.equal(keyArchived.ok, true)
  const keyList = await tool.execute({ action: 'list', target: 'key', archived: true }, execCwd(keyCwd))
  assert.equal(keyList.ok, true)
  assert.equal(keyList.entries.length, 1)
  assert.match(keyList.entries[0], /旧的项目约定/)
  // 另一 cwd 看不到（项目隔离）
  const otherKey = await tool.execute({ action: 'list', target: 'key', archived: true }, execCwd('/proj/y'))
  assert.equal(otherKey.entries.length, 0)
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
  // issue #24 修复后：DSH 核心不发 agent/settled，回合正常结束只发
  // agent/turn-stopping（payload={agent, turn, signal}），监听器随 PR #25 切换事件名
  const settled = ctx.state.listeners['agent/turn-stopping'][0]
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
  settled({ agent: agent('s1', [1]), turn: 1 })
  let check = await tool.execute({ action: 'check' }, exec('s1'))
  assert.equal(check.due, false)
  assert.equal(check.turnsSinceReview, 1)
  assert.equal(check.interval, 2)
  assert.equal(check.mode, 'suggest')

  // turn 2: count 2 → due
  settled({ agent: agent('s1', [1, 2]), turn: 2 })
  check = await tool.execute({ action: 'check' }, exec('s1'))
  assert.equal(check.due, true)

  // Due is sticky: another turn without complete keeps it due — a missed or
  // interrupted review is never silently dropped.
  settled({ agent: agent('s1', [1, 2, 3]), turn: 3 })
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
  settled({ agent: agent('s3', [1]), turn: 1 })
  const premature = await tool.execute({ action: 'complete' }, exec('s3'))
  assert.equal(premature.ok, true)
  assert.ok(premature.message.includes('未到期'))
  check = await tool.execute({ action: 'check' }, exec('s3'))
  assert.equal(check.turnsSinceReview, 1)

  // non-message turns and subagent origins never count
  const retryAgent = { id: 's2', session: { header: { origin: undefined }, events: [{ type: 'turn/start', data: { turn: 1, trigger: { kind: 'retry' } } }] } }
  settled({ agent: retryAgent, turn: 1 })
  const childAgent = { id: 'child', session: { header: { origin: 'subagent' }, events: [{ type: 'turn/start', data: { turn: 1, trigger: { kind: 'message' } } }] } }
  settled({ agent: childAgent, turn: 1 })
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
  // key write queues for confirmation (key is an injected track, so it gets
  // the same confirmation treatment as memory/user — nothing lands in KEY.md
  // until the user approves the suggestion)
  const keyOk = await tool.execute({ action: 'add', target: 'key', content: '项目 A 的架构约定' }, subExec)
  assert.equal(keyOk.ok, true)
  assert.ok(keyOk.message.includes('待确认'))
  const keyFile = join(dir, 'projects', projectHash('/tmp/proj-a'), 'KEY.md')
  assert.equal(existsSync(keyFile), false)
  const queued = readFileSync(join(dir, 'SUGGESTIONS.jsonl'), 'utf8')
  assert.ok(queued.includes('项目 A 的架构约定'))
  assert.ok(queued.includes('"target":"key"'))
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
  const config = resolveConfig({ memoryDir: dir })
  const store = new MemoryStore(config.memoryDir, config)
  const agent = { id: 'a', session: { header: { cwd: '/proj/x' } } }
  store.add('project', 'X 项目流水事实', agent)
  store.add('daily', '今天完成了 Y')
  store.add('key', 'X 项目的长期约定', agent)
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
  assert.ok(snapshot.includes('## 本项目关键记忆'))
  assert.ok(snapshot.includes('X 项目的长期约定'))
  assert.ok(snapshot.includes('memory 工具 target=key'))
  // without a cwd, no key section (nothing to inject)
  const noCwd = renderSnapshot(config, store, { id: 'b', session: { header: {} } })
  assert.ok(!noCwd.includes('## 本项目关键记忆'))
  assert.ok(snapshot.includes('## 记忆 memory-evolve'))
  assert.ok(snapshot.includes('target=project'))
  // per-turn duties: one minimal checklist, text-first tool-after pattern
  assert.ok(snapshot.includes('每轮收尾'))
  assert.ok(snapshot.includes('先输出完整回复文本，再在文本之后附带工具调用'))
  assert.ok(snapshot.includes('严禁先调工具'))
  assert.ok(snapshot.includes('一次调用'))
  assert.ok(snapshot.includes('entries 数组'))
  assert.ok(snapshot.includes('内容不要自带时间/日期前缀'))
  // key duty: importance-gated, never a per-turn mandate — and it goes
  // through user confirmation now (提交建议)
  assert.ok(snapshot.includes('重要项目事实'))
  assert.ok(snapshot.includes('target=key 提交 1 条建议'))
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
  assert.ok(both.includes('含 target=daily 与 target=project 各一项'))
  // project off: only daily keeps the write duty; reads stay for both
  const noProject = renderSnapshot(resolveConfig({ memoryDir: dir, perTurnProjectWrites: false }), store, agent)
  assert.ok(!noProject.includes('含 target=project 各一项'))
  assert.ok(noProject.includes('含 target=daily 各一项'))
  assert.ok(noProject.includes('target=project'), 'read hint for project stays')
  // daily off: only project keeps the write duty
  const noDaily = renderSnapshot(resolveConfig({ memoryDir: dir, perTurnDailyWrites: false }), store, agent)
  assert.ok(noDaily.includes('含 target=project 各一项'))
  assert.ok(!noDaily.includes('含 target=daily 各一项'))
  // both off: the key duty (default on) keeps the checklist alive
  const none = renderSnapshot(resolveConfig({ memoryDir: dir, perTurnProjectWrites: false, perTurnDailyWrites: false }), store, agent)
  assert.ok(none.includes('每轮收尾'))
  assert.ok(none.includes('target=key 提交 1 条建议'))
  assert.ok(none.includes('target=project'))
  assert.ok(none.includes('target=daily'))
  // all three off: no write duty at all, hint degrades to on-demand reads
  const allOff = renderSnapshot(resolveConfig({ memoryDir: dir, perTurnProjectWrites: false, perTurnDailyWrites: false, perTurnKeyWrites: false }), store, agent)
  assert.ok(!allOff.includes('target=key 提交 1 条建议'))
  assert.ok(!allOff.includes('每轮收尾'))
  // key off: only daily/project keep their write duties
  const noKey = renderSnapshot(resolveConfig({ memoryDir: dir, perTurnKeyWrites: false }), store, agent)
  assert.ok(noKey.includes('含 target=daily 与 target=project 各一项'))
  assert.ok(!noKey.includes('target=key 提交 1 条建议'))
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
  assert.ok(on.includes('action=complete'))
  assert.ok(on.includes('无提醒则跳过，不要调用 check'), 'no per-turn check duty')
  assert.ok(!on.includes('action=check'), 'no check step in the fixed hint')
  assert.ok(on.includes('memory_suggest'))
  assert.ok(on.includes('skill_manage'))
  assert.ok(!on.includes('本轮执行完毕'), 'completion phrase removed')
  // due warning: the snapshot itself announces an overdue review (with
  // interval + mode, so the model never has to poll the tool)
  const dueSnap = renderSnapshot(resolveConfig({ memoryDir: dir, reviewEnabled: true }), store, agent, { turnsOf: () => 99 })
  assert.ok(dueSnap.includes('⚠️ **记忆审查已到期**'))
  assert.ok(dueSnap.includes('mode=suggest'))
  assert.ok(dueSnap.includes('action=complete'))
  const notDueSnap = renderSnapshot(resolveConfig({ memoryDir: dir, reviewEnabled: true }), store, agent, { turnsOf: () => 0 })
  assert.ok(!notDueSnap.includes('⚠️ **记忆审查已到期**'))
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

test('gitBranch resolves the current branch; gitBranchList lists branches', () => {
  if (!gitAvailable()) return
  const dir = tempDir()
  try {
    // outside git → undefined / []
    assert.equal(gitBranch(dir), undefined)
    assert.deepEqual(gitBranchList(dir), [])
    // inside a git worktree → the branch name
    const branch = initGitRepo(dir)
    if (branch === null) return // git too old for `git init -b`
    assert.equal(gitBranch(dir), branch)
    assert.deepEqual(gitBranchList(dir), [branch])
  } finally {
    clean(dir)
  }
})

test('renderSnapshot injects only KEY entries covering the current branch', () => {
  if (!gitAvailable()) return
  const dir = tempDir()
  try {
    const branch = initGitRepo(dir)
    if (branch === null) return
    const config = resolveConfig({ memoryDir: join(dir, 'memories') })
    const store = new MemoryStore(config.memoryDir, config)
    const agent = { id: 'a', session: { header: { cwd: dir } } }
    store.add('key', '适用于所有分支的事实', agent)
    store.add('key', `[branch:${branch}] 仅当前分支`, agent)
    store.add('key', '[branch:other-branch] 其他分支的约定', agent)
    const snapshot = renderSnapshot(config, store, agent)
    // 无标记（全部）+ 当前分支 → 注入；其他分支 → 不注入
    assert.ok(snapshot.includes('适用于所有分支的事实'))
    assert.ok(snapshot.includes('仅当前分支'))
    assert.ok(!snapshot.includes('其他分支的约定'))
    // 分支信息随 key 一起注入：小节标题 + 提示行
    assert.ok(snapshot.includes(`当前分支：${branch}`))
    assert.ok(snapshot.includes(`**${branch}**`))
    // keyBranchFilter: false → 不过滤（全部注入，无分支信息）
    const off = renderSnapshot(resolveConfig({ memoryDir: config.memoryDir, keyBranchFilter: false }), store, agent)
    assert.ok(off.includes('其他分支的约定'))
    assert.ok(!off.includes('当前分支：'))
  } finally {
    clean(dir)
  }
})

test('memory tool key writes queue for confirmation; branches param survives the round-trip', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  const tool = ctx.state.tools.find((t) => t.name === 'memory')
  const agent = { id: 'a', session: { header: { cwd: '/proj/g' } } }
  const exec = (callId) => ({ agent, callId, signal: new AbortController().signal })
  // add with branches → queued (KEY.md untouched until confirmation), the
  // [branch:…] tag is part of the queued content
  const added = await tool.execute({ action: 'add', target: 'key', content: 'main 分支的构建约定', branches: 'main' }, exec('k1'))
  assert.equal(added.ok, true)
  assert.ok(added.message.includes('待确认'))
  assert.equal('queued' in added, false, 'queued must not leak into the output schema')
  const keyFile = join(dir, 'projects', projectHash('/proj/g'), 'KEY.md')
  assert.equal(existsSync(keyFile), false, 'key write must not land before confirmation')
  const queuedText = readFileSync(join(dir, 'SUGGESTIONS.jsonl'), 'utf8')
  assert.ok(queuedText.includes('main 分支的构建约定'))
  assert.ok(queuedText.includes('[branch:main]'))
  // add without branches → untagged suggestion
  await tool.execute({ action: 'add', target: 'key', content: '通用约定' }, exec('k2'))
  // user confirms both → they land in KEY.md (with the branch tag intact)
  const { approveSuggestions } = await import('../lib/review.js')
  const { SuggestionQueue } = await import('../lib/store.js')
  const { TodoStore } = await import('../lib/todo.js')
  const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
  const report = approveSuggestions(new MemoryStore(dir), new TodoStore(dir), queue, [1, 2], undefined)
  assert.equal(report.remaining, 0)
  const entry = storeEntries(keyFile)
  assert.match(entry[0], /^\[\d{4}-\d{2}-\d{2}\] \[branch:main\] main 分支的构建约定$/)
  assert.match(entry[1], /^\[\d{4}-\d{2}-\d{2}\] 通用约定$/)
  // list with branch filter: untagged + matching tag
  const listed = await tool.execute({ action: 'list', target: 'key', branch: 'main' }, exec('k3'))
  assert.equal(listed.entries.length, 2)
  assert.ok(listed.entries.some((e) => e.includes('main 分支的构建约定')))
  assert.ok(listed.entries.some((e) => e.includes('通用约定')))
  // list with a different branch: only the untagged entry
  const other = await tool.execute({ action: 'list', target: 'key', branch: 'dev' }, exec('k4'))
  assert.equal(other.entries.length, 1)
  assert.ok(other.entries[0].includes('通用约定'))
  clean(dir)
})

function storeEntries(path) {
  return readFileSync(path, 'utf8').split('\n§\n').map((e) => e.trim()).filter(Boolean)
}

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

test('de_prompts tool: promptsEnabled 开关注册/注销，list/get/inject 与禁用语义闭环', async () => {
  // 默认（promptsEnabled=false）：工具不注册（模型不可见）
  const offDir = tempDir()
  const offCtx = fakeCtx()
  apply(offCtx, { memoryDir: offDir })
  assert.ok(!offCtx.state.tools.some((t) => t.name === 'de_prompts'), '默认不注册 de_prompts')
  clean(offDir)

  // 配置开启：注册 + output schema 合法（DSH 硬约束校验）
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir, promptsEnabled: true })
  const tool = ctx.state.tools.find((t) => t.name === 'de_prompts')
  assert.ok(tool, 'promptsEnabled=true 时注册 de_prompts')
  assertValidOutputSchema(tool.output.schema)
  const exec = () => ({ agent: { session: { header: { cwd: '/proj/x' } } }, callId: 'c1', signal: new AbortController().signal })

  // list：seed 13 条全启用，含 id/名称/简介/分类/标签、不含正文
  const listed = await tool.execute({ action: 'list' }, exec())
  assert.equal(listed.ok, true)
  assert.equal(listed.prompts.length, 13)
  assert.ok(listed.prompts.every((p) => p.id && p.name && 'description' in p && p.category))
  assert.equal('content' in listed.prompts[0], false)
  // filter / limit
  const perf = await tool.execute({ action: 'list', filter: '性能' }, exec())
  assert.ok(perf.prompts.length >= 1)
  const capped = await tool.execute({ action: 'list', limit: 3 }, exec())
  assert.equal(capped.prompts.length, 3)
  const none = await tool.execute({ action: 'list', filter: '绝不存在' }, exec())
  assert.equal(none.prompts.length, 0)
  // get：正文全文 + enabled/lastUsedAt 可空字段归一
  const first = listed.prompts[0]
  const got = await tool.execute({ action: 'get', id: first.id }, exec())
  assert.equal(got.ok, true)
  assert.ok(got.prompt.content.length > 50)
  assert.equal(got.prompt.enabled, true)
  assert.equal(got.prompt.lastUsedAt, null)
  assert.equal((await tool.execute({ action: 'get', id: 'nope' }, exec())).ok, false)
  // inject：默认一次注入；重复注入拒绝；注入轨落盘（prompt-injections.json）
  const injected = await tool.execute({ action: 'inject', id: first.id }, exec())
  assert.equal(injected.ok, true)
  assert.equal(injected.injection.sourcePromptId, first.id)
  assert.equal(injected.injection.roundsLeft, 1)
  assert.equal((await tool.execute({ action: 'inject', id: first.id }, exec())).ok, false)
  const injectionsFile = JSON.parse(readFileSync(join(dir, 'prompt-injections.json'), 'utf8'))
  assert.equal(injectionsFile.injections.length, 1)
  assert.equal(injectionsFile.injections[0].sourcePromptId, first.id)
  // 清注入轨，测自定义 rounds/every 与非法参数
  writeFileSync(join(dir, 'prompt-injections.json'), JSON.stringify({ injections: [] }))
  const custom = await tool.execute({ action: 'inject', id: first.id, rounds: 7, every: 3 }, exec())
  assert.equal(custom.injection.roundsLeft, 7)
  assert.equal(custom.injection.every, 3)
  assert.equal((await tool.execute({ action: 'inject', id: first.id, rounds: -1 }, exec())).ok, false)
  assert.equal((await tool.execute({ action: 'inject', id: first.id, every: -1 }, exec())).ok, false)
  assert.equal((await tool.execute({ action: 'explode' }, exec())).ok, false)
  // 禁用语义：直接改 prompts.json 把第一条禁用 → list 隐藏、inject 拒绝、get 仍可查
  writeFileSync(join(dir, 'prompt-injections.json'), JSON.stringify({ injections: [] }))
  const file = join(dir, 'prompts.json')
  const data = JSON.parse(readFileSync(file, 'utf8'))
  data.prompts[0].enabled = false
  writeFileSync(file, JSON.stringify(data))
  const relist = await tool.execute({ action: 'list' }, exec())
  assert.equal(relist.prompts.some((p) => p.id === first.id), false)
  const denied = await tool.execute({ action: 'inject', id: first.id }, exec())
  assert.equal(denied.ok, false)
  assert.match(denied.message, /禁用/)
  const gotDisabled = await tool.execute({ action: 'get', id: first.id }, exec())
  assert.equal(gotDisabled.prompt.enabled, false)
  clean(dir)

  // 自定义工具名（config.promptToolName）生效
  const dir2 = tempDir()
  const ctx2 = fakeCtx()
  apply(ctx2, { memoryDir: dir2, promptsEnabled: true, promptToolName: 'my_prompts' })
  assert.ok(ctx2.state.tools.some((t) => t.name === 'my_prompts'))
  assert.ok(!ctx2.state.tools.some((t) => t.name === 'de_prompts'))
  clean(dir2)
})

test('systemPrompt context duplicate registration is tolerated (issue #23 idempotent guard)', async () => {
  // 模拟宿主重复装配（DSH 0.1.x loader 曾把插件在无 scope 标签的 ctx 上
  // apply 两次）：systemPrompt.context 第二次插入同名时抛 exactly
  // dsh-system-prompt 的 global 层 duplicate 错误。修复前 apply 会整体抛错，
  // 连带快照注入失效 + /memory-evolve/api/* 404。
  const duplicateMessage = 'prompt context "memory:snapshot" is already registered (for a per-agent override, register through that agent\'s `agent.ctx` instead)'

  // 场景 1：memory:snapshot 重复 → apply 不抛错，其余装配照常
  const dir = tempDir()
  const ctx = fakeCtx({
    services: {
      systemPrompt: {
        context: () => { throw new Error(duplicateMessage) },
      },
    },
  })
  apply(ctx, { memoryDir: dir })
  assert.ok(ctx.state.tools.some((t) => t.name === 'memory'), 'memory tool still registered after duplicate guard')
  assert.ok(ctx.state.tools.some((t) => t.name === 'skill_manage'), 'skill tool still registered after duplicate guard')
  clean(dir)

  // 场景 2：prompt:injections 重复（prompts 模块开启时同款保护）
  const dir2 = tempDir()
  const ctx2 = fakeCtx({
    services: {
      systemPrompt: {
        context: () => { throw new Error('prompt context "prompt:injections" is already registered in this scope') },
      },
    },
  })
  apply(ctx2, { memoryDir: dir2, promptsEnabled: true })
  assert.ok(ctx2.state.tools.some((t) => t.name === 'de_prompts'), 'prompts tool still registered after duplicate guard')
  clean(dir2)

  // 场景 3：非 duplicate 的系统性错误必须照抛（保护只吞 "already registered"）
  const dir3 = tempDir()
  const ctx3 = fakeCtx({
    services: {
      systemPrompt: {
        context: () => { throw new Error('systemPrompt exploded for another reason') },
      },
    },
  })
  assert.throws(() => apply(ctx3, { memoryDir: dir3 }), /systemPrompt exploded for another reason/)
  clean(dir3)
})
