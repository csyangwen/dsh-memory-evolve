/**
 * SkillsBrowser — 技能中心三栏视图（技能列表 / 目录树 / 文件查看编辑器）。
 *
 * Merged into dsh-memory-evolve from the standalone dsh-skill-browser
 * plugin; rendered as the "技能管理" sub-tab of the session memory tab.
 * The API prefix (/skills-manager) is unchanged — the host half serves the
 * same routes. 纯展示组件：数据全部通过 fetch 走 /skills-manager/api，样式由
 * 入口注入的 styles.css 提供（sb- 前缀，DSH 设计 token）。值导入仅允许
 * react 与 ui-primitives 图标；契约类型来自 ./contract.ts（type-only，
 * 构建时擦除）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import {
  IconSearchOutline16,
  IconRefreshOutline16,
  IconFolderOpen16,
  IconFolderClose16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconEditOutline16,
  IconCheckOutline16,
  IconLoadingOutline16,
  IconWarningOutline16,
  IconDataOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SkillSummary,
  FsEntry,
  SkillsResponse,
  BrowseResponse,
  ReadResponse,
  WriteResponse,
  ToggleResponse,
  DirInfo,
  DirsResponse,
  DirMutationResponse,
  SkillsBrowserProps,
} from './contract.ts'

/** 后端 API 前缀（同源）。 */
const API = '/skills-manager/api'
/** localStorage 持久化 key。 */
const LS_KEY = 'skills-manager.state.v1'

// 入口 index.ts 从本文件取 SkillsBrowserProps，这里透传重导出（type-only）
export type { SkillsBrowserProps } from './contract.ts'

type TFn = SkillsBrowserProps['t']

/** 已打开文件的内存状态。 */
interface FileState {
  path: string
  content: string
  size: number
  mtime: number
}

/** 读取失败的归类（415 非文本 / 413 超大 / 其他）。 */
interface FileError {
  kind: 'not.text' | 'too.large' | 'read.failed'
  message: string
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/** 持久化到 localStorage 的 UI 状态。 */
interface PersistedState {
  skill: string | null
  root: string | null
  expanded: string[]
  file: string | null
}

/** 带 HTTP 状态码的 API 错误，便于把 413/415 映射到专属文案。 */
class ApiFailure extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

/** 统一 fetch 封装：解析 { error } 错误信封，网络失败也转成 Error。 */
async function request<T>(input: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(input, init)
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new ApiFailure(0, err instanceof Error ? err.message : String(err))
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new ApiFailure(res.status, typeof data.error === 'string' ? data.error : `HTTP ${res.status}`)
  }
  return data as T
}

/** 取路径最后一段（root 为 '/' 时返回 '/'）。 */
function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  if (trimmed === '') return '/'
  const idx = trimmed.lastIndexOf('/')
  return idx < 0 ? trimmed : trimmed.slice(idx + 1)
}

/** 拼接绝对路径。 */
function joinPath(dir: string, name: string): string {
  const base = dir.replace(/\/+$/, '')
  return base === '' ? `/${name}` : `${base}/${name}`
}

/** 由绝对路径求相对 root 的相对路径（root 本身 → ''）。 */
function relOf(root: string, abs: string): string {
  if (abs === root) return ''
  const prefix = root === '/' ? '/' : `${root}/`
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : ''
}

/** 文件大小格式化：<1KiB 用 bytes，<1MiB 用 KiB，否则 MiB。 */
function formatSize(t: TFn, size: number | null): string {
  if (size == null) return ''
  if (size < 1024) return t('bytes', { size })
  if (size < 1024 * 1024) return t('kib', { size: (size / 1024).toFixed(1) })
  return t('mib', { size: (size / 1024 / 1024).toFixed(1) })
}

/** mtime 格式化为 yyyy-mm-dd hh:mm。 */
function formatTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** source 徽标配色：user→deepseek 蓝、project→green、bundled→neutral、其他→amber。 */
function sourceClass(source: string): string {
  if (source.startsWith('user')) return ' sb-badge--user'
  if (source.startsWith('project')) return ' sb-badge--project'
  if (source === 'bundled') return ' sb-badge--bundled'
  return ' sb-badge--other'
}

/** resourceBase 类型对应的小图标（url/opaque 均用 IconDataOutline16）。 */
function ResourceIcon({ skill }: { skill: SkillSummary }): JSX.Element {
  const rb = skill.resourceBase
  if (rb?.kind === 'directory') return <IconFolderOpen16 className="sb-card-meta-icon" />
  return <IconDataOutline16 className="sb-card-meta-icon" />
}

// ---------------------------------------------------------------------------
// 栏1 — 技能列表
// ---------------------------------------------------------------------------

/** 每页技能数（分页）。 */
const PAGE_SIZE = 20

/** 状态筛选：可用 = 模型可调用且未被禁用。 */
type StatusFilter = 'all' | 'enabled' | 'disabled'

interface SkillListProps {
  t: TFn
  skills: SkillSummary[]
  loading: boolean
  error: string | null
  query: string
  /** Selected source filter; `all` shows every source. */
  sourceFilter: string
  /** Distinct sources present in the current catalog, with counts. */
  sourceCounts: { source: string; count: number }[]
  /** Selected status filter. */
  statusFilter: StatusFilter
  selectedName: string | null
  /** Skill name whose toggle request is in flight. */
  togglingName: string | null
  /** Current page (1-based). */
  page: number
  onSourceFilter: (source: string) => void
  onStatusFilter: (status: StatusFilter) => void
  onToggleDisabled: (skill: SkillSummary) => void
  onSelect: (skill: SkillSummary) => void
  onRetry: () => void
  onPrevPage: () => void
  onNextPage: () => void
}

