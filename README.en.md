# dsh-memory-evolve — Usage Scenario Guide

> **In one sentence**: Give the AI inside DSH long-term cross-session memory, help you manage todos and skills, and let you orchestrate a team of AI sessions and external AI agents working together — **the more you use it, the more it understands you, and switching sessions never loses context**.
>
> This guide is organized around real workflows. Each scenario explains "who it's for, what it can do, how to use it, and what you get."
>
> Related docs: [Detailed feature guide](README-详细说明.md) · [Memory sync](docs/记忆同步.md) · [Changelog](docs/CHANGELOG.en.md) · [中文](README.md)

---

## Quick Start (Installation)

> ⚠️ **Running `dsh plugin add` alone is NOT enough**: on DSH 08-06+ (profiles architecture) the loader only activates plugins registered via a patch-layer `insert` — with `add` only, the client loads but the host side (memory/skills/todos/settings — i.e. all real capabilities) never starts and no tabs appear in the UI. See the [detailed guide](README-详细说明.md) "标准安装" section for the full story.

Using the web profile as an example, three steps:

```sh
# 1. Install into the profile (use link: for a local directory; git/registry
#    package addresses also work)
dsh plugin --profile web add github:csyangwen/dsh-memory-evolve
```

```sh
# 2. Edit ~/.dsh/profiles/web/cordis.patch.yml and append the registration
#    (the ID comes from the "name" field in package.json and must match
#    exactly — no @dsh-local/ prefix):
```

```yaml
- insert:
    - id: dsh-memory-evolve
      name: dsh-memory-evolve
```

```sh
# 3. Restart dsh web — done
```

To uninstall: remove the `insert` line from the patch, then run `dsh plugin --profile web remove dsh-memory-evolve`. Everything is cleaned up automatically.

---

## Meet It (30 Seconds)

After installing the plugin, open any session and you'll get a row of capability tabs: **Memory · Skills · Todos · Infinite Canvas · COI Scheduling · Session Broadcast · Prompts · Memory Sync · Model Settings · Bookmarks · Session Review · Web UI Settings · Memory Evolve Settings**. On the AI side, you get a batch of tools: memory read/write, todos, skill management, local file search, session orchestration, session broadcast, external-AI dispatch, prompt injection, model query, and more.

In one sentence: **let the AI remember you, manage for you, do for you, and work together for you.**

> Tip: Many plugin capabilities are off by default (so they don't bloat the AI's tool list). Turn them on in "Memory Evolve Settings" when needed. Most scenarios below are combination plays — **turn on all the related features to assemble a complete pipeline**.

---

## Scenario 1: Let the AI Truly Remember You (Long-Term Memory)

**Who it's for**: Everyone. This is the plugin's core and the foundation of everything else.

An AI's conversation is "one-shot": switch projects, wait a few days, or open a new session, and it forgets who you are. The plugin's five-track memory gives the AI **cross-session long-term working memory**:

- **User profile**: your preferences, company, communication habits — the AI sees these every turn;
- **Global facts**: long-term knowledge about environments, tools, and conventions;
- **Project key memory**: the current project's conventions, decisions, architecture, and gotchas, auto-injected into context; important conclusions can be tagged to apply **only on a specific git branch**;
- **Project log / daily log**: progress is auto-recorded every turn, read on demand, history traceable.

**How to use it**:

1. Just talk to the AI normally — at the end of each turn it automatically writes progress into the project log and daily log;
2. When you hit an important fact, say "**Note this down: this project's deployment port is 8080**" — it writes to project key memory, effective **only after you confirm** — the AI never writes to memory on its own;
3. Days later, in another session, just ask "**Check memory: what architecture decision did we settle on last time?**" — it picks up seamlessly;
4. Once memory grows, tell the AI to "**archive that XX memory entry**" — archived entries no longer get injected into context and can be restored anytime;
5. **Emotion feedback log**: your evaluation of work results (e.g. "great!" or "why isn't it fixed yet?") is recorded into the daily and project logs (a `【feedback】` line with emotion, task category, and your exact words) — accumulated over time, you can ask the AI to "**analyze what I've been dissatisfied with recently**" and judge where it does well or poorly by task type.

**What you get**: the AI goes from a conversation machine that "goes amnesiac every session" to a long-term partner that understands your whole workflow — continue development the next day and it directly cites yesterday's conclusions without you repeating them.

