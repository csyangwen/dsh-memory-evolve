// 快照黄金基线测试（autopilot-memory-lifecycle Step 3 先行动作；测试策略第 5 条）
//
// 有意再捕获记录（2026-09-24，PR #66 后续增强批次）：
//   - 第 1 次（块 1）：snap.keyDuty 注入文本补 salience 半句（用户需求：
//     UI 可见性与引导；spec 修订记录 R1）——旧→新唯一差异 = keyDuty 段
//     「（用户确认后写入并注入）」→「（用户确认后写入并注入；核心约定/
//     决策可传 salience:2-3 标注重要性，常规进展不传）」。
//   - 第 2 次（块 6，最终态）：keyDuty 段追加「存量旧条目缺重要性标记时
//     用 retag 补标（3=核心约定/架构/高频复用事实，2=重要，1 或不标=
//     常规进展），建议在记忆审查到期轮分批处理（每轮 10-20 条至清零）」
//     （用户拍板：主路径=运行时大模型统一补标；spec 修订记录 R3）。
//   - 第 3 次（块 7，最终态）：batchWriteDuty 段补 used 使用申报半句
//     「本轮实际用到的既有记忆，请在同次调用的 used 参数申报其独特子串，
//     命中计数用于重要性调度与衰减判定」（用户洞察：模型实际只从注入
//     快照读记忆、几乎不调 list/expand，命中信号必须能从使用申报流入；
//     spec 修订记录 R4——Q5「注入不算命中」语义修订）。
//   - 第 4 次（2026-09-28，合并 origin/main 8 提交）：keyDuty 段并入上游
//     issue #58 第二项修复「另用 memory 工具 action=add 向 target=key 提交
//     1 条建议（走待确认队列，用户确认后写入并注入）」——原文案只说「另向
//     target=key 提交 1 条建议」，而 memory_suggest 的 target 白名单不含 key，
//     照字面选工具会反复报「不支持 target=key」；本仓的 retag/salience 半句
//     与上游的工具名半句**两边都要**（合并冲突的解 = 两段拼接），故基线
//     再次有意再捕获（spec 修订记录 R5）。manifest：唯一差异段 = keyDuty；
//     其余所有行与第 3 次基线逐字节一致（脚本会同时断言两次渲染一致）。
// 四次均按有意变更流程再捕获（fixture store + 默认 config 跑 renderSnapshot，
// 脚本存档 agent-out/recapture-golden-uifollowup.mjs 与
// agent-out/v2-recapture-golden.mjs）；spec 修订记录见
// docs/specs/autopilot-memory-lifecycle.md 头部。
//
// 基线字符串由 agent-out/v2-recapture-golden.mjs 生成（JSON.stringify 形态，
// 便于机器读写与逐字节比对；手工改动仍被本文件头注记纪律禁止）。
//
// 纪律：本测试在**任何 strip 链改动之前**捕获（HEAD=4d22c1f，段 1 之后、
// salience 之前），把「固定 fixture store + 默认 config」的 renderSnapshot
// 输出嵌为 golden 字符串断言。它同时守住：
//   - Step 3（strip 链扩展：stripEntrySalience 组合进注入与回显）
//   - Step 4（快照分层注入 memoryProgressiveDisclosure 默认 off）
//   - Step 5（dueWarning 联动，后续步骤）
// 的默认零变化——后续任何步骤跑本测试红 = 默认行为被改坏。
//
// fixture 特性：全部条目手写静态日期（无动态内容）、五类旧头部形态
// （纯时间戳 / [git] / [summary] / [dsh-only] / 裸条目）、三轨布置
// （memory/user/key）、agent 无 session.id（无会话段）、cwd 非真实
// git 目录（key 轨无分支过滤，head 用 snap.keyHead 形态）。
// 捕获脚本存档：agent-out/capture-golden.mjs（工作区过程物目录）。
//
// 直跑：node tests/snapshot-golden.test.js（沙箱禁 node --test runner，
// node:test import 形态 + 自执行入口，照 tests/aliases.test.js 先例）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, renderSnapshot } from '../lib/index.js'
import { MemoryStore, projectHash } from '../lib/store.js'
import { setLocale } from '../lib/i18n.js'

// 本套件钉中文输出契约；英文由 i18n.test.js 覆盖。
setLocale('zh')

