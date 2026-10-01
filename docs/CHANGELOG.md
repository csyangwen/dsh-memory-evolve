# 更新日志（Changelog）

本仓库所有版本变更记录，按日期倒序排列。

> [English](CHANGELOG.en.md)

## 未发布

### 修复

- **技能管理在 DSH 0.2.0-rc.2 上列表全空：`standingKeyFor` 被移除 + 启动竞态把失败永久缓存（两层根因）**：① rc.2 把 `agentPresets` 的 `standingKeyFor()` 换成 `acquireScope(id?)`（返回 `{ key, [Symbol.asyncDispose] }` 租约），`resolveScope` 的 `typeof presets.standingKeyFor !== 'function'` 守卫把新宿主判成「无服务」→ scope 永远 `undefined` → 目录查询只读 global 层 → 列表空白（与 issue #6 同款症状）。修复为**双路径**：旧快照走 `standingKeyFor`（standing mount 常驻），新宿主走 `acquireScope` 并**常驻持有租约**（防默认 preset 运行期间被回收），inject 周期结束时 `asyncDispose` 释放。② 修完 ① 仍空：插件装配早于 preset 声明（bundle/profile patch 层）挂载，启动那一刻 `acquireScope(undefined)` 抛 `Unknown agent preset`，旧代码把这次失败 `scopeCache = null` **永久缓存** → 之后 preset 挂上了也永远空白。`standingKeyFor` 时代不校验 preset 是否存在、永远成功，这个时序假设从未暴露。修复：**探测失败不缓存**（每请求重试直到成功；并发请求共享同一次在途探测），只有「服务缺失/两代接口都不认识」这类确定性结论才缓存；`tests/skills-manager.test.js` 新增 acquireScope 路径与「失败重试不缓存」两个回归。

## 2026-09-28

### 修复

- **会话格式 v4 下插件注入消息会让接收方那一轮整轮失败（issue #68，阻塞级）**：DSH 0.1.7-rc.2 起会话持久化走 format v4，每条消息的 `source.kind` 必须由生产者自报（canonical 形态 `plugin:<包名>`，校验在 `@deepseek-ai/dsh-session-format-v3-to-v4` 的 message-sources 模块，持久化侧同规则）；v3 时代的「裸 `kind: 'plugin'` + 并列 plugin 字段」被**显式拒绝**：`format v4 message requires a producer-owned source kind`。插件有 4 处注入点仍在用旧写法——会话广播 / COI 通知（`lib/coi/index.js` 的 `deliver()`）、COI 任务状态通知（`lib/coi/scheduler.js` 的 `#deliver()`）、写冲突警告（`lib/coi/ws-coord.js` 的 `userMessage()`）与工作区活动公告板（同文件）。报错发生在**接收方会话认领该事件时**，所以症状是"注入所在的那一轮整轮失败"，而不是注入调用本身报错；又因为公告板需要活跃会话 ≥2、写冲突与 COI 通知靠事件触发，表现为"重启就好、过一阵复发"——重启只是清空了公告板基线 / 节流状态，并非修复。修复：新增 `lib/coi/source.js` 导出唯一常量 `PLUGIN_SOURCE_KIND = 'plugin:dsh-memory-evolve'`（与宿主 `producerKind()` 对未知生产者的映射一致），4 处全部改用它并删掉 `plugin` 字段。读取侧无需改动：`advisor` 用自己的 `kind: 'advisor'`，`review.js` 的 `lastTurnWasMessage()` 判 `undefined || 'user'`，新 kind 的语义不变。
- **带 `[summary:…]` 的条目在记忆 Tab 无法删除 / 编辑 / 归档，归档页也无法移回主记忆 / 删除（issue #59）**：根因是**展示层剥了程序元数据、匹配层没跟上**——`buildMemoryFiles()` 下发前会剥掉 `[summary:…]`（渐进式披露，2026-08-17 引入）与 `[id:…]`（2026-08-11 引入），前端 `MemoryTabView` 把这份展示文本当 raw 回传；而 `findExactIndex()` 只对 `[id:…]` 免疫，`peekExact()` 用 `includes()` 严格相等，归档侧 `ArchiveStore.removeExact()` 更是 `entries.indexOf()` 严格相等（**连 `[id:…]` 都不免疫**——启用 Git 同步后写入身份证的归档条目一律删不掉），`promoteArchived()` 的 `includes` 子串又被 `[summary:…]` 从中间截断。同一类问题第二次发生（第一次是 `[id:…]`），结论写进代码注释：**展示层每剥一种新元数据，匹配层必须同步扩展**。修复：`lib/store.js` 新增并导出 `normalizeForMatch(entry) = stripEntrySummary(stripEntryId(entry))`；`findExactIndex()` 改用它，并新增 `{ first }` 选项（主轨多条命中仍报歧义、保守拒绝；归档允许重复条目，取首条）；`peekExact()` 改走 `findExactIndex` 并**返回磁盘原文**（归档「先写后删」因此保留 `[id:…]` / `[summary:…]`，转正回主轨不丢元数据）；`ArchiveStore.remove()` 与 `removeExact()` 两侧统一归一化；`promoteArchived()` 的 `hits` 与随后的 `archive.remove()` **必须同一套基准**——只修 `hits` 不修 `remove` 会出现「转正成功但归档那条删不掉」→ 同一内容同时留在主轨与归档，且全程没有报错提示。
- **`runGit()` 的 30s 网络超时实际不生效——超时只杀直接子进程，Promise 可能永不 settle（issue #69，阻塞级）**：`git ls-remote` / `git fetch` 会再派生 `git-remote-https`，它**继承并持有** stdout/stderr 管道写端；Node 的 `'close'` 事件要等所有 stdio 句柄关闭才触发，而 `resolve()` 只挂在 `'close'` 上——超时回调虽然把 `git` 杀了，`'close'` 却永不触发，于是 Promise 挂死。实测（本地 TCP 黑洞，比不可路由地址更确定）：修复前 120 秒内 Promise 从未 settle；修复后 **30022 ms 返回 `{ok:false, code:null}`** 并在 stderr 末尾标注超时。影响不止"卡一次"：同步在 systemd user timer 下周期运行，一次挂死就让调用方永远拿不到失败原因，`node --test` 跑 `tests/sync-*.test.js` 也会整片挂住。修复三层一起做：① `settle()` 单次落定——超时 / error / close 谁先到谁生效、后到的丢弃，否则会出现"超时返回失败、随后 close 又翻案成成功"；② 超时**主动 resolve** 一个失败结果，不再等 close；③ 落定后 `killGitTree()` 尽力清理——`detached` 进程组 + `kill(-pid)` 连带孙进程（Windows 无进程组信号，退回 `child.kill()`），并 destroy 两路管道让 `'close'` 得以触发。顺序上必须**先落定、再清理**：反过来的话 destroy 管道触发的 `'close'` 会抢在超时结果之前 resolve 成一个假的成功。`NETWORK_TIMEOUT_MS` / `LOCAL_TIMEOUT_MS` 一并导出，供回归测试按真实阈值推进假定时器，避免测试另抄一份阈值后与实现漂移。
- **内置技能同步：`skillDir` 哨兵显式落地 + 成功/失败都不再静默（issue #67）**：issue 报告的"第二层"（`config.skillDir` 默认 `null` 未解析就传给 `syncBuiltinSkills()` 并抛 TypeError）**经复测不成立**——`resolveConfig()` 自首个提交起就有 `config.skillDir = resolve(config.skillDir ?? join(homedir(), '.agents', 'skills'))`，而 `apply()` 是先 `resolveConfig()` 再 `installCoi()`，调用点拿到的从来是字符串（实测 `resolveConfig({}).skillDir` → `C:\Users\…\.agents\skills`；本机 `~/.agents/skills` 里五个内置技能俱全，`memory-consolidate` 的落盘时间正是插件启动那一刻）。真正成立的是 #58 的第一层：调用点在 `installCoi()` 内、而 `installCoi` 由 `coiEnabled`（默认 false）门控——**默认配置下内置技能不会同步**，这一层由同批的 `e73a28e` 一并解决（见下条）。本次修的是 #67 里仍然值得修的三点：① 调用点显式兜底 `config.skillDir ?? DEFAULT_SKILL_DIR`（新增导出常量，与 `resolveConfig()` 的解析结果由测试钉成一致），`syncBuiltinSkills()` 则对非字符串入参抛**看得懂**的错（点名参数 + 指出该用 `resolveConfig()` 还是 `DEFAULT_SKILL_DIR`），不再把 Node 的 `The "path" argument must be of type string` 抛给上层；② 每次同步都落一行可见日志（目标目录 + 总数 + 更新数），`action: 'missing'`（插件包内缺该技能 = 打包事故）单独 warn，catch 打完整堆栈——此前成功路径只在有变更时 log、失败路径只有一行 warn，"技能从来没装上"只能靠反查技能目录的 mtime 才能发现；③ **顺带修掉同一路径上一个 Windows 专属缺陷**：`skillVersion()` 的 `^---\n` 只认 LF，而 Windows 上 `core.autocrlf=true` 检出的 SKILL.md 是 CRLF——源与目标都解析出 0，版本门控退化成"永远相等"，**x-version 升级在 Windows 上静默失效**（首次安装因目标不存在仍会复制，所以只有"升级不生效"这一半可见；本机 `~/.agents/skills` 里那五个技能正是这么来的）。改为 `^---\r?\n…` 后 CRLF 与 LF 解析一致。同源的 `normalizeSkillText()` 在 CRLF 下也把已有 frontmatter 误判成"没有"并叠加第二份头，一并改为按 `trim()` 比较边界行（不重写用户文本的换行）。
- **内置技能同步被 COI 开关连带关闭：默认配置下内置技能永远装不上（issue #58）**：`syncBuiltinSkills()` 的调用点原本在 `installCoi()` 内，而 `installCoi` 由 `coiEnabled` 门控（默认 `false`——本插件本职是记忆/待办/技能，调度是按需增强），于是 `memory-consolidate` 与 kimi/codex/grok/hermes 四个 CLI 使用指南在**默认配置下永远不会进技能库**；调用点又包着 try/catch 只打一行 warn，连"从来没跑过"都留不下痕迹（与 §7.5 broadcast 当初"独立子模块挂在 COI 下拆不开"是同款事故）。修复：同步提到插件主装配（`lib/index.js` 的 `apply()` 步骤 6.5），实现抽成 `lib/coi/skills-sync.js` 的 `syncBuiltinSkillsIfEnabled(config, pluginSkillsDir?)`——**判定只看 `coiSyncSkills`，代码里不再出现 `coiEnabled`**；`PLUGIN_SKILLS_DIR` 一并移过去并导出（供测试断言源头确实在包内），`installCoi()` 内的调用与模块级常量删除，该模块只剩适配器指南的写入需要 `normalizeSkillText`。`coiSyncSkills` 的语义随之明确为"启动时是否把内置技能同步到技能库"，与调度开关无关。
- **收尾的 key 建议没写明用哪个工具（issue #58 第二项）**：`snap.keyDuty` / `snap.subagentKeyTail` 只说"另向 target=key 提交 1 条建议"，而 `memory_suggest` 的 target 白名单是 `['memory','user','todo-life','todo-work','todo-project','todo-daily']`（`lib/review.js`），**不含 key**——照字面选工具即报"不支持 target=key"，会话收尾会反复踩。走待确认队列的正规通道是 memory 工具的 `add`（与 `memory_suggest` 共用 `enqueueSuggestion` 队列）。两处文案改为"另用 memory 工具 action=add 向 target=key 提交 1 条建议（走待确认队列，用户确认后写入并注入）"，中英同步。

