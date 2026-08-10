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
import { ArchiveStore, MemoryStore, SuggestionQueue, extractEntryDate, gitBranch, gitBranchList, parseEntryBranches, parseEntryDshOnly, todayStamp } from './store.js'
import { readAliases } from './aliases.js'
import { reviewCommand, reviewStatusTool, reviewTurnCounter, enqueueSuggestion, suggestToolDefinition } from './review.js'
import { skillManageTool } from './skills.js'
import { installApi } from './api.js'
import { installSkillsManager } from './skills-manager.js'
import { TodoStore, todoToolDefinition } from './todo.js'
import { createSearchDocsController, searchDocsCommand } from './search-docs.js'
import { installBroadcast, installCoi } from './coi/index.js'
import { installNotify, installChannelSend } from './notify.js'
import { buildWsCoordBlock, installWsCoord } from './coi/ws-coord.js'
import { installSession } from './session-orch.js'
import { AliasStore } from './aliases.js'
import { installSessionSearch } from './search/index.js'
import { installPrompts } from './prompts.js'
import { installModels, buildModelsSnapshotAsync } from './models.js'
import { installUiSettings } from './ui-settings.js'
import { installMermaid } from './mermaid.js'
import { installBookmarks } from './bookmarks.js'

// Re-exported for the web API layer (api.js imports them from here).
export { gitBranch, gitBranchList } from './store.js'

export const name = 'dsh-memory-evolve'
// 插件级服务声明：声明过的服务 ctx.xxx 直接可用（cordis 限制：未声明的
// 服务直接读会抛 "cannot get property 'xxx' without inject"）。
// tools/systemPrompt 是历史声明；agents 于 2026-08-09 加入——会话编排
// 模块（de_session）需要它创建/唤醒会话（曾用 ctx.inject(['agents'])
// 动态注入导致工具未注册，改为声明式注入后与 tools 同款可靠）；
// workspace 同批加入——spawn 需要把新会话 attach 到工作区（左侧会话
// 列表的"项目"分组，否则新会话落在「未分组」）；
// sessionTitle 同日加入——de_session rename 改会话名称（左侧列表标题）。
// sessionPersistence 于 2026-08-11 加入——de_session wake 恢复离线会话时
// 需读该会话 log 里自己最后使用的模型（request/header），否则恢复的
// agent.options 为空、{{model}} 变量无值导致被唤醒会话回合失败。
// settings / llm 于 2026-08-11 加入——模型配置模块（de_models 工具 +
// 「模型配置」Tab）需要读取模型目录（settings.get）与供应商/思考等级
// 元数据（llm.listConfigurableProviders / resolveModelInfo）。
export const inject = ['tools', 'systemPrompt', 'agents', 'workspace', 'sessionTitle', 'sessionPersistence', 'settings', 'llm']

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
  // 四档模式（2026-08-09 用户拍板）：all=文件名+内容 / filename=仅文件名 /
  // content=仅内容 / off=工具不注册。**null = 未设置**——实际生效值由
  // controller 按「运行时 mode → 配置 mode → 旧布尔开关推断」三级解析
  // （不在此推断，避免推断值压过运行时 Web 面板/slash 命令的切换）。
  searchDocsMode: null,
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
  // 工作区冲突协调（ws-coord）：**会话广播模块的子功能组**（用户拍板
  // 2026-08-09——语义上属于"通知的一部分"，归入广播，不做独立模块）。
  // 同工作区多会话并行时的资源占用协调：声明锁（de_ws_declare）+
  // 自动登记（fs/observed 写后自动进占用集）+ 写前冲突检测（软模式：
  // 警告不拦截，先信任 AI；enforceWrite 打开升级为硬拦截）+ 冲突定向
  // 通知 + 活动感知（de_ws_status 概览 / 快照【工作区活动】段）。依赖
  // broadcastEnabled 大开关（广播关 = 本功能全部不注册）。默认关。
  wsCoordEnabled: false,
  wsCoordEnforceWrite: false, // 硬拦截模式（true=冲突时 deny 拒绝写入；默认软模式只警告）
  wsCoordSnapshot: true,      // 活动感知快照段【工作区活动】（活跃会话 ≥2 时注入一行，带时间）
  wsCoordAutoRegister: true,  // fs/observed 自动登记（false=只有声明式锁）
  wsCoordNotifyConflict: true,// 冲突时给占用方发定向通知（走广播通道）
  // 会话搜索（de_session_search）：**独立子模块**（与广播同一纪律——不挂
  // 在任何模块下）。独立开关；零常驻状态（无索引/缓存/定时器，每次调用
  // 实时只读扫描）；当前支持 Codex 源（~/.codex/sessions + archived_sessions
  // 的明文 JSONL，rg 预筛后毫秒级），DSH 会话（zstd 拼接帧）暂不实现。
  // 默认关：注册即占模型工具列表，需要时才开。
  sessionSearchEnabled: false,
  sessionSearchRoots: null,   // 每源根目录覆盖（当前仅 codex，如 { codex: '/path' }）；null=各源默认
  // 会话编排（de_session）：**独立子模块**（用户拍板纪律——独立领域
  // 不挂别的模块下）。程序化创建/唤醒 DSH 会话（spawn 新会话派长提示词、
  // wake 唤醒已有会话等价替用户发消息、status/list 查状态）。独立开关
  // 与存储目录；默认关（注册即占模型工具列表）。依赖 DSH agents 服务，
  // 仅同进程会话可唤醒；spawn 加房间经广播模块松耦合桥接。
  sessionEnabled: false,
  sessionDataDir: null,       // null → <memoryDir>/session-orch
  promptsEnabled: false,      // 提示词管理器总开关（默认禁用，与本地搜索/COI 一致；开启后「提示词」Tab、注入轨与 de_prompts 工具生效）
  promptToolName: 'de_prompts', // 提示词库工具名（AI 查询/注入提示词；随 promptsEnabled 开关注册/注销）
  scratchEnabled: false,      // 临时信息 Tab 总开关（默认禁用，与本地搜索/COI 一致；开启后「临时信息」Tab 出现，内容持久化在 <memoryDir>/scratch.md）
  // 模型配置（de_models + 「模型配置」Tab）：**独立子模块**（与其他模块
  // 同款独立开关）。表格展示 DSH 供应商/模型 + 每模型启用/备注/思考等级
  // 配置；de_models 工具给 AI 查询可用模型清单。**默认关闭**（与其他
  // 独立模块一致：注册即占模型工具列表，需要时再开；且本模块的配置
  // 只对插件自身有用——不修改也不影响 DSH 的模型设置，DSH 侧仍以官方
  // 「设置 → 模型」为准）。
  modelsEnabled: false,
  // DSH UI 设置（dsh-ui-settings）：**独立子模块**（与广播/COI 同一纪律——
  // 独立领域不挂别的模块下）。对 DSH web 界面做样式级小功能（第一版：左侧
  // 会话列表「仅显示进行中」筛选，默认只显示进行中的会话、可一键切回全部；
  // 后期扩展：主题更换等）。纯客户端实现（CSS + DOM 增强），宿主端只提供
  // 开关与状态端点；**默认关闭**（与其他独立模块一致，需要时再开）。
  uiSettingsEnabled: false,
  // 会话书签（session bookmarks）：**独立子模块**（与广播/UI 设置同一纪律——
  // 独立领域不挂别的模块下）。每轮星标 + 书签列表 + 跳转定位（第一阶段）；
  // 第二阶段才做「从此处新建官方分支」。纯 UI + 宿主 API（不注册 AI 工具）；
  // 存储独立 sidecar <memoryDir>/session-bookmarks.json；**默认关闭**。
  bookmarkEnabled: false,
  // 渠道通知（de_notify）：**独立子模块**（与广播/COI 同一纪律——独立领域
  // 不挂别的模块下）。AI 完成任务后通过 IM 渠道（一期：飞书）**主动发通知**
  // 给用户。渠道能力来自渠道插件（dsh-feishu 等**公共插件**）在 apply 时
  // 登记的 globalThis 注册表（用户拍板方案 A）——本模块**零依赖**渠道插件
  // （没装/旧版无钩子 → 如实报"渠道不可用"，主插件零影响）。两种触发：
  // ①de_notify 手动工具（随时可发、无频率约束——用户拍板）；
  // ②COI 完成自动通知（COI 运行时配置 coiNotifyChannels，经 sendChannelNotify
  // 回调松耦合桥接，notify 未启用时 COI 侧静默跳过）。**默认关闭**（与其他
  // 独立模块一致：注册即占模型工具列表，需要时再开）。
  notifyEnabled: false,
  // 渠道直发（de_channel_send）：**独立子模块**（2026-08-10 用户拍板——与
  // notify 同一纪律：独立领域独立开关；当天由 de_feishu_send 泛化为四渠道：
  // feishu/qq/weixin/wecom）。AI 主动发送文本/图片/文件到 IM 渠道（DSH→渠道
  // 单向，不带「非对话」通知标注）。渠道能力来自各渠道插件（dsh-feishu /
  // dsh-qqbot / dsh-weixin / dsh-wecombot）的 globalThis 注册表（sendMedia
  // 槽位，插件版本需支持附件）。**默认开启**（用户拍板要的功能，开箱即用；
  // 与 notifyEnabled 互不影响：直发 vs 通知，语义不同、开关粒度独立）。
  channelSendEnabled: true,
}

