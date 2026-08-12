import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ScopeStore, SCOPE_MAX_CHARS } from '../lib/advisor/scopes.js'
import { buildAdvisorSystemPrompt } from '../lib/advisor/prompt.js'

/** 内存文件系统（与 store 测试同款）。 */
function memFs() {
  const files = new Map()
  return {
    files,
    writeFile: (path, data) => { files.set(path, data) },
    readFile: (path) => files.get(path) ?? '',
  }
}

function makeScopes() {
  const fs = memFs()
  const store = new ScopeStore({
    // 路径约定：内部相对路径，闭包拼 /data/ 前缀
    writeFile: (rel, data) => fs.writeFile(`/data/${rel}`, data),
    readFile: (rel) => fs.readFile(`/data/${rel}`),
    conversationFileOf: (sid) => `conversations/${sid}.json`,
    writeConversation: (rel, data) => fs.writeFile(`/data/${rel}`, data),
  })
  return { store, fs }
}

test('全局约束：所有会话共享，跨实例持久化；空文本清除', () => {
  const { store, fs } = makeScopes()
  assert.equal(store.globalOf(), '')
  store.setGlobal('评审意见一律用中文')
  assert.equal(store.globalOf(), '评审意见一律用中文')
  assert.ok(fs.files.get('/data/global-scope.json').includes('评审意见一律用中文'))
  // 新实例（模拟重启）恢复
  const fs2 = { files: fs.files, writeFile: fs.writeFile, readFile: fs.readFile }
  const store2 = new ScopeStore({
    writeFile: (rel, data) => fs2.writeFile(`/data/${rel}`, data),
    readFile: (rel) => fs2.readFile(`/data/${rel}`),
    conversationFileOf: (sid) => `conversations/${sid}.json`,
    writeConversation: (rel, data) => fs2.writeFile(`/data/${rel}`, data),
  })
  assert.equal(store2.globalOf(), '评审意见一律用中文')
  store.setGlobal('')
  assert.equal(store.globalOf(), '')
})

test('项目约束：按 cwd 隔离，项目内共享；跨实例持久化', () => {
  const { store, fs } = makeScopes()
  store.setProject('/proj/a', '本项目用 Vue npm 工程')
  assert.equal(store.projectOf('/proj/a'), '本项目用 Vue npm 工程')
  // 不同 cwd 互不影响
  assert.equal(store.projectOf('/proj/b'), '')
  // 持久化文件为 map
  assert.ok(fs.files.get('/data/project-scopes.json').includes('/proj/a'))
  // 新实例（模拟重启）恢复
  const fs2 = { files: fs.files, writeFile: fs.writeFile, readFile: fs.readFile }
  const store2 = new ScopeStore({
    writeFile: (rel, data) => fs2.writeFile(`/data/${rel}`, data),
    readFile: (rel) => fs2.readFile(`/data/${rel}`),
    conversationFileOf: (sid) => `conversations/${sid}.json`,
    writeConversation: (rel, data) => fs2.writeFile(`/data/${rel}`, data),
  })
  assert.equal(store2.projectOf('/proj/a'), '本项目用 Vue npm 工程')
  // 空文本=清除
  store.setProject('/proj/a', '')
  assert.equal(store.projectOf('/proj/a'), '')
})

test('会话约束：按会话隔离，跨新建评审会话保留；空文本清除', () => {
  const { store, fs } = makeScopes()
  store.setSession('session-1', '本会话盯紧边界条件')
  assert.equal(store.sessionOf('session-1'), '本会话盯紧边界条件')
  assert.equal(store.sessionOf('session-2'), '')
  assert.ok(fs.files.get('/data/session-scopes/session-1.json').includes('边界条件'))
  store.setSession('session-1', '')
  assert.equal(store.sessionOf('session-1'), '')
})

test('评审会话约束：随 conversation 文件存储；reset 后清空', () => {
  const { store, fs } = makeScopes()
  store.setConversation('session-1', '本次评审会话重点看性能')
  assert.equal(store.conversationOf('session-1'), '本次评审会话重点看性能')
  // conversation 文件含 scopeText 且保留 epoch/messages
  const raw = JSON.parse(fs.files.get('/data/conversations/session-1.json'))
  assert.equal(raw.scopeText, '本次评审会话重点看性能')
  assert.ok(Array.isArray(raw.messages))
  // 模拟 conversation.reset（清空消息+epoch+1）——scopeText 一并清除
  fs.writeFile('/data/conversations/session-1.json', JSON.stringify({ epoch: 2, messages: [] }))
  assert.equal(store.conversationOf('session-1'), '')
})

test('约束校验：超长拒绝；空文本清除', () => {
  const { store } = makeScopes()
  assert.throws(() => store.setSession('s', 'x'.repeat(SCOPE_MAX_CHARS + 1)))
  // 空字符串 = 清除（不抛错）
  assert.equal(store.setSession('s', '  '), '')
})

test('buildAdvisorSystemPrompt：五层拼接（有则拼、无则省略）+ 层级标题', () => {
  const full = buildAdvisorSystemPrompt({
    system: '你是评审员',
    global: '全局约束内容',
    project: '项目约束内容',
    session: '会话约束内容',
    conversation: '评审会话约束内容',
  })
  assert.ok(full.includes('你是评审员'))
  assert.ok(full.includes('### 全局约束（所有项目所有会话生效'))
  assert.ok(full.includes('全局约束内容'))
  assert.ok(full.includes('### 项目约束（本工作区所有会话生效'))
  assert.ok(full.includes('项目约束内容'))
  assert.ok(full.includes('### 会话约束（本会话生效'))
  assert.ok(full.includes('会话约束内容'))
  assert.ok(full.includes('### 本次评审会话约束（本次评审会话生效'))
  assert.ok(full.includes('评审会话约束内容'))
  // 顺序：系统 → 全局 → 项目 → 会话 → 评审会话
  const idx = [full.indexOf('你是评审员'), full.indexOf('全局约束内容'), full.indexOf('项目约束内容'), full.indexOf('会话约束内容'), full.indexOf('评审会话约束内容')]
  assert.ok(idx[0] < idx[1] && idx[1] < idx[2] && idx[2] < idx[3] && idx[3] < idx[4])
})

test('buildAdvisorSystemPrompt：空层省略；全空返回空串', () => {
  const partial = buildAdvisorSystemPrompt({ system: 'SYS', session: 'SESS' })
  assert.ok(!partial.includes('项目约束'))
  assert.ok(!partial.includes('评审会话约束'))
  assert.equal(buildAdvisorSystemPrompt({ system: '' }), '')
})
