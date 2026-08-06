import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSkillsManager } from '../lib/skills-manager.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-skills-test-'))
}

/** A real catalog with a few skills (some protected, some non-invocable). */
function makeCatalog() {
  const catalog = new Map()
  const put = (name, source, invocation) => {
    const skill = {
      name,
      description: `${name} description`,
      whenToUse: `${name} when`,
      source,
      provider: 'test',
      invocation: invocation ?? { modelInvocable: true, userInvocable: true },
      resourceBase: null,
      path: null,
      content: '',
    }
    catalog.set(name, skill)
    return skill
  }
  put('alpha', 'user-dsh')
  put('beta', 'bundled')
  put('gamma', 'project-dsh')
  const bravo = put('bravo', 'user-agents', { modelInvocable: false, userInvocable: true })
  return { catalog, put, bravo }
}

/**
 * Boot the skills manager over a fake cordis context with a real HTTP
 * server. `legacyStateFile` defaults to an absent path (no migration).
 */
async function bootSkillsManager(overrides = {}) {
  const dir = tempDir()
  const { catalog, put, bravo } = makeCatalog()
  const stateFile = overrides.stateFile ?? join(dir, 'skills-state.json')
  const legacyStateFile = overrides.legacyStateFile ?? join(dir, 'no-legacy.json')
  const disposers = []
  const changeListeners = []
  let providerCtl = null
  const realSkills = new Map()

  const skillsService = {
    list: async () => [...catalog.values()],
    get: async (name) => catalog.get(name),
    register: (skill) => {
      // Shadow registration: overwrite the same-named catalog entry, restore on dispose.
      const existing = catalog.get(skill.name)
      realSkills.set(skill.name, skill)
      if (existing !== undefined) {
        catalog.set(skill.name, {
          ...existing,
          invocation: skill.invocation,
          source: skill.source,
          provider: skill.provider,
        })
        return () => {
          catalog.set(skill.name, existing)
          realSkills.delete(skill.name)
        }
      }
      return () => { realSkills.delete(skill.name) }
    },
    registerProvider: (cb) => {
      providerCtl = cb({ invalidate: () => {} })
      return () => {}
    },
  }

  const ctx = {
    skills: skillsService,
    httpServer: {
      register: ({ handler }) => {
        ctx.handler = handler
        return () => {}
      },
    },
    workspace: { list: () => [] },
    logger: { warn: () => {} },
    inject(deps, cb) {
      for (const dep of deps) assert.ok(ctx[dep] !== undefined, `missing fake service ${dep}`)
      const disposer = cb(ctx)
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    on(event, cb) {
      changeListeners.push(cb)
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
  }

  installSkillsManager(ctx, { stateFile, legacyStateFile })
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
  return {
    base, catalog, put, bravo, stateFile, changeListeners, providerCtl, request,
    close: () => new Promise((resolve) => server.close(resolve)),
    cleanup: () => { rmSync(dir, { recursive: true, force: true }) },
  }
}

test('skills-manager: disabled list migrates once from the standalone plugin state', async () => {
  const dir = tempDir()
  try {
    const legacy = join(dir, 'legacy.json')
    writeFileSync(legacy, JSON.stringify({ disabled: ['alpha', 'beta'], customDirs: [] }))
    const stateFile = join(dir, 'skills-state.json')
    const sm = await bootSkillsManager({ legacyStateFile: legacy, stateFile })
    try {
      const list = await sm.request('GET', '/skills-manager/api/skills')
      assert.equal(list.status, 200)
      const alpha = list.data.skills.find((s) => s.name === 'alpha')
      const beta = list.data.skills.find((s) => s.name === 'beta')
      assert.equal(alpha.disabled, true)
      assert.equal(beta.disabled, true)
      assert.equal(list.data.skills.find((s) => s.name === 'gamma').disabled, false)
      // Migration persisted: a fresh boot reads the new state file, not the legacy one.
      const state = JSON.parse(readFileSync(stateFile, 'utf8'))
      assert.deepEqual(state.disabled, ['alpha', 'beta'])
    } finally {
      await sm.close()
      sm.cleanup()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skills-manager: no migration when legacy state is absent', async () => {
  const sm = await bootSkillsManager()
  try {
    const list = await sm.request('GET', '/skills-manager/api/skills')
    assert.equal(list.status, 200)
    assert.ok(list.data.skills.every((s) => s.disabled === false))
  } finally {
    await sm.close()
    sm.cleanup()
  }
})

test('skills-manager: skills list marks protected and non-invocable skills', async () => {
  const sm = await bootSkillsManager()
  try {
    const list = await sm.request('GET', '/skills-manager/api/skills')
    const gamma = list.data.skills.find((s) => s.name === 'gamma')
    const bravo = list.data.skills.find((s) => s.name === 'bravo')
    assert.equal(gamma.protected, true)
    assert.equal(bravo.invocable, false)
    assert.equal(list.data.cwd, null)
  } finally {
    await sm.close()
    sm.cleanup()
  }
})

test('skills-manager: disable shadows the skill, enable restores it', async () => {
  const sm = await bootSkillsManager()
  try {
    const disable = await sm.request('POST', '/skills-manager/api/skills/disable', { name: 'alpha' })
    assert.equal(disable.status, 200)
    assert.equal(disable.data.disabled, true)
    // The shadow replaced the catalog entry: modelInvocable is now false.
    assert.equal(sm.catalog.get('alpha').invocation.modelInvocable, false)
    // Disable is idempotent.
    const again = await sm.request('POST', '/skills-manager/api/skills/disable', { name: 'alpha' })
    assert.equal(again.status, 200)
    const enable = await sm.request('POST', '/skills-manager/api/skills/enable', { name: 'alpha' })
    assert.equal(enable.status, 200)
    assert.equal(sm.catalog.get('alpha').invocation.modelInvocable, true)
    // Enable on a non-disabled skill is a no-op.
    const noop = await sm.request('POST', '/skills-manager/api/skills/enable', { name: 'beta' })
    assert.equal(noop.status, 200)
  } finally {
    await sm.close()
    sm.cleanup()
  }
})

test('skills-manager: unknown skills 404, protected skills 403', async () => {
  const sm = await bootSkillsManager()
  try {
    const unknown = await sm.request('POST', '/skills-manager/api/skills/disable', { name: 'nope' })
    assert.equal(unknown.status, 404)
    const protectedSkill = await sm.request('POST', '/skills-manager/api/skills/disable', { name: 'gamma' })
    assert.equal(protectedSkill.status, 403)
    // The protected skill was NOT shadowed.
    assert.equal(sm.catalog.get('gamma').invocation.modelInvocable, true)
    const bad = await sm.request('POST', '/skills-manager/api/skills/disable', { name: '' })
    assert.equal(bad.status, 400)
  } finally {
    await sm.close()
    sm.cleanup()
  }
})

test('skills-manager: custom skill dirs add/list/remove with SKILL.md scanning', async () => {
  const sm = await bootSkillsManager()
  try {
    // A custom dir with one valid SKILL.md and one invalid flat file.
    const skillsDir = join(sm.stateFile, '..', 'custom-skills')
    const bundle = join(skillsDir, 'my-skill')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(bundle, 'SKILL.md'), '---\nname: my-skill\ndescription: A custom skill\n---\nBody text\n')
    const dirs = await sm.request('GET', '/skills-manager/api/dirs')
    assert.equal(dirs.status, 200)
    assert.equal(dirs.data.dirs.length, 0)

    const add = await sm.request('POST', '/skills-manager/api/dirs', { path: skillsDir })
    assert.equal(add.status, 200)
    const dirs2 = await sm.request('GET', '/skills-manager/api/dirs')
    assert.equal(dirs2.data.dirs.length, 1)
    assert.equal(dirs2.data.dirs[0].exists, true)
    assert.equal(dirs2.data.dirs[0].skillCount, 1)

    // Duplicate add is rejected; missing dir rejected.
    const dup = await sm.request('POST', '/skills-manager/api/dirs', { path: skillsDir })
    assert.equal(dup.status, 400)
    const missing = await sm.request('POST', '/skills-manager/api/dirs', { path: join(skillsDir, 'nope') })
    assert.equal(missing.status, 400)

    const del = await sm.request('DELETE', `/skills-manager/api/dirs?path=${encodeURIComponent(realpathSync(skillsDir))}`)
    assert.equal(del.status, 200)
    const dirs3 = await sm.request('GET', '/skills-manager/api/dirs')
    assert.equal(dirs3.data.dirs.length, 0)
    const delAgain = await sm.request('DELETE', `/skills-manager/api/dirs?path=${encodeURIComponent(realpathSync(skillsDir))}`)
    assert.equal(delAgain.status, 404)
  } finally {
    await sm.close()
    sm.cleanup()
  }
})

test('skills-manager: file browse/read stays root-scoped', async () => {
  const sm = await bootSkillsManager()
  try {
    const root = join(sm.stateFile, '..', 'root-dir')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'notes.md'), 'hello world\n')
    // No skill resourceBase points at root-dir, so it is not a browsable root.
    const browse = await sm.request('GET', `/skills-manager/api/browse?root=${encodeURIComponent(root)}&path=`)
    assert.equal(browse.status, 403)
    // Reading a file outside the roots is refused.
    const read = await sm.request('GET', `/skills-manager/api/read?path=${encodeURIComponent(join(root, 'notes.md'))}`)
    assert.equal(read.status, 404)
    // Unknown endpoint → 404.
    const unknown = await sm.request('GET', '/skills-manager/api/whatever')
    assert.equal(unknown.status, 404)
  } finally {
    await sm.close()
    sm.cleanup()
  }
})
