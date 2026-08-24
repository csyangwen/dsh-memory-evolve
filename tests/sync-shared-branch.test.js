/**
 * tests/sync-shared-branch.test.js — 模式 B 共享记忆仓库测试（2026-08-11 拍板）
 *
 * 需求背景：用户只建**一个**私有记忆仓库，所有项目的记忆都放里面（不
 * 可能每项目一个仓库）。实现=共享仓库 + 每项目专属分支 dsh-shared/<id>，
 * 协议零改动（remoteBranch 早已参数化）；老单项目仓库（main 分支）自动
 * 识别兼容。
 *
 * 覆盖：
 *   - sharedBranchFor / 命名空间常量；
 *   - decideModeBBranch 判定树：空仓库 fresh / 已有共享分支 shared /
 *     main 属于本项目 legacy（老单项目仓库兼容）/ main 属于别人
 *     shared-fresh（串项目防护）/ main 无 PROVENANCE shared-fresh（保守）/
 *     远端不存在 error（不自动初始化）；
 *   - e2e（handleCommand 全链路）：新共享仓库双设备认亲；老单项目仓库
 *     零迁移兼容；共享仓库串项目防护（别人的 main 不被碰）。
 *
 * 测试技巧与既有先例一致：身份用 https 假 URL（identity），传输通道用
 * 本地裸仓库（记忆仓库 origin set-url / 直传 URL）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { MODE_A_BRANCH, SHARED_BRANCH_PREFIX, decideModeBBranch, sharedBranchFor } from '../lib/sync/repo.js'
import { handleCommand, projectSyncInfo } from '../lib/sync/index.js'
import { resolveProjectId } from '../lib/sync/identity.js'

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
  return mkdtempSync(join(tmpdir(), 'dsh-shared-branch-'))
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

/** 统一身份 URL（双设备同 URL = 同一项目身份）。 */
const IDENTITY_URL = 'https://example.com/acme/alpha.git'

/** 建一个带假 remote 身份的工作目录，返回 resolveProjectId。 */
function identityFor(cwd) {
  mkdirSync(cwd, { recursive: true })
  git(cwd, ['init', '-q', '-b', 'main'])
  git(cwd, ['remote', 'add', 'origin', IDENTITY_URL])
  return resolveProjectId(cwd)
}

/** 建裸仓库（共享记忆仓库的传输通道）。 */
function makeBare(root, name = 'bare.git') {
  const bare = join(root, name)
  mkdirSync(bare, { recursive: true })
  git(bare, ['init', '-q', '--bare'])
  return bare
}

/** 往裸仓库推一个带 PROVENANCE 的分支（模拟远端已有记忆：老单项目 main
 *  或共享仓库里其他项目的分支）。 */
function seedBranch(bare, branch, projectId, displayName = 'seed') {
  const seed = mkdtempSync(join(tmpdir(), 'dsh-sync-seed-'))
  try {
    git(seed, ['init', '-q', '-b', 'main'])
    const prov = `${JSON.stringify({ projectId, displayName, version: 1, remoteBranch: branch, enabled: true, tracks: { project: true } })}\n`
    writeFileSync(join(seed, 'PROVENANCE'), prov)
    git(seed, ['add', '-f', '--', 'PROVENANCE'])
    git(seed, ['commit', '-q', '-m', 'seed'])
    git(seed, ['push', '-q', bare, `main:${branch}`])
  } finally {
    clean(seed)
  }
}

/** 往裸仓库推一个**无 PROVENANCE** 的 main（仓库默认分支/其他用途）。 */
function seedPlainMain(bare) {
  const seed = mkdtempSync(join(tmpdir(), 'dsh-sync-seed-'))
  try {
    git(seed, ['init', '-q', '-b', 'main'])
    writeFileSync(join(seed, 'README.md'), 'default branch\n')
    git(seed, ['add', '--', 'README.md'])
    git(seed, ['commit', '-q', '-m', 'init'])
    git(seed, ['push', '-q', bare, 'main:main'])
  } finally {
    clean(seed)
  }
}

/** mock 运行时（getRuntime/applyRuntimePatch）。 */
function mockRuntime(syncEnabled) {
  const state = { syncEnabled }
  const patches = []
  return {
    getRuntime: () => ({ ...state }),
    applyRuntimePatch: (patch) => { Object.assign(state, patch); patches.push(patch) },
    patches,
  }
}

/* ---------------- 命名空间 ---------------- */

test('sharedBranchFor：专属分支命名 dsh-shared/<projectId>（区别于模式 A 固定分支）', { skip }, () => {
  assert.equal(SHARED_BRANCH_PREFIX, 'dsh-shared/')
  assert.equal(MODE_A_BRANCH, 'dsh-shared/memory')
  assert.equal(sharedBranchFor('ab12cd34ef56'), 'dsh-shared/ab12cd34ef56')
  // 项目 id 是 12 hex，与模式 A 的 memory 名绝不撞车
  assert.notEqual(sharedBranchFor('ab12cd34ef56'), MODE_A_BRANCH)
})

