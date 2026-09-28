# Spec · autopilot-memory-lifecycle（记忆生命周期元数据层）

- 产出：Analyst（dsh-agents，HIGH 档 glm-pro/glm-5.3）· 2026-09-23
- 素材：A-bio-mechanisms.md / B-github-landscape.md / C-dsh-current-state.md（<工作区>/bio-memory-research/，全文已读）
- 代码基线：dsh-memory-evolve @ c337dc1（git log 实测核对）；零 npm 依赖（package.json 无 deps 字段，实测核对）
- 下游：planner 出 3-6 步工作计划 → executor 实施。本 spec 的验收标准每条均可判定（对应测试断言或明确人工验证步骤）。

## 修订记录

- **R5（2026-09-28，合并 origin/main 8 提交 + 渐进式披露 v2 批次；用户拍板：仿照 skills 的渐进式披露为记忆加渐进式披露，长记忆只注入概述、需要时调用；摘要在写入时一并生成，存量批量回填）**：① **add 的 `summary` 参数由 key 轨扩到 memory/user/key 三轨**（原门控 `target === 'key' && summary`，memory/user 只能靠 autoSummary 截首行兜底，而两轨条目多为单行长段）；② `autoSummary` 默认上限 80 → `SUMMARY_MAX_CHARS = 120`，与显式 `[summary:…]` 的写入口径统一（消除「写入 120 字、注入被砍到 80」的双口径），新增 `normalizeSummaryText` 作单一清洗源；③ 新增 `memorySummaryMinChars`（默认 400，正整数校验 + RUNTIME_KEYS + 设置页/i18n）——**摘要模式下按条目长度折叠**：正文（新增 `entryBodyOf`，剥头部元数据后）长于该值的条目折成一行摘要、短条目保持全文，`[salience:3]` 与命中豁免仍恒全文，**off 模式不受影响**（golden 逐字节不变）；④ `retag` 新增可选 `summary` 参数（新增 `retagEntryMeta`）：只重写头部元数据标记（`[summary:…]` / `[salience:N]`），**正文逐字节不动**，两者至少给一个否则诚实拒绝——这是存量摘要批量回填的执行机制；⑤ 合并上游：`normalizeForMatch` 采纳 #59 并把剥离集合扩为 `[id:]/[summary:]/[salience:]`（`entryDisplayForm` 保留为同实现的别名，`findExactIndex` 增 `{ first }` 选项）、COI 四处注入点采纳 #68 的 `PLUGIN_SOURCE_KIND`（`lib/coi/source.js`）、内置技能同步采纳 #58 的 `lib/coi/skills-sync.js` 解耦、`memory-consolidate` 升 `x-version: 2`。**golden 第 4 次有意再捕获**（唯一差异段 = `snap.keyDuty`：本仓 retag/salience 半句 + 上游工具名半句拼接；脚本 agent-out/v2-recapture-golden.mjs）。
- **R4（2026-09-24，PR #66 后续增强批次，用户洞察：模型实际只从注入快照读记忆、几乎不调 list/expand，命中信号必须能从「使用申报」流入）**：memory add 新增可选 `used` 参数（string[]，单轨与批量 entries 写均可）——收尾写入时申报本轮实际用到的既有记忆的独特子串；解析器 `resolveUsedRefs`（lib/hit-stats.js 纯函数）按 memory→user→key 轨序扫描，某轨恰一条命中 → `bumpHits`，多义/未命中换轨、全轨失败计入 unmatched；单调用内 ref 去重；先写 entries（主流程优先）后处理 used；全程 try/catch 失败隔离。回显双语（N=命中数、M=未匹配数；N>0 显「已记录 N 条」，N=0 且 M>0 显忽略段）。快照收尾写入指引（batchWriteDuty）补申报半句——**golden 第 3 次有意再捕获（最终态）**。语义修订：Q5 决策行由「注入不算命中」修订为「注入不自动计数；模型经 used 主动申报的使用计入」（被替换原文见该行内注记）。测试：tests/used-refs.test.js 7 例（批量/单轨跨轨/未匹配/多义/缺省零副作用/去重/畸形输入失败隔离）。
- **R3（2026-09-24，PR #66 后续增强批次，用户拍板：主路径=运行时由大模型统一为旧记忆补标；块 5 命中豁免保留为自动过渡层）**：memory 工具新增 `retag` action——按 match 定位单条（语义同 replace），剥旧 `[salience:N]` 盖新级别（`retagEntry`：新 tag 插头部序列末尾，正文逐字不动、`[id:]`/`[summary:]` 原样保留；store 层与 replace 同 drift 守卫 + withLock + 原子写路径）；target 支持矩阵与 add 相同（memory/user/key 有效，project/daily 诚实拒绝——retag 唯一目的就是打 tag，静默忽略会误导）；salience 必填整数 1-3（normalizeSalienceFor 同链 + store 层防御性再校验）。快照写入指引（keyDuty）补「存量补标」一行（审查到期轮分批，每轮 10-20 条至清零）——**golden 第 2 次有意再捕获**（唯一差异段 = keyDuty 补标句）。工具描述补 retag 用法。测试：tests/retag.test.js 6 例（无 tag 补标正文逐字不变/旧 tag 替换/match 不唯一/日志轨拒绝/[id:]+[summary:] 保留/非法值防御 + retagEntry 头部形态矩阵）。
- **R2（2026-09-24，PR #66 后续增强批次，用户需求）**：摘要模式妥善处理存量旧记忆——新增 `memoryHitExemptDays`（默认 30；0=关闭；校验=非负整数），摘要分支全文条件扩为 `[salience:3]` **或**「hitCount≥1 且 lastAccessed 距今 ≤ 阈值天数」（daysBetween 与 decay.js 同源口径；豁免集由调用方每轨一次 readSidecar 组装、options 传入 renderGlobalTrackInject，无豁免集=现状）。摘要头 i18n（snap.memorySummaryHead/snap.userSummaryHead）补「近期命中的条目保持全文」——**默认 golden 零变化**（摘要头不进 off 模式快照，tests/snapshot-golden.test.js 绿证实）。测试：tests/memory-progressive-disclosure.test.js 增 7 例（新鲜命中/超期/=0 关闭/无侧车/salience:3 恒豁免/off+auto 全量路径不受影响/旋钮校验）。
- **R1（2026-09-24，PR #66 后续增强批次）**：`snap.keyDuty` 快照注入文本补 salience 半句（用户需求：UI 可见性与引导——让模型在写入指引处直接看到 salience 用法）。变更点：写入指引第 1 步 keyDuty 段追加「核心约定/决策可传 salience:2-3 标注重要性，常规进展不传」；tests/snapshot-golden.test.js 的 GOLDEN_ZH 按有意变更流程再捕获（脚本 agent-out/recapture-golden-uifollowup.mjs，fixture store + 默认 config）。被替换原文（保留供审计）：
  - zh：`本轮出现重要项目事实（长期约定/决策/架构/踩坑）时另向 target=key 提交 1 条建议（用户确认后写入并注入），没有则跳过`
  - en：`when durable project facts appear this turn (long-lived conventions/decisions/architecture/pitfalls), additionally submit one suggestion to target=key (written and injected after user confirmation); skip when there are none`
  - 性质：纯文案增量，机制行为零变化；AC-3.1（off 逐字节一致）在新基线下仍成立（差异仅此一处文本）。

