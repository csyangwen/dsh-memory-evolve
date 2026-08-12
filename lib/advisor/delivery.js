/**
 * 投递层（实施规划 §三 delivery.js，双审 B5 + 复审修订；第一轮优化 Q1/Q4）。
 *
 * 用户拍板（2026-08-12）：**全量 steer**——advisorSteerSeverities 默认
 * 全量（nit/concern/blocker），severity 不在列表内的降级为 `agent.inject`
 * （非唤醒，供将来收紧配置使用；默认全量 → 实际全走 steer 实时送达）。
 *
 * 第一轮优化（2026-08-12 用户拍板）：
 * - **info 最低等级**（Q1）：默认（advisorInfoInject=false）**仅记录不
 *   注入**——`route` 返回 `'recorded'`，事件照发（面板可见），会话流
 *   不受打扰；advisorInfoInject=true 时 info 走 inject（永不 steer，不
 *   打断主 agent）；
 * - **指令即时问答**（Q4，2026-08-12 用户反馈修订）：问答回答**不注入
 *   主会话**（避免污染 agent 上下文）——只通过 finished 事件在面板展示，
 *   由 runtime 回放进评审员持续会话。
 *
 * `route` 返回值契约（runtime 据此写 outcome）：
 * - `'steer'`：真实 steer 投递（实时打断/唤醒）；
 * - `'inject'`：注入（非唤醒）；
 * - `'recorded'`：info 级且未开启注入——仅记录（事件照发）；
 * - `false`：缺 agent（调用方记 dropped，日志告警）。
 *
 * - **agent map**（KD-4）：agent/created、agent/disposed 维护（keyed by
 *   agent.id === session.id），`lookupAgent` 注册表兜底；缺 agent → 返回
 *   false（dropped，日志告警）——调用方（runtime）据此记 dropped 而非
 *   delivered（复审 B7）；
 * - **immuneTurns 冷却**（MAJOR-6 落实 fence 路径）：配置 >0 时，steer
 *   投递后接下来 N 个完成的 stepped 主 turn 走完才允许再次 steer，窗口内
 *   降级 inject；observer 的 onSteppedTurnEnd 钩子驱动递减；
 * - **消息形态**：`buildAdvisorMessage`（kinds.js）——user-role +
 *   source.kind='advisor' + notice form + summary。
 *
 * 纯类（cordis-free，agent 注入）。
 *
 * @module dsh-memory-evolve/advisor/delivery
 */

import { buildAdvisorMessage } from './kinds.js'

/**
 * @param {object} options
 * @param {(sessionId: string) => object | undefined} [options.lookupAgent] - 注册表兜底（ctx.agents.get）
 * @param {number} [options.immuneTurns] - steer 冷却（0=不限制）
 * @param {string[]} [options.steerSeverities] - 走 steer 的严重度集合（缺省全量）
 * @param {boolean} [options.infoInject] - info 级是否注入（Q1：默认 false=仅记录）
 * @param {object} [options.logger]
 */
export class AdvisorDelivery {
  constructor(options = {}) {
    this.lookupAgent = options.lookupAgent ?? (() => undefined)
    this.immuneTurns = options.immuneTurns ?? 0
    this.steerSeverities = options.steerSeverities ?? ['nit', 'concern', 'blocker']
    this.infoInject = options.infoInject === true
    this.logger = options.logger ?? console
    /** agent.id → agent（agent.id === session.id）。 */
    this.agents = new Map()
    /** 冷却闩锁：剩余必须完成的主 turn 数（>0 表示武装）。 */
    this.cooldown = new Map()
  }

  /** agent/created：登记（keyed by agent.id）。 */
  registerAgent(agent) {
    if (agent?.id !== undefined) this.agents.set(agent.id, agent)
  }

  /** agent/disposed / session/disposed：注销（冷却一并清除）。 */
  unregisterAgent(sessionId) {
    this.agents.delete(sessionId)
    this.cooldown.delete(sessionId)
  }

  /** 一个可评审主回合完成：递减冷却（observer onSteppedTurnEnd 驱动）。 */
  onSteppedTurnEnd(sessionId) {
    const remaining = this.cooldown.get(sessionId)
    if (remaining === undefined || remaining <= 0) return
    if (remaining <= 1) this.cooldown.delete(sessionId)
    else this.cooldown.set(sessionId, remaining - 1)
  }

  /** 表面重写：重置冷却（observer onRewrite 驱动）。 */
  reset(sessionId) {
    this.cooldown.delete(sessionId)
  }

  /** 更新配置（运行时热更：immuneTurns/steerSeverities/infoInject 原地生效）。 */
  configure(options = {}) {
    if (options.immuneTurns !== undefined) this.immuneTurns = options.immuneTurns
    if (options.steerSeverities !== undefined) this.steerSeverities = options.steerSeverities
    if (options.infoInject !== undefined) this.infoInject = options.infoInject === true
  }

  /**
   * 投递一条评审建议。
   * @param {string} sessionId - 会话 id
   * @param {object} note - { text, severity: 'info'|'nit'|'concern'|'blocker' }
   * @param {object} [options] - { steerSeverities? }（per-call 覆盖）
   * @returns {boolean|string} 'steer'|'inject'|'recorded'|false（见模块头契约）
   * @throws 投递抛错由调用方（runtime）捕获转 dropped 事件
   */
  route(sessionId, note, options = {}) {
    const agent = this.agents.get(sessionId) ?? this.lookupAgent(sessionId)
    if (agent === undefined || typeof agent.steer !== 'function') {
      this.logger.warn('advisor: note dropped — no agent for session', { sessionId, severity: note.severity })
      return false
    }
    // Q1：info 级默认仅记录不注入（事件照发，面板可见；会话流不受打扰）
    if (note.severity === 'info' && !this.infoInject) return 'recorded'
    const message = buildAdvisorMessage(note)
    // Q1：info 注入（infoInject=true）永远走 inject——最低等级不值得打断
    if (note.severity === 'info') {
      // 复审中6：info 缺 inject 能力时返回 false（dropped）——**绝不回退
      // steer**（违反"info 永不打断"），宁可丢弃
      if (typeof agent.inject !== 'function') {
        this.logger.warn('advisor: info note dropped — agent has no inject()', { sessionId })
        return false
      }
      agent.inject(message)
      return 'inject'
    }
    const severities = options.steerSeverities ?? this.steerSeverities
    const steering = severities.includes(note.severity)
    const cooldown = this.cooldown.get(sessionId) ?? 0
    if (steering && cooldown <= 0) {
      // 真实 steer 投递武装冷却（失败也算尝试，防噪声循环）
      if (this.immuneTurns > 0) this.cooldown.set(sessionId, this.immuneTurns)
      agent.steer(message)
      return 'steer'
    }
    // 降级 inject（severity 不在列表 或 冷却窗口内）
    if (typeof agent.inject === 'function') {
      agent.inject(message)
      return 'inject'
    }
    // 复审中6：无 inject 能力时如实上报实际通道（steer 而非 inject）
    agent.steer(message)
    return 'steer'
  }

}
