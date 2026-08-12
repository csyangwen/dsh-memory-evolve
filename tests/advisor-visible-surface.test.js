import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isVisibleUserMessage,
  isVisibleAssistantMessage,
  isVisibleMessage,
  messageVisibleText,
  renderVisibleSurface,
  TRUNCATION_MARKER,
  IMAGE_PLACEHOLDER,
} from '../lib/advisor/visible-surface.js'
import { ADVISOR_SOURCE_KIND } from '../lib/advisor/kinds.js'

/** 构造一条消息（与 memory-evolve session-orch userMessage 同构）。 */
function msg(role, content, source) {
  return { role, id: `id-${Math.random()}`, content, source: source ?? { kind: role === 'user' ? 'user' : 'model' } }
}
const text = (t) => ({ type: 'text', text: t })
const userMsg = (t) => msg('user', [text(t)], { kind: 'user' })
const agentMsg = (t, extra = []) => msg('assistant', [text(t), ...extra], { kind: 'model' })

test('isVisibleUserMessage：仅 user 且 source.kind=user', () => {
  assert.ok(isVisibleUserMessage(userMsg('你好')))
  // 工具结果（tool source）不是用户可见输入
  assert.equal(isVisibleUserMessage(msg('user', [text('{...}')], { kind: 'tool' })), false)
  // workspace/plugin 注入不是用户可见输入
  assert.equal(isVisibleUserMessage(msg('user', [text('<system-reminder>...')], { kind: 'plugin', plugin: 'x' })), false)
  // advisor 自消息不是用户可见输入
  assert.equal(isVisibleUserMessage(msg('user', [text('[advisor:nit] x')], { kind: ADVISOR_SOURCE_KIND })), false)
})

test('isVisibleAssistantMessage：role=assistant', () => {
  assert.ok(isVisibleAssistantMessage(agentMsg('好的')))
  assert.equal(isVisibleAssistantMessage(userMsg('你好')), false)
})

test('isVisibleMessage：整体判定 + 自评审排除', () => {
  assert.ok(isVisibleMessage(userMsg('你好')))
  assert.ok(isVisibleMessage(agentMsg('好的')))
  assert.equal(isVisibleMessage(null), false)
  assert.equal(isVisibleMessage(msg('user', [text('x')], { kind: 'tool' })), false)
  assert.equal(isVisibleMessage(msg('user', [text('[advisor:nit] x')], { kind: ADVISOR_SOURCE_KIND })), false)
})

test('messageVisibleText：user 文本原样', () => {
  const r = messageVisibleText(userMsg('帮我修这个 bug'))
  assert.deepEqual(r, { text: '帮我修这个 bug', imageCount: 0 })
})

test('messageVisibleText：assistant 只取 text，排除 reasoning/tool-call', () => {
  const r = messageVisibleText(agentMsg('我先看看', [
    { type: 'reasoning', text: '思考过程不可见' },
    { type: 'tool-call', name: 'read', arguments: '{"path":"a"}' },
  ]))
  assert.equal(r.text, '我先看看')
  assert.equal(r.text.includes('思考过程'), false)
  assert.equal(r.text.includes('tool-call'), false)
})

test('messageVisibleText：image 块 → 占位标记', () => {
  const r = messageVisibleText(agentMsg('图在这里', [{ type: 'image', mediaType: 'image/png', data: '...' }]))
  assert.ok(r.text.includes(IMAGE_PLACEHOLDER))
  assert.equal(r.imageCount, 1)
  // 只有图没有文本
  const only = messageVisibleText(msg('assistant', [{ type: 'image', mediaType: 'image/png', data: '...' }], { kind: 'model' }))
  assert.equal(only.text, IMAGE_PLACEHOLDER)
})

test('messageVisibleText：无可见内容返回 null', () => {
  assert.equal(messageVisibleText(msg('assistant', [{ type: 'reasoning', text: 'x' }], { kind: 'model' })), null)
  assert.equal(messageVisibleText(msg('assistant', [{ type: 'tool-call', name: 'x', arguments: '{}' }], { kind: 'model' })), null)
  assert.equal(messageVisibleText(msg('user', [text('x')], { kind: 'tool' })), null)
})

test('renderVisibleSurface：角色标注 markdown + 计数', () => {
  const r = renderVisibleSurface([userMsg('你好'), agentMsg('好的，开始')])
  assert.ok(r.markdown.startsWith('### Session update'))
  assert.ok(r.markdown.includes('<用户对Agent说>\n你好\n</用户对Agent说>'))
  assert.ok(r.markdown.includes('<Agent对用户说>\n好的，开始\n</Agent对用户说>'))
  assert.equal(r.messageCount, 2)
  assert.ok(r.charCount > 0)
})

test('renderVisibleSurface：过滤不可见消息（工具结果/思考/自消息不入表面）', () => {
  const r = renderVisibleSurface([
    userMsg('你好'),
    agentMsg('我查一下', [{ type: 'tool-call', name: 'read', arguments: '{}' }]),
    msg('user', [text('{tool result}')], { kind: 'tool' }),
    msg('user', [text('[advisor:concern] x')], { kind: ADVISOR_SOURCE_KIND }),
  ])
  assert.equal(r.messageCount, 2)
  assert.ok(!r.markdown.includes('tool result'))
  assert.ok(!r.markdown.includes('[advisor:'))
})

test('renderVisibleSurface：无可见内容返回 null', () => {
  assert.equal(renderVisibleSurface([]), null)
  assert.equal(renderVisibleSurface([msg('user', [text('x')], { kind: 'tool' })]), null)
})

test('renderVisibleSurface：有界窗口截断（保留最近 N 条 + 标记）', () => {
  const many = []
  for (let i = 0; i < 5; i++) many.push(userMsg(`消息${i}`))
  const r = renderVisibleSurface(many, { maxMessages: 2 })
  assert.equal(r.messageCount, 2)
  assert.ok(r.markdown.includes(TRUNCATION_MARKER))
  assert.ok(!r.markdown.includes('消息0'))
  assert.ok(r.markdown.includes('消息4'))
  // 0 = 无上限
  const all = renderVisibleSurface(many, { maxMessages: 0 })
  assert.equal(all.messageCount, 5)
  assert.ok(!all.markdown.includes(TRUNCATION_MARKER))
})
