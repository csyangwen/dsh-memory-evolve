/**
 * dsh-memory-evolve — Hermes-style long-term memory and background memory
 * review for DeepSeek Harness. Pure plugin: only public seams
 * (`systemPrompt`, `tools`, `commands`, `subagents`, `approval`), zero DSH
 * core changes, zero runtime dependencies.
 *
 * Two memory tracks:
 *   - user track (MEMORY.md / USER.md): written only by explicit user action
 *     (the `memory` tool call) or by user-confirmed suggestions;
 *   - learned track (SUGGESTIONS.jsonl): background reviews propose, the
 *     user confirms through `/memory_review`.
 *
 * The snapshot is injected as a `systemPrompt` context: DSH materializes it
 * as a user-role tail message and only re-appends when the rendered text
 * changes, so the stable system/history prefix (and its cache) is preserved.
 * Hermes memories (`~/.hermes/memories`, when present) are injected
 * read-only and never written.
 *
 * @module dsh-memory-evolve
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { MemoryStore, SuggestionQueue, parseEntries, todayStamp } from './store.js'
import { installReview, reviewCommand, suggestToolDefinition } from './review.js'
import { skillManageTool } from './skills.js'
import { installApi } from './api.js'

export const name = 'dsh-memory-evolve'
export const inject = ['tools', 'systemPrompt']

/** Plugin config defaults (conservative: review off, memory on). */
const DEFAULTS = {
  // storage
  memoryDir: null, // null → <dshHome>/memories
  memoryCharLimit: 2200,
  userCharLimit: 1375,
  entryDatePrefix: true,
  // hermes read-only injection (off by default; string enables)
  hermesMemoriesDir: null,
  hermesCharLimit: 4000,
  // daily / project memory
  dailyCharLimit: 8000,
  projectCharLimit: 2200,
  injectProjectMemory: true,
  injectDailySummary: true,
  // snapshot injection
  injectMemory: true,
  snapshotOrder: 500,
  injectionScan: true,
  // tools / command names
  toolName: 'memory',
  suggestToolName: 'memory_suggest',
  commandName: 'memory_review',
  skillManageToolName: 'skill_manage',
  // skill management
  skillDir: null, // null → ~/.agents/skills (shared with Hermes external dirs)
  skillMaxBytes: 65536,
  // background review
  reviewEnabled: false,
  reviewInterval: 5,
  reviewDigestEvents: 24,
  reviewDigestMaxChars: 12000,
  reviewDigestIncludeToolOutput: false,
  reviewProvider: null,
  reviewModel: null,
  reviewMode: 'suggest', // 'suggest' | 'auto'
  reviewTools: ['memory'],
  reviewProviderName: 'spawn',
  skillReviewEnabled: true,
  reviewFinalOnDispose: true,
  reviewNowCommandName: 'memory_now',
  autoApproveGlobal: false, // global tracks (user/memory) auto-written by review children
  suggestionsFile: null, // null → <memoryDir>/SUGGESTIONS.jsonl
  stateFile: null, // null → <memoryDir>/plugin-state.json (runtime config overrides)
}

/** Keys the Web UI may change at runtime (persisted to stateFile). */
const RUNTIME_KEYS = [
  'reviewEnabled', 'reviewInterval', 'reviewMode', 'skillReviewEnabled',
  'reviewProvider', 'reviewModel', 'injectProjectMemory', 'injectDailySummary',
  'autoApproveGlobal',
]

/** Validate one runtime-config patch value against its key. */
export function validateRuntimePatch(key, value) {
  switch (key) {
    case 'reviewEnabled':
    case 'skillReviewEnabled':
    case 'injectProjectMemory':
    case 'injectDailySummary':
    case 'autoApproveGlobal':
      if (typeof value !== 'boolean') throw new Error(`dsh-memory-evolve: ${key} 必须是布尔值`)
      return
    case 'reviewInterval':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
        throw new Error('dsh-memory-evolve: reviewInterval 必须 >= 1')
      }
      return
    case 'reviewMode':
      if (value !== 'suggest' && value !== 'auto') throw new Error('dsh-memory-evolve: reviewMode 必须是 "suggest" 或 "auto"')
      return
    case 'reviewProvider':
    case 'reviewModel':
      if (value !== null && typeof value !== 'string') throw new Error(`dsh-memory-evolve: ${key} 必须是字符串或 null`)
      return
    default:
      throw new Error(`dsh-memory-evolve: 不可运行的配置项 "${key}"`)
  }
}

