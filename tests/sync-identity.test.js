/**
 * tests/sync-identity.test.js — 身份解析层单元测试（施工图 §7 第 1 步验收）
 *
 * 覆盖：
 *   - normalizeRemoteUrl：https/ssh/git 协议收敛、SCP 形态、凭证剥离、
 *     .git/尾斜杠/默认端口处理、失败形态（file:///本地路径/无仓库路径）；
 *   - sanitizeRemoteUrl：明文凭证清洗；
 *   - resolveProjectId：真实 git 仓库（origin 优先、子目录同身份、无 origin
 *     取第一个 remote、无 remote 回退 projectHash）；
 *   - locateLegacyDir：旧目录迁移回查。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  normalizeRemoteUrl, resolveMainRemote, resolveProjectId, sanitizeRemoteUrl, locateLegacyDir,
} from '../lib/sync/identity.js'
import { projectHash, projectLabel } from '../lib/store.js'

/** Whether `git` is available in this environment (skip git tests otherwise). */
function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-sync-identity-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** 期望的 id：sha1(身份键) 前 12 位（与实现同一算法，防手写错）。 */
function expectedId(key) {
  return createHash('sha1').update(key).digest('hex').slice(0, 12)
}

/* ---------------- normalizeRemoteUrl ---------------- */

test('normalize: https 形态去 .git、去尾斜杠、host 小写', () => {
  assert.equal(normalizeRemoteUrl('https://github.com/user/repo.git'), 'github.com/user/repo')
  assert.equal(normalizeRemoteUrl('https://github.com/user/repo'), 'github.com/user/repo')
  assert.equal(normalizeRemoteUrl('https://github.com/user/repo/'), 'github.com/user/repo')
  assert.equal(normalizeRemoteUrl('https://GITHUB.com/User/Repo.git'), 'github.com/User/Repo')
})

test('normalize: ssh / git / http 协议与 https 收敛到同一键（双设备认亲）', () => {
  const https = normalizeRemoteUrl('https://github.com/user/repo.git')
  const ssh = normalizeRemoteUrl('git@github.com:user/repo.git')
  const sshUrl = normalizeRemoteUrl('ssh://git@github.com/user/repo.git')
  const gitProto = normalizeRemoteUrl('git://github.com/user/repo.git')
  const http = normalizeRemoteUrl('http://github.com/user/repo.git')
  assert.equal(https, 'github.com/user/repo')
  assert.equal(ssh, https)
  assert.equal(sshUrl, https)
  assert.equal(gitProto, https)
  assert.equal(http, https)
})

test('normalize: 凭证与默认端口剥离，非默认端口保留', () => {
  assert.equal(normalizeRemoteUrl('https://token123@github.com/user/repo.git'), 'github.com/user/repo')
  assert.equal(normalizeRemoteUrl('https://user:pass@github.com/user/repo.git'), 'github.com/user/repo')
  assert.equal(normalizeRemoteUrl('https://github.com:443/user/repo.git'), 'github.com/user/repo')
  assert.equal(normalizeRemoteUrl('ssh://git@github.com:22/user/repo.git'), 'github.com/user/repo')
  assert.equal(normalizeRemoteUrl('https://github.com:8443/user/repo.git'), 'github.com:8443/user/repo')
})

test('normalize: 嵌套路径与自定义端口保留', () => {
  assert.equal(normalizeRemoteUrl('https://gitlab.com/group/sub/repo.git'), 'gitlab.com/group/sub/repo')
  assert.equal(normalizeRemoteUrl('ssh://git@git.selfhost.com:2222/team/repo.git'), 'git.selfhost.com:2222/team/repo')
})

test('normalize: 不可共享形态返回 undefined（file:///本地路径/空/无仓库路径）', () => {
  assert.equal(normalizeRemoteUrl(undefined), undefined)
  assert.equal(normalizeRemoteUrl(''), undefined)
  assert.equal(normalizeRemoteUrl('   '), undefined)
  assert.equal(normalizeRemoteUrl('file:///Users/me/repo'), undefined)
  assert.equal(normalizeRemoteUrl('/Users/me/repo'), undefined)
  assert.equal(normalizeRemoteUrl('C:\\Users\\me\\repo'), undefined)
  assert.equal(normalizeRemoteUrl('https://github.com/'), undefined)
  assert.equal(normalizeRemoteUrl('https://github.com'), undefined)
  assert.equal(normalizeRemoteUrl('ftp://github.com/user/repo.git'), undefined)
})

test('normalize: 非字符串入参返回 undefined', () => {
  assert.equal(normalizeRemoteUrl(null), undefined)
  assert.equal(normalizeRemoteUrl(123), undefined)
  assert.equal(normalizeRemoteUrl({}), undefined)
})

/* ---------------- sanitizeRemoteUrl ---------------- */

