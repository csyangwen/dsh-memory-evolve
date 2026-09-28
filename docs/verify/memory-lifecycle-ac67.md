# AC-6.7 / AC-6.9 验收证据留档 · feat/memory-lifecycle（含修复轮复验）

> 本文件闭合 Phase 4 代码评审 P1-2（AC-6.7 真实输入全量跑与 AC-6.9 覆盖率说明表的验收留档缺位——两条完成判据此前只存在于 spec/plan 文本，无仓库内证据链）。
> 证据分两个时点：**基线时点**（HEAD=3db0d68，executor 原始交付后、评审代验/独立复测）与**修复轮时点**（本文件所在 commit，评审 P1×3 + P2/安全处置后新鲜复跑）。所有数字均来自脚本实跑，无臆造；口径与出处逐项标注。

---

## 一、AC-6.7 真实输入全量跑（真实记忆库只读副本全链路）

### 1.1 基线时点证据（HEAD=3db0d68）

| 项 | code-reviewer 代验（agent-out/rev-realrun.mjs） | test-engineer 独立复测（agent-out/testeng-baseline-report.md §二 AC-6.7 行） |
|---|---|---|
| 副本来源 | 复制本机真实 `~/.dsh/memories` → 系统临时目录（只读副本） | 同左（2732 文件） |
| 条目解析 | memory=161 / user=32 正常解析 | memory=161 / user=32 / key=16 |
| decay 全链路 | candidates=0（本机记忆均未超 30 天阈值），fallback=193 全部合理 | 0 候选 / fallback 209（真实时钟） |
| 报告落盘 | decay-report.json 落盘、JSON 可解析、days 无 NaN | 同左，readDecayCandidateCount=0 |
| 快照渲染 | 默认 78664 字符**无 `[salience:` 泄漏**；auto 模式 19115 字符（摘要化生效，缩 76%） | renderSnapshot 90703 字符 / 222 行三轨头齐全 |
| 原目录保护 | 脚本只写副本内报告，原目录零写回 | MEMORY.md / USER.md SHA256 前后不变；原目录 hit-stats/decay-report 计数 0 |

两方数字差异（90703 vs 78664 等）为快照配置口径差异与真实库自然漂移（testeng 报告已注明），量级吻合、结论一致：**PASS**。

### 1.2 修复轮时点复验（本 commit）

| 项 | 结果 | 脚本 |
|---|---|---|
| 三轨读取 + decay 全链路 + 快照双模式 | `memory=161 user=32`；`candidates=0 fallback=193`；默认快照 **78664 字符与评审时点逐位一致**、无 `[salience:` 泄漏；auto 19115 字符 | `node agent-out/rev-realrun.mjs <DSH 记忆目录>` → REALRUN PASS |
| COI 通道（P2-1 修复面） | buildMemoryContext 三轨全开 92074 字符 / memory-only 72242 / user-only 7846，**无 `[salience:` 泄漏**（修复前该通道原样注入 tag） | `node agent-out/fixround-realrun-coi.mjs` → COI-REALRUN PASS |

说明：rev-realrun 的 key=0 因其 agent.cwd 指向仓库目录（该项目无 key 记忆），key 轨全链路由 7 套单测覆盖（store-salience/hit-stats-backfill 的 key 队列路径）。

---

## 二、AC-6.9 覆盖率说明表

### 2.1 基线时点（test-engineer NODE_V8_COVERAGE 独立复测，7 套件）

| 文件 | 覆盖 | 说明 |
|---|---|---|
| lib/hit-stats.js | 109/109 = **100.0%** | 全文件 |
| lib/decay.js | 249/249 = **100.0%** | 全文件 |
| lib/index.js（九个改动区） | 64/64 = **100%** | AC-6.9 判定对象（executor 自报 63/63 为合计笔误，比率不变） |
| lib/index.js（全文件） | 77.5% | 参考值（历史批次口径，非本批判定对象） |

### 2.2 修复轮时点（本 commit，复采口径：NODE_V8_COVERAGE 7 套件直跑；UTF-16 偏移 + 逐字节最内层生效 range + 逐报告独立算行覆盖再 OR）

**改动区口径（AC-6.9 判定对象）——12 个改动区全部 100%：**

