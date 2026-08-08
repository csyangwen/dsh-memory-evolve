import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
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
import { BroadcastStore, messageToolDefinition } from '../lib/coi/broadcast.js'
import { coiToolDefinitions } from '../lib/coi/tools.js'
import { installCoiApi } from '../lib/coi/api.js'
import { validateCoiRuntimePatch } from '../lib/coi/index.js'
import { buildBroadcastBlock, buildCoiSnapshotBlock, buildMemoryContext, resolveConfig, renderSnapshot } from '../lib/index.js'
import { MemoryStore } from '../lib/store.js'

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

test('adapter store: builtin upsert merges partial def and persists override', () => {
  // 前端 saveUseCase 只提交部分字段（缺 resume 等）——后端必须合并内置
  // 完整定义后校验（通过），且覆盖结果持久化（重启/重载不丢）。
  const dir = tempDir()
  const store = new AdapterStore(join(dir, 'adapters.json'))
  const updated = store.upsert({
    id: 'kimi',
    name: 'Kimi Code',
    type: 'ai-cli',
    binary: 'kimi',
    args: ['-p', '{task}'],
    skillName: 'kimi-cli-calling',
    useCase: '新场景',
  })
  assert.equal(updated.useCase, '新场景')
  // 合并后保留内置关键字段（resume 等）
  assert.ok(updated.resume, '合并后保留内置 resume')
  assert.ok(updated.sessionIdExtract, '合并后保留内置 sessionIdExtract')
  // 持久化：新实例从同一文件加载，覆盖仍在
  const again = new AdapterStore(join(dir, 'adapters.json'))
  assert.equal(again.get('kimi').useCase, '新场景')
  // 完整定义 upsert（前端 {...a, useCase} 形态）同样通过并持久化
  const full = { ...BUILTIN_ADAPTERS.grok, useCase: '另一个场景' }
  const updated2 = store.upsert(full)
  assert.equal(updated2.useCase, '另一个场景')
  assert.equal(new AdapterStore(join(dir, 'adapters.json')).get('grok').useCase, '另一个场景')
  // 清空 useCase 仍被拒（语义不变）
  assert.throws(() => store.upsert({ ...BUILTIN_ADAPTERS.kimi, useCase: '  ' }), /useCase/)
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
  // 会话 A（工作区 /workA）的任务
  const tTemp = mk('temporary', { ownerSessionId: 'sessA', cwd: '/projA', ownerCwd: '/workA' })
  const tSession = mk('session', { ownerSessionId: 'sessA', cwd: '/projA', ownerCwd: '/workA' })
  // 跨目录派的任务：工作区 /workA，任务 cwd=/projA
  const tProject = mk('project', { ownerSessionId: 'sessA', cwd: '/projA', ownerCwd: '/workA' })
  const tProjectCross = mk('project', { ownerSessionId: 'sessA', cwd: '/elsewhere', ownerCwd: '/workA' })
  const tGlobal = mk('global', { ownerSessionId: 'sessA' })
  // 会话 B（工作区 /workB）的任务
  const tTempB = mk('temporary', { ownerSessionId: 'sessB', cwd: '/projA', ownerCwd: '/workB' })
  const tProjectB = mk('project', { ownerSessionId: 'sessB', cwd: '/projB', ownerCwd: '/workB' })
  // 旧任务（无 ownerCwd）：回退按任务 cwd 匹配
  const tLegacy = mk('project', { ownerSessionId: 'sessX', cwd: '/workA' })

  // A 的视角（工作区 /workA）：临时/会话=仅 A；项目=发起者工作区内的全部
  //（含跨目录派的任务 tProjectCross 与旧任务 tLegacy）；全局=全显
  const viewA = tasks.list({ ownerSessionId: 'sessA', sessionCwd: '/workA' })
  const idsA = viewA.map((t) => t.id)
  assert.ok(idsA.includes(tTemp.id))
  assert.ok(idsA.includes(tSession.id))
  assert.ok(idsA.includes(tProject.id))
  assert.ok(idsA.includes(tProjectCross.id), '跨目录派的任务在同一工作区可见')
  assert.ok(idsA.includes(tLegacy.id), '旧任务（无 ownerCwd）按任务 cwd 匹配可见')
  assert.ok(idsA.includes(tGlobal.id))
  assert.ok(!idsA.includes(tTempB.id), '会话 B 的临时任务对 A 不可见')
  assert.ok(!idsA.includes(tProjectB.id), '其他工作区的项目任务对 A 不可见')

  // B 的视角（工作区 /workB）：看不到 A 的任何任务（含跨目录派的任务），全局可见
  const viewB = tasks.list({ ownerSessionId: 'sessB', sessionCwd: '/workB' })
  const idsB = viewB.map((t) => t.id)
  assert.ok(idsB.includes(tTempB.id))
  assert.ok(idsB.includes(tProjectB.id))
  assert.ok(!idsB.includes(tTemp.id))
  assert.ok(!idsB.includes(tSession.id))
  assert.ok(!idsB.includes(tProject.id), 'A 的项目任务对 B 不可见')
  assert.ok(!idsB.includes(tProjectCross.id), 'A 跨目录派的任务对 B 不可见')
  assert.ok(!idsB.includes(tLegacy.id), '旧任务也不跨工作区泄漏')
  assert.ok(idsB.includes(tGlobal.id), '全局任务任何会话可见')

  // 不带视角（如 slash 命令）：全部可见（不启用层级过滤）
  assert.equal(tasks.list().length, 8)

  // 会话记录同样按层级过滤：临时/会话仅发起会话可见；项目=发起者工作区可见
  sessions.upsert({ id: 'sA', adapterId: 'kimi', scope: 'session', ownerSessionId: 'sessA' })
  sessions.upsert({ id: 'pA', adapterId: 'kimi', scope: 'project', cwd: '/projA', ownerSessionId: 'sessA', ownerCwd: '/workA' })
  sessions.upsert({ id: 'gA', adapterId: 'kimi', scope: 'global', ownerSessionId: 'sessA' })
  const sViewB = sessions.list({ ownerSessionId: 'sessB', sessionCwd: '/workB' })
  const sIdsB = sViewB.map((x) => x.id)
  assert.ok(!sIdsB.includes('sA'))
  assert.ok(!sIdsB.includes('pA'), '其他工作区看不到 A 的项目会话')
  assert.ok(sIdsB.includes('gA'))
  // A 自己工作区可见自己的项目会话
  const sViewA = sessions.list({ ownerSessionId: 'sessA', sessionCwd: '/workA' })
  assert.ok(sViewA.map((x) => x.id).includes('pA'), '发起者工作区可见自己的项目会话')
  rmSync(dir, { recursive: true, force: true })
})