---

## 一、目标（一句话）

为 dsh-memory-evolve 落成**记忆生命周期元数据层**：检索命中即强化（hitCount/lastAccessed 侧车统计）、条目级显著性（[salience] tag + 分层注入）、衰减归档候选报告（只产出清单绝不删除）、审查到期联动——在零依赖、零向后兼容破坏、快照默认行为零变化的前提下，让记忆条目「被用过就更耐用、长期没用进候选」，填补 A 报告指出的「检索驱动强化调度」业界空白。

## 二、候选改进池（三方输入交叉印证 + 改动面实测核实）

> 交叉印证度：A=生物机制报告，B=GitHub 全景报告，C=本机现状勘察。五项候选均获 ≥2 方直接支持；排序按「交叉印证度 × 投入产出比」。

### 候选 1 · 命中驱动强化调度 —— 推荐序 ①

- **来源**：A M4+M2（检索练习效应：强化应绑定「被成功检索」时刻而非写入时刻；**业界空白**——「检索命中驱动的强化调度没有主流实现」，A 报告 §3.2 明确列为两大设计机会之一）；C P0-3 + §八接入点②（list/expand 命中即强化、久未访问即衰减）；B §五-4（条目带 last_accessed 字段的短评）。
- **改动面（实测核实）**：
  - 新模块 `lib/hit-stats.js`：侧车（sidecar）统计存储——全局轨 `<memoryDir>/hit-stats.json`、key 轨 `projects/<id>/hit-stats.json`；键 = `track:sha1(规范化条目文本)`；原子写（tmp+rename，照 store.js:785-790 先例）+ withLock 复用（store.js:387）。
  - 回填钩子：memory 工具 list 分支（lib/index.js:1195-1298，store.query 调用点 :1256）与 expand 分支（:1424-1462）在返回结果后更新命中条目的 hitCount/lastAccessed。
  - 仅 memory/user/key 三轨计数；project/daily 是追加型日志轨（不注入、无衰减语义），不计数。
