/**
 * dsh-memory-evolve — 版本检测与更新模块测试（lib/update.js）。
 *
 * 覆盖（对应实施文档修订版 v2 的 2.10 验证清单）：
 *   - 纯函数：parseVersion / compareVersions / parseTagRefs（严格格式过滤、
 *     SemVer 排序、peeled sha 关联）
 *   - 状态机：no-release / outdated / 本地 ahead（HEAD 包含发布提交不提示）/
 *     unsupported（无 git、非仓库）
 *   - 缓存：24h 命中、force 绕过、时间回拨失效
 *   - 更新事务：目标变化 409 / dirty（untracked+staged）/ 信任校验（不在
 *     origin/main 历史拒绝）/ 成功全链路（fetch+checkout+restartRequired+
 *     releaseNotes）/ checkout 失败不乐观写状态 / 锁冲突 busy
 *   - 状态文件：位于 git 管理目录（不在工作树）、损坏 JSON 安全重建
 *
 * 全程使用临时目录（bare origin + 发布副本 + consumer clone），
 * 不触碰真实 remote（实施文档 P1-6）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  acquireUpdateLock,
  compareVersions,
  createUpdateChecker,
  parseTagRefs,
  parseVersion,
  readJson,
  releaseUpdateLock,
} from '../lib/update.js'

// 注入 run 用的真实执行器：必须用异步 execFile（promisify(execFileSync)
// 没有 callback，成功时 Promise 永不 resolve，会导致测试挂起）。
const realRun = promisify(execFile)

/** git 同步执行助手（测试基建用）。 */
function sh(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-update-test-'))
}

/**
 * 测试基建：本地 bare origin + 发布工作副本（打两个 annotated tag）+
 * consumer clone（模拟已装旧版的设备）。
 * origin 历史：c1(v1.0.0) → c2(v1.1.0)，均在 main。
 * consumer：clone 后 checkout --detach v1.0.0（旧版本安装现场）。
 */
function setupRepo() {
  const root = tempRoot()
  const origin = join(root, 'origin.git')
  const dev = join(root, 'dev')
  const consumer = join(root, 'consumer')
  sh(root, ['init', '--bare', '-q', origin])
  mkdirSync(dev)
  sh(dev, ['init', '-q'])
  sh(dev, ['config', 'user.email', 't@t'])
  sh(dev, ['config', 'user.name', 't'])
  sh(dev, ['remote', 'add', 'origin', origin])
  writeFileSync(join(dev, 'a.txt'), 'v1')
  sh(dev, ['add', '.'])
  sh(dev, ['commit', '-q', '-m', 'c1'])
  sh(dev, ['tag', '-a', 'v1.0.0', '-m', 'first release\nline2'])
  sh(dev, ['push', '-q', 'origin', 'main', 'v1.0.0'])
  writeFileSync(join(dev, 'a.txt'), 'v2')
  sh(dev, ['add', '.'])
  sh(dev, ['commit', '-q', '-m', 'c2'])
  sh(dev, ['tag', '-a', 'v1.1.0', '-m', 'second release'])
  sh(dev, ['push', '-q', 'origin', 'main', 'v1.1.0'])
  sh(root, ['clone', '-q', origin, consumer])
  sh(consumer, ['checkout', '-q', '--detach', 'v1.0.0'])
  return { root, origin, dev, consumer }
}

