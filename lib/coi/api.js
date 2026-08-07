/**
 * COI Web API — GUI 数据面（前缀 /memory-evolve/api/coi）。
 *
 * 路由：
 *   GET    /coi/adapters                    → { adapters }（含内置指南）
 *   POST   /coi/adapters   { def }          → 新增/覆盖适配器
 *   DELETE /coi/adapters/:id                → 删除自定义适配器
 *   POST   /coi/adapters/test { id }        → 适配器测试（一次性任务）
 *   GET    /coi/tasks?adapterId&scope&cwd&branch&status&q&limit
 *   POST   /coi/tasks     { dispatch 参数 } → 发起任务
 *   GET    /coi/tasks/:id                   → 任务详情
 *   GET    /coi/tasks/:id/log?tail=         → 任务输出（留档）
 *   POST   /coi/tasks/:id/cancel { force }  → 终止（无 force 仅返回确认提示）
 *   POST   /coi/tasks/:id/retry             → 一键重试
 *   GET    /coi/sessions?scope&branch&q&cwd&adapterId
 *   POST   /coi/sessions/note { id, note }  → 会话备注
 *   DELETE /coi/sessions/:id                → 删除会话记录
 *   GET    /coi/stats                       → 用量统计
 *   GET    /coi/templates                   → 模板列表
 *   POST   /coi/templates { def }           → 新增/覆盖模板
 *   DELETE /coi/templates/:id               → 删除模板
 *   GET    /coi/config                      → 运行时配置
 *   POST   /coi/config  { patch }           → 更新运行时配置
 *   POST   /coi/export  { sessionId, adapterId? } → 会话导出（后台）
 */
