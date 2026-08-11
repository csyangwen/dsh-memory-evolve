/**
 * lib/sync/worker.js — sync-worker 命令执行器（施工图 §7 第 5 步）
 *
 * 实现施工图 §5 的 sync 主流程，供独立进程（scripts/sync-worker.mjs）与
 * 主进程工具共用。核心是**锁分离**（需求 #8）：
 *
 *   - 阶段 1（锁外）：fetch 远端分支（网络命令，异步 spawn，GIT_TERMINAL
 *     _PROMPT=0 防凭证卡死）——失败即退出，本地数据零影响；
 *   - 阶段 2（锁内）：读取三方（base=merge-base 树 / ours=工作树 /
 *     theirs=远端树）→ mergeEntries 内存合并 → 原子写回工作树 →
 *     commit-tree 双父提交（index 永不 unmerged，git 冲突标记永不落盘）→
 *     update-ref。锁内全部为本地毫秒级操作（不触发 5s 超时）；
 *   - 阶段 3（锁外，仅 --push）：显式 refspec push；non-fast-forward
 *     只提示先再同步，绝不 force（需求 #9 禁 force push）。
 *
 * 降级路径：merge-base 失败 / PROVENANCE 不一致 → 退出码 3（需人工干预，
 * 绝不自动覆盖）；fetch/push 失败 → 退出码 1（可恢复）。
 *
 * 输出约定：stdout 单行 JSON { ok, code, message, committed, conflicts,
 * stats }；退出码 0=成功 / 1=可恢复错误 / 3=需人工干预。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEntries, serializeEntries } from '../store.js'
import { genEntryId } from './entryid.js'
import { mergeEntries } from './merge.js'
import { asyncWithLock, isMemoryFile, readTreeFiles, runGit, stagePaths } from './repo.js'

/** CONFLICTS.md 文件名（冲突侧车，随提交保留历史；list/resolve 解析它）。 */
export const CONFLICTS_FILE = 'CONFLICTS.md'

/**
 * 执行一次 sync（阶段 1 fetch → 阶段 2 合并提交 → 阶段 3 可选 push）。
 * @param {object} p
 * @param {string} p.dir - 记忆仓库目录。
 * @param {string} p.remoteBranch - 远端分支名（模式 A=dsh-shared/memory；
 *   模式 B=main）。
 * @param {boolean} [p.push=false] - 是否执行阶段 3 push（**仅用户显式
 *   /memory sync --push 触发**，需求 #12：push 永远需用户同意）。
 * @returns {Promise<{ok: boolean, code: number, message: string,
 *   committed: boolean, conflicts: number, stats: object}>}
 */
