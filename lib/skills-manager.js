/**
 * dsh-memory-evolve — skills manager (merged from the standalone
 * dsh-skill-browser / dsh-skills-manager plugin).
 *
 * Serves the skills-manager API under the SAME `/skills-manager` prefix the
 * standalone plugin used (the browser client keeps its original fetch base):
 *   GET  /skills-manager/api/skills         list every skill + browsable roots
 *   POST /skills-manager/api/skills/disable { name }   disable one skill
 *   POST /skills-manager/api/skills/enable  { name }   re-enable one skill
 *   GET  /skills-manager/api/dirs           list managed custom skill dirs
 *   POST /skills-manager/api/dirs { path }  add a managed custom skill dir
 *   DELETE /skills-manager/api/dirs?path=…  remove a managed custom skill dir
 *   GET  /skills-manager/api/browse         list one directory (root-scoped)
 *   GET  /skills-manager/api/read           read a text file (root-scoped)
 *   PUT  /skills-manager/api/write          write a text file (root-scoped)
 *
 * Disabling registers a runtime shadow (invocation.modelInvocable: false)
 * whose rank outranks custom/user/bundled sources but never project sources,
 * so protected system skills cannot be disabled; the choice persists in the
 * plugin state file and reconciles on every catalog change. Managed custom
 * dirs are served by this plugin's own `skill-manager` provider (source
 * `custom`, rank 300 — the same priority as skill-local custom dirs) and
 * persist in the state file.
 *
 * Migration: on first boot with no state file, the disabled list of the
 * standalone skill-manager plugins (dsh-skill-browser / dsh-skills-manager,
 * see DEFAULT_LEGACY_STATE_FILES) is imported once, so uninstalling the
 * standalone plugin does not reset the user's enable/disable choices.
 *
 * The dependency edges are declared through ctx.inject inside this function,
 * so the plugin also loads harmlessly on surfaces without httpServer (e.g.
 * the TUI) and without the skills service.
 */
import { realpath, readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, isAbsolute, sep, dirname } from 'node:path'

/** Cap on a single readable text file (bytes). */
const MAX_READ_BYTES = 512 * 1024

/** Cap on a single writable text payload (bytes). */
const MAX_WRITE_BYTES = 1024 * 1024

/** Cap on the disable/enable toggle request body (bytes). */
const MAX_TOGGLE_BYTES = 4096

/**
 * Default legacy state files of the standalone skill-manager plugins
 * （issue #5：两个历史插件名都可能是用户的旧状态来源，全部纳入迁移候选）：
 *   1. dsh-skill-browser —— 08-06 之前本地目录的旧命名（~/.dsh/plugins/dsh-skill-browser/）；
 *   2. dsh-skills-manager —— GitHub 仓库名（dsh-external/dsh-skills-manager），
 *      按旧 README 安装的用户目录名为 dsh-skills-manager，state.json 在该目录下。
 * 迁移顺序：先旧名后新名，取第一个含禁用列表的导入（详见 loadState）。
 */
const DEFAULT_LEGACY_STATE_FILES = [
  join(homedir(), '.dsh', 'plugins', 'dsh-skill-browser', 'state.json'),
  join(homedir(), '.dsh', 'plugins', 'dsh-skills-manager', 'state.json'),
]

/**
 * Sources that must never be disableable: repository/system skill roots.
 * project-dsh and project-agents carry the harness's own documented
 * workflows; the model catalog depends on them.
 */
function isProtectedSource(source) {
  return source.startsWith('project')
}

/** Read a JSON state file; null when missing or corrupt. */
function readStateFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.disabled)) {
      return {
        disabled: parsed.disabled.filter((name) => typeof name === 'string'),
        customDirs: Array.isArray(parsed.customDirs)
          ? parsed.customDirs.filter((path) => typeof path === 'string')
          : [],
      }
    }
  } catch {
    // Missing or unreadable state is not a misconfiguration.
  }
  return null
}