/** Load persisted runtime overrides (stateFile); a missing file is empty. */
function loadState(stateFile) {
  try {
    const text = readFileSync(stateFile, 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

/** Atomically persist runtime overrides. */
function saveState(stateFile, state) {
  writeFileSync(`${stateFile}.tmp.${process.pid}`, JSON.stringify(state, null, 2) + '\n')
  renameSync(`${stateFile}.tmp.${process.pid}`, stateFile)
}

const POSITIVE_NUMBER_KEYS = [
  'memoryCharLimit', 'userCharLimit', 'hermesCharLimit', 'snapshotOrder',
  'reviewInterval', 'reviewDigestEvents', 'reviewDigestMaxChars', 'skillMaxBytes',
  'dailyCharLimit', 'projectCharLimit',
]
const BOOLEAN_KEYS = [
  'injectMemory', 'injectionScan', 'reviewEnabled', 'reviewDigestIncludeToolOutput',
  'skillReviewEnabled', 'entryDatePrefix', 'injectProjectMemory', 'injectDailySummary',
  'reviewFinalOnDispose',
]
const STRING_KEYS = [
  'toolName', 'suggestToolName', 'commandName', 'reviewMode', 'reviewProviderName',
  'skillManageToolName', 'reviewNowCommandName',
]

/**
 * Validate raw config and fill defaults. Throws loud on invalid values so
 * misconfiguration fails at load.
 * @param {object} [raw] - the raw cordis config.
 * @returns {object} the resolved config.
 */
export function resolveConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-memory-evolve: 配置必须是对象')
  }
  const config = { ...DEFAULTS }
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (!(key in DEFAULTS)) throw new Error(`dsh-memory-evolve: 未知配置项 "${key}"`)
    config[key] = value
  }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  config.memoryDir = resolve(config.memoryDir ?? join(home, 'memories'))
  config.suggestionsFile = resolve(config.suggestionsFile ?? join(config.memoryDir, 'SUGGESTIONS.jsonl'))
  config.skillDir = resolve(config.skillDir ?? join(homedir(), '.agents', 'skills'))
  if (typeof config.hermesMemoriesDir === 'string') {
    config.hermesMemoriesDir = resolve(config.hermesMemoriesDir)
  } else if (config.hermesMemoriesDir !== null && config.hermesMemoriesDir !== undefined) {
    throw new Error('dsh-memory-evolve: hermesMemoriesDir 必须是路径字符串或 null')
  } else {
    config.hermesMemoriesDir = null
  }
  for (const key of POSITIVE_NUMBER_KEYS) {
    const value = config[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`dsh-memory-evolve: ${key} 必须是正数`)
    }
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof config[key] !== 'boolean') {
      throw new Error(`dsh-memory-evolve: ${key} 必须是布尔值`)
    }
  }
  for (const key of STRING_KEYS) {
    if (typeof config[key] !== 'string' || config[key].length === 0) {
      throw new Error(`dsh-memory-evolve: ${key} 必须是非空字符串`)
    }
  }
  if (config.reviewProvider !== null && typeof config.reviewProvider !== 'string') {
    throw new Error('dsh-memory-evolve: reviewProvider 必须是字符串或 null')
  }
  if (config.reviewModel !== null && typeof config.reviewModel !== 'string') {
    throw new Error('dsh-memory-evolve: reviewModel 必须是字符串或 null')
  }
  if (config.reviewMode !== 'suggest' && config.reviewMode !== 'auto') {
    throw new Error('dsh-memory-evolve: reviewMode 必须是 "suggest" 或 "auto"')
  }
  if (!Array.isArray(config.reviewTools) || config.reviewTools.length === 0
    || config.reviewTools.some((tool) => typeof tool !== 'string')) {
    throw new Error('dsh-memory-evolve: reviewTools 必须是非空字符串数组')
  }
  if (config.reviewInterval < 1) {
    throw new Error('dsh-memory-evolve: reviewInterval 必须 >= 1')
  }
  return config
}

