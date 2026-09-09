import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * 配置面板保存链路的回归测试。
 *
 * 背景（本次修复的 bug）：`MemoryQueueView.saveConfig()` 手工拼了一个固定
 * patch 对象发给宿主，键列表是**手写**的——`perTurnWriteGuard` 与
 * `writeGuardThreshold` 有控件（draft 绑定、勾选立即生效）却没进 patch，
 * 于是「勾上 → 保存 → 刷新」变成未勾选：宿主 `updateRuntime()` 压根没收到
 * 这两个键，`plugin-state.json` 自然不落盘，GET 回显的仍是默认 false。
 *
 * 这类 bug 单元测试抓不到（宿主侧 validate/落盘都是好的，坏的是客户端
 * payload），所以这里做**静态契约断言**：面板里所有 draft 绑定键必须都出现
 * 在 saveConfig 的 patch 里，且 TS 源码与构建产物 lib/client.js 必须一致
 * （仓库把产物提交进版本库，两者漂移会让「改了源码没重建」同样漏字段）。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'src', 'client', 'MemoryQueueView.tsx')
const BUNDLE = join(ROOT, 'lib', 'client.js')

/** 面板里每一个 draft 绑定键都必须随保存发出。 */
const PANEL_KEYS = [
  'reviewEnabled',
  'reviewInterval',
  'skillReviewEnabled',
  'perTurnProjectWrites',
  'perTurnDailyWrites',
  'perTurnKeyWrites',
  'perTurnWriteGuard',
  'writeGuardThreshold',
  'searchDocsEnabled',
  'searchDocsMode',
  'coiEnabled',
  'broadcastEnabled',
  'advisorEnabled',
  'sessionSearchEnabled',
  'sessionEnabled',
  'promptsEnabled',
  'modelsEnabled',
  'uiSettingsEnabled',
  'bookmarkEnabled',
  'todoEnabled',
  'notifyEnabled',
  'syncEnabled',
  'canvasEnabled',
  'keyProgressiveDisclosure',
  'keyFullInjectThreshold',
  'keyFullInjectCharLimit',
]

/** 截取 saveConfig 里 `const patch = { ... }` 那一段。 */
function patchBlock(text, from, to) {
  const start = text.indexOf(from)
  assert.notEqual(start, -1, `未找到 saveConfig 起点（${from}）`)
  const end = text.indexOf(to, start)
  assert.notEqual(end, -1, `未找到 saveConfig 终点（${to}）`)
  return text.slice(start, end)
}

const SOURCE_PATCH = patchBlock(readFileSync(SOURCE, 'utf8'), 'const saveConfig', 'void api<{ config: RuntimeConfig }>')
const BUNDLE_PATCH = patchBlock(readFileSync(BUNDLE, 'utf8'), 'const saveConfig', 'void api("/api/config"')

test('配置面板 saveConfig 发送全部 draft 绑定键（源码 + 产物）', () => {
  for (const key of PANEL_KEYS) {
    assert.ok(
      new RegExp(`${key}:\\s*draft\\.${key}`).test(SOURCE_PATCH),
      `src/client/MemoryQueueView.tsx 的 saveConfig 漏发 ${key}——面板里改了它，保存后被宿主丢弃`,
    )
    assert.ok(
      new RegExp(`${key}:\\s*draft\\.${key}`).test(BUNDLE_PATCH),
      `lib/client.js（构建产物）的 saveConfig 漏发 ${key}——产物需与源码一同重建`,
    )
  }
})

test('源码与产物 saveConfig 的键集合完全一致（防「改了源码没重建」）', () => {
  const keysOf = (block) => [...block.matchAll(/([a-zA-Z]+):\s*draft\.\1/g)].map((m) => m[1]).sort()
  const fromSource = keysOf(SOURCE_PATCH)
  const fromBundle = keysOf(BUNDLE_PATCH)
  assert.deepEqual(fromBundle, fromSource, 'lib/client.js 与 src/client/MemoryQueueView.tsx 的保存键集合不一致')
  // 反向守卫：将来面板新增控件却忘记加进 patch 时，这里会因集合不等而失败
  assert.deepEqual(fromSource, [...PANEL_KEYS].sort(), '面板键清单与 saveConfig 实际发送的键不一致')
})

test('RuntimeConfig 接口字段与保存键一致（类型即契约）', () => {
  const source = readFileSync(SOURCE, 'utf8')
  const start = source.indexOf('interface RuntimeConfig')
  assert.notEqual(start, -1)
  const end = source.indexOf('\n}', start)
  const body = source.slice(start, end)
  const fields = [...body.matchAll(/^\s{2}([a-zA-Z]+)\??:/gm)].map((m) => m[1]).sort()
  const sent = [...SOURCE_PATCH.matchAll(/([a-zA-Z]+):\s*draft\.\1/g)].map((m) => m[1]).sort()
  assert.deepEqual(sent, fields, 'RuntimeConfig 声明了字段但 saveConfig 没发送（或反之）')
})
