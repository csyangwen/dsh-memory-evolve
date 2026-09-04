/**
 * 会话书签 — 轮尾星标按钮（由 bookmark-injector.ts 的 DOM 注入挂载）。
 *
 * 挂载在**每个已完成轮的轮尾**（B 方案：注入器只对"Branch 按钮未禁用"的
 * 轮尾 assistant 消息注入，不占 conversation.chat.turnTail chain 槽，官方
 * produced-files 行保留）。点击：
 *   - 未打星 → 弹 prompt 取名（默认「轮次 N」）→ POST 创建书签；
 *   - 已打星 → 弹出迷你菜单：改名 / 删除。
 *
 * 按钮刻意克制（小图标、半透明），不干扰官方 Copy / Branch IconActions。
 *
 * 锚点（issue #39 起）：DOM 不再携带消息 seq（DSH 0.1.1-rc.2 官方重构
 * data-chat-anchor-key 为 `${kind.length}:${kind}${id}`），因此：
 *   - anchorKey = 锚点原文（主键；POST 给宿主端，由它按事件日志反查 seq）；
 *   - seq 仅老格式（node:{seq}）有值（旧 DSH 兼容路径）；
 *   - turn 从 assistant-step 锚点 id（`turn:step`）解析，供默认标签名/展示。
 *
 * sessionId 支持「字符串」或「提供者函数」两种形态：注入器传函数（会话
 * 切换后组件不重渲染也能拿到最新会话 id），书签 Tab 传字符串。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** 单条书签（与宿主 API 对齐的最小字段）。 */
interface BookmarkRow {
  id: string
  seq: number
  anchorKey: string | null
  label: string
}

/** 组件 props：anchorKey（新式主锚点）+ 展示字段 + 会话 id（字符串或提供者）。 */
export interface TurnBookmarkButtonProps {
  /** 该轮轮尾消息节点的锚点原文（data-chat-anchor-key；新式主锚点）。 */
  anchorKey: string
  /** 该轮 closing assistant 的 seq（老格式 node:{seq} 才有；跳转/fork 兼容回退）。 */
  seq: number | null
  /** 轮次号（assistant-step 锚点 id 解析；老格式 / 解析失败为 null）。 */
  turn: number | null
  /** 该轮首条用户消息预览（可空）。 */
  summary: string
  /** 会话 id：字符串（槽位场景）或提供者函数（DOM 注入场景）。 */
  sessionId: string | (() => string)
  t: Translate
}

/** 解析会话 id：函数形态在每次使用时取最新值（会话切换安全）。 */
function resolveSessionId(sessionId: string | (() => string)): string {
  return typeof sessionId === 'function' ? sessionId() : sessionId
}

