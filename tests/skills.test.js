import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isSkillName, parseFrontmatter, listSkills, readSkill, hasReadSkill, skillManageTool,
  approvePendingSkill, listPendingSkills, rejectPendingSkill,
} from '../lib/skills.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-skill-test-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

function fakeCtx(overrides = {}) {
  return {
    get: () => undefined,
    ...overrides,
  }
}

const FAKE_EXEC = () => ({ agent: undefined, callId: 'c1', signal: new AbortController().signal })

const GOOD_BODY = (name, description) => `---
name: ${name}
description: ${description}
---
# ${name}

## 概览
用于测试。

## 步骤
1. 第一步
2. 第二步

## 坑与陷阱
- 不要踩坑
`

test('isSkillName validates kebab-case and blocks traversal', () => {
  assert.equal(isSkillName('systematic-debugging'), true)
  assert.equal(isSkillName('github-pr-workflow'), true)
  assert.equal(isSkillName('Plan'), false)
  assert.equal(isSkillName('has space'), false)
  assert.equal(isSkillName('../evil'), false)
  assert.equal(isSkillName('a/b'), false)
  assert.equal(isSkillName(''), false)
})

test('parseFrontmatter accepts canonical skills and rejects malformed ones', () => {
  const parsed = parseFrontmatter(GOOD_BODY('demo-skill', '演示技能'))
  assert.equal(parsed.name, 'demo-skill')
  assert.equal(parsed.description, '演示技能')
  assert.ok(parsed.body.includes('## 概览'))
  assert.equal(parseFrontmatter('no frontmatter here'), undefined)
  assert.equal(parseFrontmatter('---\nname: x\n---\nbody'), undefined) // no description
  assert.equal(parseFrontmatter('---\ndescription: x\n---\nbody'), undefined) // no name
  // quoted description
  const quoted = parseFrontmatter('---\nname: a-b\ndescription: "带 空格 的描述"\n---\nbody')
  assert.equal(quoted.description, '带 空格 的描述')
})

test('listSkills and readSkill', () => {
  const dir = tempDir()
  mkdirSync(join(dir, 'alpha'), { recursive: true })
  writeFileSync(join(dir, 'alpha', 'SKILL.md'), GOOD_BODY('alpha', 'Alpha 技能'))
  mkdirSync(join(dir, 'broken'), { recursive: true })
  writeFileSync(join(dir, 'broken', 'SKILL.md'), 'not a skill')
  const entries = listSkills(dir)
  assert.deepEqual(entries, [{ name: 'alpha', description: 'Alpha 技能' }])
  assert.ok(readSkill(dir, 'alpha').includes('## 概览'))
  assert.equal(readSkill(dir, 'broken'), 'not a skill') // readSkill returns raw content
  assert.equal(readSkill(dir, 'nope'), undefined)
  assert.equal(readSkill(dir, '../x'), undefined)
  clean(dir)
})

test('skillManageTool create/list/read round-trip', async () => {
  const dir = tempDir()
  const tool = skillManageTool(fakeCtx(), { skillDir: dir, memoryDir: dir, skillManageToolName: 'skill_manage', skillMaxBytes: 65536 })

  const listed = await tool.execute({ action: 'list' }, FAKE_EXEC())
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.entries, [])

  const created = await tool.execute(
    { action: 'create', name: 'demo-skill', description: '演示技能', body: GOOD_BODY('demo-skill', '演示技能') },
    FAKE_EXEC(),
  )
  assert.equal(created.ok, true)
  assert.equal(readFileSync(join(dir, 'demo-skill', 'SKILL.md'), 'utf8'), GOOD_BODY('demo-skill', '演示技能'))

  const listed2 = await tool.execute({ action: 'list' }, FAKE_EXEC())
  assert.equal(listed2.entries.length, 1)
  assert.equal(listed2.entries[0].name, 'demo-skill')

  const read = await tool.execute({ action: 'read', name: 'demo-skill' }, FAKE_EXEC())
  assert.equal(read.ok, true)
  assert.ok(read.content.includes('## 概览'))
  clean(dir)
})

