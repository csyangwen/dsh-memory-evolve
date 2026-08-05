/**
 * dsh-memory-evolve — skill management tool.
 *
 * The `skill_manage` tool lets LLM agents (the background review subagent and
 * ordinary sessions) create and maintain skills in the shared skills
 * directory (`~/.agents/skills` by default — scanned by both DSH's
 * skill-local and Hermes' external dirs).
 *
 * Design:
 *   - `create` writes `<dir>/<name>/SKILL.md`; the name must be kebab-case
 *     (which also rules out path traversal) and the body must be a canonical
 *     SKILL.md whose frontmatter declares name + description;
 *   - `patch` replaces the whole SKILL.md and REQUIRES prior read evidence:
 *     the calling agent's own session log must contain a `tool/call` event
 *     for `skill_manage action=read <name>` (read-before-write, the Hermes
 *     protection against editing skills the agent never actually read);
 *   - disabled skills (any plugin registered a `modelInvocable: false`
 *     shadow through the core `ctx.skills` registry) are skipped — this
 *     reads the shared runtime registry, never another plugin's private
 *     state, so deployments without dsh-skills-manager behave identically;
 *   - sizes are capped; writes are atomic.
 *
 * Zero runtime dependencies (node:fs only).
 *
 * @module dsh-memory-evolve/skills
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Skill name grammar (matches DSH's isSkillName; kebab-case rules out traversal). */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Whether a string is a valid skill name.
 * @param {string} name - the candidate name.
 * @returns {boolean} true for kebab-case lowercase names.
 */
export function isSkillName(name) {
  return SKILL_NAME.test(name)
}

/** Strip one level of matching surrounding quotes. */
function unquote(value) {
  if (value.length >= 2
    && ((value[0] === '"' && value[value.length - 1] === '"')
      || (value[0] === "'" && value[value.length - 1] === "'"))) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Parse a canonical SKILL.md body (frontmatter block + markdown body).
 * Frontmatter is parsed line-wise for simple `key: value` fields; `name` and
 * `description` are required and must be single-line scalars.
 * @param {string} text - the full SKILL.md content.
 * @returns {{name: string, description: string, body: string} | undefined}
 *   the parsed skill, or undefined when not canonical.
 */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return undefined
  const fields = {}
  for (const line of match[1].split('\n')) {
    const field = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line)
    if (!field) continue
    const rawValue = field[2].trim()
    const quoted = (rawValue.startsWith('"') && rawValue.endsWith('"'))
      || (rawValue.startsWith("'") && rawValue.endsWith("'"))
    // YAML bare scalars reject `: ` and inline comments; a quoted value is
    // safe. This mirrors the strict YAML frontmatter parser DSH's skill-local
    // uses — a skill we accept must parse there too.
    if (!quoted && (rawValue.includes(': ') || rawValue.includes(' #'))) return undefined
    fields[field[1]] = quoted ? unquote(rawValue) : rawValue
  }
  if (typeof fields.name !== 'string' || fields.name.length === 0) return undefined
  if (typeof fields.description !== 'string' || fields.description.length === 0) return undefined
  return { name: fields.name, description: fields.description, body: match[2] }
}

/**
 * List skills in a directory (directory bundles with a parseable SKILL.md).
 * @param {string} dir - the skills directory.
 * @returns {Array<{name: string, description: string}>} sorted entries.
 */
