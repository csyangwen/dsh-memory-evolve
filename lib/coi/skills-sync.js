/**
 * COI 内置技能同步 — 适配器使用指南的"源头"在插件里。
 *
 * 设计（用户拍板）：AI 使用 COI 的指南 = 正常技能（默认启用，可在
 * 「技能管理」Tab 禁用）。插件包内自带内置技能（skills/ 目录），
 * 插件启动时同步到技能库（~/.agents/skills）：
 *   - 目标不存在 → 复制（装上）
 *   - 目标 x-version 更低 → 整目录覆盖（源头在插件，升级随插件更新）
 *   - 一致 → 跳过
 * 同步以**整目录**为单位（SKILL.md + scripts/ 等辅助文件随技能一起走）；
 * 被禁用的技能文件仍存在，只是不注入模型。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件内置的技能清单（目录名 = 技能名）。 */
export const BUILTIN_SKILLS = [
  'kimi-cli-calling',
  'codex-cli-calling',
  'grok-cli-calling',
  'hermes-cli-calling',
  'memory-consolidate',
]

/**
 * 技能库默认目录（`~/.agents/skills`）。
 *
 * 与 `lib/index.js` 的 `skillDir: null` 哨兵同义：配置里 `null` 表示"用技能库
 * 默认目录"。解析只有一处权威——`resolveConfig()` 会把哨兵实体化成绝对路径，
 * 因此正常路径下这里传进来的一定是字符串；本常量存在的意义是给**调用点**一个
 * 显式兜底（issue #67），而不是让 `syncBuiltinSkills()` 内部藏一个隐式默认值
 * （那会把"配置没解析"这种装配错误变成静默行为）。
 * `tests/skills-sync-default-dir.test.js` 钉住本常量与 `resolveConfig()` 的
 * 解析结果一致，防止两处定义漂移。
 */
export const DEFAULT_SKILL_DIR = join(homedir(), '.agents', 'skills')

/** 从 SKILL.md frontmatter 读 x-version；缺省 0。 */
/**
 * 从 SKILL.md frontmatter 读 x-version；缺省 0。
 *
 * **必须容忍 CRLF**：Windows 上 git（`core.autocrlf=true`）检出的 SKILL.md 是
 * CRLF，而旧写法 `^---\n` 只认 LF——两端都解析成 0，版本门控退化为"永远相等"，
 * 于是 x-version 升级在 Windows 上**静默失效**（首次安装仍会复制，因为目标不
 * 存在；此后的版本升级不再生效）。tests/skills-sync-default-dir.test.js 钉住
 * 两种换行都要解析出同一个版本号。
 * @param {string} text - SKILL.md 全文。
 * @returns {number} frontmatter 里的 x-version，缺失或无法解析时为 0。
 */
function skillVersion(text) {
  const match = String(text).match(/^---\r?\n[\s\S]*?^x-version:[ \t]*(\d+)[ \t]*\r?$/m)
  return match ? Number(match[1]) : 0
}

/**
 * 校验并规范化一段 SKILL.md 内容（技能格式要求）：
 *   - 空内容 / 超上限 → 抛错
 *   - 已有 frontmatter：必须完整（--- 包裹、含 name 与 description），
 *     缺失必填字段 → 抛错（提示用户补全）
 *   - 无 frontmatter：自动补全 name/description 头部
 * frontmatter 的边界行按 `trim()` 比较，因此 CRLF 文本（Windows 复制粘贴）不会
 * 被误判成"没有 frontmatter"而叠加一份新头（原实现 `lines[0] === '---'` 在
 * CRLF 下恒不成立）。校验不通过时原样返回用户文本，不重写换行。
 * @param {string} raw - 用户输入内容。
 * @param {string} skillName - 技能名（补全 frontmatter 用）。
 * @param {string} displayName - 适配器显示名（补全 description 用）。
 * @returns {string} 规范化后的完整 SKILL.md 文本。
 */
export function normalizeSkillText(raw, skillName, displayName) {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('技能内容不能为空')
  if (text.length > 128 * 1024) throw new Error('技能内容超过 128 KiB 上限')
  const lines = text.split('\n')
  if (lines[0].trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (end < 0) throw new Error('frontmatter 未闭合：需要以 --- 结尾的 YAML 头')
    const fm = lines.slice(1, end).join('\n')
    const missing = []
    if (!/^name:[ \t]*\S+/m.test(fm)) missing.push('name')
    if (!/^description:[ \t]*\S+/m.test(fm)) missing.push('description')
    if (missing.length > 0) {
      throw new Error(`frontmatter 缺少必填字段：${missing.join('、')}（SKILL.md 必须含 name 与 description）`)
    }
    return text
  }
  return `---\nname: ${skillName}\ndescription: ${displayName} 的 AI 使用指南（由 dsh-memory-evolve COI 适配器创建）。\n---\n${text}`
}

