import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDigest } from '../lib/digest.js'

function sessionWith(events) {
  return { events }
}

test('digest renders events in order', () => {
  const session = sessionWith([
    { type: 'turn/start', data: { turn: 1, trigger: { kind: 'message' } } },
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '你好' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '你好！' }] } } },
    { type: 'tool/call', data: { name: 'bash', arguments: '{"cmd":"ls"}' } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const digest = buildDigest(session, {})
  assert.ok(digest.includes('turn 1'))
  assert.ok(digest.includes('用户: 你好'))
  assert.ok(digest.includes('助手: 你好！'))
  assert.ok(digest.includes('工具调用: bash'))
  assert.ok(digest.includes('工具结果: 成功'))
  assert.ok(!digest.includes('ok')) // tool output hidden by default
})

test('digest includes tool output when asked', () => {
  const session = sessionWith([
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'secret output' }] }, error: undefined } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'boom' }] }, error: { code: 'E2BIG' } } },
  ])
  const digest = buildDigest(session, { includeToolOutput: true })
  assert.ok(digest.includes('secret output'))
  assert.ok(digest.includes('失败(E2BIG)'))
})

test('digest keeps only the tail and caps total chars', () => {
  const events = Array.from({ length: 40 }, (_, i) => ({
    type: 'user/message',
    data: { message: { content: [{ type: 'text', text: `m${i}` }] } },
  }))
  const tail = buildDigest(sessionWith(events), { maxEvents: 10 })
  assert.ok(tail.includes('m39'))
  assert.ok(!tail.includes('m0'))
  const capped = buildDigest(sessionWith(events), { maxEvents: 40, maxChars: 100 })
  assert.ok(capped.length <= 100 + '…(前面部分已省略)…\n'.length)
  assert.ok(capped.includes('m39')) // the newest tail survives truncation
})

test('digest handles missing session', () => {
  assert.equal(buildDigest(undefined, {}), '')
  assert.equal(buildDigest({}, {}), '')
})

test('digest truncates long messages', () => {
  const long = 'x'.repeat(2000)
  const session = sessionWith([
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: long }] } } },
  ])
  const digest = buildDigest(session, {})
  assert.ok(digest.length < long.length)
  assert.ok(digest.endsWith('…'))
})