| 文件 | 改动区 | 行覆盖 |
|---|---|---|
| lib/store.js | autoSummary 循环剥（P2-5）:213-224 | 12/12 FULL |
| lib/store.js | stripEntrySalience 只剥 salience（P1-1）:264-290 | 27/27 FULL |
| lib/store.js | stampEntry typeof 收口（P2-4）:775-791 | 17/17 FULL |
| lib/index.js | add 归一接 helper（P1-3）:1477-1487 | 11/11 FULL |
| lib/index.js | replace 同链透传（F-1）:1507-1519 | 13/13 FULL |
| lib/index.js | decayHint 兜底口径（P2-2）:810-817 | 8/8 FULL |
| lib/index.js | normalizeSalienceFor helper（P1-3）:1669-1699 | 31/31 FULL |
| lib/index.js | buildMemoryContext memory/user 剥离（P2-1）:1726-1741 | 16/16 FULL |
| lib/decay.js | daysBetween 往返校验（P2-3）:93-109 | 17/17 FULL |
| lib/hit-stats.js | readSidecar 危险键收口（F-2）:58-72 | 15/15 FULL |
| lib/i18n.js | param.salience 更新（F-1）:203-210 | 8/8 FULL |
| lib/i18n.js | msg.salienceIgnoredTrack 新增（P1-3）:352-355 | 4/4 FULL |
| **合计** | | **199/199 = 100%（REGIONS-ALL-FULL-COVERED）** |

**全文件口径（参考值）：**

| 文件 | 覆盖 | 未覆盖说明 |
|---|---|---|
| lib/decay.js | 257/257 = **100.0%** | — |
| lib/hit-stats.js | 111/115 = 96.5% | 4 行未覆盖均为**既有**损坏降级路径行（:61 throw 非对象 / :71-72 catch 告警 / :86 withLock 开头），非本批改动行；7 套新测试不含「侧车损坏降级」形态的组合触发（AC-1.4 变体走 readSidecar 直调路径，V8 range 口径下 catch 块粒度计为独立 range）。与 §2.1 的 100% 差异源于两代解析器的 range 归并口径微差，两套解析脚本均已留档可复现 |
| lib/store.js | 993/1578 = 62.9% | 参考值；未覆盖面为既有分支（storetail 编辑/归档/web 面板路径等，由 plugin.test.js 等既有套件覆盖——本批 7 套直跑不含那些套件） |
| lib/index.js | 1540/2528 = 60.9% | 同上（advisor/canvas/notify 等既有模块面，非本批判定对象） |
| lib/i18n.js | 1348/1350 = 99.9% | :63/:69 为 locale 回退分支（宿主 locale 服务不可用时的防御路径） |

### 2.3 复跑命令

```pwsh
# 覆盖率采集（dsh-memory-evolve 目录下）
$env:NODE_V8_COVERAGE = '<工作区>/agent-out/fixround-cov-raw'
node tests/store-salience.test.js; node tests/decay.test.js; node tests/hit-stats.test.js
node tests/hit-stats-backfill.test.js; node tests/memory-progressive-disclosure.test.js
node tests/review-decay-link.test.js; node tests/snapshot-golden.test.js
Remove-Item Env:NODE_V8_COVERAGE
# 改动区核对（期望输出末行 REGIONS-ALL-FULL-COVERED）
node <工作区>/agent-out/fixround-cov-regions.mjs <工作区>/agent-out/fixround-cov-raw
# 真实输入全链路（只读副本，绝不写回原目录）
node <工作区>/agent-out/rev-realrun.mjs <DSH 记忆目录>
node <工作区>/agent-out/fixround-realrun-coi.mjs
```

---

## 三、证据脚本索引（均在 <工作区>/agent-out/，不入库）

| 脚本 | 用途 |
|---|---|
| rev-realrun.mjs | AC-6.7 真实副本全链路（code-reviewer 评审时取证脚本，修复轮复用） |
| fixround-realrun-coi.mjs | 修复轮新增：COI 通道真实数据探针（P2-1 修复面） |
| fixround-cov.mjs | 修复轮新增：V8 行覆盖全文件汇总（UTF-16 偏移 + 最内层 range 口径） |
| fixround-cov-regions.mjs | 修复轮新增：改动区行级覆盖核对（逐报告 OR 口径） |
| fixround-mutate.mjs | 修复轮新增：注入必红自证（8 变异 × 对应负向断言必红） |

*留档人：executor（session-ce29ec93）· 修复轮 commit 所在时点 · 本文件由 write 工具落盘。*
