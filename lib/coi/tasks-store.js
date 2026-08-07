/**
 * COI 任务仓库 — 任务记录持久化（tasks.json）+ 输出留档（logs/<id>.log）。
 *
 * 崩溃恢复基础：任务元数据全程落盘，DSH 重启后 status 仍为
 * running/queued 的任务会被调度器标记为 interrupted。
 * 留档：任务输出增量追加到日志文件（上限 maxLogBytes，溢出截断并标记），
 * 历史任务可检索、可回看、可清理。
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

let sequence = 0
/** 生成任务 id：coi-<时间戳>-<序号>。 */
export function newTaskId() {
  sequence += 1
  return `coi-${Date.now().toString(36)}-${sequence.toString(36)}`
}

/** 任务状态机。 */
export const TASK_STATUSES = ['queued', 'running', 'completed', 'failed', 'killed', 'interrupted']

/**
 * @param {string} dir - 数据目录（memoryDir/coi）。
 * @param {object} [opts] - { maxLogBytes, retentionDays }。
 */
export class TaskStore {
  constructor(dir, opts = {}) {
    this.dir = dir
    this.maxLogBytes = opts.maxLogBytes ?? 2 * 1024 * 1024
    this.retentionDays = opts.retentionDays ?? 90
    this.tasks = this.#load()
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(join(this.dir, 'tasks.json'), 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  #save() {
    mkdirSync(this.dir, { recursive: true })
    const tmp = join(this.dir, `tasks.json.tmp.${process.pid}`)
    writeFileSync(tmp, JSON.stringify(this.tasks, null, 2) + '\n')
    renameSync(tmp, join(this.dir, 'tasks.json'))
  }

  /** 新建任务记录并落盘；返回带 id 的完整记录。 */
  add(fields) {
    const now = Date.now()
    const task = {
      id: newTaskId(),
      status: 'queued',
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      timedOut: false,
      error: null,
      summary: null,
      progress: [],
      ...fields,
    }
    this.tasks.push(task)
    this.#save()
    return task
  }

  /** 更新任务字段（白名单），落盘；返回更新后的记录。 */
  update(id, patch) {
    const task = this.tasks.find((t) => t.id === id)
    if (!task) return undefined
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id' || key === 'createdAt') continue
      task[key] = value
    }
    this.#save()
    return task
  }

  /** 按 id 取任务。 */
  get(id) {
    return this.tasks.find((t) => t.id === id)
  }

