/**
 * DSH settings 服务版本兼容层测试（2026-09-28，0.2.0 适配）。
 *
 * 覆盖：
 *   1) 老宿主（≤0.1.5-rc.2）：settings.get(ns) 路径；
 *   2) 新宿主（≥0.2.0-rc.1）：settings 已移除 get()，改用 describe() 列表；
 *   3) 服务缺失 / get 抛错 / describe 抛错 / ns 未注册 → 一律 undefined 不抛；
 *   4) makeSettingsReader 的批量语义（新宿主只 describe 一次）；
 *   5) 事件名常量：新老两个名字都在，监听方两个都订阅才不丢事件；
 *   6) resolveLocale 在新老两种服务形态下都能解析出 'en'。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  SETTINGS_CHANGE_EVENTS,
  resolveSettingsService,
  hasSettingsRead,
  readSettingsValue,
  readSettingsNamespace,
  makeSettingsReader,
} from '../lib/settings-compat.js'
import { resolveLocale } from '../lib/i18n.js'

/** 老宿主形态：settings.get(ns) 直接给值。 */
function legacyService(table) {
  return { get: (ns) => table[ns] }
}

/** 新宿主形态（DSH 0.2.0+）：只有 describe()，返回 { ns, value } 列表。 */
function describeService(table, counter = { calls: 0 }) {
  return {
    describe: () => {
      counter.calls += 1
      return Object.entries(table).map(([ns, value]) => ({ ns, value, schema: {}, revision: 1 }))
    },
    counter,
  }
}

test('SETTINGS_CHANGE_EVENTS lists the new event first and keeps the legacy name', () => {
  assert.deepEqual(SETTINGS_CHANGE_EVENTS, ['settings/document-updated', 'settings/updated'])
})

test('legacy host: settings.get(ns) is used and returns the namespace value', () => {
  const settings = legacyService({ locale: { preference: 'en' } })
  assert.equal(hasSettingsRead(settings), true)
  assert.deepEqual(readSettingsValue(settings, 'locale'), { preference: 'en' })
  assert.equal(readSettingsValue(settings, 'unknown'), undefined)
})

test('new host: describe() list is searched by ns (get() absent)', () => {
  const settings = describeService({ locale: { preference: 'en' }, models: { a: 1 } })
  assert.equal(typeof settings.get, 'undefined')
  assert.equal(hasSettingsRead(settings), true)
  assert.deepEqual(readSettingsValue(settings, 'locale'), { preference: 'en' })
  assert.deepEqual(readSettingsValue(settings, 'models'), { a: 1 })
  assert.equal(readSettingsValue(settings, 'missing'), undefined)
})

test('missing service, non-read service, and empty ns are safe no-ops', () => {
  assert.equal(hasSettingsRead(undefined), false)
  assert.equal(hasSettingsRead({}), false)
  assert.equal(readSettingsValue(undefined, 'locale'), undefined)
  assert.equal(readSettingsValue({}, 'locale'), undefined)
  assert.equal(readSettingsValue(legacyService({ locale: 1 }), ''), undefined)
  assert.equal(readSettingsValue(legacyService({ locale: 1 }), undefined), undefined)
})

test('throwing get()/describe() degrades to undefined instead of propagating', () => {
  const throwingGet = { get: () => { throw new Error('boom') } }
  const throwingDescribe = { describe: () => { throw new Error('boom') } }
  assert.equal(readSettingsValue(throwingGet, 'locale'), undefined)
  assert.equal(readSettingsValue(throwingDescribe, 'locale'), undefined)
  const reader = makeSettingsReader({ get: () => { throw new Error('boom') } })
  assert.equal(reader('locale'), undefined)
})

test('describe() returning a non-array (host shape drift) is tolerated', () => {
  assert.equal(readSettingsValue({ describe: () => ({ locale: { preference: 'en' } }) }, 'locale'), undefined)
})

test('resolveSettingsService prefers ctx.get("settings") and falls back to ctx.settings', () => {
  const viaGet = legacyService({ a: 1 })
  assert.equal(resolveSettingsService({ get: (key) => (key === 'settings' ? viaGet : undefined) }), viaGet)
  const direct = legacyService({ b: 2 })
  assert.equal(resolveSettingsService({ settings: direct }), direct)
  assert.equal(resolveSettingsService(undefined), undefined)
})

test('readSettingsNamespace: old ctx.get service and new describe service both resolve', () => {
  const oldCtx = { get: (key) => (key === 'settings' ? legacyService({ locale: { preference: 'en' } }) : undefined) }
  const newCtx = { get: (key) => (key === 'settings' ? describeService({ locale: { preference: 'zh' } }) : undefined) }
  assert.deepEqual(readSettingsNamespace(oldCtx, 'locale'), { preference: 'en' })
  assert.deepEqual(readSettingsNamespace(newCtx, 'locale'), { preference: 'zh' })
  assert.equal(readSettingsNamespace({}, 'locale'), undefined)
})

test('makeSettingsReader batches new-host reads into one describe() call', () => {
  const settings = describeService({ a: 1, b: 2, c: 3 })
  const read = makeSettingsReader({ get: (key) => (key === 'settings' ? settings : undefined) })
  assert.equal(read('a'), 1)
  assert.equal(read('c'), 3)
  assert.equal(read('b'), 2)
  assert.equal(read('missing'), undefined)
  assert.equal(settings.counter.calls, 1, 'describe() must run exactly once per reader')
})

test('makeSettingsReader on the legacy host forwards every read to get()', () => {
  let calls = 0
  const settings = { get: (ns) => { calls += 1; return ns === 'a' ? 1 : undefined } }
  const read = makeSettingsReader({ get: (key) => (key === 'settings' ? settings : undefined) })
  assert.equal(read('a'), 1)
  assert.equal(read('a'), 1)
  assert.equal(calls, 2, 'legacy host keeps get() live per call (no stale snapshot)')
})

test('makeSettingsReader without any settings service always answers undefined', () => {
  const read = makeSettingsReader({})
  assert.equal(read('locale'), undefined)
})

test('resolveLocale reads the new describe() shape and still understands the legacy one', () => {
  const newCtx = { get: (key) => (key === 'settings' ? describeService({ locale: { preference: 'en' } }) : undefined) }
  const oldCtx = { get: (key) => (key === 'settings' ? legacyService({ locale: { preference: 'en' } }) : undefined) }
  const unsetCtx = { get: (key) => (key === 'settings' ? describeService({ locale: {} }) : undefined) }
  assert.equal(resolveLocale(newCtx), 'en')
  assert.equal(resolveLocale(oldCtx), 'en')
  assert.equal(resolveLocale(unsetCtx), 'zh', 'unset preference keeps the historical Chinese default')
  assert.equal(resolveLocale({}), 'zh')
})
