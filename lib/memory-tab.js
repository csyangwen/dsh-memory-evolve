/**
 * dsh-memory-evolve — session memory-tab data.
 *
 * Serves the conversation view tab's file listing: the global rule file
 * (AGENTS.md) and the four memory tracks (MEMORY.md / USER.md / per-cwd
 * project / today's daily log), each with its raw text for inline display.
 * The tab is READ-ONLY for every track: hand-editing the files here would
 * risk corrupting the §-delimited entry format that the memory tool parses,
 * so edits happen through the memory tool or the system editor (the
 * "open with system tool" action per row).
 *
 * Zero runtime dependencies.
 *
 * @module dsh-memory-evolve/memory-tab
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Inline display cap per file; longer content is truncated with a flag. */
const DISPLAY_LIMIT = 64 * 1024

/**
 * Build the memory-files listing for one session's tab (read-only).
 * @param {object} config - resolved plugin config.
 * @param {import('./store.js').MemoryStore} store - the memory store.
 * @param {string | undefined} cwd - the session's working directory; project
 *   memory is keyed by it (absent cwd → project entry marked unavailable).
 * @returns {Array<object>} the file rows, in display order:
 *   { key, title, path, exists, content, truncated, available }.
 */
export function buildMemoryFiles(config, store, cwd) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const projectAgent = cwd ? { session: { header: { cwd } } } : undefined
  const rows = [
    {
      key: 'project',
      title: '项目记忆（当前会话）',
      path: projectAgent ? store.pathOf('project', projectAgent) : undefined,
      available: projectAgent !== undefined,
    },
    { key: 'daily', title: '今日日志', path: store.pathOf('daily') },
    { key: 'user', title: '用户档案 USER.md', path: store.pathOf('user') },
    { key: 'memory', title: '长期记忆 MEMORY.md', path: store.pathOf('memory') },
    { key: 'archive-user', title: '归档用户 USER-archive.md', path: join(config.memoryDir, 'USER-archive.md') },
    { key: 'archive-memory', title: '归档记忆 MEMORY-archive.md', path: join(config.memoryDir, 'MEMORY-archive.md') },
    { key: 'agents', title: '全局规则 AGENTS.md', path: join(dshHome, 'AGENTS.md') },
  ]
  return rows.map((row) => {
    const out = {
      key: row.key,
      title: row.title,
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
