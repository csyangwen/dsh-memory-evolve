/**
 * COI 适配器注册表 — 描述"如何调用某个 CLI"的声明。
 *
 * 适配器（Adapter）是 dsh-coi-hub 的扩展点：内置四家 AI CLI
 * （kimi / codex / grok / hermes）开箱即用，用户在 UI/API 里可自定义
 * 添加其他 CLI（含无会话恢复能力的 plain-cli 普通命令）。
 *
 * 适配器定义字段：
 *   id            string   唯一标识（小写字母数字连字符）
 *   skillName     string   关联技能名（AI 使用指南所在技能；默认由插件内置提供）
 *   useCase       string   适用场景说明（AI 选择适配器时参考）
 *   enabled       boolean  是否启用（缺省 true；用户可禁用不可用的 COI）
 *   name          string   显示名
 *   type          'ai-cli' | 'plain-cli'  是否有会话恢复能力
 *   binary        string   可执行命令名（PATH 内）
 *   args          string[] 基础参数模板，占位符：{task} {workdir} {model}
 *   resume        { kind:'flag', flag, arg } | { kind:'args', args }   指定会话恢复（ai-cli）
 *   continue      { kind:'flag', flag }     | { kind:'args', args }    最近会话恢复（ai-cli）
 *   sessionIdExtract { source:'stdout'|'stderr'|'any', regex }  session id 提取规则（ai-cli）
 *   outputParse   'text' | 'stream-json' | 'jsonl' | 'ndjson'  结构化流解析（预留）
 *   defaults      { timeoutMs, model? }    默认参数
 *   mgmtCmds      { list?: string[], export?: string[], delete?: string[] }  管理子命令（可选）
 *   env           object                   附加环境变量（可选）
 *   guide         string   内置使用指南（markdown，GUI 可查看）
 *   testCmd       string[] 测试按钮执行命令（如 ["-p","只回答数字：1+1"]）
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 内置四家 AI CLI 适配器（开箱即用）。guide 为简明使用指南。 */
export const BUILTIN_ADAPTERS = {
  kimi: {
    id: 'kimi',
    name: 'Kimi Code',
    useCase: '前端开发/界面与交互、中等复杂度任务、识图（读截图/照片内容）——Web 全栈快速开发首选',
    skillName: 'kimi-cli-calling',
    type: 'ai-cli',
    binary: 'kimi',
    args: ['-p', '{task}'],
    resume: { kind: 'flag', flag: '-S', arg: '{sessionId}' },
    continue: { kind: 'flag', flag: '-c' },
    sessionIdExtract: { source: 'any', regex: 'To resume this session: kimi -r (session_\\S+)' },
    outputParse: 'text',
    defaults: { timeoutMs: 1800000 },
    mgmtCmds: { export: ['export'] },
    env: {},
    testCmd: ['-p', '只回答数字：1+1'],
    guide: `# Kimi Code 使用指南




**配套技能**：AI 使用本适配器的完整细则见技能 \`kimi-cli-calling\`（由 dsh-memory-evolve 插件内置提供，默认启用；可在「技能管理」Tab 中禁用）。

**调用方式**：\`kimi -p "<任务>"\`（prompt 模式，非交互打印结果后退出）。

**会话恢复**：
- 指定会话：\`kimi -S <sessionId> -p "<任务>"\`（session id 形如 \`session_<uuid>\`）
- 最近会话：\`kimi -c -p "<任务>"\`
- 每次运行末尾会打印 \`To resume this session: kimi -r session_xxx\`，插件自动捕获入库

**注意事项**：
- prompt 必须跟在 \`-p\` 后面，不能作为裸位置参数（否则报 unknown command）
- \`-p\` 不能与 \`-y/--yolo\`、\`--auto\` 组合
- 需要可写 \`~/.kimi-code/\`（每次运行写会话目录）
- 完整 agent，任务耗时几十秒到几分钟，请耐心等待；简单问题 120s 起，复杂任务 600s 以上
- 大文件别塞进命令行，给文件路径让 kimi 自己读
- 识图：prompt 里写明图片绝对路径

**其他入口**：\`kimi export [sessionId]\` 导出 ZIP；\`kimi login\` 登录；\`kimi doctor\` 校验配置。`,
  },
  codex: {
    id: 'codex',
    name: 'Codex (OpenAI)',
    useCase: '复杂逻辑与后端、测试修复、代码审查、PR/大型改动——深度工程任务首选',
    skillName: 'codex-cli-calling',
    type: 'ai-cli',
    binary: 'codex',
    args: ['exec', '{task}'],
    resume: { kind: 'args', args: ['exec', 'resume', '{sessionId}', '{task}'] },
    continue: { kind: 'args', args: ['exec', 'resume', '--last', '{task}'] },
    sessionIdExtract: { source: 'stderr', regex: 'session id: (\\S+)' },
    outputParse: 'text',
    defaults: { timeoutMs: 1800000 },
    mgmtCmds: {},
    env: {},
    testCmd: ['exec', '--ephemeral', '只回答数字：1+1'],
    guide: `# Codex 使用指南

**配套技能**：AI 使用本适配器的完整细则见技能 \`codex-cli-calling\`（由 dsh-memory-evolve 插件内置提供，默认启用；可在「技能管理」Tab 中禁用）。
**调用方式**：\`codex exec "<任务>"\`（非交互执行；进度写 stderr，最终答案写 stdout，插件分开收集）。

**会话恢复**：
- 指定会话：\`codex exec resume <sessionId> "<任务>"\`（session id 为 UUID，出现在 stderr 头部 \`session id: xxx\`）
- 最近会话：\`codex exec resume --last "<任务>"\`

**权限与安全**：
- 只读分析：省略 \`--sandbox\`；需要改文件用 \`--sandbox workspace-write\`
- 不要把已弃用的 \`--full-auto\` 写入新脚本；\`--ephemeral\` 不持久化会话
- \`--json\` 输出 JSONL 事件流；\`-o <file>\` 保存最终回答

**其他**：参数以 \`codex exec --help\` 为准；自动化环境凭据用 \`CODEX_API_KEY\` 注入。`,
  },
  grok: {
    id: 'grok',
    name: 'Grok (xAI)',
    useCase: '快速问答、总结日志/文档、需要速度的中等任务——求快首选',
    skillName: 'grok-cli-calling',
    type: 'ai-cli',
    binary: 'grok',
    args: ['-p', '{task}'],
    resume: { kind: 'flag', flag: '-r', arg: '{sessionId}' },
    continue: { kind: 'flag', flag: '-c' },
    sessionIdExtract: { source: 'none', regex: null },
    outputParse: 'text',
    defaults: { timeoutMs: 1800000 },
    mgmtCmds: { list: ['sessions', 'list'], export: ['export'] },
    env: {},
    testCmd: ['-p', '只回答数字：1+1'],
    guide: `# Grok 使用指南

**配套技能**：AI 使用本适配器的完整细则见技能 \`grok-cli-calling\`（由 dsh-memory-evolve 插件内置提供，默认启用；可在「技能管理」Tab 中禁用）。
**调用方式**：\`grok -p "<任务>"\`（单轮 prompt 模式，stdout 就是最终回答，简洁直接）。

**会话恢复**：
- 指定会话：\`grok -r <sessionId> "<任务>"\`（按 ID 或标题匹配）
- 最近会话：\`grok -c\`
- \`grok sessions list\` / \`grok sessions search <关键词>\` 查找历史会话；\`--fork-session\` 新建 ID 复用上下文

**参数**：\`-m <模型>\` 换模型；\`--output-format streaming-json\` 事件流；\`--json-schema\` 约束输出；
\`--permission-mode acceptEdits\` 自动接受编辑；\`--sandbox\` 沙箱配置；\`--prompt-file\` 长文案放文件。

**注意事项**：需要先 \`grok login\`；agent 任务可能耗时数十秒到几分钟；大文件给路径别塞参数。`,
  },
  hermes: {
    id: 'hermes',
    name: 'Hermes Agent',
    useCase: '通用 agent 任务：文件操作、网络、多工具协作、消息推送',
    skillName: 'hermes-cli-calling',
    type: 'ai-cli',
    binary: 'hermes',
    args: ['-z', '{task}'],
    resume: { kind: 'flag', flag: '--resume', arg: '{sessionId}' },
    continue: { kind: 'flag', flag: '-c' },
    sessionIdExtract: { source: 'none', regex: null },
    outputParse: 'text',
    defaults: { timeoutMs: 1800000 },
    mgmtCmds: { list: ['sessions', 'list'], export: ['sessions', 'export'] },
    env: {},
    testCmd: ['-z', '只回答数字：1+1'],
    guide: `# Hermes 使用指南

**配套技能**：AI 使用本适配器的完整细则见技能 \`hermes-cli-calling\`（由 dsh-memory-evolve 插件内置提供，默认启用；可在「技能管理」Tab 中禁用）。
**调用方式**：\`hermes -z "<任务>"\`（oneshot 只打印最终回答，适合脚本）；\`hermes chat -q "<任务>"\` 带过程信息。

**会话恢复**：\`-c\` / \`--resume <sessionId>\`；\`hermes sessions list\` 查会话、\`hermes sessions export\` 导出。

**常用参数**：\`-Q\` 安静模式；\`--max-turns N\` 限制轮数；\`-t 工具集\`（如 \`-t terminal,file\`）；\`-s 技能\` 预加载；\`--yolo\` 跳过审批（慎用）。

**注意事项**：默认加载全部工具，简单问题加 \`--max-turns 3\`；长任务放后台（前台超时 600s）；管道输入避免大文件塞参数。`,
  },
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

/** 校验一个适配器定义；非法时抛错（错误信息即用户可读原因）。 */
export function validateAdapter(def) {
  if (def === null || typeof def !== 'object' || Array.isArray(def)) {
    throw new Error('适配器必须是对象')
  }
  const id = String(def.id ?? '').trim()
  if (!ID_RE.test(id)) throw new Error('id 必须是小写字母数字连字符（1-32 位）')
  if (typeof def.name !== 'string' || def.name.trim() === '') throw new Error('name 不能为空')
  if (def.type !== 'ai-cli' && def.type !== 'plain-cli') throw new Error('type 必须是 ai-cli 或 plain-cli')
  if (typeof def.binary !== 'string' || def.binary.trim() === '') throw new Error('binary 不能为空')
  if (!Array.isArray(def.args) || def.args.length === 0 || def.args.some((a) => typeof a !== 'string')) {
    throw new Error('args 必须是非空字符串数组')
  }
  if (def.type === 'ai-cli') {
    const resume = def.resume
    if (!resume || typeof resume !== 'object') throw new Error('ai-cli 适配器必须有 resume 配置')
    if (resume.kind === 'flag') {
      if (typeof resume.flag !== 'string' || resume.flag === '') throw new Error('resume.flag 不能为空')
    } else if (resume.kind === 'args') {
      if (!Array.isArray(resume.args) || resume.args.length === 0) throw new Error('resume.args 必须是非空数组')
    } else {
      throw new Error('resume.kind 必须是 flag 或 args')
    }
    const cont = def.continue
    if (cont && typeof cont === 'object') {
      if (cont.kind === 'flag' && (typeof cont.flag !== 'string' || cont.flag === '')) throw new Error('continue.flag 不能为空')
      if (cont.kind === 'args' && (!Array.isArray(cont.args) || cont.args.length === 0)) throw new Error('continue.args 必须是非空数组')
    }
    const extract = def.sessionIdExtract
    if (extract && typeof extract === 'object') {
      const source = extract.source
      if (source !== 'stdout' && source !== 'stderr' && source !== 'any' && source !== 'none') {
        throw new Error('sessionIdExtract.source 必须是 stdout/stderr/any/none')
      }
      if (source !== 'none' && (typeof extract.regex !== 'string' || extract.regex === '')) {
        throw new Error('sessionIdExtract.regex 不能为空')
      }
    }
  }
  if (def.defaults && typeof def.defaults !== 'object') throw new Error('defaults 必须是对象')
  if (def.env && typeof def.env !== 'object') throw new Error('env 必须是对象')
  if (def.skillName !== undefined && (typeof def.skillName !== 'string' || def.skillName.trim() === '')) {
    throw new Error('skillName 必须是非空字符串')
  }
  if (def.useCase !== undefined && (typeof def.useCase !== 'string' || def.useCase.trim() === '')) {
    throw new Error('useCase 必须是非空字符串')
  }
  if (def.enabled !== undefined && typeof def.enabled !== 'boolean') {
    throw new Error('enabled 必须是布尔值')
  }
  return true
}

/**
 * 适配器注册表：内置四家 + 用户自定义（持久化到 adapters.json）。
 * 内置适配器可被覆盖（同 id upsert 会替换定义），但 remove 只允许删用户自定义。
 */
export class AdapterStore {
  /** @param {string} file - adapters.json 的绝对路径。 */
  constructor(file) {
    this.file = file
    this.custom = this.#load()
    this.byId = new Map()
    this.#rebuildIndex()
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (error) {
      if (error.code === 'ENOENT') return {}
      throw error
    }
  }

  #save() {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(this.custom, null, 2) + '\n')
    renameSync(tmp, this.file)
  }

  #rebuildIndex() {
    this.byId = new Map()
    for (const [id, def] of Object.entries(BUILTIN_ADAPTERS)) this.byId.set(id, def)
    for (const [id, def] of Object.entries(this.custom)) this.byId.set(id, def)
  }

  /** 全部适配器（含内置）。 */
  list() {
    return [...this.byId.values()]
  }

  /** 按 id 取适配器；不存在返回 undefined。 */
  get(id) {
    return this.byId.get(id)
  }

  /** 新增或覆盖一个适配器（含内置覆盖）；返回校验后的定义。 */
  upsert(def) {
    validateAdapter(def)
    const id = String(def.id).trim()
    if (id in BUILTIN_ADAPTERS) {
      // 内置覆盖：合并到内置对象上（保留 id/type 等关键字段）
      this.byId.set(id, { ...BUILTIN_ADAPTERS[id], ...def, id })
    } else {
      this.custom[id] = { ...def, id }
      this.#save()
      this.#rebuildIndex()
    }
    return this.byId.get(id)
  }

  /** 删除自定义适配器；内置适配器不可删（返回 false）。 */
  remove(id) {
    if (id in BUILTIN_ADAPTERS || !(id in this.custom)) return false
    delete this.custom[id]
    this.#save()
    this.#rebuildIndex()
    return true
  }

  /**
   * 启用/禁用适配器（COI 不可用时用户主动关闭；禁用的适配器调度会被拒绝）。
   * 内置适配器也能禁用：状态记录在 custom 覆盖里持久化。
   * @param {string} id
   * @param {boolean} enabled
   * @returns {{ok:boolean, message:string, adapter?:object}}
   */
  setEnabled(id, enabled) {
    const adapter = this.byId.get(id)
    if (!adapter) return { ok: false, message: `未知适配器 "${id}"` }
    if (typeof enabled !== 'boolean') return { ok: false, message: 'enabled 必须是布尔值' }
    if (id in BUILTIN_ADAPTERS) {
      // 内置：写 custom 覆盖（保留原定义，仅改 enabled）
      this.custom[id] = { ...BUILTIN_ADAPTERS[id], ...(this.custom[id] ?? {}), id, enabled }
      this.#save()
    } else {
      this.custom[id] = { ...this.custom[id], enabled }
      this.#save()
    }
    this.#rebuildIndex()
    return { ok: true, message: `${adapter.name} 已${enabled ? '启用' : '禁用'}`, adapter: this.byId.get(id) }
  }
}

