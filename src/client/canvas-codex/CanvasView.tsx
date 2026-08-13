import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  FormEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { CanvasCard, TYPE_META, type CopyKind } from './CanvasCard.tsx'
import {
  DEFAULT_VIEWPORT,
  MOCK_SEARCH_ASSETS,
  createNode,
  inferNodeType,
  loadCanvasState,
  saveCanvasState,
  titleFromPath,
} from './storage.ts'
import type {
  CanvasNode,
  CanvasOwnerContext,
  CanvasPerspective,
  CanvasScope,
  CanvasState,
  CanvasViewport,
} from './types.ts'

/** 参考项目验证过的 LOD 思路：低于阈值不挂载复杂卡片正文。 */
const LOD_SCALE = 0.4
const MIN_SCALE = 0.18
const MAX_SCALE = 2.5
/** 视口外多保留一圈世界坐标缓冲，快速平移时不会看到节点突然补帧。 */
const VIRTUAL_BUFFER_PX = 420
const AI_ZONE = { x: -300, y: -205, width: 600, height: 410 }

type EntryMode = 'path' | 'note' | 'search' | null

interface CanvasViewProps {
  t: Translate
}

type Gesture = {
  kind: 'pan'
  pointerId: number
  startClientX: number
  startClientY: number
  startViewport: CanvasViewport
} | {
  kind: 'drag'
  pointerId: number
  nodeId: string
  startClientX: number
  startClientY: number
  startX: number
  startY: number
  scale: number
}

/** 把工作目录最后一段变成项目徽标；兼容 POSIX 与 Windows 路径。 */
function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() ?? '当前项目'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.matches('input, textarea, select, button, summary') || target.isContentEditable)
}

/**
 * 无限画板 Tab 主组件。
 *
 * 数据更新走 React，画布移动则只改变顶层 transform；节点自身使用独立
 * translate3d。两层都由合成器处理，不修改 left/top，不在平移缩放阶段触发
 * 卡片内部重排。世界坐标与屏幕坐标的换算集中在本组件，后续接后端只需
 * 替换存储层。
 */