- **⚠️ 关键核实发现（修正任务书「条目元数据扩展 hitCount/lastAccessed」的实现口径）**：命中元数据**不能写进条目头 tag**，必须落侧车。理由三条（均带代码证据）：
  1. **前缀缓存会被击穿**：快照对 memory/user/key 做 live 读 + 变化检测（index.js:525-535），每次检索改写 MEMORY.md 会使下一步就注入新尾部快照；而 project/daily 被刻意不注入正是为了保护 LLM 前缀缓存（index.js:630-644 注释原文）。检索是高频操作，改条目=每 list 一次脏一次缓存。
  2. **git 同步噪音**：记忆目录本身是同步仓库（C §1.3），检索即改文件会产生海量无意义提交；同步分支 fileset 只映射固定文件清单（lib/sync/filesets.js:26,33），侧车新文件天然不进任何 fileset（本 spec 用验收项钉住这一点）。
  3. **写放大与锁竞争**：跨进程锁（store.js:387 withLock）下高频整文件重写。
  侧车方案三条全解：主轨字节不动、快照零感知、损坏可静默重建。
- **风险**：低。纯增量功能，任何失败路径都可降级为「无统计」。

### 候选 2 · 条目级重要性标记 —— 推荐序 ②

- **来源**：C P0-3（重要性无条目级表达，全局轨所有条目同权全量注入）；A M6（写入时打 importance 权重，Generative Agents importance 因子是标准先例；同时警示 flashbulb 失真→本批不做 LLM 自动打分）；B §二A组（GA/LangMem 的 importance 因子主流先例）。
- **改动面（实测核实）**：
  - `lib/store.js:138` ENTRY_HEAD_RE 与 `:209-261` splitEntryHead 在 `[summary:…]` 之后追加 `[salience:N]` token——tag 序列扩展有成熟先例（[dsh-only]、[summary] 都是后加的，编辑时原样保留进 head）。
  - memory 工具 add 加可选 `salience` 参数（整数 1-3：1 低/2 中/3 高，缺省不写 tag=视为 2；钳制越界值到 [1,3]）；仅 memory/user/key 轨生效（project/daily 不标）。
  - 快照分层注入：新配置旋钮 `memoryProgressiveDisclosure`（默认 `'off'`=零变化，照抄 keyProgressiveDisclosure 三态模式 index.js:604-628 与 config 先例 :94-97）；`'auto'` 模式下条目数/字符超阈值时，无标记与低/中 salience 条目以摘要注入（autoSummary 兜底已存在 store.js:160-175，显式 [summary] 优先）、`[salience:3]` 恒全量；`'on'` 恒摘要（除 salience:3）。memory 轨被摘要化的条目取全文走 list 全量（memory/user 无保护视图，index.js:1242-1243），无需扩 expand。