- **适配 DSH 0.2.0-rc.1：settings 服务读接口与提交事件改名（静默降级，无报错）**：升级前机械比对新版 `packages/extensions/tool-cordis/src/api-catalog.ts`（老 0.1.5-rc.2 → 新 0.2.0-rc.1）发现两处破坏性变更——① `ctx.settings.get(ns)` **被移除**（新版改为 `describe(options?)` 返回 `SettingsDescriptor[]`，每项 `{ ns, value, schema, revision, … }`，按 `ns` 自行查找；`register`/`installSection` 同时移除）；② 提交事件 `settings/updated(ns, next, prev, source)` **改名为** `settings/document-updated(ns, revision)`。插件有四处依赖：宿主侧语言解析（`lib/i18n.js`）、`de_models` 的供应商目录（`lib/models.js`）、会话编排按模型名解析 provider（`lib/session-orch.js`）、以及 `apply()` 里跟随语言切换的监听器（`lib/index.js`）。旧代码在新宿主上不会报错——`settings.get` 不存在时被 `typeof` 守卫挡掉、未知事件名只是永不触发——表现为「语言设置要重启才生效」「供应商目录读不到配置（表格空白）」「spawn 显式传 model 时解析不出 provider」，属最难查的静默降级。新增 `lib/settings-compat.js` 统一封装：老宿主走 `get()`，新宿主用 `describe()` 建一次表再查 `ns`（`makeSettingsReader` 保证「每个 provider 一次 describe」的平方级开销不会出现），读不到一律返回 `undefined` 按未配置处理、绝不抛错；监听器同时订阅新旧两个事件名（`SETTINGS_CHANGE_EVENTS`），两代宿主都能就地跟随。`ctx.get` 本身抛错也吞掉降级（读服务不该带崩 `apply()`）。
- **同类排查结论（本次一并核对，无需改动）**：服务目录 91 项、事件 81 项、`ctx` 继承 API 9 组逐条比对——插件使用的 `tools`/`agents`/`sessions`/`sessionPersistence`/`sessionTitle`/`skills`/`llm`/`webServer`/`workspaceRegistry`/`commands`/`systemPrompt`/`fs`/`approval`/`attachments` 方法集**零删减**；被移除的 `agent/session-start`、`settings/updated` 事件与 `codeRuntime`/`e2b`/`ctx.hmr` 插件均未使用；会话格式 `SESSION_FORMAT_VERSION` 3 → 4 由宿主按「世代文件」（`session.v4.jsonl.zstd` 旁挂，v3 原文件保留）自动迁移，插件按事件 id 记录的书签锚点不受影响；客户端模块加载契约（`window.__ModuleLoader__.load({id, factory})`）、静态模块表（react / react-dom / `@deepseek-ai/dsh-client-ui-primitives`）、`ctx.slots.inject/register`、客户端 `locale.bind/register` 全部未变。`agent/created` 仅返回值类型放宽为 `undefined | Promise<undefined>`，插件监听器同步返回，兼容。
- **供应商目录读取兜底**：`de_models` 与会话编排原来直接调用 `ctx.settings.get(...)`（`lib/models.js` / `lib/session-orch.js`），新宿主上会直接抛 `TypeError`；现改走兼容层，并保留原有的「读不到就按未配置处理」语义（不改变表格与 provider 解析的行为，只换读取通道）。
- **客户端崩溃级适配一：ui-primitives 图标导出被改名（旧名不是别名、是删除）**：DSH 0.2.0-rc.1 把图标导出从**尺寸后缀**改成**字重后缀**——旧 `IconWarningOutline16` / `IconChevronDownOutline14` / `IconFolderClose16` / `IconLoadingOutline16`，新 `IconWarningOutlineRegular` / `IconChevronDownOutlineRegular` / `IconFolderCloseRegular` / `IconLoadingOutlineRegular`（另有 `…Medium` = 1.3px 描边、`…Artwork` = 单图元）。旧名在新宿主上 `git grep` 零命中，即**彻底删除**；`import { IconWarningOutline16 }` 拿到 `undefined`，React 渲染 `undefined` 组件立刻抛 "Element type is invalid"，**技能管理 Tab 与画板 Tab 整块 UI 崩掉**（只在升级后才暴露，本地测试与宿主端日志都看不到）。新增 `src/client/ui-icons.ts` 跨版本解析层：`resolveIcon(新名, 旧名)` 按「`…Regular` → 旧 `…16`/`…14` → `…Medium` → 渲染 null 的空实现」四档解析，两代宿主共用同一份 bundle；`SkillsBrowser.tsx`（12 个图标）与 `CanvasView.tsx`（2 个图标）改为从这里 import，`src/client` 下不再有任何文件直连 `@deepseek-ai/dsh-client-ui-primitives`。新旧 `…Regular` 与旧 `…16` 同为 16×16 viewBox、默认 `size=16`，视觉一致。
- **客户端崩溃级适配二：切换会话入口 `sessions.open` 被移除**：旧宿主 `ctx.sessions.open(id)`（`ClientSessions.open`，0.1.5-rc.2 的 `packages/api/session-controller/src/client/sessions/service.ts:270`）在 0.2.0 里被删掉（同文件只剩内部 `waitForOpen`/`attachOpening`），官方改走 `ctx.uiWorkspace.openSession(id)`（官方 `ui-chat/src/client/apply.ts` 同款迁移）。旧写法编译期无感、加载期不报错，**只在用户点「跳转到会话」时抛 `TypeError: ctx.sessions.open is not a function`**（站内通知铃铛跳转、画板 footer「跳转」按钮）。新增 `src/client/client-compat.ts` 的 `openSessionCompat(ctx, id)`：老宿主优先走 `sessions.open`（行为一字不变）、新宿主回退 `uiWorkspace.openSession`、两者都不可用返回 `false`；两处调用点（`src/client/index.ts`）改走它，`ctx.get` 抛错也吞掉。

