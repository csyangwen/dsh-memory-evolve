/**
 * dsh-memory-evolve — 记忆同步 Tab（conversation.view entry，跟随 syncEnabled）。
 *
 * 把 /memory_sync 命令组的全部能力 UI 化（2026-08-11 用户拍板：本模块其他
 * 功能都少用指令了，同步也应有独立 Tab）：
 *   - 状态卡片：项目身份 / 远端分支 / 未提交 / 落后 / 冲突数 / 迁移提示
 *   - 操作：启用开关、开始同步（用代码仓库一键 / 填共享记忆仓库地址）、
 *     同步、同步并推送（**点击即用户显式同意推送**，需求 #12）、停用
 *   - 冲突列表：每条三版本摘要 + 采用本机 / 采用远端 / 两者都要
 *   - 结果反馈 notice（成功/失败如实呈现）
 *
 * 数据源：/memory-evolve/memory-sync/*（host API；与命令组同一套逻辑）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

const API = '/memory-evolve/memory-sync'

/** 同步状态（/status 返回）。 */
interface SyncStatus {
  enabled: boolean
  initialized: boolean
  /** 项目级同步开关（三层开关第 2 层）：PROVENANCE.enabled !== false。 */
  projectEnabled?: boolean
  /** 轨级开关（第 3 层）：一期唯一轨=项目记忆。 */
  tracks?: { project?: boolean }
  uncommitted?: number
  behind?: number
  conflicts?: number
  remoteBranch?: string
  /** 记忆远端类型（统一模式）：main-repo=主代码仓库（默认）；shared-repo=共享记忆仓库。 */
  remoteKind?: 'main-repo' | 'shared-repo'
  identity?: { displayName: string; kind: string; remoteUrl?: string }
  migrateFrom?: string | null
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
  // 共享记忆仓库地址输入（可选；留空 = 用主代码仓库）
  const [remoteUrl, setRemoteUrl] = useState('')
  const [initialized, setInitialized] = useState(false) // status 首次加载完成标记

