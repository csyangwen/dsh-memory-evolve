/**
 * dsh-memory-evolve — in-turn memory review.
 *
 * The main LLM reviews its own session (it holds the full context — no
 * subagent, no digest, no transcript reconstruction). The plugin only
 * provides the pace-maker and the write paths:
 *
 *   pace    `agent/turn-stopping` counts completed message-triggered turns per
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

import { todayStamp } from './store.js'

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

  // 修复（2026-08-22，issue #24）：DSH 核心不发 `agent/settled`，回合
  // 正常结束时只发 `agent/turn-stopping`（packages/core/agent-loop/src/
  // agent.ts，payload={agent, turn, signal}）。原监听 `agent/settled`
  // 永不触发 → 轮次计数恒 0 → review 永不 due → 全局记忆轨永远无法
  // 产生。`agent/turn-stopping` 只在回合正常结束时触发（error/abort/
  // blocked 在 turn-stopping 之前 throw，到不了这里），天然过滤非正常
  // 回合，故不再需要 reason.kind==='completed' 判断（payload 也没有
  // reason 参数）。
  const onSettled = (payload) => {
    try {
      const agent = payload?.agent ?? payload
      if (!agent?.session) return
      if (agent.session.header.origin === 'subagent') return
      if (!getRuntime().reviewEnabled) return
      // Count only message-triggered turns (retries and injections are not user turns).
      // ⚠ 修复（issue #24 根因 3）：DSH 核心的 turn/start 会话事件 data
      // 只有 `{ turn }`（见 dsh-agent-loop `session.append('turn/start',
      // { turn })`），没有 `trigger` 字段——旧代码 `event.data.trigger.kind`
      // 必然抛 TypeError: Cannot read properties of undefined (reading
      // 'kind')，经 turn-stopping serial dispatch 冒泡导致整个回合被判
      // 失败（GUI 显示「本轮运行失败 … UNKNOWN」）。改为可选链 + 兜底：
      // trigger 缺失时按 message 计数——turn-stopping 仅在
      // inbox.nextStep.length === 0 时发出，next-step 注入回合已被排除，
      // 到达这里的都是用户消息回合；DSH 未来若补上 trigger 字段则自动
      // 恢复正常判定。
      const events = agent.session.events
      let messageTurn = false
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event?.type === 'turn/start') {
          const triggerKind = event.data?.trigger?.kind
          messageTurn = triggerKind === undefined || triggerKind === 'message'
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
    } catch (error) {
      // 事件回调抛异常会带崩回合（与 lib/prompts.js 同款防护）：审查
      // 计数只是节奏器，绝不能让插件异常污染回合结果。
      console.error('[memory-evolve review] turn-stopping 处理失败（已隔离，不影响回合）：', error)
    }
  }

  // 显式挂到 ctx 生命周期（P2-7）：ctx.on 返回的 disposer 交给 ctx.effect
  // 管理，插件卸载/热重载时自动移除监听器，避免重复注册导致重复计数
  ctx.effect(() => ctx.on('agent/turn-stopping', onSettled))

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
    description: '完成每 N 个用户回合的自动记忆审查。**无需每轮调用**：到期提醒由程序在快照中动态注入（出现「记忆审查已到期」提醒时才需要执行审查）；complete：审查全部执行完毕后调用，复位计数（漏做则下一轮继续提醒）；check：仅在你需要手动确认当前进度时调用（返回 due 与距上次审查的回合数）。',
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
          enum: ['memory', 'user', 'todo-life', 'todo-work', 'todo-project', 'todo-daily'],
          description: '轨：memory=环境/项目事实，user=用户事实；todo-life/todo-work/todo-project/todo-daily=待办建议（确认后写入对应待办轨）',
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
      const validTargets = ['memory', 'user', 'todo-life', 'todo-work', 'todo-project', 'todo-daily']
      if (!validTargets.includes(target)) {
        return { ok: false, message: `无效 target "${target}"（应为 ${validTargets.join('/')}）` }
      }
      if (!content) return { ok: false, message: 'content 不能为空' }
      if (!reason) return { ok: false, message: 'reason 不能为空（必须引用会话中的证据）' }
      return enqueueSuggestion(queue, target, content, reason, exec?.agent)
    },
  }
}

/** Collapse internal whitespace runs for suggestion dedup matching. */
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Enqueue one pending suggestion with dedup: same target + overlapping text
 * bump the existing entry's `hits` instead of stacking duplicates. Shared by
 * `memory_suggest` (review) and the memory tool's key-track writes (every
 * key write now requires user confirmation).
 * @param {import('./store.js').SuggestionQueue} queue - the suggestion queue.
 * @param {string} target - 'memory' | 'user' | 'key'.
 * @param {string} content - the suggested entry text.
 * @param {string | undefined} reason - why it is worth remembering.
 * @param {object | undefined} agent - the calling agent (id + cwd recorded).
 * @returns {{ok: boolean, message: string, queued: number}} the outcome.
 */
