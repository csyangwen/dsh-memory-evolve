/**
 * dsh-memory-evolve — 提示词管理器（prompts.js）测试。
 *
 * 覆盖：PromptStore CRUD/seed/统计、InjectionStore 回合计数（tickTurn）、
 * 变量展开、快照段渲染、Web API 全路由、agent/turn-stopping 集成。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  InjectionStore, PromptStore, SEED_PROMPTS, expandVars,
  installPrompts, renderInjectionSnapshot,
} from '../lib/prompts.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-prompts-test-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

// ---------- PromptStore ----------

test('PromptStore seed: 首次运行写入内置示例，再次运行不覆盖', () => {
  const dir = tempDir()
  try {
    const store = new PromptStore(dir)
    store.seedIfEmpty()
    assert.equal(store.list().length, SEED_PROMPTS.length)
    // 用户删除全部后重新 seed 不应复活（文件存在即视为已初始化）
    for (const p of store.list()) store.remove(p.id)
    assert.equal(store.list().length, 0)
    store.seedIfEmpty()
    assert.equal(store.list().length, 0)
  } finally {
    clean(dir)
  }
})

test('PromptStore CRUD 与校验', () => {
  const dir = tempDir()
  try {
    const store = new PromptStore(dir)
    store.seedIfEmpty()
    // 空名称/空内容被拒
    assert.throws(() => store.create({ name: '  ', content: 'x' }), /名称不能为空/)
    assert.throws(() => store.create({ name: 'x', content: '  ' }), /内容不能为空/)
    // 正常创建：分类默认「未分类」，标签去重截断
    const p = store.create({ name: '测试提示词', category: '', tags: ['a', 'a', 'b', '', ' '], content: '第一条\n第二行' })
    assert.equal(p.category, '未分类')
    assert.deepEqual(p.tags, ['a', 'b'])
    assert.equal(p.usageCount, 0)
    // 更新
    const updated = store.update(p.id, { name: '改名', category: '测试', tags: ['c'], content: '新内容' })
    assert.equal(updated.name, '改名')
    assert.equal(updated.category, '测试')
    assert.equal(store.get(p.id).content, '新内容')
    // 更新校验
    assert.throws(() => store.update(p.id, { name: '' }), /名称不能为空/)
    // 使用统计
    store.bumpUsage(p.id)
    assert.equal(store.get(p.id).usageCount, 1)
    assert.ok(store.get(p.id).lastUsedAt !== null)
    // 删除
    assert.equal(store.remove(p.id), true)
    assert.equal(store.remove(p.id), false)
  } finally {
    clean(dir)
  }
})

// ---------- InjectionStore ----------

test('InjectionStore: rounds 计数、间隔注入、重复来源与级联清理', () => {
  const dir = tempDir()
  try {
    const store = new InjectionStore(dir)
    // rounds 默认 1；非法值回退 1；上限截断；every 同规则；rounds=0 无限
    const a = store.add({ title: 'A', content: '内容A' })
    assert.equal(a.roundsLeft, 1)
    assert.equal(a.every, 1)
    const b = store.add({ title: 'B', content: '内容B', rounds: 3 })
    assert.equal(b.roundsLeft, 3)
    assert.equal(store.add({ title: 'C', content: 'C', rounds: 0 }).roundsLeft, null) // 无限
    assert.equal(store.add({ title: 'D', content: 'D', rounds: 999 }).roundsLeft, 50)
    assert.equal(store.add({ title: 'E', content: 'E', every: 0 }).every, 1)
    // 同来源重复注入被标记
    assert.equal(store.hasSource('src-1'), false)
    store.add({ sourcePromptId: 'src-1', title: 'S1', content: 'x' })
    assert.equal(store.hasSource('src-1'), true)
    // tickTurn（every=1）：有限次数每回合消耗一次；无限（C）永不消耗
    assert.equal(store.list().length, 6)
    store.tickTurn() // 第 1 回合：A/E/S1 归零移除，B=2，D=49，C（无限）不动
    assert.equal(store.list().length, 3)
    assert.deepEqual(store.list().map((i) => i.title), ['B', 'C', 'D'])
    store.tickTurn() // B=1, D=48
    store.tickTurn() // B=0 → 移除，剩 C、D
    assert.equal(store.list().length, 2)
    assert.equal(store.list()[1].title, 'D')
    // 空轨 tick 安全
    assert.deepEqual(store.tickTurn(), [])
    // 间隔注入（every=3, rounds=2）：出现 1 轮 → 间隔 2 轮 → 再出现 → 消耗完移除
    const iv = store.add({ title: 'I', content: 'x', rounds: 2, every: 3 })
    assert.equal(iv.countdown, 0) // 注入后下一轮即出现
    store.tickTurn() // 出现轮结束：消耗一次，countdown=2
    const ivNow = store.list().find((i) => i.id === iv.id)
    assert.equal(ivNow.roundsLeft, 1)
    assert.equal(ivNow.countdown, 2)
    store.tickTurn() // countdown=1
    store.tickTurn() // countdown=0 → 下一轮出现
    assert.equal(store.list().find((i) => i.id === iv.id).countdown, 0)
    store.tickTurn() // 出现轮结束：消耗完 → 移除
    assert.equal(store.list().some((i) => i.id === iv.id), false)
    // 无限 + 间隔：出现轮不消耗，永不自动移除，只能手动 remove
    const inf = store.add({ title: 'INF', content: 'y', rounds: 0, every: 2 })
    store.tickTurn() // 出现轮结束：无限不消耗，countdown=1
    assert.equal(store.list().find((i) => i.id === inf.id).roundsLeft, null)
    assert.equal(store.list().find((i) => i.id === inf.id).countdown, 1)
    store.tickTurn() // countdown=0 → 出现
    store.tickTurn() // 出现轮结束 → countdown=1
    assert.equal(store.list().some((i) => i.id === inf.id), true) // 永不自动移除
    assert.equal(store.remove(inf.id), true)
    // removeBySource
    store.add({ sourcePromptId: 'src-2', title: 'X', content: 'x', rounds: 2 })
    store.add({ sourcePromptId: 'src-2', title: 'Y', content: 'y' })
    store.removeBySource('src-2')
    assert.equal(store.list().length, 2)
    assert.deepEqual(store.list().map((i) => i.title), ['C', 'D']) // 上一段的 C（无限）/D 不受影响
    // remove 单条
    const z = store.add({ title: 'Z', content: 'z' })
    assert.equal(store.remove(z.id), true)
    assert.equal(store.remove(z.id), false)
  } finally {
    clean(dir)
  }
})

test('PromptStore 分类管理：默认集合/添加/改名/删除/隐式注册', () => {
  const dir = tempDir()
  try {
    const store = new PromptStore(dir)
    store.seedIfEmpty()
    // seed 写入默认分类集合
    assert.ok(store.listCategories().length >= 8)
    assert.ok(store.listCategories().includes('开发流程'))
    // 添加：正常 / **幂等（同名不报错，标记已存在）** / 空名 / 「未分类」拒绝
    const added = store.addCategory('我的分类')
    assert.equal(added.alreadyExists, false)
    assert.ok(added.categories.includes('我的分类'))
    const dup = store.addCategory('我的分类')
    assert.equal(dup.alreadyExists, true)
    assert.throws(() => store.addCategory('  '), /不能为空/)
    assert.throws(() => store.addCategory('未分类'), /无需添加/)
    // 隐式注册：create 使用新分类名 → 自动入受管列表
    store.create({ name: 'P', category: '隐式分类', content: 'x' })
    assert.ok(store.listCategories().includes('隐式分类'))
    // 改名：受管列表替换 + 该分类下提示词同步改名
    store.create({ name: 'Q', category: '我的分类', content: 'y' })
    const renamed = store.renameCategory('我的分类', '重命名分类')
    assert.equal(renamed.renamed, 1)
    assert.equal(store.listCategories().includes('我的分类'), false)
    assert.equal(store.listCategories().includes('重命名分类'), true)
    assert.equal(store.list().find((p) => p.name === 'Q').category, '重命名分类')
    // 改名校验：目标与其他分类重名 / 未分类 / 空名 / 旧名不存在
    assert.throws(() => store.renameCategory('重命名分类', '开发流程'), /已存在/)
    assert.throws(() => store.renameCategory('重命名分类', '未分类'), /不能作为目标名/)
    assert.throws(() => store.renameCategory('重命名分类', '  '), /不能为空/)
    assert.throws(() => store.renameCategory('不存在', 'X'), /不存在/)
    assert.throws(() => store.renameCategory('未分类', 'X'), /不可改名/)
    // 删除：分类下提示词移到未分类
    const outcome = store.removeCategory('重命名分类')
    assert.equal(outcome.removed, true)
    assert.equal(outcome.moved, 1)
    assert.equal(store.listCategories().includes('重命名分类'), false)
    assert.equal(store.list().find((p) => p.name === 'Q').category, '未分类')
    assert.throws(() => store.removeCategory('不存在'), /不存在/)
    assert.throws(() => store.removeCategory('未分类'), /不可删除/)
  } finally {
    clean(dir)
  }
})

// ---------- 变量展开 ----------

test('expandVars: 内置变量、未知变量保留、vars 覆盖', () => {
  const out = expandVars('今天 {{date}}，时间 {{time}}，路径 {{path}}', { path: '/a/b.txt' })
  assert.match(out, /^今天 \d{4}-\d{2}-\d{2}，时间 \d{2}:\d{2}，路径 \/a\/b\.txt$/)
  assert.equal(expandVars('{{unknown}}'), '{{unknown}}')
})

// ---------- 快照渲染 ----------

test('renderInjectionSnapshot: 命令式指令文案，只渲染出现轮，空轨不渲染', () => {
  const dir = tempDir()
  try {
    const store = new InjectionStore(dir)
    assert.equal(renderInjectionSnapshot(store), '')
    store.add({ sourcePromptId: 'p1', title: '代码审查', content: '第一行\n第二行', rounds: 1 })
    const text = renderInjectionSnapshot(store)
    // 写给模型看的命令式指令：标题声明「必须遵循」，不出现"注入"字样、
    // 引导句与 GUI 话术（活跃 N 条/Tab 移除/剩余次数）
    assert.match(text, /## 用户规则（必须遵循）/)
    assert.match(text, /「代码审查」：/)
    assert.equal(text.includes('注入'), false)
    assert.equal(text.includes('活跃'), false)
    assert.equal(text.includes('Tab 提前移除'), false)
    assert.equal(text.includes('剩余'), false)
    assert.match(text, /第一行/)
    assert.match(text, /第二行/)
    // 间隔注入：出现轮渲染，间隔轮不渲染
    const iv = store.add({ sourcePromptId: 'p2', title: '定期提醒', content: '别忘了 X', rounds: 2, every: 3 })
    assert.match(renderInjectionSnapshot(store), /「定期提醒」：/)
    store.tickTurn() // 代码审查（一次性）移除；定期提醒：消耗一次 countdown=2 → 快照空
    assert.equal(renderInjectionSnapshot(store), '')
    store.tickTurn() // countdown=1
    assert.equal(renderInjectionSnapshot(store), '')
    store.tickTurn() // countdown=0 → 出现
    const again = renderInjectionSnapshot(store)
    assert.match(again, /「定期提醒」/)
    assert.equal(again.includes('代码审查'), false)
    // 无限次：不受回合推进影响，出现轮恒渲染
    store.add({ sourcePromptId: 'p3', title: '常驻规则', content: '始终遵守', rounds: 0 })
    assert.match(renderInjectionSnapshot(store), /「常驻规则」：/)
    store.tickTurn() // 定期提醒消耗一次 countdown=2（不渲染）；常驻规则无限不消耗 countdown=0（渲染）
    const infText = renderInjectionSnapshot(store)
    assert.match(infText, /「常驻规则」：/)
    assert.equal(infText.includes('定期提醒'), false)
    assert.equal(iv.id.length > 0, true)
  } finally {
    clean(dir)
  }
})

// ---------- Web API ----------

/** Boot a real HTTP server over installPrompts' registered handler. */
async function bootApi() {
  const dir = tempDir()
  let turnListener = null
  let snapshotRender = null
  const ctx = {
    on: (event, listener) => { if (event === 'agent/turn-stopping') turnListener = listener; return () => {} },
    inject: (services, cb) => {
      // 模拟 web-only 分支：httpServer 存在 → 立即回调
      cb({
        httpServer: {
          register: ({ handler }) => { ctx.handler = handler; return () => {} },
        },
        effect: (fn) => { fn(); return () => {} },
      })
      return () => {}
    },
    effect: (fn) => { fn(); return () => {} },
    systemPrompt: {
      context: ({ name, text }) => { if (name === 'prompt:injections') snapshotRender = text; return () => {} },
    },
  }
  installPrompts(ctx, { memoryDir: dir })
  const server = createServer((req, res) => ctx.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, data }
  }
  const close = () => new Promise((resolve) => server.close(resolve))
  return { dir, base, request, close, turnListener, snapshotRender }
}

