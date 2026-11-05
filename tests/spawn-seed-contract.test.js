// 回归锁：spawn 路径不得再用「seed 注入 request/header」继承运行配置。
//
// 根因（2026-09-29 实测）：seed 事件排在 seq 0，即任何 turn 之外；v4 格式要求
// request/header 必须处于已打开的 turn 内（@deepseek-ai/dsh-session-format-v3-to-v4
// lib/index.js:571 requireTurn、:990 dense 校验）→ 每个 spawn 出来的会话日志在重载时
// 报「request/header is outside an open turn」（GUI「历史加载失败」，gateway/internal）。
// 修法：运行配置（思考等级）改走 AgentOptions.reasoningEffort（dsh-agent-loop:1157/:1525）。
//
// 直跑：node tests/spawn-seed-contract.test.js
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const read = (relative) => readFileSync(join(here, '..', relative), 'utf8')

const targets = [
  { label: 'dsh-memory-evolve/lib/session-orch.js', path: '../lib/session-orch.js' },
  { label: 'dsh-agents/lib/spawn.js', path: '../../dsh-agents/lib/spawn.js' },
]

let passed = 0
for (const target of targets) {
  let source
  try {
    source = readFileSync(join(here, '..', target.path.replace(/^\.\.\//, '')), 'utf8')
  } catch {
    source = readFileSync(join(here, target.path), 'utf8')
  }

  // ① 不得再把 request/header 写进 seed
  assert.ok(
    !/type:\s*'request\/header'/.test(source),
    `${target.label}: 仍出现 type: 'request/header'（spawn 不得再注入 seed 事件头）`,
  )
  // ② 不得再向 agents.create 传 seed
  assert.ok(
    !/\{\s*seed\s*\}/.test(source) && !/\bseed\s*:\s*\[/.test(source),
    `${target.label}: 仍向 agents.create 传 seed`,
  )
  // ③ 必须改走 AgentOptions.reasoningEffort
  assert.ok(
    /inheritedReasoningEffort/.test(source) && /reasoningEffort:\s*inheritedReasoningEffort/.test(source),
    `${target.label}: 未通过 AgentOptions.reasoningEffort 继承思考等级`,
  )
  // ④ adapterDefaults 判据必须在场（避免把适配器默认值当用户配置固化）
  assert.ok(
    /adapterDefaults\?\.reasoningEffort\s*!==\s*true/.test(source),
    `${target.label}: 缺少 adapterDefaults 判据`,
  )
  passed += 4
  console.log(`  ok  ${target.label}`)
}

console.log(`spawn-seed-contract: ${passed} assertions passed`)
