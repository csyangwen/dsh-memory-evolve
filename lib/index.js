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
import { ArchiveStore, MemoryStore, SuggestionQueue, gitBranch, gitBranchList, parseEntryBranches, todayStamp } from './store.js'
import { reviewCommand, reviewStatusTool, reviewTurnCounter, enqueueSuggestion, suggestToolDefinition } from './review.js'
import { skillManageTool } from './skills.js'
import { installApi } from './api.js'
import { installSkillsManager } from './skills-manager.js'
import { TodoStore, todoToolDefinition } from './todo.js'
import { createSearchDocsController, searchDocsCommand } from './search-docs.js'

// Re-exported for the web API layer (api.js imports them from here).
export { gitBranch, gitBranchList } from './store.js'

export const name = 'dsh-memory-evolve'
export const inject = ['tools', 'systemPrompt']

/** Plugin config defaults (conservative: review off, memory on). */
const DEFAULTS = {
  // storage
  memoryDir: null, // null → <dshHome>/memories
  entryDatePrefix: true,
  // daily / project memory (per-turn proactive writes — never injected, see renderSnapshot)
  perTurnProjectWrites: true, // snapshot hint requires a per-turn project write check
  perTurnDailyWrites: true,   // snapshot hint requires a per-turn daily write check
  perTurnKeyWrites: true,     // snapshot hint: importance-gated project KEY writes (injected)
  keyBranchFilter: true,      // static (config.yaml only): inject only KEY entries whose branch scope matches the session's git branch
  // snapshot injection
  injectMemory: true,
  snapshotOrder: 500,
  injectionScan: true,
  // tools / command names
  toolName: 'memory',
  suggestToolName: 'memory_suggest',
  commandName: 'memory_review',
  skillManageToolName: 'skill_manage',
  todoToolName: 'dtodo',
  // skill management
  skillDir: null, // null → ~/.agents/skills (the DSH skill library)
  skillMaxBytes: 65536,
  // background review (in-turn, prompt-driven: the main LLM reviews itself
  // when the turn counter reaches the interval)
  reviewEnabled: false,
  reviewInterval: 5,
  reviewMode: 'suggest', // 'suggest' | 'auto' — suggest = global facts go through memory_suggest (user confirms); auto = direct memory writes
  skillReviewEnabled: false, // off by default: skill creations queue for user confirmation (on = direct, no approval)
  memoryTabEnabled: true, // session memory tab in the web GUI (default ON — the settings-panel entry is gone, the tab is the only surface)
  suggestionsFile: null, // null → <memoryDir>/SUGGESTIONS.jsonl
  stateFile: null, // null → <memoryDir>/plugin-state.json (runtime config overrides)
  // local document search (search_local_docs; default OFF — the tool is not
  // registered at all, so the model never sees it)
  searchDocsEnabled: false,
  searchDocsToolName: 'memory_evolve_search_local_docs',
  searchDocsCommandName: 'memory_evolve_search_docs',
  searchDocsExts: ['md'],
  searchDocsProviders: 'auto', // 'auto' | ['mdfind','es','rg','walk'] — replaceable implementations
  searchDocsCacheTtlMs: 3600000, // walk 缓存 TTL（1h）
  searchDocsTimeoutMs: 60000, // 每层搜索超时上限
  searchDocsCacheFile: null, // null → <memoryDir>/search-docs-index.json
}

/** Keys the Web UI may change at runtime (persisted to stateFile). */
export const RUNTIME_KEYS = [
  'reviewEnabled', 'reviewInterval', 'reviewMode', 'skillReviewEnabled',
  'perTurnProjectWrites', 'perTurnDailyWrites', 'perTurnKeyWrites',
  'searchDocsEnabled',
]

