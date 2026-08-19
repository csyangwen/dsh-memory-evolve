import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { memoryTool } from '../lib/index.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-mem-evolve-test-'))
}

/** 最小 memory 工具环境（entries 批量只走 daily/project，不触碰 approval/queue/archive）。 */
function setup() {
  const dir = tempDir()
  const store = new MemoryStore(dir)
  const tool = memoryTool(
    { get: () => undefined }, // ctx
    { toolName: 'memory' },   // config
    store,
    {},                      // queue（key 轨确认队列，entries 用不到）
    () => ({}),              // getRuntime
    {},                      // archive
  )
  const agent = { session: { header: { cwd: join(dir, 'proj') } } }
  return { dir, store, tool, agent }
}

/** 模拟 DSH 的无损 JSON 安检：往返序列化不丢字段、无 undefined/NaN/Infinity。 */
function lossless(value) {
  const s = JSON.stringify(value)
  assert.ok(!/undefined|NaN|Infinity/.test(s), `value contains non-lossless tokens: ${s}`)
  assert.deepEqual(JSON.parse(s), value)
}

test('entries 多轨批量：单轨抛异常时其余轨道照常写入、失败被记录、返回无损', async () => {
  const { dir, store, tool, agent } = setup()
  const origAdd = store.add.bind(store)
  // 让 project 轨写入抛异常（模拟锁文件删除失败等意外）
  store.add = (target, content, a) => {
    if (String(content).includes('BOOM')) throw new Error('模拟锁文件删除失败: .memory.lock')
    return origAdd(target, content, a)
  }
  const exec = { agent }
  // 修复前：循环在 project 轨中断（daily 已写但结果丢失、返回值含 undefined）→ 断言失败；
  // 修复后：单轨失败被记录、循环继续、两轨结果齐全。
  const result = await tool.execute(
    { action: 'add', entries: [
      { target: 'daily', content: '正常轨写入' },
      { target: 'project', content: 'BOOM 触发异常' },
    ] },
    exec,
  )
  assert.equal(result.ok, false)
  assert.equal(result.multi.length, 2, '两轨结果都必须返回，不能丢轨道')
  const daily = result.multi.find((m) => m.target === 'daily')
  const project = result.multi.find((m) => m.target === 'project')
  assert.equal(daily.ok, true)
  assert.equal(project.ok, false)
  assert.match(project.message, /写入异常/, '失败原因必须给 LLM 看到')
  assert.equal(store.entriesOf('daily').length, 1, '正常轨必须真实落盘')
  lossless(result)
  rmSync(dir, { recursive: true, force: true })
})

test('entries 多轨批量：全部正常时 allOk 为 true 且返回无损', async () => {
  const { dir, store, tool, agent } = setup()
  const exec = { agent }
  const result = await tool.execute(
    { action: 'add', entries: [
      { target: 'daily', content: '第一轨' },
      { target: 'project', content: '第二轨' },
    ] },
    exec,
  )
  assert.equal(result.ok, true)
  assert.equal(result.multi.length, 2)
  assert.ok(result.multi.every((m) => m.ok))
  assert.equal(store.entriesOf('daily').length, 1)
  assert.equal(store.entriesOf('project', agent).length, 1)
  lossless(result)
  rmSync(dir, { recursive: true, force: true })
})
