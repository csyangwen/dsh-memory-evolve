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
import { resolveProjectDir } from './sync/identity.js'
import { stripEntrySummary } from './store.js'
import { translate, getLocale } from './i18n.js'

/**
 * Row-title dictionary (zh/en pairs) — the memory tab's file listing is
 * host-rendered data (lib/api.js → buildMemoryFiles), so its labels localize
 * on the host side with the active session locale instead of in the browser.
 */
const TITLE_DICT = {
  'memoryTab.row.project': ['项目日志', 'Project log'],
  'memoryTab.row.key': ['项目关键记忆 KEY.md', 'Key project facts KEY.md'],
  'memoryTab.row.archiveKey': ['项目关键记忆归档 KEY-archive.md', 'Archived key facts KEY-archive.md'],
  'memoryTab.row.daily': ['今日日志', 'Daily log'],
  'memoryTab.row.user': ['用户档案 USER.md', 'User profile USER.md'],
  'memoryTab.row.memory': ['长期记忆 MEMORY.md', 'Long-term memory MEMORY.md'],
  'memoryTab.row.archiveUser': ['归档用户 USER-archive.md', 'Archived user profile USER-archive.md'],
  'memoryTab.row.archiveMemory': ['归档记忆 MEMORY-archive.md', 'Archived long-term memory MEMORY-archive.md'],
  'memoryTab.row.agents': ['全局规则 AGENTS.md', 'AGENTS.md'],
}

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
  const projectDir = cwd ? resolveProjectDir(config.memoryDir, cwd) : undefined
  const rows = [
    {
      key: 'project',
      title: translate(TITLE_DICT, 'memoryTab.row.project', undefined, getLocale()),
      path: projectAgent ? store.pathOf('project', projectAgent) : undefined,
      available: projectAgent !== undefined,
    },
    {
      key: 'key',
      title: translate(TITLE_DICT, 'memoryTab.row.key', undefined, getLocale()),
      path: projectAgent ? store.pathOf('key', projectAgent) : undefined,
      available: projectAgent !== undefined,
    },
    {
      key: 'archive-key',
      title: translate(TITLE_DICT, 'memoryTab.row.archiveKey', undefined, getLocale()),
      path: projectDir ? join(projectDir, 'KEY-archive.md') : undefined,
      available: projectDir !== undefined,
    },
    { key: 'daily', title: translate(TITLE_DICT, 'memoryTab.row.daily', undefined, getLocale()), path: store.pathOf('daily') },
    { key: 'user', title: translate(TITLE_DICT, 'memoryTab.row.user', undefined, getLocale()), path: store.pathOf('user') },
    { key: 'memory', title: translate(TITLE_DICT, 'memoryTab.row.memory', undefined, getLocale()), path: store.pathOf('memory') },
    { key: 'archive-user', title: translate(TITLE_DICT, 'memoryTab.row.archiveUser', undefined, getLocale()), path: join(config.memoryDir, 'USER-archive.md') },
    { key: 'archive-memory', title: translate(TITLE_DICT, 'memoryTab.row.archiveMemory', undefined, getLocale()), path: join(config.memoryDir, 'MEMORY-archive.md') },
    { key: 'agents', title: translate(TITLE_DICT, 'memoryTab.row.agents', undefined, getLocale()), path: join(dshHome, 'AGENTS.md') },
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
    // 展示剥离：条目身份证 [id:…]（跨设备合并锚点）是内部机制，Tab 显示
    // 一律剥掉（施工图 §4.7）；摘要标记 [summary:…] 同属程序元数据，正文
    // 完整显示时不再展示（2026-08-15，与快照全量注入同规则）。
    // 审查修复：原 loose 正则（任意 […] 前缀后跟 summary）会误剥正文中
    // 的 [summary:…] 文本；改为复用 store.js 的 stripEntrySummary——按
    // head token 序列（[id]→时间戳→[git]→[branch]→[dsh-only]）精确
    // 匹配，只在真正的头部剥离。条目文件以 § 分隔，逐条处理后重组；
    // 非条目结构的行（如文件头注释）不受影响（无 head+summary 序列）。
    // "用系统工具打开"走 row.path 原文，不受影响。
    out.content = text
      .split('\n§\n')
      .map((chunk) => {
        const trimmed = chunk.trim()
        return trimmed === '' ? chunk : stripEntrySummary(trimmed)
      })
      .join('\n§\n')
      .replace(/^\[id:[0-9a-f]{8}\] /gm, '')
    return out
  })
}
