/**
 * dsh-memory-evolve — 临时信息 tab（conversation.view 第三个 entry）。
 *
 * 一个持久化的 Markdown 便签：临时想法随手记在这里（最终会迁移到别处
 * 或删除），内容存在 host 的 <memoryDir>/scratch.md，跨 DSH web 重启
 * 保留。**自动保存**：停止输入约 0.8s 自动落盘（串行保存队列，失败后
 * 3s 自动重试，切走 Tab / 关页面前强制保存），无需手动保存。
 *
 * 数据来自 host 的 /memory-evolve/api/scratch 路由；样式在
 * scratch-styles.css（sp- 前缀，由 index.ts 注入）。组件内部自带中英
 * 文案，不接全局 locale（与 CoIView 一致）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** 自动保存防抖间隔（停止输入多久后保存）。 */
const DEBOUNCE_MS = 800
/** 保存失败后的自动重试间隔。 */
const RETRY_MS = 3000

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

/** 中英文案（默认中文，不接全局 locale）。 */
const DICT = {
  zh: {
    help: '临时想法、随手记都放这里（Markdown 格式）：内容自动保存到 ~/.dsh/memories/scratch.md，重启不丢；整理完成后迁移到别处或删除即可。',
    placeholder: '写下临时的想法…\n\n支持 Markdown 格式；停止输入后自动保存，随时回来继续写。',
    saving: '保存中…',
    dirty: '编辑中，即将自动保存…',
    saveFailed: '保存失败：{message}（稍后自动重试）',
    loadFailed: '读取失败：{message}',
    open: '用系统工具打开',
    openFailed: '打开失败：{message}',
    savedAt: '已保存 {time}',
    neverSaved: '还没有保存过',
  },
  en: {
    help: 'Jot down temporary ideas (Markdown). Content auto-saves to ~/.dsh/memories/scratch.md and survives restarts; migrate it elsewhere or delete it once it has served its purpose.',
    placeholder: 'Write temporary thoughts…\n\nMarkdown is supported; auto-saves after you stop typing.',
    saving: 'Saving…',
    dirty: 'Editing — will auto-save…',
    saveFailed: 'Save failed: {message} (will retry shortly)',
    loadFailed: 'Load failed: {message}',
    open: 'Open with system tool',
    openFailed: 'Open failed: {message}',
    savedAt: 'Saved {time}',
    neverSaved: 'Never saved yet',
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
 * 临时信息 tab 组件。加载 → 编辑 → **自动保存**：防抖 + 串行队列 +
 * 失败重试 + 卸载前强制保存。
 */
export function ScratchView(props: ConvViewProps & ScratchViewProps): JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState('')
  /** 最后成功落盘的版本——内容与之不同即「未保存」。 */
  const [savedContent, setSavedContent] = useState('')
  const [path, setPath] = useState<string | null>(null)
  const [mtime, setMtime] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** 保存失败时递增，驱动自动重试（见自动保存 effect）。 */
  const [saveTick, setSaveTick] = useState(0)

  // 最新值的 ref 镜像：异步保存读取的总是「当时」的内容快照。
  const contentRef = useRef(content)
  const savedContentRef = useRef(savedContent)
  const pathRef = useRef(path)
  useEffect(() => { contentRef.current = content }, [content])
  useEffect(() => { savedContentRef.current = savedContent }, [savedContent])
  useEffect(() => { pathRef.current = path }, [path])
  /** 串行保存队列：保存中再触发则标记 pending，完成后接力。 */
  const savingRef = useRef(false)
  const pendingRef = useRef(false)

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

  /**
   * 保存当前内容快照（串行：in-flight 时只标记 pending，完成后自动接力
   * 再存一次，保证最后的内容一定落盘）。响应只把「本次快照」标为已保存
   * ——期间若用户又输入了新内容，dirty 判断依然正确。
   */
  const save = useCallback(async (): Promise<void> => {
    if (savingRef.current) {
      pendingRef.current = true
      return
    }
    savingRef.current = true
    setSaving(true)
    const snapshot = contentRef.current
    try {
      const res = await fetch('/memory-evolve/api/scratch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: snapshot }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setSavedContent(snapshot)
      setMtime(typeof data.mtime === 'number' ? data.mtime : null)
      setPath(typeof data.path === 'string' ? data.path : pathRef.current)
      setSaveError(null)
    } catch (err) {
      setSaveError(errText(err))
      setSaveTick((n) => n + 1) // 触发自动重试
    } finally {
      savingRef.current = false
      setSaving(false)
      if (pendingRef.current) {
        pendingRef.current = false
        void save()
      }
    }
  }, [])

  // 自动保存：内容与已保存版本不一致时，停止输入 DEBOUNCE_MS 后保存；
  // 保存失败后 RETRY_MS 自动重试（saveError/saveTick 变化会重跑本 effect）。
  useEffect(() => {
    if (contentRef.current === savedContentRef.current) return
    const timer = setTimeout(() => void save(), saveError === null ? DEBOUNCE_MS : RETRY_MS)
    return () => clearTimeout(timer)
  }, [content, savedContent, saveError, saveTick, save])

  // 卸载前强制保存（切走 Tab / 页面关闭时防抖还没到点的内容不丢失）。
  useEffect(() => {
    return () => {
      if (contentRef.current !== savedContentRef.current) {
        void save()
      }
    }
  }, [save])

  const dirty = content !== savedContent

  const openFile = async (): Promise<void> => {
    try {
      await revealScratch()
      // 成功无需提示：系统工具已经打开了文件。
    } catch (err) {
      setSaveError(pick(DICT.zh.openFailed, DICT.en.openFailed).replace('{message}', errText(err)))
    }
  }

  const statusText = (): string => {
    if (saving) return pick(DICT.zh.saving, DICT.en.saving)
    if (saveError !== null) return saveError
    if (dirty) return pick(DICT.zh.dirty, DICT.en.dirty)
    return mtime === null
      ? pick(DICT.zh.neverSaved, DICT.en.neverSaved)
      : pick(DICT.zh.savedAt, DICT.en.savedAt).replace('{time}', formatTime(mtime))
  }
  const statusKind = saveError !== null ? 'error' : (saving || dirty ? 'pending' : 'ok')

  return (
    <div className="sp-root">
      <div className="sp-head">
        <span className="sp-path" title={path ?? ''}>
          📝 {path ?? ''}
        </span>
      </div>
      <p className="sp-help">{pick(DICT.zh.help, DICT.en.help)}</p>
      {error !== null && <div className="sp-notice sp-notice-error">{error}</div>}
      {loaded && (
        <>
          <textarea
            className="sp-editor"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={pick(DICT.zh.placeholder, DICT.en.placeholder)}
            spellCheck={false}
          />
          <div className="sp-toolbar">
            <span className={`sp-status sp-status-${statusKind}`}>{statusText()}</span>
            <span className="sp-spacer" />
            <button type="button" className="sp-btn" onClick={() => void openFile()} title={path ?? ''}>
              {pick(DICT.zh.open, DICT.en.open)}
            </button>
          </div>
        </>
      )}
      {!loaded && error === null && <div className="sp-loading">{pick(DICT.zh.saving, DICT.en.saving)}</div>}
    </div>
  )
}
