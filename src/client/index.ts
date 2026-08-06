/**
 * dsh-memory-evolve — client entry.
 *
 * Registers the "记忆管理" (Memory) section into the settings panel
 * ('settings.section'). The section shows the pending memory-suggestion
 * queue with approve/reject actions and a runtime-config form backed by the
 * node half's /memory-evolve/api routes. The settings nav row label carries
 * a numeric badge of pending suggestions, refreshed by polling the badge
 * endpoint and re-registering through the deferral handle's refresh().
 */
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row lives in ui-conversation.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { deferRegistration, type Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { MemoryPanel, type MemoryPanelProps } from './MemoryPanel.tsx'
import { MemoryTabView } from './MemoryTabView.tsx'
import styles from './styles.css'

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
  'tab.label': '记忆管理',
  'tab.label.count': '记忆管理 ({count})',
  'memoryTab.label': '记忆',
  'memoryTab.cwd': '当前会话工作目录',
  'memoryTab.loading': '加载中…',
  'memoryTab.warning': '以下文件为 § 分隔的结构化记忆，用系统工具打开后请谨慎编辑，随意修改可能破坏格式、导致记忆读取错乱。',
  'memoryTab.readonly': '只读',
  'memoryTab.open': '打开文件',
  'memoryTab.opened': '已用系统工具打开',
  'memoryTab.empty': '（文件不存在或为空）',
  'memoryTab.noCwd': '（当前会话无工作目录，无法定位项目记忆）',
  'memoryTab.truncated': '（内容过长，已截断显示）',
  'panel.suggestions.title': '待确认记忆建议',
  'panel.suggestions.empty': '没有待确认的建议。',
  'panel.suggestions.help': '后台审查产出的全局记忆建议，采纳后写入记忆文件并随快照注入。',
  'panel.suggestions.approve': '采纳',
  'panel.suggestions.editHint': '采纳前可修改文本，修改后的内容将写入记忆。',
  'panel.suggestions.reject': '拒绝',
  'panel.suggestions.approveAll': '全部采纳',
  'panel.suggestions.rejectAll': '全部拒绝',
  'panel.suggestions.hits': '已建议 {count} 次',
  'panel.suggestions.hitsHint': '该内容在多轮审查中反复出现，值得认真确认',
  'panel.suggestions.done': '操作完成：{text}',
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
  'panel.config.memoryTabEnabled': '会话页记忆 Tab',
  'panel.config.memoryTabEnabled.hint': '在会话页顶部显示「记忆」Tab（展示 AGENTS.md 与四轨记忆文件，全部只读）；默认关闭，开启后需刷新页面生效',
  'panel.config.perTurnProjectWrites': '每回合写入项目记忆',
  'panel.config.perTurnProjectWrites.hint': '要求模型每个回合结束前主动检查并记录项目相关新事实（关键决策/进展/踩坑）；关闭后项目记忆仅按需读取。⚠️ 依赖 LLM 指令遵循，弱遵循的模型不一定会执行',
  'panel.config.perTurnDailyWrites': '每回合写入每日日志',
  'panel.config.perTurnDailyWrites.hint': '要求模型每个回合结束前主动检查并记录当天进展；关闭后每日日志仅按需读取。⚠️ 依赖 LLM 指令遵循，弱遵循的模型不一定会执行',
  'panel.config.save': '保存配置',
  'panel.reveal.title': '打开文件',
  'panel.reveal.help': '用系统工具打开记忆目录与记忆文件。⚠️ 随意编辑可能破坏 § 分隔格式、导致记忆读取错乱，请谨慎修改。',
  'panel.reveal.memoryDir': '记忆目录',
  'panel.reveal.memoryFile': '全局记忆',
  'panel.reveal.userFile': '用户档案',
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
  'tab.label': 'Memory',
  'tab.label.count': 'Memory ({count})',
  'memoryTab.label': 'Memory',
  'memoryTab.cwd': 'Session working directory',
  'memoryTab.loading': 'Loading…',
  'memoryTab.warning': 'These files are §-delimited structured memory. If you open them with a system tool, edit with caution — careless changes can break the format and corrupt memory reads.',
  'memoryTab.readonly': 'Read-only',
  'memoryTab.open': 'Open file',
  'memoryTab.opened': 'Opened with the system tool',
  'memoryTab.empty': '(missing or empty)',
  'memoryTab.noCwd': '(no working directory for this session — project memory unavailable)',
  'memoryTab.truncated': '(content truncated for display)',
  'panel.suggestions.title': 'Pending memory suggestions',
  'panel.suggestions.empty': 'No pending suggestions.',
  'panel.suggestions.help': 'Global-track suggestions produced by the background review. Approving writes them into the memory files, injected with the snapshot.',
  'panel.suggestions.approve': 'Approve',
  'panel.suggestions.editHint': 'You may edit the text before approving; the edited text is what gets written.',
  'panel.suggestions.reject': 'Reject',
  'panel.suggestions.approveAll': 'Approve all',
  'panel.suggestions.rejectAll': 'Reject all',
  'panel.suggestions.hits': 'Suggested {count}×',
  'panel.suggestions.hitsHint': 'This fact resurfaced across several reviews — worth a careful look',
  'panel.suggestions.done': 'Done: {text}',
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
  'panel.config.memoryTabEnabled': 'Session memory tab',
  'panel.config.memoryTabEnabled.hint': 'Show the 记忆 tab in the session view ring (AGENTS.md + the four memory tracks, all read-only); off by default, takes effect after a page reload',
  'panel.config.perTurnProjectWrites': 'Per-turn project writes',
  'panel.config.perTurnProjectWrites.hint': 'Require the model to check at the end of every turn and record project-related facts (decisions/progress/pitfalls); when off, project memory is read on demand only. ⚠️ Relies on LLM instruction following — weaker models may not comply',
  'panel.config.perTurnDailyWrites': 'Per-turn daily writes',
  'panel.config.perTurnDailyWrites.hint': 'Require the model to check at the end of every turn and record the day\'s progress; when off, the daily log is read on demand only. ⚠️ Relies on LLM instruction following — weaker models may not comply',
  'panel.config.save': 'Save config',
  'panel.reveal.title': 'Open files',
  'panel.reveal.help': 'Open the memory directories and files with your system tools. ⚠️ Careless edits can break the §-delimited format and corrupt memory reads — edit with caution.',
  'panel.reveal.memoryDir': 'Memory dir',
  'panel.reveal.memoryFile': 'Global memory',
  'panel.reveal.userFile': 'User profile',
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
 * The plugin entry: register locale, stylesheet, the settings section, and
 * the badge poller. 'conversation' is an ordering edge for the session
 * memory tab (its 'conversation.view' slot is declared by ui-conversation).
 * @param ctx - the client plugin context (`slots`, `locale` injected).
 */
export const inject = ['slots', 'locale', 'conversation']

/**
 * Client plugin body: register the settings section (badge-refreshed) and —
 * when the host switch is on — the session memory tab.
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

  let badgeCount = 0
  const deferral = deferRegistration(ctx.slots, 'settings.section', MemoryPanel, () =>
    ctx.slots.register({
      name: 'settings.section',
      id: 'memory-evolve',
      order: 30,
      label: () => (badgeCount > 0 ? t('tab.label.count', { count: badgeCount }) : t('tab.label')),
      inject: () => ({ t, refresh: () => pollBadge(true) }),
    }, (props: MemoryPanelProps) => MemoryPanel(props)))

  const pollBadge = (force = false): void => {
    void fetch('/memory-evolve/api/badge')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { count?: number }) => {
        const count = data.count ?? 0
        if (force || count !== badgeCount) {
          badgeCount = count
          deferral.refresh()
        }
      })
      .catch(() => { /* badge is best-effort; the section still works */ })
  }
  pollBadge()
  const timer = setInterval(() => pollBadge(), BADGE_POLL_MS)
  ctx.effect(() => () => {
    clearInterval(timer)
    deferral.dispose()
  }, 'memory-evolve: badge poller')

  // Session memory tab (conversation.view), shown only when the host switch
  // is on (settings panel, default off). The switch is read asynchronously at
  // boot; flipping it takes effect after a page reload.
  let tabCancelled = false
  void fetch('/memory-evolve/api/config')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((data: { config?: { memoryTabEnabled?: boolean } }) => {
      if (tabCancelled || data.config?.memoryTabEnabled !== true) return
      ctx.slots.register({
        name: 'conversation.view',
        id: 'memory-files',
        order: 20,
        label: () => t('memoryTab.label'),
      }, (props) => MemoryTabView({ ...props, t }))
    })
    .catch(() => { /* the tab is optional; a failure just leaves it hidden */ })
  ctx.effect(() => () => { tabCancelled = true }, 'memory-evolve: memory tab')
}
