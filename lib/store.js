/**
 * dsh-memory-evolve — memory storage layer.
 *
 * Hermes-compatible persistent curated memory: plain-text files with `\n§\n`
 * entry delimiters, per-target character limits, a cross-process lock file,
 * atomic writes, and a drift guard that refuses full-file rewrites when the
 * on-disk content would not round-trip through the parser (manual edits,
 * shell appends, or sister-process writes).
 *
 * Write semantics mirror the Hermes memory tool:
 *   - add: append-only, skips the drift guard (never clobbers parsed entries),
 *     but refuses a file that exists and reads as empty (would wipe history);
 *   - replace / remove: match by a short unique substring, enforce the drift
 *     guard (full-file rewrite would discard un-roundtrippable content), back
 *     up drifted files to `<file>.bak.<timestamp>` before refusing.
 *
 * All operations are synchronous (files are tiny) and serialized through one
 * lock file per directory so multiple DSH processes or external editors
 * cannot interleave writes.
 *
 * Zero runtime dependencies (node:fs only).
 *
 * @module dsh-memory-evolve/store
 */

import { createHash } from 'node:crypto'
import { getLocale, translate, STORE_DICT, STORE_TAIL_DICT } from './i18n.js'

/** Translate through STORE_DICT in the active host locale. */
const st = (key, params) => translate(STORE_DICT, key, params, getLocale())
/** Translate through STORE_TAIL_DICT in the active host locale. */
const stt = (key, params) => translate(STORE_TAIL_DICT, key, params, getLocale())
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { extractEntryId, genEntryId, legacyIdFor, stripEntryId } from './sync/entryid.js'

/** Entry delimiter, byte-compatible with Hermes MEMORY.md / USER.md. */
export const ENTRY_DELIMITER = '\n§\n'

/** A lock file older than this is considered abandoned (stale). */
const STALE_LOCK_MS = 10_000
/** How long to keep waiting for the lock before failing loud. */
const LOCK_TIMEOUT_MS = 5_000
/**
 * 锁龄硬上限：pid 探活只能证明「某进程活着」，Windows PID 复用会让崩溃
 * 进程的残锁被无关新进程「续命」→ 残锁永活、写路径跨重启全灭（审计
 * P1-5）。锁龄超此值一律判 stale（锁内操作为毫秒级，60s 已是极端余量）。
 */
const LOCK_STALE_HARD_MS = 60_000/** Spin interval while waiting for the lock. */
const LOCK_RETRY_MS = 25

/**
 * Split raw file text into trimmed, non-empty entries.
 * @param {string} text - raw file content.
 * @returns {string[]} the entries.
 */
export function parseEntries(text) {
  return text
    .split(ENTRY_DELIMITER)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Serialize entries into canonical file text (entries joined by the
 * delimiter plus a trailing newline).
 * @param {string[]} entries - the entries.
 * @returns {string} canonical file content.
 */
/** Extract the `YYYY-MM-DD` date from an entry's stamp prefix; null when absent. */
export function extractEntryDate(entry) {
  // 身份证 [id:…] 在最前（跨设备合并锚点）：先剥离再匹配日期，否则带 ID
  // 的条目全部判为"无日期"（审查 P1：since/until/earliest/latest 失效）
  const match = /^\[(\d{4}-\d{2}-\d{2})/.exec(stripEntryId(entry))
  return match ? match[1] : null
}

/**
 * Branch-scope tag inside a KEY entry: `[2026-08-06] [branch:main,dev] 内容`.
 * Absent = visible in EVERY branch ("全部"). Multiple branches are a
 * comma-separated list; the tag always follows the date stamp.
 */
export const BRANCH_TAG_RE = /(?:^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*)?\[branch:([^\]]*)\]\s*/

/**
 * 头部前缀（[branch:] 之前的合法序列）：[id] → 时间戳 → [git …]×N。
 * 供 parseEntryBranches 锚定——正文里出现的字面 [branch:…] 不算作用域。
 */
const BRANCH_HEAD_PREFIX_RE = /^(?:\[id:[0-9a-f]{8}\]\s*)?(?:\[\d{4}-\d{2}-\d{2}(?: \d{1,2}:\d{2}(?::\d{2})?)?\]\s*|\[\d{1,2}:\d{2}(?::\d{2})?\]\s*)?(?:\[git [^\]]+\]\s*)*/

/**
 * Parse the branch scope of one KEY entry.
 * 只认头部位置的 [branch:…]（[id]/时间戳/[git …] 之后、正文之前）——
 * 正文里出现的字面 [branch:main]（如记录本机制自身的记忆）不算作用域
 * （审计 P1-2：此前未锚定，正文字面会劫持分支过滤、注入被静默误滤）。
 * @param {string} entry - the full entry text.
 * @returns {string[] | null} the branch names, or null when the entry has no
 *   branch tag (meaning "all branches").
 */
export function parseEntryBranches(entry) {
  const text = String(entry ?? '')
  const prefix = BRANCH_HEAD_PREFIX_RE.exec(text)
  if (prefix === null) return null
  const match = /^\[branch:([^\]]*)\]\s*/.exec(text.slice(prefix[0].length))
  if (match === null) return null
  const branches = match[1].split(',').map((b) => b.trim()).filter(Boolean)
  return branches.length > 0 ? branches : null
}

/**
 * 「仅 DSH」标记（tag）：`[2026-08-06] [dsh-only] 内容`，属程序元数据 tag
 * 之一（位置在时间戳与 [branch:…] 之后、正文之前）。
 *
 * 语义：该条目只适用于 DSH 自身（DSH 纪律/规则/架构类事实——外部执行器
 * 不是 DSH，不必遵循 DSH 规则）。因此：
 *   - DSH 自身快照注入：照常注入（本来就是给 DSH 的）；
 *   - 注入外部执行器（COI 任务的 injectTracks 记忆注入）：整条跳过
 *     （buildMemoryContext 的 excludeDshOnly 选项负责过滤）。
 * 由记忆 Tab 的条目操作按钮（MemoryStore.setEntryDshOnly）维护；编辑正文
 * 时经 splitEntryHead 原样保留，与 [branch:…] 同等对待。
 */
export const DSH_ONLY_TAG = '[dsh-only]'

/** 条目内 [dsh-only] 标记的正则（任意位置出现即视为已标记，兼容手写文件）。 */
export const DSH_ONLY_RE = /\[dsh-only\]\s*/

/**
 * 解析一条记忆条目是否带「仅 DSH」标记。
 * 只认头部位置的 [dsh-only] token（ENTRY_HEAD_RE 消耗的头部序列内）——
 * 正文里出现的字面（如记录本机制的记忆）不算标记（审计 P1-3：未锚定时
 * 正文字面会让 COI 外部执行器注入静默跳过该条目）。
 * @param {string} entry - 完整条目文本。
 * @returns {boolean} true = 该条目只适用于 DSH，注入外部执行器时跳过。
 */
export function parseEntryDshOnly(entry) {
  const head = ENTRY_HEAD_RE.exec(String(entry ?? ''))
  if (head === null) return false
  return head[0].includes('[dsh-only]')
}

/**
 * 剥离头部位置的 [dsh-only] token（若有）；正文里的同名字面不动。
 * setEntryDshOnly 重建条目时用——此前裸 replace(DSH_ONLY_RE) 会删掉
 * 正文首处字面（单向数据丢失，审计 P1-3 探针 S5 实证）。
 * @param {string} entry - 完整条目文本。
 * @returns {string} 无头部 [dsh-only] token 的条目文本。
 */
export function stripEntryDshOnly(entry) {
  const text = String(entry ?? '')
  const head = ENTRY_HEAD_RE.exec(text)
  if (head === null || !head[0].includes('[dsh-only]')) return text
  const strippedHead = head[0].replace(/\[dsh-only\]\s*/, '')
  return strippedHead + text.slice(head[0].length)
}

/**
 * 「摘要」标记（tag）：`[2026-08-15] [summary:一句话摘要] 内容`，属程序元数据 tag
 * 之一（位置在时间戳与 [branch:…]、[dsh-only] 之后、正文之前）。
 *
 * 语义：该条目的摘要，用于渐进式披露时注入系统提示词（减少 token）。
 * 由 memory 工具 add action 的 summary 参数写入；编辑条目时经 splitEntryHead
 * 原样保留，与 [branch:…]、[dsh-only] 同等对待。
 */
export const SUMMARY_TAG_RE = /\[summary:([^\]]*)\]/

/**
 * 「重要性」标记（tag）：`[salience:N]`（N ∈ 1-3），程序元数据 tag 之一。
 * 位置在 [summary:…]（若有）之后、正文之前（autopilot-memory-lifecycle
 * Step 3，AC-2.1）。语义：条目重要性三档（1=低 2=中 3=高）；无 tag 视为
 * 2（中档，由调用方归一——parseEntrySalience 返回 null 表示无 tag）。
 * 仅显式传参写入（memory add 的 salience 参数，整数 1-3 钳制；不做 LLM
 * 自动打分，Q3 缺省决策）；仅 memory/user/key 轨写 tag（project/daily
 * 日志轨不标）。编辑条目时经 splitEntryHead 原样保留（head token）。
 *
 * 值域钉死 [1-3]（一位数字）：正文里出现的字面 [salience:9] 等越界值
 * 天然不满足头部解析（AC-2.3 负向：注入必红——正文含同名文本不得误解析）。
 */
export const SALIENCE_TAG_RE = /\[salience:([1-3])\]/

/**
 * 摘要文本上限（渐进式披露 v2，2026-09-28 用户批准批次）：显式 [summary:…]
 * 与 autoSummary 兜底摘要统一截断到 120 字。取值依据：agent-out 实测量化
 * （摘要 ≤120 字 + 正文 >400 折叠 → 全注入轨省 61.0%）；更短（80）省得更多，
 * 但条目标题/文件:行号锚点/关键数字的丢失率上升。**单一事实源**——工具层
 * add/retag 的写入口径（normalizeSummaryText）与 autoSummary 兜底共用本常量，
 * 避免「写入 118 字、注入又被截到 80」的双口径漂移。
 */
export const SUMMARY_MAX_CHARS = 120

/**
 * 摘要文本清洗（单一事实源，工具层 add/retag 与本文件 autoSummary 共用）：
 * 换行会让 [summary:…] 跨行；']' 会让解析正则 [^\]]* 提前截断（剩余文字漏进
 * 正文、stripEntrySummary 失配）——二者都是 LLM 自由文本参数常见字符，必须
 * 先去掉。随后折叠连续空白，最后按 SUMMARY_MAX_CHARS 截断（不补省略号，
 * 保持「头部 token」简洁；autoSummary 的兜底摘要另有省略号标记）。
 * @param {unknown} summary - 摘要原始值（工具参数/自动摘要输入）。
 * @returns {string} 清洗后的摘要；空串 = 调用方不得写 tag。
 */
