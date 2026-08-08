/**
 * dsh-memory-evolve — 提示词管理器（Prompt Manager）模块。
 *
 * 复用插件的「写后即时注入、不打断回复」通道：注入的本质是把一段指令写进
 * 快照可见的位置，模型下一轮生成时自动看到。本模块提供：
 *
 *   1. 提示词库（prompts.json）：CRUD + 分类 + 标签 + 使用统计，来源以用户
 *      自写为主，内置一组程序员范式作为冷启动示例；新建/快速注入时分类
 *      留空自动归入「临时」（受管分类），「未分类」仅作删除分类后的兜底；
 *   2. 注入轨（prompt-injections.json）：活跃注入条目，带 roundsLeft 回合
 *      计数——每轮对话（主 agent 的 turn-stopping）递减，归零自动移除，
 *      rounds=1 即一次性注入，rounds=N 即持续提醒 N 轮，rounds=0 无限；
 *   3. 快照段「prompt:injections」：活跃注入时渲染进系统提示词快照（空时
 *      不渲染，遵守克制原则）；
 *   4. Web API（前缀 /memory-evolve/api/prompts）：GUI 数据面。
 *
 * 与 COI 模块同构：独立 prefix handler 与主 API 共存；自建存储、零第三方
 * 依赖（node:fs 原子写）。未来的文件/端口/Git 等监测注入（二期）只对接
 * 注入轨的 add 入口，本模块无需改动——注入 API 即预留的外部触发入口。
 *
 * @module dsh-memory-evolve/prompts
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 注入轨文件与提示词库文件（相对 memoryDir）。 */
const INJECTIONS_FILE = 'prompt-injections.json'
const PROMPTS_FILE = 'prompts.json'

/**
 * 一次注入允许的最大轮数（防御性上限，防手滑输超大数）。
 * 界面已放开为任意数字输入，这里只挡明显笔误（如 99999999）。
 */
const MAX_ROUNDS = 9999
/** 提示词内容上限（与 scratch 一致，512 KiB 级）。 */
const MAX_CONTENT_BYTES = 512 * 1024
/** 名称长度上限。 */
const MAX_NAME_LEN = 120
/** 分类名长度上限。 */
const MAX_CATEGORY_LEN = 40
/** 简介长度上限（简介是给 AI 选提示词时看的短摘要，不宜过长）。 */
const MAX_DESCRIPTION_LEN = 500

/**
 * 内置程序员范式（冷启动示例）——**数据与代码分离**：内容存放在独立的
 * `lib/prompts-seed.json`（本插件包内数据文件，非用户数据目录），可独立
 * 编辑/替换（如内置示例升级时只需换数据文件，逻辑零改动）。文件带
 * `version` 字段便于将来做内置示例版本迁移。加载失败时降级为空数组
 * （用户自写库不受影响）。
 * @type {Array<{name: string, category: string, tags: string[], content: string}>}
 */
export const SEED_PROMPTS = loadSeedPrompts()

/** 从包内数据文件加载内置示例。 */
function loadSeedPrompts() {
  try {
    const text = readFileSync(new URL('./prompts-seed.json', import.meta.url), 'utf8')
    const data = JSON.parse(text)
    if (Array.isArray(data?.prompts)) return data.prompts
    console.error('[prompts] prompts-seed.json 缺少 prompts 数组')
  } catch (error) {
    console.error('[prompts] 内置示例加载失败（降级为空）：', error?.message ?? error)
  }
  return []
}

/** 内置示例数据文件版本（供将来迁移判断）。 */
export const SEED_VERSION = (() => {
  try {
    const data = JSON.parse(readFileSync(new URL('./prompts-seed.json', import.meta.url), 'utf8'))
    return typeof data?.version === 'number' ? data.version : 1
  } catch {
    return 1
  }
})()

/**
 * JSON 存储基类：同步读写 + 原子写（临时文件 + rename），文件都是小文件。
 * 与 store.js 的跨进程锁不同——prompts 只由本插件（GUI + 快照段）读写，
 * 单进程内串行调用即可，无需锁。
 */
class JsonFile {
  /** @param {string} file - JSON 文件绝对路径。 */
  constructor(file) {
    this.file = file
  }

  /** 读取并解析；文件不存在或损坏时返回 fallback（不抛错，可自愈）。 */
  read(fallback) {
    try {
      const text = readFileSync(this.file, 'utf8')
      const data = JSON.parse(text)
      return data && typeof data === 'object' ? data : fallback
    } catch {
      return fallback
    }
  }

  /** 原子写：先写临时文件再 rename，避免写一半崩溃留下损坏文件。 */
  write(data) {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}

/**
 * 提示词库存储。
 * 条目：{ id, name, description, category, tags[], content, enabled,
 *         createdAt, updatedAt, usageCount, lastUsedAt }
 *   - description：简介（一句话说明用途，AI 的 de_prompts 列表用它选提示词）；
 *   - enabled：启用状态（默认 true；**禁用后不出现在 AI 的 de_prompts 列表、
 *     也不能被注入**——只影响 AI 通道，GUI 仍可见可编辑）。
 */
export class PromptStore {
  /** @param {string} dir - memoryDir。 */
  constructor(dir) {
    this.file = join(dir, PROMPTS_FILE)
    this.backing = new JsonFile(this.file)
  }

  /** 全量列表（含统计字段）。 */
  list() {
    return this.backing.read({ prompts: [] }).prompts ?? []
  }

  /** 单条查询；不存在返回 null。 */
  get(id) {
    return this.list().find((p) => p.id === id) ?? null
  }

  /**
   * 启用中的提示词列表（AI 的 de_prompts list 用）。
   * 语义：禁用/草稿状态的提示词不进 AI 可见列表（用户不打算让 AI 使用），
   * GUI 的「提示词库」仍显示全部（含禁用，便于重新启用）。
   */
  listEnabled() {
    return this.list().filter((p) => p.enabled !== false)
  }

  // ---------- 分类管理（受管实体：默认集合 + 添加/删除；提示词里出现
  //            的新分类自动隐式注册，保持一致性） ----------

  /**
   * 内置默认分类（首次 seed 时写入受管分类列表）。
   * 「临时」是**快速注入/新建留空**的默认落点（受管分类，可改名/删除）；
   * 「未分类」不是受管实体，保留"删除分类后落点"的兜底语义。
   */
  static DEFAULT_CATEGORIES = ['开发流程', '问题排查', '设计', '测试', '质量', '性能', '文档', '产品', '临时']

