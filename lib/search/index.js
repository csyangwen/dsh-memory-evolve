/**
 * 会话搜索模块 — 装配入口与模型工具（de_session_search）。
 *
 * 独立子模块（用户拍板 2026-08-08：明显独立的子模块不挂在别的模块下）：
 *   - 独立开关 sessionSearchEnabled（默认关，与 COI/广播一致）；
 *   - 不依赖 COI 调度器、不使用记忆存储；
 *   - 零常驻状态：每次调用实时发现 + 扫描，无索引、无缓存、无定时器；
 *   - 只读：不修改任何会话文件。
 *
 * 搜索编排（每次工具调用）：
 *   1. discoverCodexFiles() 发现 ~/.codex/sessions + archived_sessions 的 JSONL；
 *   2. rg 预筛（可选）：对明文 JSONL 用 ripgrep 字面匹配缩小候选集
 *      （rg 失败/缺失/查询含转义字符时回退全量解析，结果始终以解析后
 *      的正文匹配为准——预筛只是加速手段，不是正确性依赖）；
 *   3. 逐文件流式解析 → 逐会话计算命中 → 有界 Top-K 累积；
 *   4. 返回 JSON 文本（query/count/hits：命中会话 + 最强消息 + snippet + 窗口）。
 *
 * 性能实测（本机）：Codex 语料约 46MB / 33 文件，rg 全扫 12ms，
 * 全程毫秒级——无需索引。DSH 会话（zstd 拼接帧）暂不支持，未来
 * 接入官方 session-query 或帧偏移增量索引后再扩展。
 */

import { spawn } from 'node:child_process'
import { discoverCodexFiles, parseCodexFile } from './codex.js'
import {
  canRawPrefilter, clip, createTopK, hitForSession, normalize, DEFAULT_LIMIT, LIMIT_MAX, DEFAULT_WINDOW, WINDOW_MAX,
} from './core.js'

/** rg 单批文件数（防单次命令行参数过长）。 */
const RG_BATCH_SIZE = 128
/** rg 输出字节上限（超出按失败回退全量解析，防异常输出）。 */
const RG_OUTPUT_LIMIT = 8 * 1024 * 1024
/** rg 单批超时（防御：rg 卡住时不挂死工具调用）。 */
const RG_TIMEOUT_MS = 30_000

/**
 * 运行一次 ripgrep 字面匹配，返回命中文件集合。
 * @param {readonly string[]} paths - 候选文件。
 * @param {string} query - 搜索词（字面，非正则）。
 * @param {AbortSignal | undefined} signal - 工具取消信号。
 * @param {typeof spawn} spawnFn - 可注入的 spawn（测试用）。
 * @returns {Promise<Set<string> | undefined>} undefined=失败（调用方回退全量）。
 */
