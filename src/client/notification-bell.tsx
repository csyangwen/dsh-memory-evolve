/**
 * web 站内通知铃铛（全局右上角悬浮）—— 通知模块（de_notify 的 web 渠道）前端。
 *
 * 挂载方式：createRoot 到 document.body 下独立 host div（position:fixed 定位
 * 右上角），**不占任何 slot、不依赖会话**——用户在任意会话视图都能看到这个
 * 全局铃铛（通知是「发给用户本人」的，跨会话汇总）。
 *
 * 交互：
 *   - 铃铛按钮 + 未读数字徽标（>0 才显示；>99 显示 99+）；
 *   - 点击展开弹窗：未读通知列表（发送方名称 + 主题 + 时间 + 预览）；
 *   - 点某条展开全文 + 附件（图片缩略图/文件名）+「跳转到会话」+「删除」；
 *   - 顶部「全部已读」。
 *
 * 数据源：宿主端 /memory-evolve/api/notifications/*（unread/list/read/readAll/
 * content/attachment/download）。轮询 30s 未读数 + 监听 badge-change 事件即时刷新
 * （与其他 Tab 红点同款机制）。
 *
 * 「跳转到会话」：调用 openSession(sender) —— 由 index.ts 注入 DSH client 的
 * sessions 服务 ctx.sessions.open(sessionId)（2026-08-13 调研：DSH 官方切换
 * 会话的唯一入口，ui-workspace 同款路径）。system 通知（COI 自动，sender 空）
 * 无跳转按钮。
 */
import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useState } from 'react'

/**
 * 铃铛图标（自绘 SVG，匹配 DSH outline 图标风格：stroke=currentColor 线框，
 * 跟随主题文字色，替代 emoji 🔔）。Feather「bell」线框造型，24 viewBox 缩放。
 */