/* ---------------- decideModeBBranch 判定树 ---------------- */

test('decideModeBBranch：空共享仓库 → fresh，用专属分支', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = makeBare(root)
    const identity = identityFor(join(root, 'work'))
    const dir = join(root, 'mem', 'projects', identity.id)
    const r = await decideModeBBranch({ dir, remoteUrl: bare, projectId: identity.id })
    assert.equal(r.ok, true)
    assert.equal(r.kind, 'fresh')
    assert.equal(r.branch, `dsh-shared/${identity.id}`)
  } finally {
    clean(root)
  }
})

test('decideModeBBranch：共享仓库已有本项目分支 → shared 续接', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = makeBare(root)
    const identity = identityFor(join(root, 'work'))
    seedBranch(bare, `dsh-shared/${identity.id}`, identity.id, 'alpha')
    const dir = join(root, 'mem', 'projects', identity.id)
    const r = await decideModeBBranch({ dir, remoteUrl: bare, projectId: identity.id })
    assert.equal(r.ok, true)
    assert.equal(r.kind, 'shared')
    assert.equal(r.branch, `dsh-shared/${identity.id}`)
  } finally {
    clean(root)
  }
})

test('decideModeBBranch：main 属于本项目（老单项目仓库）→ legacy 继续用 main', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = makeBare(root)
    const identity = identityFor(join(root, 'work'))
    seedBranch(bare, 'main', identity.id, 'alpha')
    const dir = join(root, 'mem', 'projects', identity.id)
    const r = await decideModeBBranch({ dir, remoteUrl: bare, projectId: identity.id })
    assert.equal(r.ok, true)
    assert.equal(r.kind, 'legacy-main')
    assert.equal(r.branch, 'main')
  } finally {
    clean(root)
  }
})

test('decideModeBBranch：main 属于其他项目（共享仓库已有别家）→ shared-fresh，绝不碰 main', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = makeBare(root)
    const identity = identityFor(join(root, 'work'))
    seedBranch(bare, 'main', 'ffffffffffff', 'beta')
    const dir = join(root, 'mem', 'projects', identity.id)
    const r = await decideModeBBranch({ dir, remoteUrl: bare, projectId: identity.id })
    assert.equal(r.ok, true)
    assert.equal(r.kind, 'fresh')
    assert.equal(r.branch, `dsh-shared/${identity.id}`)
    // 决策过程只读 main（fetch 后清理），不产生任何分支改动
    const heads = git(bare, ['for-each-ref', '--format=%(refname)', 'refs/heads'])
    assert.ok(heads.split('\n').includes('refs/heads/main'))
    assert.ok(!heads.includes(`refs/heads/dsh-shared/${identity.id}`), '决策不应创建任何远端分支')
  } finally {
    clean(root)
  }
})

test('decideModeBBranch：main 存在但无 PROVENANCE（归属不明）→ 保守专属分支', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = makeBare(root)
    const identity = identityFor(join(root, 'work'))
    seedPlainMain(bare)
    const dir = join(root, 'mem', 'projects', identity.id)
    const r = await decideModeBBranch({ dir, remoteUrl: bare, projectId: identity.id })
    assert.equal(r.ok, true)
    assert.equal(r.kind, 'fresh')
    assert.equal(r.branch, `dsh-shared/${identity.id}`)
    assert.match(r.message, /无法确认归属|专属分支/)
  } finally {
    clean(root)
  }
})

test('decideModeBBranch：远端仓库不存在 → error（分类报错，不自动初始化）', { skip }, async () => {
  const root = tempDir()
  try {
    const identity = identityFor(join(root, 'work'))
    const dir = join(root, 'mem', 'projects', identity.id)
    const r = await decideModeBBranch({ dir, remoteUrl: join(root, 'no-such.git'), projectId: identity.id })
    assert.equal(r.ok, false)
    assert.equal(r.kind, 'error')
    assert.equal(r.branch, null)
    assert.match(r.message, /不存在|无法连接/)
  } finally {
    clean(root)
  }
})

/* ---------------- e2e：全链路 ---------------- */

