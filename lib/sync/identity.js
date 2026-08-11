/**
 * lib/sync/identity.js — 项目身份解析层（施工图 §7 第 1 步）
 *
 * 职责：把"一个工作目录"解析成"一个跨设备稳定的项目身份"。
 *
 * 核心决策（用户拍板，见 docs-local/项目记忆跨设备共享-调研-20260810.md v13）：
 *   - 项目身份 = 主仓库 git remote 地址的归一化值（需求 #2：多 remote 时
 *     origin 优先）；
 *   - 同一远端仓库无论用 https / ssh / git 协议、带不带凭证、带不带 .git
 *     后缀，都解析到同一个身份键 —— 双设备 clone 方式不同也能"认亲"；
 *   - 无 remote / 归一化失败（file://、本地路径等不可共享形态）→ 回退现有
 *     projectHash(cwd)（12 hex），与旧目录命名完全兼容（迁移回查依赖此点）。
 *
 * 工程约束（施工图 §8）：
 *   - 本模块只用本地 git 命令（remote get-url / remote / rev-parse），同步
 *     执行毫秒级，绝不发起网络请求（网络命令才走 sync-worker 异步进程）；
 *   - normalizeRemoteUrl 是纯函数（零 IO），便于单测；
 *   - 与 store.js 的 projectHash / projectLabel 复用同一实现 —— fallback
 *     场景下必须算出与旧目录一模一样的目录名，否则迁移回查会失配。
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { projectHash, projectLabel } from '../store.js'

/**
 * 归一化远端仓库 URL → 跨协议身份键。
 *
 * 返回形如 `host[:port]/path` 的字符串（去协议、去凭证、去 .git、去尾斜杠、
 * host 小写、默认端口省略）。**https 与 ssh 形态收敛到同一键**——这是双设备
 * 认亲的关键：设备 A 用 https clone、设备 B 用 ssh clone，身份必须一致。
 *
 * 归一化失败（file://、本地绝对路径、无仓库路径、空输入等）返回 undefined，
 * 调用方据此回退本地 projectHash(cwd)（施工图 §9：非标准 remote 不共享）。
 *
 * @param {string | undefined} url - 远端 URL（如 `https://github.com/user/repo.git`）。
 * @returns {string | undefined} 身份键，或 undefined（无法归一化）。
 */
export function normalizeRemoteUrl(url) {
  if (typeof url !== 'string') return undefined
  const trimmed = url.trim()
  if (trimmed === '') return undefined

  // —— 形态 1：SCP 式 SSH 地址（git@github.com:user/repo.git）——
  // 无 scheme、含 `@` 与 `:`、冒号前不是 Windows 盘符。转成 ssh:// 形态后
  // 走统一解析（丢掉的 `git@` 用户名不影响仓库身份，SSH 用户名也不是凭证）。
  const isScpLike = !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    && !/^[a-zA-Z]:[\\/]/.test(trimmed)
    && /^[^@\s]+@[^:/\s]+:/.test(trimmed)
  if (isScpLike) {
    const host = trimmed.slice(trimmed.indexOf('@') + 1, trimmed.indexOf(':'))
    const path = trimmed.slice(trimmed.indexOf(':') + 1)
    return normalizeUrlCore(`ssh://${host}/${path}`)
  }

  // —— 形态 2：明确不可共享的本地形态（file://、盘符、Unix 绝对路径）——
  if (/^file:\/\//.test(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) {
    return undefined
  }

  // —— 形态 3：带 scheme 的远程 URL ——
  return normalizeUrlCore(trimmed)
}

/**
 * URL 归一化核心：解析、验协议、去凭证与 .git、规范化 host/端口/path。
 * @param {string} input - 带 scheme 的完整 URL。
 * @returns {string | undefined} 身份键，或 undefined。
 */
