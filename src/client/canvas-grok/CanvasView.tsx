/**
 * 无限画板 Tab 根组件。
 *
 * 负责：视角筛选、三种上板、画板内搜索、复制/移除、
 * localStorage 持久化（后端模式：整板走宿主 API + rev 乐观锁）。
 * 画布手势本身交给 CanvasBoard。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconPlusOutline16,
  IconSearchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { CanvasBoard } from './CanvasBoard.tsx'
import { CanvasDialogs } from './CanvasDialogs.tsx'
import type { NoteSubmit, PathSubmit } from './CanvasDialogs.tsx'
import {
  CURRENT_PROJECT_ID,
  CURRENT_PROJECT_LABEL,
  CURRENT_SESSION_LABEL,
  DEFAULT_SIZE,
  DEFAULT_VIEWPORT,
  FLASH_MS,
  HIGHLIGHT_MS,
  LOD_SCALE,
  PERSIST_DEBOUNCE_MS,
} from './constants.ts'
import {
  copyText,
  createNodeId,
  inferTypeFromPath,
  isNodeVisible,
  matchesQuery,
  normalizePath,
  saveTextToFile,
  shortSessionId,
  titleFromPath,
  toReferenceText,
  viewportToNode,
} from './helpers.ts'
import { createDebouncedSaver, loadCanvasState } from './store.ts'
import {
  detectBackend,
  fileProxyUrl,
  loadCanvasFromBackend,
  migrateNodeBackend,
  openNodeFileBackend,
  saveCanvasToBackend,
  type BackendSaveResult,
} from './api-client.ts'
import type {
  CanvasDialogKind,
  CanvasNode,
  CanvasNodeType,
  CanvasPersistState,
  CanvasViewMode,
  CanvasViewport,
} from './types.ts'

export interface CanvasViewProps {
  t: Translate
  /** 跳转到指定会话（2026-08-14：双击「其他会话」徽标调用，主会话
   * 注入 ctx.sessions.open——与 web 通知铃铛同款路径）。 */
  openSession?: (sessionId: string) => void
}

function nextZ(nodes: CanvasNode[]): number {
  let z = 1
  for (const n of nodes) if (n.placement.zIndex > z) z = n.placement.zIndex
  return z + 1
}

function placeNear(nodes: CanvasNode[], type: CanvasNodeType, preferX: number, preferY: number): { x: number; y: number } {
  const size = DEFAULT_SIZE[type]
  // 简单错位：已有卡片越多越往右下偏，避免完全重叠
  const offset = (nodes.length % 6) * 28
  return { x: preferX + offset, y: preferY + offset + size.height * 0 }
}

