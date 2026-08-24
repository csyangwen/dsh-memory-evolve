/**
 * tests/sync-global-final.test.js — Codex 二轮终审修复回归测试
 * （P0：凭证泄漏 / 跨轨冲突互删 / fileset 越界；P1：假 dirty 重复提交等）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ensureGlobalRepo } from '../lib/sync/repo.js'
import { handleCommand, installMemorySync } from '../lib/sync/index.js'
import { resolveProjectId } from '../lib/sync/identity.js'
import { runSync, resolveConflict, countConflicts } from '../lib/sync/worker.js'
import { globalBranchFor } from '../lib/sync/filesets.js'

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
  return mkdtempSync(join(tmpdir(), 'dsh-global-final-'))
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

function mockRuntime(syncEnabled) {
  const state = { syncEnabled }
  const patches = []
  return {
    getRuntime: () => ({ ...state }),
    applyRuntimePatch: (patch) => { Object.assign(state, patch); patches.push(patch) },
    patches,
  }
}

/** 建设备（cwd 主仓库身份 + memoryDir）并初始化全局仓库（origin→bare）。 */
async function setupGlobal(root, n, bare) {
  const cwd = join(root, `work${n}`)
  mkdirSync(cwd, { recursive: true })
  git(cwd, ['init', '-q', '-b', 'main'])
  git(cwd, ['remote', 'add', 'origin', 'https://example.com/acme/alpha.git'])
  const identity = resolveProjectId(cwd)
  const memoryDir = join(root, `mem${n}`)
  const init = await ensureGlobalRepo({ dir: memoryDir, url: 'https://example.com/shared-memories.git' })
  assert.equal(init.ok, true)
  git(memoryDir, ['remote', 'set-url', 'origin', bare])
  return { cwd, memoryDir, identity }
}

/* ---------------- P0-1：凭证 URL 不泄漏 ---------------- */

test('凭证 URL 不写入 PROVENANCE（token 不进 git 历史）', { skip }, async () => {
  const root = tempDir()
  try {
    const memoryDir = join(root, 'mem')
    const init = await ensureGlobalRepo({ dir: memoryDir, url: 'https://user:supersecret@example.com/shared.git' })
    assert.equal(init.ok, true)
    const prov = readFileSync(join(memoryDir, 'PROVENANCE'), 'utf8')
    assert.ok(!prov.includes('supersecret'), 'PROVENANCE 不得含凭证')
    assert.ok(prov.includes('example.com/shared.git'), '应存无凭证 URL')
    // 提交历史里也不得出现
    const log = git(memoryDir, ['log', '--all', '-p', '--', 'PROVENANCE'], { allowFail: true })
    assert.ok(!log.includes('supersecret'), 'git 历史不得含凭证')
  } finally {
    clean(root)
  }
})

/* ---------------- P0-2：跨轨冲突不互删 + 有冲突禁 push ---------------- */

