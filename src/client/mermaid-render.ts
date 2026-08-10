/**
 * dsh-memory-evolve — Mermaid 图表渲染（DSH UI 设置模块·功能六）。
 *
 * 背景（调研 docs-local/Mermaid显示支持-调研-20260810.md）：DSH Web GUI 的
 * Markdown 渲染管线（ui-primitives render.tsx / CodeBlock / Shiki 语法
 * 白名单）没有 mermaid 分支，```mermaid 块一律显示为代码文本（无高亮、
 * 可复制）。本模块用 client 侧 DOM 增强补上：MutationObserver 监听消息
 * 区，把 mermaid 代码块渲染成 SVG 图表，PC 与手机端（同一 Web GUI 的
 * 响应式）同时生效。
 *
 * 架构决策：
 * 1. 引擎懒加载：mermaid.min.js（UMD，3.4MB）不打进 client bundle（主
 *    bundle 是 esbuild 单文件，打进会拖慢首屏），由宿主端静态端点
 *    /memory-evolve/mermaid/mermaid.min.js 提供；首次见到 mermaid 块时
 *    才 <script> 注入，之后浏览器缓存（见 lib/mermaid.js）。
 * 2. DOM 增强而非改渲染器：DSH 渲染器无消息级挂载点且 DOM 被 pin（不可
 *    信输出策略），只在外围替换 .md-code-block 的正文；失败/关闭随时可弃。
 * 3. 控制器模式（setEnabled/dispose）：与 wide-chat / session-filter 同款，
 *    开关挂「DSH UI 设置」Tab「综合」子 tab（localStorage + 事件广播）。
 * 4. 内容稳定判定：流式输出时代码块持续变化，等内容停顿 STABLE_MS 且两次
 *    读取一致才渲染，避免渲染半截语法报错。
 * 5. React 重渲染防御：CodeBlock 由 React 渲染，重渲染会把 SVG 还原成代码
 *    ——成功渲染后打 data-me-mermaid 标记；观察器发现「已渲染但 wrap 不在」
 *    （被还原）时重新渲染；源码没变不重复渲染。
 * 6. 主题：按页面背景亮度选 mermaid 的 base/dark 主题（粗适配，二期做
 *    完整主题跟随）；SVG 背景透明，融入消息气泡。
 *
 * 安全：SVG 由本地 mermaid 引擎生成（mermaid 默认 securityLevel 'strict'
 * 剥离 click 等交互），非模型原文直接进 DOM，与 CodeBlock 里 shiki 的
 * dangerouslySetInnerHTML 同性质。
 */

/** 内容稳定判定等待时长（ms）：流式输出停顿这么久且内容不变才渲染。 */
const STABLE_MS = 400

/** 引擎脚本地址（宿主端静态端点，见 lib/mermaid.js）。 */
const ENGINE_SRC = '/memory-evolve/mermaid/mermaid.min.js'

/** 引擎脚本的标记属性（用于识别/去重）。 */
const SCRIPT_MARK = 'data-me-mermaid'

/** 渲染成功的标记属性（写在块上，观察器据此判断是否已处理）。 */
const RENDERED_MARK = 'data-me-mermaid-rendered'

/** mermaid UMD 全局对象的极简类型（只用到 initialize/render）。 */
interface MermaidEngine {
  initialize(options: object): void
  render(id: string, text: string): Promise<{ svg: string }>
}

/** 单个代码块的处理状态（WeakMap 持有，块离开 DOM 自动回收）。 */
interface BlockState {
  /** 上一次读取到的源码（用于稳定判定）。 */
  source: string
  /** 稳定判定计时器句柄。 */
  timer?: number
  /** 已渲染（含渲染失败标记态——失败也标记，避免反复重试刷屏）。 */
  rendered: boolean
}

/** 全局 mermaid 引擎加载 Promise（只加载一次）。 */
let enginePromise: Promise<MermaidEngine> | undefined

/** 每块渲染的递增 id（mermaid.render 要求唯一 id）。 */
let renderSeq = 0

