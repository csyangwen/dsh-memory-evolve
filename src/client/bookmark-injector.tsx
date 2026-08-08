/**
 * dsh-memory-evolve — 会话书签：轮尾星标按钮的 **DOM 注入器**（B 方案，用户拍板）。
 *
 * ## 为什么不用 turnTail 槽
 * `conversation.chat.turnTail` 是 chain 槽（first-wins，一次只能活一个 entry），
 * 官方 ui-deliverables 的 produced-files 行（每轮"生成的文件"）也注册在它上面。
 * 插件若占槽（priority=-5 + select 始终匹配）会把官方行挤掉。用户拍板改
 * **DOM 注入**：用 MutationObserver 把星标按钮"贴"到轮尾操作区旁边，官方
 * produced-files 行保留，两者共存（代价：非官方机制，React 重渲染后需保活
 * 重注入——本项目 session-filter 筛选条同款已验证稳定）。
 *
 * ## 轮尾定位（DSH 源码验证过的事实）
 * - 每条**已完成的 assistant 消息**的操作区都有 Branch 按钮（官方
 *   MessageIconActions）：文案 zh「在新对话中分支」/ en "Branch into a new
 *   conversation"（locale key `message.branch`）；**中间轮**的按钮带
 *   `aria-disabled="true"`（branchUnavailable），**轮尾**为 null/false
 *   （apps/web/tests/message-actions.e2e.ts 断言 ['true', null]）。
 * - 消息节点 DOM：`data-chat-anchor-key="node:{seq}"`（ChatView.tsx 渲染），
 *   seq 即消息事件 seq——与书签存储/跳转同坐标系（TurnTailOwnerProps.seq
 *   注释："the anchor the tail renders under"）。
 * - user 消息没有 Branch 按钮 → 天然排除。
 *
 * 因此：**节点内有 Branch 按钮 && 按钮 aria-disabled !== 'true' = 轮尾**。
 * 中间轮不打星（与官方 turnTail 只渲染轮尾的语义一致）。
 */
import { createRoot, type Root } from 'react-dom/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { TurnBookmarkButton } from './TurnBookmarkButton.tsx'

/** 注入的星标宿主容器 data 标记（保活重扫时跳过已注入的）。 */
const HOST_ATTR = 'data-bm-star-host'

/** Branch 按钮接管标记（幂等；React 重渲染重建按钮后标记丢失，observer 重扫会重新接管）。 */
const FORK_MARK = 'data-bm-fork-enabled'

/** Branch 按钮的匹配文案（zh/en 官方 locale；title/aria-label 均可能带）。 */
const BRANCH_PATTERNS = ['在新对话中分支', 'Branch into a new conversation']

/** 摘要预览最大字符数（与宿主 BOOKMARK_SUMMARY_MAX 对齐）。 */
const SUMMARY_MAX = 200

/** 注入器句柄。 */
export interface BookmarkInjector {
  dispose: () => void
}

/**
 * 从元素及其属性中解析消息 seq（data-chat-anchor-key="node:{seq}"）。
 * @param el - 消息节点元素。
 * @returns seq；解析失败返回 null（跳过该节点）。
 */
function parseSeq(el: HTMLElement): number | null {
  const key = el.getAttribute('data-chat-anchor-key') ?? ''
  const m = /^node:(\d+)$/.exec(key)
  if (m === null) return null
  const seq = Number(m[1])
  return Number.isInteger(seq) && seq >= 1 ? seq : null
}

/**
 * 判断元素是否是 Branch 按钮（官方消息操作区的分支入口）。
 * 用 title/aria-label 宽松子串匹配（zh/en），避免依赖 hash 化的 CSS class。
 * @param btn - 候选按钮元素。
 */
function isBranchButton(btn: Element): boolean {
  const title = (btn.getAttribute('title') ?? '') + ' ' + (btn.getAttribute('aria-label') ?? '')
  if (title === ' ') return false
  return BRANCH_PATTERNS.some((p) => title.includes(p))
}

/** 截断文本到摘要上限（去空白压缩）。 */
function clip(text: string): string {
  const joined = text.replace(/\s+/g, ' ').trim()
  if (joined.length <= SUMMARY_MAX) return joined
  return `${joined.slice(0, SUMMARY_MAX - 1)}…`
}

