import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SessionTranscriptObserver,
  isReviewableTurnEnd,
  isRewriteEvent,
  isHumanInputEvent,
  findLastMessageTurnEnd,
} from '../lib/advisor/observer.js'
import { ADVISOR_SOURCE_KIND } from '../lib/advisor/kinds.js'

// ---------------------------------------------------------------------------
// 事件与消息构造
// ---------------------------------------------------------------------------

let seqCounter = 0
function nextSeq() {
  return seqCounter++
}

/** user 消息事件（append）。 */
function userEvent(text, source = { kind: 'user' }) {
  return {
    type: 'user/message',
    seq: nextSeq(),
    surfaceOp: 'append',
    data: { id: `m-${seqCounter}`, role: 'user', content: [{ type: 'text', text }], source },
  }
}

/** assistant 消息事件（append）。 */
function assistantEvent(text, extraBlocks = []) {
  return {
    type: 'assistant/message',
    seq: nextSeq(),
    surfaceOp: 'append',
    data: {
      message: {
        id: `m-${seqCounter}`,
        role: 'assistant',
        content: [{ type: 'text', text }, ...extraBlocks],
        source: { kind: 'model' },
      },
    },
  }
}

/** tool result 消息事件（append）。 */
function toolResultEvent(text) {
  return {
    type: 'tool/result',
    seq: nextSeq(),
    surfaceOp: 'append',
    data: {
      message: {
        id: `m-${seqCounter}`,
        role: 'user',
        content: [{ type: 'tool-result', content: [{ type: 'text', text }], toolCallId: 't1' }],
        source: { kind: 'tool' },
      },
    },
  }
}

/** turn/end 事件。 */
function turnEndEvent(reasonKind, turn = 1) {
  return { type: 'turn/end', seq: nextSeq(), data: { turn, reason: { kind: reasonKind } } }
}

function stepStartEvent(turn = 1) {
  return { type: 'step/start', seq: nextSeq(), data: { turn } }
}

/** compact 事件。 */
function compactEvent() {
  return { type: 'compact/end', seq: nextSeq(), data: {} }
}

// ---------------------------------------------------------------------------
// 观察器测试台：feed 逐个喂事件（模拟真实 session surface 实时增长）
// ---------------------------------------------------------------------------

/**
 * 构造测试台：feed(sessionId, event) 先把事件追加进该会话的"可见事件"
 * （模拟 session.events 实时追加），再 handleEvent——deriveMessages 只看到
 * 已发生的事件（与真实运行时一致）。
 */
function makeObserver() {
  const sessions = new Map() // id → { events: [], session }
  const calls = { deltas: [], turnEnds: [], rewrites: [] }
  const observer = new SessionTranscriptObserver({
    getSession: (id) => sessions.get(id)?.session,
    sessionMeta: (id) => ({ sessionId: id, sessionName: `会话${id}`, workspace: `/proj/${id}` }),
    onDelta: (sessionId, delta, meta) => calls.deltas.push({ sessionId, delta, meta }),
    onSteppedTurnEnd: (sessionId) => calls.turnEnds.push(sessionId),
    onRewrite: (sessionId) => calls.rewrites.push(sessionId),
  })
  return {
    observer,
    calls,
    sessions,
    /** 注册一个会话（可选预置事件），返回 feed 函数。 */
    feed: (sessionId, event) => {
      let entry = sessions.get(sessionId)
      if (entry === undefined) {
        entry = { events: [], session: null }
        entry.session = {
          deriveMessages: () => {
            const out = []
            for (const e of entry.events) {
              if (e.type === 'user/message') out.push(e.data)
              if (e.type === 'assistant/message') {
                if (e.data.message.content.length === 0) continue
                out.push(e.data.message)
              }
              if (e.type === 'tool/result') out.push(e.data.message)
            }
            return out
          },
        }
        sessions.set(sessionId, entry)
      }
      entry.events.push(event)
      observer.handleEvent(sessionId, entry.events, event)
    },
    /** 预置一批事件后一次性取状态（seedTo 等场景）。 */
    messagesOf: (sessionId) => sessions.get(sessionId)?.session.deriveMessages() ?? [],
  }
}