/** Validate one runtime-config patch value against its key. */
export function validateRuntimePatch(key, value) {
  switch (key) {
    case 'reviewEnabled':
    case 'skillReviewEnabled':
    case 'perTurnProjectWrites':
    case 'perTurnDailyWrites':
    case 'perTurnKeyWrites':
    case 'searchDocsEnabled':
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
  'snapshotOrder', 'reviewInterval', 'skillMaxBytes',
  'searchDocsCacheTtlMs', 'searchDocsTimeoutMs',
]
const BOOLEAN_KEYS = [
  'injectMemory', 'injectionScan', 'reviewEnabled', 'skillReviewEnabled',
  'entryDatePrefix', 'memoryTabEnabled', 'keyBranchFilter',
  'perTurnProjectWrites', 'perTurnDailyWrites', 'perTurnKeyWrites',
  'searchDocsEnabled',
]
const STRING_KEYS = [
  'toolName', 'suggestToolName', 'commandName', 'reviewMode',
  'skillManageToolName', 'searchDocsToolName', 'searchDocsCommandName',
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
  if (!Array.isArray(config.searchDocsExts) || config.searchDocsExts.length === 0
    || config.searchDocsExts.some((ext) => typeof ext !== 'string' || !/^[a-z0-9]{1,10}$/.test(ext.toLowerCase().replace(/^\./, '')))) {
    throw new Error('dsh-memory-evolve: searchDocsExts 必须是非空扩展名数组（如 ["md","docx"]）')
  }
  config.searchDocsExts = config.searchDocsExts.map((ext) => ext.toLowerCase().replace(/^\./, ''))
  if (config.searchDocsProviders !== 'auto'
    && (!Array.isArray(config.searchDocsProviders) || config.searchDocsProviders.length === 0
      || config.searchDocsProviders.some((name) => typeof name !== 'string' || name.length === 0))) {
    throw new Error('dsh-memory-evolve: searchDocsProviders 必须是 "auto" 或非空 provider 名数组')
  }
  return config
}

/**
 * Render the memory snapshot injected into the model context. Live reads are
 * intentional: DSH's runtime-context materialization only appends when the
 * rendered text changes, so mid-session memory writes surface at the next
 * step as a tail message while the stable prefix stays cached. The slow-
 * moving tracks are rendered here — global memory/user AND the per-project
 * KEY track (projects/<hash>/KEY.md, scoped to this agent's cwd): KEY facts
 * change rarely (only when something important happens, never per-turn), so
 * injecting them with live reads gives real-time change monitoring at a
 * cache-friendly cost, exactly like the global tracks. The project log and
 * the daily log change on every write, and injecting them would append a
 * new tail snapshot per turn and defeat prefix caching — they stay on-demand
 * via the memory tool, with a fixed per-turn write duty in the hint below.
 * @param {object} config - resolved config.
 * @param {MemoryStore} store - the memory store.
 * @returns {string} the snapshot text (empty when nothing is stored).
 */
export function renderSnapshot(config, store, agent, counter) {
  const parts = []
  const memoryEntries = store.entriesOf('memory')
  const userEntries = store.entriesOf('user')
  if (memoryEntries.length > 0) {
    parts.push(`## 长期记忆（所有项目、会话都必须遵循）\n${memoryEntries.map((entry) => `- ${entry}`).join('\n')}`)
  }
  if (userEntries.length > 0) {
    parts.push(`## 用户档案\n${userEntries.map((entry) => `- ${entry}`).join('\n')}`)
  }
  // Project KEY facts are injected for the agent's own project only (its
  // session cwd). Same live-read/change-detected mechanism as the global
  // tracks: a KEY write (tool or web tab) surfaces in the next step's tail.
  // When the project is a git worktree and keyBranchFilter is on, the
  // current branch is resolved live and ONLY entries whose scope covers it
  // are injected (untagged entries = "全部" always qualify). Outside git,
  // or when the branch cannot be resolved, every entry is injected — the
  // conservative choice that never hides memory. The branch name itself is
  // injected alongside, so the model knows which branch it is on.
  const keyAgent = agent?.session?.header?.cwd ? agent : undefined
  const branch = keyAgent && config.keyBranchFilter !== false ? gitBranch(keyAgent.session.header.cwd) : undefined
  let keyEntries = keyAgent ? store.entriesOf('key', keyAgent) : []
  if (branch !== undefined) {
    keyEntries = keyEntries.filter((entry) => {
      const scope = parseEntryBranches(entry)
      return scope === null || scope.includes(branch)
    })
  }
  if (keyEntries.length > 0) {
    const head = branch !== undefined
      ? `## 本项目关键记忆（memory 工具 target=key；当前分支：${branch}，仅注入匹配分支的条目）`
      : '## 本项目关键记忆（memory 工具 target=key）'
    parts.push(`${head}\n${keyEntries.map((entry) => `- ${entry}`).join('\n')}`)
  }
  // The project log (MEMORY.md under projects/<hash>/) and the daily log are
  // deliberately NOT rendered into the snapshot: they change on every write,
  // and each change would append a new runtime-context tail message,
  // defeating LLM prefix caching. Instead the stable hint below (fixed text
  // for a given config, never varies with content) requires the model to
  // CHECK every turn for record-worthy facts and write them via the memory
  // tool right away — the program stamps timestamps, so daily/project stay
  // current without waiting for a review round. Both tracks are
  // user-toggleable at runtime (perTurnProjectWrites / perTurnDailyWrites):
  // a disabled track drops its write duty and the hint falls back to
  // on-demand reads. KEY writes are importance-gated (perTurnKeyWrites):
  // only durable project facts (long-lived conventions/decisions/architecture
  // pitfalls) qualify — never per-turn progress. Subagent sessions get a
  // restrained variant: record one entry per independent achievement instead
  // of a per-turn duty, so bulk delegation does not flood the tracks.
  const isSubagent = agent?.session?.header?.origin === 'subagent'
  const reviewOn = !isSubagent && config.reviewEnabled
  // Due warning: when the review is due, the snapshot itself tells the model
  // (the sticky counter is the authority). Low-frequency text change — one
  // extra tail snapshot per review cycle is a fair cache price for closing
  // the 'never checks' hole of weak-following models.
  const due = reviewOn && counter !== undefined && counter.turnsOf(agent) >= config.reviewInterval
  const keyDuty = config.perTurnKeyWrites !== false
  const writeTargets = [
    config.perTurnDailyWrites !== false ? 'target=daily' : null,
    config.perTurnProjectWrites !== false ? 'target=project' : null,
  ].filter(Boolean)
  // With git the model is told which branch it is on — even when no KEY
  // entry matches, the branch line keeps the model branch-aware. Outside
  // git nothing branch-related is injected at all.
  const branchHint = branch !== undefined
    ? `\n- 当前 git 分支：**${branch}**（target=key 的记忆按分支过滤注入；写 key 时可用 branches=分支名 限定范围，缺省=全部）`
    : ''
  parts.push(`## 记忆 memory-evolve（包含 memory 工具、dtodo 待办工具、skill_manage 技能工具）
- 读取：需要时用 memory 工具读取 target=project（项目约定/进展）与 target=daily（今日日志），不要凭猜测回答。本项目关键记忆（target=key）已注入上下文，无需读取。${branchHint}
- 待办（dtodo）：收尾时调用 dtodo list 检查到期（默认视图：今日到期/逾期优先，最多 8 条）——有到期未完成项就在回复末尾提醒用户；不要主动展开全部待办清单，除非用户询问；用法细节（target 归类、过往/过期查询等）见 dtodo 工具描述。`)

  // Turn-final duties, as one minimal checklist (write → status check →
  // review when due). No mechanism explanation: the interval and mode live
  // in the memory_review_status tool response — the model must perform the
  // check EVERY turn and take `due` as the verdict (a session once read
  // "every N turns" as "check every N turns" and skipped the status check).
  if (writeTargets.length > 0 || keyDuty || reviewOn) {
    const steps = []
    if (writeTargets.length > 0 || keyDuty) {
      if (isSubagent) {
        const base = `仅在完成**独立成果**时（一项实质产出、一个关键决策或踩坑结论），用 memory 工具向 ${writeTargets.join(' 与 ')} 写入 1 条，保持简洁`
        steps.push(keyDuty
          ? `${base}；重要结论可另向 target=key 提交建议（用户确认后生效）；没有独立成果就跳过，不要为写而写。`
          : `${base}；没有独立成果就跳过，不要为写而写。`)
      } else {
        const duties = []
        if (writeTargets.length > 0) {
          duties.push(`向 ${writeTargets.join(' 与 ')} 各写 1 条本回合进展（1-2 行具体内容）`)
        }
        if (keyDuty) duties.push('本轮出现重要项目事实（长期约定/决策/架构/踩坑）时另向 target=key 提交 1 条建议（用户确认后写入并注入），没有则跳过')
        steps.push(`1. 写入：用 memory 工具${duties.join('；')}；`)
      }
    }
    if (reviewOn) {
      const n = steps.length + 1
      steps.push(`${n}. 检查：调用 memory_review_status（action=check）；`)
      steps.push(`${n + 1}. 审查：due=true 时——全局记忆用 memory_suggest 提建议（mode=auto 时用 memory 直接写入），技能用 skill_manage 创建/优化，完成后调用 memory_review_status（action=complete）；due=false 直接结束。`)
    }
    const tail = '- 内容不要自带时间/日期前缀（程序自动盖时间戳）。'
    const dueWarning = due
      ? '\n\n⚠️ **记忆审查已到期**：本回合收尾必须执行审查（全局记忆建议/技能），完成后调用 memory_review_status（action=complete）复位。'
      : ''
    const head = isSubagent
      ? '- 收尾（先输出完整回复文本，再在文本之后附带工具调用，严禁先调工具）：'
      : '- 每轮收尾（先输出完整回复文本，再在文本之后附带工具调用，严禁先调工具）必须：'
    parts.push(`${head}
${steps.map((step) => `  ${step}`).join('\n')}
${tail}${dueWarning}`)
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
    archiveMemoryFile: join(config.memoryDir, 'MEMORY-archive.md'),
    archiveUserFile: join(config.memoryDir, 'USER-archive.md'),
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
 * Strip the full entry list from a write result: add/replace/remove return
 * the whole track for internal bookkeeping, but the model only needs the
 * outcome (list is the read path that returns entries).
 * @param {object} result - the store result.
 * @returns {object} the same result without `entries`.
 */
function outcomeOnly(result) {
  if (result && Array.isArray(result.entries)) {
    const { entries, ...rest } = result
    return rest
  }
  return result
}

/**
 * Build the `memory` tool definition.
 * @param {object} ctx - the plugin context (for optional approval).
 * @param {object} config - resolved config.
 * @param {MemoryStore} store - the memory store.
 * @param {import('./store.js').SuggestionQueue} queue - the suggestion queue
 *   (key-track writes go through it for user confirmation).
 * @returns {object} a ToolDefinition-shaped object.
 */
function memoryTool(ctx, config, store, queue, getRuntime) {
  return {
    name: config.toolName,
    description: '读写长期记忆（跨会话持久，随上下文快照对模型可见）。target=memory 存全局环境/项目事实，target=user 存用户事实，target=project 存当前工作目录的项目日志（仅当前项目会话可见），target=key 存当前项目的关键长期记忆（自动注入上下文，仅当前项目会话可见；支持 branches 限定 git 分支范围，缺省=全部；**写入需用户确认**：add 会进入待确认队列，确认后生效），target=daily 追加今日日志（按需读取，不注入）。add 追加条目；replace 用唯一子串片段替换整个条目；remove 用唯一子串片段删除条目；list 查询条目——默认全部返回（按时间正序），支持 filter（关键词过滤）、since/until（日期范围 YYYY-MM-DD，daily 可跨文件查历史日志）、limit（最多条数，配合 recent 取最近 N 条）、recent（最新在前）、branch（key 轨：只返回该分支可见的条目）；查不到匹配或日期无法解析时，去掉过滤条件重查。写入立即落盘，模型上下文将在下一次刷新时更新。',
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
          enum: ['memory', 'user', 'project', 'key', 'daily'],
          description: '记忆轨：memory=全局环境/项目事实，user=用户事实，project=当前项目日志，key=当前项目关键长期记忆（自动注入），daily=今日日志',
        },
        content: {
          type: 'string',
          description: 'add/replace 的新条目内容（可多行）',
        },
        match: {
          type: 'string',
          description: 'replace/remove 的匹配片段，必须唯一命中一个条目',
        },
        branches: {
          type: 'string',
          description: 'add 可选（仅 key 轨）：分支范围，逗号分隔（如 main,dev）；缺省=全部（所有分支可见）；留空字符串=全部',
        },
        branch: {
          type: 'string',
          description: 'list 可选（仅 key 轨）：只返回该分支可见的条目（无标记的全部条目 + 标记含该分支的条目）',
        },
        filter: {
          type: 'string',
          description: 'list 可选：只返回内容包含该关键词的条目（大小写不敏感）',
        },
        since: {
          type: 'string',
          description: 'list 可选：起始日期 YYYY-MM-DD；daily 轨支持跨文件查询历史日志',
        },
        until: {
          type: 'string',
          description: 'list 可选：结束日期 YYYY-MM-DD',
        },
        limit: {
          type: 'integer',
          description: 'list 可选：最多返回的条数（建议与 recent 搭配取最近 N 条）',
        },
        recent: {
          type: 'boolean',
          description: 'list 可选：按时间倒序返回（最新在前）',
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
      // suggest mode, approval-gated in auto mode. The project-scoped tracks
      // (project/key, keyed to one cwd) and daily (never injected) are safe
      // for automatic writes. The main session is never gated here (the review
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
            const stats = {}
            let entries = store.query(target, exec.agent, {
              filter: args.filter,
              since: args.since,
              until: args.until,
              limit: args.limit,
              recent: args.recent,
            }, stats)
            // key 轨的 branch 过滤：只看该分支可见的条目（无标记=全部 + 标记含该分支）
            if (target === 'key' && args.branch !== undefined && String(args.branch).trim() !== '') {
              const b = String(args.branch).trim()
              entries = entries.filter((entry) => {
                const scope = parseEntryBranches(entry)
                return scope === null || scope.includes(b)
              })
            }
            let message = `${target}：${entries.length} 条匹配`
            if (entries.length === 0 && (args.filter !== undefined || args.since !== undefined || args.until !== undefined)) {
              // 查不到：提醒模型读全文，不要凭猜测下结论
              message += '（未找到匹配条目——可去掉过滤条件重新 list 读取全文核对）'
            } else if (stats.undated > 0 && (args.since !== undefined || args.until !== undefined)) {
              // 日期格式不兼容：提醒模型这些条目未参与日期过滤
              message += `（另有 ${stats.undated} 条日期无法解析的条目未参与日期过滤——可去掉 since/until 重新 list 读取全文核对）`
            }
            result = {
              ok: true,
              message,
              target,
              entries: [...entries],
              chars: entries.join('\n').length,
            }
            break
          }
          case 'add': {
            let content = String(args.content ?? '').trim()
            let branchWarning = ''
            // key 轨的分支范围：branches=main,dev → 条目带 [branch:main,dev] 标记；
            // 缺省/空 = 全部（无标记）。对不存在的分支只警告、照常写入（分支以后可能创建）。
            if (target === 'key' && args.branches !== undefined && String(args.branches).trim() !== '') {
              const list = String(args.branches).split(',').map((b) => b.trim()).filter((b) => b.length > 0)
              if (list.length > 0) {
                content = `[branch:${list.join(',')}] ${content}`
                const known = gitBranchList(exec?.agent?.session?.header?.cwd)
                if (known.length > 0) {
                  const unknown = list.filter((b) => !known.includes(b))
                  if (unknown.length > 0) {
                    branchWarning = `（警告：分支 ${unknown.join('、')} 当前不存在，条目将仅在这些分支创建后可见）`
                  }
                }
              }
            }
            // key 轨与全局轨同待遇：写入需用户确认——add 进入待确认队列
            // （用户采纳后写入 KEY.md 并注入），不直接落盘。
            if (target === 'key') {
              const outcome = enqueueSuggestion(queue, 'key', content, '每轮收尾自动提交的项目关键记忆建议', exec?.agent)
              if (outcome.ok) {
                outcome.message = `已提交待确认的项目关键记忆建议（队列 ${outcome.queued} 条）——用户确认后才会写入并注入${branchWarning ? ` ${branchWarning}` : ''}`
              }
              // queued 不在输出 schema 内（additionalProperties:false），剥离
              const { queued: _queued, ...rest } = outcome
              result = outcomeOnly(rest)
              break
            }
            const addResult = store.add(target, content, exec.agent)
            if (addResult.ok && branchWarning !== '') addResult.message += branchWarning
            result = outcomeOnly(addResult)
            break
          }
          case 'replace':
            result = outcomeOnly(store.replace(target, args.match, args.content, exec.agent))
            break
          case 'remove':
            result = outcomeOnly(store.remove(target, args.match, exec.agent))
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
  const archive = new ArchiveStore(config.memoryDir)
  const queue = new SuggestionQueue(config.suggestionsFile)
  const todoStore = new TodoStore(config.memoryDir)
  const stateFile = resolve(config.stateFile ?? join(config.memoryDir, 'plugin-state.json'))

  // Runtime configuration: cordis config (static defaults) overlaid with the
  // persisted state file, which the Web settings panel updates live.
  const state = loadState(stateFile)
  const runtime = { ...config }
  for (const key of RUNTIME_KEYS) {
    if (state[key] !== undefined) runtime[key] = state[key]
  }
  const getRuntime = () => runtime
  // Review turn counter: created once, shared by the snapshot (due warning)
  // and the memory_review_status tool. Zero-cost when review is disabled
  // (the settled listener returns early unless reviewEnabled).
  const counter = reviewTurnCounter(ctx, getRuntime)
  const updateRuntime = (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      validateRuntimePatch(key, value)
      runtime[key] = value
      state[key] = value
    }
    saveState(stateFile, state)
    return { ...runtime }
  }

  // 2d. Local document search (search_local_docs): default OFF — the tool is
  // registered only while the runtime switch is on, so a disabled tool never
  // appears in the model's tool list (and its schema stays out of the prompt).
  // updateRuntime 联动：Web 设置面板 / slash 命令切换后即时注册或注销。
  const searchDocsCtrl = createSearchDocsController(ctx, config, getRuntime)
  const applyRuntimePatch = (patch) => {
    const next = updateRuntime(patch)
    searchDocsCtrl.sync()
    return next
  }

  // 1. Memory snapshot injection (frozen-ish: live reads, change-detected
  //    materialization keeps the cache prefix stable).
  if (config.injectMemory) {
    ctx.effect(() => ctx.systemPrompt.context({
      name: 'memory:snapshot',
      order: config.snapshotOrder,
      text: (context) => renderSnapshot(getRuntime(), store, context.agent, counter),
    }), 'dsh-memory-evolve: memory snapshot')
  }

  // 2. The memory tool (always registered; subagent writes are gated).
  ctx.effect(() => ctx.tools.register(memoryTool(ctx, config, store, queue, getRuntime)), 'dsh-memory-evolve: memory tool')

  // 2b. The skill management tool (always registered: useful in ordinary
  //     sessions too — "把这个流程做成技能" — and required by the review
  //     subagent for the skill track).
  ctx.effect(() => ctx.tools.register(skillManageTool(ctx, config)), 'dsh-memory-evolve: skill tool')

  // 2c. The todo tool (always registered: user-spoken todos are written
  //     directly; model-authored ones go through the suggestion queue).
  ctx.effect(() => ctx.tools.register(todoToolDefinition(config, todoStore)), 'dsh-memory-evolve: todo tool')

  // 3. In-turn review (opt-in): suggest tool + turn counter + status tool.
  // Machinery is installed whenever the plugin loads (config reviewEnabled OR
  // the runtime state), but the counter consults the live runtime — the
  // settings panel can flip it without a reload. The review itself runs
  // inside the main LLM's turn (prompt-driven, see renderSnapshot).
  const reviewWanted = config.reviewEnabled || runtime.reviewEnabled
  if (reviewWanted) {
    ctx.effect(() => ctx.tools.register(suggestToolDefinition(config, queue)), 'dsh-memory-evolve: suggest tool')
    ctx.effect(() => ctx.tools.register(reviewStatusTool(getRuntime, counter)), 'dsh-memory-evolve: review status tool')
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
      store, archive, queue, todoStore, getRuntime, updateRuntime: applyRuntimePatch, resolveRevealTarget: resolveReveal, revealPath,
      config,
      resolveCwd: (sessionId) => ctx.get('agents')?.get?.(sessionId)?.session?.header?.cwd,
    }), 'dsh-memory-evolve: web api')
  })

  // 5. Skills manager (merged from the standalone dsh-skill-browser plugin):
  //    browse/search/disable skills + custom skill dirs, served under the
  //    original /skills-manager prefix so the browser client is unchanged.
  //    The disabled list migrates once from the standalone plugin's state.
  installSkillsManager(ctx, {
    stateFile: join(config.memoryDir, 'skills-state.json'),
  })

  // 6. Commands: the review command works even with review off (users may
  //    want to inspect/clean leftover suggestions). Registered when the
  //    commands service exists.
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.commands.register(reviewCommand(config, store, todoStore, archive, queue))
    cmdCtx.commands.register(searchDocsCommand(config, {
      status: () => searchDocsCtrl.status(),
      setEnabled: (enabled) => applyRuntimePatch({ searchDocsEnabled: enabled }),
    }))
  })
}
