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
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isCanonical, isStaleLock, parseEntries, serializeEntries, withLock } from '../store.js'
import { ensureEntryIds } from './entryid.js'
import { locateLegacyDir, sanitizeRemoteUrl } from './identity.js'

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
 * 同步 stage 白名单（审查 P1-12）：只有这些文件进入记忆仓库历史与远端。
 * 与 .gitignore 的 deny-all 放行清单一致；logs/ 目录整体放行（未来扩展）。
 */
export const STAGE_PATHS = ['KEY.md', 'KEY-archive.md', 'MEMORY.md', 'PROVENANCE', '.gitignore', 'CONFLICTS.md', 'logs/']

/**
 * 白名单 stage（首次提交与 sync 合并提交共用）：只 add 实际存在的路径
 * （pathspec 不匹配是 fatal，--ignore-errors 不吞——审查修复实测）；
 * -f 强制（deny-all .gitignore 下显式 add 被 git 判 ignored 拒掉）。
 * @param {string} dir - 记忆仓库目录。
 * @returns {Promise<{ok: boolean, code: number | null, stdout: string, stderr: string}>}
 */
export async function stagePaths(dir) {
  const existing = STAGE_PATHS.filter((p) => existsSync(join(dir, p)))
  if (existing.length === 0) return { ok: true, code: 0, stdout: '', stderr: '' }
  return runGit(dir, ['add', '-f', '--ignore-errors', '--', ...existing])
}

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
  // 需要并入新目录（施工图 §5 步骤 2）。
  // 审查修复（Grok P1-6 / Codex P0-1）：
  //   - 源与目标**同时加锁**（嵌套 withLock，不同目录不冲突）：迁移期间
  //     两边的 store 写都被挡住，杜绝"rename 后旧路径重建孤儿目录"；
  //   - 统一**文件级移动**（不整目录 rename）：锁文件不随目录走，彻底绕开
  //     "目标非空 ENOTEMPTY"与"锁被移动"两个坑；
  //   - 同名冲突**保留双份**（源文件改 .pre-migrate 后缀），绝不覆盖丢数据；
  //   - 子目录（logs/ 等）递归移动，核验落地后才删除源目录。
  const legacyDir = locateLegacyDir(memoryDir, cwd, projectId)
  if (legacyDir !== null) {
    try {
      withLock(legacyDir, () => {
        withLock(dir, () => {
          mkdirSync(dir, { recursive: true })
          report.migratedConflicts = moveTreeInto(legacyDir, dir)
        })
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
    rmSync(join(dir, '.memory.lock'), { force: true }) // 清理嵌套锁可能残留
    report.migratedFrom = legacyDir
  }

  // ── 1. 目录与 git 初始化 ──
  mkdirSync(dir, { recursive: true })
  // 分支名统一 main（施工图 §2；审查 P1-4——unborn HEAD 的 rev-parse 行为
  // 因 git 版本而异，不能依赖它判断）：优先 `init -b main`（git ≥ 2.28），
  // 失败（旧版本无 -b）降级 init + symbolic-ref 兜底；每一步检查结果。
  const init = await runGit(dir, ['init', '-q', '-b', 'main'])
  if (!init.ok) {
    const initPlain = await runGit(dir, ['init', '-q'])
    if (!initPlain.ok) {
      return { ok: false, message: `git init 失败（${initPlain.stderr.trim().split('\n')[0] ?? ''}）——请检查 git 是否可用`, committed: false, backfilled: 0, migratedFrom: null, remoteBranchExists: null }
    }
    const sym = await runGit(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    if (!sym.ok) {
      return { ok: false, message: `无法设置默认分支 main（${sym.stderr.trim().split('\n')[0] ?? ''}）`, committed: false, backfilled: 0, migratedFrom: null, remoteBranchExists: null }
    }
  }

  // ── 2. 仓库级兜底身份（施工图 §5 步骤 4；审查 P1-11——必须 --local
  //    检查，读全局配置会被短路：全局有 name 无 email 时首次提交会失败）──
  const localName = await runGit(dir, ['config', '--local', '--get', 'user.name'])
  if (!localName.ok || localName.stdout.trim() === '') {
    await runGit(dir, ['config', '--local', 'user.name', REPO_USER.name])
  }
  const localEmail = await runGit(dir, ['config', '--local', '--get', 'user.email'])
  if (!localEmail.ok || localEmail.stdout.trim() === '') {
    await runGit(dir, ['config', '--local', 'user.email', REPO_USER.email])
  }

  // ── 3. .gitignore（先于 add；审查 P1-12——deny-all + 白名单放行：
  //    TODOS.md 等外部模块文件永不入库，git status 也不显示）──
  const gitignorePath = join(dir, '.gitignore')
  const gitignoreContent = [
    '.memory.lock', '*.tmp.*', '',
    '# 同步白名单（deny-all）：只有下列文件进入记忆仓库', '*',
    '!.gitignore', '!PROVENANCE', '!KEY.md', '!KEY-archive.md', '!MEMORY.md',
    '!CONFLICTS.md', '!logs/', '!logs/**', '',
  ].join('\n')
  if (!existsSync(gitignorePath) || readFileSync(gitignorePath, 'utf8') !== gitignoreContent) {
    writeFileSync(gitignorePath, gitignoreContent)
  }

  // ── 4. entryId 补发（锁内，同步）：白名单记忆文件全 ID ──
  // 老记忆没有身份证 → 确定性补发（sha1 内容归一化前 8 位，双设备一致），
  // 保证工作树始终全 ID（施工图 §4.6）。补发只动白名单文件；非 canonical
  // 文件（CRLF/手工编辑）绝不重写（会破坏条目边界），备份后跳过。
  withLock(dir, () => {
    const bf = backfillEntryIds(dir)
    report.backfilled = bf.backfilled
    report.skippedBackfill = bf.skipped
  })

  // ── 5. PROVENANCE：一行 JSON（合并前校验 projectId 用，施工图 §9）──
  // 已存在时解析校验（审查 P1-10）：projectId 不一致 = 目录被误用/接错，
  // 绝不继续（防 A 项目记忆并进 B 项目）。
  const provenancePath = join(dir, 'PROVENANCE')
  const existing = existsSync(provenancePath) ? readFileSync(provenancePath, 'utf8').trim() : ''
  if (existing !== '') {
    let meta = null
    try {
      meta = JSON.parse(existing)
    } catch {
      return { ok: false, message: 'PROVENANCE 已存在但无法解析（JSON 损坏）——请人工检查后重试', committed: false, backfilled: 0, migratedFrom: null, remoteBranchExists: null }
    }
    if (typeof meta.projectId === 'string' && meta.projectId !== projectId) {
      return { ok: false, message: `目录身份不匹配：现有 PROVENANCE 属于项目 ${meta.projectId}（${meta.displayName ?? ''}），当前解析为 ${projectId}。目录可能被误用或接错，已停止初始化`, committed: false, backfilled: 0, migratedFrom: null, remoteBranchExists: null }
    }
  } else {
    // enabled/tracks：三层开关的项目级与轨级位（2026-08-11 用户拍板）——
    // enabled=false = 该项目停用同步（记忆全保留）；tracks.project=false =
    // 项目记忆轨（KEY/日志/归档）不参与（一期唯一轨；全局轨二期独立开关）。
    const meta = {
      projectId, displayName, version: PROVENANCE_VERSION, remoteBranch,
      enabled: true,
      tracks: { project: true },
    }
    if (report.migratedFrom) meta.migratedFrom = report.migratedFrom
    writeFileSync(provenancePath, `${JSON.stringify(meta)}\n`)
  }

  // ── 6. 首次提交（无变化跳过；allowlist stage——审查 P1-12）──
  await stagePaths(dir)
  const staged = await runGit(dir, ['diff', '--cached', '--quiet'])
  if (!staged.ok) {
    const stamp = new Date().toISOString().slice(0, 10)
    const commit = await runGit(dir, ['commit', '-q', '-m', `memory: initial import ${stamp}`])
    if (!commit.ok) {
      return { ok: false, message: `首次提交失败：${commit.stderr.trim().split('\n')[0] ?? ''}`, committed: false, backfilled: 0, migratedFrom: null, remoteBranchExists: null }
    }
    report.committed = true
  }

  // ── 7. remote 挂载（模式 A/B 共用：origin 已存在则跳过；审查 P1-7——
  //    remote add 前必须 sanitize，防明文凭证进 .git/config）──
  const origin = await runGit(dir, ['remote', 'get-url', 'origin'])
  if (!origin.ok || origin.stdout.trim() === '') {
    const add = await runGit(dir, ['remote', 'add', 'origin', sanitizeRemoteUrl(remoteUrl)])
    if (!add.ok) {
      return { ok: false, message: `remote 挂载失败：${add.stderr.trim().split('\n')[0] ?? ''}`, committed: false, backfilled: 0, migratedFrom: null, remoteBranchExists: null }
    }
  }

  // ── 8. 试探远端分支是否存在（网络，可失败；**只探测 remoteBranch**——
  //    审查 P1-3：双 ref 探测会把"仅有 main 的代码仓库"误判为记忆分支存在）──
  const ls = await runGit(dir, ['ls-remote', 'origin', `refs/heads/${remoteBranch}`], { network: true })
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
export async function deviceBConnect({ dir, remoteUrl, remoteBranch, expectedProjectId }) {
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

  // ── 非空目录守卫（审查 P1-5/Codex P1-8）：checkout 会覆盖 tracked 文件，
  // 与未跟踪的本地记忆文件冲突（untracked would be overwritten）。
  // 只拒绝**用户记忆文件**——初始化产物（.git/.gitignore/PROVENANCE/锁）
  // 不拦（重复 setup 是安全幂等操作）。
  const existing = readdirSync(dir).filter((n) => !['.git', '.gitignore', 'PROVENANCE', '.memory.lock'].includes(n))
  if (existing.length > 0) {
    return {
      ok: false,
      mode: 'error',
      message: `目标目录 ${dir} 已有记忆内容（${existing.slice(0, 5).join('、')}${existing.length > 5 ? '…' : ''}）——为避免覆盖本地记忆，请先清空目录或人工处理后再接入`,
    }
  }

  // ── 分支存在 → 接入：init + remote + fetch（显式 refspec）+ checkout ──
  // 每步检查结果（审查 P1-8：任一步失败必须如实报错，绝不假报 adopt）
  const init = await runGit(dir, ['init', '-q', '-b', 'main'])
  if (!init.ok) {
    await runGit(dir, ['init', '-q'])
    const sym = await runGit(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    if (!sym.ok) return { ok: false, mode: 'error', message: `git init 失败：${sym.stderr.trim().split('\n')[0] ?? ''}` }
  }
  const originCheck = await runGit(dir, ['remote', 'get-url', 'origin'])
  if (!originCheck.ok || originCheck.stdout.trim() === '') {
    const add = await runGit(dir, ['remote', 'add', 'origin', sanitizeRemoteUrl(remoteUrl)])
    if (!add.ok) return { ok: false, mode: 'error', message: `remote 挂载失败：${add.stderr.trim().split('\n')[0] ?? ''}` }
  }
  const fetch = await runGit(dir, ['fetch', 'origin', `refs/heads/${remoteBranch}:refs/remotes/origin/${remoteBranch}`], { network: true })
  if (!fetch.ok) {
    return { ok: false, mode: 'error', message: `拉取远端记忆失败：${fetch.stderr.trim().split('\n')[0] ?? ''}` }
  }
  // ── 远端 PROVENANCE 校验（审查 P1-10）：接入前确认远端确实是本项目，
  //    防止 origin 指错/复用独立仓库时把别家记忆接进本地 ──
  if (typeof expectedProjectId === 'string') {
    const remoteProvenance = await runGit(dir, ['show', `refs/remotes/origin/${remoteBranch}:PROVENANCE`])
    if (remoteProvenance.ok) {
      try {
        const meta = JSON.parse(remoteProvenance.stdout.trim())
        if (typeof meta.projectId === 'string' && meta.projectId !== expectedProjectId) {
          return { ok: false, mode: 'error', message: `远端记忆属于项目 ${meta.projectId}（${meta.displayName ?? ''}），与当前项目 ${expectedProjectId} 不匹配——疑似接错了分支/仓库，已拒绝接入` }
        }
      } catch { /* 远端 PROVENANCE 损坏 → 保守放行（老仓库可能无此文件），由首次 sync 再校验 */ }
    }
  }
  const checkout = await runGit(dir, ['checkout', '-B', 'main', `refs/remotes/origin/${remoteBranch}`])
  if (!checkout.ok) {
    return { ok: false, mode: 'error', message: `检出远端记忆失败：${checkout.stderr.trim().split('\n')[0] ?? ''}` }
  }
  // 仓库级兜底身份（--local，缺哪个补哪个——审查 P1-11）
  const localName = await runGit(dir, ['config', '--local', '--get', 'user.name'])
  if (!localName.ok || localName.stdout.trim() === '') {
    await runGit(dir, ['config', '--local', 'user.name', REPO_USER.name])
  }
  const localEmail = await runGit(dir, ['config', '--local', '--get', 'user.email'])
  if (!localEmail.ok || localEmail.stdout.trim() === '') {
    await runGit(dir, ['config', '--local', 'user.email', REPO_USER.email])
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
  let backfilled = 0
  let skipped = 0
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
    // canonical 保护（审查 P0-2）：CRLF/手工编辑的非往返文件绝不重写——
    // parseEntries 会把回车符留在条目里，补发后条目边界被破坏。备份 + 跳过，
    // 等人工整理后再同步。
    if (!isCanonical(text)) {
      try {
        copyFileSync(file, `${file}.bak.${Date.now()}`)
      } catch { /* 备份失败不阻断跳过 */ }
      skipped += 1
      continue
    }
    const { entries, backfilled: n } = ensureEntryIds(parseEntries(text))
    if (n === 0) continue
    // 原子写回（与 store.js write 同款：tmp + rename）
    const tmp = `${file}.tmp.${process.pid}`
    writeFileSync(tmp, serializeEntries(entries))
    renameSync(tmp, file)
    backfilled += n
  }
  return { backfilled, skipped }
}

/* ---------------- 迁移工具 ---------------- */

/**
 * 文件级递归移动 srcDir 的全部内容到 dstDir（审查 P0-1 修复）。
 *   - 子目录递归；.memory.lock 跳过（锁文件不属于数据）；
 *   - 同名冲突：源文件改 `<名>.pre-migrate` 后缀保留**双份**，绝不覆盖；
 *   - 全部落地后才删除源目录（核验即"移动成功即落地"——同盘 rename 原子）。
 * @param {string} srcDir - 源目录（迁移后被删除）。
 * @param {string} dstDir - 目标目录（必须已存在）。
 * @returns {number} 冲突备份数。
 */
function moveTreeInto(srcDir, dstDir) {
  let conflicts = 0
  for (const name of readdirSync(srcDir)) {
    if (name === '.memory.lock') continue
    const src = join(srcDir, name)
    const dst = join(dstDir, name)
    if (statSync(src).isDirectory()) {
      mkdirSync(dst, { recursive: true })
      conflicts += moveTreeInto(src, dst)
    } else if (existsSync(dst)) {
      // 同名冲突：源保留双份（备份后缀），目标版本不动
      renameSync(src, `${dst}.pre-migrate`)
      conflicts += 1
    } else {
      renameSync(src, dst)
    }
  }
  // 全部文件已落地 → 删源目录（此时只剩空壳）
  rmSync(srcDir, { recursive: true, force: true })
  return conflicts
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
      try {
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }))
      } finally {
        closeSync(fd)
      }
      acquired = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    if (acquired) break
    // stale 判断与主进程同源（isStaleLock）：mtime 超时或 pid 已死
    // （断电中断残留）→ 立即清除，不等 10s
    if (isStaleLock(lockPath)) rmSync(lockPath, { force: true })
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
