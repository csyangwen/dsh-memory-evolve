/**
 * web 站内通知铃铛（全局悬浮）—— 通知模块（de_notify 的 web 渠道）前端。
 *
 * 挂载方式：createRoot 到 document.body 下独立 host div（position:fixed），
 * **不占任何 slot、不依赖会话**——用户在任意会话视图都能看到这个全局铃铛
 * （通知是「发给用户本人」的，跨会话汇总）。
 *
 * 交互（必须保留）：
 *   - 铃铛按钮 + 未读数字徽标（>0 才显示；>99 显示 99+）；
 *   - 点击展开弹窗：未读通知列表；顶部「全部已读」；
 *   - 点主题跳转到发送会话（openSession；system 通知 sender 空则不可点）；
 *   - 「已读」按钮才标记已读（不自动已读）；
 *   - 长文（isLong）「查看详情」打开大弹窗（720px × 85vh，全文可滚动）。
 *
 * 展示优化：
 *   - 邮件式正文（📮主题 / 📝简介 / 👤发送人 / 🕐时间 / 📄内容）结构化解析，
 *     列表不再把「主题」行和 subject 重复渲染，也不再把发送人/时间再堆一遍；
 *   - 连续空行折叠，避免 pre-wrap 撑出大段空白。
 *
 * 拖拽吸附：
 *   - Pointer Events 拖动铃铛；松开后按水平中点吸附到左/右边缘（CSS transition）；
 *   - 位移未超过阈值视为点击（避免拖一下就误开弹窗）；
 *   - 位置写入 localStorage，刷新后恢复。
 *
 * 数据源：宿主端 /memory-evolve/api/notifications/*。轮询 30s 未读数 +
 * 监听 badge-change 事件即时刷新。
 */
import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react'

/* ------------------------------------------------------------------ */
/* 图标                                                                */
/* ------------------------------------------------------------------ */

/**
 * 铃铛线框（Feather bell，stroke=currentColor，跟随主题文字色）。
 */
function BellIcon({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

/** 大弹窗关闭按钮用的十字。 */
function CloseIcon({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* 常量 / 类型                                                         */
/* ------------------------------------------------------------------ */

/** 通知 API 基址（与宿主端 installNotifyWebApi 的 prefix 对齐）。 */
const API = '/memory-evolve/api/notifications'
/** 未读数轮询间隔（与其他 Tab 红点 BADGE_POLL_MS 一致）。 */
const POLL_MS = 30000

/**
 * 铃铛吸附位置的 localStorage 键。
 * 值形如 `{ "side": "right", "top": 97 }`：side 只存左右，left 像素每次按视口重算，
 * 这样窗口缩放后仍贴边，不会漂到屏幕中间。
 */
const POS_KEY = 'dsh-memory-evolve:notify-bell-pos'
/** 位移超过该像素才算拖拽，否则视为点击展开/收起。 */
const DRAG_THRESHOLD_PX = 6
/** 与 CSS @media (max-width: 767px) 对齐。 */
const MOBILE_MAX_W = 767
const DESKTOP_GAP = 16
const MOBILE_GAP = 10
/** 桌面默认 top：避开顶栏与其它悬浮控件（历史位置 97px）。 */
const DESKTOP_TOP = 97
const MOBILE_TOP = 56
const DESKTOP_BELL = 40
const MOBILE_BELL = 36

/** 一条通知（list 接口返回的视图，senderName 已由宿主端映射）。 */
interface NotificationItem {
  id: string
  sender: string
  senderName: string
  semantic: 'notify' | 'direct'
  subject: string
  content: string
  isLong: boolean
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

/** 吸附状态：左右边 + 垂直像素。 */
interface BellDock {
  side: 'left' | 'right'
  top: number
}

/** 展开中的单条通知（全文已拉取）。 */
interface OpenDetail {
  item: NotificationItem
  content: string
}

/**
 * 邮件式正文解析结果。COI / de_notify 建议按
 * 「📮主题 / 📝简介 / 👤发送人 / 🕐时间 / 📄内容」组织；
 * 非邮件式正文 mail=false，走 leftover（折叠空行后的原文）。
 */
interface MailFields {
  mail: boolean
  headline: string
  subject: string
  intro: string
  sender: string
  time: string
  body: string
  leftover: string
}

/* ------------------------------------------------------------------ */
/* 几何 / 持久化                                                       */
/* ------------------------------------------------------------------ */

function bellMetrics(vw: number): { mobile: boolean; gap: number; size: number; defaultTop: number } {
  const mobile = vw <= MOBILE_MAX_W
  return {
    mobile,
    gap: mobile ? MOBILE_GAP : DESKTOP_GAP,
    size: mobile ? MOBILE_BELL : DESKTOP_BELL,
    defaultTop: mobile ? MOBILE_TOP : DESKTOP_TOP,
  }
}

/** 把 top 夹在视口内，避免拖出屏幕或刷新后落在折叠窗口外。 */
function clampTop(top: number, vh: number, size: number, gap: number): number {
  const max = Math.max(gap, vh - size - gap)
  return Math.min(max, Math.max(gap, top))
}

/** 按吸附边计算 host 的 left（始终用 left，才能和 right 边做 CSS 过渡插值）。 */
function dockLeft(side: BellDock['side'], vw: number, size: number, gap: number): number {
  return side === 'left' ? gap : Math.max(gap, vw - gap - size)
}

function readDock(vw: number, vh: number): BellDock {
  const { gap, size, defaultTop } = bellMetrics(vw)
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<BellDock>
      const side: BellDock['side'] = p.side === 'left' ? 'left' : 'right'
      const top = typeof p.top === 'number' && Number.isFinite(p.top) ? p.top : defaultTop
      return { side, top: clampTop(top, vh, size, gap) }
    }
  } catch {
    /* 隐私模式 / 坏 JSON：回退默认右上 */
  }
  return { side: 'right', top: clampTop(defaultTop, vh, size, gap) }
}

function writeDock(dock: BellDock): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(dock))
  } catch {
    /* quota / 隐私模式：位置只在本次会话有效 */
  }
}

