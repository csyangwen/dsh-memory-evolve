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
import { installBroadcast, installCoi } from './coi/index.js'
import { installPrompts } from './prompts.js'

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
  // local file search (search_local_files; default OFF — the tool is not
  // registered at all, so the model never sees it)
  searchDocsEnabled: false,
  searchDocsToolName: 'memory_evolve_search_local_files',
  searchDocsCommandName: 'memory_evolve_search_files',
  searchDocsExts: ['md'],
  searchDocsProviders: 'auto', // 'auto' | ['mdfind','es','rg','walk'] — replaceable implementations
  searchDocsCacheTtlMs: 3600000, // walk 缓存 TTL（1h）
  searchDocsTimeoutMs: 60000, // 每层搜索超时上限
  searchDocsCacheFile: null, // null → <memoryDir>/search-docs-index.json
  // COI 调度（de_coi：统一调度 kimi/codex/grok/hermes 等 CLI 代理）
  coiEnabled: false,          // COI 调度总开关（默认禁用，与本地搜索一致；记忆 Tab 运行时配置可随时切换，工具/命令即时生效，Tab 刷新后出现）
  coiDataDir: null,           // null → <memoryDir>/coi
  coiSummaryEnabled: true,    // 任务完成自动沉淀摘要到 project/daily 记忆
  coiSyncSkills: true,        // 启动时把内置适配器技能（skills/ 目录）同步到技能库（源头在插件）
  coiNotifyCommand: null,     // 完成通知命令模板（占位符 {taskId}{coi}{status}{summary}；null=不通知）
  coiRetentionDays: 90,       // 任务留档保留天数（超期自动清理）
  coiTaskTimeoutMs: 43200000, // 任务默认超时（12 小时；AI 代理任务动辄数小时，超时仅作兜底防线）
  coiMaxLogBytes: 2097152,    // 单任务留档上限（2 MiB）
  // 会话广播（de_broadcast）：**独立子模块**（用户拍板 2026-08-08：明显
  // 独立的子模块不挂在别的模块下——曾跟随 coiEnabled 导致开关联动、工具
  // 上下文污染），独立开关与存储目录；开启后注册 de_broadcast 工具 +
  // 快照「会话广播」段 + 会话头部复制会话 ID 按钮；默认关
  broadcastEnabled: false,
  broadcastDataDir: null,     // null → <memoryDir>/broadcast
  promptsEnabled: false,      // 提示词管理器总开关（默认禁用，与本地搜索/COI 一致；开启后「提示词」Tab 与注入轨生效）
  scratchEnabled: false,      // 临时信息 Tab 总开关（默认禁用，与本地搜索/COI 一致；开启后「临时信息」Tab 出现，内容持久化在 <memoryDir>/scratch.md）
}

