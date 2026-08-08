/**
 * Codex 会话源 — 文件发现与 JSONL 解析。
 *
 * Codex 会话记录位置（默认）：
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl   （普通）
 *   ~/.codex/archived_sessions/（子目录）rollout-*.jsonl            （归档）
 *
 * 文件格式：每行一个 JSON 对象（JSONL）。本模块只关心两类事件：
 *   { type: 'session_meta', payload: { cwd } }          —— 会话工作目录
 *   { type: 'event_msg', payload: { type: 'user_message' | 'agent_message',
 *     message: '...' }, timestamp }                     —— 对话消息
 *
 * 解析纪律（吸取 dsh-session-search 被指出的缺陷）：
 *   - 坏行宽容：单行解析失败只跳过该行，绝不淘汰整个会话文件
 *     （原插件"一行损坏 = 整个会话作废"是明确 bug）；
 *   - 防御式上限：单文件 >64MB 跳过、单行 >512KB 跳过、消息文本
 *     >4000 字符截断后再入检索（MAX_MSG_CHARS）；
 *   - 全部只读：不修改任何会话文件，不建索引/缓存。
 */

import { readdir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import {
  MAX_FILE_BYTES, MAX_LINE_CHARS, MAX_MSG_CHARS, SEARCH_ROLES,
} from './core.js'

/** 递归遍历的最大深度（sessions/YYYY/MM/DD 为 4 层，预留余量）。 */
const WALK_MAX_DEPTH = 6

/**
 * Codex 默认会话根（~/.codex）。允许部署侧覆盖（roots.codex）。
 * @returns {string}
 */
export function defaultCodexRoot() {
  return join(homedir(), '.codex')
}

/**
 * 递归列出目录下的普通文件（有界深度，目录不可读时静默跳过）。
 * @param {string} root - 起始目录。
 * @param {number} maxDepth - 最大递归深度。
 * @param {number} depth - 当前深度（内部使用）。
 * @returns {Promise<string[]>} 文件绝对路径列表。
 */
async function walkFiles(root, maxDepth = WALK_MAX_DEPTH, depth = 0) {
  if (depth > maxDepth) return []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return [] // 目录不存在/不可读：没有文件，不报错
  }
  const files = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walkFiles(path, maxDepth, depth + 1))
    } else if (entry.isFile()) {
      files.push(path)
    }
  }
  return files
}

/**
 * 发现 Codex 会话文件（sessions/ + archived_sessions/，递归、有界深度）。
 * @param {string} root - ~/.codex 根目录（可被 roots.codex 覆盖）。
 * @returns {Promise<Array<{ path: string, sessionId: string }>>}
 */
export async function discoverCodexFiles(root = defaultCodexRoot()) {
  const files = []
  for (const dir of ['sessions', 'archived_sessions']) {
    for (const path of await walkFiles(join(root, dir))) {
      if (path.endsWith('.jsonl')) {
        files.push({ path, sessionId: basename(path).replace(/\.jsonl$/, '') })
      }
    }
  }
  return files
}

/**
 * 时间戳归一化：支持毫秒数字与 ISO 字符串；无法解析返回 0。
 * @param {unknown} value
 * @returns {number}
 */
function tsOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const t = Date.parse(value)
    return Number.isNaN(t) ? 0 : t
  }
  return 0
}

/**
 * 防御式 JSON 行解析：坏行/超长行返回 null（调用方跳过，不影响整文件）。
 * @param {string} line
 * @returns {Record<string, unknown> | null}
 */
function asRecord(line) {
  if (line.length > MAX_LINE_CHARS) return null
  let data
  try {
    data = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  return data
}

/**
 * 从内容块数组中提取纯文本（Codex response_item 的 content 是块数组：
 * 元素形如 { type: 'input_text' | 'output_text', text }，兼容 'text'）。
 * @param {unknown} content - payload.content（数组或字符串）。
 * @returns {string}
 */
function extractBlocksText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block
    if ((b.type === 'input_text' || b.type === 'output_text' || b.type === 'text')
      && typeof b.text === 'string') {
      parts.push(b.text)
    }
  }
  return parts.join('\n')
}

