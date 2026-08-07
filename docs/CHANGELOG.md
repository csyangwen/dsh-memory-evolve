# 更新日志（Changelog）

本仓库所有版本变更记录，按时间倒序。版本号规则：功能里程碑记为大节，迭代修复归入小节。

---

## 2026-08-07 — COI 调度模块 + 临时信息便签（de_coi）

### 🎯 临时信息便签（scratch）
- 会话页第三个独立 Tab「临时信息」：持久化 Markdown 便签（`<memoryDir>/scratch.md`，512 KiB 上限，原子写），跨 DSH web 重启保留；**与 § 分隔的结构化记忆无关**，自由文本随意编辑不破坏解析
- 等宽编辑区 + 显式保存（Ctrl/Cmd+S，编辑区聚焦时拦截）+ 未保存脏标记 + 上次保存时间 + 一键用系统工具打开（复用 reveal 通道，`scratchFile` target）
- 宿主端 `GET/POST /memory-evolve/api/scratch` 路由（读不存在返回空、POST 整体覆盖写入，body 上限放宽到文档上限）
- Tab 名定稿：**「CLI调度」**（zh）/ **「CLI Dispatch」**（en）——弃用晦涩的「COI 调度」「COI Hub」，UI 与文档引用同步更新

### 🔧 快照审查提示优化（无需每轮 check）
- `memory_review_status` 描述改为：**无需每轮调用**——到期提醒由程序在快照中动态注入（「记忆审查已到期」出现时才执行审查），complete 复位计数，漏做下轮继续提醒；check 仅手动确认进度时使用
- 快照固定提示段删除每轮 `action=check` 步骤，只保留收尾纪律与 complete 行为（省每轮一次工具调用、保缓存）

