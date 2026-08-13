/**
 * dsh-memory-evolve — generic tab guide panel (各 Tab 的「指南」子面板)。
 *
 * 渲染结构化的功能指南：若干 section，每个含 图标 + 标题 + 说明段落 +
 * 要点列表。样式复用 me- 前缀（styles.css：me-panel / me-block / me-heading /
 * me-help / me-guide / me-guide-row / me-guide-icon / me-guide-body），
 * 与 MemoryQueueView 的「使用指南」面板视觉一致。
 *
 * 用途：设置 Tab 的「指南」= 整个插件的简单介绍（MemoryQueueView
 * feature='guide'，不走本组件）；记忆/技能/待办/提示词 Tab 的
 * 「指南」= 各自功能的详细介绍（本组件 + 各自 locale 文案）。
 */
import type { JSX } from 'react'

/** 指南中的一个 section：图标 + 标题 + 说明 + 要点列表。 */
export interface GuideSection {
  /** 行首 emoji 图标。 */
  icon: string
  /** 小节标题。 */
  title: string
  /** 小节说明文字（可省略）。 */
  body?: string
  /** 要点列表（每行一个短句，可省略）。 */
  items?: string[]
}

/** 指南面板 props：sections 是已翻译好的文本结构。 */
export interface TabGuideViewProps {
  sections: GuideSection[]
}

/** 渲染一份结构化功能指南（卡片列表，自动换行）。 */
export function TabGuideView({ sections }: TabGuideViewProps): JSX.Element {
  return (
    <div className="me-panel">
      {sections.map((section, index) => (
        <section key={index} className="me-block">
          <div className="me-block-head">
            <h3 className="me-heading">{section.icon} {section.title}</h3>
          </div>
          {section.body !== undefined && section.body !== '' && (
            <p className="me-help">{section.body}</p>
          )}
          {section.items !== undefined && section.items.length > 0 && (
            <div className="me-guide">
              {section.items.map((item, itemIndex) => (
                <div key={itemIndex} className="me-guide-row">
                  <span className="me-guide-icon">•</span>
                  <span className="me-guide-body">
                    <span>{item}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  )
}
