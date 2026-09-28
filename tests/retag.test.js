// retag 存量补标测试（PR #66 后续增强，块 6）。
//
// 覆盖（规格块 6.3 六例）：
//   ① 无 tag 条目 retag 后带 tag 且正文逐字不变
//   ② 已有 tag 替换为新级别
//   ③ match 不唯一报错（语义同 replace）
//   ④ project/daily 日志轨拒绝（工具层诚实拒绝；store 层防御性同校验）
//   ⑤ [id:]/[summary:] 原样保留（tag-only 重写）
//   ⑥ store 层 salience 非法值防御 + retagEntry 头部序列形态矩阵
//   ⑧ summary 参数（渐进式披露 v2，2026-09-28）：只补摘要、正文**逐字节**
//      不变；salience + summary 同补；摘要清洗/截断；两者皆缺诚实拒绝
//
// 直跑：node tests/retag.test.js（沙箱禁 node --test runner）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, parseEntries, parseEntrySalience, parseEntrySummary, retagEntry, retagEntryMeta, entryBodyOf } from '../lib/store.js'

function setup(memoryText = '') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-retag-test-'))
  if (memoryText !== '') writeFileSync(join(dir, 'MEMORY.md'), memoryText)
  return { dir, store: new MemoryStore(dir) }
}

function readTrack(dir, file = 'MEMORY.md') {
  return readFileSync(join(dir, file), 'utf8')
}

