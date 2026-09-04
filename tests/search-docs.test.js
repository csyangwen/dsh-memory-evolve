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
  SearchAborted, contentCandidateLimit, createSearchDocsController, createSearcher,
  defaultRoots, isAllTypes, matchContentInText, matchQuery, normalizeExts,
  nodeSearchFileContents, parseRgContentOutput, probeContentFile,
  renderSearchResult, resolveContentSearchArgs, resolveProviders,
  searchDocsCommand, searchDocsToolDefinition, searchFileContents,
} from '../lib/search-docs.js'

// This suite pins the legacy Chinese output contract; i18n.test.js covers English.
import { setLocale } from '../lib/i18n.js'
setLocale('zh')

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
  // PR #32（全盘搜索卡死修复）：win32 只收集「探测存在」的盘符——home 所在
  // 盘只扫 homedir（不含 C:\Windows 等系统目录），其余盘加盘符根。macOS
  // 上探测无盘符 → 空数组；Windows 实机上 home 所在盘必存在 → 必含 homedir。
  assert.ok(winRoots.length === 0 || winRoots.includes(homedir()))
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

// ---------------------------------------------------------------------------
// 内容检索（RAG 轻量版）：参数解析 / 文本匹配 / 安全跳过 / 工具 execute 集成
// ---------------------------------------------------------------------------

test('resolveContentSearchArgs：content / contentQuery 开关语义', () => {
  // 默认关闭（兼容旧调用）
  assert.deepEqual(resolveContentSearchArgs({}, 'foo'), { enabled: false, contentQuery: '' })
  assert.deepEqual(resolveContentSearchArgs({ content: false }, 'foo'), { enabled: false, contentQuery: '' })
  // content=true → 开启，关键词复用 query
  assert.deepEqual(resolveContentSearchArgs({ content: true }, 'foo'), { enabled: true, contentQuery: 'foo' })
  // contentQuery 非空 → 隐式开启，且覆盖 query
  assert.deepEqual(
    resolveContentSearchArgs({ contentQuery: '  bar  ' }, 'foo'),
    { enabled: true, contentQuery: 'bar' },
  )
  // 两者同传：contentQuery 优先作为正文关键词
  assert.deepEqual(
    resolveContentSearchArgs({ content: true, contentQuery: 'bar' }, 'foo'),
    { enabled: true, contentQuery: 'bar' },
  )
  // content=true 但 query/contentQuery 都空 → 开启但关键词空（execute 层会报错）
  assert.deepEqual(resolveContentSearchArgs({ content: true }, ''), { enabled: true, contentQuery: '' })
  // 空字符串 contentQuery 不隐式开启
  assert.deepEqual(resolveContentSearchArgs({ contentQuery: '   ' }, 'foo'), { enabled: false, contentQuery: '' })
})

test('contentCandidateLimit：扩容且封顶', () => {
  assert.equal(contentCandidateLimit(20), 500) // 20*25=500
  assert.equal(contentCandidateLimit(1), 100)  // 至少 100
  assert.equal(contentCandidateLimit(50), 500) // 50*25=1250 → 封顶 500
})

