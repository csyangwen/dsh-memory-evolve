/**
 * tests/sync-review-final.test.js — 上线前终审修复回归测试
 * （Grok / Codex / Kimi 三方终审问题修复的验证）
 *
 * 覆盖：
 *   - P0-1（Grok）：远端分支被删 + 本地陈旧 tracking → 报错不重建、数据不丢；
 *   - P1-1（Grok）：resolve 后 git tree 无幽灵 CONFLICTS.md、status 干净；
 *   - P0-3（Codex）/ P0-1（Kimi）：多行冲突内容无损往返；
 *   - P0-2（Codex）：非 canonical（CRLF）本地文件 → sync 中止 + 备份，不改写；
 *   - P0-5（Codex）：KEY 与 TODOS 同 id 不互撞（命名空间）；
 *   - P1-5（Kimi）：off 后 setup 重新启用 → enabled 复位；
 *   - P1-4（Kimi）：已接入项目重复 setup 幂等（非空守卫不再误杀）；
 *   - P1-3（Codex）：树相同但历史分叉 → 双父提交收敛；
 *   - P1-5（Codex）：未初始化项目（无 PROVENANCE）不生成身份证。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ensureMemoryRepo, deviceBConnect } from '../lib/sync/repo.js'
import { resolveProjectId } from '../lib/sync/identity.js'
import { runSync, resolveConflict, countConflicts, parseConflicts } from '../lib/sync/worker.js'
import { mergeEntries } from '../lib/sync/merge.js'
import { handleCommand, projectSyncInfo } from '../lib/sync/index.js'
import { isProjectSyncEnabled } from '../lib/store.js'

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-review-final-'))
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
const KEY = (lines) => lines.join('\n§\n') + '\n'

/** 搭双设备（A bootstrap+push 初始记忆；B adopt）。返回 bare 与 A/B。 */
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
  const branch = `dsh-shared/${A.identity.id}`
  const boot = await ensureMemoryRepo({ dir: A.dir, memoryDir: A.memoryDir, cwd: A.cwd, projectId: A.identity.id, displayName: A.identity.displayName, remoteUrl: A.identity.remoteUrl, remoteBranch: branch })
  assert.equal(boot.ok, true)
  writeFileSync(join(A.dir, 'KEY.md'), KEY(initialKey))
  git(A.dir, ['add', '-f', '--', 'KEY.md'])
  git(A.dir, ['commit', '-q', '-m', 'memory: initial'])
  git(A.dir, ['push', '-q', bare, `main:${branch}`])
  git(A.dir, ['remote', 'set-url', 'origin', bare])
  const connect = await deviceBConnect({ dir: B.dir, remoteUrl: bare, remoteBranch: branch, expectedProjectId: A.identity.id })
  assert.equal(connect.mode, 'adopt')
  return { bare, dev, branch }
}

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

/* ---------------- P0-1（Grok）：远端分支被删 ---------------- */

test('远端分支被删 + 本地陈旧 tracking → sync 报错、不重建分支、本地数据不丢', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, dev, branch } = await setupE2E(root)
    const r0 = await runSync({ dir: dev.B.dir, remoteBranch: branch })
    assert.equal(r0.ok, true)
    // 远端分支被删（模拟远端被清）
    git(bare, ['update-ref', '-d', `refs/heads/${branch}`])
    // B 本地有新记忆（工作树变化）——陈旧 tracking 场景必须拦截而非
    // "首次推送"式静默重建/清空
    writeFileSync(join(dev.B.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] 初始条目', '[id:bbbb0000] [2026-08-10] B 本地新增']))
    const r = await runSync({ dir: dev.B.dir, remoteBranch: branch })
    assert.equal(r.ok, false)
    assert.equal(r.code, 1)
    assert.match(r.message, /已不存在/)
    // 本地数据零改动
    assert.ok(readFileSync(join(dev.B.dir, 'KEY.md'), 'utf8').includes('B 本地新增'))
  } finally {
    clean(root)
  }
})

/* ---------------- P1-1（Grok）：resolve 后无幽灵 CONFLICTS ---------------- */

test('resolve 后 git tree 无 CONFLICTS.md、status 干净（无幽灵文件）', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, dev, branch } = await setupE2E(root)
    const r0 = await runSync({ dir: dev.B.dir, remoteBranch: branch })
    assert.equal(r0.ok, true)
    // A 推送修改；B 本地改同一条 → 冲突
    writeFileSync(join(dev.A.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] A 版本']))
    git(dev.A.dir, ['add', '-f', '--', 'KEY.md'])
    git(dev.A.dir, ['commit', '-q', '-m', 'memory: A edit'])
    git(dev.A.dir, ['push', '-q', bare, `main:${branch}`])
    writeFileSync(join(dev.B.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] B 版本']))
    const r1 = await runSync({ dir: dev.B.dir, remoteBranch: branch })
    assert.equal(r1.conflicts, 1)
    // resolve ours → 提交
    const res = await resolveConflict({ dir: dev.B.dir, index: 1, choice: 'ours' })
    assert.equal(res.ok, true)
    // HEAD 树里不得再有 CONFLICTS.md（幽灵）
    const inTree = git(dev.B.dir, ['ls-tree', '-r', '--name-only', 'HEAD'])
    assert.ok(!inTree.split('\n').includes('CONFLICTS.md'), 'HEAD 树不应有 CONFLICTS.md')
    // git status 干净（无 D CONFLICTS.md 残留）
    assert.equal(git(dev.B.dir, ['status', '--porcelain']), '', 'status 应干净')
  } finally {
    clean(root)
  }
})