  /** 受管分类列表（不含「未分类」——它是兜底视图，非受管实体）。 */
  listCategories() {
    const data = this.backing.read({ prompts: [] })
    return Array.isArray(data.categories) ? data.categories : []
  }

  /**
   * 添加分类（受管列表）；校验：非空、长度上限。
   * **幂等**：同名分类已存在时不报错，返回 alreadyExists=true（前端提示
   * 并选中已有分类即可，不做成报错体验）。
   * @returns {{categories: string[], alreadyExists: boolean}} 更新后的列表 + 是否已存在。
   */
  addCategory(name) {
    const category = String(name ?? '').trim()
    if (!category) throw new Error('分类名不能为空')
    if (category.length > MAX_CATEGORY_LEN) throw new Error(`分类名过长（上限 ${MAX_CATEGORY_LEN} 字符）`)
    if (category === '未分类') throw new Error('「未分类」是内置兜底分类，无需添加')
    const data = this.backing.read({ prompts: [] })
    const categories = Array.isArray(data.categories) ? data.categories : []
    if (categories.includes(category)) return { categories, alreadyExists: true }
    categories.push(category)
    data.categories = categories
    this.backing.write(data)
    return { categories, alreadyExists: false }
  }

  /**
   * 重命名分类：受管列表替换 + 该分类下所有提示词同步改名。
   * 目标名不能为空/超长/「未分类」，不能与现有其他分类重名。
   * **宽容处理幽灵分类**：分类不在受管列表（提示词里残留的旧分类名，
   * 如删过受管分类前的存量数据）但该分类下还有提示词时同样允许改名——
   * 提示词同步改名并把新分类名注册进受管列表；完全不存在才报错。
   * @returns {{categories: string[], renamed: number}} 更新后的列表 + 被改名的提示词数。
   */
  renameCategory(oldName, newName) {
    const from = String(oldName ?? '').trim()
    const to = String(newName ?? '').trim()
    if (!from || from === '未分类') throw new Error('「未分类」不可改名')
    if (!to) throw new Error('分类名不能为空')
    if (to === '未分类') throw new Error('「未分类」是内置兜底分类，不能作为目标名')
    if (to.length > MAX_CATEGORY_LEN) throw new Error(`分类名过长（上限 ${MAX_CATEGORY_LEN} 字符）`)
    if (from === to) return { categories: this.listCategories(), renamed: 0 }
    const data = this.backing.read({ prompts: [] })
    const categories = Array.isArray(data.categories) ? data.categories : []
    const inList = categories.includes(from)
    const affected = (data.prompts ?? []).filter((p) => p.category === from).length
    if (!inList && affected === 0) throw new Error(`分类「${from}」不存在`)
    if (categories.includes(to)) throw new Error(`分类「${to}」已存在`)
    if (inList) data.categories = categories.map((c) => (c === from ? to : c))
    let renamed = 0
    for (const prompt of data.prompts) {
      if (prompt.category === from) {
        prompt.category = to
        renamed += 1
      }
    }
    // 幽灵分类改名后把新分类名注册进受管列表（隐式注册，保持数据一致）
    if (!inList && renamed > 0 && !data.categories.includes(to)) data.categories.push(to)
    this.backing.write(data)
    return { categories: data.categories, renamed }
  }

  /**
   * 删除分类：从受管列表移除，并把该分类下的提示词移到「未分类」
   * （不删除提示词本身——分类只是组织维度）。
   * **宽容处理幽灵分类**：分类不在受管列表但该分类下还有提示词时同样
   * 允许删除（提示词移到未分类、清理残留分类名）；完全不存在才报错。
   * @returns {{removed: boolean, moved: number}} 是否命中受管列表 + 被移动的提示词数。
   */
  removeCategory(name) {
    const category = String(name ?? '').trim()
    if (!category || category === '未分类') throw new Error('「未分类」不可删除')
    const data = this.backing.read({ prompts: [] })
    const categories = Array.isArray(data.categories) ? data.categories : []
    const inList = categories.includes(category)
    const affected = (data.prompts ?? []).filter((p) => p.category === category).length
    if (!inList && affected === 0) throw new Error(`分类「${category}」不存在`)
    if (inList) data.categories = categories.filter((c) => c !== category)
    let moved = 0
    for (const prompt of data.prompts) {
      if (prompt.category === category) {
        prompt.category = '未分类'
        moved += 1
      }
    }
    this.backing.write(data)
    return { removed: inList, moved }
  }

  /** 隐式注册：提示词使用了受管列表之外的分类名时自动追加（保持数据一致）。 */
  ensureCategory(data, category) {
    if (!category || category === '未分类') return
    if (!Array.isArray(data.categories)) data.categories = []
    if (!data.categories.includes(category)) data.categories.push(category)
  }

  /**
   * 新建提示词。
   * @param {{name: string, description?: string, category?: string, tags?: string[], content: string, enabled?: boolean}} input
   * @returns {object} 新条目。
   */
  create(input) {
    const name = String(input?.name ?? '').trim()
    const content = String(input?.content ?? '').trim()
    if (!name) throw new Error('名称不能为空')
    if (!content) throw new Error('内容不能为空')
    if (name.length > MAX_NAME_LEN) throw new Error(`名称过长（上限 ${MAX_NAME_LEN} 字符）`)
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) throw new Error('内容超过上限（512 KiB）')
    // 简介（可选）：给 AI 看的一句话摘要，去首尾空白；不填为空串
    const description = String(input?.description ?? '').trim()
    if (description.length > MAX_DESCRIPTION_LEN) throw new Error(`简介过长（上限 ${MAX_DESCRIPTION_LEN} 字符）`)
    // 启用状态（默认 true）：禁用后不出现在 AI 的 de_prompts 列表、不能注入
    const enabled = input?.enabled === undefined ? true : input.enabled === true
    // 分类留空 → 自动归入「临时」：快速注入/新建时用户不指定分类的默认落点，
    // 语义清晰且是受管分类（可改名/删除）；「未分类」只作删除分类后的兜底，
    // 不作为主动创建时的默认（避免混入"被动落点"数据）。
    const category = String(input?.category ?? '').trim() || '临时'
    if (category.length > MAX_CATEGORY_LEN) throw new Error(`分类名过长（上限 ${MAX_CATEGORY_LEN} 字符）`)
    const tags = Array.isArray(input?.tags)
      ? [...new Set(input.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 10)
      : []
    const now = Date.now()
    const prompt = {
      id: randomUUID(),
      name,
      description,
      category,
      tags,
      content,
      enabled,
      createdAt: now,
      updatedAt: now,
      usageCount: 0,
      lastUsedAt: null,
    }
    const data = this.backing.read({ prompts: [] })
    data.prompts.push(prompt)
    this.ensureCategory(data, category) // 新分类自动入受管列表
    this.backing.write(data)
    return prompt
  }

