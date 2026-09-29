import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * 待确认队列「操作后就地更新、不再整块重拉、不丢编辑草稿」的静态契约测试。
 *
 * 背景（本次修复）：会话页 Tab 标题上的待确认红点只能靠「dispose + 重新注册
 * slot」刷新（DSH ui-slots 的 register() 只返回 dispose，没有就地更新 label 的
 * API），而重新注册会让整个 Tab 卸载重建。旧实现把队列状态与编辑草稿留在组件
 * 里，于是每次确认/删除：
 *   ① 成功后调 load() 把 /api/suggestions + /api/pending-skills + /api/config
 *      三个接口全部重拉一遍；
 *   ② 顺手 setEdits({}) / setTargetPicks({})——把用户在其他条目上还没提交的
 *      编辑和改轨选择一起清掉（按下标存草稿，删一条就整体错位，只能全清）；
 *   ③ 徽标变化触发宿主重注册 → 组件重挂 → 状态回到 null → 再闪一次「加载中」
 *      并再拉一遍。
 *
 * 现在：数据与草稿在模块级 store（src/client/memory-queue-store.ts）里，
 * 操作成功后按服务端回报的 removedIndices 就地删行；重挂只是重渲染。
 *
 * 这类行为在 node:test 里跑不起来（客户端模块 import react、且浏览器 API 只在
 * 构建产物里可用），所以与 client-config-save.test.js 同款做**源码 + 产物**的
 * 静态断言；产物需与源码一同重建，否则产物侧断言会失败。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VIEW = join(ROOT, 'src', 'client', 'MemoryQueueView.tsx')
const TAB = join(ROOT, 'src', 'client', 'MemoryTabView.tsx')
const STORE = join(ROOT, 'src', 'client', 'memory-queue-store.ts')
const BUNDLE = join(ROOT, 'lib', 'client.js')

const viewSource = readFileSync(VIEW, 'utf8')
const tabSource = readFileSync(TAB, 'utf8')
const storeSource = readFileSync(STORE, 'utf8')
const bundle = readFileSync(BUNDLE, 'utf8')

/** 去掉整行注释：负面断言不该被「旧代码曾经这样写」的解释性注释误伤。 */
function stripComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

const viewCode = stripComments(viewSource)

/** 截取 [from, to) 之间的源码片段。 */
function block(text, from, to) {
  const start = text.indexOf(from)
  assert.notEqual(start, -1, `未找到片段起点（${from}）`)
  const end = text.indexOf(to, start)
  assert.notEqual(end, -1, `未找到片段终点（${to}）`)
  return text.slice(start, end)
}

test('采纳/归档/拒绝后就地删行：按服务端回报的 removedIndices 更新本地队列', () => {
  const run = block(viewSource, 'const runSuggestions', 'const runSkill')
  assert.ok(
    /applyRemovedIndices\(report\.removedIndices\)/.test(run),
    'runSuggestions 必须按 report.removedIndices 就地删除——整块重拉是本次要修掉的卡顿源',
  )
  assert.ok(
    /removedIndices\?: number\[\]/.test(run),
    'runSuggestions 必须声明并消费 removedIndices（否则只能退回重拉）',
  )
  // 服务端没回报序号时才允许退回重拉（防御分支），正常路径不得重拉
  assert.ok(
    /report\.removedIndices === undefined[\s\S]*?load\(\)/.test(run),
    '缺少「服务端未回报序号时退回重拉」的兜底分支',
  )
  // 正常路径的对账只能走队列本身这一个接口（不是三接口全量 load）
  assert.ok(
    /reconcile\(\)/.test(run),
    '就地删行后必须静默对账一次（消除「服务端位次」与「本地快照」的漂移）',
  )
})

