/**
 * search-docs 本地文档检索：provider 架构、工具/命令定义、控制器测试。
 * 零真实磁盘依赖（walk 用临时目录；外部命令层不测）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  SearchAborted, createSearchDocsController, createSearcher, defaultRoots,
  isAllTypes, matchQuery, normalizeExts, renderSearchResult, resolveProviders,
  searchDocsCommand, searchDocsToolDefinition,
} from '../lib/search-docs.js'

/** 快速构造一个已解析的插件配置。 */
function baseConfig(overrides = {}) {
  return {
    memoryDir: '/tmp',
    searchDocsEnabled: false,
    searchDocsToolName: 'memory_evolve_search_local_files',
    searchDocsCommandName: 'memory_evolve_search_files',
    searchDocsExts: ['md'],
    searchDocsProviders: 'auto',
    searchDocsCacheTtlMs: 3600000,
    searchDocsTimeoutMs: 60000,
    searchDocsCacheFile: join('/tmp', 'search-docs-index.json'),
    ...overrides,
  }
}

test('normalizeExts：数组/字符串/去点/小写/去重；* 表示全部', () => {
  assert.deepEqual(normalizeExts(['.MD', 'docx', 'md'], ['md']), ['md', 'docx'])
  assert.deepEqual(normalizeExts('pdf, .TXT ,', ['md']), ['pdf', 'txt'])
  assert.deepEqual(normalizeExts(undefined, ['md']), ['md'])
  // "*" 合法（全类型）；非法输入丢弃
  assert.deepEqual(normalizeExts(['*', '../x'], ['md']), ['*'])
  assert.deepEqual(normalizeExts('*', ['md']), ['*'])
  assert.deepEqual(normalizeExts(['all'], ['md']), ['all'])
})

test('isAllTypes：* 或 all 表示全类型', () => {
  assert.equal(isAllTypes(['*']), true)
  assert.equal(isAllTypes(['all']), true)
  assert.equal(isAllTypes(['md', '*']), true)
  assert.equal(isAllTypes(['md']), false)
  assert.equal(isAllTypes([]), false)
})

test('matchQuery：大小写不敏感子串；空 query 全匹配', () => {
  assert.equal(matchQuery('写小说review.txt', '写小说'), true)
  assert.equal(matchQuery('README.md', 'readme'), true)
  assert.equal(matchQuery('README.md', 'review'), false)
  assert.equal(matchQuery('anything.md', ''), true)
})

test('defaultRoots：始终包含主目录；darwin 包含 /Volumes', () => {
  const roots = defaultRoots('darwin')
  assert.ok(roots.length >= 1)
  assert.ok(roots.includes(homedir()))
  // darwin 上真实 /Volumes 存在
  assert.ok(existsSync('/Volumes'))
  const winRoots = defaultRoots('win32')
  assert.ok(winRoots.includes(homedir()))
})

test('resolveProviders：auto 按平台排序并探测（本机 darwin → mdfind 优先）', () => {
  const chain = resolveProviders(baseConfig(), 'darwin')
  const names = chain.map((p) => p.name)
  assert.ok(names[0] === 'mdfind', `期望 mdfind 优先，实际 ${names.join(',')}`)
  assert.ok(names.includes('walk'))
  // 显式顺序
  const explicit = resolveProviders(baseConfig({ searchDocsProviders: ['rg', 'walk'] }), 'darwin')
  assert.deepEqual(explicit.map((p) => p.name), ['rg', 'walk'])
  // 未知 provider 报错
  assert.throws(() => resolveProviders(baseConfig({ searchDocsProviders: ['nope'] }), 'darwin'))
})

