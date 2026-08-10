/**
 * dsh-memory-evolve — session memory-tab data.
 *
 * Serves the conversation view tab's file listing: the global rule file
 * (AGENTS.md) and the five memory tracks (MEMORY.md / USER.md / per-cwd
 * project log / per-cwd project KEY facts / today's daily log), each with
 * its raw text for inline display. The tab is READ-ONLY for every track
 * except the KEY track's manual-add box (which goes through the host API's
 * store.add, never raw text edits): hand-editing the files here would risk
 * corrupting the §-delimited entry format that the memory tool parses, so
 * edits happen through the memory tool, the system editor (the "open with
 * system tool" action per row), or the KEY add box.
 *
 * Zero runtime dependencies.
 *
 * @module dsh-memory-evolve/memory-tab
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { projectHash } from './store.js'

/**
 * 不再设显示上限（2026-08-10）：项目日志/每日日志是追加增长型文件
 * （一年可达几 MB），且不注入、按需读取——上限只会让用户/AI 看不到
 * 最新记录。前端美观视图按条目分页（每页 50 条）兜底渲染性能。
 */

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
  const projectDir = cwd ? join(config.memoryDir, 'projects', projectHash(cwd)) : undefined
  const rows = [
    {
      key: 'project',
      title: '项目日志',
      path: projectAgent ? store.pathOf('project', projectAgent) : undefined,
      available: projectAgent !== undefined,
    },
    {
      key: 'key',
      title: '项目关键记忆 KEY.md',
      path: projectAgent ? store.pathOf('key', projectAgent) : undefined,
      available: projectAgent !== undefined,
    },
    {
      key: 'archive-key',
      title: '项目关键记忆归档 KEY-archive.md',
      path: projectDir ? join(projectDir, 'KEY-archive.md') : undefined,
      available: projectDir !== undefined,
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
    // 全量下发：前端美观视图按条目分页渲染（见 MemoryTabView），
    // raw 视图直接渲染长文本（现代浏览器可承受数 MB 文本节点）。
    out.content = text
    return out
  })
}
