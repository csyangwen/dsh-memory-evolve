/**
 * dsh-memory-evolve — 版本检测与更新模块（一期，v3）。
 *
 * 职责：检测远端 GitHub 仓库的发布版本（严格格式 git tag v0.x.y），
 * 由用户决定是否手动更新（git fetch + checkout --detach）。
 *
 * 设计要点（吸收三轮 CodeX 评审，含第三轮 P0-1~P0-3 / P1-1~P1-4 / P2-1~P2-3）：
 *   - 版本判断：严格 tag 格式 + SemVer 字符串比较；latest 只认 commit SHA
 *     祖先关系（merge-base，区分 exit 1 与执行失败）；同名本地 tag 不作证据。
 *   - 运行/磁盘版本分离（P0-1 三轮修订）：进程启动捕获 runningHeadSha +
 *     runningTag；restartRequired 派生 = 事务标志 && runningHeadSha !==
 *     state.headSha——checkout 成功后**先用本地 rev-parse HEAD 更新磁盘
 *     字段**（不依赖远端重检），远端重检失败不得覆盖/阻塞本地状态。
 *   - 锁（P0-2 三轮修订）：open 'wx' 原子创建 + owner token（pid+token
 *     双校验释放）；stale 阈值 10 分钟 > 事务最坏时长；stale 抢占用
 *     rename 原子搬走锁文件、核对内容一致才删除（防"读旧锁-删新锁"
 *     TOCTOU）；token 为 update 调用局部变量（防 checker 级共享误释放）。
 *   - 状态双文件（P0-3 三轮修订）：检测缓存（update-state.json）与事务
 *     字段（update-tx.json）分离——检测写绝不触碰事务文件，跨进程交错
 *     不再互相覆盖；各自原子写 + 损坏备份重建；gitdir 不可写时回退
 *     fallbackDir，并持久化 fallback 标记（重启后延续，P2-2）。
 *   - 缓存（P1-1 三轮修订）：lastError 存在时只走失败退避（30min），
 *     退避到期直接重检，**不再命中成功 TTL**（防一次故障冻结 24h）；
 *     无 lastError 才走成功 TTL（24h）；时间戳先验合法区间；force 绕过。
 *   - 事务：expectedTag 复核（锁内本次检测必须成功）→ dirty/原 HEAD
 *     前置失败中止 → 私有 refs 精确 fetch（--no-tags --atomic）→ SHA
 *     核验 → origin/main 信任校验 → checkout --detach <sha> → 回滚三态
 *     （ok/failed/unknown，unknown 也给出手动恢复命令，P1-2）。
 *   - git 执行：execFile 封装，非交互；检测 8s / 变更 120s；退出码取
 *     err.code（number）回退 err.status；timeout 判定 killed/signal。
 *
 * 依赖注入（测试用）：createUpdateChecker({ repoDir, fallbackDir, now, run })。
 * 生产用 getUpdateChecker() 模块级单例（runningHeadSha/runningTag 只捕获
 * 一次，热装配回调重跑不清除重启提示）。
 *
 * Zero runtime dependencies。
 *
 * @module dsh-memory-evolve/update
 */

import { execFile, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 成功检测的缓存有效期（24h 惰性重检，用户拍板不做常驻定时器）。 */
const TTL_MS = 24 * 60 * 60 * 1000
/** 检测失败退避：30 分钟内不自动重试（force 绕过；到期后直接重检，
 *  不再命中成功 TTL——P1-1 三轮修订）。 */
const FAIL_BACKOFF_MS = 30 * 60 * 1000
/** 检测类只读命令超时。 */
const CHECK_TIMEOUT_MS = 8000
/** 变更类命令超时（fetch / checkout）。 */
const MUTATE_TIMEOUT_MS = 120000
/** git 输出上限。 */
const MAX_OUTPUT = 1 * 1024 * 1024
/** 严格发布 tag 格式。 */
const TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
/** 状态文件 schema 版本。 */
const STATE_SCHEMA = 1
/** 更新锁 stale 阈值：10 分钟，大于事务最坏时长（fetch 120s + checkout
 *  120s + 若干 8s 检测 ≈ 5 分钟内），防活跃事务被误抢占（P0-2 三轮）。 */
const LOCK_STALE_MS = 10 * 60 * 1000
/** 发布说明最大展示长度。 */
const NOTES_MAX = 500
/** updater 私有 refs 命名空间。 */
const PRIVATE_REFS = 'refs/remotes/dsh-memory-evolve-update'
/** 状态文件名（检测缓存）与事务文件名（重启提示/审计，与检测分离）。 */
const STATE_FILE = 'update-state.json'
const TX_FILE = 'update-tx.json'
/** fallback 标记文件名（持久化 fallback 选择，重启后延续，P2-2）。 */
const FALLBACK_MARK_FILE = 'dsh-memory-evolve-fallback.json'

/** git 子进程非交互环境。 */
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new',
}

