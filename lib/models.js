/**
 * dsh-memory-evolve — 模型配置模块（Model Config）。
 *
 * 独立子模块：会话页「模型配置」Tab 的数据面 + 给 AI 用的 de_models 工具。
 * 定位（用户拍板 2026-08-11）：
 *   - 表格展示 DSH 现有供应商与模型（只读聚合：供应商目录 + settings 模型
 *     目录 + adapter 思考等级元数据），并允许给每个模型设置：
 *       1) 启用/禁用（插件口径的可用性标记，不改变 DSH 实际路由）；
 *       2) 备注（自由文本）；
 *       3) 可用思考等级（adapter 支持的等级白名单 + 自定义等级）。
 *   - 所有配置归属本插件（<memoryDir>/models.json），不写 DSH settings、
 *     不与其他插件耦合。
 *   - 对外暴露 de_models 工具（给 AI）：列出当前可用模型、每个模型的
 *     enabled 状态、可用思考等级与推荐等级、备注。
 *
 * 存储结构（models.json）：
 *   {
 *     "version": 1,
 *     "models": {
 *       "<provider>": {
 *         "<modelId>": {
 *           "enabled": true,                       // 缺省 = true
 *           "note": "…",                           // 缺省 = ''
 *           "reasoning": {
 *             "enabled": ["high","max"],           // 等级白名单；缺省/undefined = 全部可用
 *             "custom": [{ "id":"ultra", "name":"Ultra" }]  // 自定义等级（全量替换）
 *           }
 *         }
 *       }
 *     }
 *   }
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 插件模型配置文件（相对 memoryDir）。 */
const MODELS_FILE = 'models.json'

/** 备注最大长度（防御：防超大 body 撑爆配置文件）。 */
const NOTE_MAX = 2000
/** 自定义等级最大条数。 */
const CUSTOM_MAX = 20
/** 等级 id 合法字符（字母数字、下划线、中划线、点——与 DSH effort id 同风格）。 */
const LEVEL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/

/** 取对象路径值（简单版，同 api.js 风格）。 */
function getPath(root, path) {
  let node = root
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[key]
  }
  return node
}

/** 读取 JSON（缺失/损坏回退默认结构）。 */
function load(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.models && typeof parsed.models === 'object') {
      return parsed
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // 损坏的配置文件：备份后重建，避免配置永久丢失。
      try { writeFileSync(`${file}.corrupt-${Date.now()}`, readFileSync(file)) } catch { /* 忽略 */ }
    }
  }
  return { version: 1, models: {} }
}

/**
 * 模型配置存储：models.json 的读写。每次更新立即落盘。
 */
export class ModelConfigStore {
  /**
   * @param {string} file - 配置文件绝对路径（<memoryDir>/models.json）。
   */
  constructor(file) {
    this.file = file
    this.data = load(file)
  }

  /** 读取一个模型的配置 entry（无配置返回 undefined）。 */
  entry(provider, model) {
    return this.data.models?.[provider]?.[model]
  }

  /**
   * 更新一个模型的配置（局部 patch，缺省保留原值）。
   * @param {string} provider - 供应商路由 id。
   * @param {string} model - 模型 id。
   * @param {object} patch - { enabled?, note?, reasoning? }。
   * @returns {object} 更新后的 entry（规范化后；全空时 entry 被删除，返回 undefined）。
   */
  update(provider, model, patch) {
    const providers = this.data.models
    const current = providers[provider]?.[model] ?? {}
    const next = { ...current }
    // 默认值不落盘：enabled 默认 true（显式传 true = 恢复默认，删除字段）；
    // 空备注同理。
    if (patch.enabled !== undefined) {
      if (patch.enabled === true) delete next.enabled
      else next.enabled = false
    }
    if (patch.note !== undefined) next.note = String(patch.note).slice(0, NOTE_MAX)
    if (patch.reasoning !== undefined) next.reasoning = patch.reasoning
    // 规范化：空备注不落盘；白名单 undefined=全部可用（不落盘）；空白名单=全部禁用（落盘）。
    if (next.note === '') delete next.note
    if (next.reasoning !== undefined) {
      if (next.reasoning.enabled === undefined || next.reasoning.enabled === null) {
        delete next.reasoning.enabled
      }
      if (!Array.isArray(next.reasoning.custom) || next.reasoning.custom.length === 0) {
        delete next.reasoning.custom
      }
      if (Object.keys(next.reasoning).length === 0) delete next.reasoning
    }
    providers[provider] ??= {}
    if (Object.keys(next).length === 0) {
      delete providers[provider][model]
    } else {
      providers[provider][model] = next
    }
    if (Object.keys(providers[provider]).length === 0) delete providers[provider]
    this.save()
    return providers[provider]?.[model]
  }

