# dsh-memory-evolve

为 DeepSeek Harness 带来 Hermes 式「记忆 + 自我进化」能力的纯插件实现：**零核心修改、零运行时依赖**，随装随用、卸载即净。

## 特性

- **分层记忆（四轨）**：用户档案 · 全局事实 · 项目记忆（按工作目录隔离）· 每日日志，注入范围随层级收窄，互不污染；
- **后台审查**：每 N 个用户回合自动回顾会话，产出记忆建议、追加项目/每日记忆，并自动创建/优化技能；支持 `/memory_now` 手动触发与会话关闭终局补审；
- **技能自我进化**：审查子代理自动创建/优化 `~/.agents/skills` 下的技能（read-before-write 保护，DSH 与 Hermes 双向可用）；
- **建议确认制**：全局记忆（用户档案/全局事实）写入需经 `/memory_review` 确认，杜绝无人把关的自我修改；
- **安全设计**：防漂移备份、跨进程文件锁、原子写、字符上限、提示注入扫描、禁用技能保护；
- **缓存友好**：记忆快照走 user-role 尾部消息注入（变更检测），system prompt 与历史前缀保持稳定，不影响 LLM 前缀缓存。

## 分层记忆

| 层 | 内容 | 注入方式 | 写入方式 |
|---|---|---|---|
| 用户档案（`user`） | 用户是谁、偏好、沟通方式 | 每会话注入 | 建议确认制（`/memory_review`） |
| 全局事实（`memory`） | 环境、工具、惯例 | 每会话注入 | 建议确认制 |
| 项目记忆（`project`） | 当前项目的约定与进展 | 仅当前工作目录的会话注入（按 cwd 隔离，项目间互不可见） | 后台自动沉淀 |
| 每日日志（`daily`） | 今天做了什么 | 不注入，仅一行摘要 + 按需读取 | 后台自动沉淀 |

记忆文件位置（默认 `~/.dsh/memories/`）：