function BellIcon({ size = 20 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* 钟身 + 底缘弧 */}
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      {/* 铃舌 */}
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

/** 通知 API 基址（与宿主端 installNotifyWebApi 的 prefix 对齐）。 */
const API = '/memory-evolve/api/notifications'
/** 未读数轮询间隔（与其他 Tab 红点 BADGE_POLL_MS 一致）。 */
const POLL_MS = 30000

/** 一条通知（list 接口返回的视图，senderName 已由宿主端映射）。 */
interface NotificationItem {
  id: string
  sender: string
  senderName: string
  semantic: 'notify' | 'direct'
  subject: string
  content: string
  hasBody: boolean
  attachments: Array<{ name: string; size: number; mime: string }>
  createdAt: number
  read: boolean
}

/** 铃铛组件外部能力（由 index.ts 注入）。 */
export interface NotificationBellOpts {
  /** 切换到某会话（DSH client sessions.open）。 */
  openSession: (sessionId: string) => void
  /** 翻译函数（zh/en 跟随界面语言）。 */
  t: (key: string) => string
}

/** 时间显示：当天 HH:mm，跨天 MM-DD HH:mm。 */
function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

/** 展开中的单条通知（全文已拉取）。 */
interface OpenDetail {
  item: NotificationItem
  content: string
}

/**
 * 铃铛 React 组件（由 createNotificationBell 挂到 body 下 host）。
 */
function Bell({ openSession, t }: NotificationBellOpts): JSX.Element {
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationItem[] | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<OpenDetail | null>(null)

  /** 轮询未读数（尽力而为，失败静默保持旧值）。 */
  const poll = useCallback((): void => {
    void fetch(`${API}/unread`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { count?: number }) => setUnread(data.count ?? 0))
      .catch(() => { /* best-effort */ })
  }, [])

  useEffect(() => {
    poll()
    const timer = window.setInterval(poll, POLL_MS)
    // 通知写入后（de_notify 落盘）前端无法直接感知，靠 30s 轮询兜底；
    // badge-change 事件供其他操作（全部已读/删除）即时刷新。
    window.addEventListener('dsh-memory-evolve:badge-change', poll)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('dsh-memory-evolve:badge-change', poll)
    }
  }, [poll])

  /** 拉取未读列表。 */
  const loadList = useCallback((): void => {
    void fetch(`${API}/list?type=unread`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { items?: NotificationItem[] }) => setItems(data.items ?? []))
      .catch(() => setItems([]))
  }, [])

  /** 标记已读（批量 ids）。 */
  const markRead = useCallback((ids: string[]): void => {
    void fetch(`${API}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
      .then(() => { poll(); loadList() })
      .catch(() => { /* best-effort */ })
  }, [poll, loadList])

  /** 全部已读。 */
  const readAll = useCallback((): void => {
    void fetch(`${API}/readAll`, { method: 'POST' })
      .then(() => { poll(); loadList() })
      .catch(() => { /* best-effort */ })
  }, [poll, loadList])

  /** 删除单条。 */
  const removeItem = useCallback((id: string): void => {
    void fetch(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' })
      .then(() => { poll(); loadList(); setDetailId(null); setDetail(null) })
      .catch(() => { /* best-effort */ })
  }, [poll, loadList])

  /** 展开单条：拉全文（超长落文件时）+ 标记已读。 */
  const openDetail = useCallback((item: NotificationItem): void => {
    setDetailId(item.id)
    markRead([item.id])
    if (!item.hasBody) {
      setDetail({ item, content: item.content })
      return
    }
    void fetch(`${API}/${encodeURIComponent(item.id)}/content`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { content?: string }) => setDetail({ item, content: data.content ?? item.content }))
      .catch(() => setDetail({ item, content: item.content }))
  }, [markRead])

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next) loadList()
  }

  return (
    <div className="me-notify-host">
      {/* 铃铛按钮：固定右上角；未读数字徽标（>99 显示 99+）。 */}
      <button
        type="button"
        className="me-notify-bell"
        onClick={toggle}
        aria-label={t('notify.bellAria')}
        title={t('notify.bellAria')}
      >
        <span className="me-notify-bell-icon" aria-hidden="true"><BellIcon /></span>
        {unread > 0 && (
          <span className="me-notify-badge">{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {/* 通知弹窗。 */}
      {open && (
        <div className="me-notify-pop" role="dialog" aria-label={t('notify.bellAria')}>
          <div className="me-notify-pop-head">
            <span className="me-notify-pop-title">{t('notify.title')}</span>
            <button type="button" className="me-notify-readall" onClick={readAll}>
              {t('notify.readAll')}
            </button>
          </div>
          <div className="me-notify-list">
            {items === null && <div className="me-notify-empty">{t('notify.loading')}</div>}
            {items !== null && items.length === 0 && <div className="me-notify-empty">{t('notify.empty')}</div>}
            {items?.map((item) => {
              const expanded = detailId === item.id
              return (
                <div key={item.id} className={`me-notify-item${expanded ? ' me-notify-item-open' : ''}`}>
                  <button type="button" className="me-notify-item-head" onClick={() => openDetail(item)}>
                    <span className="me-notify-meta">
                      <span className={`me-notify-sender me-notify-${item.semantic}`}>
                        {item.senderName === 'system' ? t('notify.system') : item.senderName}
                      </span>
                      <span className="me-notify-subject">{item.subject}</span>
                    </span>
                    <span className="me-notify-time">{fmtTime(item.createdAt)}</span>
                  </button>
                  {!expanded && <div className="me-notify-preview">{item.content}</div>}
                  {expanded && (
                    <div className="me-notify-detail">
                      {detail?.item.id === item.id && (
                        <div className="me-notify-detail-body">
                          <pre className="me-notify-detail-content">{detail.content}</pre>
                          {item.attachments.length > 0 && (
                            <div className="me-notify-attachments">
                              {item.attachments.map((att, i) => (
                                <div key={i} className="me-notify-att">
                                  {att.mime?.startsWith('image/') ? (
                                    <img
                                      className="me-notify-att-img"
                                      src={`${API}/${encodeURIComponent(item.id)}/attachment/${i}`}
                                      alt={att.name}
                                    />
                                  ) : (
                                    <a
                                      className="me-notify-att-file"
                                      href={`${API}/${encodeURIComponent(item.id)}/attachment/${i}`}
                                      download={att.name}
                                    >
                                      {att.name}
                                    </a>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                          <div className="me-notify-detail-actions">
                            {item.sender !== '' && (
                              <button
                                type="button"
                                className="me-notify-jump"
                                onClick={() => { openSession(item.sender); setOpen(false) }}
                              >
                                {t('notify.jump')}
                              </button>
                            )}
                            <button type="button" className="me-notify-delete" onClick={() => removeItem(item.id)}>
                              {t('notify.delete')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 创建全局通知铃铛（探测宿主端 API 成功后由 index.ts 调用）。
 * @param opts - { openSession, t }。
 * @returns {{ dispose: () => void }} 卸载句柄（unmount + 移除 host）。
 */
export function createNotificationBell(opts: NotificationBellOpts): { dispose: () => void } {
  // 挂载 host 到 body（position:fixed 定位，全局常驻）。
  const host = document.createElement('div')
  host.id = 'dsh-notify-bell'
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(<Bell openSession={opts.openSession} t={opts.t} />)
  return {
    dispose() {
      root.unmount()
      host.remove()
    },
  }
}