function normalizeUrlCore(input) {
  let parsed
  try {
    parsed = new URL(input)
  } catch {
    return undefined
  }
  // 只接受四种远程 git 协议；file/ftp/其他一律视为不可共享
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return undefined
  if (!parsed.hostname) return undefined

  let path = parsed.pathname.replace(/\/+$/, '') // 去尾部斜杠
  if (path === '') return undefined // 无仓库路径（如 https://github.com/）→ 不可共享
  path = path.replace(/\.git$/, '') // 去 .git 后缀（大小写敏感即可，git 惯例全小写）
  if (path === '') return undefined

  // 默认端口省略（https:443 / http:80 / ssh:22 / git:9418），非默认端口保留
  const defaultPort = { 'https:': '443', 'http:': '80', 'ssh:': '22', 'git:': '9418' }[parsed.protocol]
  const port = parsed.port && parsed.port !== defaultPort ? `:${parsed.port}` : ''

  // 身份键 = host[:port] + path。刻意不带协议与凭证：
  //   - 不带协议 → https / ssh / http / git 同一仓库收敛为同一身份；
  //   - 不带凭证 → URL 里误带 token 也不会把身份键弄脏（键还会进目录名与
  //     PROVENANCE，明文 token 绝不能出现在那里）。
  return `${parsed.hostname.toLowerCase()}${port}${path}`
}

/**
 * 清洗 URL 里的明文凭证（https://user:pass@host/... → https://host/...），
 * 用于 `git remote add origin <url>`——避免把 token/密码写进记忆仓库的
 * .git/config。SSH 的 `git@` 用户名保留（不是秘密，去掉反而可能坏认证）。
 * 无法解析的输入原样返回（调用方自担）。
 *
 * @param {string} url - 原始远端 URL。
 * @returns {string} 无凭证 URL。
 */
export function sanitizeRemoteUrl(url) {
  if (typeof url !== 'string') return url
  const trimmed = url.trim()
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed // SCP/本地形态原样
  try {
    const parsed = new URL(trimmed)
    if (['https:', 'http:'].includes(parsed.protocol)) {
      parsed.username = ''
      parsed.password = ''
      return parsed.toString().replace(/\/$/, '')
    }
    return trimmed
  } catch {
    return trimmed
  }
}

/**
 * 解析主仓库 remote（需求 #2：origin 优先，其次第一个 remote）。
 *
 * 只做本地 git 查询（毫秒级同步），不联网。cwd 不在 git 仓库内时返回 null。
 *
 * @param {string | undefined} cwd - 会话工作目录。
 * @returns {{ name: string, url: string, root: string | undefined } | null}
 *   remote 名、原始 URL、仓库根路径（root 仅作展示，查询失败为 undefined）。
 */
export function resolveMainRemote(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null

  // origin 优先（git remote get-url 输出即完整 URL；无 get-url 的老版本
  // git 用 `git config --get remote.<name>.url` 兜底）
  let name = 'origin'
  let url = gitRemoteUrl(cwd, name)
  if (url === undefined) {
    // 无 origin → 取 git remote 列表第一个
    const names = gitRemoteNames(cwd)
    if (names.length === 0) return null
    name = names[0]
    url = gitRemoteUrl(cwd, name)
  }
  if (url === undefined) return null

  return { name, url, root: gitTopLevel(cwd) }
}

/**
 * 解析项目身份。
 *
 * @param {string | undefined} cwd - 会话工作目录。
 * @returns {{
 *   id: string,          // 12 hex 目录名（sha1(身份键) 前 12 位，或回退 projectHash(cwd)）
 *   kind: 'remote' | 'fallback', // remote=按仓库地址识别；fallback=本地 cwd 识别
 *   remoteName: string | undefined, // 命中的 remote 名（fallback 时为 undefined）
 *   remoteUrl: string | undefined,  // 无凭证的 remote URL（用于 git remote add；fallback 时为 undefined）
 *   displayName: string, // 可读名：归一化键（已去凭证）或项目标签；写进 PROVENANCE
 *   repoRoot: string | undefined, // 仓库根路径（展示用）
 *   key: string | null,  // 身份键原文（null = fallback）
 * }}
 */
