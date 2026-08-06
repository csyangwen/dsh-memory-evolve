/**
 * dsh-memory-evolve — persistent long-term memory and background memory
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
 * @module dsh-memory-evolve
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { MemoryStore, SuggestionQueue, todayStamp } from './store.js'
import { reviewCommand, reviewStatusTool, reviewTurnCounter, suggestToolDefinition } from './review.js'
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
  // daily / project memory (per-turn proactive writes — never injected, see renderSnapshot)
  dailyCharLimit: 16000,
  projectCharLimit: 2200,
  perTurnProjectWrites: true, // snapshot hint requires a per-turn project write check
  perTurnDailyWrites: true,   // snapshot hint requires a per-turn daily write check
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
  skillDir: null, // null → ~/.agents/skills (the DSH skill library)
  skillMaxBytes: 65536,
  // background review (in-turn, prompt-driven: the main LLM reviews itself
  // when the turn counter reaches the interval)
  reviewEnabled: false,
  reviewInterval: 5,
  reviewMode: 'suggest', // 'suggest' | 'auto' — suggest = global facts go through memory_suggest (user confirms); auto = direct memory writes
  skillReviewEnabled: false, // off by default: skill creations queue for user confirmation (on = direct, no approval)
  memoryTabEnabled: false, // session memory tab in the web GUI (default off)
  suggestionsFile: null, // null → <memoryDir>/SUGGESTIONS.jsonl
  stateFile: null, // null → <memoryDir>/plugin-state.json (runtime config overrides)
}

/** Keys the Web UI may change at runtime (persisted to stateFile). */
export const RUNTIME_KEYS = [
  'reviewEnabled', 'reviewInterval', 'reviewMode', 'skillReviewEnabled',
  'memoryTabEnabled', 'perTurnProjectWrites', 'perTurnDailyWrites',
]