/** 可推进的时钟（每次调用 +1ms，用于验证是否真的重跑了 git 检测）。 */
function advancingClock() {
  let base = Date.now()
  return () => { base += 1; return base }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('parseVersion 接受语义化与日期戳格式，拒绝 prerelease/build/compat', () => {
  // 语义化格式：数值段断言核心字段。
  const v = parseVersion('v1.2.3')
  assert.equal(v.major, 1); assert.equal(v.minor, 2); assert.equal(v.patch, 3)
  assert.equal(v.majorStr, '1'); assert.equal(v.patchStr, '3')
  assert.deepEqual(v.segments, ['1', '2', '3'])
  const z = parseVersion('v0.0.0')
  assert.equal(z.major, 0); assert.equal(z.minor, 0); assert.equal(z.patch, 0)
  // 日期戳格式（用户拍板：v26081201 这类）。
  const d = parseVersion('v26081201')
  assert.equal(d.kind, 'numeric')
  assert.deepEqual(d.segments, ['26081201'])
  assert.equal(parseVersion('v1.2.3-beta'), null)
  assert.equal(parseVersion('v1.2.3+build.1'), null)
  assert.equal(parseVersion('compat-260805'), null)
  assert.equal(parseVersion('1.2.3'), null) // 缺 v 前缀
  assert.equal(parseVersion('v01.2.3'), null) // 前导零
  assert.equal(parseVersion('v026081201'), null) // 日期戳前导零也拒绝
  assert.equal(parseVersion(''), null)
})

test('compareVersions 按段数组真比较（语义化 + 日期戳）', () => {
  assert.equal(compareVersions(parseVersion('v0.9.0'), parseVersion('v0.10.0')), -1)
  assert.equal(compareVersions(parseVersion('v1.0.0'), parseVersion('v1.0.0')), 0)
  assert.equal(compareVersions(parseVersion('v2.0.0'), parseVersion('v1.99.99')), 1)
  // 日期戳：按数值大小。
  assert.equal(compareVersions(parseVersion('v26081200'), parseVersion('v26081201')), -1)
  assert.equal(compareVersions(parseVersion('v26081202'), parseVersion('v26081201')), 1)
  assert.equal(compareVersions(parseVersion('v26081201'), parseVersion('v26081201')), 0)
  // 跨格式：单段数值 vs 三段语义化（用户实际不会混用，排序确定即可）。
  assert.equal(compareVersions(parseVersion('v26081201'), parseVersion('v1.2.3')), 1)
})

test('parseTagRefs 过滤非严格格式、关联 peeled sha、升序排序', () => {
  const out = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/compat-260805',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/v0.9.0',
    'cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v0.10.0',
    'dddddddddddddddddddddddddddddddddddddddd\trefs/tags/v0.10.0^{}',
    'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\trefs/tags/v1.0.0-beta.1',
  ].join('\n')
  const tags = parseTagRefs(out)
  assert.deepEqual(tags.map((t) => t.tag), ['v0.9.0', 'v0.10.0'])
  // v0.10.0 是 annotated tag：sha 取 peeled 行指向的 commit
  assert.equal(tags[1].sha, 'dddddddddddddddddddddddddddddddddddddddd')
  // lightweight tag：sha 即 tag 行自身
  assert.equal(tags[0].sha, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
})

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

test('outdated：旧版本设备检测到新 tag', async () => {
  const { consumer } = setupRepo()
  const checker = createUpdateChecker({ repoDir: consumer, now: advancingClock() })
  const s = await checker.status()
  assert.equal(s.status, 'outdated')
  assert.equal(s.latestTag, 'v1.1.0')
  assert.equal(s.localTag, 'v1.0.0')
  assert.equal(await checker.badgeUpdate(), 1)
})

test('本地 ahead（HEAD 已包含发布提交）不提示更新', async () => {
  const { consumer, dev } = setupRepo()
  // 把 consumer 推进到 main 最新（本地开发轨领先于 v1.1.0 或等于它）。
  sh(consumer, ['fetch', '-q', 'origin'])
  sh(consumer, ['checkout', '-q', 'main'])
  const checker = createUpdateChecker({ repoDir: consumer, now: advancingClock() })
  const s = await checker.status()
  assert.equal(s.status, 'latest')
  assert.equal(await checker.badgeUpdate(), 0)
})

test('no-release：远端没有 v* tag', async () => {
  const root = tempRoot()
  const origin = join(root, 'origin.git')
  const consumer = join(root, 'consumer')
  sh(root, ['init', '--bare', '-q', origin])
  mkdirSync(join(root, 'dev'))
  sh(join(root, 'dev'), ['init', '-q'])
  sh(join(root, 'dev'), ['config', 'user.email', 't@t'])
  sh(join(root, 'dev'), ['config', 'user.name', 't'])
  sh(join(root, 'dev'), ['remote', 'add', 'origin', origin])
  writeFileSync(join(root, 'dev', 'a.txt'), 'x')
  sh(join(root, 'dev'), ['add', '.'])
  sh(join(root, 'dev'), ['commit', '-q', '-m', 'c'])
  // 只打非语义 tag（compat-*），不算发布版本。
  sh(join(root, 'dev'), ['tag', '-a', 'compat-260805', '-m', 'compat'])
  sh(join(root, 'dev'), ['push', '-q', 'origin', 'main', 'compat-260805'])
  sh(root, ['clone', '-q', origin, consumer])
  const checker = createUpdateChecker({ repoDir: consumer, now: advancingClock() })
  const s = await checker.status()
  assert.equal(s.status, 'no-release')
  assert.equal(await checker.badgeUpdate(), 0)
})

test('unsupported：非仓库目录', async () => {
  const dir = tempRoot()
  const checker = createUpdateChecker({ repoDir: dir, now: advancingClock() })
  const s = await checker.status()
  assert.equal(s.status, 'unsupported')
})

test('unsupported：git 不存在（runner ENOENT）', async () => {
  const { consumer } = setupRepo()
  const checker = createUpdateChecker({
    repoDir: consumer,
    now: advancingClock(),
    run: async () => { const err = new Error('spawn git ENOENT'); err.code = 'ENOENT'; throw err },
  })
  const s = await checker.status()
  assert.equal(s.status, 'unsupported')
})

// ---------------------------------------------------------------------------
// 缓存 / 时间
// ---------------------------------------------------------------------------

test('24h 缓存命中：第二次 status 不重跑 git', async () => {
  const { consumer } = setupRepo()
  const clock = advancingClock()
  const checker = createUpdateChecker({ repoDir: consumer, now: clock })
  await checker.status()
  const firstAttempt = (await readCacheState(checker)).lastAttemptAt
  const s2 = await checker.status()
  const secondAttempt = (await readCacheState(checker)).lastAttemptAt
  assert.equal(s2.status, 'outdated')
  // now 每次 +1ms，若重跑 lastAttemptAt 会前进——命中缓存则保持不变。
  assert.equal(secondAttempt, firstAttempt)
})

test('force=1 绕过缓存强制重检', async () => {
  const { consumer } = setupRepo()
  const clock = advancingClock()
  const checker = createUpdateChecker({ repoDir: consumer, now: clock })
  await checker.status()
  const before = (await readCacheState(checker)).lastAttemptAt
  await checker.status(true)
  const after = (await readCacheState(checker)).lastAttemptAt
  assert.ok(after > before, 'force 应触发重检（lastAttemptAt 前进）')
})

test('时间回拨：未来 lastAttemptAt 视为失效并重检', async () => {
  const { consumer } = setupRepo()
  let t = Date.now()
  const clock = () => t
  const checker = createUpdateChecker({ repoDir: consumer, now: clock })
  await checker.status()
  // 回拨 10 小时：lastAttemptAt（未来）→ 缓存必须失效。
  t -= 10 * 60 * 60 * 1000
  const s = await checker.status()
  assert.equal(s.status, 'outdated')
  const state = await readCacheState(checker)
  assert.ok(state.lastAttemptAt <= t + 1, '重检后 lastAttemptAt 应回到当前时间附近')
})

// ---------------------------------------------------------------------------
// 更新事务
// ---------------------------------------------------------------------------

test('更新成功全链路：fetch + checkout --detach + restartRequired + releaseNotes', async () => {
  const { consumer } = setupRepo()
  const checker = createUpdateChecker({ repoDir: consumer, now: advancingClock() })
  const outcome = await checker.update('v1.1.0')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.tag, 'v1.1.0')
  assert.equal(outcome.restartRequired, true)
  assert.equal(outcome.releaseNotes.includes('second release'), true)
  // 工作树已切到 v1.1.0（detached HEAD）
  assert.equal(sh(consumer, ['describe', '--tags', '--exact-match']), 'v1.1.0')
  // 状态重算为 latest，且 restartRequired 持久化
  const s = await checker.status()
  assert.equal(s.status, 'latest')
  assert.equal((await readTxState(checker)).restartRequired, true)
  // 状态文件在 git 管理目录（不在工作树）——checkout 后工作树不出现状态文件
  assert.equal(existsSync(join(consumer, '.update-state.json')), false)
  assert.equal(existsSync(join(consumer, 'dsh-memory-evolve')), false)
})

