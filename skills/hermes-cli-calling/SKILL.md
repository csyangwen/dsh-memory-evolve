---
name: hermes-cli-calling
x-provider: dsh-memory-evolve
x-version: 1
description: "Use when the user wants to invoke Hermes Agent from the command line without entering the interactive TUI — one-shot queries, scripting/piping, non-interactive task execution. Covers hermes chat -q / hermes -z, common flags (-Q, --max-turns, -t, -s, -m, --image, --yolo, -c/--resume), pipe usage, and alternative non-interactive surfaces (cron, send, proxy, acp). 触发场景:用户在命令行直接让 Hermes 干活、不进交互界面、写脚本调用、管道传参、定时任务。"
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [hermes, cli, oneshot, scripting, non-interactive]
---
<!-- 本技能由 dsh-memory-evolve 插件（COI 调度模块）内置提供：源头随插件升级同步，禁用请到「技能管理」Tab -->


# 在 CLI 里直接调用 Hermes 做事(不进 TUI)

## 何时用
- 用户想不进入交互式 TUI,直接在终端让 Hermes 干活
- 脚本 / 管道 / CI 里调用 Hermes
- 单次提问快速拿结果,不想要会话界面

## 核心命令

```bash
hermes chat -q "你的问题"     # 单次查询,带完整工具权限(可动文件、跑命令、上网)
hermes -z "你的问题"          # oneshot:只打印最终回答,适合脚本和管道
```

区别:`chat -q` 输出包含过程信息(工具调用等),`-z` 只输出最终答案。
演示验证:`hermes chat -q "1+1" -Q` → 直接打印结果,不进任何界面。

## 常用参数(可组合)

| 参数 | 作用 |
|---|---|
| `-Q` | 安静模式,隐藏 banner/spinner,输出更干净 |
| `--max-turns N` | 限制工具调用轮数(简单问题建议 3,防跑偏) |
| `-t 工具集` | 指定工具集,如 `-t terminal,file`(默认全开) |
| `-s 技能名` | 预加载技能,如 `-s plan`(可逗号分隔多个) |
| `-m 模型 --provider 提供方` | 本次调用临时换模型 |
| `--image 图片路径` | 单次查询附加本地图片 |
| `--yolo` | 跳过危险命令审批(慎用) |
| `-c` / `--resume 会话ID` | 接着之前的会话继续干 |
| `-p 档案名` | 用指定 profile 运行 |

## 管道 / 脚本用法

```bash
echo "总结这个文件" | hermes chat -q "$(cat 文件)"
hermes -z "把这堆日志分类" < error.log
cat code.py | hermes -z "帮我 review 这段代码" -t terminal,file
# 在脚本里拿返回值:
RESULT=$(hermes -z "生成一个 UUID")
```

## 其他非交互方式(不需要"对话"也能让它干活)

```bash
hermes cron create "0 9 * * *" "每天早上总结我的待办"   # 定时任务
hermes send --platform weixin "文本"                    # 通过网关直接发消息
hermes proxy                                            # OpenAI 兼容本地代理,任何程序可调
hermes acp                                              # ACP 服务,IDE 集成
hermes chat -q "..." &                                  # 后台跑长任务(配合 nohup 或 tmux)
```

## 验证

```bash
hermes chat -q "用一句话介绍你自己" -Q --max-turns 3
# 预期:几秒内直接打印一句话答案,无交互界面
```

## 陷阱 / 注意事项
- 默认加载全部工具;简单问题加 `--max-turns 3` 防止它做多余的事。
- `-Q` 只隐藏装饰输出,不影响工具执行和最终结果。
- 长任务(几分钟级)用后台运行或 cron,别在前台干等;前台超时上限 600s。
- `-z` 只打印最终答案,想调试工具调用过程改用 `chat -q`。
- 管道输入时避免把大文件整段塞进命令行参数(超长会截断),先让 Hermes 读文件路径。
- 会话是独立的;要用之前的上下文加 `-c` / `--resume`,否则它不记得上次的事。
