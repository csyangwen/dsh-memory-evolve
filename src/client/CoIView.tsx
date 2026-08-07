/**
 * dsh-memory-evolve — COI 调度 tab（conversation.view 第二个 entry）。
 *
 * 统一调度 kimi/codex/grok/hermes 等 CLI 代理的 Web 面板：顶部六个子 Tab
 * （任务/会话/适配器/模板/统计/配置）。数据全部来自 host 的
 * /memory-evolve/api/coi 路由；样式在 coi-styles.css（coi- 前缀，
 * 由 index.ts 注入）。组件内部自带中英文案（默认中文），不接全局 locale。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/* ------------------------------------------------------------------ */
/* 类型（与 host API 响应形状一致）                                      */
/* ------------------------------------------------------------------ */

/** 一个 CLI 适配器定义。 */
interface Adapter {
  id: string
  name: string
  type: 'ai-cli' | 'plain-cli'
  binary: string
  args: string[]
  guide?: string
  testCmd?: string[]
  skillName?: string
  useCase?: string
  enabled?: boolean
  /** ai-cli 专属：指定会话恢复（必填）、最近会话恢复（可选）、会话 id 提取（可选）。 */
  resume?: { kind: 'flag'; flag: string; arg: string } | { kind: 'args'; args: string[] }
  continue?: { kind: 'flag'; flag: string } | { kind: 'args'; args: string[] }
  sessionIdExtract?: { source: 'stdout' | 'stderr' | 'any' | 'none'; regex: string | null }
}

/** 任务状态机。 */
type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'killed' | 'interrupted'

/** 一条调度任务记录。 */
interface CoiTask {
  id: string
  adapterId: string
  coi: string
  prompt: string
  scope: string
  cwd: string | null
  branch: string | null
  sessionId: string | null
  status: TaskStatus
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  lastOutputAt: number | null
  exitCode: number | null
  error: string | null
  summary: string | null
  refTaskId: string | null
  templateId: string | null
}

/** 一条 CLI 会话记录（可恢复的会话）。 */
interface CoiSession {
  id: string
  adapterId: string
  scope: string
  cwd: string | null
  branch: string | null
  note: string | null
  activeTaskId: string | null
  lastTaskId: string | null
  firstSeen: number
  lastSeen: number
}

/** 任务模板。 */
interface CoiTemplate {
  id: string
  name: string
  adapterId?: string
  prompt: string
  scope?: string
  note?: string
}

/** GET /stats 响应。 */
interface CoiStats {
  total: number
  byAdapter: Record<string, { count: number; totalMs: number; byStatus: Record<string, number> }>
}

/** GET /config 的运行时配置。 */
interface CoiConfig {
  coiNotifyCommand: string
  coiRetentionDays: number
  coiTaskTimeoutMs: number
}

/** 行内提示（成功/失败）。 */
interface Notice {
  kind: 'ok' | 'error'
  text: string
}

/* ------------------------------------------------------------------ */
/* 内部字典（默认中文，无需语言切换 UI）                                 */
/* ------------------------------------------------------------------ */

