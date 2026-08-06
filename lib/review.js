/**
 * dsh-memory-evolve — in-turn memory review.
 *
 * The main LLM reviews its own session (it holds the full context — no
 * subagent, no digest, no transcript reconstruction). The plugin only
 * provides the pace-maker and the write paths:
 *
 *   pace    `agent/settled` counts completed message-triggered turns per
 *           session; when the count reaches `reviewInterval` the review is
 *           DUE. The counter is never auto-reset — only the model's
 *           `memory_review_status complete` call resets it, so a missed or
 *           interrupted review stays due on the next turn instead of being
 *           silently dropped. Subagent sessions are not counted.
 *
 *   hint    the snapshot carries a static review section (fixed text, no
 *           content) telling the model to check `memory_review_status` at the
 *           end of every turn and, when due, silently run the review: suggest
 *           global-track facts (memory_suggest) or write them directly in
 *           auto mode, optionally touch skills (skill_manage), then complete.
 *
 *   output  suggest mode appends to the SUGGESTIONS.jsonl queue (the
 *           "learned track"), confirmed by the user through the
 *           `memory_review` command or the settings panel. auto mode writes
 *           global memory directly (the main session is not gated).
 *
 * Zero runtime dependencies.
 *
 * @module dsh-memory-evolve/review
 */

/**
 * Install the per-session review turn counter.
 * @param {object} ctx - a context with `on` (Cordis event bus).
 * @param {() => object} getRuntime - resolves live runtime config.
 * @returns {{turnsOf: (agent?: object) => number, complete: (agent?: object) => void}}
 *   the counter handle: `turnsOf` reads the count for one agent,
 *   `complete` resets it (called by the model after a finished review).
 */
export function reviewTurnCounter(ctx, getRuntime) {
  /** agentId → number of completed user turns since the last review. */
  const perSession = new Map()

  ctx.on('agent/settled', (agent, turn, reason) => {
    if (agent.session.header.origin === 'subagent') return
    if (!getRuntime().reviewEnabled) return
    if (reason.kind !== 'completed') return
    // Count only message-triggered turns (retries and injections are not user turns).
    const events = agent.session.events
    let messageTurn = false
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'turn/start' && event.data.turn === turn) {
        messageTurn = event.data.trigger.kind === 'message'
        break
      }
    }
    if (!messageTurn) return
    const state = perSession.get(agent.id) ?? { turns: 0 }
    state.turns += 1
    // Never reset here: due stays sticky until the model completes the review
    // via `memory_review_status complete`, so a missed turn cannot silently
    // drop the review.
    perSession.set(agent.id, state)
  })

  return {
    turnsOf: (agent) => perSession.get(agent?.id)?.turns ?? 0,
    complete: (agent) => { perSession.delete(agent?.id) },
  }
}

/**
 * Build the `memory_review_status` tool definition. The model queries it at
 * the end of every turn; the returned `due` flag is authoritative (the
 * interval is configurable, so the snapshot hint deliberately never embeds
 * the number).
 * @param {() => object} getRuntime - resolves live runtime config.
 * @param {{turnsOf: (agent?: object) => number, complete: (agent?: object) => void}} counter
 *   the review turn counter.
 * @returns {object} a ToolDefinition-shaped object for ctx.tools.register.
 */
export function reviewStatusTool(getRuntime, counter) {
  return {
    name: 'memory_review_status',
    description: '查询或完成每 N 个用户回合的自动记忆审查。check：返回是否到期（due）与距上次审查的回合数——到期判断以此工具返回为准，不要自行数回合；complete：审查全部执行完毕后调用，复位计数。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['check', 'complete'],
          description: 'check=查询审查是否到期；complete=完成审查后复位计数',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          due: { type: 'boolean' },
          turnsSinceReview: { type: 'integer' },
          interval: { type: 'integer' },
          mode: { type: 'string' },
          skillReviewEnabled: { type: 'boolean' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: value.message ?? '' }],
    },
    async execute(args, exec) {
      if (args.action === 'complete') {
        const runtime = getRuntime()
        const turns = counter.turnsOf(exec?.agent)
        if (turns < runtime.reviewInterval) {
          return { ok: true, message: `审查未到期（${turns}/${runtime.reviewInterval}），无需复位，计数保持不变。` }
        }
        counter.complete(exec?.agent)
        return { ok: true, message: '审查计数已复位（下次到期按新间隔重新计数）。' }
      }
      const runtime = getRuntime()
      const turns = counter.turnsOf(exec?.agent)
      const due = turns >= runtime.reviewInterval
      const message = due
        ? `记忆审查已到期（距上次审查 ${turns} 个回合，间隔 ${runtime.reviewInterval}）：执行审查，完成后必须调用 complete 复位。`
        : `记忆审查未到期（距上次审查 ${turns}/${runtime.reviewInterval} 个回合），本轮无需审查（也不要调用 complete）。`
      return {
        ok: true,
        message,
        due,
        turnsSinceReview: turns,
        interval: runtime.reviewInterval,
        mode: runtime.reviewMode,
        skillReviewEnabled: !!runtime.skillReviewEnabled,
      }
    },
  }
}