---

## Scenario: Share Project Memory Across Computers (Memory Sync)

**Who it's for**: People working on two computers (office + home) or collaborating with colleagues on the same project — who don't want to re-explain important conclusions on every machine.

**How to use it** (see [Memory sync](docs/记忆同步.md) for details):

1. In "Memory Evolve Settings → Config", turn on the **Memory Sync** module switch (this only makes the feature visible);
2. In the project session's **Memory Sync** tab, turn on **Sync this project** — click "Start sync" (the remote memory defaults to your code repo, auto-stored in a dedicated branch without polluting code), then click "Sync and push" to finish the first push; **code is public (e.g. open-source on GitHub) but you want memory private**? Fill in a **shared memory repo** address — one repo holds all projects' memory (one dedicated branch per project), keeping memory fully isolated from code;
3. On the other computer, clone the project and open it — **it auto-recognizes** (same repo URL = same project), pull it down and continue;
4. Write memory as usual (real-time flush, zero latency), accumulate a batch and click "Sync" once; a conflict only appears when both machines edited the same entry — in the tab choose "take local / take remote / keep both".

**What you get**: project key memory, project logs, archives, and project todos stay consistent across devices; with a shared memory repo filled in, **global memory (user profile / daily log / todos) also syncs across devices** (four independent track switches — sync only what you turn on) — switch computers without switching memory. **Projects with sync off are completely unaffected** (stay purely local).

---

## Scenario 2: Multi-Project Parallel Development, Nothing Falls Through (Todos + Project Log + Local Search)

**Who it's for**: Developers juggling multiple projects who keep getting stuck on "how was that earlier approach decided?"

- **Four-track todos**: Life / Work / Project / Daily. The "Project" track is isolated by working directory — switching directories doesn't interfere. Say "**Remember: before Friday, deploy the second-level panel to the mobile-access instance**" and it becomes a project todo (with important/urgent flags and due date); at the end of each day the AI reminds you of due todos;
- **Project log**: each project's progress is settled in isolation by directory, logs auto-tagged with `[git main]` branch markers for traceability;
- **Local file search**: tell the AI "**search my machine for anything similar I've written before**" — finds docs by filename (extensible to all types); also content search: "**which doc mentions XX**" directly returns the matching file and snippets.

**How to use it**:

1. Start a new project and just start chatting — the project log auto-creates;
2. Ideas that pop up, say "remember" to the AI — they enter the pending-confirmation queue — adopt or reject in "Todos", you call the shots;
3. When you can't recall, ask "a doc mentioned XX before".

**What you get**: juggling 3 projects at once stays tidy — each project's memory, todos, and doc clues go to their own directories, recoverable with one question.

---

## Scenario 3: One Person Directing a Team of AIs (Internal Team)

**Who it's for**: People who want to use AI as a "team" — one main session directing designer, frontend, backend, and test sub-sessions.

**How to use it**:

1. **Assemble the team**: tell the main session's AI "**Create 4 sessions: designer handles site visuals, frontend handles pages, backend handles APIs, test handles acceptance, and pull them into one collaboration room**" — it immediately creates 4 standard sessions (appearing in the left list, ready to take over anytime), automatically inheriting your model and working directory; you can specify an **Agent preset** when creating (e.g. "create the frontend session in code mode") to decide that session's tool surface and personality;
2. **Collaborative communication**: once the room is built, **who changed what and who finished is visible to all**; member status changes (generating / idle) auto-trigger a "room activity" notification; **room messages can carry images** — paste a screenshot into the group, and the receiving AI gets the image file path via `read`, can read the image, and can forward it to an IM channel;
3. **Dispatch and nudge**: ask the AI "**who's working now and who's idle?**" and it checks each session's status; for an idle session say "**tell frontend to send the results over**" and the AI auto-wakes it and dispatches work — no batch auto-waking, everything is consciously directed by you (or your main session);
4. **Conflict prevention**: when multiple sessions edit code in parallel on the same project, tell the AI before starting "**declare which files you'll modify**" — others (and their AIs) can see "who's changing what"; on a real collision the writer gets a conflict warning, plus "workspace activity" notifications (separately pushed on parallel start/end and member changes) keep you informed who's running and doing what;
5. **Result handoff**: each member posts results back to the room, and you aggregate and confirm.

