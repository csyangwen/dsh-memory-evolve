// es-query.ps1 真机集成测试（2026-10-16）——Everything IPC 查询脚本端到端。
// Everything 未运行时 exit 2 → skip（跳过式：本测试验证「通道可用时的正确性」，
// 不可用场景由 search-docs 的 provider 降级链与 5s 冷却兜底）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'es-query.ps1')

test('es-query.ps1: IPC 查询已知存在的文件（真机）', () => {
  const run = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Query', 'Everything.exe', '-Max', '10', '-TimeoutMs', '4000',
  ], { encoding: 'utf8', timeout: 20000 })
  if (run.error?.code === 'EPERM') {
    test.skip('沙箱拦截 node spawn（EPERM）；生产宿主进程无此限制')
    return
  }
  if (run.status === 2) {
    test.skip('Everything 未运行（exit 2），跳过真机断言')
    return
  }
  assert.equal(run.status, 0, `exit=${run.status} stderr=${run.stderr}`)
  // 本机装有 Everything：必命中主程序自身
  assert.match(run.stdout, /Everything\.exe/i)
}).timeout(30000)

test('es-query.ps1: 查询随包脚本自身（USN 实时收录验证）', () => {
  const run = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Query', 'es-query.ps1', '-Max', '10', '-TimeoutMs', '4000',
  ], { encoding: 'utf8', timeout: 20000 })
  if (run.error?.code === 'EPERM') {
    test.skip('沙箱拦截 node spawn（EPERM）；生产宿主进程无此限制')
    return
  }
  if (run.status === 2) {
    test.skip('Everything 未运行（exit 2），跳过真机断言')
    return
  }
  assert.equal(run.status, 0, `exit=${run.status} stderr=${run.stderr}`)
  // 刚写入的文件也必须被 USN Journal 增量立刻收录——这正是复用 Everything
  // 的核心收益（免维护索引，实时性由 USN 保证）
  assert.match(run.stdout, /es-query\.ps1/i)
}).timeout(30000)