- **任务书行号勘误**：任务书写「key 轨已有全量/摘要两档先例 index.js:575-584」——实测 :575-584 是 memory/user 全量注入段，两档先例在 **index.js:603-628**。planner 引用时以本 spec 为准。
- **风险**：中。触碰快照注入主路径（renderSnapshot index.js:543-777）——缓解：默认 off + 「关=逐字节同现状」负向断言（AC-3.1）+ 注入必红对照（AC-3.4）。

### 候选 3 · 遗忘/衰减调度 —— 推荐序 ③

- **来源**：C P0-2（无遗忘/衰减/容量控制，轨道单调增长直接转 token 成本）；B §三-4（AI-Memory 艾宾浩斯曲线、cortexgraph 时间衰减；graphiti invalid_at 软删除先例）；A M5（Richards & Frankland：遗忘是特性——丢弃细节保留要点有利泛化）。
- **改动面（实测核实）**：
  - 只读派生：读侧车 hit-stats（lastAccessed）+ 条目头部时间戳（无侧车记录时回退 extractEntryDate 作代理，覆盖旧库）+ [salience]。
  - memory 工具新 action `decay`：扫描三轨，产出 `<memoryDir>/decay-report.json` 归档候选清单。候选判据：`daysSince(lastAccessed ?? entryDate) > threshold[salience]`，初值 30/90/180 天（salience 1/2/3；config 可调 `decayThresholds`，0=永不）。报告含每条的 track/id/hash/lastAccessed/days/threshold/salience/原因字段与 fallback 计数元数据。幂等覆盖写。
  - **不动 skills/**：scan_memory.mjs 在 skills/memory-consolidate/scripts/（上游 #58 v2 在途，硬约束）——衰减报告完全由 lib/ 产出，报告格式即消费契约，技能侧后续自行接入。
- **风险**：低。只读计算 + 覆盖写一个 JSON 文件；绝不删除/移动任何条目（归档动作本身也留给 memory-consolidate 技能或用户裁决）。

### 候选 4 · 语义检索可选通道 —— 推荐序 ④（本批排除）

- **来源**：C P0-1 + §八接入点①（query() 无语义通道，同义改写即丢；本机已有 Ollama 嵌入基建可复用）；B §三-2（主流检索全部语义化）；A M8（联想检索补盲区）。
- **改动面（估）**：query() 或新 action 接 Ollama `/api/embed`（node 内置 fetch，127.0.0.1:11434），内存余弦或文件缓存，配置默认关、不可达静默降级现有检索。
- **风险**：中高——①缓存失效：条目 replace 后向量陈旧，需按内容 hash 失效；②dim mismatch 无守卫会**静默零命中**（guji 项目实证教训：检索输出格式合法但 recall 全 0 的无效数字）；③网络超时路径与降级语义需独立设计。独立模块、默认关闭即零影响——值得单独一个 spec + 评审，不挤本批。
- **本批唯一残留动作**：无（连配置键都不预留，避免占位配置污染）。

### 候选 5 · 巩固自动化（最小接线）—— 推荐序 ⑤

- **来源**：C §八接入点③（审查回合计数器已在位 review.js:89-132，接上即可）；A M3（Letta sleep-time compute 先例：空闲期整理是一等公民）；B Top5-1（Letta 同款）。
- **改动面（实测核实）**：review 到期的 dueWarning 文案（index.js:718-719 渲染点）在 decay-report.json 存在且非空时附加候选数，提示模型本轮审查可消费该报告（跑 memory-consolidate 技能或人工处理）。reviewEnabled 默认 false（index.js:117）不变。
- **风险**：低。只读报告文件 + 文案追加；完整 sleep-time 化（idle 会话唤醒编排、定时器）明确不在本批。

## 三、本批范围（推荐批次）

**进本批：候选 1 + 2 + 3 + 5**（生命周期闭环：命中→显著性→衰减候选→审查提示消费，共享同一套侧车基建）。

给 planner 的 5 步计划骨架（每步独立可验收、含检查点 commit）：

1. `lib/hit-stats.js` 侧车存储（读写/原子写/锁/损坏降级）+ 单测（node:test 直跑）。
2. list/expand 回填命中统计（失败隔离：侧车异常绝不影响 list 返回）+ 单测（含 AC-1 全组）。
3. `[salience:N]` tag：解析/剥离/stripEntrySalience 导出/add 参数与钳制/i18n 双语 + 单测（解析矩阵 ≥3 元素 + 正文误命中负向）。
4. 快照分层注入 `memoryProgressiveDisclosure`（renderSnapshot 扩展 + i18n）+ 负向自测（默认 off 逐字节同现状 + 注入必红对照）。
5. `decay` action + 报告落盘 + review dueWarning 联动 + 向后兼容回归 + **真实输入全量跑**（本机记忆目录只读副本）。

**排除项及理由**：

| 排除项 | 理由 |
|---|---|
| 候选 4 语义检索 | 独立模块；缓存失效/dim 守卫/降级语义需独立 spec 与评审（guji 静默零命中教训前置）；默认关零影响不急于本批 |
| sleep-time 完整编排（idle 唤醒整理） | 会话编排层改动，超出插件本批；联动最小接线（候选 5）已覆盖价值主干 |
| archive 扩 project/daily（C P1-3） | 与上游 #58 memory-consolidate v2 的冲突面相邻；且归档消费方在技能侧（skills/ 禁碰） |
| P1-1 保护视图推广到 memory/user | 与分层注入（候选 2）目标重叠，本批由分层注入主攻；留待观察 |
| P1-2 反馈行消费、【反馈】加权 | 情绪信号→巩固优先级的映射需产品层决策（A M6 flashbulb 风险），下批评估 |
| bi-temporal 双日期（B §五-2） | 「取代此前」约定的工程化有价值但独立于生命周期主线，装不下，下批候选 |

## 四、非目标（硬约束，实施与评审逐条对照）

1. **零 npm 依赖**：package.json 不得新增 dependencies / devDependencies（一切用 node 内置能力；fetch 用 node ≥18 全局 fetch）。
2. **向后兼容三连**：①无新元数据的旧记忆文件必须照常读写（缺字段=默认值：无 [salience]=中档、无侧车记录=回退条目时间戳）；②旧版本插件读新文件不炸——[salience] 对旧解析器是未知头部 token，会作为正文前缀保留（不抛错、内容不丢），isCanonical（store.js:321-323 分隔符口径）不受影响；③含新 tag 的文件 round-trip 规范。
3. **不动 skills/ 目录**：上游 #58 memory-consolidate v2 在途；衰减报告只定义产出与格式，不写技能侧消费代码。
4. **语义检索默认关闭**（本批未实现，约束预录给下批）：配置开启才生效、Ollama 不可达时静默降级现有检索、关闭=零影响。
5. **衰减只产出「归档候选」清单，绝不自动删除条目**（用户纪律：归档优先禁删除）；本批更进一步——连自动归档也不做，归档动作完全留给 memory-consolidate 技能/用户裁决。
6. **测试环境限制**：node --test runner 沙箱内 spawn EPERM 不可用，全部测试用例必须支持 `node <file>` 直跑（node:test import 形态，与现有 tests/*.test.js 同款，如 aliases.test.js:4）。
7. **主轨文件字节不动**（本批新增的所有高频写入只落侧车与报告文件；replace/add 等既有写路径语义不变）。
8. **快照默认行为零变化**：所有新注入行为挂在默认 off 的配置旋钮后；未配置用户升级后快照逐字节同现状。
9. **新增用户可见文案 zh/en 双语成对**（i18n.js 单表双键形态，i18n.test.js parity 语义延续）。
10. **不做 LLM 自动 salience 打分**（A M6 flashbulb 陷阱 + 校准差；只接受显式传参）。

## 五、验收标准清单（每条可判定）

### AC-1 命中统计（侧车）

- **AC-1.1（≥3 元素输入）**：fixture 建 5 条 memory 条目，`list filter` 命中其中 3 条 → 侧车中这 3 条 hitCount=1、lastAccessed=当日；未命中 2 条无记录。
- **AC-1.2（前缀缓存保护）**：list 前后对 MEMORY.md 做 SHA256 比对，逐字节相同。
- **AC-1.3（旧目录冷启动）**：无 hit-stats.json 的既有目录首次 list → 正常返回 + 侧车自动初始化，无异常。
- **AC-1.4（损坏降级）**：侧车文件写入垃圾字节后 list → 正常返回、统计静默重置、不抛异常（控制台告警可留档）。
- **AC-1.5（expand 计数）**：key 轨 expand 一次 → 对应条目 hitCount +1。
- **AC-1.6（日志轨豁免）**：project/daily 的 list 不产生任何统计写入。
- **AC-1.7（不进同步）**：grep 证明 hit-stats 未出现在 lib/sync/filesets.js 任何 fileset（防未来误卷入同步分支）。

### AC-2 salience 标记

- **AC-2.1（写入位置）**：add 带 salience=1 → 条目头含 `[salience:1]`，位于 `[summary:…]]` 之后、正文之前；splitEntryHead 剥离进 head（编辑正文时 tag 原样保留）。
- **AC-2.2（缺省无 tag）**：add 不带 salience → 条目无该 tag。
- **AC-2.3（≥3 元素解析矩阵 + 误命中负向）**：4 类条目——无 tag / `[salience:2]` / `[summary:x] [salience:3]` / 正文含字面 `[salience:9]` 文本——解析结果各自正确；第 4 类的正文 `[salience:9]` **不得**被误解析为头部 tag（若实现是「取首个匹配」或「串接全部」此断言必红）。
- **AC-2.4（展示剥离）**：新增导出 stripEntrySalience；全量注入与工具回显中模型可见输出不含 `[salience:…]`。
- **AC-2.5（钳制）**：salience=0 / 4 / -1 / 'x' → 钳制到 [1,3]（或非数字拒绝并回显），不产生非法 tag。

### AC-3 快照分层注入

- **AC-3.1（默认零变化，负向）**：memoryProgressiveDisclosure 缺省（=off）时，固定 store+config 下 renderSnapshot 输出与改造前**逐字节一致**（对照字符串断言）。
- **AC-3.2（auto 分层生效）**：auto 模式 + 条目数/字符超阈值 → 无标记与低/中 salience 条目以摘要（显式 [summary] 优先，autoSummary 兜底）注入；`[salience:3]` 条目全文注入。
- **AC-3.3（auto 未超阈值全量）**：auto 模式 + 未超阈值 → 全量注入（key 轨 auto 先例同款语义）。
- **AC-3.4（注入必红）**：同一 store 构造开/关分层两份快照，断言二者不同（防「旋钮失效恒同现状」的假绿门）。
- **AC-3.5（取全文指引）**：摘要注入段的头部文案告知模型可用 list 取全文。

### AC-4 衰减候选报告

- **AC-4.1（≥3 元素输入）**：构造 5 条（3 条 lastAccessed 超阈值低 salience + 2 条近期命中）→ 报告含且仅含那 3 条，每条附 track/hash/lastAccessed/days/threshold/salience 原因字段。
- **AC-4.2（旧库回退口径）**：无侧车记录的条目按条目时间戳判据参与筛选，报告 metadata 标注 fallback 条数。
- **AC-4.3（幂等）**：连续跑两次 decay → 报告内容一致（覆盖写，不累积）。
- **AC-4.4（只读派生）**：报告生成前后三个主轨文件 SHA256 不变。
- **AC-4.5（高档豁免可配）**：`[salience:3]` 条目按 threshold[3]（默认 180d）判定；threshold 配 0 时永不进候选。
- **AC-4.6（零候选明示）**：无候选时报告为空数组，工具回显明确「无候选」。

### AC-5 审查联动

- **AC-5.1（联动生效）**：reviewEnabled=true、计数到期、decay-report.json 非空 → 快照 dueWarning 文案含候选数。
- **AC-5.2（默认零变化，负向）**：review 关闭（默认）或报告为空/不存在 → 快照与无联动版逐字节一致。
- **AC-5.3（只读边界）**：联动路径只读报告文件，不触发任何自动整理/归档动作。

### AC-6 向后兼容与全局门

- **AC-6.1（旧格式全通）**：含 [git]/[branch]/[summary]/纯时间戳/无 tag 等 ≥3 种旧头部形态的文件 isCanonical=true，add/replace/list/archive 全部正常。
- **AC-6.2（新格式 round-trip）**：含 [salience] 的文件 parse→serialize round-trip 后 isCanonical=true。
- **AC-6.3（旧解析器模拟）**：用改造前的 ENTRY_HEAD_RE（快照留档的正则）解析新文件 → 不抛错、条目数不变、[salience:x] 作为正文前缀保留在条目内。
- **AC-6.4（零依赖）**：package.json 无 dependencies/devDependencies 新增（断言字段缺失或不变）。
- **AC-6.5（目录边界）**：git status 显示 skills/ 与 lib/sync/ 零改动。
- **AC-6.6（直跑）**：全部新增测试文件 `node <file>` 直跑 exit 0（交付物附命令清单）。
- **AC-6.7（真实输入全量跑）**：复制本机真实 ~/.dsh/memories 到工作区临时目录（含真实 MEMORY.md/USER.md/项目轨/daily），MemoryStore 指向副本跑 list / decay / snapshot 渲染全链路：无异常、快照可完整解析、报告产出（**只读副本，绝不写回原目录**）。此条排除自造 fixture 通过、真实数据翻车的路径。
- **AC-6.8（i18n 成对）**：新增 i18n key zh/en 双语齐全（键对齐测试通过）。
- **AC-6.9（覆盖率说明表）**：新增/修改模块的行覆盖测量（NODE_V8_COVERAGE 配方，注意 UTF-16 偏移陷阱）并交付「数字 + 未覆盖行逐项原因说明表」；目标 100%，达不到逐项说明（用户固化纪律）。

**验收链组成**：AC-1~6 全绿 + AC-6.7 真实输入全量跑 + AC-6.6 直跑命令清单 = 本批完成判据。断言鉴别力对照：≥3 元素断言 = AC-1.1 / AC-2.3 / AC-4.1 / AC-6.1；注入必红负向 = AC-2.3（误命中）/ AC-3.4 / AC-5.2；真实输入无 workaround = AC-6.7。

## 六、需求缺口与开放问题

- [ ] 侧车键 = 条目内容 hash：条目被 replace 编辑后 hash 变化、历史计数归零重新开始——是否接受？ — **缺省决策：接受**（编辑=新生命周期；replace 低频，损失可忽略；spec 已按此设计）
- [ ] 侧车不进同步 fileset → 命中统计是**设备本地**的，多设备不聚合 — **缺省决策：一期本地**（报告 metadata 预留 deviceId 字段位）；跨设备聚合等真实需求出现再议
- [ ] salience 由谁打：本批只接受显式传参，不做 LLM 自动打分（A M6 flashbulb 陷阱） — 写入时自动**建议** salience（走 memory_suggest 待确认队列）留待下批评估
- [ ] 衰减阈值 30/90/180 天是初值，无真实分布校准依据 — 上线后按首个真实报告的分布回看调整（guji「抓完分布后校准」同款纪律）；config 可调已预留
- [ ] 「注入算不算命中」：快照常驻注入是被动暴露，A M4 明确「集中暴露≠检索练习」 — **缺省决策（R4 修订，2026-09-24）：注入不自动计数；模型经 used 使用申报主动申报的使用计入**（用户洞察：模型实际只从注入快照读记忆、几乎不调 list/expand，命中信号必须能从「使用申报」流入——add 的 used 参数申报独特子串、恰一条命中即计数；显式 list/expand 照旧计数）。被替换原文：「缺省决策：不算，只有显式 list/expand 才计数；若日后数据显示需要注入权重，加配置开关」
- [ ] memory-consolidate 技能消费 decay-report.json 的路径约定需要在技能侧跟进（上游 #58 v2 落地后）— 本 spec 只定义报告 JSON 格式契约，技能侧接线不在本批
- [ ] 语义检索（下批）的缓存失效策略与 dim mismatch 守卫设计必须前置 — guji 实证：dim 不一致时检索静默跳过全部分片、hits 恒空但输出格式合法，是最危险的失效模式
- [ ] review 联动文案的候选数是否需要区分「全局轨 vs 项目轨」— 一期合并计数即可，快照文案空间有限

---

## 附 A · 核实证据索引（本 spec 引用的 file:line 均经 Analyst 实测核对）

| 证据 | 位置 | 核实方式 |
|---|---|---|
| 条目头 tag 序列与 [summary] 扩展先例 | lib/store.js:138, 209-261 | read |
| 命中回填钩子（list/expand 出入口） | lib/index.js:1195-1298（query 调用点 :1256）, 1424-1462 | read |
| 快照变化检测 / 注入分层先例 | lib/index.js:525-535, 543-777（memory/user :575-584、key 两档 :603-628） | read |
| 配置旋钮先例（keyProgressiveDisclosure） | lib/index.js:94-97, 604-628 | read |
| isCanonical round-trip 口径 | lib/store.js:321-323 | read |
| add/replace 写路径与去重 | lib/store.js:814-899 | read |
| withLock / 原子写先例 | lib/store.js:387, 785-790 | read |
| 同步 fileset 固定文件清单 | lib/sync/filesets.js:26, 33 | grep |
| 审查计数器 / dueWarning 渲染点 | lib/review.js:89-132, lib/index.js:117, 718-719 | read |
| i18n 单表双键机制 | lib/i18n.js:33-79 | read |
| 零依赖 / node --test 脚本 | package.json（无 deps 字段, scripts.test） | read |
| 测试直跑形态（node:test import） | tests/aliases.test.js:4 | read |
| git HEAD = c337dc1 | git log | pwsh 实测 |
| autoSummary 兜底 | lib/store.js:160-175 | read |

## 附 B · skipped 记录（未执行项，不计入通过项）

| skipped 项 | 原因 | 复跑命令 |
|---|---|---|
| 未运行任何现有测试 | Analyst 只读纪律（除报告落盘外不改文件；跑测试会产生临时目录写入） | `node tests/<file>.js`（逐文件直跑） |
| lib/sync/merge.js 未逐行复核 | 采信 C 报告勘察证据（file:line 已交叉核对一致的口径） | `node tests/sync-*.test.js` |
| vendor/ 目录未读 | 任务书明示跳过 | — |
| 运行时行为未实测（快照渲染/工具调用） | 同只读纪律；全部结论为代码证据口径 | 集成验证移交 executor 的 AC-6.7 真实输入全量跑 |
