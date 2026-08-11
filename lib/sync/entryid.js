/**
 * lib/sync/entryid.js — 条目身份证（entryId）工具（施工图 §7 第 2 步）
 *
 * 背景：跨设备合并需要一个"条目级身份锚点"。记忆条目的时间戳（[YYYY-MM-DD]
 * 等）是程序盖的、replace 会刷新，不能当身份；整条文本在"两台设备各自修改
 * 同一条"时无法判定"谁是谁"。entryId 是解决这个问题的身份证：
 *
 *   - 磁盘形态：`[id:xxxxxxxx]`（8 位 hex）固定在条目**最前**，其后才是
 *     时间戳等程序前缀（splitEntryHead 最优先剥离它，编辑时原样保留）；
 *   - 新条目：add 时生成**随机** ID（8 位 hex，碰撞概率 1/2^32，足够）；
 *   - 旧条目（启用同步前已存在的记忆）：**确定性补发**——sha1(内容归一化)
 *     前 8 位。同一内容在设备 A/B 上补发出同一个 ID，双设备才能对齐；
 *   - replace：继承旧条目 ID（"替换不换身份"，合并器靠它识别"同一件事
 *     被两边改成了两个版本"）；
 *   - 展示层：所有用户可见出口剥离 `[id:…]`（身份证是内部机制，不打扰
 *     阅读）；内部 API（removeExact/updateEntryContent）持完整原文，匹配
 *     不受影响（施工图 §4.7）。
 *
 * 决策来源：用户拍板需求 #6（Codex 评审采纳"确定性 legacy 补发"）。
 */

import { createHash, randomBytes } from 'node:crypto'

/** 条目最前的身份证标记：`[id:xxxxxxxx]`（8 位 hex）+ 一个空格。 */
export const ENTRY_ID_RE = /^\[id:([0-9a-f]{8})\]\s*/

/**
 * 生成一个新条目的随机身份证（8 位 hex）。
 * @returns {string} 8 位 hex。
 */
export function genEntryId() {
  return randomBytes(4).toString('hex')
}

/**
 * 提取条目最前的身份证（只认条目最前，避免误伤正文里的 `[id:…]` 字样）。
 * @param {string} entry - 完整条目原文。
 * @returns {string | null} 8 位 hex，无身份证时 null。
 */
export function extractEntryId(entry) {
  const m = ENTRY_ID_RE.exec(String(entry ?? ''))
  return m === null ? null : m[1]
}

/**
 * 剥离条目最前的身份证标记（含其后空格）。
 * @param {string} entry - 完整条目原文。
 * @returns {string} 无身份证的条目文本。
 */
export function stripEntryId(entry) {
  return String(entry ?? '').replace(ENTRY_ID_RE, '')
}

/**
 * 内容归一化（供确定性补发哈希使用）：trim + 内部连续空白折叠为单个空格。
 * 两台设备上"同一内容"必须产出同一个 ID —— 归一化抹掉仅排版不同的差异
 * （行尾空格、多行缩进等），保证双设备补发一致（施工图 §4.6）。
 * @param {string} entry - 条目原文（补发前通常已含时间戳等程序前缀）。
 * @returns {string} 归一化后的文本。
 */
export function normalizeContent(entry) {
  return String(entry ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 确定性补发：为所有无身份证的条目生成 `[id:<sha1(normalizeContent) 前8位>]`
 * 前缀。**同内容 → 同 ID**：设备 A 与设备 B 的 legacy 条目各自补发后 ID
 * 一致，合并器才能把"同一条老记忆"对齐（施工图 §4.6）。
 *
 * 已带身份证的条目原样保留（不动）；补发位置在条目最前（身份证最优先）。
 *
 * @param {string[]} entries - 条目数组（按存储顺序）。
 * @returns {{ entries: string[], backfilled: number }} 补发后的数组与补发条数。
 */
export function ensureEntryIds(entries) {
  let backfilled = 0
  const next = entries.map((entry) => {
    if (extractEntryId(entry) !== null) return entry // 已有身份证，不动
    const digest = createHash('sha1').update(normalizeContent(entry)).digest('hex').slice(0, 8)
    backfilled += 1
    return `[id:${digest}] ${entry}`
  })
  return { entries: next, backfilled }
}
