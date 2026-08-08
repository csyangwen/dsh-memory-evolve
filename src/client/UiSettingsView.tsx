/**
 * dsh-memory-evolve — DSH UI 设置 Tab（conversation.view entry）。
 *
 * 「DSH UI 设置」Tab：本模块的操作/说明界面。第一版只有一个子 Tab——
 * 「指南」（结构化介绍本模块功能，TabGuideView 渲染，与其他 Tab 同款）；
 * 后续扩展（主题更换等）在此追加子 Tab（如「主题」）。
 *
 * 注意：本 Tab 只是说明界面；真正的功能（左侧会话列表筛选）是全局 DOM
 * 增强（src/client/session-filter.ts 注入），不依赖本 Tab 是否打开。
 */
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { TabGuideView } from './TabGuideView.tsx'

/** 本 Tab 的子功能（第一版仅指南；未来：主题等）。 */
type UiSettingsFeature = 'guide'

/** Locale-bound props（memory-evolve 命名空间）。 */
export interface UiSettingsTabViewProps {
  t: Translate
}

/** 跨重挂持久化的子 tab 选择（与其他 Tab 同款模式）。 */
let persistedUiSettingsFeature: UiSettingsFeature | null = null

/** The conversation view DSH UI 设置 tab component. */
export function UiSettingsTabView(props: ConvViewProps & UiSettingsTabViewProps): JSX.Element {
  const { t } = props
  const [feature, setFeature] = useState<UiSettingsFeature>(persistedUiSettingsFeature ?? 'guide')

  // 同步子 tab 选择到模块级：重挂后恢复。
  useEffect(() => { persistedUiSettingsFeature = feature }, [feature])

  /** 本 Tab 指南（对齐其他 Tab：TabGuideView 结构化介绍，文案走全局 locale）。 */
  const renderGuide = (): JSX.Element => (
    <TabGuideView sections={[
      { icon: '🎨', title: t('uiSettingsTab.guide.what.title'), body: t('uiSettingsTab.guide.what.body'), items: [t('uiSettingsTab.guide.what.item1'), t('uiSettingsTab.guide.what.item2'), t('uiSettingsTab.guide.what.item3')] },
      { icon: '🔍', title: t('uiSettingsTab.guide.filter.title'), body: t('uiSettingsTab.guide.filter.body'), items: [t('uiSettingsTab.guide.filter.item1'), t('uiSettingsTab.guide.filter.item2'), t('uiSettingsTab.guide.filter.item3')] },
      { icon: '⚙️', title: t('uiSettingsTab.guide.switch.title'), body: t('uiSettingsTab.guide.switch.body') },
    ]} />
  )

  return (
    <div className="me-panel">
      {/* 子 Tab 条：指南（复用全局 mt-file-tabs 视觉，与其他 Tab 一致） */}
      <div className="mt-file-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'guide'}
          className={feature === 'guide' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature('guide')}
        >
          {t('uiSettingsTab.feature.guide')}
        </button>
      </div>
      {feature === 'guide' && renderGuide()}
    </div>
  )
}