### 变更

- **内置技能 `memory-consolidate` 升 `x-version: 2`（外部 PR #58 第三项，按原文摘取）**：补四类实战边界——① **同一轨的写操作串行执行**（同一个 `.md` 是读-改-写，交错执行会互相覆盖、也会撞上 drift guard；一个簇处理完再动下一个）；② **`replace` 是整条替换**：`content` 必须给完整新全文，只传增量或新句子会**静默吞掉**其余段落（2026-09-16 实证：更正一条多段记忆时只写新句子，其余段落整条丢失，靠 memories 仓库的 git 备份才找回；改写前先用 `list`、key 轨可用 `expand` 把原文读全）；③ **key 建议用 memory 工具 `add`（`target=key`）提交，不要用 `memory_suggest`**（后者 target 白名单不含 key，传入即报「不支持 target=key」）；④ 新增「四、故障处理（异常兜底）」——drift guard 报「无法解析往返」拒写时的逃生路径（先备份 → 用插件自带 `lib/store.js` 做 `serializeEntries(parseEntries(text))` 规范化并校验往返条数不变 → 回到工具流程），以及「判断条目是否粘连只认 `parseEntries(text).length`」（用正则数 `\n§\n` 会因正文里逐字引用的内容性 `§` 假阳性）。技能正文取自 PR #58 的 `d78043d`，与该提交逐字节一致。**注意：这一项只有在本版之后才真正装得上**——此前 CRLF 检出下 `skillVersion()` 解析出 0、版本门控退化成"永远相等"，Windows 上 x-version 升级是静默失效的（见上）。

### 测试