export function enqueueSuggestion(queue, target, content, reason, agent) {
  const now = new Date().toISOString()
  return queue.mutate((entries) => {
    const normalized = normalizeWhitespace(content)
    const existing = entries.find((entry) => entry.target === target
      && (normalizeWhitespace(entry.content) === normalized
        || normalizeWhitespace(entry.content).includes(normalized)
        || normalized.includes(normalizeWhitespace(entry.content))))
    if (existing) {
      existing.hits = (existing.hits ?? 1) + 1
      existing.lastSeen = now
      if (reason) existing.reason = reason
      return {
        ok: true,
        message: `该内容此前已建议（累计第 ${existing.hits} 次），已更新证据，等待用户确认`,
        queued: entries.length,
      }
    }
    entries.push({
      time: now,
      sessionId: agent?.id ?? null,
      cwd: agent?.session?.header?.cwd ?? null,
      target,
      content,
      reason: reason ?? null,
      hits: 1,
      firstSeen: now,
      lastSeen: now,
    })
    return { ok: true, queued: entries.length }
  })
}

/**
 * Approve suggestions by 1-based index: write each into its memory track and
 * drop it from the queue. Project-track entries are written with the cwd they
 * were suggested under (falling back to `agent` when the entry has none).
 * A per-index `targets` map overrides the suggested target — the user can
 * re-classify a fact into a more fitting memory track (e.g. memory → key)
 * without the AI re-suggesting it; absent entries keep the recommended
 * target. Todo suggestions can NEVER be re-classified: a todo stays a todo
 * (overrides are ignored for todo-* entries); memory suggestions can only
 * move between the three memory tracks (the API rejects todo-* picks).
 * @param {import('./store.js').MemoryStore} store - the memory store.
 * @param {import('./todo.js').TodoStore} todoStore - the todo store (for todo-* targets).
 * @param {import('./store.js').SuggestionQueue} queue - the suggestion queue.
 * @param {number[]} indices - 1-based indices into the current queue.
 * @param {object | undefined} agent - fallback agent for cwd-less entries.
 * @param {Map<number, string> | undefined} edits - optional per-index edited
 *   content (1-based), used instead of the suggested content when present.
 * @param {Map<number, string> | undefined} targets - optional per-index target
 *   override (1-based; 'memory' | 'user' | 'key' — todo-* entries ignore it).
 * @returns {{lines: string[], remaining: number}} a report for callers.
 */
