/**
 * COI 模型工具 — DSH Agent 派活给 COI 的入口（替换裸 bash 调用）。
 *
 * 工具族：
 *   de_coi_dispatch  发起任务（立即返回 taskId，不阻塞；异步查询用 de_coi_status）
 *   de_coi_status    查询任务状态/输出摘要
 *   de_coi_wait      阻塞等待任务完成（带超时，适合需要同步拿结果的场景）
 *   de_coi_cancel    终止任务（Agent 侧直接执行、不弹窗，记录日志）
 *
 * 使用纪律（写入 description，模型天然可见）：
 *   - 需要延续 COI 上下文时传 sessionId（先从 de_coi_status 或会话列表查）
 *   - 跨 COI 接力：传 refTaskId 引用上一任务的输出
 */
const SCOPE_ENUM = ['temporary', 'session', 'project', 'global']

/**
 * 任务详情视图：与 de_coi_status / de_coi_wait / de_coi_cancel 的输出 schema
 * 严格对应（additionalProperties:false 下不能多字段、类型不能错）：
 *   - 可空字符串字段归一化为空串（schema 全 string，避免 null 撞类型校验）
 *   - 可空数字字段保留 null（schema 用 oneOf 声明，DSH 校验器已确认支持）
 *   - prompt 过长且由发起方自带，不重复返回
 *   - progress 元素是对象，序列化为 JSON 行（schema 声明 string[]）
 * @param {object} task - TaskStore 任务记录（snapshot 形态）。
 * @returns {object} 与 statusTaskSchema 一一对应的纯数据对象。
 */
function statusTaskView(task) {
  const str = (v) => v ?? ''
  return {
    id: task.id,
    adapterId: task.adapterId,
    coi: str(task.coi),
    status: task.status,
    scope: str(task.scope),
    cwd: str(task.cwd),
    branch: str(task.branch),
    sessionId: str(task.sessionId),
    model: str(task.model),
    refTaskId: str(task.refTaskId),
    templateId: str(task.templateId),
    agentLabel: str(task.agentLabel),
    ownerSessionId: str(task.ownerSessionId),
    createdAt: task.createdAt ?? 0,
    startedAt: task.startedAt ?? null,
    finishedAt: task.finishedAt ?? null,
    exitCode: task.exitCode ?? null,
    timedOut: task.timedOut ?? false,
    error: str(task.error),
    summary: str(task.summary),
    progress: (task.progress ?? []).map((p) => JSON.stringify(p)),
    lastOutputAt: task.lastOutputAt ?? null,
  }
}

/** status/wait/cancel 共用的任务详情 schema（与 statusTaskView 输出一一对应）。 */
const statusTaskSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    adapterId: { type: 'string' },
    coi: { type: 'string', description: '适配器显示名（空=未记录）' },
    status: { type: 'string', description: 'queued/running/completed/failed/killed/interrupted' },
    scope: { type: 'string' },
    cwd: { type: 'string', description: '工作目录（空=无）' },
    branch: { type: 'string', description: 'git 分支（空=无）' },
    sessionId: { type: 'string', description: 'COI 会话 id（空=未捕获）' },
    model: { type: 'string', description: '模型（空=适配器默认）' },
    refTaskId: { type: 'string', description: '接力来源任务（空=无）' },
    templateId: { type: 'string', description: '任务模板（空=无）' },
    agentLabel: { type: 'string' },
    ownerSessionId: { type: 'string', description: '发起任务的 DSH 会话 id' },
    createdAt: { type: 'integer', description: '创建时间戳（毫秒）' },
    startedAt: { oneOf: [{ type: 'integer' }, { type: 'null' }], description: '开始时间戳（null=未开始）' },
    finishedAt: { oneOf: [{ type: 'integer' }, { type: 'null' }], description: '结束时间戳（null=未结束）' },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], description: '进程退出码（null=未结束）' },
    timedOut: { type: 'boolean' },
    error: { type: 'string', description: '错误信息（空=无错误）' },
    summary: { type: 'string', description: '输出摘要（空=暂无）' },
    progress: { type: 'array', items: { type: 'string' }, description: '最近进度事件（JSON 行，最多 50 条）' },
    lastOutputAt: { oneOf: [{ type: 'integer' }, { type: 'null' }], description: '最后输出时间戳（null=暂无输出）' },
  },
  required: ['id', 'adapterId', 'status'],
}

/**
 * 从当前适配器配置动态生成 dispatch 的场景说明（插件加载时注册工具，
 * 配置变更后重启/重装即更新；含自定义适配器与启用/禁用状态）。
 * @param {import('./adapters.js').AdapterStore} adapters
 * @returns {string}
 */
function buildAdapterScene(adapters) {
  const parts = adapters.list().map((a) => {
    const scene = a.useCase !== undefined && a.useCase !== '' ? a.useCase : '通用任务'
    return a.enabled === false ? `${a.id}=${scene}（已禁用，不可派单）` : `${a.id}=${scene}`
  })
  return parts.join('；')
}