test('Web API: 提示词 CRUD + 注入 + 注入轨 + 回合计数闭环', async () => {
  const { dir, request, close, turnListener, snapshotRender } = await bootApi()
  try {
    // 内置示例已 seed
    const list = await request('GET', '/memory-evolve/api/prompts')
    assert.equal(list.status, 200)
    assert.ok(list.data.prompts.length >= 10)
    // 创建 + 校验
    const created = await request('POST', '/memory-evolve/api/prompts', { name: '我的范式', content: '请按以下流程执行：\n1. 先看 {{date}} 的日志' })
    assert.equal(created.status, 200)
    const id = created.data.prompt.id
    assert.equal(created.data.prompt.category, '未分类')
    assert.equal((await request('POST', '/memory-evolve/api/prompts', { name: '', content: 'x' })).status, 400)
    // 更新
    const updated = await request('PUT', `/memory-evolve/api/prompts/${id}`, { name: '我的范式V2', category: '工作流' })
    assert.equal(updated.status, 200)
    assert.equal(updated.data.prompt.name, '我的范式V2')
    // 注入（一次性）：变量已展开，rounds=1
    const inj = await request('POST', `/memory-evolve/api/prompts/${id}/inject`, { rounds: 1 })
    assert.equal(inj.status, 200)
    assert.match(inj.data.injection.content, /\d{4}-\d{2}-\d{2}/)
    assert.equal(inj.data.injection.roundsLeft, 1)
    // 重复注入被拒
    const dup = await request('POST', `/memory-evolve/api/prompts/${id}/inject`, { rounds: 3 })
    assert.equal(dup.status, 400)
    assert.match(dup.data.error, /已在注入中/)
    // rounds 非法
    const badRounds = await request('POST', `/memory-evolve/api/prompts/${id}/inject`, { rounds: 0 })
    assert.equal(badRounds.status, 400)
    // 注入轨可见
    const injections = await request('GET', '/memory-evolve/api/prompts/injections')
    assert.equal(injections.data.injections.length, 1)
    // 快照段渲染活跃注入（含变量展开后的内容）
    assert.match(snapshotRender(), /我的范式V2/)
    // 回合计数：主 agent 回合 → 归零移除
    turnListener({ agent: { session: { header: {} } } })
    assert.equal((await request('GET', '/memory-evolve/api/prompts/injections')).data.injections.length, 0)
    assert.equal(snapshotRender(), '')
    // subagent 回合不消耗
    await request('POST', `/memory-evolve/api/prompts/${id}/inject`, { rounds: 2 })
    turnListener({ agent: { session: { header: { origin: 'subagent' } } } })
    assert.equal((await request('GET', '/memory-evolve/api/prompts/injections')).data.injections.length, 1)
    // 手动移除注入
    const injId = (await request('GET', '/memory-evolve/api/prompts/injections')).data.injections[0].id
    assert.equal((await request('DELETE', `/memory-evolve/api/prompts/injections/${injId}`)).data.ok, true)
    // 间隔注入（every 参数透传；非法 every 被拒）
    const badEvery = await request('POST', `/memory-evolve/api/prompts/${id}/inject`, { rounds: 2, every: 0 })
    assert.equal(badEvery.status, 400)
    const iv = await request('POST', `/memory-evolve/api/prompts/${id}/inject`, { rounds: 2, every: 3 })
    assert.equal(iv.status, 200)
    assert.equal(iv.data.injection.every, 3)
    assert.equal(iv.data.injection.roundsLeft, 2)
    // 停止间隔注入后重注入无限次（rounds=0）
    await request('DELETE', `/memory-evolve/api/prompts/injections/${iv.data.injection.id}`)
    const inf = await request('POST', `/memory-evolve/api/prompts/${id}/inject`, { rounds: 0 })
    assert.equal(inf.status, 200)
    assert.equal(inf.data.injection.roundsLeft, null)
    assert.equal(inf.data.injection.every, 1)
    // 删除提示词级联清理注入
    assert.equal((await request('DELETE', `/memory-evolve/api/prompts/${id}`)).status, 200)
    assert.equal((await request('GET', '/memory-evolve/api/prompts/injections')).data.injections.length, 0)
    // 来源链接
    const sources = await request('GET', '/memory-evolve/api/prompts/sources')
    assert.equal(sources.status, 200)
    assert.ok(sources.data.sources.length >= 5)
    // 分类管理 API：GET / POST（幂等）/ PUT（改名）/ DELETE
    const cats = await request('GET', '/memory-evolve/api/prompts/categories')
    assert.equal(cats.status, 200)
    assert.ok(cats.data.categories.includes('开发流程'))
    const added = await request('POST', '/memory-evolve/api/prompts/categories', { name: 'API 新增分类' })
    assert.equal(added.status, 200)
    assert.equal(added.data.alreadyExists, false)
    assert.ok(added.data.categories.includes('API 新增分类'))
    // 同名重复添加：幂等返回 alreadyExists（不报错）
    const dupCat = await request('POST', '/memory-evolve/api/prompts/categories', { name: 'API 新增分类' })
    assert.equal(dupCat.status, 200)
    assert.equal(dupCat.data.alreadyExists, true)
    // 改名
    const renamedCat = await request('PUT', '/memory-evolve/api/prompts/categories/API%20%E6%96%B0%E5%A2%9E%E5%88%86%E7%B1%BB', { name: 'API 改名分类' })
    assert.equal(renamedCat.status, 200)
    assert.equal(renamedCat.data.renamed, 0)
    assert.ok(renamedCat.data.categories.includes('API 改名分类'))
    assert.ok(!renamedCat.data.categories.includes('API 新增分类'))
    const renamedDup = await request('PUT', '/memory-evolve/api/prompts/categories/API%20%E6%94%B9%E5%90%8D%E5%88%86%E7%B1%BB', { name: '开发流程' })
    assert.equal(renamedDup.status, 400)
    const removedCat = await request('DELETE', '/memory-evolve/api/prompts/categories/API%20%E6%94%B9%E5%90%8D%E5%88%86%E7%B1%BB')
    assert.equal(removedCat.status, 200)
    assert.equal(removedCat.data.moved, 0)
    assert.ok(removedCat.data.removed)
    // 404
    assert.equal((await request('GET', '/memory-evolve/api/prompts/nope')).status, 404)
    assert.equal((await request('DELETE', '/memory-evolve/api/prompts/nope')).status, 404)
  } finally {
    await close()
    clean(dir)
  }
})

test('installPrompts: dispose 可安全调用（开关卸载路径）', async () => {
  const dir = tempDir()
  try {
    const ctx = {
      on: () => () => {},
      inject: (services, cb) => {
        cb({
          httpServer: { register: () => () => {} },
          effect: (fn) => { fn(); return () => {} },
        })
        return () => {}
      },
      effect: (fn) => { fn(); return () => {} },
      systemPrompt: { context: () => () => {} },
    }
    const installed = installPrompts(ctx, { memoryDir: dir })
    // 数据已 seed，dispose 卸载全部注册不抛错、可重复调用
    assert.equal(installed.promptStore.list().length, SEED_PROMPTS.length)
    assert.doesNotThrow(() => installed.dispose())
    assert.doesNotThrow(() => installed.dispose())
  } finally {
    clean(dir)
  }
})