test('create validates name, body, description, and rejects existing skills', async () => {
  const dir = tempDir()
  const tool = skillManageTool(fakeCtx(), { skillDir: dir, memoryDir: dir, skillManageToolName: 'skill_manage', skillMaxBytes: 65536 })

  const badName = await tool.execute({ action: 'create', name: 'Bad Name', description: 'x', body: GOOD_BODY('Bad Name', 'x') }, FAKE_EXEC())
  assert.equal(badName.ok, false)
  assert.ok(badName.message.includes('kebab-case'))

  const badBody = await tool.execute({ action: 'create', name: 'ok-skill', description: 'x', body: 'no frontmatter' }, FAKE_EXEC())
  assert.equal(badBody.ok, false)
  assert.ok(badBody.message.includes('SKILL.md'))

  const mismatch = await tool.execute(
    { action: 'create', name: 'ok-skill', description: 'x', body: GOOD_BODY('other-name', 'x') },
    FAKE_EXEC(),
  )
  assert.equal(mismatch.ok, false)
  assert.ok(mismatch.message.includes('frontmatter 的 name'))

  const descMismatch = await tool.execute(
    { action: 'create', name: 'ok-skill', description: 'y', body: GOOD_BODY('ok-skill', 'x') },
    FAKE_EXEC(),
  )
  assert.equal(descMismatch.ok, false)
  assert.ok(descMismatch.message.includes('description'))

  const tooBig = await tool.execute(
    { action: 'create', name: 'big-skill', description: 'x', body: GOOD_BODY('big-skill', 'x') + 'y'.repeat(70000) },
    FAKE_EXEC(),
  )
  assert.equal(tooBig.ok, false)
  assert.ok(tooBig.message.includes('上限'))

  // create existing → reject
  mkdirSync(join(dir, 'existing'), { recursive: true })
  writeFileSync(join(dir, 'existing', 'SKILL.md'), GOOD_BODY('existing', '已有'))
  const dup = await tool.execute(
    { action: 'create', name: 'existing', description: 'x', body: GOOD_BODY('existing', 'x') },
    FAKE_EXEC(),
  )
  assert.equal(dup.ok, false)
  assert.ok(dup.message.includes('已存在'))
  clean(dir)
})

test('patch requires read-before-write and replaces the whole SKILL.md', async () => {
  const dir = tempDir()
  const tool = skillManageTool(fakeCtx(), { skillDir: dir, memoryDir: dir, skillManageToolName: 'skill_manage', skillMaxBytes: 65536 })
  await tool.execute({ action: 'create', name: 'demo-skill', description: '演示', body: GOOD_BODY('demo-skill', '演示') }, FAKE_EXEC())

  const agent = (events) => ({ id: 'child', session: { header: { origin: 'subagent' }, events } })
  const callEvent = (action, name) => ({
    type: 'tool/call',
    data: { name: 'skill_manage', arguments: JSON.stringify({ action, name }) },
  })

  // patch without read → refused
  const unread = await tool.execute(
    { action: 'patch', name: 'demo-skill', body: GOOD_BODY('demo-skill', '修订版') },
    { agent: agent([]), callId: 'c2', signal: new AbortController().signal },
  )
  assert.equal(unread.ok, false)
  assert.ok(unread.message.includes('必须先读取'))

  // read events from OTHER tools do not count
  const otherTool = await tool.execute(
    { action: 'patch', name: 'demo-skill', body: GOOD_BODY('demo-skill', '修订版') },
    { agent: agent([{ type: 'tool/call', data: { name: 'bash', arguments: '{}' } }]), callId: 'c3', signal: new AbortController().signal },
  )
  assert.equal(otherTool.ok, false)

  // read then patch → succeeds
  await tool.execute({ action: 'read', name: 'demo-skill' }, { agent: agent([]), callId: 'c4', signal: new AbortController().signal })
  const patched = await tool.execute(
    { action: 'patch', name: 'demo-skill', body: GOOD_BODY('demo-skill', '修订版') },
    { agent: agent([callEvent('read', 'demo-skill')]), callId: 'c5', signal: new AbortController().signal },
  )
  assert.equal(patched.ok, true)
  assert.ok(readFileSync(join(dir, 'demo-skill', 'SKILL.md'), 'utf8').includes('修订版'))

  // patch nonexistent → refuse
  const missing = await tool.execute(
    { action: 'patch', name: 'ghost', body: GOOD_BODY('ghost', 'x') },
    { agent: agent([callEvent('read', 'ghost')]), callId: 'c6', signal: new AbortController().signal },
  )
  assert.equal(missing.ok, false)
  assert.ok(missing.message.includes('不存在'))
  clean(dir)
})