const DICT = {
  zh: {
    tab: 'CLI调度',
    guide: '指南',
    'guide.title': 'COI 调度使用指南',
    'guide.intro': 'COI 调度是「外部 AI 代理调度器」：把任务派给 kimi / codex / grok / hermes 等 CLI 代理——统一调度不卡主进程、实时看进度、会话分层管理可一键恢复、跨 COI 接力、任务结果留档并自动沉淀到记忆。本模块默认禁用（可在「记忆技能待办」Tab 的运行时配置中启用）。',
    'guide.use.title': '怎么发起任务',
    'guide.use.desc': '三种入口，任选其一：',
    'guide.use.ai': '对 AI 说：',
    'guide.use.aiDesc': '直接说"派给 kimi 做 XX / 让 codex 修复测试"——AI 用 de_coi_dispatch 工具发起，完成后自动接续处理结果。',
    'guide.use.slash': '终端命令：',
    'guide.use.slashDesc': '/de_coi run "任务" --coi kimi（查看全部子命令：/de_coi help）。',
    'guide.use.tab': '本 Tab：',
    'guide.use.tabDesc': '「任务」页里填适配器、任务内容、层级，可选恢复会话 / 任务模板 / 接力引用，点发起；进度与输出实时可见。',
    'guide.scope.title': '会话分层（可见范围）',
    'guide.scope.desc': '任务与会话按层级归属，决定谁能看到：',
    'guide.scope.temp': '仅发起它的那个会话可见，一次性任务（测试适配器用这个）。',
    'guide.scope.session': '仅发起它的那个会话可见，会话内可恢复。',
    'guide.scope.project': '该项目（相同工作目录）的所有会话可见，可挂 git 分支。',
    'guide.scope.global': '所有会话可见，长期保留。',
    'guide.skill.title': '适配器与技能',
    'guide.skill.desc': '每个适配器对应一个技能（AI 的使用指南，注入模型上下文）：内置四家开箱即用；自定义 CLI 可在「适配器」页添加（含普通命令 plain-cli），填技能名与内容后 AI 即学会调用它。技能可在「技能管理」Tab 禁用，可在适配器页「技能」按钮编辑。',
    'guide.tips.title': '最佳实践',
    'guide.tips.1': '分工：前端→kimi，复杂后端→codex，快速任务→grok。',
    'guide.tips.2': '接力链：codex 写代码 → kimi review（发起时选「接力引用」）。',
    'guide.tips.3': '重要会话记得备注（会话页点备注），恢复时按名字找。',
    'guide.tips.4': '任务结束可推送通知（配置页填通知命令，如 hermes send 推微信）。',
    'guide.tips.5': '记忆上下文注入：做项目开发时勾选「注入 DSH 记忆上下文」，COI 会带着你的全局规则、用户偏好与本项目关键记忆干活（按分支过滤，与 DSH 注入同规则）；也可自己先查项目/今日日志再附上文本。',
    'guide.loop': '闭环：派任务 → 实时看进度 → 拿结果留档 → 摘要沉淀记忆 → 会话可恢复再接力。',
    tasks: '任务',
    sessions: '会话',
    adapters: '适配器',
    templates: '模板',
    stats: '统计',
    config: '配置',
    loading: '加载中…',
    refresh: '刷新',
    all: '全部',
    none: '（无）',
    'launch.title': '发起任务',
    'launch.adapter': '适配器',
    'launch.prompt': '任务内容',
    'launch.promptPh': '例如：修复 tests/store.test.js 中失败的用例并验证',
    'launch.scope': '范围',
    'launch.session': '恢复会话',
    'launch.sessionNone': '（新会话）',
    'launch.sessionEmpty': '（当前适配器暂无会话）',
    'launch.template': '模板',
    'launch.templateNone': '（不用模板）',
    'launch.ref': '接力引用',
    'launch.refNone': '（不引用）',
    'launch.submit': '发起',
    'launch.injectTracks': '注入 DSH 记忆（可选）',
    'launch.injectTracksHint': '自主选择要带给 COI 的记忆轨（与层级 scope 无关，任何层级都可注入）：长期记忆=全局事实、用户档案=你的偏好、项目关键记忆=本工作区项目按分支过滤（不含 AGENTS.md）。内容会发给外部 COI 服务，注意隐私；留空=不注入',
    'launch.ctxText': '附加上下文文本（可选）',
    'launch.ctxTextPh': '自己拼接的上下文：如项目进展、相关日志要点…（超 32KB 自动写文件并把路径告诉 COI）',
    'launch.needPrompt': '任务内容不能为空',
    'launch.ok': '已发起',
    'tasks.empty': '暂无任务',
    'tasks.selectHint': '点击左侧任务查看详情与输出',
    'tasks.kill': '终止',
    'tasks.confirmKill': '确认终止该任务？',
    'tasks.killed': '已终止',
    'tasks.retry': '重试',
    'tasks.retried': '已重新发起',
    'tasks.copy': '复制',
    'tasks.copied': '已复制',
    'tasks.copyFail': '复制失败',
    'tasks.log': '输出日志',
    'tasks.logEmpty': '（暂无输出）',
    'tasks.logFull': '放大',
    'tasks.prompt': '任务内容',
    'tasks.searchPh': '搜索任务（内容/任务 id）…',
    'tasks.delete': '删除',
    'tasks.confirmDelete': '删除该任务？将移除任务记录与输出留档（已沉淀到记忆的摘要不受影响；被接力引用的任务删除后，新接力会提示任务不存在）。\n\n{id}',
    'tasks.status': '状态',
    'tasks.adapter': '适配器',
    'tasks.scope': '范围',
    'tasks.branch': '分支',
    'tasks.sessionId': '会话 ID',
    'tasks.created': '创建时间',
    'tasks.duration': '耗时',
    'tasks.lastOutput': '最后输出',
    'tasks.exitCode': '退出码',
    'tasks.error': '错误',
    'sessions.filterScope': '范围过滤',
    'sessions.searchPh': '搜索…',
    'sessions.note': '备注',
    'sessions.save': '保存',
    'sessions.delete': '删除',
    'sessions.confirmDelete': '确认删除该会话记录？',
    'sessions.empty': '暂无会话',
    'sessions.locked': '有任务占用中',
    'sessions.lastSeen': '最近活跃',
    'adapters.guide': '指南',
    'adapters.test': '测试',
    'adapters.testOk': '测试任务已发起',
    'adapters.skill': '技能',
    'adapters.skillHint': '该适配器的使用指南所在技能：它是同步注入的真实有效技能（来源=用户技能库，注入每个会话的系统提示词），AI 每次会话都能看到；禁用请到「技能管理」Tab',
    'adapters.skillBtn': '技能',
    'adapters.editSkillTitle': '编辑技能（AI 使用指南）',
    'adapters.editSkillHint': '技能 = AI 的使用指南：本技能已同步注入用户技能库（~/.agents/skills），每个会话的系统提示词里都能看到它，AI 据此正确调用本适配器。在这里编辑即更新 SKILL.md；插件重启时内置版本未变不会覆盖你的编辑；禁用入口在「技能管理」Tab。',
    'adapters.saveSkill': '保存',
    'adapters.skillSaved': '技能已保存',
    'adapters.skillName': '技能名（可选）',
    'adapters.skillNamePh': '如 my-cli-skill（该技能的 SKILL.md 将注入 AI 上下文，AI 据此学会调用此 CLI）',
    'adapters.useCase': '适用场景',
    'adapters.useCasePh': '告诉 AI 什么任务适合用这个 CLI，如：复杂后端逻辑/测试修复…',
    'adapters.useCaseEmpty': '（未填写适用场景）',
    'adapters.editUseCase': '编辑场景',
    'adapters.saveUseCase': '保存',
    'adapters.skillContent': '技能内容（SKILL.md）',
    'adapters.skillContentPh': '# 技能正文\n\n告诉 AI 如何调用这个 CLI：命令格式、参数、会话恢复方式、注意事项…（frontmatter 的 name/description 会自动补全）',
    'adapters.skillContentHint': '留空 = 只关联技能名（技能文件需另外创建，可添加后到「技能」按钮里编辑）；填写 = 技能不存在时自动创建',
    'cancel': '取消',
    'saving': '保存中…',
    'adapters.addTitle': '添加自定义适配器',
    'adapters.name': '名称',
    'adapters.type': '类型',
    'adapters.binary': '可执行文件',
    'adapters.args': '参数',
    'adapters.argsPh': '逗号分隔，如：-p, {task}',
    'adapters.add': '添加',
    'adapters.delete': '删除',
    'adapters.enable': '启用',
    'adapters.disable': '禁用',
    'adapters.disabledHint': '已禁用：AI 调度此适配器会被拒绝并提示换用其他可用项',
    'adapters.confirmDelete': '确认删除该自定义适配器？',
    'adapters.builtin': '内置',
    'adapters.custom': '自定义',
    'adapters.resumeSection': '会话恢复配置（ai-cli 必填）',
    'adapters.resumeSectionHint': 'ai-cli 类型必须有指定会话恢复能力；没有恢复能力的 CLI 请选 plain-cli 类型',
    'adapters.resumeKind': '恢复方式',
    'adapters.resumeKindFlag': 'flag 模式（恢复参数插在基础参数前）',
    'adapters.resumeKindArgs': 'args 模式（完整恢复命令）',
    'adapters.resumeFlag': '恢复 flag',
    'adapters.resumeFlagPh': '如 -S / -r / --resume',
    'adapters.resumeArg': '会话参数',
    'adapters.resumeArgPh': '含 {sessionId} 占位符，如 {sessionId}',
    'adapters.resumeArgs': '恢复命令参数',
    'adapters.resumeArgsPh': '逗号分隔，含 {sessionId}（及可选 {task}），如 exec, resume, {sessionId}, {task}',
    'adapters.continueFlag': '最近会话恢复 flag（可选）',
    'adapters.continueFlagPh': '如 -c；留空 = 不支持"最近会话"恢复',
    'adapters.extractSection': '会话 ID 自动提取（可选）',
    'adapters.extractSource': '输出流',
    'adapters.extractRegex': '提取正则',
    'adapters.extractRegexPh': '捕获组 1 为会话 ID，如 To resume this session: kimi -r (session_\\S+)',
    'adapters.resumeMissing': 'ai-cli 类型必须填写会话恢复配置（resume）',
    'templates.addTitle': '添加模板',
    'templates.name': '名称',
    'templates.prompt': '任务内容',
    'templates.adapterOpt': '适配器（可选）',
    'templates.idOpt': 'ID（可选，不填自动）',
    'templates.add': '添加',
    'templates.delete': '删除',
    'templates.confirmDelete': '确认删除该模板？',
    'templates.builtinKeep': '内置模板不可删除',
    'templates.empty': '暂无模板',
    'stats.total': '总任务数',
    'stats.count': '任务数',
    'stats.hours': '累计时长',
    'stats.byStatus': '状态分布',
    'stats.empty': '暂无统计数据',
    'config.notify': '通知命令',
    'config.notifyHint': '任务结束时执行；占位符：{taskId} {coi} {status} {summary}',
    'config.retention': '任务保留天数',
    'config.timeout': '任务超时',
    'config.timeoutHours': '小时',
    'config.timeoutMinutes': '分钟',
    'config.timeoutHint': '超时仅作兜底防线（AI 任务可能数小时无输出属正常）；留空 = 不修改',
    'config.timeoutBad': '超时格式不正确',
    'config.save': '保存',
    'config.saved': '已保存',
    'scope.temporary': '临时',
    'scope.session': '会话',
    'scope.project': '项目',
    'scope.global': '全局',
  },
  en: {
    tab: 'CLI Dispatch',
    guide: 'Guide',
    'guide.title': 'CLI Dispatch Guide',
    'guide.intro': 'COI dispatch is an external AI agent scheduler: hand tasks to CLI agents (kimi/codex/grok/hermes…) — unified non-blocking scheduling, live progress, tiered session management with one-click resume, cross-COI relay, results archived and sunk into memory. Disabled by default (enable it in the runtime config of the Memory tab).',
    'guide.use.title': 'How to dispatch',
    'guide.use.desc': 'Three entrances:',
    'guide.use.ai': 'Tell the AI: ',
    'guide.use.aiDesc': 'say "have kimi do X / let codex fix the tests" — the AI dispatches via de_coi_dispatch and picks up the result.',
    'guide.use.slash': 'Terminal: ',
    'guide.use.slashDesc': '/de_coi run "task" --coi kimi (/de_coi help for all subcommands).',
    'guide.use.tab': 'This tab: ',
    'guide.use.tabDesc': 'pick adapter, prompt, scope in the Tasks page; optionally resume a session / use a template / relay another task; progress and output are live.',
    'guide.scope.title': 'Session tiers (visibility)',
    'guide.scope.desc': 'Tasks and sessions belong to a tier that decides who can see them:',
    'guide.scope.temp': 'visible only in the session that launched it; one-shot (use for adapter tests).',
    'guide.scope.session': 'visible only in the launching session; resumable within it.',
    'guide.scope.project': 'visible to every session of that project (same cwd); can be tagged with a git branch.',
    'guide.scope.global': 'visible everywhere; long-lived.',
    'guide.skill.title': 'Adapters & skills',
    'guide.skill.desc': 'Every adapter maps to a skill (the AI usage guide, injected into the model context): four built-ins work out of the box; custom CLIs can be added in the Adapters page (plain-cli included) — fill the skill name and content and the AI learns how to drive it. Skills can be disabled in the Skill Manager tab and edited via the Skill button.',
    'guide.tips.title': 'Best practices',
    'guide.tips.1': 'Division of labor: frontend→kimi, complex backend→codex, quick jobs→grok.',
    'guide.tips.2': 'Relay chains: codex writes → kimi reviews (pick Relay when dispatching).',
    'guide.tips.3': 'Note important sessions (Sessions page) so you can resume them by name.',
    'guide.tips.4': 'Get notified on completion (set a notify command in Config, e.g. hermes send to WeChat).',
    'guide.tips.5': 'Memory context injection: for project development tick “Inject DSH memory context” — the COI works with your global rules, profile and this project\'s key facts (branch-filtered, same rules as DSH injection); you can also look up project/daily logs yourself and attach a text.',
    'guide.loop': 'The loop: dispatch → watch live progress → results archived → summaries sunk into memory → sessions resumable for the next relay.',
    tasks: 'Tasks',
    sessions: 'Sessions',
    adapters: 'Adapters',
    templates: 'Templates',
    stats: 'Stats',
    config: 'Config',
    loading: 'Loading…',
    refresh: 'Refresh',
    all: 'All',
    none: '(none)',
    'launch.title': 'Launch task',
    'launch.adapter': 'Adapter',
    'launch.prompt': 'Prompt',
    'launch.promptPh': 'e.g. fix the failing cases in tests/store.test.js and verify',
    'launch.scope': 'Scope',
    'launch.session': 'Resume session',
    'launch.sessionNone': '(new session)',
    'launch.sessionEmpty': '(no sessions for this adapter)',
    'launch.template': 'Template',
    'launch.templateNone': '(no template)',
    'launch.ref': 'Relay ref',
    'launch.refNone': '(none)',
    'launch.submit': 'Launch',
    'launch.injectTracks': 'Inject DSH memory (optional)',
    'launch.injectTracksHint': 'Pick which memory tracks to hand to the COI (independent of scope — any tier can inject): long-term memory=global facts, user profile=your preferences, project key=this workspace\'s key facts (branch-filtered; no AGENTS.md). Content is sent to external COI services — mind privacy; empty = no injection',
    'launch.ctxText': 'Extra context text (optional)',
    'launch.ctxTextPh': 'Your own context: project progress, log highlights… (over 32KB it is written to a file and the path is given to the COI)',
    'launch.needPrompt': 'Prompt must not be empty',
    'launch.ok': 'Launched',
    'tasks.empty': 'No tasks yet',
    'tasks.selectHint': 'Click a task on the left to view details and output',
    'tasks.kill': 'Kill',
    'tasks.confirmKill': 'Kill this task?',
    'tasks.killed': 'Killed',
    'tasks.retry': 'Retry',
    'tasks.retried': 'Re-launched',
    'tasks.copy': 'Copy',
    'tasks.copied': 'Copied',
    'tasks.copyFail': 'Copy failed',
    'tasks.log': 'Output log',
    'tasks.logEmpty': '(no output yet)',
    'tasks.logFull': 'Expand',
    'tasks.prompt': 'Task prompt',
    'tasks.searchPh': 'Search tasks (content / task id)…',
    'tasks.delete': 'Delete',
    'tasks.confirmDelete': 'Delete this task? Its record and output archive will be removed (memory summaries are unaffected; relay references to it will fail afterwards).\n\n{id}',
    'tasks.status': 'Status',
    'tasks.adapter': 'Adapter',
    'tasks.scope': 'Scope',
    'tasks.branch': 'Branch',
    'tasks.sessionId': 'Session ID',
    'tasks.created': 'Created',
    'tasks.duration': 'Duration',
    'tasks.lastOutput': 'Last output',
    'tasks.exitCode': 'Exit code',
    'tasks.error': 'Error',
    'sessions.filterScope': 'Scope filter',
    'sessions.searchPh': 'Search…',
    'sessions.note': 'Note',
    'sessions.save': 'Save',
    'sessions.delete': 'Delete',
    'sessions.confirmDelete': 'Delete this session record?',
    'sessions.empty': 'No sessions',
    'sessions.locked': 'Occupied by a task',
    'sessions.lastSeen': 'Last seen',
    'adapters.guide': 'Guide',
    'adapters.test': 'Test',
    'adapters.testOk': 'Test task launched',
    'adapters.skill': 'Skill',
    'adapters.skillHint': 'The skill holding this adapter\'s usage guide: a real injected skill (source = user skill library, injected into every session\'s system prompt); disable it via the Skill Manager tab',
    'adapters.skillBtn': 'Skill',
    'adapters.editSkillTitle': 'Edit skill (AI usage guide)',
    'adapters.editSkillHint': 'The skill IS the AI usage guide: it is synced into the user skill library (~/.agents/skills) and injected into every session\'s system prompt, so the AI knows how to drive this adapter. Editing here updates that SKILL.md; plugin restarts will not overwrite your edits while the built-in version is unchanged; disable it via the Skill Manager tab.',
    'adapters.saveSkill': 'Save',
    'adapters.skillSaved': 'Skill saved',
    'adapters.skillName': 'Skill name (optional)',
    'adapters.skillNamePh': 'e.g. my-cli-skill (that SKILL.md will be injected into the AI context so the AI learns how to use this CLI)',
    'adapters.useCase': 'Use case',
    'adapters.useCasePh': 'Tell the AI which tasks suit this CLI, e.g. complex backend logic / test fixes…',
    'adapters.useCaseEmpty': '(no use case set)',
    'adapters.editUseCase': 'Edit',
    'adapters.saveUseCase': 'Save',
    'adapters.skillContent': 'Skill content (SKILL.md)',
    'adapters.skillContentPh': '# Skill body\n\nTell the AI how to drive this CLI: command format, args, session resume, caveats… (frontmatter name/description are auto-completed)',
    'adapters.skillContentHint': 'Leave empty = link the skill name only (create the file later via the Skill button); filled = the skill is auto-created when missing',
    'cancel': 'Cancel',
    'saving': 'Saving…',
    'adapters.addTitle': 'Add custom adapter',
    'adapters.name': 'Name',
    'adapters.type': 'Type',
    'adapters.binary': 'Binary',
    'adapters.args': 'Args',
    'adapters.argsPh': 'comma separated, e.g.: -p, {task}',
    'adapters.add': 'Add',
    'adapters.delete': 'Delete',
    'adapters.enable': 'Enable',
    'adapters.disable': 'Disable',
    'adapters.disabledHint': 'Disabled: dispatching to this adapter is rejected with a hint to use another one',
    'adapters.confirmDelete': 'Delete this custom adapter?',
    'adapters.builtin': 'builtin',
    'adapters.custom': 'custom',
    'adapters.resumeSection': 'Session resume (required for ai-cli)',
    'adapters.resumeSectionHint': 'ai-cli must support resuming a named session; CLIs without resume support should use plain-cli',
    'adapters.resumeKind': 'Resume mode',
    'adapters.resumeKindFlag': 'flag mode (resume flag + arg prepended to base args)',
    'adapters.resumeKindArgs': 'args mode (full resume command)',
    'adapters.resumeFlag': 'Resume flag',
    'adapters.resumeFlagPh': 'e.g. -S / -r / --resume',
    'adapters.resumeArg': 'Session arg',
    'adapters.resumeArgPh': 'with {sessionId} placeholder, e.g. {sessionId}',
    'adapters.resumeArgs': 'Resume command args',
    'adapters.resumeArgsPh': 'comma separated, with {sessionId} (and optional {task}), e.g. exec, resume, {sessionId}, {task}',
    'adapters.continueFlag': 'Continue-last flag (optional)',
    'adapters.continueFlagPh': 'e.g. -c; leave empty = no “continue last session” support',
    'adapters.extractSection': 'Auto session-ID extraction (optional)',
    'adapters.extractSource': 'Output stream',
    'adapters.extractRegex': 'Extract regex',
    'adapters.extractRegexPh': 'capture group 1 = session ID, e.g. To resume this session: kimi -r (session_\\S+)',
    'adapters.resumeMissing': 'ai-cli requires a session resume config',
    'templates.addTitle': 'Add template',
    'templates.name': 'Name',
    'templates.prompt': 'Prompt',
    'templates.adapterOpt': 'Adapter (optional)',
    'templates.idOpt': 'ID (optional, auto if empty)',
    'templates.add': 'Add',
    'templates.delete': 'Delete',
    'templates.confirmDelete': 'Delete this template?',
    'templates.builtinKeep': 'Builtin templates cannot be deleted',
    'templates.empty': 'No templates',
    'stats.total': 'Total tasks',
    'stats.count': 'Tasks',
    'stats.hours': 'Total time',
    'stats.byStatus': 'By status',
    'stats.empty': 'No stats yet',
    'config.notify': 'Notify command',
    'config.notifyHint': 'Runs when a task finishes; placeholders: {taskId} {coi} {status} {summary}',
    'config.retention': 'Retention days',
    'config.timeout': 'Task timeout',
    'config.timeoutHours': 'hours',
    'config.timeoutMinutes': 'minutes',
    'config.timeoutHint': 'Timeout is a safety net only (AI agents may stay quiet for hours); leave empty to keep current',
    'config.timeoutBad': 'Bad timeout format',
    'config.save': 'Save',
    'config.saved': 'Saved',
    'scope.temporary': 'temporary',
    'scope.session': 'session',
    'scope.project': 'project',
    'scope.global': 'global',
  },
} as const

