import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-review-tools-test-'))
}

function once(fn) {
  let active = true
  return () => {
    if (!active) return
    active = false
    return fn?.()
  }
}

function fakeCtx({ web = false } = {}) {
  const state = {
    tools: [],
    contexts: [],
    commands: [],
    routes: [],
    listeners: {},
    effects: [],
    registrationAttempts: new Map(),
    disposalCalls: new Map(),
    failReviewStatusRegistration: false,
  }
  const services = {
    tools: {
      register(def) {
        state.registrationAttempts.set(def.name, (state.registrationAttempts.get(def.name) ?? 0) + 1)
        if (def.name === 'memory_review_status' && state.failReviewStatusRegistration) {
          throw new Error('injected review-status registration failure')
        }
        state.tools.push(def)
        return once(() => {
          state.disposalCalls.set(def.name, (state.disposalCalls.get(def.name) ?? 0) + 1)
          const index = state.tools.indexOf(def)
          if (index >= 0) state.tools.splice(index, 1)
        })
      },
      get: () => undefined,
    },
    systemPrompt: {
      context(def) {
        state.contexts.push(def)
        return once(() => {
          const index = state.contexts.indexOf(def)
          if (index >= 0) state.contexts.splice(index, 1)
        })
      },
    },
    commands: {
      register(def) {
        state.commands.push(def)
        return once(() => {
          const index = state.commands.indexOf(def)
          if (index >= 0) state.commands.splice(index, 1)
        })
      },
    },
  }
  if (web) {
    services.webServer = {
      register(route) {
        state.routes.push(route)
        return once(() => {
          const index = state.routes.indexOf(route)
          if (index >= 0) state.routes.splice(index, 1)
        })
      },
    }
  }

  const ctx = {
    state,
    tools: services.tools,
    systemPrompt: services.systemPrompt,
    commands: services.commands,
    webServer: services.webServer,
    on(name, listener) {
      ;(state.listeners[name] ??= []).push(listener)
      return once(() => {
        const index = state.listeners[name].indexOf(listener)
        if (index >= 0) state.listeners[name].splice(index, 1)
      })
    },
    inject(deps, callback) {
      if (!deps.every((dep) => services[dep] !== undefined)) return { dispose: () => {} }
      const dispose = callback(ctx)
      return { dispose: once(dispose) }
    },
    effect(fn) {
      const dispose = once(fn())
      state.effects.push(dispose)
      return dispose
    },
    get: (key) => services[key],
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  return ctx
}

function toolCount(ctx, name) {
  return ctx.state.tools.filter((tool) => tool.name === name).length
}

function snapshotText(ctx, cwd) {
  const snapshot = ctx.state.contexts.find((context) => context.name === 'memory:snapshot')
  assert.ok(snapshot, 'memory snapshot registered')
  return snapshot.text({ agent: { id: 'main', session: { header: { cwd } } } })
}

function assertReviewSurface(ctx, cwd, enabled) {
  const expectedCount = enabled ? 1 : 0
  assert.equal(toolCount(ctx, 'memory_suggest'), expectedCount)
  assert.equal(toolCount(ctx, 'memory_review_status'), expectedCount)
  const snapshot = snapshotText(ctx, cwd)
  assert.equal(snapshot.includes('memory_suggest'), enabled)
  assert.equal(snapshot.includes('memory_review_status'), enabled)
}

function disposeCtx(ctx) {
  for (let index = ctx.state.effects.length - 1; index >= 0; index -= 1) {
    try { ctx.state.effects[index]() } catch { /* best-effort test cleanup */ }
  }
}

async function startApi(ctx) {
  const route = ctx.state.routes.find((candidate) => candidate.path === '/memory-evolve')
  assert.ok(route, 'memory-evolve API registered')
  const server = createServer((req, res) => route.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (method, body) => {
    const response = await fetch(`${base}/memory-evolve/api/config`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  return {
    config: () => request('GET'),
    patch: (patch) => request('POST', { patch }),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('runtime review toggle keeps the paired tools and snapshot atomic', async () => {
  const dir = tempDir()
  const stateFile = join(dir, 'plugin-state.json')
  const initialState = { reviewEnabled: false, searchDocsEnabled: false }
  writeFileSync(stateFile, `${JSON.stringify(initialState, null, 2)}\n`)
  const ctx = fakeCtx({ web: true })
  apply(ctx, { memoryDir: dir, reviewEnabled: false })
  const api = await startApi(ctx)
  try {
    assertReviewSurface(ctx, dir, false)

    // The real panel posts all config keys together. If the second review-tool
    // registration fails, no unrelated key may be committed without its
    // controller sync running.
    ctx.state.failReviewStatusRegistration = true
    const failed = await api.patch({ reviewEnabled: true, searchDocsEnabled: true })
    assert.equal(failed.status, 400)
    assert.match(failed.body.error, /injected review-status registration failure/)
    assertReviewSurface(ctx, dir, false)
    assert.equal(toolCount(ctx, 'memory_evolve_search_local_files'), 0)
    assert.equal(ctx.state.disposalCalls.get('memory_suggest'), 1, 'partial registration rolled back')
    const afterFailure = await api.config()
    assert.equal(afterFailure.body.config.reviewEnabled, false)
    assert.equal(afterFailure.body.config.searchDocsEnabled, false)
    assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), initialState)

    // A persistence failure happens after successful tool staging. It must
    // restore the old pair and leave the same mixed patch wholly uncommitted.
    ctx.state.failReviewStatusRegistration = false
    const blockedTemp = `${stateFile}.tmp.${process.pid}`
    mkdirSync(blockedTemp)
    let persistFailed
    try {
      persistFailed = await api.patch({ reviewEnabled: true, searchDocsEnabled: true })
    } finally {
      rmSync(blockedTemp, { recursive: true, force: true })
    }
    assert.equal(persistFailed.status, 400)
    assertReviewSurface(ctx, dir, false)
    assert.equal(toolCount(ctx, 'memory_evolve_search_local_files'), 0)
    const afterPersistFailure = await api.config()
    assert.equal(afterPersistFailure.body.config.reviewEnabled, false)
    assert.equal(afterPersistFailure.body.config.searchDocsEnabled, false)
    assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), initialState)

    const enabled = await api.patch({ reviewEnabled: true })
    assert.equal(enabled.status, 200)
    assert.equal(enabled.body.config.reviewEnabled, true)
    assertReviewSurface(ctx, dir, true)

    const attemptsAfterEnable = new Map(ctx.state.registrationAttempts)
    const repeatedEnable = await api.patch({ reviewEnabled: true })
    assert.equal(repeatedEnable.status, 200)
    assert.deepEqual(ctx.state.registrationAttempts, attemptsAfterEnable, 'same-state enable is a registration no-op')
    assertReviewSurface(ctx, dir, true)

    const disabled = await api.patch({ reviewEnabled: false })
    assert.equal(disabled.status, 200)
    assertReviewSurface(ctx, dir, false)
    const disposalsAfterDisable = new Map(ctx.state.disposalCalls)

    const repeatedDisable = await api.patch({ reviewEnabled: false })
    assert.equal(repeatedDisable.status, 200)
    assert.deepEqual(ctx.state.disposalCalls, disposalsAfterDisable, 'same-state disable is a disposal no-op')
    assertReviewSurface(ctx, dir, false)

    const suggestAttemptsBeforeReenable = ctx.state.registrationAttempts.get('memory_suggest')
    const statusAttemptsBeforeReenable = ctx.state.registrationAttempts.get('memory_review_status')
    const reenabled = await api.patch({ reviewEnabled: true })
    assert.equal(reenabled.status, 200)
    assertReviewSurface(ctx, dir, true)
    assert.equal(ctx.state.registrationAttempts.get('memory_suggest'), suggestAttemptsBeforeReenable + 1)
    assert.equal(ctx.state.registrationAttempts.get('memory_review_status'), statusAttemptsBeforeReenable + 1)
  } finally {
    await api.close()
    disposeCtx(ctx)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persisted reviewEnabled is the initial source of truth over static config', () => {
  const cases = [
    { config: false, persisted: true, expected: true },
    { config: true, persisted: false, expected: false },
  ]
  for (const item of cases) {
    const dir = tempDir()
    const ctx = fakeCtx()
    try {
      writeFileSync(join(dir, 'plugin-state.json'), `${JSON.stringify({ reviewEnabled: item.persisted }, null, 2)}\n`)
      apply(ctx, { memoryDir: dir, reviewEnabled: item.config })
      assertReviewSurface(ctx, dir, item.expected)
    } finally {
      disposeCtx(ctx)
      rmSync(dir, { recursive: true, force: true })
    }
  }
})
