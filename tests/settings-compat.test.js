/**
 * settings-compat + 模型快照读取路径的回归测试。
 *
 * 背景（2026-09-28 实证）：宿主 0.1.7-rc.2 把 settings 服务换成 forms 形态
 * （describe/update/replace/mutate），旧 `get(ns)` 被移除——`lib/models.js` 的
 * `ctx.settings.get(ns)` 直接抛 TypeError，使 GET /memory-evolve/api/models 返回
 * 400 `{"error":"ctx.settings.get is not a function"}`。本文件把两代读取路径与
 * 「读不到也不抛」的降级行为钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settingsEntryIndex, readSettingsEntry, canWriteSettings } from '../lib/settings-compat.js'
import { buildModelsSnapshotAsync } from '../lib/models.js'

/** 假 llm 服务：一个可配置供应商 + 一个模型 + 思考等级/模态元数据。 */
function fakeLlm() {
  return {
    listConfigurableProviders: () => [{ provider: 'p', displayName: 'P', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'p'] }],
    listProviders: () => [{ id: 'p' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }, inputModalities: ['text', 'image'] }),
  }
}

/** 假 ModelConfigStore（无插件级覆盖）。 */
const fakeStore = { entry: () => undefined }

test('settings-compat：旧宿主（0.1.0-rc.x）走 get(ns)', () => {
  let asked = 0
  const legacy = { get: (ns) => { asked += 1; return { ns, preference: 'en' } } }
  assert.deepEqual(readSettingsEntry(legacy, 'locale'), { ns: 'locale', preference: 'en' })
  assert.equal(asked, 1)
  // 旧宿主没有 describe，索引为空表但不抛错
  assert.equal(settingsEntryIndex(legacy).size, 0)
  assert.equal(canWriteSettings(legacy), false, '只有 get 不算可写（需 register 或 update）')
})

test('settings-compat：新宿主（0.1.7+）走 describe()，索引覆盖全部 entry', () => {
  let described = 0
  const forms = {
    describe: () => { described += 1; return [{ ns: 'llm-pi-ai', value: { providers: { p: { models: [{ id: 'm1' }] } } } }, { ns: 'locale', value: { preference: 'en' } }] },
    update: async () => {},
  }
  const index = settingsEntryIndex(forms)
  assert.equal(index.size, 2)
  assert.deepEqual(readSettingsEntry(forms, 'locale'), { preference: 'en' })
  assert.equal(readSettingsEntry(forms, 'nope'), undefined, '未注册的 ns 返回 undefined（按未覆盖处理）')
  assert.equal(described, 3, 'readSettingsEntry 每次现取；索引只建一次')
  assert.equal(canWriteSettings(forms), true, 'update 存在即可写')
})

test('settings-compat：两代都缺失 / describe 抛错时降级为 undefined，绝不抛', () => {
  assert.equal(readSettingsEntry(undefined, 'x'), undefined)
  assert.equal(readSettingsEntry({}, 'x'), undefined)
  assert.equal(readSettingsEntry({ describe: () => { throw new Error('boom') } }, 'x'), undefined)
  assert.equal(settingsEntryIndex({ describe: () => { throw new Error('boom') } }).size, 0)
  assert.equal(readSettingsEntry({ get: () => { throw new Error('boom') } }, 'x'), undefined)
  assert.equal(canWriteSettings(null), false)
})

test('模型快照：新宿主 forms 形态下不再抛 TypeError，且读到 entry 里的供应商配置', async () => {
  const ctx = {
    llm: fakeLlm(),
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { p: { models: [{ id: 'm1', name: 'M1' }] } } } }] },
  }
  const snapshot = await buildModelsSnapshotAsync(ctx, fakeStore)
  assert.equal(snapshot.providers.length, 1)
  assert.equal(snapshot.providers[0].models.length, 1, '从 describe() 读到的模型必须出现在快照里')
  assert.equal(snapshot.providers[0].models[0].id, 'm1')
  assert.equal(snapshot.providers[0].models[0].supportsImage, true, 'adapter 元数据仍参与聚合')
})

test('模型快照：旧宿主 get(ns) 路径保持原行为', async () => {
  const ctx = {
    llm: fakeLlm(),
    settings: { get: (ns) => (ns === 'llm-pi-ai' ? { providers: { p: { models: [{ id: 'legacy' }] } } } : undefined) },
  }
  const snapshot = await buildModelsSnapshotAsync(ctx, fakeStore)
  assert.equal(snapshot.providers[0].models[0].id, 'legacy')
})

test('模型快照：settings 服务整体缺失时仍返回快照（仅无供应商配置）', async () => {
  const snapshot = await buildModelsSnapshotAsync({ llm: fakeLlm() }, fakeStore)
  assert.equal(snapshot.providers.length, 1)
  assert.deepEqual(snapshot.providers[0].models, [], '读不到配置 → 无模型行，但不抛错')
})
