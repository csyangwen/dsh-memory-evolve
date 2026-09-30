/**
 * dsh-memory-evolve - memory hygiene audit (issue #57, first slice).
 *
 * Read-only entry/byte accounting for the tracks that can be archived:
 * memory / user / key. Key needs a working directory to resolve the
 * project-scoped file. The audit does not write anything - it only reports
 * usage and which tracks are over their byte budget.
 */

/** Default byte budgets for tracks the audit covers. */
export const DEFAULT_MEMORY_BUDGETS = Object.freeze({
  memory: 64 * 1024,
  user: 32 * 1024,
  key: 32 * 1024,
})

/** Tracks audited in this slice. */
const AUDIT_PATHS = ['memory', 'user', 'key']

/**
 * Account one active memory track.
 * @param {import('./store.js').MemoryStore} store
 * @param {string} target - 'memory' | 'user' | 'key'
 * @param {object | undefined} projectAgent - agent shape supplying `cwd`.
 * @param {Record<string, number>} budgets
 * @returns {object} one audit row.
 */
function inspectTrack(store, target, projectAgent, budgets) {
  let raw
  try {
    raw = store.readRaw(target, projectAgent)
  } catch (error) {
    return {
      target,
      entries: 0,
      bytes: 0,
      budget: budgets[target] ?? DEFAULT_MEMORY_BUDGETS[target],
      overBudget: false,
      error: String(error?.message ?? error),
    }
  }
  const entries = store.entriesOf(target, projectAgent).length
  const budget = budgets[target] ?? DEFAULT_MEMORY_BUDGETS[target]
  const bytes = Number.isFinite(Number(raw?.size)) ? Number(raw.size) : 0
  const percent = budget > 0 ? Math.round((bytes / budget) * 1000) / 10 : 0
  return {
    target,
    entries,
    bytes,
    budget,
    percent,
    overBudget: bytes > budget,
  }
}

/**
 * Build a memory-hygiene audit report.
 *
 * @param {object} deps
 * @param {import('./store.js').MemoryStore} deps.store - the memory store.
 * @param {string | undefined} [deps.cwd] - session working directory; required
 *   for the 'key' track, optional for memory/user.
 * @param {Record<string, number>} [deps.budgets] - per-track byte budgets.
 * @returns {object} the audit report.
 */
export function auditMemoryUsage({ store, cwd, budgets = DEFAULT_MEMORY_BUDGETS } = {}) {
  const projectAgent = cwd ? { session: { header: { cwd: String(cwd) } } } : undefined
  const tracks = []
  for (const target of AUDIT_PATHS) {
    if (target === 'key' && !projectAgent) continue
    tracks.push(inspectTrack(store, target, projectAgent, budgets))
  }
  const overBudget = tracks.filter((track) => track.overBudget)
  return {
    at: new Date().toISOString(),
    tracks,
    overBudget: overBudget.map((track) => track.target),
    needsHygiene: overBudget.length > 0,
  }
}
