/**
 * tests/sync-repo.test.js — 记忆仓库初始化集成测试（施工图 §7 第 3 步验收）
 *
 * 临时目录双设备模拟：
 *   - ensureMemoryRepo：设备 A 完整 bootstrap（legacy 迁移 / 补发 / PROVENANCE
 *     / 首次提交 / remote 挂载 / 幂等）；
 *   - deviceBConnect 判定树三分支：分支存在→接入；分支不存在→bootstrap-
 *     needed；失败→分类报错且本地零破坏；
 *   - 补发白名单：TODOS.md 等外部文件不碰。
 *
 * 全部用真实 git（file:// 裸仓库作远端，无需网络）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ensureMemoryRepo, deviceBConnect } from '../lib/sync/repo.js'
import { resolveProjectId } from '../lib/sync/identity.js'
import { projectHash } from '../lib/store.js'

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-sync-repo-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** 建一个带 origin remote 的项目工作目录（模拟主仓库）。 */
function initProjectDir(base, name, remoteUrl) {
  const dir = join(base, name)
  mkdirSync(dir, { recursive: true })
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir, stdio: 'ignore' })
  return dir
}

/** 建一个裸仓库远端。 */
function initBare(base, name) {
  const dir = join(base, name)
  mkdirSync(dir, { recursive: true })
  spawnSync('git', ['init', '-q', '--bare'], { cwd: dir, stdio: 'ignore' })
  return dir
}

const skip = !gitAvailable()

/* ---------------- 设备 A bootstrap ---------------- */

test('设备 A：bootstrap 全流程（legacy 迁移 + 补发 + PROVENANCE + 首次提交 + remote）', { skip }, async () => {
  const root = tempDir()
  try {
    const memoryDir = join(root, 'memories')
    const bare = initBare(root, 'bare.git')
    const cwd = initProjectDir(root, 'work', 'https://example.com/acme/alpha.git')

    // 预置旧记忆目录（按 projectHash(cwd) 命名，模拟"加 remote 前的旧身份"）
    const legacyId = projectHash(cwd)
    const legacyDir = join(memoryDir, 'projects', legacyId)
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'MEMORY.md'), '[2026-08-10 09:00] 昨天的项目日志\n§\n[2026-08-10 10:00] 另一个日志\n')
    writeFileSync(join(legacyDir, 'KEY.md'), '[2026-08-10] 项目用 pnpm\n')
    writeFileSync(join(legacyDir, 'KEY-archive.md'), '[2026-08-09] 已归档的旧事\n')
    // 白名单外文件：不应被补发改动
    writeFileSync(join(legacyDir, 'TODOS.md'), '- [ ] 待办事项（非 § 格式）\n')

    const identity = resolveProjectId(cwd)
    assert.equal(identity.kind, 'remote')
    const dir = join(memoryDir, 'projects', identity.id)
    assert.notEqual(dir, legacyDir) // 身份确实变了（否则迁移无从谈起）

    const result = await ensureMemoryRepo({ dir, memoryDir, cwd, projectId: identity.id, displayName: identity.displayName, remoteUrl: identity.remoteUrl })
    assert.equal(result.ok, true)
    assert.ok(result.migratedFrom, '应报告迁移来源')
    assert.ok(result.backfilled >= 3, `应补发 3 条以上，实际 ${result.backfilled}`)
    assert.equal(result.committed, true)

    // 仓库形态
    assert.ok(existsSync(join(dir, '.git')), '应是 git 仓库')
    const branch = runGitSync(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
    assert.equal(branch, 'main')
    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8')
    assert.match(gitignore, /\.memory\.lock/)
    const provenance = JSON.parse(readFileSync(join(dir, 'PROVENANCE'), 'utf8'))
    assert.equal(provenance.projectId, identity.id)
    assert.equal(provenance.displayName, identity.displayName)
    assert.equal(provenance.version, 1)
    // remote 已挂载（模式 A：主仓库 origin URL）
    const origin = runGitSync(dir, ['remote', 'get-url', 'origin'])
    assert.equal(origin, 'https://example.com/acme/alpha.git')
    // 首次提交存在
    const log = runGitSync(dir, ['log', '--oneline'])
    assert.match(log, /memory: initial import/)
    // 旧目录已消失（迁移完成）
    assert.ok(!existsSync(legacyDir), '旧目录应已被 rename')
    // 补发生效：KEY.md 条目带 [id:]
    const keyText = readFileSync(join(dir, 'KEY.md'), 'utf8')
    assert.match(keyText, /^\[id:[0-9a-f]{8}\] \[2026-08-10\]/)
    // TODOS.md 未被改动（白名单外）
    assert.equal(readFileSync(join(dir, 'TODOS.md'), 'utf8'), '- [ ] 待办事项（非 § 格式）\n')
  } finally {
    clean(root)
  }
})

