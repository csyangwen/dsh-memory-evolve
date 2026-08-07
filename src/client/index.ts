/**
 * dsh-memory-evolve — client entry.
 *
 * Registers the session memory tab ('conversation.view') — the ONLY
 * memory-management surface (the former settings-panel section was
 * removed). The tab hosts the memory files, the pending suggestion/skill
 * queues and the runtime-config form as sub-tabs, all backed by the node
 * half's /memory-evolve/api routes. The tab label carries a red-dot pending
 * count (🔴 记忆 (N)) while suggestions/skills await confirmation, refreshed
 * by polling the badge endpoint and re-registering through the deferral
 * handle's refresh().
 */
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row lives in ui-conversation.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { MemoryTabView } from './MemoryTabView.tsx'
import styles from './styles.css'
import skillBrowserStyles from './skills-browser/styles.css'

/** Locale namespace owned by this plugin. */
const NS = 'memory-evolve'

/** Dictionary key set for the memory-evolve namespace. */
export type MemoryEvolveKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'memory-evolve': MemoryEvolveKey
  }
}

/** Simplified-Chinese dictionary (key-set source of truth). */
export const zh = {
  'tab.label': '技能管理器',
  'tab.label.alt': '技能管理器',
  'header.title': '技能管理器',
  'header.subtitle': '管理全部技能 · 自定义目录 · 禁用/启用 · 查看与编辑',
  'search.placeholder': '搜索技能名称、描述或适用场景…',
  'search.empty': '没有匹配的技能',
  'filter.all': '全部',
  'status.enabled': '可用',
  'disable': '禁用',
  'enable': '启用',
  'disabled.badge': '已禁用',
  'disabled.hint': '已禁用：不会出现在模型的技能目录中',
  'protected.badge': '系统',
  'protected.hint': '系统技能（project 来源），不可禁用',
  'toggle.failed': '操作失败：{message}',
  'manage.dirs': '管理自定义技能目录',
  'dirs.title': '自定义技能目录',
  'dirs.help': '添加包含技能的目录（支持 <目录>/<技能>/SKILL.md 或 <目录>/<技能>.md 布局）。目录永久保存在插件 state.json，重启后自动加载；与已有技能根目录重叠的路径会被拒绝。',
  'dirs.placeholder': '输入绝对路径，如 ~/.hermes/skills/…',
  'dirs.add': '添加',
  'dirs.remove': '移除',
  'dirs.empty': '还没有自定义目录',
  'dirs.missing': '目录不存在',
  'pager.prev': '上一页',
  'pager.next': '下一页',
  'pager.page': '{page} / {total} 页',
  'skills.count': '{count} 个技能',
  'roots.count': '{count} 个目录',
  'pane.skills': '技能',
  'pane.files': '文件',
  'pane.editor': '编辑',
  'no.skill.selected': '从左侧选择一个技能开始浏览',
  'no.root': '该技能没有可浏览的本地目录',
  'no.entries': '空目录',
  'no.file': '选择一个文本文件查看或编辑',
  'not.text': '不是文本文件，无法预览',
  'too.large': '文件超过读取上限（512 KiB）',
  'read.failed': '读取失败：{message}',
  'write.failed': '保存失败：{message}',
  'save': '保存',
  'saving': '保存中…',
  'saved': '已保存',
  'edit': '编辑',
  'cancel': '取消',
  'discard': '放弃',
  'dirty.hint': '有未保存的修改',
  'readonly': '只读',
  'bytes': '{size} B',
  'kib': '{size} KiB',
  'mib': '{size} MiB',
  'dir.up': '上级目录',
  'open.folder': '打开目录',
  'source.badge': '{source}',
  'invocable': '可调用',
  'when.to.use': '适用场景',
  'description': '描述',
  'resource.directory': '目录',
  'resource.url': '链接',
  'resource.opaque': '资源',
  'refresh': '刷新',
  'loading.skills': '正在加载技能…',
  'loading.dir': '加载中…',
  'tree.collapse': '折叠',
  'tree.expand': '展开',
  'path': '路径',
  'root.label': '目录',
  'editor.placeholder': '在左侧文件树中选择一个文本文件开始编辑。',
  'status.ready': '就绪',
  'status.skill': '技能',
  'status.file': '文件',
  'status.unsaved': '未保存',
  'status.saved': '已保存',
  'confirm.discard.title': '放弃未保存的修改？',
  'confirm.discard.body': '你对 {name} 的修改尚未保存，切换文件将丢失这些修改。',
  'confirm.discard.ok': '放弃修改',
  'mtime.label': '修改于 {time}',
  'open.in.new.tab': '在新标签页打开',
  'preview': '预览',
  'memoryTab.label': '记忆技能待办',
  'memoryTab.label.pending': '🔴 记忆技能待办 ({count})',
  'memoryTab.feature.guide': '使用指南',
  'memoryTab.feature.suggestions': '待确认记忆建议',
  'memoryTab.feature.todoSuggestions': '待确认待办建议',
  'memoryTab.feature.skills': '待确认技能建议',
  'memoryTab.feature.config': '运行时配置',
  'memoryTab.feature.skillBrowser': '技能管理',
  'memoryTab.feature.todo': '待办',
  'todo.track.life': '生活',
  'todo.track.all': '全部',
  'todo.track': '待办轨',
  'todo.track.work': '工作',
  'todo.track.project': '本项目',
  'todo.track.daily': '今日',
  'todo.track.past': '过往',
  'todo.projectHint': '当前会话无工作目录，项目待办不可用（只有 生活/工作/今日）。',
  'todo.help': '四轨待办：生活=个人琐事；工作=跨项目的正事；本项目=当前工作目录的待办（换个目录看不到）；今日=今天要做的（按天分文件）。每日的过往待办（今天之前）默认不读取——点「过往」页签或勾选「显示已过期」才会查询历史（已过期的遗留默认隐藏，勾选后全部显示）。添加：输入内容，可选四象限（重要×紧急）与截止日期，点「添加」；或直接对我说“帮我加个待办，是工作上的/生活中的/这个项目的/今天要的”——我会按类别写入对应轨。',
  'todo.showExpired': '显示已过期',
  'todo.pastHint': '过往待办大多是已过期的遗留，默认已隐藏；勾选「显示已过期」即可查看。',
  'todo.addPlaceholder': '输入待办内容（可多行），选择象限/截止后添加…',
  'todo.add': '添加',
  'todo.added': '已添加待办',
  'todo.done': '完成',
  'todo.undone': '恢复',
  'todo.edit': '编辑',
  'todo.save': '保存',
  'todo.cancel': '取消',
  'todo.updated': '已更新',
  'todo.deleted': '已删除',
  'todo.deleteConfirm': '确定删除这条待办？删除后不可恢复。\n\n{snippet}',
  'todo.due': '截止',
  'todo.overdue': '逾期',
  'todo.all': '全部',
  'todo.filterStatus': '状态',
  'todo.filterQuadrant': '象限',
  'todo.status.active': '未完成',
  'todo.status.pending': '待办',
  'todo.status.doing': '进行中',
  'todo.status.done': '已完成',
  'todo.status.blocked': '受阻',
  'todo.status.cancelled': '已取消',
  'todo.quadrant': '四象限',
  'todo.quadrant.none': '未分类',
  'todo.quadrant.q1': '重要紧急',
  'todo.quadrant.q2': '重要不紧急',
  'todo.quadrant.q3': '紧急不重要',
  'todo.quadrant.q4': '不重要不紧急',
  'todo.empty': '（暂无待办，添加一条吧）',
  'memoryTab.cwd': '当前会话工作目录',
  'memoryTab.loading': '加载中…',
  'memoryTab.warning': '以下文件为 § 分隔的结构化记忆，用系统工具打开后请谨慎编辑，随意修改可能破坏格式、导致记忆读取错乱。',
  'memoryTab.readonly': '只读',
  'memoryTab.open': '打开文件',
  'memoryTab.opened': '已用系统工具打开',
  'memoryTab.empty': '（文件不存在或为空）',
  'memoryTab.noCwd': '（当前会话无工作目录，无法定位项目记忆）',
  'memoryTab.truncated': '（内容过长，已截断显示）',
  'memoryTab.viewPretty': '美观视图',
  'memoryTab.viewRaw': '纯文本视图',
  'memoryTab.searchPlaceholder': '搜索内容、时间或标签…',
  'memoryTab.noResults': '没有匹配的条目，换个关键词试试。',
  'memoryTab.projectTag': '项目标签',
  'memoryTab.entryCount': '{count} 条',
  'memoryTab.keyAddHelp': '手动添加一条长期有效的项目事实（约定/决策/架构/踩坑），保存后写入 KEY.md，下一轮自动注入上下文。',
  'memoryTab.keyAddPlaceholder': '输入一条项目重要记忆，例如：本项目约定使用 pnpm workspaces…',
  'memoryTab.keyAdd': '保存',
  'memoryTab.keyAdded': '已写入项目关键记忆，下一轮将注入上下文',
  'memoryTab.delete': '删除',
  'memoryTab.deleteConfirm': '确定删除这条记忆？删除后不可恢复。\n\n{snippet}',
  'memoryTab.deleted': '已删除该条目',
  'memoryTab.edit': '编辑',
  'memoryTab.save': '保存',
  'memoryTab.cancel': '取消',
  'memoryTab.updated': '已更新该条目',
  'memoryTab.editHint': '只能修改内容：时间戳与分支等标记由程序维护，不能改动；分隔符 § 不可输入。',
  'memoryTab.editConfirm': '这条记忆保存后会立即注入会话上下文（进入后续模型的提示词），确定保存？\n\n{snippet}',
  'memoryTab.archive': '归档',
  'memoryTab.archiveConfirm': '归档这条记忆？将从主记忆移入归档文件，不再注入会话；需要时可随时移回。\n\n{snippet}',
  'memoryTab.archived': '已归档（不再注入，可随时移回）',
  'memoryTab.promote': '移回主记忆',
  'memoryTab.promoted': '已移回主记忆（重新注入会话）',
  'memoryTab.keyScope': '分支范围',
  'memoryTab.keyScopeLabel': '分支',
  'memoryTab.keyScopeAll': '全部',
  'memoryTab.keyScopeAllHint': '全部 = 所有分支可见',
  'memoryTab.keyScopeAllWeight': '（勾选后清空分支选择）',
  'memoryTab.keyScopeHint': '点击修改分支范围',
  'memoryTab.keyScopeSaved': '分支范围已更新',
  'memoryTab.keyScopeSave': '保存',
  'memoryTab.keyScopeCancel': '取消',
  'memoryTab.keyBranchInfo': '当前分支：{branch}，仅注入无标记或含该分支的条目',
  'memoryTab.gitBranch': '该条记录所属的 git 分支',
  'memoryTab.desc.project': '项目日志：每回合收尾自动记录本回合进展；不注入上下文，模型按需读取。',
  'memoryTab.desc.key': '项目关键记忆：长期约定/决策/踩坑，自动注入当前项目会话；按重要性写入，可手动添加或删除。',
  'memoryTab.desc.daily': '今日日志：按天分文件的流水记录，程序自动标注项目标签；不注入上下文，模型按需读取。',
  'memoryTab.desc.user': '用户档案：用户偏好与习惯，注入所有会话；写入需审查建议并经确认。',
  'memoryTab.desc.memory': '长期记忆：全局环境与项目事实，注入所有会话；写入需审查建议并经确认。',
  'memoryTab.desc.archive-user': '归档用户：不够格进主记忆的用户事实，不注入任何会话；可移回主记忆或删除。',
  'memoryTab.desc.archive-memory': '归档记忆：不够格进主记忆的全局事实，不注入任何会话；可移回主记忆或删除。',
  'memoryTab.desc.archive-key': '项目关键记忆归档：不够格进主记忆（或需暂停注入）的项目事实，不注入任何会话；可移回主记忆或删除。',
  'memoryTab.desc.agents': '全局规则：跨会话生效的用户规则（AGENTS.md），随系统提示词注入。',
  'panel.suggestions.title': '待确认记忆建议',
  'panel.suggestions.empty': '没有待确认的建议。',
  'panel.suggestions.help': '后台审查产出的全局记忆建议：采纳后写入记忆文件并随快照注入；归档保留备查（不注入）；拒绝丢弃。',
  'panel.todoSuggestions.title': '待确认待办建议',
  'panel.todoSuggestions.empty': '没有待确认的待办建议。',
  'panel.todoSuggestions.help': '后台审查产出的待办建议：采纳后写入对应待办轨（待办不能变成记忆）；归档保留备查；拒绝丢弃。',
  'panel.guide.title': '使用指南',
  'panel.guide.intro': 'memory_evolve 是「记忆与自我进化」能力集合：让 AI 把对话沉淀为长期记忆、待办和技能——越用越懂你，跨会话不丢上下文。',
  'panel.guide.memory.title': '记忆读写（memory 工具）',
  'panel.guide.memory.desc': '五轨记忆：长期记忆（全局）、用户档案、项目关键记忆（自动注入，且按 git 分支过滤——只有当前分支相关的关键记忆进入 AI 上下文）、项目日志、今日日志。换项目/隔天继续时直接问 AI，它查记忆衔接，不用你复述。',
  'panel.guide.review.title': '记忆审查（自动进化）',
  'panel.guide.review.desc': '每隔 N 轮 AI 自动提炼值得记住的信息，提交到「待确认记忆建议」由你确认后生效——AI 不会擅自往记忆里写东西。',
  'panel.guide.todo.title': '待办管理（dtodo）',
  'panel.guide.todo.desc': '对 AI 说"记住/我要做 X"即落成结构化待办（自动分生活/工作/项目/每日，可设重要紧急与截止），到期 AI 会提醒你；AI 自建的待办先进「待确认待办建议」等你确认。',
  'panel.guide.skill.title': '技能沉淀（skill_manage）',
  'panel.guide.skill.desc': '反复踩坑的方法论可固化为技能，同类任务下次直接按流程执行，不用重新摸索。创建保持克制，只建高复用价值的；技能库可在「技能管理」里浏览、搜索并一键启用/禁用（禁用后 AI 不再加载）。',
  'panel.guide.search.title': '本地搜索（memory_evolve_search_local_files）',
  'panel.guide.search.desc': '记忆里没有、要找本地资料时，AI 可按文件名搜索——不止文档，图片/代码/配置等一切与项目相关的文件都能找（默认只搜文档扩展名，需要时可显式全类型搜索）。',
  'panel.guide.confirm.title': '确认制（为什么 AI 不能直接写）',
  'panel.guide.confirm.desc': 'AI 自建的记忆、待办、技能都先进待确认队列，等你确认才生效。因为这些写入会真实改变 AI 的行为：记忆会进入上下文、待办是给你派的活、技能会改变 AI 的能力库——如果 AI 擅自写入，可能把它的误判当事实沉淀、或自作主张给你派活。你是最终把关者：AI 只提议，你决定。',
  'panel.guide.best.title': '怎么用得最好',
  'panel.guide.best.1': '跨会话衔接：项目约定/进展直接说"查一下记忆"，AI 从项目日志与关键记忆里接续，不重复交代。',
  'panel.guide.best.2': '口头即记：想到什么就说"记住这个 / 这个要跟进"，AI 自动分类沉淀；隔几天回来说一句就能接上。',
  'panel.guide.best.3': '定期确认：偶尔看看「待确认记忆建议」「待确认待办建议」两个 tab，采纳或拒绝——这是记忆进化的确认环节。',
  'panel.guide.loop': '闭环：聊 → 记 → 审查 → 沉淀 → 执行。这套机制就是 AI 的长期工作记忆。',
  'panel.suggestions.approve': '采纳',
  'panel.suggestions.archive': '归档',
  'panel.suggestions.archiveHint': '归档：不注入会话，仅保留备查，需要时可移回主记忆',
  'panel.suggestions.editHint': '采纳前可修改文本，修改后的内容将写入记忆。',
  'panel.suggestions.reject': '拒绝',
  'panel.suggestions.approveAll': '全部采纳',
  'panel.suggestions.rejectAll': '全部拒绝',
  'panel.suggestions.hits': '已建议 {count} 次',
  'panel.suggestions.hitsHint': '该内容在多轮审查中反复出现，值得认真确认',
  'panel.suggestions.target.memory': '长期记忆',
  'panel.suggestions.target.user': '用户档案',
  'panel.suggestions.target.key': '项目关键记忆',
  'panel.suggestions.targetHint': '采纳时写入的轨：默认=AI 推荐的分类；可改为更合适的（记忆/用户档案/项目关键记忆都会立即注入上下文）',
  'panel.suggestions.done': '操作完成：{text}',
  'panel.archive.title': '已归档记忆',
  'panel.archive.empty': '暂无归档条目',
  'panel.archive.help': '归档的建议不会注入会话，仅在此保留备查——需要时可「移回主记忆」（写入对应记忆文件）或「删除」。',
  'panel.archive.promote': '移回主记忆',
  'panel.archive.delete': '删除',
  'panel.archive.promoted': '已移回主记忆',
  'panel.archive.deleted': '已删除归档条目',
  'panel.skills.title': '待确认技能建议',
  'panel.skills.help': '后台审查产出的新技能，采纳后移入技能库（~/.agents/skills）并随系统提示词注入。',
  'panel.skills.empty': '没有待确认的技能建议。',
  'panel.skills.pending': '待采纳',
  'panel.skills.approve': '采纳',
  'panel.skills.reject': '拒绝',
  'panel.skills.done': '已{op}技能',
  'panel.config.title': '运行时配置',
  'panel.config.help': '修改立即生效并持久化（覆盖 config.yaml 的对应项）。',
  'panel.config.reviewEnabled': '后台审查',
  'panel.config.reviewEnabled.hint': '自动回顾会话并沉淀经验；关闭后 memory/skill 工具与记忆快照仍可用，只是不再自动审查',
  'panel.config.reviewInterval': '审查间隔（回合）',
  'panel.config.reviewInterval.hint': '每 N 个用户回合自动审查一次',
  'panel.config.skillReviewEnabled': '技能自动沉淀',
  'panel.config.skillReviewEnabled.hint': '关（默认）：审查创建的新技能进入待确认队列，采纳后才进入技能库；开：审查直接创建技能，无需确认（技能注入所有会话，请谨慎开启）',
  'panel.config.perTurnProjectWrites': '每回合写入项目记忆',
  'panel.config.perTurnProjectWrites.hint': '要求模型每个回合结束前主动检查并记录项目相关新事实（关键决策/进展/踩坑）；关闭后项目记忆仅按需读取。⚠️ 依赖 LLM 指令遵循，弱遵循的模型不一定会执行',
  'panel.config.perTurnDailyWrites': '每回合写入每日日志',
  'panel.config.perTurnDailyWrites.hint': '要求模型每个回合结束前主动检查并记录当天进展；关闭后每日日志仅按需读取。⚠️ 依赖 LLM 指令遵循，弱遵循的模型不一定会执行',
  'panel.config.perTurnKeyWrites': '每回合检查项目关键记忆',
  'panel.config.perTurnKeyWrites.hint': '要求模型每个回合结束前判断是否出现重要项目事实（长期约定/决策/架构/踩坑），有则写入 target=key（自动注入上下文），没有就跳过；关闭后 key 仅保留手动添加与读取。⚠️ 依赖 LLM 指令遵循',
  'panel.config.searchDocsEnabled': '本地文件搜索工具',
  'panel.config.searchDocsEnabled.hint': '启用 memory_evolve_search_local_files：让模型能在本机所有磁盘/目录中按文件名搜索文件（默认只搜文档 md/docx/pdf…；全类型/文件夹需显式参数确认；只匹配文件名不读内容）。默认关闭；关闭时工具对模型完全不可见',
  'panel.config.save': '保存配置',
  'panel.reveal.title': '打开文件',
  'panel.reveal.help': '用系统工具打开记忆目录与记忆文件。⚠️ 随意编辑可能破坏 § 分隔格式、导致记忆读取错乱，请谨慎修改。',
  'panel.reveal.memoryDir': '记忆目录',
  'panel.reveal.memoryFile': '全局记忆',
  'panel.reveal.userFile': '用户档案',
  'panel.reveal.archiveMemoryFile': '归档记忆',
  'panel.reveal.archiveUserFile': '归档用户',
  'panel.reveal.dailyDir': '每日日志目录',
  'panel.reveal.dailyFile': '今日日志',
  'panel.reveal.projectsDir': '项目记忆目录',
  'panel.reveal.skillDir': '技能目录',
  'panel.reveal.agentsFile': '全局规则 (AGENTS.md)',
  'panel.config.saved': '配置已保存并生效',
  'panel.config.failed': '操作失败：{message}',
  'panel.loading': '加载中…',
}

