/**
 * 画板浮层：路径上板 / 便签上板 / 模拟搜索上板 / 预览 / 移除确认。
 * 全部是前端模拟，不读真实磁盘。
 */
import { useMemo, useState } from 'react'
import { CATALOG, TYPE_GLYPH, TYPE_LABEL } from './constants.ts'
import { inferTypeFromPath, placeholderHue } from './helpers.ts'
import type { CanvasDialogKind, CanvasNode, CanvasNodeType } from './types.ts'

export interface PathSubmit {
  path: string
}

export interface NoteSubmit {
  title: string
  type: 'markdown' | 'plainText'
  content: string
}

export interface CanvasDialogsProps {
  kind: CanvasDialogKind
  previewNode: CanvasNode | null
  removeNode: CanvasNode | null
  onClose: () => void
  onPath: (payload: PathSubmit) => void
  onNote: (payload: NoteSubmit) => void
  onCatalog: (title: string, path: string, type: CanvasNodeType) => void
  onConfirmRemove: () => void
  onToast: (text: string) => void
}

function PathDialog(props: { onClose: () => void; onPath: (p: PathSubmit) => void }): JSX.Element {
  const [path, setPath] = useState('')
  const guessed = inferTypeFromPath(path)
  return (
    <div className="cg-dialog" role="dialog" aria-label="路径上板">
      <h3>路径上板</h3>
      <p>粘贴本地路径即可生成卡片。一期不校验文件是否存在，卡片会标「未验证」。</p>
      <div className="cg-field">
        <label htmlFor="cg-path-input">本地路径</label>
        <input
          id="cg-path-input"
          autoFocus
          value={path}
          placeholder="/Users/me/Documents/合同.pdf"
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && path.trim()) props.onPath({ path })
            if (e.key === 'Escape') props.onClose()
          }}
        />
      </div>
      <div className="cg-hint">
        将识别为：{TYPE_GLYPH[guessed]} {TYPE_LABEL[guessed]}
      </div>
      <div className="cg-dialog-actions">
        <button type="button" className="cg-btn cg-ghost" onClick={props.onClose}>取消</button>
        <button
          type="button"
          className="cg-btn cg-primary"
          disabled={!path.trim()}
          onClick={() => props.onPath({ path })}
        >
          上板
        </button>
      </div>
    </div>
  )
}

function NoteDialog(props: { onClose: () => void; onNote: (p: NoteSubmit) => void }): JSX.Element {
  const [title, setTitle] = useState('未命名便签')
  const [type, setType] = useState<'markdown' | 'plainText'>('markdown')
  const [content, setContent] = useState('')
  return (
    <div className="cg-dialog" role="dialog" aria-label="新建便签">
      <h3>便签上板</h3>
      <p>内容存在画板里，不指向任何文件（与 scratch 同语义，一期不做互通）。</p>
      <div className="cg-field">
        <label htmlFor="cg-note-title">标题</label>
        <input id="cg-note-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="cg-field">
        <label htmlFor="cg-note-type">类型</label>
        <select
          id="cg-note-type"
          value={type}
          onChange={(e) => setType(e.target.value === 'plainText' ? 'plainText' : 'markdown')}
        >
          <option value="markdown">Markdown</option>
          <option value="plainText">纯文本</option>
        </select>
      </div>
      <div className="cg-field">
        <label htmlFor="cg-note-body">内容</label>
        <textarea id="cg-note-body" value={content} onChange={(e) => setContent(e.target.value)} />
      </div>
      <div className="cg-dialog-actions">
        <button type="button" className="cg-btn cg-ghost" onClick={props.onClose}>取消</button>
        <button
          type="button"
          className="cg-btn cg-primary"
          onClick={() => props.onNote({ title: title.trim() || '未命名便签', type, content })}
        >
          上板
        </button>
      </div>
    </div>
  )
}

