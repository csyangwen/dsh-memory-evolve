/**
 * 无限画板（lib/canvas.js）单元测试。
 *
 * 覆盖：空板读取、rev 乐观锁（冲突拒绝）、normalizeNode 归属键、
 * 路径类型推断、AI 落点错位、文件代理（真实文件/敏感拒绝/缺失报错/
 * 无路径拒绝）、de_canvas 工具（list/get/add_note/未知操作/空内容）、
 * 内容上限、formatBytes。
 *
 * 测试用独立临时目录，不触碰真实记忆目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CANVAS_NOTE_MAX_BYTES,
  aiSlotPlacement,
  canvasToolDefinition,
  findNode,
  formatBytes,
  inferNodeTypeFromPath,
  normalizeNode,
  openNodeFile,
  readCanvas,
  resolveNodeFile,
  searchLocalFiles,
  writeCanvas,
} from '../lib/canvas.js'

/** 每个测试独立临时目录。 */
function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-test-'))
  return { dir, config: { memoryDir: join(dir, 'board') } }
}

const OWNER = { sessionId: 's1', projectId: 'p1', projectLabel: 'p', sessionLabel: 's' }

test('空板读取：nodes=[] rev=0', () => {
  const { config } = tempConfig()
  const empty = readCanvas(config)
  assert.equal(empty.nodes.length, 0)
  assert.equal(empty.rev, 0)
})

test('原子写 + rev 乐观锁：旧 rev 冲突拒绝，正确 rev 通过', () => {
  const { config } = tempConfig()
  const n1 = normalizeNode({ type: 'markdown', title: '测试便签', scope: 'session', content: 'hello' }, OWNER)
  const rev1 = writeCanvas(config, { nodes: [n1] }, 0)
  assert.equal(rev1, 1)
  // 旧 rev 再写 → 冲突
  assert.throws(
    () => writeCanvas(config, { nodes: [] }, 0),
    (error) => error.code === 'CANVAS_CONFLICT',
  )
  // 正确 rev → 通过
  const rev2 = writeCanvas(config, { nodes: [n1] }, 1)
  assert.equal(rev2, 2)
})

test('normalizeNode 归属键：global 无归属、session 挂 sessionId+projectId', () => {
  const g = normalizeNode({ type: 'file', title: '全局文件', scope: 'global', path: '/tmp/x.pdf' }, OWNER)
  assert.equal(g.scope, 'global')
  assert.equal(g.sessionId, undefined)
  assert.equal(g.projectId, undefined)
  const s = normalizeNode({ type: 'image', title: '会话图', scope: 'session', path: '/tmp/a.png' }, OWNER)
  assert.equal(s.sessionId, 's1')
  assert.equal(s.projectId, 'p1')
})

test('路径类型推断', () => {
  assert.equal(inferNodeTypeFromPath('/tmp/a.png'), 'image')
  assert.equal(inferNodeTypeFromPath('/tmp/b.mp3'), 'media')
  assert.equal(inferNodeTypeFromPath('/tmp/c.md'), 'markdown')
  assert.equal(inferNodeTypeFromPath('/tmp/d.txt'), 'plainText')
  assert.equal(inferNodeTypeFromPath('/tmp/e.pdf'), 'file')
})

test('AI 落点随数量错位', () => {
  const a1 = aiSlotPlacement([])
  const a2 = aiSlotPlacement([{ aiPlaced: true }, { aiPlaced: true }, { aiPlaced: true }])
  assert.ok(a1.x !== a2.x || a1.y !== a2.y)
})

test('文件代理：真实文件解析成功（realpath 对比）', () => {
  const { dir, config } = tempConfig()
  const realFile = join(dir, 'preview.png')
  writeFileSync(realFile, 'fake-png')
  const node = normalizeNode({ type: 'image', title: '图', scope: 'session', path: realFile }, OWNER)
  writeCanvas(config, { nodes: [node] }, 0)
  const res = resolveNodeFile(config, node.id)
  assert.equal(res.error, undefined)
  assert.equal(res.path, realpathSync(realFile))
})

test('文件代理：真实敏感文件拒绝', () => {
  const { dir, config } = tempConfig()
  const sshDir = join(dir, '.ssh')
  mkdirSync(sshDir, { recursive: true })
  const sshKey = join(sshDir, 'id_rsa')
  writeFileSync(sshKey, 'PRIVATE KEY')
  const node = normalizeNode({ type: 'file', title: 'ssh', scope: 'session', path: sshKey }, OWNER)
  writeCanvas(config, { nodes: [node] }, 0)
  const res = resolveNodeFile(config, node.id)
  assert.match(res.error ?? '', /敏感/)
})