/** Keys the Web UI may change at runtime (persisted to stateFile). */
export const RUNTIME_KEYS = [
  'reviewEnabled', 'reviewInterval', 'reviewMode', 'skillReviewEnabled',
  'perTurnProjectWrites', 'perTurnDailyWrites', 'perTurnKeyWrites',
  'searchDocsEnabled', 'coiEnabled', 'broadcastEnabled', 'promptsEnabled', 'scratchEnabled',
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
    case 'coiEnabled':
    case 'broadcastEnabled':
    case 'promptsEnabled':
    case 'scratchEnabled':
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
  'coiRetentionDays', 'coiTaskTimeoutMs', 'coiMaxLogBytes',
]
const BOOLEAN_KEYS = [
  'injectMemory', 'injectionScan', 'reviewEnabled', 'skillReviewEnabled',
  'entryDatePrefix', 'memoryTabEnabled', 'keyBranchFilter',
  'perTurnProjectWrites', 'perTurnDailyWrites', 'perTurnKeyWrites',
  'searchDocsEnabled', 'coiEnabled', 'coiSummaryEnabled', 'coiSyncSkills',
  'promptsEnabled', 'scratchEnabled',
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
  config.coiDataDir = resolve(config.coiDataDir ?? join(config.memoryDir, 'coi'))
  if (config.coiNotifyCommand !== null && (typeof config.coiNotifyCommand !== 'string' || config.coiNotifyCommand.trim() === '')) {
    throw new Error('dsh-memory-evolve: coiNotifyCommand 必须是字符串或 null')
  }
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
  // 会话 ID 段（快照最前面的独立输出端，常驻注入，不随任何模块开关）：
  // AI 始终知道"我是谁"——广播消息判断 sender/recipients 谁是谁、回复时
  // 把此 ID 告知对方，以及未来其他模块的消费者都要用它。固定文本（会话
  // 生命周期内不变，缓存友好）；无会话视角（subagent 等）不注入。
  if (agent?.session?.id) {
    parts.push(`## 你的会话 ID（记住它：用它与各模块消息里的 session id 比对判断是谁；回复时也可把此 ID 告知对方）\n- 你的会话 ID：${agent.session.id}`)
  }
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

  // Turn-final duties, as one minimal checklist (write → review when the
  // snapshot says so). No per-turn status check: the program injects a
  // due warning into the snapshot the moment a review is due (sticky until
  // completed), so the model never has to poll — and weak followers cannot
  // skip a review silently. No mechanism explanation: the interval and mode
  // ride on the due warning; `memory_review_status` is only for completing
  // a review (or manual progress checks).
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
      steps.push(`${n}. 审查：仅当快照出现「记忆审查已到期」提醒时执行审查（全局记忆用 memory_suggest 提建议 / mode=auto 直接写 memory，技能用 skill_manage 创建/优化），完成后调用 memory_review_status（action=complete）复位；无提醒则跳过，不要调用 check。`)
    }
    const tail = '- 内容不要自带时间/日期前缀（程序自动盖时间戳）。'
    const dueWarning = due
      ? `\n\n⚠️ **记忆审查已到期**（间隔 ${config.reviewInterval} 轮，mode=${config.reviewMode}）：本回合收尾必须执行审查——全局记忆用 memory_suggest 提交建议（mode=auto 时用 memory 直接写入），技能用 skill_manage 创建/优化；完成后调用 memory_review_status（action=complete）复位。`
      : ''
    const head = isSubagent
      ? '- 收尾（先输出完整回复文本，再在文本之后附带工具调用，严禁先调工具）：'
      : '- 每轮收尾（先输出完整回复文本，再在文本之后附带工具调用，严禁先调工具）必须：'
    parts.push(`${head}
${steps.map((step) => `  ${step}`).join('\n')}
${tail}${dueWarning}`)
  }

  // COI 任务状态（主动通知）：CLI 代理后台任务完成时，其摘要自动出现在
  // 快照里——与记忆轨同一 live-read/change-detected 尾部注入机制，模型
  // 下一次生成前获知结果。⚠️ 注意：注入只在模型「下一次生成前」发生——
  // 模型回合内继续生成才能自动看到；结束回合后结果不会被自动处理（需
  // 用户发消息触发新一轮生成）。只注入运行中（最多 3 条）与最近终态
  // （最多 2 条）各一行，保持克制；任务状态无变化时文本不变、不追加
  // 尾部（缓存友好）。**按查看者过滤**（与任务列表同规则）：临时/会话=
  // 仅本会话发起的；项目=本会话工作区（ownerCwd，旧任务回退任务 cwd）
  // 派发的；全局=全显。coiEnabled=false 或数据缺失时整个段消失（零开销）。
  // 文案面向 AI（模型消费），不含 GUI 指引。
  if (config.coiEnabled === true) {
    const coiBlock = buildCoiSnapshotBlock(config, {
      sessionId: agent?.session?.id,
      cwd: agent?.session?.header?.cwd,
    })
    if (coiBlock !== null) parts.push(coiBlock)
  }
  // 会话广播（**独立子模块**）：按 broadcastEnabled 独立注入（不随
  // coiEnabled）——只对接收方会话定点注入未读清单（收件箱式：id+主题+
  // 发送者+时间；服务端按 recipients 过滤，其他会话无感知），AI 用
  // de_broadcast read 直接查看处理。
  if (config.broadcastEnabled === true) {
    const bcastBlock = buildBroadcastBlock(config, agent?.session?.id)
    if (bcastBlock !== null) parts.push(bcastBlock)
  }
  return parts.join('\n\n')
}

/**
 * 会话广播快照段：接收方会话的未读消息清单（无未读/无查看者/数据缺失
 * 返回 null，零开销）。**定点注入**：只对 recipients 含当前会话且未读
 * （readBy 不含当前会话）的消息列出；**收件箱式**——每条只给 id+主题+
 * 发送者+时间（不注入正文，克制），AI 可直接 de_broadcast read <id>
 * 拿全文，无需先 list。文案面向 AI（指令式：必须逐条查看处理），不含
 * GUI 指引。read 后标记已读，行随之消失。
 * @param {object} config - resolved plugin config（含 broadcastDataDir/memoryDir）。
 * @param {string} [sessionId] - 查看会话 id（无会话视角时不注入）。
 * @returns {string | null}
 */
