/**
 * Phase C — Jev advisory labeling (shadow mode).
 *
 * The gate never blocks a suggestion: it attaches two scores to KEY-track
 * suggestions and degrades to a reason string otherwise. These tests pin the
 * contract the two call sites rely on, using MockJevProvider so the suite
 * never touches the network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { JevGate } from '../lib/jev-gate.js'
import { enqueueSuggestion, suggestToolDefinition } from '../lib/review.js'
import { SuggestionQueue } from '../lib/store.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-jev-gate-'))
}

/** Resolve jev-core's MockJevProvider from the sibling plugin (same loader path the gate uses). */
let Mock = null
async function loadMock() {
  if (Mock) return Mock
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const jev = await import(join(home, 'plugins/dsh-jev/packages/jev-core/lib/index.js'))
  Mock = jev.MockJevProvider
  return Mock
}

/** Wait until the pending label on the newest key entry resolves (or time out). */
async function awaitResolved(queue, { tries = 40 } = {}) {
  for (let i = 0; i < tries; i++) {
    const entries = queue.read()
    const last = entries[entries.length - 1]
    if (last && last.jev && last.jev.gate !== 'pending') return last.jev
    await new Promise((r) => setTimeout(r, 25))
  }
  return null
}

test('gate: mock provider labels a key suggestion and writes scores back into the queue', async () => {
  const dir = tempDir()
  const MockJevProvider = await loadMock()
  const provider = new MockJevProvider({
    scenarioFor: (_req, i) => ({
      answers: {
        generalization: { score: i % 2 === 0 ? 0.9 : 0.2 },
        skill_shape: { score: 0.8 },
      },
    }),
  })
  const gate = new JevGate({
    provider: 'mock',
    generalizationThreshold: 0.5,
    skillShapeThreshold: 0.6,
  }, dir)
  // swap the provider the constructor built for the scenario-driven one
  gate.setProviderForTest(provider)
  const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
  await enqueueSuggestion(queue, 'key', '用 pnpm 不要用 npm 装这个仓库', '两次锁文件损坏', null, gate)
  const jev = await awaitResolved(queue)
  assert.ok(jev, 'label must resolve')
  assert.equal(jev.gate, 'labeled')
  // scenario scores are ordinal (0..4); the gate normalizes to 0..1
  assert.equal(jev.scores.generalization, 0.9 / 4)
  assert.equal(jev.scores.skill_shape, 0.8 / 4)
  assert.equal(jev.verdicts.generalization, false, '0.225 < 0.5 — not cross-project')
  assert.equal(jev.verdicts.skill_shape, false, '0.2 < 0.6 — not skill-shaped')
})

test('gate: sensitive content is skipped and never sent to the provider', async () => {
  const dir = tempDir()
  const MockJevProvider = await loadMock()
  let sent = 0
  const provider = new MockJevProvider({
    scenarioFor: () => { sent += 1; return { answers: { generalization: { score: 1 }, skill_shape: { score: 1 } } } },
  })
  const gate = new JevGate({ provider: 'mock' }, dir)
  gate.setProviderForTest(provider)

  const out = await gate.label('用户的手机号是 13800138000，身份证 11010119900307777X')
  assert.equal(out.ok, false)
  assert.equal(out.gate, 'sensitive')
  assert.equal(sent, 0, 'sensitive text must never reach the provider')
})

test('gate: ordinal rubric scores are normalized onto 0..1 before thresholding', async () => {
  const dir = tempDir()
  const MockJevProvider = await loadMock()
  // jev-core's score() is an ordinal rubric: a 5-level rubric answers on
  // 0..4, and the SDK's expected score may fall between levels. The gate
  // must map that onto 0..1 before comparing to its thresholds — otherwise
  // every entry scores above 0.6 and everything predicts "S".
  const provider = new MockJevProvider({
    scenario: { answers: { generalization: { score: 2 }, skill_shape: { score: 4 } } },
  })
  const gate = new JevGate({
    provider: 'mock',
    generalizationThreshold: 0.5,
    skillShapeThreshold: 0.6,
  }, dir)
  gate.setProviderForTest(provider)
  const out = await gate.label('一条跨项目通用的长期口径')
  assert.equal(out.gate, 'labeled')
  assert.equal(out.scores.generalization, 0.5, '2 on a 5-level rubric is 0.5')
  assert.equal(out.scores.skill_shape, 1, '4 on a 5-level rubric is 1.0')
  assert.equal(out.verdicts.generalization, true, '0.5 meets the 0.5 threshold')
  assert.equal(out.verdicts.skill_shape, true)
})

