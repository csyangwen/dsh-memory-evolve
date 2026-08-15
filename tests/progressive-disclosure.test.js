import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { apply, resolveConfig, renderSnapshot } from '../lib/index.js'
import { MemoryStore, projectHash } from '../lib/store.js'
import { extractEntryId } from '../lib/sync/entryid.js'
import { approveSuggestions } from '../lib/review.js'
import { SuggestionQueue } from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'

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
  const commit = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir, stdio: 'ignore' })
  return commit.status === 0 ? 'test-main' : null
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-pd-test-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** Minimal fake context（与 plugin.test.js 同款）。 */
function fakeCtx(overrides = {}) {
  const state = { tools: [], contexts: [], commands: [], listeners: [], routes: [] }
  const services = {
    tools: {
      register: (def) => { state.tools.push(def); return () => {} },
      get: () => undefined,
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
    on: (name, listener) => { (state.listeners[name] ??= []).push(listener); return () => {} },
    inject: (deps, callback) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return { dispose: () => {} }
      const disposer = callback(ctx)
      return { dispose: disposer ?? (() => {}) }
    },
    effect: (fn) => { const disposer = fn(); return disposer ?? (() => {}) },
    get: (key) => services[key],
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    ...overrides,
  }
  return ctx
}

function keyFileOf(dir, cwd) {
  return join(dir, 'projects', projectHash(cwd), 'KEY.md')
}

function storeEntries(path) {
  return readFileSync(path, 'utf8').split('\n§\n').map((e) => e.trim()).filter(Boolean)
}

test('key add 的 summary 参数：清洗换行与 ] 后写入 [summary:...] 标签', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  const tool = ctx.state.tools.find((t) => t.name === 'memory')
  const cwd = '/proj/pd'
  const exec = { agent: { id: 'a', session: { header: { cwd } } }, callId: 'c1', signal: new AbortController().signal }
  // 恶意/意外输入：含换行、]、制表符的 summary
  const added = await tool.execute({
    action: 'add', target: 'key',
    content: '正文内容',
    summary: '多行\n摘要]带括号\t和制表符',
  }, exec)
  assert.equal(added.ok, true)
  const queued = readFileSync(join(dir, 'SUGGESTIONS.jsonl'), 'utf8')
  // 队列内容里的 [summary:…] 必须是单行、无 ]、无制表符
  const m = /\[summary:([^\]]*)\]/.exec(queued)
  assert.ok(m !== null, 'sanitized summary tag present')
  assert.ok(!m[1].includes(']'))
  assert.ok(!m[1].includes('\n'))
  assert.ok(!m[1].includes('\t'))
  assert.ok(m[1].length > 0 && m[1].length <= 120)
  // 用户确认 → 落盘 KEY.md，标签原样保留
  const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
  approveSuggestions(new MemoryStore(dir), new TodoStore(dir), queue, [1], undefined)
  const entries = storeEntries(keyFileOf(dir, cwd))
  assert.equal(entries.length, 1)
  assert.match(entries[0], /\[summary:[^\]]*\]\n正文内容/)
  clean(dir)
})

test('key add 的 summary：清洗后为空则不写标签', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  const tool = ctx.state.tools.find((t) => t.name === 'memory')
  const cwd = '/proj/pd2'
  const exec = { agent: { id: 'a', session: { header: { cwd } } }, callId: 'c1', signal: new AbortController().signal }
  await tool.execute({ action: 'add', target: 'key', content: '正文', summary: ']]]\n\n' }, exec)
  const queued = readFileSync(join(dir, 'SUGGESTIONS.jsonl'), 'utf8')
  assert.ok(!queued.includes('[summary:'), 'empty sanitized summary must not emit a tag')
  clean(dir)
})

test('expand：按 id 加载全文，剥身份证与摘要标记；未知 id 报错', async () => {
  const dir = tempDir()
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: dir })
  const tool = ctx.state.tools.find((t) => t.name === 'memory')
  const cwd = '/proj/pd3'
  const exec = { agent: { id: 'a', session: { header: { cwd } } }, callId: 'c1', signal: new AbortController().signal }
  // 直接落盘一条带 summary 的 key 条目（绕过队列：手工构造文件）
  const file = keyFileOf(dir, cwd)
  const store = new MemoryStore(dir)
  const agent = { session: { header: { cwd } } }
  store.add('key', '[summary:手工摘要] 展开可见的全文内容', agent)
  const entries = store.entriesOf('key', agent)
  assert.equal(entries.length, 1)
  const raw = readFileSync(file, 'utf8')
  assert.ok(raw.includes('[summary:手工摘要]'))
  // expand 需要身份证 id：entryIdMode off 的条目没有 [id:...]——用 legacyIdFor 兜底
  const { legacyIdFor } = await import('../lib/sync/entryid.js')
  const id = extractEntryId(entries[0]) ?? legacyIdFor(entries[0])
  assert.ok(typeof id === 'string' && id.length > 0)
  const expanded = await tool.execute({ action: 'expand', target: 'key', id }, exec)
  assert.equal(expanded.ok, true)
  assert.equal(expanded.entries.length, 1)
  assert.ok(expanded.entries[0].includes('展开可见的全文内容'))
  assert.ok(!expanded.entries[0].includes('[summary:'), 'summary tag stripped from expand output')
  assert.ok(!expanded.entries[0].includes(`[id:${id}]`), 'entry id stripped from expand output')
  // 未知 id
  const miss = await tool.execute({ action: 'expand', target: 'key', id: 'ffffffff' }, exec)
  assert.equal(miss.ok, false)
  clean(dir)
})

