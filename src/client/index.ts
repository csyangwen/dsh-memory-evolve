/**
 * dsh-memory-evolve — client entry.
 *
 * Registers three session tabs ('conversation.view') — the ONLY
 * memory-management surface (the former settings-panel section was
 * removed):
 *   - 记忆 tab（memory-files）：记忆文件 + 记忆专属指南 + 待确认记忆建议
 *   - 技能 tab（skills-hub）：待确认技能建议 + 技能管理（SkillsBrowser）
 *   - 待办 tab（todos-hub）：待确认待办建议 + 四轨待办（TodoView）
 * plus the optional COI 调度 / 提示词注入 / 临时信息 tabs, all backed by
 * the node half's /memory-evolve/api routes. Each tab label carries a
 * red-dot pending count (🔴 记忆 (N) / 🔴 技能 (N) / 🔴 待办 (N)) while
 * suggestions/skills/todos await confirmation, refreshed by polling the
 * badge endpoint and re-registering through the deferral handle's
 * refresh().
 */
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row lives in ui-conversation.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { MemoryTabView } from './MemoryTabView.tsx'
import { SkillsTabView } from './SkillsTabView.tsx'
import { TodosTabView } from './TodosTabView.tsx'
import { SettingsTabView } from './SettingsTabView.tsx'
import { ModelsTabView } from './ModelsTabView.tsx'
import { UiSettingsTabView } from './UiSettingsView.tsx'
import { CoIView } from './CoIView.tsx'
import { HeaderActions } from './HeaderActions.tsx'
import { BroadcastView } from './BroadcastView.tsx'
import { ScratchView } from './ScratchView.tsx'
import { PromptView } from './PromptView.tsx'
import { BookmarksView } from './BookmarksView.tsx'
import { createBookmarkInjector } from './bookmark-injector.tsx'
import { createSessionFilter } from './session-filter.ts'
import { createWideBubble, createWideChat } from './wide-chat.ts'
import { FEATURES_EVENT, readFeatures } from './ui-settings-features.ts'
import styles from './styles.css'
import coiStyles from './coi-styles.css'
import scratchStyles from './scratch-styles.css'
import promptStyles from './prompt-styles.css'
import broadcastStyles from './broadcast-styles.css'
import skillBrowserStyles from './skills-browser/styles.css'
import uiSettingsStyles from './ui-settings-styles.css'
import bookmarkStyles from './bookmark-styles.css'

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
  'memoryTab.label': '记忆',
  'memoryTab.label.pending': '🔴 记忆 ({count})',
  'skillsTab.label': '技能',
  'skillsTab.label.pending': '🔴 技能 ({count})',
  'todosTab.label': '待办',
  'todosTab.label.pending': '🔴 待办 ({count})',
  'coiTab.label': 'COI调度',
  'coiTab.label.pending': '🔴 COI调度 ({count})',
  'broadcastTab.label': '会话广播',
  'broadcast.tab.guide': '指南',
  'broadcast.tab.messages': '消息',
  'broadcast.tab.rooms': '房间',
  'broadcast.tab.settings': '设置',
  'broadcast.settings.wsCoord.title': '工作区协调（ws-coord）',
  'broadcast.settings.wsCoord.desc': '同工作区多会话并行时的资源占用协调——声明要改的文件（de_ws_declare）、写后自动登记占用、写前冲突检测（软模式警告 / 硬拦截可切换）、de_ws_status 查看"谁在跑、在干什么"。以下开关只控制本子功能；「会话广播」大开关在「Memory Evolve 设置」→「配置」里。',
  'broadcast.settings.wsCoord.enabled': '启用工作区协调',
  'broadcast.settings.wsCoord.enabled.hint': '注册 de_ws_declare / de_ws_status / de_ws_release 工具 + 写前冲突检测事件监听 + 活动感知快照段。依赖「会话广播」大开关（广播关闭时本功能不可用）。默认关闭',
  'broadcast.settings.wsCoord.snapshot': '活动快照段',
  'broadcast.settings.wsCoord.snapshot.hint': '工作区活跃会话 ≥2 时，每回合快照注入一行【工作区活动】（带当前时间，含各会话在做什么）；0~1 个会话时零开销',
  'broadcast.settings.wsCoord.enforce': '硬拦截模式',
  'broadcast.settings.wsCoord.enforce.hint': '默认关（软模式：先信任 AI，冲突只警告不拦截）；打开后升级为硬拦截——写入他人占用中的文件会被工具层直接拒绝（deny），AI 看到拒绝原因自主调整',
  'broadcast.guide.intro.title': '会话广播是什么',
  'broadcast.guide.intro.body': '会话广播 = DSH 会话之间的消息通道：给其他会话发消息（AI 用 de_broadcast send 发送），对方下次生成前快照自动出现「会话广播」提示；消息按收件箱管理——主题 + 简介，全员已读后自动删除。',
  'broadcast.guide.send.title': '怎么发消息',
  'broadcast.guide.send.body': '直接对 AI 说「给 XX 会话发广播…」即可（默认一对一，收件人=对方的会话 ID）：',
  'broadcast.guide.send.item1': '一对一：指定接收方会话 ID（把「复制会话 ID」的结果发给对方，对方 AI 就能给你发）；',
  'broadcast.guide.send.item2': '房间：多人聊天室，跨工作目录，成员都能看到（发送给 room:<房间id>）；',
  'broadcast.guide.send.item3': '项目：该工作目录内所有会话可见（发送给 project:/绝对路径）。',
  'broadcast.guide.inbox.title': '收件箱（消息页）',
  'broadcast.guide.inbox.body': '消息列表默认只看**未读**的非房间消息（已读自动隐藏；房间消息进对应房间查看）：',
  'broadcast.guide.inbox.item1': '筛选：未读 / 全部 / 已读；搜索主题、发件人、内容；分页 20 条/页；',
  'broadcast.guide.inbox.item2': '点「展开全文」看完整内容；红色「删除」= 超管删除（对所有人不可见）；',
  'broadcast.guide.inbox.item3': '一对一消息全部接收方已读后自动删除（已消费，不占列表）。',
  'broadcast.guide.room.title': '房间页',
  'broadcast.guide.room.body': '房间 = 多人协作聊天室：',
  'broadcast.guide.room.item1': '展开房间看成员在线状态：🟢 running=正在生成（可等它/它回合内可见），⚪ idle/unknown=已结束回合或未记录（不要傻等）；',
  'broadcast.guide.room.item2': '房间消息与收件箱同款筛选/搜索/分页；创建者可踢人、解散房间（触发系统通知）；',
  'broadcast.guide.room.item3': '已解散房间保留记录可追溯，成员不能再加入/发消息。',
  'broadcast.guide.alias.title': '会话别名',
  'broadcast.guide.alias.body': '给会话设置友好名（≤10 字）——快照、列表、消息里都显示别名（短ID），一眼认出是谁：',
  'broadcast.guide.alias.item1': '顶部「我的会话」行：复制会话 ID / 复制别名，把结果发给对方就能开聊；',
  'broadcast.guide.alias.item2': '会话页右上角 ⧉ 复制会话ID / ✎ 别名 按钮也可设置。',
  'broadcast.guide.switch.title': '开关',
  'broadcast.guide.switch.body': '会话广播默认关闭：在「设置」Tab 的「配置」里打开「会话广播」开关，刷新后本 Tab 出现。',
  'broadcast.mySessionId': '我的会话 ID',
  'broadcast.copyId': '复制',
  'broadcast.copied': '已复制',
  'broadcast.loading': '加载中…',
  'broadcast.refresh': '刷新',
  'broadcast.messages.empty': '（暂无消息）',
  'broadcast.messages.sender': '来自',
  'broadcast.messages.to': '收件人',
  'broadcast.messages.direct': '私信',
  'broadcast.messages.room': '房间',
  'broadcast.messages.project': '项目',
  'broadcast.messages.unread': '未读',
  'broadcast.messages.long': '长内容',
  'broadcast.message.expand': '展开全文',
  'broadcast.message.collapse': '收起',
  'broadcast.message.delete': '删除',
  'broadcast.message.deleteConfirm': '删除这条消息？（超管操作，消息对所有人不可见）\n\n{subject}',
  'broadcast.message.deleted': '已删除',
  'broadcast.copyAlias': '复制别名',
  'broadcast.msg.unread': '未读',
  'broadcast.msg.read': '已读',
  'broadcast.filter.unread': '未读',
  'broadcast.filter.all': '全部',
  'broadcast.filter.read': '已读',
  'broadcast.searchPh': '搜索主题/发件人/内容…',
  'broadcast.pagePrev': '上一页',
  'broadcast.pageNext': '下一页',
  'broadcast.pageInfo': '{page}/{total} 页',
  'broadcast.room.detail': '详情',
  'broadcast.room.messages': '房间消息',
  'broadcast.room.messages.empty': '（暂无房间消息）',
  'broadcast.messages.roomInRooms': '房间消息请在「房间」页进入对应房间查看',
  'broadcast.rooms.empty': '（暂无房间）',
  'broadcast.roomSearchPh': '搜索房间名…',
  'broadcast.roomStatus.all': '全部',
  'broadcast.roomStatus.active': '活跃',
  'broadcast.roomStatus.dissolved': '已解散',
  'broadcast.roomDays.0': '全部时间',
  'broadcast.roomDays.7': '最近7天',
  'broadcast.roomDays.30': '最近30天',
  'broadcast.room.status.active': '活跃',
  'broadcast.room.status.idle': '空闲',
  'broadcast.room.status.dissolved': '已解散',
  'broadcast.room.online': '{online}/{total} 在线',
  'broadcast.room.members': '成员',
  'broadcast.room.kick': '踢出',
  'broadcast.room.kickConfirm': '踢出成员 {member}？（将发送系统通知，该会话失去房间访问）',
  'broadcast.room.dissolve': '解散',
  'broadcast.room.dissolveConfirm': '解散房间「{name}」？（软删除：记录保留可追溯，成员收到系统通知，之后无法加入/发消息）',
  'broadcast.room.dissolved': '已解散',
  'broadcast.room.copyId': '复制房间 id',
  'broadcast.room.lastActive': '最后活动',
  'broadcast.room.created': '创建于',
  'broadcast.room.presence.unknown': 'unknown · 无活动记录',
  'header.copySessionId': '⧉ 复制会话ID',
  'header.copySessionId.done': '✓ 已复制',
  'header.copySessionId.title': '复制当前会话 ID（发给其他会话：告诉对方 AI 你的会话 ID，让它用 de_broadcast 给你发广播）',
  'header.setAlias': '✎ 别名',
  'header.setAlias.title': '设置会话别名（≤10 字）——快照/广播面板/消息中显示为你的友好名称',
  'header.setAlias.placeholder': '输入别名（≤10 字）',
  'header.setAlias.save': '保存',
  'header.setAlias.clear': '清除',
  'header.setAlias.saved': '别名已保存',
  'header.setAlias.cleared': '别名已清除',
  'scratchTab.label': '临时信息',
  'promptTab.label': '提示词注入',
  'promptTab.label.active': '🔴 提示词注入 ({count})',
  'settingsTab.label': 'Memory Evolve 设置',
  'settingsTab.feature.guide': '指南',
  'settingsTab.feature.config': '配置',
  'memoryTab.feature.guide': '指南',
  'memoryTab.feature.suggestions': '待确认记忆建议',
  'skillsTab.feature.guide': '指南',
  'skillsTab.feature.skills': '待确认技能建议',
  'skillsTab.feature.skillBrowser': '技能管理',
  'todosTab.feature.guide': '指南',
  'todosTab.feature.todoSuggestions': '待确认待办管理',
  'todosTab.feature.todo': '待办',
  // 模型配置 Tab（models-hub）：表格展示 DSH 供应商/模型 + 每模型
  // 启用/备注/可用思考等级配置（对应 de_models 工具的 Web 数据面）：
  'modelsTab.label': '模型配置',
  'modelsTab.feature.models': '模型配置',
  'modelsTab.feature.guide': '指南',
  'modelsTab.guide.what.title': '模型配置是什么',
  'modelsTab.guide.what.body': '以表格形式一览 DSH 的全部供应商与模型，并为每个模型维护插件侧配置（启用状态、备注、思考等级）——所有配置归属本插件（models.json），不修改 DSH 配置、不与其他插件耦合。',
  'modelsTab.guide.what.item1': '表格列：启用开关、供应商（含 DSH 激活状态）、模型（名称 + ID）、上下文/输出容量、思考等级、备注；支持搜索与「显示思考等级」切换；',
  'modelsTab.guide.what.item2': '每模型可设置：启用/禁用（插件口径的可用性标记，不改变 DSH 实际路由）、备注、是否支持思考、可用思考等级、推荐思考等级、自定义等级；',
  'modelsTab.guide.what.item3': '配置写入即持久化（<memoryDir>/models.json），重启不丢；',
  'modelsTab.guide.config.title': '每模型配置项',
  'modelsTab.guide.config.body': '展开一行（「配置等级」）即可编辑思考相关配置：',
  'modelsTab.guide.config.item1': '启用/禁用：决定 de_models 工具默认列出的可用模型（默认全部启用）；',
  'modelsTab.guide.config.item2': '支持思考：关闭后该模型不允许思考（仅 off 等级可用）；',
  'modelsTab.guide.config.item3': '推荐思考等级：默认「自动」跟随模型自身推荐，可手动指定任一可用等级；',
  'modelsTab.guide.config.item4': '可用思考等级：勾选哪些等级允许使用（默认全部）；可添加自定义等级（如 ultra），移除自定义等级。',
  'modelsTab.guide.tool.title': 'de_models 工具（给 AI 用）',
  'modelsTab.guide.tool.body': '本模块同时注册 de_models 工具，AI 可以直接查询当前可用模型（接口）清单：',
  'modelsTab.guide.tool.item1': '默认只返回「启用」的模型（all=true 查看全部含禁用），可按供应商过滤；',
  'modelsTab.guide.tool.item2': '每个模型返回：是否启用、DSH 是否激活、是否支持思考、可用思考等级（含推荐等级与自定义等级）、备注。',
  'modelsTab.guide.switch.title': '开关',
  'modelsTab.guide.switch.body': '模型配置默认开启；可在「Memory Evolve 设置」Tab 的「配置」里独立关闭（与其他模块同款开关）——关闭后本 Tab 与 de_models 工具隐藏，配置数据保留。',
  'modelsTab.searchPh': '搜索供应商、模型或备注…',
  'modelsTab.showReasoning': '显示思考等级',
  'modelsTab.refresh': '刷新',
  'modelsTab.loading': '加载中…',
  'modelsTab.count': '共 {total} 个模型 · {enabled} 个启用',
  'modelsTab.loadFailed': '加载失败：{message}',
  'modelsTab.empty': '（暂无模型）',
  'modelsTab.enabled': '启用',
  'modelsTab.enable': '启用',
  'modelsTab.disable': '禁用',
  'modelsTab.provider': '供应商',
  'modelsTab.model': '模型',
  'modelsTab.capacity': '上下文/输出',
  'modelsTab.reasoning': '思考等级',
  'modelsTab.note': '备注',
  'modelsTab.notePh': '输入备注…',
  'modelsTab.dormant': '未激活',
  'modelsTab.thinking': '支持思考',
  'modelsTab.thinkingHint': '关闭后该模型不允许思考（仅 off 等级可用）',
  'modelsTab.thinkingOff': '不支持思考',
  'modelsTab.recommendedLevel': '推荐思考等级',
  'modelsTab.recommendedAuto': '自动（跟随模型推荐）',
  'modelsTab.levelsNone': '全部禁用',
  'modelsTab.editLevels': '配置等级',
  'modelsTab.closeEditor': '收起',
  'modelsTab.editorTitle': '可用思考等级（勾选 = 允许该等级；推荐来自模型能力）',
  'modelsTab.recommended': '推荐',
  'modelsTab.addLevel': '添加',
  'modelsTab.removeLevel': '移除',
  'modelsTab.levelIdPh': '等级 ID（如 ultra）',
  'modelsTab.levelNamePh': '显示名（如 Ultra）',
  'modelsTab.save': '保存',
  'modelsTab.saving': '保存中…',
  'modelsTab.cancel': '取消',
  // DSH UI 设置 Tab（ui-settings-hub）：「综合」= 各功能独立小开关（用户
  // 拍板：功能未定型前不精确分类，统一收「综合」）；「指南」= 精简简介
  // （用户拍板：不细讲每个小功能怎么用）。真正的功能注入是全局 DOM 增强
  // （session-filter.ts / wide-chat.ts），开关经事件广播由 apply 同步，
  // 不依赖本 Tab 打开。
  'uiSettingsTab.label': 'DSH UI 设置',
  'uiSettingsTab.feature.mixed': '综合',
  'uiSettingsTab.feature.guide': '指南',
  'uiSettingsTab.features.title': '功能开关',
  'uiSettingsTab.features.help': '每个功能都有独立的小开关，**默认全部关闭**、由你主动开启，改动即时生效（功能未定型前统一收在「综合」，后续再分类）。',
  'uiSettingsTab.guide.what.title': 'DSH UI 设置是什么',
  'uiSettingsTab.guide.what.body': '给 DSH web 界面做样式级的小功能——不改框架源码，纯客户端注入（CSS + DOM 增强），随 DSH 更新不掉功能；后期扩展（主题更换等）都收进本模块。',
  'uiSettingsTab.guide.switch.title': '开关',
  'uiSettingsTab.guide.switch.body': '模块开关在「Memory Evolve 设置」Tab 的「配置」里（默认关闭）；本 Tab「综合」里是各功能的独立小开关（默认也全部关闭，由你主动开启）。',
  // 功能开关行文案（「综合」子 tab 渲染）。
  'uiSettings.feature.sessionFilter': '会话筛选',
  'uiSettings.feature.sessionFilter.hint': '左侧会话列表只显示进行中的会话（纯 idle 折叠，可一键切回全部）；开启后才出现筛选条',
  'uiSettings.feature.wideChat': '对话区加宽',
  'uiSettings.feature.wideChat.hint': '把中间的对话历史/输入框区域从约一半宽度扩大到右侧约 95%（与上方 Tab 导航条对齐）',
  'uiSettings.feature.wideBubble': '消息气泡加宽',
  'uiSettings.feature.wideBubble.hint': '用户提交后的消息框从默认上限 525px 扩大到占中间内容框约 80%（配合「对话区加宽」效果更明显）',
  // 筛选条按钮文案（session-filter.ts 注入 DOM 用）。
  'uiSettings.filter.on': '仅进行中',
  'uiSettings.filter.off': '全部',
  'uiSettings.running.label': '{count} 运行中',
  'uiSettings.ungrouped': '未分组',
  // 会话书签（独立子模块，bookmarkEnabled 默认关）：
  'bookmarkTab.label': '书签',
  'bookmark.tab.list': '列表',
  'bookmark.tab.guide': '指南',
  'bookmark.list.title': '本会话书签',
  'bookmark.list.help': '点击书签跳转到对应轮次；轮尾 ☆ 打星、★ 已打星（可改名/删除）；列表可搜索、可从此轮创建分支（中间轮的官方分支按钮同样已被 Memory Evolve 接管）。',
  'bookmark.refresh': '刷新',
  'bookmark.loading': '加载中…',
  'bookmark.empty': '（暂无书签——在对话轮尾点 ☆ 打星）',
  'bookmark.defaultLabel': '轮次 {n}',
  'bookmark.turn': '轮次 {n}',
  'bookmark.prompt.create': '书签名称（可改）：',
  'bookmark.prompt.rename': '新名称：',
  'bookmark.confirm.delete': '删除书签「{label}」？',
  'bookmark.noSession': '无法确定当前会话（请刷新页面后重试）',
  'bookmark.search.placeholder': '搜索书签…',
  'bookmark.search.empty': '（没有匹配的书签）',
  'bookmark.star.title.off': '☆ 打书签（Memory Evolve 会话书签）',
  'bookmark.star.title.on': '★ 已打书签：{label}（Memory Evolve，点击改名/删除）',
  'bookmark.menu.rename': '改名',
  'bookmark.menu.delete': '删除',
  'bookmark.action.jump': '跳转',
  'bookmark.action.fork': '分支',
  'bookmark.action.rename': '改名',
  'bookmark.action.delete': '删除',
  'bookmark.fork.title': '由此轮创建分支（Memory Evolve 增强）',
  'bookmark.fork.confirm': '官方仅支持从最后一条消息创建分支。是否仍要从这一轮（seq {n}）创建分支？（Memory Evolve 增强）',
  'bookmark.fork.working': '正在创建分支会话…',
  'bookmark.fork.ok': '已创建新会话 {id}（可在左侧会话列表查看）',
  'bookmark.jump.hint': '点击跳转到该轮',
  'bookmark.jumping': '正在定位…',
  'bookmark.jump.ok': '已定位到「{label}」',
  'bookmark.jump.notFound': '未找到「{label}」对应消息（可能已被压缩/不在当前历史窗口）',
  'bookmark.jump.noChat': '找不到「对话」Tab，无法跳转',
  'bookmark.renamed': '已改名',
  'bookmark.deleted': '已删除',
  'bookmark.error': '失败：{message}',
  'bookmark.guide.what.title': '会话书签是什么',
  'bookmark.guide.what.body': '给对话的每一轮打标签，之后可从列表一键跳回该轮，或直接从任意一轮创建官方分支会话。数据存在插件 sidecar（不碰官方会话日志）；中间轮的官方分支按钮已被 Memory Evolve 接管（点击弹确认后走官方 fork 通道）。',
  'bookmark.guide.star.title': '怎么打星',
  'bookmark.guide.star.body': '每个已完成轮尾有 ☆ 按钮：点一下取名（默认「轮次 N」）即打星；★ 表示已打星，再点可改名或删除。小图标不干扰 Copy/Branch。',
  'bookmark.guide.list.title': '列表与跳转',
  'bookmark.guide.list.body': '本 Tab 列出当前会话全部书签（标签、轮次、时间、摘要）。点击跳转：自动切回「对话」Tab，按 data-chat-anchor-key 定位；若在未加载的历史窗口会先拉更早消息再定位。',
  'bookmark.guide.switch.title': '开关',
  'bookmark.guide.switch.body': '默认关闭；在「Memory Evolve 设置」→「配置」打开「会话书签」。关闭后星标与本 Tab 隐藏，已存书签文件保留。',
  'panel.guide.bookmark.title': '会话书签',
  'panel.guide.bookmark.desc': '给每轮打星标记，列表一键跳回，并支持从任意轮创建官方分支（含接管官方中间轮分支按钮）。独立开关，默认关。',
  'panel.config.bookmarkEnabled': '会话书签',
  'panel.config.bookmarkEnabled.hint': '启用会话书签：每个已完成轮尾出现 ☆ 星标按钮 + 「书签」Tab 列表与跳转；支持从任意轮创建官方分支（列表「分支」按钮，或直接点官方分支按钮——中间轮会被接管并弹确认）。数据存在 <memoryDir>/session-bookmarks.json（按会话隔离，按轮 seq 定位）。**独立子模块**（默认关闭，纯 UI + 宿主 API，不注册 AI 工具）；关闭时星标与 Tab 隐藏，数据文件保留。',
  // 以下键保留兼容（旧 memory tab 合并布局的遗留，新 UI 不再引用）：
  'memoryTab.feature.config': '配置',
  'memoryTab.feature.todoSuggestions': '待确认待办建议',
  'memoryTab.feature.skills': '待确认技能建议',
  'memoryTab.feature.skillBrowser': '技能管理',
  'memoryTab.feature.todo': '待办',
  // 记忆 Tab 专属指南（「指南」子 Tab，详细介绍记忆功能本身）：
  'memoryTab.guide.tracks.title': '五轨记忆',
  'memoryTab.guide.tracks.body': '记忆按层级分五轨，注入范围随层级收窄、互不污染：',
  'memoryTab.guide.tracks.item1': '用户档案（user）：你是谁、偏好、沟通方式——每会话注入；',
  'memoryTab.guide.tracks.item2': '长期记忆（memory）：环境/工具/全局惯例——每会话注入；',
  'memoryTab.guide.tracks.item3': '项目关键记忆（key）：当前项目的长期事实（约定/决策/架构/踩坑）——注入当前项目会话，按 git 分支过滤；',
  'memoryTab.guide.tracks.item4': '项目日志（project）：当前项目的进展流水——不注入，AI 按需读取；',
  'memoryTab.guide.tracks.item5': '今日日志（daily）：按天记录的当天进展——不注入，AI 按需读取。',
  'memoryTab.guide.files.title': '文件页签',
  'memoryTab.guide.files.body': '本 Tab 直接预览 AGENTS.md 与全部记忆文件（只读——编辑请走 memory 工具或系统工具，避免破坏 § 分隔格式）：',
  'memoryTab.guide.files.item1': '美观视图：§ 条目卡片（时间/分支/标签徽标 + 内容），可搜索过滤、切换纯文本视图；',
  'memoryTab.guide.files.item2': 'KEY 页签可手动添加长期项目事实（可同时选择分支范围），保存后下一轮注入；',
  'memoryTab.guide.files.item3': '每条记忆可编辑（注入轨保存需确认）、删除（完整条目精确匹配）、归档/移回主记忆。',
  'memoryTab.guide.branch.title': 'git 分支感知',
  'memoryTab.guide.branch.body': '同一个项目的不同分支可能有完全不同的约定，项目级记忆全程感知当前分支：',
  'memoryTab.guide.branch.item1': 'key 条目可带分支范围标记（无标记 = 全部分支可见）；注入时只注入「无标记」+「覆盖当前分支」的条目；',
  'memoryTab.guide.branch.item2': '日志条目自动带来源分支 tag（[git 分支名]），跨分支回顾不张冠李戴。',
  'memoryTab.guide.maintain.title': '编辑与维护',
  'memoryTab.guide.maintain.body': '记忆的维护操作都在本 Tab 完成：',
  'memoryTab.guide.maintain.item1': '编辑正文：只改内容，时间戳/分支/tag 由程序维护；',
  'memoryTab.guide.maintain.item2': '删除：按完整条目精确匹配（杜绝误删包含关系的长条目），不可恢复；',
  'memoryTab.guide.maintain.item3': '归档/移回：memory/user/key ↔ 归档文件双向移动，归档不再注入、可随时转正。',
  'memoryTab.guide.suggestions.title': '待确认记忆建议',
  'memoryTab.guide.suggestions.body': '后台审查产出的记忆建议先进待确认队列（确认制——AI 只提议，你决定）：',
  'memoryTab.guide.suggestions.item1': '采纳：可先修改文本、可选目标轨（记忆/用户档案/项目关键记忆），写入后随快照注入；',
  'memoryTab.guide.suggestions.item2': '归档：不注入、仅保留备查，需要时可移回主记忆；拒绝：直接丢弃。',
  'memoryTab.guide.confirm.title': '确认制',
  'memoryTab.guide.confirm.body': '记忆写入会真实改变 AI 的行为（进入上下文、影响后续回复），所以一律先经你确认——这是记忆进化的把关环节。',
  // 技能 Tab 专属指南（「指南」子 Tab，详细介绍技能功能本身）：
  'skillsTab.guide.what.title': '技能是什么',
  'skillsTab.guide.what.body': '技能 = 给 AI 的方法论文档（SKILL.md：frontmatter name/description + 正文）：注入每个会话的系统提示词，AI 遇到同类任务直接按流程执行。',
  'skillsTab.guide.what.item1': '技能库默认在 ~/.agents/skills（每个技能一个目录）；',
  'skillsTab.guide.what.item2': 'DSH 还扫描项目技能、内置技能与自定义目录——全部在本 Tab 可见。',
  'skillsTab.guide.how.title': '技能如何沉淀',
  'skillsTab.guide.how.body': '反复踩坑的方法论可固化为技能：',
  'skillsTab.guide.how.item1': '后台审查创建：新技能先进「待确认技能建议」，采纳后移入技能库；',
  'skillsTab.guide.how.item2': 'skill_manage 工具：模型直接创建/更新技能（read-before-write 保护）；',
  'skillsTab.guide.how.item3': '创建保持克制：只建「多次踩坑、难度大、后续复用」的技能，避免技能库膨胀。',
  'skillsTab.guide.pending.title': '待确认技能建议',
  'skillsTab.guide.pending.body': '审查创建的新技能在此确认：',
  'skillsTab.guide.pending.item1': '采纳：移入技能库（~/.agents/skills），随系统提示词注入、所有会话立即可用；',
  'skillsTab.guide.pending.item2': '拒绝：丢弃该技能。',
  'skillsTab.guide.manager.title': '技能管理',
  'skillsTab.guide.manager.body': '完整技能管理器（三栏：技能列表 / 目录树 / 文件查看编辑）：',
  'skillsTab.guide.manager.item1': '全部技能按来源分层展示（用户 user-* / 自定义 custom / 内置 bundled / 项目 project-*），可搜索与筛选；',
  'skillsTab.guide.manager.item2': '自定义技能目录：添加/移除任意技能目录（<目录>/<技能>/SKILL.md 或 <目录>/<技能>.md 布局）；',
  'skillsTab.guide.manager.item3': '文件浏览与编辑：目录树 + 文本查看/编辑（限技能目录范围内，越界/二进制/超大被拒）；',
  'skillsTab.guide.manager.item4': '禁用列表与自定义目录持久保存，重启后自动恢复。',
  'skillsTab.guide.disable.title': '禁用 / 启用',
  'skillsTab.guide.disable.body': '一键禁用把技能从模型技能目录中移除（注册 runtime shadow，模型不再看到、skill 工具拒绝加载）：',
  'skillsTab.guide.disable.item1': '可随时重新启用，选择持久保存；',
  'skillsTab.guide.disable.item2': '系统技能（project 来源）结构性不可禁用。',
  'skillsTab.guide.dirs.title': '自定义技能目录',
  'skillsTab.guide.dirs.body': '在「技能管理」里直接添加/移除你自己的技能目录（如 ~/.hermes/skills），与已有技能根重叠的路径会被拒绝；永久保存、重启后自动加载。',
  'skillsTab.guide.restraint.title': '创建纪律',
  'skillsTab.guide.restraint.body': '技能会注入每个会话的系统提示词、影响上下文与缓存——创建必须克制：',
  'skillsTab.guide.restraint.item1': '只创建「多次尝试仍难解决、难度大、后续可能多次复用」的技能；',
  'skillsTab.guide.restraint.item2': '一次性、简单任务不创建技能。',
  // 待办 Tab 专属指南（「指南」子 Tab，详细介绍待办功能本身）：
  'todosTab.guide.tracks.title': '四轨待办',
  'todosTab.guide.tracks.body': '待办按目标分四轨，与记忆系统同构：',
  'todosTab.guide.tracks.item1': '生活（life）：个人琐事；',
  'todosTab.guide.tracks.item2': '工作（work）：跨项目的正事；',
  'todosTab.guide.tracks.item3': '本项目（project）：当前工作目录的待办（换个目录看不到，按 cwd 隔离）；',
  'todosTab.guide.tracks.item4': '今日（daily）：按天分文件的每日待办，可回看过往（按日期分组）。',
  'todosTab.guide.add.title': '如何添加',
  'todosTab.guide.add.body': '两种方式：',
  'todosTab.guide.add.item1': '对 AI 说「记住/我要做 X」（可指明 工作/生活/这个项目/今天），AI 按类别直写对应轨；',
  'todosTab.guide.add.item2': '在本 Tab 输入框手动添加（可选四象限与截止日期）。',
  'todosTab.guide.pending.title': '待确认待办管理',
  'todosTab.guide.pending.body': 'AI 自建的待办先进待确认队列——AI 不能自作主张给你派活：',
  'todosTab.guide.pending.item1': '采纳：写入对应待办轨（待办永远是待办，不可改成记忆）；',
  'todosTab.guide.pending.item2': '归档：保留备查；拒绝：丢弃。',
  'todosTab.guide.attrs.title': '状态与属性',
  'todosTab.guide.attrs.body': '每条待办带完整元数据：',
  'todosTab.guide.attrs.item1': '四象限（q1 重要紧急 ~ q4 不重要不紧急）、截止日期、可选分类；',
  'todosTab.guide.attrs.item2': '状态：待办 / 进行中 / 已完成（自动盖完成时间）/ 受阻 / 已取消；',
  'todosTab.guide.attrs.item3': '列表/看板两种视图：列表按轨页签 + 状态/象限筛选；看板按四象限四宫格展示；每条可完成/恢复、行内编辑、删除（确认），状态徽标可点击循环切换。',
  'todosTab.guide.view.title': '智能视图',
  'todosTab.guide.view.body': '默认只显示需要关注的（逾期/今日到期/当前项目/重要紧急，最多 8 条）：',
  'todosTab.guide.view.item1': '过往每日待办按需读取——点「过往」页签才查询历史；',
  'todosTab.guide.view.item2': '「显示已过期」勾选后才展示过期的遗留（默认隐藏，不增加负担）。',
  'todosTab.guide.remind.title': '到期提醒',
  'todosTab.guide.remind.body': 'AI 每轮收尾检查待办到期情况，有到期未完成项就在回复末尾提醒你——不用自己记着盯。',
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
  // 列表 / 四象限看板视图切换
  'todo.view.mode': '视图',
  'todo.view.list': '列表',
  'todo.view.board': '看板',
  'todo.board.empty': '此象限暂无待办',
  'todo.board.cycleStatus': '点击切换状态',
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
  'panel.guide.search.desc': '记忆里没有、要找本地资料时，AI 可按文件名搜索（不止文档，图片/代码/配置都能找；默认只搜文档扩展名，可显式全类型搜索）；**也可按文件内容搜**——"哪个文档里提过 XX"直接问 AI（contentQuery 参数即开内容检索）。**四档模式**（「配置」里选）：都启用（文件名+内容）/ 仅文件名搜索 / 仅内容搜索 / 关闭——内容检索有人可能用自己别的实现，可按需只留文件名模式。**默认关闭**：工具对模型完全不可见。',
  'panel.guide.coi.title': 'COI 调度（de_coi）',
  'panel.guide.coi.desc': '把任务派给外部 CLI 代理（kimi/codex/grok/hermes 等）：统一调度不卡主进程、实时看进度、会话自动分层管理可一键恢复、跨 COI 接力、任务结果留档并沉淀到记忆。说"派给 kimi/codex 做 XX"即可，或打开「COI 调度」Tab 手动发起。**默认禁用**：与本地搜索一样按需启用——在「Memory Evolve 设置」Tab 的「配置」里打开「COI 调度」开关（工具即时生效，Tab 刷新后出现）。',
  'panel.guide.prompt.title': '提示词管理器（Prompt Manager）',
  'panel.guide.prompt.desc': '把常用的工作范式固化成提示词资产（内置程序员示例：代码审查/调试/架构/测试等，来源以自写为主）：选中一条即可注入——**写入后模型下一轮自动看到、不打断回复**；支持一次性、持续 N 轮、每 M 回合提醒一次（次数/间隔可输入任意数字，按对话回合计数自动过期），「注入中」可随时停止；也支持**临时注入**：不建提示词直接输入内容注入，自动存入提示词库（分类留空归入「临时」）。**默认禁用**：在「Memory Evolve 设置」Tab 的「配置」里打开「提示词管理器」开关，Tab 刷新后出现。',
  'panel.guide.models.title': '模型配置（de_models）',
  'panel.guide.models.desc': '「模型配置」Tab + `de_models` 工具：表格一览 DSH 现有供应商与模型，给每个模型设置**插件侧**的启用状态、备注、是否支持思考与可用/推荐思考等级（可勾选等级白名单、添加自定义等级）——**这些配置只对本插件有用**（决定 de_models 查询口径与 Tab 展示），**不修改、也不影响 DSH 自身的模型设置**（DSH 的模型配置仍以官方「设置 → 模型」为准）。**默认禁用**：在「配置」里打开「模型配置」开关后，Tab 刷新出现、de_models 工具生效。',
  'panel.guide.broadcast.title': '会话广播（de_broadcast）',
  'panel.guide.broadcast.desc': 'DSH 会话之间传递消息：先复制本会话 ID（会话头部「⧉ 复制会话ID」按钮），把 ID 发给另一个会话，让它的 AI 用 de_broadcast send 把内容广播给你（recipients 可同时填多个会话 ID，默认一对一）——接收方快照**定点注入**未读提示（收件箱式列出 id+主题+发送者+时间，只有接收者看得到，其他会话无感知），AI 用 list/read 查看全文处理（显式接收者 read 即消费、全员已读自动删除；房间/项目消息保留 30 天供回看）；超过 8KB 的内容自动落文件。**房间（聊天室）**：多会话协作（可跨工作目录）——建群（room-create，创建者自动入房）→ 把房间 id 告诉其他会话（粘贴或广播）→ 对方 room-join 加入 → 之后说"发到群里"全员同时收到；room-leave 退出、room-rm 解散（仅创建者）、room-list 查群；房间 30 天无活动自动删除。**项目群**：recipients 填 project:/路径 发给整个目录（按 cwd 匹配）。**开关**：独立「会话广播」（broadcastEnabled，默认关，可单独开启，与 COI 调度无关）。另：快照最前面有**常驻「你的会话 ID」段**（不随任何开关）——AI 用它比对各模块消息里的 session id 判断收发方，回复广播时把 ID 告知对方。',
  'panel.guide.session.title': '会话搜索（de_session_search）',
  'panel.guide.session.desc': '让 AI 搜索**其他 AI 工具的历史会话**（当前支持 Codex：`~/.codex/sessions` 与 `archived_sessions` 的明文 JSONL，rg 预筛后毫秒级；DSH 会话暂不支持）——"之前 Codex 里做过 XX"直接问 AI，它按关键词搜出命中会话 + 最强消息摘要（snippet）+ 上下文窗口；大小写不敏感的字面匹配（中英文/标点同一规则），只搜用户/助手消息（工具输出不搜）；可用 cwd 限定项目（Codex 会话记录工作目录），sort/limit/window 控制结果规模；**零常驻状态**——无索引、无缓存，每次调用实时只读扫描，不修改任何会话文件。**开关**：独立「会话搜索」（sessionSearchEnabled，默认关，与 COI 调度/广播无关，可单独开启）。',
  'panel.guide.sessionOrch.title': '会话编排（de_session）',
  'panel.guide.sessionOrch.desc': '让 AI **程序化创建/唤醒 DSH 会话**（"会话启动另一个会话"）——spawn：新建**标准会话**（与手动打开完全同构：系统提示词/工具/记忆快照/持久化，出现在左侧会话列表可接管），prompt=**完整提示词**（角色/任务自由组合的长文本，如"你是美工，负责…现在开始执行：…"），创建后立即自动开跑，可选 cwd/加入广播房间（roomId）/覆盖模型（model）；wake：唤醒已有会话（sessionId + 提示词，等价替用户发消息，对方 AI 自动醒来处理，忙则排队；进程重启后自动恢复再唤醒）；status/list：查状态（running=正在生成 / idle=已停止 / offline=不在本进程，附 lastActiveAt 最后活动时间）。**协作纪律**：不会自动唤醒任何会话——由拍板人（如产品经理）**有意识地** list/status 查状态、发现员工停止后主动 wake 派活（避免管理混乱）；**边界**：仅同进程会话可唤醒；唤醒=替用户发消息（对方 GUI 可见全程）。**开关**：独立「会话编排」（sessionEnabled，默认关，与 COI/广播/搜索互不影响，可单独开启）；建议配合「会话广播」房间使用（spawn 带 roomId 自动入房）。',
  'panel.guide.uiSettings.title': 'DSH UI 设置',
  'panel.guide.uiSettings.desc': '给 DSH web 界面加样式级小功能（纯客户端注入，不改框架）：各功能的独立小开关在「DSH UI 设置」Tab 的「综合」里——会话筛选（左侧列表只显示进行中）、对话区加宽（中间区域扩大到约 95%）等；后期扩展主题更换。',
  'panel.guide.confirm.title': '确认制（为什么 AI 不能直接写）',
  'panel.guide.confirm.desc': 'AI 自建的记忆、待办、技能都先进待确认队列，等你确认才生效。因为这些写入会真实改变 AI 的行为：记忆会进入上下文、待办是给你派的活、技能会改变 AI 的能力库——如果 AI 擅自写入，可能把它的误判当事实沉淀、或自作主张给你派活。你是最终把关者：AI 只提议，你决定。',
  'panel.guide.best.title': '怎么用得最好',
  'panel.guide.best.1': '跨会话衔接：项目约定/进展直接说"查一下记忆"，AI 从项目日志与关键记忆里接续，不重复交代。',
  'panel.guide.best.2': '口头即记：想到什么就说"记住这个 / 这个要跟进"，AI 自动分类沉淀；隔几天回来说一句就能接上。',
  'panel.guide.best.3': '定期确认：偶尔看看「待确认记忆建议」「待确认待办建议」两个 tab，采纳或拒绝——这是记忆进化的确认环节。',
  'panel.guide.best.4': '跨会话协作：复制本会话 ID 发给另一个会话，让它的 AI 用 de_broadcast 把结果广播给你（可同时发给多个会话，接收方下一轮自动看到未读提示）。',
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
  'panel.config.title': '配置',
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
  'panel.config.coiEnabled': 'COI 调度',
  'panel.config.coiEnabled.hint': '启用 de_coi_* 工具与「COI 调度」Tab：统一调度 kimi/codex/grok/hermes 等 CLI 代理（默认禁用——本插件的本职是记忆/待办/技能，调度是按需增强；关闭时工具与 Tab 完全不可见）',
  'panel.config.scratchEnabled': '临时信息 Tab',
  'panel.config.scratchEnabled.hint': '启用「临时信息」Tab：持久化 Markdown 便签，临时想法随手记（自动保存到 ~/.dsh/memories/scratch.md，重启不丢，可随时迁移或删除）。默认关闭；关闭时 Tab 完全不可见',
  'panel.config.searchDocsEnabled': '本地文件搜索工具',
  'panel.config.searchDocsEnabled.hint': '让模型在本机所有磁盘/目录中搜索文件。**四档模式**：都启用 = 文件名 + 内容检索都可用；仅文件名 = content/contentQuery 参数被忽略（不读任何文件内容，适合内容检索用别的实现的人）；仅内容 = 每次调用都做内容匹配（query 视为内容关键词）；关闭 = 工具对模型完全不可见。内容检索：contentQuery="关键词" 即搜"哪个文档里提过 XX"（rg 全文匹配，返回命中片段）。默认关闭',
  'panel.config.searchDocsMode.all': '都启用（文件名 + 内容）',
  'panel.config.searchDocsMode.filename': '仅文件名搜索',
  'panel.config.searchDocsMode.content': '仅内容搜索',
  'panel.config.searchDocsMode.off': '关闭（工具不可见）',
  'panel.config.broadcastEnabled': '会话广播',
  'panel.config.broadcastEnabled.hint': '启用会话广播（de_broadcast）：DSH 会话间消息传递——快照「会话广播」未读提示（收件箱式列出 id+主题+发送者+时间）+ de_broadcast 工具（send/list/read，read 即消费、全读后自动删除、8KB 落文件、30 天清理）+ 会话广播管理面板 Tab。**独立于 COI 调度**（默认关闭，可单独开启）；关闭时以上全部不可见；「你的会话 ID」常驻快照段不受影响；会话头部「⧉ 复制会话ID」「✎ 别名」按钮属「会话编排」模块（面板顶部另有复制入口）',
  'panel.config.sessionSearchEnabled': '会话搜索',
  'panel.config.sessionSearchEnabled.hint': '启用 de_session_search：让模型搜索本机其他 AI 工具的历史会话（当前支持 Codex：~/.codex/sessions 与 archived_sessions 的明文 JSONL——rg 预筛后毫秒级；DSH 会话暂不支持）。大小写不敏感的字面匹配，只搜用户/助手消息；支持 cwd 项目过滤、relevance/newest/oldest 排序、limit/window 控制规模。**独立子模块**（默认关闭，可单独开启，与 COI 调度/广播无关）；零常驻状态：无索引、无缓存，每次调用实时只读扫描，不修改任何会话文件；关闭时工具对模型完全不可见',
  'panel.config.sessionEnabled': '会话编排',
  'panel.config.sessionEnabled.hint': '启用会话编排（de_session）：让 AI **程序化创建/唤醒 DSH 会话**——spawn 新建标准会话（与手动打开完全同构：系统提示词/工具/记忆快照/持久化，出现在左侧会话列表可接管），prompt=完整提示词（角色/任务自由组合的长文本），创建后立即自动开跑，可选 cwd/加入广播房间/覆盖模型；wake 唤醒已有会话（等价替用户发消息，对方 AI 自动醒来处理，进程重启后自动恢复）；status/list 查状态；**会话头部「⧉ 复制会话ID」「✎ 别名」按钮随本开关**（会话身份功能，曾误挂在广播下）。**独立子模块**（默认关闭；依赖 DSH agents 服务，仅同进程会话可唤醒；关闭时工具对模型不可见）',
  'panel.config.promptsEnabled': '提示词管理器',
  'panel.config.promptsEnabled.hint': '启用「提示词」Tab：提示词库（用户自写范式 + 内置示例）+ 注入轨（一次性/持续 N 轮/每 M 回合一次，次数与间隔可输入任意数字——写入后模型下一轮自动看到，回合递减自动过期，可随时停止；不建提示词也能临时注入，自动入库归入「临时」分类）。默认关闭；关闭时快照段/事件监听/API 全部卸载，Tab 刷新后隐藏',
  'panel.config.modelsEnabled': '模型配置',
  'panel.config.modelsEnabled.hint': '启用「模型配置」Tab + de_models 工具：表格展示 DSH 供应商/模型，给每个模型设置启用状态、备注、是否支持思考、可用/推荐思考等级（可加自定义等级）；de_models 供 AI 查询可用模型清单。**默认关闭**（注册即占模型工具列表，需要时再开）；⚠️ 本模块的配置**只对插件自身有用，不修改也不影响 DSH 的模型设置**（DSH 侧仍以官方「设置 → 模型」为准）。关闭时 Tab 与工具隐藏、API 拒绝访问，配置数据保留',
  'panel.config.uiSettingsEnabled': 'DSH UI 设置',
  'panel.config.uiSettingsEnabled.hint': '启用「DSH UI 设置」模块：左侧会话列表顶部出现筛选条，默认只显示进行中的会话（正在生成/等审批/等回答/有子代理在跑/出错/已完成未查看——纯 idle 的折叠隐藏），可一键切回全部；纯客户端样式增强（CSS + DOM 注入，不改 DSH 框架）；筛选偏好记在浏览器本地。**默认关闭**；关闭时筛选条与注入样式全部移除',
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
  'memoryTab.label': 'Memory',
  'memoryTab.label.pending': '🔴 Memory ({count})',
  'skillsTab.label': 'Skills',
  'skillsTab.label.pending': '🔴 Skills ({count})',
  'todosTab.label': 'Todos',
  'todosTab.label.pending': '🔴 Todos ({count})',
  'coiTab.label': 'COI Dispatch',
  'coiTab.label.pending': '🔴 COI Dispatch ({count})',
  'broadcastTab.label': 'Broadcast',
  'broadcast.tab.guide': 'Guide',
  'broadcast.tab.messages': 'Messages',
  'broadcast.tab.rooms': 'Rooms',
  'broadcast.tab.settings': 'Settings',
  'broadcast.settings.wsCoord.title': 'Workspace coordination (ws-coord)',
  'broadcast.settings.wsCoord.desc': 'Resource-occupancy coordination for parallel sessions in one workspace — declare files you will modify (de_ws_declare), auto-register writes, write-conflict detection (soft warning / hard block switchable), and de_ws_status to see "who is running and what they are doing". These switches only control this sub-feature; the "Session broadcast" master switch lives under Memory Evolve Settings → Config.',
  'broadcast.settings.wsCoord.enabled': 'Enable workspace coordination',
  'broadcast.settings.wsCoord.enabled.hint': 'Registers de_ws_declare / de_ws_status / de_ws_release tools + write-conflict detection listeners + the activity snapshot section. Depends on the "Session broadcast" master switch (unavailable while broadcast is off). Off by default',
  'broadcast.settings.wsCoord.snapshot': 'Activity snapshot section',
  'broadcast.settings.wsCoord.snapshot.hint': 'When ≥2 sessions are active in the workspace, inject one 【Workspace activity】 line into the per-turn snapshot (with the current time and what each session is doing); zero cost with 0-1 active sessions',
  'broadcast.settings.wsCoord.enforce': 'Hard-block mode',
  'broadcast.settings.wsCoord.enforce.hint': 'Off by default (soft mode: trust the AI — conflicts warn but never block); when on, writes to files occupied by other sessions are denied at the tool layer (deny), and the AI sees the reason and adjusts on its own',
  'broadcast.guide.intro.title': 'What is Session Broadcast',
  'broadcast.guide.intro.body': 'Session broadcast = a message channel between DSH sessions: send messages to other sessions (AI sends them via the de_broadcast send tool), and the receiver sees a "Session broadcast" notice in its next snapshot. Messages are managed like an inbox — subject + summary, auto-deleted once every recipient has read them.',
  'broadcast.guide.send.title': 'How to send',
  'broadcast.guide.send.body': 'Just tell the AI "broadcast to session XX…" (default is one-to-one; recipient = the other session\'s ID):',
  'broadcast.guide.send.item1': 'One-to-one: specify the recipient session ID (send your "copy session ID" result to the other side so its AI can reach you);',
  'broadcast.guide.send.item2': 'Room: multi-member chat room, cross-working-directory, visible to all members (send to room:<roomId>);',
  'broadcast.guide.send.item3': 'Project: visible to all sessions in that working directory (send to project:/absolute/path).',
  'broadcast.guide.inbox.title': 'Inbox (Messages tab)',
  'broadcast.guide.inbox.body': 'The list shows only **unread** non-room messages by default (read ones are hidden; room messages live inside the room):',
  'broadcast.guide.inbox.item1': 'Filters: unread / all / read; search by subject, sender, content; 20 per page;',
  'broadcast.guide.inbox.item2': '"Expand" shows the full content; red "Delete" = admin delete (invisible to everyone);',
  'broadcast.guide.inbox.item3': 'One-to-one messages auto-delete once all recipients have read them (consumed, no clutter).',
  'broadcast.guide.room.title': 'Rooms tab',
  'broadcast.guide.room.body': 'Rooms = multi-member collaboration chat rooms:',
  'broadcast.guide.room.item1': 'Expand a room to see member presence: 🟢 running = generating now (you may wait for it / it sees new messages this turn), ⚪ idle/unknown = turn finished or never seen (don\'t wait);',
  'broadcast.guide.room.item2': 'Room messages support the same filter/search/pagination; creators can kick members and dissolve rooms (system notice sent);',
  'broadcast.guide.room.item3': 'Dissolved rooms keep their records for audit; members can no longer join or send.',
  'broadcast.guide.alias.title': 'Session aliases',
  'broadcast.guide.alias.body': 'Give a session a friendly name (≤10 chars) — shown in snapshots, lists and messages as alias (short ID):',
  'broadcast.guide.alias.item1': 'The "My session" row at top: copy session ID / copy alias, share it to start chatting;',
  'broadcast.guide.alias.item2': 'Or use ⧉ copy session ID / ✎ alias in the session header (top-right).',
  'broadcast.guide.switch.title': 'Switch',
  'broadcast.guide.switch.body': 'Session broadcast is off by default: enable the "Session broadcast" toggle under "Config" in the "Settings" tab, then refresh to reveal this tab.',
  'broadcast.mySessionId': 'My session ID',
  'broadcast.copyId': 'Copy',
  'broadcast.copied': 'Copied',
  'broadcast.loading': 'Loading…',
  'broadcast.refresh': 'Refresh',
  'broadcast.messages.empty': '(no messages)',
  'broadcast.messages.sender': 'From',
  'broadcast.messages.to': 'To',
  'broadcast.messages.direct': 'direct',
  'broadcast.messages.room': 'room',
  'broadcast.messages.project': 'project',
  'broadcast.messages.unread': 'unread',
  'broadcast.messages.long': 'long',
  'broadcast.message.expand': 'Expand',
  'broadcast.message.collapse': 'Collapse',
  'broadcast.message.delete': 'Delete',
  'broadcast.message.deleteConfirm': 'Delete this message? (admin action, invisible to everyone)\n\n{subject}',
  'broadcast.message.deleted': 'Deleted',
  'broadcast.copyAlias': 'Copy alias',
  'broadcast.msg.unread': 'unread',
  'broadcast.msg.read': 'read',
  'broadcast.filter.unread': 'Unread',
  'broadcast.filter.all': 'All',
  'broadcast.filter.read': 'Read',
  'broadcast.searchPh': 'Search subject/sender/content…',
  'broadcast.pagePrev': 'Prev',
  'broadcast.pageNext': 'Next',
  'broadcast.pageInfo': 'Page {page}/{total}',
  'broadcast.room.detail': 'Details',
  'broadcast.room.messages': 'Room messages',
  'broadcast.room.messages.empty': '(no room messages)',
  'broadcast.messages.roomInRooms': 'Room messages live inside their room — open it from the Rooms view',
  'broadcast.rooms.empty': '(no rooms)',
  'broadcast.roomSearchPh': 'Search room name…',
  'broadcast.roomStatus.all': 'All',
  'broadcast.roomStatus.active': 'Active',
  'broadcast.roomStatus.dissolved': 'Dissolved',
  'broadcast.roomDays.0': 'Any time',
  'broadcast.roomDays.7': 'Last 7 days',
  'broadcast.roomDays.30': 'Last 30 days',
  'broadcast.room.status.active': 'active',
  'broadcast.room.status.idle': 'idle',
  'broadcast.room.status.dissolved': 'dissolved',
  'broadcast.room.online': '{online}/{total} online',
  'broadcast.room.members': 'Members',
  'broadcast.room.kick': 'Kick',
  'broadcast.room.kickConfirm': 'Kick member {member}? (a system notice is sent; the session loses room access)',
  'broadcast.room.dissolve': 'Dissolve',
  'broadcast.room.dissolveConfirm': 'Dissolve room "{name}"? (soft delete: record kept for traceability, members get a system notice, no further joins/messages)',
  'broadcast.room.dissolved': 'dissolved',
  'broadcast.room.copyId': 'Copy room id',
  'broadcast.room.lastActive': 'Last active',
  'broadcast.room.created': 'Created',
  'broadcast.room.presence.unknown': 'unknown · no activity recorded',
  'header.copySessionId': '⧉ Copy session ID',
  'header.copySessionId.done': '✓ Copied',
  'header.copySessionId.title': 'Copy this session\'s ID (send it to another session: tell its AI your session ID so it can broadcast to you via de_broadcast)',
  'header.setAlias': '✎ Alias',
  'header.setAlias.title': 'Set a session alias (≤10 chars) — shown as your friendly name in the snapshot / broadcast panel / messages',
  'header.setAlias.placeholder': 'alias (≤10 chars)',
  'header.setAlias.save': 'Save',
  'header.setAlias.clear': 'Clear',
  'header.setAlias.saved': 'Alias saved',
  'header.setAlias.cleared': 'Alias cleared',
  'scratchTab.label': 'Scratch Pad',
  'promptTab.label': 'Prompt Injection',
  'promptTab.label.active': '🔴 Prompt Injection ({count})',
  'settingsTab.label': 'Memory Evolve Settings',
  'settingsTab.feature.guide': 'Guide',
  'settingsTab.feature.config': 'Config',
  'memoryTab.feature.guide': 'Guide',
  'memoryTab.feature.suggestions': 'Memory suggestions',
  'skillsTab.feature.guide': 'Guide',
  'skillsTab.feature.skills': 'Skill suggestions',
  'skillsTab.feature.skillBrowser': 'Skill manager',
  'todosTab.feature.guide': 'Guide',
  'todosTab.feature.todoSuggestions': 'Todo suggestions',
  'todosTab.feature.todo': 'Todos',
  'modelsTab.label': 'Models',
  'modelsTab.feature.models': 'Models',
  'modelsTab.feature.guide': 'Guide',
  'modelsTab.guide.what.title': 'What is Model Config',
  'modelsTab.guide.what.body': 'A table view of every DSH provider and model, with per-model plugin-side settings (enabled state, note, reasoning levels). All settings belong to this plugin (models.json) — DSH configuration is never touched and nothing couples to other plugins.',
  'modelsTab.guide.what.item1': 'Columns: enabled toggle, provider (with DSH active state), model (name + ID), context/output capacity, reasoning levels, note; search and a "show reasoning" toggle;',
  'modelsTab.guide.what.item2': 'Per model: enable/disable (plugin-scope availability marker, does not change DSH routing), note, thinking support, allowed reasoning levels, recommended level, custom levels;',
  'modelsTab.guide.what.item3': 'Settings persist immediately (<memoryDir>/models.json) and survive restarts;',
  'modelsTab.guide.config.title': 'Per-model settings',
  'modelsTab.guide.config.body': 'Expand a row ("Configure levels") to edit reasoning settings:',
  'modelsTab.guide.config.item1': 'Enable/disable: decides which models de_models lists by default (all enabled by default);',
  'modelsTab.guide.config.item2': 'Support thinking: when off, the model cannot reason (only the off level stays available);',
  'modelsTab.guide.config.item3': 'Recommended level: defaults to "Auto" (follow the model), or pick any available level manually;',
  'modelsTab.guide.config.item4': 'Allowed levels: check which levels may be used (all by default); custom levels (e.g. ultra) can be added and removed.',
  'modelsTab.guide.tool.title': 'de_models tool (for AI)',
  'modelsTab.guide.tool.body': 'This module also registers the de_models tool so the AI can query the available model (endpoint) list:',
  'modelsTab.guide.tool.item1': 'Only "enabled" models are listed by default (all=true shows everything including disabled); filterable by provider;',
  'modelsTab.guide.tool.item2': 'Each model returns: enabled, DSH active, thinking support, usable reasoning levels (with recommended and custom levels), note.',
  'modelsTab.guide.switch.title': 'Switch',
  'modelsTab.guide.switch.body': 'Model config is on by default; it can be turned off independently in the "Memory Evolve Settings" tab ("Config") like other modules — the tab and the de_models tool hide, settings data is kept.',
  'modelsTab.searchPh': 'Search provider, model, or note…',
  'modelsTab.showReasoning': 'Show reasoning levels',
  'modelsTab.refresh': 'Refresh',
  'modelsTab.loading': 'Loading…',
  'modelsTab.count': '{total} models · {enabled} enabled',
  'modelsTab.loadFailed': 'Load failed: {message}',
  'modelsTab.empty': '(No models)',
  'modelsTab.enabled': 'Enabled',
  'modelsTab.enable': 'Enable',
  'modelsTab.disable': 'Disable',
  'modelsTab.provider': 'Provider',
  'modelsTab.model': 'Model',
  'modelsTab.capacity': 'Context/Output',
  'modelsTab.reasoning': 'Reasoning',
  'modelsTab.note': 'Note',
  'modelsTab.notePh': 'Add a note…',
  'modelsTab.dormant': 'Inactive',
  'modelsTab.thinking': 'Support thinking',
  'modelsTab.thinkingHint': 'When off, this model cannot reason (only the off level stays available)',
  'modelsTab.thinkingOff': 'Thinking off',
  'modelsTab.recommendedLevel': 'Recommended level',
  'modelsTab.recommendedAuto': 'Auto (follow model recommendation)',
  'modelsTab.levelsNone': 'All disabled',
  'modelsTab.editLevels': 'Configure levels',
  'modelsTab.closeEditor': 'Collapse',
  'modelsTab.editorTitle': 'Available reasoning levels (check = allowed; recommended comes from the model)',
  'modelsTab.recommended': 'Recommended',
  'modelsTab.addLevel': 'Add',
  'modelsTab.removeLevel': 'Remove',
  'modelsTab.levelIdPh': 'Level ID (e.g. ultra)',
  'modelsTab.levelNamePh': 'Display name (e.g. Ultra)',
  'modelsTab.save': 'Save',
  'modelsTab.saving': 'Saving…',
  'modelsTab.cancel': 'Cancel',
  // DSH UI Settings tab (ui-settings-hub): module intro (guide sub-tab) +
  // future extension seat (themes etc.). The real feature (session filter)
  // is a global DOM enhancement independent of this tab; the feature
  // switches (uiSettings.feature.*) are consumed by the "General" sub-tab
  // and broadcast via event for apply() to sync DOM injection.
  'uiSettingsTab.label': 'DSH UI Settings',
  'uiSettingsTab.feature.mixed': 'General',
  'uiSettingsTab.feature.guide': 'Guide',
  'uiSettingsTab.features.title': 'Feature switches',
  'uiSettingsTab.features.help': 'Every feature has its own small switch, **all off by default** — you turn them on deliberately; changes apply immediately (features stay under "General" until they mature and get their own categories).',
  'uiSettingsTab.guide.what.title': 'What is DSH UI Settings',
  'uiSettingsTab.guide.what.body': 'Style-level tweaks for the DSH web GUI — no framework source changes, pure client-side injection (CSS + DOM enhancement) that survives DSH updates; future extensions (themes, etc.) all land in this module.',
  'uiSettingsTab.guide.switch.title': 'Switches',
  'uiSettingsTab.guide.switch.body': 'The module switch lives in the "Config" sub-tab of the "Memory Evolve Settings" tab (off by default); the per-feature switches live in the "General" sub-tab of this tab — also all off by default, turned on deliberately.',
  // Feature-switch row labels (rendered by the "General" sub-tab).
  'uiSettings.feature.sessionFilter': 'Session filter',
  'uiSettings.feature.sessionFilter.hint': 'The left session list shows only active sessions (purely idle ones collapse; one click switches back to all); the filter bar appears only while this is on',
  'uiSettings.feature.wideChat': 'Wide conversation area',
  'uiSettings.feature.wideChat.hint': 'Widen the conversation transcript/input area from roughly half to about 95% of the right pane (aligned with the tabs bar above)',
  'uiSettings.feature.wideBubble': 'Wide message bubble',
  'uiSettings.feature.wideBubble.hint': 'Widen the user message bubble from its 525px cap to about 80% of the content column (pairs well with "Wide conversation area")',
  // Filter-bar button labels (consumed by session-filter.ts injected DOM).
  'uiSettings.filter.on': 'Running only',
  'uiSettings.filter.off': 'All',
  'uiSettings.running.label': '{count} running',
  'uiSettings.ungrouped': 'Ungrouped',
  // Session bookmarks (independent submodule, bookmarkEnabled off by default):
  'bookmarkTab.label': 'Bookmarks',
  'bookmark.tab.list': 'List',
  'bookmark.tab.guide': 'Guide',
  'bookmark.list.title': 'Session bookmarks',
  'bookmark.list.help': 'Click a bookmark to jump to that turn; star ☆ at each turn tail to bookmark, ★ when bookmarked (rename/delete); searchable list; fork from any turn (official mid-turn branch buttons are taken over by Memory Evolve).',
  'bookmark.refresh': 'Refresh',
  'bookmark.loading': 'Loading…',
  'bookmark.empty': '(No bookmarks yet — click ☆ at a turn tail)',
  'bookmark.defaultLabel': 'Turn {n}',
  'bookmark.turn': 'Turn {n}',
  'bookmark.prompt.create': 'Bookmark name (editable):',
  'bookmark.prompt.rename': 'New name:',
  'bookmark.confirm.delete': 'Delete bookmark "{label}"?',
  'bookmark.noSession': 'Cannot determine the current session (refresh the page and retry)',
  'bookmark.search.placeholder': 'Search bookmarks…',
  'bookmark.search.empty': '(No matching bookmarks)',
  'bookmark.star.title.off': '☆ Bookmark this turn (Memory Evolve session bookmarks)',
  'bookmark.star.title.on': '★ Bookmarked: {label} (Memory Evolve — click to rename/delete)',
  'bookmark.menu.rename': 'Rename',
  'bookmark.menu.delete': 'Delete',
  'bookmark.action.jump': 'Jump',
  'bookmark.action.fork': 'Fork',
  'bookmark.action.rename': 'Rename',
  'bookmark.action.delete': 'Delete',
  'bookmark.fork.title': 'Fork from this turn (Memory Evolve enhancement)',
  'bookmark.fork.confirm': 'Officially you can only fork from the last message. Fork from this turn (seq {n}) anyway? (Memory Evolve enhancement)',
  'bookmark.fork.working': 'Creating fork session…',
  'bookmark.fork.ok': 'New session created: {id} (see the session list on the left)',
  'bookmark.jump.hint': 'Click to jump to this turn',
  'bookmark.jumping': 'Locating…',
  'bookmark.jump.ok': 'Jumped to "{label}"',
  'bookmark.jump.notFound': 'Could not find the message for "{label}" (may be compacted or outside the loaded window)',
  'bookmark.jump.noChat': 'Chat tab not found — cannot jump',
  'bookmark.renamed': 'Renamed',
  'bookmark.deleted': 'Deleted',
  'bookmark.error': 'Failed: {message}',
  'bookmark.guide.what.title': 'What are session bookmarks',
  'bookmark.guide.what.body': 'Tag any completed turn, then jump back from the list in one click, or fork an official branch session from any turn. Stored in a plugin sidecar (never touches official session logs); official mid-turn branch buttons are taken over by Memory Evolve (confirm dialog, then the official fork path).',
  'bookmark.guide.star.title': 'How to star',
  'bookmark.guide.star.body': 'Each completed turn tail has a ☆ button: click to name it (default "Turn N") and bookmark; ★ means bookmarked — click again to rename or delete. Small icon, does not crowd Copy/Branch.',
  'bookmark.guide.list.title': 'List and jump',
  'bookmark.guide.list.body': 'This tab lists all bookmarks for the current session (label, turn, time, summary). Click to jump: switches back to the Chat tab and scrolls to data-chat-anchor-key; if the target is outside the loaded history window it pulls older pages first.',
  'bookmark.guide.switch.title': 'Switch',
  'bookmark.guide.switch.body': 'Off by default; enable "Session bookmarks" under Memory Evolve Settings → Config. When off, stars and this tab hide; the sidecar file is kept.',
  'panel.guide.bookmark.title': 'Session bookmarks',
  'panel.guide.bookmark.desc': 'Star any turn and jump back from the list; fork official branch sessions from any turn (including taking over official mid-turn branch buttons). Independent switch, off by default.',
  'panel.config.bookmarkEnabled': 'Session bookmarks',
  'panel.config.bookmarkEnabled.hint': 'Enable session bookmarks: a ☆ star on each completed turn tail + a Bookmarks tab for the list and jump; fork official branch sessions from any turn (list "Fork" button, or click the official branch button — mid-turn buttons are taken over with a confirm dialog). Data lives in <memoryDir>/session-bookmarks.json (per-session, keyed by turn seq). **Independent submodule** (off by default; pure UI + host API, no AI tools); when off, stars and the tab hide, the data file is kept.',
  // Legacy keys kept for compatibility (old merged memory-tab layout).
  'memoryTab.feature.config': 'Config',
  'memoryTab.feature.todoSuggestions': 'Todo suggestions',
  'memoryTab.feature.skills': 'Skill suggestions',
  'memoryTab.feature.skillBrowser': 'Skill manager',
  'memoryTab.feature.todo': 'Todos',
  // Memory-tab guide (the "Guide" sub-tab: detailed intro of the memory feature itself).
  'memoryTab.guide.tracks.title': 'Five memory tracks',
  'memoryTab.guide.tracks.body': 'Memory is organized in five tracks; injection scope narrows by tier and tracks never pollute each other:',
  'memoryTab.guide.tracks.item1': 'User profile (user): who you are, preferences, communication style — injected into every session;',
  'memoryTab.guide.tracks.item2': 'Long-term memory (memory): environment/tools/global conventions — injected into every session;',
  'memoryTab.guide.tracks.item3': 'Project key facts (key): long-lived facts of the current project (conventions/decisions/architecture/pitfalls) — injected into current-project sessions, filtered by git branch;',
  'memoryTab.guide.tracks.item4': 'Project log (project): progress stream of the current project — never injected, read on demand by the AI;',
  'memoryTab.guide.tracks.item5': 'Daily log (daily): per-day progress records — never injected, read on demand.',
  'memoryTab.guide.files.title': 'File tabs',
  'memoryTab.guide.files.body': 'This tab previews AGENTS.md and every memory file (read-only — edit via the memory tool or a system editor to avoid breaking the §-delimited format):',
  'memoryTab.guide.files.item1': 'Pretty view: § entry cards (time/branch/tag badges + content), searchable, switchable to raw text view;',
  'memoryTab.guide.files.item2': 'The KEY tab can add long-lived project facts manually (branch scope selectable); they inject from the next turn;',
  'memoryTab.guide.files.item3': 'Every entry can be edited (injected tracks require confirmation), deleted (exact whole-entry match), archived/promoted.',
  'memoryTab.guide.branch.title': 'Git branch awareness',
  'memoryTab.guide.branch.body': 'Different branches of the same project can carry completely different conventions; project-level memory tracks the current branch end to end:',
  'memoryTab.guide.branch.item1': 'Key entries can carry a branch-scope tag (untagged = visible on every branch); only "untagged + covering current branch" entries are injected;',
  'memoryTab.guide.branch.item2': 'Log entries carry an automatic source-branch tag ([git branch]), so cross-branch reviews never mix things up.',
  'memoryTab.guide.maintain.title': 'Edit & maintain',
  'memoryTab.guide.maintain.body': 'All memory maintenance happens right here:',
  'memoryTab.guide.maintain.item1': 'Edit content only — timestamps/branch/tags are program-maintained;',
  'memoryTab.guide.maintain.item2': 'Delete by exact whole-entry match (never substring — no accidental deletion of longer entries containing it), irreversible;',
  'memoryTab.guide.maintain.item3': 'Archive/promote: memory/user/key ↔ archive files, both directions; archived entries are never injected and can be promoted back anytime.',
  'memoryTab.guide.suggestions.title': 'Memory suggestions',
  'memoryTab.guide.suggestions.body': 'Review-produced memory suggestions enter a pending queue first (confirmation system — the AI proposes, you decide):',
  'memoryTab.guide.suggestions.item1': 'Approve: edit the text if needed, optionally pick the target track (memory/user/key), then it is written and injected with the snapshot;',
  'memoryTab.guide.suggestions.item2': 'Archive: kept out of the injected memory, can be promoted back; Reject: dropped.',
  'memoryTab.guide.confirm.title': 'Confirmation system',
  'memoryTab.guide.confirm.body': 'Memory writes genuinely change the AI\'s behavior (they enter the context and affect later replies), so everything goes through your confirmation first — that is the gate of memory evolution.',
  // Skills-tab guide (the "Guide" sub-tab: detailed intro of the skill feature itself).
  'skillsTab.guide.what.title': 'What a skill is',
  'skillsTab.guide.what.body': 'A skill = a methodology document for the AI (SKILL.md: frontmatter name/description + body): injected into every session\'s system prompt, so the AI follows the process next time it meets the same kind of task.',
  'skillsTab.guide.what.item1': 'The skill library lives in ~/.agents/skills by default (one directory per skill);',
  'skillsTab.guide.what.item2': 'DSH also scans project skills, bundled skills and custom dirs — all visible in this tab.',
  'skillsTab.guide.how.title': 'How skills form',
  'skillsTab.guide.how.body': 'Methodologies learned the hard way can be solidified into skills:',
  'skillsTab.guide.how.item1': 'Background review creates them: new skills land in "Skill suggestions" first, approved ones move into the library;',
  'skillsTab.guide.how.item2': 'The skill_manage tool: the model creates/updates skills directly (read-before-write protection);',
  'skillsTab.guide.how.item3': 'Creation stays restrained: only "repeatedly painful, hard, likely reused later" skills — keep the library lean.',
  'skillsTab.guide.pending.title': 'Skill suggestions',
  'skillsTab.guide.pending.body': 'New skills from review are confirmed here:',
  'skillsTab.guide.pending.item1': 'Approve: moved into the skill library (~/.agents/skills), injected with the system prompt, available to every session;',
  'skillsTab.guide.pending.item2': 'Reject: dropped.',
  'skillsTab.guide.manager.title': 'Skill manager',
  'skillsTab.guide.manager.body': 'The full skill manager (three panes: skill list / directory tree / file view-edit):',
  'skillsTab.guide.manager.item1': 'Every skill grouped by source (user user-* / custom / bundled / project project-*), searchable and filterable;',
  'skillsTab.guide.manager.item2': 'Custom skill dirs: add/remove any skill directory (<dir>/<skill>/SKILL.md or <dir>/<skill>.md layout);',
  'skillsTab.guide.manager.item3': 'File browsing & editing: directory tree + text view/edit (scoped to the skill dir; out-of-scope/binary/oversized rejected);',
  'skillsTab.guide.manager.item4': 'Disabled list and custom dirs persist and restore automatically after restart.',
  'skillsTab.guide.disable.title': 'Disable / enable',
  'skillsTab.guide.disable.body': 'One click removes a skill from the model\'s skill catalog (runtime shadow — the model no longer sees it and the skill tool refuses to load it):',
  'skillsTab.guide.disable.item1': 'Re-enable anytime; the choice persists;',
  'skillsTab.guide.disable.item2': 'System skills (project source) are structurally protected and cannot be disabled.',
  'skillsTab.guide.dirs.title': 'Custom skill directories',
  'skillsTab.guide.dirs.body': 'Add/remove your own skill directories in "Skill manager" (e.g. ~/.hermes/skills); paths overlapping an existing skill root are rejected; persisted and reloaded after restart.',
  'skillsTab.guide.restraint.title': 'Creation discipline',
  'skillsTab.guide.restraint.body': 'Skills are injected into every session\'s system prompt and affect context/cache — create sparingly:',
  'skillsTab.guide.restraint.item1': 'Only create skills that are "hard to solve after repeated tries, high difficulty, likely reused later";',
  'skillsTab.guide.restraint.item2': 'Never create skills for one-off or trivial tasks.',
  // Todos-tab guide (the "Guide" sub-tab: detailed intro of the todo feature itself).
  'todosTab.guide.tracks.title': 'Four todo tracks',
  'todosTab.guide.tracks.body': 'Todos are filed by target, isomorphic to the memory system:',
  'todosTab.guide.tracks.item1': 'Life: personal errands;',
  'todosTab.guide.tracks.item2': 'Work: cross-project tasks;',
  'todosTab.guide.tracks.item3': 'This project: todos of the current working directory (invisible from other dirs — cwd-scoped);',
  'todosTab.guide.tracks.item4': 'Today (daily): per-day todo files, with past days browsable (grouped by date).',
  'todosTab.guide.add.title': 'How to add',
  'todosTab.guide.add.body': 'Two ways:',
  'todosTab.guide.add.item1': 'Tell the AI "remember / I need to do X" (optionally work/life/this project/today) — it files the todo into the right track directly;',
  'todosTab.guide.add.item2': 'Use the add box in this tab (quadrant and due date optional).',
  'todosTab.guide.pending.title': 'Todo suggestions',
  'todosTab.guide.pending.body': 'AI-proposed todos enter a pending queue first — the AI cannot assign you work on its own:',
  'todosTab.guide.pending.item1': 'Approve: written into the matching track (a todo stays a todo — it can never become memory);',
  'todosTab.guide.pending.item2': 'Archive: kept aside; Reject: dropped.',
  'todosTab.guide.attrs.title': 'Status & attributes',
  'todosTab.guide.attrs.body': 'Every todo carries full metadata:',
  'todosTab.guide.attrs.item1': 'Quadrant (q1 important & urgent ~ q4 neither), due date, optional category;',
  'todosTab.guide.attrs.item2': 'Status: pending / doing / done (done timestamp auto-stamped) / blocked / cancelled;',
  'todosTab.guide.attrs.item3': 'List or board view: list filters by track + status/quadrant; board lays out the four Eisenhower quadrants; per-item done/restore, inline edit, delete (confirmed); status badge cycles on click.',
  'todosTab.guide.view.title': 'Smart view',
  'todosTab.guide.view.body': 'By default only items needing attention are shown (overdue / due today / current project / important-urgent, max 8):',
  'todosTab.guide.view.item1': 'Past daily todos load on demand — history is queried only when the "Past" tab is opened;',
  'todosTab.guide.view.item2': 'Expired leftovers stay hidden unless "Show expired" is ticked (no extra load).',
  'todosTab.guide.remind.title': 'Due reminders',
  'todosTab.guide.remind.body': 'The AI checks todos at the end of every turn and reminds you of overdue/due items in its reply — you never have to keep track yourself.',
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
  // List / Eisenhower board view switch
  'todo.view.mode': 'View',
  'todo.view.list': 'List',
  'todo.view.board': 'Board',
  'todo.board.empty': 'No todos in this quadrant',
  'todo.board.cycleStatus': 'Click to cycle status',
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
  'panel.guide.search.desc': 'When memory is not enough and local material is needed, the AI can search by file name — not just documents: images, code, configs, anything relevant to the project (documents only by default; full-type search available when explicitly requested). **Content search** is also available — ask "which document mentions XX" (contentQuery enables it). **Four modes** (under Config): all (name + content) / filename only / content only / off — some people prefer their own content-search implementation, so filename-only is a first-class mode. **Off by default**: the tool is invisible to the model.',
  'panel.guide.coi.title': 'COI dispatch (de_coi)',
  'panel.guide.coi.desc': 'Dispatch tasks to external CLI agents (kimi/codex/grok/hermes…): unified non-blocking scheduling, live progress, auto-tiered session management with one-click resume, cross-COI relay, archived results that also sink into memory. Just say “have kimi/codex do X”, or open the CLI Dispatch tab to dispatch manually. **Disabled by default**: enable the COI dispatch toggle under "Config" in the "Memory Evolve Settings" tab (tools take effect immediately; the tab appears after a refresh).',
  'panel.guide.prompt.title': 'Prompt manager',
  'panel.guide.prompt.desc': 'Turn recurring working paradigms into prompt assets (built-in programmer examples: code review/debugging/architecture/tests…; write your own as the main source). Pick one and inject — the content becomes visible to the model next turn without interrupting the reply; supports one-shot, N consecutive turns, or once every M turns (count and cadence accept any integers, auto-expiring by turn counting), and can be stopped anytime. Quick inject is also supported: type content and inject without saving a prompt first — it is auto-saved to the library (empty category goes to Temp). **Disabled by default**: enable the prompt manager toggle under "Config" in the "Memory Evolve Settings" tab; the tab appears after a refresh.',
  'panel.guide.models.title': 'Model config (de_models)',
  'panel.guide.models.desc': 'The "Model Config" tab + `de_models` tool: a table of every DSH provider and model, with **plugin-side** per-model settings (enabled state, note, thinking support, allowed/recommended reasoning levels — checkable level whitelist, custom levels). **These settings only affect this plugin** (they define the de_models query view and the tab display); **they do not modify or affect DSH\'s own model settings** — DSH model configuration remains whatever the official "Settings → Models" says. **Disabled by default**: turn on "Model config" under "Config" and the tab appears after a refresh, with the de_models tool active.',
  'panel.guide.broadcast.title': 'Session broadcast (de_broadcast)',
  'panel.guide.broadcast.desc': 'Pass messages between DSH sessions: copy this session\'s ID (the "⧉ Copy session ID" button in the session header), send the ID to another session, and let its AI broadcast content back to you via de_broadcast send (recipients can be an array of session IDs; one-to-one by default) — the receiver\'s snapshot gets a targeted unread hint (inbox-style: id + subject + sender + time; visible only to the receiver) and the AI reads/processes it with list/read (explicit-recipient messages are consumed on read and auto-deleted once every recipient read; room/project messages stay 30 days for review); content over 8 KB spills to a file. **Rooms (chat rooms)**: multi-session collaboration (cross-directory) — room-create (creator joins automatically) → share the room id (paste or broadcast) → others room-join → then just say "post to the room" and everyone gets it; room-leave to exit, room-rm to dissolve (creator only), room-list to view; idle rooms are auto-deleted after 30 days. **Project group**: recipients project:/path posts to the whole directory (matched by cwd). **Switch**: independent "Session broadcast" (broadcastEnabled, off by default, can be enabled alone — unrelated to COI dispatch). Also, the snapshot always leads with a persistent "Your session ID" section (regardless of any switch) — the AI uses it to tell who is who in message sender/recipients and shares its ID when replying to a broadcast.',
  'panel.guide.session.title': 'Session search (de_session_search)',
  'panel.guide.session.desc': 'Lets the AI search historical sessions of other local AI tools (Codex for now: plain JSONL under ~/.codex/sessions and archived_sessions — rg prefilter keeps it millisecond-fast; DSH sessions not supported yet) — just ask "did Codex do X before" and the AI finds matching sessions with the strongest message snippet and a context window; case-insensitive literal matching over user/assistant messages only (tool output excluded); cwd filters by project (Codex sessions record their working directory), sort/limit/window control result scale; **zero resident state** — no index, no cache, every call scans read-only in real time and never modifies session files. **Switch**: independent "Session search" (sessionSearchEnabled, off by default, unrelated to COI dispatch/broadcast, can be enabled alone).',
  'panel.guide.sessionOrch.title': 'Session orchestration (de_session)',
  'panel.guide.sessionOrch.desc': 'Lets the AI **programmatically create/wake DSH sessions** ("a session starts another session") — spawn: creates a **standard session** (identical to one opened manually: system prompt/tools/memory snapshot/persistence; appears in the left session list and can be taken over), prompt = the **full instruction text** (role/task freely composed, e.g. "You are the designer… now execute: …"), it starts running immediately; optional cwd / join a broadcast room (roomId) / model override (model); wake: wakes an existing session (sessionId + prompt, equivalent to sending a message on its behalf — its AI wakes up and processes it; queues while busy; auto-resumed after process restart); status/list: inspect state (running = generating / idle = stopped / offline = not in this process, with lastActiveAt). **Collaboration discipline**: nothing auto-wakes sessions — the decision-maker (e.g. a PM session) **deliberately** runs list/status and actively wakes stopped workers (avoids management chaos); **boundary**: only same-process sessions can be woken; waking = sending a message on their behalf (fully visible in their GUI). **Switch**: independent "Session orchestration" (sessionEnabled, off by default, unrelated to COI/broadcast/search, can be enabled alone); pairs well with "Session broadcast" rooms (spawn with roomId joins automatically).',
  'panel.guide.uiSettings.title': 'DSH UI Settings',
  'panel.guide.uiSettings.desc': 'Style-level tweaks for the DSH web GUI (pure client-side injection, no framework changes): per-feature switches live in the "General" sub-tab of the "DSH UI Settings" tab — session filter (left list shows only active sessions), wide conversation area (~95% of the right pane), and more; themes come later.',
  'panel.guide.confirm.title': 'Confirmation (why the AI cannot write directly)',
  'panel.guide.confirm.desc': 'Anything the AI creates — memory, todos, skills — enters a pending queue first and only takes effect after your confirmation. These writes genuinely change the AI: memory enters the prompt, todos are tasks assigned to you, skills change the AI’s toolbox. Unchecked auto-writes could silently enshrine the AI’s misjudgments as facts or assign you work you never asked for. You are the final gatekeeper: the AI proposes, you decide.',
  'panel.guide.best.title': 'Getting the most out of it',
  'panel.guide.best.1': 'Pick up across sessions: say “check the memory” about project conventions/progress — the AI continues from the project log and key facts instead of asking you to repeat.',
  'panel.guide.best.2': 'Dictate as you think: “remember this / follow up on that” — the AI files it automatically; a one-liner days later reconnects the thread.',
  'panel.guide.best.3': 'Confirm periodically: glance at the memory/todo suggestion tabs and adopt or reject — that is the confirmation loop of memory evolution.',
  'panel.guide.best.4': 'Cross-session collaboration: copy your session ID, send it to another session, and have its AI broadcast results back to you via de_broadcast (multiple recipients supported; the receiver sees an unread hint next turn).',
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
  'panel.config.title': 'Config',
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
  'panel.config.coiEnabled': 'COI dispatch',
  'panel.config.coiEnabled.hint': 'Enable the de_coi_* tools and the CLI Dispatch tab: unified dispatch of CLI agents (kimi/codex/grok/hermes…). Off by default — this plugin\'s core is memory/todos/skills, dispatch is an on-demand add-on; when off, the tools and the tab are completely invisible',
  'panel.config.scratchEnabled': 'Scratch pad tab',
  'panel.config.scratchEnabled.hint': 'Enable the Scratch Pad tab: a persistent Markdown note for temporary thoughts (auto-saves to ~/.dsh/memories/scratch.md, survives restarts, ready to migrate or delete anytime). Off by default; when off the tab is completely invisible',
  'panel.config.searchDocsEnabled': 'Local file search tool',
  'panel.config.searchDocsEnabled.hint': 'Lets the model search files across all local disks/directories. **Four modes**: all = name + content search; filename only = content/contentQuery parameters are ignored (never reads file contents — for people who use their own content-search implementation); content only = every call does content matching (query acts as the content keyword); off = the tool is completely invisible to the model. Content search: contentQuery="keyword" answers "which document mentions XX" (rg full-text match, returns hit snippets). Off by default',
  'panel.config.searchDocsMode.all': 'All (name + content)',
  'panel.config.searchDocsMode.filename': 'Filename only',
  'panel.config.searchDocsMode.content': 'Content only',
  'panel.config.searchDocsMode.off': 'Off (tool invisible)',
  'panel.config.broadcastEnabled': 'Session broadcast',
  'panel.config.broadcastEnabled.hint': 'Enable session broadcast (de_broadcast): inter-session messaging — the "Session broadcast" unread hint in the snapshot (inbox-style rows: id+subject+sender+time) + the de_broadcast tool (send/list/read; read consumes and auto-deletes once all recipients read; >8KB spills to a file; 30-day cleanup) + the broadcast management panel tab. **Independent of COI dispatch** (off by default, can be enabled alone); when off, all of the above are invisible; the persistent "Your session ID" snapshot section is unaffected; the header "⧉ Copy session ID" / "✎ alias" buttons belong to "Session orchestration" (the panel top also has a copy entry)',
  'panel.config.sessionSearchEnabled': 'Session search',
  'panel.config.sessionSearchEnabled.hint': 'Enable de_session_search: lets the model search historical sessions of other local AI tools (Codex for now: plain JSONL under ~/.codex/sessions and archived_sessions — rg prefilter keeps it millisecond-fast; DSH sessions not supported yet). Case-insensitive literal matching over user/assistant messages only; supports cwd project filter, relevance/newest/oldest sorting, and limit/window result control. **Independent submodule** (off by default, can be enabled alone — unrelated to COI dispatch/broadcast); zero resident state: no index, no cache, every call scans read-only in real time and never modifies session files; when off the tool is completely invisible to the model',
  'panel.config.sessionEnabled': 'Session orchestration',
  'panel.config.sessionEnabled.hint': 'Enable session orchestration (de_session): lets AI **programmatically create/wake DSH sessions** — spawn creates a standard session (identical to one opened manually: system prompt/tools/memory snapshot/persistence, appears in the left session list and can be taken over), prompt = the full instruction text (role/task freely composed), it starts running immediately; optional cwd / join a broadcast room / model override; wake wakes an existing session (equivalent to sending a message on its behalf — its AI wakes up and processes it, auto-resumed after process restart); status/list inspect state; the header **"⧉ Copy session ID" / "✎ alias" buttons follow this switch** (session-identity features, previously mis-housed under broadcast). **Independent submodule** (off by default; depends on the DSH agents service, only same-process sessions can be woken; when off the tool is invisible to the model)',
  'panel.config.promptsEnabled': 'Prompt manager',
  'panel.config.promptsEnabled.hint': 'Enable the Prompts tab: a prompt library (user-written paradigms + built-in examples) plus an injection track (once / N consecutive turns / every M turns — count and cadence accept any integers; injected content is visible to the model next turn, expires automatically by turn counting, and can be stopped anytime; quick inject works without saving a prompt first, auto-saved to the Temp category). Off by default; when off the snapshot section, event listener and API are fully uninstalled and the tab hides after refresh',
  'panel.config.modelsEnabled': 'Model config',
  'panel.config.modelsEnabled.hint': 'Enable the "Model Config" tab + de_models tool: a table of DSH providers/models with per-model settings (enabled, note, thinking support, allowed/recommended reasoning levels, custom levels); de_models lets the AI query the available model list. **Off by default** (registering takes a slot in the model tool list; turn it on when needed). ⚠️ These settings **only affect this plugin and never modify or affect DSH\'s own model settings** (DSH side stays as the official "Settings → Models" says). When off the tab and tool hide and the API refuses access, settings data is kept',
  'panel.config.uiSettingsEnabled': 'DSH UI Settings',
  'panel.config.uiSettingsEnabled.hint': 'Enable the "DSH UI Settings" module: a filter bar appears above the left session list, showing only active sessions by default (generating / awaiting approval / awaiting answer / subagents running / error / finished-but-unviewed — purely idle ones collapse away), one click switches back to all; pure client-side styling (CSS + DOM injection, no DSH framework changes); the filter preference is remembered in the browser. **Off by default**; when off, the filter bar and injected styles are fully removed',
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

  // COI 调度样式（coi- 前缀，独立注入）。
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-coi-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.coiCss = '1'
    tag.textContent = coiStyles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: coi stylesheet')

  // 会话广播样式（bb- 前缀，独立注入）。
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-broadcast-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.broadcastCss = '1'
    tag.textContent = broadcastStyles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: broadcast stylesheet')

  // 临时信息样式（sp- 前缀，独立注入）。
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-scratch-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.scratchCss = '1'
    tag.textContent = scratchStyles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: scratch stylesheet')

  // 提示词样式（pm- 前缀，独立注入）。
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-prompt-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.promptCss = '1'
    tag.textContent = promptStyles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: prompt stylesheet')

  // DSH UI 设置样式（ui- 前缀，独立注入）。样式本身无副作用：过滤规则
  // 依赖 html[data-dsh-ui-filter] 属性（session-filter.ts 激活后才设置），
  // 无属性时不生效——因此样式常驻注入（与其他模块样式同款），真正的开关
  // 控制在下方：探测 /api/ui-settings/state 成功才激活筛选与注册 Tab。
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-ui-settings-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.uiSettingsCss = '1'
    tag.textContent = uiSettingsStyles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: ui-settings stylesheet')

  // 会话书签样式（bm- 前缀，独立注入）。样式常驻无副作用；真正开关控制
  // 在下方：探测 /api/bookmarks/state 成功才注册 turnTail 星标与「书签」Tab。
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = document.querySelector('style[data-bookmark-css]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.bookmarkCss = '1'
    tag.textContent = bookmarkStyles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'memory-evolve: bookmark stylesheet')

  // 会话页三个核心 tab：记忆 / 技能 / 待办（conversation.view，依次排列）。
  // 每个 label 携带各自的待确认红点计数（记忆=记忆建议数、技能=技能建议数、
  // 待办=待办建议数），badge 变化时重新注册触发 label 重求值。
  let tabCancelled = false
  let memoryBadgeCount = 0
  let skillsBadgeCount = 0
  let todosBadgeCount = 0
  let disposeMemoryTab: (() => void) | undefined
  let disposeSkillsTab: (() => void) | undefined
  let disposeTodosTab: (() => void) | undefined

  const registerMemoryTab = (): void => {
    disposeMemoryTab?.()
    disposeMemoryTab = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: 'memory-files',
        order: 20,
        label: () => (memoryBadgeCount > 0 ? t('memoryTab.label.pending', { count: memoryBadgeCount }) : t('memoryTab.label')),
      }, (props) => MemoryTabView({ ...props, t })))
  }
  const registerSkillsTab = (): void => {
    disposeSkillsTab?.()
    disposeSkillsTab = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: 'skills-hub',
        order: 21,
        label: () => (skillsBadgeCount > 0 ? t('skillsTab.label.pending', { count: skillsBadgeCount }) : t('skillsTab.label')),
      }, (props) => SkillsTabView({ ...props, t })))
  }
  const registerTodosTab = (): void => {
    disposeTodosTab?.()
    disposeTodosTab = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: 'todos-hub',
        order: 22,
        label: () => (todosBadgeCount > 0 ? t('todosTab.label.pending', { count: todosBadgeCount }) : t('todosTab.label')),
      }, (props) => TodosTabView({ ...props, t })))
  }
  // 设置 Tab（Memory Evolve 设置，order 45 放最后）：整体指南 + 配置。
  // 无红点计数，注册一次即可；跟随 memoryTabEnabled 开关（与核心三 tab 一致）。
  let disposeSettingsTab: (() => void) | undefined
  const registerSettingsTab = (): void => {
    disposeSettingsTab?.()
    disposeSettingsTab = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: 'settings-hub',
        order: 45,
        label: () => t('settingsTab.label'),
      }, (props) => SettingsTabView({ ...props, t })))
  }
  // 模型配置 Tab（order 23，紧挨待办之后）：表格展示 DSH 供应商/模型 +
  // 每模型启用/备注/思考等级配置（de_models 工具的 Web 数据面）。
  // 与其他模块同款独立开关 modelsEnabled（默认开）：开关在「设置」Tab 的
  // 「配置」里切换，开启后刷新页面出现；关闭时 Tab 完全不可见（host 的
  // /api/models 路由在模块关闭时返回"未启用"）。
  let disposeModelsTab: (() => void) | undefined
  const registerModelsTab = (): void => {
    disposeModelsTab?.()
    disposeModelsTab = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: 'models-hub',
        order: 23,
        label: () => t('modelsTab.label'),
      }, (props) => ModelsTabView({ ...props, t })))
  }
  const pollBadge = (): void => {
    // 三个 tab 未注册前不轮询（registerMemoryTab 是探测成功的标志）。
    if (tabCancelled || disposeMemoryTab === undefined) return
    void fetch('/memory-evolve/api/badge')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { suggestions?: number; skills?: number; todoSuggestions?: number }) => {
        const suggestions = data.suggestions ?? 0
        const skills = data.skills ?? 0
        const todoSuggestions = data.todoSuggestions ?? 0
        if (suggestions !== memoryBadgeCount) {
          memoryBadgeCount = suggestions
          registerMemoryTab()
        }
        if (skills !== skillsBadgeCount) {
          skillsBadgeCount = skills
          registerSkillsTab()
        }
        if (todoSuggestions !== todosBadgeCount) {
          todosBadgeCount = todoSuggestions
          registerTodosTab()
        }
      })
      .catch(() => { /* badge is best-effort; the tab still works */ })
  }

  void fetch('/memory-evolve/api/config')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((data: { config?: { memoryTabEnabled?: boolean; scratchEnabled?: boolean; modelsEnabled?: boolean } }) => {
      // 模型配置 tab：跟随 modelsEnabled 运行时开关（默认开，与其他模块
      // 同款独立开关，在「设置」Tab 的「配置」里切换；开启后刷新页面出现）。
      if (!tabCancelled && data.config?.modelsEnabled === true && disposeModelsTab === undefined) {
        registerModelsTab()
      }
      // 临时信息 tab：受 scratchEnabled 运行时开关控制（默认关闭，与
      // COI/提示词一致）。开关在「Memory Evolve 设置」Tab 的「配置」里切换，
      // 开启后刷新页面即出现；关闭时 Tab 完全不可见（host 的
      // /api/scratch 路由仍常驻——纯文件读写、零副作用，不随开关卸载）。
      if (!scratchCancelled && data.config?.scratchEnabled === true && disposeScratchTab === undefined) {
        disposeScratchTab = ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'scratch-pad',
            order: 40,
            label: () => t('scratchTab.label'),
          }, (props) => ScratchView({ ...props, t })))
      }
      // memoryTabEnabled is a read-only field of /api/config (default true;
      // only config.yaml can turn it off — deliberately NOT a runtime key,
      // since switching it off from inside the tab would hide the tab itself).
      if (tabCancelled || data.config?.memoryTabEnabled !== true) return
      // 四个核心 tab 一起注册：记忆 / 技能 / 待办 / 设置（顺序 20/21/22/45）。
      registerMemoryTab()
      registerSkillsTab()
      registerTodosTab()
      registerSettingsTab()
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
    disposeMemoryTab?.()
    disposeSkillsTab?.()
    disposeTodosTab?.()
    disposeSettingsTab?.()
  }, 'memory-evolve: memory tabs')

  // 临时信息 Tab 的清理（注册本身在 /api/config 探测成功后进行）。
  let scratchCancelled = false
  let disposeScratchTab: (() => void) | undefined
  ctx.effect(() => () => {
    scratchCancelled = true
    disposeScratchTab?.()
  }, 'memory-evolve: scratch tab')

  // 模型配置 Tab 的清理（注册本身在 /api/config 探测成功后进行——
  // 与其他模块同款独立开关 modelsEnabled）。
  ctx.effect(() => () => {
    disposeModelsTab?.()
  }, 'memory-evolve: models tab')

  // COI 调度 Tab（conversation.view 第二个 slot）：探测 host 端 COI API
  // 存在才注册（coiEnabled=false 时 API 404，Tab 自动隐藏）。label 带红点
  // 计数：有运行中/排队中任务（按当前会话可见性）时显示「🔴 COI调度 (N)」
  // ——30s 轮询任务列表 + 监听 badge-change 事件（派发任务后即时刷新）；
  // 计数变化时重新注册触发 label 重求值（与记忆/技能/待办 Tab 同机制）。
  let coiCancelled = false
  let disposeCoiTab: (() => void) | undefined
  let coiRunningCount = 0
  /** 当前会话 id：由 COI Tab 渲染时缓存（任务可见性按会话过滤的依据）。 */
  let currentCoiSessionId: string | undefined

  const registerCoiTab = (): void => {
    disposeCoiTab?.()
    disposeCoiTab = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: 'coi-hub',
        order: 30,
        label: () => (coiRunningCount > 0 ? t('coiTab.label.pending', { count: coiRunningCount }) : t('coiTab.label')),
      }, (props) => {
        currentCoiSessionId = (props as { sessionId?: string }).sessionId
        return CoIView({ ...props, t })
      }))
  }

  const pollCoiRunning = (): void => {
    if (coiCancelled || disposeCoiTab === undefined) return
    // 带会话视角查询（与任务列表同规则：temporary/session=本会话、project=本
    // 工作区、global=全显）；limit 放宽到 200，运行中任务不可能超此量。
    const q = currentCoiSessionId !== undefined
      ? `?limit=200&sessionId=${encodeURIComponent(currentCoiSessionId)}`
      : '?limit=200'
    void fetch(`/memory-evolve/api/coi/tasks${q}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { tasks?: Array<{ status?: string }> }) => {
        const running = (data.tasks ?? []).filter((t) => t.status === 'running' || t.status === 'queued').length
        if (running !== coiRunningCount) {
          coiRunningCount = running
          registerCoiTab()
        }
      })
      .catch(() => { /* 红点是尽力而为；Tab 本身不受影响 */ })
  }

  void fetch('/memory-evolve/api/coi/config')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then(() => {
      if (coiCancelled) return
      registerCoiTab()
      pollCoiRunning()
      const coiTimer = setInterval(pollCoiRunning, BADGE_POLL_MS)
      ctx.effect(() => () => clearInterval(coiTimer), 'memory-evolve: coi tab badge poller')
      // 派发任务/任务状态变化后（CoIView 触发 badge-change）立即重查红点。
      const onCoiBadgeChange = (): void => pollCoiRunning()
      window.addEventListener('dsh-memory-evolve:badge-change', onCoiBadgeChange)
      ctx.effect(() => () => window.removeEventListener('dsh-memory-evolve:badge-change', onCoiBadgeChange), 'memory-evolve: coi tab badge listener')
    })
    .catch(() => { /* COI 未启用：Tab 保持隐藏 */ })
  ctx.effect(() => () => {
    coiCancelled = true
    disposeCoiTab?.()
  }, 'memory-evolve: coi tab')

  // 会话身份配套：会话头部「⧉ 复制会话 ID」「✎ 别名」按钮——**属于会话
  // 编排/身份**（用户拍板 2026-08-09：不是广播的功能，从 broadcastEnabled
  // 迁移到 sessionEnabled）。用户把当前会话 ID/别名复制给另一个会话，
  // 对方 AI 用 de_broadcast 广播或 de_session 编排；广播面板顶部另有
  // 「我的会话 ID 复制」，只开广播不开会话编排时复制能力仍可用。
  let sessionHeaderCancelled = false
  let disposeCopyId: (() => void) | undefined
  void fetch('/memory-evolve/api/config')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((data: { config?: { sessionEnabled?: boolean } }) => {
      if (sessionHeaderCancelled || data.config?.sessionEnabled !== true) return
      // 头部 actions 是 strict-session slot：entry 组件自动收到 sessionId。
      disposeCopyId = ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'copy-session-id',
          order: 0,
        }, (props) => HeaderActions({ ...props, t })))
    })
    .catch(() => { /* 会话编排未启用：头部按钮保持隐藏 */ })
  ctx.effect(() => () => {
    sessionHeaderCancelled = true
    disposeCopyId?.()
  }, 'memory-evolve: session header buttons')

  // 会话广播管理 Tab（conversation.view）：跟随 broadcastEnabled——探测
  // /memory-evolve/api/broadcast 存在才注册（未启用时 API 404，Tab 隐藏）。
  let broadcastTabCancelled = false
  let disposeBroadcastTab: (() => void) | undefined
  void fetch('/memory-evolve/api/broadcast/messages')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then(() => {
      if (broadcastTabCancelled) return
      disposeBroadcastTab = ctx.slots.inject('conversation.view', () =>
        ctx.slots.register({
          name: 'conversation.view',
          id: 'broadcast-hub',
          order: 32,
          label: () => t('broadcastTab.label'),
        }, (props) => BroadcastView({ ...props, t })))
    })
    .catch(() => { /* 广播未启用：Tab 保持隐藏 */ })
  ctx.effect(() => () => {
    broadcastTabCancelled = true
    disposeBroadcastTab?.()
  }, 'memory-evolve: broadcast tab')

  // DSH UI 设置模块（dsh-ui-settings）：**独立子模块**。探测宿主端
  // /api/ui-settings/state（uiSettingsEnabled 开关，默认关）——成功才：
  //  DSH UI 设置模块（dsh-ui-settings）：**独立子模块**。探测宿主端
  //  /api/ui-settings/state（uiSettingsEnabled 开关，默认关）——成功才：
  //   1. 激活各功能（全局 DOM 增强，不依赖任何 Tab 打开）：
  //      - 会话筛选（session-filter.ts：筛选条 + MutationObserver 保活 +
  //        localStorage 偏好，默认只显示进行中的会话）；
  //      - 对话区加宽（wide-chat.ts：--dsh-chat-content-width 变量覆盖）；
  //      每个功能有**独立小开关**（「综合」子 tab，localStorage + 事件
  //      广播）：初始按 readFeatures() 应用，FEATURES_EVENT 时即时同步；
  //   2. 注册「DSH UI 设置」Tab（conversation.view，综合/指南界面）。
  //  模块关闭（端点 404）时全部不注入；清理 effect 一并卸载。
  let uiSettingsCancelled = false
  let disposeUiSettingsTab: (() => void) | undefined
  let disposeSessionFilter: (() => void) | undefined
  let disposeWideChat: (() => void) | undefined
  let disposeWideBubble: (() => void) | undefined
  void fetch('/memory-evolve/api/ui-settings/state')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((data: { enabled?: boolean }) => {
      if (uiSettingsCancelled || data.enabled !== true) return
      // 1. 创建各功能控制器（先创建、后按开关状态 setEnabled）。
      const sessionFilter = createSessionFilter({
        barTitle: t('uiSettings.feature.sessionFilter'),
        on: t('uiSettings.filter.on'),
        off: t('uiSettings.filter.off'),
        runningLabel: t('uiSettings.running.label'),
        ungroupedLabel: t('uiSettings.ungrouped'),
      })
      disposeSessionFilter = sessionFilter.dispose
      const wideChat = createWideChat()
      disposeWideChat = wideChat.dispose
      const wideBubble = createWideBubble()
      disposeWideBubble = wideBubble.dispose
      // 按「综合」子 tab 的独立开关应用初始状态。
      const features = readFeatures()
      sessionFilter.setEnabled(features.sessionFilter)
      wideChat.setEnabled(features.wideChat)
      wideBubble.setEnabled(features.wideBubble)
      // 开关变更事件（UiSettingsTabView 切换后广播）→ 即时同步注入。
      const onFeaturesChanged = (event: Event): void => {
        const next = (event as CustomEvent<ReturnType<typeof readFeatures>>).detail
        if (next === undefined) return
        sessionFilter.setEnabled(next.sessionFilter)
        wideChat.setEnabled(next.wideChat)
        wideBubble.setEnabled(next.wideBubble)
      }
      window.addEventListener(FEATURES_EVENT, onFeaturesChanged)
      ctx.effect(() => () => window.removeEventListener(FEATURES_EVENT, onFeaturesChanged), 'memory-evolve: ui-settings features listener')
      // 2. 注册「DSH UI 设置」Tab。
      disposeUiSettingsTab = ctx.slots.inject('conversation.view', () =>
        ctx.slots.register({
          name: 'conversation.view',
          id: 'ui-settings-hub',
          order: 46,
          label: () => t('uiSettingsTab.label'),
        }, (props) => UiSettingsTabView({ ...props, t })))
    })
    .catch(() => { /* DSH UI 设置未启用：不注入任何东西 */ })
  ctx.effect(() => () => {
    uiSettingsCancelled = true
    disposeUiSettingsTab?.()
    disposeSessionFilter?.()
    disposeWideChat?.()
    disposeWideBubble?.()
  }, 'memory-evolve: ui-settings tab')

  // 提示词 Tab（conversation.view 第四个 entry）：提示词管理器。跟随 host
  // API 探测注册（prompts 模块为插件常驻能力，无独立开关）。label 带红点
  // 计数：有活跃注入时显示「🔴 提示词 (N)」——30s 轮询注入轨 + 监听
  // badge-change 事件（注入/停止后 PromptView 即时触发）刷新。
  let promptCancelled = false
  let disposePromptTab: (() => void) | undefined
  let promptBadgeCount = 0
  const registerPromptTab = (): void => {
    disposePromptTab?.()
    disposePromptTab = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: 'prompt-hub',
        order: 35,
        label: () => promptBadgeCount > 0
          ? t('promptTab.label.active', { count: promptBadgeCount })
          : t('promptTab.label'),
      }, (props) => PromptView({ ...props, t })))
  }
  const pollPromptBadge = (): void => {
    if (promptCancelled || disposePromptTab === undefined) return
    void fetch('/memory-evolve/api/prompts/injections')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { injections?: unknown[] }) => {
        const count = data.injections?.length ?? 0
        if (count !== promptBadgeCount) {
          promptBadgeCount = count
          registerPromptTab()
        }
      })
      .catch(() => { /* badge is best-effort; the tab still works */ })
  }
  void fetch('/memory-evolve/api/prompts/sources')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then(() => {
      if (promptCancelled) return
      registerPromptTab()
      pollPromptBadge()
      const promptBadgeTimer = setInterval(pollPromptBadge, BADGE_POLL_MS)
      ctx.effect(() => () => clearInterval(promptBadgeTimer), 'memory-evolve: prompt tab badge poller')
      const onPromptBadgeChange = (): void => pollPromptBadge()
      window.addEventListener('dsh-memory-evolve:badge-change', onPromptBadgeChange)
      ctx.effect(() => () => window.removeEventListener('dsh-memory-evolve:badge-change', onPromptBadgeChange), 'memory-evolve: prompt tab badge listener')
    })
    .catch(() => { /* host 端不可用：Tab 保持隐藏 */ })
  ctx.effect(() => () => {
    promptCancelled = true
    disposePromptTab?.()
  }, 'memory-evolve: prompt tab')

  // 会话书签（session bookmarks）：**独立子模块**。探测宿主端
  // /api/bookmarks/state（bookmarkEnabled 开关，默认关）——成功才：
  //   1. 星标按钮 DOM 注入器（B 方案，用户拍板：**不占** conversation.chat.
  //      turnTail chain 槽——该槽与官方 produced-files 行互斥（first-wins），
  //      占用会把官方"生成的文件"行挤掉；改为 MutationObserver 把星标
  //      "贴"到轮尾操作区旁，官方行保留，两者共存）；
  //   2. 会话 id 捕获器（conversation.session.header.actions list 槽的隐藏
  //      entry：strict-session slot 自动带 sessionId，渲染 null 零 UI，只
  //      把当前会话 id 写入模块变量供注入器读取——DOM 注入拿不到 id）；
  //   3. 注册「书签」Tab（conversation.view，列表 + 跳转 + 指南）。
  // 关闭时端点 404，客户端全部不注入。
  let bookmarkCancelled = false
  let disposeBookmarkTab: (() => void) | undefined
  let disposeBookmarkCapture: (() => void) | undefined
  let disposeBookmarkInjector: (() => void) | undefined
  let currentBookmarkSessionId = '' // 由捕获器写入，注入器点击时读取
  let bookmarkInjectorStarted = false // 防重复创建（捕获器可能多次渲染）
  void fetch('/memory-evolve/api/bookmarks/state')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((data: { enabled?: boolean }) => {
      if (bookmarkCancelled || data.enabled !== true) return
      // 1. 会话 id 捕获器（header.actions 是 list 槽，可与官方/插件其他按钮共存）。
      disposeBookmarkCapture = ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'bookmark-session-catcher',
          order: 100, // 末尾：隐藏 entry，零 UI
        }, (props) => {
          // strict-session slot：props 自带 sessionId。
          const sid = (props as { sessionId?: string }).sessionId
          if (typeof sid === 'string' && sid !== '') currentBookmarkSessionId = sid
          // 捕获到 id 后启动注入器（懒启动，保证 getSessionId 有值可读）。
          if (!bookmarkInjectorStarted) {
            bookmarkInjectorStarted = true
            disposeBookmarkInjector = createBookmarkInjector(
              () => currentBookmarkSessionId,
              { t },
            ).dispose
          }
          return null // 不渲染任何 UI
        }))
      // 2. 「书签」Tab（order 33：紧挨广播 32 之后、提示词 35 之前）。
      disposeBookmarkTab = ctx.slots.inject('conversation.view', () =>
        ctx.slots.register({
          name: 'conversation.view',
          id: 'bookmarks-hub',
          order: 33,
          label: () => t('bookmarkTab.label'),
        }, (props) => BookmarksView({ ...props, t })))
    })
    .catch(() => { /* 书签未启用：不注入任何东西 */ })
  ctx.effect(() => () => {
    bookmarkCancelled = true
    disposeBookmarkInjector?.()
    disposeBookmarkCapture?.()
    disposeBookmarkTab?.()
  }, 'memory-evolve: bookmarks')
}
