# 更新日志（Changelog）

本仓库所有版本变更记录，按时间倒序。版本号规则：功能里程碑记为大节，迭代修复归入小节。

---

## 2026-08-09 — 工作区冲突协调（ws-coord，会话广播模块子功能）：同工作区多会话并行的资源占用协调

### 需求（用户拍板）
同工作区多会话并行时对同一文件写入 / git 状态 / 服务产生冲突。用户拍板：①语义上属于"通知的一部分"，**归入会话广播模块**（模块已多，先归类不新开）；②默认关（大开关 broadcastEnabled + 子开关 wsCoordEnabled 均默认关）；③一期不做 git 互斥（让 AI 自己注意）与客户端面板；④**软模式**——先信任 AI，冲突只警告不拦截（enforceWrite 硬拦截保留为开关位）；⑤活动快照带当前日期时间。

### 调研
- `docs/工作区冲突协调-调研-20260809.md`：源码级验证——`fs/write-intent` 被核心 fs-policy **单槽独占**（插件不可用）；`tools/pre-execute` 是**官方留给插件的扩展点**（deny/allow/ask，核心无占用者）→ 冲突检测通道；`fs/observed` 是 emit 事件、actor=ToolExecution（可拿 agent.session.id）、targetKey=realpath → **自动登记通道**（写过的文件自动进占用集，不靠 AI 自觉）；`tools/post-execute` additionalContexts 可注入警告上下文（官方测试同款写法）。

### 实现
- **宿主端** `lib/coi/ws-coord.js`（独立装配子单元，防 08-08「广播挂 COI 拆不开」事故）：`WsCoordStore`（<broadcastDataDir>/ws-coord/locks.json 原子写、TTL/过期清理/路径归一化/按 cwd 工作区隔离）；三工具 `de_ws_declare`（声明文件/服务 + conflicts 重叠检测）/ `de_ws_status`（**无参=工作区活动概览**——谁在跑、在干什么）+ 路径/会话交集查询）/ `de_ws_release`；事件监听：`fs/observed` 自动登记（autoRegister 子开关）、`tools/pre-execute` 写前冲突检测（软模式放行+记录 / enforceWrite 硬模式 deny）、`tools/post-execute` 警告注入（additionalContexts，模型下一轮可见）、`agent/status` 会话元信息（cwd/status）、`agent/turn-stopping` 释放本回合 observed 锁；冲突时给占用方发**定向通知**（notifyConflict 子开关，走广播 store send）；**活动感知快照段**【工作区活动】（wsCoordSnapshot 子开关：活跃会话 ≥2 时注入一行、**带当前时间**、别名显示、0~1 会话零开销）。
- **装配**：`lib/index.js`——DEFAULTS（wsCoordEnabled 关 / EnforceWrite 关 / Snapshot 开 / AutoRegister 开 / NotifyConflict 开）、RUNTIME_KEYS + validateRuntimePatch 3 个运行时键、`wsCoordCtrl.sync()` 挂广播 sync 链（**依赖 broadcastEnabled 大开关**：广播关 = wsCoord 全不注册；广播卸载时先卸 wsCoord）；renderSnapshot 加活动快照段（wsCoordStoreRef 经参数传入，模块级函数不直接访问闭包）。
- **客户端**：设置 Tab 配置区加「工作区协调（广播子功能）」总开关（广播关时禁用）+ 展开后两个子开关（活动快照段 / 硬拦截模式）；zh/en 文案；`me-field-sub` 次级开关样式。
- **测试**：`tests/ws-coord.test.js` 12 个用例（存储 CRUD/TTL/冲突判定/路径归一化/活动概览/快照段/工具 schema 递归 walk/软硬模式事件链/子开关关闭跳过），全量 **288/288 全绿** + 构建成功。

### 验证
- npm test 288 全绿；npm run build 成功；工具 schema 过递归 walk（type 单一字符串、required 顶层数组、additionalProperties:false）。宿主端改动需重启 dsh web 生效。

---

## 2026-08-09 — 会话书签独立子模块（bookmarkEnabled）：每轮星标 + 列表跳转 + 任意轮官方分支

### 需求（用户拍板）
给对话的**每一轮打标签**（书签），独立列表一键跳回；**从任意轮创建官方分支**（官方 UI 只允许最后一轮分支——调研确认核心层 `session.fork` 支持任意已完成轮，限制仅是 UI 禁用按钮）。先做标记+跳转，分支经用户确认后本期一并实现。

### 调研
- `docs/会话书签-调研-20260809.md`：双人并行调研（Grok 源码层 + Codex 设计层）综合——fork 在 Core/Host/Client 三层支持任意已完成轮（`fork.spec.ts` "forks from an earlier turn boundary…"）；UI 层按钮每条轮尾都渲染、非最后一条仅 `aria-disabled` + tooltip（产品层收敛非技术限制）；积木：`conversation.chat.turnTail` 槽 / `data-chat-anchor-key` 锚点 / `session.fork` RPC。