  /**
   * 检索任务（数据全局存储，可见性按层级过滤）。
   * @param {object} [filter] - { adapterId?, scope?, cwd?, branch?, status?, q?, limit?,
   *   ownerSessionId?, sessionCwd? }
   *   q 匹配 prompt / summary / id（大小写不敏感）。
   *   可见性（与需求 §7 分层同构）——仅当提供 ownerSessionId 或 sessionCwd 时启用：
   *     临时/会话 层级：仅发起它的会话可见（ownerSessionId 匹配）
   *     项目 层级：**发起者工作区内的会话可见**（任务.ownerCwd === 查看会话 cwd——
   *       一个工作区常派多个目录的任务，跨目录派的任务在同一工作区可见；
   *       旧任务无 ownerCwd 时回退按任务 cwd 匹配，宁缺勿泄到其他工作区）
   *     全局 层级：全部可见
   * @returns {object[]} 按 createdAt 倒序。
   */
  list(filter = {}) {
    let items = [...this.tasks]
    if (filter.adapterId) items = items.filter((t) => t.adapterId === filter.adapterId)
    if (filter.scope) items = items.filter((t) => t.scope === filter.scope)
    if (filter.cwd) items = items.filter((t) => t.cwd === filter.cwd)
    if (filter.branch) items = items.filter((t) => t.branch === filter.branch)
    if (filter.status) items = items.filter((t) => t.status === filter.status)
    if (filter.q) {
      const q = String(filter.q).toLowerCase()
      items = items.filter((t) =>
        t.id.toLowerCase().includes(q)
        || (t.prompt ?? '').toLowerCase().includes(q)
        || (t.summary ?? '').toLowerCase().includes(q))
    }
    // 层级可见性过滤
    const viewerSession = filter.ownerSessionId
    const viewerCwd = filter.sessionCwd
    if (viewerSession !== undefined || viewerCwd !== undefined) {
      items = items.filter((t) => {
        switch (t.scope) {
          case 'temporary':
          case 'session':
            return viewerSession !== undefined && t.ownerSessionId === viewerSession
          case 'project':
            // 发起者工作区（ownerCwd）内的会话可见；旧任务无 ownerCwd →
            // 回退按任务 cwd 匹配（兼容历史数据，但绝不跨工作区泄漏）
            return viewerCwd === undefined
              || (t.ownerCwd != null ? t.ownerCwd === viewerCwd : (t.cwd != null && t.cwd === viewerCwd))
          default:
            return true // global 与未知层级
        }
      })
    }
    const limit = Number(filter.limit ?? 200)
    return items.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit > 0 ? limit : 200)
  }

  /**
   * 删除任务（记录 + 留档文件）。运行中/排队中的任务不可删（先终止）。
   * @param {string} id
   * @returns {{ok:boolean, message:string}}
   */
  remove(id) {
    const task = this.tasks.find((t) => t.id === id)
    if (!task) return { ok: false, message: `任务 ${id} 不存在` }
    if (task.status === 'running' || task.status === 'queued') {
      return { ok: false, message: `任务 ${id} 正在运行，请先终止再删除` }
    }
    const index = this.tasks.indexOf(task)
    this.tasks.splice(index, 1)
    this.#save()
    try { rmSync(this.logPath(id), { force: true }) } catch { /* 忽略 */ }
    return { ok: true, message: `已删除任务 ${id}` }
  }

  /** 输出留档路径。 */
  logPath(id) {
    return join(this.dir, 'logs', `${id}.log`)
  }

  /** 追加一段输出到留档文件（截断保护：超上限后不再追加，标记 truncated）。 */
  appendLog(id, text) {
    if (!text) return
    const path = this.logPath(id)
    mkdirSync(dirname(path), { recursive: true })
    try {
      let size = 0
      try {
        size = statSync(path).size
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (size >= this.maxLogBytes) {
        this.update(id, { logTruncated: true })
        return
      }
      appendFileSync(path, text)
      // 单次大块写入可能越过上限：标记截断（内容保留，后续不再追加）
      if (statSync(path).size > this.maxLogBytes) {
        this.update(id, { logTruncated: true })
      }
    } catch (error) {
      this.update(id, { error: `留档写入失败: ${error.message}` })
    }
  }

  /**
   * 读取留档（从末尾向前取，用于 GUI 尾部视图与摘要）。
   * @param {string} id - 任务 id。
   * @param {number} [tailChars] - 只取末尾 N 字符；缺省全量。
   * @returns {string} 留档文本（不存在返回空串）。
   */
  readLog(id, tailChars) {
    try {
      const text = readFileSync(this.logPath(id), 'utf8')
      if (tailChars && text.length > tailChars) return `…（前 ${text.length - tailChars} 字符已省略）\n${text.slice(-tailChars)}`
      return text
    } catch {
      return ''
    }
  }

  /**
   * 清理策略：删除超过 retentionDays 的已完成任务及其日志。
   * @returns {number} 清理的任务数。
   */
  prune() {
    const cutoff = Date.now() - this.retentionDays * 24 * 3600 * 1000
    const before = this.tasks.length
    const survivors = this.tasks.filter((t) => {
      if (t.createdAt > cutoff) return true
      if (t.status === 'running' || t.status === 'queued' || t.status === 'interrupted') return true
      return false
    })
    const removed = this.tasks.filter((t) => !survivors.includes(t))
    for (const task of removed) {
      try { rmSync(this.logPath(task.id), { force: true }) } catch { /* 忽略 */ }
    }
    if (removed.length > 0) {
      this.tasks = survivors
      this.#save()
    }
    return removed.length
  }
}
