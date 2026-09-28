# 计划 · autopilot-memory-lifecycle（记忆生命周期元数据层实施计划）

- 产出：Planner（dsh-agents，HIGH 档 glm-pro/glm-5.3）· 2026-09-23
- 上游 spec：docs/specs/autopilot-memory-lifecycle.md（35 条 AC，AC-1~AC-6；本计划所有 AC 编号均指该 spec）
- 代码基线：main @ c337dc1（本计划所有 file:line 已由 planner 逐一复核，与 spec 附 A 一致）
- 本批范围（组织者已裁定）：候选 1+2+3+5 = 命中驱动强化调度 + 条目级 salience + 衰减归档候选 + 审查联动，全部落侧车 hit-stats.json 基建；语义检索（候选 4）下批。
- 硬边界：不动 skills/ 与 lib/sync/（上游 #58 在途）；零 npm 依赖；主轨文件字节不动（高频写只落侧车与报告）；快照默认行为零变化（新行为全部挂默认 off 的旋钮）。

---

## 一、批次裁定确认（spec 第六节 8 条开放问题 → 逐条缺省决策）

> 依据任务书第 5 条：不再升级提问，以下为计划的缺省决策（决策 + 理由 + 可回退路径），executor 按此执行；实施期发现决策被证伪按「批准后修订纪律」回广播，不静默改。

| # | 开放问题 | 缺省决策 | 理由 | 可回退路径 |
|---|---|---|---|---|
| Q1 | 侧车键 = 条目内容 hash，replace 编辑后计数归零 | **接受**。hash 输入口径 = `parseEntries()` 返回的条目字符串**原样**（磁盘 round-trip 形态），禁止用展示剥离形态（stripEntrySummary/stripEntryId 之后的文本）——list 分支 index.js:1256 `store.query` 返回的就是原文，剥离只发生在 :1292 的 result 构造，回填钩子必须在剥离前取条目 | 编辑=新生命周期（A M4 检索练习语义）；replace 低频，历史计数损失可忽略 | 未来可改双键（内容 hash + [id:]），侧车值结构留扁平 JSON 即可无痛迁移 |
| Q2 | 侧车不进同步 fileset → 命中统计设备本地 | **一期本地**。decay-report.json 的 metadata 预留 `deviceId` 字段位（空串缺省） | 同步分支 fileset 是固定文件清单（lib/sync/filesets.js:26,33），侧车进同步会产生海量噪音提交（spec 候选 1 核实发现 2）；跨设备聚合无真实需求 | 出现多设备需求时：新增 fileset + 合并策略，独立 spec |
| Q3 | salience 由谁打 | **只接受显式传参**（memory add 的 salience 参数，整数 1-3 钳制）；不做 LLM 自动打分，也不做写入时自动建议 | A M6 flashbulb 陷阱 + 校准差（spec 非目标 10） | 下批评估 memory_suggest 待确认队列的建议通道（用户确认后才落 tag） |
| Q4 | 衰减阈值 30/90/180 天初值无校准依据 | **按初值上线**，config `decayThresholds`（数组，按 salience 1/2/3 索引；单项 0=永不）可调；上线后按首个真实 decay 报告的分布回看调整 | guji「抓完分布后校准」同款纪律；阈值本来就是猜测，报告数据才是依据 | 改配置即可，无代码回退成本 |
| Q5 | 「注入算不算命中」 | **不算**。只有显式 list/expand 才计数；快照常驻注入是被动暴露（A M4：集中暴露≠检索练习） | 且注入若计数会让侧车每次快照渲染都写盘——前缀缓存保护（AC-1.2 的反向）直接被击穿 | 日后需要注入权重时加配置开关，独立小改动 |
| Q6 | memory-consolidate 技能消费 decay-report.json 的路径约定 | **本批只定义报告 JSON 格式契约**（spec AC-4 字段表），不写技能侧代码 | 上游 #58 v2 在途，skills/ 禁碰（spec 非目标 3） | #58 落地后技能侧自行接入，报告格式即接口 |
| Q7 | 语义检索（下批）的设计前置 | **本批零动作**（连配置键都不预留，避免占位配置污染） | 缓存失效 + dim mismatch 静默零命中（guji 实证）需独立 spec 与评审 | 下批独立 spec，前置约束已在 spec 非目标 4 预录 |
| Q8 | review 联动候选数是否分「全局轨 vs 项目轨」 | **一期合并计数**（一个总数） | 快照文案空间有限；报告本体有 track 字段可区分 | 文案空间允许时改分轨计数，纯文案改动 |

