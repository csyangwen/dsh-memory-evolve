/**
 * 可见文本表面渲染（实施规划 §三 visible-surface.js，纯函数）。
 *
 * 「前台可见文本表面」= 用户在 GUI 里眼睛看到的对话内容（需求 R2：
 * "以用眼睛看到的为准"）：
 *
 * - **user 可见**：`role==='user' && source.kind==='user'` 的消息 text 块
 *   （普通用户输入；工具结果/workspace 注入/advisor 注入等非 human
 *   user-role 消息一律排除）；
 * - **assistant 可见**：`role==='assistant'` 消息的 text 块；image 块以
 *   `[image omitted]` 占位（用户看得到图，评审员只见标记，与前端
 *   AssistantMarkdown 的 image 渲染对齐）；
 * - **排除**：reasoning / tool-call / tool-result 块（前端折叠不可见）、
 *   所有非 human 的 user-role source、advisor 自消息（自评审排除）。
 *
 * 基于 `deriveEventMessage` 投影出的 Message 处理（勿直接遍历原始事件
 * 日志——compact/表面重写后原始日志可能含已删除内容）。有界窗口
 * （maxMessages，默认 60，0=无上限）超限保留最近 N 条并前置截断标记。
 *
 * @module dsh-memory-evolve/advisor/visible-surface
 */

import { isAdvisorMessage } from './kinds.js'

/** 默认有界窗口（实施规划 §四 advisorMaxMessages 默认 60）。 */
export const DEFAULT_MAX_MESSAGES = 60

/** 截断标记（窗口超限时前置，与 dsh-advisor 同款文案）。 */
export const TRUNCATION_MARKER = '… <earlier messages omitted>'

/** 图片占位符（用户可见图片，评审员只见标记）。 */
export const IMAGE_PLACEHOLDER = '[image omitted]'

/** 会话更新标题（评审输入 markdown 首行，评审提示词以此识别）。 */
export const SESSION_UPDATE_HEADING = '### Session update'

/**
 * 角色包裹标记（2026-08-13 用户反馈，两轮打磨）：
 * 第一轮：旧标记 user / agent（粗体）区分度弱，评审员把用户和 Agent
 * 搞混 → 改为 [用户 → Agent] / [Agent → 用户] / [用户 → 评审员｜指令] /
 * [用户 → 评审员｜提问] 单侧前缀；
 * 第二轮（本轮）：单侧前缀仍有歧义——消息内容里万一出现同样的标记
 * 文本会被误判。改为**成对开闭标签**包裹消息内容（XML 风格），标签
 * 是角色标记、标签之间的文字才是消息内容；即使内容里出现类似标签的
 * 文本也按内容理解（提示词中有对应说明）。
 * - userToAgent / agentToUser：评审员观察到的 Agent 会话可见表面；
 * - userToAdvisorInstruction / userToAdvisorQuestion：用户**直接对评审员**
 *   说的话（面板指令框/提问），由 runtime 拼进 update 段或 ### User
 *   question 段。
 */
export const ROLE_MARKERS = {
  userToAgent: { open: '<用户对Agent说>', close: '</用户对Agent说>' },
  agentToUser: { open: '<Agent对用户说>', close: '</Agent对用户说>' },
  userToAdvisorInstruction: { open: '<用户对评审员指令>', close: '</用户对评审员指令>' },
  userToAdvisorQuestion: { open: '<用户对评审员提问>', close: '</用户对评审员提问>' },
}

/** 用角色标签对包裹一条消息内容（空内容用 <empty> 占位，保持结构完整）。 */
export function wrapRoleEntry(marker, text) {
  const body = text.length > 0 ? text : '<empty>'
  return `${marker.open}\n${body}\n${marker.close}`
}

/**
 * 一条消息是否属于「可见 user 输入」：role=user 且 source.kind=user
 * （工具结果 source.kind='tool'、注入 source.kind='plugin'/'advisor' 等
 * 非 human 输入一律不算用户可见内容）。
 */
export function isVisibleUserMessage(message) {
  return message?.role === 'user' && message.source?.kind === 'user'
}

/** 一条消息是否属于「可见 assistant 回复」：role=assistant。 */
export function isVisibleAssistantMessage(message) {
  return message?.role === 'assistant'
}

/** 一条消息是否整体进入评审表面（user 可见输入 或 assistant 可见回复，且非 advisor 自消息）。 */
export function isVisibleMessage(message) {
  if (message === null || typeof message !== 'object') return false
  if (isAdvisorMessage(message)) return false // 自评审排除
  return isVisibleUserMessage(message) || isVisibleAssistantMessage(message)
}

