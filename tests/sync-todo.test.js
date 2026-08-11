/**
 * tests/sync-todo.test.js — 项目待办（TODOS.md）接入同步测试
 * （2026-08-11 统一模式：项目待办并入项目记忆轨，用户拍板）
 *
 * 覆盖：
 *   - TodoStore projectDirResolver：项目待办路径跟随 sync 目录（projectId）；
 *   - 双设备并集：A 建待办推送 → B 接入拿到；B 新增 → A 拿到；
 *   - header 保留：sync 写回后文件头注释块仍在（todo.js 解析器依赖）；
 *   - 冲突：双侧改同一条（同 tag id 不同内容）→ conflict → resolve both
 *     （theirs 换新 id）→ 收敛一致；
 *   - 白名单：TODOS.md 确实进入记忆仓库历史。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ensureMemoryRepo, deviceBConnect } from '../lib/sync/repo.js'
import { resolveProjectId } from '../lib/sync/identity.js'
import { runSync, resolveConflict, countConflicts } from '../lib/sync/worker.js'
import { TodoStore, TODO_HEADER } from '../lib/todo.js'
import { projectHash } from '../lib/store.js'

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-sync-todo-'))
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

/** todo.js 风格的 TODOS.md 文件（header + \n§\n + 条目）。 */
function todoFile(lines) {
  return `${TODO_HEADER}\n§\n${lines.join('\n§\n')}\n`
}

/** 一条项目待办（tag 行 = 时间 + [id: xxxx] + 象限 + 内容）。 */
const TODO1 = '[2026-08-11 09:00] [id: aaaa0000] [q2] 第一件事'
const TODO2 = '[2026-08-11 09:30] [id: bbbb0000] [q1] 第二件事'

/** 搭双设备（A bootstrap + 提交初始记忆 + push；B adopt）。 */
async function setupE2E(root) {
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
  const branch = `dsh-shared/${A.identity.id}`
  const boot = await ensureMemoryRepo({ dir: A.dir, memoryDir: A.memoryDir, cwd: A.cwd, projectId: A.identity.id, displayName: A.identity.displayName, remoteUrl: A.identity.remoteUrl, remoteBranch: branch })
  assert.equal(boot.ok, true)
  // A 提交初始记忆并推送（真实首推：远端无分支）
  writeFileSync(join(A.dir, 'KEY.md'), '[id:00000001] [2026-08-11] 初始记忆\n')
  git(A.dir, ['add', '-f', '--', 'KEY.md'])
  git(A.dir, ['commit', '-q', '-m', 'memory: initial'])
  git(A.dir, ['push', '-q', bare, `main:${branch}`])
  git(A.dir, ['remote', 'set-url', 'origin', bare])
  const connect = await deviceBConnect({ dir: B.dir, remoteUrl: bare, remoteBranch: branch, expectedProjectId: A.identity.id })
  assert.equal(connect.mode, 'adopt')
  return { bare, dev, branch }
}

/* ---------------- TodoStore resolver ---------------- */

test('TodoStore projectDirResolver：项目待办路径跟随 sync 目录（projectId）', { skip }, () => {
  const root = tempDir()
  try {
    const memoryDir = join(root, 'memories')
    const syncDir = join(memoryDir, 'projects', 'ab12cd34ef56')
    const resolver = () => syncDir // 简化：直接返回 sync 目录
    const plain = new TodoStore(memoryDir)
    const synced = new TodoStore(memoryDir, resolver)
    assert.equal(plain.fileOf('project', '/tmp/work'), join(memoryDir, 'projects', projectHash('/tmp/work'), 'TODOS.md'))
    assert.equal(synced.fileOf('project', '/tmp/work'), join(syncDir, 'TODOS.md'))
    // 非项目轨不受 resolver 影响
    assert.equal(synced.fileOf('life'), join(memoryDir, 'TODOS-life.md'))
    assert.equal(synced.fileOf('work'), join(memoryDir, 'TODOS-work.md'))
  } finally {
    clean(root)
  }
})

/* ---------------- 双设备并集 ---------------- */

