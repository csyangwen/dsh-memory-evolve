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
 * seq/turn/summary 由注入器从 DOM 解析（seq=消息节点事件 seq；turn 从 DOM
 * 拿不到传 null；summary=该轮最近 user 消息预览）。
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
  label: string
}

/** 组件 props：seq（轮尾锚点）+ 展示字段 + 会话 id（字符串或提供者）。 */
export interface TurnBookmarkButtonProps {
  /** 该轮 closing assistant 的 seq（跳转锚点 + 第二阶段 fork 边界）。 */
  seq: number
  /** 轮次号（DOM 注入拿不到时为 null）。 */
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
  const { seq, turn, summary, t } = props
  const [bookmark, setBookmark] = useState<BookmarkRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 加载本轮是否已打书签（按 seq 在列表里找）。
  const reload = useCallback((): void => {
    const sessionId = resolveSessionId(props.sessionId)
    if (!sessionId) return
    void api<{ bookmarks: BookmarkRow[] }>(`?sessionId=${encodeURIComponent(sessionId)}`)
      .then((data) => {
        const found = (data.bookmarks ?? []).find((b) => b.seq === seq) ?? null
        setBookmark(found)
      })
      .catch(() => { /* 探测失败：保持未打星态，点击时再报错 */ })
  }, [props.sessionId, seq])

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

  /** 默认标签名：轮次 N。 */
  const defaultLabel = t('bookmark.defaultLabel', { n: String(turn ?? seq) })

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
        body: JSON.stringify({ sessionId, seq, label, summary, turn }),
      })
        .then((data) => {
          setBookmark({ id: data.bookmark.id, seq: data.bookmark.seq, label: data.bookmark.label })
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
          setBookmark({ id: data.bookmark.id, seq: data.bookmark.seq, label: data.bookmark.label })
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
    <div className="bm-star-wrap" ref={wrapRef} data-bm-seq={String(seq)}>
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
