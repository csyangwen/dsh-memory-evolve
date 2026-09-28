# Changelog

All version changes for this repository, in reverse chronological order.

> [中文](CHANGELOG.md)

## 2026-09-28

### Fixed

- **Under session format v4 a plugin-injected message fails the recipient's whole turn (issue #68, blocking)**: since DSH 0.1.7-rc.2 session persistence uses format v4, where every message's `source.kind` must be self-reported by its producer (canonical form `plugin:<package>`, validated in the message-sources module of `@deepseek-ai/dsh-session-format-v3-to-v4` and by the same rule on the persistence side); the v3-era spelling — a bare `kind: 'plugin'` plus a sibling `plugin` field — is **explicitly rejected**: `format v4 message requires a producer-owned source kind`. Four injection sites still used the old spelling: session broadcast / COI notification (`deliver()` in `lib/coi/index.js`), COI task status notification (`#deliver()` in `lib/coi/scheduler.js`), the write-conflict warning (`userMessage()` in `lib/coi/ws-coord.js`) and the workspace-activity notice board (same file). The error surfaces when the **recipient session adopts the event**, so the symptom is "the turn in which the injection lands fails outright" rather than the injection call itself failing; and because the notice board needs two or more active sessions while write conflicts and COI notifications are event-driven, it presents as "restart fixes it, then it comes back" — restarting only clears the notice-board baseline and throttling state, it is not a fix. Fix: a new `lib/coi/source.js` exports the single constant `PLUGIN_SOURCE_KIND = 'plugin:dsh-memory-evolve'` (matching the host's `producerKind()` mapping for unknown producers), and all four sites use it with the `plugin` field dropped. No reader-side change is needed: `advisor` uses its own `kind: 'advisor'`, and `lastTurnWasMessage()` in `review.js` tests `undefined || 'user'`, so the new kind keeps its meaning.
- **Entries carrying `[summary:…]` could not be deleted, edited, or archived from the memory tab, and the archive page could neither promote them back nor delete them (issue #59)**: the root cause is that **the display layer stripped program metadata while the matching layer did not follow** — `buildMemoryFiles()` strips `[summary:…]` (progressive disclosure, introduced 2026-08-17) and `[id:…]` (introduced 2026-08-11) before handing rows to the browser, and `MemoryTabView` sends that display text back as `raw`; meanwhile `findExactIndex()` was immune only to `[id:…]`, `peekExact()` compared with a strict `includes()`, the archive-side `ArchiveStore.removeExact()` compared with a strict `entries.indexOf()` (**not even immune to `[id:…]`** — every archived entry that received an identity once Git sync was enabled was undeletable), and the `includes` substring in `promoteArchived()` was cut in half by the `[summary:…]` sitting in the middle. This is the second occurrence of the same class of bug (the first was `[id:…]`), and the conclusion is recorded in the code: **every time the display layer strips a new kind of metadata, the matching layer must be extended with it**. Fix: `lib/store.js` gains and exports `normalizeForMatch(entry) = stripEntrySummary(stripEntryId(entry))`; `findExactIndex()` uses it and gains a `{ first }` option (the main track still refuses ambiguity and rejects conservatively; archives may hold duplicate entries, so the first hit wins); `peekExact()` now goes through `findExactIndex` and **returns the on-disk original** (so the archive's write-then-remove flow keeps `[id:…]` / `[summary:…]`, and promoting back into the main track loses no metadata); both `ArchiveStore.remove()` and `removeExact()` normalize on both sides; and in `promoteArchived()` the `hits` filter and the subsequent `archive.remove()` **must share one basis** — fixing `hits` alone leaves the promoted entry stuck in the archive, so the same content lives in both the main track and the archive with no error reported anywhere.
- **`runGit()`'s 30 s network timeout never actually took effect — the timeout killed only the direct child process, so the Promise could stay unsettled forever (issue #69, blocking)**: `git ls-remote` / `git fetch` spawn `git-remote-https` in turn, which **inherits and holds** the stdout/stderr pipe write ends; Node fires `'close'` only once every stdio handle is closed, and `resolve()` was attached to `'close'` alone — so although the timeout callback killed `git`, `'close'` never fired and the Promise hung. Measured (with a local TCP black hole, which is more deterministic than an unroutable address): before the fix the Promise had still not settled after 120 seconds; after the fix it returns at **30022 ms with `{ok:false, code:null}`** and a timeout note appended to stderr. The impact is more than one stuck call: sync runs on a systemd user timer, so a single hang leaves the caller permanently without a failure reason, and `node --test` over `tests/sync-*.test.js` hangs as a whole. The fix does three things together: (1) `settle()` settles once — timeout / error / close, whichever arrives first wins and later ones are dropped, otherwise a timeout failure would be overturned into a success by a late `close`; (2) the timeout **resolves a failure result itself** instead of waiting for `close`; (3) once settled, `killGitTree()` cleans up as far as it can — a `detached` process group plus `kill(-pid)` to take the grandchild with it (Windows has no process-group signal, so it falls back to `child.kill()`), and both pipes are destroyed so `'close'` can fire. The order matters: **settle first, clean up second** — reversed, the `'close'` triggered by destroying the pipes resolves ahead of the timeout result and reports a false success. `NETWORK_TIMEOUT_MS` / `LOCAL_TIMEOUT_MS` are now exported so the regression test can advance fake timers by the real thresholds instead of keeping a second copy that drifts from the implementation.
- **Built-in skill sync: the `skillDir` sentinel lands explicitly, and neither success nor failure is silent any more (issue #67)**: the "second layer" the issue reports — `config.skillDir` defaulting to `null` and reaching `syncBuiltinSkills()` unresolved, which then throws a TypeError — **does not reproduce**: `resolveConfig()` has carried `config.skillDir = resolve(config.skillDir ?? join(homedir(), '.agents', 'skills'))` since the very first commit, and `apply()` runs `resolveConfig()` before `installCoi()`, so the call site only ever receives a string (`resolveConfig({}).skillDir` measures as `C:\Users\…\.agents\skills`, and this machine's `~/.agents/skills` holds all five built-in skills, with `memory-consolidate` landing exactly when the plugin started). What does hold is layer one from #58: the call site sits inside `installCoi()`, which `coiEnabled` (default `false`) gates — **under the default configuration the built-in skills never sync** — and that layer is fixed by `e73a28e` in this same batch (see the next item). What this change fixes are the three parts of #67 still worth fixing: (1) the call site falls back explicitly with `config.skillDir ?? DEFAULT_SKILL_DIR` (a new exported constant whose value a test pins to `resolveConfig()`'s own resolution), while `syncBuiltinSkills()` throws a **readable** error for a non-string argument (naming the parameter and pointing at `resolveConfig()` or `DEFAULT_SKILL_DIR`) instead of passing Node's `The "path" argument must be of type string` upwards; (2) every sync now logs one visible line (target directory, total, number updated), `action: 'missing'` (a built-in skill absent from the package — a packaging defect) gets its own warning, and the catch prints a full stack — previously the success path logged only when something changed and the failure path emitted a single warning, so "the skills never installed" could only be discovered by inspecting the skill directory's mtimes; (3) **a Windows-only defect on the same path is fixed along the way**: `skillVersion()` matched `^---\n`, i.e. LF only, while on Windows `core.autocrlf=true` checks SKILL.md out as CRLF — both source and target parsed as 0, the version gate degenerated into "always equal", and **x-version upgrades silently stopped working on Windows** (the first install still copied because the target did not exist, so only the "upgrades do nothing" half was visible; the five skills in this machine's `~/.agents/skills` arrived exactly that way). Matching `^---\r?\n…` makes CRLF and LF parse identically. The related `normalizeSkillText()` likewise mistook existing CRLF frontmatter for none and stacked a second header on top; it now compares boundary lines with `trim()` and does not rewrite the user's line endings.
- **Built-in skill sync was switched off along with COI dispatch: under the default configuration the built-in skills never install (issue #58)**: `syncBuiltinSkills()` used to be called inside `installCoi()`, which `coiEnabled` gates (default `false` — this plugin's job is memory/todos/skills, dispatch is an on-demand add-on), so `memory-consolidate` and the four kimi/codex/grok/hermes CLI guides **never reached the skill library under the default configuration**; and because the call site wrapped everything in a try/catch that emitted a single warning, not even "it never ran" left a trace (the same accident as §7.5 broadcast, where an independent submodule could not be detached from COI). Fix: the sync moves to the plugin's main assembly (`apply()` in `lib/index.js`, step 6.5) and its implementation becomes `syncBuiltinSkillsIfEnabled(config, pluginSkillsDir?)` in `lib/coi/skills-sync.js` — **the decision reads only `coiSyncSkills`; `coiEnabled` no longer appears in the code**; `PLUGIN_SKILLS_DIR` moves with it and is exported (so a test can assert the source really lives inside the package), the call inside `installCoi()` and the module-level constant are removed, and that module now needs `normalizeSkillText` only for writing adapter guides. `coiSyncSkills` consequently means exactly "sync the built-in skills into the skill library at startup", independent of the dispatch switch.
- **The end-of-turn key suggestion never named a tool (issue #58, second item)**: `snap.keyDuty` / `snap.subagentKeyTail` said only "additionally submit one suggestion to target=key", while `memory_suggest`'s target whitelist is `['memory','user','todo-life','todo-work','todo-project','todo-daily']` (`lib/review.js`) and **excludes key** — taking the wording literally makes the model pick a tool that answers "target=key is not supported", and every turn ending trips over it. The channel that feeds the pending-confirmation queue is the memory tool's `add` (it shares `enqueueSuggestion` with `memory_suggest`). Both strings now read "additionally use the memory tool action=add to submit one suggestion to target=key (it enters the pending-confirmation queue and is written and injected after user confirmation)", with the Chinese and English kept in sync.

### Added

- **Progressive disclosure v2 for memories: `summary` extended to all three tracks, a 120-character cap, per-entry length folding, and `retag`-based summary backfill** (user decision: give memory progressive disclosure the way skills already have it; inject only an abstract for long memories and load them on demand; generate the summary together with the write, and backfill existing entries in bulk). (1) **The `summary` parameter of `add` moves from the key track to memory/user/key** — the gate used to be `target === 'key' && summary`, so memory/user could only fall back to `autoSummary` truncating the first line of the body, and entries on those tracks are mostly single-line paragraphs (measured: MEMORY.md 182 entries / 86,804 chars, mean 477), making that fallback both lossy and nearly free of savings. (2) `autoSummary`'s default cap goes from 80 to `SUMMARY_MAX_CHARS = 120`, matching the write path of an explicit `[summary:…]` (previously the writer accepted 120 characters while injection honoured only 80 — two different yardsticks); the sanitising logic becomes the single source of truth `normalizeSummaryText` (newline / `]` / tab stripping, whitespace collapsing, truncation). (3) A new `memorySummaryMinChars` (default 400, positive-integer validation, `RUNTIME_KEYS`, bilingual settings page / i18n) — **in summary mode entries are now folded by their own length** instead of there being only an all-or-nothing track-wide switch: entries whose body (via the new `entryBodyOf`, the verbatim body with head metadata stripped) exceeds the threshold collapse to a one-line summary while shorter entries stay in full; `[salience:3]` and recent-hit exemptions still stay in full, and `off` mode is completely unaffected (byte-identical to the golden baseline). (4) `retag` gains an optional `summary` parameter (new `retagEntryMeta`): it locates one entry by match and **rewrites only the head metadata tags** (`[summary:…]` and/or `[salience:N]`, in `stampEntry`'s order) with the **body left byte-for-byte untouched**; at least one of the two must be given, and omitting both is refused honestly (a silent success would make the model believe the summary had been written) — this is the mechanism used to backfill existing summaries in bulk (resending a whole body just to insert one summary line wastes tokens and risks the body being edited in passing). (5) The tool descriptions (zh/en) now state that **when the body is long (>400 chars) the writer should supply `summary` as well** (≤120 chars) and how to load full text in summary mode (memory/user via `list`, the key track via `expand+id`). The client settings page gains the new control; this machine has no esbuild (no DSH source checkout), so the `lib/client.js` artifact was synchronised block by block from source and is held by the source↔artifact key-set equality assertion in `tests/client-config-save.test.js`. Tests: `tests/retag.test.js` gains ⑧a-⑧g (including **byte-level body** assertions comparing `Buffer.from(entryBodyOf(…), 'utf8')` byte by byte), `tests/memory-progressive-disclosure.test.js` gains blocks 6-①~⑥ (length folding / configurable threshold / salience:3 takes priority / off unaffected / knob validation / injection-must-go-red), `tests/progressive-disclosure.test.js` gains "memory/user-track add summary", and `tests/store-summary.test.js` gains `entryBodyOf`/`normalizeSummaryText`.

### Changed

- **The built-in skill `memory-consolidate` goes to `x-version: 2` (the third item of external PR #58, taken verbatim)**: it adds four field-tested boundaries — (1) **write operations on one track run serially** (the same `.md` is read-modify-write, so interleaving overwrites each other and trips the drift guard; finish one cluster before touching the next); (2) **`replace` rewrites the entire entry**: `content` must carry the full new text, because passing only an increment or a new sentence **silently swallows** the remaining paragraphs (measured 2026-09-16: correcting one multi-paragraph memory by writing only the new sentence lost every other paragraph, recovered only from the memories repository's git backup; read the original in full with `list`, or `expand` on the key track, first); (3) **submit key suggestions with the memory tool's `add` (`target=key`), never with `memory_suggest`** (whose target whitelist excludes key and answers "target=key is not supported"); (4) a new "4. Failure handling (exception fallback)" section — the escape route when the drift guard refuses a write with "cannot be parsed round-trip" (back up first, normalise with the plugin's own `lib/store.js` via `serializeEntries(parseEntries(text))` while checking the round-trip entry count is unchanged, then return to the tool flow), plus "judge entry adhesion only by `parseEntries(text).length`" (counting `\n§\n` with a regex gives false positives when an entry body quotes the delimiter literally). The skill text comes from `d78043d` in PR #58 and is byte-identical to that commit. **Note that this item only installs from this version onward** — before it, `skillVersion()` parsed 0 under a CRLF checkout and the version gate degenerated into "always equal", so x-version upgrades failed silently on Windows (see above).

### Tests

- New `tests/injection-source-kind.test.js` (4 cases): (1) a replica of the host's v4 admission rule with a **premise self-check** — the rule must reject the retired spelling and accept the canonical one, otherwise the assertions below are false-green; (2) the shape of `PLUGIN_SOURCE_KIND` and its admission; (3) a scan asserting no retired spelling remains under `lib/`; (4) a scan asserting all four injection sites reference that one constant (so a future injection site cannot hand-write its own kind). Behavioural evidence lives in existing cases: `tests/coi.test.js` (session broadcast / room dynamics / COI completion notice) and `tests/ws-coord.test.js` (write-conflict `additionalContexts` / notice board) assert on the real constructed message objects that `source.kind === PLUGIN_SOURCE_KIND` and `source.plugin === undefined`; the stubs built with the old spelling in `tests/plugin.test.js` and the two advisor cases were updated to match.
- New `tests/store-display-match.test.js` (12 cases). Key design point: the display text comes from the **real `buildMemoryFiles()`** — the test does not re-implement the stripping, so if the display layer ever strips a new kind of metadata these cases go red with it instead of passing green while the field stays broken. Coverage: `normalizeForMatch` strips only the head (a `[summary:…]` literal inside the body is left alone, and two entries differing only by that literal still tell apart); the four exact operations on the main track (delete, edit — timestamp and summary preserved verbatim —, branch scope, `[dsh-only]`); `peekExact` returning the on-disk original; archive-page deletion for both a summary-bearing entry and an entry carrying **only `[id:…]`** (pinned by its own case); duplicate archive entries taking the first hit; `promoteArchived` **asserting the archive file is emptied** after a successful promotion (guarding against the half-fix that repairs `hits` but not `remove`); and "multiple hits after normalization → refuse conservatively and touch nothing". Verified: reverting `normalizeForMatch` to the old `stripEntryId`-only behaviour makes 5 of the 12 cases fail.
- New `tests/sync-git-timeout.test.js` (7 cases, one of them POSIX-only): it injects a fake child process that **never emits `'close'`** (the equivalent of "a grandchild is holding the pipe") and advances `mock.timers` by the real thresholds, asserting that "nothing settles before the deadline", "at the deadline it settles with a timeout note and the command line", "a late `'close'` cannot overturn the result into a success", "both pipes are destroyed", and "the normal path and a spawn error are unaffected". So that a regression does not degenerate into a **hang** — under the old implementation the Promise never settles, and a plain `await` would leave the test process hanging instead of failing — the wait uses a real-time budget polled via `setImmediate` + `Date.now()` and raises an explicit assertion when the budget runs out. One further POSIX-only case uses a real detached child process plus a real grandchild (exactly the `git → git-remote-https` shape) to verify that `kill(-pid)` clears the whole tree; Windows has no process-group signal (and no SIGKILL semantics), so it is skipped — the guarantee on Windows is that the caller is no longer held hostage, while the grandchild may live until its own timeout. Verified: reverting the timeout callback to the old "kill only, never settle" behaviour makes 4 of the 7 cases fail, as **explicit assertion failures rather than hangs**.
- New `tests/skills-sync-default-dir.test.js` (6 cases): (1) `DEFAULT_SKILL_DIR` must match `resolveConfig({}).skillDir` and `resolveConfig({ skillDir: null }).skillDir` (one authority for the sentinel, so two definitions cannot drift), and an explicit configuration is not overridden; (2) `syncBuiltinSkills(ps, null | undefined | '')` must throw an error naming `userSkillsDir` and pointing at the right remedy, and must **not** contain Node's `The "path" argument must be of type string`; (3) a packaging guard — every entry of `BUILTIN_SKILLS` must actually exist under the package's `skills/` with frontmatter carrying name and description (turning a runtime-silent `action: 'missing'` into a red test); (4) a sync driven by the package's real content: all five land, zero `missing`, and a second run is entirely `unchanged`; (5) **an x-version upgrade must take effect under CRLF** (reverting the new regex to LF-only makes this case fail — verified); (6) `normalizeSkillText` does not stack a second frontmatter under CRLF, while missing fields and an unclosed header still raise errors.
- New `tests/skills-sync-decoupled.test.js` (8 cases): the source lives inside the package (`PLUGIN_SKILLS_DIR` points at the repository's `skills/` and all five are present); **`coiEnabled:false` does not affect the sync** (the crux of issue #58); `coiSyncSkills:false` is the only off switch (`coiEnabled:true` still does not sync, and not even the skill-library directory is created); the `skillDir` sentinel lands on `DEFAULT_SKILL_DIR` (using an **empty built-in source** so nothing is written into the real skill library; the target directory is asserted from the log line instead); a throwing sync is folded into one warning with its reason and returns null; every startup reports its result (including the most common "5 total, 0 updated"); missing sources are recorded as `missing` one by one with a warning; and a target path occupied by a file is likewise folded into a warning instead of thrown.
- `tests/plugin.test.js` gains two **assembly-level** cases (running the real `apply()`): with `coiEnabled:false` all five built-in skills must land, and with `coiSyncSkills:false` not even the skill-library directory is created. Verified: removing the main-assembly call makes the first one fail. The same file's snapshot case gains assertions for the second item: the key suggestion must name `memory 工具 action=add`, and `memory_suggest target=key` must not appear (so the wording cannot regress to leaving the tool unnamed).

---
## 2026-09-24

### Added

- **memory add gains the used usage report: hit signal from injected reading** — at end-of-turn writes (both single-track and batch entries writes) the model may attach an optional `used` parameter (an array of distinctive entry substrings) reporting which existing memories this turn actually consulted; the server resolves each ref across memory→user→key, and a unique hit on any track bumps that entry via `bumpHits` (unmatched/ambiguous refs ignored without error, duplicate refs deduped, everything failure-isolated from the add main flow). The snapshot end-of-turn write guidance gained the reporting clause (golden re-captured a third time, spec revision record R4 — Q5 semantics revised to "injection never auto-counts; usage the model actively reports via used does count").
- **memory tool gains the retag action: runtime re-marking of legacy entries by the model** — locate one old entry by match and restamp its `[salience:N]` importance (body text untouched, `[id:]`/`[summary:]` preserved; no-match/multi-match errors identical to replace; project/daily logs rejected honestly). The snapshot write guidance gained the "retag legacy entries" clause (batched during review turns, 10-20 entries per turn until done); the snapshot golden baseline was re-captured a second time (single differing segment = the keyDuty retag clause; spec revision record R3).
- **Hit-driven exemption for legacy entries in snapshot tiered injection (memoryHitExemptDays, default 30)**: in summary mode (auto over-threshold / on), old entries without a salience tag are no longer blanket-summarized — old memories with hitCount ≥ 1 and last access within the threshold stay fully injected (daysBetween shares the decay module's date arithmetic; sidecar reads are failure-isolated). `0` disables the exemption; off/auto full-injection paths are unchanged (golden stays byte-identical — the summary-head copy never enters the default snapshot).
- **Memory-tool usage guidance and snapshot injection notes now teach the full lifecycle**: the tool description gained salience usage (pass `salience:2-3` for durable facts/user conventions/core architecture decisions, omit for routine progress; integer 1-3 clamped automatically), automatic hit counting for `list`/`expand`, and a `decay` action note (on-demand decay-archive candidate report decay-report.json, never deletes anything); the snapshot injection write guidance (key-suggestion clause) gained "pass salience:2-3 for core conventions/decisions, omit for routine progress". The snapshot golden baseline was **intentionally re-captured** (single differing line = the write-guidance keyDuty clause; spec revision record R1).

### Docs

- All three READMEs (usage guide / detailed guide / English guide) gained a "Memory Lifecycle" section: salience parameter usage, hit-statistics mechanics (list/expand counting, hit-stats sidecar locations, excluded from sync), the decay action and report contract (including fallbackCount semantics), the memoryProgressiveDisclosure three states with the two threshold settings, and the decayThresholds configuration.

## 2026-09-15

### Fixed

- **Memory content was being progressively corrupted into U+FFFD by the sync path (root cause, blocking)**: `MEMORY.md` and daily logs grew `�` characters (45 accumulated silently over four days in the field; 11 across four daily files on this machine) while the format pre-checks (`isCanonical`, parse→serialize round-trip) happily let them through. The root cause was the **sync read path**: `runGit()` (`lib/sync/repo.js`) collected child output with a bare `String(chunk)` — `String(buffer)` is `buffer.toString('utf8')`, i.e. **every pipe chunk is decoded independently**. Git streams large blobs in 32 KiB blocks, so any multi-byte character straddling a block boundary (a 3-byte CJK character, a 4-byte emoji) was split into two invalid sequences and decoded into one U+FFFD each. Propagation: `readTreeFiles()` (reading remote `theirs` / merge-base `base`) → damaged text enters → `mergeEntries` → written back → committed → the next sync reads the damage back and splits more characters, **accumulating round after round**. Forensics: the commit holding the damage had two parents with zero U+FFFD yet the merge result had two, and the next round went 2 → 3; in the clean revisions of the four damaged files the damaged character starts at byte offsets 32766 / 32767 / 32766 / 81913 — the first three **straddle byte 32768 exactly**. Fix: decode via `setEncoding('utf8')`, where Node's StringDecoder holds the incomplete sequence at a chunk boundary and completes it with the next chunk. The same bug was fixed at three more sites: `lib/sync/index.js` (worker child stdout/stderr — stdout's last line is JSON, so damage breaks parsing), `lib/search-docs.js` (document search `out += chunk`, damage lands in search results), and `lib/coi/scheduler.js` (COI task logs, both the start and the resume paths, where damage lands in the log the user reads). `runGit()` also gained an `opts.spawnFn` injection point (tests only) so a chunk boundary can be reproduced deterministically.
- **Document-search output cap now counts UTF-8 bytes**: `lib/search-docs.js` guarded `maxBytes` with `out.length + chunk.length`, mixing UTF-16 units with Buffer bytes. Now that `setEncoding` makes `chunk` a string, `.length` would count a CJK character as one third of its byte size, so the cap accumulates `Buffer.byteLength(chunk, 'utf8')` separately.

### Tests

- New `tests/sync-utf8-stream.test.js` (14 cases): injects a fake spawn plus manually `push`ed Readable streams and delivers 2/3/4-byte characters as two pieces at **every internal split point** (six cases each for stdout and stderr), plus a byte-by-byte worst case and a real-child-process smoke test. Every case self-checks the premise ("the same pieces handed to the old chunked decode must be damaged"), so a split point that stops being harmful fails loudly instead of passing green. Verified: reverting the decode fix makes all 14 fail. (The first version of this regression used a real child process with a 60 ms timed split, which external review falsified as **false-green** — a slightly slow parent coalesces both pieces into a single data event; it has been rewritten with injection.)

---

## 2026-09-14

### Fixed

- **A literal `{{...}}` inside memory content could poison a session (issue #53, blocking)**: the host's system-prompt section renderer treats `{{name}}` in section text as a template variable and **throws on any unregistered name** (only `provider`/`model`/`cwd` are registered). The `memory:snapshot` section spliced session title/alias, `memory`/`user` tracks and the project KEY track in verbatim — sanitization existed only for the prompt-injection track. So one literal `{{xxx}}` written into memory (real case: recording the fact `x-opencode-session: {{session}}`) became a landmine for every session injecting that track: **the session failed at every step of every turn and could not rescue itself** (tool calls need a turn, and turns could not start) — the only way out was editing the memory file by hand. The whole snapshot is now sanitized before leaving the plugin: `sanitizeSnapshotBody` gained an `expand` option — the injection track keeps `expand=true` (users write real templates), while memory content and the whole-snapshot path use `expand=false`, which **downgrades without expanding** (a `{{date}}` in memory is a recorded literal fact; expanding it would falsify content; `{{date}}` → `{date}` keeps the meaning and stops the host from parsing it). `buildMemoryContext` (external COI only, never rendered by the host) is left alone. Because sanitization happens at render time, **already-poisoned sessions recover as soon as the plugin is upgraded** — no user data files are touched.
- **Enabling advisor raised `TypeError: events is not iterable` every turn (issue #49)**: same root cause as issue #42 / PR #38 — DSH 0.1.2-alpha.4+ removed `Session.events`, and while `lib/review.js` was fixed back then, advisor's `session/event` wiring was missed, passing `undefined` to the observer whose `findLastMessageTurnEnd` then ran `for...of` over it. Now uses the same three-tier fallback `session.ownEvents?.() ?? session.events ?? []`.

### Added

- **Built-in skill memory-consolidate (external PR #50)**: consolidates accumulated memories through seven approved criteria (supersede-keep-newest, similar-entry merging, literal dedup, conflict resolution, project-local archiving, stale-state cleanup, cross-track relocation). Hard boundaries: memory tool only (`replace`/`archive`/`add`; never edit `.md` files directly, never `remove`, so every step is reversible); daily logs and todos never participate; new key entries still go through the user-confirmation queue. Ships a zero-dependency read-only pre-scan script `scripts/scan_memory.mjs` (entry parsing, CJK bigram TF-IDF similarity, supersede hints, conflict-polarity clustering) that only proposes candidates and never decides or writes.

### Changed

- **Turn-end is now two-step: write memory first, then output the complete reply (external PR #52)**: the old rule put the complete reply and the memory tool calls in one message, but in DSH **a message carrying tool calls cannot end the turn**, which forced an extra closing message; `transcriptView` defaults to `compact` (collapsing finished turns, highlighting the final output) and highlights the **last** message — so it highlighted the meaningless closing line instead of the reply. Now: ① one message with only the write tool calls (no prose) → ② the next message outputs the complete reply (no tool calls, ends the turn), making the reply the last message. Note the `snap.turnEndHead` text deliberately avoids the word "dtodo": that line is not gated by `todoEnabled`, whose turn-end guidance lives in the gated `snap.todoHint`.
- **Built-in skill sync now copies whole directories (external PR #50)**: previously only `SKILL.md` was copied; now the entire skill directory travels (so `scripts/` ships with the skill), with version gating and user-edit protection unchanged (not overwritten while the target's `x-version` is not lower). **Behavior change**: on a version bump the target directory is cleared before copying, so files a user added inside a built-in skill directory are removed.

---

## 2026-09-09

### Fixed

- **"Memory write watchdog" toggle in Memory Evolve Settings reverted after saving and refreshing**: `MemoryQueueView.saveConfig()` hand-builds a fixed patch object for the host, and that key list is hard-coded — `perTurnWriteGuard` (the watchdog toggle) and `writeGuardThreshold` (its threshold) have controls and are bound to `draft` (the checkbox flips immediately), but were never added to the patch. The POST body therefore carried neither key, the host's `updateRuntime()` never saw them, nothing was persisted to `plugin-state.json`, and the next `GET /api/config` returned the default `false`. Because the panel renders the local draft, the save even reported success — the loss only surfaced after a refresh. Fix: both keys are now sent (TypeScript source plus a rebuilt `lib/client.js` artifact), with a regression test `tests/client-config-save.test.js` pinning the contract "every draft-bound panel key is sent by saveConfig" (and asserting the source and artifact key sets match, guarding against "source edited but artifact not rebuilt"). Verified to fail when the fix is reverted.

---

## 2026-09-08

### Fixed

- **Memory-tab sub-navigation hidden and unclickable after widening the conversation (issue #40)**: since DSH 0.1.2-rc the conversation column renders width-drag handles (absolute full-height `col-resize` strips carrying `data-width-handle`, z-index 8, width `min(40px, (100% - --dsh-chat-content-width)/2 - 48px)`). Plugin tabs are full-column-width panels that do not follow `--dsh-chat-content-width`, so after widening the chat the strips land exactly on the tab's top sub-navigation row (Guide / global rules AGENTS.md …), blocking both visibility and clicks. The fix mirrors DSH's own treatment of full-bleed overlay views (`.root:has([data-conversation-composer-overlay]) .widthHandle{display:none}` in `ConversationRoot.module.css`): `[data-phase]:has(...) [data-width-handle] { display: none }` now covers the root containers of **all eleven tabs** (`.mt-panel` memory/skills/todos/settings/models/sync, `.me-panel` UI settings/version/guide, `.coi-root`, `.bb-pane`, `.pm-root`, `.bm-panel`). The handles hide while any plugin tab is mounted and come back on the conversation view; the stored width preference is untouched.
- **Subagent snapshots no longer carry the dtodo turn-end hint (issue #43)**: `snap.todoHint` ("at turn end call dtodo list to check what is due … remind the user at the end of your reply") is a user-facing duty. Subagents do not deliver to the user directly and must not remind on the parent session's behalf; the hint only nudged them into one extra pointless dtodo call. Every other turn-end duty (review counter, write watchdog, turn-end heading, write wording) was already downgraded via `isSubagent` — this one was the missing exemption. A regression test was added and verified to fail when the fix is reverted.
- **Per-turn "turn-stopping 处理失败: Cannot read properties of undefined (reading 'length')" (issue #42)**: DSH 0.1.2-alpha.4+ no longer exposes `Session.events`; reading it yields `undefined` and `.length` throws, which the turn-stopping serial dispatch surfaced as a non-fatal warning. Now `agent.session.ownEvents?.() ?? agent.session.events ?? []` (older hosts fall back to `.events`). The fix had only lived on the development track — **this release is the first to ship it**; users on the previous release tag still see the warning.
- **headless profile failed to load (issue #35)**: `workspaceRegistry` (a web-only service) is no longer a hard `inject` dependency; it is read lazily through `ctx.get`.
- **Session bookmarks broken on DSH 0.1.1-rc.2+ (issue #39)**: adapted to the upstream `data-chat-anchor-key` rework (`node:{seq}` → `{kind.length}:{kind}{id}`) across star injection, list, jump and branch; legacy records fall back to seq. Also fixed the fork-seed seq-hole overrun that turned mid-turn branches into full copies.
- **Full-disk `dir` search hang (external PR #32)**: Windows system directories added to `WALK_IGNORE`, pending queue cleared after `maxFiles` truncation, drive-letter dedup in `defaultRoots`.
- **Windows cross-drive skill adoption**: `renameSync` EXDEV between `memoryDir` and `skillDir` now degrades to `cpSync + rmSync`.
- **Mobile "Memory Evolve settings" overflow (issue #31)**: long unbroken text wrapped, controls capped at `max-width: 100%`, and the missing `.me-todo-select` full-width rule added.

### Added

- **Manual entries in the MEMORY.md / USER.md tabs (issue #30)**: previously only the project KEY.md tab had an add box, while the global long-term memory and user profile were read-only. New `POST /memory-evolve/api/memory/memory` and `/user` endpoints (same timestamped append as KEY) plus an add box at the top of both tabs, with per-file drafts that survive tab switches.

> This release also contains the "memory write watchdog" and "broadcast delivery wake" additions dated **2026-09-04** (see below).

---

## 2026-08-17

### Fixed

- **Enabling Prompt Manager no longer breaks Code Mode turns (issue #13)**: the `de_prompts` parameter description no longer exposes double-brace syntax the host can interpret. Once the tool schema is serialized into the `tools:sdk` system-prompt section, its date/time template example was mistaken for an unregistered prompt variable, raising `unknown prompt variable "{{date}}"` and blocking every subsequent step. The description now uses single-brace wording (behavior unchanged: `{{date}}`/`{{time}}` expansion in user prompt bodies is unaffected). The same leftover was also cleaned from the `de_session` tool description (`{{model}}` example changed to plain text). A regression test now keeps model-facing tool schema text free of that syntax.

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
