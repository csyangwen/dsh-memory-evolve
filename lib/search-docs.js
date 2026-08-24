/**
 * dsh-memory-evolve — search_local_docs 本地文档/文件检索。
 *
 * 目标：让 LLM 一次调用就能在本机所有磁盘/目录里按【文件名】找到文件
 * （默认只返回路径/名称/修改时间/大小；可选开启【内容检索】返回命中片段）。
 *
 * 架构：provider 可替换。`registerSearchProvider(name, factory)` 注册新实现，
 * 配置 `searchDocsProviders` 控制使用顺序（'auto' = 按平台探测排序）。
 * 内置 provider（文件名枚举层）：
 *   - mdfind（darwin，Spotlight 索引，毫秒级，覆盖全盘含外置卷）
 *   - es    （win32，Everything 的 es.exe，毫秒级；未安装则跳过）
 *   - rg    （跨平台，rg --files 文件名枚举，秒级；须加 --no-messages 才能
 *             在权限受限的外置卷上工作）
 *   - walk  （Node 并发遍历 + 结果缓存，零依赖最终兜底）
 *
 * 内容检索（可选参数 content / contentQuery，默认关闭，不改变原有行为）：
 *   在文件名候选集上做字面全文匹配；优先 rg -F，无 rg 时降级 Node 逐文件读取。
 *   返回命中文件 + 行号/上下文片段（每文件最多 3 段，控制体积）。
 *
 * 工具名与参数/返回结构固定（memory_evolve_search_local_files），换实现只改
 * provider，模型侧契约不变。默认禁用（searchDocsEnabled: false）：禁用时
 * 工具不注册，模型请求里根本没有这个工具。
 *
 * 零运行时依赖（仅 node 内置模块）。
 * @module dsh-memory-evolve/search-docs
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync,
} from 'node:fs'
import { readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { translate, getLocale, MISC2_DICT } from './i18n.js'

/** Translate through MISC2_DICT in the active host locale. */
const sdt = (key, params) => translate(MISC2_DICT, key, params, getLocale())

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
 * 支持 "*"（或 "all"）= 所有文件类型（全类型搜索须由调用方显式确认）。
 * @param {unknown} exts - LLM 传入的扩展名（数组或字符串）。
 * @param {string[]} fallback - 非法/为空时的默认列表。
 * @returns {string[]} 清洗后的扩展名列表（不含点、小写；含 "*" 表示全部）。
 */
export function normalizeExts(exts, fallback) {
  const raw = Array.isArray(exts)
    ? exts
    : typeof exts === 'string'
      ? exts.split(',').map((s) => s.trim()).filter(Boolean)
      : []
  const cleaned = [...new Set(raw.map((e) => String(e).trim().toLowerCase().replace(/^\./, '')))]
  const valid = cleaned.filter((e) => /^[a-z0-9*]{1,10}$/.test(e))
  if (valid.length === 0) return [...(fallback ?? [])]
  return valid
}

/** 扩展名列表是否表示"所有类型"。 */
export function isAllTypes(exts) {
  return Array.isArray(exts) && (exts.includes('*') || exts.includes('all'))
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
 * @param {string[]} paths
 * @param {number} concurrency
 * @param {number} maxEntries
 * @param {'file'|'dir'|'any'} kind - file=只收文件；dir=只收目录；any=都要
 */
async function statEntries(paths, concurrency = 32, maxEntries = 2000, kind = 'file') {
  const limited = paths.slice(0, maxEntries)
  const out = []
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, limited.length)) }, async () => {
    while (index < limited.length) {
      const path = limited[index++]
      try {
        const info = await stat(path)
        const isDir = info.isDirectory()
        if (kind === 'any' || (kind === 'dir' && isDir) || (kind === 'file' && info.isFile())) {
          out.push({ path, name: basename(path), mtime: Math.floor(info.mtimeMs), size: info.size, dir: isDir })
        }
      } catch {
        // 文件已消失/无权限：跳过
      }
    }
  })
  await Promise.all(workers)
  return out
}

/** 统一过滤：扩展名 + query 子串匹配，按 mtime 倒序（allTypes 时跳过 ext 过滤）。 */
function filterPaths(paths, { query, exts, limit }) {
  const extSet = new Set(exts)
  const allTypes = extSet.has('*') || extSet.has('all')
  const matched = []
  for (const path of paths) {
    const name = basename(path)
    if (!allTypes && !extSet.has(extname(name).slice(1).toLowerCase())) continue
    if (!matchQuery(name, query)) continue
    matched.push(path)
  }
  return matched
}

/**
 * 完整查询管线：path 列表 → 过滤 → stat → 排序 → 截断。
 *
 * **内容模式（limit=Infinity）不按 mtime 截断**：踩坑——全盘 md 上万个，
 * 若只 stat/返回"最新 N 个"，内容检索永远扫不到老文档（镇江陆军军事学院.md
 * 被 500 上限截掉的真实事故）。内容模式枚举全量候选（防御上限
 * CONTENT_ENUM_CAP），由调用方在**内容过滤之后**再按用户 limit 截断。
 * @param {string[]} paths
 * @param {{ query: string, exts: string[], limit: number, kind?: 'file'|'dir'|'any' }} params
 * @returns {Promise<Array<{path: string, name: string, mtime: number, size: number}>>}
 */