```
~/.dsh/memories/
├── MEMORY.md                       # 全局事实（§ 分隔条目，与 Hermes 格式兼容）
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
        reviewEnabled: true      # 开启后台审查（默认关）
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

- **待确认建议**：列出全部待确认建议，逐条「采纳 / 拒绝」或批量处理（设置入口的导航行会显示 `记忆管理 (N)` 数字徽标）；
- **运行时配置**：`reviewEnabled` / `reviewInterval` / `reviewMode` / `skillReviewEnabled` / `injectProjectMemory` / `injectDailySummary` 的表单修改，保存后**立即生效并持久化**（覆盖 config.yaml 对应项，重启不丢）。

### 用户侧命令


```
/memory_review                  # 列出待确认建议（带序号）
/memory_review approve 1 3      # 采纳第 1、3 条（写入对应记忆文件）
/memory_review reject 2         # 拒绝第 2 条
/memory_review approve-all      # 全部采纳
/memory_review reject-all       # 全部拒绝
/memory_now                     # 立即对当前会话触发一次后台审查
```

### 后台审查

- 触发：每 `reviewInterval` 个用户回合（`agent/settled` 计数，仅 message 回合）；会话关闭时未审查过的会话自动补一次终局审查；`/memory_now` 可随时手动触发；
- 执行：派生一个受限子代理（工具白名单：`memory` / `memory_suggest` / `skill_manage`），从会话日志尾部重建只读转录，同时产出：
  - 全局记忆建议 → `memory_suggest` → 建议队列（等用户确认）；
  - 项目/每日记忆 → `memory` 工具直接写入（隔离层自动沉淀）；
  - 技能 → `skill_manage` 自动创建/优化 `~/.agents/skills` 下的技能；
- 并发：同时最多一个审查；异步执行不阻塞主流程；`origin: 'subagent'` 的会话永不触发（防递归）。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `memoryDir` | `~/.dsh/memories` | 记忆目录 |
| `memoryCharLimit` | 2200 | 全局事实字符上限 |
| `userCharLimit` | 1375 | 用户档案字符上限 |
| `dailyCharLimit` | 8000 | 每日日志字符上限 |
| `projectCharLimit` | 2200 | 项目记忆字符上限 |
| `entryDatePrefix` | `true` | 记忆条目自动加 `[YYYY-MM-DD]` 日期前缀（每日日志为 `[HH:MM]`） |
| `hermesMemoriesDir` | `null` | Hermes 记忆只读注入（可选开启，默认关闭） |
| `injectMemory` | `true` | 记忆快照注入开关 |
| `injectProjectMemory` | `true` | 快照注入当前项目记忆 |
| `injectDailySummary` | `true` | 快照注入"今日已记录 N 条"摘要 |
| `injectionScan` | `true` | 写入内容的提示注入短语扫描 |
| `toolName` | `memory` | 记忆工具名 |
| `skillDir` | `~/.agents/skills` | 技能写入目录（DSH 与 Hermes 共同扫描） |
| `skillManageToolName` | `skill_manage` | 技能管理工具名 |
| `skillMaxBytes` | 65536 | SKILL.md 大小上限 |
| `skillReviewEnabled` | `true` | 审查子代理的技能轨开关 |
| `reviewEnabled` | `false` | 后台审查总开关 |
| `reviewInterval` | 10 | 每 N 个用户回合审查一次 |
| `reviewDigestEvents` | 24 | 回放日志尾部事件数 |
| `reviewDigestMaxChars` | 12000 | 回放转录长度上限 |
| `reviewDigestIncludeToolOutput` | `false` | 转录是否含工具输出（隐私） |
| `reviewProvider` / `reviewModel` | 空（主模型） | 审查用模型 |
| `reviewMode` | `suggest` | `suggest`=全局记忆只产建议；`auto`=直接写（每次写前请求批准） |
| `reviewFinalOnDispose` | `true` | 会话关闭时未审查会话自动补审 |
| `reviewNowCommandName` | `memory_now` | 手动触发审查的命令名 |
| `reviewProviderName` | `spawn` | 审查子代理提供者 |

## 安全设计

- **分层隔离**：全局记忆（每会话注入）是高风险面——自动写入被拒，只走建议确认；项目记忆按 cwd 硬隔离（A 项目会话看不到 B 项目记忆）；每日日志不注入全文；
- **read-before-write**：`skill_manage` 优化已有技能前，必须先在会话日志中证明 `read` 过（防凭空改写他人技能）；
- **禁用技能保护**：写入前查 DSH 核心技能注册表的 `modelInvocable` 状态，禁用的技能不更新；
- **防数据丢失**：文件无法被解析器往返时拒绝重写并备份 `.bak.<时间戳>`；字符上限硬拒绝；跨进程锁 + 原子写；
- **提示注入防护**：写入内容扫描"忽略指令"类短语；技能 frontmatter 做 YAML 兼容性校验（description 需双引号，防 DSH 解析器静默跳过）；
- **防递归**：审查子代理（subagent 会话）永不触发审查；
- **缓存友好**：快照变更走尾部追加，不破坏 system prompt 前缀缓存；
- **可关停**：全部注册都是 fiber effect，卸载插件即完全恢复原状。

## 工作原理

```
用户会话进行中
  └─ 每 reviewInterval 个用户回合（agent/settled 计数）或会话关闭补审或 /memory_now
       └─ 从会话日志尾部重建只读转录（最多 reviewDigestEvents 条事件）
            └─ 派生受限子代理（白名单：memory / memory_suggest / skill_manage；origin=subagent 不触发审查）
                 ├─ 全局记忆建议 → SUGGESTIONS.jsonl → 用户 /memory_review 确认 → 写入
                 ├─ 项目/每日记忆 → memory 工具直接写入（隔离层）
                 └─ 技能 → skill_manage 自动创建/优化 ~/.agents/skills
                      └─ 快照注入（全局 + 当前项目 + 今日摘要）随上下文刷新，模型可见
```

## 测试

```sh
cd dsh-memory-evolve && node --test 'tests/*.test.js'
```

## License

MIT
