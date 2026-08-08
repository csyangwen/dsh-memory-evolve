/**
 * dsh-memory-evolve — todos tab (conversation.view entry).
 *
 * 独立待办 Tab（从原「记忆技能待办」Tab 拆分而来）：两个子 tab——
 *   「待确认待办管理」：后台审查产出的待办建议队列，采纳后写入对应待办轨
 *     （生活/工作/本项目/今日；待办建议不可改分类——待办永远是待办）
 *     （MemoryQueueView feature='todo-suggestions'）；
 *   「待办」：四轨待办管理器（生活/工作/项目/每日），列表 + 状态/象限
 *     过滤 + 快捷添加 + 逐条完成/编辑/删除（TodoView）。
 *
 * 子 tab 徽标显示待确认待办数（/api/badge 的 todoSuggestions 字段）：
 * 30s 轮询 + 监听 dsh-memory-evolve:badge-change 事件即时刷新；任一队列
 * 变更后由 onChanged 主动触发事件，让会话页标签的小红点同步更新。
 *
 * 样式复用 mt- 前缀（styles.css：mt-panel / mt-file-tabs / mt-feature-count）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { MemoryQueueView } from './MemoryQueueView.tsx'
import { TodoView } from './TodoView.tsx'
import { TabGuideView, type GuideSection } from './TabGuideView.tsx'

/** 待办 Tab 的三个子功能：指南 / 待确认待办管理 / 待办。 */
type TodosFeature = 'guide' | 'todo-suggestions' | 'todo'

/** Locale-bound props（locate namespace：memory-evolve）。 */
export interface TodosTabViewProps {
  t: Translate
}

/** 跨重挂持久化的子 tab 选择（模块级：badge 刷新导致组件重挂后恢复）。 */
let persistedTodosFeature: TodosFeature | null = null

/**
 * 待办 Tab 专属指南内容（「指南」子 Tab）：
 * 详细介绍待办功能本身——四轨、如何添加、待确认待办管理、状态与筛选、
 * 智能视图与到期提醒。文案来自全局 locale（todosTab.guide.* 键组）。
 */
function todosGuideSections(t: Translate): GuideSection[] {
  return [
    {
      icon: '📋',
      title: t('todosTab.guide.tracks.title'),
      body: t('todosTab.guide.tracks.body'),
      items: [
        t('todosTab.guide.tracks.item1'),
        t('todosTab.guide.tracks.item2'),
        t('todosTab.guide.tracks.item3'),
        t('todosTab.guide.tracks.item4'),
      ],
    },
    {
      icon: '➕',
      title: t('todosTab.guide.add.title'),
      body: t('todosTab.guide.add.body'),
      items: [
        t('todosTab.guide.add.item1'),
        t('todosTab.guide.add.item2'),
      ],
    },
    {
      icon: '🔲',
      title: t('todosTab.guide.pending.title'),
      body: t('todosTab.guide.pending.body'),
      items: [
        t('todosTab.guide.pending.item1'),
        t('todosTab.guide.pending.item2'),
      ],
    },
    {
      icon: '🎯',
      title: t('todosTab.guide.attrs.title'),
      body: t('todosTab.guide.attrs.body'),
      items: [
        t('todosTab.guide.attrs.item1'),
        t('todosTab.guide.attrs.item2'),
        t('todosTab.guide.attrs.item3'),
      ],
    },
    {
      icon: '📅',
      title: t('todosTab.guide.view.title'),
      body: t('todosTab.guide.view.body'),
      items: [
        t('todosTab.guide.view.item1'),
        t('todosTab.guide.view.item2'),
      ],
    },
    {
      icon: '⏰',
      title: t('todosTab.guide.remind.title'),
      body: t('todosTab.guide.remind.body'),
    },
  ]
}

/** The conversation view todos tab component. */
export function TodosTabView(props: ConvViewProps & TodosTabViewProps): JSX.Element {
  const { sessionId, t } = props
  /** 当前激活的子 tab（缺省=待确认待办管理）。 */
  const [feature, setFeature] = useState<TodosFeature>(persistedTodosFeature ?? 'todo-suggestions')
  /** 待确认待办数（子 tab 徽标）。 */
  const [todoSuggestionsCount, setTodoSuggestionsCount] = useState(0)

  /** 拉取待确认待办数（尽力而为）。 */
  const pollBadge = useCallback((): void => {
    void fetch('/memory-evolve/api/badge')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { todoSuggestions?: number }) => setTodoSuggestionsCount(data.todoSuggestions ?? 0))
      .catch(() => { /* 徽标尽力而为；功能不受影响 */ })
  }, [])

  // 同步子 tab 选择到模块级：badge 刷新导致的组件重挂后恢复。
  useEffect(() => { persistedTodosFeature = feature }, [feature])

  // 30s 轮询徽标 + 监听 badge-change 事件（队列变更后即时刷新）。
  useEffect(() => {
    pollBadge()
    const timer = window.setInterval(pollBadge, 30_000)
    const onChange = (): void => pollBadge()
    window.addEventListener('dsh-memory-evolve:badge-change', onChange)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('dsh-memory-evolve:badge-change', onChange)
    }
  }, [pollBadge])

  return (
    <div className="mt-panel">
      {/* 子 tab 条：指南 / 待确认待办管理 / 待办 */}
      <div className="mt-file-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'guide'}
          className={feature === 'guide' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature('guide')}
        >
          {t('todosTab.feature.guide')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'todo-suggestions'}
          className={feature === 'todo-suggestions' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature('todo-suggestions')}
        >
          {t('todosTab.feature.todoSuggestions')}
          {todoSuggestionsCount > 0 && <span className="mt-feature-count">{todoSuggestionsCount}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'todo'}
          className={feature === 'todo' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature('todo')}
        >
          {t('todosTab.feature.todo')}
        </button>
      </div>
      {feature === 'guide' ? (
        <TabGuideView sections={todosGuideSections(t)} />
      ) : feature === 'todo' ? (
        <TodoView t={t} sessionId={String(sessionId)} />
      ) : (
        <MemoryQueueView
          t={t}
          feature="todo-suggestions"
          onChanged={() => {
            // 队列变更后：刷新本组件徽标，并通知宿主层（index.ts）立即重查
            // badge，让会话页标签的小红点即时更新（不等 30s 轮询）。
            pollBadge()
            window.dispatchEvent(new CustomEvent('dsh-memory-evolve:badge-change'))
          }}
        />
      )}
    </div>
  )
}
