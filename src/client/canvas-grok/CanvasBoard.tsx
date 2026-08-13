/**
 * 无限画布引擎。
 *
 * 平移 / 缩放全部写在世界层的 `transform: translate3d + scale` 上，
 * 配合 will-change，浏览器走合成层，不改卡片 left/top（避免 100 卡重排）。
 *
 * 手势进行中用 DOM 直接改 transform，不每帧 setState；
 * 视口虚拟化（只挂相交卡片）和 LOD 档位在 rAF 里同步。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { CanvasCard } from './CanvasCard.tsx'
import { AI_ZONE, MAX_SCALE, MIN_SCALE, VIRT_PAD, ZOOM_STEP } from './constants.ts'
import {
  clamp,
  intersectsViewport,
  isTypingTarget,
  zoomAt,
} from './helpers.ts'
import type { CanvasNode, CanvasViewport } from './types.ts'

export interface CanvasBoardProps {
  nodes: CanvasNode[]
  viewport: CanvasViewport
  lod: boolean
  selectedId: string | null
  flashIds: ReadonlySet<string>
  highlightIds: ReadonlySet<string>
  /** 有搜索词时，未命中的卡片降透明度。 */
  searchActive: boolean
  matchIds: ReadonlySet<string>
  onViewportChange: (next: CanvasViewport, persist: boolean) => void
  onSelect: (id: string | null) => void
  onMoveNode: (id: string, x: number, y: number, persist: boolean) => void
  onPreview: (id: string) => void
  onCopy: (id: string, kind: 'id' | 'title' | 'path' | 'ref') => void
  onAskRemove: (id: string) => void
  onChangeContent: (id: string, content: string) => void
}

type Gesture =
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'drag'; id: string; originX: number; originY: number; startX: number; startY: number }

function applyWorldTransform(el: HTMLElement | null, vp: CanvasViewport): void {
  if (!el) return
  el.style.transform = `translate3d(${vp.x}px, ${vp.y}px, 0) scale(${vp.scale})`
}

function applyGrid(el: HTMLElement | null, vp: CanvasViewport): void {
  if (!el) return
  const size = Math.max(10, 22 * vp.scale)
  el.style.backgroundSize = `${size}px ${size}px`
  el.style.backgroundPosition = `${vp.x}px ${vp.y}px`
}