/** English dictionary (same key set). */
export const en: Record<MemoryEvolveKey, string> = {
  'tab.label': 'Skill Manager',
  'tab.label.alt': 'Skill Manager',
  'header.title': 'Skill Manager',
  'header.subtitle': 'Manage every skill · custom dirs · enable/disable · view & edit',
  'search.placeholder': 'Search skills by name, description, or when-to-use…',
  'search.empty': 'No matching skills',
  'filter.all': 'All',
  'status.enabled': 'Enabled',
  'disable': 'Disable',
  'enable': 'Enable',
  'disabled.badge': 'Disabled',
  'disabled.hint': 'Disabled: excluded from the model skill catalog',
  'protected.badge': 'System',
  'protected.hint': 'System skill (project source) — cannot be disabled',
  'toggle.failed': 'Toggle failed: {message}',
  'manage.dirs': 'Manage custom skill directories',
  'dirs.title': 'Custom Skill Directories',
  'dirs.help': 'Add directories containing skills (<dir>/<skill>/SKILL.md or <dir>/<skill>.md layouts). Directories persist in the plugin state.json and reload automatically after restart; paths overlapping an existing skill root are rejected.',
  'dirs.placeholder': 'Absolute path, e.g. ~/.hermes/skills/…',
  'dirs.add': 'Add',
  'dirs.remove': 'Remove',
  'dirs.empty': 'No custom directories yet',
  'dirs.missing': 'Directory missing',
  'pager.prev': 'Prev',
  'pager.next': 'Next',
  'pager.page': 'Page {page} / {total}',
  'skills.count': '{count} skills',
  'roots.count': '{count} roots',
  'pane.skills': 'Skills',
  'pane.files': 'Files',
  'pane.editor': 'Editor',
  'no.skill.selected': 'Select a skill on the left to start browsing',
  'no.root': 'This skill has no browsable local directory',
  'no.entries': 'Empty directory',
  'no.file': 'Select a text file to view or edit',
  'not.text': 'Not a text file — cannot preview',
  'too.large': 'File exceeds the 512 KiB read cap',
  'read.failed': 'Read failed: {message}',
  'write.failed': 'Save failed: {message}',
  'save': 'Save',
  'saving': 'Saving…',
  'saved': 'Saved',
  'edit': 'Edit',
  'cancel': 'Cancel',
  'discard': 'Discard',
  'dirty.hint': 'Unsaved changes',
  'readonly': 'Read-only',
  'bytes': '{size} B',
  'kib': '{size} KiB',
  'mib': '{size} MiB',
  'dir.up': 'Parent directory',
  'open.folder': 'Open directory',
  'source.badge': '{source}',
  'invocable': 'Invocable',
  'when.to.use': 'When to use',
  'description': 'Description',
  'resource.directory': 'Directory',
  'resource.url': 'Link',
  'resource.opaque': 'Resource',
  'refresh': 'Refresh',
  'loading.skills': 'Loading skills…',
  'loading.dir': 'Loading…',
  'tree.collapse': 'Collapse',
  'tree.expand': 'Expand',
  'path': 'Path',
  'root.label': 'Root',
  'editor.placeholder': 'Select a text file in the tree on the left to start editing.',
  'status.ready': 'Ready',
  'status.skill': 'Skill',
  'status.file': 'File',
  'status.unsaved': 'Unsaved',
  'status.saved': 'Saved',
  'confirm.discard.title': 'Discard unsaved changes?',
  'confirm.discard.body': 'Your changes to {name} are not saved. Switching files will lose them.',
  'confirm.discard.ok': 'Discard changes',
  'mtime.label': 'Modified {time}',
  'open.in.new.tab': 'Open in new tab',
  'preview': 'Preview',
  'memoryTab.label': 'Memory, Skills & Todos',
  'memoryTab.label.pending': '🔴 Memory, Skills & Todos ({count})',
  'memoryTab.feature.guide': 'Guide',
  'memoryTab.feature.suggestions': 'Memory suggestions',
  'memoryTab.feature.todoSuggestions': 'Todo suggestions',
  'memoryTab.feature.skills': 'Skill suggestions',
  'memoryTab.feature.config': 'Runtime config',
  'memoryTab.feature.skillBrowser': 'Skill manager',
  'memoryTab.feature.todo': 'Todos',
  'todo.track.life': 'Life',
  'todo.track.all': 'All',
  'todo.track': 'Track',
  'todo.track.work': 'Work',
  'todo.track.project': 'This project',
  'todo.track.daily': 'Today',
  'todo.track.past': 'Past',
  'todo.projectHint': 'No working directory for this session — project todos unavailable (life/work/today only).',
  'todo.help': 'Four tracks: Life=personal errands; Work=cross-project tasks; This project=the current working directory\'s todos (invisible from other dirs); Today=today\'s tasks (one file per day). Past daily todos (earlier days) are not loaded by default — open the “Past” tab or tick “Show expired” to query history (expired leftovers stay hidden until then). To add: type content, optionally pick a quadrant (important × urgent) and a due date, then hit Add — or just tell me “add a todo, it\'s for work/life/this project/today” and I will file it in the right track.',
  'todo.showExpired': 'Show expired',
  'todo.pastHint': 'Past daily todos are mostly expired leftovers and are hidden by default; tick “Show expired” to view them.',
  'todo.addPlaceholder': 'Type a todo (multi-line ok), pick quadrant/due, add…',
  'todo.add': 'Add',
  'todo.added': 'Todo added',
  'todo.done': 'Done',
  'todo.undone': 'Restore',
  'todo.edit': 'Edit',
  'todo.save': 'Save',
  'todo.cancel': 'Cancel',
  'todo.updated': 'Updated',
  'todo.deleted': 'Deleted',
  'todo.deleteConfirm': 'Delete this todo? This cannot be undone.\n\n{snippet}',
  'todo.due': 'Due',
  'todo.overdue': 'Overdue',
  'todo.all': 'All',
  'todo.filterStatus': 'Status',
  'todo.filterQuadrant': 'Quadrant',
  'todo.status.active': 'Active',
  'todo.status.pending': 'Pending',
  'todo.status.doing': 'Doing',
  'todo.status.done': 'Done',
  'todo.status.blocked': 'Blocked',
  'todo.status.cancelled': 'Cancelled',
  'todo.quadrant': 'Quadrant',
  'todo.quadrant.none': 'Unclassified',
  'todo.quadrant.q1': 'Important & urgent',
  'todo.quadrant.q2': 'Important, not urgent',
  'todo.quadrant.q3': 'Urgent, not important',
  'todo.quadrant.q4': 'Neither',
  'todo.empty': '(No todos yet — add one)',
  'memoryTab.cwd': 'Session working directory',
  'memoryTab.loading': 'Loading…',
  'memoryTab.warning': 'These files are §-delimited structured memory. If you open them with a system tool, edit with caution — careless changes can break the format and corrupt memory reads.',
  'memoryTab.readonly': 'Read-only',
  'memoryTab.open': 'Open file',
  'memoryTab.opened': 'Opened with the system tool',
  'memoryTab.empty': '(missing or empty)',
  'memoryTab.noCwd': '(no working directory for this session — project memory unavailable)',
  'memoryTab.truncated': '(content truncated for display)',
  'memoryTab.viewPretty': 'Pretty view',
  'memoryTab.viewRaw': 'Raw text',
  'memoryTab.searchPlaceholder': 'Search content, time or tag…',
  'memoryTab.noResults': 'No matching entries — try another keyword.',
  'memoryTab.projectTag': 'Project tag',
  'memoryTab.entryCount': '{count} entries',
  'memoryTab.keyAddHelp': 'Manually add a durable project fact (convention/decision/architecture/pitfall); it is written to KEY.md and injected into the context from the next turn on.',
  'memoryTab.keyAddPlaceholder': 'Type a key project fact, e.g. this project uses pnpm workspaces…',
  'memoryTab.keyAdd': 'Save',
  'memoryTab.keyAdded': 'Key fact saved — it will be injected from the next turn',
  'memoryTab.delete': 'Delete',
  'memoryTab.deleteConfirm': 'Delete this memory entry? This cannot be undone.\n\n{snippet}',
  'memoryTab.deleted': 'Entry deleted',
  'memoryTab.edit': 'Edit',
  'memoryTab.save': 'Save',
  'memoryTab.cancel': 'Cancel',
  'memoryTab.updated': 'Entry updated',
  'memoryTab.editHint': 'Content only: timestamps and branch tags are program-maintained and cannot be changed; the § delimiter cannot be typed.',
  'memoryTab.editConfirm': 'This entry is injected into the session context (the model\'s prompt) right after saving. Save anyway?\n\n{snippet}',
  'memoryTab.archive': 'Archive',
  'memoryTab.archiveConfirm': 'Archive this entry? It leaves the main memory (no longer injected) and can be promoted back any time.\n\n{snippet}',
  'memoryTab.archived': 'Archived (no longer injected; can be promoted back)',
  'memoryTab.promote': 'Promote to memory',
  'memoryTab.promoted': 'Promoted back into the main memory',
  'memoryTab.keyScope': 'Branch scope',
  'memoryTab.keyScopeLabel': 'Branch',
  'memoryTab.keyScopeAll': 'All branches',
  'memoryTab.keyScopeAllHint': 'All branches = visible everywhere',
  'memoryTab.keyScopeAllWeight': '(checking it clears branch picks)',
  'memoryTab.keyScopeHint': 'Click to change the branch scope',
  'memoryTab.keyScopeSaved': 'Branch scope updated',
  'memoryTab.keyScopeSave': 'Save',
  'memoryTab.keyScopeCancel': 'Cancel',
  'memoryTab.keyBranchInfo': 'current branch: {branch} — only untagged entries or entries covering this branch are injected',
  'memoryTab.gitBranch': 'The git branch this record belongs to',
  'memoryTab.desc.project': 'Project log: auto-recorded per turn; never injected, read on demand by the model.',
  'memoryTab.desc.key': 'Key project facts: conventions/decisions/pitfalls, injected into this project\'s sessions; written when important, addable/deletable manually.',
  'memoryTab.desc.daily': 'Daily log: per-day progress records with program-tagged project labels; never injected, read on demand.',
  'memoryTab.desc.user': 'User profile: preferences and habits, injected into every session; writes need review + confirmation.',
  'memoryTab.desc.memory': 'Long-term memory: global environment/project facts, injected into every session; writes need review + confirmation.',
  'memoryTab.desc.archive-user': 'Archived user facts: not good enough for the main track, never injected; can be promoted back or deleted.',
  'memoryTab.desc.archive-memory': 'Archived memory facts: not good enough for the main track, never injected; can be promoted back or deleted.',
  'memoryTab.desc.archive-key': 'Archived key project facts: not good enough for the main track (or paused from injection), never injected; can be promoted back or deleted.',
  'memoryTab.desc.agents': 'Global rules: cross-session user rules (AGENTS.md), injected with the system prompt.',
  'panel.suggestions.title': 'Pending memory suggestions',
  'panel.suggestions.empty': 'No pending suggestions.',
  'panel.suggestions.help': 'Global-track suggestions produced by the background review: approve writes them into the memory files (injected with the snapshot); archive keeps them aside (never injected); reject drops them.',
  'panel.todoSuggestions.title': 'Pending todo suggestions',
  'panel.todoSuggestions.empty': 'No pending todo suggestions.',
  'panel.todoSuggestions.help': 'Todo suggestions from the background review: approve writes into the matching todo track (a todo stays a todo); archive keeps aside; reject drops.',
  'panel.guide.title': 'Guide',
  'panel.guide.intro': 'memory_evolve is a “memory & self-evolution” toolkit: it turns conversations into durable memory, todos and skills — the AI gets to know you better over time and never loses context across sessions.',
  'panel.guide.memory.title': 'Memory read/write (memory tool)',
  'panel.guide.memory.desc': 'Five tracks: global memory, user profile, project key facts (auto-injected and git-branch aware — only key facts relevant to the current branch reach the AI’s context), project log, daily log. When switching projects or resuming later, just ask the AI — it reads the memory and picks up where you left off.',
  'panel.guide.review.title': 'Memory review (self-evolution)',
  'panel.guide.review.desc': 'Every N turns the AI distills what is worth remembering and submits it as a suggestion for your confirmation — it never writes into the memory on its own.',
  'panel.guide.todo.title': 'Todos (dtodo)',
  'panel.guide.todo.desc': 'Just tell the AI “remember / I need to do X” and it becomes a structured todo (auto-sorted into life/work/project/daily, with priority and due date); the AI reminds you when things are due. AI-proposed todos wait in the todo-suggestions tab for your confirmation.',
  'panel.guide.skill.title': 'Skills (skill_manage)',
  'panel.guide.skill.desc': 'Methodologies learned the hard way can be solidified into reusable skills, so the same kind of task runs on a proven process next time. Creation stays restrained: only high-reuse skills; the skill manager lets you browse, search and enable/disable any skill (disabled skills are never loaded by the AI).',
  'panel.guide.search.title': 'Local search (memory_evolve_search_local_files)',
  'panel.guide.search.desc': 'When memory is not enough and local material is needed, the AI can search by file name — not just documents: images, code, configs, anything relevant to the project (documents only by default; full-type search available when explicitly requested).',
  'panel.guide.confirm.title': 'Confirmation (why the AI cannot write directly)',
  'panel.guide.confirm.desc': 'Anything the AI creates — memory, todos, skills — enters a pending queue first and only takes effect after your confirmation. These writes genuinely change the AI: memory enters the prompt, todos are tasks assigned to you, skills change the AI’s toolbox. Unchecked auto-writes could silently enshrine the AI’s misjudgments as facts or assign you work you never asked for. You are the final gatekeeper: the AI proposes, you decide.',
  'panel.guide.best.title': 'Getting the most out of it',
  'panel.guide.best.1': 'Pick up across sessions: say “check the memory” about project conventions/progress — the AI continues from the project log and key facts instead of asking you to repeat.',
  'panel.guide.best.2': 'Dictate as you think: “remember this / follow up on that” — the AI files it automatically; a one-liner days later reconnects the thread.',
  'panel.guide.best.3': 'Confirm periodically: glance at the memory/todo suggestion tabs and adopt or reject — that is the confirmation loop of memory evolution.',
  'panel.guide.loop': 'The loop: talk → remember → review → solidify → execute. This is the AI’s long-term working memory.',
  'panel.suggestions.approve': 'Approve',
  'panel.suggestions.archive': 'Archive',
  'panel.suggestions.archiveHint': 'Archive: kept out of the injected memory, can be promoted back later',
  'panel.suggestions.editHint': 'You may edit the text before approving; the edited text is what gets written.',
  'panel.suggestions.reject': 'Reject',
  'panel.suggestions.approveAll': 'Approve all',
  'panel.suggestions.rejectAll': 'Reject all',
  'panel.suggestions.hits': 'Suggested {count}×',
  'panel.suggestions.hitsHint': 'This fact resurfaced across several reviews — worth a careful look',
  'panel.suggestions.target.memory': 'Memory',
  'panel.suggestions.target.user': 'User profile',
  'panel.suggestions.target.key': 'Project key facts',
  'panel.suggestions.targetHint': 'Track to write on approve: defaults to the AI-recommended one; re-classify if it fits better (memory/user/key are injected into the prompt immediately)',
  'panel.suggestions.done': 'Done: {text}',
  'panel.archive.title': 'Archived memory',
  'panel.archive.empty': 'No archived entries.',
  'panel.archive.help': 'Archived suggestions are never injected; they stay here for later — promote them back into the memory files when they matter, or delete them.',
  'panel.archive.promote': 'Promote to memory',
  'panel.archive.delete': 'Delete',
  'panel.archive.promoted': 'Promoted to memory',
  'panel.archive.deleted': 'Archived entry deleted',
  'panel.skills.title': 'Pending skill suggestions',
  'panel.skills.help': 'New skills produced by background review; approving moves them into the skill library (~/.agents/skills) where they are injected into system prompts.',
  'panel.skills.empty': 'No pending skill suggestions.',
  'panel.skills.pending': 'Pending',
  'panel.skills.approve': 'Approve',
  'panel.skills.reject': 'Reject',
  'panel.skills.done': 'Skill {op}',
  'panel.config.title': 'Runtime config',
  'panel.config.help': 'Changes apply immediately and persist (overriding the config.yaml entries).',
  'panel.config.reviewEnabled': 'Background review',
  'panel.config.reviewEnabled.hint': 'Automatically review sessions and harvest experience; when off, the memory/skill tools and the snapshot still work — only the automatic review stops',
  'panel.config.reviewInterval': 'Review interval (turns)',
  'panel.config.reviewInterval.hint': 'One automatic review per N user turns',
  'panel.config.skillReviewEnabled': 'Skill auto-harvest',
  'panel.config.skillReviewEnabled.hint': 'Off (default): new skills from review go to the pending queue and only install when approved; On: review creates skills directly without confirmation (skills are injected into every session — enable with care)',
  'panel.config.perTurnProjectWrites': 'Per-turn project writes',
  'panel.config.perTurnProjectWrites.hint': 'Require the model to check at the end of every turn and record project-related facts (decisions/progress/pitfalls); when off, project memory is read on demand only. ⚠️ Relies on LLM instruction following — weaker models may not comply',
  'panel.config.perTurnDailyWrites': 'Per-turn daily writes',
  'panel.config.perTurnDailyWrites.hint': 'Require the model to check at the end of every turn and record the day\'s progress; when off, the daily log is read on demand only. ⚠️ Relies on LLM instruction following — weaker models may not comply',
  'panel.config.perTurnKeyWrites': 'Per-turn key-fact check',
  'panel.config.perTurnKeyWrites.hint': 'Require the model to judge at the end of every turn whether an important project fact emerged (long-lived convention/decision/architecture/pitfall); if so, write it to target=key (injected into the context), otherwise skip. When off, key facts are only added manually or read. ⚠️ Relies on LLM instruction following',
  'panel.config.searchDocsEnabled': 'Local file search tool',
  'panel.config.searchDocsEnabled.hint': 'Enable memory_evolve_search_local_files: lets the model search files by name across all local disks/directories (documents md/docx/pdf… by default; all types/folders require explicit parameter confirmation; name matching only, never reads contents). Off by default; when off the tool is completely invisible to the model',
  'panel.config.save': 'Save config',
  'panel.reveal.title': 'Open files',
  'panel.reveal.help': 'Open the memory directories and files with your system tools. ⚠️ Careless edits can break the §-delimited format and corrupt memory reads — edit with caution.',
  'panel.reveal.memoryDir': 'Memory dir',
  'panel.reveal.memoryFile': 'Global memory',
  'panel.reveal.userFile': 'User profile',
  'panel.reveal.archiveMemoryFile': 'Archived memory',
  'panel.reveal.archiveUserFile': 'Archived user',
  'panel.reveal.dailyDir': 'Daily log dir',
  'panel.reveal.dailyFile': 'Today log',
  'panel.reveal.projectsDir': 'Project memory dir',
  'panel.reveal.skillDir': 'Skills dir',
  'panel.reveal.agentsFile': 'Global rules (AGENTS.md)',
  'panel.config.saved': 'Config saved and applied',
  'panel.config.failed': 'Failed: {message}',
  'panel.loading': 'Loading…',
}

