/**
 * dsh-memory-evolve — memory storage layer.
 *
 * Hermes-compatible persistent curated memory: plain-text files with `\n§\n`
 * entry delimiters, per-target character limits, a cross-process lock file,
 * atomic writes, and a drift guard that refuses full-file rewrites when the
 * on-disk content would not round-trip through the parser (manual edits,
 * shell appends, or sister-process writes).
 *
 * Write semantics mirror the Hermes memory tool:
 *   - add: append-only, skips the drift guard (never clobbers parsed entries),
 *     but refuses a file that exists and reads as empty (would wipe history);
 *   - replace / remove: match by a short unique substring, enforce the drift
 *     guard (full-file rewrite would discard un-roundtrippable content), back
 *     up drifted files to `<file>.bak.<timestamp>` before refusing.
 *
 * All operations are synchronous (files are tiny) and serialized through one
 * lock file per directory so multiple DSH processes or external editors
 * cannot interleave writes.
 *
 * Zero runtime dependencies (node:fs only).
 *
 * @module dsh-memory-evolve/store
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Entry delimiter, byte-compatible with Hermes MEMORY.md / USER.md. */
export const ENTRY_DELIMITER = '\n§\n'

/** A lock file older than this is considered abandoned (stale). */
const STALE_LOCK_MS = 10_000
/** How long to keep waiting for the lock before failing loud. */
const LOCK_TIMEOUT_MS = 5_000
/** Spin interval while waiting for the lock. */
const LOCK_RETRY_MS = 25

/**
 * Split raw file text into trimmed, non-empty entries.
 * @param {string} text - raw file content.
 * @returns {string[]} the entries.
 */
export function parseEntries(text) {
  return text
    .split(ENTRY_DELIMITER)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Serialize entries into canonical file text (entries joined by the
 * delimiter plus a trailing newline).
 * @param {string[]} entries - the entries.
 * @returns {string} canonical file content.
 */
/** Extract the `YYYY-MM-DD` date from an entry's stamp prefix; null when absent. */
export function extractEntryDate(entry) {
  // project 条目形如 [YYYY-MM-DD HH:MM]，日期后还有时间——只捕获日期段
  const match = /^\[(\d{4}-\d{2}-\d{2})/.exec(entry)
  return match ? match[1] : null
}

/**
 * Branch-scope tag inside a KEY entry: `[2026-08-06] [branch:main,dev] 内容`.
 * Absent = visible in EVERY branch ("全部"). Multiple branches are a
 * comma-separated list; the tag always follows the date stamp.
 */
export const BRANCH_TAG_RE = /(?:^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*)?\[branch:([^\]]*)\]\s*/

/**
 * Parse the branch scope of one KEY entry.
 * @param {string} entry - the full entry text.
 * @returns {string[] | null} the branch names, or null when the entry has no
 *   branch tag (meaning "all branches").
 */
export function parseEntryBranches(entry) {
  const match = BRANCH_TAG_RE.exec(entry)
  if (match === null) return null
  const branches = match[1].split(',').map((b) => b.trim()).filter(Boolean)
  return branches.length > 0 ? branches : null
}

export function serializeEntries(entries) {
  return entries.join(ENTRY_DELIMITER) + '\n'
}

/**
 * 剥离一条目的全部前缀标记：时间戳 + `[git …]` 程序分支标记 + `[branch:…]`
 * 分支范围 + daily 项目 tag，返回前缀 head 与正文 body。与记忆 Tab 美观视图
 * 的解析规则保持一致——编辑条目时用 head + 新正文重写，时间戳与所有 tag
 * 原样保留（程序维护的元数据不可被编辑改动）。
 * @param {string} entry - 完整条目原文。
 * @param {string} target - 'memory' | 'user' | 'daily' | 'project' | 'key'。
 * @returns {{head: string, body: string}}
 */
export function splitEntryHead(entry, target) {
  let rest = String(entry ?? '').trim()
  const timeRe = target === 'project' ? /^\[(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(?::\d{2})?)\]\s*/
    : target === 'daily' ? /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/
      : /^\[(\d{4}-\d{2}-\d{2})\]\s*/
  const tokens = []
  const timeMatch = timeRe.exec(rest)
  if (timeMatch !== null) {
    tokens.push(timeMatch[0])
    rest = rest.slice(timeMatch[0].length)
  }
  // 程序分支标记 [git …]（daily / project 按会话 cwd 盖戳）
  for (;;) {
    const gitMatch = /^\[git ([^\]]+)\]\s*/.exec(rest)
    if (gitMatch === null) break
    tokens.push(gitMatch[0])
    rest = rest.slice(gitMatch[0].length)
  }
  // key 分支范围 [branch:…]
  const branchMatch = /^\[branch:[^\]]*\]\s*/.exec(rest)
  if (branchMatch !== null) {
    tokens.push(branchMatch[0])
    rest = rest.slice(branchMatch[0].length)
  }
  // daily 项目 tag（时间戳后的第一个任意 [...]）
  if (target === 'daily') {
    const tagMatch = /^\[([^\]]+)\]\s*/.exec(rest)
    if (tagMatch !== null) {
      tokens.push(tagMatch[0])
      rest = rest.slice(tagMatch[0].length)
    }
  }
  return { head: tokens.join(''), body: rest }
}

