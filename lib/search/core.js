/**
 * 会话搜索核心 — 纯函数（无 IO，便于单元测试）。
 *
 * 设计目标（对齐 dsh-session-search 的经验教训）：
 *  - 大小写不敏感的字面子串匹配（中英文/标点同一规则，不做分词）；
 *  - 只搜 user/assistant 消息（工具输出不进检索，避免噪声）；
 *  - 每个会话以"命中次数最多的消息"为代表，同分按时间/seq 决胜；
 *  - 结果只保留有界 Top-K（插入排序 + 截断，内存有界）；
 *  - snippet 以首个命中为中心取 350 字符窗口；
 *  - 全部为纯函数：解析/发现/预筛在 codex.js 与 index.js 完成，
 *    这里只做"已解析会话 → 命中列表"的变换。
 *
 * 与 dsh-session-search 的差异（吸取其被 5 家 CLI 指出的问题）：
 *  - 不做 FTS5 索引、不建库（语料小，直接扫描足够快）；
 *  - 坏行宽容：解析器跳过坏行而不是淘汰整个会话文件（见 codex.js）。
 */

/** 单条消息入检索的文本上限（超长截断，防工具输出/大块文本灌入）。 */
export const MAX_MSG_CHARS = 4000
/** 单个会话文件字节上限（超过直接跳过该文件，防异常大文件拖垮扫描）。 */
export const MAX_FILE_BYTES = 64 * 1024 * 1024
/** 单行 JSON 字节上限（超过按坏行跳过）。 */
export const MAX_LINE_CHARS = 512 * 1024
/** snippet 字符数（命中为中心，前后各取一半）。 */
export const SNIPPET_CHARS = 350
/** 工具输出中单条消息文本的裁剪上限（模型可见部分，防撑爆上下文）。 */
export const CLIP_CHARS = 600
/** 默认返回的最大会话数。 */
export const DEFAULT_LIMIT = 10
/** limit 参数硬上限（防模型一次拉太多）。 */
export const LIMIT_MAX = 50
/** 默认消息窗口大小。 */
export const DEFAULT_WINDOW = 10
/** window 参数硬上限。 */
export const WINDOW_MAX = 30

/** 角色过滤：搜索只覆盖用户与助手消息。 */
export const SEARCH_ROLES = new Set(['user', 'assistant'])

/**
 * 归一化（大小写不敏感）：统一转小写后再做子串匹配。
 * 中文无大小写概念，原样保留；英文按 locale 无关的小写转换。
 * @param {string} value
 * @returns {string}
 */
export function normalize(value) {
  return value.toLocaleLowerCase()
}

/**
 * 计算 query 在 value 中出现的次数（字面子串，非重叠计数）。
 * 内部做大小写归一化，调用方无需预归一化（防御误用）。
 * @param {string} value - 被搜索文本。
 * @param {string} query - 搜索词（非空）。
 * @returns {number} 出现次数。
 */
export function occurrenceCount(value, query) {
  const haystack = normalize(value)
  const needle = normalize(query)
  if (needle.length === 0 || needle.length > haystack.length) return 0
  let count = 0
  let offset = 0
  while (offset <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, offset)
    if (found < 0) break
    count += 1
    // 前进至少一个字符：非重叠计数，避免 "aaa" 查 "aa" 数出 2 次
    offset = found + Math.max(1, needle.length)
  }
  return count
}

/**
 * 截取命中周围的 snippet：以首个命中为中心，前后各 SNIPPET_CHARS/2，
 * 边界补省略号；内容短于上限时原样返回。
 * @param {string} content - 原始消息文本（未归一化）。
 * @param {string} normalizedQuery - 已归一化的搜索词。
 * @returns {string}
 */