function SkillList(props: SkillListProps): JSX.Element {
  const {
    t,
    skills,
    loading,
    error,
    query,
    sourceFilter,
    sourceCounts,
    statusFilter,
    selectedName,
    togglingName,
    page,
    onSourceFilter,
    onStatusFilter,
    onToggleDisabled,
    onSelect,
    onRetry,
    onPrevPage,
    onNextPage,
  } = props

  // 按来源 + 状态 + 名称/描述/适用场景过滤（大小写不敏感，中文直接子串匹配）
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return skills.filter((s) => {
      if (sourceFilter !== 'all' && s.source !== sourceFilter) return false
      const available = s.invocable && !s.disabled
      if (statusFilter === 'enabled' && !available) return false
      if (statusFilter === 'disabled' && available) return false
      if (q === '') return true
      return `${s.name} ${s.description} ${s.whenToUse ?? ''}`.toLowerCase().includes(q)
    })
  }, [skills, query, sourceFilter, statusFilter])

  const totalCount = sourceCounts.reduce((sum, entry) => sum + entry.count, 0)
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageSafe = Math.min(Math.max(1, page), pageCount)
  const paged = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE)

  return (
    <div className="sb-section sb-section--skills">
      <div className="sb-pane-head">
        <span className="sb-pane-title">{t('pane.skills')}</span>
        <span className="sb-count">{t('skills.count', { count: filtered.length })}</span>
      </div>
      <div className="sb-chips">
          {sourceCounts.length > 1 && (
            <>
              <button
                type="button"
                className={`sb-chip${sourceFilter === 'all' ? ' sb-chip--active' : ''}`}
                onClick={() => onSourceFilter('all')}
              >
                {t('filter.all')} {totalCount}
              </button>
              {sourceCounts.map(({ source, count }) => (
                <button
                  type="button"
                  key={source}
                  className={`sb-chip${sourceFilter === source ? ' sb-chip--active' : ''}`}
                  onClick={() => onSourceFilter(source)}
                >
                  {source} {count}
                </button>
              ))}
              <span className="sb-chips-sep" />
            </>
          )}
          {(['all', 'enabled', 'disabled'] as StatusFilter[]).map((status) => (
            <button
              type="button"
              key={status}
              className={`sb-chip${statusFilter === status ? ' sb-chip--active' : ''}`}
              onClick={() => onStatusFilter(status)}
            >
              {status === 'all' ? t('filter.all') : status === 'enabled' ? t('status.enabled') : t('disabled.badge')}
            </button>
          ))}
      </div>
      <div className="sb-list">
        {loading && (
          <div className="sb-note">
            <IconLoadingOutline16 className="sb-spin" />
            <span>{t('loading.skills')}</span>
          </div>
        )}
        {!loading && error !== null && (
          <div className="sb-note sb-note--error">
            <IconWarningOutline16 />
            <span>{error}</span>
            <button type="button" className="sb-btn sb-btn--ghost" onClick={onRetry}>
              {t('refresh')}
            </button>
          </div>
        )}
        {!loading && error === null && filtered.length === 0 && (
          <div className="sb-note">{t('search.empty')}</div>
        )}
        {!loading &&
          error === null &&
          paged.map((skill) => (
            <button
              type="button"
              key={skill.name}
              className={`sb-card${skill.name === selectedName ? ' sb-card--active' : ''}${skill.disabled ? ' sb-card--disabled' : ''}`}
              onClick={() => onSelect(skill)}
              title={skill.disabled ? t('disabled.hint') : undefined}
            >
              <span className="sb-card-top">
                <span className="sb-card-name">{skill.name}</span>
                {skill.disabled && (
                  <span className="sb-badge sb-badge--disabled">{t('disabled.badge')}</span>
                )}
                <span className={`sb-badge${sourceClass(skill.source)}`}>
                  {t('source.badge', { source: skill.source })}
                </span>
              </span>
              <span className="sb-card-desc">{skill.description}</span>
              <span className="sb-card-meta">
                <ResourceIcon skill={skill} />
                {skill.whenToUse !== null && skill.whenToUse !== '' && (
                  <span className="sb-card-when">
                    <span className="sb-card-when-label">{t('when.to.use')}</span>
                    {skill.whenToUse}
                  </span>
                )}
                <span className="sb-spacer" />
                {skill.protected ? (
                  <span className="sb-badge sb-badge--protected" title={t('protected.hint')}>
                    {t('protected.badge')}
                  </span>
                ) : (
                  <span
                    className={`sb-toggle${skill.disabled ? ' sb-toggle--disabled' : ''}`}
                    role="button"
                    tabIndex={0}
                    title={skill.disabled ? t('enable') : t('disable')}
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleDisabled(skill)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        e.stopPropagation()
                        onToggleDisabled(skill)
                      }
                    }}
                  >
                    {togglingName === skill.name ? (
                      <IconLoadingOutline16 className="sb-spin" />
                    ) : skill.disabled ? (
                      t('enable')
                    ) : (
                      t('disable')
                    )}
                  </span>
                )}
              </span>
            </button>
          ))}
      </div>
      {pageCount > 1 && (
        <div className="sb-pager">
          <button
            type="button"
            className="sb-btn sb-btn--ghost"
            disabled={pageSafe <= 1}
            onClick={onPrevPage}
          >
            {t('pager.prev')}
          </button>
          <span className="sb-pager-info">{t('pager.page', { page: pageSafe, total: pageCount })}</span>
          <button
            type="button"
            className="sb-btn sb-btn--ghost"
            disabled={pageSafe >= pageCount}
            onClick={onNextPage}
          >
            {t('pager.next')}
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 栏2 — 目录树
// ---------------------------------------------------------------------------

interface Crumb {
  label: string
  abs: string
}

interface FileTreeProps {
  t: TFn
  hasSkill: boolean
  root: string | null
  rootOptions: string[]
  cache: Map<string, FsEntry[]>
  loadingDirs: Set<string>
  dirErrors: Map<string, string>
  expanded: Set<string>
  selectedPath: string | null
  crumbs: Crumb[]
  onRootChange: (root: string) => void
  onJump: (absDir: string) => void
  onToggleDir: (absDir: string) => void
  onFileClick: (absPath: string) => void
  onRetryDir: (absDir: string) => void
}

function FileTree(props: FileTreeProps): JSX.Element {
  const {
    t,
    hasSkill,
    root,
    rootOptions,
    cache,
    loadingDirs,
    dirErrors,
    expanded,
    selectedPath,
    crumbs,
    onRootChange,
    onJump,
    onToggleDir,
    onFileClick,
    onRetryDir,
  } = props

  // 递归渲染某个目录的 children（数据在父组件的 cache Map 中，按绝对路径取）
  const renderEntries = (dirAbs: string, depth: number): ReactNode => {
    const indent = { paddingLeft: 8 + depth * 14 }
    if (loadingDirs.has(dirAbs)) {
      return (
        <div className="sb-tree-note" style={indent}>
          <IconLoadingOutline16 className="sb-spin" />
          <span>{t('loading.dir')}</span>
        </div>
      )
    }
    const dirError = dirErrors.get(dirAbs)
    if (dirError !== undefined) {
      return (
        <div className="sb-tree-note sb-note--error" style={indent}>
          <IconWarningOutline16 />
          <span className="sb-tree-errmsg" title={dirError}>
            {dirError}
          </span>
          <button type="button" className="sb-tree-retry" onClick={() => onRetryDir(dirAbs)}>
            {t('refresh')}
          </button>
        </div>
      )
    }
    const entries = cache.get(dirAbs)
    if (entries === undefined) return null
    if (entries.length === 0) {
      return (
        <div className="sb-tree-note" style={indent}>
          {t('no.entries')}
        </div>
      )
    }
    return entries.map((entry) => {
      const abs = joinPath(dirAbs, entry.name)
      if (entry.type === 'dir') {
        const isOpen = expanded.has(abs)
        return (
          <div key={abs}>
            <button
              type="button"
              className="sb-tree-row"
              style={indent}
              onClick={() => onToggleDir(abs)}
              title={abs}
            >
              {isOpen ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
              {isOpen ? <IconFolderOpen16 /> : <IconFolderClose16 />}
              <span className="sb-tree-name">{entry.name}</span>
            </button>
            {isOpen && renderEntries(abs, depth + 1)}
          </div>
        )
      }
      return (
        <button
          type="button"
          key={abs}
          className={`sb-tree-row sb-tree-row--file${abs === selectedPath ? ' sb-tree-row--active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 + 14 }}
          onClick={() => onFileClick(abs)}
          title={abs}
        >
          <span className="sb-tree-name">{entry.name}</span>
          <span className="sb-tree-size">{formatSize(t, entry.size)}</span>
        </button>
      )
    })
  }

  return (
    <div className="sb-section sb-section--files">
      <div className="sb-pane-head">
        <span className="sb-pane-title">{t('pane.files')}</span>
      </div>
      {!hasSkill && <div className="sb-note">{t('no.skill.selected')}</div>}
      {hasSkill && root === null && <div className="sb-note">{t('no.root')}</div>}
      {hasSkill && root !== null && (
        <>
          <div className="sb-root-bar">
            <span className="sb-root-label">{t('root.label')}</span>
            <select
              className="sb-root-select"
              value={root}
              title={root}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => onRootChange(e.target.value)}
            >
              {rootOptions.map((r) => (
                <option key={r} value={r}>
                  {basename(r)}
                </option>
              ))}
            </select>
          </div>
          <div className="sb-crumbs">
            {crumbs.map((crumb, i) => (
              <span key={crumb.abs} className="sb-crumb-seg">
                {i > 0 && <IconChevronRightOutline14 className="sb-crumb-sep" />}
                <button type="button" className="sb-crumb" onClick={() => onJump(crumb.abs)}>
                  {crumb.label}
                </button>
              </span>
            ))}
          </div>
          <div className="sb-tree">{renderEntries(root, 0)}</div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 栏3 — 文件查看 / 编辑器
// ---------------------------------------------------------------------------

interface FileEditorProps {
  t: TFn
  skillName: string | null
  file: FileState | null
  fileLoading: boolean
  fileError: FileError | null
  hasSelection: boolean
  editing: boolean
  draft: string
  dirty: boolean
  saveState: SaveState
  saveMessage: string
  onDraftChange: (value: string) => void
  onEdit: () => void
  onCancel: () => void
  onSave: () => void
}

function FileEditor(props: FileEditorProps): JSX.Element {
  const {
    t,
    file,
    fileLoading,
    fileError,
    hasSelection,
    editing,
    draft,
    dirty,
    saveState,
    onDraftChange,
    onEdit,
    onCancel,
    onSave,
  } = props

  const gutterRef = useRef<HTMLDivElement | null>(null)

  // 行号按 \n 计数；编辑态跟 draft 走，只读态跟文件内容走
  const shownText = editing ? draft : (file?.content ?? '')
  const lineCount = useMemo(() => shownText.split('\n').length, [shownText])
  const lineNumbers = useMemo(() => {
    const arr: number[] = []
    for (let i = 1; i <= lineCount; i += 1) arr.push(i)
    return arr
  }, [lineCount])

  // Cmd/Ctrl+S 触发保存
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      onSave()
    }
  }

  let body: ReactNode
  if (fileLoading) {
    body = (
      <div className="sb-editor-empty">
        <IconLoadingOutline16 className="sb-spin" />
        <span>{t('loading.dir')}</span>
      </div>
    )
  } else if (fileError !== null) {
    const msg =
      fileError.kind === 'not.text'
        ? t('not.text')
        : fileError.kind === 'too.large'
          ? t('too.large')
          : t('read.failed', { message: fileError.message })
    body = (
      <div className="sb-editor-empty sb-note--error">
        <IconWarningOutline16 />
        <span>{msg}</span>
      </div>
    )
  } else if (file === null) {
    body = <div className="sb-editor-empty">{hasSelection ? t('no.file') : t('no.file')}</div>
  } else if (editing) {
    body = (
      <div className="sb-editor-edit">
        <div className="sb-gutter sb-gutter--edit" ref={gutterRef} aria-hidden>
          {lineNumbers.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
        <textarea
          className="sb-textarea"
          value={draft}
          spellCheck={false}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onDraftChange(e.target.value)}
          onScroll={(e) => {
            // 行号容器与 textarea 同步纵向滚动
            if (gutterRef.current !== null) {
              gutterRef.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop
            }
          }}
          onKeyDown={handleKeyDown}
        />
      </div>
    )
  } else {
    body = (
      <div className="sb-editor-scroll">
        <div className="sb-gutter" aria-hidden>
          {lineNumbers.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
        <pre className="sb-pre">{file.content}</pre>
      </div>
    )
  }

  return (
    <div className="sb-main">
      <div className="sb-editor-topbar">
        {file !== null ? (
          <>
            <span className="sb-editor-filename">{basename(file.path)}</span>
            <span className="sb-editor-path" title={`${t('path')}: ${file.path}`}>
              {file.path}
            </span>
          </>
        ) : (
          <span className="sb-editor-path">{t('no.file')}</span>
        )}
        <span className="sb-spacer" />
        {file !== null && !editing && (
          <button type="button" className="sb-btn" onClick={onEdit}>
            <IconEditOutline16 />
            {t('edit')}
          </button>
        )}
        {editing && dirty && <span className="sb-dirty-dot" title={t('dirty.hint')} />}
        {editing && (
          <>
            <button
              type="button"
              className="sb-btn sb-btn--primary"
              onClick={onSave}
              disabled={saveState === 'saving' || !dirty}
            >
              <IconCheckOutline16 />
              {saveState === 'saving' ? t('saving') : t('save')}
            </button>
            <button type="button" className="sb-btn sb-btn--ghost" onClick={onCancel}>
              {t('cancel')}
            </button>
          </>
        )}
      </div>
      {body}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 自定义目录管理弹窗
// ---------------------------------------------------------------------------

interface DirsModalProps {
  t: TFn
  dirs: DirInfo[]
  loading: boolean
  error: string | null
  input: string
  mutating: boolean
  onInputChange: (value: string) => void
  onAdd: () => void
  onRemove: (path: string) => void
  onClose: () => void
}

function DirsModal(props: DirsModalProps): JSX.Element {
  const { t, dirs, loading, error, input, mutating, onInputChange, onAdd, onRemove, onClose } = props

  return (
    <div className="sb-modal-overlay" onClick={onClose}>
      <div className="sb-modal sb-modal--dirs" onClick={(e) => e.stopPropagation()}>
        <div className="sb-modal-title">{t('dirs.title')}</div>
        <div className="sb-modal-body">
          <p className="sb-dirs-help">{t('dirs.help')}</p>
          <div className="sb-dirs-addrow">
            <input
              className="sb-dirs-input"
              type="text"
              value={input}
              placeholder={t('dirs.placeholder')}
              spellCheck={false}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && input.trim() !== '' && !mutating) {
                  e.preventDefault()
                  onAdd()
                }
              }}
            />
            <button
              type="button"
              className="sb-btn sb-btn--primary"
              disabled={mutating || input.trim() === ''}
              onClick={onAdd}
            >
              {mutating ? <IconLoadingOutline16 className="sb-spin" /> : null}
              {t('dirs.add')}
            </button>
          </div>
          {error !== null && (
            <div className="sb-action-error">
              <IconWarningOutline16 />
              <span className="sb-action-error-text">{error}</span>
            </div>
          )}
          <div className="sb-dirs-list">
            {loading && (
              <div className="sb-note">
                <IconLoadingOutline16 className="sb-spin" />
                <span>{t('loading.skills')}</span>
              </div>
            )}
            {!loading && dirs.length === 0 && <div className="sb-note">{t('dirs.empty')}</div>}
            {!loading &&
              dirs.map((dir) => (
                <div key={dir.path} className="sb-dirs-row">
                  <span className={`sb-dirs-path${dir.exists ? '' : ' sb-dirs-path--missing'}`} title={dir.path}>
                    {dir.path}
                  </span>
                  {!dir.exists && <span className="sb-badge sb-badge--disabled">{t('dirs.missing')}</span>}
                  {dir.exists && (
                    <span className="sb-count">{t('skills.count', { count: dir.skillCount })}</span>
                  )}
                  <button
                    type="button"
                    className="sb-btn sb-btn--ghost"
                    disabled={mutating}
                    onClick={() => onRemove(dir.path)}
                  >
                    {t('dirs.remove')}
                  </button>
                </div>
              ))}
          </div>
        </div>
        <div className="sb-modal-actions">
          <button type="button" className="sb-btn" onClick={onClose}>
            {t('cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function SkillsBrowser({ t, sessionId }: SkillsBrowserProps): JSX.Element {
  // —— 技能列表 ——
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [roots, setRoots] = useState<string[]>([])
  const [skillsLoading, setSkillsLoading] = useState(true)
  const [skillsError, setSkillsError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [page, setPage] = useState(1)
  const [togglingName, setTogglingName] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [selectedName, setSelectedName] = useState<string | null>(null)

  // —— 自定义目录管理 ——
  const [dirsOpen, setDirsOpen] = useState(false)
  const [dirs, setDirs] = useState<DirInfo[]>([])
  const [dirsLoading, setDirsLoading] = useState(false)
  const [dirsError, setDirsError] = useState<string | null>(null)
  const [dirInput, setDirInput] = useState('')
  const [dirMutating, setDirMutating] = useState(false)

  // —— 目录树 ——
  const [root, setRoot] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [cache, setCache] = useState<Map<string, FsEntry[]>>(new Map())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [dirErrors, setDirErrors] = useState<Map<string, string>>(new Map())

  // —— 文件 / 编辑器 ——
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [file, setFile] = useState<FileState | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState<FileError | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveMessage, setSaveMessage] = useState('')

  // —— 放弃修改确认（自绘 modal）——
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)

  const [refreshing, setRefreshing] = useState(false)

  // —— issue #4：项目技能按当前会话 cwd 扫描 ——
  // 四个 cwd 敏感请求（列表/浏览/读/写）统一携带 sessionId；服务端据此解析
  // 当前会话工作目录（缺省回退首个工作区，与旧版行为一致）。
  // sessionSuffix 带 & 前缀供已有查询参数的接口拼接；列表接口无既有参数，单独组 URL。
  const sessionSuffix = sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''
  const skillsUrl = sessionId ? `${API}/skills?sessionId=${encodeURIComponent(sessionId)}` : `${API}/skills`

  // 请求竞态防护：技能列表 / 文件读取用 AbortController + 序号，目录按路径各持一个
  const skillsAbort = useRef<AbortController | null>(null)
  const fileAbort = useRef<AbortController | null>(null)
  const fileSeq = useRef(0)
  const browseCtrls = useRef(new Map<string, AbortController>())
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restoredRef = useRef(false)

  const dirty = editing && file !== null && draft !== file.content
  const currentSkill = useMemo(
    () => skills.find((s) => s.name === selectedName) ?? null,
    [skills, selectedName],
  )
  // 目录中实际出现的来源（首见顺序）+ 计数，用于筛选 chips
  const sourceCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of skills) map.set(s.source, (map.get(s.source) ?? 0) + 1)
    return [...map.entries()].map(([source, count]) => ({ source, count }))
  }, [skills])

  // 筛选条件变化时回到第一页
  useEffect(() => {
    setPage(1)
  }, [query, sourceFilter, statusFilter])

  /** 有未保存修改时先弹确认，否则直接执行。 */
  const guardDirty = useCallback(
    (action: () => void) => {
      if (dirty) setPendingAction(() => action)
      else action()
    },
    [dirty],
  )

  // —— 技能列表加载 ——
  // silent: 不闪 loading（保留现有列表直到新数据到达），用于局部变更后的平滑刷新；
  // 否则列表瞬间被 loading 占位替换，DOM 清空导致滚动位置丢失（禁用技能后回滚顶部）。
  const loadSkills = useCallback(async (silent = false) => {
    skillsAbort.current?.abort()
    const ctrl = new AbortController()
    skillsAbort.current = ctrl
    if (!silent) setSkillsLoading(true)
    setSkillsError(null)
    try {
      const data = await request<SkillsResponse>(skillsUrl, { signal: ctrl.signal })
      if (skillsAbort.current !== ctrl) return
      setSkills(data.skills)
      setRoots(data.roots)
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      if (skillsAbort.current !== ctrl) return
      setSkillsError(err instanceof Error ? err.message : String(err))
    } finally {
      if (skillsAbort.current === ctrl && !silent) setSkillsLoading(false)
    }
  }, [skillsUrl])

  useEffect(() => {
    void loadSkills()
    return () => {
      skillsAbort.current?.abort()
      fileAbort.current?.abort()
      for (const c of browseCtrls.current.values()) c.abort()
      if (savedTimer.current !== null) clearTimeout(savedTimer.current)
    }
  }, [loadSkills])

  /** 启用/禁用一个技能：调宿主端 API 后重拉列表。 */
  const handleToggleDisabled = useCallback(
    async (skill: SkillSummary) => {
      if (togglingName !== null) return
      setTogglingName(skill.name)
      setActionError(null)
      try {
        const target = skill.disabled ? 'enable' : 'disable'
        await request<ToggleResponse>(`${API}/skills/${target}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: skill.name }),
        })
        // 本地乐观翻转，随后静默刷新与服务端对齐（保持列表与滚动位置不动）
        setSkills((prev) =>
          prev.map((s) => (s.name === skill.name ? { ...s, disabled: !s.disabled } : s)),
        )
        await loadSkills(true)
      } catch (err) {
        setActionError(
          err instanceof Error ? err.message : t('toggle.failed', { message: String(err) }),
        )
      } finally {
        setTogglingName(null)
      }
    },
    [togglingName, loadSkills, t],
  )

  /** 拉取自定义目录列表。 */
  const loadDirs = useCallback(async () => {
    setDirsLoading(true)
    setDirsError(null)
    try {
      const data = await request<DirsResponse>(`${API}/dirs`)
      setDirs(data.dirs)
    } catch (err) {
      setDirsError(err instanceof Error ? err.message : String(err))
    } finally {
      setDirsLoading(false)
    }
  }, [])

  /** 添加自定义目录：成功后刷新目录列表与技能列表（目录变更会改变技能目录）。 */
  const handleAddDir = useCallback(async () => {
    const path = dirInput.trim()
    if (path === '' || dirMutating) return
    setDirMutating(true)
    setDirsError(null)
    try {
      await request<DirMutationResponse>(`${API}/dirs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      setDirInput('')
      await loadDirs()
      await loadSkills(true)
    } catch (err) {
      setDirsError(err instanceof Error ? err.message : String(err))
    } finally {
      setDirMutating(false)
    }
  }, [dirInput, dirMutating, loadDirs, loadSkills])

  /** 移除自定义目录。 */
  const handleRemoveDir = useCallback(
    async (path: string) => {
      if (dirMutating) return
      setDirMutating(true)
      setDirsError(null)
      try {
        await request<DirMutationResponse>(
          `${API}/dirs?path=${encodeURIComponent(path)}`,
          { method: 'DELETE' },
        )
        await loadDirs()
        await loadSkills(true)
      } catch (err) {
        setDirsError(err instanceof Error ? err.message : String(err))
      } finally {
        setDirMutating(false)
      }
    },
    [dirMutating, loadDirs, loadSkills],
  )

  // —— 目录浏览（懒加载 + 内存缓存，key 为绝对路径）——
  const fetchDir = useCallback(async (rootPath: string, absDir: string) => {
    browseCtrls.current.get(absDir)?.abort()
    const ctrl = new AbortController()
    browseCtrls.current.set(absDir, ctrl)
    setLoadingDirs((prev) => new Set(prev).add(absDir))
    setDirErrors((prev) => {
      const next = new Map(prev)
      next.delete(absDir)
      return next
    })
    try {
      const rel = relOf(rootPath, absDir)
      const data = await request<BrowseResponse>(
        `${API}/browse?root=${encodeURIComponent(rootPath)}&path=${encodeURIComponent(rel)}${sessionSuffix}`,
        { signal: ctrl.signal },
      )
      if (browseCtrls.current.get(absDir) !== ctrl) return
      setCache((prev) => new Map(prev).set(absDir, data.entries))
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      if (browseCtrls.current.get(absDir) !== ctrl) return
      setDirErrors((prev) =>
        new Map(prev).set(absDir, err instanceof Error ? err.message : String(err)),
      )
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev)
        next.delete(absDir)
        return next
      })
    }
  }, [sessionSuffix])

  // root 变化后自动拉取根目录
  useEffect(() => {
    if (root !== null && !cache.has(root) && !loadingDirs.has(root)) void fetchDir(root, root)
  }, [root, cache, loadingDirs, fetchDir])

  const handleToggleDir = useCallback(
    (absDir: string) => {
      if (root === null) return
      if (expanded.has(absDir)) {
        setExpanded((prev) => {
          const next = new Set(prev)
          next.delete(absDir)
          return next
        })
      } else {
        setExpanded((prev) => new Set(prev).add(absDir))
        // 展开过的不重复请求
        if (!cache.has(absDir)) void fetchDir(root, absDir)
      }
    },
    [root, expanded, cache, fetchDir],
  )

  const handleRetryDir = useCallback(
    (absDir: string) => {
      if (root !== null) void fetchDir(root, absDir)
    },
    [root, fetchDir],
  )

  // —— 文件读取 ——
  const loadFile = useCallback(async (absPath: string) => {
    fileSeq.current += 1
    const seq = fileSeq.current
    fileAbort.current?.abort()
    const ctrl = new AbortController()
    fileAbort.current = ctrl
    setSelectedPath(absPath)
    setFileLoading(true)
    setFileError(null)
    setSaveState('idle')
    setSaveMessage('')
    try {
      const data = await request<ReadResponse>(`${API}/read?path=${encodeURIComponent(absPath)}${sessionSuffix}`, {
        signal: ctrl.signal,
      })
      if (seq !== fileSeq.current) return
      setFile({ path: data.path, content: data.content, size: data.size, mtime: data.mtime })
      setDraft(data.content)
      setEditing(false)
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      if (seq !== fileSeq.current) return
      const status = err instanceof ApiFailure ? err.status : 0
      const message = err instanceof Error ? err.message : String(err)
      setFile(null)
      setEditing(false)
      setFileError(
        status === 415
          ? { kind: 'not.text', message }
          : status === 413
            ? { kind: 'too.large', message }
            : { kind: 'read.failed', message },
      )
    } finally {
      if (seq === fileSeq.current) setFileLoading(false)
    }
  }, [sessionSuffix])

  const handleFileClick = useCallback(
    (absPath: string) => {
      guardDirty(() => void loadFile(absPath))
    },
    [guardDirty, loadFile],
  )

  // —— 技能 / 根目录切换 ——
  const applySkillSelection = useCallback(
    (skill: SkillSummary, rootOverride?: string | null, expandedInit?: Set<string>) => {
      setSelectedName(skill.name)
      const dirBase = skill.resourceBase?.kind === 'directory' ? skill.resourceBase.path : null
      const nextRoot = rootOverride !== undefined ? rootOverride : dirBase
      setRoot(nextRoot)
      setExpanded(expandedInit ?? new Set())
      // 切换技能后旧缓存的 key（绝对路径）可能仍有效，保守起见清空
      setCache(new Map())
      setDirErrors(new Map())
      setSelectedPath(null)
      setFile(null)
      setFileError(null)
      setEditing(false)
      setSaveState('idle')
    },
    [],
  )

  const handleSelectSkill = useCallback(
    (skill: SkillSummary) => {
      if (skill.name === selectedName) return
      guardDirty(() => applySkillSelection(skill))
    },
    [selectedName, guardDirty, applySkillSelection],
  )

  const handleRootChange = useCallback(
    (nextRoot: string) => {
      if (nextRoot === root) return
      guardDirty(() => {
        setRoot(nextRoot)
        setExpanded(new Set())
        setCache(new Map())
        setDirErrors(new Map())
        setSelectedPath(null)
        setFile(null)
        setFileError(null)
        setEditing(false)
        setSaveState('idle')
      })
    },
    [root, guardDirty],
  )

  // —— 面包屑：root → 当前文件所在目录 ——
  const focusDir = useMemo(() => {
    if (root === null) return null
    if (selectedPath !== null && relOf(root, selectedPath) !== '') {
      return selectedPath.slice(0, selectedPath.lastIndexOf('/'))
    }
    return root
  }, [root, selectedPath])

  const crumbs = useMemo<Crumb[]>(() => {
    if (root === null || focusDir === null) return []
    const list: Crumb[] = [{ label: basename(root), abs: root }]
    const rel = relOf(root, focusDir)
    let cur = root
    for (const part of rel === '' ? [] : rel.split('/')) {
      cur = joinPath(cur, part)
      list.push({ label: part, abs: cur })
    }
    return list
  }, [root, focusDir])

  // 面包屑跳转：展开从 root 到目标目录的全部祖先，让目标可见
  const handleJump = useCallback(
    (absDir: string) => {
      if (root === null) return
      setExpanded((prev) => {
        const next = new Set(prev)
        let cur = absDir
        while (cur !== root && relOf(root, cur) !== '') {
          next.add(cur)
          cur = cur.slice(0, cur.lastIndexOf('/'))
        }
        return next
      })
      // 祖先目录若未缓存则补拉
      let cur = absDir
      while (cur !== root && relOf(root, cur) !== '') {
        if (!cache.has(cur) && !loadingDirs.has(cur)) void fetchDir(root, cur)
        cur = cur.slice(0, cur.lastIndexOf('/'))
      }
    },
    [root, cache, loadingDirs, fetchDir],
  )

  // —— 编辑 / 保存 ——
  const handleEdit = useCallback(() => {
    if (file === null) return
    setDraft(file.content)
    setEditing(true)
    setSaveState('idle')
    setSaveMessage('')
  }, [file])

  const handleCancelEdit = useCallback(() => {
    guardDirty(() => {
      setEditing(false)
      if (file !== null) setDraft(file.content)
      setSaveState('idle')
      setSaveMessage('')
    })
  }, [guardDirty, file])

  const handleSave = useCallback(async () => {
    if (file === null || saveState === 'saving' || !dirty) return
    setSaveState('saving')
    setSaveMessage('')
    try {
      const data = await request<WriteResponse>(
        `${API}/write?path=${encodeURIComponent(file.path)}${sessionSuffix}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: draft,
        },
      )
      setFile({ path: data.path, content: draft, size: data.size, mtime: data.mtime })
      setSaveState('saved')
      // 成功提示短暂显示后消退
      if (savedTimer.current !== null) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaveState('idle'), 2500)
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setSaveState('error')
      setSaveMessage(err instanceof Error ? err.message : String(err))
    }
  }, [file, draft, dirty, saveState, sessionSuffix])

  // —— 全局刷新：清空树缓存 + 重拉技能列表 + 重拉已展开目录与当前文件 ——
  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    setCache(new Map())
    setDirErrors(new Map())
    await loadSkills()
    if (root !== null) {
      void fetchDir(root, root)
      for (const dir of expanded) {
        if (dir !== root && relOf(root, dir) !== '') void fetchDir(root, dir)
      }
    }
    if (selectedPath !== null && !editing) void loadFile(selectedPath)
    setRefreshing(false)
  }, [loadSkills, root, expanded, selectedPath, editing, fetchDir, loadFile])

  // —— 状态持久化：首次恢复完成后才开始写 localStorage ——
  useEffect(() => {
    if (restoredRef.current || skills.length === 0) return
    restoredRef.current = true
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw === null) return
      const saved = JSON.parse(raw) as Partial<PersistedState>
      if (typeof saved.skill !== 'string') return
      const skill = skills.find((s) => s.name === saved.skill)
      if (skill === undefined) return
      const dirBase = skill.resourceBase?.kind === 'directory' ? skill.resourceBase.path : null
      const savedRoot = typeof saved.root === 'string' ? saved.root : dirBase
      applySkillSelection(
        skill,
        savedRoot,
        new Set(Array.isArray(saved.expanded) ? saved.expanded : []),
      )
      if (savedRoot !== null && typeof saved.file === 'string') void loadFile(saved.file)
    } catch {
      // 持久化数据损坏时静默忽略
    }
  }, [skills, applySkillSelection, loadFile])

  useEffect(() => {
    if (!restoredRef.current) return
    const state: PersistedState = {
      skill: selectedName,
      root,
      expanded: [...expanded],
      file: selectedPath,
    }
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state))
    } catch {
      // 存储不可用时静默忽略
    }
  }, [selectedName, root, expanded, selectedPath])

  // 根目录下拉选项：当前 root 优先，其余来自 API 的 roots（原样使用，已规范化）
  const rootOptions = useMemo(() => {
    const list: string[] = []
    if (root !== null) list.push(root)
    for (const r of roots) if (!list.includes(r)) list.push(r)
    return list
  }, [root, roots])

  // 设置弹窗分区布局：左栏（搜索/刷新工具条 + 技能列表 45% + 目录树 55%），右栏编辑器
  return (
    <div className="sb-root">
      <div className="sb-body">
        <div className="sb-side">
          <div className="sb-side-toolbar">
            <div className="sb-search">
              <IconSearchOutline16 className="sb-search-icon" />
              <input
                className="sb-search-input"
                type="text"
                value={query}
                placeholder={t('search.placeholder')}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
              />
              {query !== '' && (
                <button
                  type="button"
                  className="sb-search-clear"
                  onClick={() => setQuery('')}
                  aria-label={t('cancel')}
                >
                  <IconCloseOutline16 />
                </button>
              )}
            </div>
            <button
              type="button"
              className="sb-icon-btn"
              onClick={() => {
                setDirsOpen(true)
                setDirsError(null)
                void loadDirs()
              }}
              title={t('manage.dirs')}
            >
              <IconFolderOpen16 />
            </button>
            <button
              type="button"
              className="sb-icon-btn"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
              title={t('refresh')}
            >
              {refreshing ? <IconLoadingOutline16 className="sb-spin" /> : <IconRefreshOutline16 />}
            </button>
          </div>
          <SkillList
            t={t}
            skills={skills}
            loading={skillsLoading}
            error={skillsError}
            query={query}
            sourceFilter={sourceFilter}
            sourceCounts={sourceCounts}
            statusFilter={statusFilter}
            selectedName={selectedName}
            togglingName={togglingName}
            page={page}
            onSourceFilter={setSourceFilter}
            onStatusFilter={setStatusFilter}
            onToggleDisabled={(skill) => void handleToggleDisabled(skill)}
            onSelect={handleSelectSkill}
            onRetry={() => void loadSkills()}
            onPrevPage={() => setPage((p) => Math.max(1, p - 1))}
            onNextPage={() => setPage((p) => p + 1)}
          />
          {actionError !== null && (
            <div className="sb-action-error">
              <IconWarningOutline16 />
              <span className="sb-action-error-text">{actionError}</span>
              <button
                type="button"
                className="sb-btn sb-btn--ghost"
                onClick={() => setActionError(null)}
              >
                <IconCloseOutline16 />
              </button>
            </div>
          )}
          <FileTree
            t={t}
            hasSkill={currentSkill !== null}
            root={root}
            rootOptions={rootOptions}
            cache={cache}
            loadingDirs={loadingDirs}
            dirErrors={dirErrors}
            expanded={expanded}
            selectedPath={selectedPath}
            crumbs={crumbs}
            onRootChange={handleRootChange}
            onJump={handleJump}
            onToggleDir={handleToggleDir}
            onFileClick={handleFileClick}
            onRetryDir={handleRetryDir}
          />
        </div>
        {/* 编辑器按需出现：未选中文件时不占用空间，左栏占满 */}
        {(file !== null || fileLoading || fileError !== null) && (
          <FileEditor
            t={t}
            skillName={selectedName}
            file={file}
            fileLoading={fileLoading}
            fileError={fileError}
            hasSelection={selectedPath !== null}
            editing={editing}
            draft={draft}
            dirty={dirty}
            saveState={saveState}
            saveMessage={saveMessage}
            onDraftChange={setDraft}
            onEdit={handleEdit}
            onCancel={handleCancelEdit}
            onSave={() => void handleSave()}
          />
        )}
      </div>
      {/* 面板级状态条：常驻底部，编辑器隐藏时也显示当前技能/文件/保存状态 */}
      <div className="sb-statusbar sb-statusbar--panel">
        <span className="sb-status-item">
          {t('status.skill')}: {selectedName ?? '-'}
        </span>
        <span className="sb-status-item">
          {t('status.file')}: {file !== null ? basename(file.path) : '-'}
        </span>
        <span className="sb-spacer" />
        {saveState === 'error' && (
          <span className="sb-status-item sb-status--error">
            {t('write.failed', { message: saveMessage })}
          </span>
        )}
        {dirty && <span className="sb-status-item sb-status--dirty">{t('status.unsaved')}</span>}
        {saveState === 'saved' && !dirty && (
          <span className="sb-status-item sb-status--saved">{t('status.saved')}</span>
        )}
        {file !== null && <span className="sb-status-item">{formatSize(t, file.size)}</span>}
        {file !== null && (
          <span className="sb-status-item">{t('mtime.label', { time: formatTime(file.mtime) })}</span>
        )}
      </div>
      {dirsOpen && (
        <DirsModal
          t={t}
          dirs={dirs}
          loading={dirsLoading}
          error={dirsError}
          input={dirInput}
          mutating={dirMutating}
          onInputChange={setDirInput}
          onAdd={() => void handleAddDir()}
          onRemove={(path) => void handleRemoveDir(path)}
          onClose={() => setDirsOpen(false)}
        />
      )}
      {pendingAction !== null && (
        <div className="sb-modal-overlay" onClick={() => setPendingAction(null)}>
          <div className="sb-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sb-modal-title">{t('confirm.discard.title')}</div>
            <div className="sb-modal-body">
              {t('confirm.discard.body', { name: file !== null ? basename(file.path) : '' })}
            </div>
            <div className="sb-modal-actions">
              <button
                type="button"
                className="sb-btn sb-btn--ghost"
                onClick={() => setPendingAction(null)}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                className="sb-btn sb-btn--danger"
                onClick={() => {
                  const action = pendingAction
                  setPendingAction(null)
                  action()
                }}
              >
                {t('confirm.discard.ok')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
