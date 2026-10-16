/**
 * lib/mflow-search.js — L3 语义检索工具（M-Flow）。
 *
 * 为什么需要它：三层记忆改造（MEMORY.md 之外，key/user 轨也在收窄为「只注入
 * 索引」）之后，**注入面只剩索引行**，正文要靠检索取回。若模型手里没有检索
 * 工具，索引就是死胡同——所以本工具与「只注入索引」是**一对**，缺一不可：
 * 先把检索工具接上、再收窄注入面，顺序不能反。
 *
 * 定位：与 memory_evolve_search_local_files（**字面/关键词**本地文件搜索）
 * 互补——本工具是**语义**检索（向量近邻），且检索面是 M-Flow 索引（L3，
 * 覆盖已迁出注入面的归档条目、项目日志、每日日志）。两者都不需要时用
 * memory 工具的 list/expand 按编号/身份证精确取。
 *
 * 架构：本模块是**守护进程客户端**，不是 M-Flow 的一部分。
 *   - 守护进程由用户在自己终端启动（mflow-home/bin 的启动脚本），
 *     把 `{port, token, pid, started}` 写到 daemon.json。
 *   - 本模块读 daemon.json → 连 127.0.0.1:<port> → 发**一行 JSON** →
 *     收**一行 JSON**。协议见 mflow-home/bin/mflow_daemon.py 的 handle()：
 *       请求 {token, query, limit, raw?, trace?, max_distance?}
 *       应答 {ok, query, results[], mode, elapsed_s}
 *     results 元素 = {id, score, content, source, dataset}（normalise()）
 *     + 溯源字段 entry_id / match_distance（add_provenance()）。
 *
 * **raw 模式（缺省开，配置 mflowRawOnly）**：守护进程把 `only_context=True`
 * 传给 M-Flow，返回的是**检索到的 Episode 证据原文**（EPISODIC summary 模式下
 * 按 "\n\n---\n\n" 连接的 Episode 摘要），不再调用本地小模型合成答案。
 * 依据：m_flow/search/methods/search.py:267 的 only_context 分支；合成路径
 * 会把弱相关 bundle 写成一段自信的散文（2026-10-12 阴性对照实证）。
 * `raw:false` 仍可取旧行为（合成答案），用于对照。
 *
 * 失败面（全部 fail-open，返回 ok:false + 可操作文案，绝不抛异常打断模型）：
 *   NO_DAEMON_FILE  守护进程未运行（daemon.json 不存在）→ 提示用户启动
 *   BAD_DAEMON_FILE daemon.json 损坏/缺字段
 *   UNREACHABLE     端口连不上（进程已退出，daemon.json 是残留）
 *   BAD_TOKEN       token 不匹配（daemon.json 是上一代进程的残留）
 *   TIMEOUT         查询超时
 *   BAD_REPLY       应答不是合法 JSON
 *
 * 为什么不自动拉起守护进程：拉起是「起常驻服务」，属用户侧动作（本机沙箱
 * 内 detached 进程会被 Job Object 回收，见项目记忆）。这里只报「请启动」。
 * @module dsh-memory-evolve/mflow-search
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { connect } from 'node:net'
import { isAbsolute, join } from 'node:path'

/** 工具名缺省值。 */
export const DEFAULT_SEARCH_TOOL_NAME = 'memory_search'

/** 守护进程描述文件缺省位置（可被 config.mflowDaemonFile 覆盖）。 */
export const DEFAULT_DAEMON_FILE = '~/.dsh/mflow/daemon.json'

/** 单次查询返回条数：缺省 5，上限 20（结果直接进上下文，防止一次拉爆）。 */
export const DEFAULT_SEARCH_LIMIT = 5
export const MAX_SEARCH_LIMIT = 20

/**
 * 查询超时。**2026-10-06 实测标定**：热态查询 4.3-4.8s；但守护进程启动后的
 * **第一次**查询要加载嵌入模型，实测 62.6s（墙钟）——30s 的初值会把冷启动
 * 判成 TIMEOUT（假失败）。故缺省取 90s：热态远够、冷启动也能过。这个值是
 * **最坏上界**，不是典型延迟。
 */
export const DEFAULT_SEARCH_TIMEOUT_MS = 90_000

/** 展开开头的 `~`（跨平台：Windows 也走 homedir()）。 */
export function expandHome(file) {
  const s = String(file ?? '')
  if (s === '~') return homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(homedir(), s.slice(2))
  return isAbsolute(s) ? s : join(process.cwd(), s)
}

/**
 * 读守护进程描述文件。
 * @param {string} file - daemon.json 路径（支持 `~`）。
 * @returns {{ok: true, port: number, token: string, pid: number|null, path: string}
 *   | {ok: false, error: string, message: string, path: string}}
 */
