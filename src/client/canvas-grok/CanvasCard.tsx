/**
 * 单张素材卡片。
 *
 * 交互对齐参考项目 ResourceNodeCard：标题栏拖动手柄 + 类型图标 + 预览区 + 操作。
 * LOD（scale < 0.36）只渲染大图标，省掉 textarea / 占位图。
 * 位置用 left/top 写世界坐标，由外层世界层做 transform，卡片本身不跟视口重排。
 */
import { memo, useCallback, type PointerEvent as ReactPointerEvent } from 'react'
import { TYPE_GLYPH, TYPE_LABEL } from './constants.ts'
import { placeholderHue, scopeBadgeText } from './helpers.ts'
import type { CanvasNode } from './types.ts'
import { fileProxyUrl } from './api-client.ts'

export interface CanvasCardProps {
  node: CanvasNode
  /** 当前是否处于低细节档。变化才让 memo 失效。 */
  lod: boolean
  selected: boolean
  flashing: boolean
  dimmed: boolean
  highlighted: boolean
  /** 查看者会话 id：归属徽标按它判断「当前会话 / 其他会话」（2026-08-14）。 */
  currentSessionId?: string
  /** 后端可用：true 时图片/音视频卡片直接走文件代理渲染真实内容
   * （2026-08-14 用户反馈：卡片只有静态填充，至少图片要直接显示）。 */
  backendReady: boolean
  onSelect: (id: string) => void
  onDragStart: (id: string, event: ReactPointerEvent<HTMLElement>) => void
  /** 右下角缩放：id + 起始 pointer 事件（手势在 CanvasBoard 层统一管理）。 */
  onResizeStart: (id: string, event: ReactPointerEvent<HTMLElement>) => void
  onPreview: (id: string) => void
  /** 系统默认应用打开上板文件（2026-08-14：路径上板/搜索上板的一键打开）。 */
  onOpen: (id: string) => void
  onCopy: (id: string, kind: 'id' | 'title' | 'path' | 'ref') => void
  onAskRemove: (id: string) => void
  onChangeContent: (id: string, content: string) => void
}

function extOf(path?: string): string {
  if (!path) return 'FILE'
  const base = path.split(/[/\\]/).pop() ?? path
  const i = base.lastIndexOf('.')
  if (i <= 0) return 'FILE'
  return base.slice(i + 1).toUpperCase().slice(0, 6)
}

function CardBody(props: { node: CanvasNode; backendReady: boolean; onChangeContent: CanvasCardProps['onChangeContent'] }): JSX.Element {
  const { node, backendReady, onChangeContent } = props
  const hue = placeholderHue(node.id)

  if (node.type === 'markdown' || node.type === 'plainText') {
    return (
      <>
        {node.path ? <div className="cg-card-path" title={node.path}>{node.path}</div> : null}
        <textarea
          className="cg-editor"
          value={node.content ?? ''}
          placeholder={node.type === 'markdown' ? '写一段 Markdown…' : '写一段纯文本…'}
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
          onChange={(e) => onChangeContent(node.id, e.target.value)}
        />
      </>
    )
  }

  if (node.type === 'image') {
    // 后端可用 + 有路径 → 卡片直接渲染真实图片（文件代理）；
    // 否则降级静态占位（2026-08-14 用户反馈：至少图片要直接显示）。
    const proxyUrl = backendReady && node.path ? fileProxyUrl(node.id) : ''
    return (
      <>
        {proxyUrl ? (
          <div className="cg-card-media-wrap">
            <img
              className="cg-card-media"
              src={proxyUrl}
              alt={node.title}
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          </div>
        ) : (
          <div
            className="cg-ph"
            style={{
              background: `linear-gradient(145deg, hsl(${hue} 42% 46%), hsl(${(hue + 40) % 360} 38% 32%))`,
            }}
          >
            🖼
            <small>图片预览</small>
          </div>
        )}
        {node.path ? <div className="cg-card-path" title={node.path}>{node.path}</div> : null}
      </>
    )
  }

  if (node.type === 'media') {
    // 后端可用 + 有路径 → 卡片直接渲染可播放的音视频（文件代理）；
    // 否则降级静态占位。
    const proxyUrl = backendReady && node.path ? fileProxyUrl(node.id) : ''
    const isAudio = Boolean(node.path?.toLowerCase().match(/\.(mp3|wav|m4a|aac|ogg|flac)$/))
    return (
      <>
        {proxyUrl ? (
          <div className="cg-card-media-wrap">
            {isAudio ? (
              <audio className="cg-card-media" src={proxyUrl} controls preload="metadata" />
            ) : (
              <video className="cg-card-media" src={proxyUrl} controls preload="metadata" />
            )}
          </div>
        ) : (
          <div
            className="cg-ph"
            style={{
              background: `linear-gradient(160deg, hsl(${hue} 35% 38%), hsl(${(hue + 60) % 360} 30% 22%))`,
            }}
          >
            ▶
            <small>{isAudio ? '音频' : '视频'}</small>
          </div>
        )}
        {node.path ? <div className="cg-card-path" title={node.path}>{node.path}</div> : null}
      </>
    )
  }

  if (node.type === 'folder') {
    return (
      <>
        <div className="cg-ph" style={{ fontSize: 32, minHeight: 56 }}>📁</div>
        {node.path ? <div className="cg-card-path" title={node.path}>{node.path}</div> : null}
        <div className="cg-card-meta">{node.meta?.size ?? '文件夹'} · 暂不支持内嵌浏览</div>
      </>
    )
  }

  return (
    <>
      <span className="cg-file-ext">{extOf(node.path)}</span>
      {node.path ? <div className="cg-card-path" title={node.path}>{node.path}</div> : null}
      <div className="cg-card-meta">
        {[node.meta?.size, node.meta?.mtime].filter(Boolean).join(' · ') || TYPE_LABEL[node.type]}
      </div>
    </>
  )
}

