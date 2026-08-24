import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, SuggestionQueue } from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'
import { approveSuggestions, enqueueSuggestion } from '../lib/review.js'
import { setLocale, getLocale, translate, REVIEW_CMD_DICT } from '../lib/i18n.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-review-i18n-'))
}

test('duplicate suggestions report as skipped (not failed) in every locale', () => {
  const dir = tempDir()
  const prevLocale = getLocale()
  try {
    const store = new MemoryStore(dir)
    const todoStore = new TodoStore(dir)
    const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
    enqueueSuggestion(queue, 'memory', 'Env fact A', 'because')
    store.add('memory', 'Env fact A', undefined) // the suggestion now duplicates the stored entry

    for (const locale of ['en', 'zh']) {
      setLocale(locale)
      // Re-enqueue for the second pass (the first approval consumed it).
      if (locale !== 'en') enqueueSuggestion(queue, 'memory', 'Env fact B', 'because')
      if (locale === 'zh') store.add('memory', 'Env fact B', undefined)

      const expectedLine = translate(REVIEW_CMD_DICT, 'reviewcmd.existsSkip', { n: 1, target: 'memory' }, locale)
      const report = approveSuggestions(store, todoStore, queue, [1], undefined)
      assert.equal(report.lines.length, 1)
      assert.equal(
        report.lines[0],
        expectedLine,
        `[${locale}] duplicate must render as skipped`,
      )
      assert.equal(
        report.remaining, 0, `[${locale}] duplicates are consumed`,
      )
    }
  } finally {
    setLocale(prevLocale)
    rmSync(dir, { recursive: true, force: true })
  }
})
