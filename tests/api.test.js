import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, SuggestionQueue } from '../lib/store.js'
import { installApi } from '../lib/api.js'
import { validateRuntimePatch } from '../lib/index.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-api-test-'))
}

/** Boot a real HTTP server over installApi's handler. */
async function bootApi(overrides = {}) {
  const dir = tempDir()
  const store = new MemoryStore(dir)
  const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
  const state = { reviewEnabled: true, reviewInterval: 10, reviewMode: 'suggest' }
  const getRuntime = () => ({ ...state })
  const updateRuntime = (patch) => {
    for (const [key, value] of Object.entries(patch)) validateRuntimePatch(key, value)
    Object.assign(state, patch)
    return { ...state }
  }
  const ctx = {
    httpServer: {
      register: ({ handler }) => {
        ctx.handler = handler
        return () => {}
      },
    },
  }
  installApi(ctx, { store, queue, getRuntime, updateRuntime })
  const server = createServer((req, res) => ctx.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, data }
  }
  return { base, queue, store, request, dir, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('api badge and suggestions endpoints', async () => {
  const api = await bootApi()
  try {
    const badge = await api.request('GET', '/memory-evolve/api/badge')
    assert.equal(badge.status, 200)
    assert.equal(badge.data.count, 0)
    api.queue.append({ time: 't', target: 'user', content: '候选记忆', reason: 'r', cwd: null })
    const badge2 = await api.request('GET', '/memory-evolve/api/badge')
    assert.equal(badge2.data.count, 1)
    const list = await api.request('GET', '/memory-evolve/api/suggestions')
    assert.equal(list.data.entries.length, 1)
    assert.equal(list.data.entries[0].content, '候选记忆')
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api approve/reject/approve-all/reject-all', async () => {
  const api = await bootApi()
  try {
    api.queue.append({ time: 't1', target: 'user', content: '第一条', reason: 'r', cwd: null })
    api.queue.append({ time: 't2', target: 'memory', content: '第二条', reason: 'r', cwd: null })
    const approve = await api.request('POST', '/memory-evolve/api/suggestions/approve', { indices: [1] })
    assert.equal(approve.status, 200)
    assert.equal(approve.data.remaining, 1)
    assert.equal(api.store.entriesOf('user').length, 1)
    const reject = await api.request('POST', '/memory-evolve/api/suggestions/reject', { indices: [1] })
    assert.equal(reject.data.remaining, 0)
    // approve-all on empty queue is a no-op
    const all = await api.request('POST', '/memory-evolve/api/suggestions/approve-all')
    assert.equal(all.status, 200)
    // invalid indices
    const bad = await api.request('POST', '/memory-evolve/api/suggestions/approve', { indices: [0] })
    assert.equal(bad.status, 400)
    const bad2 = await api.request('POST', '/memory-evolve/api/suggestions/approve', { indices: [] })
    assert.equal(bad2.status, 400)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api config get/update with validation', async () => {
  const api = await bootApi()
  try {
    const got = await api.request('GET', '/memory-evolve/api/config')
    assert.equal(got.data.config.reviewEnabled, true)
    const updated = await api.request('POST', '/memory-evolve/api/config', { patch: { reviewInterval: 5 } })
    assert.equal(updated.data.config.reviewInterval, 5)
    const bad = await api.request('POST', '/memory-evolve/api/config', { patch: { reviewInterval: 0 } })
    assert.equal(bad.status, 400)
    const unknown = await api.request('POST', '/memory-evolve/api/config', { patch: { nope: 1 } })
    assert.equal(unknown.status, 400)
    const notPatch = await api.request('POST', '/memory-evolve/api/config', { patch: [1] })
    assert.equal(notPatch.status, 400)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})

test('api 404 for unknown routes', async () => {
  const api = await bootApi()
  try {
    const res = await api.request('GET', '/memory-evolve/api/nope')
    assert.equal(res.status, 404)
  } finally {
    await api.close()
    rmSync(api.dir, { recursive: true, force: true })
  }
})
