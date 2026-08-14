/**
 * 画板浮层：路径上板 / 便签上板 / 搜索上板 / 预览 / 移除确认。
 * 搜索上板：走宿主真实搜索（searchLocalFiles，复用 search-docs 的
 * mdfind/rg/walk provider，与 memory_evolve_search_local_files 同源）；
 * 范围可选本机全部（缺省）/ 当前项目。预览：后端可用时图片/文本/PDF
 * 走文件代理，否则占位色块。
 */
import { useEffect, useRef, useState } from 'react'
import { TYPE_GLYPH, TYPE_LABEL } from './constants.ts'
import { inferTypeFromPath, placeholderHue } from './helpers.ts'
import { fileProxyUrl, searchFilesBackend } from './api-client.ts'
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
  /** 迁移归属对话框的目标节点（2026-08-14）。 */
  migrateNode: CanvasNode | null
  /** 后端可用标记：true 时预览走宿主文件代理。 */
  backendReady: boolean
  /** 当前会话 id（真实搜索按它定位默认搜索目录=会话工作目录）。 */
  sessionId: string
  onClose: () => void
  onPath: (payload: PathSubmit) => void
  onNote: (payload: NoteSubmit) => void
  onCatalog: (title: string, path: string, type: CanvasNodeType, size?: string) => void
  onConfirmRemove: () => void
  onToast: (text: string) => void
  /** 系统默认应用打开上板文件（2026-08-14 接入真实实现）。 */
  onOpen: (id: string) => void
  /** 迁移节点归属（2026-08-14 用户拍板：仅用户手动触发）。 */
  onMigrate: (nodeId: string, scope: 'session' | 'project' | 'global') => void
}

