---
name: memory-consolidate
x-provider: dsh-memory-evolve
x-version: 2
description: "Use when the user asks to consolidate, merge, deduplicate, or reorganize accumulated dsh-memory-evolve memories (global long-term memory, user profile, project key facts), or when a periodic memory review should run a full consolidation pass. Covers supersede-keep-newest, similar-entry merging, literal dedup, conflict resolution, project-local archiving, stale-state cleanup, and cross-track relocation, all with archive-based reversibility. 触发场景：用户要求梳理/合并/去重/整理记忆（长期记忆、用户档案、项目 key），记忆条目重复记录、新旧版本并存、表述相近却分散多条，或记忆审查到期需要一次系统性整合归档。"
---
<!-- 本技能由 dsh-memory-evolve 插件内置提供：源头随插件升级同步，禁用请到「技能管理」Tab -->

# 记忆合并梳理（memory-consolidate）

让 dsh-memory-evolve 的记忆保持「一事一条、最新为准、可溯可逆」：把随时间累积出的
重复条目、新旧并存版本、相近分散表述，按下面**经批准的合并标准**整合归档。

## 一、适用范围与硬边界

1. **合并对象**：全局长期记忆（`memory` 轨 / MEMORY.md）、用户档案（`user` 轨 /
   USER.md）、当前项目的 key 事实（`key` 轨 / projects/&lt;hash&gt;/KEY.md）与项目日志
   （`project` 轨）。memory 工具的 project/key 轨按会话工作目录隔离——**本技能在哪个
   项目会话运行，就只能执行该项目的轨**；其他项目的文件只会出现在预扫报告里供参考，
   其合并需到对应项目的会话再跑一遍本技能。
2. **不参与合并**：每日日志（daily 轨，编年史只追加）与待办（todo 轨，有独立工具）。
   它们只可读取，作为「哪条更新」的时间证据。
3. **只走 memory 工具**：所有写入用 memory 工具的 `replace` / `archive` / `add`
   完成。**禁止直接编辑记忆 .md 文件**——记忆文件有 § 分隔与 round-trip 规范校验
   （drift guard），外部改写会导致整个文件拒绝写入。
4. **归档优先，禁用删除**：被合并/被取代的原文一律 `archive`（进 *-archive.md，
   记忆 Tab 归档页可一键移回）。不要用 `remove`，保证每步操作可逆。
5. **key 轨写入需确认**：memory 工具对 key 轨的 `add` 走待确认队列——涉及新增 key
   条目时照常提交建议，由用户确认后生效，不要绕过。
6. **同一轨的写操作串行执行**：`replace` / `archive` / `add` 对同一个 `.md` 文件是
   读-改-写，交错执行会互相覆盖、也会撞上 drift guard。一个簇处理完再动下一个，
   不要并发写同一轨。

## 二、合并标准（逐簇裁决的依据）

对每个候选簇，按以下标准定性并执行：

| 标准 | 判定 | 动作 |
|------|------|------|
| **覆盖更新** | 新记忆覆盖旧记忆，或新旧条目是关于**同一项内容**的不同版本（明确写有「修订既有记忆 / 以…为准 / 已过时 / 取代」，或同一对象上更新的数据/结论/更晚日期） | 只保留最新版本，必要时把它改写为自足完整版；旧条目归档 |
| **相近合并** | 多条表达相同或相近内容 | 合并为**一条**完整表述，不拆分；取信息并集，数据以最新为准；合并条目必须单主题、自足 |
| **字面去重** | 内容实质相同、仅日期/措辞小异的重复记录 | 保留信息最全的一条，其余归档 |
| **冲突裁决** | 条目互相矛盾（如「X 不可用」vs「X 实测可用」） | 取**有实证、日期更新**的一方为准；被否定说法归档，保留条目内一行注明修正关系（「×旧记录：…已修正」） |
| **项目经验下沉** | 全局轨中的单项目一次性经验（对其他项目无复用价值） | 归档；全局轨只保留跨项目可复用事实 |
| **过期状态清理** | 描述已完成临时状态 / 已失效环境事实（「正在跑」「当前暂停」「待确认」已落定） | 条目内若仍有有效教训，先抽成新条目（`add`），再归档原文 |
| **跨轨归位** | 同一事实在多轨重复（全局 memory ↔ key ↔ user） | 按轨道职责归位到唯一轨道（key=每回合注入的关键事实 / memory=跨项目事实 / user=用户长期规则），其余副本归档；不丢任何一方增量信息 |

**跳过判定**（同样要给结论）：

- **保护名单**：用户明确要求保留或待用户拍板的条目（正文含「待用户确认 / 待用户拍板 /
  勿动 / 勿删」等）、待确认队列内容 → 不动，列入报告跳过项。
- **信息损失风险**：合并会丢关键数据（数字/路径/命令/来源）且无法并集保全 → 宁可不合并，
  只在报告中标记。

## 三、工作流程