type DictKey = keyof (typeof DICT)['zh']

/** 当前语言（默认中文；无切换 UI）。 */
const LANG: keyof typeof DICT = 'zh'

/** 字典查询：当前语言 → en 兜底 → key 本身。 */
function t(key: DictKey): string {
  return DICT[LANG][key] ?? DICT.en[key] ?? key
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const API = '/memory-evolve/api/coi'

/** 统一 fetch：非 2xx 抛出带 host message 的 Error，绝不抛未捕获异常到渲染层。 */
async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
  if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`)
  return body as T
}

/** POST JSON。 */
function postJson<T>(path: string, body?: unknown): Promise<T> {
  return fetchJson<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
}

/** DELETE。 */
function deleteJson<T>(path: string): Promise<T> {
  return fetchJson<T>(path, { method: 'DELETE' })
}

/** unknown → 可读错误文本；空信息兜底，绝不渲染空红框。 */
function errText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text !== undefined && text.trim() !== '' ? text : '操作失败（无错误详情）'
}

/** 后端 message 兜底：空串/缺失时用 fallback。 */
function msgOr(text: string | undefined, fallback: string): string {
  return text !== undefined && text.trim() !== '' ? text : fallback
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 时间戳 → 'YYYY-MM-DD HH:mm:ss'。 */
function fmtTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 时间戳 → 相对时间（'刚刚' / '5 秒前' / '3 分钟前' / '2 小时前'）。 */
function fmtAgo(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return '—'
  const delta = Math.max(0, Date.now() - ts)
  if (delta < 5000) return LANG === 'zh' ? '刚刚' : 'just now'
  const s = Math.floor(delta / 1000)
  if (s < 60) return LANG === 'zh' ? `${s} 秒前` : `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return LANG === 'zh' ? `${m} 分钟前` : `${m}m ago`
  const h = Math.floor(m / 60)
  return LANG === 'zh' ? `${h} 小时前` : `${h}h ago`
}

