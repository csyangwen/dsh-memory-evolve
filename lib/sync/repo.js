/**
 * lib/sync/repo.js — 记忆仓库操作（施工图 §7 第 3 步）
 *
 * 职责：把 `~/.dsh/memories/projects/<projectId>/` 变成（或接入）一个普通
 * 独立 git 仓库（用户拍板需求 #3：本地独立仓库，弃 worktree，全版本兼容）。
 *
 *   - ensureMemoryRepo：设备 A 初始化 / 设备 B 判定树"分支不存在"分支共用
 *     ——init + 仓库级身份 + .gitignore + legacy 迁移 + entryId 补发 +
 *     PROVENANCE + 首次提交 + remote 挂载；
 *   - deviceBConnect：设备 B 判定树（Grok 评审规范，施工图 §5）——
 *     ls-remote 试探远端三分支：分支存在→fetch+checkout 接入；分支不存在→
 *     回 bootstrap；失败→分类报错、不自动初始化、不破坏本地。
 *
 * 工程约束（施工图 §8）：
 *   - **网络命令一律 GIT_TERMINAL_PROMPT=0**（凭证缺失不卡死进程）；
 *   - git 全部走 node:child_process 异步 spawn（绝不 spawnSync 网络命令）；
 *   - 本地 git 命令毫秒级、锁外执行；与 MemoryStore 写操作互斥的部分
 *     （legacy 迁移 rename、entryId 补发写回）在 withLock 内同步执行；
 *   - 补发只动记忆文件白名单（KEY.md / KEY-archive.md / MEMORY.md /
 *     logs/*.md）——TODOS.md 等外部模块文件不碰。
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEntries, serializeEntries, withLock } from '../store.js'
import { ensureEntryIds } from './entryid.js'
import { locateLegacyDir } from './identity.js'

/** 网络命令超时（30s，GIT_TERMINAL_PROMPT=0 防凭证卡死）。 */
const NETWORK_TIMEOUT_MS = 30_000
/** 本地命令超时（10s）。 */
const LOCAL_TIMEOUT_MS = 10_000

/** 记忆文件白名单（bootstrap 补发只处理这些；TODOS.md 等外部格式不碰）。 */
const MEMORY_FILE_NAMES = new Set(['KEY.md', 'KEY-archive.md', 'MEMORY.md'])

/** 仓库级兜底身份（不依赖用户全局 git 配置；施工图 §5 步骤 4）。 */
const REPO_USER = { name: 'dsh-memory', email: 'dsh@localhost' }

/** PROVENANCE 文件格式版本（未来字段变更走版本迁移）。 */
const PROVENANCE_VERSION = 1

/**
 * 异步执行 git 命令（所有 git 操作统一入口）。
 * @param {string} dir - 命令工作目录（git -C 语义）。
 * @param {string[]} args - git 参数。
 * @param {object} [opts]
 * @param {boolean} [opts.network=false] - 网络命令：GIT_TERMINAL_PROMPT=0 +
 *   网络超时；本地命令给本地超时。
 * @returns {Promise<{ok: boolean, code: number | null, stdout: string, stderr: string}>}
 */
