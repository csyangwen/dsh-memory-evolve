/**
 * 回归测试：DSH 0.1.2-alpha.4+ 的 Session 形状（ownEvents() 取代 .events）。
 * 旧代码读 `agent.session.events.length`，新宿主下 events 为 undefined 会抛
 * TypeError（Cannot read properties of undefined (reading 'length')），
 * turn-stopping 回调被打成「处理失败」、审查计数永不累加。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewTurnCounter } from '../lib/review.js'

/**
 * 最小 Cordis 上下文桩：只实现 on/effect，够 reviewTurnCounter 注册监听。
 * @returns {{state: {listeners: Record<string, Function[]>}, ctx: object}}
 */
function fakeCtx() {
  const state = { listeners: {} }
  const ctx = {
    on(name, listener) {
      ;(state.listeners[name] ??= []).push(listener)
      return () => { state.listeners[name] = state.listeners[name].filter((l) => l !== listener) }
    },
    effect(setup) { const dispose = setup(); return typeof dispose === 'function' ? dispose : () => {} },
  }
  return { state, ctx }
}

/**
 * 构造一个回合的用户事件序列（log 序、带连续 seq）。
 * @param {number[]} turns - 回合编号列表。
 * @returns {object[]} 事件数组。
 */
function turnEvents(turns) {
  return turns.flatMap((turn) => [
    { type: 'turn/start', data: { turn } },
    { type: 'user/message', data: { id: `u${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `问题${turn}` }] } },
  ]).map((event, seq) => ({ ...event, seq }))
}

test('alpha session shape: ownEvents() replaces .events and the counter still works', () => {
  const { state, ctx } = fakeCtx()
  const counter = reviewTurnCounter(ctx, () => ({ reviewEnabled: true }))
  const listener = state.listeners['agent/turn-stopping'][0]
  assert.ok(listener, 'turn-stopping listener registered')

  // Alpha.4+ Session：没有 .events 字段，只有 ownEvents()（fork 后自有事件，log 序）。
  const alphaAgent = (id, turns) => ({
    id,
    session: { header: { origin: undefined }, ownEvents: () => turnEvents(turns) },
  })

  // 不得抛错（回归点：events.length 读 undefined）。
  assert.doesNotThrow(() => listener({ agent: alphaAgent('s1', [1]), turn: 1 }))
  assert.equal(counter.turnsOf({ id: 's1' }), 1)

  listener({ agent: alphaAgent('s1', [1, 2]), turn: 2 })
  assert.equal(counter.turnsOf({ id: 's1' }), 2)

  counter.complete({ id: 's1' })
  assert.equal(counter.turnsOf({ id: 's1' }), 0)
})

test('legacy session shape: .events still works and stays preferred when ownEvents is absent', () => {
  const { state, ctx } = fakeCtx()
  const counter = reviewTurnCounter(ctx, () => ({ reviewEnabled: true }))
  const listener = state.listeners['agent/turn-stopping'][0]

  const legacyAgent = (id, turns) => ({
    id,
    session: { header: { origin: undefined }, events: turnEvents(turns) },
  })

  assert.doesNotThrow(() => listener({ agent: legacyAgent('s2', [1]), turn: 1 }))
  assert.equal(counter.turnsOf({ id: 's2' }), 1)
})

test('defensive: session with neither accessor counts nothing instead of throwing', () => {
  const { state, ctx } = fakeCtx()
  const counter = reviewTurnCounter(ctx, () => ({ reviewEnabled: true }))
  const listener = state.listeners['agent/turn-stopping'][0]

  const bareAgent = { id: 's3', session: { header: { origin: undefined } } }
  assert.doesNotThrow(() => listener({ agent: bareAgent, turn: 1 }))
  assert.equal(counter.turnsOf({ id: 's3' }), 0)
})
