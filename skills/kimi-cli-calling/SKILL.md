---
name: kimi-cli-calling
x-provider: dsh-memory-evolve
x-version: 1
description: Use when the user wants to invoke Kimi Code CLI from the command line without entering the interactive TUI — one-shot queries, scripting/piping, non-interactive task execution. Covers `kimi -p` prompt mode, --output-format, -m model override, -c/--session resume, --skills-dir/--agent/--add-dir/--plan, and subcommands (acp, web, export, login, doctor, vis, upgrade). 触发场景:用户在命令行直接让 Kimi 干活、不进交互界面、写脚本调用、管道传参、非交互调用 kimi。
---
<!-- 本技能由 dsh-memory-evolve 插件（COI 调度模块）内置提供：源头随插件升级同步，禁用请到「技能管理」Tab -->


# 在 CLI 里直接调用 Kimi Code 做事(不进 TUI)

## 何时用
- 用户想不进入交互式 TUI,直接在终端让 Kimi 干活
- 脚本 / 管道 / CI / 定时任务里调用 Kimi
- 单次提问快速拿结果,不想要会话界面

## 核心命令

```bash
kimi -p "你的问题或任务"     # prompt 模式:跑一条 prompt,非交互打印结果后退出
```

实测:输出 = 过程摘要(`•` 开头的要点行) + 最终回答 + 末尾一行 `To resume this session: kimi -r session_xxx`(无需处理)。

## 常用参数(可组合)

| 参数 | 作用 |
|---|---|
| `--output-format stream-json` | prompt 模式的结构化流式输出(默认 `text`),适合程序解析 |
| `-m 模型别名` | 本次调用临时换模型(默认用 config.toml 的 default_model) |
| `-c, --continue` | 接着当前工作目录的上一个会话继续干 |
| `-S [id], --session [id]` | 恢复指定会话(不带 id 则交互选择) |
| `--skills-dir <dir>` | 只从指定目录加载技能(可重复),替代自动发现的技能目录 |
| `--agent <名>` / `--agent-file <md>` | 用指定 agent profile 启动新会话 |
| `--add-dir <dir>` | 给本会话增加工作目录(可重复) |
| `--plan` | 以 plan 模式启动 |

## 管道 / 脚本用法

```bash
cat error.log | kimi -p "把这些日志分类总结"
RESULT=$(kimi -p "生成一个 UUID,只输出 UUID 本身")
kimi -p "review 这段代码:请读取文件 /path/to/code.py"   # 大文件给路径,别塞进参数
```

## 陷阱 / 注意事项

1. **prompt 必须跟在 `-p` 后面,不能作为裸位置参数传。** 直接 `kimi "帮我干活"` 会把第一个位置参数当子命令解析,报 `unknown command`。正确:`kimi -p "帮我干活"`。
2. **`-p` 不能和 `-y/--yolo`、`--auto` 组合**,会报 `Cannot combine --prompt with --auto`。prompt 模式直接裸跑即可,不需要权限标志。
3. **kimi 需要可写 `~/.kimi-code/`**(每次运行都会写会话目录)。在受限沙箱里调用要提权到全权限,否则报 `EPERM: mkdir '~/.kimi-code/sessions/...'`;不要用 XDG_DATA_HOME 等环境变量重定向,硬编码路径,重定向无效。
4. **会话默认独立。** 想要上次上下文,用 `-c` 或 `-S session_xxx`(每次运行末尾会打印可恢复的 session id)。
5. **大文件别整段塞进命令行参数**(超长会截断),让 kimi 自己读文件路径。
6. 识图类任务(读截图/照片内容)直接用本方式即可——在 prompt 里写明图片绝对路径,kimi 会调用读图工具;详见 `kimi-image-recognition` skill。
7. **执行/思考时间可能特别长,请耐心等待。** kimi 是完整 agent,一条 prompt 可能触发多轮思考、读文件、跑命令,耗时从几十秒到几分钟不等,属于正常现象——不要因为长时间无输出就判定失败或杀掉进程。调用方请设足超时(简单问题 120s 起,复杂任务建议 600s 以上或放后台跑),等待命令自然退出后读取输出即可。

## 其他非交互入口

```bash
kimi acp                  # ACP server(stdio),供 IDE / Zed 等客户端接入
kimi web                  # 本地 Web GUI
kimi export [sessionId]   # 把会话导出为 ZIP
kimi login                # device-code 登录
kimi doctor               # 校验配置文件
kimi vis [sessionId]      # 浏览器里可视化某个会话
kimi upgrade              # 升级到最新版
```

## 验证

```bash
kimi -p "只回答数字:1+1 等于几?"
# 预期:几秒内打印答案 2(前面可能带 `•` 过程行),随后退出回到 shell
```
