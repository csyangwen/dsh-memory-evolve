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
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包内 skills/ 目录（内置技能源头）。 */
export const PLUGIN_SKILLS_DIR = fileURLToPath(new URL('../../skills/', import.meta.url))

/** 插件内置的技能清单（目录名 = 技能名）。 */
export const BUILTIN_SKILLS = [
  'kimi-cli-calling',
  'codex-cli-calling',
  'grok-cli-calling',
  'hermes-cli-calling',
  'memory-consolidate',
]

/** 从 SKILL.md frontmatter 读 x-version；缺省 0。 */
function skillVersion(text) {
  const match = String(text).match(/^---\n[\s\S]*?^x-version:\s*(\d+)\s*$/m)
  return match ? Number(match[1]) : 0
}

/**
 * 校验并规范化一段 SKILL.md 内容（技能格式要求）：
 *   - 空内容 / 超上限 → 抛错
 *   - 已有 frontmatter：必须完整（--- 包裹、含 name 与 description），
 *     缺失必填字段 → 抛错（提示用户补全）
 *   - 无 frontmatter：自动补全 name/description 头部
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
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end < 0) throw new Error('frontmatter 未闭合：需要以 --- 结尾的 YAML 头')
    const fm = lines.slice(1, end).join('\n')
    const missing = []
    if (!/^name:\s*\S+/m.test(fm)) missing.push('name')
    if (!/^description:\s*\S+/m.test(fm)) missing.push('description')
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
 * @param {string} userSkillsDir - 用户技能库目录（~/.agents/skills）。
 * @returns {Array<{name:string, action:'synced'|'unchanged'|'missing'}>}
 */
export function syncBuiltinSkills(pluginSkillsDir, userSkillsDir) {
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

/**
 * 启动时同步内置技能（与 COI 调度**解耦**）。
 *
 * 技能同步属于「记忆 / 技能管理」能力，不属于 CLI 调度：此前调用点写在
 * installCoi() 内，随 coiEnabled（默认 false）一起被跳过——于是默认配置下
 * 内置技能（含 memory-consolidate）永远不会同步进技能库，与 §7.5 broadcast
 * 当初「挂在 COI 下拆不开」是同款事故。现由插件主装配直接调用，只受
 * coiSyncSkills 控制，启动时一次；失败静默（同步失败不影响插件其余功能）。
 *
 * @param {object} config - 已解析插件配置（skillDir / coiSyncSkills）。
 * @param {string} [pluginSkillsDir] - 插件包内 skills/ 目录（测试可注入）。
 * @returns {Array<{name:string, action:'synced'|'unchanged'|'missing'}>} 同步结果。
 */
export function syncBuiltinSkillsIfEnabled(config, pluginSkillsDir = PLUGIN_SKILLS_DIR) {
  if (config.coiSyncSkills === false) return []
  try {
    const synced = syncBuiltinSkills(pluginSkillsDir, config.skillDir)
    const changed = synced.filter((s) => s.action === 'synced')
    if (changed.length > 0) {
      console.log(`[dsh-memory-evolve] 内置技能已同步：${changed.map((s) => s.name).join(', ')}`)
    }
    return synced
  } catch (error) {
    console.warn(`[dsh-memory-evolve] 内置技能同步失败（忽略）：${error.message}`)
    return []
  }
}
