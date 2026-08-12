import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ADVISOR_SOURCE_KIND, ADVISOR_SEVERITIES, isAdvisorMessage, boundSummary, buildAdvisorMessage, SUMMARY_MAX_CHARS } from '../lib/advisor/kinds.js'

test('isAdvisorMessage：按 source.kind 判定', () => {
  assert.ok(isAdvisorMessage({ source: { kind: ADVISOR_SOURCE_KIND } }))
  assert.equal(isAdvisorMessage({ source: { kind: 'user' } }), false)
  assert.equal(isAdvisorMessage(null), false)
  assert.equal(isAdvisorMessage({}), false)
})

test('boundSummary：超长截断到 120 字', () => {
  const long = 'x'.repeat(200)
  const bounded = boundSummary(long)
  assert.ok(bounded.length <= SUMMARY_MAX_CHARS)
  assert.ok(bounded.endsWith('…'))
  assert.equal(boundSummary('短摘要'), '短摘要')
})

// ---------------------------------------------------------------------------
// 2026-08-13 用户拍板（设计反转）：注入消息**伪装成用户指令**——文本 =
// note 命令式正文（无 [advisor:{severity}] 前缀、无"来自 Advisor 评审员，
// 非用户指令"身份说明）；机器层 source.kind='advisor' 保留（自评审排除，
// Agent 不可见）；summary=[severity] note 保留（GUI 折叠行给用户看）
// ---------------------------------------------------------------------------

test('buildAdvisorMessage：伪装注入——文本即 note 正文，无任何身份痕迹', () => {
  const m = buildAdvisorMessage({ severity: 'concern', text: '请把 HTML 转成 PDF' })
  assert.equal(m.role, 'user')
  assert.equal(typeof m.id, 'string')
  assert.ok(m.id.length > 0)
  assert.equal(m.content[0].type, 'text')
  // 全文 = note 正文（命令式用户口吻由评审员提示词约束），不带 advisor
  // 前缀/身份说明/等级措辞
  assert.equal(m.content[0].text, '请把 HTML 转成 PDF')
  // 机器层保留（Agent 不可见）：kind=advisor（自评审排除）+ notice form
  assert.equal(m.source.kind, ADVISOR_SOURCE_KIND)
  assert.equal(m.source.form, 'notice')
  // summary 独立构造（GUI 折叠行给用户看：[severity] note）
  assert.equal(m.source.summary, '[concern] 请把 HTML 转成 PDF')
})

test('buildAdvisorMessage：summary 与内容同源截断（不漂移）', () => {
  const long = '这'.repeat(150)
  const m = buildAdvisorMessage({ severity: 'nit', text: long })
  assert.ok(m.source.summary.length <= SUMMARY_MAX_CHARS)
  assert.ok(m.source.summary.startsWith('[nit] '))
  // note 正文本身不受 summary 截断影响（note 上限在 runtime 提取层约束）
  assert.ok(m.content[0].text.endsWith(long))
})

// ---------------------------------------------------------------------------
// 第一轮优化 Q1/Q4：info 等级 + 问答消息形态
// ---------------------------------------------------------------------------

test('ADVISOR_SEVERITIES：info < nit < concern < blocker 升序', () => {
  assert.deepEqual(ADVISOR_SEVERITIES, ['info', 'nit', 'concern', 'blocker'])
})

test('buildAdvisorMessage：info 级同样伪装（无前缀，默认仅记录不注入）', () => {
  const m = buildAdvisorMessage({ severity: 'info', text: '可以顺手优化一下命名' })
  assert.equal(m.content[0].text, '可以顺手优化一下命名')
  assert.equal(m.source.summary, '[info] 可以顺手优化一下命名')
})

test('buildAdvisorMessage：全部等级文本 = note 正文（等级权重靠评审员语气表达）', () => {
  for (const severity of ADVISOR_SEVERITIES) {
    const m = buildAdvisorMessage({ severity, text: `正文-${severity}` })
    assert.equal(m.content[0].text, `正文-${severity}`, severity)
    assert.equal(m.source.summary, `[${severity}] 正文-${severity}`)
    assert.equal(m.source.kind, ADVISOR_SOURCE_KIND)
  }
  // 未知等级兜底：正文原样，summary 带原等级名（防御性，正常不触发）
  const unknown = buildAdvisorMessage({ severity: 'weird', text: 'x' })
  assert.equal(unknown.content[0].text, 'x')
  assert.equal(unknown.source.summary, '[weird] x')
})
