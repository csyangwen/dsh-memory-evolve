// 工具层输出契约静态锁（2026-09-24 审计批次 1 · A①）。
//
// 缺陷背景：宿主对 memory 工具输出做 additionalProperties:false 校验，
// 返回对象里任何未在 output schema 声明的字段都会整单拒绝（写盘已发生
// 但模型只见报错）。已修两例：retag 的 entry（1d2534f）、add 去重路径的
// duplicate（本批）。store 层返回的内部簿记字段必须在 outcomeOnly 剥除
// 清单里逐一声明——本文件用静态源码契约锁住该清单，防止后续新增簿记
// 字段时漏剥（假宿主测试不校验输出 schema，只有生产宿主能抓）。
// 直跑：node tests/tool-output-contract.test.js（沙箱禁 node --test runner）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryStore, parseEntries } from '../lib/store.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

test('①静态契约：outcomeOnly 必须剥除内部簿记字段（entries/removed/matches/duplicate）', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8')
  const start = src.indexOf('function outcomeOnly')
  assert.notEqual(start, -1, 'outcomeOnly 未找到')
  const body = src.slice(start, src.indexOf('}', src.indexOf('...', start)) + 1)
  // 解构剥除清单必须包含全部四个已知簿记字段；新增字段时此断言提醒同步
  assert.match(body, /\{\s*entries,\s*removed,\s*matches,\s*duplicate,\s*\.\.\.rest\s*\}/,
    'outcomeOnly 解构清单必须含 duplicate（2026-09-24 审计 P0）——新增簿记字段时请同步此清单与本断言')
})

test('②行为契约：同日重复 add 返回对象不含 duplicate 键（ok=true 静默去重）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-outcontract-test-'))
  try {
    writeFileSync(join(dir, 'MEMORY.md'), '')
    const store = new MemoryStore(dir)
    const first = store.add('memory', '重复内容测试', undefined)
    assert.equal(first.ok, true, first.message)
    // store 层 duplicate:true 是内部簿记；模拟 outcomeOnly 的剥除（同款解构）
    const outcome = ({ entries, removed, matches, duplicate, ...rest }) => rest
    const second = store.add('memory', '重复内容测试', undefined)
    const toolResult = outcome(second)
    assert.equal(toolResult.ok, true, '去重路径 ok=true（静默跳过写入）')
    assert.equal('duplicate' in toolResult, false, '工具层结果不得携带 duplicate 键')
    assert.equal('entries' in toolResult, false, '工具层结果不得携带 entries 键')
    assert.equal(parseEntries(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).length, 1, '磁盘只有一条')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
