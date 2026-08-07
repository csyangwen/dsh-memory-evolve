---
name: codex-cli-calling
x-provider: dsh-memory-evolve
x-version: 1
description: "Use when the user wants to invoke Codex directly from a terminal without opening the interactive TUI, including one-shot tasks, repository edits, shell scripts, stdin pipelines, CI/automation, structured JSON output, or resuming a non-interactive session. Covers `codex exec`, working-directory and sandbox selection, output capture, JSONL/schema output, and safe automation. 触发场景：用户询问如何在 CLI/命令行里直接调用 Codex 做事、非交互执行任务、脚本或管道调用 Codex、让 Codex 自动修改项目、获取机器可读结果。"
---
<!-- 本技能由 dsh-memory-evolve 插件（COI 调度模块）内置提供：源头随插件升级同步，禁用请到「技能管理」Tab -->


# 在 CLI 里直接调用 Codex 做事

## 核心原则

使用 `codex exec` 运行非交互任务。根据用户的具体任务给出一条可直接复制的主命令，再按需补充管道、结构化输出或续接会话方案。

先以本机版本为准核对参数：

```bash
codex --version
codex exec --help
```

## 快速调用

在当前 Git 仓库中执行只读分析：

```bash
codex exec "分析这个项目，并列出最需要修复的三个问题"
```

允许 Codex 修改当前项目：

```bash
codex exec --sandbox workspace-write "修复测试失败，运行相关测试验证，只修改必要文件"
```

指定工作目录：

```bash
codex exec -C /path/to/project --sandbox workspace-write "实现用户登录功能并运行测试"
```

默认优先使用最小权限。只读任务省略 `--sandbox`；需要改文件时使用 `--sandbox workspace-write`。不要把已弃用的 `--full-auto` 写入新脚本。

## 选择输入方式

直接把任务作为参数传入：

```bash
codex exec "总结最近 10 个提交并生成发布说明"
```

把命令输出作为附加上下文传给固定指令：

```bash
npm test 2>&1 | codex exec "分析失败原因，提出最小修复方案"
```

让 stdin 成为完整提示词：

```bash
codex exec - < prompt.txt
```

当提示词参数和管道输入同时存在时，把提示词视为指令，把 stdin 视为额外上下文。大段日志或文件内容优先走 stdin，避免塞进 shell 参数。

## 获取输出

普通模式把进度写到 stderr，只把最终回答写到 stdout，因此可以安全捕获最终结果：

```bash
result=$(codex exec --ephemeral "用一句话概括这个仓库")
```

把最终回答另存为文件：

```bash
codex exec -o result.md "生成本项目的发布说明"
```

需要完整事件流时使用 JSONL：

```bash
codex exec --json "检查仓库中的高风险改动" | jq
```

需要稳定的机器可读最终结果时，准备 JSON Schema 并使用：

```bash
codex exec --output-schema ./schema.json -o ./result.json "提取项目元数据"
```

只关心最终回答时优先普通 stdout 或 `-o`；只有下游确实需要工具调用、文件变更和状态事件时才使用 `--json`。

## 继续上一次任务

继续最近一次非交互会话：

```bash
codex exec resume --last "根据刚才的检查结果实施修复并运行测试"
```

继续指定会话：

```bash
codex exec resume <SESSION_ID> "继续完成剩余工作"
```

不需要保留会话记录时添加 `--ephemeral`。

## 常用选项

| 选项 | 用途 |
| --- | --- |
| `-C, --cd <DIR>` | 指定主工作目录 |
| `--add-dir <DIR>` | 增加一个可写目录 |
| `--sandbox read-only` | 只读分析 |
| `--sandbox workspace-write` | 允许修改工作区 |
| `--ephemeral` | 不持久化会话 rollout 文件 |
| `--json` | 输出 JSONL 事件流 |
| `-o, --output-last-message <FILE>` | 保存最终回答 |
| `--output-schema <FILE>` | 约束最终回答为指定 JSON Schema |
| `-i, --image <FILE>` | 附加本地图片 |
| `-m, --model <MODEL>` | 为本次调用指定模型 |
| `--skip-git-repo-check` | 明确需要在非 Git 目录运行时跳过检查 |

只有在用户明确知道目标目录安全时才建议 `--skip-git-repo-check`。模型名称、可用参数和默认配置可能随 CLI 版本变化；遇到差异时以 `codex exec --help` 为准。

## 自动化与安全

- 复用本机已保存的 Codex CLI 登录；自动化环境需要独立凭据时，只把 `CODEX_API_KEY` 注入单次 `codex exec` 进程，并通过密钥管理器提供真实值。
- 不要把 API key 写入脚本、仓库、日志或命令示例中的真实占位值。
- 优先使用 `read-only` 或 `workspace-write`。仅在外部已可靠隔离且用户明确要求时考虑 `danger-full-access`。
- 不要默认建议 `--dangerously-bypass-approvals-and-sandbox`；该选项会同时跳过审批和沙箱。
- 在脚本和 CI 中让提示词明确限定任务、允许修改的范围以及验证命令。
- 在 GitHub Actions 中优先建议官方 `openai/codex-action`，不要在运行不受信任仓库代码的整个 job 中暴露 API key。

## 回答用户时

1. 识别任务是只读分析、修改项目、处理 stdin、机器消费输出还是续接会话。
2. 给出一条最短且可执行的主命令，用用户的实际目录、任务和文件名替换示例占位符。
3. 简短说明权限和输出行为；只在相关时补充其他选项。
4. 若用户要求你实际执行命令，而不只是教他使用，则在当前权限范围内执行并验证结果。
