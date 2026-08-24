/**
 * dsh-memory-evolve — todo store and `dtodo` tool (four tracks).
 *
 * Todo lives in the same §-delimited MD format as the memory tracks, with a
 * machine-readable tag line per entry:
 *
 *   [2026-08-06 21:30] [id: a1b2c3d4] [q1] [due: 2026-08-10] [status: doing] [cat: 生活]
 *   陪妈妈去医院复查
 *   记得带上检查报告
 *
 * The file starts with an HTML comment block explaining the tag grammar
 * (humans and models reading the file directly can decode it; the parser
 * strips it before splitting entries). Tracks:
 *
 *   life     TODOS-life.md            personal life
 *   work     TODOS-work.md            cross-project work
 *   project  projects/<hash>/TODOS.md per working directory (cwd-isolated)
 *   daily    daily/YYYY-MM-DD.todo.md per day (separate from the daily log)
 *
 * Writes are atomic and lock-protected like the memory store. Status changes
 * rewrite the entry's tag line; `done` stamps `[done: …]` automatically.
 *
 * The `dtodo` tool mirrors the memory tool's shape. The default `list` view
 * is deliberately narrow (hard filter, not a prompt wish): overdue + due
 * today + current project's unfinished + global Q1/Q2 unfinished, at most 8
 * entries — the model can only "read the right todos", never the whole
 * backlog, unless it asks for the full list explicitly.
 *
 * Zero runtime dependencies.
 *
 * @module dsh-memory-evolve/todo
 */

import { randomBytes } from 'node:crypto'
import { translate, getLocale, TODO_DICT, TODO_MSG_DICT } from './i18n.js'

/** Translate through the TODO_DICT dictionary in the active locale. */
const tt = (key, params) => translate(TODO_DICT, key, params)
/** Translate through TODO_MSG_DICT in the active host locale. */
const tmt = (key, params) => translate(TODO_MSG_DICT, key, params, getLocale())
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ENTRY_DELIMITER, projectHash, scanThreat, serializeEntries, todayStamp, withLock } from './store.js'

/** The four todo tracks. */
export const TODO_TARGETS = ['life', 'work', 'project', 'daily']

/** Valid todo statuses (default: pending). */
export const TODO_STATUSES = ['pending', 'doing', 'done', 'blocked', 'cancelled']

/** Archive track name for todo suggestions (single shared archive file). */
export const TODO_ARCHIVE_TARGET = 'todo-archive'

/** Default max entries of the smart list view. */
export const DEFAULT_VIEW_LIMIT = 8

/**
 * File-header format note. Kept stable so humans / models / editors opening
 * the file directly can decode the tag grammar; the parser strips it before
 * splitting entries.
 */
export const TODO_HEADER = `<!--
待办条目格式说明（程序自动维护，请勿手改结构）：
- 条目以 § 分隔；第一条 § 之前的本注释块是格式说明，不是待办
- 每条待办的首行是元数据 tag（顺序固定，可缺省的部分省略）：
  [创建时间] 程序自动盖戳（如 [2026-08-06 21:30]）
  [id: 8位十六进制] 条目的唯一标识，dtodo 工具按它操作
  [q1] 重要且紧急  [q2] 重要不紧急  [q3] 紧急不重要  [q4] 不重要不紧急（缺省=未分类）
  [due: YYYY-MM-DD] 截止日期（缺省=不限）
  [status: pending|doing|done|blocked|cancelled] 状态（缺省 pending）
  [done: YYYY-MM-DD HH:MM] 完成时间（程序盖戳，仅 done 状态）
  [cat: 分类] 可选（生活/工作/学习…）
- 首行 tag 之后是待办内容，可多行
-->
`

// ---------------------------------------------------------------------------
// Entry tag grammar
// ---------------------------------------------------------------------------