---

## 二、分支与测试策略

### 分支策略

- 从 main（c337dc1）切分支 **`feat/memory-lifecycle`**（`git switch -c feat/memory-lifecycle`）。
- **第一笔 commit 纳入 spec**：docs/specs/autopilot-memory-lifecycle.md 当前是 untracked（planner 实测 git status），切分支后先 `docs(spec): 记忆生命周期元数据层规格（命中强化+salience+衰减候选+审查联动）`，再开工——保证 feat 分支自包含、AC 编号可溯源。
- **每步完成即 commit 建检查点**（用户分块检查点纪律），提交信息照仓库惯例（git log 实测风格：`feat(scope)/fix(scope)/docs(scope): 中文描述`，scope 用模块名小写）。每步的 commit 标题见分步计划。
- 步内若验收门红两次以上，回上一步检查点定向修（`git diff HEAD~1` 圈范围），禁止跨步夹带。
- push 不在本批（本地检查点即可；push 时机由组织者/用户裁定）。

### 测试策略（全批统一，实施前先读）

1. **node 直跑**：沙箱禁 node --test runner（spawn EPERM），全部新测试文件用 node:test **import 形态 + 自执行入口**（照 tests/aliases.test.js:4 先例），保证 `node tests/<file>.js` exit 0。交付物附直跑命令清单（AC-6.6）。scripts.test 的 `node --test` 不改（沙箱外/用户终端仍可用）。
2. **测试与实现同分支**（feat/memory-lifecycle），测试文件随所在步骤一起 commit。
3. **断言鉴别力三项**（用户固化纪律，缺一即该测试不合格）：
   - **≥3 元素输入断言**：AC-1.1（5 条命中 3）、AC-2.3（4 类条目解析矩阵）、AC-4.1（5 条筛出 3）、AC-6.1（≥3 种旧头部形态）——单元素断言分不出「串接」还是「取首个」，零鉴别力；
   - **注入必红负向自测**：AC-2.3 第 4 类（正文含字面 `[salience:9]` 不得误解析）、AC-3.4（开/关分层两份快照必须不同——防旋钮失效恒同现状的假绿门）、AC-5.2（报告缺失时快照逐字节同无联动版）；
   - **真实输入无 workaround 全量跑**：AC-6.7——复制本机真实 ~/.dsh/memories 到工作区临时目录（**只读副本，绝不写回原目录**），MemoryStore 指向副本跑 list/decay/snapshot 全链路。
4. **新增测试文件清单**（全部新建，不改旧测试断言；旧测试若因新增 action enum/schema 失效，修复属对应步骤职责）：
   | 文件 | 所属步骤 | 覆盖 |
   |---|---|---|
   | tests/hit-stats.test.js | Step 1 | AC-1.3/1.4/1.7 + 模块单测（读写/原子性） |
   | tests/hit-stats-backfill.test.js | Step 2 | AC-1.1/1.2/1.5/1.6 |
   | tests/snapshot-golden.test.js | Step 3 先行创建 | 快照黄金基线（服务 AC-3.1/AC-5.2 的「逐字节同现状」对照） |
   | tests/store-salience.test.js | Step 3 | AC-2.1~2.5、AC-6.1/6.2/6.3/6.4 |
   | tests/memory-progressive-disclosure.test.js | Step 4 | AC-3.1~3.5、AC-6.8 |
   | tests/decay.test.js | Step 5 | AC-4.1~4.6 |
   | tests/review-decay-link.test.js | Step 5 | AC-5.1~5.3、AC-6.5/6.7 |