/**
 * Render the memory snapshot injected into the model context. Live reads are
 * intentional: DSH's runtime-context materialization only appends when the
 * rendered text changes, so mid-session memory writes surface at the next
 * step as a tail message while the stable prefix stays cached.
 * @param {object} config - resolved config.
 * @param {MemoryStore} store - the memory store.
 * @returns {string} the snapshot text (empty when nothing is stored).
 */
export function renderSnapshot(config, store, agent) {
  const parts = []
  const memoryEntries = store.entriesOf('memory')
  const userEntries = store.entriesOf('user')
  if (memoryEntries.length > 0) {
    parts.push(`## 长期记忆（环境 / 项目事实）\n${memoryEntries.map((entry) => `- ${entry}`).join('\n')}`)
  }
  if (userEntries.length > 0) {
    parts.push(`## 用户档案\n${userEntries.map((entry) => `- ${entry}`).join('\n')}`)
  }
  // Per-project memory: only the CURRENT working directory's project file is
  // injected, so project A sessions never see project B memory.
  const cwd = agent?.session?.header?.cwd
  if (config.injectProjectMemory && cwd) {
    try {
      const projectEntries = store.entriesOf('project', agent)
      if (projectEntries.length > 0) {
        parts.push(`## 项目记忆（${cwd}）\n${projectEntries.map((entry) => `- ${entry}`).join('\n')}`)
      }
    } catch {
      // project memory is optional; a missing cwd context must not break assembly
    }
  }
  // Daily log: only a one-line summary is injected — the log itself is read
  // on demand through the memory tool (target=daily), never fully injected.
  if (config.injectDailySummary) {
    try {
      const dailyCount = store.entriesOf('daily').length
      if (dailyCount > 0) {
        parts.push(`## 今日记忆\n今日已记录 ${dailyCount} 条（可用 memory 工具 target=daily 查看）`)
      }
    } catch {
      // best effort
    }
  }
  if (config.hermesMemoriesDir) {
    const hermes = readHermesMemories(config.hermesMemoriesDir, config.hermesCharLimit)
    if (hermes) parts.push(`## Hermes 记忆（只读，来自 ${config.hermesMemoriesDir}）\n${hermes}`)
  }
  return parts.join('\n\n')
}

/** Read Hermes memory files (best effort, read-only, capped). */
function readHermesMemories(dir, limit) {
  const entries = []
  for (const file of ['MEMORY.md', 'USER.md']) {
    try {
      entries.push(...parseEntries(readFileSync(join(dir, file), 'utf8')))
    } catch (error) {
      if (error.code === 'ENOENT') continue
      return undefined // unreadable directory → skip the whole block
    }
  }
  if (entries.length === 0) return undefined
  let text = entries.map((entry) => `- ${entry}`).join('\n')
  if (text.length > limit) text = `${text.slice(0, limit)}…`
  return text
}

/** Render the memory tool result as model/UI text. */
function renderMemoryResult(value) {
  const lines = [value.message ?? '']
  if (Array.isArray(value.entries) && value.entries.length > 0) {
    lines.push(`当前条目（${value.entries.length} 条）：`)
    value.entries.forEach((entry, index) => lines.push(`${index + 1}. ${entry}`))
  }
  if (Array.isArray(value.matches) && value.matches.length > 0) {
    lines.push('命中的条目：')
    value.matches.forEach((entry, index) => lines.push(`${index + 1}. ${entry}`))
  }
  return lines.join('\n')
}

/**
 * Build the `memory` tool definition.
 * @param {object} ctx - the plugin context (for optional approval).
 * @param {object} config - resolved config.
 * @param {MemoryStore} store - the memory store.
 * @returns {object} a ToolDefinition-shaped object.
 */
