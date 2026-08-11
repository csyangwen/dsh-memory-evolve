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

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isCanonical, isStaleLock, parseEntries, serializeEntries, withLock } from '../store.js'
import { ENTRY_DELIMITER } from '../store.js'
import { ensureEntryIds } from './entryid.js'
import { locateLegacyDir, normalizeRemoteUrl, sanitizeRemoteUrl } from './identity.js'
import { TODO_HEADER } from '../todo.js'
import { filesetSpec, isMemoryFile, isTodoPath, GLOBAL_FILESET_KEYS, globalBranchFor } from './filesets.js'

/** 网络命令超时（30s，GIT_TERMINAL_PROMPT=0 防凭证卡死）。 */
const NETWORK_TIMEOUT_MS = 30_000
/** 本地命令超时（10s）。 */
const LOCAL_TIMEOUT_MS = 10_000

/**
 * 分支命名空间前缀（需求 #5：`dsh-shared/<模块>`）。
 *  - 模式 A（复用主代码仓库）：固定分支 `dsh-shared/memory`；
 *  - 模式 B（共享记忆仓库，2026-08-11 拍板）：一个私有仓库装所有项目的
 *    记忆，每个项目使用**专属分支** `dsh-shared/<projectId>`（projectId 是
 *    12 hex 稳定身份——跨设备一致，分支名天然不冲突）；
 *  - 老单项目仓库（模式 B 一期：分支固定 main）自动识别兼容（见
 *    decideModeBBranch：main 的 PROVENANCE.projectId == 本项目 → 继续 main）。
 */
export const SHARED_BRANCH_PREFIX = 'dsh-shared/'
/** 模式 A 的固定分支名（与 SHARED_BRANCH_PREFIX 区分：共享分支是前者 + 12 hex）。 */
export const MODE_A_BRANCH = 'dsh-shared/memory'

/** 计算共享记忆仓库里某项目的专属分支名（dsh-shared/<projectId>）。 */
export function sharedBranchFor(projectId) {
  return `${SHARED_BRANCH_PREFIX}${projectId}`
}

/**
 * 记忆远端分支决策（2026-08-11 统一单一模式）。
 *
 * 统一模型：记忆同步 = 一个记忆远端（默认=主代码仓库 / 指定=共享记忆仓库）
 * + 每项目一条专属分支 dsh-shared/<projectId>。本函数决定"这个项目在给定
 * 远端上应该用哪个分支"——老配置（一期）自动识别兼容，零迁移：
 *
 * 候选分支（按优先级探测，一次 ls-remote 完成）：
 *   1. dsh-shared/<projectId> —— 统一专属分支（新项目，默认/指定远端共用）
 *   2. dsh-shared/memory      —— 老模式 A（一期固定分支）
 *   3. main                   —— 老模式 B 单项目仓库（一期固定分支）
 *
 * 判定：
 *   - 候选 1 存在 → shared（续接/第二台设备）；
 *   - 候选 2/3 存在 → 拉取读 PROVENANCE：projectId 精确匹配本项目 →
 *     legacy-memory / legacy-main（老配置继续用，零迁移）；属于别人/归属
 *     不明 → 跳过该候选（**绝不触碰别人的分支**，防串项目）；
 *   - 全部不存在或不匹配 → fresh（全新：用专属分支）。
 *
 * 串项目防护三层防线：决策只认 PROVENANCE.projectId 精确匹配 +
 * deviceBConnect 的 expectedProjectId 校验 + worker 的 checkProvenance。
 *
 * 全部网络命令（ls-remote/fetch）异步执行、GIT_TERMINAL_PROMPT=0、超时
 * 保护；本函数由 sync-worker 子进程调用（主进程绝不跑网络命令）。
 *
 * @param {object} p
 * @param {string} p.dir - 记忆仓库目录（可能尚不存在/未 init——只建目录，
 *   fetch 前才 init，失败时目录残留无害：deviceBConnect 守卫放行 .git）。
 * @param {string} p.remoteUrl - 记忆远端 URL（主代码仓库 origin 或共享仓库）。
 * @param {string} p.projectId - 本项目身份 id（12 hex）。
 * @returns {Promise<{ok: boolean, kind: 'shared'|'legacy-memory'|'legacy-main'|
 *   'fresh'|'error', branch: string | null, message: string}>}
 */
