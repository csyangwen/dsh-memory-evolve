/**
 * COI 会话仓库 — session id 的持久化登记与检索。
 *
 * 会话按层级（临时/会话/项目/全局）归属，与记忆五轨哲学同构：
 *   - 临时：任务结束即弃，不入库（调度器不调用本仓库）
 *   - 会话：本次 DSH 会话内可恢复（记录会话标签，供 GUI 过滤）
 *   - 项目：按工作目录归类，跨 DSH 会话可见，可挂 git 分支
 *   - 全局：未分类 / 跨项目，长期保留
 *
 * 并发锁：同一会话同时只能跑一个任务（两个任务同时恢复同一 session id
 * 会串上下文）。activeTaskId 记录占用者，任务完成/取消时释放。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { translate, getLocale, COI2_DICT } from '../i18n.js'

/** Translate through COI2_DICT in the active host locale. */
const cs2 = (key, params) => translate(COI2_DICT, key, params, getLocale())

const SCOPES = ['temporary', 'session', 'project', 'global']

/**
 * @param {string} file - sessions.json 的绝对路径。
 */
export class SessionStore {
  constructor(file) {
    this.file = file
    this.items = this.#load()
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  #save() {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(this.items, null, 2) + '\n')
    renameSync(tmp, this.file)
  }

  /**
   * 登记一个会话。已存在的（同 id）只更新时间戳与最近任务。
   * @param {object} rec - { id, adapterId, scope, cwd, branch, note?, taskId? }
   * @returns {object} 登记结果 { ok, message, session? }；scope 非法时 ok=false。
   */
  upsert(rec) {
    const id = String(rec.id ?? '').trim()
    if (!id) return { ok: false, message: cs2('coi2.sessNeedsId') }
    const scope = rec.scope ?? 'project'
    if (!SCOPES.includes(scope)) {
      return { ok: false, message: cs2('coi2.badScope', { valid: SCOPES.join('/') }) }
    }
    if (scope === 'temporary') return { ok: false, message: cs2('coi2.temporaryNotStored') }
    const existing = this.items.find((item) => item.id === id)
    const now = Date.now()
    if (existing) {
      if (rec.branch !== undefined) existing.branch = rec.branch
      if (rec.note !== undefined && String(rec.note).trim() !== '') existing.note = String(rec.note).trim()
      existing.adapterId = rec.adapterId ?? existing.adapterId
      existing.cwd = rec.cwd ?? existing.cwd
      if (rec.ownerCwd !== undefined) existing.ownerCwd = rec.ownerCwd
      existing.lastSeen = now
      if (rec.taskId) existing.lastTaskId = rec.taskId
      this.#save()
      return { ok: true, message: cs2('coi2.sessUpdated'), session: existing }
    }
    const session = {
      id,
      adapterId: rec.adapterId,
      scope,
      cwd: rec.cwd ?? null,
      branch: rec.branch ?? null,
      ownerSessionId: rec.ownerSessionId ?? null,
      ownerCwd: rec.ownerCwd ?? null, // 发起会话的工作目录（项目层级可见性依据）
      note: String(rec.note ?? '').trim() || null,
      activeTaskId: null,
      lastTaskId: rec.taskId ?? null,
      firstSeen: now,
      lastSeen: now,
    }
    this.items.push(session)
    this.#save()
    return { ok: true, message: cs2('coi2.sessRegistered'), session }
  }

  /**
   * 检索会话（可见性按层级过滤，与任务一致）。
   * @param {object} [filter] - { scope?, cwd?, branch?, q?, adapterId?,
   *   ownerSessionId?, sessionCwd? }
   *   q 匹配 id / 备注 / 适配器名（大小写不敏感）。
   *   可见性：临时/会话 层级仅发起会话可见；项目 层级**发起者工作区内的会话
   *   可见**（会话.ownerCwd === 查看会话 cwd；旧记录无 ownerCwd 回退按
   *   cwd 匹配，宁缺勿泄）；全局全显。
   * @returns {object[]} 匹配的会话（按 lastSeen 倒序）。
   */
  list(filter = {}) {
    let items = [...this.items]
    if (filter.scope && filter.scope !== 'all') items = items.filter((s) => s.scope === filter.scope)
    if (filter.cwd) items = items.filter((s) => s.cwd === filter.cwd)
    if (filter.branch) items = items.filter((s) => s.branch === filter.branch || s.branch === null)
    if (filter.adapterId) items = items.filter((s) => s.adapterId === filter.adapterId)
    if (filter.q) {
      const q = String(filter.q).toLowerCase()
      items = items.filter((s) =>
        s.id.toLowerCase().includes(q)
        || (s.note ?? '').toLowerCase().includes(q)
        || (s.adapterId ?? '').toLowerCase().includes(q))
    }
    const viewerSession = filter.ownerSessionId
    const viewerCwd = filter.sessionCwd
    if (viewerSession !== undefined || viewerCwd !== undefined) {
      items = items.filter((s) => {
        switch (s.scope) {
          case 'temporary':
          case 'session':
            return viewerSession !== undefined && s.ownerSessionId === viewerSession
          case 'project':
            // 发起者工作区（ownerCwd）内的会话可见；旧记录无 ownerCwd →
            // 回退按 cwd 匹配（兼容历史数据，但绝不跨工作区泄漏）
            return viewerCwd === undefined
              || (s.ownerCwd != null ? s.ownerCwd === viewerCwd : (s.cwd != null && s.cwd === viewerCwd))
          default:
            return true
        }
      })
    }
    return items.sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /** 按 session id 找记录。 */
  findById(id) {
    return this.items.find((item) => item.id === id)
  }

  /** 设置/清除备注。 */
  updateNote(id, note) {
    const session = this.findById(id)
    if (!session) return { ok: false, message: cs2('coi2.sessMissing', { id }) }
    session.note = String(note ?? '').trim() || null
    this.#save()
    return { ok: true, message: cs2('coi2.noteUpdated'), session }
  }

  /** 删除一条会话记录。 */
  remove(id) {
    const index = this.items.findIndex((item) => item.id === id)
    if (index < 0) return { ok: false, message: cs2('coi2.sessMissing', { id }) }
    const [removed] = this.items.splice(index, 1)
    this.#save()
    return { ok: true, message: cs2('coi2.sessDeleted', { id }), session: removed }
  }

  /**
   * 占用会话（并发锁）。被占用时返回失败。
   * @param {string} id - session id。
   * @param {string} taskId - 占用的任务。
   * @returns {{ok:boolean, message:string}}
   */
  acquire(id, taskId) {
    const session = this.findById(id)
    if (!session) return { ok: false, message: cs2('coi2.sessNotRegistered', { id }) }
    if (session.activeTaskId && session.activeTaskId !== taskId) {
      return {
        ok: false,
        message: cs2('coi2.sessBusy', { id, task: session.activeTaskId }),
      }
    }
    session.activeTaskId = taskId
    this.#save()
    return { ok: true, message: cs2('coi2.sessLocked') }
  }

  /** 释放会话锁（任务结束/取消时调用）。 */
  release(id, taskId) {
    const session = this.findById(id)
    if (session && session.activeTaskId === taskId) {
      session.activeTaskId = null
      this.#save()
    }
  }
}
