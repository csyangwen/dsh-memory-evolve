import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AdapterStore, BUILTIN_ADAPTERS, buildArgs, extractSessionId, validateAdapter,
} from '../lib/coi/adapters.js'
import { SessionStore } from '../lib/coi/session-store.js'
import { TaskStore } from '../lib/coi/tasks-store.js'
import { TemplateStore } from '../lib/coi/templates.js'
import { CoiScheduler } from '../lib/coi/scheduler.js'
import { coiStats } from '../lib/coi/stats.js'
import { coiToolDefinitions } from '../lib/coi/tools.js'
import { installCoiApi } from '../lib/coi/api.js'
import { validateCoiRuntimePatch } from '../lib/coi/index.js'

/** 所有测试创建的调度器：统一 dispose，避免 flush 定时器挂住事件循环。 */
const schedulers = []
after(() => {
  for (const scheduler of schedulers) scheduler.dispose()
})

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-coi-test-'))
}

/** 可注入的 fake spawn：记录子进程，测试里手动触发输出/结束。 */
function makeSpawnHarness() {
  const children = []
  const spawn = (binary, args, opts) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 4000 + children.length
    child.exitCode = null
    child.killed = []
    child.kill = (sig) => { child.killed.push(sig) }
    child.binary = binary
    child.args = args
    child.cwd = opts?.cwd
    children.push(child)
    return child
  }
  return { spawn, children }
}

function fakeCtx() {
  const registered = { tools: [], commands: [], handlers: [] }
  const effects = []
  const events = []
  const listeners = {}
  const ctx = {
    tools: { register: (tool) => { registered.tools.push(tool); return () => {} } },
    // cordis 语义：effect 立即执行回调（返回清理函数）
    effect: (fn) => { const disposer = fn(); effects.push({ fn, disposer }); return disposer ?? (() => {}) },
    inject: (_names, cb) => cb({
      commands: { register: (cmd) => { registered.commands.push(cmd); return () => {} } },
      httpServer: { register: ({ handler }) => { registered.handlers.push(handler); return () => {} } },
      effect: (fn) => { const disposer = fn(); effects.push({ fn, disposer }); return disposer ?? (() => {}) },
    }),
    emit: (name, data) => {
      events.push({ name, data })
      for (const fn of listeners[name] ?? []) fn(data)
    },
    on: (name, fn) => {
      ;(listeners[name] ??= []).push(fn)
      return () => {}
    },
    off: () => {},
    get: () => undefined,
  }
  return { ctx, registered, effects, events }
}

function bootStores(dir) {
  const adapters = new AdapterStore(join(dir, 'adapters.json'))
  const sessions = new SessionStore(join(dir, 'sessions.json'))
  const templates = new TemplateStore(join(dir, 'templates.json'))
  const tasks = new TaskStore(dir, { maxLogBytes: 65536, retentionDays: 90 })
  return { adapters, sessions, templates, tasks }
}

// ---------------------------------------------------------------- adapters

test('adapter validation rejects bad shapes', () => {
  assert.throws(() => validateAdapter({}), /id/)
  assert.throws(() => validateAdapter({ id: 'x', name: '', type: 'ai-cli', binary: 'kimi', args: ['-p', '{task}'], resume: { kind: 'flag', flag: '-S', arg: '{sessionId}' } }), /name/)
  assert.throws(() => validateAdapter({ id: 'x', name: 'X', type: 'nope', binary: 'kimi', args: ['-p'] }), /type/)
  assert.throws(() => validateAdapter({ id: 'x', name: 'X', type: 'ai-cli', binary: 'kimi', args: ['-p'] }), /resume/)
  assert.throws(() => validateAdapter({ id: 'x', name: 'X', type: 'ai-cli', binary: 'kimi', args: ['-p'], resume: { kind: 'wat' } }), /resume\.kind/)
})

test('adapter store: builtins + custom CRUD', () => {
  const dir = tempDir()
  const store = new AdapterStore(join(dir, 'adapters.json'))
  assert.equal(store.list().length, 4)
  assert.ok(store.get('kimi'))
  const custom = store.upsert({ id: 'my-cli', name: 'My CLI', type: 'plain-cli', binary: 'mytool', args: ['{task}'] })
  assert.equal(custom.id, 'my-cli')
  assert.ok(store.get('my-cli'))
  // 持久化：新实例仍能读到
  const again = new AdapterStore(join(dir, 'adapters.json'))
  assert.ok(again.get('my-cli'))
  // 内置不可删
  assert.equal(store.remove('kimi'), false)
  assert.equal(store.remove('my-cli'), true)
  rmSync(dir, { recursive: true, force: true })
})

test('buildArgs: new / resume / continue per adapter', () => {
  const kimi = BUILTIN_ADAPTERS.kimi
  const codex = BUILTIN_ADAPTERS.codex
  assert.deepEqual(buildArgs(kimi, { task: 't', cwd: '/w', mode: 'new' }), ['-p', 't'])
  assert.deepEqual(buildArgs(kimi, { task: 't', sessionId: 'session_abc', mode: 'resume' }), ['-S', 'session_abc', '-p', 't'])
  assert.deepEqual(buildArgs(kimi, { task: 't', mode: 'continue' }), ['-c', '-p', 't'])
  assert.deepEqual(buildArgs(codex, { task: 't', sessionId: 'uuid', mode: 'resume' }), ['exec', 'resume', 'uuid', 't'])
  assert.deepEqual(buildArgs(codex, { task: 't', mode: 'continue' }), ['exec', 'resume', '--last', 't'])
  // plain-cli 忽略会话模式
  const plain = { id: 'p', type: 'plain-cli', binary: 'x', args: ['{task}'] }
  assert.deepEqual(buildArgs(plain, { task: 't', mode: 'resume' }), ['t'])
  // 占位符替换
  assert.deepEqual(buildArgs(kimi, { task: 't', cwd: '/w', model: 'm', mode: 'new' }), ['-p', 't'])
})

