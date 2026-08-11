/**
 * lib/sync/index.js — 记忆同步模块装配（施工图 §7 第 6 步）
 *
 * 独立子模块（2026-08-08 拍板纪律：独立领域独立开关不借别的模块）：
 *   - syncEnabled 独立开关（**默认关**——不开的项目/电脑行为与现状逐字节
 *     一致，一个多余文件都没有）；
 *   - /memory_sync 命令组（setup / sync / sync --push / off / status /
 *     conflict list / migrate）；
 *   - 快照状态行（systemPrompt.context 段，**状态驱动稳定**：未提交 N 条 /
 *     落后远端 / 冲突 K 条——变化才变，不含渲染时刻时间戳）；
 *   - GET /memory-evolve/memory-sync/status API（经 api.js deps 注入）。
 *
 * 装配要点：
 *   - store 构造注入 projectDirResolver（sync 项目目录 = projectId 而非
 *     projectHash——迁移后 store 必须能定位新目录）与 entryIdMode 动态开关；
 *   - 全部 git 网络操作经 sync-worker 子进程（异步 spawn，主进程不阻塞、
 *     绝不 spawnSync 网络命令）；本地状态查询（快照行）用 spawnSync 毫秒级
 *     命令（与 store.js gitBranch 同款先例）。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProjectSyncEnabled, projectHash, readProvenance, withLock } from '../store.js'
import { locateLegacyDir, normalizeRemoteUrl, resolveMainRemote, resolveProjectId, sanitizeRemoteUrl } from './identity.js'
import { countConflicts, CONFLICTS_FILE, parseConflicts, resolveConflict } from './worker.js'
import { deviceBConnect, ensureMemoryRepo, MODE_A_BRANCH, resolveFilesetFiles, sharedBranchFor } from './repo.js'
import { GLOBAL_FILESET_KEYS, globalBranchFor } from './filesets.js'

/** 全局轨 fileset ↔ 用户可见轨名映射（memory/user/daily/todo）。 */
const GLOBAL_TRACK_NAMES = { 'memory-global': 'memory', 'user-global': 'user', 'daily-global': 'daily', 'todo-global': 'todo' }

/** sync-worker 可执行入口（相对本文件：lib/sync/ → scripts/）。 */
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'sync-worker.mjs')

/**
 * 异步 spawn sync-worker 子进程（网络命令在子进程，主进程零阻塞）。
 * @param {string[]} args - worker 参数（sync <dir> <rb> [--push] 等）。
 * @returns {Promise<{ok: boolean, code: number | null, stdout: string, stderr: string}>}
 */
export function spawnWorker(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => resolve({ ok: false, code: 1, stdout, stderr: error.message }))
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }))
  })
}

/** 解析 worker stdout 末行的 JSON（git 进度在 stderr，stdout 只应有 JSON）。 */
function parseWorkerOutput(run) {
  const lines = String(run.stdout ?? '').trim().split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) {
    return { ok: false, code: run.code ?? 1, message: `worker 无输出${run.stderr ? `（${run.stderr.trim().split('\n')[0]}）` : ''}` }
  }
  try {
    const parsed = JSON.parse(lines[lines.length - 1])
    return { ok: parsed.ok === true, code: parsed.code ?? (parsed.ok ? 0 : 1), ...parsed }
  } catch {
    return { ok: false, code: run.code ?? 1, message: `worker 输出无法解析：${lines[lines.length - 1]}` }
  }
}

/**
 * 项目记忆目录解析器（MemoryStore 构造注入）：sync 已初始化的项目用
 * projectId 目录（迁移后 store 读写定位到新目录），否则回退现有
 * projectHash(cwd) 目录（未启用项目零变化）。
 * @param {object} config - 插件配置（memoryDir）。
 * @returns {(cwd: string) => string}
 */
export function makeProjectDirResolver(config) {
  return (cwd) => {
    const identity = resolveProjectId(cwd) // 同步本地 git 查询，毫秒级
    const syncDir = join(config.memoryDir, 'projects', identity.id)
    // 已初始化（有 PROVENANCE）→ 用 sync 目录；否则旧逻辑（兼容未启用项目）
    if (existsSync(join(syncDir, 'PROVENANCE'))) return syncDir
    return join(config.memoryDir, 'projects', projectHash(cwd))
  }
}

/**
 * 读取项目远端分支名（PROVENANCE 记录；老仓库缺省模式 A）。
 * @returns {{dir: string, remoteBranch: string, identity: object}}
 */
/** 项目同步信息（导出供测试）。 */
export function projectSyncInfo(config, cwd) {
  const identity = resolveProjectId(cwd)
  const dir = join(config.memoryDir, 'projects', identity.id)
  // 缺省分支（Kimi P2-2）：PROVENANCE 存在但缺 remoteBranch 字段 = 极老
  // 一期模式 A 仓库 → 缺省 MODE_A_BRANCH（'dsh-shared/memory'）继续沿用；
  // 新统一模式 bootstrap 一定会写 remoteBranch，不会落到缺省
  let remoteBranch = MODE_A_BRANCH
  const meta = readProvenance(dir)
  if (meta !== null) {
    if (typeof meta.remoteBranch === 'string' && meta.remoteBranch !== '') remoteBranch = meta.remoteBranch
  }
  return { dir, remoteBranch, identity, provenance: meta }
}

/**
 * 同步状态查询（快照状态行用；本地 git 命令毫秒级，无网络）。
 * @returns {{initialized: boolean, uncommitted: number, behind: number,
 *   conflicts: number} | null}
 */
