# Changelog

All version changes for this repository, in reverse chronological order.

> [中文](CHANGELOG.md)

## 2026-09-26

### Added

- **Full Jev skill-approval pipeline (Phase D)**: with "auto-harvest skills" and "Jev skill approval" both on, skills produced by review no longer sit in the pending queue by default. Jev rules on them with the same two-axis thresholds used by the KEY labeling path (generalization >= 0.5 and skill_shape >= 0.6): **approved** installs straight into the live skill directory; **rejected** is kept staged as evidence, with manual override-install or confirm-delete; **no verdict / over budget / sensitive / error** degrades to the human queue (fail-open does not mean unconditional passthrough). Same name + same content is idempotent (no extra Jev budget, no new operation id); same name + different content is refused and the evidence is kept.
- **New "Skill approval chain" block in the "Audit log" tab**: groups the whole chain by operation id (create -> Jev verdict -> installed / rejected / awaiting human), preferring the latest DECISIVE verdict regardless of log order. Shows scores, thresholds, latency, model and reason; the skill body can be expanded, override-installed, or deleted. New endpoints: `GET /api/staged-skills`, `POST /api/staged-skills/approve`, `POST /api/staged-skills/reject` (the last two write `skill-manual-override` records).
- **Cross-validation of the config**: `skillJevApproval` defaults to `false` and can only be turned on when `skillReviewEnabled` is also on. Enforced twice: statically in `resolveConfig` and before saving in `updateRuntime` (raises before `saveState`).

### Fixed

- **Create-branch condition was fail-dangerous**: `... && gate` previously fell through to direct creation when the injected gate was null (it should degrade to pending). The branch now keys off the switch only; a null gate goes through `jevApproveCreate` into the pending path, and the logging hook receives null (null-guarded internally).

### Tests

- Added/extended: `tests/jev-gate.test.js` (20), `tests/skills.test.js` (20, covering the three-way Jev branch plus idempotency and same-name-different-content), `tests/api.test.js` (25, covering the three staged-skills endpoints and the sameOriginGuard), `tests/plugin.test.js` (32, covering defaults and the illegal combination being rejected), `tests/client-config-save.test.js` (PANEL_KEYS gains `skillJevApproval` so any new panel control must reach saveConfig). The frontend is built from the TS source with esbuild, and the save-key sets of the bundle and the source are asserted identical.