test('待确认技能操作后同样就地移除，不重拉整份列表', () => {
  const run = block(viewSource, 'const runSkill', 'const saveConfig')
  assert.ok(/removePendingSkill\(name\)/.test(run), 'runSkill 必须就地移除该技能')
  assert.ok(!/[^a-zA-Z]load\(/.test(run), 'runSkill 不得再调用整块重拉的 load()')
})

test('不再整体清空编辑草稿（旧实现每次操作 setEdits({}) / setTargetPicks({})）', () => {
  assert.ok(!/setEdits\(\{\}\)/.test(viewCode), 'MemoryQueueView 不得再整体清空编辑草稿')
  assert.ok(!/setTargetPicks\(\{\}\)/.test(viewCode), 'MemoryQueueView 不得再整体清空目标轨选择')
})

test('队列数据与草稿来自模块级 store（重挂不丢状态）', () => {
  assert.ok(/useQueueStore\(\)/.test(viewSource), 'MemoryQueueView 必须从模块级 store 取队列数据')
  for (const gone of ['useState<SuggestionEntry[]', 'useState<PendingSkill[]', 'useState<Record<number, string>>']) {
    assert.ok(!viewSource.includes(gone), `队列状态不应再留在组件本地：${gone}`)
  }
  for (const api of [
    'applyRemovedIndices',
    'hydrateQueue',
    'isQueueFresh',
    'markConfigSaved',
    'patchConfigDraft',
    'reconcileQueueEntries',
    'removePendingSkill',
    'setSuggestionEdit',
    'setSuggestionTarget',
    'suggestionKey',
    'useQueueStore',
  ]) {
    assert.ok(new RegExp(`export function ${api}\\b`).test(storeSource), `store 必须导出 ${api}`)
  }
  assert.ok(/export interface SuggestionEntry/.test(storeSource), 'store 必须定义 SuggestionEntry')
})

test('编辑草稿按「稳定键」存，不按会随删除前移的服务端序号', () => {
  // 草稿写入点（textarea / 目标轨下拉）必须用 suggestionKey(entry)
  assert.ok(
    /value=\{edits\[suggestionKey\(entry\)\] \?\? entry\.content\}/.test(viewSource),
    'textarea 的草稿必须按 suggestionKey 读',
  )
  assert.ok(
    /setSuggestionEdit\(suggestionKey\(entry\), event\.target\.value\)/.test(viewSource),
    'textarea 的草稿必须按 suggestionKey 写',
  )
  assert.ok(
    /value=\{targetPicks\[suggestionKey\(entry\)\] \?\? entry\.target\}/.test(viewSource),
    '目标轨下拉必须按 suggestionKey 读',
  )
  assert.ok(
    /setSuggestionTarget\(suggestionKey\(entry\), event\.target\.value\)/.test(viewSource),
    '目标轨下拉必须按 suggestionKey 写',
  )
  // 请求体仍按服务端原始序号对齐（序号不能变），内容按稳定键取
  const run = block(viewSource, 'const runSuggestions', 'const runSkill')
  assert.ok(
    /entries\?\.\[index - 1\]/.test(run),
    '请求体必须用「原始序号 → entries[index-1]」定位条目（序号语义不能改）',
  )
})

test('释放失败/未落地的条目不被本地误删（store 按 removedIndices 精确删除）', () => {
  assert.ok(
    /queueState\.entries\.filter\(\(_, index\) => !removed\.has\(index \+ 1\)\)/.test(storeSource),
    'applyRemovedIndices 必须只删服务端回报的序号',
  )
  assert.ok(
    /queueState\.edits = pruneDrafts\(queueState\.edits, alive\)/.test(storeSource),
    '移除条目时必须只清理被删条目的草稿（其余条目的编辑要留着）',
  )
})

test('记忆 Tab 重挂不再闪「加载中」：文件列表跨重挂用缓存', () => {
  const load = block(tabSource, 'const load = useCallback', '// 默认选中第一个可用文件')
  const preFetch = load.slice(0, load.indexOf('void api'))
  assert.ok(
    /if \(cached !== undefined\) \{[\s\S]*?setFiles\(cached\.files\)/.test(preFetch),
    'load 必须先检查缓存并用缓存立即渲染（这是重挂不闪空窗的关键）',
  )
  assert.ok(
    /\} else \{\s*\n\s*setFiles\(null\)\s*\n\s*\}/.test(preFetch),
    'setFiles(null) 只能出现在「本会话没有缓存」的 else 分支里，不得无条件清空',
  )
  assert.ok(/FILES_STALE_MS/.test(tabSource), '挂载时必须按新鲜期决定是否刷新（否则每次重挂都白拉一遍）')
})

test('构建产物与源码同步（removedIndices 链路必须重建进 lib/client.js）', () => {
  assert.ok(bundle.includes('removedIndices'), 'lib/client.js 未重建：产物里没有 removedIndices')
  assert.ok(bundle.includes('applyRemovedIndices'), 'lib/client.js 未重建：产物里没有 applyRemovedIndices')
  assert.ok(bundle.includes('removePendingSkill'), 'lib/client.js 未重建：产物里没有 removePendingSkill')
  assert.ok(!bundle.includes('setEdits({})'), 'lib/client.js 仍带旧的「整体清空草稿」写法，需重建')
})
