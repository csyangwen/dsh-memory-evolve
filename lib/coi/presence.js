/**
 * 会话在线状态追踪（presence）— 房间协作的"谁在线"能力。
 *
 * DSH 会话没有原生在线/离线概念，但 harness 会发 `agent/status` 事件
 * （status: 'running' ⇄ 'idle'）：插件监听该事件维护一张
 * { sessionId → { status, lastActiveAt } } 表，供 de_broadcast
 * presence action 查询——
 *   - running = 正在生成（在线/忙）：其他会话可以等它、向它发消息它
 *     回合内就能看到
 *   - idle = 已结束回合（等用户驱动，相当于离线）：其他会话不应傻等，
 *     协作决策时把它视为"不在线"
 *   - unknown = 从未在本进程记录过（本进程重启后尚未有该会话的事件，
 *     或该会话根本不在本 DSH 进程里）：视为不在线
 *
 * 持久化：传入 storageDir 时把 lastActiveAt 落盘到 presence.json
 * （事件到达后 2s 防抖写盘、dispose 时强制 flush）。这样 dsh 重启后
 * 成员仍能显示上次活动时间与状态，而不是全部退化成 unknown——
 * 真正的 unknown 只表示"这个会话从未在当前进程活跃过"。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 事件后防抖写盘间隔（ms）：status 切换频繁，没必要每次事件都写盘。 */
const SAVE_DEBOUNCE_MS = 2000

export class PresenceTracker {
  /**
   * @param {object} ctx - cordis ctx（需可监听 harness 事件；
   *   review.js 已用 ctx.on('agent/settled') 同款模式）。
   * @param {string} [storageDir] - 可选：持久化目录（传则落盘
   *   presence.json；不传 = 纯内存，测试/临时场景用）。
   */
  constructor(ctx, storageDir, onChange) {
    /** @type {Map<string, {status: string, lastActiveAt: number}>} */
    this.agents = new Map()
    /** 持久化文件（null = 不落盘）。 */
    this.storageFile = storageDir ? join(storageDir, 'presence.json') : null
    /** 防抖写盘定时器（timer 回调必须 try/catch，异常会崩 DSH 进程）。 */
    this.saveTimer = null
    /**
     * 状态变化回调（可选）：`(sessionId, prevStatus, nextStatus)`——
     * 仅在 running⇄idle **实际切换**时触发（首次记录不算变化，同状态
     * 重复事件也不算）。装配层（installBroadcast）用它把"谁开始干活/
     * 谁干完了"作为系统通知发给同房间其他成员——presence 本身保持
     * 纯净只管状态表，通知是调用方的关注点。
     */
    this.onChange = typeof onChange === 'function' ? onChange : null
    // 启动时加载历史记录（文件不存在/损坏 → 空表，不抛）
    this._load()
    // agent/status：status 变化时更新（running/idle 都记最后活跃时间）。
    // ⚠️ listener 收到的是**单对象 payload { agent, status }**（DSH 事件
    // 声明：'agent/status'(this, payload)），不是两个位置参数——曾误用
    // (agent, status) 导致 agent 取到 payload 对象、session 缺失全 unknown。
    // disposer 交给 ctx.effect 管理（P2-7 教训：显式挂载防重复注册）
    this._disposeListener = ctx.effect
      ? ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => {
          const sessionId = agent?.session?.id
          if (!sessionId) return
          // 状态变化检测：仅实际切换（running⇄idle）触发 onChange——
          // 首次记录（prev 不存在）不算变化（进程重启后旧状态不该当
          // 成"变化"广播）；回调异常必须吞掉，不影响状态表维护
          const prev = this.agents.get(sessionId)
          if (prev && prev.status !== status && this.onChange) {
            try { this.onChange(sessionId, prev.status, status) } catch { /* 通知失败不影响状态 */ }
          }
          this.agents.set(sessionId, { status, lastActiveAt: Date.now() })
          this._scheduleSave()
        }))
      : () => {}
    /** 卸载：释放监听 + 强制落盘。 */
    this.dispose = () => {
      try { this._disposeListener?.() } catch { /* 忽略 */ }
      this.flush()
    }
  }

  /** 启动时从 presence.json 恢复（损坏/缺失静默）。 */
  _load() {
    if (!this.storageFile) return
    try {
      const parsed = JSON.parse(readFileSync(this.storageFile, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        for (const [sid, rec] of Object.entries(parsed)) {
          if (rec && typeof rec.status === 'string' && typeof rec.lastActiveAt === 'number') {
            this.agents.set(sid, { status: rec.status, lastActiveAt: rec.lastActiveAt })
          }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[dsh-memory-evolve] presence 加载失败（忽略）: ${error.message}`)
      }
    }
  }

  /** 防抖写盘：2s 内多次事件只写一次（unref 不阻止进程退出）。 */
  _scheduleSave() {
    if (!this.storageFile) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this._save()
    }, SAVE_DEBOUNCE_MS)
    this.saveTimer.unref?.()
  }

  /** 原子写盘（tmp + rename；失败只告警不影响内存状态）。 */
  _save() {
    if (!this.storageFile) return
    try {
      mkdirSync(dirname(this.storageFile), { recursive: true })
      const tmp = `${this.storageFile}.tmp.${process.pid}`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.agents)) + '\n')
      renameSync(tmp, this.storageFile)
    } catch (error) {
      console.warn(`[dsh-memory-evolve] presence 保存失败（忽略）: ${error.message}`)
    }
  }

  /** 立即落盘（dispose / 进程退出前调用）。 */
  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this._save()
  }

  /** 单个会话的在线状态。 */
  get(sessionId) {
    const rec = this.agents.get(sessionId)
    if (!rec) return { sessionId, status: 'unknown', online: false, lastActiveAt: null }
    return {
      sessionId,
      status: rec.status,
      // running=在线（正在生成，回合内可见新消息）；idle=已结束回合
      // （等用户驱动，视为不在线——不应傻等）
      online: rec.status === 'running',
      lastActiveAt: rec.lastActiveAt,
    }
  }

  /** 房间所有成员的在线状态（未知成员也列出，方便识别死会话）。 */
  roomStatus(room) {
    const members = Array.isArray(room?.members) ? room.members : []
    return members.map((sid) => this.get(sid))
  }
}
