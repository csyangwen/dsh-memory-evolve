/**
 * 会话广播管理 Tab（conversation.view entry，跟随 broadcastEnabled 探测）。
 *
 * **用户超管视角**：查看/管理广播消息与房间——
 *  - 子 Tab：指南（本模块友好介绍，与其他 Tab 同款）/ 消息 / 房间
 *    （复用全局 mt-file-tabs/mt-file-tab 类，与记忆/待办/技能等 Tab
 *     子 Tab 视觉零差异；子 Tab 恒为面板第一个元素、左上角）
 *  - 消息收件箱：**默认只显示未读的非房间消息**（房间消息进对应房间查看，
 *    层次清晰）；状态徽标（未读/已读）、筛选（未读/全部/已读）、搜索
 *    （主题/发件人/内容）、分页（20 条/页）、点开全文、删除任意消息
 *  - 房间：全部房间（含已解散，追溯）+ 成员在线状态（🟢/⚪ 30s 轮询，
 *    最近活动时间持久化落盘，重启不丢）+
 *    **房间消息**（展开房间查看，含状态/全文/删除；同款筛选/搜索/分页）+ 踢人/解散（系统通知）
 *  - 顶部：子 Tab 下方为我的会话（别名优先）+ 复制 ID/别名
 * 不做发消息（AI 用 de_broadcast send 自然语言驱动）。
 * 数据源：/memory-evolve/api/broadcast/*（host 超管 API）+ /api/aliases。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { TabGuideView } from './TabGuideView.tsx'

const API = '/memory-evolve/api/broadcast'
const PAGE_SIZE = 20

/** 一条消息（API 返回的视图）。 */
interface Msg {
  id: string
  sender: string
  recipients: string[]
  subject: string
  content: string
  hasBody: boolean
  createdAt: number
  readBy: string[]
  /** 图片附件元数据（P3 2026-08-11；UI 通过下载端点取字节渲染缩略图）。 */
  attachments?: Array<{ name: string; size: number; mime: string }>
}

/** 一个房间（API 返回的视图，含已解散与在线聚合）。 */
interface Room {
  id: string
  name: string
  members: string[]
  status: 'active' | 'dissolved'
  createdAt: number
  lastActiveAt: number
  dissolvedAt: number | null
  createdBy: string
  onlineCount: number
}

/** 成员在线状态（API /rooms/:id/presence）。 */
interface Presence {
  sessionId: string
  status: string
  online: boolean
  lastActiveAt: number | null
}