function CatalogDialog(props: {
  onClose: () => void
  onCatalog: (title: string, path: string, type: CanvasNodeType) => void
}): JSX.Element {
  const [q, setQ] = useState('')
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return CATALOG
    return CATALOG.filter((item) =>
      item.title.toLowerCase().includes(needle)
      || item.path.toLowerCase().includes(needle)
      || item.hint.includes(needle)
      || TYPE_LABEL[item.type].includes(needle),
    )
  }, [q])
  return (
    <div className="cg-dialog" role="dialog" aria-label="模拟搜索上板">
      <h3>搜索上板（模拟）</h3>
      <p>内置示例清单，选中即上板。真实本地搜索等宿主 API 接入后再接。</p>
      <div className="cg-field">
        <label htmlFor="cg-cat-q">过滤示例</label>
        <input
          id="cg-cat-q"
          autoFocus
          value={q}
          placeholder="合同 / 设计稿 / 录音…"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="cg-catalog">
        {rows.length === 0 ? <div className="cg-hint">没有匹配的示例文件</div> : null}
        {rows.map((item) => (
          <button
            key={item.path}
            type="button"
            className="cg-catalog-row"
            onClick={() => props.onCatalog(item.title, item.path, item.type)}
          >
            <span aria-hidden>{TYPE_GLYPH[item.type]}</span>
            <span>
              <strong>{item.title}</strong>
              <small>{item.path} · {item.size} · {item.hint}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="cg-dialog-actions">
        <button type="button" className="cg-btn cg-ghost" onClick={props.onClose}>关闭</button>
      </div>
    </div>
  )
}

function PreviewDialog(props: {
  node: CanvasNode
  onClose: () => void
  onToast: (text: string) => void
}): JSX.Element {
  const { node } = props
  const light = node.type === 'markdown' || node.type === 'plainText' || node.type === 'image' || node.type === 'media'
  const hue = placeholderHue(node.id)
  return (
    <div className="cg-dialog cg-dialog-wide" role="dialog" aria-label="预览">
      <h3>{TYPE_GLYPH[node.type]} {node.title}</h3>
      <p>
        {node.path ?? '画板内便签'}
        {node.unverified ? ' · 路径未验证' : ''}
      </p>
      {node.type === 'markdown' || node.type === 'plainText' ? (
        <div className="cg-preview-body">{node.content || '（空内容）'}</div>
      ) : null}
      {node.type === 'image' ? (
        <div
          className="cg-ph"
          style={{
            minHeight: 180,
            background: `linear-gradient(145deg, hsl(${hue} 42% 46%), hsl(${(hue + 40) % 360} 38% 32%))`,
          }}
        >
          🖼
          <small>模拟图片预览（后端接入后走宿主文件代理）</small>
        </div>
      ) : null}
      {node.type === 'media' ? (
        <div
          className="cg-ph"
          style={{
            minHeight: 160,
            background: `linear-gradient(160deg, hsl(${hue} 35% 38%), hsl(${(hue + 60) % 360} 30% 22%))`,
          }}
        >
          ▶
          <small>模拟音视频预览</small>
        </div>
      ) : null}
      {!light ? (
        <div>
          <p>此类素材一期不在浏览器里渲染（Word / PDF / 文件夹等）。</p>
          <button
            type="button"
            className="cg-btn cg-ghost"
            onClick={() => props.onToast('用默认应用打开：后端接入后可用')}
          >
            用默认应用打开
          </button>
        </div>
      ) : null}
      <div className="cg-dialog-actions">
        <button type="button" className="cg-btn cg-primary" onClick={props.onClose}>关闭</button>
      </div>
    </div>
  )
}

function RemoveDialog(props: {
  node: CanvasNode
  onClose: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <div className="cg-dialog" role="dialog" aria-label="确认移除">
      <h3>从画板移除？</h3>
      <p>
        将移除「{props.node.title}」。只从画板拿掉，不删除源文件
        {props.node.path ? `（${props.node.path}）` : ''}。
      </p>
      <div className="cg-dialog-actions">
        <button type="button" className="cg-btn cg-ghost" onClick={props.onClose}>取消</button>
        <button type="button" className="cg-btn cg-primary" onClick={props.onConfirm}>移除</button>
      </div>
    </div>
  )
}

export function CanvasDialogs(props: CanvasDialogsProps): JSX.Element | null {
  if (!props.kind) return null
  return (
    <div
      className="cg-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      {props.kind === 'path' ? <PathDialog onClose={props.onClose} onPath={props.onPath} /> : null}
      {props.kind === 'note' ? <NoteDialog onClose={props.onClose} onNote={props.onNote} /> : null}
      {props.kind === 'catalog' ? <CatalogDialog onClose={props.onClose} onCatalog={props.onCatalog} /> : null}
      {props.kind === 'preview' && props.previewNode ? (
        <PreviewDialog node={props.previewNode} onClose={props.onClose} onToast={props.onToast} />
      ) : null}
      {props.kind === 'remove' && props.removeNode ? (
        <RemoveDialog node={props.removeNode} onClose={props.onClose} onConfirm={props.onConfirmRemove} />
      ) : null}
    </div>
  )
}