export function normalizeSummaryText(summary) {
  return String(summary ?? '').replace(/[\n\r\t\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX_CHARS)
}

/** 头部位置的 salience token（含尾随空白；锚定用，value 捕获同 SALIENCE_TAG_RE）。 */
const SALIENCE_HEAD_TOKEN_RE = /^\[salience:([1-3])\]\s*/

/** 头部位置的 summary token（含尾随空白；parseEntrySalience/stripEntrySalience 共用）。 */
const SUMMARY_HEAD_TOKEN_RE = /^\[summary:[^\]]*\]\s*/

/**
 * 条目头部（程序元数据前缀）的正则：[id:…] → 时间戳（日期 / 日期时间 /
 * 时分）→ [git …]×N → [branch:…] → [dsh-only]，按 splitEntryHead 的已知
 * token 顺序匹配。summary 解析与剥离都以它锚定头部——正文里出现的
 * [summary:…] 文本（如 "[foo] [summary:bar]"）不在 head 序列中，不会被
 * 误当显式摘要（审查修复：SUMMARY_TAG_RE 此前未锚定，正文含同名文本
 * 会被误解析）。
 */
const ENTRY_HEAD_RE = /^(?:\[id:[0-9a-f]{8}\]\s*)?(?:\[\d{4}-\d{2}-\d{2}(?: \d{1,2}:\d{2}(?::\d{2})?)?\]\s*|\[\d{1,2}:\d{2}(?::\d{2})?\]\s*)?(?:\[git [^\]]+\]\s*)*(?:\[branch:[^\]]*\]\s*)?(?:\[dsh-only\]\s*)?/

/**
 * 解析一条记忆条目的摘要标签（只认头部位置的 [summary:…]）。
 * @param {string} entry - 完整条目文本。
 * @returns {string | null} 摘要文本，或 null（无显式摘要）。
 */
export function parseEntrySummary(entry) {
  const text = String(entry ?? '')
  const head = ENTRY_HEAD_RE.exec(text)
  if (head === null) return null
  const match = /^\[summary:([^\]]*)\]\s*/.exec(text.slice(head[0].length))
  return match ? match[1] : null
}

/**
 * 解析一条记忆条目的重要性标签（只认头部位置：ENTRY_HEAD_RE 之后、
 * 至多隔一个 [summary:…]——与 stampEntry 写入顺序一致；容错手写乱序）。
 * @param {string} entry - 完整条目文本。
 * @returns {1 | 2 | 3 | null} 重要性档位；null = 无 tag（调用方视为 2 中档归一）。
 */
export function parseEntrySalience(entry) {
  const text = String(entry ?? '')
  const head = ENTRY_HEAD_RE.exec(text)
  if (head === null) return null
  let rest = text.slice(head[0].length)
  // 头部序列（stampEntry 固定顺序）：可选 [summary:…] → 可选 [salience:N]。
  // 两个 tag 各至多匹配一次、任意先后（手写文件容错）；超出该位置的
  // [salience:…]（如正文字面 "[salience:9]"）不在头部序列中，不解析。
  const salFirst = SALIENCE_HEAD_TOKEN_RE.exec(rest)
  if (salFirst !== null) return Number(salFirst[1])
  const sumFirst = SUMMARY_HEAD_TOKEN_RE.exec(rest)
  if (sumFirst !== null) {
    const salSecond = SALIENCE_HEAD_TOKEN_RE.exec(rest.slice(sumFirst[0].length))
    if (salSecond !== null) return Number(salSecond[1])
  }
  return null
}

/**
 * 从条目正文自动生成摘要（无显式 [summary:...] 时的兜底）。
 * 剥离所有头部标记后取正文第一行，截断到 maxLen 字。
 *
 * ⚠️ 兜底摘要的默认上限 = SUMMARY_MAX_CHARS（120，2026-09-28 渐进式披露 v2）：
 * MEMORY.md 等轨的条目多为**单行长段**（实测 182 条/86,804 字符，均值 477），
 * 「取首行」本身几乎不省字符——截断才是摘要模式的主要收益来源。此前默认 80
 * 与显式 [summary:…] 的 120 上限不一致（写入更长的摘要却被注入层砍短），
 * 本次统一到同一常量。
 * @param {string} entry - 完整条目文本。
 * @param {number} [maxLen=SUMMARY_MAX_CHARS] - 最大长度。
 * @returns {string} 自动生成的摘要。
 */
export function autoSummary(entry, maxLen = SUMMARY_MAX_CHARS) {
  // 剥离头部标记：复用 ENTRY_HEAD_RE（与 splitEntryHead / stripEntrySummary
  // 同一 head 序列：[id] → 时间戳（日期/日期时间/时分）→ [git …]×N →
  // [branch:…] → [dsh-only] → [summary:…]）。审查修复：此前逐条 ^ 锚定
  // replace 漏了 [git …] 与 [HH:MM]，带这些标记的条目后续剥离失配，
  // 元数据（如 [git main]）会混进自动摘要注入提示词。
  const rest = entryBodyOf(entry)

  // 取正文第一行
  const firstLine = rest.split('\n')[0].trim()
  if (firstLine.length <= maxLen) return firstLine
  return firstLine.slice(0, maxLen - 1) + '…'
}

/**
 * 条目**正文**（剥离全部头部程序元数据后的部分，逐字保留换行）。
 *
 * 渐进式披露 v2（2026-09-28）：按条目长度折叠需要「正文长度」这一口径——
 * 头部 token（[id:…]/时间戳/[git …]/[branch:…]/[dsh-only]/[summary:…]/
 * [salience:N]）长度因条目而异（0-40 字符），用整条原文长度会把这些元数据
 * 计进阈值，语义上说不通。本函数与 autoSummary 共用同一剥离循环（单一事实
 * 源），返回**未 trim 的完整正文**（保留内部换行），调用方自行 trim/取行。
 * @param {string} entry - 完整条目文本。
 * @returns {string} 正文（可能含换行；无正文时为空串）。
 */
export function entryBodyOf(entry) {
  let rest = String(entry ?? '').trim()
  const head = ENTRY_HEAD_RE.exec(rest)
  if (head !== null) rest = rest.slice(head[0].length)
  // P2-5 修复：手写条目的头部 tag 顺序不定
  // （parseEntrySalience / stripEntrySalience 均已双向乱序容错），固定顺序
  // 各剥一次会漏（"[salience:2] [summary:…]" 形态残留 [summary:] 字面）——
  // 改为循环交替剥头部 token 至不再变化。
  for (;;) {
    const before = rest
    rest = rest.replace(/^\[summary:[^\]]*\]\s*/, '')
    // 重要性 tag 同为头部程序元数据（Step 3）：摘要注入不得混入 [salience:N]
    rest = rest.replace(/^\[salience:[1-3]\]\s*/, '')
    if (rest === before) break
  }
  return rest
}

/**
 * 展示剥离「摘要」标记：全量注入/读取全文时，正文已完整，[summary:...]
 * 是仅供摘要模式注入用的程序元数据，不应显示（避免与正文重复、浪费 token）。
 * 只剥离头部位置的 summary tag（时间戳/[id]/[branch]/[dsh-only] 之后、
 * 正文之前），正文中出现的同名文本不动。
 * @param {string} entry - 完整条目文本。
 * @returns {string} 无 summary 标记的条目文本。
 */
export function stripEntrySummary(entry) {
  // 只按已知 head token 顺序匹配（ENTRY_HEAD_RE，与 splitEntryHead 一致）：
  // [id] → 时间戳（日期 / 日期时间 / 时分）→ [git …]×N → [branch:…] →
  // [dsh-only] → [summary:…]。正文里出现的 [summary:…] 文本（如
  // "[foo] [summary:bar]"）不在 head 序列中，不会被误剥。
  const match = ENTRY_HEAD_RE.exec(String(entry ?? ''))
  const prefix = match === null ? '' : match[0]
  const rest = String(entry ?? '').slice(prefix.length)
  return prefix + rest.replace(/^\[summary:[^\]]*\]\s*/, '')
}

/**
 * 展示剥离「重要性」标记（Step 3，AC-2.4）：全量注入与工具回显的正文已
 * 完整，[salience:N] 是仅供衰减调度/分层注入用的程序元数据，不应显示。
 * 只剥离头部位置的 salience tag（ENTRY_HEAD_RE 之后、至多隔一个
 * [summary:…]——与 parseEntrySalience 同一头部序列，容错乱序），正文中
 * 出现的字面 [salience:…] 不动。对无 tag 条目零变化（黄金基线守住）。
 * 与 stripEntrySummary 组合使用（stripEntrySalience(stripEntrySummary(…))），
 * 两函数各自幂等、任意组合等价于按序剥离。
 * 修复轮注（评审 P1-1）：[summary:…] 在本函数内只是**定位跳板**、绝不剥除
 * ——summary 属 stripEntrySummary 的职责，单独调用本函数时只剥 salience、
 * 用户显式摘要原样保留（此前两个分支都会连带剥 summary，与函数名矛盾）。
 * @param {string} entry - 完整条目文本。
 * @returns {string} 无 salience 标记的条目文本（summary tag 不受影响）。
 */
export function stripEntrySalience(entry) {
  const match = ENTRY_HEAD_RE.exec(String(entry ?? ''))
  const prefix = match === null ? '' : match[0]
  const rest = String(entry ?? '').slice(prefix.length)
  // 与 parseEntrySalience 同一头部序列（可选 summary → 可选 salience，容错乱序）。
  // salience 在前：只剥 salience，其后的 summary（若有）原样保留。
  const salFirst = SALIENCE_HEAD_TOKEN_RE.exec(rest)
  if (salFirst !== null) return prefix + rest.slice(salFirst[0].length)
  // summary 在前：跳过 summary 定位其后的 salience，只剥 salience 一段。
  const sumFirst = SUMMARY_HEAD_TOKEN_RE.exec(rest)
  if (sumFirst !== null) {
    const after = rest.slice(sumFirst[0].length)
    const salSecond = SALIENCE_HEAD_TOKEN_RE.exec(after)
    if (salSecond !== null) {
      return prefix + rest.slice(0, sumFirst[0].length) + after.slice(salSecond[0].length)
    }
  }
  // 无 salience（无论有无 summary）：原样返回（P1-1 行为契约）。
  return prefix + rest
}

