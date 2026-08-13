/**
 * dsh-memory-evolve — Web GUI API.
 *
 * Serves the settings-panel data for the web half: the pending suggestion
 * queue (with approve/reject operations), the runtime-config view/update,
 * and the badge count. Registered dynamically through `ctx.inject` on the
 * `httpServer` service, so the plugin loads harmlessly on surfaces without
 * it (e.g. the TUI).
 *
 * Routes (prefix `/memory-evolve`):
 *   GET  /api/badge                       → { count }
 *   GET  /api/suggestions                 → { entries }
 *   POST /api/suggestions/approve         { indices }    → report
 *   POST /api/suggestions/reject          { indices }    → report
 *   POST /api/suggestions/archive         { indices }    → report
 *   GET  /api/archive                     → { entries }
 *   POST /api/archive/promote            { target, match } → outcome
 *   POST /api/archive/delete             { target, match } → outcome
 *   POST /api/memory/key   { sessionId, content } → key-track add outcome
 *   POST /api/memory/delete { sessionId, target, match } → exact per-entry delete outcome
 *   POST /api/memory/archive { target, match } → main-track entry → archive file (memory/user)
 *   POST /api/suggestions/approve-all                     → report
 *   POST /api/suggestions/reject-all                      → report
 *   GET  /api/config                      → { config }
 *   POST /api/config                      { patch }      → { config }
 *
 * Zero runtime dependencies (node:http only).
 *
 * @module dsh-memory-evolve/api
 */

import { URL } from 'node:url'
import { join } from 'node:path'
import { approveSuggestions, archiveSuggestions, promoteArchived, rejectSuggestions } from './review.js'
import { RUNTIME_KEYS, gitBranch, gitBranchList } from './index.js'
import { AliasStore } from './aliases.js'
import { buildMemoryFiles } from './memory-tab.js'
import { approvePendingSkill, listPendingSkills, rejectPendingSkill } from './skills.js'
import { normalizeModelsPatch } from './models.js'

/** The pending-skill queue directory (under the memory dir). */
function pendingSkillDir(deps) {
  return join(deps.config.memoryDir, 'pending-skills')
}

/** Read the JSON request body (capped). */
async function readBody(req, maxBytes = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid JSON body')
  }
}

/**
 * 同源校验（保护本地更新端点）：要求 Content-Type 精确为 JSON 媒体类型
 * （子串匹配会放过 text/plain;charset=json 之类，CodeX 复审 P1-5）；
 * 写操作强制要求 Origin 头存在且 host 与 Host 一致——跨站表单/脚本
 * 无法构造 JSON 体、且同源 fetch 必然携带 Origin。返回错误文案或 null。
 */
function sameOriginGuard(req, body) {
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    return '请求必须为 application/json'
  }
  const host = String(req.headers.host ?? '')
  const origin = String(req.headers.origin ?? '')
  if (origin === '') return '缺少 Origin 头，已拒绝（更新必须由 Web UI 发起）'
  let originHost = ''
  try {
    originHost = new URL(origin).host
  } catch {
    return '跨站请求已拒绝'
  }
  if (originHost !== host) return '跨站请求已拒绝'
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    return '请求体必须是 JSON 对象'
  }
  return null
}

/** Send a JSON response with the given status. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/** Parse `indices` from a request body; throws on invalid shapes. */
function parseIndices(body) {
  const raw = body?.indices
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((n) => !Number.isInteger(n) || n < 1)) {
    throw new Error('indices must be a non-empty array of positive integers')
  }
  return raw
}

/** Resolve the session cwd from a request body (required for key-track ops). */
function resolveSessionCwd(body, deps) {
  const sessionId = String(body?.sessionId ?? '')
  const cwd = deps.resolveCwd?.(sessionId)
  if (!cwd) throw new Error('无法定位项目记忆：会话没有工作目录')
  return cwd
}

/**
 * Install the web API.
 * @param {object} ctx - a context with the `httpServer` service.
 * @param {object} deps - { store, archive, queue, getRuntime, updateRuntime }.
 * @returns {() => void} the httpServer registration disposer.
 */