test('跨轨冲突隔离：memory 轨冲突不被 user 轨同步删除；冲突未解决禁 push', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = join(root, 'bare.git')
    mkdirSync(bare, { recursive: true })
    git(bare, ['init', '-q', '--bare'])
    const A = await setupGlobal(root, 'A', bare)
    const B = await setupGlobal(root, 'B', bare)
    const rtA = mockRuntime(true)
    const cfgA = { memoryDir: A.memoryDir }
    assert.equal((await handleCommand('global', ['on', 'memory'], A.cwd, { config: cfgA, ...rtA })).kind, 'success')
    assert.equal((await handleCommand('global', ['on', 'user'], A.cwd, { config: cfgA, ...rtA })).kind, 'success')
    writeFileSync(join(A.memoryDir, 'MEMORY.md'), '[id:aaaa0000] [2026-08-11 10:00] 全局事实\n')
    assert.equal((await handleCommand('global', ['sync', '--push'], A.cwd, { config: cfgA, ...rtA })).kind, 'success')
    // B 开 memory 轨拉取后双侧改同一条 → memory 轨冲突
    const rtB = mockRuntime(true)
    const cfgB = { memoryDir: B.memoryDir }
    assert.equal((await handleCommand('global', ['on', 'memory'], B.cwd, { config: cfgB, ...rtB })).kind, 'success')
    assert.equal((await handleCommand('global', ['sync'], B.cwd, { config: cfgB, ...rtB })).kind, 'success')
    writeFileSync(join(A.memoryDir, 'MEMORY.md'), '[id:aaaa0000] [2026-08-11 10:00] A 的版本\n')
    assert.equal((await handleCommand('global', ['sync', '--push'], A.cwd, { config: cfgA, ...rtA })).kind, 'success')
    writeFileSync(join(B.memoryDir, 'MEMORY.md'), '[id:aaaa0000] [2026-08-11 10:00] B 的版本\n')
    const rSync = await runSync({ dir: B.memoryDir, remoteBranch: globalBranchFor('memory-global'), fileset: 'memory-global', localBranch: 'memory-global' })
    assert.equal(rSync.conflicts, 1)
    assert.ok(existsSync(join(B.memoryDir, 'CONFLICTS-memory-global.md')), 'memory 轨侧车存在')
    // user 轨同步不得删除 memory 轨侧车——且 memory 轨有未解决冲突时
    // sync 被正确拦截（不再重新合并覆盖侧车）
    const rtB2 = mockRuntime(true)
    const cfgB2 = { memoryDir: B.memoryDir }
    assert.equal((await handleCommand('global', ['on', 'user'], B.cwd, { config: cfgB2, ...rtB2 })).kind, 'success')
    const gSync = await handleCommand('global', ['sync'], B.cwd, { config: cfgB2, ...rtB2 })
    assert.equal(gSync.kind, 'error', 'memory 轨有未解决冲突 → 聚合失败（不假报成功）')
    assert.match(gSync.text, /冲突未解决/)
    assert.ok(existsSync(join(B.memoryDir, 'CONFLICTS-memory-global.md')), '其他轨同步后 memory 侧车必须还在')
    assert.equal(countConflicts(B.memoryDir, 'memory-global'), 1)
    // 冲突未解决禁止 push
    const rPush = await runSync({ dir: B.memoryDir, remoteBranch: globalBranchFor('memory-global'), fileset: 'memory-global', localBranch: 'memory-global', push: true })
    assert.equal(rPush.ok, false)
    assert.match(rPush.message, /冲突未解决/)
    // 解决后推送成功
    const res = await resolveConflict({ dir: B.memoryDir, index: 1, choice: 'ours', fileset: 'memory-global', localBranch: 'memory-global' })
    assert.equal(res.ok, true)
    const rPush2 = await runSync({ dir: B.memoryDir, remoteBranch: globalBranchFor('memory-global'), fileset: 'memory-global', localBranch: 'memory-global', push: true })
    assert.equal(rPush2.ok, true)
  } finally {
    clean(root)
  }
})

/* ---------------- P0-3：非法 daily 路径不上传 ---------------- */

test('daily/ 下的非法文件（非日期）不被 stage/上传', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = join(root, 'bare.git')
    mkdirSync(bare, { recursive: true })
    git(bare, ['init', '-q', '--bare'])
    const dev = await setupGlobal(root, 'A', bare)
    const rt = mockRuntime(true)
    const cfg = { memoryDir: dev.memoryDir }
    assert.equal((await handleCommand('global', ['on', 'daily'], dev.cwd, { config: cfg, ...rt })).kind, 'success')
    mkdirSync(join(dev.memoryDir, 'daily'), { recursive: true })
    writeFileSync(join(dev.memoryDir, 'daily', '2026-08-10.md'), '[id:aaaa0000] [00:05] 昨日日志\n')
    writeFileSync(join(dev.memoryDir, 'daily', 'notes.md'), '非法文件（非日期命名）\n')
    assert.equal((await handleCommand('global', ['sync', '--push'], dev.cwd, { config: cfg, ...rt })).kind, 'success')
    // 远端 daily 分支只含日期文件
    const tree = git(bare, ['ls-tree', '-r', '--name-only', `refs/heads/${globalBranchFor('daily-global')}`])
    assert.ok(tree.split('\n').includes('daily/2026-08-10.md'))
    assert.ok(!tree.includes('daily/notes.md'), '非法路径不得上传')
  } finally {
    clean(root)
  }
})