test('内容模式候选不按 mtime 截断（防回归：全盘 md 10613 个、目标排 500 名外被截掉的事故）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-no-truncate-'))
  try {
    // 600 个候选：599 个"较新"空文件 + 目标文件（含关键词、mtime 最旧）。
    // 旧逻辑（内容候选上限 500 + mtime 排序截断）会漏掉目标——必须枚举全量。
    const target = join(dir, '老文档-镇江.md')
    writeFileSync(target, '# 老文档标题\n正文含 关键词X 在中间\n')
    const { utimesSync } = await import('node:fs')
    utimesSync(target, 1000, 1000) // mtime 设为最早
    for (let i = 0; i < 599; i += 1) {
      writeFileSync(join(dir, `filler-${i}.md`), '无关键词\n')
    }
    let receivedLimit = -1
    const def = searchDocsToolDefinition(baseConfig(), async (params) => {
      receivedLimit = params.limit
      const results = []
      for (let i = 0; i < 599; i += 1) {
        results.push({ path: join(dir, `filler-${i}.md`), name: `filler-${i}.md`, mtime: Date.now() - i, size: 1, dir: false })
      }
      // 目标排最后、mtime 最旧——若按 mtime 截断前 500 会漏掉它。
      results.push({ path: target, name: '老文档-镇江.md', mtime: 1000, size: 30, dir: false })
      return { provider: 'fake', results }
    })
    const out = await def.execute({ contentQuery: '关键词X', limit: 5 }, {})
    assert.equal(out.ok, true)
    // 内容模式：provider 收到的 limit 必须是 Infinity（枚举全量，不按 mtime 截断）
    assert.equal(receivedLimit, Number.POSITIVE_INFINITY)
    // 最旧的目标必须命中
    assert.equal(out.results.length, 1)
    assert.equal(out.results[0].name, '老文档-镇江.md')
    assert.ok(Array.isArray(out.results[0].snippets))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('matchContentInText：字面大小写不敏感 + 上下文 + 每文件上限', () => {
  const text = [
    '前言',
    'Hello World',
    '中间行',
    'hello again',
    '结尾',
    'HELLO third',
    '更多',
  ].join('\n')
  const hits = matchContentInText(text, 'hello', { maxSnippets: 2, contextLines: 1 })
  assert.equal(hits.length, 2, '最多 2 个片段')
  assert.equal(hits[0].line, 2)
  assert.match(hits[0].text, /Hello World/i)
  assert.match(hits[0].context, /前言/)
  assert.match(hits[0].context, /中间行/)
  assert.equal(hits[1].line, 4)
  // 无命中
  assert.deepEqual(matchContentInText(text, 'no-such-token'), [])
})

test('parseRgContentOutput：解析 rg --json 命中与上下文', () => {
  // 模拟 rg --json -C 1 的 NDJSON 流（context → match → context）
  const stdout = [
    JSON.stringify({ type: 'context', data: { path: { text: '/tmp/a.md' }, line_number: 1, lines: { text: 'before\n' } } }),
    JSON.stringify({ type: 'match', data: { path: { text: '/tmp/a.md' }, line_number: 2, lines: { text: 'match line\n' } } }),
    JSON.stringify({ type: 'context', data: { path: { text: '/tmp/a.md' }, line_number: 3, lines: { text: 'after\n' } } }),
    JSON.stringify({ type: 'match', data: { path: { text: '/tmp/b.md' }, line_number: 10, lines: { text: 'only match\n' } } }),
  ].join('\n')
  const map = parseRgContentOutput(stdout, 3)
  assert.equal(map.size, 2)
  const a = map.get('/tmp/a.md')
  assert.equal(a.length, 1)
  assert.equal(a[0].line, 2)
  assert.equal(a[0].text, 'match line')
  assert.match(a[0].context, /before/)
  assert.match(a[0].context, /after/)
  const b = map.get('/tmp/b.md')
  assert.equal(b[0].line, 10)
  assert.equal(b[0].text, 'only match')
})

test('probeContentFile：二进制 / 空文件 / 正常文本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-probe-'))
  try {
    const textPath = join(dir, 'ok.md')
    const binPath = join(dir, 'bin.dat')
    const emptyPath = join(dir, 'empty.md')
    writeFileSync(textPath, 'hello\n')
    writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02, 0xff]))
    writeFileSync(emptyPath, '')
    assert.equal(probeContentFile(textPath).skip, false)
    assert.equal(probeContentFile(binPath).skip, true)
    assert.equal(probeContentFile(binPath).reason, 'binary')
    assert.equal(probeContentFile(emptyPath).skip, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('nodeSearchFileContents：命中 / 未命中 / 跳过二进制', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-node-content-'))
  try {
    const hit = join(dir, 'hit.md')
    const miss = join(dir, 'miss.md')
    const bin = join(dir, 'x.bin')
    writeFileSync(hit, '# 标题\n本文提到了智云鸿道项目。\n结尾\n')
    writeFileSync(miss, '无关内容\n')
    writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])) // PNG 头 + NUL
    const entries = [
      { path: hit, name: 'hit.md', mtime: 3, size: 50, dir: false },
      { path: miss, name: 'miss.md', mtime: 2, size: 20, dir: false },
      { path: bin, name: 'x.bin', mtime: 1, size: 6, dir: false },
    ]
    const hits = await nodeSearchFileContents(entries, '智云鸿道')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].name, 'hit.md')
    assert.ok(hits[0].snippets.length >= 1)
    assert.match(hits[0].snippets[0].text, /智云鸿道/)
    // 未命中
    const none = await nodeSearchFileContents(entries, '完全不存在的词XYZ')
    assert.equal(none.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('工具 execute：content=false 行为不变（不返回 snippets）', async () => {
  const def = searchDocsToolDefinition(baseConfig(), async () => ({
    provider: 'fake',
    results: [{ path: '/x/a.md', name: 'a.md', mtime: 1, size: 2, dir: false }],
  }))
  const out = await def.execute({ query: 'a' }, {})
  assert.equal(out.ok, true)
  assert.equal(out.content, false)
  assert.equal(out.contentQuery, '')
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].snippets, undefined)
})

