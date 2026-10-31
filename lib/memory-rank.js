/**
 * dsh-memory-evolve — 记忆检索（词法层，零依赖、无 import）。
 *
 * 背景（2026-10-25 实测）：\`memory list\` 的 \`filter\` 原实现是「整串大小写不敏感
 * 子串 + 时间正序 + limit 截断」，两个结构性缺陷：
 *   1. 只接受**一个**子串——中文整句提问（无空格）几乎必然返回空。本机 12 问实测
 *      整句命中@3 = 0/12，而摘要注入模式下模型恰恰只能靠这个入口找条目。
 *   2. 命中后**没有相关性排序**——泛词会淹没结果（filter=ST 命中 171/489 条，
 *      首条还是含英文 ST 的无关条目）。
 *
 * 本模块提供一个入口 searchIndices()，三级语义（见其文档）：
 *   整串子串（旧语义，逐条不变） → 多词 OR（空格分词） → 词法相关性召回（整句兜底）。
 * rank=true 时对命中集再做相关性排序（字符二元组 TF-IDF 余弦 + 关键词覆盖加成
 * + 同分时新的在前）。中文按字符二元组切词（无需分词器），ASCII/数字按词切。
 *
 * 调用方负责传入「匹配用文本」（store.normalizeForMatch 的结果）；本模块另行剥掉
 * 条目**头部**的方括号 token（日期/[id]/[branch]/[dsh-only]/[summary]/[git]）——
 * 实测教训：日期里的数字若参与打分，两条只有日期不同的同文条目得分就会不同，
 * 「同分时新的在前」永远轮不到。返回**下标**，重复条目不会被折叠。
 *
 * 为什么不做向量：本机 12 问实测，本地 nomic-embed-text（英文为主）中文命中@3
 * 仅 2/12，低于本模块的 4/12，且要引入常驻 Ollama 依赖。
 *
 * 索引体积：稀疏（共享词表 + 每条例按 dim 升序的定长数组）。实测全局轨 489 条
 * 约 3 MB 堆；若改成 Map<token, weight> 会是 34.6 MB（2,114 条口径），别换回去。
 *
 * @module dsh-memory-evolve/memory-rank
 */

/** 余弦项权重（词法相关性）。 */
const W_COS = 1.0
/** 关键词覆盖加成：保证「猜对了词」的强度不被词频噪音压掉。 */
const W_COVER = 0.6
/** 单槽索引缓存：插件进程长驻，同一轨反复查询时不必重复建索引。 */
const CACHE_LIMIT = 1
let cache = []

/**
 * 整句兜底的召回上限：整串无命中且切不出词的查询（中文整句）走词法召回时，
 * 最多返回这么多个候选，否则共同词很多的条目会把整轨倒给模型。
 */
const FALLBACK_CAP = 20

/**
 * 按空白切词（去重、小写）。
 * @param {string} filter
 * @returns {string[]}
 */
export function splitTerms(filter) {
  const raw = filter === undefined || filter === null ? '' : String(filter)
  const out = []
  for (const piece of raw.toLowerCase().split(/\s+/)) {
    const t = piece.trim()
    if (t !== '' && !out.includes(t)) out.push(t)
  }
  return out
}

/**
 * 只做「候选选择」这一步（不含打分排序），供测试与需要旧语义的调用方使用。
 * @param {string[]} entries - 匹配用文本。
 * @param {string} filter
 * @returns {{indices: number[], mode: 'none'|'substring'|'or'|'lexical'}}
 */
export function selectIndices(entries, filter) {
  const raw = filter === undefined || filter === null ? '' : String(filter)
  if (raw.trim() === '') return { indices: entries.map((_, i) => i), mode: 'none' }
  const q = raw.toLowerCase()
  const strict = []
  for (let i = 0; i < entries.length; i++) if (entries[i].toLowerCase().includes(q)) strict.push(i)
  if (strict.length > 0) return { indices: strict, mode: 'substring' }
  const terms = splitTerms(raw)
  if (terms.length <= 1) return { indices: [], mode: 'lexical' }
  const hit = []
  for (let i = 0; i < entries.length; i++) {
    const l = entries[i].toLowerCase()
    for (const t of terms) {
      if (l.includes(t)) {
        hit.push(i)
        break
      }
    }
  }
  return { indices: hit, mode: 'or' }
}