export async function decideModeBBranch({ dir, remoteUrl, projectId }) {
  mkdirSync(dir, { recursive: true })
  const sharedBranch = sharedBranchFor(projectId)

  // ── 1. 一次 ls-remote 探测全部候选分支（一次网络往返）──
  const candidates = [sharedBranch, MODE_A_BRANCH, 'main']
  const probe = await runGit(dir, ['ls-remote', remoteUrl, ...candidates.map((b) => `refs/heads/${b}`)], { network: true })
  if (!probe.ok) {
    return { ok: false, kind: 'error', branch: null, message: `无法连接记忆远端（${classifyRemoteError(probe.stderr)}）：${probe.stderr.trim().split('\n')[0] ?? ''}。请检查网络/凭证后重试` }
  }
  // 解析存在性：输出行 "hash\trefs/heads/<名>"
  const present = new Set()
  for (const line of probe.stdout.split('\n')) {
    const m = /^[0-9a-f]{40}\trefs\/heads\/(.+)$/.exec(line.trim())
    if (m !== null) present.add(m[1])
  }

  // 专属分支存在 → 直接续接（分支名即本项目身份；deviceBConnect 的
  // expectedProjectId 校验仍会兜底）
  if (present.has(sharedBranch)) {
    return { ok: true, kind: 'shared', branch: sharedBranch, message: `远端已有本项目的专属分支 ${sharedBranch}，直接接入` }
  }

  // ── 2. 老分支兼容：dsh-shared/memory（老模式 A）→ main（老模式 B）──
  // 存在且 PROVENANCE.projectId 精确匹配本项目 → 继续用（零迁移）；
  // 属于别人/归属不明 → 跳过该候选（绝不触碰，防串项目）
  let inited = false
  const ensureInit = async () => {
    if (inited) return
    inited = true
    const init = await runGit(dir, ['init', '-q', '-b', 'main'])
    if (!init.ok) {
      const initPlain = await runGit(dir, ['init', '-q'])
      if (!initPlain.ok) throw new Error(`git init 失败：${initPlain.stderr.trim().split('\n')[0] ?? ''}`)
      const sym = await runGit(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
      if (!sym.ok) throw new Error(`无法设置默认分支 main：${sym.stderr.trim().split('\n')[0] ?? ''}`)
    }
  }
  for (const legacy of [MODE_A_BRANCH, 'main']) {
    if (!present.has(legacy)) continue
    let belongs = false
    try {
      await ensureInit()
      // 只读 PROVENANCE 判定归属：--depth 1 浅拉（Kimi P1-9——默认路径下
      // main 是代码分支必然存在，全量 fetch 会把代码仓库全部历史拉进记忆
      // 仓库 .git；浅拉只取单个提交，读树文件足够）；临时 ref 用
      // _decide/ 命名空间（Kimi P2-7：不污染真实 remote-tracking ref——
      // 已接入仓库重复 setup 时删掉在用 tracking ref 会让 behind 显示失效）
      const tmpRef = `refs/remotes/origin/_decide/${legacy.replaceAll('/', '_')}`
      const fetch = await runGit(dir, ['fetch', '--no-tags', '--depth', '1', remoteUrl, `refs/heads/${legacy}:${tmpRef}`], { network: true })
      if (fetch.ok) {
        const show = await runGit(dir, ['show', `${tmpRef}:PROVENANCE`])
        if (show.ok) {
          try { belongs = JSON.parse(show.stdout.trim()).projectId === projectId } catch { /* 损坏视同缺失 */ }
        }
      }
      // 清理临时 ref（只动 _decide/ 命名空间，绝不动真实 tracking ref）
      await runGit(dir, ['update-ref', '-d', tmpRef])
      // fetch 失败（分支损坏/网络抖动）→ Kimi P2-1：ls-remote 已确认分支
      // 存在但拉不到内容，静默跳过会切新分支遗弃旧历史（split-brain）——
      // 如实报错让用户处理
      if (!fetch.ok && belongs === false && fetch.stderr.trim() !== '') {
        return { ok: false, kind: 'error', branch: null, message: `无法读取远端分支 ${legacy} 的内容（${fetch.stderr.trim().split('\n')[0] ?? ''}）——已停止初始化，请检查远端后重试` }
      }
    } catch (error) {
      return { ok: false, kind: 'error', branch: null, message: `git 初始化失败：${error?.message ?? String(error)}` }
    }
    if (belongs) {
      const kind = legacy === MODE_A_BRANCH ? 'legacy-memory' : 'legacy-main'
      return { ok: true, kind, branch: legacy, message: `远端分支 ${legacy} 是本项目的记忆（老配置）——继续使用，零迁移` }
    }
  }

  // ── 3. 全部不存在/不匹配 → 全新：用专属分支（远端可能已有其他项目）──
  const others = present.size > 0 ? '远端已有其他项目的分支——' : '全新记忆远端——'
  return { ok: true, kind: 'fresh', branch: sharedBranch, message: `${others}本项目使用专属分支 ${sharedBranch}` }
}

/** 项目待办文件名（2026-08-11 统一模式：并入项目记忆轨同步）。
 *  TODO 格式判定统一走 lib/sync/filesets.js 的 isTodoPath（含全局待办）。 */
export const TODO_FILE = 'TODOS.md'

/** 仓库级兜底身份（不依赖用户全局 git 配置；施工图 §5 步骤 4）。 */
const REPO_USER = { name: 'dsh-memory', email: 'dsh@localhost' }

/** PROVENANCE 文件格式版本（未来字段变更走版本迁移）。 */
const PROVENANCE_VERSION = 1

/**
 * 同步 stage 白名单（审查 P1-12）：只有这些文件进入记忆仓库历史与远端。
 * 2026-08-11 统一模式：项目待办 TODOS.md 并入项目记忆轨（用户拍板）。
 * 元数据文件（PROVENANCE/.gitignore/CONFLICTS.md/.gitattributes）所有文件集通用；
 * 各文件集的记忆文件由 resolveFilesetFiles 动态展开（全局轨二期并入一期）。
 */
export const STAGE_META = ['PROVENANCE', '.gitignore', 'CONFLICTS.md', '.gitattributes']

/**
 * .gitattributes 内容：**强制 LF、禁止换行转换**（Windows autocrlf 事故修复，
 * 2026-08-11 实测复现）。
 *
 * 背景：Windows Git 默认 core.autocrlf=true（system 级），checkout 记忆仓库
 * 时把 LF 全部转成 CRLF → 记忆文件分隔符 `\n§\n` 被 \r 破坏（整文件解析成
 * 一条）→ isCanonical 格式预检失败 → 同步被"格式异常"保护拦下。这不是
 * 同步算法问题，是 git 换行转换污染了工作树。
 *
 * 双保险修复：
 *   1. `.gitattributes` 写 `* -text`（本文件入库、随仓库传播到所有设备：
 *      任何设备 checkout 都不做换行转换，工作树与对象库逐字节一致）；
 *   2. 仓库级 `git config core.autocrlf false`（初始化时设置，覆盖用户
 *      全局/系统配置——即使 .gitattributes 缺失也安全）。
 */
export const GITATTRIBUTES_CONTENT = '* -text\n'

/**
 * 展开某文件集当前实际存在的同步文件（相对路径列表：记忆格式 + TODO 格式）。
 * 元数据（PROVENANCE/.gitignore/CONFLICTS.md）不在此列（stage 时单独处理）。
 * **严格按 isMemoryFile 过滤（Codex 二轮 P0-3）**：目录（daily/）展开不能
 * 只按后缀——daily/notes.md 之类非法路径绝不能被 stage（上传了接收端也
 * 不会合并它，成为孤儿文件）。
 * @param {string} dir - 仓库工作树目录。
 * @param {string} [fileset='project'] - 文件集。
 * @returns {{ memory: string[], todo: string[] }}
 */
export function resolveFilesetFiles(dir, fileset = 'project') {
  const spec = filesetSpec(fileset)
  const out = { memory: [], todo: [] }
  const addDirFiles = (sub, suffix, list) => {
    const d = join(dir, sub)
    if (!existsSync(d)) return
    for (const name of readdirSync(d)) {
      if (!name.endsWith(suffix)) continue
      const rel = `${sub}/${name}`
      if (!isMemoryFile(rel, fileset)) continue
      list.push(rel)
    }
  }
  for (const p of spec.memory) {
    if (p === 'daily') addDirFiles('daily', '.md', out.memory)
    else if (existsSync(join(dir, p))) out.memory.push(p)
  }
  for (const p of spec.todo) {
    if (p === 'daily') addDirFiles('daily', '.todo.md', out.todo)
    else if (existsSync(join(dir, p))) out.todo.push(p)
  }
  if (spec.logs) addDirFiles('logs', '.md', out.memory)
  return out
}

/**
 * 白名单 stage（首次提交与 sync 合并提交共用）：只 add 实际存在的路径
 * （pathspec 不匹配是 fatal，--ignore-errors 不吞——审查修复实测）；
 * -f 强制（deny-all .gitignore 下显式 add 被 git 判 ignored 拒掉）。
 * **对账（Grok 终审 P1-1 实锤修复）**：白名单文件曾被跟踪但已被删除
 * （如冲突清空后 CONFLICTS.md 被 rmSync）→ 必须 `git rm` 从 index 移除，
 * 否则 write-tree 后 HEAD 里残留幽灵文件、git status 永久 dirty、
 * 推送后对端检出过期冲突清单。
 * @param {string} dir - 记忆仓库目录。
 * @param {string} [fileset='project'] - 文件集（全局轨按轨取文件）。
 * @returns {Promise<{ok: boolean, code: number | null, stdout: string, stderr: string}>}
 */
export async function stagePaths(dir, fileset = 'project', env) {
  const { memory, todo } = resolveFilesetFiles(dir, fileset)
  const filePaths = [...memory, ...todo]
  const meta = STAGE_META.filter((p) => existsSync(join(dir, p)))
  const all = [...filePaths, ...meta]
  const cmds = []
  if (all.length > 0) cmds.push(['add', '-f', '--ignore-errors', '--', ...all])
  // 已跟踪但已删除的白名单文件 → git rm（--ignore-unmatch 防"从未跟踪"误报）
  const tracked = await runGit(dir, ['ls-files', '--', ...filePaths, ...STAGE_META], env ? { env } : {})
  if (tracked.ok && tracked.stdout.trim() !== '') {
    const removed = tracked.stdout.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !existsSync(join(dir, l)))
    if (removed.length > 0) cmds.push(['rm', '-f', '--ignore-unmatch', '--', ...removed])
  }
  if (cmds.length === 0) return { ok: true, code: 0, stdout: '', stderr: '' }
  for (const args of cmds) {
    const r = await runGit(dir, args, env ? { env } : {})
    if (!r.ok) return r
  }
  return { ok: true, code: 0, stdout: '', stderr: '' }
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
  // opts.env：额外环境变量（如 GIT_INDEX_FILE 临时 index——Codex 二轮 P1-1）
  const baseEnv = network ? { ...process.env, GIT_TERMINAL_PROMPT: '0' } : process.env
  const env = opts.env ? { ...baseEnv, ...opts.env } : baseEnv
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: dir,
      env,
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
export async function ensureMemoryRepo({ dir, memoryDir, cwd, projectId, displayName, remoteUrl, remoteBranch = sharedBranchFor(projectId) }) {
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
    // 嵌套 withLock 已正常释放锁（finally 幂等清理）；此处不主动 rmSync——
    // 多进程下可能误删**其他进程刚获取的活锁**（Kimi P2-6）。崩溃残留锁
    // 由 isStaleLock（pid 存活检测）自动清除。
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
    '!CONFLICTS.md', '!TODOS.md', '!logs/', '!logs/**', '!.gitattributes', '',
  ].join('\n')
  if (!existsSync(gitignorePath) || readFileSync(gitignorePath, 'utf8') !== gitignoreContent) {
    writeFileSync(gitignorePath, gitignoreContent)
  }

  // ── 3b. .gitattributes + core.autocrlf false（Windows 换行事故修复，
  //   2026-08-11 实测：Win11 笔记本 checkout 时 git 默认 autocrlf=true 把
  //   LF 全转 CRLF → 记忆文件分隔符被破坏、格式预检拦截同步）。`* -text`
  //   让任何设备 checkout 都不做换行转换；仓库级 config 双保险（覆盖
  //   用户全局/系统设置）。.gitattributes 经 STAGE_META 入库随仓库传播。──
  const gitattributesPath = join(dir, '.gitattributes')
  if (!existsSync(gitattributesPath) || readFileSync(gitattributesPath, 'utf8') !== GITATTRIBUTES_CONTENT) {
    writeFileSync(gitattributesPath, GITATTRIBUTES_CONTENT)
  }
  await runGit(dir, ['config', 'core.autocrlf', 'false'])

  // ── 4. entryId 补发（锁内，同步）：白名单记忆文件全 ID ──
  // 老记忆没有身份证 → 确定性补发（sha1 内容归一化前 8 位，双设备一致），
  // 保证工作树始终全 ID（施工图 §4.6）。补发只动白名单文件；非 canonical
  // 文件（CRLF/手工编辑）绝不重写（会破坏条目边界），备份后跳过。
  withLock(dir, () => {
    const bf = backfillEntryIds(dir, 'project')
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
    const reason = classifyRemoteError(probe.stderr)
    return {
      ok: false,
      mode: 'error',
      message: `无法连接远端记忆仓库（${reason}）：${probe.stderr.trim().split('\n')[0] ?? ''}。已跳过初始化，本地记忆不受影响；请检查网络/凭证后重试。`,
    }
  }

  if (probe.stdout.trim() === '') {
    // 分支不存在 → 走设备 A 初始化（本地建仓 + 首次提交；远端分支由首次
    // push 创建——push 需用户显式触发）
    return { ok: true, mode: 'bootstrap-needed', message: `远端尚无 ${remoteBranch} 分支，将按新设备初始化` }
  }

  // ── 已接入幂等（Kimi P1-4 修复）：本地已是同一项目的已初始化仓库
  //    （.git 存在 + PROVENANCE.projectId 匹配）→ 重复 setup 直接幂等成功。
  //    此前会被下方非空目录守卫误杀（"请先清空目录"——已接入项目必有
  //    KEY.md 等文件，守卫必然命中），还堵死"off 后重新启用"的官方路径。
  if (typeof expectedProjectId === 'string' && existsSync(join(dir, '.git'))) {
    const localProvPath = join(dir, 'PROVENANCE')
    if (existsSync(localProvPath)) {
      try {
        const localMeta = JSON.parse(readFileSync(localProvPath, 'utf8').trim())
        if (localMeta.projectId === expectedProjectId) {
          return { ok: true, mode: 'adopt', message: '本项目已接入（重复 setup 幂等，无需重新初始化）' }
        }
      } catch { /* 本地 PROVENANCE 损坏 → 走正常接入流程（严格校验会拒绝） */ }
    }
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
  // **Windows 换行事故修复（2026-08-11 实测）：必须在 checkout 之前**设置
  // 仓库级 core.autocrlf false——Windows Git 默认 autocrlf=true（system 级），
  // checkout 时会把远端 LF 记忆文件转成 CRLF，触发 isCanonical 格式预检
  // 拦截（\n§\n 分隔符被 \r 破坏）。远端若已带 .gitattributes（`* -text`）
  // checkout 后同样生效，这里 config 双保险（覆盖用户全局/系统配置）。
  await runGit(dir, ['config', 'core.autocrlf', 'false'])
  const originCheck = await runGit(dir, ['remote', 'get-url', 'origin'])
  if (!originCheck.ok || originCheck.stdout.trim() === '') {
    const add = await runGit(dir, ['remote', 'add', 'origin', sanitizeRemoteUrl(remoteUrl)])
    if (!add.ok) return { ok: false, mode: 'error', message: `remote 挂载失败：${add.stderr.trim().split('\n')[0] ?? ''}` }
  }
  const fetch = await runGit(dir, ['fetch', 'origin', `refs/heads/${remoteBranch}:refs/remotes/origin/${remoteBranch}`], { network: true })
  if (!fetch.ok) {
    return { ok: false, mode: 'error', message: `拉取远端记忆失败：${fetch.stderr.trim().split('\n')[0] ?? ''}` }
  }
  // ── 远端 PROVENANCE 校验（审查 P1-10 → Codex 终审 P0-1 严格化）：接入前
  //    确认远端确实是本项目，防止 origin 指错/复用独立仓库时把别家记忆接进
  //    本地。**传了 expectedProjectId 时不再 fail-open**：远端分支存在就必须
  //    PROVENANCE 存在、JSON 合法、projectId 精确相等，缺失/损坏一律拒绝——
  //    老分支无 PROVENANCE 的场景已由 decideModeBBranch 的候选探测提前判为
  //    "不属于本项目"（跳过），能走到 adopt 的分支必然带合法 PROVENANCE。
  if (typeof expectedProjectId === 'string') {
    const remoteProvenance = await runGit(dir, ['show', `refs/remotes/origin/${remoteBranch}:PROVENANCE`])
    if (!remoteProvenance.ok) {
      return { ok: false, mode: 'error', message: `远端分支 ${remoteBranch} 没有 PROVENANCE（身份缺失）——无法确认归属本项目，已拒绝接入（防串项目）。请人工检查远端分支后重试` }
    }
    let meta = null
    try {
      meta = JSON.parse(remoteProvenance.stdout.trim())
    } catch {
      return { ok: false, mode: 'error', message: `远端分支 ${remoteBranch} 的 PROVENANCE 损坏（无法解析 JSON）——已拒绝接入（防串项目）。请人工检查远端分支后重试` }
    }
    if (typeof meta.projectId !== 'string' || meta.projectId !== expectedProjectId) {
      return { ok: false, mode: 'error', message: `远端记忆属于项目 ${meta.projectId ?? '未知'}（${meta.displayName ?? ''}），与当前项目 ${expectedProjectId} 不匹配——疑似接错了分支/仓库，已拒绝接入` }
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

/* ---------------- 全局记忆仓库（全局轨，2026-08-11 本期实现） ---------------- */

/**
 * 全局记忆仓库初始化（全局轨，仅共享记忆仓库可用）。
 *
 * 全局仓库 = **记忆根目录**（<memoryDir>）的 .git：deny-all 白名单只放行
 * 全局记忆文件（MEMORY.md / USER.md / 归档 / TODOS-life.md / TODOS-work.md /
 * daily/），每个全局轨一条远端分支（dsh-shared/memory-global / user / daily /
 * todo-global，需求 #5 命名空间）与独立本地分支（refs/heads/<fileset>）。
 * **同一工作树承载全部轨**：各轨 sync 只处理自己的文件子集（fileset），
 * 互不干扰——这正是"一个仓库 + 多分支 + 同一工作树"的可行模式。
 *
 * 全程幂等：已初始化（.git + PROVENANCE 存在）→ 只校验/绑定 origin 与
 * 补发（补发本身幂等：已带身份证的条目不动）。
 *
 * @param {object} p
 * @param {string} p.dir - 记忆根目录（<memoryDir>）。
 * @param {string} p.url - 共享记忆仓库 URL（全局轨的唯一远端）。
 * @returns {Promise<{ok: boolean, message: string, committed: boolean,
 *   backfilled: number}>}
 */
export async function ensureGlobalRepo({ dir, url }) {
  const report = { ok: true, message: '', committed: false, backfilled: 0 }
  // 记忆根目录必须存在（runGit 的 cwd 不存在会 ENOENT）
  mkdirSync(dir, { recursive: true })

  // ── 1. git 初始化（幂等）──
  const init = await runGit(dir, ['init', '-q', '-b', 'main'])
  if (!init.ok) {
    const initPlain = await runGit(dir, ['init', '-q'])
    if (!initPlain.ok) return { ok: false, message: `全局记忆仓库 git init 失败：${initPlain.stderr.trim().split('\n')[0] ?? ''}`, committed: false, backfilled: 0 }
    const sym = await runGit(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    if (!sym.ok) return { ok: false, message: `无法设置默认分支 main：${sym.stderr.trim().split('\n')[0] ?? ''}`, committed: false, backfilled: 0 }
  }

  // ── 2. 仓库级兜底身份（与项目仓库同款）──
  const localName = await runGit(dir, ['config', '--local', '--get', 'user.name'])
  if (!localName.ok || localName.stdout.trim() === '') {
    await runGit(dir, ['config', '--local', 'user.name', REPO_USER.name])
  }
  const localEmail = await runGit(dir, ['config', '--local', '--get', 'user.email'])
  if (!localEmail.ok || localEmail.stdout.trim() === '') {
    await runGit(dir, ['config', '--local', 'user.email', REPO_USER.email])
  }

  // ── 3. .gitignore（deny-all + 全局记忆文件白名单；projects/ 等内部目录
  //    不入库——项目记忆在各自的 projects/<id>/.git 仓库里）──
  const gitignorePath = join(dir, '.gitignore')
  const gitignoreContent = [
    '.memory.lock', '*.tmp.*', '',
    '# 全局记忆同步白名单（deny-all）：只放行全局记忆文件', '*',
    '!.gitignore', '!PROVENANCE', '!CONFLICTS.md', '!.gitattributes',
    '!MEMORY.md', '!MEMORY-archive.md', '!USER.md', '!USER-archive.md',
    '!TODOS-life.md', '!TODOS-work.md', '!daily/', '!daily/**', '',
  ].join('\n')
  if (!existsSync(gitignorePath) || readFileSync(gitignorePath, 'utf8') !== gitignoreContent) {
    writeFileSync(gitignorePath, gitignoreContent)
  }

  // ── 3b. .gitattributes + core.autocrlf false（Windows 换行事故修复，
  //   与 ensureMemoryRepo 同款——全局记忆仓库同样不能允许 checkout 把
  //   LF 转 CRLF，否则四个全局轨的合并/格式预检全部被 \r 破坏）。──
  const gitattributesPath = join(dir, '.gitattributes')
  if (!existsSync(gitattributesPath) || readFileSync(gitattributesPath, 'utf8') !== GITATTRIBUTES_CONTENT) {
    writeFileSync(gitattributesPath, GITATTRIBUTES_CONTENT)
  }
  await runGit(dir, ['config', 'core.autocrlf', 'false'])

  // ── 4. PROVENANCE（全局仓库身份 = URL 归一化指纹；轨道开关默认全关，
  //    opt-in——与项目级一致）──
  // **凭证安全（Codex 二轮 P0-1）**：PROVENANCE 是被跟踪文件、会进入远端
  // git 历史——原始 URL（可能含 token）绝不能写进去。displayName/url 一律
  // 存 sanitizeRemoteUrl 后的无凭证 URL；projectId 用归一化键（本就无凭证）。
  const provenancePath = join(dir, 'PROVENANCE')
  const safeUrl = sanitizeRemoteUrl(url)
  if (!existsSync(provenancePath)) {
    const key = normalizeRemoteUrl(url) ?? safeUrl
    const globalId = createHash('sha1').update(key).digest('hex').slice(0, 12)
    const meta = {
      projectId: globalId, displayName: safeUrl, version: PROVENANCE_VERSION, url: safeUrl,
      enabled: true,
      // 全局轨开关（每轨独立，默认关）：memory=全局记忆、user=用户档案、
      // daily=每日日志、todo=生活/工作/每日待办
      tracks: { memory: false, user: false, daily: false, todo: false },
    }
    writeFileSync(provenancePath, `${JSON.stringify(meta)}\n`)
  }

  // ── 5. entryId 补发（锁内）：全局记忆文件（MEMORY/USER/归档/daily/*.md）
  //    补发行首身份证——TODO 格式文件跳过（tag id 自足）──
  withLock(dir, () => {
    for (const fs of GLOBAL_FILESET_KEYS) {
      if (fs === 'todo-global') continue
      const bf = backfillEntryIds(dir, fs)
      report.backfilled += bf.backfilled
    }
  })

  // ── 6. 首次提交（全部全局文件 + 元数据；无变化跳过）──
  const allFiles = []
  for (const fs of GLOBAL_FILESET_KEYS) {
    const { memory, todo } = resolveFilesetFiles(dir, fs)
    for (const p of [...memory, ...todo]) if (!allFiles.includes(p)) allFiles.push(p)
  }
  for (const p of [...allFiles, ...STAGE_META]) {
    if (existsSync(join(dir, p))) {
      const add = await runGit(dir, ['add', '-f', '--ignore-errors', '--', p])
      if (!add.ok) return { ok: false, message: `全局记忆文件 stage 失败（${p}）：${add.stderr.trim().split('\n')[0] ?? ''}`, committed: false, backfilled: report.backfilled }
    }
  }
  const staged = await runGit(dir, ['diff', '--cached', '--quiet'])
  if (!staged.ok) {
    const stamp = new Date().toISOString().slice(0, 10)
    const commit = await runGit(dir, ['commit', '-q', '-m', `memory: global initial import ${stamp}`])
    if (!commit.ok) {
      return { ok: false, message: `全局记忆仓库首次提交失败：${commit.stderr.trim().split('\n')[0] ?? ''}`, committed: false, backfilled: report.backfilled }
    }
    report.committed = true
  }

  // ── 7. remote 绑定（幂等；URL 变化 → set-url 切换）──
  // **切换身份（Codex 二轮 P1-2）**：只切 origin 不更新 PROVENANCE 会让
  // 新旧设备身份不一致（新 URL 指纹 vs 旧 PROVENANCE）——切换时同步更新
  // projectId/displayName/url（双设备都用新 URL → 新指纹一致 ✓）；各轨在
  // 旧 URL 上的分支留档（不删）。两个不可归一化 URL 视为相同（不切换）。
  const origin = await runGit(dir, ['remote', 'get-url', 'origin'])
  if (!origin.ok || origin.stdout.trim() === '') {
    const add = await runGit(dir, ['remote', 'add', 'origin', sanitizeRemoteUrl(url)])
    if (!add.ok) return { ok: false, message: `全局记忆仓库 remote 挂载失败：${add.stderr.trim().split('\n')[0] ?? ''}`, committed: false, backfilled: report.backfilled }
  } else {
    const originKey = normalizeRemoteUrl(origin.stdout.trim())
    const urlKey = normalizeRemoteUrl(url)
    const urlChanged = originKey !== undefined && urlKey !== undefined && originKey !== urlKey
    if (urlChanged) {
      const set = await runGit(dir, ['remote', 'set-url', 'origin', sanitizeRemoteUrl(url)])
      if (!set.ok) return { ok: false, message: `全局记忆仓库 remote 切换失败：${set.stderr.trim().split('\n')[0] ?? ''}`, committed: false, backfilled: report.backfilled }
      // 更新 PROVENANCE 身份（新 URL 指纹；轨开关保留）
      const provPath = join(dir, 'PROVENANCE')
      if (existsSync(provPath)) {
        try {
          const meta = JSON.parse(readFileSync(provPath, 'utf8').trim())
          const safeUrl = sanitizeRemoteUrl(url)
          meta.projectId = createHash('sha1').update(urlKey).digest('hex').slice(0, 12)
          meta.displayName = safeUrl
          meta.url = safeUrl
          writeFileSync(provPath, `${JSON.stringify(meta)}\n`)
        } catch { /* PROVENANCE 损坏：跳过身份更新（由后续校验报错暴露） */ }
      }
    }
  }

  const bits = []
  if (report.backfilled > 0) bits.push(`为 ${report.backfilled} 条全局记忆补发身份证`)
  if (report.committed) bits.push('已建立首次提交')
  report.message = bits.length > 0 ? bits.join('；') : '全局记忆仓库已就绪（无变化）'
  return report
}

/* ---------------- 内部工具 ---------------- */

/**
 * 远端 git 错误分类（ls-remote/fetch/push 失败共用）：stderr 内容判别，
 * GIT_TERMINAL_PROMPT=0 下凭证缺失会直接报错（不卡死）。
 * @param {string} stderr - git 命令的 stderr 原文。
 * @returns {'凭证缺失或认证失败' | '网络不可达或连接失败' |
 *   '远端仓库不存在或无权访问' | '未知错误'}
 */
function classifyRemoteError(stderr) {
  const err = String(stderr ?? '')
  if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(err)) {
    return '凭证缺失或认证失败'
  }
  if (/Could not resolve host|Operation timed out|Connection (refused|reset)/i.test(err)) {
    return '网络不可达或连接失败'
  }
  if (/Repository not found|not found|does not appear to be a git repository/i.test(err)) {
    return '远端仓库不存在或无权访问'
  }
  return '未知错误'
}

/**
 * 白名单记忆文件 entryId 补发（锁内同步调用；有变化才写回）。
 * 返回补发条数；只处理 KEY.md / KEY-archive.md / MEMORY.md / logs/*.md。
 * @param {string} dir - 记忆仓库目录。
 * @returns {number} 补发的条目总数。
 */
/**
 * 白名单记忆文件 entryId 补发（锁内同步调用；有变化才写回）。
 * 按文件集展开（项目级 KEY 家族 + logs/；全局轨 MEMORY/USER/归档/daily/*.md）；
 * TODO 格式文件（TODOS 家族）跳过——它们有自己的 tag id，不需要行首身份证。
 * @param {string} dir - 记忆仓库目录。
 * @param {string} [fileset='project'] - 文件集。
 * @returns {{backfilled: number, skipped: number}} 补发/跳过条数。
 */
function backfillEntryIds(dir, fileset = 'project') {
  let backfilled = 0
  let skipped = 0
  const files = []
  const { memory } = resolveFilesetFiles(dir, fileset)
  for (const rel of memory) {
    const p = join(dir, rel)
    if (existsSync(p) && statSync(p).isFile()) files.push(p)
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
      // 同名冲突：源保留双份（备份后缀），目标版本不动。
      // 备份名带时间戳（Kimi P2-6）：二次迁移同名冲突不覆盖上一份备份
      const backup = `${dst}.pre-migrate.${Date.now()}`
      renameSync(src, backup)
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
 * PROVENANCE/.gitignore 以本地工作树为准，不参与合并）。
 * 2026-08-11 统一模式：TODOS.md（项目待办）并入项目记忆轨。
 * @param {string} path - 相对路径（如 'KEY.md'、'logs/2026-08-10.md'）。
 * @returns {boolean}
 */
// isMemoryFile/isTodoPath 由 lib/sync/filesets.js 提供（项目级与全局轨
// 文件集统一判定）；此处仅保留向后兼容的 re-export（worker 等历史 import）
export { isMemoryFile } from './filesets.js'

/**
 * 解析 TODO 记忆文件为条目数组（剥文件头注释块 + § 切分）。
 * TODOS.md 有 HTML 注释头（todo.js 的 TODO_HEADER）与 tag 行 id
 * （[id: xxxx]，带空格、在首行 tag 内）——与记忆文件的 [id:xxxx] 行首
 * 身份证不同。同步侧必须专用读取：不剥 header 会把注释块当成条目；
 * 直接用 parseEntries 会导致补发破坏 tag 格式（见 merge.js 的按文件分流）。
 * @param {string} text - TODOS.md 全文。
 * @returns {string[]} 条目数组（无 header、trim 后非空）。
 */
export function parseTodoEntries(text) {
  const body = String(text ?? '')
    .replace(/^<!--[\s\S]*?-->\s*/, '')
    .replace(/^\s*§\s*\n?/, '')
    .trim()
  if (body === '') return []
  return body
    .split(ENTRY_DELIMITER)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * 序列化 TODO 记忆文件（header + § 条目）。与 todo.js 的写盘格式**逐字节
 * 一致**（HEADER + '\n§\n' + § 分隔条目；空文件只写 HEADER，Grok P2-2）——
 * 保证同步写回与 todo.js 自身写盘零 diff 噪音，todo 解析器正常读取。
 * header 参数（Kimi P2-5）：优先保留本机原 header（用户可能自定义过），
 * 缺省用 TODO_HEADER 常量。
 * @param {string[]} entries - 条目数组。
 * @param {string} [header=TODO_HEADER] - 文件头注释块原文。
 * @returns {string} 完整文件文本。
 */
export function serializeTodoEntries(entries, header = TODO_HEADER) {
  const body = (entries ?? []).filter((e) => typeof e === 'string' && e.trim() !== '')
  return `${header}${body.length > 0 ? `\n§\n${body.join('\n§\n')}\n` : ''}`
}

/**
 * 提取 TODO 文件头注释块原文（`<!-- ... -->`）；无注释块时回退 TODO_HEADER
 * 常量。与 parseTodoEntries 的剥离正则同源（Kimi P2-5：写回时保留本机
 * 原 header，不静默替换为用户自定义版本）。
 * @param {string} text - TODOS.md 全文。
 * @returns {string} 注释块原文（含 <!-- -->）。
 */
export function extractTodoHeader(text) {
  const m = /^<!--[\s\S]*?-->/.exec(String(text ?? ''))
  return m === null ? TODO_HEADER : m[0]
}

/**
 * 读取某个 git 树（ref/commit）里的全部文件为 { 路径: 条目[] }（仅同步记忆
 * 文件 + PROVENANCE——PROVENANCE 用于身份校验，不参与合并）。
 * **格式预检（Codex P0-2）**：记忆文件 parse→serialize 不能往返（CRLF/
 * 手工编辑）或 TODO 含 CRLF → 记入 invalid 清单，调用方必须中止合并
 * （坏格式数据绝不进合并器被"修复"成结构损坏）。
 * @param {string} dir - 记忆仓库目录。
 * @param {string} ref - ref/commit 名（如 'refs/remotes/origin/dsh-shared/memory'）。
 * @returns {Promise<{ files: Record<string, string[]>, provenance: string | null,
 *   invalid: Array<{path: string, reason: string}> }>}
 */
export async function readTreeFiles(dir, ref, fileset = 'project') {
  const files = {}
  let provenance = null
  const invalid = []
  // TODO 文件头映射（Codex 二轮 P1-6）：远端自定义 header 必须保留——
  // 新设备首次拉取、本地无文件时用远端 header 重建，不静默换成默认值
  const headers = {}
  const ls = await runGit(dir, ['ls-tree', '-r', '--name-only', ref])
  if (!ls.ok) return { files, provenance, invalid, headers }
  const names = ls.stdout.split('\n').map((n) => n.trim()).filter((n) => n.length > 0)
  for (const name of names) {
    // 只读同步记忆文件与 PROVENANCE（其余文件不进合并、不读）
    if (name === 'PROVENANCE') {
      const show = await runGit(dir, ['show', `${ref}:${name}`])
      if (show.ok) provenance = show.stdout
      continue
    }
    if (!isMemoryFile(name, fileset)) continue
    const show = await runGit(dir, ['show', `${ref}:${name}`])
    if (show.ok) {
      const text = show.stdout
      // TODO 格式文件（TODOS.md / TODOS-life.md / TODOS-work.md /
      // daily/*.todo.md）用专用解析（剥 header；tag 行 id 由合并器识别）；
      // 普通记忆文件 § 切分（合并器输入）
      if (isTodoPath(name)) {
        if (text.includes('\r')) invalid.push({ path: name, reason: 'TODO 文件含 CRLF（程序写盘不应出现）' })
        files[name] = parseTodoEntries(text)
        headers[name] = extractTodoHeader(text)
      } else {
        if (!isCanonical(text)) invalid.push({ path: name, reason: '记忆文件格式异常（CRLF/手工编辑，parse→serialize 不能往返）' })
        files[name] = parseEntries(text)
      }
    }
  }
  return { files, provenance, invalid, headers }
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
/**
 * 仓库级同步操作锁（Codex 二轮 P1-7）：串行化同一 .git 的 fetch/index/ref/
 * push 操作——多会话并发 sync 同一仓库会互相踩 git ref lock（第二个进程
 * 误删第一个的 lock/tracking ref）。**独立于 .memory.lock**（不占 MemoryStore
 * 写锁等网络——fetch 在锁内等待不阻塞 store 写）；stale 判定与主进程同源。
 * 锁文件 .sync.lock（非同步记忆文件，deny-all 白名单外自动忽略）。
 */
export async function asyncSyncLock(dir, fn) {
  const lockPath = join(dir, '.sync.lock')
  mkdirSync(dir, { recursive: true })
  const deadline = Date.now() + 30000 // sync 含网络 fetch，给足 30s
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
    if (isStaleLock(lockPath)) rmSync(lockPath, { force: true })
    if (Date.now() >= deadline) {
      throw new Error('dsh-memory-evolve: timed out waiting for the sync lock')
    }
    await sleep(50)
  }
  try {
    return await fn()
  } finally {
    rmSync(lockPath, { force: true })
  }
}

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