/** 各代码块状态表（WeakMap：不泄漏，块移除即回收）。 */
const states = new WeakMap<HTMLElement, BlockState>()

/**
 * 读取全局 mermaid（懒加载：首次调用才注入 <script>）。
 *
 * @returns 初始化好的 mermaid 引擎单例 Promise；加载失败 reject（调用方
 *   捕获后静默降级回代码块）。
 */
function loadMermaid(): Promise<MermaidEngine> {
  enginePromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = ENGINE_SRC
    script.setAttribute(SCRIPT_MARK, '')
    script.onload = () => {
      const mermaid = (window as unknown as { mermaid?: MermaidEngine }).mermaid
      if (mermaid === undefined) {
        reject(new Error('mermaid global missing after script load'))
        return
      }
      // startOnLoad: false——不自动扫描页面，全由本模块调度；
      // theme: 按页面背景亮度选 base/dark（浅色→base，深色→dark）；
      // background: transparent——SVG 背景融入消息气泡，不出现白/黑方块。
      mermaid.initialize({
        startOnLoad: false,
        theme: detectTheme(),
        themeVariables: { background: 'transparent' },
      })
      resolve(mermaid)
    }
    script.onerror = () => reject(new Error(`mermaid engine load failed: ${ENGINE_SRC}`))
    document.head.appendChild(script)
  })
  return enginePromise
}

/**
 * 按页面背景亮度选 mermaid 主题（粗适配）：背景暗 → 'dark'，亮 → 'base'。
 *
 * @returns mermaid 主题名。
 */
function detectTheme(): 'dark' | 'base' {
  const bg = getComputedStyle(document.body).backgroundColor
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(bg)
  if (match === null) return 'base'
  const luminance = (0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3])) / 255
  return luminance < 0.5 ? 'dark' : 'base'
}

/**
 * 判断一个代码块是否是 mermaid 块：banner 的语言标签文本恰为 mermaid。
 *
 * CodeBlock 的 banner 是 <div class="{css.infostring}">lang</div>（CSS
 * module 类名含 infostring 子串），流式进行中 lang 为 undefined（banner
 * 空），settle 后才显示 'mermaid'——配合稳定判定自然只在完整后识别。
 *
 * @param block - .md-code-block 根元素。
 * @returns 是否 mermaid 块。
 */
function isMermaidBlock(block: HTMLElement): boolean {
  const info = block.querySelector<HTMLElement>('[class*="infostring"]')
  return info?.textContent?.trim().toLowerCase() === 'mermaid'
}

/**
 * 渲染一个已稳定的 mermaid 块：引擎渲染 SVG → 包滚动容器替换 pre 正文。
 *
 * 复制按钮兼容：CodeBlock 的复制回调取 pre 文本，pre 被替换后 fallback 到
 * 闭包里的源码（trimmed）——复制按钮仍然复制 mermaid 源码，行为合理。
 *
 * @param block - 目标代码块。
 * @param source - 已确认稳定的 mermaid 源码。
 * @param state - 该块的处理状态（成功后置 rendered，失败也置——防刷屏）。
 */
async function renderBlock(block: HTMLElement, source: string, state: BlockState): Promise<void> {
  try {
    const engine = await loadMermaid()
    const pre = block.querySelector('pre')
    // 等待期间块被 React 换掉（重渲染/移除）→ 放弃本轮，等观察器下一轮。
    if (pre === null || !pre.isConnected) return
    const { svg } = await engine.render(`me-${++renderSeq}`, source)
    const preAfter = block.querySelector('pre')
    if (preAfter !== pre) return // 渲染期间被 React 替换，放弃（下一轮重来）
    const wrap = document.createElement('div')
    wrap.className = 'me-mermaid-wrap'
    wrap.innerHTML = svg
    pre.replaceWith(wrap)
    state.rendered = true
    block.setAttribute(RENDERED_MARK, '')
  } catch (error) {
    // 渲染失败（语法错误等）：保留原代码块（用户仍可复制源码），标记
    // 失败态避免反复重试；刷新页面可重新尝试。
    state.rendered = true
    block.setAttribute(RENDERED_MARK, '')
    console.warn('[dsh-memory-evolve] mermaid render failed:', error)
  }
}

