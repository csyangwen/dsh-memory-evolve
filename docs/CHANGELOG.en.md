# Changelog

All version changes for this repository, in reverse chronological order.

> [中文](CHANGELOG.md)

---

## 2026-08-14

### Fixed

- **"Current version" showed an old version after updating**: after a successful update and restart, the version page displayed the old version while the status said "already latest". Root cause: the update transaction fetches with `--no-tags` (the new tag lives only in private refs, never in local `refs/tags`), while the local version label relied on `git describe`, which could only find the nearest reachable ancestor tag. Now the label is derived from commit SHAs: when HEAD exactly matches any published commit, the published tag of that commit is used (the latest tag when the dev branch already contains the release); `git describe` results are no longer trusted; the transaction checkpoint persists the new version and "latest" status together.
- **Update red dot could persist after a failed post-checkout recheck**: a failed remote recheck after a successful checkout no longer reverts the status to `outdated` (the local version relationship is already verified by SHA; a recheck failure only records the error).
- **Stale state after manual checkout / dev-branch restore within cache TTL**: the 24h cache-hit path now validates the local HEAD; a changed HEAD immediately invalidates the cache and triggers a recheck, eliminating up-to-24h stale status or a bogus "restart required" banner.
- **Self-healing of stale cached version labels**: devices already carrying an incorrect cached version show the correct version as soon as the version page is opened after upgrade, without waiting for the next automatic recheck.

---

## 2026-08-13

### Added