  /**
   * 局部更新（白名单字段）。
   * @returns {object} 更新后的条目。
   */
  update(id, patch) {
    const data = this.backing.read({ prompts: [] })
    const prompt = data.prompts.find((p) => p.id === id)
    if (!prompt) throw new Error(`提示词不存在：${id}`)
    if (patch?.name !== undefined) {
      const name = String(patch.name).trim()
      if (!name) throw new Error('名称不能为空')
      if (name.length > MAX_NAME_LEN) throw new Error(`名称过长（上限 ${MAX_NAME_LEN} 字符）`)
      prompt.name = name
    }
    if (patch?.description !== undefined) {
      // 简介（白名单字段）：编辑时清空 = 空简介（列表/AI 选词时回退显示内容首行）
      const description = String(patch.description).trim()
      if (description.length > MAX_DESCRIPTION_LEN) throw new Error(`简介过长（上限 ${MAX_DESCRIPTION_LEN} 字符）`)
      prompt.description = description
    }
    if (patch?.enabled !== undefined) {
      // 启用状态（白名单字段）：布尔严格校验，拒绝字符串 'false' 等脏数据
      if (typeof patch.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
      prompt.enabled = patch.enabled
    }
    if (patch?.category !== undefined) {
      // 编辑时清空分类 = 移回「未分类」（与删除分类的落点一致；新建时留空
      // 才是「临时」——两种语义分别对应"主动新建"与"编辑已有条目"）。
      const category = String(patch.category).trim() || '未分类'
      if (category.length > MAX_CATEGORY_LEN) throw new Error(`分类名过长（上限 ${MAX_CATEGORY_LEN} 字符）`)
      prompt.category = category
      this.ensureCategory(data, category) // 新分类自动入受管列表
    }
    if (patch?.tags !== undefined) {
      prompt.tags = Array.isArray(patch.tags)
        ? [...new Set(patch.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 10)
        : []
    }
    if (patch?.content !== undefined) {
      const content = String(patch.content).trim()
      if (!content) throw new Error('内容不能为空')
      if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) throw new Error('内容超过上限（512 KiB）')
      prompt.content = content
    }
    prompt.updatedAt = Date.now()
    this.backing.write(data)
    return prompt
  }

  /** 删除；返回是否命中。 */
  remove(id) {
    const data = this.backing.read({ prompts: [] })
    const before = data.prompts.length
    data.prompts = data.prompts.filter((p) => p.id !== id)
    if (data.prompts.length === before) return false
    this.backing.write(data)
    return true
  }

  /** 注入一次时记录使用统计。 */
  bumpUsage(id) {
    const data = this.backing.read({ prompts: [] })
    const prompt = data.prompts.find((p) => p.id === id)
    if (!prompt) return
    prompt.usageCount = (prompt.usageCount ?? 0) + 1
    prompt.lastUsedAt = Date.now()
    this.backing.write(data)
  }

  /** 首次运行（文件不存在）时写入内置示例。 */
  seedIfEmpty() {
    try {
      readFileSync(this.file, 'utf8')
      return // 已有数据，不覆盖
    } catch {
      /* 文件不存在或不可读 → 写入示例 */
    }
    const now = Date.now()
    const prompts = SEED_PROMPTS.map((p) => ({
      id: randomUUID(),
      name: p.name,
      description: p.description ?? '', // 内置示例自带简介（seed 数据文件），缺省空
      category: p.category,
      tags: p.tags,
      content: p.content,
      enabled: true, // 内置示例默认启用
      createdAt: now,
      updatedAt: now,
      usageCount: 0,
      lastUsedAt: null,
    }))
    // 默认分类集合（受管）随首次 seed 写入；已有数据（文件存在）不覆盖
    this.backing.write({
      version: 2,
      categories: [...PromptStore.DEFAULT_CATEGORIES],
      prompts,
    })
  }
}

/**
 * 注入轨存储。
 * 条目：{ id, sourcePromptId|null, title, content, roundsLeft, every,
 *        countdown, createdAt }
 *   - roundsLeft：剩余注入（出现）次数；**null = 无限**（持续注入，不自动
 *     过期，只能手动停止）；
 *   - every：注入间隔（回合数），1 = 每回合都注入（连续），3 = 每 3 回合
 *     注入 1 次（出现 1 轮、间隔 2 轮不出现）；
 *   - countdown：距下次出现还剩多少回合（0 = 下一轮快照出现）。
 * 每回合结束（agent/turn-stopping，仅主会话）调用 tickTurn 推进：
 *   出现轮结束 → 消耗一次（无限不消耗）；还有剩余则 countdown = every - 1；
 *   非出现轮结束 → countdown 递减；归零的下一轮出现。
 * roundsLeft 归零自动移除（一次性注入 = rounds=1, every=1；无限 = rounds=0）。
 * 兼容旧数据：缺失 every/countdown 的条目视为 every=1, countdown=0；
 * roundsLeft 缺失视为 1。
 */
export class InjectionStore {
  /** @param {string} dir - memoryDir。 */
  constructor(dir) {
    this.file = join(dir, INJECTIONS_FILE)
    this.backing = new JsonFile(this.file)
  }

  /** 活跃注入列表（按注入时间正序）。 */
  list() {
    return this.backing.read({ injections: [] }).injections ?? []
  }

  /** 是否存在某提示词来源的活跃注入（防重复注入同一提示词）。 */
  hasSource(promptId) {
    return this.list().some((i) => i.sourcePromptId === promptId)
  }