/**
 * Load the persisted disable state. When the state file does not exist yet,
 * import the standalone skill-manager plugins' state once (so the merged
 * plugin keeps the user's enable/disable choices) and persist it immediately.
 *
 * @param {string} stateFile - this plugin's own state file.
 * @param {string|string[]} legacyStateFiles - one or more candidate legacy
 *   state files (issue #5：兼容 dsh-skill-browser 与 dsh-skills-manager 两种
 *   旧插件目录命名）；按顺序尝试，导入第一个含禁用列表的来源后即停止。
 */
function loadState(stateFile, legacyStateFiles) {
  const own = readStateFile(stateFile)
  if (own !== null) return own
  const state = { disabled: [], customDirs: [] }
  for (const legacyFile of typeof legacyStateFiles === 'string' ? [legacyStateFiles] : legacyStateFiles) {
    const legacy = readStateFile(legacyFile)
    if (legacy !== null && legacy.disabled.length > 0) {
      state.disabled = legacy.disabled
      state.customDirs = legacy.customDirs
      try {
        saveState(stateFile, state)
      } catch {
        // Persisting the migration is best-effort; in-memory state still works.
      }
      break
    }
  }
  return state
}

/** Persist the disable state atomically (tmp + rename). */
function saveState(stateFile, state) {
  const tmp = `${stateFile}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, stateFile)
}

/** Extensions treated as text even when the sniffing heuristics are inconclusive. */
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.text', '.json', '.json5', '.jsonc', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg', '.py', '.rb', '.go',
  '.rs', '.java', '.kt', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.swift', '.php',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.sql', '.graphql', '.vue',
  '.svelte', '.astro', '.env', '.gitignore', '.gitattributes', '.editorconfig',
  '.eslintrc', '.prettierrc', '.npmrc', '.lock', '.properties', '.csv', '.tsv',
  '.log', '.diff', '.patch', '.d.ts', '.d.cts', '.d.mts', '.dsh', '.skl', '.yml.i18n',
])

/** File extensions never offered for browsing/editing (generated or binary). */
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.bmp', '.avif', '.heic',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.dmg', '.pkg', '.woff', '.woff2',
  '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.wav', '.flac', '.m4a', '.wasm', '.pyc',
  '.class', '.jar', '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.node', '.map',
])

/** Decode one path segment safely (throws on malformed input). */
function decodeSeg(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Small JSON response helper. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Collect the raw request body (capped). */
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > cap) {
        reject(new Error(`payload exceeds ${cap} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks)) })
    req.on('error', reject)
  })
}

/** Text sniff: valid UTF-8 with no NUL bytes and a low control-char ratio. */
function looksLikeText(buffer) {
  if (buffer.includes(0)) return false
  const text = buffer.toString('utf8')
  if (text.includes('\uFFFD')) return false
  let controls = 0
  for (let i = 0; i < text.length && i < 4096; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) controls += 1
  }
  return controls === 0
}

/** Resolve the browsable roots from the current skill catalog. */
async function collectRoots(ctx, cwd) {
  const seen = new Set()
  const roots = []
  const skills = await ctx.skills.list({ cwd })
  for (const skill of skills) {
    if (skill.resourceBase?.kind === 'directory' && typeof skill.resourceBase.path === 'string') {
      seen.add(skill.resourceBase.path)
    }
    if (typeof skill.path === 'string' && skill.path.length > 0) {
      seen.add(dirname(skill.path))
    }
  }
  for (const candidate of seen) {
    try {
      const resolved = await realpath(candidate)
      const info = await stat(resolved)
      if (info.isDirectory()) roots.push(resolved)
    } catch {
      // Nonexistent or unreadable root candidates are skipped silently.
    }
  }
  return { roots: [...new Set(roots)].sort(), skills }
}

/** Resolve a client-supplied path to a realpath inside the allowed roots.
 * `path` may be absolute (must sit inside a root) or relative to `base`.
 * @returns {Promise<string|null>} resolved path, or null when outside/absent.
 */
