/**
 * lib/sync/merge.js — 三路合并器（施工图 §7 第 4 步，纯函数零依赖）
 *
 * 语义：把 base（共同祖先）/ ours（本地）/ theirs（远端）三份记忆文件集
 * 合成为一份工作树文件集 + 冲突清单。**git 冲突标记永不落盘**（需求 #7）：
 * 我们不用 git merge，而是把三个版本都读进内存，按 §6 规则表逐条决策，
 * 只有"双侧都改了同一条"这种罕见情况才进人工处理队列。
 *
 * 关键机制：
 *   - **entryKey 联合索引**：有身份证 [id:xxxx] 按 ID、无身份证按整条文本
 *     兜底。KEY.md 与 KEY-archive.md（以及 logs/）联合索引——ID 全局唯一，
 *     条目属于哪个文件只是它的 location 属性（归档/转正 = location 变化）。
 *   - **确定性补发先行**：入口对三侧全部无 ID 条目先 ensureEntryIds——
 *     双设备的 legacy 条目各自补发出同一 ID，才能识别"同一条被两边改成
 *     两个版本"（不补发则三条文本互不相干，全当新增，产生重复条目）。
 *   - **输出 canonical 保证**：输出文件由 serializeEntries 产出，可被
 *     isCanonical 往返。
 *
 * 规则表（§6，12 行，见 mergeEntry 内注释）：
 *   新增保留 / 双侧同新增去重 / 未动保留 / 单侧修改采用 /
 *   双侧同改一致去重 / 双侧改不同 → 冲突 / 单侧删除生效 /
 *   双侧删除 / 改 vs 删 → 冲突 / location 单侧变化采用、双侧不同 → 冲突。
 */

import { ensureEntryIds, extractEntryId, extractTodoId } from './entryid.js'

/** 项目待办文件名（TODO 格式：header + tag 行 id，与记忆文件不同——见 index）。 */
const TODO_FILE = 'TODOS.md'

/**
 * 三路合并。
 * @param {Record<string, string[]>} baseFiles - base 侧 { 相对路径: 条目[] }。
 * @param {Record<string, string[]>} oursFiles - ours 侧（本地工作树）。
 * @param {Record<string, string[]>} theirsFiles - theirs 侧（远端树）。
 * @returns {{ files: Record<string, string[]>, conflicts: Array<object>,
 *   removed: Array<object>, stats: {added: number, modified: number,
 *   removed: number, conflicts: number} }}
 *   files = 合并后的 { 路径: 条目[] }（每文件 canonical 可往返）；
 *   conflicts = [{ entryKey, file, base, ours, theirs, reason }]。
 */
export function mergeEntries(baseFiles, oursFiles, theirsFiles) {
  // 路径集合 = 三侧并集（输出文件都要存在——空数组 = 空文件占位）
  const allPaths = new Set([...Object.keys(baseFiles ?? {}), ...Object.keys(oursFiles ?? {}), ...Object.keys(theirsFiles ?? {})])

  // 建索引：entryKey → { location, text }（先到先得，防御同侧重复 ID）
  // TODO 文件分流（2026-08-11 统一模式，项目待办并入项目记忆轨）：
  //   - 不补发行首身份证——TODO 条目已有 tag id（[id: xxxx]），补发前缀会
  //     破坏 todo.js 的 tag 解析（行首被 [id:…] 占位）；
  //   - entryKey 用 tag id（extractTodoId）；无 id 的异常条目整条兜底。
  // **命名空间（Codex 终审 P0-5 修复）**：TODO 的 tag id 与记忆的行首 id
  // 由两个模块独立随机生成（碰撞概率 1/2^32），裸 8hex 作 key 会跨模块
  // 撞车 → 先到先得静默丢条目（已复现：KEY 与 TODOS 同 id 时 TODOS 输出
  // 被清空）。前缀 `m:`（记忆）/ `t:`（TODO）隔离两个命名空间；无 id 的
  // 条目用 `raw:` + 整条文本（保持原跨文件去重语义——同文本同一条）。
  const index = (files) => {
    const map = new Map()
    for (const [location, rawEntries] of Object.entries(files ?? {})) {
      const isTodo = location === TODO_FILE
      const entries = isTodo ? (rawEntries ?? []) : ensureEntryIds(rawEntries ?? []).entries
      for (const text of entries) {
        const id = isTodo ? extractTodoId(text) : extractEntryId(text)
        const key = id !== null ? `${isTodo ? 't:' : 'm:'}${id}` : `raw:${text}`
        if (!map.has(key)) map.set(key, { location, text })
      }
    }
    return map
  }
  const base = index(baseFiles)
  const ours = index(oursFiles)
  const theirs = index(theirsFiles)

  // 稳定的 key 遍历顺序：base 序 → ours 新增 → theirs 新增（确定性输出）
  const keys = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])

  const out = {} // location → entries[]
  const conflicts = []
  const removed = [] // 删除报告（KEY 轨默认保守：报告内提示可恢复）
  const stats = { added: 0, modified: 0, removed: 0, conflicts: 0 } // 决策统计

  const push = (location, text) => {
    ;(out[location] ??= []).push(text)
  }

  for (const key of keys) {
    const b = base.get(key)
    const o = ours.get(key)
    const t = theirs.get(key)
    const decision = mergeEntry(b, o, t)
    if (decision.kind === 'keep') {
      push(decision.location, decision.text)
      if (b === undefined) stats.added += 1
      else if (!sameEntry(b, decision)) stats.modified += 1
    } else if (decision.kind === 'remove') {
      stats.removed += 1
      if (decision.report) removed.push({ entryKey: key, location: decision.location, text: decision.text })
    } else if (decision.kind === 'conflict') {
      stats.conflicts += 1
      conflicts.push({
        entryKey: key,
        file: o?.location ?? t?.location ?? b?.location ?? '',
        base: b?.text ?? null,
        ours: o?.text ?? null,
        theirs: t?.text ?? null,
        reason: decision.reason,
      })
    }
  }

  // 空文件也输出（路径并集），保证三侧删除后文件不残留
  for (const path of allPaths) {
    if (out[path] === undefined) out[path] = []
  }

  return { files: out, conflicts, removed, stats }
}

