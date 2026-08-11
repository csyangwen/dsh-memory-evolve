#!/usr/bin/env node
/**
 * scripts/sync-worker.mjs — sync-worker 可执行入口（施工图 §3/§5）
 *
 * 用法：
 *   node scripts/sync-worker.mjs sync <dir> <remoteBranch> [--push]
 *   node scripts/sync-worker.mjs status <dir> <remoteBranch>
 *
 * 被主进程工具 execute 异步 spawn（绝不 spawnSync）；未来 pre-push hook
 * 复用同一入口（二期）。stdout 输出单行 JSON：
 *   { ok, code, message, committed, conflicts, stats }（status 为 status 字段）
 * 退出码：0=成功 / 1=可恢复错误 / 3=需人工干预（merge-base 失败、身份不匹配）。
 */

import { runStatus, runSync } from '../lib/sync/worker.js'

const [, , sub, dir, remoteBranch, ...rest] = process.argv
const push = rest.includes('--push')

async function main() {
  if (sub !== 'sync' && sub !== 'status') {
    process.stdout.write(JSON.stringify({ ok: false, code: 1, message: '用法：sync-worker.mjs sync <dir> <remoteBranch> [--push] | status <dir> <remoteBranch>' }) + '\n')
    process.exitCode = 1
    return
  }
  if (!dir || !remoteBranch) {
    process.stdout.write(JSON.stringify({ ok: false, code: 1, message: '缺少参数：需要 <dir> 与 <remoteBranch>' }) + '\n')
    process.exitCode = 1
    return
  }
  try {
    const result = sub === 'sync'
      ? await runSync({ dir, remoteBranch, push })
      : await runStatus({ dir, remoteBranch })
    process.stdout.write(JSON.stringify(result) + '\n')
    process.exitCode = result.code ?? (result.ok ? 0 : 1)
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: 1, message: `worker 异常：${error?.message ?? String(error)}` }) + '\n')
    process.exitCode = 1
  }
}

main()