test('gate: sub-threshold ordinal scores stay below the thresholds after normalization', async () => {
  const dir = tempDir()
  const MockJevProvider = await loadMock()
  const provider = new MockJevProvider({
    scenario: { answers: { generalization: { score: 1.5 }, skill_shape: { score: 2 } } },
  })
  const gate = new JevGate({ provider: 'mock' }, dir)
  gate.setProviderForTest(provider)
  const out = await gate.label('只对当前项目有用的临时进展记录')
  assert.equal(out.scores.generalization, 1.5 / 4)
  assert.equal(out.scores.skill_shape, 0.5)
  assert.equal(out.verdicts.generalization, false, '0.375 < 0.5')
  assert.equal(out.verdicts.skill_shape, false, '0.5 is below the 0.6 skill threshold')
})

test('gate: budget limit stops labeling but the suggestion still enqueues', async () => {
  const dir = tempDir()
  const MockJevProvider = await loadMock()
  const provider = new MockJevProvider({
    scenario: { answers: { generalization: { score: 0.9 }, skill_shape: { score: 0.9 } } },
  })
  // a one-call budget: the first call exhausts it, the second must degrade
  // (fresh dir per test, but the budget is UTC-daily — clean the file too)
  const budgetFile = join(dir, 'jev-budget.json')
  if (existsSync(budgetFile)) unlinkSync(budgetFile)
  const gate = new JevGate({ provider: 'mock', dailyCallLimit: 1 }, dir)
  gate.setProviderForTest(provider)

  const first = await gate.label('可复用的长期约定')
  assert.equal(first.gate, 'labeled')
  const second = await gate.label('另一条可复用的长期约定')
  assert.equal(second.ok, false)
  assert.equal(second.gate, 'limit')
  // the budget file persisted the spent call
  const budget = JSON.parse(readFileSync(join(dir, 'jev-budget.json'), 'utf8'))
  assert.equal(budget.calls, 1)
})

test('gate: rubric questions carry skill anchors so the model has a concrete reference', async () => {
  // Without concrete examples of what a reusable memory looks like, the
  // model anchors on the entry being judged and every key-style entry scores
  // high. Anchoring is what makes the two axes discriminate; pin it so a
  // refactor cannot silently drop it.
  const before = JevGate.prototype.constructor
  const src = await import('node:fs').then((fs) => fs.readFileSync('/home/aslen/.dsh/plugins/dsh-memory-evolve/lib/jev-gate.js', 'utf8'))
  assert.ok(src.includes('remote-hive-pd-recovery'), 'generalization question must cite a real skill example')
  assert.ok(src.includes('find-animation-opportunities'), 'skill question must cite a real skill example')
  assert.ok(before, 'gate class present')
})

test('gate: disabled gate and missing jev-core both degrade to a reason, never throw', async () => {
  const dir = tempDir()
  const off = new JevGate({ provider: 'mock', enabled: false }, dir)
  assert.equal((await off.label('任何内容')).gate, 'disabled')

  // simulate the sibling plugin being absent: resolution already failed once
  // in an earlier gate in this process, so construct with an unreachable
  // budget file and assert the disabled path stays total
  const broken = new JevGate({ provider: 'mock' }, null)
  const out = await broken.label('内容')
  assert.ok(['labeled', 'unavailable', 'disabled', 'limit', 'budget', 'error', 'skipped'].includes(out.gate))
})

test('gate: non-key targets are never labeled (the audit surface stays narrow)', async () => {
  const dir = tempDir()
  const MockJevProvider = await loadMock()
  let sent = 0
  const provider = new MockJevProvider({
    scenarioFor: () => { sent += 1; return { answers: { generalization: { score: 1 }, skill_shape: { score: 1 } } } },
  })
  const gate = new JevGate({ provider: 'mock' }, dir)
  gate.setProviderForTest(provider)

  const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
  await enqueueSuggestion(queue, 'memory', '一条全局事实', '理由', null, gate)
  await new Promise((r) => setTimeout(r, 100))
  const entry = queue.read()[0]
  assert.equal(entry.jev, null, 'memory-track suggestions carry no jev field')
  assert.equal(sent, 0, 'only key suggestions are labeled')
})