function memoryTool(ctx, config, store, getRuntime) {
  return {
    name: config.toolName,
    description: '读写长期记忆（跨会话持久，随上下文快照对模型可见）。target=memory 存全局环境/项目事实，target=user 存用户事实，target=project 存当前工作目录的项目记忆（仅当前项目会话可见），target=daily 追加今日日志（按需读取，不注入）。add 追加条目；replace 用唯一子串片段替换整个条目；remove 用唯一子串片段删除条目；list 查看全部条目。写入立即落盘，模型上下文将在下一次刷新时更新。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'replace', 'remove', 'list'],
          description: '要执行的操作',
        },
        target: {
          type: 'string',
          enum: ['memory', 'user', 'project', 'daily'],
          description: '记忆轨：memory=全局环境/项目事实，user=用户事实，project=当前项目记忆，daily=今日日志',
        },
        content: {
          type: 'string',
          description: 'add/replace 的新条目内容（可多行）',
        },
        match: {
          type: 'string',
          description: 'replace/remove 的匹配片段，必须唯一命中一个条目',
        },
      },
      required: ['action', 'target'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          target: { type: 'string' },
          entries: { type: 'array', items: { type: 'string' } },
          matches: { type: 'array', items: { type: 'string' } },
          chars: { type: 'integer' },
          limit: { type: 'integer' },
          backup: { type: 'string' },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: renderMemoryResult(value) }],
    },
    async execute(args, exec) {
      const target = args.target
      const action = args.action
      const origin = exec?.agent?.session?.header?.origin
      // Layered gate for subagent-origin writes: global tracks (memory/user,
      // injected every session) are the high-risk surface — refused in
      // suggest mode, approval-gated in auto mode. The isolated tracks
      // (project, scoped to one cwd; daily, never injected) are safe for
      // automatic background writes.
      if (origin === 'subagent' && (target === 'memory' || target === 'user')) {
        // autoApproveGlobal opts out of the confirmation gate entirely.
        if (getRuntime().autoApproveGlobal) {
          // fall through to the write
        } else if (getRuntime().reviewMode !== 'auto') {
          return {
            ok: false,
            message: `后台/子代理写入全局记忆被拒绝：请改用 ${getRuntime().suggestToolName} 提出建议（项目记忆与每日日志可直接写入）`,
            target,
          }
        } else {
          const approval = ctx.get('approval')
          if (!approval) {
            return { ok: false, message: '记忆写入需要用户批准，但当前没有可用的批准通道', target }
          }
          const outcome = await approval.request({
            agent: exec.agent,
            toolName: config.toolName,
            callId: exec.callId,
            reason: '后台记忆审查建议写入长期记忆',
            signal: exec.signal,
          })
          if (outcome !== 'allowed-once') {
            return { ok: false, message: `记忆写入未获批准（${outcome}）`, target }
          }
        }
      }
      let result
      try {
        switch (action) {
          case 'list': {
            const entries = store.entriesOf(target, exec.agent)
            result = {
              ok: true,
              message: `${target}：${entries.length} 条，${store.charsOf(target, exec.agent)}/${store.limitOf(target, exec.agent)} 字符`,
              target,
              entries: [...entries],
              chars: store.charsOf(target, exec.agent),
              limit: store.limitOf(target, exec.agent),
            }
            break
          }
          case 'add':
            result = store.add(target, args.content, exec.agent)
            break
          case 'replace':
            result = store.replace(target, args.match, args.content, exec.agent)
            break
          case 'remove':
            result = store.remove(target, args.match, exec.agent)
            break
          default:
            result = { ok: false, message: `未知操作 "${action}"（支持 add / replace / remove / list）`, target }
        }
      } catch (error) {
        // e.g. project memory without a session cwd
        result = { ok: false, message: error?.message ?? String(error), target }
      }
      return result
    },
  }
}

