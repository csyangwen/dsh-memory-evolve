/**
 * dsh-memory-evolve — Jev advisory gate (Phase C).
 *
 * Shadow-mode labeling for KEY-track suggestions only. Jev never blocks,
 * rewrites, or archives a suggestion: it attaches two scores that the human
 * reads during approval, and logs them for threshold calibration.
 *
 *   generalization  how reusable is this fact outside the project where it
 *                  was suggested (gold-standard axis: B-group 0.73 vs
 *                  C-group 0.31; threshold 0.5)
 *   skill_shape    does this read like a durable practice/skill rather than
 *                  a one-off project log (S-group 0.70 vs others 0.36–0.42;
 *                  threshold 0.6)
 *
 * Call sites (exactly two, by design):
 *   1. enqueueSuggestion(target='key') — label before the user sees the queue
 *   2. POST /api/audit/run — bulk re-label existing KEY entries on demand
 *
 * Fail-open is structural, not a fallback branch: the whole module degrades
 * to `gate: 'disabled' | 'unavailable' | 'skipped'`, and every caller keeps
 * its suggestion either way.
 *
 * @module dsh-memory-evolve/jev-gate
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'

/**
 * jev-core is a sibling plugin, not a dependency of this package (the plugin
 * ships zero runtime deps). Resolve it at first use against the DSH plugins
 * dir — $DSH_HOME/plugins/dsh-jev/packages/jev-core — and cache the module.
 * The whole feature turns itself off when the sibling is absent.
 */
const require = createRequire(import.meta.url)
let jevCoreModule = null
let jevResolveFailed = false

/**
 * Map an ordinal rubric score onto 0..1. The SDK's ScoreResponse.score is an
 * expected value over rubric levels (for our 5-level rubrics that is 0..4, and
 * it may land between levels), so it must be divided by levels - 1 before it
 * can be compared to the 0..1 thresholds health() publishes and the human
 * reads during approval. The legend the provider returns is authoritative for
 * the level count; the constant is the fallback when a provider omits it.
 */
const RUBRIC_LEVELS = 5
function normalizeScore(answer) {
  const legend = answer && answer.legend
  const levels = legend && typeof legend === 'object' ? Object.keys(legend).length : 0
  const n = levels >= 2 ? levels : RUBRIC_LEVELS
  return n > 1 ? answer.score / (n - 1) : answer.score
}

function loadJevCore() {
  if (jevCoreModule) return jevCoreModule
  if (jevResolveFailed) return null
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const candidates = [
    join(home, 'plugins/dsh-jev/packages/jev-core/lib/index.js'),
    // installed-as-dependency layout (dsh-jev profile node_modules)
    join(home, 'node_modules/@buberlo/jev-core/lib/index.js'),
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) {
    jevResolveFailed = true
    return null
  }
  try {
    jevCoreModule = require(found)
  } catch {
    jevResolveFailed = true
    return null
  }
  return jevCoreModule
}

/** Default shadow-mode configuration (no network, no API key). */
export const DEFAULT_GATE_CONFIG = Object.freeze({
  enabled: true,
  provider: 'mock',
  mode: 'shadow',
  model: undefined,
  dailyBudgetCny: 1,
  dailyCallLimit: 100,
  generalizationThreshold: 0.5,
  skillShapeThreshold: 0.6,
  budgetStateFile: null, // null → <memoryDir>/jev-budget.json
  // 执行纪录：每次标注一行（时间/门禁/分数/耗时/失败原因），供「审计」
  // 子页回看。null → <memoryDir>/jev-log.jsonl；写失败永不阻断标注。
  logFile: null,
})

/**
 * Build the two score questions for one candidate entry. Both use a 0–4
 * ordered rubric; jev-core maps the rubric onto a 0–1 expected score.
 */
/**
 * Concrete examples of what a generalized, skill-shaped memory looks like.
 * Not decoration: without them the model anchors on the entry being judged and
 * every key-style entry scores high. Anchoring lifted B-vs-C separation from
 * AUC 0.68 to 0.93 and S-vs-C from 0.58 to 0.88 on the 29-entry gold set
 * (live re-run, 2026-09-25).
 */