- 新增 `tests/injection-source-kind.test.js`（4 例）：① 复刻宿主 v4 准入规则并做**前提自检**——该规则必须拒绝退役写法、且通过 canonical 写法，否则后面的断言都是假绿；② `PLUGIN_SOURCE_KIND` 的形状与准入；③ 扫描 `lib/` 不得残留退役写法；④ 扫描四处注入点必须引用同一常量（防未来新增注入点时又手写一份 kind）。行为侧证据落在既有用例上：`tests/coi.test.js`（会话广播 / 房间动态 / COI 完成通知）与 `tests/ws-coord.test.js`（写冲突 `additionalContexts` / 公告板）直接断言真实构造出来的消息对象满足 `source.kind === PLUGIN_SOURCE_KIND` 且 `source.plugin === undefined`；`tests/plugin.test.js` 与两个 advisor 用例里按旧写法构造的桩数据同步更新。
- 新增 `tests/store-display-match.test.js`（12 例）。关键设计：展示文本取自**真实的 `buildMemoryFiles()`**，测试里没有复刻一遍剥离逻辑——展示层将来再剥一种新元数据时，这些用例会跟着一起红，而不是"测试全绿、线上仍坏"。覆盖：`normalizeForMatch` 只剥头部（正文里的 `[summary:…]` 字面量不动，且两条只差该字面量的条目仍分得清）；主轨删除 / 编辑（时间戳与摘要原样保留）/ 分支范围 / `[dsh-only]` 四个精确操作；`peekExact` 返回磁盘原文；归档页删除（带 summary 与**只有 `[id:…]`** 两种，后者单独钉一条）；归档重复条目取首条；`promoteArchived` 转正后**断言归档文件已清空**（防"只修 hits 不修 remove"的半吊子修复）；以及"归一化后多条命中 → 保守拒绝、一条都不动"。已验证：把 `normalizeForMatch` 退回旧的"只 stripEntryId"行为后，12 例中 5 例必失败。
- 新增 `tests/sync-git-timeout.test.js`（7 例，其中 1 例 POSIX 专属）：注入**永不 emit `'close'`** 的假子进程（等价于"孙进程占着管道"），用 `mock.timers` 按真实阈值推进，断言「未到点不得 settle」「到点必须 settle 且带超时说明与命令行」「迟到的 `'close'` 不得把结果翻案成成功」「两路管道被 destroy」「正常路径与 spawn 报错不受影响」。为避免回归退化成**挂死**——旧实现下 Promise 永不 settle，直接 `await` 会让测试进程一直挂着而不是报错——等待改用 `setImmediate` + `Date.now()` 轮询的真实时间预算，超预算直接抛出明确断言。另加一条 POSIX 专属用例：真实 detached 子进程 + 真实孙进程（正是 `git → git-remote-https` 的形态），验证 `kill(-pid)` 把整棵树清掉；Windows 没有进程组信号（也没有 SIGKILL 语义），跳过——Windows 上的保证是"调用方不再被拖住"，孙进程可能活到它自己超时。已验证：把超时回调退回旧的"只 kill 不落定"，7 例中 4 例必失败，且是**明确的断言失败而非挂起**。
- 新增 `tests/skills-sync-default-dir.test.js`（6 例）：① `DEFAULT_SKILL_DIR` 与 `resolveConfig({}).skillDir`、`resolveConfig({ skillDir: null }).skillDir` 必须一致（哨兵解析只有一处权威，防两处定义漂移），显式配置不被覆盖；② `syncBuiltinSkills(ps, null | undefined | '')` 抛的错必须点名 `userSkillsDir`、指出正确做法，且**不含** Node 的 `The "path" argument must be of type string`；③ 打包守卫——`BUILTIN_SKILLS` 每一项都必须真的在插件包 `skills/` 里且有含 name/description 的 frontmatter（把运行期静默的 `action: 'missing'` 变成红测试）；④ 用插件包真实内容同步：五项全部落盘、零 `missing`、二次全 `unchanged`；⑤ **CRLF 下 x-version 升级必须生效**（把新版正则退回 LF-only 后该例必失败——已验证）；⑥ `normalizeSkillText` 在 CRLF 下不叠加第二份 frontmatter，缺字段与未闭合仍要报错。
- 新增 `tests/skills-sync-decoupled.test.js`（8 例）：源头在包内（`PLUGIN_SKILLS_DIR` 指向仓库 `skills/` 且五项齐全）；**`coiEnabled:false` 不影响同步**（issue #58 的要害）；`coiSyncSkills:false` 是唯一关断开关（`coiEnabled:true` 也照样不同步，且连技能库目录都不创建）；`skillDir` 哨兵落到 `DEFAULT_SKILL_DIR`（用**空的内置源头**避免写入真实技能库，目标目录改由日志行断言）；同步抛错收口成一条带原因的 warn 并返回 null；每次启动都汇报结果（含最常见的"共 5 个，更新 0 个"）；源头缺失时逐个记 `missing` 并 warn；目标路径被同名文件占位时同样收口不抛。
- `tests/plugin.test.js` 新增两条**装配级**用例（跑真实 `apply()`）：`coiEnabled:false` 时五个内置技能必须落盘、`coiSyncSkills:false` 时连技能库目录都不创建。已验证「摘掉主装配调用」后第一条必失败。同文件的快照用例补上第二项的断言：key 建议必须点名 `memory 工具 action=add`，且不得出现 `memory_suggest target=key`（防止文案退化回"没写工具名"）。
- 新增 `tests/settings-compat.test.js`（13 例）：老宿主 `get()` 路径、新宿主 `describe()` 路径、服务缺失 / `get` 抛错 / `describe` 抛错 / 返回非数组 / 空 `ns` 一律 `undefined`、`makeSettingsReader` 的批量语义（新宿主只 `describe()` 一次；老宿主每次实时 `get()`）、事件名常量、`resolveLocale` 在新老两种形态下都解析出 `en`。
- `tests/plugin.test.js` 新增 1 例集成用例：`apply()` 在 get 形态与 describe 形态两种 settings 服务下、监听 `settings/updated` 与 `settings/document-updated` 两个事件名都能就地切换语言（`document-updated('models')` 不得误改语言）。
- 新增 `tests/client-icons-compat.test.js`（5 例静态护栏）：除 `ui-icons.ts` 外禁止任何 client 源文件 import ui-primitives；TSX 里禁止残留 `…16`/`…14` 旧名；shim 里旧名只能作为 `resolveIcon` 的兜底参数出现；每个 `resolveIcon(新名, 旧名)` 的新名以 `Regular` 结尾、旧名以 `16`/`14` 结尾；构建产物 `lib/client.js` 同时带新旧两套名字（证明解析分支没被静态折叠）。
- 新增 `tests/client-compat.test.js`（6 例）：`openSessionCompat` 在「有 `sessions.open`」「只有 `uiWorkspace.openSession`」「两者都无」「空 id / 抛错的 `ctx.get`」四种情形下的选择与降级；`src/client` 里禁止再出现 `ctx.sessions.open(...)` 直调（注释除外）；产物里同时含 `uiWorkspace` 与 `openSession`。该用例直接 import `src/client/client-compat.ts`（Node 22.18+ 原生剥离类型，无需构建）。
- 全量 842 例通过（840 存量 + 2 新增文件）。

---

## 2026-09-15

### 修复

- **记忆正文被同步链路持续损坏成 U+FFFD 替换字符（根因，阻塞级）**：MEMORY.md 与 daily 日志里长出 `�`（线上实证 45 处、跨四天静默累积；本机 4 个 daily 文件 11 处），格式预检（`isCanonical`/parse→serialize 往返）**照样放行**，所以一直没人发现。根因在**同步读路径**：`runGit()`（`lib/sync/repo.js`）收集子进程输出用的是裸 `String(chunk)` —— Buffer 的 `String(chunk)` 等价于 `chunk.toString('utf8')`，即**每个管道分块各自独立解码**；git 大对象按 32 KiB 块写管道，任何跨块边界的多字节字符（汉字 3 字节、emoji 4 字节）都被切成两段无效序列、各解码成一个 U+FFFD。传播链：`readTreeFiles()`（读远端 theirs / merge-base base）→ 损坏文本进场 → `mergeEntries` → 写回 → 提交 → 下次同步再把损坏读回来继续切，**逐轮累积**。法证：损坏文件所在提交的两个父提交都是 0 处损坏，合并结果却有 2 处，下一轮 2 → 3；4 个损坏文件的干净版本里，损坏字符起始字节偏移为 32766 / 32767 / 32766 / 81913 ——前三个**恰好跨越字节 32768**。修复：改为 `setEncoding('utf8')` 流式解码（Node 内部 StringDecoder 在分块边界保留半截序列、由下一块补齐）。同款问题一并修掉三处：`lib/sync/index.js`（worker 子进程 stdout/stderr，stdout 末行是 JSON，损坏会导致解析失败）、`lib/search-docs.js`（文档检索 `out += chunk`，损坏字符进检索结果）、`lib/coi/scheduler.js`（COI 任务日志，启动/恢复两条路径，损坏字符直接落进用户看的日志）。`runGit()` 顺带新增 `opts.spawnFn` 注入点（测试用，使"分块边界"可确定性复现）。
- **文档检索输出上限改按 UTF-8 字节计**：`lib/search-docs.js` 的 `maxBytes` 保护此前用 `out.length + chunk.length`（字符串 UTF-16 单元与 Buffer 字节混用）。改用 `setEncoding` 后 chunk 是字符串，沿用 `.length` 会把中文按 1/3 字节少算，故改为独立累计 `Buffer.byteLength(chunk, 'utf8')`。

### 测试

- 新增 `tests/sync-utf8-stream.test.js`（14 例）：注入假 spawn + 手动 `push` 的 Readable，把 2 / 3 / 4 字节字符在**每一个内部切点**分成两次投递（stdout、stderr 各 6 例），加逐字节最坏分块与真实子进程冒烟。每例都带"同一分块序列交给旧的逐块解码必然损坏"的**前提自检**，切点失效会直接失败而不是假绿。已验证：回退解码修复后 14/14 必失败。（第一版回归用真实子进程 + 60 ms 定时分写，经外援复核证伪为**可假绿**——父进程稍慢，两段就被合并成一个 data 事件，已改写为注入式。）

---

## 2026-09-14

### 修复