/* ------------------------------------------------------------------ */
/* 正文解析：去重主题 + 折叠空行                                        */
/* ------------------------------------------------------------------ */

/** 邮件字段行：📮 主题：xxx / 📝 简介：xxx / 📄 内容（值可空，正文在后续行）。 */
const MAIL_FIELD_RE = /^(📮|📝|👤|🕐|📄)\s*(主题|简介|发送人|时间|内容)\s*[：:]?\s*(.*)$/
/** 纯装饰分隔线（━ / ─ / — / - / = 重复），展示时丢掉。 */
const SEP_RE = /^[━─—\-_=]{4,}\s*$/

/** 连续空行压成至多一个空行，并去掉首尾空白。 */
function collapseBlank(text: string): string {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 去掉「📮 主题：」这类字段前缀，避免主题栏再显示一遍「主题」。 */
function stripSubjectPrefix(s: string): string {
  return String(s ?? '').replace(/^[📮📝👤🕐📄]\s*(主题|简介|发送人|时间|内容)\s*[：:]\s*/, '').trim()
}

/**
 * 把通知正文拆成邮件字段。识别不到字段时 mail=false，原文进 leftover。
 * 列表和大弹窗共用，保证预览与全文的去重规则一致。
 */
function parseNotifyContent(raw: string): MailFields {
  const lines = String(raw ?? '').replace(/\r\n/g, '\n').split('\n')
  const result: MailFields = {
    mail: false,
    headline: '',
    subject: '',
    intro: '',
    sender: '',
    time: '',
    body: '',
    leftover: '',
  }
  const leftover: string[] = []
  const bodyLines: string[] = []
  let inBody = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (SEP_RE.test(trimmed)) continue
    if (inBody) {
      bodyLines.push(line)
      continue
    }
    const m = trimmed.match(MAIL_FIELD_RE)
    if (m) {
      result.mail = true
      const key = m[2]
      const val = (m[3] ?? '').trim()
      if (key === '主题') result.subject = val
      else if (key === '简介') result.intro = val
      else if (key === '发送人') result.sender = val
      else if (key === '时间') result.time = val
      else if (key === '内容') {
        inBody = true
        if (val) bodyLines.push(val)
      }
      continue
    }
    // COI 自动通知开头的标记行：[COI] 任务 xx（渠道）状态
    if (/^\[COI\]/.test(trimmed)) {
      result.headline = trimmed
      result.mail = true
      continue
    }
    leftover.push(line)
  }

  result.body = collapseBlank(bodyLines.join('\n'))
  result.leftover = collapseBlank(leftover.join('\n'))
  return result
}

/**
 * 列表主题：优先用正文里解析出的「📮 主题」，再回退 item.subject，
 * 并剥掉字段前缀 / [COI] 标记行，避免和内容首行重复。
 */