import { URL } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Read the JSON request body (capped). */
async function readBody(req, maxBytes = 256 * 1024) {
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

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/**
 * @param {object} ctx - web context（含 httpServer）。
 * @param {object} svc - { scheduler, sessions, adapters, templates, tasks, config, runtimeConfig, updateRuntimeConfig, resolveCwd }
 */
export function installCoiApi(ctx, svc) {
  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const segments = path.split('/').filter(Boolean) // [memory-evolve, api, coi, ...]
    const base = '/memory-evolve/api/coi'
    try {
      if (req.method === 'GET' && path === `${base}/adapters`) {
        return sendJson(res, 200, { adapters: svc.adapters.list() })
      }
      if (req.method === 'POST' && path === `${base}/adapters`) {
        const body = await readBody(req)
        const adapter = svc.adapters.upsert(body.def ?? body)
        // 可选：同时提供技能内容 → 技能文件不存在时自动创建（AI 使用指南）
        let skillMessage = null
        if (adapter.skillName && typeof body.skillContent === 'string' && body.skillContent.trim() !== '') {
          const file = join(svc.config.skillDir ?? '', adapter.skillName, 'SKILL.md')
          if (existsSync(file)) {
            skillMessage = `技能 ${adapter.skillName} 已存在，内容未改动（可在适配器页「技能」按钮编辑）`
          } else {
            try {
              const { normalizeSkillText } = await import('./skills-sync.js')
              const text = normalizeSkillText(body.skillContent, adapter.skillName, adapter.name)
              mkdirSync(join(svc.config.skillDir ?? '', adapter.skillName), { recursive: true })
              writeFileSync(file, text)
              skillMessage = `技能 ${adapter.skillName} 已自动创建（AI 可见，技能管理 Tab 可禁用）`
            } catch (error) {
              skillMessage = `技能创建失败：${error.message}`
            }
          }
        }
        return sendJson(res, 200, { ok: true, adapter, skillMessage })
      }
      if (req.method === 'DELETE' && segments.length === 5 && segments[2] === 'coi' && segments[3] === 'adapters') {
        const ok = svc.adapters.remove(segments[4])
        return sendJson(res, 200, ok ? { ok: true } : { ok: false, message: '内置适配器不可删除' })
      }
      if (req.method === 'POST' && segments.length === 6 && segments[2] === 'coi' && segments[3] === 'adapters' && segments[5] === 'enabled') {
        // 路径 /coi/adapters/:id/enabled → segments=[memory-evolve,api,coi,adapters,id,enabled] 共 6 段
        const adapterId = decodeURIComponent(segments[4])
        const body = await readBody(req)
        const result = svc.adapters.setEnabled(adapterId, body.enabled)
        return sendJson(res, result.ok ? 200 : 400, result)
      }
      if (req.method === 'POST' && path === `${base}/adapters/test`) {
        const body = await readBody(req)
        const result = svc.scheduler.testAdapter(body.id)
        return sendJson(res, result.ok ? 200 : 400, result)
      }
      if (req.method === 'GET' && segments.length === 6 && segments[2] === 'coi' && segments[3] === 'adapters' && segments[5] === 'skill') {
        const adapterId = decodeURIComponent(segments[4])
        const result = svc.readSkill?.(adapterId) ?? { ok: false, message: '技能读写不可用' }
        return sendJson(res, result.ok ? 200 : 404, result)
      }
      if (req.method === 'PUT' && segments.length === 6 && segments[2] === 'coi' && segments[3] === 'adapters' && segments[5] === 'skill') {
        const adapterId = decodeURIComponent(segments[4])
        const body = await readBody(req)
        const result = svc.writeSkill?.(adapterId, body.content) ?? { ok: false, message: '技能读写不可用' }
        return sendJson(res, result.ok ? 200 : 400, result)
      }
      if (req.method === 'GET' && path === `${base}/tasks`) {
        // 可见性：sessionId 提供时按层级过滤（临时/会话=本会话；项目=本会话 cwd）
        const sessionId = url.searchParams.get('sessionId') ?? undefined
        const tasks = svc.tasks.list({
          adapterId: url.searchParams.get('adapterId') ?? undefined,
          scope: url.searchParams.get('scope') ?? undefined,
          cwd: url.searchParams.get('cwd') ?? undefined,
          branch: url.searchParams.get('branch') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
          q: url.searchParams.get('q') ?? undefined,
          limit: Number(url.searchParams.get('limit') ?? 200),
          ownerSessionId: sessionId,
          sessionCwd: sessionId ? svc.resolveCwd?.(sessionId) : undefined,
        })
        return sendJson(res, 200, { tasks })
      }
      if (req.method === 'POST' && path === `${base}/tasks`) {
        const body = await readBody(req)
        const cwd = body.cwd ?? svc.resolveCwd?.(body.dsSessionId ?? '')
        const result = svc.scheduler.dispatch({
          adapterId: body.adapterId,
          prompt: body.prompt,
          scope: body.scope,
          cwd,
          branch: body.branch,
          sessionId: body.sessionId,
          model: body.model,
          refTaskId: body.refTaskId,
          templateId: body.templateId,
          ownerSessionId: body.dsSessionId ?? undefined,
          ownerCwd: body.dsSessionId ? svc.resolveCwd?.(body.dsSessionId) : undefined, // 发起会话工作目录（项目层级可见性）
          injectTracks: body.injectTracks,
          contextText: body.contextText,
        })
        return sendJson(res, result.ok ? 200 : 400, result)
      }
      if (req.method === 'POST' && path === `${base}/tasks/relay`) {
        const body = await readBody(req)
        const cwd = body.cwd ?? svc.resolveCwd?.(body.dsSessionId ?? '')
        const result = svc.scheduler.dispatch({
          adapterId: body.adapterId,
          prompt: body.prompt,
          scope: body.scope,
          cwd,
          branch: body.branch,
          sessionId: body.sessionId,
          model: body.model,
          refTaskId: body.refTaskId, // 接力源任务（前端 CoIView 以 refTaskId 字段提交；原 ?? body.refTaskId 是自引用笔误，P1-2）
          ownerSessionId: body.dsSessionId ?? undefined,
          ownerCwd: body.dsSessionId ? svc.resolveCwd?.(body.dsSessionId) : undefined, // 发起会话工作目录（项目层级可见性）
          injectTracks: body.injectTracks,
          contextText: body.contextText,
        })
        return sendJson(res, result.ok ? 200 : 400, result)
      }
      if (req.method === 'GET' && segments.length === 5 && segments[2] === 'coi' && segments[3] === 'tasks') {
        const taskId = decodeURIComponent(segments[4])
        const result = svc.scheduler.status(taskId)
        return sendJson(res, result.ok ? 200 : 404, result)
      }
      if (req.method === 'GET' && segments.length === 6 && segments[2] === 'coi' && segments[3] === 'tasks' && segments[5] === 'log') {
        const taskId = decodeURIComponent(segments[4])
        const tail = Number(url.searchParams.get('tail') ?? 0)
        const result = svc.scheduler.getLog(taskId, tail > 0 ? tail : undefined)
        return sendJson(res, result.ok ? 200 : 404, result)
      }
      if (req.method === 'POST' && segments.length === 6 && segments[2] === 'coi' && segments[3] === 'tasks' && segments[5] === 'cancel') {
        const taskId = decodeURIComponent(segments[4])
        const body = await readBody(req)
        const result = svc.scheduler.cancel(taskId, { force: body.force === true })
        return sendJson(res, result.ok ? 200 : 400, result)
      }
      if (req.method === 'POST' && segments.length === 6 && segments[2] === 'coi' && segments[3] === 'tasks' && segments[5] === 'retry') {
        const taskId = decodeURIComponent(segments[4])
        const result = svc.scheduler.retry(taskId)
        return sendJson(res, result.ok ? 200 : 400, result)
      }
      if (req.method === 'DELETE' && segments.length === 5 && segments[2] === 'coi' && segments[3] === 'tasks') {
        const taskId = decodeURIComponent(segments[4])
        const result = svc.tasks.remove(taskId)
        return sendJson(res, result.ok ? 200 : 400, result)
      }
      if (req.method === 'GET' && path === `${base}/sessions`) {
        const sessionId = url.searchParams.get('sessionId') ?? undefined
        const sessions = svc.sessions.list({
          scope: url.searchParams.get('scope') ?? undefined,
          cwd: url.searchParams.get('cwd') ?? undefined,
          branch: url.searchParams.get('branch') ?? undefined,
          adapterId: url.searchParams.get('adapterId') ?? undefined,
          q: url.searchParams.get('q') ?? undefined,
          ownerSessionId: sessionId,
          sessionCwd: sessionId ? svc.resolveCwd?.(sessionId) : undefined,
        })
        return sendJson(res, 200, { sessions })
      }
      if (req.method === 'POST' && path === `${base}/sessions/note`) {
        const body = await readBody(req)
        const result = svc.sessions.updateNote(body.id, body.note)
        return sendJson(res, result.ok ? 200 : 400, result)
      }
      if (req.method === 'DELETE' && segments.length === 5 && segments[2] === 'coi' && segments[3] === 'sessions') {
        const id = decodeURIComponent(segments[4])
        const result = svc.sessions.remove(id)
        return sendJson(res, result.ok ? 200 : 404, result)
      }
      if (req.method === 'GET' && path === `${base}/stats`) {
        const { coiStats } = await import('./stats.js')
        return sendJson(res, 200, coiStats(svc.tasks))
      }
      if (req.method === 'GET' && path === `${base}/templates`) {
        return sendJson(res, 200, { templates: svc.templates.list() })
      }
      if (req.method === 'POST' && path === `${base}/templates`) {
        const body = await readBody(req)
        try {
          const template = svc.templates.upsert(body.def ?? body)
          return sendJson(res, 200, { ok: true, template })
        } catch (error) {
          return sendJson(res, 400, { ok: false, message: error.message })
        }
      }
      if (req.method === 'DELETE' && segments.length === 5 && segments[2] === 'coi' && segments[3] === 'templates') {
        const id = decodeURIComponent(segments[4])
        const ok = svc.templates.remove(id)
        return sendJson(res, ok ? 200 : 404, { ok })
      }
      if (req.method === 'GET' && path === `${base}/config`) {
        return sendJson(res, 200, { config: svc.runtimeConfig() })
      }
      if (req.method === 'POST' && path === `${base}/config`) {
        const body = await readBody(req)
        const result = svc.updateRuntimeConfig(body.patch ?? body)
        return sendJson(res, result.ok ? 200 : 400, result)
      }
      if (req.method === 'POST' && path === `${base}/export`) {
        const body = await readBody(req)
        const adapterId = body.adapterId ?? 'grok'
        const adapter = svc.adapters.get(adapterId)
        if (!adapter) return sendJson(res, 400, { ok: false, message: `未知适配器 ${adapterId}` })
        const cmd = adapter.mgmtCmds?.export
        if (!cmd) return sendJson(res, 400, { ok: false, message: `适配器 ${adapterId} 不支持会话导出` })
        const outDir = join(svc.config.coiDataDir, 'exports')
        mkdirSync(outDir, { recursive: true })
        const safeId = String(body.sessionId ?? '').replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 24)
        if (!safeId) return sendJson(res, 400, { ok: false, message: 'sessionId 不能为空' })
        const outFile = join(outDir, `${adapterId}-${safeId}.log`)
        // 加固（P2-4）：导出子进程加 unref（不阻止 DSH 退出）、60s 兜底
        // 超时（挂住就强杀）、输出 64MB 上限（防 chunks 无限吃内存）
        const child = spawn(adapter.binary, [...cmd, body.sessionId], { stdio: ['ignore', 'pipe', 'pipe'] })
        child.unref?.()
        const chunks = []
        const MAX_EXPORT_BYTES = 64 * 1024 * 1024
        const exportTimer = setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* 已退出 */ }
        }, 60000)
        exportTimer.unref?.()
        const guard = (c) => {
          chunks.push(c)
          if (Buffer.concat(chunks).length > MAX_EXPORT_BYTES) {
            try { child.kill('SIGKILL') } catch { /* 已退出 */ }
          }
        }
        child.stdout.on('data', guard)
        child.stderr.on('data', guard)
        child.on('close', () => {
          clearTimeout(exportTimer)
          try { writeFileSync(outFile, Buffer.concat(chunks).toString()) } catch { /* 忽略 */ }
        })
        return sendJson(res, 200, { ok: true, message: `导出任务已启动，输出将写入 ${outFile}` })
      }
      return sendJson(res, 404, { ok: false, message: `未知路由 ${path}` })
    } catch (error) {
      return sendJson(res, 400, { ok: false, message: error?.message ?? String(error) })
    }
  }
  return ctx.httpServer.register({ kind: 'prefix', path: '/memory-evolve/api/coi', handler })
}