test('目标变化：expectedTag 不是最新 → target-changed', async () => {
  const { consumer } = setupRepo()
  const checker = createUpdateChecker({ repoDir: consumer, now: advancingClock() })
  const outcome = await checker.update('v1.0.0')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'target-changed')
})

test('dirty：untracked 文件拦截更新', async () => {
  const { consumer } = setupRepo()
  writeFileSync(join(consumer, 'dirty.txt'), 'x')
  const checker = createUpdateChecker({ repoDir: consumer, now: advancingClock() })
  const outcome = await checker.update('v1.1.0')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'dirty')
  assert.match(outcome.error, /dirty\.txt/)
})

test('dirty：staged 文件同样拦截（文案不提示“暂存即可”）', async () => {
  const { consumer } = setupRepo()
  writeFileSync(join(consumer, 'staged.txt'), 'x')
  sh(consumer, ['add', 'staged.txt'])
  const checker = createUpdateChecker({ repoDir: consumer, now: advancingClock() })
  const outcome = await checker.update('v1.1.0')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'dirty')
  assert.doesNotMatch(outcome.error, /暂存/)
})

test('信任校验：tag 不在 origin/main 历史 → untrusted', async () => {
  const { consumer, dev, root, origin } = setupRepo()
  mkdirSync(join(root, 'side'))
  sh(root, ['clone', '-q', dev, join(root, 'side')]) // 用 dev 副本避免污染 dev
  const side = join(root, 'side')
  // clone 的 origin 指向 dev（相对路径被转为绝对路径）——改回裸仓库。
  sh(side, ['remote', 'set-url', 'origin', origin])
  sh(side, ['checkout', '-q', '--orphan', 'side'])
  sh(side, ['rm', '-rf', '-q', '.'])
  writeFileSync(join(side, 'side.txt'), 's')
  sh(side, ['add', '.'])
  sh(side, ['commit', '-q', '-m', 'side'])
  sh(side, ['tag', '-a', 'v9.9.9', '-m', 'rogue'])
  sh(side, ['push', '-q', 'origin', 'v9.9.9'])
  const checker = createUpdateChecker({ repoDir: consumer, now: advancingClock() })
  const s = await checker.status()
  assert.equal(s.latestTag, 'v9.9.9') // 检测可见（SemVer 最大）
  const outcome = await checker.update('v9.9.9')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'untrusted')
})