test('gate: every labeling call appends one execution-log record', async () => {
  const dir = tempDir()
  const MockJevProvider = await loadMock()
  const provider = new MockJevProvider({
    scenarioFor: (_req, i) => {
      if (i === 0) return { answers: { generalization: { score: 3 }, skill_shape: { score: 3 } } }
      if (i === 1) return { error: { code: 'SERVER', message: 'mock failure' } }
      return { answers: { generalization: { score: 1 }, skill_shape: { score: 1 } } }
    },
  })
  const logFile = join(dir, 'jev-log.jsonl')
  const gate = new JevGate({ provider: 'mock', logFile }, dir)
  gate.setProviderForTest(provider)

  await gate.label('一条跨项目通用的长期口径')
  await gate.label('标注失败的那一条')
  await gate.label('联系 13800138000 的敏感内容')

  const records = gate.readLog()
  assert.equal(records.length, 3, 'one record per call, newest first')
  assert.equal(records[0].gate, 'sensitive', 'sensitive skip is logged too')
  assert.equal(records[1].gate, 'error', 'provider failure is logged')
  assert.ok((records[1].reason ?? '').includes('SERVER'), 'error reason is kept')
  assert.equal(records[2].gate, 'labeled')
  assert.equal(records[2].scores.generalization, 0.75, '3/4 = 0.75 on a 5-level rubric')
  assert.equal(records[2].scores.skill_shape, 0.75)
  assert.ok(typeof records[2].contentPreview === 'string' && records[2].contentPreview.length > 0)
  // newest first
  assert.ok(records[2].at <= records[1].at)
})

test('gate: readLog reads newest first and caps at the limit', async () => {
  const dir = tempDir()
  const MockJevProvider = await loadMock()
  const provider = new MockJevProvider({
    scenario: { answers: { generalization: { score: 2 }, skill_shape: { score: 2 } } },
  })
  const gate = new JevGate({ provider: 'mock' }, dir)
  gate.setProviderForTest(provider)
  for (let i = 0; i < 5; i += 1) {
    await gate.label(`第 ${i} 条样本内容`)
  }
  const all = gate.readLog(10)
  assert.equal(all.length, 5)
  assert.equal(all[0].contentPreview, '第 4 条样本内容', 'newest first')
  const top = gate.readLog(2)
  assert.equal(top.length, 2)
  assert.equal(top[0].contentPreview, '第 4 条样本内容')
  assert.equal(top[1].contentPreview, '第 3 条样本内容')
})

test('gate: readLog tolerates a missing or corrupt log file', () => {
  const dir = tempDir()
  const gate = new JevGate({ provider: 'mock' }, dir)
  assert.deepEqual(gate.readLog(), [], 'no log file yet reads as empty')
  const missing = new JevGate({ provider: 'mock', logFile: join(dir, 'gone', 'jev-log.jsonl') }, dir)
  assert.deepEqual(missing.readLog(), [], 'unreadable path reads as empty, never throws')
})

test('gate: audit() labels a batch and one failure does not abort the rest', async () => {
  const dir = tempDir()
  const MockJevProvider = await loadMock()
  const provider = new MockJevProvider({
    scenarioFor: (_req, i) => {
      if (i === 1) return { error: { code: 'SERVER', message: 'mock failure' } }
      return { answers: { generalization: { score: 0.7 }, skill_shape: { score: 0.7 } } }
    },
  })
  const gate = new JevGate({ provider: 'mock' }, dir)
  gate.setProviderForTest(provider)

  const rows = await gate.audit(['第一条', '第二条', '联系 13800138000'])
  assert.equal(rows.length, 3)
  assert.equal(rows[0].gate, 'labeled')
  assert.equal(rows[1].gate, 'error')
  assert.equal(rows[2].gate, 'sensitive')
})

test('gate: thresholds flip verdicts and are configurable', async () => {
  const dir = tempDir()
  const MockJevProvider = await loadMock()
  const provider = new MockJevProvider({
    scenario: { answers: { generalization: { score: 2.2 }, skill_shape: { score: 2.2 } } },
  })
  // scenario scores are ordinal: 2.2/4 = 0.55 sits between the two
  // thresholds, so it flips the generalization verdict but not the skill one
  const low = new JevGate({ provider: 'mock', generalizationThreshold: 0.5, skillShapeThreshold: 0.6 }, dir)
  low.setProviderForTest(provider)
  const out = await low.label('一条通用约定')
  assert.equal(out.scores.generalization, 0.55, '2.2 on a 5-level rubric is 0.55')
  assert.equal(out.scores.skill_shape, 0.55)
  assert.equal(out.verdicts.generalization, true, '0.55 >= 0.5')
  assert.equal(out.verdicts.skill_shape, false, '0.55 < 0.6')
})

// ---- v2 design §3.4: skill adjudication ----

async function mockProviderWith(scores) {
  const MockJevProvider = await loadMock()
  const provider = new MockJevProvider({
    scenario: { answers: {
      generalization: { score: scores.generalization },
      skill_shape: { score: scores.skill_shape },
    } },
  })
  return provider
}

