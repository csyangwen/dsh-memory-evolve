// memory_search 字面兜底（2026-10-16）——守护进程不可用/语义零命中时回落
// deps.literalScan 扫记忆文件本体。daemon 文件指向不存在路径即可触发
// NO_DAEMON_FILE 失败路径（无需 mock socket）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memorySearchToolDefinition, renderSearchResult } from '../lib/mflow-search.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-fallback-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

function failingConfig(dir) {
  return { mflowDaemonFile: join(dir, 'no-such-daemon.json') }
}

const tool = (config, deps) => memorySearchToolDefinition(config, undefined, deps)

test('daemon 不可用 + literalScan 命中 → fallback-literal 输出', async () => {
  const dir = tempDir()
  const def = tool(failingConfig(dir), {
    literalScan: (query, limit) => {
      assert.equal(query, 'decay fallbackCount') // execute 已 trim
      assert.equal(limit, 5) // clampLimit 缺省
      return [
        { track: 'memory', entry: '[id:ab12cd34] [2026-10-16] decay fallbackCount 语义档案正文', entryId: 'memory:ab12cd34' },
        { track: 'daily', entry: 'x'.repeat(900), entryId: '' },
      ]
    },
  })
  const out = await def.execute({ query: ' decay fallbackCount ' }, undefined)
  assert.equal(out.ok, true)
  assert.equal(out.mode, 'fallback-literal')
  assert.equal(out.count, 2)
  assert.equal(out.results[0].entry_id, 'memory:ab12cd34')
  assert.equal(out.results[0].source, 'literal:memory')
  assert.equal(out.results[0].match_distance, -1)
  assert.equal(out.results[1].content.length, 801) // 800 + 省略号
  assert.equal(out.results[1].content.endsWith('…'), true)
  clean(dir)
})

test('daemon 不可用 + literalScan 零命中 → 原失败返回', async () => {
  const dir = tempDir()
  const def = tool(failingConfig(dir), { literalScan: () => [] })
  const out = await def.execute({ query: '任何词' }, undefined)
  assert.equal(out.ok, false)
  assert.equal(out.error, 'NO_DAEMON_FILE')
  clean(dir)
})

test('literalScan 抛异常 → 原失败返回（fail-open，兜底自身不抛）', async () => {
  const dir = tempDir()
  const def = tool(failingConfig(dir), {
    literalScan: () => { throw new Error('scan exploded') },
  })
  const out = await def.execute({ query: '任何词' }, undefined)
  assert.equal(out.ok, false)
  assert.equal(out.error, 'NO_DAEMON_FILE')
  clean(dir)
})

test('未注入 literalScan → 行为与旧版完全一致（失败返回）', async () => {
  const dir = tempDir()
  const def = tool(failingConfig(dir), undefined)
  const out = await def.execute({ query: '任何词' }, undefined)
  assert.equal(out.ok, false)
  clean(dir)
})

test('空 query 不触发兜底', async () => {
  const dir = tempDir()
  let called = 0
  const def = tool(failingConfig(dir), { literalScan: () => { called += 1; return [] } })
  const out = await def.execute({ query: '   ' }, undefined)
  assert.equal(out.ok, false)
  assert.equal(called, 0)
  clean(dir)
})

test('renderSearchResult 认得 fallback-literal 模式标签', () => {
  const rendered = renderSearchResult({
    ok: true, mode: 'fallback-literal', query: 'q', count: 1, elapsed_s: 0,
    results: [{ content: '正文', source: 'literal:memory', dataset: '', entry_id: 'memory:ab12cd34', match_distance: -1, score: -1 }],
  })
  assert.match(rendered, /^语义检索·字面兜底/)
  assert.match(rendered, /entry_id=memory:ab12cd34/)
})