/** 调宿主书签 API 的薄封装。 */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/memory-evolve/api/bookmarks${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const body = await res.json().catch(() => ({})) as { error?: string } & T
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

/**
 * 轮尾星标按钮。
 * @param props - seq/turn/summary + sessionId + t。
 */
export function TurnBookmarkButton(props: TurnBookmarkButtonProps): JSX.Element {
  const { anchorKey, seq, turn, summary, t } = props
  const [bookmark, setBookmark] = useState<BookmarkRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 加载本轮是否已打书签：新记录按 anchorKey 匹配；旧记录（无 anchorKey）
  // 回退按 seq 匹配，保证老客户端打过的星不重复。
  const reload = useCallback((): void => {
    const sessionId = resolveSessionId(props.sessionId)
    if (!sessionId) return
    void api<{ bookmarks: BookmarkRow[] }>(`?sessionId=${encodeURIComponent(sessionId)}`)
      .then((data) => {
        const found = (data.bookmarks ?? []).find((b) =>
          (b.anchorKey != null && b.anchorKey === anchorKey)
          || (b.anchorKey == null && b.seq === seq)) ?? null
        setBookmark(found)
      })
      .catch(() => { /* 探测失败：保持未打星态，点击时再报错 */ })
  }, [props.sessionId, anchorKey, seq])

  useEffect(() => { reload() }, [reload])

  // 点击外部关闭迷你菜单。
  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (event: MouseEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen])

  /** 默认标签名：轮次 N（turn 优先；老格式只有 seq；都没有则显示 ?）。 */
  const defaultLabel = t('bookmark.defaultLabel', { n: String(turn ?? seq ?? '?') })

  const createOrRename = (mode: 'create' | 'rename'): void => {
    const sessionId = resolveSessionId(props.sessionId)
    if (!sessionId) {
      window.alert(t('bookmark.error', { message: t('bookmark.noSession') }))
      return
    }
    const initial = mode === 'rename' && bookmark !== null ? bookmark.label : defaultLabel
    // window.prompt：零依赖、不抢 DSH 弹层体系；失败（Esc）则取消。
    const input = window.prompt(
      mode === 'rename' ? t('bookmark.prompt.rename') : t('bookmark.prompt.create'),
      initial,
    )
    if (input === null) return // 用户取消
    const label = input.trim() === '' ? defaultLabel : input.trim()
    setBusy(true)
    setMenuOpen(false)
    if (mode === 'create') {
      void api<{ bookmark: BookmarkRow }>('', {
        method: 'POST',
        // anchorKey 为主锚点（宿主端反查 seq/turn）；seq 仅老格式携带。
        body: JSON.stringify({ sessionId, anchorKey, seq, label, summary, turn }),
      })
        .then((data) => {
          setBookmark({
            id: data.bookmark.id,
            seq: data.bookmark.seq,
            anchorKey: data.bookmark.anchorKey ?? null,
            label: data.bookmark.label,
          })
          // 通知书签列表 Tab 刷新（若已打开）。
          window.dispatchEvent(new CustomEvent('dsh-memory-evolve:bookmarks-change'))
        })
        .catch((error: Error) => {
          window.alert(t('bookmark.error', { message: error.message }))
        })
        .finally(() => setBusy(false))
    } else if (bookmark !== null) {
      void api<{ bookmark: BookmarkRow }>('', {
        method: 'PATCH',
        body: JSON.stringify({ sessionId, id: bookmark.id, label }),
      })
        .then((data) => {
          setBookmark({
            id: data.bookmark.id,
            seq: data.bookmark.seq,
            anchorKey: data.bookmark.anchorKey ?? null,
            label: data.bookmark.label,
          })
          window.dispatchEvent(new CustomEvent('dsh-memory-evolve:bookmarks-change'))
        })
        .catch((error: Error) => {
          window.alert(t('bookmark.error', { message: error.message }))
        })
        .finally(() => setBusy(false))
    } else {
      setBusy(false)
    }
  }

  const remove = (): void => {
    const sessionId = resolveSessionId(props.sessionId)
    if (bookmark === null) return
    if (!window.confirm(t('bookmark.confirm.delete', { label: bookmark.label }))) return
    setBusy(true)
    setMenuOpen(false)
    void api<{ ok: boolean }>('', {
      method: 'DELETE',
      body: JSON.stringify({ sessionId, id: bookmark.id }),
    })
      .then(() => {
        setBookmark(null)
        window.dispatchEvent(new CustomEvent('dsh-memory-evolve:bookmarks-change'))
      })
      .catch((error: Error) => {
        window.alert(t('bookmark.error', { message: error.message }))
      })
      .finally(() => setBusy(false))
  }

  const bookmarked = bookmark !== null
  const title = bookmarked
    ? t('bookmark.star.title.on', { label: bookmark.label })
    : t('bookmark.star.title.off')

  return (
    <div className="bm-star-wrap" ref={wrapRef} data-bm-anchor={anchorKey}>
      <button
        type="button"
        className="bm-star-btn"
        data-bookmarked={bookmarked ? 'true' : undefined}
        title={title}
        aria-label={title}
        disabled={busy}
        onClick={() => {
          if (bookmarked) {
            setMenuOpen((open) => !open)
          } else {
            createOrRename('create')
          }
        }}
      >
        {/* 实心 ★ / 空心 ☆：纯字符，零图标依赖，深浅色都清晰 */}
        <span className="bm-star-icon" aria-hidden="true">{bookmarked ? '★' : '☆'}</span>
      </button>
      {menuOpen && bookmarked && (
        <div className="bm-star-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => createOrRename('rename')}>
            {t('bookmark.menu.rename')}
          </button>
          <button type="button" role="menuitem" className="bm-danger" onClick={remove}>
            {t('bookmark.menu.delete')}
          </button>
        </div>
      )}
    </div>
  )
}