test('hasReadSkill scans the session log for skill_manage read calls', () => {
  const event = (name, args) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args) } })
  const agent = { session: { events: [
    event('skill_manage', { action: 'read', name: 'alpha' }),
    event('skill_manage', { action: 'create', name: 'beta' }),
    event('skill', { name: 'gamma' }),
    { type: 'user/message', data: { message: { content: [] } } },
  ] } }
  assert.equal(hasReadSkill(agent, 'skill_manage', 'alpha'), true)
  assert.equal(hasReadSkill(agent, 'skill_manage', 'beta'), false) // create is not a read
  assert.equal(hasReadSkill(agent, 'skill_manage', 'gamma'), false) // skill tool is a different tool
  assert.equal(hasReadSkill(undefined, 'skill_manage', 'alpha'), false)
  assert.equal(hasReadSkill({ session: {} }, 'skill_manage', 'alpha'), false)
})

test('disabled skills are skipped through the ctx.skills registry', async () => {
  const dir = tempDir()
  const disabled = [{ name: 'disabled-skill', invocation: { modelInvocable: false } }]
  const ctx = fakeCtx({
    get: (key) => (key === 'skills' ? { list: async () => disabled } : undefined),
  })
  const tool = skillManageTool(ctx, { skillDir: dir, memoryDir: dir, skillManageToolName: 'skill_manage', skillMaxBytes: 65536 })
  const result = await tool.execute(
    { action: 'create', name: 'disabled-skill', description: 'x', body: GOOD_BODY('disabled-skill', 'x') },
    FAKE_EXEC(),
  )
  assert.equal(result.ok, false)
  assert.ok(result.message.includes('禁用'))
  assert.equal(readSkill(dir, 'disabled-skill'), undefined)
  clean(dir)
})

test('missing skills service degrades to "not disabled"', async () => {
  const dir = tempDir()
  const tool = skillManageTool(fakeCtx(), { skillDir: dir, memoryDir: dir, skillManageToolName: 'skill_manage', skillMaxBytes: 65536 })
  const result = await tool.execute(
    { action: 'create', name: 'plain-skill', description: 'x', body: GOOD_BODY('plain-skill', 'x') },
    FAKE_EXEC(),
  )
  assert.equal(result.ok, true)
  clean(dir)
})

test('frontmatter values with colon+space must be quoted (YAML compatibility)', async () => {
  const dir = tempDir()
  const tool = skillManageTool(fakeCtx(), { skillDir: dir, memoryDir: dir, skillManageToolName: 'skill_manage', skillMaxBytes: 65536 })
  // unquoted description with `: ` is rejected (DSH skill-local parses with
  // strict YAML and would silently skip the skill)
  const unquoted = await tool.execute(
    { action: 'create', name: 'colon-skill', description: 'a: b', body: '---\nname: colon-skill\ndescription: Verify a tool: build a matrix\n---\nbody' },
    FAKE_EXEC(),
  )
  assert.equal(unquoted.ok, false)
  assert.ok(unquoted.message.includes('双引号'))
  // quoted description with `: ` is accepted
  const quoted = await tool.execute(
    { action: 'create', name: 'colon-skill', description: 'Verify a tool: build a matrix', body: '---\nname: colon-skill\ndescription: "Verify a tool: build a matrix"\n---\nbody' },
    FAKE_EXEC(),
  )
  assert.equal(quoted.ok, true)
  // parseFrontmatter round-trips the quoted value
  const parsed = parseFrontmatter(readFileSync(join(dir, 'colon-skill', 'SKILL.md'), 'utf8'))
  assert.equal(parsed.description, 'Verify a tool: build a matrix')
  clean(dir)
})

