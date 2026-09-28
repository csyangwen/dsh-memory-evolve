# 更新日志（Changelog）

本仓库所有版本变更记录，按日期倒序排列。

> [English](CHANGELOG.en.md)

## 2026-09-26

### 新增

- **Jev 技能审批全链路上线（Phase D）**：开启「技能自动沉淀」+ 「Jev 技能审批」后，审查产出的技能不再默认进待确认队列，而是由 Jev 按双轴阈值（泛化 ≥ 0.5 且 技能形态 ≥ 0.6，与 KEY 标注链路共用同一套配置）裁决：**通过** 直接落库正式技能目录；**拒绝** 保留在暂存区作证据，可人工覆盖落库或确认删除；**无法裁决 / 超预算 / 敏感内容 / 异常** 降级为待人工（fail-open 不等于无条件放行）。同名同内容幂等不重复花预算、不生新 operationId；同名异内容拒绝并保留证据。
- **「审计」子页新增「技能审批链路」区块**：按操作 ID 聚合展示创建 → Jev 裁决 → 落库/拒绝/待人工整条链路（以 DECISIVE 类型丘优选最新裁决，与日志顺序无关），幕展分值、阈值、耗时、模型与原因，可展开技能正文、人工覆盖落库、确认删除。服务端新增 `GET /api/staged-skills`、`POST /api/staged-skills/approve`、`POST /api/staged-skills/reject`（后两个写 `skill-manual-override` 记录）。
- **配置交叉校验**：`skillJevApproval` 默认 `false`；仅允许在 `skillReviewEnabled` 同时为开时开启，静态校验（resolveConfig）与保存前校验（updateRuntime，在 saveState 之前抛错）双重拦截。

### 修复

- **create 分支条件导致 fail-dangerous**：原先 `... && gate` 在 gate 为 null 时会落到直接创建（应走 pending 降级）；改为只看开关，gate 为 null 时进入 `jevApproveCreate` 走 pending 降级，日志 hook 传 null（内部已做空值保护）。

### 测试

- 新增/补充：`tests/jev-gate.test.js`（20）、`tests/skills.test.js`（20，含 Jev 审批三叉分支 + 干等同名异内容）、`tests/api.test.js`（25，含 staged-skills 三个端点 + sameOriginGuard）、`tests/plugin.test.js`（32，含默认值与非法组合拒绝）、`tests/client-config-save.test.js`（PANEL_KEYS 补 `skillJevApproval`，守住面板新增控件必须进 saveConfig）。前端从 TS 源码构建（esbuild），产物与源码的保存键集合完全一致。