test('sanitize: 去掉 https/http 明文凭证，保留其余原样', () => {
  assert.equal(sanitizeRemoteUrl('https://token123@github.com/user/repo.git'), 'https://github.com/user/repo.git')
  assert.equal(sanitizeRemoteUrl('https://user:pass@github.com/user/repo.git'), 'https://github.com/user/repo.git')
  // SSH 用户名保留（非凭证，去掉反而坏认证）
  assert.equal(sanitizeRemoteUrl('ssh://git@github.com/user/repo.git'), 'ssh://git@github.com/user/repo.git')
  // SCP 形态与本地路径原样返回
  assert.equal(sanitizeRemoteUrl('git@github.com:user/repo.git'), 'git@github.com:user/repo.git')
  assert.equal(sanitizeRemoteUrl('file:///Users/me/repo'), 'file:///Users/me/repo')
})

/* ---------------- resolveMainRemote / resolveProjectId（真实 git 仓库） ---------------- */

test('resolveProjectId: 同一仓库的两条路径（根目录 vs 子目录）身份一致', { skip: !gitAvailable() }, () => {
  const dir = tempDir()
  try {
    const init = spawnSync('git', ['init', '-q', '-b', 'test-main'], { cwd: dir, stdio: 'ignore' })
    assert.equal(init.status, 0)
    const add = spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/alpha.git'], { cwd: dir, stdio: 'ignore' })
    assert.equal(add.status, 0)
    mkdirSync(join(dir, 'sub'))
    const rootId = resolveProjectId(dir)
    const subId = resolveProjectId(join(dir, 'sub'))
    assert.equal(rootId.kind, 'remote')
    assert.equal(rootId.id, expectedId('github.com/acme/alpha'))
    assert.equal(subId.id, rootId.id)
    assert.equal(subId.displayName, 'github.com/acme/alpha')
  } finally {
    clean(dir)
  }
})

test('resolveMainRemote: origin 优先于其他 remote', { skip: !gitAvailable() }, () => {
  const dir = tempDir()
  try {
    spawnSync('git', ['init', '-q', '-b', 'test-main'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/origin.git'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['remote', 'add', 'upstream', 'https://github.com/other/upstream.git'], { cwd: dir, stdio: 'ignore' })
    const remote = resolveMainRemote(dir)
    assert.equal(remote.name, 'origin')
    assert.equal(remote.url, 'https://github.com/acme/origin.git')
  } finally {
    clean(dir)
  }
})

test('resolveMainRemote: 无 origin 时取第一个 remote', { skip: !gitAvailable() }, () => {
  const dir = tempDir()
  try {
    spawnSync('git', ['init', '-q', '-b', 'test-main'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['remote', 'add', 'mirror', 'https://github.com/mirror/x.git'], { cwd: dir, stdio: 'ignore' })
    const remote = resolveMainRemote(dir)
    assert.equal(remote.name, 'mirror')
    assert.equal(remote.url, 'https://github.com/mirror/x.git')
    const identity = resolveProjectId(dir)
    assert.equal(identity.kind, 'remote')
    assert.equal(identity.id, expectedId('github.com/mirror/x'))
  } finally {
    clean(dir)
  }
})

test('resolveProjectId: 无 remote 回退 projectHash(cwd)，displayName 为项目标签', { skip: !gitAvailable() }, () => {
  const dir = tempDir()
  try {
    const identity = resolveProjectId(dir)
    assert.equal(identity.kind, 'fallback')
    assert.equal(identity.id, projectHash(dir))
    assert.equal(identity.displayName, projectLabel(dir))
    assert.equal(identity.remoteUrl, undefined)
    assert.equal(identity.key, null)
  } finally {
    clean(dir)
  }
})

test('resolveProjectId: remote 为本地路径（file://）时回退 fallback（不共享）', { skip: !gitAvailable() }, () => {
  const dir = tempDir()
  try {
    spawnSync('git', ['init', '-q', '-b', 'test-main'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['remote', 'add', 'origin', 'file:///tmp/somewhere'], { cwd: dir, stdio: 'ignore' })
    const identity = resolveProjectId(dir)
    assert.equal(identity.kind, 'fallback')
    assert.equal(identity.id, projectHash(dir))
  } finally {
    clean(dir)
  }
})

/* ---------------- locateLegacyDir（迁移回查） ---------------- */

test('locateLegacyDir: 旧目录存在且身份不同 → 返回旧目录；否则 null', () => {
  const memoryDir = tempDir()
  const cwd = '/work/some-project'
  const legacyId = projectHash(cwd)
  const legacyDir = join(memoryDir, 'projects', legacyId)
  try {
    // 无旧目录 → null
    assert.equal(locateLegacyDir(memoryDir, cwd, 'aaaaaaaaaaaa'), null)
    // 建旧目录 → 命中
    mkdirSync(legacyDir, { recursive: true })
    assert.equal(locateLegacyDir(memoryDir, cwd, 'bbbbbbbbbbbb'), legacyDir)
    // 身份相同 → null（无需迁移）
    assert.equal(locateLegacyDir(memoryDir, cwd, legacyId), null)
    // 非法入参 → null
    assert.equal(locateLegacyDir(undefined, cwd, 'x'), null)
    assert.equal(locateLegacyDir(memoryDir, undefined, 'x'), null)
  } finally {
    clean(memoryDir)
  }
})
