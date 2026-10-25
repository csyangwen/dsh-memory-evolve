/**
 * 回归测试：DSH 0.1.2-alpha.4+ 的 Session 形状（`ownEvents()` 取代 `.events`）在
 * 通知 / 技能这几处读取点上的表现。
 *
 * 背景：#38 适配了 `lib/review.js`、#49 适配了 `lib/advisor/*`，但另有 5 处读取点
 * 仍在直读 `agent.session.events`——现代 Session 上读到 `undefined`，且都是「读不到
 * 就静默降级/拒绝」的形态，不报错，只表现为功能不可用：`hasReadSkill()` 恒 false
 * 导致 `skill_manage action=patch` 永久被拒（issue #90 / #61）、`resolveSessionImage`
 * 报「无法读取本会话事件」、`de_session_images` 读不到图（issue #62）、会话「最后
 * 活动」永远为空。
 *
 * 本套件钉住三件事（缺任何一条都会让 bug 复发或者改成另一种错）：
 *   1. `ownEvents()` 存在时必须优先使用——否则新宿主上仍然读不到；
 *   2. `ownEvents()` 不存在时退回 `.events`——老宿主行为不变；
 *   3. 「读不到」必须保持 `undefined`：顺手写 `?? []` 会让空数组去短路那段「如实
 *      降级」的分支，于是「读不到会话事件」被说成「本会话没有图片」（本 PR 实测到
 *      的两个 tests/notify.test.js 失败就是这条）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { hasReadSkill } from '../lib/skills.js'
import { resolveSessionImage, querySessionImages } from '../lib/notify.js'

// This suite pins the legacy Chinese output contract; i18n.test.js covers English.
import { setLocale } from '../lib/i18n.js'
setLocale('zh')

/** 一条「已 read 过某技能」的 tool/call 事件（hasReadSkill 的证据形态）。 */
function readCallEvents(toolName = 'skill_manage', name = 'grill-me') {
  return [{
    type: 'tool/call',
    seq: 0,
    time: 1,
    data: { name: toolName, arguments: JSON.stringify({ action: 'read', name }) },
  }]
}

/** 一条含图片的本会话事件（scanSessionImageRefs 的最小可采集形态）。 */
function imageEvents() {
  return [{
    type: 'user/message',
    seq: 0,
    time: 1000,
    data: {
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', attachment: { attachmentId: 'sha256:aaa', mediaType: 'image/png', bytes: 100, width: 10, height: 10, name: 'a.png' } },
      ],
    },
  }]
}

/**
 * 构造 ctx：`agents.get('session-1').session` 返回给定形状。
 * 新式 Session 只传 `{ ownEvents: () => [...] }`（没有 `.events` 字段），
 * 老式 Session 只传 `{ events: [...] }`。
 */
function ctxWithSession(session) {
  return {
    get(name) {
      if (name === 'agents') {
        return { get: (sid) => (sid === 'session-1' ? { session } : undefined) }
      }
      if (name === 'attachments') {
        return { readImage: async (ref) => ({ ref, data: new Uint8Array(Buffer.from('fake-image-bytes')) }) }
      }
      return undefined
    },
  }
}

test('hasReadSkill：ownEvents() 优先、无 ownEvents 退回 .events、两者都无 → false', () => {
  const events = readCallEvents()
  // 新式 Session（只有 ownEvents()）必须能证明「已读」——否则 patch 永久被拒（issue #90）
  assert.equal(hasReadSkill({ session: { ownEvents: () => events } }, 'skill_manage', 'grill-me'), true)
  // 老式 Session 行为不变
  assert.equal(hasReadSkill({ session: { events } }, 'skill_manage', 'grill-me'), true)
  // 读不到事件 = 无法证明，保守返回 false（不是「读到了但没有」）
  assert.equal(hasReadSkill({ session: {} }, 'skill_manage', 'grill-me'), false)
  assert.equal(hasReadSkill({ session: { ownEvents: () => [] } }, 'skill_manage', 'grill-me'), false)
})

test('resolveSessionImage：ownEvents() 形状的会话也能读到图片', async () => {
  const ctx = ctxWithSession({ ownEvents: () => imageEvents() })
  const media = await resolveSessionImage(ctx, 'session-1', { kind: 'image', sessionImage: true })
  assert.equal(media.kind, 'image')
  assert.equal(media.fileName, 'a.png')
  assert.equal(typeof media.base64, 'string')
})

test('读不到会话事件时必须如实降级——不能被 ?? [] 短路成「本会话没有图片」', async () => {
  // 既无 ownEvents 也无 .events（会话不在本进程）
  const unreadable = ctxWithSession({})
  await assert.rejects(
    () => resolveSessionImage(unreadable, 'session-1', { kind: 'image', sessionImage: true }),
    /无法读取本会话事件/,
  )
  const q = await querySessionImages(unreadable, { agent: { session: { id: 'session-1' } } }, {})
  assert.match(q.summary, /无法读取本会话事件/)

  // 读得到但没有图片 —— 与上面的「读不到」必须区分
  const readableEmpty = ctxWithSession({ ownEvents: () => [] })
  const q2 = await querySessionImages(readableEmpty, { agent: { session: { id: 'session-1' } } }, {})
  assert.match(q2.summary, /没有图片/)
})
