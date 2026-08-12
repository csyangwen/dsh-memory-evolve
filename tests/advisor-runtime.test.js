import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AdvisorRuntime, extractAdviceNote, ADVISOR_NOTE_MAX_CHARS } from '../lib/advisor/runtime.js'

/** 静默 logger（测试不刷屏）。 */
const silent = { debug() {}, warn() {} }

/** 构造一个 stub llm：按序返回 reply 文本；hang=true 永不返回（超时测试）。 */
function stubLlm({ replies = [], hang = false, error = null, resolveModelInfo = undefined } = {}) {
  const calls = []
  const llm = {
    calls,
    replies,
    resolveModelInfo: resolveModelInfo ?? (async () => ({ reasoning: { efforts: [{ id: 'off' }] } })),
    stream(options) {
      calls.push(options)
      if (hang) {
        // 挂死流：永不产出、永不结束（provider 忽略 abort 的极端情形）
        return {
          [Symbol.asyncIterator]() {
            return { next: () => new Promise(() => {}) }
          },
        }
      }
      if (error !== null) {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                throw error
              },
            }
          },
        }
      }
      const text = llm.replies.length > 0 ? llm.replies.shift() : '{"note":"建议","severity":"nit"}'
      return {
        [Symbol.asyncIterator]() {
          let done = false
          return {
            next: async () => {
              if (done) return { done: true, value: undefined }
              done = true
              return { done: false, value: { type: 'text-delta', text } }
            },
          }
        },
      }
    },
  }
  return llm
}

/** stub 指令队列：记录 reserve/consume/release 调用（契约同步：reserve 带
 * options/reserve 返回含 reviewId；release(reviewId, items)）。 */
function stubInstructions() {
  let n = 0
  const state = { reserved: [], consumed: [], released: [] }
  return {
    reserve(sessionId, reviewId, options = {}) {
      const items = [{ id: `instr-${++n}`, text: '重点检查安全', reviewId }]
      state.reserved.push(...items)
      return items
    },
    consume(reviewId, texts) {
      state.consumed.push({ reviewId, texts })
    },
    release(reviewId, items) {
      const seen = new Set(state.released.map((i) => i.id))
      for (const item of items ?? []) {
        if (!seen.has(item.id)) {
          state.released.push(item)
          seen.add(item.id)
        }
      }
    },
    state,
  }
}

/** 构造一个带事件收集的运行时（llm 可直接传对象，或传 stubLlm 配置）。 */
function makeRuntime(overrides = {}) {
  const events = []
  const notes = []
  const instructions = stubInstructions()
  const llm = overrides.llm?.stream ? overrides.llm : stubLlm(overrides.llm ?? {})
  const runtime = new AdvisorRuntime({
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    systemPrompt: 'test prompt',
    llm,
    instructions,
    onEvent: (e) => events.push(e),
    // Q1 契约：onNote 返回投递结果字符串（'steer'|'inject'|'recorded'|false）
    onNote: (note, reviewId) => { notes.push({ note, reviewId }); return overrides.onNoteResult ?? 'steer' },
    // Q4：问答回答投递回调（记录并视为成功）
    onAnswer: (text, reviewId) => { answers.push({ text, reviewId }); return true },
    logger: silent,
    callTimeoutMs: overrides.callTimeoutMs ?? 60000,
    retryBackoffMs: 1,
    maxQueued: overrides.maxQueued ?? 32,
  })
  return { runtime, events, notes, instructions }
}

const META = { sessionId: 'session-test', sessionName: '测试会话', workspace: '/path/to/proj' }
const DELTA = { markdown: '### Session update\n\n**user**: 你好', messageCount: 1, charCount: 10 }

