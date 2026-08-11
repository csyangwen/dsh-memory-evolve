/**
 * tests/sync-worker.test.js — sync 主流程集成测试（施工图 §7 第 5 步验收）
 *
 * 真实 git + 裸仓库远端，双设备（各自独立记忆目录）场景：
 *   - 双向同步并集（各自新增都保留）
 *   - 单侧修改采用 + push 全流程
 *   - 双侧改同一条 → conflict（CONFLICTS.md 侧车，冲突条目不落盘）
 *   - merge-base 降级 → 退出码 3（绝不自动覆盖）
 *   - PROVENANCE 身份不匹配 → 退出码 3
 *   - status 基础状态
 *   - scripts/sync-worker.mjs 入口（stdout 单行 JSON + 退出码）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ensureMemoryRepo, deviceBConnect } from '../lib/sync/repo.js'
import { resolveProjectId } from '../lib/sync/identity.js'
import { runSync, runStatus, countConflicts } from '../lib/sync/worker.js'

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-sync-worker-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

function git(dir, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`)
  return String(r.stdout ?? '').trim()
}

/** 搭一套双设备环境（各自 memoryDir + 主仓库工作目录，同一 remote）。 */
function setupDevices(root, remoteUrl) {
  const bare = join(root, 'bare.git')
  mkdirSync(bare, { recursive: true })
  git(bare, ['init', '-q', '--bare'])
  const devices = {}
  for (const name of ['A', 'B']) {
    const cwd = join(root, `work${name}`)
    mkdirSync(cwd, { recursive: true })
    git(cwd, ['init', '-q', '-b', 'main'])
    git(cwd, ['remote', 'add', 'origin', remoteUrl])
    devices[name] = {
      cwd,
      memoryDir: join(root, `memories${name}`),
      identity: resolveProjectId(cwd),
    }
    devices[name].dir = join(devices[name].memoryDir, 'projects', devices[name].identity.id)
  }
  return { bare, devices }
}

/** 设备 A 初始化 + 写记忆 + 提交 + push（模拟用户同意后的首次推送）。 */
async function deviceABootstrap({ bare, devices, keyLines }) {
  const A = devices.A
  const boot = await ensureMemoryRepo({ dir: A.dir, memoryDir: A.memoryDir, cwd: A.cwd, projectId: A.identity.id, displayName: A.identity.displayName, remoteUrl: A.identity.remoteUrl })
  assert.equal(boot.ok, true)
  if (keyLines) writeFileSync(join(A.dir, 'KEY.md'), keyLines.join('\n§\n') + '\n')
  git(A.dir, ['add', '-A'])
  git(A.dir, ['commit', '-q', '-m', 'memory: initial'])
  git(A.dir, ['push', '-q', bare, 'main:dsh-shared/memory'])
  // 记忆仓库的 origin 指向可访问的裸仓库（模拟真实远端；cwd 的 origin 仍是
  // https 假 URL 用于身份——身份与传输通道分离）
  git(A.dir, ['remote', 'set-url', 'origin', bare])
}

const skip = !gitAvailable()
const RB = 'dsh-shared/memory'
const KEY = (lines) => lines.join('\n§\n') + '\n'

/* ---------------- 双向同步 ---------------- */

test('双向同步并集：A/B 各自新增都保留', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, devices } = setupDevices(root, 'https://example.com/acme/alpha.git')
    const A = devices.A
    const B = devices.B
    assert.equal(A.identity.id, B.identity.id, '同一 remote → 同身份')
    await deviceABootstrap({ bare, devices, keyLines: ['[id:aaaa0000] [2026-08-10] A 的条目一', '[id:aaaa0001] [2026-08-10] A 的条目二'] })

    // B 接入
    const connect = await deviceBConnect({ dir: B.dir, remoteUrl: bare, remoteBranch: RB })
    assert.equal(connect.mode, 'adopt')
    // B 本地新增一条（工作树直接改，不 commit——写记忆不碰 git）
    writeFileSync(join(B.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] A 的条目一', '[id:aaaa0001] [2026-08-10] A 的条目二', '[id:bbbb0000] [2026-08-10] B 本地新增']))
    // B 首次 sync（拉取+合并+推送；本地空提交 + 远端全量 = 并集）
    const r1 = await runSync({ dir: B.dir, remoteBranch: RB, push: true })
    assert.equal(r1.ok, true)
    assert.equal(r1.code, 0)
    assert.equal(r1.committed, true)
    const bKey = readFileSync(join(B.dir, 'KEY.md'), 'utf8')
    assert.ok(bKey.includes('A 的条目一') && bKey.includes('A 的条目二') && bKey.includes('B 本地新增'), 'B 应拿到远端全量 + 本地新增')

    // A 再 sync 拿到 B 的条目
    const r2 = await runSync({ dir: A.dir, remoteBranch: RB })
    assert.equal(r2.ok, true)
    assert.ok(readFileSync(join(A.dir, 'KEY.md'), 'utf8').includes('B 本地新增'), 'A 应拿到 B 的新增')
  } finally {
    clean(root)
  }
})

