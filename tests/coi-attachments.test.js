/**
 * COI 图片附件测试（P2：de_coi_dispatch attachments）——独立测试文件，
 * 不与其他并行会话共享 tests/coi.test.js（工作区协调：该文件被 P3 占用）。
 *
 * 覆盖：
 *   - buildArgs：flag 模式（codex -i / hermes --image）图片参数插入位置；
 *     prompt 模式（kimi/grok）不插 CLI 参数
 *   - resolveAttachments：path 校验（存在/扩展名）、url 下载（stub fetch）、
 *     attachmentId（无服务报错 / 有服务+会话事件解析完整 ref 落盘）、
 *     三选一/数量/类型校验
 *   - dispatch 集成：不支持的适配器明确报错；flag 模式 spawn 参数含图片；
 *     prompt 模式任务文本含【附件图片】段；任务记录 attachments 元数据
 *   - validateAdapter：image 配置校验
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AdapterStore, BUILTIN_ADAPTERS, buildArgs, validateAdapter,
} from '../lib/coi/adapters.js'
import { SessionStore } from '../lib/coi/session-store.js'
import { TaskStore } from '../lib/coi/tasks-store.js'
import { TemplateStore } from '../lib/coi/templates.js'
import { CoiScheduler } from '../lib/coi/scheduler.js'
import { resolveAttachments } from '../lib/coi/attachments.js'

/** 所有测试创建的调度器：统一 dispose，避免 flush 定时器挂住事件循环。 */
const schedulers = []
after(() => {
  for (const scheduler of schedulers) scheduler.dispose()
})

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-coi-att-test-'))
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

function bootStores(dir) {
  const adapters = new AdapterStore(join(dir, 'adapters.json'))
  const sessions = new SessionStore(join(dir, 'sessions.json'))
  const templates = new TemplateStore(join(dir, 'templates.json'))
  const tasks = new TaskStore(dir, { maxLogBytes: 65536, retentionDays: 90 })
  return { adapters, sessions, templates, tasks }
}

function bootScheduler(dir, overrides = {}) {
  const stores = bootStores(dir)
  const harness = makeSpawnHarness()
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
    writeSummary: overrides.writeSummary ?? (() => {}),
    memoryContext: () => '',
    attachmentsStore: overrides.attachmentsStore,
    agentsService: overrides.agentsService,
  }, { spawn: harness.spawn })
  schedulers.push(scheduler)
  scheduler.recover()
  return { ...stores, scheduler, harness }
}

/** 造一张合法的本地测试图片（仅扩展名校验，内容不校验）。 */
function makeImage(dir, name = 'shot.png') {
  const path = join(dir, name)
  writeFileSync(path, Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]))
  return path
}

// ---------------------------------------------------------------- buildArgs

test('buildArgs: flag-mode adapters insert image args before {task}', () => {
  const codex = BUILTIN_ADAPTERS.codex
  const hermes = BUILTIN_ADAPTERS.hermes
  // codex：exec -i a.png -i b.png "task"
  const args = buildArgs(codex, { task: '看图', images: ['/tmp/a.png', '/tmp/b.png'] })
  assert.deepEqual(args, ['exec', '-i', '/tmp/a.png', '-i', '/tmp/b.png', '看图'])
  // hermes：-z --image a.png "task"
  const hArgs = buildArgs(hermes, { task: '看图', images: ['/tmp/a.png'] })
  assert.deepEqual(hArgs, ['-z', '--image', '/tmp/a.png', '看图'])
  // 无图片时参数与旧版完全一致（回归保护）
  assert.deepEqual(buildArgs(codex, { task: '看图' }), ['exec', '看图'])
  // resume 模式（codex resume args 含 {task}）：图片同样插在任务参数前
  const resume = buildArgs(codex, { task: '续看图', sessionId: 'sess-1', mode: 'resume', images: ['/tmp/a.png'] })
  assert.deepEqual(resume, ['exec', 'resume', 'sess-1', '-i', '/tmp/a.png', '续看图'])
  // continue 模式（flag）：-c 在前、图片在后
  const cont = buildArgs(codex, { task: '续看图', mode: 'continue', images: ['/tmp/a.png'] })
  assert.deepEqual(cont, ['exec', 'resume', '--last', '-i', '/tmp/a.png', '续看图'])
})