- **记忆正文里的 `{{...}}` 会把会话「毒死」（issue #53，阻塞级）**：宿主的系统提示词段渲染器把段正文里的 `{{name}}` 当模板变量解析，**未注册变量直接 throw**（宿主只注册 `provider`/`model`/`cwd`）。而 `memory:snapshot` 段把会话标题/别名、`memory`/`user` 轨、项目 KEY 轨的**原文**直接拼进去，此前只对提示词注入轨做了净化——于是记忆里出现一个字面量 `{{xxx}}`（真实案例：记录 `x-opencode-session: {{session}}` 这条事实）就等价于给所有注入该轨的会话埋雷：**该会话每一步、每一轮都起不来，且无法用 memory 工具自救**（工具调用需要回合，而回合已经起不来），只能手改记忆文件。现改为**整段快照在离开插件前统一净化**：`sanitizeSnapshotBody` 新增 `expand` 选项——注入轨保持 `expand=true`（用户写的就是待展开模板），记忆轨与整段快照用 `expand=false` **只降级不展开**（记忆里的 `{{date}}` 是用户记录的字面事实，展开会篡改内容；降级为 `{date}` 既保语义又让宿主不再解析）。`buildMemoryContext`（只喂外部 COI 执行器、不经过宿主渲染器）不做净化。渲染侧净化意味着**升级插件后已中毒会话自动恢复**，无需改动用户数据文件。
- **advisor 启用后每回合报 `TypeError: events is not iterable`（issue #49）**：与 issue #42 / PR #38 同源——DSH 0.1.2-alpha.4+ 的 `Session` 不再暴露 `.events` 数组，当时修了 `lib/review.js` 却漏了 advisor 装配层的 `session/event` 接线，监听器把 `undefined` 转给 observer，`findLastMessageTurnEnd` 对其做 `for...of` 即抛错。现沿用同款三档兜底 `session.ownEvents?.() ?? session.events ?? []`（新宿主走 `ownEvents()`，老宿主回退 `.events`，都拿不到时给空数组）。

### 新增

- **内置技能 memory-consolidate：记忆合并梳理（外部 PR #50）**：把随时间累积出的重复条目、新旧并存版本、相近分散表述，按七条标准（覆盖更新 / 相近合并 / 字面去重 / 冲突裁决 / 项目经验下沉 / 过期状态清理 / 跨轨归位）整合归档。硬边界：只走 memory 工具（`replace`/`archive`/`add`，禁直改 `.md`、禁 `remove`，保证可逆）、daily 日志与待办不参与合并、key 轨新增仍走用户确认队列。附带零依赖只读预扫脚本 `scripts/scan_memory.mjs`（`§` 条目解析 + CJK 二元组 TF-IDF 相似度 + 覆盖线索 + 冲突极性聚簇），只做候选发现、不做裁决与写操作。

### 变更

- **收尾规则改为两步式：先记记忆、再输出完整回复（外部 PR #52）**：原规则要求把完整回复与 memory 工具调用放进同一条消息，但 DSH 中**带工具调用的消息结束不了 turn**，必然逼出一条多余的收尾消息；而 `transcriptView` 默认 `compact`（折叠已完成 turn 的过程、突出最终输出）高亮的是**最后一条**消息，于是高亮到的是那条无意义收尾而不是完整回复。现改为：① 本条消息只发写入工具调用（不写正文）→ ② 下一条消息输出完整回复（无工具调用，结束 turn）。完整回复因此成为最后一条、被 compact 正确高亮。注意 `snap.turnEndHead` 文案里不出现 dtodo 字样——该行不受 `todoEnabled` 控制，待办的收尾指导由受控的 `snap.todoHint` 单独承担。
- **内置技能同步升级为「整目录复制」（外部 PR #50）**：此前同步只复制 `SKILL.md`，现改为整目录（`scripts/` 等辅助文件随技能一起分发），版本门控与用户编辑保护语义不变（目标 `x-version` 不低于内置时不覆盖）。**行为变更**：版本升级时目标目录会被先清空再复制，用户自加在内置技能目录里的文件会被删除。

---

## 2026-09-09

### 修复

- **「Memory Evolve 设置」里勾选「记忆写入看门狗」保存后刷新即失效**：`MemoryQueueView.saveConfig()` 手工拼了一个固定 patch 对象发给宿主，键列表是**手写**的——`perTurnWriteGuard`（看门狗开关）与 `writeGuardThreshold`（阈值）有控件、`draft` 绑定也在（勾选立即变化），却没进 patch，于是 POST body 里根本没有这两个键，宿主 `updateRuntime()` 收不到、`plugin-state.json` 不落盘，刷新后 GET 回显仍是默认 `false`；因为界面读的是本地 draft，保存瞬间还显示「配置已保存」，问题只在刷新后才暴露。修复：把两个键补进保存 payload（TS 源码 + 构建产物 `lib/client.js` 同步重建），并新增回归测试 `tests/client-config-save.test.js` 钉住「面板 draft 绑定键 ⊆ saveConfig 发送键」这条契约（同时断言源码与产物键集合一致，防「改了源码没重建」），已验证还原修复后该测试必失败。

---

## 2026-09-08

### 修复

- **记忆 Tab 子导航被 DSH 宽度手柄遮挡、部分元素无法点击（issue #40）**：DSH 0.1.2-rc 起会话列两侧渲染「拉宽」用的宽度手柄（absolute 全高、z-index 8、拦截点击的 col-resize 竖条，元素带 `data-width-handle`，宽度 `min(40px, (100% - --dsh-chat-content-width)/2 - 48px)`）。插件的管理 Tab 是**占满整列宽**的面板（不随 `--dsh-chat-content-width` 收窄），把对话框拉宽后手柄条正好压住顶部子导航行（指南 / 全局规则 AGENTS.md …），元素被遮挡、点击被手柄拦截。修复思路与 DSH 官方对全宽 overlay 视图的先例一致（官方在 `ConversationRoot.module.css` 用 `.root:has([data-conversation-composer-overlay]) .widthHandle{display:none}` 关掉手柄），插件侧新增 `[data-phase]:has(...) [data-width-handle] { display: none }`，**一次覆盖全部 11 个 Tab 的根容器**（`.mt-panel` 记忆/技能/待办/设置/模型/同步、`.me-panel` UI 设置/版本/指南、`.coi-root` COI、`.bb-pane` 广播、`.pm-root` 提示词、`.bm-panel` 书签）——任一插件 Tab 挂载期间隐藏手柄，切回会话等视图自动恢复；拉宽偏好（`--dsh-chat-user-width`）本身不受影响，回会话 Tab 仍可拖拽。选择器用 `[data-phase]` 属性而非 CSS-module 哈希类名（`.root` 被哈希化选不中），该属性在 DSH 里非唯一但其它持有者不含上述根容器，不会误伤。
- **子代理快照不再注入 dtodo 收尾提示（issue #43）**：`snap.todoHint`（「收尾时调用 dtodo list 检查到期……有到期未完成项就在回复末尾提醒用户」）是**面向真人会话**的职责——子代理不向用户直接交付（结果回父会话），也不该替父会话提醒待办，注入只会诱导它多调一次 dtodo 白烧 token。同一函数内 review 计数、写入看门狗、收尾标题、写入文案早已按 `isSubagent` 降级，唯独此处漏了豁免。补齐后子代理快照不含任何 dtodo 收尾指导（头部工具清单的事实陈述保留：dtodo 工具对子代理确实注册可用）。新增回归测试，已验证「还原修复后测试必失败」。
- **review 每回合报「turn-stopping 处理失败：Cannot read properties of undefined (reading 'length')」（issue #42）**：DSH 0.1.2-alpha.4+ 的 Session 不再暴露 `.events` 数组，旧代码读取得到 `undefined` 后取 `.length` 抛 TypeError，经 `turn-stopping` 的 serial dispatch 冒泡，被插件的 try/catch 隔离成一条不影响回合的告警。改用 `agent.session.ownEvents?.() ?? agent.session.events ?? []` 三档兜底（老宿主回退 `.events`）。该修复此前只存在于开发轨，**本版本首次随发布交付**——只更新到上一个发布 tag（v26082401）的用户仍会看到这条报错。
- **headless profile 无法加载：依赖仅 web 运行时提供的 workspaceRegistry 服务（issue #35）**：该服务从硬性 `inject` 列表移除，改为 `ctx.get` 按需读取 + 局部注入，headless profile 不再因缺服务加载失败。
- **会话书签星标在 DSH 0.1.1-rc.2+ 全站失效（issue #39）**：官方重构了 `data-chat-anchor-key`（`node:{seq}` → `{kind.length}:{kind}{id}`，key 不再携带 seq），星标注入/列表/跳转/分支全链路失效。改为按锚点原文通用切分 kind/id（不硬编码 kind 名）+ 会话事件日志反查 `{seq, turn}`，旧记录按 seq 回退兼容；顺带修复 fork seed 的 seq 空洞越界（seq≠数组下标导致中间轮分支退化为全量复制）。
- **全盘 dir 搜索卡死（外部 PR #32）**：WALK_IGNORE 补 Windows 系统目录、maxFiles 截断后清空 pending 队列（防数千微任务级联）、defaultRoots 盘符去重。
- **Windows 下技能采纳跨盘失败**：`memoryDir`（D:）与 `skillDir`（C:）跨盘时 `renameSync` 抛 EXDEV，降级为 `cpSync + rmSync`，其余错误照抛。
- **移动端「Memory Evolve 设置」页长文本/控件溢出（issue #31）**：配置说明等无空格长串加 `overflow-wrap: anywhere`、控件加 `max-width: 100%` + `box-sizing: border-box`（不依赖移动通道，普通移动浏览器同样修复），并补上移动通道漏掉的 `.me-todo-select` 全宽规则。

