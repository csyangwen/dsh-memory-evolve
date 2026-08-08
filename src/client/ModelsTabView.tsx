/**
 * dsh-memory-evolve — 模型配置 tab（conversation.view entry）。
 *
 * 「模型配置」Tab：以表格形式展示 DSH 现有供应商与模型（只读聚合——
 * 供应商目录 + settings 模型目录 + adapter 思考等级），并支持给每个模型
 * 设置（写插件自有 models.json，不碰 DSH 配置）：
 *   1) 启用/禁用（插件口径的可用性标记）；
 *   2) 备注（行内编辑，失焦保存）；
 *   3) 可用思考等级：勾选哪些等级可用（白名单）、推荐等级展示（adapter
 *      defaultEffort）、可添加/移除自定义等级。
 *
 * 数据流：GET  /memory-evolve/api/models          → 聚合快照（含插件配置）
 *          POST /memory-evolve/api/models/update   { provider, model, patch }
 * 样式复用 mt- 前缀（styles.css：mt-panel / mt-toolbar / mt-search /
 * mt-btn / mt-muted / mt-notice*）；表格专用样式为 mt-models-*（同文件
 * 追加，token 风格与现有类一致——不自建样式体系）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { TabGuideView, type GuideSection } from './TabGuideView.tsx'

/** Locale-bound props（locate namespace：memory-evolve）。 */
export interface ModelsTabViewProps {
  t: Translate
}

/** 一个思考等级（含是否用户自定义）。 */
interface ReasoningLevel {
  id: string
  name: string
  enabled: boolean
  custom: boolean
}

/** 一个模型的思考等级信息（null = adapter 无等级且无自定义）。 */
interface ModelReasoning {
  recommended?: string
  /** 用户手动覆盖的推荐等级（undefined = 跟随模型自动推荐）。 */
  recommendedOverride?: string
  levels: ReasoningLevel[]
}

/** 一行模型（与 host /api/models 快照字段一致）。 */
interface ModelRow {
  id: string
  name: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  enabled: boolean
  /** 是否支持思考（插件开关，默认 true）。 */
  thinking: boolean
  note: string
  configured: boolean
  reasoning: ModelReasoning | null
  whitelistConfigured?: boolean
}

/** 一个供应商分组。 */
interface ProviderGroup {
  provider: string
  providerDisplay: string
  active: boolean
  settingsNs: string
  providerDefaultReasoning?: string
  models: ModelRow[]
}

/** 聚合快照。 */
interface Snapshot {
  providers: ProviderGroup[]
  total: number
  enabledTotal: number
}

/** 展开编辑的模型 key（provider\u0000model）。 */
const keyOf = (provider: string, model: string): string => `${provider}\u0000${model}`