export function syncStatusSync(config, cwd) {
  if (!cwd) return null
  const { dir, remoteBranch, identity } = projectSyncInfo(config, cwd)
  if (!existsSync(join(dir, '.git'))) {
    // 项目未初始化：全局区是设备级信息，必须照常携带（Codex 二轮 P1-8）
    return { initialized: false, global: globalSyncStatus(config.memoryDir) }
  }
  const rb = `refs/remotes/origin/${remoteBranch}`
  const head = runGitSync(dir, ['rev-parse', '--verify', 'HEAD'])
  const theirs = runGitSync(dir, ['rev-parse', '--verify', rb])
  const dirty = runGitSync(dir, ['status', '--porcelain'])
  const syncOrigin = runGitSync(dir, ['remote', 'get-url', 'origin'])
  const uncommitted = dirty === null ? 0 : dirty.split('\n').filter((l) => l.trim() !== '').length
  let behind = 0
  if (head !== null && theirs !== null) {
    const n = runGitSync(dir, ['rev-list', '--count', `HEAD..${rb}`])
    if (n !== null) behind = Number(n) || 0
  }
  // 未推送提交数（ahead = 本地领先远端）：**「未推送」的完整口径** =
  // 工作树未提交变更（uncommitted）+ 已提交未推送的提交（ahead）。
  // 远端分支尚不存在（首次推送前）→ 本地全部提交都算未推送（rev-list
  // 对不存在的 ref 会失败，需先判存在性）。
  let ahead = 0
  if (head !== null) {
    if (theirs === null) {
      ahead = Number(runGitSync(dir, ['rev-list', '--count', 'HEAD'])) || 0
    } else {
      const n = runGitSync(dir, ['rev-list', '--count', `${rb}..HEAD`])
      if (n !== null) ahead = Number(n) || 0
    }
  }
  return {
    initialized: true,
    // 项目级同步开关（三层开关第 2 层）：PROVENANCE 存在且 enabled !== false
    projectEnabled: isProjectSyncEnabled(dir),
    // 轨级开关（第 3 层）：项目记忆轨（KEY/日志/归档/项目待办）；全局轨
    // 各有独立开关（仅共享记忆仓库可用，见下方 global）
    tracks: { project: provenanceTrackProject(dir) },
    // 记忆远端类型（统一模式，2026-08-11）：sync 仓库 origin 与主仓库 remote
    // 归一化相等 = 主代码仓库（默认）；否则 = 共享记忆仓库（用户指定）；
    // origin 未挂载 = none（Kimi P2-9：不得误报为共享仓库）
    // UI 状态卡片据此显示"记忆放哪了"。
    remoteKind: syncOrigin === null
      ? 'none'
      : ((identity.remoteUrl !== undefined && normalizeRemoteUrl(syncOrigin) === normalizeRemoteUrl(identity.remoteUrl)) ? 'main-repo' : 'shared-repo'),
    // 当前记忆远端 URL（只读展示：前端地址输入框回显用——2026-08-11
    // 用户反馈"输入后刷新就不见了"：初始值应来自当前 origin，而非空串）
    originUrl: syncOrigin ?? '',
    // 全局轨状态（2026-08-11 二期并入一期，用户拍板）：全局记忆仓库 =
    // 记忆根目录的 .git；仅在共享记忆仓库 setup 后初始化。设备级信息，
    // UI 显示"全局记忆同步"区（四轨开关 + 同步按钮）。
    global: globalSyncStatus(config.memoryDir),
    uncommitted,
    ahead,
    behind,
    conflicts: countConflicts(dir),
    identity,
    dir,
    remoteBranch,
  }
}

/**
 * 全局轨状态（设备级）：全局记忆仓库（记忆根目录 .git）是否初始化、
 * 绑定的共享记忆仓库 URL、各轨开关与未提交数。
 * @param {string} memoryDir - 记忆根目录。
 * @returns {{initialized: boolean, url: string, tracks: object,
 *   uncommitted: number, remoteKind: string}}
 */
function globalSyncStatus(memoryDir) {
  const meta = readProvenance(memoryDir)
  if (meta === null || !existsSync(join(memoryDir, '.git'))) {
    return { initialized: false, url: '', tracks: {}, uncommitted: 0, conflicts: {}, remoteKind: 'none' }
  }
  // 全局仓库 origin（绑定 URL）
  const origin = runGitSync(memoryDir, ['remote', 'get-url', 'origin'])
  // uncommitted：启用轨中"工作树 ≠ 本地轨树"的轨数——**不能用 git status**
  // （多轨共享同一 .git，共享 index 只反映 HEAD/main 树，必然假脏）；
  // 用临时 GIT_INDEX_FILE 逐轨构建工作树 tree 与本地轨树比较（同步毫秒级）
  const tracks = {}
  let uncommitted = 0
  // aheadTracks：启用轨中"本地轨分支领先远端分支"的轨数（已提交未推送）。
  // 与 uncommitted 一起构成「未推送」完整口径（本地有、远端没有的内容）。
  let aheadTracks = 0
  for (const fileset of GLOBAL_FILESET_KEYS) {
    const track = GLOBAL_TRACK_NAMES[fileset]
    tracks[track] = meta.tracks?.[track] === true
    if (tracks[track] && globalFilesetDirtySync(memoryDir, fileset)) uncommitted += 1
    if (tracks[track]) {
      // 本地轨分支存在（至少提交过一次）才算；远端分支可能尚不存在
      // （首次推送前）——不存在 = 本地提交全部未推送
      const lb = `refs/heads/${fileset}`
      if (runGitSync(memoryDir, ['rev-parse', '--verify', lb]) !== null) {
        const gb = `refs/remotes/origin/${globalBranchFor(fileset)}`
        if (runGitSync(memoryDir, ['rev-parse', '--verify', gb]) === null) {
          aheadTracks += 1
        } else {
          const n = runGitSync(memoryDir, ['rev-list', '--count', `${gb}..${lb}`])
          if (n !== null && Number(n) > 0) aheadTracks += 1
        }
      }
    }
  }
  // 各轨冲突数（按 fileset 独立侧车）
  const conflicts = {}
  for (const fileset of GLOBAL_FILESET_KEYS) {
    conflicts[GLOBAL_TRACK_NAMES[fileset]] = countConflicts(memoryDir, fileset)
  }
  return {
    initialized: true,
    // 共享记忆库启用开关（设备级，2026-08-11 用户拍板）：PROVENANCE.enabled
    // ——false = 停用（项目 B 与全局记忆均不可用，数据保留，可随时重新启用）
    enabled: meta.enabled !== false,
    url: meta.url ?? origin ?? '',
    tracks,
    uncommitted,
    ahead: aheadTracks,
    conflicts,
    remoteKind: origin === null ? 'none' : 'shared-repo',
  }
}

/**
 * 同步检查某全局轨工作树是否落后于本地轨树（Codex 二轮 P1-1 配套）：
 * 临时 GIT_INDEX_FILE 从空树起步、只加本轨文件，write-tree 与
 * refs/heads/<fileset>^{tree} 比较。本地轨树不存在（未提交过）= dirty。
 */
