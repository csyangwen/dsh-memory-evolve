/**
 * dsh-memory-evolve — 对话区加宽 / 消息气泡加宽的 CSS 锚点回归测试（2026-10-30）。
 *
 * 背景：这两条规则是**纯 CSS**，JS 侧只负责挂 html 属性（wide-chat.ts），
 * 所以锚点选错时**不会有任何报错**——开关状态、html 属性、localStorage
 * 全部正常，只有宽度纹丝不动。DSH 0.2.x 就踩了两次：
 *
 *  1. `--dsh-chat-content-width` 的声明从根 `[data-phase]` 下移到 `.body`
 *     （= `[data-conversation-content]`）。CSS 自定义属性按**最近的声明**
 *     生效，写在外层的值被完整遮蔽 → 改 95% / 100% / 9999px 都没反应，
 *     也不是 specificity 问题（加 !important 到外层同样无效，子元素声明
 *     永远更近）。
 *  2. 气泡的旧锚点 `[data-time-hover-root]` 是 0.1.x 的 MessageItem 属性，
 *     0.2.x 已移除 → 选择器永不命中（全页计数 0）。
 *
 * 这两类失效都不会让任何测试变红，只能靠静态断言把「锚点必须是变量声明处」
 * 钉死。本文件读 CSS 源文本做断言，不依赖 DSH 运行时。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const UI_CSS = readFileSync(join(ROOT, 'src/client/ui-settings-styles.css'), 'utf8')
const MOBILE_CSS = readFileSync(join(ROOT, 'src/client/mobile.css'), 'utf8')

/** 去掉 CSS 注释——注释里会提到旧锚点（说明为什么改），不能算命中。 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, '')
}

const UI = stripComments(UI_CSS)
const MOBILE = stripComments(MOBILE_CSS)

/** 把「选择器列表 { 声明块 }」里的声明块按选择器取出来。 */
function rulesFor(css, selectorTest) {
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/gu
  let m
  while ((m = re.exec(css)) !== null) {
    const selectors = m[1].split(',').map((s) => s.trim())
    if (selectors.some(selectorTest)) out.push({ selectors, body: m[2] })
  }
  return out
}

// ── 对话区加宽 ─────────────────────────────────────────────────────────

test('wideChat anchors on the element that DECLARES the variable (0.2.x)', () => {
  const rules = rulesFor(UI, (s) => s.includes('data-dsh-ui-wide-chat'))
  assert.ok(rules.length > 0, 'wideChat rule must exist')

  const targets = rules.flatMap((r) => r.selectors.filter((s) => s.includes('data-dsh-ui-wide-chat')))
  assert.ok(
    targets.some((s) => s.includes('[data-conversation-content]')),
    'wideChat must anchor on [data-conversation-content] — DSH 0.2.x declares ' +
      '--dsh-chat-content-width on .body (that element); a value set on the outer ' +
      '[data-phase] is shadowed by the inner declaration and does nothing',
  )
  // 旧版兼容：0.1.x 没有 [data-conversation-content]，靠 [data-phase] 那一条。
  assert.ok(
    targets.some((s) => s.includes('[data-phase]')),
    'wideChat must also keep the 0.1.x [data-phase] anchor for backward compatibility',
  )
})

test('wideChat sets 100%, not a fixed 95% (0.2.x has a 920px clamp ceiling)', () => {
  const rules = rulesFor(UI, (s) => s.includes('data-dsh-ui-wide-chat'))
  const decl = rules
    .map((r) => /--dsh-chat-content-width\s*:\s*([^;]+);/u.exec(r.body)?.[1]?.trim())
    .filter(Boolean)
  assert.ok(decl.length > 0, 'wideChat must set --dsh-chat-content-width')
  for (const value of decl) {
    assert.equal(
      value,
      '100%',
      'wideChat must set 100% — 0.2.x falls back to clamp(680px, col*.64, 920px), ' +
        'so 95% on a wide viewport only adds ~25px and still reads as "no change"',
    )
  }
})

// ── 消息气泡加宽 ───────────────────────────────────────────────────────

test('wideBubble no longer uses the removed [data-time-hover-root] anchor', () => {
  const dead = rulesFor(UI, (s) => s.includes('data-dsh-ui-wide-bubble') && s.includes('data-time-hover-root'))
  assert.deepEqual(
    dead.map((r) => r.selectors.join(', ')),
    [],
    '[data-time-hover-root] was removed from DSH 0.2.x MessageItem — a rule using it ' +
      'matches nothing (zero elements on the page), so the switch silently does nothing',
  )
})

test('wideBubble anchors on the CSS-modules _userStack suffix', () => {
  const rules = rulesFor(UI, (s) => s.includes('data-dsh-ui-wide-bubble'))
  assert.ok(rules.length > 0, 'wideBubble rule must exist')
  const targets = rules.flatMap((r) => r.selectors.filter((s) => s.includes('data-dsh-ui-wide-bubble')))
  assert.ok(
    targets.some((s) => s.includes('_userStack')),
    'wideBubble must anchor on [class*="_userStack"] — that is where 0.2.x puts ' +
      'max-width: min(calc(var(--dsh-chat-content-width) * .702), 82%)',
  )
  // data 属性锚点比 CSS Modules 类名稳，但 _userStack 是唯一剩下的锚点，
  // 因此至少要保证它被限制在对话区内，避免误伤别的同名类。
  assert.ok(
    targets.every((s) => s.includes('[data-conversation-content]')),
    'wideBubble selectors should scope [class*="_userStack"] under [data-conversation-content]',
  )
})

// ── 手机端（mobile.css 第 10 节）────────────────────────────────────────

test('mobile full-width rules use the same corrected anchors', () => {
  const widthRules = rulesFor(MOBILE, (s) => s.includes('data-dsh-mobile') && s.includes('data-conversation-content'))
  assert.ok(
    widthRules.some((r) => /--dsh-chat-content-width\s*:\s*100%/u.test(r.body)),
    'mobile.css must declare --dsh-chat-content-width on [data-conversation-content] too',
  )

  const bubbleRules = rulesFor(MOBILE, (s) => s.includes('data-dsh-mobile') && s.includes('_userStack'))
  assert.ok(
    bubbleRules.some((r) => /max-width\s*:\s*100%/u.test(r.body)),
    'mobile.css must widen the bubble via [class*="_userStack"]',
  )

  const deadMobile = rulesFor(MOBILE, (s) => s.includes('data-dsh-mobile') && s.includes('data-time-hover-root'))
  assert.deepEqual(
    deadMobile.map((r) => r.selectors.join(', ')),
    [],
    'mobile.css still has a [data-time-hover-root] rule — it can never match on 0.2.x',
  )
})
