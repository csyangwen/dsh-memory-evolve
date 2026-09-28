/**
 * issue #67 回归：`config.skillDir` 的 `null` 哨兵必须有**唯一且显式**的落地点，
 * 且内置技能同步的失败/异常不能是哑的。
 *
 * 背景：`lib/index.js` 的默认配置写 `skillDir: null`（语义 = "用技能库默认目录"），
 * `resolveConfig()` 会把它实体化成 `~/.agents/skills`。issue #67 报告"这一层没解析
 * 就被传给 `syncBuiltinSkills()` 并抛 TypeError，而调用点的 try/catch 只 warn"——
 * 研判结论是：**解析其实一直生效**（`resolveConfig()` 自首个提交起就有这行），
 * 真实的可达性问题是 issue #58（同步调用点被 `coiEnabled` 门控）。因此本文件钉的
 * 是三条**仍然值得钉住**的契约：
 *
 *   1. 哨兵解析只有一处权威——`DEFAULT_SKILL_DIR` 与 `resolveConfig()` 必须一致，
 *      否则"null 表示默认库"这句话会在两处各有一个答案；
 *   2. 函数边界显式——收到未解析的哨兵时抛**看得懂**的错，而不是 Node 的
 *      `The "path" argument must be of type string. Received null`；
 *   3. 打包完整——内置技能清单里的每一项都真的在插件包 `skills/` 里，
 *      把运行期静默的 `action: 'missing'` 变成一条会红的测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILTIN_SKILLS, DEFAULT_SKILL_DIR, normalizeSkillText, syncBuiltinSkills } from '../lib/coi/skills-sync.js'
import { resolveConfig } from '../lib/index.js'

/** 插件包内 skills/ 目录（内置技能源头）。 */
const PLUGIN_SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

test('DEFAULT_SKILL_DIR 与 resolveConfig() 的哨兵解析必须一致', () => {
  assert.equal(DEFAULT_SKILL_DIR, join(homedir(), '.agents', 'skills'))
  // 未解析的哨兵（默认配置）与显式传哨兵，都必须落到同一个目录
  assert.equal(resolveConfig({}).skillDir, DEFAULT_SKILL_DIR, '默认配置的 skillDir 必须解析成 DEFAULT_SKILL_DIR')
  assert.equal(resolveConfig({ skillDir: null }).skillDir, DEFAULT_SKILL_DIR, '显式 null 哨兵同样解析成默认库')
  // 显式配置不被覆盖
  const custom = join(tmpdir(), 'me-custom-skills')
  assert.equal(resolveConfig({ skillDir: custom }).skillDir, custom)
})

test('syncBuiltinSkills：收到未解析的哨兵要抛看得懂的错，而不是 Node 的 path TypeError', () => {
  for (const bad of [null, undefined, '']) {
    assert.throws(
      () => syncBuiltinSkills(PLUGIN_SKILLS_DIR, bad),
      (error) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /userSkillsDir/, `报错必须点名参数（收到 ${JSON.stringify(bad)}）`)
        assert.match(error.message, /DEFAULT_SKILL_DIR|resolveConfig/, '报错必须指出正确做法')
        assert.doesNotMatch(error.message, /The "path" argument must be of type string/, '不得把 Node 的底层 TypeError 直接抛出来')
        return true
      },
    )
  }
})

test('内置技能清单与插件包内容一致（打包守卫：把静默的 missing 变成红测试）', () => {
  for (const name of BUILTIN_SKILLS) {
    const file = join(PLUGIN_SKILLS_DIR, name, 'SKILL.md')
    assert.ok(existsSync(file), `插件包缺少内置技能 ${name}（${file}）——运行期会静默记成 action: 'missing'`)
    const text = readFileSync(file, 'utf8')
    // 容忍 CRLF：Windows 上 core.autocrlf=true 检出的就是 CRLF
    assert.match(text, /^---\r?\n/, `${name}/SKILL.md 必须有 frontmatter`)
    assert.match(text, /\r?\nname:[ \t]*\S+/, `${name}/SKILL.md frontmatter 必须含 name`)
    assert.match(text, /\r?\ndescription:[ \t]*\S+/, `${name}/SKILL.md frontmatter 必须含 description`)
  }
})

