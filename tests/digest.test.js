import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDigest } from '../lib/digest.js'

function sessionWith(events) {
  return { events }
}

// DSH shapes: user/message carries the message as `data` itself (content
// blocks at data.content), assistant/message wraps it in data.message. A
// user message's `source` distinguishes direct human input (kind 'user')
// from system-injected user-role content (kind 'plugin' etc.).
function userMsg(text) {
  return {
    type: 'user/message',
    data: { id: `m-${text}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

function assistantMsg(turn, text) {
  return {
    type: 'assistant/message',
    data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }
}

function chunk(text) {
  return { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text } } }
}

test('digest renders messages in order with turn markers', () => {
  const session = sessionWith([
    { type: 'turn/start', data: { turn: 1, trigger: { kind: 'message' } } },
    userMsg('你好'),
    assistantMsg(1, '你好！'),
    { type: 'tool/call', data: { name: 'bash', arguments: '{"cmd":"ls"}' } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 2, trigger: { kind: 'message' } } },
    userMsg('继续'),
    assistantMsg(2, '好的'),
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ])
  const digest = buildDigest(session, {})
  assert.ok(digest.includes('=== turn 1 ==='))
  assert.ok(digest.includes('=== turn 2 ==='))
  assert.ok(digest.includes('用户: 你好'))
  assert.ok(digest.includes('助手: 你好！'))
  assert.ok(digest.includes('用户: 继续'))
  assert.ok(digest.includes('助手: 好的'))
  assert.ok(!digest.includes('工具调用'))
  assert.ok(!digest.includes('工具结果'))
})

test('digest never contains tool or reasoning content', () => {
  const session = sessionWith([
    { type: 'turn/start', data: { turn: 1, trigger: { kind: 'message' } } },
    userMsg('跑一下测试'),
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '让我想想怎么跑' },
            { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' },
          ],
        },
      },
    },
    { type: 'tool/call', data: { name: 'bash', arguments: '{"cmd":"ls"}' } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'secret output' }] } } },
    {
      type: 'assistant/message',
      data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '跑完了' }] } },
    },
  ])
  const digest = buildDigest(session, {})
  assert.ok(digest.includes('用户: 跑一下测试'))
  assert.ok(digest.includes('助手: 跑完了'))
  assert.ok(!digest.includes('bash'))
  assert.ok(!digest.includes('工具'))
  assert.ok(!digest.includes('让我想想')) // reasoning never enters
  assert.ok(!digest.includes('secret')) // tool output never enters
})

test('digest tolerates the wrapped user/message shape', () => {
  const session = sessionWith([
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '你好' }] }, source: { kind: 'user' } } },
  ])
  const digest = buildDigest(session, {})
  assert.ok(digest.includes('用户: 你好'))
})

test('digest skips system-injected user-role messages', () => {
  const session = sessionWith([
    { type: 'turn/start', data: { turn: 1, trigger: { kind: 'message' } } },
    userMsg('真实的用户输入'),
    {
      type: 'user/message',
      data: { id: 'inject-1', role: 'user', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes…' }] },
    },
    {
      type: 'user/message',
      data: { id: 'inject-2', role: 'user', source: { kind: 'workspace-instructions', baseline: true }, content: [{ type: 'text', text: '<system-reminder> workspace instructions…' }] },
    },
    assistantMsg(1, '回答'),
  ])
  const digest = buildDigest(session, {})
  assert.ok(digest.includes('真实的用户输入'))
  assert.ok(!digest.includes('Current runtime context'))
  assert.ok(!digest.includes('<system-reminder>'))
})

test('digest quota counts messages, not streaming chunk events', () => {
  // A streaming turn floods the log with chunk events; the quota must still
  // cover every real message, not just the closing chunks of one reply.
  const events = [
    { type: 'turn/start', data: { turn: 1, trigger: { kind: 'message' } } },
    userMsg('第一轮问题'),
    assistantMsg(1, '第一轮回答'),
    ...Array.from({ length: 500 }, (_, i) => chunk(`chunk-${i}`)),
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 2, trigger: { kind: 'message' } } },
    userMsg('第二轮问题'),
    assistantMsg(2, '第二轮回答'),
    ...Array.from({ length: 500 }, (_, i) => chunk(`chunk-${i}`)),
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  const digest = buildDigest(sessionWith(events), { maxEvents: 24 })
  assert.ok(digest.includes('第一轮问题'))
  assert.ok(digest.includes('第一轮回答'))
  assert.ok(digest.includes('第二轮问题'))
  assert.ok(digest.includes('第二轮回答'))
  assert.ok(!digest.includes('chunk-')) // chunk events never enter the digest
})

test('digest keeps only the message tail and caps total chars', () => {
  const events = Array.from({ length: 40 }, (_, i) => userMsg(`m${i}`))
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

test('digest truncates long messages keeping head and tail', () => {
  const long = `${'A'.repeat(1500)}${'B'.repeat(1500)}`
  const session = sessionWith([userMsg(long)])
  const digest = buildDigest(session, {})
  assert.ok(digest.length < long.length)
  assert.ok(digest.includes('A'.repeat(200)), 'head survives')
  assert.ok(digest.includes('B'.repeat(200)), 'tail survives (programming errors live at the end)')
  assert.ok(digest.includes('[中间省略'), 'omission marker present')
})
