# COI 调度（de_coi）使用文档

> dsh-memory-evolve 插件的 COI 调度模块：把任务派给外部 CLI 代理（kimi / codex / grok / hermes 或任意自定义 CLI），统一调度、实时看进度、会话分层管理、记忆上下文注入。
> **默认禁用**：先在「记忆技能待办」Tab →「运行时配置」打开「COI 调度」开关（工具即时生效，Tab 刷新后出现）。

---

## 1. 这是什么

COI = 命令行 AI 代理。本模块解决三个痛点：

| 痛点 | 解决 |
|---|---|
| 通过 bash 调用是黑盒，看不到进度 | 后台进程化 + **实时日志流**（GUI 任务详情 + 全屏放大） |
| 会话恢复靠人肉记 session id | **自动捕获 session id**，分层管理、备注、一键恢复 |
| COI 不了解你的规则和上下文 | **记忆上下文注入**：把长期记忆/用户档案/项目关键记忆带给 COI（不含 AGENTS.md） |

## 2. 快速开始

1. 开启开关（见上）
2. 三种入口任选：
   - **对 AI 说**："派给 kimi 做 XX / 让 codex 修复测试"（AI 用 `de_coi_dispatch` 工具，任务完成自动接续）
   - **终端**：`/de_coi run "任务" --coi kimi`
   - **Web**：会话页「COI 调度」Tab → 任务页填表单发起
3. 在任务详情看实时进度；完成后输出自动留档、摘要自动沉淀到记忆

## 3. 核心概念

- **适配器（Adapter）**：描述"如何调用某个 CLI"的声明——命令模板、会话恢复参数、session id 提取规则、适用场景、关联技能
- **任务（Task）**：一次 COI 调用，有独立 taskId、状态机（queued → running → completed/failed/killed/interrupted）、输出留档
- **会话（Session）**：COI 侧可恢复的会话（session id），跨任务存在
- **层级（Scope）**：任务/会话的归属，决定可见范围（见 §5）

## 4. 适配器管理（「适配器」页 / `/de_coi adapters`）

### 内置四家（开箱即用）

| 适配器 | 适用场景 | 会话恢复 |
|---|---|---|
| `kimi` | 前端/界面与交互、识图（读截图/照片）、快速开发 | `-S <id>` / `-c` |
| `codex` | 复杂逻辑与后端、测试修复、代码审查、PR/大型改动 | `exec resume <id>` / `--last` |
| `grok` | 快速问答、总结日志/文档、需要速度的中等任务 | `-r <id>` / `-c` |
| `hermes` | 通用 agent 任务：文件操作、网络、多工具协作、消息推送 | `--resume <id>` / `-c` |

### 每张卡片可操作

- **🎯 适用场景**：点「编辑」修改（AI 选择适配器时参考；`de_coi_dispatch` 的场景说明在重启后随之更新）
- **技能**：点「技能」查看/编辑该适配器的 SKILL.md（= AI 的使用指南，注入模型上下文；可在「技能管理」Tab 禁用）
- **启用/禁用**：COI 不可用时主动关闭——AI 派单会被拒绝并提示换用其他可用项
- **测试**：一键验证配置（跑一次 testCmd，结果在任务列表）

### 自定义适配器（添加表单）

| 字段 | 说明 |
|---|---|
| id / 名称 | 唯一标识与显示名 |
| 类型 | `ai-cli`（有会话恢复）/ `plain-cli`（普通命令，无会话） |
| 可执行文件 / 参数 | 命令与参数模板（`{task}` `{workdir}` `{model}` 占位符） |
| 技能名 | 关联技能（可选）：AI 据此学会调用此 CLI |
| 技能内容 | 填了就在技能不存在时自动创建 SKILL.md（frontmatter 自动补全） |
| 适用场景 | 告诉 AI 什么任务适合用它 |

> 技能格式要求：SKILL.md 的 frontmatter 必须含 `name` 与 `description`（缺失会报错），无 frontmatter 时自动补全。

## 5. 会话分层（可见范围）