/** 一次完整标准回合：用户输入 + 助手回复 + turn/end（返回事件数组）。 */
function fullTurn(userText = '帮我写个函数', agentText = '好的，我来写', reasonKind = 'completed') {
  return [userEvent(userText), stepStartEvent(), assistantEvent(agentText), turnEndEvent(reasonKind)]
}

// ---------------------------------------------------------------------------
// 事件判定函数
// ---------------------------------------------------------------------------

test('isReviewableTurnEnd：completed/max-tokens/error 可评审，aborted 不可', () => {
  assert.ok(isReviewableTurnEnd(turnEndEvent('completed')))
  assert.ok(isReviewableTurnEnd(turnEndEvent('max-tokens')))
  assert.ok(isReviewableTurnEnd(turnEndEvent('error')))
  assert.equal(isReviewableTurnEnd(turnEndEvent('aborted')), false)
  assert.equal(isReviewableTurnEnd(turnEndEvent('interrupted')), false)
  assert.equal(isReviewableTurnEnd({ type: 'step/end' }), false)
})

test('isRewriteEvent：compact/* 与非 append surfaceOp', () => {
  assert.ok(isRewriteEvent(compactEvent()))
  assert.ok(isRewriteEvent({ type: 'user/message', seq: 1, surfaceOp: { op: 'replace', range: [0, 2] }, data: {} }))
  assert.equal(isRewriteEvent(userEvent('x')), false)
  assert.equal(isRewriteEvent({ type: 'step/start', seq: 1 }), false)
})

test('isHumanInputEvent：user 消息 / inbox 拼接含 user；工具结果不算', () => {
  assert.ok(isHumanInputEvent(userEvent('你好')))
  assert.equal(isHumanInputEvent(userEvent('工具结果', { kind: 'tool' })), false)
  assert.equal(isHumanInputEvent(userEvent('注入', { kind: 'plugin', plugin: 'x' })), false)
  assert.equal(isHumanInputEvent(userEvent('advisor', { kind: ADVISOR_SOURCE_KIND })), false)
  assert.ok(isHumanInputEvent({ type: 'agent/inbox/spliced', seq: 1, data: { inserted: [{ source: { kind: 'user' } }] } }))
  assert.equal(isHumanInputEvent({ type: 'agent/inbox/spliced', seq: 1, data: { inserted: [{ source: { kind: ADVISOR_SOURCE_KIND } }] } }), false)
})

test('findLastMessageTurnEnd：只认进入过 step 的 turn', () => {
  const events = []
  events.push(stepStartEvent())
  events.push(turnEndEvent('completed'))
  events.push(turnEndEvent('completed')) // 无 step 的回合
  const latest = findLastMessageTurnEnd(events)
  assert.equal(latest, events[1])
})

// ---------------------------------------------------------------------------
// 观察器行为
// ---------------------------------------------------------------------------

test('标准会话：turn/end 触发评审，delta 只含可见消息', () => {
  const { feed, calls } = makeObserver()
  for (const event of fullTurn()) feed('s1', event)
  assert.equal(calls.turnEnds.length, 1)
  assert.equal(calls.deltas.length, 1)
  const delta = calls.deltas[0].delta
  assert.ok(delta.markdown.includes('<用户对Agent说>\n帮我写个函数\n</用户对Agent说>'))
  assert.ok(delta.markdown.includes('<Agent对用户说>\n好的，我来写\n</Agent对用户说>'))
  assert.equal(calls.deltas[0].meta.sessionName, '会话s1')
  assert.equal(calls.deltas[0].meta.workspace, '/proj/s1')
})

test('标准会话：aborted 回合不评审', () => {
  const { feed, calls } = makeObserver()
  for (const event of fullTurn('开始', '进行中', 'aborted')) feed('s1', event)
  assert.equal(calls.deltas.length, 0)
})

