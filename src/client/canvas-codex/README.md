# 无限画板前端一期（Codex 实现）

本目录是独立、纯前端的 `conversation.view` Tab 实现。画板使用 CSS
`translate3d + scale`、Pointer Events、视口矩形虚拟化与缩放 LOD，不依赖
第三方画布库；节点、布局、视角写入
`localStorage['memory-evolve.canvas.v1']`，不调用任何宿主 API。

## 接入

```ts
import { registerCanvasTab } from './canvas-codex/index.tsx'

const disposeCanvasTab = registerCanvasTab(ctx, { t })
ctx.effect(() => disposeCanvasTab, 'memory-evolve: canvas tab')
```

签名：

```ts
registerCanvasTab(
  ctx: { slots: SlotRegistry },
  opts: { t: Translate },
): () => void
```

函数内部注册 `conversation.view`：`id: 'canvas-hub'`、`order: 80`、
`label: '画板'`，同时注入/回收 `cc-` 前缀样式。

## 一期能力

- 无限平移、中心缩放、卡片拖拽、视口虚拟化、低缩放 LOD、图片懒加载。
- 文件夹、Markdown、纯文本、图片、音视频、普通文件六类卡片。
- 会话/项目/全局归属徽标与单板三视角筛选。
- 路径、便签、模拟搜索三种上板入口；画板搜索过滤、定位和闪烁。
- 画板内模拟预览、复制 ID/标题/路径/引用串、从板上移除。
- AI 中央固定区模拟投放、AI 标记、高亮与跳到最近写入。
- 节点内容、布局、视口、视角的 localStorage 持久化。

## 已知限制

- 不读取或校验真实路径，不调用默认应用；相关按钮仅显示后端待接入提示。
- 图片和音视频是内置 SVG/色块/波形占位，不加载真实文件。
- 当前项目以会话列表快照中的 `cwd` 派生；没有 `cwd` 时使用前端占位项目。
- localStorage 是单浏览器单板模拟，没有跨窗口乐观锁或多人同步。
- 一期不含后端、`de_canvas`、流转、分组嵌套、全屏和 terminal/web 节点。