function globalFilesetDirtySync(memoryDir, fileset) {
  const indexFile = join(memoryDir, '.git', `index.chk.${process.pid}.${fileset.replace(/\W/g, '')}`)
  const env = { ...process.env, GIT_INDEX_FILE: indexFile }
  const run = (args) => {
    const r = spawnSync('git', args, { cwd: memoryDir, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'], env })
    return r.status === 0 ? String(r.stdout ?? '').trim() : null
  }
  try {
    if (run(['read-tree', '--empty']) === null) return true
    const { memory, todo } = resolveFilesetFiles(memoryDir, fileset)
    // 元数据集合与 stagePaths 的 STAGE_META 保持一致（2026-08-11 修复：
    // .gitattributes 加入后，漏列会让"含 .gitattributes 的提交树"与工作树
    // 比较判假 dirty——无变化也被算作未提交）
    const meta = ['PROVENANCE', '.gitignore', 'CONFLICTS.md', '.gitattributes'].filter((p) => existsSync(join(memoryDir, p)))
    const files = [...memory, ...todo, ...meta]
    if (files.length > 0 && run(['add', '-f', '--ignore-errors', '--', ...files]) === null) return true
    const tree = run(['write-tree'])
    const lbTree = run(['rev-parse', '--verify', `refs/heads/${fileset}^{tree}`])
    return tree === null || tree !== lbTree
  } finally {
    try { rmSync(indexFile, { force: true }) } catch { /* 清理失败不阻断 */ }
  }
}

/** 项目记忆轨开关（PROVENANCE.tracks.project，缺省 true）。 */
function provenanceTrackProject(dir) {
  const meta = readProvenance(dir)
  return meta?.tracks?.project !== false
}

/** 本地 git 查询辅助（同步，毫秒级；快照渲染与命令共用）。 */
function runGitSync(dir, args) {
  try {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] })
    if (r.error || r.status !== 0) return null
    return String(r.stdout ?? '').trim()
  } catch {
    return null
  }
}

/**
 * 装配记忆同步模块。
 * @param {object} ctx - 插件上下文（commands / systemPrompt 服务）。
 * @param {object} deps - { config, getRuntime, applyRuntimePatch, memoryDir }。
 * @returns {{ dispose: () => void, syncStatus: (cwd) => object | null }}
 */
