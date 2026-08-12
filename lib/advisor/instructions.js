/**
 * 用户指令队列（实施规划 §三 instructions.js）。
 *
 * 用户通过面板输入框 / `/advisor tell` 给 advisor 发指令（"重点检查安全
 * 漏洞"等），指令进入 per-session 队列，在下次评审 drain 开始时被并入
 * 评审输入。
 *
 * **事务语义**（双审 M7 修订）：
 * - `reserve(sessionId)`：drain 开始时 snapshot 全部 pending 并标记
 *   `reserved`（绑定 reviewId），返回待并入的指令列表；
 * - `consume(reviewId, ids)`：评审完成（无论 outcome）后标记 `consumed`
 *   （at-least-once：成功路径不重复消费）；
 * - `release(ids)`：评审失败（transient 耗尽 / quota / permanent）时释放
 *   回 pending（下次评审重试）；
 * - transient 重试沿用同一 reservation，不重复创建消费记录。
 *
 * 持久化：`<dataDir>/instructions.json`（temp+rename 原子写，temp 名含
 * 递增 nonce——多写场景防串写）。上限：单条 text ≤2000 字符、每会话
 * pending ≤20（超限拒绝新增并报错）。
 *
 * 纯类（cordis-free，fs 由注入的 storage 提供以支持测试）。
 *
 * @module dsh-memory-evolve/advisor/instructions
 */

/** 单条指令文本上限。 */
export const INSTRUCTION_MAX_CHARS = 2_000
/** 每会话 pending 上限。 */
export const PENDING_MAX = 20

/** 指令状态机。 */
export const INSTRUCTION_STATES = ['pending', 'reserved', 'consumed']

/**
 * @param {object} options
 * @param {(path: string, data: string) => void} options.writeFile - 持久化写入（temp+rename 由调用方保证或测试注入）
 * @param {() => string} [options.now] - 时间戳注入（测试用）
 * @param {(sessionId: string) => string} options.fileFor - 会话指令文件路径（<dataDir>/instructions/<sessionId>.json）
 */
export class InstructionQueue {
  /** sessionId → 指令数组（{id, createdAt, text, state, reviewId?}）。 */
  queues = new Map()
  writeFile
  fileFor
  now

  constructor(options) {
    this.writeFile = options.writeFile
    this.fileFor = options.fileFor
    this.readFile = options.readFile // 可选：持久化读取（无则视为空队列）
    this.now = options.now ?? (() => Date.now())
  }

  /** 加载一个会话的持久化指令（启动/首次访问时；失败按空队列处理并告警）。 */
  load(sessionId, logger = console) {
    if (this.queues.has(sessionId)) return
    try {
      const raw = this.fileFor(sessionId)
      if (typeof this.readFile === 'function') {
        const text = this.readFile(raw)
        const parsed = text === '' ? [] : JSON.parse(text)
        if (Array.isArray(parsed)) {
          const items = parsed.filter((item) => item && typeof item.id === 'string')
          // 复审中3（崩溃恢复）：旧进程遗留的 reserved 恢复为 pending——
          // 旧 review 不可能继续完成，否则这些指令永久卡住（破坏
          // at-least-once）；bound 是内存瞬态不持久化，天然清除。
          let changed = false
          for (const item of items) {
            if (item.state === 'reserved') {
              item.state = 'pending'
              item.reviewId = undefined
              delete item.bound
              changed = true
            }
          }
          this.queues.set(sessionId, items)
          if (changed) this.persist(sessionId)
        }
      }
    } catch (error) {
      logger.warn?.('advisor: instructions load failed — empty queue', { sessionId, error })
    }
    if (!this.queues.has(sessionId)) this.queues.set(sessionId, [])
  }

  /** 追加一条指令（校验：非空文本、长度、pending 上限）。 */
  add(sessionId, text, logger = console) {
    const trimmed = String(text ?? '').trim()
    if (trimmed === '') throw new Error('advisor: 指令不能为空')
    if (trimmed.length > INSTRUCTION_MAX_CHARS) {
      throw new Error(`advisor: 指令超长（上限 ${INSTRUCTION_MAX_CHARS} 字符）`)
    }
    this.load(sessionId, logger)
    const queue = this.queues.get(sessionId)
    const pending = queue.filter((item) => item.state === 'pending').length
    if (pending >= PENDING_MAX) throw new Error(`advisor: 待处理指令已达上限（${PENDING_MAX} 条），请先清空或等待评审消费`)
    const item = { id: crypto.randomUUID(), createdAt: this.now(), text: trimmed, state: 'pending' }
    queue.push(item)
    this.persist(sessionId)
    return item
  }

  /** 待处理（pending）指令列表。 */
  pending(sessionId) {
    this.load(sessionId)
    return (this.queues.get(sessionId) ?? []).filter((item) => item.state === 'pending')
  }

