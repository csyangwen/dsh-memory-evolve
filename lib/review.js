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
 *   material the tail of the session's authoritative event log, rebuilt by
 *             buildDigest() — the child never accesses the live session.
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

import { buildDigest } from './digest.js'

/** Safety cap for one review run (a child that never settles releases the slot). */
const REVIEW_SAFETY_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Build the review prompt handed to the review subagent. One subagent covers
 * both tracks: memory suggestions AND skill creation/optimization (the
 * Hermes combined-review design).
 * @param {string} digest - the transcript digest.
 * @param {object} config - resolved plugin config (reviewMode etc.).
 * @returns {string} the prompt text.
 */
export function buildReviewPrompt(digest, config) {
  const writeInstruction = config.reviewMode === 'auto'
    ? '你将使用 memory 工具直接写入；每次写入前系统会向用户请求批准，被拒绝时停止该条目。'
    : `你将使用 ${config.suggestToolName} 工具提出建议（不会直接修改记忆）。`
  const trackInstruction = `记忆写入通道（三层隔离）：
- 全局事实（target: memory / user，每会话注入）→ 只能用 ${config.suggestToolName} 提建议，等待用户确认；直接调用 memory 工具写全局会被拒绝。
- 项目记忆（target: project，仅当前项目会话可见）→ 用 memory 工具直接写入（自动沉淀，隔离安全）。
- 今日日志（target: daily，按需读取不注入）→ 用 memory 工具直接写入（自动沉淀），格式为当天做了什么/重要进展，1-2 条即可。`
  const skillSection = config.skillReviewEnabled ? `

## 技能审查（同一份转录，同步进行）

判断是否有值得沉淀为技能的**可复用经验**（操作流程、命令组合、调试路径、踩坑教训、工具用法）：
- 已有技能缺步骤或有过时内容 → 优化它（优先）
- 没有合适技能 → 创建新技能

流程：
1. 先调用 ${config.skillManageToolName} action=list 查看已有技能，避免重复创建；
2. 若已有合适技能 → ${config.skillManageToolName} action=read 读取全文 → 确认问题 → action=patch 提交完整修订版（必须先 read 过，否则会被拒绝）；
3. 若无合适技能 → ${config.skillManageToolName} action=create 创建。

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

  return `你是 DSH 的后台记忆审查员。你只能看到下面这段会话转录摘录，无法访问原会话，也不要尝试读取任何文件。

【转录摘录开始】
${digest}
【转录摘录结束】

任务：判断转录中是否有值得长期记住的内容。
- 用户透露的个人信息、偏好、沟通/工作方式、期待 → 建议写入 user 轨（target: "user"）
- 环境 / 项目事实、工具使用要点、惯例、非平凡的技术方案 → 建议写入 memory 轨（target: "memory"）

对每条候选调用 ${config.suggestToolName} 工具（提供 target / content / reason），最多 2 条。
没有值得记住的内容时，直接回复 "Nothing to save." 并停止。

${writeInstruction}

${trackInstruction}
${skillSection}
禁止沉淀（这些会变成日后咬人的自我约束）：
- 一次性任务叙事（"总结了今天的行情"这类）；瞬时错误；环境依赖失败（缺二进制、凭据未配置）
- 对工具或功能的负面断言（"X 工具不能用"、"无法做 Y"）
- 密钥、令牌、密码、API key 等敏感信息
- 会话中已经自行解决、重试即好的临时状态

只依据转录中实际出现的事实，不要脑补。`
}

/**
 * Build the `memory_suggest` tool definition (suggest mode write path).
 * @param {object} config - resolved plugin config.
 * @param {import('./store.js').SuggestionQueue} queue - the suggestion queue.
 * @returns {object} a ToolDefinition-shaped object for ctx.tools.register.
 */
export function suggestToolDefinition(config, queue) {
  return {
    name: config.suggestToolName,
    description: '提出一条长期记忆建议（仅后台记忆审查使用）。不会直接修改记忆，只会加入待用户确认的队列。',
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
      return queue.append({
        time: new Date().toISOString(),
        sessionId: exec?.agent?.id ?? null,
        target,
        content,
        reason,
      })
    },
  }
}

/**
 * Install the background review machinery on a context.
 * @param {object} ctx - a context with `get('subagents')` available at
 *   trigger time (subagents is optional; without it reviews are skipped).
 * @param {object} config - resolved plugin config.
 * @param {import('./store.js').MemoryStore} store - unused here but kept for
 *   interface symmetry with the command (future auto-apply).
 */
export function installReview(ctx, config, store) {
  /** sessionId → number of completed user turns since the last review. */
  const perSession = new Map()
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
    if (inFlight) return false
    const subagents = ctx.get('subagents')
    if (!subagents) return false
    if (!subagents.getProvider(config.reviewProviderName)) return false
    inFlight = true
    safetyTimer = setTimeout(() => {
      if (inFlight) {
        inFlight = false
        ctx.logger.warn('dsh-memory-evolve: 后台审查超时，已释放审查名额')
      }
    }, REVIEW_SAFETY_TIMEOUT_MS)
    safetyTimer.unref?.()

    const digest = buildDigest(agent.session, {
      maxEvents: config.reviewDigestEvents,
      maxChars: config.reviewDigestMaxChars,
      includeToolOutput: config.reviewDigestIncludeToolOutput,
    })
    if (!digest) {
      release()
      return false
    }
    const prompt = buildReviewPrompt(digest, config)
    // Whitelist: the memory tool (project/daily auto-writes; global tracks
    // are gated inside the tool), the suggest tool in suggest mode, plus the
    // skill tool when the skill track is enabled. Everything else is
    // invisible AND refused inside the review child.
    const allow = [config.toolName]
    if (config.reviewMode === 'suggest') allow.push(config.suggestToolName)
    if (config.skillReviewEnabled) allow.push(config.skillManageToolName)
    const request = {
      label: 'memory-review',
      prompt: [{ type: 'text', text: prompt }],
      parent: agent,
      signal: abort.signal,
      toolFilter: { allow },
    }
    if (config.reviewProvider || config.reviewModel) {
      request.agentOptions = {}
      if (config.reviewProvider) request.agentOptions.provider = config.reviewProvider
      if (config.reviewModel) request.agentOptions.model = config.reviewModel
    }
    subagents
      .start(config.reviewProviderName, request)
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
    if (state.turns < config.reviewInterval) {
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
    if (config.reviewFinalOnDispose && state && state.turns > 0
      && agent.session.header.origin !== 'subagent') {
      queueMicrotask(() => trigger(agent))
    }
  })

  ctx.effect(() => () => { abort.abort() }, 'dsh-memory-evolve: review abort')

  return { trigger }
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
          const report = queue.mutate((entries) => {
            const kept = []
            const lines = []
            entries.forEach((entry, index) => {
              const number = index + 1
              if (!indices.includes(number)) {
                kept.push(entry)
                return
              }
              const outcome = store.add(entry.target, entry.content)
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
          return {
            kind: 'success',
            text: `${report.lines.join('\n')}\n剩余待确认：${report.remaining} 条`,
          }
        }
        case 'reject': {
          if (!validIndices) return { kind: 'error', text: '用法：reject <序号>…（序号来自 list）' }
          const report = queue.mutate((entries) => {
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
          return {
            kind: 'success',
            text: `已拒绝 ${report.removed} 条建议。剩余待确认：${report.remaining} 条`,
          }
        }
        case 'approve-all': {
          const report = queue.mutate((entries) => {
            const lines = []
            const kept = []
            for (const entry of entries) {
              const outcome = store.add(entry.target, entry.content)
              if (outcome.ok) {
                lines.push(`✓ [${entry.target}] 已写入记忆`)
              } else if (outcome.message.includes('已存在')) {
                lines.push(`- [${entry.target}] 已存在，跳过`)
              } else {
                lines.push(`✗ [${entry.target}] ${outcome.message}`)
                kept.push(entry)
              }
            }
            entries.length = 0
            entries.push(...kept)
            return { lines, remaining: kept.length }
          })
          return {
            kind: 'success',
            text: `${report.lines.join('\n')}\n剩余待确认：${report.remaining} 条`,
          }
        }
        case 'reject-all': {
          const count = queue.mutate((entries) => {
            const total = entries.length
            entries.length = 0
            return total
          })
          return { kind: 'success', text: `已拒绝全部 ${count} 条建议。` }
        }
        default:
          return { kind: 'error', text: `未知操作 "${op}"（支持：list / approve / reject / approve-all / reject-all）` }
      }
    },
  }
}