test('①无 tag 条目 retag 后带 tag 且正文逐字不变', () => {
  const entry = '[2026-09-20] 用户偏好多轮对话确认\n第二行正文细节'
  const fx = setup(entry + '\n')
  try {
    const r = fx.store.retag('memory', '用户偏好多轮对话确认', 3, undefined)
    assert.equal(r.ok, true, r.message)
    const entries = parseEntries(readTrack(fx.dir))
    assert.equal(entries.length, 1)
    assert.equal(entries[0], '[2026-09-20] [salience:3] 用户偏好多轮对话确认\n第二行正文细节')
    // 正文逐字不变：剥掉新 tag 后应与原条目逐字节一致
    assert.equal(retagEntry(entries[0], 3).includes('用户偏好多轮对话确认\n第二行正文细节'), true)
    assert.equal(parseEntrySalience(entries[0]), 3)
    // store 返回 entry 字段供工具层回显短 id
    assert.equal(r.entry, entries[0])
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('②已有 tag 替换为新级别（旧 [salience:1] → 新 [salience:3]，不残留旧 tag）', () => {
  const entry = '[2026-09-21] [salience:1] 旧低档条目正文'
  const fx = setup(entry + '\n')
  try {
    const r = fx.store.retag('memory', '旧低档条目正文', 3, undefined)
    assert.equal(r.ok, true, r.message)
    const entries = parseEntries(readTrack(fx.dir))
    assert.equal(entries[0], '[2026-09-21] [salience:3] 旧低档条目正文')
    assert.equal(entries[0].includes('[salience:1]'), false, 'old tag must be stripped')
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('③match 不唯一报错（错误口径同 replace，不落盘）', () => {
  const text = '[2026-09-20] 重复关键词甲条目\n§\n[2026-09-21] 重复关键词乙条目\n'
  const fx = setup(text)
  try {
    const r = fx.store.retag('memory', '重复关键词', 2, undefined)
    assert.equal(r.ok, false)
    assert.match(r.message, /多于一条|更精确|matches \d+ entries|more precise/)
    assert.equal(Array.isArray(r.matches), true)
    // 未落盘：文件原样
    assert.equal(readTrack(fx.dir), text)
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('④project/daily 拒绝 retag（日志轨无重要性语义）', () => {
  const fx = setup('')
  try {
    // store 层直接对 project 轨 retag：走 resolveTarget 写日志轨 = 语义错误，
    // 防御性校验在工具层（msg.retagLogsRejected）；store 层对日志轨同样拒绝
    // 写 [salience:N]（stampEntry 口径：日志轨不标 tag）——这里验证 store 层
    // 不给日志轨留 retag 成功路径之外的副作用（日志轨 retag 直接返回错误）。
    const r = fx.store.retag('daily', '不存在的匹配', 2, undefined)
    assert.equal(r.ok, false, 'daily retag must not succeed silently')
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('⑤[id:] 与 [summary:] 原样保留（tag-only 重写，不换生命周期）', () => {
  const entry = '[id:deadbeef] [2026-09-22] [summary:显式摘要] 有身份证有摘要的条目正文'
  const fx = setup(entry + '\n')
  try {
    const r = fx.store.retag('memory', '有身份证有摘要的条目正文', 2, undefined)
    assert.equal(r.ok, true, r.message)
    const entries = parseEntries(readTrack(fx.dir))
    assert.equal(entries[0], '[id:deadbeef] [2026-09-22] [summary:显式摘要] [salience:2] 有身份证有摘要的条目正文')
    // summary 形态在前的乱序容错：retag 后新 tag 仍插在 summary 之后
    assert.equal(parseEntrySalience(entries[0]), 2)
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('⑦工具层静态契约：retag 成功回显不得携带 output schema 未声明的 entry 字段', () => {
  // 背景（2026-09-24 生产实证）：store.retag 成功返回含 entry（供工具层取
  // 短 id），若原样透传，宿主对工具输出的 additionalProperties:false 校验会
  // 整单拒绝（报 value.entry is not a declared property）——写盘已发生但模型
  // 只见报错。假宿主不校验输出 schema，只有生产宿主能抓，故用静态源码契约
  // 锁住：retag case 块必须在 break 前 delete result.entry。
  const src = readFileSync(join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8')
  const start = src.indexOf("case 'retag':")
  assert.notEqual(start, -1, 'retag case 未找到')
  const end = src.indexOf('break', src.indexOf('delete result.entry', start) === -1 ? start : src.indexOf('delete result.entry', start))
  const block = src.slice(start, end + 'break'.length)
  assert.match(block, /delete result\.entry/, 'retag 块必须 delete result.entry（宿主 output schema additionalProperties:false）')
  // delete 必须在 message 构造之后（先用 entry 取短 id，再删）
  const msgIdx = block.indexOf('msg.retagDone')
  const delIdx = block.indexOf('delete result.entry')
  assert.ok(msgIdx !== -1 && delIdx > msgIdx, 'delete result.entry 应在 msg.retagDone 构造之后')
})

test('⑥store 层 salience 非法值防御 + retagEntry 头部形态矩阵（≥3 元素）', () => {
  const fx = setup('[2026-09-20] 某条目\n')
  try {
    for (const bad of [0, 4, 2.5, '3x', null]) {
      const r = fx.store.retag('memory', '某条目', bad, undefined)
      assert.equal(r.ok, false, `value ${String(bad)} must be rejected`)
      assert.match(r.message, /1-3/)
    }
    assert.equal(readTrack(fx.dir), '[2026-09-20] 某条目\n', 'rejected calls must not write')
    // retagEntry 纯函数矩阵：时间戳形 / 无时间戳裸条目 / git+branch 复合头部
    assert.equal(retagEntry('[2026-09-20] 正文', 1), '[2026-09-20] [salience:1] 正文')
    assert.equal(retagEntry('裸条目正文', 2), '[salience:2] 裸条目正文')
    assert.equal(
      retagEntry('[2026-09-21] [git main] [branch:dev] 复合头部正文', 3),
      '[2026-09-21] [git main] [branch:dev] [salience:3] 复合头部正文',
    )
    // 乱序容错：summary 在前（手写文件）→ 新 tag 仍插 summary 之后
    assert.equal(
      retagEntry('[2026-09-22] [summary:摘] 正文', 2),
      '[2026-09-22] [summary:摘] [salience:2] 正文',
    )
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

// ── ⑧ summary 参数（渐进式披露 v2，2026-09-28 用户批准）─────────────────
//
// 这是 131 条存量摘要批量回填的执行机制：按 id/match 定位 → 只重写头部元数据
// → 正文**逐字节**不变（避免为插一行摘要而重发整条正文）。

/** 取条目正文的字节级指纹（UTF-8 逐字节 SHA-256 前的中间量：字符数组）。 */
function bodyBytes(entry) {
  return [...Buffer.from(entryBodyOf(entry), 'utf8')]
}

test('⑧a 只补 summary：正文逐字节不变 + 头部位置正确（[date] [summary:…] 正文）', () => {
  const body = '模拟正文：429 code 1310 周五上限 / lib/index.js:1137 门控\n第二行细节（多行也要逐字保留）'
  const entry = `[2026-09-20] ${body}`
  const fx = setup(entry + '\n')
  try {
    const r = fx.store.retag('memory', '模拟正文：429 code 1310', undefined, undefined, '429 code 1310 周五上限；门控在 lib/index.js:1137')
    assert.equal(r.ok, true, r.message)
    const entries = parseEntries(readTrack(fx.dir))
    assert.equal(entries.length, 1)
    assert.equal(
      entries[0],
      '[2026-09-20] [summary:429 code 1310 周五上限；门控在 lib/index.js:1137] ' + body,
    )
    // 字节级断言：正文逐字节一致（不是「看起来一样」）
    assert.deepEqual(bodyBytes(entries[0]), bodyBytes(entry))
    assert.equal(parseEntrySummary(entries[0]), '429 code 1310 周五上限；门控在 lib/index.js:1137')
    // 只补摘要不改级别：原无 tag，retag 后仍无 [salience:] 出现
    assert.equal(parseEntrySalience(entries[0]), null)
    assert.equal(entries[0].includes('[salience:'), false)
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('⑧b 已有 salience 的条目只补 summary：原级别保留、正文逐字节不变', () => {
  const body = '正文原样：MEMORY.md 单条均值 477 字符'
  const entry = `[id:deadbeef] [2026-09-21] [salience:2] ${body}`
  const fx = setup(entry + '\n')
  try {
    const r = fx.store.retag('memory', 'MEMORY.md 单条均值', undefined, undefined, 'MEMORY.md 单条均值 477 字符')
    assert.equal(r.ok, true, r.message)
    const entries = parseEntries(readTrack(fx.dir))
    assert.equal(entries[0], `[id:deadbeef] [2026-09-21] [summary:MEMORY.md 单条均值 477 字符] [salience:2] ${body}`)
    assert.deepEqual(bodyBytes(entries[0]), bodyBytes(entry))
    assert.equal(parseEntrySalience(entries[0]), 2, '只补摘要不得丢失原 salience')
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('⑧c summary + salience 同补：一次写入两件头标记，正文逐字节不变', () => {
  const body = '正文逐字：摘要≤120 字 + 正文>400 折叠 → 省 61.0%'
  const entry = `[2026-09-22] ${body}`
  const fx = setup(entry + '\n')
  try {
    const r = fx.store.retag('memory', '正文逐字：摘要', 3, undefined, '摘要≤120 + 正文>400 折叠省 61.0%（全注入轨 165,021 字符）')
    assert.equal(r.ok, true, r.message)
    const entries = parseEntries(readTrack(fx.dir))
    assert.equal(
      entries[0],
      '[2026-09-22] [summary:摘要≤120 + 正文>400 折叠省 61.0%（全注入轨 165,021 字符）] [salience:3] ' + body,
    )
    assert.deepEqual(bodyBytes(entries[0]), bodyBytes(entry))
    assert.equal(parseEntrySalience(entries[0]), 3)
    assert.equal(parseEntrySummary(entries[0]), '摘要≤120 + 正文>400 折叠省 61.0%（全注入轨 165,021 字符）')
    // 只补 summary 时不改级别：显式传 salience 缺省 = 保留
    assert.equal(r.message.includes('salience 3 + summary'), true, r.message)
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('⑧d 覆盖已有摘要（不是追加）：旧 [summary:] 被替换，正文逐字节不变', () => {
  const body = '正文原样保留，绝不因改摘要而被动到'
  const entry = `[2026-09-23] [summary:旧摘要] ${body}`
  const fx = setup(entry + '\n')
  try {
    const r = fx.store.retag('memory', '正文原样保留', undefined, undefined, '新摘要')
    assert.equal(r.ok, true, r.message)
    const entries = parseEntries(readTrack(fx.dir))
    assert.equal(entries[0], `[2026-09-23] [summary:新摘要] ${body}`)
    assert.equal(entries[0].includes('旧摘要'), false, '旧摘要必须被替换而非并存')
    assert.deepEqual(bodyBytes(entries[0]), bodyBytes(entry))
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('⑧e 摘要清洗与 120 字截断：换行/]/制表符被清洗，超长截断', () => {
  const entry = '[2026-09-24] 待补摘要的条目正文'
  const fx = setup(entry + '\n')
  try {
    const r = fx.store.retag('memory', '待补摘要的条目正文', undefined, undefined, `第一行\n第二行]带右括号\t${'x'.repeat(200)}`)
    assert.equal(r.ok, true, r.message)
    const entries = parseEntries(readTrack(fx.dir))
    const parsed = parseEntrySummary(entries[0])
    assert.equal(parsed.includes('\n'), false, '摘要不得跨行')
    assert.equal(parsed.includes(']'), false, '摘要不得含右括号（会截断解析正则）')
    assert.equal(parsed.includes('\t'), false)
    assert.equal(parsed.length, 120, '摘要必须截断到 120 字')
    assert.deepEqual(bodyBytes(entries[0]), bodyBytes(entry))
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('⑧f salience 与 summary 都缺省 = 诚实拒绝（不得静默成功），且不落盘', () => {
  const text = '[2026-09-25] 两者都缺省时必须报错\n'
  const fx = setup(text)
  try {
    const r = fx.store.retag('memory', '两者都缺省时必须报错', undefined, undefined, undefined)
    assert.equal(r.ok, false)
    assert.match(r.message, /salience 或 summary|至少一个|at least one/)
    assert.equal(readTrack(fx.dir), text, '被拒绝的调用不得写盘')
    // 空串摘要同样视为缺省
    const r2 = fx.store.retag('memory', '两者都缺省时必须报错', undefined, undefined, '   ')
    assert.equal(r2.ok, false)
    assert.equal(readTrack(fx.dir), text)
  } finally {
    rmSync(fx.dir, { recursive: true, force: true })
  }
})

test('⑧g retagEntryMeta 纯函数：summary 与 salience 的保留/覆盖矩阵 + 正文逐字节', () => {
  const body = '正文：含 [salience:9] 越界字面与 [summary:正文里的] 字面，均属正文'
  const base = `[2026-09-26] [git main] [branch:dev] ${body}`
  // summary 覆盖、salience 保留（原本无）
  assert.equal(retagEntryMeta(base, { summary: '摘' }), `[2026-09-26] [git main] [branch:dev] [summary:摘] ${body}`)
  // 两者同时覆盖
  assert.equal(retagEntryMeta(base, { salience: 2, summary: '摘' }), `[2026-09-26] [git main] [branch:dev] [summary:摘] [salience:2] ${body}`)
  // 只给 salience：原 summary 保留
  assert.equal(
    retagEntryMeta('[2026-09-26] [summary:旧] 正文', { salience: 1 }),
    '[2026-09-26] [summary:旧] [salience:1] 正文',
  )
  // 什么都不给 = 原样返回（正文逐字节）
  assert.equal(retagEntryMeta(base, {}), base)
  // 清洗后为空串 = 清除摘要 tag（仍保证正文逐字节）
  assert.equal(retagEntryMeta('[2026-09-26] [summary:旧] 正文', { summary: ']' }), '[2026-09-26] 正文')
  // 正文逐字节断言（构造含多行/中文/符号的正文）
  const entry = `[2026-09-26] ${body}`
  assert.deepEqual([...Buffer.from(entryBodyOf(retagEntryMeta(entry, { summary: '摘' })), 'utf8')], [...Buffer.from(body, 'utf8')])
})
