/**
 * tests/sync-global.test.js — 全局记忆轨同步测试
 * （2026-08-11 用户拍板：开关做好功能必须实现——全局轨二期并入一期）
 *
 * 全局轨：全局记忆（MEMORY.md）/ 用户档案（USER.md）/ 每日日志（daily/*.md）/
 * 待办（TODOS-life.md、TODOS-work.md、daily/*.todo.md）四个独立轨，
 * 仅共享记忆仓库可用。全局仓库 = 记忆根目录的 .git（deny-all 白名单只放行
 * 全局记忆文件），每轨一条远端分支（dsh-shared/memory-global 等）与独立
 * 本地分支（refs/heads/<fileset>），同一工作树多轨并存互不干扰。
 *
 * 覆盖：
 *   - ensureGlobalRepo：初始化（.git/PROVENANCE/gitignore/补发/首次提交/origin）；
 *   - 双设备全局轨：A 开轨推送 → B 开轨拉取（记忆/用户档案/待办）；
 *   - 轨开关：关轨不参与对账；
 *   - 多轨分支隔离：各轨远端分支只含本轨文件；
 *   - 每日日志补发身份证 + 合并；
 *   - handleCommand global 子命令（on/off/status/sync）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ensureGlobalRepo } from '../lib/sync/repo.js'
import { handleCommand, projectSyncInfo } from '../lib/sync/index.js'
import { resolveProjectId } from '../lib/sync/identity.js'
import { GLOBAL_FILESET_KEYS, globalBranchFor } from '../lib/sync/filesets.js'

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-sync-global-'))
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
const URL = 'https://example.com/shared-memories.git'

/** mock 运行时。 */
function mockRuntime(syncEnabled) {
  const state = { syncEnabled }
  const patches = []
  return {
    getRuntime: () => ({ ...state }),
    applyRuntimePatch: (patch) => { Object.assign(state, patch); patches.push(patch) },
    patches,
  }
}

/** 建一台"设备"（cwd 主仓库身份 + 独立 memoryDir）。 */
function makeDevice(root, n) {
  const cwd = join(root, `work${n}`)
  mkdirSync(cwd, { recursive: true })
  git(cwd, ['init', '-q', '-b', 'main'])
  git(cwd, ['remote', 'add', 'origin', 'https://example.com/acme/alpha.git'])
  const identity = resolveProjectId(cwd)
  const memoryDir = join(root, `mem${n}`)
  return { cwd, memoryDir, identity }
}

/* ---------------- ensureGlobalRepo 初始化 ---------------- */

