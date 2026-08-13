/**
 * 工作区冲突协调（ws-coord）——会话广播模块的子功能组。
 *
 * 背景（2026-08-09 用户拍板）：同一工作区多会话并行时可能对同一文件写入、
 * git 状态、服务产生冲突。用户调研后拍板：
 *  1. 语义上属于"通知的一部分"，**归入会话广播模块**（不做独立模块）；
 *  2. 模块内保持独立装配子单元（installWsCoord + 独立子开关 + 独立子存储
 *     <broadcastDataDir>/ws-coord/），防重蹈 08-08「广播挂 COI 拆不开」；
 *  3. 默认关；一期不做 git 互斥与客户端面板（git 让 AI 自己注意）；
 *  4. **软模式**：先信任 AI——检测到冲突不拦截，而是警告（先登记，信任
 *     AI 自行处理）；enforceWrite 硬拦截保留为开关位备用。
 *
 * 三层机制：
 *  - ① 资源锁：de_ws_declare 声明（软，AI 主动）+ fs/observed 自动登记
 *    （硬，不靠自觉：每次 write/edit 成功写入即自动记入占用集）+ TTL +
 *    显式 release 释放（**回合结束不释放 observed 锁**——保留到 TTL，
 *    否则先后写入检测不到，2026-08-09 用户实测教训）；
 *    TTL 设计（2026-08-09 用户拍板）：默认 1 分钟、上限 5 分钟——锁是
 *    "正在干活"的临时信号：**写操作自动续期**（每次 write/edit 刷新 TTL），
 *    长任务只要在写就不断续；不写了 1~5 分钟内自然过期释放，不卡其他
 *    会话（曾默认 60 分钟，硬拦截模式下会卡别人 1 小时）；
 *  - ② 写前感知：tools/pre-execute 检测冲突（write/edit 工具）→ 软模式
 *    下放行但 tools/post-execute 向写入方注入警告上下文（additionalContexts，
 *    模型下一轮可见）；enforceWrite 打开时升级为 deny 硬拦截；
 *  - ③ 冲突定向通知：冲突发生时给占用方发广播（notifyConflict 子开关）；
 *  - ④ 活动感知：de_ws_status 无参 = 工作区活动概览（谁在跑、在干什么）；
 *    快照段【工作区活动】在活跃会话 ≥2 时注入一行（带时间，snapshot 子开关）。
 *
 * 关键技术事实（2026-08-09 源码验证）：
 *  - fs/write-intent 被核心 fs-policy 单槽独占，插件不可用 → 拦截点在
 *    tools/pre-execute（官方文档明确留给插件的扩展点，deny 语义完整）；
 *  - fs/observed 是 emit 事件（fire-and-forget），actor=ToolExecution，
 *    其 agent.session.id 可拿会话、target.targetKey 是 local backend 的
 *    realpath（天然归一化）→ 自动登记通道；
 *  - tools/post-execute 的 additionalContexts 可向模型注入上下文（官方
 *    测试同款写法：await next() 后合并返回）。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as pathResolve } from 'node:path'

/** 写盘防抖间隔（ms）：fs/observed 高频，没必要每次事件都写盘。 */
const SAVE_DEBOUNCE_MS = 1500
/** declared（声明）锁默认 TTL（秒）：AI 高估任务时长，默认 30 秒够用（2026-08-09 用户拍板）。 */
const DEFAULT_TTL_SEC = 30
/** declared（声明）锁 TTL 上限（秒=5 分钟）：硬拦截模式下不能长时间卡其他会话。 */
const MAX_TTL_SEC = 300
/** observed（自动登记）锁默认 TTL（秒）：写过的文件短时间内别人最好别动；写操作续期。 */
const OBSERVED_TTL_SEC = 30
/** 活动概览"最近活跃"窗口（ms）：10 分钟内活动过的会话算活跃。 */
const ACTIVE_WINDOW_MS = 10 * 60 * 1000
/** 快照段注入阈值：活跃会话 >= 2 才注入（克制原则，单会话零开销）。 */
const SNAPSHOT_MIN_ACTIVE = 2

/** 统一日期时间格式：YYYY-MM-DD HH:mm:ss（精确到秒，活动快照时间锚点）。 */
const pad2 = (n) => String(n).padStart(2, '0')
export const fmtDateTime = (ts) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 错误文本归一化（工具输出/通知文案共用）。 */
function errText(err) {
  const text = err instanceof Error ? err.message : String(err)
  return text !== undefined && text.trim() !== '' ? text : '未知错误'
}

/**
 * 路径归一化：相对路径按 cwd 解析为绝对路径后 normalize。
 * 与 fs/observed 的 targetKey（realpath）匹配使用；不解析符号链接
 * （边界情况可接受，绝大多数写入路径是普通绝对/相对路径）。
 * @param {string} p - 模型提供的路径（可能相对）。
 * @param {string} [cwd] - 会话工作目录（相对路径基准）。
 * @returns {string} 归一化绝对路径。
 */
export function normPath(p, cwd) {
  try {
    return pathResolve(cwd || process.cwd(), String(p))
  } catch {
    return String(p)
  }
}

/** 构造一条插件来源的用户消息（tools/post-execute additionalContexts 用）。 */
function userMessage(text) {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'plugin', plugin: 'dsh-memory-evolve' },
  }
}

/**
 * 锁存储：<dir>/locks.json（原子写）。
 * 每条锁：{ id, sessionId, kind:'file'|'service', target, note, startedAt,
 * expiresAt, source:'declared'|'observed', cwd }。
 * 冲突判定：kind=file 且归一化 target 相同且 sessionId 不同且未过期。
 */