/**
 * 同步内置技能到用户技能库。
 * 覆盖策略（保护用户编辑）：目标缺失 → 复制；目标 x-version 更低 →
 * 整目录覆盖（插件升级，SKILL.md 与 scripts/ 等辅助文件一起更新）；
 * 否则不动（用户可能编辑过，x-version 未变不覆盖）。
 * @param {string} pluginSkillsDir - 插件包内 skills/ 目录的绝对路径。
 * @param {string} userSkillsDir - 用户技能库目录的绝对路径（~/.agents/skills）。
 *   配置里的 `null` 哨兵必须由调用点先实体化（`resolveConfig()` 或显式传
 *   `DEFAULT_SKILL_DIR`）——本函数不做隐式兜底，收到非字符串直接抛错。
 * @returns {Array<{name:string, action:'synced'|'unchanged'|'missing'}>}
 * @throws {Error} `userSkillsDir` 不是非空字符串（issue #67：装配错误要报得
 *   看得懂，而不是 Node 的 `The "path" argument must be of type string`）。
 */
export function syncBuiltinSkills(pluginSkillsDir, userSkillsDir) {
  if (typeof userSkillsDir !== 'string' || userSkillsDir.length === 0) {
    throw new Error(
      `syncBuiltinSkills: userSkillsDir 必须是技能库目录的绝对路径，收到 ${JSON.stringify(userSkillsDir)}`
      + '——配置里的 null 哨兵需先经 resolveConfig() 或 DEFAULT_SKILL_DIR 实体化',
    )
  }
  const results = []
  for (const name of BUILTIN_SKILLS) {
    const srcDir = join(pluginSkillsDir, name)
    const srcFile = join(srcDir, 'SKILL.md')
    if (!existsSync(srcFile)) {
      results.push({ name, action: 'missing' })
      continue
    }
    const destDir = join(userSkillsDir, name)
    const destFile = join(destDir, 'SKILL.md')
    const srcText = readFileSync(srcFile, 'utf8')
    let action = 'unchanged'
    const needsCopy = !existsSync(destFile)
      || skillVersion(srcText) > skillVersion(readFileSync(destFile, 'utf8'))
    if (needsCopy) {
      rmSync(destDir, { recursive: true, force: true })
      mkdirSync(destDir, { recursive: true })
      cpSync(srcDir, destDir, { recursive: true })
      action = 'synced'
    }
    results.push({ name, action })
  }
  return results
}

/** 插件包内 skills/ 目录（内置技能源头）。导出供测试断言源头确实在包内。 */
export const PLUGIN_SKILLS_DIR = fileURLToPath(new URL('../../skills/', import.meta.url))

/**
 * 启动时同步内置技能——**与 COI 调度解耦**（issue #58）。
 *
 * 判定只看 `coiSyncSkills`，与 `coiEnabled` 无关。此前的调用点在 `installCoi()`
 * 内，而 `installCoi` 由 `coiEnabled` 门控（默认 `false`，本插件本职是记忆/
 * 待办/技能，调度是按需增强）——于是**默认配置下内置技能永远不会进技能库**，
 * 与 §7.5 broadcast 当初"独立子模块挂在 COI 下拆不开"是同款事故。
 *
 * 三个 stage 各自独立、失败不阻断启动：读取 → 同步 → 报告。异常在此收口并打
 * 一行带堆栈的 warn（同步失败绝不影响插件其余功能）。
 *
 * skillDir 的 `null` 哨兵在这里显式实体化——调用点兜底，而不是让
 * `syncBuiltinSkills()` 内部藏一个隐式默认值（那会把"配置没解析"这种装配错误
 * 变成静默行为）。
 * @param {object} config - 已解析插件配置（读 `coiSyncSkills` / `skillDir`）。
 * @param {string} [pluginSkillsDir] - 内置技能源头目录（缺省用包内 skills/，
 *   测试可注入）。
 * @returns {Array<{name:string, action:'synced'|'unchanged'|'missing'}> | null}
 *   同步结果；`coiSyncSkills === false` 或同步抛错时为 null。
 */
export function syncBuiltinSkillsIfEnabled(config, pluginSkillsDir = PLUGIN_SKILLS_DIR) {
  if (config?.coiSyncSkills === false) return null
  const skillDir = config?.skillDir ?? DEFAULT_SKILL_DIR
  try {
    const synced = syncBuiltinSkills(pluginSkillsDir, skillDir)
    const changed = synced.filter((s) => s.action === 'synced').map((s) => s.name)
    const absent = synced.filter((s) => s.action === 'missing').map((s) => s.name)
    // 每次启动都落一行：成功路径此前只在有变更时 log，"技能从来没装上"只能
    // 靠反查技能目录的 mtime 才能发现（issue #67）。
    console.log(
      `[dsh-memory-evolve] 内置技能同步 → ${skillDir}：共 ${synced.length} 个，更新 ${changed.length} 个`
      + `${changed.length > 0 ? `（${changed.join(', ')}）` : ''}`,
    )
    if (absent.length > 0) {
      // 插件包内缺少内置技能 = 打包事故，不能静默
      console.warn(`[dsh-memory-evolve] 插件包内缺少内置技能，未同步：${absent.join(', ')}（检查 skills/ 是否随包发布）`)
    }
    return synced
  } catch (error) {
    console.warn(`[dsh-memory-evolve] 内置技能同步失败（忽略，不影响启动）：${error?.stack ?? String(error)}`)
    return null
  }
}
