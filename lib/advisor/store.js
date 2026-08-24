/**
 * 评审记录存储（实施规划 §三 store.js，双审 M2 修订）。
 *
 * 双层职责：
 *
 * 1. **live 事件环**（内存）：所有 live 事件（review-started /
 *    review-finished / runtime-status）按 sessionId 分桶（每桶 200 条），
 *    每条分配**进程内单调 seq**——前端以 `after=<seq>` 游标轮询，同毫秒
 *    不丢事件；游标早于桶内最老 seq → 响应 `gap:true`（前端清空实时列表
 *    并从 records 重建）。
 * 2. **终态记录**（JSONL 持久化）：仅 review-finished 落盘
 *    `<dataDir>/records.jsonl`，**先磁盘后 ring**——磁盘追加成功才进
 *    ring；磁盘失败发 `storage-error` 事件（不把未持久化记录伪装成正常）。
 *
 * 一致性细节：
 * - 单 writer promise chain：所有 JSONL 行经同一串行队列追加（O_APPEND），
 *   无并发交错；
 * - 单条记录 ≤64KB（超限降级为截断存储 + 告警）；
 * - 启动/读取容忍尾行残缺（崩溃半行），中间坏行告警跳过；
 * - records 查询：before=<reviewId> 游标分页（offset 分页在持续追加时
 *   不稳定），ts 倒序，limit 默认 50 上限 100。
 *
 * 纯类（fs 注入以支持测试）。
 *
 * @module dsh-memory-evolve/advisor/store
 */

import { existsSync, readFileSync } from 'node:fs'
import { translate, getLocale, MISC2_DICT } from '../i18n.js'

/** Translate through MISC2_DICT in the active host locale. */
const ast_ = (key, params) => translate(MISC2_DICT, key, params, getLocale())

/** 每会话 live 事件环容量。 */
export const RING_CAPACITY = 200
/** 单条 JSONL 记录字节上限。 */
export const RECORD_MAX_BYTES = 64 * 1024
/** records 分页默认/上限。 */
export const RECORDS_DEFAULT_LIMIT = 50
export const RECORDS_MAX_LIMIT = 100

/** 单会话事件环（按 seq 升序，容量有界，尾部淘汰）。 */
class SessionRing {
  constructor(capacity = RING_CAPACITY) {
    this.capacity = capacity
    this.events = []
  }

  push(event) {
    if (this.events.length >= this.capacity) this.events.shift()
    this.events.push(event)
  }

  /** after 之后的事件；gap=true 表示 after 早于桶内最老（断档）。 */
  queryAfter(after) {
    const events = this.events
    if (events.length === 0) return { events: [], gap: false }
    // B13a：断档判定用"桶内最老事件的真实 seq"（seq 是跨会话全局单调
    // 序号；旧实现按淘汰计数 +1 会在全局 seq 前进后误判 gap）
    const oldest = events[0].seq
    if (after === undefined) return { events: [...events], gap: false } // 首次查询：全量，非断档
    if (after < oldest) return { events: [...events], gap: true }
    const start = events.findIndex((e) => e.seq > after)
    if (start < 0) return { events: [], gap: false }
    return { events: events.slice(start), gap: false }
  }
}

/**
 * @param {object} options
 * @param {string} options.recordsFile - records.jsonl 绝对路径
 * @param {(path: string, data: string | Buffer) => Promise<void>} options.appendFile - 追加写（串行队列由本类保证）
 * @param {(event: object) => void} [options.onStorageError] - 存储失败回调（发 runtime-status/storage-error）
 * @param {(path: string) => string} [options.readFile] - 读文件（缺省 readFileSync）
 * @param {() => number} [options.now] - 时间戳注入
 */
export class ReviewStore {
  constructor(options) {
    this.recordsFile = options.recordsFile
    this.appendFile = options.appendFile
    this.onStorageError = options.onStorageError
    this.readFile = options.readFile ?? ((path) => (existsSync(path) ? readFileSync(path, 'utf8') : ''))
    this.now = options.now ?? (() => Date.now())
    this.rings = new Map()
    this.nextSeq = 1
    /** 单 writer 链：所有 JSONL 追加串行执行。 */
    this.writeChain = Promise.resolve()
    this.persisted = 0
  }

  /** 分配下一个单调 seq。 */
  nextSeqValue() {
    return this.nextSeq++
  }

  ringFor(sessionId) {
    let ring = this.rings.get(sessionId)
    if (ring === undefined) {
      ring = new SessionRing(RING_CAPACITY)
      this.rings.set(sessionId, ring)
    }
    return ring
  }

  /**
   * 发布一条事件（分配 seq、进 ring）。
   *
   * **B12 修订（先磁盘后 ring）**：review-finished 不立即进 ring——先串行
   * 落盘 JSONL，成功后才进 ring（前端才能看到）；失败只发 storage-error
   * 状态事件，绝不让未持久化的 finished 出现在实时流。started /
   * runtime-status 无持久化语义，直接进 ring。
   */
  emit(event, options = {}) {
    if (options.persist === true && event.type === 'review-finished') {
      this.persistFinished(event)
      return null // finished 由落盘回调决定何时进 ring
    }
    return this.publishLive(event)
  }

  /** 进 ring + 分配 seq（live 事件统一入口）。 */
  publishLive(event) {
    const seq = this.nextSeqValue()
    const withSeq = { seq, ...event }
    if (event.sessionId !== undefined) {
      this.ringFor(event.sessionId).push(withSeq)
    } else {
      this.ringFor('__global__').push(withSeq)
    }
    return withSeq
  }

