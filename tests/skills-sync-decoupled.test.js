/**
 * issue #58 回归：内置技能同步必须**与 COI 调度解耦**。
 *
 * 缺陷：`syncBuiltinSkills()` 的调用点曾在 `installCoi()` 内，而 `installCoi`
 * 由 `coiEnabled` 门控（默认 `false`——本插件本职是记忆/待办/技能，调度是按需
 * 增强）。于是**默认配置下内置技能永远不会进技能库**：`memory-consolidate` 与
 * kimi/codex/grok/hermes 四个 CLI 使用指南在 `~/.agents/skills` 与会话技能列表
 * 里都不出现，且因为调用点包着 try/catch 只打一行 warn，连痕迹都留不下。
 * 与 §7.5 broadcast 当初"独立子模块挂在 COI 下拆不开"是同款事故。
 *
 * 修复：同步提到插件主装配（`lib/index.js` 的 `apply()`），实现抽成
 * `syncBuiltinSkillsIfEnabled(config, pluginSkillsDir?)`，**判定只看
 * `coiSyncSkills`，不再出现 `coiEnabled`**。
 *
 * 本文件覆盖单元层（直接调 `syncBuiltinSkillsIfEnabled`）；装配层（跑真实
 * `apply()`）在 `tests/plugin.test.js` 的两个 issue #58 用例里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUILTIN_SKILLS, DEFAULT_SKILL_DIR, PLUGIN_SKILLS_DIR, syncBuiltinSkillsIfEnabled,
} from '../lib/coi/skills-sync.js'

/** 仓库根（用于断言内置技能源头确实在包内）。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-me-skills-decoupled-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** 在回调执行期间截获 console.log / console.warn（同步函数，无需还原竞态）。 */
function captureConsole(fn) {
  const logs = []
  const warns = []
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = (...args) => logs.push(args.join(' '))
  console.warn = (...args) => warns.push(args.join(' '))
  try {
    fn()
  } finally {
    console.log = originalLog
    console.warn = originalWarn
  }
  return { logs, warns }
}

test('源头在包内：PLUGIN_SKILLS_DIR 指向仓库的 skills/，五个内置技能齐全', () => {
  assert.ok(PLUGIN_SKILLS_DIR.startsWith(PACKAGE_ROOT), `源头必须在包内：${PLUGIN_SKILLS_DIR}`)
  assert.equal(PLUGIN_SKILLS_DIR.replaceAll('\\', '/').endsWith('/skills/'), true, '必须指向 skills/ 目录')
  for (const name of BUILTIN_SKILLS) {
    assert.ok(existsSync(join(PLUGIN_SKILLS_DIR, name, 'SKILL.md')), `内置技能缺少源头文件：${name}`)
  }
})

test('coiEnabled=false 不影响同步（issue #58 的要害）', () => {
  const dir = tempDir()
  try {
    // ⚠️ 刻意同时传入 coiEnabled: false——旧实现里正是这个开关决定同步跑不跑
    const synced = syncBuiltinSkillsIfEnabled(
      { coiEnabled: false, skillDir: dir },
      PLUGIN_SKILLS_DIR,
    )
    assert.equal(Array.isArray(synced), true, '必须真的执行同步并返回结果')
    assert.equal(synced.length, BUILTIN_SKILLS.length)
    assert.deepEqual(synced.filter((r) => r.action === 'missing'), [])
    assert.deepEqual(synced.filter((r) => r.action === 'synced').length, BUILTIN_SKILLS.length, '全部落盘')
    assert.deepEqual(readdirSync(dir).sort(), [...BUILTIN_SKILLS].sort())
  } finally {
    clean(dir)
  }
})

test('coiSyncSkills=false 是唯一的关断开关（coiEnabled=true 也照样不同步）', () => {
  const dir = tempDir()
  const skills = join(dir, 'user-skills') // 尚不存在的路径：关断时连目录都不该创建
  try {
    const synced = syncBuiltinSkillsIfEnabled(
      { coiEnabled: true, coiSyncSkills: false, skillDir: skills },
      PLUGIN_SKILLS_DIR,
    )
    assert.equal(synced, null, '关闭时返回 null（调用方据此判断"没跑"而不是"跑了但没变化"）')
    assert.equal(existsSync(skills), false, '不得创建技能库目录')
  } finally {
    clean(dir)
  }
})