/**
 * 存量补标（PR #66 后续增强，块 6）：在条目上重打 [salience:N] 重要性
 * 标签——先剥旧 tag（stripEntrySalience，容错乱序）再在头部序列末尾
 * （[id]→时间戳→[git]→[branch]→[dsh-only]→[summary:] 之后、正文之前，
 * 与 stampEntry 写入顺序一致）盖新 tag。**正文逐字不动**；[id:] 与
 * [summary:] 原样保留（tag-only 重写，不换生命周期、不重新盖时间戳）。
 * 对无时间戳的裸条目，新 tag 落在最前（`[salience:N] 原文`）。
 * @param {string} entry - 完整条目文本（原样）。
 * @param {number} salience - 新重要性档位（1-3，调用方已归一钳制）。
 * @returns {string} 重打标签后的条目文本。
 */
export function retagEntry(entry, salience) {
  return retagEntryMeta(entry, { salience })
}

/**
 * 条目头部元数据标记的**整体重写**（渐进式披露 v2，2026-09-28）：只重写
 * 头部元数据 token（[summary:…] / [salience:N]），**正文逐字不动**。
 *
 * 这是批量回填摘要的执行机制——为存量条目补一行摘要无需重发整条正文
 *（MEMORY.md 单条均值 477 字符，131 条重发 = 62K 字符纯浪费，且有正文被
 * 模型顺手改写的风险）。
 *
 * 语义（与 stampEntry 的写入顺序一致 = summary 在前、salience 在后）：
 *   - `salience` 提供 → 覆盖为 [salience:N]；`undefined` → **保留**原 tag
 *     （可能为 null = 无 tag）；
 *   - `summary` 提供（非空字符串）→ 覆盖为 [summary:清洗+截断]；
 *     `undefined` → **保留**原摘要；空串 → 视为清除该 tag；
 *   - 正文 = 剥离全部头部 token 之后逐字节切片，输出原样回写。
 *
 * 头部 token 的识别沿用 parseEntrySalience 的容错口径：ENTRY_HEAD_RE 之后
 * 至多一个 [summary:…] 与至多一个 [salience:1-3]，任意先后、各只消费一次；
 * 之后的内容一律算正文（正文字面里的 [salience:9] 等不受影响）。
 * @param {string} entry - 完整条目文本（原样）。
 * @param {object} [meta] - { salience?: number, summary?: string }。
 * @returns {string} 重写头部元数据后的条目文本（正文逐字保留）。
 */
export function retagEntryMeta(entry, meta = {}) {
  const { salience, summary } = meta
  const text = String(entry ?? '')
  const head = ENTRY_HEAD_RE.exec(text)
  const prefix = head === null ? '' : head[0]
  let rest = text.slice(prefix.length)
  let existingSummary = null
  let existingSalience = null
  for (;;) {
    if (existingSummary === null) {
      const sum = SUMMARY_HEAD_TOKEN_RE.exec(rest)
      if (sum !== null) {
        existingSummary = /^\[summary:([^\]]*)\]/.exec(sum[0])?.[1] ?? ''
        rest = rest.slice(sum[0].length)
        continue
      }
    }
    if (existingSalience === null) {
      const sal = SALIENCE_HEAD_TOKEN_RE.exec(rest)
      if (sal !== null) {
        existingSalience = Number(sal[1])
        rest = rest.slice(sal[0].length)
        continue
      }
    }
    break
  }
  const keepSummary = summary === undefined ? existingSummary : normalizeSummaryText(summary)
  const keepSalience = salience === undefined
    ? existingSalience
    : (typeof salience === 'number' && Number.isInteger(salience) && salience >= 1 && salience <= 3 ? salience : existingSalience)
  const tags = []
  if (keepSummary !== null && keepSummary !== '') tags.push(`[summary:${keepSummary}] `)
  if (keepSalience !== null) tags.push(`[salience:${keepSalience}] `)
  return prefix + tags.join('') + rest
}

export function serializeEntries(entries) {
  return entries.join(ENTRY_DELIMITER) + '\n'
}

/**
 * 剥离一条目的全部前缀标记：时间戳 + `[git …]` 程序分支标记 + `[branch:…]`
 * 分支范围 + daily 项目 tag，返回前缀 head 与正文 body。与记忆 Tab 美观视图
 * 的解析规则保持一致——编辑条目时用 head + 新正文重写，时间戳与所有 tag
 * 原样保留（程序维护的元数据不可被编辑改动）。
 * @param {string} entry - 完整条目原文。
 * @param {string} target - 'memory' | 'user' | 'daily' | 'project' | 'key'。
 * @returns {{head: string, body: string}}
 */
export function splitEntryHead(entry, target) {
  let rest = String(entry ?? '').trim()
  const timeRe = target === 'project' ? /^\[(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(?::\d{2})?)\]\s*/
    : target === 'daily' ? /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/
      : /^\[(\d{4}-\d{2}-\d{2})\]\s*/
  const tokens = []
  // [id:xxxxxxxx] 条目身份证（跨设备合并锚点，施工图 §4.1）：最优先剥离，
  // 先于时间戳 —— 它是"程序维护的元数据"，编辑条目时原样保留（head 里）。
  const idMatch = /^\[id:([0-9a-f]{8})\]\s*/.exec(rest)
  if (idMatch !== null) {
    tokens.push(idMatch[0])
    rest = rest.slice(idMatch[0].length)
  }
  const timeMatch = timeRe.exec(rest)
  if (timeMatch !== null) {
    tokens.push(timeMatch[0])
    rest = rest.slice(timeMatch[0].length)
  }
  // 程序分支标记 [git …]（daily / project 按会话 cwd 盖戳）
  for (;;) {
    const gitMatch = /^\[git ([^\]]+)\]\s*/.exec(rest)
    if (gitMatch === null) break
    tokens.push(gitMatch[0])
    rest = rest.slice(gitMatch[0].length)
  }
  // key 分支范围 [branch:…]
  const branchMatch = /^\[branch:[^\]]*\]\s*/.exec(rest)
  if (branchMatch !== null) {
    tokens.push(branchMatch[0])
    rest = rest.slice(branchMatch[0].length)
  }
  // 「仅 DSH」标记 [dsh-only]（branch 之后、正文之前；程序元数据，编辑保留）
  const dshOnlyMatch = /^\[dsh-only\]\s*/.exec(rest)
  if (dshOnlyMatch !== null) {
    tokens.push(dshOnlyMatch[0])
    rest = rest.slice(dshOnlyMatch[0].length)
  }
  // 「摘要」标记 [summary:...]（dsh-only 之后、正文之前；程序元数据，编辑保留）
  const summaryMatch = /^\[summary:[^\]]*\]\s*/.exec(rest)
  if (summaryMatch !== null) {
    tokens.push(summaryMatch[0])
    rest = rest.slice(summaryMatch[0].length)
  }
  // 「重要性」标记 [salience:N]（summary 之后、正文之前；Step 3，AC-2.1——
  // 程序元数据，编辑保留进 head；值域 [1-3] 钉死，正文里的字面
  // [salience:9] 等越界值不满足头部形态，仍留在正文不受影响）
  const salienceMatch = /^\[salience:[1-3]\]\s*/.exec(rest)
  if (salienceMatch !== null) {
    tokens.push(salienceMatch[0])
    rest = rest.slice(salienceMatch[0].length)
  }
  // daily 项目 tag（时间戳后的第一个任意 [...]）
  if (target === 'daily') {
    const tagMatch = /^\[([^\]]+)\]\s*/.exec(rest)
    if (tagMatch !== null) {
      tokens.push(tagMatch[0])
      rest = rest.slice(tagMatch[0].length)
    }
  }
  return { head: tokens.join(''), body: rest }
}

/**
 * 读取项目 PROVENANCE（记忆同步身份记录，一行 JSON）。容错：不存在/损坏
 * 返回 null。存于 store.js 而非 sync 层——避免循环依赖（repo.js imports
 * store.js），且 MemoryStore 判定 syncedTrack 需要它。
 * @param {string} dir - 项目记忆目录。
 * @returns {object | null} { projectId, displayName, enabled, tracks, ... }。
 */
export function readProvenance(dir) {
  const p = join(dir, 'PROVENANCE')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8').trim())
  } catch {
    return null
  }
}

/**
 * 项目同步开关判定（2026-08-11 用户拍板三层开关）：项目已初始化（PROVENANCE
 * 存在）**且** enabled !== false 才算参与同步。项目开关关闭后新条目不再
 * 生成身份证（维持"未启用"的本地状态）。
 * @param {string} dir - 项目记忆目录。
 * @returns {boolean}
 */
export function isProjectSyncEnabled(dir) {
  // 三层开关第 2 层语义（2026-08-11 用户拍板 + Codex 终审 P1-5 修正）：
  // **PROVENANCE 缺失 = 未初始化 = 未 opt-in = 不启用**——只有显式初始化
  // 过（setup 写入 PROVENANCE）且 enabled !== false 的项目才参与同步。
  // 此前"缺失=默认启用"会让全局模块开关一开就给未 opt-in 项目的 KEY/日志
  // 生成身份证，违背"未打开的项目保持纯本地状态、不生成身份证"的拍板。
  const meta = readProvenance(dir)
  return meta !== null && meta.enabled !== false
}

/**
 * 匹配用的归一化：剥掉**展示层不会显示的程序元数据**，只用于"这是不是同一条"
 * 的判定，绝不用于写盘内容（写盘一律用磁盘原文）。
 *
 * 必须与展示层剥离的元数据集合严格一致，否则前端把展示文本当 raw 回传时
 * 匹配必然失败（issue #59）：
 *   - `[id:…]`：跨设备合并锚点，展示剥离（2026-08-11 首次踩坑）；
 *   - `[summary:…]`：渐进式披露摘要，展示剥离（2026-08-17 引入，当时漏了
 *     匹配层）；
 *   - `[salience:N]`：条目重要性标记，展示剥离（2026-09-24 生产实证，同一
 *     个坑第三次踩到——中缀标签让"剥掉标签的展示文本 ≠ 磁盘原文"，全部 Tab
 *     条目操作报「主轨不存在该条目」）。
 * 结论：**展示层每剥一种新元数据，匹配层必须同步扩展**——两处实现见
 * `memory-tab.js` 的 buildMemoryFiles() 与 `src/client/MemoryTabView.tsx`。
 *
 * 两侧（磁盘原文 / 展示文本）都过同一个函数，因此比较天然对齐；三个 strip
 * 都只作用于条目头部的 token 序列，正文里的同名字面量不受影响。
 * @param {string} entry - 条目文本（磁盘原文或展示文本均可）。
 * @returns {string} 归一化后的可比文本。
 */
export function normalizeForMatch(entry) {
  return stripEntrySalience(stripEntrySummary(stripEntryId(String(entry ?? '').trim())))
}

