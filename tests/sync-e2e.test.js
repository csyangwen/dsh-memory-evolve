/**
 * tests/sync-e2e.test.js — 双设备端到端集成测试（施工图 §7 第 8 步验收，一期交付）
 *
 * 裸仓库做远端，全链路场景：
 *   1. A 初始化→push；B 接入→sync 拿到全部；双向 sync 并集；
 *      A replace → B 采用；A/B 改同一条 → conflict → resolve；
 *      解决后 A 再 sync 拿到一致版本。
 *   2. A 归档（KEY → KEY-archive）→ B sync 归档生效。
 *   3. 断电式中断：worker 被杀后锁残留 → 重新 sync 立即可恢复（pid 存活
 *      检测清除 stale 锁），状态一致无损坏。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { ensureMemoryRepo, deviceBConnect } from '../lib/sync/repo.js'
import { resolveProjectId } from '../lib/sync/identity.js'
import { runSync, resolveConflict, countConflicts } from '../lib/sync/worker.js'

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
  return mkdtempSync(join(tmpdir(), 'dsh-sync-e2e-'))
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
const RB = 'dsh-shared/memory'
const KEY = (lines) => lines.join('\n§\n') + '\n'

/** 搭双设备（A bootstrap+push 初始记忆；B adopt）。 */
async function setupE2E(root, initialKey = ['[id:aaaa0000] [2026-08-10] 初始条目']) {
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
  writeFileSync(join(A.dir, 'KEY.md'), KEY(initialKey))
  git(A.dir, ['add', '-f', '--', 'KEY.md'])
  git(A.dir, ['commit', '-q', '-m', 'memory: initial'])
  git(A.dir, ['push', '-q', bare, `main:${RB}`])
  git(A.dir, ['remote', 'set-url', 'origin', bare])
  const connect = await deviceBConnect({ dir: B.dir, remoteUrl: bare, remoteBranch: RB, expectedProjectId: A.identity.id })
  assert.equal(connect.mode, 'adopt')
  return { bare, dev }
}

/** A 提交+推送一条 KEY 修改。 */
function aCommitPush(dev, bare, keyLines, msg) {
  writeFileSync(join(dev.A.dir, 'KEY.md'), KEY(keyLines))
  git(dev.A.dir, ['add', '-f', '--', 'KEY.md'])
  git(dev.A.dir, ['commit', '-q', '-m', msg])
  git(dev.A.dir, ['push', '-q', bare, `main:${RB}`])
}

/* ---------------- 全链路 ---------------- */

test('全链路：接入→并集→单侧修改→冲突→resolve→收敛一致', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, dev } = await setupE2E(root)

    // ── 1. B 接入后首次 sync：拿到全部（本地空 + 远端全量 = 并集）──
    const r1 = await runSync({ dir: dev.B.dir, remoteBranch: RB })
    assert.equal(r1.ok, true)
    assert.ok(readFileSync(join(dev.B.dir, 'KEY.md'), 'utf8').includes('初始条目'))

    // ── 2. A/B 各自写 → 双向 sync 并集 ──
    aCommitPush(dev, bare, ['[id:aaaa0000] [2026-08-10] 初始条目', '[id:aaaa0001] [2026-08-10] A 新增'], 'memory: A add')
    writeFileSync(join(dev.B.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] 初始条目', '[id:bbbb0000] [2026-08-10] B 新增']))
    const r2 = await runSync({ dir: dev.B.dir, remoteBranch: RB, push: true })
    assert.equal(r2.ok, true)
    let bKey = readFileSync(join(dev.B.dir, 'KEY.md'), 'utf8')
    assert.ok(bKey.includes('A 新增') && bKey.includes('B 新增'), 'B 应拿到并集')
    const r2a = await runSync({ dir: dev.A.dir, remoteBranch: RB })
    assert.equal(r2a.ok, true)
    assert.ok(readFileSync(join(dev.A.dir, 'KEY.md'), 'utf8').includes('B 新增'), 'A 应拿到 B 新增')

    // ── 3. A replace 一条 → B sync 采用 ──
    aCommitPush(dev, bare, ['[id:aaaa0000] [2026-08-10] A 修改后的条目', '[id:aaaa0001] [2026-08-10] A 新增', '[id:bbbb0000] [2026-08-10] B 新增'], 'memory: A replace')
    const r3 = await runSync({ dir: dev.B.dir, remoteBranch: RB })
    assert.equal(r3.ok, true)
    bKey = readFileSync(join(dev.B.dir, 'KEY.md'), 'utf8')
    assert.ok(bKey.includes('A 修改后的条目'), 'B 应采纳 A 的单侧修改')
    assert.ok(!bKey.includes('初始条目'), '旧内容应被替换')

    // ── 4. A/B 改同一条 → conflict → resolve → 收敛一致 ──
    aCommitPush(dev, bare, ['[id:aaaa0000] [2026-08-10] A 的冲突版本', '[id:aaaa0001] [2026-08-10] A 新增', '[id:bbbb0000] [2026-08-10] B 新增'], 'memory: A conflict')
    writeFileSync(join(dev.B.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] B 的冲突版本', '[id:aaaa0001] [2026-08-10] A 新增', '[id:bbbb0000] [2026-08-10] B 新增']))
    const r4 = await runSync({ dir: dev.B.dir, remoteBranch: RB })
    assert.equal(r4.ok, true)
    assert.equal(r4.conflicts, 1)
    assert.equal(countConflicts(dev.B.dir), 1)
    assert.ok(!readFileSync(join(dev.B.dir, 'KEY.md'), 'utf8').includes('冲突版本'), '冲突条目不落盘')
    // resolve ours（B 版本）
    const res = await resolveConflict({ dir: dev.B.dir, index: 1, choice: 'ours' })
    assert.equal(res.ok, true)
    bKey = readFileSync(join(dev.B.dir, 'KEY.md'), 'utf8')
    assert.ok(bKey.includes('B 的冲突版本'))
    assert.equal(countConflicts(dev.B.dir), 0)
    // B 推送解决结果 → A 收敛一致
    git(dev.B.dir, ['push', '-q', bare, `main:${RB}`])
    const r4a = await runSync({ dir: dev.A.dir, remoteBranch: RB })
    assert.equal(r4a.ok, true)
    const aKey = readFileSync(join(dev.A.dir, 'KEY.md'), 'utf8')
    assert.ok(aKey.includes('B 的冲突版本'), 'A 应拿到 resolve 后的版本')
    assert.equal(countConflicts(dev.A.dir), 0)
    // 两边最终一致（条目集合相同；逐条 trim 抹平行尾差异）
    const norm = (text) => text.split('\n§\n').map((e) => e.trim()).filter((e) => e !== '').sort()
    const aEntries = norm(readFileSync(join(dev.A.dir, 'KEY.md'), 'utf8'))
    const bEntries = norm(readFileSync(join(dev.B.dir, 'KEY.md'), 'utf8'))
    assert.deepEqual(aEntries, bEntries, '双设备记忆应完全一致')
  } finally {
    clean(root)
  }
})