test('checkout 失败：不乐观写状态，返回 error', async () => {
  const { consumer } = setupRepo()
  // 注入：仅 checkout 命令模拟失败（抛非零退出）。
  const checker = createUpdateChecker({
    repoDir: consumer,
    now: advancingClock(),
    run: async (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'checkout') {
        const err = new Error('checkout failed')
        err.status = 128
        err.stderr = 'error: pathspec failed'
        throw err
      }
      return realRun(cmd, args, opts)
    },
  })
  const outcome = await checker.update('v1.1.0')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'error')
  // 工作树仍在 v1.0.0，状态未被乐观写成 latest。
  assert.equal(sh(consumer, ['describe', '--tags', '--exact-match']), 'v1.0.0')
  assert.equal((await readCacheState(checker)).status, 'outdated')
})

test('锁冲突：更新进行中 → busy', async () => {
  const { consumer } = setupRepo()
  const checker = createUpdateChecker({ repoDir: consumer, now: advancingClock() })
  // 先手动拿锁（模拟另一实例正在更新），再调 update → busy。
  const gitDir = await checker._internal.gitDirOf()
  const lock = await acquireUpdateLock(gitDir)
  assert.equal(lock.ok, true)
  try {
    const outcome = await checker.update('v1.1.0')
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'busy')
  } finally {
    // 释放须带 token（v2 锁机制：pid+token 双校验，缺 token 不删锁）。
    releaseUpdateLock(gitDir, lock.token)
  }
  // 释放后可正常更新。
  const outcome = await checker.update('v1.1.0')
  assert.equal(outcome.ok, true)
})

test('认证失败：error 且保留最后成功状态（badge 不误变 0）', async () => {
  const { consumer } = setupRepo()
  let fail = false
  const checker = createUpdateChecker({
    repoDir: consumer,
    now: advancingClock(),
    run: async (cmd, args, opts) => {
      if (fail && cmd === 'git' && args[0] === 'ls-remote') {
        const err = new Error('auth failed')
        err.status = 128
        err.stderr = 'Permission denied (publickey).'
        throw err
      }
      return realRun(cmd, args, opts)
    },
  })
  const s1 = await checker.status()
  assert.equal(s1.status, 'outdated')
  fail = true
  const s2 = await checker.status(true) // force 重检 → 失败
  assert.equal(s2.status, 'outdated') // 保留最后成功状态
  assert.equal(s2.lastError?.kind, 'auth')
  assert.equal(await checker.badgeUpdate(), 1) // badge 依据最后成功状态，不误消失
})

test('损坏状态文件：安全重建', async () => {
  const { consumer } = setupRepo()
  const checker = createUpdateChecker({ repoDir: consumer, now: advancingClock() })
  const cachePath = join(await stateDirOf(checker), 'dsh-memory-evolve', 'update-state.json')
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, '{corrupt json!!!', 'utf8')
  const s = await checker.status()
  assert.equal(s.status, 'outdated')
  // 重建后是合法 JSON
  const raw = JSON.parse(readFileSync(cachePath, 'utf8'))
  assert.equal(raw.status, 'outdated')
})

test('remote 变化：旧缓存失效并重检', async () => {
  const { consumer, origin } = setupRepo()
  const clock = advancingClock()
  const checker = createUpdateChecker({ repoDir: consumer, now: clock })
  await checker.status()
  const firstUrl = (await readCacheState(checker)).remoteUrl
  assert.ok(firstUrl.includes('origin.git'))
  // 换 remote（指向另一个空 bare 仓库）→ 检测应重跑并识别无发布版本。
  const empty = join(dirname(origin), 'empty.git')
  sh(dirname(origin), ['init', '--bare', '-q', empty])
  sh(consumer, ['remote', 'set-url', 'origin', empty])
  const s = await checker.status()
  // 新 remote 无 tag → no-release（说明确实重检了，没有吃旧缓存）
  assert.equal(s.status, 'no-release')
})

// ---------------------------------------------------------------------------
// 第二轮 CodeX 复审（coi-mspeh3kn-2）补充回归测试
// ---------------------------------------------------------------------------

test('[P0-1] 锁内远端复核失败：更新中止，不沿用旧成功字段', async () => {
  const { consumer } = setupRepo()
  let failLs = false
  const checker = createUpdateChecker({
    repoDir: consumer,
    now: advancingClock(),
    run: async (cmd, args, opts) => {
      if (failLs && cmd === 'git' && args[0] === 'ls-remote') {
        const err = new Error('auth')
        err.stderr = 'Permission denied (publickey).'
        err.code = 128
        throw err
      }
      return realRun(cmd, args, opts)
    },
  })
  await checker.status() // 先成功检测（状态为 outdated）
  failLs = true
  const outcome = await checker.update('v1.1.0')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'error')
  // 工作树未被 checkout（仍在 v1.0.0）
  assert.equal(sh(consumer, ['describe', '--tags', '--exact-match']), 'v1.0.0')
})

