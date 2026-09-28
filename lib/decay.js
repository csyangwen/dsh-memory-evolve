/**
 * lib/decay.js — 衰减归档候选报告（autopilot-memory-lifecycle Step 5，spec
 * 候选 3）。零依赖：node:fs + 复用 store.js 的锁/日期口径与 hit-stats.js 的
 * 侧车读取。
 *
 * 设计契约（spec AC-4 全组 + 计划 Step 5 + 开放问题 Q4/Q6 缺省决策）：
 *   - **只读派生**：扫描三轨（memory/user/key）产候选清单，**绝不删除、
 *     绝不归档、绝不移动任何条目**（非目标 5——连自动归档也不做，归档动作
 *     完全留给 memory-consolidate 技能/用户裁决）。唯一写动作 = 覆盖写报告
 *     文件 `<memoryDir>/decay-report.json`（tmp+rename 原子写 + 目录锁）。
 *   - 候选判据（spec 候选 3）：`daysSince(lastAccessed ?? 条目日期) >
 *     threshold[salience]`。lastAccessed 来自命中侧车（hit-stats.json）；
 *     无侧车记录（AC-4.2 旧库回退口径）时按条目头部时间戳
 *     （extractEntryDate）代理判定，并计入 metadata.fallbackCount。
 *   - salience：条目 `[salience:N]`（1-3），无 tag 视为 2（中档）——与
 *     parseEntrySalience 的调用方归一口径一致。阈值数组按 salience 1/2/3
 *     索引（config `decayThresholds`，Q4 初值 30/90/180）；**单项 0 = 该档
 *     永不进候选**（AC-4.5）。
 *   - 无日期依据的条目（无侧车记录且条目无时间戳）：保守跳过——既不算
 *     候选也不算 fallback（fallback 专指「用了条目时间戳代理」的条目）。
 *   - 报告 JSON 契约（Q6：本批只定格式，技能侧后续自行接入）：
 *     {
 *       metadata: {
 *         generatedAt:   <ISO 8601 生成时刻>,
 *         fallbackCount: <按条目时间戳代理判定的条数>,
 *         deviceId:      <空串占位（Q2：侧车/报告一期设备本地）>,
 *         thresholds:    <本次判定使用的阈值数组快照>,
 *       },
 *       candidates: [
 *         {
 *           track,        // 'memory' | 'user' | 'key'
 *           id,           // 条目身份证 [id:xxxxxxxx]，无则为 null
 *           hash,         // hitKey 全键（track:sha1，Q1 口径，消费方可回查侧车）
 *           lastAccessed, // 侧车日期（YYYY-MM-DD）；fallback 条目为 null
 *           fallbackDate, // 条目时间戳（仅 fallback 条目非 null，其余为 null）
 *           days,         // 距今天数（>=0；负数=未来日期，不可能成为候选）
 *           threshold,    // 该条命中的阈值（天）
 *           salience,     // 1 | 2 | 3（归一后）
 *           reason,       // 人读原因串（结构化字段已齐，reason 仅供展示）
 *         }, ...
 *       ],
 *     }
 *   - 幂等（AC-4.3）：报告整文件覆盖写；candidates 排序确定性（track 顺序
 *     固定 → 组内 days 降序 → 同 days 按 hash 字典序），连跑两次除
 *     generatedAt 外逐字节一致。
 *   - 排序确定性补充：同一轨内先按扫描序收集（文件读取顺序固定），最后
 *     统一排序，杜绝依赖 Map 迭代序的隐患。
 * @module dsh-memory-evolve/decay
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractEntryDate, parseEntrySalience, parseEntries, todayStamp, withLock } from './store.js'
import { extractEntryId } from './sync/entryid.js'
import { hitKey, readSidecar } from './hit-stats.js'

/** 报告文件名（固定落在 memoryDir 根，与 hit-stats.json 同级）。 */
export const DECAY_REPORT_FILE = 'decay-report.json'

/** 缺省阈值（Q4 初值）：按 salience 1/2/3 索引；单项 0 = 永不。 */
export const DEFAULT_DECAY_THRESHOLDS = [30, 90, 180]

const DAY_MS = 86_400_000

