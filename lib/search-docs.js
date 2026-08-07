/**
 * dsh-memory-evolve — search_local_docs 本地文档检索（第一期：仅文件名匹配）。
 *
 * 目标：让 LLM 一次调用就能在本机所有磁盘/目录里按文件名找到文档
 * （不读文件内容，只返回路径/名称/修改时间/大小）。
 *
 * 架构：provider 可替换。`registerSearchProvider(name, factory)` 注册新实现，
 * 配置 `searchDocsProviders` 控制使用顺序（'auto' = 按平台探测排序）。
 * 内置 provider：
 *   - mdfind（darwin，Spotlight 索引，毫秒级，覆盖全盘含外置卷）
 *   - es    （win32，Everything 的 es.exe，毫秒级；未安装则跳过）
 *   - rg    （跨平台，rg --files 文件名枚举，秒级；须加 --no-messages 才能
 *             在权限受限的外置卷上工作）
 *   - walk  （Node 并发遍历 + 结果缓存，零依赖最终兜底）
 *
 * 工具名与参数/返回结构固定（memory_evolve_search_local_docs），换实现只改
 * provider，模型侧契约不变。默认禁用（searchDocsEnabled: false）：禁用时
 * 工具不注册，模型请求里根本没有这个工具。
 *
 * 零运行时依赖（仅 node 内置模块）。
 * @module dsh-memory-evolve/search-docs
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, readdirSync,
} from 'node:fs'
import { readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Provider 注册表（可替换实现的核心）：名字 → 工厂函数 (config) => provider
// ---------------------------------------------------------------------------

const PROVIDERS = new Map()

/**
 * 注册（或替换）一个搜索 provider。第三方实现替换时注册同名即可：
 * 工具名、参数、返回结构完全不变。
 * @param {string} name - provider 名字（配置 searchDocsProviders 里引用）。
 * @param {(config: object) => object} factory - 返回 provider 实例
 *   （{ name, search(params, ctx) }）。
 */
export function registerSearchProvider(name, factory) {
  if (typeof name !== 'string' || name.length === 0) throw new Error('search-docs: provider 名必须是非空字符串')
  if (typeof factory !== 'function') throw new Error('search-docs: provider 工厂必须是函数')
  PROVIDERS.set(name, factory)
}

/** @returns {Map<string, Function>} 当前 provider 注册表（只读用途）。 */
export function getSearchProviders() {
  return PROVIDERS
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 运行一个外部命令，收集 stdout；返回 { code, stdout }。 */
function runCmd(command, args, { signal, timeoutMs = 30000, maxBytes = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    let timer = null
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      child.kill()
      reject(new SearchAborted())
    }
    if (signal) {
      if (signal.aborted) return reject(new SearchAborted())
      signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', (chunk) => {
      if (maxBytes > 0 && out.length + chunk.length > maxBytes) {
        // 输出爆炸（如全盘枚举）：终止，防止主进程被海量 stdout 数据淹没
        cleanup()
        child.kill()
        reject(new Error(`输出超过 ${maxBytes} 字节上限，已终止`))
        return
      }
      out += chunk
    })
    child.on('error', (error) => { cleanup(); reject(error) })
    child.on('close', (code) => {
      cleanup()
      resolve({ code, stdout: out })
    })
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup()
        child.kill()
        reject(new SearchAborted())
      }, timeoutMs)
    }
  })
}

/** 命令是否可用（一次性探测，结果缓存）。 */
const PROBE_CACHE = new Map()
function commandAvailable(command, args = ['--version']) {
  if (PROBE_CACHE.has(command)) return PROBE_CACHE.get(command)
  let ok = false
  try {
    const result = spawnSync(command, args, { stdio: 'ignore', timeout: 5000 })
    ok = result.error === undefined
  } catch {
    ok = false
  }
  PROBE_CACHE.set(command, ok)
  return ok
}

/**
 * 清洗扩展名参数：接受数组或逗号分隔字符串，去点、转小写、去重。
 * @param {unknown} exts - LLM 传入的扩展名（数组或字符串）。
 * @param {string[]} fallback - 非法/为空时的默认列表。
 * @returns {string[]} 清洗后的扩展名列表（不含点、小写）。
 */