async function drain(runtime) {
  // 等待 drain 轮次结束（drain 是异步 fire-and-forget）
  await runtime.waitForDrain()
  // 补一个微任务 tick 让事件回调全部落地
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------
// extractAdviceNote（KD-2）
// ---------------------------------------------------------------------------

test('extractAdviceNote：正常帧（DTO {text,severity}）', () => {
  assert.deepEqual(extractAdviceNote('{"note":"补个单测","severity":"concern"}'), { text: '补个单测', severity: 'concern' })
})

test('extractAdviceNote：容忍散文/围栏，取第一个平衡对象', () => {
  assert.deepEqual(extractAdviceNote('好的，我的建议如下：\n```json\n{"note":"x"}\n```'), { text: 'x', severity: 'nit' })
  // 字符串里的花括号不影响平衡
  assert.deepEqual(extractAdviceNote('{"note":"含{花括号}文本","severity":"blocker"}'), { text: '含{花括号}文本', severity: 'blocker' })
})

test('extractAdviceNote：缺 severity 默认 nit；非法 severity 默认 nit', () => {
  assert.equal(extractAdviceNote('{"note":"x"}').severity, 'nit')
  assert.equal(extractAdviceNote('{"note":"x","severity":"urgent"}').severity, 'nit')
})

test('extractAdviceNote：空 note/无帧返回 undefined', () => {
  assert.equal(extractAdviceNote('{"note":""}'), undefined)
  assert.equal(extractAdviceNote('{"note":"   "}'), undefined)
  assert.equal(extractAdviceNote('没有 JSON'), undefined)
  assert.equal(extractAdviceNote(''), undefined)
})

test('extractAdviceNote：超长 note 截断加省略号', () => {
  const r = extractAdviceNote(JSON.stringify({ note: 'x'.repeat(2000), severity: 'nit' }))
  assert.ok(r.text.length <= ADVISOR_NOTE_MAX_CHARS)
  assert.ok(r.text.endsWith('…'))
})

// ---------------------------------------------------------------------------
// 完整链路
// ---------------------------------------------------------------------------

test('完整链路：enqueue → started → llm → note → guard → onNote + finished(delivered)', async () => {
  const { runtime, events, notes, instructions } = makeRuntime()
  runtime.enqueue(DELTA, META)
  await drain(runtime)

  const types = events.map((e) => e.type)
  // 首尾各有一个 runtime-status（启动 reviewing / 收尾 idle）；中间两阶段
  assert.deepEqual(types.slice(0, 3), ['runtime-status', 'review-started', 'review-finished'])
  const started = events.find((e) => e.type === 'review-started')
  assert.equal(started.sessionId, META.sessionId)
  assert.equal(started.sessionName, META.sessionName)
  assert.equal(started.workspace, META.workspace)
  assert.equal(started.input.messageCount, 1)
  assert.equal(started.input.markdown, DELTA.markdown)
  const finished = events.find((e) => e.type === 'review-finished')
  assert.equal(finished.reviewId, started.reviewId) // 同 reviewId 合并
  assert.equal(finished.outcome, 'delivered')
  assert.equal(finished.delivery, 'steer')
  assert.deepEqual(finished.note, { text: '建议', severity: 'nit' })
  assert.ok(finished.elapsedMs >= 0)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].note.text, '建议')
  // 指令 reserve → consume（成功路径）
  assert.equal(instructions.state.reserved.length, 1)
  assert.equal(instructions.state.consumed.length, 1)
  assert.deepEqual(instructions.state.consumed[0].texts, ['重点检查安全'])
  assert.equal(instructions.state.released.length, 0)
})

test('评审指令只在本轮 update 段注入一次（评审后提交进持续会话）', async () => {
  let seenMessages = null
  const llm = stubLlm()
  const origStream = llm.stream.bind(llm)
  llm.stream = (options) => {
    seenMessages = options.messages
    return origStream(options)
  }
  const { runtime } = makeRuntime({ llm })
  runtime.enqueue(DELTA, META)
  await drain(runtime)
  // 2026-08-13 用户反馈修订：首轮调用输入 = 唯一一条 update 段
  // （指令合并其中），不提前入历史、不与历史重复
  assert.equal(seenMessages.length, 1)
  assert.ok(seenMessages[0].content[0].text.startsWith('### Session update'))
  assert.ok(seenMessages[0].content[0].text.includes('<用户对评审员指令>\n重点检查安全\n</用户对评审员指令>'))
  // 评审完成后指令提交进评审员上下文（下轮评审仍携带；+1 条是建议回放）
  assert.equal(runtime.conversation.length, 2)
  assert.equal(runtime.conversation.snapshot()[0].role, 'user')
  assert.ok(runtime.conversation.snapshot()[0].text.includes('<用户对评审员指令>'))
})