/**
 * 校验/归一阈值配置。合法形态 = 长度恰 3 的数组、元素为非负整数
 * （0 = 永不，AC-4.5）。非法值**响亮抛错**（配置拼错静默回落默认值会让
 * 调参失效且无感——比崩溃更危险）。undefined/null 由调用方处理（此处视
 * 为非法，缺省值由 DEFAULTS 提供）。
 * @param {unknown} value - config.decayThresholds。
 * @returns {number[]} 归一后的三元数组。
 */
export function normalizeDecayThresholds(value) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error('dsh-memory-evolve: decayThresholds 必须是长度为 3 的数组（按 salience 1/2/3 索引）')
  }
  return value.map((n) => {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new Error('dsh-memory-evolve: decayThresholds 的每项必须是非负整数（0 = 该档永不进候选）')
    }
    return n
  })
}

/**
 * 两个 YYYY-MM-DD 日期的整数天差（to - from）。任一解析失败返回 null
 * （调用方按「无日期依据」保守跳过）。负值 = from 在未来（数据异常，
 * 恒不满足候选判据，安全）。
 * @param {string} fromStr - 起始日期（如侧车 lastAccessed）。
 * @param {string} toStr - 结束日期（如今日 todayStamp()）。
 * @returns {number | null} 天差；解析失败为 null。
 */
export function daysBetween(fromStr, toStr) {
  const from = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fromStr ?? ''))
  const to = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(toStr ?? ''))
  if (from === null || to === null) return null
  // P2-3 修复：往返校验——Date.UTC 对越界月/日自动进位（如 2026-13-45 →
  // 2027-02-14），产出貌似合理的错误天数误导候选筛选；用解析值重构
  // YYYY-MM-DD 与输入比对，不一致按解析失败处理（与既有保守口径一致）。
  const canonical = (m) => {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  }
  if (canonical(from) !== String(fromStr) || canonical(to) !== String(toStr)) return null
  const a = Date.UTC(Number(from[1]), Number(from[2]) - 1, Number(from[3]))
  const b = Date.UTC(Number(to[1]), Number(to[2]) - 1, Number(to[3]))
  return Math.floor((b - a) / DAY_MS)
}