export function installMemorySync(ctx, deps) {
  const { config, getRuntime, applyRuntimePatch } = deps
  const disposers = []

  /* ── /memory_sync 命令组 ── */
  // （快照状态行不在此注册：context 段拿不到 agent，改由 index.js 的
  // renderSnapshot 集成——renderSyncLine 导出，仅 syncEnabled 时计算。）
  let commandDispose = null
  const registerCommand = () => {
    if (commandDispose !== null) return
    commandDispose = ctx.get('commands')?.register?.({
      name: 'memory_sync',
      description: '项目记忆跨设备同步（Git）：setup [url] 初始化（无参=记忆远端用主代码仓库，零配置；url=共享记忆仓库——一个仓库装所有项目的记忆，也是全局记忆的唯一去处；每项目自动使用专属分支，老配置自动兼容），sync 拉取并合并，sync --push 同步并推送（推送需你显式触发），off 停用同步，status 查看状态，global status|on|off <memory|user|daily|todo>|sync [--push] 全局记忆同步（全局记忆/用户档案/每日日志/待办四轨，仅共享记忆仓库可用），conflict list 列出待处理冲突，conflict resolve <编号> ours|theirs|both 解决冲突，migrate 查看可迁移的旧记忆目录',
      input: { syntax: 'setup [url] | sync [--push] | off | status | global status|on|off <memory|user|daily|todo>|sync [--push] | conflict list | conflict resolve <n> ours|theirs|both | migrate', hint: '缺省=status' },
      async handler(invocation) {
        const tokens = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
        const op = (tokens[0] ?? 'status').toLowerCase()
        const cwd = invocation.agent?.session?.header?.cwd
        // global 子命令是设备级能力（全局记忆仓库在记忆根目录），不依赖
        // 项目工作目录（Codex 二轮 P1-8：命令分派先于项目 cwd 检查）
        if (op === 'global') {
          try {
            return await handleCommand('global', tokens.slice(1), cwd, { config, getRuntime, applyRuntimePatch })
          } catch (error) {
            return { kind: 'error', text: `memory_sync global 执行失败：${error?.message ?? String(error)}` }
          }
        }
        if (!cwd) return { kind: 'error', text: '当前会话没有工作目录，无法定位项目记忆' }
        try {
          return await handleCommand(op, tokens.slice(1), cwd, { config, getRuntime, applyRuntimePatch })
        } catch (error) {
          return { kind: 'error', text: `memory_sync ${op} 执行失败：${error?.message ?? String(error)}` }
        }
      },
    })
    if (commandDispose) disposers.push(commandDispose)
  }
  registerCommand()

  const syncStatus = (cwd) => {
    const enabled = getRuntime()?.syncEnabled === true
    const info = enabled ? syncStatusSync(config, cwd) : null
    return { enabled, ...(info ?? { initialized: false }) }
  }

  return {
    dispose() {
      for (const d of disposers) { try { d() } catch { /* 幂等 */ } }
      disposers.length = 0
      commandDispose = null
    },
    /** API 用：当前会话 cwd 的同步状态（含 enabled/initialized）。 */
    syncStatus,
    /** UI 操作函数（记忆同步 Tab 用；全部基于 handleCommand 与 worker）。 */
    ops: {
      /** 初始化（模式 A 无 url / 模式 B 指定 url）。 */
      async setup(cwd, url) {
        const rt = { config, getRuntime, applyRuntimePatch }
        return handleCommand('setup', url ? [url] : [], cwd, rt)
      },
      /** 同步（push=true 即用户显式同意推送，需求 #12）。 */
      async sync(cwd, push) {
        const rt = { config, getRuntime, applyRuntimePatch }
        return handleCommand('sync', push ? ['--push'] : [], cwd, rt)
      },
      /**
       * 项目级同步开关（三层开关第 2 层，2026-08-11 用户拍板）：
       *   enabled=true → 未初始化则走 setup 引导；已初始化 → PROVENANCE.enabled=true
       *   enabled=false → 该项目停用同步（记忆全保留，PROVENANCE.enabled=false）
       * 注意：模块开关（syncEnabled，设置面板）只控制 Tab/命令可见性，不控制
       * 具体项目是否参与同步。
       */
      async setProjectEnabled(cwd, enabled) {
        if (enabled) {
          const info = projectSyncInfo(config, cwd)
          if (info.provenance === null) {
            // 未初始化 → 走 setup（模式 A；私有仓库走 setup url 分支）
            return handleCommand('setup', [], cwd, { config, getRuntime, applyRuntimePatch })
          }
          if (!info.provenance.enabled || info.provenance.tracks?.project !== true) {
            // 重新启用 = 三态 A/B（旧项目开关"开"）→ 同时复位轨位
            // （projectOptIn：三态取代旧轨开关，避免遗留 false 卡死同步）
            projectOptIn(info.provenance)
            writeFileSync(join(info.dir, 'PROVENANCE'), `${JSON.stringify(info.provenance)}\n`)
          }
          return { kind: 'success', text: '本项目已启用同步' }
        }
        // 关闭：写 PROVENANCE.enabled=false（记忆文件/仓库全保留）
        const info = projectSyncInfo(config, cwd)
        if (info.provenance !== null) {
          info.provenance.enabled = false
          writeFileSync(join(info.dir, 'PROVENANCE'), `${JSON.stringify(info.provenance)}\n`)
        }
        return { kind: 'success', text: '本项目已停用同步（记忆完整保留，可随时重新启用）' }
      },
      /** 轨级开关（三层开关第 3 层）：一期唯一轨=项目记忆。 */
      setTrack(cwd, on) {
        const info = projectSyncInfo(config, cwd)
        if (info.provenance === null) return { kind: 'error', text: '项目尚未初始化——先启用本项目同步' }
        const meta = { ...info.provenance, tracks: { ...(info.provenance.tracks ?? {}), project: on === true } }
        writeFileSync(join(info.dir, 'PROVENANCE'), `${JSON.stringify(meta)}\n`)
        return { kind: 'success', text: on ? '项目记忆轨已纳入同步' : '项目记忆轨已退出同步（该轨保留本地，不再对账）' }
      },
      /** 停用同步（项目级，非全局开关；记忆全保留）。 */
      async off(cwd) {
        return this.setProjectEnabled(cwd, false)
      },
      /** 解决一条冲突。 */
      async resolve(cwd, index, choice) {
        const { dir, remoteBranch } = projectSyncInfo(config, cwd)
        const result = await resolveConflict({ dir, index, choice })
        return result.ok ? { kind: 'success', text: result.message, remaining: result.remaining } : { kind: 'error', text: result.message }
      },
      /** 冲突列表（解析 CONFLICTS.md）。 */
      conflicts(cwd) {
        const { dir } = projectSyncInfo(config, cwd)
        const path = join(dir, CONFLICTS_FILE)
        if (!existsSync(path)) return []
        return parseConflicts(readFileSync(path, 'utf8'))
      },
      /** 迁移清单（旧记忆目录可见性）。 */
      migrate(cwd) {
        const { dir, identity } = projectSyncInfo(config, cwd)
        const legacy = locateLegacyDir(config.memoryDir, cwd, identity.id)
        return legacy === null ? null : legacy
      },
      /** 全局轨状态（设备级；UI「全局记忆同步」区）。 */
      globalStatus() {
        return globalSyncStatus(config.memoryDir)
      },
      /** 全局轨开关（memory/user/daily/todo）。 */
      setGlobalTrack(track, on) {
        const TRACKS = ['memory', 'user', 'daily', 'todo']
        if (!TRACKS.includes(track)) return { kind: 'error', text: `未知全局轨 "${track}"（应为 memory/user/daily/todo）` }
        const outcome = updateGlobalTracks(config.memoryDir, (tracks) => ({ ...tracks, [track]: on === true }))
        if (!outcome.ok) return { kind: 'error', text: outcome.message }
        return { kind: 'success', text: `全局${trackLabel(track)}同步已${on ? '开启' : '关闭'}` }
      },
      /** 全局轨同步（逐个启用轨对账；push=true 即用户显式同意推送）。 */
      /** 全局轨同步（逐个启用轨对账；push=true 即用户显式同意推送）。
       *  失败聚合（Codex 二轮 P1-5）：任一轨失败必须如实返回失败/部分成功，
       *  绝不整体报 success。 */
      async globalSync(push) {
        const gMeta = readProvenance(config.memoryDir)
        if (gMeta === null) return { kind: 'error', text: '全局记忆仓库尚未初始化——先在下方填共享记忆仓库地址初始化' }
        const results = []
        let failed = 0
        for (const fileset of GLOBAL_FILESET_KEYS) {
          const track = GLOBAL_TRACK_NAMES[fileset]
          if (gMeta.tracks?.[track] !== true) continue
          const run = await spawnWorker(['sync', config.memoryDir, globalBranchFor(fileset), fileset, fileset, ...(push ? ['--push'] : [])])
          const out = parseWorkerOutput(run)
          if (!out.ok) failed += 1
          results.push(`${trackLabel(track)}：${out.ok ? (out.message ?? '完成') : out.message}`)
        }
        if (results.length === 0) return { kind: 'error', text: '未开启任何全局轨——先开启要同步的轨（全局记忆/用户档案/每日日志/待办）' }
        const head = failed > 0
          ? `${push ? '全局轨同步并推送' : '全局轨同步'}：${failed} 个轨失败（其余成功）`
          : `${push ? '全局轨同步并推送完成' : '全局轨同步完成'}`
        return { kind: failed > 0 ? 'error' : 'success', text: `${head}：\n${results.join('\n')}` }
      },
      /**
       * 启用/停用共享记忆库（设备级，2026-08-11 用户拍板）：
       *   - enabled=true：保存地址并启用——只初始化/绑定全局记忆仓库
       *     （记忆根目录 .git + PROVENANCE.url），**不碰当前项目**（项目 B
       *     模式引用这个地址，切 B 时由 setup 处理）；幂等；
       *   - enabled=false：停用——写 PROVENANCE.enabled=false（项目 B 与
       *     全局记忆均不可用），**数据与地址完整保留**，可随时重新启用。
       * @param {string} url - 共享记忆仓库地址（仅 enabled=true 时使用）。
       * @param {boolean} enabled - true=启用（保存地址）；false=停用。
       * @returns {{kind: 'success'|'error', text: string}}
       */
      async setGlobalRemote(url, enabled) {
        if (enabled === false) {
          // 停用：只写 enabled=false，不删任何数据（PROVENANCE 原子写）
          const outcome = updateGlobalEnabled(config.memoryDir, false)
          if (!outcome.ok) return { kind: 'error', text: outcome.message }
          return { kind: 'success', text: '共享记忆库已停用（数据与地址保留，可随时重新启用）' }
        }
        const trimmed = String(url ?? '').trim()
        if (trimmed === '') return { kind: 'error', text: '共享记忆仓库地址不能为空' }
        // 网络/初始化走 sync-worker 子进程（主进程零阻塞）
        const gInit = await spawnWorker(['global-init', config.memoryDir, trimmed])
        const gOut = parseWorkerOutput(gInit)
        if (!gOut.ok) return { kind: 'error', text: gOut.message }
        // 启用位：global-init 只建仓/绑地址，可能曾停用（enabled=false）——
        // 必须复位，否则保存了地址全局/项目 B 仍不可用
        updateGlobalEnabled(config.memoryDir, true)
        // 打开模块开关（让 Tab 可用；项目级开关不动——设备级配置不影响项目）
        applyRuntimePatch({ syncEnabled: true })
        return { kind: 'success', text: gOut.message ?? '共享记忆仓库已配置' }
      },
    },
  }
}