test('工具定义：契约字段固定；execute 清洗参数并透传结果', async () => {
  const calls = []
  const fakeSearch = async (params) => {
    calls.push(params)
    return { provider: 'fake', results: [{ path: '/x/README.md', name: 'README.md', mtime: 1000, size: 10 }] }
  }
  const def = searchDocsToolDefinition(baseConfig(), fakeSearch)
  assert.equal(def.name, 'memory_evolve_search_local_files')
  assert.ok(def.description.includes('文件名'))
  // output schema 为合法 DSH JSON Schema（无 property 级 required 布尔）
  assert.equal(def.output.schema.type, 'object')
  assert.equal(def.output.schema.properties.results.type, 'array')
  assert.equal(def.output.schema.properties.results.items.type, 'object')
  assert.ok(Array.isArray(def.output.schema.properties.results.items.required))
  assert.equal(typeof def.output.render, 'function')
  const out = await def.execute({ query: ' readme ', exts: 'md, .DOCX', limit: 5 }, { agent: { session: { header: { cwd: '/tmp' } } } })
  assert.equal(out.ok, true)
  assert.equal(out.results.length, 1)
  assert.deepEqual(calls[0].exts, ['md', 'docx'])
  assert.equal(calls[0].query, 'readme')
  // limit 钳制
  await def.execute({ limit: 9999 }, {})
  assert.equal(calls[1].limit, 100)
  await def.execute({ limit: 0 }, {})
  assert.equal(calls[2].limit, 1)
  // 搜索抛错 → ok:false
  const bad = searchDocsToolDefinition(baseConfig(), async () => { throw new Error('boom') })
  const failed = await bad.execute({}, {})
  assert.equal(failed.ok, false)
  assert.match(failed.message, /boom/)
})

test('工具 execute：allTypes 确认参数与 type=dir/all 透传', async () => {
  const calls = []
  const def = searchDocsToolDefinition(baseConfig(), async (params) => {
    calls.push(params)
    return { provider: 'fake', results: [] }
  })
  // 不传类型参数 → 默认文档扩展名（安全，绝不静默全盘）
  await def.execute({}, {})
  assert.deepEqual(calls[0].exts, ['md'])
  assert.equal(calls[0].kind, 'file')
  // allTypes=true → 全类型（忽略 exts）
  await def.execute({ allTypes: true, exts: ['md'] }, {})
  assert.deepEqual(calls[1].exts, ['*'])
  assert.equal(calls[1].kind, 'file')
  // exts=["*"] 等价全类型
  await def.execute({ exts: ['*'] }, {})
  assert.deepEqual(calls[2].exts, ['*'])
  // type=dir / type=all
  await def.execute({ type: 'dir', query: '年终' }, {})
  assert.equal(calls[3].kind, 'dir')
  await def.execute({ type: 'all', query: '年终' }, {})
  assert.equal(calls[4].kind, 'any')
})

test('工具 execute：AbortSignal 中止返回"索引构建中"语义', async () => {
  const def = searchDocsToolDefinition(baseConfig(), async () => { throw new SearchAborted('本地索引构建中，请稍后重试') })
  const out = await def.execute({}, {})
  assert.equal(out.ok, false)
  assert.match(out.message, /索引构建中/)
})

test('renderSearchResult：命中/空/错误三种形态', () => {
  const hit = renderSearchResult({ ok: true, provider: 'mdfind', count: 1, truncated: false, results: [{ path: '/a/b.md', name: 'b.md', mtime: 1700000000000, size: 2048 }] })
  assert.match(hit, /\/a\/b\.md/)
  assert.match(hit, /2\.0 KB/)
  const empty = renderSearchResult({ ok: true, provider: 'rg', count: 0, truncated: false, results: [] })
  assert.match(empty, /没有找到/)
  const err = renderSearchResult({ ok: false, message: '索引构建中' })
  assert.match(err, /索引构建中/)
})