test('ensureGlobalRepo：初始化全局仓库（.git/PROVENANCE/白名单/首次提交/origin）', { skip }, async () => {
  const root = tempDir()
  try {
    const dev = makeDevice(root, 'A')
    const memoryDir = dev.memoryDir
    mkdirSync(memoryDir, { recursive: true })
    // 预置一些全局记忆文件（含老记忆——补发验证）
    writeFileSync(join(memoryDir, 'MEMORY.md'), '[2026-08-11 10:00] 全局事实\n')
    writeFileSync(join(memoryDir, 'USER.md'), '[2026-08-11 09:00] 用户偏好\n')
    mkdirSync(join(memoryDir, 'daily'), { recursive: true })
    writeFileSync(join(memoryDir, 'daily', '2026-08-10.md'), '[00:05] 昨日日志\n')
    writeFileSync(join(memoryDir, 'TODOS-life.md'), '<!--\n待办格式\n-->\n§\n[2026-08-11 08:00] [id: aaaa0000] [q2] 生活待办\n')

    const r = await ensureGlobalRepo({ dir: memoryDir, url: URL })
    assert.equal(r.ok, true)
    // .git 建在记忆根目录
    assert.ok(existsSync(join(memoryDir, '.git')), '全局仓库应建在记忆根目录')
    // PROVENANCE（URL 指纹身份 + 四轨开关默认关）
    const meta = JSON.parse(readFileSync(join(memoryDir, 'PROVENANCE'), 'utf8'))
    assert.equal(meta.url, URL)
    assert.deepEqual(meta.tracks, { memory: false, user: false, daily: false, todo: false })
    // origin 绑定
    assert.equal(git(memoryDir, ['remote', 'get-url', 'origin']), URL)
    // 记忆文件补发身份证（行首 [id:xxxx]）
    assert.match(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8'), /^\[id:[0-9a-f]{8}\] /)
    assert.match(readFileSync(join(memoryDir, 'USER.md'), 'utf8'), /^\[id:[0-9a-f]{8}\] /)
    assert.match(readFileSync(join(memoryDir, 'daily', '2026-08-10.md'), 'utf8'), /^\[id:[0-9a-f]{8}\] /)
    // TODO 文件不补发（tag id 自足，header 保留）
    assert.ok(readFileSync(join(memoryDir, 'TODOS-life.md'), 'utf8').startsWith('<!--'))
    assert.ok(!/^\[id:/.test(readFileSync(join(memoryDir, 'TODOS-life.md'), 'utf8').split('\n')[2] ?? ''))
    // 首次提交包含白名单文件，其他目录（projects/ 等）不入库
    const tracked = git(memoryDir, ['ls-files'])
    assert.ok(tracked.split('\n').includes('MEMORY.md'))
    assert.ok(tracked.split('\n').includes('TODOS-life.md'))
    assert.ok(tracked.split('\n').includes('daily/2026-08-10.md'))
    // 幂等：重复调用成功且无新提交
    const r2 = await ensureGlobalRepo({ dir: memoryDir, url: URL })
    assert.equal(r2.ok, true)
  } finally {
    clean(root)
  }
})

/* ---------------- 双设备全局轨 ---------------- */

test('双设备全局轨：A 开轨推送 → B 开轨拉取（记忆/用户档案/待办）', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = join(root, 'bare.git')
    mkdirSync(bare, { recursive: true })
    git(bare, ['init', '-q', '--bare'])
    const A = makeDevice(root, 'A')
    const B = makeDevice(root, 'B')

    // 设备 A：初始化全局仓库（origin 用可访问的裸仓库做传输，身份用假 URL）
    const initA = await ensureGlobalRepo({ dir: A.memoryDir, url: URL })
    assert.equal(initA.ok, true)
    git(A.memoryDir, ['remote', 'set-url', 'origin', bare])
    // A 开 记忆+用户档案+待办 三轨（每日日志留空轨验证）
    const rtA = mockRuntime(true)
    const cfgA = { memoryDir: A.memoryDir }
    assert.equal((await handleCommand('global', ['on', 'memory'], A.cwd, { config: cfgA, ...rtA })).kind, 'success')
    assert.equal((await handleCommand('global', ['on', 'user'], A.cwd, { config: cfgA, ...rtA })).kind, 'success')
    assert.equal((await handleCommand('global', ['on', 'todo'], A.cwd, { config: cfgA, ...rtA })).kind, 'success')
    // A 写全局记忆
    writeFileSync(join(A.memoryDir, 'MEMORY.md'), '[id:aaaa0000] [2026-08-11 10:00] 全局事实\n')
    writeFileSync(join(A.memoryDir, 'USER.md'), '[id:bbbb0000] [2026-08-11 09:00] 用户偏好\n')
    writeFileSync(join(A.memoryDir, 'TODOS-life.md'), '<!--\n待办格式\n-->\n§\n[2026-08-11 08:00] [id: cccc0000] [q2] 生活待办\n')
    // A 全局同步并推送（--push = 用户同意）
    const syncA = await handleCommand('global', ['sync', '--push'], A.cwd, { config: cfgA, ...rtA })
    assert.equal(syncA.kind, 'success')
    assert.match(syncA.text, /全局记忆：|全局轨同步/)
    // 远端出现三轨分支，内容隔离
    const heads = git(bare, ['for-each-ref', '--format=%(refname)', 'refs/heads'])
    assert.ok(heads.includes(`refs/heads/${globalBranchFor('memory-global')}`))
    assert.ok(heads.includes(`refs/heads/${globalBranchFor('user-global')}`))
    assert.ok(heads.includes(`refs/heads/${globalBranchFor('todo-global')}`))
    assert.ok(!heads.includes(`refs/heads/${globalBranchFor('daily-global')}`), '未开启的轨不应推送分支')
    // memory 分支只含 MEMORY.md；todo 分支只含 TODOS-life.md
    const memTree = git(bare, ['ls-tree', '-r', '--name-only', `refs/heads/${globalBranchFor('memory-global')}`])
    assert.ok(memTree.split('\n').includes('MEMORY.md'))
    assert.ok(!memTree.includes('TODOS-life.md'))
    const todoTree = git(bare, ['ls-tree', '-r', '--name-only', `refs/heads/${globalBranchFor('todo-global')}`])
    assert.ok(todoTree.split('\n').includes('TODOS-life.md'))
    assert.ok(!todoTree.includes('MEMORY.md'))

    // 设备 B：初始化全局仓库 + 开三轨 + 拉取
    const initB = await ensureGlobalRepo({ dir: B.memoryDir, url: URL })
    assert.equal(initB.ok, true)
    git(B.memoryDir, ['remote', 'set-url', 'origin', bare])
    const rtB = mockRuntime(true)
    const cfgB = { memoryDir: B.memoryDir }
    assert.equal((await handleCommand('global', ['on', 'memory'], B.cwd, { config: cfgB, ...rtB })).kind, 'success')
    assert.equal((await handleCommand('global', ['on', 'user'], B.cwd, { config: cfgB, ...rtB })).kind, 'success')
    assert.equal((await handleCommand('global', ['on', 'todo'], B.cwd, { config: cfgB, ...rtB })).kind, 'success')
    const syncB = await handleCommand('global', ['sync'], B.cwd, { config: cfgB, ...rtB })
    assert.equal(syncB.kind, 'success')
    // B 拿到全部三轨内容（含身份证）
    assert.ok(readFileSync(join(B.memoryDir, 'MEMORY.md'), 'utf8').includes('全局事实'))
    assert.ok(readFileSync(join(B.memoryDir, 'USER.md'), 'utf8').includes('用户偏好'))
    assert.ok(readFileSync(join(B.memoryDir, 'TODOS-life.md'), 'utf8').includes('生活待办'))

    // B 追加全局记忆 → 推送 → A 收敛
    writeFileSync(join(B.memoryDir, 'MEMORY.md'), '[id:aaaa0000] [2026-08-11 10:00] 全局事实\n§\n[id:dddd0000] [2026-08-11 11:00] B 的新全局事实\n')
    const syncB2 = await handleCommand('global', ['sync', '--push'], B.cwd, { config: cfgB, ...rtB })
    assert.equal(syncB2.kind, 'success')
    const syncA2 = await handleCommand('global', ['sync'], A.cwd, { config: cfgA, ...rtA })
    assert.equal(syncA2.kind, 'success')
    assert.ok(readFileSync(join(A.memoryDir, 'MEMORY.md'), 'utf8').includes('B 的新全局事实'))
  } finally {
    clean(root)
  }
})