/**
 * 切词：ASCII/数字按词，中文按字符二元组（零依赖、对未分词中文稳健）。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const lower = String(text ?? '').toLowerCase()
  const out = []
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) out.push(m[0])
  const han = lower.match(/[\u4e00-\u9fff]/g)
  if (han) for (let i = 0; i + 1 < han.length; i++) out.push(han[i] + han[i + 1])
  return out
}

/**
 * 剥掉条目头部的方括号 token 序列（日期/[id]/[branch]/[dsh-only]/[summary]/[git]）。
 * 只剥**头部**连续方括号，正文里的方括号不受影响。
 * @param {string} text
 * @returns {string}
 */
function stripHeadTokens(text) {
  return String(text ?? '').replace(/^(?:\[[^\]]*\]\s*)+/, '')
}

/** 稀疏倒排：vocab(token→dim) + 每条例按 dim 升序的 dims/weights。 */
function buildIndex(entries) {
  const vocab = new Map()
  const tfs = new Array(entries.length)
  for (let i = 0; i < entries.length; i++) {
    const tf = new Map()
    for (const token of tokenize(stripHeadTokens(entries[i]))) {
      let dim = vocab.get(token)
      if (dim === undefined) {
        dim = vocab.size
        vocab.set(token, dim)
      }
      tf.set(dim, (tf.get(dim) || 0) + 1)
    }
    tfs[i] = tf
  }
  const n = entries.length
  const df = new Float64Array(vocab.size)
  for (const tf of tfs) for (const dim of tf.keys()) df[dim] += 1
  const idf = new Float32Array(vocab.size)
  for (let i = 0; i < idf.length; i++) idf[i] = Math.log((n + 1) / (df[i] + 1)) + 1
  const docs = new Array(n)
  for (let i = 0; i < n; i++) {
    const tf = tfs[i]
    const order = Array.from(tf.keys()).sort((a, b) => a - b)
    const dims = new Int32Array(order.length)
    const weights = new Float32Array(order.length)
    let norm = 0
    order.forEach((dim, k) => {
      dims[k] = dim
      const w = (1 + Math.log(tf.get(dim))) * idf[dim]
      weights[k] = w
      norm += w * w
    })
    docs[i] = { dims, weights, norm: Math.sqrt(norm) }
  }
  return { vocab, idf, docs }
}

function indexKey(entries) {
  let chars = 0
  for (const e of entries) chars += e.length
  const head = entries.length > 0 ? String(entries[0]).slice(0, 48) : ''
  const tail = entries.length > 0 ? String(entries[entries.length - 1]).slice(0, 48) : ''
  return entries.length + '|' + chars + '|' + head + '|' + tail
}

/** 取（或建）这批条目的稀疏索引；单槽缓存，键含条数/总字符/首尾片段。 */
function indexFor(entries) {
  const key = indexKey(entries)
  for (const item of cache) if (item.key === key) return item.index
  const index = buildIndex(entries)
  cache.unshift({ key, index })
  if (cache.length > CACHE_LIMIT) cache.length = CACHE_LIMIT
  return index
}

/** 稀疏点积（两边 dims 都升序）。 */
function cosine(doc, qdims, qweights, qnorm) {
  let dot = 0
  let i = 0
  let j = 0
  while (i < qdims.length && j < doc.dims.length) {
    const a = qdims[i]
    const b = doc.dims[j]
    if (a === b) {
      dot += qweights[i] * doc.weights[j]
      i++
      j++
    } else if (a < b) {
      i++
    } else {
      j++
    }
  }
  return doc.norm > 0 && qnorm > 0 ? dot / (doc.norm * qnorm) : 0
}