test('TODOS 同步：双设备并集，header 保留，条目完整', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, dev, branch } = await setupE2E(root)
    // A 建一条项目待办并推送
    writeFileSync(join(dev.A.dir, 'TODOS.md'), todoFile([TODO1]))
    git(dev.A.dir, ['add', '-f', '--', 'TODOS.md'])
    git(dev.A.dir, ['commit', '-q', '-m', 'memory: todo 1'])
    git(dev.A.dir, ['push', '-q', bare, `main:${branch}`])
    // TODOS.md 确实进了仓库历史（白名单生效）
    assert.ok(git(dev.A.dir, ['ls-files']).split('\n').includes('TODOS.md'), 'TODOS.md 应在仓库跟踪中')

    // B 首次 sync：拿到 TODO + header 保留
    const r1 = await runSync({ dir: dev.B.dir, remoteBranch: branch })
    assert.equal(r1.ok, true)
    const bTodo = readFileSync(join(dev.B.dir, 'TODOS.md'), 'utf8')
    assert.ok(bTodo.startsWith('<!--'), '文件头注释块应保留')
    assert.ok(bTodo.includes('第一件事'))
    assert.ok(bTodo.includes('[id: aaaa0000]'))

    // B 新增一条 → push → A 拿到并集
    writeFileSync(join(dev.B.dir, 'TODOS.md'), todoFile([TODO1, TODO2]))
    const r2 = await runSync({ dir: dev.B.dir, remoteBranch: branch, push: true })
    assert.equal(r2.ok, true)
    const r2a = await runSync({ dir: dev.A.dir, remoteBranch: branch })
    assert.equal(r2a.ok, true)
    const aTodo = readFileSync(join(dev.A.dir, 'TODOS.md'), 'utf8')
    assert.ok(aTodo.includes('第一件事') && aTodo.includes('第二件事'), 'A 应拿到并集')
    assert.ok(aTodo.startsWith('<!--'), 'A 的 header 也应保留')
    assert.equal(countConflicts(dev.A.dir), 0)
  } finally {
    clean(root)
  }
})

/* ---------------- 冲突与解决 ---------------- */

test('TODOS 冲突：双侧改同一条 → conflict → resolve both → 收敛一致', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, dev, branch } = await setupE2E(root)
    // 基线：A 提交 TODO1 并推送
    writeFileSync(join(dev.A.dir, 'TODOS.md'), todoFile([TODO1]))
    git(dev.A.dir, ['add', '-f', '--', 'TODOS.md'])
    git(dev.A.dir, ['commit', '-q', '-m', 'memory: todo base'])
    git(dev.A.dir, ['push', '-q', bare, `main:${branch}`])
    const r0 = await runSync({ dir: dev.B.dir, remoteBranch: branch })
    assert.equal(r0.ok, true)

    // A 改成 A 版；B 改成 B 版（同 id:aaaa0000 不同内容）
    const aVersion = '[2026-08-11 10:00] [id: aaaa0000] [q2] A 改的版本'
    const bVersion = '[2026-08-11 10:01] [id: aaaa0000] [q2] B 改的版本'
    writeFileSync(join(dev.A.dir, 'TODOS.md'), todoFile([aVersion]))
    git(dev.A.dir, ['add', '-f', '--', 'TODOS.md'])
    git(dev.A.dir, ['commit', '-q', '-m', 'memory: todo A edit'])
    git(dev.A.dir, ['push', '-q', bare, `main:${branch}`])
    writeFileSync(join(dev.B.dir, 'TODOS.md'), todoFile([bVersion]))
    const r1 = await runSync({ dir: dev.B.dir, remoteBranch: branch })
    assert.equal(r1.ok, true)
    assert.equal(r1.conflicts, 1, '同 id 双侧修改应产生冲突')
    // 冲突条目不落盘到 TODOS.md
    assert.ok(!readFileSync(join(dev.B.dir, 'TODOS.md'), 'utf8').includes('改的版本'), '冲突条目不落盘')

    // resolve both：两版都要（theirs 换新 id）
    const res = await resolveConflict({ dir: dev.B.dir, index: 1, choice: 'both' })
    assert.equal(res.ok, true)
    const bTodo = readFileSync(join(dev.B.dir, 'TODOS.md'), 'utf8')
    assert.ok(bTodo.includes('A 改的版本') && bTodo.includes('B 改的版本'), '两版都应保留')
    assert.equal(countConflicts(dev.B.dir), 0)
    // header 仍保留
    assert.ok(bTodo.startsWith('<!--'))

    // B 推送 → A 收敛一致
    git(dev.B.dir, ['push', '-q', bare, `main:${branch}`])
    const r2 = await runSync({ dir: dev.A.dir, remoteBranch: branch })
    assert.equal(r2.ok, true)
    const aTodo = readFileSync(join(dev.A.dir, 'TODOS.md'), 'utf8')
    assert.ok(aTodo.includes('A 改的版本') && aTodo.includes('B 改的版本'), 'A 应拿到 resolve 后的两版')
    assert.equal(countConflicts(dev.A.dir), 0)
  } finally {
    clean(root)
  }
})