/** 读一个主轨文件并解析条目；文件不存在（冷启动）返回空数组。 */
function readTrackEntries(dir, file) {
  let text
  try {
    text = readFileSync(join(dir, file), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  return parseEntries(text)
}

/**
 * 扫描单轨产候选（内部纯函数）：条目日期依据取侧车 lastAccessed，缺失时
 * 回退条目时间戳（fallback）；两者皆无 → 保守跳过。threshold=0 → 该档
 * 永不进候选（AC-4.5，先于日期判定短路）。
 * @returns {{candidates: object[], fallbackCount: number}}
 */
function scanTrack(track, dir, file, thresholds, today) {
  const entries = readTrackEntries(dir, file)
  const candidates = []
  let fallbackCount = 0
  if (entries.length === 0) return { candidates, fallbackCount }
  // 侧车缺失/损坏（readSidecar 返回空表）= 全部条目走 fallback 口径，
  // 与 AC-4.2「旧库回退」语义一致。
  const stats = readSidecar(dir)
  for (const entry of entries) {
    const salience = parseEntrySalience(entry) ?? 2
    const threshold = thresholds[salience - 1]
    if (threshold === 0) continue // 该档永不进候选（AC-4.5）
    const rec = stats[hitKey(track, entry)]
    const sidecarDate = (rec !== null && typeof rec === 'object' && typeof rec.lastAccessed === 'string')
      ? rec.lastAccessed
      : null
    let lastAccessed = null
    let fallbackDate = null
    let days = null
    if (sidecarDate !== null) {
      days = daysBetween(sidecarDate, today)
      if (days !== null) lastAccessed = sidecarDate
    }
    if (days === null) {
      // 侧车无记录或侧车日期损坏 → 条目时间戳代理（AC-4.2）；条目也无
      // 日期 → 保守跳过（不判、不计数）。
      fallbackDate = extractEntryDate(entry)
      if (fallbackDate === null) continue
      days = daysBetween(fallbackDate, today)
      if (days === null) continue
      fallbackCount += 1
    }
    if (days <= threshold) continue
    candidates.push({
      track,
      id: extractEntryId(entry),
      hash: hitKey(track, entry),
      lastAccessed,
      fallbackDate,
      days,
      threshold,
      salience,
      reason: lastAccessed !== null
        ? `上次访问 ${lastAccessed}（${days} 天前）超过阈值 ${threshold} 天（salience ${salience}）`
        : `无命中记录，按条目日期 ${fallbackDate}（${days} 天前）超过阈值 ${threshold} 天（salience ${salience}）`,
    })
  }
  return { candidates, fallbackCount }
}

/** 候选排序（确定性）：days 降序（最陈旧在前）→ 同 days 按 hash 字典序。 */
function sortCandidates(candidates) {
  return candidates.sort((a, b) => (b.days - a.days) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
}

/**
 * 构建衰减报告（**纯计算，不写任何文件**——便于测试与消费方复用）。
 * @param {import('./store.js').MemoryStore} store - 记忆库（memory/user 取
 *   store.dir，key 取 store.locate('key', agent).dir）。
 * @param {object | undefined} agent - 调用方 agent（key 轨定位需要其会话
 *   cwd；缺失时跳过 key 轨——无 cwd 的调用方本就看不到项目轨）。
 * @param {number[]} [thresholds] - 阈值数组（缺省 DEFAULT_DECAY_THRESHOLDS；
 *   非法值响亮抛错）。
 * @param {object} [opts] - { today?: string } 注入当日日期（测试确定性用；
 *   缺省 todayStamp()）。
 * @returns {{ metadata: object, candidates: object[] }} 报告对象（未落盘）。
 */
export function buildDecayReport(store, agent, thresholds = DEFAULT_DECAY_THRESHOLDS, opts = {}) {
  const th = normalizeDecayThresholds(thresholds)
  const today = typeof opts.today === 'string' ? opts.today : todayStamp()
  const keyLoc = store.locate('key', agent)
  const tracks = [
    { track: 'memory', dir: store.dir, file: 'MEMORY.md' },
    { track: 'user', dir: store.dir, file: 'USER.md' },
    ...(keyLoc ? [{ track: 'key', dir: keyLoc.dir, file: 'KEY.md' }] : []),
  ]
  const candidates = []
  let fallbackCount = 0
  for (const t of tracks) {
    const r = scanTrack(t.track, t.dir, t.file, th, today)
    candidates.push(...r.candidates)
    fallbackCount += r.fallbackCount
  }
  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      fallbackCount,
      deviceId: '', // Q2 占位：侧车与报告一期设备本地，不进同步
      thresholds: th,
    },
    candidates: sortCandidates(candidates),
  }
}

/**
 * 读 decay-report.json 的候选数（**只读**，审查联动专用，AC-5.3）。文件
 * 缺失/损坏/形态不符一律返回 0——联动文案只在「报告存在且非空」时附加
 * （AC-5.2：其余情形快照与无联动版逐字节一致）。
 * @param {string} memoryDir - 记忆根目录。
 * @returns {number} 候选数（无有效报告时为 0）。
 */
export function readDecayCandidateCount(memoryDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(memoryDir, DECAY_REPORT_FILE), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.candidates)) {
      return parsed.candidates.length
    }
  } catch {
    // 缺失/损坏 → 视同无报告（不注入联动文案）
  }
  return 0
}

/**
 * 生成并落盘衰减报告（decay action 的完整入口）：buildDecayReport 纯计算
 * + 报告文件覆盖写（tmp+rename 原子写，写盘段在 withLock(memoryDir) 内）。
 * 主轨文件全程只读（AC-4.4 由 tests/decay.test.js 的 SHA256 断言钉住）。
 * @returns {{ report: object, path: string, count: number }}
 */
export function generateDecayReport(store, agent, thresholds = DEFAULT_DECAY_THRESHOLDS) {
  const report = buildDecayReport(store, agent, thresholds)
  const path = join(store.dir, DECAY_REPORT_FILE)
  withLock(store.dir, () => {
    mkdirSync(store.dir, { recursive: true })
    const tmp = `${path}.tmp.${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`)
    renameSync(tmp, path)
  })
  return { report, path, count: report.candidates.length }
}
