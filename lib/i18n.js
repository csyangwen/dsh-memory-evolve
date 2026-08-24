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
 *     2. otherwise default 'en'.
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
 *  Default 'en': the plugin speaks English unless the DSH Language preference
 *  is explicitly 'zh'. apply() re-resolves from DSH settings at boot and on
 *  every locale change event, so live processes always follow the setting. */
let active = 'en'

/** Valid locale ids (mirrors DSH's LOCALE_IDS). */
export const LOCALES = ['zh', 'en']

/**
 * Resolve the effective locale from a Cordis context. Reads the DSH locale
 * settings section when the settings service exists. Default is 'en': only
 * an explicit 'zh' preference switches the plugin back to Chinese; unset,
 * 'auto', or any unexpected value stays English. Never throws.
 * @param {object|undefined} ctx - plugin context with an optional settings service.
 * @returns {'zh'|'en'} the resolved locale id.
 */
export function resolveLocale(ctx) {
  try {
    const settings = ctx?.get?.('settings')
    if (!settings || typeof settings.get !== 'function') return 'en'
    const section = settings.get('locale')
    const pref = section && typeof section === 'object' ? section.preference : undefined
    return pref === 'zh' ? 'zh' : 'en'
  } catch {
    return 'en'
  }
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
