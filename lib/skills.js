/**
 * dsh-memory-evolve — skill management tool.
 *
 * The `skill_manage` tool lets LLM agents (the in-turn memory review and
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
import { translate, getLocale, SKILL_DICT, SKILL_MSG_DICT } from './i18n.js'

/** Translate through the SKILL_DICT dictionary in the active locale. */
const skt = (key, params) => translate(SKILL_DICT, key, params)
/** Translate through SKILL_MSG_DICT in the active host locale. */
const smt = (key, params) => translate(SKILL_MSG_DICT, key, params, getLocale())
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
    // Windows/CRLF 兼容（issue #17）：split('\n') 后每行尾部残留 \r，
    // 而 JS 正则中 . 不匹配 \r、$ 不匹配 \r 前的位置——"name: foo\r"
    // 整行匹配失败 → fields 缺 name → 返回 undefined → 技能被静默跳过。
    // 先剥掉行尾 \r 再解析（分隔符正则已支持 \r?\n，这里补行内处理）。
    const field = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line.replace(/\r+$/, ''))
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
  if (!isSkillName(name)) return { ok: false, message: smt('skillmsg.invalidNameShort', { name }) }
  const from = join(pendingDir, name)
  if (!existsSync(join(from, 'SKILL.md'))) {
    return { ok: false, message: smt('skillmsg.pendingMissing', { name }) }
  }
  const to = join(skillDir, name)
  if (existsSync(join(to, 'SKILL.md'))) {
    return { ok: false, message: smt('skillmsg.alreadyInLib', { name }) }
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
  if (!isSkillName(name)) return { ok: false, message: smt('skillmsg.invalidNameShort', { name }) }
  const target = join(pendingDir, name)
  if (!existsSync(join(target, 'SKILL.md'))) {
    return { ok: false, message: smt('skillmsg.pendingMissing', { name }) }
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
        ? skt('skill.disabledShadow', { name })
        : undefined
    } catch {
      return undefined
    }
  }

  /** Validate a create/patch body against the canonical format. */
  const validateBody = (name, description, body) => {
    if (!isSkillName(name)) {
      return { ok: false, message: skt('skill.invalidName', { name }) }
    }
    if (description !== undefined && !String(description).trim()) {
      return { ok: false, message: skt('skill.emptyDescription') }
    }
    if (typeof body !== 'string' || body.length === 0) {
      return { ok: false, message: skt('skill.emptyBody') }
    }
    if (body.length > config.skillMaxBytes) {
      return { ok: false, message: skt('skill.tooLarge', { limit: config.skillMaxBytes }) }
    }
    const parsed = parseFrontmatter(body)
    if (!parsed) {
      return { ok: false, message: skt('skill.badFrontmatter') }
    }
    if (parsed.name !== name) {
      return { ok: false, message: skt('skill.nameMismatch', { parsed: parsed.name, name }) }
    }
    if (description !== undefined && parsed.description !== String(description).trim()) {
      return { ok: false, message: skt('skill.descriptionMismatch') }
    }
    return { ok: true }
  }

  return {
    name: config.skillManageToolName,
    get description() { return skt('skill.desc') },
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'patch', 'read', 'list'],
          get description() { return skt('skill.action') },
        },
        name: {
          type: 'string',
          get description() { return skt('skill.name') },
        },
        description: {
          type: 'string',
          get description() { return skt('skill.description') },
        },
        body: {
          type: 'string',
          get description() { return skt('skill.body') },
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
          return { ok: true, message: smt('skillmsg.listHead', { count: entries.length }), entries }
        }
        case 'read': {
          if (!isSkillName(name)) {
            return { ok: false, message: smt('skillmsg.invalidNameCase', { name }) }
          }
          const content = readSkill(dir, name)
          if (content === undefined) {
            return { ok: false, message: smt('skillmsg.missing', { name }) }
          }
          return { ok: true, message: smt('skillmsg.read', { name, bytes: content.length }), name, content }
        }
        case 'create': {
          const checked = validateBody(name, args.description, args.body)
          if (!checked.ok) return checked
          const disabled = await disabledReason(name)
          if (disabled) return { ok: false, message: disabled }
          if (readSkill(dir, name) !== undefined) {
            return { ok: false, message: smt('skillmsg.existsUsePatch', { name }) }
          }
          // Skill creations go through the pending queue unless the user
          // enabled direct auto-harvest: the skill lands in
          // <memoryDir>/pending-skills/ and is installed by moving it into
          // the live skills dir when the user approves it in the panel.
          // Applies to every session (the review runs in the main session).
          if (!config.skillReviewEnabled) {
            if (readSkill(pendingDir, name) !== undefined) {
              return { ok: false, message: smt('skillmsg.pendingDuplicate', { name }) }
            }
            writeSkill(pendingDir, name, args.body)
            return {
              ok: true,
              message: smt('skillmsg.createdPending', { name }),
              name,
            }
          }
          writeSkill(dir, name, args.body)
          return { ok: true, message: smt('skillmsg.created', { name, bytes: args.body.length }), name }
        }
        case 'patch': {
          const checked = validateBody(name, undefined, args.body)
          if (!checked.ok) return checked
          const disabled = await disabledReason(name)
          if (disabled) return { ok: false, message: disabled }
          if (readSkill(dir, name) === undefined) {
            return { ok: false, message: smt('skillmsg.missingUseCreate', { name }) }
          }
          if (!hasReadSkill(exec?.agent, config.skillManageToolName, name)) {
            return {
              ok: false,
              message: smt('skillmsg.readFirst', { name, tool: config.skillManageToolName }),
            }
          }
          writeSkill(dir, name, args.body)
          return { ok: true, message: smt('skillmsg.updated', { name, bytes: args.body.length }), name }
        }
        default:
          return { ok: false, message: smt('skillmsg.unknownAction', { action }) }
      }
    },
  }
}
