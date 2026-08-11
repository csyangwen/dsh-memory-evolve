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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProjectSyncEnabled, projectHash, readProvenance } from '../store.js'
import { locateLegacyDir, resolveMainRemote, resolveProjectId } from './identity.js'
import { countConflicts, CONFLICTS_FILE, parseConflicts, resolveConflict } from './worker.js'
import { deviceBConnect, ensureMemoryRepo } from './repo.js'

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
  let remoteBranch = 'dsh-shared/memory' // 老 PROVENANCE 无字段 → 模式 A 缺省
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
  if (!existsSync(join(dir, '.git'))) return null
  const rb = `refs/remotes/origin/${remoteBranch}`
  const head = runGitSync(dir, ['rev-parse', '--verify', 'HEAD'])
  const theirs = runGitSync(dir, ['rev-parse', '--verify', rb])
  const dirty = runGitSync(dir, ['status', '--porcelain'])
  const uncommitted = dirty === null ? 0 : dirty.split('\n').filter((l) => l.trim() !== '').length
  let behind = 0
  if (head !== null && theirs !== null) {
    const n = runGitSync(dir, ['rev-list', '--count', `HEAD..${rb}`])
    if (n !== null) behind = Number(n) || 0
  }
  return {
    initialized: true,
    // 项目级同步开关（三层开关第 2 层）：PROVENANCE 存在且 enabled !== false
    projectEnabled: isProjectSyncEnabled(dir),
    // 轨级开关（第 3 层）：一期唯一轨=项目记忆（KEY/日志/归档）；全局轨二期
    tracks: { project: provenanceTrackProject(dir) },
    uncommitted,
    behind,
    conflicts: countConflicts(dir),
    identity,
    dir,
    remoteBranch,
  }
}

/** 项目记忆轨开关（PROVENANCE.tracks.project，缺省 true）。 */
function provenanceTrackProject(dir) {
  const meta = readProvenance(dir)
  return meta?.tracks?.project !== false
}

/**
 * 共享记忆仓库专属分支判定：`dsh-shared/<12hex>`（区别于模式 A 的固定
 * 分支 `dsh-shared/memory`）。用于 status/UI 的可读性标注。
 * @param {string | undefined} branch
 * @returns {boolean}
 */