/**
 * 渲染快照状态行（并入主快照；空串 = 不显示）。
 * 由 index.js 的 renderSnapshot deps 调用——那里能拿到 agent.cwd。
 */
export function renderSyncLine(config, cwd) {
  if (!cwd) return ''
  const info = syncStatusSync(config, cwd)
  if (info === null || info.initialized !== true) return ''
  const bits = []
  // 「未推送」= 工作树未提交变更 + 已提交未推送的提交（2026-08-11 用户
  // 反馈：只说"未提交"会误以为拉取合并已把内容推上去）
  const pendingPush = (info.uncommitted ?? 0) + (info.ahead ?? 0)
  if (pendingPush > 0) bits.push(`未推送 ${pendingPush} 条`)
  if (info.behind > 0) bits.push(`落后远端 ${info.behind} 个提交（点「同步」拉取）`)
  if (info.conflicts > 0) bits.push(`冲突 ${info.conflicts} 条待处理（冲突区可解决）`)
  const line = bits.length > 0 ? bits.join(' · ') : '已同步'
  return `## 记忆同步\n- 状态：${line}（记忆同步 Tab 查看详情）`
}

/* ── 命令子命令实现 ── */

/**
 * 初始化全局记忆仓库（共享记忆仓库 setup 成功后调用；幂等）。
 * 全局轨仅共享记忆仓库可用（用户拍板）：全局仓库 = 记忆根目录的 .git。
 * 失败不阻断项目 setup——附提示，可稍后重试。
 * @param {string} memoryDir - 记忆根目录。
 * @param {string | undefined} url - 显式共享仓库 URL（无参 setup 不建全局仓库）。
 * @returns {Promise<string>} 追加到成功消息的提示串。
 */
async function initGlobalRepo(memoryDir, url) {
  if (!url) return ''
  const gInit = await spawnWorker(['global-init', memoryDir, url])
  const gOut = parseWorkerOutput(gInit)
  return gOut.ok
    ? '；全局记忆仓库已就绪（可在记忆同步 Tab 开启 全局记忆/用户档案/每日日志/待办 同步）'
    : `；⚠️ 全局记忆仓库初始化失败：${gOut.message}（不影响本项目同步，可稍后重试）`
}

/** 全局轨开关状态文本（status 用）。 */
function renderGlobalTracks(tracks) {
  const names = [['memory', '全局记忆'], ['user', '用户档案'], ['daily', '每日日志'], ['todo', '待办（生活/工作/每日）']]
  return names.map(([k, label]) => `${label}：${tracks[k] === true ? '开' : '关'}`).join('；')
}

/** 全局轨显示名（命令/UI 文案）。 */
function trackLabel(track) {
  return { memory: '全局记忆', user: '用户档案', daily: '每日日志', todo: '待办（生活/工作/每日）' }[track] ?? track
}

/**
 * 原子更新全局轨开关（Codex 二轮 P2-1）：PROVENANCE 是共享配置（多会话
 * 并发开不同轨会互相覆盖）——锁内读改写 + tmp+rename 原子落盘。
 * @param {string} memoryDir - 记忆根目录。
 * @param {(tracks: object) => object} mutate - 返回新 tracks 的纯函数。
 * @returns {{ok: boolean, message: string}}
 */
function updateGlobalTracks(memoryDir, mutate) {
  const provPath = join(memoryDir, 'PROVENANCE')
  let result = { ok: false, message: '' }
  withLock(memoryDir, () => {
    const gMeta = readProvenance(memoryDir)
    if (gMeta === null) {
      result = { ok: false, message: '全局记忆仓库尚未初始化——先在下方填共享记忆仓库地址初始化' }
      return
    }
    gMeta.tracks = mutate({ ...(gMeta.tracks ?? {}) })
    const tmp = `${provPath}.tmp.${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(gMeta)}\n`)
    renameSync(tmp, provPath)
    result = { ok: true, message: 'ok' }
  })
  return result
}

/**
 * 原子更新共享记忆库启用位（PROVENANCE.enabled，2026-08-11 用户拍板）：
 * 与 updateGlobalTracks 同款锁内读改写 + tmp+rename。停用不删任何数据，
 * 重新启用复位 enabled=true。未初始化（无 PROVENANCE）视为不可操作。
 * @param {string} memoryDir - 记忆根目录。
 * @param {boolean} enabled - true=启用 / false=停用。
 * @returns {{ok: boolean, message: string}}
 */
function updateGlobalEnabled(memoryDir, enabled) {
  const provPath = join(memoryDir, 'PROVENANCE')
  let result = { ok: false, message: '' }
  withLock(memoryDir, () => {
    const gMeta = readProvenance(memoryDir)
    if (gMeta === null) {
      result = { ok: false, message: '共享记忆库尚未初始化——先保存仓库地址' }
      return
    }
    gMeta.enabled = enabled === true
    const tmp = `${provPath}.tmp.${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(gMeta)}\n`)
    renameSync(tmp, provPath)
    result = { ok: true, message: 'ok' }
  })
  return result
}

/**
 * 项目启用复位（2026-08-11 用户拍板三态切换的完整语义）：
 *   A/B 模式 = 明确启用意图 = 项目级 enabled=true **且** 项目记忆轨纳入同步
 *   （tracks.project=true）。旧 UI 曾有独立的「项目记忆轨」勾选开关，三态
 *   切换取代后该位是遗留字段：必须随 setup/setProjectEnabled 复位，否则
 *   tracks.project=false 的旧配置会卡死拉取/推送（报「重新勾选同步范围」
 *   但新 UI 没有该入口，死锁）。
 * @param {object} meta - PROVENANCE 解析对象（就地修改）。
 */
function projectOptIn(meta) {
  meta.enabled = true
  meta.tracks = { ...(meta.tracks ?? {}), project: true }
}