**Sustained operation (key)**: the main session keeps running itself, so it can **wake any resting (idle) session at any time to continue work** — nudge, collect results, dispatch the next round; even away from the computer, the team pushes forward to results. The only prerequisite is **the DSH process hosting the main session keeps running**; if the main session goes idle or DSH is closed, the wake chain stops — you need to come back and send a message for the team to restart.

**What you get**: one person's dev output becomes a small team's throughput. Task handoff, waking, and conflict warnings are automated end-to-end, with room messages traceable.

---

## Scenario 4: Hand Heavy Work to External AI Agents (External Help)

**Who it's for**: Users who need to hand big tasks (visual redesign, code review, full feature development) to dedicated AI agents (Kimi / Codex / Grok / Hermes) — without being blocked, and without missing results.

**How to use it**:

1. Tell the AI "**dispatch this task to grok: mobile adaptation refactor**" — it runs async in the background, returns a task ID immediately, **doesn't block the current session**, and you can keep chatting;
2. Ask anytime "**how's the task going?**" or watch the real-time log stream in "COI Scheduling";
3. When dispatching, the AI can choose to carry your project memory along — the external agent also "understands project conventions";
4. **Dispatch with images**: tell the AI "**send this screenshot to grok for analysis**" — attachments support local path / remote URL / current-session image (the image you pasted in the input box); codex/kimi/hermes can actually see images (grok reads via prompt; zcode is text-only and rejects explicitly);
5. On completion the result summary **auto-writes into the project log and daily log** — dispatched work automatically becomes your memory asset.

**What you get**: AI dispatches work to AI, and you only handle confirmation and acceptance. Visual redesign, deep code review, batch refactoring — these "heavy jobs" can all be offloaded, keeping the main session light.

---

## Scenario 5: Inside + Outside Working Together — One Team, Two Kinds of Troops

**Who it's for**: People whose tasks are too big for one side alone. This is the full form of the plugin's collaboration: **internal sessions handle work needing context and back-and-forth polishing; external agents handle one-shot heavy work; memory, rooms, and prompts chain them into a pipeline.**

A complete real flow (product visual redesign):

1. **Divide work**: the main session spawns frontend and test internal sessions and pulls them into a room; meanwhile it dispatches "full-site visual redesign" to the external agent Kimi;
2. **External leads**: Kimi runs the redesign in the background (occupying no session); meanwhile the internal frontend session builds the data layer and page structure without idling;
3. **Handoff**: Kimi finishes, and the summary auto-settles into project memory — the main session posts the design conclusion to the room, and the frontend session **reads memory to get the design spec** and starts integrating;
4. **Escalation**: a weird styling bug appears during integration and the frontend session gets stuck — the main session dispatches the bug to Grok for deep digging, the conclusion returns to the room, and the frontend session fixes it accordingly;
5. **Acceptance**: the test session runs the acceptance flow, posts results to the room, and you confirm at the end.

Four collaboration joints, freely combinable:

- **Task relay**: external agents' output (summaries/conclusions) auto-enters memory → internal sessions relay and execute — **external does the heavy work, internal does integration and polish**;
- **Escalation**: internal sessions hit a hard problem → the main session dispatches it to an external agent to dig deep → the conclusion returns to the room — **internal iterates fast, external does slow careful work**;
- **Unified standards**: when dispatching to external agents, inject your accumulated prompts (like "code review checklist" or "PRD spec") — **external agents work by your process, not by luck**;
- **Status sync**: who's running and who's done is visible anytime via room + workspace activity + notifications — **you don't have to be a human dispatcher**.

**What you get**: a complete pipeline of "external leads → internal integrates → test accepts → you confirm." Big tasks are no longer carried by one person (or one AI), but split between an internal and external team.

---

## Scenario 6: The AI's Self-Discipline — Prompt Injection

**Who it's for**: People who want to settle "good working methods" and make every AI (including external agents) work by the same process.

The prompt library is an **instruction-paradigm asset library**: code review, debugging, PRD, test strategy… solidify commonly used working methods into prompts (categorizable, searchable, enable/disable-able).

**How to use it**:

1. **The AI picks and injects on its own**: when the AI thinks a certain process fits the current task, it checks the prompt library itself, picks the right prompt, and injects it into itself — "proceed by the code review checklist"; next turn it follows automatically, **without interrupting the current reply**; it can also "inject immediately" to take effect this turn;
2. **You inject with one click**: in "Prompt Injection", select one and click "Inject once / Continuously inject / Inject immediately" — continuous injection means "remind the AI to work by this discipline every turn";
3. **Temporary injection**: without creating a prompt, directly type a requirement to inject — it's auto-saved into the library for reuse;
4. **Dispatch with discipline**: when dispatching to sub-sessions or external agents, have the AI carry the corresponding prompt along — **the whole team uses the same standard**.

**What you get**: good methods no longer live only in your head or a single conversation — they become a reusable "team playbook" the AI follows on its own, while you only maintain the playbook's quality.

---

## Scenario 7: Sessions Too Long, Too Expensive, Easy to Blur — Bookmarks and Branches

**Who it's for**: Heavy users sensitive to context cost whose single sessions routinely run hundreds of turns.

- **Session bookmarks**: star (☆) any turn, "Bookmarks" lists all bookmarks (name / turn / time / summary, searchable), **one click jumps back to any turn** — star it when you discover "this conclusion matters";
- **Branch from any turn**: officially you can only branch from the last turn; this plugin **takes over the branch entry for any middle turn** — click "Branch" in the bookmark list (or click the official branch button, and a middle turn pops a confirmation), creating a new session through the official branch channel and entering the official branch genealogy;
- **Context usage reminder**: the input-box ring shows context usage in real time — ≥30% turns yellow, ≥40% turns red, reminding you it's time to bookmark, branch, or open a new session.

**How to use it**:

1. In exploratory sessions, star key turns and name the bookmark (e.g. "Plan A review conclusion");
2. To fork a new line from a middle decision point, click "Branch" in the bookmark list;
3. When the ring turns red, bookmark the current session and open a new session to continue.

**What you get**: context is no longer a rope you can only scroll from start to end, but a **timeline with anchors, branches, and jumps** — every turn's exploration can be precisely reused, and you no longer have to abandon good middle conclusions just because "the session got too long."

---

## Scenario 8: Use It Away from the Computer (Mobile Access + Session Filtering + Notifications)

**Who it's for**: People who want to keep collaborating with AI away from the computer, or who open too many sessions to watch.

- **Mobile browser access**: the DSH UI is adapted for phones — conversation area / message bubbles full-width, input bar "⋯" pulls up the collapsed toolbar and model selection; mobile operation matches desktop;
- **Session list filtering**: the left list can show only "active sessions", one screen to see who's working — desktop too;
- **Channel notification (de_notify)**: tell the AI "notify me via Feishu when the task finishes" — important results pushed to Feishu/QQ/WeChat/WeCom, known immediately at the computer or on the phone (notifications carry a "this is a notification" tag and can attach images/files);
- **Web in-site notification (de_notify channels=web)**: tell the AI "send me an in-site notification" — it lands directly on the **bell at the top-right of the web page** — unread count badge + popup list, showing "which session sent what", click the subject to jump to that session, long content click "view details" for a large popup; the bell is freely draggable and snaps to the left/right screen edge (position remembered). Sending to web and to Feishu etc. is the same sentence, just a different destination (channels `web`, or `all` to send both);
- **Channel direct-send (de_channel_send)**: the AI proactively sends text/images/files to your IM channel anytime (no notification tag) — the "send me the generated image/document" scenario; all four channels (Feishu/QQ/WeChat/WeCom) supported, attachment sources can be local path / remote URL / inline base64 / **current-session image** (sessionImage=true directly forwards the image you pasted/dragged into the DSH input box; attachmentId explicitly references, pair with de_session_images to first check which images this session has, requires DSH 260810+ snapshot).

**What you get**: heavy work keeps dispatching and progress keeps watched, without you being chained to the computer — back at the desk, take over the session from the left list and continue.

---

## Scenario 9: Give Every Session an Invisible Reviewer (Session Review)

**Who it's for**: People who want a "second pair of eyes" watching the AI's work without babysitting every line — especially when the project has set discipline (e.g. "state which directory you're in before replying") but you keep finding the AI forgets mid-conversation.

**What it can do**:

- **Independent reviewer**: attach an independent review session to each session; it **only observes the conversation you see on screen** (user words + the Agent's reply body), seeing no thinking process, tool-call params, or other internals — like a colleague sitting beside you who only listens and never touches the keyboard;
- **Real-time review every turn**: as the conversation advances each turn, the reviewer reviews once based on **full context** — it's a persistent session that remembers all history like a normal long LLM conversation and **never truncates**, never "forgetting what was said earlier";
- **Real-time steer when needed**: when the reviewer finds something worth saying, it injects into the current session as **a user instruction** — the Agent treats it as your words and executes directly (decided 2026-08-13: testing showed a "non-user instruction" tag makes the Agent question the source and lowers execution, so disguising as a user instruction works best); in the GUI conversation flow these messages show as a **collapsed `[severity]` prefix** line, so you can tell at a glance which words were actually the reviewer's;
- **Four severity levels**: `info` (record only, not injected into the main session by default, injection configurable) / `nit` (small suggestion) / `concern` (worth handling) / `blocker` (must handle immediately) — not everything interrupts, only what should be said;
- **New review session**: one click in the panel clears the reviewer's context and memory to start over — the new session's first instruction is where you tell it the background, and you control the context length;
- **Ask the reviewer directly**: ask anytime in the panel and it answers immediately (answers show only in the review panel, not injected into the main session flow) — like a listening colleague you can ask anytime;
- **Four-level constraints**: system prompt (global default, view full text / modify / one-click restore) / **project constraint** (shared in this workspace) / **session constraint** (kept for this session) / **this review-session constraint** (cleared with "new review session") — four layers spliced and injected, the more local wins on conflict;
- **Traceable records**: review records persist as JSONL, traceable in the panel's "Records".

**How to use it**:

1. In "Memory Evolve Settings → Config", turn on **Session Review** (`advisorEnabled`, off by default); the review model inherits the current session model by default, or configure `advisorProvider`/`advisorModel` separately;
2. The session page shows a "Session Review" floating window — open the panel to see the reviewer's real-time review stream and context usage;
3. In the "Constraints" tab, set rules for the reviewer (e.g. project constraint: "state which directory you're in before each reply"), saved and effective immediately;
4. Click "**New review session**" to restart the reviewer from scratch; click "**Ask**" to ask it directly;
5. Agent side: review reminders appear in the conversation flow as collapsed `[severity]` lines — you can see what the reviewer said and whether the Agent followed.

**What you get**: every AI session gains a continuously-on-duty "listening colleague" — it doesn't interrupt your rhythm, only reminds the Agent to correct course at key moments in your voice; project discipline and session constraints are watched for you, so rules aren't forgotten mid-conversation.

---

## Scenario 10: Scattered Materials, One Canvas (Infinite Canvas)

**Who it's for**: People whose design drafts sit in Downloads, contracts in a doc library, reference images on the Desktop, recordings in a personal folder — every use requires opening Finder and digging layer by layer; and people who want the AI to "see" the materials at hand without dumping them all into the conversation context.

**What it can do**:

- **Materials onto the board**: three entry points — **path onto board** (paste a local path), **note** (write directly in the canvas, content not persisted), **search onto board** (really searches local files, one click onto board); text files auto-read their content after going on board;
- **See at a glance**: infinite pan/zoom canvas, cards freely placed and resized via bottom-right drag; images / audio-video / text preview directly in the canvas; Word/PDF etc. open via the system default app;
- **Single board + view filtering**: physically one board, nodes carry ownership badges (🌐 global / 📁 project / 💬 session); the default session view shows "own session + current project + global", switch to "Project" to see all that project's sessions, switch to "Global" to see everything;
- **Quick access**: copy node ID / title / path / reference string (`[canvas:id] title`), toss the reference string to the AI and it finds the material by id;
- **AI both ways (pull-based)**: the AI uses the `de_canvas` tool to query the board by id, read material content, and place notes in the board's center area (tagged "placed by AI") — **canvas content is not injected into context**, queried on demand, saving tokens without interruption;
- **Local path reference**: files stay in place, the board only records "where it points" — source changes are visible in real time, and deleting the source shows an invalid hint on the card;
- **Security boundary**: the AI can only read nodes **already on the board** (no arbitrary path read API); sensitive directories (.ssh/.config etc.) refuse proxying even when put on the board.

**How to use it**:

1. In "Memory Evolve Settings → Config", turn on **Infinite Canvas** (`canvasEnabled`, off by default);
2. The session page shows a "Canvas" tab: path onto board / note / search onto board, cards freely arranged;
3. Click a card's "Reference" to copy the reference string, tell the AI "go get XX from the canvas" — the AI uses `de_canvas` to query / read / place notes;
4. Notes the AI places land in the board's center dashed area — drag them wherever you want.

**What you get**: goodbye to "where was that file again" — materials gather on one board, and you and the AI work at the same table: you place, the AI takes; the AI places, you look.

---

## Other Capabilities (One-Line Index)

- **Skill self-evolution**: repeatedly-hit methodologies auto-solidify into skills, so similar tasks execute by the process next time;
- **Skill management**: browse / search / disable / edit all skills in the Memory tab, add custom skill directories (the original standalone dsh-skills-manager plugin is merged into this plugin; legacy users uninstall the old plugin first per the install doc);
- **Infinite Canvas**: gather scattered files / text / images / audio-video onto one infinite canvas — local path reference, single board + view filtering (session / project / global), direct preview / copy / reference in-canvas; the AI can also read canvas material by id and place notes in the board's center area (de_canvas);
- **Session search**: let the AI search other AI tools' (e.g. Codex) historical sessions on this machine — "did XX in Codex before", just ask;
- **Model config**: the plugin maintains each model's enable status, thinking level, and notes, and marks **image-input support** (🖼 marker, clear at a glance when the AI picks a model);
- **In-turn memory review**: every N turns, the AI proactively distills memory-worthy info for your confirmation — the memory library grows itself;
- **Version detection & update**: in multi-device / multi-user deployments, the "Memory Evolve Settings" tab's "Version" page auto-detects remote release versions (git tag v0.x.y); when a new version is detected the settings tab shows a 🔴 red dot, and you decide whether to update (see "Release Versions" below);
- **Session review (Advisor)**: attach an independent reviewer to each session — observes only on-screen conversation (no thinking / tool calls), real-time review every turn, real-time steer as user instruction when needed (info / nit / concern / blocker four levels; info records-only by default), persistent never-truncating session, supports new review session / direct ask / four-level constraints / traceable records. Off by default, see [Scenario 9](#scenario-9-give-every-session-an-invisible-reviewer-session-review).
- **Web in-site notification**: channel notification (de_notify) adds a `web` channel — AI notifications land on the web page's top-right bell (unread badge + popup list + click subject to jump session + long-text large popup + drag-snap left/right), same notification semantics as Feishu etc. Off by default, enabled with the notification module (`notifyEnabled`) switch, see [Scenario 8](#scenario-8-use-it-away-from-the-computer-mobile-access--session-filtering--notifications).

Full docs for each feature are in the corresponding tab's "Guide".

---

## Release Versions

The plugin uses **git tag** as the release version identifier (two formats supported: **date-stamp `v<pure digits>`** like `v26081302` (recommended for daily releases), semantic `v1.2.3`): pushing the main branch in daily development triggers no update prompt — only a release tag is detected by each device.

**Release flow (developer)**:

```bash
# 1. Commit and push main (the tag must sit on an already-pushed main commit)
git push origin main

# 2. One-click with the release script: worktree/remote sync check → build → full test → annotated tag → push tag
bash ~/shell/dsh-memory-evolve-release.sh v26081302 -m "Release notes: ……"
```

**Update on each device (user)**:

- Auto-detect after entering the Web UI (auto-detect at most once per 24h, or click "Check for updates" to force; also a background check once on plugin startup);
- When a new version is detected, the settings tab shows a 🔴 red dot; enter the "Version" page and click "Update to v26081302";
- After updating you **must restart dsh web then refresh the browser** (only refreshing the page won't load the new code);
- After updating the plugin is in detached HEAD (following the release tag): keep using the "Version" page's update button to upgrade, **do not `git pull` directly**;
- To return to the dev track: `git checkout main && git pull --ff-only`.

**Update safety mechanism**: only accepts tags in strict format (v<pure digits> or v1.2.3) that sit in origin/main history; verifies the local worktree is clean before updating; the update process has a cross-process lock and rollback on failure, never leaving you a half-updated state.

---

## Three Principles

1. **AI only proposes, you confirm**: AI-created memory, todos, and skills all enter the pending-confirmation queue first — every write that actually changes AI behavior is yours to decide;
2. **Don't reinvent the wheel**: don't touch capabilities the official product already has, only build what the official product hasn't done and genuinely solves a pain point;
3. **Inside vs outside, complementary collaboration**: internal sessions handle context-heavy work, external agents handle one-shot heavy work; memory, rooms, and prompts chain them into a pipeline.