/**
 * 展示形态（`normalizeForMatch` 的别名，2026-09-24 起同名同实现）：记忆 Tab
 * 渲染文本与服务端精确匹配共用同一条剥离链（剥 [id:]/[summary:]/[salience:]）。
 * 保留本名字是为了兼容既有调用方与 tests/tab-exact-match.test.js。
 * @param {string} entry - 条目原文（或展示文本，幂等）。
 * @returns {string} 展示形态文本。
 */
export function entryDisplayForm(entry) {
  return normalizeForMatch(entry)
}

/**
 * 精确匹配索引（对展示层剥离的程序元数据免疫）：用 normalizeForMatch 做
 * 相等比较——展示层剥掉 `[id:…]` / `[summary:…]` / `[salience:N]` 后回传的
 * 文本仍能命中磁盘原文（审查 P0：Tab/API 精确操作在启用 sync 后失效；
 * issue #59：带 `[summary:…]` 的条目删不掉/改不了/归档不了）。
 * @param {string[]} entries - 磁盘上的条目数组。
 * @param {string} exact - 待匹配的整条文本。
 * @param {object} [options]
 * @param {boolean} [options.first=false] - 多条命中时的取舍：false 报歧义
 *   （主轨用——重复条目属数据异常，保守拒绝）；true 取首条（归档轨用——
 *   归档本来就允许同一内容重复出现，且归档页只可能点到其中一条）。
 * @returns {number} 命中下标；未命中返回 -1。
 */
function findExactIndex(entries, exact, { first = false } = {}) {
  const target = normalizeForMatch(exact)
  let found = -1
  for (let i = 0; i < entries.length; i++) {
    if (normalizeForMatch(entries[i]) === target) {
      if (found !== -1 && !first) return -1 // 多条命中 → 歧义，拒绝
      if (found === -1) found = i
    }
  }
  return found
}

/**
 * Whether raw text is the canonical serialization of its own entries.
 * Blank text counts as canonical (an empty store).
 * @param {string} text - raw file content.
 * @returns {boolean} true when the file would round-trip through the parser.
 */
export function isCanonical(text) {
  return text.trim() === '' || serializeEntries(parseEntries(text)) === text
}

/** Blocking sleep used by the lock retry loop (synchronous). */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Directories whose lock this process currently holds (reentrancy guard). */
const heldLocks = new Set()

/**
 * Acquire the directory lock exclusively (cross-process), run `fn`, release.
 * Reentrant within this process: a nested withLock on the same directory
 * proceeds directly (all mutations are synchronous, so the outer section is
 * still exclusive against other processes).
 * @param {string} dir - the directory whose lock to take.
 * @param {() => T} fn - the critical section.
 * @returns {T} the section's return value.
 * @template T
 */
/** 锁文件内容（pid/token）：断电中断后残留锁可凭 pid 存活检测立即识别。 */
const LOCK_JSON = () => JSON.stringify({ pid: process.pid, at: Date.now() })

/**
 * stale 锁判断（导出供 worker 异步锁复用）：mtime 超时，或锁文件里的
 * pid 已不存活（进程被 kill/断电——残留锁立即清除，不用等 stale 超时）。
 * @param {string} lockPath - 锁文件路径。
 * @returns {boolean}
 */
export function isStaleLock(lockPath) {
  try {
    const info = statSync(lockPath)
    // **锁龄硬上限先行（审计 P1-5）**：pid 活着只能证明「某进程存活」，
    // 不能证明它还持有锁——持锁进程崩溃后 PID 被复用，探活成功会让残锁
    // 永活。锁龄超过硬上限（60s）无论 pid 状态一律 stale（锁内操作为
    // 毫秒级，此处只牺牲极端长持锁的可用性换全局可恢复性）。
    if (Date.now() - info.mtimeMs > LOCK_STALE_HARD_MS) return true
    // 再查 pid 存活（Codex 终审 P1-7 修正）：有合法 pid 时进程活着就是
    // 有效锁（锁内操作毫秒级，但长任务不应被误抢）；只有 pid 已死或无
    // pid 的旧格式锁才按 mtime 判定。
    try {
      const owner = JSON.parse(readFileSync(lockPath, 'utf8'))
      if (typeof owner.pid === 'number') {
        try {
          process.kill(owner.pid, 0) // 信号 0 = 只探测存活
          return false // 持有者还活着且锁龄未超硬上限 → 锁有效
        } catch {
          return true // 持有者已死（断电/中断残留）→ stale
        }
      }
    } catch {
      // 旧格式锁文件（无 pid/不可解析）→ 按 mtime 判断
    }
    return Date.now() - info.mtimeMs > STALE_LOCK_MS
  } catch {
    return false // 锁文件不存在/不可读 → 不 stale（下轮重试）
  }
}

/**
 * Acquire the directory lock exclusively (cross-process), run `fn`, release.
 * Reentrant within this process: a nested withLock on the same directory
 * proceeds directly (all mutations are synchronous, so the outer section is
 * still exclusive against other processes).
 * @param {string} dir - the directory whose lock to take.
 * @param {() => T} fn - the critical section.
 * @returns {T} the section's return value.
 * @template T
 */
export function withLock(dir, fn) {
  if (heldLocks.has(dir)) return fn()
  const lockPath = join(dir, '.memory.lock')
  mkdirSync(dir, { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    let acquired = false
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeFileSync(lockPath, LOCK_JSON())
      } finally {
        closeSync(fd)
      }
      acquired = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    if (acquired) break
    if (isStaleLock(lockPath)) rmSync(lockPath, { force: true })
    if (Date.now() >= deadline) {
      // 审计 P1-5：超时错误必须带锁路径——残锁排障时用户/模型要能直接
      // 找到该删哪个文件（此前报文不含任何定位信息）。
      throw new Error(`dsh-memory-evolve: timed out waiting for the memory lock (${lockPath})`)
    }
    sleep(LOCK_RETRY_MS)
  }
  heldLocks.add(dir)
  try {
    return fn()
  } finally {
    heldLocks.delete(dir)
    rmSync(lockPath, { force: true })
  }
}

/** Minimal prompt-injection scan applied to tool-written memory content. */
const THREAT_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|earlier|above|your)\s+(instructions?|prompts?|messages?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|earlier|above|your)\s+(instructions?|prompts?|messages?|rules?)/i,
  /forget\s+(all|everything|your\s+instructions)/i,
  /忽略(所有|之前|以上|先前)(的)?(指令|指示|提示|规则)/,
  /无视(所有|之前|以上|先前)(的)?(指令|指示|提示|规则)/,
]

/**
 * Scan one memory entry for prompt-injection phrasing.
 * @param {string} text - the content to scan.
 * @returns {string | undefined} a human-readable block reason, or undefined.
 */
export function scanThreat(text) {
  for (const pattern of THREAT_PATTERNS) {
    if (pattern.test(text)) {
      return '内容包含疑似提示注入的表述（如"忽略指令"），已拒绝写入。若确为有意内容，请直接编辑记忆文件。'
    }
  }
  return undefined
}

/** Today's date as `YYYY-MM-DD` (local time). */
export function todayStamp() {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** Stable 12-hex project key for one working directory. */
export function projectHash(cwd) {
  return createHash('sha1').update(cwd).digest('hex').slice(0, 12)
}

/**
 * A short, stable project label for one working directory: the basename, or
 * the last two path segments when the basename is too short or purely
 * numeric (e.g. `/data/260805/1` → `260805/1`). Tags daily-log entries with
 * their originating project — the program knows the session cwd, so the LLM
 * never has to write it.
 * @param {string | undefined} cwd - the session working directory.
 * @returns {string | undefined} the label, or undefined without a cwd.
 */
export function projectLabel(cwd) {
  if (!cwd) return undefined
  const parts = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length === 0) return '/'
  const base = parts[parts.length - 1]
  if (base.length < 3 || /^\d+$/.test(base)) {
    return parts.length > 1 ? parts.slice(-2).join('/') : base
  }
  return base
}

/**
 * Resolve the current git branch of a working directory (same pattern as the
 * DSH TUI's prompt-context helper). Outside a git worktree, without `git`,
 * or on a detached HEAD (`--show-current` returns empty) this returns
 * undefined — callers then fall back to the no-branch behavior.
 * @param {string} cwd - the working directory to query.
 * @returns {string | undefined} the branch name, or undefined.
 */
