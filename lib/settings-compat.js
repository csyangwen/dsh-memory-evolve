/**
 * dsh-memory-evolve — 宿主 settings 服务的跨版本读取兼容层。
 *
 * 背景（2026-09-28 实证，宿主 0.1.7-rc.2）：宿主把 settings 从「命名空间注册表」
 * 换成「loader entry 配置表单」——`@deepseek-ai/dsh-settings` 的 SettingsForms 只
 * 暴露 configure/describe/update/replace/mutate，旧宿主（0.1.0-rc.x）的 `get(ns)`
 * 已移除，且 settings.yaml 被宿主导入 profile patch（重命名为 *.imported）。插件里
 * 任何 `ctx.settings.get(ns)` 都会抛 "ctx.settings.get is not a function"——本模块把
 * 两种形态收敛成一个只读取值函数，读不到一律返回 undefined（调用方按「未覆盖」降级），
 * 绝不抛错。
 *
 * 用法：
 *   const index = settingsEntryIndex(ctx.settings)   // describe() 一次建索引，多处取值
 *   index.get('llm-pi-ai')
 *   readSettingsEntry(ctx.settings, 'locale')        // 单点取值
 * @module settings-compat
 */

/**
 * describe() 结果按 ns 建索引（一次遍历多处取值；旧宿主没有 describe 时返回空表）。
 * @param {object} settings - ctx.settings（或 root 解析出的 settings 服务）。
 * @returns {Map<string, unknown>} ns → 该 entry 的有效配置值。
 */
export function settingsEntryIndex(settings) {
  const map = new Map()
  if (!settings || typeof settings.describe !== 'function') return map
  try {
    const list = settings.describe()
    if (!Array.isArray(list)) return map
    for (const descriptor of list) {
      if (descriptor && typeof descriptor.ns === 'string') map.set(descriptor.ns, descriptor.value)
    }
  } catch {
    /* 降级：空索引（调用方按「未覆盖」处理） */
  }
  return map
}

/**
 * 读某个 entry 命名空间的有效配置值：旧宿主走 get(ns)，新宿主走 describe()。
 * @param {object} settings - ctx.settings（或 root 解析出的 settings 服务）。
 * @param {string} ns - loader entry id（新宿主 descriptor.ns；旧宿主命名空间名）。
 * @returns {unknown} 有效配置值，或 undefined（服务缺失／未覆盖／读取失败）。
 */
export function readSettingsEntry(settings, ns) {
  if (!settings || typeof ns !== 'string' || ns.length === 0) return undefined
  if (typeof settings.get === 'function') {
    try { return settings.get(ns) } catch { return undefined }
  }
  return settingsEntryIndex(settings).get(ns)
}

/**
 * 该 settings 服务是否具备写入能力（新宿主 update+mutate / 旧宿主 register 作用域）。
 * @param {object} settings - ctx.settings。
 * @returns {boolean} 可按 entry 命名空间写入时为 true。
 */
export function canWriteSettings(settings) {
  if (!settings) return false
  if (typeof settings.update === 'function') return true
  return typeof settings.register === 'function'
}