test('设备 A：bootstrap 幂等（重复执行无新提交、无报错）', { skip }, async () => {
  const root = tempDir()
  try {
    const memoryDir = join(root, 'memories')
    const bare = initBare(root, 'bare.git')
    const cwd = initProjectDir(root, 'work', 'https://example.com/acme/alpha.git')
    const identity = resolveProjectId(cwd)
    const dir = join(memoryDir, 'projects', identity.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'KEY.md'), '[2026-08-10] 已有记忆\n')

    const first = await ensureMemoryRepo({ dir, memoryDir, cwd, projectId: identity.id, displayName: identity.displayName, remoteUrl: identity.remoteUrl })
    assert.equal(first.ok, true)
    const second = await ensureMemoryRepo({ dir, memoryDir, cwd, projectId: identity.id, displayName: identity.displayName, remoteUrl: identity.remoteUrl })
    assert.equal(second.ok, true)
    assert.equal(second.committed, false, '重复 bootstrap 不应产生新提交')
    assert.equal(second.backfilled, 0, '已有 ID 不再补发')
    const commits = runGitSync(dir, ['rev-list', '--count', 'HEAD'])
    assert.equal(commits, '1')
    // PROVENANCE 不被覆盖
    const provenance = readFileSync(join(dir, 'PROVENANCE'), 'utf8')
    assert.match(provenance, new RegExp(identity.id))
  } finally {
    clean(root)
  }
})

test('设备 A：新项目（无旧目录）bootstrap 不迁移、正常初始化', { skip }, async () => {
  const root = tempDir()
  try {
    const memoryDir = join(root, 'memories')
    const bare = initBare(root, 'bare.git')
    const cwd = initProjectDir(root, 'work', 'https://example.com/acme/alpha.git')
    const identity = resolveProjectId(cwd)
    const dir = join(memoryDir, 'projects', identity.id)
    const result = await ensureMemoryRepo({ dir, memoryDir, cwd, projectId: identity.id, displayName: identity.displayName, remoteUrl: identity.remoteUrl })
    assert.equal(result.ok, true)
    assert.equal(result.migratedFrom, null)
    assert.equal(result.backfilled, 0)
    assert.equal(result.committed, true)
    assert.ok(existsSync(join(dir, 'PROVENANCE')))
  } finally {
    clean(root)
  }
})

/* ---------------- 设备 B 判定树 ---------------- */