/* ---------------- P1-1：无变化二次 sync 不重复提交 ---------------- */

test('无变化二次 sync：committed=false（临时 index 对比，不假 dirty 重复提交）', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = join(root, 'bare.git')
    mkdirSync(bare, { recursive: true })
    git(bare, ['init', '-q', '--bare'])
    const dev = await setupGlobal(root, 'A', bare)
    const rt = mockRuntime(true)
    const cfg = { memoryDir: dev.memoryDir }
    assert.equal((await handleCommand('global', ['on', 'memory'], dev.cwd, { config: cfg, ...rt })).kind, 'success')
    writeFileSync(join(dev.memoryDir, 'MEMORY.md'), '[id:aaaa0000] [2026-08-11 10:00] 全局事实\n')
    assert.equal((await handleCommand('global', ['sync', '--push'], dev.cwd, { config: cfg, ...rt })).kind, 'success')
    // 无变化二次 sync → committed=false（不重复提交）
    const r2 = await runSync({ dir: dev.memoryDir, remoteBranch: globalBranchFor('memory-global'), fileset: 'memory-global', localBranch: 'memory-global' })
    assert.equal(r2.ok, true)
    assert.equal(r2.committed, false, '无变化不应产生新提交')
    // 全局状态未推送=0（fileset 检查不假脏；口径 = 工作树变更轨 + 领先轨）
    const st = await handleCommand('global', ['status'], dev.cwd, { config: cfg, ...rt })
    assert.ok(!/未推送：-?[1-9]/.test(st.text), '无变化时未推送应为 0')
  } finally {
    clean(root)
  }
})

/* ---------------- P1-5：globalSync 失败聚合 ---------------- */

test('globalSync 失败聚合：任一轨失败 → 整体 error，不假报成功', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = join(root, 'bare.git')
    mkdirSync(bare, { recursive: true })
    git(bare, ['init', '-q', '--bare'])
    const dev = await setupGlobal(root, 'A', bare)
    const rt = mockRuntime(true)
    const cfg = { memoryDir: dev.memoryDir }
    assert.equal((await handleCommand('global', ['on', 'memory'], dev.cwd, { config: cfg, ...rt })).kind, 'success')
    assert.equal((await handleCommand('global', ['on', 'user'], dev.cwd, { config: cfg, ...rt })).kind, 'success')
    // 把 origin 指向不存在的仓库 → 两轨都失败
    git(dev.memoryDir, ['remote', 'set-url', 'origin', join(root, 'no-such.git')])
    const sync = await handleCommand('global', ['sync'], dev.cwd, { config: cfg, ...rt })
    assert.equal(sync.kind, 'error', '全部轨失败必须返回 error')
    assert.match(sync.text, /失败/)
  } finally {
    clean(root)
  }
})

/* ---------------- 全局轨冲突的 ops/命令层解决链路（2026-08-11 用户反馈：
   全局推送被某轨冲突拦截后提示"请先在冲突区解决"，但 UI/API 此前只支持
   项目轨——补全 ops.conflicts/resolve 的 fileset 透传与命令组支持） ---------------- */