test('review subagent creations go to the pending queue and approve moves them', async () => {
  const dir = tempDir()
  const tool = skillManageTool(fakeCtx(), { skillDir: dir, memoryDir: dir, skillReviewEnabled: false, skillManageToolName: 'skill_manage', skillMaxBytes: 65536 })
  const subExec = () => ({
    agent: { id: 'child', session: { header: { origin: 'subagent' } } },
    callId: 'c2',
    signal: new AbortController().signal,
  })
  const body = GOOD_BODY('pending-skill', '待确认技能')

  // Default (skillReviewEnabled false): the review subagent's create lands in
  // pending-skills, NOT the live skills dir.
  const created = await tool.execute({ action: 'create', name: 'pending-skill', description: '待确认技能', body }, subExec())
  assert.equal(created.ok, true)
  assert.ok(created.message.includes('待确认队列'))
  assert.equal(existsSync(join(dir, 'pending-skill')), false, 'not installed into the live dir')
  assert.equal(readFileSync(join(dir, 'pending-skills', 'pending-skill', 'SKILL.md'), 'utf8'), body)

  // Duplicate in the pending queue is refused.
  const dup = await tool.execute({ action: 'create', name: 'pending-skill', description: '待确认技能', body }, subExec())
  assert.equal(dup.ok, false)
  assert.ok(dup.message.includes('待确认队列已有'))

  // Approving moves the directory into the live skills dir.
  const approved = approvePendingSkill(join(dir, 'pending-skills'), dir, 'pending-skill')
  assert.equal(approved.ok, true)
  assert.equal(existsSync(join(dir, 'pending-skills', 'pending-skill')), false)
  assert.equal(readFileSync(join(dir, 'pending-skill', 'SKILL.md'), 'utf8'), body)

  // Approving again (now live) is refused to avoid overwrites.
  const again = approvePendingSkill(join(dir, 'pending-skills'), dir, 'pending-skill')
  assert.equal(again.ok, false)

  // Reject removes the pending entry.
  const tool2 = skillManageTool(fakeCtx(), { skillDir: dir, memoryDir: dir, skillReviewEnabled: false, skillManageToolName: 'skill_manage', skillMaxBytes: 65536 })
  await tool2.execute({ action: 'create', name: 'reject-me', description: 'x', body: GOOD_BODY('reject-me', 'x') }, subExec())
  assert.equal(listPendingSkills(join(dir, 'pending-skills')).length, 1)
  const rejected = rejectPendingSkill(join(dir, 'pending-skills'), 'reject-me')
  assert.equal(rejected.ok, true)
  assert.equal(listPendingSkills(join(dir, 'pending-skills')).length, 0)
  clean(dir)
})

test('skillReviewEnabled true lets the review subagent create directly', async () => {
  const dir = tempDir()
  const tool = skillManageTool(fakeCtx(), { skillDir: dir, memoryDir: dir, skillReviewEnabled: true, skillManageToolName: 'skill_manage', skillMaxBytes: 65536 })
  const subExec = () => ({
    agent: { id: 'child', session: { header: { origin: 'subagent' } } },
    callId: 'c3',
    signal: new AbortController().signal,
  })
  const created = await tool.execute({ action: 'create', name: 'direct-skill', description: '直接创建', body: GOOD_BODY('direct-skill', '直接创建') }, subExec())
  assert.equal(created.ok, true)
  assert.equal(readFileSync(join(dir, 'direct-skill', 'SKILL.md'), 'utf8'), GOOD_BODY('direct-skill', '直接创建'))
  clean(dir)
})