export function readDaemonInfo(file) {
  const path = expandHome(file)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        ok: false,
        error: 'NO_DAEMON_FILE',
        message: `M-Flow 守护进程未运行（未找到 ${path}）。请先在本机终端运行启动脚本，启动后 daemon.json 会自动出现。`,
        path,
      }
    }
    return { ok: false, error: 'NO_DAEMON_FILE', message: `读取 ${path} 失败：${error?.message ?? error}`, path }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: 'BAD_DAEMON_FILE', message: `${path} 不是合法 JSON：${error?.message ?? error}`, path }
  }
  const port = Number(parsed?.port)
  const token = parsed?.token
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || typeof token !== 'string' || token === '') {
    return { ok: false, error: 'BAD_DAEMON_FILE', message: `${path} 缺 port/token 或形态不符（进程可能正在启动中，稍后重试）`, path }
  }
  return { ok: true, port, token, pid: Number.isInteger(parsed.pid) ? parsed.pid : null, path }
}

/**
 * 向守护进程发一次查询（一行 JSON 请求 → 一行 JSON 应答）。
 * **不抛异常**：一切失败都落成 {ok:false, error, message}。
 * @param {{port: number, token: string}} info - readDaemonInfo 的成功返回。
 * @param {object} opts - { query, limit, timeoutMs, trace, maxDistance, signal }。
 * @returns {Promise<object>} 成功 {ok:true, results, elapsed_s, raw}；失败 {ok:false, error, message}。
 */
export function queryDaemon(info, opts = {}) {
  const query = String(opts.query ?? '').trim()
  if (query === '') return Promise.resolve({ ok: false, error: 'BAD_ARGS', message: 'query 不能为空' })
  const limit = clampLimit(opts.limit)
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_SEARCH_TIMEOUT_MS
  const request = { token: info.token, query, limit }
  if (opts.raw !== undefined) request.raw = opts.raw === true
  if (opts.trace !== undefined) request.trace = opts.trace
  if (opts.maxDistance !== undefined) request.max_distance = opts.maxDistance

  return new Promise((resolve) => {
    let settled = false
    let buf = ''
    let timer = null
    const sock = connect({ host: '127.0.0.1', port: info.port })
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      try { sock.destroy() } catch { /* 已断开 */ }
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => finish({ ok: false, error: 'ABORTED', message: '查询已取消' })
    if (opts.signal) {
      if (opts.signal.aborted) { finish({ ok: false, error: 'ABORTED', message: '查询已取消' }); return }
      opts.signal.addEventListener('abort', onAbort)
    }
    timer = setTimeout(
      () => finish({ ok: false, error: 'TIMEOUT', message: `查询超时（>${Math.round(timeoutMs / 1000)}s）：守护进程可能正在冷启动或过载。**守护进程启动后的第一次查询要加载嵌入模型，实测可到 60s 级**；重试一次通常就回到 5s 内。` }),
      timeoutMs,
    )
    sock.setEncoding('utf8')
    sock.on('connect', () => {
      try { sock.write(`${JSON.stringify(request)}\n`) } catch (error) { finish({ ok: false, error: 'UNREACHABLE', message: String(error?.message ?? error) }) }
    })
    sock.on('data', (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      let reply
      try {
        reply = JSON.parse(buf.slice(0, nl))
      } catch (error) {
        finish({ ok: false, error: 'BAD_REPLY', message: `守护进程应答不是合法 JSON：${error?.message ?? error}` })
        return
      }
      if (reply?.ok !== true) {
        const err = String(reply?.error ?? 'UNKNOWN')
        finish({
          ok: false,
          error: err,
          message: err === 'BAD_TOKEN'
            ? '守护进程拒绝了 token：daemon.json 是上一代进程的残留（进程重启过）。请确认守护进程仍在运行，或重新启动它。'
            : String(reply?.message ?? '守护进程返回失败'),
        })
        return
      }
      finish({
        ok: true,
        results: Array.isArray(reply.results) ? reply.results : [],
        elapsed_s: reply.elapsed_s,
        query: reply.query,
        // 老守护进程不带 mode：归一成 unknown，渲染时不做「原生/合成」断言，
        // 免得把合成答案标成原生证据（宁可不说，也不能说错）。
        mode: reply.mode === 'answer' ? 'answer' : (reply.mode === 'raw' ? 'raw' : 'unknown'),
      })
    })
    sock.on('error', (error) => {
      const code = error?.code ?? ''
      finish({
        ok: false,
        error: 'UNREACHABLE',
        message: code === 'ECONNREFUSED'
          ? `连不上 127.0.0.1:${info.port}——守护进程已退出（daemon.json 是残留）。请重新启动它。`
          : `连接守护进程失败：${error?.message ?? error}`,
      })
    })
    sock.on('close', () => finish({ ok: false, error: 'CLOSED', message: '守护进程在返回结果前关闭了连接。' }))
  })
}