### 实现
- **宿主端** `lib/bookmarks.js`：`BookmarkStore`（sidecar JSON 原子写、按 sessionId 隔离、同轮去重、上限 500/会话）；HTTP API `/memory-evolve/api/bookmarks`（CRUD + `/state` 探测，关闭时 404）；`buildForkSeed`（复刻官方 api-proxy 边界算法：atSeq → ≥ 该 seq 的第一个 `turn/end`，顺延吸收 out-of-band，**DSH 事件 seq 是 0-based**）；`forkSession`（`agents.create(seed, parentSession, seedLength, cwd)` + `workspace.attachSession`，与官方 fork RPC 同路径）；`bookmarkEnabled` 独立开关（默认关，RUNTIME_KEYS/validateRuntimePatch/applyRuntimePatch sync 链）；
- **客户端**：`bookmark-injector.tsx`——**DOM 注入**（B 方案，用户拍板：不占 turnTail chain 槽，官方 produced-files 行保留）：MutationObserver + rAF 节流扫描 `[data-chat-flow]`，Branch 按钮 `aria-disabled!=='true'` 判轮尾，星标 `afterend` 贴 Branch 旁（官方 Tooltip 是独立 bubble——接管按钮的原生 title 标注 + 隐藏兄弟 `[role="tooltip"]` 气泡 + 移除 `data-unavailable`）；**中间轮官方分支按钮被接管**（启用 + 悬浮标注"Memory Evolve 增强" + 点击弹确认 → fork API），最后一轮不干预；会话 id 经 `header.actions` 隐藏 entry 捕获；`BookmarksView.tsx` 列表 Tab（摘要/时间/搜索过滤/跳转/改名/删除/**分支**）；`TurnBookmarkButton.tsx`（星标 22px、命名/改名/删除、bookmarks-change 事件联动）；zh/en 文案含指南；
- **测试**：`tests/bookmarks.test.js` 18 个用例（存储/API/fork 边界/全链路/开关），全量 **272/272 全绿** + 构建成功。

### 验证
- npm test 272 全绿（含修复其他会话 a975013 遗留的 ui-settings.test.js 签名未同步问题）；npm run build 成功；用户重启后实测：星标/列表/跳转/中间轮分支（含确认弹窗与悬浮标注）均正常。

---

## 2026-08-09 — 本地文件搜索：内容检索修复（候选全量枚举）+ 四档模式（用户拍板）

### 内容检索 bug 修复（用户实测暴露）
- 症状：`镇江陆军军事学院.md`（UTF-8、内容含关键词、文件名/元数据正常）文件名模式能搜到、内容检索找不到；
- 根因：内容模式候选被 `CONTENT_CANDIDATE_CAP=500` 按 mtime 截断——全盘 md 10613 个，目标文件排在 500 名外**永远扫不到**；
- 修复（`lib/search-docs.js`）：`finalize` 支持 `limit=Infinity`（内容模式**枚举全量候选**，防御上限 `CONTENT_ENUM_CAP=20000`，不按 mtime 截断）；rg 批次 80→200 + 并发 6（全盘 1 万文件内容检索 1.2s）；
- 验证：10612 候选 230ms + 命中目标文件；新增防回归测试（600 候选 + 最旧目标命中，断言 provider 收到 Infinity）。

### 四档模式（用户拍板：内容检索可能用别人的实现）
- `searchDocsMode`：`all`=文件名+内容 / `filename`=仅文件名（content/contentQuery 忽略，不读任何文件内容）/ `content`=仅内容（query 视为内容关键词，文件名过滤停用）/ `off`=工具不注册；
- 工具 description 随 mode 动态生成（controller 在 mode 切换时重注册）；三级解析：运行时 mode → 配置 mode → 旧布尔开关兼容推断（`searchDocsEnabled` 保留兼容）；
- 配置 UI：checkbox → 四档 select（「配置」区，即时生效）；设置 Tab 指南与 README 同步更新；
- 测试 +3（filename 忽略内容参数 / content 强制内容检索 / controller 注册与重注册），全量 **276/276 全绿** + 构建成功。

---

## 2026-08-09 — 本地文件搜索扩展：内容检索（RAG 轻量版）

### 需求（用户拍板）
`memory_evolve_search_local_files` 增加**文件内容**检索（"哪个文档里提过 XX"）。设计原则：**不新增 AI 工具、不改现有参数**（不给模型增加工具负担），只加可选参数。

### 实现
- `lib/search-docs.js` 新增可选参数 `content`（boolean，默认 false=旧行为完全不变）与 `contentQuery`（内容关键词，缺省复用 query；传了即隐式开启）；rg 字面全文匹配 → 无 rg 降级 Node 逐文件读取；返回命中文件 + 片段（行号/上下文，每文件限 1-3 段）；大文件/二进制安全跳过；description 同步更新；
- JSON Schema 校验通过（type 单字符串 / required 顶层数组 / 输出与实现严格一致）；
- 测试 +15 用例（`tests/search-docs.test.js`，含默认行为不变/命中片段/contentQuery 覆盖/未命中/二进制跳过），全量 **272/272 全绿**。

### 验证
npm test 272 全绿；DSH `assertSupportedJsonSchema` 通过；npm run build 成功。

---

## 2026-08-09 — DSH UI 设置·功能三：消息气泡加宽（用户信息框占内容框 ~80%）

### 需求（用户拍板）
用户提交后的**消息显示框太窄**（默认 `min(525px, 82%)` 上限 525px），且开启「对话区加宽」后气泡相对更显小。要求：气泡占**中间内容框约 80%**，新增独立开关。

### 实现
- `ui-settings-features.ts` 新增 `wideBubble`（默认 false，与其他功能同款默认关）
- CSS（纯规则，无需 JS 扫描）：`html[data-dsh-ui-wide-bubble="on"] [data-time-hover-root] > div:first-of-type { max-width: 80% }`——用户消息行 userRow 有**恒定 `data-time-hover-root` 锚点**（MessageItem.tsx），bubble 恒为其**第一个 div 子元素**（steering 标记是 span、MessageIconActions 是第二个 div）→ `div:first-of-type` 唯一命中、不误伤 actions；specificity 高于原 `.bubble` 规则
- `wide-chat.ts` 新增 `createWideBubble()`（同款 html 属性控制器）；index.ts 激活块三控制器统一 FEATURES_EVENT 同步
- 「综合」子 tab 新增第三行开关；zh/en 字典
- 验证（headless + CDP 真实点击打开会话）：气泡 557px（默认 min(525,82%)+padding）→ 开气泡加宽 630px（内容 80%+padding 32px）→ 双开（+对话区加宽）859px（列 1034×0.8+32）→ 恢复 557px ✓

---

## 2026-08-09 — 「DSH UI 设置」独立子模块：左侧会话列表默认只显示进行中的会话

### 需求（用户拍板）
每个工作区都有很多会话，最关注的是正在运行的这一个——给左侧会话列表加筛选，**默认只显示进行中的会话**。作为新独立模块「DSH UI 设置」（dsh-ui-settings）的第一个功能：对 DSH web 界面做样式级小功能（后期扩展主题更换等）。用户拍板筛选语义：**只隐藏纯 idle**，活跃（正在生成/等审批/等回答/有子代理在跑/出错）+ 已完成未查看全部保留。

### 方案（纯客户端 DOM 增强，不改 DSH 框架）
- 调研确认（docs/DSH-UI设置模块-调研-20260809.md）：左侧列表由 ui-workspace 渲染在 `sidebar.workspaces`（kind:single，无法叠加组件）→ 走 DOM 增强；会话行有稳定锚点 `div[role=treeitem][aria-selected]`（工作区行有 aria-expanded、搜索结果行是 button 天然排除）；状态点 StateDot 带 `data-state` 属性，**纯 idle 行无状态点**
- 过滤规则是纯 CSS：`html[data-dsh-ui-filter="on"] [role="tree"] div[role="treeitem"][aria-selected]:not(:has([data-state])) { display:none }`——React 重渲染后选择器实时生效（会话开始跑自动出现、空闲自动隐藏），无轮询；`:has()` 需 Chrome 105+
- session-filter.ts：注入「仅进行中/全部」分段筛选条（锚定 [role=tree] 插到列表顶部）+ MutationObserver 保活（React 重渲染清掉后自动重注入）+ localStorage 偏好（无记录默认开启筛选）；状态挂 `documentElement.dataset`（React 不管理 html 属性）

### 实现
- 宿主端：独立开关 `uiSettingsEnabled`（默认关，设置 Tab「配置」切换，applyRuntimePatch sync 链即时安装/卸载）+ 状态端点 `GET /api/ui-settings/state`（关闭时 404，客户端探测失败不注入任何东西）
- 客户端：新「DSH UI 设置」Tab（order 46，指南子 Tab 与其他 Tab 同款）+ 设置 Tab「指南」页模块说明行 + 「配置」开关 + zh/en 字典
- 测试：tests/ui-settings.test.js（端点 200/404、dispose 清理、无 httpServer 面无副作用）；全量 242/242 通过；bundle 契约验证（id/apply/字典键）
- 验证：headless Chrome 实测真实 GUI——12 个会话行（1 running + 11 idle），注入规则后只剩 running 的 1 行 ✓
- 遗留：宿主端改动需重启 dsh web 生效（重启后开关在「Memory Evolve 设置」Tab「配置」里打开）

---

## 2026-08-09 — DSH UI 设置·用户反馈迭代：综合子 tab、功能默认全关、对话区加宽

### 需求（用户拍板，重启实测反馈）
1. 指南**不细讲**每个小功能怎么用（模块 Tab 指南 + 设置 Tab 指南行都精简）；
2. 功能开关**不放指南里**——新建子 tab「**综合**」（功能未定型前不精确分类）；
3. **每个功能都要有独立小开关**；筛选功能开关开了之后才出现筛选条；
4. **模块默认关（已有）+ 模块内每个功能也默认关**，一律由用户主动开启；
5. 第二个功能：**对话区加宽**——中间对话历史/输入框区域默认只占右侧一半
   （748px 居中窄栏）左右留白浪费；开关开启后扩大到约 95%，与上方 Tabs
   导航条对齐。

### 实现
- `ui-settings-features.ts`（新）：功能开关共享状态（localStorage +
  FEATURES_EVENT 事件广播）；默认 `{ sessionFilter:false, wideChat:false }`
- `UiSettingsView` 重做：子 tab「综合」（默认，功能开关列表，me-switch
  同款视觉）+「指南」（精简两节）；切换开关即保存并广播
- `session-filter.ts` 改控制器形态（setEnabled/dispose）：功能关=整体停用
  （移除筛选条/html 属性/停止 MutationObserver），开=按偏好恢复；筛选条
  模式偏好（仅进行中 vs 全部）单独记忆、功能开启后无记录默认「仅进行中」
- `wide-chat.ts`（新）：对话区加宽——覆盖 CSS 变量 `--dsh-chat-content-width`
  （`html[data-dsh-ui-wide-chat="on"] [data-phase] { --dsh-chat-content-width: 95% }`；
  [data-phase] 是 ConversationRoot 根 div 稳定锚点；输入框 +32px 派生自动
  跟随；选择器 specificity 高于原 .root 声明）
- index.ts 激活块：创建两个控制器 + 按 readFeatures() 初始应用 + 监听
  FEATURES_EVENT 即时同步
- 验证（headless Chrome + CDP 真实鼠标点击）：功能默认全关（无筛选条/
  无属性）→ 模拟开筛选（事件广播）→ 筛选条出现、12→1 行过滤生效 →
  开宽屏 → 变量 95%、对话区实际宽度 748→1034px（右区 95%）→ 关回 748

---

## 2026-08-12 — ⚡ 立即注入：快照变更 + 插话，当前回合立即生效（只注入一次）

### 需求（用户拍板）
普通注入写入注入轨、**下一轮生效**（模型 idle 时必然如此）；用户要求新增「立即注入」方式——通过**快照变更**立刻生效（会话广播/记忆等模块都是快照段，机制相同）。**立即注入只注入一次，不受次数/间隔两个数字影响**（用户补充拍板，必须写清楚）。

### 机制研究（DSH 核心确认）
- 所有快照段（memory:snapshot / 会话广播 / prompt:injections）都由 preStep 在**每步 LLM 调用前重新渲染** + RuntimeContextProjection 按整体文本 diff → 变化即追加 user 消息——**回合内（下一步）立即生效**；模型 idle 时下一轮。
- 问题：模型"注入完就结束回合"（或已 idle）时没有下一步 → 等下一轮。解决：**agent.steer 插话**（send msg 到 next-step inbox，wakeup=true）——回合循环 `turnEnds && nextStep 非空` 不结束，模型被拉住再走一步 → preStep 重新渲染快照 → 注入内容投影追加 → 当前回合看到；idle 会话被唤醒立即开始回合。

### 实现
- **lib/prompts.js**：
  - `steerImmediateInjection(ctx, sessionId, promptName)`：向目标会话发 next-step 插话（userMessage 同 de_session 构造，source kind 'user'）；轻量引导文案（内容本体在快照，避免双份重复）；agents 不可用/会话不在本进程返回 false（降级）
  - de_prompts `inject` 新增 **`immediate`** 参数（默认 false）：true=写一次性注入轨（rounds 强制 1 / every 强制 0，**忽略传入的 rounds/every**）+ 插话调用者会话；message「已立即注入…当前回合生效，仅此一次（不受次数/间隔影响）」；插话失败注明降级
  - Web API `POST /:id/inject` 新增 `immediate` + `sessionId`（GUI 会话页传入）；返回 `{injection, immediate, steered}`
  - `promptsToolDefinition` 新增 ctx 参数（execute 的插话需要 agents；直接构造时可省略，立即注入降级）
- **前端 PromptView**：「⚡ 立即注入」按钮（详情栏 + 临时注入表单），请求带 immediate+sessionId（props.sessionId）；成功提示区分插话送达/降级；DICT 中英文案
- 测试：tool immediate（忽略 999/5 → every=0/rounds=1、插话留痕 sess-main、turn 结束自动移除）+ Web API immediate（带 sessionId → steered=true；缺 sessionId → steered=false）；全量 236/236 通过 + DSH schema 校验

---

## 2026-08-12 — de_prompts 新增 create/update：模型可自行创建/修改提示词

### 需求（用户拍板）
模型此前只能查询/注入提示词，不能创建——"有没有工具能让模型自己去创建提示词？"

### 实现
- `de_prompts` action 新增 **`create`**（name+content 必填，description/category/tags/enabled 可选；与 GUI 新建同一校验与语义——分类留空自动归入「临时」；返回完整条目含 id，可继续 inject/update）
- 新增 **`update`**（id 必填 + 至少一个白名单字段 name/content/description/category/tags/enabled，传哪个改哪个；与 GUI 编辑同一校验）
- 输出归一化抽 `toPromptOutput()`（get/create/update 共用，与 output schema 严格一致）；render 对带 prompt 的结果统一渲染详情
- description/parameters 同步更新（action enum、字段说明）；测试补 create/update 闭环（建→查→改→禁用→拒绝注入 + 各类校验）；DSH 官方 schema 校验通过；全量 236/236 通过

---

## 2026-08-12 — de_prompts list 多维过滤：名称/场景/备注/分类 + 未命中明确提示

### 需求（用户拍板）
list 查询要支持按**名称、场景、备注、分类名称**查询；查不到时要有**明确提示**。

### 实现
- `list` 新增 4 个独立过滤参数（均可选、可组合，同时给多个 = AND 全部满足；子串匹配、大小写不敏感）：
  - `name`=按名称
  - `category`=按分类名称
  - `tag`=按标签/场景
  - `description`=按备注/简介
  - 原 `filter`（通用关键词：名称/简介/标签/分类任意字段）保留，可与以上组合
- **未命中明确提示**：指出是哪个条件没匹配（如「未查到匹配的启用提示词：名称「X」 + 分类「Y」（当前共 N 条启用中——可去掉部分条件重查，或 list 无参数查看全部）」）；一条不剩时提示「暂无启用中的提示词（共 N 条已禁用/不存在）」
- description/parameters 同步更新；测试补多维过滤与未命中提示断言；全量 235/235 通过

---

## 2026-08-12 — 注入成功文案去歧义（实测反馈）

### 问题
AI 调 `de_prompts inject`（rounds=1）后，返回 message「已注入「X」：1 次，每回合，模型下一轮生效」——「1 次，每回合」并列易误读为"每回合都注入"，实际语义是一次性（下一轮出现一次、次数用尽自动移除）。模型传参本身无误（description 已写明 rounds=1=一次），问题在输出文案。

### 修复（只改展示文案，不动语义）
- host 端 message 按次数+间隔组合显示**实际行为**：rounds=1 → 「只注入一次 … 模型下一轮生效，之后自动结束」（一次性时省略节奏括号——every 无实际意义）；rounds=N → 「注入 N 次（每回合/每 M 回合出现）… 用尽自动结束」；rounds=0 → 「持续注入（…出现）… 直到手动停止」
- 前端 GUI 提示（afterInjected）同构重写，新增 DICT 键（injectedOnceEnding/injectedFiniteEnding/injectedInfiniteEnding/injectInfiniteShort/everyTurnParen/injectCadenceParen）
- 测试补 message 断言（rounds=1 必含「只注入一次」「之后自动结束」、不含「每回合」）；prompts+plugin 33/33 通过

---

## 2026-08-12 — 提示词新增「简介」与「启用状态」字段 + de_prompts AI 工具（列表/详情/注入）

### 🎯 需求（用户拍板）
1. 提示词库每条提示词增加**简介**字段（新建/编辑均可填写，AI 选词时看它）；
2. 提示词有**启用/禁用状态**——AI 获取的列表**不显示禁用的**；
3. 暴露符合规则的 tool：AI 能**列出启用中的提示词**（id/名称/简介/分类/标签）、**按 id 查详情**（含正文全文），从而**选择合适提示词注入**；提示词列表也可作为**子会话/子代理/CLI 任务提示词**的来源（de_session / subagent / de_coi_dispatch）。

### 实现
- **数据层**（lib/prompts.js）：条目新增 `description`（简介，上限 500 字符，默认 ''）与 `enabled`（启用状态，默认 true，布尔严格校验）；create/update 白名单支持；新增 `listEnabled()`（只返回启用中）；seed 映射补 description；内置 13 条示例全部补写简介
- **de_prompts 工具**（随 promptsEnabled 开关整体注册/注销；名字可配置 `promptToolName`，默认 `de_prompts`）：
  - `list`：只显示**启用中**的提示词（id/名称/简介/分类/标签，**不含正文**——克制输出），支持 filter（名称/简介/标签/分类关键词）与 limit
  - `get <id>`：按 id 查详情——**全部字段**（含正文全文、启用状态、使用统计、时间戳；禁用提示词也可查，AI 自行判断）
  - `inject <id>`：把提示词**注入当前会话**（写入注入轨，模型下一轮生效；rounds=次数 0=无限、every=间隔 0=只注入一次，与 Web API 同规则）；**禁用提示词不能注入**、重复注入拒绝
  - description 写明**正确用途**：给当前会话注入纪律/流程，或取正文用作子会话/子代理/CLI 任务的提示词
- **GUI**（PromptView）：新建/编辑表单新增**简介输入框**与**启用状态开关**（禁用后列表置灰 + 「已禁用」徽标，AI 不可见不可注入，GUI 可随时重新启用）；列表摘要**优先显示简介**（为空回退内容首行）；临时注入表单同步支持简介
- **配置**：`promptToolName`（STRING_KEYS 白名单）

### 📝 文档与测试
- README：特性列表、提示词管理器章节补简介/启用状态/de_prompts
- 测试：prompts.test.js（字段默认值/校验/listEnabled/API 透传/de_prompts 闭环：list 过滤禁用→get 详情→inject→重复拒绝→禁用拒绝→filter/limit/非法参数）+ plugin.test.js（开关注册/注销、自定义工具名、output schema 校验）；全量 226/227（唯一失败为另一会话进行中的 broadcast 模块改动，与本轮无关）

---

## 2026-08-08 — memory 工具新增 archive 与归档查询：AI 直接归档/检索三轨记忆

### 🎯 需求（用户拍板）
记忆 Tab 的「归档」按钮（主轨条目 → 归档文件）此前只能用户手动点；用户要求把归档能力**暴露成 tool**，AI 可直接归档、并能**查询归档内容**。

### 实现
- `memory` 工具 action 新增 **`archive`**（target 限 memory/user/key + match 唯一片段）：与 UI 归档按钮**同一语义**——按唯一子串片段从主轨移除整条（`store.remove`，含 drift guard），**原文追加**进对应归档文件（`MEMORY-archive.md` / `USER-archive.md` / `projects/<项目>/KEY-archive.md`，key 需会话工作目录），**可逆**（记忆 Tab 归档页「移回主记忆」转正）；先删后加，删除失败绝不产生重复归档条目
- `memory` 工具 `list` 新增 **`archived=true` 查询**：查对应归档文件（仅 memory/user/key 三轨，key 需 cwd），支持 filter / since / until / recent / limit（与主轨 list 语义对齐）——AI 可检索"归档了什么"，需要时提示用户移回或人工转正
- `MemoryStore.remove` 成功返回新增 `removed` 字段（被删整条原文，含时间戳）——归档等"移动"场景免二次匹配
- project/daily 不归档（tool 层明确拒绝并提示）
- subagent 写全局轨（memory/user）的既有门禁对 archive 同样生效

### 📝 文档
- README：特性列表「记忆读写」补归档、记忆 Tab 段补 memory 工具 archive/archived 查询
- 测试：store.remove 的 removed 字段断言 + 三轨归档组合流程（remove → append → 可逆）+ tool 层归档闭环（archive → 主轨空 → archived list 可见 → 过滤/隔离/报错）；全量 223/223 通过

---

## 2026-08-09 — 会话编排增强：rename 标记 + 工作区分组 + 头部按钮迁移

### 🎯 新能力
- **me（我是谁）**：`de_session me`——查当前会话自身信息（session ID / 会话名称 / 别名 / cwd / provider+model / 状态），AI 确认自己身份、把 ID/别名告知他人协作时用（AI 反馈无法直接查到自己的 ID/名称/别名）
- **rename（改名称/别名做标记）**：`de_session rename`——sessionId + title（可选，**会话名称**=左侧列表标题，走 DSH sessionTitle.rename，user source pin 住不被自动覆盖；需 live 会话，offline 可先 wake 恢复）+ alias（可选，**会话别名**≤10 字，广播/快照显示，空串=清除）——两者至少给一个、可同时改；产品经理给员工会话做标记后谁是谁一目了然
- **spawn 挂工作区分组**：新会话自动 attach 到 cwd 对应 workspace（左侧"项目"分组）——曾漏 attach 导致 cwd 正确但会话显示在「未分组」
- **头部按钮迁移（架构）**：会话头部「⧉ 复制会话ID」「✎ 别名」按钮从广播模块**迁移到会话编排**（跟随 sessionEnabled）——会话身份功能本不属于广播；广播面板顶部保留复制入口，只开广播时复制能力不丢
- **共享别名存储**：AliasStore 单实例（lib/index.js 创建）供 /api/aliases 与 de_session rename 共用，避免多实例内存缓存互覆写
- **文档**：README（spawn/wake/rename/分组/按钮归属）、设置 Tab 指南与开关 hint 同步
- **测试**：rename（live 改名/别名设清/offline 报错/同时改）；全量 220/220 通过

---

## 2026-08-09 — 会话编排迭代修复（实测排坑）

### 🎯 实测中发现并修复（产品经理协作实跑）
- **status 无返回**：live 分支返回缺 `message` 字段 → render 输出空字符串（表现为"查询没有返回"）——补 message 文案 + render 兜底（status 结果始终渲染 🟢/⚪/⚫ 状态行）
- **新会话无工作目录**：spawn 不传 cwd 时新会话落默认工作区、不在发起会话项目里——**cwd 默认继承发起会话**（header.cwd），显式 cwd 优先；spawn 记录留档 cwd
- **新会话缺模型**：spawn 继承发起会话 provider/model（曾 {{model}} 无值回合失败）；**wake 用会话自己的模型配置**（log 里最后的 provider/model，含 webUI 改过的——resume 不传 agentOptions，天然用它自己的）
- **README 同步**：插件简介、30 秒了解、特性列表补齐「会话编排」；协作纪律（不自动唤醒、人类最终拍板）写清
- **测试**：继承（cwd/model）、render 兜底断言、记录留档；全量 219/219 通过

---

## 2026-08-09 — 会话编排模块（de_session）：AI 程序化创建/唤醒会话

### 🎯 新能力（用户协作痛点：手动开 5 个会话太麻烦）
- **spawn**：程序化创建**标准 DSH 会话**（与 GUI 手动打开完全同构：系统提示词/工具/记忆快照/持久化，出现在左侧会话列表可接管）——`prompt` = 完整提示词（角色/任务自由组合的长文本，**不需要单独角色提示词**），创建后立即自动开跑（等价替用户发消息）；可选 `cwd` / `roomId`（加入广播房间，松耦合桥接：广播未启用只提示不阻断）/ `model`
- **wake**：唤醒已有会话——`sessionId` + 提示词，等价替用户发消息，对方 AI 自动醒来处理（忙则排队）；进程重启后自动 resume 再唤醒；跨实例/不存在明确报错
- **status / list**：running / idle / offline 状态查询 + spawn 记录追溯（谁建的/任务/房间/时间）
- **独立子模块**（用户拍板纪律）：独立开关 `sessionEnabled`（默认关）+ 独立存储目录 `sessionDataDir`（`<memoryDir>/session-orch`）+ 独立装配 `installSession`；与广播仅 `getBroadcastStore` 桥接；模块卸载只清理自己 spawn 的 agent，用户会话不受影响
- **边界**：仅同进程会话可唤醒；唤醒 = 替用户发消息（GUI 可见可审计）
- **测试**：新增 tests/session-orch.test.js 6 项（store 落盘/spawn 派发/wake live+resume+失败/status/list/卸载清理）；全量 219/219 通过；de_session schema 过 DSH assertSupportedJsonSchema 校验

---

## 2026-08-09 — 会话广播收件箱 UI + 指南 + presence 持久化

### 🎯 管理面板迭代（用户反馈驱动）
- **收件箱**：默认只显示**未读**（已读自动隐藏）+ 未读/全部/已读筛选 + 搜索（主题/发件人/内容）+ 分页（20 条/页）+ 状态徽标（未读/已读/长内容）；被读消息不占列表
- **房间**：展开后房间消息**同款筛选/搜索/分页**；「进入房间详情」按钮加大（正常按钮尺寸）；成员状态显示最近活动时间
- **子 Tab 对齐标准**：改用全局 `mt-file-tab` 样式（32px 高 + 底部横线 + active 品牌色），与其他 Tab（记忆/待办/技能）**零差异**——此前误用 me-tab 胶囊不标准；通知/错误条移到子 Tab 下方，子 Tab 恒居左上角
- **「指南」子 Tab**：新增本模块友好介绍（TabGuideView 结构化：是什么/怎么发/收件箱/房间与在线/别名/开关，zh/en）
- **红色按钮实底**：删除/解散/踢出改实底红 + 白字（此前 10% 浅红底暗色主题下不可见），hover 加深

### 🎯 presence 持久化（重启不退化 unknown）
- **根因**：presence 是进程内存数据，dsh 重启后清空 → 房间成员全变 unknown（与房间/成员无关，重建房间无效）
- **修复**：`PresenceTracker(ctx, storageDir)` 可选落盘 `presence.json`（事件后 2s 防抖写盘 + dispose 强制 flush + 原子写），重启后成员保留上次状态与活动时间；真正 unknown = 从未在本进程活跃（跨 DSH 进程的会话不可感知，属设计边界），UI 明示「unknown · 无活动记录」

### 📝 测试
- 新增 presence 持久化用例（模拟重启保留）；全量 213/213 通过

---

## 2026-08-08 — 提示词管理器：一键预设注入（交互友好化）

### 🎯 预设按钮 + 自定义展开（用户拍板：两个裸输入框对普通用户太难）
- **交互改造**：注入区从"两个数字输入框"改为**预设按钮组**——「注入一次」（rounds=1, every=0，下一轮出现一次即结束）/「持续注入」（rounds=0, every=1，每回合直到手动停止）/「自定义」（展开次数×间隔自由输入 + 效果预览 + 注入/收起）——覆盖绝大多数"只想注入一次"的场景，普通用户点一下即可，无需理解参数模型
- **临时注入表单同步改造**：同样三个预设按钮（创建+注入一步完成）
- **用户红框排查结论**：host 端 every=0 早已生效（curl 实证），红框来自浏览器加载旧 bundle（旧前端把间隔 0 当非法值）；服务端 bundle 已确认含全部新代码（转义大写 \uXXXX，此前小写正则误报），用户强刷页面（Cmd+Shift+R）即可

---

## 2026-08-08 — 提示词管理器修复与迭代：间隔 0 = 一次性 + 幽灵分类可管理

### 🎯 间隔 0（只注入一次）
- **语义**：`every=0` = **一次性注入**——用户"间隔 0 = 注入一次后不再出现"的直觉语义；host 端把次数强制为 1（`roundsLeft=1, every=0`），出现轮结束直接移除（tickTurn 不进次数/间隔模型）
- **UI**：间隔输入框 min 0，hint 更新（`0=只注入一次；1=每回合；N=每 N 回合一次`）；新增**注入效果即时预览**（一次性 / 无限次 / 共 N 次·每 M 回合，随输入实时变化）；注入节奏文案支持 every=0（「只注入一次」）；API 校验改为 every ≥ 0

### 🎯 幽灵分类可管理（修复分类改名/删除红框）
- **根因**：提示词里残留、不在受管列表的旧分类名（如删过受管分类前的存量数据）在分类树显示管理按钮，但 host 端不认 → 报「分类不存在」红框（用户反馈"红框没有任何信息"）
- **修复**：`renameCategory` / `removeCategory` **宽容处理**——分类不在受管列表但该分类下还有提示词时同样允许改名/删除（改名同步提示词并自动注册新分类；删除把提示词移到未分类）；完全不存在（无提示词且不在列表）才报错

### 📝 文档同步
- README：注入小节补 every=0 与效果预览、分类小节补幽灵分类宽容、API 描述补 every 0=一次性
- 测试：every=0 生命周期（add 覆盖次数 / tick 一次移除 / API 注入）、幽灵分类改名/删除用例；全量 213/213 通过

---

## 2026-08-08 — 会话广播房间/项目群（聊天室 + 自动清理）

### 🎯 新能力：多会话协作群聊
- **房间（room，聊天室）**：`de_broadcast` 新增 `room-create` / `room-join` / `room-leave` / `room-list` / `room-rm`（解散，仅创建者）——房间 = { id, name, members: [会话ID...] }（`rooms.json`），**成员=会话 ID 数组与工作目录无关，天然跨工作目录协作**；`send` 的 recipients 可传房间 id（`room-xxx` 裸 id 或 `room:<id>` 均宽容识别）→ **所有成员同时收到**（快照定点注入）；发送者须是成员；最后一人退出自动删房
- **项目群（project:<路径> 伪接收者）**：`send recipients: ['project:/绝对路径']` → 该目录内所有会话可见（按会话 cwd 匹配，跨目录不可见，公告语义）
- **默认一对一**：工具描述约束"仅用户明确要求时用房间/项目群，不擅自扩大发送范围"（防 AI 误扩散）
- **语义区分**：显式接收者消息保持"全员已读自动删除"（read 即消费）；房间/项目消息是共享讨论——read 只清未读、**保留 30 天供回看**（list 已读也显示，unread 标记区分）
- **自动清理**：房间 `lastActiveAt`（发消息/加入即刷新），**30 天无活动自动删除连同其消息**（每日 prune + 启动时）
- **可见性全链路**：快照未读清单 / list / read / delete 均按"直接接收者 / 房间成员 / 项目 cwd"过滤，非成员/跨目录完全无感知
- **Grok 审查修复**：P0 room 输出剥离 `createdBy` 等内部字段（超 schema 会被模型 API 拒）；P1 房间消息已读后保留在列表（回看语义）；schema 经 DSH assertSupportedJsonSchema 校验通过
- **测试**：41 → 42 项 COI 测试（RoomStore 生命周期 / 伪接收者可见性 / 工具 actions / 快照注入 / prune 房间清理）；全量 206/206
- **文档**：README（30 秒了解 + 广播章节）、设置 Tab 指南（zh/en）、docs/COI-调度.md §12.5 同步

## 2026-08-08 — 会话广播管理面板 + 系统通知 + 软删除（可感知协作）

### 🎯 新能力
- **管理面板 Tab「会话广播」**（用户超管视角，跟随 broadcastEnabled）：消息收件箱（全部消息/全文展开/删除任意消息，含私信/房间/项目类型与长内容标记）+ 房间列表（成员在线 🟢/⚪ 30s 轮询、活跃/空闲/已解散状态、最后活动、创建时间）+ 踢人/解散按钮（确认弹窗）+ 我的会话 ID 一键复制；管理 API `/memory-evolve/api/broadcast/*`
- **系统通知（可感知操作）**：踢人（`room-kick`，创建者）与解散（`room-rm`，创建者 / 面板超管）自动向受影响成员发系统消息（sender=system，快照/面板显示「来自 系统」，显式会话 ID 接收——不依赖房间存在）；被踢者/成员 read 即知情，无无声操作
- **软删除（可追溯）**：解散 = 房间标记 `status:'dissolved'` + `dissolvedAt`，记录保留 30 天供面板追溯；已解散房间拒绝加入/发消息；最后一人被踢自动解散
- **修复**：rooms.get 返回对象引用导致 dissolve 通知条件失效（before.status 被原地污染）——工具与 API 均改用操作前快照
- **测试**：45 → 45 项 COI 测试（kick 权限/系统通知/被踢不可见/API 全路由/在线聚合/软删除）；全量 209/209
- **文档**：README/docs §12.5 补系统通知/软删除/管理面板说明

## 2026-08-08 — 会话别名（友好名称，告别满屏长 Session ID）

### 🎯 新能力
- **会话别名**（≤10 字，允许重复——ID 才是唯一标识）：会话头部「✎ 别名」按钮（复制会话 ID 旁）设置/修改/清除（保存/清除按钮 + 回车提交）；存储 `<memoryDir>/aliases.json`（全局属性，不挂任何模块开关）
- **快照拟人化**：「你的会话」段注入别名行（`你的会话别名：小明` + ID 行）——AI 不仅知道自己的 ID 还知道自己的友好名称
- **显示别名优先**：广播面板（消息发件人/房间成员）、快照广播行、de_broadcast list/read 均显示「别名（短ID）」，完整 ID 悬停/title 可见（AI 发消息仍需 ID）；无别名回退短 ID；系统通知仍显示「系统」
- **API**：`GET/PUT/DELETE /memory-evolve/api/aliases`（全量/设置含 10 字校验/清除）
- **测试**：新增 tests/aliases.test.js（store/快照段/API 3 项）；全量 212/212
- **文档**：README/docs §12.5 补会话别名说明

## 2026-08-08 — 会话搜索独立模块（de_session_search）

### 🎯 新能力：搜索其他 AI 工具的历史会话（当前仅 Codex）
- **独立子模块**（沿用用户拍板纪律：不挂在 COI/广播等任何模块下）：**独立开关 `sessionSearchEnabled`**（默认关，设置 Tab「会话搜索」开关，与 COI 调度/广播互不影响）+ 独立装配 `installSessionSearch`（lib/search/ 目录）+ 零常驻状态（无索引/缓存/定时器，每次调用实时只读扫描，不修改任何会话文件）
- **工具（单个）**：`de_session_search`——`query` 必填（大小写不敏感字面匹配，中英文/标点同一规则，只搜用户/助手消息），可选 `source`（当前枚举仅 codex，预留扩展）/ `cwd`（按工作目录子串限定项目，Codex 会话记录 cwd）/ `sort`（relevance 默认 / newest / oldest）/ `limit`（默认 10 上限 50）/ `window`（默认 10 上限 30）；返回命中会话 + 最强消息摘要（snippet，命中为中心 350 字符）+ 上下文消息窗口（每条裁剪 600 字符防撑爆上下文）
- **实现**：发现（`~/.codex/sessions` + `archived_sessions` 递归、有界深度）→ **rg 字面预筛**（`--files-with-matches --fixed-strings --ignore-case`，本机 46MB 语料全扫 12ms；rg 缺失/失败/超时 30s/输出超限 8MB/查询含 JSON 转义字符时**回退全量解析**，结果正确性不依赖 rg）→ 流式逐行解析（防御上限：单文件 64MB/单行 512KB/单消息 4KB；**坏行宽容**——单行损坏只跳过该行，绝不淘汰整个会话，吸取 dsh-session-search"一行坏 = 整会话消失"的教训）→ 有界 Top-K 累积（内存有界）+ abort 取消支持
- **Codex 双格式兼容**（Grok 审查发现）：旧 codex-cli 格式（`event_msg` / `user_message` / `agent_message`）与新 codex-tui 0.147+ 格式（`response_item` / payload.type=message / role=user|assistant|developer，developer 系统注入跳过；content 块数组 input_text/output_text）都支持——新 TUI 会话不再漏搜；msgId 优先取 payload.id
- **设置指南**：「Memory Evolve 设置」Tab 指南新增「会话搜索」条目（zh/en）；开关文案同步

### 📝 文档同步
- README：简介（第 3 行）与 30 秒了解章节补「会话搜索」；特性列表新增独立条目；新增独立「会话搜索（de_session_search）」章节（参数/搜索语义/实现/性能/配置/安全）；配置表新增 `sessionSearchEnabled` / `sessionSearchRoots`
- 测试：新增 tests/session-search.test.js（25 个用例：core 纯函数 / Codex 新旧格式解析 / rg 预筛与回退 / cwd 过滤 / Top-K / 转义字符 / schema 形状 / 装配卸载），全量 201/201 通过

---
## 2026-08-08 — 提示词管理器迭代：临时注入 + 自由数字（次数/间隔）

### 🎯 临时注入（不建提示词直接注入）
- **流程改造**：原来必须先建提示词才能注入；现在详情栏未选中任何提示词时即为「临时注入」表单（名称可选 + 内容必填 + 分类可选 + 次数/间隔），点「注入」**自动存入提示词库 + 注入生效一步完成**——POST /prompts 创建（名称留空取内容首行前 20 字）→ POST /:id/inject → 自动选中新条目（可继续改名/改分类）
- **「临时」默认分类**：新建/临时注入时分类留空自动归入**「临时」**（新增内置受管分类，DEFAULT_CATEGORIES 8→9）；「未分类」保留"删除分类后落点"的兜底语义——编辑已有条目时清空分类 = 移回「未分类」（修掉编辑未分类条目保存报"分类不能为空"的隐患）

### 🎯 次数/间隔自由输入
- 界面次数/间隔从固定选项（0/1/3/5/10、1/2/3/5/10）改为 **type=number 自由输入任意整数**（次数 0=无限，间隔 1=每回合，空输入自动回默认；label 旁 hint 提示语义）
- host 防御上限 `MAX_ROUNDS` 50 → 9999（只挡手滑超大数）；`/prompts/:id/inject` 校验不变（rounds ≥1 或 0，every ≥1）

### 📝 文档同步
- README：30 秒了解 / 特性列表 / 提示词管理器章节补临时注入与自由数字；顺手修正快照段描述（命令式指令文案，不含机制/GUI 话术）与内置示例数量（12→13）；设置面板指南与开关提示同步
- 测试：InjectionStore 上限断言更新 + 任意数字（rounds=999/every=7/上限截断 9999）、Web API 任意数字注入（rounds=7, every=4）、create 空分类→「临时」、update 空分类→「未分类」

---

## 2026-08-08 — 会话页 Tab 体系重构 + 会话广播独立模块（de_broadcast）

### 🎯 会话页 Tab 拆分（记忆 / 技能 / 待办 / Memory Evolve 设置 四个独立 Tab）
- 原「记忆技能待办」单 Tab 拆为三个独立 Tab：**记忆**（order 20：指南 / 待确认记忆建议 + 记忆文件页签）、**技能**（order 21：指南 / 待确认技能建议 / 技能管理）、**待办**（order 22：指南 / 待确认待办管理 / 待办）；各 Tab 红点分别统计记忆/技能/待办建议数（`/api/badge` 三路拆分，任一变化只重注册对应 Tab）
- **新增「Memory Evolve 设置」Tab**（order 45，放最后）：整体指南（全插件功能简单介绍）+ **配置**（原「运行时配置」改名；本地搜索 / COI 调度 / 会话广播 / 提示词管理器 / 临时信息 的启用开关都在这里）
- **每个 Tab 都有「指南」子 Tab**：设置 Tab 的指南 = 整个插件所有功能的简单介绍；记忆/技能/待办/COI 调度/提示词注入/临时信息 Tab 的指南 = **各自功能的详细介绍**（新组件 `TabGuideView.tsx` 统一渲染，zh/en 双语）；记忆 Tab 指南覆盖五轨记忆/文件页签/git 分支感知/编辑维护/待确认建议机制，技能 Tab 覆盖技能是什么/如何沉淀/技能管理/禁用/自定义目录/创建纪律，待办 Tab 覆盖四轨/如何添加/待确认管理/状态属性/智能视图/到期提醒
- **改名**：「CLI调度」→「COI调度」、「提示词」→「提示词注入」（仅文案）

### 🎯 会话广播（de_broadcast，独立子模块）
- **架构修正（用户拍板 2026-08-08）**：会话广播曾挂在 COI 调度下跟随 coiEnabled——明显独立的子模块不应借其他模块的开关（曾导致开关联动、工具上下文污染）。现拆为独立模块：**独立开关 `broadcastEnabled`**（默认关，设置 Tab「会话广播」开关，与 COI 调度互不影响、可单独开启）+ **独立装配 `installBroadcast`** + **独立存储目录 `broadcastDataDir`**（默认 `<memoryDir>/broadcast`）+ 独立快照段；工具由 `de_coi_message` 改名 **`de_broadcast`**
- **功能**：DSH 会话之间传递消息——会话头部「⧉ 复制会话ID」按钮复制当前会话 ID，告诉另一个会话的 AI 后它可 `de_broadcast send` 发广播（recipients 会话 ID 数组，可同时发给多个；subject 可选缺省取内容首行）；接收方快照**定点注入**未读提示（收件箱式 id+主题+发送者+时间，只对接收者可见，其他会话无感知）；`read` 即消费（全部接收者读完后自动删除，绝不提前删）；超过 8KB 内容自动落文件 `broadcast/broadcasts/<id>.txt`；30 天自动清理（启动 + 每日定时 prune）；工具 action：send / list / read / delete
- **常驻「你的会话 ID」快照段**：快照最前面新增常驻段（不随任何开关、每个会话始终注入，subagent 等无会话视角不注入）——AI 始终知道"我是谁"，用它与消息里 sender/recipients 比对判断收发方，回复时把 ID 告知对方

### 📝 文档同步
- README：简介（第 3 行）与 30 秒了解章节补「会话广播」；特性章节广播从 COI 条目移出为独立条目；新增独立「会话广播（de_broadcast）」章节；配置表新增 `broadcastEnabled` / `broadcastDataDir`，`coiEnabled` 改回纯调度描述；「会话页记忆/技能/待办 Tab」章节重写为四 Tab + 各 Tab 指南结构；全部「记忆 Tab 运行时配置」引用改为「Memory Evolve 设置」Tab「配置」
- docs/rules.md 第 6 节重写为四 Tab 结构；docs/COI-调度.md 开关入口引用更新

---

## 2026-08-07 — 提示词管理器（Prompt Manager）

### 🎯 提示词管理器（会话页第四个独立 Tab「提示词」）
- **提示词库**（`<memoryDir>/prompts.json`）：CRUD + 分类树 + 标签 + 搜索（名称/分类/标签/内容）+ 复制剪贴板 + 使用统计（次数/最近注入）；三栏布局（左分类 / 中列表 / 右详情表单），操作后自动刷新
- **分类管理（受管实体）**：默认 8 个内置分类（开发流程/问题排查/设计/测试/质量/性能/文档/产品）；「＋ 新分类」添加、分类行 hover「×」删除（确认弹窗提示该分类下提示词将移到未分类，不删除提示词本身）；编辑提示词输入新分类名自动注册入受管列表（隐式注册保持一致性）；「未分类」为兜底视图不可删除；API：`GET/POST /prompts/categories`、`DELETE /prompts/categories/:name`
- **注入执行器（有状态）**：选中提示词配置「次数 × 间隔」写入**注入轨**（`prompt-injections.json`）——复用「写后即时注入、不打断回复」通道，模型**下一轮**自动看到；**次数支持无限（默认，持续注入直到手动停止）/ 一次性 / 有限 N 次**，**间隔支持每回合 / 每 M 回合出现 1 次**，宿主监听 `agent/turn-stopping` 按 **countdown 模型**推进（出现轮消耗 → 间隔等待 → 再出现；无限不消耗永不自动过期；**只计主会话回合，subagent 不消耗**），有限次数耗尽自动移除
- **状态可视化**：列表项「注入中·剩 N 次 / 持续注入」徽标 + 详情面板状态与节奏显示 + 「停止注入」按钮 + 「注入中」浮层（次数/节奏/停止）；**会话页 Tab 栏红点「🔴 提示词 (N)」**（活跃注入时显示，30s 轮询 + 注入/停止即时刷新）；已注入的提示词不可重复注入（先停止再注入）；删除提示词**级联清理**其活跃注入
- **快照段 `prompt:injections`**（order 520）：**只渲染出现轮**（countdown===0）的注入（标题 + 剩余次数 + 节奏 + 内容全文），间隔等待轮与空轨返回空串零开销
- **变量展开**：`{{date}}`/`{{time}}` 注入时自动展开，预留 vars 覆盖（二期监测注入扩展口）
- **内置示例（GitHub 真实资产）**：**13 个来自 GitHub 真实提示词库的完整条目**（英文原文保留未加工）——[SpecRoute](https://github.com/Enovatr-Labs/SpecRoute)（spec-driven：代码审查 / PRD→Spec / Spec→任务拆解 / 任务实现 / 行为保持重构）与 [Claude-Code-Promts-Skills](https://github.com/Rtur2003/Claude-Code-Promts-Skills)（DEBUG 协议调试 / 安全审计 / 性能优化 / 数据库优化 / 测试策略 / 架构模式 / Git 版本控制 / 技术文档写作）；单条 2-24 KB 完整内容；数据在 `lib/prompts-seed.json`（**version 3**，数据与代码分离、独立可替换），首次运行 seed、已有数据不覆盖；「来源」浮层列出 GitHub 范式库链接（用户自取，不做爬虫导入）
- **运行时开关**：记忆 Tab「运行时配置」新增「提示词管理器」开关（**默认关闭**，与本地搜索/COI 一致——普通用户不需要此功能）；开启时安装快照段/事件监听/API，关闭整体卸载（存储数据保留）；使用指南新增提示词管理器条目
- **API**（`/memory-evolve/api/prompts` 独立 prefix，与 COI 同构）：CRUD + inject（rounds/every 参数、**rounds=0 无限**、重复注入拒绝 + 统计）+ 注入轨查看/停止 + sources；注入 API 即**预留的外部触发入口**（未来文件/Git/端口监测注入只对接注入轨 add）
- 测试：`tests/prompts.test.js` 7 项全绿（存储/间隔计数/无限模式/变量/快照渲染/HTTP 全路由/turn-stopping 集成/dispose），全量 162/162

---

## 2026-08-07 — COI 调度模块 + 临时信息便签（de_coi）（`059790c`）

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