5. **黄金基线纪律（重要，防 AC-3.1 假绿）**：AC-3.1 要求「与改造前逐字节一致」——对照基线必须在 **Step 3 动 strip 链之前**捕获（固定 fixture store + 默认 config 的 renderSnapshot 输出，嵌为 golden 字符串断言）。它同时守住 Step 3（strip 链）、Step 4（注入分层）、Step 5（dueWarning 联动）的默认零变化。基线捕获是 Step 3 的第一个动作，不是 Step 4 的。
6. **i18n 双语**：凡新增用户可见文案（zh 文案进 i18n.js 单表双键），zh/en 必须成对（AC-6.8，i18n.test.js 键对齐测试兜底）。涉及步骤：Step 3（钳制回显）、Step 4（快照头文案 + 取全文指引）、Step 5（decay 回显 + 无候选 + dueWarning 联动文案）。Step 1/2 无用户可见文案（侧车静默，AC-1.4 告警走 console.error 不算 UI 文案）。
7. **覆盖率（AC-6.9）**：Step 5 收尾统一测量——NODE_V8_COVERAGE 配方（注意 V8 range 是 UTF-16 字符偏移非字节偏移，源码含中文注释，按 JS 字符串长度建行偏移表；多进程报告逐文件独立取最内层 range 再跨文件 OR）。目标 100%，达不到逐项说明未覆盖行原因（防御性分支/平台守卫等），交付「数字 + 说明表」。

---

## 三、分步计划（5 步，主交付）

> 执行顺序缺省串行 1→2→3→4→5。理论并行性已标注，但 3/4/5 都在 lib/index.js 快照与工具区活动，单 executor 串行最稳（merge 冲突与 golden 基线时序都免去）。

### Step 1 · 侧车基建：lib/hit-stats.js（后续所有步骤的地基）

- **目标**：新建 `lib/hit-stats.js`——命中统计侧车存储模块，零依赖（node:crypto createHash('sha1') + node:fs）。
- **涉及文件**：
  - 新建 `lib/hit-stats.js`（唯一实现文件）：
    - `hitKey(track, entry)`：键 = `track + ':' + sha1(entry)`，entry 用 parseEntries 返回的条目字符串**原样**（Q1 口径）；
    - `readSidecar(dir)`：读 `<dir>/hit-stats.json`，不存在→空表返回（AC-1.3 冷启动）；JSON.parse 失败/垃圾字节→console.error 告警 + 返回空表（AC-1.4 损坏降级，统计静默重置）；
    - `bumpHits(dir, track, entries)`：批量 +1 并写 lastAccessed（当日 ISO 日期）；内部复用 store.js:387 `withLock`（import 复用，不重复实现锁）+ 原子写（tmp+rename，照 store.js:785-790 先例）；读改写全程 try/catch——**任何侧车异常不得上抛**（失败隔离契约，Step 2 依赖）；
    - 侧车文件路径约定：全局轨（memory/user）落 `<memoryDir>/hit-stats.json`，key 轨落项目记忆目录 `projects/<id>/hit-stats.json`（路径解析复用 MemoryStore 的 resolveTarget/dir 逻辑，或由调用方传入 dir——实现时二选一并注释钉死）。
  - 新建 `tests/hit-stats.test.js`（node:test import 形态）。
- **完成判据（本步覆盖 AC-1.3 / AC-1.4 / AC-1.7）**：
  - AC-1.3：无 hit-stats.json 的既有目录首次读写 → 自动初始化无异常；
  - AC-1.4：写入垃圾字节后读写 → 不抛异常、统计重置、告警留档；
  - AC-1.7：grep 断言 `hit-stats` 不出现在 lib/sync/filesets.js 任何 fileset 清单（防未来误卷入同步）；
  - 原子性：写中断模拟（残留 .tmp 文件存在时下次读写不受影响）；
  - `node tests/hit-stats.test.js` 直跑 exit 0；`node --check lib/hit-stats.js` 语法过。
