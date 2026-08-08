/**
 * 房间动态队列（dynamics）— 成员状态变化的**快照直达**通道。
 *
 * 背景（用户拍板 2026-08-09）：成员 running/idle 状态变化**不再发收件箱
 * 系统通知**（那会制造未读、逼模型 read，高频低信息量不划算）——改为
 * 写进本队列，由快照「房间动态」段直接注入模型上下文，**渲染即消费**
 * （buildBroadcastBlock 渲染时同步推进水位，模型无需 read，等价于程序
 * 替它已读）。
 *
 * 存储：<broadcastDataDir>/dynamics.json
 *   {
 *     seq: 全局递增事件序号（水位刻度，跨会话共享）,
 *     events: [ { seq, roomId, member, kind, at } ]（最多保留 RECENT 条）,
 *     cursors: { sessionId: 该会话已送达水位 }
 *   }
 * kind: 'running'（开始干活）| 'idle'（干完/闲了）。
 *
 * 事件只增不删（prune 截断旧事件）；水位推进 = 消费，**不依赖模型真的
 * 生成**——渲染时刻就是送达时刻（快照 diff 变了必注入）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 队列保留的事件条数（超出丢弃最旧——实时协作不看历史）。 */
const RECENT = 50

export class DynamicsStore {
  /**
   * @param {string} dir - 数据目录（与 broadcast.json 同目录）。
   */
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'dynamics.json')
    this.seq = 0
    /** @type {Array<{seq:number, roomId:string, member:string, kind:string, at:number}>} */
    this.events = []
    /** @type {Record<string, number>} 会话 → 已送达水位 */
    this.cursors = {}
    this.#load()
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        if (Number.isInteger(parsed.seq)) this.seq = parsed.seq
        if (Array.isArray(parsed.events)) this.events = parsed.events
        if (parsed.cursors && typeof parsed.cursors === 'object') this.cursors = parsed.cursors
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[dsh-memory-evolve] dynamics 加载失败（忽略）: ${error.message}`)
      }
    }
  }

  /** 原子写盘（tmp + rename；失败只告警不影响内存状态）。 */
  #save() {
    try {
      mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.file}.tmp.${process.pid}`
      writeFileSync(tmp, JSON.stringify({ seq: this.seq, events: this.events, cursors: this.cursors }) + '\n')
      renameSync(tmp, this.file)
    } catch (error) {
      console.warn(`[dsh-memory-evolve] dynamics 保存失败（忽略）: ${error.message}`)
    }
  }

  /**
   * 追加一条状态变化事件（running/idle 切换时由装配层调用）。
   * @param {string} roomId - 房间 id（事件所属房间）
   * @param {string} member - 状态变化的成员会话 id
   * @param {'running'|'idle'} kind - 变化后状态
   */
  append(roomId, member, kind) {
    this.seq += 1
    this.events.push({ seq: this.seq, roomId, member, kind, at: Date.now() })
    // 实时协作不看历史：只保留最近 RECENT 条
    if (this.events.length > RECENT) this.events.splice(0, this.events.length - RECENT)
    this.#save()
  }

  /**
   * 某会话**待送达**的事件（水位之后、且仍属于某房间的事件）：
   * 按房间过滤留给调用方（快照渲染处有 rooms 表，这里只按水位取）。
   * @param {string} sessionId
   * @returns {Array<{seq:number, roomId:string, member:string, kind:string, at:number}>}
   */
  pendingFor(sessionId) {
    const cursor = this.cursors[sessionId] ?? 0
    return this.events.filter((e) => e.seq > cursor)
  }

  /**
   * 推进水位到最新事件（渲染即消费——快照渲染时刻=送达时刻，
   * 等价程序替模型 read，模型无需手动处理）。
   * @param {string} sessionId
   */
  markSeen(sessionId) {
    const latest = this.events.length > 0 ? this.events[this.events.length - 1].seq : this.seq
    this.cursors[sessionId] = latest
    this.#save()
  }
}