export function approveSuggestions(store, todoStore, queue, indices, agent, edits, targets) {
  return queue.mutate((entries) => {
    const kept = []
    const lines = []
    entries.forEach((entry, index) => {
      const number = index + 1
      if (!indices.includes(number)) {
        kept.push(entry)
        return
      }
      // 待办建议只能留在待办轨（待办不能变成记忆）；记忆建议才可改分类
      const target = entry.target.startsWith('todo-')
        ? entry.target
        : (targets?.get(number) ?? entry.target)
      const writeAgent = entry.cwd
        ? { session: { header: { cwd: entry.cwd } } }
        : agent
      // An edit that is empty (or whitespace) means "no edit": fall back to the
      // suggested content instead of attempting to write an empty entry.
      const edited = edits?.get(number)?.trim()
      const content = edited ? edited : entry.content
      const isTodo = target.startsWith('todo-')
      let outcome
      if (isTodo) {
        outcome = todoStore.addTodo(target.slice(5), content, {}, entry.cwd ?? agent?.session?.header?.cwd)
      } else {
        try {
          // key 轨无 cwd 时 resolveTarget 会抛错——兜住并保留建议
          outcome = store.add(target, content, writeAgent)
        } catch (error) {
          outcome = { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      }
      if (outcome.ok) {
        lines.push(`✓ #${number} [${target}] 已写入${isTodo ? '待办' : '记忆'}`)
      } else if (outcome.message.includes('已存在')) {
        lines.push(`- #${number} [${target}] 已存在，跳过`)
      } else {
        lines.push(`✗ #${number} [${target}] ${outcome.message}`)
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
 * Archive suggestions by 1-based index: keep the content (with its reason)
 * in the low-priority archive files instead of writing it into the injected
 * tracks or dropping it. The suggestion leaves the queue; the archived entry
 * can later be promoted back into a main track or deleted from the panel.
 * @param {import('./store.js').ArchiveStore} archive - the archive store.
 * @param {import('./store.js').SuggestionQueue} queue - the suggestion queue.
 * @param {number[]} indices - 1-based indices into the current queue.
 * @returns {{lines: string[], remaining: number}} a report for callers.
 */
export function archiveSuggestions(archive, queue, indices) {
  return queue.mutate((entries) => {
    const kept = []
    const lines = []
    entries.forEach((entry, index) => {
      const number = index + 1
      if (!indices.includes(number)) {
        kept.push(entry)
        return
      }
      // todo-* 建议统一归档到 TODO-archive.md；条目内记录原轨，转正时写回
      // 对应待办轨（归档文件不按轨分文件，必须自描述）。
      const originTag = entry.target.startsWith('todo-') ? `\n（原轨：${entry.target}）` : ''
      const stamped = `[${todayStamp()}] ${entry.content}${originTag}${entry.reason ? `\n（归档理由：${entry.reason}）` : ''}`
      // key 建议归档到该项目的 KEY-archive.md（随项目走）
      const outcome = archive.append(entry.target, stamped, entry.cwd ?? undefined)
      if (outcome.ok) {
        lines.push(`📦 #${number} [${entry.target}] 已归档（不注入，可随时移回主记忆）`)
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
 * Promote one archived entry back into its main track: strip the program
 * stamp and the archive reason, then add the plain content (the store
 * re-stamps it with the current date). Branch-scope tags ([branch:…]) on key
 * entries survive the round-trip. The archived entry is removed on success.
 * @param {import('./store.js').MemoryStore} store - the memory store.
 * @param {import('./todo.js').TodoStore} todoStore - the todo store (for todo-* targets).
 * @param {import('./store.js').ArchiveStore} archive - the archive store.
 * @param {string} target - 'memory' | 'user' | 'key' | 'todo-*'.
 * @param {string} match - a substring uniquely identifying one archived entry.
 * @param {string | undefined} cwd - project cwd (required for 'key' / 'todo-project').
 * @returns {{ok: boolean, message: string}} the outcome.
 */
export function promoteArchived(store, todoStore, archive, target, match, cwd) {
  const entries = archive.entriesOf(target, cwd)
  const hits = entries.filter((entry) => entry.includes(match))
  if (hits.length === 0) return { ok: false, message: `归档中没有条目包含片段 "${match}"` }
  if (hits.length > 1) {
    return { ok: false, message: `片段 "${match}" 匹配到 ${hits.length} 个归档条目，请用更精确的片段` }
  }
  const raw = hits[0]
  // todo 归档条目带（原轨：todo-*）标记，转正写回对应待办轨
  const origin = /（原轨：([a-z-]+)）/.exec(raw)
  const writeTarget = target.startsWith('todo-') && origin ? origin[1] : target
  const content = raw
    .replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '')
    // 理由行在最后、原轨行在理由前：先剥理由，原轨行随后也落到行尾
    .replace(/\n（归档理由：[\s\S]*?）\s*$/, '')
    .replace(/\n（原轨：[^\n]*）\s*$/, '')
    .trim()
  if (!content) return { ok: false, message: '归档条目内容为空，无法转正' }
  const writeAgent = cwd ? { session: { header: { cwd } } } : undefined
  const outcome = writeTarget.startsWith('todo-')
    ? todoStore.addTodo(writeTarget.slice(5), content, {}, cwd)
    : store.add(writeTarget, content, writeAgent)
  if (!outcome.ok) return outcome
  archive.remove(target, match, cwd)
  return { ok: true, message: `已转正写入 ${writeTarget}（${content.length} 字符），归档条目已移除` }
}

/**
 * Build the `memory_review` slash-command definition.
 * @param {object} config - resolved plugin config.
 * @param {import('./store.js').MemoryStore} store - the memory store.
 * @param {import('./store.js').ArchiveStore} archive - the archive store.
 * @param {import('./store.js').SuggestionQueue} queue - the suggestion queue.
 * @returns {object} a CommandDefinition-shaped object for ctx.commands.register.
 */
export function reviewCommand(config, store, todoStore, archive, queue) {
  const formatEntry = (entry, index) => `${index + 1}. [${entry.target}] ${entry.content}（理由：${entry.reason ?? '无'}）`

  return {
    name: config.commandName,
    description: '查看和管理记忆审查产生的建议：list 列出，approve <序号> 采纳，archive <序号> 归档（保留备查，可移回主记忆），reject <序号> 拒绝，approve-all / reject-all 批量处理',
    input: {
      syntax: 'list | approve <n>… | archive <n>… | reject <n>… | approve-all | reject-all',
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
          const report = approveSuggestions(store, todoStore, queue, indices, invocation.agent)
          return {
            kind: 'success',
            text: `${report.lines.join('\n')}\n剩余待确认：${report.remaining} 条`,
          }
        }
        case 'archive': {
          if (!validIndices) return { kind: 'error', text: '用法：archive <序号>…（序号来自 list）' }
          const report = archiveSuggestions(archive, queue, indices)
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
          const report = approveSuggestions(store, todoStore, queue, all, invocation.agent)
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
          return { kind: 'error', text: `未知操作 "${op}"（支持：list / approve / archive / reject / approve-all / reject-all）` }
      }
    },
  }
}