function isSharedBranch(branch) {
  return typeof branch === 'string' && branch.startsWith('dsh-shared/') && branch !== 'dsh-shared/memory'
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
      description: '项目记忆跨设备同步（Git）：setup [url] 初始化（无参=模式 A 复用主仓库远端；url=模式 B 共享记忆仓库——一个私有仓库可装所有项目的记忆，每个项目自动使用专属分支 dsh-shared/<项目身份>，老单项目仓库自动兼容），sync 拉取并合并，sync --push 同步并推送（推送需你显式触发），off 停用同步，status 查看状态，conflict list 列出待处理冲突，conflict resolve <编号> ours|theirs|both 解决冲突，migrate 查看可迁移的旧记忆目录',
      input: { syntax: 'setup [url] | sync [--push] | off | status | conflict list | conflict resolve <n> ours|theirs|both | migrate', hint: '缺省=status' },
      async handler(invocation) {
        const tokens = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
        const op = (tokens[0] ?? 'status').toLowerCase()
        const cwd = invocation.agent?.session?.header?.cwd
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
          if (!info.provenance.enabled) {
            info.provenance.enabled = true
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
  if (info === null) return ''
  const bits = []
  if (info.uncommitted > 0) bits.push(`未提交 ${info.uncommitted} 条`)
  if (info.behind > 0) bits.push(`落后远端 ${info.behind} 个提交（/memory_sync sync 拉取）`)
  if (info.conflicts > 0) bits.push(`冲突 ${info.conflicts} 条待处理（/memory_sync conflict list）`)
  const line = bits.length > 0 ? bits.join(' · ') : '已同步'
  return `## 记忆同步\n- 状态：${line}（/memory_sync status 查看详情）`
}

/* ── 命令子命令实现 ── */

/** 命令子命令实现（导出供测试；命令组 handler 调用）。 */
export async function handleCommand(op, rest, cwd, { config, getRuntime, applyRuntimePatch }) {
  const { dir, remoteBranch, identity } = projectSyncInfo(config, cwd)

  switch (op) {
    case 'setup': {
      // 模式判定：无参数=模式 A（复用主仓库 origin）；有 url=模式 B
      const modeB = typeof rest[0] === 'string' && rest[0].trim() !== ''
      if (modeB) {
        const url = rest[0].trim()
        // 共享记忆仓库分支决策（2026-08-11 拍板：一个私有仓库装所有项目的
        // 记忆）：worker 子进程执行（网络命令），返回本项目应使用的远端分支
        // —— 专属分支 dsh-shared/<projectId>；老单项目仓库（main 分支且
        // PROVENANCE.projectId 匹配）自动识别、继续用 main（零迁移兼容）。
        const decide = await spawnWorker(['decide', dir, url, identity.id])
        const out = parseWorkerOutput(decide)
        if (!out.ok) return { kind: 'error', text: out.message }
        const branch = typeof out.branch === 'string' && out.branch !== '' ? out.branch : 'main'
        // expectedProjectId：接入前校验远端 PROVENANCE 归属本项目（模式 B
        // 一期漏传此参数——共享仓库下多项目并存，校验是硬防线，必须补上）
        const connect = await deviceBConnect({ dir, remoteUrl: url, remoteBranch: branch, expectedProjectId: identity.id })
        if (connect.mode === 'error') return { kind: 'error', text: connect.message }
        if (connect.mode === 'adopt') {
          // 已接入：仍需本地初始化配套文件（PROVENANCE 等由远端带来）
          // 用户主动执行 setup = 明确启用意图：自动打开模块开关（Tab 可见）
          applyRuntimePatch({ syncEnabled: true })
          return { kind: 'success', text: `已接入共享记忆仓库（${branch}）：${connect.message}。执行 /memory_sync sync 拉取合并` }
        }
        const boot = await ensureMemoryRepo({ dir, memoryDir: config.memoryDir, cwd, projectId: identity.id, displayName: identity.displayName, remoteUrl: url, remoteBranch: branch })
        if (!boot.ok) return { kind: 'error', text: boot.message }
        // 与模式 A 同款：setup = 明确启用意图 → 自动打开模块开关（Tab 可见）
        applyRuntimePatch({ syncEnabled: true })
        return { kind: 'success', text: `共享记忆仓库初始化完成（${branch}）：${boot.message}。执行 /memory_sync sync --push 首次推送（推送需你同意）` }
      }
      // 模式 A：主仓库必须可识别（有可归一化的 remote）
      if (identity.kind !== 'remote') {
        return { kind: 'error', text: `当前项目没有可共享的 git 远端（${identity.displayName}）——模式 A 需要主仓库 remote 地址。请为项目配置远端后重试，或使用 /memory_sync setup <url> 指定私有记忆仓库（模式 B）` }
      }
      // 设备 B 判定树：远端已有 dsh-shared/memory → 直接接入；否则本地初始化。
      // 试探地址优先用已配置的记忆仓库 origin（重复 setup / 已初始化项目的
      // 真实传输通道），首次 setup 才用主仓库 identity.remoteUrl。
      const existingOrigin = runGitSync(dir, ['remote', 'get-url', 'origin'])
      const probeUrl = existingOrigin ?? identity.remoteUrl
      const connect = await deviceBConnect({ dir, remoteUrl: probeUrl, remoteBranch })
      if (connect.mode === 'error') return { kind: 'error', text: connect.message }
      if (connect.mode === 'adopt') {
        return { kind: 'success', text: `已接入远端记忆（${remoteBranch}）：${connect.message}。执行 /memory_sync sync 拉取合并` }
      }
      const boot = await ensureMemoryRepo({ dir, memoryDir: config.memoryDir, cwd, projectId: identity.id, displayName: identity.displayName, remoteUrl: probeUrl, remoteBranch })
      if (!boot.ok) return { kind: 'error', text: boot.message }
      const pushHint = boot.remoteBranchExists === false
        ? '远端尚无该分支——执行 /memory_sync sync --push 完成首次推送（推送需你同意）'
        : '执行 /memory_sync sync 同步'
      // 用户主动执行 setup = 明确启用意图：自动打开模块开关（Tab 可见），
      // 项目级 enabled 由 bootstrap 写入（默认 true）
      applyRuntimePatch({ syncEnabled: true })
      return { kind: 'success', text: `模式 A 初始化完成（本项目已启用同步）：${boot.message}。${pushHint}` }
    }

    case 'sync': {
      if (!existsSync(join(dir, '.git'))) {
        return { kind: 'error', text: '当前项目尚未初始化同步——请先执行 /memory_sync setup' }
      }
      const meta = readProvenance(dir)
      if (meta !== null && meta.enabled === false) {
        return { kind: 'error', text: '本项目已停用同步（记忆保留本地）——执行 /memory_sync setup 或到记忆同步 Tab 重新启用' }
      }
      if (meta !== null && meta.tracks?.project === false) {
        return { kind: 'error', text: '项目记忆轨已退出同步（未选择任何同步内容）——到记忆同步 Tab 重新勾选同步范围' }
      }
      const push = rest.includes('--push')
      if (push) {
        // push 需用户同意（需求 #12）：用户显式输入 --push 即视为同意
      }
      const run = await spawnWorker(['sync', dir, remoteBranch, ...(push ? ['--push'] : [])])
      const out = parseWorkerOutput(run)
      if (!out.ok) return { kind: 'error', text: out.message }
      const text = [out.message ?? '同步完成']
      if (push) text.push('（已推送）')
      return { kind: 'success', text: text.join(' ') }
    }

    case 'off': {
      // 停用同步：**项目级**（三层开关第 2 层，2026-08-11 用户拍板）——
      // 只停用当前项目（PROVENANCE.enabled=false），不影响全局模块开关与其他
      // 项目；记忆文件/仓库全保留，重新启用随时可继续。
      const meta = readProvenance(dir)
      if (meta === null) return { kind: 'error', text: '当前项目尚未初始化同步（无需停用）' }
      meta.enabled = false
      writeFileSync(join(dir, 'PROVENANCE'), `${JSON.stringify(meta)}\n`)
      return { kind: 'success', text: '本项目已停用同步：记忆完整保留在本机，不再对账；重新启用随时可继续（/memory_sync setup 或记忆同步 Tab）' }
    }

    case 'status': {
      const enabled = getRuntime()?.syncEnabled === true
      if (!enabled) return { kind: 'success', text: '记忆同步模块未启用（设置面板开关）——执行 /memory_sync setup 初始化并启用，或在「Memory Evolve 设置」打开' }
      const info = syncStatusSync(config, cwd)
      if (info === null) {
        return { kind: 'success', text: `模块已启用，但当前项目未初始化（远端：${identity.displayName}）——执行 /memory_sync setup 开始` }
      }
      const remoteName = resolveMainRemote(cwd)?.name ?? '?'
      // 共享记忆仓库专属分支标注：dsh-shared/<12hex>（区别于模式 A 的
      // dsh-shared/memory）——分支名不可读，标注让用户知道记忆在共享仓库里
      const branchText = isSharedBranch(info.remoteBranch)
        ? `${info.remoteBranch}（共享记忆仓库专属分支）`
        : info.remoteBranch
      const lines = [
        `项目身份：${info.identity.displayName}（${info.identity.kind === 'remote' ? `主仓库 ${remoteName}` : '本地回退'}）`,
        `远端分支：${branchText}`,
        `本项目同步：${info.projectEnabled ? '已启用' : '已停用（记忆保留本地）'}`,
        `同步范围：${info.tracks.project ? '项目记忆轨（KEY/日志/归档）' : '未选择任何轨（该轨退出同步）'}`,
        `未提交记忆：${info.uncommitted} 条`,
        `落后远端：${info.behind} 个提交`,
        `待处理冲突：${info.conflicts} 条`,
        `提示：/memory_sync sync 拉取合并；sync --push 同步并推送（推送需你显式触发）`,
      ]
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
        text: `发现旧记忆目录：${legacy}\n→ 执行 /memory_sync setup 会自动迁移（rename）到新目录 ${dir}（记入迁移日志）。`,
      }
    }

    default:
      return { kind: 'error', text: `未知子命令 "${op}"。用法：setup [url] | sync [--push] | off | status | conflict list | migrate` }
  }
}