test('[P0-3] 并发 status 不覆盖 restartRequired（合并写保留事务字段）', async () => {
  const { consumer } = setupRepo()
  const checker = createUpdateChecker({ repoDir: consumer, now: advancingClock() })
  await checker.update('v1.1.0')
  assert.equal((await readTxState(checker)).restartRequired, true)
  // 更新后强制重检（v3 双文件：检测只写缓存，事务文件不被触碰）。
  await checker.status(true)
  assert.equal((await readTxState(checker)).restartRequired, true)
  // API 派生值：runningTag（v1.0.0）≠ localTag（v1.1.0）→ 仍提示重启。
  const s = await checker.status()
  assert.equal(s.restartRequired, true)
})

test('[P1-2] 失败退避 30 分钟：退避期内不重试，超期自动重试', async () => {
  const { consumer } = setupRepo()
  let failLs = true
  let lsCalls = 0
  let t = Date.now()
  const checker = createUpdateChecker({
    repoDir: consumer,
    now: () => t,
    run: async (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        lsCalls += 1
        if (failLs) {
          const err = new Error('network')
          err.stderr = 'Could not resolve host'
          err.code = 128
          throw err
        }
      }
      return realRun(cmd, args, opts)
    },
  })
  const s1 = await checker.status()
  assert.equal(s1.lastError?.kind, 'network')
  const callsAfterFail = lsCalls
  // 退避期内（+10min）：命中失败退避，不重试。
  t += 10 * 60 * 1000
  await checker.status()
  assert.equal(lsCalls, callsAfterFail, '退避期内不应重试')
  // 超期（+31min）：自动重试（仍失败，但 ls-remote 被再次调用）。
  t += 21 * 60 * 1000
  await checker.status()
  assert.ok(lsCalls > callsAfterFail, '超期后应自动重试')
})

test('[P1-2] 失败态时间回拨：未来 lastAttemptAt 不命中退避，立即重试', async () => {
  const { consumer } = setupRepo()
  let failLs = true
  let lsCalls = 0
  let t = Date.now()
  const checker = createUpdateChecker({
    repoDir: consumer,
    now: () => t,
    run: async (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        lsCalls += 1
        if (failLs) {
          const err = new Error('network')
          err.stderr = 'Could not resolve host'
          err.code = 128
          throw err
        }
      }
      return realRun(cmd, args, opts)
    },
  })
  await checker.status()
  const callsAfterFail = lsCalls
  // 回拨 1 小时：lastAttemptAt 在未来 → 退避不成立，立即重试。
  t -= 60 * 60 * 1000
  await checker.status()
  assert.ok(lsCalls > callsAfterFail, '未来时间戳应失效并立即重试')
})

test('[P0-2] 真并发两个 update：只有一个成功，另一个 busy', async () => {
  const { consumer } = setupRepo()
  const checker = createUpdateChecker({ repoDir: consumer, now: advancingClock() })
  const [a, b] = await Promise.all([checker.update('v1.1.0'), checker.update('v1.1.0')])
  const oks = [a, b].filter((r) => r.ok === true).length
  const busys = [a, b].filter((r) => r.ok === false && r.code === 'busy').length
  assert.equal(oks, 1, '并发更新应恰好一个成功')
  assert.equal(busys, 1, '并发更新应恰好一个 busy')
})

test('[P1-3] dirty 检查命令失败：更新中止（不静默放行）', async () => {
  const { consumer } = setupRepo()
  const checker = createUpdateChecker({
    repoDir: consumer,
    now: advancingClock(),
    run: async (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'status') {
        const err = new Error('status failed')
        err.stderr = 'fatal: some error'
        err.code = 128
        throw err
      }
      return realRun(cmd, args, opts)
    },
  })
  const outcome = await checker.update('v1.1.0')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'error')
})

test('[P1-4] 同名本地 tag 指向旧提交：按 SHA 判定为 outdated', async () => {
  const { consumer } = setupRepo()
  // 本地打一个与远端同名的 v1.1.0，但指向旧提交（v1.0.0 的 commit）。
  // clone 自带 v1.1.0（指向新提交）——先删掉再打旧指向。
  sh(consumer, ['tag', '-d', 'v1.1.0'])
  sh(consumer, ['tag', 'v1.1.0', 'v1.0.0^{}'])
  const checker = createUpdateChecker({ repoDir: consumer, now: advancingClock() })
  const s = await checker.status()
  assert.equal(s.latestTag, 'v1.1.0')
  // 本地存在同名 tag（localTag 可能是 v1.0.0/v1.1.0，describe 同 commit
  // 双 tag 返回不定）但远端 SHA 未包含 → 必须 outdated（CodeX 复审 P1-4：
  // 版本包含关系只认 commit SHA，tag 名相等不能作 latest 证据）。
  assert.equal(s.status, 'outdated')
})