export function resolveProjectId(cwd) {
  const remote = resolveMainRemote(cwd)
  if (remote) {
    const key = normalizeRemoteUrl(remote.url)
    if (key) {
      return {
        id: createHash('sha1').update(key).digest('hex').slice(0, 12),
        kind: 'remote',
        remoteName: remote.name,
        remoteUrl: sanitizeRemoteUrl(remote.url),
        displayName: key,
        repoRoot: remote.root,
        key,
      }
    }
    // remote 存在但归一化失败（file:// 等）→ 落到 fallback（施工图 §9）
  }
  return {
    id: projectHash(cwd),
    kind: 'fallback',
    remoteName: undefined,
    remoteUrl: undefined,
    displayName: projectLabel(cwd) ?? String(cwd),
    repoRoot: remote?.root,
    key: null,
  }
}

/**
 * 迁移回查：定位旧目录（按 projectHash(cwd) 命名的目录）。
 *
 * 场景：项目此前没有 remote（fallback 身份 <旧hash>），后来主仓库加了
 * remote → 身份变为 <新hash> → 旧记忆目录需要 rename 迁移到新目录。
 * bootstrap 阶段调用：存在旧目录且 ≠ 新目录时返回旧目录路径。
 *
 * @param {string | undefined} memoryDir - 记忆根目录（~/.dsh/memories）。
 * @param {string | undefined} cwd - 会话工作目录。
 * @param {string} projectId - 当前解析出的新项目 id。
 * @returns {string | null} 旧目录绝对路径，或 null（无旧目录/新旧相同）。
 */
export function locateLegacyDir(memoryDir, cwd, projectId) {
  if (typeof memoryDir !== 'string' || typeof cwd !== 'string') return null
  const legacyId = projectHash(cwd)
  if (legacyId === projectId) return null // 身份没变，无需迁移
  const legacyDir = join(memoryDir, 'projects', legacyId)
  return existsSync(legacyDir) ? legacyDir : null
}

/**
 * 项目记忆目录解析（公共版，memory-tab 等非装配层使用）：sync 已初始化的
 * 项目返回 projectId 目录（PROVENANCE 存在），否则回退 projectHash(cwd)。
 * 与 makeProjectDirResolver（lib/sync/index.js）同一规则——那里是工厂函数，
 * 这里直接以 (memoryDir, cwd) 为参数，避免引入 sync/index 的依赖。
 * @param {string} memoryDir - 记忆根目录。
 * @param {string} cwd - 会话工作目录。
 * @returns {string} 项目记忆目录绝对路径。
 */
export function resolveProjectDir(memoryDir, cwd) {
  const identity = resolveProjectId(cwd)
  const syncDir = join(memoryDir, 'projects', identity.id)
  if (existsSync(join(syncDir, 'PROVENANCE'))) return syncDir
  return join(memoryDir, 'projects', projectHash(cwd))
}

/* ---------------- 内部 git 查询辅助（全部本地、同步、毫秒级） ---------------- */

/** `git remote get-url <name>`（老 git 兜底 `git config --get remote.<name>.url`）。 */
function gitRemoteUrl(cwd, name) {
  let result = runGit(['remote', 'get-url', name], cwd)
  if (result === undefined) {
    result = runGit(['config', '--get', `remote.${name}.url`], cwd)
  }
  return result
}

/** `git remote`（列出全部 remote 名）。 */
function gitRemoteNames(cwd) {
  const out = runGit(['remote'], cwd)
  if (out === undefined) return []
  return out.split('\n').map((n) => n.trim()).filter((n) => n.length > 0)
}

/** `git rev-parse --show-toplevel`（仓库根；非仓库/无 git 时 undefined）。 */
function gitTopLevel(cwd) {
  return runGit(['rev-parse', '--show-toplevel'], cwd)
}

/**
 * 执行本地 git 命令。失败返回 undefined（调用方区分"无输出"与"命令失败"）。
 * @param {string[]} args
 * @param {string} cwd
 */
function runGit(args, cwd) {
  try {
    const result = spawnSync('git', args, {
      cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.error || result.status !== 0) return undefined
    const out = String(result.stdout ?? '').trim()
    return out === '' ? undefined : out
  } catch {
    return undefined
  }
}
