/**
 * tests/sync-conflict.test.js — 冲突兜底测试（施工图 §7 第 7 步验收）
 *
 * 覆盖：parseConflicts 解析、resolveConflict ours/theirs/both、
 * 全部解决后 CONFLICTS.md 删除、编号不存在报错。
 * 场景用真实 git 双设备：A 改一条 push、B 改同一条 → B sync 产生冲突 →
 * B resolve。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ensureMemoryRepo, deviceBConnect } from '../lib/sync/repo.js'
import { resolveProjectId } from '../lib/sync/identity.js'
import { runSync, parseConflicts, resolveConflict, countConflicts } from '../lib/sync/worker.js'

// This suite pins the legacy Chinese output contract; i18n.test.js covers English.
import { setLocale } from '../lib/i18n.js'
setLocale('zh')

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-sync-conflict-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`)
  return String(r.stdout ?? '').trim()
}

const skip = !gitAvailable()
const RB = 'dsh-shared/memory'
const KEY = (lines) => lines.join('\n§\n') + '\n'

/** 搭设备 A（bootstrap+写记忆+push）与设备 B（adopt）。 */
async function setupDevices(root) {
  const bare = join(root, 'bare.git')
  mkdirSync(bare, { recursive: true })
  git(bare, ['init', '-q', '--bare'])
  const dev = {}
  for (const n of ['A', 'B']) {
    const cwd = join(root, `work${n}`)
    mkdirSync(cwd, { recursive: true })
    git(cwd, ['init', '-q', '-b', 'main'])
    git(cwd, ['remote', 'add', 'origin', 'https://example.com/acme/alpha.git'])
    const identity = resolveProjectId(cwd)
    dev[n] = { cwd, memoryDir: join(root, `mem${n}`), identity, dir: join(root, `mem${n}`, 'projects', identity.id) }
  }
  const A = dev.A
  const B = dev.B
  const boot = await ensureMemoryRepo({ dir: A.dir, memoryDir: A.memoryDir, cwd: A.cwd, projectId: A.identity.id, displayName: A.identity.displayName, remoteUrl: A.identity.remoteUrl, remoteBranch: RB })
  assert.equal(boot.ok, true)
  writeFileSync(join(A.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] 共同祖先内容']))
  git(A.dir, ['add', '-f', '--', 'KEY.md'])
  git(A.dir, ['commit', '-q', '-m', 'memory: initial'])
  git(A.dir, ['push', '-q', bare, `main:${RB}`])
  git(A.dir, ['remote', 'set-url', 'origin', bare])
  const connect = await deviceBConnect({ dir: B.dir, remoteUrl: bare, remoteBranch: RB, expectedProjectId: A.identity.id })
  assert.equal(connect.mode, 'adopt')
  return { bare, ...dev }
}

/** A 改同一条并 push；B 本地改同一条（未提交）→ B sync 产生冲突。 */
async function makeConflict(root, dev) {
  const { bare } = dev
  writeFileSync(join(dev.A.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] A 的版本']))
  git(dev.A.dir, ['add', '-f', '--', 'KEY.md'])
  git(dev.A.dir, ['commit', '-q', '-m', 'memory: A edit'])
  git(dev.A.dir, ['push', '-q', bare, `main:${RB}`])
  writeFileSync(join(dev.B.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] B 的版本']))
  const r = await runSync({ dir: dev.B.dir, remoteBranch: RB })
  assert.equal(r.ok, true)
  assert.equal(r.conflicts, 1)
}

/* ---------------- parseConflicts ---------------- */

test('parseConflicts：解析 CONFLICTS.md 稳定编号与三版本', () => {
  const text = `# 记忆同步冲突

## 1. aaaa0000（文件：KEY.md）
- 原因：内容双侧不同
- base：[id:aaaa0000] [2026-08-10] 旧
- ours：[id:aaaa0000] [2026-08-10] 本机
- theirs：[id:aaaa0000] [2026-08-10] 远端

## 2. bbbb0001（文件：logs/2026-08-10.md）
- 原因：一侧修改一侧删除
- base：无
- ours：（无）
- theirs：（无）
`
  const list = parseConflicts(text)
  assert.equal(list.length, 2)
  assert.equal(list[0].index, 1)
  assert.equal(list[0].entryKey, 'aaaa0000')
  assert.equal(list[0].file, 'KEY.md')
  assert.match(list[0].reason, /内容双侧不同/)
  assert.equal(list[1].index, 2)
})

/* ---------------- resolve 全流程 ---------------- */

test('resolve ours：采用本地版本，CONFLICTS.md 清空删除，提交生效', { skip }, async () => {
  const root = tempDir()
  try {
    const dev = await setupDevices(root)
    await makeConflict(root, dev)
    assert.equal(countConflicts(dev.B.dir), 1)
    const r = await resolveConflict({ dir: dev.B.dir, index: 1, choice: 'ours' })
    assert.equal(r.ok, true)
    assert.equal(r.remaining, 0)
    // KEY.md 含 B 版本
    const key = readFileSync(join(dev.B.dir, 'KEY.md'), 'utf8')
    assert.ok(key.includes('B 的版本'))
    assert.ok(!key.includes('A 的版本'))
    // CONFLICTS.md 已删除；冲突计数 0
    assert.ok(!existsSync(join(dev.B.dir, 'CONFLICTS.md')))
    assert.equal(countConflicts(dev.B.dir), 0)
    // 提交生效（HEAD 有新提交）
    const log = git(dev.B.dir, ['log', '--oneline', '-1'])
    assert.match(log, /resolve conflict/)
  } finally {
    clean(root)
  }
})

test('resolve theirs：采用远端版本', { skip }, async () => {
  const root = tempDir()
  try {
    const dev = await setupDevices(root)
    await makeConflict(root, dev)
    const r = await resolveConflict({ dir: dev.B.dir, index: 1, choice: 'theirs' })
    assert.equal(r.ok, true)
    const key = readFileSync(join(dev.B.dir, 'KEY.md'), 'utf8')
    assert.ok(key.includes('A 的版本'))
    assert.ok(!key.includes('B 的版本'))
    assert.equal(countConflicts(dev.B.dir), 0)
  } finally {
    clean(root)
  }
})

test('resolve both：两个版本都要（theirs 换新 ID 并存）', { skip }, async () => {
  const root = tempDir()
  try {
    const dev = await setupDevices(root)
    await makeConflict(root, dev)
    const r = await resolveConflict({ dir: dev.B.dir, index: 1, choice: 'both' })
    assert.equal(r.ok, true)
    const key = readFileSync(join(dev.B.dir, 'KEY.md'), 'utf8')
    assert.ok(key.includes('B 的版本') && key.includes('A 的版本'), '两版并存')
    // 两条 ID 不同（联合索引唯一性）
    const ids = [...key.matchAll(/\[id:([0-9a-f]{8})\]/g)].map((m) => m[1])
    assert.equal(ids.length, 2)
    assert.notEqual(ids[0], ids[1])
  } finally {
    clean(root)
  }
})

test('resolve：编号不存在 / 非法 choice 报错', { skip }, async () => {
  const root = tempDir()
  try {
    const dev = await setupDevices(root)
    await makeConflict(root, dev)
    const bad = await resolveConflict({ dir: dev.B.dir, index: 99, choice: 'ours' })
    assert.equal(bad.ok, false)
    assert.match(bad.message, /不存在/)
    const badChoice = await resolveConflict({ dir: dev.B.dir, index: 1, choice: 'merge' })
    assert.equal(badChoice.ok, false)
    assert.match(badChoice.message, /用法/)
    // 无冲突时
    const none = await resolveConflict({ dir: dev.A.dir, index: 1, choice: 'ours' })
    assert.equal(none.ok, false)
    assert.match(none.message, /没有待处理/)
  } finally {
    clean(root)
  }
})
