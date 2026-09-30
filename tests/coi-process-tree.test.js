import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { TaskStore } from '../lib/coi/tasks-store.js'
import { SessionStore } from '../lib/coi/session-store.js'
import { CoiScheduler } from '../lib/coi/scheduler.js'

test('long AI task content survives the real Windows process argument limit', { skip: process.platform !== 'win32', timeout: 12000 }, async () => {
  const root = resolve(tmpdir())
  const dir = mkdtempSync(join(root, 'coi-long-input-'))
  const adapter = { id: 'long-input-fixture', name: 'long input fixture', type: 'ai-cli', binary: process.execPath, args: ['-e', 'console.log(process.argv[1])', '{task}'] }
  const tasks = new TaskStore(dir)
  const scheduler = new CoiScheduler({ emit() {} }, { adapters: { get: () => adapter }, tasks, sessions: new SessionStore(join(dir, 'sessions.json')), config: { coiDataDir: dir } })
  try {
    const prompt = 'START_' + 'x'.repeat(40000) + '_END'
    const result = scheduler.dispatch({ adapterId: adapter.id, prompt, scope: 'temporary' })
    assert.equal(result.ok, true, result.message)
    for (let i = 0; i < 100 && tasks.get(result.taskId).status === 'running'; i++) await delay(50)
    const task = tasks.get(result.taskId)
    assert.equal(task.status, 'completed', task.error)
    const output = tasks.readLog(task.id)
    const file = output.match(/任务文件：([^\r\n]+)/)?.[1]
    assert.ok(file, 'the CLI receives a path to the complete task when arguments would exceed the platform limit')
    assert.ok(readFileSync(file, 'utf8').includes(prompt), 'the complete original task reaches the CLI-readable file')
  } finally {
    scheduler.dispose()
    if (dirname(resolve(dir)) !== root) throw new Error('Unexpected fixture path')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cancel ends the actual CLI process and its child process', { timeout: 12000 }, async () => {
  const root = resolve(tmpdir())
  const dir = mkdtempSync(join(root, 'coi-process-tree-'))
  const adapter = {
    id: 'process-fixture', name: 'process fixture', type: 'plain-cli', binary: process.execPath,
    args: ['-e', `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},8000)'],{stdio:'inherit'});console.log('CHILD:'+c.pid);setTimeout(()=>{},8000);`],
  }
  const scheduler = new CoiScheduler({ emit() {} }, {
    adapters: { get: () => adapter }, tasks: new TaskStore(dir),
    sessions: new SessionStore(join(dir, 'sessions.json')), config: { coiDataDir: dir },
  })
  let child
  let descendantPid
  const alive = (pid) => {
    try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }
  try {
    const task = scheduler.dispatch({ adapterId: adapter.id, prompt: 'local process fixture', scope: 'temporary' })
    assert.equal(task.ok, true)
    child = scheduler.running.get(task.taskId).process
    const [output] = await once(child.stdout, 'data')
    descendantPid = Number(output.toString().match(/CHILD:(\d+)/)?.[1])
    assert.ok(descendantPid > 0)
    assert.equal(alive(descendantPid), true)
    assert.equal(scheduler.cancel(task.taskId, { force: true }).ok, true)
    for (let i = 0; i < 20 && alive(descendantPid); i++) await delay(50)
    assert.equal(alive(descendantPid), false, 'cancel must terminate the CLI descendant as well as its wrapper')
  } finally {
    if (descendantPid && alive(descendantPid)) process.kill(descendantPid)
    if (child && child.exitCode === null) child.kill()
    scheduler.dispose()
    if (dirname(resolve(dir)) !== root) throw new Error('Unexpected fixture path')
    rmSync(dir, { recursive: true, force: true })
  }
})
