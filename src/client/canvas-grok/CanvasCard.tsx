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

export interface CanvasCardProps {
  node: CanvasNode
  /** 当前是否处于低细节档。变化才让 memo 失效。 */
  lod: boolean
  selected: boolean
  flashing: boolean
  dimmed: boolean
  highlighted: boolean
  onSelect: (id: string) => void
  onDragStart: (id: string, event: ReactPointerEvent<HTMLElement>) => void
  onPreview: (id: string) => void
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

function CardBody(props: { node: CanvasNode; onChangeContent: CanvasCardProps['onChangeContent'] }): JSX.Element {
  const { node, onChangeContent } = props
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
    return (
      <>
        <div
          className="cg-ph"
          style={{
            background: `linear-gradient(145deg, hsl(${hue} 42% 46%), hsl(${(hue + 40) % 360} 38% 32%))`,
          }}
        >
          🖼
          <small>模拟预览</small>
        </div>
        {node.path ? <div className="cg-card-path" title={node.path}>{node.path}</div> : null}
      </>
    )
  }

  if (node.type === 'media') {
    return (
      <>
        <div
          className="cg-ph"
          style={{
            background: `linear-gradient(160deg, hsl(${hue} 35% 38%), hsl(${(hue + 60) % 360} 30% 22%))`,
          }}
        >
          ▶
          <small>{node.path?.toLowerCase().match(/\.(mp3|wav|m4a|aac|ogg|flac)$/) ? '音频占位' : '视频占位'}</small>
        </div>
        {node.path ? <div className="cg-card-path" title={node.path}>{node.path}</div> : null}
      </>
    )
  }

  if (node.type === 'folder') {
    return (
      <>
        <div className="cg-ph" style={{ fontSize: 32, minHeight: 56 }}>📁</div>
        {node.path ? <div className="cg-card-path" title={node.path}>{node.path}</div> : null}
        <div className="cg-card-meta">{node.meta?.size ?? '文件夹'} · 一期不内嵌浏览</div>
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
          <span className="cg-badge" title={scopeBadgeText(node)}>{scopeBadgeText(node)}</span>
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
            <CardBody node={node} onChangeContent={props.onChangeContent} />
          </div>
          <footer className="cg-card-foot">
            <button type="button" onClick={() => props.onPreview(node.id)}>预览</button>
            <button type="button" onClick={() => props.onCopy(node.id, 'id')}>复制 ID</button>
            <button type="button" onClick={() => props.onCopy(node.id, 'title')}>复制标题</button>
            <button type="button" onClick={() => props.onCopy(node.id, 'path')} disabled={!node.path}>复制路径</button>
            <button type="button" onClick={() => props.onCopy(node.id, 'ref')}>引用</button>
            <button type="button" className="cg-danger" onClick={() => props.onAskRemove(node.id)}>移除</button>
          </footer>
        </>
      )}
    </article>
  )
}

export const CanvasCard = memo(CanvasCardInner)
CanvasCard.displayName = 'CanvasCard'