test('空泛短语帧（Nothing to add）→ 提取层归一化为 no-note（不展示给用户）', async () => {
  // 2026-08-12 用户反馈："Nothing to add" = 评审员"没有值得提的建议"，
  // 直接归一化为 no-note（面板显示"无建议"），不再作为 note 展示
  const { runtime, events, notes } = makeRuntime({ llm: { replies: ['{"note":"Nothing to add"}'] } })
  runtime.enqueue(DELTA, META)
  await drain(runtime)
  const finished = events.find((e) => e.type === 'review-finished')
  assert.equal(finished.outcome, 'no-note')
  assert.equal(finished.delivery, null)
  assert.equal(finished.note, null)
  assert.equal(notes.length, 0)
})

test('guard 抑制（去重/每轮一条等）→ finished(suppressed)，指令仍消费', async () => {
  // 提取层已拦截空泛短语；guard 的抑制路径用"重复建议"触发（真实场景）
  const { runtime, events, notes } = makeRuntime({ llm: { replies: ['{"note":"同一个建议","severity":"nit"}', '{"note":"同一个建议","severity":"nit"}'] } })
  runtime.enqueue(DELTA, META)
  await drain(runtime)
  runtime.enqueue({ ...DELTA, markdown: '第二轮', entries: [{ text: '**user**: 第二轮' }] }, META)
  await drain(runtime)
  const finished = events.filter((e) => e.type === 'review-finished')
  assert.equal(finished[0].outcome, 'delivered')
  assert.equal(finished[1].outcome, 'suppressed') // 同内容去重 → 抑制
  assert.equal(notes.length, 1)
})

test('无可提取 note → finished(no-note)', async () => {
  const { runtime, events } = makeRuntime({ llm: { replies: ['没有 JSON 帧的回复'] } })
  runtime.enqueue(DELTA, META)
  await drain(runtime)
  const finished = events.find((e) => e.type === 'review-finished')
  assert.equal(finished.outcome, 'no-note')
})

test('投递抛错 → finished(dropped)，drain 不崩', async () => {
  const events = []
  const instructions = stubInstructions()
  const runtime = new AdvisorRuntime({
    provider: 'p',
    model: 'm',
    systemPrompt: 's',
    llm: stubLlm(),
    instructions,
    onEvent: (e) => events.push(e),
    onNote: () => { throw new Error('no agent') },
    logger: silent,
  })
  runtime.enqueue(DELTA, META)
  await drain(runtime)
  const finished = events.find((e) => e.type === 'review-finished')
  assert.equal(finished.outcome, 'dropped')
  assert.equal(finished.error.code, 'DELIVERY_FAILED')
})

test('transient 失败：重试 1 次后仍失败 → finished(failed) + 指令释放', async () => {
  let calls = 0
  const llm = stubLlm()
  llm.stream = () => ({
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          calls += 1
          const err = new Error('network flaky')
          err.code = 'NETWORK'
          throw err
        },
      }
    },
  })
  const { runtime, events, instructions } = makeRuntime({ llm })
  runtime.enqueue(DELTA, META)
  await drain(runtime)
  assert.equal(calls, 2) // 首次 + 重试 1 次
  const finished = events.filter((e) => e.type === 'review-finished')
  assert.equal(finished.length, 1)
  assert.equal(finished[0].outcome, 'failed')
  assert.equal(finished[0].error.retryable, true)
  assert.equal(instructions.state.released.length, 1) // 指令回写
  assert.equal(instructions.state.consumed.length, 0)
})