/** limit 归一：非法值回落缺省，超上限钳制。 */
export function clampLimit(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SEARCH_LIMIT
  return Math.min(Math.floor(n), MAX_SEARCH_LIMIT)
}

/**
 * 字面兜底：调用注入的 literalScan 扫描记忆文件本体，把结果投成与语义检索
 * 同构的输出（mode='fallback-literal'）。扫描器未注入/抛异常/零命中一律
 * 返回 null（调用方回落原语义路径），本函数自身绝不抛。
 * @param {{ literalScan?: Function }} deps
 * @param {string} query
 * @param {unknown} limitArg
 * @param {object|undefined} exec
 * @returns {object|null}
 */
function literalFallback(deps, query, limitArg, exec) {
  const scan = typeof deps?.literalScan === 'function' ? deps.literalScan : null
  if (scan === null) return null
  let hits = null
  try {
    hits = scan(query, clampLimit(limitArg), exec)
  } catch {
    hits = null
  }
  if (!Array.isArray(hits) || hits.length === 0) return null
  return {
    ok: true,
    mode: 'fallback-literal',
    message: `字面兜底命中 ${hits.length} 条`,
    query,
    count: hits.length,
    elapsed_s: 0,
    results: hits.map((hit) => {
      const text = String(hit?.entry ?? '')
      return {
        content: text.length > 800 ? `${text.slice(0, 800)}…` : text,
        source: `literal:${hit?.track ?? '?'}`,
        dataset: '',
        entry_id: String(hit?.entryId ?? ''),
        match_distance: -1,
        score: -1,
      }
    }),
  }
}

/** 把守护进程结果裁剪成工具输出形态（**只保留声明过的字段**，配 additionalProperties:false）。 */
export function projectResults(results) {
  return (Array.isArray(results) ? results : []).map((r) => {
    const out = {
      content: String(r?.content ?? ''),
      source: String(r?.source ?? ''),
      dataset: String(r?.dataset ?? ''),
    }
    // entry_id 可能缺失（未开溯源 / 溯源失败 fail-open）→ 归一成空串，
    // 保证输出 schema 的字段集合恒定，模型不必猜「这个字段为什么有时没有」
    out.entry_id = r?.entry_id === null || r?.entry_id === undefined ? '' : String(r.entry_id)
    const dist = r?.match_distance
    out.match_distance = typeof dist === 'number' ? dist : -1
    const score = Number(r?.score)
    out.score = Number.isFinite(score) ? score : -1
    return out
  })
}

/** 渲染成给模型看的文本（工具输出的 text 部分）。 */
export function renderSearchResult(value) {
  if (value?.ok !== true) return value?.message ?? '检索失败'
  // 模式必须写在第一行：原生证据与合成答案的可信度不同，读的人要一眼分得清。
  const modeLabel = value.mode === 'fallback-literal'
    ? '语义检索·字面兜底（语义通道不可用或零命中，改为记忆文件字面多词扫描）'
    : value.mode === 'answer'
      ? '语义检索·合成答案（本地小模型，仅供线索）'
      : value.mode === 'raw'
        ? '语义检索·原生证据（M-Flow 直出，未经改写）'
        : '语义检索'
  const lines = [`${modeLabel}：${value.query}（命中 ${value.count} 条，${value.elapsed_s}s）`]
  if (value.count === 0) {
    lines.push('无命中。可换关键词/同义说法重试；若这是「索引里没有」的结论，请明说没有这条记录，不要编造。')
    return lines.join('\n')
  }
  for (const [i, r] of value.results.entries()) {
    const prov = r.entry_id ? `entry_id=${r.entry_id}` : 'entry_id=（无溯源）'
    const dist = r.match_distance >= 0 ? r.match_distance.toFixed(3) : 'n/a'
    lines.push(`\n--- [${i + 1}] ${prov} source=${r.source || '?'} dataset=${r.dataset || '?'} distance=${dist}`)
    lines.push(r.content)
  }
  return lines.join('\n')
}

/**
 * 构造 L3 语义检索工具定义。
 * @param {object} config - 插件配置（读 memorySearchToolName / mflowDaemonFile /
 *   mflowSearchLimit / mflowSearchTimeoutMs）。
 * @param {() => object} [getRuntime] - 取当前 runtime 配置（运行时改配置即时生效）。
 * @param {{ literalScan?: (query: string, limit: number, exec?: object) => Array<{track: string, entry: string, entryId?: string}> }} [deps]
 *   - literalScan：字面兜底扫描器（由装配层注入，扫记忆文件本体）。缺省无兜底。
 * @returns {object} DSH 工具定义。
 */
