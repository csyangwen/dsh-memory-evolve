/**
 * COI 模块组装器 — 模块边界入口。
 *
 * installCoi(ctx, config, deps) 创建全部 COI 存储与调度器，并注册
 * 模型工具 / slash 命令 / Web API。对外只暴露一个 svc 对象；与记忆模块
 * 的交互仅通过 deps.memoryStore（写摘要）这一个薄接口——未来拆成独立
 * 插件时替换该回调即可，模块内部零改动。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { translate, getLocale, COI2_DICT, NOTIFY_DICT } from '../i18n.js'

/** Translate through NOTIFY_DICT in the active host locale. */
const cnt = (key, params) => translate(NOTIFY_DICT, key, params, getLocale())

/** Translate through COI2_DICT in the active host locale. */
const cix2 = (key, params) => translate(COI2_DICT, key, params, getLocale())
import { fileURLToPath } from 'node:url'
import { AdapterStore } from './adapters.js'
import { SessionStore } from './session-store.js'
import { TaskStore } from './tasks-store.js'
import { TemplateStore } from './templates.js'
import { CoiScheduler } from './scheduler.js'
import { coiToolDefinitions } from './tools.js'
import { coiCommand } from './commands.js'
import { installCoiApi } from './api.js'
import { BroadcastStore, messageToolDefinition } from './broadcast.js'
import { installBroadcastApi } from './broadcast-api.js'
import { PresenceTracker } from './presence.js'
import { readAliases } from '../aliases.js'
import { normalizeSkillText, syncBuiltinSkills } from './skills-sync.js'

/** 插件包内 skills/ 目录（内置技能源头）。 */
const PLUGIN_SKILLS_DIR = fileURLToPath(new URL('../../skills/', import.meta.url))

/** COI 运行时配置（GUI 可改，持久化到 coi/config.json）。 */
const RUNTIME_DEFAULTS = {
  coiNotifyCommand: null,   // 任务完成通知命令模板（null=不通知）
  coiNotifyChannels: null,  // 任务完成渠道通知（de_notify 通道）：逗号分隔渠道名
                            // （如 "feishu" / "feishu,qq"；null/''=不自动通知）。
                            // 依赖 notify 模块（notifyEnabled）与对应渠道插件
                            // 注册表；未启用时静默跳过，不影响调度。
  coiRetentionDays: 90,     // 留档保留天数
  coiTaskTimeoutMs: 43200000, // 任务默认超时（12 小时；AI 任务动辄数小时，超时仅作兜底防线）
  // 注：记忆注入无全局默认——由 AI 每次派发时经 injectTracks 自主选择
  // （曾有过 coiDefaultInjectContext 默认注入开关，已移除：它诱导 AI 为了
  // 拿记忆而选 project scope，且默认注入有隐私风险，注入与否应交每次调用决定）
}

function loadRuntime(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { ...RUNTIME_DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch (error) {
    if (error.code === 'ENOENT') return { ...RUNTIME_DEFAULTS }
    throw error
  }
}

function saveRuntime(file, runtime) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(runtime, null, 2) + '\n')
  renameSync(tmp, file)
}

/** 校验一个 COI 运行时配置补丁；非法抛错。 */
export function validateCoiRuntimePatch(patch) {
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case 'coiNotifyCommand':
        if (value !== null && typeof value !== 'string') throw new Error('coiNotifyCommand 必须是字符串或 null')
        break
      case 'coiNotifyChannels':
        if (value !== null && typeof value !== 'string') throw new Error('coiNotifyChannels 必须是字符串（如 "feishu" / "feishu,qq"）或 null')
        break
      case 'coiRetentionDays':
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) throw new Error('coiRetentionDays 必须是 >= 1 的数字')
        break
      case 'coiTaskTimeoutMs':
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 1000) throw new Error('coiTaskTimeoutMs 必须是 >= 1000 的数字')
        break
      default:
        throw new Error(`未知 COI 配置项 "${key}"`)
    }
  }
  return true
}