export function installApi(ctx, deps) {
  const { store, archive, queue, todoStore, getRuntime, updateRuntime } = deps
  // 会话别名（友好名称）：全局属性，不挂任何模块开关（随时可用）。
  // 优先用主插件共享实例（de_session rename 也写同一文件/内存缓存），
  // 未提供时自建（兼容测试等直接调用场景）
  const aliases = deps.aliases ?? new AliasStore(deps.config.memoryDir)

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const segments = path.split('/').filter(Boolean)
    try {
      // 会话别名：GET 全量（面板渲染用）/ PUT 设置 / DELETE 清除
      if (req.method === 'GET' && path === '/memory-evolve/api/aliases') {
        sendJson(res, 200, { aliases: aliases.all() })
        return
      }
      if (req.method === 'PUT' && segments.length === 4 && segments[0] === 'memory-evolve' && segments[1] === 'api' && segments[2] === 'aliases') {
        const sessionId = decodeURIComponent(segments[3])
        const body = await readBody(req)
        const result = aliases.set(sessionId, body?.name)
        sendJson(res, result.ok ? 200 : 400, result)
        return
      }
      if (req.method === 'DELETE' && segments.length === 4 && segments[0] === 'memory-evolve' && segments[1] === 'api' && segments[2] === 'aliases') {
        const sessionId = decodeURIComponent(segments[3])
        sendJson(res, 200, aliases.remove(sessionId))
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/api/badge') {
        // 建议计数按类拆分：suggestions=记忆类（memory/user），
        // todoSuggestions=待办类（todo-*）——两个独立的待确认 tab。
        const all = queue.read()
        const suggestions = all.filter((entry) => !entry.target.startsWith('todo-')).length
        const todoSuggestions = all.length - suggestions
        const skills = listPendingSkills(pendingSkillDir(deps)).length
        // update：版本检测模块的独立红点字段（0/1）。只读缓存状态，
        // 绝不在此执行 git 检测（30s 轮询不能触发网络操作）。
        const update = deps.updateOps ? await deps.updateOps.badgeUpdate() : 0
        sendJson(res, 200, { count: suggestions + todoSuggestions + skills, suggestions, todoSuggestions, skills, update })
        return
      }
      // —— 版本检测与更新（lib/update.js，一期）——
      if (req.method === 'GET' && path === '/memory-evolve/api/update/status') {
        // 状态查询：?force=1 强制重检（「检查更新」按钮）；普通调用走
        // 24h 缓存/30min 失败退避（Web UI 挂载时触发）。
        if (!deps.updateOps) { sendJson(res, 422, { ok: false, code: 'unsupported', error: '版本检测模块未装配' }); return }
        try {
          const force = url.searchParams.get('force') === '1'
          const state = await deps.updateOps.status(force)
          // DTO 白名单：内部字段（repoPath/remoteUrl/headSha/latestSha 等）
          // 不外发（CodeX 复审 P1-5）。
          sendJson(res, 200, {
            ok: true,
            status: state.status,
            latestTag: state.latestTag ?? null,
            localTag: state.localTag ?? null,
            noteCode: state.noteCode ?? '',
            lastSuccessAt: state.lastSuccessAt ?? null,
            lastAttemptAt: state.lastAttemptAt ?? null,
            lastError: state.lastError ? { kind: state.lastError.kind, message: state.lastError.message } : null,
            restartRequired: state.restartRequired === true,
            lastUpdated: state.lastUpdated ? { tag: state.lastUpdated.tag, at: state.lastUpdated.at, notes: state.lastUpdated.notes ?? '' } : null,
          })
        } catch {
          sendJson(res, 503, { ok: false, code: 'error', error: '版本检测服务内部错误' })
        }
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/update') {
        // 手动更新：必须携带用户看到的 expectedTag；JSON 体 + 同源校验
        // 防跨站表单/脚本触发本地 git 写操作。
        if (!deps.updateOps) { sendJson(res, 422, { ok: false, code: 'unsupported', error: '版本检测模块未装配' }); return }
        let body
        try {
          body = await readBody(req)
        } catch {
          sendJson(res, 400, { ok: false, code: 'bad-request', error: '请求体不是合法 JSON' })
          return
        }
        const guard = sameOriginGuard(req, body)
        if (guard) { sendJson(res, 400, { ok: false, code: 'bad-request', error: guard }); return }
        const expectedTag = String(body?.expectedTag ?? '')
        try {
          const outcome = await deps.updateOps.update(expectedTag)
          if (!outcome.ok) {
            const statusMap = { 'bad-request': 400, dirty: 409, busy: 409, 'target-changed': 409, untrusted: 422, unsupported: 422, error: 503 }
            sendJson(res, statusMap[outcome.code] ?? 500, { ok: false, code: outcome.code, error: outcome.error })
            return
          }
          sendJson(res, 200, { ok: true, tag: outcome.tag, sha: outcome.sha, releaseNotes: outcome.releaseNotes, restartRequired: outcome.restartRequired })
        } catch {
          sendJson(res, 503, { ok: false, code: 'error', error: '更新服务内部错误' })
        }
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/api/suggestions') {
        sendJson(res, 200, { entries: queue.read() })
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/api/config') {
        // Only the runtime-changeable keys are exposed (the panel echoes this
        // object back as a patch, and static config keys such as memoryDir are
        // not valid patch keys). `memoryTabEnabled` is read-only here: it is
        // NOT a runtime key anymore (the tab hosts the config panel itself, so
        // switching it off in the UI would be a self-hiding trap — it can only
        // be set through config.yaml), but the client still needs to know it
        // to decide whether to register the tab.
        const runtime = getRuntime()
        sendJson(res, 200, {
          config: {
            ...Object.fromEntries(RUNTIME_KEYS.map((key) => [key, runtime[key]])),
            memoryTabEnabled: runtime.memoryTabEnabled,
          },
        })
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/config') {
        const body = await readBody(req)
        const patch = body?.patch
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
          throw new Error('patch must be an object')
        }
        sendJson(res, 200, { config: updateRuntime(patch) })
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/suggestions/approve') {
        const body = await readBody(req)
        const indices = parseIndices(body)
        const rawEdits = body?.contents
        let edits
        if (rawEdits !== undefined) {
          if (!Array.isArray(rawEdits) || rawEdits.length !== indices.length
            || rawEdits.some((c) => typeof c !== 'string')) {
            throw new Error('contents must be a string array aligned with indices')
          }
          edits = new Map(indices.map((index, i) => [index, rawEdits[i]]))
        }
        // Per-index target override: { "1": "key", "2": "user" } — re-classify
        // a fact into one of the three memory tracks; absent = the recommended
        // target. (Todo suggestions keep their track; the panel offers the
        // memory trio only.)
        const VALID_TARGETS = new Set(['memory', 'user', 'key'])
        const rawTargets = body?.targets
        let targets
        if (rawTargets !== undefined) {
          if (rawTargets === null || typeof rawTargets !== 'object' || Array.isArray(rawTargets)) {
            throw new Error('targets must be an object of index → target')
          }
          targets = new Map()
          for (const [key, value] of Object.entries(rawTargets)) {
            const index = Number(key)
            const target = String(value)
            if (!Number.isInteger(index) || index < 1) throw new Error(`无效的建议序号 "${key}"`)
            if (!VALID_TARGETS.has(target)) throw new Error(`无效的采纳目标 "${target}"`)
            targets.set(index, target)
          }
        }
        const report = approveSuggestions(store, todoStore, queue, indices, undefined, edits, targets)
        sendJson(res, 200, report)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/suggestions/reject') {
        const body = await readBody(req)
        const report = rejectSuggestions(queue, parseIndices(body))
        sendJson(res, 200, report)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/suggestions/archive') {
        const body = await readBody(req)
        const report = archiveSuggestions(archive, queue, parseIndices(body))
        sendJson(res, 200, report)
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/api/archive') {
        const sessionId = url.searchParams.get('sessionId')
        const cwd = deps.resolveCwd?.(sessionId)
        // 展示剥离：归档条目含身份证 [id:…]（跨设备合并锚点），Tab 展示一律
        // 剥掉（施工图 §4.7；转正操作走原文匹配，不受影响）
        const strip = (content) => content.replace(/^\[id:[0-9a-f]{8}\]\s*/, '')
        sendJson(res, 200, {
          entries: [
            ...archive.entriesOf('memory').map((content) => ({ target: 'memory', content: strip(content) })),
            ...archive.entriesOf('user').map((content) => ({ target: 'user', content: strip(content) })),
            ...(cwd ? archive.entriesOf('key', cwd).map((content) => ({ target: 'key', content: strip(content) })) : []),
            // todo-* 建议统一归档在 TODO-archive.md（转正时写回对应待办轨）
            ...archive.entriesOf('todo-archive').map((content) => ({ target: 'todo-archive', content: strip(content) })),
          ],
        })
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/archive/promote') {
        const body = await readBody(req)
        const target = String(body?.target ?? '')
        const match = String(body?.match ?? '').trim()
        const isTodo = target.startsWith('todo-')
        if (target !== 'memory' && target !== 'user' && target !== 'key' && !isTodo) {
          throw new Error('target 必须是 memory / user / key / todo-*')
        }
        if (!match) throw new Error('match 不能为空')
        const cwd = target === 'key' || target === 'todo-project' ? resolveSessionCwd(body, deps) : undefined
        const outcome = promoteArchived(store, todoStore, archive, target, match, cwd)
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/archive/delete') {
        const body = await readBody(req)
        const target = String(body?.target ?? '')
        const match = String(body?.match ?? '').trim()
        const isTodo = target.startsWith('todo-')
        if (target !== 'memory' && target !== 'user' && target !== 'key' && !isTodo) {
          throw new Error('target 必须是 memory / user / key / todo-*')
        }
        if (!match) throw new Error('match 不能为空')
        const cwd = target === 'key' ? resolveSessionCwd(body, deps) : undefined
        const outcome = archive.remove(target, match, cwd)
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/suggestions/approve-all') {
        const all = Array.from({ length: queue.read().length }, (_, i) => i + 1)
        sendJson(res, 200, approveSuggestions(store, todoStore, queue, all, undefined))
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/suggestions/reject-all') {
        const all = Array.from({ length: queue.read().length }, (_, i) => i + 1)
        sendJson(res, 200, rejectSuggestions(queue, all))
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/reveal') {
        const body = await readBody(req)
        const target = body?.target
        const resolved = deps.resolveRevealTarget?.(target)
        if (resolved === undefined) {
          throw new Error(`未知的打开目标 "${target}"`)
        }
        // revealPath rejects when no open command is available (e.g. WSL
        // without xdg-utils): surface that to the panel instead of silently
        // swallowing the click.
        await deps.revealPath(resolved)
        sendJson(res, 200, { ok: true, path: resolved })
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/memory-sync/status') {
        // 记忆同步状态（施工图 §6）：syncEnabled 时返回项目同步状态
        // （initialized/uncommitted/behind/conflicts/remoteBranch），
        // 未启用/未初始化如实返回（前端据此显示最小状态行）。
        const sessionId = url.searchParams.get('sessionId')
        const cwd = deps.resolveCwd?.(sessionId)
        const status = deps.syncStatus ? deps.syncStatus(cwd) : { enabled: false, initialized: false }
        // 附加迁移提示（旧目录可见性，migrate 命令的 UI 数据面）
        if (status.enabled && cwd && deps.syncOps) {
          status.migrateFrom = deps.syncOps.migrate(cwd) // null = 无旧目录
        }
        sendJson(res, 200, status)
        return
      }
      if (path === '/memory-evolve/memory-sync/setup') {
        // 初始化（记忆同步 Tab）：POST { sessionId, url? }——无 url=模式 A
        // （复用主仓库 remote）；url=模式 B 私有记忆仓库
        const body = await readBody(req)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        if (!cwd) { sendJson(res, 400, { ok: false, error: '无法定位会话工作目录' }); return }
        const url = typeof body?.url === 'string' && body.url.trim() !== '' ? body.url.trim() : undefined
        const outcome = await deps.syncOps.setup(cwd, url)
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '' })
        return
      }
      if (path === '/memory-evolve/memory-sync/sync') {
        // 同步（记忆同步 Tab）：POST { sessionId, push? }——push=true 即用户
        // 显式同意推送（需求 #12：push 永远需用户同意，UI 点击即同意）
        const body = await readBody(req)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        if (!cwd) { sendJson(res, 400, { ok: false, error: '无法定位会话工作目录' }); return }
        const outcome = await deps.syncOps.sync(cwd, body?.push === true)
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '' })
        return
      }
      if (path === '/memory-evolve/memory-sync/off') {
        // 停用同步（记忆同步 Tab）：POST { sessionId }——**项目级停用**
        // （三层开关第 2 层：PROVENANCE.enabled=false，记忆全保留），
        // 不影响全局模块开关与其他项目
        const body = await readBody(req)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        if (!cwd) { sendJson(res, 400, { ok: false, error: '无法定位会话工作目录' }); return }
        const outcome = await deps.syncOps.off(cwd)
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '' })
        return
      }
      if (path === '/memory-evolve/memory-sync/project-enabled') {
        // 项目级同步开关（三层开关第 2 层）：POST { sessionId, enabled }
        //   enabled=true → 未初始化走 setup；已初始化写 PROVENANCE.enabled=true
        //   enabled=false → 项目停用（记忆保留）
        const body = await readBody(req)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        if (!cwd) { sendJson(res, 400, { ok: false, error: '无法定位会话工作目录' }); return }
        const outcome = await deps.syncOps.setProjectEnabled(cwd, body?.enabled === true)
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '' })
        return
      }
      if (path === '/memory-evolve/memory-sync/track') {
        // 轨级开关（三层开关第 3 层）：POST { sessionId, on }——一期唯一轨=
        // 项目记忆（KEY/日志/归档）；全局轨二期独立开关
        const body = await readBody(req)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        if (!cwd) { sendJson(res, 400, { ok: false, error: '无法定位会话工作目录' }); return }
        const outcome = deps.syncOps.setTrack(cwd, body?.on === true)
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '' })
        return
      }
      if (path === '/memory-evolve/memory-sync/conflicts') {
        // 冲突列表（记忆同步 Tab）：GET ?sessionId=&fileset=
        // fileset 可选（2026-08-11 用户反馈：全局轨冲突也要能查/解决）：
        //   缺省 = project（项目轨）；memory-global/user-global/daily-global/
        //   todo-global = 全局各轨
        const sessionId = url.searchParams.get('sessionId')
        const cwd = deps.resolveCwd?.(sessionId)
        const fileset = url.searchParams.get('fileset') ?? undefined
        sendJson(res, 200, { conflicts: cwd ? deps.syncOps.conflicts(cwd, fileset) : [] })
        return
      }
      if (path === '/memory-evolve/memory-sync/resolve') {
        // 解决冲突（记忆同步 Tab）：POST { sessionId, index, choice, fileset? }
        // fileset 语义同 /conflicts（缺省 project；全局轨传 *-global）
        const body = await readBody(req)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        if (!cwd) { sendJson(res, 400, { ok: false, error: '无法定位会话工作目录' }); return }
        const index = Number(body?.index)
        const choice = String(body?.choice ?? '')
        const fileset = typeof body?.fileset === 'string' && body.fileset.trim() !== '' ? body.fileset.trim() : undefined
        if (!Number.isInteger(index) || index < 1 || !['ours', 'theirs', 'both'].includes(choice)) {
          sendJson(res, 400, { ok: false, error: 'index 必须为正整数，choice 必须为 ours/theirs/both' })
          return
        }
        const outcome = await deps.syncOps.resolve(cwd, index, choice, fileset)
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '', remaining: outcome.remaining ?? 0 })
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/memory-sync/global-status') {
        // 全局轨状态（记忆同步 Tab「全局记忆同步」区）：设备级（全局记忆
        // 仓库 = 记忆根目录 .git），返回 initialized/url/tracks/uncommitted
        const status = deps.syncOps ? deps.syncOps.globalStatus() : { initialized: false, url: '', tracks: {}, uncommitted: 0 }
        sendJson(res, 200, status)
        return
      }
      if (path === '/memory-evolve/memory-sync/global-track') {
        // 全局轨开关：POST { sessionId, track, on }——track ∈ memory/user/daily/todo
        const body = await readBody(req)
        const track = String(body?.track ?? '')
        const outcome = deps.syncOps ? deps.syncOps.setGlobalTrack(track, body?.on === true) : { kind: 'error', text: '同步模块未装配' }
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '' })
        return
      }
      if (path === '/memory-evolve/memory-sync/global-sync') {
        // 全局轨同步：POST { sessionId, push? }——push=true 即用户显式同意推送
        const body = await readBody(req)
        if (!deps.syncOps) { sendJson(res, 400, { ok: false, error: '同步模块未装配' }); return }
        const outcome = await deps.syncOps.globalSync(body?.push === true)
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '' })
        return
      }
      if (path === '/memory-evolve/memory-sync/global-remote') {
        // 启用/停用共享记忆库（设备级，「共享记忆库」子 Tab）：POST
        // { url?, enabled? }——enabled=false 停用（数据保留）；enabled=true
        // 保存地址并启用（只初始化/绑定全局记忆仓库，不碰当前项目，
        // 2026-08-11 用户拍板）
        const body = await readBody(req)
        if (!deps.syncOps) { sendJson(res, 400, { ok: false, error: '同步模块未装配' }); return }
        const outcome = await deps.syncOps.setGlobalRemote(String(body?.url ?? ''), body?.enabled !== false)
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '' })
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/api/memory-files') {
        const sessionId = url.searchParams.get('sessionId')
        const cwd = deps.resolveCwd?.(sessionId)
        sendJson(res, 200, {
          files: buildMemoryFiles(deps.config, deps.store, cwd),
          cwd: cwd ?? null,
          // Branch scope for the KEY tab: current branch + all local branches
          // ([] / null outside git — the tab then hides branch controls).
          branch: cwd ? gitBranch(cwd) ?? null : null,
          branches: cwd ? gitBranchList(cwd) : [],
        })
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/key/scope') {
        // Set the branch scope of one KEY entry from the memory tab. An
        // empty `branches` array means "全部" (the tag is removed — 全部
        // wins over any branch selection).
        const body = await readBody(req)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        if (!cwd) throw new Error('无法定位项目关键记忆：会话没有工作目录')
        const match = String(body?.match ?? '').trim()
        if (!match) throw new Error('match 不能为空')
        const rawBranches = body?.branches
        if (rawBranches !== undefined && !Array.isArray(rawBranches)) throw new Error('branches 必须是字符串数组')
        const branches = (rawBranches ?? []).map((b) => String(b).trim()).filter((b) => b.length > 0)
        const outcome = store.setEntryBranches('key', match, branches, { session: { header: { cwd } } })
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/memory/key') {
        // Manual project-KEY write from the memory tab: the user types a
        // durable project fact and the host stamps + appends it to the
        // project's KEY.md. The next snapshot render picks it up (the key
        // track is injected with live reads), so the fact reaches the model
        // context automatically. Optional `branches` (string[]; [] = 全部)
        // scopes the entry to specific git branches; optional `dshOnly`
        // (boolean) tags it with [dsh-only] — the entry then only reaches
        // DSH sessions, external executors (COI injection) skip it.
        const body = await readBody(req)
        const content = String(body?.content ?? '').trim()
        if (!content) throw new Error('内容不能为空')
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        if (!cwd) throw new Error('无法定位项目关键记忆：会话没有工作目录')
        const rawBranches = body?.branches
        if (rawBranches !== undefined && !Array.isArray(rawBranches)) throw new Error('branches 必须是字符串数组')
        const branches = (rawBranches ?? []).map((b) => String(b).trim()).filter((b) => b.length > 0)
        // 前缀顺序与 setEntryDshOnly 的插入规则一致：branch 在前、[dsh-only] 在后
        const dshOnly = body?.dshOnly === true
        let finalContent = content
        if (branches.length > 0) finalContent = `[branch:${branches.join(',')}] ${finalContent}`
        if (dshOnly) finalContent = `[dsh-only] ${finalContent}`
        const outcome = store.add('key', finalContent, { session: { header: { cwd } } })
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/memory/delete') {
        // Per-entry delete from the memory tab's pretty view. The UI sends
        // the FULL entry text (with its stamp) as `match`, and the host
        // deletes by exact whole-entry equality (removeExact) — never a
        // substring match, so deleting a short entry cannot wipe a longer
        // one that merely contains it. Archive rows map onto their track.
        const body = await readBody(req)
        const target = String(body?.target ?? '')
        const match = String(body?.match ?? '').trim()
        if (!match) throw new Error('match 不能为空')
        const ARCHIVE = { 'archive-memory': 'memory', 'archive-user': 'user', 'archive-key': 'key' }
        const TRACKS = new Set(['memory', 'user', 'daily', 'project', 'key', ...Object.keys(ARCHIVE)])
        if (!TRACKS.has(target)) throw new Error(`无效的记忆轨 "${target}"`)
        let outcome
        if (target in ARCHIVE) {
          const cwd = ARCHIVE[target] === 'key' ? resolveSessionCwd(body, deps) : undefined
          outcome = archive.removeExact(ARCHIVE[target], match, cwd)
        } else {
          const sessionId = String(body?.sessionId ?? '')
          const cwd = deps.resolveCwd?.(sessionId)
          const agent = cwd ? { session: { header: { cwd } } } : undefined
          if ((target === 'project' || target === 'key') && !cwd) {
            throw new Error('无法定位项目记忆：会话没有工作目录')
          }
          outcome = store.removeExact(target, match, agent)
        }
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/memory/update') {
        // Per-entry content edit from the memory tab's pretty view. The UI
        // sends the FULL entry text (with its stamp) as `match` — the host
        // locates it by exact whole-entry equality and rewrites only the
        // body, preserving the timestamp and every tag (git branch, branch
        // scope, daily project tag). The delimiter § is rejected, so the
        // §-split format can never be broken by an edit.
        const body = await readBody(req)
        const target = String(body?.target ?? '')
        const match = String(body?.match ?? '').trim()
        const content = String(body?.content ?? '')
        if (!match) throw new Error('match 不能为空')
        if (!content.trim()) throw new Error('内容不能为空')
        const TRACKS = new Set(['memory', 'user', 'daily', 'project', 'key'])
        if (!TRACKS.has(target)) throw new Error(`无效的记忆轨 "${target}"`)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        const agent = cwd ? { session: { header: { cwd } } } : undefined
        if ((target === 'project' || target === 'key') && !cwd) {
          throw new Error('无法定位项目记忆：会话没有工作目录')
        }
        const outcome = store.updateEntryContent(target, match, content, agent)
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/memory/dsh-only') {
        // 给一条目打/取消「仅 DSH」标记（[dsh-only]）：标记的条目仍注入 DSH
        // 自身会话，但注入外部执行器（COI 任务的 injectTracks 记忆注入）时
        // 整条跳过——用于存放只对 DSH 有意义的纪律/规则/架构类事实。整条
        // 精确匹配（同 /api/memory/update），memory/user/key 三轨可用。
        const body = await readBody(req)
        const target = String(body?.target ?? '')
        const match = String(body?.match ?? '').trim()
        const on = body?.on !== false
        if (!match) throw new Error('match 不能为空')
        if (target !== 'memory' && target !== 'user' && target !== 'key') {
          throw new Error('target 必须是 memory / user / key')
        }
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        const agent = cwd ? { session: { header: { cwd } } } : undefined
        if (target === 'key' && !cwd) throw new Error('无法定位项目关键记忆：会话没有工作目录')
        const outcome = store.setEntryDshOnly(target, match, on, agent)
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/memory/archive') {
        // Archive a main-track entry from the memory tab: the entry is
        // removed from MEMORY.md / USER.md / KEY.md by exact whole-entry
        // match and appended verbatim to the matching archive file.
        // Reversible — the archive tab can promote it back with
        // POST /api/archive/promote. Order: append to the archive FIRST,
        // then remove from the main track — a failed archive write must
        // never leave the entry deleted (data loss); a failed removal (the
        // entry was concurrently archived/deleted elsewhere) leaves one
        // extra archive entry the user can clean up manually, which is
        // recoverable. Trade-off: duplicates over data loss.
        const body = await readBody(req)
        const target = String(body?.target ?? '')
        const match = String(body?.match ?? '').trim()
        if (target !== 'memory' && target !== 'user' && target !== 'key') throw new Error('target 必须是 memory / user / key')
        if (!match) throw new Error('match 不能为空')
        const cwd = target === 'key' ? resolveSessionCwd(body, deps) : undefined
        const agent = cwd ? { session: { header: { cwd } } } : undefined
        // 先校验目标条目确实整条存在于主轨（read-only）——无效请求（子串、
        // 已删除条目）绝不把垃圾内容写进归档文件
        const peeked = store.peekExact(target, match, agent)
        if (!peeked.ok) throw new Error(peeked.message)
        const appended = archive.append(target, peeked.entry, cwd)
        if (!appended.ok) throw new Error(`归档写入失败：${appended.message ?? '未知错误'}（主轨条目未动，可重试）`)
        const outcome = store.removeExact(target, match, agent)
        if (!outcome.ok) {
          throw new Error(`已写入归档（现有 ${appended.total} 条）但主轨删除失败：${outcome.message}——归档里多出的那条可在归档页手动清理`)
        }
        sendJson(res, 200, { ok: true, message: `已归档（${target}：归档文件现有 ${appended.total} 条；${outcome.message}）` })
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/api/todo') {
        // Todo list for the 待办 sub-tab. `target` optional (default all
        // four tracks); `all=1` shows everything (the tab defaults to the
        // smart view like the dtodo tool); `past=1` also reads the daily
        // track's files from earlier days, `expired=1` includes the expired
        // past leftovers (default: filtered out). sessionId resolves cwd.
        const sessionId = url.searchParams.get('sessionId')
        const cwd = deps.resolveCwd?.(sessionId)
        const target = url.searchParams.get('target') || undefined
        const targets = target !== undefined ? [target] : ['life', 'work', 'project', 'daily']
        const date = url.searchParams.get('date') || undefined
        const result = todoStore.listTodos(targets, {
          status: url.searchParams.get('status') || undefined,
          quadrant: url.searchParams.get('quadrant') || undefined,
          due: url.searchParams.get('due') || undefined,
          cat: url.searchParams.get('cat') || undefined,
          all: url.searchParams.get('all') === '1',
          past: url.searchParams.get('past') === '1',
          expired: url.searchParams.get('expired') === '1',
          date,
        }, cwd ?? undefined, date ?? undefined)
        sendJson(res, 200, {
          items: result.items,
          total: result.total,
          truncated: result.truncated,
          defaultView: result.defaultView,
          cwd: cwd ?? null,
        })
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/todo') {
        // Todo mutations from the 待办 sub-tab (user is the confirmer: direct
        // writes). Actions: add / done / update / remove.
        const body = await readBody(req)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        const action = String(body?.action ?? '')
        const target = typeof body?.target === 'string' && body.target !== '' ? body.target : undefined
        if (action === 'add') {
          const track = target ?? (cwd ? 'project' : 'work')
          if (!['life', 'work', 'project', 'daily'].includes(track)) throw new Error(`无效 target "${track}"`)
          const due = typeof body?.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.due) ? body.due : undefined
          const quadrant = typeof body?.quadrant === 'string' && /^q[1-4]$/.test(body.quadrant) ? body.quadrant : undefined
          const cat = typeof body?.cat === 'string' && body.cat.trim() !== '' ? body.cat.trim() : undefined
          const outcome = todoStore.addTodo(track, String(body?.content ?? ''), { quadrant, due, cat }, cwd)
          if (!outcome.ok) throw new Error(outcome.message)
          sendJson(res, 200, outcome)
          return
        }
        const id = String(body?.id ?? '').trim()
        if (!id) throw new Error('id 不能为空')
        const date = typeof body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : undefined
        if (action === 'done') {
          const outcome = todoStore.doneTodo(target, id, cwd, date)
          if (!outcome.ok) throw new Error(outcome.message)
          sendJson(res, 200, outcome)
          return
        }
        if (action === 'remove') {
          const outcome = todoStore.removeTodo(target, id, cwd, date)
          if (!outcome.ok) throw new Error(outcome.message)
          sendJson(res, 200, outcome)
          return
        }
        if (action === 'update') {
          const patch = {}
          if (body?.status !== undefined) patch.status = String(body.status)
          if (body?.quadrant !== undefined) patch.quadrant = String(body.quadrant)
          if (body?.due !== undefined) patch.due = String(body.due)
          if (body?.cat !== undefined) patch.cat = String(body.cat)
          if (body?.content !== undefined) patch.content = String(body.content)
          const outcome = todoStore.updateTodo(target, id, patch, cwd, date)
          if (!outcome.ok) throw new Error(outcome.message)
          sendJson(res, 200, outcome)
          return
        }
        throw new Error(`未知操作 "${action}"（应为 add / done / update / remove）`)
      }
      if (req.method === 'GET' && path === '/memory-evolve/api/pending-skills') {
        sendJson(res, 200, { entries: listPendingSkills(pendingSkillDir(deps)) })
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/pending-skills/approve') {
        const body = await readBody(req)
        const name = String(body?.name ?? '').trim()
        const outcome = approvePendingSkill(pendingSkillDir(deps), deps.config.skillDir, name)
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/pending-skills/reject') {
        const body = await readBody(req)
        const name = String(body?.name ?? '').trim()
        const outcome = rejectPendingSkill(pendingSkillDir(deps), name)
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      // ---- 模型设置模块（lib/models.js）：表格数据 + 配置更新 ----
      // GET /api/models：聚合快照（供应商 + 模型 + 思考等级 + enabled/备注），
      // 供「模型设置」Tab 渲染；enabledOnly=1 只返回启用的模型（外部查询用）。
      // 模块未启用（modelsEnabled=false）时拒绝访问（store 为 null）。
      if (req.method === 'GET' && path === '/memory-evolve/api/models') {
        if (deps.modelsStore === null) throw new Error('模型设置模块未启用（请在「设置」Tab 的「配置」里打开「模型设置」开关）')
        const snapshot = await deps.buildModelsSnapshot()
        if (url.searchParams.get('enabledOnly') === '1') {
          for (const p of snapshot.providers) {
            p.models = p.models.filter((m) => m.enabled)
          }
        }
        sendJson(res, 200, snapshot)
        return
      }
      // POST /api/models/update { provider, model, patch }：更新一个模型的
      // 插件配置（enabled / thinking / note / reasoning.enabled 白名单 /
      // reasoning.recommended / reasoning.custom）。返回规范化后的 entry
      // （全空配置被删除时 entry 为 null）。
      if (req.method === 'POST' && path === '/memory-evolve/api/models/update') {
        if (deps.modelsStore === null) throw new Error('模型设置模块未启用（请在「设置」Tab 的「配置」里打开「模型设置」开关）')
        const body = await readBody(req)
        const provider = String(body?.provider ?? '').trim()
        const model = String(body?.model ?? '').trim()
        if (provider === '') throw new Error('provider 不能为空')
        if (model === '') throw new Error('model 不能为空')
        const patch = normalizeModelsPatch(body?.patch)
        const entry = deps.modelsStore.update(provider, model, patch)
        sendJson(res, 200, { ok: true, entry: entry ?? null })
        return
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 400, { error: error?.message ?? String(error) })
    }
  }

  return ctx.webServer.register({ kind: 'prefix', path: '/memory-evolve', handler })
}