export class WsCoordStore {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'locks.json')
    /** @type {Array<object>} 锁数组（内存权威，防抖落盘）。 */
    this.locks = []
    /** 防抖写盘定时器（timer 回调必须 try/catch，异常会崩 DSH 进程）。 */
    this.saveTimer = null
    this.#load()
  }

  /** 启动加载（缺失/损坏静默空表）。 */
  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (parsed && Array.isArray(parsed.locks)) this.locks = parsed.locks
    } catch { /* 文件缺失/损坏：空表 */ }
    this.#pruneExpired()
  }

  /** 防抖原子写盘（临时文件 + rename，防并发读半截）。 */
  #save() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        mkdirSync(this.dir, { recursive: true })
        const tmp = `${this.file}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify({ version: 1, locks: this.locks }, null, 2), 'utf8')
        renameSync(tmp, this.file)
      } catch { /* 写盘失败不影响内存使用（下次再试） */ }
    }, SAVE_DEBOUNCE_MS)
  }

  /** 惰性清理过期锁（查询/写操作前调用）。 */
  #pruneExpired() {
    const now = Date.now()
    const before = this.locks.length
    this.locks = this.locks.filter((l) => l.expiresAt > now)
    if (this.locks.length !== before) this.#save()
  }

  /** 公开清理过期锁（定期清理定时器用；不释放任何活跃锁）。 */
  prune() {
    this.#pruneExpired()
  }

  /**
   * 冲突检测：写前判断目标文件是否被**其他会话**占用。
   * @param {string} sessionId - 请求方会话 id。
   * @param {string} path - 目标文件路径（将按 cwd 归一化）。
   * @param {string} [cwd] - 请求方工作目录。
   * @returns {object | null} 占用锁（自己占用的/无锁/已过期 = null）。
   */
  conflictFor(sessionId, path, cwd) {
    this.#pruneExpired()
    const target = normPath(path, cwd)
    return this.locks.find((l) => l.kind === 'file' && l.sessionId !== sessionId && normPath(l.target, l.cwd) === target) ?? null
  }

  /**
   * 声明占用（de_ws_declare）：登记要修改的文件/服务。
   * 同一会话对同一 target 重复声明 = 刷新 note 与 TTL。
   * @param {object} req - { sessionId, cwd, targets?, services?, ttlSeconds? }
   * @returns {{ declared: object[], conflicts: object[] }}
   *   declared=本次登记的锁；conflicts=与其他会话现有锁的重叠清单。
   */
  declare({ sessionId, cwd, targets, services, ttlSeconds }) {
    this.#pruneExpired()
    const now = Date.now()
    // TTL 秒：默认 30 秒（AI 高估时长），AI 可传但上限 5 分钟（300 秒），
    // 下限 5 秒（太短无意义）；写操作 observe 自动续期兜底长任务。
    const ttl = Math.min(Math.max(Number(ttlSeconds) || DEFAULT_TTL_SEC, 5), MAX_TTL_SEC) * 1000
    const declared = []
    const conflicts = []
    const entries = []
    if (Array.isArray(targets)) {
      for (const t of targets) {
        if (!t || typeof t.path !== 'string' || t.path.trim() === '') continue
        entries.push({ kind: 'file', target: normPath(t.path, cwd), note: t.note ?? '' })
      }
    }
    if (Array.isArray(services)) {
      for (const s of services) {
        if (!s || typeof s.name !== 'string' || s.name.trim() === '') continue
        const action = s.action ? `（${s.action}）` : ''
        entries.push({ kind: 'service', target: s.name, note: s.note ? `${action}${s.note}` : action })
      }
    }
    for (const e of entries) {
      // 与其他会话现有锁重叠 → 冲突清单（提示但照常声明，交给 AI 判断）
      const hit = this.locks.find((l) => l.sessionId !== sessionId && l.kind === e.kind && normPath(l.target, l.cwd) === e.target)
      if (hit) conflicts.push({ ...hit })
      // 同会话同 target：刷新（更新 note/TTL/转 declared）
      const own = this.locks.find((l) => l.sessionId === sessionId && l.kind === e.kind && normPath(l.target, l.cwd) === e.target)
      if (own) {
        own.note = e.note || own.note
        own.expiresAt = now + ttl
        own.source = 'declared'
        own.cwd = cwd ?? own.cwd
        declared.push({ ...own })
      } else {
        const lock = {
          id: `lk_${randomUUID().slice(0, 8)}`,
          sessionId,
          kind: e.kind,
          target: e.target,
          note: e.note,
          startedAt: now,
          expiresAt: now + ttl,
          source: 'declared',
          cwd: cwd ?? '',
        }
        this.locks.push(lock)
        declared.push({ ...lock })
      }
    }
    this.#save()
    return { declared, conflicts }
  }

  /**
   * 自动登记（fs/observed 监听）：会话实际写入的文件自动进占用集——
   * 不靠 AI 自觉登记（解决"声明 ≠ 实际"）。已存在同会话同文件锁 →
   * 刷新 TTL（续期）；否则新建 observed 锁（短 TTL）。
   * @param {string} sessionId - 写入方会话 id。
   * @param {string} [cwd] - 会话工作目录。
   * @param {string} targetKey - fs/observed 的 targetKey（local backend 的 realpath）。
   */
  observe(sessionId, cwd, targetKey) {
    if (!sessionId || typeof targetKey !== 'string' || targetKey === '') return
    this.#pruneExpired()
    const now = Date.now()
    const target = normPath(targetKey, cwd)
    const own = this.locks.find((l) => l.sessionId === sessionId && l.kind === 'file' && normPath(l.target, l.cwd) === target)
    if (own) {
      own.expiresAt = now + OBSERVED_TTL_SEC * 1000
      if (own.source === 'observed') own.cwd = cwd ?? own.cwd
    } else {
      this.locks.push({
        id: `lk_${randomUUID().slice(0, 8)}`,
        sessionId,
        kind: 'file',
        target,
        note: '',
        startedAt: now,
        expiresAt: now + OBSERVED_TTL_SEC * 1000,
        source: 'observed',
        cwd: cwd ?? '',
      })
    }
    this.#save()
  }

  /**
   * 释放占用（de_ws_release）：按路径释放或全释放本会话。
   * @param {object} req - { sessionId, paths?, all? }
   * @returns {{ released: object[], remaining: number }}
   */
  release({ sessionId, paths, all }) {
    this.#pruneExpired()
    const released = []
    const keep = []
    for (const l of this.locks) {
      const mine = l.sessionId === sessionId
      const match = all === true || (Array.isArray(paths) && paths.some((p) => typeof p === 'string' && normPath(p, l.cwd) === normPath(l.target, l.cwd)))
      if (mine && match) released.push({ ...l })
      else keep.push(l)
    }
    this.locks = keep
    if (released.length > 0) this.#save()
    return { released, remaining: this.locks.length }
  }

  /**
   * 清空某会话的 observed 锁（显式场景用：模块卸载清理等）。
   * ⚠️ 默认释放策略=保留到 TTL（30 秒）——曾由 agent/turn-stopping
   * 回合结束调用，2026-08-09 实测发现回合结束即释放会让"先后写入"
   * （A 改完 → B 再改）检测不到，已移除该监听。注释与实现一致
   * （稳定版复审 P1-10：旧注释误写「30 分钟」，实际 OBSERVED_TTL_SEC=30 秒）。
   * @param {string} sessionId
   */
  clearObserved(sessionId) {
    const before = this.locks.length
    this.locks = this.locks.filter((l) => !(l.sessionId === sessionId && l.source === 'observed'))
    if (this.locks.length !== before) this.#save()
  }

  /**
   * 查询占用（de_ws_status）：按 cwd 工作区过滤（跨工作区互不干扰）。
   * @param {object} req - { cwd, paths?, sessionId? }
   * @returns {object[]} 可见锁列表（不含过期）。
   */
  list({ cwd, paths, sessionId }) {
    this.#pruneExpired()
    return this.locks.filter((l) => {
      if (cwd && normPath(l.cwd || '', cwd) !== normPath(cwd)) return false
      if (sessionId && l.sessionId !== sessionId) return false
      if (Array.isArray(paths) && paths.length > 0
        && !paths.some((p) => typeof p === 'string' && normPath(p, cwd) === normPath(l.target, l.cwd))) return false
      return true
    }).map((l) => ({ ...l }))
  }

  /**
   * 工作区活动概览（de_ws_status 无参 / 快照段用）：当前工作区"正在干活
   * 的会话"——running 中的会话 + 有活跃锁的会话（合并去重）。idle 且
   * 无锁的会话不展示（避免快照全是空壳）。
   * @param {string} [cwd] - 工作区路径。
   * @param {Map<string, {cwd?:string, status?:string, lastActiveAt:number}>} sessionMeta
   *   - 会话元信息（agent/status 维护：cwd/status/lastActiveAt）。
   * @param {number} [now]
   * @param {ReadonlySet<string> | null} [archivedIds] - 已归档会话 id 集合
   *   （ctx.workspaceRegistry.archivedSessionIds 的 Set 形态）。归档=用户已隐藏的
   *   会话（2026-08-09 用户实测反馈：归档的父级会话仍出现在活动段），
   *   活动概览必须跳过——有锁或 running 都不展示（已归档=不想看见）。
   * @returns {Array<{sessionId:string, status:string, note:string, lockCount:number, since:number}>}
   */
  activeFor(cwd, sessionMeta, now = Date.now(), archivedIds = null) {
    this.#pruneExpired()
    const base = normPath(cwd || '')
    const bySession = new Map()
    for (const l of this.locks) {
      if (archivedIds?.has(l.sessionId)) continue // 归档会话：即使有锁也不展示
      if (cwd && normPath(l.cwd || '', base) !== base) continue
      const rec = bySession.get(l.sessionId) ?? { note: '', lockCount: 0, since: l.startedAt }
      rec.lockCount += 1
      if (!rec.note && l.note) rec.note = l.note
      if (l.startedAt < rec.since) rec.since = l.startedAt
      bySession.set(l.sessionId, rec)
    }
    const out = []
    const seen = new Set()
    for (const [sessionId, rec] of bySession) {
      const meta = sessionMeta.get(sessionId)
      if (cwd && meta?.cwd && normPath(meta.cwd, base) !== base) continue
      const status = meta?.status === 'running' ? 'running' : 'idle'
      out.push({ sessionId, status, note: rec.note, lockCount: rec.lockCount, since: rec.since })
      seen.add(sessionId)
    }
    // running 且在本工作区、但暂无锁的会话（刚开始干活/纯读操作）也展示
    for (const [sessionId, meta] of sessionMeta) {
      if (seen.has(sessionId)) continue
      if (archivedIds?.has(sessionId)) continue // 归档会话：running 也不展示
      if (meta?.status !== 'running') continue
      if (cwd && normPath(meta.cwd || '', base) !== base) continue
      // since 用首次活跃锚点 firstSeenAt（稳定，不随每轮 lastActiveAt 刷新）：
      // 2026-08-13 修复——lastActiveAt 每轮 agent/status 都更新，会让 HH:MM
      // 起始时刻跨分钟变化 → 公告板文本反复变化 → 频繁注入（内容其实没变）。
      out.push({ sessionId, status: 'running', note: '', lockCount: 0, since: meta.firstSeenAt ?? meta.lastActiveAt ?? now })
    }
    // 稳定排序（2026-08-13 修复）：按会话 ID 排序，消除锁登记/过期导致的
    // 成员顺序抖动——observed 锁 30s TTL 过期→重登记会让顺序反复变化，
    // 公告板文本（名单相同只是顺序不同）被整体 diff 判定为"变化"而频繁
    // 注入（用户实测：3 会话并行正常运行，一轮内反复收到相同内容）。
    out.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
    return out
  }
}

/**
 * 活动感知快照段【工作区活动】：活跃会话 >= 2 时注入一行，单会话/无视角/
 * 开关关 = null（零开销）。
 * 文案面向 AI（模型消费），固定格式省 token（克制原则）。
 *
 * ⚠️ **文本必须"状态驱动稳定"（2026-08-09 实测教训）**：快照投影按【整体
 * 文本】diff，文本变了才注入。曾用 `${fmtDateTime(Date.now())}`（渲染时刻
 * 秒级时间戳）——每次渲染文本必变 → 回合进行中每步都重复注入（用户实测
 * 10 秒一条刷屏）。修复：时间用**状态的一部分**——活跃起始时刻 since
 * （最早锁 startedAt / 最后活跃时间，分钟精度），只在成员/锁变化时才更新；
 * 状态稳定 → 文本稳定 → 只注入一次；状态变化 → 注入一次。秒级实时时间
 * 锚点放 de_ws_status 工具输出（调用时刻=模型看到时刻，广播模块同款）。
 *
 * @param {object} config - resolved config（wsCoordEnabled/wsCoordSnapshot 运行时值）。
 * @param {string} [sessionId] - 查看会话 id（无视角不注入）。
 * @param {string} [cwd] - 查看会话工作目录。
 * @param {WsCoordStore} store - 锁存储实例。
 * @param {Map<string, object>} sessionMeta - 会话元信息。
 * @param {(sid: string) => string} [displayName] - 会话显示名（别名优先）。
 * @param {ReadonlySet<string> | null} [archivedIds] - 已归档会话 id 集合
 *   （透传给 activeFor 过滤，归档会话不参与"并行中"判定）。
 * @returns {string | null}
 */
export function buildWsCoordBlock(config, sessionId, cwd, store, sessionMeta, displayName, archivedIds = null) {
  if (config.wsCoordEnabled !== true) return null
  if (config.wsCoordSnapshot !== true) return null
  if (!sessionId || !cwd) return null
  let active
  try {
    active = store.activeFor(cwd, sessionMeta, Date.now(), archivedIds)
  } catch { return null }
  if (active.length < SNAPSHOT_MIN_ACTIVE) return null
  const parts = active.map((a) => {
    const name = displayName ? displayName(a.sessionId) : a.sessionId.slice(0, 12)
    return a.note ? `${name}（${a.note}）` : name
  })
  // 状态驱动的时间：全部活跃会话中最早的起始时刻（分钟精度）——只在
  // 状态变化时更新，保证文本稳定（同状态连续渲染输出完全相同）
  const since = Math.min(...active.map((a) => a.since))
  const d = new Date(since)
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return `【工作区活动】${hhmm} 起 ${active.length} 个会话并行中：${parts.join(' / ')}。如要修改共享文件：**开工前先用 de_ws_declare 声明**（其他会话能看到你在做什么），动手前用 de_ws_status 查询占用，避免与他人的文件冲突`
}

/**
 * 工作区协调工具组（de_ws_declare / de_ws_status / de_ws_release）。
 * ⚠️ output schema 必须与返回值严格一致（additionalProperties:false 下
 * 多一个字段都会被模型 API 拒绝）——每个工具只声明自己返回的字段。
 * @param {WsCoordStore} store
 * @param {(sid: string) => string} displayName - 会话显示名（通知文案用）。
 * @param {Map<string, object>} sessionMeta - 会话元信息（agent/status 维护
 *   cwd/status/lastActiveAt，活动概览用；de_ws_status 的 execute 里读取）。
 * @returns {object[]} 工具定义数组。
 */
export function wsToolDefinitions(store, displayName, sessionMeta, archivedIds = null) {
  /** 锁 → 输出视图（只留对外字段，含别名显示）。 */
  const lockView = (l) => ({
    id: l.id,
    sessionId: l.sessionId,
    display: displayName ? displayName(l.sessionId) : l.sessionId,
    kind: l.kind,
    target: l.target,
    note: l.note ?? '',
    startedAt: l.startedAt,
    expiresAt: l.expiresAt,
    source: l.source,
  })
  /** 工具统一消息前缀：当前时间锚点（与广播同款——模型判断新旧的关键参照）。 */
  const stamp = () => `当前时间：${fmtDateTime(Date.now())}。`
  /** 当前执行上下文（execute 的 exec 参数）：agent 缺失时返回 null（非 agent 调用）。 */
  const ctxOf = (exec) => {
    const sessionId = exec?.agent?.session?.id
    const cwd = exec?.agent?.session?.header?.cwd
    return sessionId ? { sessionId, cwd } : null
  }

  return [
    {
      name: 'de_ws_declare',
      description: '工作区占用声明（工作区协调模块，随「会话广播」开关组启用）：开工前声明你将要修改的文件/影响的服务，其他会话写前检测到冲突会收到警告、你也会在别人动你的文件时收到定向通知（软模式，不强制拦截；enforceWrite 打开时冲突文件直接拒绝写入）。targets=要修改的文件列表（path 必填，可相对路径；note=在做什么/什么影响，**其他会话看到的就是这段**，写清楚）；services=要影响的服务/端口（name 必填，如 "dev 服务" / "3000 端口"；action=如 重启/占用）；ttlSeconds=锁有效期秒（**默认 30 秒，AI 可传但上限 300 秒=5 分钟——锁是"正在干活"的临时信号，写操作会自动续期，长任务只要在写就不断续；不写了默认 30 秒内自然过期释放，不卡其他会话**）。返回 declared=本次登记的锁、conflicts=与其他会话现有锁的重叠清单（**有冲突时主动调整计划或协商**）。工作结束后用 de_ws_release 释放；**自动登记的文件锁（observed）不随回合结束释放**——保留到 TTL（默认 30 秒，每次写操作自动续期）自然过期，保证「A 改完 → B 再改」的先后写入也能被检测到。',
      parameters: {
        type: 'object',
        properties: {
          targets: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', description: '要修改的文件路径（相对路径按工作目录解析）' },
                note: { type: 'string', description: '在做什么、会造成什么影响（其他会话可见）' },
              },
              required: ['path'],
            },
            description: '要修改的文件列表',
          },
          services: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', description: '服务名/端口（如 "dev 服务"、"3000 端口"）' },
                action: { type: 'string', description: '操作（如 重启 / 占用 / 停用）' },
                note: { type: 'string', description: '补充说明' },
              },
              required: ['name'],
            },
            description: '要影响的服务列表',
          },
          ttlSeconds: { type: 'integer', description: '锁有效期秒（默认 30，上限 300=5 分钟；写操作自动续期）' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            declared: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' }, sessionId: { type: 'string' }, display: { type: 'string' },
                  kind: { type: 'string', enum: ['file', 'service'] }, target: { type: 'string' },
                  note: { type: 'string' }, startedAt: { type: 'integer' }, expiresAt: { type: 'integer' },
                  source: { type: 'string', enum: ['declared', 'observed'] },
                },
                required: ['id', 'sessionId', 'display', 'kind', 'target', 'note', 'startedAt', 'expiresAt', 'source'],
              },
            },
            conflicts: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' }, sessionId: { type: 'string' }, display: { type: 'string' },
                  kind: { type: 'string', enum: ['file', 'service'] }, target: { type: 'string' },
                  note: { type: 'string' }, startedAt: { type: 'integer' }, expiresAt: { type: 'integer' },
                  source: { type: 'string', enum: ['declared', 'observed'] },
                },
                required: ['id', 'sessionId', 'display', 'kind', 'target', 'note', 'startedAt', 'expiresAt', 'source'],
              },
            },
          },
          required: ['ok', 'message', 'declared', 'conflicts'],
        },
        render(args, value) {
          const lines = [stamp()]
          lines.push(value.ok ? `已登记 ${value.declared.length} 项占用` : `登记失败：${value.message}`)
          for (const d of value.declared) lines.push(`  · ${d.kind === 'file' ? '文件' : '服务'} ${d.target}${d.note ? `（${d.note}）` : ''} 由 ${d.display} 占用至 ${fmtDateTime(d.expiresAt)}`)
          if (value.conflicts.length > 0) {
            lines.push(`⚠️ 与其他会话冲突 ${value.conflicts.length} 项：`)
            for (const c of value.conflicts) lines.push(`  · ${c.target} 已被 ${c.display} 占用（${c.note || '无备注'}）——建议调整计划或协商`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args, exec) {
        const ctx = ctxOf(exec)
        if (!ctx) return { ok: false, message: '无法识别调用会话（非 agent 上下文），不执行登记' }
        try {
          const { declared, conflicts } = store.declare({ sessionId: ctx.sessionId, cwd: ctx.cwd, targets: args.targets, services: args.services, ttlSeconds: args.ttlSeconds })
          const msg = declared.length === 0 ? '没有可登记的目标（targets/services 均为空或不合法）' : `已登记 ${declared.length} 项占用${conflicts.length > 0 ? `，检测到 ${conflicts.length} 项与其他会话冲突` : ''}`
          return { ok: true, message: msg, declared: declared.map(lockView), conflicts: conflicts.map(lockView) }
        } catch (error) {
          return { ok: false, message: `声明失败：${errText(error)}`, declared: [], conflicts: [] }
        }
      },
    },
    {
      name: 'de_ws_status',
      description: '工作区占用/活动查询（工作区协调模块）：**无参调用 = 当前工作区活动概览**——谁在跑、各自在干什么（声明 note）、锁了哪些文件（"AI 主动知道其他会话在做什么"的入口）。paths=只查这些文件的占用（交集语义：多会话要改同一文件时先查）；sessionId=只看某会话。返回 locks=占用清单（含过期自动清理）、active=工作区活跃会话概览。开始修改共享文件前建议先查一次。',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: '可选：只查这些文件（交集）' },
          sessionId: { type: 'string', description: '可选：只看某会话的占用' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            locks: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' }, sessionId: { type: 'string' }, display: { type: 'string' },
                  kind: { type: 'string', enum: ['file', 'service'] }, target: { type: 'string' },
                  note: { type: 'string' }, startedAt: { type: 'integer' }, expiresAt: { type: 'integer' },
                  source: { type: 'string', enum: ['declared', 'observed'] },
                },
                required: ['id', 'sessionId', 'display', 'kind', 'target', 'note', 'startedAt', 'expiresAt', 'source'],
              },
            },
            active: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  sessionId: { type: 'string' }, display: { type: 'string' }, status: { type: 'string', enum: ['running', 'idle'] },
                  note: { type: 'string' }, lockCount: { type: 'integer' }, since: { type: 'integer' },
                },
                required: ['sessionId', 'display', 'status', 'note', 'lockCount', 'since'],
              },
            },
            _self: { type: 'string', description: '调用方会话 id（render 判断"自己"用）' },
          },
          required: ['ok', 'message', 'locks', 'active', '_self'],
        },
        render(args, value) {
          const lines = [stamp()]
          if (value.active.length > 0) {
            lines.push(`工作区活跃会话 ${value.active.length} 个：`)
            for (const a of value.active) {
              lines.push(`  · ${a.display} [${a.status}]${a.note ? `：${a.note}` : ''}${a.lockCount > 0 ? `（占用 ${a.lockCount} 项）` : ''}`)
            }
          }
          lines.push(value.locks.length === 0 ? '当前无占用记录' : `占用 ${value.locks.length} 项：`)
          for (const l of value.locks) {
            const who = l.sessionId !== value._self ? l.display : '自己'
            lines.push(`  · ${l.kind === 'file' ? '文件' : '服务'} ${l.target} 由 ${who}${l.source === 'declared' ? '（声明）' : '（写过后自动登记）'}${l.note ? ` ${l.note}` : ''}，至 ${fmtDateTime(l.expiresAt)}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args, exec) {
        const ctx = ctxOf(exec)
        try {
          const locks = store.list({ cwd: ctx?.cwd, paths: args.paths, sessionId: args.sessionId })
          const active = store.activeFor(ctx?.cwd, sessionMeta ?? new Map(), Date.now(), archivedIds)
          return {
            ok: true,
            message: `查询完成：${locks.length} 项占用，${active.length} 个活跃会话`,
            locks: locks.map(lockView),
            active: active.map((a) => ({ sessionId: a.sessionId, display: displayName(a.sessionId), status: a.status, note: a.note, lockCount: a.lockCount, since: a.since })),
            _self: ctx?.sessionId ?? '',
          }
        } catch (error) {
          return { ok: false, message: `查询失败：${errText(error)}`, locks: [], active: [], _self: ctx?.sessionId ?? '' }
        }
      },
    },
    {
      name: 'de_ws_release',
      description: '释放占用（工作区协调模块）：工作做完后释放自己声明的文件/服务占用。paths=释放指定路径；all=true=释放本会话全部占用（回合收尾推荐）。释放后其他会话即可无警告写入这些文件。',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: '可选：释放这些文件' },
          all: { type: 'boolean', description: 'true=释放本会话全部占用（默认 false）' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            released: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' }, sessionId: { type: 'string' }, display: { type: 'string' },
                  kind: { type: 'string', enum: ['file', 'service'] }, target: { type: 'string' },
                  note: { type: 'string' }, startedAt: { type: 'integer' }, expiresAt: { type: 'integer' },
                  source: { type: 'string', enum: ['declared', 'observed'] },
                },
                required: ['id', 'sessionId', 'display', 'kind', 'target', 'note', 'startedAt', 'expiresAt', 'source'],
              },
            },
            remaining: { type: 'integer' },
          },
          required: ['ok', 'message', 'released', 'remaining'],
        },
        render(args, value) {
          const lines = [stamp()]
          lines.push(value.ok ? `已释放 ${value.released.length} 项占用，剩余 ${value.remaining} 项（全工作区）` : `释放失败：${value.message}`)
          for (const r of value.released) lines.push(`  · ${r.kind === 'file' ? '文件' : '服务'} ${r.target}`)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args, exec) {
        const ctx = ctxOf(exec)
        if (!ctx) return { ok: false, message: '无法识别调用会话（非 agent 上下文），不执行释放', released: [], remaining: 0 }
        try {
          const { released, remaining } = store.release({ sessionId: ctx.sessionId, paths: args.paths, all: args.all === true })
          return { ok: true, message: `已释放 ${released.length} 项占用`, released: released.map(lockView), remaining }
        } catch (error) {
          return { ok: false, message: `释放失败：${errText(error)}`, released: [], remaining: 0 }
        }
      },
    },
  ]
}

