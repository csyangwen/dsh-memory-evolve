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
import { deferRegistration, type Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { MemoryPanel, type MemoryPanelProps } from './MemoryPanel.tsx'
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
  'panel.suggestions.title': '待确认记忆建议',
  'panel.suggestions.empty': '没有待确认的建议。',
  'panel.suggestions.help': '后台审查产出的全局记忆建议，采纳后写入记忆文件并随快照注入。',
  'panel.suggestions.approve': '采纳',
  'panel.suggestions.reject': '拒绝',
  'panel.suggestions.approveAll': '全部采纳',
  'panel.suggestions.rejectAll': '全部拒绝',
  'panel.suggestions.done': '操作完成：{text}',
  'panel.config.title': '运行时配置',
  'panel.config.help': '修改立即生效并持久化（覆盖 config.yaml 的对应项）。',
  'panel.config.reviewEnabled': '后台审查',
  'panel.config.reviewEnabled.hint': '回合结束/终局/手动触发审查',
  'panel.config.reviewInterval': '审查间隔（回合）',
  'panel.config.reviewInterval.hint': '每 N 个用户回合审查一次',
  'panel.config.reviewMode': '全局记忆写入模式',
  'panel.config.reviewMode.suggest': '建议确认（推荐）',
  'panel.config.reviewMode.auto': '自动写入（需批准）',
  'panel.config.skillReviewEnabled': '技能自动沉淀',
  'panel.config.injectProjectMemory': '注入项目记忆',
  'panel.config.injectDailySummary': '注入今日摘要',
  'panel.config.save': '保存配置',
  'panel.config.saved': '配置已保存并生效',
  'panel.config.failed': '操作失败：{message}',
  'panel.loading': '加载中…',
}

/** English dictionary (same key set). */
export const en: Record<MemoryEvolveKey, string> = {
  'tab.label': 'Memory',
  'tab.label.count': 'Memory ({count})',
  'panel.suggestions.title': 'Pending memory suggestions',
  'panel.suggestions.empty': 'No pending suggestions.',
  'panel.suggestions.help': 'Global-track suggestions produced by the background review. Approving writes them into the memory files, injected with the snapshot.',
  'panel.suggestions.approve': 'Approve',
  'panel.suggestions.reject': 'Reject',
  'panel.suggestions.approveAll': 'Approve all',
  'panel.suggestions.rejectAll': 'Reject all',
  'panel.suggestions.done': 'Done: {text}',
  'panel.config.title': 'Runtime config',
  'panel.config.help': 'Changes apply immediately and persist (overriding the config.yaml entries).',
  'panel.config.reviewEnabled': 'Background review',
  'panel.config.reviewEnabled.hint': 'Review on interval / session end / manual trigger',
  'panel.config.reviewInterval': 'Review interval (turns)',
  'panel.config.reviewInterval.hint': 'One review per N user turns',
  'panel.config.reviewMode': 'Global memory write mode',
  'panel.config.reviewMode.suggest': 'Suggest (recommended)',
  'panel.config.reviewMode.auto': 'Auto write (approval required)',
  'panel.config.skillReviewEnabled': 'Skill auto-harvest',
  'panel.config.injectProjectMemory': 'Inject project memory',
  'panel.config.injectDailySummary': 'Inject daily summary',
  'panel.config.save': 'Save config',
  'panel.config.saved': 'Config saved and applied',
  'panel.config.failed': 'Failed: {message}',
  'panel.loading': 'Loading…',
}

/** Badge poll interval (ms). */
const BADGE_POLL_MS = 30_000

/**
 * The plugin entry: register locale, stylesheet, the settings section, and
 * the badge poller.
 * @param ctx - the client plugin context (`slots`, `locale` injected).
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
}
