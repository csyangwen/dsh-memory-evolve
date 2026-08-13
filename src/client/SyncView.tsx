/**
 * dsh-memory-evolve — 记忆同步 Tab（conversation.view entry，跟随 syncEnabled）。
 *
 * 三个子 Tab（2026-08-11 用户拍板：项目与全局是两个独立系统，必须分开）：
 *   1. 本项目    —— 项目记忆（KEY/日志/归档/项目待办）的同步开关与操作：
 *                    不启用 / A 模式（主代码仓库）/ B 模式（共享记忆仓库）
 *                    三选一；启用后提供 同步 / 同步并推送 按钮与状态；
 *   2. 全局记忆  —— 设备级（与项目无关）：全局记忆/用户档案/每日日志/待办
 *                    四轨开关 + 全局同步按钮；依赖共享记忆仓库；
 *   3. 记忆远端  —— 设备级：共享记忆仓库地址（配置一次，项目 B 与全局共用）。
 *
 * 核心概念（避免混淆）：
 *   - 共享记忆仓库地址是**设备级**配置（一台电脑配一次），不是项目也不是
 *     全局的私有配置——所以放在独立的「记忆远端」子 Tab；
 *   - 项目 B 模式与全局记忆都只是**引用**这个地址；
 *   - 全局记忆是设备级系统：任何项目点开本 Tab，全局子 Tab 内容都是同一套。
 *
 * 数据源：/memory-evolve/memory-sync/*（host API；与命令组同一套逻辑）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

const API = '/memory-evolve/memory-sync'

/** 同步状态（/status 返回）。 */
interface SyncStatus {
  enabled: boolean
  initialized: boolean
  /** 项目级同步开关（三层开关第 2 层）：PROVENANCE.enabled !== false。 */
  projectEnabled?: boolean
  /** 轨级开关（第 3 层）：项目记忆轨 + 全局轨（见 global）。 */
  tracks?: { project?: boolean }
  /** 工作树未提交变更数（改了还没 commit 的文件数）。 */
  uncommitted?: number
  /** 已提交未推送的提交数（本地 HEAD 领先远端；2026-08-11 用户反馈后新增）。 */
  ahead?: number
  behind?: number
  conflicts?: number
  remoteBranch?: string
  /** 记忆远端类型（统一模式）：main-repo=主代码仓库（默认）；shared-repo=共享记忆仓库。 */
  remoteKind?: 'main-repo' | 'shared-repo' | 'none'
  /** 当前记忆实际对账的远端 origin URL。 */
  originUrl: string
  identity?: { displayName: string; kind: string; remoteUrl?: string }
  migrateFrom?: string | null
  /** 全局轨状态（设备级；仅共享记忆仓库可用，2026-08-11 本期实现）。 */
  global?: {
    initialized: boolean
    /** 共享记忆库启用位（设备级，2026-08-11 用户拍板）：false = 停用。 */
    enabled?: boolean
    url: string
    tracks: { memory?: boolean; user?: boolean; daily?: boolean; todo?: boolean }
    /** 工作树变更的轨数（未 commit）。 */
    uncommitted: number
    /** 已提交未推送的轨数（本地轨分支领先远端；2026-08-11 用户反馈后新增）。 */
    ahead?: number
    /** 各轨冲突数（track 名 → 条数；>0 的轨在全局子 Tab 显示冲突区）。 */
    conflicts?: { memory?: number; user?: number; daily?: number; todo?: number }
  }
}

/** 全局轨 fileset（/conflicts 与 /resolve 的 fileset 参数；track → fileset）。 */
const GLOBAL_FILESET: Record<string, string> = { memory: 'memory-global', user: 'user-global', daily: 'daily-global', todo: 'todo-global' }