/**
 * 工作区协调装配（会话广播模块的子单元）：创建锁存储、注册工具与
 * 事件监听（fs/observed 自动登记 / tools/pre-execute 冲突检测 /
 * tools/post-execute 软模式警告注入 / agent/status 会话元信息 /
 * agent/turn-stopping 回合结束释放）、活动感知快照段由主插件
 * renderSnapshot 经 buildWsCoordBlock 渲染。
 *
 * ⚠️ waterfall 纪律：pre/post-execute 的 listener **必须调用 next()**——
 * 除硬模式 deny 外任何路径不调 next 都会 veto 掉工具调用（灾难）。
 * ⚠️ timer 回调必须 try/catch（未捕获异常会崩 DSH 进程）。
 *
 * @param {object} ctx - cordis ctx（需可监听 harness 事件，presence 同款模式）。
 * @param {object} config - resolved plugin config（wsCoordAutoRegister /
 *   wsCoordNotifyConflict / wsCoordEnforceWrite 静态默认；wsCoordEnabled /
 *   wsCoordSnapshot 运行时值由调用方保证已开启）。
 * @param {object} deps - { broadcastStore?: { send(req): {ok,message} },
 *   sessionMeta?: Map<string, object> }——broadcastStore 供冲突定向通知
 *   （广播模块同目录，直接可调）；sessionMeta 为会话元信息 Map
 *   （缺省内部自建，agent/status 维护 cwd/status/lastActiveAt）。
 * @returns {{ store: WsCoordStore, dispose: () => void }}
 */
