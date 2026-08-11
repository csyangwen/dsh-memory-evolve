#!/usr/bin/env node
/**
 * scripts/sync-worker.mjs — sync-worker 可执行入口（施工图 §3/§5）
 *
 * 用法：
 *   node scripts/sync-worker.mjs sync <dir> <remoteBranch> [--push]
 *   node scripts/sync-worker.mjs status <dir> <remoteBranch>
 *   node scripts/sync-worker.mjs decide <dir> <url> <projectId>
 *
 * 被主进程工具 execute 异步 spawn（绝不 spawnSync）；未来 pre-push hook
 * 复用同一入口（二期）。stdout 输出单行 JSON：
 *   { ok, code, message, committed, conflicts, stats }（status 为 status 字段；
 *   decide 为 { ok, kind, branch, message }——共享记忆仓库分支决策）
 * 退出码：0=成功 / 1=可恢复错误 / 3=需人工干预（merge-base 失败、身份不匹配）。
 */

import { runStatus, runSync } from '../lib/sync/worker.js'
import { decideModeBBranch } from '../lib/sync/repo.js'

const [, , sub, dir, arg3, ...rest] = process.argv
const push = rest.includes('--push')

async function main() {
  if (sub === 'decide') {
    // 共享记忆仓库分支决策（模式 B，2026-08-11 拍板）：一个私有仓库装
    // 所有项目的记忆，本项目用专属分支 dsh-shared/<projectId>；老单项目
    // 仓库（main）自动识别兼容。网络命令在子进程执行，主进程零阻塞。
    const url = arg3
    const projectId = rest[0]
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
  if (sub !== 'sync' && sub !== 'status') {
    process.stdout.write(JSON.stringify({ ok: false, code: 1, message: '用法：sync-worker.mjs sync <dir> <remoteBranch> [--push] | status <dir> <remoteBranch> | decide <dir> <url> <projectId>' }) + '\n')
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
      ? await runSync({ dir, remoteBranch: arg3, push })
      : await runStatus({ dir, remoteBranch: arg3 })
    process.stdout.write(JSON.stringify(result) + '\n')
    process.exitCode = result.code ?? (result.ok ? 0 : 1)
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: 1, message: `worker 异常：${error?.message ?? String(error)}` }) + '\n')
    process.exitCode = 1
  }
}

main()