test('标准会话：无 step 的 turn（拒绝/空输入）不评审', () => {
  const { feed, calls } = makeObserver()
  feed('s1', userEvent(''))
  feed('s1', turnEndEvent('completed')) // 无 step/start
  assert.equal(calls.deltas.length, 0)
})

test('agentic 会话：人类输入到达且有未评审 assistant 增量才评审', () => {
  const { feed, calls } = makeObserver()
  feed('s1', userEvent('第一轮'))
  feed('s1', assistantEvent('第一轮回复'))
  feed('s1', userEvent('第二轮')) // 触发评审（第一轮增量）
  feed('s1', assistantEvent('第二轮回复'))
  feed('s1', userEvent('第三轮')) // 触发评审（第二轮增量）
  assert.equal(calls.deltas.length, 2)
  // 第一轮评审 delta 含第一轮对话（增量）
  const d0 = calls.deltas[0].delta.markdown
  assert.ok(d0.includes('第一轮'))
  assert.ok(d0.includes('第一轮回复'))
})

test('agentic 会话：首条用户输入不触发不推进游标', () => {
  const { feed, calls } = makeObserver()
  feed('s1', userEvent('第一条'))
  assert.equal(calls.deltas.length, 0)
  feed('s1', assistantEvent('回复'))
  feed('s1', userEvent('第二条')) // 触发评审，且包含第一条
  assert.equal(calls.deltas.length, 1)
  assert.ok(calls.deltas[0].delta.markdown.includes('第一条'))
})

test('模式闩锁：发过 turn/end 后 agentic 门休眠', () => {
  const { feed, calls } = makeObserver()
  for (const event of fullTurn()) feed('s1', event)
  feed('s1', userEvent('更多输入')) // agentic 门应休眠
  assert.equal(calls.deltas.length, 1) // 只有 turn/end 那次
})

test('可见性：工具结果/思考不进入评审 delta', () => {
  const { feed, calls } = makeObserver()
  feed('s1', userEvent('查一下'))
  feed('s1', stepStartEvent())
  feed('s1', assistantEvent('查询中', [{ type: 'reasoning', text: '思考不可见' }]))
  feed('s1', toolResultEvent('{工具结果不可见}'))
  feed('s1', assistantEvent('结论如下'))
  feed('s1', turnEndEvent('completed'))
  assert.equal(calls.deltas.length, 1)
  const markdown = calls.deltas[0].delta.markdown
  assert.ok(markdown.includes('结论如下'))
  assert.ok(!markdown.includes('思考不可见'))
  assert.ok(!markdown.includes('工具结果不可见'))
})

test('重写：compact 事件触发 onRewrite + 全量重放', () => {
  const { feed, calls } = makeObserver()
  for (const event of fullTurn()) feed('s1', event)
  feed('s1', compactEvent())
  for (const event of fullTurn('新话题', '新回复')) feed('s1', event)
  assert.equal(calls.rewrites.length, 1)
  // 重写后那次评审是全量（含第一轮内容，有界窗口内）
  const last = calls.deltas[calls.deltas.length - 1].delta.markdown
  assert.ok(last.includes('帮我写个函数'))
  assert.ok(last.includes('新回复'))
})

test('seedTo：中途开启不全量回放', () => {
  const { feed, calls, observer, messagesOf } = makeObserver()
  for (const event of fullTurn()) feed('s1', event)
  for (const event of fullTurn('第二题', '第二答')) feed('s1', event)
  // 模拟 /advisor on 在第二轮后开启：seed 到当前消息数
  observer.seedTo('s1', messagesOf('s1').length)
  for (const event of fullTurn('第三题', '第三答')) feed('s1', event)
  assert.equal(calls.deltas.length, 3) // 前两轮各 1 + seed 后 1
  const last = calls.deltas[2].delta.markdown
  assert.ok(!last.includes('第一题'))
  assert.ok(last.includes('第三答'))
})

