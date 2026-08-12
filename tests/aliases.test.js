/**
 * 会话别名（aliases.json）测试：AliasStore + 快照「你的会话」段 + 主 API。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AliasStore, readAliases } from '../lib/aliases.js'
import { resolveConfig, renderSnapshot } from '../lib/index.js'
import { MemoryStore } from '../lib/store.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-alias-test-'))
}

test('aliases store: set/get/remove/10 字上限/清空', () => {
  const dir = tempDir()
  const store = new AliasStore(dir)
  assert.equal(store.get('sA'), undefined, '初始无别名')
  // 设置
  assert.equal(store.set('sA', '小明').ok, true)
  assert.equal(store.get('sA'), '小明')
  // 覆盖
  store.set('sA', '小明2')
  assert.equal(store.get('sA'), '小明2')
  // 10 字上限
  assert.equal(store.set('sA', '一二三四五六七八九十一').ok, false, '超过 10 字拒绝')
  // 清空（空串 = 移除）
  assert.equal(store.set('sA', '  ').ok, true)
  assert.equal(store.get('sA'), undefined, '清空后无别名')
  // 全部
  store.set('sA', '甲')
  store.set('sB', '乙')
  assert.deepEqual(store.all(), { sA: '甲', sB: '乙' })
  // readAliases 文件直读（live-read：API 写入即时可见）
  assert.deepEqual(readAliases(dir), { sA: '甲', sB: '乙' })
  // 文件缺失/损坏 → 空表
  const dir2 = tempDir()
  writeFileSync(join(dir2, 'aliases.json'), 'not-json{')
  assert.deepEqual(readAliases(dir2), {})
  rmSync(dir2, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

test('snapshot: 有别名注入「你的会话别名」行，无别名不注入', () => {
  const dir = tempDir()
  const config = resolveConfig({ memoryDir: dir })
  const store = new MemoryStore(dir, config)
  const agent = { session: { id: 'sessA', header: { cwd: '/p' } } }
  // 无别名：只有 ID 行
  const snap1 = renderSnapshot(config, store, agent)
  assert.ok(snap1.includes('你的会话 ID：sessA'))
  assert.ok(!snap1.includes('你的会话别名'), '无别名不注入别名行')
  // 设别名后：别名 + ID 都注入（AI 知道自己的友好名称）
  new AliasStore(dir).set('sessA', '小明')
  const snap2 = renderSnapshot(config, store, agent)
  assert.ok(snap2.includes('你的会话别名：小明'), '注入别名行（拟人化）')
  assert.ok(snap2.includes('你的会话 ID：sessA'), 'ID 仍注入（发消息要用）')
  // 会话名称（2026-08-12 用户要求）：有名称注入「你的会话名称」行，
  // 与别名并存；没有名称/别名时输出与旧版一致（只有 ID，零变化兼容）
  const fakeTitle = { get: (session) => (session.id === 'sessA' ? { title: '登录页开发' } : undefined) }
  const snap3 = renderSnapshot(config, store, agent, undefined, null, null, null, fakeTitle)
  assert.ok(snap3.includes('你的会话名称：登录页开发'), '有名称注入名称行')
  assert.ok(snap3.includes('你的会话别名：小明'), '名称与别名并存')
  // 名称服务不可用/无标题（未传 service）→ 不注入名称行（兼容降级）
  const snap4 = renderSnapshot(config, store, agent)
  assert.ok(!snap4.includes('你的会话名称'), '无名称服务不注入名称行')
  // 名称服务返回无标题 → 也不注入（有别名仍显示别名+ID）
  const emptyTitle = { get: () => undefined }
  const snap5 = renderSnapshot(config, store, agent, undefined, null, null, null, emptyTitle)
  assert.ok(!snap5.includes('你的会话名称'), '无标题不注入名称行')
  assert.ok(snap5.includes('你的会话别名：小明'), '别名不受影响')
  rmSync(dir, { recursive: true, force: true })
})

test('aliases api: GET 全量 / PUT 设置（校验）/ DELETE 清除', async () => {
  const dir = tempDir()
  const store = new MemoryStore(dir)
  const archive = new (await import('../lib/store.js')).ArchiveStore(dir)
  const queue = new (await import('../lib/store.js')).SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
  const todoStore = new (await import('../lib/todo.js')).TodoStore(dir)
  const state = { reviewEnabled: true }
  const { installApi } = await import('../lib/api.js')
  const ctx = { webServer: { register: ({ handler }) => { ctx.handler = handler; return () => {} } } }
  installApi(ctx, {
    store, archive, queue, todoStore,
    config: { memoryDir: dir },
    getRuntime: () => ({ ...state }),
    updateRuntime: (patch) => Object.assign(state, patch),
    resolveRevealTarget: () => undefined,
    revealPath: () => {},
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
  try {
    // PUT 设置
    const put = await request('PUT', '/memory-evolve/api/aliases/sessA', { name: '小明' })
    assert.equal(put.status, 200)
    assert.equal(put.data.ok, true)
    // GET 全量
    const get = await request('GET', '/memory-evolve/api/aliases')
    assert.deepEqual(get.data.aliases, { sessA: '小明' })
    // PUT 超长拒绝
    const bad = await request('PUT', '/memory-evolve/api/aliases/sessA', { name: '一二三四五六七八九十一' })
    assert.equal(bad.status, 400)
    assert.match(bad.data.message, /最多/)
    // DELETE 清除
    const del = await request('DELETE', '/memory-evolve/api/aliases/sessA')
    assert.equal(del.data.ok, true)
    assert.deepEqual((await request('GET', '/memory-evolve/api/aliases')).data.aliases, {})
  } finally {
    await new Promise((resolve) => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})
