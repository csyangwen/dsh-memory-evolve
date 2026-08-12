/**
 * 发射闸门（实施规划 §三 guard.js，移植自 dsh-advisor emission-guard.ts）。
 *
 * 位于评审运行时（note 提取）与投递之间：`accept(note)` 返回 true 放行到
 * 投递，false 静默抑制。规则按序：
 *
 * 1. **归一化**：NFKC → 小写 → 非字母数字串折叠为单空格 → trim。"Stop."、
 *    `*stop*`、`"  STOP  "` 全部归一到 `stop`。
 * 2. **空泛短语抑制**：无具体理由的短句（stop/done/lgtm/nothing to add/
 *    ok/looks good 等 17 个）抑制。精确匹配归一化文本——包含短语的完整
 *    note 不受影响。
 * 3. **每轮一条**：`beginUpdate()` 标记一个评审周期开始（运行时每个 delta
 *    处理前调用），周期内至多放行一条。
 * 4. **归一化去重 + 升级**：本会话已接受过的 note 抑制；FIFO 4096 有界
 *    历史；同 note 同级/降级重复抑制，真实升级（nit→concern→blocker）
 *    放行并更新记忆。
 *
 * 闸门状态按会话生命周期：运行时随会话创建/销毁，guard 一并新建/丢弃；
 * `reset()` 暴露给 compact/表面重写（KD-5 类重置）。
 *
 * @module dsh-memory-evolve/advisor/guard
 */

/** FIFO 去重历史上限（与 dsh-advisor/omp 对齐：4096）。 */
export const DEFAULT_MAX_HISTORY = 4096

/** 空泛短语表（dsh-advisor 基础 6 条 + 扩展 11 条；精确匹配归一化文本）。 */
export const CONTENT_FREE_PHRASES = new Set([
  // omp/dsh-advisor 基础清单
  'stop',
  'done',
  'complete',
  'no issue continue',
  'lgtm',
  'nothing to add',
  // 扩展：无具体理由的短确认
  'ok',
  'okay',
  'good',
  'fine',
  'looks good',
  'looks fine',
  'all good',
  'all clear',
  'no issue',
  'no issues',
  'nothing',
  'looks good to me',
])

/** 严重度升序（升级判断用）：info < nit < concern < blocker。 */
const SEVERITY_RANK = { info: -1, nit: 0, concern: 1, blocker: 2 }

/**
 * 归一化一条 note 为身份键：NFKC → 小写 → 非字母数字串折叠为单空格 →
 * trim。
 */
export function normalizeNote(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** 每会话一个发射闸门（随运行时生命周期创建/销毁）。 */
export class EmissionGuard {
  /** 归一化 note → 最后接受时的严重度（Map 插入序即 FIFO 序）。 */
  history = new Map()
  /** 每轮一条闩锁（beginUpdate 复位）。 */
  acceptedThisUpdate = false
  maxHistory

  constructor(options = {}) {
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY
  }

  /** 标记一个评审周期开始（每个被处理的 delta 前调用一次）。 */
  beginUpdate() {
    this.acceptedThisUpdate = false
  }

  /**
   * 接受或抑制一条提取的 note（DTO：{ text, severity }）。
   * @param {object} note - { text: string, severity: 'info'|'nit'|'concern'|'blocker' }
   * @returns {boolean} true=放行到投递；false=抑制（不抛错）
   */
  accept(note) {
    // 运行时防御：异常输入（null/非对象/缺字段）一律抑制，绝不抛错
    if (note === null || typeof note !== 'object' || typeof note.text !== 'string') return false
    const key = normalizeNote(note.text)
    if (key.length === 0) return false // 纯标点/空白
    if (CONTENT_FREE_PHRASES.has(key)) return false
    if (this.acceptedThisUpdate) return false // 每轮一条
    const prior = this.history.get(key)
    if (prior !== undefined && SEVERITY_RANK[note.severity] <= SEVERITY_RANK[prior]) {
      return false // 同级/降级重复抑制
    }
    this.history.set(key, note.severity) // 新 note 或真实升级
    if (this.history.size > this.maxHistory) {
      const oldest = this.history.keys().next().value
      if (oldest !== undefined) this.history.delete(oldest)
    }
    this.acceptedThisUpdate = true
    return true
  }

  /** 清空全部会话状态（compact/表面重写时由 observer 调起）。 */
  reset() {
    this.history.clear()
    this.acceptedThisUpdate = false
  }
}

/** 工厂（与 dsh-advisor 同款）。 */
export function createEmissionGuard(options) {
  return new EmissionGuard(options)
}