test('skillDir 为 null 哨兵时落到 DEFAULT_SKILL_DIR（用空源头避免写入真实技能库）', () => {
  // 用**空的内置技能源头**：五个技能全部 action:'missing' → 一次 cpSync 都不会
  // 发生，因此即使解析到真实的 ~/.agents/skills 也不会写入任何东西。目标目录
  // 由日志行断言。
  const pluginSkills = tempDir()
  try {
    const { logs, warns } = captureConsole(() => syncBuiltinSkillsIfEnabled(
      { coiSyncSkills: true, skillDir: null },
      pluginSkills,
    ))
    assert.equal(logs.length, 1, '每次同步都要落一行可见日志（issue #67）')
    assert.ok(logs[0].includes(DEFAULT_SKILL_DIR), `日志必须写明目标目录（DEFAULT_SKILL_DIR）：${logs[0]}`)
    assert.equal(warns.length, 1, '五个源头全缺 → 必须 warn 一次（打包事故不能静默）')
    assert.match(warns[0], /缺少内置技能/)
  } finally {
    clean(pluginSkills)
  }
})

test('同步抛错不阻断启动：收口成一条带原因的 warn 并返回 null', () => {
  const dir = tempDir()
  try {
    // 传一个未解析的哨兵给底层（模拟装配错误）：syncBuiltinSkills 会抛，
    // syncBuiltinSkillsIfEnabled 必须收口而不是让异常冒到 apply() 里。
    const { warns } = captureConsole(() => {
      const synced = syncBuiltinSkillsIfEnabled({ coiSyncSkills: true, skillDir: '' }, PLUGIN_SKILLS_DIR)
      assert.equal(synced, null)
    })
    assert.equal(warns.length, 1)
    assert.match(warns[0], /内置技能同步失败/)
    void dir
  } finally {
    clean(dir)
  }
})

test('每次启动都汇报同步结果（含"全部 unchanged"这种最常见的情况）', () => {
  const dir = tempDir()
  try {
    const first = captureConsole(() => syncBuiltinSkillsIfEnabled({ skillDir: dir }, PLUGIN_SKILLS_DIR))
    assert.equal(first.logs.length, 1)
    assert.match(first.logs[0], /更新 5 个/)
    const second = captureConsole(() => syncBuiltinSkillsIfEnabled({ skillDir: dir }, PLUGIN_SKILLS_DIR))
    assert.equal(second.logs.length, 1, '没有变更也要 log——这正是"技能到底装没装"最需要的一行')
    assert.match(second.logs[0], /共 5 个，更新 0 个/)
    assert.equal(second.warns.length, 0)
  } finally {
    clean(dir)
  }
})

test('内置技能源头缺失时逐个记 missing 并 warn（打包守卫的运行期那一半）', () => {
  const emptySource = tempDir()
  const skills = tempDir()
  try {
    mkdirSync(skills, { recursive: true })
    const { warns } = captureConsole(() => {
      const synced = syncBuiltinSkillsIfEnabled({ skillDir: skills }, emptySource)
      assert.deepEqual(synced.map((r) => r.action), BUILTIN_SKILLS.map(() => 'missing'))
    })
    assert.equal(warns.length, 1)
    assert.ok(warns[0].includes('memory-consolidate'), 'warn 必须点名缺了哪些技能')
    assert.deepEqual(readdirSync(skills), [], 'missing 不得写入任何东西')
  } finally {
    clean(emptySource)
    clean(skills)
  }
})

test('写入失败（skillDir 被同名文件占位）时收口成 warn，不抛给调用方', () => {
  const dir = tempDir()
  try {
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'not a directory')
    const { warns } = captureConsole(() => {
      // 目标路径被文件占位 → cpSync/mkdirSync 必失败 → 必须收口
      const synced = syncBuiltinSkillsIfEnabled({ skillDir: join(blocked, 'nested') }, PLUGIN_SKILLS_DIR)
      assert.equal(synced, null)
    })
    assert.equal(warns.length, 1)
    assert.match(warns[0], /内置技能同步失败/)
  } finally {
    clean(dir)
  }
})
