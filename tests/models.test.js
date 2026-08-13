import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelConfigStore, normalizeModelsPatch } from '../lib/models.js'

/** 临时目录夹具：每个测试独立目录，用完即删。 */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-models-test-'))
}

test('ModelConfigStore：新增模型配置并原子落盘', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'models.json')
    const store = new ModelConfigStore(file)
    // 新增：启用 + 备注 + 思考等级白名单
    const entry = store.update('deepseek-official', 'deepseek-chat', {
      enabled: false,
      note: '主力模型',
      reasoning: { enabled: ['high'], recommended: 'high', custom: [{ id: 'ultra', name: 'Ultra' }] },
    })
    assert.equal(entry.enabled, false)
    assert.equal(entry.note, '主力模型')
    assert.deepEqual(entry.reasoning.enabled, ['high'])
    // 落盘后可重新加载（持久化生效）
    const reloaded = new ModelConfigStore(file)
    assert.equal(reloaded.entry('deepseek-official', 'deepseek-chat').enabled, false)
    assert.equal(reloaded.entry('deepseek-official', 'deepseek-chat').note, '主力模型')
    assert.deepEqual(reloaded.entry('deepseek-official', 'deepseek-chat').reasoning.custom, [{ id: 'ultra', name: 'Ultra' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ModelConfigStore：默认值不落盘（显式 true = 恢复默认删除字段）', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'models.json')
    const store = new ModelConfigStore(file)
    store.update('p', 'm', { enabled: false, note: 'x', thinking: false })
    // 恢复默认：显式 true → 删除字段
    const back = store.update('p', 'm', { enabled: true, note: '', thinking: true })
    assert.equal(back, undefined, '全部字段恢复默认后条目应被删除')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(raw.models, {}, '全空条目不应落盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ModelConfigStore：save 是原子写（无残留 tmp、主文件完整）', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'models.json')
    const store = new ModelConfigStore(file)
    store.update('p', 'm', { enabled: false })
    // 稳定版复审：旧实现写完 tmp 又直接写主文件，tmp 从未 rename——
    // 目录里会残留 models.json.tmp 垃圾文件且写主文件非原子。
    const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp'))
    assert.deepEqual(leftovers, [], '目录不应残留 .tmp 临时文件')
    assert.ok(existsSync(file), '主配置文件必须存在')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(raw.models.p.m.enabled, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ModelConfigStore：损坏的配置文件备份后重建，不丢后续写入', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'models.json')
    writeFileSync(file, '{ 这不是合法 JSON')
    const store = new ModelConfigStore(file)
    store.update('p', 'm', { enabled: false })
    assert.equal(store.entry('p', 'm').enabled, false)
    // 损坏原文件被备份
    const backups = readdirSync(dir).filter((name) => name.includes('.corrupt-'))
    assert.equal(backups.length, 1, '损坏文件应被备份而非直接覆盖')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ModelConfigStore：备注超长截断到上限', () => {
  const dir = tempDir()
  try {
    const store = new ModelConfigStore(join(dir, 'models.json'))
    const entry = store.update('p', 'm', { note: '长'.repeat(5000) })
    assert.ok(entry.note.length <= 2000, '备注应被截断（NOTE_MAX=2000）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('normalizeModelsPatch：非法字段被拒绝、合法字段透传', () => {
  const patch = normalizeModelsPatch({ enabled: true, note: 'x', reasoning: { enabled: ['high'] }, unknown: 1 })
  assert.equal(patch.enabled, true)
  assert.equal(patch.note, 'x')
  assert.deepEqual(patch.reasoning.enabled, ['high'])
  assert.equal(patch.unknown, undefined, '白名单外的字段应被剔除')
})
