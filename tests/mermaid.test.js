import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installMermaid } from '../lib/mermaid.js'

/**
 * Mermaid 模块宿主端测试：静态端点注册与响应（v1 一期，覆盖：
 * 端点返回 vendor 文件 200、404 兜底、内容缓存、卸载清理）。
 *
 * installMermaid 只依赖 ctx.inject(['webServer'])——用最小 fake 上下文
 * 捕获注册的 handler 后直接调用（node:http 风格 req/res 极简桩）。
 */

/** 捕获 webServer.register 的注册项；ctx.inject 立即执行回调（web-only 服务）。 */
function fakeWebCtx() {
  const registered = []
  const webCtx = {
    registered,
    effect: (fn) => { const dispose = fn(); return () => dispose?.() },
    webServer: {
      register: (entry) => {
        registered.push(entry)
        return () => { /* dispose 桩 */ }
      },
    },
  }
  return {
    registered,
    inject: (deps, fn) => fn(webCtx),
  }
}

/** 极简 req/res 桩：记录 writeHead/end，按 URL 分派 handler。 */
function makeRequest(url) {
  const res = {
    status: 0,
    body: '',
    headers: {},
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {} },
    end(text) { this.body = text ?? '' },
  }
  return { req: { method: 'GET', url }, res }
}

function invoke(handler, url) {
  const { req, res } = makeRequest(url)
  // handler 是 async，等待完成
  return Promise.resolve(handler(req, res)).then(() => res)
}

test('installMermaid：注册前缀端点并返回 mermaid.min.js（200 + vendor 内容）', async () => {
  const webCtx = fakeWebCtx()
  installMermaid(webCtx)
  assert.equal(webCtx.registered.length, 1)
  const entry = webCtx.registered[0]
  assert.equal(entry.kind, 'prefix')
  assert.equal(entry.path, '/memory-evolve/mermaid')

  const res = await invoke(entry.handler, '/memory-evolve/mermaid/mermaid.min.js')
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /javascript/)
  // 内容与 vendor 文件一致（3.4MB 文件只比对头部特征，避免测试读全量；
  // res.end 收到的是 Buffer，需转字符串比较）
  const expected = readFileSync(new URL('../vendor/mermaid.min.js', import.meta.url), 'utf8').slice(0, 200)
  assert.ok(Buffer.isBuffer(res.body) ? res.body.toString('utf8').startsWith(expected) : res.body.startsWith(expected), '端点应返回 vendor 文件原文')
})

test('installMermaid：非 mermaid 路径返回 404 JSON 兜底', async () => {
  const webCtx = fakeWebCtx()
  installMermaid(webCtx)
  const res = await invoke(webCtx.registered[0].handler, '/memory-evolve/mermaid/other.js')
  assert.equal(res.status, 404)
  assert.match(res.headers['content-type'], /application\/json/)
})

test('installMermaid：post 方法被拒绝（只服务 GET）', async () => {
  const webCtx = fakeWebCtx()
  installMermaid(webCtx)
  const { req, res } = makeRequest('/memory-evolve/mermaid/mermaid.min.js')
  req.method = 'POST'
  await webCtx.registered[0].handler(req, res)
  assert.equal(res.status, 404)
})
