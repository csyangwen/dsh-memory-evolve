/**
 * COI slash 命令 — /de_coi 族（de_ 前缀防冲突）。
 *
 * 子命令：run / list / log / stop / sessions / adapters / stats / templates / export / help
 * 终止确认：/de_coi stop <id> 需要 --force 二次确认；--all 更严格（需 --force --all）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 简易 tokenizer：支持双引号包裹的参数。 */
function tokenize(input) {
  const tokens = []
  let current = ''
  let inQuote = false
  for (const ch of String(input)) {
    if (ch === '"') {
      inQuote = !inQuote
      continue
    }
    if (ch === ' ' && !inQuote) {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current !== '') tokens.push(current)
  return tokens
}

/** 简易选项解析：--key value 与 --flag（布尔）。 */
function parseOpts(tokens, flagNames) {
  const opts = {}
  const positional = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.startsWith('--')) {
      const name = token.slice(2)
      if (flagNames.includes(name)) {
        opts[name] = true
      } else {
        opts[name] = tokens[i + 1]
        i += 1
      }
    } else {
      positional.push(token)
    }
  }
  return { opts, positional }
}

/**
 * @param {object} svc - { scheduler, sessions, adapters, templates, tasks, config }
 * @returns {object} CommandDefinition（注册名 de_coi）。
 */
export function coiCommand(svc) {
  return {
    name: 'de_coi',
    description: 'COI 调度：派任务给外部 CLI 代理（kimi/codex/grok/hermes 等）、看进度、管会话。子命令：run / list / log / stop / sessions / adapters / stats / templates / export / help',
    input: { hint: 'run|list|log|stop|sessions|adapters|stats|templates|export|help …（--help 看详情）' },
    async handler(invocation) {
      const { rawInput } = invocation
      const [sub, ...rest] = tokenize(rawInput)
      try {
        return await handle(svc, sub ?? 'help', rest, invocation)
      } catch (error) {
        return { kind: 'error', text: `de_coi: ${error?.message ?? String(error)}` }
      }
    },
  }
}

