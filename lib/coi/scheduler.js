/**
 * COI 调度器 — 核心：非阻塞后台执行、进度流、会话锁、崩溃恢复。
 *
 * 设计原则（需求文档 §6）：
 *   - 非阻塞：dispatch 立即返回 { taskId, status }，进程后台化，绝不
 *     阻塞 DSH 主进程（Agent 可继续其他工作，长任务不卡界面）
 *   - 并发不限制：任务全部立即启动（不做排队上限）
 *   - 进程树终止：detached 进程组 + kill(-pid)，COI 派生的子进程一并清理
 *   - 超时兜底：默认 30 分钟强杀；输出体积截断（留档上限）
 *   - 会话锁：同一会话同时只能跑一个任务（SessionStore.acquire）
 *   - 崩溃恢复：启动时把上次遗留的 running/queued 标记为 interrupted
 *   - 事件：任务状态变化通过 ctx.emit('coi/task-change', snapshot) 广播
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildArgs, extractSessionId } from './adapters.js'

const FLUSH_MS = 2000          // 留档落盘间隔
const KILL_GRACE_MS = 3000     // SIGTERM 后未退出的宽限，再 SIGKILL
const SUMMARY_CHARS = 1024     // 摘要取输出尾部字符数（1KB：覆盖「结论」段；完整输出另留档）
const RELAY_INLINE_MAX = 256 * 1024 // 接力内联上限（命令行参数安全值）；超长降级为写文件+尾部预览
const CONTEXT_INLINE_MAX = 32 * 1024  // 记忆上下文内联上限；超长降级为写文件+路径+尾部预览
const PROGRESS_LIMIT = 50      // 进度事件保留条数

/** 把 raw 输出流解析成进度事件（结构化流轻量解析，失败返回 null）。 */
function parseProgressLine(line) {
  if (!line.startsWith('{')) return null
  try {
    const obj = JSON.parse(line)
    if (obj === null || typeof obj !== 'object') return null
    const kind = obj.type ?? obj.event ?? obj.status ?? obj.kind
    if (typeof kind !== 'string' || kind.length === 0 || kind.length > 40) return null
    return { kind, text: typeof obj.text === 'string' ? obj.text.slice(0, 200) : undefined }
  } catch {
    return null
  }
}

/** 任务对外快照（不含进程句柄等内部状态）。 */
function snapshot(task) {
  const { process: _p, buffer: _b, flushTimer: _t, timeoutTimer: _tt, ...rest } = task
  return rest
}

/**
 * @param {object} ctx - cordis 上下文（用于 ctx.emit 事件广播）。
 * @param {object} deps - { adapters, sessions, tasks, config, writeSummary?, notify? }
 *   writeSummary({cwd, branch, text}) 摘要沉淀回调（可选，失败静默）；
 *   notify(text) 完成通知回调（可选，来自 coiNotifyCommand 配置）。
 * @param {object} [opts] - { spawn: 可注入的 spawn（测试用） }。
 */
export class CoiScheduler {
  constructor(ctx, deps, opts = {}) {
    this.ctx = ctx
    this.adapters = deps.adapters
    this.sessions = deps.sessions
    this.tasks = deps.tasks
    this.config = deps.config
    this.writeSummary = deps.writeSummary
    this.notify = deps.notify
    this.memoryContext = deps.memoryContext // ({cwd, branch}) => 自动注入的记忆轨文本（长期记忆/用户档案/项目 key，由主插件按层级提供；不含 AGENTS.md）
    this.spawn = opts.spawn ?? nodeSpawn
    this.running = new Map() // taskId -> 内部 task（含 process/buffer/timers）
    this.disposed = false
  }