| 层级 | 谁能看到（任务列表/会话列表/AI 查询） | 生命周期 |
|---|---|---|
| 临时 `temporary` | **仅发起它的那个会话** | 一次性（适配器测试用它）；留档保留 90 天 |
| 会话 `session` | 仅发起它的那个会话 | 会话内可恢复 |
| 项目 `project` | **发起者工作区内的所有会话**（按发起会话的工作目录归属，可挂 git 分支）——一个工作区常派多个目录的任务（如 dsh-virtual-platform 派 fe-erp1.0），跨目录派的任务在同一工作区可见，**其他工作区看不到**；旧任务（未记录工作区）回退按任务 cwd 匹配 | 跨会话长期 |
| 全局 `global` | 所有会话 | 长期保留 |

- **分支维度**：项目级任务/会话可挂 git 分支（与记忆 key 轨同构），恢复时按"项目 + 分支"过滤
- **会话备注**：给会话起名/打标签（如"镇江部署-登录模块"），按名检索恢复
- **会话导出**：`/de_coi export <sessionId> --coi <适配器>`（kimi export / grok export / hermes sessions export）
- **并发锁**：同一会话同时只能跑一个任务（防上下文串扰）

## 6. 任务管理（「任务」页）

- **发起表单**：适配器、任务内容、层级、恢复会话（下拉选已捕获会话，**按适配器过滤**）、任务模板、接力引用（引用上一任务输出）、注入记忆上下文
- **列表**：搜索（内容/任务 id）、状态图标、40 字截断（悬停看全文）、垂直滚动
- **详情**：状态/耗时/**最后输出时间**（运行中实时刷新，判断活性）、任务内容（只读可放大）、实时日志（2s 轮询 + ⛶ 全屏放大）
- **操作**：终止（运行中，确认弹窗；`/de_coi stop` 二次确认）、重试（同会话再发起）、删除（确认；运行中不可删）
- **状态判断**：`running` = 进程存活；超时兜底默认 12 小时（配置页可调小时/分钟）；**最后输出时间长时间不增长 + 远超预期时长** → 可疑，手动终止

## 6.5 主动通知（任务完成自动出现在模型上下文）

CLI 任务完成后，其**结果摘要（输出尾部 1KB）**会自动注入主 AI **下一次**的上下文（快照「COI 任务状态」段：运行中最多 3 条 + 最近完成 2 条，各一行）：

- **无需轮询、无需阻塞等待**：派完任务继续做其他事，完成信息下次自动可见（与记忆注入同一尾部机制，不打断当前回复、变更检测缓存友好）
- **摘要来源**：任务输出尾部 1KB（模型派活时约定「最后输出【结论】段」则尾部即结论）；完整输出在任务详情留档
- **完整闭环**：模型看摘要 → 要细看用 `de_coi_status` / GUI 任务详情拉完整输出
- **开关**：随 `coiEnabled`（默认禁用时整段不注入，零开销）

## 7. 记忆上下文注入（`injectContext` / `contextText`）

把 DSH 的记忆带给 COI，让它知道你的规则和上下文（**默认不注入**——内容会发给外部 COI 服务，注意隐私）：

- **自动注入轨**（`injectContext=true`）：长期记忆、用户档案、**本项目关键记忆**——key 按 cwd 隔离 + git 分支过滤，**与 DSH 会话注入同规则**；**不注入 AGENTS.md 全局规则**（那是 DSH 主模型的纪律，不发给外部 COI）
- **自定义文本**（`contextText`）：AI 可先查项目/今日日志，自己组织一段文本附上
- **超长处理**：注入文本 ≤ 32KB 直接内联；超过自动写入本地文件并把路径告诉 COI（AI CLI 会读文件）
- **开关粒度**：配置页「默认注入记忆上下文」（全局默认）+ 每次任务可覆盖（工具参数 / GUI 勾选 / `/de_coi run --inject-context`）
- **建议**：做项目开发时开启，让 COI 了解项目约定与上下文

## 8. 跨 COI 接力与模板

- **接力**（发起时选「接力引用」或 `refTaskId`）：把任务 A 的完整输出拼进任务 B——**可跨 COI**（如 codex 写完 → kimi review）；输出超 256KB 自动写文件+尾部预览
- **恢复会话 vs 接力**：恢复=同一 COI 同一会话的上下文延续（对方"记得"）；接力=把 A 的输出文本作为参考给 B（可跨 COI，B"看到"）
- **模板**：内置 4 个（review 代码/修复测试/总结日志/架构分析）+ 自定义，一键发起

## 9. 通知

`coiNotifyCommand`（配置页）：任务结束时执行一次，占位符 `{taskId} {coi} {status} {summary}`。
示例：`hermes send --platform weixin "COI 任务 {taskId} {status}"`（配合 hermes 网关推送微信/飞书）。

## 10. 配置项

### Host 配置（cordis.patch.yml 的 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `coiEnabled` | `false` | 模块总开关（默认禁用；运行时配置可切换） |
| `coiDataDir` | `<memoryDir>/coi` | 数据目录（适配器/会话/任务/模板/留档/导出） |
| `coiSummaryEnabled` | `true` | 任务完成自动沉淀摘要到 project/daily 记忆 |
| `coiSyncSkills` | `true` | 启动时同步内置适配器技能到技能库（源头在插件） |
| `coiNotifyCommand` | `null` | 完成通知命令模板 |
| `coiRetentionDays` | `90` | 留档保留天数（超期自动清理） |
| `coiTaskTimeoutMs` | `43200000` | 任务默认超时（12 小时，兜底防线） |
| `coiMaxLogBytes` | `2097152` | 单任务留档上限（2 MiB） |
| `coiDefaultInjectContext` | `false` | 默认注入记忆上下文 |

### 运行时配置（「COI 调度」Tab → 配置，立即生效）

- 通知命令、任务保留天数、任务超时（小时+分钟）、默认注入记忆上下文

## 11. 命令参考（/de_coi）

```
/de_coi run "<任务>" [--coi kimi|codex|grok|hermes] [--scope temporary|session|project|global]
                 [--session <id>] [--branch <b>] [--model <m>] [--ref <taskId>] [--template <id>]
                 [--continue] [--inject-context] [--context-text <文本>]
/de_coi list [--coi <id>] [--status <s>] [--limit <n>] [--q <关键词>]
/de_coi log <taskId> [--tail <字符数>]
/de_coi stop <taskId> [--force]        # 终止需二次确认；--all 需 --force --all
/de_coi sessions [list|note <id> <备注>|rm <id>] [--scope] [--branch] [--q]
/de_coi adapters [list|show <id>|test <id>|enable <id>|disable <id>]
/de_coi stats
/de_coi templates list
/de_coi export <sessionId> [--coi <id>]
/de_coi help
```

## 12. 工具参考（AI 可调用）

| 工具 | 用途 |
|---|---|
| `de_coi_dispatch` | 派任务（description 自带当前可用适配器及适用场景；支持会话恢复/接力/记忆注入） |
| `de_coi_adapters` | 查询可用适配器、适用场景与启用状态（派单前不确定时先查） |
| `de_coi_status` | 查任务状态/输出摘要/会话 id |
| `de_coi_wait` | 阻塞等待任务完成（同步拿结果） |
| `de_coi_cancel` | 终止任务 |

## 13. 常见问题

- **任务一直 running 不动？** 看详情「最后输出时间」：AI 代理思考中长时间无输出属正常；超过 12 小时自动强杀。异常卡死可手动终止（终止需确认）。
- **某个 COI 用不了了？** 适配器页直接禁用——AI 派单会被拒绝并提示换用其他项。
- **AI 不知道调哪个 CLI？** dispatch 的说明自带场景；不确定时它会先查 `de_coi_adapters`。
- **记忆会发给外部？** 默认不注入；注入时 GUI 有明确提示，敏感任务请斟酌。
- **重启后 COI 不见了？** `coiEnabled` 默认禁用，去「记忆技能待办」→ 运行时配置打开；历史任务数据都在。