/** 生成通知命令（模板占位符：{taskId} {coi} {status} {summary}）。 */
function makeNotify(commandTemplate) {
  if (!commandTemplate) return undefined
  return ({ taskId, coi, status, summary }) => {
    // 注入防护：{summary} 来自 COI 任务输出（不可信，AI 输出含反引号/
    // $()/分号是常态），绝不直接拼进 shell 命令——改走环境变量注入，
    // 模板中替换为双引号引用的 "$DSH_COI_SUMMARY"，shell 展开时不会
    // 二次解析值内的元字符，从根上杜绝命令注入（P1-1）。
    // 其余占位符（taskId/coi/status）来自插件内部受控值，可直接替换。
    const text = String(commandTemplate)
      .replaceAll('{taskId}', taskId ?? '')
      .replaceAll('{coi}', coi ?? '')
      .replaceAll('{status}', status ?? '')
      .replaceAll('{summary}', '"$DSH_COI_SUMMARY"')
    try {
      const child = spawn('sh', ['-c', text], {
        stdio: 'ignore',
        detached: true,
        env: {
          ...process.env,
          DSH_COI_SUMMARY: String(summary ?? '').slice(0, 200).replaceAll('\n', ' '),
        },
      })
      child.on('error', () => { /* 通知失败静默 */ })
      child.unref?.()
    } catch {
      /* 通知失败不影响任务 */
    }
  }
}

/**
 * 生成任务完成通知回调：**外部命令**（coiNotifyCommand）+ **渠道通知**
 * （coiNotifyChannels，de_notify 通道）组合，两者可并存互不干扰。
 * 渠道通知内容为固定模板（无用户输入面，无需注入防护）；渠道未启用/
 * 未注册时 sendChannelNotify 内部如实返回失败，这里只静默跳过（通知
 * 失败绝不影响任务调度）。两者都没有配置时返回 undefined（scheduler
 * 零开销不调用）。
 * @param {object} cfg - schedulerConfig（含 coiNotifyCommand/coiNotifyChannels）。
 * @param {object} deps - { sendChannelNotify? }（主插件注入的渠道发送回调）。
 * @returns {Function | undefined} 通知回调（无任何配置时 undefined）。
 */
/**
 * 邮件式通知正文（用户拍板 2026-08-09）：开头保留 `[COI] 任务 xx（渠道）状态`
 * 标记行（与旧格式一致，一眼认出是任务通知），随后按邮件要素排版——
 * 📮 主题 / 📝 简介 / 👤 发送人 / 🕐 时间，最后是 📄 完整内容（写在最后面，
 * 与旧格式 summary 置尾一致）。简介=内容前 60 字（一句话摘要），内容=summary
 * 压缩换行后 120 字（防刷屏）。emoji + 分隔线提升可读性（飞书/微信均支持）。
 * 独立导出便于测试断言模板。
 */
