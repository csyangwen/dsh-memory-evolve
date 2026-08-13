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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isCanonical, isProjectSyncEnabled, parseEntries, serializeEntries, readProvenance } from '../store.js'
import { genEntryId, extractEntryId, extractTodoId, TODO_ID_RE } from './entryid.js'
import { mergeEntries } from './merge.js'
import { asyncSyncLock, asyncWithLock, extractTodoHeader, isMemoryFile, parseTodoEntries, readTreeFiles, resolveFilesetFiles, runGit, serializeTodoEntries, stagePaths } from './repo.js'
import { conflictsFileFor, isTodoPath } from './filesets.js'

/** CONFLICTS.md 文件名（项目轨侧车；全局轨按 fileset 独立侧车，见 conflictsFileFor）。 */
export const CONFLICTS_FILE = 'CONFLICTS.md'

/**
 * 执行一次 sync（阶段 1 fetch → 阶段 2 合并提交 → 阶段 3 可选 push）。
 * @param {object} p
 * @param {string} p.dir - 记忆仓库目录。
 * @param {string} p.remoteBranch - 远端分支名（项目=dsh-shared/<id>；
 *   全局轨=dsh-shared/memory-global 等）。
 * @param {boolean} [p.push=false] - 是否执行阶段 3 push（**仅用户显式
 *   /memory sync --push 触发**，需求 #12：push 永远需用户同意）。
 * @param {string} [p.fileset='project'] - 同步文件集（project / memory-global /
 *   user-global / daily-global / todo-global——全局轨二期并入一期）。
 * @param {string} [p.localBranch='main'] - 本地分支（项目=main；全局轨=
 *   各轨独立分支 refs/heads/<fileset>，多轨同仓库互不干扰）。
 * @returns {Promise<{ok: boolean, code: number, message: string,
 *   committed: boolean, conflicts: number, stats: object}>}
 */
export async function runSync(p) {
  // 仓库级同步操作锁（Codex 二轮 P1-7）：同一 .git 的 fetch/index/ref/push
  // 串行化（独立于 .memory.lock，fetch 等网络不阻塞 store 写）
  return asyncSyncLock(p.dir, () => runSyncInner(p))
}