- **前置依赖**：无。
- **可并行性**：与 Step 3 可并行（互不触碰对方文件）；Step 2/5 依赖本步。
- **commit**：`feat(hit-stats): 侧车命中统计存储——原子写/损坏降级/不进同步 fileset`
- **失败时怎么办**：侧车损坏是设计内行为（读侧重建，AC-1.4 即验收）；测试红→本步独立无下游，`git switch main` 或 reset 本 commit 即回滚，修复后重来。

### Step 2 · 命中回填：list/expand 出入口接线

- **目标**：memory 工具 list/expand 返回结果后更新命中条目的 hitCount/lastAccessed（AC-1 主组），侧车异常绝不影响 list 返回。
- **涉及文件**：
  - `lib/index.js` list 分支（:1195-1298）：`store.query`（:1256）返回后、result 构造（:1286-1297）前，对 query 返回的**原始条目**（非 :1292 的展示剥离形态——Q1 口径）调用 `bumpHits`；仅 target ∈ {memory,user,key}（project/daily 日志轨豁免，AC-1.6）；**archived=true 子分支（:1199-1234）不计数**（归档条目不在主轨生命周期内）；整段 try/catch 包裹（Step 1 的失败隔离契约在此生效）。
  - `lib/index.js` expand 分支（:1424-1462）：命中 `found`（:1451）后对原文条目 bumpHits（expand 本就 key-only，AC-1.5）。
  - 新建 `tests/hit-stats-backfill.test.js`。
- **完成判据（本步覆盖 AC-1.1 / AC-1.2 / AC-1.5 / AC-1.6）**：
  - AC-1.1（≥3 元素）：fixture 建 5 条 memory 条目，`list filter` 命中 3 条 → 侧车恰这 3 条 hitCount=1、lastAccessed=当日，未命中 2 条无记录；
  - AC-1.2（前缀缓存保护）：list 前后对 MEMORY.md 做 SHA256 比对逐字节相同；
  - AC-1.5：key 轨 expand 一次 → 对应条目 hitCount +1；
  - AC-1.6：project/daily 的 list 不产生任何侧车写入（断言侧车文件不存在或无新键）；
  - 失败隔离：mock bumpHits 抛错 → list 仍正常返回（负向注入测试）。
- **前置依赖**：Step 1。
- **可并行性**：与 Step 3 可并行；Step 5 的 decay 依赖本步产出的 lastAccessed 数据。
- **commit**：`feat(memory): list/expand 命中回填——hitCount/lastAccessed 落侧车（失败隔离）`
- **失败时怎么办**：回填异常影响 list 返回 → 检查 try/catch 边界（契约：侧车永不影响主功能）；锁竞争疑虑 → bumpHits 的读改写已在 withLock 内、且检索频率低频可控，实测 list 延迟无感即过；彻底回退 = 删掉两个钩子调用点（各一处），侧车数据留存无害。

### Step 3 · 条目级 salience：[salience:N] tag 全链路

