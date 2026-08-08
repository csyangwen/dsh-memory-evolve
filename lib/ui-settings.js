/**
 * dsh-memory-evolve — DSH UI 设置模块（宿主端）。
 *
 * **独立子模块**（用户拍板纪律：独立领域不挂别的模块下）。职责：给 DSH
 * web 界面做样式级的小功能（第一版：左侧会话列表「仅显示进行中」筛选 +
 * 折叠工作区运行徽标；后期扩展：主题更换等）。
 *
 * 宿主端承担两件事：
 *   1. 独立开关 uiSettingsEnabled（默认关，在「Memory Evolve 设置」Tab 的
 *      「配置」里切换，applyRuntimePatch sync 链即时安装/卸载）；
 *   2. 状态端点：
 *      - GET /api/ui-settings/state → { enabled }：客户端探测模块开关
 *        （模块关闭时端点 404，客户端全部不注入）；
 *      - GET /api/ui-settings/running → { total, groups }：**运行中会话
 *        快照**——折叠的工作区分组不渲染会话行，DOM 计数会漏，所以由
 *        宿主端精确统计（agents.roots 状态 + workspace.sessionIds 归属），
 *        客户端用它刷新筛选按钮计数与折叠行运行徽标。
 *
 * 筛选偏好（开/关、是否默认只显示进行中）是纯客户端偏好，存 localStorage
 * （GUI 自身偏好同款存储）；本模块未来扩展（主题等）如有服务端持久化需求
 * 再在此处加端点。零运行时依赖（node:http only）。
 *
 * @module dsh-memory-evolve/ui-settings
 */

/** 发送 JSON 响应。 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/**
 * 安装 DSH UI 设置模块的宿主端部分。
 *
 * httpServer 是 web-only 服务，必须在内部 ctx.inject 动态注入（模块级
 * inject 声明会导致 TUI 面上永久 pending）。
 *
 * @param {object} ctx - cordis 上下文（各面通用）。
 * @param {object} deps - { getRunningSnapshot }：运行中会话快照构建函数
 *   （由 index.js 用 agents/workspace 服务实现，返回
 *   { total, groups: [{ title, workspaceId, running }] }）。
 * @returns {{ dispose: () => void }} 卸载句柄。
 */
export function installUiSettings(ctx, deps) {
  const { getRunningSnapshot } = deps
  let cancel = null
  // 状态端点：模块开启才注册（关闭时 404，客户端探测失败即隐藏全部注入）。
  ctx.inject(['httpServer'], (webCtx) => {
    cancel = webCtx.effect(() => webCtx.httpServer.register({
      kind: 'prefix',
      path: '/memory-evolve/api/ui-settings',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (req.method === 'GET' && url.pathname === '/memory-evolve/api/ui-settings/state') {
          sendJson(res, 200, { enabled: true })
          return
        }
        if (req.method === 'GET' && url.pathname === '/memory-evolve/api/ui-settings/running') {
          // 快照构建失败时返回空（客户端按 0 处理，不影响界面）。
          try {
            sendJson(res, 200, getRunningSnapshot())
          } catch {
            sendJson(res, 200, { total: 0, groups: [] })
          }
          return
        }
        sendJson(res, 404, { error: 'not found' })
      },
    }), 'dsh-memory-evolve: ui-settings route')
  })

  return {
    dispose() {
      cancel?.()
      cancel = null
    },
  }
}
