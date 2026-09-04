/**
 * 会话书签列表 Tab（conversation.view entry）。
 *
 * **槽位挂点决策**：挂 conversation.view（会话页 Tab 环），与记忆/技能/
 * 待办同级。理由：
 *   1. 书签是「当前会话」的导航面，不是全局设置——conversation.view 自带
 *      sessionId，按会话过滤天然正确；
 *   2. 列表需要完整滚动区展示摘要/时间/操作，header.actions 塞不下；
 *   3. turnTail 只做「打星」入口；列表/跳转/改名/删除集中在本 Tab，职责清晰。
 *
 * 点击书签 → 切回「对话」Tab → 按 data-chat-anchor-key 锚点原文定位；
 * ⚠️ DSH 0.1.1-rc.2 起锚点格式从 `node:{seq}` 重构为 `${kind.length}:${kind}${id}`
 * （key 里不再有 seq，issue #39）——因此新书签按 **anchorKey 原文**定位，
 * 旧记录（无 anchorKey）回退 `node:{seq}` 老格式。
 * 若目标在未加载的历史窗口，循环点「加载更早」按钮（loadOlder）再定位。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { TabGuideView, type GuideSection } from './TabGuideView.tsx'

/** 宿主返回的书签形状。 */
interface Bookmark {
  id: string
  sessionId: string
  seq: number
  /** 新式 DOM 锚点原文（0.1.1-rc.2+；旧记录为 null，跳转回退 node:{seq}）。 */
  anchorKey: string | null
  label: string
  summary: string
  turn: number | null
  createdAt: string
  updatedAt: string
}

/** Locale-bound props。 */
export interface BookmarksViewProps {
  t: Translate
}

/** 子功能：列表 / 指南。 */
type Feature = 'list' | 'guide'

/** 跨重挂持久化子 tab（badge 刷新导致组件重挂后恢复）。 */
let persistedFeature: Feature | null = null