export async function runSync({ dir, remoteBranch, push = false }) {
  const rb = `refs/remotes/origin/${remoteBranch}`

  // ── 前置检查：目录必须是已初始化的记忆仓库 ──
  if (!existsSync(join(dir, '.git'))) {
    return { ok: false, code: 1, message: '记忆仓库尚未初始化——请先执行 /memory sync setup 初始化', committed: false, conflicts: 0, stats: {} }
  }

  // ── 阶段 1（锁外）：fetch 远端分支（显式 refspec）──
  const fetch = await runGit(dir, ['fetch', 'origin', `refs/heads/${remoteBranch}:${rb}`], { network: true })
  if (!fetch.ok) {
    // fetch 失败：不进入合并，本地数据零影响
    const err = fetch.stderr.trim().split('\n')[0] ?? '未知错误'
    return { ok: false, code: 1, message: `拉取远端记忆失败（${err}）。本地记忆未受影响，请检查网络/凭证后重试`, committed: false, conflicts: 0, stats: {} }
  }

  // 远端 ref 存在性（fetch 后应有；防御）
  const theirsRef = await runGit(dir, ['rev-parse', '--verify', rb])
  if (!theirsRef.ok) {
    return { ok: false, code: 1, message: `远端分支 ${remoteBranch} 不存在——请先执行 /memory sync setup 初始化`, committed: false, conflicts: 0, stats: {} }
  }
  const headRef = await runGit(dir, ['rev-parse', '--verify', 'HEAD'])

  // ── PROVENANCE 校验（锁外，施工图 §9）：两侧都有且不一致 → 拒绝 ──
  const provenanceCheck = checkProvenance(dir, rb)
  if (!provenanceCheck.ok) {
    return { ok: false, code: 3, message: provenanceCheck.message, committed: false, conflicts: 0, stats: {} }
  }

  // ── 读 theirs / base（锁外，git 对象库读取，不碰工作树）──
  const theirs = await readTreeFiles(dir, rb)
  let base = { files: {}, provenance: null }
  if (headRef.ok) {
    const mergeBase = await runGit(dir, ['merge-base', 'HEAD', rb])
    if (!mergeBase.ok) {
      // merge-base 失败（历史无法对齐：被 force 推送或错接分支）→ 降级
      // 退出码 3，绝不自动覆盖（施工图 §5 阶段 2a）
      return {
        ok: false, code: 3,
        message: '历史无法对齐（可能被 force 推送或接错了分支）——已停止合并，本地记忆未受影响。请人工检查远端分支后重试',
        committed: false, conflicts: 0, stats: {},
      }
    }
    base = await readTreeFiles(dir, mergeBase.stdout.trim())
  }

  // ── 阶段 2（锁内）：读工作树 → 合并 → 写回 → 双父提交 ──
  const merged = await asyncWithLock(dir, async () => {
    // ours = 工作树（锁内读，避免读到 store 写一半的文件）
    const ours = readWorkingMemoryFiles(dir)
    const result = mergeEntries(base.files, ours, theirs.files)
    // 原子写回（tmp+rename，与 store.js write 同款）
    for (const [path, entries] of Object.entries(result.files)) {
      const abs = join(dir, path)
      mkdirSync(join(dir, dirname2(path)), { recursive: true })
      const tmp = `${abs}.tmp.${process.pid}`
      writeFileSync(tmp, serializeEntries(entries))
      renameSync(tmp, abs)
    }
    // 冲突侧车：CONFLICTS.md（有冲突写、无冲突删——删除随提交生效）
    if (result.conflicts.length > 0) {
      writeFileSync(join(dir, CONFLICTS_FILE), renderConflicts(result.conflicts))
    } else if (existsSync(join(dir, CONFLICTS_FILE))) {
      rmSync(join(dir, CONFLICTS_FILE), { force: true })
    }
    // 提交：allowlist stage（审查 P1-12：TODOS.md 等白名单外文件绝不入库）
    // → write-tree → commit-tree（双父）→ update-ref。index 永不 unmerged
    // （我们从不 git merge）；无变化时跳过。
    await stagePaths(dir)
    const staged = await runGit(dir, ['diff', '--cached', '--quiet'])
    if (staged.ok) {
      return { ...result, committed: false }
    }
    const tree = await runGit(dir, ['write-tree'])
    if (!tree.ok) return { ...result, committed: false, commitError: 'write-tree 失败' }
    const parents = []
    if (headRef.ok) parents.push('-p', 'HEAD')
    parents.push('-p', rb)
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const commit = await runGit(dir, ['commit-tree', ...parents, '-m', `memory: sync ${stamp} [merge]`, tree.stdout.trim()])
    if (!commit.ok) return { ...result, committed: false, commitError: 'commit-tree 失败' }
    await runGit(dir, ['update-ref', 'refs/heads/main', commit.stdout.trim()])
    return { ...result, committed: true }
  })

  // conflicts 统一为计数（merged.conflicts 是合并器返回的数组）
  const conflictCount = Array.isArray(merged.conflicts) ? merged.conflicts.length : (merged.conflicts ?? 0)
  if (merged.commitError) {
    return { ok: false, code: 1, message: `合并完成但提交失败：${merged.commitError}。工作树已是合并结果，请重试`, committed: false, conflicts: conflictCount, stats: merged.stats }
  }

  // ── 阶段 3（锁外，仅 --push）：显式 refspec；non-ff 不 force ──
  let pushed = false
  if (push) {
    const pushResult = await runGit(dir, ['push', 'origin', `refs/heads/main:refs/heads/${remoteBranch}`], { network: true })
    if (!pushResult.ok) {
      const err = pushResult.stderr.trim()
      if (/non-fast-forward|fetch first|rejected/i.test(err)) {
        return {
          ok: false, code: 1,
          message: '推送被拒绝：远端有新提交（non-fast-forward）。请先再执行一次 /memory sync 拉取合并后再推，绝不强制推送',
          committed: merged.committed, conflicts: conflictCount, stats: merged.stats,
        }
      }
      return {
        ok: false, code: 1,
        message: `推送失败（${err.split('\n')[0] ?? '未知错误'}）。合并结果已安全保存在本地，可稍后重试`,
        committed: merged.committed, conflicts: conflictCount, stats: merged.stats,
      }
    }
    pushed = true
  }

  const bits = []
  if (merged.committed) bits.push(`已合并提交${pushed ? '并推送' : ''}`)
  else if (pushed) bits.push('已推送（无新合并）')
  else bits.push('无需合并（两边一致）')
  if (conflictCount > 0) bits.push(`${conflictCount} 条冲突待处理（/memory sync conflict list）`)
  if (merged.stats.removed > 0) bits.push(`删除 ${merged.stats.removed} 条（可恢复）`)

  return {
    ok: true, code: 0,
    message: bits.join('；'),
    committed: merged.committed,
    conflicts: conflictCount,
    stats: merged.stats,
  }
}