test('[P0-2] 非 owner 释放：pid/token 不匹配不删锁', async () => {
  const root = tempRoot()
  const repo = join(root, 'repo')
  mkdirSync(repo)
  sh(repo, ['init', '-q'])
  const gitDir = sh(repo, ['rev-parse', '--absolute-git-dir'])
  const lock = await acquireUpdateLock(gitDir)
  assert.equal(lock.ok, true)
  // 模拟锁被其他进程接管（pid/token 都变）。
  const lockPath = join(gitDir, 'dsh-memory-evolve', 'update.lock')
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 999, token: 'other-token', startedAt: Date.now() }), 'utf8')
  releaseUpdateLock(gitDir, lock.token)
  assert.equal(existsSync(lockPath), true, '非 owner 释放不得删锁')
  // 接管者自己释放：pid 与 token 都匹配才删（模拟同进程内 token 轮换）。
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'other-token', startedAt: Date.now() }), 'utf8')
  releaseUpdateLock(gitDir, 'other-token')
  assert.equal(existsSync(lockPath), false, 'pid+token 匹配时应删除')
})

test('[P0-2] stale 锁可抢占', async () => {
  const root = tempRoot()
  const repo = join(root, 'repo')
  mkdirSync(repo)
  sh(repo, ['init', '-q'])
  const gitDir = sh(repo, ['rev-parse', '--absolute-git-dir'])
  const lockPath = join(gitDir, 'dsh-memory-evolve', 'update.lock')
  mkdirSync(dirname(lockPath), { recursive: true })
  // 写一个 1 小时前的死锁。
  writeFileSync(lockPath, JSON.stringify({ pid: 12345, token: 'dead', startedAt: Date.now() - 60 * 60 * 1000 }), 'utf8')
  const lock = await acquireUpdateLock(gitDir)
  assert.equal(lock.ok, true, 'stale 锁应可抢占')
  assert.equal(lock.token !== 'dead', true)
  releaseUpdateLock(gitDir, lock.token)
})

test('[P2-3] 损坏状态文件会备份 .corrupt-*', async () => {
  const { consumer } = setupRepo()
  const checker = createUpdateChecker({ repoDir: consumer, now: advancingClock() })
  const cachePath = join(await stateDirOf(checker), 'dsh-memory-evolve', 'update-state.json')
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, '{corrupt!!', 'utf8')
  await checker.status()
  // 损坏原文已备份（glob 找 .corrupt-*）。
  const files = readdirSync(dirname(cachePath)).filter((f) => f.startsWith('update-state.json.corrupt-'))
  assert.ok(files.length >= 1, '损坏文件应有 corrupt 备份')
})

// ---------------------------------------------------------------------------
// 状态读取 helper（v3：检测缓存与事务字段双文件，路径经 _internal.locateStateDir）
// ---------------------------------------------------------------------------

async function stateDirOf(checker) {
  return (await checker._internal.locateStateDir()).dir
}

async function readCacheState(checker) {
  const d = await stateDirOf(checker)
  return readJson(join(d, 'dsh-memory-evolve', 'update-state.json'), () => ({})).value
}

async function readTxState(checker) {
  const d = await stateDirOf(checker)
  return readJson(join(d, 'dsh-memory-evolve', 'update-tx.json'), () => ({})).value
}

// ---------------------------------------------------------------------------
// API 契约测试（DTO 白名单 / 同源校验 / badge update 字段）
// ---------------------------------------------------------------------------

import { createServer } from 'node:http'
import { installApi } from '../lib/api.js'

/** 最小 API 服务器（updateOps 用真实 checker 指向 consumer 仓库）。 */
async function bootUpdateApi(repoDir) {
  const dir = tempRoot()
  const checker = createUpdateChecker({ repoDir, fallbackDir: dir, now: advancingClock() })
  const ctx = {
    httpServer: { register: ({ handler }) => { ctx.handler = handler; return () => {} } },
  }
  const queue = { read: () => [] }
  installApi(ctx, {
    store: null, archive: null, queue, todoStore: null,
    getRuntime: () => ({}), updateRuntime: () => ({}),
    resolveCwd: () => undefined,
    config: { memoryDir: dir, skillDir: join(dir, 'skills') },
    updateOps: checker,
  })
  const server = createServer((req, res) => ctx.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, data }
  }
  return { request, close: () => new Promise((r) => server.close(r)) }
}

test('[P1-5] API 契约：status DTO 白名单不泄漏内部字段', async () => {
  const { consumer } = setupRepo()
  const { request, close } = await bootUpdateApi(consumer)
  try {
    const { status, data } = await request('GET', '/memory-evolve/api/update/status')
    assert.equal(status, 200)
    assert.equal(data.ok, true)
    assert.equal(data.status, 'outdated')
    // 内部字段不得外发（CodeX 复审 P1-5）。
    for (const leaked of ['repoPath', 'remoteUrl', 'headSha', 'latestSha', 'schemaVersion']) {
      assert.equal(leaked in data, false, `${leaked} 不应出现在 DTO`)
    }
    assert.equal('restartRequired' in data, true)
  } finally {
    await close()
  }
})