  /** 拉取状态 + 冲突列表。 */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [s, c] = await Promise.all([
        api<{ status?: SyncStatus } | SyncStatus>(`/status?sessionId=${encodeURIComponent(sessionId)}`),
        api<{ conflicts: ConflictItem[] }>(`/conflicts?sessionId=${encodeURIComponent(sessionId)}`),
      ])
      setStatus('status' in s && s.status !== undefined ? s.status : (s as SyncStatus))
      setConflicts(c.conflicts ?? [])
    } catch (error) {
      setNotice({ kind: 'error', text: t('syncTab.loadFailed', { message: (error as Error).message }) })
    } finally {
      setInitialized(true)
    }
  }, [sessionId, t])

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

          {/* ── 项目级同步开关（三层开关第 2 层）：默认关——不启用 = 维持
              未开发本模块前的纯本地状态（不建仓库、不生成身份证）。
              模块开关（第 1 层）在「Memory Evolve 设置 → 配置」里，本 Tab
              不重复（2026-08-11 用户拍板）── */}
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

          {/* ── 轨级开关（三层开关第 3 层）：项目记忆轨参与同步（一期唯一轨；
              全局轨 memory/user/daily 二期独立开关）── */}
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

          {/* ── 状态卡片 ── */}
          <div className="bb-settings">
            <div className="bb-settings-title">{t('syncTab.status.title')}</div>
            {status?.enabled !== true ? (
              <p className="bb-settings-desc">{t('syncTab.status.disabled')}</p>
            ) : status?.initialized !== true ? (
              <p className="bb-settings-desc">{t('syncTab.status.notInit')}</p>
            ) : (
              <>
                <p className="bb-settings-desc">
                  {t('syncTab.status.identity', { name: status?.identity?.displayName ?? '?', kind: status?.identity?.kind === 'remote' ? t('syncTab.status.remote') : t('syncTab.status.local') })}
                  <br />
                  {/* 记忆远端：主代码仓库（默认）或共享记忆仓库（用户指定） */}
                  {t('syncTab.status.remoteKind', { kind: status?.remoteKind === 'main-repo' ? t('syncTab.status.remoteKindMain') : status?.remoteKind === 'shared-repo' ? t('syncTab.status.remoteKindShared') : t('syncTab.status.remoteKindNone') })}
                  <br />
                  {t('syncTab.status.branch', { branch: status?.remoteBranch ?? '?' })}
                  <br />
                  {t('syncTab.status.counts', {
                    uncommitted: String(status?.uncommitted ?? 0),
                    behind: String(status?.behind ?? 0),
                    conflicts: String(status?.conflicts ?? 0),
                  })}
                </p>
                {status?.migrateFrom != null && (
                  <p className="bb-settings-desc">{t('syncTab.status.migrate', { dir: status.migrateFrom })}</p>
                )}
              </>
            )}
          </div>

          {/* ── 操作区（未启用时隐藏——先开开关）── */}
          {status?.enabled === true && (
            <div className="bb-settings">
              <div className="bb-settings-title">{t('syncTab.actions.title')}</div>
              {/* 记忆放哪说明（可折叠，2026-08-11 用户拍板：统一单一模式——
                  一个记忆远端配置 + 每项目专属分支；隐私是主要区别） */}
              <details className="bb-settings-desc">
                <summary style={{ cursor: 'pointer' }}>{t('syncTab.remote.title')}</summary>
                <div style={{ marginTop: '6px' }}>
                  <p><strong>{t('syncTab.remote.default.title')}</strong>：{t('syncTab.remote.default.desc')}</p>
                  <p><strong>{t('syncTab.remote.shared.title')}</strong>：{t('syncTab.remote.shared.desc')}</p>
                </div>
              </details>
              <div className="bb-actions">
                {status?.initialized !== true && (
                  <>
                    {/* 默认：记忆远端 = 主代码仓库（零配置） */}
                    <button type="button" className="me-btn me-btn-primary" disabled={busy} onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/setup', { method: 'POST', body: JSON.stringify({ sessionId }) })) }}>
                      {t('syncTab.actions.setupDefault')}
                    </button>
                    {/* 可选：填共享记忆仓库地址（一个仓库装所有项目的记忆） */}
                    <span className="bb-actions-inline">
                      <em className="bb-meta">{t('syncTab.actions.setupShared.hint')}</em>
                      <input
                        type="text"
                        className="me-input"
                        placeholder={t('syncTab.actions.setupShared.placeholder')}
                        value={remoteUrl}
                        onChange={(event) => setRemoteUrl(event.target.value)}
                      />
                      <button
                        type="button"
                        className="me-btn"
                        disabled={busy || remoteUrl.trim() === ''}
                        onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/setup', { method: 'POST', body: JSON.stringify({ sessionId, url: remoteUrl.trim() }) })) }}
                      >
                        {t('syncTab.actions.setupShared')}
                      </button>
                    </span>
                  </>
                )}
                {status?.initialized === true && (
                  <>
                    <button type="button" className="me-btn me-btn-primary" disabled={busy} onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/sync', { method: 'POST', body: JSON.stringify({ sessionId }) })) }}>
                      {t('syncTab.actions.sync')}
                    </button>
                    <button type="button" className="me-btn me-btn-ok" disabled={busy} onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/sync', { method: 'POST', body: JSON.stringify({ sessionId, push: true }) })) }}>
                      {t('syncTab.actions.push')}
                    </button>
                  </>
                )}
                <button type="button" className="me-btn me-btn-danger" disabled={busy} onClick={() => { void run(() => api<{ ok: boolean; text: string }>('/off', { method: 'POST', body: JSON.stringify({ sessionId }) })) }}>
                  {t('syncTab.actions.off')}
                </button>
              </div>
            </div>
          )}

          {/* ── 冲突区 ── */}
          {status?.enabled === true && conflicts.length > 0 && (
            <div className="bb-settings">
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
