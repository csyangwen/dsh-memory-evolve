/**
 * 会话搜索模块测试 — core 纯函数 + Codex 解析 + 端到端搜索。
 *
 * 覆盖重点（吸取 dsh-session-search 被 5 家 CLI 指出的缺陷）：
 *  - 坏行宽容：单行损坏不淘汰整个会话文件；
 *  - rg 预筛失败/缺失/查询含转义字符 → 回退全量解析（结果正确性不依赖 rg）；
 *  - 大小写不敏感、中文匹配、cwd 过滤、排序、Top-K 截断、窗口/snippet。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  occurrenceCount, normalize, snippet, centeredWindow, compareHits,
  hitForSession, searchSessions, createTopK, clip, canRawPrefilter,
  DEFAULT_LIMIT, LIMIT_MAX, SEARCH_ROLES,
} from '../lib/search/core.js'
import { discoverCodexFiles, parseCodexFile } from '../lib/search/codex.js'
import { runSessionSearch, sessionSearchToolDefinition, installSessionSearch } from '../lib/search/index.js'

/** 清理所有临时目录。 */
const temps = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-search-test-'))
  temps.push(dir)
  return dir
}

/** 构造一个内存会话（core 测试用）。 */
function makeSession({ sessionId = 's1', cwd = '/proj/a', updatedAt = 1000, messages = [] } = {}) {
  return {
    session: { source: 'codex', sessionId, path: '/x', title: 't', cwd, createdAt: 0, updatedAt, messageCount: messages.length },
    messages,
  }
}

function makeMessage(content, { seq = 0, role = 'user', ts = 1000 } = {}) {
  return { source: 'codex', sessionId: 's', seq, msgId: String(seq), role, content, ts }
}

// ---------------------------------------------------------------- core

test('occurrenceCount：大小写不敏感、非重叠计数', () => {
  assert.equal(occurrenceCount('Hello HELLO hello', 'hello'), 3)
  assert.equal(occurrenceCount('aaa', 'aa'), 1) // 非重叠
  assert.equal(occurrenceCount('中文测试中文', '中文'), 2)
  assert.equal(occurrenceCount('nothing', 'x'), 0)
})

test('normalize：英文转小写，中文原样', () => {
  assert.equal(normalize('AbC 中文'), 'abc 中文')
})

test('snippet：短内容原样；长内容以命中为中心', () => {
  assert.equal(snippet('short', 'short'), 'short')
  const long = 'x'.repeat(500) + 'KEY' + 'y'.repeat(500)
  const out = snippet(long, 'key')
  assert.ok(out.includes('KEY'))
  assert.ok(out.length <= 350 + 2) // 边界省略号
  assert.ok(out.startsWith('…') && out.endsWith('…'))
})

test('centeredWindow：居中取窗、越界收缩', () => {
  const msgs = [0, 1, 2, 3, 4, 5].map((i) => makeMessage(`m${i}`, { seq: i }))
  assert.deepEqual(centeredWindow(msgs, 2, 3).map((m) => m.seq), [1, 2, 3])
  assert.deepEqual(centeredWindow(msgs, 0, 3).map((m) => m.seq), [0, 1, 2]) // 越界左缩
  assert.deepEqual(centeredWindow(msgs, 5, 3).map((m) => m.seq), [3, 4, 5]) // 越界右缩
})

test('hitForSession：最强消息 + cwd 过滤 + 工具消息不搜', () => {
  const parsed = makeSession({
    cwd: '/proj/alpha',
    messages: [
      makeMessage('普通内容', { seq: 0, role: 'user' }),
      makeMessage('目标 目标 目标', { seq: 1, role: 'assistant' }),
      makeMessage('目标在工具输出里', { seq: 2, role: 'tool' }), // 工具消息不参与
    ],
  })
  const hit = hitForSession(parsed, { cwd: 'alpha' }, normalize('目标'))
  assert.ok(hit)
  assert.equal(hit.score, 3)
  assert.equal(hit.bestMatch.seq, 1)
  // cwd 不匹配 → 无命中
  assert.equal(hitForSession(parsed, { cwd: 'beta' }, normalize('目标')), undefined)
})