test('[P1-5] API 契约：POST update 同源校验（Content-Type/Origin）', async () => {
  const { consumer } = setupRepo()
  const { request, close } = await bootUpdateApi(consumer)
  try {
    // 1) 非 JSON Content-Type（form 提交形态）→ 400 bad-request。
    const rForm = await request('POST', '/memory-evolve/api/update', { expectedTag: 'v1.1.0' }, { 'content-type': 'text/plain' })
    assert.equal(rForm.status, 400)
    assert.equal(rForm.data.code, 'bad-request')
    // 2) 错误 Origin（跨站）→ 400。
    const rEvil = await request('POST', '/memory-evolve/api/update', { expectedTag: 'v9.9.9' }, { origin: 'http://evil.example' })
    assert.equal(rEvil.status, 400)
    assert.equal(rEvil.data.code, 'bad-request')
  } finally {
    await close()
  }
})

test('[P1-5] API 契约：POST 缺 Origin 被拒（更新必须由 Web UI 发起）', async () => {
  const { consumer } = setupRepo()
  const { request, close } = await bootUpdateApi(consumer)
  try {
    // request 封装不设 Origin header；Node fetch 同源 POST 默认不带 Origin
    // （与浏览器不同）→ sameOriginGuard 必须拒绝（CodeX 复审 P1-5）。
    const r = await request('POST', '/memory-evolve/api/update', { expectedTag: 'v9.9.9' })
    assert.equal(r.status, 400)
    assert.equal(r.data.code, 'bad-request')
  } finally {
    await close()
  }
})

test('badge 返回独立 update 字段（不执行 git）', async () => {
  const { consumer } = setupRepo()
  const { request, close } = await bootUpdateApi(consumer)
  try {
    // 先跑一次检测让状态就位。
    await request('GET', '/memory-evolve/api/update/status')
    const { status, data } = await request('GET', '/memory-evolve/api/badge')
    assert.equal(status, 200)
    assert.equal(data.update, 1) // consumer 落后于 v1.1.0 → 红点
    assert.equal('count' in data, true)
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 字典键一致性（zh/en 缺键回归，CodeX 复审 P1-7）
// ---------------------------------------------------------------------------

test('[P1-7] version/settingsTab 字典键 zh/en 一致', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'index.ts'), 'utf8')
  // zh 字典先定义、en 后定义：同一键第一次出现记 zh，第二次记 en。
  const all = [...src.matchAll(/'((?:settingsTab|version)\.[a-zA-Z0-9._-]+)'\s*:/g)].map((m) => m[1])
  const zhKeys = new Set()
  const enKeys = new Set()
  const seen = new Set()
  for (const key of all) {
    if (!seen.has(key)) { zhKeys.add(key); seen.add(key) }
    else enKeys.add(key)
  }
  const missingEn = [...zhKeys].filter((k) => !enKeys.has(k))
  const extraEn = [...enKeys].filter((k) => !zhKeys.has(k))
  assert.deepEqual(missingEn, [], `en 缺键: ${missingEn.join(', ')}`)
  assert.deepEqual(extraEn, [], `zh 缺键: ${extraEn.join(', ')}`)
})

// ---------------------------------------------------------------------------
// 第三轮 CodeX 复审（coi-mspfbejr-3）回归测试
// ---------------------------------------------------------------------------

test('[P0-1-v3] checkout 成功后远端重检失败：restartRequired 不被吞掉', async () => {
  const { consumer } = setupRepo()
  let failLs = false
  const checker = createUpdateChecker({
    repoDir: consumer,
    now: advancingClock(),
    run: async (cmd, args, opts) => {
      if (failLs && cmd === 'git' && args[0] === 'ls-remote') {
        const err = new Error('network')
        err.stderr = 'Could not resolve host'
        err.code = 128
        throw err
      }
      return realRun(cmd, args, opts)
    },
  })
  const outcome = await checker.update('v1.1.0')
  assert.equal(outcome.ok, true)
  // 更新后让远端重检失败——不得影响已落盘的磁盘字段与重启提示。
  failLs = true
  const s = await checker.status(true)
  assert.equal(s.lastError?.kind, 'network')
  // 磁盘字段已先行落盘（headSha 为新 commit），SHA 派生 → 仍提示重启。
  assert.equal(s.restartRequired, true, '远端重检失败不得吞掉等待重启横幅')
  // 磁盘字段确已落盘：headSha = checkout 后的 HEAD commit。
  const cache = await readCacheState(checker)
  assert.equal(cache.headSha, sh(consumer, ['rev-parse', 'HEAD']))
})