- **目标**：条目头新增 `[salience:N]` 程序元数据 tag（1-3，缺省无 tag=视为 2），覆盖写入/解析/剥离/展示全链路 + 向后兼容三连。
- **涉及文件**：
  - `lib/store.js`：
    - ENTRY_HEAD_RE（:138）与 splitEntryHead（:209-261）：token 序列在 `[summary:…]`（:247-251）之后追加 `[salience:N]` 剥离段（参照 summary 的三处同构实现：parseEntrySummary:145 / autoSummary:160-175 / stripEntrySummary:185-193 各自补 salience 对应位）；
    - 新导出 `parseEntrySalience(entry)`（返回 1|2|3|null——null=无 tag 视为 2 由调用方归一）、`stripEntrySalience(entry)`（AC-2.4 展示剥离，只剥头部位置、正文字面不动）；
    - stampEntry（add 路径 :822 调用处）：接受可选 salience，越界钳制 [1,3]、非数字拒绝（AC-2.5）；tag 写入位置 = summary 之后、正文之前（AC-2.1）；仅 memory/user/key 轨写 tag（project/daily 不标）。
  - `lib/index.js`：
    - memory 工具 schema 注册处：add 加可选 `salience` 参数（整数）；
    - add 分支（:1300 起）透传参数；
    - **展示剥离链扩展**（AC-2.4）：renderSnapshot :580/:583/:617 与 list :1231/:1292、expand :1460 的 `stripEntrySummary(stripEntryId(entry))` 外层/内层补 `stripEntrySalience`（对无 tag 条目零变化——golden 基线守住）。
  - `lib/i18n.js`：钳制/拒绝回显文案 zh/en 双键（Q3：无自动打分，无建议文案）。
  - **先行动作**：新建 `tests/snapshot-golden.test.js`——在改任何 strip 链**之前**捕获固定 fixture（含 [git]/[branch]/[summary]/纯时间戳/无 tag 各形态条目 + 默认 config）的 renderSnapshot 输出为 golden 字符串断言（AC-3.1/AC-5.2 的对照载体，贯穿 Step 3/4/5）。
  - 新建 `tests/store-salience.test.js`。
- **完成判据（本步覆盖 AC-2.1 / AC-2.2 / AC-2.3 / AC-2.4 / AC-2.5 + AC-6.1 / AC-6.2 / AC-6.3 / AC-6.4）**：
  - AC-2.1：add 带 salience=1 → 头部含 `[salience:1]` 且位于 `[summary:…]]` 之后、正文之前；splitEntryHead 剥离进 head（编辑正文 tag 原样保留）；
  - AC-2.2：不带参数 → 无 tag；
  - AC-2.3（≥3 元素 + 误命中负向）：4 类条目（无 tag / `[salience:2]` / `[summary:x] [salience:3]` / 正文含字面 `[salience:9]` 文本）解析各自正确，第 4 类正文不得被误解析为头部 tag；
  - AC-2.4：stripEntrySalience 导出 + 全量注入与工具回显不含 `[salience:…]`；
  - AC-2.5：0/4/-1/'x' → 钳制 [1,3] 或拒绝并回显，不产生非法 tag；
  - AC-6.1（≥3 形态）：旧头部形态文件 isCanonical=true，add/replace/list/archive 全通；
  - AC-6.2：含 [salience] 文件 parse→serialize round-trip isCanonical=true；
  - AC-6.3：用改造前 ENTRY_HEAD_RE 正则字面量（嵌测试留档）解析新文件 → 不抛错、条目数不变、[salience:x] 作为正文前缀保留；
  - AC-6.4：断言 package.json 无 dependencies/devDependencies 字段新增；
  - golden 基线：无 salience 条目 fixture 快照逐字节同改造前（先捕获后改造的时序由本步纪律保证）。
- **前置依赖**：无（与 Step 1/2 可并行；但 golden 基线必须先于本步 strip 链改动落盘）。
- **可并行性**：与 Step 1/2 理论并行（文件不相交——store.js/index.js 的改动区与 list 回填钩子不同段）；串行执行时放 Step 2 后。
- **commit**：`feat(store): 条目级 salience 标记——[salience:N] 解析/钳制/展示剥离 + 快照黄金基线`
- **失败时怎么办**：round-trip 破坏 → AC-6.2/6.3 定位（大概率 ENTRY_HEAD_RE 的 salience 段可选性写错）；strip 链伤快照 → golden 基线当场红，回退本 commit；tag 误命中正文 → AC-2.3 第 4 类负向已钉。

### Step 4 · 快照分层注入：memoryProgressiveDisclosure