test('walk provider：临时目录真实扫描 + 忽略目录 + query 过滤', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-test-'))
  try {
    mkdirSync(join(dir, 'docs'))
    mkdirSync(join(dir, 'docs', 'node_modules'))
    mkdirSync(join(dir, 'docs', '.git'))
    mkdirSync(join(dir, 'other'))
    writeFileSync(join(dir, 'docs', '写小说review.md'), 'x')
    writeFileSync(join(dir, 'docs', 'README.md'), 'x')
    writeFileSync(join(dir, 'docs', 'node_modules', 'ignored.md'), 'x')
    writeFileSync(join(dir, 'docs', '.git', 'ignored2.md'), 'x')
    writeFileSync(join(dir, 'other', 'notes.txt'), 'x')
    writeFileSync(join(dir, 'other', 'photo.jpg'), 'x')
    const config = baseConfig({ searchDocsCacheFile: join(dir, 'index.json') })
    const search = createSearcher({ ...config, searchDocsProviders: ['walk'] })
    // 指定 dir：不走缓存
    const byQuery = await search({ query: '写小说', exts: ['md'], dir, limit: 10 }, undefined)
    assert.equal(byQuery.provider, 'walk')
    assert.deepEqual(byQuery.results.map((r) => r.name), ['写小说review.md'])
    // 多扩展名 + 无 query
    const all = await search({ query: '', exts: ['md', 'txt'], dir, limit: 10 }, undefined)
    const names = all.results.map((r) => r.name).sort()
    assert.deepEqual(names, ['README.md', 'notes.txt', '写小说review.md'])
    // 忽略目录生效（无 ignored.md）
    assert.ok(!names.includes('ignored.md'))
    // 缓存命中路径：手工构造新鲜缓存（覆盖默认根），查询只过滤缓存、不碰磁盘
    const roots = Object.fromEntries(defaultRoots('darwin').map((root) => [root, Date.now()]))
    writeFileSync(join(dir, 'index.json'), JSON.stringify({
      version: 1,
      roots,
      files: [
        { path: join(dir, 'cached-note.md'), name: 'cached-note.md', mtime: 2000, size: 5 },
        { path: join(dir, 'other.txt'), name: 'other.txt', mtime: 1000, size: 5 },
      ],
    }))
    const cached = await search({ query: 'cached', exts: ['md'], dir: undefined, limit: 10 }, undefined)
    assert.deepEqual(cached.results.map((r) => r.name), ['cached-note.md'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('控制器：启用注册、禁用注销、状态', () => {
  let registered = null
  const fakeCtx = {
    tools: {
      register(def) {
        registered = def
        return () => { registered = null }
      },
    },
  }
  let enabled = false
  const getRuntime = () => ({ searchDocsEnabled: enabled })
  const ctrl = createSearchDocsController(fakeCtx, baseConfig(), getRuntime)
  assert.equal(registered, null, '默认禁用：不注册')
  enabled = true
  ctrl.sync()
  assert.equal(registered?.name, 'memory_evolve_search_local_files', '启用后注册工具')
  const status = ctrl.status()
  assert.equal(status.enabled, true)
  assert.deepEqual(status.providers, ['mdfind', 'rg', 'walk'])
  enabled = false
  ctrl.sync()
  assert.equal(registered, null, '禁用后注销工具')
})

test('命令：on/off/status', () => {
  let current = false
  const ctrl = { status: () => ({ enabled: current, toolName: 't', providers: ['a'], defaultExts: ['md'] }), setEnabled: (v) => { current = v } }
  const cmd = searchDocsCommand(baseConfig(), ctrl)
  assert.equal(cmd.name, 'memory_evolve_search_files')
  assert.equal(cmd.handler({ rawInput: 'on' }).kind, 'success')
  assert.equal(current, true)
  assert.equal(cmd.handler({ rawInput: 'off' }).kind, 'success')
  assert.equal(current, false)
  const status = cmd.handler({ rawInput: '' })
  assert.match(status.text, /已禁用/)
  cmd.handler({ rawInput: 'on' })
  assert.match(cmd.handler({ rawInput: '' }).text, /已启用/)
})