test('scheduler: ai-cli dispatch appends output convention, plain-cli does not', () => {
  const dir = tempDir()
  const { scheduler, harness, adapters } = bootScheduler(dir)
  // ai-cli（内置 grok）：prompt 末尾自动追加【输出约定】
  scheduler.dispatch({ adapterId: 'grok', prompt: '做个页面' })
  const argAi = harness.children[0].args[1]
  assert.ok(argAi.includes('【输出约定】'), 'ai-cli 追加输出约定')
  assert.ok(argAi.includes('【结论】'), '约定含结论段要求')
  assert.ok(argAi.includes('绝对路径'), '约定含绝对路径要求')
  // plain-cli（自定义普通命令）：不追加自然语言指令
  adapters.upsert({ id: 'plain-x', name: 'Plain X', type: 'plain-cli', binary: 'echo', args: ['{task}'] })
  scheduler.dispatch({ adapterId: 'plain-x', prompt: 'hello' })
  const argPlain = harness.children[1].args.join(' ')
  assert.ok(!argPlain.includes('【输出约定】'), 'plain-cli 不追加输出约定')
  assert.equal(argPlain, 'hello', 'plain-cli 原样透传')
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
    config: { coiTaskTimeoutMs: 60000, coiDataDir: dir },
    writeSummary,
    memoryContext: overrides.memoryContext ?? (() => '【记忆】测试记忆轨内容'),
  }, { spawn: harness.spawn })
  schedulers.push(scheduler)
  scheduler.recover()
  return { ...stores, scheduler, harness, writeSummary }
}

test('scheduler: default scope is session (private by default)', () => {
  const dir = tempDir()
  const { scheduler } = bootScheduler(dir)
  // 回归：曾默认 project → 同工作区所有会话都收到任务/注入；2026-08-07
  // 拍板默认 session（仅发起会话可见的私有默认），需要协作时显式传
  const result = scheduler.dispatch({ adapterId: 'grok', prompt: '默认私有' })
  assert.equal(result.ok, true)
  const task = scheduler.status(result.taskId).task
  assert.equal(task.scope, 'session', '默认层级=session（仅发起会话可见）')
  rmSync(dir, { recursive: true, force: true })
})