/** 收敛一条消息入列表（role/文本校验 + 首条 user 作标题 + 长度上限）。 */
function pushMessage(messages, state, { role, text, ts, msgId }) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  if (role === 'user' && state.firstUser === '') state.firstUser = trimmed.slice(0, 80)
  const seq = state.seq++
  messages.push({
    source: 'codex',
    sessionId: state.sessionId,
    seq,
    msgId: msgId ?? String(seq), // msgId 与 seq 对齐（0-based），与逻辑无关仅标识
    role,
    content: trimmed.length > MAX_MSG_CHARS ? trimmed.slice(0, MAX_MSG_CHARS) : trimmed,
    ts,
  })
}

/**
 * 逐行流式解析一个 Codex rollout JSONL 文件。
 *
 * 兼容两种 Codex 会话记录格式：
 *   1. 旧格式（codex-cli）：{ type: 'event_msg', payload: { type:
 *      'user_message' | 'agent_message', message: '...' }, timestamp }
 *   2. 新格式（codex-tui 0.147+，本机已出现）：{ type: 'response_item',
 *      payload: { type: 'message', role: 'user' | 'assistant' | 'developer',
 *      content: [{ type: 'input_text', text }] }, timestamp } ——
 *      developer（系统提示注入）跳过，只收录 user/assistant 对话消息。
 *
 * 若不兼容新格式，新 TUI 的历史会话对搜索等于不存在（Grok 审查发现）。
 *
 * @param {string} path
 * @returns {Promise<import('./core.js').CodexParsedSession | undefined>}
 *   文件不可读/超限/无任何记录时返回 undefined；坏行静默跳过。
 */
export async function parseCodexFile(path) {
  // 文件级上限：超大 rollout（异常/被污染）直接跳过，防止单文件拖垮扫描
  let st
  try {
    st = await stat(path)
  } catch {
    return undefined
  }
  if (st.size > MAX_FILE_BYTES) return undefined

  const messages = []
  const sessionId = basename(path).replace(/\.jsonl$/, '')
  const state = { sessionId, seq: 0, firstUser: '' }
  let cwd = ''
  let createdAt = 0
  let updatedAt = 0
  let records = 0

  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  try {
    for await (const raw of rl) {
      const d = asRecord(raw)
      if (d === null) continue // 坏行宽容：跳过，不淘汰整个会话
      records += 1
      const ts = tsOf(d.timestamp)
      if (ts > updatedAt) updatedAt = ts
      if (createdAt === 0 || (ts !== 0 && ts < createdAt)) createdAt = ts

      if (d.type === 'session_meta') {
        const payload = (d.payload ?? {})
        if (typeof payload.cwd === 'string') cwd = payload.cwd
      } else if (d.type === 'response_item') {
        // 新格式（codex-tui 0.147+）：消息事件（跳过 developer 系统注入）
        const payload = (d.payload ?? {})
        if (payload.type !== 'message') continue
        const role = payload.role === 'user' ? 'user'
          : payload.role === 'assistant' ? 'assistant' : undefined
        if (role === undefined) continue
        pushMessage(messages, state, {
          role,
          text: extractBlocksText(payload.content),
          ts,
          msgId: typeof payload.id === 'string' ? payload.id : undefined,
        })
      } else if (d.type === 'event_msg') {
        // 旧格式（codex-cli）：对话消息事件
        const payload = (d.payload ?? {})
        const ptype = payload.type
        if (ptype !== 'user_message' && ptype !== 'agent_message') continue
        const text = typeof payload.message === 'string' ? payload.message : ''
        pushMessage(messages, state, {
          role: ptype === 'user_message' ? 'user' : 'assistant',
          text,
          ts,
        })
      }
    }
  } catch {
    return undefined // 读取中断/IO 错误：跳过该文件
  } finally {
    rl.close()
  }

  if (records === 0) return undefined
  return {
    session: {
      source: 'codex',
      sessionId,
      path,
      title: state.firstUser || 'Codex session',
      cwd: cwd || 'unknown',
      createdAt,
      updatedAt,
      messageCount: messages.length,
    },
    messages,
  }
}