/** 毫秒 → '500ms' / '42s' / '3m 5s' / '1h 2m'。 */
function fmtDur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** 单行截断（默认 40 字）。 */
function trunc(text: string, n = 40): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…` : one
}

/** 状态 → 图标/文案/样式类。 */
const STATUS_META: Record<string, { icon: string; label: string; cls: string }> = {
  queued: { icon: '⏳', label: LANG === 'zh' ? '排队中' : 'Queued', cls: 'coi-status-queued' },
  running: { icon: '⏳', label: LANG === 'zh' ? '运行中' : 'Running', cls: 'coi-status-running' },
  completed: { icon: '✅', label: LANG === 'zh' ? '已完成' : 'Completed', cls: 'coi-status-completed' },
  failed: { icon: '❌', label: LANG === 'zh' ? '失败' : 'Failed', cls: 'coi-status-failed' },
  killed: { icon: '🛑', label: LANG === 'zh' ? '已终止' : 'Killed', cls: 'coi-status-killed' },
  interrupted: { icon: '⚠️', label: LANG === 'zh' ? '中断' : 'Interrupted', cls: 'coi-status-interrupted' },
}

function statusMeta(status: string): { icon: string; label: string; cls: string } {
  return STATUS_META[status] ?? { icon: '❔', label: status, cls: '' }
}

const SCOPES = ['temporary', 'session', 'project', 'global'] as const

/** 内置适配器 id（host 不返回内置标记，前端据此隐藏删除按钮；与 lib/coi/adapters.js 对齐）。 */
const BUILTIN_ADAPTER_IDS = new Set(['kimi', 'codex', 'grok', 'hermes'])

/** 内置模板 id（与 lib/coi/templates.js 对齐）。 */
const BUILTIN_TEMPLATE_IDS = new Set(['review-code', 'fix-tests', 'summarize-logs', 'architecture-analysis'])

/** 任务列表轮询间隔。 */
const TASKS_POLL_MS = 3000
/** 日志轮询间隔（仅运行中）。 */
const LOG_POLL_MS = 2000
/** 列表只显示最近 50 条。 */
const TASK_LIMIT = 50

/* ------------------------------------------------------------------ */
/* 通用小件                                                             */
/* ------------------------------------------------------------------ */

function NoticeLine(props: { notice: Notice | null }): JSX.Element | null {
  if (props.notice === null) return null
  return <div className={`coi-notice coi-notice-${props.notice.kind}`}>{props.notice.text}</div>
}

function ErrorLine(props: { error: string | null }): JSX.Element | null {
  if (props.error === null) return null
  return <div className="coi-error">{props.error}</div>
}

/* ------------------------------------------------------------------ */
/* 主组件：子 Tab 切换                                                   */
/* ------------------------------------------------------------------ */

type SubTab = 'guide' | 'tasks' | 'sessions' | 'adapters' | 'templates' | 'stats' | 'config'

export interface CoIViewProps {
  /** slot 注入的全局翻译（本组件按 SPEC 使用内部字典，忽略之）。 */
  t?: Translate
}

export function CoIView(props: ConvViewProps & CoIViewProps): JSX.Element {
  // 当前 DSH 会话 id：层级可见性依据（临时/会话层级仅本会话可见）
  const sessionId = (props as { sessionId?: string }).sessionId
  const [sub, setSub] = useState<SubTab>('tasks')
  const tabs: { id: SubTab; key: DictKey }[] = [
    { id: 'guide', key: 'guide' },
    { id: 'tasks', key: 'tasks' },
    { id: 'sessions', key: 'sessions' },
    { id: 'adapters', key: 'adapters' },
    { id: 'templates', key: 'templates' },
    { id: 'stats', key: 'stats' },
    { id: 'config', key: 'config' },
  ]
  return (
    <div className="coi-root">
      <div className="coi-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={sub === tab.id}
            className={`coi-tab${sub === tab.id ? ' coi-tab-active' : ''}`}
            onClick={() => setSub(tab.id)}
          >
            {t(tab.key)}
          </button>
        ))}
      </div>
      <div className="coi-body">
        {sub === 'guide' && <GuidePane />}
        {sub === 'tasks' && <TasksPane dsSessionId={sessionId} />}
        {sub === 'sessions' && <SessionsPane dsSessionId={sessionId} />}
        {sub === 'adapters' && <AdaptersPane />}
        {sub === 'templates' && <TemplatesPane />}
        {sub === 'stats' && <StatsPane />}
        {sub === 'config' && <ConfigPane />}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 使用指南                                                             */
/* ------------------------------------------------------------------ */

function GuidePane(): JSX.Element {
  return (
    <div className="coi-pane">
      <div className="coi-card">
        <div className="coi-card-title">{t('guide.title')}</div>
        <p className="coi-muted">{t('guide.intro')}</p>
      </div>
      <div className="coi-card">
        <div className="coi-card-title">🚀 {t('guide.use.title')}</div>
        <p className="coi-muted">{t('guide.use.desc')}</p>
        <ul className="coi-guide-list">
          <li><strong>{t('guide.use.ai')}</strong>{t('guide.use.aiDesc')}</li>
          <li><strong>{t('guide.use.slash')}</strong>{t('guide.use.slashDesc')}</li>
          <li><strong>{t('guide.use.tab')}</strong>{t('guide.use.tabDesc')}</li>
        </ul>
      </div>
      <div className="coi-card">
        <div className="coi-card-title">🗂️ {t('guide.scope.title')}</div>
        <p className="coi-muted">{t('guide.scope.desc')}</p>
        <ul className="coi-guide-list">
          <li><strong>{t('scope.temporary')}</strong>：{t('guide.scope.temp')}</li>
          <li><strong>{t('scope.session')}</strong>：{t('guide.scope.session')}</li>
          <li><strong>{t('scope.project')}</strong>：{t('guide.scope.project')}</li>
          <li><strong>{t('scope.global')}</strong>：{t('guide.scope.global')}</li>
        </ul>
      </div>
      <div className="coi-card">
        <div className="coi-card-title">🧭 {t('guide.skill.title')}</div>
        <p className="coi-muted">{t('guide.skill.desc')}</p>
      </div>
      <div className="coi-card">
        <div className="coi-card-title">💡 {t('guide.tips.title')}</div>
        <ul className="coi-guide-list">
          <li>{t('guide.tips.1')}</li>
          <li>{t('guide.tips.2')}</li>
          <li>{t('guide.tips.3')}</li>
          <li>{t('guide.tips.4')}</li>
        </ul>
      </div>
      <p className="coi-muted coi-pad">{t('guide.loop')}</p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 任务视图：发起表单 + 列表 + 详情/日志                                  */
/* ------------------------------------------------------------------ */

function TasksPane({ dsSessionId }: { dsSessionId?: string }): JSX.Element {
  /** 可见性 query：带 DSH 会话 id 时后端按层级过滤（临时/会话=本会话，项目=本会话 cwd）。 */
  const visQs = (dsSessionId ?? '') !== '' ? `&sessionId=${encodeURIComponent(String(dsSessionId))}` : ''
  const [adapters, setAdapters] = useState<Adapter[]>([])
  const [templates, setTemplates] = useState<CoiTemplate[]>([])
  const [sessions, setSessions] = useState<CoiSession[]>([])
  const [refTasks, setRefTasks] = useState<CoiTask[]>([])
  const [tasks, setTasks] = useState<CoiTask[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  // 发起表单
  const [adapterId, setAdapterId] = useState('kimi')
  const [prompt, setPrompt] = useState('')
  // 默认层级 session（仅发起会话可见，私有默认；用户拍板 2026-08-07）
  const [scope, setScope] = useState<string>('session')
  const [sessionId, setSessionId] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [refTaskId, setRefTaskId] = useState('')
  const [launching, setLaunching] = useState(false)
  // 注入轨（memory=长期记忆 / user=用户档案 / key=项目关键记忆；与 scope 无关）
  const [injectTracks, setInjectTracks] = useState<string[]>([])
  const [ctxText, setCtxText] = useState('')

  // 详情
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<CoiTask | null>(null)
  const [log, setLog] = useState('')
  const [logError, setLogError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [fullLog, setFullLog] = useState(false)
  const [fullPrompt, setFullPrompt] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const logRef = useRef<HTMLPreElement | null>(null)
  const fullLogRef = useRef<HTMLPreElement | null>(null)
  const selectedRef = useRef<string | null>(null)

  useEffect(() => {
    selectedRef.current = selectedId
  }, [selectedId])

  const loadTasks = useCallback(async (): Promise<void> => {
    try {
      const q = searchQ.trim()
      const data = await fetchJson<{ tasks: CoiTask[] }>(`/tasks?limit=${TASK_LIMIT}${visQs}${q !== '' ? `&q=${encodeURIComponent(q)}` : ''}`)
      setTasks(data.tasks)
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [searchQ])

  const loadDetail = useCallback(async (id: string): Promise<void> => {
    try {
      const data = await fetchJson<{ ok: boolean; task: CoiTask }>(`/tasks/${encodeURIComponent(id)}`)
      setDetail(data.task)
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    }
  }, [])

  const removeTask = async (id: string): Promise<void> => {
    if (!window.confirm(t('tasks.confirmDelete'))) return
    try {
      const res = await deleteJson<{ ok: boolean; message?: string }>(`/tasks/${encodeURIComponent(id)}`)
      if (res.ok !== true) {
        setNotice({ kind: 'error', text: msgOr(res.message, '删除失败') })
        return
      }
      setSelectedId(null)
      setDetail(null)
      void loadTasks()
      setNotice({ kind: 'ok', text: res.message ?? '已删除' })
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    }
  }

  const loadLog = useCallback(async (id: string): Promise<void> => {
    try {
      const data = await fetchJson<{ ok: boolean; text: string }>(`/tasks/${encodeURIComponent(id)}/log?tail=8000`)
      setLog(data.text)
      setLogError(null)
    } catch (err) {
      setLogError(errText(err))
    }
  }, [])

  // 列表 3s 轮询（TasksPane 卸载即停止）；顺带刷新已打开详情的元信息。
  useEffect(() => {
    void loadTasks()
    const timer = setInterval(() => {
      void loadTasks()
      const id = selectedRef.current
      if (id !== null) void loadDetail(id)
    }, TASKS_POLL_MS)
    return () => clearInterval(timer)
  }, [loadTasks, loadDetail])

  // 下拉数据源（适配器/模板/会话/可引用的已完成任务）。
  useEffect(() => {
    fetchJson<{ adapters: Adapter[] }>('/adapters')
      .then((data) => {
        setAdapters(data.adapters)
        setAdapterId((prev) => (data.adapters.some((a) => a.id === prev) ? prev : data.adapters[0]?.id ?? prev))
      })
      .catch(() => { /* 下拉留空，发起时由 host 报错 */ })
    fetchJson<{ templates: CoiTemplate[] }>('/templates')
      .then((data) => setTemplates(data.templates))
      .catch(() => { /* 同上 */ })
    fetchJson<{ sessions: CoiSession[] }>(`/sessions?${visQs.slice(1)}`)
      .then((data) => setSessions(data.sessions))
      .catch(() => { /* 同上 */ })
    fetchJson<{ tasks: CoiTask[] }>(`/tasks?status=completed&limit=50${visQs}`)
      .then((data) => setRefTasks(data.tasks))
      .catch(() => { /* 同上 */ })
  }, [])

  // 选中任务 → 拉详情与首屏日志。
  useEffect(() => {
    if (selectedId === null) {
      setDetail(null)
      return
    }
    setDetail(null)
    setLog('')
    setLogError(null)
    void loadDetail(selectedId)
    void loadLog(selectedId)
  }, [selectedId, loadDetail, loadLog])

  const running = detail !== null && (detail.status === 'running' || detail.status === 'queued')

  // 日志 2s 轮询（仅运行中）；顺带刷新详情（最后输出时间/耗时时时更新）。
  useEffect(() => {
    if (selectedId === null || !running) return
    const timer = setInterval(() => {
      void loadLog(selectedId)
      void loadDetail(selectedId)
    }, LOG_POLL_MS)
    return () => clearInterval(timer)
  }, [selectedId, running, loadLog, loadDetail])

  // 日志自动滚到底部（详情 + 全屏弹窗）。
  useEffect(() => {
    const el = logRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
    const full = fullLogRef.current
    if (full !== null) full.scrollTop = full.scrollHeight
  }, [log])

  const applyTemplate = (id: string): void => {
    setTemplateId(id)
    const tpl = templates.find((item) => item.id === id)
    if (tpl !== undefined) {
      setPrompt(tpl.prompt)
      if (tpl.adapterId !== undefined) setAdapterId(tpl.adapterId)
      if (tpl.scope !== undefined) setScope(tpl.scope)
    }
  }

  const launch = async (): Promise<void> => {
    if (prompt.trim() === '') {
      setNotice({ kind: 'error', text: t('launch.needPrompt') })
      return
    }
    setLaunching(true)
    try {
      const body: Record<string, unknown> = { adapterId, prompt, scope }
      if (scope !== 'temporary' && sessionId !== '') body.sessionId = sessionId
      if (templateId !== '') body.templateId = templateId
      if (refTaskId !== '') body.refTaskId = refTaskId
      const res = await postJson<{ ok: boolean; taskId?: string; message?: string }>('/tasks', {
        ...body,
        dsSessionId: dsSessionId ?? '',
        injectTracks: injectTracks.length > 0 ? injectTracks : undefined,
        contextText: ctxText.trim() === '' ? undefined : ctxText,
      })
      setNotice({ kind: 'ok', text: `${t('launch.ok')}${res.taskId !== undefined ? `：${res.taskId}` : ''}` })
      setPrompt('')
      setTemplateId('')
      setRefTaskId('')
      void loadTasks()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    } finally {
      setLaunching(false)
    }
  }

  const kill = async (): Promise<void> => {
    if (detail === null) return
    if (!window.confirm(t('tasks.confirmKill'))) return
    try {
      await postJson(`/tasks/${encodeURIComponent(detail.id)}/cancel`, { force: true })
      setNotice({ kind: 'ok', text: t('tasks.killed') })
      void loadTasks()
      void loadDetail(detail.id)
    } catch (err) {
      // host 要求二次确认时：把确认提示原样透出，再带 force 重发。
      const msg = errText(err)
      if (window.confirm(msg)) {
        try {
          await postJson(`/tasks/${encodeURIComponent(detail.id)}/cancel`, { force: true })
          setNotice({ kind: 'ok', text: t('tasks.killed') })
          void loadTasks()
          void loadDetail(detail.id)
        } catch (err2) {
          setNotice({ kind: 'error', text: errText(err2) })
        }
      }
    }
  }

  const retry = async (): Promise<void> => {
    if (detail === null) return
    try {
      const res = await postJson<{ ok: boolean; taskId?: string; message?: string }>(`/tasks/${encodeURIComponent(detail.id)}/retry`)
      setNotice({ kind: 'ok', text: res.message ?? `${t('tasks.retried')}${res.taskId !== undefined ? `：${res.taskId}` : ''}` })
      void loadTasks()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    }
  }

  const copySession = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setNotice({ kind: 'error', text: t('tasks.copyFail') })
    }
  }

  const detailDur = (task: CoiTask): number | null => {
    if (task.startedAt === null) return null
    if (task.finishedAt !== null) return task.finishedAt - task.startedAt
    if (task.status === 'running') return Date.now() - task.startedAt
    return null
  }

  return (
    <div className="coi-pane coi-tasks">
      <div className="coi-card">
        <div className="coi-card-title">{t('launch.title')}</div>
        <div className="coi-form-grid">
          <label className="coi-field">
            <span className="coi-label">{t('launch.adapter')}</span>
            <select
              className="coi-select"
              value={adapterId}
              onChange={(e) => {
                const next = e.target.value
                setAdapterId(next)
                // 会话绑定适配器：切换适配器后，已选会话若不属于新适配器则清空，
                // 避免恢复会话时拿其他适配器的 session id 去调度（必然失败）
                if (sessionId !== '' && !sessions.some((s) => s.id === sessionId && s.adapterId === next)) {
                  setSessionId('')
                }
              }}
            >
              {adapters.map((a) => (
                <option key={a.id} value={a.id}>{a.name}（{a.id}）</option>
              ))}
              {adapters.length === 0 && <option value={adapterId}>{adapterId}</option>}
            </select>
          </label>
          <label className="coi-field">
            <span className="coi-label">{t('launch.scope')}</span>
            <select className="coi-select" value={scope} onChange={(e) => setScope(e.target.value)}>
              {SCOPES.map((s) => (
                <option key={s} value={s}>{t(`scope.${s}`)}</option>
              ))}
            </select>
          </label>
          {scope !== 'temporary' && (
            <label className="coi-field">
              <span className="coi-label">{t('launch.session')}</span>
              {/* 会话属于某个适配器：只列当前适配器的会话（跨适配器恢复必然失败） */}
              <select className="coi-select" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                <option value="">{t('launch.sessionNone')}</option>
                {sessions.filter((s) => s.adapterId === adapterId).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id}（{s.adapterId}{s.note !== null && s.note !== '' ? ` · ${trunc(s.note, 12)}` : ''}）
                  </option>
                ))}
                {sessions.filter((s) => s.adapterId === adapterId).length === 0 && (
                  <option value="" disabled>{t('launch.sessionEmpty')}</option>
                )}
              </select>
            </label>
          )}
          <label className="coi-field">
            <span className="coi-label">{t('launch.template')}</span>
            <select className="coi-select" value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
              <option value="">{t('launch.templateNone')}</option>
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>{tpl.name}（{tpl.id}）</option>
              ))}
            </select>
          </label>
          <label className="coi-field">
            <span className="coi-label">{t('launch.ref')}</span>
            <select className="coi-select" value={refTaskId} onChange={(e) => setRefTaskId(e.target.value)}>
              <option value="">{t('launch.refNone')}</option>
              {refTasks.map((task) => (
                <option key={task.id} value={task.id}>{task.id} · {trunc(task.prompt, 24)}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="coi-field">
          <span className="coi-label">{t('launch.prompt')}</span>
          <textarea
            className="coi-textarea coi-textarea-lg"
            rows={6}
            placeholder={t('launch.promptPh')}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <label className="coi-field coi-field-wide">
          <span className="coi-field-check">
            <span className="coi-label">{t('launch.injectTracks')}</span>
          </span>
          <span className="coi-muted coi-small">{t('launch.injectTracksHint')}</span>
        </label>
        <label className="coi-field coi-field-wide coi-inject-track-line">
          {(['memory', 'user', 'key'] as const).map((track) => (
            <span key={track} className="coi-field-check">
              <input
                type="checkbox"
                checked={injectTracks.includes(track)}
                onChange={(e) => setInjectTracks(
                  e.target.checked
                    ? [...injectTracks, track]
                    : injectTracks.filter((item) => item !== track),
                )}
              />
              <span className="coi-label">{track}</span>
            </span>
          ))}
        </label>
        {injectTracks.length > 0 && (
          <label className="coi-field coi-field-wide">
            <span className="coi-label">{t('launch.ctxText')}</span>
            <textarea
              className="coi-textarea"
              rows={4}
              value={ctxText}
              onChange={(e) => setCtxText(e.target.value)}
              placeholder={t('launch.ctxTextPh')}
            />
          </label>
        )}
        <div className="coi-form-actions">
          <button type="button" className="coi-btn coi-btn-primary" disabled={launching} onClick={() => void launch()}>
            {t('launch.submit')}
          </button>
        </div>
      </div>

      <NoticeLine notice={notice} />

      <div className="coi-task-toolbar">
        <input
          className="coi-input"
          placeholder={t('tasks.searchPh')}
          value={searchQ}
          onChange={(e) => setSearchQ(e.target.value)}
        />
      </div>

      <div className="coi-split">
        <div className="coi-task-list">
          <ErrorLine error={error} />
          {tasks === null && error === null && <div className="coi-muted coi-pad">{t('loading')}</div>}
          {tasks !== null && tasks.length === 0 && <div className="coi-muted coi-pad">{t('tasks.empty')}</div>}
          {tasks?.map((task) => {
            const meta = statusMeta(task.status)
            return (
              <button
                key={task.id}
                type="button"
                className={`coi-task-row${selectedId === task.id ? ' coi-task-row-active' : ''}`}
                onClick={() => setSelectedId(task.id)}
              >
                <span className={`coi-task-status ${meta.cls}`} title={meta.label}>{meta.icon}</span>
                <span className="coi-mono coi-task-id">{task.id}</span>
                <span className="coi-task-adapter">{task.adapterId}</span>
                <span className="coi-task-prompt" title={task.prompt}>{trunc(task.prompt)}</span>
                <span className="coi-badge">{t('scope.' + task.scope) ?? task.scope}</span>
                <span className="coi-muted coi-task-time">{fmtTime(task.createdAt)}</span>
              </button>
            )
          })}
        </div>

        <div className="coi-detail">
          {selectedId === null && <div className="coi-muted coi-pad">{t('tasks.selectHint')}</div>}
          {selectedId !== null && detail === null && <div className="coi-muted coi-pad">{t('loading')}</div>}
          {detail !== null && (
            <>
              <div className="coi-detail-meta">
                <div className="coi-meta-row">
                  <span className="coi-label">{t('tasks.status')}</span>
                  <span className={statusMeta(detail.status).cls}>
                    {statusMeta(detail.status).icon} {statusMeta(detail.status).label}
                  </span>
                </div>
                <div className="coi-meta-row">
                  <span className="coi-label">{t('tasks.adapter')}</span>
                  <span>{detail.adapterId}</span>
                </div>
                <div className="coi-meta-row">
                  <span className="coi-label">{t('tasks.scope')}</span>
                  <span className="coi-badge">{t('scope.' + detail.scope) ?? detail.scope}</span>
                </div>
                {detail.branch !== null && (
                  <div className="coi-meta-row">
                    <span className="coi-label">{t('tasks.branch')}</span>
                    <span className="coi-mono">{detail.branch}</span>
                  </div>
                )}
                {detail.sessionId !== null && (
                  <div className="coi-meta-row">
                    <span className="coi-label">{t('tasks.sessionId')}</span>
                    <span className="coi-mono coi-small">{detail.sessionId}</span>
                    <button type="button" className="coi-btn coi-btn-mini" onClick={() => void copySession(detail.sessionId ?? '')}>
                      {copied ? t('tasks.copied') : t('tasks.copy')}
                    </button>
                  </div>
                )}
                <div className="coi-meta-row">
                  <span className="coi-label">{t('tasks.created')}</span>
                  <span>{fmtTime(detail.createdAt)}</span>
                </div>
                <div className="coi-meta-row">
                  <span className="coi-label">{t('tasks.duration')}</span>
                  <span>{fmtDur(detailDur(detail))}</span>
                </div>
                {running && detail.lastOutputAt != null && (
                  <div className="coi-meta-row">
                    <span className="coi-label">{t('tasks.lastOutput')}</span>
                    <span>{fmtAgo(detail.lastOutputAt)}</span>
                  </div>
                )}
                {detail.exitCode !== null && (
                  <div className="coi-meta-row">
                    <span className="coi-label">{t('tasks.exitCode')}</span>
                    <span className="coi-mono">{detail.exitCode}</span>
                  </div>
                )}
              </div>
              <div className="coi-detail-actions">
                {running && (
                  <button type="button" className="coi-btn coi-btn-danger" onClick={() => void kill()}>
                    🛑 {t('tasks.kill')}
                  </button>
                )}
                {!running && (
                  <button type="button" className="coi-btn" onClick={() => void retry()}>
                    ↻ {t('tasks.retry')}
                  </button>
                )}
                {!running && (
                  <button type="button" className="coi-btn coi-btn-danger" onClick={() => void removeTask(detail.id)}>
                    🗑 {t('tasks.delete')}
                  </button>
                )}
              </div>
              {detail.error !== null && detail.error !== '' && (
                <div className="coi-error">
                  {t('tasks.error')}：{detail.error}
                </div>
              )}
              <div className="coi-log-head">
                <span className="coi-label coi-log-title">{t('tasks.prompt')}</span>
                <button type="button" className="coi-btn coi-btn-mini" onClick={() => setFullPrompt(true)}>⛶ {t('tasks.logFull')}</button>
              </div>
              <pre className="coi-prompt-view">{detail.prompt}</pre>
              <div className="coi-log-head">
                <span className="coi-label coi-log-title">{t('tasks.log')}</span>
                <button type="button" className="coi-btn coi-btn-mini" onClick={() => setFullLog(true)}>⛶ {t('tasks.logFull')}</button>
              </div>
              {logError !== null && <div className="coi-error">{logError}</div>}
              <pre ref={logRef} className="coi-log">{log === '' ? t('tasks.logEmpty') : log}</pre>
            </>
          )}
        </div>
      </div>
      {fullPrompt && detail !== null && (
        <div className="coi-modal" onClick={() => setFullPrompt(false)}>
          <div className="coi-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="coi-modal-head">
              <span className="coi-mono coi-small">{t('tasks.prompt')} — {detail.id}</span>
              <button type="button" className="coi-btn coi-btn-mini" onClick={() => setFullPrompt(false)}>✕</button>
            </div>
            <pre className="coi-log coi-log-full coi-prompt-view-full">{detail.prompt}</pre>
          </div>
        </div>
      )}
      {fullLog && detail !== null && (
        <div className="coi-modal" onClick={() => setFullLog(false)}>
          <div className="coi-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="coi-modal-head">
              <span className="coi-mono coi-small">{t('tasks.log')} — {detail.id}（{detail.adapterId} {t('scope.' + detail.scope) ?? detail.scope}）</span>
              <button type="button" className="coi-btn coi-btn-mini" onClick={() => setFullLog(false)}>✕</button>
            </div>
            <pre ref={fullLogRef} className="coi-log coi-log-full">{log === '' ? t('tasks.logEmpty') : log}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 会话视图                                                             */
/* ------------------------------------------------------------------ */

function SessionsPane({ dsSessionId }: { dsSessionId?: string }): JSX.Element {
  const visQs = (dsSessionId ?? '') !== '' ? `&sessionId=${encodeURIComponent(String(dsSessionId))}` : ''
  const [sessions, setSessions] = useState<CoiSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [scopeFilter, setScopeFilter] = useState('')
  const [q, setQ] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      const params = new URLSearchParams()
      if (scopeFilter !== '') params.set('scope', scopeFilter)
      if (q.trim() !== '') params.set('q', q.trim())
      const data = await fetchJson<{ sessions: CoiSession[] }>(`/sessions?${params.toString()}${visQs}`)
      setSessions(data.sessions)
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [scopeFilter, q])

  useEffect(() => {
    void load()
  }, [load])

  const saveNote = async (id: string): Promise<void> => {
    try {
      await postJson('/sessions/note', { id, note: noteDraft })
      setEditId(null)
      setNotice({ kind: 'ok', text: t('config.saved') })
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    }
  }

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm(t('sessions.confirmDelete'))) return
    try {
      await deleteJson(`/sessions/${encodeURIComponent(id)}`)
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    }
  }

  return (
    <div className="coi-pane">
      <div className="coi-toolbar">
        <select className="coi-select" value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)} title={t('sessions.filterScope')}>
          <option value="">{t('all')}</option>
          {SCOPES.map((s) => (
            <option key={s} value={s}>{t(`scope.${s}`)}</option>
          ))}
        </select>
        <input
          className="coi-input"
          placeholder={t('sessions.searchPh')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="button" className="coi-btn" onClick={() => void load()}>{t('refresh')}</button>
      </div>
      <NoticeLine notice={notice} />
      <ErrorLine error={error} />
      {sessions === null && error === null && <div className="coi-muted coi-pad">{t('loading')}</div>}
      {sessions !== null && sessions.length === 0 && <div className="coi-muted coi-pad">{t('sessions.empty')}</div>}
      {sessions?.map((s) => (
        <div key={s.id} className="coi-row">
          <div className="coi-row-line">
            <span className="coi-mono coi-small">{s.id}</span>
            {s.activeTaskId !== null && s.activeTaskId !== '' && (
              <span title={`${t('sessions.locked')}：${s.activeTaskId}`}>🔒</span>
            )}
            <span className="coi-badge">{t('scope.' + s.scope) ?? s.scope}</span>
            <span>{s.adapterId}</span>
            {s.branch !== null && <span className="coi-muted coi-mono coi-small">{s.branch}</span>}
            <span className="coi-muted coi-small">{t('sessions.lastSeen')} {fmtTime(s.lastSeen)}</span>
          </div>
          <div className="coi-row-line">
            {editId === s.id ? (
              <>
                <input
                  className="coi-input coi-grow"
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder={t('sessions.note')}
                />
                <button type="button" className="coi-btn coi-btn-mini" onClick={() => void saveNote(s.id)}>{t('sessions.save')}</button>
              </>
            ) : (
              <>
                <span className="coi-muted coi-grow">{s.note !== null && s.note !== '' ? s.note : '—'}</span>
                <button
                  type="button"
                  className="coi-btn coi-btn-mini"
                  onClick={() => {
                    setEditId(s.id)
                    setNoteDraft(s.note ?? '')
                  }}
                >
                  {t('sessions.note')}
                </button>
              </>
            )}
            <button type="button" className="coi-btn coi-btn-mini coi-btn-danger" onClick={() => void remove(s.id)}>
              {t('sessions.delete')}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 适配器视图                                                           */
/* ------------------------------------------------------------------ */

function AdaptersPane(): JSX.Element {
  const [adapters, setAdapters] = useState<Adapter[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [guideOpen, setGuideOpen] = useState<string | null>(null)
  // 技能编辑（指南 = 关联技能的 SKILL.md）
  const [skillEditId, setSkillEditId] = useState<string | null>(null)
  const [skillEditName, setSkillEditName] = useState('')
  const [skillContent, setSkillContent] = useState('')
  const [skillSaving, setSkillSaving] = useState(false)
  const [skillError, setSkillError] = useState<string | null>(null)
  // useCase 行内编辑
  const [useCaseEditId, setUseCaseEditId] = useState<string | null>(null)
  const [useCaseDraft, setUseCaseDraft] = useState('')

  // 添加表单
  const [fId, setFId] = useState('')
  const [fName, setFName] = useState('')
  const [fType, setFType] = useState<'ai-cli' | 'plain-cli'>('ai-cli')
  const [fBinary, setFBinary] = useState('')
  const [fArgs, setFArgs] = useState('')
  const [fSkill, setFSkill] = useState('')
  const [fUseCase, setFUseCase] = useState('')
  const [fSkillContent, setFSkillContent] = useState('')
  // ai-cli 专属：会话恢复配置（resume 必填，continue/提取可选）
  const [fResumeKind, setFResumeKind] = useState<'flag' | 'args'>('flag')
  const [fResumeFlag, setFResumeFlag] = useState('')
  const [fResumeArg, setFResumeArg] = useState('')
  const [fResumeArgs, setFResumeArgs] = useState('')
  const [fContinueFlag, setFContinueFlag] = useState('')
  const [fExtractSource, setFExtractSource] = useState<'stdout' | 'stderr' | 'any' | 'none'>('none')
  const [fExtractRegex, setFExtractRegex] = useState('')
  const [adding, setAdding] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchJson<{ adapters: Adapter[] }>('/adapters')
      setAdapters(data.adapters)
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const test = async (id: string): Promise<void> => {
    try {
      const res = await postJson<{ ok: boolean; taskId?: string; message?: string }>('/adapters/test', { id })
      setNotice({ kind: 'ok', text: `${t('adapters.testOk')}${res.taskId !== undefined ? `：${res.taskId}` : ''}${res.message !== undefined ? `（${res.message}）` : ''}` })
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    }
  }

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm(t('adapters.confirmDelete'))) return
    try {
      const res = await deleteJson<{ ok: boolean; message?: string }>(`/adapters/${encodeURIComponent(id)}`)
      if (res.ok === false) {
        setNotice({ kind: 'error', text: msgOr(res.message, 'ok:false') })
        return
      }
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    }
  }

  const saveUseCase = async (a: Adapter): Promise<void> => {
    try {
      // 发送完整定义（...a 含 resume/continue/sessionIdExtract 等全部字段），
      // 只覆盖 useCase——后端按完整定义校验，避免部分字段被拒
      const def = { ...a, useCase: useCaseDraft.trim() }
      const res = await postJson<{ ok: boolean; message?: string }>('/adapters', { def })
      if (res.ok !== true) {
        setNotice({ kind: 'error', text: msgOr(res.message, '保存失败') })
        return
      }
      setUseCaseEditId(null)
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    }
  }

  const toggleEnabled = async (a: Adapter): Promise<void> => {
    try {
      const next = a.enabled === false
      const res = await postJson<{ ok: boolean; message?: string }>(`/adapters/${encodeURIComponent(a.id)}/enabled`, { enabled: next })
      if (res.ok !== true) {
        setNotice({ kind: 'error', text: msgOr(res.message, '操作失败') })
        return
      }
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    }
  }

  // 技能编辑：指南 = 关联技能的 SKILL.md（源头在插件，技能管理 Tab 可禁用）
  const openSkillEdit = async (a: Adapter): Promise<void> => {
    setSkillError(null)
    setSkillEditName(a.skillName ?? '')
    setSkillContent('')
    setSkillEditId(a.id)
    try {
      const res = await fetchJson<{ ok: boolean; skillName?: string; exists?: boolean; content?: string; message?: string }>(`/adapters/${encodeURIComponent(a.id)}/skill`)
      if (res.ok !== true) {
        setSkillError(msgOr(res.message, '读取失败'))
        return
      }
      setSkillEditName(res.skillName ?? '')
      setSkillContent(res.content ?? '')
    } catch (err) {
      setSkillError(errText(err))
    }
  }

  const saveSkill = async (): Promise<void> => {
    if (skillEditId === null) return
    setSkillSaving(true)
    setSkillError(null)
    try {
      const res = await fetchJson<{ ok: boolean; message?: string }>(`/adapters/${encodeURIComponent(skillEditId)}/skill`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: skillContent }),
      })
      if (res.ok !== true) {
        setSkillError(msgOr(res.message, '保存失败'))
        return
      }
      setNotice({ kind: 'ok', text: res.message ?? t('adapters.skillSaved') })
      setSkillEditId(null)
      setSkillContent('')
    } catch (err) {
      setSkillError(errText(err))
    } finally {
      setSkillSaving(false)
    }
  }

  const add = async (): Promise<void> => {
    // 前端预校验：ai-cli 必须有 resume（与后端 validateAdapter 一致，省一次往返）
    if (fType === 'ai-cli') {
      const resumeEmpty = fResumeKind === 'flag' ? fResumeFlag.trim() === '' : fResumeArgs.trim() === ''
      if (resumeEmpty) {
        setNotice({ kind: 'error', text: t('adapters.resumeMissing') })
        return
      }
    }
    setAdding(true)
    try {
      const def: Record<string, unknown> = {
        id: fId.trim(),
        name: fName.trim(),
        type: fType,
        binary: fBinary.trim(),
        args: fArgs.split(',').map((s) => s.trim()).filter((s) => s !== ''),
        skillName: fSkill.trim() === '' ? undefined : fSkill.trim(),
        useCase: fUseCase.trim() === '' ? undefined : fUseCase.trim(),
      }
      if (fType === 'ai-cli') {
        // resume 必填：flag 模式（flag+arg 插在基础参数前）/ args 模式（完整恢复命令）
        // arg 留空默认 {sessionId}——调度器用它替换会话 id
        def.resume = fResumeKind === 'flag'
          ? { kind: 'flag', flag: fResumeFlag.trim(), arg: fResumeArg.trim() === '' ? '{sessionId}' : fResumeArg.trim() }
          : { kind: 'args', args: fResumeArgs.split(',').map((s) => s.trim()).filter((s) => s !== '') }
        if (fContinueFlag.trim() !== '') def.continue = { kind: 'flag', flag: fContinueFlag.trim() }
        if (fExtractSource !== 'none' && fExtractRegex.trim() !== '') {
          def.sessionIdExtract = { source: fExtractSource, regex: fExtractRegex.trim() }
        }
      }
      const skillContent = fSkill.trim() !== '' && fSkillContent.trim() !== '' ? fSkillContent : undefined
      const res = await postJson<{ ok: boolean; message?: string; skillMessage?: string }>('/adapters', { def, skillContent })
      if (res.ok !== true) {
        setNotice({ kind: 'error', text: msgOr(res.message, '保存失败') })
        return
      }
      setNotice({ kind: 'ok', text: res.skillMessage !== undefined ? res.skillMessage : t('config.saved') })
      setFId('')
      setFName('')
      setFBinary('')
      setFArgs('')
      setFUseCase('')
      // 清空 ai-cli 会话恢复配置（类型/恢复方式保留，方便连续添加同类适配器）
      setFResumeFlag('')
      setFResumeArg('')
      setFResumeArgs('')
      setFContinueFlag('')
      setFExtractRegex('')
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="coi-pane">
      <NoticeLine notice={notice} />
      <ErrorLine error={error} />
      {adapters === null && error === null && <div className="coi-muted coi-pad">{t('loading')}</div>}
      <div className="coi-cards">
        {adapters?.map((a) => {
          const builtin = BUILTIN_ADAPTER_IDS.has(a.id)
          return (
            <div key={a.id} className="coi-card coi-adapter-card">
              <div className="coi-row-line">
                <span className="coi-strong">{a.name}</span>
                <span className="coi-mono coi-small coi-muted">{a.id}</span>
                <span className="coi-badge">{a.type}</span>
                <span className="coi-badge">{builtin ? t('adapters.builtin') : t('adapters.custom')}</span>
                <span className="coi-grow" />
                {a.skillName !== undefined && a.skillName !== '' && (
                  <span className="coi-muted coi-small coi-skill-tag" title={t('adapters.skillHint')}>
                    {t('adapters.skill')}：{a.skillName}
                  </span>
                )}
                {a.skillName !== undefined && a.skillName !== '' && (
                  <button type="button" className="coi-btn coi-btn-mini" onClick={() => void openSkillEdit(a)}>
                    {t('adapters.skillBtn')}
                  </button>
                )}
                <button
                  type="button"
                  className={`coi-btn coi-btn-mini${a.enabled === false ? ' coi-btn-danger' : ''}`}
                  onClick={() => void toggleEnabled(a)}
                >
                  {a.enabled === false ? t('adapters.enable') : t('adapters.disable')}
                </button>
                <button type="button" className="coi-btn coi-btn-mini" onClick={() => void test(a.id)}>
                  {t('adapters.test')}
                </button>
                {!builtin && (
                  <button type="button" className="coi-btn coi-btn-mini coi-btn-danger" onClick={() => void remove(a.id)}>
                    {t('adapters.delete')}
                  </button>
                )}
              </div>
              <div className="coi-row-line coi-muted coi-small">
                <span className="coi-mono">{a.binary}</span>
                {a.args.length > 0 && <span className="coi-mono">{a.args.join(' ')}</span>}
              </div>
              <div className="coi-row-line coi-muted coi-small">
                {useCaseEditId === a.id ? (
                  <>
                    <span>🎯</span>
                    <input
                      className="coi-input coi-grow"
                      value={useCaseDraft}
                      onChange={(e) => setUseCaseDraft(e.target.value)}
                      placeholder={t('adapters.useCasePh')}
                    />
                    <button type="button" className="coi-btn coi-btn-mini coi-btn-primary" onClick={() => void saveUseCase(a)}>{t('adapters.saveUseCase')}</button>
                    <button type="button" className="coi-btn coi-btn-mini" onClick={() => setUseCaseEditId(null)}>{t('cancel')}</button>
                  </>
                ) : (
                  <>
                    <span className="coi-grow">🎯 {a.useCase !== undefined && a.useCase !== '' ? a.useCase : t('adapters.useCaseEmpty')}</span>
                    <button
                      type="button"
                      className="coi-btn coi-btn-mini"
                      onClick={() => { setUseCaseEditId(a.id); setUseCaseDraft(a.useCase ?? '') }}
                    >
                      {t('adapters.editUseCase')}
                    </button>
                  </>
                )}
              </div>
              {a.enabled === false && (
                <div className="coi-row-line coi-error">
                  <span>⛔ {t('adapters.disabledHint')}</span>
                </div>
              )}
              {guideOpen === a.id && a.guide !== undefined && <pre className="coi-guide">{a.guide}</pre>}
            </div>
          )
        })}
      </div>

      <div className="coi-card">
        <div className="coi-card-title">{t('adapters.addTitle')}</div>
        <div className="coi-form-grid">
          <label className="coi-field">
            <span className="coi-label">id</span>
            <input className="coi-input" value={fId} onChange={(e) => setFId(e.target.value)} placeholder="my-cli" />
          </label>
          <label className="coi-field">
            <span className="coi-label">{t('adapters.name')}</span>
            <input className="coi-input" value={fName} onChange={(e) => setFName(e.target.value)} />
          </label>
          <label className="coi-field">
            <span className="coi-label">{t('adapters.type')}</span>
            <select className="coi-select" value={fType} onChange={(e) => setFType(e.target.value as 'ai-cli' | 'plain-cli')}>
              <option value="ai-cli">ai-cli</option>
              <option value="plain-cli">plain-cli</option>
            </select>
          </label>
          <label className="coi-field">
            <span className="coi-label">{t('adapters.binary')}</span>
            <input className="coi-input" value={fBinary} onChange={(e) => setFBinary(e.target.value)} placeholder="/usr/local/bin/my-cli" />
          </label>
          <label className="coi-field coi-field-wide">
            <span className="coi-label">{t('adapters.args')}</span>
            <input className="coi-input" value={fArgs} onChange={(e) => setFArgs(e.target.value)} placeholder={t('adapters.argsPh')} />
          </label>
          <label className="coi-field coi-field-wide">
            <span className="coi-label">{t('adapters.skillName')}</span>
            <input className="coi-input" value={fSkill} onChange={(e) => setFSkill(e.target.value)} placeholder={t('adapters.skillNamePh')} />
          </label>
          <label className="coi-field coi-field-wide">
            <span className="coi-label">{t('adapters.useCase')}</span>
            <input className="coi-input" value={fUseCase} onChange={(e) => setFUseCase(e.target.value)} placeholder={t('adapters.useCasePh')} />
          </label>
          {fType === 'ai-cli' && (
            <>
              {/* ai-cli 会话恢复配置：后端 validateAdapter 强制 ai-cli 必须有 resume，
                  这里提供对应输入，避免"手动添加 AI 适配器保存被拒" */}
              <div className="coi-field coi-field-wide coi-resume-section">
                <span className="coi-label">{t('adapters.resumeSection')}</span>
                <span className="coi-muted coi-small">{t('adapters.resumeSectionHint')}</span>
              </div>
              <label className="coi-field">
                <span className="coi-label">{t('adapters.resumeKind')}</span>
                <select className="coi-select" value={fResumeKind} onChange={(e) => setFResumeKind(e.target.value as 'flag' | 'args')}>
                  <option value="flag">{t('adapters.resumeKindFlag')}</option>
                  <option value="args">{t('adapters.resumeKindArgs')}</option>
                </select>
              </label>
              {fResumeKind === 'flag' ? (
                <>
                  <label className="coi-field">
                    <span className="coi-label">{t('adapters.resumeFlag')}</span>
                    <input className="coi-input" value={fResumeFlag} onChange={(e) => setFResumeFlag(e.target.value)} placeholder={t('adapters.resumeFlagPh')} />
                  </label>
                  <label className="coi-field">
                    <span className="coi-label">{t('adapters.resumeArg')}</span>
                    <input className="coi-input" value={fResumeArg} onChange={(e) => setFResumeArg(e.target.value)} placeholder={t('adapters.resumeArgPh')} />
                  </label>
                </>
              ) : (
                <label className="coi-field coi-field-wide">
                  <span className="coi-label">{t('adapters.resumeArgs')}</span>
                  <input className="coi-input" value={fResumeArgs} onChange={(e) => setFResumeArgs(e.target.value)} placeholder={t('adapters.resumeArgsPh')} />
                </label>
              )}
              <label className="coi-field coi-field-wide">
                <span className="coi-label">{t('adapters.continueFlag')}</span>
                <input className="coi-input" value={fContinueFlag} onChange={(e) => setFContinueFlag(e.target.value)} placeholder={t('adapters.continueFlagPh')} />
              </label>
              <div className="coi-field coi-field-wide coi-resume-section">
                <span className="coi-label">{t('adapters.extractSection')}</span>
              </div>
              <label className="coi-field">
                <span className="coi-label">{t('adapters.extractSource')}</span>
                <select className="coi-select" value={fExtractSource} onChange={(e) => setFExtractSource(e.target.value as 'stdout' | 'stderr' | 'any' | 'none')}>
                  <option value="none">none</option>
                  <option value="stdout">stdout</option>
                  <option value="stderr">stderr</option>
                  <option value="any">any</option>
                </select>
              </label>
              {fExtractSource !== 'none' && (
                <label className="coi-field coi-field-wide">
                  <span className="coi-label">{t('adapters.extractRegex')}</span>
                  <input className="coi-input" value={fExtractRegex} onChange={(e) => setFExtractRegex(e.target.value)} placeholder={t('adapters.extractRegexPh')} />
                </label>
              )}
            </>
          )}
          {fSkill.trim() !== '' && (
            <label className="coi-field coi-field-wide">
              <span className="coi-label">{t('adapters.skillContent')}</span>
              <textarea
                className="coi-textarea"
                rows={5}
                value={fSkillContent}
                onChange={(e) => setFSkillContent(e.target.value)}
                placeholder={t('adapters.skillContentPh')}
              />
              <span className="coi-muted coi-small">{t('adapters.skillContentHint')}</span>
            </label>
          )}
        </div>
        <div className="coi-form-actions">
          {/* ai-cli 必填 resume：缺失时禁用添加按钮（与 add() 内预校验一致） */}
          <button
            type="button"
            className="coi-btn coi-btn-primary"
            disabled={adding
              || fId.trim() === ''
              || fName.trim() === ''
              || fBinary.trim() === ''
              || (fType === 'ai-cli' && (fResumeKind === 'flag' ? fResumeFlag.trim() === '' : fResumeArgs.trim() === ''))}
            onClick={() => void add()}
          >
            {t('adapters.add')}
          </button>
        </div>
      </div>

      {/* 技能编辑弹窗：指南 = 关联技能的 SKILL.md */}
      {skillEditId !== null && (
        <div className="coi-modal" onClick={() => setSkillEditId(null)}>
          <div className="coi-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="coi-modal-head">
              <span className="coi-small">{t('adapters.editSkillTitle')}：{skillEditName}</span>
              <button type="button" className="coi-btn coi-btn-mini" onClick={() => setSkillEditId(null)}>✕</button>
            </div>
            {skillError !== null && <div className="coi-error coi-pad">{skillError}</div>}
            <div className="coi-pad coi-muted coi-small">{t('adapters.editSkillHint')}</div>
            <textarea
              className="coi-textarea coi-skill-editor"
              value={skillContent}
              onChange={(e) => setSkillContent(e.target.value)}
              placeholder="# SKILL.md"
            />
            <div className="coi-modal-head">
              <button type="button" className="coi-btn coi-btn-mini" onClick={() => setSkillEditId(null)}>{t('cancel')}</button>
              <button type="button" className="coi-btn coi-btn-primary coi-btn-mini" disabled={skillSaving} onClick={() => void saveSkill()}>
                {skillSaving ? t('saving') : t('adapters.saveSkill')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 模板视图                                                             */
/* ------------------------------------------------------------------ */

function TemplatesPane(): JSX.Element {
  const [templates, setTemplates] = useState<CoiTemplate[] | null>(null)
  const [adapters, setAdapters] = useState<Adapter[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const [fId, setFId] = useState('')
  const [fName, setFName] = useState('')
  const [fPrompt, setFPrompt] = useState('')
  const [fAdapterId, setFAdapterId] = useState('')
  const [adding, setAdding] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchJson<{ templates: CoiTemplate[] }>('/templates')
      setTemplates(data.templates)
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [])

  useEffect(() => {
    void load()
    fetchJson<{ adapters: Adapter[] }>('/adapters')
      .then((data) => setAdapters(data.adapters))
      .catch(() => { /* 下拉留空 */ })
  }, [load])

  const remove = async (id: string): Promise<void> => {
    if (BUILTIN_TEMPLATE_IDS.has(id)) {
      setNotice({ kind: 'error', text: t('templates.builtinKeep') })
      return
    }
    if (!window.confirm(t('templates.confirmDelete'))) return
    try {
      await deleteJson(`/templates/${encodeURIComponent(id)}`)
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    }
  }

  const add = async (): Promise<void> => {
    setAdding(true)
    try {
      const def: Record<string, unknown> = { name: fName.trim(), prompt: fPrompt }
      if (fId.trim() !== '') def.id = fId.trim()
      if (fAdapterId !== '') def.adapterId = fAdapterId
      await postJson('/templates', { def })
      setNotice({ kind: 'ok', text: t('config.saved') })
      setFId('')
      setFName('')
      setFPrompt('')
      setFAdapterId('')
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="coi-pane">
      <NoticeLine notice={notice} />
      <ErrorLine error={error} />
      {templates === null && error === null && <div className="coi-muted coi-pad">{t('loading')}</div>}
      {templates !== null && templates.length === 0 && <div className="coi-muted coi-pad">{t('templates.empty')}</div>}
      {templates?.map((tpl) => (
        <div key={tpl.id} className="coi-row">
          <div className="coi-row-line">
            <span className="coi-strong">{tpl.name}</span>
            <span className="coi-mono coi-small coi-muted">{tpl.id}</span>
            {tpl.adapterId !== undefined && <span className="coi-badge">{tpl.adapterId}</span>}
            {BUILTIN_TEMPLATE_IDS.has(tpl.id) && <span className="coi-badge">{t('adapters.builtin')}</span>}
            <span className="coi-grow" />
            <button type="button" className="coi-btn coi-btn-mini coi-btn-danger" onClick={() => void remove(tpl.id)}>
              {t('templates.delete')}
            </button>
          </div>
          <div className="coi-row-line coi-muted" title={tpl.prompt}>{trunc(tpl.prompt, 80)}</div>
        </div>
      ))}

      <div className="coi-card">
        <div className="coi-card-title">{t('templates.addTitle')}</div>
        <div className="coi-form-grid">
          <label className="coi-field">
            <span className="coi-label">{t('templates.name')}</span>
            <input className="coi-input" value={fName} onChange={(e) => setFName(e.target.value)} />
          </label>
          <label className="coi-field">
            <span className="coi-label">{t('templates.adapterOpt')}</span>
            <select className="coi-select" value={fAdapterId} onChange={(e) => setFAdapterId(e.target.value)}>
              <option value="">{t('none')}</option>
              {adapters.map((a) => (
                <option key={a.id} value={a.id}>{a.id}</option>
              ))}
            </select>
          </label>
          <label className="coi-field coi-field-wide">
            <span className="coi-label">{t('templates.idOpt')}</span>
            <input className="coi-input" value={fId} onChange={(e) => setFId(e.target.value)} placeholder="my-template" />
          </label>
        </div>
        <label className="coi-field">
          <span className="coi-label">{t('templates.prompt')}</span>
          <textarea className="coi-textarea" rows={3} value={fPrompt} onChange={(e) => setFPrompt(e.target.value)} />
        </label>
        <div className="coi-form-actions">
          <button type="button" className="coi-btn coi-btn-primary" disabled={adding || fName.trim() === '' || fPrompt.trim() === ''} onClick={() => void add()}>
            {t('templates.add')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 统计视图                                                             */
/* ------------------------------------------------------------------ */

function StatsPane(): JSX.Element {
  const [stats, setStats] = useState<CoiStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchJson<CoiStats>('/stats')
      setStats(data)
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="coi-pane">
      <div className="coi-toolbar">
        <button type="button" className="coi-btn" onClick={() => void load()}>{t('refresh')}</button>
      </div>
      <ErrorLine error={error} />
      {stats === null && error === null && <div className="coi-muted coi-pad">{t('loading')}</div>}
      {stats !== null && (
        <>
          <div className="coi-stat-grid">
            <div className="coi-stat-card">
              <div className="coi-stat-num">{stats.total}</div>
              <div className="coi-muted">{t('stats.total')}</div>
            </div>
          </div>
          <div className="coi-stat-grid">
            {Object.entries(stats.byAdapter).map(([id, bucket]) => (
              <div key={id} className="coi-stat-card">
                <div className="coi-strong">{id}</div>
                <div className="coi-stat-num">{bucket.count}</div>
                <div className="coi-muted coi-small">
                  {t('stats.count')} · {t('stats.hours')} {(bucket.totalMs / 3600000).toFixed(2)}h
                </div>
                <div className="coi-row-line coi-small">
                  {Object.entries(bucket.byStatus).map(([status, count]) => {
                    const meta = statusMeta(status)
                    return (
                      <span key={status} className={meta.cls} title={meta.label}>
                        {meta.icon} {count}
                      </span>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
          {Object.keys(stats.byAdapter).length === 0 && <div className="coi-muted coi-pad">{t('stats.empty')}</div>}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 配置视图                                                             */
/* ------------------------------------------------------------------ */

function ConfigPane(): JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [notify, setNotify] = useState('')
  const [retention, setRetention] = useState('')
  const [timeoutH, setTimeoutH] = useState('')
  const [timeoutM, setTimeoutM] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchJson<{ config: CoiConfig }>('/config')
      .then((data) => {
        setNotify(data.config.coiNotifyCommand ?? '')
        setRetention(String(data.config.coiRetentionDays ?? ''))
        const ms = data.config.coiTaskTimeoutMs ?? 0
        setTimeoutH(String(Math.floor(ms / 3600000)))
        setTimeoutM(String(Math.round((ms % 3600000) / 60000)))
        setLoaded(true)
      })
      .catch((err) => setError(errText(err)))
  }, [])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const patch: Record<string, unknown> = { coiNotifyCommand: notify }
      const days = Number(retention)
      const h = Number(timeoutH)
      const m = Number(timeoutM)
      if (retention.trim() !== '' && Number.isFinite(days)) patch.coiRetentionDays = days
      if (timeoutH.trim() !== '' || timeoutM.trim() !== '') {
        const totalMinutes = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
        if (!Number.isFinite(totalMinutes) || totalMinutes < 0) throw new Error(t('config.timeoutBad'))
        patch.coiTaskTimeoutMs = totalMinutes * 60000
      }
      await postJson('/config', { patch })
      setNotice({ kind: 'ok', text: t('config.saved') })
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="coi-pane">
      <NoticeLine notice={notice} />
      <ErrorLine error={error} />
      {!loaded && error === null && <div className="coi-muted coi-pad">{t('loading')}</div>}
      {loaded && (
        <div className="coi-card">
          <label className="coi-field">
            <span className="coi-label">{t('config.notify')}</span>
            <input className="coi-input" value={notify} onChange={(e) => setNotify(e.target.value)} />
            <span className="coi-muted coi-small">{t('config.notifyHint')}</span>
          </label>
          <label className="coi-field">
            <span className="coi-label">{t('config.retention')}</span>
            <input className="coi-input" type="number" min={0} value={retention} onChange={(e) => setRetention(e.target.value)} />
          </label>
          <label className="coi-field">
            <span className="coi-label">{t('config.timeout')}</span>
            <div className="coi-inline">
              <input className="coi-input" type="number" min={0} value={timeoutH} onChange={(e) => setTimeoutH(e.target.value)} placeholder="0" />
              <span className="coi-muted coi-small">{t('config.timeoutHours')}</span>
              <input className="coi-input" type="number" min={0} max={59} value={timeoutM} onChange={(e) => setTimeoutM(e.target.value)} placeholder="0" />
              <span className="coi-muted coi-small">{t('config.timeoutMinutes')}</span>
            </div>
            <span className="coi-muted coi-small">{t('config.timeoutHint')}</span>
          </label>
          <div className="coi-form-actions">
            <button type="button" className="coi-btn coi-btn-primary" disabled={saving} onClick={() => void save()}>
              {t('config.save')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