async function resolveInside(roots, path, base) {
  const target = isAbsolute(path) ? path : join(base ?? '', path)
  let resolved
  try {
    resolved = await realpath(target)
  } catch {
    return null
  }
  for (const root of roots) {
    if (isInsideRoot(root, resolved)) return resolved
  }
  return null
}

/** Build one browse entry (skip binary-looking artifacts). */
async function entryInfo(absPath, name) {
  const info = await stat(absPath)
  if (info.isDirectory()) {
    return { name, type: 'dir', size: null, mtime: info.mtimeMs }
  }
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (SKIP_EXTENSIONS.has(ext)) return null
  return { name, type: 'file', size: info.size, mtime: info.mtimeMs }
}

// ---------------------------------------------------------------------------
// User-managed custom skill directories
// ---------------------------------------------------------------------------

/** Kebab-case skill-name grammar, mirroring dsh-skill's public rule. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Strip one level of matching quotes and simple escapes from a scalar. */
function unquoteScalar(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).replace(/\\(["'\\n])/g, (_, ch) => (ch === 'n' ? '\n' : ch))
    }
  }
  return trimmed
}

/** Parse one boolean scalar the way skill-local accepts it (undefined = absent). */
function parseBoolScalar(value) {
  switch (value.trim().toLowerCase()) {
    case 'true': case 'yes': case 'on': case '1': return true
    case 'false': case 'no': case 'off': case '0': return false
    default: return undefined
  }
}

/** Extract the YAML frontmatter block (between the leading `---` fences). */
function splitFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return null
  return { data: match[1], body: text.slice(match[0].length) }
}

/** Read one `key: value` line (single-line scalars only; folded YAML is skipped). */
function frontmatterField(data, key) {
  const match = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(data)
  return match === null ? undefined : unquoteScalar(match[1])
}

/**
 * Minimal frontmatter extraction for the fields the local provider consumes:
 * name, description, whenToUse, disable-model-invocation, user-invocable.
 * Line-oriented subset of YAML — multi-line scalars are not supported and
 * make the file fail soft (skipped), matching skill-local's behavior for
 * unparsable frontmatter.
 * @returns the parsed fields, or null when the file is not a valid skill.
 */
function extractSkillFields(text) {
  const frontmatter = splitFrontmatter(text)
  if (frontmatter === null) return null
  const name = frontmatterField(frontmatter.data, 'name')
  const description = frontmatterField(frontmatter.data, 'description')
  if (name === undefined || description === undefined || !SKILL_NAME_RE.test(name)) return null
  const whenToUse = frontmatterField(frontmatter.data, 'whenToUse')
  const disable = parseBoolScalar(frontmatterField(frontmatter.data, 'disable-model-invocation') ?? '')
  const userInvocable = parseBoolScalar(frontmatterField(frontmatter.data, 'user-invocable') ?? '')
  return {
    name,
    description,
    ...whenToUse !== undefined && whenToUse !== '' ? { whenToUse } : {},
    invocation: {
      modelInvocable: disable !== true,
      userInvocable: userInvocable !== false,
    },
    body: frontmatter.body.trim(),
  }
}

/** Scan one SKILL.md file into a provider candidate (bundle layout). */
async function scanSkillFile(file, dir, signal) {
  signal?.throwIfAborted()
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return null
  }
  const fields = extractSkillFields(text)
  if (fields === null) return null
  return {
    name: fields.name,
    description: fields.description,
    ...fields.whenToUse !== undefined ? { whenToUse: fields.whenToUse } : {},
    invocation: fields.invocation,
    source: 'custom',
    provider: 'skill-manager',
    rank: 300,
    resourceBase: { kind: 'directory', path: dir },
    path: file,
    locator: { file, dir },
  }
}

/**
 * Scan one user-managed directory for skills: `<dir>/<skill>/SKILL.md`
 * bundles and `<dir>/<name>.md` flat files (the same 1–2 level layout
 * skill-local accepts). Returns candidates for the skill-manager provider.
 */