// ---------------------------------------------------------------------------
// SemVer 工具
// ---------------------------------------------------------------------------

/**
 * 解析严格格式 tag；不合法返回 null。数值段同时保留 Number 与
 * 去前导零字符串（比较用字符串，避免 Number 精度损失）。
 */
export function parseVersion(tag) {
  const m = TAG_RE.exec(String(tag ?? ''))
  if (!m) return null
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    majorStr: m[1], minorStr: m[2], patchStr: m[3],
  }
}

/** 数值段字符串比较（去前导零后按长度+字典序）。 */
function cmpNumStr(a, b) {
  const cleanA = a.replace(/^0+/, '') || '0'
  const cleanB = b.replace(/^0+/, '') || '0'
  if (cleanA.length !== cleanB.length) return cleanA.length < cleanB.length ? -1 : 1
  if (cleanA === cleanB) return 0
  return cleanA < cleanB ? -1 : 1
}

/** 语义版本比较。 */
export function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    const c = cmpNumStr(a[`${key}Str`], b[`${key}Str`])
    if (c !== 0) return c
  }
  return 0
}

// ---------------------------------------------------------------------------
// git runner
// ---------------------------------------------------------------------------

/**
 * 统一 git 执行封装。kind：ok | enoent | not-repo | timeout | conflict |
 * error（auth/network 由 kind 细分）。code：数字退出码。
 */
export async function runGit(repoDir, args, opts = {}) {
  const timeout = opts.timeout ?? CHECK_TIMEOUT_MS
  const run = opts.run ?? execFileP
  try {
    const { stdout, stderr } = await run('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT,
      timeout,
      windowsHide: true,
      env: { ...process.env, ...GIT_ENV, ...(opts.env ?? {}) },
    })
    return { ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), kind: 'ok' }
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'EACCES') {
      return { ok: false, stdout: '', stderr: '', kind: 'enoent' }
    }
    if (err?.killed === true || err?.signal != null) {
      return { ok: false, stdout: '', stderr: '', kind: 'timeout' }
    }
    const stderr = String(err?.stderr ?? '')
    if (args[0] === 'rev-parse' && (stderr.includes('not a git repository') || stderr.includes('not a git work tree'))) {
      return { ok: false, stdout: '', stderr, kind: 'not-repo' }
    }
    // 退出码：promisify(execFile) 的数字退出码在 err.code；err.status 可能缺失。
    const exitCode = typeof err?.code === 'number' ? err.code : (typeof err?.status === 'number' ? err.status : undefined)
    return { ok: false, stdout: '', stderr, kind: classifyError(stderr) ?? 'error', code: exitCode }
  }
}

/** 按 stderr 关键词细分错误。 */
export function classifyError(stderr) {
  const s = String(stderr ?? '')
  if (/permission denied|authentication failed|could not read from remote|publickey/i.test(s)) return 'auth'
  if (/could not resolve host|connection (timed out|refused|reset)|operation timed out|name or service not known|network is unreachable|temporary failure/i.test(s)) return 'network'
  if (/would be overwritten|unable to unlink|failed to (lock|write)|index\.lock|is not empty/i.test(s)) return 'conflict'
  if (/timed out/i.test(s)) return 'timeout'
  return 'error'
}

// ---------------------------------------------------------------------------
// 状态文件（检测缓存与事务字段分离；原子写；损坏备份；fallback 标记）
// ---------------------------------------------------------------------------

/** 默认检测缓存。 */
function defaultCache() {
  return {
    schemaVersion: STATE_SCHEMA,
    repoPath: '',
    remoteUrl: '',
    status: 'unknown', // latest | outdated | no-release | unsupported | unknown
    latestTag: null,
    latestSha: null,
    localTag: null,
    headSha: null,
    noteCode: '',
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  }
}