/**
 * 读取 sync 状态（快照状态行 / status 命令用）：远端落后/领先、未提交数、
 * 冲突数。全部本地 git 查询（毫秒级），不联网。
 * @param {object} p - { dir, remoteBranch }。
 * @returns {Promise<{ok: boolean, message: string, status: object}>}
 */
export async function runStatus({ dir, remoteBranch }) {
  if (!existsSync(join(dir, '.git'))) {
    return { ok: true, message: '未初始化', status: { initialized: false } }
  }
  const rb = `refs/remotes/origin/${remoteBranch}`
  const headRef = await runGit(dir, ['rev-parse', '--verify', 'HEAD'])
  const theirsRef = await runGit(dir, ['rev-parse', '--verify', rb])
  // 未提交变更数（工作树 vs HEAD；git status --porcelain 的行数）
  const dirty = await runGit(dir, ['status', '--porcelain'])
  const uncommitted = dirty.ok ? dirty.stdout.split('\n').filter((l) => l.trim() !== '').length : 0
  // 落后/领先提交数（与远端对齐程度）
  let behind = 0
  let ahead = 0
  if (headRef.ok && theirsRef.ok) {
    const b = await runGit(dir, ['rev-list', '--count', `${rb}..HEAD`])
    const a = await runGit(dir, ['rev-list', '--count', `HEAD..${rb}`])
    if (a.ok) behind = Number(a.stdout.trim()) || 0
    if (b.ok) ahead = Number(b.stdout.trim()) || 0
  }
  // 冲突数（解析 CONFLICTS.md 的编号条目）
  const conflicts = countConflicts(dir)
  return {
    ok: true,
    message: `初始化：${theirsRef.ok ? '已接入' : '未接入远端'}`,
    status: { initialized: true, behind, ahead, uncommitted, conflicts },
  }
}

/* ---------------- 内部工具 ---------------- */

/** 工作树记忆文件读取（锁内调用）。 */
function readWorkingMemoryFiles(dir) {
  const files = {}
  for (const name of ['KEY.md', 'KEY-archive.md', 'MEMORY.md']) {
    const p = join(dir, name)
    if (existsSync(p)) files[name] = parseEntries(readFileSync(p, 'utf8'))
  }
  const logsDir = join(dir, 'logs')
  if (existsSync(logsDir) && readdirSync(logsDir).length > 0) {
    for (const name of readdirSync(logsDir)) {
      if (name.endsWith('.md')) files[`logs/${name}`] = parseEntries(readFileSync(join(logsDir, name), 'utf8'))
    }
  }
  return files
}

