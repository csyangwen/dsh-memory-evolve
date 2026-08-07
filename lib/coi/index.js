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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdapterStore } from './adapters.js'
import { SessionStore } from './session-store.js'
import { TaskStore } from './tasks-store.js'
import { TemplateStore } from './templates.js'
import { CoiScheduler } from './scheduler.js'
import { coiToolDefinitions } from './tools.js'
import { coiCommand } from './commands.js'
import { installCoiApi } from './api.js'
import { normalizeSkillText, syncBuiltinSkills } from './skills-sync.js'

/** 插件包内 skills/ 目录（内置技能源头）。 */
const PLUGIN_SKILLS_DIR = fileURLToPath(new URL('../../skills/', import.meta.url))

/** COI 运行时配置（GUI 可改，持久化到 coi/config.json）。 */
const RUNTIME_DEFAULTS = {
  coiNotifyCommand: null,   // 任务完成通知命令模板（null=不通知）
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

  const scheduler = new CoiScheduler(ctx, {
    adapters,
    sessions,
    tasks,
    config: schedulerConfig,
    writeSummary,
    notify: makeNotify(schedulerConfig.coiNotifyCommand),
    // 记忆上下文注入（模块边界：由主插件提供，读取 AGENTS/memory/user/key）
    memoryContext: deps.memoryContext,
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
      if (!adapter) return { ok: false, message: `未知适配器 "${adapterId}"` }
      const skillName = adapter.skillName
      if (!skillName) return { ok: false, message: `适配器 ${adapterId} 未关联技能` }
      const file = join(config.skillDir, skillName, 'SKILL.md')
      try {
        const content = readFileSync(file, 'utf8')
        return { ok: true, skillName, exists: true, path: file, content }
      } catch (error) {
        if (error.code === 'ENOENT') return { ok: true, skillName, exists: false, path: file, content: '' }
        return { ok: false, message: `读取技能失败: ${error.message}` }
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
      if (!adapter) return { ok: false, message: `未知适配器 "${adapterId}"` }
      const skillName = adapter.skillName
      if (!skillName) return { ok: false, message: `适配器 ${adapterId} 未关联技能` }
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
        return { ok: true, message: `技能 ${skillName} 已保存（源头为插件内置，重启时版本未变不会覆盖你的编辑）` }
      } catch (error) {
        return { ok: false, message: `保存技能失败: ${error.message}` }
      }
    },
    updateRuntimeConfig: (patch) => {
      validateCoiRuntimePatch(patch)
      Object.assign(runtime, patch)
      saveRuntime(runtimeFile, runtime)
      Object.assign(schedulerConfig, runtime)
      // 通知命令热更新
      scheduler.notify = makeNotify(runtime.coiNotifyCommand)
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
  ctx.inject(['httpServer'], (webCtx) => {
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
