import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoSummary, parseEntrySummary, stripEntrySummary } from '../lib/store.js'

// 渐进式披露（2026-08-15）的核心纯函数：[summary:…] 标签的解析、自动摘要
// 兜底与展示剥离。头部序列 = [id:…] → 时间戳（日期 / 日期时间 / 时分）→
// [git …]×N → [branch:…] → [dsh-only] → [summary:…]（与 splitEntryHead 一致）。

test('parseEntrySummary：解析头部位置的显式摘要', () => {
  assert.equal(parseEntrySummary('[2026-08-15] [summary:一句话摘要] 正文内容'), '一句话摘要')
  assert.equal(parseEntrySummary('[id:deadbeef] [2026-08-15] [branch:main] [dsh-only] [summary:带全套头部] 正文'), '带全套头部')
  assert.equal(parseEntrySummary('[2026-08-15] 正文没有摘要标签'), null)
  // 审查修复回归：SUMMARY_TAG_RE 锚定头部——正文里的 [summary:…] 文本
  // 不被误当显式摘要
  assert.equal(parseEntrySummary('[2026-08-15] 正文提到 [summary:正文文本] 不算'), null)
  // 头部之后紧跟的第一个 [summary:…] 才算（第二个是正文）
  assert.equal(parseEntrySummary('[2026-08-15] [summary:真的] [summary:假的] 正文'), '真的')
})

test('parseEntrySummary：[git …] 标记后的摘要仍可解析', () => {
  assert.equal(parseEntrySummary('[12:30] [git main] [summary:每日条目摘要] 内容'), '每日条目摘要')
})

test('autoSummary：剥离完整头部后取正文首行', () => {
  assert.equal(autoSummary('[2026-08-15] 构建用 DSH_SOURCE 指定检出根'), '构建用 DSH_SOURCE 指定检出根')
  assert.equal(autoSummary('[2026-08-15] [summary:显式摘要] 正文首行'), '正文首行')
  assert.equal(autoSummary('[id:deadbeef] [2026-08-15] [branch:main] [dsh-only] 全套头部后的正文'), '全套头部后的正文')
})

test('autoSummary：审查修复回归——[git …] 与 [HH:MM] 头部不再漏进摘要', () => {
  // 修复前：逐条 ^ 锚定 replace 漏了 [git …]，后续剥离失配，
  // 摘要会输出 "[git main] 正文" 这样的元数据污染
  assert.equal(autoSummary('[12:30] [git main] 每日日志的正文行'), '每日日志的正文行')
  assert.equal(autoSummary('[2026-08-15 08:30] [git dev] 项目日志正文'), '项目日志正文')
  assert.equal(autoSummary('[2026-08-15] [git main] [branch:dev,dsh] key 条目正文'), 'key 条目正文')
  // daily 的项目标签 [tag]（时间戳后第一个任意 [...]）不在 head 序列中，
  // 属正文的一部分，不剥（autoSummary 只服务 key 轨，此处只验证不误伤）
  assert.equal(autoSummary('[08:30] [git main] [标签] 带项目标签的行'), '[标签] 带项目标签的行')
})

test('autoSummary：超长首行截断加省略号', () => {
  const long = 'x'.repeat(100)
  const out = autoSummary(`[2026-08-15] ${long}`)
  assert.equal(out.length, 80)
  assert.ok(out.endsWith('…'))
  // 恰好等于 maxLen 不截断
  const exact = 'y'.repeat(80)
  assert.equal(autoSummary(`[2026-08-15] ${exact}`), exact)
})

test('autoSummary：多行条目只取第一行', () => {
  assert.equal(autoSummary('[2026-08-15] 第一行\n第二行\n第三行'), '第一行')
})

test('stripEntrySummary：只剥头部摘要，正文同名文本保留', () => {
  assert.equal(stripEntrySummary('[2026-08-15] [summary:摘要] 正文'), '[2026-08-15] 正文')
  assert.equal(
    stripEntrySummary('[id:deadbeef] [2026-08-15] [branch:main] [dsh-only] [summary:摘要] 正文'),
    '[id:deadbeef] [2026-08-15] [branch:main] [dsh-only] 正文',
  )
  // 审查修复回归：正文中（非 head 序列）的 [summary:…] 不被误剥
  assert.equal(
    stripEntrySummary('[2026-08-15] 正文 [foo] [summary:bar] 结尾'),
    '[2026-08-15] 正文 [foo] [summary:bar] 结尾',
  )
  // 无摘要原样返回
  assert.equal(stripEntrySummary('[2026-08-15] 普通正文'), '[2026-08-15] 普通正文')
})

test('stripEntrySummary 与 parseEntrySummary 的一致性：剥掉的摘要能被解析回来', () => {
  const entry = '[2026-08-15] [branch:main] [summary:一致性别丢] 正文内容'
  const parsed = parseEntrySummary(entry)
  const stripped = stripEntrySummary(entry)
  assert.equal(parsed, '一致性别丢')
  assert.ok(!stripped.includes('summary'))
  assert.ok(stripped.endsWith('正文内容'))
})