### 步骤 1：预扫（优先用脚本）

脚本随本技能目录分发：`scripts/scan_memory.mjs`（与本 SKILL.md 同目录）。先定位技能
目录（技能工具加载时会给出路径；找不到时在插件安装目录 `node_modules/dsh-memory-evolve/
skills/memory-consolidate` 与用户技能根 `~/.agents/skills/memory-consolidate` 下找），
然后只读扫描：

```bash
node <技能目录>/scripts/scan_memory.mjs --dir <memoryDir> --out <工作区>/memory-consolidate-report.json
```

- `<memoryDir>` 缺省 `~/.dsh/memories`；`--threshold` 缺省 0.42（相似候选门槛）。
- 报告 JSON：候选簇（members/pairs/hint）+ 统计；`hint` 只是**建议**（supersede /
  duplicate / conflict / similar），最终定性以第二步的裁决为准。
- **脚本不可用时的回退**：用 memory 工具 `list` 分轨分批读取全部条目，由 AI 直接做
  相近判读（条目量大时按轨道与项目分组逐批处理）。

### 步骤 2：逐簇裁决

读报告，逐簇回答：这簇属于哪条标准？保留哪条？合并后的文本是什么？
产出一个简短计划（簇 → 动作 / 保留 / 归档 / 依据），然后进入执行。判定合并文本时：

- 信息并集：保留各条中不重复的事实、数据、路径、命令、来源；
- 以最新数据为准，旧数据只在有对照价值时以「旧值→新值」形式保留；
- 单主题、自足：不依赖被归档条目也能读懂；程序会自动盖时间戳，不要手写日期前缀。

### 步骤 3：执行（一簇一清，不攒批）

> ⚠️ `replace` 是**整条替换**：`content` 必须给该条目的**完整新全文**（含全部编号段
> 与分段）。只传增量或新句子会**静默吞掉**其余内容——2026-09-16 实证：更正一条多段
> 记忆时只写了新句子，其余段落整条丢失（靠 memories 仓库的 git 备份才找回）。改写前
> 先用 `list`（key 轨可用 `expand`）把原文读全。

对每个簇按序执行（全部通过 memory 工具）：

1. `replace` 保留条目 → 改写为合并版文本（保留条目的 id/位置不变）；
2. `archive` 其余条目 → 原文进归档；
3. 需要「过期状态清理」抽取新教训、或「跨轨归位」在目标轨落地时用 `add`
   （key 轨 `add` 走待确认队列，属正常流程）。**key 建议用 memory 工具 `add`
   （`target=key`）提交，不要用 `memory_suggest`**——后者的 target 白名单不含 key，
   传入会报「不支持 target=key」；
4. 跨轨归位先确认目标轨没有既有同项条目（先 `list` 核对），再落位。

执行中任何一条工具报错：先重读该轨当前状态再重试一次，仍失败就跳过该簇并在报告中
如实标注，不要中断整批。

### 步骤 4：报告

- 候选簇超过 40 个时分批：本轮只处理前 40 簇，报告里注明剩余量，后续回合继续。
- 收尾用 memory 工具一次调用写入 daily + project 两条日志：动作计数（合并 N 组 /
  归档 M 条 / 抽取 K 条 / 跳过 J 条）+ 1-2 个代表例 + 跳过原因。合并中产生的、值得
  长期注入的项目级事实，另行向 key 轨提交建议。

### 步骤 5：备份推送

向记忆同步发一次手动推送（仅 DSH 运行时可用；失败不阻塞，在报告注明「待下次自动备份」）：

```bash
curl -X POST http://127.0.0.1:3080/memory-evolve/memory-sync/global-sync \
  -H "Content-Type: application/json" -d '{"push":true}'
```

## 四、故障处理（异常兜底）

- **工具报「…的内容无法通过记忆工具解析往返」（drift guard 拒写）**：说明该轨文件已
  不是规范形（常见成因：历史迁移脚本写入了 CRLF 分隔符、文件末尾多一个孤立 `§`、缺
  收尾换行），此时 `replace` / `archive` / `remove` 一律被拒。处置：①先手工备份该
  `.md`；②用插件自带的 `lib/store.js` 做规范化——读取全文后
  `serializeEntries(parseEntries(text))`，**校验往返条数不变**再把结果写回（UTF-8 无
  BOM）；③回到本文工具流程继续。不要手工拼分隔符。
- **判断条目是否粘连只认 `parseEntries(text).length`**：用正则数 `\n§\n` 会出现假阳性
  ——条目正文可能逐字引用分隔符（内容性 `§`）。`parseEntries` 计数与预期不符，才说明
  文件真的坏了。

## 五、何时运行

- 用户点名「梳理 / 合并 / 去重 / 整理记忆」时全量运行；
- 记忆审查到期提醒时，可用本技能做一次系统性整合（替代零散的逐条建议）；
- 日常不建议频繁跑：两次运行之间至少间隔一周或记忆有批量新增。