export function memorySearchToolDefinition(config, getRuntime, deps = {}) {
  const cfg = () => ({ ...config, ...(typeof getRuntime === 'function' ? getRuntime() : {}) })
  return {
    name: config.memorySearchToolName ?? DEFAULT_SEARCH_TOOL_NAME,
    description: [
      '按**语义**检索本机长期记忆的 L3 索引（M-Flow 向量库），返回最相近条目的**正文**与溯源。',
      '',
      '**什么时候用它**：注入到上下文里的记忆只有**索引行**（一行摘要），当你需要某条的**完整正文**、或需要检索索引里没列出的历史记忆（归档条目、项目日志、每日日志）时用它。',
      '- 与 memory 工具的分工：`list`/`expand` 按**编号或身份证**精确取（用于索引里已列出的条目）；本工具按**意思**模糊取（用于不知道编号、或索引里没有的）。',
      '- 与 memory_evolve_search_local_files 的分工：那个是**字面关键词**搜文件；本工具是**语义**检索，换个说法也能命中。',
      '- 返回的 `entry_id`（形如 `memory:ab12cd34`）可直接交给 memory 工具 `expand` 取全文/查命中。',
      '',
      '**返回什么（raw 模式）**：默认返回 M-Flow **检索到的证据原文**，不经过本地小模型改写——正文就是记忆条目本身，`entry_id` 是它的溯源身份。',
      '（把配置 `mflowRawOnly` 置 false 会退回「本地模型基于证据合成答案」的旧行为；合成文本只当线索，判断依据一律以 entry_id 回溯原文为准。）',
      '',
      '**依赖**：需要本机 M-Flow 守护进程在运行（它把端口写进 daemon.json）。未运行时会返回明确的启动指引——这不是错误，按指引启动后重试即可。',
      '**无命中时**：如实说「没有这条记录」，不要凭印象补全内容。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要检索的内容（自然语言即可，不必是精确关键词）。用中文/英文按记忆原本的语种提问命中率最高。',
        },
        limit: {
          type: 'integer',
          description: `返回条数（默认 ${DEFAULT_SEARCH_LIMIT}，上限 ${MAX_SEARCH_LIMIT}）。结果正文直接进上下文，非必要不要调大。`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          query: { type: 'string' },
          count: { type: 'integer' },
          elapsed_s: { type: 'number' },
          error: { type: 'string' },
          mode: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string' },
                source: { type: 'string' },
                dataset: { type: 'string' },
                entry_id: { type: 'string' },
                match_distance: { type: 'number' },
                score: { type: 'number' },
              },
              required: ['content', 'source', 'dataset', 'entry_id', 'match_distance', 'score'],
            },
          },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: renderSearchResult(value) }],
    },
    async execute(args, exec) {
      const runtime = cfg()
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (query === '') {
        return { ok: false, error: 'BAD_ARGS', message: 'query 不能为空', query: '', count: 0, elapsed_s: 0, results: [] }
      }
      const info = readDaemonInfo(runtime.mflowDaemonFile ?? DEFAULT_DAEMON_FILE)
      if (!info.ok) {
        // 字面兜底：守护进程文件缺失/损坏（大概率未启动）时同样先兜底再失败
        const fallback = literalFallback(deps, query, args?.limit, exec)
        if (fallback !== null) return fallback
        return { ok: false, error: info.error, message: info.message, query, count: 0, elapsed_s: 0, results: [] }
      }
      const res = await queryDaemon(info, {
        query,
        limit: args?.limit ?? runtime.mflowSearchLimit ?? DEFAULT_SEARCH_LIMIT,
        timeoutMs: runtime.mflowSearchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
        // 原生证据为缺省（用户 2026-10-12 裁定）；只有显式关掉才走合成。
        raw: runtime.mflowRawOnly !== false,
        signal: exec?.signal,
      })
      if (!res.ok) {
        // 字面兜底（2026-10-16）：守护进程不可用（未启动/超时/坏回包）时，
        // 回落字面多词 AND 扫描记忆文件本体。语义库与记忆轨存在结构性时间
        // 差（补量滞后，可能差数天），语义通道查不到不等于没有这条记录。
        const fallback = literalFallback(deps, query, args?.limit, exec)
        if (fallback !== null) return fallback
        return { ok: false, error: res.error, message: res.message, query, count: 0, elapsed_s: 0, results: [] }
      }
      const results = projectResults(res.results)
      if (results.length === 0) {
        // 语义零命中同样兜底：换一条便宜的字面通道再确认一次，仍零命中才
        // 下「没有」的结论（fail-open：扫描器任何异常都不改变失败返回）。
        const fallback = literalFallback(deps, query, args?.limit, exec)
        if (fallback !== null) return fallback
      }
      return {
        ok: true,
        message: `命中 ${results.length} 条`,
        query,
        count: results.length,
        elapsed_s: Number(res.elapsed_s) || 0,
        mode: typeof res.mode === 'string' ? res.mode : 'unknown',
        results,
      }
    },
  }
}