- **目标**：memory 轨（连带 user 轨同机制）快照注入分层——默认 off 零变化，auto/on 模式下低/无 salience 条目摘要注入、`[salience:3]` 恒全量。
- **涉及文件**：
  - `lib/index.js`：
    - config 区（:94-97 keyProgressiveDisclosure 先例后）：`memoryProgressiveDisclosure: 'off'`（缺省）+ `memoryFullInjectThreshold` / `memoryFullInjectCharLimit`（auto 模式双阈值，先例值照 key 轨 3/1500）；
    - renderSnapshot memory/user 全量注入段（:575-584）：照 key 两档段（:603-628）扩三态——off=现状全量；auto=条目数与总字符均未超阈值才全量，超则分层（无标记与 salience 1/2 → 摘要注入：显式 [summary] 优先、autoSummary 兜底；[salience:3] 恒全文）；on=恒摘要（salience:3 除外）。摘要行格式沿用 key 轨 `- [短id] 摘要` 形态（memory 轨取全文走 list 全量，AC-3.5 文案指明——**无需扩 expand**，expand 是 key-only）；
    - config 校验段（:516-521 附近先例）：新旋钮值合法性校验。
  - `lib/i18n.js`：摘要头文案 + 取全文指引文案，zh/en 双键（AC-3.5/AC-6.8）。
  - 新建 `tests/memory-progressive-disclosure.test.js`（参照现有 tests/progressive-disclosure.test.js 的 key 轨先例写法）。
- **完成判据（本步覆盖 AC-3.1 / AC-3.2 / AC-3.3 / AC-3.4 / AC-3.5 + AC-6.8）**：
  - AC-3.1（默认零变化，负向）：off/缺省时固定 store+config 的 renderSnapshot 输出与 golden 基线**逐字节一致**；
  - AC-3.2：auto + 超阈值 → 无标记与低/中 salience 条目摘要注入（[summary] 优先、autoSummary 兜底），salience:3 全文；
  - AC-3.3：auto + 未超阈值 → 全量注入；
  - AC-3.4（注入必红）：同一 store 开/关分层两份快照断言**不同**（防旋钮失效假绿门）；
  - AC-3.5：摘要注入段头部文案告知模型可用 list 取全文；
  - AC-6.8：新增 i18n key zh/en 齐全（键对齐测试过）。
- **前置依赖**：Step 3（读 parseEntrySalience；golden 基线已在位）。
- **可并行性**：不可并行（依赖 Step 3 的 tag 解析与基线）。
- **commit**：`feat(snapshot): memory 轨分层注入 memoryProgressiveDisclosure（默认 off 零变化）`
- **失败时怎么办**：注入路径回归 → AC-3.1 golden + AC-3.4 必红双门定位（红 AC-3.1=改到了默认路径；红 AC-3.4=旋钮没接通）；auto 阈值语义错 → 对照 key 轨 :603-628 逐行核对双阈值合取逻辑；最坏回退 = 旋钮删掉即回现状（默认 off 本就是零变化设计）。

### Step 5 · 衰减候选报告 + 审查联动 + 全局收尾

- **目标**：memory 工具新 action `decay` 产出归档候选清单（只读派生，绝不删除）；review 到期时快照 dueWarning 附加候选数；全批向后兼容回归 + 真实输入全量跑 + 覆盖率说明表。
- **涉及文件**：
  - `lib/store.js` 或新建 `lib/decay.js`（推荐独立模块，主逻辑纯函数便于测试）：候选判据 `daysSince(lastAccessed ?? extractEntryDate(entry)) > decayThresholds[salience]`；扫描三轨（memory/user/key）；报告写 `<memoryDir>/decay-report.json`，字段 = 每条 {track, id/hash, lastAccessed, days, threshold, salience, 原因} + metadata {generatedAt, fallbackCount, deviceId（空串占位，Q2）}；幂等覆盖写（原子写先例）；threshold 配 0 该档永不进候选（AC-4.5）。
  - `lib/index.js`：
    - config：`decayThresholds: [30, 90, 180]`（Q4 初值，按 salience 1/2/3 索引）；
    - memory 工具 schema：action enum 加 `'decay'`；decay 分支调 lib/decay.js，回显含候选数/无候选明示（i18n）；
    - dueWarning 渲染点（:718-719）：due 且 decay-report.json 存在且非空 → 文案附加候选数（合并计数，Q8；只读报告文件，AC-5.3）。
  - `lib/i18n.js`：decay 回显 + 无候选 + 联动文案 zh/en 双键。
  - 新建 `tests/decay.test.js`、`tests/review-decay-link.test.js`。
