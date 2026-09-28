/**
 * DSH ui-primitives 图标「跨版本」解析层（2026-09-28，DSH 0.2.0 适配）。
 *
 * 为什么需要它：DSH 0.2.0-rc.1 把 ui-primitives 的图标导出从**尺寸后缀**改成了
 * **字重后缀**：
 *
 *   旧（≤ 0.1.5-rc.2）：IconWarningOutline16 / IconChevronDownOutline14 /
 *                        IconFolderClose16 / IconLoadingOutline16 …
 *   新（0.2.0-rc.1+）：  IconWarningOutlineRegular / IconChevronDownOutlineRegular /
 *                        IconFolderCloseRegular / IconLoadingOutlineRegular
 *                        （另有 …Medium = 1.3px 描边、…Artwork = 单图元）
 *
 * 旧名在新宿主上**不是别名而是彻底删除**（`git grep IconWarningOutline16` 在
 * 0.2.0-rc.1 里零命中）。若直接按旧名取值会拿到 undefined，React 渲染
 * `undefined` 组件立刻抛 "Element type is invalid"，整块 UI（技能管理 / 画板）
 * 直接崩掉——比"图标少一个"严重得多。
 *
 * 因此这里统一按「新名 → 旧名 → Medium → 空实现」四档解析：
 *   - 新宿主取 …Regular（1px 描边，与旧 …16 同为 16×16 viewBox、默认 size=16，
 *     视觉一致）；
 *   - 老宿主回退到 …16 / …14；
 *   - 万一将来再改名，退化为 Medium；
 *   - 全都没有时渲染 null（宁可少个图标，也绝不让整块 UI 崩）。
 *
 * 本模块是**唯一**允许直接触碰 ui-primitives 图标导出的地方：其它 TSX 一律从这里
 * import，避免升级宿主时再次散落一地旧名。
 */
import type { ComponentType } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

/** 图标组件 props（与 ui-primitives 的 IconProps 同形，只用到这两个字段）。 */
export interface IconProps {
  size?: number
  className?: string
}

/** 图标组件类型。 */
export type IconComponent = ComponentType<IconProps>

/** 兜底图标：所有候选名都缺失时渲染 null，保证 React 不会因 undefined 组件抛错。 */
const MissingIcon: IconComponent = () => null

/**
 * 按「新名 → 旧名 → Medium 变体 → null」解析一个图标组件。
 * @param modern - 0.2.0+ 的导出名（…Regular）。
 * @param legacy - ≤0.1.5 的导出名（…16 / …14）。
 * @returns 可渲染的图标组件（永不 undefined）。
 */
export function resolveIcon(modern: string, legacy: string): IconComponent {
  const table = primitives as unknown as Record<string, IconComponent | undefined>
  return table[modern] ?? table[legacy] ?? table[modern.replace(/Regular$/u, 'Medium')] ?? MissingIcon
}

// —— 本插件用到的图标（名称对齐 0.2.0 的 Regular 口径）——
/** 搜索（放大镜）。 */
export const IconSearchOutline = resolveIcon('IconSearchOutlineRegular', 'IconSearchOutline16')
/** 刷新。 */
export const IconRefreshOutline = resolveIcon('IconRefreshOutlineRegular', 'IconRefreshOutline16')
/** 文件夹（打开态）。 */
export const IconFolderOpen = resolveIcon('IconFolderOpenRegular', 'IconFolderOpen16')
/** 文件夹（关闭态）。 */
export const IconFolderClose = resolveIcon('IconFolderCloseRegular', 'IconFolderClose16')
/** 向下折叠箭头。 */
export const IconChevronDown = resolveIcon('IconChevronDownOutlineRegular', 'IconChevronDownOutline14')
/** 向右展开箭头。 */
export const IconChevronRight = resolveIcon('IconChevronRightOutlineRegular', 'IconChevronRightOutline14')
/** 关闭 / 取消。 */
export const IconCloseOutline = resolveIcon('IconCloseOutlineRegular', 'IconCloseOutline16')
/** 编辑（铅笔）。 */
export const IconEditOutline = resolveIcon('IconEditOutlineRegular', 'IconEditOutline16')
/** 勾选 / 已保存。 */
export const IconCheckOutline = resolveIcon('IconCheckOutlineRegular', 'IconCheckOutline16')
/** 加载中（配合 .sb-spin 自转）。 */
export const IconLoadingOutline = resolveIcon('IconLoadingOutlineRegular', 'IconLoadingOutline16')
/** 警告。 */
export const IconWarningOutline = resolveIcon('IconWarningOutlineRegular', 'IconWarningOutline16')
/** 数据 / 资源。 */
export const IconDataOutline = resolveIcon('IconDataOutlineRegular', 'IconDataOutline16')
/** 新增（加号）。 */
export const IconPlusOutline = resolveIcon('IconPlusOutlineRegular', 'IconPlusOutline16')