### 新增

- **MEMORY.md / USER.md 页签支持手动新建记忆条目（issue #30）**：此前各文件页签中只有项目关键记忆 KEY.md 有手动添加框，用户最想随手记的长期记忆（MEMORY.md）与用户档案（USER.md）是纯只读——想让 AI 记住某条偏好/环境只能靠反复口头交代或等自动沉淀。新增 `POST /memory-evolve/api/memory/memory` 与 `/memory-evolve/api/memory/user` 端点（与 KEY 同款 `store.add` 盖戳追加，日期前缀由程序生成），前端 MEMORY.md / USER.md 页签顶部渲染同款添加框，草稿按文件分桶（切页签不丢内容），保存后清空草稿、刷新列表并提示。

> 本版本还包含 **2026-09-04** 记录的「记忆写入看门狗」与「广播投递即唤醒（wake 参数）」两项新增（见下）。

---

## 2026-09-04

### 新增

- **记忆写入看门狗（长会话防遗忘，吸收 PR #37 特性一）**：长会话中模型对「每轮收尾写 daily/project」的固定提示词逐渐失效（指令稀释），连续多轮不写记忆且程序侧毫无反馈，遗漏被静默吞掉。新增程序侧合规追踪：按会话统计「连续完成多少个用户回合未写任何 daily/project 记忆」（`writeGapCounter`，`agent/turn-stopping` 计数、subagent 不计、进程内存态），缺口达到阈值（`writeGuardThreshold`，默认 2，可在「Memory Evolve 设置 → 配置」调整）时快照注入置顶 ⚠️ 提醒，粘性直到下一次成功写入即消（key 轨确认队列不算——看门狗只盯每轮进展日志）。提醒文案刻意静态（不嵌实时计数）+ 按实际启用的写入轨参数化（单轨关闭不命令写已关轨）。**独立开关 `perTurnWriteGuard`，默认关**（用户拍板 2026-09-04：根源是模型指令遵循能力，强遵循模型不需要；打开才启用）。
- **广播投递即唤醒（de_broadcast send wake 参数，吸收 PR #37 特性二）**：研究「为什么广播有时能唤醒会话、有时不能」——根因在 DSH 核心的投递原语：广播投递一律用 `inject`（不唤醒），接收方 **running 时同回合可见（像被唤醒）**、**idle 时消息停在收件箱直到下次自然驱动（没动静）**、**offline 直接跳过**——三种状态三种观感。新增 `wake: true`（send 可选参数，默认 false 行为不变）：idle 接收方改走 `followup` 唤醒（投递到下一回合并启动驱动，等价替用户发消息，与 de_session wake / COI wakeOnComplete 同款机制；消息体带「发送方唤醒了你」标记）；running 接收方仍 inject（不打断）；offline 跳过（收件箱 + 回来补投兜底）。回执**始终**附「已唤醒 N 个空闲接收方」计数（含 0）。投递按接收方独立容错 + Set 去重（房间/项目/显式接收者重叠不重复投递、单点失败不中断）。经 Codex 独立评审与本地 DSH 0.1.2 源码实锚验证（Agent.followup/status/wakeDriver 语义成立）后合入。

---

## 2026-08-17

### 修复

- **Code Mode 启用提示词管理器后整轮失败（issue #13）**：`de_prompts` 工具参数说明不再携带宿主可解析的双花括号语法——工具 Schema 被序列化进 `tools:sdk` 系统提示词段后，说明文字中的 date/time 模板示例会被误当作未注册的 prompt variable，触发 `unknown prompt variable "{{date}}"` 并阻断后续所有回合。说明改为单花括号写法（功能不变：用户提示词正文中的 `{{date}}`/`{{time}}` 展开不受影响）。同批清理 `de_session` 工具描述中的同类残留（`{{model}}` 示例改为纯文字）。新增回归测试确保模型可见的工具 Schema 不再泄漏该语法。

---

## 2026-08-14

### 修复

- **版本更新后「当前版本」显示旧版本号**：更新成功的设备重启后，版本页出现「当前版本」仍为旧版、状态却显示「已是最新」的冲突。根因是更新事务的 fetch 使用 `--no-tags`（新 tag 只进私有引用、不落本地 refs/tags），而本地版本标识依赖 `git describe` 只能找到最近可达的旧祖先 tag。现已改为按 commit SHA 判定：HEAD 精确匹配任一发布 commit 时直接取该 commit 的发布 tag（开发轨已包含发布版本时显示最新 tag），不再信任 describe 结果；更新事务检查点同步落盘新版本号与「已是最新」状态。
- **更新成功后远端复核失败会误留更新红点**：checkout 成功后的远端重检失败不再把状态回退为 outdated（本地版本关系已由 SHA 核验确定，重检失败只记录错误信息）。
- **缓存期内手动切换版本/恢复开发轨状态陈旧**：24h 检测缓存命中时增加本地 HEAD 校验，本地提交变化立即失效重检，不再出现最长 24 小时的状态错报或假「等待重启」提示。
- **旧缓存版本号自动自愈**：已带错误版本号缓存的设备，升级后打开版本页立即显示正确版本，无需等待自动重检。

---

## 2026-08-13

### 新增