/** Validate one runtime-config patch value against its key. */
export function validateRuntimePatch(key, value) {
  switch (key) {
    case 'reviewEnabled':
    case 'skillReviewEnabled':
    case 'memoryTabEnabled':
    case 'perTurnProjectWrites':
    case 'perTurnDailyWrites':
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
  'memoryCharLimit', 'userCharLimit', 'snapshotOrder',
  'reviewInterval', 'skillMaxBytes',
  'dailyCharLimit', 'projectCharLimit',
]
const BOOLEAN_KEYS = [
  'injectMemory', 'injectionScan', 'reviewEnabled', 'skillReviewEnabled',
  'entryDatePrefix', 'memoryTabEnabled',
  'perTurnProjectWrites', 'perTurnDailyWrites',
]
const STRING_KEYS = [
  'toolName', 'suggestToolName', 'commandName', 'reviewMode',
  'skillManageToolName',
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
  if (config.reviewMode !== 'suggest' && config.reviewMode !== 'auto') {
    throw new Error('dsh-memory-evolve: reviewMode 必须是 "suggest" 或 "auto"')
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
 * step as a tail message while the stable prefix stays cached. Only
 * slow-moving tracks (global memory/user) are rendered here: project memory
 * and the daily log change on every write, and injecting them would append a
 * new tail snapshot per turn and defeat prefix caching — they stay on-demand
 * via the memory tool, with a fixed per-turn write duty in the hint below.
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
  // Per-project memory and the daily log are deliberately NOT rendered into
  // the snapshot: they change on every write, and each change would append a
  // new runtime-context tail message, defeating LLM prefix caching. Instead
  // the stable hint below (fixed text for a given config, never varies with
  // content) requires the model to CHECK every turn for record-worthy facts
  // and write them via the memory tool right away — the program stamps
  // timestamps, so daily/project stay current without waiting for a review
  // round. Both tracks are user-toggleable at runtime (perTurnProjectWrites /
  // perTurnDailyWrites): a disabled track drops its write duty and the hint
  // falls back to on-demand reads. Subagent sessions get a restrained
  // variant: record one entry per independent achievement instead of a
  // per-turn duty, so bulk delegation does not flood the tracks.
  const isSubagent = agent?.session?.header?.origin === 'subagent'
  const writeTargets = [
    config.perTurnProjectWrites !== false
      ? '- 项目相关 → target=project（与已有条目同主题用 replace 更新、全新事实用 add）'
      : null,
    config.perTurnDailyWrites !== false
      ? '- 当天进展 → target=daily（与已有条目同主题用 replace 更新、全新事实用 add）'
      : null,
  ].filter(Boolean)
  const writeSection = writeTargets.length > 0
    ? (isSubagent
        ? `写入要求（子代理）：仅在完成**独立成果**时（一项实质产出、一个关键决策或踩坑结论），用 memory 工具向对应轨写入 1 条，保持简洁；没有独立成果就跳过，不要为写而写。
${writeTargets.join('\n')}`
        : `写入要求（重要）：**每个回合结束前、输出最终回复之前，调用一次 memory 工具**检查并记录本回合：
- 本回合有**任何实际产出或进展**（写了文档/请假条/代码、创作了内容、完成调研或任务、解决 bug、关键决策、踩坑教训、用户透露的偏好或事实）→ **必须写入 1 条**：当天进展 → target=daily；项目相关 → target=project（与已有条目同主题用 replace 更新、全新事实用 add）。写**具体做了什么**，1-2 行即可，不要写"继续处理 X"这类空话。
- 本回合**没有任何实质内容**（纯寒暄、纯问答无行动）→ 跳过，不要为写而写。
- **首写保险**：若今天还没有任何 daily 条目（可先 action=list target=daily 查看），本回合**必须**至少写入 1 条 daily。
${writeTargets.join('\n')}`)
    : ''
  parts.push(`## 按需记忆（project / daily）
以下两轨不注入本会话（为缓存与隔离），需要时请主动用 memory 工具读取（action=list），不要凭猜测回答：
- target=project：当前项目的约定、进展、历史决策、踩坑记录——任务涉及项目上下文、或对项目情况不确定时，先读取再动手/回答；
- target=daily：今天做了什么、当天进展——用户问起今天/最近做了什么、或需要当天信息时读取。
${writeSection}${writeSection === '' ? '' : '\n'}格式纪律：不要在内容中自行添加任何时间/日期前缀（如 "[2026-08-05]"、"[00:00]"）——你无法确知当前日期，程序会自动添加准确的时间戳（每日日志 [HH:MM]、项目记忆 [YYYY-MM-DD HH:MM]），直接从内容主体开始写。`)

  // In-turn review hint (main sessions only, when review is enabled). Fixed
  // text: the interval and mode live in the memory_review_status tool
  // response, never in this block, so config changes do not break the cache.
  if (!isSubagent && config.reviewEnabled) {
    parts.push(`## 记忆审查（每 N 个用户回合自动进行）
系统会统计本会话的用户回合数；每 N 个回合将一次记忆审查标记为**到期**（N 可在设置面板调整）。**到期判断以 memory_review_status 工具返回的 due 为准，不要自行数回合。**

每个回合结束前、输出最终回复之前：
1. 调用 memory_review_status（action=check）查询是否到期；
2. 未到期（due=false）→ 不做任何审查动作；
3. 到期（due=true）→ **静默执行审查**（全部为工具操作，不要写进最终回复）：
   a. 回顾本会话的对话，提炼审查要点：用户透露的稳定偏好/个人信息、关键决策、踩坑教训、可复用经验；
   b. 全局记忆（memory/user 轨）：对照本快照中【长期记忆】【用户档案】逐条**查重**——只建议**稳定、可跨会话复用**的新事实（单次出现的行为不算偏好）。工具返回 mode=suggest → 用 memory_suggest 提出建议（最多 2 条，宁缺毋滥，同一偏好合并为 1 条）；mode=auto → 用 memory 工具直接写入（同样宁缺毋滥）。禁止沉淀：一次性任务叙事、瞬时错误、环境依赖失败、对工具/功能的负面断言、敏感信息、已自行解决的临时状态；
   c. 技能（可选）：确有可复用经验（本会话反复踩坑、难度大、后续会复用）→ 用 skill_manage 先 action=list 查重；已有合适技能 → read → patch 优化（不受创建门槛限制）；没有且满足全部门槛 → create。每轮审查最多 1 次技能操作。create 的去向按「技能自动沉淀」开关：关（默认）= 进待确认队列，面板采纳后生效；开 = 直接创建生效；
   d. 审查执行完毕后调用 memory_review_status（action=complete）复位计数；若中途被打断未完成，下回合仍会到期，可继续补做。
4. 格式纪律（全局轨）：不要在建议/写入内容中自行添加时间/日期前缀（如 "[2026-08-05]"）——你无法确知当前日期，程序会自动添加准确的时间戳。`)
  }
  return parts.join('\n\n')
}

/**
 * Resolve one reveal target to an openable path. Every target is a fixed
 * path derived from the memory dir, the skill dir, or the dsh home — never
 * an arbitrary path. Directories open as-is; a missing file falls back to
 * its containing directory (e.g. AGENTS.md before DSH created it, or
 * today's daily log before the first write) instead of failing with an
 * unknown target.
 * @param {object} config - resolved plugin config.
 * @param {string} target - the reveal target name.
 * @returns {string | undefined} the path to open, or undefined for an
 *   unknown target.
 */
export function resolveRevealTarget(config, target) {
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
  // Directories open as-is; the plugin's own storage directories are
  // created on demand so the reveal buttons work on a fresh install before
  // any memory was ever written (MEMORY.md/USER.md/daily/projects do not
  // exist yet, and neither does the memory dir itself).
  if (target === 'memoryDir' || target === 'dailyDir' || target === 'projectsDir') {
    return existsSync(path) ? path : ensureDir(path)
  }
  if (target === 'agentsFile') {
    return existsSync(path) ? path : dshHome
  }
  if (target === 'skillDir') {
    return existsSync(path) ? path : dirname(config.skillDir)
  }
  // Files: open the containing directory when the file does not exist yet
  // (creating it on demand — the memory dir is plugin-owned).
  const dir = table[target === 'dailyFile' ? 'dailyDir' : 'memoryDir']
  return existsSync(path) ? path : ensureDir(dir)
}

/**
 * Convert a Linux/WSL path to a Windows path for `explorer.exe`, using
 * `wslpath` (bundled with WSL itself). Falls back to the original path when
 * wslpath is missing or fails — e.g. on pure Linux, where the explorer.exe
 * attempt will fail anyway and the command chain moves on.
 * @param {string} path - the Linux path to convert.
 * @returns {string} the Windows path, or the input when not convertible.
 */
export function toWindowsPath(path) {
  const result = spawnSync('wslpath', ['-w', path], { encoding: 'utf8' })
  const converted = result.error ? '' : String(result.stdout ?? '').trim()
  return converted || path
}

/** Create a directory (recursively) and return its path. */
function ensureDir(path) {
  mkdirSync(path, { recursive: true })
  return path
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
      // automatic writes. The main session is never gated here (the review
      // prompt disciplines its global writes instead).
      if (origin === 'subagent' && (target === 'memory' || target === 'user')) {
        if (getRuntime().reviewMode !== 'auto') {
          return {
            ok: false,
            message: `子代理写入全局记忆被拒绝：请改用 ${getRuntime().suggestToolName} 提出建议（项目记忆与每日日志可直接写入）`,
            target,
          }
        }
        const approval = ctx.get('approval')
        if (!approval) {
          return { ok: false, message: '记忆写入需要用户批准，但当前没有可用的批准通道', target }
        }
        const outcome = await approval.request({
          agent: exec.agent,
          toolName: config.toolName,
          callId: exec.callId,
          reason: '记忆审查建议写入长期记忆',
          signal: exec.signal,
        })
        if (outcome !== 'allowed-once') {
          return { ok: false, message: `记忆写入未获批准（${outcome}）`, target }
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

  // 3. In-turn review (opt-in): suggest tool + turn counter + status tool.
  // Machinery is installed whenever the plugin loads (config reviewEnabled OR
  // the runtime state), but the counter consults the live runtime — the
  // settings panel can flip it without a reload. The review itself runs
  // inside the main LLM's turn (prompt-driven, see renderSnapshot).
  const reviewWanted = config.reviewEnabled || runtime.reviewEnabled
  if (reviewWanted) {
    ctx.effect(() => ctx.tools.register(suggestToolDefinition(config, queue)), 'dsh-memory-evolve: suggest tool')
    ctx.effect(() => ctx.tools.register(reviewStatusTool(getRuntime, reviewTurnCounter(ctx, getRuntime))), 'dsh-memory-evolve: review status tool')
  }

  // 4. Web API: the settings panel's data surface (web-only service; the
  //    plugin still loads on surfaces without httpServer).
  ctx.inject(['httpServer'], (webCtx) => {
    const resolveReveal = (target) => resolveRevealTarget(config, target)
    // Open a path with the platform's reveal command; WSL/Linux falls back
    // from xdg-open to wslview so a missing xdg-utils does not silently
    // swallow the click. Rejects with a user-visible message when nothing
    // is available. Linux/WSL: xdg-open → wslview → explorer.exe (WSL ships
    // explorer.exe + wslpath even where wslu's wslview cannot be installed).
    const revealPath = (path) => new Promise((resolve, reject) => {
      const commands = process.platform === 'darwin' ? ['open']
        : process.platform === 'win32' ? ['explorer']
          : ['xdg-open', 'wslview', 'explorer.exe']
      const tryNext = (index) => {
        if (index >= commands.length) {
          reject(new Error('没有可用的打开命令（Linux/WSL 请安装 xdg-utils，或使用 Windows 自带的 explorer.exe）'))
          return
        }
        const command = commands[index]
        // explorer.exe takes a Windows path; everything else the Linux path.
        const args = command === 'explorer.exe' ? [toWindowsPath(path)] : [path]
        const child = spawn(command, args, { stdio: 'ignore' })
        child.on('error', () => tryNext(index + 1))
        child.on('spawn', () => resolve())
      }
      tryNext(0)
    })
    webCtx.effect(() => installApi(webCtx, {
      store, queue, getRuntime, updateRuntime, resolveRevealTarget: resolveReveal, revealPath,
      config,
      resolveCwd: (sessionId) => ctx.get('agents')?.get?.(sessionId)?.session?.header?.cwd,
    }), 'dsh-memory-evolve: web api')
  })

  // 5. Commands: the review command works even with review off (users may
  //    want to inspect/clean leftover suggestions). Registered when the
  //    commands service exists.
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.commands.register(reviewCommand(config, store, queue))
  })
}