export function normalizeExts(exts, fallback) {
  const raw = Array.isArray(exts)
    ? exts
    : typeof exts === 'string'
      ? exts.split(',').map((s) => s.trim()).filter(Boolean)
      : []
  const cleaned = [...new Set(raw.map((e) => String(e).trim().toLowerCase().replace(/^\./, '')))]
  const valid = cleaned.filter((e) => /^[a-z0-9]{1,10}$/.test(e))
  if (valid.length === 0) return [...(fallback ?? [])]
  return valid
}

/** basename 子串匹配（大小写不敏感）；query 为空 = 全部匹配。 */
export function matchQuery(name, query) {
  if (!query) return true
  return name.toLowerCase().includes(query.toLowerCase())
}

/** 默认搜索根：用户主目录 + 平台外置卷/其它盘符。 */
export function defaultRoots(platform = process.platform) {
  const home = homedir()
  const roots = [home]
  try {
    if (platform === 'darwin') {
      for (const name of readdirSync('/Volumes')) {
        if (!name.startsWith('.')) roots.push(join('/Volumes', name))
      }
    } else if (platform === 'win32') {
      for (let c = 65; c <= 90; c++) {
        const drive = `${String.fromCharCode(c)}:\\`
        if (existsSync(drive)) roots.push(drive)
      }
    } else {
      for (const p of ['/home', '/media', '/mnt']) {
        if (existsSync(p)) roots.push(p)
      }
    }
  } catch {
    // 不可读的卷目录直接跳过
  }
  return roots
}

/**
 * 并发 stat 一批路径，返回 [{ path, name, mtime, size }]（失败的跳过）。
 * 只处理前 `maxEntries` 条：空 query 的全盘枚举可能几十万条，逐条 stat
 * 慢盘会长时间占满事件循环（曾导致 DSH 主进程卡死），截断即止损。
 */
async function statEntries(paths, concurrency = 32, maxEntries = 2000) {
  const limited = paths.slice(0, maxEntries)
  const out = []
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, limited.length)) }, async () => {
    while (index < limited.length) {
      const path = limited[index++]
      try {
        const info = await stat(path)
        if (info.isFile()) out.push({ path, name: basename(path), mtime: Math.floor(info.mtimeMs), size: info.size })
      } catch {
        // 文件已消失/无权限：跳过
      }
    }
  })
  await Promise.all(workers)
  return out
}

/** 统一过滤：扩展名 + query 子串匹配，按 mtime 倒序。 */
function filterPaths(paths, { query, exts, limit }) {
  const extSet = new Set(exts)
  const matched = []
  for (const path of paths) {
    const name = basename(path)
    if (!extSet.has(extname(name).slice(1).toLowerCase())) continue
    if (!matchQuery(name, query)) continue
    matched.push(path)
  }
  return matched
}

/**
 * 完整查询管线：path 列表 → 过滤 → stat → 排序 → 截断。
 * @param {string[]} paths
 * @param {{ query: string, exts: string[], limit: number }} params
 * @returns {Promise<Array<{path: string, name: string, mtime: number, size: number}>>}
 */
async function finalize(paths, { query, exts, limit }) {
  const matched = filterPaths(paths, { query, exts, limit })
  const entries = await statEntries(matched)
  entries.sort((a, b) => b.mtime - a.mtime)
  return entries.slice(0, limit)
}

/** 搜索被取消/超时的标记错误。 */
export class SearchAborted extends Error {
  constructor(message = '搜索已取消或超时') {
    super(message)
    this.name = 'SearchAborted'
  }
}

// ---------------------------------------------------------------------------
// 内置 provider：mdfind（macOS Spotlight）
// ---------------------------------------------------------------------------