/** 容量格式化（K/M 后缀，风格与官方 Models 页一致）。 */
function capacityText(value: number | undefined): string {
  if (value === undefined) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}K`
  return String(value)
}

/** 保存中的模型 key 集合。 */
type SavingSet = ReadonlySet<string>

/** 模型配置 Tab 的两个子功能：模型配置（表格）/ 指南。 */
type ModelsFeature = 'models' | 'guide'

/** 跨重挂持久化的子 tab 选择（模块级：快照刷新导致组件重挂后恢复）。 */
let persistedModelsFeature: ModelsFeature | null = null

/** 模型配置 Tab 专属指南内容（「指南」子 Tab）。 */
function modelsGuideSections(t: Translate): GuideSection[] {
  return [
    {
      icon: '🧭',
      title: t('modelsTab.guide.what.title'),
      body: t('modelsTab.guide.what.body'),
      items: [
        t('modelsTab.guide.what.item1'),
        t('modelsTab.guide.what.item2'),
        t('modelsTab.guide.what.item3'),
      ],
    },
    {
      icon: '⚙️',
      title: t('modelsTab.guide.config.title'),
      body: t('modelsTab.guide.config.body'),
      items: [
        t('modelsTab.guide.config.item1'),
        t('modelsTab.guide.config.item2'),
        t('modelsTab.guide.config.item3'),
        t('modelsTab.guide.config.item4'),
      ],
    },
    {
      icon: '🤖',
      title: t('modelsTab.guide.tool.title'),
      body: t('modelsTab.guide.tool.body'),
      items: [
        t('modelsTab.guide.tool.item1'),
        t('modelsTab.guide.tool.item2'),
      ],
    },
    {
      icon: '🔌',
      title: t('modelsTab.guide.switch.title'),
      body: t('modelsTab.guide.switch.body'),
    },
  ]
}

/**
 * 模型配置表格组件。
 * @param props - 会话上下文 + locale。
 */
export function ModelsTabView(props: ConvViewProps & ModelsTabViewProps): JSX.Element {
  const { t } = props
  /** 当前激活的子 tab（缺省=模型配置表格，指南为附加说明）。 */
  const [feature, setFeature] = useState<ModelsFeature>(persistedModelsFeature ?? 'models')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [showReasoning, setShowReasoning] = useState(true)
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState<SavingSet>(new Set())

  // 同步子 tab 选择到模块级：组件重挂后恢复。
  useEffect(() => { persistedModelsFeature = feature }, [feature])

  /** 拉取聚合快照。 */
  const load = useCallback((): void => {
    setLoading(true)
    setError(undefined)
    void fetch('/memory-evolve/api/models')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: Snapshot) => { setSnapshot(data) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { setLoading(false) })
  }, [])

  useEffect(() => { load() }, [load])

  /** 提交一个模型的配置更新；成功后在本地快照上应用（不整表重拉，避免
   *  打断其他行正在输入的草稿）。 */
  const update = useCallback(async (provider: string, model: string, patch: object): Promise<boolean> => {
    const key = keyOf(provider, model)
    setSaving((current) => new Set(current).add(key))
    try {
      const res = await fetch('/memory-evolve/api/models/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, model, patch }),
      })
      const data = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${res.status}`)
      return true
    } finally {
      setSaving((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }, [])

  /** 本地应用一行更新（改快照 + 重算 enabledTotal）。 */
  const applyLocal = useCallback((provider: string, model: string, mutate: (row: ModelRow) => void): void => {
    setSnapshot((current) => {
      if (current === null) return current
      const providers = current.providers.map((g) => {
        if (g.provider !== provider) return g
        return { ...g, models: g.models.map((m) => {
          if (m.id !== model) return m
          const next = { ...m }
          mutate(next)
          return next
        }) }
      })
      let enabledTotal = 0
      for (const g of providers) {
        for (const m of g.models) {
          if (m.enabled) enabledTotal += 1
        }
      }
      return { providers, total: current.total, enabledTotal }
    })
  }, [])

  /** 切换启用/禁用。 */
  const toggleEnabled = useCallback((provider: string, model: string): void => {
    const target = findRow(snapshot, provider, model)
    if (target === null) return
    void update(provider, model, { enabled: !target.enabled }).then((ok) => {
      if (ok) applyLocal(provider, model, (row) => { row.enabled = !row.enabled })
    })
  }, [snapshot, update, applyLocal])

  /** 备注失焦保存。 */
  const saveNote = useCallback((provider: string, model: string, note: string): void => {
    void update(provider, model, { note }).then((ok) => {
      if (ok) applyLocal(provider, model, (row) => { row.note = note })
    })
  }, [update, applyLocal])

  /** 保存思考配置：是否支持思考 + 推荐等级（''=自动）+ 等级白名单 + 自定义列表。 */
  const saveReasoning = useCallback((
    provider: string,
    model: string,
    thinking: boolean,
    recommended: string,
    enabledIds: string[],
    custom: { id: string; name: string }[],
  ): void => {
    const row = findRow(snapshot, provider, model)
    if (row === null || row.reasoning === null) return
    // 全选 = 未配置（null），与默认语义一致（adapter 等级全部可用）。
    const allIds = row.reasoning.levels.map((l) => l.id)
    const enabled = enabledIds.length === allIds.length && allIds.every((id) => enabledIds.includes(id))
      ? null
      : enabledIds
    void update(provider, model, {
      thinking,
      reasoning: {
        enabled,
        // '' = 跟随模型自动推荐（null 清除覆盖）。
        recommended: recommended === '' ? null : recommended,
        custom,
      },
    }).then((ok) => {
      if (ok) {
        setExpanded(undefined)
        applyLocal(provider, model, (r) => {
          const reasoning = r.reasoning
          if (reasoning === null) return
          r.thinking = thinking
          reasoning.recommendedOverride = recommended === '' ? undefined : recommended
          // 手动覆盖优先；自动 = 保持 adapter 默认（本地快照已含）。
          if (recommended !== '') reasoning.recommended = recommended
          const enabledSet = new Set(enabledIds)
          const customById = new Map(custom.map((c) => [c.id, c]))
          reasoning.levels = [
            ...reasoning.levels.map((l) => {
              const c = customById.get(l.id)
              return c !== undefined
                ? { id: l.id, name: c.name, custom: true, enabled: enabledSet.has(l.id) }
                : { id: l.id, name: l.name, custom: false, enabled: enabledSet.has(l.id) }
            }),
            // 新添加的自定义等级（不在 adapter 等级里）追加到末尾。
            ...custom.filter((c) => !reasoning.levels.some((l) => l.id === c.id))
              .map((c) => ({ id: c.id, name: c.name, custom: true, enabled: enabledSet.has(c.id) })),
          ]
        })
      }
    })
  }, [snapshot, update, applyLocal])

  /** 搜索过滤后的行（供应商 | 模型）。 */
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out: { group: ProviderGroup; row: ModelRow }[] = []
    for (const group of snapshot?.providers ?? []) {
      for (const row of group.models) {
        if (q !== '' && !(group.providerDisplay.toLowerCase().includes(q)
          || group.provider.toLowerCase().includes(q)
          || row.name.toLowerCase().includes(q)
          || row.id.toLowerCase().includes(q)
          || row.note.toLowerCase().includes(q))) continue
        out.push({ group, row })
      }
    }
    return out
  }, [snapshot, query])

  return (
    <div className="mt-panel">
      {/* 子 tab 条：模型配置（表格）/ 指南 */}
      <div className="mt-file-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'models'}
          className={feature === 'models' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature('models')}
        >
          {t('modelsTab.feature.models')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'guide'}
          className={feature === 'guide' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature('guide')}
        >
          {t('modelsTab.feature.guide')}
        </button>
      </div>
      {feature === 'guide'
        ? <TabGuideView sections={modelsGuideSections(t)} />
        : (
          <>
            <div className="mt-toolbar">
        <input
          className="mt-search"
          type="search"
          placeholder={t('modelsTab.searchPh')}
          value={query}
          onChange={(event) => { setQuery(event.target.value) }}
          aria-label={t('modelsTab.searchPh')}
        />
        <label className="mt-models-toggle-label">
          <input
            type="checkbox"
            checked={showReasoning}
            onChange={(event) => { setShowReasoning(event.target.checked) }}
          />
          <span>{t('modelsTab.showReasoning')}</span>
        </label>
        <button type="button" className="mt-btn" disabled={loading} onClick={load}>
          {loading ? t('modelsTab.loading') : t('modelsTab.refresh')}
        </button>
        {snapshot !== null
          ? <span className="mt-muted">{t('modelsTab.count', { total: snapshot.total, enabled: snapshot.enabledTotal })}</span>
          : null}
      </div>
      {error !== undefined ? <div className="mt-notice mt-notice-error">{t('modelsTab.loadFailed', { message: error })}</div> : null}
      {snapshot !== null && rows.length === 0
        ? <p className="mt-muted">{t('modelsTab.empty')}</p>
        : null}
      <div className="mt-models-scroll">
        <table className="mt-models-table">
          <thead>
            <tr>
              <th className="mt-models-cell mt-models-col-enable">{t('modelsTab.enabled')}</th>
              <th className="mt-models-cell">{t('modelsTab.provider')}</th>
              <th className="mt-models-cell">{t('modelsTab.model')}</th>
              <th className="mt-models-cell mt-models-col-capacity">{t('modelsTab.capacity')}</th>
              {showReasoning ? <th className="mt-models-cell mt-models-col-reasoning">{t('modelsTab.reasoning')}</th> : null}
              <th className="mt-models-cell">{t('modelsTab.note')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ group, row }) => (
              <RowView
                key={keyOf(group.provider, row.id)}
                t={t}
                group={group}
                row={row}
                showReasoning={showReasoning}
                expanded={expanded === keyOf(group.provider, row.id)}
                saving={saving.has(keyOf(group.provider, row.id))}
                onToggle={() => { toggleEnabled(group.provider, row.id) }}
                onExpand={() => {
                  setExpanded(expanded === keyOf(group.provider, row.id)
                    ? undefined
                    : keyOf(group.provider, row.id))
                }}
                onSaveNote={(note) => { saveNote(group.provider, row.id, note) }}
                onSaveReasoning={(thinking, recommended, enabledIds, custom) => {
                  saveReasoning(group.provider, row.id, thinking, recommended, enabledIds, custom)
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
          </>
        )}
    </div>
  )
}

/** 在快照中找一行（toggle 前取当前 enabled 值用）。 */
function findRow(snapshot: Snapshot | null, provider: string, model: string): ModelRow | null {
  for (const group of snapshot?.providers ?? []) {
    if (group.provider !== provider) continue
    const row = group.models.find((m) => m.id === model)
    return row ?? null
  }
  return null
}

/** 一行（含展开的思考等级编辑器）。 */
function RowView(props: {
  t: Translate
  group: ProviderGroup
  row: ModelRow
  showReasoning: boolean
  expanded: boolean
  saving: boolean
  onToggle: () => void
  onExpand: () => void
  onSaveNote: (note: string) => void
  onSaveReasoning: (thinking: boolean, recommended: string, enabledIds: string[], custom: { id: string; name: string }[]) => void
}): JSX.Element {
  const { t, group, row, showReasoning, expanded, saving, onToggle, onExpand, onSaveNote, onSaveReasoning } = props
  // 备注草稿（失焦才提交；展开/刷新不影响输入）。
  const [noteDraft, setNoteDraft] = useState(row.note)
  // 思考等级编辑草稿：是否支持思考 + 推荐等级（''=自动）+ 勾选集合 + 自定义列表
  // （打开时从行数据初始化）。
  const [thinkingDraft, setThinkingDraft] = useState(row.thinking)
  const [recommendedDraft, setRecommendedDraft] = useState(row.reasoning?.recommendedOverride ?? '')
  const [levelDraft, setLevelDraft] = useState<ReadonlySet<string>>(
    () => new Set((row.reasoning?.levels ?? []).filter((l) => l.enabled).map((l) => l.id)),
  )
  const [customDraft, setCustomDraft] = useState<{ id: string; name: string }[]>(
    () => (row.reasoning?.levels ?? []).filter((l) => l.custom).map((l) => ({ id: l.id, name: l.name })),
  )
  // 新增自定义等级输入。
  const [newId, setNewId] = useState('')
  const [newName, setNewName] = useState('')

  // 行数据刷新后同步草稿（仅当行 key 未变且草稿未被用户编辑——简单策略：
  // 快照变化时若展开中则不覆盖草稿，关闭编辑器时提交）。
  useEffect(() => { setNoteDraft(row.note) }, [row.note])

  const levels = row.reasoning?.levels ?? []
  const recommended = row.reasoning?.recommended
  const usable = levels.filter((l) => l.enabled)

  /** 切换「支持思考」：关闭时非 off 等级自动取消勾选（off = 不思考仍可用）。 */
  const toggleThinking = (next: boolean): void => {
    setThinkingDraft(next)
    if (!next) {
      setLevelDraft((current) => {
        const filtered = new Set<string>()
        for (const id of current) {
          const level = levels.find((l) => l.id === id)
          if (level !== undefined && level.id === 'off') filtered.add(id)
        }
        return filtered
      })
    }
  }

  return (
    <tr className={row.enabled ? 'mt-models-row' : 'mt-models-row mt-models-row-muted'}>
      <td className="mt-models-cell mt-models-col-enable">
        <input
          type="checkbox"
          checked={row.enabled}
          disabled={saving}
          onChange={onToggle}
          aria-label={row.enabled ? t('modelsTab.disable') : t('modelsTab.enable')}
        />
      </td>
      <td className="mt-models-cell">
        <span className="mt-models-provider">{group.providerDisplay}</span>
        {!group.active
          ? <span className="mt-models-tag mt-models-tag-dormant">{t('modelsTab.dormant')}</span>
          : null}
      </td>
      <td className="mt-models-cell">
        <div className="mt-models-model">
          <span className="mt-models-model-name">{row.name}</span>
          <span className="mt-models-model-id">{row.id}</span>
        </div>
      </td>
      <td className="mt-models-cell mt-models-col-capacity">
        <span className="mt-models-capacity">
          {capacityText(row.contextWindow)} / {capacityText(row.maxTokens)}
        </span>
      </td>
      {showReasoning
        ? (
          <td className="mt-models-cell mt-models-col-reasoning">
            {!row.thinking
              ? <span className="mt-models-tag mt-models-tag-off">{t('modelsTab.thinkingOff')}</span>
              : levels.length === 0
                ? <span className="mt-models-muted-cell">—</span>
                : (
                  <>
                    <div className="mt-models-levels">
                      {usable.length === 0
                        ? <span className="mt-models-level-none">{t('modelsTab.levelsNone')}</span>
                        : usable.slice(0, 4).map((l) => (
                          <span
                            key={l.id}
                            className={l.id === recommended ? 'mt-models-tag mt-models-tag-rec' : 'mt-models-tag'}
                          >
                            {l.name}
                          </span>
                        ))}
                      {usable.length > 4 ? <span className="mt-models-level-more">+{usable.length - 4}</span> : null}
                    </div>
                    <button type="button" className="mt-models-link" onClick={onExpand} aria-expanded={expanded}>
                      {expanded ? t('modelsTab.closeEditor') : t('modelsTab.editLevels')}
                    </button>
                  </>
                )}
          </td>
        )
        : null}
      <td className="mt-models-cell">
        <input
          className="mt-models-note"
          type="text"
          value={noteDraft}
          placeholder={t('modelsTab.notePh')}
          disabled={saving}
          aria-label={t('modelsTab.note')}
          onChange={(event) => { setNoteDraft(event.target.value) }}
          onBlur={() => { if (noteDraft !== row.note) onSaveNote(noteDraft) }}
        />
      </td>
      {expanded && levels.length > 0
        ? (
          <td className="mt-models-expanded" colSpan={showReasoning ? 6 : 5}>
            <div className="mt-models-editor">
              <div className="mt-models-editor-title">{t('modelsTab.editorTitle')}</div>
              {/* 是否支持思考（关闭后仅 off 可用）。 */}
              <label className="mt-models-editor-level">
                <input
                  type="checkbox"
                  checked={thinkingDraft}
                  disabled={saving}
                  onChange={(event) => { toggleThinking(event.target.checked) }}
                />
                <span className="mt-models-editor-level-name">{t('modelsTab.thinking')}</span>
                <span className="mt-models-editor-hint">{t('modelsTab.thinkingHint')}</span>
              </label>
              {/* 推荐等级：手动选择（默认自动 = 跟随模型推荐）。 */}
              <label className="mt-models-editor-level">
                <span className="mt-models-editor-label">{t('modelsTab.recommendedLevel')}</span>
                <select
                  className="mt-models-select"
                  value={thinkingDraft ? recommendedDraft : ''}
                  disabled={saving || !thinkingDraft || usable.length === 0}
                  onChange={(event) => { setRecommendedDraft(event.target.value) }}
                >
                  <option value="">{t('modelsTab.recommendedAuto')}</option>
                  {levels.filter((l) => l.enabled).map((l) => (
                    <option key={l.id} value={l.id}>{l.name} ({l.id})</option>
                  ))}
                </select>
              </label>
              <div className="mt-models-editor-levels">
                {levels.map((l) => (
                  <label key={l.id} className="mt-models-editor-level">
                    <input
                      type="checkbox"
                      checked={levelDraft.has(l.id)}
                      disabled={saving || (!thinkingDraft && l.id !== 'off')}
                      onChange={() => {
                        setLevelDraft((current) => {
                          const next = new Set(current)
                          if (!next.delete(l.id)) next.add(l.id)
                          return next
                        })
                      }}
                    />
                    <span className="mt-models-editor-level-name">{l.name}</span>
                    <span className="mt-models-editor-level-id">{l.id}</span>
                    {l.id === recommended && thinkingDraft
                      ? <span className="mt-models-tag mt-models-tag-rec">{t('modelsTab.recommended')}</span>
                      : null}
                    {l.custom
                      ? (
                        <button
                          type="button"
                          className="mt-models-link mt-models-link-danger"
                          disabled={saving}
                          onClick={() => {
                            setCustomDraft((current) => current.filter((c) => c.id !== l.id))
                            setLevelDraft((current) => {
                              const next = new Set(current)
                              next.delete(l.id)
                              return next
                            })
                          }}
                        >
                          {t('modelsTab.removeLevel')}
                        </button>
                      )
                      : null}
                  </label>
                ))}
              </div>
              <div className="mt-models-editor-add">
                <input
                  className="mt-search"
                  type="text"
                  value={newId}
                  placeholder={t('modelsTab.levelIdPh')}
                  aria-label={t('modelsTab.levelIdPh')}
                  disabled={saving}
                  onChange={(event) => { setNewId(event.target.value.trim()) }}
                />
                <input
                  className="mt-search"
                  type="text"
                  value={newName}
                  placeholder={t('modelsTab.levelNamePh')}
                  aria-label={t('modelsTab.levelNamePh')}
                  disabled={saving}
                  onChange={(event) => { setNewName(event.target.value) }}
                />
                <button
                  type="button"
                  className="mt-btn"
                  disabled={saving || newId === '' || !/^[A-Za-z0-9._-]{1,32}$/.test(newId)}
                  onClick={() => {
                    setCustomDraft((current) => {
                      if (current.some((c) => c.id === newId)) return current
                      return [...current, { id: newId, name: newName === '' ? newId : newName }]
                    })
                    setLevelDraft((current) => new Set(current).add(newId))
                    setNewId('')
                    setNewName('')
                  }}
                >
                  {t('modelsTab.addLevel')}
                </button>
              </div>
              <div className="mt-models-editor-actions">
                <button
                  type="button"
                  className="mt-btn"
                  disabled={saving}
                  onClick={() => { onSaveReasoning(thinkingDraft, recommendedDraft, [...levelDraft], customDraft) }}
                >
                  {saving ? t('modelsTab.saving') : t('modelsTab.save')}
                </button>
                <button type="button" className="mt-btn" disabled={saving} onClick={onExpand}>
                  {t('modelsTab.cancel')}
                </button>
              </div>
            </div>
          </td>
        )
        : null}
    </tr>
  )
}
