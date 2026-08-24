#!/usr/bin/env node
/**
 * scripts/sync-worker.mjs — sync-worker 可执行入口（施工图 §3/§5）
 *
 * 用法：
 *   node scripts/sync-worker.mjs sync <dir> <remoteBranch> [fileset] [localBranch] [--push]
 *   node scripts/sync-worker.mjs status <dir> <remoteBranch>
 *   node scripts/sync-worker.mjs decide <dir> <url> <projectId>
 *   node scripts/sync-worker.mjs global-init <dir> <url>
 *
 * 被主进程工具 execute 异步 spawn（绝不 spawnSync）；未来 pre-push hook
 * 复用同一入口（二期）。stdout 输出单行 JSON：
 *   { ok, code, message, committed, conflicts, stats }（status 为 status 字段；
 *   decide 为 { ok, kind, branch, message }——记忆远端分支决策）
 * 退出码：0=成功 / 1=可恢复错误 / 3=需人工干预（merge-base 失败、身份不匹配）。
 * fileset：project（缺省）/ memory-global / user-global / daily-global /
 * todo-global（全局轨二期并入一期，2026-08-11 用户拍板：开关做好功能必须实现）。
 */

import { runStatus, runSync } from '../lib/sync/worker.js'
import { setLocale, resolveLocale } from '../lib/i18n.js'

// Inherit the spawning host's language (spawnWorker passes DSH_LOCALE).
setLocale(resolveLocale(undefined))
import { decideModeBBranch, ensureGlobalRepo } from '../lib/sync/repo.js'

const [, , sub, dir, arg3, ...rest] = process.argv
const push = rest.includes('--push')
const restArgs = rest.filter((a) => a !== '--push')

async function main() {
  if (sub === 'decide') {
    // 记忆远端分支决策（统一单一模式）：候选 dsh-shared/<id> → 老分支，
    // 老单项目仓库（main）自动识别兼容。网络命令在子进程执行，主进程零阻塞。
    const url = arg3
    const projectId = restArgs[0]
    if (!dir || !url || !projectId) {
      process.stdout.write(JSON.stringify({ ok: false, kind: 'error', branch: null, code: 1, message: '用法：sync-worker.mjs decide <dir> <url> <projectId>' }) + '\n')
      process.exitCode = 1
      return
    }
    const result = await decideModeBBranch({ dir, remoteUrl: url, projectId })
    process.stdout.write(JSON.stringify(result) + '\n')
    process.exitCode = result.ok ? 0 : 1
    return
  }
  if (sub === 'global-init') {
    // 全局记忆仓库初始化（全局轨，仅共享记忆仓库可用）：
    // 记忆根目录建 .git + deny-all 白名单 + PROVENANCE + 补发 + 首次提交
    const url = arg3
    if (!dir || !url) {
      process.stdout.write(JSON.stringify({ ok: false, code: 1, message: '用法：sync-worker.mjs global-init <dir> <url>' }) + '\n')
      process.exitCode = 1
      return
    }
    const result = await ensureGlobalRepo({ dir, url })
    process.stdout.write(JSON.stringify(result) + '\n')
    process.exitCode = result.ok ? 0 : 1
    return
  }
  if (sub !== 'sync' && sub !== 'status') {
    process.stdout.write(JSON.stringify({ ok: false, code: 1, message: '用法：sync-worker.mjs sync <dir> <remoteBranch> [fileset] [localBranch] [--push] | status <dir> <remoteBranch> | decide <dir> <url> <projectId> | global-init <dir> <url>' }) + '\n')
    process.exitCode = 1
    return
  }
  if (!dir || !arg3) {
    process.stdout.write(JSON.stringify({ ok: false, code: 1, message: '缺少参数：需要 <dir> 与 <remoteBranch>' }) + '\n')
    process.exitCode = 1
    return
  }
  try {
    const result = sub === 'sync'
      ? await runSync({ dir, remoteBranch: arg3, push, fileset: restArgs[0] ?? 'project', localBranch: restArgs[1] ?? 'main' })
      : await runStatus({ dir, remoteBranch: arg3 })
    process.stdout.write(JSON.stringify(result) + '\n')
    process.exitCode = result.code ?? (result.ok ? 0 : 1)
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: 1, message: `worker 异常：${error?.message ?? String(error)}` }) + '\n')
    process.exitCode = 1
  }
}

main()
