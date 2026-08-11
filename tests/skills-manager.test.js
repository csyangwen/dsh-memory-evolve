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

/** A real catalog with a few skills (some protected, some non-invocable).
 * 每个技能在临时目录里建真实 SKILL.md（issue #6 方案 A：禁用需写文件
 * frontmatter 标记，测试技能必须有可写的本地文件）。 */
function makeCatalog() {
  const catalog = new Map()
  const dir = tempDir()
  const put = (name, source, invocation, opts = {}) => {
    const skillDir = join(dir, name)
    mkdirSync(skillDir, { recursive: true })
    const file = join(skillDir, 'SKILL.md')
    const description = opts.description ?? `${name} description`
    writeFileSync(file, `---\nname: ${name}\ndescription: "${description}"\n---\nBody text\n`)
    const skill = {
      name,
      description,
      whenToUse: `${name} when`,
      source,
      provider: 'test',
      invocation: invocation ?? { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: 'directory', path: skillDir },
      path: file,
      content: '',
    }
    catalog.set(name, skill)
    return skill
  }
  put('alpha', 'user-dsh')
  put('beta', 'bundled')
  put('gamma', 'project-dsh')
  const bravo = put('bravo', 'user-agents', { modelInvocable: false, userInvocable: true })
  return { catalog, put, bravo, dir }
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
  // issue #4：记录最近一次 skills.list 收到的 cwd，用于断言服务端把解析出的
  // 会话工作目录真正传给了技能扫描（列表/浏览/读/写共用）。
  let lastListCwd = null
  // issue #6：记录最近一次 skills.list 收到的 scope（preset 视图 scope），
  // 用于断言 260810 快照分层后管理界面确实按 preset scope 查询目录。
  let lastListScope = undefined

  const skillsService = {
    list: async (opts) => {
      lastListCwd = opts?.cwd ?? null
      lastListScope = opts?.scope
      return [...catalog.values()]
    },
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
    // issue #6：agentPresets 服务（260810 快照起 skill-local 按 preset scope
    // 分层，管理界面查询目录需带默认 preset 的 standing scope key）。
    // overrides.agentPresets 可传 null 模拟「无该服务的旧环境」。
    agentPresets: overrides.agentPresets === undefined
      ? { standingKeyFor: async () => ({ agentPreset: 'standard' }) }
      : overrides.agentPresets,
    get(name) {
      // 受限 ctx 的服务探测：未提供的服务返回 undefined（skills.js 同款模式）
      return ctx[name]
    },
    httpServer: {
      register: ({ handler }) => {
        ctx.handler = handler
        return () => {}
      },
    },
    workspace: overrides.workspace ?? { list: () => [] },
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

  installSkillsManager(ctx, { stateFile, legacyStateFile, resolveCwd: overrides.resolveCwd })
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
    lastListCwd: () => lastListCwd,
    lastListScope: () => lastListScope,
    close: () => new Promise((resolve) => server.close(resolve)),
    cleanup: () => { rmSync(dir, { recursive: true, force: true }) },
  }}

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