/**
 * Build the `memory_suggest` tool definition (suggest mode write path).
 * Repeated suggestions of the same content are deduplicated: the queue keeps
 * ONE pending entry per (target, content) and bumps its `hits` counter, so a
 * fact that keeps resurfacing in reviews accumulates a visible frequency the
 * user can weigh when confirming.
 * @param {object} config - resolved plugin config.
 * @param {import('./store.js').SuggestionQueue} queue - the suggestion queue.
 * @returns {object} a ToolDefinition-shaped object for ctx.tools.register.
 */
export function suggestToolDefinition(config, queue) {
  return {
    name: config.suggestToolName,
    description: '提出一条长期记忆建议（记忆审查使用）。不会直接修改记忆，只会加入待用户确认的队列；重复内容会累计建议次数。',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['memory', 'user'],
          description: '记忆轨：memory=环境/项目事实，user=用户事实',
        },
        content: {
          type: 'string',
          description: '建议记忆的条目内容（可多行）',
        },
        reason: {
          type: 'string',
          description: '为什么值得记住（引用会话中的证据）',
        },
      },
      required: ['target', 'content', 'reason'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          queued: { type: 'integer' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: value.message ?? '' }],
    },
    async execute(args, exec) {
      const target = args.target
      const content = String(args.content ?? '').trim()
      const reason = String(args.reason ?? '').trim()
      if (target !== 'memory' && target !== 'user') {
        return { ok: false, message: `无效 target "${target}"（应为 memory 或 user）` }
      }
      if (!content) return { ok: false, message: 'content 不能为空' }
      if (!reason) return { ok: false, message: 'reason 不能为空（必须引用会话中的证据）' }
      const now = new Date().toISOString()
      return queue.mutate((entries) => {
        const normalized = normalizeWhitespace(content)
        // Same track + overlapping text = the same fact resurfacing: bump the
        // existing pending entry instead of stacking duplicates.
        const existing = entries.find((entry) => entry.target === target
          && (normalizeWhitespace(entry.content) === normalized
            || normalizeWhitespace(entry.content).includes(normalized)
            || normalized.includes(normalizeWhitespace(entry.content))))
        if (existing) {
          existing.hits = (existing.hits ?? 1) + 1
          existing.lastSeen = now
          existing.reason = reason
          return {
            ok: true,
            message: `该建议此前已提出（累计第 ${existing.hits} 次），已更新证据，等待用户确认`,
            queued: entries.length,
          }
        }
        entries.push({
          time: now,
          sessionId: exec?.agent?.id ?? null,
          cwd: exec?.agent?.session?.header?.cwd ?? null,
          target,
          content,
          reason,
          hits: 1,
          firstSeen: now,
          lastSeen: now,
        })
        return { ok: true, queued: entries.length }
      })
    },
  }
}

/** Collapse internal whitespace runs for suggestion dedup matching. */
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Approve suggestions by 1-based index: write each into its memory track and
 * drop it from the queue. Project-track entries are written with the cwd they
 * were suggested under (falling back to `agent` when the entry has none).
 * @param {import('./store.js').MemoryStore} store - the memory store.
 * @param {import('./store.js').SuggestionQueue} queue - the suggestion queue.
 * @param {number[]} indices - 1-based indices into the current queue.
 * @param {object | undefined} agent - fallback agent for cwd-less entries.
 * @param {Map<number, string> | undefined} edits - optional per-index edited
 *   content (1-based), used instead of the suggested content when present.
 * @returns {{lines: string[], remaining: number}} a report for callers.
 */
