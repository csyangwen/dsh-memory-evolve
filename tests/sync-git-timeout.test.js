/**
 * tests/sync-git-timeout.test.js — `runGit()` 超时必须真的让 Promise settle
 * （issue #69）
 *
 * 缺陷：超时回调只 `child.kill('SIGKILL')` 直接子进程，而 `resolve()` 只挂在
 * `'close'` 上。`git ls-remote` / `git fetch` 会再派生 `git-remote-https`，它
 * **继承并持有** stdout/stderr 管道写端；Node 的 `'close'` 要等所有 stdio 句柄
 * 关闭才触发，于是 Promise 永不 settle。实测（TEST-NET-1 不可路由地址）父进程
 * 名义上被 SIGKILL 了，却要等孙进程自己放弃才返回，耗时 126 秒；慢速 / 半开连接
 * 可能永不返回——同步在 systemd user timer 下周期运行，一次挂死就让调用方永远
 * 拿不到失败原因，`node --test` 也会整片挂住。
 *
 * 本文件分两层：
 *   1. **确定性单元测试（主守卫）**：注入假 spawn + 永不 emit `'close'` 的假
 *      子进程（等价于"孙进程占着管道"），用 `mock.timers` 推进真实阈值，断言
 *      「到点必须 settle」「迟到的 close 不得翻案」「管道被 destroy」。
 *   2. **进程组终止（POSIX 专属）**：真实 detached 子进程 + 真实孙进程，验证
 *      `kill(-pid)` 把整棵树清掉。Windows 没有进程组信号（也没有 SIGKILL 语义），
 *      该用例跳过——Windows 上的保证是"调用方不再被拖住"，孙进程可能活到它
 *      自己超时。
 */
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { NETWORK_TIMEOUT_MS, LOCAL_TIMEOUT_MS, runGit } from '../lib/sync/repo.js'

/**
 * 假子进程：**永不** emit `'close'`，模拟「孙进程持有管道写端 → close 不触发」。
 * `pid` 缺省 undefined → `killGitTree()` 走 `child.kill()` 分支（不触碰真实
 * 进程组，避免测试误杀同机上的其它进程）。
 */
class StuckChild extends EventEmitter {
  constructor(pid) {
    super()
    this.pid = pid
    this.stdout = new Readable({ read() {} })
    this.stderr = new Readable({ read() {} })
    /** 收到的信号序列（断言 kill 真的被调用）。 */
    this.signals = []
  }

  kill(signal) {
    this.signals.push(signal)
    return true
  }
}

/** 让微任务队列跑空（假定时器 tick 之后用）。 */
async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

/** 让宏任务也跑一轮（流式 data 投递要走 setImmediate；本文件只 mock setTimeout）。 */
async function flushMacro() {
  await new Promise((resolve) => setImmediate(resolve))
}

/**
 * 等 Promise settle，但**不让回归退化成挂死**：`setTimeout` 已被 mock，这里用
 * `setImmediate` + `Date.now()` 轮询（两者都没被 mock）。到点仍未 settle 就抛一条
 * 明确的断言失败——旧实现下正是"永不 settle"，直接 `await` 会让测试进程挂住
 * 而不是报错。
 * @param {Promise<object>} pending - 待观察的 runGit 调用。
 * @param {number} [budgetMs] - 允许的真实时间预算。
 * @returns {Promise<object>} settle 后的结果。
 */
async function expectSettled(pending, budgetMs = 3000) {
  let settled = false
  let value
  const tracked = pending.then((result) => { settled = true; value = result })
  const started = Date.now()
  while (!settled && Date.now() - started < budgetMs) await flushMacro()
  assert.equal(settled, true, `runGit 的 Promise 在 ${budgetMs}ms 内没有 settle（超时回调未落定 → issue #69 回归）`)
  await tracked
  return value
}