/** 调宿主书签 API。 */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/memory-evolve/api/bookmarks${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const body = await res.json().catch(() => ({})) as { error?: string } & T
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

/** 显示侧时间格式化。 */
function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

/**
 * 切到「对话」Tab（id=chat，conversation.view 环的第一个官方 entry）。
 * 官方 Tab 按钮没有 data-view-id，靠 label 文本宽松匹配 + 位置兜底。
 * @returns 是否成功点到了某个 tab。
 */
function switchToChatTab(): boolean {
  const tabs = document.querySelectorAll<HTMLElement>('[role="tab"]')
  // 1) 文案匹配：中文「对话」/ 英文 "Chat"（官方 locale）。
  for (const tab of tabs) {
    const text = (tab.textContent ?? '').trim()
    if (text === '对话' || text === 'Chat' || text.startsWith('对话') || text.startsWith('Chat')) {
      tab.click()
      return true
    }
  }
  // 2) 兜底：第一个 role=tab 通常是 chat（order: 0）。
  const first = tabs[0]
  if (first !== undefined) {
    first.click()
    return true
  }
  return false
}

/**
 * 点击「加载更早」按钮（ChatView 顶部 hasMore 按钮）。
 * 文案来自官方 locale：中文「加载更早的消息」等，宽松匹配。
 * @returns 是否找到并点击了可点按钮。
 */
function clickLoadOlder(): boolean {
  // ChatView 的 loadOlder 按钮在 [data-chat-flow] 上方 .older 区域。
  const flow = document.querySelector('[data-chat-flow]')
  const root = flow?.parentElement ?? document
  const buttons = root.querySelectorAll<HTMLButtonElement>('button')
  for (const btn of buttons) {
    if (btn.disabled) continue
    const text = (btn.textContent ?? '').trim()
    // 官方 key chat.loadOlder / loading —— 中英文常见文案。
    if (
      text.includes('更早')
      || text.includes('older')
      || text.includes('Older')
      || text.includes('Load earlier')
      || text.includes('加载历史')
    ) {
      btn.click()
      return true
    }
  }
  return false
}

/**
 * 等待 DOM 中出现锚点，或超时。
 * @param key - data-chat-anchor-key 原文（新式）或 `node:{seq}`（旧式回退）。
 * @param timeoutMs - 最长等待。
 * @returns 找到的元素或 null。
 */
function waitForAnchor(key: string, timeoutMs = 2500): Promise<HTMLElement | null> {
  const existing = document.querySelector<HTMLElement>(`[data-chat-anchor-key="${key}"]`)
  if (existing !== null) return Promise.resolve(existing)

  return new Promise((resolve) => {
    const started = Date.now()
    const timer = window.setInterval(() => {
      const el = document.querySelector<HTMLElement>(`[data-chat-anchor-key="${key}"]`)
      if (el !== null) {
        window.clearInterval(timer)
        resolve(el)
        return
      }
      if (Date.now() - started >= timeoutMs) {
        window.clearInterval(timer)
        resolve(null)
      }
    }, 80)
  })
}

/** 书签 → 可定位锚点 key：新记录用 anchorKey 原文，旧记录回退 node:{seq}。 */
function anchorKeyFor(bm: Bookmark): string {
  return bm.anchorKey !== null && bm.anchorKey !== '' ? bm.anchorKey : `node:${bm.seq}`
}

/**
 * 跳转到指定书签：切对话 Tab → 必要时 loadOlder → scrollIntoView。
 * @param bm - 目标书签记录（用其 anchorKey/seq 组合定位）。
 * @returns 结果消息（成功/失败文案 key 由调用方拼）。
 */
async function jumpToAnchor(bm: Bookmark): Promise<'ok' | 'not-found' | 'no-chat'> {
  const key = anchorKeyFor(bm)
  // 1. 切回对话 Tab（ChatView 卸载时锚点不在 DOM 里）。
  const switched = switchToChatTab()
  if (!switched) return 'no-chat'
  // 给 React 一帧挂载 ChatView。
  await new Promise((r) => window.setTimeout(r, 120))

  // 2. 已在窗口内 → 直接滚。
  let el = await waitForAnchor(key, 800)
  if (el !== null) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // 短暂高亮：加 outline，1.5s 后清。
    flashAnchor(el)
    return 'ok'
  }

  // 3. 未加载：循环 loadOlder（最多 12 页，防死循环）。
  for (let page = 0; page < 12; page += 1) {
    const clicked = clickLoadOlder()
    if (!clicked) break
    // 等一页历史拉完（ChatView loadingOlder 结束会渲染新锚点）。
    el = await waitForAnchor(key, 3000)
    if (el !== null) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      flashAnchor(el)
      return 'ok'
    }
  }
  return 'not-found'
}

/** 锚点短暂高亮（outline 闪一下，不改布局）。 */
function flashAnchor(el: HTMLElement): void {
  const prev = el.style.outline
  el.style.outline = '2px solid var(--dsw-static-yellow-9, #f5a623)'
  el.style.outlineOffset = '4px'
  window.setTimeout(() => {
    el.style.outline = prev
    el.style.outlineOffset = ''
  }, 1600)
}

/**
 * 书签列表 Tab 组件。
 */
