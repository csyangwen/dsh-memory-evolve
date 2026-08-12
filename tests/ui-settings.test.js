/**
 * dsh-memory-evolve — DSH UI 设置模块（宿主端）测试。
 *
 * 验证 installUiSettings：状态探测端点 GET /api/ui-settings/state 返回
 * { enabled: true }、其他路径 404、dispose 清理注册。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installUiSettings } from '../lib/ui-settings.js'

/** 与 plugin.test.js 同款的 fake ctx（inject 对已存在服务立即回调）。 */
function fakeCtx() {
  const state = { routes: [] }
  const services = {
    webServer: {
      register: (route) => {
        state.routes.push(route)
        // 返回 disposer：记录调用以便断言 dispose 清理。
        return () => { state.routes = state.routes.filter((r) => r !== route) }
      },
    },
  }
  const ctx = {
    state,
    webServer: services.webServer, // inject 回调收到的 ctx 上服务可达
    inject: (deps, callback) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return { dispose: () => {} }
      const disposer = callback(ctx)
      return { dispose: disposer ?? (() => {}) }
    },
    effect: (fn) => {
      const disposer = fn()
      return disposer ?? (() => {})
    },
    get: (key) => services[key],
  }
  return ctx
}

/** 构造一个极简 IncomingMessage/ServerResponse 双胞胎，捕获写出的响应。 */
function fakeReqRes(method, url) {
  const res = { status: 0, body: '', ended: false }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (text) => { res.body = text; res.ended = true }
  return {
    req: { method, url, on: () => {} },
    res,
  }
}

test('installUiSettings registers the state endpoint and answers correctly', async () => {
  const ctx = fakeCtx()
  // deps.getRunningSnapshot：a975013 起 installUiSettings(ctx, deps) 需要
  // 运行快照构建函数（测试里给空快照即可，状态端点不依赖它）。
  const installed = installUiSettings(ctx, { getRunningSnapshot: () => ({ total: 0, groups: [] }) })
  assert.equal(ctx.state.routes.length, 1, 'one route registered')
  assert.equal(ctx.state.routes[0].kind, 'prefix')
  assert.equal(ctx.state.routes[0].path, '/memory-evolve/api/ui-settings')

  const { req, res } = fakeReqRes('GET', '/memory-evolve/api/ui-settings/state')
  await ctx.state.routes[0].handler(req, res)
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { enabled: true })

  // 其他路径 404。
  const miss = fakeReqRes('GET', '/memory-evolve/api/ui-settings/other')
  await ctx.state.routes[0].handler(miss.req, miss.res)
  assert.equal(miss.res.status, 404)

  // dispose 清理注册。
  installed.dispose()
  assert.equal(ctx.state.routes.length, 0, 'route removed after dispose')
})

test('installUiSettings tolerates surfaces without webServer', () => {
  // TUI 面：无 webServer 服务 → inject 不回调，dispose 无副作用。
  const ctx = { inject: () => ({ dispose: () => {} }), effect: () => () => {} }
  const installed = installUiSettings(ctx, { getRunningSnapshot: () => ({ total: 0, groups: [] }) })
  installed.dispose()
})