- **无限画板**：把散落各处的文件/文本/图片/音视频集中到一块无限画布上陈列的素材工作台。本地路径引用（文件留原地）、单板+视角筛选（会话/项目/全局 + 归属徽标）、无限平移缩放（LOD/虚拟化/GPU 合成性能底座）、三种上板入口（路径/便签/真实本地搜索）、画板内直接预览/复制/引用、卡片自由拖拽与右下角缩放、AI 双向（`de_canvas` 工具：按 id 查/读、往画板中央区放便签，不注入上下文）、整板 rev 乐观锁防多会话覆盖。独立子模块 `canvasEnabled` 开关，存储 `<memoryDir>/canvas/boards.json`。
- **web 站内通知**：`de_notify` / `de_channel_send` 新增 `web` 渠道——通知直达网页右上角铃铛，支持未读徽标、弹窗列表、全文查看、附件缩略图、一键跳转对应会话。
- **COI 任务列表分页**：GUI 任务子 Tab 分页浏览，任务记录多时不再一次性全部渲染。

### 变更

- **临时信息（scratch）模块移除**：画板内便签（markdown/纯文本节点，内容存画板内）已覆盖其能力，删除「临时信息」Tab、`scratchEnabled` 开关与 `/api/scratch` 路由；已有 scratch.md 内容保留在记忆目录，未自动迁移。

### 改进

- **通知机制重构——快照不再被其他模块反复拉动重注入**：COI 任务（已发起/完成）、工作区公告板（并行开始/结束/成员变化）、会话广播（新消息/房间动态）全部从上下文快照移出，改为**独立消息投递**（不打断正在进行的回合）；快照只保留身份、记忆与纪律等稳定内容。各模块变化不再连带整段快照重复注入，上下文更干净。
- **COI 完成通知只给状态与日志路径**：任务完成/启动消息不再附带日志截取摘要（长日志时截取落在正文中段、看不出结论），直接给出完整日志文件路径，AI 用 read 读取全量输出；`de_coi_status` 只查状态/取路径。
- **工作区公告板防抖**：只在真实状态变化时通知（并行开始/结束、成员变化、备注变化），会话正常运行期间不再反复刷新。
- **记忆同步改为纯 GUI 操作**：移除 `/memory_sync` 命令与快照同步状态行——同步完全由你在「记忆同步」Tab 手动触发，AI 不再参与同步执行。
- **版本检测启动即触发**：插件启动后后台自动检测一次新版本，设置 Tab 红点不再依赖手动打开版本页。
- **通知铃铛全面打磨**：SVG 图标、位置避让、移动端适配；弹窗优化（标题颜色 / 会话名称显示 / 长文大弹窗）；列表分行布局 + 已读按钮 + 标题跳转；邮件式去重、空行折叠、拖拽吸附、配色统一。
- **兼容 DSH 0812 内测版**：适配核心服务名改名（workspace→workspaceRegistry、httpServer→webServer），对外行为不变。

### 修复

- **记忆归档安全**：归档改为「先写入归档文件、成功后再删除主轨」——归档写入失败时主记忆原样保留，不再丢数据。
- **待确认建议序号对齐**：建议队列按热度排序后采纳/拒绝仍按原始序号处理，不再误操作其他条目（误采纳/误拒绝）。
- **记忆同步可靠性**：冲突解决可安全重试（git 失败不再残留半完成状态、不重复写入条目）；远端身份校验更严格（远端分支存在但身份文件缺失/损坏时拒绝合并）。
- **会话切换不再串台**：记忆 Tab 的文件列表与页签选择按会话隔离，切换会话后不再显示上一个会话的内容。
- **待办逾期判定**：改用本地日期（东八区晚上「今天」的截止不再被误标为逾期）。
- **共享记忆库地址回显**：不再误显示主代码仓库地址（避免把共享库配置改成代码仓）。
- **模型设置入口**：关闭「支持思考」后仍可重新打开编辑器（不再无路可回）。
- **手机端工具栏**：加号/模型按钮不再因增强未就绪而永久消失。
- **COI 任务恢复**：重启后不再残留「会话忙」假锁；长任务输出扫描缓冲设上限，不再无限吃内存。
- **会话评审**：总闸关闭后停止后台每秒轮询（重开自动恢复）；重置评审员时旧评审结果不再写入已清空的新会话。
- **工具描述与实际行为对齐**：工作区锁的保留时长描述修正（30 秒 TTL）、提示词与广播参数说明修正（重复键不再覆盖语义）。
- **通知详情截断**：点开通知总是拉取全文，修复 200~8KB 中长通知显示不全。
- **会话评审开关体系**：`advisorEnabled` 改为模块总闸（设置 Tab 关闭即整体停用）；修复会话级开关刷新页面后丢失；各会话默认关闭（opt-in），总闸开启后需在悬浮面板手动启用。

---

## 2026-08-12

### 新增

- **会话评审（Advisor）模块**：每个会话挂独立评审员，实时观察用户输入与回复，按 info / nit / concern / blocker 四级给出反馈；支持五层约束（系统提示词 / 全局 / 项目 / 会话 / 评审会话）；管理面板含约束 / 实时 / 记录 / 设置四个 Tab，可指令问答、查看评审员上下文规模、一键恢复默认提示词。
- **版本检测与更新**：自动检测远端新版本（git tag），设置 Tab 新增版本页（当前版本 / 最新版本 / 更新按钮 + 红点提醒）。
- **任务完成自动唤醒**：`de_coi_dispatch` 新增 `wakeOnComplete` 参数——任务完成后自动唤醒派单会话投递完成摘要，无需用户手动触发。

### 改进

- **完成唤醒无次数限制**：用户显式要求的唤醒每次都生效，与 `de_session wake` 同语义。
- **COI 输出可追溯**：`de_coi_status` / `de_coi_wait` 输出开头直接给出完整日志文件路径，无需自行搜索。

### 修复

- **提示词注入快照不再被宿主渲染器拦截**：注入正文含 `{{date}}`/`{{time}}` 等变量时，快照段渲染侧统一展开；正文里残留的任意 `{{...}}`（未知变量、malformed 引用）也一并去模板化——宿主 system-prompt 渲染器把段文本 `{{...}}` 当模板变量解析、未注册即报 unknown prompt variable 导致整轮注入失败的问题（issue #6）彻底兜底，旧版本遗留/手动编辑的注入数据同样安全。
- **会话评审四项细节**：实时流清空、悬浮窗默认隐藏、tool-call 按序显示、中文指南文案补齐。

---

## 2026-08-11

### 新增

- **记忆同步（跨设备项目记忆共享）**：项目记忆一键同步到远端，多台电脑共享同一份记忆；三层启用开关（模块 / 项目 / 轨），逐项目 opt-in 默认关闭；条目身份证机制保证双设备合并对齐；GUI「记忆同步」Tab（状态卡片 / 初始化 / 同步 / 冲突逐条解决）。
- **共享记忆仓库**：一个私有仓库装所有项目的记忆，每个项目自动使用专属分支，互不干扰；老仓库自动识别、零迁移。
- **统一单一模式**：记忆远端模型合并——默认复用主代码仓库、也可指定共享记忆仓库，每项目一条专属分支；项目待办（TODOS.md）并入项目记忆轨同步。
- **全局记忆轨**：全局记忆 / 用户档案 / 每日日志 / 待办四轨可跨设备同步（仅共享记忆仓库可用），每轨一条独立分支。
- **图片链路五大能力**：输入框图片直发 IM 渠道（`sessionImage` / `attachmentId` 来源）；COI 派单带图（codex / kimi / grok / hermes）；`de_session` 支持 Agent 预设；`de_models` 展示模型图片输入能力；会话广播图片附件（收件箱缩略图 + 延迟保留转发窗口）。

### 改进