function fmtNotifyStamp() {
  const d = new Date()
  const pad2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function buildChannelContent(taskId, coi, status, summary) {
  const id = taskId ?? ''
  const name = coi ?? ''
  const oneLine = String(summary ?? '').replace(/\s+/g, ' ').trim()
  const intro = oneLine.slice(0, 60)
  const body = oneLine.slice(0, 120)
  const bar = '━━━━━━━━━━━━━━━━━━━━━━━━'
  return [
    `${cnt('coin.head', { id, name, status: status ?? '' })}`,
    bar,
    `${cnt('coin.subject', { id, name })}`,
    `${cnt('coin.intro', { intro })}`,
    `${cnt('coin.sender')}`,
    `${cnt('coin.time', { time: fmtNotifyStamp() })}`,
    bar,
    `${cnt('coin.bodyHead')}`,
    body,
  ].join('\n')
}

export function buildNotify(cfg, deps) {
  const cmdNotify = makeNotify(cfg.coiNotifyCommand)
  const channels = typeof cfg.coiNotifyChannels === 'string' && cfg.coiNotifyChannels.trim() !== ''
    ? cfg.coiNotifyChannels.trim()
    : null
  if (!cmdNotify && !channels) return undefined
  return ({ taskId, coi, status, summary }) => {
    if (cmdNotify) {
      try { cmdNotify({ taskId, coi, status, summary }) } catch { /* 通知失败不影响任务 */ }
    }
    if (channels && deps.sendChannelNotify) {
      try {
        // fire-and-forget：调度器不等待通知完成；异步 rejection 必须
        // 挂 catch（否则 unhandledRejection 崩进程——通知失败绝不影响任务）
        void Promise.resolve(deps.sendChannelNotify({
          channels,
          // 邮件式模板（buildChannelContent）：标记行 + 主题/简介/发送人/时间，
          // 内容置尾；taskId/coi/status 来自插件内部，summary 走纯文本参数
          // （无 shell 面），换行压缩 + 长度截断防刷屏
          content: buildChannelContent(taskId, coi, status, summary),
        })).catch(() => { /* 渠道通知失败不影响任务 */ })
      } catch { /* 同步异常同样静默 */ }
    }
  }
}

/**
 * 安装 COI 模块。
 * @param {object} ctx - 插件上下文（tools 已注入；commands/httpServer 动态注入）。
 * @param {object} config - 已解析插件配置（含 coi* 项）。
 * @param {object} deps - { memoryStore, resolveCwd }
 *   memoryStore：记忆模块的 MemoryStore 实例（摘要沉淀只走 store.add 一个方法）。
 *   resolveCwd(sessionId)：web 请求的会话工作目录解析（缺省返回 undefined）。
 * @returns {object} svc — { scheduler, sessions, adapters, templates, tasks,
 *   runtimeConfig, updateRuntimeConfig }。
 */
export function installCoi(ctx, config, deps) {
  const coiDataDir = config.coiDataDir
  mkdirSync(coiDataDir, { recursive: true })

  // 内置技能同步：适配器使用指南的源头在插件（skills/ 目录），启动时
  // 同步到技能库——默认启用、技能管理 Tab 可禁用、随插件升级更新。
  // 失败静默（技能同步不影响调度）。
  if (config.coiSyncSkills !== false) {
    try {
      const synced = syncBuiltinSkills(PLUGIN_SKILLS_DIR, config.skillDir)
      const changed = synced.filter((s) => s.action === 'synced')
      if (changed.length > 0) {
        console.log(`[dsh-memory-evolve] COI 内置技能已同步：${changed.map((s) => s.name).join(', ')}`)
      }
    } catch (error) {
      console.warn(`[dsh-memory-evolve] COI 内置技能同步失败（忽略）：${error.message}`)
    }
  }

  const adapters = new AdapterStore(join(coiDataDir, 'adapters.json'))
  const sessions = new SessionStore(join(coiDataDir, 'sessions.json'))
  const templates = new TemplateStore(join(coiDataDir, 'templates.json'))
  const tasks = new TaskStore(coiDataDir, {
    maxLogBytes: config.coiMaxLogBytes,
    retentionDays: config.coiRetentionDays,
  })

  // 运行时配置（文件优先于静态配置）
  const runtimeFile = join(coiDataDir, 'config.json')
  const runtime = loadRuntime(runtimeFile)
  const schedulerConfig = {
    ...config,
    coiNotifyCommand: runtime.coiNotifyCommand ?? config.coiNotifyCommand ?? null,
    coiNotifyChannels: runtime.coiNotifyChannels ?? config.coiNotifyChannels ?? null,
    coiRetentionDays: runtime.coiRetentionDays ?? config.coiRetentionDays ?? RUNTIME_DEFAULTS.coiRetentionDays,
    coiTaskTimeoutMs: runtime.coiTaskTimeoutMs ?? config.coiTaskTimeoutMs ?? RUNTIME_DEFAULTS.coiTaskTimeoutMs,
  }

  // 摘要沉淀：内部直连记忆模块（薄接口，失败静默）
  const writeSummary = config.coiSummaryEnabled !== false
    ? ({ cwd, branch, text }) => {
        const agent = cwd ? { session: { header: { cwd } } } : undefined
        if (agent) {
          const result = deps.memoryStore.add('project', `${text}（${branch ? `分支 ${branch}，` : ''}可 /de_coi 恢复会话）`, agent)
          if (!result.ok) throw new Error(result.message)
        }
        const dailyResult = deps.memoryStore.add('daily', text, agent)
        if (!dailyResult.ok) throw new Error(dailyResult.message)
      }
    : undefined

  // 图片附件依赖（P2，均可选）：attachments=DSH 新快照的附件服务（会话图片
  // attachmentId 来源读取字节必需）；agents=会话事件解析 ImageBlock 完整 ref。
  // 用 ctx.get 动态获取（插件未声明 inject 这两个服务；旧运行时不存在时
  // 取不到 → 附件 attachmentId 来源如实报错，path/url 来源不受影响）。
  let attachmentsStore
  let agentsService
  try {
    attachmentsStore = ctx.get('attachments')
    agentsService = ctx.get('agents')
  } catch {
    /* 服务不可用：保持 undefined（附件 attachmentId 来源会明确报错） */
  }

  const scheduler = new CoiScheduler(ctx, {
    adapters,
    sessions,
    tasks,
    config: schedulerConfig,
    writeSummary,
    notify: buildNotify(schedulerConfig, deps),
    // 记忆上下文注入（模块边界：由主插件提供，读取 AGENTS/memory/user/key）
    memoryContext: deps.memoryContext,
    // 图片附件服务（可选，见上）
    attachmentsStore,
    agentsService,
  })
  scheduler.recover()

  // 留档清理接线（P1-4）：prune 此前无人调用，coiRetentionDays 配置
  // 形同虚设（tasks.json 与 logs/ 只增不减）。启动时跑一次 + 每日
  // 定时清理（unref 不阻止进程退出）；prune 内部保留 running/queued/
  // interrupted 任务，不会误删进行中的记录。
  const pruneTimer = setInterval(() => {
    try { tasks.prune() } catch { /* 清理失败不影响调度 */ }
  }, 24 * 3600 * 1000)
  pruneTimer.unref?.()
  try { tasks.prune() } catch { /* 启动清理失败不影响调度 */ }

  const svc = {
    scheduler,
    sessions,
    adapters,
    templates,
    tasks,
    config: schedulerConfig,
    runtimeConfig: () => ({ ...runtime }),
    /**
     * 读适配器关联技能的 SKILL.md（AI 使用指南所在技能）。
     * @param {string} adapterId
     * @returns {{ok:boolean, skillName?:string, exists?:boolean, path?:string, content?:string, message?:string}}
     */
    readSkill: (adapterId) => {
      const adapter = adapters.get(adapterId)
      if (!adapter) return { ok: false, message: cix2('coi2.adapterUnknown', { id: adapterId }) }
      const skillName = adapter.skillName
      if (!skillName) return { ok: false, message: cix2('coi2.adapterNoSkill', { id: adapterId }) }
      const file = join(config.skillDir, skillName, 'SKILL.md')
      try {
        const content = readFileSync(file, 'utf8')
        return { ok: true, skillName, exists: true, path: file, content }
      } catch (error) {
        if (error.code === 'ENOENT') return { ok: true, skillName, exists: false, path: file, content: '' }
        return { ok: false, message: cix2('coi2.skillReadFailed', { detail: error.message }) }
      }
    },
    /**
     * 写适配器关联技能的 SKILL.md（编辑保存；保留 frontmatter 版本，
     * 同步逻辑见 skills-sync——用户编辑后内置版本不变则不覆盖）。
     * @param {string} adapterId
     * @param {string} content
     * @returns {{ok:boolean, message?:string}}
     */
    writeSkill: (adapterId, content) => {
      const adapter = adapters.get(adapterId)
      if (!adapter) return { ok: false, message: cix2('coi2.adapterUnknown', { id: adapterId }) }
      const skillName = adapter.skillName
      if (!skillName) return { ok: false, message: cix2('coi2.adapterNoSkill', { id: adapterId }) }
      let text
      try {
        text = normalizeSkillText(content, skillName, adapter.name)
      } catch (error) {
        return { ok: false, message: error.message }
      }
      const file = join(config.skillDir, skillName, 'SKILL.md')
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, text)
        return { ok: true, message: cix2('coi2.skillSaved', { skill: skillName }) }
      } catch (error) {
        return { ok: false, message: cix2('coi2.skillSaveFailed', { detail: error.message }) }
      }
    },
    updateRuntimeConfig: (patch) => {
      validateCoiRuntimePatch(patch)
      Object.assign(runtime, patch)
      saveRuntime(runtimeFile, runtime)
      Object.assign(schedulerConfig, runtime)
      // 通知热更新：命令 + 渠道组合回调一起重建（配置变更即时生效）
      scheduler.notify = buildNotify(schedulerConfig, deps)
      scheduler.tasks.retentionDays = runtime.coiRetentionDays
      return { ok: true, config: { ...runtime } }
    },
  }

  // 注册与卸载收集（运行时开关可整体安装/卸载）
  const disposers = []
  // prune 每日定时器随模块卸载一并清理
  disposers.push(() => clearInterval(pruneTimer))

  // 模型工具（DSH Agent 派活入口）
  disposers.push(ctx.effect(() => {
    const toolDisposers = coiToolDefinitions(scheduler).map((tool) => ctx.tools.register(tool))
    return () => toolDisposers.forEach((d) => d?.())
  }, 'dsh-memory-evolve: coi tools'))

  // slash 命令（/de_coi 族）
  ctx.inject(['commands'], (cmdCtx) => {
    const d = cmdCtx.commands.register(coiCommand(svc))
    disposers.push(d)
  })

  // Web API（web-only 服务动态注入）
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const d = installCoiApi(webCtx, { ...svc, resolveCwd: deps.resolveCwd })
      disposers.push(d)
    }, 'dsh-memory-evolve: coi web api')
  })

  // 卸载清理：释放全部定时器/进程句柄
  ctx.effect(() => () => scheduler.dispose(), 'dsh-memory-evolve: coi scheduler')

  /** 整体卸载（coiEnabled 运行时关闭时调用）。 */
  const dispose = () => {
    for (const d of disposers) {
      try { d?.() } catch { /* 忽略 */ }
    }
    try { scheduler.dispose() } catch { /* 忽略 */ }
  }

  return { svc, dispose }
}