function displaySubject(item: NotificationItem): string {
  const parsed = parseNotifyContent(item.content)
  if (parsed.subject) return parsed.subject
  const raw = (item.subject || '').trim()
  if (/^\[COI\]/.test(raw)) return raw.replace(/^\[COI\]\s*/, '')
  return stripSubjectPrefix(raw) || raw
}

/**
 * 列表内容区：邮件式只展示简介（其次正文），不再重复主题/发送人/时间；
 * 非邮件式则折叠空行，并去掉与 subject 相同（或就是「📮 主题：」）的首行。
 */
function previewText(item: NotificationItem): string {
  const parsed = parseNotifyContent(item.content)
  if (parsed.mail) {
    return parsed.intro || parsed.body || parsed.leftover
  }
  let text = collapseBlank(item.content)
  const first = text.split('\n')[0]?.trim() ?? ''
  const subj = (item.subject || '').trim()
  const firstNorm = stripSubjectPrefix(first) || first
  const subjNorm = stripSubjectPrefix(subj) || subj
  if (first && (first === subj || firstNorm === subjNorm || MAIL_FIELD_RE.test(first))) {
    text = collapseBlank(text.slice(text.indexOf('\n') === -1 ? text.length : text.indexOf('\n')))
  }
  return text
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

function senderLabel(item: NotificationItem, t: (key: string) => string): string {
  return item.senderName === 'system' ? t('notify.system') : item.senderName
}

/* ------------------------------------------------------------------ */
/* 子组件                                                              */
/* ------------------------------------------------------------------ */

/** 附件条：图片缩略 / 文件下载链接。列表与大弹窗共用。 */
function AttachmentList({ item }: { item: NotificationItem }): JSX.Element {
  return (
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
  )
}

/* ------------------------------------------------------------------ */
/* 主组件                                                              */
/* ------------------------------------------------------------------ */

/**
 * 铃铛 React 组件（由 createNotificationBell 挂到 body 下 host）。
 */
function Bell({ openSession, t }: NotificationBellOpts): JSX.Element {
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationItem[] | null>(null)
  // 「查看详情」大弹窗（长通知全文展示用，几千字可滚动）。
  const [modal, setModal] = useState<OpenDetail | null>(null)

  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const [dock, setDock] = useState<BellDock>(() => readDock(window.innerWidth, window.innerHeight))
  /** 拖拽中的实时坐标；非 null 时覆盖 dock 的 left/top，避免松手前被 React 拽回吸附位。 */
  const [dragBox, setDragBox] = useState<{ left: number; top: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const hostRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    origLeft: number
    origTop: number
    moved: boolean
  } | null>(null)
  /** 拖拽松手后浏览器还会再派发一次 click，用这个挡掉，避免误开弹窗。 */
  const suppressClickRef = useRef(false)
  const rafRef = useRef(0)

  const metrics = bellMetrics(vp.w)
  const hostLeft = dragBox ? dragBox.left : dockLeft(dock.side, vp.w, metrics.size, metrics.gap)
  const hostTop = dragBox ? dragBox.top : clampTop(dock.top, vp.h, metrics.size, metrics.gap)
  // 下半屏往上弹出，避免列表被视口裁切。
  const popUp = hostTop > vp.h * 0.5

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

  // 窗口缩放：右吸附要按新宽度重算 left；top 夹回视口并回写，避免刷新后又飞出去。
  useEffect(() => {
    const onResize = (): void => {
      const w = window.innerWidth
      const h = window.innerHeight
      const m = bellMetrics(w)
      setVp({ w, h })
      setDock((prev) => {
        const next = { side: prev.side, top: clampTop(prev.top, h, m.size, m.gap) }
        writeDock(next)
        return next
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 拖拽期间禁选中，避免划过页面把会话标题选蓝。
  useEffect(() => {
    if (!dragging) return
    const prev = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.userSelect = prev
    }
  }, [dragging])

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
      .then(() => { poll(); loadList(); setModal(null) })
      .catch(() => { /* best-effort */ })
  }, [poll, loadList])

  /** 标记单条已读（用户点「已读」按钮触发，不自动已读）。 */
  const markReadItem = useCallback((id: string): void => {
    markRead([id])
  }, [markRead])

  /** 打开「查看详情」大弹窗：拉全文（host full(id) 无论是否落文件都返回完整内容）。 */
  const viewDetail = useCallback((item: NotificationItem): void => {
    void fetch(`${API}/${encodeURIComponent(item.id)}/content`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { content?: string }) => setModal({ item, content: data.content ?? item.content }))
      .catch(() => setModal({ item, content: item.content }))
  }, [])

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next) loadList()
  }

  /* ---------- 拖拽：pointerdown / move / up，松手按中点吸附左右 ---------- */

  const onBellPointerDown = (e: PointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return
    const host = hostRef.current
    if (!host) return
    const rect = host.getBoundingClientRect()
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left,
      origTop: rect.top,
      moved: false,
    }
    // 捕获指针：移出按钮 / 滑到 iframe 上也不会丢 move/up。
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onBellPointerMove = (e: PointerEvent<HTMLButtonElement>): void => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    if (!d.moved) {
      d.moved = true
      setDragging(true)
      setOpen(false) // 拖的时候收起列表，避免 380px 弹窗跟着飞
    }
    const m = bellMetrics(window.innerWidth)
    const left = Math.min(window.innerWidth - m.size - m.gap, Math.max(m.gap, d.origLeft + dx))
    const top = clampTop(d.origTop + dy, window.innerHeight, m.size, m.gap)
    if (rafRef.current) window.cancelAnimationFrame(rafRef.current)
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0
      setDragBox({ left, top })
    })
  }

  const finishPointer = (e: PointerEvent<HTMLButtonElement>): void => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    dragRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* 已释放 */ }
    if (!d.moved) return // 点击交给 onClick，键盘激活也能走同一条路
    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
    suppressClickRef.current = true
    const host = hostRef.current
    const rect = host?.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const m = bellMetrics(vw)
    const curLeft = rect?.left ?? d.origLeft
    const curTop = rect?.top ?? d.origTop
    const side: BellDock['side'] = curLeft + m.size / 2 < vw / 2 ? 'left' : 'right'
    const top = clampTop(curTop, vh, m.size, m.gap)
    // 先钉在松手位置（本帧），下一帧再切到吸附 left，CSS transition 才能插值。
    setDragBox({ left: curLeft, top: curTop })
    setDragging(false)
    setVp({ w: vw, h: vh })
    window.requestAnimationFrame(() => {
      const next = { side, top }
      writeDock(next)
      setDock(next)
      setDragBox(null)
    })
  }

  const onBellClick = (e: MouseEvent<HTMLButtonElement>): void => {
    if (suppressClickRef.current) {
      e.preventDefault()
      e.stopPropagation()
      suppressClickRef.current = false
      return
    }
    toggle()
  }

  const hostClass = [
    'me-notify-host',
    dock.side === 'left' ? 'me-notify-side-left' : 'me-notify-side-right',
    dragging ? 'me-notify-dragging' : '',
  ].filter(Boolean).join(' ')

  const modalParsed = modal ? parseNotifyContent(modal.content) : null

  return (
    <div
      ref={hostRef}
      className={hostClass}
      style={{ left: hostLeft, top: hostTop }}
    >
      {/* 铃铛按钮：可拖；未读数字徽标（>99 显示 99+）。 */}
      <button
        type="button"
        className={`me-notify-bell${unread > 0 ? ' me-notify-bell-unread' : ''}`}
        onClick={onBellClick}
        onPointerDown={onBellPointerDown}
        onPointerMove={onBellPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        aria-label={t('notify.bellAria')}
        aria-expanded={open}
        title={t('notify.bellAria')}
      >
        <span className="me-notify-bell-icon" aria-hidden="true"><BellIcon /></span>
        {unread > 0 && (
          <span className="me-notify-badge">{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {/* 通知弹窗。 */}
      {open && (
        <div
          className={`me-notify-pop${popUp ? ' me-notify-pop-up' : ''}`}
          role="dialog"
          aria-label={t('notify.bellAria')}
        >
          <div className="me-notify-pop-head">
            <span className="me-notify-pop-title">{t('notify.title')}</span>
            {unread > 0 && <span className="me-notify-pop-count">{unread > 99 ? '99+' : unread}</span>}
            <button type="button" className="me-notify-readall" onClick={readAll}>
              {t('notify.readAll')}
            </button>
          </div>
          <div className="me-notify-list">
            {items === null && <div className="me-notify-empty">{t('notify.loading')}</div>}
            {items !== null && items.length === 0 && (
              <div className="me-notify-empty">
                <span className="me-notify-empty-icon" aria-hidden="true"><BellIcon size={22} /></span>
                <span>{t('notify.empty')}</span>
              </div>
            )}
            {items?.map((item) => {
              const parsed = parseNotifyContent(item.content)
              const preview = previewText(item)
              return (
                <div key={item.id} className="me-notify-item">
                  {/* 第一行：发送人（左）+ 时间（右） */}
                  <div className="me-notify-item-head">
                    <span className={`me-notify-sender me-notify-${item.semantic}`}>
                      {senderLabel(item, t)}
                    </span>
                    {parsed.headline && <span className="me-notify-coi-chip">COI</span>}
                    <span className="me-notify-time">{fmtTime(item.createdAt)}</span>
                  </div>
                  {/* 第二行：主题（点击跳转到发送会话；system 通知无 sender 不可点） */}
                  <button
                    type="button"
                    className="me-notify-subject"
                    disabled={item.sender === ''}
                    onClick={() => { if (item.sender) { openSession(item.sender); setOpen(false) } }}
                    title={item.sender ? t('notify.jump') : undefined}
                  >
                    {displaySubject(item)}
                  </button>
                  {/* 内容：已去重主题、折叠空行；长文截断 + 「查看详情」。 */}
                  {preview ? (
                    <div className={`me-notify-content${item.isLong ? ' me-notify-content-clamped' : ''}`}>
                      {preview}
                    </div>
                  ) : null}
                  {item.attachments.length > 0 && <AttachmentList item={item} />}
                  {/* 底部操作：已读按钮（不自动已读）+ 长文「查看详情」。 */}
                  <div className="me-notify-item-actions">
                    <button type="button" className="me-notify-markread" onClick={() => markReadItem(item.id)}>
                      {t('notify.markRead')}
                    </button>
                    {item.isLong && (
                      <button type="button" className="me-notify-more" onClick={() => viewDetail(item)}>
                        {t('notify.viewDetail')}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 「查看详情」大弹窗：长通知全文展示，几千字可滚动。 */}
      {modal && modalParsed && (
        <div className="me-notify-modal-backdrop" onClick={() => setModal(null)}>
          <div className="me-notify-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="me-notify-modal-head">
              <span className="me-notify-modal-title">{displaySubject(modal.item) || t('notify.title')}</span>
              <button type="button" className="me-notify-modal-close" onClick={() => setModal(null)} aria-label={t('notify.close')}>
                <CloseIcon />
              </button>
            </div>
            <div className="me-notify-modal-body">
              <div className="me-notify-modal-meta">
                <span className={`me-notify-sender me-notify-${modal.item.semantic}`}>
                  {senderLabel(modal.item, t)}
                </span>
                {modalParsed.headline && <span className="me-notify-coi-chip">COI</span>}
                <span className="me-notify-time">{fmtTime(modal.item.createdAt)}</span>
              </div>
              {/*
               * 邮件式：头里已有主题/发送人/时间，这里只渲染简介 + 正文 + 剩余段落，
               * 避免再堆一遍 📮/👤/🕐。非邮件式则折叠空行后整篇展示。
               */}
              {modalParsed.mail ? (
                <div className="me-notify-mail">
                  {modalParsed.headline && (
                    <div className="me-notify-mail-headline">{modalParsed.headline}</div>
                  )}
                  {modalParsed.intro && (
                    <div className="me-notify-mail-intro">{modalParsed.intro}</div>
                  )}
                  {modalParsed.body && (
                    <pre className="me-notify-modal-content">{modalParsed.body}</pre>
                  )}
                  {modalParsed.leftover && (
                    <pre className="me-notify-modal-content">{modalParsed.leftover}</pre>
                  )}
                </div>
              ) : (
                <pre className="me-notify-modal-content">{collapseBlank(modal.content)}</pre>
              )}
              {modal.item.attachments.length > 0 && <AttachmentList item={modal.item} />}
              <div className="me-notify-detail-actions">
                {modal.item.sender !== '' && (
                  <button
                    type="button"
                    className="me-notify-jump"
                    onClick={() => { openSession(modal.item.sender); setModal(null); setOpen(false) }}
                  >
                    {t('notify.jump')}
                  </button>
                )}
                <button type="button" className="me-notify-delete" onClick={() => removeItem(modal.item.id)}>
                  {t('notify.delete')}
                </button>
              </div>
            </div>
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