/** 拼装一个适配器的一次调用参数（按模式：new / resume / continue）。 */
export function buildArgs(adapter, { task, cwd, model, sessionId, mode }) {
  const fill = (args) => args.map((arg) => String(arg)
    .replaceAll('{task}', task ?? '')
    .replaceAll('{workdir}', cwd ?? '')
    .replaceAll('{model}', model ?? '')
    .replaceAll('{sessionId}', sessionId ?? ''))
  if (adapter.type !== 'ai-cli' || mode === 'new' || mode === undefined) {
    return fill(adapter.args)
  }
  if (mode === 'resume') {
    const resume = adapter.resume
    // flag 模式：flag + arg 插在基础参数前；args 模式：resume.args 本身
    // 就是完整调用参数（已含 {task} 占位）
    if (resume.kind === 'flag') {
      return fill([resume.flag, resume.arg, ...adapter.args])
    }
    return fill(resume.args)
  }
  if (mode === 'continue') {
    const cont = adapter.continue
    if (cont && cont.kind === 'flag') return fill([cont.flag, ...adapter.args])
    if (cont && cont.kind === 'args') return fill(cont.args)
    // 没有 continue 配置的 ai-cli 退化为新会话
    return fill(adapter.args)
  }
  return fill(adapter.args)
}

/** 从文本中按适配器的提取规则找 session id；找不到返回 undefined。 */
export function extractSessionId(adapter, stdoutText, stderrText) {
  const extract = adapter.sessionIdExtract
  if (!extract || extract.source === 'none' || !extract.regex) return undefined
  const candidates = extract.source === 'stdout' ? [stdoutText]
    : extract.source === 'stderr' ? [stderrText]
      : [stdoutText, stderrText]
  for (const text of candidates) {
    const match = String(text).match(new RegExp(extract.regex))
    if (match) return match[1] ?? match[0]
  }
  return undefined
}