test('syncBuiltinSkills：用插件包真实内容同步，五个技能全部落地且不含 missing', () => {
  const userSkills = mkdtempSync(join(tmpdir(), 'me-skills-'))
  try {
    const first = syncBuiltinSkills(PLUGIN_SKILLS_DIR, userSkills)
    assert.equal(first.length, BUILTIN_SKILLS.length)
    assert.deepEqual(first.filter((r) => r.action === 'missing'), [], '不得有 missing（源目录必须齐全）')
    assert.deepEqual(first.map((r) => r.name).sort(), [...BUILTIN_SKILLS].sort())
    assert.deepEqual(first.filter((r) => r.action === 'synced').length, BUILTIN_SKILLS.length, '首次同步应全部落盘')
    for (const name of BUILTIN_SKILLS) {
      assert.ok(existsSync(join(userSkills, name, 'SKILL.md')), `${name} 未落盘`)
    }
    // 幂等：第二次全部 unchanged（用户编辑保护 + 不重复写盘）
    const second = syncBuiltinSkills(PLUGIN_SKILLS_DIR, userSkills)
    assert.deepEqual(second.filter((r) => r.action !== 'unchanged'), [], '第二次必须全部 unchanged')
  } finally {
    rmSync(userSkills, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------------------
// CRLF（Windows 检出）：版本门控与 frontmatter 识别都必须容忍

test('skillVersion 容忍 CRLF：x-version 升级在 Windows 检出上同样生效', () => {
  // 缺陷：旧写法 `^---\\n` 只认 LF，CRLF 的 SKILL.md 解析出 0——源与目标都取 0，
  // 版本门控退化成"永远相等"，x-version 升级在 Windows 上静默失效
  // （首次安装因目标不存在仍会复制，所以只有"升级不生效"这一半可见）。
  const dir = mkdtempSync(join(tmpdir(), 'me-skills-crlf-'))
  const pluginSkills = join(dir, 'plugin-skills')
  const userSkills = join(dir, 'user-skills')
  const crlf = (version) => `---\r\nname: kimi-cli-calling\r\nx-version: ${version}\r\ndescription: 测试\r\n---\r\n# v${version}\r\n`
  mkdirSync(join(pluginSkills, 'kimi-cli-calling'), { recursive: true })
  writeFileSync(join(pluginSkills, 'kimi-cli-calling', 'SKILL.md'), crlf(1))
  try {
    assert.equal(syncBuiltinSkills(pluginSkills, userSkills).find((r) => r.name === 'kimi-cli-calling').action, 'synced')
    // 版本不变 → unchanged（用户编辑保护仍然有效）
    writeFileSync(join(pluginSkills, 'kimi-cli-calling', 'SKILL.md'), crlf(1))
    assert.equal(syncBuiltinSkills(pluginSkills, userSkills).find((r) => r.name === 'kimi-cli-calling').action, 'unchanged')
    // **版本升级 → 必须覆盖**（这条在旧实现下必失败）
    writeFileSync(join(pluginSkills, 'kimi-cli-calling', 'SKILL.md'), crlf(2))
    assert.equal(
      syncBuiltinSkills(pluginSkills, userSkills).find((r) => r.name === 'kimi-cli-calling').action,
      'synced',
      'CRLF 的 SKILL.md 也必须能识别出版本升级',
    )
    assert.ok(readFileSync(join(userSkills, 'kimi-cli-calling', 'SKILL.md'), 'utf8').includes('# v2'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('normalizeSkillText 容忍 CRLF：已有 frontmatter 不被误判成"没有"', () => {
  const crlf = '---\r\nname: my-skill\r\ndescription: 说明\r\n---\r\n正文\r\n'
  const out = normalizeSkillText(crlf, 'my-skill', 'Kimi')
  // 入口先 trim，所以比较基准是去掉首尾空白后的原文
  assert.equal(out, crlf.trim(), 'CRLF 且字段齐全时必须原样返回，不得叠加第二份 frontmatter')
  assert.equal(out.match(/^---/gm).length, 2, '只应有一对 --- 边界')
  // 缺字段仍要报错（CRLF 下也不能漏判）
  assert.throws(
    () => normalizeSkillText('---\r\nname: x\r\n---\r\n正文\r\n', 'x', 'Kimi'),
    /缺少必填字段.*description/,
  )
  // 未闭合同样要报错
  assert.throws(() => normalizeSkillText('---\r\nname: x\r\ndescription: y\r\n', 'x', 'Kimi'), /未闭合/)
})