test('extractSessionId', () => {
  assert.equal(extractSessionId(BUILTIN_ADAPTERS.kimi, '• 2\n\nTo resume this session: kimi -r session_e65de601-c683', ''), 'session_e65de601-c683')
  assert.equal(extractSessionId(BUILTIN_ADAPTERS.codex, '', 'workdir: /x\nsession id: 019fdad1-b0fb-7dc2\n'), '019fdad1-b0fb-7dc2')
  assert.equal(extractSessionId(BUILTIN_ADAPTERS.grok, '2', ''), undefined)
})

// ------------------------------------------------------------- session store

test('session store: scopes, notes, lock', () => {
  const dir = tempDir()
  const store = new SessionStore(join(dir, 'sessions.json'))
  assert.equal(store.upsert({ id: 's1', adapterId: 'kimi', scope: 'temporary' }).ok, false)
  assert.equal(store.upsert({ id: 's1', adapterId: 'kimi', scope: 'nope' }).ok, false)
  const added = store.upsert({ id: 's1', adapterId: 'kimi', scope: 'project', cwd: '/p', branch: 'main', taskId: 't1' })
  assert.equal(added.ok, true)
  // 重复 upsert 不重复
  store.upsert({ id: 's1', adapterId: 'kimi', scope: 'project', cwd: '/p' })
  assert.equal(store.list().length, 1)
  // 锁
  assert.equal(store.acquire('s1', 't2').ok, true)
  assert.equal(store.acquire('s1', 't3').ok, false)
  store.release('s1', 't2')
  assert.equal(store.acquire('s1', 't3').ok, true)
  // 备注与过滤
  store.updateNote('s1', '镇江部署')
  const found = store.list({ q: '镇江' })
  assert.equal(found.length, 1)
  assert.equal(found[0].note, '镇江部署')
  const byBranch = store.list({ branch: 'main' })
  assert.equal(byBranch.length, 1)
  assert.ok(store.remove('s1').ok)
  assert.equal(store.list().length, 0)
  rmSync(dir, { recursive: true, force: true })
})

// ----------------------------------------------------------------- task store

test('task store: lifecycle, log, filters, prune', () => {
  const dir = tempDir()
  const store = new TaskStore(dir, { maxLogBytes: 1024, retentionDays: 90 })
  const task = store.add({ adapterId: 'kimi', prompt: 'hello' })
  assert.match(task.id, /^coi-/)
  store.update(task.id, { status: 'running' })
  assert.equal(store.get(task.id).status, 'running')
  store.appendLog(task.id, 'line1\n')
  store.appendLog(task.id, 'line2\n')
  assert.equal(store.readLog(task.id), 'line1\nline2\n')
  const tail = store.readLog(task.id, 8)
  assert.ok(tail.includes('line2'))
  store.appendLog(task.id, 'x'.repeat(2000))
  assert.equal(store.get(task.id).logTruncated, true)
  // 过滤
  store.add({ adapterId: 'codex', prompt: 'other', scope: 'global' })
  assert.equal(store.list({ adapterId: 'kimi' }).length, 1)
  assert.equal(store.list({ q: 'other' }).length, 1)
  assert.equal(store.list({ status: 'running' }).length, 1)
  // prune：老任务删除、新任务与运行中保留（update 白名单拒改 createdAt，
  // 直接改内存数组模拟"百日前创建"）
  const old = store.add({ adapterId: 'grok', prompt: 'old' })
  old.createdAt = Date.now() - 100 * 24 * 3600 * 1000
  store.update(old.id, { status: 'completed' })
  const running = store.add({ adapterId: 'grok', prompt: 'running' })
  running.createdAt = Date.now() - 100 * 24 * 3600 * 1000
  store.update(running.id, { status: 'running' })
  assert.equal(store.prune(), 1)
  assert.ok(store.get(old.id) === undefined)
  assert.ok(store.get(running.id))
  // remove：运行中拒绝、已结束可删
  assert.equal(store.remove(running.id).ok, false)
  const done = store.add({ adapterId: 'grok', prompt: 'done' })
  store.update(done.id, { status: 'completed' })
  assert.equal(store.remove(done.id).ok, true)
  assert.ok(store.get(done.id) === undefined)
  rmSync(dir, { recursive: true, force: true })
})

// ----------------------------------------------------------- visibility