test('单侧修改采用 + push 全流程（显式 refspec）', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, devices } = setupDevices(root, 'https://example.com/acme/alpha.git')
    const A = devices.A
    const B = devices.B
    await deviceABootstrap({ bare, devices, keyLines: ['[id:aaaa0000] [2026-08-10] 原始内容'] })
    await deviceBConnect({ dir: B.dir, remoteUrl: bare, remoteBranch: RB })

    // A 修改条目并推送（模拟用户 /memory sync --push）
    writeFileSync(join(A.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] A 修改后的内容']))
    git(A.dir, ['add', '-A'])
    git(A.dir, ['commit', '-q', '-m', 'memory: edit'])
    git(A.dir, ['push', '-q', bare, 'main:dsh-shared/memory'])

    // B sync --push：采用 A 的单侧修改 + B 本地新增保留 + push 成功
    writeFileSync(join(B.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] 原始内容', '[id:bbbb0000] [2026-08-10] B 的新条目']))
    const r = await runSync({ dir: B.dir, remoteBranch: RB, push: true })
    assert.equal(r.ok, true)
    assert.equal(r.code, 0)
    assert.equal(r.committed, true)
    const bKey = readFileSync(join(B.dir, 'KEY.md'), 'utf8')
    assert.ok(bKey.includes('A 修改后的内容'), 'B 应采用 A 的单侧修改')
    assert.ok(bKey.includes('B 的新条目'), 'B 本地新增保留')
    // push 后远端应有 B 的条目
    const remoteKey = git(bare, ['show', 'refs/heads/dsh-shared/memory:KEY.md'])
    assert.ok(remoteKey.includes('B 的新条目'), '远端应含 B 的推送')
  } finally {
    clean(root)
  }
})

/* ---------------- 冲突 ---------------- */

test('双侧改同一条：conflict 进人工，冲突条目不落盘，CONFLICTS.md 生成', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, devices } = setupDevices(root, 'https://example.com/acme/alpha.git')
    const A = devices.A
    const B = devices.B
    await deviceABootstrap({ bare, devices, keyLines: ['[id:aaaa0000] [2026-08-10] 共同祖先内容'] })
    await deviceBConnect({ dir: B.dir, remoteUrl: bare, remoteBranch: RB })

    // A 改 → push
    writeFileSync(join(A.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] A 的版本']))
    git(A.dir, ['add', '-A'])
    git(A.dir, ['commit', '-q', '-m', 'memory: A edit'])
    git(A.dir, ['push', '-q', bare, 'main:dsh-shared/memory'])

    // B 改同一条（不同内容）
    writeFileSync(join(B.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] B 的版本']))
    const r = await runSync({ dir: B.dir, remoteBranch: RB })
    assert.equal(r.ok, true)
    assert.equal(r.conflicts, 1)
    assert.equal(r.stats.conflicts, 1)
    // CONFLICTS.md 生成且含三版本
    const conflictsDoc = readFileSync(join(B.dir, 'CONFLICTS.md'), 'utf8')
    assert.match(conflictsDoc, /aaaa0000/)
    assert.ok(conflictsDoc.includes('共同祖先内容') && conflictsDoc.includes('A 的版本') && conflictsDoc.includes('B 的版本'))
    // 冲突条目不落盘（KEY.md 无该条）
    const bKey = readFileSync(join(B.dir, 'KEY.md'), 'utf8')
    assert.ok(!bKey.includes('aaaa0000'), '冲突条目不进工作树')
    assert.equal(countConflicts(B.dir), 1)
  } finally {
    clean(root)
  }
})