export function CanvasView(props: ConvViewProps & CanvasViewProps): JSX.Element {
  // conversation.view 自带 useSessions；用当前会话行的 cwd 作为一期项目键，
  // 无 cwd 时使用稳定的前端占位键。这里只读宿主已经注入的快照，不发 API。
  const sessionRow = props.useSessions((snapshot) => snapshot.byId[props.sessionId])
  const owner = useMemo<CanvasOwnerContext>(() => {
    const sessionId = String(props.sessionId ?? 'session-local')
    const projectId = sessionRow?.cwd?.trim() || 'project:local'
    return {
      sessionId,
      sessionLabel: sessionRow?.displayTitle || `会话 ${sessionId.slice(0, 8)}`,
      projectId,
      projectLabel: sessionRow?.cwd ? basename(sessionRow.cwd) : '当前项目',
    }
  }, [props.sessionId, sessionRow?.cwd, sessionRow?.displayTitle])

  const initialRef = useRef<CanvasState | null>(null)
  if (initialRef.current === null) initialRef.current = loadCanvasState(owner)
  const initial = initialRef.current

  const [nodes, setNodes] = useState<CanvasNode[]>(initial.nodes)
  const [viewport, setViewport] = useState<CanvasViewport>(initial.viewport)
  const [perspective, setPerspective] = useState<CanvasPerspective>(initial.perspective)
  const [lastAiNodeId, setLastAiNodeId] = useState<string | undefined>(initial.lastAiNodeId)
  const [entryMode, setEntryMode] = useState<EntryMode>(null)
  const [scope, setScope] = useState<CanvasScope>('session')
  const [pathValue, setPathValue] = useState('')
  const [noteTitle, setNoteTitle] = useState('新便签')
  const [noteContent, setNoteContent] = useState('')
  const [noteKind, setNoteKind] = useState<'markdown' | 'plainText'>('markdown')
  const [assetQuery, setAssetQuery] = useState('')
  const [boardQuery, setBoardQuery] = useState('')
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null)
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null)
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null)
  const [spacePressed, setSpacePressed] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 })

  const rootRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef(viewport)
  const nodesRef = useRef(nodes)
  const canvasSizeRef = useRef(canvasSize)
  const stateRef = useRef<CanvasState>({ version: 1, nodes, viewport, perspective, lastAiNodeId })
  const gestureRef = useRef<Gesture | null>(null)
  const spaceRef = useRef(false)
  const toastTimerRef = useRef<number | null>(null)
  const highlightTimerRef = useRef<number | null>(null)
  viewportRef.current = viewport
  nodesRef.current = nodes
  canvasSizeRef.current = canvasSize
  stateRef.current = { version: 1, nodes, viewport, perspective, lastAiNodeId }

  const showToast = useCallback((message: string): void => {
    setToast(message)
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 1800)
  }, [])

  const flashNode = useCallback((nodeId: string): void => {
    setHighlightedNodeId(nodeId)
    if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = window.setTimeout(() => setHighlightedNodeId(null), 1500)
  }, [])

  // ResizeObserver 只更新画布外框尺寸；平移缩放期间不会触发它，因此虚拟化
  // 的边界计算不会产生额外布局读取。
  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const update = (): void => {
      setCanvasSize({ width: root.clientWidth || 1, height: root.clientHeight || 1 })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  // 状态变化后短防抖落 localStorage；卸载时再强制写一次最新 ref，避免刚
  // 拖完就切 Tab 时最后一帧布局丢失。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!saveCanvasState(stateRef.current)) showToast('本地保存失败：浏览器存储不可用')
    }, 180)
    return () => window.clearTimeout(timer)
  }, [nodes, viewport, perspective, lastAiNodeId, showToast])

  useEffect(() => () => {
    saveCanvasState(stateRef.current)
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current)
  }, [])

  // 空格是“临时抓手”。输入框/编辑器内不截获空格，保证文本编辑正常。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || isEditableTarget(event.target)) return
      event.preventDefault()
      spaceRef.current = true
      setSpacePressed(true)
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code !== 'Space') return
      spaceRef.current = false
      setSpacePressed(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  // 指针移动以 requestAnimationFrame 合帧：高频 trackpad / 鼠标事件每帧
  // 最多触发一次 React 更新。拖节点时只替换目标节点对象，其余卡片由 memo
  // 跳过 render。
  useEffect(() => {
    let frame = 0
    let latest: { x: number; y: number } | null = null
    const applyPointer = (clientX: number, clientY: number): void => {
      const gesture = gestureRef.current
      if (gesture === null) return
      if (gesture.kind === 'pan') {
        setViewport({
          ...gesture.startViewport,
          x: gesture.startViewport.x + clientX - gesture.startClientX,
          y: gesture.startViewport.y + clientY - gesture.startClientY,
        })
        return
      }
      const dx = (clientX - gesture.startClientX) / gesture.scale
      const dy = (clientY - gesture.startClientY) / gesture.scale
      setNodes((current) => current.map((node) => node.id === gesture.nodeId
        ? { ...node, placement: { ...node.placement, x: gesture.startX + dx, y: gesture.startY + dy } }
        : node))
    }
    const onPointerMove = (event: PointerEvent): void => {
      const gesture = gestureRef.current
      if (gesture === null || gesture.pointerId !== event.pointerId) return
      latest = { x: event.clientX, y: event.clientY }
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        const point = latest
        latest = null
        if (point !== null) applyPointer(point.x, point.y)
      })
    }
    const onPointerEnd = (event: PointerEvent): void => {
      const gesture = gestureRef.current
      if (gesture === null || gesture.pointerId !== event.pointerId) return
      if (frame !== 0) window.cancelAnimationFrame(frame)
      frame = 0
      latest = null
      applyPointer(event.clientX, event.clientY)
      gestureRef.current = null
      setDraggingNodeId(null)
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerEnd)
    window.addEventListener('pointercancel', onPointerEnd)
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerEnd)
      window.removeEventListener('pointercancel', onPointerEnd)
    }
  }, [])

  const beginPan = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0 && event.button !== 1) return
    event.preventDefault()
    gestureRef.current = {
      kind: 'pan',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startViewport: { ...viewportRef.current },
    }
  }, [])

  const onCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    if (target.closest('[data-cc-ui]') !== null) return
    // 普通点击卡片正文不平移；按住空格时卡片区域也变成抓手。
    if (target.closest('[data-cc-card]') !== null && !spaceRef.current) return
    beginPan(event)
  }, [beginPan])

  const onStartNodeDrag = useCallback((event: ReactPointerEvent<HTMLElement>, nodeId: string): void => {
    event.stopPropagation()
    if (spaceRef.current) {
      beginPan(event)
      return
    }
    if (event.button !== 0) return
    event.preventDefault()
    const node = nodesRef.current.find((item) => item.id === nodeId)
    if (node === undefined) return
    const nextZ = nodesRef.current.reduce((max, item) => Math.max(max, item.placement.zIndex), 0) + 1
    setNodes((current) => current.map((item) => item.id === nodeId
      ? { ...item, placement: { ...item.placement, zIndex: nextZ } }
      : item))
    setDraggingNodeId(nodeId)
    gestureRef.current = {
      kind: 'drag',
      pointerId: event.pointerId,
      nodeId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: node.placement.x,
      startY: node.placement.y,
      scale: viewportRef.current.scale,
    }
  }, [beginPan])

  /** 围绕指定画布局部坐标缩放，光标下的世界点保持不动。 */
  const zoomAt = useCallback((localX: number, localY: number, requestedScale: number): void => {
    const current = viewportRef.current
    const nextScale = clamp(requestedScale, MIN_SCALE, MAX_SCALE)
    const worldX = (localX - current.x) / current.scale
    const worldY = (localY - current.y) / current.scale
    setViewport({
      x: localX - worldX * nextScale,
      y: localY - worldY * nextScale,
      scale: nextScale,
    })
  }, [])

  const onWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    if (target.closest('[data-cc-wheel-lock]') !== null) return
    event.preventDefault()
    const rect = rootRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const factor = Math.exp(-event.deltaY * 0.00135)
    zoomAt(event.clientX - rect.left, event.clientY - rect.top, viewportRef.current.scale * factor)
  }, [zoomAt])

  const focusNode = useCallback((node: CanvasNode): void => {
    const size = canvasSizeRef.current
    const scale = Math.max(viewportRef.current.scale, 0.72)
    setViewport({
      x: size.width / 2 - (node.placement.x + node.placement.width / 2) * scale,
      y: size.height / 2 - (node.placement.y + node.placement.height / 2) * scale,
      scale,
    })
    flashNode(node.id)
  }, [flashNode])

  /** 当前屏幕中心换算成世界坐标，新上板素材围绕这里错列摆放。 */
  const nextPlacementPoint = useCallback((): { x: number; y: number } => {
    const current = viewportRef.current
    const size = canvasSizeRef.current
    const offset = nodesRef.current.length % 7
    return {
      x: (size.width / 2 - current.x) / current.scale - 150 + offset * 22,
      y: (size.height / 2 - current.y) / current.scale - 105 + offset * 18,
    }
  }, [])

  const addNodeToBoard = useCallback((node: CanvasNode, message: string): void => {
    const maxZ = nodesRef.current.reduce((max, item) => Math.max(max, item.placement.zIndex), 0)
    const next = { ...node, placement: { ...node.placement, zIndex: maxZ + 1 } }
    setNodes((current) => [...current, next])
    setEntryMode(null)
    showToast(message)
    // 新卡片已经按当前屏幕中心生成，不额外跳动视口，只做视觉高亮。
    flashNode(next.id)
  }, [flashNode, showToast])

  const addPath = (event: FormEvent): void => {
    event.preventDefault()
    const path = pathValue.trim()
    if (path === '') {
      showToast('请输入要上板的本地路径')
      return
    }
    const point = nextPlacementPoint()
    addNodeToBoard(createNode({
      type: inferNodeType(path),
      title: titleFromPath(path),
      scope,
      owner,
      x: point.x,
      y: point.y,
      path,
      unverified: true,
    }), '路径已上板（未验证）')
    setPathValue('')
  }

  const addNote = (event: FormEvent): void => {
    event.preventDefault()
    const point = nextPlacementPoint()
    addNodeToBoard(createNode({
      type: noteKind,
      title: noteTitle,
      scope,
      owner,
      x: point.x,
      y: point.y,
      content: noteContent,
    }), '便签已上板')
    setNoteTitle('新便签')
    setNoteContent('')
  }

  const addMockAsset = (asset: (typeof MOCK_SEARCH_ASSETS)[number]): void => {
    const point = nextPlacementPoint()
    addNodeToBoard(createNode({
      type: asset.type,
      title: asset.title,
      scope,
      owner,
      x: point.x,
      y: point.y,
      path: asset.path,
      size: asset.size,
    }), '模拟搜索素材已上板')
  }

  const simulateAiDrop = useCallback((): void => {
    const samples = [
      ['AI 整理：下一步', '1. 核对需求边界\n2. 汇总相关素材\n3. 把结果交回当前会话'],
      ['AI 产物摘要', '这是一张纯前端模拟的 AI 便签。后续 de_canvas 接入后，真实产物会落到同一区域。'],
      ['AI 待确认要点', '- 文件引用保持只读\n- 画布布局由用户决定\n- AI 不移动已有卡片'],
    ] as const
    const aiCount = nodesRef.current.filter((node) => node.aiPlaced).length
    const sample = samples[aiCount % samples.length]
    const node = createNode({
      type: 'markdown',
      title: `${sample[0]} #${aiCount + 1}`,
      scope: 'session',
      owner,
      // 固定区内轻微错列；不设数量上限，用户可把看过的便签拖走。
      x: AI_ZONE.x + 125 + (aiCount % 6) * 24,
      y: AI_ZONE.y + 80 + (aiCount % 5) * 22,
      content: sample[1],
      aiPlaced: true,
    })
    const maxZ = nodesRef.current.reduce((max, item) => Math.max(max, item.placement.zIndex), 0)
    node.placement.zIndex = maxZ + 1
    setNodes((current) => [...current, node])
    setLastAiNodeId(node.id)
    setEntryMode(null)
    flashNode(node.id)
    focusNode(node)
    showToast('AI 模拟便签已放到中央固定区')
  }, [flashNode, focusNode, owner, showToast])

  const jumpToLastAi = useCallback((): void => {
    const node = nodesRef.current.find((item) => item.id === lastAiNodeId)
      ?? [...nodesRef.current].reverse().find((item) => item.aiPlaced)
    if (node === undefined) {
      showToast('还没有 AI 写入便签')
      return
    }
    focusNode(node)
  }, [focusNode, lastAiNodeId, showToast])

  const openNode = useCallback((nodeId: string): void => {
    setPreviewNodeId(nodeId)
  }, [])

  const copyNode = useCallback(async (nodeId: string, kind: CopyKind): Promise<void> => {
    const node = nodesRef.current.find((item) => item.id === nodeId)
    if (node === undefined) return
    const value = kind === 'id'
      ? node.id
      : kind === 'title'
        ? node.title
        : kind === 'path'
          ? node.path ?? ''
          : `[canvas:${node.id}] ${node.title}`
    if (value === '') {
      showToast('这个节点没有本地路径')
      return
    }
    try {
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(value)
      } else {
        const input = document.createElement('textarea')
        input.value = value
        input.style.position = 'fixed'
        input.style.opacity = '0'
        document.body.appendChild(input)
        input.select()
        document.execCommand('copy')
        input.remove()
      }
      showToast('已复制')
    } catch {
      showToast('复制失败，请检查浏览器权限')
    }
  }, [showToast])

  const removeNode = useCallback((nodeId: string): void => {
    const node = nodesRef.current.find((item) => item.id === nodeId)
    if (node === undefined || !window.confirm(`确认从画板移除“${node.title}”？\n不会删除源文件。`)) return
    setNodes((current) => current.filter((item) => item.id !== nodeId))
    setPreviewNodeId((current) => current === nodeId ? null : current)
    setLastAiNodeId((current) => current === nodeId ? undefined : current)
    showToast('已从画板移除，源文件未删除')
  }, [showToast])

  const updateContent = useCallback((nodeId: string, content: string): void => {
    setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, content } : node))
  }, [])

  const matchesPerspective = useCallback((node: CanvasNode): boolean => {
    if (perspective === 'global') return true
    if (node.scope === 'global') return true
    if (perspective === 'project') return node.ownership.projectId === owner.projectId
    if (node.scope === 'project') return node.ownership.projectId === owner.projectId
    return node.ownership.sessionId === owner.sessionId
  }, [owner.projectId, owner.sessionId, perspective])

  const perspectiveNodes = useMemo(() => nodes.filter(matchesPerspective), [nodes, matchesPerspective])
  const normalizedBoardQuery = boardQuery.trim().toLocaleLowerCase()
  const matchedNodes = useMemo(() => perspectiveNodes.filter((node) => {
    if (normalizedBoardQuery === '') return true
    const haystack = `${node.title} ${TYPE_META[node.type].label} ${node.type}`.toLocaleLowerCase()
    return haystack.includes(normalizedBoardQuery)
  }), [normalizedBoardQuery, perspectiveNodes])

  // 屏幕矩形反算到世界坐标，节点矩形做 AABB 相交测试。DOM 数量由当前
  // 视口决定，而不是由画板总节点数决定。
  const visibleNodes = useMemo(() => {
    const buffer = VIRTUAL_BUFFER_PX / viewport.scale
    const left = -viewport.x / viewport.scale - buffer
    const top = -viewport.y / viewport.scale - buffer
    const right = (canvasSize.width - viewport.x) / viewport.scale + buffer
    const bottom = (canvasSize.height - viewport.y) / viewport.scale + buffer
    return matchedNodes.filter((node) => {
      const p = node.placement
      return p.x + p.width >= left && p.x <= right && p.y + p.height >= top && p.y <= bottom
    })
  }, [canvasSize.height, canvasSize.width, matchedNodes, viewport])

  const locateBoardMatch = (): void => {
    if (normalizedBoardQuery === '') {
      showToast('输入标题或类型后再定位')
      return
    }
    const node = matchedNodes[0]
    if (node === undefined) {
      showToast('当前视角没有匹配节点')
      return
    }
    focusNode(node)
  }

  const resetViewport = (): void => {
    setViewport({
      ...DEFAULT_VIEWPORT,
      x: canvasSizeRef.current.width / 2,
      y: canvasSizeRef.current.height / 2,
    })
  }

  const previewNode = nodes.find((node) => node.id === previewNodeId)
  const filteredAssets = MOCK_SEARCH_ASSETS.filter((asset) => {
    const query = assetQuery.trim().toLocaleLowerCase()
    return query === '' || `${asset.title} ${TYPE_META[asset.type].label}`.toLocaleLowerCase().includes(query)
  })
  const stageStyle = {
    transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.scale})`,
  }
  const gridStyle = {
    backgroundPosition: `${viewport.x}px ${viewport.y}px`,
    backgroundSize: `${32 * viewport.scale}px ${32 * viewport.scale}px`,
  }

  return (
    <div
      ref={rootRef}
      className={`cc-root${gestureRef.current?.kind === 'pan' ? ' cc-is-panning' : ''}${spacePressed ? ' cc-space-ready' : ''}`}
      style={gridStyle}
      tabIndex={0}
      onPointerDown={onCanvasPointerDown}
      onWheel={onWheel}
    >
      <div className="cc-topbar" data-cc-ui>
        <div className="cc-brand">
          <span className="cc-brand-icon">⌘</span>
          <div><strong>无限画板</strong><small>{visibleNodes.length}/{matchedNodes.length} 可见 · 共 {nodes.length} 张</small></div>
        </div>

        <div className="cc-perspectives" role="group" aria-label="画板视角">
          {(['session', 'project', 'global'] as const).map((item) => (
            <button
              type="button"
              key={item}
              className={perspective === item ? 'cc-active' : ''}
              onClick={() => setPerspective(item)}
              title={item === 'session' ? '当前会话 + 当前项目 + 全局' : item === 'project' ? '当前项目所有会话 + 全局' : '全部节点'}
            >
              {item === 'session' ? '💬 会话' : item === 'project' ? '📁 项目' : '🌐 全局'}
            </button>
          ))}
        </div>

        <form className="cc-board-search" onSubmit={(event) => { event.preventDefault(); locateBoardMatch() }}>
          <input
            value={boardQuery}
            onChange={(event) => setBoardQuery(event.currentTarget.value)}
            placeholder="搜索画板标题 / 类型"
            aria-label="画板内搜索"
          />
          {boardQuery !== '' && <button type="button" title="清空搜索" onClick={() => setBoardQuery('')}>×</button>}
          <button type="submit">定位</button>
        </form>

        <div className="cc-ai-actions">
          <button type="button" className="cc-ai-primary" onClick={simulateAiDrop}>✦ AI 投放模拟</button>
          <button type="button" onClick={jumpToLastAi}>跳到最近 AI 写入</button>
        </div>
      </div>

      <div className="cc-entrybar" data-cc-ui>
        <button type="button" className={entryMode === 'path' ? 'cc-active' : ''} onClick={() => setEntryMode(entryMode === 'path' ? null : 'path')}>＋ 路径上板</button>
        <button type="button" className={entryMode === 'note' ? 'cc-active' : ''} onClick={() => setEntryMode(entryMode === 'note' ? null : 'note')}>＋ 新建便签</button>
        <button type="button" className={entryMode === 'search' ? 'cc-active' : ''} onClick={() => setEntryMode(entryMode === 'search' ? null : 'search')}>⌕ 模拟搜索上板</button>
      </div>

      {entryMode !== null && (
        <aside className="cc-entry-panel" data-cc-ui onPointerDown={(event) => event.stopPropagation()}>
          <div className="cc-panel-head">
            <strong>{entryMode === 'path' ? '路径上板' : entryMode === 'note' ? '新建便签' : '模拟本地搜索'}</strong>
            <button type="button" onClick={() => setEntryMode(null)} aria-label="关闭">×</button>
          </div>
          <label className="cc-field">
            <span>归属</span>
            <select value={scope} onChange={(event) => setScope(event.currentTarget.value as CanvasScope)}>
              <option value="session">💬 {owner.sessionLabel}</option>
              <option value="project">📁 {owner.projectLabel}</option>
              <option value="global">🌐 全局</option>
            </select>
          </label>

          {entryMode === 'path' && (
            <form onSubmit={addPath} className="cc-panel-form">
              <label className="cc-field"><span>本地路径</span><input autoFocus value={pathValue} onChange={(event) => setPathValue(event.currentTarget.value)} placeholder="/Users/me/Documents/example.pdf" /></label>
              <p>按后缀自动分类；一期不读取、不校验路径，卡片会标记“未验证”。</p>
              <button type="submit" className="cc-submit">上板</button>
            </form>
          )}

          {entryMode === 'note' && (
            <form onSubmit={addNote} className="cc-panel-form">
              <label className="cc-field"><span>类型</span><select value={noteKind} onChange={(event) => setNoteKind(event.currentTarget.value as 'markdown' | 'plainText')}><option value="markdown">Markdown</option><option value="plainText">纯文本</option></select></label>
              <label className="cc-field"><span>标题</span><input value={noteTitle} onChange={(event) => setNoteTitle(event.currentTarget.value)} /></label>
              <label className="cc-field"><span>内容</span><textarea value={noteContent} onChange={(event) => setNoteContent(event.currentTarget.value)} placeholder="写下临时内容…" /></label>
              <button type="submit" className="cc-submit">创建便签</button>
            </form>
          )}

          {entryMode === 'search' && (
            <div className="cc-panel-form">
              <label className="cc-field"><span>示例文件清单</span><input autoFocus value={assetQuery} onChange={(event) => setAssetQuery(event.currentTarget.value)} placeholder="搜索合同、设计稿、录音…" /></label>
              <div className="cc-asset-results">
                {filteredAssets.map((asset) => (
                  <div className="cc-asset-row" key={asset.path}>
                    <span className="cc-result-icon">{TYPE_META[asset.type].icon}</span>
                    <span><strong>{asset.title}</strong><small>{TYPE_META[asset.type].label} · {asset.size}</small></span>
                    <button type="button" onClick={() => addMockAsset(asset)}>上板</button>
                  </div>
                ))}
                {filteredAssets.length === 0 && <p className="cc-empty">没有匹配的模拟文件</p>}
              </div>
            </div>
          )}
        </aside>
      )}

      <div className="cc-stage" style={stageStyle} aria-label="无限画布世界坐标层">
        <div className="cc-ai-zone" style={{ transform: `translate3d(${AI_ZONE.x}px, ${AI_ZONE.y}px, 0)`, width: AI_ZONE.width, height: AI_ZONE.height }}>
          <span>✦ AI 便签投放固定区</span>
          <small>AI 只投放内容，不调整用户布局</small>
        </div>
        {visibleNodes.map((node) => (
          <CanvasCard
            key={node.id}
            node={node}
            lod={viewport.scale < LOD_SCALE}
            dragging={draggingNodeId === node.id}
            highlighted={highlightedNodeId === node.id}
            onStartDrag={onStartNodeDrag}
            onOpen={openNode}
            onCopy={copyNode}
            onRemove={removeNode}
            onContentChange={updateContent}
          />
        ))}
      </div>

      <div className="cc-zoom-controls" data-cc-ui>
        <button type="button" onClick={() => zoomAt(canvasSize.width / 2, canvasSize.height / 2, viewport.scale / 1.2)} aria-label="缩小">−</button>
        <span>{Math.round(viewport.scale * 100)}%</span>
        <button type="button" onClick={() => zoomAt(canvasSize.width / 2, canvasSize.height / 2, viewport.scale * 1.2)} aria-label="放大">＋</button>
        <button type="button" onClick={resetViewport}>回到中央</button>
      </div>

      <div className="cc-help-chip" data-cc-ui>拖空白平移 · 空格 + 拖 · 滚轮中心缩放 · 双击卡片打开</div>
      {toast !== null && <div className="cc-toast" role="status" data-cc-ui>{toast}</div>}

      {previewNode !== undefined && (
        <div className="cc-modal-backdrop" data-cc-ui onPointerDown={(event) => { if (event.target === event.currentTarget) setPreviewNodeId(null) }}>
          <section className="cc-preview-modal" role="dialog" aria-modal="true" aria-label={`预览 ${previewNode.title}`}>
            <header><span>{TYPE_META[previewNode.type].icon}</span><div><strong>{previewNode.title}</strong><small>{previewNode.id}</small></div><button type="button" onClick={() => setPreviewNodeId(null)} aria-label="关闭预览">×</button></header>
            <div className="cc-preview-body">
              {(previewNode.type === 'markdown' || previewNode.type === 'plainText') && <pre>{previewNode.content || '（空便签）'}</pre>}
              {previewNode.type === 'image' && previewNode.previewUrl !== undefined && <img src={previewNode.previewUrl} alt={previewNode.title} />}
              {previewNode.type === 'media' && <div className="cc-large-placeholder"><span>{/\.(?:mp3|wav|m4a|aac|ogg)$/i.test(previewNode.path ?? '') ? '♫' : '▶'}</span><strong>音视频预览占位</strong><small>真实媒体读取将在宿主 API 接入后启用</small></div>}
              {(previewNode.type === 'folder' || previewNode.type === 'file') && <div className="cc-large-placeholder"><span>{TYPE_META[previewNode.type].icon}</span><strong>使用系统默认应用打开</strong><small>{previewNode.path ?? '这个节点没有路径'}</small><button type="button" onClick={() => showToast('后端接入后可用')}>用默认应用打开</button></div>}
            </div>
            <footer>
              <span title={previewNode.path ?? ''}>{previewNode.path ?? `${previewNode.scopeLabel} · 画板内内容`}</span>
              <button type="button" onClick={() => { void copyNode(previewNode.id, 'reference') }}>复制引用串</button>
              <button type="button" onClick={() => setPreviewNodeId(null)}>关闭</button>
            </footer>
          </section>
        </div>
      )}
    </div>
  )
}
