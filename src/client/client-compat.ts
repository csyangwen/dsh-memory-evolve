/**
 * DSH 客户端服务的跨版本入口（2026-09-28，DSH 0.2.0 适配）。
 *
 * 目前只有一件事：**切换到指定会话**。它在 0.2.0 换了入口——
 *
 *   旧（≤ 0.1.5-rc.2）：`ctx.sessions.open(id)`
 *     `ClientSessions.open(id)`，见 packages/api/session-controller/src/client/sessions/service.ts。
 *   新（0.2.0-rc.1+）：`sessions` 服务删掉了 `open()`（同一文件里只剩内部
 *     `waitForOpen`/`attachOpening`），官方改为 `ctx.uiWorkspace.openSession(id)`
 *     ——官方自己的 ui-chat 就是这么迁的
 *     （packages/client/ui-chat/src/client/apply.ts：
 *      `.then((childId) => { ctx.uiWorkspace.openSession(childId) })`）。
 *
 * 旧代码在新宿主上不会报错于编译期、也不会在加载期报错——只会在用户点
 * 「跳转到会话」时抛 `TypeError: ctx.sessions.open is not a function`。
 * 本模块按「旧入口优先 → 新入口 → 静默放弃」解析：老宿主行为一字不变，
 * 新宿主走 uiWorkspace；两者都没有时返回 false（调用方据此提示失败，
 * 而不是把异常甩给用户）。
 *
 * @module dsh-memory-evolve/client-compat
 */

/** 服务读数用的最小上下文形状（只用到 cordis 的 ctx.get）。 */
interface ServiceReader {
  get?: (name: string) => unknown
}

/** 带 openSession 的工作区导航服务（DSH 0.2.0+）。 */
interface WorkspaceNavigation {
  openSession?: (sessionId: string) => void
}

/** 带 open 的会话服务（DSH ≤ 0.1.5）。 */
interface LegacySessions {
  open?: (sessionId: string) => void
}

/**
 * 切换到某个会话（跨版本兼容）。
 * @param ctx - 客户端插件上下文（需要 ctx.get）。
 * @param sessionId - 目标会话 id。
 * @returns 是否成功发起跳转（两代入口都不可用时为 false）。
 */
export function openSessionCompat(ctx: ServiceReader | undefined, sessionId: string): boolean {
  if (!ctx || typeof sessionId !== 'string' || sessionId.length === 0) return false
  const read = (name: string): unknown => {
    try {
      return ctx.get?.(name)
    } catch {
      return undefined
    }
  }
  // 旧宿主（≤ 0.1.5-rc.2）：sessions.open 是官方唯一切换入口。
  const sessions = read('sessions') as LegacySessions | undefined
  if (sessions && typeof sessions.open === 'function') {
    sessions.open(sessionId)
    return true
  }
  // 新宿主（0.2.0-rc.1+）：sessions 不再有 open，改走 uiWorkspace.openSession。
  const workspace = read('uiWorkspace') as WorkspaceNavigation | undefined
  if (workspace && typeof workspace.openSession === 'function') {
    workspace.openSession(sessionId)
    return true
  }
  return false
}
