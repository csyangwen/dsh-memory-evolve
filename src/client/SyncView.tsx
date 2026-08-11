/**
 * dsh-memory-evolve — 记忆同步 Tab（conversation.view entry，跟随 syncEnabled）。
 *
 * 把记忆同步能力集中到独立 Tab：
 *   - 状态卡片：项目身份 / 远端分支 / 未提交 / 落后 / 冲突数 / 迁移提示
 *   - 操作：启用开关、开始同步（用代码仓库一键 / 填共享记忆仓库地址）、
 *     同步、同步并推送（**点击即用户显式同意推送**，需求 #12）、停用
 *   - 冲突列表：每条三版本摘要 + 采用本机 / 采用远端 / 两者都要
 *   - 结果反馈 notice（成功/失败如实呈现）
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
  uncommitted?: number
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
    url: string
    tracks: { memory?: boolean; user?: boolean; daily?: boolean; todo?: boolean }
    uncommitted: number
  }
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

export function SyncView(props: ConvViewProps & { t: Translate }): JSX.Element {
  const { t, sessionId } = props
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [conflicts, setConflicts] = useState<ConflictItem[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  // 记忆远端地址输入：初始回显当前 origin，也可改为共享记忆仓库地址。
  const [remoteUrl, setRemoteUrl] = useState('')
  // 用户开始编辑后，后台刷新不得用 status.originUrl 覆盖尚未提交的输入。
  const remoteUrlEdited = useRef(false)
  const [initialized, setInitialized] = useState(false) // status 首次加载完成标记

  /** 拉取状态 + 冲突列表。 */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [s, c] = await Promise.all([
        api<{ status?: SyncStatus } | SyncStatus>(`/status?sessionId=${encodeURIComponent(sessionId)}`),
        api<{ conflicts: ConflictItem[] }>(`/conflicts?sessionId=${encodeURIComponent(sessionId)}`),
      ])
      const nextStatus = 'status' in s && s.status !== undefined ? s.status : (s as SyncStatus)
      setStatus(nextStatus)
      if (!remoteUrlEdited.current) setRemoteUrl(nextStatus.originUrl ?? '')
      setConflicts(c.conflicts ?? [])
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

  const sectionStyle = {
    marginTop: '12px',
    paddingTop: '12px',
    borderTop: '1px solid var(--dsw-alias-border-l2)',
  }

  /**
   * 统一同步：一个「同步」/「同步并推送」按钮同时驱动 项目轨 + 已开启的
   * 全局轨（2026-08-11 用户拍板：按钮不重复，只保留一对推拉按钮）。
   * 顺序执行并聚合结果：项目 sync（若已初始化）→ 全局轨 sync（若有轨开启）。
   * @param push - true = 同步并推送（用户显式点击 = 同意推送）。
   */
  const syncAll = async (push: boolean): Promise<{ ok: boolean; text: string }> => {
    const parts: string[] = []
    let ok = true
    // 项目轨（本项目已初始化才参与）
    if (status?.initialized === true) {
      const r = await api<{ ok: boolean; text: string }>('/sync', { method: 'POST', body: JSON.stringify({ sessionId, ...(push ? { push: true } : {}) }) })
      if (!r.ok) ok = false
      parts.push(r.text)
    }
    // 全局轨（全局仓库已初始化且至少一个轨开启才参与）
    const globalTracks = status?.global?.tracks ?? {}
    const anyGlobalOn = Object.values(globalTracks).some((v) => v === true)
    if (status?.global?.initialized === true && anyGlobalOn) {
      const r = await api<{ ok: boolean; text: string }>('/global-sync', { method: 'POST', body: JSON.stringify({ sessionId, ...(push ? { push: true } : {}) }) })
      if (!r.ok) ok = false
      parts.push(r.text)
    }
    if (parts.length === 0) return { ok: false, text: t('syncTab.actions.nothingToSync') }
    return { ok, text: parts.join('；') }
  }

  return (
    <div className="mt-panel">
      {!initialized ? (
        <div className="bb-empty">{t('syncTab.loading')}</div>
      ) : (
        <>
          {/* 未深度测试提示（用户要求，2026-08-11）：本功能体量大、影响大，
              尚未经过用户深度测试——上线初期必须明示慎重使用 */}
          <div className="me-notice me-notice-warn" style={{ marginBottom: '8px' }}>
            {t('syncTab.betaWarning')}
          </div>
          {notice !== null && (
            <div className={notice.kind === 'ok' ? 'me-notice-ok' : 'me-notice-error'}>
              {notice.text}
            </div>
          )}

          {/* ══ 分区一：本项目（2026-08-11 用户拍板布局：顶部介绍 → 本项目 →
              全局 → 记忆远端与同步，自上而下）══ */}
          <div className="bb-settings">
            <div className="bb-settings-title">{t('syncTab.section.project')}</div>
            {/* 项目级同步开关（三层开关第 2 层）：默认关——不启用 = 维持
                未开发本模块前的纯本地状态（不建仓库、不生成身份证）。
                模块开关（第 1 层）在「Memory Evolve 设置 → 配置」里，本 Tab
                不重复（2026-08-11 用户拍板）。关闭本开关即停用本项目同步。 */}
            <label className="me-field">
              <span className="me-field-label">
                {t('syncTab.projectEnabled')}
                <em className="me-field-hint">{t('syncTab.projectEnabled.hint')}</em>
              </span>
              <input
                type="checkbox"
                className="me-switch"
                disabled={status?.enabled !== true}
                checked={status?.projectEnabled === true}
                onChange={(event) => {
                  const target = event.target.checked
                  void run(() => api<{ ok: boolean; text: string }>('/project-enabled', { method: 'POST', body: JSON.stringify({ sessionId, enabled: target }) }))
                }}
              />
            </label>

            {/* 轨级开关（三层开关第 3 层）：项目记忆轨参与同步 */}
            <label className="me-field">
              <span className="me-field-label">
                {t('syncTab.trackProject')}
                <em className="me-field-hint">{t('syncTab.trackProject.hint')}</em>
              </span>
              <input
                type="checkbox"
                className="me-switch"
                disabled={status?.projectEnabled !== true}
                checked={status?.tracks?.project !== false}
                onChange={(event) => {
                  const target = event.target.checked
                  void run(() => api<{ ok: boolean; text: string }>('/track', { method: 'POST', body: JSON.stringify({ sessionId, on: target }) }))
                }}
              />
            </label>
          </div>

          {/* ══ 分区二：全局记忆（不属于本项目，仅共享记忆仓库可用）══ */}
          <div className="bb-settings" style={sectionStyle}>
            <div className="bb-settings-title">{t('syncTab.section.global')}</div>
            {status?.global?.initialized === true ? (
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
                  {t('syncTab.global.uncommitted', { n: String(status.global.uncommitted ?? 0) })}
                  <br />
                  {t('syncTab.global.hint')}
                </p>
              </>
            ) : (
              <p className="bb-settings-desc">{t('syncTab.global.notInit')}</p>
            )}
          </div>

          {/* ══ 分区三：记忆远端与同步（A/B 切换 + 当前状态 + 推拉按钮）══ */}
          <div className="bb-settings" style={sectionStyle}>
            <div className="bb-settings-title">{t('syncTab.section.sync')}</div>

            {/* 当前记忆远端状态（一个仓库——用户拍板：B 模式只显示共享记忆
                仓库，不再显示项目身份/代码仓库地址，避免"两个仓库"困惑） */}
            <div className="bb-settings-desc">
              {status?.enabled !== true ? (
                t('syncTab.status.disabled')
              ) : status?.initialized !== true ? (
                t('syncTab.status.notInit')
              ) : (
                <>
                  <p>
                    <strong>{t('syncTab.status.remoteKind', { kind: status?.remoteKind === 'main-repo' ? t('syncTab.status.remoteKindMain') : status?.remoteKind === 'shared-repo' ? t('syncTab.status.remoteKindShared') : t('syncTab.status.remoteKindNone') })}</strong>
                    <br />
                    {t('syncTab.status.originUrl', { url: status?.originUrl || t('syncTab.status.remoteKindNone') })}
                    <br />
                    {t('syncTab.status.remoteKind.hint')}
                  </p>
                  <p>
                    {t('syncTab.status.branch', { branch: status?.remoteBranch ?? '?' })}
                    <br />
                    {t('syncTab.status.counts', {
                      uncommitted: String(status?.uncommitted ?? 0),
                      behind: String(status?.behind ?? 0),
                      conflicts: String(status?.conflicts ?? 0),
                    })}
                  </p>
                  {status?.migrateFrom != null && (
                    <p>{t('syncTab.status.migrate', { dir: status.migrateFrom })}</p>
                  )}
                </>
              )}
            </div>

            {/* 记忆放哪说明（可折叠） */}
            <details className="bb-settings-desc" style={{ marginTop: '8px' }}>
              <summary style={{ cursor: 'pointer' }}>{t('syncTab.remote.title')}</summary>
              <div style={{ marginTop: '6px' }}>
                <p><strong>{t('syncTab.remote.default.title')}</strong>：{t('syncTab.remote.default.desc')}</p>
                <p><strong>{t('syncTab.remote.shared.title')}</strong>：{t('syncTab.remote.shared.desc')}</p>
              </div>
            </details>

            {/* 地址输入 + 切换/初始化（任何状态都显示；已初始化 = 切换记忆远端） */}
            <div className="bb-actions" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '8px', marginTop: '8px' }}>
              <em className="bb-meta">
                {status?.initialized === true ? t('syncTab.actions.switchShared.hint') : t('syncTab.actions.setupShared.hint')}
              </em>
              <span className="bb-actions-inline" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', width: '100%', minWidth: 0 }}>
                <input
                  type="text"
                  className="me-input"
                  style={{ flex: '1 1 360px', width: 'auto', minWidth: 'min(280px, 100%)' }}
                  placeholder={t('syncTab.actions.setupShared.placeholder')}
                  value={remoteUrl}
                  onChange={(event) => {
                    remoteUrlEdited.current = true
                    setRemoteUrl(event.target.value)
                  }}
                />
                <button
                  type="button"
                  className="me-btn"
                  disabled={busy || remoteUrl.trim() === ''}
                  onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/setup', { method: 'POST', body: JSON.stringify({ sessionId, url: remoteUrl.trim() }) })) }}
                >
                  {status?.initialized === true ? t('syncTab.actions.switchShared') : t('syncTab.actions.setupShared')}
                </button>
              </span>
            </div>

            {/* 统一操作按钮：未初始化 = 开始同步（用代码仓库）；已初始化 =
                一个「同步」+ 一个「同步并推送」，同时驱动项目轨与已开启的全局轨
                （2026-08-11 用户拍板：按钮不重复、只保留一对推拉按钮） */}
            <div className="bb-actions" style={{ marginTop: '10px' }}>
              {status?.initialized !== true ? (
                <button type="button" className="me-btn me-btn-primary" disabled={busy || status?.enabled !== true} onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/setup', { method: 'POST', body: JSON.stringify({ sessionId }) })) }}>
                  {t('syncTab.actions.setupDefault')}
                </button>
              ) : (
                <>
                  <button type="button" className="me-btn me-btn-primary" disabled={busy} onClick={() => { void run(() => syncAll(false)) }}>
                    {t('syncTab.actions.sync')}
                  </button>
                  <button type="button" className="me-btn me-btn-ok" disabled={busy} onClick={() => { void run(() => syncAll(true)) }}>
                    {t('syncTab.actions.push')}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* ── 冲突区 ── */}
          {status?.enabled === true && conflicts.length > 0 && (
            <div className="bb-settings" style={sectionStyle}>
              <div className="bb-settings-title">{t('syncTab.conflicts.title', { count: conflicts.length })}</div>
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

          {/* ── 提示 ── */}
          <p className="bb-empty">{t('syncTab.footnote')}</p>
        </>
      )}
    </div>
  )
}
