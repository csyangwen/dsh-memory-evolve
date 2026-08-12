import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AdvisorConversation } from '../lib/advisor/conversation.js'

test('conversation：追加 user/assistant 消息与快照', () => {
  const c = new AdvisorConversation()
  assert.equal(c.length, 0)
  c.appendUser('**user**: 你好')
  c.appendUser('**agent**: 好的')
  c.appendAssistant('[nit] 建议补单测')
  assert.equal(c.length, 3)
  const snap = c.snapshot()
  assert.deepEqual(snap[0], { role: 'user', text: '**user**: 你好' })
  assert.deepEqual(snap[2], { role: 'assistant', text: '[nit] 建议补单测' })
  // 快照是副本（调用方修改不污染）
  snap[0].text = 'changed'
  assert.equal(c.snapshot()[0].text, '**user**: 你好')
})

test('conversation：reset 清空上下文 + epoch 自增（新建评审会话）', () => {
  const c = new AdvisorConversation()
  assert.equal(c.epoch, 1)
  c.appendUser('背景信息')
  c.appendAssistant('[concern] 注意')
  const epoch = c.reset()
  assert.equal(epoch, 2)
  assert.equal(c.epoch, 2)
  assert.equal(c.length, 0)
  // 再次 reset 继续自增
  assert.equal(c.reset(), 3)
})

test('conversation：无截断——追加大量消息后快照完整保留', () => {
  const c = new AdvisorConversation()
  for (let i = 0; i < 500; i++) c.appendUser(`消息${i}`)
  assert.equal(c.length, 500)
  assert.ok(c.snapshot()[0].text.includes('消息0'))
  assert.ok(c.snapshot()[499].text.includes('消息499'))
})
