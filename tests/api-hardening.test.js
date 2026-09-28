// API 加固回归（2026-09-24 审计批次 1 · F⑨⑩）。
//
// ⑨ memory-sync 十路由缺 HTTP method 校验：GET 即可触发副作用（global-sync
// 无 sessionId 依赖可被裸 GET 驱动 git 网络操作）。
// ⑩ promote 端点 todo-archive 的 cwd 解析脱节：todo-project 原轨归档条目
// 转正 100% 失败（底层裸抛 400，调用方无解）。
// 直跑：node tests/api-hardening.test.js。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveStore, MemoryStore } from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'
import { promoteArchived } from '../lib/review.js'

test('⑨静态契约：memory-sync 十路由全部显式校验 method', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'lib', 'api.js'), 'utf8')
  const names = ['setup', 'sync', 'off', 'project-enabled', 'track', 'conflicts', 'resolve', 'global-track', 'global-sync', 'global-remote']
  for (const name of names) {
    // 每个路由的条件必须以 req.method === 开头（不再有裸 path 判断）
    const bare = new RegExp(`if \\(path === '/memory-evolve/memory-sync/${name}'\\)`)
    assert.equal(bare.test(src), false, `${name} 不得再有裸 path 判断（GET 触发副作用）`)
    const guarded = new RegExp(`if \\(req\\.method === '(GET|POST)' && path === '/memory-evolve/memory-sync/${name}'\\)`)
    assert.equal(guarded.test(src), true, `${name} 必须显式校验 method`)
  }
})

test('⑩a todo-project 归档条目转正：带 cwd 成功（原 P1-1 场景 A）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-hard-'))
  try {
    const store = new MemoryStore(dir)
    const todoStore = new TodoStore(dir)
    const archive = new ArchiveStore(dir)
    archive.append('todo-archive', '[2026-09-24] 写周报（原轨：todo-project）', undefined)
    const r = promoteArchived(store, todoStore, archive, 'todo-archive', '写周报', 'D:\\proj\\x')
    assert.equal(r.ok, true, JSON.stringify(r))
    // 转正后归档清空
    assert.equal(archive.entriesOf('todo-archive').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑩b 缺原轨标记的 todo-archive 条目：友好报错不裸抛（原场景 B）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-hard-'))
  try {
    const store = new MemoryStore(dir)
    const todoStore = new TodoStore(dir)
    const archive = new ArchiveStore(dir)
    archive.append('todo-archive', '[2026-09-24] 无原轨标记的旧条目', undefined)
    const r = promoteArchived(store, todoStore, archive, 'todo-archive', '无原轨标记', 'D:\\proj\\x')
    assert.equal(r.ok, false)
    assert.match(r.message, /原轨|手动/)
    // 归档条目保留（fail-loud 不丢数据）
    assert.equal(archive.entriesOf('todo-archive').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑩c todo-project 原轨转正无 cwd：明确提示（不再裸抛「需要会话工作目录」）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-hard-'))
  try {
    const store = new MemoryStore(dir)
    const todoStore = new TodoStore(dir)
    const archive = new ArchiveStore(dir)
    archive.append('todo-archive', '[2026-09-24] 写周报（原轨：todo-project）', undefined)
    const r = promoteArchived(store, todoStore, archive, 'todo-archive', '写周报', undefined)
    assert.equal(r.ok, false)
    assert.match(r.message, /工作目录|项目会话/)
    assert.equal(archive.entriesOf('todo-archive').length, 1, '归档条目保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