  /**
   * 写入一条注入。
   * @param {{sourcePromptId?: string|null, title: string, content: string, rounds?: number, every?: number}} input
   *   rounds=出现次数（默认 1；**0 = 无限**，持续注入直到手动停止）；
   *   every=注入间隔回合数（默认 1=每回合；**0 = 一次性**——只出现一次
   *   即结束，次数强制按 1 处理，用户"间隔 0"的直觉语义）。
   * @returns {object} 注入条目。
   */
  add(input) {
    const title = String(input?.title ?? '').trim() || '未命名提示词'
    const content = String(input?.content ?? '').trim()
    if (!content) throw new Error('注入内容不能为空')
    const everyRaw = input?.every
    if (everyRaw === 0) {
      // 间隔 0 = 一次性注入：下一轮出现一次即结束（rounds 语义被覆盖为 1，
      // 存 every=0 以便 UI 显示「只注入一次」；tickTurn 对 every=0 条目
      // 出现轮结束直接移除，不会进入间隔计数）。
      const injection = {
        id: randomUUID(),
        sourcePromptId: input?.sourcePromptId ?? null,
        title,
        content,
        roundsLeft: 1,
        every: 0,
        countdown: 0, // 注入后下一轮即出现
        createdAt: Date.now(),
      }
      const data = this.backing.read({ injections: [] })
      data.injections.push(injection)
      this.backing.write(data)
      return injection
    }
    const roundsRaw = input?.rounds
    // rounds 0/null = 无限；其余须为 1..MAX_ROUNDS 整数（非法回退 1）。
    const roundsLeft = roundsRaw === 0 || roundsRaw === null
      ? null
      : (Number.isInteger(roundsRaw) && roundsRaw >= 1 ? Math.min(roundsRaw, MAX_ROUNDS) : 1)
    const every = Number.isInteger(everyRaw) && everyRaw >= 1
      ? Math.min(everyRaw, MAX_ROUNDS)
      : 1
    const injection = {
      id: randomUUID(),
      sourcePromptId: input?.sourcePromptId ?? null,
      title,
      content,
      roundsLeft,
      every,
      countdown: 0, // 注入后下一轮即出现
      createdAt: Date.now(),
    }
    const data = this.backing.read({ injections: [] })
    data.injections.push(injection)
    this.backing.write(data)
    return injection
  }

  /**
   * 移除一条注入（用户手动提前结束）。
   * @returns {boolean} 是否命中。
   */
  remove(id) {
    const data = this.backing.read({ injections: [] })
    const before = data.injections.length
    data.injections = data.injections.filter((i) => i.id !== id)
    if (data.injections.length === before) return false
    this.backing.write(data)
    return true
  }

  /** 移除某提示词来源的全部注入（提示词被删除时级联清理）。 */
  removeBySource(promptId) {
    const data = this.backing.read({ injections: [] })
    const before = data.injections.length
    data.injections = data.injections.filter((i) => i.sourcePromptId !== promptId)
    if (data.injections.length !== before) this.backing.write(data)
  }

