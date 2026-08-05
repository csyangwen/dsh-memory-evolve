/**
 * dsh-memory-evolve — session memory-tab data.
 *
 * Serves the conversation view tab's file listing: the global rule file
 * (AGENTS.md) and the four memory tracks (MEMORY.md / USER.md / per-cwd
 * project / today's daily log), each with its raw text for inline display.
 * The tab is READ-ONLY for agents/memory/user (global, injected tracks);
 * project and daily are editable through `saveMemoryFile` (the plugin owns
 * those storage locations and the user may curate them by hand).
 *
 * Zero runtime dependencies.
 *
 * @module dsh-memory-evolve/memory-tab
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Inline display cap per file; longer content is truncated with a flag. */
const DISPLAY_LIMIT = 64 * 1024
/** Save cap: refuse absurdly large edits instead of writing them. */
const SAVE_LIMIT = 64 * 1024

/** Keys the session tab may save back (project/daily only). */
const EDITABLE_KEYS = new Set(['project', 'daily'])

/**
 * Build the memory-files listing for one session's tab.
 * @param {object} config - resolved plugin config.
 * @param {import('./store.js').MemoryStore} store - the memory store.
 * @param {string | undefined} cwd - the session's working directory; project
 *   memory is keyed by it (absent cwd → project entry marked unavailable).
 * @returns {Array<object>} the file rows, in display order:
 *   { key, title, path, editable, exists, content, truncated, available }.
 */
export function buildMemoryFiles(config, store, cwd) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const projectAgent = cwd ? { session: { header: { cwd } } } : undefined
  const rows = [
    { key: 'agents', title: '全局规则 AGENTS.md', path: join(dshHome, 'AGENTS.md'), editable: false },
    { key: 'memory', title: '长期记忆 MEMORY.md', path: store.pathOf('memory'), editable: false },
    { key: 'user', title: '用户档案 USER.md', path: store.pathOf('user'), editable: false },
    {
      key: 'project',
      title: '项目记忆（当前会话）',
      path: projectAgent ? store.pathOf('project', projectAgent) : undefined,
      editable: true,
      available: projectAgent !== undefined,
    },
    { key: 'daily', title: '今日日志', path: store.pathOf('daily'), editable: true },
  ]
  return rows.map((row) => {
    const out = {
      key: row.key,
      title: row.title,
      editable: row.editable,
      available: row.available ?? true,
      exists: false,
      truncated: false,
      content: '',
    }
    if (row.path === undefined) return out
    out.path = row.path
    if (!existsSync(row.path)) return out
    let text
    try {
      text = readFileSync(row.path, 'utf8')
    } catch {
      return out // unreadable file → treat as empty, keep the row visible
    }
    out.exists = true
    if (text.length > DISPLAY_LIMIT) {
      out.truncated = true
      text = text.slice(0, DISPLAY_LIMIT)
    }
    out.content = text
    return out
  })
}

/**
 * Save an editable memory file (project or daily) from the session tab.
 * @param {object} config - resolved plugin config.
 * @param {import('./store.js').MemoryStore} store - the memory store.
 * @param {string} key - 'project' or 'daily' (anything else is refused).
 * @param {string} content - the new raw file content.
 * @param {string | undefined} cwd - session cwd (required for 'project').
 * @returns {{ok: true, path: string} | {ok: false, message: string}} the
 *   outcome.
 */
export function saveMemoryFile(config, store, key, content, cwd) {
  if (!EDITABLE_KEYS.has(key)) {
    return { ok: false, message: `该文件只读，不能从面板保存（${key}）` }
  }
  if (typeof content !== 'string' || content.length > SAVE_LIMIT) {
    return { ok: false, message: `内容超限（上限 ${SAVE_LIMIT} 字符）` }
  }
  const agent = key === 'project'
    ? { session: { header: { cwd } } }
    : undefined
  if (key === 'project' && !cwd) {
    return { ok: false, message: '当前会话没有工作目录，无法定位项目记忆' }
  }
  const path = store.pathOf(key, agent)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    return { ok: true, path }
  } catch (error) {
    return { ok: false, message: `保存失败：${error?.message ?? String(error)}` }
  }
}