/** 默认事务字段。 */
function defaultTx() {
  return { restartRequired: false, lastUpdated: null }
}

/**
 * 读 JSON 文件（不存在返回默认；损坏时备份 .corrupt-<ts> 并重建）。
 * @param {string} path
 * @param {() => object} makeDefault
 */
export function readJson(path, makeDefault) {
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { value: makeDefault(), corrupt: false }
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { value: { ...makeDefault(), ...parsed }, corrupt: false }
    }
  } catch {
    /* 落到备份分支 */
  }
  try {
    renameSync(path, `${path}.corrupt-${Date.now()}`)
  } catch {
    /* 备份失败不阻塞重建 */
  }
  return { value: makeDefault(), corrupt: true }
}

/** 原子写 JSON（同目录唯一临时文件 + rename）。 */
export function writeState(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, path)
}

/** 解析 git 管理目录（兼容 .git 目录与 .git 文件式 worktree）。 */
export async function resolveStatePath(repoDir, run = execFileP) {
  const r = await runGit(repoDir, ['rev-parse', '--absolute-git-dir'], { run })
  if (!r.ok || r.kind !== 'ok') return null
  const gitDir = String(r.stdout ?? '').trim()
  if (!gitDir) return null
  return { gitDir }
}

// ---------------------------------------------------------------------------
// 跨进程更新锁（原子创建 + owner token + 防 TOCTOU 抢占）
// ---------------------------------------------------------------------------

/**
 * 获取更新排他锁。
 * 原子性：openSync('wx') 创建（O_EXCL），并发只有一个成功；锁内容
 * { pid, token, startedAt }。已存在且未超 stale（10 分钟）→ 冲突。
 * stale 抢占：**rename 原子搬走锁文件**，核对搬走内容与读到的一致才
 * 删除（防"读旧锁-删新锁"TOCTOU——他人若在我们读取后抢先写入了新锁，
 * 搬走的是新锁，核对不一致会原样放回并返回冲突，P0-2 三轮修订）。
 * @param {string} gitDir
 * @param {number} now
 * @returns {Promise<{ok:boolean, token?:string, reason?:string}>}
 */
export async function acquireUpdateLock(gitDir, now = Date.now()) {
  const lockDir = join(gitDir, 'dsh-memory-evolve')
  mkdirSync(lockDir, { recursive: true })
  const lockPath = join(lockDir, 'update.lock')
  const token = randomBytes(8).toString('hex')
  const payload = JSON.stringify({ pid: process.pid, token, startedAt: now })

  const tryCreate = () => {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeFileSync(fd, payload, 'utf8')
      } finally {
        closeSync(fd) // 防 fd 泄漏（P2-3 三轮修订）
      }
      return true
    } catch (err) {
      if (err?.code === 'EEXIST') return false
      throw err
    }
  }

  if (tryCreate()) return { ok: true, token }

  // 已存在：读锁内容判断是否 stale。
  let staleInfo = null
  try {
    const existing = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (typeof existing?.startedAt === 'number' && now - existing.startedAt >= LOCK_STALE_MS) staleInfo = existing
    else if (typeof existing?.startedAt !== 'number') staleInfo = { pid: '?', token: '?', startedAt: 0 } // 损坏锁 → 抢占
  } catch {
    staleInfo = { pid: '?', token: '?', startedAt: 0 }
  }
  if (!staleInfo) {
    let pid = '?'
    try { pid = JSON.parse(readFileSync(lockPath, 'utf8')).pid } catch { /* ignore */ }
    return { ok: false, reason: `更新正在进行（PID ${pid}）` }
  }

  // stale 抢占：原子搬走锁文件，核对内容一致才删（防误删他人新锁）。
  try {
    const reaped = `${lockPath}.reap-${process.pid}-${Date.now()}`
    renameSync(lockPath, reaped)
    let reapedInfo = null
    try {
      reapedInfo = JSON.parse(readFileSync(reaped, 'utf8'))
    } catch {
      /* 搬走的锁损坏：直接删除（无人能持有损坏锁） */
    }
    const same = reapedInfo && reapedInfo.pid === staleInfo.pid && reapedInfo.token === staleInfo.token
    if (same || !reapedInfo) {
      unlinkSync(reaped)
    } else {
      // 内容不同：我们读的是旧锁，但已被他人换成新锁——原样放回。
      renameSync(reaped, lockPath)
      return { ok: false, reason: '更新正在进行（锁已被他人接管）' }
    }
  } catch {
    /* 搬走失败（锁已被他人处理）→ 直接尝试创建 */
  }
  if (tryCreate()) return { ok: true, token }
  return { ok: false, reason: '更新正在进行（并发抢占失败）' }
}