export function snippet(content, normalizedQuery) {
  if (content.length <= SNIPPET_CHARS) return content
  const match = normalize(content).indexOf(normalizedQuery)
  if (match < 0) return `${content.slice(0, SNIPPET_CHARS)}…`
  const before = Math.floor((SNIPPET_CHARS - normalizedQuery.length) / 2)
  const start = Math.max(0, Math.min(match - before, content.length - SNIPPET_CHARS))
  const end = Math.min(content.length, start + SNIPPET_CHARS)
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`
}

/**
 * 以 index 为中心取消息窗口（前后对称，越界自动收缩到数组边界）。
 * @template T
 * @param {readonly T[]} values - 消息数组。
 * @param {number} index - 中心消息下标。
 * @param {number} size - 窗口大小（>=1）。
 * @returns {T[]}
 */
export function centeredWindow(values, index, size) {
  const before = Math.floor((size - 1) / 2)
  let start = Math.max(0, index - before)
  const end = Math.min(values.length, start + size)
  start = Math.max(0, end - size)
  return values.slice(start, end)
}

/**
 * 消息新旧比较（时间戳优先，同时间比 seq）。
 * @param {import('./codex.js').CodexMessage} a
 * @param {import('./codex.js').CodexMessage} b
 * @returns {boolean} a 比 b 新。
 */
export function newerMessage(a, b) {
  if (a.ts !== b.ts) return a.ts > b.ts
  return a.seq > b.seq
}

/**
 * 命中排序：relevance=命中次数降序（次按时间降序）；newest/oldest=按会话
 * 更新时间；全部再按（时间,源,id）稳定决胜。
 * @param {import('./codex.js').CodexSessionHit} left
 * @param {import('./codex.js').CodexSessionHit} right
 * @param {'relevance'|'newest'|'oldest'} sort
 * @returns {number} 负数=left 在前。
 */
export function compareHits(left, right, sort) {
  if (sort === 'newest' || sort === 'oldest') {
    const direction = sort === 'newest' ? -1 : 1
    const byTime = direction * (left.session.updatedAt - right.session.updatedAt)
    if (byTime !== 0) return byTime
  } else if (left.score !== right.score) {
    return right.score - left.score
  }
  if (left.bestMatch.ts !== right.bestMatch.ts) return right.bestMatch.ts - left.bestMatch.ts
  if (left.session.updatedAt !== right.session.updatedAt) return right.session.updatedAt - left.session.updatedAt
  return `${left.session.source}\u0000${left.session.sessionId}`
    .localeCompare(`${right.session.source}\u0000${right.session.sessionId}`)
}

/**
 * 计算单个已解析会话的命中（最强消息 + snippet + 窗口）。
 * @param {import('./codex.js').CodexParsedSession} parsed - 已解析会话。
 * @param {object} request - 搜索请求（见 searchSessions）。
 * @param {string} normalizedQuery - 已归一化的搜索词。
 * @returns {import('./codex.js').CodexSessionHit | undefined} 无命中返回 undefined。
 */
export function hitForSession(parsed, request, normalizedQuery) {
  // cwd 过滤：大小写不敏感子串（会话 cwd 未知时仅当未指定 cwd 才放行）
  if (request.cwd !== undefined && request.cwd.length > 0
    && !normalize(parsed.session.cwd).includes(normalize(request.cwd))) {
    return undefined
  }
  let strongest
  for (const message of parsed.messages) {
    if (!SEARCH_ROLES.has(message.role)) continue
    const score = occurrenceCount(normalize(message.content), normalizedQuery)
    if (score === 0) continue
    if (strongest === undefined
      || score > strongest.score
      || (score === strongest.score && newerMessage(message, strongest.message))) {
      strongest = { message, score }
    }
  }
  if (strongest === undefined) return undefined
  const matchIndex = parsed.messages.findIndex((m) => m.seq === strongest.message.seq)
  return {
    session: parsed.session,
    bestMatch: strongest.message,
    snippet: snippet(strongest.message.content, normalizedQuery),
    window: matchIndex < 0 ? [] : centeredWindow(parsed.messages, matchIndex, request.window ?? DEFAULT_WINDOW),
    score: strongest.score,
  }
}

/**
 * 在已解析会话集合上执行搜索（纯函数）。
 * @param {readonly import('./codex.js').CodexParsedSession[]} sessions
 * @param {object} request - { query, cwd?, sort?, limit?, window? }
 *   query 必填；sort 默认 relevance；limit 默认 DEFAULT_LIMIT。
 * @returns {import('./codex.js').CodexSessionHit[]} 排序后截断的命中列表。
 */
export function searchSessions(sessions, request) {
  const query = String(request.query ?? '').trim()
  if (query.length === 0) return []
  const normalizedQuery = normalize(query)
  const sort = request.sort === 'newest' || request.sort === 'oldest' ? request.sort : 'relevance'
  const limit = Number.isSafeInteger(request.limit) && request.limit > 0
    ? Math.min(request.limit, LIMIT_MAX)
    : DEFAULT_LIMIT
  const hits = []
  for (const parsed of sessions) {
    const hit = hitForSession(parsed, request, normalizedQuery)
    if (hit !== undefined) hits.push(hit)
  }
  hits.sort((a, b) => compareHits(a, b, sort))
  return hits.slice(0, limit)
}

/**
 * 有界 Top-K 累积器：搜索过程中逐会话插入，保持有序且长度不超过 limit
 * （避免全量收集后再排序的内存峰值）。
 * @param {number} limit
 * @param {'relevance'|'newest'|'oldest'} sort
 * @returns {{ push(hit): void, values(): import('./codex.js').CodexSessionHit[] }}
 */
export function createTopK(limit, sort) {
  const hits = []
  return {
    push(hit) {
      hits.push(hit)
      hits.sort((a, b) => compareHits(a, b, sort))
      if (hits.length > limit) hits.length = limit
    },
    values() {
      return hits
    },
  }
}

/**
 * 输出裁剪：模型可见文本上限（超长截断加省略号）。
 * @param {string} content
 * @returns {string}
 */
export function clip(content) {
  return content.length > CLIP_CHARS ? `${content.slice(0, CLIP_CHARS)}…` : content
}

/**
 * 请求是否可以用 rg 做原始行预筛：rg 匹配的是 JSON 原文行，含引号/控制
 * 字符的查询会与 JSON 转义后的内容不一致，此时跳过预筛直接全量解析
 * （结果仍以解析后的正文匹配为准，预筛只是加速手段）。
 * @param {string} query
 * @returns {boolean}
 */
export function canRawPrefilter(query) {
  return query.length > 0 && !/["\\\u0000-\u001f]/u.test(query)
}
