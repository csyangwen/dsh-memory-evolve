/**
 * 无限画板 Tab 根组件。
 *
 * 负责：视角筛选、三种上板、画板内搜索、AI 投放模拟、复制/移除、
 * localStorage 持久化。画布手势本身交给 CanvasBoard。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconPlusOutline16,
  IconSearchOutline16,
  IconSparkle16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { CanvasBoard } from './CanvasBoard.tsx'
import { CanvasDialogs } from './CanvasDialogs.tsx'
import type { NoteSubmit, PathSubmit } from './CanvasDialogs.tsx'
import {
  AI_NOTE_POOL,
  AI_ZONE,
  CURRENT_PROJECT_ID,
  CURRENT_PROJECT_LABEL,
  CURRENT_SESSION_ID,
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
  titleFromPath,
  toReferenceText,
  viewportToNode,
} from './helpers.ts'
import { createDebouncedSaver, loadCanvasState } from './store.ts'
import {
  detectBackend,
  loadCanvasFromBackend,
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

function aiSlot(nodes: CanvasNode[]): { x: number; y: number } {
  const aiCount = nodes.filter((n) => n.aiPlaced).length
  const col = aiCount % 2
  const row = Math.floor(aiCount / 2) % 2
  return {
    x: AI_ZONE.x + 20 + col * 270,
    y: AI_ZONE.y + 36 + row * 120,
  }
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

  // 会话 id（后端归属键）：conversation.view 的 strict-session props 自带。
  const sessionId = typeof (props as { sessionId?: string }).sessionId === 'string'
    ? (props as { sessionId: string }).sessionId
    : 'session-local'

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
    () => nodes.filter((n) => isNodeVisible(n, viewMode)),
    [nodes, viewMode],
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
      sessionId: CURRENT_SESSION_ID,
      projectId: CURRENT_PROJECT_ID,
      path,
      unverified: true,
      meta: { mtime: '未验证' },
    })
    setDialog(null)
    showToast(`已上板：${titleFromPath(path)}`)
  }, [addNode, showToast])

  const onNote = useCallback((payload: NoteSubmit) => {
    addNode({
      type: payload.type,
      title: payload.title,
      scope: 'session',
      scopeLabel: CURRENT_SESSION_LABEL,
      sessionId: CURRENT_SESSION_ID,
      projectId: CURRENT_PROJECT_ID,
      content: payload.content,
    })
    setDialog(null)
    showToast('便签已上板')
  }, [addNode, showToast])

  const onCatalog = useCallback((title: string, path: string, type: CanvasNodeType) => {
    addNode({
      type,
      title,
      scope: 'session',
      scopeLabel: CURRENT_SESSION_LABEL,
      sessionId: CURRENT_SESSION_ID,
      projectId: CURRENT_PROJECT_ID,
      path,
      unverified: true,
      meta: { size: CATALOG_SIZE[path], mtime: '示例' },
    })
    setDialog(null)
    showToast(`已上板：${title}`)
  }, [addNode, showToast])

  const dropAiNote = useCallback(() => {
    const pick = AI_NOTE_POOL[Math.floor(Math.random() * AI_NOTE_POOL.length)]
    const slot = aiSlot(nodes)
    const node = addNode({
      type: 'markdown',
      title: pick.title,
      scope: 'session',
      scopeLabel: CURRENT_SESSION_LABEL,
      sessionId: CURRENT_SESSION_ID,
      projectId: CURRENT_PROJECT_ID,
      content: pick.content,
      aiPlaced: true,
      x: slot.x,
      y: slot.y,
    })
    setLastAiNodeId(node.id)
    persist({ lastAiNodeId: node.id })
    showToast('AI 已投放一张便签')
  }, [addNode, persist, showToast])

  const jumpToAi = useCallback(() => {
    const id = lastAiNodeId
    const node = id ? nodes.find((n) => n.id === id) : null
    if (!node) {
      showToast('还没有 AI 写入')
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
              会话
            </button>
            <button type="button" className={viewMode === 'project' ? 'cg-on' : ''} onClick={() => changeViewMode('project')}>
              项目
            </button>
            <button type="button" className={viewMode === 'global' ? 'cg-on' : ''} onClick={() => changeViewMode('global')}>
              全局
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
            便签
          </button>
          <button type="button" className="cg-btn cg-ghost" onClick={() => setDialog('catalog')}>
            模拟搜索
          </button>
        </div>

        <div className="cg-toolbar-sep" />

        <div className="cg-toolbar-group">
          <button type="button" className="cg-btn cg-primary" onClick={dropAiNote}>
            <IconSparkle16 /> AI 投放
          </button>
          <button type="button" className="cg-btn cg-ghost" onClick={jumpToAi} disabled={!lastAiNodeId}>
            跳到最近 AI 写入
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
          {' · '}{viewMode === 'session' ? CURRENT_SESSION_LABEL : viewMode === 'project' ? CURRENT_PROJECT_LABEL : '全部'}
          {backendReady ? (
            syncState === 'conflict' ? ' · ⚠️ 冲突，请刷新'
              : syncState === 'saving' ? ' · 保存中'
                : syncState === 'offline' ? ' · 离线模式'
                  : ' · 已同步'
          ) : ' · 本地模式'}
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
        onViewportChange={applyViewport}
        onSelect={onSelect}
        onMoveNode={onMoveNode}
        onPreview={onPreview}
        onCopy={onCopy}
        onAskRemove={onAskRemove}
        onChangeContent={onChangeContent}
      />

      <CanvasDialogs
        kind={dialog}
        previewNode={dialog === 'preview' ? previewNode : null}
        removeNode={dialog === 'remove' ? removeNode : null}
        backendReady={backendReady}
        onClose={closeDialog}
        onPath={onPath}
        onNote={onNote}
        onCatalog={onCatalog}
        onConfirmRemove={onConfirmRemove}
        onToast={showToast}
      />

      {toast ? <div className="cg-toast" role="status">{toast}</div> : null}
    </div>
  )
}

/** 目录项尺寸，避免在 add 时再扫一遍 CATALOG。 */
const CATALOG_SIZE: Record<string, string> = {
  '~/Documents/合同-甲乙方.pdf': '2.4 MB',
  '~/Downloads/首页设计稿-v3.png': '1.8 MB',
  '~/Notes/产品需求说明.md': '28 KB',
  '~/Recordings/会议录音-0813.mp3': '18 MB',
  '~/Movies/演示视频-cut.mp4': '42 MB',
  '~/Documents/项目规范文档.docx': '340 KB',
  '~/Design/客户logo.svg': '12 KB',
  '~/Projects/demo/README.txt': '4 KB',
}
