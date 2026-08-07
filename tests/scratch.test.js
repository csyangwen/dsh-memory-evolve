import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readScratch, writeScratch, scratchPath, SCRATCH_MAX_BYTES } from '../lib/scratch.js'
import { installApi } from '../lib/api.js'
import { resolveRevealTarget } from '../lib/index.js'
import { ArchiveStore, MemoryStore, SuggestionQueue } from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-scratch-test-'))
}

function makeConfig(dir) {
  return { memoryDir: dir, skillDir: join(dir, 'skills') }
}

/** Boot a real HTTP server over installApi's handler（与 api.test.js 同款）。 */
async function bootApi(dir) {
  const store = new MemoryStore(dir)
  const archive = new ArchiveStore(dir)
  const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
  const todoStore = new TodoStore(dir)
  const state = { reviewEnabled: false }
  const getRuntime = () => ({ ...state })
  const updateRuntime = (patch) => Object.assign(state, patch) && { ...state }
  const ctx = {
    httpServer: { register: ({ handler }) => { ctx.handler = handler; return () => {} } },
  }
  installApi(ctx, {
    store, archive, queue, todoStore, getRuntime, updateRuntime,
    resolveRevealTarget: () => undefined,
    revealPath: () => {},
    config: makeConfig(dir),
    resolveCwd: () => undefined,
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
  return { base, request, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('scratch read/write: 文件不存在时读空，写入后原子落盘可读回', () => {
  const dir = tempDir()
  try {
    const config = makeConfig(dir)
    const path = scratchPath(config)
    assert.equal(path, join(dir, 'scratch.md'))
    // 首次读取：文件不存在 → 空内容，且不预创建文件
    const empty = readScratch(config)
    assert.equal(empty.content, '')
    assert.equal(empty.size, 0)
    assert.equal(empty.mtime, null)
    assert.equal(existsSync(path), false)
    // 写入 → 原子落盘（无残留 tmp），读回一致
    const markdown = '# 临时想法\n\n- [ ] 调研 X\n\n`code` 片段\n'
    const written = writeScratch(config, markdown)
    assert.equal(written.ok, true)
    assert.equal(written.chars, markdown.length)
    assert.equal(written.size, Buffer.byteLength(markdown, 'utf8'))
    assert.equal(existsSync(path), true)
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), [])
    const read = readScratch(config)
    assert.equal(read.content, markdown)
    assert.equal(read.size, written.size)
    assert.equal(typeof read.mtime, 'number')
    // 覆盖写入：内容整体替换
    writeScratch(config, '第二条内容')
    assert.equal(readScratch(config).content, '第二条内容')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scratch write: 大小上限与类型校验', () => {
  const dir = tempDir()
  try {
    const config = makeConfig(dir)
    assert.throws(() => writeScratch(config, 'x'.repeat(SCRATCH_MAX_BYTES + 1)), /超过上限/)
    assert.throws(() => writeScratch(config, 123), /必须是字符串/)
    // 刚好在上限内可以写
    assert.equal(writeScratch(config, 'x'.repeat(SCRATCH_MAX_BYTES)).ok, true)
    // 空字符串 = 清空便签，合法
    assert.equal(writeScratch(config, '').ok, true)
    assert.equal(readScratch(config).content, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scratch api: GET 空 / POST 写入 / GET 读回 / 非法请求', async () => {
  const dir = tempDir()
  const api = await bootApi(dir)
  try {
    // GET：未写入过 → 空内容
    const first = await api.request('GET', '/memory-evolve/api/scratch')
    assert.equal(first.status, 200)
    assert.equal(first.data.content, '')
    assert.equal(first.data.size, 0)
    assert.ok(typeof first.data.path === 'string')
    // POST：写入
    const content = '# 随手记\n\n- 想法 A\n- 想法 B\n'
    const saved = await api.request('POST', '/memory-evolve/api/scratch', { content })
    assert.equal(saved.status, 200)
    assert.equal(saved.data.ok, true)
    assert.equal(saved.data.chars, content.length)
    assert.equal(typeof saved.data.mtime, 'number')
    // GET：读回一致，且真实落盘在 memoryDir/scratch.md
    const read = await api.request('GET', '/memory-evolve/api/scratch')
    assert.equal(read.data.content, content)
    assert.equal(readFileSync(join(dir, 'scratch.md'), 'utf8'), content)
    // POST 空内容 = 清空
    const cleared = await api.request('POST', '/memory-evolve/api/scratch', { content: '' })
    assert.equal(cleared.status, 200)
    assert.equal((await api.request('GET', '/memory-evolve/api/scratch')).data.content, '')
  } finally {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scratch reveal target: scratchFile 解析到 memoryDir/scratch.md', () => {
  const dir = tempDir()
  try {
    const config = makeConfig(dir)
    // 文件不存在时 fallback 到记忆目录（现有 resolveRevealTarget 语义）
    assert.equal(resolveRevealTarget(config, 'scratchFile'), dir)
    writeScratch(config, '# hi')
    assert.equal(resolveRevealTarget(config, 'scratchFile'), join(dir, 'scratch.md'))
    // 未知目标不受影响
    assert.equal(resolveRevealTarget(config, 'nope'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
