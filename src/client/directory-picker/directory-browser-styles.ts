/**
 * 自动生成（scripts/vendor-directory-browser.mjs）：官方 DirectoryBrowser 的
 * css module 类名映射（dp- 前缀防全局污染）+ 本地 cx 实现（替代 clsx）。
 * 不要手工编辑；重跑 vendor 脚本重新生成。
 */

/** css module 类名 → 全局类名映射（与 directory-browser.css 中的 dp- 前缀一致）。 */
export const css: Record<string, string> = {
  "dialog": "dp-dialog",
  "editorScope": "dp-editorScope",
  "header": "dp-header",
  "title": "dp-title",
  "crumbBar": "dp-crumbBar",
  "crumbEditZone": "dp-crumbEditZone",
  "pathInput": "dp-pathInput",
  "millerRow": "dp-millerRow",
  "crumbTrail": "dp-crumbTrail",
  "crumbSeat": "dp-crumbSeat",
  "crumb": "dp-crumb",
  "crumbChevron": "dp-crumbChevron",
  "crumbEditGlyph": "dp-crumbEditGlyph",
  "column": "dp-column",
  "content": "dp-content",
  "loadingFloat": "dp-loadingFloat",
  "divider": "dp-divider",
  "rowSeat": "dp-rowSeat",
  "row": "dp-row",
  "rowSelected": "dp-rowSelected",
  "rowIcon": "dp-rowIcon",
  "rowIconSelected": "dp-rowIconSelected",
  "rowName": "dp-rowName",
  "rowChevron": "dp-rowChevron",
  "status": "dp-status",
  "error": "dp-error",
  "footerBar": "dp-footerBar",
  "showHiddenToggle": "dp-showHiddenToggle",
  "showHiddenToggleActive": "dp-showHiddenToggleActive",
  "footerGap": "dp-footerGap",
  "footerAction": "dp-footerAction",
  "createDialog": "dp-createDialog",
  "createBody": "dp-createBody",
  "createTitle": "dp-createTitle",
  "createIn": "dp-createIn",
  "createInput": "dp-createInput",
  "createActions": "dp-createActions"
}

/** 本地 cx：过滤 falsy 后空格拼接（clsx 最小子集，bundle 禁第三方值导入）。 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