export function runGit(dir, args, opts = {}) {
  const network = opts.network === true
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: dir,
      env: network ? { ...process.env, GIT_TERMINAL_PROMPT: '0' } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, code: null, stdout, stderr: `${error.message}\n${stderr}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr })
    })
  })
}

/**
 * 设备 A 初始化 / 设备 B 空分支引导（施工图 §5）。
 *
 * 全程幂等：重复调用（已 init、已 commit、origin 已存在）安全跳过。
 * 网络命令只有最后的 ls-remote 试探（失败不阻断，仅影响 push 提示）。
 *
 * @param {object} p
 * @param {string} p.dir - 记忆仓库目录（<memoryDir>/projects/<projectId>）。
 * @param {string} p.memoryDir - 记忆根目录（迁移回查用）。
 * @param {string} p.cwd - 会话工作目录（迁移回查用）。
 * @param {string} p.projectId - 项目身份 id（12 hex）。
 * @param {string} p.displayName - 可读身份名（写入 PROVENANCE）。
 * @param {string} p.remoteUrl - 远端 URL（模式 A=主仓库 origin；模式 B=用户指定）。
 * @param {string} [p.remoteBranch='dsh-shared/memory'] - 远端分支名（模式 A
 *   命名空间分支；模式 B='main'）——写入 PROVENANCE，运行期读取。
 * @returns {Promise<{ok: boolean, message: string, committed: boolean,
 *   backfilled: number, migratedFrom: string | null,
 *   remoteBranchExists: boolean | null}>}
 */
export async function ensureMemoryRepo({ dir, memoryDir, cwd, projectId, displayName, remoteUrl, remoteBranch = 'dsh-shared/memory' }) {
  const report = { ok: true, message: '', committed: false, backfilled: 0, migratedFrom: null, remoteBranchExists: null }

  // ── 0. legacy 迁移（锁内，同步）：旧 projectHash(cwd) 目录 → 并入新目录 ──
  // 项目此前无 remote（fallback 身份）后来加了 remote → 身份变化 → 旧目录
  // 需要并入新目录（施工图 §5 步骤 2）。互斥对象是"旧目录上的 store 写"，
  // 所以锁必须取 legacyDir（withLock(dir) 会在 dir 里创建锁文件，反而让
  // rename 目标非空 → ENOTEMPTY）。
  const legacyDir = locateLegacyDir(memoryDir, cwd, projectId)
  if (legacyDir !== null) {
    try {
      withLock(legacyDir, () => {
        if (existsSync(dir)) {
          // 目标已存在：仅锁文件残留 → 清掉后整目录 rename；有真实内容
          // （上次迁移失败的手动残留）→ 逐文件并入，绝不覆盖已有文件
          const hasContent = readdirSync(dir).some((n) => n !== '.memory.lock')
          if (hasContent) {
            for (const name of readdirSync(legacyDir)) {
              const src = join(legacyDir, name)
              if (name === '.memory.lock') continue
              if (statSync(src).isFile() && !existsSync(join(dir, name))) {
                renameSync(src, join(dir, name))
              }
            }
            rmSync(legacyDir, { recursive: true, force: true })
          } else {
            rmSync(dir, { recursive: true, force: true })
            renameSync(legacyDir, dir)
          }
        } else {
          renameSync(legacyDir, dir)
        }
      })
    } catch (error) {
      // 迁移失败：绝不继续——先报错让用户人工处理，防止两套目录并存
      // 导致记忆分裂
      return {
        ok: false,
        message: `记忆目录迁移失败：${error?.message ?? String(error)}。请人工检查 ${memoryDir}/projects/ 下是否有两个同项目目录后重试。`,
        committed: false, backfilled: 0, migratedFrom: null, remoteBranchExists: null,
      }
    }
    // rename 会把 legacyDir 的锁文件一起带走 → 清掉新目录里的残留
    rmSync(join(dir, '.memory.lock'), { force: true })
    report.migratedFrom = legacyDir
  }

  // ── 1. 目录与 git 初始化 ──
  mkdirSync(dir, { recursive: true })
  await runGit(dir, ['init', '-q'])
  // 分支名统一 main（施工图 §2）：git < 2.28 无 `init -b`，统一用
  // symbolic-ref 兜底——只在 HEAD 未指向有效分支时设置（重复 bootstrap 安全）。
  const headBranch = await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!headBranch.ok || headBranch.stdout.trim() === 'HEAD') {
    await runGit(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  }

  // ── 2. 仓库级兜底身份（已存在则跳过，施工图 §5 步骤 4）──
  const userName = await runGit(dir, ['config', 'user.name'])
  if (!userName.ok || userName.stdout.trim() === '') {
    await runGit(dir, ['config', 'user.name', REPO_USER.name])
    await runGit(dir, ['config', 'user.email', REPO_USER.email])
  }

  // ── 3. .gitignore（先于 add；.memory.lock 与临时文件永不入库）──
  const gitignorePath = join(dir, '.gitignore')
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, '.memory.lock\n*.tmp.*\n')
  }

  // ── 4. entryId 补发（锁内，同步）：白名单记忆文件全 ID ──
  // 老记忆没有身份证 → 确定性补发（sha1 内容归一化前 8 位，双设备一致），
  // 保证工作树始终全 ID（施工图 §4.6）。补发只动白名单文件。
  withLock(dir, () => {
    report.backfilled = backfillEntryIds(dir)
  })

  // ── 5. PROVENANCE：一行 JSON（合并前校验 projectId 用，施工图 §9）──
  const provenancePath = join(dir, 'PROVENANCE')
  const existing = existsSync(provenancePath) ? readFileSync(provenancePath, 'utf8').trim() : ''
  if (existing === '') {
    const meta = { projectId, displayName, version: PROVENANCE_VERSION, remoteBranch }
    if (report.migratedFrom) meta.migratedFrom = report.migratedFrom
    writeFileSync(provenancePath, `${JSON.stringify(meta)}\n`)
  }

  // ── 6. 首次提交（无变化跳过）──
  await runGit(dir, ['add', '-A'])
  const staged = await runGit(dir, ['diff', '--cached', '--quiet'])
  if (!staged.ok) {
    const stamp = new Date().toISOString().slice(0, 10)
    const commit = await runGit(dir, ['commit', '-q', '-m', `memory: initial import ${stamp}`])
    report.committed = commit.ok
  }

  // ── 7. remote 挂载（模式 A/B 共用：origin 已存在则跳过）──
  const origin = await runGit(dir, ['remote', 'get-url', 'origin'])
  if (!origin.ok || origin.stdout.trim() === '') {
    await runGit(dir, ['remote', 'add', 'origin', remoteUrl])
  }

  // ── 8. 试探远端分支是否存在（网络，可失败）→ 决定 push 提示 ──
  const ls = await runGit(dir, ['ls-remote', 'origin', 'refs/heads/dsh-shared/memory', 'refs/heads/main'], { network: true })
  const found = ls.ok && ls.stdout.trim() !== ''
  report.remoteBranchExists = ls.ok ? found : null // null = 试探失败（无网络等）

  const bits = []
  if (report.migratedFrom) bits.push(`已迁移旧记忆目录（${report.migratedFrom} → ${dir}）`)
  if (report.backfilled > 0) bits.push(`为 ${report.backfilled} 条老记忆补发身份证`)
  if (report.committed) bits.push('已建立首次提交')
  report.message = bits.length > 0 ? bits.join('；') : '记忆仓库已就绪（无变化）'
  return report
}

/**
 * 设备 B 接入判定树（Grok 评审规范，施工图 §5）：
 *   1. ls-remote 试探远端分支（GIT_TERMINAL_PROMPT=0，30s 超时）；
 *   2. 分支存在 → fetch + checkout 接入，记忆立即可用；
 *   3. 分支不存在 → 返回 bootstrap-needed（调用方走 ensureMemoryRepo）；
 *   4. 失败 → 分类报错（凭证/网络/仓库不存在），**不自动初始化、不破坏本地**。
 *
 * @param {object} p
 * @param {string} p.dir - 目标记忆仓库目录。
 * @param {string} p.remoteUrl - 远端 URL（主仓库 origin 或模式 B 指定）。
 * @param {string} p.remoteBranch - 远端分支名（模式 A=dsh-shared/memory；
 *   模式 B=main）。
 * @returns {Promise<{ok: boolean, mode: 'adopt' | 'bootstrap-needed' | 'error',
 *   message: string}>}
 */
export async function deviceBConnect({ dir, remoteUrl, remoteBranch }) {
  // 目录先建（ls-remote 的 cwd 必须存在；此时只是空目录，未 init 未 fetch，
  // 试探失败时本地零改动——"不破坏本地"）
  mkdirSync(dir, { recursive: true })

  // 试探分支（网络命令：凭证缺失/无网络都不会卡死）
  const probe = await runGit(dir, ['ls-remote', remoteUrl, `refs/heads/${remoteBranch}`], { network: true })

  if (!probe.ok) {
    // 失败分类（stderr 内容判别；GIT_TERMINAL_PROMPT=0 下凭证缺失直接报错）
    const err = probe.stderr
    let reason = '未知错误'
    if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(err)) {
      reason = '凭证缺失或认证失败'
    } else if (/Could not resolve host|Operation timed out|Connection (refused|reset)/i.test(err)) {
      reason = '网络不可达或连接失败'
    } else if (/Repository not found|not found|does not appear to be a git repository/i.test(err)) {
      reason = '远端仓库不存在或无权访问'
    }
    return {
      ok: false,
      mode: 'error',
      message: `无法连接远端记忆仓库（${reason}）：${err.trim().split('\n')[0] ?? ''}。已跳过初始化，本地记忆不受影响；请检查网络/凭证后重试。`,
    }
  }

  if (probe.stdout.trim() === '') {
    // 分支不存在 → 走设备 A 初始化（本地建仓 + 首次提交；远端分支由首次
    // push 创建——push 需用户显式触发）
    return { ok: true, mode: 'bootstrap-needed', message: `远端尚无 ${remoteBranch} 分支，将按新设备初始化` }
  }

  // 分支存在 → 接入：init + remote + fetch（显式 refspec）+ checkout
  await runGit(dir, ['init', '-q'])
  const headBranch = await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!headBranch.ok || headBranch.stdout.trim() === 'HEAD') {
    await runGit(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  }
  await runGit(dir, ['remote', 'add', 'origin', remoteUrl])
  const fetch = await runGit(dir, ['fetch', 'origin', `refs/heads/${remoteBranch}:refs/remotes/origin/${remoteBranch}`], { network: true })
  if (!fetch.ok) {
    return { ok: false, mode: 'error', message: `拉取远端记忆失败：${fetch.stderr.trim().split('\n')[0] ?? ''}` }
  }
  // 本地 main ← 远端分支（-B 强制；设备 B 全新目录，无本地改动可丢）
  await runGit(dir, ['checkout', '-B', 'main', `refs/remotes/origin/${remoteBranch}`])
  // 仓库级兜底身份（后续 push 需要）
  const userName = await runGit(dir, ['config', 'user.name'])
  if (!userName.ok || userName.stdout.trim() === '') {
    await runGit(dir, ['config', 'user.name', REPO_USER.name])
    await runGit(dir, ['config', 'user.email', REPO_USER.email])
  }
  return { ok: true, mode: 'adopt', message: `已接入远端记忆（${remoteBranch}）` }
}

/* ---------------- 内部工具 ---------------- */

/**
 * 白名单记忆文件 entryId 补发（锁内同步调用；有变化才写回）。
 * 返回补发条数；只处理 KEY.md / KEY-archive.md / MEMORY.md / logs/*.md。
 * @param {string} dir - 记忆仓库目录。
 * @returns {number} 补发的条目总数。
 */
function backfillEntryIds(dir) {
  let total = 0
  const files = []
  // 根目录白名单文件
  for (const name of MEMORY_FILE_NAMES) {
    const p = join(dir, name)
    if (existsSync(p) && statSync(p).isFile()) files.push(p)
  }
  // logs/ 目录（若存在；项目日志实际是 MEMORY.md，logs/ 为未来扩展预留）
  const logsDir = join(dir, 'logs')
  if (existsSync(logsDir) && statSync(logsDir).isDirectory()) {
    for (const name of readdirSync(logsDir)) {
      if (name.endsWith('.md')) files.push(join(logsDir, name))
    }
  }
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue // 不可读文件跳过（不破坏）
    }
    if (text.trim() === '') continue
    const { entries, backfilled } = ensureEntryIds(parseEntries(text))
    if (backfilled === 0) continue
    // 原子写回（与 store.js write 同款：tmp + rename）
    const tmp = `${file}.tmp.${process.pid}`
    writeFileSync(tmp, serializeEntries(entries))
    renameSync(tmp, file)
    total += backfilled
  }
  return total
}

/* ---------------- sync 主流程辅助（worker 共用） ---------------- */

/**
 * 判断路径是否属于"同步记忆文件"（合并器只处理这些；其余文件如
 * TODOS.md/.gitignore/PROVENANCE 以本地工作树为准，不参与合并）。
 * @param {string} path - 相对路径（如 'KEY.md'、'logs/2026-08-10.md'）。
 * @returns {boolean}
 */
export function isMemoryFile(path) {
  if (MEMORY_FILE_NAMES.has(path)) return true
  return path.startsWith('logs/') && path.endsWith('.md')
}

/**
 * 读取某个 git 树（ref/commit）里的全部文件为 { 路径: 条目[] }（仅同步记忆
 * 文件 + PROVENANCE——PROVENANCE 用于身份校验，不参与合并）。
 * @param {string} dir - 记忆仓库目录。
 * @param {string} ref - ref/commit 名（如 'refs/remotes/origin/dsh-shared/memory'）。
 * @returns {Promise<{ files: Record<string, string>, provenance: string | null }>}
 */
export async function readTreeFiles(dir, ref) {
  const files = {}
  let provenance = null
  const ls = await runGit(dir, ['ls-tree', '-r', '--name-only', ref])
  if (!ls.ok) return { files, provenance }
  const names = ls.stdout.split('\n').map((n) => n.trim()).filter((n) => n.length > 0)
  for (const name of names) {
    // 只读同步记忆文件与 PROVENANCE（其余文件不进合并、不读）
    if (name === 'PROVENANCE') {
      const show = await runGit(dir, ['show', `${ref}:${name}`])
      if (show.ok) provenance = show.stdout
      continue
    }
    if (!isMemoryFile(name)) continue
    const show = await runGit(dir, ['show', `${ref}:${name}`])
    if (show.ok) files[name] = parseEntries(show.stdout) // 解析为条目数组（合并器输入）
  }
  return { files, provenance }
}

/**
 * 异步目录锁（worker 专用）：与主进程 store 的同步 withLock 同一把锁文件
 * （.memory.lock），语义对齐——互斥主进程的记忆写操作。worker 在锁内要做
 * 异步 git 提交（无法用同步 withLock），故提供 await 版本。
 * 锁内全部为本地毫秒级操作（写盘 + commit-tree），不会触发 5s 超时。
 * @param {string} dir - 记忆仓库目录。
 * @param {() => Promise<T>} fn - 临界区（异步）。
 * @returns {Promise<T>}
 * @template T
 */
export async function asyncWithLock(dir, fn) {
  const lockPath = join(dir, '.memory.lock')
  mkdirSync(dir, { recursive: true })
  const deadline = Date.now() + 5000 // 与 store.js LOCK_TIMEOUT_MS 对齐
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  for (;;) {
    let acquired = false
    try {
      const fd = openSync(lockPath, 'wx')
      closeSync(fd)
      acquired = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    if (acquired) break
    try {
      const info = statSync(lockPath)
      if (Date.now() - info.mtimeMs > 10000) rmSync(lockPath, { force: true }) // stale 对齐
    } catch {
      // 锁在重试间隙消失——继续
    }
    if (Date.now() >= deadline) {
      throw new Error('dsh-memory-evolve: timed out waiting for the memory lock')
    }
    await sleep(50)
  }
  try {
    return await fn()
  } finally {
    rmSync(lockPath, { force: true })
  }
}
