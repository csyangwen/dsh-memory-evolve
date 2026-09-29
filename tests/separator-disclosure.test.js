/**
 * 条目分隔符（记忆文件的 § 分隔格式）——**写入前可见性**回归锁。
 *
 * 背景：`§` 是记忆条目的分隔符（`lib/store.js` 的 `ENTRY_DELIMITER = '\n§\n'`），
 * 正文携带会在下次解析时静默把一条拆成两条，因此 add/replace/归档重写三处一律
 * **拒绝**（拒绝本身是对的）。但约束此前只出现在**错误信息**里：模型在「决定写
 * 什么」的那一刻看不到它，只能写完被拒、再改写重试——实测同一会话连续两次被拒，
 * 第二次的成因还是「为了解释这条规则，把该字符本身写进了正文」。
 *
 * 本测试把「约束必须在写入时刻可见」钉成契约：
 *   ① `param.content` / `param.entries` 参数描述（工具 schema，模型组装调用时读到）；
 *   ② 快照收尾写入指引 `snap.batchWriteDuty` / `snap.keyDuty`（模型计划本轮写什么时读到）；
 *   ③ 拒绝文案 `msg.sectionContainsDelimiter` 必须给出**怎么改**（否则只有堵没有疏）。
 * 另含一条**注入必红**负向自测：把披露从句里删掉后判据必须变红，否则本文件就是空门。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MEMORY_DICT, SNAPSHOT_DICT } from '../lib/i18n.js'

const ZH = 0
const EN = 1

/** 取字典条目（快照类键在 SNAPSHOT_DICT，其余在 MEMORY_DICT；缺键即响亮失败——不静默跳过）。 */
function entry(key) {
  const pair = MEMORY_DICT[key] ?? SNAPSHOT_DICT[key]
  assert.ok(Array.isArray(pair), `字典缺条目 ${key}（MEMORY_DICT / SNAPSHOT_DICT 均未命中）`)
  assert.equal(pair.length >= 2, true, `${key} 必须 zh/en 双语成对`)
  return pair
}

/**
 * 「写入时刻可见」判据：文本必须同时给出 ①该字符不可用 ②引用章节的改写写法。
 * 判据写成纯函数，便于下面的注入必红自测直接喂变异文本。
 */
function disclosesRule(text, { mustMentionDelimiter }) {
  const hasDelimiter = String(text).includes('§')
  const hasRewrite = /节\s*N\.N/.test(text) || /section\s+N\.N/i.test(text)
  if (mustMentionDelimiter && !hasDelimiter) return false
  return hasRewrite
}

test('参数描述在写入前披露分隔符约束（含改写写法）', () => {
  const content = entry('param.content')
  for (const [i, label] of [[ZH, 'zh'], [EN, 'en']]) {
    assert.ok(
      disclosesRule(content[i], { mustMentionDelimiter: true }),
      `param.content[${label}] 必须在写入前披露「不得含 §」并给出改写写法（节 N.N）`,
    )
    assert.ok(/自查|self-check/i.test(content[i]), `param.content[${label}] 须写成「写入前自查」口气，而不是事后报错说明`)
  }
  // 批量写是收尾主路径，entries 描述同样要带约束
  const entries = entry('param.entries')
  for (const [i, label] of [[ZH, 'zh'], [EN, 'en']]) {
    assert.ok(entries[i].includes('§'), `param.entries[${label}] 必须提到该字符不可用`)
  }
})

test('快照收尾写入指引带「写入前自查」（模型决定写什么的那一刻可见）', () => {
  for (const key of ['snap.batchWriteDuty', 'snap.keyDuty']) {
    const pair = entry(key)
    for (const [i, label] of [[ZH, 'zh'], [EN, 'en']]) {
      assert.ok(
        disclosesRule(pair[i], { mustMentionDelimiter: true }),
        `${key}[${label}] 必须披露分隔符约束并给出改写写法`,
      )
      assert.ok(/写入前自查|self-check before writing/i.test(pair[i]), `${key}[${label}] 须带「写入前自查」字样`)
    }
  }
})

test('拒绝文案给出「怎么改」而不只是「不能」', () => {
  const pair = entry('msg.sectionContainsDelimiter')
  for (const [i, label] of [[ZH, 'zh'], [EN, 'en']]) {
    const text = pair[i]
    assert.ok(text.includes('§'), `${label} 拒绝文案须点名该字符`)
    assert.ok(disclosesRule(text, { mustMentionDelimiter: false }), `${label} 拒绝文案须给出改写写法（节 N.N）`)
    assert.ok(/重试|retry/i.test(text), `${label} 拒绝文案须给出下一步动作（删掉该字符后重试）`)
  }
})

test('注入必红：把披露从句删掉后判据必须变红（否则本文件是空门）', () => {
  const content = entry('param.content')
  // 变异 1：回到「只描述参数用途」的旧文案 → 判据必须失败
  const mutated = 'add/replace 的新条目内容（可多行）'
  assert.equal(disclosesRule(mutated, { mustMentionDelimiter: true }), false, '旧文案必须被判红')
  // 变异 2：提了字符但没给改写写法（只有堵、没有疏）→ 判据同样必须失败
  const halfDisclosure = '内容不能包含条目分隔符 §（会破坏格式）'
  assert.equal(disclosesRule(halfDisclosure, { mustMentionDelimiter: false }), false, '「只说不能、不说怎么改」必须被判红')
  // 对照：真实文案必须过门（证明判据不是恒红）
  assert.equal(disclosesRule(content[ZH], { mustMentionDelimiter: true }), true)
  assert.equal(disclosesRule(content[EN], { mustMentionDelimiter: true }), true)
})