  /**
   * 一个对话回合结束：推进所有条目的出现计划（countdown 模型）。
   *   - 本回合是出现轮（countdown===0）→ **every=0 的一次性条目直接移除**；
   *     其余有限次数消耗一次（无限不消耗），还有剩余则 countdown = every - 1
   *     （间隔 every-1 个不出现的回合）；
   *   - 非出现轮 → countdown 递减；
   *   - 有限次数归零的移除（无限条目永不自动移除）。
   * @returns {string[]} 被移除的注入标题（供日志/调试）。
   */
  tickTurn() {
    const data = this.backing.read({ injections: [] })
    if (data.injections.length === 0) return []
    const expired = []
    const alive = []
    for (const injection of data.injections) {
      const every = Number.isInteger(injection.every) && injection.every >= 1 ? injection.every : 1
      const countdown = Number.isInteger(injection.countdown) ? injection.countdown : 0
      if (countdown === 0) {
        // 出现轮结束：every=0（一次性）出现一次即结束，不进次数/间隔模型
        if (injection.every === 0) {
          expired.push(injection.title)
          continue
        }
        // 有限次数消耗一次；无限（null）不消耗、不移除
        if (injection.roundsLeft !== null) {
          injection.roundsLeft = (injection.roundsLeft ?? 1) - 1
          if (injection.roundsLeft <= 0) {
            expired.push(injection.title)
            continue
          }
        }
        injection.countdown = every - 1
      } else {
        injection.countdown = countdown - 1
      }
      alive.push(injection)
    }
    data.injections = alive
    this.backing.write(data)
    return expired
  }
}

/**
 * 变量展开：{{date}} → 当天 YYYY-MM-DD，{{time}} → 当前 HH:MM。
 * 未知变量原样保留（二期监测注入的 {{path}}/{{event}} 等由监测侧扩展
 * 传入，本函数预留 vars 覆盖参数）。
 * @param {string} text - 模板文本。
 * @param {Record<string, string>} [vars] - 额外变量覆盖。
 * @returns {string} 展开后的文本。
 */
export function expandVars(text, vars = {}) {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const builtin = {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  }
  const all = { ...builtin, ...vars }
  return String(text).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (raw, key) =>
    Object.prototype.hasOwnProperty.call(all, key) ? all[key] : raw)
}

/**
 * 渲染快照段「prompt:injections」：只渲染"本回合该出现"的注入
 * （countdown===0），其余（间隔等待中的）不渲染——克制的间隔注入语义：
 * 连续注入每轮出现，间隔注入只在出现轮出现。空时输出空串（不注入）。
 *
 * **文案是写给模型看的指令，不是给用户看的系统状态**：标题直接声明
 * 「必须遵循」，**不出现"注入"字样与任何机制解释**（模型不需要知道
 * 规则是怎么进来的、何时会被移除——快照里出现的即是当前生效的规则，
 * 没有多余引导句）；也不写「活跃 N 条」「可在 Tab 移除」这类 GUI 话术。
 * @param {InjectionStore} store
 * @returns {string} 快照文本。
 */
export function renderInjectionSnapshot(store) {
  const injections = store.list().filter((i) => (Number.isInteger(i.countdown) ? i.countdown : 0) === 0)
  if (injections.length === 0) return ''
  const lines = ['## 用户规则（必须遵循）']
  for (const injection of injections) {
    lines.push(`- 「${injection.title}」：`)
    const body = injection.content.split('\n').map((line) => `  ${line}`).join('\n')
    lines.push(body)
  }
  return lines.join('\n')
}

/**
 * GitHub 提示词范式来源链接（用户自取，不做爬虫导入；界面「来源」区展示）。
 * @type {Array<{name: string, url: string, desc: string}>}
 */
export const PROMPT_SOURCES = [
  { name: 'awesome-chatgpt-prompts', url: 'https://github.com/f/awesome-chatgpt-prompts', desc: '通用提示词大全（120K+ stars，含 CSV/MD 可参考格式）' },
  { name: 'GitHub Spec Kit', url: 'https://github.github.com/spec-kit/', desc: 'GitHub 官方 spec-driven AI 开发套件（PRD/规范/Spec 写作范式）' },
  { name: 'SpecRoute', url: 'https://github.com/Enovatr-Labs/SpecRoute', desc: 'spec-driven 开发框架：PRD、提示词、技能、编码规则（Codex/Claude）' },
  { name: 'ai-specs', url: 'https://github.com/ferreyes/ai-specs', desc: '面向多种 AI 编码工具的开发规则/标准集' },
  { name: 'lidr-specboot', url: 'https://github.com/LIDR-academy/lidr-specboot', desc: '可导入任意项目的开发规则与 AI agent 配置集' },
  { name: 'awesome-prompts', url: 'https://github.com/ai-boost/awesome-prompts', desc: 'GPTs Store 高分提示词精选 + 提示工程论文' },
]

/**
 * 提示词列表渲染：把 list 结果压成一行一个（名称/分类/id/简介），保持
 * 输出克制——正文只在 get 详情时返回，列表不塞长文本。
 */
function renderPromptList(items) {
  const lines = items.map((p) => {
    const desc = p.description ? `：${p.description}` : ''
    return `- ${p.name}（${p.category}）id=${p.id}${desc}`
  })
  return `启用中的提示词 ${items.length} 条（含分类/简介/id，不含正文——需要全文用 get 查详情）\n${lines.join('\n')}`
}

/**
 * 提示词输出归一化：与 output schema 的 prompt 对象严格一致（additionalProperties:
 * false 下多字段/缺字段都会被模型 API 拒绝——既有踩坑）。enabled/usageCount
 * 兜底旧数据、lastUsedAt 可空（oneOf null）。get/create/update 共用。
 */
function toPromptOutput(p) {
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? '',
    category: p.category,
    tags: p.tags ?? [],
    content: p.content,
    enabled: p.enabled !== false,
    usageCount: p.usageCount ?? 0,
    lastUsedAt: p.lastUsedAt ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}

/**
 * 「提示词库」工具（de_prompts）：AI 查询并注入提示词。
 *
 * **正确用途（写进 description 供模型理解）**：提示词库是标准工作范式的
 * 资产库（代码审查/调试/测试/PRD…）。AI 需要时：
 *   1. list —— 查看**启用中**的提示词（id/名称/简介/分类/标签，不含正文；
 *      禁用与草稿不显示）；
 *   2. get  —— 按 id 取详情（含正文全文与状态/统计）——选中后可作为
 *      子会话/子代理/CLI 任务的提示词（配合 de_session / subagent /
 *      de_coi_dispatch 使用）；
 *   3. inject —— 把提示词注入当前会话（写入注入轨，模型下一轮自动遵循；
 *      rounds=次数 0=无限，every=间隔 0=只注入一次）。
 *
 * @param {object} config - 插件配置（promptToolName）。
 * @param {PromptStore} promptStore - 提示词库存储。
 * @param {InjectionStore} injectionStore - 注入轨存储。
 * @returns {object} DSH 工具定义（name/description/parameters/output/execute）。
 */
export function promptsToolDefinition(config, promptStore, injectionStore) {
  return {
    // config.promptToolName 来自 resolveConfig 默认 'de_prompts'；兜底默认值
    // 保证直接构造（测试/其他调用方）也不出现 undefined 工具名。
    name: config.promptToolName || 'de_prompts',
    description: '查询/创建/修改并注入「提示词库」（prompts）。**正确用途**：提示词库是标准工作范式资产库（代码审查/调试/测试/PRD/架构…）；需要给当前会话注入纪律或流程、或给子会话/子代理/CLI 任务（de_session / subagent / de_coi_dispatch）挑选现成提示词时，先 list 查看可用提示词（只显示启用中：id/名称/简介/分类/标签，不含正文），选定后 get <id> 取详情（含正文全文），或直接 inject <id> 注入当前会话（写入注入轨，模型下一轮自动看到并遵循）。**create 创建提示词**（name+content 必填，description/category/tags/enabled 可选——"把这次的经验固化成可复用范式"时用；创建后返回完整条目含 id）；**update 按 id 修改**（传哪个字段改哪个：name/content/description/category/tags/enabled，至少一个）。**list 支持多维过滤（均可选、可组合，同时给多个=全部满足）**：name=按名称过滤、category=按分类名称过滤、tag=按标签/场景过滤、description=按备注/简介过滤、filter=通用关键词（名称/简介/标签/分类任意字段）；limit=最多条数；未查到会明确提示是哪个条件没匹配。inject 支持 rounds（次数：1=一次默认，N=有限 N 次，0=无限持续）与 every（间隔：1=每回合默认，0=只注入一次，N=每 N 回合一次）。禁用状态的提示词不出现在列表、也不能注入（get 仍可查详情）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'update', 'inject'],
          description: 'list=列出启用中的提示词；get=按 id 查详情（含正文全文）；create=创建提示词（name+content 必填）；update=按 id 修改提示词（传哪个字段改哪个）；inject=注入指定提示词到当前会话',
        },
        id: {
          type: 'string',
          description: 'get / update / inject 必填：提示词 id（来自 list 返回或 create 结果）',
        },
        name: {
          type: 'string',
          description: 'create 必填 / update 可选 / list 可选（按名称过滤）：提示词名称',
        },
        content: {
          type: 'string',
          description: 'create 必填 / update 可选：提示词正文（Markdown，支持 {{date}}/{{time}} 变量注入时展开）',
        },
        description: {
          type: 'string',
          description: 'create/update 可选 / list 可选（按备注过滤）：提示词简介——一句话说明用途（AI 选词时看它）',
        },
        category: {
          type: 'string',
          description: 'create/update 可选 / list 可选（按分类过滤）：分类名；create 留空自动归入「临时」，update 留空移回「未分类」',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'create/update 可选：标签数组（去重，最多 10 个）',
        },
        enabled: {
          type: 'boolean',
          description: 'create/update 可选：启用状态（默认 true；false=禁用——不出现在 list、不能被 inject）',
        },
        filter: {
          type: 'string',
          description: 'list 可选：通用关键词过滤——名称/简介/标签/分类任意字段包含即命中（大小写不敏感；可与 name/category/tag/description 组合，全部满足才返回）',
        },
        name: {
          type: 'string',
          description: 'list 可选：按名称过滤（子串，大小写不敏感）',
        },
        category: {
          type: 'string',
          description: 'list 可选：按分类名称过滤（子串，大小写不敏感；如「开发流程」「测试」）',
        },
        tag: {
          type: 'string',
          description: 'list 可选：按标签/场景过滤（子串，大小写不敏感；如「review」「debug」）',
        },
        description: {
          type: 'string',
          description: 'list 可选：按备注/简介过滤（子串，大小写不敏感）',
        },
        limit: {
          type: 'integer',
          description: 'list 可选：最多返回条数（默认全部）',
        },
        rounds: {
          type: 'integer',
          description: 'inject 可选：注入次数，1=只注入一次（默认），N=有限 N 次，0=无限持续直到手动停止',
        },
        every: {
          type: 'integer',
          description: 'inject 可选：注入间隔回合数，1=每回合（默认），0=只注入一次，N=每 N 回合出现一次',
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
          action: { type: 'string' },
          prompts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                category: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
              },
              required: ['id', 'name', 'description', 'category', 'tags'],
            },
          },
          prompt: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              category: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              content: { type: 'string' },
              enabled: { type: 'boolean' },
              usageCount: { type: 'integer' },
              lastUsedAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              createdAt: { type: 'integer' },
              updatedAt: { type: 'integer' },
            },
            required: ['id', 'name', 'description', 'category', 'tags', 'content', 'enabled', 'usageCount', 'lastUsedAt', 'createdAt', 'updatedAt'],
          },
          injection: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              sourcePromptId: { type: 'string' },
              title: { type: 'string' },
              content: { type: 'string' },
              roundsLeft: { type: 'integer' },
              every: { type: 'integer' },
              countdown: { type: 'integer' },
              createdAt: { type: 'integer' },
            },
            required: ['id', 'sourcePromptId', 'title', 'content', 'roundsLeft', 'every', 'countdown', 'createdAt'],
          },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: (() => {
          if (!value.ok) return `de_prompts: ${value.message}`
          if (value.action === 'list') return renderPromptList(value.prompts ?? [])
          // get/create/update 都带完整 prompt 对象 → 渲染详情文本
          if (value.prompt) {
            const p = value.prompt
            const state = p.enabled ? '启用' : '禁用'
            return `「${p.name}」\n分类：${p.category} · 状态：${state} · 已注入 ${p.usageCount} 次\n简介：${p.description || '（无）'}\n标签：${(p.tags ?? []).join(', ') || '（无）'}\n正文：\n${p.content}`
          }
          return value.message // inject 结果 / 其他
        })(),
      }],
    },
    async execute(args) {
      const action = String(args?.action ?? '')
      try {
        if (action === 'list') {
          // 只列启用中的提示词（禁用/草稿不进 AI 视野）。多维过滤（均可选、
          // 可组合，同时给多个 = AND 全部满足）：
          //   name=按名称 / category=按分类名称 / tag=按标签（场景）/
          //   description=按备注（简介）/ filter=通用关键词（任意字段）；
          // 每个条件都是子串匹配（大小写不敏感）。limit 截断。
          // 列表不含正文——克制输出，正文留给 get 详情。
          let items = promptStore.listEnabled()
          const qName = String(args?.name ?? '').trim().toLowerCase()
          const qCategory = String(args?.category ?? '').trim().toLowerCase()
          const qTag = String(args?.tag ?? '').trim().toLowerCase()
          const qDescription = String(args?.description ?? '').trim().toLowerCase()
          const qFilter = String(args?.filter ?? '').trim().toLowerCase()
          if (qName || qCategory || qTag || qDescription || qFilter) {
            const hasField = (value, q) => q === '' || String(value ?? '').toLowerCase().includes(q)
            items = items.filter((p) =>
              hasField(p.name, qName)
              && hasField(p.category, qCategory)
              && (!qTag || (p.tags ?? []).some((t) => t.toLowerCase().includes(qTag)))
              && hasField(p.description, qDescription)
              && (!qFilter || (
                `${p.name} ${p.category} ${p.description ?? ''} ${(p.tags ?? []).join(' ')}`.toLowerCase().includes(qFilter)
              )))
          }
          if (args?.limit !== undefined && Number.isInteger(args.limit) && args.limit > 0) {
            items = items.slice(0, args.limit)
          }
          const prompts = items.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description ?? '',
            category: p.category,
            tags: p.tags ?? [],
          }))
          // 未命中时的明确提示：指出是哪个条件没匹配（而非笼统的"查无"），
          // 并给出"共 N 条启用中 + 去掉条件重查"的下一步指引。
          let message
          if (prompts.length === 0) {
            const conditions = []
            if (qName) conditions.push(`名称「${args.name}」`)
            if (qCategory) conditions.push(`分类「${args.category}」`)
            if (qTag) conditions.push(`标签「${args.tag}」`)
            if (qDescription) conditions.push(`备注「${args.description}」`)
            if (qFilter) conditions.push(`关键词「${args.filter}」`)
            const total = promptStore.listEnabled().length
            message = conditions.length > 0
              ? `未查到匹配的启用提示词：${conditions.join(' + ')}（当前共 ${total} 条启用中——可去掉部分条件重查，或 list 无参数查看全部）`
              : `暂无启用中的提示词（当前共 ${total} 条已禁用/不存在）`
          } else {
            message = `启用中的提示词：${prompts.length} 条（确定后 get <id> 取详情，或 inject <id> 注入当前会话）`
          }
          return { ok: true, message, action: 'list', prompts }
        }
        if (action === 'get') {
          const id = String(args?.id ?? '').trim()
          if (!id) return { ok: false, message: 'get 需要 id（来自 list 返回）', action: 'get' }
          const p = promptStore.get(id)
          if (!p) return { ok: false, message: `提示词不存在：${id}（可先 list 查看可用提示词）`, action: 'get' }
          // 详情返回全部字段（含正文/状态/统计）；禁用提示词也可查（AI 自行判断）
          return {
            ok: true,
            message: `「${p.name}」详情（${p.enabled === false ? '已禁用' : '启用中'}，已注入 ${p.usageCount ?? 0} 次）`,
            action: 'get',
            prompt: toPromptOutput(p),
          }
        }
        if (action === 'create') {
          // 模型自建提示词：name+content 必填（与 GUI 新建同一校验/语义——
          // 分类留空自动归入「临时」，其余字段可选）。创建后返回完整条目
          // （含 id），模型可继续 inject 或 update 调整。
          const created = promptStore.create({
            name: args?.name,
            content: args?.content,
            description: args?.description,
            category: args?.category,
            tags: args?.tags,
            enabled: args?.enabled,
          })
          return {
            ok: true,
            message: `已创建提示词「${created.name}」（分类：${created.category}，id=${created.id}）——可 inject 注入当前会话，或 update <id> 继续修改`,
            action: 'create',
            prompt: toPromptOutput(created),
          }
        }
        if (action === 'update') {
          // 按 id 修改：白名单字段（name/content/description/category/tags/enabled），
          // 传哪个改哪个；至少一个字段（避免空更新）。与 GUI 编辑同一校验。
          const id = String(args?.id ?? '').trim()
          if (!id) return { ok: false, message: 'update 需要 id（来自 list 返回或 create 结果）', action: 'update' }
          const patch = {}
          for (const key of ['name', 'content', 'description', 'category', 'tags', 'enabled']) {
            if (args?.[key] !== undefined) patch[key] = args[key]
          }
          if (Object.keys(patch).length === 0) {
            return { ok: false, message: 'update 至少要改一个字段（name/content/description/category/tags/enabled）', action: 'update' }
          }
          const updated = promptStore.update(id, patch)
          return {
            ok: true,
            message: `已更新提示词「${updated.name}」（分类：${updated.category}，enabled=${updated.enabled !== false}）`,
            action: 'update',
            prompt: toPromptOutput(updated),
          }
        }
        if (action === 'inject') {
          const id = String(args?.id ?? '').trim()
          if (!id) return { ok: false, message: 'inject 需要 id（来自 list 返回）', action: 'inject' }
          const p = promptStore.get(id)
          if (!p) return { ok: false, message: `提示词不存在：${id}（可先 list 查看可用提示词）`, action: 'inject' }
          // 禁用提示词不可注入（与 list 隐藏同一语义：用户停用的不用于 AI 注入）
          if (p.enabled === false) {
            return { ok: false, message: `「${p.name}」已禁用，不能注入（可在 GUI 提示词库中重新启用）`, action: 'inject' }
          }
          if (injectionStore.hasSource(id)) {
            return { ok: false, message: `「${p.name}」已在注入中（可先在 GUI「注入中」移除再重新注入）`, action: 'inject' }
          }
          // rounds：缺省 1=只注入一次；0=无限；其余须 ≥1 整数（与 Web API 同规则）
          const rounds = args?.rounds === undefined ? 1 : Number(args.rounds)
          if (rounds !== 0 && (!Number.isInteger(rounds) || rounds < 1)) {
            return { ok: false, message: 'rounds 必须是 ≥1 的整数，或 0 表示无限', action: 'inject' }
          }
          // every：缺省 1=每回合；0=只注入一次；其余须 ≥0 整数
          const every = args?.every === undefined ? 1 : Number(args.every)
          if (!Number.isInteger(every) || every < 0) {
            return { ok: false, message: 'every 必须是 ≥0 的整数（0 = 只注入一次）', action: 'inject' }
          }
          const injection = injectionStore.add({
            sourcePromptId: id,
            title: p.name,
            content: expandVars(p.content),
            rounds,
            every,
          })
          promptStore.bumpUsage(id)
          // 注入成功文案：次数+间隔组合的**实际行为**，避免"1 次，每回合"
          // 之类的歧义（rounds=1 是一次性，不是每回合都注入）：
          //   rounds=1 → 「只注入一次」；rounds=N → 「注入 N 次」；rounds=0 → 「持续注入」
          //   every=0 → 无括号说明；every=1 → （每回合出现）；every=N → （每 N 回合出现）
          //   收尾：一次性「之后自动结束」/ 有限「用尽自动结束」/ 无限「直到手动停止」
          const times = rounds === 0 ? '持续注入' : (rounds === 1 ? '只注入一次' : `注入 ${rounds} 次`)
          // rounds=1 时 every 无实际意义（出现一次即结束），省略节奏括号；
          // 有限 N 次/无限才说明出现节奏
          const cadence = every === 0 || rounds === 1 ? '' : (every === 1 ? '（每回合出现）' : `（每 ${every} 回合出现）`)
          const ending = every === 0 || rounds === 1
            ? '，之后自动结束'
            : (rounds === 0 ? '，直到手动停止' : '，用尽自动结束')
          return {
            ok: true,
            message: `已注入「${p.name}」：${times}${cadence}，模型下一轮生效${ending}`,
            action: 'inject',
            injection,
          }
        }
        return { ok: false, message: `未知 action：${action}（支持 list / get / inject）`, action: action || '' }
      } catch (error) {
        return { ok: false, message: error?.message ?? String(error), action: action || '' }
      }
    },
  }
}