async function scanSkillDir(dir, signal) {
  signal?.throwIfAborted()
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = []
  for (const entry of entries) {
    signal?.throwIfAborted()
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      const skill = await scanSkillFile(join(abs, 'SKILL.md'), dir, signal)
      if (skill !== null) candidates.push(skill)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const skill = await scanSkillFile(abs, dir, signal)
      if (skill !== null) candidates.push(skill)
    }
  }
  return candidates
}

/** True when `candidate` (absolute, realpathed) is inside `root` (absolute, realpathed). */
function isInsideRoot(root, candidate) {
  return candidate === root || candidate.startsWith(root + sep)
}

/**
 * Install the skills-manager machinery (disabled shadows, custom-dir
 * provider, web API) into a memory-evolve plugin context.
 *
 * @param {object} ctx - the plugin context (services resolved via ctx.inject).
 * @param {object} [options]
 * @param {string} options.stateFile - state file for disabled list + custom dirs.
 * @param {string|string[]} [options.legacyStateFile] - one-time import source(s)
 *   (standalone plugin state；缺省=两个历史插件名候选，见 DEFAULT_LEGACY_STATE_FILES)。
 * @param {(sessionId: string) => string | undefined} [options.resolveCwd] - issue #4：
 *   按会话 id 解析会话工作目录（如 agents.get(sessionId).session.header.cwd）。
 *   装配后，list/browse/read/write 在缺少显式 cwd 时用它定位项目技能扫描目录；
 *   缺省（未装配）时保持旧行为：回退 workspace.list()[0]。
 */