function runRipgrep(paths, query, signal, spawnFn) {
  return new Promise((resolve) => {
    const child = spawnFn('rg', [
      '--files-with-matches', '--fixed-strings', '--ignore-case',
      '--null', '--no-messages', '--', query, ...paths,
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks = []
    let size = 0
    let settled = false
    // 防御超时：rg 异常卡住时不挂死整个工具调用
    const timer = setTimeout(() => {
      if (settled) return
      try { child.kill() } catch { /* 已退出 */ }
      settled = true
      signal?.removeEventListener('abort', abort)
      resolve(undefined)
    }, RG_TIMEOUT_MS)
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(value)
    }
    const abort = () => {
      try { child.kill() } catch { /* 已退出 */ }
      finish(undefined)
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', () => finish(undefined)) // rg 不存在/启动失败：回退全量
    child.stdout.on('data', (chunk) => {
      size += chunk.byteLength
      if (size > RG_OUTPUT_LIMIT) {
        try { child.kill() } catch { /* 已退出 */ }
        finish(undefined)
        return
      }
      chunks.push(chunk)
    })
    child.on('close', (code) => {
      // rg 退出码：0=有命中 1=无命中 2=错误（错误走回退）
      finish(code === 0 || code === 1 ? Buffer.concat(chunks).toString('utf8') : undefined)
    })
  })
}

/**
 * rg 预筛：返回命中文件集合；无法预筛（查询含转义字符/无 rg/出错）返回
 * undefined，调用方回退全量解析。
 * @param {readonly { path: string }[]} files
 * @param {string} query
 * @param {AbortSignal | undefined} signal
 * @param {typeof spawn} spawnFn
 * @returns {Promise<Set<string> | undefined>}
 */
async function prefilterFiles(files, query, signal, spawnFn) {
  if (!canRawPrefilter(query)) return undefined
  const matches = new Set()
  for (let start = 0; start < files.length; start += RG_BATCH_SIZE) {
    const batch = files.slice(start, start + RG_BATCH_SIZE)
    const output = await runRipgrep(batch.map((f) => f.path), query, signal, spawnFn)
    if (output === undefined) return undefined // 任何一批失败都回退全量
    for (const path of output.split('\u0000')) {
      if (path.length > 0) matches.add(path)
    }
  }
  return matches
}

/**
 * 执行一次搜索（发现 → 预筛 → 解析 → Top-K）。
 * @param {object} request - { query, cwd?, sort?, limit?, window? }。
 * @param {object} options - { root?: string, spawn: typeof spawn, signal? }。
 *   root 为 Codex 根目录覆盖（config.sessionSearchRoots.codex）。
 * @returns {Promise<{ query: string, count: number, hits: object[] }>}
 */
export async function runSessionSearch(request, options) {
  const query = String(request.query ?? '').trim()
  if (query.length === 0) {
    return { query, count: 0, hits: [] }
  }
  // abort 预检：已取消的调用直接抛（与循环内 throwIfAborted 语义一致）
  if (options.signal?.aborted === true) throw options.signal.reason
  const sort = request.sort === 'newest' || request.sort === 'oldest' ? request.sort : 'relevance'
  const limit = Number.isSafeInteger(request.limit) && request.limit > 0
    ? Math.min(request.limit, LIMIT_MAX)
    : DEFAULT_LIMIT
  const window = Number.isSafeInteger(request.window) && request.window > 0
    ? Math.min(request.window, WINDOW_MAX)
    : DEFAULT_WINDOW
  const cwd = typeof request.cwd === 'string' && request.cwd.trim().length > 0 ? request.cwd.trim() : undefined

  const files = await discoverCodexFiles(options.root)
  const normalizedQuery = normalize(query)

  // 预筛（可失败回退）：缩小候选集，命中集合外的不再解析
  const prefiltered = await prefilterFiles(files, query, options.signal, options.spawn)
  const candidates = prefiltered === undefined
    ? files
    : files.filter((f) => prefiltered.has(f.path))

  const topK = createTopK(limit, sort)
  for (const file of candidates) {
    if (options.signal?.aborted === true) throw options.signal.reason
    const parsed = await parseCodexFile(file.path)
    if (parsed === undefined) continue
    const hit = hitForSession(parsed, { cwd, window }, normalizedQuery)
    if (hit !== undefined) topK.push(hit)
  }

  const hits = topK.values().map((hit) => ({
    source: hit.session.source,
    sessionId: hit.session.sessionId,
    title: hit.session.title,
    cwd: hit.session.cwd,
    updatedAt: hit.session.updatedAt,
    snippet: hit.snippet,
    bestMatch: {
      role: hit.bestMatch.role,
      seq: hit.bestMatch.seq,
      text: clip(hit.bestMatch.content),
    },
    window: hit.window.map((m) => ({
      seq: m.seq,
      role: m.role,
      text: clip(m.content),
    })),
  }))
  return { query, count: hits.length, hits }
}

/**
 * de_session_search 工具定义。
 * 用法细节全部写在 description（function calling 通道自解释、模型天然可见
 * ——用户拍板原则：提示词注入只放纪律，工具细节放 description）。
 * @param {object} options - { root?: string, spawn?: typeof spawn }。
 * @returns {object} 可直接进 ctx.tools.register 的工具定义。
 */
export function sessionSearchToolDefinition(options = {}) {
  const spawnFn = options.spawn ?? spawn
  const root = options.root
  return {
    name: 'de_session_search',
    description: '搜索本机其他 AI 工具的历史会话（当前支持 Codex：~/.codex/sessions 与 archived_sessions 的 JSONL 会话记录；DSH 会话暂不支持）。大小写不敏感的字面匹配（中文/英文/标点同一规则），只搜用户与助手消息（工具输出不搜）；返回命中会话 + 最强消息摘要（snippet）+ 命中处上下文消息窗口。结果来自历史会话的只读快照，不修改任何文件、不建索引。每次调用实时扫描，Codex 语料小时毫秒级完成。建议先用 cwd 限定项目（Codex 会话记录工作目录），再按需用 sort/limit/window 控制结果规模。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的文本（字面匹配，大小写不敏感；中英文均可）' },
        source: { type: 'string', enum: ['codex'], description: '会话来源（当前仅 codex，后续扩展 claude/pi/opencode 等）' },
        cwd: { type: 'string', description: '可选：只搜工作目录包含该子串的会话（大小写不敏感）' },
        sort: { type: 'string', enum: ['relevance', 'newest', 'oldest'], description: '结果排序：relevance=命中次数优先（默认）/newest=最新在前/oldest=最旧在前' },
        limit: { type: 'number', description: `可选：最多返回的会话数（默认 ${DEFAULT_LIMIT}，上限 ${LIMIT_MAX}）` },
        window: { type: 'number', description: `可选：每个命中返回的消息窗口大小（默认 ${DEFAULT_WINDOW}，上限 ${WINDOW_MAX}）` },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const result = await runSessionSearch(args, {
        root,
        spawn: spawnFn,
        signal: exec?.signal,
      })
      return JSON.stringify(result, null, 2)
    },
  }
}

/**
 * 安装会话搜索模块（独立装配，sessionSearchEnabled 打开时由主插件调用）。
 * @param {object} ctx - cordis ctx（需注入 tools）。
 * @param {object} config - resolved plugin config（含 sessionSearchRoots）。
 * @returns {{ dispose: () => void }} 卸载句柄。
 */
export function installSessionSearch(ctx, config) {
  const disposers = []
  disposers.push(ctx.effect(() => {
    const d = ctx.tools.register(sessionSearchToolDefinition({
      root: config.sessionSearchRoots?.codex,
    }))
    return () => d?.()
  }, 'dsh-memory-evolve: session search tool'))
  return {
    dispose() {
      for (const d of disposers) {
        try { d?.() } catch { /* 忽略 */ }
      }
    },
  }
}
