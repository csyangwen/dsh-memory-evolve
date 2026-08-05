/**
 * dsh-memory-evolve — background memory review.
 *
 * Hermes-style periodic reflection, mapped onto DSH seams:
 *
 *   trigger   `agent/settled` — count completed message-triggered turns per
 *             session; every `reviewInterval` turns, schedule one review.
 *             Subagent sessions (`origin: 'subagent'`) never trigger, so the
 *             review child cannot recursively review itself.
 *
 *   material the INCREMENTAL tail of the session's authoritative event log,
 *             rebuilt by buildDigest() from the events after the last review's
 *             watermark — periodic reviews never re-read settled turns, so the
 *             digest stays ≈ the interval's worth of dialogue. The child never
 *             accesses the live session.
 *
 *   execution ctx.subagents.start('spawn', …) with a toolFilter that only
 *             allows the suggestion tool (suggest mode) or the memory tool
 *             (auto mode, gated by user approval inside the tool). One review
 *             at a time; failures are logged and silent; a safety timer
 *             releases the slot if a child never settles.
 *
 *   output    suggest mode appends to the SUGGESTIONS.jsonl queue (the
 *             "learned track"), confirmed by the user through the
 *             `memory_review` command. auto mode writes memory directly after
 *             approval.
 *
 * Zero runtime dependencies.
 *
 * @module dsh-memory-evolve/review
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDigest } from './digest.js'

/** Safety cap for one review run (a child that never settles releases the slot). */
const REVIEW_SAFETY_TIMEOUT_MS = 15 * 60 * 1000
/** Cap on persisted per-session review watermarks (oldest entries drop first). */
const WATERMARK_LIMIT = 200

/**
 * Load the persisted review watermarks (sessionId → event-log length at the
 * last review). The watermark survives process restarts, so a periodic review
 * after `dsh web` restarts still only reads the turns since the last review.
 * @param {string} file - the JSONL watermarks file.
 * @returns {Record<string, number>} the loaded map.
 */