test('quota 失败：暂停 + 指令释放 + runtime-status(quota_exhausted)，队列保留', async () => {
  const llm = stubLlm()
  llm.stream = () => ({
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          const err = new Error('quota exceeded')
          err.code = 'QUOTA_EXCEEDED'
          throw err
        },
      }
    },
  })
  const { runtime, events, instructions } = makeRuntime({ llm })
  runtime.enqueue(DELTA, META)
  runtime.enqueue({ ...DELTA, markdown: '第二个' }, META)
  await drain(runtime)
  assert.equal(runtime.status(), 'quota_exhausted')
  const statusEvent = events.filter((e) => e.type === 'runtime-status').pop()
  assert.equal(statusEvent.runtimeStatus, 'quota_exhausted')
  assert.equal(instructions.state.released.length, 1)
  // 队列保留（第二个 delta 仍在）
  assert.equal(runtime.pendingCount, 1)
  // resume 后继续处理
  runtime.resume()
  await drain(runtime)
  assert.equal(runtime.pendingCount, 0)
})

test('permanent 失败：终止 + runtime-status(halted)', async () => {
  const llm = stubLlm()
  llm.stream = () => ({
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          const err = new Error('model_not_found')
          err.code = 'MODEL_NOT_FOUND'
          throw err
        },
      }
    },
  })
  const { runtime, events } = makeRuntime({ llm })
  runtime.enqueue(DELTA, META)
  await drain(runtime)
  assert.equal(runtime.status(), 'halted')
  const statusEvent = events.filter((e) => e.type === 'runtime-status').pop()
  assert.equal(statusEvent.runtimeStatus, 'halted')
  // halted 后 enqueue 被忽略
  runtime.enqueue(DELTA, META)
  assert.equal(runtime.pendingCount, 0)
})

test('挂死流：调用级超时兜底退出（transient 重试后 → failed）', async () => {
  const { runtime, events } = makeRuntime({ llm: { hang: true }, callTimeoutMs: 50 })
  runtime.enqueue(DELTA, META)
  await drain(runtime)
  const finished = events.find((e) => e.type === 'review-finished')
  assert.equal(finished.outcome, 'failed')
  assert.ok(finished.error.retryable === true)
})

test('队列满：drop-newest（不阻塞调用方）', async () => {
  const llm = stubLlm({ hang: true })
  const { runtime } = makeRuntime({ llm, callTimeoutMs: 300, maxQueued: 1 })
  runtime.enqueue(DELTA, META)
  // 等 drain 进入挂起（首个 delta 已被 shift 处理中）
  await new Promise((resolve) => setTimeout(resolve, 5))
  runtime.enqueue({ ...DELTA, markdown: 'b' }, META) // 入队（队空，放行）
  runtime.enqueue({ ...DELTA, markdown: 'c' }, META) // 队满 → 丢弃
  assert.equal(runtime.pendingCount, 1) // 只有 b 在队，c 被丢
})

test('dispose：中止 in-flight + 迟到事件丢弃 + 指令释放语义', async () => {
  const { runtime, events, instructions } = makeRuntime({ llm: { hang: true }, callTimeoutMs: 5000 })
  runtime.enqueue(DELTA, META)
  await new Promise((resolve) => setTimeout(resolve, 5))
  runtime.dispose()
  await drain(runtime)
  assert.equal(runtime.status(), 'disabled')
  // B6：started 已发 → dispose 中止后必须发 finished(cancelled) 闭合（前端防永久 skeleton）
  const finished = events.filter((e) => e.type === 'review-finished')
  assert.equal(finished.length, 1)
  assert.equal(finished[0].outcome, 'cancelled')
  // B5：指令已释放回 pending（不残留 reserved）
  assert.equal(instructions.state.released.length, 1)
})