/** 路径的目录部分（兼容无目录的根级文件）。 */
function dirname2(path) {
  const i = path.lastIndexOf('/')
  return i < 0 ? '.' : path.slice(0, i)
}

/**
 * PROVENANCE 校验（施工图 §9）：本地与远端都有且 projectId 不一致 →
 * 拒绝合并（防止把 A 项目的记忆并进 B 项目）。任一侧缺失（老仓库）→
 * 警告放行（不阻塞首次对接）。
 */
function checkProvenance(dir, rb) {
  const localPath = join(dir, 'PROVENANCE')
  let local = null
  if (existsSync(localPath)) {
    try {
      local = JSON.parse(readFileSync(localPath, 'utf8').trim())
    } catch { /* 损坏视同缺失 */ }
  }
  // 远端 PROVENANCE 从对象库读（不依赖工作树）
  let remote = null
  try {
    const raw = runGitSync(dir, ['show', `${rb}:PROVENANCE`])
    if (raw !== null) remote = JSON.parse(raw.trim())
  } catch { /* 无远端 PROVENANCE（老仓库） */ }
  if (local && remote && local.projectId && remote.projectId && local.projectId !== remote.projectId) {
    return { ok: false, message: `记忆身份不匹配：本地项目 ${local.projectId}（${local.displayName ?? ''}）≠ 远端项目 ${remote.projectId}（${remote.displayName ?? ''}）。疑似接错了分支/仓库，已拒绝合并。请检查后重试` }
  }
  return { ok: true }
}

/** 渲染 CONFLICTS.md（编号=顺序号，resolve 的稳定标识）。 */
export function renderConflicts(conflicts) {
  const lines = ['# 记忆同步冲突', '']
  conflicts.forEach((c, i) => {
    lines.push(`## ${i + 1}. ${c.entryKey}（文件：${c.file}）`)
    lines.push(`- 原因：${c.reason}`)
    lines.push(`- base：${c.base ?? '（无）'}`)
    lines.push(`- ours：${c.ours ?? '（无）'}`)
    lines.push(`- theirs：${c.theirs ?? '（无）'}`)
    lines.push('')
  })
  return lines.join('\n')
}

/** 解析 CONFLICTS.md 的冲突数（# N. 条目数）。 */
export function countConflicts(dir) {
  const p = join(dir, CONFLICTS_FILE)
  if (!existsSync(p)) return 0
  const text = readFileSync(p, 'utf8')
  const m = text.match(/^## (\d+)\./gm)
  return m ? m.length : 0
}

/** 同步 git show 辅助（PROVENANCE 读取用，本地命令毫秒级）。 */
function runGitSync(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] })
  return r.status === 0 ? String(r.stdout ?? '').trim() : null
}

/* ---------------- conflict resolve（施工图 §7 第 7 步） ---------------- */

/**
 * 解析 CONFLICTS.md → 冲突条目列表（编号=文件中的顺序，1 起，稳定标识）。
 * @param {string} text - CONFLICTS.md 全文。
 * @returns {Array<{index: number, entryKey: string, file: string, reason: string,
 *   base: string | null, ours: string | null, theirs: string | null}>}
 */
export function parseConflicts(text) {
  const out = []
  const blocks = String(text ?? '').split(/^## /m).slice(1)
  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i].split('\n')
    const header = (lines[0] ?? '').trim()
    // 形如 "1. aaaa0000（文件：KEY.md）"
    const m = /^(\d+)\.\s+(\S+)\s*（文件：(.+?)）/.exec(header)
    if (m === null) continue
    const item = { index: Number(m[1]), entryKey: m[2], file: m[3], reason: '', base: null, ours: null, theirs: null }
    for (const line of lines.slice(1)) {
      // 标签中英兼容（renderConflicts 输出"原因"，历史文件可能是"reason"）
      const r = /^-\s+(原因|reason|base|ours|theirs)：(.*)$/.exec(line.trim())
      if (r === null) continue
      if (r[1] === '原因' || r[1] === 'reason') item.reason = r[2]
      else if (r[1] === 'base') item.base = r[2]
      else if (r[1] === 'ours') item.ours = r[2]
      else if (r[1] === 'theirs') item.theirs = r[2]
    }
    out.push(item)
  }
  return out
}