/**
 * 安装提示词管理器：
 *   1. 存储 + 内置示例 seed；
 *   2. 快照段注册（出现轮注入渲染进系统提示词）；
 *   3. agent/turn-stopping 回合推进（仅主会话 agent，subagent 回合不消耗）；
 *   4. Web API（/memory-evolve/api/prompts，与 COI 同构独立 prefix）。
 * 所有注册的 disposer 收集进 dispose()——由上层（index.js 的 promptsCtrl）
 * 按运行时开关整体安装/卸载（与 COI 模块同构）。
 * @param {object} ctx - 插件上下文（systemPrompt 注入）。
 * @param {object} config - 插件配置（memoryDir 必填）。
 * @returns {{promptStore: PromptStore, injectionStore: InjectionStore, dispose: () => void}}
 *   供上层暴露给 Web API / 测试 / 卸载。
 */
export function installPrompts(ctx, config) {
  const promptStore = new PromptStore(config.memoryDir)
  const injectionStore = new InjectionStore(config.memoryDir)
  promptStore.seedIfEmpty()
  const disposers = []

  // 0. AI 工具（de_prompts）：查询/注入提示词库——随本模块开关整体安装/
  //    卸载（promptsEnabled=false 时工具不注册，模型不可见）。ctx.tools
  //    来自插件级 inject 声明（'tools' 已注入），真实运行时直接可用。
  disposers.push(ctx.effect(() => ctx.tools.register(
    promptsToolDefinition(config, promptStore, injectionStore),
  ), 'dsh-memory-evolve: prompts tool'))

  // 1. 快照段：出现轮注入渲染（空时返回 ''，不产生任何快照文本）。
  disposers.push(ctx.effect(() => ctx.systemPrompt.context({
    name: 'prompt:injections',
    order: 520, // 在 memory:snapshot (500) 之后
    text: () => renderInjectionSnapshot(injectionStore),
  }), 'dsh-memory-evolve: prompt injections snapshot'))

  // 2. 回合推进：主 agent 回合即将关闭时推进注入计划。
  //    subagent 的回合不计数（避免子任务偷偷消耗注入次数）；listener 全程
  //    try/catch——事件回调抛异常会带崩进程（项目既有踩坑）。
  disposers.push(ctx.on('agent/turn-stopping', (payload) => {
    try {
      const header = payload?.agent?.session?.header
      if (!header || header.origin === 'subagent') return
      const expired = injectionStore.tickTurn()
      if (expired.length > 0) {
        console.log(`[prompts] 注入到期移除：${expired.join('、')}`)
      }
    } catch (error) {
      console.error('[prompts] turn-stopping 推进失败：', error)
    }
  }))

  // 3. Web API（web-only：TUI 上无 httpServer 时自然跳过）。
  ctx.inject(['httpServer'], (webCtx) => {
    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname
      const base = '/memory-evolve/api/prompts'
      const readBody = async (maxBytes = 256 * 1024) => {
        const chunks = []
        let total = 0
        for await (const chunk of req) {
          total += chunk.length
          if (total > maxBytes) throw new Error('body too large')
          chunks.push(chunk)
        }
        if (chunks.length === 0) return {}
        try {
          return JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          throw new Error('invalid JSON body')
        }
      }
      const sendJson = (status, body) => {
        const text = JSON.stringify(body)
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(text)
      }
      try {
        // ---- 提示词库 ----
        if (req.method === 'GET' && path === base) {
          return sendJson(200, { prompts: promptStore.list() })
        }
        if (req.method === 'POST' && path === base) {
          const body = await readBody()
          return sendJson(200, { prompt: promptStore.create(body) })
        }
        // ---- 注入轨（先于 :id 通配匹配） ----
        if (req.method === 'GET' && path === `${base}/injections`) {
          return sendJson(200, { injections: injectionStore.list() })
        }
        if (req.method === 'DELETE' && path.startsWith(`${base}/injections/`)) {
          const id = decodeURIComponent(path.slice(`${base}/injections/`.length))
          if (!id) throw new Error('id 不能为空')
          return sendJson(200, { ok: injectionStore.remove(id) })
        }
        if (req.method === 'GET' && path === `${base}/sources`) {
          return sendJson(200, { sources: PROMPT_SOURCES })
        }
        // ---- 分类管理（受管实体；先于 :id 通配匹配） ----
        if (req.method === 'GET' && path === `${base}/categories`) {
          return sendJson(200, { categories: promptStore.listCategories() })
        }
        if (req.method === 'POST' && path === `${base}/categories`) {
          const body = await readBody()
          return sendJson(200, promptStore.addCategory(body?.name))
        }
        if (req.method === 'PUT' && path.startsWith(`${base}/categories/`)) {
          // 重命名分类：{ name: 新名 }；该分类下提示词同步改名
          const name = decodeURIComponent(path.slice(`${base}/categories/`.length))
          const body = await readBody()
          return sendJson(200, promptStore.renameCategory(name, body?.name))
        }
        if (req.method === 'DELETE' && path.startsWith(`${base}/categories/`)) {
          const name = decodeURIComponent(path.slice(`${base}/categories/`.length))
          return sendJson(200, promptStore.removeCategory(name))
        }
        // ---- 单条提示词操作（含 /:id/inject 子路由） ----
        const match = /^\/memory-evolve\/api\/prompts\/([^/]+)(?:\/(inject))?$/.exec(path)
        if (match) {
          const id = decodeURIComponent(match[1])
          const sub = match[2] // 'inject' | undefined
          if (req.method === 'GET') {
            const prompt = promptStore.get(id)
            if (!prompt) return sendJson(404, { error: `提示词不存在：${id}` })
            return sendJson(200, { prompt })
          }
          if (req.method === 'PUT') {
            const body = await readBody()
            return sendJson(200, { prompt: promptStore.update(id, body) })
          }
          if (req.method === 'DELETE') {
            const ok = promptStore.remove(id)
            if (!ok) return sendJson(404, { error: `提示词不存在：${id}` })
            injectionStore.removeBySource(id) // 级联清理该来源的活跃注入
            return sendJson(200, { ok: true })
          }
          if (req.method === 'POST' && sub === 'inject') {
            const body = await readBody()
            const prompt = promptStore.get(id)
            if (!prompt) throw new Error(`提示词不存在：${id}`)
            if (injectionStore.hasSource(id)) {
              throw new Error(`「${prompt.name}」已在注入中（可在「注入中」列表先移除再重新注入）`)
            }
            // rounds: 0 = 无限；≥1 整数 = 有限次数
            const rounds = body?.rounds === undefined ? 1 : Number(body.rounds)
            if (rounds !== 0 && (!Number.isInteger(rounds) || rounds < 1)) {
              throw new Error('rounds 必须是 ≥1 的整数，或 0 表示无限')
            }
            const every = body?.every === undefined ? 1 : Number(body.every)
            if (!Number.isInteger(every) || every < 0) throw new Error('every 必须是 ≥0 的整数（0 = 只注入一次）')
            const injection = injectionStore.add({
              sourcePromptId: id,
              title: prompt.name,
              content: expandVars(prompt.content),
              rounds,
              every,
            })
            promptStore.bumpUsage(id)
            return sendJson(200, { injection })
          }
        }
        sendJson(404, { error: 'not found' })
      } catch (error) {
        sendJson(400, { error: error?.message ?? String(error) })
      }
    }
    webCtx.effect(() => {
      disposers.push(webCtx.httpServer.register({
        kind: 'prefix',
        path: '/memory-evolve/api/prompts',
        handler,
      }))
    }, 'dsh-memory-evolve: prompts web api')
  })

  /** 整体卸载（promptsEnabled 运行时关闭时调用；存储数据保留）。 */
  const dispose = () => {
    for (const d of disposers) {
      try { d?.() } catch { /* 忽略 */ }
    }
  }

  return { promptStore, injectionStore, dispose }
}