test('disposeSession：清理会话状态（重建后全量重放）', () => {
  const { feed, calls, observer, sessions } = makeObserver()
  for (const event of fullTurn()) feed('s1', event)
  observer.disposeSession('s1')
  // 模拟会话重建：dispose 后事件日志清空（真实中 dispose 即事件流终止）
  sessions.get('s1').events.length = 0
  for (const event of fullTurn('又一轮', '又回复')) feed('s1', event)
  assert.equal(calls.deltas.length, 2)
  // 重建后全新渲染器：全量重放新会话内容
  const last = calls.deltas[1].delta.markdown
  assert.ok(last.includes('又一轮'))
  assert.ok(last.includes('又回复'))
  assert.ok(!last.includes('帮我写个函数'))
})

test('增量语义：第二轮评审只含新增消息', () => {
  const { feed, calls } = makeObserver()
  for (const event of fullTurn('第一题', '第一答')) feed('s1', event)
  for (const event of fullTurn('第二题', '第二答')) feed('s1', event)
  assert.equal(calls.deltas.length, 2)
  const d0 = calls.deltas[0].delta.markdown
  const d1 = calls.deltas[1].delta.markdown
  assert.ok(d0.includes('第一题'))
  assert.ok(!d1.includes('第一题')) // 增量不含第一轮
  assert.ok(d1.includes('第二题'))
})

// ---------------------------------------------------------------------------
// 第一轮优化 Q3 重构：增量可见条目（评审员持续会话输入）
// ---------------------------------------------------------------------------

test('Q3 重构：增量评审的 delta 携带 entries（本轮新增可见条目）', () => {
  const { feed, calls } = makeObserver()
  for (const event of fullTurn('第一题', '第一答')) feed('s1', event)
  for (const event of fullTurn('第二题', '第二答')) feed('s1', event)
  const d1 = calls.deltas[1].delta
  // 增量条目只含第二轮（不含第一轮）
  assert.ok(Array.isArray(d1.entries))
  assert.ok(d1.entries.some((e) => e.text.includes('第二题')))
  assert.ok(!d1.entries.some((e) => e.text.includes('第一题')))
  // 首次全量：entries = 全部可见消息
  const d0 = calls.deltas[0].delta
  assert.ok(d0.entries.some((e) => e.text.includes('第一题')))
})

test('Q3 重构：entries 携带角色成对标签（<用户对Agent说>/<Agent对用户说>），排除不可见消息', () => {
  const { feed, calls } = makeObserver()
  // 第一轮带一个工具结果（不可见）+ advisor 自消息（自评审排除）
  const events = [
    userEvent('第一题'),
    stepStartEvent(),
    assistantEvent('第一答', [{ type: 'tool-call', name: 'read', arguments: '{}' }]),
    toolResultEvent('{tool result}'),
    turnEndEvent('completed'),
  ]
  for (const event of events) feed('s1', event)
  const d0 = calls.deltas[0].delta
  assert.ok(d0.entries.some((e) => e.text.includes('<用户对Agent说>\n第一题\n</用户对Agent说>')))
  assert.ok(d0.entries.some((e) => e.text.includes('<Agent对用户说>\n第一答\n</Agent对用户说>')))
  assert.ok(!d0.entries.some((e) => e.text.includes('tool result')))
})

test('Q3 重构：renderAndEmit 的 entries 与 markdown 增量一致（skipLast 不污染）', () => {
  // agentic 触发（skipLast）：末条用户输入进入下一轮，不在本轮 entries
  const { observer, feed, sessions, calls } = makeObserver()
  const entry = sessions.get('s1')
  // 预置：首条 user + agent 回复（无 turn/end → agentic 模式）
  feed('s1', userEvent('问题'))
  feed('s1', assistantEvent('回答'))
  // 用户再发一条（触发 agentic 评审；该输入被 skipLast 排除）
  feed('s1', userEvent('追问'))
  const last = calls.deltas[calls.deltas.length - 1]
  assert.ok(!last.delta.entries.some((e) => e.text.includes('追问')))
  assert.ok(last.delta.entries.some((e) => e.text.includes('回答')))
})
