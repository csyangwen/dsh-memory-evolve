/**
 * 评审员约束存储（2026-08-12 用户拍板：四层级——系统提示词 / 项目约束 /
 * 会话约束 / 评审会话约束）。
 *
 * 本模块管理后三层（系统提示词在既有 config.advisorSystemPrompt）：
 *
 * - **全局约束**（global）：**所有项目、所有会话**都生效（2026-08-12
 *   用户拍板：与系统提示词区分——提示词一般不改，全局约束词是日常层）；
 * - **项目约束**（project）：按工作区 cwd 隔离，同一 cwd 的所有会话共享
 *   同一条（编辑保存即生效，重启/刷新保留）；
 * - **会话约束**（session）：按会话 id 隔离，本会话内一直有效（跨「新建
 *   评审会话」保留）；
 * - **评审会话约束**（conversation）：绑定评审会话（epoch）——存于
 *   conversation 持久化文件（{ epoch, messages, scopeText }），**新建
 *   评审会话（resetConversation）即清空**。
 *
 * 存储位置（<dataDir>/advisor/）：
 * - global-scope.json：{ text }（全局约束，所有项目/会话共享）
 * - project-scopes.json：{ [cwd]: text }
 * - session-scopes/<safeId>.json：{ text }
 * - conversations/<safeId>.json：{ epoch, messages, scopeText }
 *
 * 纯类（fs 由注入的 storage 提供以支持测试）；原子写由调用方保证。
 * **路径约定：内部全部使用相对 dataDir 的路径**（'project-scopes.json'、
 * 'session-scopes/x.json'、conversationFileOf 返回 'conversations/x.json'），
 * 由调用方在 readFile/writeFile/writeConversation 闭包里拼前缀。
 *
 * @module dsh-memory-evolve/advisor/scopes
 */

/** 单条约束文本上限（多行，可同时放多条指令）。 */
export const SCOPE_MAX_CHARS = 4_000

/**
 * @param {object} options
 * @param {(path: string, data: string) => void} options.writeFile - 原子写（相对 dataDir 路径；temp+rename 由调用方保证）
 * @param {(path: string) => string} options.readFile - 读取（相对 dataDir 路径；不存在返回 ''）
 * @param {(sessionId: string) => string} options.conversationFileOf - 评审会话文件路径（与 conversation 共用）
 * @param {(path: string, data: string) => void} options.writeConversation - 评审会话文件原子写
 */
export class ScopeStore {
  /** 全局约束文本（undefined=未加载；所有项目/会话共享）。 */
  globalText = undefined
  /** cwd → 项目约束文本。 */
  projectScopes = new Map()
  /** sessionId → 会话约束文本。 */
  sessionScopes = new Map()
  writeFile
  readFile
  conversationFileOf
  writeConversation

  constructor(options) {
    this.writeFile = options.writeFile
    this.readFile = options.readFile
    this.conversationFileOf = options.conversationFileOf
    this.writeConversation = options.writeConversation
  }

  /** 校验并规整约束文本（trim；空=清除该层）。 */
  static normalize(text) {
    const trimmed = String(text ?? '').trim()
    if (trimmed.length > SCOPE_MAX_CHARS) {
      throw new Error(`约束文本超长（上限 ${SCOPE_MAX_CHARS} 字符）`)
    }
    return trimmed
  }

  // ---- 全局约束（所有项目/会话共享，2026-08-12 用户拍板） ----