/**
 * 提取该轮的用户消息预览：从消息节点往前找最近的 **user 消息节点**
 * （无 Branch 按钮的消息节点 = user 消息），取文本截断。
 * 找不到返回 ''（宿主 upsert 兼容空摘要）。
 * @param node - 轮尾 assistant 消息节点。
 * @param root - 注入器扫描根（限定查找范围）。
 */
function extractSummary(node: HTMLElement, root: HTMLElement): string {
  // 收集 root 下按 DOM 顺序排列的消息节点。
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-chat-anchor-key^="node:"]'))
  const index = nodes.indexOf(node)
  if (index < 0) return ''
  // 往前找：最后一个没有 Branch 按钮的节点 = 最近的 user 消息。
  for (let i = index - 1; i >= 0; i -= 1) {
    const prev = nodes[i]
    if (prev === undefined) continue
    const hasBranch = prev.querySelector('button') !== null
      && Array.from(prev.querySelectorAll('button')).some(isBranchButton)
    if (!hasBranch) return clip(prev.textContent ?? '')
    // 遇到 assistant 消息就继续往前找（跨轮直到 user）。
  }
  return ''
}

/**
 * 创建书签星标注入器（模块启用时调用一次；dispose 卸载全部注入）。
 *
 * @param getSessionId - 当前会话 id 提供者（由 header.actions 捕获器写入；
 *   点击星标时才读取，避免注入器依赖 Tab 挂载时序）。
 * @param deps - 依赖：翻译函数。
 * @returns 注入器句柄（dispose）。
 */