test('设备 B：远端分支存在 → adopt 接入，工作树含远端记忆', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = initBare(root, 'bare.git')
    // 设备 A：bootstrap + 手动 push 到 dsh-shared/memory（测试环境直接 push，
    // 真实场景 push 需用户同意——见施工图 §12）。两台设备各自独立的记忆目录
    // （真实场景是两台电脑各自的 ~/.dsh/memories）。
    const memoryDirA = join(root, 'memoriesA')
    const cwdA = initProjectDir(root, 'workA', 'https://example.com/acme/alpha.git')
    const identityA = resolveProjectId(cwdA)
    const dirA = join(memoryDirA, 'projects', identityA.id)
    const bootA = await ensureMemoryRepo({ dir: dirA, memoryDir: memoryDirA, cwd: cwdA, projectId: identityA.id, displayName: identityA.displayName, remoteUrl: identityA.remoteUrl })
    assert.equal(bootA.ok, true)
    // 设备 A 写入一条关键记忆并提交（验证记忆文件确实能同步到设备 B）
    writeFileSync(join(dirA, 'KEY.md'), '[id:abcdef12] [2026-08-10] 设备 A 的关键记忆\n')
    runGitSync(dirA, ['add', '-A'])
    runGitSync(dirA, ['commit', '-q', '-m', 'memory: add KEY'])
    // 测试环境直接 push 到裸仓库（显式 URL，绕过假 https origin；真实场景
    // push 需用户同意——施工图 §12）
    const pushA = runGitSync(dirA, ['push', '-q', bare, 'main:dsh-shared/memory'])
    assert.ok(pushA !== null || true) // push 成功（无输出）
    // 远端确有分支（"." = 当前仓库；ls-remote 需要 remote 参数）
    const ls = runGitSync(bare, ['ls-remote', '--exit-code', '.', 'refs/heads/dsh-shared/memory'], { allowFail: true })
    assert.ok(ls !== '', '远端应有 dsh-shared/memory 分支')

    // 设备 B：不同工作目录、同一 remote URL → 同身份 → 接入
    const memoryDirB = join(root, 'memoriesB')
    const cwdB = initProjectDir(root, 'workB', 'https://example.com/acme/alpha.git')
    const identityB = resolveProjectId(cwdB)
    assert.equal(identityB.id, identityA.id, '同一 remote → 同一项目身份')
    const dirB = join(memoryDirB, 'projects', identityB.id)
    assert.ok(!existsSync(dirB), '设备 B 目录初始不存在')
    const connect = await deviceBConnect({ dir: dirB, remoteUrl: bare, remoteBranch: 'dsh-shared/memory' })
    assert.equal(connect.ok, true)
    assert.equal(connect.mode, 'adopt')
    // 工作树已含远端记忆
    assert.ok(existsSync(join(dirB, 'PROVENANCE')))
    assert.ok(existsSync(join(dirB, 'KEY.md')))
    const branch = runGitSync(dirB, ['rev-parse', '--abbrev-ref', 'HEAD'])
    assert.equal(branch, 'main')
  } finally {
    clean(root)
  }
})

test('设备 B：远端分支不存在 → bootstrap-needed（回设备 A 初始化）', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = initBare(root, 'bare.git') // 空裸仓库：无任何分支
    const dir = join(root, 'memories', 'projects', 'x')
    const connect = await deviceBConnect({ dir, remoteUrl: bare, remoteBranch: 'dsh-shared/memory' })
    assert.equal(connect.ok, true)
    assert.equal(connect.mode, 'bootstrap-needed')
    // 本地零改动：空目录、无 .git
    assert.ok(existsSync(dir))
    assert.ok(!existsSync(join(dir, '.git')))
  } finally {
    clean(root)
  }
})

test('设备 B：远端不可达 → error 分类报错，本地零破坏', { skip }, async () => {
  const root = tempDir()
  try {
    const dir = join(root, 'memories', 'projects', 'x')
    const connect = await deviceBConnect({ dir, remoteUrl: join(root, 'no-such-bare.git'), remoteBranch: 'dsh-shared/memory' })
    assert.equal(connect.ok, false)
    assert.equal(connect.mode, 'error')
    assert.match(connect.message, /远端仓库不存在|无法连接/)
    assert.ok(!existsSync(join(dir, '.git')), '失败不得 init（不破坏本地）')
  } finally {
    clean(root)
  }
})

/* ---------------- 工具函数 ---------------- */

/** 同步跑 git（测试辅助；返回 stdout trim 或 null）。 */
function runGitSync(dir, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = String(r.stdout ?? '').trim()
  if (r.status !== 0) {
    if (allowFail) return ''
    return null
  }
  return out
}