export function approveSuggestions(store, queue, indices, agent, edits) {
  return queue.mutate((entries) => {
    const kept = []
    const lines = []
    entries.forEach((entry, index) => {
      const number = index + 1
      if (!indices.includes(number)) {
        kept.push(entry)
        return
      }
      const writeAgent = entry.cwd
        ? { session: { header: { cwd: entry.cwd } } }
        : agent
      // An edit that is empty (or whitespace) means "no edit": fall back to the
      // suggested content instead of attempting to write an empty entry.
      const edited = edits?.get(number)?.trim()
      const content = edited ? edited : entry.content
      const outcome = store.add(entry.target, content, writeAgent)
      if (outcome.ok) {
        lines.push(`✓ #${number} [${entry.target}] 已写入记忆`)
      } else if (outcome.message.includes('已存在')) {
        lines.push(`- #${number} [${entry.target}] 已存在，跳过`)
      } else {
        lines.push(`✗ #${number} [${entry.target}] ${outcome.message}`)
        kept.push(entry)
      }
    })
    entries.length = 0
    entries.push(...kept)
    return { lines, remaining: kept.length }
  })
}

/**
 * Reject suggestions by 1-based index: drop them from the queue.
 * @param {import('./store.js').SuggestionQueue} queue - the suggestion queue.
 * @param {number[]} indices - 1-based indices into the current queue.
 * @returns {{removed: number, remaining: number}} a report for callers.
 */
export function rejectSuggestions(queue, indices) {
  return queue.mutate((entries) => {
    const kept = []
    let removed = 0
    entries.forEach((entry, index) => {
      if (indices.includes(index + 1)) removed += 1
      else kept.push(entry)
    })
    entries.length = 0
    entries.push(...kept)
    return { removed, remaining: kept.length }
  })
}

/**
 * Build the `memory_review` slash-command definition.
 * @param {object} config - resolved plugin config.
 * @param {import('./store.js').MemoryStore} store - the memory store.
 * @param {import('./store.js').SuggestionQueue} queue - the suggestion queue.
 * @returns {object} a CommandDefinition-shaped object for ctx.commands.register.
 */
export function reviewCommand(config, store, queue) {
  const formatEntry = (entry, index) => `${index + 1}. [${entry.target}] ${entry.content}（理由：${entry.reason ?? '无'}）`

  return {
    name: config.commandName,
    description: '查看和管理记忆审查产生的建议：list 列出，approve <序号> 采纳，reject <序号> 拒绝，approve-all / reject-all 批量处理',
    input: {
      syntax: 'list | approve <n>… | reject <n>… | approve-all | reject-all',
      hint: '不填参数时默认 list',
    },
    handler(invocation) {
      const tokens = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
      const op = (tokens[0] ?? 'list').toLowerCase()
      const indices = tokens.slice(1).map((token) => Number(token))
      const validIndices = indices.length > 0 && indices.every((value) => Number.isInteger(value) && value >= 1)

      switch (op) {
        case 'list': {
          const entries = queue.read()
          if (entries.length === 0) return { kind: 'success', text: '没有待确认的记忆建议。' }
          const lines = entries.map(formatEntry)
          return { kind: 'success', text: `待确认的记忆建议（${entries.length} 条）：\n${lines.join('\n')}` }
        }
        case 'approve': {
          if (!validIndices) return { kind: 'error', text: '用法：approve <序号>…（序号来自 list）' }
          const report = approveSuggestions(store, queue, indices, invocation.agent)
          return {
            kind: 'success',
            text: `${report.lines.join('\n')}\n剩余待确认：${report.remaining} 条`,
          }
        }
        case 'reject': {
          if (!validIndices) return { kind: 'error', text: '用法：reject <序号>…（序号来自 list）' }
          const report = rejectSuggestions(queue, indices)
          return {
            kind: 'success',
            text: `已拒绝 ${report.removed} 条建议。剩余待确认：${report.remaining} 条`,
          }
        }
        case 'approve-all': {
          const all = Array.from({ length: queue.read().length }, (_, i) => i + 1)
          const report = approveSuggestions(store, queue, all, invocation.agent)
          return {
            kind: 'success',
            text: `${report.lines.join('\n')}\n剩余待确认：${report.remaining} 条`,
          }
        }
        case 'reject-all': {
          const report = rejectSuggestions(queue, Array.from({ length: queue.read().length }, (_, i) => i + 1))
          return { kind: 'success', text: `已拒绝全部 ${report.removed} 条建议。` }
        }
        default:
          return { kind: 'error', text: `未知操作 "${op}"（支持：list / approve / reject / approve-all / reject-all）` }
      }
    },
  }
}