/* ---------------- 归档 ---------------- */

test('归档生效：A 归档 KEY → KEY-archive，B sync 后归档同步', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, dev } = await setupE2E(root)
    const r1 = await runSync({ dir: dev.B.dir, remoteBranch: RB })
    assert.equal(r1.ok, true)
    // A 归档：KEY.md 移除该条 + KEY-archive.md 追加
    writeFileSync(join(dev.A.dir, 'KEY.md'), '') // 清空（唯一条目被归档）
    writeFileSync(join(dev.A.dir, 'KEY-archive.md'), '[id:aaaa0000] [2026-08-10] 初始条目\n')
    git(dev.A.dir, ['add', '-f', '--', 'KEY.md', 'KEY-archive.md'])
    git(dev.A.dir, ['commit', '-q', '-m', 'memory: archive'])
    git(dev.A.dir, ['push', '-q', bare, `main:${RB}`])
    const r2 = await runSync({ dir: dev.B.dir, remoteBranch: RB })
    assert.equal(r2.ok, true)
    const bKey = readFileSync(join(dev.B.dir, 'KEY.md'), 'utf8')
    const bArchive = readFileSync(join(dev.B.dir, 'KEY-archive.md'), 'utf8')
    assert.ok(!bKey.includes('初始条目'), 'B 的 KEY.md 应移除已归档条目')
    assert.ok(bArchive.includes('初始条目'), 'B 的 KEY-archive.md 应有归档条目')
    assert.equal(countConflicts(dev.B.dir), 0)
  } finally {
    clean(root)
  }
})

/* ---------------- 断电中断恢复 ---------------- */

test('中断恢复：worker 被杀残留锁 → 重新 sync 立即可用（pid 存活检测）', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, dev } = await setupE2E(root)
    // A 推送新提交，B 有本地修改（sync 有真实工作）
    aCommitPush(dev, bare, ['[id:aaaa0000] [2026-08-10] 初始条目', '[id:aaaa0001] [2026-08-10] 远端新条目'], 'memory: A more')
    writeFileSync(join(dev.B.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] 初始条目', '[id:bbbb0000] [2026-08-10] B 本地']))

    // 真实中断冒烟：spawn worker 执行 sync，50ms 后 SIGKILL（模拟断电）
    const script = join(process.cwd(), 'scripts', 'sync-worker.mjs')
    const child = spawn(process.execPath, [script, 'sync', dev.B.dir, RB], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 50))
    child.kill('SIGKILL')
    await new Promise((r) => child.on('close', r))

    // 重新 sync：必须成功（锁残留被 pid 存活检测立即清除；合并幂等）
    const retry = await runSync({ dir: dev.B.dir, remoteBranch: RB })
    assert.equal(retry.ok, true, `中断后重试应成功：${retry.message}`)
    const bKey = readFileSync(join(dev.B.dir, 'KEY.md'), 'utf8')
    assert.ok(bKey.includes('远端新条目') && bKey.includes('B 本地'), '数据应完整（并集）')
    assert.ok(!existsSync(join(dev.B.dir, '.memory.lock')), '锁不应残留')
    // git index 从未 unmerged
    const unmerged = git(dev.B.dir, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })
    assert.equal(unmerged, '', 'index 不应有 unmerged 条目')
  } finally {
    clean(root)
  }
})

test('中断恢复：模拟断电残留锁（已死 pid）→ 立即可恢复，不等待 stale 超时', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, dev } = await setupE2E(root)
    const r1 = await runSync({ dir: dev.B.dir, remoteBranch: RB })
    assert.equal(r1.ok, true)
    // 手工写一个"已死 pid"的残留锁（模拟断电瞬间）
    writeFileSync(join(dev.B.dir, '.memory.lock'), JSON.stringify({ pid: 999999999, at: Date.now() }))
    const start = Date.now()
    const r2 = await runSync({ dir: dev.B.dir, remoteBranch: RB })
    const elapsed = Date.now() - start
    assert.equal(r2.ok, true)
    assert.ok(elapsed < 3000, `残留锁应被 pid 检测立即清除（实际 ${elapsed}ms，不应等 10s stale）`)
    assert.ok(!existsSync(join(dev.B.dir, '.memory.lock')))
  } finally {
    clean(root)
  }
})