test('buildArgs: prompt-mode adapters (kimi/grok) never get CLI image args', () => {
  const kimi = BUILTIN_ADAPTERS.kimi
  const grok = BUILTIN_ADAPTERS.grok
  const kArgs = buildArgs(kimi, { task: '看图', images: ['/tmp/a.png'] })
  assert.deepEqual(kArgs, ['-p', '看图'], 'kimi 图片走 prompt，不插 CLI 参数')
  const gArgs = buildArgs(grok, { task: '看图', images: ['/tmp/a.png'] })
  assert.deepEqual(gArgs, ['-p', '看图'], 'grok 图片走 prompt，不插 CLI 参数')
})

// --------------------------------------------------------- resolveAttachments

test('resolveAttachments: path source — exists + image extension', async () => {
  const dir = tempDir()
  const img = makeImage(dir)
  const out = join(dir, 'att')
  // 合法本地图片：原路径直用
  const ok = await resolveAttachments([{ path: img, caption: '截图' }], { outputDir: out, tag: 't1' })
  assert.equal(ok.ok, true)
  assert.equal(ok.files.length, 1)
  assert.equal(ok.files[0].localPath, img)
  assert.equal(ok.files[0].source, 'path')
  assert.equal(ok.files[0].caption, '截图')
  // 不存在 → 报错
  const missing = await resolveAttachments([{ path: join(dir, 'nope.png') }], { outputDir: out, tag: 't2' })
  assert.equal(missing.ok, false)
  assert.match(missing.message, /不存在/)
  // 非图片扩展名 → 报错
  const txt = join(dir, 'note.txt')
  writeFileSync(txt, 'hello')
  const bad = await resolveAttachments([{ path: txt }], { outputDir: out, tag: 't3' })
  assert.equal(bad.ok, false)
  assert.match(bad.message, /不是图片/)
  rmSync(dir, { recursive: true, force: true })
})

test('resolveAttachments: shape validation — array/三选一/数量/类型', async () => {
  const dir = tempDir()
  const out = join(dir, 'att')
  const img = makeImage(dir)
  // 非数组
  assert.equal((await resolveAttachments('nope', { outputDir: out, tag: 't' })).ok, false)
  // 缺来源
  assert.equal((await resolveAttachments([{ caption: 'x' }], { outputDir: out, tag: 't' })).ok, false)
  // 来源冲突（path+url）
  assert.equal((await resolveAttachments([{ path: img, url: 'https://x/y.png' }], { outputDir: out, tag: 't' })).ok, false)
  // kind=file 暂不支持
  assert.equal((await resolveAttachments([{ kind: 'file', path: img }], { outputDir: out, tag: 't' })).ok, false)
  // 超上限
  const many = Array.from({ length: 6 }, () => ({ path: img }))
  const over = await resolveAttachments(many, { outputDir: out, tag: 't' })
  assert.equal(over.ok, false)
  assert.match(over.message, /最多 5 张/)
  // undefined/null = 无附件
  assert.equal((await resolveAttachments(undefined, { outputDir: out, tag: 't' })).ok, true)
  rmSync(dir, { recursive: true, force: true })
})

test('resolveAttachments: url source — downloads to attachments dir', async () => {
  const dir = tempDir()
  const out = join(dir, 'att')
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://example.com/shot.png')
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]) }
  }
  try {
    const ok = await resolveAttachments([{ url: 'https://example.com/shot.png' }], { outputDir: out, tag: 't1' })
    assert.equal(ok.ok, true)
    assert.equal(ok.files[0].source, 'url')
    assert.ok(ok.files[0].localPath.endsWith('.png'), '扩展名从 URL 推断')
    assert.ok(existsSync(ok.files[0].localPath), '下载文件落盘')
    // 非 http(s) 地址 → 报错
    const bad = await resolveAttachments([{ url: 'ftp://x/y.png' }], { outputDir: out, tag: 't2' })
    assert.equal(bad.ok, false)
    assert.match(bad.message, /http\(s\)/)
  } finally {
    globalThis.fetch = origFetch
  }
  rmSync(dir, { recursive: true, force: true })
})