- **完成判据（本步覆盖 AC-4.1~4.6 + AC-5.1~5.3 + AC-6.5 / AC-6.6 / AC-6.7 / AC-6.9）**：
  - AC-4.1（≥3 元素）：5 条构造（3 条超阈值低 salience + 2 条近期命中）→ 报告恰含那 3 条，字段齐全；
  - AC-4.2：无侧车记录条目按条目时间戳回退判定，metadata 标注 fallback 条数；
  - AC-4.3：连跑两次 decay → 报告一致（幂等覆盖）；
  - AC-4.4（只读派生）：报告生成前后三个主轨文件 SHA256 不变；
  - AC-4.5：salience:3 按 threshold[3]（默认 180d）判定；threshold 配 0 永不进候选；
  - AC-4.6：零候选 → 空数组报告 + 回显「无候选」明示；
  - AC-5.1：reviewEnabled=true + 计数到期 + 报告非空 → dueWarning 含候选数；
  - AC-5.2（负向）：review 关闭（默认）或报告空/不存在 → 快照与无联动版逐字节一致（golden 基线）；
  - AC-5.3：联动路径只读报告文件，无任何自动整理动作；
  - AC-6.5：`git status` 证明 skills/ 与 lib/sync/ 零改动；
  - AC-6.6：全部新增测试 node 直跑 exit 0 + 命令清单；
  - AC-6.7（真实输入全量跑）：复制本机 ~/.dsh/memories 到工作区临时目录（只读副本纪律；副本目录加 .gitignore），MemoryStore 指向副本跑 list / decay / snapshot 渲染全链路——无异常、快照可完整解析、报告产出；
  - AC-6.9：新增/修改模块行覆盖测量（NODE_V8_COVERAGE，UTF-16 偏移口径）+ 未覆盖行逐项原因说明表。
- **前置依赖**：Step 1+2（侧车与 lastAccessed 数据）+ Step 3（salience 值）。
- **可并行性**：与 Step 4 无强数据依赖，但都改 lib/index.js 快照区——缺省在 Step 4 后串行。
- **commit**：`feat(decay): 衰减归档候选报告 + review dueWarning 联动 + 真实输入全量回归`
- **失败时怎么办**：真实数据翻车（AC-6.7）→ 副本原则保证原目录零风险，逐条目定位（大概率旧库罕见头部形态）；沙箱读 ~/.dsh/memories 被拦 → pwsh Copy-Item 复制到工作区再指向副本（读取通常不受限，复制是保险动作）；decay 误判 → 报告只读不删（AC-4.4 断言），改 config 阈值即调（Q4）；覆盖率不达标 → 按纪律逐项说明，不硬凑。

---

## 四、风险与回退（总表）

| 风险 | 概率/影响 | 缓解（设计内） | 回退动作 |
|---|---|---|---|
| 侧车损坏/写中断 | 低/低 | tmp+rename 原子写 + 读侧损坏静默重建（AC-1.4 即验收） | 无需回退——重建即恢复，最坏丢统计 |
| 回填影响 list 主功能 | 中/高 | 失败隔离契约（try/catch 全包 + 负向注入测试）+ AC-1.2 字节不变断言 | 删两个钩子调用点（各一行），侧车留存无害 |
| strip 链改动伤快照默认输出 | 中/高 | golden 基线先行（Step 3 第一个动作）+ AC-3.1 逐字节断言 | 回退 Step 3 commit |
| 旧解析器兼容破坏（round-trip） | 低/高 | AC-6.1/6.2/6.3 三连负向 + tag 可选性正则（salience 段 min=0） | 回退 Step 3 commit |
| 注入分层改坏主路径 | 中/高 | 默认 off + AC-3.1（同现状）+ AC-3.4（必红，防假绿）双门 | 旋钮默认 off 本就是零变化；删旋钮即回现状 |
| 衰减误判（阈值无校准） | 高/低（只读） | 报告绝不删除（AC-4.4 只读断言）+ config 可调（Q4） | 改 decayThresholds 配置，无代码回退 |
| 真实数据罕见形态翻车 | 中/中 | AC-6.7 只读副本全量跑（排除自造 fixture 通过、真实数据翻车路径） | 副本原则保证原目录零风险；定位后定向修 |
| skills/ 或 lib/sync/ 误碰 | 低/高 | AC-6.5 git status 门 + spec 非目标 3/计划头部硬边界 | restore 误碰文件 |
| node --test runner 不可用（沙箱） | 确定/低 | 全部测试 node 直跑设计（策略节第 1 条） | 用户终端 `npm test` 兜底全量跑 |

