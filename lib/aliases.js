/**
 * 会话别名仓库（aliases.json）— 会话的友好名称。
 *
 * 会话 ID（session-xxx）对用户不友好：广播面板/快照里满屏长 ID。别名
 * 是**会话的全局属性**（不只广播用——快照「你的会话」段的其他消费者
 * 也需要），独立存储于 <memoryDir>/aliases.json：
 *   { sessionId: 别名 }（最多 10 字，允许重复——ID 才是唯一标识）
 *
 * 显示策略（别名优先）：有别名显示「别名」，无别名回退短 ID；完整 ID
 * 悬停/括号可见（AI 发消息仍需要 ID）。
 * 修改 = 覆盖；清空/删除 = 移除别名。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { translate, getLocale, MISC2_DICT } from './i18n.js'

/** Translate through MISC2_DICT in the active host locale. */
const alt = (key, params) => translate(MISC2_DICT, key, params, getLocale())

/** 别名长度上限（10 个字符，中文友好）。 */
export const ALIAS_MAX_LEN = 10

/**
 * 读取别名字典（live-read：快照/面板每次读文件，写入即时生效）。
 * @param {string} dir - memoryDir。
 * @returns {Record<string, string>} { sessionId: 别名 }
 */
export function readAliases(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'aliases.json'), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {} // 文件缺失/损坏：空表
  }
}

export class AliasStore {
  /**
   * @param {string} dir - memoryDir（aliases.json 所在目录）。
   */
  constructor(dir) {
    this.file = join(dir, 'aliases.json')
    this.aliases = readAliases(dir)
  }

  #save() {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(this.aliases, null, 2) + '\n')
    renameSync(tmp, this.file)
  }

  /** 取别名；无返回 undefined。 */
  get(sessionId) {
    return this.aliases[sessionId]
  }

  /**
   * 设置别名（覆盖；空串/纯空格 = 清除）。
   * @param {string} sessionId
   * @param {string} name
   * @returns {{ok:boolean, message:string}}
   */
  set(sessionId, name) {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return { ok: false, message: alt('alias.needsSid') }
    const text = String(name ?? '').trim()
    if (text === '') {
      // 清空 = 移除别名
      if (this.aliases[sid] !== undefined) {
        delete this.aliases[sid]
        this.#save()
      }
      return { ok: true, message: alt('alias.cleared') }
    }
    if (text.length > ALIAS_MAX_LEN) {
      return { ok: false, message: alt('alias.tooLong', { max: ALIAS_MAX_LEN, len: text.length }) }
    }
    this.aliases[sid] = text
    this.#save()
    return { ok: true, message: alt('alias.set', { alias: text }) }
  }

  /** 清除别名。 */
  remove(sessionId) {
    return this.set(sessionId, '')
  }

  /** 全部别名（面板一次拉取渲染）。 */
  all() {
    return { ...this.aliases }
  }
}