const ANCHOR_LINES = [
  '已存在的 skill 范例（泛化方法论的形态）：',
  '- remote-hive-pd-recovery: 经MCP remote run在远端Hive按calc_performance口径统计PD与回收率、渲染宽表图并分块回传交付的端到端流程',
  '- find-animation-opportunities: Search a codebase or UI for places that do not animate but should, and reject everything that should not. Read-only; it proposes motion with exact values, it does not implement it.',
]
const ANCHOR = ANCHOR_LINES.join('\n')

function buildQuestions(text) {
  const jev = loadJevCore()
  return {
    generalization: jev.score(
      '判断这条记忆的「跨项目可复用性」：它是一个长期约定/决策/口径（适用于许多项目，属于全局 KEY 记忆），还是只对当前项目的当前状态有用（属于项目轨）？\n' + ANCHOR + '\n' + '待评估文本：\n' + text,
      [
        '只描述当前项目的一次性状态或进展（谁做了什么、本轮结果），换项目毫无意义',
        '当前项目的临时约定，其他项目几乎用不上',
        '和具体项目绑定但带一点通用性，换个项目可能沾边',
        '跨项目通用的做法或约定，多数项目能复用',
        '与项目无关的长期决策/口径/标准，任何会话都该知道',
      ],
    ),
    skill_shape: jev.score(
      '判断这条记忆的「技能/实践形态」：它读起来像一个可重复执行的做法或专业习惯（适合沉淀成技能），还是一个一次性事件记录？\n' + ANCHOR + '\n' + '待评估文本：\n' + text,
      [
        '一次性事件或进展流水账（某次任务的结果/状态）',
        '具体到某次操作的记录，没有可重复执行的步骤',
        '介于事件与做法之间，隐含一些可复用的经验',
        '清晰可重复的做法或最佳实践，值得沉淀',
        '教科书式的稳定规范/工作流，直接可以写成技能',
      ],
    ),
  }
}

export class JevGate {
  #core = null
  #config
  #stateFile
  #logFile
  #bootError = null

  /**
   * @param {object} [configOverrides] partial config; missing keys take
   *   {@link DEFAULT_GATE_CONFIG}. `memoryDir` is required for the budget
   *   state file unless `budgetStateFile` is given.
   */
  constructor(configOverrides = {}, memoryDir = null) {
    this.#config = { ...DEFAULT_GATE_CONFIG, ...configOverrides }
    this.#stateFile = this.#config.budgetStateFile
      ?? (memoryDir ? join(memoryDir, 'jev-budget.json') : null)
    this.#logFile = this.#config.logFile
      ?? (memoryDir ? join(memoryDir, 'jev-log.jsonl') : null)

    // Construct eagerly: a live provider without an API key is a config
    // error we want to surface once at boot, not per suggestion. Construction
    // failure keeps the gate unavailable but never throws to callers.
    const jev = loadJevCore()
    if (jev === null) {
      this.#bootError = 'jev-core not found under ~/.dsh/plugins/dsh-jev (dsh-jev plugin missing?)'
      return
    }
    if (this.#config.provider === 'live' && !this.#config.apiKey) {
      this.#bootError = 'live provider configured without an apiKey — staying offline'
      return
    }
    try {
      const provider = this.#config.provider === 'live'
        ? new jev.LiveTypeSafeProvider({
            apiKey: this.#config.apiKey,
            model: this.#config.model,
            baseURL: this.#config.baseURL,
            timeoutMs: this.#config.timeoutMs,
            maxRetries: this.#config.maxRetries,
            logLevel: 'off',
          })
        : new jev.MockJevProvider({ model: this.#config.model })
      this.#core = jev.createJevCore({
        provider,
        mode: this.#config.mode,
        model: this.#config.model,
        redactKeys: [...jev.DEFAULT_REDACT_KEYS],
      })
    } catch (error) {
      this.#bootError = error?.message ?? String(error)
    }
  }

  /** Today's UTC date key (budget resets per UTC day, matching the daily track). */
  static budgetKey() {
    return new Date().toISOString().slice(0, 10)
  }

