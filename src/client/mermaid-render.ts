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
 *    开关挂「Web UI 设置」Tab「综合」子 tab（localStorage + 事件广播）。
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

/**
 * 强制重试路径的稳定判定等待（ms）：渲染被打断/图被还原时内容不会再变
 * （React 重建不改内容），短等待即可，缩短 Tab 切换恢复时间。
 */
const FORCE_STABLE_MS = 150

/** 渲染被打断后的重试延迟（ms）：等 React 重建窗口过去再重试（重建通常 <100ms）。 */
const RETRY_DELAY_MS = 200

/** 引擎脚本地址（宿主端静态端点，见 lib/mermaid.js）。 */
const ENGINE_SRC = '/memory-evolve/mermaid/mermaid.min.js'

/** 引擎脚本的标记属性（用于识别/去重）。 */
const SCRIPT_MARK = 'data-me-mermaid'

/** 渲染成功的标记属性（写在块上，观察器据此判断是否已处理）。 */
const RENDERED_MARK = 'data-me-mermaid-rendered'

/**
 * 渲染永久失败的标记属性（写在块上）。restore 检测（rendered 但 wrap 不在）
 * 见到它不再重置重试——否则语法错误块会被延迟重扫反复重置，而每次重试
 * 失败 mermaid 都会往 body 末尾插一个错误图（#d{id}），无限循环堆积
 * （2026-08-10 实测：页面下方堆了一串 "Syntax error in text"）。
 */
const FAILED_MARK = 'data-me-mermaid-failed'

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
  /** 渲染进行中（防并发：稳定判定 timer 与延迟重试可能重叠）。 */
  rendering: boolean
  /** 连续失败次数（临时性失败如引擎加载可重试，语法错误 2 次后放弃）。 */
  failCount: number
  /** 引擎加载连续失败次数（只用于控制 console 只打一次，不参与放弃判定——引擎失败永远可重试）。 */
  engineFails: number
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
 * 失败可恢复（Grok 审阅意见 P0-②）：加载失败时把缓存的 Promise 重置为
 * undefined，下次调用重新注入 <script> 重试——否则一次失败（端点闪断/
 * 网络抖动）会让 Promise 永久粘死在 rejected，模块废到刷新。
 *
 * @returns 初始化好的 mermaid 引擎单例 Promise；加载失败 reject（调用方
 *   捕获后按引擎失败路径处理，不置永久放弃）。
 */
