/**
 * dsh-memory-evolve — host-side i18n runtime (English support, 2026-08-25).
 *
 * One source of truth for which language the HOST side (model-facing tool
 * descriptions, injected snapshot duties, feedback lines, tool result
 * messages) speaks:
 *
 *   resolveLocale():
 *     1. DSH Settings → General → Language preference (namespace 'locale',
 *        field 'preference') when the user picked one explicitly ('zh'|'en');
 *     2. otherwise default 'zh'.
 *
 * 2026-08-25 自实现修正（吸收外部 PR #27 时拍板）：默认语言为中文——
 * 未显式设置 / 'auto' / 未知值一律回退 'zh'（保持本插件历史行为与中文
 * 用户群不变），只有用户显式选择 'en' 才切换英文。原 PR 默认 'en' 与
 * 其"zh stays default"声明矛盾，属破坏性变更，故纠正。
 *
 * The DSH locale plugin registers the namespace read-only from our side: we
 * never call settings.update/replace — we only .get() the resolved section
 * and listen to the 'settings/updated' commit event. When the user flips
 * Language mid-session, `setLocale` re-resolves and every getter-based tool
 * description + next-built snapshot/message follows immediately (no restart,
 * no re-registration — the tools registry reads `definition.description` at
 * projection time, so plain JS getters are enough).
 *
 * Dictionary shape: per-domain flat key → { zh, en } pairs, translated via
 * t(domain, key, params) with {name} placeholder substitution. Keeping both
 * languages in one table makes key-parity testable in one pass.
 *
 * @module dsh-memory-evolve/i18n
 */

/** Active host locale. Module-level singleton: one process speaks one language.
 *  Default 'zh'（2026-08-25 自实现拍板）：保持历史中文行为；仅当 DSH
 *  Language preference 显式为 'en' 时切英文。apply() 在启动和每次 locale
 *  变更事件时重新解析，运行中的进程始终跟随设置。 */
let active = 'zh'

/** Valid locale ids (mirrors DSH's LOCALE_IDS). */
export const LOCALES = ['zh', 'en']

/**
 * Resolve the effective locale from a Cordis context. Reads the DSH locale
 * settings section when the settings service exists. Default is 'zh'：仅当
 * DSH Language preference 显式为 'en' 时切英文；unset / 'auto' / 未知值
 * 一律保持中文（历史行为兼容）。Never throws.
 * @param {object|undefined} ctx - plugin context with an optional settings service.
 * @returns {'zh'|'en'} the resolved locale id.
 */