  /** 落盘（原子写：先写临时文件再 rename）。 */
  save() {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    try {
      writeFileSync(this.file, JSON.stringify(this.data, null, 2))
    } finally {
      try { /* 清理临时文件 */ } catch { /* 忽略 */ }
    }
  }
}

/**
 * 聚合模型清单快照：供应商目录 + settings 模型目录 + adapter 思考等级
 * （并行查询、逐个降级）+ 插件配置（enabled/note/等级白名单/自定义等级）。
 *
 * 思考等级语义：
 *   - recommended：adapter 报告的 defaultEffort（展示用，插件不覆盖）；
 *   - levels：adapter 支持的全部等级 + 用户自定义等级（id 去重）；
 *     每个等级 enabled = 白名单未配置 ? true : 白名单包含该 id。
 * @param {object} ctx - 插件根上下文（llm / settings 服务）。
 * @param {ModelConfigStore} store - 插件配置存储。
 * @returns {Promise<object>} { providers, total, enabledTotal }。
 */
export async function buildModelsSnapshotAsync(ctx, store) {
  const entries = ctx.llm.listConfigurableProviders()
  const activeIds = new Set(ctx.llm.listProviders().map((p) => p.id))
  const nsCache = new Map()
  const getNs = (ns) => {
    if (!nsCache.has(ns)) nsCache.set(ns, ctx.settings.get(ns))
    return nsCache.get(ns)
  }

  const providers = entries.map((entry) => {
    const value = getNs(entry.settingsNs)
    const profile = value !== undefined && entry.settingsPath.length > 0
      ? getPath(value, entry.settingsPath)
      : value
    const rawModels = profile !== undefined && Array.isArray(profile.models) ? profile.models : []
    const active = activeIds.has(entry.provider)
    const providerDefaultReasoning = profile !== undefined
      ? (typeof profile.reasoning === 'string' ? profile.reasoning
        : typeof profile.reasoningEffort === 'string' ? profile.reasoningEffort
          : undefined)
      : undefined
    const models = rawModels.map((raw) => {
      const model = String(raw?.id ?? '')
      if (model === '') return null
      const cfg = store.entry(entry.provider, model)
      const enabled = cfg?.enabled !== false
      const note = typeof cfg?.note === 'string' ? cfg.note : ''
      return {
        id: model,
        name: typeof raw?.name === 'string' && raw.name !== '' ? raw.name : model,
        description: typeof raw?.description === 'string' ? raw.description : undefined,
        contextWindow: typeof raw?.contextWindow === 'number' ? raw.contextWindow : undefined,
        maxTokens: typeof raw?.maxTokens === 'number' ? raw.maxTokens : undefined,
        enabled,
        note,
        configured: cfg !== undefined,
      }
    }).filter((m) => m !== null)
    return { provider: entry.provider, providerDisplay: entry.displayName, active, settingsNs: entry.settingsNs, providerDefaultReasoning, models }
  })

  // adapter 思考等级元数据：只对激活供应商并行查询，失败降级为 null。
  const reasoningByKey = new Map()
  await Promise.all(providers.flatMap((p) => {
    if (!p.active) return []
    return p.models.map((m) => ctx.llm.resolveModelInfo(p.provider, m.id).then(
      (info) => {
        if (info?.reasoning?.efforts?.length > 0) {
          reasoningByKey.set(`${p.provider}\u0000${m.id}`, {
            efforts: info.reasoning.efforts.map((e) => ({ id: e.id, name: e.name, description: e.description })),
            defaultEffort: info.reasoning.defaultEffort,
          })
        }
      },
      () => { /* 降级：该模型无思考等级 */ },
    ))
  }))

  // 合并插件配置 → 每个模型的完整行（含有效思考等级列表）。
  let total = 0
  let enabledTotal = 0
  for (const p of providers) {
    for (const m of p.models) {
      total += 1
      if (m.enabled) enabledTotal += 1
      const cfg = store.entry(p.provider, m.id)
      const info = reasoningByKey.get(`${p.provider}\u0000${m.id}`)
      const custom = Array.isArray(cfg?.reasoning?.custom) ? cfg.reasoning.custom : []
      const whitelist = Array.isArray(cfg?.reasoning?.enabled) ? cfg.reasoning.enabled : undefined
      // 等级表：adapter 等级 + 自定义等级（按 id 去重，自定义优先显示在后）。
      const byId = new Map()
      for (const e of info?.efforts ?? []) byId.set(e.id, { id: e.id, name: e.name })
      for (const c of custom) {
        if (typeof c?.id === 'string' && c.id !== '' && !byId.has(c.id)) {
          byId.set(c.id, { id: c.id, name: typeof c.name === 'string' && c.name !== '' ? c.name : c.id })
        }
      }
      const levels = [...byId.values()].map((l) => ({
        id: l.id,
        name: l.name,
        custom: custom.some((c) => c.id === l.id),
        enabled: whitelist === undefined ? true : whitelist.includes(l.id),
      }))
      m.reasoning = levels.length > 0
        ? { recommended: info?.defaultEffort ?? undefined, levels }
        : null
      m.whitelistConfigured = whitelist !== undefined
    }
  }
  return { providers, total, enabledTotal }
}