/** 全局轨显示名词典键（冲突区标题用；track → 词典键）。 */
const GLOBAL_TRACK_LABEL: Record<string, string> = {
  memory: 'syncTab.global.trackMemory',
  user: 'syncTab.global.trackUser',
  daily: 'syncTab.global.trackDaily',
  todo: 'syncTab.global.trackTodo',
}

/** 一条冲突（/conflicts 返回；resolve 用 index 定位）。 */
interface ConflictItem {
  index: number
  entryKey: string
  file: string
  reason: string
  base: string | null
  ours: string | null
  theirs: string | null
}

/** 通用 API 调用（同文件内各模块同款）。 */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

/** 截断长文本（冲突三方片段展示用）。 */
function clamp(text: string | null, max = 60): string {
  if (text === null) return '（无）'
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 操作反馈（成功/失败）。 */
type Notice = { kind: 'ok' | 'error'; text: string } | null

/** 子 Tab：project=本项目 / global=全局记忆 / remote=共享记忆库。 */
type SyncFeature = 'project' | 'global' | 'remote'

export function SyncView(props: ConvViewProps & { t: Translate }): JSX.Element {
  const { t, sessionId } = props
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [conflicts, setConflicts] = useState<ConflictItem[]>([])
  /** 全局各轨冲突列表（track 名 → 列表；2026-08-11 用户反馈后新增——
   *  全局推送被某轨冲突拦截时，冲突区就在全局子 Tab 里解决）。 */
  const [globalConflicts, setGlobalConflicts] = useState<Record<string, ConflictItem[]>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [initialized, setInitialized] = useState(false) // status 首次加载完成标记
  /** 当前子 Tab（跨重挂持久化：状态刷新导致组件重挂后恢复）。 */
  const [feature, setFeature] = useState<SyncFeature>('project')
  /** 「共享记忆库」子 Tab 的地址输入：初始回显已配置的共享仓库地址。 */
  const [remoteUrl, setRemoteUrl] = useState('')
  // 用户开始编辑后，后台刷新不得用已保存的地址覆盖尚未提交的输入。
  const remoteUrlEdited = useRef(false)
  /** 共享记忆库启用意向（2026-08-11 用户拍板：本地单选，回显服务端
   *  enabled；点「启用」只切本地意向并露出地址输入，点「启用并保存」才
   *  真正执行；点「不启用」且当前已启用 → 立即停用）。 */
  const [remoteOn, setRemoteOn] = useState(false)

  /** 拉取状态 + 冲突列表（项目 + 全局各轨）。 */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [s, c] = await Promise.all([
        api<{ status?: SyncStatus } | SyncStatus>(`/status?sessionId=${encodeURIComponent(sessionId)}`),
        api<{ conflicts: ConflictItem[] }>(`/conflicts?sessionId=${encodeURIComponent(sessionId)}`),
      ])
      const nextStatus = 'status' in s && s.status !== undefined ? s.status : (s as SyncStatus)
      setStatus(nextStatus)
      // 记忆远端输入框回显已配置的共享仓库地址（设备级 global.url）。
      // 不能回显项目 originUrl——A 模式下 originUrl 是主代码仓库地址，
      // 回显它会把「共享记忆库」配置误改成主代码仓（稳定版复审 P0-8）
      if (!remoteUrlEdited.current) setRemoteUrl(nextStatus.global?.url ?? '')
      // 启用意向回显：跟随服务端 enabled（停用后刷新回"不启用"）
      setRemoteOn(nextStatus.global?.enabled === true)
      setConflicts(c.conflicts ?? [])
      // 全局各轨冲突详情：对 status.global.conflicts > 0 的轨逐轨拉取
      // （/conflicts?fileset=<track>-global；2026-08-11 用户反馈：全局轨
      // 冲突也要能在 UI 解决，不能只报"先到冲突区解决"却无处可点）
      const gMap: Record<string, ConflictItem[]> = {}
      const gCounts = nextStatus.global?.conflicts ?? {}
      const gTracks = (Object.keys(gCounts) as Array<keyof typeof gCounts>)
        .filter((track) => (gCounts[track] ?? 0) > 0)
      await Promise.all(gTracks.map(async (track) => {
        const fileset = GLOBAL_FILESET[track]
        if (!fileset) return
        const r = await api<{ conflicts: ConflictItem[] }>(`/conflicts?sessionId=${encodeURIComponent(sessionId)}&fileset=${encodeURIComponent(fileset)}`)
        gMap[track] = r.conflicts ?? []
      }))
      setGlobalConflicts(gMap)
    } catch (error) {
      setNotice({ kind: 'error', text: t('syncTab.loadFailed', { message: (error as Error).message }) })
    } finally {
      setInitialized(true)
    }
  }, [sessionId, t])

  useEffect(() => {
    remoteUrlEdited.current = false
    setRemoteUrl('')
  }, [sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 执行一个操作（busy 锁 + 结果反馈 + 刷新）。 */
  const run = async (op: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      const result = await op()
      const r = result as { ok?: boolean; text?: string }
      setNotice({ kind: r.ok === false ? 'error' : 'ok', text: r.text ?? 'ok' })
    } catch (error) {
      setNotice({ kind: 'error', text: (error as Error).message })
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  /**
   * 本项目三态选择（2026-08-11 用户拍板）：
   *   - 不启用：项目记忆纯本地（/off，记忆完整保留）；
   *   - A 模式：记忆远端 = 主代码仓库（/setup 无参，零配置）；
   *   - B 模式：记忆远端 = 共享记忆仓库（/setup { url }）——但地址是设备级
   *     配置（「记忆远端」子 Tab），**未配置时不允许切 B**，引导去配置。
   * @param mode - 'off' | 'main' | 'shared'。
   */
  const setProjectMode = async (mode: 'off' | 'main' | 'shared'): Promise<{ ok: boolean; text: string }> => {
    if (mode === 'off') {
      const r = await api<{ ok: boolean; text: string }>('/off', { method: 'POST', body: JSON.stringify({ sessionId }) })
      return r
    }
    if (mode === 'shared') {
      // B 模式依赖设备级共享记忆库：未启用（enabled=false 或未初始化）→
      // 拒绝并跳到「共享记忆库」子 Tab 引导（2026-08-11 用户拍板）
      if (status?.global?.enabled !== true || status?.global?.initialized !== true) {
        setFeature('remote') // 跳到「共享记忆库」子 Tab 引导启用
        return { ok: false, text: t('syncTab.project.mode.shared.needRemote') }
      }
      const url = status.global.url
      const r = await api<{ ok: boolean; text: string }>('/setup', { method: 'POST', body: JSON.stringify({ sessionId, url }) })
      return r
    }
    // A 模式：无参 setup（切回/初始化到主代码仓库，自动启用本项目）
    const r = await api<{ ok: boolean; text: string }>('/setup', { method: 'POST', body: JSON.stringify({ sessionId }) })
    return r
  }

  return (
    <div className="mt-panel">
      {!initialized ? (
        <div className="bb-empty">{t('syncTab.loading')}</div>
      ) : (
        <>
          {notice !== null && (
            <div className={notice.kind === 'ok' ? 'me-notice-ok' : 'me-notice-error'}>
              {notice.text}
            </div>
          )}

          {/* 子 Tab 栏：本项目 / 全局记忆 / 记忆远端（2026-08-11 用户拍板） */}
          <div className="mt-file-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={feature === 'project'}
              className={feature === 'project' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
              onClick={() => setFeature('project')}
            >
              {t('syncTab.tab.project')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={feature === 'global'}
              className={feature === 'global' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
              onClick={() => setFeature('global')}
            >
              {t('syncTab.tab.global')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={feature === 'remote'}
              className={feature === 'remote' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
              onClick={() => setFeature('remote')}
            >
              {t('syncTab.tab.remote')}
            </button>
          </div>

          {/* ════════ 子 Tab 一：本项目 ════════ */}
          {feature === 'project' && (
            <>
              <div className="sv-section">
                <div className="sv-section-title">{t('syncTab.section.project')}</div>
                {/* 三态单选：不启用 / A 模式 / B 模式（2026-08-11 用户拍板：
                    一个决策同时表达"是否启用"与"记忆放哪"，无悬空状态） */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <label className={`sv-radio-row${status?.projectEnabled !== true ? ' sv-radio-active' : ''}`}>
                    <input
                      type="radio"
                      name="sync-project-mode"
                      checked={status?.projectEnabled !== true}
                      onChange={() => { void run(() => setProjectMode('off')) }}
                    />
                    <span style={{ flex: 1 }}>
                      <span className="sv-radio-label">{t('syncTab.project.mode.off')}</span>
                      <span className="sv-radio-desc">{t('syncTab.project.mode.off.desc')}</span>
                    </span>
                  </label>
                  <label className={`sv-radio-row${status?.projectEnabled === true && status?.remoteKind === 'main-repo' ? ' sv-radio-active' : ''}`}>
                    <input
                      type="radio"
                      name="sync-project-mode"
                      checked={status?.projectEnabled === true && status?.remoteKind === 'main-repo'}
                      onChange={() => { void run(() => setProjectMode('main')) }}
                    />
                    <span style={{ flex: 1 }}>
                      <span className="sv-radio-label">{t('syncTab.project.mode.main')}</span>
                      <span className="sv-radio-desc">{t('syncTab.project.mode.main.desc')}</span>
                    </span>
                  </label>
                  <label className={`sv-radio-row${status?.projectEnabled === true && status?.remoteKind === 'shared-repo' ? ' sv-radio-active' : ''}`}>
                    <input
                      type="radio"
                      name="sync-project-mode"
                      checked={status?.projectEnabled === true && status?.remoteKind === 'shared-repo'}
                      onChange={() => { void run(() => setProjectMode('shared')) }}
                    />
                    <span style={{ flex: 1 }}>
                      <span className="sv-radio-label">{t('syncTab.project.mode.shared')}</span>
                      <span className="sv-radio-desc">{t('syncTab.project.mode.shared.desc')}</span>
                    </span>
                  </label>
                </div>

                {/* 当前记忆远端状态（一个仓库） */}
                {status?.projectEnabled === true && status?.initialized === true && (
                  <div className="sv-status" style={{ marginTop: '10px' }}>
                    <p>
                      <strong>{t('syncTab.status.remoteKind', { kind: status?.remoteKind === 'main-repo' ? t('syncTab.status.remoteKindMain') : status?.remoteKind === 'shared-repo' ? t('syncTab.status.remoteKindShared') : t('syncTab.status.remoteKindNone') })}</strong>
                      <br />
                      <span className="sv-status-url">{status?.originUrl || t('syncTab.status.remoteKindNone')}</span>
                    </p>
                    <p>
                      {t('syncTab.status.branch', { branch: status?.remoteBranch ?? '?' })}
                      <br />
                      {/* 「未推送」= 工作树未提交变更 + 已提交未推送的提交
                          （2026-08-11 用户反馈：只看"未提交"会误以为拉取合并
                          已把内容推上去；点拉取合并后 ahead 仍在 → 引导点
                          「推送」才上远端） */}
                      {t('syncTab.status.counts', {
                        pending: String((status?.uncommitted ?? 0) + (status?.ahead ?? 0)),
                        behind: String(status?.behind ?? 0),
                        conflicts: String(status?.conflicts ?? 0),
                      })}
                    </p>
                    {status?.migrateFrom != null && (
                      <p>{t('syncTab.status.migrate', { dir: status.migrateFrom })}</p>
                    )}
                  </div>
                )}

                {/* 项目同步操作（仅启用后可用；只驱动项目轨，与全局分离——
                    2026-08-11 用户拍板：全局同步在「全局记忆」子 Tab） */}
                {status?.projectEnabled === true && status?.initialized === true && (
                  <div className="sv-actions">
                    <button type="button" className="me-btn me-btn-primary" disabled={busy} onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/sync', { method: 'POST', body: JSON.stringify({ sessionId }) })) }}>
                      {t('syncTab.actions.sync')}
                    </button>
                    <button type="button" className="me-btn me-btn-ok" disabled={busy} onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/sync', { method: 'POST', body: JSON.stringify({ sessionId, push: true }) })) }}>
                      {t('syncTab.actions.push')}
                    </button>
                  </div>
                )}
                {status?.enabled === true && status?.projectEnabled === true && status?.initialized !== true && (
                  <p className="bb-meta" style={{ marginTop: '8px' }}>{t('syncTab.status.notInit')}</p>
                )}
              </div>

              {/* 冲突区（项目级冲突） */}
              {status?.enabled === true && conflicts.length > 0 && (
                <div className="sv-section">
                  <div className="sv-section-title">{t('syncTab.conflicts.title', { count: conflicts.length })}</div>
                  {conflicts.map((c) => (
                    <div key={c.index} className="bb-session-line">
                      <div>
                        <strong>#{c.index} {c.entryKey}</strong>（{c.file}）· {c.reason}
                        <br />
                        <span className="bb-meta">
                          {t('syncTab.conflicts.base')}：{clamp(c.base)}
                          <br />
                          {t('syncTab.conflicts.ours')}：{clamp(c.ours)}
                          <br />
                          {t('syncTab.conflicts.theirs')}：{clamp(c.theirs)}
                        </span>
                      </div>
                      <div className="bb-actions">
                        <button type="button" className="me-btn" disabled={busy} onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/resolve', { method: 'POST', body: JSON.stringify({ sessionId, index: c.index, choice: 'ours' }) })) }}>
                          {t('syncTab.conflicts.oursBtn')}
                        </button>
                        <button type="button" className="me-btn" disabled={busy} onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/resolve', { method: 'POST', body: JSON.stringify({ sessionId, index: c.index, choice: 'theirs' }) })) }}>
                          {t('syncTab.conflicts.theirsBtn')}
                        </button>
                        <button type="button" className="me-btn" disabled={busy} onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/resolve', { method: 'POST', body: JSON.stringify({ sessionId, index: c.index, choice: 'both' }) })) }}>
                          {t('syncTab.conflicts.bothBtn')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ════════ 子 Tab 二：全局记忆（设备级，与项目无关）════════ */}
          {feature === 'global' && (
            <div className="sv-section">
              <div className="sv-section-title">{t('syncTab.section.global')}</div>
              {/* 可用条件 = 共享记忆库已启用（enabled）且已初始化；停用/未配置
                  时明确显示"不可用"并引导（2026-08-11 用户拍板） */}
              {status?.global?.enabled === true && status?.global?.initialized === true ? (
                <>
                  {/* 四轨开关（每轨独立 opt-in，默认关） */}
                  {([
                    ['memory', 'syncTab.global.trackMemory'],
                    ['user', 'syncTab.global.trackUser'],
                    ['daily', 'syncTab.global.trackDaily'],
                    ['todo', 'syncTab.global.trackTodo'],
                  ] as const).map(([track, labelKey]) => (
                    <label key={track} className="me-field">
                      <span className="me-field-label">{t(labelKey)}</span>
                      <input
                        type="checkbox"
                        className="me-switch"
                        checked={status.global?.tracks?.[track] === true}
                        onChange={(event) => {
                          const target = event.target.checked
                          void run(() => api<{ ok: boolean; text: string }>('/global-track', { method: 'POST', body: JSON.stringify({ sessionId, track, on: target }) }))
                        }}
                      />
                    </label>
                  ))}
                  <p className="bb-meta">
                    {/* 「未推送」= 工作树变更轨 + 已提交未推送的轨（2026-08-11
                        用户反馈：与「推送」按钮语义对齐——点拉取合并后领先轨
                        仍在，引导点「推送」才上远端） */}
                    {t('syncTab.global.uncommitted', { n: String((status.global.uncommitted ?? 0) + (status.global.ahead ?? 0)) })}
                    <br />
                    {t('syncTab.global.hint')}
                  </p>
                  {/* 全局同步按钮（只驱动全局轨，与项目分离） */}
                  <div className="sv-actions">
                    <button type="button" className="me-btn me-btn-primary" disabled={busy} onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/global-sync', { method: 'POST', body: JSON.stringify({ sessionId }) })) }}>
                      {t('syncTab.global.sync')}
                    </button>
                    <button type="button" className="me-btn me-btn-ok" disabled={busy} onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/global-sync', { method: 'POST', body: JSON.stringify({ sessionId, push: true }) })) }}>
                      {t('syncTab.global.push')}
                    </button>
                  </div>

                  {/* 全局各轨冲突区（2026-08-11 用户反馈：全局推送被某轨冲突
                      拦截时，冲突区就在这里解决——fileset 透传给 /resolve；
                      解决后本地提交、ahead+1，再点「推送」上远端） */}
                  {Object.entries(globalConflicts).map(([track, items]) => (
                    items.length > 0 ? (
                      <div className="sv-section" key={`g-${track}`}>
                        <div className="sv-section-title">
                          {t('syncTab.conflicts.titleGlobal', { track: t(GLOBAL_TRACK_LABEL[track] ?? 'syncTab.global.title'), count: String(items.length) })}
                        </div>
                        {items.map((c) => (
                          <div key={`g-${track}-${c.index}`} className="bb-session-line">
                            <div>
                              <strong>#{c.index} {c.entryKey}</strong>（{c.file}）· {c.reason}
                              <br />
                              <span className="bb-meta">
                                {t('syncTab.conflicts.base')}：{clamp(c.base)}
                                <br />
                                {t('syncTab.conflicts.ours')}：{clamp(c.ours)}
                                <br />
                                {t('syncTab.conflicts.theirs')}：{clamp(c.theirs)}
                              </span>
                            </div>
                            <div className="bb-actions">
                              <button type="button" className="me-btn" disabled={busy} onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/resolve', { method: 'POST', body: JSON.stringify({ sessionId, index: c.index, choice: 'ours', fileset: GLOBAL_FILESET[track] }) })) }}>
                                {t('syncTab.conflicts.oursBtn')}
                              </button>
                              <button type="button" className="me-btn" disabled={busy} onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/resolve', { method: 'POST', body: JSON.stringify({ sessionId, index: c.index, choice: 'theirs', fileset: GLOBAL_FILESET[track] }) })) }}>
                                {t('syncTab.conflicts.theirsBtn')}
                              </button>
                              <button type="button" className="me-btn" disabled={busy} onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/resolve', { method: 'POST', body: JSON.stringify({ sessionId, index: c.index, choice: 'both', fileset: GLOBAL_FILESET[track] }) })) }}>
                                {t('syncTab.conflicts.bothBtn')}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null
                  ))}
                </>
              ) : (
                <p className="bb-settings-desc">{t('syncTab.global.notInit')}</p>
              )}
            </div>
          )}

          {/* ════════ 子 Tab 三：共享记忆库（设备级配置，无 A/B 徽标）════════ */}
          {feature === 'remote' && (
            <div className="sv-section">
              <div className="sv-section-title">{t('syncTab.section.remote')}</div>
              {/* 说明：设备级、项目 B 与全局共用 */}
              <p className="bb-settings-desc">{t('syncTab.remote.desc')}</p>

              {/* 启用/停用单选（2026-08-11 用户拍板：共享记忆库也要有开关——
                  不启用 = 项目 B 与全局记忆均不可用；已同步数据与地址保留）。
                  用本地意向 remoteOn 控制显示；点「不启用」且当前已启用 →
                  立即停用；点「启用」→ 露出地址输入，点「启用并保存」才生效 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label className={`sv-radio-row${!remoteOn ? ' sv-radio-active' : ''}`}>
                  <input
                    type="radio"
                    name="sync-remote-enabled"
                    checked={!remoteOn}
                    onChange={() => {
                      if (status?.global?.enabled === true) {
                        // 当前已启用 → 直接停用（数据保留）
                        void run(() => api<{ ok: boolean; text: string }>('/global-remote', { method: 'POST', body: JSON.stringify({ enabled: false }) }))
                      } else {
                        setRemoteOn(false)
                      }
                    }}
                  />
                  <span style={{ flex: 1 }}>
                    <span className="sv-radio-label">{t('syncTab.remote.mode.off')}</span>
                    <span className="sv-radio-desc">{t('syncTab.remote.mode.off.desc')}</span>
                  </span>
                </label>
                <label className={`sv-radio-row${remoteOn ? ' sv-radio-active' : ''}`}>
                  <input
                    type="radio"
                    name="sync-remote-enabled"
                    checked={remoteOn}
                    onChange={() => setRemoteOn(true)}
                  />
                  <span style={{ flex: 1 }}>
                    <span className="sv-radio-label">{t('syncTab.remote.mode.on')}</span>
                    <span className="sv-radio-desc">{t('syncTab.remote.mode.on.desc')}</span>
                  </span>
                </label>
              </div>

              {/* 启用意向态：地址输入 + 启用并保存（/global-remote：只配置设备级
                  共享记忆库，不碰项目）；已启用时附「停用共享记忆库」按钮 */}
              {remoteOn ? (
                <>
                  <div className="sv-actions" style={{ marginTop: '10px' }}>
                    <input
                      type="text"
                      className="me-input"
                      style={{ flex: '1 1 360px', width: 'auto', minWidth: 'min(280px, 100%)' }}
                      placeholder={t('syncTab.remote.placeholder')}
                      value={remoteUrl}
                      onChange={(event) => {
                        remoteUrlEdited.current = true
                        setRemoteUrl(event.target.value)
                      }}
                    />
                    <button
                      type="button"
                      className="me-btn me-btn-primary"
                      disabled={busy || remoteUrl.trim() === ''}
                      onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/global-remote', { method: 'POST', body: JSON.stringify({ url: remoteUrl.trim(), enabled: true }) })) }}
                    >
                      {/* 已启用 = 修改并保存（可换另一个共享记忆库，旧分支留档）；
                          未启用 = 启用并保存（2026-08-11 用户拍板） */}
                      {status?.global?.initialized === true && status?.global?.url !== ''
                        ? t('syncTab.remote.modify')
                        : t('syncTab.remote.save')}
                    </button>
                    {status?.global?.initialized === true && status?.global?.url !== '' && (
                      <button
                        type="button"
                        className="me-btn me-btn-danger"
                        disabled={busy}
                        onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/global-remote', { method: 'POST', body: JSON.stringify({ enabled: false }) })) }}
                      >
                        {t('syncTab.remote.disable')}
                      </button>
                    )}
                  </div>
                  {/* 当前已配置地址（只读展示） */}
                  {status?.global?.initialized === true && status?.global?.url !== '' && (
                    <p className="bb-meta" style={{ marginTop: '8px' }}>
                      {t('syncTab.remote.current', { url: status.global.url })}
                    </p>
                  )}
                </>
              ) : (
                <p className="bb-meta" style={{ marginTop: '8px' }}>{t('syncTab.remote.switchHint')}</p>
              )}
            </div>
          )}

          {/* ── 提示 ── */}
          <p className="bb-empty">{t('syncTab.footnote')}</p>
        </>
      )}
    </div>
  )
}
