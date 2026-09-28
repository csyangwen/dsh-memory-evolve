/**
 * lib/hit-stats.js — 命中统计侧车（sidecar）存储（autopilot-memory-lifecycle
 * Step 1）。零依赖：node:crypto sha1 + node:fs，锁复用 store.js 的 withLock。
 *
 * 设计契约（spec docs/specs/autopilot-memory-lifecycle.md 候选 1）：
 *   - 侧车文件路径：`<dir>/hit-stats.json`。**dir 由调用方传入**（钉死）——
 *     调用方（lib/index.js 回填钩子）用 `store.locate(target, agent)?.dir`
 *     解析：memory/user 轨 = 记忆根目录（`<memoryDir>/hit-stats.json`），
 *     key 轨 = 项目记忆目录（`projects/<id>/hit-stats.json`）。
 *   - 键口径（Q1）：`track + ':' + sha1(条目字符串原样)`——条目字符串必须是
 *     parseEntries() 返回的磁盘 round-trip 形态（含 [id:…]/[summary:…] 等
 *     头部 tag），禁止用展示剥离（stripEntryId/stripEntrySummary）之后的文本。
 *   - 失败隔离：bumpHits 读改写全程 try/catch，**任何异常不上抛**、只
 *     console.error 留档——侧车故障绝不影响 list/expand 主流程（Step 2 契约）。
 *   - 损坏降级（AC-1.4）：侧车 JSON.parse 失败/非对象 → console.error 告警
 *     + 返回空表（统计静默重置，下次命中重新累计）。
 *   - 原子写：tmp + rename（照 store.js write() 先例，tmp 名带进程号）；
 *     读改写整体在 withLock(dir) 内，跨进程互斥。
 *   - 不进同步：hit-stats.json 不在任何同步 fileset 清单内（AC-1.7，
 *     tests/hit-stats.test.js 钉住）——命中统计是设备本地数据（Q2）。
 * @module dsh-memory-evolve/hit-stats
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { todayStamp, withLock } from './store.js'

/** 侧车文件名（固定，落在调用方给定的轨道目录下）。 */
export const HIT_STATS_FILE = 'hit-stats.json'

/**
 * 计算一条记忆条目的命中统计键。
 * @param {string} track - 记忆轨（'memory' | 'user' | 'key'）。
 * @param {string} entry - 条目字符串**原样**（parseEntries 返回形态，Q1 口径）。
 * @returns {string} `<track>:<sha1hex>` 形态的键。
 */
export function hitKey(track, entry) {
  return `${track}:${createHash('sha1').update(String(entry), 'utf8').digest('hex')}`
}

/**
 * 读取侧车命中统计表（不做任何写入）。
 * @param {string} dir - 轨道目录（侧车文件所在目录）。
 * @returns {Record<string, {hitCount: number, lastAccessed: string}>}
 *   统计表；文件不存在（冷启动，AC-1.3）或损坏（AC-1.4）时返回空表。
 */
export function readSidecar(dir) {
  const path = join(dir, HIT_STATS_FILE)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return {} // 冷启动：无侧车 = 空表
    console.error(`[hit-stats] 侧车读取失败，降级为空表: ${error && error.message ? error.message : error}`)
    return {}
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('侧车内容不是 JSON 对象')
    }
    // 修复轮 F-2（安全评审）：JSON.parse 会把 __proto__ / constructor 解析为
    // 自有属性（V8 语义，不设原型）——当前消费全部走 track:sha1 受限键形、
    // 现状无可达污染路径，但侧车是常被后续功能扩展的数据结构，返回前收口
    // 删除危险自有键，钉死「消费方拿到的表永不携带这两个键」的契约。
    if (Object.prototype.hasOwnProperty.call(parsed, '__proto__')) delete parsed.__proto__
    if (Object.prototype.hasOwnProperty.call(parsed, 'constructor')) delete parsed.constructor
    return parsed
  } catch (error) {
    console.error(`[hit-stats] 侧车损坏，命中统计已静默重置: ${error && error.message ? error.message : error}`)
    return {}
  }
}

