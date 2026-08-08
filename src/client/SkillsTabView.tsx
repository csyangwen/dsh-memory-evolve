/**
 * dsh-memory-evolve — skills tab (conversation.view entry).
 *
 * 独立技能 Tab（从原「记忆技能待办」Tab 拆分而来）：两个子 tab——
 *   「待确认技能建议」：后台审查产出的新技能队列，采纳后移入技能库
 *     （~/.agents/skills）并随系统提示词注入（MemoryQueueView feature='skills'）；
 *   「技能管理」：技能中心三栏视图（列表/目录树/编辑器），合并自原
 *     dsh-skill-browser 插件（SkillsBrowser，API 前缀 /skills-manager 不变）。
 *
 * 子 tab 徽标显示待确认技能数（/api/badge 的 skills 字段）：30s 轮询 +
 * 监听 dsh-memory-evolve:badge-change 事件即时刷新；任一队列变更后由
 * onChanged 主动触发事件，让会话页标签的小红点同步更新。
 *
 * 样式复用 mt- 前缀（styles.css：mt-panel / mt-file-tabs / mt-feature-count）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { MemoryQueueView } from './MemoryQueueView.tsx'
import { SkillsBrowser } from './skills-browser/SkillsBrowser.tsx'
import { TabGuideView, type GuideSection } from './TabGuideView.tsx'

/** 技能 Tab 的三个子功能：指南 / 待确认技能建议 / 技能管理。 */
type SkillsFeature = 'guide' | 'skills' | 'skill-browser'

/** Locale-bound props（locate namespace：memory-evolve）。 */
export interface SkillsTabViewProps {
  t: Translate
}

/** 跨重挂持久化的子 tab 选择（模块级：badge 刷新导致组件重挂后恢复）。 */
let persistedSkillsFeature: SkillsFeature | null = null

/**
 * 技能 Tab 专属指南内容（「指南」子 Tab）：
 * 详细介绍技能功能本身——技能是什么、如何沉淀、待确认技能建议、技能管理
 * （浏览/禁用/自定义目录/文件编辑）。文案来自全局 locale（skillsTab.guide.* 键组）。
 */
function skillsGuideSections(t: Translate): GuideSection[] {
  return [
    {
      icon: '🛠️',
      title: t('skillsTab.guide.what.title'),
      body: t('skillsTab.guide.what.body'),
      items: [
        t('skillsTab.guide.what.item1'),
        t('skillsTab.guide.what.item2'),
      ],
    },
    {
      icon: '🔄',
      title: t('skillsTab.guide.how.title'),
      body: t('skillsTab.guide.how.body'),
      items: [
        t('skillsTab.guide.how.item1'),
        t('skillsTab.guide.how.item2'),
        t('skillsTab.guide.how.item3'),
      ],
    },
    {
      icon: '📥',
      title: t('skillsTab.guide.pending.title'),
      body: t('skillsTab.guide.pending.body'),
      items: [
        t('skillsTab.guide.pending.item1'),
        t('skillsTab.guide.pending.item2'),
      ],
    },
    {
      icon: '🔍',
      title: t('skillsTab.guide.manager.title'),
      body: t('skillsTab.guide.manager.body'),
      items: [
        t('skillsTab.guide.manager.item1'),
        t('skillsTab.guide.manager.item2'),
        t('skillsTab.guide.manager.item3'),
        t('skillsTab.guide.manager.item4'),
      ],
    },
    {
      icon: '⛔',
      title: t('skillsTab.guide.disable.title'),
      body: t('skillsTab.guide.disable.body'),
      items: [
        t('skillsTab.guide.disable.item1'),
        t('skillsTab.guide.disable.item2'),
      ],
    },
    {
      icon: '📁',
      title: t('skillsTab.guide.dirs.title'),
      body: t('skillsTab.guide.dirs.body'),
    },
    {
      icon: '🚫',
      title: t('skillsTab.guide.restraint.title'),
      body: t('skillsTab.guide.restraint.body'),
      items: [
        t('skillsTab.guide.restraint.item1'),
        t('skillsTab.guide.restraint.item2'),
      ],
    },
  ]
}

/** The conversation view skills tab component. */
export function SkillsTabView(props: ConvViewProps & SkillsTabViewProps): JSX.Element {
  const { t } = props
  /** 当前激活的子 tab（缺省=待确认技能建议）。 */
  const [feature, setFeature] = useState<SkillsFeature>(persistedSkillsFeature ?? 'skills')
  /** 待确认技能数（子 tab 徽标）。 */
  const [skillsCount, setSkillsCount] = useState(0)

  /** 拉取待确认技能数（尽力而为）。 */
  const pollBadge = useCallback((): void => {
    void fetch('/memory-evolve/api/badge')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { skills?: number }) => setSkillsCount(data.skills ?? 0))
      .catch(() => { /* 徽标尽力而为；功能不受影响 */ })
  }, [])

  // 同步子 tab 选择到模块级：badge 刷新导致的组件重挂后恢复。
  useEffect(() => { persistedSkillsFeature = feature }, [feature])

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
      {/* 子 tab 条：指南 / 待确认技能建议 / 技能管理 */}
      <div className="mt-file-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'guide'}
          className={feature === 'guide' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature('guide')}
        >
          {t('skillsTab.feature.guide')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'skills'}
          className={feature === 'skills' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature('skills')}
        >
          {t('skillsTab.feature.skills')}
          {skillsCount > 0 && <span className="mt-feature-count">{skillsCount}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'skill-browser'}
          className={feature === 'skill-browser' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature('skill-browser')}
        >
          {t('skillsTab.feature.skillBrowser')}
        </button>
      </div>
      {feature === 'guide' ? (
        <TabGuideView sections={skillsGuideSections(t)} />
      ) : feature === 'skill-browser' ? (
        <SkillsBrowser t={t} />
      ) : (
        <MemoryQueueView
          t={t}
          feature="skills"
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
