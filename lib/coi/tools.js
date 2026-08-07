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
    description: `发起一个 COI 任务（把任务派给外部 CLI 代理）。当前可用适配器及适用场景：${buildAdapterScene(scheduler.adapters)}。禁用状态的适配器不要派单（会被拒绝）；完整列表可用 de_coi_adapters 查询。立即返回 taskId，任务在后台异步执行，不阻塞本进程。随后用 de_coi_status 查进度、de_coi_wait 等待完成。可用 adapterId 指定代理；需要延续上次上下文时传 sessionId（会恢复该 COI 会话，且同一会话不能并发跑多个任务）；跨 COI 接力传 refTaskId（自动引用上一任务的输出）。scope：temporary=临时不保留会话/session=本次对话内/project=按工作目录归类（默认，可挂 branch）/global=跨项目全局。\n\n【记忆上下文注入】injectContext=true 时自动注入 DSH 记忆（供 COI 遵循与参考）：AGENTS.md 全局规则（行为纪律）、长期记忆（全局事实）、用户档案（用户偏好）、本项目关键记忆（仅当前 cwd 项目且按 git 分支过滤，与 DSH 会话注入同规则）。contextText 可传你自查后拼好的任意文本（如先用 memory 工具查项目日志/今日日志，把必要信息组织进来）。默认不注入（记忆内容会发给外部 COI 服务，注意隐私）；做项目开发时建议注入项目记忆，让 COI 了解项目约定与上下文。注入文本超 32KB 会自动写入本地文件并把路径告诉 COI。`,
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
        injectContext: { type: 'boolean', description: '是否自动注入 DSH 记忆上下文（AGENTS 规则/长期记忆/用户档案/本项目关键记忆按分支过滤；默认不注入，做项目开发时建议开启）' },
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
          task: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              adapterId: { type: 'string' },
              status: { type: 'string' },
              sessionId: { type: 'string', description: '会话 id（可能为 null）' },
              scope: { type: 'string' },
              summary: { type: 'string', description: '输出摘要（可能为 null）' },
              error: { type: 'string', description: '错误信息（可能为 null）' },
            },
            required: ['id', 'adapterId', 'status'],
          },
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
    execute: (args) => scheduler.status(args.taskId),
  }

  const wait = {
    name: 'de_coi_wait',
    description: '阻塞等待一个 COI 任务完成（最多等 timeoutMs，默认 60 秒）。任务完成返回结果摘要；超时返回当前状态。适合需要同步拿 COI 结果的场景；不着急时用 de_coi_status 轮询更省。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 id' },
        timeoutMs: { type: 'integer', description: '最大等待毫秒数（默认 60000，最大 600000）' },
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
          task: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              adapterId: { type: 'string' },
              status: { type: 'string' },
              sessionId: { type: 'string', description: '会话 id（可能为 null）' },
              summary: { type: 'string', description: '输出摘要（可能为 null）' },
              error: { type: 'string', description: '错误信息（可能为 null）' },
            },
            required: ['id', 'adapterId', 'status'],
          },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => {
        const task = value.task
        if (!task) return [{ type: 'text', text: value.message }]
        return [{ type: 'text', text: `任务 ${task.id}：${task.status}\n${task.summary ? `输出摘要：\n${task.summary}` : ''}` }]
      },
    },
    async execute(args) {
      const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 60000) || 60000, 1000), 600000)
      return scheduler.wait(args.taskId, timeoutMs)
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
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: `${value.ok ? '🛑' : '❌'} ${value.message}` }],
    },
    execute: (args) => scheduler.cancel(args.taskId, { force: true }),
  }

  return [dispatch, adapters, status, wait, cancel]
}