  #emit(event, data) {
    try {
      this.ctx.emit(event, data)
    } catch {
      /* 无监听者或 emit 不可用：忽略 */
    }
  }

  /** 启动时崩溃恢复：遗留的 running/queued 标记为 interrupted。 */
  recover() {
    for (const task of this.tasks.tasks) {
      if (task.status === 'running' || task.status === 'queued') {
        this.tasks.update(task.id, {
          status: 'interrupted',
          finishedAt: Date.now(),
          error: 'DSH 重启导致任务中断，可基于会话恢复',
        })
      }
    }
  }

  /**
   * 发起一个 COI 任务（立即返回，不等待）。
   * @param {object} req - { adapterId, prompt, scope?, cwd?, branch?, sessionId?,
   *   model?, refTaskId?, templateId?, agentLabel? }
   *   scope 缺省：'session'（仅发起会话可见——私有默认，用户拍板 2026-08-07：
   *   曾默认 'project' 导致同工作区所有会话都收到任务/注入，AI 也易选错；
   *   需要跨会话协作时显式传 'project'/'global'）。'temporary' 不入会话库。
   *   refTaskId：跨 COI 接力——引用该任务的留档尾部拼进 prompt。
   * @returns {{ok:boolean, taskId?:string, status?:string, message?:string}}
   */
  dispatch(req) {
    if (this.disposed) return { ok: false, message: '调度器已销毁' }
    const adapter = this.adapters.get(req.adapterId)
    if (!adapter) return { ok: false, message: `未知适配器 "${req.adapterId}"（可用 de_coi_adapters 查看可用适配器与适用场景）` }
    if (adapter.enabled === false) {
      const available = this.adapters.list().filter((a) => a.enabled !== false).map((a) => a.id).join(' / ')
      return { ok: false, message: `适配器 ${adapter.id}（${adapter.name}）已被禁用。可用适配器：${available}（可用 de_coi_adapters 查看适用场景）` }
    }
    const prompt = String(req.prompt ?? '').trim()
    if (!prompt) return { ok: false, message: '任务内容不能为空' }
    const cwd = req.cwd ?? null
    // 默认 session（仅发起会话可见）：私有默认，防止任务/注入扩散到同工作区
    // 其他会话；需要跨会话协作时显式传 project/global
    const scope = req.scope ?? 'session'
    const validScopes = ['temporary', 'session', 'project', 'global']
    if (!validScopes.includes(scope)) return { ok: false, message: `scope 必须是 ${validScopes.join('/')}` }

    // 接力：引用任务 A 的完整留档（全量输出；超过命令行参数上限时
    // 降级为写 relay 文件 + 内联尾部预览，保证"全部"可获取）
    let finalPrompt = prompt
    if (req.refTaskId) {
      const ref = this.tasks.get(req.refTaskId)
      if (!ref) return { ok: false, message: `引用的任务 ${req.refTaskId} 不存在` }
      const full = this.tasks.readLog(ref.id)
      if (full) {
        if (full.length <= RELAY_INLINE_MAX) {
          finalPrompt = `【引用任务 ${ref.id}（${ref.adapterId}）的完整输出，供你参考：】\n${full}\n\n【我的任务】\n${prompt}`
        } else {
          const relayDir = join(this.config.coiDataDir, 'relay')
          mkdirSync(relayDir, { recursive: true })
          const relayFile = join(relayDir, `${ref.id}.txt`)
          try {
            writeFileSync(relayFile, full)
            finalPrompt = `【引用任务 ${ref.id}（${ref.adapterId}）的完整输出（共 ${full.length} 字符）已写入文件 ${relayFile}，请读取该文件获取完整内容。输出尾部预览：】\n${full.slice(-RELAY_INLINE_MAX)}\n\n【我的任务】\n${prompt}`
          } catch {
            finalPrompt = `【引用任务 ${ref.id}（${ref.adapterId}）的输出尾部（完整内容过大无法内联）：】\n${full.slice(-RELAY_INLINE_MAX)}\n\n【我的任务】\n${prompt}`
          }
        }
      }
    }

    // 会话模式：恢复指定会话 / 最近会话 / 新会话
    let sessionId = req.sessionId ?? null
    let mode = 'new'
    if (sessionId && adapter.type === 'ai-cli') mode = 'resume'
    else if (adapter.type === 'ai-cli' && req.continueLast) mode = 'continue'

    // 入队（状态机 queued → running）
    const task = this.tasks.add({
      adapterId: adapter.id,
      coi: adapter.name,
      prompt: finalPrompt,
      scope,
      cwd,
      branch: req.branch ?? null,
      sessionId: sessionId && adapter.type === 'ai-cli' ? sessionId : null,
      model: req.model ?? null,
      refTaskId: req.refTaskId ?? null,
      templateId: req.templateId ?? null,
      agentLabel: req.agentLabel ?? null,
      ownerSessionId: req.ownerSessionId ?? null, // DSH 会话 id（临时/会话层级可见性依据）
      ownerCwd: req.ownerCwd ?? null,             // 发起会话的工作目录（项目层级可见性依据：
                                                  //   发起者工作区内的会话可见本任务，跨目录派的任务
                                                  //   不会被其他工作区看到）
      mode: mode === 'new' ? undefined : mode,
    })

    // 会话锁：恢复指定会话时占用（同一会话不能并发跑多个任务）。
    // 任务先入队，占用失败则回滚删除（此时任务尚未启动，无副作用）。
    // 未登记的会话（如用户手动从 CLI 拿到的 id）先自动登记再占用。
    if (sessionId && adapter.type === 'ai-cli') {
      if (!this.sessions.findById(sessionId)) {
        this.sessions.upsert({ id: sessionId, adapterId: adapter.id, scope, cwd, branch: req.branch ?? null, taskId: task.id, ownerSessionId: task.ownerSessionId, ownerCwd: task.ownerCwd })
      }
      const lock = this.sessions.acquire(sessionId, task.id)
      if (!lock.ok) {
        const index = this.tasks.tasks.findIndex((t) => t.id === task.id)
        if (index >= 0) this.tasks.tasks.splice(index, 1)
        return { ok: false, message: lock.message }
      }
    }

    // 记忆上下文注入（默认关；AI 自主选择注入轨：memory/user/key + 自传文本）
    // 注意：注入与 scope 完全无关——scope 只决定任务归属与可见性；无论什么
    // 层级，只要传了 injectTracks 就会注入对应轨（内容会发给外部 COI 服务）
    const injectTracks = Array.isArray(req.injectTracks)
      ? req.injectTracks.filter((t) => t === 'memory' || t === 'user' || t === 'key')
      : []
    const contextText = String(req.contextText ?? '').trim()
    const memText = injectTracks.length > 0
      ? String(this.memoryContext?.({ cwd: task.cwd, branch: task.branch, tracks: injectTracks }) ?? '').trim()
      : ''
    const ctxParts = []
    if (memText !== '') ctxParts.push(memText)
    if (contextText !== '') ctxParts.push(contextText)
    if (ctxParts.length > 0) {
      const ctxBlock = ctxParts.join('\n\n')
      const basePrompt = finalPrompt
      if (ctxBlock.length <= CONTEXT_INLINE_MAX) {
        finalPrompt = `【规则和背景信息】（以下内容为任务的规则与背景，必须严格遵循其中的要求执行任务，回复中无需说明或提及来源）\n${ctxBlock}\n\n【任务】\n${basePrompt}`
      } else {
        const ctxDir = join(this.config.coiDataDir, 'contexts')
        mkdirSync(ctxDir, { recursive: true })
        const ctxFile = join(ctxDir, `${task.id}.txt`)
        try {
          writeFileSync(ctxFile, ctxBlock)
          finalPrompt = `【规则和背景信息】已写入文件 ${ctxFile}（共 ${ctxBlock.length} 字符），请读取该文件——其中的规则与背景必须严格遵循执行（回复中无需提及来源）。尾部预览：\n${ctxBlock.slice(-CONTEXT_INLINE_MAX)}\n\n【任务】\n${basePrompt}`
        } catch {
          finalPrompt = `【规则和背景信息】尾部（完整内容过大无法落文件，必须严格遵循以下规则与背景执行，回复中无需提及来源）：\n${ctxBlock.slice(-CONTEXT_INLINE_MAX)}\n\n【任务】\n${basePrompt}`
        }
      }
    }
    // AI 类适配器（type=ai-cli）追加输出约定：回复末尾必须输出【结论】段、
    // 交互内容给文件绝对路径——保证 CLI 反馈有效可溯源（调度器取输出尾部
    // 当摘要，结论在末尾则摘要即结论）。plain-cli 普通命令不是 AI，不追加
    // 这种自然语言指令（结构化输出/脚本不消费它）。
    if (adapter.type === 'ai-cli') {
      finalPrompt += `\n\n【输出约定】（请遵守）
- 在回复最末尾输出【结论】段：用简洁要点总结你完成的工作（改了哪些文件 / 实现了什么 / 如何验证或预览）。
- 需要当前会话中的 AI 进一步处理的内容（文件、产物、可运行地址），一律给出文件的**绝对路径**；不要只描述、不给出可访问的位置。`
    }
    this.tasks.update(task.id, { prompt: finalPrompt })

    // 立即转 running 并启动进程（并发不限制）
    this.tasks.update(task.id, { status: 'running', startedAt: Date.now() })
    this.#startProcess(adapter, task, { finalPrompt, mode })
    this.#emit('coi/task-change', snapshot(task))
    return {
      ok: true,
      taskId: task.id,
      status: 'running',
      message: `已发起 ${adapter.name} 任务 ${task.id}（scope=${scope}）`,
    }
  }

  /** 启动子进程（进程组独立，便于整组终止）。 */
  #startProcess(adapter, task, { finalPrompt, mode }) {
    const args = buildArgs(adapter, {
      task: finalPrompt,
      cwd: task.cwd ?? undefined,
      model: task.model ?? undefined,
      sessionId: task.sessionId ?? undefined,
      mode: task.mode ?? 'new',
    })
    if (args.some((arg) => arg.includes('{sessionId}')) && mode === 'resume') {
      // 占位符未被替换 = sessionId 缺失，报错终止
      this.#finish(task, { status: 'failed', error: '缺少 sessionId 无法恢复会话' })
      return
    }
    let child
    try {
      child = this.spawn(adapter.binary, args, {
        cwd: task.cwd ?? undefined,
        env: { ...process.env, ...(adapter.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (error) {
      this.#finish(task, { status: 'failed', error: `启动失败: ${error.message}` })
      return
    }
    // COI 全部通过命令行参数传任务，不需要 stdin；立即关闭管道
    // （否则 codex 等会阻塞读取 stdin 而永不退出，任务永远 running）
    try { child.stdin?.end() } catch { /* 忽略 */ }
    const internal = {
      ...task,
      process: child,
      buffer: '',
      stderrBuffer: '',
      stdoutText: '',
      stderrText: '',
      progress: [],
      truncated: false,
    }
    this.running.set(task.id, internal)
    child.on('error', (error) => {
      this.#finish(internal, { status: 'failed', error: `进程错误: ${error.message}` })
    })
    child.stdout?.on('data', (chunk) => this.#onOutput(internal, 'stdout', chunk))
    child.stderr?.on('data', (chunk) => this.#onOutput(internal, 'stderr', chunk))
    child.on('close', (code, signal) => {
      if (this.running.get(task.id) === internal) {
        this.#finish(internal, {
          status: code === 0 ? 'completed' : 'failed',
          exitCode: code,
          error: code !== 0 && !internal.timedOut ? `退出码 ${code}${signal ? `（信号 ${signal}）` : ''}` : internal.error,
        })
      }
    })
    internal.flushTimer = setInterval(() => this.#flush(internal), FLUSH_MS)
    const timeoutMs = adapter.defaults?.timeoutMs ?? this.config.coiTaskTimeoutMs
    if (timeoutMs > 0) {
      internal.timeoutTimer = setTimeout(() => {
        if (this.running.get(task.id) !== internal) return
        internal.timedOut = true
        this.#kill(internal, '超时强杀')
      }, timeoutMs)
    }
  }

  /** 增量输出：入缓冲、提取 session id、解析进度、定时落盘。 */
  #onOutput(internal, source, chunk) {
    if (this.running.get(internal.id) !== internal) return
    const text = chunk.toString()
    const target = source === 'stderr' ? 'stderrBuffer' : 'buffer'
    internal[target] += text
    if (source === 'stdout') internal.stdoutText += text
    else internal.stderrText += text

    // 会话 id 捕获（增量扫描：只扫新增部分；新任务/resume 任务都提取——
    // kimi 等会在输出尾部打印可恢复的新会话 id）
    if (internal.sessionId == null) {
      const found = extractSessionId(this.adapters.get(internal.adapterId), internal.stdoutText, internal.stderrText)
      if (found) {
        internal.sessionId = found
        this.tasks.update(internal.id, { sessionId: found })
        if (internal.scope !== 'temporary') {
          this.sessions.upsert({
            id: found,
            adapterId: internal.adapterId,
            scope: internal.scope,
            cwd: internal.cwd,
            branch: internal.branch,
            taskId: internal.id,
            ownerSessionId: internal.ownerSessionId ?? null,
          })
          // 新任务捕获到会话后同样占用（防后续 resume 任务撞车）
          const lock = this.sessions.acquire(found, internal.id)
          if (!lock.ok) {
            // 已被其他任务占用：保留提取结果，但锁归对方
            internal.sessionLocked = false
          }
        }
        this.#emit('coi/task-change', snapshot(internal))
      }
    }

    // 进度事件（结构化流行）
    const lines = text.split('\n')
    for (const line of lines) {
      const ev = parseProgressLine(line)
      if (ev) {
        internal.progress.push({ at: Date.now(), ...ev })
        if (internal.progress.length > PROGRESS_LIMIT) internal.progress.shift()
      }
    }
  }

  /** 定时把缓冲写入留档文件，并刷新"最后输出时间"（实时活性判断用）。 */
  #flush(internal) {
    if (this.running.get(internal.id) !== internal) return
    const text = internal.buffer
    internal.buffer = ''
    if (text) {
      this.tasks.appendLog(internal.id, text)
      this.tasks.update(internal.id, { lastOutputAt: Date.now() })
    }
  }

  /** 任务结束统一收尾。 */
  #finish(internal, patch) {
    const current = this.running.get(internal.id)
    if (!current) return
    this.running.delete(internal.id)
    clearInterval(internal.flushTimer)
    clearTimeout(internal.timeoutTimer)
    // 收尾 flush
    const tail = internal.buffer
    internal.buffer = ''
    this.tasks.appendLog(internal.id, tail)
    if (internal.sessionId) {
      this.sessions.release(internal.sessionId, internal.id)
    }
    const status = patch.status ?? 'failed'
    const summary = this.tasks.readLog(internal.id, SUMMARY_CHARS)
    const updates = {
      status,
      finishedAt: Date.now(),
      exitCode: patch.exitCode ?? internal.exitCode ?? null,
      error: patch.error ?? internal.error ?? null,
      summary: summary || null,
      progress: internal.progress.slice(0, PROGRESS_LIMIT),
      logTruncated: internal.truncated || undefined,
    }
    this.tasks.update(internal.id, updates)
    const done = this.tasks.get(internal.id)
    // 摘要沉淀（项目/全局级任务，且记忆回调存在）
    if (done.scope !== 'temporary' && this.writeSummary) {
      const line = `[COI] ${done.coi} 任务 ${done.id} ${status}${done.sessionId ? `（会话 ${done.sessionId}）` : ''}：${String(done.prompt ?? '').slice(0, 120)}`
      try {
        this.writeSummary({ cwd: done.cwd, branch: done.branch, text: line })
      } catch {
        /* 记忆写入失败不影响任务 */
      }
    }
    if (this.notify) {
      try {
        this.notify({ taskId: done.id, coi: done.coi, status, summary: done.summary })
      } catch {
        /* 通知失败不影响任务 */
      }
    }
    this.#emit('coi/task-change', snapshot(done))
  }

  /** 终止进程组：SIGTERM → 宽限 → SIGKILL。 */
  #kill(internal, reason) {
    const child = internal.process
    if (!child || child.exitCode !== null) return
    const pid = child.pid
    const signal = internal.timedOut ? 'SIGKILL' : 'SIGTERM'
    try {
      process.kill(-pid, signal)
    } catch {
      try { child.kill(signal) } catch { /* 已退出 */ }
    }
    if (signal === 'SIGTERM') {
      const killer = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL') } catch { /* 已退出 */ }
      }, KILL_GRACE_MS)
      killer.unref?.()
    }
    internal.error = internal.error ?? reason
  }

  /**
   * 取消任务（进程组终止）。
   * @param {string} taskId
   * @param {object} [opts] - { force: true 表示调用方已确认 }。
   * @returns {{ok:boolean, message:string, task?:object}}
   */
  cancel(taskId, opts = {}) {
    const internal = this.running.get(taskId)
    const task = this.tasks.get(taskId)
    if (!task) return { ok: false, message: `任务 ${taskId} 不存在` }
    if (!internal) {
      const done = ['completed', 'failed', 'killed', 'interrupted'].includes(task.status)
      return { ok: false, message: done ? `任务 ${taskId} 已结束（${task.status}）` : `任务 ${taskId} 不在运行中` }
    }
    if (!opts.force) {
      return {
        ok: false,
        message: `确认终止任务 ${taskId}（${task.coi}：${String(task.prompt ?? '').slice(0, 60)}）？再次调用并带 force=true 才执行`,
      }
    }
    this.#kill(internal, '用户终止')
    this.tasks.update(taskId, { status: 'killed', finishedAt: Date.now(), error: '用户终止' })
    if (internal.sessionId) this.sessions.release(internal.sessionId, taskId)
    this.running.delete(taskId)
    clearInterval(internal.flushTimer)
    clearTimeout(internal.timeoutTimer)
    this.tasks.appendLog(taskId, `\n[任务被用户终止]\n`)
    const done = this.tasks.get(taskId)
    this.#emit('coi/task-change', snapshot(done))
    return { ok: true, message: `任务 ${taskId} 已终止`, task: snapshot(done) }
  }

  /** 任务状态/详情。 */
  status(taskId) {
    const task = this.tasks.get(taskId)
    if (!task) return { ok: false, message: `任务 ${taskId} 不存在` }
    return { ok: true, task: snapshot(task) }
  }

  /** 任务输出（留档已含全部缓冲；运行中实时读文件）。 */
  getLog(taskId, tailChars) {
    const task = this.tasks.get(taskId)
    if (!task) return { ok: false, message: `任务 ${taskId} 不存在` }
    return { ok: true, text: this.tasks.readLog(taskId, tailChars) }
  }

  /**
   * 阻塞等待任务完成（带超时）。
   *
   * 实现为纯轮询（每 500ms 读一次任务状态），**不依赖 ctx.on/ctx.off 事件
   * 系统**——cordis 受限上下文里 `ctx.off` 会抛 "cannot get property 'off'
   * without inject"，且 timer 回调中的未捕获异常会直接崩掉整个进程
   * （曾导致 DSH 挂掉：超时回调抛错 → resolve 不执行 → 工具永远挂着）。
   * 轮询只在任务状态变化与超时两个时刻 resolve，绝不抛错。
   *
   * @param {string} taskId
   * @param {number} [timeoutMs=60000] 最大等待毫秒数
   * @param {AbortSignal} [signal] 可选取消信号（如工具执行的 exec.signal）：
   *   abort 时立即停止轮询并 resolve。修复定时器链泄漏：原来调用方用
   *   Promise.race 取消时本 Promise 永不 settle，内部 500ms 轮询链会一直
   *   空转到 deadline（最长 10 分钟），每次取消都泄漏一条定时器链 + closure。
   */
  async wait(taskId, timeoutMs = 60000, signal) {
    const task = this.tasks.get(taskId)
    if (!task) return { ok: false, message: `任务 ${taskId} 不存在` }
    if (task.status !== 'running' && task.status !== 'queued') {
      return { ok: true, task: snapshot(task) }
    }
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve) => {
      let timer = null
      // 统一收口：所有终态分支（完成/不存在/超时/取消）都走这里——
      // 清掉已排队的轮询定时器、摘除 abort 监听再 resolve，
      // 保证轮询链立即断开、不再空转（P0-1 修复）
      const done = (result) => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (signal) {
          try { signal.removeEventListener?.('abort', onAbort) } catch { /* 忽略 */ }
        }
        resolve(result)
      }
      const onAbort = () => done({ ok: false, message: '等待已取消（会话已停止）' })
      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      const tick = () => {
        const current = this.tasks.get(taskId)
        if (!current) {
          done({ ok: false, message: `任务 ${taskId} 不存在` })
          return
        }
        if (current.status !== 'running' && current.status !== 'queued') {
          done({ ok: true, task: snapshot(current) })
          return
        }
        if (Date.now() >= deadline) {
          done({ ok: false, message: `等待超时（${timeoutMs}ms），任务仍在运行，可用 de_coi_status 再查`, task: snapshot(current) })
          return
        }
        timer = setTimeout(tick, 500)
      }
      timer = setTimeout(tick, 500)
    })
  }

  /** 一键重试：同参数重新发起（新会话；若原任务有 sessionId 则恢复它）。 */
  retry(taskId) {
    const task = this.tasks.get(taskId)
    if (!task) return { ok: false, message: `任务 ${taskId} 不存在` }
    return this.dispatch({
      adapterId: task.adapterId,
      prompt: task.prompt,
      scope: task.scope,
      cwd: task.cwd,
      branch: task.branch,
      sessionId: task.sessionId ?? undefined,
      model: task.model ?? undefined,
      refTaskId: task.refTaskId ?? undefined,
      templateId: task.templateId ?? undefined,
      ownerSessionId: task.ownerSessionId ?? undefined,
      ownerCwd: task.ownerCwd ?? undefined,
    })
  }

  /** 适配器测试：用 testCmd 起一次性任务（不入会话库）。 */
  testAdapter(adapterId) {
    const adapter = this.adapters.get(adapterId)
    if (!adapter) return { ok: false, message: `未知适配器 "${adapterId}"` }
    if (adapter.enabled === false) return { ok: false, message: `适配器 ${adapterId} 已被禁用，无法测试` }
    if (!Array.isArray(adapter.testCmd) || adapter.testCmd.length === 0) {
      return { ok: false, message: `适配器 ${adapterId} 未配置 testCmd` }
    }
    const task = this.tasks.add({
      adapterId: adapter.id,
      coi: adapter.name,
      prompt: `[适配器测试] ${adapter.testCmd.join(' ')}`,
      scope: 'temporary',
      cwd: null,
      branch: null,
      sessionId: null,
      model: null,
      kind: 'test',
    })
    this.tasks.update(task.id, { status: 'running', startedAt: Date.now() })
    const internal = {
      ...task,
      process: null,
      buffer: '',
      stderrBuffer: '',
      stdoutText: '',
      stderrText: '',
      progress: [],
    }
    this.running.set(task.id, internal)
    let child
    try {
      child = this.spawn(adapter.binary, adapter.testCmd, {
        env: { ...process.env, ...(adapter.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (error) {
      this.#finish(internal, { status: 'failed', error: `启动失败: ${error.message}` })
      return { ok: false, message: `启动失败: ${error.message}`, taskId: task.id }
    }
    internal.process = child
    try { child.stdin?.end() } catch { /* 忽略 */ }
    child.on('error', (error) => this.#finish(internal, { status: 'failed', error: `进程错误: ${error.message}` }))
    child.stdout?.on('data', (chunk) => this.#onOutput(internal, 'stdout', chunk))
    child.stderr?.on('data', (chunk) => this.#onOutput(internal, 'stderr', chunk))
    child.on('close', (code) => {
      if (this.running.get(task.id) === internal) {
        this.#finish(internal, {
          status: code === 0 ? 'completed' : 'failed',
          exitCode: code,
          error: code !== 0 ? `退出码 ${code}` : undefined,
        })
      }
    })
    internal.flushTimer = setInterval(() => this.#flush(internal), FLUSH_MS)
    const timeoutMs = adapter.defaults?.timeoutMs ?? this.config.coiTaskTimeoutMs
    if (timeoutMs > 0) {
      internal.timeoutTimer = setTimeout(() => {
        if (this.running.get(task.id) !== internal) return
        internal.timedOut = true
        this.#kill(internal, '适配器测试超时')
      }, timeoutMs)
    }
    return { ok: true, taskId: task.id, message: `测试任务 ${task.id} 已启动` }
  }

  /**
   * 释放全部定时器并终止运行中任务（插件卸载 / coiEnabled 关闭时调用）。
   *
   * P2-9 修复：原实现只清定时器，运行中的 COI 子进程变成孤儿
   * （detached 继续跑）、会话锁 activeTaskId 永久残留（重开 COI 后
   * resume 该会话会被锁拒绝）、tasks.json 状态停在 running 且无人监控。
   * 现在对每个运行中任务：清定时器 → 从 running 摘除 → 释放会话锁 →
   * 标记 interrupted → 终止进程组。
   * 顺序注意：先摘除再 kill，进程 close 事件触发时 #finish 的
   * `running.get(id)` 检查为 false 直接返回，不会把状态覆盖回去。
   */
  dispose() {
    this.disposed = true
    for (const internal of [...this.running.values()]) {
      clearInterval(internal.flushTimer)
      clearTimeout(internal.timeoutTimer)
      this.#flush(internal)
      this.running.delete(internal.id)
      if (internal.sessionId) {
        try { this.sessions.release(internal.sessionId, internal.id) } catch { /* 忽略 */ }
      }
      try {
        this.tasks.update(internal.id, {
          status: 'interrupted',
          finishedAt: Date.now(),
          error: 'COI 模块关闭导致任务中断，可基于会话恢复',
        })
      } catch { /* 忽略 */ }
      this.#kill(internal, 'COI 模块关闭')
    }
  }
}
