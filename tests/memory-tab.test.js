import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { buildMemoryFiles, saveMemoryFile } from '../lib/memory-tab.js'

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

test('buildMemoryFiles lists all five tracks with content', () => {
  const { dir, config, store } = setup()
  store.add('memory', '环境事实')
  store.add('user', '用户偏好')
  const projectAgent = { session: { header: { cwd: '/work/p' } } }
  store.add('project', '项目约定', projectAgent)
  store.add('daily', '今天做了事')
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    writeFileSync(join(dir, 'AGENTS.md'), '全局规则')
    const files = buildMemoryFiles(config, store, '/work/p')
    assert.equal(files.length, 5)
    const byKey = Object.fromEntries(files.map((f) => [f.key, f]))
    assert.equal(byKey.agents.content, '全局规则')
    assert.equal(byKey.agents.editable, false)
    assert.equal(byKey.memory.content.includes('环境事实'), true)
    assert.equal(byKey.memory.editable, false)
    assert.equal(byKey.user.content.includes('用户偏好'), true)
    assert.equal(byKey.project.content.includes('项目约定'), true)
    assert.equal(byKey.project.editable, true)
    assert.equal(byKey.daily.content.includes('今天做了事'), true)
    assert.equal(byKey.daily.editable, true)
  } finally {
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
  } finally {
    process.env.DSH_HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saveMemoryFile only allows project and daily', () => {
  const { dir, config, store } = setup()
  assert.equal(saveMemoryFile(config, store, 'memory', 'x', '/w').ok, false)
  assert.equal(saveMemoryFile(config, store, 'user', 'x', '/w').ok, false)
  assert.equal(saveMemoryFile(config, store, 'agents', 'x', '/w').ok, false)
  // project requires a cwd
  assert.equal(saveMemoryFile(config, store, 'project', 'x', undefined).ok, false)
  const daily = saveMemoryFile(config, store, 'daily', '今天改了一版\n', '/w')
  assert.equal(daily.ok, true)
  assert.equal(readFileSync(daily.path, 'utf8'), '今天改了一版\n')
  const project = saveMemoryFile(config, store, 'project', '项目新约定', '/work/p')
  assert.equal(project.ok, true)
  assert.equal(readFileSync(project.path, 'utf8'), '项目新约定')
  // oversized content refused
  const huge = saveMemoryFile(config, store, 'daily', 'x'.repeat(70 * 1024), '/w')
  assert.equal(huge.ok, false)
  rmSync(dir, { recursive: true, force: true })
})
