// 锁健壮性回归（2026-09-24 审计批次 1 · E⑦⑧）。
//
// ⑦ ArchiveStore.removeExact 此前锁 this.dir（记忆根），key 归档在
// projects/<id>/ 下时与 append/remove 的锁不同目录——跨进程互斥失效，
// tmp+rename 覆盖式写会丢更新。三方法锁目录必须同源。
// ⑧ isStaleLock 只凭 pid 探活：持锁进程崩溃后 PID 被 Windows 复用 →
// 探活成功 → 残锁永活 → 写路径跨重启全灭。修复=锁龄硬上限双条件 +
// 超时错误带锁路径。
// 直跑：node tests/lock-robustness.test.js。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isStaleLock, ArchiveStore, MemoryStore } from '../lib/store.js'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'

test('⑧a isStaleLock：pid 存活但锁龄超硬上限 → stale（PID 复用场景）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lock-test-'))
  try {
    const lockPath = join(dir, '.memory.lock')
    // 本进程（pid 一定存活）持锁 + mtime 拨回 120 秒前
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() - 120_000 }))
    const old = new Date(Date.now() - 120_000)
    utimesSync(lockPath, old, old)
    assert.equal(isStaleLock(lockPath), true, '锁龄 120s > 60s 硬上限必须判 stale（即使 pid 活着）')
    // 锁龄新鲜 + pid 存活 → 有效
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }))
    assert.equal(isStaleLock(lockPath), false, '新鲜锁 + pid 存活 → 有效')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑧b isStaleLock：pid 已死 → stale（原语义保持）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lock-test-'))
  try {
    const lockPath = join(dir, '.memory.lock')
    // PID 4194303：Windows 上几乎不可能存活的巨大 PID
    writeFileSync(lockPath, JSON.stringify({ pid: 4194303, at: Date.now() }))
    assert.equal(isStaleLock(lockPath), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑦ ArchiveStore 三个写方法锁目录同源（key 归档 = 项目目录）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lock-test-'))
  try {
    // 静态契约：类体内不得再出现「锁记忆根」形态；每个写方法的锁目录
    // 都经 dirname(this.fileOf(...)) 计算（append 内联、remove/removeExact
    // 经局部 lockDir 变量——三处各出现一次）。
    const src = readFileSync(join(import.meta.dirname, '..', 'lib', 'store.js'), 'utf8')
    const classStart = src.indexOf('class ArchiveStore')
    const classBody = src.slice(classStart, src.indexOf('\n}', classStart))
    assert.equal((classBody.match(/withLock\(this\.dir/g) ?? []).length, 0,
      'ArchiveStore 任何写方法不得锁记忆根（key 归档互斥失效，审计 P1-4）')
    assert.equal((classBody.match(/dirname\(this\.fileOf\(/g) ?? []).length, 3,
      'append/remove/removeExact 三方法的锁目录都必须来自 fileOf 所在目录')
    // 行为验证：key 归档 removeExact 正常工作（锁在项目目录上）
    const archive = new ArchiveStore(dir)
    const cwdDir = mkdtempSync(join(tmpdir(), 'dsh-lock-cwd-'))
    const raw = '[2026-09-24] [salience:2] 归档锁测试条目'
    archive.append('key', raw, cwdDir)
    const r = archive.removeExact('key', '[2026-09-24] 归档锁测试条目', cwdDir)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(archive.entriesOf('key', cwdDir).length, 0)
    rmSync(cwdDir, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑧c 超时错误信息含锁路径（静态契约）', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'lib', 'store.js'), 'utf8')
  assert.match(src, /timed out waiting for the memory lock \(\$\{lockPath\}\)/,
    '超时错误必须带 lockPath（排障可操作）')
})
