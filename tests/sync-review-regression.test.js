/**
 * tests/sync-review-regression.test.js — 审查回归测试（Grok/Codex 报告 P0/P1）
 *
 * 覆盖审查发现的关键缺陷，防止回退：
 *   - 双 ID：自带 [id:] 的 add 不再产生双 ID；replace 权威 ID 继承
 *   - 迁移保数据：同名冲突保留双份、logs/ 子目录递归移动
 *   - 非 canonical 文件补发跳过（不破坏 CRLF 文件）
 *   - adopt 非空目录守卫（用户记忆文件拒绝接入）
 *   - allowlist：TODOS.md 等白名单外文件不入库（git ls-files 验证）
 *   - removeExact 对身份证免疫（展示剥离后回传仍可精确删除）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { MemoryStore, ArchiveStore } from '../lib/store.js'
import { extractEntryId } from '../lib/sync/entryid.js'
import { ensureMemoryRepo, deviceBConnect } from '../lib/sync/repo.js'
import { resolveProjectId } from '../lib/sync/identity.js'

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-sync-reg-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

function git(dir, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`)
  return String(r.stdout ?? '').trim()
}

const skip = !gitAvailable()
const agent = { session: { header: { cwd: '/work/x' } } }

/** 模拟已 bootstrap 的 sync 项目目录（写 PROVENANCE）。 */
function syncInit(dir) {
  const projectDir = join(dir, 'projects', 'aaaaaaaaaaaa')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'PROVENANCE'), JSON.stringify({ projectId: 'aaaaaaaaaaaa', displayName: 'x', version: 1 }) + '\n')
  return projectDir
}

/* ── 双 ID 回归（Grok P0-2 / Codex P1-6）── */

test('add 自带 ID：单 ID 保留在最前（不产生双 ID，转正不断锚点）', () => {
  const dir = tempDir()
  try {
    syncInit(dir)
    const store = new MemoryStore(dir, { entryIdMode: 'on', projectDirResolver: () => join(dir, 'projects', 'aaaaaaaaaaaa') })
    const r = store.add('key', '[id:deadbeef] [2026-08-10] 从归档转正的旧事', agent)
    assert.equal(r.ok, true)
    const entry = store.entriesOf('key', agent)[0]
    // 恰好一个 ID，且在最前
    assert.equal(extractEntryId(entry), 'deadbeef')
    assert.equal((entry.match(/\[id:[0-9a-f]{8}\]/g) ?? []).length, 1, '不应产生双 ID')
    assert.ok(entry.startsWith('[id:deadbeef] '))
    // 内容保留
    assert.ok(entry.includes('从归档转正的旧事'))
  } finally {
    clean(dir)
  }
})

test('replace 权威 ID：replacement 自带 ID 被剥离，旧 ID 为唯一身份', () => {
  const dir = tempDir()
  try {
    syncInit(dir)
    const store = new MemoryStore(dir, { entryIdMode: 'on', projectDirResolver: () => join(dir, 'projects', 'aaaaaaaaaaaa') })
    store.add('key', '原始内容', agent)
    const oldId = extractEntryId(store.entriesOf('key', agent)[0])
    // replacement 里误写另一个 ID——必须以旧 ID 为权威
    const r = store.replace('key', '原始内容', '[id:ffffffff] 新内容', agent)
    assert.equal(r.ok, true)
    const entry = store.entriesOf('key', agent)[0]
    assert.equal(extractEntryId(entry), oldId, '旧 ID 是权威')
    assert.equal((entry.match(/\[id:[0-9a-f]{8}\]/g) ?? []).length, 1)
  } finally {
    clean(dir)
  }
})

/* ── 精确匹配对身份证免疫（Grok P0-1 / Codex P1-3）── */

