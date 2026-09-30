import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { AdapterStore } from '../lib/coi/adapters.js'
import { SessionStore } from '../lib/coi/session-store.js'
import { TaskStore } from '../lib/coi/tasks-store.js'
import { CoiScheduler } from '../lib/coi/scheduler.js'

test('synchronous spawn failure reaches failed and releases its session lock', () => {
  const root = resolve(tmpdir())
  const dir = mkdtempSync(join(root, 'coi-start-failure-'))
  const adapters = new AdapterStore(join(dir, 'adapters.json'))
  const sessions = new SessionStore(join(dir, 'sessions.json'))
  const tasks = new TaskStore(dir)
  const notifications = []
  const scheduler = new CoiScheduler({ emit() {} }, {
    adapters, sessions, tasks, config: { coiDataDir: dir },
    notify: (event) => notifications.push(event),
  })
  try {
    // Node rejects the invalid cwd synchronously, before launching any CLI.
    const result = scheduler.dispatch({
      adapterId: 'kimi', prompt: 'must not execute', mode: 'resume',
      sessionId: 'cli-session-a', ownerSessionId: 'session-a', cwd: { invalid: true },
    })
    assert.equal(result.ok, false)
    const task = tasks.get(result.taskId)
    assert.equal(task.status, 'failed')
    assert.match(task.error, /启动失败/)
    assert.ok(task.finishedAt)
    assert.equal(scheduler.running.size, 0)
    assert.equal(sessions.findById('cli-session-a').activeTaskId, null)
    assert.equal(sessions.acquire('cli-session-a', 'next-task').ok, true)
    assert.deepEqual(notifications.map((event) => event.status), ['failed'])
  } finally {
    scheduler.dispose()
    if (dirname(resolve(dir)) !== root) throw new Error('Unexpected fixture path')
    rmSync(dir, { recursive: true })
  }
})