  #readBudget() {
    if (!this.#stateFile) return { day: JevGate.budgetKey(), calls: 0, costCny: 0 }
    try {
      if (existsSync(this.#stateFile)) {
        const parsed = JSON.parse(readFileSync(this.#stateFile, 'utf8'))
        if (parsed && typeof parsed === 'object') return parsed
      }
    } catch {
      // a corrupt budget file must never block a suggestion
    }
    return { day: JevGate.budgetKey(), calls: 0, costCny: 0 }
  }

  #writeBudget(state) {
    if (!this.#stateFile) return
    try {
      mkdirSync(join(this.#stateFile, '..'), { recursive: true })
      writeFileSync(this.#stateFile + '.tmp.' + process.pid, JSON.stringify(state, null, 2) + '\n')
      // atomic-ish rename; a rare crash leaves the tmp file, next write overwrites
      renameSync(this.#stateFile + '.tmp.' + process.pid, this.#stateFile)
    } catch {
      // budget persistence is best-effort
    }
  }

  /**
   * Append one execution record to the Jev log (best-effort, never throws):
   * one JSON line per labeling call so the audit sub-tab can replay history.
   */
  #log(record) {
    if (!this.#logFile) return
    try {
      mkdirSync(join(this.#logFile, '..'), { recursive: true })
      appendFileSync(this.#logFile, JSON.stringify(record) + '\n')
    } catch {
      // the log is diagnostics only — a failed append must never block a label
    }
  }

  /**
   * Read the execution log tail (newest first). Used by /api/audit/records.
   * A missing or corrupt file reads as empty; individual bad lines are skipped.
   * @param {number} limit - max records to return (default 100).
   * @returns {object[]} records
   */
  readLog(limit = 100) {
    if (!this.#logFile) return []
    let text
    try {
      text = readFileSync(this.#logFile, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return []
      return []
    }
    const records = []
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      try { records.push(JSON.parse(line)) } catch { /* skip malformed line */ }
    }
    return records.slice(-Math.max(1, limit)).reverse()
  }

  /**
   * Whether the gate is constructed and under budget. Cheap; safe to call per
   * suggestion. `bumped` accounts a pending call (we only learn the real cost
   * after the reply, but the call is already committed).
   */  #admissible(bumped = 0) {
    if (this.#core === null) return { ok: false, reason: 'unavailable', detail: this.#bootError }
    if (this.#config.enabled === false) return { ok: false, reason: 'disabled' }
    const budget = this.#readBudget()
    const day = JevGate.budgetKey()
    const rolled = budget.day !== day ? { day, calls: 0, costCny: 0 } : budget
    if (rolled.calls + bumped > this.#config.dailyCallLimit) return { ok: false, reason: 'limit' }
    if (rolled.costCny + bumped * (this.#config.estimatedCostCny ?? 0) > this.#config.dailyBudgetCny) {
      return { ok: false, reason: 'budget' }
    }
    return { ok: true, budget: rolled }
  }

  /**
   * Sensitive content never leaves the process: phone numbers, ID cards,
   * bank cards, secrets, credentials. Returns the reason string when blocked.
   */
  static containsSensitive(text) {
    const s = String(text ?? '')
    if (/1[3-9]\d{9}/.test(s)) return '手机号'
    if (/\d{15}(?:\d{2}[0-9Xx])?/.test(s)) return '身份证号'
    if (/\b\d{16,19}\b/.test(s)) return '银行卡号'
    if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(s)) return 'API 密钥'
    if (/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(s)) return 'Bearer 令牌'
    if (/(?:BEGIN\s+)?(?:RSA\s+)?(?:PRIVATE|PUBLIC)\s+KEY/i.test(s)) return '密钥'
    if (/(?:password|passwd|secret|token|apikey|api_key|authorization)\s*[:=]\s*\S+/i.test(s)) return '凭据'
    return null
  }

  /**
   * Label one candidate KEY entry. Never throws.
   * @param {string} text the suggested entry content
   * @returns {Promise<object>} `{ ok, gate, scores?, reason?, ...meta }` —
   *   `gate` is one of 'labeled' | 'skipped' | 'unavailable' | 'disabled' |
   *   'sensitive' | 'limit' | 'budget' | 'error'.
   */
  async label(text) {
    const content = String(text ?? '').trim()
    if (!content) return { ok: false, gate: 'skipped', reason: 'empty content' }
    if (this.#config.enabled === false) return { ok: false, gate: 'disabled', reason: 'gate off' }
    if (this.#core === null) {
      this.#log({ at: new Date().toISOString(), kind: 'label', gate: 'unavailable',
        contentPreview: '', reason: this.#bootError })
      return { ok: false, gate: 'unavailable', reason: this.#bootError }
    }
    const sensitive = JevGate.containsSensitive(content)
    if (sensitive) {
      this.#log({ at: new Date().toISOString(), kind: 'label', gate: 'sensitive',
        contentPreview: content.slice(0, 120), reason: sensitive })
      return { ok: false, gate: 'sensitive', reason: sensitive }
    }
    const adm = this.#admissible(1)
    if (!adm.ok) {
      this.#log({ at: new Date().toISOString(), kind: 'label', gate: adm.reason,
        contentPreview: content.slice(0, 120), reason: 'budget exhausted' })
      return { ok: false, gate: adm.reason, reason: 'budget exhausted' }
    }

    let result
    try {
      result = await this.#core.evaluate({
        state: content,
        questions: buildQuestions(content),
      })
    } catch (error) {
      // evaluate is documented as never-throwing; a throw here is a programming
      // error — still fail open, but report it loudly in the reason.
      this.#log({ at: new Date().toISOString(), kind: 'label', gate: 'error',
        contentPreview: content.slice(0, 120), reason: error?.message ?? String(error) })
      return { ok: false, gate: 'error', reason: error?.message ?? String(error) }
    }
    // accounting: count the call, estimate cost (mock: 0)
    const isLive = this.#config.provider === 'live'
    const cost = isLive ? (this.#config.estimatedCostCny ?? 0) : 0
    const next = { ...adm.budget, calls: adm.budget.calls + 1, costCny: +(adm.budget.costCny + cost).toFixed(6) }
    this.#writeBudget(next)

    if (!result.ok) {
      // jev-core keeps the structural violations in failure.detail (bounded:
      // no request body or provider payload); surface them so a transient
      // INVALID_RESPONSE is diagnosable from the queue instead of a bare code.
      const detail = Array.isArray(result.failure.detail) && result.failure.detail.length
        ? result.failure.detail.map((v) => v.path + ': ' + v.message).join(' | ')
        : null
      const reason = `${result.failure.code}: ${result.failure.message}${detail ? '—' + detail : ''}`
      this.#log({ at: new Date().toISOString(), kind: 'label', gate: 'error',
        contentPreview: content.slice(0, 120), reason,
        model: result.diagnostics?.model, provider: result.diagnostics?.provider })
      return {
        ok: false,
        gate: 'error',
        reason,
        model: result.diagnostics?.model,
        provider: result.diagnostics?.provider,
      }
    }
    const g = result.answers.generalization
    const s = result.answers.skill_shape
    const genScore = normalizeScore(g)
    const skillScore = normalizeScore(s)
    this.#log({
      at: new Date().toISOString(), kind: 'label', gate: 'labeled',
      contentPreview: content.slice(0, 120),
      scores: { generalization: genScore, skill_shape: skillScore },
      verdicts: {
        generalization: genScore >= this.#config.generalizationThreshold,
        skill_shape: skillScore >= this.#config.skillShapeThreshold,
      },
      thresholds: {
        generalization: this.#config.generalizationThreshold,
        skill_shape: this.#config.skillShapeThreshold,
      },
      model: result.diagnostics?.model,
      provider: result.diagnostics?.provider,
      latencyMs: result.diagnostics?.latencyMs,
    })
    return {
      ok: true,
      gate: 'labeled',
      scores: {
        generalization: genScore,
        skill_shape: skillScore,
      confidence: {
        generalization: g.confidence ?? null,
        skill_shape: s.confidence ?? null,
      },
    },
    verdicts: {
        generalization: genScore >= this.#config.generalizationThreshold,
        skill_shape: skillScore >= this.#config.skillShapeThreshold,
      },
      model: result.diagnostics?.model,
      provider: result.diagnostics?.provider,
      latencyMs: result.diagnostics?.latencyMs,
      thresholds: {
        generalization: this.#config.generalizationThreshold,
        skill_shape: this.#config.skillShapeThreshold,
      },
    }
  }

  /**
   * Replace the constructed provider (tests inject MockJevProvider scenarios).
   * Production code never calls this.
   */
  setProviderForTest(provider) {
    const jev = loadJevCore()
    if (jev === null) throw new Error('jev-core unavailable')
    this.#core = jev.createJevCore({
      provider,
      mode: this.#config.mode,
      model: this.#config.model,
      redactKeys: [...jev.DEFAULT_REDACT_KEYS],
    })
  }

  /** Whether the gate is live (not mock). */
  get isLive() { return this.#core !== null && this.#config.provider === 'live' }

  /** Health snapshot for the audit endpoint and the settings panel. */
  health() {
    return {
      available: this.#core !== null,
      enabled: this.#config.enabled !== false,
      provider: this.#config.provider,
      mode: this.#config.mode,
      bootError: this.#bootError,
      budget: this.#readBudget(),
      limits: {
        dailyCallLimit: this.#config.dailyCallLimit,
        dailyBudgetCny: this.#config.dailyBudgetCny,
      },
      thresholds: {
        generalization: this.#config.generalizationThreshold,
        skill_shape: this.#config.skillShapeThreshold,
      },
    }
  }

  /**
  * Bulk-label many texts. Used by the manual audit endpoint only; each row
  * is independent and one failure never aborts the batch.
  * @param {string[]} texts
  * @param {object} [opts] `{ signal }`
  */
  async audit(texts, opts = {}) {
    const rows = []
    for (const text of texts) {
      if (opts.signal?.aborted) break
      rows.push({ content: text, ...(await this.label(text)) })
    }
    return rows
  }

  /**
   * Adjudicate one staged skill for installation (v2 design §3.4).
   *
   * The two axes are conjunctive on purpose (§3.2): generalization high but
   * skill_shape low is a global fact that belongs in KEY, not in the skill
   * library; skill_shape high but generalization low is a project-only
   * practice that would pollute every session once installed. Only both axes
   * over threshold is a skill.
   *
   * Shares one threshold set with the KEY labeling path — never a second
   * copy of the configuration (§8.8 review checklist).
   *
   * @param {string} name - the kebab-case skill name (logging/correlation only).
   * @param {string} body - the SKILL.md content (frontmatter + body).
   * @param {string} [operationId] - the chain correlation id.
   * @returns {Promise<object>} `{ approved: boolean|null, scores?, reason,
   *   thresholds?, model?, provider?, latencyMs? }` — approved is null when
   *   Jev could not rule (unavailable / sensitive / over budget / error); the
   *   caller must then degrade to the human pending queue, never install and
   *   never discard (§8.2).
   */
  async auditSkill(name, body, operationId = undefined) {
    const outcome = await this.label(body)
    const thresholds = {
      generalization: this.#config.generalizationThreshold,
      skill_shape: this.#config.skillShapeThreshold,
    }
    if (!outcome.ok) {
      // fail-open as "no verdict": the skill stays staged and the caller
      // moves it to the human pending queue. This is not fail-dangerous
      // (never installs) and not lossy (never deletes).
      return {
        approved: null,
        reason: outcome.reason,
        gate: outcome.gate,
        thresholds,
        model: outcome.model,
        provider: outcome.provider,
      }
    }
    const g = outcome.scores.generalization
    const s = outcome.scores.skill_shape
    const approved = g >= thresholds.generalization && s >= thresholds.skill_shape
    const reason = approved
      ? `双轴过阈（通用性 ${g.toFixed(3)} >= ${thresholds.generalization}，技能形态 ${s.toFixed(3)} >= ${thresholds.skill_shape}）`
      : `未过阈：通用性 ${g.toFixed(3)}（阈值 ${thresholds.generalization}）/ 技能形态 ${s.toFixed(3)}（阈值 ${thresholds.skill_shape}）`
    return {
      approved,
      scores: outcome.scores,
      verdicts: outcome.verdicts,
      thresholds,
      reason,
      model: outcome.model,
      provider: outcome.provider,
      latencyMs: outcome.latencyMs,
    }
  }

  /**
   * Append one skill-chain execution record (v2 design §3.5/§8.4). Same log
   * file as KEY labels; the `kind` field separates the chains and the UI
   * groups by it. Best-effort, never throws, never writes the skill body,
   * secrets, or tokens.
   * @param {object} record - must carry `kind`; recommended fields:
   *   operationId, at, name, contentHash, source, gate, scores, thresholds,
   *   approved, destination, reason, model, provider, latencyMs.
   */
  logSkill(record) {
    this.#log({ at: new Date().toISOString(), ...(record && typeof record === 'object' ? record : {}) })
  }
}
