/**
 * 会话头部「✎ 别名」按钮（conversation.session.header.actions 插槽，
 * 复制会话 ID 按钮旁）——给当前会话设置友好名称（≤10 字）。
 *
 * 别名存 <memoryDir>/aliases.json（全局属性，不随模块开关）：快照
 * 「你的会话」段注入（AI 知道自己的别名）、广播面板/快照/工具显示
 * 别名优先（拟人化，告别满屏长 Session ID）。修改覆盖、清除移除。
 */
import { useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

const ALIAS_API = '/memory-evolve/api/aliases'

/** @param props - 标准 session slot props（含当前会话 id）。 */
export function AliasButton(props: { sessionId: string; t: Translate }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const openEditor = (): void => {
    setOpen(true)
    setNotice(null)
    // 拉当前别名作占位（GET 全量，取自己）
    void fetch(`${ALIAS_API}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { aliases?: Record<string, string> }) => {
        setName(data.aliases?.[props.sessionId] ?? '')
      })
      .catch(() => { /* 占位留空即可 */ })
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setNotice(null)
    try {
      const text = name.trim()
      const res = await fetch(`${ALIAS_API}/${encodeURIComponent(props.sessionId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: text }),
      })
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string }
      if (res.ok !== true || body.ok !== true) throw new Error(body.message ?? `HTTP ${res.status}`)
      // 保存成功后收起编辑区（避免按钮残留）
      setNotice(text === '' ? props.t('header.setAlias.cleared') : props.t('header.setAlias.saved'))
      setOpen(false)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const clear = async (): Promise<void> => {
    setSaving(true)
    setNotice(null)
    try {
      const res = await fetch(`${ALIAS_API}/${encodeURIComponent(props.sessionId)}`, { method: 'DELETE' })
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string }
      if (res.ok !== true || body.ok !== true) throw new Error(body.message ?? `HTTP ${res.status}`)
      setName('')
      setNotice(props.t('header.setAlias.cleared'))
      setOpen(false)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <span className="me-alias-wrap">
      <button
        type="button"
        className="me-copy-session-id"
        title={props.t('header.setAlias.title')}
        onClick={() => (open ? setOpen(false) : openEditor())}
      >
        {props.t('header.setAlias')}
      </button>
      {open && (
        <span className="me-alias-editor">
          <input
            className="me-alias-input"
            value={name}
            maxLength={10}
            placeholder={props.t('header.setAlias.placeholder')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
            autoFocus
          />
          <button type="button" className="me-copy-session-id" disabled={saving} onClick={() => void save()}>
            {props.t('header.setAlias.save')}
          </button>
          <button type="button" className="me-copy-session-id" disabled={saving || name === ''} onClick={() => void clear()}>
            {props.t('header.setAlias.clear')}
          </button>
          {notice !== null && <span className="me-alias-notice">{notice}</span>}
        </span>
      )}
    </span>
  )
}