function PathDialog(props: { onClose: () => void; onPath: (p: PathSubmit) => void }): JSX.Element {
  const [path, setPath] = useState('')
  const guessed = inferTypeFromPath(path)
  return (
    <div className="cg-dialog" role="dialog" aria-label="路径上板">
      <h3>路径上板</h3>
      <p>粘贴本地路径即可生成卡片。暂不校验文件是否存在，卡片会标「未验证」。</p>
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
      <p>内容存在画板里，不指向任何文件。</p>
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
  onCatalog: (title: string, path: string, type: CanvasNodeType, size?: string) => void
  /** 后端可用标记：true 时走宿主真实搜索。 */
  backendReady: boolean
  /** 当前会话 id（后端按它解析项目搜索范围）。 */
  sessionId: string
}): JSX.Element {
  const [q, setQ] = useState('')
  // 搜索范围（2026-08-14 用户反馈：默认只能搜项目目录）：
  //   local（缺省）= 全盘搜索；project = 当前会话工作目录。
  const [scope, setScope] = useState<'local' | 'project'>('local')
  const [remoteRows, setRemoteRows] = useState<Array<{ title: string; path: string; type: string; size: string }> | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const searchSeq = useRef(0)

  // 后端模式：输入防抖 350ms 触发真实搜索（mdfind/rg/walk）。
  useEffect(() => {
    if (!props.backendReady) return
    const needle = q.trim()
    if (!needle) {
      setRemoteRows(null)
      setSearchError(null)
      return
    }
    setSearching(true)
    setSearchError(null)
    const seq = ++searchSeq.current
    const timer = setTimeout(() => {
      void searchFilesBackend(needle, { sessionId: props.sessionId, scope, limit: 20 }).then((rows) => {
        if (searchSeq.current !== seq) return // 过期响应丢弃
        setSearching(false)
        setRemoteRows(rows)
        if (rows === null) setSearchError('本地搜索不可用')
      })
    }, 350)
    return () => { clearTimeout(timer); setSearching(false) }
  }, [q, props.backendReady, props.sessionId, scope])

  const rows = props.backendReady && remoteRows !== null ? remoteRows : []
  return (
    <div className="cg-dialog" role="dialog" aria-label="搜索上板">
      <h3>搜索上板</h3>
      <p>搜索本机文件，选中即上板。</p>
      <div className="cg-field">
        <label htmlFor="cg-cat-q">关键字</label>
        <input
          id="cg-cat-q"
          autoFocus
          value={q}
          placeholder="合同 / 设计稿 / 录音…"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="cg-seg cg-scope" role="group" aria-label="搜索范围">
        <button type="button" className={scope === 'local' ? 'cg-on' : ''} onClick={() => setScope('local')}>
          本机全部
        </button>
        <button type="button" className={scope === 'project' ? 'cg-on' : ''} onClick={() => setScope('project')}>
          当前项目
        </button>
      </div>
      {searching ? <div className="cg-hint">搜索中…</div> : null}
      {searchError ? <div className="cg-hint cg-hint-error">{searchError}</div> : null}
      <div className="cg-catalog">
        {!searching && rows.length === 0 ? (
          <div className="cg-hint">
            {q.trim() ? '没有匹配的文件' : '输入关键字搜索本机文件'}
          </div>
        ) : null}
        {rows.map((item) => (
          <button
            key={item.path}
            type="button"
            className="cg-catalog-row"
            onClick={() => props.onCatalog(item.title, item.path, item.type as CanvasNodeType, item.size)}
          >
            <span aria-hidden>{TYPE_GLYPH[item.type as CanvasNodeType] ?? '▤'}</span>
            <span>
              <strong>{item.title}</strong>
              <small>{item.path} · {item.size ?? ''}</small>
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
  /** 后端可用标记：true 时预览走宿主文件代理（真实文件内容）。 */
  backendReady: boolean
  onClose: () => void
  onToast: (text: string) => void
  /** 系统默认应用打开上板文件（2026-08-14 接入真实实现）。 */
  onOpen: (id: string) => void
}): JSX.Element {
  const { node } = props
  const light = node.type === 'markdown' || node.type === 'plainText' || node.type === 'image' || node.type === 'media'
  const hue = placeholderHue(node.id)
  const proxyUrl = props.backendReady ? fileProxyUrl(node.id) : ''
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
        proxyUrl ? (
          <img className="cg-preview-img" src={proxyUrl} alt={node.title} loading="lazy" decoding="async" />
        ) : (
          <div
            className="cg-ph"
            style={{
              minHeight: 180,
              background: `linear-gradient(145deg, hsl(${hue} 42% 46%), hsl(${(hue + 40) % 360} 38% 32%))`,
            }}
          >
            🖼
            <small>启用画板模块后可预览真实图片</small>
          </div>
        )
      ) : null}
      {node.type === 'media' ? (
        proxyUrl ? (
          /\.(mp3|wav|m4a|aac|ogg)$/i.test(node.path ?? '') ? (
            <audio className="cg-preview-media" src={proxyUrl} controls preload="metadata" />
          ) : (
            <video className="cg-preview-media" src={proxyUrl} controls preload="metadata" />
          )
        ) : (
          <div
            className="cg-ph"
            style={{
              minHeight: 160,
              background: `linear-gradient(160deg, hsl(${hue} 35% 38%), hsl(${(hue + 60) % 360} 30% 22%))`,
            }}
          >
            ▶
            <small>启用画板模块后可播放真实文件</small>
          </div>
        )
      ) : null}
      {!light ? (
        <div>
          <p>此类素材暂不在浏览器内渲染（Word / PDF / 文件夹等）。</p>
          {node.path ? (
            <button
              type="button"
              className="cg-btn cg-ghost"
              onClick={() => props.onOpen(node.id)}
            >
              用默认应用打开
            </button>
          ) : null}
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

/**
 * 迁移归属对话框（2026-08-14 用户拍板：改归属只能用户手动触发；
 * 目标会话 = 当前打开画板的会话）。三档去向：
 *   💬 本会话 → session 级（归当前会话 + 当前项目）
 *   📁 本项目 → project 级（项目内所有会话可见）
 *   🌐 所有项目可见 → global 级（所有视角可见）
 */
function MigrateDialog(props: {
  node: CanvasNode
  onClose: () => void
  onMigrate: (nodeId: string, scope: 'session' | 'project' | 'global') => void
}): JSX.Element {
  const [scope, setScope] = useState<'session' | 'project' | 'global'>(props.node.scope === 'global' ? 'global' : props.node.scope === 'project' ? 'project' : 'session')
  return (
    <div className="cg-dialog" role="dialog" aria-label="迁移归属">
      <h3>迁移归属</h3>
      <p>「{props.node.title}」将移动到：</p>
      <div className="cg-migrate-opts">
        <button type="button" className={`cg-migrate-opt${scope === 'session' ? ' cg-on' : ''}`} onClick={() => setScope('session')}>
          <strong>💬 本会话</strong>
          <small>归当前会话（在别的会话打开画板看不到它，除非切「所有项目」）</small>
        </button>
        <button type="button" className={`cg-migrate-opt${scope === 'project' ? ' cg-on' : ''}`} onClick={() => setScope('project')}>
          <strong>📁 本项目</strong>
          <small>项目级：当前项目内所有会话都能看到</small>
        </button>
        <button type="button" className={`cg-migrate-opt${scope === 'global' ? ' cg-on' : ''}`} onClick={() => setScope('global')}>
          <strong>🌐 所有项目可见</strong>
          <small>全局：任何会话、任何视角都能看到</small>
        </button>
      </div>
      <div className="cg-dialog-actions">
        <button type="button" className="cg-btn cg-ghost" onClick={props.onClose}>取消</button>
        <button type="button" className="cg-btn cg-primary" onClick={() => props.onMigrate(props.node.id, scope)}>迁移</button>
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
      {props.kind === 'catalog' ? (
        <CatalogDialog onClose={props.onClose} onCatalog={props.onCatalog} backendReady={props.backendReady} sessionId={props.sessionId} />
      ) : null}
      {props.kind === 'preview' && props.previewNode ? (
        <PreviewDialog node={props.previewNode} onClose={props.onClose} onToast={props.onToast} backendReady={props.backendReady} onOpen={props.onOpen} />
      ) : null}
      {props.kind === 'remove' && props.removeNode ? (
        <RemoveDialog node={props.removeNode} onClose={props.onClose} onConfirm={props.onConfirmRemove} />
      ) : null}
      {props.kind === 'migrate' && props.migrateNode ? (
        <MigrateDialog node={props.migrateNode} onClose={props.onClose} onMigrate={props.onMigrate} />
      ) : null}
    </div>
  )
}