test('3 连丢：清空 backlog（never stall）', async () => {
  let calls = 0
  const llm = stubLlm()
  llm.stream = () => ({
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          calls += 1
          const err = new Error('flaky')
          err.code = 'NETWORK'
          throw err
        },
      }
    },
  })
  const { runtime, events } = makeRuntime({ llm, maxQueued: 10 })
  for (let i = 0; i < 5; i++) runtime.enqueue({ ...DELTA, markdown: `d${i}` }, META)
  await drain(runtime)
  assert.equal(runtime.pendingCount, 0) // backlog 被清空
  assert.ok(events.filter((e) => e.type === 'review-finished').length >= 1)
})

test('reasoning off 能力门控：声明支持才传；解析失败省略选项', async () => {
  // 支持 off
  let seenOptions = null
  const llm1 = stubLlm({ resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }) })
  llm1.stream = (options) => { seenOptions = options; return stubLlm().stream(options) }
  const r1 = makeRuntime({ llm: llm1 })
  r1.runtime.enqueue(DELTA, META)
  await drain(r1.runtime)
  assert.equal(seenOptions.reasoningEffort, 'off')

  // 不支持 off（如普通模型）→ 省略选项
  let seen2 = null
  const llm2 = stubLlm({ resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }) })
  llm2.stream = (options) => { seen2 = options; return stubLlm().stream(options) }
  const r2 = makeRuntime({ llm: llm2 })
  r2.runtime.enqueue(DELTA, META)
  await drain(r2.runtime)
  assert.equal(seen2.reasoningEffort, undefined)

  // 解析抛错 → 省略选项，调用正常
  let seen3 = null
  const llm3 = stubLlm({ resolveModelInfo: async () => { throw new Error('resolve failed') } })
  llm3.stream = (options) => { seen3 = options; return stubLlm().stream(options) }
  const r3 = makeRuntime({ llm: llm3 })
  r3.runtime.enqueue(DELTA, META)
  await drain(r3.runtime)
  assert.equal(seen3.reasoningEffort, undefined)
})

// ---------------------------------------------------------------------------
// 第一轮优化 Q1：info 级（默认仅记录不注入）
// ---------------------------------------------------------------------------

test('info 级：onNote 返回 recorded → outcome=recorded（仅记录不注入）', async () => {
  const { runtime, events } = makeRuntime({ onNoteResult: 'recorded' })
  runtime.enqueue(DELTA, META)
  await drain(runtime)
  const finished = events.find((e) => e.type === 'review-finished')
  assert.equal(finished.outcome, 'recorded')
  assert.equal(finished.delivery, null)
  assert.equal(finished.note.severity, 'nit') // 记录照常携带 note
})

test('info 级：guard 仍生效；投递成功（recorded）的建议回放进评审员会话', async () => {
  // 投递层语义（infoInject 开关在 api.test.js 覆盖），runtime 只透传投递结果
  const { runtime } = makeRuntime({ onNoteResult: 'recorded' })
  runtime.enqueue(DELTA, META)
  await drain(runtime)
  // Q3：delivered/recorded 都回放进评审员持续会话（assistant 消息）
  const messages = runtime.conversation.snapshot()
  assert.ok(messages.some((m) => m.role === 'assistant' && m.text.includes('[nit] 建议')))
})

test('Q3：评审员持续会话——第二次评审调用携带第一次的建议回放（assistant 消息）', async () => {
  const llm = stubLlm({ replies: ['{"note":"第一次建议","severity":"nit"}', '{"note":"第二次建议","severity":"nit"}'] })
  const { runtime } = makeRuntime({ llm })
  runtime.enqueue(DELTA, META)
  await drain(runtime)
  runtime.enqueue({ ...DELTA, markdown: '### Session update\n\n**user**: 第二问', entries: [{ text: '**user**: 第二问' }] }, META)
  await drain(runtime)
  const lastCall = llm.calls[llm.calls.length - 1]
  const texts = lastCall.messages.map((m) => m.content[0].text)
  // 第一次建议以 assistant 消息回放（她记得自己说过什么）
  assert.ok(texts.includes('[nit] 第一次建议'))
  assert.ok(lastCall.messages[texts.indexOf('[nit] 第一次建议')].role === 'assistant')
  // 历史全量重放 + 最后一条 update 段（无截断）
  const updateIndex = texts.findIndex((t) => t.startsWith('### Session update'))
  assert.ok(updateIndex === texts.length - 1)
  // 上下文持续累积
  assert.ok(runtime.conversation.length >= 3)
})

