import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { buildMemoryFiles } from '../lib/memory-tab.js'
import { setLocale, getLocale } from '../lib/i18n.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-tab-test-'))
}

function setup(overrides = {}) {
  const dir = tempDir()
  const config = {
    memoryDir: dir,
    skillDir: join(dir, 'skills'),
    ...overrides,
  }
  const store = new MemoryStore(dir)
  return { dir, config, store }
}

test('buildMemoryFiles lists all nine tracks with content', () => {
  const { dir, config, store } = setup()
  store.add('memory', '环境事实')
  store.add('user', '用户偏好')
  const projectAgent = { session: { header: { cwd: '/work/p' } } }
  store.add('project', '项目约定', projectAgent)
  store.add('key', '项目关键事实', projectAgent)
  store.add('daily', '今天做了事')
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    writeFileSync(join(dir, 'AGENTS.md'), '全局规则')
    const files = buildMemoryFiles(config, store, '/work/p')
    assert.equal(files.length, 9)
    const byKey = Object.fromEntries(files.map((f) => [f.key, f]))
    assert.equal(byKey.agents.content, '全局规则')
    assert.equal(byKey.memory.content.includes('环境事实'), true)
    assert.equal(byKey.user.content.includes('用户偏好'), true)
    assert.equal(byKey.project.content.includes('项目约定'), true)
    assert.equal(byKey.key.content.includes('项目关键事实'), true)
    assert.equal(byKey.daily.content.includes('今天做了事'), true)
    assert.equal(byKey['archive-memory'].exists, false)
    assert.equal(byKey['archive-user'].exists, false)
    assert.equal(byKey['archive-key'].available, true)
    assert.equal(byKey['archive-key'].exists, false)
  } finally {
    process.env.DSH_HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildMemoryFiles localizes row titles with the active locale', () => {
  const { dir, config, store } = setup()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const prevLocale = getLocale()
  try {
    // English (default): titles must not be the legacy Chinese strings.
    setLocale('en')
    let files = buildMemoryFiles(config, store, '/work/p')
    assert.equal(files.length, 9)
    const enByTitle = Object.fromEntries(files.map((f) => [f.title, f]))
    assert.deepEqual(
      Object.keys(enByTitle).sort(),
      ['AGENTS.md', 'Archived key facts KEY-archive.md', 'Archived long-term memory MEMORY-archive.md',
        'Archived user profile USER-archive.md', 'Daily log', 'Key project facts KEY.md',
        'Long-term memory MEMORY.md', 'Project log', 'User profile USER.md'].sort(),
    )
    // Chinese: legacy contract titles stay byte-identical.
    setLocale('zh')
    files = buildMemoryFiles(config, store, '/work/p')
    const zhByTitle = Object.fromEntries(files.map((f) => [f.title, f]))
    assert.equal(zhByTitle['项目日志'] !== undefined, true)
    assert.equal(zhByTitle['今日日志'] !== undefined, true)
    assert.equal(zhByTitle['长期记忆 MEMORY.md'] !== undefined, true)
    assert.equal(zhByTitle['全局规则 AGENTS.md'] !== undefined, true)
  } finally {
    setLocale(prevLocale)
    process.env.DSH_HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildMemoryFiles handles missing files and missing cwd', () => {
  const { dir, config, store } = setup()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir // isolate AGENTS.md from the real dsh home
  try {
    const files = buildMemoryFiles(config, store, undefined)
    const byKey = Object.fromEntries(files.map((f) => [f.key, f]))
    assert.equal(byKey.agents.exists, false)
    assert.equal(byKey.agents.content, '')
    assert.equal(byKey.memory.exists, false)
    // project without a cwd is unavailable but still listed
    assert.equal(byKey.project.available, false)
    assert.equal(byKey.project.path, undefined)
    // key track follows the same cwd rule
    assert.equal(byKey.key.available, false)
    assert.equal(byKey.key.path, undefined)
  } finally {
    process.env.DSH_HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
  }
})

