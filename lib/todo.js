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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
   */
  constructor(dir) {
    this.dir = dir
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
    return this.parseAll(this.readText(target, cwd, date))
  }

  /** Atomically write one track's items (header + entries). */
  write(target, cwd, items) {
    const path = this.fileOf(target, cwd)
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
    if (!text) return { ok: false, message: '待办内容不能为空', target }
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
      return { ok: true, message: `已添加待办（${target}：${items.length} 条）`, id, target }
    })
  }

  /**
   * Locate one item by id inside one track (or every track when target is
   * undefined). Returns the track, the item and the full item list.
   * @returns {{target: string, item: object, items: object[]} | null}
   */
  findById(target, id, cwd, date) {
    const targets = target !== undefined ? [target] : TODO_TARGETS
    for (const t of targets) {
      let items
      try {
        items = this.itemsOf(t, cwd, date)
      } catch {
        continue
      }
      const item = items.find((entry) => entry.id === id)
      if (item !== undefined) return { target: t, item, items }
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
      return { ok: false, message: `没有找到 id 为 "${id}" 的待办${target ? `（${target} 轨）` : ''}`, target: target ?? '?' }
    }
    const { target: t, item, items } = found
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
    return withLock(dirname(this.fileOf(t, cwd)), () => {
      const current = this.itemsOf(t, cwd)
      const index = current.findIndex((entry) => entry.id === id)
      if (index === -1) return { ok: false, message: '该待办已被删除（可能在其他窗口操作）——请刷新后重试', target: t }
      const next = [...current]
      next[index] = { raw }
      this.write(t, cwd, next)
      return { ok: true, message: `已更新待办（${t}）`, target: t }
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
      return { ok: false, message: `没有找到 id 为 "${id}" 的待办`, target: target ?? '?' }
    }
    const { target: t, items } = found
    return withLock(dirname(this.fileOf(t, cwd)), () => {
      const current = this.itemsOf(t, cwd)
      const next = current.filter((entry) => entry.id !== id)
      if (next.length === current.length) {
        return { ok: false, message: '该待办已被删除（可能在其他窗口操作）——请刷新后重试', target: t }
      }
      this.write(t, cwd, next)
      return { ok: true, message: `已删除待办（${t}）`, target: t }
    })
  }

  /**
   * List todos across the given tracks with filters. Without `all`, returns
   * the smart default view: overdue + due today + the current project's
   * unfinished + global Q1/Q2 unfinished (daily: today's unfinished),
   * sorted overdue > today > Q1 > Q2 > Q3/Q4/none, capped at 8.
   * @param {string[]} targets - tracks to scan.
   * @param {object} options - { status?, quadrant?, due?, cat?, date?, all? }.
   * @param {string | undefined} cwd - the session cwd (project track).
   * @param {string | undefined} today - today's date (defaults to now).
   * @returns {{items: object[], total: number, truncated: boolean, defaultView: boolean}}
   */
  listTodos(targets, options = {}, cwd, today = todayStamp()) {
    const done = (item) => item.status === 'done' || item.status === 'cancelled'
    const isOverdue = (item) => item.due !== null && item.due < today && !done(item)
    const isToday = (item) => item.due === today && !done(item)
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

    const defaultView = options.all !== true && options.status === undefined
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
    // overdue > today > q1 > q2 > q3 > q4 > none; then due (if any) then time.
    const rank = (item) => (isOverdue(item) ? 0 : isToday(item) ? 1 : item.quadrant === 'q1' ? 2 : item.quadrant === 'q2' ? 3 : item.quadrant === 'q3' ? 4 : item.quadrant === 'q4' ? 5 : 6)
    selected.sort((a, b) => {
      const r = rank(a) - rank(b)
      if (r !== 0) return r
      const d = String(a.due ?? '').localeCompare(String(b.due ?? ''))
      if (d !== 0) return d
      return String(a.time).localeCompare(String(b.time))
    })
    const truncated = selected.length > DEFAULT_VIEW_LIMIT
    return {
      items: options.all === true ? selected : selected.slice(0, DEFAULT_VIEW_LIMIT),
      total: selected.length,
      truncated,
      defaultView,
    }
  }

  /**
   * Format a list result into the model-facing text (short, self-describing
   * tag semantics so every list call re-explains the grammar).
   */
  formatList(result, today = todayStamp()) {
    const { items, total, truncated, defaultView } = result
    if (items.length === 0) {
      return defaultView
        ? '待办（默认视图）：没有需要关注的未完成待办（逾期/今日到期/当前项目/重要紧急），全部清空 🎉'
        : '待办：没有匹配的条目'
    }
    const head = defaultView
      ? `待办（默认视图：逾期/今日到期/当前项目未完成/重要紧急，最多 ${DEFAULT_VIEW_LIMIT} 条）`
      : `待办（${total} 条${truncated ? `，仅显示前 ${DEFAULT_VIEW_LIMIT} 条` : ''}）`
    const lines = items.map((item) => {
      const tags = [`[${item.target}]`]
      if (item.quadrant) tags.push(`[${item.quadrant}]`)
      if (item.due !== null) tags.push(item.due < today ? `[逾期 ${item.due}]` : `[${item.due}]`)
      if (item.status !== 'pending') tags.push(`[${item.status}]`)
      if (item.cat) tags.push(`[${item.cat}]`)
      const text = item.text.split('\n')[0]
      return `- ${tags.join(' ')} ${text}（id: ${item.id}）`
    })
    return `${head}\n${lines.join('\n')}\ntag 语义：q1-q4=四象限（重要×紧急）；due=截止；status=状态；操作按 id（dtodo done/update/remove <id>，可带 target=）。`
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
 * @returns {object} a tool definition for ctx.tools.register.
 */
export function todoToolDefinition(config, todoStore) {
  return {
    name: config.todoToolName,
    description: '待办管理（四轨：life 生活 / work 工作 / project 项目（按工作目录隔离）/ daily 每日）。用户口述"记住/我要做 X"时用 add 直写——**add 的 target 遵循用户说的类别**（"工作上的事"→work、"生活中的"→life、"这个项目要"→project、"今天要"→daily），用户没说才用缺省（有工作目录 project，无 cwd 用 work）；list 默认只返回需要关注的未完成项（逾期/今日到期/当前项目/重要紧急，最多 8 条），看全部需显式参数；done/update/remove 按 id 精确操作。模型自建待办请用 memory_suggest target=todo-*（进待确认队列），不要直接 add。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'list', 'done', 'update', 'remove'],
          description: 'add=新增；list=查看（默认智能视图）；done=完成；update=修改；remove=删除',
        },
        target: {
          type: 'string',
          enum: TODO_TARGETS,
          description: 'add：遵循用户说的类别（工作→work、生活→life、项目→project、每日→daily），没说才缺省（有工作目录用 project，否则 work）；list 缺省=综合四轨；done/update/remove 缺省=全轨按 id 查找',
        },
        content: { type: 'string', description: 'add 时必填：待办内容（首行是标题，可多行写详情）；update 时=替换内容' },
        important: { type: 'boolean', description: '是否重要（与 urgent 组合成四象限）' },
        urgent: { type: 'boolean', description: '是否紧急' },
        quadrant: { type: 'string', enum: ['q1', 'q2', 'q3', 'q4'], description: '直接指定四象限（优先于 important/urgent）：q1 重要紧急 / q2 重要不紧急 / q3 紧急不重要 / q4 不重要不紧急' },
        due: { type: 'string', description: '截止日期 YYYY-MM-DD' },
        cat: { type: 'string', description: '分类（生活/工作/学习…）' },
        status: { type: 'string', enum: TODO_STATUSES, description: 'list 筛选（缺省=智能视图）；update 设置新状态' },
        id: { type: 'string', description: '条目标识（list 返回，如 a1b2c3d4）；done/update/remove 必填' },
        date: { type: 'string', description: 'daily 轨指定日期 YYYY-MM-DD（缺省=今天）' },
        all: { type: 'boolean', description: 'list 时 true=显示全部未过滤（默认智能视图）' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          target: { type: 'string' },
          id: { type: 'string', description: 'add 成功时返回新条目的 id（后续 done/update/remove 用）' },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: value.message ?? '' }],
    },
    async execute(args, exec) {
      const action = args.action
      const cwd = exec?.agent?.session?.header?.cwd ?? undefined
      const dateArg = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
      if (action === 'add') {
        const target = args.target ?? (cwd ? 'project' : 'work')
        if (!TODO_TARGETS.includes(target)) {
          return { ok: false, message: `无效 target "${target}"（应为 ${TODO_TARGETS.join('/')}）`, target }
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
        const result = todoStore.listTodos(targets, {
          status: args.status,
          quadrant: args.quadrant,
          due: args.due,
          cat: args.cat,
          all: args.all === true,
          date,
        }, cwd, date ?? undefined)
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
      return { ok: false, message: `未知 action "${action}"` }
    },
  }
}