export function CanvasView(props: ConvViewProps & CanvasViewProps): JSX.Element {
  // 后端探测：宿主 canvasEnabled 开关开启 → 整板走后端（含 rev 乐观锁）；
  // 否则纯前端 localStorage 降级（前端一期验收期行为）。
  const backendReadyRef = useRef(false)
  const backendRevRef = useRef(0)
  const [backendReady, setBackendReady] = useState(false)
  const [syncState, setSyncState] = useState<'idle' | 'saving' | 'conflict' | 'offline'>('idle')
  const initial = useRef(loadCanvasState()).current
  const [nodes, setNodes] = useState<CanvasNode[]>(initial.nodes)
  const [viewport, setViewport] = useState<CanvasViewport>(initial.viewport)
  const [viewMode, setViewMode] = useState<CanvasViewMode>(initial.viewMode)
  const [lastAiNodeId, setLastAiNodeId] = useState<string | null>(initial.lastAiNodeId)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /** 防抖后的搜索词：输入框即时回显，跳转/闪烁等 180ms 再动镜头。 */
  const [appliedQuery, setAppliedQuery] = useState('')
  const [dialog, setDialog] = useState<CanvasDialogKind>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [flashIds, setFlashIds] = useState<Set<string>>(() => new Set())
  const [highlightIds, setHighlightIds] = useState<Set<string>>(() => new Set())
  const [toast, setToast] = useState<string | null>(null)
  const [stageSize, setStageSize] = useState({ w: 800, h: 560 })

  const saver = useRef(createDebouncedSaver(PERSIST_DEBOUNCE_MS)).current
  /** 后端模式下纯视角变化（viewport/viewMode）的短防抖保存器：
   *  滚轮缩放每帧触发 persist，但视角是低频价值数据（刷新恢复用），
   *  500ms 合批即可；nodes 变更不走它（走立即串行，数据必达）。 */
  const viewportSaver = useRef(createDebouncedSaver(500)).current
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  /** 最新快照的同步镜像：连续 setState 后立刻 persist，不能读闭包里的旧 nodes。 */
  const snapRef = useRef<CanvasPersistState>({
    version: 1,
    nodes,
    viewport,
    viewMode,
    lastAiNodeId,
  })
  snapRef.current = { version: 1, nodes, viewport, viewMode, lastAiNodeId }

  /** nodes 最新镜像：异步回调（文本补全 fetch 返回）必须读它而不是
   * effect 闭包里的旧 nodes，否则会覆盖用户拖动中的卡片位置
   * （2026-08-14 与 CanvasBoard pan 还原同模式修复）。 */
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  // 会话 id（后端归属键）：conversation.view 的 strict-session props 自带。
  const sessionId = typeof (props as { sessionId?: string }).sessionId === 'string'
    ? (props as { sessionId: string }).sessionId
    : 'session-local'

  // 当前会话项目归属（后端 GET 下发，按会话工作目录解析）：视角筛选与
  // 新增节点归属必须用真实值——曾用模拟常量 'proj-demo'/'sess-demo-current'
  // 导致「本会话/本项目」视角筛选错乱（2026-08-14 用户反馈：记忆.png 标
  // 当前会话却本会话视角看不到，只有项目/所有项目视角可见）。
  const [currentProjectId, setCurrentProjectId] = useState<string>(CURRENT_PROJECT_ID)
  const [currentProjectLabel, setCurrentProjectLabel] = useState<string>(CURRENT_PROJECT_LABEL)

  /** 初始加载：探测后端 → 后端有板则用后端数据（并接管保存）。 */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const ready = await detectBackend()
      if (cancelled) return
      if (!ready) {
        setSyncState('offline')
        return
      }
      const remote = await loadCanvasFromBackend(sessionId)
      if (cancelled) return
      if (remote !== null) {
        // 乐观锁 rev 必须用后端当前值（曾硬编码 0 导致保存被 409 全拒）
        backendRevRef.current = remote.rev
        snapRef.current = remote
        setNodes(remote.nodes)
        setViewport(remote.viewport)
        setViewMode(remote.viewMode)
        if (remote.lastAiNodeId) setLastAiNodeId(remote.lastAiNodeId)
        // 当前会话项目归属（后端解析的真实值；后端未下发时保留默认）
        if (remote.currentProjectId) setCurrentProjectId(remote.currentProjectId)
        if (remote.currentProjectLabel) setCurrentProjectLabel(remote.currentProjectLabel)
      }
      backendReadyRef.current = true
      setBackendReady(true)
      setSyncState('idle')
    })()
    return () => { cancelled = true }
  }, [sessionId])

  /** 后端整板保存：**立即 + 串行队列**（不用防抖——防抖 + 卸载 cancel 会
   *  丢最后一次变更：加便签后 800ms 内刷新页面保存被取消，便签丢失）。
   *  串行保证同一时刻只有一个 POST 在飞，避免并发携带旧 rev 触发 409；
   *  队列尾总是最新快照，最终一致。 */
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve())
  const persistBackend = useCallback((state: CanvasPersistState) => {
    setSyncState('saving')
    // 排到串行队列尾部：前一个保存完成后才发下一个（携带届时最新的 rev）。
    saveChainRef.current = saveChainRef.current
      .catch(() => { /* 前序失败不阻断后续 */ })
      .then(() => saveCanvasToBackend(state, backendRevRef.current, sessionId))
      .then((result: BackendSaveResult) => {
        if (result.ok && typeof result.rev === 'number') {
          backendRevRef.current = result.rev
          setSyncState('idle')
        } else if (result.conflict) {
          setSyncState('conflict')
          showToast('画板已被其他会话修改，请刷新页面加载最新内容')
        } else {
          // 网络/宿主错误：降级为离线提示，不打断本地操作
          setSyncState('offline')
        }
      })
  }, [sessionId])

  const persist = useCallback((patch: Partial<CanvasPersistState>) => {
    const state: CanvasPersistState = {
      version: 1,
      nodes: patch.nodes ?? snapRef.current.nodes,
      viewport: patch.viewport ?? snapRef.current.viewport,
      viewMode: patch.viewMode ?? snapRef.current.viewMode,
      lastAiNodeId: patch.lastAiNodeId === undefined ? snapRef.current.lastAiNodeId : patch.lastAiNodeId,
    }
    snapRef.current = state
    if (backendReadyRef.current) {
      // 后端模式：**含 nodes 的变更立即进串行队列（数据必达）**；
      // 纯 viewport/viewMode 变化走短防抖（滚轮缩放每帧触发，但视角
      // 是低频价值数据，防抖合批不丢关键信息）。
      if (patch.nodes !== undefined || patch.lastAiNodeId !== undefined) {
        persistBackend(state)
      } else {
        viewportSaver.schedule(() => persistBackend(state))
      }
    } else {
      saver.schedule(state)
    }
  }, [persistBackend, saver])

  useEffect(() => () => {
    // 卸载（切 Tab/刷新）时：localStorage 模式 flush 掉 pending 快照
    // （防抖未触发的最后一次变更不丢）；后端模式 nodes 变更已立即串行
    // 保存，这里只需 cancel 视角防抖（视角丢失无害）。
    if (!backendReadyRef.current) {
      saver.flush(snapRef.current)
    }
    saver.cancel()
    viewportSaver.cancel()
    if (flashTimer.current) clearTimeout(flashTimer.current)
    if (highlightTimer.current) clearTimeout(highlightTimer.current)
    if (toastTimer.current) clearTimeout(toastTimer.current)
  }, [saver, viewportSaver])

  /** 文本补全（拉取式）：路径引用的 markdown/plainText 节点若有 path 但
   *  content 为空（搜索上板/路径上板只存路径、不预读内容），从宿主文件
   *  代理读取文本填入卡片。已补全的节点记入 set，不再重复读；
   *  读取失败（如文件未保存完成 404）退避重试几次后放弃，不打扰操作。 */
  const textFilledRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!backendReady) return
    const candidates = nodes.filter((n) =>
      (n.type === 'markdown' || n.type === 'plainText')
      && typeof n.path === 'string' && n.path !== ''
      && !n.content
      && !textFilledRef.current.has(n.id),
    )
    if (candidates.length === 0) return
    let cancelled = false
    const fill = (node: CanvasNode, attempt: number): void => {
      void (async () => {
        try {
          const res = await fetch(fileProxyUrl(node.id))
          if (!res.ok) {
            // 节点可能尚未保存到后端（保存链是异步的）→ 退避重试
            if (attempt < 3 && !cancelled) {
              setTimeout(() => { if (!cancelled) fill(node, attempt + 1) }, 500 * (attempt + 1))
            }
            return
          }
          const text = await res.text()
          if (cancelled) return
          textFilledRef.current.add(node.id)
          // 截断保护（与后端便签上限同量级），避免大文件撑爆卡片
          const clipped = text.length > 120 * 1024
            ? `${text.slice(0, 120 * 1024)}\n…（内容过长，已截断）`
            : text
          // ⚠️ 必须基于 nodesRef.current（最新镜像）合并，不能用 effect
          // 闭包里的旧 nodes——否则会覆盖用户拖动中的卡片位置
          // （2026-08-14 修复，与 CanvasBoard pan 还原同模式）。
          const next = nodesRef.current.map((n) => n.id === node.id ? { ...n, content: clipped } : n)
          nodesRef.current = next
          setNodes(next)
          persist({ nodes: next })
        } catch {
          // 网络错误：静默放弃（节点保持"仅路径"状态，预览仍可走代理）
        }
      })()
    }
    candidates.forEach((n) => fill(n, 0))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendReady, nodes])

  useEffect(() => {
    const timer = setTimeout(() => setAppliedQuery(query), 180)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const stage = root.querySelector('.cg-stage')
    if (!(stage instanceof HTMLElement)) return
    const ro = new ResizeObserver(() => {
      const r = stage.getBoundingClientRect()
      setStageSize({ w: r.width, h: r.height })
    })
    ro.observe(stage)
    return () => ro.disconnect()
  }, [])

  const showToast = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 1600)
  }, [])

  const pulseHighlight = useCallback((id: string) => {
    setHighlightIds(new Set([id]))
    if (highlightTimer.current) clearTimeout(highlightTimer.current)
    highlightTimer.current = setTimeout(() => setHighlightIds(new Set()), HIGHLIGHT_MS)
  }, [])

  const visibleNodes = useMemo(
    // ⚠️ 必须传真实 sessionId/currentProjectId——isNodeVisible 的默认参数
    // 是模拟常量（'sess-demo-current'/'proj-demo'），不传会导致「本会话」
    // 视角永远匹配不上真实节点（2026-08-14 用户反馈：记忆.png 标当前会话
    // 却本会话视角看不到，只有项目/所有项目视角可见）。
    () => nodes.filter((n) => isNodeVisible(n, viewMode, sessionId, currentProjectId)),
    [nodes, viewMode, sessionId, currentProjectId],
  )

  const matchIds = useMemo(() => {
    const set = new Set<string>()
    const q = appliedQuery.trim()
    if (!q) return set
    for (const n of visibleNodes) if (matchesQuery(n, q)) set.add(n.id)
    return set
  }, [appliedQuery, visibleNodes])

  const searchActive = appliedQuery.trim().length > 0

  const lod = viewport.scale < LOD_SCALE

  const previewNode = focusId ? nodes.find((n) => n.id === focusId) ?? null : null
  const removeNode = previewNode

  const applyViewport = useCallback((next: CanvasViewport, shouldPersist: boolean) => {
    setViewport(next)
    if (shouldPersist) persist({ viewport: next })
  }, [persist])

  const changeViewMode = useCallback((mode: CanvasViewMode) => {
    setViewMode(mode)
    persist({ viewMode: mode })
  }, [persist])

  const upsert = useCallback((next: CanvasNode[], extra?: Partial<CanvasPersistState>) => {
    setNodes(next)
    persist({ ...extra, nodes: next })
  }, [persist])

  const addNode = useCallback((partial: Omit<CanvasNode, 'id' | 'createdAt' | 'placement'> & {
    x?: number
    y?: number
  }): CanvasNode => {
    const { x: placedX, y: placedY, ...fields } = partial
    const id = createNodeId()
    const size = DEFAULT_SIZE[fields.type]
    const pos = placeNear(nodes, fields.type, placedX ?? 360, placedY ?? 160)
    const node: CanvasNode = {
      ...fields,
      id,
      createdAt: Date.now(),
      placement: {
        x: placedX ?? pos.x,
        y: placedY ?? pos.y,
        width: size.width,
        height: size.height,
        zIndex: nextZ(nodes),
      },
    }
    const next = [...nodes, node]
    upsert(next)
    setSelectedId(id)
    pulseHighlight(id)
    return node
  }, [nodes, pulseHighlight, upsert])

  const onPath = useCallback((payload: PathSubmit) => {
    const path = normalizePath(payload.path)
    if (!path) return
    const type = inferTypeFromPath(path)
    addNode({
      type,
      title: titleFromPath(path),
      scope: 'session',
      scopeLabel: CURRENT_SESSION_LABEL,
      // 归属必须用真实查看者会话 id（曾写死模拟常量 CURRENT_SESSION_ID，
      // 导致新节点归属到假会话、其他会话视角过滤看不到——2026-08-14 修复）
      sessionId,
      // projectId 同样必须用后端下发的真实值（曾写死 'proj-demo' 模拟值，
      // 导致「本项目」视角筛选错乱——2026-08-14 修复）
      projectId: currentProjectId,
      path,
      unverified: true,
      meta: { mtime: '未验证' },
    })
    setDialog(null)
    showToast(`已上板：${titleFromPath(path)}`)
  }, [addNode, currentProjectId, sessionId, showToast])

  const onNote = useCallback((payload: NoteSubmit) => {
    addNode({
      type: payload.type,
      title: payload.title,
      scope: 'session',
      scopeLabel: CURRENT_SESSION_LABEL,
      // 归属用真实查看者会话 id（2026-08-14 修复，见 onPath 注释）
      sessionId,
      // projectId 用后端下发的真实值（2026-08-14 修复，见 onPath 注释）
      projectId: currentProjectId,
      content: payload.content,
    })
    setDialog(null)
    showToast('便签已上板')
  }, [addNode, currentProjectId, sessionId, showToast])

  const onCatalog = useCallback((title: string, path: string, type: CanvasNodeType, size?: string) => {
    addNode({
      type,
      title,
      scope: 'session',
      scopeLabel: CURRENT_SESSION_LABEL,
      // 归属用真实查看者会话 id（2026-08-14 修复，见 onPath 注释）
      sessionId,
      // projectId 用后端下发的真实值（2026-08-14 修复，见 onPath 注释）
      projectId: currentProjectId,
      path,
      unverified: true,
      // 搜索结果显示真实文件大小（2026-08-14 删除内置示例 CATALOG_SIZE）
      meta: size ? { size, mtime: '未验证' } : undefined,
    })
    setDialog(null)
    showToast(`已上板：${title}`)
  }, [addNode, currentProjectId, sessionId, showToast])

  // 「跳到最近 AI 便签」：真实 AI 写入（de_canvas add_note，后端已接入）
  // 落会话板中央区并记 lastAiNodeId，此按钮定位到那张便签。
  const jumpToAi = useCallback(() => {
    const id = lastAiNodeId
    const node = id ? nodes.find((n) => n.id === id) : null
    if (!node) {
      showToast('还没有 AI 便签')
      return
    }
    setSelectedId(node.id)
    pulseHighlight(node.id)
    applyViewport(viewportToNode(node, viewport, stageSize.w, stageSize.h), true)
  }, [applyViewport, lastAiNodeId, nodes, pulseHighlight, showToast, stageSize.h, stageSize.w, viewport])

  const onMoveNode = useCallback((id: string, x: number, y: number, shouldPersist: boolean) => {
    setNodes((prev) => {
      const next = prev.map((n) => {
        if (n.id !== id) return n
        return { ...n, placement: { ...n.placement, x, y } }
      })
      if (shouldPersist) persist({ nodes: next })
      return next
    })
  }, [persist])

  /** 卡片右下角缩放：更新宽高（世界坐标），松手时持久化。 */
  const onResizeNode = useCallback((id: string, width: number, height: number, shouldPersist: boolean) => {
    setNodes((prev) => {
      const next = prev.map((n) => {
        if (n.id !== id) return n
        return { ...n, placement: { ...n.placement, width, height } }
      })
      if (shouldPersist) persist({ nodes: next })
      return next
    })
  }, [persist])

  const onSelect = useCallback((id: string | null) => {
    setSelectedId(id)
    if (!id) return
    setNodes((prev) => {
      const z = nextZ(prev)
      return prev.map((n) => n.id === id ? { ...n, placement: { ...n.placement, zIndex: z } } : n)
    })
  }, [])

  const onChangeContent = useCallback((id: string, content: string) => {
    setNodes((prev) => {
      const next = prev.map((n) => n.id === id ? { ...n, content } : n)
      persist({ nodes: next })
      return next
    })
  }, [persist])

  const onCopy = useCallback(async (id: string, kind: 'id' | 'title' | 'path' | 'ref') => {
    const node = nodes.find((n) => n.id === id)
    if (!node) return
    const text =
      kind === 'id' ? node.id
        : kind === 'title' ? node.title
          : kind === 'path' ? (node.path ?? '')
            : toReferenceText(node)
    if (!text) {
      showToast('没有可复制的路径')
      return
    }
    const ok = await copyText(text)
    showToast(ok
      ? (kind === 'id' ? '已复制 ID' : kind === 'title' ? '已复制标题' : kind === 'path' ? '已复制路径' : '已复制引用串')
      : '复制失败')
  }, [nodes, showToast])

  const onAskRemove = useCallback((id: string) => {
    setFocusId(id)
    setDialog('remove')
  }, [])

  /** 系统默认应用打开上板文件（2026-08-14：路径上板/搜索上板一键打开）。 */
  const onOpen = useCallback(async (id: string) => {
    const node = nodes.find((n) => n.id === id)
    if (!node?.path) {
      showToast('该节点没有本地路径可打开')
      return
    }
    const result = await openNodeFileBackend(id)
    showToast(result.ok ? `已用默认应用打开：${node.title}` : `打开失败：${result.error ?? '未知错误'}`)
  }, [nodes, showToast])

  /** 保存文本/便签内容到本机（2026-08-14：弹系统保存对话框，AI 与
   *  用户加的 markdown/纯文本标签都能落地到实机文件）。 */
  const onSave = useCallback(async (id: string) => {
    const node = nodes.find((n) => n.id === id)
    if (!node || typeof node.content !== 'string' || node.content === '') {
      showToast('该节点没有可保存的内容')
      return
    }
    const result = await saveTextToFile(node.title, node.content)
    if (result.ok) {
      showToast(result.message ? `已保存：${node.title}（${result.message}）` : `已保存：${node.title}`)
    } else if (!result.canceled) {
      showToast(`保存失败：${result.message ?? '未知错误'}`)
    }
    // canceled：用户主动取消保存对话框，不提示
  }, [nodes, showToast])

  /** 打开迁移归属对话框（2026-08-14：仅用户手动触发）。 */
  const onMigrateClick = useCallback((id: string) => {
    setFocusId(id)
    setDialog('migrate')
  }, [])

  /** 执行迁移：调后端重写归属键，成功后更新本地节点 + rev。 */
  const onMigrate = useCallback(async (id: string, scope: 'session' | 'project' | 'global') => {
    if (!backendReadyRef.current) {
      showToast('画板未连接后端，无法迁移归属')
      return
    }
    const result = await migrateNodeBackend(id, scope, sessionId, backendRevRef.current)
    if (!result.ok) {
      showToast(result.conflict ? '画板已被其他会话修改，请刷新后重试' : `迁移失败：${result.error ?? '未知错误'}`)
      return
    }
    // 后端返回迁移后的节点：更新本地 nodes（保持位置/内容不变）
    if (result.node && typeof result.rev === 'number') {
      backendRevRef.current = result.rev
      setNodes((prev) => {
        const next = prev.map((n) => n.id === id ? { ...n, ...(result.node as Partial<CanvasNode>) } : n)
        return next
      })
    }
    setDialog(null)
    showToast('归属已迁移')
  }, [backendReadyRef, sessionId, showToast])

  /**
   * 跳转到节点归属会话（2026-08-14 用户反馈：跳转太快来不及反应，要
   * 有提示）。⚠️ 跳转会切换会话，画板组件随旧会话卸载，toast 可能
   * 来不及显示——所以先 toast「正在跳转」，延迟 ~600ms 再执行切换，
   * 用户看到提示后界面才变。openSession 是主会话注入的稳定函数，
   * 闭包持有它，组件卸载后 timer 回调依然能完成跳转。
   */
  const openSessionWithToast = useCallback((targetSessionId: string) => {
    const node = nodes.find((n) => n.sessionId === targetSessionId)
    const name = node?.sessionName ?? shortSessionId(targetSessionId)
    showToast(`正在跳转到会话：${name}`)
    setTimeout(() => {
      props.openSession?.(targetSessionId)
    }, 600)
  }, [nodes, props.openSession, showToast])

  const onConfirmRemove = useCallback(() => {
    if (!focusId) return
    const next = nodes.filter((n) => n.id !== focusId)
    const nextLast = lastAiNodeId === focusId ? null : lastAiNodeId
    upsert(next, { lastAiNodeId: nextLast })
    setLastAiNodeId(nextLast)
    setSelectedId((cur) => cur === focusId ? null : cur)
    setFocusId(null)
    setDialog(null)
    showToast('已从画板移除')
  }, [focusId, lastAiNodeId, nodes, showToast, upsert])

  const onPreview = useCallback((id: string) => {
    setFocusId(id)
    setDialog('preview')
  }, [])

  const viewportRef = useRef(viewport)
  const stageSizeRef = useRef(stageSize)
  const visibleRef = useRef(visibleNodes)
  viewportRef.current = viewport
  stageSizeRef.current = stageSize
  visibleRef.current = visibleNodes

  /** 画板内搜索：命中闪烁 + 镜头跳到第一张。只在 query 变化时跳，避免拖动画布被拽回。 */
  useEffect(() => {
    const q = appliedQuery.trim()
    if (!q) {
      setFlashIds(new Set())
      return
    }
    const hits = visibleRef.current.filter((n) => matchesQuery(n, q))
    setFlashIds(new Set(hits.map((n) => n.id)))
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlashIds(new Set()), FLASH_MS)
    if (hits[0]) {
      const vp = viewportRef.current
      const sz = stageSizeRef.current
      applyViewport(viewportToNode(hits[0], vp, sz.w, sz.h), false)
      setSelectedId(hits[0].id)
    }
  }, [appliedQuery, applyViewport])

  const closeDialog = useCallback(() => {
    setDialog(null)
    setFocusId(null)
  }, [])

  return (
    <div className="cg-root" ref={rootRef}>
      <div className="cg-toolbar">
        <div className="cg-toolbar-group">
          <span className="cg-meta">视角</span>
          <div className="cg-seg" role="tablist" aria-label="视角筛选">
            <button type="button" className={viewMode === 'session' ? 'cg-on' : ''} onClick={() => changeViewMode('session')}>
              本会话
            </button>
            <button type="button" className={viewMode === 'project' ? 'cg-on' : ''} onClick={() => changeViewMode('project')}>
              本项目
            </button>
            <button type="button" className={viewMode === 'global' ? 'cg-on' : ''} onClick={() => changeViewMode('global')}>
              所有项目
            </button>
          </div>
        </div>

        <label className="cg-search">
          <IconSearchOutline16 />
          <input
            value={query}
            placeholder="搜索画板节点…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        <div className="cg-toolbar-group">
          <button type="button" className="cg-btn cg-ghost" onClick={() => setDialog('path')}>
            <IconPlusOutline16 /> 路径上板
          </button>
          <button type="button" className="cg-btn cg-ghost" onClick={() => setDialog('note')}>
            <IconPlusOutline16 /> 便签
          </button>
          <button type="button" className="cg-btn cg-ghost" onClick={() => setDialog('catalog')}>
            <IconPlusOutline16 /> 搜索上板
          </button>
        </div>

        <div className="cg-toolbar-sep" />

        <div className="cg-toolbar-group">
          <button type="button" className="cg-btn cg-ghost" onClick={jumpToAi} disabled={!lastAiNodeId}>
            跳到最近 AI 便签
          </button>
          <button
            type="button"
            className="cg-btn cg-ghost cg-scale"
            title="复位视角"
            onClick={() => applyViewport({ ...DEFAULT_VIEWPORT }, true)}
          >
            {Math.round(viewport.scale * 100)}%
          </button>
        </div>

        <span className="cg-meta">
          {visibleNodes.length}/{nodes.length} 张
          {searchActive ? ` · 命中 ${matchIds.size}` : ''}
          {' · '}{viewMode === 'session' ? '本会话' : viewMode === 'project' ? currentProjectLabel : '所有项目'}
          {backendReady ? (
            syncState === 'conflict' ? ' · ⚠️ 冲突，请刷新'
              : syncState === 'saving' ? ' · 保存中'
                : syncState === 'offline' ? ' · 未连接后端'
                  : ' · 已同步'
          ) : ' · 仅本地保存'}
        </span>
      </div>

      <CanvasBoard
        nodes={visibleNodes}
        viewport={viewport}
        lod={lod}
        selectedId={selectedId}
        flashIds={flashIds}
        highlightIds={highlightIds}
        searchActive={searchActive}
        matchIds={matchIds}
        currentSessionId={sessionId}
        backendReady={backendReady}
        openSession={openSessionWithToast}
        onViewportChange={applyViewport}
        onSelect={onSelect}
        onMoveNode={onMoveNode}
        onResizeNode={onResizeNode}
        onPreview={onPreview}
        onOpen={onOpen}
        onSave={onSave}
        onMigrate={onMigrateClick}
        onCopy={onCopy}
        onAskRemove={onAskRemove}
        onChangeContent={onChangeContent}
      />

      <CanvasDialogs
        kind={dialog}
        previewNode={dialog === 'preview' ? previewNode : null}
        removeNode={dialog === 'remove' ? removeNode : null}
        migrateNode={dialog === 'migrate' ? (focusId ? nodes.find((n) => n.id === focusId) ?? null : null) : null}
        backendReady={backendReady}
        sessionId={sessionId}
        onClose={closeDialog}
        onPath={onPath}
        onNote={onNote}
        onCatalog={onCatalog}
        onConfirmRemove={onConfirmRemove}
        onToast={showToast}
        onOpen={onOpen}
        onMigrate={onMigrate}
      />

      {toast ? <div className="cg-toast" role="status">{toast}</div> : null}
    </div>
  )
}
