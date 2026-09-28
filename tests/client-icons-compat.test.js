/**
 * ui-primitives 图标跨版本解析层测试（2026-09-28，DSH 0.2.0 适配）。
 *
 * 背景：DSH 0.2.0-rc.1 把 ui-primitives 图标导出从 …16/…14 改成 …Regular
 * （旧名被彻底删除，不是别名）。若某个 TSX 又直接按旧名 import，新宿主上
 * 会拿到 undefined 组件、React 直接抛 "Element type is invalid"——整块 UI
 * 崩掉且只在升级后才暴露。这组测试做三道静态护栏：
 *   1) src/client 下除 ui-icons.ts 外，不得再直接 import ui-primitives 图标；
 *   2) 所有 TSX 里不得再出现 …16 / …14 旧图标名；
 *   3) 构建产物 lib/client.js 同时带上新名（Regular）与旧名（16/14）两套
 *      字符串，证明确实走了「新名优先、旧名兜底」的解析分支（而不是被
 *      esbuild 静态求值成单一名字）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SRC = join(ROOT, 'src/client')

/** 递归收集一个目录下的所有文件（绝对路径）。 */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const SOURCES = walk(CLIENT_SRC)

test('only ui-icons.ts imports ui-primitives (icons stay behind one compat seam)', () => {
  const offenders = SOURCES
    .filter((file) => /\.tsx?$/u.test(file) && !file.endsWith(join('client', 'ui-icons.ts')))
    .filter((file) => readFileSync(file, 'utf8').includes('@deepseek-ai/dsh-client-ui-primitives'))
    .map((file) => file.slice(ROOT.length + 1))
  assert.deepEqual(offenders, [], 'these files must import icons from ../ui-icons.ts instead')
})

test('no TSX keeps a legacy sized icon name (…16 / …14) outside the shim', () => {
  const offenders = []
  for (const file of SOURCES) {
    if (!/\.tsx?$/u.test(file)) continue
    // ui-icons.ts 是唯一允许出现旧名的地方——且只作为 resolveIcon 的兜底字符串。
    if (file.endsWith(join('client', 'ui-icons.ts'))) continue
    const hits = readFileSync(file, 'utf8').match(/\bIcon[A-Za-z0-9_]*(?:16|14)\b/gu)
    if (hits) offenders.push(`${file.slice(ROOT.length + 1)}: ${[...new Set(hits)].join(', ')}`)
  }
  assert.deepEqual(offenders, [], 'legacy icon names are deleted in DSH 0.2.0 and render as undefined')
})

test('the shim keeps legacy names only as resolveIcon fallback strings', () => {
  const shim = readFileSync(join(CLIENT_SRC, 'ui-icons.ts'), 'utf8')
  const legacyUses = shim.match(/\bIcon[A-Za-z0-9_]*(?:16|14)\b/gu) ?? []
  const fallbackUses = [...shim.matchAll(/resolveIcon\('[^']+', '([^']+)'\)/gu)].map((m) => m[1])
  assert.deepEqual(
    [...new Set(legacyUses)].sort(),
    [...new Set(fallbackUses)].sort(),
    'every legacy name in the shim must be a resolveIcon fallback argument',
  )
})

test('the shim resolves every icon through resolveIcon(modern, legacy)', () => {
  const shim = readFileSync(join(CLIENT_SRC, 'ui-icons.ts'), 'utf8')
  const pairs = [...shim.matchAll(/resolveIcon\('([^']+)', '([^']+)'\)/gu)].map((m) => [m[1], m[2]])
  assert.ok(pairs.length >= 13, `expected the full icon set, saw ${pairs.length}`)
  for (const [modern, legacy] of pairs) {
    assert.match(modern, /Regular$/u, `${modern} must be the 0.2.0+ (Regular) export name`)
    assert.match(legacy, /(?:16|14)$/u, `${legacy} must be the ≤0.1.5 sized export name`)
  }
  // 兜底链必须存在：两代宿主都拿不到时渲染 null，而不是把 undefined 交给 React。
  assert.match(shim, /MissingIcon/u, 'the shim needs a null-rendering fallback icon')
})

test('built bundle carries both the modern and the legacy icon names', () => {
  const bundle = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  for (const name of ['IconWarningOutlineRegular', 'IconWarningOutline16', 'IconChevronDownOutlineRegular', 'IconChevronDownOutline14']) {
    assert.ok(bundle.includes(name), `lib/client.js must reference ${name} (rebuild after editing src/client)`)
  }
  assert.ok(!/from\s*"@deepseek-ai\/dsh-client-ui-primitives"[\s\S]{0,200}IconWarningOutline16/u.test(bundle),
    'the bundle must not destructure legacy icon names from the module (they are undefined on 0.2.0)')
})
