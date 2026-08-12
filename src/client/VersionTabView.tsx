/**
 * dsh-memory-evolve — version tab (settings tab sub-entry).
 *
 * 「版本」子 Tab：插件版本检测与手动更新界面（一期）。
 *
 * 数据面：GET /memory-evolve/api/update/status（?force=1 强制重检）与
 * POST /memory-evolve/api/update（{ expectedTag }）。服务端负责全部 git
 * 操作与安全校验（严格 tag 格式 / 24h 惰性缓存 / 原子更新锁 / 目标复核 /
 * dirty 检查 / origin/main 信任校验 / 失败回滚 / 运行-磁盘版本分离），
 * 本组件只做展示与用户交互——**更新结果不存组件 state**（restartRequired
 * 由服务端派生并持久化：badge 重挂/刷新页面后等待重启横幅依然存在，
 * CodeX 复审 P1-6：发布说明也存服务端 lastUpdated.notes，重挂不丢）。
 *
 * 设计要点：
 *   - 检测与更新分离：检查按钮只刷新状态；更新按钮仅在有新版本时出现，
 *     提交用户当前看到的 expectedTag（防 TOCTOU，目标变化服务端回 409）；
 *   - 更新成功后显示发布说明（tag 附注）与「等待重启」横幅（先重启
 *     dsh web，再刷新浏览器）；若随后的状态刷新失败，仍呈现"更新已完成"
 *     而不是当作更新失败（P1-6）；
 *   - 错误统一为 { code, message }，文案走字典（version.error.<code>），
 *     无硬编码中文（CodeX 复审 P2-4）；
 *   - 全部文案走 zh/en 字典键，无硬编码中文。
 */