test('文件代理：不存在的敏感路径仍报敏感拒绝（不误导为不存在）', () => {
  const { dir, config } = tempConfig()
  const node = normalizeNode({ type: 'file', title: 'ssh2', scope: 'session', path: join(dir, '.ssh', 'id_ed25519') }, OWNER)
  writeCanvas(config, { nodes: [node] }, 0)
  const res = resolveNodeFile(config, node.id)
  assert.match(res.error ?? '', /敏感/)
})

test('文件代理：缺失普通路径友好报错', () => {
  const { dir, config } = tempConfig()
  const node = normalizeNode({ type: 'file', title: 'gone', scope: 'session', path: join(dir, 'nope.txt') }, OWNER)
  writeCanvas(config, { nodes: [node] }, 0)
  const res = resolveNodeFile(config, node.id)
  assert.match(res.error ?? '', /不存在/)
})

test('文件代理：无路径节点拒绝', () => {
  const { config } = tempConfig()
  const node = normalizeNode({ type: 'markdown', title: '便签', scope: 'session', content: 'hi' }, OWNER)
  writeCanvas(config, { nodes: [node] }, 0)
  const res = resolveNodeFile(config, node.id)
  assert.match(res.error ?? '', /没有路径/)
})

test('打开：真实文件可打开（darwin 返回 ok，spawn 不阻塞）', () => {
  const { dir, config } = tempConfig()
  const realFile = join(dir, 'open-me.txt')
  writeFileSync(realFile, 'hello')
  const node = normalizeNode({ type: 'file', title: '打开', scope: 'session', path: realFile }, OWNER)
  writeCanvas(config, { nodes: [node] }, 0)
  const res = openNodeFile(config, node.id)
  assert.equal(res.error, undefined)
  assert.equal(res.ok, true)
})

test('打开：敏感路径拒绝', () => {
  const { config } = tempConfig()
  const node = normalizeNode({ type: 'file', title: 'ssh', scope: 'session', path: join(dirname(config.memoryDir), '.ssh', 'id_rsa') }, OWNER)
  writeCanvas(config, { nodes: [node] }, 0)
  const res = openNodeFile(config, node.id)
  assert.match(res.error ?? '', /敏感/)
})

test('打开：不存在路径友好报错', () => {
  const { dir, config } = tempConfig()
  const node = normalizeNode({ type: 'file', title: 'gone', scope: 'session', path: join(dir, 'nope.txt') }, OWNER)
  writeCanvas(config, { nodes: [node] }, 0)
  const res = openNodeFile(config, node.id)
  assert.match(res.error ?? '', /不存在/)
})

test('打开：无路径节点拒绝', () => {
  const { config } = tempConfig()
  const node = normalizeNode({ type: 'markdown', title: '便签', scope: 'session', content: 'hi' }, OWNER)
  writeCanvas(config, { nodes: [node] }, 0)
  const res = openNodeFile(config, node.id)
  assert.match(res.error ?? '', /没有路径/)
})

test('de_canvas list：会话视角返回节点清单', async () => {
  const { config } = tempConfig()
  const node = normalizeNode({ type: 'markdown', title: '便签', scope: 'session', content: 'hi' }, OWNER)
  writeCanvas(config, { nodes: [node] }, 0)
  const tool = canvasToolDefinition(config, () => '/proj')
  const res = await tool.execute({ action: 'list', view: 'session' }, { agent: { session: { id: 's1', header: { cwd: '/proj' } } } })
  assert.equal(res.ok, true)
  assert.ok(Array.isArray(res.nodes))
  assert.ok(res.nodes.some((n) => n.id === node.id))
})

test('de_canvas get：按 id 返回节点内容', async () => {
  const { config } = tempConfig()
  const node = normalizeNode({ type: 'markdown', title: '便签', scope: 'session', content: 'hello world' }, OWNER)
  writeCanvas(config, { nodes: [node] }, 0)
  const tool = canvasToolDefinition(config, () => '/proj')
  const res = await tool.execute({ action: 'get', id: node.id }, { agent: { session: { id: 's1' } } })
  assert.equal(res.ok, true)
  assert.equal(res.content, 'hello world')
})

test('de_canvas get：不存在的 id 报错', async () => {
  const { config } = tempConfig()
  const tool = canvasToolDefinition(config, () => '/proj')
  const res = await tool.execute({ action: 'get', id: 'canvas_nope' }, { agent: { session: { id: 's1' } } })
  assert.equal(res.ok, false)
  assert.match(res.error, /没有节点/)
})

