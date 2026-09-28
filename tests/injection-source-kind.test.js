/**
 * 注入消息的 source kind 必须符合会话格式 v4（issue #68）。
 *
 * 背景：DSH 0.1.7-rc.2 起会话持久化走 format v4，每条消息的 `source.kind`
 * 必须由生产者自报（canonical `plugin:<包名>`）；v3 时代的
 * 「`kind: 'plugin'` + 并列 plugin 字段」会被直接拒绝：
 *
 *   format v4 message requires a producer-owned source kind
 *
 * 报错发生在**接收方会话认领该事件时**，症状是"注入那一步所在的一轮整轮
 * 失败"，而不是注入调用本身报错；又因为公告板/写冲突/COI 通知都靠事件触发，
 * 表现为"重启就好、过一阵复发"。本文件同时提供三层防护：
 *
 *  1. 规则复刻自检——确认这条准入规则确实会拒绝退役写法（否则下面的断言
 *     就是空转的假绿）；
 *  2. 常量形状——`PLUGIN_SOURCE_KIND` 必须是 `plugin:<包名>`；
 *  3. 静态扫描——`lib/` 里不得再出现退役写法，且四处注入点都引用同一常量
 *     （防未来新增注入点时又手写一份 kind）。
 *
 * 行为侧的证据在别处：`tests/coi.test.js`（会话广播 / 房间动态 / COI 完成
 * 通知）与 `tests/ws-coord.test.js`（写冲突 additionalContexts / 公告板）
 * 直接断言真实构造出来的消息对象。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_SOURCE_KIND } from '../lib/coi/source.js'

const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')

/** 插件包名（package.json 的 name），kind 必须由它拼出。 */
const PACKAGE_NAME = 'dsh-memory-evolve'

/** `lib/` 下全部 .js 源文件（相对路径 + 内容）。 */
function libSources() {
  return readdirSync(LIB_DIR, { recursive: true })
    .map((entry) => String(entry).replaceAll('\\', '/'))
    .filter((entry) => entry.endsWith('.js'))
    .map((entry) => ({ file: entry, text: readFileSync(join(LIB_DIR, entry), 'utf8') }))
}

/**
 * 复刻宿主 v4 的 source 准入规则（源码在 `@deepseek-ai/dsh-session-format-v3-to-v4`
 * 的 message-sources 模块，编译产物 `lib/index.js`）：`kind` 必须是非空字符串，
 * 且不得等于已退役的 `'plugin'`。
 * @param {unknown} value - 待判定的 source 值。
 * @returns {boolean} true 表示该 source 会被 v4 接受。
 */
function admitsV4Source(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.kind === 'string'
    && value.kind.length > 0
    && value.kind !== 'plugin'
}

test('前提自检：复刻的 v4 准入规则确实拒绝退役写法', () => {
  // 退役写法（v3）：裸 'plugin' + 并列 plugin 字段 → 必须被拒
  assert.equal(admitsV4Source({ kind: 'plugin', plugin: PACKAGE_NAME }), false)
  // 别的非法形态同样被拒（证明规则不是恒真）
  assert.equal(admitsV4Source({ kind: '' }), false)
  assert.equal(admitsV4Source({ plugin: PACKAGE_NAME }), false)
  assert.equal(admitsV4Source(null), false)
  // canonical 形态 → 必须通过
  assert.equal(admitsV4Source({ kind: `plugin:${PACKAGE_NAME}` }), true)
})

test('PLUGIN_SOURCE_KIND：canonical 的 producer-owned kind，且通过 v4 准入', () => {
  assert.equal(PLUGIN_SOURCE_KIND, `plugin:${PACKAGE_NAME}`)
  assert.notEqual(PLUGIN_SOURCE_KIND, 'plugin', '不得回退到退役的裸 plugin')
  assert.ok(admitsV4Source({ kind: PLUGIN_SOURCE_KIND, form: 'notice' }))
})

test('lib/ 里不得残留退役写法（裸 kind: \'plugin\' + 并列 plugin 字段）', () => {
  // 只认「kind: 'plugin' 后紧跟逗号」——即对象字面量里的退役写法；
  // 文档注释里对它的描述（后跟反引号或中文）不会命中。
  const retired = /kind:\s*['"]plugin['"]\s*,/
  const offenders = libSources()
    .filter(({ text }) => retired.test(text))
    .map(({ file }) => file)
  assert.deepEqual(offenders, [], `这些文件仍在使用退役写法：${offenders.join(', ')}`)
})

test('四处注入点全部引用 PLUGIN_SOURCE_KIND（防新增注入点手写 kind）', () => {
  // 注入点清单：coi/index.js deliver()、coi/scheduler.js #deliver()、
  // coi/ws-coord.js userMessage() 与公告板。每个文件都必须 import 常量。
  const sources = libSources()
  const byFile = new Map(sources.map(({ file, text }) => [file, text]))
  for (const file of ['coi/index.js', 'coi/scheduler.js', 'coi/ws-coord.js']) {
    const text = byFile.get(file)
    assert.ok(text !== undefined, `缺少文件 ${file}`)
    assert.match(text, /import \{[^}]*PLUGIN_SOURCE_KIND[^}]*\} from '\.\/source\.js'/, `${file} 未从 './source.js' 导入常量`)
  }
  // 注入消息都用 `source`（单数）或 `source:` 字段承载 kind；
  // 计数应等于四处（ws-coord 两处、scheduler 一处、coi/index 一处）。
  const usages = sources
    .flatMap(({ file, text }) => text.split('\n').map((line, index) => ({ file, line: index + 1, text: line })))
    .filter(({ text }) => text.includes('kind: PLUGIN_SOURCE_KIND'))
  assert.equal(usages.length, 4, `PLUGIN_SOURCE_KIND 使用点应为 4 处，实际 ${usages.length} 处：${usages.map((u) => `${u.file}:${u.line}`).join(', ')}`)
})