import { useEffect, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** Locale-bound props（memory-evolve 命名空间）。 */
export interface VersionTabViewProps {
  t: Translate
}

/** SettingsTabView 引用用（同 VersionTabViewProps，兼容名）。 */
export type VersionTabTabProps = VersionTabViewProps

/** 服务端状态对象（/api/update/status 的 DTO 白名单，字段对齐 lib/update.js）。 */
interface UpdateState {
  ok?: boolean
  status?: string // latest | outdated | no-release | unsupported | unknown
  latestTag?: string | null
  localTag?: string | null
  noteCode?: string
  lastAttemptAt?: number | null
  lastSuccessAt?: number | null
  lastError?: { kind?: string; message?: string } | null
  restartRequired?: boolean
  lastUpdated?: { tag?: string; at?: number; notes?: string } | null
}

/** 更新接口返回（POST /api/update）。 */
interface UpdateOutcome {
  ok: boolean
  code?: string
  error?: string
  tag?: string
  releaseNotes?: string
  restartRequired?: boolean
}

/** 统一错误对象（code → 字典文案；message 兜底展示）。 */
interface ViewError {
  code: string
  message: string
}

/** 刷新当前状态（force 走「检查更新」语义）。 */
async function fetchStatus(force: boolean): Promise<UpdateState> {
  const res = await fetch(`/memory-evolve/api/update/status${force ? '?force=1' : ''}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as UpdateState
}

/** 毫秒时间戳 → 本地短时间（不显示秒级；展示用）。 */
function formatTime(ms?: number | null): string {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '—'
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The conversation view version tab component. */
export function VersionTabView(props: VersionTabTabProps): JSX.Element {
  const { t } = props

  /** 状态数据（null=首次加载中——期间禁用操作按钮）。 */
  const [state, setState] = useState<UpdateState | null>(null)
  /** 最近一次成功更新的发布说明（tag 附注，服务端截断 500 字符）。 */
  const [releaseNotes, setReleaseNotes] = useState<string>('')
  /** 「检查更新」进行中。 */
  const [checking, setChecking] = useState(false)
  /** 「立即更新」进行中。 */
  const [updating, setUpdating] = useState(false)
  /** 统一错误对象（code 驱动字典文案；网络异常用 'network'）。 */
  const [error, setError] = useState<ViewError | null>(null)

  /** 拉取状态并落屏（可选 force）。 */
  const refresh = (force: boolean): void => {
    setError(null)
    if (force) setChecking(true)
    fetchStatus(force)
      .then((data) => {
        setState(data)
        // 状态变化（红点 0/1）广播给宿主层：index.ts 的 badge 监听会同步
        // 各 Tab 红点（设置 Tab 的 🔴 由此出现/消失）。
        window.dispatchEvent(new CustomEvent('dsh-memory-evolve:badge-change'))
      })
      .catch((err: unknown) => setError({ code: 'network', message: err instanceof Error ? err.message : 'network error' }))
      .finally(() => setChecking(false))
  }

  /** 挂载即触发一次惰性检测（24h 缓存内不跑 git；force 留给按钮）。 */
  useEffect(() => { refresh(false) }, [])

  /** 执行更新（提交当前看到的 expectedTag，防目标变化竞态）。 */
  const doUpdate = (): void => {
    if (updating || !state?.latestTag) return
    setUpdating(true)
    setError(null)
    void fetch('/memory-evolve/api/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedTag: state.latestTag }),
    })
      .then(async (res) => {
        const outcome = (await res.json()) as UpdateOutcome
        if (!res.ok || !outcome.ok) {
          setError({ code: outcome.code ?? 'unknown', message: outcome.error ?? '' })
          return
        }
        // 成功：先落屏发布说明与"等待重启"（即使随后的状态刷新失败也
        // 不能显示成更新失败——P1-6）。
        setReleaseNotes(outcome.releaseNotes ?? '')
        setState({ ...(state ?? {}), restartRequired: true })
        try {
          const data = await fetchStatus(false)
          setState(data)
        } catch {
          /* 状态刷新失败：保持"更新已完成"呈现，不覆盖为错误 */
        }
        setError(null)
        window.dispatchEvent(new CustomEvent('dsh-memory-evolve:badge-change'))
      })
      .catch((err: unknown) => setError({ code: 'network', message: err instanceof Error ? err.message : 'network error' }))
      .finally(() => setUpdating(false))
  }

  const busy = checking || updating || state === null

  // 状态说明（noteCode → 字典文案；兜底不显示）。
  const noteText = state?.noteCode ? t(`version.note.${state.noteCode}`) : ''

  return (
    <div className="me-panel">
      {/* —— 等待重启横幅：服务端派生状态驱动，重挂/刷新后依然显示 —— */}
      {state?.restartRequired === true && (
        <div className="me-notice me-notice-warn" role="alert">
          <strong>{t('version.restart.title')}</strong>：{t('version.restart.hint')}
        </div>
      )}

      {/* —— 版本状态卡 —— */}
      <div className="me-block">
        <div className="me-group">
          <div className="me-field">
            <span className="me-field-label">{t('version.current')}</span>
            <span className="me-field-value">{state?.localTag ?? '—'}</span>
          </div>
          <div className="me-field">
            <span className="me-field-label">{t('version.latest')}</span>
            <span className="me-field-value">{state?.latestTag ?? '—'}</span>
          </div>
          <div className="me-field">
            <span className="me-field-label">{t('version.statusLabel')}</span>
            <span className="me-field-value">
              {state === null
                ? t('version.loading')
                : t(`version.status.${state.status ?? 'unknown'}`)}
            </span>
          </div>
          {noteText !== '' && <p className="me-help">{noteText}</p>}
          {/* 上次检测失败信息（stale 附加展示，不覆盖最后成功状态） */}
          {state?.lastError && (
            <p className="me-help">
              {t('version.lastError')}：{state.lastError.message ?? state.lastError.kind ?? '—'}
            </p>
          )}
          <p className="me-help">
            {t('version.checkTime')}：{formatTime(state?.lastSuccessAt ?? state?.lastAttemptAt)}
          </p>
        </div>
      </div>

      {/* —— 操作区：检测与更新分离，更新按钮只在有新版本时出现 —— */}
      <div className="me-block">
        <button type="button" className="me-btn" disabled={busy} onClick={() => refresh(true)}>
          {checking ? t('version.checking') : t('version.checkNow')}
        </button>
        {state?.status === 'outdated' && state.latestTag && (
          <button type="button" className="me-btn me-btn-primary" disabled={busy} onClick={doUpdate}>
            {updating ? t('version.updating') : t('version.updateNow', { tag: state.latestTag })}
          </button>
        )}
        {error && (
          <p className="me-notice me-notice-error" role="alert">
            {t(`version.error.${error.code}`, { message: error.message })}
          </p>
        )}
      </div>

      {/* —— 更新结果（最近一次成功更新的发布说明，tag 附注） —— */}
      {(releaseNotes !== '' || state?.lastUpdated?.notes) && (
        <div className="me-block">
          <div className="me-group">
            <div className="me-field">
              <span className="me-field-label">{t('version.releaseNotes')}</span>
              <span className="me-field-value me-notes-pre">{state?.lastUpdated?.notes ?? releaseNotes}</span>
            </div>
          </div>
        </div>
      )}

      {/* —— 不支持自动检测时的安装引导 —— */}
      {state?.status === 'unsupported' && (
        <div className="me-block">
          <p className="me-help">{t('version.unsupported.hint')}</p>
        </div>
      )}
    </div>
  )
}
