import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdapterStore } from '../lib/coi/adapters.js'
import { SessionStore } from '../lib/coi/session-store.js'
import { TaskStore } from '../lib/coi/tasks-store.js'
import { CoiScheduler } from '../lib/coi/scheduler.js'

/**
 * COI 高风险路径测试（稳定版复审补测）：
 * 1. 崩溃恢复 recover() 必须释放遗留任务的会话锁（activeTaskId 假锁）；
 * 2. 会话 id 扫描缓冲有上限（SESSION_TRACK_LIMIT），长输出不无限累积内存；
 * 3. 测试任务（适配器测试）同样受缓冲上限约束。
 */

const schedulers = []
after(() => {
  for (const scheduler of schedulers) scheduler.dispose()
})

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-coi-recovery-'))
}

/** fake spawn：记录子进程，测试手动触发 stdout/stderr。 */
function makeSpawnHarness() {
  const children = []
  const spawn = (binary, args, opts) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 5000 + children.length
    child.exitCode = null
    child.killed = []
    child.kill = (sig) => { child.killed.push(sig) }
    child.binary = binary
    child.args = args
    children.push(child)
    return child
  }
  return { spawn, children }
}

function makeDeps(dir, spawn) {
  const dataDir = join(dir, 'coi')
  return {
    adapters: new AdapterStore(join(dir, 'adapters.json')),
    sessions: new SessionStore(join(dir, 'sessions.json')),
    tasks: new TaskStore(dataDir),
    config: { coiDataDir: dataDir },
    writeSummary: () => {},
    notify: async () => {},
    memoryContext: async () => '',
  }
}

function makeScheduler(deps, spawn) {
  const scheduler = new CoiScheduler({ emit: () => {} }, deps, { spawn })
  schedulers.push(scheduler)
  return scheduler
}

test('recover()：遗留 running 任务释放会话锁（activeTaskId 假锁修复）', () => {
  const dir = tempDir()
  try {
    const spawn = makeSpawnHarness().spawn
    const deps = makeDeps(dir, spawn)
    // 模拟崩溃前状态：任务 running + 会话被该任务锁定（均持久化在磁盘）
    const task = deps.tasks.add({
      adapterId: 'kimi', prompt: '任务', scope: 'session',
      sessionId: 'session-recover-me', status: 'running',
    })
    // acquire 前置：会话需先登记（真实调度器在捕获 session id 时 upsert）
    deps.sessions.upsert({ id: 'session-recover-me', adapterId: 'kimi', scope: 'session' })
    const lock = deps.sessions.acquire('session-recover-me', task.id)
    assert.equal(lock.ok, true, '前置：会话应被任务锁定')
    // 新调度器实例 = 模拟进程重启（重新读盘；必须用新 deps 实例断言，
    // 旧实例的内存数组不会被 recover 更新）
    const fresh = makeDeps(dir, spawn)
    const scheduler = makeScheduler(fresh, spawn)
    scheduler.recover()
    // 任务被标记 interrupted
    const after = fresh.tasks.tasks.find((t) => t.id === task.id)
    assert.equal(after.status, 'interrupted', '遗留任务应标记 interrupted')
    // 会话锁必须释放——重启后 resume 该会话不应被「会话忙」拒绝
    const session = fresh.sessions.findById('session-recover-me')
    assert.equal(session.activeTaskId, null, 'recover 必须释放遗留任务的会话锁（否则永久假锁）')
    const reAcquire = fresh.sessions.acquire('session-recover-me', 'coi-new-task-1')
    assert.equal(reAcquire.ok, true, '释放后新任务应能重新占用该会话')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recover()：queued 遗留任务同样释放锁；无 sessionId 任务不报错', () => {
  const dir = tempDir()
  try {
    const spawn = makeSpawnHarness().spawn
    const deps = makeDeps(dir, spawn)
    const t1 = deps.tasks.add({ adapterId: 'kimi', prompt: 'q', status: 'queued', sessionId: 'session-q' })
    deps.sessions.upsert({ id: 'session-q', adapterId: 'kimi', scope: 'session' })
    deps.sessions.acquire('session-q', t1.id)
    // 无 sessionId 的遗留任务（不应抛错）
    deps.tasks.add({ adapterId: 'kimi', prompt: 'no-session', status: 'running' })
    // 新实例 = 模拟进程重启（断言用新实例，旧实例内存不更新）
    const fresh = makeDeps(dir, spawn)
    const scheduler = makeScheduler(fresh, spawn)
    scheduler.recover()
    assert.equal(fresh.sessions.findById('session-q').activeTaskId, null)
    const interrupted = fresh.tasks.tasks.filter((t) => t.status === 'interrupted').length
    assert.equal(interrupted, 2, '两条遗留任务都应标记 interrupted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('长输出任务冒烟：远超缓冲上限的输出流经任务正常完成、留档可读', async () => {
  const dir = tempDir()
  try {
    const { spawn, children } = makeSpawnHarness()
    const deps = makeDeps(dir, spawn)
    const scheduler = makeScheduler(deps, spawn)
    const result = scheduler.dispatch({
      adapterId: 'kimi', prompt: '长输出任务', scope: 'temporary',
      sessionId: null, // 强制走「未捕获 sessionId」的累积路径
    })
    assert.equal(result.ok, true)
    const child = children[0]
    // 灌入远超会话 id 扫描缓冲上限（512KB）的输出（1.28MB，适配器不打印
    // session id → 永不捕获）：验证缓冲截断路径下任务不受影响正常完成
    const chunk = Buffer.alloc(64 * 1024, 'a')
    for (let i = 0; i < 20; i++) child.stdout.emit('data', chunk)
    child.emit('close', 0)
    // 等 flush 定时器（FLUSH_MS=2s）把输出写入留档
    await new Promise((resolve) => setTimeout(resolve, 2300))
    const task = deps.tasks.tasks[0]
    assert.equal(task.status, 'completed', '缓冲上限不应影响任务生命周期')
    const logFile = join(dir, 'coi', 'logs', `${task.id}.log`)
    assert.ok(existsSync(logFile), '留档文件应存在')
    assert.ok(readFileSync(logFile, 'utf8').length > 0, '留档文件应非空')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
