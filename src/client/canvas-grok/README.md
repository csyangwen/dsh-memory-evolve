# 无限画板 · 前端一期（canvas-grok）

纯前端实现，数据走 `localStorage`（`memory-evolve.canvas.v1`）。主会话负责把本目录接到 `src/client/index.ts` 并构建 `lib/client.js`。

## 实现了什么

- 无限画布：拖空白 / 空格+拖 平移；滚轮以指针为中心缩放；卡片标题栏拖拽摆放
- 性能底座：世界层 `translate3d + scale` 合成、视口虚拟化、scale&lt;0.36 LOD 降级为图标、图片用占位渐变（无真实解码）
- 6 类卡片：文件夹 / Markdown / 纯文本 / 图片 / 音视频 / 文件
- 三层归属 + 视角筛选（会话 / 项目 / 全局）+ 卡片归属徽标
- 三种上板：路径（标「未验证」）/ 便签 / 模拟搜索清单
- 画板内搜索：按标题/类型/路径过滤，命中闪烁并跳转
- 操作：预览（轻量模拟 / 重量占位）、复制 ID·标题·路径·引用串 `[canvas:id] 标题`、移除确认
- AI 投放模拟：中央虚线投放区 +「AI 放置」标记 + 跳到最近 AI 写入
- 首次打开预置 4 张示例卡（全局 / 项目 / 当前会话 / 其他会话），用于演示筛选

## 接入

```ts
import { registerCanvasTab } from './canvas-grok/index.ts'

// 在 apply(ctx) 里：
const disposeCanvas = registerCanvasTab(ctx, { t })
// 插件卸载时调用 disposeCanvas()
```

签名：

```ts
function registerCanvasTab(
  ctx: CanvasTabHost,          // 只需 ctx.slots.inject / register
  opts: { t: Translate },
): () => void                  // disposer
```

槽位：`conversation.view` / `id: canvas-hub` / `order: 80` / `label: 画板`。

## 已知限制

- 不读真实本地文件，路径一律「未验证」；预览是占位色块/正文
- 模拟搜索是内置 8 条清单，不是 `memory_evolve_search_local_files`
- 不做 de_canvas、流转、分组嵌套、全屏、文件夹内嵌浏览、terminal/web 节点
- 当前会话 / 项目身份写死为演示值，未接 `ConvViewProps` / sessions
- Tab 尚未挂进 `src/client/index.ts`（按规格由主会话接入）

## 文件清单

| 文件 | 职责 |
|---|---|
| `index.ts` | `registerCanvasTab` + 样式注入 |
| `CanvasView.tsx` | Tab 壳：工具条 / 状态 / 持久化 |
| `CanvasBoard.tsx` | 画布引擎：平移缩放 / 虚拟化 |
| `CanvasCard.tsx` | 单卡 + LOD |
| `CanvasDialogs.tsx` | 上板 / 预览 / 移除浮层 |
| `types.ts` | 数据模型 |
| `constants.ts` | 尺寸、LOD、种子、模拟清单 |
| `helpers.ts` | 视角可见性、引用串、几何 |
| `store.ts` | localStorage 读写 |
| `styles.css` | `cg-` 前缀样式 |