test('visibility: scope-tier filtering for tasks and sessions', () => {
  const dir = tempDir()
  const { tasks, sessions } = bootStores(dir)
  const mk = (scope, extra = {}) => tasks.add({ adapterId: 'kimi', prompt: 'p', scope, cwd: null, branch: null, ...extra })
  // 会话 A 的任务
  const tTemp = mk('temporary', { ownerSessionId: 'sessA', cwd: '/projA' })
  const tSession = mk('session', { ownerSessionId: 'sessA', cwd: '/projA' })
  const tProject = mk('project', { ownerSessionId: 'sessA', cwd: '/projA' })
  const tGlobal = mk('global', { ownerSessionId: 'sessA' })
  // 会话 B 的任务
  const tTempB = mk('temporary', { ownerSessionId: 'sessB', cwd: '/projA' })
  const tProjectB = mk('project', { ownerSessionId: 'sessB', cwd: '/projB' })

  // A 的视角（cwd=/projA）：临时/会话=仅 A；项目=仅 /projA；全局=全显
  const viewA = tasks.list({ ownerSessionId: 'sessA', sessionCwd: '/projA' })
  const idsA = viewA.map((t) => t.id)
  assert.ok(idsA.includes(tTemp.id))
  assert.ok(idsA.includes(tSession.id))
  assert.ok(idsA.includes(tProject.id))
  assert.ok(idsA.includes(tGlobal.id))
  assert.ok(!idsA.includes(tTempB.id), '会话 B 的临时任务对 A 不可见')
  assert.ok(!idsA.includes(tProjectB.id), '项目 B 的任务对 A 不可见')

  // B 的视角（cwd=/projB）：看不到 A 的临时/会话/项目任务，全局可见
  const viewB = tasks.list({ ownerSessionId: 'sessB', sessionCwd: '/projB' })
  const idsB = viewB.map((t) => t.id)
  assert.ok(idsB.includes(tTempB.id))
  assert.ok(idsB.includes(tProjectB.id))
  assert.ok(!idsB.includes(tTemp.id))
  assert.ok(!idsB.includes(tSession.id))
  assert.ok(!idsB.includes(tProject.id))
  assert.ok(idsB.includes(tGlobal.id), '全局任务任何会话可见')

  // 不带视角（如 slash 命令）：全部可见（不启用层级过滤）
  assert.equal(tasks.list().length, 6)

  // 会话记录同样按层级过滤
  sessions.upsert({ id: 'sA', adapterId: 'kimi', scope: 'session', ownerSessionId: 'sessA' })
  sessions.upsert({ id: 'pA', adapterId: 'kimi', scope: 'project', cwd: '/projA', ownerSessionId: 'sessA' })
  sessions.upsert({ id: 'gA', adapterId: 'kimi', scope: 'global', ownerSessionId: 'sessA' })
  const sViewB = sessions.list({ ownerSessionId: 'sessB', sessionCwd: '/projB' })
  const sIdsB = sViewB.map((x) => x.id)
  assert.ok(!sIdsB.includes('sA'))
  assert.ok(!sIdsB.includes('pA'))
  assert.ok(sIdsB.includes('gA'))
  rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------------------ scheduler

function bootScheduler(dir, overrides = {}) {
  const stores = bootStores(dir)
  const harness = makeSpawnHarness()
  const writeSummary = overrides.writeSummary ?? (() => {})
  const listeners = {}
  const eventCtx = {
    emit: (name, data) => { for (const fn of listeners[name] ?? []) fn(data) },
    on: (name, fn) => { ;(listeners[name] ??= []).push(fn); return () => {} },
    off: () => {},
  }
  const scheduler = new CoiScheduler(eventCtx, {
    adapters: stores.adapters,
    sessions: stores.sessions,
    tasks: stores.tasks,
    config: { coiTaskTimeoutMs: 60000, coiDataDir: dir, coiDefaultInjectContext: overrides.defaultInject ?? false },
    writeSummary,
    memoryContext: overrides.memoryContext ?? (() => '【记忆】测试记忆轨内容'),
  }, { spawn: harness.spawn })
  schedulers.push(scheduler)
  scheduler.recover()
  return { ...stores, scheduler, harness, writeSummary }
}

test('scheduler: dispatch runs async and completes with session capture', async () => {
  const dir = tempDir()
  const { scheduler, harness, sessions, tasks } = bootScheduler(dir)
  const result = scheduler.dispatch({ adapterId: 'kimi', prompt: '做一件事', scope: 'project', cwd: '/p', branch: 'main' })
  assert.equal(result.ok, true)
  assert.ok(result.taskId)
  const child = harness.children[0]
  assert.equal(child.binary, 'kimi')
  assert.deepEqual(child.args, ['-p', '做一件事'])
  assert.equal(tasks.get(result.taskId).status, 'running')
  // 输出 + session id 捕获
  child.stdout.emit('data', '• 思考中\n')
  child.stdout.emit('data', 'To resume this session: kimi -r session_abc123\n')
  assert.equal(tasks.get(result.taskId).sessionId, 'session_abc123')
  const sessionsList = sessions.list()
  assert.equal(sessionsList.length, 1)
  assert.equal(sessionsList[0].scope, 'project')
  assert.equal(sessionsList[0].branch, 'main')
  assert.equal(sessionsList[0].cwd, '/p')
  // 完成
  child.emit('close', 0)
  const task = tasks.get(result.taskId)
  assert.equal(task.status, 'completed')
  assert.equal(task.exitCode, 0)
  assert.ok(task.summary.includes('session_abc123'))
  // 留档已写
  assert.ok(tasks.readLog(result.taskId).includes('思考中'))
  // 会话锁已释放
  assert.equal(sessions.findById('session_abc123').activeTaskId, null)
  rmSync(dir, { recursive: true, force: true })
})

test('scheduler: session lock rejects concurrent reuse', () => {
  const dir = tempDir()
  const { scheduler, harness } = bootScheduler(dir)
  const first = scheduler.dispatch({ adapterId: 'kimi', prompt: 'a', sessionId: 's1', scope: 'session' })
  assert.equal(first.ok, true)
  const second = scheduler.dispatch({ adapterId: 'kimi', prompt: 'b', sessionId: 's1', scope: 'session' })
  assert.equal(second.ok, false)
  assert.match(second.message, /占用/)
  harness.children[0].emit('close', 0)
  // 释放后可再次使用
  const third = scheduler.dispatch({ adapterId: 'kimi', prompt: 'c', sessionId: 's1', scope: 'session' })
  assert.equal(third.ok, true)
  rmSync(dir, { recursive: true, force: true })
})

test('scheduler: cancel kills process group', () => {
  const dir = tempDir()
  const { scheduler, harness } = bootScheduler(dir)
  const { taskId } = scheduler.dispatch({ adapterId: 'grok', prompt: 'x' })
  // 不带 force：要求确认
  const confirm = scheduler.cancel(taskId, {})
  assert.equal(confirm.ok, false)
  assert.match(confirm.message, /确认/)
  // 带 force：终止
  const result = scheduler.cancel(taskId, { force: true })
  assert.equal(result.ok, true)
  assert.equal(harness.children[0].killed.length, 1)
  assert.equal(scheduler.status(taskId).task.status, 'killed')
  rmSync(dir, { recursive: true, force: true })
})

test('scheduler: disabled adapter is rejected with alternatives', () => {
  const dir = tempDir()
  const { scheduler, harness, adapters } = bootScheduler(dir)
  // 禁用 grok
  const off = adapters.setEnabled('grok', false)
  assert.equal(off.ok, true)
  assert.equal(adapters.get('grok').enabled, false)
  // 禁用后 dispatch 被拒，且提示可用列表
  const result = scheduler.dispatch({ adapterId: 'grok', prompt: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.message, /已被禁用/)
  assert.match(result.message, /kimi/)
  assert.equal(harness.children.length, 0)
  // 测试按钮同样拒绝
  const testRes = scheduler.testAdapter('grok')
  assert.equal(testRes.ok, false)
  // 重新启用后恢复
  adapters.setEnabled('grok', true)
  const again = scheduler.dispatch({ adapterId: 'grok', prompt: 'y' })
  assert.equal(again.ok, true)
  rmSync(dir, { recursive: true, force: true })
})

test('coi tools: de_coi_adapters lists scenarios and enabled state', async () => {
  const dir = tempDir()
  const { scheduler, adapters } = bootScheduler(dir)
  const tools = coiToolDefinitions(scheduler)
  const adaptersTool = tools.find((t) => t.name === 'de_coi_adapters')
  const res = await adaptersTool.execute({})
  assert.equal(res.ok, true)
  assert.equal(res.adapters.length, 4)
  const kimi = res.adapters.find((a) => a.id === 'kimi')
  assert.equal(kimi.enabled, true)
  assert.ok(kimi.useCase.length > 0)
  adapters.setEnabled('codex', false)
  const res2 = await adaptersTool.execute({})
  assert.equal(res2.adapters.find((a) => a.id === 'codex').enabled, false)
  rmSync(dir, { recursive: true, force: true })
})

test('scheduler: wait resolves on completion; retry re-dispatches', async () => {
  const dir = tempDir()
  const { scheduler, harness } = bootScheduler(dir)
  const { taskId } = scheduler.dispatch({ adapterId: 'grok', prompt: 'x' })
  const waiting = scheduler.wait(taskId, 5000)
  harness.children[0].emit('close', 0)
  const waited = await waiting
  assert.equal(waited.ok, true)
  assert.equal(waited.task.status, 'completed')
  // retry
  const retried = scheduler.retry(taskId)
  assert.equal(retried.ok, true)
  assert.equal(harness.children.length, 2)
  rmSync(dir, { recursive: true, force: true })
})

test('scheduler: relay refTaskId appends full prior output', () => {
  const dir = tempDir()
  const { scheduler, harness } = bootScheduler(dir)
  const first = scheduler.dispatch({ adapterId: 'grok', prompt: '第一件事' })
  // 输出较长（超过旧版 4000 字符截断阈值也应全量内联）
  const bigOutput = '第一件事的结果输出\n' + 'x'.repeat(9000) + '\n结尾标记'
  harness.children[0].stdout.emit('data', bigOutput)
  harness.children[0].emit('close', 0)
  const second = scheduler.dispatch({ adapterId: 'kimi', prompt: '继续', refTaskId: first.taskId })
  assert.equal(second.ok, true)
  const arg = harness.children[1].args[1]
  assert.match(arg, /引用任务/)
  assert.match(arg, /第一件事的结果输出/) // 开头部分也在（全量内联）
  assert.match(arg, /结尾标记/)            // 结尾也在
  assert.match(arg, /继续/)
  assert.ok(arg.length > 9000, '输出应全量内联而非截断')
  rmSync(dir, { recursive: true, force: true })
})

test('scheduler: memory context injection (opt-in, inline + file fallback)', () => {
  const dir = tempDir()
  const { scheduler, harness } = bootScheduler(dir)
  // 默认不注入
  const plain = scheduler.dispatch({ adapterId: 'grok', prompt: '任务' })
  assert.ok(!harness.children[0].args[1].includes('背景信息'))
  // 显式开启：自动轨注入
  const withMem = scheduler.dispatch({ adapterId: 'grok', prompt: '任务2', injectContext: true })
  const arg1 = harness.children[1].args[1]
  assert.ok(arg1.includes('背景信息'))
  assert.ok(arg1.includes('无需说明或提及来源'))
  assert.ok(arg1.includes('测试记忆轨内容'))
  assert.ok(arg1.includes('任务2'))
  // 自定义文本叠加
  const withText = scheduler.dispatch({ adapterId: 'grok', prompt: '任务3', contextText: '【自查】项目日志要点：完成了登录模块' })
  const arg2 = harness.children[2].args[1]
  assert.ok(arg2.includes('项目日志要点：完成了登录模块'))
  // 超长（>32KB）：写文件 + 路径
  const big = 'x'.repeat(40 * 1024)
  const withBig = scheduler.dispatch({ adapterId: 'grok', prompt: '任务4', injectContext: true, contextText: big })
  const arg3 = harness.children[3].args[1]
  assert.ok(arg3.includes('已写入文件'))
  assert.match(arg3, /contexts\/coi-[a-z0-9-]+\.txt/)
  // 全局默认开（配置）
  const dir2 = tempDir()
  const s2 = bootScheduler(dir2, { defaultInject: true })
  const auto = s2.scheduler.dispatch({ adapterId: 'grok', prompt: '任务5' })
  assert.ok(s2.harness.children[0].args[1].includes('背景信息'))
  s2.scheduler.dispose()
  rmSync(dir2, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

test('skills sync: version-gated copy protects user edits', async () => {
  const dir = tempDir()
  const pluginSkills = join(dir, 'plugin-skills')
  const userSkills = join(dir, 'user-skills')
  mkdirSync(join(pluginSkills, 'kimi-cli-calling'), { recursive: true })
  writeFileSync(join(pluginSkills, 'kimi-cli-calling', 'SKILL.md'), '---\nx-version: 1\n---\n# kimi v1\n')
  const { syncBuiltinSkills, BUILTIN_SKILLS } = await import('../lib/coi/skills-sync.js')
  assert.deepEqual(BUILTIN_SKILLS, ['kimi-cli-calling', 'codex-cli-calling', 'grok-cli-calling', 'hermes-cli-calling'])
  const results = syncBuiltinSkills(pluginSkills, userSkills)
  assert.equal(results.find((r) => r.name === 'kimi-cli-calling').action, 'synced')
  assert.equal(results.find((r) => r.name === 'codex-cli-calling').action, 'missing')
  // 版本相同 → unchanged（用户编辑不被覆盖）
  const again = syncBuiltinSkills(pluginSkills, userSkills)
  assert.equal(again.find((r) => r.name === 'kimi-cli-calling').action, 'unchanged')
  // 用户编辑内容（版本不变）→ 仍 unchanged
  writeFileSync(join(userSkills, 'kimi-cli-calling', 'SKILL.md'), '---\nx-version: 1\n---\n# 用户自定义内容\n')
  const edited = syncBuiltinSkills(pluginSkills, userSkills)
  assert.equal(edited.find((r) => r.name === 'kimi-cli-calling').action, 'unchanged')
  assert.equal(readFileSync(join(userSkills, 'kimi-cli-calling', 'SKILL.md'), 'utf8').includes('用户自定义内容'), true)
  // 内置版本升级 → 覆盖（源头在插件）
  writeFileSync(join(pluginSkills, 'kimi-cli-calling', 'SKILL.md'), '---\nx-version: 2\n---\n# kimi v2\n')
  const upgraded = syncBuiltinSkills(pluginSkills, userSkills)
  assert.equal(upgraded.find((r) => r.name === 'kimi-cli-calling').action, 'synced')
  assert.equal(readFileSync(join(userSkills, 'kimi-cli-calling', 'SKILL.md'), 'utf8').includes('# kimi v2'), true)
  rmSync(dir, { recursive: true, force: true })
})

test('scheduler: failed exit code marks task failed', () => {
  const dir = tempDir()
  const { scheduler, harness } = bootScheduler(dir)
  const { taskId } = scheduler.dispatch({ adapterId: 'grok', prompt: 'x' })
  harness.children[0].emit('close', 1)
  const task = scheduler.status(taskId).task
  assert.equal(task.status, 'failed')
  assert.equal(task.exitCode, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('scheduler: recover marks interrupted leftovers', () => {
  const dir = tempDir()
  const stores = bootStores(dir)
  const t = stores.tasks.add({ adapterId: 'kimi', prompt: 'leftover' })
  stores.tasks.update(t.id, { status: 'running' })
  const harness = makeSpawnHarness()
  const scheduler = new CoiScheduler({ emit: () => {} }, {
    adapters: stores.adapters, sessions: stores.sessions, tasks: stores.tasks,
    config: { coiTaskTimeoutMs: 60000 },
  }, { spawn: harness.spawn })
  scheduler.recover()
  assert.equal(stores.tasks.get(t.id).status, 'interrupted')
  rmSync(dir, { recursive: true, force: true })
})

test('scheduler: summary sink is called for non-temporary tasks', () => {
  const dir = tempDir()
  const summaries = []
  const { scheduler, harness } = bootScheduler(dir, { writeSummary: (s) => summaries.push(s) })
  scheduler.dispatch({ adapterId: 'grok', prompt: '沉淀我', scope: 'project', cwd: '/p', branch: 'main' })
  harness.children[0].emit('close', 0)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].cwd, '/p')
  assert.equal(summaries[0].branch, 'main')
  rmSync(dir, { recursive: true, force: true })
})

// ----------------------------------------------------------------- templates & stats

test('templates and stats', () => {
  const dir = tempDir()
  const { templates } = bootStores(dir)
  assert.equal(templates.list().length, 4)
  assert.ok(templates.get('review-code'))
  const custom = templates.upsert({ id: 'my-tpl', name: '我的模板', prompt: '做 XX' })
  assert.equal(custom.name, '我的模板')
  assert.equal(templates.list().length, 5)
  assert.equal(templates.remove('review-code'), false) // 内置不可删
  assert.equal(templates.remove('my-tpl'), true)
  // stats
  const { tasks } = bootStores(dir)
  tasks.add({ adapterId: 'kimi', prompt: 'a', status: 'completed', startedAt: 1000, finishedAt: 6000 })
  tasks.add({ adapterId: 'kimi', prompt: 'b', status: 'completed', startedAt: 1000, finishedAt: 3000 })
  const stats = coiStats(tasks)
  assert.equal(stats.total, 2)
  assert.equal(stats.byAdapter.kimi.count, 2)
  assert.equal(stats.byAdapter.kimi.totalMs, 7000)
  rmSync(dir, { recursive: true, force: true })
})

// --------------------------------------------------------------------- tools

test('coi tools: schemas stay DSH-compatible (no type arrays, no field-level required)', async () => {
  // DSH 的 assertSupportedJsonSchema 要求 type 为单一字符串、字段级
  // required 只在顶层数组声明（字段级 required: true 会被模型 API 拒绝：
  // 'true is not of type "array"'）。递归扫描全部 schema（防回归）。
  const dir = tempDir()
  const { scheduler } = bootScheduler(dir)
  const tools = coiToolDefinitions(scheduler)
  // DSH 只递归检查 schema 节点（properties 映射本身不检查，仅检查其值）；
  // 因此名为 type 的字段（如 { type: 'string' }）不会被误判。
  const walk = (node, path, container = false) => {
    if (node === null || typeof node !== 'object') return
    if (!container) {
      if (typeof node.type === 'object') {
        throw new Error(`schema ${path}.type 必须是单一字符串: ${JSON.stringify(node.type)}`)
      }
      if (Object.hasOwn(node, 'required') && !Array.isArray(node.required)) {
        throw new Error(`schema ${path}.required 必须是数组: ${JSON.stringify(node.required)}`)
      }
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, `${path}.${key}`, key === 'properties')
    }
  }
  for (const tool of tools) {
    walk(tool.parameters, tool.name)
    walk(tool.output.schema, `${tool.name}.output`)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('coi tools: dispatch/status/wait/cancel registered with schemas', async () => {
  const dir = tempDir()
  const { scheduler, harness } = bootScheduler(dir)
  const tools = coiToolDefinitions(scheduler)
  assert.deepEqual(tools.map((t) => t.name), ['de_coi_dispatch', 'de_coi_adapters', 'de_coi_status', 'de_coi_wait', 'de_coi_cancel'])
  const dispatchTool = tools[0]
  const result = await dispatchTool.execute({ adapterId: 'grok', prompt: '任务', scope: 'project' }, { agent: { session: { header: { cwd: '/p' } } } })
  assert.equal(result.ok, true)
  assert.ok(result.taskId)
  const statusTool = tools[2]
  const status = await statusTool.execute({ taskId: result.taskId })
  assert.equal(status.ok, true)
  assert.equal(status.task.status, 'running')
  harness.children[0].emit('close', 0)
  const waitTool = tools[3]
  const cancelResult = await waitTool.execute({ taskId: 'nonexistent' })
  assert.equal(cancelResult.ok, false)
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------- api

async function bootApi(dir, overrides = {}) {
  const stores = bootStores(dir)
  const harness = makeSpawnHarness()
  const scheduler = new CoiScheduler({ emit: () => {} }, {
    adapters: stores.adapters,
    sessions: stores.sessions,
    tasks: stores.tasks,
    config: { coiTaskTimeoutMs: 60000 },
  }, { spawn: harness.spawn })
  schedulers.push(scheduler)
  scheduler.recover()
  const runtime = { coiNotifyCommand: null, coiRetentionDays: 90, coiTaskTimeoutMs: 60000 }
  const svc = {
    scheduler, sessions: stores.sessions, adapters: stores.adapters,
    templates: stores.templates, tasks: stores.tasks,
    config: { coiDataDir: dir, skillDir: join(dir, 'skills') },
    runtimeConfig: () => ({ ...runtime }),
    updateRuntimeConfig: (patch) => {
      try {
        validateCoiRuntimePatch(patch)
      } catch (error) {
        return { ok: false, message: error.message }
      }
      Object.assign(runtime, patch)
      return { ok: true, config: { ...runtime } }
    },
    resolveCwd: overrides.resolveCwd ?? (() => undefined),
  }
  const ctx = {
    httpServer: { register: ({ handler }) => { ctx.handler = handler; return () => {} } },
  }
  installCoiApi(ctx, svc)
  const server = createServer((req, res) => ctx.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, data }
  }
  return { base, request, harness, scheduler, stores, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('coi api: adapters, tasks dispatch + status + cancel flow', async () => {
  const dir = tempDir()
  const api = await bootApi(dir)
  try {
    const adapters = await api.request('GET', '/memory-evolve/api/coi/adapters')
    assert.equal(adapters.data.adapters.length, 4)
    assert.ok(adapters.data.adapters.find((a) => a.id === 'kimi').guide)

    const dispatch = await api.request('POST', '/memory-evolve/api/coi/tasks', { adapterId: 'kimi', prompt: 'API 任务', scope: 'project', cwd: '/p', dsSessionId: 'ds-sess-1' })
    assert.equal(dispatch.status, 200)
    assert.equal(dispatch.data.ok, true)
    const taskId = dispatch.data.taskId
    // dsSessionId 记为所有者（层级可见性依据），与"恢复的 COI 会话"（sessionId）互不干扰
    assert.equal(api.stores.tasks.get(taskId).ownerSessionId, 'ds-sess-1')

    const status = await api.request('GET', `/memory-evolve/api/coi/tasks/${taskId}`)
    assert.equal(status.data.task.status, 'running')

    // 不带 force 的 cancel 只返回确认提示
    const confirm = await api.request('POST', `/memory-evolve/api/coi/tasks/${taskId}/cancel`, {})
    assert.equal(confirm.status, 400)
    assert.match(confirm.data.message, /确认/)
    // 带 force 执行
    const cancel = await api.request('POST', `/memory-evolve/api/coi/tasks/${taskId}/cancel`, { force: true })
    assert.equal(cancel.status, 200)
    assert.equal(cancel.data.ok, true)

    const list = await api.request('GET', '/memory-evolve/api/coi/tasks?cwd=/p')
    assert.equal(list.data.tasks.length, 1)
    assert.equal(list.data.tasks[0].status, 'killed')

    // 删除：killed 任务可删（记录+留档移除）
    const del = await api.request('DELETE', `/memory-evolve/api/coi/tasks/${taskId}`)
    assert.equal(del.status, 200)
    assert.equal(del.data.ok, true)
    const afterDel = await api.request('GET', '/memory-evolve/api/coi/tasks?cwd=/p')
    assert.equal(afterDel.data.tasks.length, 0)
  } finally {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('coi api: sessions note, stats, config patch, relay', async () => {
  const dir = tempDir()
  const api = await bootApi(dir)
  try {
    // 先跑一个任务捕获会话（fake spawn 手动触发）
    const dispatch = await api.request('POST', '/memory-evolve/api/coi/tasks', { adapterId: 'kimi', prompt: '捕获会话', scope: 'project', cwd: '/p' })
    api.harness.children[0].stdout.emit('data', 'To resume this session: kimi -r session_api1\n')
    api.harness.children[0].emit('close', 0)

    const note = await api.request('POST', '/memory-evolve/api/coi/sessions/note', { id: 'session_api1', note: 'API 测试会话' })
    assert.equal(note.data.ok, true)
    const sessions = await api.request('GET', '/memory-evolve/api/coi/sessions?q=API')
    assert.equal(sessions.data.sessions.length, 1)

    const stats = await api.request('GET', '/memory-evolve/api/coi/stats')
    assert.equal(stats.data.total, 1)
    assert.equal(stats.data.byAdapter.kimi.count, 1)

    const config = await api.request('POST', '/memory-evolve/api/coi/config', { patch: { coiRetentionDays: 30 } })
    assert.equal(config.data.ok, true)
    assert.equal(config.data.config.coiRetentionDays, 30)
    const badConfig = await api.request('POST', '/memory-evolve/api/coi/config', { patch: { nope: 1 } })
    assert.equal(badConfig.status, 400)

    const relay = await api.request('POST', '/memory-evolve/api/coi/tasks/relay', { adapterId: 'grok', prompt: '接力', refTaskId: dispatch.data.taskId })
    assert.equal(relay.data.ok, true)
    assert.match(api.harness.children[1].args[1], /引用任务/)
  } finally {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('coi api: adapter upsert + delete + test', async () => {
  const dir = tempDir()
  const api = await bootApi(dir)
  try {
    const add = await api.request('POST', '/memory-evolve/api/coi/adapters', { def: { id: 'hello', name: 'Hello CLI', type: 'plain-cli', binary: 'hello', args: ['{task}'], skillName: 'hello-skill' }, skillContent: '# 技能正文\n告诉 AI 怎么用 hello' })
    assert.equal(add.status, 200)
    assert.equal(add.data.adapter.id, 'hello')
    assert.match(add.data.skillMessage, /自动创建/)
    assert.ok(readFileSync(join(dir, 'skills', 'hello-skill', 'SKILL.md'), 'utf8').includes('告诉 AI 怎么用 hello'))
    // 技能已存在时不覆盖
    const addAgain = await api.request('POST', '/memory-evolve/api/coi/adapters', { def: { id: 'hello', name: 'Hello CLI', type: 'plain-cli', binary: 'hello', args: ['{task}'], skillName: 'hello-skill' }, skillContent: '# 新内容' })
    assert.match(addAgain.data.skillMessage, /已存在/)
    assert.ok(!readFileSync(join(dir, 'skills', 'hello-skill', 'SKILL.md'), 'utf8').includes('新内容'))
    const bad = await api.request('POST', '/memory-evolve/api/coi/adapters', { def: { id: 'BAD ID', name: 'x', type: 'plain-cli', binary: 'x', args: ['x'] } })
    assert.equal(bad.status, 400)
    const delBuiltin = await api.request('DELETE', '/memory-evolve/api/coi/adapters/kimi')
    assert.equal(delBuiltin.data.ok, false)
    const del = await api.request('DELETE', '/memory-evolve/api/coi/adapters/hello')
    assert.equal(del.data.ok, true)
    const test = await api.request('POST', '/memory-evolve/api/coi/adapters/test', { id: 'grok' })
    assert.equal(test.status, 200)
    assert.equal(test.data.ok, true)
    assert.equal(api.harness.children[0].binary, 'grok')
  } finally {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ----------------------------------------------------------------- commands

test('de_coi command: tokenize/parseOpts and handler basics', async () => {
  const { tokenize, parseOpts } = await (async () => {
    const mod = await import('../lib/coi/commands.js')
    // tokenize/parseOpts 未导出——通过 handler 行为间接验证
    return mod
  })()
  // handler 行为验证
  const dir = tempDir()
  const stores = bootStores(dir)
  const harness = makeSpawnHarness()
  const scheduler = new CoiScheduler({ emit: () => {} }, {
    adapters: stores.adapters, sessions: stores.sessions, tasks: stores.tasks,
    config: { coiTaskTimeoutMs: 60000 },
  }, { spawn: harness.spawn })
  schedulers.push(scheduler)
  const { coiCommand } = await import('../lib/coi/commands.js')
  const cmd = coiCommand({ scheduler, sessions: stores.sessions, adapters: stores.adapters, templates: stores.templates, tasks: stores.tasks, config: { coiDataDir: dir } })
  // help
  const help = await cmd.handler({ rawInput: 'help' })
  assert.equal(help.kind, 'success')
  assert.match(help.text, /de_coi run/)
  // run（带引号参数）
  const run = await cmd.handler({ rawInput: 'run "做一件事" --coi kimi --scope project' })
  assert.equal(run.kind, 'success')
  assert.match(run.text, /coi-/)
  assert.equal(harness.children[0].binary, 'kimi')
  assert.deepEqual(harness.children[0].args, ['-p', '做一件事'])
  // list
  const list = await cmd.handler({ rawInput: 'list --limit 5' })
  assert.equal(list.kind, 'success')
  assert.match(list.text, /做一件事/)
  // stop 二次确认
  const taskId = run.text.match(/(coi-[a-z0-9-]+)/)[1]
  const stop1 = await cmd.handler({ rawInput: `stop ${taskId}` })
  assert.equal(stop1.kind, 'error')
  assert.match(stop1.text, /确认/)
  const stop2 = await cmd.handler({ rawInput: `stop ${taskId} --force` })
  assert.equal(stop2.kind, 'success')
  assert.match(stop2.text, /已终止/)
  // adapters / stats / sessions
  const adaptersList = await cmd.handler({ rawInput: 'adapters list' })
  assert.match(adaptersList.text, /kimi/)
  const stats = await cmd.handler({ rawInput: 'stats' })
  assert.match(stats.text, /总任务数/)
  const sessionsList = await cmd.handler({ rawInput: 'sessions list' })
  assert.equal(sessionsList.kind, 'success')
  rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------------ installCoi glue

test('installCoi: tools, command, api, summary wiring', async () => {
  const dir = tempDir()
  const { ctx, registered, events } = fakeCtx()
  const adds = []
  const memoryStore = { add: (target, content, agent) => { adds.push({ target, content, cwd: agent?.session?.header?.cwd }); return { ok: true, message: 'ok' } } }
  const { installCoi } = await import('../lib/coi/index.js')
  const { svc } = installCoi(ctx, {
    coiDataDir: join(dir, 'coi'),
    coiEnabled: true,
    coiSummaryEnabled: true,
    coiSyncSkills: false, // 测试不触碰真实技能库
    coiNotifyCommand: null,
    coiRetentionDays: 90,
    coiTaskTimeoutMs: 60000,
    coiMaxLogBytes: 65536,
    skillDir: join(dir, 'skills'),
  }, { memoryStore, resolveCwd: () => '/p' })

  // 工具注册
  const toolNames = registered.tools.map((t) => t.name)
  assert.deepEqual(toolNames, ['de_coi_dispatch', 'de_coi_adapters', 'de_coi_status', 'de_coi_wait', 'de_coi_cancel'])
  // 命令注册
  assert.equal(registered.commands.length, 1)
  assert.equal(registered.commands[0].name, 'de_coi')
  // API 注册
  assert.equal(registered.handlers.length, 1)

  // 技能读写：内置适配器关联技能；未同步时 exists=false，写入后可读回
  const missing = svc.readSkill('kimi')
  assert.equal(missing.ok, true)
  assert.equal(missing.skillName, 'kimi-cli-calling')
  assert.equal(missing.exists, false)
  const write = svc.writeSkill('kimi', '---\nname: kimi-cli-calling\ndescription: 测试技能描述\nx-version: 1\n---\n# 测试技能\n')
  assert.equal(write.ok, true)
  const readBack = svc.readSkill('kimi')
  assert.equal(readBack.exists, true)
  assert.ok(readBack.content.includes('测试技能'))
  assert.equal(svc.readSkill('nope').ok, false)
  assert.equal(svc.writeSkill('kimi', '').ok, false)

  // 发起任务（用真实 spawn 会跑真命令——这里直接断言 dispatch 路径与摘要）
  const harness = makeSpawnHarness()
  svc.scheduler.spawn = harness.spawn
  const result = svc.scheduler.dispatch({ adapterId: 'grok', prompt: '写日志', scope: 'project', cwd: '/p', branch: 'main' })
  assert.equal(result.ok, true)
  harness.children[0].emit('close', 0)
  assert.equal(adds.length, 2) // project + daily
  assert.equal(adds[0].target, 'project')
  assert.equal(adds[1].target, 'daily')
  assert.ok(adds[0].content.includes('[COI]'))

  // 运行时配置更新
  const upd = svc.updateRuntimeConfig({ coiRetentionDays: 45 })
  assert.equal(upd.ok, true)
  assert.equal(upd.config.coiRetentionDays, 45)
  assert.throws(() => svc.updateRuntimeConfig({ wat: 1 }), /未知 COI 配置项/)

  rmSync(dir, { recursive: true, force: true })
})