function loadMermaid(): Promise<MermaidEngine> {
  enginePromise ??= new Promise((resolve, reject) => {
    // 防御：若之前失败注入的 script 残留，先移除再重新注入（避免重复 script）。
    document.querySelector(`script[${SCRIPT_MARK}]`)?.remove()
    const script = document.createElement('script')
    script.src = ENGINE_SRC
    script.setAttribute(SCRIPT_MARK, '')
    const fail = (reason: string): void => {
      enginePromise = undefined // 允许下次调用重新加载（失败可恢复）。
      reject(new Error(reason))
    }
    script.onload = () => {
      const mermaid = (window as unknown as { mermaid?: MermaidEngine }).mermaid
      if (mermaid === undefined) {
        fail('mermaid global missing after script load')
        return
      }
      // startOnLoad: false——不自动扫描页面，全由本模块调度；
      // securityLevel: 'strict'——显式声明安全契约（Grok 审阅意见 P0-③，
      //   不依赖上游默认值：剥离 click 等交互，模型源码不进可执行面）；
      // suppressErrorRendering: true——渲染失败时 mermaid 默认会把错误图
      //   插进 body 末尾的 #d{id} 元素且不清理（源码 removeTempElements
      //   只在成功或本配置时执行），开启后失败只 reject、由本模块处理
      //   （2026-08-10 实测：语法错误块在页面下方堆了一串 "Syntax error
      //   in text / mermaid version 11.16.0"）；
      // theme: 按页面背景亮度选 base/dark（浅色→base，深色→dark）；
      // background: transparent——SVG 背景融入消息气泡，不出现白/黑方块。
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: detectTheme(),
        themeVariables: { background: 'transparent' },
      })
      resolve(mermaid)
    }
    script.onerror = () => fail(`mermaid engine load failed: ${ENGINE_SRC}`)
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
 * 渲染永久失败时在代码块上方插入一行提示（保留原代码供复制修正）。
 *
 * 之前的行为是静默保留代码块——用户看到"还是代码"却不知道为什么。
 * 提示文案跟随页面语言（zh/en），颜色样式见 mermaid-render.css。
 * 附带 mermaid 错误信息首行（含行号定位，如 "Lexical error on line 5.
 * Unrecognized text."），用户/AI 可据此针对性修正。
 *
 * @param block - 目标代码块。
 * @param error - 最后一次渲染失败的错误（可选，用于提取定位信息）。
 */
function showErrorHint(block: HTMLElement, error?: unknown): void {
  if (block.querySelector('.me-mermaid-error') !== null) return // 已提示过，不重复插入。
  const pre = block.querySelector('pre')
  if (pre === null) return
  const hint = document.createElement('div')
  hint.className = 'me-mermaid-error'
  // mermaid 错误信息首行含定位（如 "Lexical error on line 5. Unrecognized text."），
  // 展示给用户/AI 便于针对性修正；截断防超长。
  const detail = error instanceof Error
    ? (String(error.message).split('\n')[0] ?? '').slice(0, 80)
    : ''
  const zh = (document.documentElement.lang ?? '').toLowerCase().startsWith('zh')
  hint.textContent = zh
    ? `⚠ mermaid 渲染失败${detail === '' ? '' : `：${detail}`}，已保留代码（可复制修正）`
    : `⚠ mermaid render failed${detail === '' ? '' : `: ${detail}`}, code kept`
  pre.insertAdjacentElement('beforebegin', hint)
}

/**
 * mermaid 源码高置信度自动修正（首次渲染失败后尝试一次）。
 *
 * 雷区实测（2026-08-11，kroki / mermaid.ink 双真实引擎验证，mermaid 11.16.0）：
 * 1. subgraph 标题字符集极窄：全角/半角括号、！？等标点都会报
 *    "Lexical error ... Unrecognized text"；用双引号包裹标题即可绕过
 *    （subgraph "标题（任意标点）" 实测通过）——AI 生成的图 subgraph
 *    标题带中文括号太常见，这是"很多图显示不出来"的头号原因。
 * 2. 边标签 |...| 与节点标签 [...] 里的半角引号（'、"）和半角括号
 *    （()）会被 lexer 当成语法 token（STR / 形状定界符），报
 *    "Parse error ... got 'STR'"；换成中文全角等价字符（‘ ’ “ ” （ ））
 *    即成为普通文本，语义不变（实测通过）。引号按出现顺序交替成对
 *    （第奇数个→左引号，第偶数个→右引号），`ctx.get('llm')` 显示为
 *    `ctx.get（‘llm’）`。
 *
 * 原则：只做上述高置信度替换，宁可不修也不乱改——改错语义比不渲染更糟；
 * 修正版仅用于渲染，代码块内保留原文供复制。
 *
 * @param source - 原始 mermaid 源码。
 * @returns 修正后的源码；无需修正时返回 null。
 */
function autoFixMermaid(source: string): string | null {
  let changed = false
  const fixed = source.split('\n').map((line) => {
    // 规则 1：subgraph 标题引号化。
    //   形如 "subgraph 标题" 的行；标题未用引号包裹、也未用 [id] 形式，
    //   且含 mermaid 标题 token 不认的标点 → 双引号包裹（内部 " 转义）。
    const sub = /^(\s*subgraph\s+)(.+?)\s*$/.exec(line)
    if (sub !== null) {
      const title = sub[2]
      if (
        !title.startsWith('"') &&
        !title.startsWith('[') &&
        /[（）()！？!?，。；：、""''【】《》]/.test(title)
      ) {
        changed = true
        return `${sub[1]}"${title.replace(/"/g, '\\"')}"`
      }
      return line
    }
    // 规则 2：边标签（-->|label|）里的危险字符中文化。
    //   仅处理竖线形式标签（--text--> 形式不猜）；已用引号包裹的标签
    //   跳过（不猜作者的转义意图）。
    const edge = /^(\s*\S[^|]*?)\|([^|]*)\|(.*)$/.exec(line)
    if (edge !== null && edge[1].includes('-->') && !edge[2].startsWith('"') && !edge[2].startsWith("'")) {
      const fixedLabel = fixDangerChars(edge[2])
      if (fixedLabel !== edge[2]) {
        changed = true
        return `${edge[1]}|${fixedLabel}|${edge[3]}`
      }
      return line
    }
    // 规则 3：节点标签 [...] 里的半角引号中文化（[ 后紧跟引号 = 已包裹，
    //   跳过；半角括号在节点文本里实测安全，不处理）。
    const node = /^(\s*\S+?\s*)(\[)([^\]]*)(\])(.*)$/.exec(line)
    if (node !== null && !node[3].startsWith('"') && !node[3].startsWith("'") && /['"]/.test(node[3])) {
      const fixedText = fixDangerChars(node[3])
      if (fixedText !== node[3]) {
        changed = true
        return `${node[1]}${node[2]}${fixedText}${node[4]}${node[5]}`
      }
    }
    return line
  })
  return changed ? fixed.join('\n') : null
}

/**
 * 把一段 mermaid 文本里的半角引号/括号换成中文全角等价字符。
 *
 * 引号按出现顺序交替成对：' → ‘（开）/'（闭），" → “（开）/”（闭）；
 * 括号成对替换：( → （，) → ）。
 *
 * @param text - 原始文本。
 * @returns 替换后的文本（无危险字符时原样返回）。
 */
function fixDangerChars(text: string): string {
  let singleOpen = true
  let doubleOpen = true
  return text.replace(/['"()]/g, (ch) => {
    if (ch === "'") { const q = singleOpen ? '\u2018' : '\u2019'; singleOpen = !singleOpen; return q }
    if (ch === '"') { const q = doubleOpen ? '\u201c' : '\u201d'; doubleOpen = !doubleOpen; return q }
    return ch === '(' ? '\uff08' : '\uff09'
  })
}

/**
 * 在 mermaid 块的操作区（复制按钮旁）补插「下载」按钮（幂等）。
 *
 * 按钮插在 CodeBlock 的 .banner .action 容器里（React 渲染的 DOM）——
 * 复制按钮点击会切换 copied 状态、触发该区域 React 重渲染，把插件插入
 * 的按钮清掉；本函数由 schedule（每个 mutation 命中已渲染块时）反复调用，
 * 发现缺失即补插，实现按钮持久存在。
 *
 * @param block - 已渲染的 mermaid 代码块。
 */
function ensureDownloadButton(block: HTMLElement): void {
  const wrap = block.querySelector<HTMLElement>('.me-mermaid-wrap')
  if (wrap === null) return
  const svg = wrap.querySelector<SVGSVGElement>('svg')
  if (svg === null) return
  // 幂等：按钮已存在（自己插的）则不动，避免重复累积。
  // ⚠️ 必须 **block 级** 检查：按钮优先插在 wrap 之外的 .action 操作区
  // （复制按钮旁），若只查 wrap 内部永远查不到 → 每次 mutation 都重复
  // 插入 → 插入本身又触发新的 mutation → observer 自激无限循环 → 主线程
  // 被占满、页面卡死（2026-08-11 实测事故，commit cde0038 已回滚修复）。
  if (block.querySelector('.me-mermaid-download') !== null) return
  // 优先插到复制按钮所在的操作区（.action，CSS module 类名含 action
  // 子串），贴近用户期望的"复制按钮旁边"；找不到操作区（结构变化）
  // 则退回 wrap 右上角（CSS 里绝对定位兜底）。
  const action = block.querySelector<HTMLElement>('[class*="action"]')
  const target = action ?? wrap
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'me-mermaid-download'
  const zh = (document.documentElement.lang ?? '').toLowerCase().startsWith('zh')
  btn.textContent = zh ? '下载' : 'SVG'
  btn.title = zh ? '下载此图为 SVG（矢量，可无损缩放）' : 'Download diagram as SVG'
  btn.addEventListener('click', (event) => {
    event.stopPropagation() // 不冒泡，避免误触块级行为。
    downloadSvg(svg)
  })
  target.appendChild(btn)
}

/**
 * 把块内的 SVG 图序列化并触发浏览器下载（.svg 文件）。
 *
 * 用 XMLSerializer 序列化 DOM 中的 svg（含 mermaid 生成的 <style> 与
 * foreignObject 文本），零依赖、无损矢量；文件名带本地时间戳。
 * 选择 SVG 而非 PNG：SVG 是 mermaid 的标准交付格式、任意放大不糊；
 * PNG 需 canvas 转换，而 mermaid 默认 htmlLabels 生成的 foreignObject
 * 在 canvas 绘制时文本会丢失（浏览器规范限制），一期不做。
 *
 * @param svg - 要下载的 SVG 元素。
 */
function downloadSvg(svg: SVGSVGElement): void {
  const xml = new XMLSerializer().serializeToString(svg)
  const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  const a = document.createElement('a')
  a.href = url
  a.download = `mermaid-${stamp}.svg`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
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
  // 防并发：同一块同时只允许一个渲染在途（稳定判定 timer 与延迟重试可能
  // 重叠，重复渲染同一 id 的 mermaid 图会互相干扰）。
  if (state.rendering) return
  state.rendering = true
  // 引擎加载单独 try/catch（Grok 审阅意见 P0-④ 失败分级）：
  //   引擎失败 = 环境问题（端点闪断/网络抖动）→ 不计数、不置永久放弃，
  //   走下方统一重试分支，直到加载成功（loadMermaid 自身失败可恢复）。
  let engine: MermaidEngine
  try {
    engine = await loadMermaid()
  } catch (error) {
    state.engineFails += 1
    if (state.engineFails === 1) {
      console.warn('[dsh-memory-evolve] mermaid engine load failed, will retry:', error)
    }
    return
  }
  // 尝试序列：原样源码 → 高置信度自动修正版（autoFixMermaid，仅当修正
  // 有意义才追加；修正版只用于渲染，代码块里的源码保持原文可复制）。
  const attempts: Array<{ text: string }> = [{ text: source }]
  const fixed = autoFixMermaid(source)
  if (fixed !== null) attempts.push({ text: fixed })
  let lastError: unknown
  try {
    for (const attempt of attempts) {
      // 渲染 id（mermaid.render 要求唯一）：mermaid 失败时默认会在 body 末尾
      // 残留 #d{id} 错误块，id 同时用于失败路径的清理（suppressErrorRendering
      // 已让引擎自行清理，这里是双保险）。
      const id = `me-${++renderSeq}`
      try {
        const pre = block.querySelector('pre')
        // 等待引擎期间块被 React 换掉（重渲染/移除）→ 放弃本轮，走下方重试。
        if (pre === null || !pre.isConnected) return
        const { svg } = await engine.render(id, attempt.text)
        const preAfter = block.querySelector('pre')
        // 渲染期间被 React 替换（Tab 切换 remount 视图等）→ 放弃，走下方重试。
        if (preAfter !== pre) return
        const wrap = document.createElement('div')
        wrap.className = 'me-mermaid-wrap'
        wrap.innerHTML = svg
        pre.replaceWith(wrap)
        state.rendered = true
        state.failCount = 0
        state.engineFails = 0
        block.setAttribute(RENDERED_MARK, '')
        // 成功 = 图真的渲染出来了，清掉可能的失败标记（之前失败过又被还原的块）。
        block.removeAttribute(FAILED_MARK)
        // 渲染成功后立即放下载按钮（复制按钮旁）；此后由 schedule 兜底补插。
        ensureDownloadButton(block)
        return
      } catch (error) {
        lastError = error
        // 双保险清理：防御性删除本轮 id 对应的错误块（#d{id}），保证页面
        // 不残留错误图（2026-08-10 实测：语法错误块在页面下方堆积）。
        document.getElementById(`d${id}`)?.remove()
      }
    }
    // 所有尝试（原样 + 自动修正）都失败 → 图定义确实有问题（典型语法
    // 错误）：计数 2 次后标记永久失败（保留代码块 + 提示行 + console），
    // 此前延迟重试（防一次性抖动）。failCount 按 renderBlock 调用次数计，
    // 不是按尝试次数（原样+修正只算一次失败）。
    state.failCount += 1
    if (state.failCount >= 2) {
      state.rendered = true
      block.setAttribute(RENDERED_MARK, '')
      // 永久失败标记：restore 检测见到它不再重置重试（否则延迟重扫会把它
      // 当成"图被还原"反复重置，每次重试失败 mermaid 又插一个错误块）。
      block.setAttribute(FAILED_MARK, '')
      showErrorHint(block, lastError)
    }
    console.warn(`[dsh-memory-evolve] mermaid render failed (attempt ${state.failCount}):`, lastError)
  } finally {
    state.rendering = false
  }
  // 被 React 打断、引擎失败或临时渲染失败：不会再有后续 mutation 保证重试
  // （Tab 切换 remount 后 React 已稳定）——延迟一小段（等 React 稳定）强制
  // 重新调度；schedule(force=true) 跳过源码短路、重置稳定判定计时器。React
  // 若持续重渲染则重试到稳定为止；引擎失败也在此无限重试（本地端点恢复即
  // 成功）。成功路径已在上面 return，不会走到这里。
  if (!state.rendered && block.isConnected && block.querySelector('pre') !== null) {
    window.setTimeout(() => { schedule(block, true) }, RETRY_DELAY_MS)
  }
}

/**
 * 调度一个代码块：识别 mermaid → 内容稳定判定 → 渲染。
 *
 * 流式输出中每帧都会调用（观察器回调）。短路规则：内容未变且已有待触发
 * 的稳定判定计时器时不动；`force` 用于渲染被打断/临时失败后的重试——跳过
 * 短路、强制重置计时器。
 *
 * @param block - 候选代码块（.md-code-block 或其中的元素）。
 * @param force - 强制重置稳定判定计时器（默认 false）。
 */
function schedule(block: HTMLElement, force = false): void {
  if (!isMermaidBlock(block)) return
  let state = states.get(block)
  if (state === undefined) {
    state = { source: '', rendered: false, rendering: false, failCount: 0, engineFails: 0 }
    states.set(block, state)
  }
  // 捕获为 const：setTimeout 闭包会引用 state，TS 对 let 的收窄在闭包
  // 捕获后会失效（conservative reset），const 捕获不受影响。
  const s = state
  if (s.rendered) {
    // React 重渲染把图还原成代码：标记还在但 wrap 已不在 → 重置并**立即**
    // 走强制路径重渲染（图被还原时内容不会再变，短稳定等待即可，不等 400ms）。
    if (block.querySelector('.me-mermaid-wrap') === null) {
      // 永久失败（语法错误等）不重置：重置会触发强制重渲染 → 再失败 → mermaid
      // 再插一个错误图，延迟重扫下形成无限循环（2026-08-10 实测：页面下方
      // 堆了一串 "Syntax error in text / mermaid version 11.16.0"）。
      if (block.hasAttribute(FAILED_MARK)) return
      s.rendered = false
      s.failCount = 0 // 图被还原 = 环境已重置，清失败计数允许重新尝试。
      block.removeAttribute(RENDERED_MARK)
      schedule(block, true)
      return
    }
    // wrap 还在：补插下载按钮（复制按钮点击等 React 局部重渲染可能清掉
    // 我们插在操作区里的按钮，mutation 驱动下幂等补插，保持按钮常驻）。
    ensureDownloadButton(block)
    return
  }
  const source = block.querySelector('pre')?.textContent ?? ''
  if (!force && source === s.source && s.timer !== undefined) return // 内容未变，等计时器到期
  s.source = source
  window.clearTimeout(s.timer)
  s.timer = window.setTimeout(() => {
    const current = block.querySelector('pre')?.textContent ?? ''
    if (current === s.source) {
      // 两次读取一致 = 流式已稳定 → 渲染（渲染中则由延迟重试接管，防并发）。
      if (!s.rendering) void renderBlock(block, s.source, s)
    } else {
      schedule(block) // 仍在变化（流式继续）→ 重新计时。
    }
  }, force ? FORCE_STABLE_MS : STABLE_MS)
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
  /** 延迟重扫定时器（消息异步挂载/增量渲染的兜底窗口）。 */
  let rescanTimer: number | undefined

  /** 观察器回调：新增节点（消息渲染/历史回放/React 重挂载）→ 调度处理。 */
  const onMutations = (mutations: MutationRecord[]): void => {
    let addedCount = 0
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          addedCount += 1
          if (!(node instanceof HTMLElement)) continue
          // 向上找：节点本身是块，或挂在某代码块内（新增的子元素）。
          const self = node.classList.contains('md-code-block')
            ? node
            : node.closest<HTMLElement>('.md-code-block')
          if (self instanceof HTMLElement) schedule(self)
          // 向下扫（Grok 审阅意见 P0-①）：React 一次插入整个消息列表容器
          // （remount/历史回放）时，容器内的 .md-code-block 不会出现在
          // addedNodes 里——只做向上 closest 会整体漏检，全靠补扫兜底。
          // 对容器向下 querySelectorAll 一次即覆盖全部块（块内无嵌套块，
          // 若 self 已命中则无需再向下扫）。
          if (self === null) {
            for (const inner of node.querySelectorAll<HTMLElement>('.md-code-block')) schedule(inner)
          }
        }
      } else {
        // characterData / attributes：mutation.target 可能是 **Text 节点**
        // （流式文本更新、回放增量填充）或元素——Text 没有 closest，
        // 必须经 parentElement 上溯（2026-08-10 实测坑：只判 HTMLElement
        // 会让本分支永不触发，刷新后历史消息若以增量方式挂载就漏渲染）。
        const element = mutation.target instanceof HTMLElement
          ? mutation.target
          : mutation.target.parentElement
        const block = element?.closest<HTMLElement>('.md-code-block')
        // block 可能为 undefined（element 不存在）或 null（未命中）→ 统一判空。
        if (block instanceof HTMLElement) schedule(block)
      }
    }
    // 视图整体重挂载（顶部 Tab 切换 remount、会话切换）会一次性插入大量
    // 节点——渲染可能恰在 React 重建窗口内被打断（见 renderBlock 重试），
    // 批量插入时额外触发一次延迟补扫序列兜底。
    if (addedCount > 40) scheduleRescans()
  }

  /**
   * 延迟全量重扫：刷新后历史消息的挂载时序不确定（可能晚于 setEnabled 时
   * 的 scan，且增量渲染走 characterData 更新、不保证 childList 新增节点），
   * 在开启后的三个时间点各补扫一次兜底。schedule 内部有源码比对短路 +
   * 已渲染标记，重复扫描成本极低；渲染失败（引擎加载失败等）的块也会因
   * 「rendered 但 wrap 不在」在重扫时被重置重试。
   */
  const scheduleRescans = (): void => {
    window.clearTimeout(rescanTimer)
    const delays = [300, 1000, 2500, 6000]
    const run = (index: number): void => {
      if (index >= delays.length) return
      rescanTimer = window.setTimeout(() => {
        if (disposed || observer === undefined) return
        for (const block of document.querySelectorAll<HTMLElement>('.md-code-block')) schedule(block)
        run(index + 1)
      }, delays[index])
    }
    run(0)
  }

  /**
   * 开关同步：true=启动观察 + 全量扫描现有消息（历史回放）+ 延迟补扫；
   * false=停止观察（已渲染图保留，不还原，刷新后随开关状态恢复）。
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
      scheduleRescans()
    } else if (!enabled && observer !== undefined) {
      observer.disconnect()
      observer = undefined
      window.clearTimeout(rescanTimer)
    }
  }

  return {
    setEnabled,
    dispose() {
      disposed = true
      observer?.disconnect()
      observer = undefined
      window.clearTimeout(rescanTimer)
    },
  }
}