/**
 * Whether raw text is the canonical serialization of its own entries.
 * Blank text counts as canonical (an empty store).
 * @param {string} text - raw file content.
 * @returns {boolean} true when the file would round-trip through the parser.
 */
export function isCanonical(text) {
  return text.trim() === '' || serializeEntries(parseEntries(text)) === text
}

/** Blocking sleep used by the lock retry loop (synchronous). */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Directories whose lock this process currently holds (reentrancy guard). */
const heldLocks = new Set()

/**
 * Acquire the directory lock exclusively (cross-process), run `fn`, release.
 * Reentrant within this process: a nested withLock on the same directory
 * proceeds directly (all mutations are synchronous, so the outer section is
 * still exclusive against other processes).
 * @param {string} dir - the directory whose lock to take.
 * @param {() => T} fn - the critical section.
 * @returns {T} the section's return value.
 * @template T
 */
export function withLock(dir, fn) {
  if (heldLocks.has(dir)) return fn()
  const lockPath = join(dir, '.memory.lock')
  mkdirSync(dir, { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    let acquired = false
    try {
      closeSync(openSync(lockPath, 'wx'))
      acquired = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    if (acquired) break
    try {
      const info = statSync(lockPath)
      if (Date.now() - info.mtimeMs > STALE_LOCK_MS) rmSync(lockPath, { force: true })
    } catch {
      // lock vanished between attempts — retry
    }
    if (Date.now() >= deadline) {
      throw new Error('dsh-memory-evolve: timed out waiting for the memory lock')
    }
    sleep(LOCK_RETRY_MS)
  }
  heldLocks.add(dir)
  try {
    return fn()
  } finally {
    heldLocks.delete(dir)
    rmSync(lockPath, { force: true })
  }
}

/** Minimal prompt-injection scan applied to tool-written memory content. */
const THREAT_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|earlier|above|your)\s+(instructions?|prompts?|messages?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|earlier|above|your)\s+(instructions?|prompts?|messages?|rules?)/i,
  /forget\s+(all|everything|your\s+instructions)/i,
  /忽略(所有|之前|以上|先前)(的)?(指令|指示|提示|规则)/,
  /无视(所有|之前|以上|先前)(的)?(指令|指示|提示|规则)/,
]

/**
 * Scan one memory entry for prompt-injection phrasing.
 * @param {string} text - the content to scan.
 * @returns {string | undefined} a human-readable block reason, or undefined.
 */
export function scanThreat(text) {
  for (const pattern of THREAT_PATTERNS) {
    if (pattern.test(text)) {
      return '内容包含疑似提示注入的表述（如"忽略指令"），已拒绝写入。若确为有意内容，请直接编辑记忆文件。'
    }
  }
  return undefined
}

/** Today's date as `YYYY-MM-DD` (local time). */
export function todayStamp() {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** Stable 12-hex project key for one working directory. */
export function projectHash(cwd) {
  return createHash('sha1').update(cwd).digest('hex').slice(0, 12)
}

/**
 * A short, stable project label for one working directory: the basename, or
 * the last two path segments when the basename is too short or purely
 * numeric (e.g. `/data/260805/1` → `260805/1`). Tags daily-log entries with
 * their originating project — the program knows the session cwd, so the LLM
 * never has to write it.
 * @param {string | undefined} cwd - the session working directory.
 * @returns {string | undefined} the label, or undefined without a cwd.
 */
export function projectLabel(cwd) {
  if (!cwd) return undefined
  const parts = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length === 0) return '/'
  const base = parts[parts.length - 1]
  if (base.length < 3 || /^\d+$/.test(base)) {
    return parts.length > 1 ? parts.slice(-2).join('/') : base
  }
  return base
}

/**
 * Resolve the current git branch of a working directory (same pattern as the
 * DSH TUI's prompt-context helper). Outside a git worktree, without `git`,
 * or on a detached HEAD (`--show-current` returns empty) this returns
 * undefined — callers then fall back to the no-branch behavior.
 * @param {string} cwd - the working directory to query.
 * @returns {string | undefined} the branch name, or undefined.
 */
