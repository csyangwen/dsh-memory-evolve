/**
 * dsh-memory-evolve — Mermaid 图表渲染模块（宿主端）。
 *
 * **独立子模块**（用户拍板纪律：独立领域不挂别的模块下）。职责：为 DSH
 * web 界面补上 Mermaid 图表渲染（client 侧 DOM 增强，见
 * docs-local/Mermaid显示支持-调研-20260810.md 6.2 节方案）。
 *
 * 宿主端只承担一件事：把 mermaid 的浏览器构建产物（UMD，约 3.4MB）通过
 * 静态端点提供给 client。原因：
 *   - 插件零运行时依赖 + client bundle 是 esbuild 单文件（cjs）——mermaid
 *     直接 import 会被打进主 bundle，GUI 首屏加载膨胀几 MB；
 *   - 懒加载 + 本地静态端点 = 不依赖外网 CDN（内网/离线/手机 App 都可用），
 *     首次见到 mermaid 块才加载，之后浏览器缓存；
 *   - 渲染本身在浏览器本地执行（不占 DSH 主进程 CPU）。
 *
 * 端点（插件加载即注册，不跟随任何开关——client 的「Mermaid 图表渲染」
 * 功能开关只决定 client 是否注入渲染器，静态文件本身无副作用）：
 *   GET /memory-evolve/mermaid/mermaid.min.js
 *
 * vendor 文件来源：DSH checkout node_modules/mermaid/dist/mermaid.min.js
 * （mermaid@11.16.0，MIT License，见 README-详细说明.md 第三方声明）。
 * 与上游同步方式：重新复制该文件到 vendor/ 即可（版本锁定于 vendor 内）。
 *
 * 零运行时依赖（node:fs only）。httpServer 是 web-only 服务，必须在内部
 * ctx.inject 动态注入（模块级 inject 声明会导致 TUI 面上永久 pending）。
 *
 * @module dsh-memory-evolve/mermaid
 */

import { readFileSync } from 'node:fs'

/** 静态文件路径：插件根/vendor/mermaid.min.js（lib/ 的上一级）。 */
const MERMAID_FILE = new URL('../vendor/mermaid.min.js', import.meta.url)

/** 缓存文件内容（首次读取后驻留内存，避免每次请求读盘 3.4MB）。 */
let cachedSource = null

/** 发送 JSON 响应（404 兜底）。 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/**
 * 安装 Mermaid 模块的宿主端部分（静态端点）。
 *
 * @param {object} ctx - cordis 上下文（各面通用）。
 * @returns {{ dispose: () => void }} 卸载句柄。
 */
export function installMermaid(ctx) {
  let cancel = null
  ctx.inject(['webServer'], (webCtx) => {
    cancel = webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/memory-evolve/mermaid',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (req.method === 'GET' && url.pathname === '/memory-evolve/mermaid/mermaid.min.js') {
          try {
            // 首次读取后缓存；读取失败（vendor 文件缺失）时 404，client
            // 端加载失败会静默降级回代码块，不报错。
            if (cachedSource === null) cachedSource = readFileSync(MERMAID_FILE)
            // 浏览器构建产物是普通 JS，按 script 加载需 JS 类型；缓存 1
            // 小时（client 每次页面刷新重新请求一次，代价可忽略）。
            res.writeHead(200, {
              'content-type': 'application/javascript; charset=utf-8',
              'cache-control': 'public, max-age=3600',
            })
            res.end(cachedSource)
          } catch {
            sendJson(res, 404, { error: 'mermaid vendor file missing' })
          }
          return
        }
        sendJson(res, 404, { error: 'not found' })
      },
    }), 'dsh-memory-evolve: mermaid static route')
  })

  return {
    dispose() {
      cancel?.()
    },
  }
}
