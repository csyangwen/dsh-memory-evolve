/**
 * 会话头部「复制会话 ID」按钮（conversation.session.header.actions 插槽）。
 *
 * 会话广播的配套入口：用户把当前会话 ID 复制给另一个会话（粘贴到对方
 * 的输入框告诉对方 AI），对方 AI 就能用 de_broadcast 给本会话发广播。
 * strict-session slot 自动注入 sessionId prop；点击复制到剪贴板，短暂
 * 显示「已复制」反馈。
 */
import { useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** @param props - 标准 session slot props（含当前会话 id）。 */
export function CopySessionIdButton(props: { sessionId: string; t: Translate }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="me-copy-session-id"
      title={props.t('header.copySessionId.title')}
      onClick={() => {
        void navigator.clipboard.writeText(props.sessionId)
          .then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => { /* 剪贴板被拒：静默 */ })
      }}
    >
      {copied ? props.t('header.copySessionId.done') : props.t('header.copySessionId')}
    </button>
  )
}