/* ---------------- P0-3（Codex）/ P0-1（Kimi）：多行冲突无损 ---------------- */

test('多行条目冲突 → CONFLICTS.md 无损编码 → resolve 写回完整多行正文', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, dev, branch } = await setupE2E(root)
    const r0 = await runSync({ dir: dev.B.dir, remoteBranch: branch })
    assert.equal(r0.ok, true)
    // 多行记忆条目（正文含换行与 Markdown 结构）
    const aVersion = '[id:aaaa0000] [2026-08-10] A 的多行版本\n第二行内容\n- 列表项\n## 小标题'
    const bVersion = '[id:aaaa0000] [2026-08-10] B 的多行版本\nB 第二行\nB 第三行'
    writeFileSync(join(dev.A.dir, 'KEY.md'), KEY([aVersion]))
    git(dev.A.dir, ['add', '-f', '--', 'KEY.md'])
    git(dev.A.dir, ['commit', '-q', '-m', 'memory: A multi'])
    git(dev.A.dir, ['push', '-q', bare, `main:${branch}`])
    writeFileSync(join(dev.B.dir, 'KEY.md'), KEY([bVersion]))
    const r1 = await runSync({ dir: dev.B.dir, remoteBranch: branch })
    assert.equal(r1.conflicts, 1)
    // 侧车可解析且内容无损（多行全文还原）
    const parsed = parseConflicts(readFileSync(join(dev.B.dir, 'CONFLICTS.md'), 'utf8'))
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].ours, bVersion, 'ours 应无损还原多行全文')
    assert.equal(parsed[0].theirs, aVersion, 'theirs 应无损还原多行全文')
    // resolve ours → 写回完整多行正文
    const res = await resolveConflict({ dir: dev.B.dir, index: 1, choice: 'ours' })
    assert.equal(res.ok, true)
    const bKey = readFileSync(join(dev.B.dir, 'KEY.md'), 'utf8')
    assert.ok(bKey.includes('B 的多行版本\nB 第二行\nB 第三行'), '多行正文应完整写回')
    assert.equal(countConflicts(dev.B.dir), 0)
  } finally {
    clean(root)
  }
})

/* ---------------- P0-2（Codex）：非 canonical 文件中止（2026-08-11 语义细化） ----------------
 * 纯 CRLF（git autocrlf 污染，\r\n→\n 无损可往返）→ 自愈成功，不再中止；
 * 真·手工编辑/混合行尾（\r\n→\n 后仍不能往返）→ 仍按 P0-2 中止+备份。
 * 后者用例见 tests/sync-worker.test.js「CRLF 自愈：手工编辑的真·坏格式仍中止」。 */

test('本地纯 CRLF 记忆文件 → sync 自愈成功（LF 归一化，不再中止）', { skip }, async () => {
  const root = tempDir()
  try {
    const { dev, branch } = await setupE2E(root)
    // 把 B 的 KEY.md 写成纯 CRLF（模拟 Windows git core.autocrlf=true checkout 产物）
    writeFileSync(join(dev.B.dir, 'KEY.md'), '[id:aaaa0000] [2026-08-10] 初始条目\r\n§\r\n[id:cccc0000] [2026-08-10] CRLF 条目\r\n')
    const r = await runSync({ dir: dev.B.dir, remoteBranch: branch })
    assert.equal(r.ok, true, `纯 CRLF 应自愈而非中止：${r.message}`)
    assert.match(r.message, /归一化/)
    // 写回后为 LF（无 \r），条目分隔符完好
    const after = readFileSync(join(dev.B.dir, 'KEY.md'), 'utf8')
    assert.ok(!after.includes('\r'), '自愈后应为 LF')
    assert.ok(after.includes('§'), '条目分隔符应完好')
  } finally {
    clean(root)
  }
})

/* ---------------- P0-5（Codex）：TODO/记忆 ID 命名空间 ---------------- */

test('KEY 与 TODOS 同 id 不互撞（命名空间隔离）', { skip }, () => {
  // 纯合并器测试：KEY.md 与 TODOS.md 各有一条 id=aaaa0000 的条目，三侧相同
  const files = {
    'KEY.md': ['[id:aaaa0000] [2026-08-10] 记忆条目'],
    'TODOS.md': ['[2026-08-11 09:00] [id: aaaa0000] [q2] 待办条目'],
  }
  const result = mergeEntries(files, files, files)
  assert.equal(result.conflicts.length, 0, '不同命名空间同 id 不应冲突')
  assert.deepEqual(result.files['KEY.md'], ['[id:aaaa0000] [2026-08-10] 记忆条目'])
  assert.deepEqual(result.files['TODOS.md'], ['[2026-08-11 09:00] [id: aaaa0000] [q2] 待办条目'], 'TODOS 条目不应被记忆条目顶掉')
})