- **记忆同步 Tab 全面重排**：三子 Tab 化（项目 / 全局 / 记忆远端）、统一推拉按钮、设备级启用开关、状态文案「未提交」改「未推送」+ ahead 统计。
- **兼容 DSH 260810 快照**：`dsh.client` 配置迁移、Agent 预设挂载，新会话工具面完整。

### 修复

- **Windows 换行事故**：Windows Git autocrlf 将记忆文件转为 CRLF 导致解析失败——新增 `.gitattributes` 强制 LF + 存量文件无损自愈，双设备同步恢复。
- **全局轨数据安全加固**：修复凭证泄漏、跨轨冲突数据风险、非法路径上传、假 dirty 重复提交等问题；全局推送被冲突拦截后可直接在界面逐条解决。
- **spawn / wake 工具面缺失**：修复 DSH 260810 下新会话与恢复会话缺少 bash / read / write / edit 的问题。

---

## 2026-08-10

### 新增

- **memory 工具多轨批量写**：一次调用同时写每日日志 + 项目日志，收尾合并为一次工具往返。
- **情绪反馈记录**：日志条目可携带用户情绪反馈（正面 / 负面 + 原话摘录），积累后可按任务分类分析满意度。

### 改进

- **大文件保护**：project / daily 无参数查询默认返回最近 50 条并附元数据，记忆 Tab 分页展示，消除长文件截断。

### 修复

- **旧插件迁移引导**：dsh-skills-manager 残留会导致 Web 整页不可用——补充醒目迁移文档与禁用列表自动迁移。

---

## 2026-08-09

### 新增

- **工作区冲突协调**：多会话并行时声明文件 / 服务占用（`de_ws_declare` / `de_ws_status` / `de_ws_release`），写前冲突检测、占用方定向通知、活动感知快照段。
- **会话书签**：每一轮可星标命名，独立列表一键跳回；从任意已完成轮创建官方分支。
- **本地文件搜索内容检索**：`memory_evolve_search_local_files` 支持文件内容关键词检索（可选参数，默认行为不变）；新增四档模式（文件名+内容 / 仅文件名 / 仅内容 / 关闭）。
- **DSH UI 设置模块**：左侧会话列表默认只显示进行中的会话；对话区加宽（约 95%）；消息气泡加宽（约 80%）。
- **立即注入**：提示词可「当前回合立即生效」注入（快照变更 + 插话），只注入一次，不受次数 / 间隔影响。
- **会话编排模块（de_session）**：spawn 程序化创建标准会话、wake 唤醒、status / list 查询；`me` 查自身信息；`rename` 改会话名称 / 别名；新会话自动挂工作区分组。
- **会话广播收件箱**：未读 / 全部 / 已读筛选 + 搜索 + 分页；房间成员在线状态持久化（重启不丢失）。

### 修复

- **内容检索漏搜**：修复全盘上万文档时目标文件扫不到的问题。
- **工作区协调实测迭代**：活动段重复注入刷屏、会话删除后锁残留、显示完整会话 ID 等。

---

## 2026-08-08

### 新增

- **de_prompts 创建 / 修改**：模型可自行创建 / 修改提示词，与 GUI 同一套校验。
- **de_prompts 多维过滤**：按名称 / 分类 / 标签 / 简介过滤，未命中时明确提示是哪个条件没匹配。
- **提示词简介与启用状态**：每条提示词可填简介、可禁用；de_prompts 工具（列表 / 详情 / 注入）上线，AI 可选择合适提示词注入当前会话或作为子任务提示词。
- **memory 工具归档**：AI 可直接归档记忆条目（memory / user / key 三轨）并查询归档内容，可逆。
- **提示词管理器交互升级**：一键预设注入（注入一次 / 持续注入 / 自定义）；临时注入（不建提示词直接注入）；次数 / 间隔自由输入。
- **会话广播房间 / 项目群**：多会话聊天室（成员跨工作目录）+ 项目公告群（按目录可见）；30 天无活动自动清理；房间 / 项目消息保留 30 天供回看。
- **会话广播管理面板**：消息收件箱、房间管理、成员在线状态；踢人 / 解散自动发送系统通知；解散软删除可追溯。
- **会话别名**：给会话起友好名称（≤10 字），快照 / 面板 / 消息显示别名优先。
- **会话搜索（de_session_search）**：搜索本机 Codex 历史会话（按项目 / 关键词，只读扫描、零常驻状态）。
- **会话页 Tab 体系重构**：记忆 / 技能 / 待办 / Memory Evolve 设置四个独立 Tab，每个 Tab 带中英双语指南。
- **会话广播独立模块**：从 COI 调度拆出独立开关与存储目录，互不影响。

### 修复

- **注入文案去歧义**：注入结果按实际行为显示（只注入一次 / 共 N 次 / 持续注入），不再误读。
- **幽灵分类可管理**：分类树中残留的旧分类可正常改名 / 删除（提示词自动迁移）。

---

## 2026-08-07

### 新增

- **提示词管理器**：提示词库 CRUD + 分类树 + 标签 + 搜索 + 使用统计；注入执行器（次数 × 间隔，支持无限 / 一次性 / 有限次）；内置 13 个来自 GitHub 真实提示词库的完整范式。
- **COI 调度模块**：统一调度 kimi / codex / grok / hermes 等外部 CLI——非阻塞后台任务、进度可视化、会话分层管理与恢复、跨 COI 接力、任务模板、用量统计、崩溃恢复；支持自定义 CLI 适配器。
- **临时信息便签**：会话页独立 Tab，持久化 Markdown 便签（跨重启保留）。
- **本地文件搜索**：`memory_evolve_search_local_files` 按文件名搜索本机文档（默认只搜文档类型，全类型需显式开启）。
- **每日待办可查过往**：`dtodo list` 支持 past / expired 查询历史；待办子 Tab 新增「过往」页签（含过期遗留）。
- **记忆条目编辑**：五轨记忆美观视图直接编辑保存（程序标记与分隔符受保护）。
- **建议队列分类**：记忆 / 待办 / 技能建议三个独立待确认 Tab；采纳时可改目标轨（记忆三轨之间）。

### 改进

- **适配 DSH 08-06 profiles 架构**：客户端注册改用 `ctx.slots.inject`，快照提示分区更清晰。

---

## 2026-08-06

### 新增

- **技能管理并入**：独立插件 dsh-skill-browser 整体合并——技能浏览 / 搜索 / 筛选 / 一键禁用启用 / 自定义目录；旧插件禁用列表自动迁移。
- **四轨待办**：生活 / 工作 / 项目 / 每日；四象限 + 截止 + 状态 tag；`dtodo` 工具（add / list / done / update / remove）与默认智能视图。
- **key 轨确认制**：模型写入项目关键记忆先进待确认队列，用户采纳后才写入并注入。
- **项目关键记忆归档**：key 条目可归档至 KEY-archive.md，可逆（可移回主记忆）。
- **git 分支感知**：记忆按分支注入与查询，日志自动带来源分支标记。

---

## 2026-08-05

### 新增

- **初版发布**：分层记忆与自我进化插件——全局事实 / 用户档案 / 项目记忆 / 每日日志四轨记忆。
- **记忆审查机制**：后台审查 + 建议队列（采纳 / 归档 / 拒绝，支持批量）。
- **Web 界面**：设置面板「记忆管理」、会话页记忆 Tab（文件内联视图）。
- **技能自我进化**：`skill_manage` 工具（严格创建门槛 + 待确认队列）。