function CanvasCardInner(props: CanvasCardProps): JSX.Element {
  const { node, lod, selected, flashing, dimmed, highlighted } = props
  const { placement } = node

  const onHeadPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    props.onSelect(node.id)
    props.onDragStart(node.id, event)
  }, [node.id, props])

  /** 右下角缩放手柄：阻止冒泡（避免误触标题栏拖动），交给 CanvasBoard 手势。 */
  const onResizePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    props.onSelect(node.id)
    props.onResizeStart(node.id, event)
  }, [node.id, props])

  const className = [
    'cg-card',
    selected ? 'cg-selected' : '',
    flashing ? 'cg-flash' : '',
    dimmed ? 'cg-dimmed' : '',
    highlighted ? 'cg-fresh' : '',
    node.aiPlaced ? 'cg-ai' : '',
  ].filter(Boolean).join(' ')

  return (
    <article
      className={className}
      data-node-id={node.id}
      style={{
        left: placement.x,
        top: placement.y,
        width: placement.width,
        height: placement.height,
        zIndex: placement.zIndex,
      }}
      onPointerDown={(e) => {
        // 点卡片本体提升选中，但不一定开拖（拖只从标题栏开始，避免和文本选择打架）
        if (e.button === 0) props.onSelect(node.id)
      }}
    >
      <header className="cg-card-head" onPointerDown={onHeadPointerDown}>
        <span className="cg-drag" aria-hidden>⋮⋮</span>
        <span className="cg-type-glyph" title={TYPE_LABEL[node.type]}>{TYPE_GLYPH[node.type]}</span>
        <strong className="cg-card-title" title={node.title}>{node.title}</strong>
        <span className="cg-badges">
          {node.aiPlaced ? <span className="cg-badge cg-badge-ai">AI 放置</span> : null}
          {node.unverified ? <span className="cg-badge cg-badge-warn">未验证</span> : null}
          <span className="cg-badge" title={scopeBadgeText(node, props.currentSessionId)}>{scopeBadgeText(node, props.currentSessionId)}</span>
        </span>
      </header>

      {lod ? (
        <div className="cg-lod">
          {TYPE_GLYPH[node.type]}
          <span>{node.title}</span>
        </div>
      ) : (
        <>
          <div className="cg-card-body">
            <CardBody node={node} backendReady={props.backendReady} onChangeContent={props.onChangeContent} />
          </div>
          <footer className="cg-card-foot">
            <button type="button" onClick={() => props.onPreview(node.id)}>预览</button>
            {node.path ? (
              <button type="button" className="cg-open" onClick={() => props.onOpen(node.id)} title="用系统默认应用打开">打开</button>
            ) : null}
            <button type="button" onClick={() => props.onCopy(node.id, 'id')}>复制 ID</button>
            <button type="button" onClick={() => props.onCopy(node.id, 'title')}>复制标题</button>
            <button type="button" onClick={() => props.onCopy(node.id, 'path')} disabled={!node.path}>复制路径</button>
            <button type="button" onClick={() => props.onCopy(node.id, 'ref')}>引用</button>
            <button type="button" className="cg-danger" onClick={() => props.onAskRemove(node.id)}>移除</button>
          </footer>
        </>
      )}

      {/* 右下角缩放手柄：拖动改变卡片宽高（最小尺寸由 CSS/常量约束） */}
      <button
        type="button"
        className="cg-resize-handle"
        aria-label="拖动调整卡片大小"
        title="拖动调整大小"
        onPointerDown={onResizePointerDown}
      />
    </article>
  )
}

export const CanvasCard = memo(CanvasCardInner)
CanvasCard.displayName = 'CanvasCard'