/**
 * 释放更新锁：pid + token 都匹配才删除（防误删他人新锁）。
 * @param {string} gitDir
 * @param {string} token
 */
export function releaseUpdateLock(gitDir, token) {
  try {
    const lockPath = join(gitDir, 'dsh-memory-evolve', 'update.lock')
    const existing = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (existing?.pid === process.pid && existing?.token === token) {
      unlinkSync(lockPath)
    }
  } catch {
    /* 忽略：锁已不存在或不属于本进程 */
  }
}

// ---------------------------------------------------------------------------
// 检测器 / 更新器
// ---------------------------------------------------------------------------

/**
 * 创建版本检测/更新控制器（每次调用探测一次运行版本；测试用独立实例，
 * 生产用 getUpdateChecker() 单例）。
 */
export function createUpdateChecker(opts = {}) {
  const repoDir = opts.repoDir ?? dirname(dirname(fileURLToPath(import.meta.url)))
  const fallbackDir = opts.fallbackDir ?? join(process.env.HOME ?? '', '.dsh')
  const now = opts.now ?? Date.now
  const run = opts.run

  // 进程内 single-flight。
  let inFlightCheck = null
  // 状态目录定位缓存（null=未定位；'gitdir' | 'fallback'）。
  let stateDirMode = null

  /**
   * 运行版本（进程首次创建 checker 时同步捕获）：
   *   runningTag = 磁盘 tag；runningHeadSha = HEAD commit。
   * restartRequired 派生用 **SHA** 比较（P0-1 三轮修订：同名 tag 被移动
   * 后 tag 相等但 SHA 已变；SHA 判定最可靠）。
   */
  let runningTag = null
  let runningHeadSha = null
  try {
    const env = { ...process.env, ...GIT_ENV }
    const tag = spawnSync('git', ['describe', '--tags', '--match', 'v*', '--abbrev=0'], {
      cwd: repoDir, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'], env,
    })
    if (!tag.error && tag.status === 0) {
      const candidate = String(tag.stdout ?? '').trim()
      if (parseVersion(candidate)) runningTag = candidate
    }
    const head = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'], env,
    })
    if (!head.error && head.status === 0) runningHeadSha = String(head.stdout ?? '').trim()
  } catch {
    runningTag = null
    runningHeadSha = null
  }

  /** 状态文件所在目录（gitdir 或 fallbackDir）+ 两文件路径。 */
  function pathsOf(dir) {
    return {
      cache: join(dir, 'dsh-memory-evolve', STATE_FILE),
      tx: join(dir, 'dsh-memory-evolve', TX_FILE),
    }
  }

  /**
   * 定位状态目录：
   *   - 解析 gitdir 成功：若存在 fallback 标记且标记指向当前 gitdir →
   *     延续 fallback（P2-2：重启后不丢 fallback 期间的写入）；否则 gitdir。
   *   - 解析失败（非仓库）→ fallbackDir。
   * @returns {Promise<{dir:string, mode:'gitdir'|'fallback'}>}
   */
  async function locateStateDir() {
    if (stateDirMode) return stateDirMode === 'gitdir' ? { dir: await gitDirOf(), mode: 'gitdir' } : { dir: fallbackDir, mode: 'fallback' }
    const resolved = await resolveStatePath(repoDir, run)
    if (!resolved) {
      stateDirMode = 'fallback'
      return { dir: fallbackDir, mode: 'fallback' }
    }
    // fallback 标记延续：标记存在且 gitDir 匹配 → 继续用 fallback。
    const markPath = join(fallbackDir, FALLBACK_MARK_FILE)
    try {
      const mark = JSON.parse(readFileSync(markPath, 'utf8'))
      if (mark?.gitDir === resolved.gitDir && mark.at) {
        stateDirMode = 'fallback'
        return { dir: fallbackDir, mode: 'fallback' }
      }
    } catch {
      /* 无标记 → gitdir */
    }
    stateDirMode = 'gitdir'
    return { dir: resolved.gitDir, mode: 'gitdir' }
  }

  /** 只解析 gitdir（不触发 fallback 标记逻辑）。 */
  async function gitDirOf() {
    const resolved = await resolveStatePath(repoDir, run)
    return resolved ? resolved.gitDir : fallbackDir
  }

  /**
   * 合并读：缓存 + 事务字段。
   */
  async function loadState() {
    const loc = await locateStateDir()
    const p = pathsOf(loc.dir)
    const cache = readJson(p.cache, defaultCache).value
    const tx = readJson(p.tx, defaultTx).value
    return { ...cache, ...tx }
  }

  /** 写检测缓存（绝不触碰事务字段——双文件分离，P0-3 三轮修订）。 */
  async function saveCache(patch) {
    const loc = await locateStateDir()
    const p = pathsOf(loc.dir)
    const { value: prev } = readJson(p.cache, defaultCache)
    const merged = { ...prev, ...patch, schemaVersion: STATE_SCHEMA }
    try {
      writeState(p.cache, merged)
    } catch (err) {
      if (loc.mode === 'fallback') throw err
      // gitdir 不可写 → 切 fallback 并持久化标记（P2-2）。
      stateDirMode = 'fallback'
      try {
        writeState(join(fallbackDir, FALLBACK_MARK_FILE), { gitDir: loc.dir, at: now() })
      } catch { /* 忽略 */ }
      const fp = pathsOf(fallbackDir)
      const { value: fbPrev } = readJson(fp.cache, defaultCache)
      writeState(fp.cache, { ...fbPrev, ...patch, schemaVersion: STATE_SCHEMA })
    }
  }

  /** 写事务字段（仅更新事务调用；检测绝不调用）。 */
  async function saveTx(patch) {
    const loc = await locateStateDir()
    const p = pathsOf(loc.dir)
    const { value: prev } = readJson(p.tx, defaultTx)
    const merged = { ...prev, ...patch }
    try {
      writeState(p.tx, merged)
    } catch (err) {
      if (loc.mode === 'fallback') throw err
      stateDirMode = 'fallback'
      try {
        writeState(join(fallbackDir, FALLBACK_MARK_FILE), { gitDir: loc.dir, at: now() })
      } catch { /* 忽略 */ }
      const fp = pathsOf(fallbackDir)
      const { value: fbPrev } = readJson(fp.tx, defaultTx)
      writeState(fp.tx, { ...fbPrev, ...patch })
    }
  }

  /**
   * 检查仓库可用性 + 远端地址；不可用返回 null。
   */
  async function probeRepo() {
    const resolved = await resolveStatePath(repoDir, run)
    if (!resolved) return null
    const url = await runGit(repoDir, ['config', '--get', 'remote.origin.url'], { run })
    if (!url.ok) return null
    return { gitDir: resolved.gitDir, remoteUrl: String(url.stdout ?? '').trim() }
  }

  /**
   * 执行一次完整检测（不读缓存）。只写检测缓存文件。
   * @returns {Promise<{ok:boolean, state:object}>}
   *   ok=false 表示远端检测未成功（ls-remote 失败/非仓库）——调用方
   *   （更新事务）必须要求 ok=true。
   */
  async function doCheck() {
    const prev = await loadState()
    const repo = await probeRepo()
    const attemptAt = now()

    if (!repo) {
      await saveCache({
        status: 'unsupported',
        lastAttemptAt: attemptAt,
        lastError: { kind: 'unsupported', message: '插件目录不是 git 仓库或 git 不可用（请用 git clone 安装）' },
        noteCode: 'unsupported',
      })
      return { ok: false, state: { ...prev, status: 'unsupported' } }
    }

    const ls = await runGit(repoDir, ['ls-remote', '--tags', 'origin'], { run })
    if (!ls.ok) {
      await saveCache({ lastAttemptAt: attemptAt, lastError: { kind: ls.kind, message: `远端检测失败（${ls.kind}）` } })
      return { ok: false, state: { ...prev, lastAttemptAt: attemptAt, lastError: { kind: ls.kind, message: `远端检测失败（${ls.kind}）` } } }
    }
    const tags = parseTagRefs(ls.stdout)
    const latest = tags.length > 0 ? tags[tags.length - 1] : null

    const head = await runGit(repoDir, ['rev-parse', 'HEAD'], { run })
    const headSha = head.ok ? String(head.stdout ?? '').trim() : null
    const desc = await runGit(repoDir, ['describe', '--tags', '--match', 'v*', '--abbrev=0'], { run })
    let localTag = null
    if (desc.ok) {
      const candidate = String(desc.stdout ?? '').trim()
      localTag = parseVersion(candidate) ? candidate : null
    }

    let status = 'latest'
    let noteCode = ''
    if (!latest) {
      status = 'no-release'
      noteCode = 'no-release'
    } else if (headSha && latest.sha) {
      const ancestor = await runGit(repoDir, ['merge-base', '--is-ancestor', latest.sha, 'HEAD'], { run })
      if (ancestor.ok) {
        status = 'latest'
        noteCode = headSha === latest.sha ? 'latest-exact' : 'latest-contained'
      } else if (ancestor.code === 1) {
        status = 'outdated'
        noteCode = 'outdated'
      } else {
        status = 'outdated'
        noteCode = 'outdated'
      }
    } else {
      status = 'outdated'
      noteCode = 'outdated'
    }

    await saveCache({
      repoPath: safeRealpath(repoDir),
      remoteUrl: repo.remoteUrl,
      status,
      latestTag: latest?.tag ?? null,
      latestSha: latest?.sha ?? null,
      localTag,
      headSha,
      lastAttemptAt: attemptAt,
      lastSuccessAt: attemptAt,
      lastError: null,
      noteCode,
    })
    return { ok: true, state: { ...prev, status, latestTag: latest?.tag ?? null, latestSha: latest?.sha ?? null, localTag, headSha, noteCode } }
  }

  /**
   * 检测入口：失败退避优先（lastError 存在时只走退避，到期直接重检——
   * 不命中成功 TTL，P1-1）；无失败才走成功 TTL；时间戳先验合法区间；
   * force 绕过；single-flight。
   */
  async function status(force = false) {
    const prev = await loadState()
    const t = now()
    if (!force) {
      if (prev.lastError) {
        // 失败退避：距上次尝试 <30min 不自动重试；到期 → 直接重检。
        const attempt = prev.lastAttemptAt
        const attemptValid = typeof attempt === 'number' && attempt >= 0 && attempt <= t
        if (attemptValid && t - attempt < FAIL_BACKOFF_MS) return withDerivedRestart(prev)
      } else {
        // 成功 TTL：距上次成功 <24h → 命中缓存（remote 变化则重检）。
        const okAt = prev.lastSuccessAt
        const okValid = typeof okAt === 'number' && okAt >= 0 && okAt <= t
        if (okValid && t - okAt < TTL_MS) {
          const url = await runGit(repoDir, ['config', '--get', 'remote.origin.url'], { run })
          const remoteUrl = url.ok ? String(url.stdout ?? '').trim() : ''
          if (remoteUrl !== prev.remoteUrl) return doCheck().then((r) => withDerivedRestart(r.state))
          return withDerivedRestart(prev)
        }
      }
    }
    if (inFlightCheck) return inFlightCheck.then((r) => withDerivedRestart(r.state))
    inFlightCheck = doCheck().finally(() => { inFlightCheck = null })
    return inFlightCheck.then((r) => withDerivedRestart(r.state))
  }

  /**
   * 派生 restartRequired：事务标志 && 运行 HEAD ≠ 磁盘 HEAD（SHA 判定，
   * P0-1 三轮修订：同名 tag 移动、tag 比较不可靠场景均覆盖）。
   */
  function withDerivedRestart(state) {
    const needsRestart = state.restartRequired === true && (runningHeadSha === null || runningHeadSha !== state.headSha)
    return { ...state, restartRequired: needsRestart }
  }

  /**
   * 手动更新（expectedTag 由用户当前看到的版本提交）。
   * 事务：锁（token 局部变量）→ 锁内强制重检（必须成功）→ 目标变化 409 →
   * dirty 检查 → 原 HEAD → 私有 refs fetch → SHA 核验 → 信任校验 →
   * checkout --detach <sha> → 回滚三态 → **本地磁盘字段先行落盘**
   * （rev-parse HEAD，不依赖远端）→ 远端重检（失败不阻塞）→ 事务字段。
   */
  async function update(expectedTag) {
    if (!parseVersion(expectedTag)) {
      return { ok: false, code: 'bad-request', error: `expectedTag 必须是严格格式版本号（如 v1.2.3），收到：${String(expectedTag ?? '')}` }
    }

    const gitDirRes = await resolveStatePath(repoDir, run)
    if (!gitDirRes) return { ok: false, code: 'unsupported', error: '插件目录不是 git 仓库（请用 git clone 安装）' }

    const lock = await acquireUpdateLock(gitDirRes.gitDir, now())
    if (!lock.ok) return { ok: false, code: 'busy', error: lock.reason ?? '更新正在进行' }
    // token 为本次调用局部变量（三轮 P0-2：checker 级共享变量会放大
    // stale 重入后的误释放风险）。
    const lockToken = lock.token

    try {
      // —— 锁内强制重检：本次必须成功（ls-remote 失败即中止，不沿用旧字段）——
      const fresh = await doCheck()
      if (!fresh.ok) {
        return { ok: false, code: 'error', error: '更新前远端复核失败，已中止（请检查网络/SSH 后重试）' }
      }
      const freshState = fresh.state
      if (freshState.latestTag !== expectedTag || !freshState.latestSha) {
        return { ok: false, code: 'target-changed', error: freshState.latestTag ? `远端最新版本已变为 ${freshState.latestTag}，请重新确认` : '远端当前无发布版本' }
      }

      // —— dirty 检查（命令失败也中止）——
      const dirty = await runGit(repoDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { run })
      if (!dirty.ok) {
        return { ok: false, code: 'error', error: `工作树状态检查失败（${dirty.kind}），已中止` }
      }
      if (String(dirty.stdout ?? '').length > 0) {
        const files = String(dirty.stdout ?? '').split('\0').filter(Boolean).slice(0, 20).map((line) => line.slice(3) || line)
        return { ok: false, code: 'dirty', error: `工作树有未提交改动（${files.length} 项，如：${files.slice(0, 5).join('、')}）。请先提交、还原或另存后再更新` }
      }

      // —— 原 HEAD（回滚锚点）——
      const orig = await runGit(repoDir, ['rev-parse', 'HEAD'], { run })
      if (!orig.ok) {
        return { ok: false, code: 'error', error: '无法读取当前 HEAD，已中止' }
      }
      const originalHead = String(orig.stdout ?? '').trim()

      // —— 私有 refs 精确 fetch（不碰本地 tag/main）——
      const tagRef = `${PRIVATE_REFS}/tag/${expectedTag}`
      const mainRef = `${PRIVATE_REFS}/main`
      const fetch = await runGit(repoDir, [
        'fetch', '--no-tags', '--atomic', 'origin',
        `refs/tags/${expectedTag}:${tagRef}`,
        `refs/heads/main:${mainRef}`,
      ], { timeout: MUTATE_TIMEOUT_MS, run })
      if (!fetch.ok) {
        return { ok: false, code: 'error', error: `拉取远端失败（${fetch.kind}），请检查网络/SSH 后重试` }
      }

      // —— SHA 核验 ——
      const tagObj = await runGit(repoDir, ['rev-parse', `${tagRef}^{}`], { run })
      const sha = tagObj.ok ? String(tagObj.stdout ?? '').trim() : null
      if (!sha || sha !== freshState.latestSha) {
        return { ok: false, code: 'target-changed', error: '标签内容与检测时不一致（可能已被移动），请重新检查' }
      }

      // —— 信任边界：发布提交必须是 origin/main 祖先 ——
      const trusted = await runGit(repoDir, ['merge-base', '--is-ancestor', sha, mainRef], { run })
      if (!trusted.ok && trusted.code !== 1) {
        return { ok: false, code: 'error', error: `信任校验执行失败（${trusted.kind}），已中止` }
      }
      if (trusted.code === 1) {
        return { ok: false, code: 'untrusted', error: `${expectedTag} 不在 origin/main 的历史上，已拒绝更新` }
      }

      // —— checkout --detach <sha> ——
      const co = await runGit(repoDir, ['checkout', '--detach', sha], { timeout: MUTATE_TIMEOUT_MS, run })
      if (!co.ok) {
        // 回滚三态（P1-2 三轮修订）：none=HEAD 未动；ok=已回滚；
        // failed/unknown=需给出手动恢复命令（不能谎称已回滚）。
        let rollback = 'none'
        const headNow = await runGit(repoDir, ['rev-parse', 'HEAD'], { run })
        if (!headNow.ok) {
          rollback = 'unknown'
        } else if (String(headNow.stdout ?? '').trim() !== originalHead) {
          const rb = await runGit(repoDir, ['checkout', '--detach', originalHead], { timeout: MUTATE_TIMEOUT_MS, run })
          rollback = rb.ok ? 'ok' : 'failed'
        }
        const hints = {
          ok: '已回滚到原状态',
          failed: '且回滚失败——请手动执行：git checkout --detach ' + originalHead,
          unknown: '且无法确认当前 HEAD——请手动检查并执行：git checkout --detach ' + originalHead,
          none: '',
        }
        return { ok: false, code: 'error', error: `切换版本失败（${co.kind}）${hints[rollback]}` }
      }

      // —— 发布说明 ——
      let releaseNotes = ''
      const notes = await runGit(repoDir, ['for-each-ref', tagRef, '--format=%(contents)'], { run })
      if (notes.ok) releaseNotes = String(notes.stdout ?? '').trim().slice(0, NOTES_MAX)

      // —— 磁盘字段先行落盘（本地命令，不依赖远端；P0-1 三轮修订）——
      const diskHead = await runGit(repoDir, ['rev-parse', 'HEAD'], { run })
      const diskHeadSha = diskHead.ok ? String(diskHead.stdout ?? '').trim() : sha
      const diskDesc = await runGit(repoDir, ['describe', '--tags', '--match', 'v*', '--abbrev=0'], { run })
      const diskTag = diskDesc.ok && parseVersion(String(diskDesc.stdout ?? '').trim()) ? String(diskDesc.stdout ?? '').trim() : expectedTag
      await saveCache({ headSha: diskHeadSha, localTag: diskTag })

      // —— 事务字段（独立文件）——
      await saveTx({ restartRequired: true, lastUpdated: { tag: expectedTag, sha, at: now(), result: 'ok', notes: releaseNotes } })

      // —— 远端重检（失败不阻塞：磁盘字段已就位，仅更新远端视图）——
      const after = await doCheck()
      const finalState = { ...after.state, restartRequired: true }

      return { ok: true, tag: expectedTag, sha, releaseNotes, restartRequired: true, state: finalState }
    } finally {
      releaseUpdateLock(gitDirRes.gitDir, lockToken)
    }
  }

  /**
   * badge 查询：基于最后成功状态（不触发任何 git 操作）。
   */
  async function badgeUpdate() {
    const prev = await loadState()
    return prev.status === 'outdated' ? 1 : 0
  }

  return { status, update, badgeUpdate, _internal: { doCheck, locateStateDir, loadState, gitDirOf } }
}