function queryVector(index, filter) {
  const tf = new Map()
  for (const token of tokenize(String(filter ?? ''))) {
    const dim = index.vocab.get(token)
    if (dim === undefined) continue // 未登录词只走覆盖加成，不参与余弦
    tf.set(dim, (tf.get(dim) || 0) + 1)
  }
  const order = Array.from(tf.keys()).sort((a, b) => a - b)
  const dims = new Int32Array(order.length)
  const weights = new Float32Array(order.length)
  let norm = 0
  order.forEach((dim, k) => {
    dims[k] = dim
    const w = (1 + Math.log(tf.get(dim))) * index.idf[dim]
    weights[k] = w
    norm += w * w
  })
  return { dims, weights, norm: Math.sqrt(norm) }
}

/** 条目头部的日期戳（YYYY-MM-DD），用于同分裁决；没有则空串。 */
function entryDate(entry) {
  const m = /\[(\d{4}-\d{2}-\d{2})\]/.exec(String(entry ?? ''))
  return m === null ? '' : m[1]
}

/**
 * 唯一入口：选候选（+ 排序）。
 *
 * 语义（按优先级）：
 *   1. 整串子串命中 → **旧语义**（原顺序）；rank=true 时对命中集做相关性排序。
 *   2. 整串无命中且能按空白切出多个词 → 多词 OR（关键字查询），rank=true 时排序。
 *   3. 整串无命中且切不出词 → **词法相关性召回**（中文整句提问的兜底）：给全轨
 *      打分取正分前 FALLBACK_CAP 条，mode='lexical'（此时顺序必然是相关性顺序）。
 *
 * @param {string[]} entries - 该轨全部条目（匹配用文本）
 * @param {string} filter
 * @param {{rank?: boolean, cap?: number}} [opts]
 * @returns {{indices: number[], mode: 'none'|'substring'|'or'|'lexical'|'rank', scores: number[], matched: number}}
 */
export function searchIndices(entries, filter, opts = {}) {
  const rank = opts.rank === true
  const cap = Number.isInteger(opts.cap) && opts.cap > 0 ? opts.cap : FALLBACK_CAP
  const selected = selectIndices(entries, filter)
  if (selected.mode === 'none') {
    return { indices: selected.indices, mode: 'none', scores: [], matched: selected.indices.length }
  }
  const lexical = selected.mode === 'lexical'
  const candidates = lexical ? entries.map((_, i) => i) : selected.indices
  if (!rank && !lexical) {
    // 旧语义命中集（子串 / 多词 OR）：不排序，交给调用方的 recent/limit 顺序
    return { indices: candidates, mode: selected.mode, scores: [], matched: candidates.length }
  }
  const index = indexFor(entries)
  const qv = queryVector(index, filter)
  const terms = splitTerms(filter)
  const scored = candidates.map((i) => {
    const lower = stripHeadTokens(entries[i]).toLowerCase()
    let covered = 0
    for (const t of terms) if (lower.includes(t)) covered += 1
    const coverage = terms.length > 0 ? covered / terms.length : 0
    return {
      index: i,
      score: W_COS * cosine(index.docs[i], qv.dims, qv.weights, qv.norm) + W_COVER * coverage,
      date: entryDate(entries[i]),
    }
  })
  const positive = scored.filter((s) => s.score > 0)
  positive.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.date !== b.date) return a.date < b.date ? 1 : -1 // 同分：新的在前
    return a.index - b.index // 兜底：保持原顺序，保证确定性
  })
  const kept = lexical && positive.length > cap ? positive.slice(0, cap) : positive
  return {
    indices: kept.map((s) => s.index),
    mode: lexical ? 'lexical' : 'rank',
    scores: kept.map((s) => s.score),
    matched: positive.length,
  }
}

/**
 * 相关性排序（等价 searchIndices(rank=true)，保留函数名给测试/调用方）。
 * @param {string[]} entries
 * @param {string} filter
 * @returns {{indices: number[], mode: string, scores: number[]}}
 */
export function rankIndices(entries, filter) {
  return searchIndices(entries, filter, { rank: true })
}

/** 字符串级包装（测试/其他调用方用）。 */
export function selectEntries(entries, filter) {
  const r = selectIndices(entries, filter)
  return { entries: r.indices.map((i) => entries[i]), mode: r.mode }
}

/** 测试用：清空索引缓存。 */
export function clearRankCache() {
  cache = []
}