test('removeExact：展示剥离文本回传仍能精确删除', () => {
  const dir = tempDir()
  try {
    syncInit(dir)
    const store = new MemoryStore(dir, { entryIdMode: 'on', projectDirResolver: () => join(dir, 'projects', 'aaaaaaaaaaaa') })
    store.add('key', '要删除的条目', agent)
    const diskEntry = store.entriesOf('key', agent)[0]
    assert.match(diskEntry, /^\[id:/)
    // 前端持有的是剥离后文本
    const visible = diskEntry.replace(/^\[id:[0-9a-f]{8}\] /, '')
    const r = store.removeExact('key', visible, agent)
    assert.equal(r.ok, true, '剥离文本应能精确删除（strip 匹配）')
    assert.equal(store.entriesOf('key', agent).length, 0)
  } finally {
    clean(dir)
  }
})

test('ArchiveStore：key 归档与主轨同一项目目录（resolver 生效）', () => {
  const dir = tempDir()
  try {
    const projectDir = join(dir, 'projects', 'aaaaaaaaaaaa')
    syncInit(dir)
    const archive = new ArchiveStore(dir, { projectDirResolver: () => projectDir })
    const r = archive.append('key', '[2026-08-10] 归档条目', '/work/x')
    assert.equal(r.ok, true)
    // 归档文件在项目目录（resolver 指定的），而不是默认 hash 目录
    assert.ok(existsSync(join(projectDir, 'KEY-archive.md')))
    assert.ok(!existsSync(join(dir, 'projects', '2a3132d1d2c1', 'KEY-archive.md')), '默认 hash 目录不应出现归档')
  } finally {
    clean(dir)
  }
})

/* ── 迁移保数据（Codex P0-1）── */

test('迁移：同名冲突保留双份 + logs/ 子目录递归移动', { skip }, async () => {
  const root = tempDir()
  try {
    const memoryDir = join(root, 'memories')
    const cwd = join(root, 'work')
    mkdirSync(cwd, { recursive: true })
    git(cwd, ['init', '-q', '-b', 'main'])
    git(cwd, ['remote', 'add', 'origin', 'https://example.com/acme/alpha.git'])
    const identity = resolveProjectId(cwd)
    // 旧目录（legacy hash）有：KEY.md（冲突）、logs/ 子目录、TODOS.md
    const legacyId = (await import('../lib/store.js')).projectHash(cwd)
    const legacyDir = join(memoryDir, 'projects', legacyId)
    mkdirSync(join(legacyDir, 'logs'), { recursive: true })
    writeFileSync(join(legacyDir, 'KEY.md'), '[id:aaaa0000] [2026-08-10] 旧 KEY\n')
    writeFileSync(join(legacyDir, 'logs', '2026-08-09.md'), '[2026-08-09 10:00] 旧日志\n')
    writeFileSync(join(legacyDir, 'TODOS.md'), '- [ ] 待办\n')
    // 新目录已存在且 KEY.md 有内容（模拟身份变化后两边都写过）
    const dir = join(memoryDir, 'projects', identity.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'KEY.md'), '[id:bbbb0000] [2026-08-10] 新 KEY\n')

    const boot = await ensureMemoryRepo({ dir, memoryDir, cwd, projectId: identity.id, displayName: identity.displayName, remoteUrl: identity.remoteUrl, remoteBranch: 'dsh-shared/memory' })
    assert.equal(boot.ok, true)
    assert.equal(boot.migratedConflicts, 1, '同名 KEY.md 应备份双份')
    // 新 KEY 保留（目标版本不动）
    assert.ok(readFileSync(join(dir, 'KEY.md'), 'utf8').includes('新 KEY'))
    // 旧 KEY 备份保留（.pre-migrate 后缀）
    assert.ok(readFileSync(join(dir, 'KEY.md.pre-migrate'), 'utf8').includes('旧 KEY'), '旧 KEY 应备份为 .pre-migrate')
    // logs/ 子目录递归移动
    assert.ok(readFileSync(join(dir, 'logs', '2026-08-09.md'), 'utf8').includes('旧日志'), 'logs/ 子目录应递归迁移')
    // TODOS.md 也在（白名单外文件原样移动）
    assert.ok(existsSync(join(dir, 'TODOS.md')))
    // 旧目录已删除
    assert.ok(!existsSync(legacyDir))
  } finally {
    clean(root)
  }
})

/* ── 非 canonical 补发保护（Codex P0-2）── */

test('非 canonical 文件：补发跳过并备份，不破坏条目边界', { skip }, async () => {
  const root = tempDir()
  try {
    const memoryDir = join(root, 'memories')
    const cwd = join(root, 'work')
    mkdirSync(cwd, { recursive: true })
    git(cwd, ['init', '-q', '-b', 'main'])
    git(cwd, ['remote', 'add', 'origin', 'https://example.com/acme/alpha.git'])
    const identity = resolveProjectId(cwd)
    const dir = join(memoryDir, 'projects', identity.id)
    mkdirSync(dir, { recursive: true })
    // CRLF 文件（parseEntries 无法往返——\r 残留）
    const crlf = '[2026-08-10] 第一条\r\n§\r\n[2026-08-10] 第二条\r\n'
    writeFileSync(join(dir, 'KEY.md'), crlf)
    const boot = await ensureMemoryRepo({ dir, memoryDir, cwd, projectId: identity.id, displayName: identity.displayName, remoteUrl: identity.remoteUrl, remoteBranch: 'dsh-shared/memory' })
    assert.equal(boot.ok, true)
    assert.equal(boot.backfilled, 0, '非 canonical 不补发')
    assert.equal(boot.skippedBackfill, 1, '应报告跳过')
    // 文件原样保留（未被重写）
    assert.equal(readFileSync(join(dir, 'KEY.md'), 'utf8'), crlf)
    // 备份存在
    const baks = (await import('node:fs')).readdirSync(dir).filter((n) => n.startsWith('KEY.md.bak.'))
    assert.equal(baks.length, 1, '应有备份')
  } finally {
    clean(root)
  }
})