test('scheduler: dispatch runs async and completes with session capture', async () => {
  const dir = tempDir()
  const { scheduler, harness, sessions, tasks } = bootScheduler(dir)
  const result = scheduler.dispatch({ adapterId: 'kimi', prompt: '做一件事', scope: 'project', cwd: '/p', branch: 'main' })
  assert.equal(result.ok, true)
  assert.ok(result.taskId)
  const child = harness.children[0]
  assert.equal(child.binary, 'kimi')
  // ai-cli 自动追加输出约定（【结论】段 + 绝对路径），任务原文在开头
  assert.ok(child.args[1].startsWith('做一件事'))
  assert.ok(child.args[1].includes('【输出约定】'))
  assert.ok(child.args[1].includes('【结论】'))
  assert.ok(child.args[1].includes('绝对路径'))
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

test('scheduler: memory context injection (AI 自主选择轨, inline + file fallback)', () => {
  const dir = tempDir()
  const { scheduler, harness } = bootScheduler(dir)
  // 默认不注入（不传 injectTracks）
  const plain = scheduler.dispatch({ adapterId: 'grok', prompt: '任务' })
  assert.ok(!harness.children[0].args[1].includes('背景信息'))
  // AI 自主选择轨：显式传 injectTracks 注入
  const withMem = scheduler.dispatch({ adapterId: 'grok', prompt: '任务2', injectTracks: ['memory', 'user', 'key'] })
  const arg1 = harness.children[1].args[1]
  assert.ok(arg1.includes('背景信息'))
  assert.ok(arg1.includes('无需说明或提及来源'))
  assert.ok(arg1.includes('测试记忆轨内容'))
  assert.ok(arg1.includes('任务2'))
  // 注入与 scope 无关：temporary/global 层级同样可注入（回归：AI 曾误以为
  // 只有 project 才注入，导致为拿记忆而选 project）
  const withTemp = scheduler.dispatch({ adapterId: 'grok', prompt: '临时任务', scope: 'temporary', injectTracks: ['key'] })
  assert.ok(harness.children[2].args[1].includes('背景信息'), 'temporary 层级同样注入')
  // 不注入 AGENTS.md 全局规则（用户决策：只注入记忆轨，外部 COI 不背 DSH 纪律）
  assert.ok(!arg1.includes('【全局规则 AGENTS.md】'), '不注入 AGENTS.md 段')
  // 自定义文本叠加
  const withText = scheduler.dispatch({ adapterId: 'grok', prompt: '任务3', contextText: '【自查】项目日志要点：完成了登录模块' })
  const arg2 = harness.children[3].args[1]
  assert.ok(arg2.includes('项目日志要点：完成了登录模块'))
  // 超长（>32KB）：写文件 + 路径
  const big = 'x'.repeat(40 * 1024)
  const withBig = scheduler.dispatch({ adapterId: 'grok', prompt: '任务4', injectTracks: ['key'], contextText: big })
  const arg3 = harness.children[4].args[1]
  assert.ok(arg3.includes('已写入文件'))
  assert.match(arg3, /contexts\/coi-[a-z0-9-]+\.txt/)
  // 非法轨被过滤（不会注入）
  const bad = scheduler.dispatch({ adapterId: 'grok', prompt: '任务5', injectTracks: ['memory', 'AGENTS'] })
  assert.ok(harness.children[5].args[1].includes('背景信息'), '合法轨仍注入')
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
  // 回归：description 必须引导模型"派发后不要直接结束回合"（快照注入只发生在
  // 下一次生成前，结束回合后结果不会被自动处理）——防止改回"无需等待"的误导
  assert.ok(tools[0].description.includes('不要立即结束回合'), 'dispatch 引导不结束回合')
  assert.ok(tools[0].description.includes('严禁承诺'), 'dispatch 禁止虚假承诺自动处理')
  assert.ok(tools[3].description.includes('拿结果的正确方式'), 'wait 定位为派发后拿结果的方式')
  assert.ok(!tools[0].description.includes('无需轮询、无需阻塞等待'), 'dispatch 不再误导无需等待')
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

test('coi tools: status/wait/cancel outputs match schema exactly (no extra/missing/null-typed fields)', async () => {
  // 回归：de_coi_status 曾因返回全字段任务而 schema 只声明 6 个属性被模型 API
  // 拒绝（additionalProperties:false + null 撞 string 类型）。现在输出必须与
  // schema 的属性集一一对应：字段不多不少、可空字符串归一化为空串、可空数字
  // 保留 null（schema 用 oneOf 声明）。
  const dir = tempDir()
  const { scheduler, harness } = bootScheduler(dir)
  const tools = coiToolDefinitions(scheduler)
  const dispatchTool = tools[0]
  const result = await dispatchTool.execute({ adapterId: 'grok', prompt: '任务', scope: 'project' }, { agent: { session: { header: { cwd: '/p' } } } })
  const statusTool = tools[2]
  const waitTool = tools[3]
  const cancelTool = tools[4]
  // 运行中任务：sessionId/finishedAt/exitCode/summary 尚未产生
  const status = await statusTool.execute({ taskId: result.taskId })
  assert.equal(status.ok, true)
  assert.ok(status.message.length > 0, 'status 必须带 message')
  const taskSchema = statusTool.output.schema.properties.task
  const schemaProps = Object.keys(taskSchema.properties).sort()
  assert.deepEqual(Object.keys(status.task).sort(), schemaProps, 'task 字段集必须与 schema 完全一致')
  assert.equal(status.task.sessionId, '', '可空字符串归一化为空串')
  assert.equal(status.task.finishedAt, null, '可空数字保留 null')
  assert.equal(status.task.exitCode, null)
  assert.equal(status.task.summary, '')
  assert.ok(Array.isArray(status.task.progress))
  // wait：完成任务的输出同样合规（wait 成功分支原无 message，已补）
  harness.children[0].emit('close', 0)
  const waited = await waitTool.execute({ taskId: result.taskId, timeoutMs: 2000 })
  assert.equal(waited.ok, true)
  assert.ok(waited.message.length > 0, 'wait 必须带 message')
  assert.deepEqual(Object.keys(waited.task).sort(), schemaProps, 'wait task 字段集与 schema 一致')
  // cancel：任务已结束 → {ok:false} 无 task（schema 允许 task 缺省）
  const cancel = await cancelTool.execute({ taskId: result.taskId })
  assert.equal(cancel.ok, false)
  assert.ok(cancel.message.length > 0)
  // 新任务 cancel：返回带 task 的终止详情，同样合规
  const result2 = await dispatchTool.execute({ adapterId: 'grok', prompt: '任务2', scope: 'project' }, { agent: { session: { header: { cwd: '/p' } } } })
  const cancel2 = await cancelTool.execute({ taskId: result2.taskId })
  assert.equal(cancel2.ok, true)
  assert.deepEqual(Object.keys(cancel2.task).sort(), schemaProps, 'cancel task 字段集与 schema 一致')
  assert.equal(cancel2.task.status, 'killed')
  // wait 可被 exec.signal（停止按钮/回合中断）中止：不阻塞到 timeout
  const result3 = await dispatchTool.execute({ adapterId: 'grok', prompt: '任务3', scope: 'project' }, { agent: { session: { header: { cwd: '/p' } } } })
  const controller = new AbortController()
  const waitPromise = waitTool.execute({ taskId: result3.taskId, timeoutMs: 120000 }, { signal: controller.signal })
  controller.abort()
  const aborted = await waitPromise
  assert.equal(aborted.ok, false, 'abort 后立即返回')
  assert.match(aborted.message, /取消/)
  // 让被放弃的 wait 内部 Promise 正常收尾（任务完成 → 清掉残留 timer）
  harness.children[2].emit('close', 0)
  // wait 超时：运行中任务轮询到 deadline 返回——不依赖 ctx.on/ctx.off
  // （bootScheduler 的 ctx 只有 emit；曾因超时回调里 ctx.off 抛
  //  "cannot get property off without inject" 崩掉整个进程）
  const result4 = await dispatchTool.execute({ adapterId: 'grok', prompt: '任务4', scope: 'project' }, { agent: { session: { header: { cwd: '/p' } } } })
  const timedOut = await waitTool.execute({ taskId: result4.taskId, timeoutMs: 1500 })
  assert.equal(timedOut.ok, false)
  assert.match(timedOut.message, /超时/)
  assert.equal(timedOut.task.status, 'running', '超时返回当前状态')
  harness.children[3].emit('close', 0)
  rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------------------ snapshot

test('memory context: key branch filtering uses declared task branch', () => {
  const dir = tempDir()
  const config = resolveConfig({ memoryDir: dir })
  const store = new MemoryStore(dir, config)
  const cwd = join(dir, 'proj')
  const agent = { session: { header: { cwd } } }
  // 三条项目关键记忆：无标记（全部）/ main / dev
  store.add('key', '全局可见的项目约定', agent)
  store.add('key', 'main 分支的约定 [branch:main]', agent)
  store.add('key', 'dev 分支的约定 [branch:dev]', agent)
  // 全局记忆与用户档案（tracks 轨过滤测试用）
  store.add('memory', '全局事实条目', agent)
  store.add('user', '用户偏好条目', agent)
  // 任务声明分支 main：只注入无标记 + main 标记条目，标题带分支名
  const ctxMain = buildMemoryContext(store, { cwd, branch: 'main' })
  assert.ok(ctxMain.includes('全局可见的项目约定'))
  assert.ok(ctxMain.includes('main 分支的约定'))
  assert.ok(!ctxMain.includes('dev 分支的约定'), '其他分支的 key 不注入')
  assert.ok(ctxMain.includes('【本项目关键记忆（分支 main）】'))
  // 任务声明分支 dev：只注入无标记 + dev
  const ctxDev = buildMemoryContext(store, { cwd, branch: 'dev' })
  assert.ok(ctxDev.includes('dev 分支的约定'))
  assert.ok(!ctxDev.includes('main 分支的约定'))
  // 未声明分支（cwd 非 git 目录）：gitBranch 失败 → 全部注入
  const ctxAny = buildMemoryContext(store, { cwd })
  assert.ok(ctxAny.includes('main 分支的约定'))
  assert.ok(ctxAny.includes('dev 分支的约定'))
  assert.ok(!ctxAny.includes('分支 main）'), '未声明分支时标题不带分支名')
  // 无 cwd：不注入项目关键记忆段
  const ctxNoCwd = buildMemoryContext(store, {})
  assert.ok(!ctxNoCwd.includes('本项目关键记忆'))
  // tracks 轨过滤（AI 经 injectTracks 自主选择）：只取指定轨，缺省=全部
  const ctxOnlyKey = buildMemoryContext(store, { cwd, branch: 'main', tracks: ['key'] })
  assert.ok(ctxOnlyKey.includes('本项目关键记忆'), 'key 轨注入')
  assert.ok(!ctxOnlyKey.includes('全局事实条目'), '未选 memory 轨不注入')
  assert.ok(!ctxOnlyKey.includes('用户偏好条目'), '未选 user 轨不注入')
  const ctxOnlyMemory = buildMemoryContext(store, { cwd, tracks: ['memory'] })
  assert.ok(ctxOnlyMemory.includes('全局事实条目'))
  assert.ok(!ctxOnlyMemory.includes('本项目关键记忆'), '未选 key 轨不注入项目记忆')
  assert.ok(!ctxOnlyMemory.includes('用户偏好条目'), '未选 user 轨不注入')
  const ctxOnlyUser = buildMemoryContext(store, { cwd, tracks: ['user'] })
  assert.ok(ctxOnlyUser.includes('用户偏好条目'))
  assert.ok(!ctxOnlyUser.includes('全局事实条目'), '未选 memory 轨不注入')
  assert.ok(!ctxOnlyUser.includes('本项目关键记忆'), '未选 key 轨不注入项目记忆')
  rmSync(dir, { recursive: true, force: true })
})

test('snapshot: COI task status block (active notify) injected when coiEnabled', () => {
  const dir = tempDir()
  const coiDir = join(dir, 'coi')
  mkdirSync(coiDir, { recursive: true })
  const t = (id, now) => ({ id, adapterId: 'grok', coi: 'Grok (xAI)', startedAt: now - 60000 })
  const now = Date.now()
  writeFileSync(join(coiDir, 'tasks.json'), JSON.stringify({
    tasks: [
      // 工作区 /workA 的任务（含跨目录派发，ownerCwd=/workA）
      { ...t('coi-run-1', now), status: 'running', prompt: '写一个手表页面', scope: 'project', ownerCwd: '/workA', finishedAt: null },
      { ...t('coi-temp-run-1', now), adapterId: 'kimi', coi: 'Kimi Code', status: 'running', prompt: '本会话临时任务', scope: 'temporary', ownerSessionId: 'sessA', finishedAt: null },
      { ...t('coi-temp-other-run-1', now), adapterId: 'kimi', coi: 'Kimi Code', status: 'running', prompt: '别的会话临时任务', scope: 'temporary', ownerSessionId: 'sessB', finishedAt: null },
      { ...t('coi-done-1', now), adapterId: 'kimi', coi: 'Kimi Code', status: 'completed', prompt: '重构登录模块', scope: 'project', ownerCwd: '/workA', finishedAt: now - 5 * 60000, summary: '已完成 5 个文件改动，验证通过' },
      { ...t('coi-fail-1', now), status: 'failed', prompt: '部署', scope: 'project', ownerCwd: '/workA', finishedAt: now - 60000, summary: '…（前 1000 字符已省略）\n部署失败：超时' },
      // 其他工作区 /workB 的任务（不应注入给 /workA 的查看者）
      { ...t('coi-other-1', now), status: 'completed', prompt: 'B 工作区的任务', scope: 'project', ownerCwd: '/workB', finishedAt: now - 4 * 60000, summary: 'B 的摘要' },
      // 全局任务（全显；时间较老，避免挤占 done 前 2）
      { ...t('coi-global-1', now), status: 'completed', prompt: '全局任务', scope: 'global', finishedAt: now - 30 * 60000, summary: '全局摘要' },
    ],
  }))
  const config = resolveConfig({ memoryDir: dir, coiEnabled: true })
  // 查看者：会话 sessA、工作区 /workA
  const viewer = { sessionId: 'sessA', cwd: '/workA' }
  // 单元：buildCoiSnapshotBlock（带 viewer 过滤）
  const block = buildCoiSnapshotBlock(config, viewer)
  assert.ok(block !== null)
  assert.ok(block.includes('COI 任务状态'))
  assert.ok(block.includes('coi-run-1'), '本工作区运行中任务注入')
  assert.ok(!block.includes('分钟'), '运行中行不含耗时（固定文本，快照只在状态变化时变）')
  assert.ok(!block.includes('写一个手表页面'), '运行中行不含用户输入的提示词（隐私克制）')
  assert.ok(!block.includes('重构登录模块'), '终态行不含用户输入的提示词（隐私克制）')
  assert.ok(block.includes('coi-temp-run-1'), '本会话临时任务注入')
  assert.ok(!block.includes('coi-temp-other-run-1'), '其他会话的临时任务不注入')
  assert.ok(block.includes('coi-done-1'), '本工作区最近完成任务注入')
  assert.ok(block.includes('已完成 5 个文件改动'), '完整摘要注入')
  assert.ok(block.includes('````'), '摘要用 4 反引号围栏包裹（AI 可识别为完整摘要）')
  assert.ok(!block.includes('前 1000 字符已省略'), 'readLog 省略标记被清理')
  assert.ok(block.includes('coi-fail-1'), '最近失败任务注入')
  assert.ok(block.includes('部署失败：超时'), '失败任务完整摘要注入')
  assert.ok(!block.includes('coi-other-1'), '其他工作区的任务不注入')
  assert.ok((block.match(/[✅❌]/g) ?? []).length <= 2, '终态最多 2 条（克制）')
  // 无视角（viewer 为空）：只注入 global（先测，避免被下方 viewer 视角抢先通知）
  const blockNoViewer = buildCoiSnapshotBlock(config, {})
  assert.ok(blockNoViewer !== null)
  assert.ok(blockNoViewer.includes('coi-global-1'), '全局任务全显')
  assert.ok(!blockNoViewer.includes('coi-run-1'), '无视角不注入项目任务')
  // 一次性通知：终态展示后被标记 notified，第二次不再注入（运行中仍注入；
  // 首次未轮到展示的终态会在后续轮次补通知）
  const block2 = buildCoiSnapshotBlock(config, viewer)
  assert.ok(block2 !== null)
  assert.ok(block2.includes('coi-run-1'), '运行中任务每次注入')
  assert.ok(!block2.includes('coi-done-1'), '终态任务只通知一次')
  assert.ok(!block2.includes('coi-fail-1'), '终态任务只通知一次')
  // 调度器覆盖模拟：TaskStore 整数组写回（内存副本无 notified 字段，运行中
  // 任务每 2s flush 一次 update(lastOutputAt) 即整文件覆盖）——通知标记在
  // 独立 notified.json，覆盖 tasks.json 后仍必须只通知一次（否则反复注入）
  const rewritten = JSON.parse(readFileSync(join(coiDir, 'tasks.json'), 'utf8'))
  for (const t of rewritten.tasks) delete t.notified // 模拟调度器内存副本
  writeFileSync(join(coiDir, 'tasks.json'), JSON.stringify(rewritten, null, 2) + '\n')
  const block3 = buildCoiSnapshotBlock(config, viewer)
  assert.ok(block3.includes('coi-run-1'), 'tasks.json 被覆盖后运行中任务仍注入')
  assert.ok(!block3.includes('coi-done-1'), 'tasks.json 被覆盖后终态仍只通知一次（notified.json 独立存储）')
  assert.ok(!block3.includes('coi-fail-1'), 'tasks.json 被覆盖后终态仍只通知一次（notified.json 独立存储）')
  // 旧数据兼容：任务记录里已带 notified:true 的任务不重复通知（整段不注入）
  const dir3 = tempDir()
  const coiDir3 = join(dir3, 'coi')
  mkdirSync(coiDir3, { recursive: true })
  writeFileSync(join(coiDir3, 'tasks.json'), JSON.stringify([
    { ...t('legacy-done', now), status: 'completed', prompt: '旧通知', scope: 'global', finishedAt: now - 1000, summary: '旧摘要', notified: true },
  ]))
  const config3 = resolveConfig({ memoryDir: dir3, coiEnabled: true })
  assert.equal(buildCoiSnapshotBlock(config3, {}), null, '旧 notified:true 任务不重复通知')
  rmSync(dir3, { recursive: true, force: true })
  // 集成：renderSnapshot 注入（agent 提供会话视角）
  const store = new MemoryStore(dir, config)
  const agent = { session: { id: 'sessA', header: { cwd: '/workA' } } }
  const snap = renderSnapshot(config, store, agent)
  assert.ok(snap.includes('COI 任务状态'))
  assert.ok(!snap.includes('coi-other-1'), '集成视图同样过滤其他工作区')
  // 会话 ID 注入：AI 始终知道"我是谁"（广播双向判断 sender/recipients）
  assert.ok(snap.includes('你的会话 ID'), '注入会话 ID 段')
  assert.ok(snap.includes('sessA'), '注入自己的会话 ID 值')
  // coiEnabled=false → COI 段消失（零开销）；会话 ID 段常驻（独立输出端）
  const off = renderSnapshot({ ...config, coiEnabled: false }, store, agent)
  assert.ok(!off.includes('COI 任务状态'))
  assert.ok(off.includes('你的会话 ID'), '会话 ID 段常驻（不随 coiEnabled，其他模块的消费者也用）')
  // tasks.json 不存在/无数据 → 不注入、不抛错
  const dir2 = tempDir()
  const config2 = resolveConfig({ memoryDir: dir2 })
  assert.equal(buildCoiSnapshotBlock(config2), null)
  assert.ok(!renderSnapshot(config2, store, agent).includes('COI 任务状态'))
  rmSync(dir2, { recursive: true, force: true })
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
    // 启用/禁用路由（回归：segments 段数曾误写 7 → 404）
    const disable = await api.request('POST', '/memory-evolve/api/coi/adapters/kimi/enabled', { enabled: false })
    assert.equal(disable.status, 200)
    assert.equal(disable.data.ok, true)
    assert.equal(api.stores.adapters.get('kimi').enabled, false)
    const enable = await api.request('POST', '/memory-evolve/api/coi/adapters/kimi/enabled', { enabled: true })
    assert.equal(enable.status, 200)
    assert.equal(api.stores.adapters.get('kimi').enabled, true)
    const badEnable = await api.request('POST', '/memory-evolve/api/coi/adapters/kimi/enabled', { enabled: 'yes' })
    assert.equal(badEnable.status, 400)
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
  assert.ok(harness.children[0].args[1].startsWith('做一件事'), 'slash run 同样追加输出约定')
  assert.ok(harness.children[0].args[1].includes('【输出约定】'))
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

test('installBroadcast: 独立装配（不依赖 coiEnabled，注册 de_broadcast + prune）', async () => {
  const dir = tempDir()
  const { ctx, registered } = fakeCtx()
  const { installBroadcast } = await import('../lib/coi/index.js')
  const installed = installBroadcast(ctx, { memoryDir: dir, broadcastDataDir: join(dir, 'bcast') })
  // 只注册 de_broadcast（无调度工具——广播独立于 COI 调度）
  assert.deepEqual(registered.tools.map((t) => t.name), ['de_broadcast'])
  // store 可正常收发（独立目录）
  const sent = installed.store.send({ sender: 'sA', recipients: ['sB'], content: '独立模块测试' })
  assert.equal(sent.ok, true)
  assert.equal(installed.store.forSession('sB').length, 1)
  // dispose 卸载后 effect 清理（工具/定时器释放）
  installed.dispose()
  rmSync(dir, { recursive: true, force: true })
})

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

  // 工具注册（含会话广播 de_broadcast）
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

// ------------------------------------------------------------------ 会话广播

test('broadcast store: send/visibility/read/remove/prune + long body file', () => {
  const dir = tempDir()
  const coiDir = join(dir, 'coi')
  mkdirSync(coiDir, { recursive: true })
  const store = new BroadcastStore(coiDir)
  // 校验：空 recipients / 空 content / 空 sender
  assert.equal(store.send({ sender: 'A', recipients: [], content: 'x' }).ok, false)
  assert.equal(store.send({ sender: 'A', recipients: ['B'], content: '  ' }).ok, false)
  assert.equal(store.send({ sender: '', recipients: ['B'], content: 'x' }).ok, false)
  // 正常发送（A → B,C；recipients 去重）
  const sent = store.send({ sender: 'A', recipients: ['B', 'B', 'C'], content: '你好，请总结一下' })
  assert.equal(sent.ok, true)
  const id = sent.item.id
  // 可见性：只有接收者与发送者看得到
  const forB = store.forSession('B')
  assert.equal(forB.length, 1)
  assert.equal(forB[0].id, id)
  assert.equal(store.forSession('D').length, 0, '无关会话看不到')
  assert.equal(store.forSession('A').length, 1, '发送方可看到自己发的')
  // 未读数：仅接收者未读
  assert.equal(store.unreadCount('B'), 1)
  assert.equal(store.unreadCount('C'), 1)
  assert.equal(store.unreadCount('A'), 0, '发送方不算未读')
  assert.equal(store.unreadCount('D'), 0)
  // read：非接收者拒绝；接收者读后标记已读、未读归零（幂等）
  assert.equal(store.read(id, 'D').ok, false)
  const read = store.read(id, 'B')
  assert.equal(read.ok, true)
  assert.ok(read.item.content.includes('你好'))
  assert.equal(store.unreadCount('B'), 0, 'B 已读后未读归零')
  assert.equal(store.unreadCount('C'), 1, 'C 仍未读（各自独立）')
  store.read(id, 'B')
  assert.equal(store.unreadCount('B'), 0, '重复读幂等')
  // 读即消费（未全读保留）：B 列表消失；C 未读仍可见；A 留痕仍在
  assert.equal(store.forSession('B').length, 0, 'B 读后消息从列表消失')
  assert.equal(store.forSession('C').length, 1, 'C 未读仍可见')
  assert.equal(store.forSession('A').length, 1, '未全读时发送方留痕保留')
  // 全员已读 → 自动删除（最后一个接收者读完触发；发送者留痕随之消失）
  store.read(id, 'C')
  assert.equal(store.items.some((m) => m.id === id), false, '全员已读自动删除')
  assert.equal(store.forSession('A').length, 0, '发送者留痕随全部读完消失')
  // remove：需未读消息测权限（单独发一条 A→B，不读）
  const sentRm = store.send({ sender: 'A', recipients: ['B'], content: '待删除' })
  assert.equal(store.remove(sentRm.item.id, 'D').ok, false, '无关会话不可删')
  assert.equal(store.remove(sentRm.item.id, 'B').ok, true, '接收者可删')
  // 长内容（>8KB）：落文件，read 取全文 + 单接收者 read 即删（文件一并清理）
  const big = '大'.repeat(9000)
  const sentBig = store.send({ sender: 'A', recipients: ['B'], content: big })
  assert.ok(sentBig.item.bodyFile, '超长内容落文件')
  const readBig = store.read(sentBig.item.id, 'B')
  assert.equal(readBig.item.content.length, 9000, 'read 返回全文')
  assert.equal(store.items.some((m) => m.id === sentBig.item.id), false, '单接收者 read 即删')
  assert.equal(existsSync(sentBig.item.bodyFile), false, '长内容文件一并清理')
  // prune：超 30 天清理
  const now = Date.now()
  store.items.push({ id: 'old-1', sender: 'A', recipients: ['B'], content: '旧', createdAt: now - 31 * 24 * 3600 * 1000, readBy: [] })
  const pruned = store.prune()
  assert.equal(pruned, 1)
  assert.equal(store.forSession('B').some((m) => m.id === 'old-1'), false)
  rmSync(dir, { recursive: true, force: true })
})

test('broadcast snapshot block: 定点注入只给接收者 + read 后提示消失', () => {
  const dir = tempDir()
  const coiDir = join(dir, 'coi')
  mkdirSync(coiDir, { recursive: true })
  const now = Date.now()
  writeFileSync(join(coiDir, 'broadcast.json'), JSON.stringify([
    { id: 'msg-1', sender: 'sessA', recipients: ['sessB'], content: '给 B 的消息', createdAt: now, readBy: [] },
    { id: 'msg-2', sender: 'sessA', recipients: ['sessC'], content: '给 C 的消息', createdAt: now, readBy: [] },
    { id: 'msg-3', sender: 'sessA', recipients: ['sessB'], content: 'B 已读', createdAt: now, readBy: ['sessB'] },
  ]))
  // 独立目录：broadcastDataDir（默认 memoryDir/broadcast，测试显式指定原路径）
  const config = resolveConfig({ memoryDir: dir, coiEnabled: true, broadcastDataDir: coiDir })
  // B：1 条未读（msg-1；msg-3 已读不计）；收件箱式列出 id+主题，可直接 read
  const blockB = buildBroadcastBlock(config, 'sessB')
  assert.ok(blockB !== null)
  assert.ok(blockB.includes('未读消息 1 条'), 'B 看到自己的未读数')
  assert.ok(blockB.includes('msg-1'), '快照列出消息 id（AI 可直接 read，无需先 list）')
  assert.ok(blockB.includes('给 B 的消息'), '快照列出主题（缺省=内容首行）')
  assert.ok(blockB.includes('必须用 de_broadcast read'), '指令式：必须 read 处理')
  assert.ok(!blockB.includes('msg-2'), '不注入他人消息')
  assert.ok(!blockB.includes('msg-3'), '已读消息不列出')
  // C：1 条未读（msg-2）
  const blockC = buildBroadcastBlock(config, 'sessC')
  assert.ok(blockC.includes('未读消息 1 条'))
  assert.ok(blockC.includes('msg-2'))
  // 无关会话 / 无会话视角：整段不注入（定点）
  assert.equal(buildBroadcastBlock(config, 'sessD'), null, '无关会话无感知')
  assert.equal(buildBroadcastBlock(config, undefined), null, '无会话视角不注入')
  // 文件不存在：null
  assert.equal(buildBroadcastBlock(resolveConfig({ memoryDir: tempDir() }), 'sessB'), null)
  // read 后提示消失（模拟 readBy 落盘）
  const parsed = JSON.parse(readFileSync(join(coiDir, 'broadcast.json'), 'utf8'))
  parsed.find((m) => m.id === 'msg-1').readBy.push('sessB')
  writeFileSync(join(coiDir, 'broadcast.json'), JSON.stringify(parsed))
  assert.equal(buildBroadcastBlock(config, 'sessB'), null, '全部已读后提示消失')
  rmSync(dir, { recursive: true, force: true })
})

test('coi tools: de_broadcast send/list/read/delete via session id', async () => {
  const dir = tempDir()
  const coiDir = join(dir, 'coi')
  mkdirSync(coiDir, { recursive: true })
  const broadcast = new BroadcastStore(coiDir)
  const { scheduler } = bootScheduler(dir)
  // 独立模块：工具由 messageToolDefinition 提供（coiToolDefinitions 已无
  // broadcast 参数，只返回 5 个调度工具）
  const msgTool = messageToolDefinition(broadcast)
  assert.equal(msgTool.name, 'de_broadcast')
  const execB = { agent: { session: { id: 'sessB', header: { cwd: '/p' } } } }
  const execA = { agent: { session: { id: 'sessA', header: { cwd: '/p' } } } }
  // send：sender 从执行上下文自动取（B 给 A 发）；subject 缺省取内容首行
  const sent = await msgTool.execute({ action: 'send', recipients: ['sessA'], content: '请查看项目日志' }, execB)
  assert.equal(sent.ok, true)
  // list：A 收到 1 条未读；无关会话 0 条；收件箱式（主题 + 简短简介）
  const listA = await msgTool.execute({ action: 'list' }, execA)
  assert.equal(listA.messages.length, 1)
  assert.equal(listA.messages[0].unread, true)
  assert.equal(listA.messages[0].sender, 'sessB')
  assert.equal(listA.messages[0].subject, '请查看项目日志', '缺省 subject 取内容首行')
  assert.ok(listA.messages[0].content.length <= 60, 'list 只给简短简介（收件箱式）')
  const listOther = await msgTool.execute({ action: 'list' }, { agent: { session: { id: 'sessX' } } })
  assert.equal(listOther.messages.length, 0)
  // read：返回全文（不截断）+ 已读
  const read = await msgTool.execute({ action: 'read', id: listA.messages[0].id }, execA)
  assert.equal(read.ok, true)
  assert.ok(read.messages[0].content.includes('项目日志'))
  // 读即消费：A read 后（唯一接收者）消息自动删除，列表为空
  const listA2 = await msgTool.execute({ action: 'list' }, execA)
  assert.equal(listA2.messages.length, 0, 'read 后消息自动删除（列表为空）')
  // delete：接收方 A 可删（重新发一条未读的）
  const sent2 = await msgTool.execute({ action: 'send', recipients: ['sessA'], content: '第二条' }, execB)
  assert.equal(sent2.ok, true)
  const listA3 = await msgTool.execute({ action: 'list' }, execA)
  const del = await msgTool.execute({ action: 'delete', id: listA3.messages[0].id }, execA)
  assert.equal(del.ok, true)
  const listA4 = await msgTool.execute({ action: 'list' }, execA)
  assert.equal(listA4.messages.length, 0)
  // coiToolDefinitions 只含调度工具（广播已独立）
  const toolsPlain = coiToolDefinitions(scheduler)
  assert.deepEqual(toolsPlain.map((t) => t.name), ['de_coi_dispatch', 'de_coi_adapters', 'de_coi_status', 'de_coi_wait', 'de_coi_cancel'])
  rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------------ 房间与项目群

test('broadcast rooms: create/join/leave/list/remove + 伪接收者可见性', () => {
  const dir = tempDir()
  const bdir = join(dir, 'broadcast')
  mkdirSync(bdir, { recursive: true })
  const broadcast = new BroadcastStore(bdir)
  const rooms = broadcast.rooms
  // 创建：创建者自动入房；名字缺省=id
  const created = rooms.create({ name: '审核组', createdBy: 'A' })
  assert.equal(created.ok, true)
  const rid = created.room.id
  assert.ok(rid.startsWith('room-'))
  assert.deepEqual(created.room.members, ['A'])
  // join 幂等 + 非成员校验
  assert.equal(rooms.join(rid, 'B').ok, true)
  assert.equal(rooms.join(rid, 'B').ok, true, '重复加入幂等')
  assert.equal(rooms.join('room-nope', 'B').ok, false, '不存在房间拒绝')
  assert.equal(rooms.list('B').length, 1, 'B 加入后可见房间')
  assert.equal(rooms.list('X').length, 0)
  // 发消息到房间：非成员被拒、成员成功
  assert.equal(broadcast.send({ sender: 'X', recipients: [`${rid}`], content: '潜入' }).ok, false, '非成员不能发房间消息')
  const sent = broadcast.send({ sender: 'A', recipients: [rid], content: '开始审核', subject: '同步' })
  assert.equal(sent.ok, true)
  const msgId = sent.item.id
  // 可见性：成员 B 未读可见；非成员 X 不可见（forSession/unreadCount）
  assert.equal(broadcast.unreadCount('B'), 1, '房间成员看到未读')
  assert.equal(broadcast.unreadCount('X'), 0, '非成员无感知')
  assert.equal(broadcast.forSession('B').length, 1)
  // read：成员可读；房间消息不自动删除（共享语义，30 天清理）
  const read = broadcast.read(msgId, 'B')
  assert.equal(read.ok, true)
  assert.ok(read.item.content.includes('开始审核'))
  assert.equal(broadcast.items.some((m) => m.id === msgId), true, '房间消息 read 后保留（回看）')
  assert.equal(broadcast.unreadCount('B'), 0, '已读后未读归零')
  // remove：房间成员可删（B 可删 A 发的房间消息）
  assert.equal(broadcast.remove(msgId, 'B').ok, true, '房间成员可删除房间消息')
  // leave：退出后不可见；最后一个退出房间删除
  assert.equal(rooms.leave(rid, 'B').ok, true)
  assert.equal(rooms.get(rid).members.length, 1)
  assert.equal(rooms.leave(rid, 'A').ok, true)
  assert.equal(rooms.get(rid), undefined, '最后一个成员退出后房间删除')
  // remove：仅创建者可删
  const r2 = rooms.create({ name: '组2', createdBy: 'A' })
  assert.equal(rooms.remove(r2.room.id, 'B').ok, false, '非创建者不能删房间')
  assert.equal(rooms.remove(r2.room.id, 'A').ok, true)
  rmSync(dir, { recursive: true, force: true })
})

test('broadcast project:<路径> 伪接收者：同目录会话可见 + 跨目录不可见', () => {
  const dir = tempDir()
  const bdir = join(dir, 'broadcast')
  mkdirSync(bdir, { recursive: true })
  const broadcast = new BroadcastStore(bdir)
  // A（/proj1）发给 project:/proj1
  const sent = broadcast.send({ sender: 'A', recipients: ['project:/proj1'], content: '项目公告', subject: '公告' })
  assert.equal(sent.ok, true)
  const msgId = sent.item.id
  // 同目录会话 B（cwd=/proj1）可见；跨目录 C（cwd=/proj2）不可见
  assert.equal(broadcast.unreadCount('B', '/proj1'), 1, '同目录会话看到项目消息')
  assert.equal(broadcast.unreadCount('C', '/proj2'), 0, '跨目录会话无感知')
  assert.equal(broadcast.unreadCount('B'), 0, '无 cwd 信息时 project 消息不可见')
  // 发送者视角：留痕可见
  assert.equal(broadcast.forSession('A', '/proj1').some((m) => m.id === msgId), true, '发送者留痕')
  // read：同目录可读；跨目录拒绝；不自动删除（公告语义）
  assert.equal(broadcast.read(msgId, 'C', '/proj2').ok, false, '跨目录不可读')
  const read = broadcast.read(msgId, 'B', '/proj1')
  assert.equal(read.ok, true)
  assert.equal(broadcast.items.some((m) => m.id === msgId), true, 'project 消息 read 后保留（公告）')
  assert.equal(broadcast.unreadCount('B', '/proj1'), 0)
  // 显式会话消息仍"全员已读自动删除"（伪接收者不影响旧语义）
  const direct = broadcast.send({ sender: 'A', recipients: ['D'], content: '一对一' })
  assert.equal(broadcast.read(direct.item.id, 'D').ok, true)
  assert.equal(broadcast.items.some((m) => m.id === direct.item.id), false, '显式消息 read 即删不受影响')
  rmSync(dir, { recursive: true, force: true })
})

test('broadcast tools: room-create/join/leave/list + send 到房间', async () => {
  const dir = tempDir()
  const bdir = join(dir, 'broadcast')
  mkdirSync(bdir, { recursive: true })
  const broadcast = new BroadcastStore(bdir)
  const msgTool = messageToolDefinition(broadcast)
  const execA = { agent: { session: { id: 'sA', header: { cwd: '/p' } } } }
  const execB = { agent: { session: { id: 'sB', header: { cwd: '/p' } } } }
  // A 建房（room 输出必须剥离 createdBy 等内部字段——P0：超 schema 会被模型 API 拒）
  const created = await msgTool.execute({ action: 'room-create', name: '协作组' }, execA)
  assert.equal(created.ok, true)
  assert.equal(created.rooms.length, 1)
  assert.deepEqual(Object.keys(created.rooms[0]).sort(), ['createdAt', 'id', 'members', 'name'], 'room 输出不含 createdBy 等内部字段')
  const rid = created.rooms[0].id
  // B 加入（用户告知 room id）
  const joined = await msgTool.execute({ action: 'room-join', roomId: rid }, execB)
  assert.equal(joined.ok, true)
  // room-list：A/B 都看到
  const listA = await msgTool.execute({ action: 'room-list' }, execA)
  assert.equal(listA.rooms.length, 1)
  assert.equal(listA.rooms[0].members.length, 2)
  // A 发房间消息 → B 未读
  const sent = await msgTool.execute({ action: 'send', recipients: [rid], content: '第一条讨论' }, execA)
  assert.equal(sent.ok, true)
  const listB = await msgTool.execute({ action: 'list' }, execB)
  assert.equal(listB.messages.length, 1)
  assert.equal(listB.messages[0].unread, true)
  // B 读后未读提示消失；房间消息保留在列表（回看语义，unread=false）
  const read = await msgTool.execute({ action: 'read', id: listB.messages[0].id }, execB)
  assert.equal(read.ok, true)
  const listB2 = await msgTool.execute({ action: 'list' }, execB)
  assert.equal(listB2.messages.length, 1, '房间消息已读后保留（回看）')
  assert.equal(listB2.messages[0].unread, false)
  // 解散权限：非创建者拒绝；创建者 room-rm 解散
  const rmDenied = await msgTool.execute({ action: 'room-rm', roomId: rid }, execB)
  assert.equal(rmDenied.ok, false, '非创建者不能解散房间')
  // B 退出
  const left = await msgTool.execute({ action: 'room-leave', roomId: rid }, execB)
  assert.equal(left.ok, true)
  const listB3 = await msgTool.execute({ action: 'room-list' }, execB)
  assert.equal(listB3.rooms.length, 0)
  // 重新建房给 A 测试解散
  const created2 = await msgTool.execute({ action: 'room-create', name: '待解散' }, execA)
  const rmOk = await msgTool.execute({ action: 'room-rm', roomId: created2.rooms[0].id }, execA)
  assert.equal(rmOk.ok, true, '创建者可解散房间')
  rmSync(dir, { recursive: true, force: true })
})

test('broadcast snapshot block: 房间成员与项目内会话的未读清单注入', () => {
  const dir = tempDir()
  const bdir = join(dir, 'broadcast')
  mkdirSync(bdir, { recursive: true })
  const now = Date.now()
  writeFileSync(join(bdir, 'rooms.json'), JSON.stringify({ 'room-1': { id: 'room-1', name: '审核组', members: ['sessA', 'sessB'], createdAt: now, createdBy: 'sessA' } }))
  writeFileSync(join(bdir, 'broadcast.json'), JSON.stringify([
    { id: 'msg-r', sender: 'sessA', recipients: ['room-1'], content: '房间消息', subject: '房间', createdAt: now, readBy: [] },
    { id: 'msg-p', sender: 'sessA', recipients: ['project:/workA'], content: '项目消息', subject: '项目', createdAt: now, readBy: [] },
    { id: 'msg-d', sender: 'sessA', recipients: ['sessB'], content: '单聊', subject: '单聊', createdAt: now, readBy: [] },
  ]))
  const config = resolveConfig({ memoryDir: dir, broadcastEnabled: true, broadcastDataDir: bdir })
  // 房间成员 sessB（cwd=/workA）：三条全可见（房间成员 + 项目同目录 + 直接接收者）
  const blockB = buildBroadcastBlock(config, 'sessB', '/workA')
  assert.ok(blockB.includes('msg-r'), '房间成员注入房间消息')
  assert.ok(blockB.includes('msg-p'), '同目录注入项目消息')
  assert.ok(blockB.includes('msg-d'), '直接接收者注入')
  assert.ok(blockB.includes('未读消息 3 条'))
  // 非成员且跨目录 sessC：只看到直接接收者？sessC 无任何关系 → null
  assert.equal(buildBroadcastBlock(config, 'sessC', '/workB'), null, '无关会话无感知')
  // 房间非成员但同目录 sessD：只看到项目消息
  const blockD = buildBroadcastBlock(config, 'sessD', '/workA')
  assert.ok(blockD !== null)
  assert.ok(!blockD.includes('msg-r'), '非房间成员看不到房间消息')
  assert.ok(blockD.includes('msg-p'), '同目录看到项目消息')
  rmSync(dir, { recursive: true, force: true })
})

test('broadcast prune: 30 天无活动房间自动删除（连同其消息）', () => {
  const dir = tempDir()
  const bdir = join(dir, 'broadcast')
  mkdirSync(bdir, { recursive: true })
  const broadcast = new BroadcastStore(bdir)
  // 建房 + 发消息（房内 2 人）
  const created = broadcast.rooms.create({ name: '协作组', createdBy: 'A' })
  broadcast.rooms.join(created.room.id, 'B')
  const sent = broadcast.send({ sender: 'A', recipients: [created.room.id], content: '第一条' })
  assert.equal(sent.ok, true)
  const activeRoomId = created.room.id
  // 建房但不拉人（空房间）
  const lonely = broadcast.rooms.create({ name: '废群', createdBy: 'X' })
  const lonelyRoomId = lonely.room.id
  // 把两个房间的 lastActiveAt 拨回 31 天前（模拟长期无活动）
  broadcast.rooms.rooms[activeRoomId].lastActiveAt = Date.now() - 31 * 24 * 3600 * 1000
  broadcast.rooms.rooms[lonelyRoomId].lastActiveAt = Date.now() - 31 * 24 * 3600 * 1000
  // prune：两个房间都删除；房间消息一并删除
  const pruned = broadcast.prune()
  assert.equal(broadcast.rooms.get(activeRoomId), undefined, '无活动房间删除')
  assert.equal(broadcast.rooms.get(lonelyRoomId), undefined, '空房间删除')
  assert.equal(broadcast.items.length, 0, '房间消息一并删除')
  assert.ok(pruned >= 1, '统计清理数')
  // 活跃房间（lastActiveAt 近期）不受影响
  const fresh = broadcast.rooms.create({ name: '活跃', createdBy: 'A' })
  broadcast.send({ sender: 'A', recipients: [fresh.room.id], content: '新消息' })
  broadcast.prune()
  assert.equal(broadcast.rooms.get(fresh.room.id) !== undefined, true, '活跃房间保留')
  rmSync(dir, { recursive: true, force: true })
})