### 🎯 COI 调度（统一调度 kimi/codex/grok/hermes 等 CLI 代理）
- **适配器驱动架构**（`lib/coi/` 独立模块，边界清晰可拆）：内置 kimi/codex/grok/hermes 四家开箱即用（命令模板/会话恢复参数/session id 提取/结构化输出解析/**内置使用指南**），UI 可**自定义添加任意 CLI**（`ai-cli` 有会话恢复 / `plain-cli` 普通命令降级，两级配置：常用表单 + 高级规则），适配器**测试按钮**一键 ping 验证
- **非阻塞调度**（第一原则）：`de_coi_dispatch` 工具 / `/de_coi run` / Web 面板三入口**立即返回 taskId**，任务经 `node:child_process` 后台化，**绝不卡死 DSH 主进程**；终止杀**进程树**（detached 进程组）、超时兜底（默认 12 小时）、输出体积截断留档
- **进度可视化**：Web「COI 调度」Tab 实时日志流（2s 轮询）、任务列表 3s 轮询、状态机 queued/running/completed/failed/killed/interrupted；`de_coi_wait` 可同步等待结果（Agent 侧完成回传）
- **终止确认**：GUI confirm 弹窗 / `/de_coi stop <id>` 二次确认（`--force`）/ `--all --force`；Agent 工具取消直接执行不弹窗
- **会话分层管理**：session id 自动捕获（kimi 尾部正则 / codex stderr 头部）→ 按 **临时/会话/项目/全局** 分层入库，项目级可挂 **git 分支**（与 key 记忆同构），备注/检索/一键恢复（各家恢复参数自动拼接）/`/de_coi sessions` 管理
- **会话并发锁**：同一会话同时只能跑一个任务（恢复时检测占用，防上下文串扰）
- **跨 COI 接力**：发起任务可 `refTaskId` 引用上一任务留档输出自动拼接（如 codex 写 → kimi review）
- **任务留档与检索**：输出自动落盘（`coi/logs/`），按 COI/项目/时间/关键词检索，自动清理（默认 90 天）
- **任务跨会话可见**：数据按项目目录归类，任何 DSH 会话可见该项目 COI 任务
- **任务模板**：内置 4 个（review 代码/修复测试/总结日志/架构分析）+ 自定义，一键发起
- **用量统计**：各 COI 调用次数/累计耗时/状态分布（GUI 统计页 + `/de_coi stats`）
- **会话导出**：封装 kimi export / grok export / hermes sessions export 后台导出
- **完成通知**：`coiNotifyCommand` 命令模板（占位符 `{taskId}{coi}{status}{summary}`，可配 `hermes send` 推微信/飞书），失败静默不影响任务
- **崩溃恢复**：任务状态全程持久化，DSH 重启后遗留 running/queued 标记 interrupted，可基于会话恢复
- **记忆融合（弱耦合）**：任务完成自动把摘要沉淀到 project/daily 记忆轨（模块内部直连 `store.add`，停用记忆轨不影响调度）
- **配置项**：`coiEnabled` / `coiDataDir` / `coiSummaryEnabled` / `coiNotifyCommand` / `coiRetentionDays` / `coiTaskTimeoutMs` / `coiMaxLogBytes`
- 命令前缀 `de_`（D=DeepSeek，E=edgar）防插件冲突；Web 新 Tab「CLI调度」（探测 host API 存在才注册）；使用指南新增 COI 线；README 同步（含新 docs/COI-调度.md 使用文档，AGENTS.md 加 de_coi_dispatch 提示）

---

## 2026-08-07 — slots API 适配与快照提示优化（`68d05de`/`cfcfd63`）

- **适配 DSH 08-06 profiles 架构**（`68d05de`）：上游移除 `ui-slots.deferRegistration`，客户端改用 `ctx.slots.inject` 注册记忆 Tab，badge 刷新改为重新注册（deferral.refresh）后恢复 tab 选择；配套 dsh-plugin / dsh-web-plugin 技能按新架构更新（config.yaml → cordis.patch.yml、`--dump-config` 排查）
- **快照提示词优化**（`cfcfd63`）：分区标题更清晰（「长期记忆（所有项目、会话都必须遵循）」「本项目关键记忆（memory 工具 target=key）」「记忆 memory-evolve（包含 memory 工具、dtodo 待办工具、skill_manage 技能工具）」），删除「✅ memory-evolve 本轮执行完毕」收尾语（快照只保留纪律，不再自指）

---

## 2026-08-07 — 本地文件搜索（`a4cdb3b`/`1bb4909`/`5af8c10`）

### 🎯 本地文件搜索工具（memory_evolve_search_local_files）
- 新工具 `memory_evolve_search_local_files`（slash 命令 `/memory_evolve_search_files`，前缀保留防撞名）：在本机按**文件名**搜索文件/文件夹，**只返回路径、不读内容**（文档查找主用途）
- **provider 可替换链**：`mdfind` → `rg --no-messages`（外置卷权限错误会让 rg exit 2）→ Node walk+缓存——换实现不动工具契约（`registerSearchProvider` + `searchDocsProviders` 配置顺序）
- **默认只搜文档**：不传 `exts` 时默认仅常见文档扩展名（md 等），**绝不静默全盘枚举**；全类型搜索（图片/视频/任意扩展名）必须显式 `allTypes=true`（或 `exts=["*"]`），副作用在描述中说明
- **type 参数**：`file`（默认）/ `dir`（文件夹名，mdfind 走 kMDItemContentType==public.folder）/ `all`；rg/es 无法枚举文件夹时明确报错并回退 walk（walk 收集目录，kind=dir/any）
- **默认禁用 + 动态注册/注销**：`tools.register` 返回 disposer，禁用即注销、模型不可见；运行时开关在配置面板；默认搜索根含外置卷 `/Volumes`
- 配置项：`searchDocsEnabled` / `searchDocsToolName` / `searchDocsCommandName` / `searchDocsExts` / `searchDocsProviders` / `searchDocsCacheTtlMs` / `searchDocsTimeoutMs`；walk 缓存按 root TTL + 后台重建 + 并发去重

### 🔧 修复与配套
- **搜索不再冻结 DSH 主进程**（`1bb4909`）：mdfind 结果靠 JS 过滤导致空结果触发回退链（rg 全盘扫 7 个卷 + walk 全量重建），walk 同步 `JSON.stringify` + `writeFileSync` 数十万条缓存 + 48 路并发 readdir 卡死事件循环——改为有预算上限、异步重建等
- 修复 `allTypes` 把所有结果滤空、`type=dir` 泄漏默认 md 扩展名的问题（`5af8c10`）
- **dtodo 工具描述场景化**：`past=true` 不带 `expired` 时输出提示（含空结果时），说明每日待办当天截止即过期（`a4cdb3b`）
- **快照 dtodo 节精简**：只留每轮纪律（收尾检查到期、提醒、不主动展开），用法细节一律指向工具 description（function calling 自解释、省每轮 token、保缓存）（`a4cdb3b`）
- memory 工具 list 描述补充默认顺序与空结果指引（`a4cdb3b`）

---

## 2026-08-07 — 每日待办可查过往 + 记忆条目编辑 + 建议队列分类（`342869d`/`4f2b435`/`39f55c8`）

### 🎯 每日待办可查过往（`342869d`）
- **dtodo `list` 新增 `past=true`**：同时查询每日待办的**过往**（今天之前的 `daily/YYYY-MM-DD.todo.md` 文件，条目带日期标记、统一排在列表最后）；`expired=true` 时包含**已过期的遗留**（未完成且无未来截止），缺省只显示未过期的过往条目——过往**默认不出现**，不增加模型信息负担
- **dtodo `list` 新增 `cwd=路径` 跨项目查询**：在别的会话里查指定项目的 `target=project` 待办（project 轨按该路径定位，缺省=当前会话目录）——工具层能力，前端 UI 不提供
- **过往条目按 id 可操作**：`done` / `update` / `remove` 能定位到今天之前的 daily 文件并**写回对应日期**（不再只认今天的文件）
- **待办子 Tab**：「每日」页签改名**「今日」**，新增**「过往」**页签（只显示今天之前的每日待办，按日期分组）；筛选区新增**「显示已过期」**开关（默认关闭——过往遗留默认隐藏，勾选后全部显示）；**历史文件按需读取**：只有点开「过往」页签或勾选「显示已过期」时才请求 `past`，其余视图不读任何历史文件（两年约 700 个文件也只在此刻一次性顺序读，无需缓存/并行等后端加速）；过往视图不提供快速添加（只查历史）
- 快照固定提示行补充：查每日过往待办用 `dtodo list past=true`，要含已过期的遗留再加 `expired=true`

### 🎯 美观视图条目编辑 + 注入轨确认（`4f2b435`）
- **记忆条目编辑保存**（长期记忆 / 用户档案 / 项目关键记忆 / 项目日志 / 今日日志五轨，美观视图每条卡片新增「编辑」）：**只能修改内容**——时间戳、git 分支、分支范围、daily 项目标签等程序标记由 `splitEntryHead` 剥离保留，不可改动；**分隔符 § 禁止输入**（前端输入即过滤 + 后端硬校验），编辑不可能破坏 § 分割格式；沿用 drift guard（文件被外部改坏自动备份拒绝）与注入扫描
- **注入轨保存确认**：长期记忆 / 用户档案 / 项目关键记忆保存时弹确认（"保存后会立即注入会话上下文"）；项目日志 / 今日日志不注入、无需确认
- 新增 `POST /api/memory/update`（按完整条目原文精确匹配，只替换正文）

### 🎯 建议队列：改分类 + 待办建议独立 tab（`4f2b435`/`39f55c8`）
- **目标徽标按轨着色**：长期记忆（蓝）/ 用户档案（绿）/ 项目关键记忆（橙）/ 待办·各轨（紫）+ 友好中文名
- **采纳时可改分类**：每条记忆建议带目标下拉（默认=AI 推荐轨，不选直接采纳行为不变），可改到**记忆三轨**（项目关键记忆 / 用户档案 / 长期记忆）之一——AI 分错类的记忆不再只能按原轨写入；改到「项目关键记忆」按建议来源会话的工作目录写入对应项目 KEY.md，无 cwd 时失败并**保留建议**
- **待办建议强制留在待办轨**：待办不能变成记忆（覆盖被忽略）；记忆建议只能在三轨之间改（API 校验同步收窄）
- **「待确认待办建议」独立 tab**：todo-* 建议不再混在「待确认记忆建议」里——记忆建议 / 待办建议 / 技能建议三个独立待确认 tab，各自徽标计数（`/api/badge` 拆分 `suggestions` 与 `todoSuggestions`），批量操作只作用于当前面板

---

## 2026-08-06 — 里程碑：技能管理并入 + 四轨待办（`56ae87d`）

> 本次大版本把独立插件 dsh-skill-browser（技能管理器）整体合并进来，并新增四轨待办系统，记忆 Tab 升级为「记忆技能待办」唯一管理入口。

### 🎯 技能管理器（合并自 dsh-skill-browser，`d5bbf7d`）
- 会话页记忆技能待办 Tab 新增「技能管理」子 Tab：按**来源层级**（user-* / custom / bundled / project-*）浏览全部技能，搜索 + 来源/状态筛选 + 分页，**一键禁用/启用**（runtime shadow，project 系统技能结构性不可禁用），自定义技能目录，目录树浏览与技能文件编辑
- **与独立插件冲突**：二者不可同时启用（双重 shadow / 重复 provider）——原插件已从 config.yaml 停用，其禁用列表在首次启动时**自动迁移**到 `skills-state.json`，API 前缀沿用 `/skills-manager`

### 🎯 四轨待办（dtodo）
- **四轨**：`life` 生活 / `work` 工作 / `project` **本项目**（按工作目录隔离）/ `daily` 每日（按天分文件）；§ 分隔 MD 存储，**文件头注释自描述 tag 语法**（任何编辑器/模型可直接读取）
- 条目 tag：创建时间（程序盖戳）· `[id]` 唯一标识 · `[q1]`~`[q4]` **四象限**（重要×紧急）· `[due]` 截止 · `[status]` 状态（done 自动盖 `[done]` 完成时间）· `[cat]` 分类
- `dtodo` 工具：`add`（**用户口述直写**，target 遵循用户类别词，缺省=本项目/工作）· `list`（**默认智能视图**：逾期 + 今日到期 + 本项目未完成 + 全局 Q1/Q2，最多 8 条，全量需显式参数）· `done` / `update` / `remove`（按 id 精确操作）
- **注入策略**：待办内容**永不注入**；快照只带一条固定提示行（收尾检查到期、有到期项在回复末尾提醒、不主动展开全部清单）——状态变化零尾部注入
- **确认制**：模型自建待办走 `memory_suggest target=todo-*` 进待确认队列（采纳/归档带「原轨」标记可转正），用户口述直写
- **待办子 Tab**：默认「全部」视图（四轨合并 + 轨徽标）、状态/四象限筛选、快速添加（全部视图可选目标轨）、行内编辑、完成/恢复/删除、逾期标红；页签下方使用说明小字
- 标签改名：记忆 → 记忆技能 → **记忆技能待办**

### 修复与细节
- todo 归属：**用户类别词优先**（"工作上的事"→ work），没说才用缺省 target（`56ae87d`）
- 待办「未完成」筛选包含 doing/blocked（此前只显示 pending）（`56ae87d`）
- 记忆 Tab 文件页签与功能页签互斥、跨重挂持久化（`31bbc58` 延续）

---

## 2026-08-06 — 里程碑：key 轨确认制 + git 分支感知（`31bbc58`）

> 本次大版本把「项目关键记忆（key）」提升到与全局轨同等待遇，并让整个记忆系统感知 git 分支。

### 🎯 项目关键记忆（key）确认制
- key 写入与 memory/user 同待遇：**模型写入先进待确认队列**（`memory add target=key` → 建议队列，去重累计），**用户采纳后才写入 KEY.md 并注入**（`31bbc58`）
- 记忆 Tab 手动添加 = 直写（用户即确认者，不受确认制约束）
- 修复：key 建议返回的 `queued` 字段超出工具输出 schema（`additionalProperties: false`）导致运行时拒绝——已剥离并加防回归测试

### 🎯 key 项目级归档（第三层冷存储）
- 新增 `projects/<cwd-hash>/KEY-archive.md`（随项目走、按 cwd 隔离）
- **双向移动**：key 主轨条目「归档」→ KEY-archive.md；归档页签「移回主记忆」转正 / 删除；分支标记 `[branch:…]` 在归档/转正中保留
- 记忆 Tab 新增「项目关键记忆归档」文件页签（9 个页签）

### 🎯 git 分支感知（详见 README「git 分支与记忆」）
- **当前分支识别**：程序实时 `git branch --show-current`（与 DSH TUI 同款）；非 git / 获取失败 / detached HEAD → 视为无分支，所有分支行为退化为"全部"（`b62d5b5` + `31bbc58`）
- **key 按分支范围注入**：条目 `[branch:main,dev]` 标记限定可见分支（无标记=全部）；注入只取「无标记 + 覆盖当前分支」；**当前分支名随 key 一起注入**（key 小节标题 + 提示行），模型明确知道自己所在分支
- **分支范围管理**：Tab 内每条 key 显示「分支: 全部 ▾」徽标（点击展开多选，全部与具体分支互斥、「全部」权重最大）；手动添加时可选择范围；LLM 可用 `branches=` 参数（缺省=全部，不存在分支仅警告）+ `memory list target=key branch=main` 查询
- **日志分支 tag**：项目日志/每日日志每条记录**自动带来源分支** `[git main]`（程序标注，手写前缀会被剥离），日志可溯源到分支
- 开关：`keyBranchFilter`（config.yaml）

### 🎯 记忆 Tab UI
- 功能面板与文件视图**互斥激活**（点文件页签自动退出功能面板）（`31bbc58`）
- tab 选择**跨重挂持久化**（badge 刷新会导致组件重挂，选择不再丢失）（`31bbc58`）
- 会话页标签小红点（🔴 记忆 (N)）**即时更新**（`dsh-memory-evolve:badge-change` 事件）（`31bbc58`）
- 项目日志标题去掉「（当前会话）」（`31bbc58`）
- 每条 key 条目可删除；「分支: 全部 ▾」徽标可编辑（`b62d5b5`）

---

## 2026-08-06 — 执行纪律与提示词极简（多 commit）

### 每回合执行时序
- **先文本后工具**：快照提示模型「最终回复消息中先输出完整回复文本、再在文本之后附带工具调用」（`7df2e0b`）
- 每回合收尾**最后一步**执行记忆写入与审查检查（`590afbb`、`1c85984`、`14c65ae`）
- 提示词三版极简：合并写入+审查为单一「回合收尾」清单、删除全部机制解释、写死每回合必查（`8df3db4`）
- 收尾确认文案：「✅ memory-evolve 本轮执行完毕」（`df95b79`）

### 程序自动标注（LLM 零负担）
- daily 日志自动标注项目标签 `[HH:MM] [项目]`（`8df3db4`）
- 手写日期/分支前缀一律程序剥离（`36e43e5`、`31bbc58`）
- 移除全部容量限制（`8df3db4`）

### 回合内自我审查
- 审查改由**主 LLM 在自己回合内执行**（子代理机制移除，信息零损耗）（`22b883a`）
- 到期**粘滞**（只增不清，complete 才复位）+ complete 前置防御（`df95b79`）
- **到期快照警告**：快照尾部出现「记忆审查已到期」醒目警告（`9b75daa`）；complete 后警告消失会触发一次额外上下文注入——**特性而非缺陷**（保证弱遵循模型可见性），已在文档说明
- 建议去重 + 命中次数（`2ca4c77`）

### memory 工具查询化
- `memory list` 支持 `filter` / `since` / `until`（daily 跨文件）/ `recent` / `limit` / `branch`；0 匹配与旧格式日期条目有提醒（`9b75daa`）

### 修复
- 空白文件被误判为读取失败导致无法写入（`910e654`）
- 到期消息残留旧段名引用、避免重复写入诱导（`df95b79`）
- WSL 下 reveal 打开失败 → `explorer.exe` + `wslpath` 回退（`8bead16`）

---

## 2026-08-05 — 初版与基础建设

### 核心机制
- **初版**：分层记忆与自我进化插件（纯插件、零核心修改、零运行时依赖）（`5fa55f2`）
- 四轨记忆：全局事实 MEMORY.md / 用户档案 USER.md / 项目记忆（按 cwd 隔离）/ 每日日志（按天分文件）
- 快照注入走 user-role 尾部消息（变更检测、缓存友好）；project/daily 保持按需读取（`3029747`）
- 移除早期只读记忆注入与全部用户可见的遗留痕迹（`9e280f5`、`8319edc`）

### 审查机制（早期）
- 子代理式后台审查：可追溯（digest 带 session id，可读完整会话）（`b40173d`）、增量（断点续审）（`486af6d`、`5bf03cb`）、宽松触发（`4edca58`）
- 建议队列：去重 + 命中次数、采纳前可编辑、`autoApproveGlobal`（`821e4bd`、`2ca4c77`）

### Web 界面
- **设置面板「记忆管理」**：建议审查（采纳/归档/拒绝/批量）、运行时配置、打开系统文件（`c83b3d4`、`821e4bd`、`e08a473`）
- **会话页记忆 Tab**：文件内联视图、project/daily 可编辑 → 后改为**全只读**（`07ae483`、`0888dcb`）
- WSL/全新安装的 reveal 失败修复（`f11f13f`、`8248151`）

### 技能自我进化
- `skill_manage` 工具：严格创建门槛（多次踩坑、难度大、后续复用）、待确认队列（默认关）（`dabaad2`）

### 文档
- README 截图（设置面板/记忆 Tab/审查子代理）（`4285be6`）
- docs/rules.md 功能规则文档（`f49eb48`）
- 模型主动读取 project/daily 的最佳实践（`814d2b1`）
- 缓存局限的诚实说明（`2a73ffd`）

---

## 未发布（工作区）

- 无（最新提交 hash 见顶部大节，提交后回填）。