registerSearchProvider('mdfind', () => ({
  name: 'mdfind',
  probe() {
    return process.platform === 'darwin'
  },
  async search({ query, exts, dir, limit }, { signal }) {
    // 扩展名收窄必须进索引查询：若只在 JS 端过滤，query 命中一堆非目标
    // 扩展名会全部被滤掉 → 空结果 → 降级全盘扫描（卡死主进程的根因）。
    const extPredicates = exts.length > 0
      ? `(${exts.map((ext) => `kMDItemFSName == "*.${ext}"cd`).join(' || ')})`
      : null
    const predicates = []
    if (query) {
      const safe = String(query).replace(/["\\]/g, '')
      predicates.push(`kMDItemFSName == "*${safe}*"cd`)
      if (extPredicates) predicates.push(extPredicates)
    } else if (extPredicates) {
      predicates.push(extPredicates)
    }
    const args = predicates.length > 0 ? [predicates.join(' && ')] : []
    if (dir) args.push('-onlyin', dir)
    const { stdout } = await runCmd('mdfind', args, { signal })
    const paths = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    return finalize(paths, { query, exts, limit })
  },
}))

// ---------------------------------------------------------------------------
// 内置 provider：es（Windows Everything，需用户安装）
// ---------------------------------------------------------------------------

registerSearchProvider('es', () => ({
  name: 'es',
  probe() {
    if (process.platform !== 'win32') return false
    return commandAvailable('es.exe', ['-h'])
  },
  async search({ query, exts, dir, limit }, { signal }) {
    const args = []
    if (query) args.push('-n', query)
    if (exts.length > 0) args.push('-ext', exts.join(';'))
    if (dir) args.push('-path', dir)
    const { stdout } = await runCmd('es.exe', args, { signal })
    const paths = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    return finalize(paths, { query, exts, limit })
  },
}))

// ---------------------------------------------------------------------------
// 内置 provider：rg（跨平台；--no-messages 容忍外置卷权限错误）
// ---------------------------------------------------------------------------

registerSearchProvider('rg', (config) => ({
  name: 'rg',
  probe() {
    return commandAvailable('rg', ['--version'])
  },
  async search({ query, exts, dir, limit }, { signal }) {
    const roots = dir ? [dir] : defaultRoots()
    const args = ['--files', '--hidden', '--no-messages']
    for (const ext of exts) args.push('-g', `*.${ext}`)
    args.push('-g', '!.git/**')
    args.push(...roots.filter((root) => existsSync(root)))
    // 全盘枚举（含慢速外置卷）可能极慢：10s 上限 + 输出 64MB 上限，超限即
    // 中止并降级，避免长时间占住主进程。
    const { stdout } = await runCmd('rg', args, { signal, timeoutMs: 10000, maxBytes: 64 * 1024 * 1024 })
    const paths = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    return finalize(paths, { query, exts, limit })
  },
}))

// ---------------------------------------------------------------------------
// 内置 provider：walk（Node 并发遍历 + 结果缓存，零依赖兜底）
// ---------------------------------------------------------------------------

/** walk 忽略的目录名（大小写不敏感比较）。 */
const WALK_IGNORE = new Set([
  'node_modules', '.git', 'library', 'appdata', 'system32', '.cache',
  '.trash', '.trashes', '.spotlight-v100', '.fseventsd',
  '.documentrevisions-v100', '.temporaryitems', '__pycache__',
  'venv', '.venv', '.tox', '.pytest_cache', 'site-packages',
])

/** walk 缓存里收录的文档扩展名集合（查询时按请求 exts 过滤）。 */
const DOCUMENT_EXTS = new Set([
  'md', 'markdown', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'pdf', 'rtf', 'odt', 'odp', 'ods', 'epub', 'mobi', 'html', 'htm',
  'csv', 'json', 'yaml', 'yml',
])

/** 并发目录遍历：收集扩展名命中的文件路径（maxFiles 预算截断）。 */
async function walkFiles(root, { extSet, signal, concurrency = 16, maxFiles = 50000 }) {
  const found = []
  const queue = [root]
  let running = 0
  let finished = false
  const maybeFinish = (resolveWalk) => {
    if (!finished && running === 0 && queue.length === 0) {
      finished = true
      resolveWalk()
    }
  }
  await new Promise((resolveWalk, rejectWalk) => {
    const startNext = () => {
      while (running < concurrency && queue.length > 0 && !signal?.aborted && found.length < maxFiles) {
        const dir = queue.shift()
        running += 1
        readdir(dir, { withFileTypes: true }).then((entries) => {
          running -= 1
          for (const entry of entries) {
            if (signal?.aborted || found.length >= maxFiles) break
            const name = entry.name
            if (entry.isDirectory()) {
              if (!WALK_IGNORE.has(name.toLowerCase())) queue.push(join(dir, name))
            } else if (entry.isFile()) {
              const ext = extname(name).slice(1).toLowerCase()
              if (extSet.has(ext)) found.push(join(dir, name))
            }
          }
          startNext()
          maybeFinish(resolveWalk)
        }).catch(() => {
          // 目录无权限/已被删除：跳过继续
          running -= 1
          startNext()
          maybeFinish(resolveWalk)
        })
      }
      maybeFinish(resolveWalk)
    }
    startNext()
  })
  return found
}

/**
 * walk provider 工厂：带结果缓存（<cacheFile>，TTL 内复用；过期只重扫
 * 过期的根；扫描中并发去重；后台完成写盘）。dir 参数指定时不走缓存。
 */
function createWalkProvider(config) {
  const cacheFile = resolve(config.searchDocsCacheFile ?? join(config.memoryDir, 'search-docs-index.json'))
  const ttlMs = config.searchDocsCacheTtlMs ?? 3600000
  const extSet = new Set(DOCUMENT_EXTS)
  let cache = null // { version, roots: { [root]: scannedAt }, files: [...] }
  let scanPromise = null

  function loadCache() {
    if (cache !== null) return cache
    try {
      if (existsSync(cacheFile)) {
        const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'))
        if (parsed && parsed.version === 1 && Array.isArray(parsed.files)) cache = parsed
      }
    } catch {
      cache = null // 损坏的缓存：重建
    }
    return cache
  }

  async function rebuild(staleRoots, signal) {
    const next = {
      version: 1,
      roots: { ...(cache?.roots ?? {}) },
      files: (cache?.files ?? []).filter((file) => !staleRoots.some((root) => file.path.startsWith(root))),
    }
    for (const root of staleRoots) {
      // 每卷扫描预算：慢速外置盘（NTFS）可能上百万条目，超预算截断，
      // 防止后台扫描无限期占满事件循环。
      const paths = await walkFiles(root, { extSet, signal, maxFiles: 50000 })
      const entries = await statEntries(paths, 16, 50000)
      next.files.push(...entries)
      next.roots[root] = Date.now()
    }
    try {
      mkdirSync(dirname(cacheFile), { recursive: true })
      // 大缓存必须异步写：同步 stringify+写盘几十万条会阻塞主进程数秒
      //（曾把 DSH 主进程卡死）。
      await writeFile(`${cacheFile}.tmp.${process.pid}`, JSON.stringify(next))
      await rename(`${cacheFile}.tmp.${process.pid}`, cacheFile)
    } catch {
      // 缓存写失败不致命：本次结果仍然可用
    }
    cache = next
    return next
  }

  return {
    name: 'walk',
    probe() {
      return true
    },
    async search({ query, exts, dir, limit }, { signal }) {
      // 指定目录：不依赖缓存，直接扫该目录（通常较小，很快）。
      if (dir) {
        const paths = await walkFiles(dir, { extSet, signal, maxFiles: 20000 })
        return finalize(paths, { query, exts, limit })
      }
      loadCache()
      const roots = defaultRoots().filter((root) => existsSync(root))
      const stale = roots.filter((root) => !cache?.roots?.[root] || Date.now() - cache.roots[root] > ttlMs)
      if (stale.length > 0 && !scanPromise) {
        // 后台重建索引（低并发，避免 IO 洪流）；查询绝不等待它。
        scanPromise = rebuild(stale, undefined).catch((error) => {
          scanPromise = null
          throw error
        })
      }
      // 无论索引是否就绪：直接用现有缓存过滤（旧数据可用），不阻塞。
      // 首次无缓存时返回空，后台构建完成后下次调用即命中——绝不把
      // 全盘扫描放在查询路径上（曾导致 DSH 主进程卡死）。
      const files = cache?.files ?? []
      return files
        .filter((file) => exts.includes(extname(file.name).slice(1).toLowerCase()))
        .filter((file) => matchQuery(file.name, query))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit)
    },
  }
}

registerSearchProvider('walk', (config) => createWalkProvider(config))

// ---------------------------------------------------------------------------
// provider 链解析
// ---------------------------------------------------------------------------

/** 平台默认 provider 顺序。 */
function autoOrder(platform = process.platform) {
  if (platform === 'darwin') return ['mdfind', 'rg', 'walk']
  if (platform === 'win32') return ['es', 'rg', 'walk']
  return ['rg', 'walk']
}

/**
 * 按配置解析可用的 provider 实例链。
 * @param {object} config - resolved config（searchDocsProviders）。
 * @param {string} platform
 * @returns {Array<{name: string, search: Function}>}
 */
export function resolveProviders(config, platform = process.platform) {
  const wanted = Array.isArray(config.searchDocsProviders)
    ? config.searchDocsProviders
    : autoOrder(platform)
  const chain = []
  for (const name of wanted) {
    const factory = PROVIDERS.get(name)
    if (!factory) throw new Error(`search-docs: 未知的 provider "${name}"（已注册：${[...PROVIDERS.keys()].join(', ')}）`)
    const instance = factory(config)
    if (typeof instance.probe === 'function' && !instance.probe()) continue
    chain.push(instance)
  }
  if (chain.length === 0) {
    // walk 永远可用；若配置把 walk 排除了且其它都不可用，至少留一个报错途径
    throw new Error('search-docs: 没有可用的搜索 provider（检查 searchDocsProviders 配置）')
  }
  return chain
}

/**
 * 创建搜索器：依次尝试 provider，**成功（含空结果）即返回**——索引层
 * （mdfind/es）是全盘权威视图，空结果就是"没有"，继续降级去全盘扫描
 * 只会让查询变成分钟级并占满主进程（卡死根因）。仅当 provider 本身
 * 失败/超时才降级到下一层。
 * @param {object} config
 * @returns {(params: object, signal?: AbortSignal) => Promise<{provider: string, results: Array}>}
 */
export function createSearcher(config) {
  const chain = resolveProviders(config)
  return async function search(params, signal) {
    let lastError = null
    for (const provider of chain) {
      try {
        const results = await provider.search(params, { signal })
        return { provider: provider.name, results }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('search-docs: 搜索失败')
  }
}

// ---------------------------------------------------------------------------
// 工具定义（模型侧契约固定：memory_evolve_search_local_docs）
// ---------------------------------------------------------------------------

/** 渲染搜索结果（工具输出 → 模型可见文本）。 */
export function renderSearchResult(value) {
  if (!value.ok) return `搜索失败：${value.message ?? '未知错误'}`
  if (!value.results || value.results.length === 0) {
    return `没有找到匹配的文档（provider: ${value.provider ?? 'none'}）`
  }
  const lines = value.results.map((result, index) => {
    const time = new Date(result.mtime).toISOString().slice(0, 16).replace('T', ' ')
    const size = result.size < 1024 ? `${result.size} B` : `${(result.size / 1024).toFixed(1)} KB`
    return `${index + 1}. ${result.path}（${size}，${time}）`
  })
  const head = `找到 ${value.count} 个文档${value.truncated ? '（已截断，可增大 limit）' : ''}（provider: ${value.provider}）：`
  return `${head}\n${lines.join('\n')}`
}

/**
 * 工具定义：memory_evolve_search_local_docs。
 * @param {object} config - resolved config。
 * @param {(params: object, signal?: AbortSignal) => Promise<object>} search - 搜索函数。
 * @returns {object} ToolDefinition-shaped object。
 */
export function searchDocsToolDefinition(config, search) {
  const defaultExts = config.searchDocsExts ?? ['md']
  return {
    name: config.searchDocsToolName,
    description: '在本机所有磁盘/目录中按文件名查找文档（只匹配文件名，不读取文件内容）。用于找到与当前任务相关的参考文档：query 匹配文件名关键字（子串、大小写不敏感；**中文文件名请尝试多个说法/同义词**——如"年报"可能查不到，可换"述职"、"年度报告"、"年终总结"等文件名中实际出现的词，无结果时换词再查或留空列出最近文档），exts 限定扩展名（如 ["md","docx"]，支持逗号分隔字符串），dir 可限定目录。结果按修改时间倒序返回路径、文件名、大小与修改时间。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '文件名关键字（子串匹配，大小写不敏感）；留空 = 列出最近修改的文档',
        },
        exts: {
          type: 'array',
          items: { type: 'string' },
          description: `扩展名列表（不含点，如 ["md","docx"]；也兼容 "md,docx" 字符串）；不传时默认 ${JSON.stringify(defaultExts)}`,
        },
        dir: {
          type: 'string',
          description: '可选：限定搜索目录（绝对路径，或相对当前工作目录的相对路径）',
        },
        limit: {
          type: 'integer',
          description: '最多返回条数（默认 20，最大 100）',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          provider: { type: 'string' },
          count: { type: 'integer' },
          truncated: { type: 'boolean' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                name: { type: 'string' },
                mtime: { type: 'integer' },
                size: { type: 'integer' },
              },
              required: ['path', 'name'],
            },
          },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: renderSearchResult(value) }],
    },
    async execute(args, exec) {
      const signal = exec?.signal
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      let exts
      try {
        exts = normalizeExts(args.exts, defaultExts)
      } catch {
        return { ok: false, message: 'exts 参数格式不正确（应为扩展名数组或逗号分隔字符串）', provider: null, count: 0, truncated: false, results: [] }
      }
      let dir
      if (typeof args.dir === 'string' && args.dir.trim()) {
        const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
        dir = resolve(cwd, args.dir.trim())
      }
      const limit = Math.min(Math.max(Number.isFinite(args.limit) ? Math.floor(args.limit) : 20, 1), 100)
      try {
        const { provider, results } = await search({ query, exts, dir, limit }, signal)
        return {
          ok: true,
          provider,
          count: results.length,
          truncated: results.length > limit,
          results: results.slice(0, limit),
        }
      } catch (error) {
        const message = error instanceof SearchAborted
          ? error.message
          : `搜索失败：${error.message ?? String(error)}`
        return { ok: false, message, provider: null, count: 0, truncated: false, results: [] }
      }
    },
    timeoutMs: config.searchDocsTimeoutMs ?? 60000,
  }
}

