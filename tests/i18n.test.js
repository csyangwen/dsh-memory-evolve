/**
 * English-support i18n tests: dictionary integrity, locale resolution, the
 * live settings/updated switch, and per-locale output of user-facing
 * surfaces (tool descriptions, store messages, feedback lines, snapshot).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LOCALES,
  MEMORY_DICT,
  REVIEW_DICT,
  TODO_DICT,
  SKILL_DICT,
  SNAPSHOT_DICT,
  STORE_DICT,
  STORE_TAIL_DICT,
  REVIEW_CMD_DICT,
  resolveLocale,
  setLocale,
  getLocale,
  translate,
} from '../lib/i18n.js'
import { MemoryStore } from '../lib/store.js'
import { memoryTool, renderSnapshot, resolveConfig } from '../lib/index.js'
import { reviewStatusTool, suggestToolDefinition, reviewTurnCounter } from '../lib/review.js'
import { todoToolDefinition, TodoStore } from '../lib/todo.js'
import { skillManageTool } from '../lib/skills.js'
import { SuggestionQueue } from '../lib/store.js'

const ALL_DICTS = [
  ['MEMORY', MEMORY_DICT],
  ['REVIEW', REVIEW_DICT],
  ['TODO', TODO_DICT],
  ['SKILL', SKILL_DICT],
  ['SNAPSHOT', SNAPSHOT_DICT],
  ['STORE', STORE_DICT],
  ['STORE_TAIL', STORE_TAIL_DICT],
  ['REVIEW_CMD', REVIEW_CMD_DICT],
]

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'i18n-test-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

test('every dictionary key carries a non-empty zh/en pair', () => {
  for (const [name, dict] of ALL_DICTS) {
    const keys = Object.keys(dict)
    assert.ok(keys.length > 0, `${name} dict must not be empty`)
    for (const [key, pair] of Object.entries(dict)) {
      assert.ok(Array.isArray(pair), `${name}.${key} must be a [zh, en] array`)
      assert.equal(pair.length, 2, `${name}.${key} must have exactly two cells`)
      assert.ok(typeof pair[0] === 'string' && pair[0].length > 0, `${name}.${key} zh cell must be non-empty`)
      assert.ok(typeof pair[1] === 'string' && pair[1].length > 0, `${name}.{key} en cell must be non-empty`.replace('{key}', key))
    }
  }
})

test('translate substitutes {name} params and falls back to the key when missing', () => {
  const dict = { 'k.hello': ['Xin chào {name}', 'Hello {name}'] }
  assert.equal(translate(dict, 'k.hello', { name: 'Kai' }, 'en'), 'Hello Kai')
  assert.equal(translate(dict, 'k.hello', { name: 'Minh' }, 'zh'), 'Xin chào Minh')
  assert.equal(translate(dict, 'k.missing'), 'k.missing')
  // unknown param stays as-is
  assert.equal(translate(dict, 'k.hello', { other: 1 }, 'en'), 'Hello {name}')
})

test('resolveLocale: en only when DSH Language preference is explicitly en; legacy default stays zh', async () => {
  const makeCtx = (section) => ({
    get: (name) => (name === 'settings' ? { get: (ns) => (ns === 'locale' ? section : undefined) } : undefined),
  })
  setLocale('en') // reset singleton to the plugin default
  assert.deepEqual(LOCALES, ['zh', 'en'])
  assert.equal(resolveLocale(undefined), 'zh', 'no settings service → default zh')
  assert.equal(resolveLocale(makeCtx(undefined)), 'zh', 'settings without a locale section → zh')
  assert.equal(resolveLocale(makeCtx({ preference: 'auto' })), 'zh', 'auto → zh')
  assert.equal(resolveLocale(makeCtx({ preference: 'zh' })), 'zh', 'explicit zh → zh')
  assert.equal(resolveLocale(makeCtx({ preference: 'en' })), 'en', 'explicit en → en')
})

test('setLocale/getLocale round-trip and ignore invalid ids', () => {
  setLocale('zh')
  assert.equal(getLocale(), 'zh')
  setLocale('fr')
  assert.equal(getLocale(), 'zh', 'invalid ids are ignored')
  setLocale('en')
  assert.equal(getLocale(), 'en')
  setLocale('en') // restore default for later tests
})

test('memory tool description follows the active locale via getter', async () => {
  const dir = tempDir()
  const config = resolveConfig({ memoryDir: dir })
  const store = new MemoryStore(config.memoryDir, config)
  const queue = new SuggestionQueue(join(dir, 'suggestions.json'))
  const tool = memoryTool({}, config, store, queue, () => config, undefined)
  setLocale('zh')
  assert.ok(tool.description.startsWith('读写长期记忆'))
  setLocale('en')
  assert.ok(tool.description.startsWith('Read/write long-term memory'))
  setLocale('zh')
  clean(dir)
})

/** Fake exec context with an agent whose cwd points at dir (project track). */
function fakeExec(cwd) {
  return { agent: cwd ? { id: 'a1', session: { header: { cwd } } } : { id: 'a1' } }
}

