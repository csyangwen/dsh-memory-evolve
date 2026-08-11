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
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { projectHash } from '../store.js'
import { locateLegacyDir, resolveMainRemote, resolveProjectId } from './identity.js'
import { countConflicts, CONFLICTS_FILE } from './worker.js'
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
  const provenancePath = join(dir, 'PROVENANCE')
  if (existsSync(provenancePath)) {
    try {
      const meta = JSON.parse(readFileSync(provenancePath, 'utf8').trim())
      if (typeof meta.remoteBranch === 'string' && meta.remoteBranch !== '') remoteBranch = meta.remoteBranch
    } catch { /* 损坏视同缺省 */ }
  }
  return { dir, remoteBranch, identity }
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
    uncommitted,
    behind,
    conflicts: countConflicts(dir),
    identity,
    dir,
    remoteBranch,
  }
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
      description: '项目记忆跨设备同步（Git）：setup [url] 初始化（无参=模式 A 复用主仓库远端；url=模式 B 私有记忆仓库），sync 拉取并合并，sync --push 同步并推送（推送需你显式触发），off 停用同步，status 查看状态，conflict list 列出待处理冲突，migrate 查看可迁移的旧记忆目录',
      input: { syntax: 'setup [url] | sync [--push] | off | status | conflict list | migrate', hint: '缺省=status' },
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

  return {
    dispose() {
      for (const d of disposers) { try { d() } catch { /* 幂等 */ } }
      disposers.length = 0
      commandDispose = null
    },
    /** API 用：当前会话 cwd 的同步状态（含 enabled/initialized）。 */
    syncStatus(cwd) {
      const enabled = getRuntime()?.syncEnabled === true
      const info = enabled ? syncStatusSync(config, cwd) : null
      return { enabled, ...(info ?? { initialized: false }) }
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
        const connect = await deviceBConnect({ dir, remoteUrl: url, remoteBranch: 'main' })
        if (connect.mode === 'error') return { kind: 'error', text: connect.message }
        if (connect.mode === 'adopt') {
          // 已接入：仍需本地初始化配套文件（PROVENANCE 等由远端带来）
          return { kind: 'success', text: `模式 B（私有仓库）接入完成：${connect.message}。执行 /memory_sync sync 拉取合并` }
        }
        const boot = await ensureMemoryRepo({ dir, memoryDir: config.memoryDir, cwd, projectId: identity.id, displayName: identity.displayName, remoteUrl: url, remoteBranch: 'main' })
        if (!boot.ok) return { kind: 'error', text: boot.message }
        return { kind: 'success', text: `模式 B 初始化完成：${boot.message}。执行 /memory_sync sync --push 首次推送（推送需你同意）` }
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
      return { kind: 'success', text: `模式 A 初始化完成：${boot.message}。${pushHint}` }
    }

    case 'sync': {
      if (!existsSync(join(dir, '.git'))) {
        return { kind: 'error', text: '当前项目尚未初始化同步——请先执行 /memory_sync setup' }
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
      // 停用同步：关闭全局开关（所有项目停止同步；记忆全保留，目录不删）
      applyRuntimePatch({ syncEnabled: false })
      return { kind: 'success', text: '已停用记忆同步（syncEnabled=false）。已同步项目的记忆完整保留在本机，不再对账；重新启用随时可继续。' }
    }

    case 'status': {
      const enabled = getRuntime()?.syncEnabled === true
      if (!enabled) return { kind: 'success', text: '记忆同步未启用（syncEnabled=false）——执行 /memory_sync setup 初始化并开启' }
      const info = syncStatusSync(config, cwd)
      if (info === null) {
        return { kind: 'success', text: `记忆同步已启用，但当前项目未初始化（远端：${identity.displayName}）——执行 /memory_sync setup 开始` }
      }
      const remoteName = resolveMainRemote(cwd)?.name ?? '?'
      const lines = [
        `项目身份：${info.identity.displayName}（${info.identity.kind === 'remote' ? `主仓库 ${remoteName}` : '本地回退'}）`,
        `远端分支：${info.remoteBranch}`,
        `未提交记忆：${info.uncommitted} 条`,
        `落后远端：${info.behind} 个提交`,
        `待处理冲突：${info.conflicts} 条`,
        `提示：/memory_sync sync 拉取合并；sync --push 同步并推送（推送需你显式触发）`,
      ]
      return { kind: 'success', text: lines.join('\n') }
    }

    case 'conflict': {
      const sub = (rest[0] ?? 'list').toLowerCase()
      if (sub !== 'list') {
        return { kind: 'error', text: '用法：conflict list（resolve 能力即将就绪）' }
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
