import { memo } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { CanvasNode } from './types.ts'

/** 卡片类型的稳定视觉语义；搜索也复用 label，不出现内部英文枚举。 */
export const TYPE_META: Record<CanvasNode['type'], { icon: string; label: string }> = {
  folder: { icon: '📁', label: '文件夹' },
  markdown: { icon: 'M↓', label: 'Markdown' },
  plainText: { icon: '¶', label: '纯文本' },
  image: { icon: '▧', label: '图片' },
  media: { icon: '▶', label: '音视频' },
  file: { icon: '▤', label: '文件' },
}

export type CopyKind = 'id' | 'title' | 'path' | 'reference'

interface CanvasCardProps {
  node: CanvasNode
  lod: boolean
  dragging: boolean
  highlighted: boolean
  onStartDrag: (event: ReactPointerEvent<HTMLElement>, nodeId: string) => void
  onOpen: (nodeId: string) => void
  onCopy: (nodeId: string, kind: CopyKind) => void
  onRemove: (nodeId: string) => void
  onContentChange: (nodeId: string, content: string) => void
}

function scopeText(node: CanvasNode): string {
  if (node.scope === 'global') return '🌐 全局'
  if (node.scope === 'project') return `📁 ${node.scopeLabel}`
  return `💬 ${node.scopeLabel}`
}

function mediaIcon(node: CanvasNode): string {
  return /\.(?:mp3|wav|m4a|aac|ogg)$/i.test(node.path ?? '') ? '♫' : '▶'
}

/**
 * 单张画板卡片。
 *
 * memo 的价值在拖拽阶段最明显：父层每帧只替换被拖节点的对象，其余可见
 * 卡片保持引用不变，不需要重新执行图片/文本预览的 React render。低缩放
 * 直接走极简 DOM 分支，只保留图标、标题和归属，避免隐藏复杂 DOM 仍占用
 * 布局/绘制成本。
 */
export const CanvasCard = memo(function CanvasCard(props: CanvasCardProps): JSX.Element {
  const { node, lod, dragging, highlighted } = props
  const meta = TYPE_META[node.type]
  const style = {
    width: node.placement.width,
    height: node.placement.height,
    zIndex: dragging ? 1_000_000 : node.placement.zIndex,
    transform: `translate3d(${node.placement.x}px, ${node.placement.y}px, 0)`,
  } satisfies CSSProperties

  if (lod) {
    return (
      <article
        className={`cc-card cc-card-lod${dragging ? ' cc-card-dragging' : ''}${highlighted ? ' cc-card-highlight' : ''}`}
        style={style}
        data-cc-card
        data-node-id={node.id}
        onPointerDown={(event) => props.onStartDrag(event, node.id)}
        onDoubleClick={() => props.onOpen(node.id)}
        title={`${node.title} · ${scopeText(node)}`}
      >
        <span className="cc-lod-icon" aria-hidden>{node.type === 'media' ? mediaIcon(node) : meta.icon}</span>
        <strong>{node.title}</strong>
        <small>{scopeText(node)}</small>
      </article>
    )
  }

  return (
    <article
      className={`cc-card cc-card-${node.type}${dragging ? ' cc-card-dragging' : ''}${highlighted ? ' cc-card-highlight' : ''}${node.aiPlaced ? ' cc-card-ai' : ''}`}
      style={style}
      data-cc-card
      data-node-id={node.id}
      onDoubleClick={() => props.onOpen(node.id)}
    >
      <header
        className="cc-card-head"
        title="拖动卡片；按住空格拖动则平移画布"
        onPointerDown={(event) => props.onStartDrag(event, node.id)}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <span className="cc-drag-grip" aria-hidden>⠿</span>
        <span className="cc-type-icon" aria-hidden>{node.type === 'media' ? mediaIcon(node) : meta.icon}</span>
        <strong title={node.title}>{node.title}</strong>
        {node.aiPlaced && <span className="cc-ai-badge" title="由一期模拟 AI 投放">AI 放置</span>}
      </header>

      <div className="cc-card-badges">
        <span className={`cc-scope-badge cc-scope-${node.scope}`} title={`归属：${scopeText(node)}`}>{scopeText(node)}</span>
        {node.meta?.unverified && <span className="cc-unverified" title="纯前端一期不校验路径是否存在">未验证</span>}
      </div>

      <div className="cc-card-body" onDoubleClick={(event) => event.stopPropagation()}>
        {(node.type === 'markdown' || node.type === 'plainText') && (
          <textarea
            className="cc-text-editor"
            aria-label={`编辑${meta.label}内容`}
            value={node.content ?? ''}
            placeholder={node.type === 'markdown' ? '输入 Markdown 内容…' : '输入纯文本内容…'}
            spellCheck={false}
            data-cc-wheel-lock
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => props.onContentChange(node.id, event.currentTarget.value)}
          />
        )}
        {node.type === 'image' && (
          node.previewUrl !== undefined
            ? <img src={node.previewUrl} alt={node.title} loading="lazy" decoding="async" draggable={false} />
            : <div className="cc-image-placeholder"><span>▧</span><small>模拟图片预览</small></div>
        )}
        {node.type === 'media' && (
          <div className="cc-media-placeholder">
            <span aria-hidden>{mediaIcon(node)}</span>
            <div className="cc-wave" aria-hidden><i /><i /><i /><i /><i /><i /><i /></div>
            <small>{/\.(?:mp3|wav|m4a|aac|ogg)$/i.test(node.path ?? '') ? '模拟音频预览' : '模拟视频预览'}</small>
          </div>
        )}
        {node.type === 'folder' && (
          <div className="cc-file-placeholder"><span aria-hidden>📁</span><strong>本地文件夹引用</strong><small>一期不读取文件夹内容</small></div>
        )}
        {node.type === 'file' && (
          <div className="cc-file-placeholder"><span className="cc-extension">{extensionOf(node.title)}</span><strong>{node.meta?.size ?? '未知大小'}</strong><small>使用默认应用打开</small></div>
        )}
      </div>

      {(node.path !== undefined || node.meta?.size !== undefined || node.meta?.mtime !== undefined) && (
        <div className="cc-card-meta" title={node.path ?? ''}>
          <span>{node.path ?? '画板内便签'}</span>
          <small>{[node.meta?.size, node.meta?.mtime].filter(Boolean).join(' · ')}</small>
        </div>
      )}

      <footer className="cc-card-actions" data-cc-ui onDoubleClick={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => props.onOpen(node.id)}>打开</button>
        <details className="cc-action-menu">
          <summary>复制与操作</summary>
          <div className="cc-action-popover">
            <button type="button" onClick={() => props.onCopy(node.id, 'id')}>复制节点 ID</button>
            <button type="button" onClick={() => props.onCopy(node.id, 'title')}>复制标题</button>
            <button type="button" disabled={!node.path} onClick={() => props.onCopy(node.id, 'path')}>复制路径</button>
            <button type="button" onClick={() => props.onCopy(node.id, 'reference')}>复制引用串</button>
            <button type="button" className="cc-danger-action" onClick={() => props.onRemove(node.id)}>从画板移除</button>
          </div>
        </details>
      </footer>
    </article>
  )
})

function extensionOf(title: string): string {
  const suffix = title.includes('.') ? title.split('.').pop() : 'FILE'
  return String(suffix ?? 'FILE').slice(0, 7).toUpperCase()
}