/** 条目首行时间戳（创建时间，程序盖戳）。 */
const TIME_RE = /^\[(\d{4}-\d{2}-\d{2}(?:\s\d{2}:\d{2})?)\]\s*/
/** 唯一 id（8 位 hex）。 */
const ID_RE = /\[id:\s*([0-9a-f]{8})\]/i
/** 四象限：q1 重要紧急 / q2 重要不紧急 / q3 紧急不重要 / q4 不重要不紧急。 */
const QUAD_RE = /\[q([1-4])\]/i
/** 截止日期。 */
const DUE_RE = /\[due:\s*(\d{4}-\d{2}-\d{2})\]/i
/** 状态。 */
const STATUS_RE = /\[status:\s*(pending|doing|done|blocked|cancelled)\]/i
/** 完成时间（程序盖戳）。 */
const DONE_RE = /\[done:\s*(\d{4}-\d{2}-\d{2}(?:\s\d{2}:\d{2})?)\]/i
/** 分类。 */
const CAT_RE = /\[cat:\s*([^\]]+)\]/i

/** 当前时间戳 `YYYY-MM-DD HH:MM`（本地时间）。 */
function nowStamp() {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${todayStamp()} ${hh}:${mm}`
}

/** 8-hex random id. */
function newId() {
  return randomBytes(4).toString('hex')
}

/**
 * Parse one raw todo entry into its structured form. The first line is the
 * tag line (time stamp + tags); the rest is the todo's text (may be empty).
 * @param {string} raw - one §-separated entry (trimmed).
 * @returns {object | null} the parsed item, or null when it has no id/tag line.
 */
export function parseTodoEntry(raw) {
  const first = raw.split('\n', 1)[0]
  const time = TIME_RE.exec(first)
  if (time === null) return null
  const idMatch = ID_RE.exec(first)
  const quadMatch = QUAD_RE.exec(first)
  const dueMatch = DUE_RE.exec(first)
  const statusMatch = STATUS_RE.exec(first)
  const doneMatch = DONE_RE.exec(first)
  const catMatch = CAT_RE.exec(first)
  const text = raw.slice(first.length).trim()
  return {
    id: idMatch?.[1] ?? null,
    time: time[1],
    quadrant: quadMatch?.[1] ? `q${quadMatch[1]}` : null,
    due: dueMatch?.[1] ?? null,
    status: statusMatch?.[1] ?? 'pending',
    doneAt: doneMatch?.[1] ?? null,
    cat: catMatch?.[1]?.trim() || null,
    text,
    raw,
  }
}

/**
 * Build one entry's tag line + content.
 * @param {object} meta - { time, id, quadrant, due, status, cat, doneAt }.
 * @param {string} content - the todo text.
 * @returns {string} the full entry.
 */
export function stampTodoLine(meta, content) {
  const parts = [`[${meta.time}]`, `[id: ${meta.id}]`]
  if (meta.quadrant) parts.push(`[${meta.quadrant}]`)
  if (meta.due) parts.push(`[due: ${meta.due}]`)
  parts.push(`[status: ${meta.status ?? 'pending'}]`)
  if (meta.cat) parts.push(`[cat: ${meta.cat}]`)
  if (meta.doneAt) parts.push(`[done: ${meta.doneAt}]`)
  return `${parts.join(' ')}\n${String(content).trim()}`
}

// ---------------------------------------------------------------------------
// TodoStore
// ---------------------------------------------------------------------------

/**
 * The todo store: four MD files (life / work / project / daily) with the
 * §-delimited entry format and the header note. All mutations are atomic
 * (tmp + rename) under the directory lock.
 */
export class TodoStore {
  /**
   * @param {string} dir - the memory directory.
   * @param {(cwd: string) => string} [projectDirResolver] - 项目记忆目录解析器
   *   （sync 已初始化的项目 → projectId 目录；未启用项目 → projectHash 目录）。
   *   与 MemoryStore 同一注入：记忆同步迁移后项目待办必须与新目录一致，
   *   否则 TODOS.md 会落在旧目录、进不了 sync 仓库（2026-08-11 统一模式）。
   */
  constructor(dir, projectDirResolver = null) {
    this.dir = dir
    this.projectDirResolver = projectDirResolver
  }

  /** Resolve one track's file path; project requires the cwd, daily honors `date`. */
  fileOf(target, cwd, date) {
    switch (target) {
      case 'life':
        return join(this.dir, 'TODOS-life.md')
      case 'work':
        return join(this.dir, 'TODOS-work.md')
      case 'daily':
        return join(this.dir, 'daily', `${date ?? todayStamp()}.todo.md`)
      case 'project': {
        if (!cwd) throw new Error('dsh-memory-evolve: project todo 需要会话工作目录')
        // 已注入 resolver（记忆同步装配）→ 项目待办跟随记忆目录（projectId）；
        // 否则维持旧路径（projectHash）——未启用同步的项目零变化
        if (this.projectDirResolver) return join(this.projectDirResolver(cwd), 'TODOS.md')
        return join(this.dir, 'projects', projectHash(cwd), 'TODOS.md')
      }
      default:
        throw new Error(`dsh-memory-evolve: 无效的待办轨 "${target}"`)
    }
  }

  /** Read one track's raw text; a missing file reads as the header only. */
  readText(target, cwd, date) {
    try {
      return readFileSync(this.fileOf(target, cwd, date), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return ''
      throw error
    }
  }

  /** Parse one track's raw text into items (header comment stripped). */
  parseAll(text) {
    // 剥离文件头注释块后，残留的开头 `§` 分隔符一并去掉
    const body = text
      .replace(/^<!--[\s\S]*?-->\s*/, '')
      .replace(/^\s*§\s*\n?/, '')
      .trim()
    if (body === '') return []
    return body
      .split(ENTRY_DELIMITER)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => parseTodoEntry(entry))
      .filter((item) => item !== null)
  }

  /** All items of one track (daily: the `date` file, default today). */
  itemsOf(target, cwd, date) {
    const items = this.parseAll(this.readText(target, cwd, date))
    // daily 条目附带所属日期（今天或指定日期），供过往查询/写回定位文件
    if (target === 'daily') {
      const day = date ?? todayStamp()
      for (const item of items) item.day = day
    }
    return items
  }

  /**
   * All past daily items: every daily todo file strictly before `today`
   * (newest day first), each item tagged with its `day`. Read sequentially —
   * history is only loaded on explicit request (see `past`), so a two-year
   * backlog (~700 small files) stays a tens-of-ms one-off read.
   * @param {string | undefined} today - today's date (defaults to now).
   * @returns {object[]} past daily items with `day` set.
   */
  pastItemsOf(today = todayStamp()) {
    let names = []
    try {
      names = readdirSync(join(this.dir, 'daily'))
    } catch {
      return []
    }
    const days = names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.todo\.md$/.test(name))
      .map((name) => name.slice(0, 10))
      .filter((day) => day < today)
      .sort()
      .reverse()
    const all = []
    for (const day of days) {
      all.push(...this.itemsOf('daily', undefined, day))
    }
    return all
  }

  /** Atomically write one track's items (header + entries). */
  write(target, cwd, items, date) {
    const path = this.fileOf(target, cwd, date)
    const dir = dirname(path)
    mkdirSync(dir, { recursive: true })
    const body = items.map((item) => item.raw).join(ENTRY_DELIMITER)
    const text = `${TODO_HEADER}${body.length > 0 ? `\n§\n${body}\n` : ''}`
    const tmp = `${path}.tmp.${process.pid}`
    writeFileSync(tmp, text)
    renameSync(tmp, path)
  }

  /**
   * Add one todo. User-spoken todos are written directly (the user is the
   * confirmer); model-authored ones go through the suggestion queue instead.
   * @param {string} target - 'life' | 'work' | 'project' | 'daily'.
   * @param {string} content - the todo text.
   * @param {object} meta - { quadrant?, due?, cat? }.
   * @param {string | undefined} cwd - required for 'project'.
   * @returns {{ok: boolean, message: string, id?: string, target: string}}
   */
  addTodo(target, content, meta = {}, cwd) {
    const text = String(content ?? '').trim()
    if (!text) return { ok: false, message: tmt('todomsg.emptyContent'), target }
    const threat = scanThreat(text)
    if (threat) return { ok: false, message: threat, target }
    const id = newId()
    const item = {
      raw: stampTodoLine({
        time: nowStamp(),
        id,
        quadrant: meta.quadrant ?? null,
        due: meta.due ?? null,
        status: 'pending',
        cat: meta.cat ?? null,
        doneAt: null,
      }, text),
    }
    return withLock(dirname(this.fileOf(target, cwd ?? undefined)), () => {
      const items = this.itemsOf(target, cwd)
      items.push(item)
      this.write(target, cwd, items)
      return { ok: true, message: tmt('todomsg.added', { target, count: items.length }), id, target }
    })
  }

  /**
   * Locate one item by id inside one track (or every track when target is
   * undefined). Returns the track, the item and the full item list. For the
   * daily track without an explicit `date`, today + every past day's file is
   * scanned and the match carries its `day` (for writing back the right file).
   * @returns {{target: string, item: object, items: object[], day?: string} | null}
   */
  findById(target, id, cwd, date) {
    const targets = target !== undefined ? [target] : TODO_TARGETS
    for (const t of targets) {
      let items
      try {
        if (t === 'daily' && date === undefined) {
          items = [...this.itemsOf('daily', cwd), ...this.pastItemsOf()]
        } else {
          items = this.itemsOf(t, cwd, date)
        }
      } catch {
        continue
      }
      const item = items.find((entry) => entry.id === id)
      if (item !== undefined) return { target: t, item, items, day: item.day }
    }
    return null
  }

  /**
   * Update one todo by id: status / quadrant / due / cat / content.
   * `status: done` stamps the done time; leaving `done` clears it.
   * @returns {{ok: boolean, message: string, target: string}}
   */
  updateTodo(target, id, patch = {}, cwd, date) {
    const found = this.findById(target, id, cwd, date)
    if (found === null) {
      return { ok: false, message: target ? tmt('todomsg.notFoundTrack', { id, target }) : tmt('todomsg.notFound', { id }), target: target ?? '?' }
    }
    const { target: t, item, day } = found
    const meta = parseTodoEntry(item.raw)
    const nextStatus = patch.status ?? meta.status
    const doneAt = nextStatus === 'done' ? (meta.doneAt ?? nowStamp()) : null
    const raw = stampTodoLine({
      time: meta.time,
      id: meta.id,
      quadrant: patch.quadrant !== undefined ? patch.quadrant : meta.quadrant,
      due: patch.due !== undefined ? patch.due : meta.due,
      status: nextStatus,
      cat: patch.cat !== undefined ? patch.cat : meta.cat,
      doneAt,
    }, patch.content !== undefined ? patch.content : meta.text)
    return withLock(dirname(this.fileOf(t, cwd, day)), () => {
      const current = this.itemsOf(t, cwd, day)
      const index = current.findIndex((entry) => entry.id === id)
      if (index === -1) return { ok: false, message: tmt('todomsg.gone'), target: t }
      const next = [...current]
      next[index] = { raw }
      this.write(t, cwd, next, day)
      return { ok: true, message: tmt('todomsg.updated', { target: t }), target: t }
    })
  }

  /** Mark one todo done (stamps the done time). */
  doneTodo(target, id, cwd, date) {
    return this.updateTodo(target, id, { status: 'done' }, cwd, date)
  }

  /** Remove one todo by id (exact). */
  removeTodo(target, id, cwd, date) {
    const found = this.findById(target, id, cwd, date)
    if (found === null) {
      return { ok: false, message: tmt('todomsg.notFound', { id }), target: target ?? '?' }
    }
    const { target: t, day } = found
    return withLock(dirname(this.fileOf(t, cwd, day)), () => {
      const current = this.itemsOf(t, cwd, day)
      const next = current.filter((entry) => entry.id !== id)
      if (next.length === current.length) {
        return { ok: false, message: tmt('todomsg.gone'), target: t }
      }
      this.write(t, cwd, next, day)
      return { ok: true, message: tmt('todomsg.deleted', { target: t }), target: t }
    })
  }

  /**
   * List todos across the given tracks with filters. Without `all`, returns
   * the smart default view: overdue + due today + the current project's
   * unfinished + global Q1/Q2 unfinished (daily: today's unfinished),
   * sorted overdue > today > Q1 > Q2 > Q3/Q4/none, capped at 8.
   *
   * `past: true` also reads every daily file before today (each item tagged
   * `day` + `past`). Past daily items are by default filtered out when they
   * are "expired" — unfinished entries whose due date (or the file's day,
   * when no due tag) is already behind — so history stays out of the way
   * unless explicitly requested; `expired: true` includes them.
   * @param {string[]} targets - tracks to scan.
   * @param {object} options - { status?, quadrant?, due?, cat?, date?, all?, past?, expired? }.
   * @param {string | undefined} cwd - the session cwd (project track).
   * @param {string | undefined} today - today's date (defaults to now).
   * @returns {{items: object[], total: number, truncated: boolean, defaultView: boolean}}
   */
  listTodos(targets, options = {}, cwd, today = todayStamp()) {
    const done = (item) => item.status === 'done' || item.status === 'cancelled'
    const isOverdue = (item) => item.due !== null && item.due < today && !done(item)
    const isToday = (item) => item.due === today && !done(item)
    const isPast = (item) => item.past === true
    // 过往 daily 条目的"已过期"：未完成，且（无 due 时按文件日期）已落后于今天
    const isPastExpired = (item) => {
      if (!isPast(item) || done(item)) return false
      if (item.due === null) return true
      return item.due < today
    }
    const wantStatus = (item) => {
      if (options.status === undefined || options.status === 'all') return true
      return item.status === options.status
    }
    const wantQuadrant = (item) => {
      if (options.quadrant === undefined || options.quadrant === 'all') return true
      return item.quadrant === options.quadrant
    }
    const wantDue = (item) => {
      if (options.due === undefined || options.due === 'all') return true
      if (options.due === 'overdue') return isOverdue(item)
      if (options.due === 'today') return isToday(item) || isOverdue(item)
      return true
    }
    const wantCat = (item) => {
      if (options.cat === undefined) return true
      return item.cat !== null && item.cat.toLowerCase().includes(String(options.cat).toLowerCase())
    }

    const all = []
    const seen = new Set()
    for (const target of targets) {
      let items
      try {
        items = this.itemsOf(target, cwd, options.date)
      } catch {
        continue
      }
      for (const item of items) {
        // Daily track: only the requested date's file is read (date option
        // selects the file); life/work/project always included.
        if (!wantStatus(item) || !wantQuadrant(item) || !wantDue(item) || !wantCat(item)) continue
        if (seen.has(item.id)) continue
        seen.add(item.id)
        all.push({ ...item, target })
      }
    }
    // 过往每日待办：today 之前的所有 daily 文件；默认过滤"已过期"遗留
    if (options.past === true && targets.includes('daily')) {
      for (const item of this.pastItemsOf(today)) {
        if (!wantStatus(item) || !wantQuadrant(item) || !wantDue(item) || !wantCat(item)) continue
        if (seen.has(item.id)) continue
        seen.add(item.id)
        const marked = { ...item, target: 'daily', past: true }
        if (options.expired !== true && isPastExpired(marked)) continue
        all.push(marked)
      }
    }

    const defaultView = options.all !== true && options.past !== true && options.status === undefined
      && options.quadrant === undefined && options.due === undefined
    let selected = all
    if (defaultView) {
      selected = all.filter((item) => {
        if (done(item)) return false
        if (isOverdue(item) || isToday(item)) return true
        if (item.target === 'project' && cwd) return true
        if ((item.target === 'life' || item.target === 'work') && (item.quadrant === 'q1' || item.quadrant === 'q2')) return true
        if (item.target === 'daily') return true // today's daily unfinished
        return false
      })
    }
    // 普通条目：overdue > today > q1 > q2 > q3 > q4 > none；过往条目统一排最后
    // （按日期倒序、组内时间倒序）。再按 due 然后 time 稳定排序。
    const rank = (item) => (isPast(item) ? 9 : isOverdue(item) ? 0 : isToday(item) ? 1 : item.quadrant === 'q1' ? 2 : item.quadrant === 'q2' ? 3 : item.quadrant === 'q3' ? 4 : item.quadrant === 'q4' ? 5 : 6)
    selected.sort((a, b) => {
      const ra = rank(a)
      const rb = rank(b)
      if (ra !== rb) return ra - rb
      if (isPast(a) && isPast(b)) {
        const d = String(b.day).localeCompare(String(a.day))
        if (d !== 0) return d
        return String(b.time).localeCompare(String(a.time))
      }
      const d = String(a.due ?? '').localeCompare(String(b.due ?? ''))
      if (d !== 0) return d
      return String(a.time).localeCompare(String(b.time))
    })
    // 用户拍板（2026-08-09）：本项目待办列表（单轨 project 查询）显示反转——
    // 最新添加的条目排在最前面（原排序按 due/time 正序，旧条目在前）。
    // 仅单轨 project 生效：混合查询（默认四轨）与其他轨保持原有排序语义不变；
    // 副作用：反转后 overdue 优先级沉底（收尾 dtodo list 检查仍有到期提醒兜底）。
    if (targets.length === 1 && targets[0] === 'project') {
      selected.reverse()
    }
    // past=true 是显式查询历史：不截断，与 all=true 一致
    const explicit = options.all === true || options.past === true
    const truncated = !explicit && selected.length > DEFAULT_VIEW_LIMIT
    // 防御性提示：只查过往却漏了 expired —— 每日待办截止=当天，未完成的过往
    // 默认被隐藏，模型可能以为"昨天没有待办"；输出里直接点明补救参数。
    const hint = options.past === true && options.expired !== true
      ? '提示：过往每日待办未完成的过期遗留默认隐藏，若需查看请再调一次 list 加 expired=true'
      : null
    return {
      items: explicit ? selected : selected.slice(0, DEFAULT_VIEW_LIMIT),
      total: selected.length,
      truncated,
      defaultView,
      hint,
    }
  }

  /**
   * Format a list result into the model-facing text (short, self-describing
   * tag semantics so every list call re-explains the grammar).
   */
  formatList(result, today = todayStamp()) {
    const { items, total, truncated, defaultView } = result
    if (items.length === 0) {
      const hint = result.hint ? `\n${result.hint}` : ''
      return defaultView
        ? `待办（默认视图）：没有需要关注的未完成待办（逾期/今日到期/当前项目/重要紧急），全部清空 🎉${hint}`
        : `待办：没有匹配的条目${hint}`
    }
    const head = defaultView
      ? `待办（默认视图：逾期/今日到期/当前项目未完成/重要紧急，最多 ${DEFAULT_VIEW_LIMIT} 条）`
      : `待办（${total} 条${truncated ? `，仅显示前 ${DEFAULT_VIEW_LIMIT} 条` : ''}）`
    const lines = items.map((item) => {
      const tags = [`[${item.target}]`]
      if (item.past === true) tags.push(`[过往 ${item.day}]`)
      if (item.quadrant) tags.push(`[${item.quadrant}]`)
      if (item.due !== null) tags.push(item.due < today ? `[逾期 ${item.due}]` : `[${item.due}]`)
      if (item.status !== 'pending') tags.push(`[${item.status}]`)
      if (item.cat) tags.push(`[${item.cat}]`)
      const text = item.text.split('\n')[0]
      return `- ${tags.join(' ')} ${text}（id: ${item.id}）`
    })
    const hint = result.hint ? `\n${result.hint}` : ''
    return `${head}\n${lines.join('\n')}\ntag 语义：q1-q4=四象限（重要×紧急）；due=截止；status=状态；操作按 id（dtodo done/update/remove <id>，可带 target=）。${hint}`
  }
}

// ---------------------------------------------------------------------------
// dtodo tool
// ---------------------------------------------------------------------------

/** Resolve the quadrant from direct value or important/urgent booleans. */
function resolveQuadrant(args) {
  if (typeof args.quadrant === 'string' && /^q[1-4]$/.test(args.quadrant)) return args.quadrant
  const important = args.important === true
  const urgent = args.urgent === true
  if (important && urgent) return 'q1'
  if (important && !urgent) return 'q2'
  if (!important && urgent) return 'q3'
  return null
}

/**
 * Build the `dtodo` tool definition.
 * @param {object} config - resolved plugin config (tool name).
 * @param {import('./todo.js').TodoStore} todoStore - the todo store.
 * @param {() => boolean} [isTodoEnabled] - live todo-capability switch
 *   (default always enabled). Tool schemas may have been emitted before a
 *   runtime switch, so the execute-time guard refuses writes once the
 *   capability is off.
 * @returns {object} a tool definition for ctx.tools.register.
 */
export function todoToolDefinition(config, todoStore, isTodoEnabled = () => true) {
  return {
    name: config.todoToolName,
    get description() { return tt('todo.desc') },
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'list', 'done', 'update', 'remove'],
          get description() { return tt('todo.action') },
        },
        target: {
          type: 'string',
          enum: TODO_TARGETS,
          get description() { return tt('todo.target') },
        },
        content: { type: 'string', get description() { return tt('todo.content') } },
        important: { type: 'boolean', get description() { return tt('todo.important') } },
        urgent: { type: 'boolean', get description() { return tt('todo.urgent') } },
        quadrant: { type: 'string', enum: ['q1', 'q2', 'q3', 'q4'], get description() { return tt('todo.quadrant') } },
        due: { type: 'string', get description() { return tt('todo.due') } },
        cat: { type: 'string', get description() { return tt('todo.cat') } },
        status: { type: 'string', enum: ['pending', 'done'], get description() { return tt('todo.status') } },
        id: { type: 'string', get description() { return tt('todo.id') } },
        date: { type: 'string', get description() { return tt('todo.date') } },
        all: { type: 'boolean', get description() { return tt('todo.all') } },
        past: { type: 'boolean', get description() { return tt('todo.past') } },
        expired: { type: 'boolean', get description() { return tt('todo.expired') } },
        cwd: { type: 'string', get description() { return tt('todo.cwd') } },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'string', description: '机器可判定的失败码（待办功能关闭时为 TODO_DISABLED）' },
          message: { type: 'string' },
          target: { type: 'string' },
          id: { type: 'string', description: 'add 成功时返回新条目的 id（后续 done/update/remove 用）' },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: value.message ?? '' }],
    },
    async execute(args, exec) {
      // 工具 schema 可能在开关切换前就已生成，这里做执行期守卫：待办能力
      // 关闭后，任何已捕获的调用都不能继续写入。
      if (!isTodoEnabled()) {
        return { ok: false, code: 'TODO_DISABLED', message: '待办功能未启用' }
      }
      const action = args.action
      const cwd = exec?.agent?.session?.header?.cwd ?? undefined
      const dateArg = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
      if (action === 'add') {
        const target = args.target ?? (cwd ? 'project' : 'work')
        if (!TODO_TARGETS.includes(target)) {
          return { ok: false, message: tmt('todomsg.invalidTarget', { target, valid: TODO_TARGETS.join('/') }), target }
        }
        const due = typeof args.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.due) ? args.due : undefined
        const cat = typeof args.cat === 'string' && args.cat.trim() !== '' ? args.cat.trim() : undefined
        const quadrant = resolveQuadrant(args)
        const outcome = todoStore.addTodo(target, String(args.content ?? ''), { quadrant, due, cat }, cwd)
        return { ok: outcome.ok, message: outcome.message, target: outcome.target, id: outcome.id }
      }
      if (action === 'list') {
        const targets = args.target !== undefined ? [args.target] : TODO_TARGETS
        const date = typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : undefined
        // 跨项目查询：cwd 参数显式指定项目工作目录（缺省=当前会话目录）
        const projectCwd = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd.trim() : cwd
        const result = todoStore.listTodos(targets, {
          status: args.status,
          quadrant: args.quadrant,
          due: args.due,
          cat: args.cat,
          all: args.all === true,
          past: args.past === true,
          expired: args.expired === true,
          date,
        }, projectCwd, date ?? undefined)
        if (date !== undefined) result.date = date
        return { ok: true, message: todoStore.formatList(result, date ?? undefined) }
      }
      if (action === 'done') {
        const outcome = todoStore.doneTodo(args.target, String(args.id ?? ''), cwd, dateArg(args.date))
        return { ok: outcome.ok, message: outcome.message, target: outcome.target }
      }
      if (action === 'remove') {
        const outcome = todoStore.removeTodo(args.target, String(args.id ?? ''), cwd, dateArg(args.date))
        return { ok: outcome.ok, message: outcome.message, target: outcome.target }
      }
      if (action === 'update') {
        const patch = {}
        if (args.status !== undefined) patch.status = args.status
        if (args.quadrant !== undefined) patch.quadrant = /^q[1-4]$/.test(args.quadrant) ? args.quadrant : undefined
        if (args.due !== undefined) patch.due = /^\d{4}-\d{2}-\d{2}$/.test(args.due) ? args.due : null
        if (args.cat !== undefined) patch.cat = args.cat === '' ? null : args.cat
        if (args.content !== undefined) patch.content = String(args.content)
        const outcome = todoStore.updateTodo(args.target, String(args.id ?? ''), patch, cwd, dateArg(args.date))
        return { ok: outcome.ok, message: outcome.message, target: outcome.target }
      }
      return { ok: false, message: tmt('todomsg.unknownAction', { action }) }
    },
  }
}

/**
 * Runtime lifecycle for the dtodo capability（todoEnabled 运行时开关，
 * 吸收外部 PR #29 功能自行移植）。存储刻意放在控制器之外：禁用完全可逆，
 * 绝不触碰既有待办数据文件，也不影响独立的同步轨（sync track）。
 * @param {object} ctx - plugin context（tools 服务）。
 * @param {object} config - resolved plugin config（tool name）。
 * @param {() => object} getRuntime - resolves live runtime config.
 * @param {import('./todo.js').TodoStore} todoStore - the todo store.
 * @returns {{sync: () => void, enabled: () => boolean}} 控制器句柄：
 *   `sync` 按运行时开关即时注册/注销 dtodo 工具（幂等），`enabled` 读
 *   当前开关状态。
 */
export function createTodoController(ctx, config, getRuntime, todoStore) {
  let disposer = null
  const enabled = () => getRuntime().todoEnabled !== false
  const sync = () => {
    if (enabled() && disposer === null) {
      disposer = ctx.tools.register(todoToolDefinition(config, todoStore, enabled))
    } else if (!enabled() && disposer !== null) {
      disposer()
      disposer = null
    }
  }
  sync()
  return { sync, enabled }
}
