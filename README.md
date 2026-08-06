# dsh-memory-evolve

为 DeepSeek Harness 带来「跨会话长期记忆 + 后台自我进化」能力的纯插件实现：**零核心修改、零运行时依赖**，随装随用、卸载即净。

> **📖 记忆与审查规则（功能说明）**：[docs/rules.md](docs/rules.md) —— 四层记忆如何工作、审查何时触发与产出什么、什么该记什么不该记、哪些需要你确认。README 只讲安装与配置。

## 特性

- **分层记忆（四轨）**：用户档案 · 全局事实 · 项目记忆（按工作目录隔离）· 每日日志，注入范围随层级收窄，互不污染；
- **每回合实时记录**：快照内固定提示行要求模型**每个回合结束前主动检查**并写入项目记忆/每日日志（同主题 replace 合并、程序盖准确时间戳），当天进展与项目脉络随时落盘、无需等待审查回合；可在设置面板分别关闭「每回合写入项目记忆 / 每日日志」；
- **回合内自我审查**：每 N 个用户回合，插件把一次记忆审查标记为到期，**主 LLM 在自己回合内静默执行**（提示词驱动 + `memory_review_status` 工具计数）——不再派生子代理、不重建转录，模型直接基于完整上下文审查：产出全局记忆建议（`memory_suggest`，用户确认后入库）并创建/优化技能；
- **可追溯审查**：审查在主会话内进行，天然拥有全部上下文（工具输出、推理过程、对话细节零损耗），无需摘要重建、无需深读接口；
- **技能自我进化（创建需确认）**：审查优化 `~/.agents/skills` 下已有技能（read-before-write 保护）；**新技能默认进入待确认队列**，设置面板采纳后才移入技能库（创建门槛严格：多次踩坑、难度大、后续会复用才创建）——技能注入所有会话，必须克制；
- **建议确认制**：全局记忆（用户档案/全局事实）写入需经设置面板或 `/memory_review` 确认；新技能同样需确认，杜绝无人把关的自我修改；
- **安全设计**：防漂移备份、跨进程文件锁、原子写、字符上限、提示注入扫描、禁用技能保护；
- **缓存友好**：记忆快照走 user-role 尾部消息注入（变更检测），system prompt 与历史前缀保持稳定。**只注入低频变化的全局轨**（用户档案/全局事实）——项目记忆与每日日志随每回合主动写入而变化，若注入会导致每轮追加新的上下文快照、前缀缓存命中率下降，因此它们**默认不注入**，改为按需读取 + 快照中一行**固定提示**要求模型每回合主动检查写入（提示文本固定不变，不产生新快照）。

## 分层记忆

| 层 | 内容 | 注入方式 | 写入方式 |
|---|---|---|---|
| 用户档案（`user`） | 用户是谁、偏好、沟通方式 | 每会话注入（低频变化，缓存友好） | 建议确认制（`/memory_review`） |
| 全局事实（`memory`） | 环境、工具、惯例 | 每会话注入（低频变化，缓存友好） | 建议确认制 |
| 项目记忆（`project`） | 当前项目的约定与进展 | **不注入**，按需读取（`memory` 工具，按 cwd 隔离） | 每回合主动写入（无需确认） |
| 每日日志（`daily`） | 今天做了什么 | **不注入**，按需读取（`memory` 工具） | 每回合主动写入（无需确认） |

记忆文件位置（默认 `~/.dsh/memories/`）：

```
~/.dsh/memories/
├── MEMORY.md                       # 全局事实（§ 分隔条目格式）
├── USER.md                         # 用户档案
├── SUGGESTIONS.jsonl               # 待确认建议队列
├── daily/YYYY-MM-DD.md             # 每日日志（按天分文件）
└── projects/<cwd-hash>/MEMORY.md   # 项目记忆（每个工作目录独立）
```

## 安装

```sh
mkdir -p ~/.dsh/plugins
cp -r dsh-memory-evolve ~/.dsh/plugins/
ln -s ~/.dsh/plugins/dsh-memory-evolve ~/node_modules/@dsh-local/dsh-memory-evolve
```

在 `~/.dsh/config.yaml` 追加：

```yaml
- insert:
    - id: dsh-memory-evolve
      name: '@dsh-local/dsh-memory-evolve'
      config:
        reviewEnabled: true      # 开启回合内记忆审查（默认关）
        reviewInterval: 10       # 每 10 个用户回合审查一次
```

重启 `dsh web` 即生效。卸载：删除 config.yaml 中的 insert 行 + 删除软链与目录，一切效果随插件卸载自动清理。

## 用法

### 模型侧

agent 会通过 `memory` 工具读写记忆，通过 `skill_manage` 工具管理技能。用户也可以直接说"记住 XXX"。