test('runGit：网络命令到点即 settle（不再等 close），结果为超时失败', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const child = new StuckChild()
    const call = runGit('/nonexistent', ['ls-remote', 'https://192.0.2.1/x.git'], {
      network: true,
      spawnFn: () => child,
    })
    // 旁路观察"是否已落定"——注意不要用 .then() 链去 expectSettled（那会把
    // 结果值吃掉变成 undefined）
    let early
    void call.then((value) => { early = value })

    // 前提自检：这是"永不 close"的子进程，不 tick 就永远不该 settle
    mock.timers.tick(NETWORK_TIMEOUT_MS - 1)
    await flush()
    assert.equal(early, undefined, `未到 ${NETWORK_TIMEOUT_MS}ms 不得 settle`)

    mock.timers.tick(1)
    const result = await expectSettled(call)
    assert.equal(result.ok, false)
    assert.equal(result.code, null)
    assert.match(result.stderr, /\[超时\]/)
    assert.match(result.stderr, new RegExp(String(NETWORK_TIMEOUT_MS)))
    assert.ok(result.stderr.includes('ls-remote'), '超时说明里要带上命令行，便于定位')
  } finally {
    mock.timers.reset()
  }
})

test('runGit：本地命令用本地超时阈值（10s，不是网络 30s）', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const child = new StuckChild()
    const call = runGit('/nonexistent', ['status'], { spawnFn: () => child })
    let early
    void call.then((value) => { early = value })
    mock.timers.tick(LOCAL_TIMEOUT_MS - 1)
    await flush()
    assert.equal(early, undefined, '本地命令在 10s 前不得 settle')
    mock.timers.tick(1)
    const result = await expectSettled(call)
    assert.equal(result.ok, false)
    assert.match(result.stderr, new RegExp(String(LOCAL_TIMEOUT_MS)))
  } finally {
    mock.timers.reset()
  }
})

test('runGit：超时落定后，迟到的 close 不得把结果翻案成成功（settle-once）', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const child = new StuckChild()
    const pending = runGit('/nonexistent', ['fetch', 'origin'], { network: true, spawnFn: () => child })
    mock.timers.tick(NETWORK_TIMEOUT_MS)
    const result = await expectSettled(pending)
    assert.equal(result.ok, false)
    assert.equal(result.code, null)

    // 孙进程终于退出 → 管道关闭 → 子进程 'close' 到达（真实场景里可能晚几秒）
    child.emit('close', 0)
    await flush()
    assert.equal(result.ok, false, 'close 到得晚，不得翻案成成功')
    assert.equal(result.code, null, 'code 必须保持 null（没有人拿到真实退出码）')
  } finally {
    mock.timers.reset()
  }
})

test('runGit：超时时杀进程并 destroy 两路管道（close 得以触发、句柄释放）', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const child = new StuckChild()
    const pending = runGit('/nonexistent', ['fetch'], { network: true, spawnFn: () => child })
    mock.timers.tick(NETWORK_TIMEOUT_MS)
    await expectSettled(pending)
    assert.deepEqual(child.signals, ['SIGKILL'], '必须尝试终止子进程')
    assert.equal(child.stdout.destroyed, true, 'stdout 管道必须 destroy')
    assert.equal(child.stderr.destroyed, true, 'stderr 管道必须 destroy')
  } finally {
    mock.timers.reset()
  }
})

test('runGit：正常路径不受影响（close 先到 → 按退出码判定，并清掉定时器）', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const child = new StuckChild()
    const pending = runGit('/nonexistent', ['status'], { spawnFn: () => child })
    child.stdout.push(' M lib/store.js\n')
    await flushMacro()
    child.emit('close', 0)
    const result = await expectSettled(pending, 500)
    assert.equal(result.ok, true)
    assert.equal(result.code, 0)
    assert.equal(result.stdout, ' M lib/store.js\n')
    assert.deepEqual(child.signals, [], '正常结束不得 kill')
    // 定时器必须已清除：再推进时间也不会再触发超时分支
    mock.timers.tick(NETWORK_TIMEOUT_MS * 2)
    await flush()
    assert.deepEqual(child.signals, [], '落定后不得再 kill')
    assert.equal(result.ok, true, '已落定的结果不得被改写')
  } finally {
    mock.timers.reset()
  }
})