test('expand：审查修复回归——分支作用域过滤（分支 A 不能 expand 分支 B 的条目）', async () => {
  const dir = tempDir()
  const repo = tempDir()
  const branch = initGitRepo(repo)
  if (gitAvailable() && branch !== null) {
    try {
      const ctx = fakeCtx()
      apply(ctx, { memoryDir: dir })
      const tool = ctx.state.tools.find((t) => t.name === 'memory')
      const exec = { agent: { id: 'a', session: { header: { cwd: repo } } }, callId: 'c1', signal: new AbortController().signal }
      // test-main 分支的条目（限别的分支 other-x）
      const store = new MemoryStore(dir)
      const agent = { session: { header: { cwd: repo } } }
      store.add('key', '[branch:other-x] [summary:别分支] 仅限 other-x 分支的秘密', agent)
      store.add('key', '[summary:通用] 无标记通用条目', agent)
      const entries = store.entriesOf('key', agent)
      const { legacyIdFor } = await import('../lib/sync/entryid.js')
      const otherId = extractEntryId(entries.find((e) => e.includes('other-x')) ?? '') ?? legacyIdFor(entries.find((e) => e.includes('other-x')) ?? '')
      const anyId = extractEntryId(entries.find((e) => e.includes('通用')) ?? '') ?? legacyIdFor(entries.find((e) => e.includes('通用')) ?? '')
      // 当前分支 test-main：受限条目 expand 不到（修复前能拿到 → 越权）
      const denied = await tool.execute({ action: 'expand', target: 'key', id: otherId }, exec)
      assert.equal(denied.ok, false, 'branch-scoped entry must not be expandable from another branch')
      // 无标记条目随时可 expand
      const allowed = await tool.execute({ action: 'expand', target: 'key', id: anyId }, exec)
      assert.equal(allowed.ok, true)
    } finally {
      clean(dir)
      clean(repo)
    }
  } else {
    // 无 git 环境：跳过（打印跳过原因，避免假绿）
    assert.ok(true, 'git unavailable - skipped')
  }
})

test('renderSnapshot：off（默认）全量注入，on 摘要注入带 [id] 与 expand 提示', () => {
  const dir = tempDir()
  const cwd = '/proj/pd4'
  const agent = { id: 'a', session: { header: { cwd } } }
  const store = new MemoryStore(dir)
  store.add('key', '[summary:显式摘要] 这是一条很长很长的正文内容第一行\n还有第二行', agent)
  store.add('key', '没有显式摘要的条目', agent)
  // off（默认）：全文注入、无 summary 标签
  const off = renderSnapshot(resolveConfig({ memoryDir: dir }), store, agent)
  assert.ok(off.includes('这是一条很长很长的正文内容第一行'))
  assert.ok(!off.includes('[summary:显式摘要]'))
  assert.ok(!off.includes('摘要模式'))
  // on：摘要注入
  const on = renderSnapshot(resolveConfig({ memoryDir: dir, keyProgressiveDisclosure: 'on' }), store, agent)
  assert.ok(on.includes('摘要模式'))
  assert.ok(on.includes('action=expand+id'))
  assert.ok(on.includes('显式摘要'), 'explicit summary used when present')
  assert.ok(!on.includes('这是一条很长很长的正文内容第一行'), 'full body must not leak in summary mode')
  // 无显式摘要的条目 → autoSummary 首行兜底
  assert.ok(on.includes('没有显式摘要的条目'))
  clean(dir)
})

test('renderSnapshot：auto 模式按条目数+字符数双阈值判定', () => {
  const dir = tempDir()
  const cwd = '/proj/pd5'
  const agent = { id: 'a', session: { header: { cwd } } }
  const store = new MemoryStore(dir)
  store.add('key', '短条目一', agent)
  store.add('key', '短条目二', agent)
  // 条目数 ≤ 3 且字符 ≤ 1500 → 全量
  const small = renderSnapshot(resolveConfig({ memoryDir: dir, keyProgressiveDisclosure: 'auto' }), store, agent)
  assert.ok(!small.includes('摘要模式'), 'small key set injects full text in auto mode')
  assert.ok(small.includes('短条目一'))
  // 字符超限 → 摘要（字符阈值调到极小值）
  const big = renderSnapshot(resolveConfig({ memoryDir: dir, keyProgressiveDisclosure: 'auto', keyFullInjectCharLimit: 1 }), store, agent)
  assert.ok(big.includes('摘要模式'), 'over char limit falls back to summary in auto mode')
  // 条目数超限 → 摘要（条目阈值调到 1，两条数据）
  const many = renderSnapshot(resolveConfig({ memoryDir: dir, keyProgressiveDisclosure: 'auto', keyFullInjectThreshold: 1 }), store, agent)
  assert.ok(many.includes('摘要模式'), 'over entry threshold falls back to summary in auto mode')
  clean(dir)
})