`memory` 工具参数：`action`（add / replace / remove / list）+ `target`（memory / user / project / daily）。

- `memory add target=project content=...`：写入当前项目的记忆；
- `memory list target=daily`：查看今日日志；
- replace/remove 用唯一子串片段匹配。

### Web 设置面板（推荐）

`dsh web` 左下角设置 → **记忆管理**：

- **待确认建议**：列出全部待确认建议，**采纳前可编辑文本**（修改后再入库），逐条「采纳 / 拒绝」或批量处理（设置入口的导航行会显示 `记忆管理 (N)` 数字徽标）；
- **待确认技能**：审查创建的新技能在此「采纳」（移入技能库，立即生效）或「拒绝」；
- **运行时配置**：`reviewEnabled` / `reviewInterval` / `reviewMode` / `skillReviewEnabled` / `memoryTabEnabled` 的表单修改，保存后**立即生效并持久化**（覆盖 config.yaml 对应项，重启不丢）；
- **打开文件**：一键用系统工具打开记忆目录 / 全局记忆 / 用户档案 / 今日日志 / 项目记忆目录 / 技能目录。

![设置 → 记忆管理](docs/images/设置-记忆管理.png)

### 会话页记忆 Tab（可选）

开启「会话页记忆 Tab」（配置 `memoryTabEnabled`，默认关，开启后刷新页面生效）后，会话页顶部出现「记忆」标签页：直接预览 AGENTS.md 与四轨记忆文件（**全部只读**——编辑请通过 memory 工具或用系统工具打开文件，避免破坏 § 分隔格式），每行可一键用系统工具打开。

![会话页记忆 Tab](docs/images/记忆tab.png)

### 用户侧命令


```
/memory_review                  # 列出待确认建议（带序号）
/memory_review approve 1 3      # 采纳第 1、3 条（写入对应记忆文件）
/memory_review reject 2         # 拒绝第 2 条
/memory_review approve-all      # 全部采纳
/memory_review reject-all       # 全部拒绝
```

### 回合内记忆审查

- **触发**：插件统计每个会话的用户回合数（`agent/settled` 计数，仅 message 回合；子代理会话不计数）；达到 `reviewInterval` 后，一次审查被标记为**到期**；
- **执行**：快照携带固定提示段，要求模型每个回合结束前调用 `memory_review_status` 查询是否到期；**到期判断以工具返回的 `due` 为准**（间隔不写死在提示里）。到期时模型在自己的回合内**静默执行审查**（工具操作，不写进最终回复）：
  - 全局记忆（memory/user）：对照快照中已注入的全局记忆**查重**，仅建议**稳定、可跨会话复用**的新事实 → `memory_suggest` 提出（最多 2 条，宁缺毋滥）；`reviewMode=auto` 时直接用 `memory` 工具写入；
  - 技能：确有可复用经验 → `skill_manage` 先 list 查重 → read → create/patch（每轮最多 1 次操作；create 默认进待确认队列）；
  - 完成后调用 `memory_review_status complete` **复位计数**；
- **到期不清零**：计数只增不清——若某回合模型未执行（弱遵循/被打断），下回合仍是到期状态，审查不会静默丢失；只有 `complete` 才复位；
- **职责边界**：project/daily 由主会话**每回合主动写入**（见「分层记忆」表），审查只处理全局轨建议与技能；
- **依赖**：审查由**提示词驱动**，依赖模型的指令遵循能力——弱遵循模型可能不查/不执行（见「已知局限」）。

审查产出（建议与技能）在会话列表中不可见（没有子代理），但建议队列与技能库可在设置面板查看/确认。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `memoryDir` | `~/.dsh/memories` | 记忆目录 |
| `memoryCharLimit` | 2200 | 全局事实字符上限 |
| `userCharLimit` | 1375 | 用户档案字符上限 |
| `dailyCharLimit` | 16000 | 每日日志字符上限 |
| `projectCharLimit` | 2200 | 项目记忆字符上限 |
| `perTurnProjectWrites` | `true` | 每回合写入项目记忆：要求模型每个回合结束前主动检查并记录项目相关新事实；关 = 项目记忆仅按需读取 |
| `perTurnDailyWrites` | `true` | 每回合写入每日日志：要求模型每个回合结束前主动检查并记录当天进展；关 = 每日日志仅按需读取 |
| `entryDatePrefix` | `true` | 记忆条目自动加时间前缀：全局轨 `[YYYY-MM-DD]`、项目轨 `[YYYY-MM-DD HH:MM]`、每日日志 `[HH:MM]` |
| `injectMemory` | `true` | 记忆快照注入开关（只注入低频变化的全局轨 + 一行按需提示；项目/每日内容按需读取，不注入） |
| `injectionScan` | `true` | 写入内容的提示注入短语扫描 |
| `toolName` | `memory` | 记忆工具名 |
| `skillDir` | `~/.agents/skills` | 技能写入目录（DSH 技能库） |
| `skillManageToolName` | `skill_manage` | 技能管理工具名 |
| `skillMaxBytes` | 65536 | SKILL.md 大小上限 |
| `skillReviewEnabled` | `false` | 技能自动沉淀：关（默认）= 所有新技能（含审查创建）进待确认队列；开 = 直接创建无需确认 |
| `reviewEnabled` | `false` | 回合内审查总开关（提示段 + 回合计数） |
| `reviewInterval` | 5 | 每 N 个用户回合将一次审查标记为到期 |
| `reviewMode` | `suggest` | `suggest`（推荐）= 全局事实只产建议，经你确认后入库；`auto` = 审查直接写入全局轨，无需确认（注意提示注入风险） |
| `memoryTabEnabled` | `false` | 会话页「记忆」Tab 开关：开启后会话页顶部可查看记忆文件（全部只读）；默认关，开启后刷新页面生效 |