/**
 * 解决一条冲突（施工图 §7 第 7 步）：
 *   - ours：采用本地版本；theirs：采用远端版本；both：两个版本都要
 *     （theirs 版本换新随机 ID——同 ID 不能并存，联合索引唯一性约束）。
 *   - 写回目标文件（锁内）→ 从 CONFLICTS.md 移除该条（清空则删文件）→
 *     提交（allowlist + commit-tree 单父，本地提交）。
 * @param {object} p - { dir, remoteBranch, index, choice }。
 * @returns {Promise<{ok: boolean, message: string, remaining: number}>}
 */
export async function resolveConflict({ dir, index, choice }) {
  const path = join(dir, CONFLICTS_FILE)
  if (!existsSync(path)) return { ok: false, message: '没有待处理的冲突' }
  const text = readFileSync(path, 'utf8')
  const conflicts = parseConflicts(text)
  const target = conflicts.find((c) => c.index === index)
  if (target === undefined) {
    return { ok: false, message: `冲突编号 ${index} 不存在（当前 1..${conflicts.length}）` }
  }
  if (!['ours', 'theirs', 'both'].includes(choice)) {
    return { ok: false, message: '用法：conflict resolve <编号> ours | theirs | both' }
  }
  if (choice !== 'both' && target[choice] === null) {
    return { ok: false, message: `冲突 ${index} 没有可用的 ${choice} 版本（该侧为空/删除）` }
  }

  return asyncWithLock(dir, async () => {
    // ── 1. 写回目标文件（锁内；文件可能不存在如 logs/xxx.md → 建目录）──
    const abs = join(dir, target.file)
    mkdirSync(join(dir, dirname2(target.file)), { recursive: true })
    const entries = existsSync(abs) ? parseEntries(readFileSync(abs, 'utf8')) : []
    if (choice === 'both') {
      // 两个版本都要：ours 原样 + theirs 换新随机 ID（同 ID 不并存）
      const theirsWithNewId = stripIdToNew(target.theirs)
      if (target.ours !== null) entries.push(target.ours)
      if (theirsWithNewId !== null) entries.push(theirsWithNewId)
    } else {
      entries.push(target[choice])
    }
    const tmp = `${abs}.tmp.${process.pid}`
    writeFileSync(tmp, serializeEntries(entries))
    renameSync(tmp, abs)

    // ── 2. 从 CONFLICTS.md 移除该条（清空则删文件）──
    const remaining = conflicts.filter((c) => c.index !== index)
    if (remaining.length === 0) {
      rmSync(path, { force: true })
    } else {
      // 重建文件：编号重新从 1 起（稳定标识=新顺序）
      writeFileSync(path, renderConflicts(remaining.map(({ entryKey, file, base, ours, theirs, reason }) => ({ entryKey, file, base, ours, theirs, reason }))))
    }

    // ── 3. 提交（allowlist + commit-tree 单父；index 永不 unmerged）──
    await stagePaths(dir)
    const staged = await runGit(dir, ['diff', '--cached', '--quiet'])
    if (!staged.ok) {
      const tree = await runGit(dir, ['write-tree'])
      const headRef = await runGit(dir, ['rev-parse', '--verify', 'HEAD'])
      const parents = headRef.ok ? ['-p', 'HEAD'] : []
      const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
      const commit = await runGit(dir, ['commit-tree', ...parents, '-m', `memory: resolve conflict #${index} (${choice}) ${stamp}`, tree.stdout.trim()])
      if (commit.ok) {
        await runGit(dir, ['update-ref', 'refs/heads/main', commit.stdout.trim()])
      }
    }
    return { ok: true, message: `已解决冲突 #${index}（${choice}）并提交`, remaining: remaining.length }
  })
}

/** 换掉条目的身份证（both 场景：theirs 版换新 ID 后与 ours 并存）。 */
function stripIdToNew(entry) {
  if (entry === null) return null
  return entry.replace(/^\[id:[0-9a-f]{8}\]\s*/, `[id:${genEntryId()}] `)
}