function loadWatermarks(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Persist the watermarks atomically, bounded to the newest entries.
 * @param {string} file - the JSONL watermarks file.
 * @param {Map<string, number>} watermarks - the in-memory map.
 */
function saveWatermarks(file, watermarks) {
  const entries = [...watermarks.entries()].slice(-WATERMARK_LIMIT)
  writeFileSync(`${file}.tmp.${process.pid}`, JSON.stringify(Object.fromEntries(entries)) + '\n')
  renameSync(`${file}.tmp.${process.pid}`, file)
}

/**
 * Build the review prompt handed to the review subagent. One subagent covers
 * both tracks: memory suggestions AND skill creation/optimization (the
 * Hermes combined-review design).
 * @param {string} digest - the transcript digest.
 * @param {object} config - resolved plugin config (reviewMode etc.).
 * @param {import('./store.js').MemoryStore | undefined} store - when given,
 *   the CURRENT global memory (MEMORY.md + USER.md entries) is rendered into
 *   the prompt so the reviewer dedupes against what already exists.
 * @returns {string} the prompt text.
 */
export function buildReviewPrompt(digest, config, store) {
  const writeInstruction = config.reviewMode === 'auto'
    ? '你将使用 memory 工具直接写入；每次写入前系统会向用户请求批准，被拒绝时停止该条目。'
    : `你将使用 ${config.suggestToolName} 工具提出建议（不会直接修改记忆）。`
  const existingMemory = store ? (() => {
    const parts = []
    const memoryEntries = store.entriesOf('memory')
    const userEntries = store.entriesOf('user')
    if (memoryEntries.length > 0) {
      parts.push(`## 长期记忆（环境 / 项目事实）\n${memoryEntries.map((entry) => `- ${entry}`).join('\n')}`)
    }
    if (userEntries.length > 0) {
      parts.push(`## 用户档案\n${userEntries.map((entry) => `- ${entry}`).join('\n')}`)
    }
    return parts.length > 0 ? parts.join('\n\n') : '（当前无全局记忆）'
  })() : '（未提供已有记忆数据）'
  const trackInstruction = `记忆写入通道（三层，松紧不同）：
- 今日日志（target: daily，按需读取不注入）→ 宽松：每个会话至少写 1 条，记录当天做了什么（任务、产出、重要进展、值得回顾的事），1-2 条即可；用 memory 工具直接写入。
- 项目记忆（target: project，仅当前项目会话可见）→ 宽松：本会话在工作目录做了实质工作（写文档/短文、改代码、调研、方案讨论、踩坑教训）→ 用 memory 工具直接写入至少 1 条（做了什么、关键决策/进展）；纯寒暄（如"你好"、"你是谁"）不记，无项目上下文时跳过。
- 全局事实（target: memory / user，每会话注入）→ 严格（宁缺毋滥）：仅用户透露的**稳定**个人信息、偏好、沟通/工作方式（需跨会话可复用，单次出现的行为不算偏好），或非平凡、**稳定**的环境/技术事实；用 ${config.suggestToolName} 提建议等待用户确认，最多 2 条，直接调用 memory 工具写全局会被拒绝。
**格式纪律（所有轨）：不要在内容中自行添加任何时间/日期前缀（如 "[2026-08-05]"、"[00:00]"、"深夜"）——你无法确知当前日期，程序会自动添加准确的时间戳（每日日志 [HH:MM]、项目记忆 [YYYY-MM-DD HH:MM]），直接从内容主体开始写。**`
  const skillSection = config.skillReviewEnabled ? `

## 技能审查（同一份转录，同步进行）

判断是否有值得沉淀为技能的**可复用经验**（操作流程、命令组合、调试路径、踩坑教训、工具用法）：
- 已有技能缺步骤或有过时内容 → 优化它（优先）
- 没有合适技能 → 创建新技能

**创建门槛（严格）**：技能会注入每个会话的系统提示词（技能目录全量注入），**创建务必克制**——只创建满足**全部**条件的高价值技能：
1. **多次尝试仍难解决**：本会话（或近期会话）反复尝试、多次踩坑才解决的问题，而不是一次成功；
2. **难度大**：步骤多、易错、非显而易见；
3. **后续可能多次复用**：同类任务会反复出现。
**一次性任务、简单任务（一次就会、无需查阅）不要创建**——想不出类级名称也说明不该创建。

流程：
1. 先调用 ${config.skillManageToolName} action=list 查看已有技能，避免重复创建；
2. 若已有合适技能 → ${config.skillManageToolName} action=read 读取全文 → 确认问题 → action=patch 提交完整修订版（必须先 read 过，否则会被拒绝；优化已有技能**不受创建门槛限制**）；
3. 若无合适技能且满足上面全部创建门槛 → ${config.skillManageToolName} action=create 创建。

注意：create 创建的技能会先进入**待确认队列**（不直接生效），等待用户在设置面板确认采纳后才会进入技能库；采纳前技能不会注入任何会话。若工具返回"待确认队列已有同名技能"，说明此前已创建过，请勿重复创建。

命名纪律（重要）：技能名必须是 kebab-case 的**类级名称**（如 systematic-debugging、github-pr-workflow），禁止 PR 号、错误串、功能代号、一次性任务名（如 fix-pr-123、debug-yesterday）。若想不出类级名称，说明不该创建。

SKILL.md 结构（create 时）——description 必须用双引号包裹（值含冒号+空格时未加引号会被 YAML 拒绝）：
---
name: <kebab-case>
description: "<一句话，写明何时使用>"
---
# <标题>
## 概览（何时使用、核心原则）
## 步骤（可执行的操作步骤）
## 命令 / 代码（可直接运行的命令）
## 坑与陷阱（踩过的坑、注意事项）
## 验证（如何确认做对了）

每轮审查最多 1 次技能操作（创建或优化其一）；若技能与记忆都有产出则都执行。` : ''

  return `你是 DSH 的后台记忆审查员。下面是本会话的转录摘录（增量摘要，只含上次审查以来的对话）。摘要信息不足时，你可以按需深读（见下文"可追溯信息"）；除此之外不要访问其他文件。

【转录摘录开始】
${digest}
【转录摘录结束】

【当前已有全局记忆】（以下是已确认写入的条目，**不要重复建议**同样的内容；如需覆盖或合并到已有条目，请在建议的 reason 中说明）
${existingMemory}

摘要只覆盖最近对话，且长内容可能被截断（中间省略处标注了省略字符数）。如需更多上下文，你可以（不需要时忽略，不要为读而读；工具不可用就跳过）：
- 读取本会话完整记录：agent_session_read 工具（source="dsh"，sessionId 见【会话信息】，可用 aroundSeq/window 定位到任意轮次）；
- 查看项目记忆：memory 工具（target=project，仅当前工作目录）；
- 查看今日日志：memory 工具（target=daily，按需读取）。
读取到的内容同样只作为判断依据，不要写入全局轨。

任务（按顺序执行）：
0. 先做要点提取：在回复开头输出"【转录要点】"——用户的要求与偏好、关键决策、遇到的问题与解决、产出物，各 1-2 行（转录中长内容可能被截断，中间省略处标注了省略的字符数，不要脑补被省略的内容）。
1. 今日日志：用 memory 工具写入本会话做了什么（target: "daily"）——宽松，至少 1 条（除非转录只有纯寒暄）。
2. 项目记忆：本会话有实质工作 → 用 memory 工具写入项目记忆（target: "project"）——宽松，至少 1 条。
3. 全局事实：根据要点提取，用户透露的个人信息、偏好、沟通/工作方式、期待 → 用 ${config.suggestToolName} 建议写入 user 轨（target: "user"）；非平凡的环境/技术事实、工具要点、惯例 → 建议写入 memory 轨（target: "memory"）——严格（宁缺毋滥），最多 2 条，没有就不提。

全局轨纪律（重要）：
- **先对照【当前已有全局记忆】查重**：已存在的条目不要重复建议；与已有条目高度相似的内容也不要建议（除非确有新增信息，且说明与哪条合并）。
- **技能优先**：可复用的操作方法、流程、调试路径、工具要点 → 走技能轨（${config.skillManageToolName}），不要建议进全局 memory（技能才是这类知识的归宿）。
- **单次信号不泛化**：只出现一次的行为/请求不算稳定偏好（如一次"写短一点"）；需至少 2 次独立信号才建议。
- **过时风险**：转录中对代码/配置/行为现状的描述可能已被后续修改推翻（代码演进很快）——不要建议"描述本身"；确有必要时，建议"该问题/位置存在"这类不会过时的表述。
- 同一次审查内，同一偏好只建议 1 条（合并多轮证据），不要拆分多条。

${writeInstruction}

${trackInstruction}
${skillSection}
禁止沉淀（仅针对全局轨 memory/user，这些会变成日后咬人的自我约束）：
- 一次性任务叙事（"写了篇短文"这类）；瞬时错误；环境依赖失败（缺二进制、凭据未配置）
- 对工具或功能的负面断言（"X 工具不能用"、"无法做 Y"）
- 密钥、令牌、密码、API key 等敏感信息
- 会话中已经自行解决、重试即好的临时状态
注意：daily 与 project 轨不受"一次性任务叙事"限制——"今天写了篇短文并依反馈修改"正是日志该记的内容。

只有转录纯属寒暄（"你好"、"你是谁"等，无实质内容）时，才直接回复 "Nothing to save." 并停止。
只依据转录中实际出现的事实，不要脑补。`
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
    description: '提出一条长期记忆建议（仅后台记忆审查使用）。不会直接修改记忆，只会加入待用户确认的队列；重复内容会累计建议次数。',
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
          description: '为什么值得记住（引用转录中的证据）',
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
      if (!reason) return { ok: false, message: 'reason 不能为空（必须引用转录中的证据）' }
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
 * Install the background review machinery on a context.
 * @param {object} ctx - a context with `get('subagents')` available at
 *   trigger time (subagents is optional; without it reviews are skipped).
 * @param {object} config - resolved plugin config.
 * @param {import('./store.js').MemoryStore} store - unused here but kept for
 *   interface symmetry with the command (future auto-apply).
 */
export function installReview(ctx, getRuntime, store) {
  /** sessionId → number of completed user turns since the last review. */
  const perSession = new Map()
  /** sessionId → event-log length at the last review (incremental watermark). */
  const watermarksFile = join(store.dir, 'review-watermarks.json')
  const lastReviewed = new Map(Object.entries(loadWatermarks(watermarksFile)))
  /** One review at a time; a busy slot skips (never queues). */
  let inFlight = false
  const abort = new AbortController()
  let safetyTimer

  const release = () => {
    inFlight = false
    if (safetyTimer) {
      clearTimeout(safetyTimer)
      safetyTimer = undefined
    }
  }

  /**
   * Schedule one review of an agent. Returns whether a review was actually
   * scheduled (false when one is in flight, the provider is missing, or the
   * session has no reviewable content).
   * @param {object} agent - the agent whose session tail to review.
   * @returns {boolean} true when a review was scheduled.
   */
  const trigger = (agent) => {
    const runtime = getRuntime()
    if (!runtime.reviewEnabled) return false
    if (inFlight) return false
    const subagents = ctx.get('subagents')
    if (!subagents) return false
    if (!subagents.getProvider(runtime.reviewProviderName)) return false
    inFlight = true
    safetyTimer = setTimeout(() => {
      if (inFlight) {
        inFlight = false
        ctx.logger.warn('dsh-memory-evolve: 后台审查超时，已释放审查名额')
      }
    }, REVIEW_SAFETY_TIMEOUT_MS)
    safetyTimer.unref?.()

    // Incremental digest: only the events after the last reviewed seq enter
    // the window, so a periodic review never re-reads already-settled turns
    // and the digest stays small (≈ the interval's worth of dialogue).
    const events = agent.session.events
    const fromSeq = lastReviewed.get(agent.id) ?? 0
    const digest = buildDigest(agent.session, {
      maxEvents: runtime.reviewDigestEvents,
      maxChars: runtime.reviewDigestMaxChars,
      fromSeq,
    })
    if (!digest) {
      release()
      return false
    }
    // Advance the watermark even if the child later fails: the window must
    // not grow without bound on repeated reviews of the same content. The
    // watermark is persisted so a process restart does not re-review the
    // whole session from turn 1.
    if (Array.isArray(events)) {
      lastReviewed.set(agent.id, events.length)
      saveWatermarks(watermarksFile, lastReviewed)
    }
    const prompt = buildReviewPrompt(digest, runtime, store)
    // Whitelist: the memory tool (project/daily auto-writes; global tracks
    // are gated inside the tool), the suggest tool in suggest mode, the
    // skill tool when the skill track is enabled, plus — when the
    // dsh-session-search plugin registered it — the session reader so the
    // reviewer can trace into the full conversation. Everything else is
    // invisible AND refused inside the review child. (An unknown name in the
    // allow list would fail the spawn, hence the existence check.)
    const allow = [runtime.toolName]
    if (runtime.reviewMode === 'suggest') allow.push(runtime.suggestToolName)
    if (runtime.skillReviewEnabled) allow.push(runtime.skillManageToolName)
    if (ctx.get('tools')?.get?.('agent_session_read') !== undefined) allow.push('agent_session_read')
    const request = {
      label: 'memory-review',
      prompt: [{ type: 'text', text: prompt }],
      parent: agent,
      signal: abort.signal,
      toolFilter: { allow },
    }
    if (runtime.reviewProvider || runtime.reviewModel) {
      request.agentOptions = {}
      if (runtime.reviewProvider) request.agentOptions.provider = runtime.reviewProvider
      if (runtime.reviewModel) request.agentOptions.model = runtime.reviewModel
    }
    subagents
      .start(runtime.reviewProviderName, request)
      .then((run) => run.result.then(
        (result) => {
          ctx.logger.info(`dsh-memory-evolve: 后台审查完成（${agent.id}，${result.stopReason}）`)
          return run.dispose()
        },
        (error) => {
          ctx.logger.warn(`dsh-memory-evolve: 后台审查子代理失败：${error?.message ?? error}`)
          return run.dispose()
        },
      ))
      .then(release, release)
    return true
  }

  ctx.on('agent/settled', (agent, turn, reason) => {
    // The review child itself is a subagent — never trigger on it.
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
    if (state.turns < getRuntime().reviewInterval) {
      perSession.set(agent.id, state)
      return
    }
    perSession.delete(agent.id)
    // Leave the emit path immediately: the review runs detached.
    queueMicrotask(() => trigger(agent))
  })

  ctx.on('agent/disposed', (agent) => {
    // Final review: a session that ended with user turns but never reached
    // the interval still gets one review pass (short tasks accumulate too).
    const state = perSession.get(agent.id)
    perSession.delete(agent.id)
    const runtime = getRuntime()
    if (runtime.reviewEnabled && runtime.reviewFinalOnDispose && state && state.turns > 0
      && agent.session.header.origin !== 'subagent') {
      queueMicrotask(() => trigger(agent))
    }
  })

  ctx.effect(() => () => { abort.abort() }, 'dsh-memory-evolve: review abort')

  return { trigger }
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
    description: '查看和管理后台记忆审查的建议：list 列出，approve <序号> 采纳，reject <序号> 拒绝，approve-all / reject-all 批量处理',
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