test('[P1-1-v3] 先成功缓存 → 强制失败 → 退避到期自动重试（不再被成功 TTL 冻结）', async () => {
  const { consumer } = setupRepo()
  let failLs = false
  let lsCalls = 0
  let t = Date.now()
  const checker = createUpdateChecker({
    repoDir: consumer,
    now: () => t,
    run: async (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        lsCalls += 1
        if (failLs) {
          const err = new Error('network')
          err.stderr = 'Could not resolve host'
          err.code = 128
          throw err
        }
      }
      return realRun(cmd, args, opts)
    },
  })
  await checker.status() // 先建立成功缓存（lastSuccessAt 距今 <1ms）
  const callsAfterSuccess = lsCalls
  failLs = true
  await checker.status(true) // force 重检 → 失败（记 lastError + lastAttemptAt）
  const callsAfterFail = lsCalls
  assert.ok(callsAfterFail > callsAfterSuccess)
  // 退避期内（+10min）：不重试。
  t += 10 * 60 * 1000
  await checker.status()
  assert.equal(lsCalls, callsAfterFail, '退避期内不应重试')
  // 超期（+31min）：即使成功 TTL（24h）未到期，也必须重试（P1-1-v3）。
  t += 21 * 60 * 1000
  await checker.status()
  assert.ok(lsCalls > callsAfterFail, '退避到期必须重试，不得被成功 TTL 冻结')
})

test('[P1-2-v3] checkout 失败且 HEAD 读取失败：回滚状态 unknown，提示手动恢复', async () => {
  const { consumer } = setupRepo()
  let failCheckout = false
  let failHead = false
  // 只让 checkout 之后（回滚检测）的 rev-parse HEAD 失败——doCheck 与
  // 前置原 HEAD 读取都在 checkout 之前，不受影响（P1-2-v3：unknown 分支）。
  let checkoutSeen = false
  const checker = createUpdateChecker({
    repoDir: consumer,
    now: advancingClock(),
    run: async (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'checkout') {
        checkoutSeen = true
        if (failCheckout) {
          const err = new Error('co failed')
          err.stderr = 'fatal: some error'
          err.code = 128
          throw err
        }
      }
      if (checkoutSeen && failHead && cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        const err = new Error('head failed')
        err.stderr = 'fatal: bad object'
        err.code = 128
        throw err
      }
      return realRun(cmd, args, opts)
    },
  })
  failCheckout = true
  failHead = true
  const outcome = await checker.update('v1.1.0')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'error')
  // 回滚状态 unknown → 文案必须包含手动恢复指引（不能谎称已回滚）。
  assert.match(outcome.error, /手动检查/)
  assert.match(outcome.error, /checkout --detach/)
})

test('[P0-2-v3] stale 阈值内（10 分钟）活跃锁不被抢占', async () => {
  const root = tempRoot()
  const repo = join(root, 'repo')
  mkdirSync(repo)
  sh(repo, ['init', '-q'])
  const gitDir = sh(repo, ['rev-parse', '--absolute-git-dir'])
  const lockPath = join(gitDir, 'dsh-memory-evolve', 'update.lock')
  mkdirSync(dirname(lockPath), { recursive: true })
  // 5 分钟前的锁：仍在 stale 阈值内 → 不得抢占（v3 阈值 10 分钟）。
  writeFileSync(lockPath, JSON.stringify({ pid: 12345, token: 'active', startedAt: Date.now() - 5 * 60 * 1000 }), 'utf8')
  const lock = await acquireUpdateLock(gitDir)
  assert.equal(lock.ok, false, '阈值内活跃锁不得被抢占')
})

test('[P2-2-v3] fallback 标记延续：重启后新实例仍用 fallback 状态', async () => {
  const { consumer } = setupRepo()
  const fbDir = join(tempRoot(), 'fb')
  // 触发 fallback 的方式：把 gitdir 下的 dsh-memory-evolve 目录位换成同名
  // 文件（writeState 的 mkdirSync 会失败 → saveCache 切 fallbackDir）。
  const checker = createUpdateChecker({ repoDir: consumer, fallbackDir: fbDir, now: advancingClock() })
  const dir = await stateDirOf(checker)
  // 把 <gitdir>/dsh-memory-evolve 目录删掉，换成一个同名文件：后续 mkdirSync
  // 失败 → saveCache 走 fallback。
  const meDir = join(dir, 'dsh-memory-evolve')
  rmSync(meDir, { recursive: true, force: true })
  writeFileSync(meDir, 'block', 'utf8') // 目录位被文件占据
  const s = await checker.status()
  assert.equal(s.status, 'outdated')
  // fallback 标记已写入。
  const markPath = join(fbDir, 'dsh-memory-evolve-fallback.json')
  assert.equal(existsSync(markPath), true, 'fallback 标记应持久化')
  // 模拟重启：新 checker 实例（同 fallbackDir）→ 延续 fallback 状态。
  const checker2 = createUpdateChecker({ repoDir: consumer, fallbackDir: fbDir, now: advancingClock() })
  const s2 = await checker2.status()
  assert.equal(s2.status, 'outdated')
  assert.equal(s2.latestTag, 'v1.1.0')
  // 恢复：删掉占位文件，避免污染后续。
  rmSync(meDir, { force: true })
})