/* ---------------- 降级路径 ---------------- */

test('merge-base 降级：历史无法对齐 → 退出码 3，本地零影响', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, devices } = setupDevices(root, 'https://example.com/acme/alpha.git')
    const B = devices.B
    await deviceABootstrap({ bare, devices, keyLines: ['[id:aaaa0000] [2026-08-10] 原始内容'] })
    await deviceBConnect({ dir: B.dir, remoteUrl: bare, remoteBranch: RB })
    // 制造无共同祖先：B 在孤儿分支上建新根提交（保留 PROVENANCE——它是
    // 项目身份，现实中不会随历史被删；isProjectSyncEnabled 依赖它）。
    // 同步锚定 refs/heads/main——孤儿提交必须落到 main 上（runSync 按
    // 本地分支 ref 工作，不再依赖 HEAD）
    const bProv = readFileSync(join(B.dir, 'PROVENANCE'), 'utf8')
    git(B.dir, ['checkout', '-q', '--orphan', 'tmp'])
    git(B.dir, ['rm', '-q', '-r', '--cached', '.'])
    git(B.dir, ['clean', '-q', '-fd'])
    writeFileSync(join(B.dir, 'KEY.md'), KEY(['[id:cccc0000] [2026-08-10] 无关历史']))
    writeFileSync(join(B.dir, 'PROVENANCE'), bProv)
    git(B.dir, ['add', '-A'])
    git(B.dir, ['commit', '-q', '-m', 'memory: orphan'])
    git(B.dir, ['branch', '-f', 'main']) // main 指向孤儿提交
    git(B.dir, ['checkout', '-q', 'main'])
    const r = await runSync({ dir: B.dir, remoteBranch: RB })
    assert.equal(r.ok, false)
    assert.equal(r.code, 3)
    assert.match(r.message, /历史无法对齐/)
    // 本地零影响：工作树 KEY.md 未被合并改写
    assert.ok(readFileSync(join(B.dir, 'KEY.md'), 'utf8').includes('无关历史'))
  } finally {
    clean(root)
  }
})

test('PROVENANCE 身份不匹配 → 退出码 3（拒绝合并）', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, devices } = setupDevices(root, 'https://example.com/acme/alpha.git')
    const B = devices.B
    await deviceABootstrap({ bare, devices, keyLines: ['[id:aaaa0000] [2026-08-10] 原始内容'] })
    await deviceBConnect({ dir: B.dir, remoteUrl: bare, remoteBranch: RB })
    // 篡改 B 的 PROVENANCE（模拟接错仓库）
    writeFileSync(join(B.dir, 'PROVENANCE'), JSON.stringify({ projectId: 'ffffffffffff', displayName: '别家项目', version: 1 }) + '\n')
    const r = await runSync({ dir: B.dir, remoteBranch: RB })
    assert.equal(r.ok, false)
    assert.equal(r.code, 3)
    // 严格化后的消息（Codex P0-1）：本地/远端身份不一致一律拒绝
    assert.match(r.message, /身份/)
  } finally {
    clean(root)
  }
})

/* ---------------- status 与入口 ---------------- */

test('runStatus：基础状态（initialized/behind/ahead/uncommitted/conflicts）', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, devices } = setupDevices(root, 'https://example.com/acme/alpha.git')
    const A = devices.A
    const B = devices.B
    // 未初始化
    const s0 = await runStatus({ dir: join(root, 'nonexistent', 'x'), remoteBranch: RB })
    assert.equal(s0.status.initialized, false)
    await deviceABootstrap({ bare, devices, keyLines: ['[id:aaaa0000] [2026-08-10] 原始内容'] })
    // A 有一处未提交修改
    writeFileSync(join(A.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] 原始内容', '[id:dddd0000] [2026-08-10] 未提交']))
    const s1 = await runStatus({ dir: A.dir, remoteBranch: RB })
    assert.equal(s1.status.initialized, true)
    assert.equal(s1.status.uncommitted, 1)
    assert.ok(s1.status.behind === 0 || s1.status.ahead === 0)
  } finally {
    clean(root)
  }
})