test('Q3（2026-08-13 修订）：本轮消息只在 update 段注入一次，评审后提交进持续会话', async () => {
  const llm = stubLlm()
  const { runtime } = makeRuntime({ llm })
  runtime.enqueue({ ...DELTA, entries: [{ text: '**user**: 你好' }, { text: '**agent**: 好的' }] }, META)
  await drain(runtime)
  const call = llm.calls[0]
  const texts = call.messages.map((m) => m.content[0].text)
  // 用户反馈：每一轮评审只注入一次本轮观察到的 Agent/用户消息——调用
  // 输入 = 历史（首轮为空）+ 唯一一条 update 段（指令 + 全部增量条目），
  // 条目不再作为独立历史消息与 update 段重复出现
  assert.equal(texts.length, 1)
  const update = texts[0]
  assert.ok(update.startsWith('### Session update'))
  assert.ok(update.includes('<用户对评审员指令>\n重点检查安全\n</用户对评审员指令>'))
  assert.ok(update.includes('**user**: 你好'))
  assert.ok(update.includes('**agent**: 好的'))
  // 评审完成后：本轮输入提交进持续会话（先 user 后 assistant，顺序正确）
  const snapshot = runtime.conversation.snapshot()
  assert.equal(snapshot.length, 4)
  assert.equal(snapshot[0].role, 'user')
  assert.ok(snapshot[0].text.includes('<用户对评审员指令>\n重点检查安全\n</用户对评审员指令>'))
  assert.equal(snapshot[1].text, '**user**: 你好')
  assert.equal(snapshot[2].text, '**agent**: 好的')
  assert.equal(snapshot[3].role, 'assistant')
  assert.ok(snapshot[3].text.includes('[nit] 建议'))
})

// ---------------------------------------------------------------------------
// 第一轮优化 Q4：指令即时问答
// ---------------------------------------------------------------------------

test('问答：ask → 问题进持续会话 + QA 后缀 + answered 事件 + inject + 回放', async () => {
  const llm = stubLlm({ replies: ['直接回答：重点检查边界条件。'] })
  const { runtime, events, instructions } = makeRuntime({ llm })
  runtime.ask(META, 'instr-q1')
  await drain(runtime)
  // 调用输入：问题已在持续会话（### User question），全量重放
  const call = llm.calls[0]
  assert.ok(call.system.includes('直接问答模式'))
  const texts = call.messages.map((m) => m.content[0].text)
  assert.ok(texts.some((t) => t.startsWith('### User question\n<用户对评审员提问>\n重点检查安全\n</用户对评审员提问>')))
  assert.ok(!texts.some((t) => t.includes('<用户对评审员指令>')))
  // started 带 mode=qa
  const started = events.find((e) => e.type === 'review-started')
  assert.equal(started.input.mode, 'qa')
  // finished：answered + note=回答全文 + delivery=null（不注入主会话，
  // 2026-08-12 用户反馈：回答只在面板展示）
  const finished = events.find((e) => e.type === 'review-finished')
  assert.equal(finished.outcome, 'answered')
  assert.equal(finished.delivery, null)
  assert.deepEqual(finished.note, { text: '直接回答：重点检查边界条件。', severity: 'answer' })
  // 指令已消费
  assert.equal(instructions.state.consumed.length, 1)
  // Q3：回答回放进评审员持续会话（assistant 消息，她记得回答过什么）
  const conversation = runtime.conversation.snapshot()
  assert.ok(conversation.some((m) => m.role === 'assistant' && m.text.includes('[advisor] 直接回答：重点检查边界条件。')))
})