interface Notice { kind: 'ok' | 'error'; text: string }

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { 'content-type': 'application/json' }, ...init })
  const body = (await res.json().catch(() => ({}))) as { message?: string }
  if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`)
  return body as T
}

function errText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text !== undefined && text.trim() !== '' ? text : '操作失败（无错误详情）'
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** 接收者是否房间引用（room:<id> 或裸房间 id）。 */
function isRoomRef(r: string): boolean {
  return r.startsWith('room:') || /^room-[0-9a-z-]+$/.test(r)
}

/** 收件人可读化：会话 ID 显示别名（悬停完整 ID）、room:→房间名、project:→路径。 */
function recipientLabel(r: string, rooms: Map<string, Room>, aliases: Record<string, string>): string {
  if (r.startsWith('room:') || /^room-[0-9a-z-]+$/.test(r)) {
    const rid = r.startsWith('room:') ? r.slice(5) : r
    const room = rooms.get(rid)
    return room !== undefined ? room.name : rid
  }
  if (r.startsWith('project:')) return r.slice(8)
  return displayName(r, aliases)
}

function shortId(id: string, n = 14): string {
  return id.length > n ? `${id.slice(0, n)}…` : id
}

/** 会话显示名：别名优先（别名（短ID）），无别名=短 ID；完整 ID 供 title 悬停。 */
function displayName(sid: string, aliases: Record<string, string>): string {
  const short = shortId(sid, 14)
  if (aliases[sid] !== undefined) return `${aliases[sid]}（${short}）`
  return short
}

/**
 * 工作区协调（ws-coord）设置面板——广播模块的**子功能设置**。
 * 用户拍板（2026-08-09）：子功能的开关放在广播面板自己的「设置」子 Tab 里，
 * 「Memory Evolve 设置」Tab 只控制大模块开关（broadcastEnabled）。
 * 数据通道：GET/POST /memory-evolve/api/config（与 MemoryQueueView 同款）。
 * 开关：wsCoordEnabled 总开关 + 展开后的两个子开关（快照段 / 硬拦截）。
 */
function WsCoordSettings({ t }: { t: Translate }): JSX.Element {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 加载当前运行时配置（含 wsCoord* 键）
  useEffect(() => {
    let cancelled = false
    fetch('/memory-evolve/api/config')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: { config?: Record<string, unknown> }) => {
        if (!cancelled && body.config) setConfig(body.config)
      })
      .catch((err: unknown) => { if (!cancelled) setError(errText(err)) })
    return () => { cancelled = true }
  }, [])

  /** 切换一个开关：POST patch → 服务端校验并落盘 → 回写本地 config。 */
  const patch = (key: string, value: boolean): void => {
    setBusy(true)
    setError(null)
    fetch('/memory-evolve/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { [key]: value } }),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: { config?: Record<string, unknown> }) => {
        if (body.config) setConfig(body.config)
      })
      .catch((err: unknown) => setError(errText(err)))
      .finally(() => setBusy(false))
  }

  if (config === null) return <div className="bb-empty">{t('broadcast.loading')}</div>
  const on = (k: string): boolean => config[k] === true
  return (
    <div className="bb-settings">
      <div className="bb-settings-title">{t('broadcast.settings.wsCoord.title')}</div>
      <p className="bb-settings-desc">{t('broadcast.settings.wsCoord.desc')}</p>
      <label className="me-field">
        <span className="me-field-label">
          {t('broadcast.settings.wsCoord.enabled')}
          <em className="me-field-hint">{t('broadcast.settings.wsCoord.enabled.hint')}</em>
        </span>
        <input
          type="checkbox"
          className="me-switch"
          checked={on('wsCoordEnabled')}
          disabled={busy}
          onChange={(event) => patch('wsCoordEnabled', event.target.checked)}
        />
      </label>
      {on('wsCoordEnabled') && (
        <>
          <label className="me-field me-field-sub">
            <span className="me-field-label">
              {t('broadcast.settings.wsCoord.snapshot')}
              <em className="me-field-hint">{t('broadcast.settings.wsCoord.snapshot.hint')}</em>
            </span>
            <input
              type="checkbox"
              className="me-switch"
              checked={on('wsCoordSnapshot')}
              disabled={busy}
              onChange={(event) => patch('wsCoordSnapshot', event.target.checked)}
            />
          </label>
          <label className="me-field me-field-sub">
            <span className="me-field-label">
              {t('broadcast.settings.wsCoord.enforce')}
              <em className="me-field-hint">{t('broadcast.settings.wsCoord.enforce.hint')}</em>
            </span>
            <input
              type="checkbox"
              className="me-switch"
              checked={on('wsCoordEnforceWrite')}
              disabled={busy}
              onChange={(event) => patch('wsCoordEnforceWrite', event.target.checked)}
            />
          </label>
        </>
      )}
      {error !== null && <div className="bb-error">{error}</div>}
    </div>
  )
}

export function BroadcastView(props: ConvViewProps & { t: Translate }): JSX.Element {
  const { t, sessionId } = props
  const [view, setView] = useState<'guide' | 'messages' | 'rooms' | 'settings'>('messages')
  const [messages, setMessages] = useState<Msg[] | null>(null)
  const [rooms, setRooms] = useState<Room[] | null>(null)
  const [roomMap, setRoomMap] = useState<Map<string, Room>>(new Map())
  const [aliases, setAliases] = useState<Record<string, string>>({})
  // 消息视图：筛选/搜索/分页
  const [filter, setFilter] = useState<'unread' | 'all' | 'read'>('unread')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  // 房间消息视图（展开房间后）：与消息列表同款的筛选/搜索/分页（展开/收起时重置）
  const [roomMsgFilter, setRoomMsgFilter] = useState<'unread' | 'all' | 'read'>('unread')
  const [roomMsgQuery, setRoomMsgQuery] = useState('')
  const [roomMsgPage, setRoomMsgPage] = useState(1)
  // 房间视图（列表）：搜索（名字）/状态筛选（全部/活跃/已解散）/时间筛选（最近N天）/分页
  const [roomQuery, setRoomQuery] = useState('')
  const [roomStatus, setRoomStatus] = useState<'all' | 'active' | 'dissolved'>('active')
  const [roomDays, setRoomDays] = useState(0)   // 0=不限；7/30=最近 N 天创建
  const [roomPage, setRoomPage] = useState(1)
  // 展开状态
  const [expanded, setExpanded] = useState<string | null>(null)   // 消息视图展开全文的消息 id
  const [fullText, setFullText] = useState<Record<string, string>>({})
  /** 正在看原图的附件（"消息id:序号"；null=未展开）。点击缩略图切换。 */
  const [openImage, setOpenImage] = useState<string | null>(null)
  const [openRoom, setOpenRoom] = useState<string | null>(null)   // 展开的房间 id
  const [roomMsgExpanded, setRoomMsgExpanded] = useState<string | null>(null)
  const [presence, setPresence] = useState<Record<string, Presence[]>>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [copied, setCopied] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      const [m, r, a] = await Promise.all([
        fetchJson<{ messages: Msg[] }>('/messages'),
        fetchJson<{ rooms: Room[] }>('/rooms'),
        fetch('/memory-evolve/api/aliases').then((res) => (res.ok ? res.json() : { aliases: {} })) as Promise<{ aliases?: Record<string, string> }>,
      ])
      setMessages(m.messages)
      setRooms(r.rooms)
      setRoomMap(new Map(r.rooms.map((room) => [room.id, room])))
      setAliases(a.aliases ?? {})
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 30_000)
    return () => clearInterval(timer)
  }, [load])

  // 消息列表（默认不含房间消息——房间消息进对应房间查看，层次清晰）
  const directMessages = useMemo(() => {
    const items = messages ?? []
    return items.filter((m) => !m.recipients.some((r) => isRoomRef(r)))
  }, [messages])

  const filteredMessages = useMemo(() => {
    let items = directMessages
    if (filter === 'unread') items = items.filter((m) => m.readBy.length === 0)
    if (filter === 'read') items = items.filter((m) => m.readBy.length > 0)
    if (query.trim() !== '') {
      const q = query.trim().toLowerCase()
      items = items.filter((m) =>
        m.subject.toLowerCase().includes(q)
        || m.sender.toLowerCase().includes(q)
        || m.content.toLowerCase().includes(q))
    }
    return items
  }, [directMessages, filter, query])

  const totalPages = Math.max(1, Math.ceil(filteredMessages.length / PAGE_SIZE))
  const pageItems = filteredMessages.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  // 房间消息（展开房间时显示）
  const roomMessages = useMemo(() => {
    if (openRoom === null || messages === null) return []
    return messages.filter((m) => m.recipients.includes(`room:${openRoom}`) || m.recipients.includes(openRoom))
  }, [openRoom, messages])

  // 房间消息筛选/搜索/分页（纯前端，基于 roomMessages 派生）
  const filteredRoomMessages = useMemo(() => {
    let items = roomMessages
    if (roomMsgFilter === 'unread') items = items.filter((m) => m.readBy.length === 0)
    if (roomMsgFilter === 'read') items = items.filter((m) => m.readBy.length > 0)
    if (roomMsgQuery.trim() !== '') {
      const q = roomMsgQuery.trim().toLowerCase()
      items = items.filter((m) =>
        m.subject.toLowerCase().includes(q)
        || m.sender.toLowerCase().includes(q)
        || m.content.toLowerCase().includes(q))
    }
    return items
  }, [roomMessages, roomMsgFilter, roomMsgQuery])

  const roomTotalPages = Math.max(1, Math.ceil(filteredRoomMessages.length / PAGE_SIZE))
  const roomPageItems = filteredRoomMessages.slice((roomMsgPage - 1) * PAGE_SIZE, roomMsgPage * PAGE_SIZE)

  // 房间列表筛选（名字搜索 + 状态 + 最近 N 天 + 分页，纯前端派生）
  const filteredRooms = useMemo(() => {
    const items = rooms ?? []
    const q = roomQuery.trim().toLowerCase()
    const since = roomDays > 0 ? Date.now() - roomDays * 86400000 : 0
    return items
      .filter((r) => roomStatus === 'all' || r.status === roomStatus)
      .filter((r) => q === '' || r.name.toLowerCase().includes(q))
      .filter((r) => since === 0 || r.createdAt >= since)
  }, [rooms, roomQuery, roomStatus, roomDays])

  const roomListTotalPages = Math.max(1, Math.ceil(filteredRooms.length / PAGE_SIZE))
  const roomListPageItems = filteredRooms.slice((roomPage - 1) * PAGE_SIZE, roomPage * PAGE_SIZE)

  const deleteMessage = async (msg: Msg): Promise<void> => {
    if (!window.confirm(t('broadcast.message.deleteConfirm', { subject: msg.subject }))) return
    try {
      await fetchJson<{ ok: boolean }>(`/messages/${encodeURIComponent(msg.id)}`, { method: 'DELETE' })
      setNotice({ kind: 'ok', text: t('broadcast.message.deleted') })
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    }
  }

  /** 展开/收起消息全文（长内容走 /content）。 */
  const toggleExpand = async (msg: Msg, expandId: string, setExpandId: (id: string | null) => void): Promise<void> => {
    if (expandId === msg.id) {
      setExpandId(null)
      return
    }
    setExpandId(msg.id)
    if (fullText[msg.id] === undefined) {
      try {
        const res = await fetchJson<{ content: string }>(`/messages/${encodeURIComponent(msg.id)}/content`)
        setFullText((prev) => ({ ...prev, [msg.id]: res.content }))
      } catch (err) {
        setNotice({ kind: 'error', text: errText(err) })
      }
    }
  }

  /** 展开房间成员 + 拉在线状态；展开/收起时重置房间消息筛选状态。 */
  const toggleRoom = async (room: Room): Promise<void> => {
    if (openRoom === room.id) {
      setOpenRoom(null)
      setRoomMsgExpanded(null)
      setRoomMsgFilter('unread')
      setRoomMsgQuery('')
      setRoomMsgPage(1)
      return
    }
    setOpenRoom(room.id)
    setRoomMsgExpanded(null)
    setRoomMsgFilter('unread')
    setRoomMsgQuery('')
    setRoomMsgPage(1)
    try {
      const res = await fetchJson<{ presence: Presence[] }>(`/rooms/${encodeURIComponent(room.id)}/presence`)
      setPresence((prev) => ({ ...prev, [room.id]: res.presence }))
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    }
  }

  const kickMember = async (room: Room, member: string): Promise<void> => {
    if (!window.confirm(t('broadcast.room.kickConfirm', { member }))) return
    try {
      await fetchJson<{ ok: boolean }>(`/rooms/${encodeURIComponent(room.id)}/kick`, {
        method: 'POST',
        body: JSON.stringify({ member }),
      })
      setNotice({ kind: 'ok', text: t('broadcast.room.kick') })
      void load()
      setOpenRoom(null)
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    }
  }

  const dissolveRoom = async (room: Room): Promise<void> => {
    if (!window.confirm(t('broadcast.room.dissolveConfirm', { name: room.name }))) return
    try {
      const res = await fetchJson<{ ok: boolean; message?: string }>(`/rooms/${encodeURIComponent(room.id)}/dissolve`, { method: 'POST' })
      if (res.ok !== true) {
        setNotice({ kind: 'error', text: res.message ?? '操作失败' })
        return
      }
      setNotice({ kind: 'ok', text: t('broadcast.room.dissolved') })
      void load()
    } catch (err) {
      setNotice({ kind: 'error', text: errText(err) })
    }
  }

  const copyText = (text: string, key: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      window.setTimeout(() => setCopied(''), 1500)
    }).catch(() => { /* 剪贴板被拒：静默 */ })
  }

  /** 消息卡片（消息列表与房间消息共用）。 */
  const renderMsgCard = (m: Msg, expandId: string, setExpandId: (id: string | null) => void): JSX.Element => {
    const from = m.sender === 'system' ? '系统' : displayName(m.sender, aliases)
    const to = m.recipients.map((r) => recipientLabel(r, roomMap, aliases)).join(', ')
    const unread = m.readBy.length === 0 // 超管视角：无人读过 = 未读
    const isOpen = expandId === m.id
    return (
      <div key={m.id} className="bb-card">
        <div className="bb-row">
          <span className="bb-strong">{m.subject || '（无主题）'}</span>
          <span className={`bb-badge${unread ? ' bb-badge-unread' : ' bb-badge-read'}`}>
            {unread ? t('broadcast.msg.unread') : t('broadcast.msg.read')}
          </span>
          {m.hasBody && <span className="bb-badge bb-badge-long">{t('broadcast.messages.long')}</span>}
          <span className="bb-grow" />
          <span className="bb-muted bb-small">{fmtTime(m.createdAt)}</span>
          <button type="button" className="bb-btn bb-btn-mini" onClick={() => void toggleExpand(m, expandId, setExpandId)}>
            {isOpen ? t('broadcast.message.collapse') : t('broadcast.message.expand')}
          </button>
          <button type="button" className="bb-btn bb-btn-mini bb-btn-danger" onClick={() => void deleteMessage(m)}>
            {t('broadcast.message.delete')}
          </button>
        </div>
        <div className="bb-muted bb-small" title={m.sender === 'system' ? undefined : m.sender}>
          {t('broadcast.messages.sender')}：{from} · {t('broadcast.messages.to')}：{to}
        </div>
        {isOpen && (
          <pre className="bb-content">{fullText[m.id] ?? m.content}</pre>
        )}
        {/* 图片附件缩略图（P3 2026-08-11）：横向排列 64px 缩略图，点击在
            卡片下方展开原图（再点收起）；字节来自附件下载端点
            /messages/<id>/attachment/<序号>（不暴露文件系统路径）。 */}
        {Array.isArray(m.attachments) && m.attachments.length > 0 && (
          <div className="bb-attachments">
            {m.attachments.map((a, i) => {
              const key = `${m.id}:${i}`
              const src = `${API}/messages/${encodeURIComponent(m.id)}/attachment/${i}`
              const open = openImage === key
              return (
                <div key={key} className="bb-att-item">
                  <button
                    type="button"
                    className="bb-att-thumb"
                    title={`${a.name}（${(a.size / 1024).toFixed(0)} KB）`}
                    onClick={() => setOpenImage(open ? null : key)}
                  >
                    <img src={src} alt={a.name} loading="lazy" className="bb-att-thumb-img" />
                  </button>
                  {open && (
                    <div className="bb-att-preview" onClick={() => setOpenImage(null)}>
                      <img src={src} alt={a.name} className="bb-att-preview-img" />
                      <span className="bb-att-preview-name">{a.name}</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  /** 筛选芯片 + 搜索框工具栏（消息列表与房间消息共用结构）。 */
  const renderToolbar = (
    currentFilter: 'unread' | 'all' | 'read',
    onFilter: (f: 'unread' | 'all' | 'read') => void,
    currentQuery: string,
    onQuery: (q: string) => void,
  ): JSX.Element => (
    <div className="bb-toolbar">
      {(['unread', 'all', 'read'] as const).map((f) => (
        <button
          key={f}
          type="button"
          className={`bb-chip${currentFilter === f ? ' bb-chip-active' : ''}`}
          onClick={() => onFilter(f)}
        >
          {t(`broadcast.filter.${f}`)}
        </button>
      ))}
      <input
        className="bb-search"
        placeholder={t('broadcast.searchPh')}
        value={currentQuery}
        onChange={(e) => onQuery(e.target.value)}
      />
    </div>
  )

  /** 分页条（消息列表与房间消息共用）。 */
  const renderPager = (
    currentPage: number,
    total: number,
    onPage: (p: number) => void,
  ): JSX.Element | null => {
    if (total <= 1) return null
    return (
      <div className="bb-pager">
        <button type="button" className="bb-btn bb-btn-mini" disabled={currentPage <= 1} onClick={() => onPage(currentPage - 1)}>
          {t('broadcast.pagePrev')}
        </button>
        <span className="bb-muted bb-small">{t('broadcast.pageInfo', { page: currentPage, total })}</span>
        <button type="button" className="bb-btn bb-btn-mini" disabled={currentPage >= total} onClick={() => onPage(currentPage + 1)}>
          {t('broadcast.pageNext')}
        </button>
      </div>
    )
  }

  const myAlias = aliases[sessionId]

  /** 本 Tab 指南（对齐其他 Tab：TabGuideView 结构化介绍，文案走全局 locale）。 */
  const renderGuide = (): JSX.Element => (
    <TabGuideView sections={[
      { icon: '📨', title: t('broadcast.guide.intro.title'), body: t('broadcast.guide.intro.body') },
      { icon: '✉️', title: t('broadcast.guide.send.title'), body: t('broadcast.guide.send.body'), items: [t('broadcast.guide.send.item1'), t('broadcast.guide.send.item2'), t('broadcast.guide.send.item3')] },
      { icon: '📥', title: t('broadcast.guide.inbox.title'), body: t('broadcast.guide.inbox.body'), items: [t('broadcast.guide.inbox.item1'), t('broadcast.guide.inbox.item2'), t('broadcast.guide.inbox.item3')] },
      { icon: '👥', title: t('broadcast.guide.room.title'), body: t('broadcast.guide.room.body'), items: [t('broadcast.guide.room.item1'), t('broadcast.guide.room.item2'), t('broadcast.guide.room.item3')] },
      { icon: '🏷️', title: t('broadcast.guide.alias.title'), body: t('broadcast.guide.alias.body'), items: [t('broadcast.guide.alias.item1'), t('broadcast.guide.alias.item2')] },
      { icon: '⚙️', title: t('broadcast.guide.switch.title'), body: t('broadcast.guide.switch.body') },
    ]} />
  )

  return (
    <div className="bb-pane">
      {/* ① 子 Tab 恒为面板第一个元素（左上角），复用全局 mt-file-tabs /
          mt-file-tab / mt-file-tab-active —— 与记忆/待办/技能等 Tab 的
          子 Tab（指南/主功能）视觉零差异（32px 高 + 底部横线 + active 品牌色） */}
      <div className="mt-file-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'guide'}
          className={view === 'guide' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setView('guide')}
        >
          {t('broadcast.tab.guide')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'messages'}
          className={view === 'messages' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setView('messages')}
        >
          {t('broadcast.tab.messages')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'rooms'}
          className={view === 'rooms' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setView('rooms')}
        >
          {t('broadcast.tab.rooms')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'settings'}
          className={view === 'settings' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setView('settings')}
        >
          {t('broadcast.tab.settings')}
        </button>
      </div>

      {/* ② 会话 ID 区块在子 Tab 下方（不再与 Tab 并排） */}
      <div className="bb-session-line" title={sessionId}>
        <span className="bb-session-label">{t('broadcast.mySessionId')}：</span>
        <code className="bb-mono">
          {myAlias !== undefined ? `${myAlias}（${shortId(sessionId)}）` : shortId(sessionId)}
        </code>
        <button type="button" className="bb-btn bb-btn-mini" onClick={() => copyText(sessionId, 'id')}>
          {copied === 'id' ? t('broadcast.copied') : t('broadcast.copyId')}
        </button>
        {myAlias !== undefined && (
          <button type="button" className="bb-btn bb-btn-mini" onClick={() => copyText(myAlias, 'alias')}>
            {copied === 'alias' ? t('broadcast.copied') : t('broadcast.copyAlias')}
          </button>
        )}
      </div>

      {/* 通知/错误放子 Tab 之后（不挤占左上角） */}
      {notice !== null && <div className={`bb-notice bb-notice-${notice.kind}`}>{notice.text}</div>}
      {error !== null && <div className="bb-error">{error}</div>}

      {view === 'guide' && renderGuide()}

      {/* 设置子 Tab：工作区协调（ws-coord）子功能开关（用户拍板——
          Memory Evolve 设置只控制大模块开关，子功能设置放广播面板内） */}
      {view === 'settings' && <WsCoordSettings t={t} />}

      {view === 'messages' && (
        <div className="bb-list">
          {messages === null && <div className="bb-empty">{t('broadcast.loading')}</div>}
          {messages !== null && (
            <>
              {renderToolbar(
                filter,
                (f) => { setFilter(f); setPage(1) },
                query,
                (q) => { setQuery(q); setPage(1) },
              )}
              {directMessages.length === 0 && (
                <div className="bb-empty">
                  {t('broadcast.messages.empty')}
                  {messages.some((m) => m.recipients.some((r) => isRoomRef(r))) && (
                    <div className="bb-hint">{t('broadcast.messages.roomInRooms')}</div>
                  )}
                </div>
              )}
              {directMessages.length > 0 && filteredMessages.length === 0 && (
                <div className="bb-empty">{t('broadcast.messages.empty')}</div>
              )}
              {pageItems.map((m) => renderMsgCard(m, expanded, setExpanded))}
              {renderPager(page, totalPages, setPage)}
            </>
          )}
        </div>
      )}

      {view === 'rooms' && (
        <div className="bb-list">
          {rooms === null && <div className="bb-empty">{t('broadcast.loading')}</div>}
          {rooms !== null && (
            <>
              {/* 房间列表工具栏：名字搜索 + 状态筛选（全部/活跃/已解散）+ 时间筛选 + 分页 */}
              <div className="bb-toolbar">
                {(['all', 'active', 'dissolved'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`bb-chip${roomStatus === s ? ' bb-chip-active' : ''}`}
                    onClick={() => { setRoomStatus(s); setRoomPage(1) }}
                  >
                    {t(`broadcast.roomStatus.${s}`)}
                  </button>
                ))}
                {([0, 7, 30] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`bb-chip${roomDays === d ? ' bb-chip-active' : ''}`}
                    onClick={() => { setRoomDays(d); setRoomPage(1) }}
                  >
                    {t(`broadcast.roomDays.${d}`)}
                  </button>
                ))}
                <input
                  className="bb-search"
                  placeholder={t('broadcast.roomSearchPh')}
                  value={roomQuery}
                  onChange={(e) => { setRoomQuery(e.target.value); setRoomPage(1) }}
                />
              </div>
              {filteredRooms.length === 0 && (
                <div className="bb-empty">{t('broadcast.rooms.empty')}</div>
              )}
              {roomListPageItems.map((room) => {
            const dissolved = room.status === 'dissolved'
            const online = room.onlineCount > 0 && !dissolved
            const statusLabel = dissolved
              ? t('broadcast.room.status.dissolved')
              : online ? t('broadcast.room.status.active') : t('broadcast.room.status.idle')
            const members = presence[room.id] ?? room.members.map((sid) => ({ sessionId: sid, status: 'unknown', online: false, lastActiveAt: null }))
            const isOpen = openRoom === room.id
            return (
              <div key={room.id} className={`bb-card${isOpen ? ' bb-card-open' : ''}${dissolved ? ' bb-card-dissolved' : ''}`}>
                <div className="bb-row">
                  <span className={`bb-dot${online ? ' bb-dot-on' : dissolved ? ' bb-dot-off' : ' bb-dot-idle'}`} />
                  <span className="bb-strong">{room.name}</span>
                  <span className={`bb-badge${dissolved ? ' bb-badge-dissolved' : online ? ' bb-badge-online' : ''}`}>
                    {statusLabel}
                  </span>
                  <span className="bb-badge">
                    {t('broadcast.room.online', { online: room.onlineCount, total: room.members.length })}
                  </span>
                  <span className="bb-grow" />
                  <span className="bb-muted bb-small">{t('broadcast.room.lastActive')}：{fmtTime(room.lastActiveAt)}</span>
                  {/* 进入房间详情：正常按钮尺寸，不再套 bb-btn-mini */}
                  <button type="button" className="bb-btn bb-btn-detail" onClick={() => void toggleRoom(room)}>
                    {isOpen ? t('broadcast.message.collapse') : t('broadcast.room.detail')}
                  </button>
                  {!dissolved && (
                    <button type="button" className="bb-btn bb-btn-mini bb-btn-danger" onClick={() => void dissolveRoom(room)}>
                      {t('broadcast.room.dissolve')}
                    </button>
                  )}
                </div>
                <div className="bb-meta">
                  <code className="bb-mono bb-small">{room.id}</code>
                  <span className="bb-muted bb-small">
                    · {t('broadcast.room.created')} {fmtTime(room.createdAt)} · {room.members.length} {t('broadcast.room.members')}
                  </span>
                  <button type="button" className="bb-btn bb-btn-mini" onClick={() => copyText(room.id, `room-${room.id}`)}>
                    {t('broadcast.room.copyId')}
                  </button>
                </div>
                {isOpen && (
                  <>
                    <div className="bb-members">
                      <div className="bb-section-title">{t('broadcast.room.members')}</div>
                      {members.map((p) => (
                        <div key={p.sessionId} className="bb-row bb-member" title={p.sessionId}>
                          <span className={`bb-dot${p.online ? ' bb-dot-on' : ' bb-dot-idle'}`} />
                          <code className="bb-mono">{displayName(p.sessionId, aliases)}</code>
                          <span className="bb-muted bb-small">
                            {p.online ? 'running' : p.status === 'idle' ? 'idle' : t('broadcast.room.presence.unknown')}
                            {p.lastActiveAt !== null ? ` · ${fmtTime(p.lastActiveAt)}` : ''}
                          </span>
                          <span className="bb-grow" />
                          {!dissolved && (
                            <button type="button" className="bb-btn bb-btn-mini bb-btn-danger" onClick={() => void kickMember(room, p.sessionId)}>
                              {t('broadcast.room.kick')}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    {/* 房间消息：同款筛选/搜索/分页 */}
                    <div className="bb-room-msgs">
                      <div className="bb-section-title">
                        {t('broadcast.room.messages')}
                        <span className="bb-count">{roomMessages.length}</span>
                      </div>
                      {renderToolbar(
                        roomMsgFilter,
                        (f) => { setRoomMsgFilter(f); setRoomMsgPage(1) },
                        roomMsgQuery,
                        (q) => { setRoomMsgQuery(q); setRoomMsgPage(1) },
                      )}
                      {roomMessages.length === 0 && (
                        <div className="bb-empty bb-empty-sm">{t('broadcast.room.messages.empty')}</div>
                      )}
                      {roomMessages.length > 0 && filteredRoomMessages.length === 0 && (
                        <div className="bb-empty bb-empty-sm">{t('broadcast.room.messages.empty')}</div>
                      )}
                      {roomPageItems.map((m) => renderMsgCard(m, roomMsgExpanded, setRoomMsgExpanded))}
                      {renderPager(roomMsgPage, roomTotalPages, setRoomMsgPage)}
                    </div>
                  </>
                )}
              </div>
            )
          })}
              {renderPager(roomPage, roomListTotalPages, setRoomPage)}
            </>
          )}
        </div>
      )}
    </div>
  )
}
