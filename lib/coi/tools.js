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
    description: `发起一个 COI 任务（把任务派给外部 CLI 代理）。当前可用适配器及适用场景：${buildAdapterScene(scheduler.adapters)}。禁用状态的适配器不要派单（会被拒绝）；完整列表可用 de_coi_adapters 查询。立即返回 taskId，任务在后台异步执行，不阻塞本进程。随后用 de_coi_status 查进度、de_coi_wait 等待完成。可用 adapterId 指定代理；需要延续上次上下文时传 sessionId（会恢复该 COI 会话，且同一会话不能并发跑多个任务）；跨 COI 接力传 refTaskId（自动引用上一任务的输出）。scope：temporary=临时不保留会话（不入库、不沉淀摘要）/session=仅发起会话可见（**默认，私有**，可恢复会话）/project=本工作区所有会话可见（可挂 branch）/global=全显。**scope 只决定可见性，与记忆注入无关**（注入看 injectTracks）。\n\n【记忆上下文注入（AI 自主选择）】injectTracks 可传注入轨数组：memory=长期记忆（全局事实）/user=用户档案（用户偏好）/key=本项目关键记忆（当前 cwd 项目、按 git 分支过滤；不含 AGENTS.md 全局规则——那是 DSH 主模型的纪律）。**注意：scope 与记忆注入完全无关**——scope 只决定任务归属与可见性；需要注入记忆时无论选什么 scope 都可传 injectTracks。默认不注入（记忆内容会发给外部 COI 服务，注意隐私）；做项目开发时建议至少注入 key，让 COI 了解项目约定与上下文。contextText 可传你自查后拼好的任意文本（如先用 memory 工具查项目日志/今日日志，把必要信息组织进来；与 injectTracks 可叠加）。注入文本超 32KB 会自动写入本地文件并把路径告诉 COI。

【拿结果（重要，先读）】任务完成后其摘要会注入你**下一次生成前**的上下文（快照「COI 任务状态」段）——注意：**只有你在同一回合内继续生成（接着 wait/查询/做其他事）时才会自动看到**；若你直接结束回合，下一次生成要等用户发消息才发生，**结果不会被自动处理**，任务等于"卡在后台没人接"。因此派发后不要立即结束回合，按任务时长选择：
- **预计几分钟内**（grok 等）→ 直接 de_coi_wait 等到完成（完成即返回，不等满超时），拿结果继续处理，本回合闭环；
- **预计较长**（kimi/codex/zcode 等）→ 先 de_coi_wait 一小段（如 30-60s）确认任务正常启动（拿到会话/状态），再决定：继续 wait（单次最长 10 分钟，可多次调用）或结束回合——**若结束回合且用户希望完成后自动处理，可带 wakeOnComplete=true 派单**：任务完成时会自动唤醒本会话开新回合投递完成摘要（空闲时），AI 醒来直接处理结果、无需用户发消息；用户没要求唤醒时维持原状（如实告诉用户「任务在后台运行，发任意消息（如"看结果"）我就能看到完成摘要并整理」，**严禁承诺"完成后会自动处理/自动整理给你"**——除非本次派单已传 wakeOnComplete=true）。`,
    parameters: {
      type: 'object',
      properties: {
        adapterId: { type: 'string', description: 'COI 适配器 id：kimi / codex / grok / hermes 或自定义' },
        prompt: { type: 'string', description: '任务内容（让 COI 做的事）' },
        scope: { type: 'string', enum: SCOPE_ENUM, description: '归属层级（默认 session=仅发起会话可见，私有；需要跨会话协作时显式选 project=本工作区可见/global=全显；temporary=临时不入库不沉淀）' },
        cwd: { type: 'string', description: '工作目录（缺省=当前会话工作目录）' },
        branch: { type: 'string', description: 'scope=project 时挂的 git 分支（缺省=当前分支）' },
        sessionId: { type: 'string', description: '要恢复的 COI 会话 id（延续上下文）；不传=新会话' },
        model: { type: 'string', description: '覆盖适配器默认模型' },
        refTaskId: { type: 'string', description: '跨 COI 接力：引用该任务的输出拼进任务' },
        templateId: { type: 'string', description: '任务模板 id（prompt 为空时用模板内容）' },
        injectTracks: { type: 'array', items: { type: 'string', enum: ['memory', 'user', 'key'] }, description: '自主选择注入哪些 DSH 记忆轨给 COI（可多选）：memory=长期记忆、user=用户档案、key=本项目关键记忆（按 cwd 与 git 分支过滤，不含 AGENTS.md）。不传=不注入。**与 scope 无关**（scope 只决定归属/可见性）' },
        contextText: { type: 'string', description: '你自己拼接的上下文文本（可先用 memory 工具查项目/今日日志后组织；与 injectTracks 可叠加）' },
        attachments: {
          type: 'array',
          description: '【图片附件（可选）】要带给 COI 的图片列表（仅图片，最多 5 张）。每条来源三选一：path=本地文件绝对路径 / url=http(s) 远程地址（自动下载后传给 COI）/ attachmentId=引用本会话消息里的图片（用户在输入框贴的图，需当前 DSH 运行支持会话图片机制）。支持图片的适配器：codex（-i 参数）/ hermes（--image 参数）/ kimi（prompt 附路径+读图工具）/ grok（prompt 附路径，待实测验证）；zcode 纯文本不支持、qoder/dsh 暂不支持——不支持时派单会明确报错。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['image'], description: '附件类型：目前仅支持图片 image（缺省 image）' },
              path: { type: 'string', description: '本地文件绝对路径（与 url/attachmentId 三选一）' },
              url: { type: 'string', description: 'http/https 远程地址，自动下载后传给 COI（与 path/attachmentId 三选一）' },
              attachmentId: { type: 'string', description: '引用本会话消息里的图片 id（浏览器输入框贴图；与 path/url 三选一，需新快照运行时）' },
              mediaType: { type: 'string', description: 'attachmentId 引用时的媒体类型（如 image/png；缺省自动从会话记录取）' },
              fileName: { type: 'string', description: '目标文件名（url/attachmentId 缺省自动推断）' },
              caption: { type: 'string', description: '图片说明文字（附加在任务文本里，帮助 COI 理解图片用途）' },
            },
          },
        },
        wakeOnComplete: { type: 'boolean', description: '任务完成时是否唤醒本会话（默认 false=保持现状：完成摘要进快照段，下次生成才看到；已结束回合则需用户发消息才处理）。传 true=与官方后台任务同款体验：本会话空闲时任务完成会自动开新回合投递完成摘要（AI 醒来处理结果），本会话忙碌时摘要注入下一步；连续唤醒上限 3 次防自激。**使用时机：用户明确要求「任务完成叫我/完成后唤醒我/干完自动汇报」时传 true**；用户没要求唤醒时不要传，避免打扰。' },
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
      // 图片附件：先异步解析（path 校验 / url 下载 / attachmentId 会话引用
      // 读字节），任一附件非法即整体拒绝（不创建半成品任务）；解析成功
      // 的本地文件数组传给 dispatch 按适配器 image 配置注入
      const resolved = await scheduler.resolveAttachments(args.attachments, exec?.agent?.session?.id)
      if (!resolved.ok) return { ok: false, message: resolved.message }
      return scheduler.dispatch({
        adapterId: args.adapterId,
        prompt,
        scope: args.scope ?? 'session', // 私有默认：仅发起会话可见（防扩散到同工作区其他会话）
        cwd,
        branch: args.branch,
        sessionId: args.sessionId,
        model: args.model,
        refTaskId: args.refTaskId,
        templateId,
        agentLabel: exec?.agent?.session?.header?.origin ?? 'main',
        ownerSessionId: exec?.agent?.session?.id ?? undefined,
        ownerCwd: agentCwd ?? undefined, // 发起会话的工作目录（项目层级可见性依据）
        injectTracks: args.injectTracks,
        contextText: args.contextText,
        attachments: resolved.files,
        wakeOnComplete: args.wakeOnComplete === true, // 完成唤醒（默认 false=现状；true=官方同款：空闲自动开新回合投递完成摘要）
      })
    },
  }

  const status = {
    name: 'de_coi_status',
    description: '查询 COI 任务状态与输出摘要（taskId 来自 de_coi_dispatch）。返回状态（running/completed/failed/killed/interrupted）、会话 id（若已捕获）、输出摘要。需要立即确认状态、拿完整摘要或查会话 id 时用它；也可在回合内轮询跟踪长任务。',
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
    description: '阻塞等待一个 COI 任务完成（最多等 timeoutMs，默认 60 秒，上限 10 分钟）。任务完成即返回（不等满 timeout，不浪费等待时间）。**这是派发后拿结果的正确方式**：任务完成时本工具返回的 task 字段直接含完整摘要；等待期间任务完成摘要也会注入你下一次生成前的上下文。若超时未完成会返回当前状态——可再次调用继续等（单次最长 10 分钟）。⚠️ 等待期间会阻塞当前回合（用户点停止按钮会中断等待，返回"等待已取消"）。预计很快的任务用它完成闭环；超长任务可先 wait 一小段确认启动，未完成而结束回合时须如实告知用户发消息触发结果处理。',
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
      // 停止按钮/回合中断会 abort exec.signal——把 signal 直接交给
      // scheduler.wait：abort 时 wait 立即停止内部轮询并 resolve。
      // 原来用 Promise.race 取消时 wait 的 Promise 永不 settle，内部
      // 500ms 轮询链会空转到 deadline（定时器链泄漏，P0-1）。
      if (exec?.signal?.aborted) return { ok: false, message: '等待已取消（会话已停止）' }
      const result = await scheduler.wait(args.taskId, timeoutMs, exec?.signal)
      // 任务不存在 / 被取消：{ ok:false, message } 已符合 schema
      if (result.task === undefined) return result
      const task = statusTaskView(result.task)
      return { ok: result.ok, message: result.message ?? `任务 ${task.id}（${task.coi || task.adapterId}）：${task.status}`, task }
    },
  }

  const adapters = {
    name: 'de_coi_adapters',
    description: '查询可用的 COI 适配器列表及其适用场景（含禁用状态与自定义适配器）。派任务前不确定该用哪个 CLI 时先查这个：返回 id/name/type/enabled/useCase/**avgMs（平均完成耗时毫秒，0=暂无数据）**，再据此调 de_coi_dispatch——avgMs 反映该 CLI 的历史任务平均耗时，**选型时结合任务复杂度参考**（如快任务选 avgMs 小的，深度任务选能力匹配的）（不要派给 enabled=false 的适配器）。',
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
                avgMs: { type: 'integer', description: '平均完成耗时（毫秒；0=暂无完成记录）' },
              },
              required: ['id', 'name', 'type', 'enabled', 'avgMs'],
            },
          },
        },
        required: ['ok', 'adapters'],
      },
      render: (_args, value) => {
        // 平均耗时友好格式化：统一分钟（一位小数，如 0.5 分钟 / 3.2 分钟）；
        // avgMs=0（暂无完成记录）不显示
        const fmtMs = (ms) => (ms > 0 ? `（均耗时 ${(ms / 60000).toFixed(1)} 分钟）` : '')
        const lines = value.adapters.map((a) => `${a.enabled ? '✅' : '⛔'} ${a.id} — ${a.name}（${a.type}）${fmtMs(a.avgMs)}${a.useCase ? `：${a.useCase}` : ''}${a.enabled ? '' : ' [已禁用]'}`)
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
        avgMs: scheduler.adapterAvgMs(a.id),
      })),
    }),
  }

  const cancel = {
    name: 'de_coi_cancel',
    description: '终止一个正在运行的 COI 任务（杀掉整个进程树）。',
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