  /** 读取全局约束（惰性加载文件）。 */
  globalOf(logger = console) {
    if (this.globalText === undefined) {
      let text = ''
      try {
        const raw = this.readFile('global-scope.json')
        if (raw !== '') {
          const parsed = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object' && typeof parsed.text === 'string') {
            text = parsed.text
          }
        }
      } catch (error) {
        logger.warn?.('advisor: global scope load failed', { error })
      }
      this.globalText = text
    }
    return this.globalText
  }

  /** 保存全局约束（空文本=清除）。 */
  setGlobal(text, logger = console) {
    const normalized = ScopeStore.normalize(text)
    this.globalOf(logger) // 确保已加载
    this.globalText = normalized
    if (normalized === '') {
      this.writeFile('global-scope.json', '')
    } else {
      this.writeFile('global-scope.json', JSON.stringify({ text: normalized }))
    }
    return normalized
  }

  // ---- 项目约束（按 cwd 隔离，项目内会话共享） ----

  /** 读取项目约束（惰性加载整文件 map）。 */
  projectOf(cwd, logger = console) {
    if (!this.projectScopes.has(cwd)) {
      let text = ''
      try {
        const raw = this.readFile('project-scopes.json')
        if (raw !== '') {
          const parsed = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object') {
            text = typeof parsed[cwd] === 'string' ? parsed[cwd] : ''
          }
        }
      } catch (error) {
        logger.warn?.('advisor: project scope load failed', { cwd, error })
      }
      this.projectScopes.set(cwd, text)
    }
    return this.projectScopes.get(cwd) ?? ''
  }

  /** 保存项目约束（空文本=清除）。 */
  setProject(cwd, text, logger = console) {
    const normalized = ScopeStore.normalize(text)
    this.projectOf(cwd, logger) // 确保已加载
    this.projectScopes.set(cwd, normalized)
    // 合并写整文件（map 持久化）
    const merged = {}
    for (const [key, value] of this.projectScopes) {
      if (value !== '') merged[key] = value
    }
    this.writeFile('project-scopes.json', JSON.stringify(merged))
    return normalized
  }

  // ---- 会话约束（按会话隔离，跨新建评审会话保留） ----

  /** 读取会话约束（惰性加载文件）。 */
  sessionOf(sessionId, logger = console) {
    if (!this.sessionScopes.has(sessionId)) {
      let text = ''
      try {
        const raw = this.readFile(`session-scopes/${safeId(sessionId)}.json`)
        if (raw !== '') {
          const parsed = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object' && typeof parsed.text === 'string') {
            text = parsed.text
          }
        }
      } catch (error) {
        logger.warn?.('advisor: session scope load failed', { sessionId, error })
      }
      this.sessionScopes.set(sessionId, text)
    }
    return this.sessionScopes.get(sessionId) ?? ''
  }

  /** 保存会话约束（空文本=清除）。 */
  setSession(sessionId, text, logger = console) {
    const normalized = ScopeStore.normalize(text)
    this.sessionOf(sessionId, logger) // 确保已加载
    this.sessionScopes.set(sessionId, normalized)
    if (normalized === '') {
      this.writeFile(`session-scopes/${safeId(sessionId)}.json`, '')
    } else {
      this.writeFile(`session-scopes/${safeId(sessionId)}.json`, JSON.stringify({ text: normalized }))
    }
    return normalized
  }

  /** 会话销毁：清理内存缓存（磁盘文件保留供追溯，可重写覆盖）。 */
  disposeSession(sessionId) {
    this.sessionScopes.delete(sessionId)
  }

  // ---- 评审会话约束（绑定 conversation 文件，新建评审会话即清空） ----

  /**
   * 读取评审会话约束（与 conversation 共用同一持久化文件——reset 时
   * conversation.reset 会一并清空）。
   */
  conversationOf(sessionId, logger = console) {
    try {
      const raw = this.readFile(this.conversationFileOf(sessionId))
      if (raw === '') return ''
      const parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' && typeof parsed.scopeText === 'string'
        ? parsed.scopeText
        : ''
    } catch (error) {
      logger.warn?.('advisor: conversation scope load failed', { sessionId, error })
      return ''
    }
  }

  /** 保存评审会话约束（写入 conversation 文件——需保留 messages/epoch）。 */
  setConversation(sessionId, text, logger = console) {
    const normalized = ScopeStore.normalize(text)
    try {
      const raw = this.readFile(this.conversationFileOf(sessionId))
      const parsed = raw === '' ? null : JSON.parse(raw)
      const data = parsed !== null && typeof parsed === 'object'
        ? { ...parsed, scopeText: normalized }
        : { epoch: 1, messages: [], scopeText: normalized }
      this.writeConversation(this.conversationFileOf(sessionId), JSON.stringify(data))
    } catch (error) {
      logger.warn?.('advisor: conversation scope save failed', { sessionId, error })
    }
    return normalized
  }
}

/** 会话 id 安全化为文件名（防路径穿越）。 */
function safeId(sessionId) {
  return String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')
}
