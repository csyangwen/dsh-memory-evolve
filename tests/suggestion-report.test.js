import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveStore, MemoryStore, SuggestionQueue } from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'
import { approveSuggestions, archiveSuggestions, rejectSuggestions } from '../lib/review.js'

/**
 * 待确认队列的报告契约：approve / reject / archive 都必须回报
 * `removedIndices`——**实际离开队列**的 1-based 序号。
 *
 * 背景（Web UI 卡顿修复）：报告原来只说「还剩几条」，说不清「具体删掉了哪
 * 几条」，客户端因此只能在每次操作后整块重拉 /api/suggestions 刷新列表。有了
 * 这个字段，客户端就能就地删掉那几行，不必再重拉。
 *
 * 字段的准确性命中两个真实故障模式：
 *   - 少报 → 界面上条目「点了没反应」，要等下次整块刷新才消失；
 *   - 多报 → 界面把写失败的条目吞掉（用户以为已存，实际还在队列里）。
 * 所以这里重点钉「写失败 / 归档失败 / 待办关闭」的条目必须留在队列且不进字段。
 */

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-suggestion-report-'))
}

function setup() {
  const dir = tempDir()
  return {
    dir,
    store: new MemoryStore(dir),
    todoStore: new TodoStore(dir),
    queue: new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl')),
    archive: new ArchiveStore(dir),
  }
}

test('approve 回报真正落地的序号；写失败的条目保留且不列入', () => {
  const { dir, store, todoStore, queue } = setup()
  try {
    queue.append({ time: 't1', target: 'user', content: '第一条', cwd: null })
    queue.append({ time: 't2', target: 'user', content: '第二条', cwd: null })
    queue.append({ time: 't3', target: 'user', content: '第三条', cwd: null })
    // 中间那条写失败：必须留在队列里，且不能出现在 removedIndices 中
    const failing = {
      add: (target, content) => {
        if (content === '第二条') throw new Error('boom')
        return store.add(target, content)
      },
    }
    const report = approveSuggestions(failing, todoStore, queue, [1, 2, 3], undefined)
    assert.deepEqual(report.removedIndices, [1, 3])
    assert.equal(report.remaining, 1)
    const left = queue.read()
    assert.equal(left.length, 1)
    assert.equal(left[0].content, '第二条', '写失败的条目必须留在队列中等待重试')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('approve 把重复建议算作已消费（计入 removedIndices）', () => {
  const { dir, store, todoStore, queue } = setup()
  try {
    store.add('memory', '同一条事实', undefined)
    queue.append({ time: 't1', target: 'memory', content: '同一条事实', cwd: null })
    const report = approveSuggestions(store, todoStore, queue, [1], undefined)
    assert.deepEqual(report.removedIndices, [1], '重复建议不再需要确认，必须离开队列')
    assert.equal(report.remaining, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reject 回报被删掉的原始序号（含跳号）', () => {
  const { dir, queue } = setup()
  try {
    for (const n of [1, 2, 3]) queue.append({ time: `t${n}`, target: 'user', content: `第${n}条`, cwd: null })
    const report = rejectSuggestions(queue, [1, 3])
    assert.deepEqual(report.removedIndices, [1, 3])
    assert.equal(report.removed, 2)
    assert.equal(report.remaining, 1)
    assert.equal(queue.read()[0].content, '第2条')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reject 忽略队列里不存在的序号（不虚报）', () => {
  const { dir, queue } = setup()
  try {
    queue.append({ time: 't1', target: 'user', content: '唯一一条', cwd: null })
    const report = rejectSuggestions(queue, [1, 5])
    assert.deepEqual(report.removedIndices, [1])
    assert.equal(report.remaining, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('archive 只回报归档成功的序号；写入失败的条目保留', () => {
  const { dir, queue, archive } = setup()
  try {
    queue.append({ time: 't1', target: 'memory', content: '甲', cwd: null })
    queue.append({ time: 't2', target: 'memory', content: '乙', cwd: null })
    const failing = {
      append: (target, content, cwd) => (content.includes('乙')
        ? { ok: false, message: 'disk full' }
        : archive.append(target, content, cwd)),
    }
    const report = archiveSuggestions(failing, queue, [1, 2])
    assert.deepEqual(report.removedIndices, [1])
    assert.equal(report.remaining, 1)
    const left = queue.read()
    assert.equal(left.length, 1)
    assert.equal(left[0].content, '乙', '归档失败的条目必须留在队列中')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('待办功能关闭时：待办建议保留、记忆建议照常处理', () => {
  const { dir, store, todoStore, queue } = setup()
  try {
    queue.append({ time: 't1', target: 'todo-work', content: '候选待办', cwd: null })
    queue.append({ time: 't2', target: 'user', content: '记忆事实', cwd: null })
    const report = approveSuggestions(store, todoStore, queue, [1, 2], undefined, undefined, undefined, {
      isTodoEnabled: () => false,
    })
    assert.deepEqual(report.removedIndices, [2], '待办关闭时 #1 必须留在队列里')
    const left = queue.read()
    assert.equal(left.length, 1)
    assert.equal(left[0].target, 'todo-work')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
