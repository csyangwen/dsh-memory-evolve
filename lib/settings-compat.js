/**
 * dsh-memory-evolve — DSH settings 服务「读」兼容层（2026-09-28，DSH 0.2.0 适配）。
 *
 * 为什么需要这一层（升级 0.1.5-rc.2 → 0.2.0-rc.1 时机械比对
 * packages/extensions/tool-cordis/src/api-catalog.ts 得出）：
 *
 *   旧版（≤ 0.1.5-rc.2）settings 服务：
 *     - get(ns)           → 直接返回某个命名空间的实时配置值；
 *     - register/installSection → 插件注册自己的设置命名空间；
 *     - 变更事件 'settings/updated'(ns, next, prev, source)。
 *
 *   新版（0.2.0-rc.1+）settings 服务：
 *     - get() / register() / installSection() **被移除**；
 *     - 改为 describe(options?) → SettingsDescriptor[]
 *       （每项 { ns, value, schema, revision, base, user, ... }），
 *       即「列出所有活跃插件 schema 及其实时值」，按 ns 自行查找；
 *     - 变更事件改名 'settings/document-updated'(ns, revision)。
 *
 * 插件只在两处依赖它，都是**只读**用途：
 *   1) locale 命名空间 → 决定宿主侧（工具描述 / 快照 / 反馈行）说什么语言；
 *   2) 各 provider 条目的 settingsNs → 读供应商/模型目录（de_models、会话编排
 *      的 provider 解析）。
 * 插件从不写 DSH settings（locale 命名空间归 DSH 自己的 locale 插件所有）。
 *
 * 因此本模块统一封装「读一个命名空间」，两种宿主都兼容：
 * 老宿主走 get()，新宿主走 describe() 建一次表再查 ns；读不到一律返回
 * undefined（调用方按"未配置"处理），绝不抛错打断工具调用。
 *
 * @module dsh-memory-evolve/settings-compat
 */

/** settings 命名空间的变更事件名（新旧宿主各一个；监听方两个都订阅才不丢事件）。
 *  老：'settings/updated'(ns, next, prev, source)；
 *  新：'settings/document-updated'(ns, revision)。两者第一个参数都是命名空间。 */
export const SETTINGS_CHANGE_EVENTS = ['settings/document-updated', 'settings/updated']

/**
 * 从插件上下文取出 settings 服务（可能不存在——DSH 允许不装 settings）。
 * @param {object|undefined} ctx - 插件/子模块上下文。
 * @returns {object|undefined} settings 服务实例。
 */
export function resolveSettingsService(ctx) {
  // ctx.get 是宿主实现，理论上可能抛错（依赖缺失/服务解析失败）——读服务本身
  // 不该把插件的 apply() 一起带崩，故这里吞掉异常退化为"没有 settings"。
  try {
    const fromGet = ctx?.get?.('settings')
    if (fromGet) return fromGet
  } catch {
    // 落到下面的属性兜底
  }
  // 兜底：宿主把 settings 作为 ctx 上的服务属性暴露时（老写法/测试桩）。
  return ctx?.settings
}

/**
 * 判断一个 settings 服务对象是否具备本插件需要的「读」能力。
 * 老宿主有 get()，新宿主有 describe()；两者都没有就不值得接线。
 * @param {object|undefined} settings - settings 服务实例。
 * @returns {boolean} 是否可读。
 */
export function hasSettingsRead(settings) {
  return !!settings && (typeof settings.get === 'function' || typeof settings.describe === 'function')
}

/**
 * 用单个 settings 服务对象读取一个命名空间的实时值（版本兼容）。
 * @param {object|undefined} settings - settings 服务实例。
 * @param {string} ns - 命名空间（如 'locale'，或 provider 条目的 settingsNs）。
 * @returns {unknown} 该命名空间的配置值；读不到返回 undefined。
 */
export function readSettingsValue(settings, ns) {
  if (!hasSettingsRead(settings) || typeof ns !== 'string' || ns.length === 0) return undefined
  try {
    // 老宿主（≤ 0.1.5-rc.2）：直接按命名空间取值。
    if (typeof settings.get === 'function') return settings.get(ns)
    // 新宿主（0.2.0-rc.1+）：describe() 列出全部活跃 schema 的实时值，按 ns 查找。
    const list = settings.describe()
    if (Array.isArray(list)) {
      const hit = list.find((entry) => entry && entry.ns === ns)
      if (hit) return hit.value
    }
    return undefined
  } catch {
    // 命名空间未注册 / schema 校验失败 / 宿主实现差异——一律按"未配置"处理。
    return undefined
  }
}

/**
 * 便捷封装：直接从插件上下文读一个命名空间。
 * @param {object|undefined} ctx - 插件上下文。
 * @param {string} ns - 命名空间。
 * @returns {unknown} 配置值或 undefined。
 */
export function readSettingsNamespace(ctx, ns) {
  return readSettingsValue(resolveSettingsService(ctx), ns)
}

/**
 * 批量读取器：反复读多个命名空间时，新宿主只调用一次 describe() 建表，
 * 避免「每个 provider 条目一次 describe」的平方级开销（de_models 快照会
 * 遍历全部可配置供应商）。
 *
 * 注意：返回的读取器持有建表那一刻的**快照**，只适合在「一次快照构建 /
 * 一次 provider 解析」范围内使用；跨回合长期持有请重新创建（语言等实时
 * 变化的场景由 SETTINGS_CHANGE_EVENTS 事件重新解析）。
 * @param {object|undefined} ctx - 插件上下文。
 * @returns {(ns: string) => unknown} 按命名空间取值的读取器。
 */
export function makeSettingsReader(ctx) {
  const settings = resolveSettingsService(ctx)
  if (!hasSettingsRead(settings)) return () => undefined
  if (typeof settings.get === 'function') {
    return (ns) => readSettingsValue(settings, ns)
  }
  let table = null
  return (ns) => {
    if (table === null) {
      table = new Map()
      try {
        const list = settings.describe()
        if (Array.isArray(list)) {
          for (const entry of list) {
            if (entry && typeof entry.ns === 'string') table.set(entry.ns, entry.value)
          }
        }
      } catch {
        // describe() 失败：留空表，后续一律返回 undefined。
      }
    }
    return table.get(ns)
  }
}