export function gitBranch(cwd) {
  if (!cwd) return undefined
  try {
    const result = spawnSync('git', ['branch', '--show-current'], {
      cwd, encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.error || result.status !== 0) return undefined
    const branch = String(result.stdout ?? '').trim()
    return branch === '' ? undefined : branch
  } catch {
    return undefined
  }
}

/**
 * List all local branch names of a working directory (for the memory tab's
 * branch-scope pickers). Empty on any failure.
 * @param {string} cwd - the working directory to query.
 * @returns {string[]} the branch names ([] = not a git repo / no git).
 */
export function gitBranchList(cwd) {
  if (!cwd) return []
  try {
    const result = spawnSync('git', ['branch', '--format=%(refname:short)'], {
      cwd, encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.error || result.status !== 0) return []
    return String(result.stdout ?? '')
      .split('\n')
      .map((b) => b.trim())
      .filter((b) => b.length > 0)
  } catch {
    return []
  }
}

/**
 * Persistent curated memory store over the five tracks: global facts
 * (MEMORY.md / USER.md), the daily log (daily/YYYY-MM-DD.md), the per-project
 * log (projects/<hash>/MEMORY.md, keyed by the session cwd) and per-project
 * KEY facts (projects/<hash>/KEY.md — the project's long-term memory, which
 * IS injected into the context like the global tracks).
 */
export class MemoryStore {
  /**
   * @param {string} dir - the memory directory (created on demand).
   * @param {object} [options] - scan and stamping switches.
   * @param {boolean} [options.injectionScan=true] - enable the threat scan.
   * @param {boolean} [options.entryDatePrefix=true] - stamp entries with a
   *   `[YYYY-MM-DD] ` prefix on add, refreshed on replace (idempotent for
   *   content that already carries a date stamp).
   * @param {'off'|'on'} [options.entryIdMode='off'] - 条目身份证开关（施工图
   *   §4.2）：'on' 时 add 为每个新条目前置随机 `[id:xxxxxxxx]`、replace 继承
   *   旧条目 ID（"替换不换身份"）。**只有启用了 Git 同步的项目才开**——
   *   未启用项目保持 'off'，行为与现状逐字节一致。默认 'off'。
   * @param {(cwd: string) => string} [options.projectDirResolver] - 项目目录
   *   解析器（记忆同步装配层注入）：sync 已初始化项目返回 projectId 目录，
   *   否则回退 projectHash(cwd)（缺省逻辑）。
   */
  constructor(dir, options = {}) {
    this.dir = dir
    this.injectionScan = options.injectionScan ?? true
    this.entryDatePrefix = options.entryDatePrefix ?? true
    this.entryIdMode = options.entryIdMode === 'on' ? 'on' : 'off'
    this.projectDirResolver = typeof options.projectDirResolver === 'function' ? options.projectDirResolver : null
  }

  /**
   * Resolve one target to its file location.
   * @param {string} target - 'memory' | 'user' | 'daily' | 'project' | 'key'.
   * @param {object | undefined} agent - the calling agent; required for
   *   'project' and 'key' (its session cwd selects the project directory).
   * @returns {{dir: string, file: string} | undefined}
   *   the location, or undefined when it cannot be resolved (e.g. project
   *   memory without a session cwd).
   */
  locate(target, agent) {
    switch (target) {
      case 'memory':
        return { dir: this.dir, file: 'MEMORY.md' }
      case 'user':
        return { dir: this.dir, file: 'USER.md' }
      case 'daily':
        return { dir: join(this.dir, 'daily'), file: `${todayStamp()}.md` }
      case 'project':
      case 'key': {
        const cwd = agent?.session?.header?.cwd
        if (!cwd) return undefined
        // 项目目录定位：sync 已初始化的项目用 projectId 目录（迁移后），
        // 否则回退 projectHash(cwd)（未启用同步的项目行为零变化）。
        // projectDirResolver 由装配层注入（lib/sync/index.js）。
        const dir = this.projectDirResolver
          ? this.projectDirResolver(cwd)
          : join(this.dir, 'projects', projectHash(cwd))
        return {
          dir,
          file: target === 'key' ? 'KEY.md' : 'MEMORY.md',
        }
      }
      default:
        throw new Error(`dsh-memory-evolve: 无效的记忆轨 "${target}"`)
    }
  }

  /** Resolve a target or fail loud with a locatable message. */
  resolveTarget(target, agent) {
    const loc = this.locate(target, agent)
    if (!loc) {
      throw new Error(`dsh-memory-evolve: 无法定位记忆轨 "${target}"（项目记忆需要有效的会话工作目录）`)
    }
    return loc
  }

  /**
   * Stamp one entry with a time prefix: date stamp for the long-term tracks
   * (global memory/user AND the per-project KEY track — a `[YYYY-MM-DD]`
   * prefix, same shape as the injected global tracks), date+time for the
   * per-project log (project entries need hour granularity to reconstruct
   * when something happened), time-of-day for the daily log (its file name
   * already carries the date). Idempotent for content that already carries
   * the matching prefix; a bare `[YYYY-MM-DD]` project entry is upgraded to
   * the dated-time form on replace.
   *
   * For daily/project/key, a hand-written date-like prefix (`[2026-08-05]`,
   * `[2026-08-05 深夜]`) is STRIPPED first: writers (review subagents) do
   * not know the current date and guess — dates belong to the file name
   * (daily) or the program stamp (project/key), so the canonical stamp wins.
   *
   * Daily entries additionally carry a program-tagged project label
   * (`[HH:MM] [git branch] [label] …`) derived from the calling agent's
   * cwd, so the log shows which project each entry belongs to without the
   * LLM writing it. Daily AND project entries carry a program-tagged git
   * branch (`[git main]`, right after the time stamp) whenever the session
   * cwd is a git worktree — logs stay branch-reliable without any LLM
   * cooperation.
   * @param {string} target - the memory track.
   * @param {string} content - trimmed entry text.
   * @param {object | undefined} agent - the calling agent (its cwd selects
   *   the project label for the daily track).
   * @param {number | undefined} [salience] - optional entry importance
   *   (1-3; Step 3). Written as a `[salience:N]` head tag after
   *   `[summary:…]` (if any) and before the body — memory/user/key tracks
   *   only. Out-of-range/non-integer values are silently ignored here (the
   *   tool layer clamps or rejects with an echo; this is defense in depth
   *   so no illegal tag ever reaches disk), and an already-present head
   *   tag is never duplicated (the key-track queue path pre-stamps it).
   * @returns {string} the stamped entry.
   */
  stampEntry(target, content, agent, salience) {
    // 身份证（跨设备合并锚点）**永远在条目最前**：先暂存剥离，盖完所有
    // 程序前缀（时间戳/git 分支/项目标签）后统一装回（审查 P0——此前盖在
    // 日期前导致"自带 ID 的 add/转正"产生双 ID 且合并锚点断裂）。
    const entryId = extractEntryId(content)
    if (entryId !== null) content = stripEntryId(content)
    let stamped
    if (target === 'daily' || target === 'project' || target === 'key') {
      content = content.replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, '')
      // 分支 tag 是程序专属标注：剥离模型手写的 [git 分支] 前缀，防止与
      // 程序盖的 tag 重复（模型不知道分支名，也不该写）
      content = content.replace(/^\[git [^\]]+\]\s*/, '')
    }
    if (target === 'daily') {
      if (!this.entryDatePrefix || /^\[\d{2}:\d{2}\]\s/.test(content)) {
        stamped = content
      } else {
        const d = new Date()
        const hh = String(d.getHours()).padStart(2, '0')
        const mm = String(d.getMinutes()).padStart(2, '0')
        const label = projectLabel(agent?.session?.header?.cwd)
        const branch = gitBranch(agent?.session?.header?.cwd)
        const branchTag = branch !== undefined ? `[git ${branch}] ` : ''
        stamped = `[${hh}:${mm}] ${branchTag}${label ? `[${label}] ` : ''}${content}`
      }
    } else if (target === 'project') {
      if (!this.entryDatePrefix || /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s/.test(content)) {
        stamped = content
      } else {
        const d = new Date()
        const hh = String(d.getHours()).padStart(2, '0')
        const mm = String(d.getMinutes()).padStart(2, '0')
        const branch = gitBranch(agent?.session?.header?.cwd)
        const branchTag = branch !== undefined ? `[git ${branch}] ` : ''
        stamped = `[${todayStamp()} ${hh}:${mm}] ${branchTag}${content}`
      }
    } else if (!this.entryDatePrefix || /^\[\d{4}-\d{2}-\d{2}\]\s/.test(content)) {
      stamped = content
    } else {
      stamped = `[${todayStamp()}] ${content}`
    }
    // 重要性 tag（Step 3，AC-2.1）：仅 memory/user/key 轨写入；位置 =
    // [summary:…]（若有）之后、正文之前。锚定用 ENTRY_HEAD_RE（head 到
    // dsh-only 为止，此刻身份证尚未装回）。值域外/非整数静默忽略（工具
    // 层已钳制/拒绝并回显，此处是纵深防御——非法 tag 永不落盘）；已有
    // 头部 tag 不重复写（key 轨待确认队列路径在 addOne 预拼，幂等）。
    if ((target === 'memory' || target === 'user' || target === 'key') && salience !== undefined) {
      // P2-4 修复：纵深防御层只认真 number——Number(true)===1、Number('2')===2
      // 会穿过整数检查（工具层 schema type:integer 已拦布尔/字符串，此处收口
      // store API 的直接调用方），与「非法 tag 永不落盘」的意图对齐。
      const n = typeof salience === 'number' ? salience : NaN
      if (Number.isInteger(n) && n >= 1 && n <= 3) {
        const headMatch = ENTRY_HEAD_RE.exec(stamped)
        const headLen = headMatch !== null ? headMatch[0].length : 0
        const rest = stamped.slice(headLen)
        const sumMatch = /^\[summary:[^\]]*\]\s*/.exec(rest)
        const afterSummary = sumMatch !== null ? rest.slice(sumMatch[0].length) : rest
        if (!/^\[salience:[1-3]\]\s*/.test(afterSummary)) {
          const tag = `[salience:${n}] `
          stamped = sumMatch !== null
            ? stamped.slice(0, headLen + sumMatch[0].length) + tag + afterSummary
            : stamped.slice(0, headLen) + tag + afterSummary
        }
      }
    }
    // 统一出口：身份证装回最前（程序前缀之前）
    if (entryId !== null) stamped = `[id:${entryId}] ${stamped}`
    return stamped
  }

  /** Absolute path of one target's file (throws when not locatable). */
  pathOf(target, agent) {
    const loc = this.resolveTarget(target, agent)
    return join(loc.dir, loc.file)
  }


  /** Current character usage of one target (delimiter-joined length). */
  charsOf(target, agent) {
    return this.entriesOf(target, agent).join(ENTRY_DELIMITER).length
  }

  /** Read one target's entries without locking (snapshot reads). */
  entriesOf(target, agent) {
    return parseEntries(this.readRaw(target, agent).text)
  }

  /**
   * Query entries with LLM-friendly lookups: keyword `filter`
   * (case-insensitive substring), date range `since`/`until`
   * (`YYYY-MM-DD`; the daily track spans multiple files, so a range reads
   * every day's log in between), `recent` newest-first ordering and a
   * `limit` cap. Entries without a date stamp survive date filters.
   * @param {string} target - the memory track.
   * @param {object | undefined} agent - the calling agent (required for
   *   'project').
   * @param {{filter?: string, since?: string, until?: string, limit?: number, recent?: boolean}} [opts]
   * @returns {string[]} the matching entries (raw text with stamps).
   */
  query(target, agent, opts = {}, stats = {}) {
    const { filter, since, until, limit, recent } = opts
    let rows = []
    if (target === 'daily' && (since !== undefined || until !== undefined)) {
      // 跨日期查询：枚举 daily/ 目录中范围内的文件（按日期升序收集）
      const dir = join(this.dir, 'daily')
      let days = []
      try {
        days = readdirSync(dir)
          .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
          .map((name) => name.slice(0, 10))
          .sort()
      } catch {
        days = [] // daily 目录尚不存在
      }
      for (const day of days) {
        if ((since !== undefined && day < since) || (until !== undefined && day > until)) continue
        let text
        try {
          text = readFileSync(join(dir, `${day}.md`), 'utf8')
        } catch {
          continue
        }
        for (const entry of parseEntries(text)) rows.push({ date: day, text: entry })
      }
    } else {
      // 单文件轨：日期从条目时间戳提取（daily 单文件 = 今天的文件）
      const fileDate = target === 'daily' ? todayStamp() : null
      for (const entry of this.entriesOf(target, agent)) {
        rows.push({ date: fileDate ?? extractEntryDate(entry), text: entry })
      }
    }
    if (filter !== undefined && String(filter) !== '') {
      const q = String(filter).toLowerCase()
      rows = rows.filter((row) => row.text.toLowerCase().includes(q))
    }
    if (since !== undefined || until !== undefined) {
      rows = rows.filter((row) => {
        if (row.date === null) return true // 无日期条目不参与日期过滤
        if (since !== undefined && row.date < since) return false
        if (until !== undefined && row.date > until) return false
        return true
      })
    }
    // 统计日期无法解析的条目（旧格式/手写前缀）——调用方可据此提醒模型读全文
    stats.undated = rows.filter((row) => row.date === null).length
    stats.total = rows.length
    if (recent) rows.reverse() // 升序收集后整体反转 = 日期倒序 + 组内倒序
    if (limit !== undefined && Number.isFinite(Number(limit)) && Number(limit) > 0) {
      rows = rows.slice(0, Math.floor(Number(limit)))
    }
    return rows.map((row) => row.text)
  }

  /** Read the raw file; a missing file reads as an empty store. */
  readRaw(target, agent) {
    const path = this.pathOf(target, agent)
    try {
      return { text: readFileSync(path, 'utf8'), size: statSync(path).size }
    } catch (error) {
      if (error.code === 'ENOENT') return { text: '', size: 0 }
      throw error
    }
  }

  /**
   * Reload one target under the caller's lock.
   * @returns {{kind:'ok', entries: string[]} | {kind:'read-failed'} | {kind:'drift', backup: string}}
   */
  reload(target, agent) {
    const { text, size } = this.readRaw(target, agent)
    // Only a truly unreadable file is refused (non-empty size yet zero bytes
    // read back — e.g. a broken encoding). A whitespace-only file is a normal
    // empty store: rewriting it cannot wipe history.
    if (text === '' && size > 0) return { kind: 'read-failed' }
    if (!isCanonical(text)) {
      const backup = `${this.pathOf(target, agent)}.bak.${Date.now()}`
      writeFileSync(backup, text)
      return { kind: 'drift', backup }
    }
    return { kind: 'ok', entries: parseEntries(text) }
  }

  /** Atomically write entries to one target's file. */
  write(target, entries, agent) {
    const path = this.pathOf(target, agent)
    const tmp = `${path}.tmp.${process.pid}`
    writeFileSync(tmp, serializeEntries(entries))
    renameSync(tmp, path)
  }

  /**
   * Reload one target under the caller's lock, skipping the drift guard.
   * Append-only mutations never clobber parsed entries, so an un-roundtrippable
   * file is tolerated (Hermes semantics); an unreadable file is not
   * (rewriting it would wipe history). A whitespace-only file is a normal
   * empty store — only a file that exists with a size yet reads back as the
   * empty string is treated as unreadable.
   * @returns {{kind:'ok', entries: string[]} | {kind:'read-failed'}}
   */
  reloadForAppend(target, agent) {
    const { text, size } = this.readRaw(target, agent)
    if (text === '' && size > 0) return { kind: 'read-failed' }
    return { kind: 'ok', entries: parseEntries(text) }
  }

  /**
   * Append one entry. Skips the drift guard (append-only), rejects empty
   * content, exact duplicates, over-limit additions, and unreadable files.
   * @param {string} target - 'memory' or 'user'.
   * @param {string} content - the entry text.
   * @param {number | undefined} [salience] - optional entry importance
   *   (1-3, Step 3; clamped/rejected at the tool layer, stamped only for
   *   memory/user/key).
   * @returns {object} a tool-friendly result object.
   */
  add(target, content, agent, salience) {
    const loc = this.resolveTarget(target, agent)
    const text = String(content).trim()
    if (!text) return { ok: false, message: st('store.emptyContent'), target }
    // § 是条目分隔符（保留字符）：正文携带会在下次 parse 时静默拆条
    //（且拆后仍 canonical，drift guard 永远侦测不到）或尾随丢字锁死
    // drift——与 updateEntryContent 同口径拒绝（审计 P1-1）。
    if (text.includes('§')) {
      return { ok: false, message: stt('storetail.sectionDelimiter'), target }
    }
    if (this.injectionScan) {
      const threat = scanThreat(text)
      if (threat) return { ok: false, message: threat, target }
    }
    const stamped = this.stampEntry(target, text, agent, salience)
    return withLock(loc.dir, () => {
      const reload = this.reloadForAppend(target, agent)
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableWrite'), target }
      }
      const entries = reload.entries
      // entryIdMode=on（启用了 Git 同步的项目）：新条目前置随机身份证
      // （施工图 §4.2；未启用项目不处理，行为零变化）。一期同步范围 = 项目
      // 轨（key + project 日志），全局轨（memory/user/daily）二期才共享，
      // 一期不生成 ID —— 磁盘格式保持现状。PROVENANCE 存在 = 该项目已完成
      // bootstrap（未初始化项目即使全局开关打开也不生成 ID）。
      const syncedTrack = this.entryIdMode === 'on' && (target === 'key' || target === 'project')
        && isProjectSyncEnabled(loc.dir)
      const withId = syncedTrack && !/^\[id:[0-9a-f]{8}\]\s*/.test(stamped)
        ? `[id:${genEntryId()}] ${stamped}`
        : stamped
      // 去重比较：on 模式剥离身份证后比较（身份证每次随机，直接 includes
      // 会永远不命中，导致重复内容被反复添加）；off 模式维持原行为。
      const dup = syncedTrack
        ? entries.some((entry) => stripEntryId(entry) === stripEntryId(withId))
        : entries.includes(stamped)
      if (dup) {
        return {
          ok: true, duplicate: true, message: st('store.duplicate'), target,
          entries: [...entries], chars: this.charsOf(target, agent),
        }
      }
      const next = [...entries, withId]
      this.write(target, next, agent)
      return {
        ok: true, message: st('store.added', { target, before: entries.length, after: next.length }), target,
        entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * Replace the whole entry containing the unique substring `match`.
   * Enforces the drift guard (full-file rewrite).
   * @param {string} target - 'memory' or 'user'.
   * @param {string} match - a short substring uniquely identifying one entry.
   * @param {string} content - the replacement entry text.
   * @param {number | undefined} [salience] - optional entry importance for
   *   the replacement (1-3, Step 3). Not passed = the new entry carries no
   *   salience tag (edit = new lifecycle, Q1 semantics).
   * @returns {object} a tool-friendly result object.
   */
  replace(target, match, content, agent, salience) {
    const loc = this.resolveTarget(target, agent)
    const oldText = String(match ?? '').trim()
    const newContent = String(content ?? '').trim()
    if (!oldText) return { ok: false, message: st('store.emptyMatch'), target }
    if (!newContent) return { ok: false, message: st('store.emptyNewContent'), target }
    // § 为条目分隔符（保留字符），replace 内容携带同 add 拒绝（审计 P1-1）
    if (newContent.includes('§')) {
      return { ok: false, message: stt('storetail.sectionDelimiter'), target }
    }
    if (this.injectionScan) {
      const threat = scanThreat(newContent)
      if (threat) return { ok: false, message: threat, target }
    }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: st('store.driftGuardWrite', { file: loc.file, backup: reload.backup }),
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableWrite'), target }
      }
      const entries = reload.entries
      const matches = entries.filter((entry) => entry.includes(oldText))
      if (matches.length === 0) {
        return { ok: false, message: st('store.noMatch', { match: oldText }), target, entries: [...entries] }
      }
      if (matches.length > 1) {
        return {
          ok: false,
          message: st('store.multiMatch', { match: oldText, count: matches.length }),
          target, matches: [...matches], entries: [...entries],
        }
      }
      const index = entries.indexOf(matches[0])
      const next = [...entries]
      // 替换不换身份（施工图 §4.3；Codex 二轮 P1-3 扩展）：
      //   - **旧条目已有身份证（任何轨）→ 必须保留**——全局轨开启后
      //     memory/user 也会补发 [id:xxxx]，replace 删掉 ID 会让双设备
      //     修改同一条时无法对齐（被当成两条新增）；
      //   - 旧条目无 ID：项目轨（key/project）且同步启用 → 按旧内容确定性
      //     补发（legacyIdFor，双设备一致）；未启用同步的 memory/user 无
      //     ID → 不加（保持纯本地状态）。
      let replacement = this.stampEntry(target, newContent, agent, salience)
      const oldId = extractEntryId(matches[0])
      if (this.entryIdMode === 'on' && oldId !== null) {
        replacement = stripEntryId(replacement)
        replacement = `[id:${oldId}] ${replacement}`
      } else if (this.entryIdMode === 'on' && (target === 'key' || target === 'project')
        && isProjectSyncEnabled(loc.dir)) {
        const legacyId = legacyIdFor(stripEntryId(matches[0]))
        replacement = stripEntryId(replacement)
        replacement = `[id:${legacyId}] ${replacement}`
      }
      next[index] = replacement
      this.write(target, next, agent)
      return {
        ok: true, message: st('store.replaced', { target, count: entries.length }), target,
        entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * Re-tag the entry containing the unique substring `match`（PR #66 后续增强
   * 块 6；渐进式披露 v2 扩 summary）：按 match 定位单条（语义同 replace：
   * 未命中/多义同错误口径），只重写**头部元数据标记**——[salience:N] 与/或
   * [summary:…]，正文逐字不动、[id:] 原样保留（retagEntryMeta，tag-only 重写）。
   * 写入走与 replace 完全相同的 drift 守卫 + withLock + 整文件原子写路径
   * （同步/加锁机制全同）。
   *
   * 渐进式披露 v2（2026-09-28 用户批准）：summary 是本次批量回填 131 条存量
   * 摘要的执行机制——不重发正文即可补一行 [summary:…]。两者至少给一个：
   * salience 缺省 = 保留原级别；summary 缺省 = 保留原摘要。
   * @param {string} target - 'memory' | 'user' | 'key'（project/daily 由
   *   工具层诚实拒绝；store 层不做二次校验，保持与 replace 同宽度）。
   * @param {string} match - unique substring locating one entry.
   * @param {number|undefined} salience - 新重要性 1-3（工具层已归一钳制；
   *   store 层防御性再校验，非法响亮拒绝）；undefined = 不改级别。
   * @param {object} agent - session agent（与 replace 同参）。
   * @param {string|undefined} [summary] - 新摘要（已由工具层清洗/截断；
   *   store 层再走 normalizeSummaryText，纵深防御）；undefined = 不改摘要。
   * @returns {object} a tool-friendly result object（entry = 重打后的条目原文）。
   */
  retag(target, match, salience, agent, summary) {
    const loc = this.resolveTarget(target, agent)
    const oldText = String(match ?? '').trim()
    if (!oldText) return { ok: false, message: st('store.emptyMatch'), target }
    // 渐进式披露 v2：salience 与 summary 至少给一个（两都不给 = 无操作，
    // 诚实报错而非静默成功——静默成功会让模型以为摘要已写入）。
    // ⚠️ 判据只用 `undefined` 表「未提供」：null 是**显式非法值**（工具层
    // schema type:integer 不会传 null，但 store API 的直接调用方可能），
    // 仍走 retagBadLevel 响亮拒绝，与修复前口径一致。
    if (salience === undefined) {
      if (summary === undefined || String(summary ?? '').trim() === '') {
        return { ok: false, message: st('store.retagNothing'), target }
      }
    }
    let level
    if (salience !== undefined) {
      level = Number(salience)
      if (!Number.isInteger(level) || level < 1 || level > 3) {
        return { ok: false, message: st('store.retagBadLevel', { value: String(salience) }), target }
      }
    }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: st('store.driftGuardWrite', { file: loc.file, backup: reload.backup }),
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableWrite'), target }
      }
      const entries = reload.entries
      const matches = entries.filter((entry) => entry.includes(oldText))
      if (matches.length === 0) {
        return { ok: false, message: st('store.noMatch', { match: oldText }), target, entries: [...entries] }
      }
      if (matches.length > 1) {
        return {
          ok: false,
          message: st('store.multiMatch', { match: oldText, count: matches.length }),
          target, matches: [...matches], entries: [...entries],
        }
      }
      const index = entries.indexOf(matches[0])
      const next = [...entries]
      next[index] = retagEntryMeta(matches[0], { salience: level, summary })
      this.write(target, next, agent)
      // 回显 what：只改级别 / 只改摘要 / 两者都改（渐进式披露 v2）
      const wroteSummary = summary !== undefined && normalizeSummaryText(summary) !== ''
      const what = level !== undefined && wroteSummary
        ? st('store.retagWhatBoth', { level })
        : level !== undefined
          ? st('store.retagWhatSalience', { level })
          : st('store.retagWhatSummary')
      return {
        ok: true, message: st('store.retagged', { target, what }), target,
        entry: next[index], entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * Remove the entry containing the unique substring `match`.
   * Enforces the drift guard (full-file rewrite).
   * @param {string} target - 'memory' or 'user'.
   * @param {string} match - a short substring uniquely identifying one entry.
   * @returns {object} a tool-friendly result object.
   */
  remove(target, match, agent) {
    const loc = this.resolveTarget(target, agent)
    const oldText = String(match ?? '').trim()
    if (!oldText) return { ok: false, message: st('store.emptyMatch'), target }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: st('store.driftGuardOp', { file: loc.file, backup: reload.backup }),
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableWrite'), target }
      }
      const entries = reload.entries
      const matches = entries.filter((entry) => entry.includes(oldText))
      if (matches.length === 0) {
        return { ok: false, message: st('store.noMatch', { match: oldText }), target, entries: [...entries] }
      }
      if (matches.length > 1) {
        return {
          ok: false,
          message: st('store.multiMatch', { match: oldText, count: matches.length }),
          target, matches: [...matches], entries: [...entries],
        }
      }
      const index = entries.indexOf(matches[0])
      const next = [...entries]
      next.splice(index, 1)
      this.write(target, next, agent)
      return {
        ok: true, message: st('store.removed', { target, before: entries.length, after: next.length }), target,
        // removed：被删的整条原文（含时间戳）——供归档等"移动"场景直接
        // 追加到归档文件，避免二次匹配
        removed: matches[0],
        entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * Preview the single entry containing the unique substring `match`,
   * WITHOUT writing anything. 与 remove 同一匹配语义（唯一子串命中、
   * drift guard 前置校验），供「先归档、后删除」的移动场景使用：
   * 先用 peek 拿到命中原文写入归档文件，归档成功后再执行删除——
   * 替代旧「先删后加」顺序，避免归档写入失败时主轨条目直接丢失。
   * @param {string} target - 'memory' or 'user'.
   * @param {string} match - a short substring uniquely identifying one entry.
   * @returns {object} a tool-friendly result object ({ ok, entry } on success).
   */
  peek(target, match, agent) {
    const loc = this.resolveTarget(target, agent)
    const oldText = String(match ?? '').trim()
    if (!oldText) return { ok: false, message: st('store.emptyMatch'), target }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: st('store.driftGuardOp', { file: loc.file, backup: reload.backup }),
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableOp'), target }
      }
      const matches = reload.entries.filter((entry) => entry.includes(oldText))
      if (matches.length === 0) {
        return { ok: false, message: st('store.noMatch', { match: oldText }), target }
      }
      if (matches.length > 1) {
        return {
          ok: false,
          message: st('store.multiMatch', { match: oldText, count: matches.length }),
          target,
        }
      }
      return { ok: true, entry: matches[0], target }
    })
  }

  /**
   * Preview whether an EXACT whole-entry match exists (same matching
   * semantics as removeExact, read-only, writes nothing). 供「先归档、
   * 后删除」场景在写入归档文件前校验目标条目确实存在于主轨——避免
   * 无效请求（非整条子串、已删除条目）先把垃圾内容写进归档文件。
   *
   * 匹配走 findExactIndex（对展示层剥离的 `[id:…]` / `[summary:…]` 免疫，
   * issue #59），但**返回的是磁盘原文**而不是入参：归档文件因此保留
   * `[id:…]` 与 `[summary:…]`，转正回主轨时不丢元数据（`store.add` 的
   * stampEntry 会把身份证装回最前、时间戳重新盖）。
   * @param {string} target - the memory track ('memory' | 'user' | 'daily' |
   *   'project' | 'key').
   * @param {string} entry - the FULL entry text (with its stamp) to check.
   * @returns {object} a tool-friendly result object ({ ok, entry } on success);
   *   `entry` is the on-disk original, not the caller's text.
   */
  peekExact(target, entry, agent) {
    const loc = this.resolveTarget(target, agent)
    const exact = String(entry ?? '').trim()
    if (!exact) return { ok: false, message: st('store.emptyEntry'), target }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: st('store.driftGuardOp', { file: loc.file, backup: reload.backup }),
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableOp'), target }
      }
      const index = findExactIndex(reload.entries, exact)
      if (index === -1) {
        return { ok: false, message: stt('storetail.mainMissing'), target }
      }
      return { ok: true, entry: reload.entries[index], target }
    })
  }

  /**
   * Remove the entry that EXACTLY equals `entry` (whole-entry match, not a
   * substring). Used by the memory tab's per-entry delete button: the UI
   * sends the full entry text it rendered, and this deletes precisely that
   * entry — a substring match could hit a longer entry that merely contains
   * the text (e.g. deleting "喜欢简洁" must not remove "喜欢简洁，也喜欢
   * 详细"). Enforces the drift guard; a missing exact entry is reported
   * without touching anything.
   * @param {string} target - the memory track ('memory' | 'user' | 'daily' |
   *   'project' | 'key').
   * @param {string} entry - the FULL entry text (with its stamp) to delete.
   * @returns {object} a tool-friendly result object.
   */
  removeExact(target, entry, agent) {
    const loc = this.resolveTarget(target, agent)
    const exact = String(entry ?? '').trim()
    if (!exact) return { ok: false, message: st('store.emptyEntry'), target }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: st('store.driftGuardOp', { file: loc.file, backup: reload.backup }),
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableWrite'), target }
      }
      const entries = reload.entries
      // 精确匹配对身份证免疫（审查 P0）：展示层剥离 [id:…] 后回传的文本
      // 也能命中磁盘原文（strip 相等比较）；多条命中报歧义（防御）。
      const index = findExactIndex(entries, exact)
      if (index === -1) {
        return {
          ok: false,
          message: stt('storetail.entryMissing'),
          target, entries: [...entries],
        }
      }
      const next = [...entries]
      next.splice(index, 1)
      this.write(target, next, agent)
      return {
        ok: true, message: st('store.removed', { target, before: entries.length, after: next.length }), target,
        entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * Set the branch scope of one KEY entry (whole-entry exact match). An
   * empty `branches` array means "all branches" — the tag is REMOVED
   * ("全部" has the highest weight: it wins over any branch selection).
   * The date stamp is preserved; the tag is (re)inserted right after it.
   * @param {string} target - 'key' (other tracks are rejected).
   * @param {string} entry - the FULL entry text to update.
   * @param {string[]} branches - the branch names ([] = all branches).
   * @returns {object} a tool-friendly result object.
   */
  setEntryBranches(target, entry, branches, agent) {
    const loc = this.resolveTarget(target, agent)
    const exact = String(entry ?? '').trim()
    if (!exact) return { ok: false, message: st('store.emptyEntry'), target }
    if (target !== 'key') return { ok: false, message: stt('storetail.branchKeyOnly'), target }
    const list = (Array.isArray(branches) ? branches : [])
      .map((b) => String(b).trim())
      .filter((b) => b.length > 0)
    const tag = list.length > 0 ? `[branch:${list.join(',')}] ` : ''
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: st('store.driftGuardOp', { file: loc.file, backup: reload.backup }),
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableWrite'), target }
      }
      const entries = reload.entries
      const index = findExactIndex(entries, exact)
      if (index === -1) {
        return {
          ok: false,
          message: stt('storetail.entryMissing'),
          target, entries: [...entries],
        }
      }
      // 用**磁盘原文**（含身份证）重建（审查 P1：基于剥离文本重建会丢 ID）；
      // splitEntryHead 拆出全部程序前缀（id/日期/git/branch/dsh-only），
      // 去掉旧 [branch:] 后插入新标记
      const diskEntry = entries[index]
      const { head, body } = splitEntryHead(diskEntry, target)
      const headNoBranch = head.replace(/\[branch:[^\]]*\]\s*/, '')
      const next = [...entries]
      next[index] = `${headNoBranch}${tag}${body}`
      this.write(target, next, agent)
      return {
        ok: true, message: list.length > 0 ? `已设置分支范围（${list.join('、')}）` : '已设为全部分支可见',
        target, entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * 设置/取消一条目的「仅 DSH」标记（整条精确匹配，与 setEntryBranches
   * 同款校验：drift guard + 精确相等 + 不存在的条目拒绝）。
   *
   * 标记为 `[dsh-only]`（时间戳与 [branch:…] 之后、正文之前）：打标记后
   * 该条目仍注入 DSH 自身会话，但注入外部执行器（COI 任务的 injectTracks
   * 记忆注入）时会被 buildMemoryContext 的 excludeDshOnly 整条跳过——
   * 用于存放只对 DSH 有意义的纪律/规则/架构类事实（外部 CLI 代理不是
   * DSH，强行遵循 DSH 规则只会困惑）。取消标记 = 移除该 tag（条目恢复
   * 对外部执行器可见）。
   * @param {string} target - 'memory' | 'user' | 'key'（其他轨拒绝）。
   * @param {string} entry - 完整条目原文（整条精确匹配）。
   * @param {boolean} on - true=打标记，false=取消标记。
   * @returns {object} a tool-friendly result object.
   */
  setEntryDshOnly(target, entry, on, agent) {
    const loc = this.resolveTarget(target, agent)
    const exact = String(entry ?? '').trim()
    if (!exact) return { ok: false, message: st('store.emptyEntry'), target }
    if (target !== 'memory' && target !== 'user' && target !== 'key') {
      return { ok: false, message: stt('storetail.dshOnlyTrackLimit'), target }
    }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: st('store.driftGuardOp', { file: loc.file, backup: reload.backup }),
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableWrite'), target }
      }
      const entries = reload.entries
      const index = findExactIndex(entries, exact)
      if (index === -1) {
        return {
          ok: false,
          message: stt('storetail.entryMissing'),
          target, entries: [...entries],
        }
      }
      // 用磁盘原文重建（保身份证）；splitEntryHead 拆出全部程序前缀，
      // 去掉旧 [dsh-only]（只剥头部 token——正文里的同名字面不动，审计
      // P1-3：此前裸 replace 删正文字面且不可还原）后按需插入——位置
      // 固定：程序元数据之后、正文之前
      const diskEntry = entries[index]
      const bare = stripEntryDshOnly(diskEntry)
      const { head, body } = splitEntryHead(bare, target)
      const next = [...entries]
      next[index] = on ? `${head}${DSH_ONLY_TAG} ${body}` : `${head}${body}`
      this.write(target, next, agent)
      return {
        ok: true,
        message: on ? '已标记为仅 DSH 适用（注入外部执行器时跳过）' : '已取消仅 DSH 标记（外部执行器可见）',
        target, entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * 只更新一条目的正文（整条精确匹配）——记忆 Tab 美观视图的「编辑」入口。
   * 时间戳与全部 tag（[git …] / [branch:…] / daily 项目标签）原样保留：
   * 程序维护的元数据不可被编辑改动。内容禁止包含条目分隔符 §（防破坏
   * § 分割格式）。Enforces the drift guard (full-file rewrite).
   * @param {string} target - 'memory' | 'user' | 'daily' | 'project' | 'key'。
   * @param {string} entry - 完整条目原文（与删除/归档同一份，UI 渲染时持有）。
   * @param {string} content - 新正文（可多行；空内容请用删除）。
   * @returns {object} a tool-friendly result object.
   */
  updateEntryContent(target, entry, content, agent) {
    const loc = this.resolveTarget(target, agent)
    const exact = String(entry ?? '').trim()
    const newContent = String(content ?? '').trim()
    if (!exact) return { ok: false, message: st('store.emptyEntry'), target }
    if (!newContent) return { ok: false, message: stt('storetail.emptyContentTab'), target }
    if (newContent.includes('§')) {
      return { ok: false, message: stt('storetail.sectionDelimiter'), target }
    }
    if (this.injectionScan) {
      const threat = scanThreat(newContent)
      if (threat) return { ok: false, message: threat, target }
    }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: st('store.driftGuardWrite', { file: loc.file, backup: reload.backup }),
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableWrite'), target }
      }
      const entries = reload.entries
      const index = findExactIndex(entries, exact)
      if (index === -1) {
        return {
          ok: false,
          message: stt('storetail.entryMissing'),
          target, entries: [...entries],
        }
      }
      const { head } = splitEntryHead(entries[index], target) // 磁盘原文（保身份证）
      // 防御：完全解析不出前缀的异常条目，编辑会破坏其原有格式——拒绝并提示手动处理
      if (head === '') {
        return {
          ok: false,
          message: stt('storetail.unrecognizedPrefix'),
          target, entries: [...entries],
        }
      }
      const next = [...entries]
      next[index] = `${head}${newContent}`
      this.write(target, next, agent)
      return {
        ok: true, message: stt('storetail.updated', { target }), target,
        entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }
}

/**
 * Append-only JSONL queue of background-review memory suggestions
 * (the "learned track" awaiting user confirmation).
 */
export class SuggestionQueue {
  /**
   * @param {string} file - the JSONL file path.
   */
  constructor(file) {
    this.file = file
  }

  /** Read all suggestions; a missing file reads as empty. */
  read() {
    try {
      const text = readFileSync(this.file, 'utf8')
      return text
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  /** Atomically write the full suggestion list. */
  write(entries) {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp.${process.pid}`
    writeFileSync(tmp, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : ''))
    renameSync(tmp, this.file)
  }

  /** Append one suggestion under the directory lock. */
  append(entry) {
    return withLock(dirname(this.file), () => {
      const entries = this.read()
      entries.push(entry)
      this.write(entries)
      return { ok: true, queued: entries.length }
    })
  }

  /**
   * Mutate the suggestion list under the directory lock.
   * @param {(entries: object[]) => T} fn - the mutation; return value is passed through.
   * @returns {T} the mutation's return value.
   * @template T
   */
  mutate(fn) {
    return withLock(dirname(this.file), () => {
      const entries = this.read()
      const result = fn(entries)
      this.write(entries)
      return result
    })
  }
}

/**
 * 归档存储：低优先级记忆的冷存储——"丢了可惜但不够格进主记忆"的建议
 * 落在这里。不注入任何会话；条目可在记忆 Tab「移回主记忆」（转正，写回
 * 对应主轨）或删除。文件与主轨同格式（§ 分隔 + `[YYYY-MM-DD]` 时间戳），
 * 按原 target 分文件：`MEMORY-archive.md` / `USER-archive.md`，以及项目级
 * `projects/<cwd-hash>/KEY-archive.md`（key 轨的归档，随项目走，需 cwd）。
 */
export class ArchiveStore {
  /**
   * @param {string} dir - the memory directory (archive files live beside
   *   the main track files).
   * @param {object} [options]
   * @param {(cwd: string) => string} [options.projectDirResolver] - 项目目录
   *   解析器（记忆同步装配层注入）：sync 项目定位 projectId 目录（审查 P1：
   *   归档写入与迁移/合并必须同一目录）。缺省回退 projectHash(cwd)。
   */
  constructor(dir, options = {}) {
    this.dir = dir
    this.projectDirResolver = typeof options.projectDirResolver === 'function' ? options.projectDirResolver : null
  }

  /** Resolve one archive file path; key requires the project cwd. */
  fileOf(target, cwd) {
    if (target === 'memory') return join(this.dir, 'MEMORY-archive.md')
    if (target === 'user') return join(this.dir, 'USER-archive.md')
    if (target === 'key') {
      if (!cwd) throw new Error('dsh-memory-evolve: key 归档需要会话工作目录')
      const projectDir = this.projectDirResolver
        ? this.projectDirResolver(cwd)
        : join(this.dir, 'projects', projectHash(cwd))
      return join(projectDir, 'KEY-archive.md')
    }
    // todo-* 建议统一归档到 TODO-archive.md（归档条目是普通 § 文本，转正时按
    // 原 target 写回对应待办轨）
    if (typeof target === 'string' && target.startsWith('todo-')) {
      return join(this.dir, 'TODO-archive.md')
    }
    throw new Error(`dsh-memory-evolve: 无效的归档轨 "${target}"`)
  }

  /** Read one archive track's entries; a missing file reads as empty. */
  entriesOf(target, cwd) {
    try {
      return parseEntries(readFileSync(this.fileOf(target, cwd), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  /** Append one entry under the directory lock (atomic write). */
  append(target, content, cwd) {
    // 锁文件所在目录（key 归档=项目目录，与主轨写/合并互斥；全局归档=记忆根）
    const lockDir = dirname(this.fileOf(target, cwd))
    return withLock(lockDir, () => {
      const entries = this.entriesOf(target, cwd)
      entries.push(content)
      const path = this.fileOf(target, cwd)
      const tmp = `${path}.tmp.${process.pid}`
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(tmp, serializeEntries(entries))
      renameSync(tmp, path)
      return { ok: true, total: entries.length }
    })
  }

  /**
   * Remove the single entry containing the unique substring `match`.
   *
   * 两侧都过 normalizeForMatch（issue #59）：归档页回传的是**展示文本**
   * （已剥 `[id:…]` / `[summary:…]`），而归档文件里存的是含元数据的原文——
   * 直接在原文上 `includes(展示文本)` 会因为中间插了元数据而断链。这条路径
   * 是 `promoteArchived()` 转正成功后清理归档文件用的，不修就会出现
   * 「转正成功但归档那条删不掉 → 同一内容同时留在主轨与归档」且不报错。
   */
  remove(target, match, cwd) {
    const lockDir = dirname(this.fileOf(target, cwd))
    return withLock(lockDir, () => {
      // 展示形态子串匹配：归档条目带 [id:]/[salience:] 等头部标签时，Tab
      // 回传的展示文本仍能命中（与主轨精确操作同一归一化）。
      const hit = (entry) => entryDisplayForm(entry).includes(String(match ?? '').trim())
      const entries = this.entriesOf(target, cwd)
      const matches = entries.filter(hit)
      if (matches.length === 0) return { ok: false, message: stt('storetail.archiveNoMatch', { match }) }
      if (matches.length > 1) {
        return { ok: false, message: stt('storetail.archiveMultiMatch', { match, count: matches.length }) }
      }
      const next = entries.filter((entry) => !hit(entry))
      const path = this.fileOf(target, cwd)
      const tmp = `${path}.tmp.${process.pid}`
      writeFileSync(tmp, serializeEntries(next))
      renameSync(tmp, path)
      return { ok: true, removed: matches[0] }
    })
  }

  /**
   * Remove the entry that EXACTLY equals `content` (whole-entry match).
   *
   * 走与主轨同一套 findExactIndex（issue #59）：此前是 `entries.indexOf()`
   * 严格相等，**连 `[id:…]` 都不免疫**——启用 Git 同步后写入身份证的归档
   * 条目（`[id:…]` 前缀）在归档页一律删不掉。归档允许同一内容重复出现，
   * 因此多条命中取首条（`first: true`）而不是报歧义。
   */
  removeExact(target, content, cwd) {
    // 锁目录与 append/remove 同源（归档文件所在目录）——此前锁 this.dir
    // （记忆根），key 轨归档在 projects/<id>/ 下时跨进程互斥失效（审计
    // P1-4：两进程 append/removeExact 交错 → tmp+rename 覆盖式丢更新）。
    const lockDir = dirname(this.fileOf(target, cwd))
    return withLock(lockDir, () => {
      // 展示形态相等（同主轨 findExactIndex）：Tab 回传展示文本可命中带
      // 头部标签的归档原文。
      const view = entryDisplayForm(content)
      const entries = this.entriesOf(target, cwd)
      const index = entries.findIndex((entry) => entryDisplayForm(entry) === view)
      if (index === -1) {
        return { ok: false, message: stt('storetail.archiveEntryMissing') }
      }
      const next = [...entries]
      next.splice(index, 1)
      const path = this.fileOf(target, cwd)
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp.${process.pid}`
      writeFileSync(tmp, serializeEntries(next))
      renameSync(tmp, path)
      return { ok: true, removed: entries[index] }
    })
  }
}