export function CanvasBoard(props: CanvasBoardProps): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const vpRef = useRef(props.viewport)
  const nodesRef = useRef(props.nodes)
  const gestureRef = useRef<Gesture | null>(null)
  const spaceRef = useRef(false)
  const panRafRef = useRef(0)
  const [space, setSpace] = useState(false)
  const [panning, setPanning] = useState(false)
  const [size, setSize] = useState({ w: 800, h: 560 })
  const [visibleIds, setVisibleIds] = useState<string[]>(() => props.nodes.map((n) => n.id))

  vpRef.current = props.viewport
  nodesRef.current = props.nodes

  /** 量视口尺寸，虚拟化依赖它。 */
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const sync = (): void => {
      const rect = el.getBoundingClientRect()
      setSize({ w: Math.max(1, rect.width), h: Math.max(1, rect.height) })
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const refreshVisible = useCallback((vp: CanvasViewport, list: CanvasNode[]) => {
    const next: string[] = []
    for (const node of list) {
      if (intersectsViewport(node, vp, size.w, size.h, VIRT_PAD)) next.push(node.id)
    }
    setVisibleIds((prev) => {
      if (prev.length === next.length && prev.every((id, i) => id === next[i])) return prev
      return next
    })
  }, [size.h, size.w])

  useEffect(() => {
    applyWorldTransform(worldRef.current, props.viewport)
    applyGrid(stageRef.current, props.viewport)
    refreshVisible(props.viewport, props.nodes)
  }, [props.nodes, props.viewport, refreshVisible])

  useEffect(() => () => {
    if (panRafRef.current) cancelAnimationFrame(panRafRef.current)
  }, [])

  /** 空格 + 拖 = 平移（输入框里不抢空格）。 */
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.repeat) return
      if (isTypingTarget(e.target)) return
      e.preventDefault()
      spaceRef.current = true
      setSpace(true)
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return
      spaceRef.current = false
      setSpace(false)
    }
    window.addEventListener('keydown', down, { passive: false })
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  const commitViewport = useCallback((next: CanvasViewport, persist: boolean) => {
    vpRef.current = next
    applyWorldTransform(worldRef.current, next)
    applyGrid(stageRef.current, next)
    refreshVisible(next, nodesRef.current)
    props.onViewportChange(next, persist)
  }, [props, refreshVisible])

  /**
   * 滚轮缩放必须挂非 passive 监听才能 preventDefault，
   * 否则页面跟着滚，画布却不缩。React 的 onWheel 在根上是 passive。
   */
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const cx = event.clientX - rect.left
      const cy = event.clientY - rect.top
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      const nextScale = clamp(vpRef.current.scale * factor, MIN_SCALE, MAX_SCALE)
      if (nextScale === vpRef.current.scale) return
      commitViewport(zoomAt(vpRef.current, cx, cy, nextScale), true)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [commitViewport])

  const onStagePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const onCard = Boolean((event.target as HTMLElement | null)?.closest?.('[data-node-id]'))
    // 空白拖，或按住空格在卡片上拖 → 平移
    if (!onCard || spaceRef.current) {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      gestureRef.current = { kind: 'pan', lastX: event.clientX, lastY: event.clientY }
      setPanning(true)
      if (!onCard) props.onSelect(null)
    }
  }, [props])

  const onStagePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current
    if (!g) return
    if (g.kind === 'pan') {
      const dx = event.clientX - g.lastX
      const dy = event.clientY - g.lastY
      g.lastX = event.clientX
      g.lastY = event.clientY
      const next = { ...vpRef.current, x: vpRef.current.x + dx, y: vpRef.current.y + dy }
      vpRef.current = next
      applyWorldTransform(worldRef.current, next)
      applyGrid(stageRef.current, next)
      // 平移中不 setState 视口，只在 rAF 里重算虚拟化，避免 100 卡跟着每帧重渲染
      if (!panRafRef.current) {
        panRafRef.current = requestAnimationFrame(() => {
          panRafRef.current = 0
          refreshVisible(vpRef.current, nodesRef.current)
        })
      }
      return
    }
    const scale = vpRef.current.scale || 1
    const x = g.originX + (event.clientX - g.startX) / scale
    const y = g.originY + (event.clientY - g.startY) / scale
    props.onMoveNode(g.id, x, y, false)
  }, [props, refreshVisible])

  const endGesture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current
    if (!g) return
    gestureRef.current = null
    setPanning(false)
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* 已释放 */ }
    if (g.kind === 'pan') {
      refreshVisible(vpRef.current, nodesRef.current)
      props.onViewportChange(vpRef.current, true)
      return
    }
    const scale = vpRef.current.scale || 1
    const x = g.originX + (event.clientX - g.startX) / scale
    const y = g.originY + (event.clientY - g.startY) / scale
    props.onMoveNode(g.id, x, y, true)
  }, [props, refreshVisible])

  const onDragStart = useCallback((id: string, event: ReactPointerEvent<HTMLElement>) => {
    if (spaceRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const node = nodesRef.current.find((n) => n.id === id)
    if (!node) return
    const stage = stageRef.current
    if (stage) {
      try { stage.setPointerCapture(event.pointerId) } catch { /* ignore */ }
    }
    gestureRef.current = {
      kind: 'drag',
      id,
      originX: node.placement.x,
      originY: node.placement.y,
      startX: event.clientX,
      startY: event.clientY,
    }
  }, [])

  const visibleSet = useMemo(() => new Set(visibleIds), [visibleIds])
  const visibleNodes = useMemo(
    () => props.nodes.filter((n) => visibleSet.has(n.id)),
    [props.nodes, visibleSet],
  )

  return (
    <div
      ref={stageRef}
      className={`cg-stage${panning ? ' cg-panning' : ''}${space ? ' cg-space' : ''}`}
      onPointerDown={onStagePointerDown}
      onPointerMove={onStagePointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
    >
      <div ref={worldRef} className="cg-world">
        <div
          className="cg-ai-zone"
          style={{
            left: AI_ZONE.x,
            top: AI_ZONE.y,
            width: AI_ZONE.width,
            height: AI_ZONE.height,
          }}
        >
          <span className="cg-ai-zone-label">AI 投放区 · 新便签落在这里，可拖走</span>
        </div>
        {visibleNodes.map((node) => (
          <CanvasCard
            key={node.id}
            node={node}
            lod={props.lod}
            selected={props.selectedId === node.id}
            flashing={props.flashIds.has(node.id)}
            dimmed={props.searchActive && !props.matchIds.has(node.id)}
            highlighted={props.highlightIds.has(node.id)}
            onSelect={props.onSelect}
            onDragStart={onDragStart}
            onPreview={props.onPreview}
            onCopy={props.onCopy}
            onAskRemove={props.onAskRemove}
            onChangeContent={props.onChangeContent}
          />
        ))}
      </div>
      <div className="cg-hint-bar">
        拖空白处平移 · 空格+拖 也可平移 · 滚轮缩放（中心为指针）· 缩放 {Math.round(props.viewport.scale * 100)}%
        {props.lod ? ' · LOD 图标档' : ''}
        {visibleNodes.length < props.nodes.length
          ? ` · 视口 ${visibleNodes.length}/${props.nodes.length}`
          : ''}
      </div>
    </div>
  )
}