/**
 * The plugin entrypoint.
 * @param {object} ctx - the plugin context (`tools`, `systemPrompt` injected).
 * @param {object} [rawConfig] - raw cordis config.
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const store = new MemoryStore(config.memoryDir, config)
  const queue = new SuggestionQueue(config.suggestionsFile)
  const stateFile = resolve(config.stateFile ?? join(config.memoryDir, 'plugin-state.json'))

  // Runtime configuration: cordis config (static defaults) overlaid with the
  // persisted state file, which the Web settings panel updates live.
  const state = loadState(stateFile)
  const runtime = { ...config }
  for (const key of RUNTIME_KEYS) {
    if (state[key] !== undefined) runtime[key] = state[key]
  }
  const getRuntime = () => runtime
  const updateRuntime = (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      validateRuntimePatch(key, value)
      runtime[key] = value
      state[key] = value
    }
    saveState(stateFile, state)
    return { ...runtime }
  }

  // 1. Memory snapshot injection (frozen-ish: live reads, change-detected
  //    materialization keeps the cache prefix stable).
  if (config.injectMemory) {
    ctx.effect(() => ctx.systemPrompt.context({
      name: 'memory:snapshot',
      order: config.snapshotOrder,
      text: (context) => renderSnapshot(getRuntime(), store, context.agent),
    }), 'dsh-memory-evolve: memory snapshot')
  }

  // 2. The memory tool (always registered; subagent writes are gated).
  ctx.effect(() => ctx.tools.register(memoryTool(ctx, config, store, getRuntime)), 'dsh-memory-evolve: memory tool')

  // 2b. The skill management tool (always registered: useful in ordinary
  //     sessions too — "把这个流程做成技能" — and required by the review
  //     subagent for the skill track).
  ctx.effect(() => ctx.tools.register(skillManageTool(ctx, config)), 'dsh-memory-evolve: skill tool')

  // 3. Background review (opt-in): suggest tool + trigger + command.
  // Review machinery is installed whenever the plugin loads (config
  // reviewEnabled OR the runtime state), but the trigger/listeners consult
  // the live runtime — the settings panel can flip it without a reload.
  const reviewWanted = config.reviewEnabled || runtime.reviewEnabled
  let reviewApi = undefined
  if (reviewWanted) {
    ctx.effect(() => ctx.tools.register(suggestToolDefinition(config, queue)), 'dsh-memory-evolve: suggest tool')
    reviewApi = installReview(ctx, getRuntime, store)
  }

  // 4. Web API: the settings panel's data surface (web-only service; the
  //    plugin still loads on surfaces without httpServer).
  ctx.inject(['httpServer'], (webCtx) => {
    const resolveRevealTarget = (target) => {
      const today = todayStamp()
      const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
      const table = {
        memoryDir: config.memoryDir,
        memoryFile: join(config.memoryDir, 'MEMORY.md'),
        userFile: join(config.memoryDir, 'USER.md'),
        dailyDir: join(config.memoryDir, 'daily'),
        dailyFile: join(config.memoryDir, 'daily', `${today}.md`),
        projectsDir: join(config.memoryDir, 'projects'),
        skillDir: config.skillDir,
        agentsFile: join(dshHome, 'AGENTS.md'),
      }
      if (typeof target !== 'string' || !(target in table)) return undefined
      const path = table[target]
      // Whitelist: every reveal target is a fixed path derived from the
      // memory dir or the configured skill dir — no arbitrary paths.
      if (target === 'skillDir' || target === 'agentsFile') {
        return existsSync(path) ? path : undefined
      }
      if (target === 'memoryDir' || target === 'dailyDir' || target === 'projectsDir') {
        return existsSync(path) ? path : undefined
      }
      // Files: open the containing directory when the file does not exist yet
      // (e.g. today's daily log before the first write).
      return existsSync(path) ? path : table[target === 'dailyFile' ? 'dailyDir' : 'memoryDir']
    }
    const revealPath = (path) => {
      const command = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'explorer'
          : 'xdg-open'
      const child = spawn(command, [path], { stdio: 'ignore' })
      child.on('error', (error) => {
        webCtx.logger.warn(`dsh-memory-evolve: 打开路径失败 ${path}: ${error.message}`)
      })
    }
    webCtx.effect(() => installApi(webCtx, {
      store, queue, getRuntime, updateRuntime, resolveRevealTarget, revealPath,
    }), 'dsh-memory-evolve: web api')
  })

  // 5. Commands: the review command works even with review off (users may
  //    want to inspect/clean leftover suggestions); the manual-trigger
  //    command works whenever review is enabled. Registered when the
  //    commands service exists.
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.commands.register(reviewCommand(config, store, queue))
    if (reviewApi) {
      cmdCtx.commands.register({
        name: config.reviewNowCommandName,
        description: '立即对当前会话触发一次后台记忆审查（不受回合间隔限制）',
        handler(invocation) {
          if (invocation.agent.session.header.origin === 'subagent') {
            return { kind: 'error', text: '子代理会话不能触发记忆审查' }
          }
          if (!getRuntime().reviewEnabled) {
            return { kind: 'error', text: '后台审查未启用（可在 Web 设置 → 记忆管理 中开启）' }
          }
          const fired = reviewApi.trigger(invocation.agent)
          return fired
            ? { kind: 'success', text: '审查已触发，产出将在建议队列（SUGGESTIONS.jsonl）与技能库中体现。' }
            : { kind: 'error', text: '未能触发审查：已有审查进行中，或当前无可审查内容，请稍后再试。' }
        },
      })
    }
  })
}