## 安全设计

- **分层隔离**：全局记忆（每会话注入）是高风险面——suggest 模式下自动写入被拒（含子代理），只走建议确认；项目记忆按 cwd 硬隔离（A 项目会话看不到 B 项目记忆，且内容不注入、仅按需读取）；每日日志不注入；
- **read-before-write**：`skill_manage` 优化已有技能前，必须先在会话日志中证明 `read` 过（防凭空改写他人技能）；
- **禁用技能保护**：写入前查 DSH 核心技能注册表的 `modelInvocable` 状态，禁用的技能不更新；
- **防数据丢失**：文件无法被解析器往返时拒绝重写并备份 `.bak.<时间戳>`；字符上限硬拒绝；跨进程锁 + 原子写；
- **提示注入防护**：写入内容扫描"忽略指令"类短语；技能 frontmatter 做 YAML 兼容性校验（description 需双引号，防 DSH 解析器静默跳过）；
- **审查不递归**：子代理会话不计入审查回合数（审查只发生在主会话）；
- **缓存友好**：快照变更走尾部追加，不破坏 system prompt 前缀缓存；
- **可关停**：全部注册都是 fiber effect，卸载插件即完全恢复原状。

## 工作原理

```
用户会话进行中（每回合）
  ├─ 结束前：模型主动检查并写入 project/daily（memory 工具；无新事实则跳过）
  └─ 结束前：模型调用 memory_review_status check 查询审查是否到期
       ├─ 未到期（due=false）→ 正常结束回合
       └─ 到期（due=true）→ 回合内静默审查（不写进回复）：
            ├─ 全局记忆建议 → memory_suggest → SUGGESTIONS.jsonl → 用户 /memory_review 或面板确认 → 写入
            ├─ 技能 → skill_manage 创建/优化 ~/.agents/skills（create 默认进待确认队列）
            └─ memory_review_status complete 复位计数
  快照注入：仅低频变化的全局轨 + 每回合主动写入提示行 + 审查提示段（均为静态文本）；项目/每日按需读取
```

## 已知局限

### 缓存命中

本插件对 LLM 前缀缓存的优化是**尽力而为，并未彻底解决**：

- **已做**：快照只注入低频变化的轨（全局记忆/用户档案）与静态提示段，项目记忆与每日日志内容不注入——它们随每回合主动写入而变化，若注入会导致请求结尾频繁出现新内容；
- **未解决**：DSH 的运行时上下文是 **append-only 的 user-role 尾部快照**（`Current runtime context…`），无法原地更新。因此**任何**快照内容变化——例如用户确认一条新建议、直接 `memory add` 写入全局轨——都会向请求历史**追加一条新的尾部消息**：该新增尾部无法命中缓存，且历史中的旧快照会持续占位、随写入次数增多而堆积。**前缀部分（system 指令、工具说明、AGENTS.md、此前对话）不受影响、照常命中缓存**——代价只在新尾部本身；
- 这是 DSH 核心 context 机制的固有设计，插件层面无法替换历史快照；若未来 DSH 支持可原地更新的上下文（或 system-role 稳定注入），本插件可直接受益。

### 指令遵循依赖

「每回合写入 project/daily」与「回合内自我审查」都由**快照提示段驱动**——插件只负责计数与到期标记，执行依赖模型的指令遵循能力：

- 弱遵循模型可能跳过每回合检查、到期后不查询或不执行审查；
- **到期不清零**缓解"漏一轮"（下回合仍到期），但救不了"从不查"；
- 若发现模型不执行，可调低 `reviewInterval` 提高到期频率，或检查是否使用了弱遵循模型。

## 测试

```sh
cd dsh-memory-evolve && node --test 'tests/*.test.js'
```

## License

MIT