**执行中最可能卡的一步：Step 4（快照分层注入）**。理由：① renderSnapshot 是全插件最核心路径，AC-3.1 逐字节对照对基线时序敏感（基线必须在 Step 3 strip 链改动前捕获——若 executor 忽略「先行动作」纪律，对照的将是已污染输出，假绿）；② memory/user 轨摘要化的「取全文」指引与 key 轨 expand 机制不同（memory 无保护视图、走 list 全量，AC-3.5 文案需另设计）；③ auto 双阈值（条目数×字符合取）语义要与 key 轨先例对齐又有轨间差异。次卡点：Step 5 的 AC-6.7 真实输入全量跑（本机记忆目录含真实历史形态，V8 覆盖率 UTF-16 陷阱另需注意）。

## 五、验收对照表（35 条 AC ↔ 步骤映射）

| AC 组 | 条目 | 覆盖步骤 | 断言鉴别力标记 |
|---|---|---|---|
| AC-1 命中统计 | 1.1~1.7（7 条） | Step 1（1.3/1.4/1.7）+ Step 2（1.1/1.2/1.5/1.6） | **≥3 元素**=1.1 |
| AC-2 salience | 2.1~2.5（5 条） | Step 3 | **≥3 元素+必红**=2.3 |
| AC-3 分层注入 | 3.1~3.5（5 条） | Step 4（3.1 基线载体=Step 3 先行） | **必红**=3.1/3.4 |
| AC-4 衰减报告 | 4.1~4.6（6 条） | Step 5 | **≥3 元素**=4.1 |
| AC-5 审查联动 | 5.1~5.3（3 条） | Step 5 | **必红**=5.2 |
| AC-6 兼容与全局门 | 6.1~6.9（9 条） | Step 3（6.1/6.2/6.3/6.4）+ Step 5（6.5/6.6/6.7/6.9）+ Step 4（6.8） | **≥3 元素**=6.1；**真实输入**=6.7 |

**本批完成判据**：AC-1~6 全绿 + AC-6.7 真实输入全量跑 + AC-6.6 直跑命令清单（spec 第五节验收链原文）。

## 六、明确标注「下批」的项（装不下 + 理由）

| 下批项 | 理由 |
|---|---|
| 候选 4 语义检索通道 | 独立模块；缓存失效/dim mismatch 静默零命中守卫/降级语义需独立 spec 与评审（guji 实证教训前置）；默认关零影响不急于本批 |
| sleep-time 完整编排（idle 唤醒整理） | 会话编排层改动超出插件本批；候选 5 最小接线已覆盖价值主干 |
| archive 扩 project/daily | 与上游 #58 冲突面相邻；归档消费方在技能侧（skills/ 禁碰） |
| 写入时自动建议 salience（memory_suggest 通道） | 产品层决策（A M6 flashbulb 风险），Q3 留待下批评估 |
| 反馈行消费/【反馈】加权 | 情绪信号→巩固优先级映射需产品层决策 |
| bi-temporal 双日期 | 有价值但独立于生命周期主线，5 步装不下 |

---

*计划终。执行入口：executor 从 Step 1 开工，每步完成即 commit；实施期 spec 证伪走批准后修订纪律（广播组织者，不静默改）。*