// issue #5：legacy 来源支持多候选（dsh-skill-browser / dsh-skills-manager 两种
// 旧插件目录命名都可能存在，用户按旧 README 装的是后者）；按顺序遍历，
// 取第一个含禁用列表的来源导入并持久化。
test('skills-manager: disabled list migrates from the first populated legacy candidate (issue #5)', async () => {
  const dir = tempDir()
  try {
    // 候选 1（dsh-skill-browser 命名）不存在；候选 2（dsh-skills-manager 命名）有数据
    const legacy1 = join(dir, 'legacy-skill-browser.json')
    const legacy2 = join(dir, 'legacy-skills-manager.json')
    writeFileSync(legacy2, JSON.stringify({ disabled: ['alpha'], customDirs: ['/custom/dir'] }))
    const stateFile = join(dir, 'skills-state.json')
    const sm = await bootSkillsManager({ legacyStateFile: [legacy1, legacy2], stateFile })
    try {
      const list = await sm.request('GET', '/skills-manager/api/skills')
      assert.equal(list.status, 200)
      assert.equal(list.data.skills.find((s) => s.name === 'alpha').disabled, true)
      // 迁移结果持久化到本仓 state 文件（含自定义目录）
      const state = JSON.parse(readFileSync(stateFile, 'utf8'))
      assert.deepEqual(state.disabled, ['alpha'])
      assert.deepEqual(state.customDirs, ['/custom/dir'])
    } finally {
      await sm.close()
      sm.cleanup()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// issue #5：多候选按顺序取第一个非空——候选 1 有数据时不再读取候选 2
test('skills-manager: first populated legacy candidate wins (issue #5)', async () => {
  const dir = tempDir()
  try {
    const legacy1 = join(dir, 'legacy-a.json')
    const legacy2 = join(dir, 'legacy-b.json')
    writeFileSync(legacy1, JSON.stringify({ disabled: ['alpha'], customDirs: [] }))
    writeFileSync(legacy2, JSON.stringify({ disabled: ['beta'], customDirs: [] }))
    const stateFile = join(dir, 'skills-state.json')
    const sm = await bootSkillsManager({ legacyStateFile: [legacy1, legacy2], stateFile })
    try {
      const list = await sm.request('GET', '/skills-manager/api/skills')
      assert.equal(list.status, 200)
      assert.equal(list.data.skills.find((s) => s.name === 'alpha').disabled, true)
      assert.equal(list.data.skills.find((s) => s.name === 'beta').disabled, false)
    } finally {
      await sm.close()
      sm.cleanup()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
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

// issue #4：cwd 解析顺序 = 显式 cwd 参数 → sessionId + resolveCwd → workspace[0] 兜底。
// 列表/浏览/读/写四个接口共用同一解析，且解析结果真正传给技能扫描。
test('skills-manager: cwd resolves from sessionId via resolveCwd (issue #4)', async () => {
  const sm = await bootSkillsManager({
    resolveCwd: (sessionId) => (sessionId === 'sess-1' ? '/proj/alpha' : undefined),
    workspace: { list: () => [{ path: '/ws/fallback' }] },
  })
  try {
    // 1) sessionId 命中 → 会话 cwd 生效，且真正传给 collectRoots 的技能扫描
    const list = await sm.request('GET', '/skills-manager/api/skills?sessionId=sess-1')
    assert.equal(list.status, 200)
    assert.equal(list.data.cwd, '/proj/alpha')
    assert.equal(sm.lastListCwd(), '/proj/alpha')
    // 2) 未知 sessionId（resolveCwd 无结果）→ 回落首个工作区
    const list2 = await sm.request('GET', '/skills-manager/api/skills?sessionId=unknown')
    assert.equal(list2.status, 200)
    assert.equal(list2.data.cwd, '/ws/fallback')
    // 3) 无任何参数 → 回落首个工作区（与原行为一致）
    const list3 = await sm.request('GET', '/skills-manager/api/skills')
    assert.equal(list3.status, 200)
    assert.equal(list3.data.cwd, '/ws/fallback')
    // 4) 显式 cwd 参数优先于 sessionId
    const list4 = await sm.request('GET', '/skills-manager/api/skills?cwd=/explicit&sessionId=sess-1')
    assert.equal(list4.status, 200)
    assert.equal(list4.data.cwd, '/explicit')
    // 5) browse/read/write 同样按 sessionId 解析（collectRoots 收到会话 cwd）
    await sm.request('GET', '/skills-manager/api/browse?root=%2Fany&path=&sessionId=sess-1')
    assert.equal(sm.lastListCwd(), '/proj/alpha')
    await sm.request('GET', '/skills-manager/api/read?path=%2Fany&sessionId=sess-1')
    assert.equal(sm.lastListCwd(), '/proj/alpha')
    await sm.request('PUT', '/skills-manager/api/write?path=%2Fany&sessionId=sess-1', 'x')
    assert.equal(sm.lastListCwd(), '/proj/alpha')
  } finally {
    await sm.close()
    sm.cleanup()
  }
})

// issue #4：未装配 resolveCwd 时（旧部署/独立测试），sessionId 被忽略，
// 行为与修复前完全一致（回退首个工作区）。
test('skills-manager: sessionId ignored when resolveCwd is not installed', async () => {
  const sm = await bootSkillsManager({
    workspace: { list: () => [{ path: '/ws/fallback' }] },
  })
  try {
    const list = await sm.request('GET', '/skills-manager/api/skills?sessionId=whatever')
    assert.equal(list.status, 200)
    assert.equal(list.data.cwd, '/ws/fallback')
  } finally {
    await sm.close()
    sm.cleanup()
  }
})

// issue #4：空工作区 + sessionId 命中 → 用会话 cwd；空工作区 + 无参数 → cwd 为 null。
test('skills-manager: empty workspace still resolves cwd from sessionId', async () => {
  const sm = await bootSkillsManager({
    resolveCwd: () => '/proj/alpha',
    workspace: { list: () => [] },
  })
  try {
    const list = await sm.request('GET', '/skills-manager/api/skills?sessionId=sess-1')
    assert.equal(list.status, 200)
    assert.equal(list.data.cwd, '/proj/alpha')
    const noSession = await sm.request('GET', '/skills-manager/api/skills')
    assert.equal(noSession.status, 200)
    assert.equal(noSession.data.cwd, null)
  } finally {
    await sm.close()
    sm.cleanup()
  }
})

// issue #4：resolveCwd 回调抛异常 → 静默回落首个工作区，接口不报错。
test('skills-manager: resolveCwd throwing falls back to workspace instead of failing', async () => {
  const sm = await bootSkillsManager({
    resolveCwd: () => { throw new Error('boom') },
    workspace: { list: () => [{ path: '/ws/fallback' }] },
  })
  try {
    const list = await sm.request('GET', '/skills-manager/api/skills?sessionId=sess-1')
    assert.equal(list.status, 200)
    assert.equal(list.data.cwd, '/ws/fallback')
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

// issue #6：260810 快照起 skill-local 注册在 agent preset 的 scope 层，无 scope
// 的 skills.list() 只读 global 层 → 技能管理列表空白。修复=列表/浏览/读/写/
// 禁用校验全部带默认 preset 的 standing scope key 查询目录。
test('skills-manager: catalog queries carry the default preset scope (issue #6)', async () => {
  const sm = await bootSkillsManager()
  try {
    // 1) 列表：list 收到默认 preset 的 scope key
    const list = await sm.request('GET', '/skills-manager/api/skills')
    assert.equal(list.status, 200)
    assert.deepEqual(sm.lastListScope(), { agentPreset: 'standard' })
    // 2) browse/read/write 同样带 scope（三个接口共用 collectRoots）
    await sm.request('GET', '/skills-manager/api/browse?root=%2Fany&path=')
    assert.deepEqual(sm.lastListScope(), { agentPreset: 'standard' })
    await sm.request('GET', '/skills-manager/api/read?path=%2Fany')
    assert.deepEqual(sm.lastListScope(), { agentPreset: 'standard' })
    await sm.request('PUT', '/skills-manager/api/write?path=%2Fany', 'x')
    assert.deepEqual(sm.lastListScope(), { agentPreset: 'standard' })
    // 3) 禁用/启用路径的存在性校验同样带 scope（否则任何技能都 404）
    const disable = await sm.request('POST', '/skills-manager/api/skills/disable', { name: 'alpha' })
    assert.equal(disable.status, 200)
    assert.deepEqual(sm.lastListScope(), { agentPreset: 'standard' })
  } finally {
    await sm.close()
    sm.cleanup()
  }
})

// issue #6：无 agentPresets 服务的环境（旧快照/TUI）→ scope 回退 undefined，
// 查询退化为无 scope（旧行为），接口仍正常返回。
test('skills-manager: no agentPresets service falls back to scopeless queries', async () => {
  const sm = await bootSkillsManager({ agentPresets: null })
  try {
    const list = await sm.request('GET', '/skills-manager/api/skills')
    assert.equal(list.status, 200)
    assert.equal(sm.lastListScope(), undefined)
    const disable = await sm.request('POST', '/skills-manager/api/skills/disable', { name: 'alpha' })
    assert.equal(disable.status, 200)
  } finally {
    await sm.close()
    sm.cleanup()
  }
})

// issue #6 方案 A：禁用落地为 SKILL.md frontmatter 的 disable-model-invocation
// 标记（skill-local 官方解析 → modelInvocable:false），不依赖 layer shadow。
test('skills-manager: disable writes the frontmatter flag, enable removes it (issue #6)', async () => {
  const sm = await bootSkillsManager()
  try {
    const alpha = sm.catalog.get('alpha')
    // 禁用：文件出现标记 + state 记录 + shadow 注册（catalog 目录被覆盖）
    const disable = await sm.request('POST', '/skills-manager/api/skills/disable', { name: 'alpha' })
    assert.equal(disable.status, 200)
    assert.equal(disable.data.disabled, true)
    const marked = readFileSync(alpha.path, 'utf8')
    assert.match(marked, /^disable-model-invocation: true$/m)
    // 其余 frontmatter 内容原样保留
    assert.match(marked, /^name: alpha$/m)
    assert.match(marked, /^Body text$/m)
    assert.equal(sm.catalog.get('alpha').invocation.modelInvocable, false)
    const state = JSON.parse(readFileSync(sm.stateFile, 'utf8'))
    assert.ok(state.disabled.includes('alpha'))
    // 再次禁用幂等（标记不重复）
    const again = await sm.request('POST', '/skills-manager/api/skills/disable', { name: 'alpha' })
    assert.equal(again.status, 200)
    const markedAgain = readFileSync(alpha.path, 'utf8')
    assert.equal(markedAgain.match(/^disable-model-invocation: true$/gm)?.length, 1)
    // 启用：标记移除 + state 清空 + shadow 恢复
    const enable = await sm.request('POST', '/skills-manager/api/skills/enable', { name: 'alpha' })
    assert.equal(enable.status, 200)
    const cleared = readFileSync(alpha.path, 'utf8')
    assert.doesNotMatch(cleared, /disable-model-invocation/)
    assert.equal(sm.catalog.get('alpha').invocation.modelInvocable, true)
    const stateAfter = JSON.parse(readFileSync(sm.stateFile, 'utf8'))
    assert.ok(!stateAfter.disabled.includes('alpha'))
  } finally {
    await sm.close()
    sm.cleanup()
  }
})

// issue #6 方案 A：bundled（安装目录）技能拒绝禁用；project 源维持拒绝。
test('skills-manager: bundled skills refuse disable, project skills stay protected', async () => {
  const sm = await bootSkillsManager()
  try {
    const bundled = await sm.request('POST', '/skills-manager/api/skills/disable', { name: 'beta' })
    assert.equal(bundled.status, 403)
    // bundled 文件未被改写
    const beta = sm.catalog.get('beta')
    assert.doesNotMatch(readFileSync(beta.path, 'utf8'), /disable-model-invocation/)
    const protectedSkill = await sm.request('POST', '/skills-manager/api/skills/disable', { name: 'gamma' })
    assert.equal(protectedSkill.status, 403)
    assert.doesNotMatch(readFileSync(sm.catalog.get('gamma').path, 'utf8'), /disable-model-invocation/)
  } finally {
    await sm.close()
    sm.cleanup()
  }
})

// issue #6 方案 A 懒迁移：预置 state.disabled 中「当前目录 modelInvocable 仍为
// true」的技能（shadow 被 scope 层覆盖的场景），装配时自动落地 frontmatter 标记。
test('skills-manager: stale disables migrate to frontmatter on boot (issue #6)', async () => {
  const dir = tempDir()
  try {
    const stateFile = join(dir, 'skills-state.json')
    // 预置：alpha 在禁用列表，但目录里 modelInvocable 仍为 true（模拟禁用失效）
    writeFileSync(stateFile, JSON.stringify({ disabled: ['alpha'], customDirs: [] }))
    const sm = await bootSkillsManager({ stateFile })
    try {
      const alpha = sm.catalog.get('alpha')
      const text = readFileSync(alpha.path, 'utf8')
      assert.match(text, /^disable-model-invocation: true$/m)
      // 已生效（shadow）的技能（bravo modelInvocable:false）不动文件
      const bravo = sm.catalog.get('bravo')
      assert.doesNotMatch(readFileSync(bravo.path, 'utf8'), /disable-model-invocation/)
      // UI disabled 显示仍来自 state 列表
      const list = await sm.request('GET', '/skills-manager/api/skills')
      assert.equal(list.data.skills.find((s) => s.name === 'alpha').disabled, true)
    } finally {
      await sm.close()
      sm.cleanup()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