  /**
   * 终态记录落盘（B12：**先磁盘后 ring**——append 成功后才 publishLive；
   * 失败发 storage-error，finished 不进实时流）。
   */
  persistFinished(event) {
    // 落盘用独立 DTO：剥离 seq（契约 ReviewRecord 无 seq）、保留完整字段
    const record = { ...event }
    delete record.seq
    const line = JSON.stringify(record)
    const bytes = Buffer.byteLength(line, 'utf8')
    if (bytes > RECORD_MAX_BYTES) {
      this.onStorageError?.({
        type: 'storage-error',
        ts: this.now(),
        code: 'RECORD_TOO_LARGE',
        message: ast_('adv.recordTooLarge', { bytes }),
        reviewId: event.reviewId,
        sessionId: event.sessionId,
      })
      return
    }
    const task = this.writeChain.then(async () => {
      await this.appendFile(this.recordsFile, `${line}\n`)
      this.persisted += 1
      // 磁盘成功 → 进 ring（前端此刻才可见该 finished）
      this.publishLive(event)
    })
    this.writeChain = task.catch((error) => {
      this.onStorageError?.({
        type: 'storage-error',
        ts: this.now(),
        code: 'APPEND_FAILED',
        message: ast_('adv.recordWriteFailed', { detail: error?.message ?? String(error) }),
        reviewId: event.reviewId,
        sessionId: event.sessionId,
      })
    })
    return task
  }

  /** live 事件查询（游标）。 */
  queryEvents(sessionId, after, limit = 100) {
    const ring = this.rings.get(sessionId)
    if (ring === undefined) return { events: [], nextCursor: after ?? 0, gap: false }
    const { events, gap } = ring.queryAfter(after)
    const capped = limit > 0 ? events.slice(0, limit) : events
    const last = capped.length > 0 ? capped[capped.length - 1].seq : (after ?? 0)
    return { events: capped, nextCursor: last, gap }
  }

  /**
   * 终态记录查询（before 游标分页，ts 倒序）。
   * @returns {{ records: Array, nextCursor: string|null, hasMore: boolean }}
   */
  queryRecords(filters = {}) {
    const { sessionId, workspace, severity, before, limit = RECORDS_DEFAULT_LIMIT } = filters
    const capped = Math.min(Math.max(1, Number(limit) || RECORDS_DEFAULT_LIMIT), RECORDS_MAX_LIMIT)
    const lines = []
    const raw = this.readFile(this.recordsFile)
    if (raw === '') return { records: [], nextCursor: null, hasMore: false }
    const parts = raw.split('\n')
    // 容忍尾行残缺（崩溃半行）：最后一段非 JSON 则忽略
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (part.trim() === '') continue
      try {
        lines.push(JSON.parse(part))
      } catch (error) {
        // 尾行残缺容错；中间坏行告警
        if (i < parts.length - 1) {
          this.onStorageError?.({
            type: 'storage-error',
            ts: this.now(),
            code: 'CORRUPT_LINE',
            message: ast_('adv.lineCorrupt', { line: i + 1, detail: error?.message ?? String(error) }),
          })
        }
      }
    }
    // 过滤（会话/工作空间/严重度）
    let matched = lines.filter((r) => {
      if (sessionId !== undefined && r.sessionId !== sessionId) return false
      if (workspace !== undefined && r.workspace !== workspace) return false
      if (severity !== undefined && r.note?.severity !== severity) return false
      return true
    })
    // 稳定排序（ts 倒序，同 ts 按 reviewId 字典序倒序保证全序）
    let sorted = matched.sort((a, b) => {
      if (b.ts !== a.ts) return b.ts - a.ts
      return a.reviewId < b.reviewId ? 1 : a.reviewId > b.reviewId ? -1 : 0
    })
    // B13b：before 游标按精确 reviewId 定位（旧实现只比 ts——同毫秒多条
    // 记录时下一页会跳过该毫秒的剩余记录）
    if (before !== undefined) {
      const index = sorted.findIndex((r) => r.reviewId === before)
      if (index >= 0) sorted = sorted.slice(index + 1)
    }
    const hasMore = sorted.length > capped
    const page = sorted.slice(0, capped)
    return {
      records: page,
      nextCursor: hasMore ? page[page.length - 1].reviewId : null,
      hasMore,
    }
  }

  /**
   * 会话销毁：清掉该会话的 live ring（磁盘记录保留供追溯）。
   *
   * 复审低11：旧文件里存在两个同名实现（前一个声称保留 ring、后一个实际
   * 删除）——统一为"清 ring"，live 事件本就只服务实时面板，会话销毁后
   * 重建会从 records 重新对齐；磁盘 records.jsonl 不受影响。
   */
  disposeSession(sessionId) {
    this.rings.delete(sessionId)
  }

  /**
   * 新建评审会话（2026-08-13 用户反馈）：清掉该会话的 live ring——
   * 实时流只显示**当前评审会话**的活动；旧评审事件（上一评审会话）已
   * 落盘 records.jsonl，在「记录」Tab 可查，不丢。与 disposeSession
   * 的区别：reset 后会话仍活跃，新事件继续进 ring。
   */
  resetSessionEvents(sessionId) {
    this.rings.delete(sessionId)
  }
}