async function finalize(paths, { query, exts, limit, kind = 'file' }) {
  const matched = kind === 'file'
    ? filterPaths(paths, { query, exts, limit })
    : paths.filter((path) => matchQuery(basename(path), query))
  // 内容模式（Infinity）：stat 上限放宽到 CONTENT_ENUM_CAP（全量枚举）；
  // 文件名模式保持原 2000 上限（旧行为）。
  const maxEntries = Number.isFinite(limit)
    ? Math.min(2000, Math.max(1, limit))
    : CONTENT_ENUM_CAP
  const entries = await statEntries(matched, 32, maxEntries, kind)
  entries.sort((a, b) => b.mtime - a.mtime)
  return Number.isFinite(limit) ? entries.slice(0, limit) : entries
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
  async search({ query, exts, dir, limit, kind = 'file' }, { signal }) {
    // 扩展名收窄必须进索引查询：若只在 JS 端过滤，query 命中一堆非目标
    // 扩展名会全部被滤掉 → 空结果 → 降级全盘扫描（卡死主进程的根因）。
    const allTypes = isAllTypes(exts)
    const extPredicates = !allTypes && exts.length > 0
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
    // 目录搜索：Spotlight 用 contentType 限定文件夹；type=all 不加限制。
    if (kind === 'dir') predicates.push('kMDItemContentType == "public.folder"')
    const args = predicates.length > 0 ? [predicates.join(' && ')] : []
    if (dir) args.push('-onlyin', dir)
    const { stdout } = await runCmd('mdfind', args, { signal })
    const paths = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    return finalize(paths, { query, exts, limit, kind })
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
  async search({ query, exts, dir, limit, kind = 'file' }, { signal }) {
    // rg --files 只枚举文件，不列目录：目录/全部搜索不支持，抛错降级。
    if (kind !== 'file') throw new Error('rg 不支持目录搜索（已降级）')
    const args = []
    if (query) args.push('-n', query)
    const allTypes = isAllTypes(exts)
    if (!allTypes && exts.length > 0) args.push('-ext', exts.join(';'))
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
  async search({ query, exts, dir, limit, kind = 'file' }, { signal }) {
    // rg --files 只枚举文件、不列目录：目录/全部搜索不支持，抛错降级。
    if (kind !== 'file') throw new Error('rg 不支持目录搜索（已降级）')
    const roots = dir ? [dir] : defaultRoots()
    const args = ['--files', '--hidden', '--no-messages']
    const allTypes = isAllTypes(exts)
    if (!allTypes) {
      for (const ext of exts) args.push('-g', `*.${ext}`)
    }
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

/**
 * 并发目录遍历：收集文件（extSet 过滤）与/或目录（忽略列表过滤）。
 * maxFiles 预算截断，防慢盘无限期占住事件循环。
 * @param {string} root
 * @param {{ extSet: Set<string>, signal?: AbortSignal, concurrency?: number,
 *           maxFiles?: number, kind?: 'file'|'dir'|'any' }} opts
 */
async function walkFiles(root, { extSet, signal, concurrency = 16, maxFiles = 50000, kind = 'file' }) {
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
              if (WALK_IGNORE.has(name.toLowerCase())) continue
              const full = join(dir, name)
              if (kind === 'dir' || kind === 'any') found.push(full)
              queue.push(full)
            } else if (entry.isFile() && kind !== 'dir') {
              const ext = extname(name).slice(1).toLowerCase()
              if (kind === 'any' || extSet.has(ext)) found.push(join(dir, name))
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
    async search({ query, exts, dir, limit, kind = 'file' }, { signal }) {
      const allTypes = isAllTypes(exts)
      // 指定目录 / 目录搜索 / 全类型：不走缓存（缓存只覆盖文档类文件），
      // 直接扫该目录/全盘（预算截断兜底）。
      if (dir || kind !== 'file' || allTypes) {
        const roots = dir ? [dir] : defaultRoots().filter((root) => existsSync(root))
        const all = []
        for (const root of roots) {
          const paths = await walkFiles(root, { extSet, signal, maxFiles: kind === 'dir' ? 20000 : 50000, kind })
          all.push(...paths)
        }
        return finalize(all, { query, exts, limit, kind })
      }
      loadCache()
      const roots = defaultRoots().filter((root) => existsSync(root))
      const stale = roots.filter((root) => !cache?.roots?.[root] || Date.now() - cache.roots[root] > ttlMs)
      if (stale.length > 0 && !scanPromise) {
        // 后台重建索引（低并发，避免 IO 洪流）；查询绝不等待它。
        // 失败只记录、不重新抛出——重新抛出的 rejection 无人消费会变成
        // unhandled rejection（Node 严格模式/未来版本可能升级为进程崩溃，
        // P1-5）；下次查询自然重试。
        scanPromise = rebuild(stale, undefined).catch((error) => {
          scanPromise = null
          console.warn(`[dsh-memory-evolve] 文档索引后台重建失败（忽略，下次查询重试）：${error?.message ?? error}`)
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
// 内容检索（可选第二阶段：在文件名候选集上做字面全文匹配）
// ---------------------------------------------------------------------------

/**
 * 内容检索体积/安全上限（硬编码，避免单次工具调用拖垮主进程或撑爆上下文）。
 * - 单文件超过 CONTENT_MAX_FILE_BYTES 跳过（大文件/媒体安全）
 * - 每文件最多 CONTENT_MAX_SNIPPETS 个命中片段
 * - 片段行文本截断到 CONTENT_SNIPPET_LINE_MAX 字符
 * - 候选文件枚举上限 CONTENT_ENUM_CAP（内容模式枚举全量候选的防御上限，
 *   防止 allTypes 无扩展名过滤时候选爆炸；枚举后内容过滤，再按用户 limit 截断）
 */
const CONTENT_MAX_FILE_BYTES = 2 * 1024 * 1024
const CONTENT_MAX_SNIPPETS = 3
const CONTENT_CONTEXT_LINES = 1
/** 内容模式候选枚举防御上限（全盘 md 约 1 万级，2 万足够覆盖；再高会有 stat 开销）。 */
const CONTENT_ENUM_CAP = 20000
const CONTENT_SNIPPET_LINE_MAX = 200
const CONTENT_CANDIDATE_CAP = 500
/** 判定二进制：读文件头前 N 字节，出现 NUL 即跳过。 */
const CONTENT_BINARY_PROBE_BYTES = 8192

/**
 * 截断过长的行文本，避免单行 JSON/minified 源码撑爆返回体积。
 * @param {string} text
 * @returns {string}
 */
function truncateSnippetLine(text) {
  const s = String(text ?? '').replace(/\r$/, '')
  if (s.length <= CONTENT_SNIPPET_LINE_MAX) return s
  return `${s.slice(0, CONTENT_SNIPPET_LINE_MAX)}…`
}

/**
 * 快速判断路径是否像二进制文件（存在 NUL 字节）或过大不可读。
 * 读失败/超大一律视为"跳过"（安全优先，不抛到上层）。
 * @param {string} filePath
 * @param {number} [sizeHint] - 已知 size 时免去 stat
 * @returns {{ skip: boolean, size: number, reason: string }}
 */
export function probeContentFile(filePath, sizeHint) {
  let size = sizeHint
  try {
    if (size === undefined || size === null || !Number.isFinite(size)) {
      size = statSync(filePath).size
    }
  } catch {
    return { skip: true, size: 0, reason: 'stat-failed' }
  }
  if (!Number.isFinite(size) || size < 0) return { skip: true, size: 0, reason: 'bad-size' }
  if (size === 0) return { skip: true, size: 0, reason: 'empty' }
  if (size > CONTENT_MAX_FILE_BYTES) return { skip: true, size, reason: 'too-large' }

  // 二进制探测：读文件头，出现 0x00 即视为二进制（UTF-16 文本也会被跳过——可接受）
  let fd
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(Math.min(CONTENT_BINARY_PROBE_BYTES, size))
    const n = readSync(fd, buf, 0, buf.length, 0)
    for (let i = 0; i < n; i++) {
      if (buf[i] === 0) return { skip: true, size, reason: 'binary' }
    }
    return { skip: false, size, reason: '' }
  } catch {
    return { skip: true, size: size ?? 0, reason: 'read-failed' }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/**
 * 在单个文件文本中做字面（大小写不敏感）匹配，返回最多 maxSnippets 个片段。
 * @param {string} content - 完整文件文本
 * @param {string} contentQuery - 非空关键词
 * @param {{ maxSnippets?: number, contextLines?: number }} [opts]
 * @returns {Array<{ line: number, text: string, context: string }>}
 */
export function matchContentInText(content, contentQuery, opts = {}) {
  const maxSnippets = opts.maxSnippets ?? CONTENT_MAX_SNIPPETS
  const contextLines = opts.contextLines ?? CONTENT_CONTEXT_LINES
  const needle = String(contentQuery).toLowerCase()
  if (!needle || maxSnippets <= 0) return []

  // 统一换行，按行扫描；保留原始行文本用于展示
  const lines = String(content).split(/\r?\n/)
  const snippets = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(needle)) continue
    const lineNo = i + 1 // 1-based
    const from = Math.max(0, i - contextLines)
    const to = Math.min(lines.length - 1, i + contextLines)
    const contextParts = []
    for (let j = from; j <= to; j++) {
      contextParts.push(truncateSnippetLine(lines[j]))
    }
    snippets.push({
      line: lineNo,
      text: truncateSnippetLine(lines[i]),
      context: contextParts.join('\n'),
    })
    if (snippets.length >= maxSnippets) break
  }
  return snippets
}

/**
 * Node 降级路径：逐文件 probe → 读入 → 字面匹配。
 * 跳过二进制/过大/不可读文件；不抛错。
 * @param {Array<{ path: string, name: string, mtime?: number, size?: number, dir?: boolean }>} entries
 * @param {string} contentQuery
 * @param {{ signal?: AbortSignal, maxSnippets?: number, contextLines?: number }} [opts]
 * @returns {Promise<Array<object>>} 命中条目（原 entry + snippets）
 */
export async function nodeSearchFileContents(entries, contentQuery, opts = {}) {
  const { signal, maxSnippets = CONTENT_MAX_SNIPPETS, contextLines = CONTENT_CONTEXT_LINES } = opts
  const out = []
  for (const entry of entries) {
    if (signal?.aborted) throw new SearchAborted()
    // 目录没有"文件内容"可搜
    if (entry.dir === true) continue
    const probe = probeContentFile(entry.path, entry.size)
    if (probe.skip) continue
    let text
    try {
      text = readFileSync(entry.path, 'utf8')
    } catch {
      continue
    }
    const snippets = matchContentInText(text, contentQuery, { maxSnippets, contextLines })
    if (snippets.length === 0) continue
    out.push({
      path: entry.path,
      name: entry.name ?? basename(entry.path),
      mtime: entry.mtime ?? 0,
      size: entry.size ?? probe.size,
      dir: false,
      snippets,
    })
  }
  return out
}

/**
 * 解析 `rg --json` 输出（比 path:line:text 文本格式稳健：临时目录名常含
 * `-数字-`，会与上下文行 `path-line-text` 冲突导致误解析）。
 *
 * 每个 match 事件与其前后 context 事件组装成一个 snippet；
 * 同一文件片段数截断到 maxSnippets。
 *
 * @param {string} stdout - rg --json 的 NDJSON 输出
 * @param {number} maxSnippets
 * @returns {Map<string, Array<{ line: number, text: string, context: string }>>}
 */
export function parseRgContentOutput(stdout, maxSnippets = CONTENT_MAX_SNIPPETS) {
  /** @type {Map<string, Array<{ line: number, text: string, context: string }>>} */
  const byFile = new Map()
  /**
   * 按文件暂存尚未 flush 的上下文/命中行：
   * { contexts: [{line,text}], match: {line,text}|null }
   * rg --json 在 -C 模式下按顺序吐 context → match → context，遇 summary 或下一 match 前 flush。
   */
  /** @type {Map<string, { pending: Array<{ kind: string, line: number, text: string }> }>} */
  const buffers = new Map()

  const flushPath = (path) => {
    const buf = buffers.get(path)
    if (!buf || buf.pending.length === 0) return
    const match = buf.pending.find((l) => l.kind === 'match')
    if (match) {
      const list = byFile.get(path) ?? []
      if (list.length < maxSnippets) {
        list.push({
          line: match.line,
          text: truncateSnippetLine(match.text),
          context: buf.pending.map((l) => truncateSnippetLine(l.text)).join('\n'),
        })
        byFile.set(path, list)
      }
    }
    buf.pending = []
  }

  for (const raw of String(stdout).split('\n')) {
    if (!raw.trim()) continue
    let evt
    try {
      evt = JSON.parse(raw)
    } catch {
      continue // 非 JSON 行忽略（兼容极老 rg 或混入噪声）
    }
    if (!evt || !evt.type || !evt.data) continue
    const path = evt.data.path?.text
    if (!path) continue
    const line = evt.data.line_number
    // lines.text 末尾常带 \n，去掉以便展示
    const text = String(evt.data.lines?.text ?? '').replace(/\r?\n$/, '')

    if (evt.type === 'match') {
      // 新 match 前先结算上一段（防御性：正常流里 context 已挂在 pending）
      const buf = buffers.get(path) ?? { pending: [] }
      // 若 pending 里已有 match，先 flush 再开新块
      if (buf.pending.some((l) => l.kind === 'match')) flushPath(path)
      const next = buffers.get(path) ?? { pending: [] }
      next.pending.push({ kind: 'match', line, text })
      buffers.set(path, next)
    } else if (evt.type === 'context') {
      const buf = buffers.get(path) ?? { pending: [] }
      buf.pending.push({ kind: 'ctx', line, text })
      buffers.set(path, buf)
    } else if (evt.type === 'summary' || evt.type === 'end') {
      // 文件结束：flush 该文件（若 path 在 end 事件里）
      flushPath(path)
    }
  }
  // 收尾：所有未 flush 的文件
  for (const path of buffers.keys()) flushPath(path)
  return byFile
}

/**
 * 用 rg 在给定文件列表上做字面全文搜索（-F 固定字符串，-i 大小写不敏感）。
 * 使用 --json 输出以避免路径中的连字符/数字干扰解析。
 * 文件过多时分批调用，规避 ARG_MAX。
 * @param {string[]} paths
 * @param {string} contentQuery
 * @param {{ signal?: AbortSignal, maxSnippets?: number, contextLines?: number }} [opts]
 * @returns {Promise<Map<string, Array<{ line: number, text: string, context: string }>>>}
 */
async function rgSearchFileContents(paths, contentQuery, opts = {}) {
  const { signal, maxSnippets = CONTENT_MAX_SNIPPETS, contextLines = CONTENT_CONTEXT_LINES } = opts
  /** @type {Map<string, Array<{ line: number, text: string, context: string }>>} */
  const merged = new Map()
  // 每批约 200 个路径：避免命令行过长（macOS ARG_MAX），同时减少 spawn 次数。
  const BATCH = 200
  // 批次并发度：全盘候选可达上万文件（内容模式枚举全量），串行 100+ 次
  // spawn 会拖到几十秒；并发 6 个 rg 进程在 SSD 上把全盘内容检索压到几秒。
  const CONCURRENCY = 6
  const batches = []
  for (let i = 0; i < paths.length; i += BATCH) {
    batches.push(paths.slice(i, i + BATCH))
  }
  let next = 0
  const worker = async () => {
    while (next < batches.length) {
      if (signal?.aborted) throw new SearchAborted()
      const batch = batches[next++]
      if (batch === undefined) continue
      const args = [
        '--json', // NDJSON：路径/行号结构化，不受 path 中 `-` 数字干扰
        '-F', // 字面匹配（非正则）
        '-i', // 大小写不敏感，与文件名 matchQuery 一致
        '-C', String(contextLines),
        '--max-count', String(maxSnippets),
        '--no-messages',
        '-e', contentQuery,
        '--',
        ...batch,
      ]
      try {
        // rg 无匹配时 exit code = 1，仍属正常；runCmd 只看 stdout
        const { stdout } = await runCmd('rg', args, { signal, timeoutMs: 15000, maxBytes: 8 * 1024 * 1024 })
        const part = parseRgContentOutput(stdout, maxSnippets)
        for (const [path, snippets] of part) {
          const prev = merged.get(path) ?? []
          for (const s of snippets) {
            if (prev.length >= maxSnippets) break
            // 按行号去重
            if (!prev.some((p) => p.line === s.line)) prev.push(s)
          }
          merged.set(path, prev)
        }
      } catch (error) {
        if (error instanceof SearchAborted) throw error
        // 单批失败：跳过该批（权限/消失文件），继续其余
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()))
  return merged
}

/**
 * 在候选文件条目上做内容检索：优先 rg，不可用或全败时降级 Node 逐文件读取。
 * 保持候选条目的 mtime/size 元数据；只返回至少有一个片段的文件。
 * @param {Array<{ path: string, name: string, mtime?: number, size?: number, dir?: boolean }>} entries
 * @param {string} contentQuery - 非空关键词
 * @param {{ signal?: AbortSignal, preferNode?: boolean }} [opts]
 *   preferNode=true 时强制 Node 路径（测试用，跳过 rg）
 * @returns {Promise<Array<{ path: string, name: string, mtime: number, size: number, dir: boolean, snippets: Array }>>}
 */
export async function searchFileContents(entries, contentQuery, opts = {}) {
  const query = String(contentQuery ?? '').trim()
  if (!query) return []
  // 只处理文件；目录跳过
  const files = entries.filter((e) => e && e.path && e.dir !== true)
  if (files.length === 0) return []

  const { signal, preferNode = false } = opts
  const useRg = !preferNode && commandAvailable('rg', ['--version'])

  if (useRg) {
    // 先过滤明显不可读/过大/二进制，减少 rg 输入噪声
    const readable = []
    for (const entry of files) {
      if (signal?.aborted) throw new SearchAborted()
      const probe = probeContentFile(entry.path, entry.size)
      if (!probe.skip) readable.push(entry)
    }
    if (readable.length > 0) {
      try {
        const byPath = await rgSearchFileContents(
          readable.map((e) => e.path),
          query,
          { signal },
        )
        if (byPath.size > 0) {
          const out = []
          for (const entry of readable) {
            const snippets = byPath.get(entry.path)
            if (!snippets || snippets.length === 0) continue
            out.push({
              path: entry.path,
              name: entry.name ?? basename(entry.path),
              mtime: entry.mtime ?? 0,
              size: entry.size ?? 0,
              dir: false,
              snippets,
            })
          }
          // 保持原候选排序（通常已按 mtime 倒序）
          return out
        }
        // rg 跑完但无命中：信任结果，不再降级 Node（避免重复 IO）
        return []
      } catch (error) {
        if (error instanceof SearchAborted) throw error
        // rg 整体失败 → 降级 Node
      }
    }
  }

  return nodeSearchFileContents(files, query, { signal })
}

/**
 * 解析内容检索开关与关键词（参数设计，见 searchDocsToolDefinition description）。
 * - contentQuery 非空 → 隐式开启内容检索，关键词=contentQuery
 * - content===true → 显式开启，关键词=contentQuery 或回退 query
 * - 两者皆无 → 关闭（兼容旧调用）
 * @param {{ content?: unknown, contentQuery?: unknown, query?: string }} args
 * @param {string} query - 已 trim 的文件名 query
 * @returns {{ enabled: boolean, contentQuery: string }}
 */
export function resolveContentSearchArgs(args, query) {
  const rawCq = typeof args.contentQuery === 'string' ? args.contentQuery.trim() : ''
  const explicit = args.content === true
  const enabled = explicit || rawCq.length > 0
  if (!enabled) return { enabled: false, contentQuery: '' }
  const contentQuery = rawCq || query || ''
  return { enabled: true, contentQuery }
}

/**
 * 内容模式下的内部候选上限：在 limit 基础上扩容，但封顶 CONTENT_CANDIDATE_CAP。
 * 先拿更多文件名候选，再做内容过滤，最后按 limit 截断返回。
 * @param {number} limit
 * @returns {number}
 */
export function contentCandidateLimit(limit) {
  const base = Math.max(1, limit)
  return Math.min(CONTENT_CANDIDATE_CAP, Math.max(base * 25, 100))
}

// ---------------------------------------------------------------------------
// 工具定义（模型侧契约：memory_evolve_search_local_files）
// ---------------------------------------------------------------------------

/** 渲染搜索结果（工具输出 → 模型可见文本）。 */
export function renderSearchResult(value) {
  if (!value.ok) return `搜索失败：${value.message ?? '未知错误'}`
  if (!value.results || value.results.length === 0) {
    const mode = value.content ? '内容' : ''
    return `没有找到匹配的${mode}${value.type === 'dir' ? '文件夹' : value.type === 'any' ? '文件或文件夹' : '文档'}（provider: ${value.provider ?? 'none'}）`
  }
  const lines = value.results.map((result, index) => {
    const time = new Date(result.mtime).toISOString().slice(0, 16).replace('T', ' ')
    const size = result.size < 1024 ? `${result.size} B` : `${(result.size / 1024).toFixed(1)} KB`
    let line = `${index + 1}. ${result.path}（${size}，${time}）`
    // 内容检索：附带命中片段（行号 + 匹配行），便于模型直接定位
    if (Array.isArray(result.snippets) && result.snippets.length > 0) {
      const snipLines = result.snippets.map((s) => `    L${s.line}: ${s.text}`)
      line = `${line}\n${snipLines.join('\n')}`
    }
    return line
  })
  const noun = value.type === 'dir' ? '文件夹' : value.type === 'any' ? '文件/文件夹' : '文档'
  const modeHint = value.content ? `内容关键词「${value.contentQuery ?? ''}」` : '文件名'
  const head = `找到 ${value.count} 个${noun}（${modeHint}${value.truncated ? '，已截断，可增大 limit' : ''}，provider: ${value.provider}）：`
  return `${head}\n${lines.join('\n')}`
}

/**
 * 工具定义：memory_evolve_search_local_files。
 * @param {object} config - resolved config。
 * @param {(params: object, signal?: AbortSignal) => Promise<object>} search - 搜索函数。
 * @returns {object} ToolDefinition-shaped object。
 */
export function searchDocsToolDefinition(config, search) {
  const defaultExts = config.searchDocsExts ?? ['md']
  // 四档模式（searchDocsMode，运行时可改，见 createSearchDocsController）：
  //   all      = 文件名 + 内容检索都可用（默认）
  //   filename = 仅文件名搜索（content/contentQuery 参数被忽略）
  //   content  = 仅内容搜索（query 视为内容关键词，文件名过滤停用）
  //   off      = 工具不注册（由 controller sync 处理，不进本函数）
  const mode = config.searchDocsMode ?? 'all'
  const contentDesc = mode === 'filename'
    ? [
        '',
        '**内容检索已由插件配置禁用（仅文件名搜索模式）**：content / contentQuery 参数会被忽略，不会读取任何文件内容。',
      ]
    : mode === 'content'
      ? [
          '',
          '**【内容检索模式（插件配置：仅内容搜索）】**：每次调用都做文件内容字面匹配——query 参数视为内容关键词（等价 contentQuery），文件名过滤停用；type=dir 仍按文件夹名搜索。',
          '- contentQuery="关键词"：内容关键词（字面、大小写不敏感）；query 同义兜底。',
          '- 命中后每文件返回 1–3 个片段（行号 + 匹配行 + 少量上下文）；二进制与过大文件自动跳过。',
        ]
      : [
          '',
          '**【可选】内容检索（知识库问答："哪个文档里提过 XX"）**：',
          '- content=true：在文件名候选集上再做文件内容字面匹配；关键词默认复用 query。',
          '- contentQuery="关键词"：内容检索关键词；**只要传了非空 contentQuery 即隐式开启内容检索**（无需再传 content=true）。',
          '- 同时传 contentQuery 与 query 时：query 只过滤文件名，contentQuery 匹配文件内容。',
          '- 纯内容搜索（不限文件名）：query 留空 + contentQuery="XX"（或 content=true 且 query="XX"）。',
          '- 命中后每文件返回 1–3 个片段（行号 + 匹配行 + 少量上下文）；二进制与过大文件自动跳过。',
          '- 内容检索仅对文件生效（type=dir 时忽略内容参数）。',
        ]
  return {
    name: config.searchDocsToolName,
    description: [
      '在本机所有磁盘/目录中搜索文件。',
      '**默认只按文件名匹配**（不读内容），返回路径/名称/大小/修改时间。',
      `**主要用途：查找文档**——不传 exts 时默认只搜文档扩展名 ${JSON.stringify(defaultExts)}，不会枚举全部文件。`,
      '**搜索所有类型（图片/视频/任意扩展名）必须显式传 allTypes=true**（或 exts=["*"]）：结果集可能很大、首次全盘扫描较慢，非必要不要用。',
      'type=dir 可搜索文件夹名（建议配合 query 缩小范围）。',
      'query 为文件名关键字（子串、大小写不敏感；**中文文件名请尝试多个说法/同义词**——如"年报"查不到可换"述职"、"年度报告"等；无结果时换词再查或留空列出最近文档）。',
      'exts 限定扩展名（数组或逗号字符串）；dir 可限定搜索目录；limit 默认 20 最大 100。',
      ...contentDesc,
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '文件名关键字（子串匹配，大小写不敏感）；留空 = 不按文件名过滤（列出最近修改，或配合 contentQuery 做纯内容搜索）',
        },
        exts: {
          type: 'array',
          items: { type: 'string' },
          description: `扩展名列表（不含点，如 ["md","docx"]；也兼容 "md,docx" 字符串）；不传时默认 ${JSON.stringify(defaultExts)}（只搜文档）；["*"] = 所有类型（等同于 allTypes=true，需显式确认）`,
        },
        allTypes: {
          type: 'boolean',
          description: '**确认参数**：true = 显式确认搜索所有文件类型（忽略 exts；结果集可能很大、首次全盘扫描较慢）。不传 = 按 exts 搜索（默认只搜文档）',
        },
        type: {
          type: 'string',
          enum: ['file', 'dir', 'all'],
          description: 'file（默认）= 搜文件；dir = 搜文件夹名；all = 文件+文件夹',
        },
        dir: {
          type: 'string',
          description: '可选：限定搜索目录（绝对路径，或相对当前工作目录的相对路径）',
        },
        limit: {
          type: 'integer',
          description: '最多返回条数（默认 20，最大 100）',
        },
        content: {
          type: 'boolean',
          description: '可选：true = 开启内容检索（在文件名候选中做字面全文匹配）。默认 false，行为与旧版完全一致。若已传非空 contentQuery 则无需再传本参数（隐式开启）',
        },
        contentQuery: {
          type: 'string',
          description: '可选：内容检索关键词（字面、大小写不敏感）。非空时隐式开启内容检索；缺省且 content=true 时复用 query。与 query 同时传时：query 管文件名、contentQuery 管正文',
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
          type: { type: 'string' },
          count: { type: 'integer' },
          truncated: { type: 'boolean' },
          // content / contentQuery：始终返回，便于模型区分本次是否做了内容检索
          content: { type: 'boolean' },
          contentQuery: { type: 'string' },
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
                dir: { type: 'boolean' },
                // snippets 仅内容检索命中时出现；文件名模式不返回该字段
                snippets: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      line: { type: 'integer' },
                      text: { type: 'string' },
                      context: { type: 'string' },
                    },
                    required: ['line', 'text', 'context'],
                  },
                },
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
      // 全类型必须显式确认：allTypes=true，或 exts=["*"]（等价确认）。
      // 不传任何类型参数 → 默认文档扩展名，绝不静默全盘枚举。
      // 目录/全部搜索没有扩展名概念：exts 视为全类型，避免默认 ['md']
      // 混进索引谓词把目录结果过滤光。
      const kind = args.type === 'dir' ? 'dir' : args.type === 'all' ? 'any' : 'file'
      let exts
      try {
        exts = kind !== 'file' || args.allTypes === true ? ['*'] : normalizeExts(args.exts, defaultExts)
      } catch {
        return {
          ok: false,
          message: sdt('sd.badExts'),
          provider: '',
          type: kind,
          count: 0,
          truncated: false,
          content: false,
          contentQuery: '',
          results: [],
        }
      }
      let dir
      if (typeof args.dir === 'string' && args.dir.trim()) {
        const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
        dir = resolve(cwd, args.dir.trim())
      }
      const limit = Math.min(Math.max(Number.isFinite(args.limit) ? Math.floor(args.limit) : 20, 1), 100)

      // —— 四档模式（searchDocsMode，运行时可改）——
      //   all      = 文件名 + 内容检索都可用（默认）
      //   filename = 仅文件名：content/contentQuery 忽略（不读任何文件内容）
      //   content  = 仅内容：query 视为内容关键词（等价 contentQuery），
      //              文件名过滤停用（否则 query 同时滤文件名会把目标滤掉）
      //   off      = 工具不注册（controller sync 处理，不进 execute）
      const mode = config.searchDocsMode ?? 'all'
      const contentArgs = resolveContentSearchArgs(args, query)
      let contentEnabled = contentArgs.enabled && kind !== 'dir'
      let effectiveContentQuery = contentArgs.contentQuery
      // 文件名搜索关键词：content 模式清空（文件名过滤停用）。
      let fileNameQuery = query
      if (mode === 'filename') {
        contentEnabled = false
        effectiveContentQuery = ''
      } else if (mode === 'content') {
        contentEnabled = kind !== 'dir'
        effectiveContentQuery = contentArgs.contentQuery || query
        fileNameQuery = ''
      }

      // 内容模式：候选**枚举全量**（limit=Infinity → finalize 不按 mtime 截断），
      // 内容过滤后再按用户 limit 截断返回——否则老文档被"最新 N 个"截掉
      // （真实事故：全盘 md 10613 个，目标文件排在 500 名外永远搜不到）。
      const searchLimit = contentEnabled ? Number.POSITIVE_INFINITY : limit

      try {
        // 内容检索开启但关键词为空（content=true 且 query/contentQuery 都空）
        if (contentEnabled && !effectiveContentQuery) {
          return {
            ok: false,
            message: sdt('sd.contentNeedsQuery'),
            provider: '',
            type: kind,
            count: 0,
            truncated: false,
            content: true,
            contentQuery: '',
            results: [],
          }
        }

        const { provider, results } = await search(
          { query: fileNameQuery, exts, dir, limit: searchLimit, kind },
          signal,
        )

        // —— 仅文件名模式：与旧行为一致（不带 snippets / content 字段语义保持默认 false）——
        if (!contentEnabled) {
          return {
            ok: true,
            provider,
            type: kind,
            count: results.length,
            truncated: results.length > limit,
            content: false,
            contentQuery: '',
            results: results.slice(0, limit),
          }
        }

        // —— 内容检索第二阶段：在候选文件中做字面全文匹配 ——
        const contentHits = await searchFileContents(results, effectiveContentQuery, { signal })
        const truncated = contentHits.length > limit
        const sliced = contentHits.slice(0, limit)
        return {
          ok: true,
          provider,
          type: kind,
          count: sliced.length,
          truncated,
          content: true,
          contentQuery: effectiveContentQuery,
          results: sliced,
        }
      } catch (error) {
        const message = error instanceof SearchAborted
          ? error.message
          : `搜索失败：${error.message ?? String(error)}`
        return {
          ok: false,
          message,
          provider: '',
          type: kind,
          count: 0,
          truncated: false,
          content: contentEnabled,
          contentQuery: effectiveContentQuery || '',
          results: [],
        }
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
  let disposer = null
  let lastMode = null
  /** 解析生效模式（三级）：运行时显式 mode（Web 面板/slash 持久化）→ 配置
   *  mode（config.yaml 显式设置）→ 旧布尔开关兼容推断（true→all / false→off）。
   *  不在此处做 config 推断——resolveConfig 的 searchDocsMode 默认 null。 */
  const resolveMode = () => {
    const rt = getRuntime()
    if (typeof rt.searchDocsMode === 'string' && rt.searchDocsMode !== '') return rt.searchDocsMode
    if (config.searchDocsMode !== null && config.searchDocsMode !== undefined) return config.searchDocsMode
    const enabled = rt.searchDocsEnabled ?? config.searchDocsEnabled
    return enabled ? 'all' : 'off'
  }
  const sync = () => {
    // 四档模式：off = 工具不注册；其余按 mode 注册（description 随 mode 变化，
    // 因此 mode 切换时需卸载旧定义重注册——applyRuntimePatch 调 sync 即触发）。
    const mode = resolveMode()
    if (mode !== 'off') {
      if (disposer === null || lastMode !== mode) {
        disposer?.()
        disposer = ctx.tools.register(searchDocsToolDefinition({ ...config, searchDocsMode: mode }, search))
        lastMode = mode
      }
    } else if (disposer !== null) {
      disposer()
      disposer = null
      lastMode = null
    }
  }
  sync()
  return {
    sync,
    status() {
      const mode = resolveMode()
      const chain = resolveProviders(config).map((provider) => provider.name)
      return {
        enabled: mode !== 'off',
        mode,
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
        return { kind: 'success', text: sdt('sd.enabled', { tool: status.toolName, chain: status.providers.join(' → ') }) }
      }
      if (op === 'off') {
        ctrl.setEnabled(false)
        return { kind: 'success', text: sdt('sd.disabled') }
      }
      const status = ctrl.status()
      return {
        kind: 'success',
        text: sdt('sd.status', { state: status.enabled ? sdt('sd.on') : sdt('sd.off'), tool: status.toolName, chain: status.providers.join(' → '), exts: status.defaultExts.join(', ') }),
      }
    },
  }
}
