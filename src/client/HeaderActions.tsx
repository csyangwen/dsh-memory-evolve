/**
 * 会话头部 actions 组合（conversation.session.header.actions 插槽）：
 * 「⧉ 复制会话ID」+「✎ 别名」两个按钮并排。strict-session slot 自动
 * 注入 sessionId；t 由插件闭包传入。
 */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { CopySessionIdButton } from './CopySessionIdButton.tsx'
import { AliasButton } from './AliasButton.tsx'

/** @param props - 标准 session slot props + 翻译函数。 */
export function HeaderActions(props: { sessionId: string; t: Translate }): JSX.Element {
  return (
    <>
      <CopySessionIdButton {...props} />
      <AliasButton {...props} />
    </>
  )
}