// ---------------------------------------------------------------------------
// 模块级单例（生产用）
// ---------------------------------------------------------------------------

let sharedChecker = null

/**
 * 获取模块级单例 checker（runningHeadSha/runningTag 只在进程首次创建时
 * 捕获；热装配/注入回调重跑复用同一实例，不清除重启提示）。
 */
export function getUpdateChecker(opts = {}) {
  if (!sharedChecker) sharedChecker = createUpdateChecker(opts)
  return sharedChecker
}

/** 测试辅助：重置单例。 */
export function _resetSharedChecker() {
  sharedChecker = null
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 解析 `git ls-remote --tags` 输出：仅保留严格格式 v* tag，关联 peeled
 * commit SHA，按 SemVer 升序返回。
 */
export function parseTagRefs(stdout) {
  const map = new Map()
  for (const line of String(stdout ?? '').split('\n')) {
    const m = /^([0-9a-f]{40,64})\s+refs\/tags\/(.+)$/.exec(line.trim())
    if (!m) continue
    const sha = m[1]
    const ref = m[2]
    if (ref.endsWith('^{}')) {
      const tag = ref.slice(0, -3)
      if (parseVersion(tag)) map.set(tag, { tag, sha })
    } else if (parseVersion(ref)) {
      if (!map.has(ref)) map.set(ref, { tag: ref, sha })
    }
  }
  return [...map.values()].sort((a, b) => compareVersions(parseVersion(a.tag), parseVersion(b.tag)))
}

/** realpath 失败时兜底返回原路径。 */
function safeRealpath(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
