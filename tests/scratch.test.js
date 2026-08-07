import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('scratch read: 外部写入的超大文件拒绝读取（返回 error，不吐内容）', () => {
  const dir = tempDir()
  try {
    const config = makeConfig(dir)
    const path = scratchPath(config)
    // 模拟外部编辑器（reveal 通道）绕过 writeScratch 写入超大文件
    writeFileSync(path, Buffer.alloc(SCRATCH_MAX_BYTES + 1, 0x61))
    const read = readScratch(config)
    assert.equal(read.content, '')
    assert.ok(read.error && read.error.includes('大小上限'), `error 应提示超上限：${read.error}`)
    assert.equal(read.size, SCRATCH_MAX_BYTES + 1)
    // 正常文件不受影响
    writeScratch(config, '正常内容')
    const ok = readScratch(config)
    assert.equal(ok.content, '正常内容')
    assert.equal(ok.error, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scratch read: 非 UTF-8 内容拒绝读取（避免乱码被覆盖写回）', () => {
  const dir = tempDir()
  try {
    const config = makeConfig(dir)
    const path = scratchPath(config)
    // 模拟外部编辑器以非 UTF-8 编码保存：非法 UTF-8 字节序列
    writeFileSync(path, Buffer.from([0x63, 0x63, 0xc3, 0x28, 0x21])) // 'cc' + 非法序列 + '!'
    const read = readScratch(config)
    assert.equal(read.content, '')
    assert.ok(read.error && read.error.includes('UTF-8'), `error 应提示编码问题：${read.error}`)
    // 合法 UTF-8（含多字节中文）不受影响
    writeScratch(config, '中文便签 ✓')
    const ok = readScratch(config)
    assert.equal(ok.content, '中文便签 ✓')
    assert.equal(ok.error, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scratch write: 同名 tmp 残留被清理（崩溃残留不堆积）', () => {
  const dir = tempDir()
  try {
    const config = makeConfig(dir)
    const path = scratchPath(config)
    const tmpPath = `${path}.tmp.${process.pid}`
    // 模拟上次写入中途崩溃留下的残留
    writeFileSync(tmpPath, '残留垃圾')
    writeScratch(config, '新内容')
    assert.equal(existsSync(tmpPath), false, '写入后旧 tmp 残留应被清理')
    assert.equal(readScratch(config).content, '新内容')
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

test('scratch api: 换行密集的合法内容不再被 readBody 提前拒绝（JSON 转义放大）', async () => {
  const dir = tempDir()
  const api = await bootApi(dir)
  try {
    // 内容 400 KB、一半是换行：JSON 序列化后 body ≈ 600 KB，旧实现的
    // 「内容上限 + 1024」body 上限会误拒（body too large）；content 本身
    // 400 KB < 512 KiB 完全合法，应保存成功。
    const content = 'x\n'.repeat(200 * 1024) // 400000 字节
    assert.ok(Buffer.byteLength(content, 'utf8') < SCRATCH_MAX_BYTES)
    const saved = await api.request('POST', '/memory-evolve/api/scratch', { content })
    assert.equal(saved.status, 200)
    assert.equal(saved.data.ok, true)
    assert.equal(readScratch(makeConfig(dir)).content, content)
  } finally {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scratch api: 内容超过 writeScratch 上限 → 400 且由内容校验拦截（非 body 上限）', async () => {
  const dir = tempDir()
  const api = await bootApi(dir)
  try {
    // 600 KB 纯字符：body ≈ 614 KB < 4 MiB（readBody 放行），由
    // writeScratch 的内容字节数校验拒绝——错误信息应指向内容超限。
    const content = 'x'.repeat(SCRATCH_MAX_BYTES + 64 * 1024)
    const saved = await api.request('POST', '/memory-evolve/api/scratch', { content })
    assert.equal(saved.status, 400)
    assert.ok(saved.data.error.includes('超过上限'), `应提示内容超上限：${saved.data.error}`)
    // 原文件未被破坏
    assert.equal(readScratch(makeConfig(dir)).content, '')
  } finally {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scratch api: GET 透传读取拒绝（超大/非 UTF-8 返回 error 而非内容）', async () => {
  const dir = tempDir()
  const api = await bootApi(dir)
  try {
    // 超大文件
    writeFileSync(join(dir, 'scratch.md'), Buffer.alloc(SCRATCH_MAX_BYTES + 1, 0x61))
    const big = await api.request('GET', '/memory-evolve/api/scratch')
    assert.equal(big.status, 200)
    assert.equal(big.data.content, '')
    assert.ok(big.data.error && big.data.error.includes('大小上限'))
    // 非 UTF-8
    writeFileSync(join(dir, 'scratch.md'), Buffer.from([0x63, 0xc3, 0x28]))
    const bad = await api.request('GET', '/memory-evolve/api/scratch')
    assert.equal(bad.status, 200)
    assert.equal(bad.data.content, '')
    assert.ok(bad.data.error && bad.data.error.includes('UTF-8'))
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