  /**
   * Q4（复审高1）：标记一条指令为「已绑定给即将入队的问答任务」。
   *
   * 时序竞态：`tell()` 先把指令写入 pending，`ask()` 任务排在队列里，
   * 若队列中已有普通评审 delta 排在问答前面，评审的 reserve 会抢走这条
   * 新指令（问答任务拿到空问题）。绑定标记让评审的 reserve 跳过它，问答
   * 任务用 reserve(ids) 精确消费。
   */
  bind(sessionId, id, logger = console) {
    this.load(sessionId, logger)
    const item = (this.queues.get(sessionId) ?? []).find((entry) => entry.id === id)
    if (item !== undefined && item.state === 'pending') item.bound = true
  }

  /**
   * Q4：解除绑定（问答任务被拒等场景）——指令回到普通 pending 流，
   * 由下次评审自然消费（不丢）。
   */
  unbind(sessionId, id, logger = console) {
    this.load(sessionId, logger)
    const item = (this.queues.get(sessionId) ?? []).find((entry) => entry.id === id)
    if (item !== undefined && item.bound === true) {
      delete item.bound
      this.persist(sessionId)
    }
  }

  /**
   * drain 开始：snapshot 待处理指令并标记 reserved（绑定 reviewId）。
   *
   * @param {object} [options] - { ids?: string[] }：问答模式精确指定要消费
   *   的指令 id（评审模式不传=全部 pending 且跳过已绑定问答的）
   * @returns {Array<{id:string,text:string,reviewId:string}>} 本轮并入的指令
   *   （带 reviewId——release 需校验 reservation 所属，防旧 runtime 误释放）
   */
  reserve(sessionId, reviewId, options = {}, logger = console) {
    this.load(sessionId, logger)
    const queue = this.queues.get(sessionId) ?? []
    const ids = options.ids
    const idSet = ids !== undefined ? new Set(ids) : null
    const reserved = []
    for (const item of queue) {
      if (item.state !== 'pending') continue
      // 问答：只取指定 id；评审：跳过已绑定问答的指令（Q4 竞态防护）
      if (idSet !== null ? !idSet.has(item.id) : item.bound === true) continue
      item.state = 'reserved'
      item.reviewId = reviewId
      delete item.bound
      reserved.push({ id: item.id, text: item.text, reviewId })
    }
    if (reserved.length > 0) this.persist(sessionId)
    return reserved
  }

  /** 评审完成：reserved 且属于该 reviewId 的指令标记 consumed。 */
  consume(reviewId, logger = console) {
    let changed = false
    for (const queue of this.queues.values()) {
      for (const item of queue) {
        if (item.state === 'reserved' && item.reviewId === reviewId) {
          item.state = 'consumed'
          item.reviewId = undefined
          changed = true
        }
      }
    }
    if (changed) this.persistAll(logger)
  }

  /**
   * 评审失败：reserved 指令释放回 pending（下次评审重试）。
   *
   * 复审中4：必须校验 reservation 所属 reviewId——旧 runtime 的迟到
   * release（dispose/abort 路径）不得误恢复新 runtime 已重新 reserve 的
   * 同一指令（双释放由状态校验 + reviewId 校验双重兜底）。
   */
  release(reviewId, items, logger = console) {
    const ids = new Set((items ?? []).map((item) => item.id))
    if (ids.size === 0) return
    let changed = false
    for (const queue of this.queues.values()) {
      for (const item of queue) {
        if (item.state === 'reserved' && item.reviewId === reviewId && ids.has(item.id)) {
          item.state = 'pending'
          item.reviewId = undefined
          delete item.bound
          changed = true
        }
      }
    }
    if (changed) this.persistAll(logger)
  }

  /** 清空某会话全部 pending（不动 in-flight reserved/consumed）。 */
  clearPending(sessionId, logger = console) {
    this.load(sessionId, logger)
    const queue = this.queues.get(sessionId) ?? []
    const kept = queue.filter((item) => item.state !== 'pending')
    const cleared = queue.length - kept.length
    if (cleared > 0) {
      this.queues.set(sessionId, kept)
      this.persist(sessionId)
    }
    return cleared
  }

  /** 会话销毁：丢弃内存缓存（磁盘记录保留供追溯）。 */
  disposeSession(sessionId) {
    this.queues.delete(sessionId)
  }

  persist(sessionId) {
    const queue = this.queues.get(sessionId) ?? []
    this.writeFile(this.fileFor(sessionId), JSON.stringify(queue))
  }

  persistAll(logger = console) {
    for (const sessionId of this.queues.keys()) {
      try {
        this.persist(sessionId)
      } catch (error) {
        logger.warn?.('advisor: instructions persist failed', { sessionId, error })
      }
    }
  }
}