/** Keys the Web UI may change at runtime (persisted to stateFile). */
export const RUNTIME_KEYS = [
  'reviewEnabled', 'reviewInterval', 'reviewMode', 'skillReviewEnabled',
  'perTurnProjectWrites', 'perTurnDailyWrites', 'perTurnKeyWrites',
  'searchDocsEnabled', 'coiEnabled', 'broadcastEnabled', 'promptsEnabled', 'scratchEnabled',
  'sessionSearchEnabled', 'sessionEnabled', 'modelsEnabled', 'uiSettingsEnabled',
  'bookmarkEnabled', 'searchDocsMode',
  'wsCoordEnabled', 'wsCoordEnforceWrite', 'wsCoordSnapshot',
  'notifyEnabled', 'channelSendEnabled',
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
    case 'searchDocsMode':
      if (key === 'searchDocsMode') {
        // null = 未设置（controller 按 searchDocsEnabled 推断生效档）。
        // ⚠️ GET /api/config 回显的就是 null（runtime={...config} 的
        // DEFAULTS 占位），保存必须允许它，否则设置面板一保存就报错。
        if (value !== null && !['all', 'filename', 'content', 'off'].includes(value)) {
          throw new Error('dsh-memory-evolve: searchDocsMode 必须是 all / filename / content / off 之一（或 null 恢复默认推断）')
        }
        return
      }
      if (typeof value !== 'boolean') throw new Error(`dsh-memory-evolve: ${key} 必须是布尔值`)
      return
    case 'coiEnabled':
    case 'broadcastEnabled':
    case 'promptsEnabled':
    case 'scratchEnabled':
    case 'sessionSearchEnabled':
    case 'sessionEnabled':
    case 'modelsEnabled':
    case 'uiSettingsEnabled':
    case 'bookmarkEnabled':
    case 'wsCoordEnabled':
    case 'wsCoordEnforceWrite':
    case 'wsCoordSnapshot':
    case 'notifyEnabled':
    case 'channelSendEnabled':
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
  'promptsEnabled', 'scratchEnabled', 'sessionSearchEnabled', 'sessionEnabled',
  'notifyEnabled', 'channelSendEnabled',
]
const STRING_KEYS = [
  'toolName', 'suggestToolName', 'commandName', 'reviewMode',
  'skillManageToolName', 'searchDocsToolName', 'searchDocsCommandName',
  'promptToolName',
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
  config.sessionDataDir = resolve(config.sessionDataDir ?? join(config.memoryDir, 'session-orch'))
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
 * @param {object|null} [sessionTitleService] - DSH sessionTitle 服务（可选，
 *   会话名称显示用；不可用/未传时名称不显示——兼容降级）。
 * @returns {string} the snapshot text (empty when nothing is stored).
 */
export function renderSnapshot(config, store, agent, counter, wsCoordStore = null, wsCoordMeta = null, wsCoordArchived = null, sessionTitleService = null) {
  const parts = []
  // 会话 ID 段（快照最前面的独立输出端，常驻注入，不随任何模块开关）：
  // AI 始终知道"我是谁"——广播消息判断 sender/recipients 谁是谁、回复时
  // 把此 ID 告知对方，以及未来其他模块的消费者都要用它。固定文本（会话
  // 生命周期内不变，缓存友好）；无会话视角（subagent 等）不注入。
  // 会话名称/别名（2026-08-12 用户要求）：同款"有就显示、没有就不显示"
  // 的兼容逻辑——名称来自 DSH sessionTitle 服务（自动生成/用户 rename，
  // 更新粒度为"用户消息后"，不是每步渲染——符合快照段状态驱动稳定铁律；
  // live 会话可读，服务不可用/无标题时置 null 不显示）；别名来自本插件
  // aliases.json（用户手动设置，≤10 字）。两者都无时输出与旧版完全一致
  // （只有 ID），零变化兼容。
  if (agent?.session?.id) {
    const aliases = readAliases(config.memoryDir ?? '')
    const alias = aliases[agent.session.id]
    let title = null
    try {
      title = sessionTitleService?.get?.(agent.session)?.title ?? null
    } catch { /* 标题读取失败置 null（兼容降级） */ }
    if (alias || title) {
      const bits = []
      if (title) bits.push(`- 你的会话名称：${title}`)
      if (alias) bits.push(`- 你的会话别名：${alias}`)
      bits.push(`- 你的会话 ID：${agent.session.id}`)
      parts.push(`## 你的会话（用名称/别名/ID 与各模块消息里的 session id 比对判断是谁；回复时把名称/别名与 ID 告知对方）\n${bits.join('\n')}`)
    } else {
      parts.push(`## 你的会话 ID（记住它：用它与各模块消息里的 session id 比对判断是谁；回复时也可把此 ID 告知对方）\n- 你的会话 ID：${agent.session.id}`)
    }
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
        const base = `仅在完成**独立成果**时（一项实质产出、一个关键决策或踩坑结论），用 memory 工具一次调用（entries 数组）向 ${writeTargets.join(' 与 ')} 写入 1 条，保持简洁`
        steps.push(keyDuty
          ? `${base}；重要结论可另向 target=key 提交建议（用户确认后生效）；没有独立成果就跳过，不要为写而写。`
          : `${base}；没有独立成果就跳过，不要为写而写。`)
      } else {
        const duties = []
        if (writeTargets.length > 0) {
          // 一次调用批量写（entries 数组含各轨一项），省一次工具往返。
          // writeTargets 元素形如 'target=daily'，直接 join(' 与 ') 拼进提示。
          duties.push(`用 memory 工具**一次调用**（action=add + entries 数组，含 ${writeTargets.join(' 与 ')} 各一项）写 1 条本回合进展（1-2 行具体内容）`)
        }
        if (keyDuty) duties.push('本轮出现重要项目事实（长期约定/决策/架构/踩坑）时另向 target=key 提交 1 条建议（用户确认后写入并注入），没有则跳过')
        // 用户情绪反馈记录（2026-08-10）：真人用户本回合输入有明显情绪时，
        // 给 daily/project 条目都带 feedback 参数（程序拼接【反馈】行，格式
        // 固定可检索）；分类按轨区分：daily 通用分层、project 项目内分层。
        if (writeTargets.length > 0) {
          duties.push('本回合真人用户输入有明显情绪（正面/负面）时，各条目带 feedback 参数（sentiment/category/quote/note，程序自动生成【反馈】行）——daily 的 category 写通用分类（如 编程/后端/数据库，至少一级可到三级；分类指工作类型如 编程→前端开发→JavaScript，不是任务涉及的功能/模块名），project 的 category 写本项目内分层（如 记忆模块/写入链路，按项目实际结构）；中性任务指令或其他会话 AI 消息不带 feedback')
        }
        steps.push(`1. 写入：${duties.join('；')}；`)
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
    const bcastBlock = buildBroadcastBlock(config, agent?.session?.id, agent?.session?.header?.cwd)
    if (bcastBlock !== null) parts.push(bcastBlock)
  }
  // 工作区活动感知（ws-coord，广播模块子功能）：活跃会话 ≥2 时注入一行
  // 【工作区活动】（带当前时间，其他会话据此判断新旧；0~1 个会话零开销）。
  // 这是"AI 主动知道谁在跑、在干什么"的被动通道——配合 de_ws_status
  // 主动查询。依赖广播大开关（wsCoord 只在 broadcastEnabled 时安装）。
  // ⚠️ 本函数是**模块级函数**（export function renderSnapshot），wsCoord
  // 实例经参数传入（wsCoordStore/wsCoordMeta，默认 null）——绝不能在函数
  // 体内引用 apply 闭包的 wsCoordStoreRef（ReferenceError，2026-08-09
  // 实测踩坑：曾误写 ref 名导致"wsCoordStoreRef is not defined"）。
  if (config.wsCoordEnabled === true && wsCoordStore !== null && wsCoordMeta !== null) {
    const wsBlock = buildWsCoordBlock(
      config,
      agent?.session?.id,
      agent?.session?.header?.cwd,
      wsCoordStore,
      wsCoordMeta,
      (sid) => {
        // 活动段显示名：**完整会话 ID**（2026-08-09 用户拍板）——AI 看到
        // 活动段后可用完整 ID 调 de_session status 确认对方是否真的在运行；
        // 截短 ID 无法查询。有别名时"别名（完整ID）"便于人读。
        const aliases = readAliases(config.memoryDir ?? '')
        const alias = aliases[sid]
        return alias !== undefined ? `${alias}（${sid}）` : sid
      },
      wsCoordArchived, // 已归档会话集合（过滤活动段：归档=用户已隐藏，2026-08-09 修复）
    )
    if (wsBlock !== null) parts.push(wsBlock)
  }
  return parts.join('\n\n')
}

/**
 * 会话广播快照段：查看会话的未读消息清单（无未读/无查看者/数据缺失
 * 返回 null，零开销）。**定点注入**：只对可见消息列出——直接接收者
 * （显式会话 ID）/ **房间成员**（room:<id>，读同目录 rooms.json 判断
 * 成员）/ **项目内会话**（project:<路径>，按查看会话 cwd 匹配）；
 * 未读（readBy 不含当前会话）才列出。**收件箱式**——每条只给 id+主题+
 * 发送者+时间（不注入正文，克制），AI 可直接 de_broadcast read <id>
 * 拿全文，无需先 list。文案面向 AI（指令式：必须逐条查看处理），不含
 * GUI 指引。read 后标记已读，行随之消失。
 *
 * 自 2026-08-09 起附带**「房间动态」段**（用户拍板：成员状态变化不再
 * 发收件箱系统通知——未读会逼模型 read，高频低信息量不划算）：读
 * dynamics.json 队列，把"上次水位之后"的同房成员 running/idle 变化
 * 注入快照，**渲染即消费**（同步推进水位落盘 = 程序替模型已读，模型
 * 无需 read；渲染时刻=送达时刻，快照 diff 变了必注入）。同一成员连续
 * 多条变化合并为最新状态（快速 running→idle 不刷屏）。
 * @param {object} config - resolved plugin config（含 broadcastDataDir/memoryDir）。
 * @param {string} [sessionId] - 查看会话 id（无会话视角时不注入）。
 * @param {string} [cwd] - 查看会话工作目录（project: 伪接收者判断用）。
 * @returns {string | null}
 */
export function buildBroadcastBlock(config, sessionId, cwd) {
  if (!sessionId) return null
  try {
    // 独立存储目录：broadcastDataDir（null → <memoryDir>/broadcast）
    const dir = config.broadcastDataDir ?? join(config.memoryDir ?? '', 'broadcast')
    const file = join(dir, 'broadcast.json')
    // 未读清单与房间动态**互为独立**：broadcast.json 缺失但有动态队列
    // （dynamics.json）时也要注入动态段——两者都不存在才整段隐藏
    if (!existsSync(file) && !existsSync(join(dir, 'dynamics.json'))) return null
    const parsed = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
    const messages = Array.isArray(parsed) ? parsed : []
    // 房间成员表（room:<id> 伪接收者判断；文件缺失=无房间）
    let rooms = {}
    try {
      const rp = JSON.parse(readFileSync(join(dir, 'rooms.json'), 'utf8'))
      if (rp && typeof rp === 'object' && !Array.isArray(rp)) rooms = rp
    } catch { /* 无房间文件：忽略 */ }
    // 房间动态队列（成员状态变化快照直达；文件缺失=无动态）
    let dynamics = { seq: 0, events: [], cursors: {} }
    try {
      const dp = JSON.parse(readFileSync(join(dir, 'dynamics.json'), 'utf8'))
      if (dp && typeof dp === 'object') dynamics = { seq: 0, events: [], cursors: {}, ...dp }
    } catch { /* 无动态文件：忽略 */ }
    // 会话别名表（发件人友好显示；在 memoryDir，与广播存储不同目录）
    const aliases = readAliases(config.memoryDir ?? '')
    const visible = (m) => {
      if (!Array.isArray(m.recipients)) return false
      if (m.recipients.includes(sessionId)) return true
      // 伪接收者宽容解析（与 lib/coi/broadcast.js parseRef 一致）：
      // room:<id> 或裸房间 id（room-xxx）、project:<绝对路径>
      for (const r of m.recipients) {
        if (typeof r !== 'string') continue
        let roomId = null
        let projectPath = null
        if (r.startsWith('room:')) roomId = r.slice(5)
        else if (/^room-[0-9a-z-]+$/.test(r)) roomId = r
        else if (r.startsWith('project:')) projectPath = r.slice(8)
        if (roomId !== null) {
          const room = rooms[roomId]
          if (room && Array.isArray(room.members) && room.members.includes(sessionId)) return true
        }
        if (projectPath !== null && cwd && cwd === projectPath) return true
      }
      return false
    }
    const unread = messages.filter((m) =>
      visible(m) && !(Array.isArray(m.readBy) && m.readBy.includes(sessionId)))
    // ⚠️ 不能提前 return（曾有 if (unread.length === 0) return null）：
    // 无未读时可能仍有「房间动态」段要注入，两部分互为独立
    const lines = unread.slice(0, 5).map((m) => {
      const when = new Date(m.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      // 主题：老消息无 subject 时兜底取内容首行（与 de_broadcast 一致）
      let subject = m.subject ?? ''
      if (subject === '') {
        const first = String(m.content ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '')
        subject = first !== undefined ? first.replace(/^[#>*\-`\s]+/, '').slice(0, 40) : ''
      }
      // 消息类型标记（谁发给谁的直观化）：私信（显式含我）/ 房间：群名 /
      // 项目：路径——房间/项目消息是所有成员/同目录共有的，标注出来
      let type = '私信'
      for (const r of m.recipients) {
        if (typeof r !== 'string') continue
        if (r.startsWith('room:') || /^room-[0-9a-z-]+$/.test(r)) {
          const rid = r.startsWith('room:') ? r.slice(5) : r
          const room = rooms[rid]
          type = `房间：${room && room.name ? room.name : rid}`
        } else if (r.startsWith('project:')) {
          type = `项目：${r.slice(8)}`
        }
      }
      // 发件人显示：系统通知=「系统」；否则会话别名优先（别名（短ID），
      // 拟人化且保留 ID 供 read/回复用），无别名=短 ID
      let from
      if (m.sender === 'system') {
        from = '系统'
      } else {
        const alias = aliases[m.sender]
        const short = m.sender.length > 12 ? `${m.sender.slice(0, 12)}…` : m.sender
        from = alias !== undefined ? `${alias}（${short}）` : short
      }
      return `- 📨 ${m.id}【${subject}】来自 ${from}（${type}）${when}`
    })
    if (unread.length > 5) lines.push(`- …还有 ${unread.length - 5} 条未读（de_broadcast list 查看）`)
    // 标题即指令（AI 消费）：必须逐条 read 处理，未处理完不要结束回合
    const parts = []
    if (unread.length > 0) {
      parts.push(`## 会话广播（未读消息 ${unread.length} 条：必须用 de_broadcast read 逐条查看并处理，未处理完不要结束回合）\n${lines.join('\n')}`)
    }
    // ---- 房间动态段（成员状态变化快照直达，渲染即消费）----
    // 用户拍板 2026-08-09：状态变化不走收件箱（未读逼模型 read 不划算），
    // 直接进快照；本段在**渲染时**同步消费（推进水位落盘 = 程序替模型
    // 已读，无需 read；渲染时刻=送达时刻，快照 diff 变了必注入）。
    // 只显示：我所在未解散房间的、水位之后的变化（离开/已解散后不收）。
    const myRoomIds = new Set(
      Object.values(rooms)
        .filter((r) => r.status !== 'dissolved' && Array.isArray(r.members) && r.members.includes(sessionId))
        .map((r) => r.id))
    const cursor = (dynamics.cursors ?? {})[sessionId] ?? 0
    // 只显示：我所在房间的、水位之后的、**别人**的变化（自己的状态
    // 自己知道，不注入自己；水位仍照常推进，避免积累）
    const pending = (Array.isArray(dynamics.events) ? dynamics.events : [])
      .filter((e) => e && typeof e.seq === 'number' && e.seq > cursor && myRoomIds.has(e.roomId) && e.member !== sessionId
        // 防御：变化者本人也必须是房间成员（写入侧已保证，这里兜底
        // 防脏数据——非成员的变化事件不注入）
        && (rooms[e.roomId]?.members ?? []).includes(e.member))
    if (pending.length > 0) {
      // 合并（用户拍板：状态变化不需要实时逐条，一段窗口内的连续变化
      // 组合后一次注入）：同一 房间+成员 的多条变化只取**最后一条**
      // （最新状态）——快速 running→idle 不刷屏，模型只需知道当前状态
      const latestByMember = new Map()
      for (const e of pending) latestByMember.set(`${e.roomId}|${e.member}`, e)
      const merged = [...latestByMember.values()].sort((a, b) => a.at - b.at)
      const maxShow = 10 // 克制：最多 10 条，防刷屏
      const dynLines = merged.slice(0, maxShow).map((e) => {
        const room = rooms[e.roomId]
        const roomName = room && room.name ? room.name : e.roomId
        const when = fmtMmddHms(e.at)
        const member = String(e.member ?? '')
        const alias = aliases[member]
        const short = member.length > 12 ? `${member.slice(0, 12)}…` : member
        const who = alias !== undefined ? `${alias}（${short}）` : short
        if (e.kind === 'running') {
          return `- ${when} ${who} 开始干活（${roomName}）——正在生成，可直接向它发消息，它回合内可见`
        }
        // idle：语义明确化（用户拍板：模型不一定知道回合走完需要 wake）
        return `- ${when} ${who} 干完/闲了（${roomName}）——已结束回合，要它干活需 de_session wake，别傻等`
      })
      if (merged.length > maxShow) dynLines.push(`- …还有 ${merged.length - maxShow} 条更早变化（de_broadcast presence 可查当前状态）`)
      // 标题中性（用户拍板：不能写"无需处理"——那会诱导模型忽略状态
      // 变化，而这些恰恰是需要行动的：idle 要 wake、running 可发消息）。
      // ⏰ 当前时间锚点（2026-08-11 用户要求）：动态行是**事件时间**，
      // 可能跨天（昨天的变化今天才看到）；标题标注**快照渲染时刻**（精确
      // 到秒）后，模型一眼对比就知道哪些是刚发生的、哪些是以前的——
      // 与 de_broadcast 输出最前面的当前时间锚点同格式原则
      parts.push(`## 房间动态（成员状态变化 · ⏰ 当前 ${fmtFullDateTime(Date.now())}）\n${dynLines.join('\n')}`)
      // 渲染即消费：推进水位到最新事件（程序替模型已读；下次渲染这些
      // 变化不再出现，快照文本回到基线——DSH diff 不再触发重复注入）。
      // 注意：lib 侧直接操作文件（与读 broadcast.json 同款原子写），
      // 保留 events 原样、只更新 cursors 中本会话的水位，不动他人水位
      const latest = Number.isInteger(dynamics.seq) ? dynamics.seq : 0
      if (latest > cursor) {
        const dynFile = join(dir, 'dynamics.json')
        mkdirSync(dir, { recursive: true })
        const tmp = `${dynFile}.tmp.${process.pid}`
        writeFileSync(tmp, JSON.stringify({ seq: dynamics.seq, events: dynamics.events, cursors: { ...(dynamics.cursors ?? {}), [sessionId]: latest } }) + '\n')
        renameSync(tmp, dynFile)
      }
    }
    return parts.length > 0 ? parts.join('\n\n') : null
  } catch {
    return null // 数据缺失/解析失败：整段隐藏
  }
}

/**
 * 动态事件时间显示：MM-DD HH:mm:ss（带日期——变化可能跨天，只有时分
 * 会让模型误判"刚发生"；与 de_broadcast 输出锚点同格式原则）。
 * @param {number} ts - 时间戳
 */
function fmtMmddHms(ts) {
  const d = new Date(ts)
  const pad2 = (n) => String(n).padStart(2, '0')
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/**
 * 完整日期时间（快照「房间动态」标题的当前时间锚点用）：
 * YYYY-MM-DD HH:mm:ss 精确到秒——与 de_broadcast 输出最前面的
 * 「⏰ 当前时间」同格式，模型拿它对比各动态行的事件时间判断新旧。
 * @param {number} ts - 时间戳
 */
function fmtFullDateTime(ts) {
  const d = new Date(ts)
  const pad2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
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
  // entries 多轨批量写：逐轨渲染结果，模型一眼看清哪轨成功/失败
  if (Array.isArray(value.multi) && value.multi.length > 0) {
    lines.push('批量写入结果：')
    value.multi.forEach((m) => lines.push(`- ${m.target}: ${m.message}`))
  }
  return lines.join('\n')
}

/**
 * Strip the full entry list and store-internal fields from a write result:
 * add/replace/remove return the whole track (and `removed` 原文) for internal
 * bookkeeping, but the model only needs the outcome (list is the read path
 * that returns entries). `removed` 不在 output schema 内（additionalProperties
 * :false 下多字段会被模型 API 拒），必须一并剥除。
 * @param {object} result - the store result.
 * @returns {object} the same result without `entries` / `removed`.
 */
function outcomeOnly(result) {
  if (result && typeof result === 'object') {
    const { entries, removed, ...rest } = result
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
 * @param {() => object} getRuntime - runtime config getter.
 * @param {ArchiveStore} archive - the archive store (archive action 用：
 *   主轨条目移动到对应归档文件）。
 * @returns {object} a ToolDefinition-shaped object.
 */
export function memoryTool(ctx, config, store, queue, getRuntime, archive) {
  /**
   * 程序拼接【反馈】行（用户情绪反馈记录，2026-08-10 上线）。
   * sentiment 必填（positive/negative）；category/quote/note 可缺省
   * （缺省段不输出，category 缺省标"未分类"）。所有字段清洗
   * |、换行、§、引号（防破坏 § 分隔的 MD 条目格式）；quote 强制截断
   * ≤20 字（用户原话摘录，可溯源证据）。返回 '' 表示不生成行。
   * @param {object|null} feedback - 工具的 feedback 参数（或 entries 项内的）。
   * @returns {string} 【反馈】行文本，或 ''。
   */
  function buildFeedbackLine(feedback) {
    if (!feedback || typeof feedback !== 'object') return ''
    const sent = feedback.sentiment === 'positive' ? '正面' : feedback.sentiment === 'negative' ? '负面' : null
    if (sent === null) return ''
    const clean = (s) => String(s ?? '').replace(/[|\n\r§"]/g, '').trim()
    const cat = clean(feedback.category) || '未分类'
    const quote = clean(feedback.quote).slice(0, 20)
    const note = clean(feedback.note)
    const tag = feedback.manual === true ? '【反馈·手动】' : '【反馈】'
    const parts = [`情绪:${sent}`, `分类:${cat}`]
    if (quote) parts.push(`原话:"${quote}"`)
    if (note) parts.push(`表现:${note}`)
    return `${tag}${parts.join(' | ')}`
  }

  /**
   * 单轨 add 的公共实现（entries 批量与单轨 add 共用）：
   * - feedback 行由程序拼接后附加到条目末尾（仅 daily/project 轨生效；
   *   key 轨忽略 feedback，走建议队列；memory/user 也不生成行）；
   * - key 轨 add 进待确认队列（用户确认后写入并注入），不直接落盘；
   * - 结果统一 outcomeOnly（剥 entries/removed，严格对齐 output schema）。
   * @param {string} target - 记忆轨。
   * @param {string} content - 条目内容。
   * @param {object|null} feedback - feedback 参数（可为空）。
   * @param {object} exec - 工具执行上下文（agent 等）。
   * @returns {Promise<object>} 工具友好结果 {ok, message, target, ...}。
   */
  async function addOne(target, content, feedback, exec) {
    const fbLine = target === 'daily' || target === 'project' ? buildFeedbackLine(feedback) : ''
    let finalContent = String(content ?? '').trim()
    if (fbLine !== '') finalContent = finalContent === '' ? fbLine : `${finalContent}\n${fbLine}`
    if (finalContent === '') return { ok: false, message: '内容不能为空', target }
    if (target === 'key') {
      const outcome = enqueueSuggestion(queue, 'key', finalContent, '每轮收尾自动提交的项目关键记忆建议', exec?.agent)
      if (outcome.ok) {
        outcome.message = `已提交待确认的项目关键记忆建议（队列 ${outcome.queued} 条）——用户确认后才会写入并注入`
      }
      // queued 不在输出 schema 内（additionalProperties:false），剥离
      const { queued: _queued, ...rest } = outcome
      return outcomeOnly(rest)
    }
    const addResult = store.add(target, finalContent, exec.agent)
    return outcomeOnly(addResult)
  }

  return {
    name: config.toolName,
    description: '读写长期记忆（跨会话持久，随上下文快照对模型可见）。target=memory 存全局环境/项目事实，target=user 存用户事实，target=project 存当前工作目录的项目日志（仅当前项目会话可见），target=key 存当前项目的关键长期记忆（自动注入上下文，仅当前项目会话可见；支持 branches 限定 git 分支范围，缺省=全部；**写入需用户确认**：add 会进入待确认队列，确认后生效），target=daily 追加今日日志（按需读取，不注入）。add 追加条目；replace 用唯一子串片段替换整个条目；remove 用唯一子串片段删除条目；**archive 把条目归档（仅 memory/user/key 三轨）**：按唯一子串片段从主轨移除整条、原文追加进对应归档文件（MEMORY-archive.md / USER-archive.md / 项目 KEY-archive.md，可逆——记忆 Tab 归档页可移回主记忆），适合"已不再需要注入、但丢之可惜"的低频旧事；list 查询条目——默认查主轨（未归档，全部返回，按时间正序），支持 filter（关键词过滤）、since/until（日期范围 YYYY-MM-DD，daily 可跨文件查历史日志）、limit（最多条数，配合 recent 取最近 N 条）、recent（最新在前）、branch（key 轨：只返回该分支可见的条目）、**archived=true（查对应归档文件 MEMORY-archive.md / USER-archive.md / 项目 KEY-archive.md——仅 memory/user/key 三轨，key 需要会话工作目录；归档不注入，可移回主记忆）**；查不到匹配或日期无法解析时，去掉过滤条件重查。**每轮收尾批量写**：写每日日志+项目日志用一次调用（action=add 且 entries 数组含 target=daily 与 target=project 两项，entries 仅支持这两轨），不要分成两次调用。**情绪反馈**：若本回合真人用户输入有明显情绪（正面如"太好了/谢谢"，负面如"怎么还没改对/再试一次"），给 daily 和 project 两条都带 feedback 参数（sentiment/category/quote/note，程序自动生成【反馈】行并清洗特殊字符）；daily 的 category 写通用分层（如 编程/后端/数据库；分类指工作类型如 编程→前端开发→JavaScript，不是任务涉及的功能/模块名），project 的 category 写项目内分层（如 记忆模块/写入链路，按项目实际结构）；中性任务指令或其他会话 AI 发来的消息不要带 feedback。写入立即落盘，模型上下文将在下一次刷新时更新。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'replace', 'remove', 'archive', 'list'],
          description: '要执行的操作',
        },
        target: {
          type: 'string',
          enum: ['memory', 'user', 'project', 'key', 'daily'],
          description: '记忆轨：memory=全局环境/项目事实，user=用户事实，project=当前项目日志，key=当前项目关键长期记忆（自动注入），daily=今日日志；archive 与 archived 查询只支持 memory/user/key',
        },
        content: {
          type: 'string',
          description: 'add/replace 的新条目内容（可多行）',
        },
        entries: {
          type: 'array',
          description: 'add 可选：一次调用多轨批量写入（每轮收尾合并写 daily+project 用，省一次工具往返）。每项 {target, content, feedback?}；**仅支持 daily/project 两轨**（其他轨请用单轨参数，避免绕过全局轨门禁）；传了 entries 时忽略顶层 target/content，逐项执行并返回每轨结果',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              target: {
                type: 'string',
                enum: ['daily', 'project'],
                description: '记忆轨：仅 daily（今日日志）或 project（当前项目日志）',
              },
              content: {
                type: 'string',
                description: '条目内容（同顶层 content）',
              },
              feedback: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  sentiment: {
                    type: 'string',
                    enum: ['positive', 'negative'],
                    description: '情绪：positive=正面（太好啦/谢谢/不错），negative=负面（怎么还没改对/又错了/再试一次）；仅真人用户明确评价时给，程序会清洗特殊字符',
                  },
                  category: {
                    type: 'string',
                    description: '任务分类：daily 轨写通用分层（如 编程/后端/数据库，至少一级可到三级；一级参考：编程/文档/运维/数据分析/设计/通用；分类指工作类型如 编程→前端开发→JavaScript，不是任务涉及的功能/模块名，模块名只属于 project 轨）；project 轨写本项目内分层（如 记忆模块/写入链路，按项目实际结构，不强制层级数）',
                  },
                  quote: {
                    type: 'string',
                    description: '用户原话摘录（程序自动截断 ≤20 字并清洗；情绪判定的可溯源证据）',
                  },
                  note: {
                    type: 'string',
                    description: '表现一句话（好/不好 + 原因，如 改了两轮还没对）',
                  },
                  manual: {
                    type: 'boolean',
                    description: 'true=用户手动要求记录（生成【反馈·手动】前缀）；缺省=false（自动捕获）',
                  },
                },
                required: ['sentiment'],
                description: 'add 可选：本回合真人用户输入有明显情绪时附带，程序自动在条目末尾拼接【反馈】行（格式固定可检索，特殊字符自动清洗）；中性任务指令或其他会话 AI 消息不要带',
              },
            },
            required: ['target', 'content'],
          },
        },
        feedback: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sentiment: {
              type: 'string',
              enum: ['positive', 'negative'],
              description: '情绪：positive=正面（太好啦/谢谢/不错），negative=负面（怎么还没改对/又错了/再试一次）；仅真人用户明确评价时给，程序会清洗特殊字符',
            },
            category: {
              type: 'string',
              description: '任务分类：daily 轨写通用分层（如 编程/后端/数据库，至少一级可到三级；一级参考：编程/文档/运维/数据分析/设计/通用）；project 轨写本项目内分层（如 记忆模块/写入链路，按项目实际结构，不强制层级数）',
            },
            quote: {
              type: 'string',
              description: '用户原话摘录（程序自动截断 ≤20 字并清洗；情绪判定的可溯源证据）',
            },
            note: {
              type: 'string',
              description: '表现一句话（好/不好 + 原因，如 改了两轮还没对）',
            },
            manual: {
              type: 'boolean',
              description: 'true=用户手动要求记录（生成【反馈·手动】前缀）；缺省=false（自动捕获）',
            },
          },
          required: ['sentiment'],
          description: 'add 可选（仅 daily/project 轨生效）：本回合真人用户输入有明显情绪时附带，程序自动在条目末尾拼接【反馈】行（格式固定可检索，特殊字符自动清洗）；中性任务指令或其他会话 AI 消息不要带',
        },
        match: {
          type: 'string',
          description: 'replace/remove/archive 的匹配片段，必须唯一命中一个条目',
        },
        archived: {
          type: 'boolean',
          description: 'list 可选：true 时查询对应归档文件（MEMORY-archive.md / USER-archive.md / 项目 KEY-archive.md），仅 memory/user/key 三轨，key 需要会话工作目录',
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
          // list 元数据：该轨总条目数与最早/最新日期（指导模型合理设置查询范围）
          total: { type: 'integer' },
          earliest: { type: 'string' },
          latest: { type: 'string' },
          // entries 多轨批量写的结果数组（每轨 {target, ok, message}）
          multi: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                target: { type: 'string' },
                ok: { type: 'boolean' },
                message: { type: 'string' },
              },
              required: ['target', 'ok', 'message'],
            },
          },
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
      // target 兜底校验：required 已放宽为仅 ['action']（entries 批量模式
      // 不需要顶层 target），其他操作缺 target 时给出明确错误而非底层报错。
      const isEntriesAdd = action === 'add' && Array.isArray(args.entries) && args.entries.length > 0
      if (!target && !isEntriesAdd) {
        return { ok: false, message: '缺少 target（记忆轨必填；每轮收尾批量写请用 add + entries 数组）' }
      }
      let result
      try {
        switch (action) {
          case 'list': {
            // archived=true：查归档文件（MEMORY-archive.md / USER-archive.md /
            // 项目 KEY-archive.md）——归档内容不注入、主轨 list 看不到，
            // 需要时可在这里检索（移回主记忆走记忆 Tab 或人工转正）。
            if (args.archived === true) {
              if (target !== 'memory' && target !== 'user' && target !== 'key') {
                result = { ok: false, message: 'archived 查询只支持 memory / user / key（project/daily 不归档）', target }
                break
              }
              const cwd = exec?.agent?.session?.header?.cwd
              if (target === 'key' && !cwd) {
                result = { ok: false, message: 'key 归档查询需要会话工作目录', target }
                break
              }
              let entries = archive.entriesOf(target, cwd)
              // 轻量过滤：filter 子串（大小写不敏感）、since/until 按时间戳
              // 前缀比较、recent 倒序、limit 截断——与主轨 list 语义对齐
              const q = String(args.filter ?? '').trim().toLowerCase()
              if (q) entries = entries.filter((e) => e.toLowerCase().includes(q))
              const stamp = (e) => { const m = /^\[(\d{4}-\d{2}-\d{2})\]/.exec(e); return m ? m[1] : null }
              if (args.since !== undefined) {
                const s = String(args.since)
                entries = entries.filter((e) => { const d = stamp(e); return d !== null && d >= s })
              }
              if (args.until !== undefined) {
                const u = String(args.until)
                entries = entries.filter((e) => { const d = stamp(e); return d !== null && d <= u })
              }
              if (args.recent === true) entries = [...entries].reverse()
              if (args.limit !== undefined && Number.isInteger(args.limit) && args.limit > 0) {
                entries = entries.slice(0, args.limit)
              }
              result = {
                ok: true,
                message: `${target} 归档：${entries.length} 条（归档不注入；需要时可移回主记忆）`,
                target,
                entries: [...entries],
                chars: entries.join('\n').length,
              }
              break
            }
            const stats = {}
            // ── 大文件轨查询保护（2026-08-10）──
            // project/daily 是追加增长型日志（一年可达几千条），模型无参数
            // list 会拉回全量 → 上下文 token 爆炸。未显式传 limit/recent 时
            // 默认"最近 50 条倒序"，并返回元数据（total/earliest/latest）让
            // 模型判断查询范围（日志就是给 AI 查的，信息越清楚查得越准）。
            // 显式传 limit/recent 时尊重显式值；memory/user/key 轨不设保护。
            const isLog = target === 'project' || target === 'daily'
            const protectedView = isLog
              && args.limit === undefined
              && args.recent === undefined
              && args.since === undefined
              && args.until === undefined
            const queryOpts = {
              filter: args.filter,
              since: args.since,
              until: args.until,
              limit: protectedView ? 50 : args.limit,
              recent: protectedView ? true : args.recent,
            }
            let entries = store.query(target, exec.agent, queryOpts, stats)
            // 元数据：该轨文件的总条目数与最早/最新日期（用于指导查询范围）
            const allEntries = store.entriesOf(target, exec.agent)
            const dates = []
            for (const entry of allEntries) {
              const d = extractEntryDate(entry)
              if (d !== null) dates.push(d)
            }
            const total = allEntries.length
            const earliest = dates.length > 0 ? dates.reduce((a, b) => (a < b ? a : b)) : ''
            const latest = dates.length > 0 ? dates.reduce((a, b) => (a > b ? a : b)) : ''
            // key 轨的 branch 过滤：只看该分支可见的条目（无标记=全部 + 标记含该分支）
            if (target === 'key' && args.branch !== undefined && String(args.branch).trim() !== '') {
              const b = String(args.branch).trim()
              entries = entries.filter((entry) => {
                const scope = parseEntryBranches(entry)
                return scope === null || scope.includes(b)
              })
            }
            let message = `${target}：${entries.length} 条匹配`
            if (protectedView) {
              // 默认保护视图：告知库规模与时间跨度，引导模型合理加条件查询
              message += `（该轨共 ${total} 条，时间跨度 ${earliest || '?'} ~ ${latest || '?'}，默认只返回最近 50 条——查询更早记录请加 since/until（如 since=${earliest || 'YYYY-MM-DD'}）或增大 limit）`
            } else if (entries.length === 0 && (args.filter !== undefined || args.since !== undefined || args.until !== undefined)) {
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
              total,
              earliest,
              latest,
            }
            break
          }
          case 'add': {
            // ── entries 多轨批量（每轮收尾合并写 daily+project）──
            // 仅支持 daily/project 两轨（schema enum 已限；此处程序再兜底，
            // 防绕过 memory/user 的 subagent 门禁与 key 的确认队列）。
            // 逐项独立执行、独立成败，汇总到 multi 返回。
            if (Array.isArray(args.entries) && args.entries.length > 0) {
              const multi = []
              for (const item of args.entries) {
                const t = item?.target
                const c = String(item?.content ?? '').trim()
                if (t !== 'daily' && t !== 'project') {
                  multi.push({ target: String(t ?? '?'), ok: false, message: 'entries 仅支持 daily/project 轨（其他轨请用单轨参数）' })
                  continue
                }
                if (c === '') {
                  multi.push({ target: t, ok: false, message: '内容不能为空' })
                  continue
                }
                const r = await addOne(t, c, item?.feedback, exec)
                multi.push({ target: t, ok: r.ok, message: r.message })
              }
              const allOk = multi.every((m) => m.ok)
              result = {
                ok: allOk,
                message: `批量写入 ${multi.length} 轨：` + multi.map((m) => `${m.target}=${m.ok ? '成功' : '失败'}`).join(' '),
                multi,
              }
              break
            }
            // ── 单轨 add（原逻辑 + feedback 参数）──
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
            const addOneResult = await addOne(target, content, args.feedback, exec)
            if (addOneResult.ok && branchWarning !== '') addOneResult.message += branchWarning
            result = addOneResult
            break
          }
          case 'replace':
            result = outcomeOnly(store.replace(target, args.match, args.content, exec.agent))
            break
          case 'remove':
            result = outcomeOnly(store.remove(target, args.match, exec.agent))
            break
          case 'archive': {
            // 归档：主轨条目 → 对应归档文件（仅 memory/user/key 三轨）。
            // 与记忆 Tab「归档」按钮同一语义——按唯一子串片段从主轨移除
            // 整条，原文追加进 MEMORY-archive.md / USER-archive.md /
            // projects/<项目>/KEY-archive.md（key 需会话工作目录）。
            // 可逆：记忆 Tab 归档页「移回主记忆」可转正。先删后加：删除
            // 失败绝不产生重复归档条目。drift guard 由 store.remove 承担。
            if (target !== 'memory' && target !== 'user' && target !== 'key') {
              result = { ok: false, message: 'archive 只支持 memory / user / key 三个归档轨（project/daily 不归档）', target }
              break
            }
            const match = String(args.match ?? '').trim()
            if (!match) {
              result = { ok: false, message: 'match 不能为空（要归档条目的唯一片段）', target }
              break
            }
            const cwd = exec?.agent?.session?.header?.cwd
            if (target === 'key' && !cwd) {
              result = { ok: false, message: 'key 轨归档需要会话工作目录', target }
              break
            }
            const removed = store.remove(target, match, exec.agent)
            if (!removed.ok) {
              result = outcomeOnly(removed)
              break
            }
            // 把被删的整条（含时间戳）原文追加进归档文件
            const appended = archive.append(target, removed.removed ?? match, cwd)
            result = {
              ok: true,
              message: `已归档（${target}：归档文件现有 ${appended.total ?? 1} 条；原条目已从主轨移除，可随时在记忆 Tab 归档页移回）`,
              target,
            }
            break
          }
          default:
            result = { ok: false, message: `未知操作 "${action}"（支持 add / replace / remove / archive / list）`, target }
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
 *   excludeDshOnly：true = 跳过带「仅 DSH」标记（[dsh-only]）的条目——
 *   这些条目只适用于 DSH 自身（DSH 纪律/规则/架构类事实），外部执行器
 *   不必遵循 DSH 规则，注入只会让它们困惑。COI 调度注入时传 true；DSH
 *   自身快照注入不传（标记条目照常注入 DSH）。
 * @param {MemoryStore} store - 记忆 store。
 * @param {object} [opts] - { cwd, branch, tracks, excludeDshOnly }。
 * @returns {string} 拼接好的上下文文本（无内容返回空串）。
 */
export function buildMemoryContext(store, { cwd, branch: declaredBranch, tracks, excludeDshOnly } = {}) {
  // tracks 缺省=全部三轨（兼容快照等既有调用方）；COI 调度时由 AI 经
  // injectTracks 参数自主选择（scope 与注入无关，任何层级都能选轨注入）
  const want = (track) => tracks === undefined || tracks.includes(track)
  // 「仅 DSH」标记过滤：excludeDshOnly=true（外部执行器注入）时整条跳过
  // 带 [dsh-only] 的条目；DSH 自身注入（false/缺省）原样保留
  const dshOnlySafe = (entries) => (excludeDshOnly ? entries.filter((entry) => !parseEntryDshOnly(entry)) : entries)
  const parts = []
  if (want('memory')) {
    const memoryEntries = dshOnlySafe(store.entriesOf('memory'))
    if (memoryEntries.length > 0) parts.push(`【长期记忆（全局）】\n${memoryEntries.join('\n')}`)
  }
  if (want('user')) {
    const userEntries = dshOnlySafe(store.entriesOf('user'))
    if (userEntries.length > 0) parts.push(`【用户档案】\n${userEntries.join('\n')}`)
  }
  if (want('key') && cwd) {
    const keyAgent = { session: { header: { cwd } } }
    let keyEntries = dshOnlySafe(store.entriesOf('key', keyAgent))
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
  // 会话别名共享存储（aliases.json 单实例）：api 路由（/api/aliases）与
  // de_session rename 共用，避免多实例内存缓存互覆写
  const aliasStore = new AliasStore(config.memoryDir)

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
    notifyCtrl.sync() // 渠道通知随 notifyEnabled 即时安装/卸载（先于 COI——COI 依赖其 sendChannelNotify 回调）
    channelSendCtrl.sync() // 渠道直发随 channelSendEnabled 即时安装/卸载（独立开关，与 notify 互不影响）
    searchDocsCtrl.sync()
    coiCtrl.sync() // COI 模块随 coiEnabled 即时安装/卸载
    broadcastCtrl.sync() // 会话广播随 broadcastEnabled 即时安装/卸载
    sessionSearchCtrl.sync() // 会话搜索随 sessionSearchEnabled 即时安装/卸载
    sessionCtrl.sync() // 会话编排随 sessionEnabled 即时安装/卸载（曾漏掉导致开关打开工具不注册）
    promptsCtrl.sync() // 提示词模块随 promptsEnabled 即时安装/卸载
    modelsCtrl.sync() // 模型配置随 modelsEnabled 即时安装/卸载
    uiSettingsCtrl.sync() // DSH UI 设置随 uiSettingsEnabled 即时安装/卸载
    bookmarkCtrl.sync() // 会话书签随 bookmarkEnabled 即时安装/卸载
    return next
  }

  // 1. Memory snapshot injection (frozen-ish: live reads, change-detected
  //    materialization keeps the cache prefix stable).
  if (config.injectMemory) {
    ctx.effect(() => ctx.systemPrompt.context({
      name: 'memory:snapshot',
      order: config.snapshotOrder,
      text: (context) => renderSnapshot(getRuntime(), store, context.agent, counter, wsCoordStoreRef, wsCoordMetaRef, wsCoordArchivedRef !== null ? wsCoordArchivedRef() : null, ctx.sessionTitle),
    }), 'dsh-memory-evolve: memory snapshot')
  }

  // 2. The memory tool (always registered; subagent writes are gated).
  ctx.effect(() => ctx.tools.register(memoryTool(ctx, config, store, queue, getRuntime, archive)), 'dsh-memory-evolve: memory tool')

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

  // 3b. 模型配置模块（de_models 工具 + 「模型配置」Tab 数据面）：**独立
  //     子模块**，与其他模块同款独立开关 modelsEnabled（默认关）。开启时
  //     注册 de_models 工具 + 提供 /api/models 数据；关闭时工具注销、
  //     API 返回"未启用"（配置数据 models.json 保留）。开关在「设置」Tab
  //     的「配置」里切换（applyRuntimePatch sync 链即时生效）。
  let modelsDispose = null
  let modelsStore = null
  const modelsCtrl = {
    sync() {
      const enabled = runtime.modelsEnabled === true
      if (enabled && modelsDispose === null) {
        const installed = installModels(ctx, config)
        modelsDispose = installed.dispose
        modelsStore = installed.store
      } else if (!enabled && modelsDispose !== null) {
        modelsDispose()
        modelsDispose = null
        modelsStore = null
      }
    },
  }
  modelsCtrl.sync()

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
      // 共享别名存储实例（aliases.json 单实例：api 路由与 de_session rename
      // 共用同一内存缓存，避免多实例互覆写；api.js 缺省自建）
      aliases: aliasStore,
      resolveCwd: (sessionId) => ctx.get('agents')?.get?.(sessionId)?.session?.header?.cwd,
      // 模型配置模块：store（models.json 读写）+ 快照聚合（供应商/模型/
      // 思考等级/备注/enabled 一站式返回给「模型配置」Tab 与外部查询）；
      // 模块未启用（modelsEnabled=false）时 store 为 null，API 拒绝访问。
      modelsStore,
      buildModelsSnapshot: () => buildModelsSnapshotAsync(ctx, modelsStore),
    }), 'dsh-memory-evolve: web api')
  })

  // 5. Skills manager (merged from the standalone dsh-skill-browser plugin):
  //    browse/search/disable skills + custom skill dirs, served under the
  //    original /skills-manager prefix so the browser client is unchanged.
  //    The disabled list migrates once from the standalone plugin's state.
  installSkillsManager(ctx, {
    stateFile: join(config.memoryDir, 'skills-state.json'),
    // issue #4：技能 Tab 的项目技能扫描按「当前会话 cwd」定位（与 /api/memory
    // 各接口同款模式），不再固定回退到 workspace.list()[0]；客户端请求带
    // sessionId，服务端据此解析会话工作目录。
    resolveCwd: (sessionId) => ctx.get('agents')?.get?.(sessionId)?.session?.header?.cwd,
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

  // 7.4 渠道通知（de_notify）：**独立子模块**（与广播同一纪律——独立领域
  //     不挂别的模块下）。notifyEnabled 独立开关（默认关）：开启时注册
  //     de_notify 工具（手动触发）；关闭时整体卸载。sendChannelNotify ref
  //     供 COI 调度模块（coiNotifyChannels 自动通知）松耦合桥接——notify
  //     未启用时 ref 为 null，COI 侧静默跳过（不报错、不影响调度）。
  let notifyDispose = null
  let notifySendRef = null
  const notifyCtrl = {
    sync() {
      const enabled = runtime.notifyEnabled === true
      if (enabled && notifyDispose === null) {
        const installed = installNotify(ctx)
        notifyDispose = installed.dispose
        notifySendRef = installed.sendChannelNotify
      } else if (!enabled && notifyDispose !== null) {
        notifyDispose()
        notifyDispose = null
        notifySendRef = null
      }
    },
  }
  notifyCtrl.sync()

  // 7.4.1 渠道直发（de_channel_send）：**独立子模块**（与 notify 同一纪律——
  //     独立领域独立开关；2026-08-10 用户拍板二者都做：通知 + 直发，当天
  //     由 de_feishu_send 泛化为四渠道：feishu/qq/weixin/wecom）。
  //     channelSendEnabled 独立开关（默认**开**，用户拍板要的功能开箱即用）：
  //     开启时注册 de_channel_send 工具（AI 主动发送文本/图片/文件到各渠道，
  //     不带「非对话」通知标注）；关闭时整体卸载。与 notifyEnabled 互不影响。
  let channelSendDispose = null
  const channelSendCtrl = {
    sync() {
      const enabled = runtime.channelSendEnabled === true
      if (enabled && channelSendDispose === null) {
        channelSendDispose = installChannelSend(ctx).dispose
      } else if (!enabled && channelSendDispose !== null) {
        channelSendDispose()
        channelSendDispose = null
      }
    },
  }
  channelSendCtrl.sync()

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
          // 记忆上下文注入（读 memory/user/key；tracks 由 AI 经 injectTracks
          // 自主选择）。excludeDshOnly=true：跳过带 [dsh-only] 标记的条目——
          // 外部执行器不是 DSH，不必遵循 DSH 纪律/规则，注入只会让其困惑
          memoryContext: ({ cwd, branch, tracks }) => buildMemoryContext(store, { cwd, branch, tracks, excludeDshOnly: true }),
          // 渠道通知回调（coiNotifyChannels 自动通知）：notify 模块未启用时
          // ref 为 null → 可选链返回 undefined，COI 侧静默跳过
          sendChannelNotify: (opts) => notifySendRef?.(opts),
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
  //     storeRef 供会话编排模块（de_session spawn 加房间）松耦合桥接——
  //     广播未启用时返回 undefined，编排模块只提示不阻断。
  //     7.55 工作区冲突协调（ws-coord）是**广播模块的子功能组**（用户拍板
  //     2026-08-09：语义上属于"通知的一部分"，归入广播，不做独立模块）：
  //     wsCoordEnabled 子开关（默认关），**依赖广播大开关**（广播关 =
  //     wsCoord 全部不注册）；开启时安装锁存储 + de_ws_* 工具 + 事件监听
  //     （fs/observed 自动登记 / pre-execute 冲突检测 / post-execute 软模式
  //     警告 / turn-stopping 释放），存储独立子目录 <broadcastDataDir>/ws-coord/，
  //     代码独立装配单元（installWsCoord）——防 08-08「广播挂 COI 拆不开」
  //     事故重演，将来若要拆出成本低。
  let broadcastDispose = null
  let broadcastStoreRef = null
  let wsCoordDispose = null
  let wsCoordStoreRef = null
  let wsCoordMetaRef = null
  /** 已归档会话集合读取函数（installWsCoord 提供，每次现读；快照渲染时执行）。 */
  let wsCoordArchivedRef = null
  const wsCoordCtrl = {
    sync() {
      // 子开关依赖广播大开关：broadcastEnabled 关 = wsCoord 不注册
      const enabled = runtime.wsCoordEnabled === true && broadcastDispose !== null
      if (enabled && wsCoordDispose === null) {
        const installed = installWsCoord(ctx, config, { broadcastStore: broadcastStoreRef })
        wsCoordDispose = installed.dispose
        wsCoordStoreRef = installed.store
        wsCoordMetaRef = installed.sessionMeta
        wsCoordArchivedRef = installed.archivedIds
      } else if (!enabled && wsCoordDispose !== null) {
        wsCoordDispose()
        wsCoordDispose = null
        wsCoordStoreRef = null
        wsCoordMetaRef = null
        wsCoordArchivedRef = null
      }
    },
  }
  const broadcastCtrl = {
    sync() {
      const enabled = runtime.broadcastEnabled === true
      if (enabled && broadcastDispose === null) {
        const installed = installBroadcast(ctx, config)
        broadcastDispose = installed.dispose
        broadcastStoreRef = installed.store
        // 广播装好后同步 wsCoord（wsCoordEnabled 已开时随广播一起装）
        wsCoordCtrl.sync()
      } else if (!enabled && broadcastDispose !== null) {
        // 广播卸载时 wsCoord 一并卸载（先子后父，依赖顺序）
        if (wsCoordDispose !== null) {
          wsCoordDispose()
          wsCoordDispose = null
          wsCoordStoreRef = null
          wsCoordMetaRef = null
          wsCoordArchivedRef = null
        }
        broadcastDispose()
        broadcastDispose = null
        broadcastStoreRef = null
      }
    },
  }
  broadcastCtrl.sync()

  // 7.55 会话编排（de_session）：**独立子模块**（与广播同一纪律——独立
  //      领域不挂别的模块下）。sessionEnabled 独立开关（默认关）：开启时
  //      注册 de_session 工具（spawn 新建会话 / wake 唤醒已有会话 /
  //      status/list 查状态），关闭时整体卸载（并清理本模块 spawn 出的
  //      live agent，用户自己的会话不受影响）；存储独立目录
  //      sessionDataDir（<memoryDir>/session-orch）。依赖 DSH agents 服务，
  //      仅同进程会话可唤醒；spawn 加房间经 getBroadcastStore 桥接广播。
  let sessionDispose = null
  const sessionCtrl = {
    sync() {
      const enabled = runtime.sessionEnabled === true
      if (enabled && sessionDispose === null) {
        const installed = installSession(ctx, config, {
          getBroadcastStore: () => broadcastStoreRef,
          // 共享别名存储（与 /api/aliases 同一实例，rename 改别名即时一致）
          aliasStore,
        })
        sessionDispose = installed.dispose
      } else if (!enabled && sessionDispose !== null) {
        sessionDispose()
        sessionDispose = null
      }
    },
  }
  sessionCtrl.sync()

  // 7.6 会话搜索（de_session_search）：**独立子模块**（与广播同一纪律）。
  //     sessionSearchEnabled 独立开关（默认关）：开启时注册 de_session_search
  //     工具（实时只读扫描 Codex 会话，无索引/缓存/定时器），关闭时注销。
  //     存储零依赖——不建目录不落盘，root 覆盖走静态 config.sessionSearchRoots。
  let sessionSearchDispose = null
  const sessionSearchCtrl = {
    sync() {
      const enabled = runtime.sessionSearchEnabled === true
      if (enabled && sessionSearchDispose === null) {
        const installed = installSessionSearch(ctx, config)
        sessionSearchDispose = installed.dispose
      } else if (!enabled && sessionSearchDispose !== null) {
        sessionSearchDispose()
        sessionSearchDispose = null
      }
    },
  }
  sessionSearchCtrl.sync()

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

  // 9. DSH UI 设置（dsh-ui-settings）：**独立子模块**（用户拍板纪律——
  //    独立领域不挂别的模块下）。对 DSH web 界面做样式级小功能（第一版：
  //    左侧会话列表「仅显示进行中」筛选 + 折叠工作区运行徽标）。纯客户端
  //    实现（CSS + DOM 增强，注入逻辑在 src/client/session-filter.ts），
  //    宿主端提供独立开关 uiSettingsEnabled（默认关）、状态探测端点
  //    GET /api/ui-settings/state（关闭时 404，客户端探测失败即不注入任何
  //    东西）与**运行中会话快照** GET /api/ui-settings/running（折叠的
  //    工作区分组不渲染会话行、DOM 计数会漏，由宿主端精确统计——
  //    agents.roots 的 status + workspace.sessionIds 归属）。开关在
  //    「设置」Tab 的「配置」里切换（applyRuntimePatch sync 链即时安装/卸载）。
  //
  // 运行中会话快照构建：遍历所有顶层 live agent（roots，即用户可见的
  // 会话），status==='running' 的按 workspace.sessionIds 归属到工作区，
  // 归属不到的合并为未分组（title=null）。groups 保持 workspace.list()
  // 顺序，客户端按行标题前缀匹配（workspace title 全局唯一）。
  //
  // ⚠️ 踩坑（2026-08-09 用户实测 bug）：workspace.list() 返回的包装对象
  // 是 { host, id, record:{...} } 结构——title/sessionIds 经**原型 getter**
  // 暴露（可读），但**没有 workspaceId getter**（真实 id 在 .id）。
  // 之前用 owner.workspaceId 做 Map key 全是 undefined → 所有组 get(undefined)
  // 命中同一个计数 → 每个工作区都显示相同的运行数。修复：**用 workspace
  // 对象引用本身做 Map key**（不依赖任何字段名），归属与取数天然一一对应。
  const buildRunningSnapshot = () => {
    const agentsSvc = ctx.get('agents')
    const workspaceSvc = ctx.get('workspace')
    const roots = agentsSvc?.roots?.() ?? []
    const workspaces = workspaceSvc?.list?.() ?? []
    // 按 workspace 对象引用统计 running 数（sessionIds getter 精确归属）。
    const runningByWorkspace = new Map()
    let ungrouped = 0
    for (const agent of roots) {
      if (agent.status !== 'running') continue
      const sessionId = agent.session?.id
      const owner = sessionId === undefined ? undefined
        : workspaces.find((w) => (w.sessionIds ?? []).includes(sessionId))
      if (owner === undefined) ungrouped += 1
      else runningByWorkspace.set(owner, (runningByWorkspace.get(owner) ?? 0) + 1)
    }
    const groups = []
    for (const w of workspaces) {
      const running = runningByWorkspace.get(w) ?? 0
      groups.push({ title: w.title, workspaceId: w.id ?? null, running })
    }
    if (ungrouped > 0) groups.push({ title: null, workspaceId: null, running: ungrouped })
    const total = groups.reduce((sum, g) => sum + g.running, 0)
    return { total, groups }
  }
  let uiSettingsDispose = null
  const uiSettingsCtrl = {
    sync() {
      const enabled = runtime.uiSettingsEnabled === true
      if (enabled && uiSettingsDispose === null) {
        const installed = installUiSettings(ctx, { getRunningSnapshot: buildRunningSnapshot })
        // Mermaid 静态端点（/memory-evolve/mermaid/mermaid.min.js）跟随
        // DSH UI 设置模块的生命周期：模块关闭时端点一并卸载（client 的
        // 「Mermaid 图表渲染」功能开关在其「综合」列表里，模块关了功能
        // 自然没有入口）。独立文件独立函数（lib/mermaid.js），不借开关。
        const installedMermaid = installMermaid(ctx)
        uiSettingsDispose = () => {
          installed.dispose()
          installedMermaid.dispose()
        }
      } else if (!enabled && uiSettingsDispose !== null) {
        uiSettingsDispose()
        uiSettingsDispose = null
      }
    },
  }
  uiSettingsCtrl.sync()

  // 10. 会话书签（session bookmarks）：**独立子模块**（用户拍板纪律——
  //     独立领域不挂别的模块下）。每轮星标 + 书签列表 + 跳转（第一阶段
  //     不做分支）。纯 UI + 宿主 API（不注册 AI 工具）；存储独立 sidecar
  //     session-bookmarks.json。bookmarkEnabled 独立开关（默认关）：开启
  //     时安装 HTTP API，关闭时整体卸载（数据文件保留）；客户端探测
  //     /api/bookmarks/state 成功才注入 turnTail 星标与「书签」Tab。
  //     开关在「设置」Tab 的「配置」里切换（applyRuntimePatch sync 链
  //     即时安装/卸载）。
  let bookmarkDispose = null
  const bookmarkCtrl = {
    sync() {
      const enabled = runtime.bookmarkEnabled === true
      if (enabled && bookmarkDispose === null) {
        const installed = installBookmarks(ctx, config)
        bookmarkDispose = installed.dispose
      } else if (!enabled && bookmarkDispose !== null) {
        bookmarkDispose()
        bookmarkDispose = null
      }
    },
  }
  bookmarkCtrl.sync()
}