test('searchLocalFiles：指定目录命中文件（provider 链或 walk 兜底）', async () => {
  const { dir, config } = tempConfig()
  writeFileSync(join(dir, '上板测试文件.txt'), 'hello')
  const res = await searchLocalFiles(config, '上板测试', { dir, limit: 5 })
  // provider 链（mdfind/rg）命中也算对；全 miss 才走内置 walk
  assert.ok(['mdfind', 'es', 'rg', 'walk'].includes(res.provider), `provider=${res.provider}`)
  assert.ok(res.items.some((it) => it.title.includes('上板测试')))
})

test('searchLocalFiles：空关键字返回空（不触发 provider）', async () => {
  const { config } = tempConfig()
  const res = await searchLocalFiles(config, '   ', { limit: 5 })
  assert.equal(res.items.length, 0)
  assert.equal(res.provider, 'none')
})

test('de_canvas add_note：放入会话板中央区（aiPlaced + scope=session）', async () => {
  const { config } = tempConfig()
  const tool = canvasToolDefinition(config, () => '/proj')
  const res = await tool.execute(
    { action: 'add_note', title: 'AI 便签', content: '来自 AI 的测试内容' },
    { agent: { session: { id: 's1', header: { cwd: '/proj' } } } },
  )
  assert.equal(res.ok, true)
  assert.equal(res.scope, 'session')
  assert.ok(res.placement && typeof res.placement.x === 'number')
  // 板里确实多了 AI 便签
  const board = readCanvas(config)
  assert.ok(board.nodes.some((n) => n.id === res.id && n.aiPlaced === true))
})

test('de_canvas add_note：空内容拒绝', async () => {
  const { config } = tempConfig()
  const tool = canvasToolDefinition(config, () => '/proj')
  const res = await tool.execute({ action: 'add_note', content: '' }, { agent: { session: { id: 's1' } } })
  assert.equal(res.ok, false)
})

test('de_canvas 未知操作拒绝', async () => {
  const { config } = tempConfig()
  const tool = canvasToolDefinition(config, () => '/proj')
  const res = await tool.execute({ action: 'unknown' }, { agent: { session: { id: 's1' } } })
  assert.equal(res.ok, false)
})

test('便签内容超限截断', () => {
  const node = normalizeNode(
    { type: 'markdown', title: 'big', scope: 'session', content: 'x'.repeat(CANVAS_NOTE_MAX_BYTES + 1000) },
    OWNER,
  )
  assert.ok(node.content.length <= CANVAS_NOTE_MAX_BYTES)
})

test('findNode 按 id 查找', () => {
  const { config } = tempConfig()
  const node = normalizeNode({ type: 'markdown', title: 't', scope: 'session', content: 'x' }, OWNER)
  writeCanvas(config, { nodes: [node] }, 0)
  const board = readCanvas(config)
  assert.equal(findNode(board.nodes, node.id)?.id, node.id)
  assert.equal(findNode(board.nodes, 'nope'), undefined)
})

test('整板保存做形状归一：前端附加字段剥除、缺省字段补齐、id 保留', () => {
  const { config } = tempConfig()
  // 模拟前端 localStorage 时代遗留的节点格式（带 meta 等附加字段）
  const frontendNode = {
    id: 'canvas_abc123',
    type: 'image',
    title: '前端图',
    scope: 'session',
    scopeLabel: '会话',
    sessionId: 's1',
    projectId: 'p1',
    path: '/tmp/x.png',
    meta: { size: '1 KB', mtime: '示例' }, // 附加字段应被剥除
    placement: { x: 10, y: 20, width: 320, height: 240, zIndex: 1 },
    aiPlaced: false,
    createdAt: 123456,
  }
  writeCanvas(config, { nodes: [frontendNode] }, 0)
  const board = readCanvas(config)
  const saved = board.nodes[0]
  assert.equal(saved.id, 'canvas_abc123') // 前缀合法 → id 保留
  assert.equal(saved.meta, undefined)     // 附加字段剥除
  assert.equal(saved.unverified, true)    // 路径不存在 → unverified 补齐
  assert.equal(saved.title, '前端图')
  assert.equal(board.rev, 1)
})

test('整板保存：非法 id 前缀重新生成', () => {
  const { config } = tempConfig()
  writeCanvas(config, { nodes: [{ id: 'legacy_9', title: 't', scope: 'session', placement: {} }] }, 0)
  const board = readCanvas(config)
  assert.match(board.nodes[0].id, /^canvas_/)
})

test('formatBytes 格式化', () => {
  assert.equal(formatBytes(500), '500 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
})