test('工具 execute：content=true 命中与片段返回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-tool-content-'))
  try {
    const f1 = join(dir, 'alpha.md')
    const f2 = join(dir, 'beta.md')
    writeFileSync(f1, 'line1\n关键字Alpha出现在这里\nline3\n')
    writeFileSync(f2, '没有目标词\n')
    // fake 文件名搜索返回两个候选；内容阶段再过滤
    const def = searchDocsToolDefinition(baseConfig(), async () => ({
      provider: 'fake',
      results: [
        { path: f1, name: 'alpha.md', mtime: 20, size: 40, dir: false },
        { path: f2, name: 'beta.md', mtime: 10, size: 20, dir: false },
      ],
    }))
    const out = await def.execute({ query: 'alpha', content: true }, {})
    assert.equal(out.ok, true)
    assert.equal(out.content, true)
    assert.equal(out.contentQuery, 'alpha') // content=true 复用 query
    assert.equal(out.results.length, 1)
    assert.equal(out.results[0].name, 'alpha.md')
    assert.ok(Array.isArray(out.results[0].snippets))
    assert.ok(out.results[0].snippets.length >= 1)
    assert.equal(typeof out.results[0].snippets[0].line, 'number')
    assert.match(out.results[0].snippets[0].text, /Alpha/i)
    assert.equal(typeof out.results[0].snippets[0].context, 'string')
    // render 含片段
    const rendered = renderSearchResult(out)
    assert.match(rendered, /内容关键词/)
    assert.match(rendered, /L\d+:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('工具 execute：contentQuery 覆盖 query，并隐式开启内容检索', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-tool-cq-'))
  try {
    const f = join(dir, 'note.md')
    writeFileSync(f, '正文提到 成都 与项目规划。\n')
    const calls = []
    const def = searchDocsToolDefinition(baseConfig(), async (params) => {
      calls.push(params)
      return {
        provider: 'fake',
        results: [{ path: f, name: 'note.md', mtime: 1, size: 30, dir: false }],
      }
    })
    // 不传 content=true，只传 contentQuery → 隐式开启
    const out = await def.execute({ query: 'note', contentQuery: '成都' }, {})
    assert.equal(out.ok, true)
    assert.equal(out.content, true)
    assert.equal(out.contentQuery, '成都')
    assert.equal(out.results.length, 1)
    assert.match(out.results[0].snippets[0].text, /成都/)
    // 文件名搜索仍用 query=note（contentQuery 不替代文件名）
    assert.equal(calls[0].query, 'note')
    // 内容模式内部候选 limit 扩容
    assert.ok(calls[0].limit >= 100)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('工具 execute：内容未命中返回空 results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-tool-miss-'))
  try {
    const f = join(dir, 'empty-hit.md')
    writeFileSync(f, '完全无关的文字\n')
    const def = searchDocsToolDefinition(baseConfig(), async () => ({
      provider: 'fake',
      results: [{ path: f, name: 'empty-hit.md', mtime: 1, size: 20, dir: false }],
    }))
    const out = await def.execute({ contentQuery: '绝对不会出现的词QQQ' }, {})
    assert.equal(out.ok, true)
    assert.equal(out.content, true)
    assert.equal(out.count, 0)
    assert.deepEqual(out.results, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('工具 execute：大文件与二进制安全跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-tool-safe-'))
  try {
    const bin = join(dir, 'photo.bin')
    const big = join(dir, 'huge.md')
    const ok = join(dir, 'ok.md')
    writeFileSync(bin, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]))
    // 构造 >2MB 的大文件（内容检索上限）
    writeFileSync(big, 'x'.repeat(2 * 1024 * 1024 + 100))
    writeFileSync(ok, 'safe keyword here\n')
    const def = searchDocsToolDefinition(baseConfig(), async () => ({
      provider: 'fake',
      results: [
        { path: bin, name: 'photo.bin', mtime: 3, size: 5, dir: false },
        { path: big, name: 'huge.md', mtime: 2, size: 2 * 1024 * 1024 + 100, dir: false },
        { path: ok, name: 'ok.md', mtime: 1, size: 20, dir: false },
      ],
    }))
    const out = await def.execute({ contentQuery: 'keyword' }, {})
    assert.equal(out.ok, true)
    // 二进制与大文件被跳过，只剩 ok.md
    assert.equal(out.results.length, 1)
    assert.equal(out.results[0].name, 'ok.md')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('工具 execute：content=true 且无关键词 → ok:false', async () => {
  const def = searchDocsToolDefinition(baseConfig(), async () => {
    throw new Error('不应调用 search')
  })
  const out = await def.execute({ content: true, query: '' }, {})
  assert.equal(out.ok, false)
  assert.match(out.message, /关键词/)
  assert.equal(out.content, true)
})

test('工具 execute：type=dir 时忽略内容检索参数', async () => {
  const calls = []
  const def = searchDocsToolDefinition(baseConfig(), async (params) => {
    calls.push(params)
    return {
      provider: 'fake',
      results: [{ path: '/tmp/folder', name: 'folder', mtime: 1, size: 0, dir: true }],
    }
  })
  const out = await def.execute({ type: 'dir', query: 'folder', contentQuery: '不该搜正文' }, {})
  assert.equal(out.ok, true)
  assert.equal(out.content, false)
  assert.equal(out.results[0].snippets, undefined)
  // 目录搜索不扩容候选
  assert.equal(calls[0].limit, 20)
})

test('工具 schema：content 相关参数与 output 字段合法（type 单一字符串、required 为数组）', () => {
  const def = searchDocsToolDefinition(baseConfig(), async () => ({ provider: 'x', results: [] }))
  assert.ok(def.parameters.properties.content)
  assert.equal(def.parameters.properties.content.type, 'boolean')
  assert.equal(def.parameters.properties.contentQuery.type, 'string')
  assert.ok(def.description.includes('内容检索'))
  assert.ok(def.description.includes('contentQuery'))

  // 递归校验 DSH JSON Schema 硬约束
  const walk = (node, path, inProperties = false) => {
    if (node === null || typeof node !== 'object') return
    if (!inProperties) {
      if (Object.hasOwn(node, 'type') && typeof node.type !== 'string') {
        throw new Error(`${path}.type 必须是单一字符串: ${JSON.stringify(node.type)}`)
      }
      if (Object.hasOwn(node, 'required') && !Array.isArray(node.required)) {
        throw new Error(`${path}.required 必须是数组: ${JSON.stringify(node.required)}`)
      }
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, `${path}.${key}`, key === 'properties')
    }
  }
  walk(def.parameters, 'parameters')
  walk(def.output.schema, 'output')

  // snippets 子 schema 存在且字段齐全
  const snip = def.output.schema.properties.results.items.properties.snippets
  assert.equal(snip.type, 'array')
  assert.deepEqual(snip.items.required, ['line', 'text', 'context'])
  assert.equal(def.output.schema.properties.content.type, 'boolean')
  assert.equal(def.output.schema.properties.contentQuery.type, 'string')
})

test('searchFileContents preferNode：强制 Node 路径可命中', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-prefer-node-'))
  try {
    const f = join(dir, 'doc.md')
    writeFileSync(f, 'force node path KEYWORD_XYZ\n')
    const hits = await searchFileContents(
      [{ path: f, name: 'doc.md', mtime: 1, size: 30, dir: false }],
      'KEYWORD_XYZ',
      { preferNode: true },
    )
    assert.equal(hits.length, 1)
    assert.match(hits[0].snippets[0].text, /KEYWORD_XYZ/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 四档模式（searchDocsMode）：all / filename / content / off
// ---------------------------------------------------------------------------

test('mode=filename：content/contentQuery 参数被忽略（不读任何文件内容）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-mode-filename-'))
  try {
    const f = join(dir, 'target.md')
    writeFileSync(f, '含 目标词X 的内容\n')
    const def = searchDocsToolDefinition(
      { ...baseConfig(), searchDocsMode: 'filename' },
      async () => ({ provider: 'fake', results: [{ path: f, name: 'target.md', mtime: 1, size: 10, dir: false }] }),
    )
    // 即使模型传了 contentQuery，也不会做内容匹配。
    const out = await def.execute({ query: 'target', contentQuery: '目标词X' }, {})
    assert.equal(out.ok, true)
    assert.equal(out.content, false)
    assert.equal(out.contentQuery, '')
    assert.equal(out.results.length, 1)
    assert.equal(out.results[0].snippets, undefined)
    // description 明确告知内容检索已禁用。
    assert.match(def.description, /内容检索已由插件配置禁用/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mode=content：强制内容检索，query 视为内容关键词、文件名过滤停用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-mode-content-'))
  try {
    const f = join(dir, '任意文件名.md')
    writeFileSync(f, '正文含 关键内容词Y\n')
    let receivedQuery = 'sentinel'
    const def = searchDocsToolDefinition(
      { ...baseConfig(), searchDocsMode: 'content' },
      async (params) => {
        receivedQuery = params.query // 文件名过滤关键词必须被清空
        return { provider: 'fake', results: [{ path: f, name: '任意文件名.md', mtime: 1, size: 10, dir: false }] }
      },
    )
    // 只传 query（无 contentQuery）：content 模式下 query 即内容关键词。
    const out = await def.execute({ query: '关键内容词Y', limit: 5 }, {})
    assert.equal(out.ok, true)
    assert.equal(out.content, true)
    assert.equal(out.contentQuery, '关键内容词Y')
    assert.equal(receivedQuery, '') // 文件名过滤停用
    assert.equal(out.results.length, 1)
    assert.ok(Array.isArray(out.results[0].snippets))
    assert.match(def.description, /仅内容搜索/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('controller：mode=off 不注册工具；mode 切换时重注册（description 跟随）', async () => {
  let runtime = { searchDocsMode: 'off' }
  const registered = []
  const ctx = {
    tools: {
      register: (def) => {
        registered.push(def)
        return () => { registered.splice(registered.indexOf(def), 1) }
      },
    },
  }
  const { createSearchDocsController } = await import('../lib/search-docs.js')
  const ctrl = createSearchDocsController(ctx, baseConfig(), () => runtime)
  // off：不注册
  assert.equal(registered.length, 0)
  // filename：注册一次，description 带"禁用"
  runtime = { searchDocsMode: 'filename' }
  ctrl.sync()
  assert.equal(registered.length, 1)
  assert.match(registered[0].description, /内容检索已由插件配置禁用/)
  // content：重注册（旧定义卸载、新定义注册），description 更新
  runtime = { searchDocsMode: 'content' }
  ctrl.sync()
  assert.equal(registered.length, 1)
  assert.match(registered[0].description, /仅内容搜索/)
  // off：卸载
  runtime = { searchDocsMode: 'off' }
  ctrl.sync()
  assert.equal(registered.length, 0)
})