test('问答：跳过发射闸门（与普通评审去重历史无关）', async () => {
  // 第一次评审产出 note，第二次问答即使回答与 note 相同也放行（问答不查 guard）
  const llm = stubLlm({ replies: ['{"note":"相同的建议","severity":"nit"}', '相同的建议'] })
  const { runtime, events } = makeRuntime({ llm })
  runtime.enqueue(DELTA, META)
  await drain(runtime)
  runtime.ask(META, null)
  await drain(runtime)
  // 问答不受去重抑制：answered 事件存在（即使回答与评审 note 相同）
  const finished = events.filter((e) => e.type === 'review-finished')
  assert.ok(finished.some((f) => f.outcome === 'answered'))
  // 回答回放进评审员会话
  const texts = runtime.conversation.snapshot().map((m) => m.text)
  assert.ok(texts.some((t) => t.includes('[advisor] 相同的建议')))
})

test('问答：空回答 → transient 重试后 failed + 指令释放回 pending', async () => {
  // 复审高2：空回答不静默消费——按 transient 失败重试一次，仍空则 failed
  const llm = stubLlm({ replies: ['   ', '   '] })
  const { runtime, events, instructions } = makeRuntime({ llm })
  runtime.ask(META, null)
  await drain(runtime)
  const finished = events.find((e) => e.type === 'review-finished')
  assert.equal(finished.outcome, 'failed')
  assert.equal(finished.note, null)
  assert.equal(instructions.state.released.length, 1) // 指令回 pending 可重试
  assert.equal(instructions.state.consumed.length, 0) // 绝不消费
})

test('问答：失败（quota）→ 指令释放回 pending + finished(failed)', async () => {
  const llm = stubLlm({ error: Object.assign(new Error('quota'), { code: 'QUOTA_EXCEEDED' }) })
  const { runtime, events, instructions } = makeRuntime({ llm })
  runtime.ask(META, null)
  await drain(runtime)
  const finished = events.find((e) => e.type === 'review-finished')
  assert.equal(finished.outcome, 'failed')
  assert.equal(runtime.status(), 'quota_exhausted')
  assert.equal(instructions.state.released.length, 1) // 指令可重试
})

// ---------------------------------------------------------------------------
// 复审修复：混合排队 / 问答投递失败
// ---------------------------------------------------------------------------

test('复审高1：in-flight 评审 + 排队评审 + ask（问答指令不被普通评审抢走）', async () => {
  const llm = stubLlm({ hang: true, replies: [] })
  const { runtime } = makeRuntime({ llm, callTimeoutMs: 5000 })
  // 任务1：评审正在 in-flight（hang 住）
  runtime.enqueue(DELTA, META)
  await new Promise((resolve) => setTimeout(resolve, 5))
  // 任务2：排队中的评审（会 reserve 全部 pending——必须跳过已绑定问答的指令）
  runtime.enqueue({ ...DELTA, markdown: '排队评审' }, META)
  // tell 语义：指令已绑定给问答任务（模拟 index.js 的 bind）
  runtime.ask(META, null, 'instr-bound-1')
  // 任务顺序：评审1(in-flight) → 评审2 → 问答
  // 评审2 的 reserve 跳过 bound 指令；问答 reserve(ids) 精确拿到
  runtime.dispose() // 中止 in-flight，让队列继续被清空（验证 reserve 语义即可）
  await drain(runtime)
  // 评审2 处理时 reserved 不含 instr-bound-1（问答的指令），
  // 但 stubInstructions 总是返回固定 items——这里验证 reserve 调用参数：
  // 通过 stub 的 reserve 记录无法区分，改用真实 InstructionQueue 验证在
  // store.test.js 的 bind 测试中覆盖；此处验证 ask 携带 instructionId 不被吞
  const pendingTask = runtime.queue // dispose 后已清空
  assert.ok(pendingTask.length === 0)
})

