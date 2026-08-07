/**
 * dsh-memory-evolve — 临时信息 tab（conversation.view 第三个 entry）。
 *
 * 一个持久化的 Markdown 便签：临时想法随手记在这里（最终会迁移到别处
 * 或删除），内容存在 host 的 <memoryDir>/scratch.md，跨 DSH web 重启
 * 保留。第一版刻意保持简单：一个等宽字体编辑区 + 显式保存（Cmd/Ctrl+S
 * 快捷键）+ 用系统工具打开文件 + 保存状态提示。
 *
 * 数据来自 host 的 /memory-evolve/api/scratch 路由；样式在
 * scratch-styles.css（sp- 前缀，由 index.ts 注入）。组件内部自带中英
 * 文案，不接全局 locale（与 CoIView 一致）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** GET /api/scratch 的响应形状。 */
interface ScratchData {
  content: string
  path: string
  mtime: number | null
  size: number
}

/** Locale-bound props（与 MemoryTabView 一致，宽类型 Translate）。 */
export interface ScratchViewProps {
  t: Translate
}

/** 行内提示（成功/失败）。 */
interface Notice {
  kind: 'ok' | 'error'
  text: string
}

/** 中英文案（默认中文，不接全局 locale）。 */
const DICT = {
  zh: {
    title: '临时信息',
    help: '临时想法、随手记都放这里（Markdown 格式）：内容持久保存在 ~/.dsh/memories/scratch.md，重启不丢；整理完成后迁移到别处或删除即可。',
    placeholder: '写下临时的想法…\n\n支持 Markdown 格式；保存后内容会持久保留，随时回来继续写。',
    save: '保存',
    saved: '已保存',
    saving: '保存中…',
    dirty: '有未保存的修改',
    loadFailed: '读取失败：{message}',
    saveFailed: '保存失败：{message}',
    open: '用系统工具打开',
    opened: '已用系统工具打开',
    openFailed: '打开失败：{message}',
    savedAt: '上次保存 {time}',
    neverSaved: '还没有保存过',
    hintSave: 'Ctrl/Cmd + S 保存',
    loading: '加载中…',
  },
  en: {
    title: 'Scratch Pad',
    help: 'Jot down temporary ideas (Markdown). Content persists in ~/.dsh/memories/scratch.md across restarts; migrate it elsewhere or delete it once it has served its purpose.',
    placeholder: 'Write temporary thoughts…\n\nMarkdown is supported; saved content persists, come back any time.',
    save: 'Save',
    saved: 'Saved',
    saving: 'Saving…',
    dirty: 'Unsaved changes',
    loadFailed: 'Load failed: {message}',
    saveFailed: 'Save failed: {message}',
    open: 'Open with system tool',
    opened: 'Opened with the system tool',
    openFailed: 'Open failed: {message}',
    savedAt: 'Last saved {time}',
    neverSaved: 'Never saved yet',
    hintSave: 'Ctrl/Cmd + S to save',
    loading: 'Loading…',
  },
} as const

/** 选择文案的语言（默认中文）。 */
function pick(zhText: string, enText: string): string {
  return (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('en'))
    ? enText
    : zhText
}

/** 统一错误文本。 */
function errText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message || 'unknown error'
}

/** 格式化为本地时间字符串（HH:MM:SS）。 */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** 打开 scratch 文档（复用 host 的 reveal 通道）。 */
async function revealScratch(): Promise<void> {
  const res = await fetch('/memory-evolve/api/reveal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'scratchFile' }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
}

/**
 * 临时信息 tab 组件。加载 → 编辑 → 保存（显式按钮或 Cmd/Ctrl+S），
 * 未保存修改有脏标记提示。
 */
export function ScratchView(props: ConvViewProps & ScratchViewProps): JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState('')
  /** 最后成功保存的版本——内容与之不同即「未保存」。 */
  const [savedContent, setSavedContent] = useState('')
  const [path, setPath] = useState<string | null>(null)
  const [mtime, setMtime] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/memory-evolve/api/scratch')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: ScratchData = await res.json()
      setContent(data.content)
      setSavedContent(data.content)
      setPath(data.path)
      setMtime(data.mtime)
      setError(null)
      setLoaded(true)
    } catch (err) {
      setError(errText(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async (): Promise<void> => {
    setSaving(true)
    setNotice(null)
    try {
      const res = await fetch('/memory-evolve/api/scratch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setSavedContent(content)
      setMtime(typeof data.mtime === 'number' ? data.mtime : null)
      setPath(typeof data.path === 'string' ? data.path : path)
      setNotice({ kind: 'ok', text: DICT.zh.saved })
    } catch (err) {
      setNotice({ kind: 'error', text: pick(DICT.zh.saveFailed, DICT.en.saveFailed).replace('{message}', errText(err)) })
    } finally {
      setSaving(false)
    }
  }, [content, path])

  // Cmd/Ctrl + S 保存：只在焦点位于本组件编辑区时拦截，不干扰全局。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's'
        && textareaRef.current === event.target) {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [save])

  const dirty = content !== savedContent

  const openFile = async (): Promise<void> => {
    setNotice(null)
    try {
      await revealScratch()
      setNotice({ kind: 'ok', text: pick(DICT.zh.opened, DICT.en.opened) })
    } catch (err) {
      setNotice({ kind: 'error', text: pick(DICT.zh.openFailed, DICT.en.openFailed).replace('{message}', errText(err)) })
    }
  }

  const savedLabel = mtime === null
    ? pick(DICT.zh.neverSaved, DICT.en.neverSaved)
    : pick(DICT.zh.savedAt, DICT.en.savedAt).replace('{time}', formatTime(mtime))

  return (
    <div className="sp-root">
      <div className="sp-head">
        <span className="sp-path" title={path ?? ''}>
          📝 {path ?? ''}
        </span>
        <span className="sp-saved-at">{savedLabel}</span>
      </div>
      <p className="sp-help">{pick(DICT.zh.help, DICT.en.help)}</p>
      {error !== null && <div className="sp-notice sp-notice-error">{error}</div>}
      {loaded && (
        <>
          <textarea
            ref={textareaRef}
            className="sp-editor"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={pick(DICT.zh.placeholder, DICT.en.placeholder)}
            spellCheck={false}
          />
          <div className="sp-toolbar">
            <span className="sp-dirty">{dirty ? pick(DICT.zh.dirty, DICT.en.dirty) : ''}</span>
            <span className="sp-hint">{pick(DICT.zh.hintSave, DICT.en.hintSave)}</span>
            {notice !== null && <span className={`sp-notice sp-notice-${notice.kind}`}>{notice.text}</span>}
            <span className="sp-spacer" />
            <button type="button" className="sp-btn" onClick={() => void openFile()} title={path ?? ''}>
              {pick(DICT.zh.open, DICT.en.open)}
            </button>
            <button
              type="button"
              className="sp-btn sp-btn-primary"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? pick(DICT.zh.saving, DICT.en.saving) : pick(DICT.zh.save, DICT.en.save)}
            </button>
          </div>
        </>
      )}
      {!loaded && error === null && <div className="sp-loading">{pick(DICT.zh.loading, DICT.en.loading)}</div>}
    </div>
  )
}