/** golden fixture 的共享构造（memory-progressive-disclosure.test.js 复用）。 */
export function buildGoldenFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-golden-'))
  const memoryEntries = [
    '[2026-09-20] 纯时间戳条目（无任何附加标记）',
    '[2026-09-21] [git main] 带 git 分支标记的条目',
    '[2026-09-22] [summary:显式摘要示例] 带摘要标记的条目，正文第一行',
    '[dsh-only] 无日期的仅 DSH 条目',
    '无时间戳无标记的裸条目',
  ]
  const userEntries = [
    '[2026-09-19] 用户档案条目一',
    '[2026-09-20] [summary:用户摘要示例] 用户档案条目二正文',
  ]
  const keyEntries = [
    '[2026-09-18] [branch:main,dev] 带分支范围的关键记忆条目',
    '[2026-09-19] [summary:关键摘要] 带摘要的关键记忆条目正文',
  ]
  const CWD = '/proj/golden-cwd'
  writeFileSync(join(dir, 'MEMORY.md'), memoryEntries.join('\n§\n') + '\n')
  writeFileSync(join(dir, 'USER.md'), userEntries.join('\n§\n') + '\n')
  const keyDir = join(dir, 'projects', projectHash(CWD))
  mkdirSync(keyDir, { recursive: true })
  writeFileSync(join(keyDir, 'KEY.md'), keyEntries.join('\n§\n') + '\n')
  return {
    dir,
    store: new MemoryStore(dir),
    config: resolveConfig({ memoryDir: dir }),
    agent: { id: 'a', session: { header: { cwd: CWD } } },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** 黄金基线（2026-09-24 有意再捕获，缘由见文件头注记；非漂移变更禁止手工改动本字符串）。 */
export const GOLDEN_ZH = "## 长期记忆（所有项目、会话都必须遵循）\n- [2026-09-20] 纯时间戳条目（无任何附加标记）\n- [2026-09-21] [git main] 带 git 分支标记的条目\n- [2026-09-22] 带摘要标记的条目，正文第一行\n- [dsh-only] 无日期的仅 DSH 条目\n- 无时间戳无标记的裸条目\n\n## 用户档案\n- [2026-09-19] 用户档案条目一\n- [2026-09-20] 用户档案条目二正文\n\n## 本项目关键记忆（memory 工具 target=key）\n- [2026-09-18] [branch:main,dev] 带分支范围的关键记忆条目\n- [2026-09-19] 带摘要的关键记忆条目正文\n\n## 记忆 memory-evolve（包含 memory 工具、dtodo 待办工具、skill_manage 技能工具）\n- 读取：需要时用 memory 工具读取 target=project（项目约定/进展）与 target=daily（今日日志），不要凭猜测回答。本项目关键记忆（target=key）已注入上下文，无需读取。\n- 待办（dtodo）：收尾时调用 dtodo list 检查到期（默认视图：今日到期/逾期优先，最多 8 条）——有到期未完成项就在回复末尾提醒用户；不要主动展开全部待办清单，除非用户询问；用法细节（target 归类、过往/过期查询等）见 dtodo 工具描述。\n\n- 每轮收尾分两步（不要把完整回复和写入工具调用放进同一条消息——带工具调用的消息结束不了 turn，会逼出多余收尾）：① 本条消息只发写入工具调用（memory 等，不写正文）；② 下一条消息输出完整回复（无工具调用，结束 turn）。\n  1. 写入：用 memory 工具**一次调用**（action=add + entries 数组，含 target=daily 与 target=project 各一项）写 1 条本回合进展（1-2 行具体内容；本轮实际用到的既有记忆，请在同次调用的 used 参数申报其独特子串，命中计数用于重要性调度与衰减判定）；本轮出现重要项目事实（长期约定/决策/架构/踩坑）时另用 memory 工具 action=add 向 target=key 提交 1 条建议（走待确认队列，用户确认后写入并注入；核心约定/决策可传 salience:2-3 标注重要性，常规进展不传）；存量旧条目缺重要性标记时用 retag 补标（3=核心约定/架构/高频复用事实，2=重要，1 或不标=常规进展），建议在记忆审查到期轮分批处理（每轮 10-20 条至清零）；没有则跳过；本回合真人用户输入有明显情绪（正面/负面）时，各条目带 feedback 参数（sentiment/category/quote/note，程序自动生成【反馈】行）——daily 的 category 写通用分类（如 编程/后端/数据库，至少一级可到三级；分类指工作类型如 编程→前端开发→JavaScript，不是任务涉及的功能/模块名），project 的 category 写本项目内分层（如 记忆模块/写入链路，按项目实际结构）；中性任务指令或其他会话 AI 消息不带 feedback；\n- 内容不要自带时间/日期前缀（程序自动盖时间戳）。"

test('快照黄金基线：固定 fixture + 默认 config 的 renderSnapshot 输出逐字节等于捕获基线', () => {
  const fx = buildGoldenFixture()
  try {
    const out = renderSnapshot(fx.config, fx.store, fx.agent)
    // 逐字节对照（AC-3.1 / AC-5.2 的「同现状」载体）：
    assert.equal(out, GOLDEN_ZH)
    // 确定性辅助断言：渲染两次逐字节一致（快照不许有隐藏随机性）
    const again = renderSnapshot(fx.config, fx.store, fx.agent)
    assert.equal(again, GOLDEN_ZH)
  } finally {
    fx.cleanup()
  }
})

// node 直跑自执行入口（被 import 时不重复执行——import 方测试自带 test 注册）
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  // node:test 的 test() 已在 import 时注册并自动执行，此处仅保证直跑退出码传播
}