async function handle(svc, sub, rest, invocation) {
  switch (sub) {
    case 'run': {
      // --inject-tracks 是带值选项（逗号分隔的注入轨），不列入 flagNames
      const { opts, positional } = parseOpts(rest, ['continue', 'all'])
      const prompt = positional.join(' ')
      if (!prompt && !opts.template) return { kind: 'error', text: '用法：/de_coi run "<任务>" [--coi kimi] [--scope session] [--session <id>] [--branch <b>] [--model <m>] [--ref <taskId>] [--template <id>] [--continue] [--inject-tracks memory,user,key] [--context-text <文本>]' }
      const result = svc.scheduler.dispatch({
        adapterId: opts.coi ?? 'kimi',
        prompt,
        scope: opts.scope,
        cwd: opts.cwd,
        branch: opts.branch,
        sessionId: opts.session,
        model: opts.model,
        refTaskId: opts.ref,
        templateId: opts.template,
        continueLast: opts.continue,
        ownerSessionId: invocation?.agent?.session?.id ?? undefined,
        ownerCwd: invocation?.agent?.session?.header?.cwd ?? undefined, // 发起会话工作目录（项目层级可见性）
        injectTracks: opts['inject-tracks']
          ? String(opts['inject-tracks']).split(',').map((s) => s.trim()).filter((s) => s !== '')
          : undefined,
        contextText: opts['context-text'],
      })
      return result.ok
        ? { kind: 'success', text: `✅ ${result.message}\n查看进度：/de_coi log ${result.taskId}` }
        : { kind: 'error', text: result.message }
    }
    case 'list': {
      const { opts } = parseOpts(rest, [])
      const tasks = svc.tasks.list({
        adapterId: opts.coi,
        status: opts.status,
        cwd: opts.cwd,
        q: opts.q,
        limit: Number(opts.limit ?? 15),
      })
      if (tasks.length === 0) return { kind: 'success', text: '（暂无任务）' }
      const lines = tasks.map((t) => {
        const when = new Date(t.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        const mark = { running: '⏳', completed: '✅', failed: '❌', killed: '🛑', interrupted: '⚠️', queued: '⏸️' }[t.status] ?? '·'
        return `${mark} ${t.id} [${t.adapterId}] ${t.status} ${when} ${String(t.prompt ?? '').slice(0, 40)}`
      })
      return { kind: 'success', text: `任务（${tasks.length} 条）：\n${lines.join('\n')}` }
    }
    case 'log': {
      const { opts, positional } = parseOpts(rest, [])
      const taskId = positional[0]
      if (!taskId) return { kind: 'error', text: '用法：/de_coi log <taskId> [--tail <字符数>]' }
      const result = svc.scheduler.getLog(taskId, Number(opts.tail ?? 4000))
      if (!result.ok) return { kind: 'error', text: result.message }
      return { kind: 'success', text: result.text.slice(-(Number(opts.tail ?? 4000))) || '（无输出）' }
    }
    case 'stop': {
      const { opts, positional } = parseOpts(rest, ['force', 'all', 'yes'])
      const taskId = positional[0]
      if (!taskId) return { kind: 'error', text: '用法：/de_coi stop <taskId> [--force]（终止需二次确认；--all 需同时带 --force）' }
      if (taskId === '--all') {
        if (!opts.force) return { kind: 'error', text: '⚠️ 终止全部任务需二次确认：/de_coi stop --all --force' }
        const running = svc.tasks.list({ status: 'running' }).filter((t) => svc.scheduler.status(t.id).task?.status === 'running')
        for (const t of running) svc.scheduler.cancel(t.id, { force: true })
        return { kind: 'success', text: `已终止 ${running.length} 个任务` }
      }
      if (!opts.force && !opts.yes) {
        const info = svc.scheduler.status(taskId)
        const task = info.task
        if (!task) return { kind: 'error', text: info.message }
        return { kind: 'error', text: `⚠️ 确认终止任务 ${taskId}（${task.coi}：${String(task.prompt ?? '').slice(0, 60)}）？确认请再次执行：/de_coi stop ${taskId} --force` }
      }
      const result = svc.scheduler.cancel(taskId, { force: true })
      return result.ok ? { kind: 'success', text: result.message } : { kind: 'error', text: result.message }
    }
    case 'sessions': {
      const { opts, positional } = parseOpts(rest, [])
      const action = positional[0] ?? 'list'
      if (action === 'list') {
        const sessions = svc.sessions.list({ scope: opts.scope, branch: opts.branch, q: opts.q, adapterId: opts.coi })
        if (sessions.length === 0) return { kind: 'success', text: '（暂无会话记录）' }
        const lines = sessions.slice(0, Number(opts.limit ?? 20)).map((s) => {
          const lock = s.activeTaskId ? ` [占用:${s.activeTaskId}]` : ''
          return `${s.id} [${s.adapterId}] ${s.scope}${s.branch ? ` @${s.branch}` : ''}${s.note ? ` "${s.note}"` : ''}${lock}`
        })
        return { kind: 'success', text: `会话（${sessions.length} 条）：\n${lines.join('\n')}` }
      }
      if (action === 'note') {
        const id = positional[1]
        const note = positional.slice(2).join(' ')
        if (!id || !note) return { kind: 'error', text: '用法：/de_coi sessions note <sessionId> <备注>' }
        const result = svc.sessions.updateNote(id, note)
        return result.ok ? { kind: 'success', text: result.message } : { kind: 'error', text: result.message }
      }
      if (action === 'rm' || action === 'remove') {
        const id = positional[1]
        if (!id) return { kind: 'error', text: '用法：/de_coi sessions rm <sessionId>' }
        const result = svc.sessions.remove(id)
        return result.ok ? { kind: 'success', text: result.message } : { kind: 'error', text: result.message }
      }
      return { kind: 'error', text: 'sessions 子命令：list / note <id> <备注> / rm <id>' }
    }
    case 'adapters': {
      const { positional } = parseOpts(rest, [])
      const action = positional[0] ?? 'list'
      if (action === 'list') {
        const adapters = svc.adapters.list()
        return {
          kind: 'success',
          text: adapters.map((a) => `${a.enabled === false ? '⛔' : '✅'} ${a.id} — ${a.name}（${a.type === 'ai-cli' ? 'AI CLI，可恢复会话' : '普通 CLI'}）${a.useCase ? `：${a.useCase}` : ''}${a.enabled === false ? ' [已禁用]' : ''}`).join('\n'),
        }
      }
      if (action === 'show') {
        const adapter = svc.adapters.get(positional[1])
        if (!adapter) return { kind: 'error', text: `未知适配器 ${positional[1]}` }
        return { kind: 'success', text: `${adapter.id} — ${adapter.name}\n类型：${adapter.type}\n命令：${adapter.binary} ${adapter.args.join(' ')}\n${adapter.guide ? `\n指南：\n${adapter.guide}` : ''}` }
      }
      if (action === 'test') {
        const result = svc.scheduler.testAdapter(positional[1])
        return result.ok ? { kind: 'success', text: result.message } : { kind: 'error', text: result.message }
      }
      if (action === 'enable' || action === 'disable') {
        const result = svc.adapters.setEnabled(positional[1], action === 'enable')
        return result.ok ? { kind: 'success', text: result.message } : { kind: 'error', text: result.message }
      }
      return { kind: 'error', text: 'adapters 子命令：list / show <id> / test <id> / enable <id> / disable <id>' }
    }
    case 'stats': {
      const { coiStats } = await import('./stats.js')
      const stats = coiStats(svc.tasks)
      const lines = [`总任务数：${stats.total}`]
      for (const [id, s] of Object.entries(stats.byAdapter)) {
        const hours = (s.totalMs / 3600000).toFixed(1)
        lines.push(`  ${id}: ${s.count} 次，累计 ${hours} 小时（${Object.entries(s.byStatus).map(([k, v]) => `${k}:${v}`).join('，')}）`)
      }
      return { kind: 'success', text: lines.join('\n') }
    }
    case 'templates': {
      const { positional } = parseOpts(rest, [])
      const action = positional[0] ?? 'list'
      if (action === 'list') {
        const templates = svc.templates.list()
        return { kind: 'success', text: templates.length === 0 ? '（暂无模板）' : templates.map((t) => `${t.id} — ${t.name}${t.adapterId ? ` [${t.adapterId}]` : ''}\n    ${t.prompt.slice(0, 60)}`).join('\n') }
      }
      return { kind: 'error', text: 'templates 子命令：list' }
    }
    case 'export': {
      const { opts, positional } = parseOpts(rest, [])
      const sessionId = positional[0]
      if (!sessionId) return { kind: 'error', text: '用法：/de_coi export <sessionId> [--coi kimi]' }
      const adapterId = opts.coi ?? 'grok'
      const adapter = svc.adapters.get(adapterId)
      if (!adapter) return { kind: 'error', text: `未知适配器 ${adapterId}` }
      const cmd = adapter.mgmtCmds?.export
      if (!cmd) return { kind: 'error', text: `适配器 ${adapterId} 不支持会话导出` }
      const outDir = join(svc.config.coiDataDir, 'exports')
      mkdirSync(outDir, { recursive: true })
      const outFile = join(outDir, `${adapterId}-${sessionId.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 24)}.log`)
      // 加固（P2-4）：与 web export 端点同款——unref + 60s 兜底超时 +
      // 输出 64MB 上限，防导出进程挂住/无限吃内存
      const child = spawn(adapter.binary, [...cmd, sessionId], { stdio: ['ignore', 'pipe', 'pipe'] })
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
      child.on('close', (code) => {
        clearTimeout(exportTimer)
        writeFileSync(outFile, Buffer.concat(chunks).toString())
      })
      return { kind: 'success', text: `导出任务已启动（${adapter.binary} ${cmd.join(' ')} ${sessionId}），完成后输出在 ${outFile}` }
    }
    case 'help':
    default:
      return {
        kind: 'success',
        text: `de_coi — COI 调度命令族
  /de_coi run "<任务>" [--coi kimi|codex|grok|hermes] [--scope temporary|session|project|global] [--session <id>] [--branch <b>] [--model <m>] [--ref <taskId>] [--template <id>] [--continue] [--inject-context] [--context-text <文本>]
  /de_coi list [--coi <id>] [--status <s>] [--limit <n>] [--q <关键词>]
  /de_coi log <taskId> [--tail <字符数>]
  /de_coi stop <taskId> [--force]（终止需二次确认；--all 需 --force --all）
  /de_coi sessions [list|note <id> <备注>|rm <id>] [--scope] [--branch] [--q]
  /de_coi adapters [list|show <id>|test <id>|enable <id>|disable <id>]
  /de_coi stats
  /de_coi templates list
  /de_coi export <sessionId> [--coi <id>]`,
      }
  }
}
