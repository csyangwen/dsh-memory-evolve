/**
 * lib/sync/filesets.js — 同步文件集定义（全局轨二期并入一期，2026-08-11
 * 用户拍板：开关做好功能必须实现）
 *
 * 同步机制按"文件集"（fileset）区分同步范围：
 *   project       项目级（KEY/日志/归档/项目待办/logs/）——一期已有
 *   memory-global 全局记忆轨：MEMORY.md + MEMORY-archive.md
 *   user-global   用户档案轨：USER.md + USER-archive.md
 *   daily-global  每日日志轨：daily/*.md（记忆格式，追加型）
 *   todo-global   全局待办轨：TODOS-life.md / TODOS-work.md /
 *                 daily/*.todo.md（TODO 格式，tag id）
 *
 * 全局轨承载于**全局记忆仓库**（记忆根目录的 .git，deny-all 白名单只放行
 * 全局记忆文件），每个轨一条远端分支（dsh-shared/memory-global / user /
 * daily / todo-global，需求 #5 命名空间）与本地分支（refs/heads/<轨>），
 * 各轨互不干扰；仅共享记忆仓库（setup 带 url）可用。
 *
 * 纯函数零依赖（merge.js 等不引入仓库逻辑的地方可安全 import）。
 */

/**
 * 项目级文件集规格（memory=记忆格式文件、todo=TODO 格式文件、
 * logs=logs/ 目录放行）。'daily' 特殊项 = daily 目录（日志 .md 或 .todo.md）。
 */
export const PROJECT_SPEC = {
  memory: ['KEY.md', 'KEY-archive.md', 'MEMORY.md'],
  todo: ['TODOS.md'],
  logs: true,
}

/** 全局轨文件集规格（key = fileset 名 = 本地/远端分支名主体）。 */
export const GLOBAL_FILESETS = {
  'memory-global': { memory: ['MEMORY.md', 'MEMORY-archive.md'], todo: [], logs: false },
  'user-global': { memory: ['USER.md', 'USER-archive.md'], todo: [], logs: false },
  'daily-global': { memory: ['daily'], todo: [], logs: false },
  'todo-global': { memory: [], todo: ['TODOS-life.md', 'TODOS-work.md', 'daily'], logs: false },
}

/** 全部全局 fileset 列表（迭代用）。 */
export const GLOBAL_FILESET_KEYS = Object.keys(GLOBAL_FILESETS)

/** 全局轨远端分支名（dsh-shared/<轨>）。 */
export function globalBranchFor(fileset) {
  const name = {
    'memory-global': 'memory-global',
    'user-global': 'user',
    'daily-global': 'daily',
    'todo-global': 'todo-global',
  }[fileset]
  return `dsh-shared/${name ?? fileset}`
}

/** 全局轨本地分支名（refs/heads/<fileset>，与远端分支解耦）。 */
export function globalLocalBranchFor(fileset) {
  return fileset
}

/** 取 fileset 的规格对象（未知 fileset 抛错）。 */
export function filesetSpec(fileset) {
  if (fileset === 'project') return PROJECT_SPEC
  const spec = GLOBAL_FILESETS[fileset]
  if (spec === undefined) throw new Error(`dsh-memory-evolve: 未知同步文件集 "${fileset}"`)
  return spec
}

/** daily 日志文件路径模式（记忆格式）。 */
const DAILY_LOG_RE = /^daily\/\d{4}-\d{2}-\d{2}\.md$/
/** daily 待办文件路径模式（TODO 格式）。 */
const DAILY_TODO_RE = /^daily\/\d{4}-\d{2}-\d{2}\.todo\.md$/

/**
 * 判断路径是否属于某 fileset 的同步记忆文件（按路径模式，不依赖磁盘存在
 * ——readTreeFiles 要判断远端树里的路径名，本地可能不存在）。
 * @param {string} path - 相对路径。
 * @param {string} [fileset='project'] - 文件集。
 * @returns {boolean}
 */
export function isMemoryFile(path, fileset = 'project') {
  const spec = filesetSpec(fileset)
  if (spec.memory.includes(path)) return true
  if (spec.todo.includes(path)) return true
  if (spec.logs && path.startsWith('logs/') && path.endsWith('.md')) return true
  if (spec.memory.includes('daily') && DAILY_LOG_RE.test(path)) return true
  if (spec.todo.includes('daily') && DAILY_TODO_RE.test(path)) return true
  return false
}

/**
 * 判断路径是否是 TODO 格式文件（合并器按文件分流：TODO 用 tag id 做
 * entryKey、不补发行首身份证、写回带 header）。全局模式匹配，不依赖
 * fileset——同一路径在任何文件集里格式不变。
 * @param {string} path - 相对路径。
 * @returns {boolean}
 */
export function isTodoPath(path) {
  return path === 'TODOS.md' || path === 'TODOS-life.md' || path === 'TODOS-work.md' || DAILY_TODO_RE.test(path)
}
