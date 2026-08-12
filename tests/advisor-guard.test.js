import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEmissionGuard, normalizeNote, CONTENT_FREE_PHRASES } from '../lib/advisor/guard.js'

test('normalizeNote：大小写/全角/标点折叠为单空格', () => {
  assert.equal(normalizeNote('Stop.'), 'stop')
  assert.equal(normalizeNote('*stop*'), 'stop')
  assert.equal(normalizeNote('  STOP  '), 'stop')
  assert.equal(normalizeNote('No issue, continue.'), 'no issue continue')
  assert.equal(normalizeNote('变量名使用 camelCase'), '变量名使用 camelcase')
})

test('accept：普通 note 放行', () => {
  const guard = createEmissionGuard()
  assert.equal(guard.accept({ text: '建议把辅助函数拆成独立模块并加单测', severity: 'concern' }), true)
})

test('accept：空泛短语抑制（含扩展清单）', () => {
  const guard = createEmissionGuard()
  assert.equal(guard.accept({ text: 'Nothing to add', severity: 'nit' }), false)
  assert.equal(guard.accept({ text: 'lgtm', severity: 'nit' }), false)
  assert.equal(guard.accept({ text: 'looks good to me', severity: 'nit' }), false)
  // 包含短语的完整 note 不受影响
  assert.equal(guard.accept({ text: '看起来没问题，但建议补一个边界测试', severity: 'nit' }), true)
  // 纯标点/空白
  assert.equal(guard.accept({ text: '!!!', severity: 'nit' }), false)
})

test('accept：每轮至多一条（beginUpdate 复位）', () => {
  const guard = createEmissionGuard()
  assert.equal(guard.accept({ text: '第一条建议', severity: 'nit' }), true)
  assert.equal(guard.accept({ text: '第二条建议', severity: 'nit' }), false) // 同轮第二条抑制
  guard.beginUpdate()
  assert.equal(guard.accept({ text: '第二条建议', severity: 'nit' }), true) // 新轮可放行
})

test('accept：归一化去重 + 升级放行', () => {
  const guard = createEmissionGuard()
  // 每个断言前 beginUpdate（真实运行时每个 delta 一个周期，模拟同款节奏）
  guard.beginUpdate()
  assert.equal(guard.accept({ text: 'Stop. 之前先确认需求。', severity: 'nit' }), true)
  // 同级重复抑制（归一化后同键）
  guard.beginUpdate()
  assert.equal(guard.accept({ text: 'stop 之前先确认需求', severity: 'nit' }), false)
  // 升级放行（concern > nit）
  guard.beginUpdate()
  assert.equal(guard.accept({ text: 'stop 之前先确认需求', severity: 'concern' }), true)
  // 降级抑制（nit < concern）
  guard.beginUpdate()
  assert.equal(guard.accept({ text: 'stop 之前先确认需求', severity: 'nit' }), false)
})

test('accept：info 最低等级（Q1）——info→nit 升级放行，nit→info 降级抑制', () => {
  const guard = createEmissionGuard()
  guard.beginUpdate()
  assert.equal(guard.accept({ text: '同一个建议', severity: 'info' }), true)
  // info→nit 真实升级放行
  guard.beginUpdate()
  assert.equal(guard.accept({ text: '同一个建议', severity: 'nit' }), true)
  // nit→info 降级抑制
  guard.beginUpdate()
  assert.equal(guard.accept({ text: '同一个建议', severity: 'info' }), false)
  // 全新 info note 正常放行
  guard.beginUpdate()
  assert.equal(guard.accept({ text: '一个全新的小提示', severity: 'info' }), true)
})

test('accept：FIFO 历史有界（超出驱逐最旧）', () => {
  const guard = createEmissionGuard({ maxHistory: 3 })
  for (const note of ['建议一', '建议二', '建议三']) {
    guard.beginUpdate()
    assert.equal(guard.accept({ text: note, severity: 'nit' }), true)
  }
  guard.beginUpdate()
  assert.equal(guard.accept({ text: '建议一', severity: 'nit' }), false) // 仍被记忆抑制
  guard.beginUpdate()
  assert.equal(guard.accept({ text: '建议四', severity: 'nit' }), true)
  // 建议一已被驱逐 → 可再次放行
  guard.beginUpdate()
  assert.equal(guard.accept({ text: '建议一', severity: 'nit' }), true)
})

test('reset：清空历史与每轮闩锁', () => {
  const guard = createEmissionGuard()
  assert.equal(guard.accept({ text: '建议', severity: 'nit' }), true)
  assert.equal(guard.accept({ text: '建议', severity: 'nit' }), false)
  guard.reset()
  assert.equal(guard.accept({ text: '建议', severity: 'nit' }), true)
})

test('CONTENT_FREE_PHRASES 覆盖基础与扩展清单', () => {
  for (const phrase of ['stop', 'done', 'complete', 'no issue continue', 'lgtm', 'nothing to add', 'ok', 'good', 'fine', 'looks good', 'all good', 'all clear', 'no issue', 'no issues', 'nothing', 'looks good to me']) {
    assert.ok(CONTENT_FREE_PHRASES.has(phrase), `缺短语: ${phrase}`)
  }
})

test('accept 永不抛错（异常输入容错）', () => {
  const guard = createEmissionGuard()
  assert.equal(guard.accept(null), false)
  assert.equal(guard.accept({ text: null, severity: 'nit' }), false)
  assert.equal(guard.accept({ text: 123, severity: 'nit' }), false)
  assert.equal(guard.accept({ text: '', severity: 'nit' }), false)
})