export function installWsCoord(ctx, config, deps = {}) {
  const dir = join(config.broadcastDataDir ?? join(config.memoryDir ?? '', 'broadcast'), 'ws-coord')
  const store = new WsCoordStore(dir)
  /** 会话元信息：sessionId → { cwd, status, lastActiveAt }（活动概览用）。 */
  const sessionMeta = deps.sessionMeta ?? new Map()
  /**
   * 会话显示名（快照活动段/冲突提醒/通知文案用，**面向 AI 消费**）：
   * 必须给**完整会话 ID**（2026-08-09 用户拍板）——看到通知的 AI 需要用
   * 完整 ID 调 de_session status / de_broadcast presence 确认对方是否真的
   * 在运行；截短 ID 无法查询。有别名时"别名（完整ID）"便于人读。
   */
  const displayName = (sid) => {
    try {
      const aliases = config.memoryDir ? JSON.parse(readFileSync(join(config.memoryDir, 'aliases.json'), 'utf8')) : {}
      if (aliases && typeof aliases === 'object' && typeof aliases[sid] === 'string') return `${aliases[sid]}（${sid}）`
    } catch { /* 无别名文件：直接完整 ID */ }
    return sid
  }
  /** 软模式待注入警告：callId → 警告文本（pre 记录，post 消费）。 */
  const pendingWarnings = new Map()
  const disposers = []

  // —— 事件监听（ctx.effect 管理，disposer 自动清理）——
  // 1. agent/status：记录会话 cwd/status/lastActiveAt（活动概览数据源）
  disposers.push(ctx.effect
    ? ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => {
        try {
          const sessionId = agent?.session?.id
          if (!sessionId) return
          const prev = sessionMeta.get(sessionId)
          sessionMeta.set(sessionId, {
            cwd: prev?.cwd ?? agent?.session?.header?.cwd ?? '',
            status,
            lastActiveAt: Date.now(),
            // 首次活跃锚点（2026-08-13 修复）：只在首次记录时写入，不随
            // 每轮 lastActiveAt 刷新——公告板 HH:MM 起始时刻的数据源。
            // 旧实现 running 无锁会话的 since 用 lastActiveAt，每轮
            // agent/status（至少 2 次/轮）都会刷新 → HH:MM 跨分钟变化 →
            // 公告板文本反复变化 → 频繁注入（内容其实没变）。
            firstSeenAt: prev?.firstSeenAt ?? Date.now(),
          })
          // 成员状态变化（进入/离开 running）即时触发公告板检测投递
          // （checkAndNotify 定义于本函数之后，事件回调执行时已就绪）
          try { checkAndNotify() } catch { /* 投递失败不影响元信息维护 */ }
        } catch { /* 元信息维护失败不影响 */ }
      }), 'dsh-memory-evolve: ws-coord agent/status')
    : () => {})

  // 2. fs/observed：自动登记——会话实际写入的文件自动进占用集（不靠自觉）
  if (config.wsCoordAutoRegister !== false) {
    disposers.push(ctx.effect
      ? ctx.effect(() => ctx.on('fs/observed', (target, _version, actor) => {
          try {
            const sessionId = actor?.agent?.session?.id
            if (!sessionId) return
            const cwd = sessionMeta.get(sessionId)?.cwd ?? actor?.agent?.session?.header?.cwd ?? ''
            store.observe(sessionId, cwd, target?.targetKey ?? '')
            // 锁登记/续期即时触发公告板检测投递（定时器 15s 兜底）
            try { checkAndNotify() } catch { /* 投递失败不影响写入 */ }
          } catch { /* 自动登记失败不影响写入 */ }
        }), 'dsh-memory-evolve: ws-coord fs/observed')
      : () => {})
  }

  // 3. tools/pre-execute：写前冲突检测（write/edit 工具）
  //    —— waterfall：除硬模式 deny 外**必须调 next()**（不调 = veto 工具）
  disposers.push(ctx.effect
    ? ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
        try {
          if (exec?.name !== 'write' && exec?.name !== 'edit') return next()
          const sessionId = exec?.agent?.session?.id
          const cwd = exec?.agent?.session?.header?.cwd
          const filePath = exec?.arguments?.file_path
          if (!sessionId || typeof filePath !== 'string' || filePath === '') return next()
          const lock = store.conflictFor(sessionId, filePath, cwd)
          if (!lock) return next()
          const text = `文件 ${filePath} 正被会话 ${displayName(lock.sessionId)} 占用（${lock.note || '无备注'}，开始于 ${fmtDateTime(lock.startedAt)}，剩余约 ${Math.max(0, Math.ceil((lock.expiresAt - Date.now()) / 60000))} 分钟）`
          if (config.wsCoordEnforceWrite === true) {
            // 硬模式（开关位备用）：拒绝写入，AI 看到 reason 自主调整
            return { kind: 'deny', reason: `${text}。建议等待其释放，或先用 de_ws_status 查看详情再决定。` }
          }
          // 软模式：放行，记录警告 → post-execute 注入；并可选通知占用方
          pendingWarnings.set(exec.callId, text)
          if (config.wsCoordNotifyConflict !== false && deps.broadcastStore) {
            try {
              deps.broadcastStore.send({
                sender: sessionId,
                recipients: [lock.sessionId],
                subject: `冲突提醒：${filePath.split('/').pop()}`,
                content: `会话 ${displayName(sessionId)} 即将写入你占用的文件 ${filePath}（${lock.note || '无备注'}）。请留意可能的合并或提前释放占用。`,
              })
            } catch { /* 通知失败不影响工具调用 */ }
          }
          return next()
        } catch { return next() } // 检测异常绝不影响工具调用
      }), 'dsh-memory-evolve: ws-coord pre-execute')
    : () => {})

  // 4. tools/post-execute：软模式警告注入（写成功后把冲突警告放进模型
  //    上下文——下一轮生成即看到，不打断当前工作流）
  disposers.push(ctx.effect
    ? ctx.effect(() => ctx.on('tools/post-execute', async (exec, result, next) => {
        const warn = exec?.callId ? pendingWarnings.get(exec.callId) : undefined
        if (warn === undefined) return next()
        pendingWarnings.delete(exec.callId)
        // 写失败不注入（没有实际占用发生）
        if (!result || result.isError !== false) return next()
        const decision = await next()
        if (decision?.kind === 'accept') {
          return {
            kind: 'accept',
            additionalContexts: [userMessage(`⚠️ 冲突提醒：${warn}。如非有意写入他人占用的文件，建议用 de_ws_status 查看详情并与对方协商。`)],
          }
        }
        return decision
      }), 'dsh-memory-evolve: ws-coord post-execute')
    : () => {})

  // ⚠️ 刻意**不监听 agent/turn-stopping 释放 observed 锁**（2026-08-09
  // 用户实测教训）：回合结束立即释放会导致"先后写入"完全检测不到——
  // A 改完文件回合结束 → 锁消失 → B 下回合改同一文件时无冲突可报。
  // 冲突的主要场景正是先后写入（A 改了还没提交，B 又来改）。因此
  // observed 锁**保留到 TTL（30 秒）**自然过期，AI 可用 de_ws_release
  // 主动释放（all=true 清全部），避免堆积。

  // 5. agent/disposed：会话**被删除/销毁**时立即清理其全部锁与会话记录
  //    （2026-08-09 用户实测：已删除会话的锁还占着、活动段还显示它）。
  //    会话删除 = 用户明确放弃该会话，锁继续占（最长 30 秒，TTL 自然过期）
  //    会误伤
  //    其他会话且提醒指向不存在的会话（纯噪音）。**idle（停止回合）不
  //    触发此事件**——回合停止 ≠ 任务完成，锁保留 TTL（见上）。
  disposers.push(ctx.effect
    ? ctx.effect(() => ctx.on('agent/disposed', (payload) => {
        try {
          const sessionId = payload?.agent?.session?.id
          if (!sessionId) return
          store.release({ sessionId, all: true })
          sessionMeta.delete(sessionId)
        } catch { /* 清理失败不影响销毁流程 */ }
      }), 'dsh-memory-evolve: ws-coord agent/disposed')
    : () => {})

  /** 已归档会话 id 集合（每次现读，归档/取消归档即时生效）：
   *  ctx.workspaceRegistry.archivedSessionIds（官方注册表级归档集合，README 公开
   *  字段）。拿不到/读取失败返回 null = 不过滤（旧 DSH 版本兼容）。
   *  @returns {ReadonlySet<string> | null}
   */
  const archivedIds = () => {
    try {
      const list = ctx.workspaceRegistry?.archivedSessionIds
      if (!Array.isArray(list) || list.length === 0) return null
      return new Set(list)
    } catch { return null }
  }

  // —— 工具注册（三个 de_ws_* 工具）——
  disposers.push(ctx.effect
    ? ctx.effect(() => {
        const defs = wsToolDefinitions(store, displayName, sessionMeta, archivedIds)
        const cleanups = defs.map((d) => {
          const reg = ctx.tools.register(d)
          return () => { try { reg?.() } catch { /* 忽略 */ } }
        })
        return () => { for (const c of cleanups) c() }
      }, 'dsh-memory-evolve: ws-coord tools')
    : () => {})

  // —— 过期锁定期清理（unref 不阻止进程退出）——
  const pruneTimer = setInterval(() => {
    try { store.prune() } catch { /* 清理失败不影响使用 */ }
  }, 6 * 3600 * 1000)
  pruneTimer.unref?.()

  // —— 公告板独立投递（2026-08-13 用户拍板：公告板移出整体快照）——
  // DSH 快照按【整体文本】diff 注入：公告板一行变化会连带记忆/纪律等
  // 其他段一起作为新尾部重注入，AI 被迫重看已注入多次的无关段（噪声）；
  // 且 DSH 核心不支持逐段投影（归档调研确认），插件无法让单段独立变更
  // 检测。因此改为本模块内部检测状态变化，向工作区会话投递**独立消息**
  // （inject 不唤醒，内容与旧公告板行完全一致）。
  // 检测：agent/status 事件（成员进出即时）+ 15s 轮询定时器（覆盖锁
  // 过期等惰性变化，unref 不阻止进程退出）；投递节流：同一会话 30s 内
  // 最多一条（正常变化已做状态驱动稳定，频率很低，节流只是极端兜底）。
  const NOTIFY_POLL_MS = 15 * 1000
  const NOTIFY_MIN_INTERVAL_MS = 30 * 1000
  /** 占位标记：上次投递的是「并行结束」（避免与真实公告板文本混淆）。 */
  const ENDED_MARKER = '\u0000ended'
  let agentsService = null
  try { agentsService = ctx.get('agents') } catch { /* 旧运行时无 agents 服务：公告板不投递 */ }
  /** 会话 → 上次投递的公告板文本（ENDED_MARKER = 已通知过并行结束）。 */
  const lastBlockBySession = new Map()
  /** 会话 → 上次投递时间戳（节流）。 */
  const lastNotifyAt = new Map()

  /**
   * 检查工作区内公告板状态是否变化，变化则向对应会话投递独立消息。
   * 以每个会话自己的视角（sessionId+cwd）生成公告板文本——不同工作区
   * 的会话只收到自己工作区的活动。活跃会话 <2（公告板隐藏）且上次有
   * 内容时投递「并行结束」消息（有信息量：可以独占工作区了）。
   * 公开为测试钩子（定时器与事件监听都走它）。
   */
  const checkAndNotify = () => {
    if (config.wsCoordSnapshot !== true || agentsService === null) return
    for (const [sessionId, meta] of sessionMeta) {
      const cwd = meta?.cwd
      if (!cwd || meta?.status !== 'running') continue
      const block = buildWsCoordBlock(config, sessionId, cwd, store, sessionMeta, displayName, archivedIds())
      const next = block !== null ? block : ENDED_MARKER
      const prev = lastBlockBySession.get(sessionId)
      if (prev === next) continue
      if (prev === undefined) {
        // 首次见到该会话：有公告板内容（并行开始）→ 投递；无内容（当前
        // 活跃不足 2）→ 只记基线不投递——避免给从未并行的会话发一条
        // 无意义的「并行已结束」
        if (block === null) {
          lastBlockBySession.set(sessionId, ENDED_MARKER)
          continue
        }
      }
      const lastAt = lastNotifyAt.get(sessionId) ?? 0
      if (Date.now() - lastAt < NOTIFY_MIN_INTERVAL_MS) continue
      const agent = agentsService.get(sessionId)
      if (!agent) continue
      const text = block !== null
        ? block
        : '【工作区活动】并行已结束：当前工作区活跃会话不足 2 个，可独占继续工作（有需要可用 de_ws_status 复查）'
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin',
          plugin: 'dsh-memory-evolve',
          form: 'notice',
          summary: text.split('\n')[0].slice(0, 80),
        },
      }
      // 公告板是状态更新，一律 inject 不唤醒（不打断正在进行的回合）
      agent.inject(message)
      lastBlockBySession.set(sessionId, next)
      lastNotifyAt.set(sessionId, Date.now())
    }
  }
  const notifyTimer = setInterval(() => {
    try { checkAndNotify() } catch { /* 投递失败不影响锁功能 */ }
  }, NOTIFY_POLL_MS)
  notifyTimer.unref?.()

  return {
    store,
    sessionMeta,
    archivedIds,
    /** 测试钩子：手动触发一次公告板变更检测与投递。 */
    checkAndNotify,
    dispose() {
      clearInterval(pruneTimer)
      clearInterval(notifyTimer)
      for (const d of disposers) {
        try { d?.() } catch { /* 忽略 */ }
      }
    },
  }
}