- **Infinite Canvas**: a material workbench that gathers scattered files / text / images / audio-video onto an infinite canvas. Local path reference (files stay in place), single board + view filtering (session / project / global + ownership badges), infinite pan/zoom (LOD / virtualization / GPU compositing performance base), three board-entry points (path / note / real local search), direct in-canvas preview / copy / reference, free card drag + bottom-right resize, AI both ways (`de_canvas` tool: query/read by id, place notes in the board's center area, not injected into context), whole-board rev optimistic lock to prevent multi-session overwrites. Standalone `canvasEnabled` sub-module switch, storage `<memoryDir>/canvas/boards.json`.
- **Web in-site notification**: `de_notify` / `de_channel_send` add a `web` channel — notifications land directly on the web page's top-right bell, supporting unread badge, popup list, full-text view, attachment thumbnails, one-click jump to the source session.
- **COI task list pagination**: GUI task sub-tab paginated browsing, no longer rendering everything at once when there are many task records.

### Changed

- **Scratch module removed**: in-canvas notes (markdown / plain-text nodes, content stored in the canvas) already cover its capability; removed the "Scratch" tab, `scratchEnabled` switch, and `/api/scratch` route; existing scratch.md content is kept in the memory directory, not auto-migrated.

### Improved

- **Notification mechanism rework — snapshot no longer repeatedly re-injected by other modules**: COI tasks (dispatched / completed), workspace bulletin board (parallel start/end / member changes), and session broadcast (new message / room activity) all moved out of the context snapshot to **independent message delivery** (not interrupting the in-progress turn); the snapshot keeps only stable content like identity, memory, and discipline. Module changes no longer re-inject the whole snapshot, keeping context cleaner.
- **COI completion notification only gives status and log path**: task completion/start messages no longer carry a truncated log excerpt (with long logs the excerpt lands mid-body and shows no conclusion), directly giving the full log file path for the AI to read via `read`; `de_coi_status` only checks status / fetches path.
- **Workspace bulletin board debounce**: only notifies on real state changes (parallel start/end, member changes, note changes), no longer refreshing repeatedly during normal session operation.
- **Memory sync becomes pure GUI operation**: removed the `/memory_sync` command and snapshot sync-status line — sync is fully triggered by you manually in the "Memory Sync" tab, the AI no longer participates in sync execution.
- **Version detection triggers on startup**: after plugin startup a background check runs once for a new version; the settings-tab red dot no longer depends on manually opening the version page.
- **Notification bell full polish**: SVG icon, position avoidance, mobile adaptation; popup optimization (title color / session name display / long-text large popup); list multi-line layout + read button + title jump; email-style dedup, blank-line collapse, drag-snap, unified color scheme.
- **DSH 0812 internal-beta compatibility**: adapted to core service renames (workspace→workspaceRegistry, httpServer→webServer), external behavior unchanged.

### Fixed

- **Memory archive safety**: archiving changed to "write to the archive file first, delete the main track only on success" — if archive write fails, the main memory stays intact, no more data loss.
- **Pending suggestion index alignment**: after sorting the suggestion queue by heat, adopt/reject still operates by original index, no longer mis-operating other entries (wrong adopt / wrong reject).
- **Memory sync reliability**: conflict resolution safely retryable (git failure no longer leaves half-complete state, no duplicate entry writes); stricter remote identity check (reject merge when the remote branch exists but the identity file is missing/corrupt).
- **Session switching no longer cross-contaminates**: the Memory tab's file list and tab selection are isolated per session; switching sessions no longer shows the previous session's content.
- **Todo overdue judgment**: uses local date (East-8 evening "today" deadlines no longer mis-marked overdue).
- **Shared memory repo address echo**: no longer mis-displays the main code repo address (avoiding changing the shared repo config to the code repo).
- **Model settings entry**: after turning off "thinking support", the editor can still be reopened (no longer a dead end).
- **Mobile toolbar**: the plus / model buttons no longer permanently disappear because enhancement isn't ready.
- **COI task recovery**: no leftover "session busy" fake lock after restart; long-task output scan buffer capped, no more unbounded memory growth.
- **Session review**: after the master switch is off, the background per-second polling stops (auto-resumes on re-enable); resetting the reviewer no longer writes old review results into the newly cleared session.
- **Tool description aligned with actual behavior**: workspace lock retention description fixed (30s TTL), prompt and broadcast parameter descriptions fixed (duplicate keys no longer overwrite semantics).
- **Notification detail truncation**: opening a notification always fetches full text, fixing 200~8KB mid-long notifications showing incomplete.
- **Session review switch system**: `advisorEnabled` becomes the module master switch (turning it off in the settings tab disables the whole thing); fixed the session-level switch being lost after page refresh; each session defaults off (opt-in), must be manually enabled in the floating panel after the master switch is on.

---

## 2026-08-12

### Added

- **Session review (Advisor) module**: attach an independent reviewer to each session, observing user input and replies in real time, giving feedback at info / nit / concern / blocker four levels; supports five-level constraints (system prompt / global / project / session / review session); management panel with Constraints / Live / Records / Settings four tabs, can Q&A by instruction, view reviewer context size, one-click restore default prompt.
- **Version detection & update**: auto-detect remote new versions (git tag), settings tab adds a version page (current version / latest version / update button + red dot reminder).
- **Task completion auto-wake**: `de_coi_dispatch` adds a `wakeOnComplete` parameter — after task completion, auto-wake the dispatching session to deliver the completion summary, no manual trigger needed.

### Improved

- **Completion wake no count limit**: user-requested wakes take effect every time, same semantics as `de_session wake`.
- **COI output traceable**: `de_coi_status` / `de_coi_wait` output gives the full log file path at the start, no self-search needed.

### Fixed

- **Prompt injection snapshot no longer intercepted by the host renderer**: when the injected body contains variables like `{{date}}`/`{{time}}`, the snapshot segment expands them uniformly on the render side; any leftover `{{...}}` in the body (unknown variables, malformed references) is also de-templated — the host system-prompt renderer treated segment text `{{...}}` as template variables and threw "unknown prompt variable" on unregistered ones, failing the whole turn's injection (issue #6), now fully covered; leftover or manually edited injection data from old versions is equally safe.
- **Session review four details**: real-time stream clearing, floating window hidden by default, tool-call in-order display, Chinese guide copy completed.

---

## 2026-08-11

### Added

- **Memory sync (cross-device project memory sharing)**: one-click sync project memory to remote, multiple computers share the same memory; three-level enable switch (module / project / track), per-project opt-in off by default; entry identity mechanism ensures dual-device merge alignment; GUI "Memory Sync" tab (status card / init / sync / conflict resolved one by one).
- **Shared memory repo**: one private repo holds all projects' memory, each project auto-uses a dedicated branch, no interference; old repos auto-recognized, zero migration.
- **Unified single mode**: memory remote model merge — default reuse the main code repo, or specify a shared memory repo, one dedicated branch per project; project todos (TODOS.md) merged into project memory-track sync.
- **Global memory track**: global memory / user profile / daily log / todos four tracks sync across devices (shared memory repo only), one independent branch per track.
- **Five image-link capabilities**: input-box image direct-send to IM channels (`sessionImage` / `attachmentId` sources); COI dispatch with images (codex / kimi / grok / hermes); `de_session` supports Agent presets; `de_models` shows model image-input capability; session broadcast image attachments (inbox thumbnails + delayed-retention forwarding window).

### Improved

- **Memory sync tab full re-layout**: three sub-tabs (Project / Global / Memory remote), unified push/pull buttons, device-level enable switch, status copy "uncommitted" → "unpushed" + ahead count.
- **DSH 260810 snapshot compatibility**: `dsh.client` config migration, Agent preset mounting, new session tool surface complete.

### Fixed

- **Windows line-ending incident**: Windows Git autocrlf converted memory files to CRLF causing parse failure — added `.gitattributes` forcing LF + lossless self-heal of existing files, dual-device sync restored.
- **Global track data security hardening**: fixed credential leakage, cross-track conflict data risks, illegal path upload, fake-dirty repeated commits; global push blocked by conflict can now be resolved one-by-one directly in the UI.
- **spawn / wake tool surface missing**: fixed new sessions and resumed sessions missing bash / read / write / edit under DSH 260810.

---

## 2026-08-10

### Added

- **memory tool multi-track batch write**: one call writes daily log + project log simultaneously, consolidated into one tool round-trip at wrap-up.
- **Emotion feedback recording**: log entries can carry user emotion feedback (positive / negative + exact quote), accumulated to analyze satisfaction by task category.

### Improved

- **Large file protection**: project / daily no-parameter queries default to returning the most recent 50 entries with metadata, Memory tab paginated display, eliminating long-file truncation.

### Fixed

- **Legacy plugin migration guidance**: dsh-skills-manager residue makes the whole web page unusable — added prominent migration docs and disabled-list auto-migration.

---

## 2026-08-09

### Added

- **Workspace conflict coordination**: declare file / service occupancy during parallel multi-session work (`de_ws_declare` / `de_ws_status` / `de_ws_release`), pre-write conflict detection, targeted notification to the occupant, activity-aware snapshot segment.
- **Session bookmarks**: star and name each turn, independent list one-click jump back; create official branch from any completed turn.
- **Local file search content retrieval**: `memory_evolve_search_local_files` supports file-content keyword retrieval (optional parameter, default behavior unchanged); added four modes (filename+content / filename-only / content-only / off).
- **DSH UI settings module**: left session list shows only active sessions by default; conversation area widened (about 95%); message bubbles widened (about 80%).
- **Immediate injection**: prompts can be injected "effective immediately this turn" (snapshot change + interjection), injected only once, unaffected by count / interval.
- **Session orchestration module (de_session)**: spawn programmatically creates standard sessions, wake wakes, status / list query; `me` queries self info; `rename` renames session / alias; new sessions auto-attach to workspace groups.
- **Session broadcast inbox**: unread / all / read filtering + search + pagination; room member online status persisted (not lost on restart).

### Fixed

- **Content retrieval missed files**: fixed target files unscannable when the whole disk has tens of thousands of docs.
- **Workspace coordination field iteration**: activity segment repeated injection spam, lock residue after session deletion, displaying full session ID, etc.

---

## 2026-08-08

### Added

- **de_prompts create / modify**: the model can create / modify prompts itself, same validation as the GUI.
- **de_prompts multi-dimension filtering**: filter by name / category / tag / description, clear prompt on which condition didn't match.
- **Prompt description & enable status**: each prompt can have a description and be disabled; de_prompts tool (list / detail / inject) live, AI can pick a suitable prompt to inject into the current session or as a subtask prompt.
- **memory tool archive**: AI can directly archive memory entries (memory / user / key three tracks) and query archive content, reversible.
- **Prompt manager interaction upgrade**: one-click preset injection (inject once / continuously inject / custom); temporary injection (inject without creating a prompt); free input for count / interval.
- **Session broadcast rooms / project groups**: multi-session chat rooms (members across working directories) + project announcement groups (visible by directory); 30-day no-activity auto-cleanup; room / project messages retained 30 days for review.
- **Session broadcast management panel**: message inbox, room management, member online status; kick / dissolve auto-send system notification; dissolve soft-delete traceable.
- **Session alias**: give sessions a friendly name (≤10 chars), snapshot / panel / message prefer alias display.
- **Session search (de_session_search)**: search local Codex historical sessions (by project / keyword, read-only scan, zero resident state).
- **Session page tab system rework**: Memory / Skills / Todos / Memory Evolve Settings four independent tabs, each with bilingual guide.
- **Session broadcast standalone module**: split out from COI scheduling with an independent switch and storage directory, no mutual influence.

### Fixed

- **Injection copy disambiguation**: injection result displayed by actual behavior (inject once / N times total / continuous), no more misreading.
- **Ghost categories manageable**: leftover old categories in the category tree can be renamed / deleted normally (prompts auto-migrated).

---

## 2026-08-07

### Added

- **Prompt manager**: prompt library CRUD + category tree + tags + search + usage stats; injection executor (count × interval, supports infinite / once / finite); 13 built-in complete paradigms from real GitHub prompt libraries.
- **COI scheduling module**: unified scheduling of kimi / codex / grok / hermes external CLIs — non-blocking background tasks, progress visualization, session layered management & recovery, cross-COI relay, task templates, usage stats, crash recovery; supports custom CLI adapters.
- **Scratch note**: standalone session-page tab, persistent Markdown note (survives restart).
- **Local file search**: `memory_evolve_search_local_files` searches local docs by filename (docs only by default, all types require explicit enable).
- **Daily todo past query**: `dtodo list` supports past / expired historical query; todo sub-tab adds a "Past" page (including expired leftovers).
- **Memory entry editing**: five-track memory pretty-view direct edit & save (program markers and separators protected).
- **Suggestion queue categorization**: memory / todo / skill three independent pending tabs; can change target track on adopt (among the three memory tracks).

### Improved

- **DSH 08-06 profiles architecture adaptation**: client registration uses `ctx.slots.inject`, snapshot prompt sections clearer.

---

## 2026-08-06

### Added

- **Skill management merged in**: standalone plugin dsh-skill-browser fully merged — skill browse / search / filter / one-click disable-enable / custom directories; old plugin's disabled list auto-migrated.
- **Four-track todos**: Life / Work / Project / Daily; four-quadrant + due + status tags; `dtodo` tool (add / list / done / update / remove) and default smart view.
- **key track confirmation**: model writing project key memory enters the pending-confirmation queue first, written and injected only after user adoption.
- **Project key memory archive**: key entries archive to KEY-archive.md, reversible (movable back to main memory).
- **git branch awareness**: memory injected and queried by branch, logs auto-tagged with source branch.

---

## 2026-08-05

### Added

- **Initial release**: layered memory and self-evolution plugin — global facts / user profile / project memory / daily log four-track memory.
- **Memory review mechanism**: background review + suggestion queue (adopt / archive / reject, batch supported).
- **Web UI**: settings panel "Memory Management", session-page Memory tab (inline file view).
- **Skill self-evolution**: `skill_manage` tool (strict creation threshold + pending-confirmation queue).
