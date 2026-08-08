/**
 * COI 用量统计 — 从任务仓库聚合各 COI 的调用次数与耗时。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 适配器平均耗时统计文件名（coiDataDir 下）。 */
export const ADAPTER_STATS_FILE = 'stats.json'

/**
 * @param {import('./tasks-store.js').TaskStore} tasks
 * @returns {object} { total, byAdapter: { <adapterId>: { count, totalMs, byStatus } } }
 */
export function coiStats(tasks) {
  const byAdapter = {}
  let total = 0
  for (const task of tasks.tasks) {
    total += 1
    const bucket = (byAdapter[task.adapterId] ??= { count: 0, totalMs: 0, byStatus: {} })
    bucket.count += 1
    bucket.byStatus[task.status] = (bucket.byStatus[task.status] ?? 0) + 1
    if (task.startedAt && task.finishedAt) {
      bucket.totalMs += Math.max(0, task.finishedAt - task.startedAt)
    }
  }
  return { total, byAdapter }
}

/**
 * 适配器平均耗时聚合（持久化，coi/stats.json）——任务 **completed** 时由
 * 调度器累加本次耗时（failed/killed/interrupted 不算正常完成，不计入），
 * 供 de_coi_adapters 返回给模型选型参考。任务明细耗时已有任务记录
 * （startedAt/finishedAt）负责，这里只存**聚合值**（count + totalMs），
 * 不重复记录明细；且任务留档按 retentionDays 清理后平均耗时仍保留。
 * 文件结构：{ "<adapterId>": { count, totalMs } }。
 */

/** 读适配器耗时聚合表；文件缺失/损坏返回空表。 */
export function loadAdapterStats(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 累加一次完成的耗时（毫秒），原子写；失败静默（统计不影响任务）。 */
export function recordAdapterStats(file, adapterId, ms) {
  try {
    const stats = loadAdapterStats(file)
    const bucket = (stats[adapterId] ??= { count: 0, totalMs: 0 })
    bucket.count += 1
    bucket.totalMs += Math.max(0, ms)
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(stats, null, 2) + '\n')
    renameSync(tmp, file)
  } catch {
    /* 统计写失败不影响任务 */
  }
}

/** 某适配器的平均完成耗时（毫秒；无记录返回 0）。 */
export function adapterAvgMs(file, adapterId) {
  const bucket = loadAdapterStats(file)[adapterId]
  return bucket && bucket.count > 0 ? Math.round(bucket.totalMs / bucket.count) : 0
}
