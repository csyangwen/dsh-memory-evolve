/**
 * 客户端 bundle 契约测试：验证 lib/client.js 的 ModuleLoader 包装格式与
 * 导出面（id 与 package.json name 一致 / inject / apply），以及新增的目录
 * 选择器子模块注册点存在。
 *
 * mock window.__ModuleLoader__ 记录 handoff；factory(require) 返回的 surface
 * 须含 inject/apply；require 表必须覆盖全部 external 键（platform 模块表）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** 与 scripts/build.mjs EXTERNALS 对齐的平台模块表（mock 版）。 */
const EXTERNAL_KEYS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

test('bundle: ModuleLoader handoff id === package.json name，导出面含 inject/apply', () => {
  const code = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  let handoff = null
  const loader = { load: (entry) => { handoff = entry } }
  const sandbox = {
    window: { __ModuleLoader__: loader },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)

  assert.ok(handoff !== null, 'bundle 必须调用 __ModuleLoader__.load')
  assert.equal(handoff.id, MANIFEST.name, '注册 id 必须与 package.json name 一致（否则 mis-stamped）')

  const requireMock = (id) => {
    if (!EXTERNAL_KEYS.includes(id)) throw new Error(`bundle 引用了平台表外的模块: ${id}`)
    return id === 'cordis' ? {} : {}
  }
  const surface = handoff.factory(requireMock)
  assert.ok(Array.isArray(surface.inject), 'surface 必须导出 inject 数组')
  assert.equal(typeof surface.apply, 'function', 'surface 必须导出 apply')
  // 目录选择器需要 workspaces 服务（pickDirectory/listDirectory/createDirectory）
  assert.ok(surface.inject.includes('workspaces'), 'inject 必须含 workspaces')
  assert.ok(surface.inject.includes('slots'), 'inject 必须含 slots')
})

test('bundle: 目录选择器子模块代码已打包（occupant/判定/官方组件本地化）', () => {
  const code = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  // 二合一 occupant + 本机判定
  assert.ok(code.includes('SmartDirectoryFlow'), '缺少 SmartDirectoryFlow occupant')
  assert.ok(code.includes('isLoopbackLocation'), '缺少本机判定')
  assert.ok(code.includes('directoryPickerNative'), '缺少目录选择器功能开关读取')
  assert.ok(code.includes('Select Workspace Directory') || code.includes('选择工作区目录'), '缺少 DirectoryBrowser 词典')
  // 官方组件本地化产物（dp- 前缀样式）
  assert.ok(code.includes('dp-dialog'), '缺少 DirectoryBrowser 本地化样式')
})
