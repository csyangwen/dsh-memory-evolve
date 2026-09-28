import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveStore, MemoryStore, SuggestionQueue, projectHash } from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'
import { approveSuggestions, enqueueSuggestion, promoteArchived, suggestToolDefinition } from '../lib/review.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-review-key-'))
}

// Phase B (R2.1): memory_suggest accepts target=key, the queue keeps the cwd,
// and approval writes into the project's KEY.md (auto-injected track).
test('suggest target=key: schema accepts key, queue keeps cwd, approval writes KEY.md', async () => {
  const dir = tempDir()
  const projectDir = join(dir, 'proj')
  mkdirSync(projectDir, { recursive: true })
  try {
    const store = new MemoryStore(dir)
    const todoStore = new TodoStore(dir)
    const archive = new ArchiveStore(dir)
    const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
    const agent = { id: 'sess-key', session: { header: { cwd: projectDir } } }

    const tool = suggestToolDefinition({}, queue)
    // schema enum now includes key
    const targets = tool.parameters.properties.target
    assert.ok(Array.isArray(targets.enum) && targets.enum.includes('key'), 'key must be in the enum')

    // execute accepts target=key and enqueues
    const out = await tool.execute(
      { target: 'key', content: '导出脚本必须带 --utf8 才不丢 emoji', reason: '又一次在报表里出现 U+FFFD' },
      { agent },
    )
    assert.ok(out.ok, 'target=key suggestion must enqueue')
    assert.equal(out.queued, 1)

    // the queued entry carries the agent cwd (needed to resolve the project KEY.md)
    const entries = queue.read()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].target, 'key')
    assert.equal(entries[0].cwd, projectDir, 'key suggestion must record the session cwd')

    // approval writes into the project's KEY.md (hashed project dir, same as locate())
    const report = approveSuggestions(store, todoStore, archive, queue, [1], agent)
    assert.equal(report.remaining, 0)
    const keyFile = join(dir, 'projects', projectHash(projectDir), 'KEY.md')
    assert.ok(existsSync(keyFile), 'KEY.md must be created under the project dir')
    assert.ok(readFileSync(keyFile, 'utf8').includes('--utf8'), 'KEY.md must hold the approved content')

    // approval is also reachable from the API-side target override (memory -> key)
    enqueueSuggestion(queue, 'memory', '另一条全局事实', '理由')
    const override = new Map([[1, 'key']])
    approveSuggestions(store, todoStore, archive, queue, [1], agent, undefined, override)
    assert.ok(
      readFileSync(keyFile, 'utf8').includes('另一条全局事实'),
      'a memory suggestion re-classified to key must land in KEY.md',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Phase B (R2.2): the project track has an archive channel. The project main
// file is MEMORY.md (sitting beside KEY.md in the same project dir), so its
// archive must be a separate MEMORY-archive.md — never KEY-archive.md.
test('project archive channel: fileOf(project) resolves beside KEY-archive.md, not into it', () => {
  const dir = tempDir()
  const projectDir = join(dir, 'proj')
  mkdirSync(projectDir, { recursive: true })
  try {
    // no projectDirResolver injected: ArchiveStore falls back to projectHash(cwd),
    // same default MemoryStore.locate uses for a non-synced project
    const storeDir = join(dir, 'projects', projectHash(projectDir))

    const archive = new ArchiveStore(dir)
    // without a cwd the archive cannot know which project
    assert.throws(() => archive.fileOf('project'), /归档需要会话工作目录/)

    const file = archive.fileOf('project', projectDir)
    assert.equal(file, join(storeDir, 'MEMORY-archive.md'), 'project archive must sit beside the project MEMORY.md')
    assert.notEqual(file, join(storeDir, 'KEY-archive.md'), 'project archive must never be the KEY archive')

    // append + read round-trips, and stays out of the KEY archive
    archive.append('project', '[2026-09-25] 一次性交付路径，已过期', projectDir)
    assert.equal(archive.entriesOf('project', projectDir).length, 1)
    assert.equal(archive.entriesOf('key', projectDir).length, 0, 'KEY archive must stay empty')

    // remove round-trips too
    const rm = archive.remove('project', '一次性交付路径', projectDir)
    assert.ok(rm.ok)
    assert.equal(archive.entriesOf('project', projectDir).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Phase B (R2.2): an archived project entry can be promoted back into the
// project track (same round-trip as memory/user/key).
test('project archive promote: archived entry returns to the project track', () => {
  const dir = tempDir()
  const projectDir = join(dir, 'proj')
  mkdirSync(projectDir, { recursive: true })
  try {
    // no projectDirResolver: both stores fall back to projectHash(cwd)
    const storeDir = join(dir, 'projects', projectHash(projectDir))
    const store = new MemoryStore(dir)
    const todoStore = new TodoStore(dir)
    const archive = new ArchiveStore(dir)
    const agent = { session: { header: { cwd: projectDir } } }

    archive.append('project', '[2026-09-25] 口径：金额一律用分 not 元', projectDir)
    const outcome = promoteArchived(store, todoStore, archive, 'project', '金额一律用分', projectDir)
    assert.ok(outcome.ok, outcome.message)
    assert.equal(archive.entriesOf('project', projectDir).length, 0, 'promote must consume the archived entry')
    const projectFile = join(storeDir, 'MEMORY.md')
    assert.ok(readFileSync(projectFile, 'utf8').includes('金额一律用分'), 'content must be back in the project track')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// R2.2 revision: project cleanup goes through the queue as project-archive
// suggestions, NOT direct removes. Approval moves the entry (peek -> archive ->
// remove), and a failed removal rolls the archive write back.
test('project-archive suggestion: approval moves the entry into the archive, never deletes outright', async () => {
  const dir = tempDir()
  const projectDir = join(dir, 'proj')
  mkdirSync(projectDir, { recursive: true })
  try {
    const store = new MemoryStore(dir)
    const todoStore = new TodoStore(dir)
    const archive = new ArchiveStore(dir)
    const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
    const agent = { id: 'sweep', session: { header: { cwd: projectDir } } }

    store.add('project', '2026-08-30 一次性导出脚本路径 /tmp/x.py，早已不用', agent)
    store.add('project', '2026-09-20 口径：金额一律用分 not 元', agent)
    const storeDir = join(dir, 'projects', projectHash(projectDir))
    assert.equal(store.entriesOf('project', agent).length, 2)

    // the model proposes archiving the stale entry via the queue
    const tool = suggestToolDefinition({}, queue)
    const out = await tool.execute(
      { target: 'project-archive', content: '一次性导出脚本路径', reason: '一次性交付路径，项目已不再做' },
      { agent },
    )
    assert.ok(out.ok, 'project-archive suggestion must enqueue')

    // approval moves it: gone from the project track, present in the archive
    const report = approveSuggestions(store, todoStore, archive, queue, [1], agent)
    assert.equal(report.remaining, 0)
    assert.equal(store.entriesOf('project', agent).length, 1, 'the swept entry must leave the project track')
    assert.equal(archive.entriesOf('project', projectDir).length, 1, 'the swept entry must land in the archive')
    const archived = archive.entriesOf('project', projectDir)[0]
    assert.ok(archived.includes('一次性导出脚本路径'), 'the archive must hold the original entry text')
    assert.ok(!archived.includes('金额一律用分'), 'the conclusion must still be in the project track')
    assert.ok(readFileSync(join(storeDir, 'MEMORY.md'), 'utf8').includes('金额一律用分'))

    // the archived entry restores cleanly (promote uses the same substring match)
    const back = promoteArchived(store, todoStore, archive, 'project', '一次性导出脚本路径', projectDir)
    assert.ok(back.ok, back.message)
    assert.equal(store.entriesOf('project', agent).length, 2, 'promote must return the entry to the project track')
    assert.equal(archive.entriesOf('project', projectDir).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// no-match and multi-match must NOT delete anything — the suggestion stays queued
test('project-archive suggestion: ambiguous match keeps the entry and re-queues', async () => {
  const dir = tempDir()
  const projectDir = join(dir, 'proj')
  mkdirSync(projectDir, { recursive: true })
  try {
    const store = new MemoryStore(dir)
    const todoStore = new TodoStore(dir)
    const archive = new ArchiveStore(dir)
    const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
    const agent = { id: 'sweep2', session: { header: { cwd: projectDir } } }

    store.add('project', '重复关键词 abc 第一条', agent)
    store.add('project', '重复关键词 abc 第二条', agent)

    const tool = suggestToolDefinition({}, queue)
    await tool.execute(
      { target: 'project-archive', content: '重复关键词', reason: '过期' },
      { agent },
    )
    const report = approveSuggestions(store, todoStore, archive, queue, [1], agent)
    // ambiguous match: nothing moved, suggestion stays for the user to refine
    assert.equal(store.entriesOf('project', agent).length, 2, 'ambiguous match must not delete anything')
    assert.equal(archive.entriesOf('project', projectDir).length, 0, 'ambiguous match must not archive anything')
    assert.equal(report.remaining, 1, 'the suggestion stays queued on failure')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// without a cwd the suggestion cannot resolve a project and stays queued
test('project-archive suggestion: missing cwd keeps the suggestion queued', async () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    const todoStore = new TodoStore(dir)
    const archive = new ArchiveStore(dir)
    const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))

    const tool = suggestToolDefinition({}, queue)
    await tool.execute(
      { target: 'project-archive', content: '某条', reason: '过期' },
      {},
    )
    const report = approveSuggestions(store, todoStore, archive, queue, [1], undefined)
    assert.equal(report.remaining, 1, 'a cwd-less project-archive suggestion stays queued')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