export function createBookmarkInjector(
  getSessionId: () => string,
  deps: { t: Translate },
): BookmarkInjector {
  let disposed = false
  let observer: MutationObserver | null = null
  // 已挂载的 React 根：seq → { root, host }（dispose 时逐个卸载）。
  const mounted = new Map<number, { root: Root; host: HTMLElement }>()
  let scanRaf = 0 // rAF 节流句柄（高频 mutation 合并到下一帧）

  /** 查找消息节点内的轮尾 Branch 按钮（未禁用）。 */
  function findTailBranch(node: HTMLElement): HTMLButtonElement | null {
    const buttons = Array.from(node.querySelectorAll<HTMLButtonElement>('button'))
    const branch = buttons.find(isBranchButton)
    if (branch === undefined) return null
    // 中间轮：aria-disabled="true"（branchUnavailable）→ 跳过，只给轮尾打星。
    if (branch.getAttribute('aria-disabled') === 'true') return null
    return branch
  }

  /** 查找节点内任意 Branch 按钮（含禁用的中间轮）。 */
  function findBranchButton(node: HTMLElement): HTMLButtonElement | null {
    const buttons = Array.from(node.querySelectorAll<HTMLButtonElement>('button'))
    return buttons.find(isBranchButton) ?? null
  }

  /**
   * 接管中间轮的官方 Branch 按钮（用户拍板方案：**复用官方按钮**）：
   * - 最后一轮（按钮可用）= 官方本就支持 fork → **不干预**；
   * - 中间轮（官方 aria-disabled="true" + 禁用提示）= 启用按钮 + 替换
   *   title + 点击弹确认 → 调本插件 /fork API 实现"任意轮分支"。
   * 浏览器对 disabled 按钮不派发 click，所以必须先移除禁用属性才能拦截。
   *
   * ⚠️ 官方 Tooltip 是 primitives 组件渲染的**独立 bubble**（role="tooltip"，
   * label 来自 React prop），按钮上的 title/aria-label 不影响它——所以
   * 悬浮标注靠两件事：①按钮原生 title（我们的文案，浏览器原生提示）；
   * ②scan() 里隐藏被接管按钮的官方 bubble（否则官方"仅可从…"提示还在）。
   */
  function enableForkOnTurn(node: HTMLElement): void {
    const branch = findBranchButton(node)
    if (branch === null) return
    // 最后一轮：官方支持，不接管。
    if (branch.getAttribute('aria-disabled') !== 'true') return
    if (branch.hasAttribute(FORK_MARK)) return // 已接管（幂等）
    branch.setAttribute(FORK_MARK, '')
    branch.removeAttribute('aria-disabled')
    branch.removeAttribute('disabled')
    // data-unavailable 是官方禁用态样式选择器（按钮呈灰色），一并移除。
    branch.removeAttribute('data-unavailable')
    // 官方禁用提示替换为 Memory Evolve 增强说明（原生 title 悬浮显示）。
    branch.title = deps.t('bookmark.fork.title')
    branch.setAttribute('aria-label', deps.t('bookmark.fork.title'))
    branch.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const seq = parseSeq(node)
      const sessionId = getSessionId()
      if (seq === null || sessionId === '') {
        window.alert(deps.t('bookmark.error', { message: deps.t('bookmark.noSession') }))
        return
      }
      // 确认弹窗：官方不支持的行为，明确告知后再执行。
      if (!window.confirm(deps.t('bookmark.fork.confirm', { n: String(seq) }))) return
      void fetch('/memory-evolve/api/bookmarks/fork', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, seq }),
      })
        .then((res) => res.json().catch(() => ({})) as Promise<{ sessionId?: string; error?: string }>)
        .then((data) => {
          if (typeof data.sessionId === 'string') {
            window.alert(deps.t('bookmark.fork.ok', { id: data.sessionId }))
          } else {
            window.alert(deps.t('bookmark.error', { message: data.error ?? 'HTTP error' }))
          }
        })
        .catch((error: Error) => {
          window.alert(deps.t('bookmark.error', { message: error.message }))
        })
    })
  }

  /** 扫描一次：为所有未注入的轮尾消息贴星标。 */
  function scan(): void {
    if (disposed) return
    const root = document.querySelector<HTMLElement>('[data-chat-flow]')
    if (root === null) return // 对话区未挂载（可能在别的 Tab）
    // 清理官方 Tooltip bubble：被接管按钮（FORK_MARK）的兄弟
    // [role="tooltip"] 是 React 渲染的官方提示（"仅可从…"），悬浮时会
    // 误导用户以为仍不可用——隐藏它，让原生 title（我们的说明）生效。
    // bubble 是 Tooltip fragment 里按钮的下一个兄弟。
    const bubbles = root.querySelectorAll<HTMLElement>('[role="tooltip"]')
    for (const bubble of bubbles) {
      const prev = bubble.previousElementSibling
      if (prev instanceof HTMLButtonElement && prev.hasAttribute(FORK_MARK)) {
        bubble.style.display = 'none'
      }
    }
    const nodes = root.querySelectorAll<HTMLElement>('[data-chat-anchor-key^="node:"]')
    for (const node of nodes) {
      // 分支接管：每个消息节点都处理（中间轮启用+接管；最后一轮官方不动）。
      enableForkOnTurn(node)
      // 星标注入：仅轮尾（Branch 可用）。
      if (node.querySelector(`[${HOST_ATTR}]`) !== null) continue // 已注入
      const seq = parseSeq(node)
      if (seq === null) continue
      const branch = findTailBranch(node)
      if (branch === null) continue // 非轮尾（user 消息 / 中间轮 / 未完成）
      const summary = extractSummary(node, root)
      // 注入宿主容器 + React 根（星标按钮）。afterend：紧挨 Branch 按钮。
      const host = document.createElement('div')
      host.setAttribute(HOST_ATTR, '')
      host.dataset.bmSeq = String(seq)
      branch.insertAdjacentElement('afterend', host)
      const rootNode = createRoot(host)
      rootNode.render(
        <TurnBookmarkButton
          seq={seq}
          turn={null} // DOM 拿不到 turn 号；宿主 upsert 兼容 turn=null（默认名用 seq）
          summary={summary}
          sessionId={getSessionId}
          t={deps.t}
        />,
      )
      mounted.set(seq, { root: rootNode, host })
    }
  }

  /** 启动保活观察（body childList+subtree；rAF 节流合并高频变更）。 */
  observer = new MutationObserver(() => {
    if (disposed) return
    if (scanRaf !== 0) return
    scanRaf = requestAnimationFrame(() => {
      scanRaf = 0
      if (disposed) return
      scan()
    })
  })
  observer.observe(document.body, { childList: true, subtree: true })
  scan() // 初始注入

  return {
    dispose(): void {
      disposed = true
      if (scanRaf !== 0) {
        cancelAnimationFrame(scanRaf)
        scanRaf = 0
      }
      observer?.disconnect()
      observer = null
      // 卸载全部 React 根并移除宿主容器。
      for (const { root: r, host } of mounted.values()) {
        r.unmount()
        host.remove()
      }
      mounted.clear()
    },
  }
}