/* ── adopt 守卫（Grok P1-5 / Codex P1-8）── */

test('adopt：目录已有用户记忆文件 → 拒绝接入（不覆盖）', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = join(root, 'bare.git')
    mkdirSync(bare, { recursive: true })
    git(bare, ['init', '-q', '--bare'])
    // 远端有分支（先在一处初始化并推送）
    const cwdA = join(root, 'workA')
    mkdirSync(cwdA, { recursive: true })
    git(cwdA, ['init', '-q', '-b', 'main'])
    git(cwdA, ['remote', 'add', 'origin', 'https://example.com/acme/alpha.git'])
    const identityA = resolveProjectId(cwdA)
    const memoryDirA = join(root, 'memoriesA')
    const dirA = join(memoryDirA, 'projects', identityA.id)
    const boot = await ensureMemoryRepo({ dir: dirA, memoryDir: memoryDirA, cwd: cwdA, projectId: identityA.id, displayName: identityA.displayName, remoteUrl: identityA.remoteUrl, remoteBranch: 'dsh-shared/memory' })
    assert.equal(boot.ok, true)
    writeFileSync(join(dirA, 'KEY.md'), '[id:aaaa0000] [2026-08-10] 远端记忆\n')
    git(dirA, ['add', '-f', '--', 'KEY.md'])
    git(dirA, ['commit', '-q', '-m', 'memory: key'])
    git(dirA, ['push', '-q', bare, 'main:dsh-shared/memory'])
    // 目标目录已有本地记忆文件
    const dirB = join(root, 'memoriesB', 'projects', identityA.id)
    mkdirSync(dirB, { recursive: true })
    writeFileSync(join(dirB, 'KEY.md'), '[2026-08-10] 本地未提交记忆\n')
    const connect = await deviceBConnect({ dir: dirB, remoteUrl: bare, remoteBranch: 'dsh-shared/memory', expectedProjectId: identityA.id })
    assert.equal(connect.ok, false)
    assert.equal(connect.mode, 'error')
    assert.match(connect.message, /已有记忆内容/)
    // 本地记忆未被破坏
    assert.ok(readFileSync(join(dirB, 'KEY.md'), 'utf8').includes('本地未提交记忆'))
    assert.ok(!existsSync(join(dirB, '.git')), '失败不得 init')
  } finally {
    clean(root)
  }
})

/* ── allowlist（Codex P1-12）── */

test('allowlist：TODOS.md 等白名单外文件不入库（git ls-files 验证）', { skip }, async () => {
  const root = tempDir()
  try {
    const memoryDir = join(root, 'memories')
    const cwd = join(root, 'work')
    mkdirSync(cwd, { recursive: true })
    git(cwd, ['init', '-q', '-b', 'main'])
    git(cwd, ['remote', 'add', 'origin', 'https://example.com/acme/alpha.git'])
    const identity = resolveProjectId(cwd)
    const dir = join(memoryDir, 'projects', identity.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'KEY.md'), '[id:aaaa0000] [2026-08-10] 记忆\n')
    writeFileSync(join(dir, 'TODOS.md'), '- [ ] 待办（不该入库）\n')
    writeFileSync(join(dir, 'scratch.md'), '便签（不该入库）\n')
    const boot = await ensureMemoryRepo({ dir, memoryDir, cwd, projectId: identity.id, displayName: identity.displayName, remoteUrl: identity.remoteUrl, remoteBranch: 'dsh-shared/memory' })
    assert.equal(boot.ok, true)
    const tracked = git(dir, ['ls-files'])
    assert.ok(tracked.includes('KEY.md'), 'KEY.md 应入库')
    assert.ok(tracked.includes('PROVENANCE'), 'PROVENANCE 应入库')
    assert.ok(!tracked.includes('TODOS.md'), 'TODOS.md 不应入库')
    assert.ok(!tracked.includes('scratch.md'), '便签不应入库')
  } finally {
    clean(root)
  }
})
