/**
 * dsh-memory-evolve — DSH UI 设置 Tab（conversation.view entry）。
 *
 * 「DSH UI 设置」Tab：本模块的操作/说明界面，两个子 Tab：
 *   「综合」：**各功能的小开关列表**（用户拍板：每个功能设置都要有单独
 *     的小开关按钮；功能未定型前不精确分类，先统一收在「综合」）——当前
 *     两个功能：会话筛选（左侧列表只显示进行中）、对话区加宽（中间区域
 *     扩大到约 95%）。开关状态存 localStorage 并经事件广播，index.ts
 *     监听后同步 DOM 注入（不依赖本 Tab 是否打开）。
 *   「指南」：模块简介（精简——用户拍板：不用详细介绍每个小功能怎么用，
 *     这只是些小功能）。
 *
 * 注意：功能注入是全局 DOM 增强（session-filter.ts / wide-chat.ts），
 * 开关在「综合」里切换后即时生效。
 */
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { TabGuideView } from './TabGuideView.tsx'
import { readFeatures, writeFeatures, type UiSettingsFeatures } from './ui-settings-features.ts'

/** 本 Tab 的子功能：综合（功能开关）/ 指南（简介）。 */
type UiSettingsFeature = 'mixed' | 'guide'

/** Locale-bound props（memory-evolve 命名空间）。 */
export interface UiSettingsTabViewProps {
  t: Translate
}

/** 跨重挂持久化的子 tab 选择（与其他 Tab 同款模式）。 */
let persistedUiSettingsFeature: UiSettingsFeature | null = null

/**
 * 功能开关行：一行 = 名称 + 描述 + 独立小开关（me-switch，与设置 Tab
 * 配置表单同款视觉）。
 */
function FeatureSwitchRow({ label, hint, checked, onChange }: {
  label: string
  hint: string
  checked: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <label className="me-field">
      <span className="me-field-label">
        {label}
        <em className="me-field-hint">{hint}</em>
      </span>
      <input
        type="checkbox"
        className="me-switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}

/** The conversation view DSH UI 设置 tab component. */
export function UiSettingsTabView(props: ConvViewProps & UiSettingsTabViewProps): JSX.Element {
  const { t } = props
  const [feature, setFeature] = useState<UiSettingsFeature>(persistedUiSettingsFeature ?? 'mixed')
  /** 功能开关状态（初始化自 localStorage；切换即保存 + 广播事件）。 */
  const [features, setFeatures] = useState<UiSettingsFeatures>(() => readFeatures())

  // 同步子 tab 选择到模块级：重挂后恢复。
  useEffect(() => { persistedUiSettingsFeature = feature }, [feature])

  /** 切换单个功能开关：更新本地状态 + 持久化 + 广播（注入立即跟随）。 */
  const toggleFeature = (key: keyof UiSettingsFeatures, checked: boolean): void => {
    setFeatures((prev) => {
      const next = { ...prev, [key]: checked }
      writeFeatures(next)
      return next
    })
  }

  /** 「综合」子 tab：功能开关列表（每个功能独立小开关）。 */
  const renderMixed = (): JSX.Element => (
    <section className="me-block">
      <div className="me-block-head">
        <h3 className="me-heading">{t('uiSettingsTab.features.title')}</h3>
      </div>
      <p className="me-help">{t('uiSettingsTab.features.help')}</p>
      <div className="me-form">
        <div className="me-group">
          <FeatureSwitchRow
            label={t('uiSettings.feature.sessionFilter')}
            hint={t('uiSettings.feature.sessionFilter.hint')}
            checked={features.sessionFilter}
            onChange={(checked) => toggleFeature('sessionFilter', checked)}
          />
          <FeatureSwitchRow
            label={t('uiSettings.feature.wideChat')}
            hint={t('uiSettings.feature.wideChat.hint')}
            checked={features.wideChat}
            onChange={(checked) => toggleFeature('wideChat', checked)}
          />
        </div>
      </div>
    </section>
  )

  /** 「指南」子 tab：模块简介（精简版，不细讲每个小功能怎么用）。 */
  const renderGuide = (): JSX.Element => (
    <TabGuideView sections={[
      { icon: '🎨', title: t('uiSettingsTab.guide.what.title'), body: t('uiSettingsTab.guide.what.body') },
      { icon: '🪄', title: t('uiSettingsTab.guide.switch.title'), body: t('uiSettingsTab.guide.switch.body') },
    ]} />
  )

  return (
    <div className="me-panel">
      {/* 子 Tab 条：综合 / 指南（复用全局 mt-file-tabs 视觉，与其他 Tab 一致） */}
      <div className="mt-file-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'mixed'}
          className={feature === 'mixed' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature('mixed')}
        >
          {t('uiSettingsTab.feature.mixed')}
        </button>
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
      {feature === 'mixed' && renderMixed()}
      {feature === 'guide' && renderGuide()}
    </div>
  )
}