export function resolveLocale(ctx) {
  // Child-process override (spawnWorker passes the host locale down so the
  // memory-sync worker speaks the same language as its parent).
  const fromEnv = typeof process !== 'undefined' && process.env?.DSH_LOCALE
  if (fromEnv === 'zh') return 'zh'
  if (fromEnv === 'en') return 'en'
  try {
    const settings = ctx?.get?.('settings')
    if (!settings || typeof settings.get !== 'function') return 'zh'
    const section = settings.get('locale')
    const pref = section && typeof section === 'object' ? section.preference : undefined
    return pref === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

/** The module-level active locale (for passing to child processes). */
export function getActiveLocale() {
  return active
}

/**
 * Set the active locale (validated). The apply() wiring calls this at boot
 * and on every 'settings/updated' event for the 'locale' namespace.
 * @param {'zh'|'en'} locale - the new active locale.
 */
export function setLocale(locale) {
  if (LOCALES.includes(locale)) active = locale
}

/** Read the active locale (mainly for tests). */
export function getLocale() {
  return active
}

/**
 * Translate one key in the active locale with {name} placeholder params.
 * Unknown keys fall back to the key itself so missing translations surface
 * visibly instead of crashing a tool call.
 * @param {Record<string, [string, string]>} dict - flat map key → [zh, en].
 * @param {string} key - dictionary key.
 * @param {object} [params] - placeholder values ({name} style).
 * @param {'zh'|'en'} [locale] - override the active locale (tests).
 * @returns {string} the translated string.
 */
export function translate(dict, key, params, locale = undefined) {
  const pair = dict[key]
  const lang = locale ?? active
  let text = pair ? (lang === 'zh' ? pair[0] : pair[1]) : key
  if (params && typeof params === 'object') {
    text = text.replace(/\{(\w+)\}/g, (m, name) => {
      const v = params[name]
      return v === undefined || v === null ? m : String(v)
    })
  }
  return text
}

/* ------------------------------------------------------------------ */
/* dictionaries                                                        */
/* ------------------------------------------------------------------ */

/**
 * Core memory-tool strings: descriptions, parameters, result messages.
 * Format: KEY: [zh, en]. Keep both cells non-empty (key-parity test).
 */
export const MEMORY_DICT = {
  // ── tool description ──
  'memory.desc': [
    '读写长期记忆（跨会话持久，随上下文快照对模型可见）。target=memory 存全局环境/项目事实，target=user 存用户事实，target=project 存当前工作目录的项目日志（仅当前项目会话可见），target=key 存当前项目的关键长期记忆（自动注入上下文，仅当前项目会话可见；支持 branches 限定 git 分支范围，缺省=全部；**写入需用户确认**：add 会进入待确认队列，确认后生效；add 可选 summary 参数提供一句话摘要用于渐进式披露），target=daily 追加今日日志（按需读取，不注入）。add 追加条目；replace 用唯一子串片段替换整个条目；remove 用唯一子串片段删除条目；**archive 把条目归档（仅 memory/user/key 三轨）**：按唯一子串片段从主轨移除整条、原文追加进对应归档文件（MEMORY-archive.md / USER-archive.md / 项目 KEY-archive.md，可逆——记忆 Tab 归档页可移回主记忆），适合"已不再需要注入、但丢之可惜"的低频旧事；list 查询条目——默认查主轨（未归档，全部返回，按时间正序），支持 filter（关键词过滤）、since/until（日期范围 YYYY-MM-DD，daily 可跨文件查历史日志）、limit（最多条数，配合 recent 取最近 N 条）、recent（最新在前）、branch（key 轨：只返回该分支可见的条目）、**archived=true（查对应归档文件 MEMORY-archive.md / USER-archive.md / 项目 KEY-archive.md——仅 memory/user/key 三轨，key 需要会话工作目录；归档不注入，可移回主记忆）**；查不到匹配或日期无法解析时，去掉过滤条件重查。**expand 按需加载全文（渐进式披露）**：当 key 轨为摘要模式时，系统提示词只注入摘要，需要详情时用 expand+id 加载完整条目。**每轮收尾批量写**：写每日日志+项目日志用一次调用（action=add 且 entries 数组含 target=daily 与 target=project 两项，entries 仅支持这两轨），不要分成两次调用。**情绪反馈**：若本回合真人用户输入有明显情绪（正面如"太好了/谢谢"，负面如"怎么还没改对/再试一次"），给 daily 和 project 两条都带 feedback 参数（sentiment/category/quote/note，程序自动生成【反馈】行并清洗特殊字符）；daily 的 category 写通用分层（如 编程/后端/数据库；分类指工作类型如 编程→前端开发→JavaScript，不是任务涉及的功能/模块名），project 的 category 写项目内分层（如 记忆模块/写入链路，按项目实际结构）；中性任务指令或其他会话 AI 发来的消息不要带 feedback。写入立即落盘，模型上下文将在下一次刷新时更新。',
    'Read/write long-term memory (persists across sessions; visible to the model through context snapshots). target=memory stores global environment/project facts, target=user stores user facts, target=project stores the current working directory\'s project log (visible only to sessions of this project), target=key stores the current project\'s critical long-term memory (auto-injected into context, visible only to this project\'s sessions; supports branches to limit git-branch visibility, default=all; **writes require user confirmation**: add enters a pending-confirmation queue and takes effect after approval; add accepts an optional summary parameter — a one-line abstract for progressive disclosure), target=daily appends today\'s log (read on demand, not injected). add appends an entry; replace rewrites an entire entry matched by a unique substring; remove deletes an entry matched by a unique substring; **archive moves an entry into the archive (memory/user/key tracks only)**: matched by a unique substring, removed from the main track and appended verbatim into the archive file (MEMORY-archive.md / USER-archive.md / project KEY-archive.md; reversible — the Memory tab archive page can move entries back); good for low-frequency items "no longer worth injecting but too valuable to drop". list queries entries — main track by default (unarchived; everything returned, time ascending), supporting filter (keyword), since/until (date range YYYY-MM-DD; daily may query across historical files), limit (max entries, combine with recent to fetch the latest N), recent (newest first), branch (key track: only entries visible to that branch), **archived=true (query the archive files MEMORY-archive.md / USER-archive.md / project KEY-archive.md instead — memory/user/key tracks only; key needs the session working directory; archives are not injected and can be moved back to the main track)**; when nothing matches or dates fail to parse, retry without filters. **expand loads full text on demand (progressive disclosure)**: when the key track runs in summary mode the system prompt injects only summaries; use expand+id to load the full entry. **End-of-turn batch write**: write the daily log + project log in ONE call (action=add with an entries array containing target=daily and target=project items; entries supports these two tracks only) instead of two calls. **Sentiment feedback**: when the human user\'s input this turn carries clear emotion (positive e.g. "great/thanks", negative e.g. "still wrong/try again"), attach the feedback parameter (sentiment/category/quote/note; the program renders the [Feedback] line and strips special characters) to BOTH daily and project items; daily categories use generic layering (e.g. Coding/Backend/Databases — category describes the kind of work like Coding→Frontend→JavaScript, never the feature/module name), project categories use this project\'s own layering (e.g. Memory module/write path, following actual project structure); do not attach feedback for neutral task instructions or messages from other session AIs. Writes persist immediately; model context refreshes on the next turn.',
  ],
  // ── parameter descriptions ──
  'param.action': ['要执行的操作', 'The action to perform'],
  'param.target': [
    '记忆轨：memory=全局环境/项目事实，user=用户事实，project=当前项目日志，key=当前项目关键长期记忆（自动注入），daily=今日日志；archive 与 archived 查询只支持 memory/user/key',
    'Memory track: memory=global environment/project facts, user=user profile facts, project=current project log, key=current project critical long-term memory (auto-injected), daily=today\'s log; archive and archived queries support memory/user/key only',
  ],
  'param.content': [
    'add/replace 的新条目内容（可多行）',
    'New entry content for add/replace (multi-line allowed)',
  ],
  'param.entries': [
    'add 可选：一次调用多轨批量写入（每轮收尾合并写 daily+project 用，省一次工具往返）。每项 {target, content, feedback?}；**仅支持 daily/project 两轨**（其他轨请用单轨参数，避免绕过全局轨门禁）；传了 entries 时忽略顶层 target/content，逐项执行并返回每轨结果',
    'Optional for add: batch-write multiple tracks in ONE call (the end-of-turn combined daily+project write saves a round trip). Each item is {target, content, feedback?}; **daily/project tracks only** (use single-track parameters for other tracks to respect global-track gating); when entries is given the top-level target/content are ignored, each item executes and returns its own result',
  ],
  'param.entriesTarget': [
    '记忆轨：仅 daily（今日日志）或 project（当前项目日志）',
    'Memory track: daily (today\'s log) or project (current project log) only',
  ],
  'param.entriesContent': ['条目内容（同顶层 content）', 'Entry content (same as top-level content)'],
  'param.feedback': [
    'add 可选（仅 daily/project 轨生效）：本回合真人用户输入有明显情绪时附带，程序自动在条目末尾拼接【反馈】行（格式固定可检索，特殊字符自动清洗）；中性任务指令或其他会话 AI 消息不要带',
    'Optional for add (daily/project tracks only): attach when the human user\'s input this turn carries clear emotion; the program appends a [Feedback] line to the entry (fixed searchable format, special characters sanitized); skip it for neutral task instructions or messages from other session AIs',
  ],
  'param.sentiment': [
    '情绪：positive=正面（太好啦/谢谢/不错），negative=负面（怎么还没改对/又错了/再试一次）；仅真人用户明确评价时给，程序会清洗特殊字符',
    'Sentiment: positive (great/thanks/nice), negative (still wrong/wrong again/try again); provide only for explicit human-user evaluations; special characters are sanitized',
  ],
  'param.category': [
    '任务分类：daily 轨写通用分层（如 编程/后端/数据库，至少一级可到三级；一级参考：编程/文档/运维/数据分析/设计/通用；分类指工作类型如 编程→前端开发→JavaScript，不是任务涉及的功能/模块名）；project 轨写本项目内分层（如 记忆模块/写入链路，按项目实际结构，不强制层级数）',
    'Task category: daily track uses generic layering (e.g. Coding/Backend/Databases, one to three levels; top-level references: Coding/Docs/Ops/Data analysis/Design/General; category means the KIND of work like Coding→Frontend→JavaScript, never the feature/module name); project track uses this project\'s own layering (e.g. Memory module/write path, following actual structure; depth not enforced)',
  ],
  'param.quote': [
    '用户原话摘录（程序自动截断 ≤20 字并清洗；情绪判定的可溯源证据）',
    'Verbatim user quote (truncated to 20 chars and sanitized; traceable evidence for the sentiment call)',
  ],
  'param.note': [
    '表现一句话（好/不好 + 原因，如 改了两轮还没对）',
    'One-line performance note (good/bad + reason, e.g. two fix rounds still failing)',
  ],
  'param.manual': [
    'true=用户手动要求记录（生成【反馈·手动】前缀）；缺省=false（自动捕获）',
    'true=user explicitly asked to record (renders the [Feedback·manual] prefix); default=false (automatic capture)',
  ],
  'param.match': [
    'replace/remove/archive 的匹配片段，必须唯一命中一个条目',
    'Substring for replace/remove/archive; must match exactly one entry',
  ],
  'param.archived': [
    'list 可选：true 时查询对应归档文件（MEMORY-archive.md / USER-archive.md / 项目 KEY-archive.md），仅 memory/user/key 三轨，key 需要会话工作目录',
    'Optional for list: true queries the archive files (MEMORY-archive.md / USER-archive.md / project KEY-archive.md) instead; memory/user/key tracks only; key needs the session working directory',
  ],
  'param.branches': [
    'add 可选（仅 key 轨）：分支范围，逗号分隔（如 main,dev）；缺省=全部（所有分支可见）；留空字符串=全部',
    'Optional for add (key track only): branch scope, comma-separated (e.g. main,dev); default=all branches visible; empty string=all',
  ],
  'param.branch': [
    'list 可选（仅 key 轨）：只返回该分支可见的条目（无标记的全部条目 + 标记含该分支的条目）',
    'Optional for list (key track only): return only entries visible to that branch (untagged entries + entries tagged with it)',
  ],
  'param.filter': [
    'list 可选：只返回内容包含该关键词的条目（大小写不敏感）',
    'Optional for list: return only entries containing this keyword (case-insensitive)',
  ],
  'param.since': [
    'list 可选：起始日期 YYYY-MM-DD；daily 轨支持跨文件查询历史日志',
    'Optional for list: start date YYYY-MM-DD; the daily track may query across historical files',
  ],
  'param.until': ['list 可选：结束日期 YYYY-MM-DD', 'Optional for list: end date YYYY-MM-DD'],
  'param.limit': [
    'list 可选：最多返回的条数（建议与 recent 搭配取最近 N 条）',
    'Optional for list: maximum entries to return (combine with recent to fetch the latest N)',
  ],
  'param.recent': [
    'list 可选：按时间倒序返回（最新在前）',
    'Optional for list: return newest first (reverse chronological)',
  ],
  'param.id': [
    'expand 必填：条目身份证 ID（摘要模式注入的 [mem-xxxxxxxx] 中的 xxxxxxxx 部分）',
    'Required for expand: the entry identity ID (the xxxxxxxx part of a [mem-xxxxxxxx] id shown in summary-mode injections)',
  ],
  'param.summary': [
    'add 可选（仅 key 轨）：一句话摘要（≤120 字），用于渐进式披露时注入系统提示词；缺省=自动截取正文首行',
    'Optional for add (key track only): a one-line summary (≤120 chars) injected by progressive disclosure; default=first line of the body',
  ],
  // ── execute-time messages ──
  'msg.emptyContent': ['内容不能为空', 'Content must not be empty'],
  'msg.emptyMatch': ['match 不能为空', 'match must not be empty'],
  'msg.emptyEntry': ['条目不能为空', 'Entry must not be empty'],
  'msg.missingTarget': [
    '缺少 target（记忆轨必填；每轮收尾批量写请用 add + entries 数组）',
    'Missing target (a memory track is required; use add + the entries array for the end-of-turn batch write)',
  ],
  'msg.fileUnreadableWrite': [
    '记忆文件存在但无法读取，拒绝写入（防止清空已有记忆）',
    'Memory file exists but cannot be read; write refused (protecting existing memories from being wiped)',
  ],
  'msg.fileUnreadableOp': [
    '记忆文件存在但无法读取，拒绝操作（防止误判条目）',
    'Memory file exists but cannot be read; operation refused (avoiding entry misjudgment)',
  ],
  'msg.driftGuardWrite': [
    '拒绝写入：{file} 的内容无法通过记忆工具解析往返（可能被手工编辑或外部进程修改）。已备份到 {backup}。请先将该文件整理为规范的 § 分隔条目，再重试。',
    'Write refused: {file} does not round-trip through the memory tool parser (hand-edited or modified by another process?). A backup was saved to {backup}. Re-format the file into canonical §-delimited entries first, then retry.',
  ],
  'msg.driftGuardOp': [
    '拒绝操作：{file} 的内容无法通过记忆工具解析往返。已备份到 {backup}。请先整理文件再重试。',
    'Operation refused: {file} does not round-trip through the memory tool parser. A backup was saved to {backup}. Reformat the file first, then retry.',
  ],
  'msg.added': ['已添加（{target}：{before} → {after} 条）', 'Added ({target}: {before} → {after} entries)'],
  'msg.duplicate': ['条目已存在，未重复添加', 'Entry already exists; not added again'],
  'msg.replaced': ['已替换条目（{target}：{count} 条不变）', 'Entry replaced ({target}: {count} entries unchanged)'],
  'msg.removedEntry': ['已删除条目（{target}：{before} → {after} 条）', 'Entry deleted ({target}: {before} → {after} entries)'],
  'msg.noMatchEntries': ['没有条目包含片段 "{match}"', 'No entry contains the substring "{match}"'],
  'msg.multiMatch': [
    '片段 "{match}" 匹配到 {count} 个条目，请用更精确的片段',
    'The substring "{match}" matches {count} entries; use a more precise substring',
  ],
  'msg.archivedQueryOnly': [
    'archived 查询只支持 memory / user / key（project/daily 不归档）',
    'archived queries support memory / user / key only (project/daily are never archived)',
  ],
  'msg.keyArchiveNeedsCwd': ['key 归档查询需要会话工作目录', 'key archive queries need the session working directory'],
  'msg.archiveList': [
    '{target} 归档：{count} 条（归档不注入；需要时可移回主记忆）',
    '{target} archive: {count} entries (archives are not injected; entries can be moved back to the main track when needed)',
  ],
  'msg.listMatched': ['{target}：{count} 条匹配', '{target}: {count} entries matched'],
  'msg.protectedView': [
    '（该轨共 {total} 条，时间跨度 {earliest} ~ {latest}，默认只返回最近 50 条——查询更早记录请加 since/until（如 since={sample}）或增大 limit）',
    '(this track holds {total} entries spanning {earliest} ~ {latest}; by default only the latest 50 return — add since/until (e.g. since={sample}) or raise limit to reach older records)',
  ],
  'msg.noMatchesRetry': [
    '（未找到匹配条目——可去掉过滤条件重新 list 读取全文核对）',
    '(no matching entries — retry list without filters to scan the full text)',
  ],
  'msg.undatedSkipped': [
    '（另有 {count} 条日期无法解析的条目未参与日期过滤——可去掉 since/until 重新 list 读取全文核对）',
    '({count} additional entries have unparsable dates and were skipped by the date filter — retry without since/until to scan the full text)',
  ],
  'msg.subagentGlobalDenied': [
    '子代理写入全局记忆被拒绝：请改用 {suggestTool} 提出建议（项目记忆与每日日志可直接写入）',
    'Subagent writes to global memory are refused: propose via {suggestTool} instead (project memory and today\'s log stay directly writable)',
  ],
  'msg.approvalUnavailable': [
    '记忆写入需要用户批准，但当前没有可用的批准通道',
    'This memory write needs user approval but no approval channel is available',
  ],
  'msg.approvalReason': ['记忆审查建议写入长期记忆', 'Review suggestion writing into long-term memory'],
  'msg.notApproved': ['记忆写入未获批准（{outcome}）', 'Memory write was not approved ({outcome})'],
  'msg.keySuggestionQueued': [
    '已提交待确认的项目关键记忆建议（队列 {queued} 条）——用户确认后才会写入并注入',
    'Submitted a pending project-key-memory suggestion (queue now holds {queued}) — it is written and injected only after user confirmation',
  ],
  'msg.keySuggestReason': ['每轮收尾自动提交的项目关键记忆建议', 'Project key-memory suggestion auto-submitted at end of turn'],
  'msg.writeError': [
    '写入异常：{detail}',
    'Write failed: {detail}',
  ],
  'msg.batchUnsupportedTrack': [
    'entries 仅支持 daily/project 轨（其他轨请用单轨参数）',
    'entries supports daily/project tracks only (use single-track parameters for other tracks)',
  ],
  'msg.batchSummary': [
    '批量写入 {count} 轨：',
    'Batch-wrote {count} tracks: ',
  ],
  'msg.ok': ['成功', 'ok'],
  'msg.failed': ['失败', 'failed'],
  'msg.archiveTracksOnly': [
    'archive 只支持 memory / user / key 三个归档轨（project/daily 不归档）',
    'archive supports the three archive tracks memory / user / key only (project/daily are never archived)',
  ],
  'msg.archiveEmptyMatch': [
    'match 不能为空（要归档条目的唯一片段）',
    'match must not be empty (a unique substring of the entry to archive)',
  ],
  'msg.archiveKeyNeedsCwd': ['key 轨归档需要会话工作目录', 'key-track archiving needs the session working directory'],
  'msg.archiveAppendFailed': [
    '归档写入失败：{detail}（主轨条目未动，可重试）',
    'Archive write failed: {detail} (the main-track entry is untouched; retry is safe)',
  ],
  'msg.archivePartial': [
    '已写入归档（现有 {total} 条）但主轨删除失败：{detail}——归档里多出的那条可在记忆 Tab 归档页手动清理',
    'Archived ({total} entries now in the archive) but main-track deletion failed: {detail} — clean up the extra archive copy on the Memory tab archive page',
  ],
  'msg.archivedDone': [
    '已归档（{target}：归档文件现有 {total} 条；原条目已从主轨移除，可随时在记忆 Tab 归档页移回）',
    'Archived ({target}: the archive file now holds {total}; the original entry left the main track and can move back any time from the Memory tab archive page)',
  ],
  'msg.expandKeyOnly': ['expand 仅支持 target=key', 'expand supports target=key only'],
  'msg.expandNeedsId': ['expand 需要提供 id 参数', 'expand needs the id parameter'],
  'msg.expandNeedsCwd': ['expand 需要会话工作目录', 'expand needs the session working directory'],
  'msg.expandNotFound': ['未找到 id={id} 的 key 条目', 'No key entry with id={id} found'],
  'msg.expandFullText': ['条目全文', 'Entry full text'],
  'msg.unknownAction': [
    '未知操作 "{action}"（支持 add / replace / remove / archive / list / expand）',
    'Unknown action "{action}" (supported: add / replace / remove / archive / list / expand)',
  ],
  'msg.branchWarningUnknown': [
    '（警告：分支 {branches} 当前不存在，条目将仅在这些分支创建后可见）',
    '(warning: branch(es) {branches} do not exist yet; entries become visible only after those branches are created)',
  ],
  'msg.sectionContainsDelimiter': [
    '内容不能包含条目分隔符 §（会破坏记忆文件的分割格式）',
    'Content must not contain the entry delimiter § (it would corrupt the memory file format)',
  ],
  // ── renderMemoryResult ──
  'render.currentEntries': ['当前条目（{count} 条）：', 'Current entries ({count}):'],
  'render.matches': ['命中的条目：', 'Matched entries:'],
  'render.batchResults': ['批量写入结果：', 'Batch write results:'],
  // ── feedback line ──
  'feedback.tag': ['【反馈】', '[Feedback]'],
  'feedback.tagManual': ['【反馈·手动】', '[Feedback·manual]'],
  'feedback.positive': ['正面', 'positive'],
  'feedback.negative': ['负面', 'negative'],
  'feedback.uncategorized': ['未分类', 'Uncategorized'],
  'feedback.sentiment': ['情绪', 'sentiment'],
  'feedback.category': ['分类', 'category'],
  'feedback.quote': ['原话', 'quote'],
  'feedback.note': ['表现', 'note'],
}

/** Suggest/review-status tool strings (lib/review.js). */
export const REVIEW_DICT = {
  'reviewStatus.desc': [
    '完成每 N 个用户回合的自动记忆审查。**无需每轮调用**：到期提醒由程序在快照中动态注入（出现「记忆审查已到期」提醒时才需要执行审查）；complete：审查全部执行完毕后调用，复位计数（漏做则下一轮继续提醒）；check：仅在你需要手动确认当前进度时调用（返回 due 与距上次审查的回合数）。',
    'Completes the automatic memory review due every N user turns. **Do NOT call it every turn**: the due reminder is injected into the snapshot dynamically (run a review only when the "memory review is due" reminder appears); complete: call after finishing the whole review to reset the counter (skipping keeps the reminder coming next turn); check: call only to manually confirm current progress (returns due and turns since the last review).',
  ],
  'reviewStatus.action': [
    'check=查询审查是否到期；complete=完成审查后复位计数',
    'check=query whether a review is due; complete=reset the counter after finishing a review',
  ],
  'reviewStatus.notDue': [
    '审查未到期（{turns}/{interval}），无需复位，计数保持不变。',
    'No review is due yet ({turns}/{interval}); no reset needed and the counter stays unchanged.',
  ],
  'reviewStatus.reset': [
    '审查计数已复位（下次到期按新间隔重新计数）。',
    'Review counter reset (the next due date counts against the new interval).',
  ],
  'reviewStatus.due': [
    '记忆审查已到期（距上次审查 {turns} 个回合，间隔 {interval}）：执行审查，完成后必须调用 complete 复位。',
    'A memory review is due ({turns} turns since the last one, interval {interval}): run the review, then call complete to reset.',
  ],
  'reviewStatus.notDueYet': [
    '记忆审查未到期（距上次审查 {turns}/{interval} 个回合），本轮无需审查（也不要调用 complete）。',
    'No memory review is due ({turns}/{interval} turns since the last one); skip reviewing this turn (and do not call complete).',
  ],
  'suggest.desc': [
    '提出一条长期记忆建议（记忆审查使用）。不会直接修改记忆，只会加入待用户确认的队列；重复内容会累计建议次数。',
    'Propose one long-term-memory suggestion (used by the review flow). It never modifies memory directly — the proposal joins a queue awaiting user confirmation; repeated content accumulates a hit count.',
  ],
  'suggest.target': [
    '轨：memory=环境/项目事实，user=用户事实；todo-life/todo-work/todo-project/todo-daily=待办建议（确认后写入对应待办轨）',
    'Track: memory=environment/project facts, user=user facts; todo-life/todo-work/todo-project/todo-daily=todo suggestions (written into the matching todo track after confirmation)',
  ],
  'suggest.content': ['建议记忆的条目内容（可多行）', 'Suggested memory entry content (multi-line allowed)'],
  'suggest.reason': ['为什么值得记住（引用会话中的证据）', 'Why this is worth remembering (cite evidence from the session)'],
  'suggest.invalidTarget': [
    '无效 target "{target}"（应为 {valid}）',
    'Invalid target "{target}" (expected one of {valid})',
  ],
  'suggest.emptyContent': ['content 不能为空', 'content must not be empty'],
  'suggest.emptyReason': ['reason 不能为空（必须引用会话中的证据）', 'reason must not be empty (cite evidence from the session)'],
  'suggest.queued': [
    '已提交待确认建议（队列 {queued} 条）——用户确认后才会写入',
    'Suggestion queued for confirmation (queue now holds {queued}) — written only after user approval',
  ],
}

/** Todo tool strings (lib/todo.js). */
export const TODO_DICT = {
  'todo.desc': [
    '待办管理（四轨：life 生活 / work 工作 / project 项目（按工作目录隔离）/ daily 每日）。用户口述"记住/我要做 X"时用 add 直写——**add 的 target 遵循用户说的类别**（"工作上的事"→work、"生活中的"→life、"这个项目要"→project、"今天要"→daily），用户没说才用缺省（有工作目录 project，无 cwd 用 work）。**list 默认智能视图**：只返回需要关注的未完成项（逾期/今日到期/当前项目/重要紧急，最多 8 条），看全部需显式 all=true 或筛选参数。**查过往（昨天及更早的每日待办）请一次到位：list 加 past=true 且 expired=true**——每日待办截止=当天，过往的每日待办几乎必然已过期（除非已完成），只带 past=true 会隐藏未完成的过期遗留（只能看到已完成的过往）；带齐两个参数才能看到"昨天有哪些待办、哪些没做完"。**跨项目查询**：在别的会话里查某项目的待办用 list 加 target=project 与 cwd=<该项目工作目录路径>。done/update/remove 按 id 精确操作（list 输出带 id；每日过往条目的 id 同样可操作）。模型自建待办请用 memory_suggest target=todo-*（进待确认队列），不要直接 add。',
    'Todo management (four tracks: life / work / project (isolated per working directory) / daily). When the user says "remember / I need to do X", write it directly with add — **the add target follows the category the user names** ("work thing"→work, "personal"→life, "for this project"→project, "today"→daily); fall back to defaults only when unspecified (project when a working directory exists, otherwise work). **list defaults to a smart view**: only unfinished items needing attention (overdue/due today/current project/important-urgent, max 8); pass all=true or filters to see everything. **Querying the past (yesterday and older daily todos) needs one precise call: list with past=true AND expired=true** — daily todos expire the same day, so past unfinished ones are almost certainly expired already; past=true alone hides expired leftovers (showing only completed history); with both parameters you see "what yesterday\'s todos were and what went undone". **Cross-project queries**: inspect another project\'s todos with list + target=project + cwd=<that project\'s working directory>. done/update/remove operate precisely by id (list output includes ids; past daily-entry ids work the same way). For model-authored todos use memory_suggest target=todo-* (enters the confirmation queue); never add directly.',
  ],
  'todo.action': [
    'add=新增；list=查看（默认智能视图）；done=完成；update=修改；remove=删除',
    'add=create; list=view (smart view by default); done=complete; update=modify; remove=delete',
  ],
  'todo.target': [
    'add：遵循用户说的类别（工作→work、生活→life、项目→project、每日→daily），没说才缺省（有工作目录用 project，否则 work）；list 缺省=综合四轨；done/update/remove 缺省=全轨按 id 查找',
    'add: follow the category the user names (work→work, personal→life, project→project, today→daily), fall back to defaults only when unspecified (project with a working directory, else work); list default=composite of all four tracks; done/update/remove default=search all tracks by id',
  ],
  'todo.content': [
    'add 时必填：待办内容（首行是标题，可多行写详情）；update 时=替换内容',
    'Required for add: todo content (first line is the title; details may follow on more lines); for update=replacement content',
  ],
  'todo.important': ['是否重要（与 urgent 组合成四象限）', 'Whether important (combines with urgent into the four quadrants)'],
  'todo.urgent': ['是否紧急', 'Whether urgent'],
  'todo.quadrant': [
    '直接指定四象限（优先于 important/urgent）：q1 重要紧急 / q2 重要不紧急 / q3 紧急不重要 / q4 不重要不紧急',
    'Set the quadrant directly (overrides important/urgent): q1 important+urgent / q2 important+not urgent / q3 urgent+not important / q4 neither',
  ],
  'todo.due': ['截止日期 YYYY-MM-DD', 'Due date YYYY-MM-DD'],
  'todo.cat': ['分类（生活/工作/学习…）', 'Category (life/work/study…)'],
  'todo.status': [
    'list 筛选（缺省=智能视图）；update 设置新状态',
    'list filter (default=smart view); update sets the new status',
  ],
  'todo.id': [
    '条目标识（list 返回，如 a1b2c3d4）；done/update/remove 必填',
    'Item id as returned by list (e.g. a1b2c3d4); required for done/update/remove',
  ],
  'todo.date': [
    'daily 轨指定日期 YYYY-MM-DD（缺省=今天）',
    'Date for the daily track YYYY-MM-DD (default=today)',
  ],
  'todo.all': [
    'list 时 true=显示全部未过滤（默认智能视图）',
    'For list: true shows everything unfiltered (smart view is the default)',
  ],
  'todo.past': [
    'list 时 true=同时查询每日待办的过往（昨天及更早的历史条目，带日期）；**查过往请同时带 expired=true**（每日待办截止=当天，未完成的过往必然已过期，默认被隐藏）',
    'For list: true also queries past daily todos (yesterday and older, with dates); **pair it with expired=true** — daily todos expire same-day, so unfinished past ones are always expired and hidden by default',
  ],
  'todo.expired': [
    'list 时 true=过往中同时包含已过期的遗留条目（仅与 past=true 配合生效；缺省隐藏已过期且无未来截止的遗留）',
    'For list: true includes expired leftover entries among the past (only takes effect with past=true; expired items without a future due date are hidden by default)',
  ],
  'todo.cwd': [
    'list 时指定项目工作目录路径（跨项目查询：在别的会话里查该项目 target=project 的待办，project 轨按此路径定位；缺省=当前会话工作目录）',
    'Working directory path for list (cross-project queries: inspect another project\'s target=project todos; the project track locates data by this path; default=current session working directory)',
  ],
}

/** Skill-management tool strings (lib/skills.js). */
export const SKILL_DICT = {
  'skill.listHeader': ['已有技能（{count} 个）：', 'Existing skills ({count}):'],
  'skill.desc': [
    '管理技能库（默认目录 ~/.agents/skills，DSH 技能库）：create 创建新技能（body 为完整 SKILL.md，含 --- frontmatter：name 与 description 单行必填）；patch 更新已有技能（必须先用 read 读取过，body 为完整修订版）；read 读取技能全文；list 列出已有技能。技能命名必须 kebab-case 类级名称（如 systematic-debugging），禁止一次性任务名。',
    'Manage the skill library (default directory ~/.agents/skills, the DSH skill store): create adds a new skill (body is a full SKILL.md including --- frontmatter with single-line name and description); patch updates an existing skill (read it first; body is the full revised version); read returns a skill\'s full text; list enumerates skills. Skill names must be kebab-case class-like names (e.g. systematic-debugging); one-off task names are rejected.',
  ],
  'skill.action': ['要执行的操作', 'The action to perform'],
  'skill.name': ['技能名（kebab-case 小写）', 'Skill name (lowercase kebab-case)'],
  'skill.description': ['create 时的一句话描述（说明何时使用该技能，将写入 frontmatter）', 'One-sentence description for create (when to use the skill; written into frontmatter)'],
  'skill.body': [
    'create/patch 时的完整 SKILL.md 内容（--- frontmatter + 正文：概览/步骤/命令/坑/验证）',
    'Full SKILL.md content for create/patch (--- frontmatter + body: overview/steps/commands/pitfalls/verification)',
  ],
  'skill.invalidName': [
    '无效技能名 "{name}"（必须 kebab-case 小写，如 systematic-debugging）',
    'Invalid skill name "{name}" (must be lowercase kebab-case, e.g. systematic-debugging)',
  ],
  'skill.emptyDescription': ['description 不能为空', 'description must not be empty'],
  'skill.emptyBody': ['body 不能为空（完整 SKILL.md 内容，含 frontmatter）', 'body must not be empty (full SKILL.md content including frontmatter)'],
  'skill.tooLarge': ['SKILL.md 超过大小上限 {limit} 字节', 'SKILL.md exceeds the size cap of {limit} bytes'],
  'skill.badFrontmatter': [
    'body 不是规范 SKILL.md：必须以 --- 开头的 frontmatter（含单行 name 与 description），后接正文。注意 description 请用双引号包裹（如 description: "..."），未加引号且含冒号+空格的值会被 YAML 拒绝',
    'body is not a valid SKILL.md: it must start with a --- frontmatter block (single-line name and description) followed by the body. Quote the description value with double quotes (description: "..."); unquoted values containing colon+space get rejected by YAML',
  ],
  'skill.nameMismatch': [
    'frontmatter 的 name（{parsed}）必须与技能名一致（{name}）',
    'frontmatter name ({parsed}) must equal the skill name ({name})',
  ],
  'skill.descriptionMismatch': [
    'frontmatter 的 description 与传入的 description 不一致',
    'frontmatter description differs from the description argument',
  ],
  'skill.disabledShadow': [
    '技能 "{name}" 已被禁用（modelInvocable: false），不执行写入',
    'Skill "{name}" is disabled (modelInvocable: false); no write performed',
  ],
}

/** Snapshot injection strings (renderSnapshot / buildMemoryContext in lib/index.js). */
export const SNAPSHOT_DICT = {
  'snap.sessionNamed': [
    '## 你的会话（用名称/别名/ID 与各模块消息里的 session id 比对判断是谁；回复时把名称/别名与 ID 告知对方）',
    '## Your session (match the name/alias/ID against session ids inside module messages to tell who is who; when replying, tell the other party the name/alias and ID)',
  ],
  'snap.yourName': ['- 你的会话名称：{title}', '- Your session name: {title}'],
  'snap.yourAlias': ['- 你的会话别名：{alias}', '- Your session alias: {alias}'],
  'snap.yourId': ['- 你的会话 ID：{id}', '- Your session ID: {id}'],
  'snap.sessionPlain': [
    '## 你的会话 ID（记住它：用它与各模块消息里的 session id 比对判断是谁；回复时也可把此 ID 告知对方）',
    '## Your session ID (remember it: match it against session ids inside module messages to tell who is who; you may also give this ID to the other party when replying)',
  ],
  'snap.memoryHead': [
    '## 长期记忆（所有项目、会话都必须遵循）',
    '## Long-term memory (every project and session must follow this)',
  ],
  'snap.userHead': ['## 用户档案', '## User profile'],
  'snap.keyHead': ['## 本项目关键记忆（memory 工具 target=key）', '## This project\'s key memories (memory tool target=key)'],
  'snap.keyBranchHead': [
    '## 本项目关键记忆（memory 工具 target=key；当前分支：{branch}，仅注入匹配分支的条目）',
    '## This project\'s key memories (memory tool target=key; current branch: {branch}; only branch-matching entries injected)',
  ],
  'snap.keySummaryHead': [
    '## 本项目关键记忆（memory 工具 target=key；摘要模式，用 memory action=expand+id 加载全文）',
    '## This project\'s key memories (memory tool target=key; summary mode — use memory action=expand+id to load full text)',
  ],
  'snap.keySummaryBranchHead': [
    '## 本项目关键记忆（memory 工具 target=key；摘要模式，当前分支：{branch}；用 memory action=expand+id 加载全文）',
    '## This project\'s key memories (memory tool target=key; summary mode, current branch: {branch}; use memory action=expand+id to load full text)',
  ],
  'snap.section': [
    '## 记忆 memory-evolve（包含 memory 工具、dtodo 待办工具、skill_manage 技能工具）',
    '## Memory memory-evolve (provides the memory tool, dtodo todo tool, and skill_manage skill tool)',
  ],
  'snap.sectionNoTodo': [
    '## 记忆 memory-evolve（包含 memory 工具、skill_manage 技能工具）',
    '## Memory memory-evolve (provides the memory tool and skill_manage skill tool)',
  ],
  'snap.readHint': [
    '- 读取：需要时用 memory 工具读取 target=project（项目约定/进展）与 target=daily（今日日志），不要凭猜测回答。本项目关键记忆（target=key）已注入上下文，无需读取。',
    '- Reading: when needed use the memory tool to read target=project (project conventions/progress) and target=daily (today\'s log); never answer from guesswork. This project\'s key memories (target=key) are already injected into context — no need to re-read.',
  ],
  'snap.branchHint': [
    '\n- 当前 git 分支：**{branch}**（target=key 的记忆按分支过滤注入；写 key 时可用 branches=分支名 限定范围，缺省=全部）',
    '\n- Current git branch: **{branch}** (target=key memories are filtered by branch on injection; when writing key entries you may scope them with branches=<branch name>; default=all)',
  ],
  'snap.todoHint': [
    '- 待办（dtodo）：收尾时调用 dtodo list 检查到期（默认视图：今日到期/逾期优先，最多 8 条）——有到期未完成项就在回复末尾提醒用户；不要主动展开全部待办清单，除非用户询问；用法细节（target 归类、过往/过期查询等）见 dtodo 工具描述。',
    '- Todos (dtodo): at turn end call dtodo list to check what is due (default view: due-today/overdue first, max 8 items) — if unfinished due items exist, remind the user at the end of your reply; never expand the whole todo list unprompted; usage details (target categories, past/expired queries) live in the dtodo tool description.',
  ],
  'snap.turnEndHead': [
    '- 每轮收尾（先输出完整回复文本，再在文本之后附带工具调用，严禁先调工具）必须：',
    '- End of every turn (output your complete reply text FIRST, then attach tool calls AFTER it; calling tools first is strictly forbidden), you must:',
  ],
  'snap.subagentTurnEndHead': [
    '- 收尾（先输出完整回复文本，再在文本之后附带工具调用，严禁先调工具）：',
    '- Turn end (output your complete reply text FIRST, then attach tool calls AFTER it; calling tools first is strictly forbidden):',
  ],
  'snap.subagentWrite': [
    '仅在完成**独立成果**时（一项实质产出、一个关键决策或踩坑结论），用 memory 工具一次调用（entries 数组）向 {targets} 写入 1 条，保持简洁',
    'Only after completing an **independent achievement** (a substantive deliverable, a key decision, or a pitfall conclusion), write ONE concise entry to {targets} with a single memory call (entries array)',
  ],
  'snap.subagentKeyTail': [
    '；重要结论可另向 target=key 提交建议（用户确认后生效）；没有独立成果就跳过，不要为写而写。',
    '; for important conclusions you may additionally submit a suggestion to target=key (takes effect after user confirmation); skip entirely when there is no independent achievement — do not write for writing\'s sake.',
  ],
  'snap.subagentSkipTail': [
    '；没有独立成果就跳过，不要为写而写。',
    '; skip entirely when there is no independent achievement — do not write for writing\'s sake.',
  ],
  'snap.batchWriteDuty': [
    '用 memory 工具**一次调用**（action=add + entries 数组，含 {targets} 各一项）写 1 条本回合进展（1-2 行具体内容）',
    'In ONE memory call (action=add with an entries array containing one item each for {targets}) write one entry of this turn\'s progress (1-2 concrete lines)',
  ],
  'snap.and': [' 与 ', ' and '],
  'snap.keyDuty': [
    '本轮出现重要项目事实（长期约定/决策/架构/踩坑）时另向 target=key 提交 1 条建议（用户确认后写入并注入），没有则跳过',
    'when durable project facts appear this turn (long-lived conventions/decisions/architecture/pitfalls), additionally submit one suggestion to target=key (written and injected after user confirmation); skip when there are none',
  ],
  'snap.feedbackDuty': [
    '本回合真人用户输入有明显情绪（正面/负面）时，各条目带 feedback 参数（sentiment/category/quote/note，程序自动生成【反馈】行）——daily 的 category 写通用分类（如 编程/后端/数据库，至少一级可到三级；分类指工作类型如 编程→前端开发→JavaScript，不是任务涉及的功能/模块名），project 的 category 写本项目内分层（如 记忆模块/写入链路，按项目实际结构）；中性任务指令或其他会话 AI 消息不带 feedback',
    'when the human user\'s input this turn carries clear emotion (positive/negative), attach the feedback parameter to both entries (sentiment/category/quote/note; the program renders a [Feedback] line) — daily categories use generic layering (e.g. Coding/Backend/Databases, one to three levels; category means the kind of work like Coding→Frontend→JavaScript, never the feature/module name), project categories use this project\'s own layering (e.g. Memory module/write path, following actual structure); no feedback for neutral task instructions or messages from other session AIs',
  ],
  'snap.writeStep': ['1. 写入：{duties}；', '1. Write: {duties};'],
  'snap.reviewStep': [
    '{n}. 审查：仅当快照出现「记忆审查已到期」提醒时执行审查（全局记忆用 memory_suggest 提建议 / mode=auto 直接写 memory，技能用 skill_manage 创建/优化），完成后调用 memory_review_status（action=complete）复位；无提醒则跳过，不要调用 check。',
    '{n}. Review: only when the snapshot shows the "memory review is due" reminder run a review (global memory via memory_suggest suggestions / direct memory writes in mode=auto; skills via skill_manage create/patch), then call memory_review_status (action=complete) to reset; with no reminder skip — do not call check.',
  ],
  'snap.noTimestampTail': [
    '- 内容不要自带时间/日期前缀（程序自动盖时间戳）。',
    '- Do not prefix entry content with your own time/date stamps (the program timestamps automatically).',
  ],
  'snap.dueWarning': [
    '\n\n⚠️ **记忆审查已到期**（间隔 {interval} 轮，mode={mode}）：本回合收尾必须执行审查——全局记忆用 memory_suggest 提交建议（mode=auto 时用 memory 直接写入），技能用 skill_manage 创建/优化；完成后调用 memory_review_status（action=complete）复位。',
    '\n\n⚠️ **A memory review is DUE** (interval {interval} turns, mode={mode}): finish this turn by running the review — global memory via memory_suggest suggestions (direct memory writes in mode=auto), skills via skill_manage create/patch; then call memory_review_status (action=complete) to reset.',
  ],
  // 写入看门狗（2026-08-31）：长会话连续多轮未写 daily/project 的置顶提醒。
  // 文案刻意静态（不嵌实时计数）——DSH 快照按整体文本 diff 注入，嵌计数
  // 会导致欠账期间每轮重注入整段快照（缓存不友好）；阈值随配置走。
  'snap.writeGuardWarning': [
    '\n\n⚠️ **记忆写入遗漏提醒**：本会话已连续 **{threshold} 轮以上**未写入任何 daily/project 记忆（写入看门狗已触发）——本回合收尾**必须**用 memory 工具一次调用（action=add + entries 数组，含 target=daily 与 target=project 各一项）把遗漏轮次的关键进展**补写**进去（每轨 1 条、多轮进展浓缩成 1-2 行即可），之后恢复每轮一条的节奏，不要再漏。',
    '\n\n⚠️ **Memory-write backlog alert**: this session has gone **{threshold}+ consecutive turns** without ANY daily/project memory write (write watchdog tripped) — before this turn ends you MUST catch up with ONE memory call (action=add + entries array, one item each for target=daily and target=project), condensing the missed turns\' key progress into 1-2 lines per track; then resume the one-entry-per-turn rhythm. Do not skip again.',
  ],
  // buildMemoryContext (external-executor injections)
  'ctx.memoryGlobal': ['【长期记忆（全局）】', '[Long-term memory (global)]'],
  'ctx.userProfile': ['【用户档案】', '[User profile]'],
  'ctx.keyWithBranch': ['【本项目关键记忆（分支 {branch}）】', "[This project's key memories (branch {branch})]"],
  'ctx.keyPlain': ["【本项目关键记忆】", "[This project's key memories]"],
}

/** MemoryStore user-facing result messages (lib/store.js). */
export const STORE_DICT = {
  'store.emptyContent': ['内容不能为空', 'Content must not be empty'],
  'store.emptyMatch': ['match 不能为空', 'match must not be empty'],
  'store.fileUnreadableWrite': [
    '记忆文件存在但无法读取，拒绝写入（防止清空已有记忆）',
    'Memory file exists but cannot be read; write refused (protecting existing memories from being wiped)',
  ],
  'store.duplicate': ['条目已存在，未重复添加', 'Entry already exists; not added again'],
  'store.added': ['已添加（{target}：{before} → {after} 条）', 'Added ({target}: {before} → {after} entries)'],
  'store.emptyNewContent': [
    'content 不能为空（删除条目请用 remove）',
    'content must not be empty (use remove to delete an entry)',
  ],
  'store.driftGuardWrite': [
    '拒绝写入：{file} 的内容无法通过记忆工具解析往返（可能被手工编辑或外部进程修改）。已备份到 {backup}。请先将该文件整理为规范的 § 分隔条目，再重试。',
    'Write refused: {file} does not round-trip through the memory tool parser (hand-edited or modified by another process?). A backup was saved to {backup}. Re-format the file into canonical §-delimited entries first, then retry.',
  ],
  'store.noMatch': ['没有条目包含片段 "{match}"', 'No entry contains the substring "{match}"'],
  'store.multiMatch': [
    '片段 "{match}" 匹配到 {count} 个条目，请用更精确的片段',
    'The substring "{match}" matches {count} entries; use a more precise substring',
  ],
  'store.replaced': ['已替换条目（{target}：{count} 条不变）', 'Entry replaced ({target}: {count} entries unchanged)'],
  'store.driftGuardOp': [
    '拒绝操作：{file} 的内容无法通过记忆工具解析往返。已备份到 {backup}。请先整理文件再重试。',
    'Operation refused: {file} does not round-trip through the memory tool parser. A backup was saved to {backup}. Reformat the file first, then retry.',
  ],
  'store.fileUnreadableOp': [
    '记忆文件存在但无法读取，拒绝操作（防止误判条目）',
    'Memory file exists but cannot be read; operation refused (avoiding entry misjudgment)',
  ],
  'store.removed': ['已删除条目（{target}：{before} → {after} 条）', 'Entry deleted ({target}: {before} → {after} entries)'],
  'store.emptyEntry': ['条目不能为空', 'Entry must not be empty'],
  'store.sectionDelimiter': [
    '内容不能包含条目分隔符 §（会破坏记忆文件的分割格式）',
    'Content must not contain the entry delimiter § (it would corrupt the memory file format)',
  ],
}

/** Store tail messages (archive helpers / manual edit paths, lib/store.js). */
export const STORE_TAIL_DICT = {
  'storetail.mainMissing': [
    '主轨不存在该条目（可能已被删除）——未写入归档',
    'The main track no longer has this entry (already deleted?) — nothing was archived',
  ],
  'storetail.entryMissing': [
    '条目不存在（可能已被删除，或文件被外部修改）——请刷新列表后重试',
    'Entry not found (deleted, or the file changed externally) — refresh the list and retry',
  ],
  'storetail.branchKeyOnly': ['分支范围仅适用于 key 轨', 'Branch scoping applies to the key track only'],
  'storetail.dshOnlyTrackLimit': [
    '「仅 DSH」标记仅适用于 memory / user / key 轨',
    'The [dsh-only] marker applies to memory / user / key tracks only',
  ],
  'storetail.emptyContentTab': [
    '内容不能为空（删除条目请用删除按钮）',
    'Content must not be empty (use the delete button to remove an entry)',
  ],
  'storetail.sectionDelimiter': [
    '内容不能包含条目分隔符 §（会破坏记忆文件的分割格式）',
    'Content must not contain the entry delimiter § (it would corrupt the memory file format)',
  ],
  'storetail.unrecognizedPrefix': [
    '该条目没有可识别的标记前缀（时间戳/tag），无法安全编辑——请用系统工具打开文件手动修改',
    'This entry lacks a recognizable tag prefix (timestamp/tag); it cannot be edited safely — open the file with a system tool and edit it manually',
  ],
  'storetail.updated': ['已更新条目（{target}）', 'Entry updated ({target})'],
  'storetail.archiveNoMatch': ['归档中没有条目包含片段 "{match}"', 'No archive entry contains the substring "{match}"'],
  'storetail.archiveMultiMatch': [
    '片段 "{match}" 匹配到 {count} 个归档条目，请用更精确的片段',
    'The substring "{match}" matches {count} archive entries; use a more precise substring',
  ],
  'storetail.archiveEntryMissing': [
    '归档条目不存在（可能已被删除）——请刷新列表后重试',
    'Archive entry not found (already deleted?) — refresh the list and retry',
  ],
}

/** Suggestion queue / review command strings (lib/review.js). */
export const REVIEW_CMD_DICT = {
  'reviewcmd.dedup': [
    '该内容此前已建议（累计第 {hits} 次），已更新证据，等待用户确认',
    'This content was proposed before (hit #{hits}); evidence updated, awaiting user confirmation',
  ],
  'reviewcmd.writtenMemory': ['✓ #{n} [{target}] 已写入记忆', '✓ #{n} [{target}] written into memory'],
  'reviewcmd.writtenTodo': ['✓ #{n} [{target}] 已写入待办', '✓ #{n} [{target}] written into todos'],
  'reviewcmd.existsSkip': ['- #{n} [{target}] 已存在，跳过', '- #{n} [{target}] already exists; skipped'],
  'reviewcmd.failed': ['✗ #{n} [{target}] {detail}', '✗ #{n} [{target}] {detail}'],
  'reviewcmd.remaining': ['剩余待确认：{count} 条', '{count} suggestion(s) pending confirmation'],
  'reviewcmd.emptyQueue': ['没有待确认的记忆建议。', 'No memory suggestions are pending confirmation.'],
  'reviewcmd.listHead': ['待确认的记忆建议（{count} 条）：', 'Memory suggestions pending confirmation ({count}):'],
  'reviewcmd.entryLine': [
    '{i}. [{target}] {content}（理由：{reason}）',
    '{i}. [{target}] {content} (reason: {reason})',
  ],
  'reviewcmd.noReason': ['无', 'none'],
  'reviewcmd.usageApprove': ['用法：approve <序号>…（序号来自 list）', 'Usage: approve <index>… (indices come from list)'],
  'reviewcmd.usageArchive': ['用法：archive <序号>…（序号来自 list）', 'Usage: archive <index>… (indices come from list)'],
  'reviewcmd.usageReject': ['用法：reject <序号>…（序号来自 list）', 'Usage: reject <index>… (indices come from list)'],
  'reviewcmd.rejectedSome': [
    '已拒绝 {count} 条建议。剩余待确认：{remaining} 条',
    'Rejected {count} suggestion(s). {remaining} still pending confirmation',
  ],
  'reviewcmd.rejectedAll': ['已拒绝全部 {count} 条建议。', 'Rejected all {count} suggestion(s).'],
}

/** Misc host strings: sync stub commands, archive promotion, review command ops. */
export const MISC_DICT = {
  'misc.syncNotReady': ['记忆同步未初始化', 'Memory sync is not initialized'],
  'misc.archiveNoMatch': [
    '归档中没有条目包含片段 "{match}"',
    'No archive entry contains the substring "{match}"',
  ],
  'misc.archiveMultiMatch': [
    '片段 "{match}" 匹配到 {count} 个归档条目，请用更精确的片段',
    'The substring "{match}" matches {count} archive entries; use a more precise substring',
  ],
  'misc.promoteEmpty': ['归档条目内容为空，无法转正', 'Archive entry content is empty; cannot promote it'],
  'misc.promoted': [
    '已转正写入 {target}（{chars} 字符），归档条目已移除',
    'Promoted into {target} ({chars} chars); the archive entry was removed',
  ],
  'misc.unknownOp': [
    '未知操作 "{op}"（支持：list / approve / archive / reject / approve-all / reject-all）',
    'Unknown operation "{op}" (supported: list / approve / archive / reject / approve-all / reject-all)',
  ],
}

/** Todo execute-time messages (lib/todo.js). */
export const TODO_MSG_DICT = {
  'todomsg.emptyContent': ['待办内容不能为空', 'Todo content must not be empty'],
  'todomsg.added': ['已添加待办（{target}：{count} 条）', 'Todo added ({target}: {count} item(s))'],
  'todomsg.notFoundTrack': [
    '没有找到 id 为 "{id}" 的待办（{target} 轨）',
    'No todo with id "{id}" ({target} track)',
  ],
  'todomsg.notFound': ['没有找到 id 为 "{id}" 的待办', 'No todo with id "{id}"'],
  'todomsg.gone': [
    '该待办已被删除（可能在其他窗口操作）——请刷新后重试',
    'This todo was already deleted (edited in another window?) — refresh and retry',
  ],
  'todomsg.updated': ['已更新待办（{target}）', 'Todo updated ({target})'],
  'todomsg.deleted': ['已删除待办（{target}）', 'Todo deleted ({target})'],
  'todomsg.invalidTarget': [
    '无效 target "{target}"（应为 {valid}）',
    'Invalid target "{target}" (expected one of {valid})',
  ],
  'todomsg.unknownAction': ['未知 action "{action}"', 'Unknown action "{action}"'],
}

/** Skill execute-time messages (lib/skills.js). */
export const SKILL_MSG_DICT = {
  'skillmsg.invalidNameShort': ['无效技能名 "{name}"', 'Invalid skill name "{name}"'],
  'skillmsg.pendingMissing': ['待确认技能 "{name}" 不存在', 'Pending skill "{name}" does not exist'],
  'skillmsg.alreadyInLib': [
    '技能 "{name}" 已存在于技能库，请先处理再采纳',
    'Skill "{name}" already exists in the library; resolve it before adopting',
  ],
  'skillmsg.listHead': ['技能库（{count} 个）：', 'Skill library ({count}):'],
  'skillmsg.invalidNameCase': [
    '无效技能名 "{name}"（必须 kebab-case 小写）',
    'Invalid skill name "{name}" (must be lowercase kebab-case)',
  ],
  'skillmsg.missing': ['技能 "{name}" 不存在', 'Skill "{name}" does not exist'],
  'skillmsg.read': ['已读取技能 "{name}"（{bytes} 字节）', 'Read skill "{name}" ({bytes} bytes)'],
  'skillmsg.existsUsePatch': [
    '技能 "{name}" 已存在，请改用 patch 更新',
    'Skill "{name}" exists; use patch to update it',
  ],
  'skillmsg.pendingDuplicate': [
    '待确认队列已有技能 "{name}"，请勿重复创建（可在设置面板处理）',
    'The pending queue already holds "{name}"; do not create it twice (handle it in the settings panel)',
  ],
  'skillmsg.createdPending': [
    '技能 "{name}" 已创建到待确认队列（等待用户在设置面板确认采纳，采纳后才会进入技能库）',
    'Skill "{name}" entered the pending queue (it joins the library only after the user adopts it in the settings panel)',
  ],
  'skillmsg.created': ['技能 "{name}" 已创建（{bytes} 字节）', 'Skill "{name}" created ({bytes} bytes)'],
  'skillmsg.missingUseCreate': [
    '技能 "{name}" 不存在，请改用 create',
    'Skill "{name}" does not exist; use create first',
  ],
  'skillmsg.readFirst': [
    '更新技能 "{name}" 前必须先读取它：请先调用 {tool} action=read name={name}',
    'Read skill "{name}" before updating it: call {tool} action=read name={name} first',
  ],
  'skillmsg.updated': ['技能 "{name}" 已更新（{bytes} 字节）', 'Skill "{name}" updated ({bytes} bytes)'],
  'skillmsg.unknownAction': [
    '未知操作 "{action}"（支持 create / patch / read / list）',
    'Unknown action "{action}" (supported: create / patch / read / list)',
  ],
}

/** Prompt tool messages (lib/prompts.js). */
export const PROMPT_DICT = {
  'promptmsg.injectedOnce': [
    '【立即注入】提示词「{name}」已生效（仅此一次）——请查看快照「用户规则」并立即遵循。',
    '[Injected now] Prompt "{name}" took effect (this turn only) — see the "User rules" snapshot section and follow it immediately.',
  ],
  'promptmsg.getNeedsId': ['get 需要 id（来自 list 返回）', 'get needs an id (as returned by list)'],
  'promptmsg.missingGet': ['提示词不存在：{id}（可先 list 查看可用提示词）', 'Prompt not found: {id} (run list to see available prompts)'],
  'promptmsg.detail': [
    '「{name}」详情（{status}，已注入 {count} 次）',
    '"{name}" details ({status}, injected {count} time(s))',
  ],
  'promptmsg.enabled': ['启用中', 'enabled'],
  'promptmsg.disabled': ['已禁用', 'disabled'],
  'promptmsg.created': [
    '已创建提示词「{name}」（分类：{category}，id={id}）——可 inject 注入当前会话，或 update <id> 继续修改',
    'Prompt "{name}" created (category: {category}, id={id}) — inject it into the current session, or update <id> to keep editing',
  ],
  'promptmsg.updateNeedsId': [
    'update 需要 id（来自 list 返回或 create 结果）',
    'update needs an id (from list output or the create result)',
  ],
  'promptmsg.updateNoFields': [
    'update 至少要改一个字段（name/content/description/category/tags/enabled）',
    'update must change at least one field (name/content/description/category/tags/enabled)',
  ],
  'promptmsg.updated': [
    '已更新提示词「{name}」（分类：{category}，enabled={enabled}）',
    'Prompt "{name}" updated (category: {category}, enabled={enabled})',
  ],
  'promptmsg.injectNeedsId': ['inject 需要 id（来自 list 返回）', 'inject needs an id (as returned by list)'],
  'promptmsg.missingInject': ['提示词不存在：{id}（可先 list 查看可用提示词）', 'Prompt not found: {id} (run list to see available prompts)'],
  'promptmsg.cannotInjectDisabled': [
    '「{name}」已禁用，不能注入（可在 GUI 提示词库中重新启用）',
    '"{name}" is disabled and cannot be injected (re-enable it in the GUI prompt library)',
  ],
  'promptmsg.alreadyInjecting': [
    '「{name}」已在注入中（可先在 GUI「注入中」移除再重新注入）',
    '"{name}" is already injecting (remove it from the GUI "Injecting" list, then inject again)',
  ],
  'promptmsg.injectNow': [
    '已立即注入「{name}」：当前回合生效，仅此一次（不受次数/间隔影响）{tail}',
    'Injected "{name}" now: takes effect this turn, once only (ignores count/interval){tail}',
  ],
  'promptmsg.steerMissed': ['（插话未送达——将在下一轮生效）', '(the interjection was not delivered — it applies next turn instead)'],
  'promptmsg.roundsInvalid': ['rounds 必须是 ≥1 的整数，或 0 表示无限', 'rounds must be an integer ≥1, or 0 for unlimited'],
  'promptmsg.everyInvalid': ['every 必须是 ≥0 的整数（0 = 只注入一次）', 'every must be an integer ≥0 (0 = inject once)'],
  'promptmsg.injectScheduled': [
    '已注入「{name}」：{times}{cadence}，模型下一轮生效{ending}',
    'Injected "{name}": {times}{cadence}; the model picks it up next turn{ending}',
  ],
  'promptmsg.unknownAction': [
    '未知 action：{action}（支持 list / get / inject）',
    'Unknown action {action} (supported: list / get / inject)',
  ],
}

/** de_session (session-orch) messages (lib/session-orch.js). */
export const SESSION_DICT = {
  'ses.msg.renameNeedsSid': ['rename 必填 sessionId（要改名的会话）', 'rename needs sessionId (the session to rename)'],
  'ses.msg.renameNeedsOne': [
    'rename 至少提供 title（会话名称）或 alias（会话别名）之一',
    'rename needs at least one of title (session name) or alias (session alias)',
  ],
  'ses.msg.notLoadedRename': [
    '会话 {sid} 不在当前进程，无法改名称（可先 wake 恢复再改，或用 list 确认 ID）',
    'Session {sid} is not loaded in this process; cannot rename it (wake it first, or confirm the ID with list)',
  ],
  'ses.msg.renameFailed': ['改会话名称失败: {detail}', 'Renaming failed: {detail}'],
  'ses.msg.aliasStoreMissing': ['别名存储不可用（aliases.json）', 'Alias storage unavailable (aliases.json)'],
  'ses.msg.noRequester': ['无法获取当前会话信息（调用上下文缺少 agent）', 'Cannot resolve the current session (call context lacks an agent)'],
  'ses.msg.noSelfId': ['无法获取当前会话 ID', 'Cannot resolve the current session ID'],
  'ses.msg.spawnNeedsPrompt': [
    'spawn 必填 prompt（新会话的完整提示词，可长文本自由组合：角色/任务/要求一次写清）',
    'spawn needs prompt (the new session\'s full brief — role/task/requirements may be one long free-form text)',
  ],
  'ses.msg.badPreset': [
    'agentPreset 格式不合法："{preset}"（须匹配 [a-z0-9][a-z0-9-]*，如 code/cordis/minimal/standard）',
    'Invalid agentPreset "{preset}" (must match [a-z0-9][a-z0-9-]*, e.g. code/cordis/minimal/standard)',
  ],
  'ses.msg.spawnFailed': ['创建会话失败: {detail}', 'Session creation failed: {detail}'],
  'ses.msg.dispatchFailed': [
    '会话 {sid} 已创建但派发初始任务失败: {detail}',
    'Session {sid} was created but dispatching its initial task failed: {detail}',
  ],
  'ses.msg.spawned': [
    '已创建会话 {sid} 并开始执行任务{notes}',
    'Session {sid} created and task started{notes}',
  ],
  'ses.msg.wakeNeedsSid': ['wake 必填 sessionId（要唤醒的会话 ID）', 'wake needs sessionId (the session to wake)'],
  'ses.msg.wakeNeedsPrompt': [
    'wake 必填 prompt（要对方做的事，如"现在开始执行：…"）',
    'wake needs prompt (what the other session should do, e.g. "start now: …")',
  ],
  'ses.msg.wakeRestoreFailed': [
    '会话 {sid} 不在当前进程且自动恢复失败（可能不存在/是跨实例会话/持久化不可用）: {detail}',
    'Session {sid} is not in this process and auto-restore failed (missing? cross-instance? persistence unavailable?): {detail}',
  ],
  'ses.msg.wakeFailed': ['唤醒会话 {sid} 失败: {detail}', 'Waking session {sid} failed: {detail}'],
  'ses.msg.wakeQueued': [
    '指令已送达会话 {sid}（已入队）。⚠️ 送达≠成功：对方实际能否跑起来需**稍后确认**——离线恢复或模型配置缺失时回合可能失败。等几秒后 de_session status 查它是否 running；忙完前不要重复派活',
    'Delivered to session {sid} (queued). ⚠️ Delivered ≠ succeeded: confirm later that it actually runs — a restored offline session or a missing model config can fail the turn. Check de_session status after a few seconds; do not re-dispatch while it is busy',
  ],
  'ses.msg.statusNeedsSid': ['status 必填 sessionId', 'status needs a sessionId'],
  'ses.msg.statusOffline': [
    '会话不在当前进程（离线或不存在；同实例会话重启后会自动恢复）',
    'Session is not loaded in this process (offline or nonexistent; same-instance sessions restore automatically after a restart)',
  ],
  'ses.msg.statusLine': [
    '会话 {sid} 状态：{status}（{detail}）',
    'Session {sid} status: {status} ({detail})',
  ],
  'ses.msg.statusRunning': ['正在生成', 'generating'],
  'ses.msg.statusIdle': ['空闲，等指令', 'idle, awaiting instructions'],
  'ses.msg.findNeedsQuery': [
    'find 必填 query（要查找的名称/别名/ID 关键字）',
    'find needs query (a name/alias/ID keyword to search for)',
  ],
  'ses.msg.broadcastDisabled': [
    '广播模块未启用（可在运行时配置打开「会话广播」）',
    'The broadcast module is disabled (turn on "session broadcast" in the runtime configuration)',
  ],
  'ses.msg.orchNotReady': ['会话编排未就绪（DSH agents 服务不可用）', 'Session orchestration not ready (the DSH agents service is unavailable)'],
  'ses.msg.unknownAction': ['未知 action "{action}"', 'Unknown action "{action}"'],
  'ses.msg.actionFailed': ['de_session {action} 失败: {detail}', 'de_session {action} failed: {detail}'],
}

/** Small-module messages: search-docs, advisor, aliases, api, canvas, update, notify. */
export const MISC2_DICT = {
  'sd.badExts': ['exts 参数格式不正确（应为扩展名数组或逗号分隔字符串）', 'Invalid exts parameter (expected an array or comma-separated string of extensions)'],
  'sd.contentNeedsQuery': ['内容检索需要关键词：请提供 contentQuery，或同时提供 query（content=true 时复用 query）', 'Content search needs keywords: provide contentQuery, or supply query too (content=true reuses query)'],
  'sd.enabled': ['已启用本地文档搜索工具（{tool}）。provider 链：{chain}', 'Local docs search enabled ({tool}). Provider chain: {chain}'],
  'sd.disabled': ['已禁用本地文档搜索工具：工具已从模型可见列表中移除', 'Local docs search disabled: the tool was removed from the model-visible list'],
  'sd.status': ['本地文档搜索工具：{state}\n工具名：{tool}\nprovider 链：{chain}\n默认扩展名：{exts}\n用法：/memory_evolve_search_docs on|off', 'Local docs search: {state}\nTool name: {tool}\nProvider chain: {chain}\nDefault extensions: {exts}\nUsage: /memory_evolve_search_docs on|off'],
  'sd.on': ['已启用', 'enabled'],
  'sd.off': ['已禁用（默认）', 'disabled (default)'],
  'adv.noSession': ['无法识别当前会话', 'Cannot identify the current session'],
  'adv.globalOff': ['Advisor 全局开关未开启：请先在 设置 → 配置 打开「会话评审（Advisor）」，再为会话单独{verb}', 'The Advisor global switch is off: enable "Session review (Advisor)" under Settings → Configuration first, then toggle this session {verb}'],
  'adv.cannotReset': ['无法重置：本会话 Advisor 未启用或运行时不可用', 'Cannot reset: Advisor is not enabled for this session or its runtime is unavailable'],
  'adv.resetDone': ['已新建评审会话（#{epoch}）——评审员上下文已清空，可在第一条指令中告知背景信息。', 'Review session restarted (#{epoch}) — the reviewer context is clear; you may provide background in your first instruction.'],
  'adv.tellEmpty': ['指令不能为空：/advisor tell <指令内容>', 'Instruction must not be empty: /advisor tell <instruction>'],
  'adv.tellQueued': ['指令已入队：{text}', 'Instruction queued: {text}'],
  'adv.rateLimited': ['评审调用被限流：{detail}', 'Review call rate-limited: {detail}'],
  'adv.droppedAfterRetries': ['评审调用多次失败，本轮丢弃', 'Review call failed repeatedly; dropped for this turn'],
  'adv.aborted': ['评审被中止（会话销毁/停用）', 'Review aborted (session destroyed or disabled)'],
  'adv.deliveryFailed': ['投递失败（缺 agent 或 steer 抛错）', 'Delivery failed (missing agent or steer threw)'],
  'adv.emptyAnswer': ['advisor 问答返回空回答', 'The advisor Q&A returned an empty answer'],
  'adv.recordTooLarge': ['评审记录超限（{bytes} 字节），已跳过落盘', 'Review record exceeds the size limit ({bytes} bytes); not persisted'],
  'adv.recordWriteFailed': ['评审记录落盘失败：{detail}', 'Persisting the review record failed: {detail}'],
  'adv.lineCorrupt': ['records.jsonl 第 {line} 行损坏，已跳过：{detail}', 'records.jsonl line {line} is corrupt and was skipped: {detail}'],
  'alias.needsSid': ['会话 id 不能为空', 'Session id must not be empty'],
  'alias.cleared': ['已清除会话别名', 'Session alias cleared'],
  'alias.tooLong': ['别名最多 {max} 个字（当前 {len} 字）', 'Alias is limited to {max} chars (got {len})'],
  'alias.set': ['会话别名已设为「{alias}」', 'Session alias set to "{alias}"'],
  'api.syncNotAssembled': ['同步模块未装配', 'Sync module is not assembled'],
  'api.archivedOk': ['已归档（{target}：归档文件现有 {count} 条；{detail}）', 'Archived ({target}: the archive file now holds {count} entries; {detail})'],
  'canvas.failed': ['画板操作失败：{detail}', 'Canvas operation failed: {detail}'],
  'canvas.unknownError': ['未知错误', 'unknown error'],
  'upd.notGitRepo': ['插件目录不是 git 仓库或 git 不可用（请用 git clone 安装）', 'The plugin directory is not a git repo or git is unavailable (install via git clone)'],
  'upd.remoteCheckFailed': ['远端检测失败（{kind}）', 'Remote check failed ({kind})'],
  'notify.missing': ['通知 {id} 不存在', 'Notification {id} does not exist'],
}

/** COI broadcast messages (lib/coi/broadcast.js). */
export const BROADCAST_DICT = {
  'bc.attachLimit': ['图片附件数量超限：最多 {max} 张（收到 {count} 张）', 'Too many image attachments: at most {max} (got {count})'],
  'bc.needsCreator': ['创建者会话 id 不能为空', 'Creator session id must not be empty'],
  'bc.roomCreated': ['房间「{name}」已创建（你是成员；告诉其他人房间 id {id} 让它们 room-join）', 'Room "{name}" created (you are a member; share room id {id} so others can room-join)'],
  'bc.roomMissingJoin': ['房间 {id} 不存在（请向创建者确认房间 id）', 'Room {id} does not exist (confirm the room id with its creator)'],
  'bc.roomDissolved': ['房间「{name}」已解散，无法加入', 'Room "{name}" was dissolved; cannot join'],
  'bc.joined': ['已加入房间「{name}」（成员 {count} 人）', 'Joined room "{name}" ({count} member(s))'],
  'bc.roomMissing': ['房间 {id} 不存在', 'Room {id} does not exist'],
  'bc.leftAutoDissolved': ['已退出，房间 {id} 无成员已解散（记录保留可追溯）', 'Left; room {id} had no members and was dissolved (records kept for traceability)'],
  'bc.left': ['已退出房间「{name}」（剩 {count} 人）', 'Left room "{name}" ({count} member(s) remain)'],
  'bc.onlyCreatorDissolve': ['只有创建者可以解散房间', 'Only the creator can dissolve the room'],
  'bc.alreadyDissolved': ['房间「{name}」已是解散状态', 'Room "{name}" is already dissolved'],
  'bc.dissolved': ['房间「{name}」已解散', 'Room "{name}" dissolved'],
  'bc.memberNotInRoom': ['成员 {member} 不在房间中', 'Member {member} is not in the room'],
  'bc.kickedAutoDissolved': ['已踢出 {member}，房间无成员已解散', 'Kicked {member}; the room has no members and was dissolved'],
  'bc.kicked': ['已踢出成员 {member}（剩 {count} 人）', 'Member {member} kicked ({count} member(s) remain)'],
  'bc.needsSender': ['发送方会话 id 不能为空', 'Sender session id must not be empty'],
  'bc.badRecipients': ['recipients 必须是非空数组（会话 ID 或 room:/project: 伪接收者）', 'recipients must be a non-empty array (session IDs or room:/project: pseudo-recipients)'],
  'bc.sendRoomMissing': ['房间 {id} 不存在（先 room-create，或向创建者确认房间 id 后 room-join）', 'Room {id} does not exist (room-create first, or confirm the id with the creator and room-join)'],
  'bc.sendRoomDissolved': ['房间「{name}」已解散，无法发消息', 'Room "{name}" was dissolved; cannot send messages'],
  'bc.notMember': ['你不是房间「{name}」的成员（先 room-join 加入）', 'You are not a member of room "{name}" (room-join first)'],
  'bc.projectNeedsPath': ['project: 后必须跟工作目录绝对路径，如 project:/Volumes/data/proj', 'project: must be followed by an absolute working-directory path, e.g. project:/Volumes/data/proj'],
  'bc.emptyContent': ['消息内容不能为空', 'Message content must not be empty'],
  'bc.sent': ['广播已发送（{count} 个接收目标{tail}）', 'Broadcast sent ({count} recipient(s){tail})'],
  'bc.sentImages': ['，图片 {count} 张', ', {count} image(s)'],
  'bc.wokenTail': ['；已唤醒 {count} 个空闲接收方（其余为运行中=同回合可见，或离线=仅收件箱）', '; woke {count} idle recipient(s) (others: running = same-turn delivery, or offline = inbox only)'],
  'bc.msgMissing': ['消息 {id} 不存在', 'Message {id} does not exist'],
  'bc.msgInvisible': ['该消息对当前会话不可见，无法读取', 'This message is not visible to the current session and cannot be read'],
  'bc.msgDetail': ['消息 {id}（{sender} → {recipients}）', 'Message {id} ({sender} → {recipients})'],
  'bc.onlySenderOrRecipient': ['只有发送方或接收方可删除该消息', 'Only the sender or a recipient can delete this message'],
  'bc.deleted': ['已删除消息 {id}', 'Message {id} deleted'],
  'bc.imagesDisabled': ['图片附件未启用（配置项 broadcastImageEnabled=false；开启后才能带图发送）', 'Image attachments are disabled (config broadcastImageEnabled=false; enable it to send images)'],
  'bc.attachFailed': ['附件处理失败：{detail}', 'Attachment processing failed: {detail}'],
  'bc.listHead': ['消息（{label} {count} 条）', 'Messages ({label}: {count})'],
  'bc.readNeedsIds': ['read 必填 id 或 ids（消息 id）', 'read needs id or ids (message ids)'],
  'bc.readDone': ['已读取 {count} 条{tail}', '{count} message(s) read{tail}'],
  'bc.readSkipped': ['，跳过 {count} 条（不可见/不存在）', ', skipped {count} (invisible/missing)'],
  'bc.kickRoomMissing': ['房间 {id} 不存在', 'Room {id} does not exist'],
  'bc.onlyCreatorKick': ['只有创建者可以踢人', 'Only the creator can kick members'],
  'bc.presenceDisabled': ['在线状态追踪未启用', 'Presence tracking is not enabled'],
  'bc.presenceOne': ['会话 {sid} 状态', 'Session {sid} presence'],
  'bc.presenceList': ['房间「{name}」成员在线状态（{online}/{total} 在线）', 'Room "{name}" member presence ({online}/{total} online)'],
  'bc.unknownAction': ['未知 action "{action}"', 'Unknown action "{action}"'],
}

/** COI scheduler + command messages (lib/coi/scheduler.js, lib/coi/commands.js). */
export const COI_DICT = {
  'coi.template.name.review-code': ['Review 代码', 'Code review'],
  'coi.template.name.fix-tests': ['修复测试', 'Fix tests'],
  'coi.template.name.summarize-logs': ['总结日志', 'Summarize logs'],
  'coi.template.name.architecture-analysis': ['架构分析', 'Architecture analysis'],
  'coi.disposed': ['调度器已销毁', 'The scheduler has been disposed'],
  'coi.adapterUnknownHint': ['未知适配器 "{id}"（可用 de_coi_adapters 查看可用适配器与适用场景）', 'Unknown adapter "{id}" (run de_coi_adapters to list adapters and their use cases)'],
  'coi.adapterDisabled': ['适配器 {id}（{name}）已被禁用。可用适配器：{available}（可用 de_coi_adapters 查看适用场景）', 'Adapter {id} ({name}) is disabled. Available adapters: {available} (see de_coi_adapters for use cases)'],
  'coi.emptyPrompt': ['任务内容不能为空', 'Task prompt must not be empty'],
  'coi.badScope': ['scope 必须是 {valid}', 'scope must be one of {valid}'],
  'coi.noImageSupport': [
    '适配器 {id}（{name}）不支持图片附件。支持图片的适配器：codex（-i 参数）/ hermes（--image 参数）/ kimi（prompt 附图片路径读图）/ grok（prompt 附图片路径读图，待实测验证）；zcode 为纯文本通道不可识图',
    'Adapter {id} ({name}) does not support image attachments. Image-capable adapters: codex (-i flag) / hermes (--image flag) / kimi (attach the image path in the prompt) / grok (same as kimi; unverified); zcode is text-only and cannot read images',
  ],
  'coi.refMissing': ['引用的任务 {id} 不存在', 'Referenced task {id} does not exist'],
  'coi.dispatched': ['已发起 {name} 任务 {taskId}（scope={scope}）', 'Dispatched {name} task {taskId} (scope={scope})'],
  'coi.taskMissing': ['任务 {id} 不存在', 'Task {id} does not exist'],
  'coi.stopConfirm': ['确认终止任务 {id}（{adapter}：{preview}）？再次调用并带 force=true 才执行', 'Confirm stopping task {id} ({adapter}: {preview})? Call again with force=true to proceed'],
  'coi.stopped': ['任务 {id} 已终止', 'Task {id} stopped'],
  'coi.waitAborted': ['等待已取消（会话已停止）', 'Wait cancelled (the session was stopped)'],
  'coi.waitTimeout': ['等待超时（{timeout}ms），任务仍在运行，可用 de_coi_status 再查', 'Wait timed out after {timeout}ms; the task is still running — check again with de_coi_status'],
  'coi.testAdapterUnknown': ['未知适配器 "{id}"', 'Unknown adapter "{id}"'],
  'coi.testAdapterDisabled': ['适配器 {id} 已被禁用，无法测试', 'Adapter {id} is disabled and cannot be tested'],
  'coi.testNoCmd': ['适配器 {id} 未配置 testCmd', 'Adapter {id} has no testCmd configured'],
  'coi.startFailed': ['启动失败: {detail}', 'Start failed: {detail}'],
  'coi.testStarted': ['测试任务 {id} 已启动', 'Test task {id} started'],
  'coicmd.runUsage': ['用法：/de_coi run "<任务>" [--coi kimi] [--scope session] [--session <id>] [--branch <b>] [--model <m>] [--ref <taskId>] [--template <id>] [--continue] [--inject-tracks memory,user,key] [--context-text <文本>]', 'Usage: /de_coi run "<task>" [--coi kimi] [--scope session] [--session <id>] [--branch <b>] [--model <m>] [--ref <taskId>] [--template <id>] [--continue] [--inject-tracks memory,user,key] [--context-text <text>]'],
  'coicmd.dispatched': ['✅ {message}\n查看进度：/de_coi log {taskId}', '✅ {message}\nTrack progress: /de_coi log {taskId}'],
  'coicmd.noTasks': ['（暂无任务）', '(no tasks yet)'],
  'coicmd.taskList': ['任务（{count} 条）：\n{lines}', 'Tasks ({count}):\n{lines}'],
  'coicmd.logUsage': ['用法：/de_coi log <taskId> [--tail <字符数>]', 'Usage: /de_coi log <taskId> [--tail <chars>]'],
  'coicmd.stopUsage': ['用法：/de_coi stop <taskId> [--force]（终止需二次确认；--all 需同时带 --force）', 'Usage: /de_coi stop <taskId> [--force] (stopping needs a second confirmation; --all additionally requires --force)'],
  'coicmd.stopAllConfirm': ['⚠️ 终止全部任务需二次确认：/de_coi stop --all --force', '⚠️ Stopping every task needs a second confirmation: /de_coi stop --all --force'],
  'coicmd.stoppedMany': ['已终止 {count} 个任务', '{count} task(s) stopped'],
  'coicmd.stopOneConfirm': ['⚠️ 确认终止任务 {id}（{adapter}：{preview}）？确认请再次执行：/de_coi stop {id} --force', '⚠️ Confirm stopping task {id} ({adapter}: {preview})? Run /de_coi stop {id} --force again to confirm'],
  'coicmd.noSessions': ['（暂无会话记录）', '(no session records yet)'],
  'coicmd.sessionList': ['会话（{count} 条）：\n{lines}', 'Sessions ({count}):\n{lines}'],
  'coicmd.noteUsage': ['用法：/de_coi sessions note <sessionId> <备注>', 'Usage: /de_coi sessions note <sessionId> <note>'],
  'coicmd.rmUsage': ['用法：/de_coi sessions rm <sessionId>', 'Usage: /de_coi sessions rm <sessionId>'],
  'coicmd.sessionsSubs': ['sessions 子命令：list / note <id> <备注> / rm <id>', 'sessions subcommands: list / note <id> <note> / rm <id>'],
  'coicmd.adapterUnknown': ['未知适配器 {id}', 'Unknown adapter {id}'],
  'coicmd.adapterShow': ['{id} — {name}\n类型：{type}\n命令：{cmd}\n{guide}', '{id} — {name}\nType: {type}\nCommand: {cmd}\n{guide}'],
  'coicmd.adapterGuide': ['指南：\n{guide}', 'Guide:\n{guide}'],
  'coicmd.adaptersSubs': ['adapters 子命令：list / show <id> / test <id> / enable <id> / disable <id>', 'adapters subcommands: list / show <id> / test <id> / enable <id> / disable <id>'],
  'coicmd.templatesSubs': ['templates 子命令：list', 'templates subcommands: list'],
  'coicmd.exportUsage': ['用法：/de_coi export <sessionId> [--coi kimi]', 'Usage: /de_coi export <sessionId> [--coi kimi]'],
  'coicmd.exportUnsupported': ['适配器 {id} 不支持会话导出', 'Adapter {id} does not support session export'],
  'coicmd.exportStarted': ['导出任务已启动（{cmd}），完成后输出在 {outFile}', 'Export task started ({cmd}); output will land in {outFile}'],
}
export const HELP_EXTRA = {
  'coicmd.help': [
    `de_coi — COI 调度命令族
  /de_coi run "<任务>" [--coi kimi|codex|grok|hermes] [--scope temporary|session|project|global] [--session <id>] [--branch <b>] [--model <m>] [--ref <taskId>] [--template <id>] [--continue] [--inject-context] [--context-text <文本>]
  /de_coi list [--coi <id>] [--status <s>] [--limit <n>] [--q <关键词>]
  /de_coi log <taskId> [--tail <字符数>]
  /de_coi stop <taskId> [--force]（终止需二次确认；--all 需 --force --all）
  /de_coi sessions [list|note <id> <备注>|rm <id>] [--scope] [--branch] [--q]
  /de_coi adapters [list|show <id>|test <id>|enable <id>|disable <id>]
  /de_coi stats
  /de_coi templates list
  /de_coi export <sessionId> [--coi <id>]`,
    `de_coi — COI dispatch command family
  /de_coi run "<task>" [--coi kimi|codex|grok|hermes] [--scope temporary|session|project|global] [--session <id>] [--branch <b>] [--model <m>] [--ref <taskId>] [--template <id>] [--continue] [--inject-context] [--context-text <text>]
  /de_coi list [--coi <id>] [--status <s>] [--limit <n>] [--q <keyword>]
  /de_coi log <taskId> [--tail <chars>]
  /de_coi stop <taskId> [--force] (stopping needs a second confirmation; --all requires --force --all)
  /de_coi sessions [list|note <id> <note>|rm <id>] [--scope] [--branch] [--q]
  /de_coi adapters [list|show <id>|test <id>|enable <id>|disable <id>]
  /de_coi stats
  /de_coi templates list
  /de_coi export <sessionId> [--coi <id>]`,
  ],
}

/** COI adapters/api/index/session/tasks/tools/ws-coord messages. */
export const COI2_DICT = {
  'coi2.adapterUnknown': ['未知适配器 "{id}"', 'Unknown adapter "{id}"'],
  'coi2.enabledMustBeBool': ['enabled 必须是布尔值', 'enabled must be a boolean'],
  'coi2.adapterToggled': ['{name} 已{state}', '{name} {state}'],
  'coi2.stateOn': ['启用', 'enabled'],
  'coi2.stateOff': ['禁用', 'disabled'],
  'coi2.builtinUndeletable': ['内置适配器不可删除', 'Built-in adapters cannot be deleted'],
  'coi2.skillIoUnavailable': ['技能读写不可用', 'Skill read/write is unavailable'],
  'coi2.skillExistsUnchanged': ['技能 {skill} 已存在，内容未改动（可在适配器页「技能」按钮编辑）', 'Skill {skill} already exists; content unchanged (edit it via the "Skill" button on the adapter page)'],
  'coi2.skillAutoCreated': ['技能 {skill} 已自动创建（AI 可见，技能管理 Tab 可禁用）', 'Skill {skill} created automatically (visible to AI; disable it from the Skill Management tab)'],
  'coi2.skillCreateFailed': ['技能创建失败：{detail}', 'Creating the skill failed: {detail}'],
  'coi2.sessionIdEmpty': ['sessionId 不能为空', 'sessionId must not be empty'],
  'coi2.exportUnsupportedApi': ['适配器 {id} 不支持会话导出', 'Adapter {id} does not support session export'],
  'coi2.exportStartedApi': ['导出任务已启动，输出将写入 {outFile}', 'Export task started; output will be written to {outFile}'],
  'coi2.unknownRoute': ['未知路由 {path}', 'Unknown route {path}'],
  'coi2.attachMustBeArray': ['attachments 必须是数组', 'attachments must be an array'],
  'coi2.attachLimit': ['图片附件最多 {max} 张（收到 {count} 张）', 'At most {max} image attachments (got {count})'],
  'coi2.attachNotObject': ['第 {n} 个附件必须是对象', 'Attachment #{n} must be an object'],
  'coi2.attachKindUnsupported': ['第 {n} 个附件类型 "{kind}" 暂不支持（当前仅支持图片 image）', 'Attachment #{n}: kind "{kind}" is not supported yet (only images are supported)'],
  'coi2.attachNoSource': ['第 {n} 个附件缺少来源（path / url / attachmentId 三选一）', 'Attachment #{n} has no source (one of path / url / attachmentId)'],
  'coi2.attachMultiSource': ['第 {n} 个附件来源只能三选一（path / url / attachmentId）', 'Attachment #{n}: pick exactly one source (path / url / attachmentId)'],
  'coi2.attachFileMissing': ['第 {n} 个附件本地文件不存在：{path}', 'Attachment #{n}: local file does not exist: {path}'],
  'coi2.attachNotImage': ['第 {n} 个附件不是图片文件（仅支持 png/jpg/jpeg/webp/gif）：{path}', 'Attachment #{n} is not an image file (png/jpg/jpeg/webp/gif only): {path}'],
  'coi2.attachBadUrl': ['第 {n} 个附件 url 必须是 http(s) 地址', 'Attachment #{n}: url must be an http(s) address'],
  'coi2.attachDownloadHttpFail': ['第 {n} 个附件下载失败（HTTP {status}）：{url}', 'Attachment #{n}: download failed (HTTP {status}): {url}'],
  'coi2.attachDownloadFail': ['第 {n} 个附件下载失败：{detail}', 'Attachment #{n}: download failed: {detail}'],
  'coi2.attachSessionNeedsRuntime': [
    '第 {n} 个附件引用会话图片需要 DSH 新快照运行时的 attachments 服务（当前进程不支持），请改用 path/url 来源，或重启 DSH 后重试',
    'Attachment #{n}: session-image references need the attachments service from a newer DSH snapshot (this process lacks it); use a path/url source instead, or restart DSH and retry',
  ],
  'coi2.attachSessionNotFound': [
    '第 {n} 个附件在发起会话中未找到匹配的图片（attachmentId={id}）——图片须来自当前会话消息（浏览器输入框贴图）',
    'Attachment #{n}: no matching image in the originating session (attachmentId={id}) — the image must come from a message in the current session (pasted in the browser input box)',
  ],
  'coi2.attachSessionReadFail': ['第 {n} 个附件读取会话图片失败：{detail}', 'Attachment #{n}: reading the session image failed: {detail}'],
  'coi2.attachSessionNoData': ['第 {n} 个附件读取会话图片失败：未返回数据', 'Attachment #{n}: reading the session image failed (no data returned)'],
  'coi2.attMissingInMsg': ['附件不存在（消息 {id} 第 {index} 张）', 'Attachment not found (message {id}, image #{index})'],
  'coi2.attFileMissing': ['附件文件缺失（{name}）', 'Attachment file missing ({name})'],
  'coi2.msgMissing': ['消息 {id} 不存在', 'Message {id} does not exist'],
  'coi2.roomMissing': ['房间 {id} 不存在', 'Room {id} does not exist'],
  'coi2.unknownRouteB': ['未知路由 {path}', 'Unknown route {path}'],
  'coi2.adapterNoSkill': ['适配器 {id} 未关联技能', 'Adapter {id} has no skill associated'],
  'coi2.skillReadFailed': ['读取技能失败: {detail}', 'Reading the skill failed: {detail}'],
  'coi2.skillSaved': ['技能 {skill} 已保存（源头为插件内置，重启时版本未变不会覆盖你的编辑）', 'Skill {skill} saved (it originates from the plugin; on restart an unchanged version will not overwrite your edit)'],
  'coi2.skillSaveFailed': ['保存技能失败: {detail}', 'Saving the skill failed: {detail}'],
  'coi2.sessNeedsId': ['session id 不能为空', 'session id must not be empty'],
  'coi2.badScope': ['scope 必须是 {valid}', 'scope must be one of {valid}'],
  'coi2.temporaryNotStored': ['临时层级的会话不入库', 'Temporary-scope sessions are not persisted'],
  'coi2.sessUpdated': ['会话已更新', 'Session updated'],
  'coi2.sessRegistered': ['会话已登记', 'Session registered'],
  'coi2.sessMissing': ['会话 {id} 不存在', 'Session {id} does not exist'],
  'coi2.noteUpdated': ['备注已更新', 'Note updated'],
  'coi2.sessDeleted': ['已删除会话 {id}', 'Session {id} deleted'],
  'coi2.sessNotRegistered': ['会话 {id} 未登记', 'Session {id} is not registered'],
  'coi2.sessBusy': ['会话 {id} 正被任务 {task} 占用（同一会话不能并发跑多个任务）', 'Session {id} is occupied by task {task} (a session cannot run multiple tasks concurrently)'],
  'coi2.sessLocked': ['会话已锁定', 'Session locked'],
  'coi2.taskMissing': ['任务 {id} 不存在', 'Task {id} does not exist'],
  'coi2.taskRunningDelete': ['任务 {id} 正在运行，请先终止再删除', 'Task {id} is running — stop it before deleting'],
  'coi2.taskDeleted': ['已删除任务 {id}', 'Task {id} deleted'],
  'coi2.templateMissing': ['模板 {id} 不存在', 'Template {id} does not exist'],
  'coi2.emptyPromptTemplate': ['任务内容不能为空（或指定 templateId）', 'Task prompt must not be empty (or pass templateId)'],
  'coi2.taskStatus': ['任务 {id}（{adapter}）：{status}', 'Task {id} ({adapter}): {status}'],
  'coi2.taskLog': ['{logHint}\n任务 {id}：{status}\n{summary}', '{logHint}\nTask {id}: {status}\n{summary}'],
  'coi2.taskSummaryHead': ['输出摘要：\n{summary}', 'Output summary:\n{summary}'],
  'coi2.waitAborted': ['等待已取消（会话已停止）', 'Wait cancelled (the session was stopped)'],
  'coi2.wsNoCtxDeclare': ['无法识别调用会话（非 agent 上下文），不执行登记', 'Cannot identify the calling session (not an agent context); skipping declaration'],
  'coi2.declareFailed': ['声明失败：{detail}', 'Declaration failed: {detail}'],
  'coi2.queryDone': ['查询完成：{locks} 项占用，{active} 个活跃会话', 'Query complete: {locks} lock(s) held, {active} active session(s)'],
  'coi2.queryFailed': ['查询失败：{detail}', 'Query failed: {detail}'],
  'coi2.wsNoCtxRelease': ['无法识别调用会话（非 agent 上下文），不执行释放', 'Cannot identify the calling session (not an agent context); skipping release'],
  'coi2.released': ['已释放 {count} 项占用', '{count} lock(s) released'],
  'coi2.releaseFailed': ['释放失败：{detail}', 'Release failed: {detail}'],
}

/** Memory-sync messages (lib/sync/index.js). */
export const SYNC_DICT = {
  'sync.workerNoOutput': ['worker 无输出{tail}', 'The worker produced no output{tail}'],
  'sync.workerParen': ['（{detail}）', ' ({detail})'],
  'sync.workerUnparseable': ['worker 输出无法解析：{line}', 'Worker output could not be parsed: {line}'],
  'sync.projectOn': ['本项目已启用同步', 'Sync is enabled for this project'],
  'sync.projectOff': ['本项目已停用同步（记忆完整保留，可随时重新启用）', 'Sync is disabled for this project (memory fully retained; re-enable any time)'],
  'sync.notInitialized': ['项目尚未初始化——先启用本项目同步', 'The project is not initialized — enable sync for this project first'],
  'sync.badGlobalTrack': ['未知全局轨 "{track}"（应为 memory/user/daily/todo）', 'Unknown global track "{track}" (expected memory/user/daily/todo)'],
  'sync.globalToggled': ['全局{track}同步已{state}', 'Global {track} sync {state}'],
  'sync.stateOn': ['开启', 'enabled'],
  'sync.stateOff': ['关闭', 'disabled'],
  'sync.globalRepoMissing': ['全局记忆仓库尚未初始化——先在下方填共享记忆仓库地址初始化', 'The global memory repo is not initialized — fill in the shared-memory repo URL below first'],
  'sync.noGlobalTracks': ['未开启任何全局轨——先开启要同步的轨（全局记忆/用户档案/每日日志/待办）', 'No global track is enabled — turn on the tracks to sync (global memory / user profile / daily log / todos)'],
  'sync.noGlobalTracksSwitches': ['未开启任何全局轨——先打开要同步的轨开关', 'No global track is enabled — flip on the switches of the tracks to sync'],
  'sync.sharedDisabled': ['共享记忆库已停用（数据与地址保留，可随时重新启用）', 'Shared memory disabled (data and the repo URL are kept; re-enable any time)'],
  'sync.emptyRepoUrl': ['共享记忆仓库地址不能为空', 'The shared-memory repo URL must not be empty'],
  'sync.sharedNotInit': ['共享记忆库尚未初始化——先保存仓库地址', 'Shared memory is not initialized — save the repo URL first'],
  'sync.noGitRemote': ['当前项目没有可共享的 git 远端——请先为主仓库配置 remote（或在下方填共享记忆仓库地址）', 'This project has no shareable git remote — configure a remote on the main repo first (or fill in the shared-memory repo URL below)'],
  'sync.switchRemoteFailed': ['切换记忆远端失败：remote set-url 未成功（本地记忆未受影响）', 'Switching the memory remote failed: remote set-url did not succeed (local memory unaffected)'],
  'sync.remoteSwitched': [
    '记忆远端已切换（{url}，分支 {branch}）。本地记忆完整保留——点「同步」完成首次对账（推送需点「同步并推送」）{note}',
    'Memory remote switched ({url}, branch {branch}). Local memory fully retained — press "Sync" for the first reconciliation (pushing needs "Sync & Push"){note}',
  ],
  'sync.connected': [
    '已接入远端记忆（{branch}）：{message}。点「同步」拉取合并{tail}',
    'Connected to the remote memory (branch {branch}): {message}. Press "Sync" to fetch and merge{tail}',
  ],
  'sync.setupDone': [
    '记忆同步初始化完成（{branch}）：{message}。{pushHint}{note}',
    'Memory-sync initialization complete (branch {branch}): {message}. {pushHint}{note}',
  ],
  'sync.needSetupFirst': ['当前项目尚未初始化同步——请先点「开始同步」', 'This project has not initialized sync — press "Start Sync" first'],
  'sync.offNeedReenable': ['本项目已停用同步（记忆保留本地）——到记忆同步 Tab 重新启用', 'Sync is disabled for this project (memory kept locally) — re-enable it in the Memory Sync tab'],
  'sync.globalUsage': ['用法：global on|off <memory|user|daily|todo>', 'Usage: global on|off <memory|user|daily|todo>'],
  'sync.globalStatusToggled': [
    '全局{track}同步已{state}（{tracks}）',
    'Global {track} sync {state} ({tracks})',
  ],
  'sync.globalNotInitShort': ['全局记忆同步未初始化——全局记忆（用户档案/每日日志/待办）仅共享记忆仓库可用：先填共享记忆仓库地址初始化', 'Global memory sync is not initialized — global tracks (user profile / daily log / todos) require a shared-memory repo: fill in its URL first'],
  'sync.globalUsageLong': ['用法：global status | global on|off <memory|user|daily|todo> | global sync [--push]', 'Usage: global status | global on|off <memory|user|daily|todo> | global sync [--push]'],
  'sync.nothingToDisable': ['当前项目尚未初始化同步（无需停用）', 'This project never initialized sync (nothing to disable)'],
  'sync.disabledLong': ['本项目已停用同步：记忆完整保留在本机，不再对账；重新启用随时可继续（记忆同步 Tab）', 'Sync disabled for this project: memory stays fully on this machine and will no longer reconcile; re-enable any time from the Memory Sync tab'],
  'sync.moduleDisabled': ['记忆同步模块未启用——在「Memory Evolve 设置 → 配置」打开', 'The memory-sync module is disabled — enable it under "Memory Evolve Settings → Configuration"'],
  'sync.moduleOnProjectNotInit': ['模块已启用，但当前项目未初始化——点下方「开始同步」', 'The module is enabled, but this project is not initialized — press "Start Sync" below'],
  'sync.resolveUsageHint': ['用法：conflict resolve <编号> ours | theirs | both [fileset]（编号来自 conflict list）', 'Usage: conflict resolve <number> ours | theirs | both [fileset] (numbers come from conflict list)'],
  'sync.resolveUsage': ['用法：conflict resolve <编号> ours | theirs | both [fileset]', 'Usage: conflict resolve <number> ours | theirs | both [fileset]'],
  'sync.conflictUsage': ['用法：conflict list [fileset] | conflict resolve <编号> ours | theirs | both [fileset]', 'Usage: conflict list [fileset] | conflict resolve <number> ours | theirs | both [fileset]'],
  'sync.noConflicts': ['没有待处理的同步冲突。', 'No pending sync conflicts.'],
  'sync.noLegacyDir': ['没有发现可迁移的旧记忆目录（当前身份与历史目录一致）。', 'No legacy memory directory found to migrate (current identity matches the history).'],
  'sync.legacyFound': ['发现旧记忆目录：{legacy}\n→ 点「开始同步」会自动迁移到新目录 {dir}（记入迁移日志）。', 'Legacy memory directory found: {legacy}\n→ "Start Sync" migrates it into the new directory {dir} automatically (recorded in the migration log).'],
  'sync.unknownSub': ['未知子命令 "{op}"。用法：setup [url] | sync [--push] | off | status | conflict list | migrate', 'Unknown subcommand "{op}". Usage: setup [url] | sync [--push] | off | status | conflict list | migrate'],
}

/** Memory-sync repo plumbing messages (lib/sync/repo.js). */
export const SYNC_REPO_DICT = {
  'syncr.probeFailed': ['无法连接记忆远端（{reason}）：{detail}。请检查网络/凭证后重试', 'Cannot reach the memory remote ({reason}): {detail}. Check network/credentials and retry'],
  'syncr.adoptShared': ['远端已有本项目的专属分支 {branch}，直接接入', 'The remote already has this project\'s dedicated branch {branch}; adopting it directly'],
  'syncr.fetchLegacyFail': ['无法读取远端分支 {branch} 的内容（{detail}）——已停止初始化，请检查远端后重试', 'Cannot read the content of remote branch {branch} ({detail}) — initialization stopped; check the remote and retry'],
  'syncr.gitInitFail': ['git 初始化失败：{detail}', 'git init failed: {detail}'],
  'syncr.legacyContinue': ['远端分支 {branch} 是本项目的记忆（老配置）——继续使用，零迁移', 'Remote branch {branch} holds this project\'s memory (legacy layout) — continuing with it, zero migration'],
  'syncr.freshBranch': ['{others}本项目使用专属分支 {branch}', '{others}This project uses dedicated branch {branch}'],
  'syncr.othersPresent': ['远端已有其他项目的分支——', 'The remote already hosts other projects\' branches — '],
  'syncr.freshRemote': ['全新记忆远端——', 'Fresh memory remote — '],
  'syncr.migrateFail': ['记忆目录迁移失败：{detail}。请人工检查 {memoryDir}/projects/ 下是否有两个同项目目录后重试。', 'Memory directory migration failed: {detail}. Manually check for two same-project directories under {memoryDir}/projects/ and retry.'],
  'syncr.initFail': ['git init 失败（{detail}）——请检查 git 是否可用', 'git init failed ({detail}) — check that git is available'],
  'syncr.mainBranchFail': ['无法设置默认分支 main（{detail}）', 'Cannot set the default branch to main ({detail})'],
  'syncr.provenanceCorrupt': ['PROVENANCE 已存在但无法解析（JSON 损坏）——请人工检查后重试', 'PROVENANCE exists but cannot be parsed (corrupt JSON) — inspect it manually and retry'],
  'syncr.identityMismatch': [
    '目录身份不匹配：现有 PROVENANCE 属于项目 {existing}（{displayName}），当前解析为 {current}。目录可能被误用或接错，已停止初始化',
    'Directory identity mismatch: the existing PROVENANCE belongs to project {existing} ({displayName}), but this resolves to {current}. The directory may be misused or miswired; initialization stopped',
  ],
  'syncr.commitFail': ['首次提交失败：{detail}', 'The initial commit failed: {detail}'],
  'syncr.remoteAddFail': ['remote 挂载失败：{detail}', 'Attaching the remote failed: {detail}'],
  'syncr.remoteUnreachable': [
    '无法连接远端记忆仓库（{reason}）：{detail}。已跳过初始化，本地记忆不受影响；请检查网络/凭证后重试。',
    'Cannot reach the remote memory repo ({reason}): {detail}. Initialization skipped; local memory unaffected. Check network/credentials and retry.',
  ],
  'syncr.bootstrapNeeded': ['远端尚无 {branch} 分支，将按新设备初始化', 'Remote branch {branch} does not exist yet; initializing as a new device'],
  'syncr.idempotentAdopt': ['本项目已接入（重复 setup 幂等，无需重新初始化）', 'This project is already connected (setup is idempotent; no re-initialization needed)'],
  'syncr.dirNotEmpty': [
    '目标目录 {dir} 已有记忆内容（{files}）——为避免覆盖本地记忆，请先清空目录或人工处理后再接入',
    'Target directory {dir} already holds memory content ({files}) — to avoid overwriting local memory, empty the directory or handle it manually before connecting',
  ],
  'syncr.gitInitFailShort': ['git init 失败：{detail}', 'git init failed: {detail}'],
  'syncr.remoteAddFailShort': ['remote 挂载失败：{detail}', 'Attaching the remote failed: {detail}'],
  'syncr.fetchFail': ['拉取远端记忆失败：{detail}', 'Fetching the remote memory failed: {detail}'],
  'syncr.noProvenance': ['远端分支 {branch} 没有 PROVENANCE（身份缺失）——无法确认归属本项目，已拒绝接入（防串项目）。请人工检查远端分支后重试', 'Remote branch {branch} has no PROVENANCE (identity missing) — cannot confirm it belongs to this project; connection refused (cross-project guard). Inspect the remote branch manually and retry'],
  'syncr.provenanceBroken': ['远端分支 {branch} 的 PROVENANCE 损坏（无法解析 JSON）——已拒绝接入（防串项目）。请人工检查远端分支后重试', 'Remote branch {branch} has a corrupt PROVENANCE (unparseable JSON) — connection refused (cross-project guard). Inspect the remote branch manually and retry'],
  'syncr.identityMismatchRemote': ['远端记忆属于项目 {projectId}（{displayName}），与当前项目 {expected} 不匹配——疑似接错了分支/仓库，已拒绝接入', 'The remote memory belongs to project {projectId} ({displayName}), which does not match the current project {expected} — likely the wrong branch/repo; connection refused'],
  'syncr.checkoutFail': ['检出远端记忆失败：{detail}', 'Checking out the remote memory failed: {detail}'],
  'syncr.adopted': ['已接入远端记忆（{branch}）', 'Connected to the remote memory (branch {branch})'],
  'syncr.globalInitFail': ['全局记忆仓库 git init 失败：{detail}', 'Global memory repo git init failed: {detail}'],
  'syncr.globalMainFail': ['无法设置默认分支 main：{detail}', 'Cannot set the default branch to main: {detail}'],
  'syncr.globalStageFail': ['全局记忆文件 stage 失败（{path}）：{detail}', 'Staging the global memory file failed ({path}): {detail}'],
  'syncr.globalCommitFail': ['全局记忆仓库首次提交失败：{detail}', 'Global memory repo initial commit failed: {detail}'],
  'syncr.globalRemoteAddFail': ['全局记忆仓库 remote 挂载失败：{detail}', 'Global memory repo remote attach failed: {detail}'],
  'syncr.globalRemoteSetFail': ['全局记忆仓库 remote 切换失败：{detail}', 'Global memory repo remote switch failed: {detail}'],
}

/** Memory-sync worker messages (lib/sync/worker.js). */
export const SYNC_WORKER_DICT = {
  'syncw.notInit': ['记忆仓库尚未初始化——请先在记忆同步 Tab 点「开始同步」初始化', 'The memory repo is not initialized — press "Start Sync" in the Memory Sync tab first'],
  'syncw.conflictsPending': ['还有 {count} 条冲突未解决（{file}）——请先在冲突区解决后再同步', '{count} conflict(s) remain unresolved ({file}) — resolve them in the conflicts area before syncing'],
  'syncw.disabledResume': ['本项目已停用同步（记忆完整保留本地）——重新启用后继续', 'Sync is disabled for this project (memory fully kept locally) — re-enable to continue'],
  'syncw.noTracksSelected': ['项目记忆轨已退出同步（未选择任何同步内容）', 'Project memory tracks left the sync (no sync content selected)'],
  'syncw.pullFail': ['拉取远端记忆失败（{err}）。本地记忆未受影响，请检查网络/凭证后重试', 'Fetching the remote memory failed ({err}). Local memory unaffected; check network/credentials and retry'],
  'syncw.branchGone': ['远端分支 {branch} 已不存在（本地曾有陈旧跟踪，已清理）。远端记忆可能被删除或迁移——请检查远端后重新初始化', 'Remote branch {branch} no longer exists (a stale local tracking ref was cleaned up). The remote memory may have been deleted or moved — check the remote and re-initialize'],
  'syncw.branchMissing': ['远端分支 {branch} 不存在——请先点「开始同步」初始化', 'Remote branch {branch} does not exist — press "Start Sync" to initialize first'],
  'syncw.remoteInvalid': ['远端记忆数据格式异常（{path}：{reason}）——已停止同步，本地记忆未受影响。请人工检查远端分支后重试', 'Remote memory data is malformed ({path}: {reason}) — sync stopped, local memory unaffected. Inspect the remote branch manually and retry'],
  'syncw.historyDiverged': ['历史无法对齐（可能被 force 推送或接错了分支）——已停止合并，本地记忆未受影响。请人工检查远端分支后重试', 'Histories cannot be aligned (force-pushed or wrong branch?) — merge stopped, local memory unaffected. Inspect the remote branch manually and retry'],
  'syncw.baseInvalid': ['历史数据格式异常（{path}：{reason}）——已停止合并，本地记忆未受影响。请人工检查后重试', 'Historical data is malformed ({path}: {reason}) — merge stopped, local memory unaffected. Inspect it manually and retry'],
  'syncw.commitAfterMergeFail': ['合并完成但提交失败：{detail}。工作树已是合并结果，请重试', 'Merge completed but the commit failed: {detail}. The working tree already holds the merged result; retry'],
  'syncw.conflictsBeforePush': ['还有 {count} 条冲突未解决（{file}）——请先解决冲突再推送，否则远端会缺少冲突条目', '{count} conflict(s) remain unresolved ({file}) — resolve before pushing or the remote will miss the conflicted entries'],
  'syncw.pushRejected': ['推送被拒绝：远端有新提交（non-fast-forward）。请先再点一次「同步」拉取合并后再推，绝不强制推送', 'Push rejected: the remote has new commits (non-fast-forward). Press "Sync" again to fetch and merge first; never force-push'],
  'syncw.pushFail': ['推送失败（{detail}）。合并结果已安全保存在本地，可稍后重试', 'Push failed ({detail}). The merged result is safely stored locally; retry later'],
  'syncw.unknownError': ['未知错误', 'unknown error'],
  'syncw.statusNotInit': ['未初始化', 'not initialized'],
  'syncw.statusInit': ['初始化：{state}', 'Initialization: {state}'],
  'syncw.connectedState': ['已接入', 'connected'],
  'syncw.notConnected': ['未接入远端', 'not connected to a remote'],
  'syncw.identityMismatchMerge': [
    '远端记忆身份缺失或不匹配（本地项目 {local}）。疑似远端分支被篡改或接错——已拒绝合并。请检查后重试',
    'Remote memory identity missing or mismatched (local project {local}). The remote branch may be tampered with or miswired — merge refused. Check and retry',
  ],
  'syncw.noConflicts': ['没有待处理的冲突', 'No pending conflicts'],
  'syncw.badConflictIndex': ['冲突编号 {index} 不存在（当前 1..{max}）', 'Conflict number {index} does not exist (valid range 1..{max})'],
  'syncw.resolveUsage': ['用法：conflict resolve <编号> ours | theirs | both', 'Usage: conflict resolve <number> ours | theirs | both'],
  'syncw.choiceUnavailable': ['冲突 {index} 没有可用的 {choice} 版本（该侧为空/删除）', 'Conflict {index} has no {choice} side available (that side is empty/deleted)'],
  'syncw.fileNotWhitelisted': ['冲突 {index} 的目标文件不在同步白名单内（{file}）——已拒绝写入', "Conflict {index}'s target file is not in the sync whitelist ({file}) — write refused"],
  'syncw.treeStepFail': ['解决冲突时 {error}（目标条目已写回，可重试）', '{error} while resolving the conflict (the target entry is written back; safe to retry)'],
  'syncw.commitTreeFail': ['解决冲突时 commit-tree 失败：{detail}（目标条目已写回且写回幂等，可直接重试）', 'commit-tree failed while resolving: {detail} (the target entry is written back idempotently; retry directly)'],
  'syncw.updateRefFail': ['解决冲突时 update-ref 失败：{detail}。提交已生成但 ref 未更新——侧车仍在，写回幂等，请重试', 'update-ref failed while resolving: {detail}. The commit exists but the ref was not updated — the sidecar remains, writes are idempotent; retry'],
  'syncw.resolved': ['已解决冲突 #{index}（{choice}）并提交', 'Conflict #{index} resolved ({choice}) and committed'],
}

/** COI task-completion notification mail body (lib/coi/index.js). */
export const NOTIFY_DICT = {
  'coin.head': ['[COI] 任务 {id}（{name}）{status}', '[COI] Task {id} ({name}) {status}'],
  'coin.subject': ['📮 主题：任务完成：{id}（{name}）', '📮 Subject: Task finished: {id} ({name})'],
  'coin.intro': ['📝 简介：{intro}', '📝 Intro: {intro}'],
  'coin.sender': ['👤 发送人：DSH AI 助手（dsh-memory-evolve）', '👤 Sender: DSH AI assistant (dsh-memory-evolve)'],
  'coin.time': ['🕐 时间：{time}', '🕐 Time: {time}'],
  'coin.bodyHead': ['📄 内容', '📄 Content'],
}
