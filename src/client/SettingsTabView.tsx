/**
 * dsh-memory-evolve — settings tab (conversation.view entry).
 *
 * 「Memory Evolve 设置」Tab：整个插件的总览与配置入口，三个子 Tab——
 *   「指南」：整个插件所有功能的简单介绍（整体指南，MemoryQueueView
 *     feature='guide'）——介绍的是全部功能（记忆/技能/待办/COI/提示词/
 *     临时信息/本地搜索/确认制）的用途，帮助新用户 30 秒了解插件；
 *   「配置」：运行时配置表单（原记忆 Tab 的「运行时配置」，用户拍板改名为
 *     「配置」；MemoryQueueView feature='config'）——审查、技能沉淀、
 *     每回合写入、各 Tab 开关等，修改立即生效并持久化；
 *   「版本」：插件版本检测与手动更新（VersionTabView，一期）——检测到
 *     新发布 tag 时设置 Tab 的 label 出现 🔴 红点（badge 机制，见
 *     index.ts 的 updateBadgeCount），用户在这里决定是否更新。
 *
 * 从原「记忆技能待办」Tab 抽取而来：记忆 Tab 不再承载整体指南与运行时
 * 配置，专心做记忆文件浏览与待确认记忆建议。
 */
import { useEffect, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { MemoryQueueView } from './MemoryQueueView.tsx'
import { VersionTabView } from './VersionTabView.tsx'

/** 设置 Tab 的三个子功能：指南（整体简介）/ 配置（运行时配置）/ 版本（检测更新）。 */
type SettingsFeature = 'guide' | 'config' | 'version'

/** Locale-bound props（memory-evolve 命名空间）。 */
export interface SettingsTabViewProps {
  t: Translate
}

/** 跨重挂持久化的子 tab 选择（模块级：badge 刷新导致组件重挂后恢复）。 */
let persistedSettingsFeature: SettingsFeature | null = null

/** The conversation view settings tab component. */
export function SettingsTabView(props: ConvViewProps & SettingsTabViewProps): JSX.Element {
  const { t } = props
  /** 当前激活的子 tab（缺省=指南）。 */
  const [feature, setFeature] = useState<SettingsFeature>(persistedSettingsFeature ?? 'guide')

  // 同步子 tab 选择到模块级：重挂后恢复。
  useEffect(() => { persistedSettingsFeature = feature }, [feature])

  return (
    <div className="mt-panel">
      {/* 子 tab 条：指南 / 配置 / 版本 */}
      <div className="mt-file-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'guide'}
          className={feature === 'guide' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature('guide')}
        >
          {t('settingsTab.feature.guide')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'config'}
          className={feature === 'config' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature('config')}
        >
          {t('settingsTab.feature.config')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'version'}
          className={feature === 'version' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature('version')}
        >
          {t('settingsTab.feature.version')}
        </button>
      </div>
      {/* 显式条件渲染：version 走 VersionTabView（MemoryQueueView 不接受
          version feature，直接透传会类型/渲染错误——CodeX 评审 P1-4） */}
      {feature === 'version' ? (
        <VersionTabView t={t} />
      ) : (
        <MemoryQueueView
          t={t}
          feature={feature}
          onChanged={() => {
            // 配置变更后通知宿主层（index.ts）重查 badge（配置开关变化会影响
            // 各 Tab 的可用性，红点计数不变，但保持事件一致性）。
            window.dispatchEvent(new CustomEvent('dsh-memory-evolve:badge-change'))
          }}
        />
      )}
    </div>
  )
}
