/**
 * tests/sync-index.test.js — 记忆同步装配层测试（施工图 §7 第 6 步验收）
 *
 * 覆盖：
 *   - makeProjectDirResolver：sync 已初始化项目定位 projectId 目录，否则
 *     回退 projectHash(cwd)（未启用项目零变化）；
 *   - renderSyncLine / syncStatusSync：快照状态行（未初始化空串、初始化后
 *     状态文本、状态驱动稳定）；
 *   - handleCommand 命令组：setup 模式 A（真实 git 双设备）、setup 模式 B、
 *     sync 未初始化报错、off 关闭开关、status、migrate、conflict list；
 *   - spawnWorker：真实子进程调用 worker 入口。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeProjectDirResolver, projectSyncInfo, renderSyncLine, handleCommand, spawnWorker, syncStatusSync, installMemorySync } from '../lib/sync/index.js'
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
  return mkdtempSync(join(tmpdir(), 'dsh-sync-index-'))
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

/** 搭一个已初始化的 sync 项目（设备 A bootstrap + push 到裸仓库）。 */
async function bootProject(root, name = 'work') {
  const bare = join(root, 'bare.git')
  mkdirSync(bare, { recursive: true })
  git(bare, ['init', '-q', '--bare'])
  const cwd = join(root, name)
  mkdirSync(cwd, { recursive: true })
  git(cwd, ['init', '-q', '-b', 'main'])
  git(cwd, ['remote', 'add', 'origin', 'https://example.com/acme/alpha.git'])
  const identity = resolveProjectId(cwd)
  const memoryDir = join(root, 'memories')
  const dir = join(memoryDir, 'projects', identity.id)
  const boot = await ensureMemoryRepo({ dir, memoryDir, cwd, projectId: identity.id, displayName: identity.displayName, remoteUrl: identity.remoteUrl, remoteBranch: RB })
  assert.equal(boot.ok, true)
  // 记忆仓库 origin 指向可访问的裸仓库，并完成首次推送（远端分支存在 →
  // setup 判定树走 adopt 分支）
  git(dir, ['remote', 'set-url', 'origin', bare])
  git(dir, ['push', '-q', bare, `main:${RB}`])
  return { bare, cwd, memoryDir, identity, dir }
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

/* ---------------- makeProjectDirResolver ---------------- */

test('makeProjectDirResolver：已初始化 sync 项目 → projectId 目录；否则回退 projectHash', { skip }, async () => {
  const root = tempDir()
  try {
    const { cwd, memoryDir, identity } = await bootProject(root)
    const resolver = makeProjectDirResolver({ memoryDir })
    // 已初始化：PROVENANCE 存在 → projectId 目录
    assert.equal(resolver(cwd), join(memoryDir, 'projects', identity.id))
    // 未初始化项目：回退 projectHash
    const plainCwd = join(root, 'no-git-project')
    mkdirSync(plainCwd, { recursive: true })
    assert.equal(resolver(plainCwd), join(memoryDir, 'projects', projectHash(plainCwd)))
  } finally {
    clean(root)
  }
})

/* ---------------- 快照状态行 ---------------- */

test('renderSyncLine：未初始化 → 空串（不占快照体积）；初始化后 → 状态文本', { skip }, async () => {
  const root = tempDir()
  try {
    const { cwd, memoryDir } = await bootProject(root)
    // 未初始化项目：空串
    const plainCwd = join(root, 'plain')
    mkdirSync(plainCwd, { recursive: true })
    assert.equal(renderSyncLine({ memoryDir }, plainCwd), '')
    // 无 cwd：空串
    assert.equal(renderSyncLine({ memoryDir }, undefined), '')
    // 已初始化：状态文本（刚初始化 → 未提交 0、落后 0 → "已同步"）
    const line = renderSyncLine({ memoryDir }, cwd)
    assert.match(line, /^## 记忆同步/)
    assert.match(line, /已同步|未提交/)
  } finally {
    clean(root)
  }
})

test('renderSyncLine：未提交变更会体现在状态行（状态驱动稳定）', { skip }, async () => {
  const root = tempDir()
  try {
    const { cwd, memoryDir, dir } = await bootProject(root)
    // 工作树加一条未提交记忆（模拟 store 写入后）
    writeFileSync(join(dir, 'KEY.md'), '[id:aaaa0000] [2026-08-11] 未提交条目\n')
    const line = renderSyncLine({ memoryDir }, cwd)
    assert.match(line, /未提交 1 条/)
  } finally {
    clean(root)
  }
})

/* ---------------- 命令组 ---------------- */

test('handleCommand setup：模式 A（未初始化引导 / 本地远端回退 / adopt 接入）', { skip }, async () => {
  const root = tempDir()
  try {
    const { cwd, memoryDir } = await bootProject(root)
    const rt = mockRuntime(true)
    // ① 未初始化项目（无记忆仓库）sync → 报错引导 setup
    const plainCwd = join(root, 'plain2')
    mkdirSync(plainCwd, { recursive: true })
    git(plainCwd, ['init', '-q', '-b', 'main'])
    git(plainCwd, ['remote', 'add', 'origin', 'https://example.com/acme/beta.git'])
    const noSetup = await handleCommand('sync', [], plainCwd, { config: { memoryDir }, ...rt })
    assert.equal(noSetup.kind, 'error')
    assert.match(noSetup.text, /setup/)
    // ② 本地路径 remote（file:// 语义，归一化失败 → fallback 身份）→
    //    setup 模式 A 如实报"没有可共享远端"（引导模式 B）
    const localCwd = join(root, 'plain3')
    mkdirSync(localCwd, { recursive: true })
    git(localCwd, ['init', '-q', '-b', 'main'])
    git(localCwd, ['remote', 'add', 'origin', join(root, 'local-bare.git')])
    const localSetup = await handleCommand('setup', [], localCwd, { config: { memoryDir }, ...rt })
    assert.equal(localSetup.kind, 'error')
    assert.match(localSetup.text, /没有可共享的 git 远端/)
    // ③ 已初始化项目（远端分支存在）→ setup 判定树 adopt 分支 → 接入提示
    const setup = await handleCommand('setup', [], cwd, { config: { memoryDir }, ...rt })
    assert.equal(setup.kind, 'success')
    assert.match(setup.text, /接入远端记忆/)
  } finally {
    clean(root)
  }
})

test('handleCommand setup：模式 B（共享记忆仓库 url）初始化', { skip }, async () => {
  const root = tempDir()
  try {
    const privateBare = join(root, 'private-bare.git')
    mkdirSync(privateBare, { recursive: true })
    git(privateBare, ['init', '-q', '--bare'])
    const cwd = join(root, 'workB')
    mkdirSync(cwd, { recursive: true })
    git(cwd, ['init', '-q', '-b', 'main'])
    git(cwd, ['remote', 'add', 'origin', 'https://example.com/acme/alpha.git']) // 主仓库 remote（身份）
    const identity = resolveProjectId(cwd)
    const memoryDir = join(root, 'memoriesB')
    const rt = mockRuntime(true)
    // 模式 B：显式 url → 共享记忆仓库（2026-08-11 拍板：一个私有仓库装
    // 所有项目的记忆）。空仓库 → fresh → 本项目使用专属分支 dsh-shared/<id>
    // （不再固定 main——main 只用于老单项目仓库兼容）
    const setup = await handleCommand('setup', [privateBare], cwd, { config: { memoryDir }, ...rt })
    assert.equal(setup.kind, 'success')
    assert.match(setup.text, /共享记忆仓库/)
    const info = projectSyncInfo({ memoryDir }, cwd)
    assert.equal(info.remoteBranch, `dsh-shared/${identity.id}`)
    assert.ok(existsSync(join(info.dir, 'PROVENANCE')))
    // PROVENANCE 记录了共享分支
    const meta = JSON.parse(readFileSync(join(info.dir, 'PROVENANCE'), 'utf8'))
    assert.equal(meta.remoteBranch, `dsh-shared/${identity.id}`)
  } finally {
    clean(root)
  }
})

test('handleCommand off：项目级停用（PROVENANCE.enabled=false，记忆保留）；status 显示三层开关', { skip }, async () => {
  const root = tempDir()
  try {
    const { cwd, memoryDir, dir } = await bootProject(root)
    const rt = mockRuntime(false)
    // 模块未启用时 status 提示先 setup/开模块
    const st = await handleCommand('status', [], cwd, { config: { memoryDir }, ...rt })
    assert.equal(st.kind, 'success')
    assert.match(st.text, /未启用/)
    // off：项目级停用——PROVENANCE.enabled=false（不关全局开关）
    const off = await handleCommand('off', [], cwd, { config: { memoryDir }, ...rt })
    assert.equal(off.kind, 'success')
    assert.deepEqual(rt.patches, [], 'off 不应触碰全局 syncEnabled')
    const meta = JSON.parse(readFileSync(join(dir, 'PROVENANCE'), 'utf8'))
    assert.equal(meta.enabled, false)
    // 停用后 sync 被拒
    const syncAfter = await handleCommand('sync', [], cwd, { config: { memoryDir }, ...mockRuntime(true) })
    assert.equal(syncAfter.kind, 'error')
    assert.match(syncAfter.text, /已停用同步/)
    // 启用后 status 显示项目信息与三层开关状态
    const rt2 = mockRuntime(true)
    const st2 = await handleCommand('status', [], cwd, { config: { memoryDir }, ...rt2 })
    assert.equal(st2.kind, 'success')
    assert.match(st2.text, /项目身份/)
    assert.match(st2.text, /远端分支：dsh-shared\/memory/)
    assert.match(st2.text, /本项目同步：已停用/)
  } finally {
    clean(root)
  }
})

test('handleCommand migrate：旧目录可见；conflict list：无冲突提示', { skip }, async () => {
  const root = tempDir()
  try {
    const { cwd, memoryDir } = await bootProject(root)
    const rt = mockRuntime(true)
    // 无旧目录 → 提示无迁移
    const migrate = await handleCommand('migrate', [], cwd, { config: { memoryDir }, ...rt })
    assert.equal(migrate.kind, 'success')
    assert.match(migrate.text, /没有发现可迁移/)
    // conflict list 无冲突
    const cl = await handleCommand('conflict', ['list'], cwd, { config: { memoryDir }, ...rt })
    assert.equal(cl.kind, 'success')
    assert.match(cl.text, /没有待处理/)
  } finally {
    clean(root)
  }
})

/* ---------------- spawnWorker 端到端 ---------------- */

test('spawnWorker：真实子进程执行 worker（sync 未初始化目录报可恢复错误）', { skip }, async () => {
  const root = tempDir()
  try {
    const run = await spawnWorker(['sync', join(root, 'no-such-dir'), RB])
    assert.equal(run.ok, false)
    // worker 输出应为 JSON（stdout 末行解析出 message）
    const parsed = JSON.parse(run.stdout.trim().split('\n').pop())
    assert.equal(parsed.ok, false)
    assert.match(parsed.message, /未初始化|初始化/)
  } finally {
    clean(root)
  }
})

/* ---------------- installMemorySync 装配冒烟 ---------------- */

test('installMemorySync：命令注册 + dispose 清理 + syncStatus', () => {
  // mock ctx（commands 服务）：验证命令组注册与卸载
  const registered = []
  let disposed = 0
  const mockCtx = {
    get(name) {
      if (name === 'commands') {
        return {
          register(def) {
            registered.push(def)
            return () => { disposed += 1 }
          },
        }
      }
      return undefined
    },
  }
  const rt = { syncEnabled: true }
  const installed = installMemorySync(mockCtx, {
    config: { memoryDir: '/tmp/nonexistent' },
    getRuntime: () => ({ ...rt }),
    applyRuntimePatch: () => {},
  })
  // 命令注册
  assert.ok(registered.some((d) => d.name === 'memory_sync'), '应注册 /memory_sync 命令')
  const def = registered.find((d) => d.name === 'memory_sync')
  assert.match(def.input.syntax, /setup/)
  // syncStatus：未初始化项目如实返回
  const status = installed.syncStatus('/tmp/nonexistent-cwd')
  assert.equal(status.enabled, true)
  assert.equal(status.initialized, false)
  // dispose：清理命令注册
  installed.dispose()
  assert.ok(disposed >= 1, 'dispose 应清理注册')
  // 幂等 dispose
  installed.dispose()
})

/* ---------------- syncStatusSync（API 数据源） ---------------- */

test('syncStatusSync：初始化后返回完整状态字段', { skip }, async () => {
  const root = tempDir()
  try {
    const { cwd, memoryDir } = await bootProject(root)
    const status = syncStatusSync({ memoryDir }, cwd)
    assert.ok(status)
    assert.equal(status.initialized, true)
    assert.equal(typeof status.uncommitted, 'number')
    assert.equal(typeof status.behind, 'number')
    assert.equal(typeof status.conflicts, 'number')
    assert.equal(status.remoteBranch, RB)
    // 未初始化项目 → null
    assert.equal(syncStatusSync({ memoryDir }, join(root, 'nonexistent')), null)
  } finally {
    clean(root)
  }
})

/* ---------------- 三层开关（2026-08-11 用户拍板） ---------------- */

test('三层开关：模块开关≠项目开关；项目开关默认关、打开走 setup、关闭停用', { skip }, async () => {
  const root = tempDir()
  try {
    const { cwd, memoryDir } = await bootProject(root)
    const rt = mockRuntime(true)
    const ops = installMemorySync(mockCtxOf(), { config: { memoryDir }, getRuntime: rt.getRuntime, applyRuntimePatch: rt.applyRuntimePatch }).ops
    // ① 模块开关开、项目未初始化：projectEnabled 语义 = PROVENANCE 不存在 →
    //    setup 引导（项目开关"打开"动作 = setup）
    const status0 = syncStatusSync({ memoryDir }, cwd)
    assert.ok(status0.initialized)
    // ② 项目开关关闭（显式停用）→ PROVENANCE.enabled=false → sync 被拒
    const off = await ops.setProjectEnabled(cwd, false)
    assert.equal(off.kind, 'success')
    const meta = JSON.parse(readFileSync(join(projectSyncInfo({ memoryDir }, cwd).dir, 'PROVENANCE'), 'utf8'))
    assert.equal(meta.enabled, false)
    const syncRejected = await handleCommand('sync', [], cwd, { config: { memoryDir }, ...mockRuntime(true) })
    assert.equal(syncRejected.kind, 'error')
    assert.match(syncRejected.text, /已停用同步/)
    // ③ 重新启用（项目开关打开）→ enabled=true，sync 恢复
    const on = await ops.setProjectEnabled(cwd, true)
    assert.equal(on.kind, 'success')
    const meta2 = JSON.parse(readFileSync(join(projectSyncInfo({ memoryDir }, cwd).dir, 'PROVENANCE'), 'utf8'))
    assert.equal(meta2.enabled, true)
    const syncOk = await handleCommand('sync', [], cwd, { config: { memoryDir }, ...mockRuntime(true) })
    assert.equal(syncOk.kind, 'success')
    // ④ 轨开关：关掉项目记忆轨 → sync 被拒（无内容可对账）
    const trackOff = ops.setTrack(cwd, false)
    assert.equal(trackOff.kind, 'success')
    const meta3 = JSON.parse(readFileSync(join(projectSyncInfo({ memoryDir }, cwd).dir, 'PROVENANCE'), 'utf8'))
    assert.equal(meta3.tracks.project, false)
    const syncTrackRejected = await handleCommand('sync', [], cwd, { config: { memoryDir }, ...mockRuntime(true) })
    assert.equal(syncTrackRejected.kind, 'error')
    assert.match(syncTrackRejected.text, /退出同步|未选择任何同步内容/)
    // ⑤ 轨开关恢复
    ops.setTrack(cwd, true)
  } finally {
    clean(root)
  }
})

/** 最小 mock ctx（installMemorySync 命令注册用）。 */
function mockCtxOf() {
  return { get: () => undefined }
}
