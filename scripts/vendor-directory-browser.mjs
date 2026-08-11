/**
 * 一次性 vendor 脚本：把官方 DirectoryBrowser 组件复制进本插件并做本地化适配。
 *
 * 来源：DSH 官方 checkout 的 directory-picker-browse 包（快照跟随更新）。
 * 为什么复制而非 import：客户端 bundle 只允许值导入白名单内的 @deepseek-ai/*
 * 包（见 scripts/build.mjs EXTERNALS），跨包 import 组件会破坏 bundle 契约；
 * 且官方包未发布，复制后本插件零外部运行时依赖。官方升级该组件时重跑本脚本
 * 并 review 差异即可（保留文件头注释中的官方链接）。
 *
 * 适配内容：
 * 1. css module → 全局 css：全部类名加 `dp-` 前缀（防污染 DSH 全局样式）；
 *    官方 `.dialog.dialog` 提权技巧 → `.dp-dialog.dialog`（Modal 自带 .dialog，
 *    双类叠加提权语义不变）。
 * 2. css module 导入 → 本地类名映射对象（directory-browser-styles.ts）。
 * 3. 第三方依赖 clsx → 本地 5 行 cx 实现（bundle 禁第三方值导入）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const CHECKOUT = process.env.DSH_SOURCE ?? join(homedir(), '.dsh/source/current')
const SRC = join(CHECKOUT, 'packages/host/directory-picker-browse/src/client')
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src/client/directory-picker')

mkdirSync(OUT, { recursive: true })

// ---- 1. css：提取类名 + 前缀化 ----
const css = readFileSync(join(SRC, 'DirectoryBrowser.module.css'), 'utf8')
// css module 类名允许驼峰（rowSeat、showHiddenToggle…），须完整提取；
// 排除注释里的 ".css" 字样（非类名）。
const names = [...new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1]))]
  .filter((n) => n !== 'css')
let prefixed = css.replace(/\.([a-zA-Z][a-zA-Z0-9-]*)/g, (_m, n) => (n === 'css' ? _m : `.dp-${n}`))
// 官方 .dialog.dialog 提权技巧：Modal 组件自带 .dialog 类，传入的 dp-dialog
// 与其叠加；双类选择器 .dp-dialog.dialog 命中 "dialog dp-dialog" 元素，特异性不变。
prefixed = prefixed.replace(/\.dp-dialog\.dp-dialog/g, '.dp-dialog.dialog')
writeFileSync(join(OUT, 'directory-browser.css'), prefixed)

// ---- 2. 类名映射对象 + cx ----
const styleKeys = Object.fromEntries(names.map((n) => [n, `dp-${n}`]))
const stylesTs = [
  '/**',
  ' * 自动生成（scripts/vendor-directory-browser.mjs）：官方 DirectoryBrowser 的',
  ' * css module 类名映射（dp- 前缀防全局污染）+ 本地 cx 实现（替代 clsx）。',
  ' * 不要手工编辑；重跑 vendor 脚本重新生成。',
  ' */',
  '',
  '/** css module 类名 → 全局类名映射（与 directory-browser.css 中的 dp- 前缀一致）。 */',
  `export const css: Record<string, string> = ${JSON.stringify(styleKeys, null, 2)}`,
  '',
  '/** 本地 cx：过滤 falsy 后空格拼接（clsx 最小子集，bundle 禁第三方值导入）。 */',
  'export function cx(...parts: Array<string | false | null | undefined>): string {',
  "  return parts.filter(Boolean).join(' ')",
  '}',
  '',
].join('\n')
writeFileSync(join(OUT, 'directory-browser-styles.ts'), stylesTs)

// ---- 3. tsx：复制 + import/clsx 替换 ----
let tsx = readFileSync(join(SRC, 'DirectoryBrowser.tsx'), 'utf8')
tsx = tsx.replace(
  "import css from './DirectoryBrowser.module.css'",
  "import { css, cx } from './directory-browser-styles.ts'",
)
tsx = tsx.replace("import clsx from 'clsx'\n", '')
tsx = tsx.replaceAll('clsx(', 'cx(')
// 校验：所有 css.xxx 引用必须存在于类名集合
for (const m of tsx.matchAll(/css\.([A-Za-z][A-Za-z0-9]*)/g)) {
  if (!(m[1] in styleKeys)) {
    console.error(`vendor: missing style key ${m[1]} — 重新检查官方 css 类名提取规则`)
    process.exit(1)
  }
}
writeFileSync(join(OUT, 'DirectoryBrowser.tsx'), tsx)

console.log(`vendored DirectoryBrowser: ${names.length} style keys, ${tsx.split('\n').length} lines`)