test('searchSessions：排序 + Top-K 截断', () => {
  const sessions = [
    makeSession({ sessionId: 'a', updatedAt: 100, messages: [makeMessage('x 命中', { ts: 1 })] }),
    makeSession({ sessionId: 'b', updatedAt: 200, messages: [makeMessage('命中 命中', { ts: 2 })] }),
    makeSession({ sessionId: 'c', updatedAt: 300, messages: [makeMessage('命中 命中 命中', { ts: 3 })] }),
  ]
  const hits = searchSessions(sessions, { query: '命中', limit: 2 })
  assert.equal(hits.length, 2)
  assert.equal(hits[0].session.sessionId, 'c') // 命中最多在前
  assert.equal(hits[1].session.sessionId, 'b')
  // newest 排序
  const newest = searchSessions(sessions, { query: '命中', sort: 'newest', limit: 10 })
  assert.deepEqual(newest.map((h) => h.session.sessionId), ['c', 'b', 'a'])
  // 空查询
  assert.deepEqual(searchSessions(sessions, { query: '  ' }), [])
})

test('createTopK：内存有界的累积器', () => {
  const topK = createTopK(2, 'relevance')
  topK.push({ session: { source: 'codex', sessionId: 'a', updatedAt: 1, cwd: '', title: '', createdAt: 0, path: '', messageCount: 0 }, bestMatch: { seq: 0, role: 'user', ts: 1, source: 'codex', sessionId: 'a', msgId: '0', content: '' }, snippet: '', window: [], score: 1 })
  topK.push({ session: { source: 'codex', sessionId: 'b', updatedAt: 2, cwd: '', title: '', createdAt: 0, path: '', messageCount: 0 }, bestMatch: { seq: 0, role: 'user', ts: 2, source: 'codex', sessionId: 'b', msgId: '0', content: '' }, snippet: '', window: [], score: 5 })
  topK.push({ session: { source: 'codex', sessionId: 'c', updatedAt: 3, cwd: '', title: '', createdAt: 0, path: '', messageCount: 0 }, bestMatch: { seq: 0, role: 'user', ts: 3, source: 'codex', sessionId: 'c', msgId: '0', content: '' }, snippet: '', window: [], score: 3 })
  const ids = topK.values().map((h) => h.session.sessionId)
  assert.deepEqual(ids, ['b', 'c']) // 高分保留、低分淘汰
})

test('compareHits：relevance 同分按时间决胜', () => {
  const mk = (id, score, ts) => ({
    session: { source: 'codex', sessionId: id, updatedAt: ts, cwd: '', title: '', createdAt: 0, path: '', messageCount: 0 },
    bestMatch: { seq: 0, role: 'user', ts, source: 'codex', sessionId: id, msgId: '0', content: '' },
    snippet: '', window: [], score,
  })
  assert.ok(compareHits(mk('a', 2, 100), mk('b', 2, 200), 'relevance') > 0) // 同分：新的在前
  assert.ok(compareHits(mk('a', 2, 100), mk('b', 3, 100), 'relevance') > 0) // 分高在前
})

test('clip 与 canRawPrefilter', () => {
  assert.equal(clip('short'), 'short')
  assert.equal(clip('x'.repeat(700)).length, 601)
  assert.equal(canRawPrefilter('中文 query'), true)
  assert.equal(canRawPrefilter('含"引号'), false) // JSON 转义字符 → 跳过预筛
  assert.equal(canRawPrefilter(''), false)
})

test('SEARCH_ROLES 覆盖 user/assistant', () => {
  assert.deepEqual([...SEARCH_ROLES].sort(), ['assistant', 'user'])
})

// ---------------------------------------------------------------- codex