/**
 * 批量命中回填：entries 中每条 +1 hitCount 并刷新 lastAccessed（当日本地
 * 日期，与条目时间戳 todayStamp 同源口径）。读改写整体在 withLock(dir) 内，
 * 原子写 tmp+rename；**全程 try/catch，任何异常不上抛**（失败隔离契约）。
 * @param {string} dir - 轨道目录（侧车文件所在目录）。
 * @param {string} track - 记忆轨（'memory' | 'user' | 'key'）。
 * @param {string | string[]} entries - 命中的条目字符串（原样口径）或其数组。
 * @returns {void}
 */
export function bumpHits(dir, track, entries) {
  try {
    const list = (Array.isArray(entries) ? entries : [entries])
      .map((e) => String(e))
      .filter((e) => e.trim().length > 0)
    if (list.length === 0) return
    withLock(dir, () => {
      const stats = readSidecar(dir)
      const today = todayStamp()
      for (const entry of list) {
        const key = hitKey(track, entry)
        const rec = stats[key]
        if (rec !== null && typeof rec === 'object') {
          rec.hitCount = (Number(rec.hitCount) || 0) + 1
          rec.lastAccessed = today
        } else {
          stats[key] = { hitCount: 1, lastAccessed: today }
        }
      }
      // 原子写：tmp + rename（store.js write() 先例；锁内写，无并发撕裂）
      mkdirSync(dir, { recursive: true })
      const path = join(dir, HIT_STATS_FILE)
      const tmp = `${path}.tmp.${process.pid}`
      writeFileSync(tmp, `${JSON.stringify(stats, null, 2)}\n`)
      renameSync(tmp, path)
    })
  } catch (error) {
    // 失败隔离：侧车任何异常（锁超时/磁盘/权限…）不得上抛影响主流程
    console.error(`[hit-stats] 命中回填失败（已忽略）: ${error && error.message ? error.message : error}`)
  }
}

/**
 * 使用申报解析（PR #66 后续增强，块 7；用户洞察：模型实际只从注入快照读
 * 记忆、几乎不调 list/expand，命中信号必须能从「使用申报」流入）——把
 * 模型申报的独特子串解析为真实条目命中。
 *
 * 解析规则（钉死）：每个 ref 按 memory→user→key 轨序扫描；某轨内含该 ref
 * 的条目**恰 1 条** → 命中（track, entry 原文）；0 条或多条 → 换轨再试；
 * 全轨未命中或多义 → 计入 unmatched（不报错）。单调用内 ref 去重（Set）。
 * 纯函数（不做 I/O、不直接 bumpHits）——调用方收集各轨条目与目录、对本
 * 函数产出的 hits 逐条 bumpHits（失败隔离在调用方 try/catch 内）。
 * @param {Record<string, string[]>} trackEntries - 各轨条目（原样口径，
 *   parseEntries 形态）：{ memory: [...], user: [...], key: [...] }。
 * @param {string[]} refs - 模型申报的独特子串数组。
 * @returns {{ hits: Array<{track: string, entry: string}>, unmatched: string[] }}
 */
export function resolveUsedRefs(trackEntries, refs) {
  const hits = []
  const unmatched = []
  const seen = new Set()
  for (const raw of Array.isArray(refs) ? refs : []) {
    const ref = String(raw).trim()
    if (ref === '') continue
    if (seen.has(ref)) continue // 单调用内去重：重复 ref 只解析一次
    seen.add(ref)
    let matched = null
    for (const track of ['memory', 'user', 'key']) {
      const entries = trackEntries[track]
      if (!Array.isArray(entries)) continue
      const matches = entries.filter((entry) => entry.includes(ref))
      if (matches.length === 1) {
        matched = { track, entry: matches[0] }
        break
      }
      // 0 条（未命中）或多条（多义）→ 换轨再试；全轨失败计入 unmatched
    }
    if (matched !== null) hits.push(matched)
    else unmatched.push(ref)
  }
  return { hits, unmatched }
}
