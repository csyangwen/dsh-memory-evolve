/**
 * COI 用量统计 — 从任务仓库聚合各 COI 的调用次数与耗时。
 */
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