/* ---------------- P1-5（Kimi）：off 后 setup 重新启用 ---------------- */

test('off 停用后 setup 重新启用 → enabled 复位、sync 可用', { skip }, async () => {
  const root = tempDir()
  try {
    const { dev, branch } = await setupE2E(root)
    const A = dev.A
    const rt = mockRuntime(true)
    const cfg = { memoryDir: A.memoryDir }
    // off → enabled=false
    const off = await handleCommand('off', [], A.cwd, { config: cfg, ...rt })
    assert.equal(off.kind, 'success')
    assert.equal(projectSyncInfo(cfg, A.cwd).provenance.enabled, false)
    // setup 重新启用（远端分支存在 → adopt 幂等路径）→ enabled 复位
    const setup = await handleCommand('setup', [], A.cwd, { config: cfg, ...rt })
    assert.equal(setup.kind, 'success')
    const info = projectSyncInfo(cfg, A.cwd)
    assert.equal(info.provenance.enabled, true, 'setup 应复位项目级 enabled')
    // sync 可用
    const sync = await handleCommand('sync', [], A.cwd, { config: cfg, ...rt })
    assert.equal(sync.kind, 'success')
  } finally {
    clean(root)
  }
})

/* ---------------- P1-4（Kimi）：重复 setup 幂等 ---------------- */

test('已接入项目重复 setup 幂等成功（非空目录守卫不误杀）', { skip }, async () => {
  const root = tempDir()
  try {
    const { dev } = await setupE2E(root)
    const A = dev.A
    const rt = mockRuntime(true)
    const setup = await handleCommand('setup', [], A.cwd, { config: { memoryDir: A.memoryDir }, ...rt })
    assert.equal(setup.kind, 'success')
    assert.match(setup.text, /已接入|幂等/)
    assert.ok(!/清空目录/.test(setup.text), '不得再引导"清空目录"')
  } finally {
    clean(root)
  }
})

/* ---------------- P1-3（Codex）：同树分叉收敛 ---------------- */

test('树相同但历史分叉 → 双父提交收敛，push 成功', { skip }, async () => {
  const root = tempDir()
  try {
    const { bare, dev, branch } = await setupE2E(root)
    const A = dev.A
    const B = dev.B
    // A 提交 C2（内容 X）并推送
    writeFileSync(join(A.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] 内容X']))
    git(A.dir, ['add', '-f', '--', 'KEY.md'])
    git(A.dir, ['commit', '-q', '-m', 'memory: C2'])
    git(A.dir, ['push', '-q', bare, `main:${branch}`])
    // B 的 HEAD 还停在 adopt 时的旧提交；B 修改成**同样的树**（内容 X）→
    // 新提交 C3（父=旧提交，与 C2 分叉但树相同）
    writeFileSync(join(B.dir, 'KEY.md'), KEY(['[id:aaaa0000] [2026-08-10] 内容X']))
    git(B.dir, ['add', '-f', '--', 'KEY.md'])
    git(B.dir, ['commit', '-q', '-m', 'memory: C3'])
    // B sync：树无变化但远端非祖先 → 必须建双父提交（否则 ahead/behind 死锁）
    const r = await runSync({ dir: B.dir, remoteBranch: branch })
    assert.equal(r.ok, true)
    assert.equal(r.committed, true, '分叉场景必须产生收敛提交')
    // push 成功（non-fast-forward 死锁解除）
    const push = await runSync({ dir: B.dir, remoteBranch: branch, push: true })
    assert.equal(push.ok, true)
  } finally {
    clean(root)
  }
})

/* ---------------- P1-5（Codex）：未初始化项目不生成身份证 ---------------- */

test('未初始化项目（无 PROVENANCE）→ isProjectSyncEnabled=false；显式 enabled=true → true', { skip }, () => {
  const root = tempDir()
  try {
    const memoryDir = join(root, 'memories')
    const dir = join(memoryDir, 'projects', 'ab12cd34ef56')
    mkdirSync(dir, { recursive: true })
    // 无 PROVENANCE = 未初始化 = 不启用（不再"缺失=默认启用"）
    assert.equal(isProjectSyncEnabled(dir), false)
    // enabled=false 显式停用
    writeFileSync(join(dir, 'PROVENANCE'), JSON.stringify({ projectId: 'ab12cd34ef56', enabled: false }) + '\n')
    assert.equal(isProjectSyncEnabled(dir), false)
    // enabled=true 启用
    writeFileSync(join(dir, 'PROVENANCE'), JSON.stringify({ projectId: 'ab12cd34ef56', enabled: true }) + '\n')
    assert.equal(isProjectSyncEnabled(dir), true)
  } finally {
    clean(root)
  }
})