test('runGit：给 git 子进程固定 LC_ALL=C，避免非英文 locale 下 stderr 被本地化（#75）', async () => {
  const child = new StuckChild()
  let seenEnv = null
  // 经 opts.spawnFn 观察 env；不 new 真实进程，避免 Windows 上再开一个 git。
  const pending = runGit('/nonexistent', ['status'], {
    spawnFn: (cmd, args, opts) => {
      seenEnv = opts.env
      return child
    },
  })
  child.emit('close', 0)
  await expectSettled(pending, 500)

  assert.ok(seenEnv, 'spawn 应收到 env 参数')
  assert.equal(seenEnv.LC_ALL, 'C', 'git 子进程必须用 C locale（中文/其他语言系统不得把错误文案本地化）')
  // 网络命令仍要保留防凭证卡死开关
  const netChild = new StuckChild()
  let netEnv = null
  const netPending = runGit('/nonexistent', ['fetch', 'origin'], {
    network: true,
    spawnFn: (cmd, args, opts) => {
      netEnv = opts.env
      return netChild
    },
  })
  netChild.emit('close', 0)
  await expectSettled(netPending, 500)
  assert.equal(netEnv.LC_ALL, 'C', '网络命令同样必须固定 C locale')
  assert.equal(netEnv.GIT_TERMINAL_PROMPT, '0', '网络命令必须保留 GIT_TERMINAL_PROMPT=0 防凭证卡死')
})

test('runGit：spawn 报错（如 git 不存在）走 error 分支并带出原因', async () => {
  const child = new StuckChild()
  const pending = runGit('/nonexistent', ['status'], { spawnFn: () => child })
  child.emit('error', new Error('spawn git ENOENT'))
  const result = await expectSettled(pending, 500)
  assert.equal(result.ok, false)
  assert.equal(result.code, null)
  assert.match(result.stderr, /ENOENT/)
})

// POSIX 才能按进程组终止；Windows 无进程组信号，跳过（见文件头说明）。
test('runGit：超时终止真实进程组（子进程 + 孙进程一并清掉）', { skip: process.platform === 'win32' }, async () => {
  // 假 spawn 返回一个**真实的** detached 子进程：它再派生一个孙进程，两者都
  // 活着并持有 stdout/stderr 管道——正是 git → git-remote-https 的形态。
  const script = [
    "const { spawn } = require('node:child_process')",
    "const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'] })",
    "process.stdout.write('GRANDCHILD=' + kid.pid + '\\n')",
    'setTimeout(() => {}, 60000)',
  ].join('\n')
  const child = spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let grandchildPid = null
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    const match = /GRANDCHILD=(\d+)/.exec(chunk)
    if (match !== null) grandchildPid = Number(match[1])
  })

  /** 进程是否还活着（POSIX：signal 0 只做存在性检查）。 */
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  /** 轮询等待进程消失（真实时间：Date 未被 mock）。 */
  const waitGone = async (pid, deadlineMs = 5000) => {
    const started = Date.now()
    while (Date.now() - started < deadlineMs) {
      if (!alive(pid)) return true
      await flushMacro()
    }
    return !alive(pid)
  }

  try {
    assert.ok(child.pid > 0)
    // 等孙进程 pid 打出来（前提自检：没有孙进程就测不到进程组终止）
    const bootDeadline = Date.now() + 10_000
    while (grandchildPid === null && Date.now() < bootDeadline) await flushMacro()
    assert.ok(grandchildPid !== null, '孙进程必须已启动')
    assert.equal(alive(grandchildPid), true)

    mock.timers.enable({ apis: ['setTimeout'] })
    const pending = runGit('/nonexistent', ['fetch'], { network: true, spawnFn: () => child })
    mock.timers.tick(NETWORK_TIMEOUT_MS)
    const result = await expectSettled(pending)
    mock.timers.reset()
    assert.equal(result.ok, false)

    assert.equal(await waitGone(child.pid), true, '直接子进程必须被终止')
    assert.equal(await waitGone(grandchildPid), true, '孙进程必须随进程组一起被终止')
  } finally {
    mock.timers.reset()
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* 已清理 */ }
  }
})
