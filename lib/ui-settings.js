/**
 * dsh-memory-evolve — DSH UI 设置模块（宿主端）。
 *
 * **独立子模块**（用户拍板纪律：独立领域不挂别的模块下）。职责：给 DSH
 * web 界面做样式级的小功能（第一版：左侧会话列表「仅显示进行中」筛选；
 * 后期扩展：主题更换等）。
 *
 * 宿主端只承担两件事：
 *   1. 独立开关 uiSettingsEnabled（默认关，在「Memory Evolve 设置」Tab 的
 *      「配置」里切换，applyRuntimePatch sync 链即时安装/卸载）；
 *   2. 状态探测端点 GET /api/ui-settings/state → { enabled }——客户端用它
 *      决定是否注入样式与筛选逻辑（模块关闭时端点 404，客户端全部隐藏）。
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
 * @returns {{ dispose: () => void }} 卸载句柄。
 */
export function installUiSettings(ctx) {
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