/**
 * 调度一个代码块：识别 mermaid → 内容稳定判定 → 渲染。
 *
 * 流式输出中每帧都会调用（观察器回调），内部短路：源码未变直接返回；
 * 源码变了重置 STABLE_MS 计时器，到时再对比一次，一致才渲染。
 *
 * @param block - 候选代码块（.md-code-block 或其中的元素）。
 */
function schedule(block: HTMLElement): void {
  if (!isMermaidBlock(block)) return
  let state = states.get(block)
  if (state === undefined) {
    state = { source: '', rendered: false }
    states.set(block, state)
  }
  // 捕获为 const：setTimeout 闭包会引用 state，TS 对 let 的收窄在闭包
  // 捕获后会失效（conservative reset），const 捕获不受影响。
  const s = state
  // React 重渲染把图还原成代码：标记还在但 wrap 已不在 → 重置重走。
  if (s.rendered && block.querySelector('.me-mermaid-wrap') === null) {
    s.rendered = false
    block.removeAttribute(RENDERED_MARK)
  }
  if (s.rendered) return
  const source = block.querySelector('pre')?.textContent ?? ''
  if (source === s.source) return // 内容未变，等待计时器到期对比
  s.source = source
  window.clearTimeout(s.timer)
  s.timer = window.setTimeout(() => {
    const current = block.querySelector('pre')?.textContent ?? ''
    if (current === s.source) {
      // 两次读取一致 = 流式已稳定 → 渲染。
      void renderBlock(block, s.source, s)
    } else {
      schedule(block) // 仍在变化（流式继续）→ 重新计时。
    }
  }, STABLE_MS)
}

/**
 * 创建 Mermaid 渲染控制器（模块启用时调用一次，开关事件驱动启停）。
 *
 * @returns { setEnabled, dispose }：setEnabled(false)=停止观察（已渲染的
 *   图保留，刷新后随开关状态恢复）；dispose=模块卸载清理。
 */
export function createMermaidRenderer(): { setEnabled(enabled: boolean): void; dispose(): void } {
  let observer: MutationObserver | undefined
  let disposed = false

  /** 观察器回调：新增节点（消息渲染/历史回放/React 重挂载）→ 调度处理。 */
  const onMutations = (mutations: MutationRecord[]): void => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue
          const block = node.classList.contains('md-code-block') ? node : node.closest<HTMLElement>('.md-code-block')
          if (block !== null) schedule(block)
        }
      } else if (mutation.target instanceof HTMLElement) {
        // characterData（流式文本更新）/ attributes（banner 语言标签出现、
        // 类名变化）→ 顺带调度目标所在块，覆盖「流式中途停顿超 STABLE_MS
        // 后恢复」等 childList 感知不到的情况。
        const block = mutation.target.closest<HTMLElement>('.md-code-block')
        if (block !== null) schedule(block)
      }
    }
  }

  /**
   * 开关同步：true=启动观察 + 全量扫描现有消息（历史回放）；
   * false=停止观察（已渲染图保留，不还原，刷新后恢复代码块）。
   */
  const setEnabled = (enabled: boolean): void => {
    if (disposed) return
    if (enabled && observer === undefined) {
      observer = new MutationObserver(onMutations)
      // childList+subtree 捕获新块；characterData 捕获流式文本更新；
      // attributes(class) 捕获 banner 语言标签出现。
      observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] })
      // 全量扫描当前已渲染的消息（打开开关时立即生效于历史消息）。
      for (const block of document.querySelectorAll<HTMLElement>('.md-code-block')) schedule(block)
    } else if (!enabled && observer !== undefined) {
      observer.disconnect()
      observer = undefined
    }
  }

  return {
    setEnabled,
    dispose() {
      disposed = true
      observer?.disconnect()
      observer = undefined
    },
  }
}
