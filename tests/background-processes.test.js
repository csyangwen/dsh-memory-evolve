import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { gitBranch, gitBranchList } from '../lib/store.js'
import { toWindowsPath } from '../lib/index.js'
import { getSearchProviders } from '../lib/search-docs.js'
import { resolveMainRemote } from '../lib/sync/identity.js'
import { projectSyncInfo, spawnWorker, syncStatusSync } from '../lib/sync/index.js'
import { runStatus } from '../lib/sync/worker.js'
import { runGit } from '../lib/sync/repo.js'

const nativeSpawnSync = childProcess.spawnSync
const nativeSpawn = childProcess.spawn

function temporaryDirectory(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-background-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function git(cwd, args) {
  const result = nativeSpawnSync('git', ['-c', `core.hooksPath=${join(cwd, 'fixture-no-hooks')}`, ...args],
    { cwd, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr || String(result.error))
  return result.stdout.trim()
}

function repository(dir) {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'test-main'])
  git(dir, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture'])
}

function intercept(t, { sync, async } = {}) {
  const calls = []
  childProcess.spawnSync = (command, args, options) => {
    calls.push({ command, args, options })
    if (sync) return sync(command, args, options)
    // Keep the red test from itself flashing consoles while still running real Git.
    return nativeSpawnSync(command, args, { ...options, windowsHide: true })
  }
  childProcess.spawn = (command, args, options) => {
    calls.push({ command, args, options })
    if (async) return async(command, args, options)
    return nativeSpawn(command, args, {
      ...options, windowsHide: true,
      detached: process.platform === 'win32' ? false : options?.detached,
    })
  }
  syncBuiltinESMExports()
  t.after(() => {
    childProcess.spawnSync = nativeSpawnSync
    childProcess.spawn = nativeSpawn
    syncBuiltinESMExports()
  })
  return calls
}

function assertHidden(calls) {
  assert.ok(calls.length > 0, 'the public helper must actually invoke a command')
  for (const { command, args, options } of calls) {
    assert.equal(options?.windowsHide, true, `${command} ${args.join(' ')} must request a hidden console`)
  }
}

function answer(stdout) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  queueMicrotask(() => {
    child.stdout.end(stdout)
    child.stderr.end()
    child.emit('close', 0)
  })
  return child
}

test('branch and remote discovery preserve real Git results without opening consoles', (t) => {
  const root = temporaryDirectory(t)
  repository(root)
  const url = 'https://example.invalid/fixture.git'
  git(root, ['remote', 'add', 'origin', url])
  const calls = intercept(t)
  assert.equal(gitBranch(root), 'test-main')
  assert.deepEqual(gitBranchList(root), ['test-main'])
  assert.equal(resolveMainRemote(root).url, url)
  git(root, ['remote', 'rename', 'origin', 'upstream'])
  const remote = resolveMainRemote(root)
  assert.equal(remote.name, 'upstream')
  assert.equal(realpathSync(remote.root), realpathSync(root))
  assert.ok(calls.some(({ args }) => args.join(' ') === 'remote'))
  assertHidden(calls)
})

test('path conversion and document probes/searches hide their console helpers', async (t) => {
  const root = temporaryDirectory(t)
  const file = join(root, 'notes.md')
  writeFileSync(file, 'fixture\n')
  const calls = intercept(t, {
    sync(command) {
      if (command === 'wslpath') return { status: 0, stdout: 'C:\\notes\r\n' }
      assert.equal(command, 'rg')
      return { status: 0, stdout: 'fixture rg' }
    },
    async(command) {
      assert.equal(command, 'rg')
      return answer(file + '\n')
    },
  })
  assert.equal(toWindowsPath('/mnt/c/notes'), 'C:\\notes')
  const provider = getSearchProviders().get('rg')({})
  assert.equal(provider.probe(), true)
  const result = await provider.search({ query: 'notes', exts: ['md'], dir: root, limit: 10 }, {})
  assert.deepEqual(result.map(entry => entry.path), [file])
  assert.equal(calls.length, 3)
  assertHidden(calls)
})

test('project and global sync status retain real Git behavior with hidden subprocesses', async (t) => {
  const root = temporaryDirectory(t)
  const cwd = join(root, 'work')
  repository(cwd)
  const config = { memoryDir: join(root, 'memory') }
  const { dir } = projectSyncInfo(config, cwd)
  repository(dir)
  repository(config.memoryDir)
  writeFileSync(join(config.memoryDir, 'PROVENANCE'), JSON.stringify({ tracks: { memory: true } }))
  const calls = intercept(t)
  const status = syncStatusSync(config, cwd)
  assert.equal(status.initialized, true)
  assert.equal(status.global.initialized, true)
  assert.ok(calls.some(({ args }) => args[0] === 'read-tree'))
  const worker = await runStatus({ dir, localBranch: 'test-main', remoteBranch: 'dsh-shared/fixture' })
  assert.equal(worker.ok, true)
  assert.equal(worker.status.initialized, true)
  assertHidden(calls)
})

test('the sync worker runs in the background without changing arguments or output', async (t) => {
  const args = ['status', temporaryDirectory(t), 'dsh-shared/fixture']
  const calls = intercept(t, {
    async(command, actualArgs) {
      assert.equal(command, process.execPath)
      assert.deepEqual(actualArgs.slice(1), args)
      return answer('{"ok":true}\n')
    },
  })
  const result = await spawnWorker(args)
  assert.equal(result.ok, true)
  assert.equal(result.stdout, '{"ok":true}\n')
  assert.equal(calls.length, 1)
  assertHidden(calls)
})

test('sync Git hides Windows consoles without changing POSIX process groups', async (t) => {
  const root = temporaryDirectory(t)
  const args = ['status', '--porcelain']
  const calls = []
  const result = await runGit(root, args, {
    spawnFn(command, actualArgs, options) {
      calls.push({ command, args: actualArgs, options })
      return answer(' M KEY.md\n')
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.stdout, ' M KEY.md\n')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'git')
  assert.deepEqual(calls[0].args, args)
  assert.equal(calls[0].options.cwd, root)
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(calls[0].options.detached, process.platform !== 'win32')
  assertHidden(calls)
})