export function listSkills(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const result = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const text = readFileSync(join(dir, entry.name, 'SKILL.md'), 'utf8')
      const parsed = parseFrontmatter(text)
      if (parsed && parsed.name === entry.name) {
        result.push({ name: entry.name, description: parsed.description })
      }
    } catch {
      // unreadable or unparseable skill — skip
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * List pending (awaiting user confirmation) skills with their full content.
 * @param {string} dir - the pending-skills directory.
 * @returns {Array<{name: string, description: string, content: string}>}
 *   entries in name order.
 */
export function listPendingSkills(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const result = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const content = readFileSync(join(dir, entry.name, 'SKILL.md'), 'utf8')
      const parsed = parseFrontmatter(content)
      if (parsed && parsed.name === entry.name) {
        result.push({ name: entry.name, description: parsed.description, content })
      }
    } catch {
      // unreadable or unparseable — skip
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Approve one pending skill: move it from the pending directory into the
 * live skills directory (a rename — the skill is "installed" by the move).
 * @param {string} pendingDir - the pending-skills directory.
 * @param {string} skillDir - the live skills directory.
 * @param {string} name - the skill name (kebab-case).
 * @returns {{ok: true, path: string} | {ok: false, message: string}} the
 *   outcome; refuses to overwrite a live skill with the same name.
 */
export function approvePendingSkill(pendingDir, skillDir, name) {
  if (!isSkillName(name)) return { ok: false, message: `无效技能名 "${name}"` }
  const from = join(pendingDir, name)
  if (!existsSync(join(from, 'SKILL.md'))) {
    return { ok: false, message: `待确认技能 "${name}" 不存在` }
  }
  const to = join(skillDir, name)
  if (existsSync(join(to, 'SKILL.md'))) {
    return { ok: false, message: `技能 "${name}" 已存在于技能库，请先处理再采纳` }
  }
  mkdirSync(skillDir, { recursive: true })
  renameSync(from, to)
  return { ok: true, path: join(to, 'SKILL.md') }
}

/**
 * Reject one pending skill: delete it from the pending directory.
 * @param {string} pendingDir - the pending-skills directory.
 * @param {string} name - the skill name (kebab-case).
 * @returns {{ok: true} | {ok: false, message: string}} the outcome.
 */
export function rejectPendingSkill(pendingDir, name) {
  if (!isSkillName(name)) return { ok: false, message: `无效技能名 "${name}"` }
  const target = join(pendingDir, name)
  if (!existsSync(join(target, 'SKILL.md'))) {
    return { ok: false, message: `待确认技能 "${name}" 不存在` }
  }
  rmSync(target, { recursive: true, force: true })
  return { ok: true }
}

/**
 * Read one skill's SKILL.md.
 * @param {string} dir - the skills directory.
 * @param {string} name - the skill name (kebab-case).
 * @returns {string | undefined} the raw content, or undefined when absent.
 */
export function readSkill(dir, name) {
  if (!isSkillName(name)) return undefined
  try {
    return readFileSync(join(dir, name, 'SKILL.md'), 'utf8')
  } catch {
    return undefined
  }
}

/** Atomically write one skill's SKILL.md (creates the directory). */
function writeSkill(dir, name, content) {
  const target = join(dir, name)
  mkdirSync(target, { recursive: true })
  const path = join(target, 'SKILL.md')
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

/**
 * Whether the calling agent has read the skill before (read-before-write):
 * its own session log must contain a `skill_manage action=read <name>`
 * tool call. The session log is the authoritative reconstruction boundary.
 * @param {object | undefined} agent - the calling agent (may be absent for
 *   headless callers — those are refused by the caller's policy anyway).
 * @param {string} toolName - the configured skill tool name.
 * @param {string} name - the skill name.
 * @returns {boolean} true when a read is proven by the log.
 */
export function hasReadSkill(agent, toolName, name) {
  const events = agent?.session?.events
  if (!Array.isArray(events)) return false
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    if (event.data?.name !== toolName) continue
    try {
      const args = JSON.parse(event.data.arguments)
      if (args.action === 'read' && args.name === name) return true
    } catch {
      // unparseable arguments — ignore
    }
  }
  return false
}

/**
 * Build the `skill_manage` tool definition.
 * @param {object} ctx - the plugin context (for the optional `skills`
 *   service used by the disabled-skill check).
 * @param {object} config - resolved plugin config (skillDir etc.).
 * @returns {object} a ToolDefinition-shaped object for ctx.tools.register.
 */
export function skillManageTool(ctx, config) {
  const dir = config.skillDir
  const pendingDir = join(config.memoryDir, 'pending-skills')

  /** Check the shared runtime registry for a disabled shadow. */
  const disabledReason = async (name) => {
    const skills = ctx.get('skills')
    if (!skills || typeof skills.list !== 'function') return undefined
    try {
      const list = await skills.list({})
      const skill = list.find((entry) => entry.name === name)
      return skill?.invocation?.modelInvocable === false
        ? `技能 "${name}" 已被禁用（modelInvocable: false），不执行写入`
        : undefined
    } catch {
      return undefined
    }
  }

  /** Validate a create/patch body against the canonical format. */
  const validateBody = (name, description, body) => {
    if (!isSkillName(name)) {
      return { ok: false, message: `无效技能名 "${name}"（必须 kebab-case 小写，如 systematic-debugging）` }
    }
    if (description !== undefined && !String(description).trim()) {
      return { ok: false, message: 'description 不能为空' }
    }
    if (typeof body !== 'string' || body.length === 0) {
      return { ok: false, message: 'body 不能为空（完整 SKILL.md 内容，含 frontmatter）' }
    }
    if (body.length > config.skillMaxBytes) {
      return { ok: false, message: `SKILL.md 超过大小上限 ${config.skillMaxBytes} 字节` }
    }
    const parsed = parseFrontmatter(body)
    if (!parsed) {
      return { ok: false, message: 'body 不是规范 SKILL.md：必须以 --- 开头的 frontmatter（含单行 name 与 description），后接正文。注意 description 请用双引号包裹（如 description: "..."），未加引号且含冒号+空格的值会被 YAML 拒绝' }
    }
    if (parsed.name !== name) {
      return { ok: false, message: `frontmatter 的 name（${parsed.name}）必须与技能名一致（${name}）` }
    }
    if (description !== undefined && parsed.description !== String(description).trim()) {
      return { ok: false, message: 'frontmatter 的 description 与传入的 description 不一致' }
    }
    return { ok: true }
  }

  return {
    name: config.skillManageToolName,
    description: '管理技能库（默认目录 ~/.agents/skills，DSH 与 Hermes 都能加载）：create 创建新技能（body 为完整 SKILL.md，含 --- frontmatter：name 与 description 单行必填）；patch 更新已有技能（必须先用 read 读取过，body 为完整修订版）；read 读取技能全文；list 列出已有技能。技能命名必须 kebab-case 类级名称（如 systematic-debugging），禁止一次性任务名。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'patch', 'read', 'list'],
          description: '要执行的操作',
        },
        name: {
          type: 'string',
          description: '技能名（kebab-case 小写）',
        },
        description: {
          type: 'string',
          description: 'create 时的一句话描述（说明何时使用该技能，将写入 frontmatter）',
        },
        body: {
          type: 'string',
          description: 'create/patch 时的完整 SKILL.md 内容（--- frontmatter + 正文：概览/步骤/命令/坑/验证）',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          name: { type: 'string' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
          content: { type: 'string' },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => {
        const lines = [value.message ?? '']
        if (Array.isArray(value.entries) && value.entries.length > 0) {
          lines.push(`已有技能（${value.entries.length} 个）：`)
          value.entries.forEach((entry, index) => lines.push(`${index + 1}. ${entry.name} — ${entry.description}`))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const action = args.action
      const name = String(args.name ?? '').trim()
      switch (action) {
        case 'list': {
          const entries = listSkills(dir)
          return { ok: true, message: `技能库（${entries.length} 个）：`, entries }
        }
        case 'read': {
          if (!isSkillName(name)) {
            return { ok: false, message: `无效技能名 "${name}"（必须 kebab-case 小写）` }
          }
          const content = readSkill(dir, name)
          if (content === undefined) {
            return { ok: false, message: `技能 "${name}" 不存在` }
          }
          return { ok: true, message: `已读取技能 "${name}"（${content.length} 字节）`, name, content }
        }
        case 'create': {
          const checked = validateBody(name, args.description, args.body)
          if (!checked.ok) return checked
          const disabled = await disabledReason(name)
          if (disabled) return { ok: false, message: disabled }
          if (readSkill(dir, name) !== undefined) {
            return { ok: false, message: `技能 "${name}" 已存在，请改用 patch 更新` }
          }
          // Background-review creations go through the pending queue unless
          // the user enabled direct auto-harvest: the skill lands in
          // <memoryDir>/pending-skills/ and is installed by moving it into
          // the live skills dir when the user approves it in the panel.
          const fromReview = exec?.agent?.session?.header?.origin === 'subagent'
          if (fromReview && !config.skillReviewEnabled) {
            if (readSkill(pendingDir, name) !== undefined) {
              return { ok: false, message: `待确认队列已有技能 "${name}"，请勿重复创建（可在设置面板处理）` }
            }
            writeSkill(pendingDir, name, args.body)
            return {
              ok: true,
              message: `技能 "${name}" 已创建到待确认队列（等待用户在设置面板确认采纳，采纳后才会进入技能库）`,
              name,
            }
          }
          writeSkill(dir, name, args.body)
          return { ok: true, message: `技能 "${name}" 已创建（${args.body.length} 字节）`, name }
        }
        case 'patch': {
          const checked = validateBody(name, undefined, args.body)
          if (!checked.ok) return checked
          const disabled = await disabledReason(name)
          if (disabled) return { ok: false, message: disabled }
          if (readSkill(dir, name) === undefined) {
            return { ok: false, message: `技能 "${name}" 不存在，请改用 create` }
          }
          if (!hasReadSkill(exec?.agent, config.skillManageToolName, name)) {
            return {
              ok: false,
              message: `更新技能 "${name}" 前必须先读取它：请先调用 ${config.skillManageToolName} action=read name=${name}`,
            }
          }
          writeSkill(dir, name, args.body)
          return { ok: true, message: `技能 "${name}" 已更新（${args.body.length} 字节）`, name }
        }
        default:
          return { ok: false, message: `未知操作 "${action}"（支持 create / patch / read / list）` }
      }
    },
  }
}