/** Badge poll interval (ms). */
const BADGE_POLL_MS = 30_000

/**
 * The plugin entry: register locale and stylesheet, then the session memory
 * tab (default ON) with a red-dot pending count on its label. The former
 * settings-panel section (MemoryPanel) is gone — the tab now hosts the
 * suggestion/skill queues and the runtime config as sub-tabs. 'conversation'
 * is an ordering edge for the session memory tab (its 'conversation.view'
 * slot is declared by ui-conversation).
 * @param ctx - the client plugin context (`slots`, `locale` injected).
 */
export const inject = ['slots', 'locale', 'conversation']

/**
 * Client plugin body: register the session memory tab when the host switch
 * is on (default ON; flipping it in the tab's runtime-config sub-tab takes
 * effect after a page reload).
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS) as unknown as Translate

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'memory-evolve: dictionaries')

  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-memory-evolve-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.memoryEvolveCss = '1'
    tag.textContent = styles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: stylesheet')

  // Skill-browser styles (merged from the standalone dsh-skill-browser
  // plugin): sb- prefixed, injected alongside the panel styles.
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-skill-browser-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.skillBrowserCss = '1'
    tag.textContent = skillBrowserStyles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: skill browser stylesheet')

  // Session memory tab (conversation.view): the ONLY memory-management
  // surface now (the settings-panel section was removed). The label carries
  // a red-dot pending count (🔴 记忆 (N)) while suggestions/skills await
  // confirmation. Upstream 08-06 removed ui-slots' deferRegistration; the
  // replacement is ctx.slots.inject (registers once the slot is declared on
  // the ledger). Badge changes re-register the entry — the register bump
  // notifies subscribers, which re-evaluates the label thunk.
  let tabCancelled = false
  let badgeCount = 0
  let disposeTab: (() => void) | undefined
  const registerTab = (): void => {
    disposeTab?.()
    disposeTab = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: 'memory-files',
        order: 20,
        label: () => (badgeCount > 0 ? t('memoryTab.label.pending', { count: badgeCount }) : t('memoryTab.label')),
      }, (props) => MemoryTabView({ ...props, t })))
  }
  const pollBadge = (): void => {
    if (tabCancelled || disposeTab === undefined) return
    void fetch('/memory-evolve/api/badge')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { count?: number }) => {
        const count = data.count ?? 0
        if (count !== badgeCount) {
          badgeCount = count
          registerTab()
        }
      })
      .catch(() => { /* badge is best-effort; the tab still works */ })
  }

  void fetch('/memory-evolve/api/config')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((data: { config?: { memoryTabEnabled?: boolean } }) => {
      // memoryTabEnabled is a read-only field of /api/config (default true;
      // only config.yaml can turn it off — deliberately NOT a runtime key,
      // since switching it off from inside the tab would hide the tab itself).
      if (tabCancelled || data.config?.memoryTabEnabled !== true) return
      registerTab()
      pollBadge()
      const timer = setInterval(pollBadge, BADGE_POLL_MS)
      ctx.effect(() => () => clearInterval(timer), 'memory-evolve: memory tab badge poller')
      // The tab's own queue actions (approve/archive/reject skills too) fire
      // this event after a mutation — re-poll immediately so the red-dot
      // label updates without waiting for the next 30s poll.
      const onTabChanged = (): void => pollBadge()
      window.addEventListener('dsh-memory-evolve:badge-change', onTabChanged)
      ctx.effect(() => () => window.removeEventListener('dsh-memory-evolve:badge-change', onTabChanged), 'memory-evolve: memory tab badge listener')
    })
    .catch(() => { /* the tab is optional; a failure just leaves it hidden */ })
  ctx.effect(() => () => {
    tabCancelled = true
    disposeTab?.()
  }, 'memory-evolve: memory tab')
}