export function installSkillsManager(ctx, options = {}) {
  const stateFile = options.stateFile
  // issue #5：legacy 来源兼容单路径（旧调用方/测试）与缺省多候选（生产装配）。
  // 显式传值则只用它；不传则尝试两个历史插件名目录的 state.json。
  const legacyStateFile = options.legacyStateFile ?? DEFAULT_LEGACY_STATE_FILES
  // issue #4：按 sessionId 解析会话工作目录的能力（由宿主装配传入，与
  // /api/memory 各接口同款模式）。缺省为 null：无此能力时保持旧行为
  // （cwd 缺省回退首个工作区），兼容不带会话上下文的历史调用方。
  const resolveCwdForSession = typeof options.resolveCwd === 'function' ? options.resolveCwd : null

  ctx.inject(['skills'], (skillCtx) => {
    const state = loadState(stateFile, legacyStateFile)
    /** Live disabled-shadow disposers, keyed by skill name. */
    const shadows = new Map()
    /** Plugin teardown latch: stop registering new shadows after dispose. */
    let disposed = false
    let reconciling = false
    let reconcileAgain = false
    /** Invalidation handle for the user-managed directory provider. */
    let providerControl = null

    /**
     * Keep one runtime shadow per disabled skill: a copy of the real skill
     * whose invocation policy is modelInvocable:false. The runtime provider
     * (rank 250) outranks custom/user/bundled sources but not project sources,
     * so protected skills can never be shadowed — the rank order is the
     * enforcement boundary. The model-facing catalog filters modelInvocable,
     * so a shadowed skill disappears from the model's catalog and the `skill`
     * tool refuses to load it, while the browser UI still lists it (dimmed)
     * for re-enable and file browsing.
     */
    const reconcileOnce = async () => {
      const disabled = new Set(state.disabled)
      for (const [name, dispose] of shadows) {
        if (!disabled.has(name)) {
          dispose()
          shadows.delete(name)
        }
      }
      let list = []
      try {
        list = await skillCtx.skills.list({})
      } catch (error) {
        skillCtx.logger?.warn?.(`skills-manager: catalog lookup failed during reconcile: ${error?.message ?? error}`)
        return
      }
      for (const name of disabled) {
        if (shadows.has(name)) continue
        const summary = list.find((skill) => skill.name === name)
        if (summary === undefined) continue
        // Already non-invocable (e.g. frontmatter-disable-model-invocation):
        // nothing to shadow — the source itself hides it from the model.
        if (!summary.invocation?.modelInvocable) continue
        let real
        try {
          real = await skillCtx.skills.get(name)
        } catch {
          continue
        }
        if (real === undefined) continue
        try {
          const dispose = skillCtx.skills.register({
            name: real.name,
            description: real.description,
            ...real.whenToUse !== undefined ? { whenToUse: real.whenToUse } : {},
            invocation: { modelInvocable: false, userInvocable: true },
            source: real.source,
            provider: real.provider,
            ...real.resourceBase !== undefined ? { resourceBase: real.resourceBase } : {},
            content: real.content,
            ...real.path !== undefined ? { path: real.path } : {},
            ...real.metadata !== undefined ? { metadata: real.metadata } : {},
          })
          shadows.set(name, dispose)
        } catch (error) {
          skillCtx.logger?.warn?.(`skills-manager: failed to register disabled shadow for "${name}": ${error?.message ?? error}`)
        }
      }
    }

    /** Serialize reconcile passes; a change during a pass schedules one rerun. */
    const reconcile = async () => {
      if (disposed || reconciling) {
        reconcileAgain = true
        return
      }
      reconciling = true
      try {
        do {
          reconcileAgain = false
          await reconcileOnce()
        } while (reconcileAgain)
      } finally {
        reconciling = false
      }
    }

    /** Reconcile after any catalog change (provider scans, runtime registrations). */
    skillCtx.on('skills/change', () => {
      void reconcile()
    })
    // The effect body runs NOW; only the returned disposer runs at unload.
    skillCtx.effect(() => {
      return () => {
        disposed = true
        for (const dispose of shadows.values()) dispose()
        shadows.clear()
      }
    }, 'memory-evolve: skills-manager disabled shadows')
    void reconcile()

    /**
     * The user-managed custom-directory provider: lists skills from the
     * directories added through the web UI (persisted in the state file).
     * Source and rank match skill-local's configured custom dirs, so these
     * skills are indistinguishable from config-added custom skills.
     */
    const provider = {
      name: 'skill-manager',
      async list(options) {
        const signal = options?.signal
        const candidates = []
        for (const dir of state.customDirs) {
          const found = await scanSkillDir(dir, signal)
          candidates.push(...found)
        }
        return candidates
      },
      async get(candidate, options) {
        options?.signal?.throwIfAborted()
        let text
        try {
          text = await readFile(candidate.locator.file, 'utf8')
        } catch {
          return undefined
        }
        const fields = extractSkillFields(text)
        if (fields === null) return undefined
        return {
          name: fields.name,
          description: fields.description,
          ...fields.whenToUse !== undefined ? { whenToUse: fields.whenToUse } : {},
          invocation: fields.invocation,
          source: 'custom',
          provider: 'skill-manager',
          resourceBase: { kind: 'directory', path: candidate.locator.dir },
          path: candidate.locator.file,
          content: fields.body,
        }
      },
    }
    skillCtx.skills.registerProvider((control) => {
      providerControl = control
      return provider
    })

    /** Persist a directory change and refresh the catalog + disabled shadows. */
    const commitDirChange = () => {
      saveState(stateFile, state)
      providerControl?.invalidate()
      return reconcile()
    }

    /**
     * Add one user-managed skill directory. The path must exist, be absolute,
     * not already added, and not overlap an existing skill root (a root inside
     * the new dir, or the new dir inside a root) — overlapping would create
     * duplicate candidates with unpredictable winners.
     * @returns {Promise<{ok: boolean, path?: string, status?: number, error?: string}>}
     */
    const addCustomDir = async (input) => {
      if (typeof input !== 'string' || input.trim() === '') {
        return { ok: false, status: 400, error: 'missing directory path' }
      }
      let path = input.trim()
      if (path === '~' || path.startsWith('~/')) path = join(homedir(), path.slice(2))
      if (!isAbsolute(path)) return { ok: false, status: 400, error: 'path must be absolute' }
      let resolved
      let info
      try {
        resolved = await realpath(path)
        info = await stat(resolved)
      } catch {
        return { ok: false, status: 400, error: 'directory does not exist' }
      }
      if (!info.isDirectory()) return { ok: false, status: 400, error: 'path is not a directory' }
      if (state.customDirs.includes(resolved)) {
        return { ok: false, status: 400, error: 'directory is already added' }
      }
      let roots = []
      try {
        ({ roots } = await collectRoots(skillCtx, undefined))
      } catch {
        roots = []
      }
      for (const root of roots) {
        if (isInsideRoot(resolved, root) || isInsideRoot(root, resolved)) {
          return {
            ok: false,
            status: 400,
            error: `directory overlaps an existing skill root: ${root}`,
          }
        }
      }
      state.customDirs.push(resolved)
      await commitDirChange()
      return { ok: true, path: resolved }
    }

    /** Remove one user-managed skill directory (idempotent). */
    const removeCustomDir = async (path) => {
      const index = state.customDirs.indexOf(path)
      if (index < 0) return { ok: false, status: 404, error: 'directory is not in the managed list' }
      state.customDirs.splice(index, 1)
      await commitDirChange()
      return { ok: true, path }
    }

    /**
     * Flip one skill's disabled state. Disable requires the live real skill;
     * protected (project) sources are rejected. Enable is idempotent.
     * @returns {Promise<{ok: boolean, name: string, disabled: boolean, error?: string, status?: number}>}
     */
    const setSkillDisabled = async (name, disabled) => {
      if (typeof name !== 'string' || name.length === 0) {
        return { ok: false, status: 400, error: 'missing skill name' }
      }
      let list = []
      try {
        list = await skillCtx.skills.list({})
      } catch (error) {
        return { ok: false, status: 500, error: `catalog lookup failed: ${error?.message ?? error}` }
      }
      const summary = list.find((skill) => skill.name === name)
      if (summary === undefined) {
        return { ok: false, status: 404, error: `skill "${name}" is unknown` }
      }
      if (disabled && isProtectedSource(summary.source)) {
        return {
          ok: false,
          status: 403,
          error: `skill "${name}" (${summary.source}) is protected and cannot be disabled`,
        }
      }
      const index = state.disabled.indexOf(name)
      const wasDisabled = index >= 0
      if (disabled && !wasDisabled) {
        state.disabled.push(name)
        saveState(stateFile, state)
        await reconcile()
      } else if (!disabled && wasDisabled) {
        state.disabled.splice(index, 1)
        saveState(stateFile, state)
        await reconcile()
      }
      return { ok: true, name, disabled }
    }

    skillCtx.inject(['httpServer', 'workspace'], (webCtx) => {
      const handler = async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const pathname = url.pathname
        const query = url.searchParams

        // ── 统一 cwd 解析（issue #4）──────────────────────────────────────
        // 项目技能扫描按「当前会话的工作目录」定位，而不是固定取第一个工作区：
        //   1. 显式 cwd 参数优先（兼容旧调用方）；
        //   2. 否则用 sessionId 经 resolveCwd 解析当前会话真实 cwd；
        //   3. 最后回退 workspace.list()[0]（无 sessionId / 会话离线 / 未装配
        //      resolveCwd 时，行为与修复前完全一致）。
        // list / browse / read / write 四个 cwd 敏感接口共用此解析。
        const resolveCwdFor = (queryParams) => {
          const explicit = queryParams.get('cwd')
          if (explicit) return explicit
          const sessionId = queryParams.get('sessionId')
          if (sessionId && resolveCwdForSession) {
            try {
              const cwd = resolveCwdForSession(sessionId)
              if (cwd) return cwd
            } catch {
              // resolveCwd 是宿主装配的回调，异常时静默回落兜底路径，
              // 不让单次技能查询因会话解析失败而整体报错。
            }
          }
          const ws = webCtx.workspace.list()[0]
          return ws ? ws.path : undefined
        }

        // ── GET /api/skills ──────────────────────────────────────────────
        if (pathname === '/skills-manager/api/skills' && req.method === 'GET') {
          try {
            const cwd = resolveCwdFor(query)
            const { skills, roots } = await collectRoots(webCtx, cwd)
            sendJson(res, 200, {
              skills: skills.map((skill) => ({
                name: skill.name,
                description: skill.description,
                whenToUse: skill.whenToUse ?? null,
                source: skill.source,
                provider: skill.provider,
                invocable: skill.invocation?.modelInvocable ?? true,
                disabled: state.disabled.includes(skill.name),
                protected: isProtectedSource(skill.source),
                resourceBase: skill.resourceBase ?? null,
                path: typeof skill.path === 'string' ? skill.path : null,
              })),
              roots,
              cwd: cwd ?? null,
            })
          } catch (error) {
            sendJson(res, 500, { error: `skills listing failed: ${String(error?.message ?? error)}` })
          }
          return
        }

        // ── POST /api/skills/disable | /enable { name } ───────────────────
        if ((pathname === '/skills-manager/api/skills/disable' || pathname === '/skills-manager/api/skills/enable')
          && req.method === 'POST') {
          const disabled = pathname.endsWith('/disable')
          try {
            const buffer = await readBody(req, MAX_TOGGLE_BYTES)
            let payload
            try {
              payload = JSON.parse(buffer.toString('utf8'))
            } catch {
              sendJson(res, 400, { error: 'request body must be JSON' })
              return
            }
            const outcome = await setSkillDisabled(typeof payload?.name === 'string' ? payload.name : '', disabled)
            if (!outcome.ok) {
              sendJson(res, outcome.status ?? 400, { error: outcome.error })
              return
            }
            sendJson(res, 200, { ok: true, name: outcome.name, disabled: outcome.disabled })
          } catch (error) {
            sendJson(res, 500, { error: `toggle failed: ${String(error?.message ?? error)}` })
          }
          return
        }

        // ── GET /api/dirs ─────────────────────────────────────────────────
        if (pathname === '/skills-manager/api/dirs' && req.method === 'GET') {
          try {
            const dirs = []
            for (const dir of state.customDirs) {
              let exists = false
              let skillCount = 0
              try {
                const info = await stat(dir)
                exists = info.isDirectory()
              } catch {
                exists = false
              }
              if (exists) {
                try {
                  skillCount = (await scanSkillDir(dir, undefined)).length
                } catch {
                  skillCount = 0
                }
              }
              dirs.push({ path: dir, exists, skillCount })
            }
            sendJson(res, 200, { dirs })
          } catch (error) {
            sendJson(res, 500, { error: `dirs listing failed: ${String(error?.message ?? error)}` })
          }
          return
        }

        // ── POST /api/dirs { path } ───────────────────────────────────────
        if (pathname === '/skills-manager/api/dirs' && req.method === 'POST') {
          try {
            const buffer = await readBody(req, MAX_TOGGLE_BYTES)
            let payload
            try {
              payload = JSON.parse(buffer.toString('utf8'))
            } catch {
              sendJson(res, 400, { error: 'request body must be JSON' })
              return
            }
            const outcome = await addCustomDir(typeof payload?.path === 'string' ? payload.path : '')
            if (!outcome.ok) {
              sendJson(res, outcome.status ?? 400, { error: outcome.error })
              return
            }
            sendJson(res, 200, { ok: true, path: outcome.path })
          } catch (error) {
            sendJson(res, 500, { error: `dir add failed: ${String(error?.message ?? error)}` })
          }
          return
        }

        // ── DELETE /api/dirs?path=… ───────────────────────────────────────
        if (pathname === '/skills-manager/api/dirs' && req.method === 'DELETE') {
          try {
            const path = decodeSeg(query.get('path') || '')
            const outcome = await removeCustomDir(path)
            if (!outcome.ok) {
              sendJson(res, outcome.status ?? 400, { error: outcome.error })
              return
            }
            sendJson(res, 200, { ok: true, path: outcome.path })
          } catch (error) {
            sendJson(res, 500, { error: `dir remove failed: ${String(error?.message ?? error)}` })
          }
          return
        }

        // ── GET /api/browse?root=…&path=… ────────────────────────────────
        if (pathname === '/skills-manager/api/browse' && req.method === 'GET') {
          try {
            const { roots } = await collectRoots(webCtx, resolveCwdFor(query))
            const root = decodeSeg(query.get('root') || '')
            if (!roots.includes(root)) {
              sendJson(res, 403, { error: 'root is not a browsable skill directory' })
              return
            }
            const rel = decodeSeg(query.get('path') || '')
            const dir = await resolveInside(roots, rel, root)
            if (dir === null) {
              sendJson(res, 404, { error: 'directory not found or outside skill roots' })
              return
            }
            const info = await stat(dir)
            if (!info.isDirectory()) {
              sendJson(res, 400, { error: 'path is not a directory' })
              return
            }
            const names = await readdir(dir)
            const entries = []
            for (const name of names.sort((a, b) => a.localeCompare(b))) {
              const abs = join(dir, name)
              try {
                const entry = await entryInfo(abs, name)
                if (entry) entries.push(entry)
              } catch {
                // Unreadable entries are skipped.
              }
            }
            // Directories first, then files; both alphabetical.
            entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
            sendJson(res, 200, { root, path: dir, entries })
          } catch (error) {
            sendJson(res, 500, { error: `browse failed: ${String(error?.message ?? error)}` })
          }
          return
        }

        // ── GET /api/read?path=… ─────────────────────────────────────────
        if (pathname === '/skills-manager/api/read' && req.method === 'GET') {
          try {
            const { roots } = await collectRoots(webCtx, resolveCwdFor(query))
            const target = decodeSeg(query.get('path') || '')
            const file = await resolveInside(roots, target, undefined)
            if (file === null) {
              sendJson(res, 404, { error: 'file not found or outside skill roots' })
              return
            }
            const buffer = await readFile(file)
            if (buffer.length > MAX_READ_BYTES) {
              sendJson(res, 413, { error: `file exceeds the ${MAX_READ_BYTES / 1024} KiB read cap` })
              return
            }
            if (!looksLikeText(buffer)) {
              sendJson(res, 415, { error: 'not a text file' })
              return
            }
            const info = await stat(file)
            sendJson(res, 200, {
              path: file,
              content: buffer.toString('utf8'),
              size: buffer.length,
              mtime: info.mtimeMs,
            })
          } catch (error) {
            sendJson(res, 500, { error: `read failed: ${String(error?.message ?? error)}` })
          }
          return
        }

        // ── PUT /api/write?path=… (body = raw text) ──────────────────────
        if (pathname === '/skills-manager/api/write' && req.method === 'PUT') {
          try {
            const { roots } = await collectRoots(webCtx, resolveCwdFor(query))
            const target = decodeSeg(query.get('path') || '')
            const file = await resolveInside(roots, target, undefined)
            if (file === null) {
              sendJson(res, 404, { error: 'target file not found or outside skill roots' })
              return
            }
            const buffer = await readBody(req, MAX_WRITE_BYTES)
            if (!looksLikeText(buffer)) {
              sendJson(res, 415, { error: 'refusing to write non-text content' })
              return
            }
            const info = await stat(file)
            if (!info.isFile()) {
              sendJson(res, 400, { error: 'target is not a file' })
              return
            }
            await writeFile(file, buffer, { encoding: 'utf8' })
            const after = await stat(file)
            sendJson(res, 200, { ok: true, path: file, size: after.size, mtime: after.mtimeMs })
          } catch (error) {
            sendJson(res, 500, { error: `write failed: ${String(error?.message ?? error)}` })
          }
          return
        }

        sendJson(res, 404, { error: `unknown skills-manager endpoint ${req.method} ${pathname}` })
      }
      return webCtx.httpServer.register({ kind: 'prefix', path: '/skills-manager', handler })
    })
  })
}
