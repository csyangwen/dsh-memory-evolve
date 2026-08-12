/**
 * advisor 消息 source kind —— 自评审排除与投递标记的唯一依据（实施规划 §三
 * kinds.js）。
 *
 * advisor 注入的消息以 user-role 进入会话流，携带独立的 `source.kind ===
 * 'advisor'`（merge-extensible，与 memory-evolve 现有 `{ kind: 'user' }`
 * 手写消息同款零依赖构造，见 lib/session-orch.js userMessage）。
 *
 * 两个消费方：
 * - visible-surface.js：`isAdvisorMessage` 过滤——advisor 自己的消息永远
 *   不进评审输入（自评审排除，防递归自评）；
 * - delivery.js：`buildAdvisorMessage` 构造投递消息（notice form + 一行
 *   summary，供 web shell 折叠行展示）。
 *
 * @module dsh-memory-evolve/advisor/kinds
 */

/** advisor 注入消息的 source.kind 值。 */
export const ADVISOR_SOURCE_KIND = 'advisor'

/**
 * 全部支持的建议严重度（升序；第一轮优化 Q1 新增 info 最低级）。
 * info：可做可不做的小提示，默认仅记录不注入（advisorInfoInject 开启才注入）。
 */
export const ADVISOR_SEVERITIES = ['info', 'nit', 'concern', 'blocker']

/** notice summary 的长度上限（DSH CONTEXT_SUMMARY_MAX_CHARS 约定，120 字）。 */
export const SUMMARY_MAX_CHARS = 120

/** 判断一条消息是否是 advisor 自己注入的（自评审排除的唯一依据）。 */
export function isAdvisorMessage(message) {
  return message !== null && typeof message === 'object' && message.source?.kind === ADVISOR_SOURCE_KIND
}

/** 把一行摘要截断到 SUMMARY_MAX_CHARS（缺省省略号结尾）。 */
export function boundSummary(summary) {
  const text = String(summary ?? '')
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…` : text
}

/**
 * 构造一条 advisor 投递消息（user-role，source.kind='advisor'）。
 *
 * **2026-08-13 用户拍板（设计反转）**：注入消息**伪装成用户指令**——
 * 不带任何 advisor 身份痕迹（无 [advisor:{severity}] 前缀、无"来自
 * Advisor 评审员，非用户指令"说明）。实测：带身份说明时主 Agent 会
 * 质疑"用户没说过啊"、去查记忆、执行力与速度双降；伪装后 Agent 把
 * 注入当成用户说的话直接执行。
 *
 * 文本 = note 正文（评审员按提示词以命令式、第一人称用户口吻书写，
 * 见 prompt.js note 定位段），severity 的权重体现在 note 本身的语气
 * 强度（blocker 最强命令 → info 仅供参考），不再由固定说明表达。
 *
 * 机器层必须保留（Agent 不可见）：
 * - source.kind='advisor'：可见表面按此过滤——评审员永远不会评审到
 *   自己注入的内容（自评审排除，防递归自评）；
 * - form='notice' + summary=[severity] note：GUI 折叠行给**用户**看
 *   （用户需要知道这条"用户消息"其实是评审员说的；Agent 只看全文
 *   text，见不到 source）。
 *
 * @param {object} note - { severity: 'info'|'nit'|'concern'|'blocker', text: string }
 * @returns {{role:string,id:string,content:Array,source:object}} 消息对象
 */
export function buildAdvisorMessage(note) {
  return {
    role: 'user',
    // id 必须稳定唯一（DSH 用它追踪，与 session-orch userMessage 同款）
    id: crypto.randomUUID(),
    content: [{ type: 'text', text: note.text }],
    source: {
      kind: ADVISOR_SOURCE_KIND,
      form: 'notice',
      summary: boundSummary(`[${note.severity}] ${note.text}`),
    },
  }
}