test('ops.conflicts/resolve 支持全局轨 fileset：冲突可查可解、解决提交落本轨分支、命令组同款', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = join(root, 'bare.git')
    mkdirSync(bare, { recursive: true })
    git(bare, ['init', '-q', '--bare'])
    const A = await setupGlobal(root, 'A', bare)
    const B = await setupGlobal(root, 'B', bare)
    const rtA = mockRuntime(true)
    const cfgA = { memoryDir: A.memoryDir }
    assert.equal((await handleCommand('global', ['on', 'memory'], A.cwd, { config: cfgA, ...rtA })).kind, 'success')
    writeFileSync(join(A.memoryDir, 'MEMORY.md'), '[id:aaaa0000] [2026-08-11 10:00] 全局事实\n')
    assert.equal((await handleCommand('global', ['sync', '--push'], A.cwd, { config: cfgA, ...rtA })).kind, 'success')
    const rtB = mockRuntime(true)
    const cfgB = { memoryDir: B.memoryDir }
    assert.equal((await handleCommand('global', ['on', 'memory'], B.cwd, { config: cfgB, ...rtB })).kind, 'success')
    assert.equal((await handleCommand('global', ['sync'], B.cwd, { config: cfgB, ...rtB })).kind, 'success')
    // 双侧改同一条 → B 端 memory-global 冲突
    writeFileSync(join(A.memoryDir, 'MEMORY.md'), '[id:aaaa0000] [2026-08-11 10:00] A 的版本\n')
    assert.equal((await handleCommand('global', ['sync', '--push'], A.cwd, { config: cfgA, ...rtA })).kind, 'success')
    writeFileSync(join(B.memoryDir, 'MEMORY.md'), '[id:aaaa0000] [2026-08-11 10:00] B 的版本\n')
    const rSync = await runSync({ dir: B.memoryDir, remoteBranch: globalBranchFor('memory-global'), fileset: 'memory-global', localBranch: 'memory-global' })
    assert.equal(rSync.conflicts, 1)
    // 命令组：conflict list <fileset> 能列出全局冲突
    const clist = await handleCommand('conflict', ['list', 'memory-global'], B.cwd, { config: cfgB, ...mockRuntime(true) })
    assert.equal(clist.kind, 'success')
    assert.match(clist.text, /aaaa0000/)
    // ops 层：带 fileset 查全局冲突；缺省（项目）查不到（隔离正确）
    const ops = installMemorySync({ get: () => undefined }, { config: cfgB, getRuntime: rtB.getRuntime, applyRuntimePatch: rtB.applyRuntimePatch }).ops
    const list = ops.conflicts(B.cwd, 'memory-global')
    assert.equal(list.length, 1)
    // entryKey 带命名空间前缀（记忆轨 m: / TODO 轨 t:，merge 联合索引）
    assert.equal(list[0].entryKey, 'm:aaaa0000')
    assert.equal(ops.conflicts(B.cwd, undefined).length, 0, '缺省 fileset 只查项目轨')
    // 命令组：conflict resolve <编号> ours <fileset> 解决
    const cres = await handleCommand('conflict', ['resolve', '1', 'ours', 'memory-global'], B.cwd, { config: cfgB, ...mockRuntime(true) })
    assert.equal(cres.kind, 'success')
    assert.equal(countConflicts(B.memoryDir, 'memory-global'), 0)
    // ops.resolve 同样可用；解决提交必须落在 memory-global 分支（不串 main）
    const res = await ops.resolve(B.cwd, 1, 'ours', 'memory-global')
    assert.equal(res.kind, 'error', '侧车已清空：重复解决应如实失败（幂等保护）')
    assert.ok(git(B.memoryDir, ['rev-parse', '--verify', 'refs/heads/memory-global']).length > 0, '解决提交应落在 memory-global 本地分支')
    // 解决后推送成功（完整闭环）
    const rPush = await runSync({ dir: B.memoryDir, remoteBranch: globalBranchFor('memory-global'), fileset: 'memory-global', localBranch: 'memory-global', push: true })
    assert.equal(rPush.ok, true)
  } finally {
    clean(root)
  }
})