/**
 * de_models 工具定义：给 AI 查询当前可用模型（接口）清单。
 * 默认只列出插件标记为启用的模型；all=true 列出全部（含禁用，带 enabled）。
 */
export function modelsToolDefinition(ctx, store) {
  return {
    name: 'de_models',
    description: '查询当前可用模型（接口）清单：每个模型的供应商、模型 ID/名称、是否启用（插件标记）、DSH 是否激活、可用思考等级（含推荐等级与自定义等级）、备注。默认只返回启用的模型；需要看全部（含禁用）时传 all=true，可按供应商过滤。',
    parameters: {
      type: 'object',
      properties: {
        all: {
          type: 'boolean',
          description: '可选：true 时返回全部模型（含禁用的，带 enabled 标记）；缺省只返回启用的',
        },
        provider: {
          type: 'string',
          description: '可选：按供应商路由 id 过滤（如 deepseek-official、openai）',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          total: { type: 'integer' },
          models: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                provider: { type: 'string' },
                providerDisplay: { type: 'string' },
                active: { type: 'boolean' },
                model: { type: 'string' },
                name: { type: 'string' },
                enabled: { type: 'boolean' },
                note: { type: 'string' },
                reasoning: {
                  oneOf: [
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        recommended: { type: 'string' },
                        levels: {
                          type: 'array',
                          items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                              id: { type: 'string' },
                              name: { type: 'string' },
                              enabled: { type: 'boolean' },
                            },
                            required: ['id', 'name', 'enabled'],
                          },
                        },
                      },
                      required: ['levels'],
                    },
                    { type: 'null' },
                  ],
                },
              },
              required: ['provider', 'providerDisplay', 'active', 'model', 'name', 'enabled', 'note', 'reasoning'],
            },
          },
        },
        required: ['ok', 'total', 'models'],
      },
      render: (_args, value) => [{ type: 'text', text: renderModels(value) }],
    },
    async execute(args) {
      const all = args.all === true
      const providerFilter = typeof args.provider === 'string' && args.provider.trim() !== ''
        ? args.provider.trim()
        : undefined
      const snapshot = await buildModelsSnapshotAsync(ctx, store)
      const models = []
      for (const p of snapshot.providers) {
        if (providerFilter !== undefined && p.provider !== providerFilter) continue
        for (const m of p.models) {
          if (!all && !m.enabled) continue
          models.push({
            provider: p.provider,
            providerDisplay: p.providerDisplay,
            active: p.active,
            model: m.id,
            name: m.name,
            enabled: m.enabled,
            note: m.note,
            reasoning: m.reasoning === null
              ? null
              : {
                recommended: m.reasoning.recommended ?? '',
                levels: m.reasoning.levels.map((l) => ({ id: l.id, name: l.name, enabled: l.enabled })),
              },
          })
        }
      }
      return { ok: true, total: models.length, models }
    },
  }
}