test('store result messages render in both locales', () => {
  const dir = tempDir()
  const store = new MemoryStore(dir)
  setLocale('en')
  const empty = store.add('memory', '   ')
  assert.equal(empty.message, 'Content must not be empty')
  store.add('memory', 'abc')
  const dup = store.add('memory', 'abc')
  assert.equal(dup.message, 'Entry already exists; not added again')
  const added = store.add('memory', 'def')
  assert.match(added.message, /^Added \(memory: \d+ → \d+ entries\)$/)
  const noMatch = store.replace('memory', 'zzz-not-there', 'new text')
  assert.equal(noMatch.message, 'No entry contains the substring "zzz-not-there"')
  const multi = store.add('memory', 'dup-target')
  store.add('memory', 'dup-target again')
  void multi
  setLocale('zh')
  const dupZh = store.add('memory', 'abc')
  assert.equal(dupZh.message, '条目已存在，未重复添加')
  clean(dir)
})

test('feedback line renders in both locales', async () => {
  const dir = tempDir()
  mkdirSync(dir, { recursive: true })
  const config = resolveConfig({ memoryDir: dir })
  const store = new MemoryStore(config.memoryDir, config)
  const queue = new SuggestionQueue(join(dir, 'suggestions.json'))
  const projectDir = join(dir, 'proj')
  mkdirSync(projectDir, { recursive: true })
  const tool = memoryTool({}, config, store, queue, () => config, undefined)
  setLocale('en')
  await tool.execute(
    { action: 'add', target: 'daily', content: 'shipped the parser', feedback: { sentiment: 'positive', category: 'Coding/Backend', quote: 'great work!', note: 'clean fix' } },
    fakeExec(),
  )
  const daily = readFileSync(join(config.memoryDir, `daily/${new Date().toISOString().slice(0, 10)}.md`), 'utf8')
  assert.ok(daily.includes('[Feedback]sentiment:positive | category:Coding/Backend | quote:"great work!" | note:clean fix'), daily)
  setLocale('zh')
  await tool.execute(
    { action: 'add', target: 'daily', content: 'hoàn tất parser', feedback: { sentiment: 'negative', category: '编程/后端' } },
    fakeExec(),
  )
  const dailyZh = readFileSync(join(config.memoryDir, `daily/${new Date().toISOString().slice(0, 10)}.md`), 'utf8')
  assert.ok(dailyZh.includes('【反馈】情绪:负面 | 分类:编程/后端'), dailyZh)
  clean(dir)
})

test('renderSnapshot duties follow the active locale (legacy zh assertions keep passing)', () => {
  const dir = tempDir()
  const config = resolveConfig({ memoryDir: dir })
  const store = new MemoryStore(config.memoryDir, config)
  const agent = { id: 'a', session: { header: { cwd: '/proj/x' } } }
  store.add('key', 'X 项目的长期约定', agent)
  setLocale('zh')
  const zhSnap = renderSnapshot(config, store, agent)
  assert.ok(zhSnap.includes('## 记忆 memory-evolve'))
  assert.ok(zhSnap.includes('每轮收尾'))
  assert.ok(zhSnap.includes('严禁先调工具'))
  assert.ok(zhSnap.includes('## 本项目关键记忆'))
  setLocale('en')
  const enSnap = renderSnapshot(config, store, agent)
  assert.ok(enSnap.includes('## Memory memory-evolve'), enSnap.slice(0, 400))
  assert.ok(enSnap.includes('End of every turn'))
  assert.ok(enSnap.includes('calling tools first is strictly forbidden'))
  assert.ok(enSnap.includes("This project's key memories"))
  assert.ok(enSnap.includes('X 项目的长期约定'), 'entry content itself is never translated')
  assert.ok(!enSnap.includes('每轮收尾'))
  setLocale('zh')
  clean(dir)
})

test('review status + suggest tool descriptions follow the locale', () => {
  const dir = tempDir()
  const runtime = { reviewInterval: 20, reviewEnabled: true, reviewMode: 'suggest' }
  const counter = { turnsOf: () => 0, complete: () => {} }
  setLocale('en')
  const rs = reviewStatusTool(() => runtime, counter)
  assert.ok(rs.description.startsWith('Completes the automatic memory review'))
  const config = resolveConfig({ memoryDir: dir })
  const queue = new SuggestionQueue(join(dir, 'suggestions.json'))
  const sg = suggestToolDefinition(config, queue)
  assert.ok(sg.description.startsWith('Propose one long-term-memory suggestion'))
  setLocale('zh')
  assert.ok(reviewStatusTool(() => runtime, counter).description.startsWith('完成每 N 个用户回合的自动记忆审查'))
  clean(dir)
})

test('todo + skill tool descriptions follow the locale', () => {
  const dir = tempDir()
  const config = resolveConfig({ memoryDir: dir })
  const todoStore = new TodoStore(config.memoryDir)
  setLocale('en')
  const todo = todoToolDefinition(config, todoStore)
  assert.ok(todo.description.startsWith('Todo management (four tracks'))
  const skill = skillManageTool({}, config)
  assert.ok(skill.description.startsWith('Manage the skill library'))
  setLocale('zh')
  assert.ok(todoToolDefinition(config, todoStore).description.startsWith('待办管理（四轨'))
  clean(dir)
})

test('skill validation messages follow the locale', async () => {
  const dir = tempDir()
  const config = resolveConfig({ memoryDir: dir })
  const skill = skillManageTool({}, config)
  setLocale('en')
  const bad = await skill.execute({ action: 'create', name: 'Bad Name', body: '---\nname: x\n' }, fakeExec())
  assert.ok(bad.message.includes('Invalid skill name'), bad.message)
  setLocale('zh')
  const badZh = await skill.execute({ action: 'create', name: 'Bad Name', body: '---\nname: x\n' }, fakeExec())
  assert.ok(badZh.message.includes('无效技能名'), badZh.message)
  clean(dir)
})