/** 判断 keep 决策的条目与 base 是否一致（用于 modified 统计）。 */
function sameEntry(b, decision) {
  return b.text === decision.text && b.location === decision.location
}

/**
 * 单条目的三路决策（§6 规则表逐行实现）。
 * @param {{location: string, text: string} | undefined} b - base 侧。
 * @param {{location: string, text: string} | undefined} o - ours 侧。
 * @param {{location: string, text: string} | undefined} t - theirs 侧。
 * @returns {{kind: 'keep', location: string, text: string}
 *   | {kind: 'remove', report?: boolean, location?: string, text?: string}
 *   | {kind: 'conflict', reason: string}}
 */
function mergeEntry(b, o, t) {
  const same = (a, c) => a !== undefined && c !== undefined && a.text === c.text && a.location === c.location
  const unmodified = (x) => b !== undefined && x !== undefined && same(b, x)

  // ── 新增（base 无此条）──
  if (b === undefined) {
    if (o !== undefined && t === undefined) return { kind: 'keep', location: o.location, text: o.text }
    if (o === undefined && t !== undefined) return { kind: 'keep', location: t.location, text: t.text }
    if (o !== undefined && t !== undefined) {
      if (same(o, t)) return { kind: 'keep', location: o.location, text: o.text } // 双侧同新增 → 去重一条
      // 同 ID 不同内容（理论不发生：ID 唯一随机）→ 进人工。注意与施工图
      // "都保留并报告"的微差：同 ID 双条目会破坏联合索引唯一性，人工处理
      // 更安全（数据损坏信号，不猜）。
      return {
        kind: 'conflict',
        reason: '双侧新增同一 ID 且内容不同（理论不发生，ID 唯一随机）',
      }
    }
    return { kind: 'remove' } // 三侧皆无（不可达）
  }

  // ── base 存在：按"哪侧动了"分派 ──
  const oChanged = o === undefined || !same(b, o)
  const tChanged = t === undefined || !same(b, t)

  if (!oChanged && !tChanged) {
    return { kind: 'keep', location: b.location, text: b.text } // 未动：保留 base
  }
  if (oChanged && !tChanged) {
    if (o === undefined) {
      // 单侧删除（theirs 未动、ours 删）：删除生效（报告提示可恢复）
      return { kind: 'remove', report: true, location: b.location, text: b.text }
    }
    return { kind: 'keep', location: o.location, text: o.text } // 单侧修改：采用 ours
  }
  if (!oChanged && tChanged) {
    if (t === undefined) {
      return { kind: 'remove', report: true, location: b.location, text: b.text } // 单侧删除
    }
    return { kind: 'keep', location: t.location, text: t.text } // 单侧修改：采用 theirs
  }

  // ── 双侧都动了 ──
  if (o === undefined && t === undefined) return { kind: 'remove' } // 双方删除
  if (o === undefined || t === undefined) {
    // 一侧改（或挪位置）一侧删 → 保守进人工（不猜，施工图 §6）
    return { kind: 'conflict', reason: '一侧修改一侧删除' }
  }
  if (same(o, t)) {
    return { kind: 'keep', location: o.location, text: o.text } // 双侧同改一致 → 去重
  }
  // 双侧改且不同：内容不同 → content；仅 location 不同 → location
  const contentDiff = o.text !== t.text
  const locationDiff = o.location !== t.location
  return {
    kind: 'conflict',
    reason: contentDiff && locationDiff ? '内容与位置双侧不同' : contentDiff ? '内容双侧不同' : '位置双侧不同（归档/转正冲突）',
  }
}