test('resolveAttachments: attachmentId — 无服务报错 / 有服务+会话事件解析落盘', async () => {
  const dir = tempDir()
  const out = join(dir, 'att')
  // 无 attachments 服务（当前旧运行时）：如实报错
  const noSvc = await resolveAttachments([{ attachmentId: 'att-x' }], { outputDir: out, tag: 't1' })
  assert.equal(noSvc.ok, false)
  assert.match(noSvc.message, /attachments 服务/)
  // 有服务但会话事件里找不到该图 → 报错
  const agentsEmpty = { get: () => ({ session: { events: [] } }) }
  const storeEmpty = { readImage: async () => { throw new Error('不应被调用') } }
  const notFound = await resolveAttachments(
    [{ attachmentId: 'att-missing' }],
    { outputDir: out, tag: 't2', attachmentsStore: storeEmpty, agentsService: agentsEmpty, sessionId: 'sess-1' },
  )
  assert.equal(notFound.ok, false)
  assert.match(notFound.message, /未找到匹配的图片/)
  // 完整链路：会话 user/message 事件里有 ImageBlock（完整 ref）→ readImage 读字节落盘
  const fullRef = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 4, width: 2, height: 2, name: '贴图.png' }
  const agents = { get: (id) => ({ session: { events: [{ type: 'user/message', data: { content: [{ type: 'image', attachment: fullRef }] } }] } }) }
  const store = {
    readImage: async (ref) => {
      assert.equal(ref.attachmentId, 'att-1')
      assert.equal(ref.bytes, 4, '传入的是会话事件里的完整 ref')
      return { ref: fullRef, data: new Uint8Array([9, 8, 7, 6]) }
    },
  }
  const ok = await resolveAttachments(
    [{ attachmentId: 'att-1', caption: '用户贴图' }],
    { outputDir: out, tag: 't3', attachmentsStore: store, agentsService: agents, sessionId: 'sess-1' },
  )
  assert.equal(ok.ok, true)
  assert.equal(ok.files[0].source, 'attachmentId')
  assert.equal(ok.files[0].name, '贴图.png')
  assert.ok(ok.files[0].localPath.endsWith('.png'))
  assert.ok(existsSync(ok.files[0].localPath), '会话图片字节落盘')
  assert.deepEqual([...readFileSync(ok.files[0].localPath)], [9, 8, 7, 6], '字节内容一致')
  rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------------- dispatch

test('dispatch: 不支持的适配器（无 image 配置）带附件 → 明确报错', () => {
  const dir = tempDir()
  const { scheduler, adapters } = bootScheduler(dir)
  // zcode 不在内置里：自定义一个无 image 配置的 ai-cli（模拟 zcode 纯文本）
  adapters.upsert({
    id: 'zcode', name: 'ZCode', type: 'ai-cli', binary: 'zcode',
    args: ['-p', '{task}'], resume: { kind: 'flag', flag: '-r', arg: '{sessionId}' },
  })
  const result = scheduler.dispatch({
    adapterId: 'zcode',
    prompt: '看图',
    attachments: [{ localPath: '/tmp/a.png', name: 'a.png', source: 'path', original: '/tmp/a.png' }],
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /不支持图片附件/)
  assert.match(result.message, /codex|hermes|kimi/)
  rmSync(dir, { recursive: true, force: true })
})

test('dispatch: codex（flag 模式）spawn 参数含 -i 图片路径，任务记录附件元数据', () => {
  const dir = tempDir()
  const { scheduler, harness, tasks } = bootScheduler(dir)
  const img = makeImage(dir)
  const result = scheduler.dispatch({
    adapterId: 'codex',
    prompt: '分析这张截图',
    attachments: [{ localPath: img, name: 'shot.png', caption: '报错截图', source: 'path', original: img }],
  })
  assert.equal(result.ok, true)
  const child = harness.children[0]
  assert.ok(child.args.includes('-i'), 'spawn 参数含 -i')
  assert.ok(child.args.includes(img), 'spawn 参数含图片路径')
  // 任务留档记录附件元数据（含来源与本地路径）
  const task = tasks.get(result.taskId)
  assert.equal(task.attachments.length, 1)
  assert.equal(task.attachments[0].source, 'path')
  assert.equal(task.attachments[0].original, img)
  assert.equal(task.attachments[0].caption, '报错截图')
  rmSync(dir, { recursive: true, force: true })
})

test('dispatch: kimi（prompt 模式）任务文本含【附件图片】段与路径', () => {
  const dir = tempDir()
  const { scheduler, harness } = bootScheduler(dir)
  const img = makeImage(dir)
  const result = scheduler.dispatch({
    adapterId: 'kimi',
    prompt: '识别图片内容',
    attachments: [{ localPath: img, name: 'shot.png', caption: '登录页', source: 'path', original: img }],
  })
  assert.equal(result.ok, true)
  const prompt = harness.children[0].args[1]
  assert.ok(prompt.includes('【附件图片】'), 'prompt 含附件图片段')
  assert.ok(prompt.includes(img), 'prompt 含图片绝对路径')
  assert.ok(prompt.includes('登录页'), 'prompt 含 caption')
  assert.ok(prompt.includes('读图能力'), '提示 agent 用读图能力查看')
  // flag 参数不插（kimi 无专用图片参数）
  assert.ok(!harness.children[0].args.includes('-i'))
  rmSync(dir, { recursive: true, force: true })
})

test('dispatch: 无附件时行为与旧版完全一致（无附件段/无图片参数）', () => {
  const dir = tempDir()
  const { scheduler, harness } = bootScheduler(dir)
  const result = scheduler.dispatch({ adapterId: 'grok', prompt: '普通任务' })
  assert.equal(result.ok, true)
  const prompt = harness.children[0].args[1]
  assert.ok(prompt.includes('普通任务'), '任务文本含原 prompt')
  assert.ok(!prompt.includes('【附件图片】'), '无附件不追加附件段')
  assert.ok(!prompt.includes('读图能力'), '无附件不追加读图提示')
  assert.equal(harness.children[0].args.includes('-i'), false, '无图片参数')
  rmSync(dir, { recursive: true, force: true })
})

// ----------------------------------------------------- validateAdapter image

test('validateAdapter: image 配置校验（mode/flag）', () => {
  const base = { id: 'x', name: 'X', type: 'ai-cli', binary: 'x', args: ['{task}'], resume: { kind: 'flag', flag: '-r', arg: '{sessionId}' } }
  // 合法：flag / prompt
  assert.equal(validateAdapter({ ...base, image: { mode: 'flag', flag: '-i' } }), true)
  assert.equal(validateAdapter({ ...base, image: { mode: 'prompt' } }), true)
  // mode 非法
  assert.throws(() => validateAdapter({ ...base, image: { mode: 'wat' } }), /image\.mode/)
  // flag 模式缺 flag
  assert.throws(() => validateAdapter({ ...base, image: { mode: 'flag' } }), /image\.flag/)
  // 缺省（不支持图片）合法——兼容旧自定义适配器
  assert.equal(validateAdapter({ ...base }), true)
})

test('adapter store: 构造加载旧版 custom 内置覆盖时合并内置定义（image 配置不丢失）', () => {
  const dir = tempDir()
  const file = join(dir, 'adapters.json')
  // 模拟旧版存储：P2 图片附件上线之前保存的内置覆盖（完整旧定义、无 image 字段）
  const oldKimi = { id: 'kimi', name: 'Kimi Code', type: 'ai-cli', binary: 'kimi', args: ['-p', '{task}'], resume: { kind: 'flag', flag: '-S', arg: '{sessionId}' }, continue: { kind: 'flag', flag: '-c' }, sessionIdExtract: { source: 'any', regex: 'To resume this session: kimi -r (session_\\S+)' }, outputParse: 'text', defaults: { timeoutMs: 1800000 }, mgmtCmds: { export: ['export'] }, env: {}, testCmd: ['-p', '只回答数字：1+1'] }
  writeFileSync(file, JSON.stringify({ kimi: oldKimi }, null, 2))
  const store = new AdapterStore(file)
  const kimi = store.get('kimi')
  assert.ok(kimi.image, '旧版存储缺 image → 合并后继承内置 image 配置（2026-08-11 回归）')
  assert.equal(kimi.image.mode, 'prompt')
  // 用户改过的字段（useCase）仍优先，未覆盖字段（image）继承内置
  const oldGrok = { ...oldKimi, id: 'grok', name: 'Grok (xAI)', binary: 'grok', resume: { kind: 'flag', flag: '-r', arg: '{sessionId}' }, sessionIdExtract: { source: 'none', regex: null }, mgmtCmds: { list: ['sessions', 'list'], export: ['export'] }, useCase: '用户自定义场景' }
  writeFileSync(file, JSON.stringify({ kimi: oldKimi, grok: oldGrok }, null, 2))
  const store2 = new AdapterStore(file)
  assert.equal(store2.get('grok').useCase, '用户自定义场景', '用户覆盖字段优先')
  assert.ok(store2.get('grok').image, '未覆盖字段继承内置')
  rmSync(dir, { recursive: true, force: true })
})