/**
 * @param {import('./scheduler.js').CoiScheduler} scheduler
 * @returns {object[]} 工具定义数组（与 memory 工具同 shape，直接进 ctx.tools.register）。
 */
export function coiToolDefinitions(scheduler) {
  const dispatch = {
    name: 'de_coi_dispatch',
    description: `发起一个 COI 任务（把任务派给外部 CLI 代理）。当前可用适配器及适用场景：${buildAdapterScene(scheduler.adapters)}。禁用状态的适配器不要派单（会被拒绝）；完整列表可用 de_coi_adapters 查询。立即返回 taskId，任务在后台异步执行，不阻塞本进程。随后用 de_coi_status 查进度、de_coi_wait 等待完成。可用 adapterId 指定代理；需要延续上次上下文时传 sessionId（会恢复该 COI 会话，且同一会话不能并发跑多个任务）；跨 COI 接力传 refTaskId（自动引用上一任务的输出）。scope：temporary=临时不保留会话/session=本次对话内/project=按工作目录归类（默认，可挂 branch）/global=跨项目全局。\n\n【记忆上下文注入】injectContext=true 时自动注入 DSH 记忆（供 COI 遵循与参考）：长期记忆（全局事实）、用户档案（用户偏好）、本项目关键记忆（仅当前 cwd 项目且按 git 分支过滤；不注入 AGENTS.md 全局规则——那是 DSH 主模型的纪律）。contextText 可传你自查后拼好的任意文本（如先用 memory 工具查项目日志/今日日志，把必要信息组织进来）。默认不注入（记忆内容会发给外部 COI 服务，注意隐私）；做项目开发时建议注入项目记忆，让 COI 了解项目约定与上下文。注入文本超 32KB 会自动写入本地文件并把路径告诉 COI。`,
    parameters: {
      type: 'object',
      properties: {
        adapterId: { type: 'string', description: 'COI 适配器 id：kimi / codex / grok / hermes 或自定义' },
        prompt: { type: 'string', description: '任务内容（让 COI 做的事）' },
        scope: { type: 'string', enum: SCOPE_ENUM, description: '归属层级（默认 project，临时任务选 temporary）' },
        cwd: { type: 'string', description: '工作目录（缺省=当前会话工作目录）' },
        branch: { type: 'string', description: 'scope=project 时挂的 git 分支（缺省=当前分支）' },
        sessionId: { type: 'string', description: '要恢复的 COI 会话 id（延续上下文）；不传=新会话' },
        model: { type: 'string', description: '覆盖适配器默认模型' },
        refTaskId: { type: 'string', description: '跨 COI 接力：引用该任务的输出拼进任务' },
        templateId: { type: 'string', description: '任务模板 id（prompt 为空时用模板内容）' },
        injectContext: { type: 'boolean', description: '是否自动注入 DSH 记忆上下文（长期记忆/用户档案/本项目关键记忆按分支过滤，不含 AGENTS.md；默认不注入，做项目开发时建议开启）' },
        contextText: { type: 'string', description: '你自己拼接的上下文文本（可先用 memory 工具查项目/今日日志后组织；与 injectContext 可叠加）' },
      },
      required: ['adapterId', 'prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          taskId: { type: 'string' },
          status: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: `${value.ok ? '✅' : '❌'} ${value.message}${value.taskId ? `（taskId: ${value.taskId}）` : ''}` }],
    },
    async execute(args, exec) {
      let prompt = String(args.prompt ?? '').trim()
      let templateId = args.templateId
      if (!prompt && templateId) {
        const template = scheduler.templates?.get(templateId)
        if (template) {
          prompt = template.prompt
          if (!args.adapterId && template.adapterId) args = { ...args, adapterId: template.adapterId }
        } else {
          return { ok: false, message: `模板 ${templateId} 不存在` }
        }
      }
      if (!prompt) return { ok: false, message: '任务内容不能为空（或指定 templateId）' }
      const agentCwd = exec?.agent?.session?.header?.cwd
      const cwd = args.cwd ?? agentCwd ?? null
      return scheduler.dispatch({
        adapterId: args.adapterId,
        prompt,
        scope: args.scope ?? (cwd ? 'project' : 'global'),
        cwd,
        branch: args.branch,
        sessionId: args.sessionId,
        model: args.model,
        refTaskId: args.refTaskId,
        templateId,
        agentLabel: exec?.agent?.session?.header?.origin ?? 'main',
        ownerSessionId: exec?.agent?.session?.id ?? undefined,
        injectContext: args.injectContext,
        contextText: args.contextText,
      })
    },
  }

  const status = {
    name: 'de_coi_status',
    description: '查询 COI 任务状态与输出摘要（taskId 来自 de_coi_dispatch）。返回状态（running/completed/failed/killed/interrupted）、会话 id（若已捕获）、输出摘要。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 id' },
      },
      required: ['taskId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          task: { ...statusTaskSchema },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => {
        const task = value.task
        if (!task) return [{ type: 'text', text: value.message }]
        const lines = [
          `${task.status === 'completed' ? '✅' : task.status === 'running' ? '⏳' : '❌'} 任务 ${task.id}（${task.adapterId}）：${task.status}`,
          task.sessionId ? `会话：${task.sessionId}` : null,
          task.summary ? `输出摘要：\n${task.summary}` : null,
          task.error ? `错误：${task.error}` : null,
        ].filter(Boolean)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: (args) => {
      const result = scheduler.status(args.taskId)
      // 任务不存在：{ ok:false, message } 已符合 schema，直接返回
      if (result.task === undefined) return result
      const task = statusTaskView(result.task)
      return { ok: true, message: `任务 ${task.id}（${task.coi || task.adapterId}）：${task.status}`, task }
    },
  }

  const wait = {
    name: 'de_coi_wait',
    description: '阻塞等待一个 COI 任务完成（最多等 timeoutMs，默认 60 秒，上限 10 分钟）。⚠️ 等待期间会阻塞当前回合（点停止按钮可中断）；AI 代理任务通常数分钟到数小时，**建议优先用 de_coi_status 轮询进度**，只在任务预计很快完成且必须同步拿结果时用 wait。任务完成返回结果摘要；超时返回当前状态。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 id' },
        timeoutMs: { type: 'integer', description: '最大等待毫秒数（默认 60000，最大 600000；长时间任务不要设大值，用 de_coi_status 轮询）' },
      },
      required: ['taskId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          task: { ...statusTaskSchema },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => {
        const task = value.task
        if (!task) return [{ type: 'text', text: value.message }]
        return [{ type: 'text', text: `任务 ${task.id}：${task.status}\n${task.summary ? `输出摘要：\n${task.summary}` : ''}` }]
      },
    },
    async execute(args, exec) {
      const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 60000) || 60000, 1000), 600000)
      // 停止按钮/回合中断会 abort exec.signal——立即结束等待，绝不卡死当前回合
      if (exec?.signal?.aborted) return { ok: false, message: '等待已取消（会话已停止）' }
      const cancelled = new Promise((resolve) => {
        exec?.signal?.addEventListener('abort', () => {
          resolve({ ok: false, message: '等待已取消（用户停止）' })
        }, { once: true })
      })
      const result = await Promise.race([scheduler.wait(args.taskId, timeoutMs), cancelled])
      // 任务不存在 / 被取消：{ ok:false, message } 已符合 schema
      if (result.task === undefined) return result
      const task = statusTaskView(result.task)
      return { ok: result.ok, message: result.message ?? `任务 ${task.id}（${task.coi || task.adapterId}）：${task.status}`, task }
    },
  }

  const adapters = {
    name: 'de_coi_adapters',
    description: '查询可用的 COI 适配器列表及其适用场景（含禁用状态与自定义适配器）。派任务前不确定该用哪个 CLI 时先查这个：返回 id/name/type/enabled/useCase，再据此调 de_coi_dispatch（不要派给 enabled=false 的适配器）。',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          adapters: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                type: { type: 'string' },
                enabled: { type: 'boolean' },
                useCase: { type: 'string', description: '适用场景（可能为空）' },
              },
              required: ['id', 'name', 'type', 'enabled'],
            },
          },
        },
        required: ['ok', 'adapters'],
      },
      render: (_args, value) => {
        const lines = value.adapters.map((a) => `${a.enabled ? '✅' : '⛔'} ${a.id} — ${a.name}（${a.type}）${a.useCase ? `：${a.useCase}` : ''}${a.enabled ? '' : ' [已禁用]'}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: () => ({
      ok: true,
      adapters: scheduler.adapters.list().map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        enabled: a.enabled !== false,
        useCase: a.useCase ?? '',
      })),
    }),
  }

  const cancel = {
    name: 'de_coi_cancel',
    description: '终止一个正在运行的 COI 任务（杀掉整个进程树）。Agent 侧调用直接执行、不弹确认框（用户手动终止走 GUI/slash 有确认）。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 id' },
      },
      required: ['taskId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          task: { ...statusTaskSchema, description: '终止后的任务详情' },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: `${value.ok ? '🛑' : '❌'} ${value.message}` }],
    },
    execute: (args) => {
      const result = scheduler.cancel(args.taskId, { force: true })
      // 任务不存在/不在运行：{ ok:false, message } 已符合 schema
      if (result.task === undefined) return result
      return { ok: result.ok, message: result.message, task: statusTaskView(result.task) }
    },
  }

  return [dispatch, adapters, status, wait, cancel]
}