async function runSyncInner({ dir, remoteBranch, push = false, fileset = 'project', localBranch = 'main' }) {
  const rb = `refs/remotes/origin/${remoteBranch}`
  const lb = `refs/heads/${localBranch}`

  // ── 前置检查：目录必须是已初始化的记忆仓库 ──
  if (!existsSync(join(dir, '.git'))) {
    return { ok: false, code: 1, message: '记忆仓库尚未初始化——请先在记忆同步 Tab 点「开始同步」初始化', committed: false, conflicts: 0, stats: {} }
  }
  // **未解决冲突禁止继续（Codex 二轮 P0-2 数据风险链）**：冲突条目不落工作树
  // （只在侧车），二次 sync 重新合并会把"空工作树"误判为删除、覆盖侧车——
  // 数据永久丢。必须先 resolve 再同步（项目轨与全局轨一视同仁）。
  const pendingConflicts = countConflicts(dir, fileset)
  if (pendingConflicts > 0) {
    return { ok: false, code: 1, message: `还有 ${pendingConflicts} 条冲突未解决（${conflictsFileFor(fileset)}）——请先在冲突区解决后再同步`, committed: false, conflicts: pendingConflicts, stats: {} }
  }
  // 项目级同步开关（三层开关第 2 层，2026-08-11 用户拍板）：enabled=false
  // 的项目拒绝对账（记忆完整保留本地）。全局轨（fileset ≠ project）跳过
  // 项目级检查（全局仓库的开关是各轨 PROVENANCE.tracks，由调用方把关）。
  if (fileset === 'project') {
    if (!isProjectSyncEnabled(dir)) {
      return { ok: false, code: 1, message: '本项目已停用同步（记忆完整保留本地）——重新启用后继续', committed: false, conflicts: 0, stats: {} }
    }
    // 轨级开关（第 3 层）：项目记忆轨退出同步 → 无内容可对账。
    // **兜底语义（2026-08-11 用户拍板三态切换）**：handleCommand 'sync'
    // 已对"已启用（enabled=true）但轨位为旧 UI 遗留 false"的项目自愈复位
    // tracks.project=true——能走到 worker 的调用方必然已通过该检查；这里
    // 的拒绝只兜底绕过 handleCommand 的直接调用（如测试/未来调用方），
    // 保持保守：未显式纳入轨的内容不推送。
    const provenance = readProvenance(dir)
    if (provenance !== null && provenance.tracks?.project === false) {
      return { ok: false, code: 1, message: '项目记忆轨已退出同步（未选择任何同步内容）', committed: false, conflicts: 0, stats: {} }
    }
  }

  // ── 阶段 1（锁外）：fetch 远端分支（显式 refspec）──
  let fetch = await runGit(dir, ['fetch', 'origin', `refs/heads/${remoteBranch}:${rb}`], { network: true })
  if (!fetch.ok) {
    // 断电中断恢复：kill 可能残留 git 自身的 ref 锁（cannot lock ref）。
    // worker 是唯一 fetch 者且进程已死 → 清理残留锁后重试一次。
    if (/cannot lock ref/i.test(fetch.stderr)) {
      // 断电中断恢复：kill 可能让 fetch 的 ref 事务停在中间态（ref 锁残留
      // 或 CAS 期望值过期）。remote-tracking ref 只是缓存——先递归清理锁
      // 残留，再删除该 ref 强制重新拉取（无损，重拉全量）。
      cleanRefLocks(dir, remoteBranch)
      await runGit(dir, ['update-ref', '-d', rb])
      fetch = await runGit(dir, ['fetch', 'origin', `refs/heads/${remoteBranch}:${rb}`], { network: true })
    }
  }
  // 远端尚无此分支：**区分两种场景**（Grok 终审 P0-1 实锤修复）——
  //   a) 真·首次推送（本地从未跟踪过该分支）→ 远端视为空（theirs 空、
  //      无 merge-base、单父提交），本地合并后由阶段 3 的 push 创建远端分支；
  //   b) 远端分支消失（本地曾有陈旧 remote-tracking：之前 fetch 过、远端
  //      分支后来被删/改名）→ 陈旧 theirs + 空 base 会把"本地新写 vs 旧
  //      内容同 ID 不同"误判为双侧冲突、工作树被清空（数据风险）——
  //      必须拦截：清理陈旧 ref 后如实报错，绝不静默当首次推送重建远端分支。
  let remoteMissing = false
  if (!fetch.ok) {
    remoteMissing = /couldn't find remote ref|not our ref|no such ref/i.test(fetch.stderr)
  }
  if (!fetch.ok && !remoteMissing) {
    // fetch 失败：不进入合并，本地数据零影响
    const err = fetch.stderr.trim().split('\n')[0] ?? '未知错误'
    return { ok: false, code: 1, message: `拉取远端记忆失败（${err}）。本地记忆未受影响，请检查网络/凭证后重试`, committed: false, conflicts: 0, stats: {} }
  }
  if (remoteMissing) {
    const staleTracking = await runGit(dir, ['rev-parse', '--verify', rb])
    if (staleTracking.ok) {
      // 远端分支被删除/迁移：清理陈旧 tracking ref（保留只会让后续读树
      // 读到过期数据），并如实报错——本地记忆零改动
      await runGit(dir, ['update-ref', '-d', rb])
      return { ok: false, code: 1, message: `远端分支 ${remoteBranch} 已不存在（本地曾有陈旧跟踪，已清理）。远端记忆可能被删除或迁移——请检查远端后重新初始化`, committed: false, conflicts: 0, stats: {} }
    }
    // 真·首次推送：从未有过 tracking → 远端视为空
  }

  // 远端 ref 存在性（fetch 后应有；首次推送场景远端 ref 缺失是预期的）
  const theirsRef = await runGit(dir, ['rev-parse', '--verify', rb])
  if (!theirsRef.ok && !remoteMissing) {
    return { ok: false, code: 1, message: `远端分支 ${remoteBranch} 不存在——请先点「开始同步」初始化`, committed: false, conflicts: 0, stats: {} }
  }
  const headRef = await runGit(dir, ['rev-parse', '--verify', lb])

  // ── PROVENANCE 校验（锁外，施工图 §9）：远端分支存在时必须严格匹配；
  // 真·首次推送（remoteMissing）无需远端身份 ──
  const provenanceCheck = checkProvenance(dir, rb, remoteMissing)
  if (!provenanceCheck.ok) {
    return { ok: false, code: 3, message: provenanceCheck.message, committed: false, conflicts: 0, stats: {} }
  }

  // ── 读 theirs / base（锁外，git 对象库读取，不碰工作树）──
  // 格式预检（Codex P0-2）：远端/历史数据非 canonical（CRLF 等）绝不能进
  // 合并——合并器按条目处理，坏格式会被"修复"成结构损坏的写回。中止让
  // 用户人工处理，本地零改动。
  const theirs = await readTreeFiles(dir, rb, fileset)
  if (theirs.invalid.length > 0) {
    return { ok: false, code: 3, message: `远端记忆数据格式异常（${theirs.invalid[0].path}：${theirs.invalid[0].reason}）——已停止同步，本地记忆未受影响。请人工检查远端分支后重试`, committed: false, conflicts: 0, stats: {} }
  }
  let base = { files: {}, provenance: null, invalid: [] }
  // 首次推送场景（远端空）跳过 merge-base：无共同历史可对齐，base 为空
  if (headRef.ok && !remoteMissing) {
    const mergeBase = await runGit(dir, ['merge-base', lb, rb])
    if (!mergeBase.ok) {
      // merge-base 失败（历史无法对齐：被 force 推送或错接分支）→ 降级
      // 退出码 3，绝不自动覆盖（施工图 §5 阶段 2a）
      return {
        ok: false, code: 3,
        message: '历史无法对齐（可能被 force 推送或接错了分支）——已停止合并，本地记忆未受影响。请人工检查远端分支后重试',
        committed: false, conflicts: 0, stats: {},
      }
    }
    base = await readTreeFiles(dir, mergeBase.stdout.trim(), fileset)
    if (base.invalid.length > 0) {
      return { ok: false, code: 3, message: `历史数据格式异常（${base.invalid[0].path}：${base.invalid[0].reason}）——已停止合并，本地记忆未受影响。请人工检查后重试`, committed: false, conflicts: 0, stats: {} }
    }
  }

  // ── 阶段 2（锁内）：读工作树 → 合并 → 写回 → 双父提交 ──
  // CRLF 自愈计数（2026-08-11 Windows autocrlf 事故修复）：锁内记录、
  // 锁外拼进最终消息（锁外作用域读取）。
  let crlfNormalized = 0
  const merged = await asyncWithLock(dir, async () => {
    // 锁内重读 HEAD（Codex P1-4）：等待锁期间另一个 worker 可能已推进
    // HEAD——锁前快照会基于过期状态合并（base/parents 全错）。不一致则
    // 中止，用户重试（锁内不抛异常，finally 正常释放锁）。
    const headNow = await runGit(dir, ['rev-parse', '--verify', lb])
    const headBefore = headRef.ok ? headRef.stdout.trim() : null
    const headCurrent = headNow.ok ? headNow.stdout.trim() : null
    if (headBefore !== headCurrent) {
      return { fatal: '同步期间本地记忆被其他操作更新（HEAD 已变化）——请重试' }
    }
    // ours = 工作树（锁内读，避免读到 store 写一半的文件）
    // 格式预检（Codex P0-2）：本地非 canonical 文件绝不重写——备份后中止，
    // 写盘尚未发生，工作树零改动。**CRLF 自愈（2026-08-11 Windows autocrlf
    // 事故修复）**：\r\n→\n 无损转换后可往返的文件不再中止，自动归一化
    // （合并写回时以 LF 覆盖）；真·手工编辑/混合行尾仍按原逻辑备份中止。
    const ours = readWorkingMemoryFiles(dir, fileset)
    if (ours.invalid.length > 0) {
      for (const inv of ours.invalid) {
        try {
          copyFileSync(join(dir, inv.path), `${join(dir, inv.path)}.bak.${Date.now()}`)
        } catch { /* 备份失败不阻断中止 */ }
      }
      return { fatal: `本地记忆文件格式异常（${ours.invalid[0].path}：${ours.invalid[0].reason}）——已备份原文件并停止同步，请整理后重试` }
    }
    const crlfNormalizedInLock = ours.normalized.length
    if (crlfNormalizedInLock > 0) crlfNormalized = crlfNormalizedInLock
    const result = mergeEntries(base.files, ours.files, theirs.files)
    // 原子写回（tmp+rename，与 store.js write 同款）；TODO 文件带 header
    // 写回（P1-6：优先保留本机原 header，缺省用 TODO_HEADER 常量）
    for (const [path, entries] of Object.entries(result.files)) {
      const abs = join(dir, path)
      mkdirSync(join(dir, dirname2(path)), { recursive: true })
      const tmp = `${abs}.tmp.${process.pid}`
      const text = isTodoPath(path)
        ? serializeTodoEntries(entries, (existsSync(abs) ? extractTodoHeader(readFileSync(abs, 'utf8')) : undefined) ?? theirs.headers?.[path])
        : serializeEntries(entries)
      writeFileSync(tmp, text)
      renameSync(tmp, abs)
    }
    // 冲突侧车（Codex 二轮 P0-2 修复）：按 fileset 独立侧车——多轨共享
    // 同一 .git 时，无冲突轨的同步绝不能删掉其他轨的冲突记录（工作树
    // 清空 + 侧车丢失 = 数据永久丢）。有冲突写、无冲突删（删除随提交生效）
    const conflictsPath = join(dir, conflictsFileFor(fileset))
    if (result.conflicts.length > 0) {
      writeFileSync(conflictsPath, renderConflicts(result.conflicts))
    } else if (existsSync(conflictsPath)) {
      rmSync(conflictsPath, { force: true })
    }
    // 提交（Codex 二轮 P1-1 重写）：**用临时 GIT_INDEX_FILE 构建本 fileset
    // 的提交树**——多轨共享同一 .git，共享 index 永远只反映 HEAD（main 树），
    // 用它 stage/write-tree 会把其他轨文件带进提交树，且 diff --cached 与
    // HEAD 比较永远"dirty"、无变化也重复提交。临时 index 从空树起步、
    // 只加本 fileset 文件，tree 与 lb^{tree} 直接比较判定有无变化。
    const treeResult = await buildFilesetTree(dir, fileset)
    if (!treeResult.ok) return { ...result, committed: false, commitError: treeResult.error }
    const tree = treeResult.tree
    const lbTree = await runGit(dir, ['rev-parse', '--verify', `${lb}^{tree}`])
    const makeCommit = async (parents) => {
      const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
      const commit = await runGit(dir, ['commit-tree', ...parents, '-m', `memory: sync ${stamp} [merge]`, tree])
      if (!commit.ok) return { ok: false, error: 'commit-tree 失败' }
      const upd = await runGit(dir, ['update-ref', lb, commit.stdout.trim()])
      if (!upd.ok) return { ok: false, error: 'update-ref 失败' }
      // 提交用临时 index——把共享 index 重置到新提交树（单轨项目仓库
      // git status 恢复干净；全局仓库其他轨显示未跟踪属预期观感）
      await runGit(dir, ['reset', '-q', lb])
      return { ok: true }
    }
    if (lbTree.ok && lbTree.stdout.trim() === tree) {
      // 树相同（无内容变化）：远端是本地祖先 → 已收敛跳过；
      // 树相同但历史分叉（对端同树提交）→ 双父提交收敛（Codex P1-3）
      if (remoteMissing) return { ...result, committed: false }
      const isAncestor = await runGit(dir, ['merge-base', '--is-ancestor', rb, lb])
      if (isAncestor.ok) return { ...result, committed: false }
      const m = await makeCommit(['-p', lb, '-p', rb])
      if (!m.ok) return { ...result, committed: false, commitError: m.error }
      return { ...result, committed: true }
    }
    const parents = []
    if (headRef.ok) parents.push('-p', lb)
    // 首次推送场景（远端分支尚不存在）→ 单父提交（无 -p rb）
    if (!remoteMissing) parents.push('-p', rb)
    const c = await makeCommit(parents)
    if (!c.ok) return { ...result, committed: false, commitError: c.error }
    return { ...result, committed: true }
  })

  // 中止类结果（格式异常/HEAD 竞争）→ code 3 需人工处理
  if (merged.fatal) {
    return { ok: false, code: 3, message: merged.fatal, committed: false, conflicts: 0, stats: {} }
  }
  // conflicts 统一为计数（merged.conflicts 是合并器返回的数组）
  const conflictCount = Array.isArray(merged.conflicts) ? merged.conflicts.length : (merged.conflicts ?? 0)
  if (merged.commitError) {
    return { ok: false, code: 1, message: `合并完成但提交失败：${merged.commitError}。工作树已是合并结果，请重试`, committed: false, conflicts: conflictCount, stats: merged.stats }
  }

  // ── 阶段 3（锁外，仅 --push）：显式 refspec；non-ff 不 force ──
  // **冲突未解决禁止 push（Codex 二轮 P0-2）**：冲突条目不落工作树（只在
  // 侧车），push 会把缺条目的树推到远端、让对端数据永久缺失
  let pushed = false
  if (push && conflictCount > 0) {
    return {
      ok: false, code: 1,
      message: `还有 ${conflictCount} 条冲突未解决（${conflictsFileFor(fileset)}）——请先解决冲突再推送，否则远端会缺少冲突条目`,
      committed: merged.committed, conflicts: conflictCount, stats: merged.stats,
    }
  }
  if (push) {
    const pushResult = await runGit(dir, ['push', 'origin', `${lb}:refs/heads/${remoteBranch}`], { network: true })
    if (!pushResult.ok) {
      const err = pushResult.stderr.trim()
      if (/non-fast-forward|fetch first|rejected/i.test(err)) {
        return {
          ok: false, code: 1,
          message: '推送被拒绝：远端有新提交（non-fast-forward）。请先再点一次「同步」拉取合并后再推，绝不强制推送',
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
  if (conflictCount > 0) bits.push(`${conflictCount} 条冲突待处理（在冲突区解决）`)
  if (merged.stats.removed > 0) bits.push(`删除 ${merged.stats.removed} 条（可恢复）`)
  if (crlfNormalized > 0) bits.push(`已将 ${crlfNormalized} 个文件从 CRLF 归一化为 LF（Windows git 换行转换，内容无损）`)

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
export async function runStatus({ dir, remoteBranch, localBranch = 'main' }) {
  if (!existsSync(join(dir, '.git'))) {
    return { ok: true, message: '未初始化', status: { initialized: false } }
  }
  const rb = `refs/remotes/origin/${remoteBranch}`
  const lb = `refs/heads/${localBranch}`
  const headRef = await runGit(dir, ['rev-parse', '--verify', lb])
  const theirsRef = await runGit(dir, ['rev-parse', '--verify', rb])
  // 未提交变更数（工作树 vs HEAD；git status --porcelain 的行数）
  const dirty = await runGit(dir, ['status', '--porcelain'])
  const uncommitted = dirty.ok ? dirty.stdout.split('\n').filter((l) => l.trim() !== '').length : 0
  // 落后/领先提交数（与远端对齐程度）
  let behind = 0
  let ahead = 0
  if (headRef.ok && theirsRef.ok) {
    const b = await runGit(dir, ['rev-list', '--count', `${rb}..${lb}`])
    const a = await runGit(dir, ['rev-list', '--count', `${lb}..${rb}`])
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

/** 工作树记忆文件读取（锁内调用；按文件集展开，全局轨二期并入一期）。
 * TODO 格式文件（TODOS.md/TODOS-life.md/TODOS-work.md/daily/*.todo.md）用
 * 专用解析（剥 header）。
 * 返回 { files, invalid, normalized }——invalid 为格式预检失败清单
 * （Codex P0-2：真·手工编辑/混合行尾的文件 parse→serialize 不能往返，
 * 绝不能被重写破坏）；normalized 为 **CRLF 自愈**记录（2026-08-11
 * Windows autocrlf 事故：.gitattributes 修复前初始化的仓库，工作树被
 * Windows Git 默认 core.autocrlf=true 在 checkout 时把 LF 全转 CRLF——
 * `\r\n→\n` 是**无损**转换，转后 canonical 即放行，合并写回阶段自然以
 * LF 覆盖工作树；只有转后仍不能往返（手工编辑/混合行尾）才进 invalid）。 */
function readWorkingMemoryFiles(dir, fileset = 'project') {
  const files = {}
  const invalid = []
  const normalized = []
  const readMemory = (p, name) => {
    const text = readFileSync(p, 'utf8')
    if (isTodoPath(name)) {
      // TODO 自愈：CRLF → LF 后无孤立 \r 才放行（tag id/§ 切分依赖 LF）
      const lf = text.replace(/\r\n/g, '\n')
      if (text.includes('\r') && !lf.includes('\r')) {
        normalized.push({ path: name })
        files[name] = parseTodoEntries(lf)
        return
      }
      if (text.includes('\r')) invalid.push({ path: name, reason: 'TODO 文件含 CRLF（程序写盘不应出现）' })
      files[name] = parseTodoEntries(text)
    } else if (!isCanonical(text)) {
      const lf = text.replace(/\r\n/g, '\n')
      if (lf !== text && isCanonical(lf)) {
        // 纯 CRLF 污染（git autocrlf）→ 无损归一化，合并写回时以 LF 覆盖
        normalized.push({ path: name })
        files[name] = parseEntries(lf)
      } else {
        invalid.push({ path: name, reason: '记忆文件格式异常（CRLF/手工编辑，parse→serialize 不能往返）' })
        files[name] = parseEntries(text)
      }
    } else {
      files[name] = parseEntries(text)
    }
  }
  const { memory, todo } = resolveFilesetFiles(dir, fileset)
  for (const rel of [...memory, ...todo]) {
    const p = join(dir, rel)
    if (existsSync(p)) readMemory(p, rel)
  }
  return { files, invalid, normalized }
}

/** 路径的目录部分（兼容无目录的根级文件）。 */
function dirname2(path) {
  const i = path.lastIndexOf('/')
  return i < 0 ? '.' : path.slice(0, i)
}

/**
 * 用临时 GIT_INDEX_FILE 构建某文件集的提交树（Codex 二轮 P1-1 重写）。
 * 多轨共享同一 .git 时共享 index 永远只反映 HEAD（main 树）——用共享
 * index 提交会把其他轨文件带进提交树。这里从空树起步、只加本 fileset
 * 文件（含元数据），write-tree 得到纯净的本轨树；临时 index 用完即删。
 * @param {string} dir - 记忆仓库目录。
 * @param {string} fileset - 文件集。
 * @returns {Promise<{ok: boolean, tree?: string, error?: string}>}
 */
async function buildFilesetTree(dir, fileset, excludeFromMeta = []) {
  const indexFile = join(dir, '.git', `index.sync.${process.pid}.${Date.now()}`)
  const env = { GIT_INDEX_FILE: indexFile }
  try {
    const empty = await runGit(dir, ['read-tree', '--empty'], { env })
    if (!empty.ok) return { ok: false, error: `index 初始化失败：${empty.stderr.trim().split('\n')[0] ?? ''}` }
    const stage = await stagePaths(dir, fileset, env)
    if (!stage.ok) return { ok: false, error: `stage 失败：${stage.stderr.trim().split('\n')[0] ?? ''}` }
    // 稳定版复审 P0-6：resolve 提交时排除 CONFLICTS.md——新顺序下侧车在
    // 提交成功后才从磁盘移除，若让它进提交树，HEAD 会留下「已解决的冲突
    // 清单」幽灵文件（git status 永久 dirty、对端检出过期冲突）。
    // 仅从临时 index 移除（--cached），不影响磁盘侧车。
    if (excludeFromMeta.length > 0) {
      const exclude = await runGit(dir, ['rm', '--cached', '-f', '--ignore-unmatch', '--', ...excludeFromMeta], { env })
      if (!exclude.ok) return { ok: false, error: `排除 ${excludeFromMeta.join(',')} 失败：${exclude.stderr.trim().split('\n')[0] ?? ''}` }
    }
    const tree = await runGit(dir, ['write-tree'], { env })
    if (!tree.ok) return { ok: false, error: 'write-tree 失败' }
    return { ok: true, tree: tree.stdout.trim() }
  } finally {
    try { rmSync(indexFile, { force: true }) } catch { /* 清理失败不阻断 */ }
  }
}

/**
 * PROVENANCE 校验（施工图 §9 → Codex 终审 P0-1 严格化 → 2026-08-13
 * 稳定版复审 fail-closed 补全）：本地有合法 projectId 时，远端分支
 * 存在（非首次推送）就必须 PROVENANCE 存在、JSON 合法、projectId 精确
 * 相等——缺失/损坏一律拒绝（防把 A 项目记忆并进 B 项目；fail-open 已
 * 复现可串项目）。真·首次推送（远端分支尚不存在，remoteMissing=true）
 * 远端侧为空 → 放行（本地合法即可，推送时会把 PROVENANCE 带上）。
 * 两侧都无身份（老仓库零迁移场景）→ 放行，保持历史兼容。
 * @param {string} dir - the memory repo working dir.
 * @param {string} rb - remote branch ref (e.g. 'origin/main').
 * @param {boolean} remoteMissing - true when the remote branch does not
 *   exist at all (first-push scenario; caller derives it from fetch stderr).
 * @returns {{ok: boolean, message?: string}} the check outcome.
 */
function checkProvenance(dir, rb, remoteMissing = false) {
  const localPath = join(dir, 'PROVENANCE')
  let local = null
  if (existsSync(localPath)) {
    try {
      local = JSON.parse(readFileSync(localPath, 'utf8').trim())
    } catch { /* 本地损坏：视同缺失（下方按"本地合法才严格"处理） */ }
  }
  // 远端 PROVENANCE 从对象库读（不依赖工作树）
  let remote = null
  let remoteReadable = false
  try {
    const raw = runGitSync(dir, ['show', `${rb}:PROVENANCE`])
    if (raw !== null) {
      remoteReadable = true
      remote = JSON.parse(raw.trim())
    }
  } catch { /* 远端无 PROVENANCE 或损坏 */ }
  // 真·首次推送：远端为空，无需远端身份（本地身份随推送带上去）
  if (remoteMissing) return { ok: true }
  // 本地有合法身份 + 远端分支存在 → 严格匹配（fail-closed）：
  // 分支存在但 PROVENANCE 缺失 / 空 / 坏 JSON / projectId 不匹配 → 拒绝。
  if (local && typeof local.projectId === 'string') {
    if (!remoteReadable || remote === null || typeof remote.projectId !== 'string' || remote.projectId !== local.projectId) {
      return { ok: false, message: `远端记忆身份缺失或不匹配（本地项目 ${local.projectId}）。疑似远端分支被篡改或接错——已拒绝合并。请检查后重试` }
    }
    return { ok: true }
  }
  // 本地无身份（老仓库零迁移）：远端存在时无从核对，保持历史兼容放行
  return { ok: true }
}

/**
 * 渲染 CONFLICTS.md（编号=顺序号，resolve 的稳定标识）。
 * **多行无损（Codex 终审 P0-3 修复）**：base/ours/theirs 是任意多行正文
 * （记忆/TODO 条目都允许多行，正文可能含 `- `、`## ` 等 Markdown 结构），
 * 直接拼行会截断且结构错乱（已复现三行内容解析后只剩首行、写回丢数据）。
 * 改为 `JSON.stringify(原文)` 单行编码——换行/结构全部转义，单行无损；
 * 解析端 JSON.parse 还原（失败回退原文，兼容老格式侧车）。
 */
export function renderConflicts(conflicts) {
  const enc = (v) => (v === null ? '（无）' : JSON.stringify(v))
  // entryKey 显示名（Kimi P1-11）：无 id 条目的 key 是整条文本（可含换行），
  // 直接进 `## N. <key>` 会破坏解析——压平并截断为单行显示名（resolve 按
  // 编号定位，显示名无需可逆）
  const displayKey = (k) => String(k ?? '?').replace(/\s+/g, ' ').slice(0, 40)
  const lines = ['# 记忆同步冲突', '']
  conflicts.forEach((c, i) => {
    lines.push(`## ${i + 1}. ${displayKey(c.entryKey)}（文件：${c.file}）`)
    lines.push(`- 原因：${c.reason}`)
    lines.push(`- base：${enc(c.base)}`)
    lines.push(`- ours：${enc(c.ours)}`)
    lines.push(`- theirs：${enc(c.theirs)}`)
    lines.push('')
  })
  return lines.join('\n')
}

/** 解析 CONFLICTS.md 的冲突数（# N. 条目数）。 */
/** 解析 CONFLICTS 侧车的冲突数（# N. 条目数；按 fileset 独立侧车）。 */
export function countConflicts(dir, fileset = 'project') {
  const p = join(dir, conflictsFileFor(fileset))
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

/** 递归清理 git ref 锁残留（断电中断恢复用）。返回清理数。
 * 含 refs/heads/main.lock（Kimi P1-2：commit-tree 后被杀会残留主分支锁，
 * 不清则 update-ref 每次失败）与 packed-refs.lock。 */
function cleanRefLocks(dir, remoteBranch) {
  let count = 0
  const originDir = join(dir, '.git', 'refs', 'remotes', 'origin')
  const targets = [join(originDir, `${remoteBranch}.lock`), join(dir, '.git', 'packed-refs.lock'), join(dir, '.git', 'refs', 'heads', 'main.lock')]
  // 层级目录锁：refs/remotes/origin/dsh-shared/.lock（创建目录时的锁）
  const parts = remoteBranch.split('/')
  let acc = originDir
  for (let i = 0; i < parts.length - 1; i++) {
    acc = join(acc, parts[i])
    targets.push(`${acc}.lock`)
  }
  for (const t of targets) {
    try {
      if (existsSync(t)) {
        rmSync(t, { force: true })
        count += 1
      }
    } catch { /* 单个清理失败不阻断 */ }
  }
  return count
}

/* ---------------- conflict resolve（施工图 §7 第 7 步） ---------------- */

/**
 * 解析 CONFLICTS.md → 冲突条目列表（编号=文件中的顺序，1 起，稳定标识）。
 * @param {string} text - CONFLICTS.md 全文。
 * @returns {Array<{index: number, entryKey: string, file: string, reason: string,
 *   base: string | null, ours: string | null, theirs: string | null}>}
 */
export function parseConflicts(text) {
  // 多行无损解码（Codex P0-3）：base/ours/theirs 是 JSON.stringify 单行编码；
  // JSON.parse 失败 = 老格式侧车（未编码原文）→ 原样返回
  const dec = (raw) => {
    if (raw === '（无）') return null
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'string' ? parsed : raw
    } catch {
      return raw
    }
  }
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
      else if (r[1] === 'base') item.base = dec(r[2])
      else if (r[1] === 'ours') item.ours = dec(r[2])
      else if (r[1] === 'theirs') item.theirs = dec(r[2])
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
export async function resolveConflict(p) {
  // 仓库级同步操作锁（Codex P1-7）：与 runSync 串行化（动同一 index/ref）
  return asyncSyncLock(p.dir, () => resolveConflictInner(p))
}

async function resolveConflictInner({ dir, index, choice, fileset = 'project', localBranch = 'main' }) {
  // 侧车按 fileset 独立（Codex 二轮 P0-2）
  const path = join(dir, conflictsFileFor(fileset))
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
  // 侧车路径白名单校验（Grok P2-5）：侧车的 file 字段只能指向本 fileset
  // 的同步记忆文件（Codex 二轮 P0-2：按 fileset 校验）——防手工/异常侧车
  // 写穿到任意路径
  if (!isMemoryFile(target.file, fileset)) {
    return { ok: false, message: `冲突 ${index} 的目标文件不在同步白名单内（${target.file}）——已拒绝写入` }
  }

  return asyncWithLock(dir, async () => {
    // ── 1. 写回目标文件（锁内；文件可能不存在如 logs/xxx.md → 建目录）──
    // 幂等写回（稳定版复审 P0-6）：目标条目已存在于目标文件时跳过写入。
    // 旧实现「写回→删侧车→git 提交」在 git 失败时留下「已写未提交、侧车
    // 已删」的半完成态：重试报"没有待处理冲突"但工作树改动未提交；且重试
    // 会再把同一条目写一遍（重复数据）。现在 git 失败时侧车保留、写回
    // 幂等，重试安全。
    // TODO 文件用专用解析/序列化（P1-6：优先保留本机原 header）
    const abs = join(dir, target.file)
    mkdirSync(join(dir, dirname2(target.file)), { recursive: true })
    const isTodo = isTodoPath(target.file)
    const existingEntries = existsSync(abs)
      ? (isTodo ? parseTodoEntries(readFileSync(abs, 'utf8')) : parseEntries(readFileSync(abs, 'utf8')))
      : []
    // 本次要写入的候选：both = ours + theirs（theirs 换新随机 ID）；否则单侧
    const candidates = choice === 'both'
      ? [target.ours, target.theirs].filter((v) => v !== null)
      : [target[choice]]
    // 判重：有身份证的按 id 相等（跨设备锚点），无 id 退化为整条文本相等。
    // both 场景 theirs 用原文判重——重试时目标文件里是换过新 id 的副本，
    // 原文（内容）匹配也能命中，不会重复追加。
    const sameEntry = (a, b) => {
      const idA = isTodo ? extractTodoId(a) : extractEntryId(a)
      const idB = isTodo ? extractTodoId(b) : extractEntryId(b)
      if (idA !== null && idB !== null) return idA === idB
      return a === b
    }
    const toWrite = candidates.filter((cand) => !existingEntries.some((e) => sameEntry(e, cand)))
    if (toWrite.length > 0) {
      const entries = [
        ...existingEntries,
        ...toWrite.map((cand) => (choice === 'both' && cand === target.theirs ? stripIdToNew(cand, isTodo) : cand)),
      ]
      const tmp = `${abs}.tmp.${process.pid}`
      const text = isTodo
        ? serializeTodoEntries(entries, existsSync(abs) ? extractTodoHeader(readFileSync(abs, 'utf8')) : undefined)
        : serializeEntries(entries)
      writeFileSync(tmp, text)
      renameSync(tmp, abs)
    }

    // ── 2. 提交（临时 index 构建本轨树 + commit-tree；index 永不
    //    unmerged）── **每步检查（Codex P0-4 / Kimi P1-10）：git 写入失败
    //    必须如实报错，绝不假报"已解决并提交"。CONFLICTS.md 排除在提交树
    //    外（P0-6：侧车提交后才删，不能留下幽灵文件）**
    const treeResult = await buildFilesetTree(dir, fileset, ['CONFLICTS.md'])
    if (!treeResult.ok) return { ok: false, message: `解决冲突时 ${treeResult.error}（目标条目已写回，可重试）` }
    const lb = `refs/heads/${localBranch}`
    const headRef = await runGit(dir, ['rev-parse', '--verify', lb])
    const parents = headRef.ok ? ['-p', lb] : []
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const commit = await runGit(dir, ['commit-tree', ...parents, '-m', `memory: resolve conflict #${index} (${choice}) ${stamp}`, treeResult.tree])
    if (!commit.ok) return { ok: false, message: `解决冲突时 commit-tree 失败：${commit.stderr.trim().split('\n')[0] ?? ''}（目标条目已写回且写回幂等，可直接重试）` }
    const upd = await runGit(dir, ['update-ref', lb, commit.stdout.trim()])
    if (!upd.ok) return { ok: false, message: `解决冲突时 update-ref 失败：${upd.stderr.trim().split('\n')[0] ?? ''}。提交已生成但 ref 未更新——侧车仍在，写回幂等，请重试` }

    // ── 3. 提交成功后才移除侧车条目（稳定版复审 P0-6）：git 失败时侧车
    //    保留（重试继续有冲突可解）；清空则删文件（原子写，Kimi P2-3）──
    const remaining = conflicts.filter((c) => c.index !== index)
    if (remaining.length === 0) {
      rmSync(path, { force: true })
    } else {
      // 重建文件：编号重新从 1 起（稳定标识=新顺序）
      const tmpConflicts = `${path}.tmp.${process.pid}`
      writeFileSync(tmpConflicts, renderConflicts(remaining.map(({ entryKey, file, base, ours, theirs, reason }) => ({ entryKey, file, base, ours, theirs, reason }))))
      renameSync(tmpConflicts, path)
    }

    // ── 4. 共享 index 重置到新提交树（单轨项目仓库 git status 恢复干净）──
    // reset 失败不影响已提交结果（ref 已更新），下次同步会自然对齐
    await runGit(dir, ['reset', '-q', lb])
    return { ok: true, message: `已解决冲突 #${index}（${choice}）并提交`, remaining: remaining.length }
  })
}

/** 换掉条目的身份证（both 场景：theirs 版换新 ID 后与 ours 并存）。
 * isTodo 显式传参（Codex P1-9 / Kimi P2-4）：TODO 条目换 tag 行内
 * `[id: xxxx]`（带空格），记忆条目换行首 `[id:xxxx]`——由调用方的文件
 * 类型决定正则，不再按正文内容猜格式（正文里出现 `[id: xxxx]` 字样不会
 * 误判；同 id 不能并存，联合索引唯一性约束）。 */
function stripIdToNew(entry, isTodo) {
  if (entry === null) return null
  if (isTodo) return entry.replace(TODO_ID_RE, `[id: ${genEntryId()}]`)
  return entry.replace(/^\[id:[0-9a-f]{8}\]\s*/, `[id:${genEntryId()}] `)
}
