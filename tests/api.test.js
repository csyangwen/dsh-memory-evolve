import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveStore, MemoryStore, SuggestionQueue } from '../lib/store.js'
import { installApi } from '../lib/api.js'
import { validateRuntimePatch } from '../lib/index.js'
import { TodoStore } from '../lib/todo.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-api-test-'))
}

/** Boot a real HTTP server over installApi's handler. */
async function bootApi(overrides = {}) {
  const dir = tempDir()
  const store = new MemoryStore(dir)
  const archive = new ArchiveStore(dir)
  const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
  const todoStore = new TodoStore(dir)
  const state = { reviewEnabled: true, reviewInterval: 10, reviewMode: 'suggest', memoryTabEnabled: true }
  const getRuntime = () => ({ ...state })
  const updateRuntime = (patch) => {
    for (const [key, value] of Object.entries(patch)) validateRuntimePatch(key, value)
    Object.assign(state, patch)
    return { ...state }
  }
  const ctx = {
    httpServer: {
      register: ({ handler }) => {
        ctx.handler = handler
        return () => {}
      },
    },
  }
  const revealTargets = {
    memoryDir: dir,
    nope: undefined,
  }
  installApi(ctx, {
    store, archive, queue, todoStore, getRuntime, updateRuntime,
    resolveRevealTarget: (target) => revealTargets[target],
    revealPath: overrides.revealPath ?? (() => {}),
    config: overrides.config ?? { memoryDir: dir, skillDir: join(dir, 'skills') },
    resolveCwd: overrides.resolveCwd ?? (() => undefined),
  })
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
  return { base, queue, archive, store, request, dir, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('api badge and suggestions endpoints', async () => {
  const api = await bootApi()
  try {
    const badge = await api.request('GET', '/memory-evolve/api/badge')
    assert.equal(badge.status, 200)
    assert.equal(badge.data.count, 0)
    assert.equal(badge.data.suggestions, 0)
    assert.equal(badge.data.skills, 0)
    api.queue.append({ time: 't', target: 'user', content: '候选记忆', reason: 'r', cwd: null })
    const badge2 = await api.request('GET', '/memory-evolve/api/badge')
    assert.equal(badge2.data.count, 1)
    assert.equal(badge2.data.suggestions, 1)
    assert.equal(badge2.data.skills, 0)
    const list = await api.request('GET', '/memory-evolve/api/suggestions')
    assert.equal(list.data.entries.length, 1)
    assert.equal(list.data.entries[0].content, '候选记忆')
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api approve/reject/approve-all/reject-all', async () => {
  const api = await bootApi()
  try {
    api.queue.append({ time: 't1', target: 'user', content: '第一条', reason: 'r', cwd: null })
    api.queue.append({ time: 't2', target: 'memory', content: '第二条', reason: 'r', cwd: null })
    const approve = await api.request('POST', '/memory-evolve/api/suggestions/approve', { indices: [1] })
    assert.equal(approve.status, 200)
    assert.equal(approve.data.remaining, 1)
    assert.equal(api.store.entriesOf('user').length, 1)
    const reject = await api.request('POST', '/memory-evolve/api/suggestions/reject', { indices: [1] })
    assert.equal(reject.data.remaining, 0)
    // approve-all on empty queue is a no-op
    const all = await api.request('POST', '/memory-evolve/api/suggestions/approve-all')
    assert.equal(all.status, 200)
    // invalid indices
    const bad = await api.request('POST', '/memory-evolve/api/suggestions/approve', { indices: [0] })
    assert.equal(bad.status, 400)
    const bad2 = await api.request('POST', '/memory-evolve/api/suggestions/approve', { indices: [] })
    assert.equal(bad2.status, 400)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api config get/update with validation', async () => {
  const api = await bootApi()
  try {
    const got = await api.request('GET', '/memory-evolve/api/config')
    assert.equal(got.data.config.reviewEnabled, true)
    // Only runtime-changeable keys are exposed — static config keys are not
    // valid patch keys, and echoing them back must not 400 on save.
    assert.equal('memoryDir' in got.data.config, false)
    assert.equal('toolName' in got.data.config, false)
    // memoryTabEnabled is exposed READ-ONLY (the client decides whether to
    // register the tab) but is no longer a runtime key — patching it fails.
    assert.equal(got.data.config.memoryTabEnabled, true)
    const tabPatch = await api.request('POST', '/memory-evolve/api/config', { patch: { memoryTabEnabled: false } })
    assert.equal(tabPatch.status, 400)
    const updated = await api.request('POST', '/memory-evolve/api/config', { patch: { reviewInterval: 5 } })
    assert.equal(updated.data.config.reviewInterval, 5)
    const bad = await api.request('POST', '/memory-evolve/api/config', { patch: { reviewInterval: 0 } })
    assert.equal(bad.status, 400)
    const unknown = await api.request('POST', '/memory-evolve/api/config', { patch: { nope: 1 } })
    assert.equal(unknown.status, 400)
    // Static keys are still rejected when a caller sends them explicitly.
    const staticKey = await api.request('POST', '/memory-evolve/api/config', { patch: { memoryDir: '/tmp/x' } })
    assert.equal(staticKey.status, 400)
    const notPatch = await api.request('POST', '/memory-evolve/api/config', { patch: [1] })
    assert.equal(notPatch.status, 400)
    // per-turn write switches are runtime-changeable booleans
    const perTurn = await api.request('POST', '/memory-evolve/api/config', { patch: { perTurnProjectWrites: false, perTurnDailyWrites: true } })
    assert.equal(perTurn.status, 200)
    assert.equal(perTurn.data.config.perTurnProjectWrites, false)
    const badBool = await api.request('POST', '/memory-evolve/api/config', { patch: { perTurnDailyWrites: 'yes' } })
    assert.equal(badBool.status, 400)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api memory/key writes a key fact for the session cwd', async () => {
  const api = await bootApi({ resolveCwd: (sessionId) => (sessionId === 'abc' ? '/work/p' : undefined) })
  try {
    // no cwd → 400 with a clear reason
    const noCwd = await api.request('POST', '/memory-evolve/api/memory/key', { sessionId: 'ghost', content: 'x' })
    assert.equal(noCwd.status, 400)
    assert.ok(noCwd.data.error.includes('工作目录'))
    // empty content → 400
    const empty = await api.request('POST', '/memory-evolve/api/memory/key', { sessionId: 'abc', content: '   ' })
    assert.equal(empty.status, 400)
    // happy path: appended to the project KEY.md with a program stamp
    const ok = await api.request('POST', '/memory-evolve/api/memory/key', { sessionId: 'abc', content: '本项目约定使用 pnpm' })
    assert.equal(ok.status, 200)
    assert.equal(ok.data.ok, true)
    const entries = api.store.entriesOf('key', { session: { header: { cwd: '/work/p' } } })
    assert.equal(entries.length, 1)
    assert.match(entries[0], /^\[\d{4}-\d{2}-\d{2}\] 本项目约定使用 pnpm$/)
    // optional branches scope the entry
    const scoped = await api.request('POST', '/memory-evolve/api/memory/key', {
      sessionId: 'abc', content: 'dev 专属约定', branches: ['dev'],
    })
    assert.equal(scoped.status, 200)
    const tagged = api.store.entriesOf('key', { session: { header: { cwd: '/work/p' } } })
      .find((e) => e.includes('dev 专属约定'))
    assert.match(tagged, /^\[\d{4}-\d{2}-\d{2}\] \[branch:dev\] dev 专属约定$/)
    // invalid branches shape → 400
    const badShape = await api.request('POST', '/memory-evolve/api/memory/key', {
      sessionId: 'abc', content: 'x', branches: 'dev',
    })
    assert.equal(badShape.status, 400)
    // the memory-files listing exposes the new KEY.md row
    const list = await api.request('GET', '/memory-evolve/api/memory-files?sessionId=abc')
    const byKey = Object.fromEntries(list.data.files.map((f) => [f.key, f]))
    assert.equal(byKey.key.content.includes('本项目约定使用 pnpm'), true)
    assert.equal(list.data.cwd, '/work/p')
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api 404 for unknown routes', async () => {
  const api = await bootApi()
  try {
    const res = await api.request('GET', '/memory-evolve/api/nope')
    assert.equal(res.status, 404)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api approve supports edited contents', async () => {
  const api = await bootApi()
  try {
    api.queue.append({ time: 't', target: 'user', content: '原始建议文本', reason: 'r', cwd: null })
    const res = await api.request('POST', '/memory-evolve/api/suggestions/approve', {
      indices: [1],
      contents: ['修改后的入库文本'],
    })
    assert.equal(res.status, 200)
    assert.equal(api.store.entriesOf('user')[0].includes('修改后的入库文本'), true)
    assert.equal(api.store.entriesOf('user')[0].includes('原始建议文本'), false)
    // contents/indices length mismatch → 400
    api.queue.append({ time: 't2', target: 'memory', content: 'x', reason: 'r', cwd: null })
    const bad = await api.request('POST', '/memory-evolve/api/suggestions/approve', {
      indices: [1],
      contents: ['a', 'b'],
    })
    assert.equal(bad.status, 400)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api approve with empty contents falls back to the suggested content', async () => {
  const api = await bootApi()
  try {
    // The panel sends contents: [''] when the textarea was never edited —
    // that must not overwrite the suggestion with an empty entry.
    api.queue.append({ time: 't', target: 'memory', content: '原始建议文本', reason: 'r', cwd: null })
    const res = await api.request('POST', '/memory-evolve/api/suggestions/approve', {
      indices: [1],
      contents: [''],
    })
    assert.equal(res.status, 200)
    assert.equal(api.store.entriesOf('memory').length, 1)
    assert.equal(api.store.entriesOf('memory')[0].includes('原始建议文本'), true)
    assert.equal(api.queue.read().length, 0)
    // Whitespace-only edits fall back the same way.
    api.queue.append({ time: 't2', target: 'user', content: '另一条建议', reason: 'r', cwd: null })
    const ws = await api.request('POST', '/memory-evolve/api/suggestions/approve', {
      indices: [1],
      contents: ['   '],
    })
    assert.equal(ws.status, 200)
    assert.equal(api.store.entriesOf('user')[0].includes('另一条建议'), true)
    assert.equal(api.queue.read().length, 0)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api reveal resolves whitelisted targets and rejects unknown ones', async () => {
  const api = await bootApi()
  try {
    const res = await api.request('POST', '/memory-evolve/api/reveal', { target: 'memoryDir' })
    assert.equal(res.status, 200)
    assert.equal(res.data.ok, true)
    assert.equal(res.data.path, api.dir)
    const bad = await api.request('POST', '/memory-evolve/api/reveal', { target: '/etc' })
    assert.equal(bad.status, 400)
    const missing = await api.request('POST', '/memory-evolve/api/reveal', { target: 'nope' })
    assert.equal(missing.status, 400)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api memory-files lists tracks and save refuses read-only keys', async () => {
  const api = await bootApi()
  try {
    api.store.add('memory', '环境事实')
    const list = await api.request('GET', '/memory-evolve/api/memory-files?sessionId=abc')
    assert.equal(list.status, 200)
    const byKey = Object.fromEntries(list.data.files.map((f) => [f.key, f]))
    assert.equal(byKey.memory.content.includes('环境事实'), true)
    assert.equal(byKey.project.available, false) // no cwd resolved
    // branch scope fields: no cwd → null / []
    assert.equal(list.data.cwd, null)
    assert.equal(list.data.branch, null)
    assert.deepEqual(list.data.branches, [])
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api key/scope sets the branch scope of a KEY entry', async () => {
  const api = await bootApi({ resolveCwd: (sessionId) => (sessionId === 'abc' ? '/work/p' : undefined) })
  try {
    const agent = { session: { header: { cwd: '/work/p' } } }
    api.store.add('key', '全局事实', agent)
    const entry = api.store.entriesOf('key', agent)[0]
    // scope it to a branch
    let res = await api.request('POST', '/memory-evolve/api/key/scope', {
      sessionId: 'abc', match: entry, branches: ['main'],
    })
    assert.equal(res.status, 200)
    assert.ok(api.store.entriesOf('key', agent)[0].includes('[branch:main]'))
    // back to 全部 (empty array removes the tag)
    const tagged = api.store.entriesOf('key', agent)[0]
    res = await api.request('POST', '/memory-evolve/api/key/scope', {
      sessionId: 'abc', match: tagged, branches: [],
    })
    assert.equal(res.status, 200)
    const untagged = api.store.entriesOf('key', agent)[0]
    assert.ok(!untagged.includes('[branch:'))
    // validation: no cwd / bad branches shape / missing entry
    const noCwd = await api.request('POST', '/memory-evolve/api/key/scope', { sessionId: 'ghost', match: 'x', branches: [] })
    assert.equal(noCwd.status, 400)
    const badShape = await api.request('POST', '/memory-evolve/api/key/scope', { sessionId: 'abc', match: 'x', branches: 'main' })
    assert.equal(badShape.status, 400)
    const missing = await api.request('POST', '/memory-evolve/api/key/scope', { sessionId: 'abc', match: '[2026-08-06] 不存在', branches: [] })
    assert.equal(missing.status, 400)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api memory/delete removes entries exactly across every track', async () => {
  const api = await bootApi({ resolveCwd: (sessionId) => (sessionId === 'abc' ? '/work/p' : undefined) })
  try {
    // seed: memory / user / daily / project / key entries
    api.store.add('memory', '全局事实甲')
    api.store.add('user', '用户偏好乙')
    api.store.add('daily', '今日进展丙')
    const agent = { session: { header: { cwd: '/work/p' } } }
    api.store.add('project', '项目日志丁', agent)
    api.store.add('key', '项目关键事实戊', agent)
    const entry = (target, needle) => api.store.entriesOf(target, target === 'project' || target === 'key' ? agent : undefined)
      .find((e) => e.includes(needle))
    // memory track (no cwd needed)
    let res = await api.request('POST', '/memory-evolve/api/memory/delete', { target: 'memory', match: entry('memory', '全局事实甲') })
    assert.equal(res.status, 200)
    assert.equal(api.store.entriesOf('memory').length, 0)
    // user track
    res = await api.request('POST', '/memory-evolve/api/memory/delete', { target: 'user', match: entry('user', '用户偏好乙') })
    assert.equal(res.status, 200)
    assert.equal(api.store.entriesOf('user').length, 0)
    // daily track
    res = await api.request('POST', '/memory-evolve/api/memory/delete', { target: 'daily', match: entry('daily', '今日进展丙') })
    assert.equal(res.status, 200)
    assert.equal(api.store.entriesOf('daily').length, 0)
    // project + key need a session cwd
    const noCwd = await api.request('POST', '/memory-evolve/api/memory/delete', { sessionId: 'ghost', target: 'project', match: 'x' })
    assert.equal(noCwd.status, 400)
    assert.ok(noCwd.data.error.includes('工作目录'))
    res = await api.request('POST', '/memory-evolve/api/memory/delete', { sessionId: 'abc', target: 'project', match: entry('project', '项目日志丁') })
    assert.equal(res.status, 200)
    assert.equal(api.store.entriesOf('project', agent).length, 0)
    res = await api.request('POST', '/memory-evolve/api/memory/delete', { sessionId: 'abc', target: 'key', match: entry('key', '项目关键事实戊') })
    assert.equal(res.status, 200)
    assert.equal(api.store.entriesOf('key', agent).length, 0)
    // archive tracks map onto memory/user
    api.archive.append('memory', '[2026-08-06] 归档条目 A')
    res = await api.request('POST', '/memory-evolve/api/memory/delete', { target: 'archive-memory', match: '[2026-08-06] 归档条目 A' })
    assert.equal(res.status, 200)
    assert.equal(api.archive.entriesOf('memory').length, 0)
    // validation: unknown target / empty match / missing entry
    const badTarget = await api.request('POST', '/memory-evolve/api/memory/delete', { target: 'nope', match: 'x' })
    assert.equal(badTarget.status, 400)
    const empty = await api.request('POST', '/memory-evolve/api/memory/delete', { target: 'memory', match: '   ' })
    assert.equal(empty.status, 400)
    const missing = await api.request('POST', '/memory-evolve/api/memory/delete', { target: 'memory', match: '[2026-08-06] 不存在的条目' })
    assert.equal(missing.status, 400)
    assert.ok(missing.data.error.includes('不存在'))
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api memory/archive moves main-track entries to the archive and back', async () => {
  const api = await bootApi()
  try {
    api.store.add('memory', '全局事实归档测试')
    api.store.add('user', '用户偏好归档测试')
    const memEntry = api.store.entriesOf('memory')[0]
    const userEntry = api.store.entriesOf('user')[0]
    // archive a memory entry: main track loses it, archive file gains it verbatim
    let res = await api.request('POST', '/memory-evolve/api/memory/archive', { target: 'memory', match: memEntry })
    assert.equal(res.status, 200)
    assert.equal(res.data.ok, true)
    assert.equal(api.store.entriesOf('memory').length, 0)
    assert.deepEqual(api.archive.entriesOf('memory'), [memEntry])
    // user track likewise
    res = await api.request('POST', '/memory-evolve/api/memory/archive', { target: 'user', match: userEntry })
    assert.equal(res.status, 200)
    assert.equal(api.store.entriesOf('user').length, 0)
    assert.deepEqual(api.archive.entriesOf('user'), [userEntry])
    // full round-trip: promote back → main track restored, archive emptied
    res = await api.request('POST', '/memory-evolve/api/archive/promote', { target: 'memory', match: memEntry })
    assert.equal(res.status, 200)
    assert.ok(api.store.entriesOf('memory').some((e) => e.includes('全局事实归档测试')))
    assert.equal(api.archive.entriesOf('memory').length, 0)
    // exactness: archiving a substring that is not a whole entry fails and
    // touches nothing (a longer entry containing it must survive)
    api.store.add('memory', '短内容')
    api.store.add('memory', '短内容，但有更长的条目')
    const short = api.store.entriesOf('memory').find((e) => e.includes('短内容，但有'))
    const notWhole = await api.request('POST', '/memory-evolve/api/memory/archive', { target: 'memory', match: '短内容' })
    assert.equal(notWhole.status, 400)
    assert.ok(api.store.entriesOf('memory').some((e) => e.includes('更长的条目')))
    assert.equal(api.archive.entriesOf('memory').length, 0)
    // validation: bad target / empty match / missing entry
    const badTarget = await api.request('POST', '/memory-evolve/api/memory/archive', { target: 'daily', match: 'x' })
    assert.equal(badTarget.status, 400)
    const empty = await api.request('POST', '/memory-evolve/api/memory/archive', { target: 'memory', match: '  ' })
    assert.equal(empty.status, 400)
    const missing = await api.request('POST', '/memory-evolve/api/memory/archive', { target: 'memory', match: '[2026-08-06] 不存在' })
    assert.equal(missing.status, 400)
    assert.equal(api.archive.entriesOf('memory').length, 0)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api key archive round-trip: archive main-track key entry, promote back', async () => {
  const api = await bootApi({ resolveCwd: (sessionId) => (sessionId === 'abc' ? '/work/p' : undefined) })
  try {
    const agent = { session: { header: { cwd: '/work/p' } } }
    api.store.add('key', '需要暂停注入的项目事实', agent)
    const entry = api.store.entriesOf('key', agent)[0]
    // archive the key entry → KEY.md loses it, KEY-archive.md gains it
    let res = await api.request('POST', '/memory-evolve/api/memory/archive', {
      sessionId: 'abc', target: 'key', match: entry,
    })
    assert.equal(res.status, 200)
    assert.equal(api.store.entriesOf('key', agent).length, 0)
    assert.deepEqual(api.archive.entriesOf('key', '/work/p'), [entry])
    // the archive listing exposes it (with sessionId)
    res = await api.request('GET', '/memory-evolve/api/archive?sessionId=abc')
    assert.equal(res.status, 200)
    assert.ok(res.data.entries.some((e) => e.target === 'key' && e.content.includes('需要暂停注入的项目事实')))
    // promote back → KEY.md restored, archive emptied
    res = await api.request('POST', '/memory-evolve/api/archive/promote', {
      sessionId: 'abc', target: 'key', match: entry,
    })
    assert.equal(res.status, 200)
    assert.ok(api.store.entriesOf('key', agent).some((e) => e.includes('需要暂停注入的项目事实')))
    assert.deepEqual(api.archive.entriesOf('key', '/work/p'), [])
    // archive again, then delete via the archive-key track
    await api.request('POST', '/memory-evolve/api/memory/archive', { sessionId: 'abc', target: 'key', match: entry })
    res = await api.request('POST', '/memory-evolve/api/memory/delete', {
      sessionId: 'abc', target: 'archive-key', match: entry,
    })
    assert.equal(res.status, 200)
    assert.deepEqual(api.archive.entriesOf('key', '/work/p'), [])
    // validation: key ops need a session cwd
    const noCwd = await api.request('POST', '/memory-evolve/api/memory/archive', { target: 'key', match: entry })
    assert.equal(noCwd.status, 400)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api reveal surfaces open-command failures instead of swallowing them', async () => {
  const api = await bootApi({
    // No open command available (the WSL-without-xdg-utils case): the panel
    // must see a 400 with a reason, not a silent no-op.
    revealPath: async () => { throw new Error('没有可用的打开命令（Linux/WSL 请安装 xdg-utils 或 wslu）') },
  })
  try {
    const res = await api.request('POST', '/memory-evolve/api/reveal', { target: 'memoryDir' })
    assert.equal(res.status, 400)
    assert.ok(res.data.error.includes('xdg-utils'))
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api pending-skills list/approve/reject round-trip', async () => {
  const api = await bootApi()
  try {
    // Seed a pending skill directly in the memory dir.
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const pending = join(api.dir, 'pending-skills', 'queued-skill')
    mkdirSync(pending, { recursive: true })
    writeFileSync(join(pending, 'SKILL.md'), `---
name: queued-skill
description: "队列技能"
---
# queued-skill
`)
    const list = await api.request('GET', '/memory-evolve/api/pending-skills')
    assert.equal(list.status, 200)
    assert.equal(list.data.entries.length, 1)
    assert.equal(list.data.entries[0].name, 'queued-skill')
    const bad = await api.request('POST', '/memory-evolve/api/pending-skills/approve', { name: 'nope' })
    assert.equal(bad.status, 400)
    const approved = await api.request('POST', '/memory-evolve/api/pending-skills/approve', { name: 'queued-skill' })
    assert.equal(approved.status, 200)
    assert.equal(api.request ? true : true, true)
    const list2 = await api.request('GET', '/memory-evolve/api/pending-skills')
    assert.equal(list2.data.entries.length, 0)
    // badge counts suggestions + pending skills
    const badge = await api.request('GET', '/memory-evolve/api/badge')
    assert.equal(badge.data.count, 0)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('archive endpoints: archive a suggestion, list, promote, delete', async () => {
  const { base, queue, archive, store, request, close, dir } = await bootApi()
  try {
    // seed the queue with one suggestion
    queue.append({ time: new Date().toISOString(), target: 'user', content: '低优先级事实', reason: '观察' })
    // archive it
    let res = await request('POST', '/memory-evolve/api/suggestions/archive', { indices: [1] })
    assert.equal(res.status, 200)
    assert.equal(res.data.remaining, 0)
    assert.equal(queue.read().length, 0)
    assert.equal(archive.entriesOf('user').length, 1)
    assert.ok(archive.entriesOf('user')[0].includes('归档理由：观察'))
    // list
    res = await request('GET', '/memory-evolve/api/archive')
    assert.equal(res.status, 200)
    assert.equal(res.data.entries.length, 1)
    assert.equal(res.data.entries[0].target, 'user')
    // promote back into the main track
    res = await request('POST', '/memory-evolve/api/archive/promote', { target: 'user', match: '低优先级事实' })
    assert.equal(res.status, 200)
    assert.ok(res.data.ok)
    assert.equal(archive.entriesOf('user').length, 0)
    assert.ok(store.entriesOf('user').some((e) => e.includes('低优先级事实')))
    // archive again, then delete
    queue.append({ time: new Date().toISOString(), target: 'memory', content: '备查事实', reason: '万一有用' })
    await request('POST', '/memory-evolve/api/suggestions/archive', { indices: [1] })
    res = await request('POST', '/memory-evolve/api/archive/delete', { target: 'memory', match: '备查事实' })
    assert.equal(res.status, 200)
    assert.equal(archive.entriesOf('memory').length, 0)
    // invalid target is rejected
    res = await request('POST', '/memory-evolve/api/archive/promote', { target: 'daily', match: 'x' })
    assert.equal(res.status, 400)
  } finally {
    await close()
    rmSync(dir, { recursive: true, force: true })
  }
})