/** 写一个 Codex rollout fixture（支持传坏行）。 */
function writeRollout(dir, name, lines) {
  const file = join(dir, name)
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

test('parseCodexFile：提取 cwd/消息/title/时间戳；坏行宽容', async () => {
  const dir = tempDir()
  const file = writeRollout(dir, 'rollout-2026-08-06T00-00-00-abc.jsonl', [
    '{"type":"session_meta","payload":{"cwd":"/proj/web"},"timestamp":"2026-08-06T00:00:00Z"}',
    '{ 这不是合法的 JSON 行 }', // 坏行：应跳过而不是淘汰整文件
    '{"type":"event_msg","payload":{"type":"user_message","message":"帮我搜索 会话"},"timestamp":"2026-08-06T00:00:01Z"}',
    '{"type":"event_msg","payload":{"type":"agent_message","message":"这是助手回复"},"timestamp":"2026-08-06T00:00:02Z"}',
    '{"type":"event_msg","payload":{"type":"tool_call","message":"工具调用"},"timestamp":"2026-08-06T00:00:03Z"}', // 非对话消息：不进消息列表
  ])
  const parsed = await parseCodexFile(file)
  assert.ok(parsed)
  assert.equal(parsed.session.cwd, '/proj/web')
  assert.equal(parsed.session.sessionId, 'rollout-2026-08-06T00-00-00-abc')
  assert.equal(parsed.messages.length, 2) // 坏行 + tool_call 都不计入
  assert.equal(parsed.messages[0].role, 'user')
  assert.equal(parsed.messages[1].role, 'assistant')
  assert.equal(parsed.session.title, '帮我搜索 会话') // 首条 user 消息作标题
  assert.ok(parsed.messages[1].ts > parsed.messages[0].ts)
  // updatedAt = 全文件最大事件时间（含非对话事件，如 tool_call）
  assert.equal(parsed.session.updatedAt, Date.parse('2026-08-06T00:00:03Z'))
})

test('parseCodexFile：空文件/全坏行返回 undefined', async () => {
  const dir = tempDir()
  const empty = writeRollout(dir, 'empty.jsonl', [''])
  assert.equal(await parseCodexFile(empty), undefined)
  const bad = writeRollout(dir, 'bad.jsonl', ['not json', 'also not json'])
  assert.equal(await parseCodexFile(bad), undefined) // 坏行宽容但无有效记录
})

test('parseCodexFile：兼容新格式 response_item（codex-tui 0.147+）', async () => {
  const dir = tempDir()
  const file = writeRollout(dir, 'rollout-tui.jsonl', [
    '{"type":"session_meta","payload":{"cwd":"/proj/new"},"timestamp":"2026-08-08T00:00:00Z"}',
    // developer（系统提示注入）：必须跳过
    '{"type":"response_item","payload":{"type":"message","id":"dev-1","role":"developer","content":[{"type":"input_text","text":"<skills_instructions>很长"} ]},"timestamp":"2026-08-08T00:00:01Z"}',
    // user 消息（内容块数组）
    '{"type":"response_item","payload":{"type":"message","id":"usr-1","role":"user","content":[{"type":"input_text","text":"帮我重构 会话搜索 模块"} ]},"timestamp":"2026-08-08T00:00:02Z"}',
    // assistant 消息（多块拼接）
    '{"type":"response_item","payload":{"type":"message","id":"ast-1","role":"assistant","content":[{"type":"output_text","text":"好的，我先看"},{"type":"output_text","text":"现有代码"} ]},"timestamp":"2026-08-08T00:00:03Z"}',
    // 非 message 的 response_item：跳过
    '{"type":"response_item","payload":{"type":"item_completed","id":"ic-1"},"timestamp":"2026-08-08T00:00:04Z"}',
  ])
  const parsed = await parseCodexFile(file)
  assert.ok(parsed)
  assert.equal(parsed.messages.length, 2) // developer 与非 message 不计入
  assert.equal(parsed.messages[0].role, 'user')
  assert.equal(parsed.messages[0].content, '帮我重构 会话搜索 模块')
  assert.equal(parsed.messages[0].msgId, 'usr-1') // 使用 payload.id
  assert.equal(parsed.messages[1].role, 'assistant')
  assert.equal(parsed.messages[1].content, '好的，我先看\n现有代码') // 多块拼接
  assert.equal(parsed.session.title, '帮我重构 会话搜索 模块')
})

test('parseCodexFile：新旧格式混合文件都能搜到', async () => {
  const dir = tempDir()
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  const file = writeRollout(join(dir, 'sessions'), 'rollout-mixed.jsonl', [
    '{"type":"session_meta","payload":{"cwd":"/proj/mix"},"timestamp":"2026-08-08T00:00:00Z"}',
    '{"type":"event_msg","payload":{"type":"user_message","message":"旧格式消息"},"timestamp":"2026-08-08T00:00:01Z"}',
    '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"新格式回复"} ]},"timestamp":"2026-08-08T00:00:02Z"}',
  ])
  const parsed = await parseCodexFile(file)
  assert.ok(parsed)
  assert.equal(parsed.messages.length, 2)
  assert.equal(parsed.messages[0].content, '旧格式消息')
  assert.equal(parsed.messages[1].content, '新格式回复')
  // 混合格式也能端到端搜到（rg 命中所有文件路径）
  const result = await runSessionSearch({ query: '新格式' }, { root: dir, spawn: fakeRgSpawn() })
  assert.equal(result.count, 1)
  // rg 缺失时回退全量解析，混合格式依然能搜到（正确性不依赖 rg）
  const fallback = await runSessionSearch({ query: '旧格式' }, { root: dir, spawn: fakeRgSpawn({ missing: true }) })
  assert.equal(fallback.count, 1)
})

test('parseCodexFile：不存在的文件返回 undefined', async () => {
  assert.equal(await parseCodexFile(join(tempDir(), 'nope.jsonl')), undefined)
})

test('discoverCodexFiles：发现 sessions 与 archived_sessions 下的 jsonl', async () => {
  const dir = tempDir()
  mkdirSync(join(dir, 'sessions', '2026', '08', '06'), { recursive: true })
  mkdirSync(join(dir, 'archived_sessions', 'old'), { recursive: true })
  writeFileSync(join(dir, 'sessions', '2026', '08', '06', 'rollout-a.jsonl'), '{}\n')
  writeFileSync(join(dir, 'archived_sessions', 'old', 'rollout-b.jsonl'), '{}\n')
  writeFileSync(join(dir, 'sessions', '2026', '08', '06', 'rollout-c.jsonl.gz'), 'x') // 非 jsonl：排除
  const files = await discoverCodexFiles(dir)
  assert.equal(files.length, 2)
  assert.ok(files.every((f) => f.path.endsWith('.jsonl')))
  assert.ok(files.some((f) => f.sessionId === 'rollout-a'))
  assert.ok(files.some((f) => f.sessionId === 'rollout-b'))
})

test('discoverCodexFiles：根目录不存在返回空数组', async () => {
  assert.deepEqual(await discoverCodexFiles(join(tempDir(), 'missing')), [])
})

// ---------------------------------------------------------------- 端到端

/**
 * fake spawn：模拟 rg --files-with-matches。可配置：
 *  - missAll=true → 返回空（无命中）
 *  - fail=true → 报错退出（触发回退全量）
 *  - missing=true → spawn 报 error（rg 不存在）
 */
function fakeRgSpawn({ missAll = false, fail = false, missing = false } = {}) {
  const spawn = (binary, args) => {
    assert.equal(binary, 'rg')
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    process.nextTick(() => {
      if (missing) {
        child.emit('error', new Error('ENOENT'))
        return
      }
      if (fail) {
        child.emit('close', 2) // rg 错误退出 → 回退全量
        return
      }
      // 默认：除 query 外全部路径命中（-- 之后是路径）
      const paths = args.slice(args.indexOf('--') + 1)
      const out = missAll ? '' : paths.join('\u0000') + '\u0000'
      child.stdout.emit('data', Buffer.from(out))
      child.emit('close', 0)
    })
    child.kill = () => {}
    return child
  }
  return spawn
}

test('runSessionSearch：端到端搜索 + rg 预筛命中', async () => {
  const dir = tempDir()
  mkdirSync(join(dir, 'sessions', '2026', '08', '06'), { recursive: true })
  writeRollout(join(dir, 'sessions', '2026', '08', '06'), 'rollout-a.jsonl', [
    '{"type":"session_meta","payload":{"cwd":"/proj/web"},"timestamp":"2026-08-06T00:00:00Z"}',
    '{"type":"event_msg","payload":{"type":"user_message","message":"帮我找 会话搜索 相关内容"},"timestamp":"2026-08-06T00:00:01Z"}',
  ])
  writeRollout(join(dir, 'sessions', '2026', '08', '06'), 'rollout-b.jsonl', [
    '{"type":"session_meta","payload":{"cwd":"/proj/api"},"timestamp":"2026-08-06T00:00:00Z"}',
    '{"type":"event_msg","payload":{"type":"user_message","message":"无关内容"},"timestamp":"2026-08-06T00:00:01Z"}',
  ])
  const result = await runSessionSearch({ query: '会话搜索' }, { root: dir, spawn: fakeRgSpawn() })
  assert.equal(result.count, 1)
  assert.equal(result.hits[0].sessionId, 'rollout-a')
  assert.equal(result.hits[0].cwd, '/proj/web')
  assert.equal(result.hits[0].bestMatch.text, '帮我找 会话搜索 相关内容')
  assert.ok(Array.isArray(result.hits[0].window))
})

test('runSessionSearch：rg 缺失/失败 → 回退全量解析（结果不变）', async () => {
  const dir = tempDir()
  mkdirSync(join(dir, 'sessions', '2026'), { recursive: true })
  writeRollout(join(dir, 'sessions', '2026'), 'rollout-x.jsonl', [
    '{"type":"session_meta","payload":{"cwd":"/proj/x"},"timestamp":"2026-08-06T00:00:00Z"}',
    '{"type":"event_msg","payload":{"type":"user_message","message":"fallback 目标"},"timestamp":"2026-08-06T00:00:01Z"}',
  ])
  for (const spawn of [fakeRgSpawn({ missing: true }), fakeRgSpawn({ fail: true })]) {
    const result = await runSessionSearch({ query: 'fallback' }, { root: dir, spawn })
    assert.equal(result.count, 1)
    assert.equal(result.hits[0].sessionId, 'rollout-x')
  }
})

test('runSessionSearch：查询含转义字符 → 跳过预筛直扫（正确性不依赖 rg）', async () => {
  const dir = tempDir()
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  writeRollout(join(dir, 'sessions'), 'rollout-q.jsonl', [
    '{"type":"event_msg","payload":{"type":"user_message","message":"他说 \\"引用\\" 很重要"},"timestamp":"2026-08-06T00:00:01Z"}',
  ])
  const result = await runSessionSearch({ query: '"引用"' }, { root: dir, spawn: fakeRgSpawn() })
  assert.equal(result.count, 1)
})

test('runSessionSearch：cwd 过滤 + limit 截断', async () => {
  const dir = tempDir()
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  for (const [id, cwd] of [['a', '/proj/alpha'], ['b', '/proj/beta'], ['c', '/proj/alpha']]) {
    writeRollout(join(dir, 'sessions'), `rollout-${id}.jsonl`, [
      `{"type":"session_meta","payload":{"cwd":"${cwd}"},"timestamp":"2026-08-06T00:00:00Z"}`,
      '{"type":"event_msg","payload":{"type":"user_message","message":"共同 关键词"},"timestamp":"2026-08-06T00:00:01Z"}',
    ])
  }
  const all = await runSessionSearch({ query: '关键词' }, { root: dir, spawn: fakeRgSpawn() })
  assert.equal(all.count, 3)
  const alpha = await runSessionSearch({ query: '关键词', cwd: 'alpha' }, { root: dir, spawn: fakeRgSpawn() })
  assert.equal(alpha.count, 2)
  const limited = await runSessionSearch({ query: '关键词', limit: 1 }, { root: dir, spawn: fakeRgSpawn() })
  assert.equal(limited.count, 1)
})

test('runSessionSearch：空查询返回空结果', async () => {
  const result = await runSessionSearch({ query: '   ' }, { root: tempDir(), spawn: fakeRgSpawn() })
  assert.equal(result.count, 0)
  assert.deepEqual(result.hits, [])
})

test('sessionSearchToolDefinition：schema 形状正确（query 必填、source 枚举 codex）', () => {
  const tool = sessionSearchToolDefinition({ root: tempDir() })
  assert.equal(tool.name, 'de_session_search')
  assert.deepEqual(tool.parameters.required, ['query'])
  assert.equal(tool.parameters.properties.query.type, 'string')
  assert.deepEqual(tool.parameters.properties.source.enum, ['codex'])
  assert.equal(typeof tool.execute, 'function')
  assert.equal(tool.output.schema.type, 'string')
})

test('installSessionSearch：注册工具并返回可卸载句柄', () => {
  const registered = []
  const ctx = {
    tools: { register: (tool) => { registered.push(tool); return () => {} } },
    effect: (fn) => { const disposer = fn(); return disposer ?? (() => {}) },
  }
  const installed = installSessionSearch(ctx, { sessionSearchRoots: null })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'de_session_search')
  installed.dispose()
  // 卸载后再次安装不应报错（句柄幂等）
  installed.dispose()
})

test('搜索是大小写不敏感的（Codex 真实场景）', async () => {
  const dir = tempDir()
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  writeRollout(join(dir, 'sessions'), 'rollout-case.jsonl', [
    '{"type":"event_msg","payload":{"type":"user_message","message":"Please fix the Login Page"},"timestamp":"2026-08-06T00:00:01Z"}',
  ])
  const result = await runSessionSearch({ query: 'login page' }, { root: dir, spawn: fakeRgSpawn() })
  assert.equal(result.count, 1)
})