// ---------------------------------------------------------------------------
// 控制器：按运行时开关动态注册/注销工具（禁用后模型请求里即无此工具）
// ---------------------------------------------------------------------------

/**
 * 创建 search-docs 控制器：持有工具注册 disposer，sync() 按
 * getRuntime().searchDocsEnabled 注册或注销。
 * @param {object} ctx - cordis ctx（需注入 tools）。
 * @param {object} config - resolved config。
 * @param {() => object} getRuntime - 运行时配置读取。
 * @returns {{ sync: () => void, status: () => object }}
 */
export function createSearchDocsController(ctx, config, getRuntime) {
  const search = createSearcher(config)
  const definition = searchDocsToolDefinition(config, search)
  let disposer = null
  const sync = () => {
    if (getRuntime().searchDocsEnabled) {
      if (disposer === null) {
        disposer = ctx.tools.register(definition)
      }
    } else if (disposer !== null) {
      disposer()
      disposer = null
    }
  }
  sync()
  return {
    sync,
    status() {
      const chain = resolveProviders(config).map((provider) => provider.name)
      return {
        enabled: getRuntime().searchDocsEnabled,
        toolName: config.searchDocsToolName,
        providers: chain,
        defaultExts: config.searchDocsExts ?? ['md'],
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 斜杠命令：memory_evolve_search_docs [on|off]
// ---------------------------------------------------------------------------

/**
 * 命令定义：/memory_evolve_search_docs [on|off]（不带参数 = 查看状态）。
 * @param {object} config - resolved config。
 * @param {{ status: () => object, setEnabled: (v: boolean) => object }} ctrl - 控制器句柄。
 * @returns {object} CommandDefinition-shaped object。
 */
export function searchDocsCommand(config, ctrl) {
  return {
    name: config.searchDocsCommandName,
    description: '启用/禁用/查看本地文档搜索工具（memory_evolve_search_local_docs）：on 启用，off 禁用，不带参数查看状态',
    input: {
      syntax: '[on|off]',
      hint: '不带参数时显示当前状态；启用后 LLM 即可在会话里调用本地文档搜索工具',
    },
    handler(invocation) {
      const op = invocation.rawInput.trim().toLowerCase()
      if (op === 'on') {
        ctrl.setEnabled(true)
        const status = ctrl.status()
        return { kind: 'success', text: `已启用本地文档搜索工具（${status.toolName}）。provider 链：${status.providers.join(' → ')}` }
      }
      if (op === 'off') {
        ctrl.setEnabled(false)
        return { kind: 'success', text: '已禁用本地文档搜索工具：工具已从模型可见列表中移除' }
      }
      const status = ctrl.status()
      return {
        kind: 'success',
        text: `本地文档搜索工具：${status.enabled ? '已启用' : '已禁用（默认）'}\n工具名：${status.toolName}\nprovider 链：${status.providers.join(' → ')}\n默认扩展名：${status.defaultExts.join(', ')}\n用法：/memory_evolve_search_docs on|off`,
      }
    },
  }
}