test('e2e：新共享记忆仓库双设备——A 初始化走专属分支，B 认亲接入', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = makeBare(root)
    // 设备 A：setup 指定共享仓库（统一模式）→ fresh → 专属分支 + 模块开关自动开
    const cwdA = join(root, 'workA')
    const identityA = identityFor(cwdA)
    const memA = join(root, 'memA')
    const rtA = mockRuntime(false)
    const setupA = await handleCommand('setup', [bare], cwdA, { config: { memoryDir: memA }, ...rtA })
    assert.equal(setupA.kind, 'success')
    assert.match(setupA.text, /记忆同步初始化完成/)
    assert.ok(rtA.patches.some((p) => p.syncEnabled === true), 'setup = 明确启用意图 → 自动开模块开关')
    const infoA = projectSyncInfo({ memoryDir: memA }, cwdA)
    assert.equal(infoA.remoteBranch, `dsh-shared/${identityA.id}`)
    // A 写一条记忆并推送（--push = 用户显式同意）
    writeFileSync(join(infoA.dir, 'KEY.md'), '[id:aaaa0000] [2026-08-11] 共享仓库首条\n')
    const syncA = await handleCommand('sync', ['--push'], cwdA, { config: { memoryDir: memA }, ...rtA })
    assert.equal(syncA.kind, 'success')
    // 远端只出现专属分支，main 不存在
    const headsA = git(bare, ['for-each-ref', '--format=%(refname)', 'refs/heads'])
    assert.ok(headsA.includes(`refs/heads/dsh-shared/${identityA.id}`))
    assert.ok(!headsA.includes('refs/heads/main'))
    // 设备 B：同身份 URL → 同一项目 id → setup 走 shared 认亲接入
    const cwdB = join(root, 'workB')
    const identityB = identityFor(cwdB)
    assert.equal(identityB.id, identityA.id)
    const memB = join(root, 'memB')
    const rtB = mockRuntime(false)
    const setupB = await handleCommand('setup', [bare], cwdB, { config: { memoryDir: memB }, ...rtB })
    assert.equal(setupB.kind, 'success')
    assert.match(setupB.text, /已接入远端记忆/)
    assert.ok(rtB.patches.some((p) => p.syncEnabled === true))
    const infoB = projectSyncInfo({ memoryDir: memB }, cwdB)
    assert.equal(infoB.remoteBranch, `dsh-shared/${identityB.id}`)
    // B 同步拿到记忆
    const syncB = await handleCommand('sync', [], cwdB, { config: { memoryDir: memB }, ...rtB })
    assert.equal(syncB.kind, 'success')
    assert.ok(readFileSync(join(infoB.dir, 'KEY.md'), 'utf8').includes('共享仓库首条'))
  } finally {
    clean(root)
  }
})

test('e2e：老单项目仓库（main 分支）零迁移兼容——双设备继续用 main', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = makeBare(root)
    const cwdA = join(root, 'workA')
    const identityA = identityFor(cwdA)
    seedBranch(bare, 'main', identityA.id, 'alpha') // 老单项目仓库：main 属于本项目
    const memA = join(root, 'memA')
    const rtA = mockRuntime(false)
    const setupA = await handleCommand('setup', [bare], cwdA, { config: { memoryDir: memA }, ...rtA })
    assert.equal(setupA.kind, 'success')
    assert.match(setupA.text, /main/) // legacy：继续用 main，零迁移
    const infoA = projectSyncInfo({ memoryDir: memA }, cwdA)
    assert.equal(infoA.remoteBranch, 'main')
    // 设备 B 同样
    const cwdB = join(root, 'workB')
    const identityB = identityFor(cwdB)
    assert.equal(identityB.id, identityA.id)
    const memB = join(root, 'memB')
    const rtB = mockRuntime(false)
    const setupB = await handleCommand('setup', [bare], cwdB, { config: { memoryDir: memB }, ...rtB })
    assert.equal(setupB.kind, 'success')
    assert.match(setupB.text, /已接入/)
    const infoB = projectSyncInfo({ memoryDir: memB }, cwdB)
    assert.equal(infoB.remoteBranch, 'main')
  } finally {
    clean(root)
  }
})

test('e2e：共享仓库串项目防护——main 是别人的，本项目独立分支互不干扰', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = makeBare(root)
    // 共享仓库已有 B 项目（老单项目形态：记忆在 main）
    const betaId = 'ffffffffffff'
    seedBranch(bare, 'main', betaId, 'beta')
    const mainBefore = git(bare, ['rev-parse', 'refs/heads/main'])
    // A 项目 setup：决策 shared-fresh → 专属分支，绝不触碰 main
    const cwdA = join(root, 'workA')
    const identityA = identityFor(cwdA)
    const memA = join(root, 'memA')
    const rtA = mockRuntime(false)
    const setupA = await handleCommand('setup', [bare], cwdA, { config: { memoryDir: memA }, ...rtA })
    assert.equal(setupA.kind, 'success')
    const infoA = projectSyncInfo({ memoryDir: memA }, cwdA)
    assert.equal(infoA.remoteBranch, `dsh-shared/${identityA.id}`)
    // A 推送自己的记忆后，main 仍原封不动
    writeFileSync(join(infoA.dir, 'KEY.md'), '[id:cccc0000] [2026-08-11] A 的记忆\n')
    const syncA = await handleCommand('sync', ['--push'], cwdA, { config: { memoryDir: memA }, ...rtA })
    assert.equal(syncA.kind, 'success')
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), mainBefore, 'main 不应被 A 项目触碰')
    const heads = git(bare, ['for-each-ref', '--format=%(refname)', 'refs/heads'])
    assert.ok(heads.includes(`refs/heads/dsh-shared/${identityA.id}`))
  } finally {
    clean(root)
  }
})