export function BookmarksView(props: ConvViewProps & BookmarksViewProps): JSX.Element {
  const { t, sessionId } = props
  const [feature, setFeature] = useState<Feature>(persistedFeature ?? 'list')
  const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(null)
  const [query, setQuery] = useState('') // 搜索关键词（label/summary 子串过滤）
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { persistedFeature = feature }, [feature])

  const load = useCallback((): void => {
    if (!sessionId) {
      setBookmarks([])
      return
    }
    void api<{ bookmarks: Bookmark[] }>(`?sessionId=${encodeURIComponent(sessionId)}`)
      .then((data) => setBookmarks(data.bookmarks ?? []))
      .catch((error: Error) => {
        setNotice({ kind: 'error', text: t('bookmark.error', { message: error.message }) })
        setBookmarks([])
      })
  }, [sessionId, t])

  useEffect(() => { load() }, [load])

  // 星标创建/删除后即时刷新列表。
  useEffect(() => {
    const onChange = (): void => load()
    window.addEventListener('dsh-memory-evolve:bookmarks-change', onChange)
    return () => window.removeEventListener('dsh-memory-evolve:bookmarks-change', onChange)
  }, [load])

  const onJump = (bm: Bookmark): void => {
    setBusy(true)
    setNotice({ kind: 'info', text: t('bookmark.jumping') })
    void jumpToAnchor(bm)
      .then((result) => {
        if (result === 'ok') {
          setNotice({ kind: 'ok', text: t('bookmark.jump.ok', { label: bm.label }) })
        } else if (result === 'no-chat') {
          setNotice({ kind: 'error', text: t('bookmark.jump.noChat') })
        } else {
          setNotice({ kind: 'error', text: t('bookmark.jump.notFound', { label: bm.label }) })
        }
      })
      .finally(() => setBusy(false))
  }

  const onRename = (bm: Bookmark): void => {
    const input = window.prompt(t('bookmark.prompt.rename'), bm.label)
    if (input === null) return
    const label = input.trim()
    if (label === '') return
    setBusy(true)
    void api<{ bookmark: Bookmark }>('', {
      method: 'PATCH',
      body: JSON.stringify({ sessionId, id: bm.id, label }),
    })
      .then(() => {
        load()
        setNotice({ kind: 'ok', text: t('bookmark.renamed') })
      })
      .catch((error: Error) => {
        setNotice({ kind: 'error', text: t('bookmark.error', { message: error.message }) })
      })
      .finally(() => setBusy(false))
  }

  const onDelete = (bm: Bookmark): void => {
    if (!window.confirm(t('bookmark.confirm.delete', { label: bm.label }))) return
    setBusy(true)
    void api<{ ok: boolean }>('', {
      method: 'DELETE',
      body: JSON.stringify({ sessionId, id: bm.id }),
    })
      .then(() => {
        load()
        setNotice({ kind: 'ok', text: t('bookmark.deleted') })
      })
      .catch((error: Error) => {
        setNotice({ kind: 'error', text: t('bookmark.error', { message: error.message }) })
      })
      .finally(() => setBusy(false))
  }

  /** 从此书签的轮次创建官方分支会话（用户拍板本期实现）。 */
  const onFork = (bm: Bookmark): void => {
    if (!window.confirm(t('bookmark.fork.confirm', { n: String(bm.turn ?? bm.seq) }))) return
    setBusy(true)
    setNotice({ kind: 'info', text: t('bookmark.fork.working') })
    void fetch('/memory-evolve/api/bookmarks/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // anchorKey 优先（新式）；旧记录回退 seq（宿主端仍按 seq 分支）。
      body: JSON.stringify({ sessionId: bm.sessionId, seq: bm.seq, anchorKey: bm.anchorKey ?? undefined }),
    })
      .then((res) => res.json().catch(() => ({})) as Promise<{ sessionId?: string; error?: string }>)
      .then((data) => {
        if (typeof data.sessionId === 'string') {
          setNotice({ kind: 'ok', text: t('bookmark.fork.ok', { id: data.sessionId }) })
        } else {
          setNotice({ kind: 'error', text: t('bookmark.error', { message: data.error ?? 'HTTP error' }) })
        }
      })
      .catch((error: Error) => {
        setNotice({ kind: 'error', text: t('bookmark.error', { message: error.message }) })
      })
      .finally(() => setBusy(false))
  }

  // 搜索过滤：label 或 summary 子串（大小写不敏感）；空关键词 = 全部。
  const q = query.trim().toLowerCase()
  const filtered = bookmarks === null
    ? null
    : q === ''
      ? bookmarks
      : bookmarks.filter((bm) =>
          bm.label.toLowerCase().includes(q) || bm.summary.toLowerCase().includes(q))

  const guideSections: GuideSection[] = [
    {
      icon: '⭐',
      title: t('bookmark.guide.what.title'),
      body: t('bookmark.guide.what.body'),
    },
    {
      icon: '📍',
      title: t('bookmark.guide.star.title'),
      body: t('bookmark.guide.star.body'),
    },
    {
      icon: '📜',
      title: t('bookmark.guide.list.title'),
      body: t('bookmark.guide.list.body'),
    },
    {
      icon: '⚙️',
      title: t('bookmark.guide.switch.title'),
      body: t('bookmark.guide.switch.body'),
    },
  ]

  return (
    <div className="bm-panel">
      {/* 子 tab：列表 / 指南 */}
      <div className="mt-file-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'list'}
          className={feature === 'list' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature('list')}
        >
          {t('bookmark.tab.list')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'guide'}
          className={feature === 'guide' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature('guide')}
        >
          {t('bookmark.tab.guide')}
        </button>
      </div>

      {feature === 'guide' && (
        <TabGuideView sections={guideSections} />
      )}

      {feature === 'list' && (
        <>
          <div className="bm-toolbar">
            <h3>{t('bookmark.list.title')}</h3>
            <button
              type="button"
              className="bm-toolbar-btn"
              disabled={busy}
              onClick={() => load()}
            >
              {t('bookmark.refresh')}
            </button>
          </div>
          <p className="bm-help">{t('bookmark.list.help')}</p>
          {/* 搜索框：label/summary 子串过滤（书签多了不翻列表） */}
          <input
            type="search"
            className="bm-search"
            placeholder={t('bookmark.search.placeholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t('bookmark.search.placeholder')}
          />
          {notice !== null && (
            <div className={`bm-notice bm-notice-${notice.kind}`}>{notice.text}</div>
          )}
          <div className="bm-list">
            {filtered === null && (
              <div className="bm-empty">{t('bookmark.loading')}</div>
            )}
            {filtered !== null && filtered.length === 0 && (
              <div className="bm-empty">
                {q === '' ? t('bookmark.empty') : t('bookmark.search.empty')}
              </div>
            )}
            {filtered !== null && filtered.map((bm) => (
              <div
                key={bm.id}
                className="bm-item"
                role="article"
                onClick={() => { if (!busy) onJump(bm) }}
                onKeyDown={(event) => {
                  if (!busy && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault()
                    onJump(bm)
                  }
                }}
                tabIndex={0}
                title={t('bookmark.jump.hint')}
              >
                <div className="bm-item-head">
                  <span className="bm-item-label">★ {bm.label}</span>
                  <span className="bm-item-meta">
                    {bm.turn !== null ? t('bookmark.turn', { n: String(bm.turn) }) : `seq ${bm.seq}`}
                    {' · '}
                    {formatTime(bm.createdAt)}
                  </span>
                </div>
                {bm.summary !== '' && (
                  <div className="bm-item-summary">{bm.summary}</div>
                )}
                {/* 操作钮：stopPropagation 避免冒泡成二次跳转 */}
                <div
                  className="bm-item-actions"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <button type="button" disabled={busy} onClick={() => onJump(bm)}>
                    {t('bookmark.action.jump')}
                  </button>
                  {/* 分支：从此轮创建官方分支会话（Memory Evolve 增强） */}
                  <button type="button" disabled={busy} onClick={() => onFork(bm)}>
                    {t('bookmark.action.fork')}
                  </button>
                  <button type="button" disabled={busy} onClick={() => onRename(bm)}>
                    {t('bookmark.action.rename')}
                  </button>
                  <button type="button" className="bm-danger" disabled={busy} onClick={() => onDelete(bm)}>
                    {t('bookmark.action.delete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