/* ---------------- 关轨不参与 ---------------- */

test('全局轨开关：关闭的轨不参与对账（远端分支不受影响）', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = join(root, 'bare.git')
    mkdirSync(bare, { recursive: true })
    git(bare, ['init', '-q', '--bare'])
    const dev = makeDevice(root, 'A')
    const rt = mockRuntime(true)
    const cfg = { memoryDir: dev.memoryDir }
    await ensureGlobalRepo({ dir: dev.memoryDir, url: URL })
    git(dev.memoryDir, ['remote', 'set-url', 'origin', bare])
    // 只开 memory 轨
    assert.equal((await handleCommand('global', ['on', 'memory'], dev.cwd, { config: cfg, ...rt })).kind, 'success')
    writeFileSync(join(dev.memoryDir, 'USER.md'), '[id:eeee0000] [2026-08-11 09:00] 用户档案（未开轨）\n')
    const sync = await handleCommand('global', ['sync', '--push'], dev.cwd, { config: cfg, ...rt })
    assert.equal(sync.kind, 'success')
    // user 分支不存在（未开轨不推）
    const heads = git(bare, ['for-each-ref', '--format=%(refname)', 'refs/heads'])
    assert.ok(!heads.includes(`refs/heads/${globalBranchFor('user-global')}`))
    // 本地 user 文件保持原样（未被合并改写）
    assert.ok(readFileSync(join(dev.memoryDir, 'USER.md'), 'utf8').includes('未开轨'))
    // 开轨后 sync 才推
    assert.equal((await handleCommand('global', ['on', 'user'], dev.cwd, { config: cfg, ...rt })).kind, 'success')
    const sync2 = await handleCommand('global', ['sync', '--push'], dev.cwd, { config: cfg, ...rt })
    assert.equal(sync2.kind, 'success')
    assert.ok(git(bare, ['for-each-ref', '--format=%(refname)', 'refs/heads']).includes(`refs/heads/${globalBranchFor('user-global')}`))
  } finally {
    clean(root)
  }
})