/**
 * 会话广播独立装配（用户拍板 2026-08-08：明显独立的子模块不要挂在别的
 * 模块下——曾跟随 coiEnabled 导致开关联动、工具上下文污染，故拆出）。
 * 由主插件在 broadcastEnabled 打开时调用：创建独立存储、注册
 * de_broadcast 工具、prune 每日定时清理。**不依赖 COI 调度器**。
 * @param {object} ctx - cordis ctx（需注入 tools）。
 * @param {object} config - resolved plugin config（含 broadcastDataDir、
 *   memoryDir；broadcastDataDir 缺省 = <memoryDir>/broadcast）。
 * @returns {{ dispose: () => void }} 卸载句柄（broadcastEnabled 关闭时调用）。
 */
export function installBroadcast(ctx, config) {
  const dir = config.broadcastDataDir ?? join(config.memoryDir ?? '', 'broadcast')
  const broadcast = new BroadcastStore(dir)
  // —— 2026-08-13 用户拍板：广播改独立消息投递（快照段已移除）——
  // DSH 快照按整体文本 diff 注入：广播段（未读清单+房间动态）一变就拉着
  // 记忆/纪律等其他段一起重注入（噪声）。与 COI/工作区公告板同款处理：
  // 新消息/成员状态变化时向接收方会话投递**独立消息**，AI 收到后用
  // de_broadcast read 处理——收件箱语义不变（通知 ≠ 已读）。缺省 inject
  // 不唤醒；2026-09-01 起 send 可带 wake=true 把 idle 接收方 followup
  // 唤醒（见 deliver）。
  let agentsService = null
  try { agentsService = ctx.get('agents') } catch { /* 旧运行时：无独立消息投递 */ }
  /** 本进程内已见过的会话：首次出现补投未读汇总（重启前的未读不丢）。 */
  const seenSessions = new Set()

  /**
   * 投递一条插件 notice 形态的用户消息。缺省 inject（不唤醒，下一步可见）；
   * wake=true 且接收方 idle 时改用 followup——投递到下一回合并唤醒驱动
   * （等价替用户发消息，与 de_session wake / COI wakeOnComplete 同款机制，
   * DSH 核心 agent.ts：followup=send(next-turn, wakeup=true)）。接收方
   * running 时一律 inject（消息当前回合下一步即被认领，不打断进行中的
   * 回合）；offline（agents.get 无值）无驱动可唤，跳过（消息已在收件箱，
   * 会话回来由首次出现补投/自主 read 兜底）。唤醒的消息体追加标记，让
   * 接收方明白这个回合是发送方唤醒产生的。
   * @returns {{delivered: boolean, woken: boolean}} 是否投递成功 / 是否实际唤醒。
   */
  const deliver = (sessionId, text, wake = false) => {
    if (!agentsService) return { delivered: false, woken: false }
    const agent = agentsService.get(sessionId)
    if (!agent) return { delivered: false, woken: false }
    const source = { kind: 'plugin', plugin: 'dsh-memory-evolve', form: 'notice', summary: text.split('\n')[0].slice(0, 80) }
    if (wake && agent.status === 'idle') {
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `${text}（发送方唤醒了你——请立即处理本条）` }],
        source,
      })
      return { delivered: true, woken: true }
    }
    agent.inject({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source,
    })
    return { delivered: true, woken: false }
  }

  /** 发送方显示名：别名优先（保留短 ID 供 read/回复），否则短 ID。 */
  const senderName = (sid) => {
    try {
      const aliases = config.memoryDir ? readAliases(config.memoryDir) : {}
      if (aliases && typeof aliases === 'object' && typeof aliases[sid] === 'string') return `${aliases[sid]}（${sid.slice(0, 12)}）`
    } catch { /* 无别名：短 ID */ }
    return sid.length > 12 ? `${sid.slice(0, 12)}…` : sid
  }

  // 会话在线状态追踪（presence）：监听 agent/status，供 de_broadcast
  // presence action 查询房间成员谁在线（running）/谁已离线（idle）。
  // 传广播目录持久化 lastActiveAt（presence.json）：dsh 重启后成员仍
  // 显示最近活动时间，而不是全部退化成 unknown。
  // onChange：成员 running⇄idle 切换 → 向同房其他成员投递房间动态独立
  // 消息（合并 + 节流，见 enqueueDyn；只记房间成员变化，非成员零事件；
  // 房间只有自己时事件无人可看，也跳过）。
  const presence = new PresenceTracker(ctx, dir, (sessionId, prevStatus, nextStatus) => {
    try {
      const rooms = broadcast.rooms.roomsOf(sessionId)
      if (rooms.length === 0) return
      const who = senderName(sessionId)
      const kind = nextStatus === 'running' ? 'running' : 'idle'
      for (const room of rooms) {
        const others = room.members.filter((m) => m !== sessionId)
        if (others.length === 0) continue // 房间只有自己：事件无人可看
        for (const m of others) enqueueDyn(m, room, who, kind)
      }
    } catch { /* 投递失败不影响 presence 状态维护 */ }
  })

  /** 新广播消息落盘后：向接收方（在线会话）投递独立消息。wake=true 时
   *  idle 接收方被 followup 唤醒（见 deliver）；返回实际唤醒数供调用方
   *  回执。 */
  const notifyRecipients = (msg, wake = false) => {
    const subject = String(msg.subject ?? '').slice(0, 60)
    const text = `【广播消息】「${subject || '（无主题）'}」来自 ${msg.sender === 'system' ? '系统' : senderName(msg.sender)}——用 de_broadcast read ${msg.id} 查看全文并处理`
    let woken = 0
    for (const r of msg.recipients) {
      if (r.startsWith('room:')) {
        const room = broadcast.rooms.get(r.slice(5))
        for (const m of room?.members ?? []) {
          if (m !== msg.sender && deliver(m, text, wake).woken) woken += 1
        }
      } else if (r.startsWith('project:')) {
        const path = r.slice(8)
        for (const [sid, rec] of presence.agents) {
          if (sid !== msg.sender && rec?.cwd === path && deliver(sid, text, wake).woken) woken += 1
        }
      } else if (r !== msg.sender) {
        if (deliver(r, text, wake).woken) woken += 1
      }
    }
    return woken
  }
  // send 包一层：工具 execute / API / 系统通知（房间解散/踢人）共用实例，
  // 统一在落盘后走接收方投递。wake 是**投递行为参数**（不落盘、store 忽
  // 略未知字段）：de_broadcast 工具 send 的 wake=true 传到这里生效；系统
  // 通知等其余调用方不带 wake → 保持 inject 不唤醒。
  const origSend = broadcast.send.bind(broadcast)
  broadcast.send = (req) => {
    const wake = req?.wake === true
    const result = origSend(req)
    if (result.ok && result.item) {
      try { result.woken = notifyRecipients(result.item, wake) } catch { /* 投递失败不影响发送 */ }
    }
    return result
  }

  // —— 房间动态投递（合并 + 节流）——
  // 用户拍板：状态变化不需要逐条——同一接收成员 30s 窗口内的连续变化
  // 合并为一条（待投内容覆盖为最新状态），15s 定时器 flush；窗口外立即投。
  const DYN_NOTIFY_MS = 30 * 1000
  const DYN_FLUSH_MS = 15 * 1000
  const lastDynAt = new Map()
  const pendingDyn = new Map()
  const dynText = (p) => p.kind === 'running'
    ? `【房间动态】${p.who} 开始干活（${p.roomName}）——正在生成，可直接向它发消息，它回合内可见`
    : `【房间动态】${p.who} 干完/闲了（${p.roomName}）——已结束回合，要它干活需 de_session wake，别傻等`
  const enqueueDyn = (memberId, room, who, kind) => {
    const p = { roomName: room.name ?? room.id, who, kind }
    if (Date.now() - (lastDynAt.get(memberId) ?? 0) >= DYN_NOTIFY_MS) {
      deliver(memberId, dynText(p))
      lastDynAt.set(memberId, Date.now())
    } else {
      pendingDyn.set(memberId, p) // 节流窗口内：合并待投（覆盖为最新状态）
    }
  }
  const flushDyn = () => {
    if (pendingDyn.size === 0) return
    for (const [memberId, p] of pendingDyn) {
      deliver(memberId, dynText(p))
      lastDynAt.set(memberId, Date.now())
    }
    pendingDyn.clear()
  }
  const dynTimer = setInterval(() => {
    try { flushDyn() } catch { /* 投递失败不影响 */ }
  }, DYN_FLUSH_MS)
  dynTimer.unref?.()

  // —— 会话首次出现（进程重启/新会话）：补投未读广播汇总 ——
  // 独立消息只投给在线会话；重启前的未读不会因此丢失——会话醒来（首次
  // 状态事件）时把未读清单汇总投给它，模型收到后仍需 de_broadcast read
  // 处理（收件箱语义：通知 ≠ 已读）。
  const notifyUnread = (sessionId, cwd) => {
    const count = broadcast.unreadCount(sessionId, cwd)
    if (count === 0) return
    const recent = broadcast.forSession(sessionId, cwd)
      .filter((m) => !m.readBy.includes(sessionId))
      .slice(0, 3)
    const sample = recent
      .map((m) => `「${String(m.subject ?? '').slice(0, 30) || '（无主题）'}」来自 ${m.sender === 'system' ? '系统' : senderName(m.sender)}`)
      .join(' / ')
    deliver(sessionId, `【会话广播】你有 ${count} 条未读广播消息（最新：${sample}）——用 de_broadcast list/read 逐条查看并处理`)
  }

  // 每日清理 + 启动清理（unref 不阻止进程退出；30 天过期消息含长内容文件）
  const pruneTimer = setInterval(() => {
    try { broadcast.prune() } catch { /* 清理失败不影响使用 */ }
  }, 24 * 3600 * 1000)
  pruneTimer.unref?.()
  try { broadcast.prune() } catch { /* 启动清理失败不影响使用 */ }

  const disposers = []
  disposers.push(() => clearInterval(pruneTimer))
  disposers.push(() => clearInterval(dynTimer))
  disposers.push(() => presence.dispose())
  disposers.push(ctx.effect(() => {
    // svc：presence 显示会话名称/别名用（agents/sessionTitle 已插件级
    // 声明式注入——名称需 live 会话；任一不可用则 title=null 兼容）
    const d = ctx.tools.register(messageToolDefinition(broadcast, presence, config.memoryDir, { agents: ctx.agents, sessionTitle: ctx.sessionTitle }, config.broadcastImageEnabled !== false))
    return () => d?.()
  }, 'dsh-memory-evolve: broadcast tool'))
  // 补投未读（会话首次状态事件触发；独立 seen 集合，与 presence 内部
  // 首次记录互不干扰）
  disposers.push(ctx.effect
    ? ctx.effect(() => ctx.on('agent/status', ({ agent }) => {
        try {
          const sessionId = agent?.session?.id
          if (!sessionId || seenSessions.has(sessionId)) return
          seenSessions.add(sessionId)
          notifyUnread(sessionId, agent?.session?.header?.cwd)
        } catch { /* 补投失败不影响 */ }
      }), 'dsh-memory-evolve: broadcast unread catchup')
    : () => {})

  // Web 管理面板 API（广播启用时注册；面板 Tab 探测该 API 存在才显示）
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const d = installBroadcastApi(webCtx, { broadcast, presence })
      disposers.push(d)
    }, 'dsh-memory-evolve: broadcast web api')
  })

  return {
    store: broadcast,
    presence,
    dispose() {
      for (const d of disposers) {
        try { d?.() } catch { /* 忽略 */ }
      }
    },
  }
}