/**
 * 提取一条消息的可见文本。
 *
 * 2026-08-13 用户反馈：Agent 消息里的 **tool-call 按出现顺序逐行显示**
 * ——每个 tool call 一行 `[tool: 名称]`（有几个显示几行），**插在消息
 * 文本流的对应位置**（不是统一追加到末尾），评审员能看到"Agent 在这
 * 一步用过什么工具"；**不显示被折叠的参数内容**（arguments 不进表面，
 * 与前端折叠行为一致）。工具结果（tool-result）仍然不可见。
 *
 * @param {object} message - deriveEventMessage 投影出的 Message
 * @returns {{ text: string, imageCount: number } | null}
 *   null=无可见内容（该消息不进评审表面）；text=可见文本拼接
 */
export function messageVisibleText(message) {
  if (!isVisibleMessage(message)) return null
  const parts = []
  let imageCount = 0
  for (const block of message.content ?? []) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push(block.text)
        break
      case 'image':
        // 用户看得到图；评审员只见占位标记（不传图片本体）
        imageCount += 1
        break
      case 'tool-call':
        // 2026-08-13 用户反馈：按块顺序插入一行 [tool: 名称]（有几个
        // 显示几行），不显示折叠的参数内容
        if (typeof block.name === 'string' && block.name !== '') parts.push(`[tool: ${block.name}]`)
        break
      default:
        // reasoning / tool-result / 未知扩展块：前端折叠不可见
        break
    }
  }
  const text = parts.join('\n')
  if (text === '' && imageCount === 0) return null
  const imageSuffix = imageCount > 0 ? (text !== '' ? `\n${IMAGE_PLACEHOLDER}` : IMAGE_PLACEHOLDER) : ''
  return { text: `${text}${imageSuffix}`, imageCount }
}

/**
 * 渲染可见消息列表为评审输入 markdown（角色标注 + 有界窗口截断）。
 * 内部共享实现：标题由调用方指定（更新段/上下文段共用同一渲染逻辑）。
 *
 * @param {Array<object>} messages - 按时间序的 Message 列表（已过滤 advisor 自消息亦可，函数内再滤一次）
 * @param {{ maxMessages?: number }} [options] - maxMessages=有界窗口（0=无上限），默认 DEFAULT_MAX_MESSAGES
 * @param {string} heading - markdown 首行标题（SESSION_UPDATE_HEADING / SESSION_CONTEXT_HEADING）
 * @returns {{ markdown: string, messageCount: number, charCount: number } | null}
 *   null=无任何可见内容（不生成评审）
 */
function renderSurface(messages, options, heading) {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES
  const visible = []
  for (const message of messages) {
    const rendered = messageVisibleText(message)
    if (rendered === null) continue
    visible.push({ message, rendered })
  }
  if (visible.length === 0) return null

  let omitted = false
  let window = visible
  if (maxMessages > 0 && visible.length > maxMessages) {
    window = visible.slice(-maxMessages) // 保留最近 N 条
    omitted = true
  }

  const lines = [heading]
  if (omitted) lines.push(TRUNCATION_MARKER)
  let charCount = 0
  for (const { message, rendered } of window) {
    // 角色成对标签包裹（2026-08-13 用户反馈：谁对谁说话一目了然 +
    // 内容与标记无歧义）
    const marker = isVisibleUserMessage(message) ? ROLE_MARKERS.userToAgent : ROLE_MARKERS.agentToUser
    const entry = wrapRoleEntry(marker, rendered.text.trim())
    lines.push(entry)
    charCount += entry.length
  }
  return {
    markdown: lines.join('\n\n'),
    messageCount: window.length,
    charCount,
  }
}

/**
 * 渲染可见消息列表为「会话更新」评审输入（增量段，`### Session update`）。
 *
 * @param {Array<object>} messages - 按时间序的 Message 列表
 * @param {{ maxMessages?: number }} [options] - maxMessages=有界窗口（0=无上限）
 * @returns {{ markdown: string, messageCount: number, charCount: number } | null}
 */
export function renderVisibleSurface(messages, options = {}) {
  return renderSurface(messages, options, SESSION_UPDATE_HEADING)
}

/**
 * 渲染可见消息列表为**逐条条目**（Q3 重构：评审员持续会话用）。
 *
 * 与 renderVisibleSurface（合成单段 markdown）不同：每条可见消息独立成
 * 条目 { text }（带 **user** / **agent** 标注）——评审员上下文按消息
 * 粒度追加，保持"普通 LLM 对话"的消息结构。
 *
 * @param {Array<object>} messages - 按时间序的 Message 列表
 * @returns {Array<{text:string}>} 逐条可见条目（空数组=无可见内容）
 */
export function renderVisibleEntries(messages) {
  const out = []
  for (const message of messages) {
    const rendered = messageVisibleText(message)
    if (rendered === null) continue
    // 角色成对标签包裹（2026-08-13 用户反馈：谁对谁说话一目了然 +
    // 内容与标记无歧义）
    const marker = isVisibleUserMessage(message) ? ROLE_MARKERS.userToAgent : ROLE_MARKERS.agentToUser
    out.push({ text: wrapRoleEntry(marker, rendered.text.trim()) })
  }
  return out
}