test('auditSkill: both axes over threshold → approved', async () => {
  const dir = tempDir()
  const gate = new JevGate({
    provider: 'mock',
    generalizationThreshold: 0.5,
    skillShapeThreshold: 0.6,
  }, dir)
  gate.setProviderForTest(await mockProviderWith({ generalization: 3.2, skill_shape: 3.2 }))
  const verdict = await gate.auditSkill('good-skill', '---\nname: good-skill\ndescription: x\n---\n正文')
  assert.equal(verdict.approved, true)
  assert.equal(verdict.scores.generalization, 0.8)
  assert.equal(verdict.scores.skill_shape, 0.8)
  assert.equal(verdict.thresholds.generalization, 0.5)
  assert.equal(verdict.thresholds.skill_shape, 0.6)
  assert.ok(verdict.reason.includes('双轴过阈'), 'approve reason explains both axes')
})

test('auditSkill: one axis low → rejected (the conjunction is the point)', async () => {
  const dir = tempDir()
  const gate = new JevGate({ provider: 'mock' }, dir)
  gate.setProviderForTest(await mockProviderWith({ generalization: 3.2, skill_shape: 1.2 }))
  const verdict = await gate.auditSkill('project-only', '正文')
  assert.equal(verdict.approved, false)
  assert.ok(verdict.reason.includes('未过阈'), 'reject reason states which axis failed')
})

test('auditSkill: sensitive body → approved null, never sent to the provider', async () => {
  const dir = tempDir()
  const MockJevProvider = await loadMock()
  let sent = 0
  const provider = new MockJevProvider({
    scenarioFor: () => { sent += 1; return { answers: { generalization: { score: 4 }, skill_shape: { score: 4 } } } },
  })
  const gate = new JevGate({ provider: 'mock' }, dir)
  gate.setProviderForTest(provider)
  const verdict = await gate.auditSkill('leaky', '密码 password=hunter2 的做法')
  assert.equal(verdict.approved, null, 'sensitive content cannot be ruled on')
  assert.equal(verdict.gate, 'sensitive')
  assert.equal(sent, 0, 'the body must never reach the provider')
})

test('auditSkill: over budget → approved null (fail-open means no verdict)', async () => {
  const dir = tempDir()
  const budgetFile = join(dir, 'jev-budget.json')
  if (existsSync(budgetFile)) unlinkSync(budgetFile)
  const gate = new JevGate({ provider: 'mock', dailyCallLimit: 1 }, dir)
  gate.setProviderForTest(await mockProviderWith({ generalization: 3.2, skill_shape: 3.2 }))
  assert.equal((await gate.auditSkill('a', '正文')).approved, true)
  const verdict = await gate.auditSkill('b', '正文')
  assert.equal(verdict.approved, null, 'budget exhaustion yields no verdict, not an approval')
  assert.equal(verdict.gate, 'limit')
})

test('auditSkill: disabled gate → approved null, never approves by default', async () => {
  const dir = tempDir()
  const gate = new JevGate({ provider: 'mock', enabled: false }, dir)
  const verdict = await gate.auditSkill('x', '正文')
  assert.equal(verdict.approved, null)
  assert.equal(verdict.gate, 'disabled')
})

test('auditSkill shares one threshold set with the KEY path (no second config)', async () => {
  // §8.8 review checklist: the skill chain must read the same thresholds the
  // KEY labeling path publishes, otherwise two configs drift apart.
  const dir = tempDir()
  const gate = new JevGate({
    provider: 'mock',
    generalizationThreshold: 0.42,
    skillShapeThreshold: 0.77,
  }, dir)
  gate.setProviderForTest(await mockProviderWith({ generalization: 2.0, skill_shape: 3.4 }))
  const verdict = await gate.auditSkill('x', '正文')
  assert.equal(verdict.thresholds.generalization, 0.42)
  assert.equal(verdict.thresholds.skill_shape, 0.77)
  assert.equal(verdict.approved, true, '0.5 >= 0.42 and 0.85 >= 0.77')
  assert.equal(gate.health().thresholds.generalization, 0.42, 'health() shows the same value')
})

test('logSkill: appends skill-chain records the audit endpoint reads back', async () => {
  const dir = tempDir()
  const gate = new JevGate({ provider: 'mock' }, dir)
  gate.logSkill({ kind: 'skill-create', operationId: 'op-1', name: 's', contentHash: 'abc', stage: 'staged' })
  gate.logSkill({ kind: 'skill-verdict', operationId: 'op-1', name: 's', approved: false, reason: '低' })
  const records = gate.readLog(10)
  assert.equal(records.length, 2)
  assert.equal(records[0].kind, 'skill-verdict', 'newest first')
  assert.equal(records[1].operationId, 'op-1')
  assert.equal(records[0].approved, false)
})