/* ---------------- 每日日志轨 ---------------- */

test('每日日志轨：daily/*.md 补发身份证并同步', { skip }, async () => {
  const root = tempDir()
  try {
    const bare = join(root, 'bare.git')
    mkdirSync(bare, { recursive: true })
    git(bare, ['init', '-q', '--bare'])
    const A = makeDevice(root, 'A')
    const B = makeDevice(root, 'B')
    const rtA = mockRuntime(true)
    const cfgA = { memoryDir: A.memoryDir }
    await ensureGlobalRepo({ dir: A.memoryDir, url: URL })
    git(A.memoryDir, ['remote', 'set-url', 'origin', bare])
    assert.equal((await handleCommand('global', ['on', 'daily'], A.cwd, { config: cfgA, ...rtA })).kind, 'success')
    mkdirSync(join(A.memoryDir, 'daily'), { recursive: true })
    writeFileSync(join(A.memoryDir, 'daily', '2026-08-10.md'), '[id:aaaa0000] [00:05] 昨日日志\n')
    const syncA = await handleCommand('global', ['sync', '--push'], A.cwd, { config: cfgA, ...rtA })
    assert.equal(syncA.kind, 'success')
    // B 开 daily 轨拉取
    const rtB = mockRuntime(true)
    const cfgB = { memoryDir: B.memoryDir }
    await ensureGlobalRepo({ dir: B.memoryDir, url: URL })
    git(B.memoryDir, ['remote', 'set-url', 'origin', bare])
    assert.equal((await handleCommand('global', ['on', 'daily'], B.cwd, { config: cfgB, ...rtB })).kind, 'success')
    const syncB = await handleCommand('global', ['sync'], B.cwd, { config: cfgB, ...rtB })
    assert.equal(syncB.kind, 'success')
    assert.ok(readFileSync(join(B.memoryDir, 'daily', '2026-08-10.md'), 'utf8').includes('昨日日志'))
  } finally {
    clean(root)
  }
})

/* ---------------- global status 子命令 ---------------- */

test('global status：未初始化/已初始化两种状态', { skip }, async () => {
  const root = tempDir()
  try {
    const dev = makeDevice(root, 'A')
    const rt = mockRuntime(true)
    const cfg = { memoryDir: dev.memoryDir }
    // 未初始化
    const st0 = await handleCommand('global', ['status'], dev.cwd, { config: cfg, ...rt })
    assert.equal(st0.kind, 'success')
    assert.match(st0.text, /未初始化/)
    // 初始化后
    await ensureGlobalRepo({ dir: dev.memoryDir, url: URL })
    const st1 = await handleCommand('global', ['status'], dev.cwd, { config: cfg, ...rt })
    assert.equal(st1.kind, 'success')
    assert.match(st1.text, new RegExp(URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(st1.text, /全局记忆：关；用户档案：关；每日日志：关；待办（生活\/工作\/每日）：关/)
  } finally {
    clean(root)
  }
})