test('scripts/sync-worker.mjs 入口：stdout 单行 JSON + 退出码', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, devices } = setupDevices(root, 'https://example.com/acme/alpha.git')
    const B = devices.B
    await deviceABootstrap({ bare, devices, keyLines: ['[id:aaaa0000] [2026-08-10] 原始内容'] })
    await deviceBConnect({ dir: B.dir, remoteUrl: bare, remoteBranch: RB })
    writeFileSync(join(B.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] 原始内容', '[id:eeee0000] [2026-08-10] B 的新条目']))
    const script = join(process.cwd(), 'scripts', 'sync-worker.mjs')
    const r = spawnSync('node', [script, 'sync', B.dir, RB], { encoding: 'utf8', timeout: 60000 })
    assert.equal(r.status, 0, `退出码应 0：${r.stderr}`)
    const out = JSON.parse(r.stdout.trim().split('\n').pop())
    assert.equal(out.ok, true)
    assert.equal(out.committed, true)
    assert.equal(typeof out.message, 'string')
    // status 子命令
    const rs = spawnSync('node', [script, 'status', B.dir, RB], { encoding: 'utf8', timeout: 30000 })
    const sOut = JSON.parse(rs.stdout.trim())
    assert.equal(sOut.status.initialized, true)
  } finally {
    clean(root)
  }
})

/* ---------------- CRLF 自愈（2026-08-11 Windows autocrlf 事故修复） ---------------- */

test('CRLF 自愈：工作树被 Windows autocrlf 转 CRLF 后 sync 自动归一化（不再中止）', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, devices } = setupDevices(root, 'https://example.com/acme/alpha.git')
    const B = devices.B
    await deviceABootstrap({ bare, devices, keyLines: ['[id:aaaa0000] [2026-08-10] 原始内容'] })
    await deviceBConnect({ dir: B.dir, remoteUrl: bare, remoteBranch: RB })
    // 模拟 Windows git core.autocrlf=true 的 checkout 结果：KEY.md 全部 LF → CRLF
    const keyPath = join(B.dir, 'KEY.md')
    const lf = readFileSync(keyPath, 'utf8')
    writeFileSync(keyPath, lf.replace(/\n/g, '\r\n'))
    // 修复前：isCanonical 失败 → 中止（格式异常）；修复后：无损归一化 → 同步成功
    const r = await runSync({ dir: B.dir, remoteBranch: RB })
    assert.equal(r.ok, true, `CRLF 工作树应自愈而非中止：${r.message}`)
    assert.match(r.message, /归一化/)
    // 工作树已恢复 LF（合并写回）
    const after = readFileSync(keyPath, 'utf8')
    assert.ok(!after.includes('\r'), '写回后文件应为 LF')
    assert.ok(after.includes('原始内容'), '条目内容应完好')
  } finally {
    clean(root)
  }
})

test('CRLF 自愈：手工编辑的真·坏格式仍中止（备份 + 不重写）', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, devices } = setupDevices(root, 'https://example.com/acme/alpha.git')
    const B = devices.B
    await deviceABootstrap({ bare, devices, keyLines: ['[id:aaaa0000] [2026-08-10] 原始内容'] })
    await deviceBConnect({ dir: B.dir, remoteUrl: bare, remoteBranch: RB })
    // 手工编辑破坏：混合行尾（\r\n 与孤立 \r 并存）+ 缺尾部换行——
    // \r\n→\n 归一化后仍非 canonical（孤立 \r 保留、serialize 会补尾部
    // \n），与"纯 CRLF 污染"可区分 → 必须中止（不猜、不重写）
    const keyPath = join(B.dir, 'KEY.md')
    writeFileSync(keyPath, '条目A\r\n§\r\n条目B\n更多\r孤立')
    const r = await runSync({ dir: B.dir, remoteBranch: RB })
    assert.equal(r.ok, false)
    assert.equal(r.code, 3)
    assert.match(r.message, /格式异常/)
    // 原文件应被备份（.bak 存在）
    const baks = readdirSync(B.dir).filter((n) => n.includes('.bak.'))
    assert.ok(baks.length > 0, '坏格式文件应备份')
  } finally {
    clean(root)
  }
})
