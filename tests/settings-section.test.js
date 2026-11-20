import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_SRC = readFileSync(join(ROOT, 'src/client/index.ts'), 'utf8')
const SETTINGS_SRC = readFileSync(join(ROOT, 'src/client/SettingsTabView.tsx'), 'utf8')
const BUNDLE = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')

test('plugin registers settings page under DSH global settings.section instead of conversation.view', () => {
  assert.match(INDEX_SRC, /ctx\.slots\.inject\(\s*'settings\.section'/u)
  assert.match(INDEX_SRC, /ctx\.slots\.inject\(\s*'settings\.section\.icon'/u)
  assert.match(INDEX_SRC, /id:\s*'memory-evolve'/u)
  assert.doesNotMatch(INDEX_SRC, /id:\s*'settings-hub'/u)
})

test('global Settings section mounts before memoryTabEnabled guard', () => {
  const registerIdx = INDEX_SRC.indexOf('registerSettingsTab()')
  const guardIdx = INDEX_SRC.indexOf('memoryTabEnabled !== true')
  assert.ok(registerIdx > -1, 'registerSettingsTab() call must exist')
  assert.ok(guardIdx > -1, 'memoryTabEnabled guard must exist')
  assert.ok(registerIdx < guardIdx, 'Settings section must register even when session memory tabs are disabled')
})

test('SettingsTabView uses global settings container class and exports icon component', () => {
  assert.match(SETTINGS_SRC, /className="mt-panel me-settings-section"/u)
  assert.match(SETTINGS_SRC, /export function MemoryEvolveSettingsIcon\b/u)
})

test('built bundle reflects global settings.section registration without settings-hub', () => {
  assert.ok(BUNDLE.includes('settings.section'), 'lib/client.js must register settings.section')
  assert.ok(BUNDLE.includes('settings.section.icon'), 'lib/client.js must register settings.section.icon')
  assert.ok(BUNDLE.includes('memory-evolve'), 'lib/client.js must use memory-evolve section id')
  assert.ok(BUNDLE.includes('me-settings-section'), 'lib/client.js must include me-settings-section layout class')
  assert.ok(!/["']settings-hub["']/u.test(BUNDLE), 'lib/client.js must not register legacy settings-hub conversation tab')
})