export function gitBranch(cwd) {
  if (!cwd) return undefined
  try {
    const result = spawnSync('git', ['branch', '--show-current'], {
      cwd, encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.error || result.status !== 0) return undefined
    const branch = String(result.stdout ?? '').trim()
    return branch === '' ? undefined : branch
  } catch {
    return undefined
  }
}

/**
 * List all local branch names of a working directory (for the memory tab's
 * branch-scope pickers). Empty on any failure.
 * @param {string} cwd - the working directory to query.
 * @returns {string[]} the branch names ([] = not a git repo / no git).
 */
export function gitBranchList(cwd) {
  if (!cwd) return []
  try {
    const result = spawnSync('git', ['branch', '--format=%(refname:short)'], {
      cwd, encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.error || result.status !== 0) return []
    return String(result.stdout ?? '')
      .split('\n')
      .map((b) => b.trim())
      .filter((b) => b.length > 0)
  } catch {
    return []
  }
}

/**
 * Persistent curated memory store over the five tracks: global facts
 * (MEMORY.md / USER.md), the daily log (daily/YYYY-MM-DD.md), the per-project
 * log (projects/<hash>/MEMORY.md, keyed by the session cwd) and per-project
 * KEY facts (projects/<hash>/KEY.md — the project's long-term memory, which
 * IS injected into the context like the global tracks).
 */
export class MemoryStore {
  /**
   * @param {string} dir - the memory directory (created on demand).
   * @param {object} [options] - scan and stamping switches.
   * @param {boolean} [options.injectionScan=true] - enable the threat scan.
   * @param {boolean} [options.entryDatePrefix=true] - stamp entries with a
   *   `[YYYY-MM-DD] ` prefix on add, refreshed on replace (idempotent for
   *   content that already carries a date stamp).
   */
  constructor(dir, options = {}) {
    this.dir = dir
    this.injectionScan = options.injectionScan ?? true
    this.entryDatePrefix = options.entryDatePrefix ?? true
  }

  /**
   * Resolve one target to its file location.
   * @param {string} target - 'memory' | 'user' | 'daily' | 'project' | 'key'.
   * @param {object | undefined} agent - the calling agent; required for
   *   'project' and 'key' (its session cwd selects the project directory).
   * @returns {{dir: string, file: string} | undefined}
   *   the location, or undefined when it cannot be resolved (e.g. project
   *   memory without a session cwd).
   */
  locate(target, agent) {
    switch (target) {
      case 'memory':
        return { dir: this.dir, file: 'MEMORY.md' }
      case 'user':
        return { dir: this.dir, file: 'USER.md' }
      case 'daily':
        return { dir: join(this.dir, 'daily'), file: `${todayStamp()}.md` }
      case 'project':
      case 'key': {
        const cwd = agent?.session?.header?.cwd
        if (!cwd) return undefined
        return {
          dir: join(this.dir, 'projects', projectHash(cwd)),
          file: target === 'key' ? 'KEY.md' : 'MEMORY.md',
        }
      }
      default:
        throw new Error(`dsh-memory-evolve: 无效的记忆轨 "${target}"`)
    }
  }

  /** Resolve a target or fail loud with a locatable message. */
  resolveTarget(target, agent) {
    const loc = this.locate(target, agent)
    if (!loc) {
      throw new Error(`dsh-memory-evolve: 无法定位记忆轨 "${target}"（项目记忆需要有效的会话工作目录）`)
    }
    return loc
  }

  /**
   * Stamp one entry with a time prefix: date stamp for the long-term tracks
   * (global memory/user AND the per-project KEY track — a `[YYYY-MM-DD]`
   * prefix, same shape as the injected global tracks), date+time for the
   * per-project log (project entries need hour granularity to reconstruct
   * when something happened), time-of-day for the daily log (its file name
   * already carries the date). Idempotent for content that already carries
   * the matching prefix; a bare `[YYYY-MM-DD]` project entry is upgraded to
   * the dated-time form on replace.
   *
   * For daily/project/key, a hand-written date-like prefix (`[2026-08-05]`,
   * `[2026-08-05 深夜]`) is STRIPPED first: writers (review subagents) do
   * not know the current date and guess — dates belong to the file name
   * (daily) or the program stamp (project/key), so the canonical stamp wins.
   *
   * Daily entries additionally carry a program-tagged project label
   * (`[HH:MM] [git branch] [label] …`) derived from the calling agent's
   * cwd, so the log shows which project each entry belongs to without the
   * LLM writing it. Daily AND project entries carry a program-tagged git
   * branch (`[git main]`, right after the time stamp) whenever the session
   * cwd is a git worktree — logs stay branch-reliable without any LLM
   * cooperation.
   * @param {string} target - the memory track.
   * @param {string} content - trimmed entry text.
   * @param {object | undefined} agent - the calling agent (its cwd selects
   *   the project label for the daily track).
   * @returns {string} the stamped entry.
   */
  stampEntry(target, content, agent) {
    if (target === 'daily' || target === 'project' || target === 'key') {
      content = content.replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, '')
      // 分支 tag 是程序专属标注：剥离模型手写的 [git 分支] 前缀，防止与
      // 程序盖的 tag 重复（模型不知道分支名，也不该写）
      content = content.replace(/^\[git [^\]]+\]\s*/, '')
    }
    if (target === 'daily') {
      if (!this.entryDatePrefix || /^\[\d{2}:\d{2}\]\s/.test(content)) return content
      const d = new Date()
      const hh = String(d.getHours()).padStart(2, '0')
      const mm = String(d.getMinutes()).padStart(2, '0')
      const label = projectLabel(agent?.session?.header?.cwd)
      const branch = gitBranch(agent?.session?.header?.cwd)
      const branchTag = branch !== undefined ? `[git ${branch}] ` : ''
      return `[${hh}:${mm}] ${branchTag}${label ? `[${label}] ` : ''}${content}`
    }
    if (target === 'project') {
      if (!this.entryDatePrefix || /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s/.test(content)) return content
      const d = new Date()
      const hh = String(d.getHours()).padStart(2, '0')
      const mm = String(d.getMinutes()).padStart(2, '0')
      const branch = gitBranch(agent?.session?.header?.cwd)
      const branchTag = branch !== undefined ? `[git ${branch}] ` : ''
      return `[${todayStamp()} ${hh}:${mm}] ${branchTag}${content}`
    }
    if (!this.entryDatePrefix) return content
    if (/^\[\d{4}-\d{2}-\d{2}\]\s/.test(content)) return content
    return `[${todayStamp()}] ${content}`
  }

  /** Absolute path of one target's file (throws when not locatable). */
  pathOf(target, agent) {
    const loc = this.resolveTarget(target, agent)
    return join(loc.dir, loc.file)
  }


  /** Current character usage of one target (delimiter-joined length). */
  charsOf(target, agent) {
    return this.entriesOf(target, agent).join(ENTRY_DELIMITER).length
  }

  /** Read one target's entries without locking (snapshot reads). */
  entriesOf(target, agent) {
    return parseEntries(this.readRaw(target, agent).text)
  }

  /**
   * Query entries with LLM-friendly lookups: keyword `filter`
   * (case-insensitive substring), date range `since`/`until`
   * (`YYYY-MM-DD`; the daily track spans multiple files, so a range reads
   * every day's log in between), `recent` newest-first ordering and a
   * `limit` cap. Entries without a date stamp survive date filters.
   * @param {string} target - the memory track.
   * @param {object | undefined} agent - the calling agent (required for
   *   'project').
   * @param {{filter?: string, since?: string, until?: string, limit?: number, recent?: boolean}} [opts]
   * @returns {string[]} the matching entries (raw text with stamps).
   */
  query(target, agent, opts = {}, stats = {}) {
    const { filter, since, until, limit, recent } = opts
    let rows = []
    if (target === 'daily' && (since !== undefined || until !== undefined)) {
      // 跨日期查询：枚举 daily/ 目录中范围内的文件（按日期升序收集）
      const dir = join(this.dir, 'daily')
      let days = []
      try {
        days = readdirSync(dir)
          .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
          .map((name) => name.slice(0, 10))
          .sort()
      } catch {
        days = [] // daily 目录尚不存在
      }
      for (const day of days) {
        if ((since !== undefined && day < since) || (until !== undefined && day > until)) continue
        let text
        try {
          text = readFileSync(join(dir, `${day}.md`), 'utf8')
        } catch {
          continue
        }
        for (const entry of parseEntries(text)) rows.push({ date: day, text: entry })
      }
    } else {
      // 单文件轨：日期从条目时间戳提取（daily 单文件 = 今天的文件）
      const fileDate = target === 'daily' ? todayStamp() : null
      for (const entry of this.entriesOf(target, agent)) {
        rows.push({ date: fileDate ?? extractEntryDate(entry), text: entry })
      }
    }
    if (filter !== undefined && String(filter) !== '') {
      const q = String(filter).toLowerCase()
      rows = rows.filter((row) => row.text.toLowerCase().includes(q))
    }
    if (since !== undefined || until !== undefined) {
      rows = rows.filter((row) => {
        if (row.date === null) return true // 无日期条目不参与日期过滤
        if (since !== undefined && row.date < since) return false
        if (until !== undefined && row.date > until) return false
        return true
      })
    }
    // 统计日期无法解析的条目（旧格式/手写前缀）——调用方可据此提醒模型读全文
    stats.undated = rows.filter((row) => row.date === null).length
    stats.total = rows.length
    if (recent) rows.reverse() // 升序收集后整体反转 = 日期倒序 + 组内倒序
    if (limit !== undefined && Number.isFinite(Number(limit)) && Number(limit) > 0) {
      rows = rows.slice(0, Math.floor(Number(limit)))
    }
    return rows.map((row) => row.text)
  }

  /** Read the raw file; a missing file reads as an empty store. */
  readRaw(target, agent) {
    const path = this.pathOf(target, agent)
    try {
      return { text: readFileSync(path, 'utf8'), size: statSync(path).size }
    } catch (error) {
      if (error.code === 'ENOENT') return { text: '', size: 0 }
      throw error
    }
  }

  /**
   * Reload one target under the caller's lock.
   * @returns {{kind:'ok', entries: string[]} | {kind:'read-failed'} | {kind:'drift', backup: string}}
   */
  reload(target, agent) {
    const { text, size } = this.readRaw(target, agent)
    // Only a truly unreadable file is refused (non-empty size yet zero bytes
    // read back — e.g. a broken encoding). A whitespace-only file is a normal
    // empty store: rewriting it cannot wipe history.
    if (text === '' && size > 0) return { kind: 'read-failed' }
    if (!isCanonical(text)) {
      const backup = `${this.pathOf(target, agent)}.bak.${Date.now()}`
      writeFileSync(backup, text)
      return { kind: 'drift', backup }
    }
    return { kind: 'ok', entries: parseEntries(text) }
  }

  /** Atomically write entries to one target's file. */
  write(target, entries, agent) {
    const path = this.pathOf(target, agent)
    const tmp = `${path}.tmp.${process.pid}`
    writeFileSync(tmp, serializeEntries(entries))
    renameSync(tmp, path)
  }

  /**
   * Reload one target under the caller's lock, skipping the drift guard.
   * Append-only mutations never clobber parsed entries, so an un-roundtrippable
   * file is tolerated (Hermes semantics); an unreadable file is not
   * (rewriting it would wipe history). A whitespace-only file is a normal
   * empty store — only a file that exists with a size yet reads back as the
   * empty string is treated as unreadable.
   * @returns {{kind:'ok', entries: string[]} | {kind:'read-failed'}}
   */
  reloadForAppend(target, agent) {
    const { text, size } = this.readRaw(target, agent)
    if (text === '' && size > 0) return { kind: 'read-failed' }
    return { kind: 'ok', entries: parseEntries(text) }
  }

  /**
   * Append one entry. Skips the drift guard (append-only), rejects empty
   * content, exact duplicates, over-limit additions, and unreadable files.
   * @param {string} target - 'memory' or 'user'.
   * @param {string} content - the entry text.
   * @returns {object} a tool-friendly result object.
   */
  add(target, content, agent) {
    const loc = this.resolveTarget(target, agent)
    const text = String(content).trim()
    if (!text) return { ok: false, message: '内容不能为空', target }
    if (this.injectionScan) {
      const threat = scanThreat(text)
      if (threat) return { ok: false, message: threat, target }
    }
    const stamped = this.stampEntry(target, text, agent)
    return withLock(loc.dir, () => {
      const reload = this.reloadForAppend(target, agent)
      if (reload.kind === 'read-failed') {
        return { ok: false, message: '记忆文件存在但无法读取，拒绝写入（防止清空已有记忆）', target }
      }
      const entries = reload.entries
      if (entries.includes(stamped)) {
        return {
          ok: true, message: '条目已存在，未重复添加', target,
          entries: [...entries], chars: this.charsOf(target, agent),
        }
      }
      const next = [...entries, stamped]
      this.write(target, next, agent)
      return {
        ok: true, message: `已添加（${target}：${entries.length} → ${next.length} 条）`, target,
        entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * Replace the whole entry containing the unique substring `match`.
   * Enforces the drift guard (full-file rewrite).
   * @param {string} target - 'memory' or 'user'.
   * @param {string} match - a short substring uniquely identifying one entry.
   * @param {string} content - the replacement entry text.
   * @returns {object} a tool-friendly result object.
   */
  replace(target, match, content, agent) {
    const loc = this.resolveTarget(target, agent)
    const oldText = String(match ?? '').trim()
    const newContent = String(content ?? '').trim()
    if (!oldText) return { ok: false, message: 'match 不能为空', target }
    if (!newContent) return { ok: false, message: 'content 不能为空（删除条目请用 remove）', target }
    if (this.injectionScan) {
      const threat = scanThreat(newContent)
      if (threat) return { ok: false, message: threat, target }
    }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: `拒绝写入：${loc.file} 的内容无法通过记忆工具解析往返（可能被手工编辑或外部进程修改）。已备份到 ${reload.backup}。请先将该文件整理为规范的 § 分隔条目，再重试。`,
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: '记忆文件存在但无法读取，拒绝写入（防止清空已有记忆）', target }
      }
      const entries = reload.entries
      const matches = entries.filter((entry) => entry.includes(oldText))
      if (matches.length === 0) {
        return { ok: false, message: `没有条目包含片段 "${oldText}"`, target, entries: [...entries] }
      }
      if (matches.length > 1) {
        return {
          ok: false,
          message: `片段 "${oldText}" 匹配到 ${matches.length} 个条目，请用更精确的片段`,
          target, matches: [...matches], entries: [...entries],
        }
      }
      const index = entries.indexOf(matches[0])
      const next = [...entries]
      next[index] = this.stampEntry(target, newContent, agent)
      this.write(target, next, agent)
      return {
        ok: true, message: `已替换条目（${target}：${entries.length} 条不变）`, target,
        entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * Remove the entry containing the unique substring `match`.
   * Enforces the drift guard (full-file rewrite).
   * @param {string} target - 'memory' or 'user'.
   * @param {string} match - a short substring uniquely identifying one entry.
   * @returns {object} a tool-friendly result object.
   */
  remove(target, match, agent) {
    const loc = this.resolveTarget(target, agent)
    const oldText = String(match ?? '').trim()
    if (!oldText) return { ok: false, message: 'match 不能为空', target }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: `拒绝写入：${loc.file} 的内容无法通过记忆工具解析往返。已备份到 ${reload.backup}。请先整理文件再重试。`,
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: '记忆文件存在但无法读取，拒绝写入（防止清空已有记忆）', target }
      }
      const entries = reload.entries
      const matches = entries.filter((entry) => entry.includes(oldText))
      if (matches.length === 0) {
        return { ok: false, message: `没有条目包含片段 "${oldText}"`, target, entries: [...entries] }
      }
      if (matches.length > 1) {
        return {
          ok: false,
          message: `片段 "${oldText}" 匹配到 ${matches.length} 个条目，请用更精确的片段`,
          target, matches: [...matches], entries: [...entries],
        }
      }
      const index = entries.indexOf(matches[0])
      const next = [...entries]
      next.splice(index, 1)
      this.write(target, next, agent)
      return {
        ok: true, message: `已删除条目（${target}：${entries.length} → ${next.length} 条）`, target,
        // removed：被删的整条原文（含时间戳）——供归档等"移动"场景直接
        // 追加到归档文件，避免二次匹配
        removed: matches[0],
        entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * Remove the entry that EXACTLY equals `entry` (whole-entry match, not a
   * substring). Used by the memory tab's per-entry delete button: the UI
   * sends the full entry text it rendered, and this deletes precisely that
   * entry — a substring match could hit a longer entry that merely contains
   * the text (e.g. deleting "喜欢简洁" must not remove "喜欢简洁，也喜欢
   * 详细"). Enforces the drift guard; a missing exact entry is reported
   * without touching anything.
   * @param {string} target - the memory track ('memory' | 'user' | 'daily' |
   *   'project' | 'key').
   * @param {string} entry - the FULL entry text (with its stamp) to delete.
   * @returns {object} a tool-friendly result object.
   */
  removeExact(target, entry, agent) {
    const loc = this.resolveTarget(target, agent)
    const exact = String(entry ?? '').trim()
    if (!exact) return { ok: false, message: '条目不能为空', target }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: `拒绝写入：${loc.file} 的内容无法通过记忆工具解析往返。已备份到 ${reload.backup}。请先整理文件再重试。`,
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: '记忆文件存在但无法读取，拒绝写入（防止清空已有记忆）', target }
      }
      const entries = reload.entries
      const index = entries.indexOf(exact)
      if (index === -1) {
        return {
          ok: false,
          message: '条目不存在（可能已被删除，或文件被外部修改）——请刷新列表后重试',
          target, entries: [...entries],
        }
      }
      const next = [...entries]
      next.splice(index, 1)
      this.write(target, next, agent)
      return {
        ok: true, message: `已删除条目（${target}：${entries.length} → ${next.length} 条）`, target,
        entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * Set the branch scope of one KEY entry (whole-entry exact match). An
   * empty `branches` array means "all branches" — the tag is REMOVED
   * ("全部" has the highest weight: it wins over any branch selection).
   * The date stamp is preserved; the tag is (re)inserted right after it.
   * @param {string} target - 'key' (other tracks are rejected).
   * @param {string} entry - the FULL entry text to update.
   * @param {string[]} branches - the branch names ([] = all branches).
   * @returns {object} a tool-friendly result object.
   */
  setEntryBranches(target, entry, branches, agent) {
    const loc = this.resolveTarget(target, agent)
    const exact = String(entry ?? '').trim()
    if (!exact) return { ok: false, message: '条目不能为空', target }
    if (target !== 'key') return { ok: false, message: '分支范围仅适用于 key 轨', target }
    const list = (Array.isArray(branches) ? branches : [])
      .map((b) => String(b).trim())
      .filter((b) => b.length > 0)
    const tag = list.length > 0 ? `[branch:${list.join(',')}] ` : ''
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: `拒绝写入：${loc.file} 的内容无法通过记忆工具解析往返。已备份到 ${reload.backup}。请先整理文件再重试。`,
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: '记忆文件存在但无法读取，拒绝写入（防止清空已有记忆）', target }
      }
      const entries = reload.entries
      const index = entries.indexOf(exact)
      if (index === -1) {
        return {
          ok: false,
          message: '条目不存在（可能已被删除，或文件被外部修改）——请刷新列表后重试',
          target, entries: [...entries],
        }
      }
      // 剥离旧分支标记，得到 [YYYY-MM-DD] 前缀 + 正文；再插入新标记
      const bare = exact.replace(/\[branch:[^\]]*\]\s*/, '')
      const headMatch = /^(\[[^\]]+\])\s*/.exec(bare)
      const head = headMatch ? `${headMatch[1]} ` : ''
      const rest = headMatch ? bare.slice(headMatch[0].length) : bare
      const next = [...entries]
      next[index] = `${head}${tag}${rest}`
      this.write(target, next, agent)
      return {
        ok: true, message: list.length > 0 ? `已设置分支范围（${list.join('、')}）` : '已设为全部分支可见',
        target, entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * 只更新一条目的正文（整条精确匹配）——记忆 Tab 美观视图的「编辑」入口。
   * 时间戳与全部 tag（[git …] / [branch:…] / daily 项目标签）原样保留：
   * 程序维护的元数据不可被编辑改动。内容禁止包含条目分隔符 §（防破坏
   * § 分割格式）。Enforces the drift guard (full-file rewrite).
   * @param {string} target - 'memory' | 'user' | 'daily' | 'project' | 'key'。
   * @param {string} entry - 完整条目原文（与删除/归档同一份，UI 渲染时持有）。
   * @param {string} content - 新正文（可多行；空内容请用删除）。
   * @returns {object} a tool-friendly result object.
   */
  updateEntryContent(target, entry, content, agent) {
    const loc = this.resolveTarget(target, agent)
    const exact = String(entry ?? '').trim()
    const newContent = String(content ?? '').trim()
    if (!exact) return { ok: false, message: '条目不能为空', target }
    if (!newContent) return { ok: false, message: '内容不能为空（删除条目请用删除按钮）', target }
    if (newContent.includes('§')) {
      return { ok: false, message: '内容不能包含条目分隔符 §（会破坏记忆文件的分割格式）', target }
    }
    if (this.injectionScan) {
      const threat = scanThreat(newContent)
      if (threat) return { ok: false, message: threat, target }
    }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: `拒绝写入：${loc.file} 的内容无法通过记忆工具解析往返（可能被手工编辑或外部进程修改）。已备份到 ${reload.backup}。请先将该文件整理为规范的 § 分隔条目，再重试。`,
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: '记忆文件存在但无法读取，拒绝写入（防止清空已有记忆）', target }
      }
      const entries = reload.entries
      const index = entries.indexOf(exact)
      if (index === -1) {
        return {
          ok: false,
          message: '条目不存在（可能已被删除，或文件被外部修改）——请刷新列表后重试',
          target, entries: [...entries],
        }
      }
      const { head } = splitEntryHead(exact, target)
      // 防御：完全解析不出前缀的异常条目，编辑会破坏其原有格式——拒绝并提示手动处理
      if (head === '') {
        return {
          ok: false,
          message: '该条目没有可识别的标记前缀（时间戳/tag），无法安全编辑——请用系统工具打开文件手动修改',
          target, entries: [...entries],
        }
      }
      const next = [...entries]
      next[index] = `${head}${newContent}`
      this.write(target, next, agent)
      return {
        ok: true, message: `已更新条目（${target}）`, target,
        entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }
}

/**
 * Append-only JSONL queue of background-review memory suggestions
 * (the "learned track" awaiting user confirmation).
 */
export class SuggestionQueue {
  /**
   * @param {string} file - the JSONL file path.
   */
  constructor(file) {
    this.file = file
  }

  /** Read all suggestions; a missing file reads as empty. */
  read() {
    try {
      const text = readFileSync(this.file, 'utf8')
      return text
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  /** Atomically write the full suggestion list. */
  write(entries) {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp.${process.pid}`
    writeFileSync(tmp, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : ''))
    renameSync(tmp, this.file)
  }

  /** Append one suggestion under the directory lock. */
  append(entry) {
    return withLock(dirname(this.file), () => {
      const entries = this.read()
      entries.push(entry)
      this.write(entries)
      return { ok: true, queued: entries.length }
    })
  }

  /**
   * Mutate the suggestion list under the directory lock.
   * @param {(entries: object[]) => T} fn - the mutation; return value is passed through.
   * @returns {T} the mutation's return value.
   * @template T
   */
  mutate(fn) {
    return withLock(dirname(this.file), () => {
      const entries = this.read()
      const result = fn(entries)
      this.write(entries)
      return result
    })
  }
}

/**
 * 归档存储：低优先级记忆的冷存储——"丢了可惜但不够格进主记忆"的建议
 * 落在这里。不注入任何会话；条目可在记忆 Tab「移回主记忆」（转正，写回
 * 对应主轨）或删除。文件与主轨同格式（§ 分隔 + `[YYYY-MM-DD]` 时间戳），
 * 按原 target 分文件：`MEMORY-archive.md` / `USER-archive.md`，以及项目级
 * `projects/<cwd-hash>/KEY-archive.md`（key 轨的归档，随项目走，需 cwd）。
 */
export class ArchiveStore {
  /**
   * @param {string} dir - the memory directory (archive files live beside
   *   the main track files).
   */
  constructor(dir) {
    this.dir = dir
  }

  /** Resolve one archive file path; key requires the project cwd. */
  fileOf(target, cwd) {
    if (target === 'memory') return join(this.dir, 'MEMORY-archive.md')
    if (target === 'user') return join(this.dir, 'USER-archive.md')
    if (target === 'key') {
      if (!cwd) throw new Error('dsh-memory-evolve: key 归档需要会话工作目录')
      return join(this.dir, 'projects', projectHash(cwd), 'KEY-archive.md')
    }
    // todo-* 建议统一归档到 TODO-archive.md（归档条目是普通 § 文本，转正时按
    // 原 target 写回对应待办轨）
    if (typeof target === 'string' && target.startsWith('todo-')) {
      return join(this.dir, 'TODO-archive.md')
    }
    throw new Error(`dsh-memory-evolve: 无效的归档轨 "${target}"`)
  }

  /** Read one archive track's entries; a missing file reads as empty. */
  entriesOf(target, cwd) {
    try {
      return parseEntries(readFileSync(this.fileOf(target, cwd), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  /** Append one entry under the directory lock (atomic write). */
  append(target, content, cwd) {
    return withLock(this.dir, () => {
      const entries = this.entriesOf(target, cwd)
      entries.push(content)
      const path = this.fileOf(target, cwd)
      const tmp = `${path}.tmp.${process.pid}`
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(tmp, serializeEntries(entries))
      renameSync(tmp, path)
      return { ok: true, total: entries.length }
    })
  }

  /** Remove the single entry containing the unique substring `match`. */
  remove(target, match, cwd) {
    return withLock(this.dir, () => {
      const entries = this.entriesOf(target, cwd)
      const matches = entries.filter((entry) => entry.includes(match))
      if (matches.length === 0) return { ok: false, message: `归档中没有条目包含片段 "${match}"` }
      if (matches.length > 1) {
        return { ok: false, message: `片段 "${match}" 匹配到 ${matches.length} 个归档条目，请用更精确的片段` }
      }
      const next = entries.filter((entry) => !entry.includes(match))
      const path = this.fileOf(target, cwd)
      const tmp = `${path}.tmp.${process.pid}`
      writeFileSync(tmp, serializeEntries(next))
      renameSync(tmp, path)
      return { ok: true, removed: matches[0] }
    })
  }

  /** Remove the entry that EXACTLY equals `content` (whole-entry match). */
  removeExact(target, content, cwd) {
    return withLock(this.dir, () => {
      const entries = this.entriesOf(target, cwd)
      const index = entries.indexOf(content)
      if (index === -1) {
        return { ok: false, message: '归档条目不存在（可能已被删除）——请刷新列表后重试' }
      }
      const next = [...entries]
      next.splice(index, 1)
      const path = this.fileOf(target, cwd)
      const tmp = `${path}.tmp.${process.pid}`
      writeFileSync(tmp, serializeEntries(next))
      renameSync(tmp, path)
      return { ok: true, removed: content }
    })
  }
}
