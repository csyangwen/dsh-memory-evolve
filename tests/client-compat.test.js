/**
 * 客户端服务跨版本入口测试（2026-09-28，DSH 0.2.0 适配）。
 *
 * openSessionCompat 覆盖「切换到会话」的两代入口：
 *   旧（≤ 0.1.5-rc.2）：ctx.sessions.open(id)
 *   新（0.2.0-rc.1+）：sessions 删掉 open()，改走 ctx.uiWorkspace.openSession(id)
 *
 * 该模块是纯函数、无 import，Node 22.18+ 可直接剥离类型导入（无需构建）。
 * 另外用静态断言锁死「TSX 里不许再出现 ctx.sessions.open(...) 直调」——
 * 这正是升级后会在用户点击时才炸的调用形态。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openSessionCompat } from '../src/client/client-compat.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SRC = join(ROOT, 'src/client')

/** 递归收集目录下所有文件。 */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** 造一个只带 get() 的客户端上下文；table 里的服务缺省即 undefined。 */
function fakeCtx(table) {
  return { get: (name) => table[name] }
}

test('legacy host: sessions.open is the chosen entry point', () => {
  const calls = []
  const ctx = fakeCtx({
    sessions: { open: (id) => calls.push(['sessions', id]) },
    uiWorkspace: { openSession: (id) => calls.push(['uiWorkspace', id]) },
  })
  assert.equal(openSessionCompat(ctx, 'session-1'), true)
  assert.deepEqual(calls, [['sessions', 'session-1']], 'legacy host must keep the historical path')
})

test('0.2.0 host: uiWorkspace.openSession is used when sessions.open is gone', () => {
  const calls = []
  const ctx = fakeCtx({
    sessions: { refresh: () => {} },
    uiWorkspace: { openSession: (id) => calls.push(['uiWorkspace', id]) },
  })
  assert.equal(openSessionCompat(ctx, 'session-2'), true)
  assert.deepEqual(calls, [['uiWorkspace', 'session-2']])
})

test('no usable entry point degrades to false instead of throwing', () => {
  assert.equal(openSessionCompat(fakeCtx({ sessions: {}, uiWorkspace: {} }), 'x'), false)
  assert.equal(openSessionCompat(fakeCtx({}), 'x'), false)
  assert.equal(openSessionCompat(undefined, 'x'), false)
})

test('invalid ids and throwing get() are tolerated', () => {
  const ctx = fakeCtx({ sessions: { open: () => { throw new Error('should not be called') } } })
  assert.equal(openSessionCompat(ctx, ''), false)
  assert.equal(openSessionCompat(ctx, undefined), false)
  const throwing = { get: () => { throw new Error('boom') } }
  assert.equal(openSessionCompat(throwing, 'session-3'), false)
})

test('src/client never calls ctx.sessions.open(...) directly again', () => {
  const offenders = []
  for (const file of walk(CLIENT_SRC)) {
    if (!/\.tsx?$/u.test(file)) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (!line.includes('ctx.sessions.open(')) return
      // 允许注释里提到历史路径（说明为什么改走兼容层），禁止真实调用。
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
      offenders.push(`${file.slice(ROOT.length + 1)}:${index + 1}`)
    })
  }
  assert.deepEqual(offenders, [], 'route session switching through openSessionCompat')
})

test('built bundle carries both the legacy and the 0.2.0 session-open paths', () => {
  const bundle = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  assert.ok(bundle.includes('uiWorkspace'), 'lib/client.js must query uiWorkspace (rebuild after editing src/client)')
  assert.ok(bundle.includes('openSession'), 'lib/client.js must call openSession on the 0.2.0 host')
})