/** 命令子命令实现（导出供测试；命令组 handler 调用）。 */
export async function handleCommand(op, rest, cwd, { config, getRuntime, applyRuntimePatch }) {
  const { dir, remoteBranch, identity } = projectSyncInfo(config, cwd)

  switch (op) {
    case 'setup': {
      // 统一单一模式（2026-08-11 用户拍板）：记忆同步 = 一个记忆远端 +
      // 每项目一条专属分支 dsh-shared/<projectId>。远端来源一个配置：
      //   无参   = 默认主代码仓库 origin（零配置；= 原模式 A）
      //   有 url = 指定共享记忆仓库（= 原模式 B，全局轨唯一的家）
      // 老配置（一期 dsh-shared/memory / main 分支）由分支决策自动识别，
      // 继续沿用，零迁移。
      const url = typeof rest[0] === 'string' && rest[0].trim() !== '' ? rest[0].trim() : undefined
      // 目标远端（Grok 终审 P1-2 修复——切换语义落地）：
      //   显式 url → 该共享记忆仓库；
      //   无参 → 当前 origin 已是主代码仓库则保持（幂等重复 setup）；
      //          否则切回主代码仓库（文档承诺的"清空地址 = 回主仓库"）。
      //   origin 无法归一化（本地路径等）→ 无法与主仓库对比 → 保持现状幂等
      const existingOrigin = runGitSync(dir, ['remote', 'get-url', 'origin'])
      const originNormalized = existingOrigin ? normalizeRemoteUrl(existingOrigin) : undefined
      const mainNormalized = identity.remoteUrl ? normalizeRemoteUrl(identity.remoteUrl) : undefined
      let probeUrl
      if (url) {
        probeUrl = url
      } else if (existingOrigin && (originNormalized === undefined || originNormalized === mainNormalized)) {
        probeUrl = existingOrigin // origin 无法归一化（本地路径）/ 已是主仓库 → 幂等保持
      } else {
        probeUrl = identity.remoteUrl ?? existingOrigin // 切回主仓库（无主仓库时保持现有 origin）
      }
      if (!probeUrl) {
        return { kind: 'error', text: '当前项目没有可共享的 git 远端——请先为主仓库配置 remote（或在下方填共享记忆仓库地址）' }
      }
      // 切换检测：目标远端与现有 origin 不同 → set-url + 更新 PROVENANCE，
      // 本地记忆完整保留，由用户显式 sync 完成首次对账（绝不假成功）
      const switching = existingOrigin !== null
        && normalizeRemoteUrl(existingOrigin) !== normalizeRemoteUrl(probeUrl)
      if (switching) {
        const setUrl = runGitSync(dir, ['remote', 'set-url', 'origin', sanitizeRemoteUrl(probeUrl)])
        if (setUrl === null) {
          return { kind: 'error', text: '切换记忆远端失败：remote set-url 未成功（本地记忆未受影响）' }
        }
      }
      // 分支决策（worker 子进程，网络命令不进主进程）：候选
      // dsh-shared/<id> → dsh-shared/memory（老模式 A）→ main（老模式 B），
      // PROVENANCE.projectId 精确匹配才认（防串项目）
      const decide = await spawnWorker(['decide', dir, probeUrl, identity.id])
      const out = parseWorkerOutput(decide)
      if (!out.ok) return { kind: 'error', text: out.message }
      const branch = typeof out.branch === 'string' && out.branch !== '' ? out.branch : sharedBranchFor(identity.id)
      if (switching) {
        // 已初始化仓库切换记忆远端：只更新 PROVENANCE.remoteBranch（本地
        // 记忆一字不动），引导用户 sync 完成首次对账——不自动 fetch/合并
        const meta = readProvenance(dir)
        if (meta !== null) {
          const branchChanged = meta.remoteBranch !== branch
          const needOptIn = meta.enabled !== true || meta.tracks?.project !== true
          if (branchChanged) meta.remoteBranch = branch
          // 切换远端同样是一次"明确启用"（A/B 模式）→ 复位轨位（见
          // projectOptIn 注释：三态取代旧轨开关，避免遗留 false 卡死同步）
          if (branchChanged || needOptIn) {
            projectOptIn(meta)
            writeFileSync(join(dir, 'PROVENANCE'), `${JSON.stringify(meta)}\n`)
          }
          applyRuntimePatch({ syncEnabled: true })
          const gNote = await initGlobalRepo(config.memoryDir, url)
          return { kind: 'success', text: `记忆远端已切换（${probeUrl}，分支 ${branch}）。本地记忆完整保留——点「同步」完成首次对账（推送需点「同步并推送」）${gNote}` }
        }
        // PROVENANCE 缺失（异常）→ 落到正常初始化流程兜底
      }
      // expectedProjectId：接入前校验远端 PROVENANCE 归属本项目（防接错
      // 仓库/分支——共享仓库多项目并存下是硬防线）
      const connect = await deviceBConnect({ dir, remoteUrl: probeUrl, remoteBranch: branch, expectedProjectId: identity.id })
      if (connect.mode === 'error') return { kind: 'error', text: connect.message }
      if (connect.mode === 'adopt') {
        // 已接入：仍需本地初始化配套文件（PROVENANCE 等由远端带来）。
        // 用户主动执行 setup = 明确启用意图：自动打开模块开关（Tab 可见）
        // **并复位项目级 enabled=true + 轨位 project=true（Kimi P1-5：off
        // 后按官方提示 setup 重新启用，enabled=false 必须复位，否则 sync
        // 仍被拒；tracks 同理——三态切换取代旧轨开关，见 projectOptIn）**
        applyRuntimePatch({ syncEnabled: true })
        const meta = readProvenance(dir)
        if (meta !== null && (meta.enabled === false || meta.tracks?.project !== true)) {
          projectOptIn(meta)
          writeFileSync(join(dir, 'PROVENANCE'), `${JSON.stringify(meta)}\n`)
        }
        // adopt 路径不经过 ensureMemoryRepo 的 legacy 迁移段（Kimi P1-7）：
        // 检测到旧记忆目录时显式警告（数据未丢但可能"失联"）
        const legacyWarn = (() => {
          const legacy = locateLegacyDir(config.memoryDir, cwd, identity.id)
          return legacy === null ? '' : `；注意：发现旧记忆目录 ${legacy}（尚未并入，可在记忆同步 Tab 查看）`
        })()
        const gNote = await initGlobalRepo(config.memoryDir, url)
        return { kind: 'success', text: `已接入远端记忆（${branch}）：${connect.message}。点「同步」拉取合并${legacyWarn}${gNote}` }
      }
      const boot = await ensureMemoryRepo({ dir, memoryDir: config.memoryDir, cwd, projectId: identity.id, displayName: identity.displayName, remoteUrl: probeUrl, remoteBranch: branch })
      if (!boot.ok) return { kind: 'error', text: boot.message }
      // setup = 明确启用意图 → 自动打开模块开关（Tab 可见），项目级 enabled
      // 由 bootstrap 写入（默认 true）；老 PROVENANCE（off 后远端分支被删
      // 走 bootstrap）同样复位 enabled + 轨位（Kimi P1-5 + projectOptIn）
      applyRuntimePatch({ syncEnabled: true })
      const meta = readProvenance(dir)
      if (meta !== null && (meta.enabled === false || meta.tracks?.project !== true)) {
        projectOptIn(meta)
        writeFileSync(join(dir, 'PROVENANCE'), `${JSON.stringify(meta)}\n`)
      }
      const pushHint = boot.remoteBranchExists === false
        ? '远端尚无该分支——点「同步并推送」完成首次推送（推送需你同意）'
        : '点「同步」开始对账'
      const gNote = await initGlobalRepo(config.memoryDir, url)
      return { kind: 'success', text: `记忆同步初始化完成（${branch}）：${boot.message}。${pushHint}${gNote}` }
    }

    case 'sync': {
      if (!existsSync(join(dir, '.git'))) {
        return { kind: 'error', text: '当前项目尚未初始化同步——请先点「开始同步」' }
      }
      const meta = readProvenance(dir)
      if (meta !== null && meta.enabled === false) {
        return { kind: 'error', text: '本项目已停用同步（记忆保留本地）——到记忆同步 Tab 重新启用' }
      }
      if (meta !== null && meta.tracks?.project === false) {
        // 三态切换已取代旧「项目记忆轨」勾选开关（2026-08-11 用户拍板：
        // A/B 模式 = 轨纳入同步，不启用 = 轨退出）。tracks.project=false 是
        // 旧 UI 的遗留位——本项目已启用（enabled=true）说明用户已表达启用
        // 意图，此处**自愈复位**并继续，不再拒绝（否则报「重新勾选同步
        // 范围」但新 UI 无该入口，拉取/推送永久死锁）
        meta.tracks.project = true
        writeFileSync(join(dir, 'PROVENANCE'), `${JSON.stringify(meta)}\n`)
      }
      const push = rest.includes('--push')
      if (push) {
        // push 需用户同意（需求 #12）：用户显式输入 --push 即视为同意
      }
      const run = await spawnWorker(['sync', dir, remoteBranch, ...(push ? ['--push'] : [])])
      const out = parseWorkerOutput(run)
      if (!out.ok) return { kind: 'error', text: out.message }
      // worker 文案已含"推送"时不再重复追加（Grok P2-4）
      const text = [out.message ?? '同步完成']
      if (push && !/推送/.test(out.message ?? '')) text.push('（已推送）')
      return { kind: 'success', text: text.join(' ') }
    }

    case 'global': {
      // 全局轨（2026-08-11 二期并入一期，用户拍板：开关做好功能必须实现）：
      //   全局记忆 / 用户档案 / 每日日志 / 待办（生活·工作·每日）四个独立轨，
      //   仅共享记忆仓库可用（全局仓库 = 记忆根目录的 .git，setup <url> 时初始化）。
      //   用法：global status | global on <memory|user|daily|todo> |
      //         global off <轨> | global sync [--push]
      const sub = (rest[0] ?? 'status').toLowerCase()
      const trackName = (rest[1] ?? '').toLowerCase()
      const TRACKS = new Set(['memory', 'user', 'daily', 'todo'])
      if (sub === 'on' || sub === 'off') {
        if (!TRACKS.has(trackName)) {
          return { kind: 'error', text: '用法：global on|off <memory|user|daily|todo>' }
        }
        // 原子更新（Codex P2-1：锁内读改写 + tmp+rename）
        const outcome = updateGlobalTracks(config.memoryDir, (tracks) => ({ ...tracks, [trackName]: sub === 'on' }))
        if (!outcome.ok) return { kind: 'error', text: outcome.message }
        const tracks = readProvenance(config.memoryDir)?.tracks ?? {}
        return { kind: 'success', text: `全局${trackLabel(trackName)}同步已${sub === 'on' ? '开启' : '关闭'}（${renderGlobalTracks(tracks)}）` }
      }
      if (sub === 'sync') {
        const gMeta = readProvenance(config.memoryDir)
        if (gMeta === null) return { kind: 'error', text: '全局记忆仓库尚未初始化——先在下方填共享记忆仓库地址初始化' }
        const push = rest.includes('--push')
        // 逐个启用轨对账（每轨独立分支，互不干扰）；失败聚合（Codex P1-5）：
        // 任一轨失败如实报"部分失败"，绝不整体报 success
        const results = []
        let failed = 0
        for (const fileset of GLOBAL_FILESET_KEYS) {
          const track = GLOBAL_TRACK_NAMES[fileset]
          if (gMeta.tracks?.[track] !== true) continue
          const run = await spawnWorker(['sync', config.memoryDir, globalBranchFor(fileset), fileset, fileset, ...(push ? ['--push'] : [])])
          const out = parseWorkerOutput(run)
          if (!out.ok) failed += 1
          results.push(`${trackLabel(track)}：${out.ok ? (out.message ?? '完成') : out.message}`)
        }
        if (results.length === 0) return { kind: 'error', text: '未开启任何全局轨——先打开要同步的轨开关' }
        const head = failed > 0
          ? `${push ? '全局轨同步并推送' : '全局轨同步'}：${failed} 个轨失败（其余成功）`
          : `${push ? '全局轨同步并推送完成' : '全局轨同步完成'}`
        return { kind: failed > 0 ? 'error' : 'success', text: `${head}：\n${results.join('\n')}` }
      }
      if (sub === 'status') {
        const g = globalSyncStatus(config.memoryDir)
        if (!g.initialized) {
          return { kind: 'success', text: '全局记忆同步未初始化——全局记忆（用户档案/每日日志/待办）仅共享记忆仓库可用：先填共享记忆仓库地址初始化' }
        }
        const lines = [
          `全局记忆远端：${g.url}`,
          `全局轨开关：${renderGlobalTracks(g.tracks)}`,
          // 「未推送」= 工作树变更轨 + 已提交未推送的轨（2026-08-11 用户
          // 反馈：与「推送」按钮语义对齐）
          `未推送：${(g.uncommitted ?? 0) + (g.ahead ?? 0)} 个轨（点「全局推送」才上远端）`,
          `提示：global sync 同步全部已开启的轨；global sync --push 同步并推送（推送需你显式触发）`,
        ]
        return { kind: 'success', text: lines.join('\n') }
      }
      return { kind: 'error', text: '用法：global status | global on|off <memory|user|daily|todo> | global sync [--push]' }
    }

    case 'off': {
      // 停用同步：**项目级**（三层开关第 2 层，2026-08-11 用户拍板）——
      // 只停用当前项目（PROVENANCE.enabled=false），不影响全局模块开关与其他
      // 项目；记忆文件/仓库全保留，重新启用随时可继续。
      // **轨位联动（三态取代旧轨开关）**：不启用 = 原来的"关" = 项目记忆轨
      // 也退出（tracks.project=false），与 setup 的 projectOptIn 复位互逆。
      const meta = readProvenance(dir)
      if (meta === null) return { kind: 'error', text: '当前项目尚未初始化同步（无需停用）' }
      meta.enabled = false
      meta.tracks = { ...(meta.tracks ?? {}), project: false }
      writeFileSync(join(dir, 'PROVENANCE'), `${JSON.stringify(meta)}\n`)
      return { kind: 'success', text: '本项目已停用同步：记忆完整保留在本机，不再对账；重新启用随时可继续（记忆同步 Tab）' }
    }

    case 'status': {
      const enabled = getRuntime()?.syncEnabled === true
      if (!enabled) return { kind: 'success', text: '记忆同步模块未启用——在「Memory Evolve 设置 → 配置」打开' }
      const info = syncStatusSync(config, cwd)
      if (info === null) {
        return { kind: 'success', text: `模块已启用，但当前项目未初始化——点下方「开始同步」` }
      }
      const remoteName = resolveMainRemote(cwd)?.name ?? '?'
      // 记忆远端类型（统一模式）：sync 仓库 origin 与主仓库 remote 归一化
      // 相等 = 主代码仓库（默认）；否则 = 共享记忆仓库（用户指定）
      const syncOrigin = runGitSync(dir, ['remote', 'get-url', 'origin'])
      const remoteKind = (typeof syncOrigin === 'string' && syncOrigin !== '' && info.identity.remoteUrl
        && normalizeRemoteUrl(syncOrigin) === normalizeRemoteUrl(info.identity.remoteUrl))
        ? '主代码仓库'
        : '共享记忆仓库'
      const lines = [
        `项目身份：${info.identity.displayName}（${info.identity.kind === 'remote' ? `主仓库 ${remoteName}` : '本地回退'}）`,
        `记忆远端：${remoteKind}（${syncOrigin ?? '未挂载'}）`,
        `远端分支：${info.remoteBranch}`,
        `本项目同步：${info.projectEnabled ? '已启用' : '已停用（记忆保留本地）'}`,
        // 三态取代旧轨开关后 tracks.project 不再独立：A/B 模式恒等于轨纳入，
        // 停用时轨位随 enabled 一起关（off 联动）
        `同步范围：${info.projectEnabled ? '项目记忆轨（KEY/日志/归档/项目待办）' : '未选择（停用状态）'}`,
        // 「未推送」= 工作树未提交变更 + 已提交未推送的提交（2026-08-11 用户
        // 反馈：只看"未提交"会误以为拉取合并已把内容推上去）
        `未推送：${(info.uncommitted ?? 0) + (info.ahead ?? 0)} 条（拉取合并只提交/合并本地，点「推送」才上远端）`,
        `落后远端：${info.behind} 个提交`,
        `待处理冲突：${info.conflicts} 条`,
        `提示：点「同步」拉取合并；点「同步并推送」同步并推送（推送需你显式点击）`,
      ]
      // 全局轨区（全局记忆仓库已初始化时展示——设备级状态）
      if (info.global?.initialized === true) {
        lines.push('', `【全局记忆同步】（全局记忆远端：${info.global.url}）`)
        lines.push(`全局轨开关：${renderGlobalTracks(info.global.tracks)}`)
        lines.push(`未推送：${(info.global.uncommitted ?? 0) + (info.global.ahead ?? 0)} 个轨（点「全局推送」才上远端）`)
        lines.push('提示：点「全局同步」拉取合并；点「全局同步并推送」同步并推送')
      }
      return { kind: 'success', text: lines.join('\n') }
    }

    case 'conflict': {
      const sub = (rest[0] ?? 'list').toLowerCase()
      if (sub === 'resolve') {
        // resolve <编号> ours|theirs|both：采用本地/远端/两版都要；
        // 解决后重新提交（施工图 §7 第 7 步）
        const index = Number(rest[1])
        const choice = (rest[2] ?? '').toLowerCase()
        if (!Number.isInteger(index) || index < 1) {
          return { kind: 'error', text: '用法：conflict resolve <编号> ours | theirs | both（编号来自 conflict list）' }
        }
        if (!['ours', 'theirs', 'both'].includes(choice)) {
          return { kind: 'error', text: '用法：conflict resolve <编号> ours | theirs | both' }
        }
        const result = await resolveConflict({ dir, index, choice })
        if (!result.ok) return { kind: 'error', text: result.message }
        return { kind: 'success', text: `${result.message}${result.remaining > 0 ? `；剩余冲突 ${result.remaining} 条` : '；冲突已全部解决'}` }
      }
      if (sub !== 'list') {
        return { kind: 'error', text: '用法：conflict list | conflict resolve <编号> ours | theirs | both' }
      }
      const path = join(dir, CONFLICTS_FILE)
      if (!existsSync(path)) return { kind: 'success', text: '没有待处理的同步冲突。' }
      return { kind: 'success', text: readFileSync(path, 'utf8') }
    }

    case 'migrate': {
      const legacy = locateLegacyDir(config.memoryDir, cwd, identity.id)
      if (legacy === null) {
        return { kind: 'success', text: '没有发现可迁移的旧记忆目录（当前身份与历史目录一致）。' }
      }
      return {
        kind: 'success',
        text: `发现旧记忆目录：${legacy}\n→ 点「开始同步」会自动迁移到新目录 ${dir}（记入迁移日志）。`,
      }
    }

    default:
      return { kind: 'error', text: `未知子命令 "${op}"。用法：setup [url] | sync [--push] | off | status | conflict list | migrate` }
  }
}