/** 工具结果的文本渲染（给模型看的紧凑表格）。 */
function renderModels(value) {
  const lines = []
  const models = value.models ?? []
  if (models.length === 0) {
    lines.push('（没有匹配的模型）')
    return lines.join('\n')
  }
  for (const m of models) {
    const tags = []
    tags.push(m.enabled ? '启用' : '禁用')
    tags.push(m.active ? 'DSH激活' : 'DSH未激活')
    let reasoning = '无思考等级'
    if (m.reasoning !== null) {
      const usable = m.reasoning.levels.filter((l) => l.enabled).map((l) => l.name)
      const rec = m.reasoning.recommended
      reasoning = usable.length === 0
        ? '思考等级：全部禁用'
        : `思考等级：${usable.join('/')}${rec !== '' ? `（推荐 ${rec}）` : ''}`
    }
    lines.push(`- ${m.providerDisplay}(${m.provider}) / ${m.name}(${m.model}) [${tags.join(', ')}] ${reasoning}${m.note !== '' ? ` 备注：${m.note}` : ''}`)
  }
  lines.push(`共 ${value.total} 个模型`)
  return lines.join('\n')
}

/**
 * 装配模型配置模块：注册 de_models 工具（常驻，无独立开关——纯本地只读
 * 查询 + 插件自有配置，不占外部资源）。
 * @param {object} ctx - 插件根上下文。
 * @param {object} config - 插件配置（memoryDir 已解析）。
 * @returns {{ store: ModelConfigStore, dispose: () => void }} 装配句柄。
 */
export function installModels(ctx, config) {
  const store = new ModelConfigStore(join(config.memoryDir, MODELS_FILE))
  const disposers = []
  disposers.push(ctx.effect(() => {
    const d = ctx.tools.register(modelsToolDefinition(ctx, store))
    return () => d?.()
  }, 'dsh-memory-evolve: models tool'))
  return {
    store,
    dispose() {
      for (const d of disposers) {
        try { d?.() } catch { /* 忽略 */ }
      }
    },
  }
}

/** 校验并规范化一个 models/update 请求的 patch（供 api.js 使用）。 */
export function normalizeModelsPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('patch 必须是对象')
  }
  const next = {}
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
    next.enabled = patch.enabled
  }
  if (patch.note !== undefined) {
    if (typeof patch.note !== 'string') throw new Error('note 必须是字符串')
    if (patch.note.length > NOTE_MAX) throw new Error(`note 超过长度上限（${NOTE_MAX}）`)
    next.note = patch.note
  }
  if (patch.reasoning !== undefined) {
    const r = patch.reasoning
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error('reasoning 必须是对象')
    }
    const reasoning = {}
    if (r.enabled !== undefined && r.enabled !== null) {
      if (!Array.isArray(r.enabled)) throw new Error('reasoning.enabled 必须是等级 id 数组或 null')
      reasoning.enabled = r.enabled.map((id) => {
        if (typeof id !== 'string' || !LEVEL_ID_RE.test(id)) {
          throw new Error(`无效的思考等级 id "${id}"`)
        }
        return id
      })
    }
    if (r.custom !== undefined) {
      if (!Array.isArray(r.custom)) throw new Error('reasoning.custom 必须是数组')
      if (r.custom.length > CUSTOM_MAX) throw new Error(`自定义等级超过上限（${CUSTOM_MAX}）`)
      const seen = new Set()
      reasoning.custom = r.custom.map((c) => {
        const id = String(c?.id ?? '')
        const name = typeof c?.name === 'string' ? c.name.slice(0, 40) : ''
        if (!LEVEL_ID_RE.test(id)) throw new Error(`无效的自定义等级 id "${id}"`)
        if (seen.has(id)) throw new Error(`重复的自定义等级 id "${id}"`)
        seen.add(id)
        return { id, name: name === '' ? id : name }
      })
    }
    next.reasoning = reasoning
  }
  return next
}
