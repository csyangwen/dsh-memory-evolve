import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TemplateStore, BUILTIN_TEMPLATES } from '../lib/coi/templates.js'
import { setLocale, getLocale, translate, COI_DICT } from '../lib/i18n.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-coi-tpl-i18n-'))
}

test('builtin template display names follow the active locale', () => {
  const dir = tempDir()
  const prevLocale = getLocale()
  try {
    const templates = new TemplateStore(join(dir, 'templates.json'))
    for (const locale of ['en', 'zh']) {
      setLocale(locale)
      const list = templates.list()
      assert.equal(list.length, BUILTIN_TEMPLATES.length)
      for (const tpl of list) {
        const expected = translate(COI_DICT, `coi.template.name.${tpl.id}`, undefined, locale)
        assert.equal(
          typeof expected, 'string',
          `[${locale}] dict must carry a name for builtin ${tpl.id}`,
        )
        assert.equal(
          tpl.name, expected,
          `[${locale}] builtin template ${tpl.id} must localize`,
        )
      }
    }
  } finally {
    setLocale(prevLocale)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('custom template names are stored verbatim in every locale', () => {
  const dir = tempDir()
  const prevLocale = getLocale()
  try {
    const templates = new TemplateStore(join(dir, 'templates.json'))
    setLocale('en')
    const custom = templates.upsert({ id: 'my-tpl', name: '我的模板', prompt: 'do x' })
    assert.equal(custom.name, '我的模板')
    setLocale('zh')
    assert.equal(templates.get('my-tpl').name, '我的模板')
  } finally {
    setLocale(prevLocale)
    rmSync(dir, { recursive: true, force: true })
  }
})
