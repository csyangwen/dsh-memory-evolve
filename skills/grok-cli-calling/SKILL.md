---
name: grok-cli-calling
x-provider: dsh-memory-evolve
x-version: 1
description: Use when the user wants to invoke the Grok CLI from the command line without entering the interactive TUI — one-shot quick queries, scripting/piping, non-interactive task execution, structured JSON output, or resuming a session. Covers `grok -p/--single` prompt mode, --output-format, --json-schema, -m model override, -c/--continue and -r/--resume, --permission-mode/--sandbox, and subcommands (agent, sessions, export, memory, mcp, plugin, doctor, login). 触发场景：用户在命令行直接让 Grok 干活、不进交互界面、快速一次性提问、写脚本调用、管道传参、非交互调用 grok。
---
<!-- 本技能由 dsh-memory-evolve 插件（COI 调度模块）内置提供：源头随插件升级同步，禁用请到「技能管理」Tab -->


# 在 CLI 里直接调用 Grok 干活（不进 TUI）

## 何时用

- 用户想不进入交互式 TUI，直接在终端让 Grok 干活
- 快速一次性提问（Grok 的特点就是快，前端后端都能干）
- 脚本 / 管道 / CI / 定时任务里调用 Grok
- 需要结构化 JSON 输出的机器可读场景

## 核心命令

```bash
grok -p "你的问题或任务"     # 单轮 prompt 模式：跑一条 prompt，打印回答到 stdout 后退出
```

实测：输出就是最终回答本身，简洁直接，无多余装饰（快速验证：`grok -p "只回答数字：1+1等于几？"` → `2`）。

## 常用参数（可组合）

| 参数 | 作用 |
|---|---|
| `--output-format <格式>` | 输出格式：`plain`（默认，纯回答）/ `json` / `streaming-json`（NDJSON 流式会话更新）/ `streaming-messages-json`（Anthropic Messages 格式 NDJSON），适合程序解析 |
| `--json-schema '<SCHEMA>'` | 约束模型输出为符合该 JSON Schema 的 JSON（隐含 `--output-format json`），如 `--json-schema '{"type":"object","properties":{"name":{"type":"string"}}}'` |
| `-m, --model <模型>` | 本次调用临时换模型（默认 `grok-4.5`，用 `grok models` 查看可用列表） |
| `--reasoning-effort <级别>` | 推理模型的思考强度 |
| `-c, --continue` | 接着当前工作目录最近一次会话继续干 |
| `-r, --resume [id或标题]` | 恢复指定会话（按 ID 或标题匹配；不带参数恢复最近一次） |
| `--fork-session` | 恢复时新建会话 ID 而不是复用原会话（可与 `--resume` 组合） |
| `--permission-mode <模式>` | 权限模式：`default` / `acceptEdits`（自动接受文件编辑）/ `auto` / `dontAsk` / `bypassPermissions` / `plan` |
| `--sandbox <PROFILE>` | 文件系统与网络访问沙箱配置（也可用环境变量 `GROK_SANDBOX`） |
| `--always-approve` | 自动批准所有工具执行 |
| `--max-turns <N>` | 限制最大 agent 轮数 |
| `--tools <列表>` / `--disallowed-tools <列表>` | 允许 / 移除内建工具（逗号分隔） |
| `--allow <RULE>` / `--deny <RULE>` | 权限允许 / 拒绝规则（兼容 `--allowedTools` / `--disallowedTools`） |
| `--rules <RULES>` | 追加额外规则到系统提示词 |
| `--agent <NAME>` | 使用指定 agent 配置 |
| `--prompt-file <PATH>` | 从文件读取单轮 prompt（长任务文案放文件，避免 shell 转义地狱） |
| `--no-plan` / `--no-subagents` / `--no-memory` | 禁用计划模式 / 子代理 / 跨会话记忆 |
| `--experimental-memory` | 启用跨会话记忆 |
| `--cwd <DIR>` | 指定工作目录 |
| `--disable-web-search` | 禁用网页搜索与抓取工具 |

## 管道 / 脚本用法

```bash
cat error.log | grok -p "把这些日志分类总结"
RESULT=$(grok -p "生成一个 UUID，只输出 UUID 本身")
grok -p "review 这段代码：请读取文件 /path/to/code.py"   # 大文件给路径，别塞进参数
grok --json-schema '{"type":"object","properties":{"issue":{"type":"string"},"fix":{"type":"string"}},"required":["issue","fix"]}' -p "分析这个报错并给出修复" | jq .
```

## 陷阱 / 注意事项

1. **需要先登录。** 未登录时调用会直接失败（`grok models` 会提示 `You are not authenticated`）。登录用 `grok login`（本地 `--oauth`，无头/远程环境 `--device-auth`）。`grok doctor` 可体检终端/配置状态。
2. **`-p` 是单轮模式，会话默认独立。** 想要延续上次上下文，用 `-c`（继续最近会话）或 `-r <id>`（恢复指定会话，标题也支持，大小写不敏感）。`grok sessions list` / `grok sessions search <关键词>` 可查找历史会话。
3. **大文件别整段塞进命令行参数**（超长会截断），让 Grok 自己读文件路径；长 prompt 用 `--prompt-file`。
4. **权限模式按需选择。** 只读分析用默认模式即可；需要改文件时用 `--permission-mode acceptEdits` 或 `--sandbox workspace-write` 类配置；`bypassPermissions` 全放行要谨慎，仅在明确需要时使用。
5. **执行时间：Grok 以快著称，但它是完整 agent**，复杂任务（读文件、跑命令、多轮思考）仍可能耗时数十秒到几分钟。调用方请设足超时（简单问题 60s 起，复杂任务 300s 以上或放后台跑），不要因短暂无输出就判定失败。
6. **输出格式选择。** 只关心最终回答用默认 `plain`（stdout 干净）；需要事件流/增量输出用 `streaming-json`；需要严格结构用 `--json-schema`。

## 其他非交互入口

```bash
grok agent stdio       # ACP/stdio 模式，供 IDE、Zed 等客户端接入
grok agent headless    # 通过 Grok WebSocket relay 无头运行
grok agent serve       # 以 WebSocket server 运行
grok sessions list     # 列出最近会话
grok sessions search <关键词>   # 搜索会话
grok sessions delete <id>      # 删除会话
grok export            # 将会话导出为 Markdown
grok memory            # 管理跨会话记忆
grok mcp               # 管理 MCP server 配置
grok plugin            # 管理插件与市场源
grok models            # 列出可用模型
grok login / logout    # 登录 / 登出
grok inspect           # 查看当前目录发现的配置
grok worktree          # 管理 git worktree
grok wrap <命令>       # 运行命令并支持本地剪贴板（OSC 52）
grok update            # 检查更新或安装指定版本
```

## 验证

```bash
grok -p "只回答数字：1+1等于几？"
# 预期：几秒内直接打印 2，随后退出回到 shell
```