export function buildBroadcastBlock(config, sessionId) {
  if (!sessionId) return null
  try {
    // 独立存储目录：broadcastDataDir（null → <memoryDir>/broadcast）
    const dir = config.broadcastDataDir ?? join(config.memoryDir ?? '', 'broadcast')
    const file = join(dir, 'broadcast.json')
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const messages = Array.isArray(parsed) ? parsed : []
    const unread = messages.filter((m) =>
      Array.isArray(m.recipients) && m.recipients.includes(sessionId)
      && !(Array.isArray(m.readBy) && m.readBy.includes(sessionId)))
    if (unread.length === 0) return null
    const lines = unread.slice(0, 5).map((m) => {
      const when = new Date(m.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      // 主题：老消息无 subject 时兜底取内容首行（与 de_broadcast 一致）
      let subject = m.subject ?? ''
      if (subject === '') {
        const first = String(m.content ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '')
        subject = first !== undefined ? first.replace(/^[#>*\-`\s]+/, '').slice(0, 40) : ''
      }
      return `- 📨 ${m.id}【${subject}】${m.sender} ${when}`
    })
    if (unread.length > 5) lines.push(`- …还有 ${unread.length - 5} 条未读（de_broadcast list 查看）`)
    // 标题即指令（AI 消费）：必须逐条 read 处理，未处理完不要结束回合
    return `## 会话广播（未读消息 ${unread.length} 条：必须用 de_broadcast read 逐条查看并处理，未处理完不要结束回合）\n${lines.join('\n')}`
  } catch {
    return null // 数据缺失/解析失败：整段隐藏
  }
}

/**
 * COI 任务状态快照段（运行中 + 最近终态各一行，克制注入；失败返回 null）。
 * 可见性与任务列表同规则：临时/会话=发起会话；项目=发起者工作区（旧任务
 * 无 ownerCwd 回退任务 cwd）；global=全显；无查看者视角时只注入 global。
 * 摘要清理 readLog 的「…（前 N 字符已省略）」截断标记（对 AI 无意义）。
 * **一次性通知**：终态任务只注入一次（注入后记入独立的 notified.json，
 * 之后不再重复出现——模型没收到就靠 de_coi_status 查询）；运行中任务每次
 * 显示。notified 不写在任务记录上：tasks.json 会被调度器整文件覆盖
 * （TaskStore 内存副本无该字段），写任务上会被冲掉导致反复通知。
 * @param {object} config - resolved plugin config（含 coiDataDir）。
 * @param {object} [viewer] - { sessionId?, cwd? } 查看会话（agent）视角。
 * @returns {string | null}
 */
export function buildCoiSnapshotBlock(config, viewer = {}) {
  try {
    const file = join(config.coiDataDir, 'tasks.json')
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const tasks = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tasks) ? parsed.tasks : []
    if (tasks.length === 0) return null
    // 一次性通知标记独立存储（notified.json），**不写在任务记录里**：
    // tasks.json 会被调度器整文件覆盖（TaskStore 内存副本没有 notified
    // 字段，运行中任务每 2s flush 一次 update(lastOutputAt) 即整数组写回），
    // 标记若写在任务记录上会被立刻冲掉、完成态任务永远"未通知"反复注入。
    // 独立文件调度器碰不到；兼容旧数据：任务记录里已有的 notified:true 也算。
    const notifiedFile = join(config.coiDataDir, 'notified.json')
    const notified = new Set()
    try {
      const raw = JSON.parse(readFileSync(notifiedFile, 'utf8'))
      if (Array.isArray(raw)) for (const id of raw) notified.add(String(id))
    } catch { /* 文件不存在/损坏：从零开始 */ }
    for (const t of tasks) if (t.notified === true) notified.add(t.id)
    const viewerSession = viewer.sessionId
    const viewerCwd = viewer.cwd
    const visible = (t) => {
      switch (t.scope) {
        case 'temporary':
        case 'session':
          return viewerSession !== undefined && t.ownerSessionId === viewerSession
        case 'project':
          return viewerCwd !== undefined
            && (t.ownerCwd != null ? t.ownerCwd === viewerCwd : (t.cwd != null && t.cwd === viewerCwd))
        default:
          return true // global
      }
    }
    const cleanSummary = (s) => String(s ?? '').replace(/^…（前 \d+ 字符已省略）\n?/, '')
    const running = tasks
      .filter((t) => visible(t) && (t.status === 'running' || t.status === 'queued'))
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, 3)
    // 终态只取「未通知过」的（notified 独立集合）——一次性通知
    const done = tasks
      .filter((t) => visible(t) && t.status !== 'running' && t.status !== 'queued' && !notified.has(t.id))
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
      .slice(0, 2)
    const lines = []
    for (const t of running) {
      // 运行中行是固定文本（不含耗时、不含用户输入的提示词）——①快照文本只在
      // 任务状态变化时改变，否则"已运行 N 分钟"每轮都变、整个快照每回合重注入
      // （缓存浪费）；②用户输入的提示词是隐私/业务内容，不注入模型上下文
      // （模型需要时用 de_coi_status 查询完整任务）
      lines.push(`- ⏳ ${t.status === 'queued' ? '排队中' : '运行中'}：${t.id} · ${t.coi ?? t.adapterId}`)
    }
    for (const t of done) {
      // 终态行：头部只含任务 id 与适配器名（不含用户输入的提示词），正文是
      // 完整摘要（1KB，不截断）用 4 反引号围栏包裹，让 AI 明确这是完整摘要
      // 内容（摘要里若含 4 连反引号则降级为 3 连，防破坏围栏）
      const mark = t.status === 'completed' ? '✅' : '❌'
      const head = `- ${mark} ${t.status}：${t.id} · ${t.coi ?? t.adapterId}`
      const raw = cleanSummary(t.summary)
      const summary = raw.replace(/````/g, '```')
      lines.push(summary !== '' ? `${head}\n\`\`\`\`${summary}\n\`\`\`\`` : head)
    }
    // 展示过的终态任务记入独立通知集合并落盘（原子写；失败忽略，下轮重试）
    if (done.length > 0) {
      try {
        for (const t of done) notified.add(t.id)
        // 顺手清理已删除任务的残留 id（防集合无限增长）
        const alive = new Set(tasks.map((t) => t.id))
        const payload = [...notified].filter((id) => alive.has(id))
        const tmp = `${notifiedFile}.tmp.${process.pid}`
        writeFileSync(tmp, JSON.stringify(payload) + '\n')
        renameSync(tmp, notifiedFile)
      } catch { /* 通知标记写失败不影响本轮展示 */ }
    }
    if (lines.length === 0) return null
    // 标题写明机制：摘要注入"下一次生成前"——回合内继续生成才自动可见；
    // 已结束回合需用户发消息触发（模型据此决定 wait 还是如实告知）
    return `## COI 任务状态（CLI 后台代理任务：完成摘要注入你下一次生成前，回合已结束时发任意消息即可看到；摘要为输出尾部，完整输出用 de_coi_status 查询）\n${lines.join('\n')}`
  } catch {
    return null // 数据缺失/解析失败：整段隐藏
  }
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
    scratchFile: join(config.memoryDir, 'scratch.md'),
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
 * 构建 COI 任务注入的记忆上下文文本（与 DSH 会话注入同源同规则）：
 *   长期记忆 + 用户档案（所有任务注入）；项目关键记忆仅在有 cwd 时注入，
 *   且按 git 分支过滤（与 keyBranchFilter 一致：只注入无标记或覆盖当前
 *   分支的条目）。**不注入 AGENTS.md**（用户决策：DSH 的每轮纪律/开发规则
 *   只约束 DSH 主模型，不应强加给外部 COI）。项目日志/每日日志不注入
 *   （流水太长，与 DSH 快照策略一致）。
 *   tracks 可只取部分轨（'memory'/'user'/'key' 子集，COI 调度由 AI 经
 *   injectTracks 自主选择）；缺省=全部三轨。
 * @param {MemoryStore} store - 记忆 store。
 * @param {object} [opts] - { cwd, branch, tracks } 任务工作目录/分支/注入轨。
 * @returns {string} 拼接好的上下文文本（无内容返回空串）。
 */
export function buildMemoryContext(store, { cwd, branch: declaredBranch, tracks } = {}) {
  // tracks 缺省=全部三轨（兼容快照等既有调用方）；COI 调度时由 AI 经
  // injectTracks 参数自主选择（scope 与注入无关，任何层级都能选轨注入）
  const want = (track) => tracks === undefined || tracks.includes(track)
  const parts = []
  if (want('memory')) {
    const memoryEntries = store.entriesOf('memory')
    if (memoryEntries.length > 0) parts.push(`【长期记忆（全局）】\n${memoryEntries.join('\n')}`)
  }
  if (want('user')) {
    const userEntries = store.entriesOf('user')
    if (userEntries.length > 0) parts.push(`【用户档案】\n${userEntries.join('\n')}`)
  }
  if (want('key') && cwd) {
    const keyAgent = { session: { header: { cwd } } }
    let keyEntries = store.entriesOf('key', keyAgent)
    // 分支过滤：优先用任务声明的分支（scope=project 可挂 branch，如
    // feat/tag-question-paper）；任务未声明时回退到 cwd 目录当前 checkout
    // 的分支（git branch --show-current，与 DSH 会话注入同规则）。非 git
    // 仓库/获取失败 → 全部注入。
    const branch = declaredBranch ?? gitBranch(cwd)
    if (branch !== undefined) {
      keyEntries = keyEntries.filter((entry) => {
        const scope = parseEntryBranches(entry)
        return scope === null || scope.includes(branch)
      })
    }
    if (keyEntries.length > 0) {
      const head = branch !== undefined ? `【本项目关键记忆（分支 ${branch}）】` : '【本项目关键记忆】'
      parts.push(`${head}\n${keyEntries.join('\n')}`)
    }
  }
  return parts.join('\n\n')
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
    coiCtrl.sync() // COI 模块随 coiEnabled 即时安装/卸载
    broadcastCtrl.sync() // 会话广播随 broadcastEnabled 即时安装/卸载
    promptsCtrl.sync() // 提示词模块随 promptsEnabled 即时安装/卸载
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

  // 7. COI 调度模块（de_coi 工具/命令/API）：统一调度 kimi/codex/grok/hermes
  //    等 CLI 代理。模块边界：lib/coi/* 独立目录，只通过 memoryStore.add
  //    这一个薄接口沉淀摘要；未来拆独立插件时替换该回调即可。
  //    coiEnabled 为运行时开关（默认禁用）：开启时安装（工具/命令/API 注册、
  //    任务数据目录复用），关闭时整体卸载；Web Tab 在刷新后随 API 探测出现/隐藏。
  let coiDispose = null
  const coiCtrl = {
    sync() {
      const enabled = runtime.coiEnabled === true
      if (enabled && coiDispose === null) {
        const installed = installCoi(ctx, config, {
          memoryStore: store,
          resolveCwd: (sessionId) => ctx.get('agents')?.get?.(sessionId)?.session?.header?.cwd,
          memoryContext: ({ cwd }) => buildMemoryContext(store, { cwd }),
        })
        coiDispose = installed.dispose
      } else if (!enabled && coiDispose !== null) {
        coiDispose()
        coiDispose = null
      }
    },
  }
  coiCtrl.sync()

  // 7.5 会话广播（de_broadcast）：**独立子模块**（用户拍板：明显独立的
  //     子模块不挂在别的模块下，曾跟随 coiEnabled 是事故）。broadcastEnabled
  //     独立开关（默认关）：开启时安装（de_broadcast 工具注册 + prune
  //     定时器 + 快照「会话广播」段 + 会话头部复制会话 ID 按钮），关闭时
  //     整体卸载；存储独立目录 broadcastDataDir（<memoryDir>/broadcast）。
  let broadcastDispose = null
  const broadcastCtrl = {
    sync() {
      const enabled = runtime.broadcastEnabled === true
      if (enabled && broadcastDispose === null) {
        const installed = installBroadcast(ctx, config)
        broadcastDispose = installed.dispose
      } else if (!enabled && broadcastDispose !== null) {
        broadcastDispose()
        broadcastDispose = null
      }
    },
  }
  broadcastCtrl.sync()

  // 8. 提示词管理器（Prompt Manager）：提示词库 CRUD + 注入轨（一次性/持续
  //    N 轮/每 M 回合一次，agent/turn-stopping 回合推进）+ 快照段 + Web API。
  //    复用「写后即时注入、不打断回复」通道；未来监测注入只对接注入轨 add
  //    入口。promptsEnabled 为运行时开关（默认禁用）：开启时安装，关闭时
  //    整体卸载（快照段/事件监听/API 全部移除，存储数据保留）。
  let promptsDispose = null
  const promptsCtrl = {
    sync() {
      const enabled = runtime.promptsEnabled === true
      if (enabled && promptsDispose === null) {
        const installed = installPrompts(ctx, config)
        promptsDispose = installed.dispose
      } else if (!enabled && promptsDispose !== null) {
        promptsDispose()
        promptsDispose = null
      }
    },
  }
  promptsCtrl.sync()
}
