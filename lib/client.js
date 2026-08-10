window.__ModuleLoader__.load({ id: "dsh-memory-evolve", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  dshMobile: () => dshMobile,
  en: () => en,
  inject: () => inject,
  zh: () => zh
});
module.exports = __toCommonJS(index_exports);

// src/client/MemoryTabView.tsx
var import_react2 = require("react");

// src/client/MemoryQueueView.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
function todoTargetLabel(t2, target) {
  const track = target.slice(5);
  if (track === "life") return `\u5F85\u529E\xB7${t2("todo.track.life")}`;
  if (track === "work") return `\u5F85\u529E\xB7${t2("todo.track.work")}`;
  if (track === "project") return `\u5F85\u529E\xB7${t2("todo.track.project")}`;
  if (track === "daily") return `\u5F85\u529E\xB7${t2("todo.track.daily")}`;
  return target;
}
function suggestTargetLabel(t2, target) {
  if (target.startsWith("todo-")) return todoTargetLabel(t2, target);
  if (target === "memory") return t2("panel.suggestions.target.memory");
  if (target === "user") return t2("panel.suggestions.target.user");
  if (target === "key") return t2("panel.suggestions.target.key");
  return target;
}
function suggestTargetClass(target) {
  return target.startsWith("todo-") ? "todo" : target;
}
var SUGGEST_TARGETS = ["memory", "user", "key"];
async function api(path, init) {
  const res = await fetch(`/memory-evolve${path}`, {
    headers: { "content-type": "application/json" },
    ...init
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}
function summarizeReport(report) {
  const head = report.lines?.join("\uFF1B") ?? `\u5DF2\u5904\u7406 ${report.removed ?? 0} \u6761`;
  return `${head}\uFF08\u5269\u4F59 ${report.remaining} \u6761\uFF09`;
}
function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}
function MemoryQueueView(props) {
  const { t: t2, feature, onChanged } = props;
  const [entries, setEntries] = (0, import_react.useState)(null);
  const [skills, setSkills] = (0, import_react.useState)(null);
  const [config, setConfig] = (0, import_react.useState)(null);
  const [draft, setDraft] = (0, import_react.useState)(null);
  const [edits, setEdits] = (0, import_react.useState)({});
  const [targetPicks, setTargetPicks] = (0, import_react.useState)({});
  const [notice, setNotice] = (0, import_react.useState)(null);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const load = () => {
    void Promise.all([
      api("/api/suggestions"),
      api("/api/pending-skills"),
      api("/api/config")
    ]).then(([s, sk, c]) => {
      const sorted = [...s.entries].sort((a, b) => (b.hits ?? 1) - (a.hits ?? 1));
      setEntries(sorted);
      setSkills(sk.entries);
      setEdits({});
      setTargetPicks({});
      setConfig(c.config);
      setDraft((prev) => prev ?? c.config);
    }).catch((error) => {
      setNotice({ kind: "error", text: t2("panel.config.failed", { message: error.message }) });
    });
  };
  (0, import_react.useEffect)(() => {
    load();
  }, []);
  const runSuggestions = (op, indices) => {
    setBusy(true);
    const body = {};
    body.indices = indices;
    if (op === "approve") {
      const contents = indices.map((index) => edits[index] ?? "");
      if (contents.some((content) => content !== "")) body.contents = contents;
      const overrides = {};
      for (const index of indices) {
        const pick3 = targetPicks[index];
        if (pick3 !== void 0 && pick3 !== entries?.[index - 1]?.target) overrides[String(index)] = pick3;
      }
      if (Object.keys(overrides).length > 0) body.targets = overrides;
    }
    void api(`/api/suggestions/${op}`, {
      method: "POST",
      body: JSON.stringify(body)
    }).then((report) => {
      setNotice({ kind: "ok", text: summarizeReport(report) });
      load();
      onChanged();
    }).catch((error) => {
      setNotice({ kind: "error", text: t2("panel.config.failed", { message: error.message }) });
    }).finally(() => setBusy(false));
  };
  const runSkill = (op, name) => {
    setBusy(true);
    void api(`/api/pending-skills/${op}`, {
      method: "POST",
      body: JSON.stringify({ name })
    }).then(() => {
      setNotice({ kind: "ok", text: t2("panel.skills.done", { op: op === "approve" ? t2("panel.skills.approve") : t2("panel.skills.reject") }) });
      load();
      onChanged();
    }).catch((error) => {
      setNotice({ kind: "error", text: t2("panel.config.failed", { message: error.message }) });
    }).finally(() => setBusy(false));
  };
  const saveConfig = () => {
    if (draft === null) return;
    setBusy(true);
    const patch = {
      reviewEnabled: draft.reviewEnabled,
      reviewInterval: draft.reviewInterval,
      skillReviewEnabled: draft.skillReviewEnabled,
      perTurnProjectWrites: draft.perTurnProjectWrites,
      perTurnDailyWrites: draft.perTurnDailyWrites,
      perTurnKeyWrites: draft.perTurnKeyWrites,
      searchDocsEnabled: draft.searchDocsEnabled,
      searchDocsMode: draft.searchDocsMode,
      coiEnabled: draft.coiEnabled,
      broadcastEnabled: draft.broadcastEnabled,
      sessionSearchEnabled: draft.sessionSearchEnabled,
      sessionEnabled: draft.sessionEnabled,
      scratchEnabled: draft.scratchEnabled,
      promptsEnabled: draft.promptsEnabled,
      modelsEnabled: draft.modelsEnabled,
      uiSettingsEnabled: draft.uiSettingsEnabled,
      bookmarkEnabled: draft.bookmarkEnabled,
      notifyEnabled: draft.notifyEnabled
    };
    void api("/api/config", {
      method: "POST",
      body: JSON.stringify({ patch })
    }).then((res) => {
      setConfig(res.config);
      setDraft(res.config);
      setNotice({ kind: "ok", text: t2("panel.config.saved") });
    }).catch((error) => {
      setNotice({ kind: "error", text: t2("panel.config.failed", { message: error.message }) });
    }).finally(() => setBusy(false));
  };
  const patchDraft = (patch) => {
    setDraft((prev) => prev === null ? prev : { ...prev, ...patch });
  };
  const suggestionRows = (entries ?? []).map((entry, index) => ({ entry, index: index + 1 })).filter(({ entry }) => feature === "todo-suggestions" ? entry.target.startsWith("todo-") : !entry.target.startsWith("todo-"));
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-panel", children: [
    notice !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: `me-notice me-notice-${notice.kind}`, children: notice.text }),
    feature === "guide" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "me-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "me-block-head", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "me-heading", children: t2("panel.guide.title") }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-help", children: t2("panel.guide.intro") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-guide", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-guide-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-guide-icon", children: "\u{1F9E0}" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-guide-body", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t2("panel.guide.memory.title") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t2("panel.guide.memory.desc") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-guide-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-guide-icon", children: "\u{1F504}" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-guide-body", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t2("panel.guide.review.title") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t2("panel.guide.review.desc") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-guide-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-guide-icon", children: "\u2705" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-guide-body", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t2("panel.guide.todo.title") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t2("panel.guide.todo.desc") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-guide-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-guide-icon", children: "\u{1F6E0}\uFE0F" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-guide-body", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t2("panel.guide.skill.title") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t2("panel.guide.skill.desc") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-guide-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-guide-icon", children: "\u{1F50D}" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-guide-body", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t2("panel.guide.search.title") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t2("panel.guide.search.desc") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-guide-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-guide-icon", children: "\u{1F680}" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-guide-body", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t2("panel.guide.coi.title") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t2("panel.guide.coi.desc") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-guide-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-guide-icon", children: "\u{1F4CC}" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-guide-body", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t2("panel.guide.prompt.title") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t2("panel.guide.prompt.desc") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-guide-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-guide-icon", children: "\u{1F9E9}" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-guide-body", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t2("panel.guide.models.title") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t2("panel.guide.models.desc") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-guide-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-guide-icon", children: "\u{1F4E8}" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-guide-body", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t2("panel.guide.broadcast.title") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t2("panel.guide.broadcast.desc") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-guide-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-guide-icon", children: "\u{1F4E1}" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-guide-body", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t2("panel.guide.session.title") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t2("panel.guide.session.desc") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-guide-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-guide-icon", children: "\u{1F9ED}" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-guide-body", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t2("panel.guide.sessionOrch.title") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t2("panel.guide.sessionOrch.desc") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-guide-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-guide-icon", children: "\u{1F3A8}" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-guide-body", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t2("panel.guide.uiSettings.title") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t2("panel.guide.uiSettings.desc") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-guide-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-guide-icon", children: "\u2B50" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-guide-body", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t2("panel.guide.bookmark.title") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t2("panel.guide.bookmark.desc") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-guide-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-guide-icon", children: "\u{1F6E1}\uFE0F" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-guide-body", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t2("panel.guide.confirm.title") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t2("panel.guide.confirm.desc") })
          ] })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { className: "me-guide-sub", children: t2("panel.guide.best.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("ul", { className: "me-guide-tips", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: t2("panel.guide.best.1") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: t2("panel.guide.best.2") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: t2("panel.guide.best.3") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: t2("panel.guide.best.4") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-guide-loop", children: t2("panel.guide.loop") })
    ] }),
    (feature === "suggestions" || feature === "todo-suggestions") && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "me-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-block-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "me-heading", children: feature === "todo-suggestions" ? t2("panel.todoSuggestions.title") : t2("panel.suggestions.title") }),
        suggestionRows.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-count", children: suggestionRows.length })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-help", children: feature === "todo-suggestions" ? t2("panel.todoSuggestions.help") : t2("panel.suggestions.help") }),
      entries === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-muted", children: t2("panel.loading") }) : suggestionRows.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-empty", children: feature === "todo-suggestions" ? t2("panel.todoSuggestions.empty") : t2("panel.suggestions.empty") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "me-list", children: suggestionRows.map(({ entry, index }) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: "me-item", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-item-head", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "span",
              {
                className: `me-badge me-badge-suggest me-badge-suggest-${suggestTargetClass(entry.target)}`,
                title: t2("panel.suggestions.targetHint"),
                children: suggestTargetLabel(t2, entry.target)
              }
            ),
            (entry.hits ?? 1) > 1 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-badge me-badge-hits", title: t2("panel.suggestions.hitsHint"), children: t2("panel.suggestions.hits", { count: entry.hits ?? 1 }) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-item-time", title: entry.time, children: formatTime(entry.time) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-item-actions", children: [
              !entry.target.startsWith("todo-") && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "select",
                {
                  className: "me-pick-target",
                  title: t2("panel.suggestions.targetHint"),
                  value: targetPicks[index] ?? entry.target,
                  onChange: (event) => setTargetPicks((prev) => ({ ...prev, [index]: event.target.value })),
                  children: SUGGEST_TARGETS.map((target) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: target, children: suggestTargetLabel(t2, target) }, target))
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  className: "me-btn me-btn-ok",
                  disabled: busy,
                  onClick: () => runSuggestions("approve", [index]),
                  children: t2("panel.suggestions.approve")
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  className: "me-btn me-btn-archive",
                  disabled: busy,
                  title: t2("panel.suggestions.archiveHint"),
                  onClick: () => runSuggestions("archive", [index]),
                  children: t2("panel.suggestions.archive")
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  className: "me-btn me-btn-danger",
                  disabled: busy,
                  onClick: () => runSuggestions("reject", [index]),
                  children: t2("panel.suggestions.reject")
                }
              )
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "textarea",
            {
              className: "me-item-edit",
              rows: 3,
              value: edits[index] ?? entry.content,
              onChange: (event) => setEdits((prev) => ({ ...prev, [index]: event.target.value }))
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-item-reason", children: entry.reason !== void 0 && entry.reason !== "" ? entry.reason : t2("panel.suggestions.editHint") })
        ] }, `${entry.time}-${index}`)) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-bulk", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              className: "me-btn me-btn-ok",
              disabled: busy,
              onClick: () => runSuggestions("approve", suggestionRows.map((row) => row.index)),
              children: t2("panel.suggestions.approveAll")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              className: "me-btn me-btn-danger",
              disabled: busy,
              onClick: () => runSuggestions("reject", suggestionRows.map((row) => row.index)),
              children: t2("panel.suggestions.rejectAll")
            }
          )
        ] })
      ] })
    ] }),
    feature === "skills" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "me-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-block-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "me-heading", children: t2("panel.skills.title") }),
        skills !== null && skills.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-count", children: skills.length })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-help", children: t2("panel.skills.help") }),
      skills === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-muted", children: t2("panel.loading") }) : skills.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-empty", children: t2("panel.skills.empty") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "me-list", children: skills.map((skill) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: "me-item", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-item-head", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-badge me-badge-target", children: skill.name }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-item-time", children: t2("panel.skills.pending") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-item-actions", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                className: "me-btn me-btn-ok",
                disabled: busy,
                onClick: () => runSkill("approve", skill.name),
                children: t2("panel.skills.approve")
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                className: "me-btn me-btn-danger",
                disabled: busy,
                onClick: () => runSkill("reject", skill.name),
                children: t2("panel.skills.reject")
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-item-reason", children: skill.description })
      ] }, skill.name)) })
    ] }),
    feature === "config" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "me-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "me-block-head", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "me-heading", children: t2("panel.config.title") }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-help", children: t2("panel.config.help") }),
      draft === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-muted", children: t2("panel.loading") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-form", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-group", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t2("panel.config.reviewEnabled"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t2("panel.config.reviewEnabled.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                className: "me-switch",
                checked: draft.reviewEnabled,
                onChange: (event) => patchDraft({ reviewEnabled: event.target.checked })
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t2("panel.config.reviewInterval"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t2("panel.config.reviewInterval.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "number",
                className: "me-input",
                min: 1,
                value: draft.reviewInterval,
                onChange: (event) => patchDraft({ reviewInterval: Number(event.target.value) })
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "me-group", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
            t2("panel.config.skillReviewEnabled"),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t2("panel.config.skillReviewEnabled.hint") })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "checkbox",
              className: "me-switch",
              checked: draft.skillReviewEnabled,
              onChange: (event) => patchDraft({ skillReviewEnabled: event.target.checked })
            }
          )
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-group", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t2("panel.config.perTurnProjectWrites"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t2("panel.config.perTurnProjectWrites.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                className: "me-switch",
                checked: draft.perTurnProjectWrites,
                onChange: (event) => patchDraft({ perTurnProjectWrites: event.target.checked })
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t2("panel.config.perTurnDailyWrites"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t2("panel.config.perTurnDailyWrites.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                className: "me-switch",
                checked: draft.perTurnDailyWrites,
                onChange: (event) => patchDraft({ perTurnDailyWrites: event.target.checked })
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t2("panel.config.perTurnKeyWrites"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t2("panel.config.perTurnKeyWrites.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                className: "me-switch",
                checked: draft.perTurnKeyWrites,
                onChange: (event) => patchDraft({ perTurnKeyWrites: event.target.checked })
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-group", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t2("panel.config.searchDocsEnabled"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t2("panel.config.searchDocsEnabled.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
              "select",
              {
                className: "me-todo-select",
                value: draft.searchDocsMode ?? (draft.searchDocsEnabled ? "all" : "off"),
                onChange: (event) => {
                  const mode = event.target.value;
                  patchDraft({
                    searchDocsMode: mode,
                    searchDocsEnabled: mode !== "off"
                    // 兼容旧键（驱动注册/卸载）
                  });
                },
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "all", children: t2("panel.config.searchDocsMode.all") }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "filename", children: t2("panel.config.searchDocsMode.filename") }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "content", children: t2("panel.config.searchDocsMode.content") }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "off", children: t2("panel.config.searchDocsMode.off") })
                ]
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t2("panel.config.coiEnabled"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t2("panel.config.coiEnabled.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                className: "me-switch",
                checked: draft.coiEnabled,
                onChange: (event) => patchDraft({ coiEnabled: event.target.checked })
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t2("panel.config.broadcastEnabled"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t2("panel.config.broadcastEnabled.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                className: "me-switch",
                checked: draft.broadcastEnabled,
                onChange: (event) => patchDraft({ broadcastEnabled: event.target.checked })
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t2("panel.config.notifyEnabled"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t2("panel.config.notifyEnabled.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                className: "me-switch",
                checked: draft.notifyEnabled,
                onChange: (event) => patchDraft({ notifyEnabled: event.target.checked })
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t2("panel.config.sessionEnabled"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t2("panel.config.sessionEnabled.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                className: "me-switch",
                checked: draft.sessionEnabled,
                onChange: (event) => patchDraft({ sessionEnabled: event.target.checked })
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t2("panel.config.sessionSearchEnabled"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t2("panel.config.sessionSearchEnabled.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                className: "me-switch",
                checked: draft.sessionSearchEnabled,
                onChange: (event) => patchDraft({ sessionSearchEnabled: event.target.checked })
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t2("panel.config.scratchEnabled"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t2("panel.config.scratchEnabled.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                className: "me-switch",
                checked: draft.scratchEnabled,
                onChange: (event) => patchDraft({ scratchEnabled: event.target.checked })
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t2("panel.config.promptsEnabled"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t2("panel.config.promptsEnabled.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                className: "me-switch",
                checked: draft.promptsEnabled,
                onChange: (event) => patchDraft({ promptsEnabled: event.target.checked })
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t2("panel.config.modelsEnabled"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t2("panel.config.modelsEnabled.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                className: "me-switch",
                checked: draft.modelsEnabled,
                onChange: (event) => patchDraft({ modelsEnabled: event.target.checked })
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t2("panel.config.uiSettingsEnabled"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t2("panel.config.uiSettingsEnabled.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                className: "me-switch",
                checked: draft.uiSettingsEnabled,
                onChange: (event) => patchDraft({ uiSettingsEnabled: event.target.checked })
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t2("panel.config.bookmarkEnabled"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t2("panel.config.bookmarkEnabled.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                className: "me-switch",
                checked: draft.bookmarkEnabled,
                onChange: (event) => patchDraft({ bookmarkEnabled: event.target.checked })
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "me-actions", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "me-btn me-btn-primary", disabled: busy, onClick: saveConfig, children: t2("panel.config.save") }) })
      ] })
    ] })
  ] });
}

// src/client/TabGuideView.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
function TabGuideView({ sections }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "me-panel", children: sections.map((section, index) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "me-block", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "me-block-head", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("h3", { className: "me-heading", children: [
      section.icon,
      " ",
      section.title
    ] }) }),
    section.body !== void 0 && section.body !== "" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "me-help", children: section.body }),
    section.items !== void 0 && section.items.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "me-guide", children: section.items.map((item, itemIndex) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "me-guide-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "me-guide-icon", children: "\u2022" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "me-guide-body", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: item }) })
    ] }, itemIndex)) })
  ] }, index)) });
}

// src/client/MemoryTabView.tsx
var import_jsx_runtime3 = require("react/jsx-runtime");
var ENTRY_DELIMITER = "\n\xA7\n";
var BRANCH_TAG_RE = /(?:^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*)?\[branch:([^\]]*)\]\s*/;
var DSH_ONLY_RE = /\[dsh-only\]\s*/;
var TIME_PREFIX = {
  project: /^\[(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(?::\d{2})?)\]\s*/,
  daily: /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/,
  date: /^\[(\d{4}-\d{2}-\d{2})\]\s*/
};
var ENTRY_KEYS = /* @__PURE__ */ new Set(["memory", "user", "archive-memory", "archive-user", "archive-key", "project", "key", "daily"]);
var EDIT_KEYS = /* @__PURE__ */ new Set(["memory", "user", "project", "key", "daily"]);
var INJECTED_KEYS = /* @__PURE__ */ new Set(["memory", "user", "key"]);
function parseEntries(row) {
  const prefix = row.key === "project" ? TIME_PREFIX.project : row.key === "daily" ? TIME_PREFIX.daily : TIME_PREFIX.date;
  const entries = [];
  for (const raw of row.content.split(ENTRY_DELIMITER)) {
    let text = raw.trim();
    if (text === "") continue;
    const rawText = text;
    let time = null;
    let tag = null;
    let branch = null;
    let branches = null;
    let dshOnly = false;
    const timeMatch = prefix.exec(text);
    if (timeMatch !== null) {
      time = timeMatch[1];
      text = text.slice(timeMatch[0].length);
      if (row.key === "daily" || row.key === "project") {
        const gitMatch = /^\[git ([^\]]+)\]\s*/.exec(text);
        if (gitMatch !== null) {
          branch = gitMatch[1];
          text = text.slice(gitMatch[0].length);
        }
      }
      if (row.key === "daily") {
        const tagMatch = /^\[([^\]]+)\]\s*/.exec(text);
        if (tagMatch !== null) {
          tag = tagMatch[1];
          text = text.slice(tagMatch[0].length);
        }
      } else if (row.key === "key") {
        const branchMatch = BRANCH_TAG_RE.exec(rawText);
        if (branchMatch !== null) {
          const list = branchMatch[1].split(",").map((b) => b.trim()).filter(Boolean);
          branches = list.length > 0 ? list : null;
          text = text.replace(BRANCH_TAG_RE, "");
        }
      }
      if (DSH_ONLY_RE.test(text)) {
        dshOnly = true;
        text = text.replace(DSH_ONLY_RE, "");
      }
    }
    entries.push({ time, tag, branch, text, branches, dshOnly, raw: rawText });
  }
  return entries;
}
function entryMatches(entry, q) {
  return entry.text.toLowerCase().includes(q) || (entry.time ?? "").toLowerCase().includes(q) || (entry.tag ?? "").toLowerCase().includes(q);
}
var PAGE_SIZE = 50;
async function api2(path, init) {
  const res = await fetch(`/memory-evolve${path}`, {
    headers: { "content-type": "application/json" },
    ...init
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}
var persistedFeature = null;
var persistedFileKey = null;
function memoryGuideSections(t2) {
  return [
    {
      icon: "\u{1F9E0}",
      title: t2("memoryTab.guide.tracks.title"),
      body: t2("memoryTab.guide.tracks.body"),
      items: [
        t2("memoryTab.guide.tracks.item1"),
        t2("memoryTab.guide.tracks.item2"),
        t2("memoryTab.guide.tracks.item3"),
        t2("memoryTab.guide.tracks.item4"),
        t2("memoryTab.guide.tracks.item5")
      ]
    },
    {
      icon: "\u{1F4C2}",
      title: t2("memoryTab.guide.files.title"),
      body: t2("memoryTab.guide.files.body"),
      items: [
        t2("memoryTab.guide.files.item1"),
        t2("memoryTab.guide.files.item2"),
        t2("memoryTab.guide.files.item3")
      ]
    },
    {
      icon: "\u{1F33F}",
      title: t2("memoryTab.guide.branch.title"),
      body: t2("memoryTab.guide.branch.body"),
      items: [
        t2("memoryTab.guide.branch.item1"),
        t2("memoryTab.guide.branch.item2")
      ]
    },
    {
      icon: "\u{1F6E0}\uFE0F",
      title: t2("memoryTab.guide.maintain.title"),
      body: t2("memoryTab.guide.maintain.body"),
      items: [
        t2("memoryTab.guide.maintain.item1"),
        t2("memoryTab.guide.maintain.item2"),
        t2("memoryTab.guide.maintain.item3")
      ]
    },
    {
      icon: "\u2705",
      title: t2("memoryTab.guide.suggestions.title"),
      body: t2("memoryTab.guide.suggestions.body"),
      items: [
        t2("memoryTab.guide.suggestions.item1"),
        t2("memoryTab.guide.suggestions.item2")
      ]
    },
    {
      icon: "\u{1F6E1}\uFE0F",
      title: t2("memoryTab.guide.confirm.title"),
      body: t2("memoryTab.guide.confirm.body")
    }
  ];
}
function MemoryTabView(props) {
  const { sessionId, t: t2 } = props;
  const [files, setFiles] = (0, import_react2.useState)(null);
  const [notice, setNotice] = (0, import_react2.useState)(null);
  const [cwd, setCwd] = (0, import_react2.useState)(null);
  const [branch, setBranch] = (0, import_react2.useState)(null);
  const [branches, setBranches] = (0, import_react2.useState)([]);
  const [view, setView] = (0, import_react2.useState)("pretty");
  const [query, setQuery] = (0, import_react2.useState)("");
  const [page, setPage] = (0, import_react2.useState)(0);
  const [activeKey, setActiveKey] = (0, import_react2.useState)(persistedFileKey);
  const [keyDraft, setKeyDraft] = (0, import_react2.useState)("");
  const [keySaving, setKeySaving] = (0, import_react2.useState)(false);
  const [keyDshOnly, setKeyDshOnly] = (0, import_react2.useState)(false);
  const [keyScope, setKeyScope] = (0, import_react2.useState)([]);
  const [scopeEdit, setScopeEdit] = (0, import_react2.useState)(null);
  const [scopeDraft, setScopeDraft] = (0, import_react2.useState)([]);
  const [scopeSaving, setScopeSaving] = (0, import_react2.useState)(false);
  const [editEntryRaw, setEditEntryRaw] = (0, import_react2.useState)(null);
  const [editDraft, setEditDraft] = (0, import_react2.useState)("");
  const [editSaving, setEditSaving] = (0, import_react2.useState)(false);
  const [deleting, setDeleting] = (0, import_react2.useState)(false);
  const [feature, setFeature] = (0, import_react2.useState)(persistedFeature);
  const [badge, setBadge] = (0, import_react2.useState)({ suggestions: 0 });
  const pollBadge = (0, import_react2.useCallback)(() => {
    void api2("/api/badge").then((data) => setBadge({ suggestions: data.suggestions ?? 0 })).catch(() => {
    });
  }, []);
  (0, import_react2.useEffect)(() => {
    pollBadge();
    const timer = window.setInterval(pollBadge, 3e4);
    return () => window.clearInterval(timer);
  }, [pollBadge]);
  (0, import_react2.useEffect)(() => {
    persistedFeature = feature;
  }, [feature]);
  (0, import_react2.useEffect)(() => {
    persistedFileKey = activeKey;
  }, [activeKey]);
  const load = (0, import_react2.useCallback)(() => {
    setFiles(null);
    void api2(
      `/api/memory-files?sessionId=${encodeURIComponent(String(sessionId))}`
    ).then((res) => {
      setFiles(res.files);
      setCwd(res.cwd);
      setBranch(res.branch);
      setBranches(res.branches ?? []);
    }).catch((error) => {
      setNotice({ kind: "error", text: error.message });
      setFiles([]);
    });
  }, [sessionId]);
  (0, import_react2.useEffect)(() => {
    load();
  }, []);
  (0, import_react2.useEffect)(() => {
    if (files === null || files.length === 0) return;
    if (activeKey !== null && files.some((row) => row.key === activeKey)) return;
    const fallback = files.find((row) => row.available) ?? files[0];
    setActiveKey(fallback.key);
  }, [files, activeKey]);
  const flash = (text) => {
    setNotice({ kind: "ok", text });
    window.setTimeout(() => {
      setNotice((current) => current?.text === text ? null : current);
    }, 3500);
  };
  const openWithSystem = (row) => {
    const target = row.key === "memory" ? "memoryFile" : row.key === "user" ? "userFile" : row.key === "daily" ? "dailyFile" : row.key === "project" || row.key === "key" ? "projectsDir" : row.key === "archive-memory" ? "archiveMemoryFile" : row.key === "archive-user" ? "archiveUserFile" : row.key === "archive-key" ? "projectsDir" : "agentsFile";
    void api2("/api/reveal", { method: "POST", body: JSON.stringify({ target }) }).then(() => flash(t2("memoryTab.opened"))).catch((error) => setNotice({ kind: "error", text: error.message }));
  };
  const saveKey = () => {
    const content = keyDraft.trim();
    if (content === "" || keySaving) return;
    setKeySaving(true);
    void api2("/api/memory/key", {
      method: "POST",
      body: JSON.stringify({ sessionId: String(sessionId), content, branches: keyScope, dshOnly: keyDshOnly })
    }).then(() => {
      setKeyDraft("");
      setKeyDshOnly(false);
      load();
      flash(t2("memoryTab.keyAdded"));
    }).catch((error) => {
      setNotice({ kind: "error", text: error.message });
    }).finally(() => setKeySaving(false));
  };
  const toggleScopeBranch = (b) => {
    setScopeDraft((prev) => prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b]);
  };
  const toggleKeyScopeBranch = (b) => {
    setKeyScope((prev) => prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b]);
  };
  const openScope = (entry) => {
    setScopeEdit(entry.raw);
    setScopeDraft(entry.branches ?? []);
  };
  const saveScope = () => {
    if (scopeEdit === null || activeRow === null || scopeSaving) return;
    setScopeSaving(true);
    void api2("/api/key/scope", {
      method: "POST",
      body: JSON.stringify({ sessionId: String(sessionId), match: scopeEdit, branches: scopeDraft })
    }).then(() => {
      setScopeEdit(null);
      load();
      flash(t2("memoryTab.keyScopeSaved"));
    }).catch((error) => {
      setNotice({ kind: "error", text: error.message });
    }).finally(() => setScopeSaving(false));
  };
  const toggleDshOnly = (entry) => {
    if (activeRow === null || deleting) return;
    setDeleting(true);
    void api2("/api/memory/dsh-only", {
      method: "POST",
      body: JSON.stringify({
        sessionId: String(sessionId),
        target: activeRow.key,
        match: entry.raw,
        on: !entry.dshOnly
      })
    }).then(() => {
      load();
      flash(entry.dshOnly ? t2("memoryTab.dshOnlyRemoved") : t2("memoryTab.dshOnlySet"));
    }).catch((error) => {
      setNotice({ kind: "error", text: error.message });
    }).finally(() => setDeleting(false));
  };
  const deleteEntry = (entry) => {
    if (activeRow === null || deleting) return;
    const snippet = entry.text.length > 60 ? `${entry.text.slice(0, 60)}\u2026` : entry.text;
    if (!window.confirm(t2("memoryTab.deleteConfirm", { snippet }))) return;
    setDeleting(true);
    void api2("/api/memory/delete", {
      method: "POST",
      body: JSON.stringify({
        sessionId: String(sessionId),
        target: activeRow.key,
        match: entry.raw
      })
    }).then(() => {
      load();
      flash(t2("memoryTab.deleted"));
    }).catch((error) => {
      setNotice({ kind: "error", text: error.message });
    }).finally(() => setDeleting(false));
  };
  const startEdit = (entry) => {
    setEditEntryRaw(entry.raw);
    setEditDraft(entry.text);
  };
  const saveEdit = () => {
    if (editEntryRaw === null || activeRow === null || editSaving) return;
    const content = editDraft.trim();
    if (content === "") return;
    if (INJECTED_KEYS.has(activeRow.key)) {
      const snippet = content.length > 60 ? `${content.slice(0, 60)}\u2026` : content;
      if (!window.confirm(t2("memoryTab.editConfirm", { snippet }))) return;
    }
    setEditSaving(true);
    void api2("/api/memory/update", {
      method: "POST",
      body: JSON.stringify({
        sessionId: String(sessionId),
        target: activeRow.key,
        match: editEntryRaw,
        content: editDraft
      })
    }).then(() => {
      setEditEntryRaw(null);
      load();
      flash(t2("memoryTab.updated"));
    }).catch((error) => {
      setNotice({ kind: "error", text: error.message });
    }).finally(() => setEditSaving(false));
  };
  const moveEntry = (entry, op) => {
    if (activeRow === null || deleting) return;
    if (op === "archive") {
      const snippet = entry.text.length > 60 ? `${entry.text.slice(0, 60)}\u2026` : entry.text;
      if (!window.confirm(t2("memoryTab.archiveConfirm", { snippet }))) return;
    }
    setDeleting(true);
    const path = op === "archive" ? "/api/memory/archive" : "/api/archive/promote";
    const target = op === "archive" ? activeRow.key : activeRow.key === "archive-memory" ? "memory" : activeRow.key === "archive-key" ? "key" : "user";
    void api2(path, {
      method: "POST",
      body: JSON.stringify({ sessionId: String(sessionId), target, match: entry.raw })
    }).then(() => {
      load();
      flash(op === "archive" ? t2("memoryTab.archived") : t2("memoryTab.promoted"));
    }).catch((error) => {
      setNotice({ kind: "error", text: error.message });
    }).finally(() => setDeleting(false));
  };
  const q = query.trim().toLowerCase();
  const activeRow = (files ?? []).find((row) => row.key === activeKey) ?? null;
  let activeEntries = null;
  let activeHidden = false;
  if (activeRow !== null && activeRow.available && activeRow.exists) {
    if (view === "raw" || !ENTRY_KEYS.has(activeRow.key)) {
      activeHidden = q !== "" && !activeRow.content.toLowerCase().includes(q);
    } else {
      const all = parseEntries(activeRow);
      activeEntries = q === "" ? all : all.filter((entry) => entryMatches(entry, q));
      activeHidden = q !== "" && activeEntries.length === 0;
    }
  }
  const pageCount = activeEntries === null ? 1 : Math.max(1, Math.ceil(activeEntries.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageEntries = activeEntries === null ? null : [...activeEntries].reverse().slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "mt-panel", children: [
    notice !== null && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: `mt-notice mt-notice-${notice.kind}`, children: notice.text }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "mt-file-tabs", role: "tablist", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "guide",
          className: feature === "guide" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature(feature === "guide" ? null : "guide"),
          children: t2("memoryTab.feature.guide")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "suggestions",
          className: feature === "suggestions" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature(feature === "suggestions" ? null : "suggestions"),
          children: [
            t2("memoryTab.feature.suggestions"),
            badge.suggestions > 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "mt-feature-count", children: badge.suggestions })
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "mt-tab-sep", role: "presentation" }),
      files !== null && (files ?? []).map((row) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": row.key === activeKey,
          className: row.key === activeKey ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => {
            setActiveKey(row.key);
            setFeature(null);
            setPage(0);
          },
          children: row.title
        },
        row.key
      ))
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("p", { className: "mt-warning", children: [
      "\u26A0\uFE0F ",
      t2("memoryTab.warning")
    ] }),
    cwd !== null && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("p", { className: "mt-cwd", children: [
      t2("memoryTab.cwd"),
      ": ",
      cwd
    ] }),
    feature !== null ? feature === "guide" ? (
      // 记忆专属指南：详细介绍记忆 Tab 自己的功能（五轨/文件页签/分支/
      // 编辑维护/待确认建议机制）。整体插件指南在「Memory Evolve 设置」Tab。
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(TabGuideView, { sections: memoryGuideSections(t2) })
    ) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
      MemoryQueueView,
      {
        t: t2,
        feature: "suggestions",
        onChanged: () => {
          pollBadge();
          window.dispatchEvent(new CustomEvent("dsh-memory-evolve:badge-change"));
        }
      }
    ) : files === null ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "mt-muted", children: t2("memoryTab.loading") }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "mt-toolbar", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "mt-view-toggle", role: "group", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
            "button",
            {
              type: "button",
              className: view === "pretty" ? "mt-view-btn mt-view-btn-active" : "mt-view-btn",
              onClick: () => setView("pretty"),
              children: t2("memoryTab.viewPretty")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
            "button",
            {
              type: "button",
              className: view === "raw" ? "mt-view-btn mt-view-btn-active" : "mt-view-btn",
              onClick: () => setView("raw"),
              children: t2("memoryTab.viewRaw")
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "input",
          {
            type: "search",
            className: "mt-search",
            value: query,
            placeholder: t2("memoryTab.searchPlaceholder"),
            onChange: (event) => {
              setQuery(event.target.value);
              setPage(0);
            }
          }
        )
      ] }),
      q !== "" && activeHidden && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "mt-empty", children: t2("memoryTab.noResults") }),
      activeRow !== null && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "mt-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "mt-card-head", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "mt-card-title", children: activeRow.title }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "mt-badge mt-badge-ro", children: t2("memoryTab.readonly") }),
          activeEntries !== null && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "mt-badge mt-badge-count", children: t2("memoryTab.entryCount", { count: activeEntries.length }) }),
          activeRow.path !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "mt-card-path", title: activeRow.path, children: activeRow.path }),
          activeRow.available && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "mt-card-actions", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "mt-btn", onClick: () => openWithSystem(activeRow), children: t2("memoryTab.open") }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("p", { className: "mt-card-desc", children: [
          t2(`memoryTab.desc.${activeRow.key}`),
          activeRow.key === "key" && branch !== null && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "mt-card-desc-branch", children: [
            " ",
            t2("memoryTab.keyBranchInfo", { branch })
          ] })
        ] }),
        activeRow.key === "key" && activeRow.available && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "mt-key-add", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
            "textarea",
            {
              className: "mt-key-input",
              rows: 2,
              value: keyDraft,
              placeholder: t2("memoryTab.keyAddPlaceholder"),
              onChange: (event) => setKeyDraft(event.target.value)
            }
          ),
          branches.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "mt-key-scope", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "mt-key-scope-label", children: [
              t2("memoryTab.keyScope"),
              ":"
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { className: "mt-scope-opt", children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                "input",
                {
                  type: "checkbox",
                  checked: keyScope.length === 0,
                  onChange: () => setKeyScope([])
                }
              ),
              t2("memoryTab.keyScopeAll")
            ] }),
            branches.map((b) => /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { className: "mt-scope-opt", children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                "input",
                {
                  type: "checkbox",
                  checked: keyScope.includes(b),
                  onChange: () => toggleKeyScopeBranch(b)
                }
              ),
              b
            ] }, b))
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "mt-key-add-foot", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "mt-key-help", children: t2("memoryTab.keyAddHelp") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { className: "mt-key-dsh-opt", title: t2("memoryTab.dshOnlyHint"), children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                "input",
                {
                  type: "checkbox",
                  checked: keyDshOnly,
                  onChange: (event) => setKeyDshOnly(event.target.checked)
                }
              ),
              t2("memoryTab.dshOnlyAdd")
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
              "button",
              {
                type: "button",
                className: "mt-btn mt-btn-primary",
                disabled: keySaving || keyDraft.trim() === "",
                onClick: saveKey,
                children: t2("memoryTab.keyAdd")
              }
            )
          ] })
        ] }),
        !activeRow.available ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "mt-muted", children: t2("memoryTab.noCwd") }) : !activeRow.exists ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("pre", { className: "mt-content", children: t2("memoryTab.empty") }) : activeEntries === null ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("pre", { className: "mt-content", children: activeRow.content }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "mt-entries", children: (pageEntries ?? []).map((entry, index) => /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "mt-entry", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "mt-entry-head", children: [
            entry.time !== null && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "mt-entry-time", children: entry.time }),
            entry.branch !== null && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "mt-entry-branch mt-entry-branch-tag", title: t2("memoryTab.gitBranch"), children: entry.branch }),
            entry.tag !== null && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "mt-entry-tag", title: t2("memoryTab.projectTag"), children: entry.tag }),
            entry.dshOnly && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "mt-entry-dsh-only", title: t2("memoryTab.dshOnlyHint"), children: [
              "\u{1F512} ",
              t2("memoryTab.dshOnly")
            ] }),
            activeRow.key === "key" && branches.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
              "button",
              {
                type: "button",
                className: entry.branches === null ? "mt-entry-branch mt-entry-branch-all" : "mt-entry-branch",
                title: entry.branches === null ? t2("memoryTab.keyScopeAllHint") : t2("memoryTab.keyScopeHint"),
                onClick: () => openScope(entry),
                children: [
                  t2("memoryTab.keyScopeLabel"),
                  ": ",
                  entry.branches === null ? t2("memoryTab.keyScopeAll") : entry.branches.join(", "),
                  " \u25BE"
                ]
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "mt-entry-ops", children: [
              (activeRow.key === "memory" || activeRow.key === "user" || activeRow.key === "key") && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                "button",
                {
                  type: "button",
                  className: "mt-btn mt-entry-op",
                  title: t2("memoryTab.archive"),
                  disabled: deleting,
                  onClick: () => moveEntry(entry, "archive"),
                  children: t2("memoryTab.archive")
                }
              ),
              (activeRow.key === "archive-memory" || activeRow.key === "archive-user" || activeRow.key === "archive-key") && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                "button",
                {
                  type: "button",
                  className: "mt-btn mt-entry-op",
                  title: t2("memoryTab.promote"),
                  disabled: deleting,
                  onClick: () => moveEntry(entry, "promote"),
                  children: t2("memoryTab.promote")
                }
              ),
              EDIT_KEYS.has(activeRow.key) && editEntryRaw !== entry.raw && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                "button",
                {
                  type: "button",
                  className: "mt-btn mt-entry-op",
                  title: t2("memoryTab.edit"),
                  disabled: deleting,
                  onClick: () => startEdit(entry),
                  children: t2("memoryTab.edit")
                }
              ),
              (activeRow.key === "memory" || activeRow.key === "user" || activeRow.key === "key") && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                "button",
                {
                  type: "button",
                  className: `mt-btn mt-entry-op${entry.dshOnly ? " mt-entry-dsh-on" : ""}`,
                  title: t2("memoryTab.dshOnlyToggleHint"),
                  disabled: deleting,
                  onClick: () => toggleDshOnly(entry),
                  children: entry.dshOnly ? t2("memoryTab.dshOnlyOff") : t2("memoryTab.dshOnlyOn")
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                "button",
                {
                  type: "button",
                  className: "mt-btn mt-entry-del",
                  title: t2("memoryTab.delete"),
                  disabled: deleting,
                  onClick: () => deleteEntry(entry),
                  children: t2("memoryTab.delete")
                }
              )
            ] })
          ] }),
          editEntryRaw === entry.raw ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "mt-entry-edit", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
              "textarea",
              {
                className: "mt-item-edit",
                rows: 3,
                value: editDraft,
                onChange: (event) => setEditDraft(event.target.value.replaceAll("\xA7", ""))
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "mt-entry-edit-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "mt-entry-edit-hint", children: t2("memoryTab.editHint") }),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                "button",
                {
                  type: "button",
                  className: "mt-btn mt-btn-primary",
                  disabled: editSaving || editDraft.trim() === "",
                  onClick: saveEdit,
                  children: t2("memoryTab.save")
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "mt-btn", disabled: editSaving, onClick: () => setEditEntryRaw(null), children: t2("memoryTab.cancel") })
            ] })
          ] }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "mt-entry-text", children: entry.text }),
          activeRow.key === "key" && scopeEdit === entry.raw && branches.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "mt-scope", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "mt-key-scope-label", children: [
              t2("memoryTab.keyScope"),
              ":"
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { className: "mt-scope-opt", children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                "input",
                {
                  type: "checkbox",
                  checked: scopeDraft.length === 0,
                  onChange: () => setScopeDraft([])
                }
              ),
              t2("memoryTab.keyScopeAll"),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("em", { className: "mt-scope-all-hint", children: t2("memoryTab.keyScopeAllWeight") })
            ] }),
            branches.map((b) => /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { className: "mt-scope-opt", children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                "input",
                {
                  type: "checkbox",
                  checked: scopeDraft.includes(b),
                  onChange: () => toggleScopeBranch(b)
                }
              ),
              b
            ] }, b)),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "mt-scope-actions", children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                "button",
                {
                  type: "button",
                  className: "mt-btn mt-btn-primary",
                  disabled: scopeSaving,
                  onClick: saveScope,
                  children: t2("memoryTab.keyScopeSave")
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "mt-btn", disabled: scopeSaving, onClick: () => setScopeEdit(null), children: t2("memoryTab.keyScopeCancel") })
            ] })
          ] })
        ] }, index)) }),
        activeEntries !== null && pageCount > 1 && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "mt-pager", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
            "button",
            {
              type: "button",
              className: "mt-btn",
              disabled: safePage <= 0,
              onClick: () => setPage(safePage - 1),
              children: t2("memoryTab.pagePrev")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "mt-pager-info", children: t2("memoryTab.pageInfo", { page: safePage + 1, total: pageCount, count: activeEntries.length }) }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
            "button",
            {
              type: "button",
              className: "mt-btn",
              disabled: safePage >= pageCount - 1,
              onClick: () => setPage(safePage + 1),
              children: t2("memoryTab.pageNext")
            }
          )
        ] }),
        activeRow.truncated && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "mt-muted", children: t2("memoryTab.truncated") })
      ] })
    ] })
  ] });
}

// src/client/SkillsTabView.tsx
var import_react4 = require("react");

// src/client/skills-browser/SkillsBrowser.tsx
var import_react3 = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime4 = require("react/jsx-runtime");
var API = "/skills-manager/api";
var LS_KEY = "skills-manager.state.v1";
var ApiFailure = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};
async function request(input, init = {}) {
  let res;
  try {
    res = await fetch(input, init);
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiFailure(0, err instanceof Error ? err.message : String(err));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiFailure(res.status, typeof data.error === "string" ? data.error : `HTTP ${res.status}`);
  }
  return data;
}
function basename(p) {
  const trimmed = p.replace(/\/+$/, "");
  if (trimmed === "") return "/";
  const idx = trimmed.lastIndexOf("/");
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}
function joinPath(dir, name) {
  const base = dir.replace(/\/+$/, "");
  return base === "" ? `/${name}` : `${base}/${name}`;
}
function relOf(root, abs) {
  if (abs === root) return "";
  const prefix = root === "/" ? "/" : `${root}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : "";
}
function formatSize(t2, size) {
  if (size == null) return "";
  if (size < 1024) return t2("bytes", { size });
  if (size < 1024 * 1024) return t2("kib", { size: (size / 1024).toFixed(1) });
  return t2("mib", { size: (size / 1024 / 1024).toFixed(1) });
}
function formatTime2(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function sourceClass(source) {
  if (source.startsWith("user")) return " sb-badge--user";
  if (source.startsWith("project")) return " sb-badge--project";
  if (source === "bundled") return " sb-badge--bundled";
  return " sb-badge--other";
}
function ResourceIcon({ skill }) {
  const rb = skill.resourceBase;
  if (rb?.kind === "directory") return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconFolderOpen16, { className: "sb-card-meta-icon" });
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconDataOutline16, { className: "sb-card-meta-icon" });
}
var PAGE_SIZE2 = 20;
function SkillList(props) {
  const {
    t: t2,
    skills,
    loading,
    error,
    query,
    sourceFilter,
    sourceCounts,
    statusFilter,
    selectedName,
    togglingName,
    page,
    onSourceFilter,
    onStatusFilter,
    onToggleDisabled,
    onSelect,
    onRetry,
    onPrevPage,
    onNextPage
  } = props;
  const filtered = (0, import_react3.useMemo)(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (sourceFilter !== "all" && s.source !== sourceFilter) return false;
      const available = s.invocable && !s.disabled;
      if (statusFilter === "enabled" && !available) return false;
      if (statusFilter === "disabled" && available) return false;
      if (q === "") return true;
      return `${s.name} ${s.description} ${s.whenToUse ?? ""}`.toLowerCase().includes(q);
    });
  }, [skills, query, sourceFilter, statusFilter]);
  const totalCount = sourceCounts.reduce((sum, entry) => sum + entry.count, 0);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE2));
  const pageSafe = Math.min(Math.max(1, page), pageCount);
  const paged = filtered.slice((pageSafe - 1) * PAGE_SIZE2, pageSafe * PAGE_SIZE2);
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-section sb-section--skills", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-pane-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-pane-title", children: t2("pane.skills") }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-count", children: t2("skills.count", { count: filtered.length }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-chips", children: [
      sourceCounts.length > 1 && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(import_jsx_runtime4.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
          "button",
          {
            type: "button",
            className: `sb-chip${sourceFilter === "all" ? " sb-chip--active" : ""}`,
            onClick: () => onSourceFilter("all"),
            children: [
              t2("filter.all"),
              " ",
              totalCount
            ]
          }
        ),
        sourceCounts.map(({ source, count }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
          "button",
          {
            type: "button",
            className: `sb-chip${sourceFilter === source ? " sb-chip--active" : ""}`,
            onClick: () => onSourceFilter(source),
            children: [
              source,
              " ",
              count
            ]
          },
          source
        )),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-chips-sep" })
      ] }),
      ["all", "enabled", "disabled"].map((status) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "button",
        {
          type: "button",
          className: `sb-chip${statusFilter === status ? " sb-chip--active" : ""}`,
          onClick: () => onStatusFilter(status),
          children: status === "all" ? t2("filter.all") : status === "enabled" ? t2("status.enabled") : t2("disabled.badge")
        },
        status
      ))
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-list", children: [
      loading && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-note", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconLoadingOutline16, { className: "sb-spin" }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { children: t2("loading.skills") })
      ] }),
      !loading && error !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-note sb-note--error", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconWarningOutline16, {}),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { children: error }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "sb-btn sb-btn--ghost", onClick: onRetry, children: t2("refresh") })
      ] }),
      !loading && error === null && filtered.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "sb-note", children: t2("search.empty") }),
      !loading && error === null && paged.map((skill) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
        "button",
        {
          type: "button",
          className: `sb-card${skill.name === selectedName ? " sb-card--active" : ""}${skill.disabled ? " sb-card--disabled" : ""}`,
          onClick: () => onSelect(skill),
          title: skill.disabled ? t2("disabled.hint") : void 0,
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "sb-card-top", children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-card-name", children: skill.name }),
              skill.disabled && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-badge sb-badge--disabled", children: t2("disabled.badge") }),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: `sb-badge${sourceClass(skill.source)}`, children: t2("source.badge", { source: skill.source }) })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-card-desc", children: skill.description }),
            /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "sb-card-meta", children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(ResourceIcon, { skill }),
              skill.whenToUse !== null && skill.whenToUse !== "" && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "sb-card-when", children: [
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-card-when-label", children: t2("when.to.use") }),
                skill.whenToUse
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-spacer" }),
              skill.protected ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-badge sb-badge--protected", title: t2("protected.hint"), children: t2("protected.badge") }) : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                "span",
                {
                  className: `sb-toggle${skill.disabled ? " sb-toggle--disabled" : ""}`,
                  role: "button",
                  tabIndex: 0,
                  title: skill.disabled ? t2("enable") : t2("disable"),
                  onClick: (e) => {
                    e.stopPropagation();
                    onToggleDisabled(skill);
                  },
                  onKeyDown: (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      onToggleDisabled(skill);
                    }
                  },
                  children: togglingName === skill.name ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconLoadingOutline16, { className: "sb-spin" }) : skill.disabled ? t2("enable") : t2("disable")
                }
              )
            ] })
          ]
        },
        skill.name
      ))
    ] }),
    pageCount > 1 && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-pager", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "button",
        {
          type: "button",
          className: "sb-btn sb-btn--ghost",
          disabled: pageSafe <= 1,
          onClick: onPrevPage,
          children: t2("pager.prev")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-pager-info", children: t2("pager.page", { page: pageSafe, total: pageCount }) }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "button",
        {
          type: "button",
          className: "sb-btn sb-btn--ghost",
          disabled: pageSafe >= pageCount,
          onClick: onNextPage,
          children: t2("pager.next")
        }
      )
    ] })
  ] });
}
function FileTree(props) {
  const {
    t: t2,
    hasSkill,
    root,
    rootOptions,
    cache,
    loadingDirs,
    dirErrors,
    expanded,
    selectedPath,
    crumbs,
    onRootChange,
    onJump,
    onToggleDir,
    onFileClick,
    onRetryDir
  } = props;
  const renderEntries = (dirAbs, depth) => {
    const indent = { paddingLeft: 8 + depth * 14 };
    if (loadingDirs.has(dirAbs)) {
      return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-tree-note", style: indent, children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconLoadingOutline16, { className: "sb-spin" }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { children: t2("loading.dir") })
      ] });
    }
    const dirError = dirErrors.get(dirAbs);
    if (dirError !== void 0) {
      return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-tree-note sb-note--error", style: indent, children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconWarningOutline16, {}),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-tree-errmsg", title: dirError, children: dirError }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "sb-tree-retry", onClick: () => onRetryDir(dirAbs), children: t2("refresh") })
      ] });
    }
    const entries = cache.get(dirAbs);
    if (entries === void 0) return null;
    if (entries.length === 0) {
      return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "sb-tree-note", style: indent, children: t2("no.entries") });
    }
    return entries.map((entry) => {
      const abs = joinPath(dirAbs, entry.name);
      if (entry.type === "dir") {
        const isOpen = expanded.has(abs);
        return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
            "button",
            {
              type: "button",
              className: "sb-tree-row",
              style: indent,
              onClick: () => onToggleDir(abs),
              title: abs,
              children: [
                isOpen ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconChevronDownOutline14, {}) : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconChevronRightOutline14, {}),
                isOpen ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconFolderOpen16, {}) : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconFolderClose16, {}),
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-tree-name", children: entry.name })
              ]
            }
          ),
          isOpen && renderEntries(abs, depth + 1)
        ] }, abs);
      }
      return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
        "button",
        {
          type: "button",
          className: `sb-tree-row sb-tree-row--file${abs === selectedPath ? " sb-tree-row--active" : ""}`,
          style: { paddingLeft: 8 + depth * 14 + 14 },
          onClick: () => onFileClick(abs),
          title: abs,
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-tree-name", children: entry.name }),
            /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-tree-size", children: formatSize(t2, entry.size) })
          ]
        },
        abs
      );
    });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-section sb-section--files", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "sb-pane-head", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-pane-title", children: t2("pane.files") }) }),
    !hasSkill && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "sb-note", children: t2("no.skill.selected") }),
    hasSkill && root === null && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "sb-note", children: t2("no.root") }),
    hasSkill && root !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(import_jsx_runtime4.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-root-bar", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-root-label", children: t2("root.label") }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "select",
          {
            className: "sb-root-select",
            value: root,
            title: root,
            onChange: (e) => onRootChange(e.target.value),
            children: rootOptions.map((r) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("option", { value: r, children: basename(r) }, r))
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "sb-crumbs", children: crumbs.map((crumb, i) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "sb-crumb-seg", children: [
        i > 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconChevronRightOutline14, { className: "sb-crumb-sep" }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "sb-crumb", onClick: () => onJump(crumb.abs), children: crumb.label })
      ] }, crumb.abs)) }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "sb-tree", children: renderEntries(root, 0) })
    ] })
  ] });
}
function FileEditor(props) {
  const {
    t: t2,
    file,
    fileLoading,
    fileError,
    hasSelection,
    editing,
    draft,
    dirty,
    saveState,
    onDraftChange,
    onEdit,
    onCancel,
    onSave
  } = props;
  const gutterRef = (0, import_react3.useRef)(null);
  const shownText = editing ? draft : file?.content ?? "";
  const lineCount = (0, import_react3.useMemo)(() => shownText.split("\n").length, [shownText]);
  const lineNumbers = (0, import_react3.useMemo)(() => {
    const arr = [];
    for (let i = 1; i <= lineCount; i += 1) arr.push(i);
    return arr;
  }, [lineCount]);
  const handleKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      onSave();
    }
  };
  let body;
  if (fileLoading) {
    body = /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-editor-empty", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconLoadingOutline16, { className: "sb-spin" }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { children: t2("loading.dir") })
    ] });
  } else if (fileError !== null) {
    const msg = fileError.kind === "not.text" ? t2("not.text") : fileError.kind === "too.large" ? t2("too.large") : t2("read.failed", { message: fileError.message });
    body = /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-editor-empty sb-note--error", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconWarningOutline16, {}),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { children: msg })
    ] });
  } else if (file === null) {
    body = /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "sb-editor-empty", children: hasSelection ? t2("no.file") : t2("no.file") });
  } else if (editing) {
    body = /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-editor-edit", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "sb-gutter sb-gutter--edit", ref: gutterRef, "aria-hidden": true, children: lineNumbers.map((n) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { children: n }, n)) }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "textarea",
        {
          className: "sb-textarea",
          value: draft,
          spellCheck: false,
          onChange: (e) => onDraftChange(e.target.value),
          onScroll: (e) => {
            if (gutterRef.current !== null) {
              gutterRef.current.scrollTop = e.target.scrollTop;
            }
          },
          onKeyDown: handleKeyDown
        }
      )
    ] });
  } else {
    body = /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-editor-scroll", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "sb-gutter", "aria-hidden": true, children: lineNumbers.map((n) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { children: n }, n)) }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("pre", { className: "sb-pre", children: file.content })
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-main", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-editor-topbar", children: [
      file !== null ? /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(import_jsx_runtime4.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-editor-filename", children: basename(file.path) }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-editor-path", title: `${t2("path")}: ${file.path}`, children: file.path })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-editor-path", children: t2("no.file") }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-spacer" }),
      file !== null && !editing && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("button", { type: "button", className: "sb-btn", onClick: onEdit, children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconEditOutline16, {}),
        t2("edit")
      ] }),
      editing && dirty && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-dirty-dot", title: t2("dirty.hint") }),
      editing && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(import_jsx_runtime4.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
          "button",
          {
            type: "button",
            className: "sb-btn sb-btn--primary",
            onClick: onSave,
            disabled: saveState === "saving" || !dirty,
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconCheckOutline16, {}),
              saveState === "saving" ? t2("saving") : t2("save")
            ]
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "sb-btn sb-btn--ghost", onClick: onCancel, children: t2("cancel") })
      ] })
    ] }),
    body
  ] });
}
function DirsModal(props) {
  const { t: t2, dirs, loading, error, input, mutating, onInputChange, onAdd, onRemove, onClose } = props;
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "sb-modal-overlay", onClick: onClose, children: /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-modal sb-modal--dirs", onClick: (e) => e.stopPropagation(), children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "sb-modal-title", children: t2("dirs.title") }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-modal-body", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "sb-dirs-help", children: t2("dirs.help") }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-dirs-addrow", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "input",
          {
            className: "sb-dirs-input",
            type: "text",
            value: input,
            placeholder: t2("dirs.placeholder"),
            spellCheck: false,
            onChange: (e) => onInputChange(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter" && input.trim() !== "" && !mutating) {
                e.preventDefault();
                onAdd();
              }
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
          "button",
          {
            type: "button",
            className: "sb-btn sb-btn--primary",
            disabled: mutating || input.trim() === "",
            onClick: onAdd,
            children: [
              mutating ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconLoadingOutline16, { className: "sb-spin" }) : null,
              t2("dirs.add")
            ]
          }
        )
      ] }),
      error !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-action-error", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconWarningOutline16, {}),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-action-error-text", children: error })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-dirs-list", children: [
        loading && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-note", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconLoadingOutline16, { className: "sb-spin" }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { children: t2("loading.skills") })
        ] }),
        !loading && dirs.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "sb-note", children: t2("dirs.empty") }),
        !loading && dirs.map((dir) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-dirs-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: `sb-dirs-path${dir.exists ? "" : " sb-dirs-path--missing"}`, title: dir.path, children: dir.path }),
          !dir.exists && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-badge sb-badge--disabled", children: t2("dirs.missing") }),
          dir.exists && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-count", children: t2("skills.count", { count: dir.skillCount }) }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "button",
            {
              type: "button",
              className: "sb-btn sb-btn--ghost",
              disabled: mutating,
              onClick: () => onRemove(dir.path),
              children: t2("dirs.remove")
            }
          )
        ] }, dir.path))
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "sb-modal-actions", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "sb-btn", onClick: onClose, children: t2("cancel") }) })
  ] }) });
}
function SkillsBrowser({ t: t2, sessionId }) {
  const [skills, setSkills] = (0, import_react3.useState)([]);
  const [roots, setRoots] = (0, import_react3.useState)([]);
  const [skillsLoading, setSkillsLoading] = (0, import_react3.useState)(true);
  const [skillsError, setSkillsError] = (0, import_react3.useState)(null);
  const [query, setQuery] = (0, import_react3.useState)("");
  const [sourceFilter, setSourceFilter] = (0, import_react3.useState)("all");
  const [statusFilter, setStatusFilter] = (0, import_react3.useState)("all");
  const [page, setPage] = (0, import_react3.useState)(1);
  const [togglingName, setTogglingName] = (0, import_react3.useState)(null);
  const [actionError, setActionError] = (0, import_react3.useState)(null);
  const [selectedName, setSelectedName] = (0, import_react3.useState)(null);
  const [dirsOpen, setDirsOpen] = (0, import_react3.useState)(false);
  const [dirs, setDirs] = (0, import_react3.useState)([]);
  const [dirsLoading, setDirsLoading] = (0, import_react3.useState)(false);
  const [dirsError, setDirsError] = (0, import_react3.useState)(null);
  const [dirInput, setDirInput] = (0, import_react3.useState)("");
  const [dirMutating, setDirMutating] = (0, import_react3.useState)(false);
  const [root, setRoot] = (0, import_react3.useState)(null);
  const [expanded, setExpanded] = (0, import_react3.useState)(/* @__PURE__ */ new Set());
  const [cache, setCache] = (0, import_react3.useState)(/* @__PURE__ */ new Map());
  const [loadingDirs, setLoadingDirs] = (0, import_react3.useState)(/* @__PURE__ */ new Set());
  const [dirErrors, setDirErrors] = (0, import_react3.useState)(/* @__PURE__ */ new Map());
  const [selectedPath, setSelectedPath] = (0, import_react3.useState)(null);
  const [file, setFile] = (0, import_react3.useState)(null);
  const [fileLoading, setFileLoading] = (0, import_react3.useState)(false);
  const [fileError, setFileError] = (0, import_react3.useState)(null);
  const [editing, setEditing] = (0, import_react3.useState)(false);
  const [draft, setDraft] = (0, import_react3.useState)("");
  const [saveState, setSaveState] = (0, import_react3.useState)("idle");
  const [saveMessage, setSaveMessage] = (0, import_react3.useState)("");
  const [pendingAction, setPendingAction] = (0, import_react3.useState)(null);
  const [refreshing, setRefreshing] = (0, import_react3.useState)(false);
  const sessionSuffix = sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : "";
  const skillsUrl = sessionId ? `${API}/skills?sessionId=${encodeURIComponent(sessionId)}` : `${API}/skills`;
  const skillsAbort = (0, import_react3.useRef)(null);
  const fileAbort = (0, import_react3.useRef)(null);
  const fileSeq = (0, import_react3.useRef)(0);
  const browseCtrls = (0, import_react3.useRef)(/* @__PURE__ */ new Map());
  const savedTimer = (0, import_react3.useRef)(null);
  const restoredRef = (0, import_react3.useRef)(false);
  const dirty = editing && file !== null && draft !== file.content;
  const currentSkill = (0, import_react3.useMemo)(
    () => skills.find((s) => s.name === selectedName) ?? null,
    [skills, selectedName]
  );
  const sourceCounts = (0, import_react3.useMemo)(() => {
    const map = /* @__PURE__ */ new Map();
    for (const s of skills) map.set(s.source, (map.get(s.source) ?? 0) + 1);
    return [...map.entries()].map(([source, count]) => ({ source, count }));
  }, [skills]);
  (0, import_react3.useEffect)(() => {
    setPage(1);
  }, [query, sourceFilter, statusFilter]);
  const guardDirty = (0, import_react3.useCallback)(
    (action) => {
      if (dirty) setPendingAction(() => action);
      else action();
    },
    [dirty]
  );
  const loadSkills = (0, import_react3.useCallback)(async (silent = false) => {
    skillsAbort.current?.abort();
    const ctrl = new AbortController();
    skillsAbort.current = ctrl;
    if (!silent) setSkillsLoading(true);
    setSkillsError(null);
    try {
      const data = await request(skillsUrl, { signal: ctrl.signal });
      if (skillsAbort.current !== ctrl) return;
      setSkills(data.skills);
      setRoots(data.roots);
    } catch (err) {
      if (err.name === "AbortError") return;
      if (skillsAbort.current !== ctrl) return;
      setSkillsError(err instanceof Error ? err.message : String(err));
    } finally {
      if (skillsAbort.current === ctrl && !silent) setSkillsLoading(false);
    }
  }, [skillsUrl]);
  (0, import_react3.useEffect)(() => {
    void loadSkills();
    return () => {
      skillsAbort.current?.abort();
      fileAbort.current?.abort();
      for (const c of browseCtrls.current.values()) c.abort();
      if (savedTimer.current !== null) clearTimeout(savedTimer.current);
    };
  }, [loadSkills]);
  const handleToggleDisabled = (0, import_react3.useCallback)(
    async (skill) => {
      if (togglingName !== null) return;
      setTogglingName(skill.name);
      setActionError(null);
      try {
        const target = skill.disabled ? "enable" : "disable";
        await request(`${API}/skills/${target}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: skill.name })
        });
        setSkills(
          (prev) => prev.map((s) => s.name === skill.name ? { ...s, disabled: !s.disabled } : s)
        );
        await loadSkills(true);
      } catch (err) {
        setActionError(
          err instanceof Error ? err.message : t2("toggle.failed", { message: String(err) })
        );
      } finally {
        setTogglingName(null);
      }
    },
    [togglingName, loadSkills, t2]
  );
  const loadDirs = (0, import_react3.useCallback)(async () => {
    setDirsLoading(true);
    setDirsError(null);
    try {
      const data = await request(`${API}/dirs`);
      setDirs(data.dirs);
    } catch (err) {
      setDirsError(err instanceof Error ? err.message : String(err));
    } finally {
      setDirsLoading(false);
    }
  }, []);
  const handleAddDir = (0, import_react3.useCallback)(async () => {
    const path = dirInput.trim();
    if (path === "" || dirMutating) return;
    setDirMutating(true);
    setDirsError(null);
    try {
      await request(`${API}/dirs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path })
      });
      setDirInput("");
      await loadDirs();
      await loadSkills(true);
    } catch (err) {
      setDirsError(err instanceof Error ? err.message : String(err));
    } finally {
      setDirMutating(false);
    }
  }, [dirInput, dirMutating, loadDirs, loadSkills]);
  const handleRemoveDir = (0, import_react3.useCallback)(
    async (path) => {
      if (dirMutating) return;
      setDirMutating(true);
      setDirsError(null);
      try {
        await request(
          `${API}/dirs?path=${encodeURIComponent(path)}`,
          { method: "DELETE" }
        );
        await loadDirs();
        await loadSkills(true);
      } catch (err) {
        setDirsError(err instanceof Error ? err.message : String(err));
      } finally {
        setDirMutating(false);
      }
    },
    [dirMutating, loadDirs, loadSkills]
  );
  const fetchDir = (0, import_react3.useCallback)(async (rootPath, absDir) => {
    browseCtrls.current.get(absDir)?.abort();
    const ctrl = new AbortController();
    browseCtrls.current.set(absDir, ctrl);
    setLoadingDirs((prev) => new Set(prev).add(absDir));
    setDirErrors((prev) => {
      const next = new Map(prev);
      next.delete(absDir);
      return next;
    });
    try {
      const rel = relOf(rootPath, absDir);
      const data = await request(
        `${API}/browse?root=${encodeURIComponent(rootPath)}&path=${encodeURIComponent(rel)}${sessionSuffix}`,
        { signal: ctrl.signal }
      );
      if (browseCtrls.current.get(absDir) !== ctrl) return;
      setCache((prev) => new Map(prev).set(absDir, data.entries));
    } catch (err) {
      if (err.name === "AbortError") return;
      if (browseCtrls.current.get(absDir) !== ctrl) return;
      setDirErrors(
        (prev) => new Map(prev).set(absDir, err instanceof Error ? err.message : String(err))
      );
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.delete(absDir);
        return next;
      });
    }
  }, [sessionSuffix]);
  (0, import_react3.useEffect)(() => {
    if (root !== null && !cache.has(root) && !loadingDirs.has(root)) void fetchDir(root, root);
  }, [root, cache, loadingDirs, fetchDir]);
  const handleToggleDir = (0, import_react3.useCallback)(
    (absDir) => {
      if (root === null) return;
      if (expanded.has(absDir)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(absDir);
          return next;
        });
      } else {
        setExpanded((prev) => new Set(prev).add(absDir));
        if (!cache.has(absDir)) void fetchDir(root, absDir);
      }
    },
    [root, expanded, cache, fetchDir]
  );
  const handleRetryDir = (0, import_react3.useCallback)(
    (absDir) => {
      if (root !== null) void fetchDir(root, absDir);
    },
    [root, fetchDir]
  );
  const loadFile = (0, import_react3.useCallback)(async (absPath) => {
    fileSeq.current += 1;
    const seq = fileSeq.current;
    fileAbort.current?.abort();
    const ctrl = new AbortController();
    fileAbort.current = ctrl;
    setSelectedPath(absPath);
    setFileLoading(true);
    setFileError(null);
    setSaveState("idle");
    setSaveMessage("");
    try {
      const data = await request(`${API}/read?path=${encodeURIComponent(absPath)}${sessionSuffix}`, {
        signal: ctrl.signal
      });
      if (seq !== fileSeq.current) return;
      setFile({ path: data.path, content: data.content, size: data.size, mtime: data.mtime });
      setDraft(data.content);
      setEditing(false);
    } catch (err) {
      if (err.name === "AbortError") return;
      if (seq !== fileSeq.current) return;
      const status = err instanceof ApiFailure ? err.status : 0;
      const message = err instanceof Error ? err.message : String(err);
      setFile(null);
      setEditing(false);
      setFileError(
        status === 415 ? { kind: "not.text", message } : status === 413 ? { kind: "too.large", message } : { kind: "read.failed", message }
      );
    } finally {
      if (seq === fileSeq.current) setFileLoading(false);
    }
  }, [sessionSuffix]);
  const handleFileClick = (0, import_react3.useCallback)(
    (absPath) => {
      guardDirty(() => void loadFile(absPath));
    },
    [guardDirty, loadFile]
  );
  const applySkillSelection = (0, import_react3.useCallback)(
    (skill, rootOverride, expandedInit) => {
      setSelectedName(skill.name);
      const dirBase = skill.resourceBase?.kind === "directory" ? skill.resourceBase.path : null;
      const nextRoot = rootOverride !== void 0 ? rootOverride : dirBase;
      setRoot(nextRoot);
      setExpanded(expandedInit ?? /* @__PURE__ */ new Set());
      setCache(/* @__PURE__ */ new Map());
      setDirErrors(/* @__PURE__ */ new Map());
      setSelectedPath(null);
      setFile(null);
      setFileError(null);
      setEditing(false);
      setSaveState("idle");
    },
    []
  );
  const handleSelectSkill = (0, import_react3.useCallback)(
    (skill) => {
      if (skill.name === selectedName) return;
      guardDirty(() => applySkillSelection(skill));
    },
    [selectedName, guardDirty, applySkillSelection]
  );
  const handleRootChange = (0, import_react3.useCallback)(
    (nextRoot) => {
      if (nextRoot === root) return;
      guardDirty(() => {
        setRoot(nextRoot);
        setExpanded(/* @__PURE__ */ new Set());
        setCache(/* @__PURE__ */ new Map());
        setDirErrors(/* @__PURE__ */ new Map());
        setSelectedPath(null);
        setFile(null);
        setFileError(null);
        setEditing(false);
        setSaveState("idle");
      });
    },
    [root, guardDirty]
  );
  const focusDir = (0, import_react3.useMemo)(() => {
    if (root === null) return null;
    if (selectedPath !== null && relOf(root, selectedPath) !== "") {
      return selectedPath.slice(0, selectedPath.lastIndexOf("/"));
    }
    return root;
  }, [root, selectedPath]);
  const crumbs = (0, import_react3.useMemo)(() => {
    if (root === null || focusDir === null) return [];
    const list = [{ label: basename(root), abs: root }];
    const rel = relOf(root, focusDir);
    let cur = root;
    for (const part of rel === "" ? [] : rel.split("/")) {
      cur = joinPath(cur, part);
      list.push({ label: part, abs: cur });
    }
    return list;
  }, [root, focusDir]);
  const handleJump = (0, import_react3.useCallback)(
    (absDir) => {
      if (root === null) return;
      setExpanded((prev) => {
        const next = new Set(prev);
        let cur2 = absDir;
        while (cur2 !== root && relOf(root, cur2) !== "") {
          next.add(cur2);
          cur2 = cur2.slice(0, cur2.lastIndexOf("/"));
        }
        return next;
      });
      let cur = absDir;
      while (cur !== root && relOf(root, cur) !== "") {
        if (!cache.has(cur) && !loadingDirs.has(cur)) void fetchDir(root, cur);
        cur = cur.slice(0, cur.lastIndexOf("/"));
      }
    },
    [root, cache, loadingDirs, fetchDir]
  );
  const handleEdit = (0, import_react3.useCallback)(() => {
    if (file === null) return;
    setDraft(file.content);
    setEditing(true);
    setSaveState("idle");
    setSaveMessage("");
  }, [file]);
  const handleCancelEdit = (0, import_react3.useCallback)(() => {
    guardDirty(() => {
      setEditing(false);
      if (file !== null) setDraft(file.content);
      setSaveState("idle");
      setSaveMessage("");
    });
  }, [guardDirty, file]);
  const handleSave = (0, import_react3.useCallback)(async () => {
    if (file === null || saveState === "saving" || !dirty) return;
    setSaveState("saving");
    setSaveMessage("");
    try {
      const data = await request(
        `${API}/write?path=${encodeURIComponent(file.path)}${sessionSuffix}`,
        {
          method: "PUT",
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          body: draft
        }
      );
      setFile({ path: data.path, content: draft, size: data.size, mtime: data.mtime });
      setSaveState("saved");
      if (savedTimer.current !== null) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaveState("idle"), 2500);
    } catch (err) {
      if (err.name === "AbortError") return;
      setSaveState("error");
      setSaveMessage(err instanceof Error ? err.message : String(err));
    }
  }, [file, draft, dirty, saveState, sessionSuffix]);
  const handleRefresh = (0, import_react3.useCallback)(async () => {
    setRefreshing(true);
    setCache(/* @__PURE__ */ new Map());
    setDirErrors(/* @__PURE__ */ new Map());
    await loadSkills();
    if (root !== null) {
      void fetchDir(root, root);
      for (const dir of expanded) {
        if (dir !== root && relOf(root, dir) !== "") void fetchDir(root, dir);
      }
    }
    if (selectedPath !== null && !editing) void loadFile(selectedPath);
    setRefreshing(false);
  }, [loadSkills, root, expanded, selectedPath, editing, fetchDir, loadFile]);
  (0, import_react3.useEffect)(() => {
    if (restoredRef.current || skills.length === 0) return;
    restoredRef.current = true;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw === null) return;
      const saved = JSON.parse(raw);
      if (typeof saved.skill !== "string") return;
      const skill = skills.find((s) => s.name === saved.skill);
      if (skill === void 0) return;
      const dirBase = skill.resourceBase?.kind === "directory" ? skill.resourceBase.path : null;
      const savedRoot = typeof saved.root === "string" ? saved.root : dirBase;
      applySkillSelection(
        skill,
        savedRoot,
        new Set(Array.isArray(saved.expanded) ? saved.expanded : [])
      );
      if (savedRoot !== null && typeof saved.file === "string") void loadFile(saved.file);
    } catch {
    }
  }, [skills, applySkillSelection, loadFile]);
  (0, import_react3.useEffect)(() => {
    if (!restoredRef.current) return;
    const state = {
      skill: selectedName,
      root,
      expanded: [...expanded],
      file: selectedPath
    };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {
    }
  }, [selectedName, root, expanded, selectedPath]);
  const rootOptions = (0, import_react3.useMemo)(() => {
    const list = [];
    if (root !== null) list.push(root);
    for (const r of roots) if (!list.includes(r)) list.push(r);
    return list;
  }, [root, roots]);
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-root", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-body", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-side", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-side-toolbar", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-search", children: [
            /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconSearchOutline16, { className: "sb-search-icon" }),
            /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
              "input",
              {
                className: "sb-search-input",
                type: "text",
                value: query,
                placeholder: t2("search.placeholder"),
                onChange: (e) => setQuery(e.target.value)
              }
            ),
            query !== "" && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
              "button",
              {
                type: "button",
                className: "sb-search-clear",
                onClick: () => setQuery(""),
                "aria-label": t2("cancel"),
                children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconCloseOutline16, {})
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "button",
            {
              type: "button",
              className: "sb-icon-btn",
              onClick: () => {
                setDirsOpen(true);
                setDirsError(null);
                void loadDirs();
              },
              title: t2("manage.dirs"),
              children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconFolderOpen16, {})
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "button",
            {
              type: "button",
              className: "sb-icon-btn",
              onClick: () => void handleRefresh(),
              disabled: refreshing,
              title: t2("refresh"),
              children: refreshing ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconLoadingOutline16, { className: "sb-spin" }) : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconRefreshOutline16, {})
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          SkillList,
          {
            t: t2,
            skills,
            loading: skillsLoading,
            error: skillsError,
            query,
            sourceFilter,
            sourceCounts,
            statusFilter,
            selectedName,
            togglingName,
            page,
            onSourceFilter: setSourceFilter,
            onStatusFilter: setStatusFilter,
            onToggleDisabled: (skill) => void handleToggleDisabled(skill),
            onSelect: handleSelectSkill,
            onRetry: () => void loadSkills(),
            onPrevPage: () => setPage((p) => Math.max(1, p - 1)),
            onNextPage: () => setPage((p) => p + 1)
          }
        ),
        actionError !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-action-error", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconWarningOutline16, {}),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-action-error-text", children: actionError }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "button",
            {
              type: "button",
              className: "sb-btn sb-btn--ghost",
              onClick: () => setActionError(null),
              children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_dsh_client_ui_primitives.IconCloseOutline16, {})
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          FileTree,
          {
            t: t2,
            hasSkill: currentSkill !== null,
            root,
            rootOptions,
            cache,
            loadingDirs,
            dirErrors,
            expanded,
            selectedPath,
            crumbs,
            onRootChange: handleRootChange,
            onJump: handleJump,
            onToggleDir: handleToggleDir,
            onFileClick: handleFileClick,
            onRetryDir: handleRetryDir
          }
        )
      ] }),
      (file !== null || fileLoading || fileError !== null) && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        FileEditor,
        {
          t: t2,
          skillName: selectedName,
          file,
          fileLoading,
          fileError,
          hasSelection: selectedPath !== null,
          editing,
          draft,
          dirty,
          saveState,
          saveMessage,
          onDraftChange: setDraft,
          onEdit: handleEdit,
          onCancel: handleCancelEdit,
          onSave: () => void handleSave()
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-statusbar sb-statusbar--panel", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "sb-status-item", children: [
        t2("status.skill"),
        ": ",
        selectedName ?? "-"
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "sb-status-item", children: [
        t2("status.file"),
        ": ",
        file !== null ? basename(file.path) : "-"
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-spacer" }),
      saveState === "error" && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-status-item sb-status--error", children: t2("write.failed", { message: saveMessage }) }),
      dirty && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-status-item sb-status--dirty", children: t2("status.unsaved") }),
      saveState === "saved" && !dirty && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-status-item sb-status--saved", children: t2("status.saved") }),
      file !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-status-item", children: formatSize(t2, file.size) }),
      file !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "sb-status-item", children: t2("mtime.label", { time: formatTime2(file.mtime) }) })
    ] }),
    dirsOpen && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      DirsModal,
      {
        t: t2,
        dirs,
        loading: dirsLoading,
        error: dirsError,
        input: dirInput,
        mutating: dirMutating,
        onInputChange: setDirInput,
        onAdd: () => void handleAddDir(),
        onRemove: (path) => void handleRemoveDir(path),
        onClose: () => setDirsOpen(false)
      }
    ),
    pendingAction !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "sb-modal-overlay", onClick: () => setPendingAction(null), children: /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-modal", onClick: (e) => e.stopPropagation(), children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "sb-modal-title", children: t2("confirm.discard.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "sb-modal-body", children: t2("confirm.discard.body", { name: file !== null ? basename(file.path) : "" }) }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "sb-modal-actions", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "button",
          {
            type: "button",
            className: "sb-btn sb-btn--ghost",
            onClick: () => setPendingAction(null),
            children: t2("cancel")
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "button",
          {
            type: "button",
            className: "sb-btn sb-btn--danger",
            onClick: () => {
              const action = pendingAction;
              setPendingAction(null);
              action();
            },
            children: t2("confirm.discard.ok")
          }
        )
      ] })
    ] }) })
  ] });
}

// src/client/SkillsTabView.tsx
var import_jsx_runtime5 = require("react/jsx-runtime");
var persistedSkillsFeature = null;
function skillsGuideSections(t2) {
  return [
    {
      icon: "\u{1F6E0}\uFE0F",
      title: t2("skillsTab.guide.what.title"),
      body: t2("skillsTab.guide.what.body"),
      items: [
        t2("skillsTab.guide.what.item1"),
        t2("skillsTab.guide.what.item2")
      ]
    },
    {
      icon: "\u{1F504}",
      title: t2("skillsTab.guide.how.title"),
      body: t2("skillsTab.guide.how.body"),
      items: [
        t2("skillsTab.guide.how.item1"),
        t2("skillsTab.guide.how.item2"),
        t2("skillsTab.guide.how.item3")
      ]
    },
    {
      icon: "\u{1F4E5}",
      title: t2("skillsTab.guide.pending.title"),
      body: t2("skillsTab.guide.pending.body"),
      items: [
        t2("skillsTab.guide.pending.item1"),
        t2("skillsTab.guide.pending.item2")
      ]
    },
    {
      icon: "\u{1F50D}",
      title: t2("skillsTab.guide.manager.title"),
      body: t2("skillsTab.guide.manager.body"),
      items: [
        t2("skillsTab.guide.manager.item1"),
        t2("skillsTab.guide.manager.item2"),
        t2("skillsTab.guide.manager.item3"),
        t2("skillsTab.guide.manager.item4")
      ]
    },
    {
      icon: "\u26D4",
      title: t2("skillsTab.guide.disable.title"),
      body: t2("skillsTab.guide.disable.body"),
      items: [
        t2("skillsTab.guide.disable.item1"),
        t2("skillsTab.guide.disable.item2")
      ]
    },
    {
      icon: "\u{1F4C1}",
      title: t2("skillsTab.guide.dirs.title"),
      body: t2("skillsTab.guide.dirs.body")
    },
    {
      icon: "\u{1F6AB}",
      title: t2("skillsTab.guide.restraint.title"),
      body: t2("skillsTab.guide.restraint.body"),
      items: [
        t2("skillsTab.guide.restraint.item1"),
        t2("skillsTab.guide.restraint.item2")
      ]
    }
  ];
}
function SkillsTabView(props) {
  const { t: t2, sessionId } = props;
  const [feature, setFeature] = (0, import_react4.useState)(persistedSkillsFeature ?? "skills");
  const [skillsCount, setSkillsCount] = (0, import_react4.useState)(0);
  const pollBadge = (0, import_react4.useCallback)(() => {
    void fetch("/memory-evolve/api/badge").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((data) => setSkillsCount(data.skills ?? 0)).catch(() => {
    });
  }, []);
  (0, import_react4.useEffect)(() => {
    persistedSkillsFeature = feature;
  }, [feature]);
  (0, import_react4.useEffect)(() => {
    pollBadge();
    const timer = window.setInterval(pollBadge, 3e4);
    const onChange = () => pollBadge();
    window.addEventListener("dsh-memory-evolve:badge-change", onChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("dsh-memory-evolve:badge-change", onChange);
    };
  }, [pollBadge]);
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "mt-panel", children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "mt-file-tabs", role: "tablist", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "guide",
          className: feature === "guide" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature("guide"),
          children: t2("skillsTab.feature.guide")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "skills",
          className: feature === "skills" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature("skills"),
          children: [
            t2("skillsTab.feature.skills"),
            skillsCount > 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "mt-feature-count", children: skillsCount })
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "skill-browser",
          className: feature === "skill-browser" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature("skill-browser"),
          children: t2("skillsTab.feature.skillBrowser")
        }
      )
    ] }),
    feature === "guide" ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(TabGuideView, { sections: skillsGuideSections(t2) }) : feature === "skill-browser" ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(SkillsBrowser, { t: t2, sessionId }) : /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
      MemoryQueueView,
      {
        t: t2,
        feature: "skills",
        onChanged: () => {
          pollBadge();
          window.dispatchEvent(new CustomEvent("dsh-memory-evolve:badge-change"));
        }
      }
    )
  ] });
}

// src/client/TodosTabView.tsx
var import_react6 = require("react");

// src/client/TodoView.tsx
var import_react5 = require("react");
var import_jsx_runtime6 = require("react/jsx-runtime");
var TARGETS = ["life", "work", "project", "daily"];
var DONE_STATUSES = /* @__PURE__ */ new Set(["done", "cancelled"]);
var BOARD_QUADRANTS = ["q1", "q2", "q3", "q4"];
var persistedViewMode = null;
async function api3(path, init) {
  const res = await fetch(`/memory-evolve${path}`, {
    headers: { "content-type": "application/json" },
    ...init
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}
function quadrantLabel(t2, quadrant) {
  if (quadrant === null) return t2("todo.quadrant.none");
  return t2(`todo.quadrant.${quadrant}`);
}
function resolveItemQuadrant(item) {
  if (item.quadrant === "q1" || item.quadrant === "q2" || item.quadrant === "q3" || item.quadrant === "q4") {
    return item.quadrant;
  }
  const important = item.important === true;
  const urgent = item.urgent === true;
  if (important && urgent) return "q1";
  if (important && !urgent) return "q2";
  if (!important && urgent) return "q3";
  return "q4";
}
function statusLabel(t2, status) {
  const key = `todo.status.${status}`;
  const label = t2(key);
  return label === key ? status : label;
}
function dayLabel(day) {
  const [, month, date] = day.split("-");
  return `${Number(month)}\u6708${Number(date)}\u65E5`;
}
function TodoView(props) {
  const { t: t2, sessionId } = props;
  const [target, setTarget] = (0, import_react5.useState)("all");
  const [addTarget, setAddTarget] = (0, import_react5.useState)("work");
  const [items, setItems] = (0, import_react5.useState)(null);
  const [cwd, setCwd] = (0, import_react5.useState)(null);
  const [statusFilter, setStatusFilter] = (0, import_react5.useState)("active");
  const [quadFilter, setQuadFilter] = (0, import_react5.useState)("all");
  const [showExpired, setShowExpired] = (0, import_react5.useState)(false);
  const [viewMode, setViewMode] = (0, import_react5.useState)(persistedViewMode ?? "list");
  const [draft, setDraft] = (0, import_react5.useState)("");
  const [draftQuad, setDraftQuad] = (0, import_react5.useState)("");
  const [draftDue, setDraftDue] = (0, import_react5.useState)("");
  const [editId, setEditId] = (0, import_react5.useState)(null);
  const [editDraft, setEditDraft] = (0, import_react5.useState)("");
  const [editQuad, setEditQuad] = (0, import_react5.useState)("");
  const [editDue, setEditDue] = (0, import_react5.useState)("");
  const [editStatus, setEditStatus] = (0, import_react5.useState)("");
  const [busy, setBusy] = (0, import_react5.useState)(false);
  const [notice, setNotice] = (0, import_react5.useState)(null);
  (0, import_react5.useEffect)(() => {
    persistedViewMode = viewMode;
  }, [viewMode]);
  const load = (0, import_react5.useCallback)(() => {
    setItems(null);
    const params = new URLSearchParams({ sessionId, all: "1" });
    if (target === "past") params.set("target", "daily");
    else if (target !== "all") params.set("target", target);
    const wantPast = target === "past" || target === "all" && showExpired;
    if (wantPast) {
      params.set("past", "1");
      if (showExpired) params.set("expired", "1");
    }
    void api3(`/api/todo?${params.toString()}`).then((res) => {
      setItems(res.items);
      setCwd(res.cwd);
      setAddTarget((prev) => {
        if (target !== "all") return prev;
        return res.cwd ? "project" : "work";
      });
    }).catch((error) => setNotice({ kind: "error", text: error.message }));
  }, [sessionId, target, showExpired]);
  (0, import_react5.useEffect)(() => {
    load();
  }, [load]);
  const flash = (text) => {
    setNotice({ kind: "ok", text });
    window.setTimeout(() => {
      setNotice((current) => current?.text === text ? null : current);
    }, 3e3);
  };
  const addTodo = () => {
    const content = draft.trim();
    if (content === "" || busy) return;
    setBusy(true);
    const addTrack = target === "all" ? addTarget : target;
    void api3("/api/todo", {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        action: "add",
        target: addTrack,
        content,
        quadrant: draftQuad === "" ? void 0 : draftQuad,
        due: draftDue === "" ? void 0 : draftDue
      })
    }).then(() => {
      setDraft("");
      setDraftQuad("");
      setDraftDue("");
      load();
      flash(t2("todo.added"));
    }).catch((error) => {
      setNotice({ kind: "error", text: error.message });
    }).finally(() => setBusy(false));
  };
  const toggleDone = (item) => {
    if (busy) return;
    setBusy(true);
    const done = !DONE_STATUSES.has(item.status);
    void api3("/api/todo", {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        action: done ? "done" : "update",
        target: item.target,
        id: item.id,
        status: "pending"
      })
    }).then(() => {
      load();
      flash(done ? t2("todo.done") : t2("todo.undone"));
    }).catch((error) => {
      setNotice({ kind: "error", text: error.message });
    }).finally(() => setBusy(false));
  };
  const removeTodo = (item) => {
    if (busy) return;
    const snippet = item.text.split("\n")[0].slice(0, 40);
    if (!window.confirm(t2("todo.deleteConfirm", { snippet }))) return;
    setBusy(true);
    void api3("/api/todo", {
      method: "POST",
      body: JSON.stringify({ sessionId, action: "remove", target: item.target, id: item.id })
    }).then(() => {
      load();
      flash(t2("todo.deleted"));
    }).catch((error) => {
      setNotice({ kind: "error", text: error.message });
    }).finally(() => setBusy(false));
  };
  const startEdit = (item) => {
    setEditId(item.id);
    setEditDraft(item.text);
    setEditQuad(item.quadrant ?? "");
    setEditDue(item.due ?? "");
    setEditStatus(item.status);
  };
  const saveEdit = (item) => {
    if (busy) return;
    setBusy(true);
    void api3("/api/todo", {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        action: "update",
        target: item.target,
        id: item.id,
        content: editDraft.trim(),
        quadrant: editQuad === "" ? void 0 : editQuad,
        due: editDue === "" ? void 0 : editDue,
        status: editStatus
      })
    }).then(() => {
      setEditId(null);
      load();
      flash(t2("todo.updated"));
    }).catch((error) => {
      setNotice({ kind: "error", text: error.message });
    }).finally(() => setBusy(false));
  };
  const cycleStatus = (item) => {
    if (busy) return;
    const order = ["pending", "doing", "done", "blocked", "cancelled"];
    const idx = order.indexOf(item.status);
    const next = order[(idx + 1) % order.length] ?? "pending";
    setBusy(true);
    void api3("/api/todo", {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        action: "update",
        target: item.target,
        id: item.id,
        status: next
      })
    }).then(() => {
      load();
      flash(t2("todo.updated"));
    }).catch((error) => {
      setNotice({ kind: "error", text: error.message });
    }).finally(() => setBusy(false));
  };
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const visible = (items ?? []).filter((item) => {
    if (target === "past" && item.past !== true) return false;
    if (statusFilter === "active" && DONE_STATUSES.has(item.status)) return false;
    if (statusFilter === "done" && !DONE_STATUSES.has(item.status)) return false;
    if (quadFilter === "none" && item.quadrant !== null) return false;
    if (quadFilter !== "all" && quadFilter !== "none" && item.quadrant !== quadFilter) return false;
    return true;
  });
  const groups = [];
  for (const item of visible) {
    const day = item.past === true ? item.day ?? null : null;
    const last = groups[groups.length - 1];
    if (day !== null && last !== void 0 && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  const boardBuckets = {
    q1: [],
    q2: [],
    q3: [],
    q4: []
  };
  for (const item of visible) {
    boardBuckets[resolveItemQuadrant(item)].push(item);
  }
  const renderMetaBadges = (item, opts) => {
    const done = DONE_STATUSES.has(item.status);
    const overdue = item.due !== null && item.due < today && !done;
    return /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(import_jsx_runtime6.Fragment, { children: [
      target === "all" && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: "me-badge me-badge-target", children: item.past === true ? t2("todo.track.past") : t2(`todo.track.${item.target}`) }),
      item.past === true && target !== "all" && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: "me-badge me-badge-day", children: dayLabel(item.day ?? "") }),
      opts?.showQuad === true && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: `me-badge me-badge-quad me-badge-quad-${item.quadrant ?? "none"}`, children: quadrantLabel(t2, item.quadrant) }),
      item.due !== null && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: `me-badge ${overdue ? "me-badge-overdue" : "me-badge-due"}`, children: overdue ? `${t2("todo.overdue")} ${item.due}` : `${t2("todo.due")} ${item.due}` }),
      item.cat !== null && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: "me-badge me-badge-target", children: item.cat }),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
        "button",
        {
          type: "button",
          className: `me-badge me-badge-status me-badge-status-${item.status}`,
          title: t2("todo.board.cycleStatus"),
          disabled: busy,
          onClick: (event) => {
            event.stopPropagation();
            cycleStatus(item);
          },
          children: statusLabel(t2, item.status)
        }
      )
    ] });
  };
  const renderActions = (item) => {
    const done = DONE_STATUSES.has(item.status);
    return /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("span", { className: "me-item-actions", children: [
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("button", { type: "button", className: "me-btn me-btn-ok", disabled: busy, onClick: () => toggleDone(item), children: done ? t2("todo.undone") : t2("todo.done") }),
      editId !== item.id && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("button", { type: "button", className: "me-btn", disabled: busy, onClick: () => startEdit(item), children: t2("todo.edit") }),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("button", { type: "button", className: "me-btn me-btn-danger", disabled: busy, onClick: () => removeTodo(item), children: t2("memoryTab.delete") })
    ] });
  };
  const renderEditForm = (item) => /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "me-todo-edit", children: [
    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
      "textarea",
      {
        className: "me-item-edit",
        rows: 2,
        value: editDraft,
        onChange: (event) => setEditDraft(event.target.value)
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "me-todo-edit-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("select", { value: editQuad, onChange: (event) => setEditQuad(event.target.value), children: [
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "", children: t2("todo.quadrant.none") }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "q1", children: t2("todo.quadrant.q1") }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "q2", children: t2("todo.quadrant.q2") }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "q3", children: t2("todo.quadrant.q3") }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "q4", children: t2("todo.quadrant.q4") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
        "input",
        {
          type: "date",
          value: editDue,
          onChange: (event) => setEditDue(event.target.value)
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("select", { value: editStatus, onChange: (event) => setEditStatus(event.target.value), children: [
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "pending", children: t2("todo.status.pending") }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "doing", children: t2("todo.status.doing") }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "done", children: t2("todo.status.done") }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "blocked", children: t2("todo.status.blocked") }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "cancelled", children: t2("todo.status.cancelled") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
        "button",
        {
          type: "button",
          className: "me-btn me-btn-ok",
          disabled: busy || editDraft.trim() === "",
          onClick: () => saveEdit(item),
          children: t2("todo.save")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("button", { type: "button", className: "me-btn", disabled: busy, onClick: () => setEditId(null), children: t2("todo.cancel") })
    ] })
  ] });
  const renderBoardCard = (item) => {
    const done = DONE_STATUSES.has(item.status);
    const titleLine = item.text.split("\n")[0] || item.text;
    return /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
      "article",
      {
        className: `me-todo-card${done ? " me-todo-card--done" : ""}`,
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "me-todo-card-meta", children: renderMetaBadges(item) }),
          editId === item.id ? renderEditForm(item) : /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(import_jsx_runtime6.Fragment, { children: [
            /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("p", { className: "me-todo-card-title", title: item.text, children: titleLine }),
            item.text.includes("\n") && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("p", { className: "me-todo-card-body", children: item.text.slice(titleLine.length).trim() })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "me-todo-card-foot", children: [
            /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: "me-item-time", children: item.time }),
            renderActions(item)
          ] })
        ]
      },
      item.id
    );
  };
  const renderBoard = () => /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "me-todo-board", role: "region", "aria-label": t2("todo.view.board"), children: BOARD_QUADRANTS.map((qid) => {
    const bucket = boardBuckets[qid];
    return /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
      "section",
      {
        className: `me-todo-quad me-todo-quad-${qid}`,
        "aria-label": t2(`todo.quadrant.${qid}`),
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("header", { className: "me-todo-quad-head", children: [
            /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: "me-todo-quad-title", children: t2(`todo.quadrant.${qid}`) }),
            /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: "me-todo-quad-count", children: bucket.length })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "me-todo-quad-body", children: bucket.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("p", { className: "me-todo-quad-empty", children: t2("todo.board.empty") }) : bucket.map((item) => renderBoardCard(item)) })
        ]
      },
      qid
    );
  }) });
  const renderList = () => {
    if (visible.length === 0) {
      return /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("p", { className: "me-empty", children: [
        t2("todo.empty"),
        (target === "all" || target === "past") && !showExpired && ` ${t2("todo.pastHint")}`
      ] });
    }
    return /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("ul", { className: "me-list", children: groups.map((group) => /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(import_react5.Fragment, { children: [
      group.day !== null && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("li", { className: "me-todo-day", children: dayLabel(group.day) }),
      group.items.map((item) => {
        const done = DONE_STATUSES.has(item.status);
        return /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("li", { className: `me-item me-todo-item${done ? " me-todo-item--done" : ""}`, children: [
          /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "me-item-head", children: [
            renderMetaBadges(item, { showQuad: true }),
            /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: "me-item-time", children: item.time }),
            renderActions(item)
          ] }),
          editId === item.id ? renderEditForm(item) : /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("p", { className: "me-todo-text", children: item.text })
        ] }, item.id);
      })
    ] }, group.day ?? group.items[0].id)) });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "me-panel", children: [
    notice !== null && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: `me-notice me-notice-${notice.kind}`, children: notice.text }),
    /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "me-tabs", role: "tablist", children: [
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": target === "all",
          className: target === "all" ? "me-tab me-tab-active" : "me-tab",
          onClick: () => setTarget("all"),
          children: t2("todo.track.all")
        }
      ),
      TARGETS.map((track) => /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": target === track,
          className: target === track ? "me-tab me-tab-active" : "me-tab",
          onClick: () => setTarget(track),
          children: t2(`todo.track.${track}`)
        },
        track
      )),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": target === "past",
          className: target === "past" ? "me-tab me-tab-active" : "me-tab",
          onClick: () => setTarget("past"),
          children: t2("todo.track.past")
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("p", { className: "me-muted me-todo-help", children: t2("todo.help") }),
    target === "project" && cwd === null && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("p", { className: "me-muted", children: t2("todo.projectHint") }),
    target !== "past" && /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "me-todo-add", children: [
      target === "all" && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
        "select",
        {
          className: "me-todo-select",
          value: addTarget,
          onChange: (event) => setAddTarget(event.target.value),
          title: t2("todo.track"),
          children: TARGETS.map((track) => /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: track, children: t2(`todo.track.${track}`) }, track))
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
        "input",
        {
          type: "text",
          className: "me-todo-input",
          value: draft,
          placeholder: t2("todo.addPlaceholder"),
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") addTodo();
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
        "select",
        {
          className: "me-todo-select",
          value: draftQuad,
          onChange: (event) => setDraftQuad(event.target.value),
          title: t2("todo.quadrant"),
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "", children: t2("todo.quadrant.none") }),
            /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "q1", children: t2("todo.quadrant.q1") }),
            /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "q2", children: t2("todo.quadrant.q2") }),
            /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "q3", children: t2("todo.quadrant.q3") }),
            /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "q4", children: t2("todo.quadrant.q4") })
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
        "input",
        {
          type: "date",
          className: "me-todo-date",
          value: draftDue,
          onChange: (event) => setDraftDue(event.target.value),
          title: t2("todo.due")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("button", { type: "button", className: "me-btn me-btn-ok", disabled: busy || draft.trim() === "", onClick: addTodo, children: t2("todo.add") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "me-todo-filters", children: [
      /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("label", { className: "me-todo-filter", children: [
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { children: t2("todo.filterStatus") }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("select", { value: statusFilter, onChange: (event) => setStatusFilter(event.target.value), children: [
          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "active", children: t2("todo.status.active") }),
          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "all", children: t2("todo.all") }),
          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "done", children: t2("todo.status.done") })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("label", { className: "me-todo-filter", children: [
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { children: t2("todo.filterQuadrant") }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("select", { value: quadFilter, onChange: (event) => setQuadFilter(event.target.value), children: [
          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "all", children: t2("todo.all") }),
          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "q1", children: t2("todo.quadrant.q1") }),
          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "q2", children: t2("todo.quadrant.q2") }),
          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "q3", children: t2("todo.quadrant.q3") }),
          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "q4", children: t2("todo.quadrant.q4") }),
          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "none", children: t2("todo.quadrant.none") })
        ] })
      ] }),
      (target === "all" || target === "past") && /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("label", { className: "me-todo-filter me-todo-filter-check", children: [
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
          "input",
          {
            type: "checkbox",
            checked: showExpired,
            onChange: (event) => setShowExpired(event.target.checked)
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { children: t2("todo.showExpired") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "me-todo-view-switch", role: "group", "aria-label": t2("todo.view.mode"), children: [
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
          "button",
          {
            type: "button",
            className: viewMode === "list" ? "me-todo-view-btn me-todo-view-btn-active" : "me-todo-view-btn",
            "aria-pressed": viewMode === "list",
            onClick: () => setViewMode("list"),
            children: t2("todo.view.list")
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
          "button",
          {
            type: "button",
            className: viewMode === "board" ? "me-todo-view-btn me-todo-view-btn-active" : "me-todo-view-btn",
            "aria-pressed": viewMode === "board",
            onClick: () => setViewMode("board"),
            children: t2("todo.view.board")
          }
        )
      ] })
    ] }),
    items === null ? /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("p", { className: "me-muted", children: t2("panel.loading") }) : viewMode === "board" ? renderBoard() : renderList()
  ] });
}

// src/client/TodosTabView.tsx
var import_jsx_runtime7 = require("react/jsx-runtime");
var persistedTodosFeature = null;
function todosGuideSections(t2) {
  return [
    {
      icon: "\u{1F4CB}",
      title: t2("todosTab.guide.tracks.title"),
      body: t2("todosTab.guide.tracks.body"),
      items: [
        t2("todosTab.guide.tracks.item1"),
        t2("todosTab.guide.tracks.item2"),
        t2("todosTab.guide.tracks.item3"),
        t2("todosTab.guide.tracks.item4")
      ]
    },
    {
      icon: "\u2795",
      title: t2("todosTab.guide.add.title"),
      body: t2("todosTab.guide.add.body"),
      items: [
        t2("todosTab.guide.add.item1"),
        t2("todosTab.guide.add.item2")
      ]
    },
    {
      icon: "\u{1F532}",
      title: t2("todosTab.guide.pending.title"),
      body: t2("todosTab.guide.pending.body"),
      items: [
        t2("todosTab.guide.pending.item1"),
        t2("todosTab.guide.pending.item2")
      ]
    },
    {
      icon: "\u{1F3AF}",
      title: t2("todosTab.guide.attrs.title"),
      body: t2("todosTab.guide.attrs.body"),
      items: [
        t2("todosTab.guide.attrs.item1"),
        t2("todosTab.guide.attrs.item2"),
        t2("todosTab.guide.attrs.item3")
      ]
    },
    {
      icon: "\u{1F4C5}",
      title: t2("todosTab.guide.view.title"),
      body: t2("todosTab.guide.view.body"),
      items: [
        t2("todosTab.guide.view.item1"),
        t2("todosTab.guide.view.item2")
      ]
    },
    {
      icon: "\u23F0",
      title: t2("todosTab.guide.remind.title"),
      body: t2("todosTab.guide.remind.body")
    }
  ];
}
function TodosTabView(props) {
  const { sessionId, t: t2 } = props;
  const [feature, setFeature] = (0, import_react6.useState)(persistedTodosFeature ?? "todo-suggestions");
  const [todoSuggestionsCount, setTodoSuggestionsCount] = (0, import_react6.useState)(0);
  const pollBadge = (0, import_react6.useCallback)(() => {
    void fetch("/memory-evolve/api/badge").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((data) => setTodoSuggestionsCount(data.todoSuggestions ?? 0)).catch(() => {
    });
  }, []);
  (0, import_react6.useEffect)(() => {
    persistedTodosFeature = feature;
  }, [feature]);
  (0, import_react6.useEffect)(() => {
    pollBadge();
    const timer = window.setInterval(pollBadge, 3e4);
    const onChange = () => pollBadge();
    window.addEventListener("dsh-memory-evolve:badge-change", onChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("dsh-memory-evolve:badge-change", onChange);
    };
  }, [pollBadge]);
  return /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "mt-panel", children: [
    /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "mt-file-tabs", role: "tablist", children: [
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "guide",
          className: feature === "guide" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature("guide"),
          children: t2("todosTab.feature.guide")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "todo-suggestions",
          className: feature === "todo-suggestions" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature("todo-suggestions"),
          children: [
            t2("todosTab.feature.todoSuggestions"),
            todoSuggestionsCount > 0 && /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "mt-feature-count", children: todoSuggestionsCount })
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "todo",
          className: feature === "todo" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature("todo"),
          children: t2("todosTab.feature.todo")
        }
      )
    ] }),
    feature === "guide" ? /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(TabGuideView, { sections: todosGuideSections(t2) }) : feature === "todo" ? /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(TodoView, { t: t2, sessionId: String(sessionId) }) : /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
      MemoryQueueView,
      {
        t: t2,
        feature: "todo-suggestions",
        onChanged: () => {
          pollBadge();
          window.dispatchEvent(new CustomEvent("dsh-memory-evolve:badge-change"));
        }
      }
    )
  ] });
}

// src/client/SettingsTabView.tsx
var import_react7 = require("react");
var import_jsx_runtime8 = require("react/jsx-runtime");
var persistedSettingsFeature = null;
function SettingsTabView(props) {
  const { t: t2 } = props;
  const [feature, setFeature] = (0, import_react7.useState)(persistedSettingsFeature ?? "guide");
  (0, import_react7.useEffect)(() => {
    persistedSettingsFeature = feature;
  }, [feature]);
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { className: "mt-panel", children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { className: "mt-file-tabs", role: "tablist", children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "guide",
          className: feature === "guide" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature("guide"),
          children: t2("settingsTab.feature.guide")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "config",
          className: feature === "config" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature("config"),
          children: t2("settingsTab.feature.config")
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
      MemoryQueueView,
      {
        t: t2,
        feature,
        onChanged: () => {
          window.dispatchEvent(new CustomEvent("dsh-memory-evolve:badge-change"));
        }
      }
    )
  ] });
}

// src/client/ModelsTabView.tsx
var import_react8 = require("react");
var import_jsx_runtime9 = require("react/jsx-runtime");
var keyOf = (provider, model) => `${provider}\0${model}`;
function capacityText(value) {
  if (value === void 0) return "\u2014";
  if (value >= 1e6) return `${(value / 1e6).toFixed(value % 1e6 === 0 ? 0 : 1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(value % 1e3 === 0 ? 0 : 1)}K`;
  return String(value);
}
var persistedModelsFeature = null;
function modelsGuideSections(t2) {
  return [
    {
      icon: "\u{1F9ED}",
      title: t2("modelsTab.guide.what.title"),
      body: t2("modelsTab.guide.what.body"),
      items: [
        t2("modelsTab.guide.what.item1"),
        t2("modelsTab.guide.what.item2"),
        t2("modelsTab.guide.what.item3")
      ]
    },
    {
      icon: "\u2699\uFE0F",
      title: t2("modelsTab.guide.config.title"),
      body: t2("modelsTab.guide.config.body"),
      items: [
        t2("modelsTab.guide.config.item1"),
        t2("modelsTab.guide.config.item2"),
        t2("modelsTab.guide.config.item3"),
        t2("modelsTab.guide.config.item4"),
        t2("modelsTab.guide.config.item5")
      ]
    },
    {
      icon: "\u{1F916}",
      title: t2("modelsTab.guide.tool.title"),
      body: t2("modelsTab.guide.tool.body"),
      items: [
        t2("modelsTab.guide.tool.item1"),
        t2("modelsTab.guide.tool.item2")
      ]
    },
    {
      icon: "\u{1F50C}",
      title: t2("modelsTab.guide.switch.title"),
      body: t2("modelsTab.guide.switch.body")
    }
  ];
}
function ModelsTabView(props) {
  const { t: t2 } = props;
  const [feature, setFeature] = (0, import_react8.useState)(persistedModelsFeature ?? "models");
  const [snapshot, setSnapshot] = (0, import_react8.useState)(null);
  const [loading, setLoading] = (0, import_react8.useState)(false);
  const [error, setError] = (0, import_react8.useState)(void 0);
  const [query, setQuery] = (0, import_react8.useState)("");
  const [showReasoning, setShowReasoning] = (0, import_react8.useState)(true);
  const [expanded, setExpanded] = (0, import_react8.useState)(void 0);
  const [saving, setSaving] = (0, import_react8.useState)(/* @__PURE__ */ new Set());
  (0, import_react8.useEffect)(() => {
    persistedModelsFeature = feature;
  }, [feature]);
  const load = (0, import_react8.useCallback)(() => {
    setLoading(true);
    setError(void 0);
    void fetch("/memory-evolve/api/models").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((data) => {
      setSnapshot(data);
    }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      setLoading(false);
    });
  }, []);
  (0, import_react8.useEffect)(() => {
    load();
  }, [load]);
  const update = (0, import_react8.useCallback)(async (provider, model, patch) => {
    const key = keyOf(provider, model);
    setSaving((current) => new Set(current).add(key));
    try {
      const res = await fetch("/memory-evolve/api/models/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, model, patch })
      });
      const data = await res.json();
      if (!res.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${res.status}`);
      return true;
    } finally {
      setSaving((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, []);
  const applyLocal = (0, import_react8.useCallback)((provider, model, mutate) => {
    setSnapshot((current) => {
      if (current === null) return current;
      const providers = current.providers.map((g) => {
        if (g.provider !== provider) return g;
        return { ...g, models: g.models.map((m) => {
          if (m.id !== model) return m;
          const next = { ...m };
          mutate(next);
          return next;
        }) };
      });
      let enabledTotal = 0;
      for (const g of providers) {
        for (const m of g.models) {
          if (m.enabled) enabledTotal += 1;
        }
      }
      return { providers, total: current.total, enabledTotal };
    });
  }, []);
  const toggleEnabled = (0, import_react8.useCallback)((provider, model) => {
    const target = findRow(snapshot, provider, model);
    if (target === null) return;
    void update(provider, model, { enabled: !target.enabled }).then((ok) => {
      if (ok) applyLocal(provider, model, (row) => {
        row.enabled = !row.enabled;
      });
    });
  }, [snapshot, update, applyLocal]);
  const saveNote = (0, import_react8.useCallback)((provider, model, note) => {
    void update(provider, model, { note }).then((ok) => {
      if (ok) applyLocal(provider, model, (row) => {
        row.note = note;
      });
    });
  }, [update, applyLocal]);
  const saveReasoning = (0, import_react8.useCallback)((provider, model, thinking, recommended, enabledIds, custom) => {
    const row = findRow(snapshot, provider, model);
    if (row === null || row.reasoning === null) return;
    const allIds = row.reasoning.levels.map((l) => l.id);
    const enabled = enabledIds.length === allIds.length && allIds.every((id) => enabledIds.includes(id)) ? null : enabledIds;
    void update(provider, model, {
      thinking,
      reasoning: {
        enabled,
        // '' = 跟随模型自动推荐（null 清除覆盖）。
        recommended: recommended === "" ? null : recommended,
        custom
      }
    }).then((ok) => {
      if (ok) {
        setExpanded(void 0);
        applyLocal(provider, model, (r) => {
          const reasoning = r.reasoning;
          if (reasoning === null) return;
          r.thinking = thinking;
          reasoning.recommendedOverride = recommended === "" ? void 0 : recommended;
          if (recommended !== "") reasoning.recommended = recommended;
          const enabledSet = new Set(enabledIds);
          const customById = new Map(custom.map((c) => [c.id, c]));
          reasoning.levels = [
            ...reasoning.levels.map((l) => {
              const c = customById.get(l.id);
              return c !== void 0 ? { id: l.id, name: c.name, custom: true, enabled: enabledSet.has(l.id) } : { id: l.id, name: l.name, custom: false, enabled: enabledSet.has(l.id) };
            }),
            // 新添加的自定义等级（不在 adapter 等级里）追加到末尾。
            ...custom.filter((c) => !reasoning.levels.some((l) => l.id === c.id)).map((c) => ({ id: c.id, name: c.name, custom: true, enabled: enabledSet.has(c.id) }))
          ];
        });
      }
    });
  }, [snapshot, update, applyLocal]);
  const rows = (0, import_react8.useMemo)(() => {
    const q = query.trim().toLowerCase();
    const out = [];
    for (const group of snapshot?.providers ?? []) {
      for (const row of group.models) {
        if (q !== "" && !(group.providerDisplay.toLowerCase().includes(q) || group.provider.toLowerCase().includes(q) || row.name.toLowerCase().includes(q) || row.id.toLowerCase().includes(q) || row.note.toLowerCase().includes(q))) continue;
        out.push({ group, row });
      }
    }
    return out;
  }, [snapshot, query]);
  return /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("div", { className: "mt-panel", children: [
    /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("div", { className: "mt-file-tabs", role: "tablist", children: [
      /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "models",
          className: feature === "models" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature("models"),
          children: t2("modelsTab.feature.models")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "guide",
          className: feature === "guide" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature("guide"),
          children: t2("modelsTab.feature.guide")
        }
      )
    ] }),
    feature === "guide" ? /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(TabGuideView, { sections: modelsGuideSections(t2) }) : /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(import_jsx_runtime9.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("div", { className: "mt-toolbar", children: [
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
          "input",
          {
            className: "mt-search",
            type: "search",
            placeholder: t2("modelsTab.searchPh"),
            value: query,
            onChange: (event) => {
              setQuery(event.target.value);
            },
            "aria-label": t2("modelsTab.searchPh")
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("label", { className: "mt-models-toggle-label", children: [
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
            "input",
            {
              type: "checkbox",
              checked: showReasoning,
              onChange: (event) => {
                setShowReasoning(event.target.checked);
              }
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { children: t2("modelsTab.showReasoning") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("button", { type: "button", className: "mt-btn", disabled: loading, onClick: load, children: loading ? t2("modelsTab.loading") : t2("modelsTab.refresh") }),
        snapshot !== null ? /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { className: "mt-muted", children: t2("modelsTab.count", { total: snapshot.total, enabled: snapshot.enabledTotal }) }) : null
      ] }),
      error !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("div", { className: "mt-notice mt-notice-error", children: t2("modelsTab.loadFailed", { message: error }) }) : null,
      snapshot !== null && rows.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("p", { className: "mt-muted", children: t2("modelsTab.empty") }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("div", { className: "mt-models-scroll", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("table", { className: "mt-models-table", children: [
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("tr", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("th", { className: "mt-models-cell mt-models-col-enable", children: t2("modelsTab.enabled") }),
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("th", { className: "mt-models-cell", children: t2("modelsTab.provider") }),
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("th", { className: "mt-models-cell", children: t2("modelsTab.model") }),
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("th", { className: "mt-models-cell mt-models-col-capacity", children: t2("modelsTab.capacity") }),
          showReasoning ? /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("th", { className: "mt-models-cell mt-models-col-reasoning", children: t2("modelsTab.reasoning") }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("th", { className: "mt-models-cell", children: t2("modelsTab.note") })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("tbody", { children: rows.map(({ group, row }) => /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
          RowView,
          {
            t: t2,
            group,
            row,
            showReasoning,
            expanded: expanded === keyOf(group.provider, row.id),
            saving: saving.has(keyOf(group.provider, row.id)),
            onToggle: () => {
              toggleEnabled(group.provider, row.id);
            },
            onExpand: () => {
              setExpanded(expanded === keyOf(group.provider, row.id) ? void 0 : keyOf(group.provider, row.id));
            },
            onSaveNote: (note) => {
              saveNote(group.provider, row.id, note);
            },
            onSaveReasoning: (thinking, recommended, enabledIds, custom) => {
              saveReasoning(group.provider, row.id, thinking, recommended, enabledIds, custom);
            }
          },
          keyOf(group.provider, row.id)
        )) })
      ] }) })
    ] })
  ] });
}
function findRow(snapshot, provider, model) {
  for (const group of snapshot?.providers ?? []) {
    if (group.provider !== provider) continue;
    const row = group.models.find((m) => m.id === model);
    return row ?? null;
  }
  return null;
}
function RowView(props) {
  const { t: t2, group, row, showReasoning, expanded, saving, onToggle, onExpand, onSaveNote, onSaveReasoning } = props;
  const [noteDraft, setNoteDraft] = (0, import_react8.useState)(row.note);
  const [thinkingDraft, setThinkingDraft] = (0, import_react8.useState)(row.thinking);
  const [recommendedDraft, setRecommendedDraft] = (0, import_react8.useState)(row.reasoning?.recommendedOverride ?? "");
  const [levelDraft, setLevelDraft] = (0, import_react8.useState)(
    () => new Set((row.reasoning?.levels ?? []).filter((l) => l.enabled).map((l) => l.id))
  );
  const [customDraft, setCustomDraft] = (0, import_react8.useState)(
    () => (row.reasoning?.levels ?? []).filter((l) => l.custom).map((l) => ({ id: l.id, name: l.name }))
  );
  const [newId, setNewId] = (0, import_react8.useState)("");
  const [newName, setNewName] = (0, import_react8.useState)("");
  (0, import_react8.useEffect)(() => {
    setNoteDraft(row.note);
  }, [row.note]);
  const levels = row.reasoning?.levels ?? [];
  const recommended = row.reasoning?.recommended;
  const usable = levels.filter((l) => l.enabled);
  const toggleThinking = (next) => {
    setThinkingDraft(next);
    if (!next) {
      setLevelDraft((current) => {
        const filtered = /* @__PURE__ */ new Set();
        for (const id of current) {
          const level = levels.find((l) => l.id === id);
          if (level !== void 0 && level.id === "off") filtered.add(id);
        }
        return filtered;
      });
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("tr", { className: row.enabled ? "mt-models-row" : "mt-models-row mt-models-row-muted", children: [
    /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("td", { className: "mt-models-cell mt-models-col-enable", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
      "input",
      {
        type: "checkbox",
        checked: row.enabled,
        disabled: saving,
        onChange: onToggle,
        "aria-label": row.enabled ? t2("modelsTab.disable") : t2("modelsTab.enable")
      }
    ) }),
    /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("td", { className: "mt-models-cell", children: [
      /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { className: "mt-models-provider", children: group.providerDisplay }),
      !group.active ? /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { className: "mt-models-tag mt-models-tag-dormant", children: t2("modelsTab.dormant") }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("td", { className: "mt-models-cell", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("div", { className: "mt-models-model", children: [
      /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { className: "mt-models-model-name", children: row.name }),
      /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { className: "mt-models-model-id", children: row.id }),
      row.supportsImage === true ? /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { className: "mt-models-tag", title: t2("modelsTab.supportsImageHint"), children: t2("modelsTab.supportsImage") }) : null
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("td", { className: "mt-models-cell mt-models-col-capacity", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("span", { className: "mt-models-capacity", children: [
      capacityText(row.contextWindow),
      " / ",
      capacityText(row.maxTokens)
    ] }) }),
    showReasoning ? /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("td", { className: "mt-models-cell mt-models-col-reasoning", children: !row.thinking ? /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { className: "mt-models-tag mt-models-tag-off", children: t2("modelsTab.thinkingOff") }) : levels.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { className: "mt-models-muted-cell", children: "\u2014" }) : /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(import_jsx_runtime9.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("div", { className: "mt-models-levels", children: [
        usable.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { className: "mt-models-level-none", children: t2("modelsTab.levelsNone") }) : usable.slice(0, 4).map((l) => /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
          "span",
          {
            className: l.id === recommended ? "mt-models-tag mt-models-tag-rec" : "mt-models-tag",
            children: l.name
          },
          l.id
        )),
        usable.length > 4 ? /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("span", { className: "mt-models-level-more", children: [
          "+",
          usable.length - 4
        ] }) : null
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("button", { type: "button", className: "mt-models-link", onClick: onExpand, "aria-expanded": expanded, children: expanded ? t2("modelsTab.closeEditor") : t2("modelsTab.editLevels") })
    ] }) }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("td", { className: "mt-models-cell", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
      "input",
      {
        className: "mt-models-note",
        type: "text",
        value: noteDraft,
        placeholder: t2("modelsTab.notePh"),
        disabled: saving,
        "aria-label": t2("modelsTab.note"),
        onChange: (event) => {
          setNoteDraft(event.target.value);
        },
        onBlur: () => {
          if (noteDraft !== row.note) onSaveNote(noteDraft);
        }
      }
    ) }),
    expanded && levels.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("td", { className: "mt-models-expanded", colSpan: showReasoning ? 6 : 5, children: /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("div", { className: "mt-models-editor", children: [
      /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("div", { className: "mt-models-editor-title", children: t2("modelsTab.editorTitle") }),
      /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("label", { className: "mt-models-editor-level", children: [
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
          "input",
          {
            type: "checkbox",
            checked: thinkingDraft,
            disabled: saving,
            onChange: (event) => {
              toggleThinking(event.target.checked);
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { className: "mt-models-editor-level-name", children: t2("modelsTab.thinking") }),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { className: "mt-models-editor-hint", children: t2("modelsTab.thinkingHint") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("label", { className: "mt-models-editor-level", children: [
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { className: "mt-models-editor-label", children: t2("modelsTab.recommendedLevel") }),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(
          "select",
          {
            className: "mt-models-select",
            value: thinkingDraft ? recommendedDraft : "",
            disabled: saving || !thinkingDraft || usable.length === 0,
            onChange: (event) => {
              setRecommendedDraft(event.target.value);
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("option", { value: "", children: t2("modelsTab.recommendedAuto") }),
              levels.filter((l) => l.enabled).map((l) => /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("option", { value: l.id, children: [
                l.name,
                " (",
                l.id,
                ")"
              ] }, l.id))
            ]
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("div", { className: "mt-models-editor-levels", children: levels.map((l) => /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("label", { className: "mt-models-editor-level", children: [
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
          "input",
          {
            type: "checkbox",
            checked: levelDraft.has(l.id),
            disabled: saving || !thinkingDraft && l.id !== "off",
            onChange: () => {
              setLevelDraft((current) => {
                const next = new Set(current);
                if (!next.delete(l.id)) next.add(l.id);
                return next;
              });
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { className: "mt-models-editor-level-name", children: l.name }),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { className: "mt-models-editor-level-id", children: l.id }),
        l.id === recommended && thinkingDraft ? /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { className: "mt-models-tag mt-models-tag-rec", children: t2("modelsTab.recommended") }) : null,
        l.custom ? /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
          "button",
          {
            type: "button",
            className: "mt-models-link mt-models-link-danger",
            disabled: saving,
            onClick: () => {
              setCustomDraft((current) => current.filter((c) => c.id !== l.id));
              setLevelDraft((current) => {
                const next = new Set(current);
                next.delete(l.id);
                return next;
              });
            },
            children: t2("modelsTab.removeLevel")
          }
        ) : null
      ] }, l.id)) }),
      /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("div", { className: "mt-models-editor-add", children: [
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
          "input",
          {
            className: "mt-search",
            type: "text",
            value: newId,
            placeholder: t2("modelsTab.levelIdPh"),
            "aria-label": t2("modelsTab.levelIdPh"),
            disabled: saving,
            onChange: (event) => {
              setNewId(event.target.value.trim());
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
          "input",
          {
            className: "mt-search",
            type: "text",
            value: newName,
            placeholder: t2("modelsTab.levelNamePh"),
            "aria-label": t2("modelsTab.levelNamePh"),
            disabled: saving,
            onChange: (event) => {
              setNewName(event.target.value);
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
          "button",
          {
            type: "button",
            className: "mt-btn",
            disabled: saving || newId === "" || !/^[A-Za-z0-9._-]{1,32}$/.test(newId),
            onClick: () => {
              setCustomDraft((current) => {
                if (current.some((c) => c.id === newId)) return current;
                return [...current, { id: newId, name: newName === "" ? newId : newName }];
              });
              setLevelDraft((current) => new Set(current).add(newId));
              setNewId("");
              setNewName("");
            },
            children: t2("modelsTab.addLevel")
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)("div", { className: "mt-models-editor-actions", children: [
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
          "button",
          {
            type: "button",
            className: "mt-btn",
            disabled: saving,
            onClick: () => {
              onSaveReasoning(thinkingDraft, recommendedDraft, [...levelDraft], customDraft);
            },
            children: saving ? t2("modelsTab.saving") : t2("modelsTab.save")
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("button", { type: "button", className: "mt-btn", disabled: saving, onClick: onExpand, children: t2("modelsTab.cancel") })
      ] })
    ] }) }) : null
  ] });
}

// src/client/UiSettingsView.tsx
var import_react9 = require("react");

// src/client/ui-settings-features.ts
var FEATURES_KEY = "dsh-memory-evolve:ui-settings:features";
var FEATURES_EVENT = "dsh-memory-evolve:ui-settings-features";
var DEFAULTS = { sessionFilter: false, wideChat: false, wideBubble: false, contextWarn: false, mermaidRender: false };
function readFeatures() {
  try {
    const raw = localStorage.getItem(FEATURES_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      return {
        sessionFilter: typeof parsed.sessionFilter === "boolean" ? parsed.sessionFilter : DEFAULTS.sessionFilter,
        wideChat: typeof parsed.wideChat === "boolean" ? parsed.wideChat : DEFAULTS.wideChat,
        wideBubble: typeof parsed.wideBubble === "boolean" ? parsed.wideBubble : DEFAULTS.wideBubble,
        contextWarn: typeof parsed.contextWarn === "boolean" ? parsed.contextWarn : DEFAULTS.contextWarn,
        mermaidRender: typeof parsed.mermaidRender === "boolean" ? parsed.mermaidRender : DEFAULTS.mermaidRender
      };
    }
  } catch {
  }
  return { ...DEFAULTS };
}
function writeFeatures(features) {
  try {
    localStorage.setItem(FEATURES_KEY, JSON.stringify(features));
  } catch {
  }
  window.dispatchEvent(new CustomEvent(FEATURES_EVENT, { detail: { ...features } }));
}

// src/client/UiSettingsView.tsx
var import_jsx_runtime10 = require("react/jsx-runtime");
var persistedUiSettingsFeature = null;
function FeatureSwitchRow({ label, hint, checked, onChange }) {
  return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("label", { className: "me-field", children: [
    /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("span", { className: "me-field-label", children: [
      label,
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("em", { className: "me-field-hint", children: hint })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
      "input",
      {
        type: "checkbox",
        className: "me-switch",
        checked,
        onChange: (event) => onChange(event.target.checked)
      }
    )
  ] });
}
function UiSettingsTabView(props) {
  const { t: t2 } = props;
  const [feature, setFeature] = (0, import_react9.useState)(persistedUiSettingsFeature ?? "mixed");
  const [features, setFeatures] = (0, import_react9.useState)(() => readFeatures());
  (0, import_react9.useEffect)(() => {
    persistedUiSettingsFeature = feature;
  }, [feature]);
  const toggleFeature = (key, checked) => {
    setFeatures((prev) => {
      const next = { ...prev, [key]: checked };
      writeFeatures(next);
      return next;
    });
  };
  const renderMixed = () => /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("section", { className: "me-block", children: [
    /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("div", { className: "me-block-head", children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("h3", { className: "me-heading", children: t2("uiSettingsTab.features.title") }) }),
    /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("p", { className: "me-help", children: t2("uiSettingsTab.features.help") }),
    /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("div", { className: "me-form", children: /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("div", { className: "me-group", children: [
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
        FeatureSwitchRow,
        {
          label: t2("uiSettings.feature.sessionFilter"),
          hint: t2("uiSettings.feature.sessionFilter.hint"),
          checked: features.sessionFilter,
          onChange: (checked) => toggleFeature("sessionFilter", checked)
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
        FeatureSwitchRow,
        {
          label: t2("uiSettings.feature.wideChat"),
          hint: t2("uiSettings.feature.wideChat.hint"),
          checked: features.wideChat,
          onChange: (checked) => toggleFeature("wideChat", checked)
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
        FeatureSwitchRow,
        {
          label: t2("uiSettings.feature.wideBubble"),
          hint: t2("uiSettings.feature.wideBubble.hint"),
          checked: features.wideBubble,
          onChange: (checked) => toggleFeature("wideBubble", checked)
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
        FeatureSwitchRow,
        {
          label: t2("uiSettings.feature.contextWarn"),
          hint: t2("uiSettings.feature.contextWarn.hint"),
          checked: features.contextWarn,
          onChange: (checked) => toggleFeature("contextWarn", checked)
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
        FeatureSwitchRow,
        {
          label: t2("uiSettings.feature.mermaidRender"),
          hint: t2("uiSettings.feature.mermaidRender.hint"),
          checked: features.mermaidRender,
          onChange: (checked) => toggleFeature("mermaidRender", checked)
        }
      )
    ] }) })
  ] });
  const renderGuide = () => /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(TabGuideView, { sections: [
    { icon: "\u{1F3A8}", title: t2("uiSettingsTab.guide.what.title"), body: t2("uiSettingsTab.guide.what.body") },
    { icon: "\u{1FA84}", title: t2("uiSettingsTab.guide.switch.title"), body: t2("uiSettingsTab.guide.switch.body") }
  ] });
  return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("div", { className: "me-panel", children: [
    /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("div", { className: "mt-file-tabs", role: "tablist", children: [
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "mixed",
          className: feature === "mixed" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature("mixed"),
          children: t2("uiSettingsTab.feature.mixed")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "guide",
          className: feature === "guide" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature("guide"),
          children: t2("uiSettingsTab.feature.guide")
        }
      )
    ] }),
    feature === "mixed" && renderMixed(),
    feature === "guide" && renderGuide()
  ] });
}

// src/client/CoIView.tsx
var import_react10 = require("react");
var import_jsx_runtime11 = require("react/jsx-runtime");
var DICT = {
  zh: {
    tab: "CLI\u8C03\u5EA6",
    guide: "\u6307\u5357",
    "guide.title": "COI \u8C03\u5EA6\u4F7F\u7528\u6307\u5357",
    "guide.intro": "COI \u8C03\u5EA6\u662F\u300C\u5916\u90E8 AI \u4EE3\u7406\u8C03\u5EA6\u5668\u300D\uFF1A\u628A\u4EFB\u52A1\u6D3E\u7ED9 kimi / codex / grok / hermes \u7B49 CLI \u4EE3\u7406\u2014\u2014\u7EDF\u4E00\u8C03\u5EA6\u4E0D\u5361\u4E3B\u8FDB\u7A0B\u3001\u5B9E\u65F6\u770B\u8FDB\u5EA6\u3001\u4F1A\u8BDD\u5206\u5C42\u7BA1\u7406\u53EF\u4E00\u952E\u6062\u590D\u3001\u8DE8 COI \u63A5\u529B\u3001\u4EFB\u52A1\u7ED3\u679C\u7559\u6863\u5E76\u81EA\u52A8\u6C89\u6DC0\u5230\u8BB0\u5FC6\u3002\u672C\u6A21\u5757\u9ED8\u8BA4\u7981\u7528\uFF08\u53EF\u5728\u300CMemory Evolve \u8BBE\u7F6E\u300DTab \u7684\u300C\u914D\u7F6E\u300D\u4E2D\u542F\u7528\uFF09\u3002",
    "guide.use.title": "\u600E\u4E48\u53D1\u8D77\u4EFB\u52A1",
    "guide.use.desc": "\u4E09\u79CD\u5165\u53E3\uFF0C\u4EFB\u9009\u5176\u4E00\uFF1A",
    "guide.use.ai": "\u5BF9 AI \u8BF4\uFF1A",
    "guide.use.aiDesc": '\u76F4\u63A5\u8BF4"\u6D3E\u7ED9 kimi \u505A XX / \u8BA9 codex \u4FEE\u590D\u6D4B\u8BD5"\u2014\u2014AI \u7528 de_coi_dispatch \u5DE5\u5177\u53D1\u8D77\uFF0C\u5B8C\u6210\u540E\u81EA\u52A8\u63A5\u7EED\u5904\u7406\u7ED3\u679C\u3002',
    "guide.use.slash": "\u7EC8\u7AEF\u547D\u4EE4\uFF1A",
    "guide.use.slashDesc": '/de_coi run "\u4EFB\u52A1" --coi kimi\uFF08\u67E5\u770B\u5168\u90E8\u5B50\u547D\u4EE4\uFF1A/de_coi help\uFF09\u3002',
    "guide.use.tab": "\u672C Tab\uFF1A",
    "guide.use.tabDesc": "\u300C\u4EFB\u52A1\u300D\u9875\u91CC\u586B\u9002\u914D\u5668\u3001\u4EFB\u52A1\u5185\u5BB9\u3001\u5C42\u7EA7\uFF0C\u53EF\u9009\u6062\u590D\u4F1A\u8BDD / \u4EFB\u52A1\u6A21\u677F / \u63A5\u529B\u5F15\u7528\uFF0C\u70B9\u53D1\u8D77\uFF1B\u8FDB\u5EA6\u4E0E\u8F93\u51FA\u5B9E\u65F6\u53EF\u89C1\u3002",
    "guide.scope.title": "\u4F1A\u8BDD\u5206\u5C42\uFF08\u53EF\u89C1\u8303\u56F4\uFF09",
    "guide.scope.desc": "\u4EFB\u52A1\u4E0E\u4F1A\u8BDD\u6309\u5C42\u7EA7\u5F52\u5C5E\uFF0C\u51B3\u5B9A\u8C01\u80FD\u770B\u5230\uFF1A",
    "guide.scope.temp": "\u4EC5\u53D1\u8D77\u5B83\u7684\u90A3\u4E2A\u4F1A\u8BDD\u53EF\u89C1\uFF0C\u4E00\u6B21\u6027\u4EFB\u52A1\uFF08\u6D4B\u8BD5\u9002\u914D\u5668\u7528\u8FD9\u4E2A\uFF09\u3002",
    "guide.scope.session": "\u4EC5\u53D1\u8D77\u5B83\u7684\u90A3\u4E2A\u4F1A\u8BDD\u53EF\u89C1\uFF0C\u4F1A\u8BDD\u5185\u53EF\u6062\u590D\u3002",
    "guide.scope.project": "\u8BE5\u9879\u76EE\uFF08\u76F8\u540C\u5DE5\u4F5C\u76EE\u5F55\uFF09\u7684\u6240\u6709\u4F1A\u8BDD\u53EF\u89C1\uFF0C\u53EF\u6302 git \u5206\u652F\u3002",
    "guide.scope.global": "\u6240\u6709\u4F1A\u8BDD\u53EF\u89C1\uFF0C\u957F\u671F\u4FDD\u7559\u3002",
    "guide.skill.title": "\u9002\u914D\u5668\u4E0E\u6280\u80FD",
    "guide.skill.desc": "\u6BCF\u4E2A\u9002\u914D\u5668\u5BF9\u5E94\u4E00\u4E2A\u6280\u80FD\uFF08AI \u7684\u4F7F\u7528\u6307\u5357\uFF0C\u6CE8\u5165\u6A21\u578B\u4E0A\u4E0B\u6587\uFF09\uFF1A\u5185\u7F6E\u56DB\u5BB6\u5F00\u7BB1\u5373\u7528\uFF1B\u81EA\u5B9A\u4E49 CLI \u53EF\u5728\u300C\u9002\u914D\u5668\u300D\u9875\u6DFB\u52A0\uFF08\u542B\u666E\u901A\u547D\u4EE4 plain-cli\uFF09\uFF0C\u586B\u6280\u80FD\u540D\u4E0E\u5185\u5BB9\u540E AI \u5373\u5B66\u4F1A\u8C03\u7528\u5B83\u3002\u6280\u80FD\u53EF\u5728\u300C\u6280\u80FD\u7BA1\u7406\u300DTab \u7981\u7528\uFF0C\u53EF\u5728\u9002\u914D\u5668\u9875\u300C\u6280\u80FD\u300D\u6309\u94AE\u7F16\u8F91\u3002",
    "guide.tips.title": "\u6700\u4F73\u5B9E\u8DF5",
    "guide.tips.1": "\u5206\u5DE5\uFF1A\u524D\u7AEF\u2192kimi\uFF0C\u590D\u6742\u540E\u7AEF\u2192codex\uFF0C\u5FEB\u901F\u4EFB\u52A1\u2192grok\u3002",
    "guide.tips.2": "\u63A5\u529B\u94FE\uFF1Acodex \u5199\u4EE3\u7801 \u2192 kimi review\uFF08\u53D1\u8D77\u65F6\u9009\u300C\u63A5\u529B\u5F15\u7528\u300D\uFF09\u3002",
    "guide.tips.3": "\u91CD\u8981\u4F1A\u8BDD\u8BB0\u5F97\u5907\u6CE8\uFF08\u4F1A\u8BDD\u9875\u70B9\u5907\u6CE8\uFF09\uFF0C\u6062\u590D\u65F6\u6309\u540D\u5B57\u627E\u3002",
    "guide.tips.4": "\u4EFB\u52A1\u7ED3\u675F\u53EF\u63A8\u9001\u901A\u77E5\uFF08\u914D\u7F6E\u9875\u586B\u901A\u77E5\u547D\u4EE4\uFF0C\u5982 hermes send \u63A8\u5FAE\u4FE1\uFF09\u3002",
    "guide.tips.5": "\u8BB0\u5FC6\u4E0A\u4E0B\u6587\u6CE8\u5165\uFF1A\u505A\u9879\u76EE\u5F00\u53D1\u65F6\u52FE\u9009\u300C\u6CE8\u5165 DSH \u8BB0\u5FC6\u4E0A\u4E0B\u6587\u300D\uFF0CCOI \u4F1A\u5E26\u7740\u4F60\u7684\u5168\u5C40\u89C4\u5219\u3001\u7528\u6237\u504F\u597D\u4E0E\u672C\u9879\u76EE\u5173\u952E\u8BB0\u5FC6\u5E72\u6D3B\uFF08\u6309\u5206\u652F\u8FC7\u6EE4\uFF0C\u4E0E DSH \u6CE8\u5165\u540C\u89C4\u5219\uFF09\uFF1B\u4E5F\u53EF\u81EA\u5DF1\u5148\u67E5\u9879\u76EE/\u4ECA\u65E5\u65E5\u5FD7\u518D\u9644\u4E0A\u6587\u672C\u3002",
    "guide.loop": "\u95ED\u73AF\uFF1A\u6D3E\u4EFB\u52A1 \u2192 \u5B9E\u65F6\u770B\u8FDB\u5EA6 \u2192 \u62FF\u7ED3\u679C\u7559\u6863 \u2192 \u6458\u8981\u6C89\u6DC0\u8BB0\u5FC6 \u2192 \u4F1A\u8BDD\u53EF\u6062\u590D\u518D\u63A5\u529B\u3002",
    tasks: "\u4EFB\u52A1",
    sessions: "\u4F1A\u8BDD",
    adapters: "\u9002\u914D\u5668",
    templates: "\u6A21\u677F",
    stats: "\u7EDF\u8BA1",
    config: "\u914D\u7F6E",
    loading: "\u52A0\u8F7D\u4E2D\u2026",
    refresh: "\u5237\u65B0",
    all: "\u5168\u90E8",
    none: "\uFF08\u65E0\uFF09",
    "launch.title": "\u53D1\u8D77\u4EFB\u52A1",
    "launch.expand": "\u5C55\u5F00",
    "launch.collapse": "\u6536\u8D77",
    "launch.adapter": "\u9002\u914D\u5668",
    "launch.prompt": "\u4EFB\u52A1\u5185\u5BB9",
    "launch.promptPh": "\u4F8B\u5982\uFF1A\u4FEE\u590D tests/store.test.js \u4E2D\u5931\u8D25\u7684\u7528\u4F8B\u5E76\u9A8C\u8BC1",
    "launch.scope": "\u8303\u56F4",
    "launch.session": "\u6062\u590D\u4F1A\u8BDD",
    "launch.sessionNone": "\uFF08\u65B0\u4F1A\u8BDD\uFF09",
    "launch.sessionEmpty": "\uFF08\u5F53\u524D\u9002\u914D\u5668\u6682\u65E0\u4F1A\u8BDD\uFF09",
    "launch.template": "\u6A21\u677F",
    "launch.templateNone": "\uFF08\u4E0D\u7528\u6A21\u677F\uFF09",
    "launch.ref": "\u63A5\u529B\u5F15\u7528",
    "launch.refNone": "\uFF08\u4E0D\u5F15\u7528\uFF09",
    "launch.submit": "\u53D1\u8D77",
    "launch.injectTracks": "\u6CE8\u5165 DSH \u8BB0\u5FC6\uFF08\u53EF\u9009\uFF09",
    "launch.injectTracksHint": "\u81EA\u4E3B\u9009\u62E9\u8981\u5E26\u7ED9 COI \u7684\u8BB0\u5FC6\u8F68\uFF08\u4E0E\u5C42\u7EA7 scope \u65E0\u5173\uFF0C\u4EFB\u4F55\u5C42\u7EA7\u90FD\u53EF\u6CE8\u5165\uFF09\uFF1A\u957F\u671F\u8BB0\u5FC6=\u5168\u5C40\u4E8B\u5B9E\u3001\u7528\u6237\u6863\u6848=\u4F60\u7684\u504F\u597D\u3001\u9879\u76EE\u5173\u952E\u8BB0\u5FC6=\u672C\u5DE5\u4F5C\u533A\u9879\u76EE\u6309\u5206\u652F\u8FC7\u6EE4\uFF08\u4E0D\u542B AGENTS.md\uFF09\u3002\u5185\u5BB9\u4F1A\u53D1\u7ED9\u5916\u90E8 COI \u670D\u52A1\uFF0C\u6CE8\u610F\u9690\u79C1\uFF1B\u7559\u7A7A=\u4E0D\u6CE8\u5165",
    "launch.ctxText": "\u9644\u52A0\u4E0A\u4E0B\u6587\u6587\u672C\uFF08\u53EF\u9009\uFF09",
    "launch.ctxTextPh": "\u81EA\u5DF1\u62FC\u63A5\u7684\u4E0A\u4E0B\u6587\uFF1A\u5982\u9879\u76EE\u8FDB\u5C55\u3001\u76F8\u5173\u65E5\u5FD7\u8981\u70B9\u2026\uFF08\u8D85 32KB \u81EA\u52A8\u5199\u6587\u4EF6\u5E76\u628A\u8DEF\u5F84\u544A\u8BC9 COI\uFF09",
    "launch.needPrompt": "\u4EFB\u52A1\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A",
    "launch.ok": "\u5DF2\u53D1\u8D77",
    "tasks.empty": "\u6682\u65E0\u4EFB\u52A1",
    "tasks.selectHint": "\u70B9\u51FB\u5DE6\u4FA7\u4EFB\u52A1\u67E5\u770B\u8BE6\u60C5\u4E0E\u8F93\u51FA",
    "tasks.kill": "\u7EC8\u6B62",
    "tasks.confirmKill": "\u786E\u8BA4\u7EC8\u6B62\u8BE5\u4EFB\u52A1\uFF1F",
    "tasks.killed": "\u5DF2\u7EC8\u6B62",
    "tasks.retry": "\u91CD\u8BD5",
    "tasks.retried": "\u5DF2\u91CD\u65B0\u53D1\u8D77",
    "tasks.copy": "\u590D\u5236",
    "tasks.copied": "\u5DF2\u590D\u5236",
    "tasks.copyFail": "\u590D\u5236\u5931\u8D25",
    "tasks.log": "\u8F93\u51FA\u65E5\u5FD7",
    "tasks.logEmpty": "\uFF08\u6682\u65E0\u8F93\u51FA\uFF09",
    "tasks.logFull": "\u653E\u5927",
    "tasks.prompt": "\u4EFB\u52A1\u5185\u5BB9",
    "tasks.searchPh": "\u641C\u7D22\u4EFB\u52A1\uFF08\u5185\u5BB9/\u4EFB\u52A1 id\uFF09\u2026",
    "tasks.delete": "\u5220\u9664",
    "tasks.confirmDelete": "\u5220\u9664\u8BE5\u4EFB\u52A1\uFF1F\u5C06\u79FB\u9664\u4EFB\u52A1\u8BB0\u5F55\u4E0E\u8F93\u51FA\u7559\u6863\uFF08\u5DF2\u6C89\u6DC0\u5230\u8BB0\u5FC6\u7684\u6458\u8981\u4E0D\u53D7\u5F71\u54CD\uFF1B\u88AB\u63A5\u529B\u5F15\u7528\u7684\u4EFB\u52A1\u5220\u9664\u540E\uFF0C\u65B0\u63A5\u529B\u4F1A\u63D0\u793A\u4EFB\u52A1\u4E0D\u5B58\u5728\uFF09\u3002\n\n{id}",
    "tasks.status": "\u72B6\u6001",
    "tasks.adapter": "\u9002\u914D\u5668",
    "tasks.scope": "\u8303\u56F4",
    "tasks.branch": "\u5206\u652F",
    "tasks.sessionId": "\u4F1A\u8BDD ID",
    "tasks.created": "\u521B\u5EFA\u65F6\u95F4",
    "tasks.duration": "\u8017\u65F6",
    "tasks.lastOutput": "\u6700\u540E\u8F93\u51FA",
    "tasks.exitCode": "\u9000\u51FA\u7801",
    "tasks.error": "\u9519\u8BEF",
    "sessions.filterScope": "\u8303\u56F4\u8FC7\u6EE4",
    "sessions.searchPh": "\u641C\u7D22\u2026",
    "sessions.note": "\u5907\u6CE8",
    "sessions.save": "\u4FDD\u5B58",
    "sessions.delete": "\u5220\u9664",
    "sessions.confirmDelete": "\u786E\u8BA4\u5220\u9664\u8BE5\u4F1A\u8BDD\u8BB0\u5F55\uFF1F",
    "sessions.empty": "\u6682\u65E0\u4F1A\u8BDD",
    "sessions.locked": "\u6709\u4EFB\u52A1\u5360\u7528\u4E2D",
    "sessions.lastSeen": "\u6700\u8FD1\u6D3B\u8DC3",
    "adapters.guide": "\u6307\u5357",
    "adapters.test": "\u6D4B\u8BD5",
    "adapters.testOk": "\u6D4B\u8BD5\u4EFB\u52A1\u5DF2\u53D1\u8D77",
    "adapters.skill": "\u6280\u80FD",
    "adapters.skillHint": "\u8BE5\u9002\u914D\u5668\u7684\u4F7F\u7528\u6307\u5357\u6240\u5728\u6280\u80FD\uFF1A\u5B83\u662F\u540C\u6B65\u6CE8\u5165\u7684\u771F\u5B9E\u6709\u6548\u6280\u80FD\uFF08\u6765\u6E90=\u7528\u6237\u6280\u80FD\u5E93\uFF0C\u6CE8\u5165\u6BCF\u4E2A\u4F1A\u8BDD\u7684\u7CFB\u7EDF\u63D0\u793A\u8BCD\uFF09\uFF0CAI \u6BCF\u6B21\u4F1A\u8BDD\u90FD\u80FD\u770B\u5230\uFF1B\u7981\u7528\u8BF7\u5230\u300C\u6280\u80FD\u7BA1\u7406\u300DTab",
    "adapters.skillBtn": "\u6280\u80FD",
    "adapters.editSkillTitle": "\u7F16\u8F91\u6280\u80FD\uFF08AI \u4F7F\u7528\u6307\u5357\uFF09",
    "adapters.editSkillHint": "\u6280\u80FD = AI \u7684\u4F7F\u7528\u6307\u5357\uFF1A\u672C\u6280\u80FD\u5DF2\u540C\u6B65\u6CE8\u5165\u7528\u6237\u6280\u80FD\u5E93\uFF08~/.agents/skills\uFF09\uFF0C\u6BCF\u4E2A\u4F1A\u8BDD\u7684\u7CFB\u7EDF\u63D0\u793A\u8BCD\u91CC\u90FD\u80FD\u770B\u5230\u5B83\uFF0CAI \u636E\u6B64\u6B63\u786E\u8C03\u7528\u672C\u9002\u914D\u5668\u3002\u5728\u8FD9\u91CC\u7F16\u8F91\u5373\u66F4\u65B0 SKILL.md\uFF1B\u63D2\u4EF6\u91CD\u542F\u65F6\u5185\u7F6E\u7248\u672C\u672A\u53D8\u4E0D\u4F1A\u8986\u76D6\u4F60\u7684\u7F16\u8F91\uFF1B\u7981\u7528\u5165\u53E3\u5728\u300C\u6280\u80FD\u7BA1\u7406\u300DTab\u3002",
    "adapters.saveSkill": "\u4FDD\u5B58",
    "adapters.skillSaved": "\u6280\u80FD\u5DF2\u4FDD\u5B58",
    "adapters.skillName": "\u6280\u80FD\u540D\uFF08\u53EF\u9009\uFF09",
    "adapters.skillNamePh": "\u5982 my-cli-skill\uFF08\u8BE5\u6280\u80FD\u7684 SKILL.md \u5C06\u6CE8\u5165 AI \u4E0A\u4E0B\u6587\uFF0CAI \u636E\u6B64\u5B66\u4F1A\u8C03\u7528\u6B64 CLI\uFF09",
    "adapters.useCase": "\u9002\u7528\u573A\u666F",
    "adapters.useCasePh": "\u544A\u8BC9 AI \u4EC0\u4E48\u4EFB\u52A1\u9002\u5408\u7528\u8FD9\u4E2A CLI\uFF0C\u5982\uFF1A\u590D\u6742\u540E\u7AEF\u903B\u8F91/\u6D4B\u8BD5\u4FEE\u590D\u2026",
    "adapters.useCaseEmpty": "\uFF08\u672A\u586B\u5199\u9002\u7528\u573A\u666F\uFF09",
    "adapters.editUseCase": "\u7F16\u8F91\u573A\u666F",
    "adapters.saveUseCase": "\u4FDD\u5B58",
    "adapters.skillContent": "\u6280\u80FD\u5185\u5BB9\uFF08SKILL.md\uFF09",
    "adapters.skillContentPh": "# \u6280\u80FD\u6B63\u6587\n\n\u544A\u8BC9 AI \u5982\u4F55\u8C03\u7528\u8FD9\u4E2A CLI\uFF1A\u547D\u4EE4\u683C\u5F0F\u3001\u53C2\u6570\u3001\u4F1A\u8BDD\u6062\u590D\u65B9\u5F0F\u3001\u6CE8\u610F\u4E8B\u9879\u2026\uFF08frontmatter \u7684 name/description \u4F1A\u81EA\u52A8\u8865\u5168\uFF09",
    "adapters.skillContentHint": "\u7559\u7A7A = \u53EA\u5173\u8054\u6280\u80FD\u540D\uFF08\u6280\u80FD\u6587\u4EF6\u9700\u53E6\u5916\u521B\u5EFA\uFF0C\u53EF\u6DFB\u52A0\u540E\u5230\u300C\u6280\u80FD\u300D\u6309\u94AE\u91CC\u7F16\u8F91\uFF09\uFF1B\u586B\u5199 = \u6280\u80FD\u4E0D\u5B58\u5728\u65F6\u81EA\u52A8\u521B\u5EFA",
    "cancel": "\u53D6\u6D88",
    "saving": "\u4FDD\u5B58\u4E2D\u2026",
    "adapters.addTitle": "\u6DFB\u52A0\u81EA\u5B9A\u4E49\u9002\u914D\u5668",
    "adapters.name": "\u540D\u79F0",
    "adapters.type": "\u7C7B\u578B",
    "adapters.binary": "\u53EF\u6267\u884C\u6587\u4EF6",
    "adapters.args": "\u53C2\u6570",
    "adapters.argsPh": "\u9017\u53F7\u5206\u9694\uFF0C\u5982\uFF1A-p, {task}",
    "adapters.add": "\u6DFB\u52A0",
    "adapters.delete": "\u5220\u9664",
    "adapters.enable": "\u542F\u7528",
    "adapters.disable": "\u7981\u7528",
    "adapters.disabledHint": "\u5DF2\u7981\u7528\uFF1AAI \u8C03\u5EA6\u6B64\u9002\u914D\u5668\u4F1A\u88AB\u62D2\u7EDD\u5E76\u63D0\u793A\u6362\u7528\u5176\u4ED6\u53EF\u7528\u9879",
    "adapters.confirmDelete": "\u786E\u8BA4\u5220\u9664\u8BE5\u81EA\u5B9A\u4E49\u9002\u914D\u5668\uFF1F",
    "adapters.builtin": "\u5185\u7F6E",
    "adapters.custom": "\u81EA\u5B9A\u4E49",
    "adapters.resumeSection": "\u4F1A\u8BDD\u6062\u590D\u914D\u7F6E\uFF08ai-cli \u5FC5\u586B\uFF09",
    "adapters.resumeSectionHint": "ai-cli \u7C7B\u578B\u5FC5\u987B\u6709\u6307\u5B9A\u4F1A\u8BDD\u6062\u590D\u80FD\u529B\uFF1B\u6CA1\u6709\u6062\u590D\u80FD\u529B\u7684 CLI \u8BF7\u9009 plain-cli \u7C7B\u578B",
    "adapters.resumeKind": "\u6062\u590D\u65B9\u5F0F",
    "adapters.resumeKindFlag": "flag \u6A21\u5F0F\uFF08\u6062\u590D\u53C2\u6570\u63D2\u5728\u57FA\u7840\u53C2\u6570\u524D\uFF09",
    "adapters.resumeKindArgs": "args \u6A21\u5F0F\uFF08\u5B8C\u6574\u6062\u590D\u547D\u4EE4\uFF09",
    "adapters.resumeFlag": "\u6062\u590D flag",
    "adapters.resumeFlagPh": "\u5982 -S / -r / --resume",
    "adapters.resumeArg": "\u4F1A\u8BDD\u53C2\u6570",
    "adapters.resumeArgPh": "\u542B {sessionId} \u5360\u4F4D\u7B26\uFF0C\u5982 {sessionId}",
    "adapters.resumeArgs": "\u6062\u590D\u547D\u4EE4\u53C2\u6570",
    "adapters.resumeArgsPh": "\u9017\u53F7\u5206\u9694\uFF0C\u542B {sessionId}\uFF08\u53CA\u53EF\u9009 {task}\uFF09\uFF0C\u5982 exec, resume, {sessionId}, {task}",
    "adapters.continueFlag": "\u6700\u8FD1\u4F1A\u8BDD\u6062\u590D flag\uFF08\u53EF\u9009\uFF09",
    "adapters.continueFlagPh": '\u5982 -c\uFF1B\u7559\u7A7A = \u4E0D\u652F\u6301"\u6700\u8FD1\u4F1A\u8BDD"\u6062\u590D',
    "adapters.extractSection": "\u4F1A\u8BDD ID \u81EA\u52A8\u63D0\u53D6\uFF08\u53EF\u9009\uFF09",
    "adapters.extractSource": "\u8F93\u51FA\u6D41",
    "adapters.extractRegex": "\u63D0\u53D6\u6B63\u5219",
    "adapters.extractRegexPh": "\u6355\u83B7\u7EC4 1 \u4E3A\u4F1A\u8BDD ID\uFF0C\u5982 To resume this session: kimi -r (session_\\S+)",
    "adapters.resumeMissing": "ai-cli \u7C7B\u578B\u5FC5\u987B\u586B\u5199\u4F1A\u8BDD\u6062\u590D\u914D\u7F6E\uFF08resume\uFF09",
    "templates.addTitle": "\u6DFB\u52A0\u6A21\u677F",
    "templates.name": "\u540D\u79F0",
    "templates.prompt": "\u4EFB\u52A1\u5185\u5BB9",
    "templates.adapterOpt": "\u9002\u914D\u5668\uFF08\u53EF\u9009\uFF09",
    "templates.idOpt": "ID\uFF08\u53EF\u9009\uFF0C\u4E0D\u586B\u81EA\u52A8\uFF09",
    "templates.add": "\u6DFB\u52A0",
    "templates.delete": "\u5220\u9664",
    "templates.confirmDelete": "\u786E\u8BA4\u5220\u9664\u8BE5\u6A21\u677F\uFF1F",
    "templates.builtinKeep": "\u5185\u7F6E\u6A21\u677F\u4E0D\u53EF\u5220\u9664",
    "templates.empty": "\u6682\u65E0\u6A21\u677F",
    "stats.total": "\u603B\u4EFB\u52A1\u6570",
    "stats.count": "\u4EFB\u52A1\u6570",
    "stats.hours": "\u7D2F\u8BA1\u65F6\u957F",
    "stats.byStatus": "\u72B6\u6001\u5206\u5E03",
    "stats.empty": "\u6682\u65E0\u7EDF\u8BA1\u6570\u636E",
    "config.notify": "\u901A\u77E5\u547D\u4EE4",
    "config.notifyHint": "\u4EFB\u52A1\u7ED3\u675F\u65F6\u6267\u884C\uFF1B\u5360\u4F4D\u7B26\uFF1A{taskId} {coi} {status} {summary}",
    "config.retention": "\u4EFB\u52A1\u4FDD\u7559\u5929\u6570",
    "config.timeout": "\u4EFB\u52A1\u8D85\u65F6",
    "config.timeoutHours": "\u5C0F\u65F6",
    "config.timeoutMinutes": "\u5206\u949F",
    "config.timeoutHint": "\u8D85\u65F6\u4EC5\u4F5C\u515C\u5E95\u9632\u7EBF\uFF08AI \u4EFB\u52A1\u53EF\u80FD\u6570\u5C0F\u65F6\u65E0\u8F93\u51FA\u5C5E\u6B63\u5E38\uFF09\uFF1B\u7559\u7A7A = \u4E0D\u4FEE\u6539",
    "config.timeoutBad": "\u8D85\u65F6\u683C\u5F0F\u4E0D\u6B63\u786E",
    "config.save": "\u4FDD\u5B58",
    "config.saved": "\u5DF2\u4FDD\u5B58",
    "scope.temporary": "\u4E34\u65F6",
    "scope.session": "\u4F1A\u8BDD",
    "scope.project": "\u9879\u76EE",
    "scope.global": "\u5168\u5C40"
  },
  en: {
    tab: "CLI Dispatch",
    guide: "Guide",
    "guide.title": "CLI Dispatch Guide",
    "guide.intro": "COI dispatch is an external AI agent scheduler: hand tasks to CLI agents (kimi/codex/grok/hermes\u2026) \u2014 unified non-blocking scheduling, live progress, tiered session management with one-click resume, cross-COI relay, results archived and sunk into memory. Disabled by default (enable it in the runtime config of the Memory tab).",
    "guide.use.title": "How to dispatch",
    "guide.use.desc": "Three entrances:",
    "guide.use.ai": "Tell the AI: ",
    "guide.use.aiDesc": 'say "have kimi do X / let codex fix the tests" \u2014 the AI dispatches via de_coi_dispatch and picks up the result.',
    "guide.use.slash": "Terminal: ",
    "guide.use.slashDesc": '/de_coi run "task" --coi kimi (/de_coi help for all subcommands).',
    "guide.use.tab": "This tab: ",
    "guide.use.tabDesc": "pick adapter, prompt, scope in the Tasks page; optionally resume a session / use a template / relay another task; progress and output are live.",
    "guide.scope.title": "Session tiers (visibility)",
    "guide.scope.desc": "Tasks and sessions belong to a tier that decides who can see them:",
    "guide.scope.temp": "visible only in the session that launched it; one-shot (use for adapter tests).",
    "guide.scope.session": "visible only in the launching session; resumable within it.",
    "guide.scope.project": "visible to every session of that project (same cwd); can be tagged with a git branch.",
    "guide.scope.global": "visible everywhere; long-lived.",
    "guide.skill.title": "Adapters & skills",
    "guide.skill.desc": "Every adapter maps to a skill (the AI usage guide, injected into the model context): four built-ins work out of the box; custom CLIs can be added in the Adapters page (plain-cli included) \u2014 fill the skill name and content and the AI learns how to drive it. Skills can be disabled in the Skill Manager tab and edited via the Skill button.",
    "guide.tips.title": "Best practices",
    "guide.tips.1": "Division of labor: frontend\u2192kimi, complex backend\u2192codex, quick jobs\u2192grok.",
    "guide.tips.2": "Relay chains: codex writes \u2192 kimi reviews (pick Relay when dispatching).",
    "guide.tips.3": "Note important sessions (Sessions page) so you can resume them by name.",
    "guide.tips.4": "Get notified on completion (set a notify command in Config, e.g. hermes send to WeChat).",
    "guide.tips.5": "Memory context injection: for project development tick \u201CInject DSH memory context\u201D \u2014 the COI works with your global rules, profile and this project's key facts (branch-filtered, same rules as DSH injection); you can also look up project/daily logs yourself and attach a text.",
    "guide.loop": "The loop: dispatch \u2192 watch live progress \u2192 results archived \u2192 summaries sunk into memory \u2192 sessions resumable for the next relay.",
    tasks: "Tasks",
    sessions: "Sessions",
    adapters: "Adapters",
    templates: "Templates",
    stats: "Stats",
    config: "Config",
    loading: "Loading\u2026",
    refresh: "Refresh",
    all: "All",
    none: "(none)",
    "launch.title": "Launch task",
    "launch.expand": "Expand",
    "launch.collapse": "Collapse",
    "launch.adapter": "Adapter",
    "launch.prompt": "Prompt",
    "launch.promptPh": "e.g. fix the failing cases in tests/store.test.js and verify",
    "launch.scope": "Scope",
    "launch.session": "Resume session",
    "launch.sessionNone": "(new session)",
    "launch.sessionEmpty": "(no sessions for this adapter)",
    "launch.template": "Template",
    "launch.templateNone": "(no template)",
    "launch.ref": "Relay ref",
    "launch.refNone": "(none)",
    "launch.submit": "Launch",
    "launch.injectTracks": "Inject DSH memory (optional)",
    "launch.injectTracksHint": "Pick which memory tracks to hand to the COI (independent of scope \u2014 any tier can inject): long-term memory=global facts, user profile=your preferences, project key=this workspace's key facts (branch-filtered; no AGENTS.md). Content is sent to external COI services \u2014 mind privacy; empty = no injection",
    "launch.ctxText": "Extra context text (optional)",
    "launch.ctxTextPh": "Your own context: project progress, log highlights\u2026 (over 32KB it is written to a file and the path is given to the COI)",
    "launch.needPrompt": "Prompt must not be empty",
    "launch.ok": "Launched",
    "tasks.empty": "No tasks yet",
    "tasks.selectHint": "Click a task on the left to view details and output",
    "tasks.kill": "Kill",
    "tasks.confirmKill": "Kill this task?",
    "tasks.killed": "Killed",
    "tasks.retry": "Retry",
    "tasks.retried": "Re-launched",
    "tasks.copy": "Copy",
    "tasks.copied": "Copied",
    "tasks.copyFail": "Copy failed",
    "tasks.log": "Output log",
    "tasks.logEmpty": "(no output yet)",
    "tasks.logFull": "Expand",
    "tasks.prompt": "Task prompt",
    "tasks.searchPh": "Search tasks (content / task id)\u2026",
    "tasks.delete": "Delete",
    "tasks.confirmDelete": "Delete this task? Its record and output archive will be removed (memory summaries are unaffected; relay references to it will fail afterwards).\n\n{id}",
    "tasks.status": "Status",
    "tasks.adapter": "Adapter",
    "tasks.scope": "Scope",
    "tasks.branch": "Branch",
    "tasks.sessionId": "Session ID",
    "tasks.created": "Created",
    "tasks.duration": "Duration",
    "tasks.lastOutput": "Last output",
    "tasks.exitCode": "Exit code",
    "tasks.error": "Error",
    "sessions.filterScope": "Scope filter",
    "sessions.searchPh": "Search\u2026",
    "sessions.note": "Note",
    "sessions.save": "Save",
    "sessions.delete": "Delete",
    "sessions.confirmDelete": "Delete this session record?",
    "sessions.empty": "No sessions",
    "sessions.locked": "Occupied by a task",
    "sessions.lastSeen": "Last seen",
    "adapters.guide": "Guide",
    "adapters.test": "Test",
    "adapters.testOk": "Test task launched",
    "adapters.skill": "Skill",
    "adapters.skillHint": "The skill holding this adapter's usage guide: a real injected skill (source = user skill library, injected into every session's system prompt); disable it via the Skill Manager tab",
    "adapters.skillBtn": "Skill",
    "adapters.editSkillTitle": "Edit skill (AI usage guide)",
    "adapters.editSkillHint": "The skill IS the AI usage guide: it is synced into the user skill library (~/.agents/skills) and injected into every session's system prompt, so the AI knows how to drive this adapter. Editing here updates that SKILL.md; plugin restarts will not overwrite your edits while the built-in version is unchanged; disable it via the Skill Manager tab.",
    "adapters.saveSkill": "Save",
    "adapters.skillSaved": "Skill saved",
    "adapters.skillName": "Skill name (optional)",
    "adapters.skillNamePh": "e.g. my-cli-skill (that SKILL.md will be injected into the AI context so the AI learns how to use this CLI)",
    "adapters.useCase": "Use case",
    "adapters.useCasePh": "Tell the AI which tasks suit this CLI, e.g. complex backend logic / test fixes\u2026",
    "adapters.useCaseEmpty": "(no use case set)",
    "adapters.editUseCase": "Edit",
    "adapters.saveUseCase": "Save",
    "adapters.skillContent": "Skill content (SKILL.md)",
    "adapters.skillContentPh": "# Skill body\n\nTell the AI how to drive this CLI: command format, args, session resume, caveats\u2026 (frontmatter name/description are auto-completed)",
    "adapters.skillContentHint": "Leave empty = link the skill name only (create the file later via the Skill button); filled = the skill is auto-created when missing",
    "cancel": "Cancel",
    "saving": "Saving\u2026",
    "adapters.addTitle": "Add custom adapter",
    "adapters.name": "Name",
    "adapters.type": "Type",
    "adapters.binary": "Binary",
    "adapters.args": "Args",
    "adapters.argsPh": "comma separated, e.g.: -p, {task}",
    "adapters.add": "Add",
    "adapters.delete": "Delete",
    "adapters.enable": "Enable",
    "adapters.disable": "Disable",
    "adapters.disabledHint": "Disabled: dispatching to this adapter is rejected with a hint to use another one",
    "adapters.confirmDelete": "Delete this custom adapter?",
    "adapters.builtin": "builtin",
    "adapters.custom": "custom",
    "adapters.resumeSection": "Session resume (required for ai-cli)",
    "adapters.resumeSectionHint": "ai-cli must support resuming a named session; CLIs without resume support should use plain-cli",
    "adapters.resumeKind": "Resume mode",
    "adapters.resumeKindFlag": "flag mode (resume flag + arg prepended to base args)",
    "adapters.resumeKindArgs": "args mode (full resume command)",
    "adapters.resumeFlag": "Resume flag",
    "adapters.resumeFlagPh": "e.g. -S / -r / --resume",
    "adapters.resumeArg": "Session arg",
    "adapters.resumeArgPh": "with {sessionId} placeholder, e.g. {sessionId}",
    "adapters.resumeArgs": "Resume command args",
    "adapters.resumeArgsPh": "comma separated, with {sessionId} (and optional {task}), e.g. exec, resume, {sessionId}, {task}",
    "adapters.continueFlag": "Continue-last flag (optional)",
    "adapters.continueFlagPh": "e.g. -c; leave empty = no \u201Ccontinue last session\u201D support",
    "adapters.extractSection": "Auto session-ID extraction (optional)",
    "adapters.extractSource": "Output stream",
    "adapters.extractRegex": "Extract regex",
    "adapters.extractRegexPh": "capture group 1 = session ID, e.g. To resume this session: kimi -r (session_\\S+)",
    "adapters.resumeMissing": "ai-cli requires a session resume config",
    "templates.addTitle": "Add template",
    "templates.name": "Name",
    "templates.prompt": "Prompt",
    "templates.adapterOpt": "Adapter (optional)",
    "templates.idOpt": "ID (optional, auto if empty)",
    "templates.add": "Add",
    "templates.delete": "Delete",
    "templates.confirmDelete": "Delete this template?",
    "templates.builtinKeep": "Builtin templates cannot be deleted",
    "templates.empty": "No templates",
    "stats.total": "Total tasks",
    "stats.count": "Tasks",
    "stats.hours": "Total time",
    "stats.byStatus": "By status",
    "stats.empty": "No stats yet",
    "config.notify": "Notify command",
    "config.notifyHint": "Runs when a task finishes; placeholders: {taskId} {coi} {status} {summary}",
    "config.retention": "Retention days",
    "config.timeout": "Task timeout",
    "config.timeoutHours": "hours",
    "config.timeoutMinutes": "minutes",
    "config.timeoutHint": "Timeout is a safety net only (AI agents may stay quiet for hours); leave empty to keep current",
    "config.timeoutBad": "Bad timeout format",
    "config.save": "Save",
    "config.saved": "Saved",
    "scope.temporary": "temporary",
    "scope.session": "session",
    "scope.project": "project",
    "scope.global": "global"
  }
};
var LANG = "zh";
function t(key) {
  return DICT[LANG][key] ?? DICT.en[key] ?? key;
}
var API2 = "/memory-evolve/api/coi";
async function fetchJson(path, init) {
  const res = await fetch(`${API2}${path}`, {
    headers: { "content-type": "application/json" },
    ...init
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  return body;
}
function postJson(path, body) {
  return fetchJson(path, { method: "POST", body: JSON.stringify(body ?? {}) });
}
function deleteJson(path) {
  return fetchJson(path, { method: "DELETE" });
}
function errText(err) {
  const text = err instanceof Error ? err.message : String(err);
  return text !== void 0 && text.trim() !== "" ? text : "\u64CD\u4F5C\u5931\u8D25\uFF08\u65E0\u9519\u8BEF\u8BE6\u60C5\uFF09";
}
function msgOr(text, fallback) {
  return text !== void 0 && text.trim() !== "" ? text : fallback;
}
function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}
function fmtTime(ts) {
  if (ts === null || ts === void 0) return "\u2014";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function fmtAgo(ts) {
  if (ts === null || ts === void 0) return "\u2014";
  const delta = Math.max(0, Date.now() - ts);
  if (delta < 5e3) return LANG === "zh" ? "\u521A\u521A" : "just now";
  const s = Math.floor(delta / 1e3);
  if (s < 60) return LANG === "zh" ? `${s} \u79D2\u524D` : `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return LANG === "zh" ? `${m} \u5206\u949F\u524D` : `${m}m ago`;
  const h = Math.floor(m / 60);
  return LANG === "zh" ? `${h} \u5C0F\u65F6\u524D` : `${h}h ago`;
}
function fmtDur(ms) {
  if (ms === null || ms === void 0 || ms < 0) return "\u2014";
  if (ms < 1e3) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1e3);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function trunc(text, n = 40) {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}\u2026` : one;
}
var STATUS_META = {
  queued: { icon: "\u23F3", label: LANG === "zh" ? "\u6392\u961F\u4E2D" : "Queued", cls: "coi-status-queued" },
  running: { icon: "\u23F3", label: LANG === "zh" ? "\u8FD0\u884C\u4E2D" : "Running", cls: "coi-status-running" },
  completed: { icon: "\u2705", label: LANG === "zh" ? "\u5DF2\u5B8C\u6210" : "Completed", cls: "coi-status-completed" },
  failed: { icon: "\u274C", label: LANG === "zh" ? "\u5931\u8D25" : "Failed", cls: "coi-status-failed" },
  killed: { icon: "\u{1F6D1}", label: LANG === "zh" ? "\u5DF2\u7EC8\u6B62" : "Killed", cls: "coi-status-killed" },
  interrupted: { icon: "\u26A0\uFE0F", label: LANG === "zh" ? "\u4E2D\u65AD" : "Interrupted", cls: "coi-status-interrupted" }
};
function statusMeta(status) {
  return STATUS_META[status] ?? { icon: "\u2754", label: status, cls: "" };
}
var SCOPES = ["temporary", "session", "project", "global"];
var BUILTIN_ADAPTER_IDS = /* @__PURE__ */ new Set(["kimi", "codex", "grok", "hermes"]);
var BUILTIN_TEMPLATE_IDS = /* @__PURE__ */ new Set(["review-code", "fix-tests", "summarize-logs", "architecture-analysis"]);
var TASKS_POLL_MS = 3e3;
var LOG_POLL_MS = 2e3;
var TASK_LIMIT = 50;
function NoticeLine(props) {
  if (props.notice === null) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: `coi-notice coi-notice-${props.notice.kind}`, children: props.notice.text });
}
function ErrorLine(props) {
  if (props.error === null) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-error", children: props.error });
}
function CoIView(props) {
  const sessionId = props.sessionId;
  const [sub, setSub] = (0, import_react10.useState)("tasks");
  const tabs = [
    { id: "guide", key: "guide" },
    { id: "tasks", key: "tasks" },
    { id: "sessions", key: "sessions" },
    { id: "adapters", key: "adapters" },
    { id: "templates", key: "templates" },
    { id: "stats", key: "stats" },
    { id: "config", key: "config" }
  ];
  return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-root", children: [
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-tabs", role: "tablist", children: tabs.map((tab) => /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
      "button",
      {
        type: "button",
        role: "tab",
        "aria-selected": sub === tab.id,
        className: `coi-tab${sub === tab.id ? " coi-tab-active" : ""}`,
        onClick: () => setSub(tab.id),
        children: t(tab.key)
      },
      tab.id
    )) }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-body", children: [
      sub === "guide" && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(GuidePane, {}),
      sub === "tasks" && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(TasksPane, { dsSessionId: sessionId }),
      sub === "sessions" && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(SessionsPane, { dsSessionId: sessionId }),
      sub === "adapters" && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(AdaptersPane, {}),
      sub === "templates" && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(TemplatesPane, {}),
      sub === "stats" && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(StatsPane, {}),
      sub === "config" && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(ConfigPane, {})
    ] })
  ] });
}
function GuidePane() {
  return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-pane", children: [
    /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-card-title", children: t("guide.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("p", { className: "coi-muted", children: t("guide.intro") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-card-title", children: [
        "\u{1F680} ",
        t("guide.use.title")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("p", { className: "coi-muted", children: t("guide.use.desc") }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("ul", { className: "coi-guide-list", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("strong", { children: t("guide.use.ai") }),
          t("guide.use.aiDesc")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("strong", { children: t("guide.use.slash") }),
          t("guide.use.slashDesc")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("strong", { children: t("guide.use.tab") }),
          t("guide.use.tabDesc")
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-card-title", children: [
        "\u{1F5C2}\uFE0F ",
        t("guide.scope.title")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("p", { className: "coi-muted", children: t("guide.scope.desc") }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("ul", { className: "coi-guide-list", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("strong", { children: t("scope.temporary") }),
          "\uFF1A",
          t("guide.scope.temp")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("strong", { children: t("scope.session") }),
          "\uFF1A",
          t("guide.scope.session")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("strong", { children: t("scope.project") }),
          "\uFF1A",
          t("guide.scope.project")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("strong", { children: t("scope.global") }),
          "\uFF1A",
          t("guide.scope.global")
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-card-title", children: [
        "\u{1F9ED} ",
        t("guide.skill.title")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("p", { className: "coi-muted", children: t("guide.skill.desc") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-card-title", children: [
        "\u{1F4A1} ",
        t("guide.tips.title")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("ul", { className: "coi-guide-list", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("li", { children: t("guide.tips.1") }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("li", { children: t("guide.tips.2") }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("li", { children: t("guide.tips.3") }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("li", { children: t("guide.tips.4") })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("p", { className: "coi-muted coi-pad", children: t("guide.loop") })
  ] });
}
function TasksPane({ dsSessionId }) {
  const visQs = (dsSessionId ?? "") !== "" ? `&sessionId=${encodeURIComponent(String(dsSessionId))}` : "";
  const [adapters, setAdapters] = (0, import_react10.useState)([]);
  const [templates, setTemplates] = (0, import_react10.useState)([]);
  const [sessions, setSessions] = (0, import_react10.useState)([]);
  const [refTasks, setRefTasks] = (0, import_react10.useState)([]);
  const [tasks, setTasks] = (0, import_react10.useState)(null);
  const [error, setError] = (0, import_react10.useState)(null);
  const [notice, setNotice] = (0, import_react10.useState)(null);
  const [adapterId, setAdapterId] = (0, import_react10.useState)("kimi");
  const [prompt, setPrompt] = (0, import_react10.useState)("");
  const [scope, setScope] = (0, import_react10.useState)("session");
  const [sessionId, setSessionId] = (0, import_react10.useState)("");
  const [templateId, setTemplateId] = (0, import_react10.useState)("");
  const [refTaskId, setRefTaskId] = (0, import_react10.useState)("");
  const [launching, setLaunching] = (0, import_react10.useState)(false);
  const [injectTracks, setInjectTracks] = (0, import_react10.useState)([]);
  const [ctxText, setCtxText] = (0, import_react10.useState)("");
  const [launchOpen, setLaunchOpen] = (0, import_react10.useState)(false);
  const [selectedId, setSelectedId] = (0, import_react10.useState)(null);
  const [detail, setDetail] = (0, import_react10.useState)(null);
  const [log, setLog] = (0, import_react10.useState)("");
  const [logError, setLogError] = (0, import_react10.useState)(null);
  const [copied, setCopied] = (0, import_react10.useState)(false);
  const [fullLog, setFullLog] = (0, import_react10.useState)(false);
  const [fullPrompt, setFullPrompt] = (0, import_react10.useState)(false);
  const [searchQ, setSearchQ] = (0, import_react10.useState)("");
  const logRef = (0, import_react10.useRef)(null);
  const fullLogRef = (0, import_react10.useRef)(null);
  const selectedRef = (0, import_react10.useRef)(null);
  (0, import_react10.useEffect)(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);
  const loadTasks = (0, import_react10.useCallback)(async () => {
    try {
      const q = searchQ.trim();
      const data = await fetchJson(`/tasks?limit=${TASK_LIMIT}${visQs}${q !== "" ? `&q=${encodeURIComponent(q)}` : ""}`);
      setTasks(data.tasks);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, [searchQ]);
  const loadDetail = (0, import_react10.useCallback)(async (id) => {
    try {
      const data = await fetchJson(`/tasks/${encodeURIComponent(id)}`);
      setDetail(data.task);
    } catch (err) {
      setNotice({ kind: "error", text: errText(err) });
    }
  }, []);
  const removeTask = async (id) => {
    if (!window.confirm(t("tasks.confirmDelete"))) return;
    try {
      const res = await deleteJson(`/tasks/${encodeURIComponent(id)}`);
      if (res.ok !== true) {
        setNotice({ kind: "error", text: msgOr(res.message, "\u5220\u9664\u5931\u8D25") });
        return;
      }
      setSelectedId(null);
      setDetail(null);
      void loadTasks();
      setNotice({ kind: "ok", text: res.message ?? "\u5DF2\u5220\u9664" });
    } catch (err) {
      setNotice({ kind: "error", text: errText(err) });
    }
  };
  const loadLog = (0, import_react10.useCallback)(async (id) => {
    try {
      const data = await fetchJson(`/tasks/${encodeURIComponent(id)}/log?tail=8000`);
      setLog(data.text);
      setLogError(null);
    } catch (err) {
      setLogError(errText(err));
    }
  }, []);
  (0, import_react10.useEffect)(() => {
    void loadTasks();
    const timer = setInterval(() => {
      void loadTasks();
      const id = selectedRef.current;
      if (id !== null) void loadDetail(id);
    }, TASKS_POLL_MS);
    return () => clearInterval(timer);
  }, [loadTasks, loadDetail]);
  (0, import_react10.useEffect)(() => {
    fetchJson("/adapters").then((data) => {
      setAdapters(data.adapters);
      setAdapterId((prev) => data.adapters.some((a) => a.id === prev) ? prev : data.adapters[0]?.id ?? prev);
    }).catch(() => {
    });
    fetchJson("/templates").then((data) => setTemplates(data.templates)).catch(() => {
    });
    fetchJson(`/sessions?${visQs.slice(1)}`).then((data) => setSessions(data.sessions)).catch(() => {
    });
    fetchJson(`/tasks?status=completed&limit=50${visQs}`).then((data) => setRefTasks(data.tasks)).catch(() => {
    });
  }, []);
  (0, import_react10.useEffect)(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    setDetail(null);
    setLog("");
    setLogError(null);
    void loadDetail(selectedId);
    void loadLog(selectedId);
  }, [selectedId, loadDetail, loadLog]);
  const running = detail !== null && (detail.status === "running" || detail.status === "queued");
  (0, import_react10.useEffect)(() => {
    if (selectedId === null || !running) return;
    const timer = setInterval(() => {
      void loadLog(selectedId);
      void loadDetail(selectedId);
    }, LOG_POLL_MS);
    return () => clearInterval(timer);
  }, [selectedId, running, loadLog, loadDetail]);
  (0, import_react10.useEffect)(() => {
    const el = logRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
    const full = fullLogRef.current;
    if (full !== null) full.scrollTop = full.scrollHeight;
  }, [log]);
  const applyTemplate = (id) => {
    setTemplateId(id);
    const tpl = templates.find((item) => item.id === id);
    if (tpl !== void 0) {
      setPrompt(tpl.prompt);
      if (tpl.adapterId !== void 0) setAdapterId(tpl.adapterId);
      if (tpl.scope !== void 0) setScope(tpl.scope);
    }
  };
  const launch = async () => {
    if (prompt.trim() === "") {
      setNotice({ kind: "error", text: t("launch.needPrompt") });
      return;
    }
    setLaunching(true);
    try {
      const body = { adapterId, prompt, scope };
      if (scope !== "temporary" && sessionId !== "") body.sessionId = sessionId;
      if (templateId !== "") body.templateId = templateId;
      if (refTaskId !== "") body.refTaskId = refTaskId;
      const res = await postJson("/tasks", {
        ...body,
        dsSessionId: dsSessionId ?? "",
        injectTracks: injectTracks.length > 0 ? injectTracks : void 0,
        contextText: ctxText.trim() === "" ? void 0 : ctxText
      });
      setNotice({ kind: "ok", text: `${t("launch.ok")}${res.taskId !== void 0 ? `\uFF1A${res.taskId}` : ""}` });
      setPrompt("");
      setTemplateId("");
      setRefTaskId("");
      void loadTasks();
      window.dispatchEvent(new CustomEvent("dsh-memory-evolve:badge-change"));
    } catch (err) {
      setNotice({ kind: "error", text: errText(err) });
    } finally {
      setLaunching(false);
    }
  };
  const kill = async () => {
    if (detail === null) return;
    if (!window.confirm(t("tasks.confirmKill"))) return;
    try {
      await postJson(`/tasks/${encodeURIComponent(detail.id)}/cancel`, { force: true });
      setNotice({ kind: "ok", text: t("tasks.killed") });
      void loadTasks();
      void loadDetail(detail.id);
    } catch (err) {
      const msg = errText(err);
      if (window.confirm(msg)) {
        try {
          await postJson(`/tasks/${encodeURIComponent(detail.id)}/cancel`, { force: true });
          setNotice({ kind: "ok", text: t("tasks.killed") });
          void loadTasks();
          void loadDetail(detail.id);
        } catch (err2) {
          setNotice({ kind: "error", text: errText(err2) });
        }
      }
    }
  };
  const retry = async () => {
    if (detail === null) return;
    try {
      const res = await postJson(`/tasks/${encodeURIComponent(detail.id)}/retry`);
      setNotice({ kind: "ok", text: res.message ?? `${t("tasks.retried")}${res.taskId !== void 0 ? `\uFF1A${res.taskId}` : ""}` });
      void loadTasks();
    } catch (err) {
      setNotice({ kind: "error", text: errText(err) });
    }
  };
  const copySession = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setNotice({ kind: "error", text: t("tasks.copyFail") });
    }
  };
  const detailDur = (task) => {
    if (task.startedAt === null) return null;
    if (task.finishedAt !== null) return task.finishedAt - task.startedAt;
    if (task.status === "running") return Date.now() - task.startedAt;
    return null;
  };
  return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-pane coi-tasks", children: [
    /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-card-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-card-title", children: t("launch.title") }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-grow" }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => setLaunchOpen(!launchOpen), children: launchOpen ? t("launch.collapse") : t("launch.expand") })
      ] }),
      launchOpen && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(import_jsx_runtime11.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-form-grid", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("launch.adapter") }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(
              "select",
              {
                className: "coi-select",
                value: adapterId,
                onChange: (e) => {
                  const next = e.target.value;
                  setAdapterId(next);
                  if (sessionId !== "" && !sessions.some((s) => s.id === sessionId && s.adapterId === next)) {
                    setSessionId("");
                  }
                },
                children: [
                  adapters.map((a) => /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("option", { value: a.id, children: [
                    a.name,
                    "\uFF08",
                    a.id,
                    "\uFF09"
                  ] }, a.id)),
                  adapters.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: adapterId, children: adapterId })
                ]
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("launch.scope") }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("select", { className: "coi-select", value: scope, onChange: (e) => setScope(e.target.value), children: SCOPES.map((s) => /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: s, children: t(`scope.${s}`) }, s)) })
          ] }),
          scope !== "temporary" && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("launch.session") }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("select", { className: "coi-select", value: sessionId, onChange: (e) => setSessionId(e.target.value), children: [
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: "", children: t("launch.sessionNone") }),
              sessions.filter((s) => s.adapterId === adapterId).map((s) => /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("option", { value: s.id, children: [
                s.id,
                "\uFF08",
                s.adapterId,
                s.note !== null && s.note !== "" ? ` \xB7 ${trunc(s.note, 12)}` : "",
                "\uFF09"
              ] }, s.id)),
              sessions.filter((s) => s.adapterId === adapterId).length === 0 && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: "", disabled: true, children: t("launch.sessionEmpty") })
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("launch.template") }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("select", { className: "coi-select", value: templateId, onChange: (e) => applyTemplate(e.target.value), children: [
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: "", children: t("launch.templateNone") }),
              templates.map((tpl) => /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("option", { value: tpl.id, children: [
                tpl.name,
                "\uFF08",
                tpl.id,
                "\uFF09"
              ] }, tpl.id))
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("launch.ref") }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("select", { className: "coi-select", value: refTaskId, onChange: (e) => setRefTaskId(e.target.value), children: [
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: "", children: t("launch.refNone") }),
              refTasks.map((task) => /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("option", { value: task.id, children: [
                task.id,
                " \xB7 ",
                trunc(task.prompt, 24)
              ] }, task.id))
            ] })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("launch.prompt") }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
            "textarea",
            {
              className: "coi-textarea coi-textarea-lg",
              rows: 6,
              placeholder: t("launch.promptPh"),
              value: prompt,
              onChange: (e) => setPrompt(e.target.value)
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field coi-field-wide", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-field-check", children: /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("launch.injectTracks") }) }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-muted coi-small", children: t("launch.injectTracksHint") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("label", { className: "coi-field coi-field-wide coi-inject-track-line", children: ["memory", "user", "key"].map((track) => /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("span", { className: "coi-field-check", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
            "input",
            {
              type: "checkbox",
              checked: injectTracks.includes(track),
              onChange: (e) => setInjectTracks(
                e.target.checked ? [...injectTracks, track] : injectTracks.filter((item) => item !== track)
              )
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: track })
        ] }, track)) }),
        injectTracks.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field coi-field-wide", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("launch.ctxText") }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
            "textarea",
            {
              className: "coi-textarea",
              rows: 4,
              value: ctxText,
              onChange: (e) => setCtxText(e.target.value),
              placeholder: t("launch.ctxTextPh")
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-form-actions", children: /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-primary", disabled: launching, onClick: () => void launch(), children: t("launch.submit") }) })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(NoticeLine, { notice }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-task-toolbar", children: /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
      "input",
      {
        className: "coi-input",
        placeholder: t("tasks.searchPh"),
        value: searchQ,
        onChange: (e) => setSearchQ(e.target.value)
      }
    ) }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-split", children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-task-list", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(ErrorLine, { error }),
        tasks === null && error === null && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-muted coi-pad", children: t("loading") }),
        tasks !== null && tasks.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-muted coi-pad", children: t("tasks.empty") }),
        tasks?.map((task) => {
          const meta = statusMeta(task.status);
          return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(
            "button",
            {
              type: "button",
              className: `coi-task-row${selectedId === task.id ? " coi-task-row-active" : ""}`,
              onClick: () => setSelectedId(task.id),
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: `coi-task-status ${meta.cls}`, title: meta.label, children: meta.icon }),
                /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-mono coi-task-id", children: task.id }),
                /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-task-adapter", children: task.adapterId }),
                /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-task-prompt", title: task.prompt, children: trunc(task.prompt) }),
                /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-badge", children: t("scope." + task.scope) ?? task.scope }),
                /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-muted coi-task-time", children: fmtTime(task.createdAt) })
              ]
            },
            task.id
          );
        })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-detail", children: [
        selectedId === null && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-muted coi-pad", children: t("tasks.selectHint") }),
        selectedId !== null && detail === null && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-muted coi-pad", children: t("loading") }),
        detail !== null && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(import_jsx_runtime11.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-detail-meta", children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("tasks.status") }),
              /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("span", { className: statusMeta(detail.status).cls, children: [
                statusMeta(detail.status).icon,
                " ",
                statusMeta(detail.status).label
              ] })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("tasks.adapter") }),
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { children: detail.adapterId })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("tasks.scope") }),
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-badge", children: t("scope." + detail.scope) ?? detail.scope })
            ] }),
            detail.branch !== null && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("tasks.branch") }),
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-mono", children: detail.branch })
            ] }),
            detail.sessionId !== null && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("tasks.sessionId") }),
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-mono coi-small", children: detail.sessionId }),
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => void copySession(detail.sessionId ?? ""), children: copied ? t("tasks.copied") : t("tasks.copy") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("tasks.created") }),
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { children: fmtTime(detail.createdAt) })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("tasks.duration") }),
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { children: fmtDur(detailDur(detail)) })
            ] }),
            running && detail.lastOutputAt != null && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("tasks.lastOutput") }),
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { children: fmtAgo(detail.lastOutputAt) })
            ] }),
            detail.exitCode !== null && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("tasks.exitCode") }),
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-mono", children: detail.exitCode })
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-detail-actions", children: [
            running && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("button", { type: "button", className: "coi-btn coi-btn-danger", onClick: () => void kill(), children: [
              "\u{1F6D1} ",
              t("tasks.kill")
            ] }),
            !running && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("button", { type: "button", className: "coi-btn", onClick: () => void retry(), children: [
              "\u21BB ",
              t("tasks.retry")
            ] }),
            !running && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("button", { type: "button", className: "coi-btn coi-btn-danger", onClick: () => void removeTask(detail.id), children: [
              "\u{1F5D1} ",
              t("tasks.delete")
            ] })
          ] }),
          detail.error !== null && detail.error !== "" && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-error", children: [
            t("tasks.error"),
            "\uFF1A",
            detail.error
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-log-head", children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label coi-log-title", children: t("tasks.prompt") }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => setFullPrompt(true), children: [
              "\u26F6 ",
              t("tasks.logFull")
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("pre", { className: "coi-prompt-view", children: detail.prompt }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-log-head", children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label coi-log-title", children: t("tasks.log") }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => setFullLog(true), children: [
              "\u26F6 ",
              t("tasks.logFull")
            ] })
          ] }),
          logError !== null && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-error", children: logError }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("pre", { ref: logRef, className: "coi-log", children: log === "" ? t("tasks.logEmpty") : log })
        ] })
      ] })
    ] }),
    fullPrompt && detail !== null && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-modal", onClick: () => setFullPrompt(false), children: /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-modal-box", onClick: (e) => e.stopPropagation(), children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-modal-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("span", { className: "coi-mono coi-small", children: [
          t("tasks.prompt"),
          " \u2014 ",
          detail.id
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => setFullPrompt(false), children: "\u2715" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("pre", { className: "coi-log coi-log-full coi-prompt-view-full", children: detail.prompt })
    ] }) }),
    fullLog && detail !== null && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-modal", onClick: () => setFullLog(false), children: /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-modal-box", onClick: (e) => e.stopPropagation(), children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-modal-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("span", { className: "coi-mono coi-small", children: [
          t("tasks.log"),
          " \u2014 ",
          detail.id,
          "\uFF08",
          detail.adapterId,
          " ",
          t("scope." + detail.scope) ?? detail.scope,
          "\uFF09"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => setFullLog(false), children: "\u2715" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("pre", { ref: fullLogRef, className: "coi-log coi-log-full", children: log === "" ? t("tasks.logEmpty") : log })
    ] }) })
  ] });
}
function SessionsPane({ dsSessionId }) {
  const visQs = (dsSessionId ?? "") !== "" ? `&sessionId=${encodeURIComponent(String(dsSessionId))}` : "";
  const [sessions, setSessions] = (0, import_react10.useState)(null);
  const [error, setError] = (0, import_react10.useState)(null);
  const [notice, setNotice] = (0, import_react10.useState)(null);
  const [scopeFilter, setScopeFilter] = (0, import_react10.useState)("");
  const [q, setQ] = (0, import_react10.useState)("");
  const [editId, setEditId] = (0, import_react10.useState)(null);
  const [noteDraft, setNoteDraft] = (0, import_react10.useState)("");
  const load = (0, import_react10.useCallback)(async () => {
    try {
      const params = new URLSearchParams();
      if (scopeFilter !== "") params.set("scope", scopeFilter);
      if (q.trim() !== "") params.set("q", q.trim());
      const data = await fetchJson(`/sessions?${params.toString()}${visQs}`);
      setSessions(data.sessions);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, [scopeFilter, q]);
  (0, import_react10.useEffect)(() => {
    void load();
  }, [load]);
  const saveNote = async (id) => {
    try {
      await postJson("/sessions/note", { id, note: noteDraft });
      setEditId(null);
      setNotice({ kind: "ok", text: t("config.saved") });
      void load();
    } catch (err) {
      setNotice({ kind: "error", text: errText(err) });
    }
  };
  const remove = async (id) => {
    if (!window.confirm(t("sessions.confirmDelete"))) return;
    try {
      await deleteJson(`/sessions/${encodeURIComponent(id)}`);
      void load();
    } catch (err) {
      setNotice({ kind: "error", text: errText(err) });
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-pane", children: [
    /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-toolbar", children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("select", { className: "coi-select", value: scopeFilter, onChange: (e) => setScopeFilter(e.target.value), title: t("sessions.filterScope"), children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: "", children: t("all") }),
        SCOPES.map((s) => /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: s, children: t(`scope.${s}`) }, s))
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
        "input",
        {
          className: "coi-input",
          placeholder: t("sessions.searchPh"),
          value: q,
          onChange: (e) => setQ(e.target.value)
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn", onClick: () => void load(), children: t("refresh") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(NoticeLine, { notice }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(ErrorLine, { error }),
    sessions === null && error === null && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-muted coi-pad", children: t("loading") }),
    sessions !== null && sessions.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-muted coi-pad", children: t("sessions.empty") }),
    sessions?.map((s) => /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-row-line", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-mono coi-small", children: s.id }),
        s.activeTaskId !== null && s.activeTaskId !== "" && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { title: `${t("sessions.locked")}\uFF1A${s.activeTaskId}`, children: "\u{1F512}" }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-badge", children: t("scope." + s.scope) ?? s.scope }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { children: s.adapterId }),
        s.branch !== null && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-muted coi-mono coi-small", children: s.branch }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("span", { className: "coi-muted coi-small", children: [
          t("sessions.lastSeen"),
          " ",
          fmtTime(s.lastSeen)
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-row-line", children: [
        editId === s.id ? /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(import_jsx_runtime11.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
            "input",
            {
              className: "coi-input coi-grow",
              value: noteDraft,
              onChange: (e) => setNoteDraft(e.target.value),
              placeholder: t("sessions.note")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => void saveNote(s.id), children: t("sessions.save") })
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(import_jsx_runtime11.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-muted coi-grow", children: s.note !== null && s.note !== "" ? s.note : "\u2014" }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
            "button",
            {
              type: "button",
              className: "coi-btn coi-btn-mini",
              onClick: () => {
                setEditId(s.id);
                setNoteDraft(s.note ?? "");
              },
              children: t("sessions.note")
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini coi-btn-danger", onClick: () => void remove(s.id), children: t("sessions.delete") })
      ] })
    ] }, s.id))
  ] });
}
function AdaptersPane() {
  const [adapters, setAdapters] = (0, import_react10.useState)(null);
  const [error, setError] = (0, import_react10.useState)(null);
  const [notice, setNotice] = (0, import_react10.useState)(null);
  const [guideOpen, setGuideOpen] = (0, import_react10.useState)(null);
  const [skillEditId, setSkillEditId] = (0, import_react10.useState)(null);
  const [skillEditName, setSkillEditName] = (0, import_react10.useState)("");
  const [skillContent, setSkillContent] = (0, import_react10.useState)("");
  const [skillSaving, setSkillSaving] = (0, import_react10.useState)(false);
  const [skillError, setSkillError] = (0, import_react10.useState)(null);
  const [useCaseEditId, setUseCaseEditId] = (0, import_react10.useState)(null);
  const [useCaseDraft, setUseCaseDraft] = (0, import_react10.useState)("");
  const [fId, setFId] = (0, import_react10.useState)("");
  const [fName, setFName] = (0, import_react10.useState)("");
  const [fType, setFType] = (0, import_react10.useState)("ai-cli");
  const [fBinary, setFBinary] = (0, import_react10.useState)("");
  const [fArgs, setFArgs] = (0, import_react10.useState)("");
  const [fSkill, setFSkill] = (0, import_react10.useState)("");
  const [fUseCase, setFUseCase] = (0, import_react10.useState)("");
  const [fSkillContent, setFSkillContent] = (0, import_react10.useState)("");
  const [fResumeKind, setFResumeKind] = (0, import_react10.useState)("flag");
  const [fResumeFlag, setFResumeFlag] = (0, import_react10.useState)("");
  const [fResumeArg, setFResumeArg] = (0, import_react10.useState)("");
  const [fResumeArgs, setFResumeArgs] = (0, import_react10.useState)("");
  const [fContinueFlag, setFContinueFlag] = (0, import_react10.useState)("");
  const [fExtractSource, setFExtractSource] = (0, import_react10.useState)("none");
  const [fExtractRegex, setFExtractRegex] = (0, import_react10.useState)("");
  const [adding, setAdding] = (0, import_react10.useState)(false);
  const load = (0, import_react10.useCallback)(async () => {
    try {
      const data = await fetchJson("/adapters");
      setAdapters(data.adapters);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);
  (0, import_react10.useEffect)(() => {
    void load();
  }, [load]);
  const test = async (id) => {
    try {
      const res = await postJson("/adapters/test", { id });
      setNotice({ kind: "ok", text: `${t("adapters.testOk")}${res.taskId !== void 0 ? `\uFF1A${res.taskId}` : ""}${res.message !== void 0 ? `\uFF08${res.message}\uFF09` : ""}` });
    } catch (err) {
      setNotice({ kind: "error", text: errText(err) });
    }
  };
  const remove = async (id) => {
    if (!window.confirm(t("adapters.confirmDelete"))) return;
    try {
      const res = await deleteJson(`/adapters/${encodeURIComponent(id)}`);
      if (res.ok === false) {
        setNotice({ kind: "error", text: msgOr(res.message, "ok:false") });
        return;
      }
      void load();
    } catch (err) {
      setNotice({ kind: "error", text: errText(err) });
    }
  };
  const saveUseCase = async (a) => {
    try {
      const def = { ...a, useCase: useCaseDraft.trim() };
      const res = await postJson("/adapters", { def });
      if (res.ok !== true) {
        setNotice({ kind: "error", text: msgOr(res.message, "\u4FDD\u5B58\u5931\u8D25") });
        return;
      }
      setUseCaseEditId(null);
      void load();
    } catch (err) {
      setNotice({ kind: "error", text: errText(err) });
    }
  };
  const toggleEnabled = async (a) => {
    try {
      const next = a.enabled === false;
      const res = await postJson(`/adapters/${encodeURIComponent(a.id)}/enabled`, { enabled: next });
      if (res.ok !== true) {
        setNotice({ kind: "error", text: msgOr(res.message, "\u64CD\u4F5C\u5931\u8D25") });
        return;
      }
      void load();
    } catch (err) {
      setNotice({ kind: "error", text: errText(err) });
    }
  };
  const openSkillEdit = async (a) => {
    setSkillError(null);
    setSkillEditName(a.skillName ?? "");
    setSkillContent("");
    setSkillEditId(a.id);
    try {
      const res = await fetchJson(`/adapters/${encodeURIComponent(a.id)}/skill`);
      if (res.ok !== true) {
        setSkillError(msgOr(res.message, "\u8BFB\u53D6\u5931\u8D25"));
        return;
      }
      setSkillEditName(res.skillName ?? "");
      setSkillContent(res.content ?? "");
    } catch (err) {
      setSkillError(errText(err));
    }
  };
  const saveSkill = async () => {
    if (skillEditId === null) return;
    setSkillSaving(true);
    setSkillError(null);
    try {
      const res = await fetchJson(`/adapters/${encodeURIComponent(skillEditId)}/skill`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: skillContent })
      });
      if (res.ok !== true) {
        setSkillError(msgOr(res.message, "\u4FDD\u5B58\u5931\u8D25"));
        return;
      }
      setNotice({ kind: "ok", text: res.message ?? t("adapters.skillSaved") });
      setSkillEditId(null);
      setSkillContent("");
    } catch (err) {
      setSkillError(errText(err));
    } finally {
      setSkillSaving(false);
    }
  };
  const add = async () => {
    if (fType === "ai-cli") {
      const resumeEmpty = fResumeKind === "flag" ? fResumeFlag.trim() === "" : fResumeArgs.trim() === "";
      if (resumeEmpty) {
        setNotice({ kind: "error", text: t("adapters.resumeMissing") });
        return;
      }
    }
    setAdding(true);
    try {
      const def = {
        id: fId.trim(),
        name: fName.trim(),
        type: fType,
        binary: fBinary.trim(),
        args: fArgs.split(",").map((s) => s.trim()).filter((s) => s !== ""),
        skillName: fSkill.trim() === "" ? void 0 : fSkill.trim(),
        useCase: fUseCase.trim() === "" ? void 0 : fUseCase.trim()
      };
      if (fType === "ai-cli") {
        def.resume = fResumeKind === "flag" ? { kind: "flag", flag: fResumeFlag.trim(), arg: fResumeArg.trim() === "" ? "{sessionId}" : fResumeArg.trim() } : { kind: "args", args: fResumeArgs.split(",").map((s) => s.trim()).filter((s) => s !== "") };
        if (fContinueFlag.trim() !== "") def.continue = { kind: "flag", flag: fContinueFlag.trim() };
        if (fExtractSource !== "none" && fExtractRegex.trim() !== "") {
          def.sessionIdExtract = { source: fExtractSource, regex: fExtractRegex.trim() };
        }
      }
      const skillContent2 = fSkill.trim() !== "" && fSkillContent.trim() !== "" ? fSkillContent : void 0;
      const res = await postJson("/adapters", { def, skillContent: skillContent2 });
      if (res.ok !== true) {
        setNotice({ kind: "error", text: msgOr(res.message, "\u4FDD\u5B58\u5931\u8D25") });
        return;
      }
      setNotice({ kind: "ok", text: res.skillMessage !== void 0 ? res.skillMessage : t("config.saved") });
      setFId("");
      setFName("");
      setFBinary("");
      setFArgs("");
      setFUseCase("");
      setFResumeFlag("");
      setFResumeArg("");
      setFResumeArgs("");
      setFContinueFlag("");
      setFExtractRegex("");
      void load();
    } catch (err) {
      setNotice({ kind: "error", text: errText(err) });
    } finally {
      setAdding(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-pane", children: [
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(NoticeLine, { notice }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(ErrorLine, { error }),
    adapters === null && error === null && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-muted coi-pad", children: t("loading") }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-cards", children: adapters?.map((a) => {
      const builtin = BUILTIN_ADAPTER_IDS.has(a.id);
      return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-card coi-adapter-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-row-line", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-strong", children: a.name }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-mono coi-small coi-muted", children: a.id }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-badge", children: a.type }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-badge", children: builtin ? t("adapters.builtin") : t("adapters.custom") }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-grow" }),
          a.skillName !== void 0 && a.skillName !== "" && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("span", { className: "coi-muted coi-small coi-skill-tag", title: t("adapters.skillHint"), children: [
            t("adapters.skill"),
            "\uFF1A",
            a.skillName
          ] }),
          a.skillName !== void 0 && a.skillName !== "" && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => void openSkillEdit(a), children: t("adapters.skillBtn") }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
            "button",
            {
              type: "button",
              className: `coi-btn coi-btn-mini${a.enabled === false ? " coi-btn-danger" : ""}`,
              onClick: () => void toggleEnabled(a),
              children: a.enabled === false ? t("adapters.enable") : t("adapters.disable")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => void test(a.id), children: t("adapters.test") }),
          !builtin && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini coi-btn-danger", onClick: () => void remove(a.id), children: t("adapters.delete") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-row-line coi-muted coi-small", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-mono", children: a.binary }),
          a.args.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-mono", children: a.args.join(" ") }),
          a.avgMs !== void 0 && a.avgMs > 0 && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("span", { className: "coi-avg-ms", title: "\u5386\u53F2 completed \u4EFB\u52A1\u7684\u5E73\u5747\u8017\u65F6\uFF08de_coi_adapters \u540C\u6E90\uFF09", children: [
            "\u23F1 \u5747\u8017\u65F6 ",
            (a.avgMs / 6e4).toFixed(1),
            " \u5206\u949F"
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-row-line coi-muted coi-small", children: useCaseEditId === a.id ? /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(import_jsx_runtime11.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { children: "\u{1F3AF}" }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
            "input",
            {
              className: "coi-input coi-grow",
              value: useCaseDraft,
              onChange: (e) => setUseCaseDraft(e.target.value),
              placeholder: t("adapters.useCasePh")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini coi-btn-primary", onClick: () => void saveUseCase(a), children: t("adapters.saveUseCase") }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => setUseCaseEditId(null), children: t("cancel") })
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(import_jsx_runtime11.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("span", { className: "coi-grow", children: [
            "\u{1F3AF} ",
            a.useCase !== void 0 && a.useCase !== "" ? a.useCase : t("adapters.useCaseEmpty")
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
            "button",
            {
              type: "button",
              className: "coi-btn coi-btn-mini",
              onClick: () => {
                setUseCaseEditId(a.id);
                setUseCaseDraft(a.useCase ?? "");
              },
              children: t("adapters.editUseCase")
            }
          )
        ] }) }),
        a.enabled === false && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-row-line coi-error", children: /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("span", { children: [
          "\u26D4 ",
          t("adapters.disabledHint")
        ] }) }),
        guideOpen === a.id && a.guide !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("pre", { className: "coi-guide", children: a.guide })
      ] }, a.id);
    }) }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-card-title", children: t("adapters.addTitle") }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-form-grid", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: "id" }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("input", { className: "coi-input", value: fId, onChange: (e) => setFId(e.target.value), placeholder: "my-cli" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("adapters.name") }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("input", { className: "coi-input", value: fName, onChange: (e) => setFName(e.target.value) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("adapters.type") }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("select", { className: "coi-select", value: fType, onChange: (e) => setFType(e.target.value), children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: "ai-cli", children: "ai-cli" }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: "plain-cli", children: "plain-cli" })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("adapters.binary") }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("input", { className: "coi-input", value: fBinary, onChange: (e) => setFBinary(e.target.value), placeholder: "/usr/local/bin/my-cli" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field coi-field-wide", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("adapters.args") }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("input", { className: "coi-input", value: fArgs, onChange: (e) => setFArgs(e.target.value), placeholder: t("adapters.argsPh") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field coi-field-wide", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("adapters.skillName") }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("input", { className: "coi-input", value: fSkill, onChange: (e) => setFSkill(e.target.value), placeholder: t("adapters.skillNamePh") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field coi-field-wide", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("adapters.useCase") }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("input", { className: "coi-input", value: fUseCase, onChange: (e) => setFUseCase(e.target.value), placeholder: t("adapters.useCasePh") })
        ] }),
        fType === "ai-cli" && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(import_jsx_runtime11.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-field coi-field-wide coi-resume-section", children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("adapters.resumeSection") }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-muted coi-small", children: t("adapters.resumeSectionHint") })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("adapters.resumeKind") }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("select", { className: "coi-select", value: fResumeKind, onChange: (e) => setFResumeKind(e.target.value), children: [
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: "flag", children: t("adapters.resumeKindFlag") }),
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: "args", children: t("adapters.resumeKindArgs") })
            ] })
          ] }),
          fResumeKind === "flag" ? /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(import_jsx_runtime11.Fragment, { children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("adapters.resumeFlag") }),
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("input", { className: "coi-input", value: fResumeFlag, onChange: (e) => setFResumeFlag(e.target.value), placeholder: t("adapters.resumeFlagPh") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("adapters.resumeArg") }),
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("input", { className: "coi-input", value: fResumeArg, onChange: (e) => setFResumeArg(e.target.value), placeholder: t("adapters.resumeArgPh") })
            ] })
          ] }) : /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field coi-field-wide", children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("adapters.resumeArgs") }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("input", { className: "coi-input", value: fResumeArgs, onChange: (e) => setFResumeArgs(e.target.value), placeholder: t("adapters.resumeArgsPh") })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field coi-field-wide", children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("adapters.continueFlag") }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("input", { className: "coi-input", value: fContinueFlag, onChange: (e) => setFContinueFlag(e.target.value), placeholder: t("adapters.continueFlagPh") })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-field coi-field-wide coi-resume-section", children: /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("adapters.extractSection") }) }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("adapters.extractSource") }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("select", { className: "coi-select", value: fExtractSource, onChange: (e) => setFExtractSource(e.target.value), children: [
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: "none", children: "none" }),
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: "stdout", children: "stdout" }),
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: "stderr", children: "stderr" }),
              /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: "any", children: "any" })
            ] })
          ] }),
          fExtractSource !== "none" && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field coi-field-wide", children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("adapters.extractRegex") }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("input", { className: "coi-input", value: fExtractRegex, onChange: (e) => setFExtractRegex(e.target.value), placeholder: t("adapters.extractRegexPh") })
          ] })
        ] }),
        fSkill.trim() !== "" && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field coi-field-wide", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("adapters.skillContent") }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
            "textarea",
            {
              className: "coi-textarea",
              rows: 5,
              value: fSkillContent,
              onChange: (e) => setFSkillContent(e.target.value),
              placeholder: t("adapters.skillContentPh")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-muted coi-small", children: t("adapters.skillContentHint") })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-form-actions", children: /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
        "button",
        {
          type: "button",
          className: "coi-btn coi-btn-primary",
          disabled: adding || fId.trim() === "" || fName.trim() === "" || fBinary.trim() === "" || fType === "ai-cli" && (fResumeKind === "flag" ? fResumeFlag.trim() === "" : fResumeArgs.trim() === ""),
          onClick: () => void add(),
          children: t("adapters.add")
        }
      ) })
    ] }),
    skillEditId !== null && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-modal", onClick: () => setSkillEditId(null), children: /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-modal-box", onClick: (e) => e.stopPropagation(), children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-modal-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("span", { className: "coi-small", children: [
          t("adapters.editSkillTitle"),
          "\uFF1A",
          skillEditName
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => setSkillEditId(null), children: "\u2715" })
      ] }),
      skillError !== null && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-error coi-pad", children: skillError }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-pad coi-muted coi-small", children: t("adapters.editSkillHint") }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
        "textarea",
        {
          className: "coi-textarea coi-skill-editor",
          value: skillContent,
          onChange: (e) => setSkillContent(e.target.value),
          placeholder: "# SKILL.md"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-modal-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => setSkillEditId(null), children: t("cancel") }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-primary coi-btn-mini", disabled: skillSaving, onClick: () => void saveSkill(), children: skillSaving ? t("saving") : t("adapters.saveSkill") })
      ] })
    ] }) })
  ] });
}
function TemplatesPane() {
  const [templates, setTemplates] = (0, import_react10.useState)(null);
  const [adapters, setAdapters] = (0, import_react10.useState)([]);
  const [error, setError] = (0, import_react10.useState)(null);
  const [notice, setNotice] = (0, import_react10.useState)(null);
  const [fId, setFId] = (0, import_react10.useState)("");
  const [fName, setFName] = (0, import_react10.useState)("");
  const [fPrompt, setFPrompt] = (0, import_react10.useState)("");
  const [fAdapterId, setFAdapterId] = (0, import_react10.useState)("");
  const [adding, setAdding] = (0, import_react10.useState)(false);
  const load = (0, import_react10.useCallback)(async () => {
    try {
      const data = await fetchJson("/templates");
      setTemplates(data.templates);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);
  (0, import_react10.useEffect)(() => {
    void load();
    fetchJson("/adapters").then((data) => setAdapters(data.adapters)).catch(() => {
    });
  }, [load]);
  const remove = async (id) => {
    if (BUILTIN_TEMPLATE_IDS.has(id)) {
      setNotice({ kind: "error", text: t("templates.builtinKeep") });
      return;
    }
    if (!window.confirm(t("templates.confirmDelete"))) return;
    try {
      await deleteJson(`/templates/${encodeURIComponent(id)}`);
      void load();
    } catch (err) {
      setNotice({ kind: "error", text: errText(err) });
    }
  };
  const add = async () => {
    setAdding(true);
    try {
      const def = { name: fName.trim(), prompt: fPrompt };
      if (fId.trim() !== "") def.id = fId.trim();
      if (fAdapterId !== "") def.adapterId = fAdapterId;
      await postJson("/templates", { def });
      setNotice({ kind: "ok", text: t("config.saved") });
      setFId("");
      setFName("");
      setFPrompt("");
      setFAdapterId("");
      void load();
    } catch (err) {
      setNotice({ kind: "error", text: errText(err) });
    } finally {
      setAdding(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-pane", children: [
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(NoticeLine, { notice }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(ErrorLine, { error }),
    templates === null && error === null && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-muted coi-pad", children: t("loading") }),
    templates !== null && templates.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-muted coi-pad", children: t("templates.empty") }),
    templates?.map((tpl) => /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-row-line", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-strong", children: tpl.name }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-mono coi-small coi-muted", children: tpl.id }),
        tpl.adapterId !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-badge", children: tpl.adapterId }),
        BUILTIN_TEMPLATE_IDS.has(tpl.id) && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-badge", children: t("adapters.builtin") }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-grow" }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini coi-btn-danger", onClick: () => void remove(tpl.id), children: t("templates.delete") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-row-line coi-muted", title: tpl.prompt, children: trunc(tpl.prompt, 80) })
    ] }, tpl.id)),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-card-title", children: t("templates.addTitle") }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-form-grid", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("templates.name") }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("input", { className: "coi-input", value: fName, onChange: (e) => setFName(e.target.value) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("templates.adapterOpt") }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("select", { className: "coi-select", value: fAdapterId, onChange: (e) => setFAdapterId(e.target.value), children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: "", children: t("none") }),
            adapters.map((a) => /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("option", { value: a.id, children: a.id }, a.id))
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field coi-field-wide", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("templates.idOpt") }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("input", { className: "coi-input", value: fId, onChange: (e) => setFId(e.target.value), placeholder: "my-template" })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("templates.prompt") }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("textarea", { className: "coi-textarea", rows: 3, value: fPrompt, onChange: (e) => setFPrompt(e.target.value) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-form-actions", children: /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-primary", disabled: adding || fName.trim() === "" || fPrompt.trim() === "", onClick: () => void add(), children: t("templates.add") }) })
    ] })
  ] });
}
function StatsPane() {
  const [stats, setStats] = (0, import_react10.useState)(null);
  const [error, setError] = (0, import_react10.useState)(null);
  const load = (0, import_react10.useCallback)(async () => {
    try {
      const data = await fetchJson("/stats");
      setStats(data);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);
  (0, import_react10.useEffect)(() => {
    void load();
  }, [load]);
  return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-pane", children: [
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-toolbar", children: /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn", onClick: () => void load(), children: t("refresh") }) }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(ErrorLine, { error }),
    stats === null && error === null && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-muted coi-pad", children: t("loading") }),
    stats !== null && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(import_jsx_runtime11.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-stat-grid", children: /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-stat-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-stat-num", children: stats.total }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-muted", children: t("stats.total") })
      ] }) }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-stat-grid", children: Object.entries(stats.byAdapter).map(([id, bucket]) => /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-stat-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-strong", children: id }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-stat-num", children: bucket.count }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-muted coi-small", children: [
          t("stats.count"),
          " \xB7 ",
          t("stats.hours"),
          " ",
          (bucket.totalMs / 36e5).toFixed(2),
          "h"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-row-line coi-small", children: Object.entries(bucket.byStatus).map(([status, count]) => {
          const meta = statusMeta(status);
          return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("span", { className: meta.cls, title: meta.label, children: [
            meta.icon,
            " ",
            count
          ] }, status);
        }) })
      ] }, id)) }),
      Object.keys(stats.byAdapter).length === 0 && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-muted coi-pad", children: t("stats.empty") })
    ] })
  ] });
}
function ConfigPane() {
  const [loaded, setLoaded] = (0, import_react10.useState)(false);
  const [error, setError] = (0, import_react10.useState)(null);
  const [notice, setNotice] = (0, import_react10.useState)(null);
  const [notify, setNotify] = (0, import_react10.useState)("");
  const [retention, setRetention] = (0, import_react10.useState)("");
  const [timeoutH, setTimeoutH] = (0, import_react10.useState)("");
  const [timeoutM, setTimeoutM] = (0, import_react10.useState)("");
  const [saving, setSaving] = (0, import_react10.useState)(false);
  (0, import_react10.useEffect)(() => {
    fetchJson("/config").then((data) => {
      setNotify(data.config.coiNotifyCommand ?? "");
      setRetention(String(data.config.coiRetentionDays ?? ""));
      const ms = data.config.coiTaskTimeoutMs ?? 0;
      setTimeoutH(String(Math.floor(ms / 36e5)));
      setTimeoutM(String(Math.round(ms % 36e5 / 6e4)));
      setLoaded(true);
    }).catch((err) => setError(errText(err)));
  }, []);
  const save = async () => {
    setSaving(true);
    try {
      const patch = { coiNotifyCommand: notify };
      const days = Number(retention);
      const h = Number(timeoutH);
      const m = Number(timeoutM);
      if (retention.trim() !== "" && Number.isFinite(days)) patch.coiRetentionDays = days;
      if (timeoutH.trim() !== "" || timeoutM.trim() !== "") {
        const totalMinutes = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
        if (!Number.isFinite(totalMinutes) || totalMinutes < 0) throw new Error(t("config.timeoutBad"));
        patch.coiTaskTimeoutMs = totalMinutes * 6e4;
      }
      await postJson("/config", { patch });
      setNotice({ kind: "ok", text: t("config.saved") });
    } catch (err) {
      setNotice({ kind: "error", text: errText(err) });
    } finally {
      setSaving(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-pane", children: [
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(NoticeLine, { notice }),
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(ErrorLine, { error }),
    !loaded && error === null && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-muted coi-pad", children: t("loading") }),
    loaded && /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("config.notify") }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("input", { className: "coi-input", value: notify, onChange: (e) => setNotify(e.target.value) }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-muted coi-small", children: t("config.notifyHint") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("config.retention") }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("input", { className: "coi-input", type: "number", min: 0, value: retention, onChange: (e) => setRetention(e.target.value) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("label", { className: "coi-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-label", children: t("config.timeout") }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("div", { className: "coi-inline", children: [
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("input", { className: "coi-input", type: "number", min: 0, value: timeoutH, onChange: (e) => setTimeoutH(e.target.value), placeholder: "0" }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-muted coi-small", children: t("config.timeoutHours") }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("input", { className: "coi-input", type: "number", min: 0, max: 59, value: timeoutM, onChange: (e) => setTimeoutM(e.target.value), placeholder: "0" }),
          /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-muted coi-small", children: t("config.timeoutMinutes") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: "coi-muted coi-small", children: t("config.timeoutHint") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: "coi-form-actions", children: /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("button", { type: "button", className: "coi-btn coi-btn-primary", disabled: saving, onClick: () => void save(), children: t("config.save") }) })
    ] })
  ] });
}

// src/client/CopySessionIdButton.tsx
var import_react11 = require("react");
var import_jsx_runtime12 = require("react/jsx-runtime");
function CopySessionIdButton(props) {
  const [copied, setCopied] = (0, import_react11.useState)(false);
  return /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(
    "button",
    {
      type: "button",
      className: "me-copy-session-id",
      title: props.t("header.copySessionId.title"),
      onClick: () => {
        void navigator.clipboard.writeText(props.sessionId).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }).catch(() => {
        });
      },
      children: copied ? props.t("header.copySessionId.done") : props.t("header.copySessionId")
    }
  );
}

// src/client/AliasButton.tsx
var import_react12 = require("react");
var import_jsx_runtime13 = require("react/jsx-runtime");
var ALIAS_API = "/memory-evolve/api/aliases";
function AliasButton(props) {
  const [open, setOpen] = (0, import_react12.useState)(false);
  const [name, setName] = (0, import_react12.useState)("");
  const [saving, setSaving] = (0, import_react12.useState)(false);
  const [notice, setNotice] = (0, import_react12.useState)(null);
  const openEditor = () => {
    setOpen(true);
    setNotice(null);
    void fetch(`${ALIAS_API}`).then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((data) => {
      setName(data.aliases?.[props.sessionId] ?? "");
    }).catch(() => {
    });
  };
  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const text = name.trim();
      const res = await fetch(`${ALIAS_API}/${encodeURIComponent(props.sessionId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: text })
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok !== true || body.ok !== true) throw new Error(body.message ?? `HTTP ${res.status}`);
      setNotice(text === "" ? props.t("header.setAlias.cleared") : props.t("header.setAlias.saved"));
      setOpen(false);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  const clear = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch(`${ALIAS_API}/${encodeURIComponent(props.sessionId)}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (res.ok !== true || body.ok !== true) throw new Error(body.message ?? `HTTP ${res.status}`);
      setName("");
      setNotice(props.t("header.setAlias.cleared"));
      setOpen(false);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)("span", { className: "me-alias-wrap", children: [
    /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(
      "button",
      {
        type: "button",
        className: "me-copy-session-id",
        title: props.t("header.setAlias.title"),
        onClick: () => open ? setOpen(false) : openEditor(),
        children: props.t("header.setAlias")
      }
    ),
    open && /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)("span", { className: "me-alias-editor", children: [
      /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(
        "input",
        {
          className: "me-alias-input",
          value: name,
          maxLength: 10,
          placeholder: props.t("header.setAlias.placeholder"),
          onChange: (e) => setName(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter") void save();
          },
          autoFocus: true
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("button", { type: "button", className: "me-copy-session-id", disabled: saving, onClick: () => void save(), children: props.t("header.setAlias.save") }),
      /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("button", { type: "button", className: "me-copy-session-id", disabled: saving || name === "", onClick: () => void clear(), children: props.t("header.setAlias.clear") }),
      notice !== null && /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("span", { className: "me-alias-notice", children: notice })
    ] })
  ] });
}

// src/client/HeaderActions.tsx
var import_jsx_runtime14 = require("react/jsx-runtime");
function HeaderActions(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime14.jsxs)(import_jsx_runtime14.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(CopySessionIdButton, { ...props }),
    /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(AliasButton, { ...props })
  ] });
}

// src/client/BroadcastView.tsx
var import_react13 = require("react");
var import_jsx_runtime15 = require("react/jsx-runtime");
var API3 = "/memory-evolve/api/broadcast";
var PAGE_SIZE3 = 20;
async function fetchJson2(path, init) {
  const res = await fetch(`${API3}${path}`, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
  return body;
}
function errText2(err) {
  const text = err instanceof Error ? err.message : String(err);
  return text !== void 0 && text.trim() !== "" ? text : "\u64CD\u4F5C\u5931\u8D25\uFF08\u65E0\u9519\u8BEF\u8BE6\u60C5\uFF09";
}
function fmtTime2(ts) {
  return new Date(ts).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function isRoomRef(r) {
  return r.startsWith("room:") || /^room-[0-9a-z-]+$/.test(r);
}
function recipientLabel(r, rooms, aliases) {
  if (r.startsWith("room:") || /^room-[0-9a-z-]+$/.test(r)) {
    const rid = r.startsWith("room:") ? r.slice(5) : r;
    const room = rooms.get(rid);
    return room !== void 0 ? room.name : rid;
  }
  if (r.startsWith("project:")) return r.slice(8);
  return displayName(r, aliases);
}
function shortId(id, n = 14) {
  return id.length > n ? `${id.slice(0, n)}\u2026` : id;
}
function displayName(sid, aliases) {
  const short = shortId(sid, 14);
  if (aliases[sid] !== void 0) return `${aliases[sid]}\uFF08${short}\uFF09`;
  return short;
}
function WsCoordSettings({ t: t2 }) {
  const [config, setConfig] = (0, import_react13.useState)(null);
  const [busy, setBusy] = (0, import_react13.useState)(false);
  const [error, setError] = (0, import_react13.useState)(null);
  (0, import_react13.useEffect)(() => {
    let cancelled = false;
    fetch("/memory-evolve/api/config").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((body) => {
      if (!cancelled && body.config) setConfig(body.config);
    }).catch((err) => {
      if (!cancelled) setError(errText2(err));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const patch = (key, value) => {
    setBusy(true);
    setError(null);
    fetch("/memory-evolve/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patch: { [key]: value } })
    }).then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((body) => {
      if (body.config) setConfig(body.config);
    }).catch((err) => setError(errText2(err))).finally(() => setBusy(false));
  };
  if (config === null) return /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { className: "bb-empty", children: t2("broadcast.loading") });
  const on = (k) => config[k] === true;
  return /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-settings", children: [
    /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { className: "bb-settings-title", children: t2("broadcast.settings.wsCoord.title") }),
    /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("p", { className: "bb-settings-desc", children: t2("broadcast.settings.wsCoord.desc") }),
    /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("label", { className: "me-field", children: [
      /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("span", { className: "me-field-label", children: [
        t2("broadcast.settings.wsCoord.enabled"),
        /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("em", { className: "me-field-hint", children: t2("broadcast.settings.wsCoord.enabled.hint") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
        "input",
        {
          type: "checkbox",
          className: "me-switch",
          checked: on("wsCoordEnabled"),
          disabled: busy,
          onChange: (event) => patch("wsCoordEnabled", event.target.checked)
        }
      )
    ] }),
    on("wsCoordEnabled") && /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)(import_jsx_runtime15.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("label", { className: "me-field me-field-sub", children: [
        /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("span", { className: "me-field-label", children: [
          t2("broadcast.settings.wsCoord.snapshot"),
          /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("em", { className: "me-field-hint", children: t2("broadcast.settings.wsCoord.snapshot.hint") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
          "input",
          {
            type: "checkbox",
            className: "me-switch",
            checked: on("wsCoordSnapshot"),
            disabled: busy,
            onChange: (event) => patch("wsCoordSnapshot", event.target.checked)
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("label", { className: "me-field me-field-sub", children: [
        /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("span", { className: "me-field-label", children: [
          t2("broadcast.settings.wsCoord.enforce"),
          /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("em", { className: "me-field-hint", children: t2("broadcast.settings.wsCoord.enforce.hint") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
          "input",
          {
            type: "checkbox",
            className: "me-switch",
            checked: on("wsCoordEnforceWrite"),
            disabled: busy,
            onChange: (event) => patch("wsCoordEnforceWrite", event.target.checked)
          }
        )
      ] })
    ] }),
    error !== null && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { className: "bb-error", children: error })
  ] });
}
function BroadcastView(props) {
  const { t: t2, sessionId } = props;
  const [view, setView] = (0, import_react13.useState)("messages");
  const [messages, setMessages] = (0, import_react13.useState)(null);
  const [rooms, setRooms] = (0, import_react13.useState)(null);
  const [roomMap, setRoomMap] = (0, import_react13.useState)(/* @__PURE__ */ new Map());
  const [aliases, setAliases] = (0, import_react13.useState)({});
  const [filter, setFilter] = (0, import_react13.useState)("unread");
  const [query, setQuery] = (0, import_react13.useState)("");
  const [page, setPage] = (0, import_react13.useState)(1);
  const [roomMsgFilter, setRoomMsgFilter] = (0, import_react13.useState)("unread");
  const [roomMsgQuery, setRoomMsgQuery] = (0, import_react13.useState)("");
  const [roomMsgPage, setRoomMsgPage] = (0, import_react13.useState)(1);
  const [roomQuery, setRoomQuery] = (0, import_react13.useState)("");
  const [roomStatus, setRoomStatus] = (0, import_react13.useState)("active");
  const [roomDays, setRoomDays] = (0, import_react13.useState)(0);
  const [roomPage, setRoomPage] = (0, import_react13.useState)(1);
  const [expanded, setExpanded] = (0, import_react13.useState)(null);
  const [fullText, setFullText] = (0, import_react13.useState)({});
  const [openImage, setOpenImage] = (0, import_react13.useState)(null);
  const [openRoom, setOpenRoom] = (0, import_react13.useState)(null);
  const [roomMsgExpanded, setRoomMsgExpanded] = (0, import_react13.useState)(null);
  const [presence, setPresence] = (0, import_react13.useState)({});
  const [error, setError] = (0, import_react13.useState)(null);
  const [notice, setNotice] = (0, import_react13.useState)(null);
  const [copied, setCopied] = (0, import_react13.useState)("");
  const load = (0, import_react13.useCallback)(async () => {
    try {
      const [m, r, a] = await Promise.all([
        fetchJson2("/messages"),
        fetchJson2("/rooms"),
        fetch("/memory-evolve/api/aliases").then((res) => res.ok ? res.json() : { aliases: {} })
      ]);
      setMessages(m.messages);
      setRooms(r.rooms);
      setRoomMap(new Map(r.rooms.map((room) => [room.id, room])));
      setAliases(a.aliases ?? {});
      setError(null);
    } catch (err) {
      setError(errText2(err));
    }
  }, []);
  (0, import_react13.useEffect)(() => {
    void load();
    const timer = setInterval(() => void load(), 3e4);
    return () => clearInterval(timer);
  }, [load]);
  const directMessages = (0, import_react13.useMemo)(() => {
    const items = messages ?? [];
    return items.filter((m) => !m.recipients.some((r) => isRoomRef(r)));
  }, [messages]);
  const filteredMessages = (0, import_react13.useMemo)(() => {
    let items = directMessages;
    if (filter === "unread") items = items.filter((m) => m.readBy.length === 0);
    if (filter === "read") items = items.filter((m) => m.readBy.length > 0);
    if (query.trim() !== "") {
      const q = query.trim().toLowerCase();
      items = items.filter((m) => m.subject.toLowerCase().includes(q) || m.sender.toLowerCase().includes(q) || m.content.toLowerCase().includes(q));
    }
    return items;
  }, [directMessages, filter, query]);
  const totalPages = Math.max(1, Math.ceil(filteredMessages.length / PAGE_SIZE3));
  const pageItems = filteredMessages.slice((page - 1) * PAGE_SIZE3, page * PAGE_SIZE3);
  const roomMessages = (0, import_react13.useMemo)(() => {
    if (openRoom === null || messages === null) return [];
    return messages.filter((m) => m.recipients.includes(`room:${openRoom}`) || m.recipients.includes(openRoom));
  }, [openRoom, messages]);
  const filteredRoomMessages = (0, import_react13.useMemo)(() => {
    let items = roomMessages;
    if (roomMsgFilter === "unread") items = items.filter((m) => m.readBy.length === 0);
    if (roomMsgFilter === "read") items = items.filter((m) => m.readBy.length > 0);
    if (roomMsgQuery.trim() !== "") {
      const q = roomMsgQuery.trim().toLowerCase();
      items = items.filter((m) => m.subject.toLowerCase().includes(q) || m.sender.toLowerCase().includes(q) || m.content.toLowerCase().includes(q));
    }
    return items;
  }, [roomMessages, roomMsgFilter, roomMsgQuery]);
  const roomTotalPages = Math.max(1, Math.ceil(filteredRoomMessages.length / PAGE_SIZE3));
  const roomPageItems = filteredRoomMessages.slice((roomMsgPage - 1) * PAGE_SIZE3, roomMsgPage * PAGE_SIZE3);
  const filteredRooms = (0, import_react13.useMemo)(() => {
    const items = rooms ?? [];
    const q = roomQuery.trim().toLowerCase();
    const since = roomDays > 0 ? Date.now() - roomDays * 864e5 : 0;
    return items.filter((r) => roomStatus === "all" || r.status === roomStatus).filter((r) => q === "" || r.name.toLowerCase().includes(q)).filter((r) => since === 0 || r.createdAt >= since);
  }, [rooms, roomQuery, roomStatus, roomDays]);
  const roomListTotalPages = Math.max(1, Math.ceil(filteredRooms.length / PAGE_SIZE3));
  const roomListPageItems = filteredRooms.slice((roomPage - 1) * PAGE_SIZE3, roomPage * PAGE_SIZE3);
  const deleteMessage = async (msg) => {
    if (!window.confirm(t2("broadcast.message.deleteConfirm", { subject: msg.subject }))) return;
    try {
      await fetchJson2(`/messages/${encodeURIComponent(msg.id)}`, { method: "DELETE" });
      setNotice({ kind: "ok", text: t2("broadcast.message.deleted") });
      void load();
    } catch (err) {
      setNotice({ kind: "error", text: errText2(err) });
    }
  };
  const toggleExpand = async (msg, expandId, setExpandId) => {
    if (expandId === msg.id) {
      setExpandId(null);
      return;
    }
    setExpandId(msg.id);
    if (fullText[msg.id] === void 0) {
      try {
        const res = await fetchJson2(`/messages/${encodeURIComponent(msg.id)}/content`);
        setFullText((prev) => ({ ...prev, [msg.id]: res.content }));
      } catch (err) {
        setNotice({ kind: "error", text: errText2(err) });
      }
    }
  };
  const toggleRoom = async (room) => {
    if (openRoom === room.id) {
      setOpenRoom(null);
      setRoomMsgExpanded(null);
      setRoomMsgFilter("unread");
      setRoomMsgQuery("");
      setRoomMsgPage(1);
      return;
    }
    setOpenRoom(room.id);
    setRoomMsgExpanded(null);
    setRoomMsgFilter("unread");
    setRoomMsgQuery("");
    setRoomMsgPage(1);
    try {
      const res = await fetchJson2(`/rooms/${encodeURIComponent(room.id)}/presence`);
      setPresence((prev) => ({ ...prev, [room.id]: res.presence }));
    } catch (err) {
      setNotice({ kind: "error", text: errText2(err) });
    }
  };
  const kickMember = async (room, member) => {
    if (!window.confirm(t2("broadcast.room.kickConfirm", { member }))) return;
    try {
      await fetchJson2(`/rooms/${encodeURIComponent(room.id)}/kick`, {
        method: "POST",
        body: JSON.stringify({ member })
      });
      setNotice({ kind: "ok", text: t2("broadcast.room.kick") });
      void load();
      setOpenRoom(null);
    } catch (err) {
      setNotice({ kind: "error", text: errText2(err) });
    }
  };
  const dissolveRoom = async (room) => {
    if (!window.confirm(t2("broadcast.room.dissolveConfirm", { name: room.name }))) return;
    try {
      const res = await fetchJson2(`/rooms/${encodeURIComponent(room.id)}/dissolve`, { method: "POST" });
      if (res.ok !== true) {
        setNotice({ kind: "error", text: res.message ?? "\u64CD\u4F5C\u5931\u8D25" });
        return;
      }
      setNotice({ kind: "ok", text: t2("broadcast.room.dissolved") });
      void load();
    } catch (err) {
      setNotice({ kind: "error", text: errText2(err) });
    }
  };
  const copyText = (text, key) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      window.setTimeout(() => setCopied(""), 1500);
    }).catch(() => {
    });
  };
  const renderMsgCard = (m, expandId, setExpandId) => {
    const from = m.sender === "system" ? "\u7CFB\u7EDF" : displayName(m.sender, aliases);
    const to = m.recipients.map((r) => recipientLabel(r, roomMap, aliases)).join(", ");
    const unread = m.readBy.length === 0;
    const isOpen = expandId === m.id;
    return /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("span", { className: "bb-strong", children: m.subject || "\uFF08\u65E0\u4E3B\u9898\uFF09" }),
        /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("span", { className: `bb-badge${unread ? " bb-badge-unread" : " bb-badge-read"}`, children: unread ? t2("broadcast.msg.unread") : t2("broadcast.msg.read") }),
        m.hasBody && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("span", { className: "bb-badge bb-badge-long", children: t2("broadcast.messages.long") }),
        /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("span", { className: "bb-grow" }),
        /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("span", { className: "bb-muted bb-small", children: fmtTime2(m.createdAt) }),
        /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("button", { type: "button", className: "bb-btn bb-btn-mini", onClick: () => void toggleExpand(m, expandId, setExpandId), children: isOpen ? t2("broadcast.message.collapse") : t2("broadcast.message.expand") }),
        /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("button", { type: "button", className: "bb-btn bb-btn-mini bb-btn-danger", onClick: () => void deleteMessage(m), children: t2("broadcast.message.delete") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-muted bb-small", title: m.sender === "system" ? void 0 : m.sender, children: [
        t2("broadcast.messages.sender"),
        "\uFF1A",
        from,
        " \xB7 ",
        t2("broadcast.messages.to"),
        "\uFF1A",
        to
      ] }),
      isOpen && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("pre", { className: "bb-content", children: fullText[m.id] ?? m.content }),
      Array.isArray(m.attachments) && m.attachments.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { className: "bb-attachments", children: m.attachments.map((a, i) => {
        const key = `${m.id}:${i}`;
        const src = `${API3}/messages/${encodeURIComponent(m.id)}/attachment/${i}`;
        const open = openImage === key;
        return /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-att-item", children: [
          /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
            "button",
            {
              type: "button",
              className: "bb-att-thumb",
              title: `${a.name}\uFF08${(a.size / 1024).toFixed(0)} KB\uFF09`,
              onClick: () => setOpenImage(open ? null : key),
              children: /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("img", { src, alt: a.name, loading: "lazy", className: "bb-att-thumb-img" })
            }
          ),
          open && /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-att-preview", onClick: () => setOpenImage(null), children: [
            /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("img", { src, alt: a.name, className: "bb-att-preview-img" }),
            /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("span", { className: "bb-att-preview-name", children: a.name })
          ] })
        ] }, key);
      }) })
    ] }, m.id);
  };
  const renderToolbar = (currentFilter, onFilter, currentQuery, onQuery) => /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-toolbar", children: [
    ["unread", "all", "read"].map((f) => /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
      "button",
      {
        type: "button",
        className: `bb-chip${currentFilter === f ? " bb-chip-active" : ""}`,
        onClick: () => onFilter(f),
        children: t2(`broadcast.filter.${f}`)
      },
      f
    )),
    /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
      "input",
      {
        className: "bb-search",
        placeholder: t2("broadcast.searchPh"),
        value: currentQuery,
        onChange: (e) => onQuery(e.target.value)
      }
    )
  ] });
  const renderPager = (currentPage, total, onPage) => {
    if (total <= 1) return null;
    return /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-pager", children: [
      /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("button", { type: "button", className: "bb-btn bb-btn-mini", disabled: currentPage <= 1, onClick: () => onPage(currentPage - 1), children: t2("broadcast.pagePrev") }),
      /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("span", { className: "bb-muted bb-small", children: t2("broadcast.pageInfo", { page: currentPage, total }) }),
      /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("button", { type: "button", className: "bb-btn bb-btn-mini", disabled: currentPage >= total, onClick: () => onPage(currentPage + 1), children: t2("broadcast.pageNext") })
    ] });
  };
  const myAlias = aliases[sessionId];
  const renderGuide = () => /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(TabGuideView, { sections: [
    { icon: "\u{1F4E8}", title: t2("broadcast.guide.intro.title"), body: t2("broadcast.guide.intro.body") },
    { icon: "\u2709\uFE0F", title: t2("broadcast.guide.send.title"), body: t2("broadcast.guide.send.body"), items: [t2("broadcast.guide.send.item1"), t2("broadcast.guide.send.item2"), t2("broadcast.guide.send.item3")] },
    { icon: "\u{1F4E5}", title: t2("broadcast.guide.inbox.title"), body: t2("broadcast.guide.inbox.body"), items: [t2("broadcast.guide.inbox.item1"), t2("broadcast.guide.inbox.item2"), t2("broadcast.guide.inbox.item3")] },
    { icon: "\u{1F465}", title: t2("broadcast.guide.room.title"), body: t2("broadcast.guide.room.body"), items: [t2("broadcast.guide.room.item1"), t2("broadcast.guide.room.item2"), t2("broadcast.guide.room.item3")] },
    { icon: "\u{1F3F7}\uFE0F", title: t2("broadcast.guide.alias.title"), body: t2("broadcast.guide.alias.body"), items: [t2("broadcast.guide.alias.item1"), t2("broadcast.guide.alias.item2")] },
    { icon: "\u2699\uFE0F", title: t2("broadcast.guide.switch.title"), body: t2("broadcast.guide.switch.body") }
  ] });
  return /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-pane", children: [
    /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "mt-file-tabs", role: "tablist", children: [
      /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": view === "guide",
          className: view === "guide" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setView("guide"),
          children: t2("broadcast.tab.guide")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": view === "messages",
          className: view === "messages" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setView("messages"),
          children: t2("broadcast.tab.messages")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": view === "rooms",
          className: view === "rooms" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setView("rooms"),
          children: t2("broadcast.tab.rooms")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": view === "settings",
          className: view === "settings" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setView("settings"),
          children: t2("broadcast.tab.settings")
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-session-line", title: sessionId, children: [
      /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("span", { className: "bb-session-label", children: [
        t2("broadcast.mySessionId"),
        "\uFF1A"
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("code", { className: "bb-mono", children: myAlias !== void 0 ? `${myAlias}\uFF08${shortId(sessionId)}\uFF09` : shortId(sessionId) }),
      /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("button", { type: "button", className: "bb-btn bb-btn-mini", onClick: () => copyText(sessionId, "id"), children: copied === "id" ? t2("broadcast.copied") : t2("broadcast.copyId") }),
      myAlias !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("button", { type: "button", className: "bb-btn bb-btn-mini", onClick: () => copyText(myAlias, "alias"), children: copied === "alias" ? t2("broadcast.copied") : t2("broadcast.copyAlias") })
    ] }),
    notice !== null && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { className: `bb-notice bb-notice-${notice.kind}`, children: notice.text }),
    error !== null && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { className: "bb-error", children: error }),
    view === "guide" && renderGuide(),
    view === "settings" && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(WsCoordSettings, { t: t2 }),
    view === "messages" && /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-list", children: [
      messages === null && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { className: "bb-empty", children: t2("broadcast.loading") }),
      messages !== null && /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)(import_jsx_runtime15.Fragment, { children: [
        renderToolbar(
          filter,
          (f) => {
            setFilter(f);
            setPage(1);
          },
          query,
          (q) => {
            setQuery(q);
            setPage(1);
          }
        ),
        directMessages.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-empty", children: [
          t2("broadcast.messages.empty"),
          messages.some((m) => m.recipients.some((r) => isRoomRef(r))) && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { className: "bb-hint", children: t2("broadcast.messages.roomInRooms") })
        ] }),
        directMessages.length > 0 && filteredMessages.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { className: "bb-empty", children: t2("broadcast.messages.empty") }),
        pageItems.map((m) => renderMsgCard(m, expanded, setExpanded)),
        renderPager(page, totalPages, setPage)
      ] })
    ] }),
    view === "rooms" && /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-list", children: [
      rooms === null && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { className: "bb-empty", children: t2("broadcast.loading") }),
      rooms !== null && /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)(import_jsx_runtime15.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-toolbar", children: [
          ["all", "active", "dissolved"].map((s) => /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
            "button",
            {
              type: "button",
              className: `bb-chip${roomStatus === s ? " bb-chip-active" : ""}`,
              onClick: () => {
                setRoomStatus(s);
                setRoomPage(1);
              },
              children: t2(`broadcast.roomStatus.${s}`)
            },
            s
          )),
          [0, 7, 30].map((d) => /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
            "button",
            {
              type: "button",
              className: `bb-chip${roomDays === d ? " bb-chip-active" : ""}`,
              onClick: () => {
                setRoomDays(d);
                setRoomPage(1);
              },
              children: t2(`broadcast.roomDays.${d}`)
            },
            d
          )),
          /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
            "input",
            {
              className: "bb-search",
              placeholder: t2("broadcast.roomSearchPh"),
              value: roomQuery,
              onChange: (e) => {
                setRoomQuery(e.target.value);
                setRoomPage(1);
              }
            }
          )
        ] }),
        filteredRooms.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { className: "bb-empty", children: t2("broadcast.rooms.empty") }),
        roomListPageItems.map((room) => {
          const dissolved = room.status === "dissolved";
          const online = room.onlineCount > 0 && !dissolved;
          const statusLabel2 = dissolved ? t2("broadcast.room.status.dissolved") : online ? t2("broadcast.room.status.active") : t2("broadcast.room.status.idle");
          const members = presence[room.id] ?? room.members.map((sid) => ({ sessionId: sid, status: "unknown", online: false, lastActiveAt: null }));
          const isOpen = openRoom === room.id;
          return /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: `bb-card${isOpen ? " bb-card-open" : ""}${dissolved ? " bb-card-dissolved" : ""}`, children: [
            /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("span", { className: `bb-dot${online ? " bb-dot-on" : dissolved ? " bb-dot-off" : " bb-dot-idle"}` }),
              /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("span", { className: "bb-strong", children: room.name }),
              /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("span", { className: `bb-badge${dissolved ? " bb-badge-dissolved" : online ? " bb-badge-online" : ""}`, children: statusLabel2 }),
              /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("span", { className: "bb-badge", children: t2("broadcast.room.online", { online: room.onlineCount, total: room.members.length }) }),
              /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("span", { className: "bb-grow" }),
              /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("span", { className: "bb-muted bb-small", children: [
                t2("broadcast.room.lastActive"),
                "\uFF1A",
                fmtTime2(room.lastActiveAt)
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("button", { type: "button", className: "bb-btn bb-btn-detail", onClick: () => void toggleRoom(room), children: isOpen ? t2("broadcast.message.collapse") : t2("broadcast.room.detail") }),
              !dissolved && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("button", { type: "button", className: "bb-btn bb-btn-mini bb-btn-danger", onClick: () => void dissolveRoom(room), children: t2("broadcast.room.dissolve") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-meta", children: [
              /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("code", { className: "bb-mono bb-small", children: room.id }),
              /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("span", { className: "bb-muted bb-small", children: [
                "\xB7 ",
                t2("broadcast.room.created"),
                " ",
                fmtTime2(room.createdAt),
                " \xB7 ",
                room.members.length,
                " ",
                t2("broadcast.room.members")
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("button", { type: "button", className: "bb-btn bb-btn-mini", onClick: () => copyText(room.id, `room-${room.id}`), children: t2("broadcast.room.copyId") })
            ] }),
            isOpen && /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)(import_jsx_runtime15.Fragment, { children: [
              /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-members", children: [
                /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { className: "bb-section-title", children: t2("broadcast.room.members") }),
                members.map((p) => /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-row bb-member", title: p.sessionId, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("span", { className: `bb-dot${p.online ? " bb-dot-on" : " bb-dot-idle"}` }),
                  /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("code", { className: "bb-mono", children: displayName(p.sessionId, aliases) }),
                  /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("span", { className: "bb-muted bb-small", children: [
                    p.online ? "running" : p.status === "idle" ? "idle" : t2("broadcast.room.presence.unknown"),
                    p.lastActiveAt !== null ? ` \xB7 ${fmtTime2(p.lastActiveAt)}` : ""
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("span", { className: "bb-grow" }),
                  !dissolved && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("button", { type: "button", className: "bb-btn bb-btn-mini bb-btn-danger", onClick: () => void kickMember(room, p.sessionId), children: t2("broadcast.room.kick") })
                ] }, p.sessionId))
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-room-msgs", children: [
                /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)("div", { className: "bb-section-title", children: [
                  t2("broadcast.room.messages"),
                  /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("span", { className: "bb-count", children: roomMessages.length })
                ] }),
                renderToolbar(
                  roomMsgFilter,
                  (f) => {
                    setRoomMsgFilter(f);
                    setRoomMsgPage(1);
                  },
                  roomMsgQuery,
                  (q) => {
                    setRoomMsgQuery(q);
                    setRoomMsgPage(1);
                  }
                ),
                roomMessages.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { className: "bb-empty bb-empty-sm", children: t2("broadcast.room.messages.empty") }),
                roomMessages.length > 0 && filteredRoomMessages.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)("div", { className: "bb-empty bb-empty-sm", children: t2("broadcast.room.messages.empty") }),
                roomPageItems.map((m) => renderMsgCard(m, roomMsgExpanded, setRoomMsgExpanded)),
                renderPager(roomMsgPage, roomTotalPages, setRoomMsgPage)
              ] })
            ] })
          ] }, room.id);
        }),
        renderPager(roomPage, roomListTotalPages, setRoomPage)
      ] })
    ] })
  ] });
}

// src/client/ScratchView.tsx
var import_react14 = require("react");
var import_jsx_runtime16 = require("react/jsx-runtime");
var DEBOUNCE_MS = 800;
var RETRY_MS = 3e3;
var DICT2 = {
  zh: {
    // 「指南」子 tab：临时信息功能的详细介绍（本 Tab 专属）。
    guide: "\u6307\u5357",
    note: "\u4FBF\u7B7E",
    guideIntro: "\u4E34\u65F6\u4FE1\u606F Tab = \u4E00\u4E2A\u6301\u4E45\u5316\u7684 Markdown \u4FBF\u7B7E\uFF1A\u4E34\u65F6\u60F3\u6CD5\u3001\u968F\u624B\u8BB0\u90FD\u653E\u8FD9\u91CC\u2014\u2014\u81EA\u52A8\u4FDD\u5B58\u3001\u91CD\u542F\u4E0D\u4E22\uFF0C\u6574\u7406\u5B8C\u6210\u540E\u8FC1\u79FB\u5230\u522B\u5904\u6216\u5220\u9664\u5373\u53EF\u3002",
    guideSaveTitle: "\u81EA\u52A8\u4FDD\u5B58",
    guideSaveBody: "\u505C\u6B62\u8F93\u5165\u7EA6 0.8 \u79D2\u81EA\u52A8\u843D\u76D8\uFF08\u4E32\u884C\u4FDD\u5B58\u961F\u5217\uFF0C\u5931\u8D25\u540E 3 \u79D2\u81EA\u52A8\u91CD\u8BD5\uFF09\uFF1B\u5207\u8D70 Tab / \u5173\u9875\u9762\u524D\u5F3A\u5236\u4FDD\u5B58\uFF0C\u65E0\u9700\u624B\u52A8\u64CD\u4F5C\u3002",
    guideFreeTitle: "\u81EA\u7531\u6587\u672C",
    guideFreeBody: "\u4E0E \xA7 \u5206\u9694\u7684\u7ED3\u6784\u5316\u8BB0\u5FC6\u6587\u4EF6\u5B8C\u5168\u65E0\u5173\uFF1A\u5185\u5BB9\u662F\u81EA\u7531\u6587\u672C\uFF08Markdown\uFF09\uFF0C\u968F\u610F\u7F16\u8F91\u4E0D\u7834\u574F\u4EFB\u4F55\u89E3\u6790\u683C\u5F0F\u3002",
    guideLimitTitle: "\u4E0A\u9650\u4E0E\u4FDD\u62A4",
    guideLimitBody: "\u5185\u5BB9\u4E0A\u9650 512 KiB\uFF0C**\u539F\u5B50\u5199**\u4FDD\u62A4\uFF08\u5148\u5199\u4E34\u65F6\u6587\u4EF6\u518D rename\uFF09\uFF1B\u8D85\u9650 / \u975E UTF-8 \u65F6\u53EA\u8BFB\u4FDD\u62A4\u4E0D\u8986\u76D6\u3002",
    guideOpenTitle: "\u6253\u5F00\u6587\u4EF6",
    guideOpenBody: "\u4E00\u952E\u7528\u7CFB\u7EDF\u7F16\u8F91\u5668 / \u8BBF\u8FBE\u6253\u5F00 scratch.md\uFF08\u590D\u7528\u5BBF\u4E3B reveal \u901A\u9053\uFF09\uFF1B\u5185\u5BB9\u4FDD\u5B58\u5728 ~/.dsh/memories/scratch.md\u3002",
    help: "\u4E34\u65F6\u60F3\u6CD5\u3001\u968F\u624B\u8BB0\u90FD\u653E\u8FD9\u91CC\uFF08Markdown \u683C\u5F0F\uFF09\uFF1A\u5185\u5BB9\u81EA\u52A8\u4FDD\u5B58\u5230 ~/.dsh/memories/scratch.md\uFF0C\u91CD\u542F\u4E0D\u4E22\uFF1B\u6574\u7406\u5B8C\u6210\u540E\u8FC1\u79FB\u5230\u522B\u5904\u6216\u5220\u9664\u5373\u53EF\u3002",
    placeholder: "\u5199\u4E0B\u4E34\u65F6\u7684\u60F3\u6CD5\u2026\n\n\u652F\u6301 Markdown \u683C\u5F0F\uFF1B\u505C\u6B62\u8F93\u5165\u540E\u81EA\u52A8\u4FDD\u5B58\uFF0C\u968F\u65F6\u56DE\u6765\u7EE7\u7EED\u5199\u3002",
    saving: "\u4FDD\u5B58\u4E2D\u2026",
    dirty: "\u7F16\u8F91\u4E2D\uFF0C\u5373\u5C06\u81EA\u52A8\u4FDD\u5B58\u2026",
    saveFailed: "\u4FDD\u5B58\u5931\u8D25\uFF1A{message}\uFF08\u7A0D\u540E\u81EA\u52A8\u91CD\u8BD5\uFF09",
    loadFailed: "\u8BFB\u53D6\u5931\u8D25\uFF1A{message}",
    loading: "\u52A0\u8F7D\u4E2D\u2026",
    retry: "\u91CD\u8BD5",
    remoteChanged: "\u68C0\u6D4B\u5230\u5176\u4ED6\u7A97\u53E3/\u5916\u90E8\u4FEE\u6539\u4E86\u4FBF\u7B7E\u5185\u5BB9\uFF1B\u5F53\u524D\u672A\u4FDD\u5B58\u7684\u7F16\u8F91\u5728\u4FDD\u5B58\u65F6\u4F1A\u8986\u76D6\u8FDC\u7A0B\u5185\u5BB9\u3002",
    open: "\u7528\u7CFB\u7EDF\u5DE5\u5177\u6253\u5F00",
    openFailed: "\u6253\u5F00\u5931\u8D25\uFF1A{message}",
    savedAt: "\u5DF2\u4FDD\u5B58 {time}",
    neverSaved: "\u8FD8\u6CA1\u6709\u4FDD\u5B58\u8FC7"
  },
  en: {
    // "Guide" sub-tab: detailed introduction of the scratch-pad feature.
    guide: "Guide",
    note: "Note",
    guideIntro: "The Scratch Pad tab = a persistent Markdown note: jot down temporary thoughts here \u2014 auto-saved, survives restarts, and can be migrated elsewhere or deleted once it has served its purpose.",
    guideSaveTitle: "Auto-save",
    guideSaveBody: "Saves automatically ~0.8s after you stop typing (serialized save queue, retries every 3s on failure); forces a save when you leave the tab or close the page \u2014 no manual saving needed.",
    guideFreeTitle: "Free-form text",
    guideFreeBody: "Unrelated to the \xA7-delimited structured memory files: content is free-form Markdown; editing it can never break any parser format.",
    guideLimitTitle: "Limit & protection",
    guideLimitBody: "512 KiB cap with **atomic writes** (temp file then rename); read-only protection when over the cap or not UTF-8.",
    guideOpenTitle: "Open the file",
    guideOpenBody: "One click opens scratch.md with your system editor / Finder (reuses the host reveal channel); content lives in ~/.dsh/memories/scratch.md.",
    help: "Jot down temporary ideas (Markdown). Content auto-saves to ~/.dsh/memories/scratch.md and survives restarts; migrate it elsewhere or delete it once it has served its purpose.",
    placeholder: "Write temporary thoughts\u2026\n\nMarkdown is supported; auto-saves after you stop typing.",
    saving: "Saving\u2026",
    dirty: "Editing \u2014 will auto-save\u2026",
    saveFailed: "Save failed: {message} (will retry shortly)",
    loadFailed: "Load failed: {message}",
    loading: "Loading\u2026",
    retry: "Retry",
    remoteChanged: "The note was modified elsewhere; your unsaved edits will overwrite it when saved.",
    open: "Open with system tool",
    openFailed: "Open failed: {message}",
    savedAt: "Saved {time}",
    neverSaved: "Never saved yet"
  }
};
function pick(zhText, enText) {
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("en") ? enText : zhText;
}
function errText3(err) {
  const message = err instanceof Error ? err.message : String(err);
  return message || "unknown error";
}
function formatTime3(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
async function revealScratch() {
  const res = await fetch("/memory-evolve/api/reveal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: "scratchFile" })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
}
function ScratchView(props) {
  const [view, setView] = (0, import_react14.useState)("main");
  const [loaded, setLoaded] = (0, import_react14.useState)(false);
  const [error, setError] = (0, import_react14.useState)(null);
  const [content, setContent] = (0, import_react14.useState)("");
  const [savedContent, setSavedContent] = (0, import_react14.useState)("");
  const [path, setPath] = (0, import_react14.useState)(null);
  const [mtime, setMtime] = (0, import_react14.useState)(null);
  const [saving, setSaving] = (0, import_react14.useState)(false);
  const [saveError, setSaveError] = (0, import_react14.useState)(null);
  const [saveTick, setSaveTick] = (0, import_react14.useState)(0);
  const [openError, setOpenError] = (0, import_react14.useState)(null);
  const [remoteChanged, setRemoteChanged] = (0, import_react14.useState)(false);
  const contentRef = (0, import_react14.useRef)(content);
  const savedContentRef = (0, import_react14.useRef)(savedContent);
  const pathRef = (0, import_react14.useRef)(path);
  (0, import_react14.useEffect)(() => {
    contentRef.current = content;
  }, [content]);
  (0, import_react14.useEffect)(() => {
    savedContentRef.current = savedContent;
  }, [savedContent]);
  (0, import_react14.useEffect)(() => {
    pathRef.current = path;
  }, [path]);
  const savingRef = (0, import_react14.useRef)(false);
  const pendingRef = (0, import_react14.useRef)(false);
  const load = (0, import_react14.useCallback)(async () => {
    try {
      const res = await fetch("/memory-evolve/api/scratch");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setLoaded(false);
        return;
      }
      setContent(data.content);
      setSavedContent(data.content);
      setPath(data.path);
      setMtime(data.mtime);
      setError(null);
      setLoaded(true);
    } catch (err) {
      setError(errText3(err));
      setLoaded(false);
    }
  }, []);
  (0, import_react14.useEffect)(() => {
    void load();
  }, [load]);
  const retryLoad = (0, import_react14.useCallback)(async () => {
    setError(null);
    setOpenError(null);
    void load();
  }, [load]);
  (0, import_react14.useEffect)(() => {
    const onVisible = async () => {
      if (typeof document === "undefined" || document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/memory-evolve/api/scratch");
        if (!res.ok) return;
        const data = await res.json();
        if (typeof data.content !== "string" || data.error) return;
        if (data.content === savedContentRef.current) {
          setRemoteChanged(false);
          return;
        }
        if (contentRef.current !== savedContentRef.current) {
          setRemoteChanged(true);
        } else {
          setContent(data.content);
          setSavedContent(data.content);
          setMtime(typeof data.mtime === "number" ? data.mtime : null);
          setRemoteChanged(false);
        }
      } catch {
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  const save = (0, import_react14.useCallback)(async () => {
    if (savingRef.current) {
      pendingRef.current = true;
      return;
    }
    savingRef.current = true;
    setSaving(true);
    const snapshot = contentRef.current;
    try {
      const res = await fetch("/memory-evolve/api/scratch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: snapshot })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSavedContent(snapshot);
      setMtime(typeof data.mtime === "number" ? data.mtime : null);
      setPath(typeof data.path === "string" ? data.path : pathRef.current);
      setSaveError(null);
      setRemoteChanged(false);
    } catch (err) {
      setSaveError(errText3(err));
      setSaveTick((n) => n + 1);
    } finally {
      savingRef.current = false;
      setSaving(false);
      if (pendingRef.current) {
        pendingRef.current = false;
        void save();
      }
    }
  }, []);
  (0, import_react14.useEffect)(() => {
    if (contentRef.current === savedContentRef.current) return;
    const timer = setTimeout(() => void save(), saveError === null ? DEBOUNCE_MS : RETRY_MS);
    return () => clearTimeout(timer);
  }, [content, savedContent, saveError, saveTick, save]);
  (0, import_react14.useEffect)(() => {
    return () => {
      if (contentRef.current !== savedContentRef.current) {
        void save();
      }
    };
  }, [save]);
  const dirty = content !== savedContent;
  const openFile = async () => {
    try {
      await revealScratch();
      setOpenError(null);
    } catch (err) {
      setOpenError(pick(DICT2.zh.openFailed, DICT2.en.openFailed).replace("{message}", errText3(err)));
    }
  };
  const openButton = /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("button", { type: "button", className: "sp-btn", onClick: () => void openFile(), title: path ?? "", children: pick(DICT2.zh.open, DICT2.en.open) });
  const statusText = () => {
    if (saving) return pick(DICT2.zh.saving, DICT2.en.saving);
    if (saveError !== null) return saveError;
    if (dirty) return pick(DICT2.zh.dirty, DICT2.en.dirty);
    return mtime === null ? pick(DICT2.zh.neverSaved, DICT2.en.neverSaved) : pick(DICT2.zh.savedAt, DICT2.en.savedAt).replace("{time}", formatTime3(mtime));
  };
  const statusKind = saveError !== null ? "error" : saving || dirty ? "pending" : "ok";
  return /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)("div", { className: "sp-root", children: [
    /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)("div", { className: "mt-file-tabs", role: "tablist", children: [
      /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": view === "guide",
          className: view === "guide" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setView("guide"),
          children: pick(DICT2.zh.guide, DICT2.en.guide)
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": view === "main",
          className: view === "main" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setView("main"),
          children: pick(DICT2.zh.note, DICT2.en.note)
        }
      )
    ] }),
    view === "guide" ? (
      // 临时信息专属指南（本 Tab 功能详细介绍，文案见 DICT guide* 键）
      /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(TabGuideView, { sections: [
        { icon: "\u{1F4DD}", title: pick(DICT2.zh.guideIntro, DICT2.en.guideIntro), body: "" },
        { icon: "\u{1F4BE}", title: pick(DICT2.zh.guideSaveTitle, DICT2.en.guideSaveTitle), body: pick(DICT2.zh.guideSaveBody, DICT2.en.guideSaveBody) },
        { icon: "\u{1F513}", title: pick(DICT2.zh.guideFreeTitle, DICT2.en.guideFreeTitle), body: pick(DICT2.zh.guideFreeBody, DICT2.en.guideFreeBody) },
        { icon: "\u26A0\uFE0F", title: pick(DICT2.zh.guideLimitTitle, DICT2.en.guideLimitTitle), body: pick(DICT2.zh.guideLimitBody, DICT2.en.guideLimitBody) },
        { icon: "\u{1F4C2}", title: pick(DICT2.zh.guideOpenTitle, DICT2.en.guideOpenTitle), body: pick(DICT2.zh.guideOpenBody, DICT2.en.guideOpenBody) }
      ] })
    ) : /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)(import_jsx_runtime16.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("div", { className: "sp-head", children: /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)("span", { className: "sp-path", title: path ?? "", children: [
        "\u{1F4DD} ",
        path ?? ""
      ] }) }),
      /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("p", { className: "sp-help", children: pick(DICT2.zh.help, DICT2.en.help) }),
      error !== null && /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)("div", { className: "sp-notice sp-notice-error", children: [
        error,
        /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)("span", { className: "sp-notice-actions", children: [
          /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(
            "button",
            {
              type: "button",
              className: "sp-btn sp-btn-small",
              onClick: () => void retryLoad(),
              children: pick(DICT2.zh.retry, DICT2.en.retry)
            }
          ),
          openButton
        ] })
      ] }),
      openError !== null && /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("div", { className: "sp-notice sp-notice-error", children: openError }),
      remoteChanged && /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("div", { className: "sp-notice sp-notice-warn", children: pick(DICT2.zh.remoteChanged, DICT2.en.remoteChanged) }),
      loaded && /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)(import_jsx_runtime16.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(
          "textarea",
          {
            className: "sp-editor",
            value: content,
            onChange: (e) => setContent(e.target.value),
            placeholder: pick(DICT2.zh.placeholder, DICT2.en.placeholder),
            spellCheck: false
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)("div", { className: "sp-toolbar", children: [
          /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("span", { className: `sp-status sp-status-${statusKind}`, children: statusText() }),
          /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("span", { className: "sp-spacer" }),
          openButton
        ] })
      ] }),
      !loaded && error === null && /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("div", { className: "sp-loading", children: pick(DICT2.zh.loading, DICT2.en.loading) })
    ] })
  ] });
}

// src/client/PromptView.tsx
var import_react15 = require("react");
var import_jsx_runtime17 = require("react/jsx-runtime");
var DICT3 = {
  zh: {
    // 「指南」子 tab：提示词注入功能的详细介绍（本 Tab 专属）。
    guide: "\u6307\u5357",
    library: "\u63D0\u793A\u8BCD\u5E93",
    guideIntro: "\u63D0\u793A\u8BCD\u6CE8\u5165 = \u53EF\u590D\u7528\u7684\u300C\u6307\u4EE4\u8303\u5F0F\u8D44\u4EA7\u5E93 + \u6CE8\u5165\u6267\u884C\u5668\u300D\uFF1A\u628A\u5E38\u7528\u5DE5\u4F5C\u8303\u5F0F\uFF08\u4EE3\u7801\u5BA1\u67E5 / \u8C03\u8BD5 / PRD / \u6D4B\u8BD5\u7B49\uFF09\u56FA\u5316\u6210\u63D0\u793A\u8BCD\uFF0C\u9009\u4E2D\u5373\u6CE8\u5165\u2014\u2014\u6A21\u578B\u4E0B\u4E00\u8F6E\u81EA\u52A8\u770B\u5230\u3001\u4E0D\u6253\u65AD\u56DE\u590D\u3002",
    guideLibTitle: "\u63D0\u793A\u8BCD\u5E93",
    guideLibBody: "\u53EF\u590D\u7528\u7684\u6307\u4EE4\u8303\u5F0F\u8D44\u4EA7\uFF0C\u6765\u6E90\u4EE5\u7528\u6237\u81EA\u5199\u4E3A\u4E3B\uFF1A",
    guideLibItem1: "CRUD\uFF1A\u65B0\u5EFA / \u7F16\u8F91 / \u5220\u9664\uFF0C\u540D\u79F0 + \u7B80\u4ECB + \u5206\u7C7B + \u6807\u7B7E + \u6B63\u6587\uFF08Markdown\uFF09\uFF0C\u65B0\u5EFA\u65F6\u5206\u7C7B\u7559\u7A7A\u81EA\u52A8\u5F52\u5165\u300C\u4E34\u65F6\u300D\uFF1B",
    guideLibItem2: "\u5206\u7C7B\u7BA1\u7406\uFF1A\u5185\u7F6E\u5206\u7C7B + \u81EA\u5B9A\u4E49\u6DFB\u52A0 / \u91CD\u547D\u540D / \u5220\u9664\uFF08\u5220\u9664\u65F6\u8BE5\u5206\u7C7B\u4E0B\u63D0\u793A\u8BCD\u81EA\u52A8\u79FB\u5230\u672A\u5206\u7C7B\uFF09\uFF1B",
    guideLibItem3: "\u641C\u7D22\uFF08\u540D\u79F0/\u5206\u7C7B/\u6807\u7B7E/\u5185\u5BB9\uFF09+ \u590D\u5236\u5230\u526A\u8D34\u677F + \u4F7F\u7528\u7EDF\u8BA1\uFF1B",
    guideLibItem4: "\u5185\u7F6E 13 \u6761\u6765\u81EA GitHub \u771F\u5B9E\u63D0\u793A\u8BCD\u8D44\u4EA7\u7684\u51B7\u542F\u52A8\u793A\u4F8B\uFF08SpecRoute / Claude-Code-Promts-Skills\uFF09\uFF0C\u5E76\u9644\u8303\u5F0F\u5E93\u94FE\u63A5\u4F9B\u81EA\u53D6\uFF1B",
    guideLibItem5: "\u542F\u7528\u72B6\u6001\uFF1A\u7981\u7528\u540E AI \u7684\u63D0\u793A\u8BCD\u5DE5\u5177\uFF08de_prompts\uFF09\u770B\u4E0D\u5230\u3001\u4E5F\u4E0D\u80FD\u6CE8\u5165\u2014\u2014GUI \u4ECD\u53EF\u7F16\u8F91\uFF0C\u968F\u65F6\u53EF\u91CD\u65B0\u542F\u7528\uFF1BAI \u53EF\u67E5\u8BE2\u5217\u8868\uFF08\u6309 ID \u53D6\u8BE6\u60C5\uFF09\u5E76\u9009\u62E9\u5408\u9002\u63D0\u793A\u8BCD\u6CE8\u5165\u5F53\u524D\u4F1A\u8BDD\uFF0C\u6216\u7528\u4F5C\u5B50\u4F1A\u8BDD/\u5B50\u4EE3\u7406/CLI \u4EFB\u52A1\u63D0\u793A\u8BCD\u3002",
    guideInjectTitle: "\u6CE8\u5165\u673A\u5236",
    guideInjectBody: "\u9009\u4E2D\u63D0\u793A\u8BCD\u914D\u7F6E\u300C\u6B21\u6570 \xD7 \u95F4\u9694\u300D\u5373\u6CE8\u5165\uFF08\u6B21\u6570/\u95F4\u9694\u53EF\u8F93\u5165\u4EFB\u610F\u6570\u5B57\uFF09\uFF1A",
    guideInjectItem1: "\u6B21\u6570\uFF1A\u4E00\u6B21\u6027\uFF081 \u8F6E\uFF09/ \u6709\u9650 N \u6B21 / \u65E0\u9650\uFF080 = \u6301\u7EED\u6CE8\u5165\u76F4\u5230\u624B\u52A8\u505C\u6B62\uFF09\uFF1B",
    guideInjectItem2: '\u95F4\u9694\uFF1A\u6BCF\u56DE\u5408\uFF081\uFF09/ \u6BCF M \u56DE\u5408\u51FA\u73B0 1 \u6B21\uFF08\u5982"\u6BCF 3 \u56DE\u5408\u63D0\u9192\u4E00\u6B21"\uFF09\uFF1B',
    guideInjectItem3: "\u5199\u540E\u5373\u65F6\u6CE8\u5165\u3001\u4E0D\u6253\u65AD\u56DE\u590D\uFF1A\u5185\u5BB9\u5199\u5165\u6CE8\u5165\u8F68\uFF0C\u6A21\u578B\u4E0B\u4E00\u8F6E\u751F\u6210\u65F6\u81EA\u52A8\u770B\u5230\uFF1B",
    guideInjectItem4: "\u6B63\u6587\u652F\u6301 {{date}} / {{time}} \u53D8\u91CF\uFF0C\u6CE8\u5165\u65F6\u81EA\u52A8\u5C55\u5F00\u3002",
    guideInjectItem5: "\u4E34\u65F6\u6CE8\u5165\uFF1A\u4E0D\u5EFA\u63D0\u793A\u8BCD\u4E5F\u80FD\u6CE8\u5165\u2014\u2014\u8BE6\u60C5\u680F\u76F4\u63A5\u8F93\u5165\u5185\u5BB9\u70B9\u300C\u6CE8\u5165\u300D\uFF0C\u81EA\u52A8\u5B58\u5165\u63D0\u793A\u8BCD\u5E93\uFF08\u5206\u7C7B\u7559\u7A7A\u5F52\u5165\u300C\u4E34\u65F6\u300D\uFF09\uFF0C\u4E00\u6B21\u64CD\u4F5C\u540C\u65F6\u5165\u5E93\u5E76\u751F\u6548\uFF1B",
    guideTrackTitle: "\u6CE8\u5165\u72B6\u6001",
    guideTrackBody: "\u6BCF\u4E2A\u63D0\u793A\u8BCD\u6709\u660E\u786E\u72B6\u6001\uFF08\u672A\u6CE8\u5165 / \u6CE8\u5165\u4E2D\xB7\u5269 N \u6B21 / \u6301\u7EED\u6CE8\u5165\u4E2D\uFF09\uFF0C\u53EF\u968F\u65F6\u505C\u6B62\uFF1B\u300C\u6CE8\u5165\u4E2D\u300D\u6D6E\u5C42\u5B9E\u65F6\u5C55\u793A\uFF1B\u4F1A\u8BDD\u9875 Tab \u680F\u6709\u6D3B\u8DC3\u6CE8\u5165\u65F6\u663E\u793A\u7EA2\u70B9 \u{1F534}\u3002",
    guideSwitchTitle: "\u5F00\u5173",
    guideSwitchBody: "\u63D0\u793A\u8BCD\u7BA1\u7406\u5668\u9ED8\u8BA4\u5173\u95ED\uFF1A\u5728\u300CMemory Evolve \u8BBE\u7F6E\u300DTab \u7684\u300C\u914D\u7F6E\u300D\u91CC\u6253\u5F00\u300C\u63D0\u793A\u8BCD\u7BA1\u7406\u5668\u300D\u5F00\u5173\uFF0C\u5237\u65B0\u540E\u672C Tab \u51FA\u73B0\u3002",
    search: "\u641C\u7D22\u540D\u79F0\u3001\u5206\u7C7B\u3001\u6807\u7B7E\u6216\u5185\u5BB9\u2026",
    new: "\u65B0\u5EFA\u63D0\u793A\u8BCD",
    all: "\u5168\u90E8",
    uncategorized: "\u672A\u5206\u7C7B",
    inject: "\u6CE8\u5165",
    injectRound: "\u6CE8\u5165 {n} \u6B21",
    injectInfinite: "\u65E0\u9650\u6B21\uFF08\u6301\u7EED\u6CE8\u5165\uFF09",
    injectCadence: "\u6BCF {n} \u56DE\u5408\u4E00\u6B21",
    everyTurn: "\u6BCF\u56DE\u5408",
    injectHint: "\u5199\u5165\u6CE8\u5165\u8F68\uFF0C\u6A21\u578B\u4E0B\u4E00\u8F6E\u81EA\u52A8\u770B\u5230\uFF1B\u6B21\u6570\u6309\u5BF9\u8BDD\u56DE\u5408\u6D88\u8017\uFF08\u53EF\u95F4\u9694\u6CE8\u5165\uFF09\uFF0C\u65E0\u9650\u6B21\u5219\u6301\u7EED\u5230\u624B\u52A8\u505C\u6B62",
    injecting: "\u6CE8\u5165\u4E2D",
    injectingBadge: "\u6CE8\u5165\u4E2D\xB7\u5269{n}\u6B21",
    injectingBadgeInfinite: "\u6CE8\u5165\u4E2D\xB7\u6301\u7EED",
    injectingIdle: "\u672A\u6CE8\u5165",
    noInjection: "\u8FD8\u6CA1\u6709\u6CE8\u5165\u4E2D\u7684\u63D0\u793A\u8BCD",
    removeInjection: "\u505C\u6B62\u6CE8\u5165",
    stoppedInjection: "\u5DF2\u505C\u6B62\u6CE8\u5165",
    copy: "\u590D\u5236",
    copied: "\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F",
    save: "\u4FDD\u5B58",
    saving: "\u4FDD\u5B58\u4E2D\u2026",
    cancel: "\u53D6\u6D88",
    delete: "\u5220\u9664",
    deleteConfirm: "\u786E\u5B9A\u5220\u9664\u300C{name}\u300D\uFF1F\u5220\u9664\u540E\u4E0D\u53EF\u6062\u590D\uFF0C\u5176\u6D3B\u8DC3\u6CE8\u5165\u4F1A\u4E00\u5E76\u79FB\u9664\u3002",
    sources: "GitHub \u8303\u5F0F\u5E93\u6765\u6E90",
    sourcesHint: "\u4EE5\u4E0B\u4ED3\u5E93\u6709\u5927\u91CF\u9AD8\u8D28\u91CF\u63D0\u793A\u8BCD/\u89C4\u8303\uFF08\u7528\u6237\u81EA\u53D6\uFF0C\u4E0D\u505A\u81EA\u52A8\u5BFC\u5165\uFF09\uFF1A",
    empty: "\u8FD8\u6CA1\u6709\u63D0\u793A\u8BCD\u3002\u70B9\u300C\u65B0\u5EFA\u63D0\u793A\u8BCD\u300D\u5F00\u59CB\uFF0C\u6216\u4ECE\u53F3\u4FA7\u6765\u6E90\u94FE\u63A5\u83B7\u53D6\u7075\u611F\u3002",
    noMatch: "\u6CA1\u6709\u5339\u914D\u7684\u63D0\u793A\u8BCD",
    formNew: "\u65B0\u5EFA\u63D0\u793A\u8BCD",
    formEdit: "\u7F16\u8F91\u63D0\u793A\u8BCD",
    name: "\u540D\u79F0",
    namePh: "\u5982\uFF1A\u4EE3\u7801\u5BA1\u67E5\uFF08Code Review\uFF09",
    description: "\u7B80\u4ECB",
    descriptionPh: "\u4E00\u53E5\u8BDD\u8BF4\u660E\u8FD9\u4E2A\u63D0\u793A\u8BCD\u7684\u7528\u9014\uFF08AI \u9009\u62E9\u63D0\u793A\u8BCD\u65F6\u770B\u8FD9\u91CC\uFF09",
    enabled: "\u542F\u7528\u72B6\u6001",
    enabledOn: "\u5DF2\u542F\u7528",
    enabledOff: "\u5DF2\u7981\u7528",
    disabledHint: "\u7981\u7528\u540E\u4E0D\u51FA\u73B0\u5728 AI \u7684\u63D0\u793A\u8BCD\u5217\u8868\uFF0C\u4E5F\u4E0D\u80FD\u88AB AI \u6CE8\u5165\uFF1B\u53EF\u5728\u672C\u9875\u91CD\u65B0\u542F\u7528",
    category: "\u5206\u7C7B",
    categoryPh: "\u5982\uFF1A\u5F00\u53D1\u6D41\u7A0B\uFF08\u7559\u7A7A\u81EA\u52A8\u5F52\u5165\u300C\u4E34\u65F6\u300D\uFF09",
    tags: "\u6807\u7B7E",
    tagsPh: "\u9017\u53F7\u5206\u9694\uFF0C\u5982\uFF1Areview, \u8D28\u91CF",
    content: "\u5185\u5BB9",
    contentPh: "\u5728\u8FD9\u91CC\u7F16\u5199\u63D0\u793A\u8BCD\u6B63\u6587\u2026\n\u652F\u6301 {{date}}\u3001{{time}} \u53D8\u91CF\uFF0C\u6CE8\u5165\u65F6\u81EA\u52A8\u5C55\u5F00\u3002",
    usage: "\u5DF2\u6CE8\u5165 {n} \u6B21",
    lastUsed: "\u6700\u8FD1\u6CE8\u5165\uFF1A{time}",
    neverUsed: "\u4ECE\u672A\u6CE8\u5165\u8FC7",
    rounds: "\u6B21\u6570",
    cadence: "\u95F4\u9694",
    roundsHint: "0=\u65E0\u9650\uFF1B1=\u53EA\u6CE8\u5165\u4E00\u6B21",
    everyHint: "0=\u53EA\u6CE8\u5165\u4E00\u6B21\uFF1B1=\u6BCF\u56DE\u5408\uFF1BN=\u6BCF N \u56DE\u5408\u4E00\u6B21",
    onceOnly: "\u53EA\u6CE8\u5165\u4E00\u6B21",
    effectOnce: "\u4E00\u6B21\u6027\uFF1A\u4E0B\u4E00\u8F6E\u51FA\u73B0\u4E00\u6B21\u540E\u81EA\u52A8\u7ED3\u675F",
    effectInfinite: "\u65E0\u9650\u6B21\uFF1A\u6BCF\u56DE\u5408\u51FA\u73B0\uFF0C\u6301\u7EED\u5230\u624B\u52A8\u505C\u6B62",
    effectInfiniteCadence: "\u65E0\u9650\u6B21\uFF1A\u6BCF {n} \u56DE\u5408\u51FA\u73B0\u4E00\u6B21\uFF0C\u6301\u7EED\u5230\u624B\u52A8\u505C\u6B62",
    effectFinite: "\u5171 {n} \u6B21\uFF1A\u6BCF\u56DE\u5408\u51FA\u73B0\uFF0C\u7528\u5C3D\u81EA\u52A8\u7ED3\u675F",
    effectFiniteCadence: "\u5171 {n} \u6B21\uFF1A\u6BCF {m} \u56DE\u5408\u51FA\u73B0\u4E00\u6B21\uFF0C\u7528\u5C3D\u81EA\u52A8\u7ED3\u675F",
    roundsInvalid: "\u6B21\u6570\u5FC5\u987B\u662F \u22650 \u7684\u6574\u6570\uFF080 = \u65E0\u9650\u6B21\uFF09",
    everyInvalid: "\u95F4\u9694\u5FC5\u987B\u662F \u22650 \u7684\u6574\u6570\uFF080 = \u53EA\u6CE8\u5165\u4E00\u6B21\uFF09",
    // 预设注入按钮（覆盖最常见的场景，普通用户无需理解次数×间隔）
    injectOnceBtn: "\u6CE8\u5165\u4E00\u6B21",
    injectOnceBtnHint: "\u53EA\u6CE8\u5165\u4E00\u6B21\uFF1A\u4E0B\u4E00\u8F6E\u51FA\u73B0\u540E\u81EA\u52A8\u7ED3\u675F",
    injectInfiniteBtn: "\u6301\u7EED\u6CE8\u5165",
    injectInfiniteBtnHint: "\u6BCF\u56DE\u5408\u51FA\u73B0\uFF0C\u76F4\u5230\u624B\u52A8\u505C\u6B62",
    customBtn: "\u81EA\u5B9A\u4E49",
    customBtnHint: "\u81EA\u7531\u8BBE\u7F6E\u6B21\u6570\u4E0E\u95F4\u9694",
    // 立即注入：通过快照变更当前回合立即生效（会话空闲则马上唤醒）；
    // 固定只注入一次，不受次数/间隔两个数字影响（用户拍板语义）
    injectNowBtn: "\u26A1 \u7ACB\u5373\u6CE8\u5165",
    injectNowBtnHint: "\u7ACB\u523B\u751F\u6548\u4E00\u6B21\uFF08\u5F53\u524D\u56DE\u5408/\u9A6C\u4E0A\u5524\u9192\uFF09\uFF0C\u53EA\u6CE8\u5165\u4E00\u6B21\uFF0C\u4E0D\u53D7\u6B21\u6570\u4E0E\u95F4\u9694\u5F71\u54CD",
    injectedNow: "\u5DF2\u7ACB\u5373\u6CE8\u5165\u300C{name}\u300D\uFF1A\u5F53\u524D\u56DE\u5408\u751F\u6548\uFF0C\u4EC5\u6B64\u4E00\u6B21\uFF08\u4E0D\u53D7\u6B21\u6570/\u95F4\u9694\u5F71\u54CD\uFF09",
    injectedNowFallback: "\u5DF2\u7ACB\u5373\u6CE8\u5165\u300C{name}\u300D\uFF08\u63D2\u8BDD\u672A\u9001\u8FBE\uFF0C\u5C06\u5728\u4E0B\u4E00\u8F6E\u751F\u6548\uFF09",
    collapseCustom: "\u6536\u8D77",
    quickTitle: "\u4E34\u65F6\u6CE8\u5165",
    quickDesc: "\u4E0D\u5EFA\u63D0\u793A\u8BCD\u4E5F\u80FD\u6CE8\u5165\uFF1A\u76F4\u63A5\u8F93\u5165\u5185\u5BB9\u70B9\u300C\u6CE8\u5165\u4E00\u6B21\u300D\uFF0C\u4F1A\u81EA\u52A8\u5B58\u5165\u63D0\u793A\u8BCD\u5E93\uFF08\u5206\u7C7B\u7559\u7A7A\u5F52\u5165\u300C\u4E34\u65F6\u300D\uFF09\uFF0C\u4E00\u6B21\u64CD\u4F5C\u540C\u65F6\u5165\u5E93\u5E76\u751F\u6548\u3002",
    quickNamePh: "\u540D\u79F0\uFF08\u53EF\u9009\uFF0C\u7559\u7A7A\u53D6\u5185\u5BB9\u9996\u884C\uFF09",
    quickCategoryPh: "\u5206\u7C7B\uFF08\u53EF\u9009\uFF0C\u7559\u7A7A\u5F52\u5165\u300C\u4E34\u65F6\u300D\uFF09",
    contentRequired: "\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A",
    error: "{message}",
    loadFailed: "\u52A0\u8F7D\u5931\u8D25\uFF1A{message}",
    injected: "\u5DF2\u6CE8\u5165\u300C{name}\u300D\uFF1A{rounds}{cadence}\uFF0C\u6A21\u578B\u4E0B\u4E00\u8F6E\u751F\u6548{ending}",
    injectedOnceEnding: "\uFF0C\u4E4B\u540E\u81EA\u52A8\u7ED3\u675F",
    injectedFiniteEnding: "\uFF0C\u7528\u5C3D\u81EA\u52A8\u7ED3\u675F",
    injectedInfiniteEnding: "\uFF0C\u76F4\u5230\u624B\u52A8\u505C\u6B62",
    injectInfiniteShort: "\u6301\u7EED\u6CE8\u5165",
    everyTurnParen: "\uFF08\u6BCF\u56DE\u5408\u51FA\u73B0\uFF09",
    injectCadenceParen: "\uFF08\u6BCF {n} \u56DE\u5408\u51FA\u73B0\uFF09",
    removed: "\u5DF2\u79FB\u9664\u6CE8\u5165",
    reload: "\u5237\u65B0",
    newCategory: "\u65B0\u5206\u7C7B",
    newCategoryPh: "\u8F93\u5165\u5206\u7C7B\u540D\uFF0C\u56DE\u8F66\u786E\u8BA4",
    deleteCategory: "\u5220\u9664\u5206\u7C7B",
    renameCategory: "\u91CD\u547D\u540D\u5206\u7C7B",
    renamePh: "\u8F93\u5165\u65B0\u5206\u7C7B\u540D\uFF0C\u56DE\u8F66\u786E\u8BA4",
    categoryRemoved: "\u5DF2\u5220\u9664\u5206\u7C7B\u300C{name}\u300D{moved}",
    categoryDeleted: "\u5DF2\u5220\u9664\u5206\u7C7B\u300C{name}\u300D",
    categoryMoved: "\uFF0C{count} \u6761\u63D0\u793A\u8BCD\u5DF2\u79FB\u5230\u672A\u5206\u7C7B",
    categoryExists: "\u5206\u7C7B\u300C{name}\u300D\u5DF2\u5B58\u5728\uFF0C\u5DF2\u4E3A\u4F60\u9009\u4E2D",
    categoryRenamed: "\u5DF2\u91CD\u547D\u540D\u300C{from}\u300D\u2192\u300C{to}\u300D{renamed}",
    categoryRenamedSuffix: "\uFF0C{count} \u6761\u63D0\u793A\u8BCD\u5DF2\u540C\u6B65"
  },
  en: {
    // "Guide" sub-tab: detailed introduction of the prompt injection feature.
    guide: "Guide",
    library: "Prompt library",
    guideIntro: 'Prompt injection = a reusable "instruction pattern library + injection executor": turn recurring work paradigms (code review / debugging / PRD / testing\u2026) into prompts, then inject one with a click \u2014 the model sees it next turn without interrupting the reply.',
    guideLibTitle: "Prompt library",
    guideLibBody: "Reusable instruction patterns, mostly user-written:",
    guideLibItem1: "CRUD: create / edit / delete, name + description + category + tags + body (Markdown); new prompts with an empty category go to Temp automatically;",
    guideLibItem2: "Category management: built-in categories + custom add / rename / delete (prompts in a deleted category move to Uncategorized);",
    guideLibItem3: "Search (name/category/tags/content) + copy to clipboard + usage stats;",
    guideLibItem4: "13 cold-start examples from real GitHub prompt assets (SpecRoute / Claude-Code-Promts-Skills) plus links to public pattern libraries;",
    guideLibItem5: "Enabled state: disabled prompts are hidden from the AI prompt tool (de_prompts) and cannot be injected by AI \u2014 still editable here, re-enable anytime; AI can list prompts (fetch details by ID) and inject the right one into the current session, or use it as a sub-session/subagent/CLI task prompt.",
    guideInjectTitle: "Injection mechanics",
    guideInjectBody: 'Select a prompt, configure "count \xD7 cadence" (any integers) and inject:',
    guideInjectItem1: "Count: once (1 turn) / finite N turns / unlimited (0 = keeps injecting until stopped);",
    guideInjectItem2: 'Cadence: every turn (1) / once every M turns (e.g. "remind every 3 turns");',
    guideInjectItem3: "Injects without interrupting the reply: written to the injection track, visible to the model on the next turn;",
    guideInjectItem4: "{{date}} / {{time}} variables expand at injection time.",
    guideInjectItem5: "Quick inject: no need to save a prompt first \u2014 type content and inject; it is auto-saved to the library (empty category \u2192 Temp) in one step;",
    guideTrackTitle: "Injection state",
    guideTrackBody: 'Every prompt has an explicit state (not injected / injecting\xB7N left / injecting\xB7ongoing) and can be stopped anytime; the "Injecting" overlay shows live entries; the session tab shows a red dot \u{1F534} while anything is active.',
    guideSwitchTitle: "Switch",
    guideSwitchBody: 'The prompt manager is off by default: enable the "Prompt manager" toggle under "Config" in the "Memory Evolve Settings" tab, then refresh to reveal this tab.',
    search: "Search name, category, tags or content\u2026",
    new: "New prompt",
    all: "All",
    uncategorized: "Uncategorized",
    inject: "Inject",
    injectRound: "Inject {n} times",
    injectInfinite: "Unlimited (until stopped)",
    injectCadence: "every {n} turns",
    everyTurn: "every turn",
    injectHint: "Writes to the injection track \u2014 visible to the model next turn; countdown consumes per conversation turn (interval injection supported); unlimited runs until stopped manually",
    injecting: "Injecting",
    injectingBadge: "injecting\xB7{n} left",
    injectingBadgeInfinite: "injecting\xB7ongoing",
    injectingIdle: "not injected",
    noInjection: "Nothing is being injected right now",
    removeInjection: "Stop",
    stoppedInjection: "Injection stopped",
    copy: "Copy",
    copied: "Copied to clipboard",
    save: "Save",
    saving: "Saving\u2026",
    cancel: "Cancel",
    delete: "Delete",
    deleteConfirm: 'Delete "{name}"? This cannot be undone and removes its active injections too.',
    sources: "GitHub prompt sources",
    sourcesHint: "These repos host high-quality prompts/specs (browse yourself \u2014 no auto import):",
    empty: 'No prompts yet. Click "New prompt" to start, or grab ideas from the source links.',
    noMatch: "No matching prompts",
    formNew: "New prompt",
    formEdit: "Edit prompt",
    name: "Name",
    namePh: "e.g. Code Review",
    description: "Description",
    descriptionPh: "One line about what this prompt does (AI reads this when picking a prompt)",
    enabled: "Enabled",
    enabledOn: "Enabled",
    enabledOff: "Disabled",
    disabledHint: "Disabled prompts are hidden from AI lists and cannot be injected by AI; re-enable here anytime",
    category: "Category",
    categoryPh: "e.g. workflow (empty = Temp category)",
    tags: "Tags",
    tagsPh: "Comma-separated, e.g. review, quality",
    content: "Content",
    contentPh: "Write the prompt body here\u2026\n{{date}} and {{time}} variables expand on inject.",
    usage: "Injected {n} times",
    lastUsed: "Last injected: {time}",
    neverUsed: "Never injected",
    rounds: "Count",
    cadence: "Cadence",
    roundsHint: "0=unlimited; 1=once only",
    everyHint: "0=once only; 1=every turn; N=every N turns",
    onceOnly: "once only",
    effectOnce: "Once: appears next turn, then auto-ends",
    effectInfinite: "Unlimited: every turn, until stopped",
    effectInfiniteCadence: "Unlimited: once every {n} turns, until stopped",
    effectFinite: "{n} times: every turn, auto-ends when spent",
    effectFiniteCadence: "{n} times: once every {m} turns, auto-ends when spent",
    roundsInvalid: "Count must be an integer \u2265 0 (0 = unlimited)",
    everyInvalid: "Cadence must be an integer \u2265 0 (0 = once only)",
    // Preset inject buttons (cover the most common cases; no need to
    // understand count × cadence for everyday use).
    injectOnceBtn: "Inject once",
    injectOnceBtnHint: "Once only: appears next turn, then auto-ends",
    injectInfiniteBtn: "Keep injecting",
    injectInfiniteBtnHint: "Every turn, until stopped",
    customBtn: "Custom",
    customBtnHint: "Free-form count and cadence",
    // Immediate injection: takes effect this turn via snapshot change (or
    // wakes an idle session); fixed to once only, ignores count and cadence.
    injectNowBtn: "\u26A1 Inject now",
    injectNowBtnHint: "Takes effect immediately (this turn / wakes the session), once only \u2014 ignores count and cadence",
    injectedNow: 'Injected "{name}" now: effective this turn, once only (ignores count/cadence)',
    injectedNowFallback: 'Injected "{name}" now (steer not delivered \u2014 will take effect next turn)',
    collapseCustom: "Collapse",
    quickTitle: "Quick inject",
    quickDesc: 'Inject without saving a prompt first: type content and hit "Inject once" \u2014 it is auto-saved to the library (empty category goes to Temp) in one step.',
    quickNamePh: "Name (optional; defaults to first content line)",
    quickCategoryPh: "Category (optional; empty = Temp)",
    contentRequired: "Content is required",
    error: "{message}",
    loadFailed: "Load failed: {message}",
    injected: 'Injected "{name}": {rounds}{cadence} \u2014 visible next turn{ending}',
    injectedOnceEnding: ", then auto-ends",
    injectedFiniteEnding: ", auto-ends when spent",
    injectedInfiniteEnding: ", until stopped",
    injectInfiniteShort: "Keep injecting",
    everyTurnParen: " (every turn)",
    injectCadenceParen: " (every {n} turns)",
    removed: "Injection removed",
    reload: "Reload",
    newCategory: "New category",
    newCategoryPh: "Type a category name, Enter to confirm",
    deleteCategory: "Delete category",
    renameCategory: "Rename category",
    renamePh: "Type a new name, Enter to confirm",
    categoryRemoved: 'Category "{name}" deleted{moved}',
    categoryDeleted: 'Category "{name}" deleted',
    categoryMoved: ", {count} prompts moved to Uncategorized",
    categoryExists: 'Category "{name}" already exists \u2014 selected',
    categoryRenamed: 'Renamed "{from}" \u2192 "{to}"{renamed}',
    categoryRenamedSuffix: ", {count} prompts updated"
  }
};
function pick2(zhText, enText) {
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("en") ? enText : zhText;
}
function errText4(err) {
  const message = err instanceof Error ? err.message : String(err);
  return message || "unknown error";
}
function formatTime4(ms) {
  return new Date(ms).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
async function api4(url, init) {
  const res = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...init
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
function parseInjectNums(roundsText, everyText, say) {
  const rounds = roundsText.trim() === "" ? 0 : Number(roundsText);
  const every = everyText.trim() === "" ? 1 : Number(everyText);
  if (!Number.isInteger(rounds) || rounds < 0) throw new Error(say("roundsInvalid"));
  if (!Number.isInteger(every) || every < 0) throw new Error(say("everyInvalid"));
  return { rounds, every };
}
function EffectHint(props) {
  const r = props.roundsText.trim() === "" ? 0 : Number(props.roundsText);
  const e = props.everyText.trim() === "" ? 1 : Number(props.everyText);
  if (!Number.isInteger(r) || r < 0 || !Number.isInteger(e) || e < 0) return null;
  const D = props.say;
  let text;
  if (e === 0) {
    text = D("effectOnce");
  } else if (r === 0) {
    text = e === 1 ? D("effectInfinite") : D("effectInfiniteCadence").replace("{n}", String(e));
  } else if (r === 1) {
    text = D("effectOnce");
  } else {
    text = e === 1 ? D("effectFinite").replace("{n}", String(r)) : D("effectFiniteCadence").replace("{n}", String(r)).replace("{m}", String(e));
  }
  return /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: "pm-effect-hint", children: text });
}
function NumInput(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("label", { className: "pm-field pm-num-field", children: [
    /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("span", { className: "pm-field-label", children: [
      props.label,
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-field-hint", children: props.hint })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
      "input",
      {
        type: "number",
        className: "pm-input pm-num-input",
        min: props.min,
        step: 1,
        value: props.value,
        onChange: (e) => props.onChange(e.target.value)
      }
    )
  ] });
}
function PromptView(props) {
  const lang = typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("en") ? "en" : "zh";
  const D = DICT3[lang];
  const say = (key) => D[key];
  const [prompts, setPrompts] = (0, import_react15.useState)([]);
  const [injections, setInjections] = (0, import_react15.useState)([]);
  const [sources, setSources] = (0, import_react15.useState)([]);
  const [categories, setCategories] = (0, import_react15.useState)([]);
  const [view, setView] = (0, import_react15.useState)("main");
  const [search, setSearch] = (0, import_react15.useState)("");
  const [category, setCategory] = (0, import_react15.useState)("\u5168\u90E8");
  const [selectedId, setSelectedId] = (0, import_react15.useState)(null);
  const [creating, setCreating] = (0, import_react15.useState)(false);
  const [showInjections, setShowInjections] = (0, import_react15.useState)(false);
  const [showSources, setShowSources] = (0, import_react15.useState)(false);
  const [error, setError] = (0, import_react15.useState)(null);
  const [notice, setNotice] = (0, import_react15.useState)(null);
  const [roundsText, setRoundsText] = (0, import_react15.useState)("0");
  const [everyText, setEveryText] = (0, import_react15.useState)("1");
  const [customOpen, setCustomOpen] = (0, import_react15.useState)(false);
  const [busy, setBusy] = (0, import_react15.useState)(false);
  const [addingCategory, setAddingCategory] = (0, import_react15.useState)(false);
  const [newCategoryName, setNewCategoryName] = (0, import_react15.useState)("");
  const [renamingCategory, setRenamingCategory] = (0, import_react15.useState)(null);
  const [renameValue, setRenameValue] = (0, import_react15.useState)("");
  const [name, setName] = (0, import_react15.useState)("");
  const [description, setDescription] = (0, import_react15.useState)("");
  const [formCategory, setFormCategory] = (0, import_react15.useState)("");
  const [tags, setTags] = (0, import_react15.useState)("");
  const [content, setContent] = (0, import_react15.useState)("");
  const [enabled, setEnabled] = (0, import_react15.useState)(true);
  const overlayRef = (0, import_react15.useRef)(null);
  (0, import_react15.useEffect)(() => {
    const onDown = (e) => {
      if (overlayRef.current === null || overlayRef.current.contains(e.target)) return;
      setShowInjections(false);
      setShowSources(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);
  const showError = (0, import_react15.useCallback)((err) => {
    setError(errText4(err));
  }, []);
  const showNotice = (0, import_react15.useCallback)((text) => {
    setNotice(text);
    window.setTimeout(() => setNotice(null), 4e3);
  }, []);
  const load = (0, import_react15.useCallback)(async () => {
    try {
      const [p, i, c] = await Promise.all([
        api4("/memory-evolve/api/prompts"),
        api4("/memory-evolve/api/prompts/injections"),
        api4("/memory-evolve/api/prompts/categories")
      ]);
      setPrompts(p.prompts);
      setInjections(i.injections);
      setCategories(c.categories);
    } catch (err) {
      showError(say("loadFailed").replace("{message}", errText4(err)));
    }
  }, [showError]);
  (0, import_react15.useEffect)(() => {
    void load();
    void api4("/memory-evolve/api/prompts/sources").then((data) => setSources(data.sources)).catch(() => {
    });
  }, [load]);
  const displayCategories = (0, import_react15.useMemo)(() => {
    const promptCats = prompts.map((p) => p.category).filter((c) => c && c !== "\u672A\u5206\u7C7B");
    return [.../* @__PURE__ */ new Set([...categories, ...promptCats])].sort((a, b) => a.localeCompare(b, "zh"));
  }, [categories, prompts]);
  const uncategorizedCount = (0, import_react15.useMemo)(
    () => prompts.filter((p) => p.category === "\u672A\u5206\u7C7B").length,
    [prompts]
  );
  const filtered = (0, import_react15.useMemo)(() => {
    const q = search.trim().toLowerCase();
    return prompts.filter((p) => {
      if (category !== "\u5168\u90E8" && p.category !== category) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q) || p.tags.some((t2) => t2.toLowerCase().includes(q)) || p.content.toLowerCase().includes(q);
    });
  }, [prompts, search, category]);
  const selected = prompts.find((p) => p.id === selectedId) ?? null;
  const selectPrompt = (id) => {
    const p = prompts.find((x) => x.id === id);
    if (!p) return;
    setSelectedId(id);
    setCreating(false);
    setName(p.name);
    setDescription(p.description ?? "");
    setFormCategory(p.category === "\u672A\u5206\u7C7B" ? "" : p.category);
    setTags(p.tags.join(", "));
    setContent(p.content);
    setEnabled(p.enabled !== false);
  };
  const startCreate = () => {
    setSelectedId(null);
    setCreating(true);
    setName("");
    setDescription("");
    setFormCategory("");
    setTags("");
    setContent("");
    setEnabled(true);
    setError(null);
  };
  const savePrompt = async () => {
    if (busy) return;
    const body = {
      name,
      description,
      category: formCategory,
      tags: tags.split(/[,，]/).map((t2) => t2.trim()).filter(Boolean),
      content,
      enabled
    };
    setBusy(true);
    try {
      if (creating) {
        const created = await api4("/memory-evolve/api/prompts", { method: "POST", body: JSON.stringify(body) });
        await load();
        setCreating(false);
        setSelectedId(created.prompt.id);
      } else if (selectedId !== null) {
        await api4(`/memory-evolve/api/prompts/${encodeURIComponent(selectedId)}`, { method: "PUT", body: JSON.stringify(body) });
        await load();
      }
    } catch (err) {
      showError(errText4(err));
    } finally {
      setBusy(false);
    }
  };
  const deletePrompt = async () => {
    if (selectedId === null) return;
    const text = say("deleteConfirm").replace("{name}", selected?.name ?? "");
    if (!window.confirm(text)) return;
    try {
      await api4(`/memory-evolve/api/prompts/${encodeURIComponent(selectedId)}`, { method: "DELETE" });
      setSelectedId(null);
      setCreating(false);
      await load();
    } catch (err) {
      showError(errText4(err));
    }
  };
  const afterInjected = async (injection) => {
    const times = injection.roundsLeft === null ? say("injectInfiniteShort") : injection.roundsLeft === 1 ? say("onceOnly") : say("injectRound").replace("{n}", String(injection.roundsLeft));
    const cadence = injection.every === 0 || injection.roundsLeft === 1 ? "" : (injection.every ?? 1) === 1 ? say("everyTurnParen") : say("injectCadenceParen").replace("{n}", String(injection.every));
    const ending = injection.every === 0 || injection.roundsLeft === 1 ? say("injectedOnceEnding") : injection.roundsLeft === null ? say("injectedInfiniteEnding") : say("injectedFiniteEnding");
    showNotice(say("injected").replace("{name}", injection.title).replace("{rounds}", times).replace("{cadence}", cadence).replace("{ending}", ending));
    await load();
    setShowInjections(true);
    window.dispatchEvent(new CustomEvent("dsh-memory-evolve:badge-change"));
  };
  const injectPrompt = async () => {
    if (selectedId === null) return;
    let nums;
    try {
      nums = parseInjectNums(roundsText, everyText, say);
    } catch (err) {
      showError(errText4(err));
      return;
    }
    try {
      const data = await api4(
        `/memory-evolve/api/prompts/${encodeURIComponent(selectedId)}/inject`,
        { method: "POST", body: JSON.stringify(nums) }
      );
      await afterInjected(data.injection);
    } catch (err) {
      showError(errText4(err));
    }
  };
  const injectPreset = async (rounds, every) => {
    if (selectedId === null) return;
    try {
      const data = await api4(
        `/memory-evolve/api/prompts/${encodeURIComponent(selectedId)}/inject`,
        { method: "POST", body: JSON.stringify({ rounds, every }) }
      );
      await afterInjected(data.injection);
    } catch (err) {
      showError(errText4(err));
    }
  };
  const injectNow = async (promptId) => {
    try {
      const data = await api4(
        `/memory-evolve/api/prompts/${encodeURIComponent(promptId)}/inject`,
        { method: "POST", body: JSON.stringify({ immediate: true, sessionId: props.sessionId }) }
      );
      const name2 = data.injection.title;
      showNotice(data.steered ? say("injectedNow").replace("{name}", name2) : say("injectedNowFallback").replace("{name}", name2));
      await load();
      setShowInjections(true);
      window.dispatchEvent(new CustomEvent("dsh-memory-evolve:badge-change"));
    } catch (err) {
      showError(errText4(err));
    }
  };
  const quickInject = async (preset, immediate = false) => {
    if (busy) return;
    const text = content.trim();
    if (!text) {
      showError(say("contentRequired"));
      return;
    }
    let nums;
    if (preset !== void 0) {
      nums = preset;
    } else {
      try {
        nums = parseInjectNums(roundsText, everyText, say);
      } catch (err) {
        showError(errText4(err));
        return;
      }
    }
    setBusy(true);
    try {
      const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
      const promptName = name.trim() || (firstLine.length > 20 ? `${firstLine.slice(0, 20)}\u2026` : firstLine) || "\u672A\u547D\u540D\u63D0\u793A\u8BCD";
      const created = await api4("/memory-evolve/api/prompts", {
        method: "POST",
        body: JSON.stringify({
          name: promptName,
          description,
          category: formCategory.trim(),
          tags: tags.split(/[,，]/).map((t2) => t2.trim()).filter(Boolean),
          content: text,
          enabled
        })
      });
      const data = immediate ? await api4(
        `/memory-evolve/api/prompts/${encodeURIComponent(created.prompt.id)}/inject`,
        { method: "POST", body: JSON.stringify({ immediate: true, sessionId: props.sessionId }) }
      ) : await api4(
        `/memory-evolve/api/prompts/${encodeURIComponent(created.prompt.id)}/inject`,
        { method: "POST", body: JSON.stringify(nums) }
      );
      if (immediate) {
        const name2 = data.injection.title;
        showNotice(data.steered ? say("injectedNow").replace("{name}", name2) : say("injectedNowFallback").replace("{name}", name2));
      } else {
        await afterInjected(data.injection);
      }
      selectPrompt(created.prompt.id);
    } catch (err) {
      showError(errText4(err));
    } finally {
      setBusy(false);
    }
  };
  const removeInjection = async (id) => {
    try {
      await api4(`/memory-evolve/api/prompts/injections/${encodeURIComponent(id)}`, { method: "DELETE" });
      showNotice(say("stoppedInjection"));
      await load();
      window.dispatchEvent(new CustomEvent("dsh-memory-evolve:badge-change"));
    } catch (err) {
      showError(errText4(err));
    }
  };
  const activeInjectionOf = (promptId) => injections.find((i) => i.sourcePromptId === promptId);
  const cadenceLabel = (inj) => {
    if (inj.every === 0) return say("onceOnly");
    return (inj.every ?? 1) === 1 ? say("everyTurn") : say("injectCadence").replace("{n}", String(inj.every));
  };
  const remainingLabel = (inj) => inj.roundsLeft === null ? say("injectInfinite") : say("injectRound").replace("{n}", String(inj.roundsLeft));
  const addCategory = async () => {
    const name2 = newCategoryName.trim();
    if (!name2) return;
    try {
      const data = await api4("/memory-evolve/api/prompts/categories", {
        method: "POST",
        body: JSON.stringify({ name: name2 })
      });
      setCategories(data.categories);
      setCategory(name2);
      setNewCategoryName("");
      setAddingCategory(false);
      if (data.alreadyExists) showNotice(say("categoryExists").replace("{name}", name2));
    } catch (err) {
      showError(errText4(err));
    }
  };
  const renameCategory = async (from) => {
    const to = renameValue.trim();
    if (!to || to === from) {
      setRenamingCategory(null);
      setRenameValue("");
      return;
    }
    try {
      const data = await api4(
        `/memory-evolve/api/prompts/categories/${encodeURIComponent(from)}`,
        { method: "PUT", body: JSON.stringify({ name: to }) }
      );
      setCategories(data.categories);
      if (category === from) setCategory(to);
      setRenamingCategory(null);
      setRenameValue("");
      await load();
      const suffix = data.renamed > 0 ? say("categoryRenamedSuffix").replace("{count}", String(data.renamed)) : "";
      showNotice(`${say("categoryRenamed").replace("{from}", from).replace("{to}", to).replace("{renamed}", "")}${suffix}`);
    } catch (err) {
      showError(errText4(err));
    }
  };
  const removeCategory = async (name2) => {
    const count = prompts.filter((p) => p.category === name2).length;
    const hint = count > 0 ? say("categoryMoved").replace("{count}", String(count)) : "";
    if (!window.confirm(`${say("deleteCategory")}\u300C${name2}\u300D\uFF1F${hint}`)) return;
    try {
      const data = await api4(
        `/memory-evolve/api/prompts/categories/${encodeURIComponent(name2)}`,
        { method: "DELETE" }
      );
      const cats = await api4("/memory-evolve/api/prompts/categories");
      setCategories(cats.categories);
      if (category === name2) setCategory("\u5168\u90E8");
      await load();
      const moved = data.moved > 0 ? say("categoryMoved").replace("{count}", String(data.moved)) : "";
      showNotice(`${say("categoryDeleted").replace("{name}", name2)}${moved}`);
    } catch (err) {
      showError(errText4(err));
    }
  };
  const copyPrompt = async () => {
    const text = selected?.content ?? "";
    try {
      await navigator.clipboard.writeText(text);
      showNotice(say("copied"));
    } catch (err) {
      showError(errText4(err));
    }
  };
  const summaryLine = (p) => {
    const desc = (p.description ?? "").trim();
    if (desc) return desc.length > 60 ? `${desc.slice(0, 60)}\u2026` : desc;
    const first = p.content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    return first.length > 60 ? `${first.slice(0, 60)}\u2026` : first;
  };
  const selectedIsDirty = selected !== null && (name !== selected.name || description !== (selected.description ?? "") || (formCategory || "\u672A\u5206\u7C7B") !== selected.category || tags !== selected.tags.join(", ") || content !== selected.content || enabled !== (selected.enabled !== false));
  return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-root", children: [
    /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "mt-file-tabs", role: "tablist", children: [
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": view === "guide",
          className: view === "guide" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setView("guide"),
          children: say("guide")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": view === "main",
          className: view === "main" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setView("main"),
          children: say("library")
        }
      )
    ] }),
    view === "guide" ? (
      // 提示词注入专属指南（本 Tab 功能详细介绍，文案见 DICT guide* 键）
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(TabGuideView, { sections: [
        { icon: "\u{1F4CC}", title: say("guideIntro"), body: "" },
        { icon: "\u{1F4DA}", title: say("guideLibTitle"), body: say("guideLibBody"), items: [say("guideLibItem1"), say("guideLibItem2"), say("guideLibItem3"), say("guideLibItem4"), say("guideLibItem5")] },
        { icon: "\u{1F489}", title: say("guideInjectTitle"), body: say("guideInjectBody"), items: [say("guideInjectItem1"), say("guideInjectItem2"), say("guideInjectItem3"), say("guideInjectItem4")] },
        { icon: "\u{1F534}", title: say("guideTrackTitle"), body: say("guideTrackBody") },
        { icon: "\u2699\uFE0F", title: say("guideSwitchTitle"), body: say("guideSwitchBody") }
      ] })
    ) : /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(import_jsx_runtime17.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-toolbar", children: [
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
          "input",
          {
            className: "pm-search",
            placeholder: say("search"),
            value: search,
            onChange: (e) => setSearch(e.target.value)
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
          "select",
          {
            className: "pm-select",
            value: category,
            onChange: (e) => setCategory(e.target.value),
            title: say("category"),
            children: categories.map((c) => /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("option", { value: c, children: c }, c))
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
          "button",
          {
            type: "button",
            className: "pm-tool-btn",
            onClick: () => {
              setShowInjections(!showInjections);
              setShowSources(false);
            },
            title: say("injectHint"),
            children: [
              say("injecting"),
              injections.length > 0 ? ` (${injections.length})` : ""
            ]
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
          "button",
          {
            type: "button",
            className: "pm-tool-btn",
            onClick: () => {
              setShowSources(!showSources);
              setShowInjections(false);
            },
            children: say("sources")
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("button", { type: "button", className: "pm-primary-btn", onClick: startCreate, children: say("new") })
      ] }),
      (error !== null || notice !== null) && /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: `pm-banner ${error !== null ? "pm-banner-error" : ""}`, children: [
        error !== null ? error : notice,
        error !== null && /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("button", { type: "button", className: "pm-banner-close", onClick: () => setError(null), children: "\xD7" })
      ] }),
      showInjections && /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-overlay", ref: overlayRef, children: [
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: "pm-overlay-title", children: say("injecting") }),
        injections.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: "pm-overlay-empty", children: say("noInjection") }),
        injections.map((inj) => /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-overlay-item", children: [
          /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-overlay-item-main", children: [
            /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-overlay-item-title", children: [
              "\u300C",
              inj.title,
              "\u300D"
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-overlay-item-sub", children: [
              remainingLabel(inj),
              " \xB7 ",
              cadenceLabel(inj)
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("button", { type: "button", className: "pm-danger-btn pm-overlay-remove", onClick: () => void removeInjection(inj.id), children: say("removeInjection") })
        ] }, inj.id))
      ] }),
      showSources && /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-overlay pm-overlay-wide", ref: overlayRef, children: [
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: "pm-overlay-title", children: say("sources") }),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: "pm-overlay-sub", children: say("sourcesHint") }),
        sources.map((s) => /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-source-item", children: [
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("a", { className: "pm-source-link", href: s.url, target: "_blank", rel: "noreferrer", children: s.name }),
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: "pm-source-desc", children: s.desc })
        ] }, s.url))
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-body", children: [
        /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-pane-cats", children: [
          /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
            "button",
            {
              type: "button",
              className: `pm-cat ${category === "\u5168\u90E8" ? "pm-cat-active" : ""}`,
              onClick: () => setCategory("\u5168\u90E8"),
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-cat-name", children: say("all") }),
                /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-cat-count", children: prompts.length })
              ]
            }
          ),
          displayCategories.map((c) => {
            const count = prompts.filter((p) => p.category === c).length;
            if (renamingCategory === c) {
              return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-cat-row", children: [
                /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                  "input",
                  {
                    className: "pm-cat-add-input",
                    autoFocus: true,
                    placeholder: say("renamePh"),
                    value: renameValue,
                    onChange: (e) => setRenameValue(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === "Enter") void renameCategory(c);
                      if (e.key === "Escape") {
                        setRenamingCategory(null);
                        setRenameValue("");
                      }
                    }
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("button", { type: "button", className: "pm-cat-add-ok", onClick: () => void renameCategory(c), children: "\u2713" })
              ] }, c);
            }
            return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-cat-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
                "button",
                {
                  type: "button",
                  className: `pm-cat ${category === c ? "pm-cat-active" : ""}`,
                  onClick: () => setCategory(c),
                  children: [
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-cat-name", children: c }),
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-cat-count", children: count })
                  ]
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                "button",
                {
                  type: "button",
                  className: "pm-cat-del",
                  title: say("renameCategory"),
                  onClick: () => {
                    setRenamingCategory(c);
                    setRenameValue(c);
                  },
                  children: "\u270E"
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                "button",
                {
                  type: "button",
                  className: "pm-cat-del",
                  title: say("deleteCategory"),
                  onClick: () => void removeCategory(c),
                  children: "\xD7"
                }
              )
            ] }, c);
          }),
          uncategorizedCount > 0 && /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
            "button",
            {
              type: "button",
              className: `pm-cat ${category === "\u672A\u5206\u7C7B" ? "pm-cat-active" : ""}`,
              onClick: () => setCategory("\u672A\u5206\u7C7B"),
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-cat-name", children: say("uncategorized") }),
                /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-cat-count", children: uncategorizedCount })
              ]
            }
          ),
          addingCategory ? /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-cat-add", children: [
            /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
              "input",
              {
                className: "pm-cat-add-input",
                autoFocus: true,
                placeholder: say("newCategoryPh"),
                value: newCategoryName,
                onChange: (e) => setNewCategoryName(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === "Enter") void addCategory();
                  if (e.key === "Escape") {
                    setAddingCategory(false);
                    setNewCategoryName("");
                  }
                }
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("button", { type: "button", className: "pm-cat-add-ok", onClick: () => void addCategory(), children: "\u2713" })
          ] }) : /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("button", { type: "button", className: "pm-cat-add-btn", onClick: () => setAddingCategory(true), children: [
            "\uFF0B ",
            say("newCategory")
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-pane-list", children: [
          prompts.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: "pm-pane-empty", children: say("empty") }),
          prompts.length > 0 && filtered.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: "pm-pane-empty", children: say("noMatch") }),
          filtered.map((p) => {
            const active = activeInjectionOf(p.id);
            return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
              "button",
              {
                type: "button",
                className: `pm-item ${selectedId === p.id && !creating ? "pm-item-active" : ""} ${p.enabled === false ? "pm-item-disabled" : ""}`,
                onClick: () => selectPrompt(p.id),
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-item-row1", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-item-name", children: p.name }),
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-item-badge", children: p.category }),
                    p.enabled === false && /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-item-badge pm-item-badge-off", title: say("disabledHint"), children: say("enabledOff") }),
                    active !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-item-badge pm-item-badge-active", title: say("injectHint"), children: active.roundsLeft === null ? say("injectingBadgeInfinite") : say("injectingBadge").replace("{n}", String(active.roundsLeft)) })
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: "pm-item-summary", children: summaryLine(p) }),
                  /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-item-row3", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-item-usage", children: say("usage").replace("{n}", String(p.usageCount ?? 0)) }),
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-item-used", children: p.lastUsedAt !== null ? say("lastUsed").replace("{time}", formatTime4(p.lastUsedAt)) : say("neverUsed") })
                  ] })
                ]
              },
              p.id
            );
          })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-pane-detail", children: [
          selected === null && !creating && // 未选中提示词 → 「临时注入」快速表单：不建提示词也能直接注入
          // （自动入库 + 注入一步完成，分类留空归入「临时」）
          /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-form", children: [
            /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: "pm-form-title", children: say("quickTitle") }),
            /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: "pm-quick-sub", children: say("quickDesc") }),
            /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("label", { className: "pm-field", children: [
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-field-label", children: say("name") }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                "input",
                {
                  className: "pm-input",
                  placeholder: say("quickNamePh"),
                  value: name,
                  onChange: (e) => setName(e.target.value)
                }
              )
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("label", { className: "pm-field", children: [
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-field-label", children: say("description") }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                "input",
                {
                  className: "pm-input",
                  placeholder: say("descriptionPh"),
                  value: description,
                  onChange: (e) => setDescription(e.target.value)
                }
              )
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("label", { className: "pm-field pm-field-grow", children: [
              /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("span", { className: "pm-field-label", children: [
                say("content"),
                " *"
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                "textarea",
                {
                  className: "pm-textarea",
                  placeholder: say("contentPh"),
                  value: content,
                  onChange: (e) => setContent(e.target.value)
                }
              )
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("label", { className: "pm-field", children: [
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-field-label", children: say("category") }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                "input",
                {
                  className: "pm-input",
                  list: "pm-category-list",
                  placeholder: say("quickCategoryPh"),
                  value: formCategory,
                  onChange: (e) => setFormCategory(e.target.value)
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("datalist", { id: "pm-category-list", children: displayCategories.map((c) => /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("option", { value: c }, c)) })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-actions", children: [
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                "button",
                {
                  type: "button",
                  className: "pm-primary-btn",
                  title: say("injectOnceBtnHint"),
                  onClick: () => void quickInject({ rounds: 1, every: 0 }),
                  disabled: busy,
                  children: busy ? say("saving") : say("injectOnceBtn")
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                "button",
                {
                  type: "button",
                  className: "pm-tool-btn",
                  title: say("injectInfiniteBtnHint"),
                  onClick: () => void quickInject({ rounds: 0, every: 1 }),
                  disabled: busy,
                  children: say("injectInfiniteBtn")
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                "button",
                {
                  type: "button",
                  className: "pm-tool-btn",
                  title: say("injectNowBtnHint"),
                  onClick: () => void quickInject(void 0, true),
                  disabled: busy,
                  children: say("injectNowBtn")
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                "button",
                {
                  type: "button",
                  className: "pm-tool-btn",
                  title: say("customBtnHint"),
                  onClick: () => setCustomOpen(!customOpen),
                  children: say("customBtn")
                }
              )
            ] }),
            customOpen && /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-custom-zone", children: [
              /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-num-row", children: [
                /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                  NumInput,
                  {
                    label: say("rounds"),
                    hint: say("roundsHint"),
                    value: roundsText,
                    min: 0,
                    onChange: setRoundsText
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                  NumInput,
                  {
                    label: say("cadence"),
                    hint: say("everyHint"),
                    value: everyText,
                    min: 0,
                    onChange: setEveryText
                  }
                )
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(EffectHint, { roundsText, everyText, say }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-actions", children: [
                /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("button", { type: "button", className: "pm-primary-btn", onClick: () => void quickInject(), disabled: busy, children: busy ? say("saving") : say("inject") }),
                /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("button", { type: "button", className: "pm-tool-btn", onClick: () => setCustomOpen(false), children: say("collapseCustom") })
              ] })
            ] })
          ] }),
          (selected !== null || creating) && /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-form", children: [
            /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: "pm-form-title", children: creating ? say("formNew") : say("formEdit") }),
            /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("label", { className: "pm-field", children: [
              /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("span", { className: "pm-field-label", children: [
                say("name"),
                " *"
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                "input",
                {
                  className: "pm-input",
                  placeholder: say("namePh"),
                  value: name,
                  onChange: (e) => setName(e.target.value)
                }
              )
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("label", { className: "pm-field", children: [
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-field-label", children: say("description") }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                "input",
                {
                  className: "pm-input",
                  placeholder: say("descriptionPh"),
                  value: description,
                  onChange: (e) => setDescription(e.target.value)
                }
              )
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("label", { className: "pm-field", children: [
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-field-label", children: say("category") }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                "input",
                {
                  className: "pm-input",
                  list: "pm-category-list",
                  placeholder: say("categoryPh"),
                  value: formCategory,
                  onChange: (e) => setFormCategory(e.target.value)
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("datalist", { id: "pm-category-list", children: displayCategories.map((c) => /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("option", { value: c }, c)) })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("label", { className: "pm-field", children: [
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-field-label", children: say("tags") }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                "input",
                {
                  className: "pm-input",
                  placeholder: say("tagsPh"),
                  value: tags,
                  onChange: (e) => setTags(e.target.value)
                }
              )
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("label", { className: "pm-field pm-field-grow", children: [
              /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("span", { className: "pm-field-label", children: [
                say("content"),
                " *"
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                "textarea",
                {
                  className: "pm-textarea",
                  placeholder: say("contentPh"),
                  value: content,
                  onChange: (e) => setContent(e.target.value)
                }
              )
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("label", { className: "pm-field pm-enable-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("span", { className: "pm-field-label", children: [
                say("enabled"),
                /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: "pm-field-hint", children: say("disabledHint") })
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                "button",
                {
                  type: "button",
                  role: "switch",
                  "aria-checked": enabled,
                  className: `pm-toggle ${enabled ? "pm-toggle-on" : ""}`,
                  onClick: () => setEnabled(!enabled),
                  children: enabled ? say("enabledOn") : say("enabledOff")
                }
              )
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-actions", children: [
              !creating && (() => {
                const active = selected !== null ? activeInjectionOf(selected.id) : void 0;
                if (active !== void 0) {
                  return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(import_jsx_runtime17.Fragment, { children: [
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("span", { className: "pm-inject-status", children: [
                      active.roundsLeft === null ? say("injectingBadgeInfinite") : say("injectingBadge").replace("{n}", String(active.roundsLeft)),
                      " ",
                      "\xB7 ",
                      cadenceLabel(active)
                    ] }),
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("button", { type: "button", className: "pm-danger-btn", onClick: () => void removeInjection(active.id), children: say("removeInjection") })
                  ] });
                }
                return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(import_jsx_runtime17.Fragment, { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                    "button",
                    {
                      type: "button",
                      className: "pm-primary-btn",
                      title: say("injectOnceBtnHint"),
                      onClick: () => void injectPreset(1, 0),
                      children: say("injectOnceBtn")
                    }
                  ),
                  /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                    "button",
                    {
                      type: "button",
                      className: "pm-tool-btn",
                      title: say("injectInfiniteBtnHint"),
                      onClick: () => void injectPreset(0, 1),
                      children: say("injectInfiniteBtn")
                    }
                  ),
                  /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                    "button",
                    {
                      type: "button",
                      className: "pm-tool-btn",
                      title: say("injectNowBtnHint"),
                      onClick: () => void injectNow(selected.id),
                      children: say("injectNowBtn")
                    }
                  ),
                  /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                    "button",
                    {
                      type: "button",
                      className: "pm-tool-btn",
                      title: say("customBtnHint"),
                      onClick: () => setCustomOpen(!customOpen),
                      children: say("customBtn")
                    }
                  ),
                  customOpen && /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-custom-zone pm-custom-zone-inline", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: "pm-inject-group", children: [
                      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                        NumInput,
                        {
                          label: say("rounds"),
                          hint: say("roundsHint"),
                          value: roundsText,
                          min: 0,
                          onChange: setRoundsText
                        }
                      ),
                      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                        NumInput,
                        {
                          label: say("cadence"),
                          hint: say("everyHint"),
                          value: everyText,
                          min: 0,
                          onChange: setEveryText
                        }
                      ),
                      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("button", { type: "button", className: "pm-primary-btn", onClick: () => void injectPrompt(), children: say("inject") }),
                      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("button", { type: "button", className: "pm-tool-btn", onClick: () => setCustomOpen(false), children: say("collapseCustom") })
                    ] }),
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(EffectHint, { roundsText, everyText, say })
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("button", { type: "button", className: "pm-tool-btn", onClick: () => void copyPrompt(), children: say("copy") })
                ] });
              })(),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("button", { type: "button", className: "pm-tool-btn", onClick: () => void savePrompt(), disabled: busy, children: busy ? say("saving") : say("save") }),
              !creating && /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("button", { type: "button", className: "pm-danger-btn", onClick: () => void deletePrompt(), children: say("delete") }),
              creating && /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("button", { type: "button", className: "pm-tool-btn", onClick: () => {
                setCreating(false);
                setSelectedId(null);
              }, children: say("cancel") })
            ] }),
            !creating && selected !== null && selectedIsDirty && /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: "pm-dirty-hint", children: pick2("\u6709\u672A\u4FDD\u5B58\u7684\u4FEE\u6539", "Unsaved changes") })
          ] })
        ] })
      ] })
    ] })
  ] });
}

// src/client/BookmarksView.tsx
var import_react16 = require("react");
var import_jsx_runtime18 = require("react/jsx-runtime");
var persistedFeature2 = null;
async function api5(path, init) {
  const res = await fetch(`/memory-evolve/api/bookmarks${path}`, {
    headers: { "content-type": "application/json" },
    ...init
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
function formatTime5(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}
function switchToChatTab() {
  const tabs = document.querySelectorAll('[role="tab"]');
  for (const tab of tabs) {
    const text = (tab.textContent ?? "").trim();
    if (text === "\u5BF9\u8BDD" || text === "Chat" || text.startsWith("\u5BF9\u8BDD") || text.startsWith("Chat")) {
      tab.click();
      return true;
    }
  }
  const first = tabs[0];
  if (first !== void 0) {
    first.click();
    return true;
  }
  return false;
}
function clickLoadOlder() {
  const flow = document.querySelector("[data-chat-flow]");
  const root = flow?.parentElement ?? document;
  const buttons = root.querySelectorAll("button");
  for (const btn of buttons) {
    if (btn.disabled) continue;
    const text = (btn.textContent ?? "").trim();
    if (text.includes("\u66F4\u65E9") || text.includes("older") || text.includes("Older") || text.includes("Load earlier") || text.includes("\u52A0\u8F7D\u5386\u53F2")) {
      btn.click();
      return true;
    }
  }
  return false;
}
function waitForAnchor(seq, timeoutMs = 2500) {
  const key = `node:${seq}`;
  const existing = document.querySelector(`[data-chat-anchor-key="${key}"]`);
  if (existing !== null) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      const el = document.querySelector(`[data-chat-anchor-key="${key}"]`);
      if (el !== null) {
        window.clearInterval(timer);
        resolve(el);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        window.clearInterval(timer);
        resolve(null);
      }
    }, 80);
  });
}
async function jumpToSeq(seq) {
  const switched = switchToChatTab();
  if (!switched) return "no-chat";
  await new Promise((r) => window.setTimeout(r, 120));
  let el = await waitForAnchor(seq, 800);
  if (el !== null) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    flashAnchor(el);
    return "ok";
  }
  for (let page = 0; page < 12; page += 1) {
    const clicked = clickLoadOlder();
    if (!clicked) break;
    el = await waitForAnchor(seq, 3e3);
    if (el !== null) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      flashAnchor(el);
      return "ok";
    }
  }
  return "not-found";
}
function flashAnchor(el) {
  const prev = el.style.outline;
  el.style.outline = "2px solid var(--dsw-static-yellow-9, #f5a623)";
  el.style.outlineOffset = "4px";
  window.setTimeout(() => {
    el.style.outline = prev;
    el.style.outlineOffset = "";
  }, 1600);
}
function BookmarksView(props) {
  const { t: t2, sessionId } = props;
  const [feature, setFeature] = (0, import_react16.useState)(persistedFeature2 ?? "list");
  const [bookmarks, setBookmarks] = (0, import_react16.useState)(null);
  const [query, setQuery] = (0, import_react16.useState)("");
  const [notice, setNotice] = (0, import_react16.useState)(null);
  const [busy, setBusy] = (0, import_react16.useState)(false);
  (0, import_react16.useEffect)(() => {
    persistedFeature2 = feature;
  }, [feature]);
  const load = (0, import_react16.useCallback)(() => {
    if (!sessionId) {
      setBookmarks([]);
      return;
    }
    void api5(`?sessionId=${encodeURIComponent(sessionId)}`).then((data) => setBookmarks(data.bookmarks ?? [])).catch((error) => {
      setNotice({ kind: "error", text: t2("bookmark.error", { message: error.message }) });
      setBookmarks([]);
    });
  }, [sessionId, t2]);
  (0, import_react16.useEffect)(() => {
    load();
  }, [load]);
  (0, import_react16.useEffect)(() => {
    const onChange = () => load();
    window.addEventListener("dsh-memory-evolve:bookmarks-change", onChange);
    return () => window.removeEventListener("dsh-memory-evolve:bookmarks-change", onChange);
  }, [load]);
  const onJump = (bm) => {
    setBusy(true);
    setNotice({ kind: "info", text: t2("bookmark.jumping") });
    void jumpToSeq(bm.seq).then((result) => {
      if (result === "ok") {
        setNotice({ kind: "ok", text: t2("bookmark.jump.ok", { label: bm.label }) });
      } else if (result === "no-chat") {
        setNotice({ kind: "error", text: t2("bookmark.jump.noChat") });
      } else {
        setNotice({ kind: "error", text: t2("bookmark.jump.notFound", { label: bm.label }) });
      }
    }).finally(() => setBusy(false));
  };
  const onRename = (bm) => {
    const input = window.prompt(t2("bookmark.prompt.rename"), bm.label);
    if (input === null) return;
    const label = input.trim();
    if (label === "") return;
    setBusy(true);
    void api5("", {
      method: "PATCH",
      body: JSON.stringify({ sessionId, id: bm.id, label })
    }).then(() => {
      load();
      setNotice({ kind: "ok", text: t2("bookmark.renamed") });
    }).catch((error) => {
      setNotice({ kind: "error", text: t2("bookmark.error", { message: error.message }) });
    }).finally(() => setBusy(false));
  };
  const onDelete = (bm) => {
    if (!window.confirm(t2("bookmark.confirm.delete", { label: bm.label }))) return;
    setBusy(true);
    void api5("", {
      method: "DELETE",
      body: JSON.stringify({ sessionId, id: bm.id })
    }).then(() => {
      load();
      setNotice({ kind: "ok", text: t2("bookmark.deleted") });
    }).catch((error) => {
      setNotice({ kind: "error", text: t2("bookmark.error", { message: error.message }) });
    }).finally(() => setBusy(false));
  };
  const onFork = (bm) => {
    if (!window.confirm(t2("bookmark.fork.confirm", { n: String(bm.seq) }))) return;
    setBusy(true);
    setNotice({ kind: "info", text: t2("bookmark.fork.working") });
    void fetch("/memory-evolve/api/bookmarks/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: bm.sessionId, seq: bm.seq })
    }).then((res) => res.json().catch(() => ({}))).then((data) => {
      if (typeof data.sessionId === "string") {
        setNotice({ kind: "ok", text: t2("bookmark.fork.ok", { id: data.sessionId }) });
      } else {
        setNotice({ kind: "error", text: t2("bookmark.error", { message: data.error ?? "HTTP error" }) });
      }
    }).catch((error) => {
      setNotice({ kind: "error", text: t2("bookmark.error", { message: error.message }) });
    }).finally(() => setBusy(false));
  };
  const q = query.trim().toLowerCase();
  const filtered = bookmarks === null ? null : q === "" ? bookmarks : bookmarks.filter((bm) => bm.label.toLowerCase().includes(q) || bm.summary.toLowerCase().includes(q));
  const guideSections = [
    {
      icon: "\u2B50",
      title: t2("bookmark.guide.what.title"),
      body: t2("bookmark.guide.what.body")
    },
    {
      icon: "\u{1F4CD}",
      title: t2("bookmark.guide.star.title"),
      body: t2("bookmark.guide.star.body")
    },
    {
      icon: "\u{1F4DC}",
      title: t2("bookmark.guide.list.title"),
      body: t2("bookmark.guide.list.body")
    },
    {
      icon: "\u2699\uFE0F",
      title: t2("bookmark.guide.switch.title"),
      body: t2("bookmark.guide.switch.body")
    }
  ];
  return /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)("div", { className: "bm-panel", children: [
    /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)("div", { className: "mt-file-tabs", role: "tablist", children: [
      /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "list",
          className: feature === "list" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature("list"),
          children: t2("bookmark.tab.list")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "guide",
          className: feature === "guide" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature("guide"),
          children: t2("bookmark.tab.guide")
        }
      )
    ] }),
    feature === "guide" && /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(TabGuideView, { sections: guideSections }),
    feature === "list" && /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(import_jsx_runtime18.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)("div", { className: "bm-toolbar", children: [
        /* @__PURE__ */ (0, import_jsx_runtime18.jsx)("h3", { children: t2("bookmark.list.title") }),
        /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(
          "button",
          {
            type: "button",
            className: "bm-toolbar-btn",
            disabled: busy,
            onClick: () => load(),
            children: t2("bookmark.refresh")
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime18.jsx)("p", { className: "bm-help", children: t2("bookmark.list.help") }),
      /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(
        "input",
        {
          type: "search",
          className: "bm-search",
          placeholder: t2("bookmark.search.placeholder"),
          value: query,
          onChange: (event) => setQuery(event.target.value),
          "aria-label": t2("bookmark.search.placeholder")
        }
      ),
      notice !== null && /* @__PURE__ */ (0, import_jsx_runtime18.jsx)("div", { className: `bm-notice bm-notice-${notice.kind}`, children: notice.text }),
      /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)("div", { className: "bm-list", children: [
        filtered === null && /* @__PURE__ */ (0, import_jsx_runtime18.jsx)("div", { className: "bm-empty", children: t2("bookmark.loading") }),
        filtered !== null && filtered.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime18.jsx)("div", { className: "bm-empty", children: q === "" ? t2("bookmark.empty") : t2("bookmark.search.empty") }),
        filtered !== null && filtered.map((bm) => /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(
          "div",
          {
            className: "bm-item",
            role: "article",
            onClick: () => {
              if (!busy) onJump(bm);
            },
            onKeyDown: (event) => {
              if (!busy && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                onJump(bm);
              }
            },
            tabIndex: 0,
            title: t2("bookmark.jump.hint"),
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)("div", { className: "bm-item-head", children: [
                /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)("span", { className: "bm-item-label", children: [
                  "\u2605 ",
                  bm.label
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)("span", { className: "bm-item-meta", children: [
                  bm.turn !== null ? t2("bookmark.turn", { n: String(bm.turn) }) : `seq ${bm.seq}`,
                  " \xB7 ",
                  formatTime5(bm.createdAt)
                ] })
              ] }),
              bm.summary !== "" && /* @__PURE__ */ (0, import_jsx_runtime18.jsx)("div", { className: "bm-item-summary", children: bm.summary }),
              /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(
                "div",
                {
                  className: "bm-item-actions",
                  onClick: (event) => event.stopPropagation(),
                  onKeyDown: (event) => event.stopPropagation(),
                  children: [
                    /* @__PURE__ */ (0, import_jsx_runtime18.jsx)("button", { type: "button", disabled: busy, onClick: () => onJump(bm), children: t2("bookmark.action.jump") }),
                    /* @__PURE__ */ (0, import_jsx_runtime18.jsx)("button", { type: "button", disabled: busy, onClick: () => onFork(bm), children: t2("bookmark.action.fork") }),
                    /* @__PURE__ */ (0, import_jsx_runtime18.jsx)("button", { type: "button", disabled: busy, onClick: () => onRename(bm), children: t2("bookmark.action.rename") }),
                    /* @__PURE__ */ (0, import_jsx_runtime18.jsx)("button", { type: "button", className: "bm-danger", disabled: busy, onClick: () => onDelete(bm), children: t2("bookmark.action.delete") })
                  ]
                }
              )
            ]
          },
          bm.id
        ))
      ] })
    ] })
  ] });
}

// src/client/bookmark-injector.tsx
var import_client = require("react-dom/client");

// src/client/TurnBookmarkButton.tsx
var import_react17 = require("react");
var import_jsx_runtime19 = require("react/jsx-runtime");
function resolveSessionId(sessionId) {
  return typeof sessionId === "function" ? sessionId() : sessionId;
}
async function api6(path, init) {
  const res = await fetch(`/memory-evolve/api/bookmarks${path}`, {
    headers: { "content-type": "application/json" },
    ...init
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
function TurnBookmarkButton(props) {
  const { seq, turn, summary, t: t2 } = props;
  const [bookmark, setBookmark] = (0, import_react17.useState)(null);
  const [busy, setBusy] = (0, import_react17.useState)(false);
  const [menuOpen, setMenuOpen] = (0, import_react17.useState)(false);
  const wrapRef = (0, import_react17.useRef)(null);
  const reload = (0, import_react17.useCallback)(() => {
    const sessionId = resolveSessionId(props.sessionId);
    if (!sessionId) return;
    void api6(`?sessionId=${encodeURIComponent(sessionId)}`).then((data) => {
      const found = (data.bookmarks ?? []).find((b) => b.seq === seq) ?? null;
      setBookmark(found);
    }).catch(() => {
    });
  }, [props.sessionId, seq]);
  (0, import_react17.useEffect)(() => {
    reload();
  }, [reload]);
  (0, import_react17.useEffect)(() => {
    if (!menuOpen) return;
    const onDoc = (event) => {
      if (wrapRef.current !== null && !wrapRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);
  const defaultLabel = t2("bookmark.defaultLabel", { n: String(turn ?? seq) });
  const createOrRename = (mode) => {
    const sessionId = resolveSessionId(props.sessionId);
    if (!sessionId) {
      window.alert(t2("bookmark.error", { message: t2("bookmark.noSession") }));
      return;
    }
    const initial = mode === "rename" && bookmark !== null ? bookmark.label : defaultLabel;
    const input = window.prompt(
      mode === "rename" ? t2("bookmark.prompt.rename") : t2("bookmark.prompt.create"),
      initial
    );
    if (input === null) return;
    const label = input.trim() === "" ? defaultLabel : input.trim();
    setBusy(true);
    setMenuOpen(false);
    if (mode === "create") {
      void api6("", {
        method: "POST",
        body: JSON.stringify({ sessionId, seq, label, summary, turn })
      }).then((data) => {
        setBookmark({ id: data.bookmark.id, seq: data.bookmark.seq, label: data.bookmark.label });
        window.dispatchEvent(new CustomEvent("dsh-memory-evolve:bookmarks-change"));
      }).catch((error) => {
        window.alert(t2("bookmark.error", { message: error.message }));
      }).finally(() => setBusy(false));
    } else if (bookmark !== null) {
      void api6("", {
        method: "PATCH",
        body: JSON.stringify({ sessionId, id: bookmark.id, label })
      }).then((data) => {
        setBookmark({ id: data.bookmark.id, seq: data.bookmark.seq, label: data.bookmark.label });
        window.dispatchEvent(new CustomEvent("dsh-memory-evolve:bookmarks-change"));
      }).catch((error) => {
        window.alert(t2("bookmark.error", { message: error.message }));
      }).finally(() => setBusy(false));
    } else {
      setBusy(false);
    }
  };
  const remove = () => {
    const sessionId = resolveSessionId(props.sessionId);
    if (bookmark === null) return;
    if (!window.confirm(t2("bookmark.confirm.delete", { label: bookmark.label }))) return;
    setBusy(true);
    setMenuOpen(false);
    void api6("", {
      method: "DELETE",
      body: JSON.stringify({ sessionId, id: bookmark.id })
    }).then(() => {
      setBookmark(null);
      window.dispatchEvent(new CustomEvent("dsh-memory-evolve:bookmarks-change"));
    }).catch((error) => {
      window.alert(t2("bookmark.error", { message: error.message }));
    }).finally(() => setBusy(false));
  };
  const bookmarked = bookmark !== null;
  const title = bookmarked ? t2("bookmark.star.title.on", { label: bookmark.label }) : t2("bookmark.star.title.off");
  return /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { className: "bm-star-wrap", ref: wrapRef, "data-bm-seq": String(seq), children: [
    /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
      "button",
      {
        type: "button",
        className: "bm-star-btn",
        "data-bookmarked": bookmarked ? "true" : void 0,
        title,
        "aria-label": title,
        disabled: busy,
        onClick: () => {
          if (bookmarked) {
            setMenuOpen((open) => !open);
          } else {
            createOrRename("create");
          }
        },
        children: /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("span", { className: "bm-star-icon", "aria-hidden": "true", children: bookmarked ? "\u2605" : "\u2606" })
      }
    ),
    menuOpen && bookmarked && /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { className: "bm-star-menu", role: "menu", children: [
      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("button", { type: "button", role: "menuitem", onClick: () => createOrRename("rename"), children: t2("bookmark.menu.rename") }),
      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("button", { type: "button", role: "menuitem", className: "bm-danger", onClick: remove, children: t2("bookmark.menu.delete") })
    ] })
  ] });
}

// src/client/bookmark-injector.tsx
var import_jsx_runtime20 = require("react/jsx-runtime");
var HOST_ATTR = "data-bm-star-host";
var FORK_MARK = "data-bm-fork-enabled";
var BRANCH_PATTERNS = ["\u5728\u65B0\u5BF9\u8BDD\u4E2D\u5206\u652F", "Branch into a new conversation"];
var SUMMARY_MAX = 200;
function parseSeq(el) {
  const key = el.getAttribute("data-chat-anchor-key") ?? "";
  const m = /^node:(\d+)$/.exec(key);
  if (m === null) return null;
  const seq = Number(m[1]);
  return Number.isInteger(seq) && seq >= 1 ? seq : null;
}
function isBranchButton(btn) {
  const title = (btn.getAttribute("title") ?? "") + " " + (btn.getAttribute("aria-label") ?? "");
  if (title === " ") return false;
  return BRANCH_PATTERNS.some((p) => title.includes(p));
}
function clip(text) {
  const joined = text.replace(/\s+/g, " ").trim();
  if (joined.length <= SUMMARY_MAX) return joined;
  return `${joined.slice(0, SUMMARY_MAX - 1)}\u2026`;
}
function extractSummary(node, root) {
  const nodes = Array.from(root.querySelectorAll('[data-chat-anchor-key^="node:"]'));
  const index = nodes.indexOf(node);
  if (index < 0) return "";
  for (let i = index - 1; i >= 0; i -= 1) {
    const prev = nodes[i];
    if (prev === void 0) continue;
    const hasBranch = prev.querySelector("button") !== null && Array.from(prev.querySelectorAll("button")).some(isBranchButton);
    if (!hasBranch) return clip(prev.textContent ?? "");
  }
  return "";
}
function createBookmarkInjector(getSessionId, deps) {
  let disposed = false;
  let observer = null;
  const mounted = /* @__PURE__ */ new Map();
  let scanRaf = 0;
  function findTailBranch(node) {
    const buttons = Array.from(node.querySelectorAll("button"));
    const branch = buttons.find(isBranchButton);
    if (branch === void 0) return null;
    if (branch.getAttribute("aria-disabled") === "true") return null;
    return branch;
  }
  function findBranchButton(node) {
    const buttons = Array.from(node.querySelectorAll("button"));
    return buttons.find(isBranchButton) ?? null;
  }
  function enableForkOnTurn(node) {
    const branch = findBranchButton(node);
    if (branch === null) return;
    if (branch.getAttribute("aria-disabled") !== "true") return;
    if (branch.hasAttribute(FORK_MARK)) return;
    branch.setAttribute(FORK_MARK, "");
    branch.removeAttribute("aria-disabled");
    branch.removeAttribute("disabled");
    branch.removeAttribute("data-unavailable");
    branch.title = deps.t("bookmark.fork.title");
    branch.setAttribute("aria-label", deps.t("bookmark.fork.title"));
    branch.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const seq = parseSeq(node);
      const sessionId = getSessionId();
      if (seq === null || sessionId === "") {
        window.alert(deps.t("bookmark.error", { message: deps.t("bookmark.noSession") }));
        return;
      }
      if (!window.confirm(deps.t("bookmark.fork.confirm", { n: String(seq) }))) return;
      void fetch("/memory-evolve/api/bookmarks/fork", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, seq })
      }).then((res) => res.json().catch(() => ({}))).then((data) => {
        if (typeof data.sessionId === "string") {
          window.alert(deps.t("bookmark.fork.ok", { id: data.sessionId }));
        } else {
          window.alert(deps.t("bookmark.error", { message: data.error ?? "HTTP error" }));
        }
      }).catch((error) => {
        window.alert(deps.t("bookmark.error", { message: error.message }));
      });
    });
  }
  function scan() {
    if (disposed) return;
    const root = document.querySelector("[data-chat-flow]");
    if (root === null) return;
    const bubbles = root.querySelectorAll('[role="tooltip"]');
    for (const bubble of bubbles) {
      const prev = bubble.previousElementSibling;
      if (prev instanceof HTMLButtonElement && prev.hasAttribute(FORK_MARK)) {
        bubble.style.display = "none";
      }
    }
    const nodes = root.querySelectorAll('[data-chat-anchor-key^="node:"]');
    for (const node of nodes) {
      enableForkOnTurn(node);
      if (node.querySelector(`[${HOST_ATTR}]`) !== null) continue;
      const seq = parseSeq(node);
      if (seq === null) continue;
      const branch = findTailBranch(node);
      if (branch === null) continue;
      const summary = extractSummary(node, root);
      const host = document.createElement("div");
      host.setAttribute(HOST_ATTR, "");
      host.dataset.bmSeq = String(seq);
      branch.insertAdjacentElement("afterend", host);
      const rootNode = (0, import_client.createRoot)(host);
      rootNode.render(
        /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
          TurnBookmarkButton,
          {
            seq,
            turn: null,
            summary,
            sessionId: getSessionId,
            t: deps.t
          }
        )
      );
      mounted.set(seq, { root: rootNode, host });
    }
  }
  observer = new MutationObserver(() => {
    if (disposed) return;
    if (scanRaf !== 0) return;
    scanRaf = requestAnimationFrame(() => {
      scanRaf = 0;
      if (disposed) return;
      scan();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scan();
  return {
    dispose() {
      disposed = true;
      if (scanRaf !== 0) {
        cancelAnimationFrame(scanRaf);
        scanRaf = 0;
      }
      observer?.disconnect();
      observer = null;
      for (const { root: r, host } of mounted.values()) {
        r.unmount();
        host.remove();
      }
      mounted.clear();
    }
  };
}

// src/client/session-filter.ts
var FILTER_BAR_ID = "dsh-ui-filter-bar";
var PREF_KEY = "dsh-memory-evolve:ui-settings:filter";
var RUNNING_POLL_MS = 5e3;
function readPref() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw === "off" ? "off" : "on";
  } catch {
    return "on";
  }
}
function writePref(mode) {
  try {
    localStorage.setItem(PREF_KEY, mode);
  } catch {
  }
}
function applyToDocument(mode) {
  const root = document.documentElement;
  if (mode === "on") root.dataset.dshUiFilter = "on";
  else delete root.dataset.dshUiFilter;
}
async function fetchRunning() {
  try {
    const res = await fetch("/memory-evolve/api/ui-settings/running", { cache: "no-store" });
    if (!res.ok) return { total: 0, groups: [] };
    const data = await res.json();
    if (!Array.isArray(data.groups)) return { total: data.total ?? 0, groups: [] };
    return { total: data.total ?? 0, groups: data.groups };
  } catch {
    return { total: 0, groups: [] };
  }
}
function createSessionFilter(texts) {
  let mode = readPref();
  let enabled = false;
  let disposed = false;
  let observer = null;
  let pollTimer = null;
  let countRaf = 0;
  let snapshot = { total: 0, groups: [] };
  const updateCount = () => {
    if (disposed || !enabled) return;
    if (countRaf !== 0) return;
    countRaf = requestAnimationFrame(() => {
      countRaf = 0;
      if (disposed || !enabled) return;
      const button = document.getElementById(FILTER_BAR_ID)?.querySelector('.dsh-ui-filter-btn[data-mode="on"]');
      if (button == null) return;
      button.textContent = `${texts.on} (${snapshot.total})`;
    });
  };
  const ensureBadges = () => {
    if (disposed || !enabled) return;
    const rows = document.querySelectorAll('div[role="treeitem"][aria-expanded]');
    for (const row of rows) {
      const collapsed = row.getAttribute("aria-expanded") === "false";
      const text = row.textContent ?? "";
      let matched = null;
      let bestLen = -1;
      for (const group of snapshot.groups) {
        const prefix = group.title ?? texts.ungroupedLabel;
        if (prefix !== "" && text.startsWith(prefix) && prefix.length > bestLen) {
          matched = group;
          bestLen = prefix.length;
        }
      }
      const need = collapsed && matched !== null && matched.running > 0;
      const badge = row.querySelector(".dsh-ui-ws-run-badge");
      if (need) {
        const label = texts.runningLabel.replace("{count}", String(matched.running));
        if (badge !== null) {
          if (badge.textContent !== label) badge.textContent = label;
        } else {
          const el = document.createElement("span");
          el.className = "dsh-ui-ws-run-badge";
          el.textContent = label;
          row.appendChild(el);
        }
      } else if (badge !== null) {
        badge.remove();
      }
    }
  };
  const refresh = () => {
    if (disposed || !enabled) return;
    void fetchRunning().then((next) => {
      if (disposed || !enabled) return;
      snapshot = next;
      updateCount();
      ensureBadges();
    });
  };
  const buildBar = () => {
    const bar = document.createElement("div");
    bar.id = FILTER_BAR_ID;
    bar.className = "dsh-ui-filter-bar";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", texts.barTitle);
    bar.title = texts.barTitle;
    const mkButton = (btnMode, label) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `dsh-ui-filter-btn${mode === btnMode ? " dsh-ui-filter-btn-active" : ""}`;
      button.dataset.mode = btnMode;
      button.textContent = label;
      button.setAttribute("aria-pressed", mode === btnMode ? "true" : "false");
      button.addEventListener("click", () => {
        if (disposed || !enabled) return;
        mode = btnMode;
        applyToDocument(mode);
        writePref(mode);
        for (const btn of bar.querySelectorAll(".dsh-ui-filter-btn")) {
          const isActive = btn.dataset.mode === mode;
          btn.classList.toggle("dsh-ui-filter-btn-active", isActive);
          btn.setAttribute("aria-pressed", isActive ? "true" : "false");
        }
      });
      return button;
    };
    bar.appendChild(mkButton("on", texts.on));
    bar.appendChild(mkButton("off", texts.off));
    return bar;
  };
  const ensureBar = () => {
    if (disposed || !enabled) return;
    if (document.getElementById(FILTER_BAR_ID) !== null) return;
    const tree = document.querySelector('[role="tree"]');
    if (tree === null || tree.parentNode === null) return;
    tree.parentNode.insertBefore(buildBar(), tree);
    updateCount();
  };
  const startObserver = () => {
    if (observer !== null || disposed) return;
    observer = new MutationObserver(() => {
      if (disposed || !enabled) return;
      if (document.getElementById(FILTER_BAR_ID) === null) {
        ensureBar();
        return;
      }
      ensureBadges();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  };
  const startPolling = () => {
    if (pollTimer !== null || disposed) return;
    pollTimer = setInterval(refresh, RUNNING_POLL_MS);
  };
  return {
    /** 功能开关：false=整体停用（移除注入与观察），true=按偏好恢复。 */
    setEnabled(next) {
      if (disposed) return;
      enabled = next;
      if (enabled) {
        applyToDocument(mode);
        ensureBar();
        startObserver();
        startPolling();
        refresh();
      } else {
        if (countRaf !== 0) {
          cancelAnimationFrame(countRaf);
          countRaf = 0;
        }
        if (pollTimer !== null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        observer?.disconnect();
        observer = null;
        document.getElementById(FILTER_BAR_ID)?.remove();
        document.querySelectorAll(".dsh-ui-ws-run-badge").forEach((el) => el.remove());
        delete document.documentElement.dataset.dshUiFilter;
      }
    },
    dispose() {
      disposed = true;
      if (countRaf !== 0) {
        cancelAnimationFrame(countRaf);
        countRaf = 0;
      }
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      observer?.disconnect();
      observer = null;
      document.getElementById(FILTER_BAR_ID)?.remove();
      document.querySelectorAll(".dsh-ui-ws-run-badge").forEach((el) => el.remove());
      delete document.documentElement.dataset.dshUiFilter;
    }
  };
}

// src/client/wide-chat.ts
var WIDE_CHAT_ATTR = "data-dsh-ui-wide-chat";
function createWideChat() {
  let disposed = false;
  return {
    /** 功能开关：false=恢复默认 748px 窄栏，true=加宽到约 95%。 */
    setEnabled(next) {
      if (disposed) return;
      const root = document.documentElement;
      if (next) root.setAttribute(WIDE_CHAT_ATTR, "on");
      else root.removeAttribute(WIDE_CHAT_ATTR);
    },
    dispose() {
      disposed = true;
      document.documentElement.removeAttribute(WIDE_CHAT_ATTR);
    }
  };
}
var WIDE_BUBBLE_ATTR = "data-dsh-ui-wide-bubble";
function createWideBubble() {
  let disposed = false;
  return {
    /** 功能开关：false=恢复默认 min(525px,82%)，true=气泡占内容框 80%。 */
    setEnabled(next) {
      if (disposed) return;
      const root = document.documentElement;
      if (next) root.setAttribute(WIDE_BUBBLE_ATTR, "on");
      else root.removeAttribute(WIDE_BUBBLE_ATTR);
    },
    dispose() {
      disposed = true;
      document.documentElement.removeAttribute(WIDE_BUBBLE_ATTR);
    }
  };
}

// src/client/context-meter-warn.ts
var RING_CIRCUMFERENCE = 2 * Math.PI * 5.5;
var WARN_PERCENT = 30;
var ERROR_PERCENT = 40;
var WARN_COLOR_VAR = "--dsw-alias-state-warn-primary";
var ERROR_COLOR_VAR = "--dsw-alias-state-error-primary";
function findRings() {
  return [...document.querySelectorAll(
    'button[aria-haspopup="dialog"] svg circle[stroke-dasharray]'
  )];
}
function percentFromDasharray(circle) {
  const dash = Number.parseFloat((circle.getAttribute("stroke-dasharray") ?? "").split(" ")[0] ?? "");
  if (!Number.isFinite(dash) || dash <= 0) return null;
  return Math.min(100, Math.round(dash / RING_CIRCUMFERENCE * 100));
}
function resolveColor(varName, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return value === "" ? fallback : value;
}
function createContextMeterWarn() {
  let enabled = false;
  let disposed = false;
  let observer = null;
  const apply2 = () => {
    if (disposed) return;
    const warn = resolveColor(WARN_COLOR_VAR, "#d97706");
    const error = resolveColor(ERROR_COLOR_VAR, "#dc2626");
    for (const ring of findRings()) {
      const percent = percentFromDasharray(ring);
      if (percent === null) continue;
      const color = percent >= ERROR_PERCENT ? error : percent >= WARN_PERCENT ? warn : null;
      if (color === null) ring.style.removeProperty("stroke");
      else ring.style.stroke = color;
    }
  };
  const startObserver = () => {
    if (observer !== null || disposed) return;
    observer = new MutationObserver(() => {
      apply2();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["stroke-dasharray"]
    });
  };
  return {
    setEnabled(next) {
      if (disposed) return;
      enabled = next;
      if (enabled) {
        apply2();
        startObserver();
      } else {
        observer?.disconnect();
        observer = null;
        for (const ring of findRings()) ring.style.removeProperty("stroke");
      }
    },
    dispose() {
      disposed = true;
      observer?.disconnect();
      observer = null;
      for (const ring of findRings()) ring.style.removeProperty("stroke");
    }
  };
}

// src/client/mermaid-render.ts
var STABLE_MS = 400;
var FORCE_STABLE_MS = 150;
var RETRY_DELAY_MS = 200;
var ENGINE_SRC = "/memory-evolve/mermaid/mermaid.min.js";
var SCRIPT_MARK = "data-me-mermaid";
var RENDERED_MARK = "data-me-mermaid-rendered";
var FAILED_MARK = "data-me-mermaid-failed";
var enginePromise;
var renderSeq = 0;
var states = /* @__PURE__ */ new WeakMap();
function loadMermaid() {
  enginePromise ??= new Promise((resolve, reject) => {
    document.querySelector(`script[${SCRIPT_MARK}]`)?.remove();
    const script = document.createElement("script");
    script.src = ENGINE_SRC;
    script.setAttribute(SCRIPT_MARK, "");
    const fail = (reason) => {
      enginePromise = void 0;
      reject(new Error(reason));
    };
    script.onload = () => {
      const mermaid = window.mermaid;
      if (mermaid === void 0) {
        fail("mermaid global missing after script load");
        return;
      }
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: detectTheme(),
        themeVariables: { background: "transparent" }
      });
      resolve(mermaid);
    };
    script.onerror = () => fail(`mermaid engine load failed: ${ENGINE_SRC}`);
    document.head.appendChild(script);
  });
  return enginePromise;
}
function detectTheme() {
  const bg = getComputedStyle(document.body).backgroundColor;
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(bg);
  if (match === null) return "base";
  const luminance = (0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3])) / 255;
  return luminance < 0.5 ? "dark" : "base";
}
function isMermaidBlock(block) {
  const info = block.querySelector('[class*="infostring"]');
  return info?.textContent?.trim().toLowerCase() === "mermaid";
}
function showErrorHint(block, error) {
  if (block.querySelector(".me-mermaid-error") !== null) return;
  const pre = block.querySelector("pre");
  if (pre === null) return;
  const hint = document.createElement("div");
  hint.className = "me-mermaid-error";
  const detail = error instanceof Error ? (String(error.message).split("\n")[0] ?? "").slice(0, 80) : "";
  const zh2 = (document.documentElement.lang ?? "").toLowerCase().startsWith("zh");
  hint.textContent = zh2 ? `\u26A0 mermaid \u6E32\u67D3\u5931\u8D25${detail === "" ? "" : `\uFF1A${detail}`}\uFF0C\u5DF2\u4FDD\u7559\u4EE3\u7801\uFF08\u53EF\u590D\u5236\u4FEE\u6B63\uFF09` : `\u26A0 mermaid render failed${detail === "" ? "" : `: ${detail}`}, code kept`;
  pre.insertAdjacentElement("beforebegin", hint);
}
function autoFixMermaid(source) {
  let changed = false;
  const fixed = source.split("\n").map((line) => {
    const sub = /^(\s*subgraph\s+)(.+?)\s*$/.exec(line);
    if (sub !== null) {
      const title = sub[2];
      if (!title.startsWith('"') && !title.startsWith("[") && /[（）()！？!?，。；：、""''【】《》]/.test(title)) {
        changed = true;
        return `${sub[1]}"${title.replace(/"/g, '\\"')}"`;
      }
      return line;
    }
    const edge = /^(\s*\S[^|]*?)\|([^|]*)\|(.*)$/.exec(line);
    if (edge !== null && edge[1].includes("-->") && !edge[2].startsWith('"') && !edge[2].startsWith("'")) {
      const fixedLabel = fixDangerChars(edge[2]);
      if (fixedLabel !== edge[2]) {
        changed = true;
        return `${edge[1]}|${fixedLabel}|${edge[3]}`;
      }
      return line;
    }
    const node = /^(\s*\S+?\s*)(\[)([^\]]*)(\])(.*)$/.exec(line);
    if (node !== null && !node[3].startsWith('"') && !node[3].startsWith("'") && /['"]/.test(node[3])) {
      const fixedText = fixDangerChars(node[3]);
      if (fixedText !== node[3]) {
        changed = true;
        return `${node[1]}${node[2]}${fixedText}${node[4]}${node[5]}`;
      }
    }
    return line;
  });
  return changed ? fixed.join("\n") : null;
}
function fixDangerChars(text) {
  let singleOpen = true;
  let doubleOpen = true;
  return text.replace(/['"()]/g, (ch) => {
    if (ch === "'") {
      const q = singleOpen ? "\u2018" : "\u2019";
      singleOpen = !singleOpen;
      return q;
    }
    if (ch === '"') {
      const q = doubleOpen ? "\u201C" : "\u201D";
      doubleOpen = !doubleOpen;
      return q;
    }
    return ch === "(" ? "\uFF08" : "\uFF09";
  });
}
function ensureDownloadButton(block) {
  const wrap = block.querySelector(".me-mermaid-wrap");
  if (wrap === null) return;
  const svg = wrap.querySelector("svg");
  if (svg === null) return;
  if (block.querySelector(".me-mermaid-download") !== null) return;
  const action = block.querySelector('[class*="action"]');
  const target = action ?? wrap;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "me-mermaid-download";
  const zh2 = (document.documentElement.lang ?? "").toLowerCase().startsWith("zh");
  btn.textContent = zh2 ? "\u4E0B\u8F7D" : "SVG";
  btn.title = zh2 ? "\u4E0B\u8F7D\u6B64\u56FE\u4E3A SVG\uFF08\u77E2\u91CF\uFF0C\u53EF\u65E0\u635F\u7F29\u653E\uFF09" : "Download diagram as SVG";
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    downloadSvg(svg);
  });
  target.appendChild(btn);
}
function downloadSvg(svg) {
  const xml = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const d = /* @__PURE__ */ new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = `mermaid-${stamp}.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
async function renderBlock(block, source, state) {
  if (state.rendering) return;
  state.rendering = true;
  let engine;
  try {
    engine = await loadMermaid();
  } catch (error) {
    state.engineFails += 1;
    if (state.engineFails === 1) {
      console.warn("[dsh-memory-evolve] mermaid engine load failed, will retry:", error);
    }
    return;
  }
  const attempts = [{ text: source }];
  const fixed = autoFixMermaid(source);
  if (fixed !== null) attempts.push({ text: fixed });
  let lastError;
  try {
    for (const attempt of attempts) {
      const id = `me-${++renderSeq}`;
      try {
        const pre = block.querySelector("pre");
        if (pre === null || !pre.isConnected) return;
        const { svg } = await engine.render(id, attempt.text);
        const preAfter = block.querySelector("pre");
        if (preAfter !== pre) return;
        const wrap = document.createElement("div");
        wrap.className = "me-mermaid-wrap";
        wrap.innerHTML = svg;
        pre.replaceWith(wrap);
        state.rendered = true;
        state.failCount = 0;
        state.engineFails = 0;
        block.setAttribute(RENDERED_MARK, "");
        block.removeAttribute(FAILED_MARK);
        ensureDownloadButton(block);
        return;
      } catch (error) {
        lastError = error;
        document.getElementById(`d${id}`)?.remove();
      }
    }
    state.failCount += 1;
    if (state.failCount >= 2) {
      state.rendered = true;
      block.setAttribute(RENDERED_MARK, "");
      block.setAttribute(FAILED_MARK, "");
      showErrorHint(block, lastError);
    }
    console.warn(`[dsh-memory-evolve] mermaid render failed (attempt ${state.failCount}):`, lastError);
  } finally {
    state.rendering = false;
  }
  if (!state.rendered && block.isConnected && block.querySelector("pre") !== null) {
    window.setTimeout(() => {
      schedule(block, true);
    }, RETRY_DELAY_MS);
  }
}
function schedule(block, force = false) {
  if (!isMermaidBlock(block)) return;
  let state = states.get(block);
  if (state === void 0) {
    state = { source: "", rendered: false, rendering: false, failCount: 0, engineFails: 0 };
    states.set(block, state);
  }
  const s = state;
  if (s.rendered) {
    if (block.querySelector(".me-mermaid-wrap") === null) {
      if (block.hasAttribute(FAILED_MARK)) return;
      s.rendered = false;
      s.failCount = 0;
      block.removeAttribute(RENDERED_MARK);
      schedule(block, true);
      return;
    }
    ensureDownloadButton(block);
    return;
  }
  const source = block.querySelector("pre")?.textContent ?? "";
  if (!force && source === s.source && s.timer !== void 0) return;
  s.source = source;
  window.clearTimeout(s.timer);
  s.timer = window.setTimeout(() => {
    const current = block.querySelector("pre")?.textContent ?? "";
    if (current === s.source) {
      if (!s.rendering) void renderBlock(block, s.source, s);
    } else {
      schedule(block);
    }
  }, force ? FORCE_STABLE_MS : STABLE_MS);
}
function createMermaidRenderer() {
  let observer;
  let disposed = false;
  let rescanTimer;
  const onMutations = (mutations) => {
    let addedCount = 0;
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          addedCount += 1;
          if (!(node instanceof HTMLElement)) continue;
          const self = node.classList.contains("md-code-block") ? node : node.closest(".md-code-block");
          if (self instanceof HTMLElement) schedule(self);
          if (self === null) {
            for (const inner of node.querySelectorAll(".md-code-block")) schedule(inner);
          }
        }
      } else {
        const element = mutation.target instanceof HTMLElement ? mutation.target : mutation.target.parentElement;
        const block = element?.closest(".md-code-block");
        if (block instanceof HTMLElement) schedule(block);
      }
    }
    if (addedCount > 40) scheduleRescans();
  };
  const scheduleRescans = () => {
    window.clearTimeout(rescanTimer);
    const delays = [300, 1e3, 2500, 6e3];
    const run = (index) => {
      if (index >= delays.length) return;
      rescanTimer = window.setTimeout(() => {
        if (disposed || observer === void 0) return;
        for (const block of document.querySelectorAll(".md-code-block")) schedule(block);
        run(index + 1);
      }, delays[index]);
    };
    run(0);
  };
  const setEnabled = (enabled) => {
    if (disposed) return;
    if (enabled && observer === void 0) {
      observer = new MutationObserver(onMutations);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });
      for (const block of document.querySelectorAll(".md-code-block")) schedule(block);
      scheduleRescans();
    } else if (!enabled && observer !== void 0) {
      observer.disconnect();
      observer = void 0;
      window.clearTimeout(rescanTimer);
    }
  };
  return {
    setEnabled,
    dispose() {
      disposed = true;
      observer?.disconnect();
      observer = void 0;
      window.clearTimeout(rescanTimer);
    }
  };
}

// src/client/styles.css
var styles_default = "/**\n * dsh-memory-evolve panel styles \u2014 DSH design tokens, `me-` prefix.\n * Colors come exclusively from --dsw-alias-* / --dsw-static-* tokens so the\n * panel follows the light/dark theme automatically (no hardcoded colors).\n */\n\n/* ---------- Root ---------- */\n\n.me-panel {\n  height: 100%;\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: column;\n  gap: 20px;\n  overflow-y: auto;\n  padding: 4px 2px 28px;\n  font-family: var(--dsw-font-family, inherit);\n  color: var(--dsw-alias-label-primary);\n}\n\n/* Inside the session memory tab: the panel is a sub-view, not a full-height\n   settings column \u2014 cap its height so the tab never grows the page. */\n.mt-panel .me-panel {\n  height: auto;\n  max-height: 62vh;\n}\n\n/* ---------- Notice bar (success / error) ---------- */\n\n.me-notice {\n  flex: none;\n  display: flex;\n  align-items: flex-start;\n  gap: 8px;\n  padding: 8px 12px;\n  border-radius: 8px;\n  font-size: 12px;\n  line-height: 1.5;\n}\n\n.me-notice::before {\n  content: '';\n  flex: none;\n  width: 6px;\n  height: 6px;\n  margin-top: 6px;\n  border-radius: 50%;\n}\n\n.me-notice-ok {\n  color: var(--dsw-alias-state-success-primary);\n  background: var(--dsw-alias-state-success-tertiary);\n  border: 1px solid var(--dsw-alias-state-success-primary);\n}\n.me-notice-ok::before {\n  background: var(--dsw-alias-state-success-primary);\n}\n\n.me-notice-error {\n  color: var(--dsw-alias-state-error-primary);\n  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);\n  border: 1px solid var(--dsw-alias-state-error-secondary);\n}\n.me-notice-error::before {\n  background: var(--dsw-alias-state-error-primary);\n}\n\n/* ---------- Section cards ---------- */\n\n.me-block {\n  flex: none;\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  padding: 14px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  background: var(--dsw-alias-bg-layer-1);\n}\n\n.me-block-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n\n.me-heading {\n  margin: 0;\n  font-size: 13px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-count {\n  flex: none;\n  min-width: 18px;\n  box-sizing: border-box;\n  padding: 1px 6px;\n  border-radius: 9px;\n  font-size: 11px;\n  line-height: 16px;\n  text-align: center;\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n.me-help {\n  margin: -4px 0 0;\n  font-size: 12px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.me-muted {\n  margin: 0;\n  padding: 8px 0;\n  font-size: 12px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n/* Friendly empty state */\n.me-empty {\n  margin: 0;\n  padding: 22px 12px;\n  border: 1px dashed var(--dsw-alias-border-l3);\n  border-radius: 10px;\n  font-size: 12px;\n  line-height: 1.5;\n  text-align: center;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n/* ---------- Suggestion list (own scroll area) ---------- */\n\n.me-list {\n  margin: 0;\n  padding: 0 2px 0 0;\n  list-style: none;\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  max-height: 380px;\n  overflow-y: auto;\n}\n\n.me-item {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  padding: 10px 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-base);\n  transition: border-color 120ms ease;\n}\n\n.me-item:hover {\n  border-color: var(--dsw-alias-border-l3);\n}\n\n.me-item-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n}\n\n.me-badge {\n  flex: none;\n  max-width: 45%;\n  padding: 1px 8px;\n  border-radius: 9px;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n.me-badge-hits {\n  color: var(--dsw-alias-state-warn-primary);\n  background: var(--dsw-alias-state-warn-tertiary);\n}\n\n/* \u5F85\u786E\u8BA4\u5EFA\u8BAE\u7684\u76EE\u6807\u5FBD\u6807\uFF1A\u6309\u8F68\u7740\u8272\uFF0C\u9192\u76EE\u533A\u5206\u8981\u5199\u5165\u54EA\u7C7B\u8BB0\u5FC6 */\n.me-badge-suggest {\n  border: 1px solid transparent;\n  font-size: 11px;\n  line-height: 18px;\n  padding: 1px 10px;\n}\n\n.me-badge-suggest-memory {\n  color: var(--dsw-static-blue-5, #3b82f6);\n  background: color-mix(in srgb, var(--dsw-static-blue-5, #3b82f6) 16%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-blue-5, #3b82f6) 45%, transparent);\n}\n\n.me-badge-suggest-user {\n  color: var(--dsw-static-green-5, #16a34a);\n  background: color-mix(in srgb, var(--dsw-static-green-5, #16a34a) 16%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-green-5, #16a34a) 45%, transparent);\n}\n\n.me-badge-suggest-key {\n  color: var(--dsw-static-amber-6, #d97706);\n  background: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 18%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 48%, transparent);\n}\n\n.me-badge-suggest-todo {\n  color: var(--dsw-static-purple-5, #9333ea);\n  background: color-mix(in srgb, var(--dsw-static-purple-5, #9333ea) 16%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-purple-5, #9333ea) 45%, transparent);\n}\n\n/* \u91C7\u7EB3\u76EE\u6807\u9009\u62E9\u4E0B\u62C9\uFF08\u9ED8\u8BA4=AI \u63A8\u8350\u8F68\uFF0C\u53EF\u6539\u5206\u7C7B\uFF09 */\n.me-pick-target {\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 6px;\n  padding: 2px 6px;\n  font-size: 11px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n}\n\n/* \u4F7F\u7528\u6307\u5357\u9762\u677F */\n.me-guide {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.me-guide-row {\n  display: flex;\n  gap: 10px;\n  align-items: flex-start;\n  padding: 8px 10px;\n  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-l2, rgba(128, 128, 128, 0.06));\n}\n\n.me-guide-icon {\n  flex: none;\n  font-size: 16px;\n  line-height: 20px;\n}\n\n.me-guide-body {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  min-width: 0;\n}\n\n.me-guide-body strong {\n  font-size: 12px;\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-guide-body span {\n  font-size: 12px;\n  line-height: 1.55;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.me-guide-sub {\n  margin: 14px 0 6px;\n  font-size: 12px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-guide-tips {\n  margin: 0;\n  padding-left: 18px;\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  font-size: 12px;\n  line-height: 1.55;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.me-guide-loop {\n  margin: 12px 0 0;\n  font-size: 12px;\n  font-weight: 600;\n  color: var(--dsw-static-blue-5, #3b82f6);\n}\n\n.me-item-time {\n  flex: 1;\n  min-width: 0;\n  font-size: 11px;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.me-item-actions {\n  flex: none;\n  display: flex;\n  gap: 6px;\n}\n\n.me-item-edit {\n  width: 100%;\n  box-sizing: border-box;\n  padding: 8px 10px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  outline: none;\n  background: var(--dsw-alias-bg-layer-1);\n  color: var(--dsw-alias-label-primary);\n  font-family: var(--dsw-font-family, inherit);\n  font-size: 12px;\n  line-height: 1.6;\n  resize: vertical;\n  transition: border-color 120ms ease, background-color 120ms ease;\n}\n\n.me-item-edit:hover {\n  border-color: var(--dsw-alias-border-l3);\n}\n\n.me-item-edit:focus-visible {\n  border-color: var(--dsw-alias-state-business-primary);\n}\n\n.me-item-reason {\n  margin: 0;\n  padding-left: 8px;\n  border-left: 2px solid var(--dsw-alias-border-l3);\n  font-size: 11px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n/* Bulk actions: separated from the list by a hairline */\n.me-bulk {\n  display: flex;\n  gap: 8px;\n  padding-top: 10px;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n}\n\n/* ---------- Buttons ---------- */\n\n.me-btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  height: 26px;\n  padding: 0 10px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  white-space: nowrap;\n  cursor: pointer;\n  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;\n}\n\n.me-btn:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.me-btn:active:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.me-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n.me-btn-archive {\n  border-color: var(--dsw-alias-border-l3);\n  color: var(--dsw-alias-label-secondary);\n}\n\n.me-btn-archive:hover:not(:disabled) {\n  border-color: var(--dsw-alias-interactive-fg-default);\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-archive-list {\n  max-height: 320px;\n  overflow-y: auto;\n}\n\n.me-archive-content {\n  margin: 0;\n  padding: 10px 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-layer-1);\n  font: inherit;\n  font-size: 12px;\n  line-height: 1.6;\n  white-space: pre-wrap;\n  word-break: break-word;\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-btn-ok {\n  color: var(--dsw-alias-state-success-primary);\n  border-color: var(--dsw-alias-state-success-primary);\n}\n.me-btn-ok:hover:not(:disabled) {\n  background: var(--dsw-alias-state-success-tertiary);\n}\n\n.me-btn-danger {\n  color: var(--dsw-alias-state-error-primary);\n}\n.me-btn-danger:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n  border-color: var(--dsw-alias-state-error-secondary);\n}\n\n.me-btn-primary {\n  border-color: transparent;\n  background: var(--dsw-alias-button-primary-fill);\n  color: var(--dsw-alias-label-primary-inverted);\n  font-weight: 600;\n}\n.me-btn-primary:hover:not(:disabled) {\n  background: var(--dsw-alias-button-primary-hover);\n}\n.me-btn-primary:disabled {\n  background: var(--dsw-alias-button-primary-dimmed);\n}\n\n.me-btn:focus-visible,\n.me-switch:focus-visible,\n.me-input:focus-visible,\n.me-select:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary);\n  outline-offset: 1px;\n}\n\n/* ---------- Config form ---------- */\n\n.me-form {\n  display: flex;\n  flex-direction: column;\n}\n\n/* Visual grouping: value rows vs. toggle rows, hairline between groups */\n.me-group {\n  display: flex;\n  flex-direction: column;\n}\n.me-group + .me-group {\n  margin-top: 8px;\n  padding-top: 4px;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n}\n\n.me-field {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  padding: 7px 2px;\n  font-size: 13px;\n  color: var(--dsw-alias-label-primary);\n  cursor: pointer;\n}\n\n.me-field-label {\n  flex: 1;\n  min-width: 0;\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.me-field-hint {\n  font-style: normal;\n  font-size: 11px;\n  line-height: 1.4;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n/* \u6B21\u7EA7\u5F00\u5173\u884C\uFF08\u5B50\u529F\u80FD\u5F00\u5173\uFF0C\u5982 ws-coord \u7684\u5FEB\u7167/\u786C\u62E6\u622A\uFF09\uFF1A\u7F29\u8FDB + \u5F31\u5316\uFF0C\n   \u89C6\u89C9\u4E0A\u4E0E\u4E3B\u5F00\u5173\uFF08\u6A21\u5757\u603B\u5F00\u5173\uFF09\u533A\u5206 */\n.me-field-sub {\n  padding-left: 18px;\n  border-left: 2px solid var(--dsw-alias-border-l2);\n  margin-left: 2px;\n}\n\n/* \u88AB\u7981\u7528\u7684\u5F00\u5173\uFF08\u5982\u5E7F\u64AD\u5173\u65F6 ws-coord \u603B\u5F00\u5173\u4E0D\u53EF\u70B9\uFF09\uFF1A\u5F31\u5316\u63D0\u793A */\n.me-switch:disabled {\n  opacity: 0.4;\n  cursor: not-allowed;\n}\n\n/* Toggle switch (accent when on) */\n.me-switch {\n  appearance: none;\n  flex: none;\n  position: relative;\n  width: 36px;\n  height: 20px;\n  margin: 0;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 10px;\n  background: var(--dsw-alias-interactive-bg-active);\n  cursor: pointer;\n  transition: background-color 150ms ease, border-color 150ms ease;\n}\n\n.me-switch::after {\n  content: '';\n  position: absolute;\n  top: 2px;\n  left: 2px;\n  width: 14px;\n  height: 14px;\n  border-radius: 50%;\n  background: var(--dsw-static-neutral-00);\n  transition: transform 150ms ease;\n}\n\n.me-switch:hover {\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.me-switch:checked {\n  border-color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-primary);\n}\n\n.me-switch:checked::after {\n  transform: translateX(16px);\n}\n\n/* Number / select inputs, right-aligned and uniform width */\n.me-input,\n.me-select {\n  flex: none;\n  width: 120px;\n  height: 28px;\n  box-sizing: border-box;\n  padding: 0 8px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 6px;\n  outline: none;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  transition: border-color 120ms ease;\n}\n\n.me-input:hover,\n.me-select:hover {\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.me-select {\n  cursor: pointer;\n}\n\n.me-actions {\n  display: flex;\n  justify-content: flex-end;\n  gap: 8px;\n  margin-top: 8px;\n  padding-top: 12px;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n}\n\n/* ---------- Open-files button grid ---------- */\n\n.me-reveal-grid {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));\n  gap: 8px;\n}\n\n.me-btn-reveal {\n  justify-content: flex-start;\n  height: 30px;\n  padding: 0 10px;\n  color: var(--dsw-alias-label-secondary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.me-btn-reveal:hover:not(:disabled) {\n  color: var(--dsw-alias-label-primary);\n  border-color: var(--dsw-alias-state-business-primary);\n}\n\n/* ---------- Scrollbars (token-driven, fall back to border color) ---------- */\n\n.me-panel::-webkit-scrollbar,\n.me-list::-webkit-scrollbar {\n  width: 8px;\n}\n\n.me-panel::-webkit-scrollbar-thumb,\n.me-list::-webkit-scrollbar-thumb {\n  border-radius: 4px;\n  background: var(--dsw-alias-scrollbar-bg-l1, var(--dsw-alias-border-l3));\n}\n\n.me-panel::-webkit-scrollbar-thumb:hover,\n.me-list::-webkit-scrollbar-thumb:hover {\n  background: var(--dsw-alias-scrollbar-hover-l1, var(--dsw-alias-border-l4));\n}\n\n.me-panel::-webkit-scrollbar-track,\n.me-list::-webkit-scrollbar-track {\n  background: transparent;\n}\n\n/* ---- memory tab (conversation.view) ---- */\n.mt-panel {\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  padding: 6px 12px 12px;\n  overflow-y: auto;\n  height: 100%;\n  box-sizing: border-box;\n}\n\n.mt-notice {\n  padding: 8px 12px;\n  border-radius: 8px;\n  font-size: 12px;\n  line-height: 1.5;\n}\n\n.mt-notice-ok {\n  color: var(--dsw-alias-state-success-primary);\n  background: var(--dsw-alias-state-success-tertiary);\n}\n\n.mt-notice-error {\n  color: var(--dsw-alias-state-error-primary);\n  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);\n  border: 1px solid var(--dsw-alias-state-error-secondary);\n}\n\n.mt-cwd {\n  margin: 0;\n  font-size: 11px;\n  color: var(--dsw-alias-label-dimmed);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.mt-muted {\n  margin: 0;\n  font-size: 12px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.mt-list {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n}\n\n.mt-card {\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  padding: 12px;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  background: var(--dsw-alias-bg-layer-1);\n}\n\n.mt-card-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n}\n\n/* \u6BCF\u4E2A\u6587\u4EF6\u9875\u7B7E\u9876\u90E8\u7684\u4E00\u884C\u5C0F\u5B57\u8BF4\u660E\uFF08\u4F5C\u7528\u4E0E\u673A\u5236\uFF09 */\n.mt-card-desc {\n  margin: 0;\n  font-size: 11px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.mt-card-title {\n  flex: none;\n  font-size: 13px;\n  font-weight: 600;\n}\n\n.mt-badge {\n  flex: none;\n  padding: 1px 8px;\n  border-radius: 9px;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n}\n\n.mt-badge-ro {\n  color: var(--dsw-alias-label-secondary);\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.mt-card-path {\n  flex: 1;\n  min-width: 0;\n  font-size: 11px;\n  color: var(--dsw-alias-label-dimmed);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  direction: rtl;\n  text-align: left;\n}\n\n.mt-card-actions {\n  flex: none;\n}\n\n.mt-btn {\n  padding: 3px 10px;\n  border-radius: 6px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font-size: 12px;\n  cursor: pointer;\n}\n\n.mt-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n/* ---- manual project KEY add box ---- */\n\n/* Branch-scope line in the KEY add box and in the per-entry scope editor. */\n.mt-key-scope {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 4px 12px;\n}\n\n.mt-key-scope-label {\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.mt-scope-opt {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  font-size: 12px;\n  cursor: pointer;\n}\n\n.mt-scope-opt input {\n  margin: 0;\n  accent-color: var(--dsw-alias-state-business-primary);\n}\n\n.mt-scope-all-hint {\n  font-style: normal;\n  font-size: 10px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n/* Per-entry branch-scope badge (click to edit). */\n.mt-entry-branch {\n  flex: none;\n  max-width: 45%;\n  padding: 1px 8px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 9px;\n  background: transparent;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--dsw-alias-state-business-primary);\n  cursor: pointer;\n}\n\n.mt-entry-branch:hover {\n  border-color: var(--dsw-alias-interactive-fg-default);\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.mt-entry-branch-all {\n  color: var(--dsw-alias-label-secondary);\n  font-weight: 500;\n}\n\n/* Static source-branch tag on daily/project log entries (not clickable). */\n.mt-entry-branch-tag {\n  color: var(--dsw-alias-state-success-primary);\n  cursor: default;\n  border-style: dashed;\n}\n\n/* \u300C\u4EC5 DSH\u300D\u6807\u8BB0\u5FBD\u7AE0\uFF1A\u8BE5\u6761\u76EE\u53EA\u6CE8\u5165 DSH \u81EA\u8EAB\uFF0C\u6CE8\u5165\u5916\u90E8\u6267\u884C\u5668\uFF08COI\uFF09\u65F6\u8DF3\u8FC7\u3002 */\n.mt-entry-dsh-only {\n  flex: none;\n  padding: 1px 8px;\n  border: 1px solid var(--dsw-alias-state-warning-border, var(--dsw-alias-border-l3));\n  border-radius: 9px;\n  background: transparent;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n  white-space: nowrap;\n  color: var(--dsw-alias-state-warning-fg, var(--dsw-alias-state-business-primary));\n}\n\n/* \u300C\u4EC5 DSH\u300Dtoggle \u6309\u94AE\u7684\u5DF2\u6807\u8BB0\u6FC0\u6D3B\u6001\uFF08\u9AD8\u4EAE\u533A\u5206\u5DF2\u6253\u6807\uFF09\u3002 */\n.mt-entry-dsh-on {\n  border-color: var(--dsw-alias-state-warning-border, var(--dsw-alias-border-l3)) !important;\n  color: var(--dsw-alias-state-warning-fg, var(--dsw-alias-state-business-primary)) !important;\n  font-weight: 600;\n}\n\n/* key \u624B\u52A8\u6DFB\u52A0\u6846\u7684\u300C\u4EC5 DSH\u300D\u52FE\u9009\u3002 */\n.mt-key-dsh-opt {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  user-select: none;\n}\n\n/* Inline scope editor panel under a KEY entry. */\n.mt-scope {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 4px 12px;\n  padding: 8px 10px;\n  border: 1px dashed var(--dsw-alias-border-l4);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n}\n\n.mt-scope-actions {\n  margin-left: auto;\n  display: flex;\n  gap: 6px;\n}\n\n/* Current-branch suffix on the KEY tab description line. */\n.mt-card-desc-branch {\n  color: var(--dsw-alias-state-business-primary);\n  font-weight: 600;\n}\n\n.mt-key-add {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding: 10px;\n  margin-bottom: 10px;\n  border: 1px dashed var(--dsw-alias-border-l4);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n}\n\n.mt-key-input {\n  box-sizing: border-box;\n  width: 100%;\n  padding: 8px 10px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 8px;\n  outline: none;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  line-height: 1.5;\n  resize: vertical;\n  transition: border-color 120ms ease;\n}\n\n.mt-key-input:hover {\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.mt-key-input:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary);\n  outline-offset: 1px;\n}\n\n.mt-key-input::placeholder {\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.mt-key-add-foot {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 10px;\n}\n\n.mt-key-help {\n  font-size: 11px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.mt-btn-primary {\n  flex: none;\n  border-color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-primary);\n  color: var(--dsw-alias-label-on-primary, #fff);\n  font-weight: 600;\n}\n\n.mt-btn-primary:hover:not(:disabled) {\n  filter: brightness(1.1);\n}\n\n.mt-content {\n  margin: 0;\n  padding: 10px;\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n  border: 1px solid var(--dsw-alias-border-l3);\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n  font-size: 12px;\n  line-height: 1.6;\n  white-space: pre-wrap;\n  word-break: break-word;\n  max-height: 320px;\n  overflow-y: auto;\n}\n\n\n.mt-warning {\n  margin: 0;\n  font-size: 11px;\n  line-height: 1.5;\n  color: var(--dsw-alias-state-warn-primary);\n}\n\n/* ---- memory tab toolbar (view toggle + search) ---- */\n\n.mt-file-tabs {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 2px;\n  padding: 0;\n  border-bottom: 1px solid var(--dsw-alias-interactive-bg-hover);\n  margin-bottom: 10px;\n}\n\n.mt-file-tab {\n  appearance: none;\n  height: 32px;\n  padding: 0 12px;\n  border: none;\n  border-radius: 6px 6px 0 0;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  font: inherit;\n  font-size: 13px;\n  cursor: pointer;\n  transition: background-color 120ms ease, color 120ms ease;\n}\n\n.mt-file-tab:hover:not(.mt-file-tab-active) {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.mt-file-tab-active,\n.mt-file-tab-active:hover {\n  background: var(--dsw-alias-interactive-bg-active);\n  color: var(--dsw-alias-brand-primary);\n  font-weight: 600;\n}\n\n/* Vertical divider between the feature tabs and the file tabs. */\n.mt-tab-sep {\n  flex: none;\n  align-self: center;\n  width: 1px;\n  height: 16px;\n  margin: 0 4px;\n  background: var(--dsw-alias-border-l3);\n}\n\n/* Pending-count badge inside a feature tab (e.g. \u5F85\u786E\u8BA4\u8BB0\u5FC6\u5EFA\u8BAE (2)). */\n.mt-feature-count {\n  display: inline-block;\n  min-width: 14px;\n  margin-left: 6px;\n  padding: 0 4px;\n  border-radius: 8px;\n  font-size: 10px;\n  line-height: 16px;\n  text-align: center;\n  font-weight: 700;\n  color: var(--dsw-alias-label-on-primary, #fff);\n  background: var(--dsw-alias-state-error-primary);\n}\n\n.mt-toolbar {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  flex-wrap: wrap;\n}\n\n/* Segmented \u7F8E\u89C2/\u7EAF\u6587\u672C toggle */\n.mt-view-toggle {\n  flex: none;\n  display: inline-flex;\n  padding: 2px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n}\n\n.mt-view-btn {\n  padding: 3px 12px;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  font: inherit;\n  font-size: 12px;\n  white-space: nowrap;\n  cursor: pointer;\n  transition: background-color 120ms ease, color 120ms ease;\n}\n\n.mt-view-btn:hover {\n  color: var(--dsw-alias-label-primary);\n}\n\n.mt-view-btn-active,\n.mt-view-btn-active:hover {\n  background: var(--dsw-alias-interactive-bg-active);\n  color: var(--dsw-alias-label-primary);\n  font-weight: 600;\n}\n\n.mt-view-btn:focus-visible,\n.mt-search:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary);\n  outline-offset: 1px;\n}\n\n.mt-search {\n  flex: 1;\n  min-width: 160px;\n  height: 28px;\n  box-sizing: border-box;\n  padding: 0 10px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 8px;\n  outline: none;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  transition: border-color 120ms ease;\n}\n\n.mt-search:hover {\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.mt-search::placeholder {\n  color: var(--dsw-alias-label-dimmed);\n}\n\n/* Search hit count badge in the card head */\n.mt-badge-count {\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n/* Friendly empty state (no search results) */\n.mt-empty {\n  margin: 0;\n  padding: 22px 12px;\n  border: 1px dashed var(--dsw-alias-border-l3);\n  border-radius: 10px;\n  font-size: 12px;\n  line-height: 1.5;\n  text-align: center;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n/* ---- pretty view: \xA7 entry cards ---- */\n\n.mt-entries {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  max-height: 320px;\n  overflow-y: auto;\n}\n\n.mt-entry {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding: 10px 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-base);\n  transition: border-color 120ms ease, background-color 120ms ease;\n}\n\n.mt-entry:hover {\n  border-color: var(--dsw-alias-border-l3);\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.mt-entry-head {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  min-width: 0;\n}\n\n.mt-entry-time {\n  flex: none;\n  padding: 1px 8px;\n  border-radius: 9px;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n  font-variant-numeric: tabular-nums;\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.mt-entry-tag {\n  flex: none;\n  max-width: 60%;\n  padding: 1px 8px;\n  border-radius: 9px;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n/* Per-entry action buttons (pretty view): right-aligned group. */\n.mt-entry-ops {\n  flex: none;\n  margin-left: auto;\n  display: flex;\n  align-items: center;\n  gap: 4px;\n}\n\n/* Neutral action (archive / promote back). */\n.mt-entry-op {\n  padding: 1px 8px;\n  font-size: 11px;\n  line-height: 16px;\n  border-color: transparent;\n  color: var(--dsw-alias-label-secondary);\n  opacity: 0.8;\n}\n\n.mt-entry-op:hover:not(:disabled) {\n  opacity: 1;\n  border-color: var(--dsw-alias-border-l3);\n  color: var(--dsw-alias-label-primary);\n}\n\n/* Per-entry delete button (pretty view): danger tint. */\n.mt-entry-del {\n  padding: 1px 8px;\n  font-size: 11px;\n  line-height: 16px;\n  border-color: transparent;\n  color: var(--dsw-alias-state-error-primary);\n  opacity: 0.7;\n}\n\n.mt-entry-del:hover:not(:disabled) {\n  opacity: 1;\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n  border-color: var(--dsw-alias-state-error-secondary);\n}\n\n.mt-entry-text {\n  margin: 0;\n  font-size: 12px;\n  line-height: 1.6;\n  white-space: pre-wrap;\n  word-break: break-word;\n  color: var(--dsw-alias-label-primary);\n}\n\n/* \u6761\u76EE\u6B63\u6587\u7F16\u8F91\u6846\uFF08\u7F8E\u89C2\u89C6\u56FE\u300C\u7F16\u8F91\u300D\uFF09\uFF1A\u53EA\u6539\u5185\u5BB9\uFF0C\u6807\u8BB0\u7A0B\u5E8F\u7EF4\u62A4 */\n.mt-entry-edit {\n  margin-top: 6px;\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n}\n\n.mt-item-edit {\n  width: 100%;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  border-radius: 6px;\n  padding: 6px 8px;\n  font-size: 12px;\n  line-height: 1.5;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  resize: vertical;\n  min-height: 56px;\n}\n\n.mt-item-edit:focus-visible {\n  outline: 2px solid var(--dsw-static-blue-6, #2563eb);\n  outline-offset: 1px;\n}\n\n.mt-entry-edit-row {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex-wrap: wrap;\n}\n\n.mt-entry-edit-hint {\n  flex: 1 1 auto;\n  font-size: 11px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n/* Entry list scrollbar (token-driven, fall back to border color) */\n.mt-entries::-webkit-scrollbar {\n  width: 8px;\n}\n\n.mt-entries::-webkit-scrollbar-thumb {\n  border-radius: 4px;\n  background: var(--dsw-alias-scrollbar-bg-l1, var(--dsw-alias-border-l3));\n}\n\n.mt-entries::-webkit-scrollbar-thumb:hover {\n  background: var(--dsw-alias-scrollbar-hover-l1, var(--dsw-alias-border-l4));\n}\n\n.mt-entries::-webkit-scrollbar-track {\n  background: transparent;\n}\n\n/* \u5206\u9875\u5668\uFF08\u7F8E\u89C2\u89C6\u56FE\u5927\u6587\u4EF6\u5206\u9875\uFF0C2026-08-10\uFF09 */\n.mt-pager {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 8px;\n  margin-top: 10px;\n  padding-top: 10px;\n  border-top: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.2));\n}\n\n.mt-pager-info {\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary, rgba(128, 128, 128, 0.85));\n}\n}\n\n/* ---------- Todo sub-tab ---------- */\n\n.me-tabs {\n  flex: none;\n  display: flex;\n  flex-wrap: wrap;\n  gap: 6px;\n}\n\n.me-tab {\n  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  border-radius: 6px;\n  padding: 4px 12px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary);\n  background: transparent;\n  cursor: pointer;\n}\n\n.me-tab:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.me-tab-active {\n  color: var(--dsw-alias-label-primary);\n  border-color: var(--dsw-alias-brand-primary);\n  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);\n}\n\n.me-todo-add {\n  flex: none;\n  display: flex;\n  gap: 8px;\n  align-items: center;\n}\n\n.me-todo-input {\n  flex: 1;\n  min-width: 0;\n  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  border-radius: 6px;\n  padding: 6px 10px;\n  font-size: 12px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-todo-select,\n.me-todo-date,\n.me-todo-filters select {\n  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  border-radius: 6px;\n  padding: 5px 8px;\n  font-size: 12px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-todo-filters {\n  flex: none;\n  display: flex;\n  gap: 16px;\n  align-items: center;\n}\n\n.me-todo-filter {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.me-todo-filter-check {\n  cursor: pointer;\n  user-select: none;\n}\n\n.me-todo-filter-check input {\n  accent-color: var(--dsw-static-blue-5, #3b82f6);\n}\n\n/* \u8FC7\u5F80 daily \u5F85\u529E\u7684\u5206\u7EC4\u6807\u9898\uFF08\u5982 8\u67085\u65E5\uFF09 */\n.me-todo-day {\n  list-style: none;\n  margin: 10px 0 2px;\n  font-size: 12px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-secondary);\n  border-bottom: 1px dashed var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  padding-bottom: 2px;\n}\n\n.me-badge-day {\n  color: var(--dsw-static-amber-7, #b45309);\n  background: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 14%, transparent);\n  border: 1px solid color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 40%, transparent);\n}\n\n.me-todo-item--done .me-todo-text {\n  opacity: 0.55;\n  text-decoration: line-through;\n}\n\n.me-todo-text {\n  margin: 4px 0 0;\n  font-size: 13px;\n  line-height: 1.5;\n  white-space: pre-wrap;\n  word-break: break-word;\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-todo-edit {\n  margin-top: 6px;\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n}\n\n.me-todo-edit-row {\n  display: flex;\n  gap: 8px;\n  align-items: center;\n  flex-wrap: wrap;\n}\n\n.me-todo-edit-row select,\n.me-todo-edit-row input {\n  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  border-radius: 6px;\n  padding: 4px 8px;\n  font-size: 12px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-badge-quad {\n  border: 1px solid transparent;\n}\n\n.me-badge-quad-q1 {\n  color: var(--dsw-static-red-5, #e5484d);\n  background: color-mix(in srgb, var(--dsw-static-red-5, #e5484d) 14%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-red-5, #e5484d) 40%, transparent);\n}\n\n.me-badge-quad-q2 {\n  color: var(--dsw-static-blue-5, #3b82f6);\n  background: color-mix(in srgb, var(--dsw-static-blue-5, #3b82f6) 14%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-blue-5, #3b82f6) 40%, transparent);\n}\n\n.me-badge-quad-q3 {\n  color: var(--dsw-static-amber-5, #f59e0b);\n  background: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 14%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 40%, transparent);\n}\n\n.me-badge-quad-q4 {\n  color: var(--dsw-static-neutral-5, #8b8d98);\n  background: color-mix(in srgb, var(--dsw-static-neutral-5, #8b8d98) 14%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-neutral-5, #8b8d98) 40%, transparent);\n}\n\n.me-badge-quad-none {\n  color: var(--dsw-alias-label-tertiary);\n  background: transparent;\n  border-color: var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n}\n\n.me-badge-overdue {\n  color: var(--dsw-static-red-5, #e5484d);\n  background: color-mix(in srgb, var(--dsw-static-red-5, #e5484d) 12%, transparent);\n}\n\n.me-badge-due {\n  color: var(--dsw-static-amber-5, #f59e0b);\n  background: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 12%, transparent);\n}\n\n.me-todo-help {\n  font-size: 11px;\n  line-height: 1.6;\n  color: var(--dsw-alias-label-dimmed);\n  margin: 0;\n}\n\n/* ---------- \u5F85\u529E\uFF1A\u5217\u8868 / \u770B\u677F \u89C6\u56FE\u5207\u6362\uFF08\u5206\u6BB5\u63A7\u4EF6\uFF09 ---------- */\n\n.me-todo-view-switch {\n  display: inline-flex;\n  margin-left: auto;\n  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  border-radius: 8px;\n  overflow: hidden;\n  flex: none;\n}\n\n.me-todo-view-btn {\n  appearance: none;\n  border: none;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12px;\n  padding: 4px 12px;\n  cursor: pointer;\n  line-height: 1.4;\n}\n\n.me-todo-view-btn:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-todo-view-btn-active {\n  color: var(--dsw-alias-label-primary);\n  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);\n  font-weight: 600;\n}\n\n/* ---------- \u5F85\u529E\uFF1A\u56DB\u8C61\u9650\u770B\u677F ----------\n * 2\xD72 \u5BAB\u683C\uFF1B\u6BCF\u4E2A\u8C61\u9650\u7528\u4E0D\u540C\u8272\u76F8\u63CF\u8FB9/\u6807\u9898\u70B9\u7F00\uFF0C\u989C\u8272\u5168\u90E8\u8D70\n * --dsw-static-* / --dsw-alias-* token\uFF0C\u6DF1\u6D45\u8272\u81EA\u9002\u5E94\u3002\n */\n\n.me-todo-board {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  grid-template-rows: minmax(160px, 1fr) minmax(160px, 1fr);\n  gap: 10px;\n  flex: none;\n  min-height: 320px;\n  max-height: 52vh;\n}\n\n/* \u7A84\u5C4F\uFF1A\u56DB\u8C61\u9650\u6539\u4E3A\u5355\u5217\u5806\u53E0\uFF0C\u907F\u514D\u5361\u7247\u88AB\u6324\u6241 */\n@media (max-width: 720px) {\n  .me-todo-board {\n    grid-template-columns: 1fr;\n    grid-template-rows: none;\n    max-height: none;\n  }\n}\n\n.me-todo-quad {\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  border-radius: 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  background: var(--dsw-alias-bg-layer-1);\n  overflow: hidden;\n}\n\n/* \u8C61\u9650\u8272\u5E26\uFF1A\u9876\u90E8\u7EC6\u7EBF + \u6807\u9898\u8272\uFF0C\u4E0E\u5217\u8868\u5FBD\u6807\u914D\u8272\u4E00\u81F4 */\n.me-todo-quad-q1 {\n  border-color: color-mix(in srgb, var(--dsw-static-red-5, #e5484d) 45%, var(--dsw-alias-border-l2));\n  box-shadow: inset 0 3px 0 0 color-mix(in srgb, var(--dsw-static-red-5, #e5484d) 70%, transparent);\n}\n.me-todo-quad-q2 {\n  border-color: color-mix(in srgb, var(--dsw-static-blue-5, #3b82f6) 45%, var(--dsw-alias-border-l2));\n  box-shadow: inset 0 3px 0 0 color-mix(in srgb, var(--dsw-static-blue-5, #3b82f6) 70%, transparent);\n}\n.me-todo-quad-q3 {\n  border-color: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 45%, var(--dsw-alias-border-l2));\n  box-shadow: inset 0 3px 0 0 color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 70%, transparent);\n}\n.me-todo-quad-q4 {\n  border-color: color-mix(in srgb, var(--dsw-static-neutral-5, #8b8d98) 45%, var(--dsw-alias-border-l2));\n  box-shadow: inset 0 3px 0 0 color-mix(in srgb, var(--dsw-static-neutral-5, #8b8d98) 55%, transparent);\n}\n\n.me-todo-quad-head {\n  flex: none;\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n  padding: 8px 10px 6px;\n}\n\n.me-todo-quad-title {\n  font-size: 12px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-todo-quad-q1 .me-todo-quad-title { color: var(--dsw-static-red-5, #e5484d); }\n.me-todo-quad-q2 .me-todo-quad-title { color: var(--dsw-static-blue-5, #3b82f6); }\n.me-todo-quad-q3 .me-todo-quad-title { color: var(--dsw-static-amber-6, #d97706); }\n.me-todo-quad-q4 .me-todo-quad-title { color: var(--dsw-static-neutral-5, #8b8d98); }\n\n.me-todo-quad-count {\n  flex: none;\n  min-width: 18px;\n  box-sizing: border-box;\n  padding: 1px 6px;\n  border-radius: 9px;\n  font-size: 11px;\n  line-height: 16px;\n  text-align: center;\n  color: var(--dsw-alias-label-secondary);\n  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent);\n}\n\n.me-todo-quad-body {\n  flex: 1;\n  min-height: 0;\n  overflow-y: auto;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  padding: 4px 8px 10px;\n}\n\n.me-todo-quad-empty {\n  margin: 12px 4px;\n  padding: 16px 8px;\n  text-align: center;\n  font-size: 12px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-dimmed);\n  border: 1px dashed var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  border-radius: 8px;\n  background: color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent);\n}\n\n/* \u770B\u677F\u5361\u7247 */\n.me-todo-card {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding: 8px 10px;\n  border-radius: 10px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  background: var(--dsw-alias-bg-base);\n  transition: border-color 120ms ease, box-shadow 120ms ease;\n}\n\n.me-todo-card:hover {\n  border-color: var(--dsw-alias-border-l3);\n  box-shadow: 0 1px 4px color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);\n}\n\n.me-todo-card--done {\n  opacity: 0.72;\n}\n\n.me-todo-card--done .me-todo-card-title {\n  text-decoration: line-through;\n}\n\n.me-todo-card-meta {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 4px;\n  min-width: 0;\n}\n\n.me-todo-card-title {\n  margin: 0;\n  font-size: 13px;\n  font-weight: 500;\n  line-height: 1.4;\n  color: var(--dsw-alias-label-primary);\n  word-break: break-word;\n  display: -webkit-box;\n  -webkit-line-clamp: 2;\n  -webkit-box-orient: vertical;\n  overflow: hidden;\n}\n\n.me-todo-card-body {\n  margin: 0;\n  font-size: 11px;\n  line-height: 1.45;\n  color: var(--dsw-alias-label-tertiary);\n  white-space: pre-wrap;\n  word-break: break-word;\n  display: -webkit-box;\n  -webkit-line-clamp: 3;\n  -webkit-box-orient: vertical;\n  overflow: hidden;\n}\n\n.me-todo-card-foot {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  justify-content: space-between;\n  gap: 6px;\n  margin-top: 2px;\n}\n\n.me-todo-card-foot .me-item-actions {\n  display: inline-flex;\n  flex-wrap: wrap;\n  gap: 4px;\n}\n\n.me-todo-card-foot .me-btn {\n  font-size: 11px;\n  padding: 2px 8px;\n}\n\n/* \u72B6\u6001\u5FBD\u6807\uFF08\u5217\u8868 + \u770B\u677F\u5171\u7528\uFF09\uFF1B\u53EF\u70B9\u51FB\u5207\u6362\u72B6\u6001 */\n.me-badge-status {\n  appearance: none;\n  cursor: pointer;\n  border: 1px solid transparent;\n  font-family: inherit;\n}\n\n.me-badge-status:disabled {\n  cursor: not-allowed;\n  opacity: 0.6;\n}\n\n.me-badge-status:hover:not(:disabled) {\n  filter: brightness(1.05);\n}\n\n.me-badge-status-pending {\n  color: var(--dsw-alias-label-secondary);\n  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-alias-label-secondary) 30%, transparent);\n}\n\n.me-badge-status-doing {\n  color: var(--dsw-static-blue-5, #3b82f6);\n  background: color-mix(in srgb, var(--dsw-static-blue-5, #3b82f6) 14%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-blue-5, #3b82f6) 40%, transparent);\n}\n\n.me-badge-status-done {\n  color: var(--dsw-static-green-5, #16a34a);\n  background: color-mix(in srgb, var(--dsw-static-green-5, #16a34a) 14%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-green-5, #16a34a) 40%, transparent);\n}\n\n.me-badge-status-blocked {\n  color: var(--dsw-static-red-5, #e5484d);\n  background: color-mix(in srgb, var(--dsw-static-red-5, #e5484d) 14%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-red-5, #e5484d) 40%, transparent);\n}\n\n.me-badge-status-cancelled {\n  color: var(--dsw-static-neutral-5, #8b8d98);\n  background: color-mix(in srgb, var(--dsw-static-neutral-5, #8b8d98) 14%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-neutral-5, #8b8d98) 35%, transparent);\n  text-decoration: line-through;\n}\n\n/* \u4F1A\u8BDD\u5934\u90E8\u300C\u590D\u5236\u4F1A\u8BDD ID\u300D\u6309\u94AE\uFF08conversation.session.header.actions \u63D2\u69FD\uFF09\u3002\n   \u5C0F\u5C3A\u5BF8\u5E7D\u7075\u6309\u94AE\uFF1A\u8DDF\u968F DSH \u4E3B\u9898 token\uFF0C\u9F20\u6807\u60AC\u505C\u52A0\u6DF1\u3002 */\n.me-copy-session-id {\n  appearance: none;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.35));\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary, inherit);\n  font-size: 12px;\n  line-height: 1;\n  padding: 4px 8px;\n  cursor: pointer;\n  white-space: nowrap;\n}\n.me-copy-session-id:hover {\n  border-color: var(--dsw-alias-interactive-bg-active, rgba(128, 128, 128, 0.6));\n  color: var(--dsw-alias-label-primary, inherit);\n}\n\n/* \u4F1A\u8BDD\u522B\u540D\u6309\u94AE\uFF08header actions\uFF0C\u590D\u5236\u4F1A\u8BDD ID \u6309\u94AE\u65C1\uFF09\uFF1A\u5185\u8054\u7F16\u8F91\u533A */\n.me-alias-wrap {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n}\n\n.me-alias-editor {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n}\n\n.me-alias-input {\n  width: 110px;\n  appearance: none;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.35));\n  border-radius: 6px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font-size: 12px;\n  padding: 3px 6px;\n  outline: none;\n}\n\n.me-alias-input:focus {\n  border-color: var(--dsw-alias-state-accent-primary, #4c8dff);\n}\n\n.me-alias-notice {\n  font-size: 11px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n/* ---- \u6A21\u578B\u914D\u7F6E Tab\uFF08models-hub\uFF09----\n * mt-models-* \u524D\u7F00\uFF0Ctoken \u4E0E\u98CE\u683C\u4E0E\u73B0\u6709 mt- \u7C7B\u4E00\u81F4\uFF08\u4E0D\u81EA\u5EFA\u6837\u5F0F\u4F53\u7CFB\uFF09\u3002\n * \u8868\u683C + \u884C\u5185\u914D\u7F6E\uFF08\u542F\u7528\u5F00\u5173 / \u601D\u8003\u7B49\u7EA7\u6807\u7B7E\u4E0E\u7F16\u8F91\u5668 / \u5907\u6CE8\u8F93\u5165\uFF09\u3002 */\n\n/* \u8868\u683C\u6EDA\u52A8\u5BB9\u5668\uFF08\u8868\u683C\u53EF\u80FD\u8D85\u51FA\u9762\u677F\u9AD8\u5EA6\uFF09\u3002 */\n.mt-models-scroll {\n  flex: 1;\n  min-height: 0;\n  overflow: auto;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-base);\n}\n\n.mt-models-table {\n  width: 100%;\n  border-collapse: collapse;\n  font-size: 12px;\n}\n\n.mt-models-cell {\n  padding: 6px 10px;\n  border-bottom: 1px solid var(--dsw-alias-interactive-bg-hover);\n  vertical-align: top;\n  text-align: left;\n  color: var(--dsw-alias-label-primary);\n}\n\n.mt-models-table thead .mt-models-cell {\n  position: sticky;\n  top: 0;\n  z-index: 1;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-secondary);\n  font-size: 11px;\n  font-weight: 600;\n  white-space: nowrap;\n}\n\n.mt-models-table tbody .mt-models-row:last-child .mt-models-cell {\n  border-bottom: none;\n}\n\n/* \u7981\u7528\u884C\uFF1A\u6574\u884C\u964D\u900F\u660E + \u540D\u79F0\u5212\u7EBF\u5F31\u5316\u3002 */\n.mt-models-row-muted .mt-models-cell {\n  opacity: 0.55;\n}\n\n.mt-models-col-enable {\n  width: 44px;\n}\n\n.mt-models-col-capacity {\n  width: 96px;\n  white-space: nowrap;\n}\n\n.mt-models-col-reasoning {\n  min-width: 180px;\n}\n\n.mt-models-provider {\n  font-weight: 600;\n}\n\n.mt-models-tag {\n  display: inline-block;\n  margin: 1px 4px 1px 0;\n  padding: 0 7px;\n  border-radius: 9px;\n  font-size: 10px;\n  line-height: 17px;\n  white-space: nowrap;\n  color: var(--dsw-alias-label-secondary);\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.mt-models-tag-rec {\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n.mt-models-tag-dormant {\n  margin-left: 4px;\n  color: var(--dsw-alias-state-warning-primary);\n  background: var(--dsw-alias-state-warning-tertiary);\n}\n\n.mt-models-model {\n  display: flex;\n  flex-direction: column;\n  gap: 1px;\n  min-width: 0;\n}\n\n.mt-models-model-name {\n  font-weight: 600;\n}\n\n.mt-models-model-id {\n  font-size: 11px;\n  color: var(--dsw-alias-label-dimmed);\n  word-break: break-all;\n}\n\n.mt-models-capacity {\n  font-variant-numeric: tabular-nums;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.mt-models-muted-cell {\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.mt-models-levels {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 2px;\n  margin-bottom: 2px;\n}\n\n.mt-models-level-none {\n  font-size: 11px;\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.mt-models-level-more {\n  font-size: 10px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.mt-models-link {\n  appearance: none;\n  padding: 0;\n  border: none;\n  background: transparent;\n  color: var(--dsw-alias-state-accent-primary, #4c8dff);\n  font: inherit;\n  font-size: 11px;\n  cursor: pointer;\n}\n\n.mt-models-link:hover {\n  text-decoration: underline;\n}\n\n.mt-models-link-danger {\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.mt-models-note {\n  width: 100%;\n  min-width: 140px;\n  box-sizing: border-box;\n  padding: 3px 8px;\n  border: 1px solid transparent;\n  border-radius: 6px;\n  outline: none;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  transition: border-color 120ms ease, background-color 120ms ease;\n}\n\n.mt-models-note:hover {\n  border-color: var(--dsw-alias-border-l3);\n}\n\n.mt-models-note:focus {\n  border-color: var(--dsw-alias-state-accent-primary, #4c8dff);\n  background: var(--dsw-alias-bg-base);\n}\n\n.mt-models-note::placeholder {\n  color: var(--dsw-alias-label-dimmed);\n}\n\n/* \u5C55\u5F00\u7684\u601D\u8003\u7B49\u7EA7\u7F16\u8F91\u5668\uFF08\u5360\u6574\u884C\uFF09\u3002 */\n.mt-models-expanded {\n  padding: 10px 12px;\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.mt-models-editor {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.mt-models-editor-title {\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.mt-models-editor-levels {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n}\n\n.mt-models-editor-level {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  font-size: 12px;\n  cursor: pointer;\n}\n\n.mt-models-editor-level-name {\n  font-weight: 600;\n}\n\n.mt-models-editor-level-id {\n  font-size: 11px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.mt-models-editor-add {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 8px;\n}\n\n.mt-models-editor-add .mt-search {\n  flex: 0 1 180px;\n}\n\n.mt-models-editor-actions {\n  display: flex;\n  gap: 8px;\n}\n\n.mt-models-toggle-label {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  white-space: nowrap;\n}\n\n/* \u601D\u8003\u5173\u95ED\u6807\u8BB0\uFF08\u6A21\u578B\u914D\u7F6E\u8868\u683C\u884C\u5185\uFF09\u3002 */\n.mt-models-tag-off {\n  color: var(--dsw-alias-state-error-primary);\n  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);\n}\n\n/* \u63A8\u8350\u7B49\u7EA7\u4E0B\u62C9\uFF08\u601D\u8003\u7B49\u7EA7\u7F16\u8F91\u5668\u5185\uFF09\u3002 */\n.mt-models-select {\n  appearance: none;\n  max-width: 260px;\n  padding: 3px 24px 3px 8px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 6px;\n  outline: none;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  cursor: pointer;\n}\n\n.mt-models-select:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n.mt-models-editor-label {\n  flex: none;\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.mt-models-editor-hint {\n  font-size: 11px;\n  color: var(--dsw-alias-label-dimmed);\n}\n";

// src/client/coi-styles.css
var coi_styles_default = '/**\n * dsh-memory-evolve \u2014 COI \u8C03\u5EA6 tab \u6837\u5F0F\uFF08coi- \u524D\u7F00\uFF0C\u7531 index.ts \u6CE8\u5165\uFF09\u3002\n * \u989C\u8272\u4E00\u5F8B\u8D70 DSH \u8BBE\u8BA1 token\uFF08--dsw-alias-* / --dsw-static-*\uFF09\uFF0C\u6DF1\u6D45\u8272\u81EA\u52A8\u9002\u914D\u3002\n */\n\n.coi-root {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n  height: 100%;\n  color: var(--dsw-alias-label-primary);\n  font-size: 13px;\n}\n\n/* ---- \u5B50 Tab \u6761 ---- */\n.coi-tabs {\n  display: flex;\n  gap: 4px;\n  padding: 8px 12px 0;\n  border-bottom: 1px solid var(--dsw-alias-interactive-bg-hover);\n  flex-shrink: 0;\n}\n\n.coi-tab {\n  appearance: none;\n  border: none;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  padding: 6px 12px;\n  cursor: pointer;\n  font-size: 13px;\n  border-radius: 6px 6px 0 0;\n}\n\n.coi-tab:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.coi-tab-active,\n.coi-tab-active:hover {\n  color: var(--dsw-alias-brand-primary);\n  background: var(--dsw-alias-interactive-bg-active);\n  font-weight: 600;\n}\n\n/* ---- \u5185\u5BB9\u533A ---- */\n.coi-body {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n}\n\n.coi-pane {\n  flex: 1;\n  min-height: 0;\n  overflow: auto;\n  padding: 12px;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.coi-tasks {\n  overflow: hidden;\n}\n\n/* ---- \u4EFB\u52A1\u89C6\u56FE\uFF1A\u5DE6\u5217\u8868 + \u53F3\u8BE6\u60C5 ---- */\n.coi-split {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  gap: 8px;\n}\n\n.coi-task-list {\n  flex: 0 0 46%;\n  min-width: 0;\n  overflow: auto;\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  padding: 4px;\n}\n\n.coi-task-row {\n  appearance: none;\n  border: none;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  padding: 6px 8px;\n  border-radius: 6px;\n  cursor: pointer;\n  text-align: left;\n  font-size: 12px;\n  width: 100%;\n}\n\n.coi-task-row:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.coi-task-row-active,\n.coi-task-row-active:hover {\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.coi-task-status {\n  flex-shrink: 0;\n}\n\n.coi-task-id {\n  flex-shrink: 0;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.coi-task-adapter {\n  flex-shrink: 0;\n  color: var(--dsw-alias-brand-primary);\n}\n\n.coi-task-prompt {\n  flex: 1;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.coi-task-time {\n  flex-shrink: 0;\n  font-size: 11px;\n}\n\n.coi-detail {\n  flex: 1;\n  min-width: 0;\n  overflow: auto;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  padding: 10px;\n}\n\n.coi-detail-meta {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n}\n\n.coi-meta-row {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n\n.coi-meta-row .coi-label {\n  min-width: 64px;\n}\n\n.coi-detail-actions {\n  display: flex;\n  gap: 8px;\n}\n\n.coi-log-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n}\n\n.coi-log-title {\n  margin-top: 4px;\n}\n\n.coi-log {\n  flex: 1;\n  min-height: 220px;\n  max-height: 45vh;\n  overflow: auto;\n  margin: 0;\n  padding: 8px;\n  border-radius: 6px;\n  background: var(--dsw-alias-markdown-code-block);\n  color: var(--dsw-alias-label-primary);\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n  font-size: 12px;\n  line-height: 1.5;\n  white-space: pre-wrap;\n  word-break: break-all;\n}\n\n.coi-guide {\n  margin: 4px 0 0;\n  padding: 8px;\n  border-radius: 6px;\n  background: var(--dsw-alias-markdown-code-block);\n  color: var(--dsw-alias-label-secondary);\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n  font-size: 12px;\n  line-height: 1.5;\n  white-space: pre-wrap;\n  word-break: break-word;\n  max-height: 40vh;\n  overflow: auto;\n}\n\n/* ---- \u5361\u7247 / \u8868\u5355 ---- */\n.coi-card {\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  padding: 10px;\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  flex-shrink: 0;\n}\n\n.coi-card-title {\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n}\n\n/* \u5361\u7247\u5934\u90E8\u884C\uFF1A\u6807\u9898 + \u53F3\u4FA7\u64CD\u4F5C\u6309\u94AE\uFF08\u5982\u53D1\u8D77\u8868\u5355\u7684\u5C55\u5F00/\u6536\u8D77\uFF09 */\n.coi-card-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n\n.coi-cards {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.coi-adapter-card {\n  gap: 4px;\n}\n\n.coi-form-grid {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 8px;\n}\n\n/* \u7EB5\u5411\u5361\u7247\u91CC\u7684\u5B57\u6BB5\uFF1Aflex-basis \u53EA\u7528\u4E8E\u6A2A\u5411\u7F51\u683C\uFF08\u5BBD\u5EA6\uFF09\uFF0C\n   \u7EB5\u5411\u6392\u5217\u65F6\u7981\u6B62\u6309 180px \u9AD8\u5EA6\u62C9\u4F38\uFF08\u5426\u5219\u6BCF\u4E2A\u5B57\u6BB5\u4E0B\u65B9\u7559\u5927\u7247\u7A7A\u767D\uFF09 */\n.coi-card > .coi-field {\n  flex: none;\n}\n\n.coi-field {\n  display: flex;\n  flex-direction: column;\n  gap: 3px;\n  flex: 1 1 180px;\n  min-width: 0;\n}\n\n.coi-field-wide {\n  flex-basis: 100%;\n}\n\n.coi-label {\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 12px;\n}\n\n/* \u8868\u5355\u5185\u914D\u7F6E\u533A\u5757\u6807\u9898\uFF08\u5982"\u4F1A\u8BDD\u6062\u590D\u914D\u7F6E"\uFF09\uFF1A\u5206\u9694\u7EBF + \u5F3A\u8C03\u8272\uFF0C\u4E0E\u666E\u901A label \u533A\u5206 */\n.coi-resume-section {\n  flex-basis: 100%;\n  border-top: 1px dashed var(--dsw-alias-interactive-bg-hover);\n  padding-top: 6px;\n  margin-top: 2px;\n}\n.coi-resume-section .coi-label {\n  color: var(--dsw-alias-label-primary);\n  font-weight: 600;\n}\n\n/* \u6CE8\u5165\u8F68\u52FE\u9009\u884C\uFF1A\u4E09\u4E2A checkbox \u6A2A\u5411\u6392\u5217 */\n.coi-inject-track-line {\n  flex-direction: row;\n  gap: 16px;\n}\n\n/* \u9002\u914D\u5668\u5361\u7247\uFF1A\u5E73\u5747\u8017\u65F6\u5FBD\u6807\uFF08\u6709\u5B8C\u6210\u8BB0\u5F55\u624D\u6E32\u67D3\uFF09 */\n.coi-avg-ms {\n  color: var(--dsw-alias-state-success-primary);\n  font-weight: 600;\n}\n\n.coi-input,\n.coi-select,\n.coi-textarea {\n  appearance: none;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  padding: 6px 8px;\n  font-size: 13px;\n  font-family: inherit;\n  outline: none;\n  min-width: 0;\n}\n\n.coi-input:focus,\n.coi-select:focus,\n.coi-textarea:focus {\n  border-color: var(--dsw-alias-brand-primary);\n}\n\n.coi-textarea {\n  resize: vertical;\n}\n\n.coi-form-actions {\n  display: flex;\n  gap: 8px;\n  justify-content: flex-end;\n}\n\n/* ---- \u6309\u94AE ---- */\n.coi-btn {\n  appearance: none;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: var(--dsw-alias-button-tool-bar-fill);\n  color: var(--dsw-alias-interactive-fg-default);\n  padding: 6px 14px;\n  font-size: 13px;\n  cursor: pointer;\n}\n\n.coi-btn:hover {\n  background: var(--dsw-alias-button-tool-bar-hover);\n}\n\n.coi-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n.coi-btn-primary {\n  background: var(--dsw-alias-button-primary-fill);\n  border-color: transparent;\n  color: var(--dsw-alias-label-primary-inverted);\n}\n\n.coi-btn-primary:hover {\n  background: var(--dsw-alias-button-primary-hover);\n}\n\n.coi-btn-danger {\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.coi-btn-danger:hover {\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n}\n\n.coi-btn-mini {\n  padding: 2px 8px;\n  font-size: 12px;\n}\n\n/* ---- \u5DE5\u5177\u6761 / \u5217\u8868\u884C ---- */\n.coi-toolbar {\n  display: flex;\n  gap: 8px;\n  align-items: center;\n  flex-shrink: 0;\n}\n\n.coi-toolbar .coi-input {\n  flex: 1;\n}\n\n.coi-row {\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  padding: 8px 10px;\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  flex-shrink: 0;\n}\n\n.coi-row-line {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n  flex-wrap: wrap;\n}\n\n.coi-grow {\n  flex: 1;\n  min-width: 0;\n}\n\n/* ---- \u5FBD\u6807 / \u72B6\u6001\u8272 ---- */\n.coi-badge {\n  display: inline-block;\n  padding: 1px 8px;\n  border-radius: 999px;\n  background: var(--dsw-alias-interactive-bg-active);\n  color: var(--dsw-alias-label-secondary);\n  font-size: 11px;\n  flex-shrink: 0;\n}\n\n.coi-status-queued {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.coi-status-running {\n  color: var(--dsw-alias-state-business-primary);\n}\n\n.coi-status-completed {\n  color: var(--dsw-alias-state-success-primary);\n}\n\n.coi-status-failed {\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.coi-status-killed {\n  color: var(--dsw-alias-state-warn-primary);\n}\n\n.coi-status-interrupted {\n  color: var(--dsw-alias-state-warn-primary);\n}\n\n/* ---- \u63D0\u793A ---- */\n.coi-notice {\n  padding: 6px 10px;\n  border-radius: 6px;\n  font-size: 12px;\n  flex-shrink: 0;\n}\n\n.coi-notice-ok {\n  background: var(--dsw-alias-state-success-tertiary);\n  color: var(--dsw-alias-state-success-primary);\n}\n\n.coi-notice-error {\n  /* \u80CC\u666F error-secondary \u4E0E\u6587\u5B57 error-primary \u5728\u6697\u8272\u4E3B\u9898\u4E0B\u540C\u8272\uFF08\u5747 red-400\uFF09\uFF0C\n     \u5FC5\u987B\u7528\u8DE8\u4E3B\u9898\u56FA\u5B9A\u7684\u6DF1\u7EA2\u505A\u6587\u5B57\u8272\uFF0C\u5426\u5219\u6587\u5B57\u4E0D\u53EF\u89C1\uFF08\u66FE\u8868\u73B0\u4E3A"\u7A7A\u7EA2\u6846"\uFF09\u3002 */\n  background: var(--dsw-alias-state-error-secondary);\n  color: var(--dsw-static-red-900);\n}\n\n.coi-error {\n  padding: 6px 10px;\n  border-radius: 6px;\n  background: var(--dsw-alias-state-error-secondary);\n  /* \u540C\u4E0A\uFF1A\u6697\u8272\u4E3B\u9898\u4E0B error-primary \u4E0E\u80CC\u666F\u540C\u8272\uFF0C\u56FA\u5B9A\u6DF1\u7EA2\u4FDD\u8BC1\u53EF\u8BFB */\n  color: var(--dsw-static-red-900);\n  font-size: 12px;\n  flex-shrink: 0;\n  white-space: pre-wrap;\n  word-break: break-word;\n}\n\n/* ---- \u7EDF\u8BA1 ---- */\n.coi-stat-grid {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 8px;\n  flex-shrink: 0;\n}\n\n.coi-stat-card {\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  padding: 12px;\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  min-width: 140px;\n  flex: 1 1 140px;\n}\n\n.coi-stat-num {\n  font-size: 24px;\n  font-weight: 700;\n  color: var(--dsw-alias-brand-primary);\n}\n\n/* ---- \u6742\u9879 ---- */\n.coi-mono {\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n}\n\n.coi-small {\n  font-size: 11px;\n}\n\n.coi-muted {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.coi-strong {\n  font-weight: 600;\n}\n\n.coi-pad {\n  padding: 12px;\n}\n\n/* ---- \u65E5\u5FD7\u5168\u5C4F\u5F39\u7A97 ---- */\n.coi-modal {\n  position: fixed;\n  inset: 0;\n  z-index: 1000;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: rgba(0, 0, 0, 0.5);\n}\n\n.coi-modal-box {\n  display: flex;\n  flex-direction: column;\n  width: 92vw;\n  height: 88vh;\n  max-width: 1400px;\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-overlay);\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  overflow: hidden;\n}\n\n.coi-modal-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n  padding: 8px 12px;\n  border-bottom: 1px solid var(--dsw-alias-interactive-bg-hover);\n  flex-shrink: 0;\n}\n\n.coi-log-full {\n  flex: 1;\n  min-height: 0;\n  max-height: none;\n  overflow: auto;\n  border-radius: 0;\n  margin: 0;\n}\n\n/* ---- \u5C0F\u65F6/\u5206\u949F\u6A2A\u6392 ---- */\n.coi-inline {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n\n.coi-inline .coi-input {\n  width: 88px;\n  flex-shrink: 0;\n}\n\n/* ---- \u53D1\u8D77\u4EFB\u52A1\u5927\u8F93\u5165\u6846 ---- */\n.coi-textarea-lg {\n  min-height: 130px;\n}\n\n/* ---- \u6280\u80FD\u7F16\u8F91\u5F39\u7A97\u7F16\u8F91\u5668 ---- */\n.coi-skill-editor {\n  flex: 1;\n  min-height: 0;\n  margin: 0 12px 12px;\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n  font-size: 12px;\n  line-height: 1.5;\n  white-space: pre;\n  overflow: auto;\n}\n\n.coi-skill-tag {\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n}\n\n/* ---- \u4EFB\u52A1\u5217\u8868\u641C\u7D22\u680F ---- */\n.coi-task-toolbar {\n  padding: 0 12px;\n  flex-shrink: 0;\n}\n\n.coi-task-toolbar .coi-input {\n  width: 100%;\n}\n\n/* ---- \u8BE6\u60C5\uFF1A\u4EFB\u52A1\u5185\u5BB9\uFF08\u53EA\u8BFB\uFF0C\u5C0F\u533A\u57DF\uFF0C\u53EF\u6EDA\u52A8\uFF09 ---- */\n.coi-prompt-view {\n  max-height: 120px;\n  overflow: auto;\n  margin: 0;\n  padding: 8px;\n  border-radius: 6px;\n  background: var(--dsw-alias-markdown-code-block);\n  color: var(--dsw-alias-label-primary);\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n  font-size: 12px;\n  line-height: 1.5;\n  white-space: pre-wrap;\n  word-break: break-all;\n}\n\n.coi-prompt-view-full {\n  white-space: pre-wrap;\n  word-break: break-all;\n}\n';

// src/client/scratch-styles.css
var scratch_styles_default = "/**\n * dsh-memory-evolve \u2014 \u4E34\u65F6\u4FE1\u606F tab \u6837\u5F0F\uFF08`sp-` \u524D\u7F00\uFF09\u3002\n * \u989C\u8272\u53EA\u7528 --dsw-alias-* token\uFF0C\u6DF1\u6D45\u8272\u81EA\u52A8\u9002\u914D\uFF08\u4E0E coi- \u4E00\u81F4\uFF09\u3002\n */\n\n.sp-root {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n  height: 100%;\n  box-sizing: border-box;\n  gap: 8px;\n  padding: 12px;\n  color: var(--dsw-alias-label-primary);\n  font-size: 13px;\n}\n\n.sp-head {\n  flex: none;\n  display: flex;\n  align-items: baseline;\n  gap: 10px;\n  min-width: 0;\n}\n\n.sp-path {\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary);\n  font-family: var(--dsw-font-family-mono, monospace);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.sp-saved-at {\n  flex: none;\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.sp-help {\n  flex: none;\n  margin: 0;\n  font-size: 12px;\n  line-height: 1.6;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.sp-editor {\n  flex: 1;\n  min-height: 0;\n  width: 100%;\n  box-sizing: border-box;\n  resize: none;\n  appearance: none;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  padding: 12px 14px;\n  font-family: var(--dsw-font-family-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace);\n  font-size: 13px;\n  line-height: 1.7;\n  outline: none;\n}\n\n.sp-editor:focus {\n  border-color: var(--dsw-alias-brand-primary);\n}\n\n.sp-editor::placeholder {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.sp-toolbar {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  min-height: 30px;\n}\n\n.sp-spacer {\n  flex: 1;\n}\n\n.sp-status {\n  font-size: 12px;\n  line-height: 1.4;\n}\n\n.sp-status-ok {\n  color: var(--dsw-alias-state-success-primary);\n}\n\n.sp-status-pending {\n  color: var(--dsw-alias-label-secondary);\n}\n\n.sp-status-error {\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.sp-notice {\n  font-size: 12px;\n  line-height: 1.4;\n  border-radius: 6px;\n  padding: 3px 8px;\n}\n\n/* notice \u884C\u5185\u7684\u64CD\u4F5C\u6309\u94AE\uFF08\u91CD\u8BD5 / \u6253\u5F00\uFF09\uFF0C\u4E0E\u6587\u6848\u540C\u884C\u53F3\u6392 */\n.sp-notice-actions {\n  display: inline-flex;\n  gap: 6px;\n  margin-left: 8px;\n  vertical-align: middle;\n}\n\n.sp-btn-small {\n  padding: 1px 8px;\n  font-size: 12px;\n  border-radius: 4px;\n}\n\n/* \u8B66\u793A\uFF08\u975E\u9519\u8BEF\uFF09\uFF1A\u5982\u300C\u5176\u4ED6\u7A97\u53E3\u4FEE\u6539\u4E86\u4FBF\u7B7E\u300D\u63D0\u793A */\n.sp-notice-warn {\n  color: var(--dsw-alias-label-secondary);\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.sp-notice-ok {\n  color: var(--dsw-alias-state-success-primary);\n  background: var(--dsw-alias-state-success-tertiary);\n}\n\n.sp-notice-error {\n  /* \u6697\u8272\u4E3B\u9898\u4E0B error-primary \u4E0E error-secondary \u540C\u8272\uFF08red-400\uFF09\uFF0C\n     \u56FA\u5B9A\u6DF1\u7EA2\u4FDD\u8BC1\u6587\u5B57\u5728\u7C89\u7EA2\u5E95\u4E0A\u53EF\u8BFB */\n  color: var(--dsw-static-red-900);\n  background: var(--dsw-alias-state-error-secondary);\n}\n\n.sp-loading {\n  padding: 12px 0;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.sp-btn {\n  flex: none;\n  appearance: none;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: var(--dsw-alias-button-tool-bar-fill);\n  color: var(--dsw-alias-interactive-fg-default);\n  padding: 5px 14px;\n  font-size: 13px;\n  cursor: pointer;\n}\n\n.sp-btn:hover {\n  background: var(--dsw-alias-button-tool-bar-hover);\n}\n\n.sp-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n";

// src/client/prompt-styles.css
var prompt_styles_default = "/**\n * dsh-memory-evolve \u2014 \u63D0\u793A\u8BCD tab \u6837\u5F0F\uFF08pm- \u524D\u7F00\uFF09\u3002\n * \u5E03\u5C40\uFF1A\u9876\u680F\uFF08\u641C\u7D22/\u7B5B\u9009/\u6309\u94AE\uFF09+ \u4E09\u680F\u4E3B\u4F53\uFF08\u5206\u7C7B\u6811 / \u5217\u8868 / \u8BE6\u60C5\u8868\u5355\uFF09\u3002\n * \u989C\u8272\u5168\u90E8\u4F7F\u7528 DSH \u8BBE\u8BA1 token\uFF08--dsw-alias-* / --dsw-static-*\uFF09\uFF0C\u6DF1\u6D45\u8272\n * \u81EA\u52A8\u9002\u914D\uFF1B\u9AD8\u5EA6\u94FA\u6EE1\u7236\u5BB9\u5668\uFF08conversation.view \u7684 tab \u5BB9\u5668\u662F flex \u5217\uFF09\u3002\n */\n\n.pm-root {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  padding: 8px;\n  box-sizing: border-box;\n  overflow: hidden;\n}\n\n/* ---------- \u9876\u680F ---------- */\n.pm-toolbar {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex-shrink: 0;\n}\n\n.pm-search {\n  flex: 1;\n  min-width: 0;\n  height: 30px;\n  padding: 0 10px;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font-size: 13px;\n  outline: none;\n}\n.pm-search:focus {\n  border-color: var(--dsw-alias-brand-primary);\n}\n.pm-search::placeholder {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.pm-select {\n  height: 30px;\n  padding: 0 8px;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font-size: 13px;\n  outline: none;\n  cursor: pointer;\n  max-width: 140px;\n}\n\n.pm-tool-btn {\n  height: 30px;\n  padding: 0 10px;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: var(--dsw-alias-button-tool-bar-fill);\n  color: var(--dsw-alias-label-primary);\n  font-size: 13px;\n  cursor: pointer;\n  white-space: nowrap;\n}\n.pm-tool-btn:hover {\n  background: var(--dsw-alias-button-tool-bar-hover);\n}\n.pm-tool-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n.pm-primary-btn {\n  height: 30px;\n  padding: 0 12px;\n  border: none;\n  border-radius: 6px;\n  background: var(--dsw-alias-brand-primary);\n  color: var(--dsw-alias-label-primary-inverted);\n  font-size: 13px;\n  cursor: pointer;\n  white-space: nowrap;\n}\n.pm-primary-btn:hover {\n  background: var(--dsw-alias-button-primary-hover);\n}\n\n.pm-danger-btn {\n  height: 30px;\n  padding: 0 10px;\n  border: 1px solid var(--dsw-alias-state-error-secondary);\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-state-error-primary);\n  font-size: 13px;\n  cursor: pointer;\n  white-space: nowrap;\n}\n.pm-danger-btn:hover {\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n}\n\n/* ---------- \u9876\u680F\u6D88\u606F\u6A2A\u5E45 ---------- */\n.pm-banner {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 6px 10px;\n  border-radius: 6px;\n  background: var(--dsw-alias-state-success-tertiary);\n  color: var(--dsw-alias-state-success-primary);\n  font-size: 12px;\n  flex-shrink: 0;\n}\n.pm-banner-error {\n  background: var(--dsw-alias-state-error-secondary);\n  color: var(--dsw-alias-state-error-primary);\n}\n.pm-banner-close {\n  margin-left: auto;\n  border: none;\n  background: transparent;\n  color: inherit;\n  font-size: 14px;\n  cursor: pointer;\n}\n\n/* ---------- \u6D6E\u5C42\uFF08\u6CE8\u5165\u4E2D / \u6765\u6E90\uFF09 ---------- */\n.pm-overlay {\n  position: absolute;\n  top: 46px;\n  right: 8px;\n  z-index: 50;\n  width: 320px;\n  max-width: calc(100vw - 48px);\n  max-height: 60vh;\n  overflow-y: auto;\n  padding: 10px;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-overlay);\n  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n.pm-overlay-wide {\n  width: 420px;\n}\n.pm-overlay-title {\n  font-size: 13px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n}\n.pm-overlay-sub {\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary);\n}\n.pm-overlay-empty {\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary);\n  padding: 4px 0;\n}\n.pm-overlay-item {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 6px 8px;\n  border-radius: 6px;\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n.pm-overlay-item-main {\n  flex: 1;\n  min-width: 0;\n}\n.pm-overlay-item-title {\n  font-size: 12px;\n  color: var(--dsw-alias-label-primary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.pm-overlay-item-sub {\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n}\n.pm-overlay-remove {\n  flex-shrink: 0;\n}\n.pm-source-item {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  padding: 6px 8px;\n  border-radius: 6px;\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n.pm-source-link {\n  font-size: 12px;\n  font-weight: 600;\n  color: var(--dsw-alias-brand-primary);\n  text-decoration: none;\n}\n.pm-source-link:hover {\n  text-decoration: underline;\n}\n.pm-source-desc {\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n/* ---------- \u4E09\u680F\u4E3B\u4F53 ---------- */\n.pm-body {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  gap: 8px;\n  position: relative;\n}\n\n/* \u5DE6\uFF1A\u5206\u7C7B\u6811 */\n.pm-pane-cats {\n  width: 130px;\n  flex-shrink: 0;\n  overflow-y: auto;\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  padding: 4px;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n}\n.pm-cat {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 6px;\n  padding: 6px 8px;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font-size: 12px;\n  cursor: pointer;\n  text-align: left;\n}\n.pm-cat:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n.pm-cat-active {\n  background: var(--dsw-alias-interactive-bg-active);\n  color: var(--dsw-alias-brand-primary);\n  font-weight: 600;\n}\n.pm-cat-name {\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.pm-cat-count {\n  font-size: 11px;\n  color: var(--dsw-alias-label-tertiary);\n  flex-shrink: 0;\n}\n\n/* \u5206\u7C7B\u884C\uFF08\u542B\u5220\u9664\u6309\u94AE\uFF09\u4E0E\u5206\u7C7B\u7BA1\u7406\uFF08\u6DFB\u52A0/\u5220\u9664\uFF09 */\n.pm-cat-row {\n  display: flex;\n  align-items: center;\n  gap: 2px;\n}\n.pm-cat-row .pm-cat {\n  flex: 1;\n  min-width: 0;\n}\n.pm-cat-del {\n  flex-shrink: 0;\n  width: 18px;\n  height: 18px;\n  border: none;\n  border-radius: 4px;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 12px;\n  line-height: 1;\n  cursor: pointer;\n  opacity: 0;\n}\n.pm-cat-row:hover .pm-cat-del {\n  opacity: 1;\n}\n.pm-cat-del:hover {\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n  color: var(--dsw-alias-state-error-primary);\n}\n.pm-cat-add-btn {\n  margin-top: 4px;\n  padding: 5px 8px;\n  border: 1px dashed var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12px;\n  cursor: pointer;\n  text-align: left;\n}\n.pm-cat-add-btn:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-brand-primary);\n}\n.pm-cat-add {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  margin-top: 4px;\n}\n.pm-cat-add-input {\n  flex: 1;\n  min-width: 0;\n  height: 24px;\n  padding: 0 6px;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 4px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font-size: 12px;\n  outline: none;\n}\n.pm-cat-add-input:focus {\n  border-color: var(--dsw-alias-brand-primary);\n}\n.pm-cat-add-ok {\n  width: 24px;\n  height: 24px;\n  border: none;\n  border-radius: 4px;\n  background: var(--dsw-alias-brand-primary);\n  color: var(--dsw-alias-label-primary-inverted);\n  font-size: 12px;\n  cursor: pointer;\n}\n\n/* \u4E2D\uFF1A\u5217\u8868 */\n.pm-pane-list {\n  flex: 1;\n  min-width: 0;\n  overflow-y: auto;\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  padding: 4px;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n}\n.pm-item {\n  display: flex;\n  flex-direction: column;\n  gap: 3px;\n  padding: 8px 10px;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  cursor: pointer;\n  text-align: left;\n}\n.pm-item:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n.pm-item-active {\n  background: var(--dsw-alias-interactive-bg-active);\n}\n.pm-item-row1 {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  min-width: 0;\n}\n.pm-item-name {\n  font-size: 13px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.pm-item-badge {\n  flex-shrink: 0;\n  padding: 1px 6px;\n  border-radius: 8px;\n  font-size: 10px;\n  color: var(--dsw-alias-label-secondary);\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n.pm-item-badge-active {\n  color: var(--dsw-alias-state-success-primary);\n  background: var(--dsw-alias-state-success-tertiary);\n  font-weight: 600;\n}\n/* \u7981\u7528\u63D0\u793A\u8BCD\uFF1A\u5217\u8868\u7F6E\u7070 + \u300C\u5DF2\u7981\u7528\u300D\u5FBD\u6807\uFF08AI \u7684 de_prompts \u5217\u8868\u770B\u4E0D\u5230\u5B83\uFF09 */\n.pm-item-disabled .pm-item-name {\n  color: var(--dsw-alias-label-tertiary);\n  text-decoration: line-through;\n}\n.pm-item-badge-off {\n  color: var(--dsw-alias-label-tertiary);\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n.pm-inject-status {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  padding: 4px 10px;\n  border-radius: 6px;\n  font-size: 12px;\n  font-weight: 600;\n  color: var(--dsw-alias-state-success-primary);\n  background: var(--dsw-alias-state-success-tertiary);\n}\n.pm-item-summary {\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.pm-item-row3 {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 6px;\n}\n.pm-item-usage,\n.pm-item-used {\n  font-size: 10px;\n  color: var(--dsw-alias-label-tertiary);\n}\n.pm-pane-empty {\n  padding: 24px 12px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary);\n  text-align: center;\n}\n\n/* \u53F3\uFF1A\u8BE6\u60C5\u8868\u5355 */\n.pm-pane-detail {\n  width: 42%;\n  min-width: 260px;\n  flex-shrink: 0;\n  overflow-y: auto;\n  padding: 10px;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n}\n.pm-detail-hint {\n  padding: 24px 12px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary);\n  text-align: center;\n}\n.pm-form {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  height: 100%;\n}\n.pm-form-title {\n  font-size: 13px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n  flex-shrink: 0;\n}\n\n/* \u5FEB\u901F\u6CE8\u5165\uFF08\u4E34\u65F6\u6CE8\u5165\uFF09\u8BF4\u660E\u6587\u5B57 */\n.pm-quick-sub {\n  font-size: 12px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-secondary);\n  flex-shrink: 0;\n}\n\n/* \u6CE8\u5165\u53C2\u6570\u6570\u5B57\u8F93\u5165\u6846\uFF08\u6B21\u6570/\u95F4\u9694\uFF0C\u81EA\u7531\u8F93\u5165\u4EFB\u610F\u6574\u6570\uFF09 */\n.pm-num-row {\n  display: flex;\n  align-items: flex-start;\n  gap: 8px;\n  flex-shrink: 0;\n}\n.pm-num-field {\n  flex: 1;\n  min-width: 0;\n}\n.pm-num-input {\n  width: 100%;\n  box-sizing: border-box;\n}\n.pm-field-hint {\n  margin-left: 6px;\n  font-weight: 400;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n/* \u6CE8\u5165\u6548\u679C\u5373\u65F6\u9884\u89C8\uFF08\u6B21\u6570 \xD7 \u95F4\u9694 \u2192 \u5B9E\u9645\u884C\u4E3A\u8BF4\u660E\uFF0C\u6362\u884C\u663E\u793A\u5728\u53C2\u6570\u533A\u4E0B\u65B9\uFF09 */\n.pm-effect-hint {\n  width: 100%;\n  font-size: 11px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-secondary);\n  flex-shrink: 0;\n}\n\n/* \u81EA\u5B9A\u4E49\u6CE8\u5165\u533A\uFF08\u9884\u8BBE\u6309\u94AE\u4E4B\u5916\u7684\u81EA\u7531\u8F93\u5165\uFF0C\u9ED8\u8BA4\u6536\u8D77\uFF09 */\n.pm-custom-zone {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  width: 100%;\n  padding: 8px;\n  box-sizing: border-box;\n  border: 1px dashed var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n  flex-shrink: 0;\n}\n.pm-custom-zone-inline {\n  /* \u5728 flex-wrap \u7684 pm-actions \u91CC\u5360\u6EE1\u6574\u884C\uFF0C\u4E0E\u9884\u8BBE\u6309\u94AE\u7EC4\u5206\u884C\u663E\u793A */\n  flex-basis: 100%;\n}\n.pm-field {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  flex-shrink: 0;\n}\n/* \u542F\u7528\u72B6\u6001\u884C\uFF1Alabel \u4E0E\u5F00\u5173\u6309\u94AE\u6A2A\u6392 */\n.pm-enable-row {\n  flex-direction: row;\n  align-items: center;\n  justify-content: space-between;\n}\n.pm-toggle {\n  flex-shrink: 0;\n  padding: 3px 12px;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 10px;\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n  background: var(--dsw-alias-bg-base);\n  cursor: pointer;\n}\n.pm-toggle-on {\n  color: var(--dsw-alias-state-success-primary);\n  border-color: var(--dsw-alias-state-success-tertiary);\n  background: var(--dsw-alias-state-success-tertiary);\n  font-weight: 600;\n}\n.pm-field-grow {\n  flex: 1;\n  min-height: 0;\n}\n.pm-field-label {\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n}\n.pm-input {\n  height: 30px;\n  padding: 0 10px;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font-size: 13px;\n  outline: none;\n}\n.pm-input:focus {\n  border-color: var(--dsw-alias-brand-primary);\n}\n.pm-textarea {\n  flex: 1;\n  min-height: 120px;\n  padding: 8px 10px;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font-size: 12px;\n  font-family: var(--dsw-font-family-mono);\n  line-height: 1.5;\n  resize: none;\n  outline: none;\n}\n.pm-textarea:focus {\n  border-color: var(--dsw-alias-brand-primary);\n}\n.pm-textarea::placeholder {\n  color: var(--dsw-alias-label-tertiary);\n}\n.pm-actions {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex-wrap: wrap;\n  flex-shrink: 0;\n}\n.pm-inject-group {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n.pm-rounds {\n  max-width: 170px;\n}\n.pm-dirty-hint {\n  font-size: 11px;\n  color: var(--dsw-alias-state-warn-primary);\n  flex-shrink: 0;\n}\n";

// src/client/broadcast-styles.css
var broadcast_styles_default = "/* \u4F1A\u8BDD\u5E7F\u64AD\u7BA1\u7406 Tab\uFF08bb- \u524D\u7F00\uFF0C\u72EC\u7ACB\u6CE8\u5165\uFF1B\u5E7F\u64AD\u6A21\u5757\u72EC\u7ACB\u6837\u5F0F\uFF09\u3002\n   \u5168\u90E8\u989C\u8272\u8D70 --dsw-alias-*/--dsw-static-* token\uFF0C\u8DDF\u968F\u660E\u6697\u4E3B\u9898\u3002\n   \u5B50 Tab \u76F4\u63A5\u590D\u7528\u5168\u5C40 mt-file-tabs / mt-file-tab / mt-file-tab-active\n   \uFF08\u4E0E\u8BB0\u5FC6/\u5F85\u529E/\u6280\u80FD\u7B49 Tab \u7684\u5B50 Tab \u96F6\u5DEE\u5F02\uFF09\uFF0C\u6B64\u5904\u4E0D\u518D\u5B9A\u4E49\u3002 */\n\n/* ---------- \u6839\u9762\u677F ---------- */\n\n.bb-pane {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n  padding: 4px 2px 20px;\n  font-family: var(--dsw-font-family, inherit);\n  color: var(--dsw-alias-label-primary);\n  font-size: 13px;\n}\n\n.bb-grow {\n  flex: 1 1 auto;\n  min-width: 0;\n}\n\n/* ---------- \u4F1A\u8BDD ID \u884C\uFF08\u4F4D\u4E8E\u5B50 Tab \u4E0B\u65B9\uFF09 ---------- */\n\n.bb-session-line {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex-wrap: wrap;\n  padding: 8px 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-layer-1);\n  font-size: 12px;\n}\n\n.bb-session-label {\n  color: var(--dsw-alias-label-secondary);\n  flex: none;\n}\n\n.bb-session-line code,\n.bb-mono {\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n  font-size: 12px;\n  color: var(--dsw-alias-label-primary);\n}\n\n/* ---------- \u5217\u8868\u4E0E\u5361\u7247 ---------- */\n\n.bb-list {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.bb-card {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding: 12px 14px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  background: var(--dsw-alias-bg-layer-1);\n  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);\n  transition: border-color 0.15s ease, box-shadow 0.15s ease;\n}\n\n.bb-card:hover {\n  border-color: var(--dsw-alias-border-l, rgba(128, 128, 128, 0.4));\n  box-shadow: 0 2px 6px color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);\n}\n\n/* \u5C55\u5F00\u4E2D\u7684\u623F\u95F4\u5361\u7247\uFF1A\u7565\u62AC\u5347\u5C42\u6B21 */\n.bb-card-open {\n  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, var(--dsw-alias-border-l2));\n  box-shadow: 0 2px 8px color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);\n}\n\n.bb-card-dissolved {\n  opacity: 0.78;\n}\n\n.bb-row {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex-wrap: wrap;\n}\n\n.bb-strong {\n  font-weight: 600;\n  font-size: 13px;\n  color: var(--dsw-alias-label-primary);\n}\n\n.bb-muted {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.bb-small {\n  font-size: 12px;\n}\n\n/* \u623F\u95F4\u5143\u4FE1\u606F\u884C\uFF08id / \u521B\u5EFA\u65F6\u95F4 / \u590D\u5236\uFF09 */\n.bb-meta {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  flex-wrap: wrap;\n}\n\n/* \u5206\u533A\u5C0F\u6807\u9898\uFF08\u6210\u5458 / \u623F\u95F4\u6D88\u606F\uFF09 */\n.bb-section-title {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  font-size: 12px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-secondary);\n  margin-bottom: 2px;\n}\n\n.bb-count {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  min-width: 18px;\n  height: 18px;\n  padding: 0 6px;\n  border-radius: 9px;\n  font-size: 11px;\n  font-weight: 500;\n  line-height: 1;\n  color: var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary));\n  background: var(--dsw-alias-state-business-tertiary, var(--dsw-alias-interactive-bg-hover));\n}\n\n/* ---------- \u5FBD\u6807 ---------- */\n\n.bb-badge {\n  display: inline-flex;\n  align-items: center;\n  font-size: 11px;\n  line-height: 1.2;\n  padding: 2px 8px;\n  border-radius: 9px;\n  color: var(--dsw-alias-label-tertiary);\n  background: var(--dsw-alias-interactive-bg-hover);\n  white-space: nowrap;\n}\n\n.bb-badge-long {\n  color: var(--dsw-static-amber-5, #f59e0b);\n  background: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 14%, transparent);\n}\n\n.bb-badge-unread {\n  color: var(--dsw-static-red-900, #c53030);\n  background: color-mix(in srgb, var(--dsw-static-red-900, #c53030) 12%, transparent);\n}\n\n.bb-badge-read {\n  color: var(--dsw-alias-label-tertiary);\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.bb-badge-online {\n  color: var(--dsw-alias-state-success-primary, #2f9e44);\n  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2f9e44) 14%, transparent);\n}\n\n.bb-badge-dissolved {\n  color: var(--dsw-alias-state-error-primary, #e5484d);\n  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 12%, transparent);\n}\n\n/* ---------- \u5728\u7EBF\u72B6\u6001\u70B9 ---------- */\n\n.bb-dot {\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  flex: none;\n  box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 12%, transparent);\n}\n\n.bb-dot-on {\n  background: var(--dsw-alias-state-success-primary, #2f9e44);\n  color: var(--dsw-alias-state-success-primary, #2f9e44);\n}\n\n.bb-dot-idle {\n  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.5));\n  color: var(--dsw-alias-label-tertiary);\n  box-shadow: none;\n}\n\n.bb-dot-off {\n  background: var(--dsw-alias-state-error-primary, #e5484d);\n  color: var(--dsw-alias-state-error-primary, #e5484d);\n}\n\n/* ---------- \u6D88\u606F\u5168\u6587 ---------- */\n\n.bb-content {\n  margin: 4px 0 0;\n  padding: 10px 12px;\n  max-height: 320px;\n  overflow: auto;\n  font-size: 12px;\n  line-height: 1.55;\n  white-space: pre-wrap;\n  word-break: break-word;\n  background: var(--dsw-alias-bg-base);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  color: var(--dsw-alias-label-primary);\n}\n\n/* ---------- \u6210\u5458\u5217\u8868 ---------- */\n\n.bb-members {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  margin-top: 4px;\n  padding: 10px 12px;\n  background: var(--dsw-alias-bg-base);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n}\n\n.bb-member {\n  font-size: 12px;\n  padding: 4px 6px;\n  border-radius: 6px;\n  transition: background 0.12s ease;\n}\n\n.bb-member:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n/* ---------- \u6309\u94AE ---------- */\n\n.bb-btn {\n  appearance: none;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.35));\n  border-radius: 6px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12px;\n  line-height: 1.2;\n  padding: 4px 10px;\n  cursor: pointer;\n  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;\n}\n\n.bb-btn:hover:not(:disabled) {\n  border-color: var(--dsw-alias-interactive-bg-active, rgba(128, 128, 128, 0.6));\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.bb-btn:active:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover));\n}\n\n.bb-btn:disabled {\n  opacity: 0.45;\n  cursor: default;\n}\n\n.bb-btn:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));\n  outline-offset: 1px;\n}\n\n.bb-btn-mini {\n  font-size: 11px;\n  padding: 3px 8px;\n}\n\n/* \u623F\u95F4\u8BE6\u60C5\u4E3B\u64CD\u4F5C\uFF1A\u6B63\u5E38\u5C3A\u5BF8\uFF0C\u6613\u70B9 */\n.bb-btn-detail {\n  font-size: 12px;\n  padding: 6px 12px;\n  font-weight: 500;\n  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent);\n  color: var(--dsw-alias-brand-primary);\n  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent);\n}\n\n.bb-btn-detail:hover:not(:disabled) {\n  border-color: var(--dsw-alias-brand-primary);\n  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);\n  color: var(--dsw-alias-brand-primary);\n}\n\n.bb-btn-primary {\n  border-color: var(--dsw-alias-state-accent-primary, #4c8dff);\n  color: var(--dsw-alias-state-accent-primary, #4c8dff);\n}\n\n/* \u5371\u9669\u6309\u94AE\uFF1A**\u5B9E\u5E95\u7EA2 + \u767D\u5B57**\uFF08\u7528\u6237\u53CD\u9988\u6D45\u7EA2\u5E95/\u7EA2\u5B57\u5728\u6697\u8272\u4E3B\u9898\u4E0B\u770B\u4E0D\u6E05\uFF1B\n   \u5B9E\u5E95\u4FDD\u8BC1\u4EFB\u4F55\u4E3B\u9898\u4E0B\u90FD\u9192\u76EE\uFF09\uFF0Chover \u52A0\u6DF1 */\n.bb-btn-danger {\n  color: #fff;\n  border-color: var(--dsw-static-red-900, #c53030);\n  background: var(--dsw-static-red-900, #c53030);\n}\n\n.bb-btn-danger:hover:not(:disabled) {\n  background: color-mix(in srgb, var(--dsw-static-red-900, #c53030) 82%, #000);\n  border-color: color-mix(in srgb, var(--dsw-static-red-900, #c53030) 82%, #000);\n  color: #fff;\n}\n\n/* ---------- \u7B5B\u9009\u82AF\u7247\uFF08\u6D88\u606F/\u623F\u95F4\u6D88\u606F\u5DE5\u5177\u680F\uFF1B\u975E\u4E3B Tab\uFF09 ---------- */\n\n.bb-chip {\n  appearance: none;\n  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  border-radius: 6px;\n  padding: 4px 10px;\n  font-size: 12px;\n  line-height: 1.2;\n  color: var(--dsw-alias-label-secondary);\n  background: transparent;\n  cursor: pointer;\n  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;\n}\n\n.bb-chip:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.bb-chip-active {\n  color: var(--dsw-alias-label-primary);\n  border-color: var(--dsw-alias-brand-primary);\n  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);\n  font-weight: 500;\n}\n\n.bb-chip-active:hover {\n  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent);\n}\n\n/* ---------- \u5DE5\u5177\u680F\uFF08\u7B5B\u9009 + \u641C\u7D22\uFF09\u4E0E\u5206\u9875 ---------- */\n\n.bb-toolbar {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex-wrap: wrap;\n  padding: 2px 0;\n}\n\n.bb-search {\n  flex: 1 1 160px;\n  min-width: 0;\n  appearance: none;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.35));\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font-size: 12px;\n  padding: 6px 10px;\n  outline: none;\n  transition: border-color 0.12s ease;\n}\n\n.bb-search::placeholder {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.bb-search:hover {\n  border-color: var(--dsw-alias-interactive-bg-active, rgba(128, 128, 128, 0.5));\n}\n\n.bb-search:focus {\n  border-color: var(--dsw-alias-state-accent-primary, #4c8dff);\n  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-accent-primary, #4c8dff) 18%, transparent);\n}\n\n.bb-pager {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 10px;\n  padding: 6px 0 2px;\n}\n\n/* ---------- \u7A7A\u72B6\u6001 ---------- */\n\n.bb-empty {\n  margin: 0;\n  padding: 22px 14px;\n  border: 1px dashed var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));\n  border-radius: 10px;\n  font-size: 12px;\n  line-height: 1.5;\n  text-align: center;\n  color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary));\n  background: color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent);\n}\n\n.bb-empty-sm {\n  padding: 14px 10px;\n}\n\n.bb-hint {\n  margin-top: 6px;\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 12px;\n}\n\n/* ---------- \u623F\u95F4\u6D88\u606F\u533A\u5757\uFF08\u5C55\u5F00\u540E\uFF0C\u5B9E\u7EBF\u5361\u7247\u5C42\u6B21\uFF0C\u544A\u522B\u865A\u7EBF\u6846\uFF09 ---------- */\n\n.bb-room-msgs {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  margin-top: 6px;\n  padding: 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-base);\n}\n\n/* \u623F\u95F4\u6D88\u606F\u5185\u7684\u5361\u7247\u7565\u964D\u7EA7\uFF0C\u907F\u514D\u4E0E\u5916\u5C42\u623F\u95F4\u5361\u53CC\u91CD\u9634\u5F71\u8FC7\u91CD */\n.bb-room-msgs .bb-card {\n  padding: 10px 12px;\n  border-radius: 10px;\n  box-shadow: none;\n}\n\n.bb-room-msgs .bb-card:hover {\n  box-shadow: 0 1px 3px color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent);\n}\n\n/* ---------- \u901A\u77E5 / \u9519\u8BEF ---------- */\n\n.bb-notice {\n  font-size: 12px;\n  line-height: 1.5;\n  padding: 8px 12px;\n  border-radius: 8px;\n}\n\n.bb-notice-ok {\n  color: var(--dsw-alias-state-success-primary);\n  background: var(--dsw-alias-state-success-tertiary);\n  border: 1px solid var(--dsw-alias-state-success-primary);\n}\n\n.bb-notice-error {\n  color: var(--dsw-static-red-900, #c53030);\n  background: color-mix(in srgb, var(--dsw-static-red-900, #c53030) 10%, transparent);\n  border: 1px solid var(--dsw-alias-state-error-secondary);\n}\n\n.bb-error {\n  font-size: 12px;\n  line-height: 1.5;\n  color: var(--dsw-static-red-900, #c53030);\n  padding: 8px 12px;\n  border-radius: 8px;\n  background: color-mix(in srgb, var(--dsw-static-red-900, #c53030) 8%, transparent);\n  border: 1px solid var(--dsw-alias-state-error-secondary, color-mix(in srgb, var(--dsw-static-red-900, #c53030) 35%, transparent));\n}\n\n/* \u8BBE\u7F6E\u5B50 Tab\uFF08\u5DE5\u4F5C\u533A\u534F\u8C03 ws-coord \u5B50\u529F\u80FD\u5F00\u5173\uFF09\uFF1A\u9762\u677F\u6807\u9898 + \u8BF4\u660E + \u5F00\u5173\u884C\n   \uFF08\u5F00\u5173\u884C\u590D\u7528\u5168\u5C40 me-field/me-switch \u7C7B\uFF0C\u4E0E\u300CMemory Evolve \u8BBE\u7F6E\u300D\u89C6\u89C9\u4E00\u81F4\uFF1B\n    me-field-sub \u7F29\u8FDB\u8868\u793A\u5B50\u5F00\u5173\u4F9D\u8D56\u603B\u5F00\u5173\uFF09 */\n.bb-settings {\n  padding: 4px 2px;\n}\n\n.bb-settings-title {\n  font-size: 14px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n  margin-bottom: 4px;\n}\n\n.bb-settings-desc {\n  font-size: 12px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-dimmed);\n  margin: 0 0 10px;\n  padding-bottom: 10px;\n  border-bottom: 1px solid var(--dsw-alias-border-l2);\n}\n\n/* ---- \u56FE\u7247\u9644\u4EF6\uFF08P3 2026-08-11\uFF09\uFF1A\u7F29\u7565\u56FE\u6A2A\u6392 + \u70B9\u51FB\u5C55\u5F00\u539F\u56FE ---- */\n.bb-attachments {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 8px;\n  margin-top: 8px;\n}\n\n.bb-att-item {\n  display: flex;\n  flex-direction: column;\n  align-items: flex-start;\n  gap: 4px;\n}\n\n/* 64px \u7F29\u7565\u56FE\u6309\u94AE\uFF08\u65E0\u8FB9\u6846\u65E0\u80CC\u666F\uFF0Chover \u63D0\u4EAE\uFF09 */\n.bb-att-thumb {\n  padding: 0;\n  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.3));\n  border-radius: 6px;\n  background: none;\n  cursor: pointer;\n  overflow: hidden;\n  line-height: 0;\n}\n\n.bb-att-thumb:hover {\n  border-color: var(--dsw-alias-label-primary, #888);\n}\n\n.bb-att-thumb-img {\n  width: 64px;\n  height: 64px;\n  object-fit: cover;\n  display: block;\n}\n\n/* \u539F\u56FE\u9884\u89C8\uFF1A\u5361\u7247\u5185\u5C55\u5F00\uFF0C\u70B9\u51FB\u4EFB\u610F\u5904\u6536\u8D77 */\n.bb-att-preview {\n  margin-top: 6px;\n  cursor: zoom-out;\n  max-width: 100%;\n}\n\n.bb-att-preview-img {\n  max-width: 100%;\n  max-height: 420px;\n  border-radius: 6px;\n  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.3));\n  display: block;\n}\n\n.bb-att-preview-name {\n  display: block;\n  margin-top: 4px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-dimmed, #999);\n}\n";

// src/client/skills-browser/styles.css
var styles_default2 = "/**\n * Skill Browser \u5168\u90E8\u6837\u5F0F\uFF08\u666E\u901A CSS\uFF0C\u7C7B\u540D sb- \u524D\u7F00\uFF09\u3002\n * \u989C\u8272\u4E00\u5F8B\u8D70 DSH \u8BBE\u8BA1 token\uFF08--dsw-alias-*\uFF09\uFF0C\u9759\u6001\u8272\u677F\u7528 --dsw-static-* \u5E76\u5E26\n * alias \u515C\u5E95\uFF1B\u6DF1/\u6D45\u8272\u7531 body[data-ds-dark-theme] \u5207\u6362 token \u81EA\u52A8\u9002\u914D\u3002\n */\n\n/* ---------- \u5E03\u5C40\u9AA8\u67B6 ---------- */\n\n.sb-root {\n  flex: 1;\n  min-height: 0;\n  /* The settings `.options` container is a plain block scroll box (not a\n     flex parent), so flex:1 alone collapses the root to content height.\n     height:100% fills the determined parent height in both contexts. */\n  height: 100%;\n  display: flex;\n  flex-direction: column;\n  font-family: var(--dsw-font-family);\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-bg-base);\n  overflow: hidden;\n}\n\n.sb-body {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  overflow: hidden;\n}\n\n.sb-spacer {\n  flex: 1;\n  min-width: 8px;\n}\n\n/* ---------- \u5DE6\u680F\uFF1A\u5DE5\u5177\u6761 + \u4E0A\u4E0B\u5206\u533A ---------- */\n\n.sb-side {\n  flex: 1 1 0;\n  min-width: 0;\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n}\n\n.sb-side-toolbar {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 8px 12px;\n  border-bottom: 1px solid var(--dsw-alias-border-l);\n}\n\n.sb-search {\n  position: relative;\n  flex: 1;\n  min-width: 0;\n  display: flex;\n  align-items: center;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.sb-search-icon {\n  position: absolute;\n  left: 8px;\n  pointer-events: none;\n}\n\n.sb-search-input {\n  width: 100%;\n  height: 30px;\n  padding: 0 28px 0 28px;\n  font: inherit;\n  font-size: 12px;\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 6px;\n  outline: none;\n}\n\n.sb-search-input::placeholder {\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.sb-search-input:focus-visible {\n  border-color: var(--dsw-alias-brand-primary);\n  outline: 1px solid var(--dsw-alias-brand-primary);\n}\n\n.sb-search-clear {\n  position: absolute;\n  right: 4px;\n  display: flex;\n  align-items: center;\n  padding: 2px;\n  border: none;\n  border-radius: 4px;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  cursor: pointer;\n}\n\n.sb-search-clear:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-secondary);\n}\n\n.sb-icon-btn {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 30px;\n  height: 30px;\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n}\n\n.sb-icon-btn:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.sb-icon-btn:active:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.sb-icon-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n/* ---------- \u4E24\u680F\u5E03\u5C40\uFF1A\u5DE6\u680F 45/55 \u5206\u533A\uFF0C\u53F3\u680F\u7F16\u8F91\u5668 ---------- */\n\n.sb-section {\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  overflow: hidden;\n}\n\n/* \u4E0A\u90E8\uFF1A\u6280\u80FD\u5217\u8868\uFF0855%\uFF0C\u4E3B\u89C6\u56FE\uFF09\uFF0C\u4E0E\u4E0B\u90E8\u4EE5\u5206\u9694\u7EBF\u9694\u5F00 */\n.sb-section--skills {\n  flex: 55;\n  border-bottom: 1px solid var(--dsw-alias-border-l);\n}\n\n/* \u4E0B\u90E8\uFF1A\u9009\u4E2D\u6280\u80FD\u7684\u76EE\u5F55\u6811\uFF0845%\uFF09 */\n.sb-section--files {\n  flex: 45;\n}\n\n.sb-main {\n  flex: none;\n  width: 42%;\n  min-width: 320px;\n  max-width: 640px;\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  overflow: hidden;\n  border-left: 1px solid var(--dsw-alias-border-l);\n}\n\n/* \u7A84\u7A97\u53E3\uFF08\u5F39\u7A97 max-width: calc(100vw - 48px)\uFF09\uFF1A\u7F16\u8F91\u5668\u6536\u7A84\uFF0C\u5DE6\u680F\u8BA9\u4F4D */\n@media (max-width: 900px) {\n  .sb-main {\n    width: 50%;\n    min-width: 260px;\n  }\n}\n\n.sb-pane-head {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 8px 12px;\n  border-bottom: 1px solid var(--dsw-alias-border-l);\n}\n\n.sb-pane-title {\n  font-size: 12px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.sb-count {\n  font-size: 11px;\n  line-height: 16px;\n  padding: 0 6px;\n  border-radius: 8px;\n  color: var(--dsw-alias-label-tertiary);\n  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-overlay));\n}\n\n/* ---------- \u901A\u7528\u63D0\u793A / \u6309\u94AE / \u52A8\u753B ---------- */\n\n.sb-note {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  padding: 16px 12px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.sb-note--error {\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.sb-btn {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  height: 26px;\n  padding: 0 10px;\n  font: inherit;\n  font-size: 12px;\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  cursor: pointer;\n  white-space: nowrap;\n}\n\n.sb-btn:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.sb-btn:active:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.sb-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n.sb-btn--primary {\n  border-color: transparent;\n  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));\n  color: var(--dsw-alias-label-inverted, #fff);\n}\n\n.sb-btn--primary:hover:not(:disabled) {\n  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary));\n}\n\n.sb-btn--primary:disabled {\n  background: var(--dsw-alias-button-primary-dimmed, var(--dsw-alias-brand-primary));\n}\n\n.sb-btn--ghost {\n  border-color: transparent;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.sb-btn--ghost:active:not(:disabled) {\n  background: var(--dsw-alias-button-ghost-active-fill, var(--dsw-alias-interactive-bg-active));\n}\n\n.sb-btn--danger {\n  border-color: transparent;\n  background: var(--dsw-alias-state-error-primary);\n  color: var(--dsw-alias-label-inverted, #fff);\n}\n\n.sb-btn--danger:hover:not(:disabled) {\n  opacity: 0.88;\n}\n\n.sb-btn:focus-visible,\n.sb-icon-btn:focus-visible,\n.sb-card:focus-visible,\n.sb-tree-row:focus-visible,\n.sb-crumb:focus-visible,\n.sb-root-select:focus-visible,\n.sb-search-clear:focus-visible {\n  outline: 2px solid var(--dsw-alias-brand-primary);\n  outline-offset: -2px;\n}\n\n@keyframes sb-rotate {\n  from {\n    transform: rotate(0deg);\n  }\n  to {\n    transform: rotate(360deg);\n  }\n}\n\n.sb-spin {\n  animation: sb-rotate 0.9s linear infinite;\n}\n\n/* ---------- \u680F1 \u6280\u80FD\u5361\u7247 ---------- */\n\n.sb-list {\n  flex: 1;\n  min-height: 0;\n  overflow-y: auto;\n  padding: 8px;\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n}\n\n.sb-card {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  width: 100%;\n  padding: 8px 10px;\n  border: 1px solid transparent;\n  border-radius: 8px;\n  background: transparent;\n  font: inherit;\n  text-align: left;\n  cursor: pointer;\n  color: inherit;\n}\n\n.sb-card:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.sb-card--active,\n.sb-card--active:hover {\n  background: var(--dsw-alias-interactive-bg-hover-accent, var(--dsw-alias-interactive-bg-active));\n  border-color: var(--dsw-alias-brand-primary);\n}\n\n.sb-card-top {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n}\n\n.sb-card-name {\n  flex: 1;\n  min-width: 0;\n  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);\n  font-size: 12px;\n  font-weight: 600;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.sb-badge {\n  flex: none;\n  font-size: 10px;\n  line-height: 16px;\n  padding: 0 6px;\n  border-radius: 8px;\n  white-space: nowrap;\n}\n\n.sb-badge--user {\n  color: var(--dsw-static-deepseek-5, var(--dsw-alias-brand-primary));\n  background: color-mix(\n    in srgb,\n    var(--dsw-static-deepseek-5, var(--dsw-alias-brand-primary)) 14%,\n    transparent\n  );\n}\n\n.sb-badge--project {\n  color: var(--dsw-static-green-5, var(--dsw-alias-state-success-primary));\n  background: color-mix(\n    in srgb,\n    var(--dsw-static-green-5, var(--dsw-alias-state-success-primary)) 14%,\n    transparent\n  );\n}\n\n.sb-badge--bundled {\n  color: var(--dsw-static-neutral-5, var(--dsw-alias-label-tertiary));\n  background: color-mix(\n    in srgb,\n    var(--dsw-static-neutral-5, var(--dsw-alias-label-dimmed)) 16%,\n    transparent\n  );\n}\n\n.sb-badge--other {\n  color: var(--dsw-static-amber-5, var(--dsw-alias-state-warn-label));\n  background: color-mix(\n    in srgb,\n    var(--dsw-static-amber-5, var(--dsw-alias-state-warn-label)) 16%,\n    transparent\n  );\n}\n\n.sb-card-desc {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-secondary);\n  display: -webkit-box;\n  -webkit-line-clamp: 2;\n  -webkit-box-orient: vertical;\n  overflow: hidden;\n}\n\n.sb-card-meta {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  min-width: 0;\n  font-size: 11px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.sb-card-meta-icon {\n  flex: none;\n}\n\n.sb-card-when {\n  min-width: 0;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.sb-card-when-label {\n  margin-right: 4px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n/* ---------- \u680F2 \u76EE\u5F55\u6811 ---------- */\n\n.sb-root-bar {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 8px 12px 0;\n}\n\n.sb-root-label {\n  flex: none;\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.sb-root-select {\n  flex: 1;\n  min-width: 0;\n  height: 26px;\n  padding: 0 6px;\n  font: inherit;\n  font-size: 12px;\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 6px;\n  outline: none;\n  cursor: pointer;\n}\n\n.sb-crumbs {\n  flex: none;\n  display: flex;\n  align-items: center;\n  flex-wrap: wrap;\n  row-gap: 2px;\n  padding: 6px 12px;\n  border-bottom: 1px solid var(--dsw-alias-border-l);\n}\n\n.sb-crumb-seg {\n  display: inline-flex;\n  align-items: center;\n  min-width: 0;\n}\n\n.sb-crumb-sep {\n  margin: 0 2px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.sb-crumb {\n  padding: 1px 4px;\n  border: none;\n  border-radius: 4px;\n  background: transparent;\n  font: inherit;\n  font-size: 11px;\n  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  max-width: 160px;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.sb-crumb:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.sb-tree {\n  flex: 1;\n  min-height: 0;\n  overflow: auto;\n  padding: 4px 0 8px;\n}\n\n.sb-tree-row {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  width: 100%;\n  height: 24px;\n  padding-right: 8px;\n  border: none;\n  background: transparent;\n  font: inherit;\n  font-size: 12px;\n  color: var(--dsw-alias-label-primary);\n  cursor: pointer;\n  text-align: left;\n}\n\n.sb-tree-row:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.sb-tree-row--active,\n.sb-tree-row--active:hover {\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.sb-tree-row svg {\n  flex: none;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.sb-tree-name {\n  flex: 1;\n  min-width: 0;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.sb-tree-row--file .sb-tree-name {\n  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);\n}\n\n.sb-tree-size {\n  flex: none;\n  font-size: 11px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.sb-tree-note {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  padding-top: 4px;\n  padding-bottom: 4px;\n  padding-right: 8px;\n  font-size: 11px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.sb-tree-errmsg {\n  min-width: 0;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.sb-tree-retry {\n  flex: none;\n  padding: 0 4px;\n  border: none;\n  border-radius: 4px;\n  background: transparent;\n  font: inherit;\n  font-size: 11px;\n  color: var(--dsw-alias-brand-primary);\n  cursor: pointer;\n}\n\n.sb-tree-retry:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n/* ---------- \u680F3 \u67E5\u770B / \u7F16\u8F91\u5668 ---------- */\n\n.sb-editor-topbar {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  height: 40px;\n  padding: 0 12px;\n  border-bottom: 1px solid var(--dsw-alias-border-l);\n}\n\n.sb-editor-filename {\n  flex: none;\n  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);\n  font-size: 12px;\n  font-weight: 600;\n}\n\n.sb-editor-path {\n  min-width: 0;\n  font-size: 11px;\n  color: var(--dsw-alias-label-dimmed);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.sb-dirty-dot {\n  flex: none;\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  background: var(--dsw-alias-state-warn-label);\n}\n\n.sb-editor-empty {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 8px;\n  padding: 24px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary);\n  text-align: center;\n}\n\n/* \u53EA\u8BFB\u9884\u89C8\uFF1A\u884C\u53F7 + pre \u540C\u5728\u4E00\u4E2A\u6EDA\u52A8\u5BB9\u5668\uFF0C\u884C\u53F7\u6A2A\u5411\u5438\u4F4F */\n.sb-editor-scroll {\n  flex: 1;\n  min-height: 0;\n  overflow: auto;\n  display: flex;\n  align-items: flex-start;\n}\n\n.sb-gutter {\n  flex: none;\n  position: sticky;\n  left: 0;\n  padding: 8px 8px 8px 12px;\n  border-right: 1px solid var(--dsw-alias-border-l);\n  background: var(--dsw-alias-bg-base);\n  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);\n  font-size: 12px;\n  line-height: 20px;\n  text-align: right;\n  color: var(--dsw-alias-label-dimmed);\n  user-select: none;\n}\n\n.sb-pre {\n  flex: 1;\n  min-width: max-content;\n  margin: 0;\n  padding: 8px 12px;\n  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);\n  font-size: 12px;\n  line-height: 20px;\n  white-space: pre;\n  color: var(--dsw-alias-label-primary);\n}\n\n/* \u7F16\u8F91\u6A21\u5F0F\uFF1A\u72EC\u7ACB\u884C\u53F7\u5217\u4E0E textarea \u540C\u6B65\u6EDA\u52A8 */\n.sb-editor-edit {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  overflow: hidden;\n}\n\n.sb-gutter--edit {\n  position: static;\n  overflow: hidden;\n  border-right: 1px solid var(--dsw-alias-border-l);\n}\n\n.sb-textarea {\n  flex: 1;\n  min-width: 0;\n  padding: 8px 12px;\n  border: none;\n  outline: none;\n  resize: none;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);\n  font-size: 12px;\n  line-height: 20px;\n  white-space: pre;\n  overflow: auto;\n}\n\n/* \u72B6\u6001\u6761 */\n.sb-statusbar {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  height: 26px;\n  padding: 0 12px;\n  border-top: 1px solid var(--dsw-alias-border-l);\n  font-size: 11px;\n  color: var(--dsw-alias-label-tertiary);\n  overflow: hidden;\n  white-space: nowrap;\n}\n\n.sb-status-item {\n  flex: none;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.sb-status--dirty {\n  color: var(--dsw-alias-state-warn-label);\n}\n\n.sb-status--saved {\n  color: var(--dsw-alias-state-success-primary);\n}\n\n.sb-status--error {\n  color: var(--dsw-alias-state-error-primary);\n}\n\n/* \u9762\u677F\u7EA7\u72B6\u6001\u6761\uFF1A\u56FA\u5B9A\u5728\u9762\u677F\u5E95\u90E8\uFF0C\u7F16\u8F91\u5668\u9690\u85CF\u65F6\u4E5F\u53EF\u89C1 */\n.sb-statusbar--panel {\n  height: 28px;\n  border-top: 1px solid var(--dsw-alias-border-l);\n}\n\n/* \u7B5B\u9009 chips \u540C\u884C\u7684\u5206\u9694\u7AD6\u7EBF */\n.sb-chips-sep {\n  flex: none;\n  align-self: stretch;\n  width: 1px;\n  margin: 0 4px;\n  background: var(--dsw-alias-border-l);\n}\n\n/* ---------- \u653E\u5F03\u4FEE\u6539\u786E\u8BA4\u5F39\u7A97 ---------- */\n\n.sb-modal-overlay {\n  position: fixed;\n  inset: 0;\n  z-index: 100;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: rgba(0, 0, 0, 0.4);\n}\n\n.sb-modal {\n  width: 360px;\n  max-width: calc(100vw - 48px);\n  padding: 16px;\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-base));\n}\n\n.sb-modal-title {\n  font-size: 13px;\n  font-weight: 600;\n  line-height: 20px;\n}\n\n.sb-modal-body {\n  margin-top: 8px;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.sb-modal-actions {\n  margin-top: 16px;\n  display: flex;\n  justify-content: flex-end;\n  gap: 8px;\n}\n\n/* ---------- \u6EDA\u52A8\u6761\uFF08\u8DDF\u968F DSH token\uFF0C\u7F3A token \u65F6\u7528\u8FB9\u6846\u8272\u515C\u5E95\uFF09 ---------- */\n\n.sb-list::-webkit-scrollbar,\n.sb-tree::-webkit-scrollbar,\n.sb-editor-scroll::-webkit-scrollbar,\n.sb-textarea::-webkit-scrollbar {\n  width: 8px;\n  height: 8px;\n}\n\n.sb-list::-webkit-scrollbar-thumb,\n.sb-tree::-webkit-scrollbar-thumb,\n.sb-editor-scroll::-webkit-scrollbar-thumb,\n.sb-textarea::-webkit-scrollbar-thumb {\n  border-radius: 4px;\n  background: var(--dsw-alias-scrollbar-bg-l, var(--dsw-alias-border-l));\n}\n\n.sb-list::-webkit-scrollbar-thumb:hover,\n.sb-tree::-webkit-scrollbar-thumb:hover,\n.sb-editor-scroll::-webkit-scrollbar-thumb:hover,\n.sb-textarea::-webkit-scrollbar-thumb:hover {\n  background: var(--dsw-alias-scrollbar-hover-l, var(--dsw-alias-label-dimmed));\n}\n\n.sb-list::-webkit-scrollbar-track,\n.sb-tree::-webkit-scrollbar-track,\n.sb-editor-scroll::-webkit-scrollbar-track,\n.sb-textarea::-webkit-scrollbar-track {\n  background: transparent;\n}\n\n/* \u2500\u2500 settings panel enhancement (fullscreen / drag-resize) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n\n/* Fullscreen toggle button: pinned to the panel's top-right, left of the\n   framework's close button (36px wide), above the content stack. */\n.sb-panel-maximize {\n  position: absolute;\n  top: 10px;\n  right: 46px;\n  z-index: 20;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n  padding: 0;\n  border: none;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  transition: background-color 120ms ease, color 120ms ease;\n}\n\n.sb-panel-maximize:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.sb-panel-maximize:focus-visible {\n  outline: 2px solid var(--dsw-alias-brand-primary);\n  outline-offset: 1px;\n}\n\n/* Drag-resize handle: bottom-right corner grip. */\n.sb-panel-resize-handle {\n  position: absolute;\n  right: 0;\n  bottom: 0;\n  z-index: 20;\n  display: flex;\n  align-items: flex-end;\n  justify-content: flex-end;\n  width: 26px;\n  height: 26px;\n  padding: 0 5px 5px 0;\n  box-sizing: border-box;\n  cursor: nwse-resize;\n  border-radius: 0 0 24px 0;\n  color: var(--dsw-alias-label-secondary);\n  transition: color 120ms ease, background-color 120ms ease;\n}\n\n.sb-panel-resize-handle:hover,\n.sb-panel-resize-handle--active {\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n/* ---------- \u6280\u80FD\u6765\u6E90\u7B5B\u9009 chips ---------- */\n\n.sb-chips {\n  flex: none;\n  display: flex;\n  flex-wrap: wrap;\n  gap: 4px;\n  padding: 0 8px 6px;\n}\n\n.sb-chip {\n  height: 22px;\n  padding: 0 10px;\n  font: inherit;\n  font-size: 11px;\n  line-height: 22px;\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 11px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  white-space: nowrap;\n}\n\n.sb-chip:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.sb-chip--active {\n  border-color: var(--dsw-alias-brand-primary);\n  color: var(--dsw-alias-brand-primary);\n  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);\n}\n\n/* ---------- \u7981\u7528 / \u542F\u7528 ---------- */\n\n.sb-card--disabled .sb-card-name,\n.sb-card--disabled .sb-card-desc,\n.sb-card--disabled .sb-card-when {\n  opacity: 0.55;\n}\n\n.sb-badge--disabled {\n  color: var(--dsw-static-neutral-5, var(--dsw-alias-label-tertiary));\n  background: color-mix(\n    in srgb,\n    var(--dsw-static-neutral-5, var(--dsw-alias-label-tertiary)) 16%,\n    transparent\n  );\n}\n\n.sb-badge--protected {\n  color: var(--dsw-static-blue-5, var(--dsw-alias-label-secondary));\n  background: color-mix(\n    in srgb,\n    var(--dsw-static-blue-5, var(--dsw-alias-label-secondary)) 14%,\n    transparent\n  );\n}\n\n.sb-toggle {\n  flex: none;\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  height: 20px;\n  padding: 0 8px;\n  font: inherit;\n  font-size: 11px;\n  line-height: 20px;\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 10px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  white-space: nowrap;\n}\n\n.sb-toggle:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.sb-toggle--disabled {\n  border-color: var(--dsw-alias-state-warn-border, var(--dsw-alias-border-l));\n  color: var(--dsw-static-amber-5, var(--dsw-alias-state-warn-label));\n}\n\n/* \u5207\u6362\u64CD\u4F5C\u5931\u8D25\u63D0\u793A\u6761\uFF08\u5DE5\u5177\u6761\u4E0B\u65B9\uFF09 */\n\n.sb-action-error {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  margin: 0 8px 6px;\n  padding: 4px 8px;\n  font-size: 11px;\n  color: var(--dsw-static-red-5, var(--dsw-alias-state-danger-label));\n  background: color-mix(\n    in srgb,\n    var(--dsw-static-red-5, var(--dsw-alias-state-danger-label)) 10%,\n    transparent\n  );\n  border: 1px solid var(--dsw-alias-state-danger-border, var(--dsw-alias-border-l));\n  border-radius: 6px;\n}\n\n.sb-action-error-text {\n  flex: 1;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n/* ---------- \u5206\u9875\u6761 ---------- */\n\n.sb-pager {\n  flex: none;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 8px;\n  padding: 6px 8px;\n  border-top: 1px solid var(--dsw-alias-border-l);\n}\n\n.sb-pager-info {\n  font-size: 11px;\n  color: var(--dsw-alias-label-tertiary);\n  white-space: nowrap;\n}\n\n/* ---------- \u81EA\u5B9A\u4E49\u76EE\u5F55\u7BA1\u7406\u5F39\u7A97 ---------- */\n\n.sb-modal--dirs {\n  width: 560px;\n  max-width: calc(100vw - 48px);\n}\n\n.sb-dirs-help {\n  margin: 0 0 10px;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.sb-dirs-addrow {\n  display: flex;\n  gap: 8px;\n  margin-bottom: 10px;\n}\n\n.sb-dirs-input {\n  flex: 1;\n  min-width: 0;\n  height: 28px;\n  padding: 0 10px;\n  font: inherit;\n  font-size: 12px;\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 6px;\n  background: var(--dsw-alias-input-bg, transparent);\n  color: var(--dsw-alias-label-primary);\n}\n\n.sb-dirs-input:focus-visible {\n  outline: 2px solid var(--dsw-alias-brand-primary);\n  outline-offset: 1px;\n}\n\n.sb-dirs-list {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  max-height: 280px;\n  overflow-y: auto;\n}\n\n.sb-dirs-row {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 6px 8px;\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 6px;\n}\n\n.sb-dirs-path {\n  flex: 1;\n  min-width: 0;\n  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);\n  font-size: 12px;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--dsw-alias-label-primary);\n}\n\n.sb-dirs-path--missing {\n  color: var(--dsw-static-red-5, var(--dsw-alias-state-danger-label));\n  text-decoration: line-through;\n}\n\n/* ---------- dsh-memory-evolve integration ---------- */\n\n/* Inside the session memory tab, cap the height like the other feature\n   panels (62vh) so the skill manager never grows the page; the three panes\n   scroll internally. */\n.mt-panel .sb-root {\n  height: auto;\n  max-height: 62vh;\n  flex: none;\n}\n";

// src/client/ui-settings-styles.css
var ui_settings_styles_default = '/**\n * dsh-memory-evolve \u2014 DSH UI \u8BBE\u7F6E\u6A21\u5757\u6837\u5F0F\uFF08ui- \u524D\u7F00\uFF0C\u72EC\u7ACB\u6CE8\u5165\uFF09\u3002\n *\n * \u5168\u90E8\u4F7F\u7528 DSH \u8BBE\u8BA1 token\uFF08--dsw-alias-*\uFF09\uFF0C\u6DF1\u6D45\u8272\u4E3B\u9898\u81EA\u52A8\u9002\u914D\uFF1B\u540E\u7EED\n * \u4E3B\u9898\u529F\u80FD\uFF08CSS \u53D8\u91CF\u8986\u76D6\uFF09\u53EF\u76F4\u63A5\u63A5\u7BA1\u672C\u6587\u4EF6\u3002\n */\n\n/* \u2500\u2500 \u4F1A\u8BDD\u7B5B\u9009\uFF1A\u4EC5\u663E\u793A\u8FDB\u884C\u4E2D\u7684\u4F1A\u8BDD \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n *\n * \u8FC7\u6EE4\u89C4\u5219\u4F5C\u7528\u57DF\u6302\u5728 <html data-dsh-ui-filter="on">\uFF08session-filter.ts\n * \u63A7\u5236\uFF0ClocalStorage \u8BB0\u5FC6\u504F\u597D\uFF0C\u9ED8\u8BA4\u5F00\u542F\uFF09\u3002\n *\n * \u9009\u62E9\u5668\u4F9D\u636E\uFF08\u8C03\u7814\u6587\u6863 docs-local/DSH-UI\u8BBE\u7F6E\u6A21\u5757-\u8C03\u7814-20260809.md\uFF09\uFF1A\n * - \u4F1A\u8BDD\u884C = div[role="treeitem"][aria-selected]\uFF08\u5DE5\u4F5C\u533A\u5206\u7EC4\u884C\u6709\n *   aria-expanded \u65E0 aria-selected\uFF1B\u641C\u7D22\u7ED3\u679C\u884C\u662F <button>\u2014\u2014div \u5929\u7136\u6392\u9664\uFF0C\n *   \u641C\u7D22\u6A21\u5F0F\u4E0B\u7B5B\u9009\u4E0D\u751F\u6548\uFF09\uFF1B\n * - \u7EAF idle \u4F1A\u8BDD\u884C\u6CA1\u6709\u4EFB\u4F55 data-state \u72B6\u6001\u70B9\uFF1B\u6D3B\u8DC3\uFF08ongoing/warning/error\uFF09\n *   \u4E0E completed\uFF08done\uFF09\u90FD\u6709\u72B6\u6001\u70B9 \u2192 \u53EA\u9690\u85CF\u5B8C\u5168\u65E0\u72B6\u6001\u70B9\u7684\u884C\uFF1B\n * - :has() \u9700 Chrome 105+\uFF082022-08 \u8D77\uFF0C\u73B0\u4EE3\u6D4F\u89C8\u5668\u65E0\u95EE\u9898\uFF09\u3002\n *\n * React \u91CD\u6E32\u67D3\u540E\u9009\u62E9\u5668\u5B9E\u65F6\u751F\u6548\uFF1A\u4F1A\u8BDD\u4ECE idle \u53D8 running \u65F6\u72B6\u6001\u70B9\u51FA\u73B0\u3001\n * \u884C\u81EA\u52A8\u6062\u590D\u663E\u793A\uFF0C\u65E0\u9700 JS \u8F6E\u8BE2\u4F1A\u8BDD\u72B6\u6001\u3002\n */\nhtml[data-dsh-ui-filter="on"] [role="tree"] div[role="treeitem"][aria-selected]:not(:has([data-state])) {\n  display: none;\n}\n\n/* \u2500\u2500 \u5BF9\u8BDD\u533A\u52A0\u5BBD\uFF08wide-chat.ts \u63A7\u5236 html[data-dsh-ui-wide-chat]\uFF09\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n *\n * DSH \u5BF9\u8BDD\u533A\u5BBD\u5EA6\u7531 CSS \u53D8\u91CF --dsh-chat-content-width \u63A7\u5236\n * \uFF08ConversationRoot.module.css\uFF1A748px\uFF1B\u8F93\u5165\u6846 = +32px \u6D3E\u751F\uFF0C\u5168\u90E8\u81EA\u52A8\n * \u8DDF\u968F\uFF09\u3002\u5728\u5BF9\u8BDD\u533A\u6839\u5143\u7D20\uFF08[data-phase] \u662F ConversationRoot \u6839 div \u7684\u7A33\u5B9A\n * \u951A\u70B9\uFF09\u4E0A\u8986\u76D6\u4E3A 95%\uFF08\u76F8\u5BF9\u53F3\u4FA7\u533A\u57DF\u5BBD\uFF0C\u4E0E\u4E0A\u65B9 Tabs \u5BFC\u822A\u6761\u5BBD\u5EA6\u5BF9\u9F50\uFF09\uFF1B\n * \u672C\u9009\u62E9\u5668 specificity\uFF08html+attr+attr = 0,2,1\uFF09\u9AD8\u4E8E\u539F .root\uFF080,1,0\uFF09\uFF0C\n * \u7A33\u80DC\u539F\u58F0\u660E\u3002 */\nhtml[data-dsh-ui-wide-chat="on"] [data-phase] {\n  --dsh-chat-content-width: 95%;\n}\n\n/* \u2500\u2500 \u6D88\u606F\u6C14\u6CE1\u52A0\u5BBD\uFF08wide-chat.ts \u63A7\u5236 html[data-dsh-ui-wide-bubble]\uFF09\u2500\u2500\u2500\u2500\u2500\n *\n * \u75DB\u70B9\uFF08\u7528\u6237\u53CD\u9988 2026-08-09\uFF09\uFF1A\u7528\u6237\u63D0\u4EA4\u540E\u7684\u6D88\u606F\u6846\u9ED8\u8BA4 max-width:\n * min(525px, 82%)\uFF08MessageItem.module.css .bubble\uFF09\u2014\u2014\u5BF9\u8BDD\u533A\u52A0\u5BBD\u540E\n * \u6C14\u6CE1\u4ECD\u88AB 525px \u4E0A\u9650\u5361\u4F4F\u3001\u76F8\u5BF9\u66F4\u663E\u5C0F\u3002\u5F00\u542F\u540E\u8BA9\u6C14\u6CE1\u5360\u4E2D\u95F4\u5185\u5BB9\u6846\u7EA6 80%\u3002\n *\n * \u951A\u70B9\uFF08\u6E90\u7801\u4F9D\u636E\uFF09\uFF1A\u7528\u6237\u6D88\u606F\u884C userRow \u6709\u6052\u5B9A `data-time-hover-root`\n * \u5C5E\u6027\uFF08MessageItem.tsx\uFF09\uFF1Bbubble \u6052\u4E3A\u5176**\u7B2C\u4E00\u4E2A div \u5B50\u5143\u7D20**\uFF08steering\n * \u6807\u8BB0\u662F span\u3001MessageIconActions \u662F\u7B2C\u4E8C\u4E2A div\uFF09\u2192 `div:first-of-type`\n * \u552F\u4E00\u547D\u4E2D bubble\uFF0C\u4E0D\u8BEF\u4F24 actions\u3002\u539F\u89C4\u5219 .bubble\uFF080,1,0\uFF09\uFF0C\u672C\u9009\u62E9\u5668\n * specificity \u66F4\u9AD8\uFF0C\u7A33\u80DC\u3002 */\nhtml[data-dsh-ui-wide-bubble="on"] [data-time-hover-root] > div:first-of-type {\n  max-width: 80%;\n}\n\n/* \u2500\u2500 \u4F1A\u8BDD\u5217\u8868\u9876\u90E8\u7B5B\u9009\u6761\uFF08session-filter.ts \u6CE8\u5165\u7684 DOM\uFF09\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.dsh-ui-filter-bar {\n  display: flex;\n  gap: 6px;\n  padding: 6px 10px;\n  border-bottom: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.25));\n  /* \u8DDF\u968F\u5217\u8868\u533A\u80CC\u666F\uFF08token \u515C\u5E95\uFF09\uFF0C\u4E0D\u8BBE\u56FA\u5B9A\u5E95\u8272\u4EE5\u514D\u6DF1\u6D45\u4E3B\u9898\u7A81\u5140 */\n  background: transparent;\n}\n\n/* \u5206\u6BB5\u6309\u94AE\uFF1A\u975E\u6FC0\u6D3B\u6001\u5F31\u5316\u3001\u6FC0\u6D3B\u6001\u54C1\u724C\u5F3A\u8C03\uFF08\u5BF9\u9F50 DSH tool-bar \u6309\u94AE\u98CE\u683C\uFF09\u3002 */\n.dsh-ui-filter-btn {\n  flex: 1;\n  min-height: 24px;\n  padding: 2px 8px;\n  border: 1px solid transparent;\n  border-radius: 6px;\n  background: var(--dsw-alias-button-tool-bar-fill, transparent);\n  color: var(--dsw-alias-label-secondary, inherit);\n  font-size: 12px;\n  line-height: 18px;\n  cursor: pointer;\n  transition: background 0.12s ease, color 0.12s ease;\n}\n\n.dsh-ui-filter-btn:hover {\n  background: var(--dsw-alias-button-tool-bar-hover, rgba(128, 128, 128, 0.14));\n  color: var(--dsw-alias-label-primary, inherit);\n}\n\n.dsh-ui-filter-btn-active,\n.dsh-ui-filter-btn-active:hover {\n  background: var(--dsw-alias-button-tool-bar-fill-invisible, rgba(128, 128, 128, 0.18));\n  border-color: var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  color: var(--dsw-alias-brand-primary, inherit);\n  font-weight: 600;\n}\n\n/* \u2500\u2500 \u6298\u53E0\u5DE5\u4F5C\u533A\u884C\u7684\u8FD0\u884C\u5FBD\u6807\uFF08session-filter.ts \u6CE8\u5165\u7684 DOM\uFF09\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n * \u6298\u53E0\u7684\u5206\u7EC4\u884C\u4E0A\u770B\u4E0D\u5230\u4F1A\u8BDD\u8FD0\u884C\u72B6\u6001\uFF0C\u5FBD\u6807\u300C\u25CF N \u8FD0\u884C\u4E2D\u300D\u8865\u4E0A\u8FD9\u4E2A\u4FE1\u606F\uFF1B\n * \u884C\u662F flex \u5E03\u5C40\uFF0C\u5FBD\u6807\u8FFD\u52A0\u5728\u884C\u5C3E\u81EA\u7136\u9760\u53F3\u3002\u72B6\u6001\u8272\u7528\u4E1A\u52A1\u4E3B\u8272 token\n * \uFF08--dsw-alias-state-business-primary\uFF0C\u6DF1\u6D45\u4E3B\u9898\u81EA\u52A8\u9002\u914D\uFF09\u3002 */\n.dsh-ui-ws-run-badge {\n  align-self: center;\n  margin-left: 6px;\n  padding: 1px 7px;\n  border-radius: 999px;\n  background: var(--dsw-alias-state-business-secondary, rgba(64, 128, 255, 0.16));\n  color: var(--dsw-alias-state-business-primary, #3b82f6);\n  font-size: 11px;\n  line-height: 16px;\n  white-space: nowrap;\n  flex: none;\n}';

// src/client/mermaid-render.css
var mermaid_render_default = "/**\n * dsh-memory-evolve \u2014 Mermaid \u56FE\u8868\u6E32\u67D3\u6837\u5F0F\u3002\n *\n * .me-mermaid-wrap \u662F\u66FF\u6362 .md-code-block \u6B63\u6587\uFF08pre\uFF09\u540E\u5305 SVG \u7684\u6EDA\u52A8\u5BB9\u5668\uFF1A\n * - max-width:100% + overflow-x:auto\uFF1A\u5927\u56FE\uFF08\u51E0\u5341\u8282\u70B9\uFF09\u5728\u7A84\u5C4F\uFF08\u624B\u673A\uFF09\u4E0E\n *   \u7A84\u6D88\u606F\u680F\u4E0A\u6A2A\u5411\u6EDA\u52A8\uFF0C\u800C\u4E0D\u662F\u88AB\u538B\u7F29\u53D8\u5F62\uFF1B\n * - svg max-width:none\uFF1A\u7981\u6B62 svg \u88AB\u5BB9\u5668\u538B\u7F29\uFF08svg \u6709\u56FA\u5B9A viewBox \u5C3A\u5BF8\uFF09\uFF1B\n * - margin:0 auto\uFF1A\u5C0F\u56FE\u5C45\u4E2D\uFF1B\n * - \u80CC\u666F\u900F\u660E\uFF08\u5F15\u64CE\u521D\u59CB\u5316\u5DF2\u8BBE themeVariables.background=transparent\uFF09\uFF0C\n *   \u6DF1\u6D45\u4E3B\u9898\u4E0B\u90FD\u878D\u5165\u6D88\u606F\u6C14\u6CE1\uFF0C\u4E0D\u7559\u767D/\u9ED1\u65B9\u5757\u3002\n */\n\n.me-mermaid-wrap {\n  max-width: 100%;\n  overflow-x: auto;\n  padding: 10px 4px;\n}\n\n.me-mermaid-wrap svg {\n  display: block;\n  margin: 0 auto;\n  max-width: none;\n  height: auto;\n}\n\n/* \u6E32\u67D3\u6C38\u4E45\u5931\u8D25\uFF08\u8BED\u6CD5\u9519\u8BEF\u7B49\uFF09\u65F6\u7684\u63D0\u793A\u884C\uFF1A\u63D2\u5728 banner \u4E0E\u4EE3\u7801\u4E4B\u95F4\uFF0C\u7425\u73C0\u8272\n   \u5C0F\u5B57 + \u534A\u900F\u660E\u5E95\uFF0C\u6DF1\u6D45\u4E3B\u9898\u4E0B\u90FD\u53EF\u89C1\uFF1B\u4EE3\u7801\u539F\u6837\u4FDD\u7559\u3001\u53EF\u590D\u5236\u4FEE\u6B63\u3002 */\n.me-mermaid-error {\n  padding: 6px 12px;\n  font-size: 12px;\n  line-height: 1.5;\n  color: #b45309;\n  background: rgba(180, 83, 9, 0.08);\n  border-bottom: 1px solid rgba(180, 83, 9, 0.25);\n}\n\n/* \u300C\u4E0B\u8F7D\u300D\u6309\u94AE\uFF1A\u63D2\u5728 DSH \u590D\u5236\u6309\u94AE\u65C1\uFF08.action \u5BB9\u5668\uFF09\uFF0C\u89C2\u611F\u4E0E\u590D\u5236\u6309\u94AE\n   \u8FD1\u4F3C\uFF08\u5C0F\u5B57\u3001\u900F\u660E\u5E95\u3001hover \u52A0\u6DF1\uFF09\uFF1B\u989C\u8272/\u5B57\u4F53\u7EE7\u627F\u5F53\u524D\u4E3B\u9898\u3002 */\n.me-mermaid-download {\n  border: none;\n  background: transparent;\n  color: inherit;\n  font: inherit;\n  font-size: 12px;\n  line-height: 1.5;\n  padding: 2px 8px;\n  border-radius: 6px;\n  cursor: pointer;\n  opacity: 0.75;\n  transition: opacity 0.15s, background 0.15s;\n}\n\n.me-mermaid-download:hover {\n  opacity: 1;\n  background: rgba(128, 128, 128, 0.25);\n}\n\n/* \u515C\u5E95\u4F4D\u7F6E\uFF1A\u82E5\u5757\u7ED3\u6784\u53D8\u5316\u5BFC\u81F4\u627E\u4E0D\u5230\u64CD\u4F5C\u533A\uFF0C\u6309\u94AE\u843D\u5728 wrap \u53F3\u4E0A\u89D2\n   \uFF08ensureDownloadButton \u7684 fallback\uFF09\uFF0C\u534A\u900F\u660E\u5C0F\u6309\u94AE\u60AC\u4E8E\u56FE\u4E0A\u65B9\u3002 */\n.me-mermaid-wrap {\n  position: relative;\n}\n\n.me-mermaid-wrap > .me-mermaid-download {\n  position: absolute;\n  top: 4px;\n  right: 4px;\n  z-index: 1;\n}\n";

// src/client/bookmark-styles.css
var bookmark_styles_default = "/**\n * \u4F1A\u8BDD\u4E66\u7B7E\u6837\u5F0F\uFF08bm- \u524D\u7F00\uFF0C\u72EC\u7ACB\u6CE8\u5165\uFF09\u3002\n *\n * \u8BBE\u8BA1\u539F\u5219\uFF1A\n * - \u5C0F\u56FE\u6807\u661F\u6807\uFF1A\u4E0D\u62A2 Copy/Branch \u64CD\u4F5C\u533A\u7684\u89C6\u89C9\u7126\u70B9\uFF1B\n * - \u5217\u8868 Tab \u94FA\u6EE1 conversation.view \u7684 flex \u7236\u5BB9\u5668\uFF1B\n * - \u989C\u8272\u5168\u90E8\u8D70 DSH \u8BBE\u8BA1 token\uFF08\u6DF1\u6D45\u8272\u81EA\u52A8\u9002\u914D\uFF09\uFF0C\u4E0D\u5199\u6B7B\u989C\u8272\u3002\n */\n\n/* ---- \u8F6E\u5C3E\u661F\u6807\u6309\u94AE\uFF08DOM \u6CE8\u5165\uFF0CB \u65B9\u6848\uFF1A\u4E0D\u5360 turnTail \u69FD\uFF0C\u5B98\u65B9 produced-files \u884C\u4FDD\u7559\uFF09---- */\n.bm-star-btn {\n  appearance: none;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 2px;\n  border: none;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary, #8b8d98);\n  /* \u56FE\u6807\u5C3A\u5BF8\uFF08\u7528\u6237\u62CD\u677F\uFF1A17px \u57FA\u7840\u4E0A\u518D\u653E\u5927 1.3 \u500D \u2248 22px\uFF09 */\n  font-size: 22px;\n  line-height: 1;\n  padding: 1px 5px;\n  margin: 0;\n  border-radius: 4px;\n  cursor: pointer;\n  opacity: 0.72;\n  transition: opacity 0.12s ease, color 0.12s ease, background 0.12s ease;\n}\n\n.bm-star-btn:hover {\n  opacity: 1;\n  color: var(--dsw-alias-label-primary, inherit);\n  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));\n}\n\n/* \u5DF2\u6253\u4E66\u7B7E\uFF1A\u5B9E\u5FC3\u661F\uFF0C\u4E3B\u9898\u5F3A\u8C03\u8272 */\n.bm-star-btn[data-bookmarked='true'] {\n  opacity: 1;\n  color: var(--dsw-static-yellow-9, #f5a623);\n}\n\n.bm-star-btn[data-bookmarked='true']:hover {\n  color: var(--dsw-static-yellow-10, #d48806);\n}\n\n.bm-star-btn:disabled {\n  cursor: wait;\n  opacity: 0.5;\n}\n\n.bm-star-icon {\n  /* \u4E0E\u6309\u94AE\u540C\u5C3A\u5BF8\uFF0822px\uFF09\uFF0C\u7EAF\u5B57\u7B26\u661F\u6807 */\n  font-size: 22px;\n  line-height: 1;\n}\n\n/* \u5185\u8054\u8FF7\u4F60\u83DC\u5355\uFF08\u6539\u540D / \u5220\u9664\uFF09\uFF0C\u6302\u5728\u661F\u6807\u65C1 */\n.bm-star-wrap {\n  display: inline-flex;\n  align-items: center;\n  gap: 2px;\n  position: relative;\n  /* \u8D34\u88C5\u8FDB\u5B98\u65B9\u64CD\u4F5C\u533A\u884C\u5185\uFF1A\u4E0E Copy/Branch \u6309\u94AE\u9694\u5F00\u4E00\u70B9 */\n  margin-left: 4px;\n  flex: none;\n}\n\n.bm-star-menu {\n  position: absolute;\n  top: 100%;\n  left: 0;\n  z-index: 20;\n  min-width: 140px;\n  margin-top: 2px;\n  padding: 4px;\n  border-radius: 8px;\n  border: 1px solid var(--dsw-alias-border-subtle, rgba(128, 128, 128, 0.28));\n  background: var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-primary, #fff));\n  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.bm-star-menu button {\n  appearance: none;\n  border: none;\n  background: transparent;\n  text-align: left;\n  padding: 6px 10px;\n  border-radius: 4px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-primary, inherit);\n  cursor: pointer;\n}\n\n.bm-star-menu button:hover {\n  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));\n}\n\n.bm-star-menu button.bm-danger {\n  color: var(--dsw-static-red-9, #e5484d);\n}\n\n/* ---- \u4E66\u7B7E\u5217\u8868 Tab\uFF08conversation.view\uFF09---- */\n.bm-panel {\n  display: flex;\n  flex-direction: column;\n  flex: 1;\n  min-height: 0;\n  height: 100%;\n  padding: 12px 16px;\n  gap: 10px;\n  overflow: hidden;\n  box-sizing: border-box;\n  font-family: var(--dsw-font-family, system-ui, sans-serif);\n  color: var(--dsw-alias-label-primary, inherit);\n}\n\n.bm-toolbar {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex-shrink: 0;\n}\n\n.bm-toolbar h3 {\n  margin: 0;\n  font-size: 14px;\n  font-weight: 600;\n  flex: 1;\n}\n\n.bm-toolbar-btn {\n  appearance: none;\n  border: 1px solid var(--dsw-alias-border-subtle, rgba(128, 128, 128, 0.28));\n  background: transparent;\n  color: var(--dsw-alias-label-secondary, inherit);\n  border-radius: 6px;\n  padding: 4px 10px;\n  font-size: 12px;\n  cursor: pointer;\n}\n\n.bm-toolbar-btn:hover {\n  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));\n  color: var(--dsw-alias-label-primary, inherit);\n}\n\n.bm-help {\n  margin: 0;\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary, #6b6f76);\n  line-height: 1.5;\n  flex-shrink: 0;\n}\n\n/* \u641C\u7D22\u6846\uFF1Alabel/\u6458\u8981\u5B50\u4E32\u8FC7\u6EE4\uFF08\u4E66\u7B7E\u591A\u4E86\u4E0D\u7FFB\u5217\u8868\uFF09 */\n.bm-search {\n  flex: none;\n  box-sizing: border-box;\n  width: 100%;\n  height: 28px;\n  padding: 0 10px;\n  border: 1px solid var(--dsw-alias-border-subtle, rgba(128, 128, 128, 0.28));\n  border-radius: 8px;\n  outline: none;\n  background: var(--dsw-alias-bg-base, var(--dsw-alias-bg-primary, #fff));\n  color: var(--dsw-alias-label-primary, inherit);\n  font: inherit;\n  font-size: 12px;\n  transition: border-color 120ms ease;\n}\n\n.bm-search:hover {\n  border-color: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));\n}\n\n.bm-search:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary, #2563eb);\n  outline-offset: 1px;\n}\n\n.bm-search::placeholder {\n  color: var(--dsw-alias-label-tertiary, #8b8d98);\n}\n\n.bm-list {\n  flex: 1;\n  min-height: 0;\n  overflow-y: auto;\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n}\n\n.bm-empty {\n  padding: 24px 8px;\n  text-align: center;\n  font-size: 13px;\n  color: var(--dsw-alias-label-tertiary, #8b8d98);\n}\n\n.bm-item {\n  appearance: none;\n  border: 1px solid var(--dsw-alias-border-subtle, rgba(128, 128, 128, 0.22));\n  background: var(--dsw-alias-bg-secondary, transparent);\n  border-radius: 8px;\n  padding: 10px 12px;\n  text-align: left;\n  cursor: pointer;\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  transition: border-color 0.12s ease, background 0.12s ease;\n  color: inherit;\n  font: inherit;\n  width: 100%;\n  box-sizing: border-box;\n}\n\n.bm-item:hover {\n  border-color: var(--dsw-alias-interactive-bg-active, rgba(128, 128, 128, 0.45));\n  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.08));\n}\n\n.bm-item-head {\n  display: flex;\n  align-items: baseline;\n  gap: 8px;\n  min-width: 0;\n}\n\n.bm-item-label {\n  font-size: 13px;\n  font-weight: 600;\n  flex: 1;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.bm-item-meta {\n  font-size: 11px;\n  color: var(--dsw-alias-label-tertiary, #8b8d98);\n  flex-shrink: 0;\n}\n\n.bm-item-summary {\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary, #6b6f76);\n  line-height: 1.4;\n  overflow: hidden;\n  display: -webkit-box;\n  -webkit-line-clamp: 2;\n  -webkit-box-orient: vertical;\n}\n\n.bm-item-actions {\n  display: flex;\n  gap: 6px;\n  margin-top: 4px;\n}\n\n.bm-item-actions button {\n  appearance: none;\n  border: none;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary, #8b8d98);\n  font-size: 11px;\n  padding: 2px 4px;\n  border-radius: 4px;\n  cursor: pointer;\n}\n\n.bm-item-actions button:hover {\n  color: var(--dsw-alias-label-primary, inherit);\n  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));\n}\n\n.bm-item-actions button.bm-danger:hover {\n  color: var(--dsw-static-red-9, #e5484d);\n}\n\n.bm-notice {\n  font-size: 12px;\n  padding: 6px 10px;\n  border-radius: 6px;\n  flex-shrink: 0;\n}\n\n.bm-notice-ok {\n  background: color-mix(in srgb, var(--dsw-static-green-9, #30a46c) 14%, transparent);\n  color: var(--dsw-static-green-11, #18794e);\n}\n\n.bm-notice-error {\n  background: color-mix(in srgb, var(--dsw-static-red-9, #e5484d) 14%, transparent);\n  color: var(--dsw-static-red-11, #c62a2f);\n}\n\n.bm-notice-info {\n  background: color-mix(in srgb, var(--dsw-static-blue-9, #3b82f6) 14%, transparent);\n  color: var(--dsw-static-blue-11, #1d4ed8);\n}\n";

// src/client/mobile.css
var mobile_default = '/**\n * dsh-memory-evolve \u2014 \u79FB\u52A8\u7AEF\u9002\u914D\uFF08dsh-android-edapp \u9002\u914D\u534F\u8BAE\u8DEF\u5F84 B\uFF09\u3002\n *\n * ## \u6765\u6E90\u4E0E\u80CC\u666F\n * \u672C\u6587\u4EF6\u4ECE dsh-android-edapp \u7684 src/client/mobile-tabs.css\uFF08\u4E00\u671F 9+1 Tab \u624B\u673A\n * \u9002\u914D\uFF0C\u5168\u90E8\u89C4\u5219\u539F\u4F4D\u4E8E @media (max-width: 767px) \u5757\u5185\uFF09\u6574\u4F53\u8FC1\u79FB\u800C\u6765\n * \uFF082026-08-09 \u7528\u6237\u62CD\u677F\uFF1A\u9002\u914D\u8DDF\u7740\u63D2\u4EF6\u8D70\u2014\u2014memory-evolve \u5347\u7EA7\u6539\u81EA\u5DF1\u5373\u53EF\uFF0C\n * dsh-android-edapp \u53EA\u7559\u5916\u58F3 + \u901A\u7528\u515C\u5E95 + \u9002\u914D\u7BA1\u7406\u5668\uFF09\u3002\n *\n * ## \u534F\u8BAE\u8BF4\u660E\uFF08ADAPTER PROTOCOL v1\uFF0C\u89C1 dsh-android-edapp/docs/ADAPTER-PROTOCOL.md\uFF09\n * \u672C\u6587\u4EF6\u901A\u8FC7 ./client \u5BFC\u51FA\u9762\u7684\u7EA6\u5B9A\u5B57\u6BB5 `dshMobile = { css }`\uFF08src/client/\n * index.ts\uFF09\u4EA4\u7ED9 dsh-android-edapp \u81EA\u52A8\u53D1\u73B0\u5E76\u6CE8\u5165\u3002\u6CE8\u5165\u65F6 css \u4F1A\u88AB\u539F\u6837\u5305\u88F9\u8FDB\n * `@media (max-width: 767px)`\uFF0C\u56E0\u6B64\u5FC5\u987B\u9075\u5B88\uFF1A\n * - \u3010\u4E0D\u5199 @media\u3011\u2014\u2014\u5D4C\u5957\u5408\u6CD5\u4F46\u6CA1\u5FC5\u8981\uFF0C\u7EDF\u4E00\u7531 dsh-android-edapp \u5305\u88F9\uFF1B\n * - \u9009\u62E9\u5668\u4E00\u5F8B\u4FDD\u7559 `html[data-dsh-mobile]` \u524D\u7F00\uFF08\u8BE5\u5C5E\u6027\u7531 dsh-android-edapp\n *   \u5728 \u2264767px \u65F6\u81EA\u52A8\u6302\u4E0A\uFF0C\u5A92\u4F53\u67E5\u8BE2 + \u5C5E\u6027\u5F00\u5173\u53CC\u4FDD\u9669\uFF0C\u684C\u9762\u96F6\u5F71\u54CD\uFF09\uFF1B\n * - \u53EA\u8986\u76D6\u5E03\u5C40/\u5C3A\u5BF8\uFF08\u5BBD\u5EA6\u3001flex \u65B9\u5411\u3001\u95F4\u8DDD\u3001\u6EA2\u51FA\u3001\u89E6\u533A\u5927\u5C0F\uFF09\uFF0C\u4E0D\u6539\u989C\u8272/\u5B57\u4F53\n *   \uFF08\u8DDF\u968F DSH \u4E3B\u9898\u53D8\u91CF\uFF09\uFF1B\n * - \u4E0E\u901A\u7528\u515C\u5E95\u5C42\uFF08mobile-fallback.css\uFF09\u3010\u65B9\u5411\u76F8\u53CD\u3011\u7684\u89C4\u5219\u5FC5\u987B\u52A0 `!important`\n *   \u8868\u660E\u610F\u56FE\uFF08\u534F\u8BAE\u8BED\u4E49\uFF1A\u4F5C\u8005\u9002\u914D\u4F18\u5148\u4E8E\u515C\u5E95\uFF1B\u515C\u5E95\u7528 !important \u505A\u5E03\u5C40\u94B3\u5236\uFF0C\n *   \u5982\u8868\u683C min-width:0\u3001\u9762\u677F max-height \u94B3\u5236\u3001\u5217\u8868 max-height:none \u653E\u901A\uFF09\u3002\n *   \u672C\u6587\u4EF6\u4E2D\u5E26 !important \u7684\u89C4\u5219\u5747\u4E3A\u5BF9\u6297\u515C\u5E95\u94B3\u5236\uFF0C\u9010\u6761\u6CE8\u660E\u7406\u7531\uFF1B\n *   \u65B9\u5411\u4E00\u81F4\u7684\u89C4\u5219\uFF08\u9762\u677F\u6536\u7A84\u3001\u89E6\u533A\u653E\u5927\u3001\u653E\u901A\u7B49\uFF09\u4E0D\u52A0\u3002\n *\n * ## \u8986\u76D6\u8303\u56F4\uFF08\u6309 Tab \u5206\u7EC4\uFF0C\u89C1\u4E0B\u65B9\u5206\u533A\u6CE8\u91CA\uFF09\n * memory-evolve \u5404 Tab\uFF08\u8BB0\u5FC6/\u6280\u80FD/\u5F85\u529E/COI\u8C03\u5EA6/\u4F1A\u8BDD\u5E7F\u64AD/\u4FBF\u7B7E/\u63D0\u793A\u8BCD/\u4E66\u7B7E/\n * \u8BBE\u7F6E/\u6A21\u578B\uFF09\u6302\u5728 DSH \u7684 `conversation.view` \u69FD\uFF08\u4E2D\u5FC3\u5217\uFF09\uFF0C\u624B\u673A\u4E0A\u4E2D\u5FC3\u5217\n * \u5168\u5BBD\uFF0CTab \u5BB9\u5668\u672C\u8EAB\u6CA1\u95EE\u9898\uFF0C\u95EE\u9898\u5728 Tab **\u5185\u90E8**\u5E03\u5C40\uFF08\u684C\u9762\u5047\u8BBE\uFF09\uFF1A\n * flex \u6A2A\u6392\u591A\u5217\u3001white-space: nowrap\u3001max-width: 45%\u3001\u56FA\u5B9A\u5BBD\u5EA6\u9762\u677F\n * \uFF08360px/560px \u7F16\u8F91\u5668\uFF09\u3001\u957F\u5217\u8868/\u8868\u683C\u7B49\u3002\n * memory-evolve \u5168\u90E8\u4F7F\u7528**\u666E\u901A\u7C7B\u540D**\uFF08me-/mt-/coi-/bb-/sp-/pm-/bm- \u524D\u7F00\uFF0C\n * esbuild \u6784\u5EFA\u540E\u4E0D\u54C8\u5E0C\uFF09\u2192 \u9009\u62E9\u5668\u53EF\u76F4\u63A5\u9009\u4E2D\u8986\u76D6\u3002\n * \u7B2C 10 \u8282\u53E6\u8986\u76D6 DSH **\u6838\u5FC3\u5BF9\u8BDD\u533A**\uFF08ConversationRoot/ChatView\uFF0C\u4E0D\u662F\u672C\n * \u63D2\u4EF6 Tab\uFF09\uFF1A\u5BF9\u8BDD\u533A\u4E0E\u7528\u6237\u6D88\u606F\u6C14\u6CE1\u5728\u624B\u673A\u4E0A\u6EE1\u5BBD\u3001\u4E0E\u5C4F\u5E55\u7B49\u5BBD\u65E0\u4E24\u4FA7\u8FB9\u8DDD\u3002\n *\n * ## \u5B9E\u73B0\u7B56\u7565\uFF08\u6309 Tab \u5206\u7EC4\uFF09\n * 1. \u6A2A\u6392\u6539\u7EB5\u6392\uFF1Acoi-split\uFF08\u5DE6\u5217\u8868+\u53F3\u8BE6\u60C5\uFF09\u3001pm-body\uFF08\u4E09\u680F\uFF09\u3001sb-body\uFF08\u5DE6\u680F+\u7F16\u8F91\u5668\uFF09\n * 2. nowrap \u6539\u6362\u884C\uFF1A\u5404\u7C7B head/actions/toolbar \u884C\u8865 flex-wrap\n * 3. 45%/60% \u9650\u5BBD\u5FBD\u6807\u6539\u5168\u5BBD\uFF1Ame-badge / mt-entry-branch / mt-entry-tag\n * 4. \u56FA\u5B9A\u5BBD\u5EA6\u9762\u677F\u6539\u81EA\u9002\u5E94\uFF1Apm-pane-*\u3001sb-main\u3001pm-overlay\u3001sb-modal\n * 5. \u5185\u90E8\u6EDA\u52A8\u5217\u8868\u653E\u5F00\uFF1Ame-list / mt-entries / bb-content \u7B49 max-height \u89E3\u9664\uFF0C\n *    \u5185\u5BB9\u968F\u9875\u9762\u6574\u4F53\u6EDA\u52A8\uFF08\u624B\u673A\u4E0A\u907F\u514D\u5D4C\u5957\u6EDA\u52A8\uFF0C\u4F53\u9A8C\u66F4\u987A\u6ED1\uFF09\n * 6. \u957F\u8868\u683C\u6A2A\u5411\u6EDA\u52A8\uFF1Amt-models-table \u7ED9 min-width \u5F3A\u5236\u6EDA\u52A8\u5BB9\u5668\u751F\u6548\n */\n\n/* ================================================================\n * 0. \u901A\u7528\uFF08\u8DE8 Tab \u5171\u4EAB\u7684\u5E03\u5C40\u8865\u4E01\uFF09\n * ================================================================ */\n\n/* me-panel\uFF1ATodoView / MemoryQueueView / TabGuideView / UiSettingsView \u7684\n   \u516C\u5171\u6839\u5BB9\u5668\u3002\u624B\u673A\u4E0A\u6536\u7A84\u5DE6\u53F3\u7559\u767D\u3001\u6536\u7D27\u7EB5\u5411\u95F4\u8DDD\uFF0C\u628A\u5B9D\u8D35\u5BBD\u5EA6\u8BA9\u7ED9\u5185\u5BB9\u3002\n   \uFF08\u5DE6\u53F3\u7559\u767D\u4F1A\u88AB\u515C\u5E95\u5C42\u6A21\u5F0F 7 \u4FDD\u5E95\u5230 \u226516px\uFF0C\u65B9\u5411\u4E00\u81F4\uFF0C\u65E0\u9700 !important\u3002\uFF09 */\nhtml[data-dsh-mobile] .me-panel {\n  padding: 4px 6px 20px;\n  gap: 14px;\n}\n\n/* mt-panel\uFF1A\u8BB0\u5FC6/\u6280\u80FD/\u8BBE\u7F6E/\u6A21\u578B\u7B49 Tab \u7684\u516C\u5171\u6839\u5BB9\u5668\uFF0C\u540C\u6837\u6536\u7A84\u7559\u767D\u3002 */\nhtml[data-dsh-mobile] .mt-panel {\n  padding: 6px 8px 12px;\n  gap: 8px;\n}\n\n/* \u4F1A\u8BDD\u8BB0\u5FC6 Tab \u5185\u5D4C\u9762\u677F\uFF08.mt-panel .me-panel \u684C\u9762 62vh \u9650\u9AD8\uFF09\uFF1A\u624B\u673A\u4E0A\n   \u89E3\u9664\u9650\u9AD8\uFF0C\u907F\u514D\u300C\u9762\u677F\u5185\u6EDA\u52A8 + \u5916\u5C42\u6EDA\u52A8\u300D\u4E24\u5C42\u5D4C\u5957\u6EDA\u52A8\uFF08\u5D4C\u5957\u6EDA\u52A8\u5728\n   \u624B\u673A\u4E0A\u6EDA\u52A8\u624B\u611F\u5DEE\u3001\u8FD8\u5BB9\u6613\u8BEF\u89E6\uFF09\u3002\n   !important\uFF1A\u5BF9\u6297\u515C\u5E95\u5C42\u6A21\u5F0F 1 \u2014\u2014 \u515C\u5E95\u5BF9 [class*="panel"] \u7C7B\u5143\u7D20\u94B3\u5236\n   max-height: calc(100dvh - 24px)\uFF08\u9632\u5F39\u5C42\u8D85\u9AD8\uFF09\uFF0C\u6B64\u5904\u8981\u5B8C\u5168\u653E\u901A\uFF08none\uFF09\uFF0C\n   \u65B9\u5411\u76F8\u53CD\uFF0C\u5FC5\u987B !important \u8868\u660E"\u4F5C\u8005\u9002\u914D\u4F18\u5148"\u3002 */\nhtml[data-dsh-mobile] .mt-panel .me-panel {\n  max-height: none !important;\n}\n\n/* \u5185\u90E8\u6EDA\u52A8\u5217\u8868\u653E\u5F00\uFF1Ame-list\uFF08\u5EFA\u8BAE\u961F\u5217\uFF09/ mt-entries\uFF08\u7F8E\u89C2\u89C6\u56FE\u6761\u76EE\uFF09/\n   me-archive-list\uFF08\u5F52\u6863\u5217\u8868\uFF09\u684C\u9762\u4E0A\u9650\u9AD8\u5185\u6EDA\uFF0C\u624B\u673A\u4E0A\u89E3\u9664\u9650\u9AD8\u8BA9\u5185\u5BB9\n   \u81EA\u7136\u5C55\u5F00\uFF0C\u7EDF\u4E00\u7531\u5916\u5C42 mt-panel/me-panel \u6574\u4F53\u6EDA\u52A8\u3002\n   \uFF08\u515C\u5E95\u5C42\u6A21\u5F0F 6 \u5BF9 [class*="list"/"entries"/"items"] \u540C\u6837\u653E\u901A\n   max-height: none\uFF0C\u65B9\u5411\u4E00\u81F4\uFF0C\u65E0\u9700 !important\u3002\uFF09 */\nhtml[data-dsh-mobile] .me-list,\nhtml[data-dsh-mobile] .mt-entries,\nhtml[data-dsh-mobile] .me-archive-list {\n  max-height: none;\n}\n\n/* \u9650\u5BBD\u5FBD\u6807\u6539\u5168\u5BBD\uFF1Ame-badge\uFF08\u5EFA\u8BAE\u76EE\u6807\u5FBD\u6807 max-width:45%\uFF09\u3001\n   mt-entry-branch\uFF08\u5206\u652F\u5FBD\u6807 45%\uFF09\u3001mt-entry-tag\uFF08\u6761\u76EE\u6807\u7B7E 60%\uFF09\u3002\n   \u7A84\u5C4F\u4E0B 45%/60% \u4F1A\u628A\u5FBD\u6807\u6587\u5B57\u622A\u65AD\u6210\u7701\u7565\u53F7\uFF0C\u653E\u5F00\u9650\u5BBD\u8BA9\u5FBD\u6807\u5B8C\u6574\u663E\u793A\uFF0C\n   \u5FC5\u8981\u65F6\u81EA\u7136\u6362\u884C\u3002 */\nhtml[data-dsh-mobile] .me-badge,\nhtml[data-dsh-mobile] .mt-entry-branch,\nhtml[data-dsh-mobile] .mt-entry-tag {\n  max-width: 100%;\n}\n\n/* \u5361\u7247\u5934\u884C\u8865\u6362\u884C\uFF1Ame-item-head\uFF08\u5EFA\u8BAE\u6761\u76EE\u5934\uFF09/ mt-card-head\uFF08\u8BB0\u5FC6\u5361\u7247\u5934\uFF09/\n   mt-entry-head\uFF08\u7F8E\u89C2\u89C6\u56FE\u6761\u76EE\u5934\uFF09\u684C\u9762\u662F\u5355\u884C\u6A2A\u6392\uFF08\u6807\u9898+\u5FBD\u6807+\u65F6\u95F4+\u64CD\u4F5C\uFF09\uFF0C\n   \u624B\u673A\u4E0A\u7A7A\u95F4\u4E0D\u591F\u65F6\u5141\u8BB8\u6298\u884C\uFF0C\u907F\u514D\u64CD\u4F5C\u6309\u94AE\u88AB\u6324\u51FA\u5C4F\u5E55\u3002 */\nhtml[data-dsh-mobile] .me-item-head,\nhtml[data-dsh-mobile] .mt-card-head,\nhtml[data-dsh-mobile] .mt-entry-head {\n  flex-wrap: wrap;\n}\n\n/* \u64CD\u4F5C\u6309\u94AE\u7EC4\u8865\u6362\u884C\uFF1Ame-item-actions\uFF08\u6761\u76EE\u64CD\u4F5C\uFF09/ me-bulk\uFF08\u6279\u91CF\u64CD\u4F5C\uFF09/\n   me-actions\uFF08\u8868\u5355\u5E95\u90E8\u64CD\u4F5C\uFF09\uFF0C\u624B\u673A\u4E0A\u6309\u94AE\u591A\u65F6\u6298\u884C\u800C\u4E0D\u662F\u6EA2\u51FA\u3002\n   \uFF08\u515C\u5E95\u5C42\u6A21\u5F0F 2 \u5BF9 [class*="actions"] \u5DF2\u5F3A\u5236 flex-wrap\uFF0C\u65B9\u5411\u4E00\u81F4\u3002\uFF09 */\nhtml[data-dsh-mobile] .me-item-actions,\nhtml[data-dsh-mobile] .me-bulk,\nhtml[data-dsh-mobile] .me-actions {\n  flex-wrap: wrap;\n}\n\n/* \u914D\u7F6E\u8868\u5355\u884C\uFF08me-field\uFF1Alabel + \u63A7\u4EF6\u6A2A\u6392\uFF09\uFF1A\u624B\u673A\u4E0A\u5141\u8BB8\u6298\u884C\uFF1B\n   \u6570\u5B57/\u4E0B\u62C9\u63A7\u4EF6\uFF08me-input/me-select\uFF0C\u684C\u9762\u56FA\u5B9A 120px\uFF09\u6539\u5360\u6EE1\u6574\u884C\uFF0C\n   \u53D8\u6210\u300Clabel \u4E00\u884C + \u63A7\u4EF6\u4E00\u884C\u300D\u7684\u7EB5\u5411\u6392\u5E03\uFF0C\u7A84\u5C4F\u4E0B\u53EF\u8BFB\u6027\u548C\u89E6\u533A\u90FD\u66F4\u597D\u3002\n   \uFF08me-switch \u5F00\u5173\u884C\u4E0D\u53D7\u5F71\u54CD\uFF0C\u5F00\u5173\u4E0D\u9700\u8981\u5168\u5BBD\u3002\uFF09 */\nhtml[data-dsh-mobile] .me-field {\n  flex-wrap: wrap;\n}\nhtml[data-dsh-mobile] .me-field > .me-input,\nhtml[data-dsh-mobile] .me-field > .me-select {\n  width: 100%;\n}\n\n/* \u4E3B\u6309\u94AE\u89E6\u533A\u5FAE\u589E\uFF1Ame-btn \u684C\u9762 26px \u9AD8\uFF0C\u624B\u673A\u4E0A\u62AC\u5230 30px \u4FBF\u4E8E\u62C7\u6307\u70B9\u6309\n   \uFF08\u53EA\u6539\u9AD8\u5EA6\uFF0C\u4E0D\u52A8\u914D\u8272\u4E0E\u5185\u8FB9\u8DDD\u8BED\u4E49\uFF09\u3002 */\nhtml[data-dsh-mobile] .me-btn {\n  height: 30px;\n}\nhtml[data-dsh-mobile] .mt-btn {\n  padding: 4px 12px;\n}\n\n/* \u5B50 Tab \u9875\u7B7E\u6536\u7A84\u5185\u8FB9\u8DDD\uFF1Amt-file-tab \u684C\u9762 padding 0 12px\uFF0C\u624B\u673A\u4E0A\n   0 10px\uFF0C\u8BA9\u4E00\u884C\u80FD\u591A\u653E\u51E0\u4E2A\u9875\u7B7E\uFF08\u8BB0\u5FC6 Tab \u6587\u4EF6\u9875\u7B7E\u8F83\u591A\uFF09\u3002 */\nhtml[data-dsh-mobile] .mt-file-tab {\n  padding: 0 10px;\n}\n\n/* \u533A\u5757\u5361\u7247\u5185\u8FB9\u8DDD\u5FAE\u6536\uFF1Ame-block \u684C\u9762 14px\uFF0C\u624B\u673A\u4E0A 10px 12px\u3002 */\nhtml[data-dsh-mobile] .me-block {\n  padding: 10px 12px;\n}\n\n/* ================================================================\n * 1. \u8BB0\u5FC6 Tab\uFF08mt-/me- \u7C7B\uFF0CMemoryTabView + MemoryQueueView\uFF09\n * ================================================================ */\n\n/* KEY \u624B\u5DE5\u6DFB\u52A0\u6846\u5E95\u90E8\u884C\uFF08\u8BF4\u660E\u6587\u5B57 + \u6DFB\u52A0\u6309\u94AE\uFF09\uFF1A\u624B\u673A\u4E0A\u5141\u8BB8\u6298\u884C\uFF0C\n   \u907F\u514D\u8BF4\u660E\u6587\u5B57\u88AB\u6309\u94AE\u6324\u538B\u3002 */\nhtml[data-dsh-mobile] .mt-key-add-foot {\n  flex-wrap: wrap;\n}\n\n/* \u5185\u5D4C\u8BF4\u660E\u6587\u5B57\u884C\uFF1A\u4FDD\u6301\u6362\u884C\u80FD\u529B\uFF0C\u4E0D\u989D\u5916\u5904\u7406\uFF08mt-toolbar \u5DF2\u81EA\u5E26\n   flex-wrap\uFF0C\u641C\u7D22\u6846 min-width 160px \u624B\u673A\u4E0A\u81EA\u52A8\u5360\u884C\uFF09\u3002 */\n\n/* ================================================================\n * 2. \u5F85\u529E Tab\uFF08me-todo-*\uFF0CTodoView\uFF09\n * ================================================================ */\n\n/* \u65B0\u589E\u5F85\u529E\u884C\uFF08\u8F93\u5165\u6846 + \u5206\u7C7B\u4E0B\u62C9 + \u6DFB\u52A0\u6309\u94AE\uFF09\uFF1A\u624B\u673A\u4E0A\u8F93\u5165\u6846\u5360\u6EE1\u6574\u884C\uFF0C\n   \u4E0B\u62C9\u4E0E\u6309\u94AE\u6298\u5230\u7B2C\u4E8C\u884C\u2014\u2014\u7A84\u5C4F\u4E0B\u684C\u9762\u5F0F\u5355\u884C\u6392\u5E03\u4F1A\u6324\u7206\u3002 */\nhtml[data-dsh-mobile] .me-todo-add {\n  flex-wrap: wrap;\n}\nhtml[data-dsh-mobile] .me-todo-add .me-todo-input {\n  flex-basis: 100%;\n}\n\n/* \u7B5B\u9009\u533A\uFF08\u8F68 checkbox \u7EC4\uFF09\uFF1A\u684C\u9762 gap 16px \u5355\u884C\uFF0C\u624B\u673A\u4E0A\u5141\u8BB8\u6298\u884C\u5E76\n   \u6536\u7D27\u95F4\u8DDD\uFF0C\u7B5B\u9009\u9879\u591A\u65F6\u6362\u884C\u6392\u5217\u3002 */\nhtml[data-dsh-mobile] .me-todo-filters {\n  flex-wrap: wrap;\n  gap: 8px 12px;\n}\n\n/* \u5217\u8868/\u770B\u677F\u89C6\u56FE\u5207\u6362\uFF08\u5206\u6BB5\u63A7\u4EF6\uFF09\uFF1A\u684C\u9762\u4E0A margin-left:auto \u8D34\u53F3\uFF0C\n   \u624B\u673A\u4E0A\u5360\u6EE1\u6574\u884C\u3001\u4E24\u4E2A\u6309\u94AE\u5747\u5206\u5BBD\u5EA6\u2014\u2014\u89E6\u533A\u66F4\u5927\u3001\u66F4\u597D\u70B9\u6309\u3002 */\nhtml[data-dsh-mobile] .me-todo-view-switch {\n  margin-left: 0;\n  flex-basis: 100%;\n}\nhtml[data-dsh-mobile] .me-todo-view-btn {\n  flex: 1;\n}\n\n/* \u56DB\u8C61\u9650\u770B\u677F\uFF1Amemory-evolve \u81EA\u5E26 \u2264720px \u5355\u5217\u65AD\u70B9\uFF0C767px \u5185\u81EA\u7136\u547D\u4E2D\uFF0C\n   \u65E0\u9700\u8986\u76D6\uFF082\xD72 \u5BAB\u683C\u5728\u624B\u673A 375px \u4E0B\u5DF2\u81EA\u52A8\u5806\u53E0\u4E3A\u5355\u5217\uFF09\u3002 */\n\n/* ================================================================\n * 3. \u6280\u80FD Tab\uFF08me-/sb- \u7C7B\uFF0CSkillsTabView + skills-browser\uFF09\n * ================================================================ */\n\n/* \u6280\u80FD\u6D4F\u89C8\u5668\u6839\u5BB9\u5668\uFF1A\u4F1A\u8BDD\u5185\u5D4C\u65F6\u684C\u9762 62vh \u9650\u9AD8\uFF0C\u624B\u673A\u4E0A\u89E3\u9664\uFF08\u540C me-panel\n   \u7684\u7406\u7531\uFF0C\u907F\u514D\u5D4C\u5957\u6EDA\u52A8\uFF09\u3002 */\nhtml[data-dsh-mobile] .mt-panel .sb-root {\n  max-height: none;\n}\n\n/* \u4E3B\u4F53\u4E24\u680F\u6539\u7EB5\u6392\uFF1Asb-body \u684C\u9762\u6A2A\u6392\uFF08\u5DE6\u680F sb-side + \u53F3\u680F sb-main\n   \u7F16\u8F91\u5668\uFF09\uFF0C\u624B\u673A\u4E0A\u4E0A\u4E0B\u5806\u53E0\u2014\u2014\u7F16\u8F91\u5668 42%/min-width:320px \u5728 375px\n   \u5C4F\u4E0A\u653E\u4E0D\u4E0B\u4E24\u680F\u3002\n   \uFF08\u515C\u5E95\u5C42\u6A21\u5F0F 2 \u5BF9 [class*="body"] \u5DF2\u5F3A\u5236 column\uFF0C\u65B9\u5411\u4E00\u81F4\u3002\uFF09 */\nhtml[data-dsh-mobile] .sb-body {\n  flex-direction: column;\n}\n\n/* \u5DE6\u680F\uFF08\u641C\u7D22 + \u6280\u80FD\u5217\u8868 + \u76EE\u5F55\u6811\uFF09\uFF1A\u624B\u673A\u4E0A\u9650\u9AD8 45vh \u5185\u90E8\u6EDA\u52A8\uFF0C\n   \u907F\u514D\u628A\u7F16\u8F91\u5668\u9876\u51FA\u5C4F\u5E55\u3002 */\nhtml[data-dsh-mobile] .sb-side {\n  flex: none;\n  max-height: 45vh;\n}\n\n/* \u53F3\u680F\u7F16\u8F91\u5668\uFF1A\u684C\u9762 width:42% min-width:320px\uFF0C\u624B\u673A\u4E0A\u6539\u5168\u5BBD\u81EA\u9002\u5E94\uFF0C\n   \u5DE6\u4FA7\u7AD6\u7EBF\u6539\u9876\u90E8\u6A2A\u7EBF\uFF08\u89C6\u89C9\u5206\u9694\u8DDF\u968F\u5806\u53E0\u65B9\u5411\uFF09\u3002min-height 40vh\n   \u4FDD\u8BC1\u7F16\u8F91\u5668\u5728\u7EB5\u6392\u540E\u4ECD\u6709\u8DB3\u591F\u7F16\u8F91\u533A\u57DF\u3002 */\nhtml[data-dsh-mobile] .sb-main {\n  width: 100%;\n  min-width: 0;\n  max-width: none;\n  flex: none;\n  min-height: 40vh;\n  border-left: none;\n  border-top: 1px solid var(--dsw-alias-border-l);\n}\n\n/* \u5DE6\u680F\u4E0A\u4E0B\u5206\u533A\uFF08\u6280\u80FD\u5217\u8868 55% / \u76EE\u5F55\u6811 45%\uFF09\uFF1A\u7EB5\u6392\u540E flex \u6BD4\u4F8B\u65E0\u610F\u4E49\uFF0C\n   \u6539\u4E3A\u5404\u81EA\u5185\u5BB9\u81EA\u9002\u5E94 + \u6700\u5C0F\u9AD8\u5EA6\uFF0C\u907F\u514D\u67D0\u4E00\u5206\u533A\u88AB\u538B\u6CA1\u3002 */\nhtml[data-dsh-mobile] .sb-section--skills,\nhtml[data-dsh-mobile] .sb-section--files {\n  flex: none;\n}\nhtml[data-dsh-mobile] .sb-section--skills {\n  min-height: 30vh;\n}\nhtml[data-dsh-mobile] .sb-section--files {\n  min-height: 26vh;\n}\n\n/* \u76EE\u5F55\u6811\u884C\u9AD8\uFF1A\u684C\u9762 24px \u592A\u77EE\uFF0C\u624B\u673A\u4E0A\u62AC\u5230 30px \u4FBF\u4E8E\u70B9\u6309\u3002 */\nhtml[data-dsh-mobile] .sb-tree-row {\n  height: 30px;\n}\n\n/* \u81EA\u5B9A\u4E49\u76EE\u5F55\u6DFB\u52A0\u884C\uFF08\u8F93\u5165\u6846 + \u6DFB\u52A0\u6309\u94AE\uFF09\uFF1A\u624B\u673A\u4E0A\u5141\u8BB8\u6298\u884C\u3002 */\nhtml[data-dsh-mobile] .sb-dirs-addrow {\n  flex-wrap: wrap;\n}\n\n/* \u5F39\u7A97\uFF08\u653E\u5F03\u4FEE\u6539\u786E\u8BA4 360px / \u76EE\u5F55\u7BA1\u7406 560px\uFF09\uFF1A\u624B\u673A\u4E0A\u6539\u8FD1\u5168\u5BBD\uFF0C\n   \u4E24\u4FA7\u7559 16px \u8FB9\u8DDD\uFF08\u539F max-width calc(100vw-48px) \u8986\u76D6\u4E3A 32px\uFF0C\n   \u66F4\u8D34\u8FB9\u3001\u5185\u5BB9\u533A\u66F4\u5927\uFF09\u3002\n   \uFF08\u515C\u5E95\u5C42\u6A21\u5F0F 1 \u4F1A\u94B3\u5236 [class*="modal"] \u7684 max-width \u4E3A\n   calc(100vw - 24px)\u2014\u2014\u6B64\u5904 width \u663E\u5F0F calc(100vw - 32px) \u66F4\u7A84\u3001\n   \u65B9\u5411\u4E00\u81F4\uFF0C\u5B9E\u9645\u5BBD\u5EA6\u7531 width \u4E3B\u5BFC\uFF0C\u65E0\u9700 !important\u3002\uFF09 */\nhtml[data-dsh-mobile] .sb-modal,\nhtml[data-dsh-mobile] .sb-modal--dirs {\n  width: calc(100vw - 32px);\n  max-width: calc(100vw - 32px);\n}\n\n/* ================================================================\n * 4. COI \u8C03\u5EA6 Tab\uFF08coi- \u7C7B\uFF0CCoIView\uFF09\n * ================================================================ */\n\n/* \u5B50 Tab \u6761\uFF1A\u684C\u9762\u5355\u884C\u4E0D\u6362\u884C\uFF0C\u624B\u673A\u4E0A\u5141\u8BB8\u6298\u884C\uFF08\u8C03\u5EA6/\u7EDF\u8BA1/\u53D1\u8D77/\u9002\u914D\u5668\n   \u7B49\u9875\u7B7E\u591A\u65F6\u6362\u884C\u6392\u5217\uFF09\u3002 */\nhtml[data-dsh-mobile] .coi-tabs {\n  flex-wrap: wrap;\n}\n\n/* \u4EFB\u52A1\u89C6\u56FE\u5DE6\u53F3\u5206\u680F\u6539\u7EB5\u6392\uFF1Acoi-split \u684C\u9762\uFF08\u5DE6\u4EFB\u52A1\u5217\u8868 46% + \u53F3\u8BE6\u60C5\uFF09\uFF0C\n   \u624B\u673A\u4E0A\u4E0A\u4E0B\u5806\u53E0\u2014\u2014\u5217\u8868\u9650\u9AD8 40vh \u5185\u90E8\u6EDA\u52A8\uFF0C\u8BE6\u60C5\u533A\u7ED9\u8DB3 30vh\u3002 */\nhtml[data-dsh-mobile] .coi-split {\n  flex-direction: column;\n}\n/* \u4EFB\u52A1\u5217\u8868\u9650\u9AD8 40vh \u5185\u90E8\u6EDA\u52A8\uFF08\u7EB5\u6392\u540E\u5217\u8868\u4E0D\u80FD\u65E0\u9650\u62C9\u957F\uFF0C\u5426\u5219\u8BE6\u60C5\u533A\n   \u88AB\u9876\u51FA\u5C4F\u5E55\uFF09\u3002\n   !important\uFF1A\u5BF9\u6297\u515C\u5E95\u5C42\u6A21\u5F0F 6 \u2014\u2014 \u515C\u5E95\u5BF9 [class*="list"] \u5F3A\u5236\n   max-height: none \u653E\u901A\uFF08\u5047\u8BBE\u6240\u6709\u5217\u8868\u90FD\u8BE5\u968F\u9875\u9762\u6EDA\u52A8\uFF09\uFF0C\u6B64\u5904\u5217\u8868\u8981\n   \u4FDD\u7559 40vh \u9650\u9AD8\u5185\u6EDA\uFF0C\u65B9\u5411\u76F8\u53CD\uFF0C\u5FC5\u987B !important\u3002 */\nhtml[data-dsh-mobile] .coi-task-list {\n  flex: none;\n  width: 100%;\n  max-height: 40vh !important;\n}\nhtml[data-dsh-mobile] .coi-detail {\n  flex: none;\n  min-height: 30vh;\n}\n\n/* \u5DE5\u5177\u680F/\u64CD\u4F5C\u7EC4\u8865\u6362\u884C\uFF1Acoi-toolbar\uFF08\u5DE5\u5177\u6761\uFF09\u3001coi-detail-actions\n   \uFF08\u8BE6\u60C5\u64CD\u4F5C\uFF09\u3001coi-form-actions\uFF08\u8868\u5355\u64CD\u4F5C\uFF09\u3001coi-card-head\uFF08\u5361\u7247\u5934\uFF09\u3001\n   coi-meta-row\uFF08\u5143\u4FE1\u606F\u884C\uFF09\uFF0C\u624B\u673A\u4E0A\u591A\u63A7\u4EF6\u65F6\u6298\u884C\u9632\u6EA2\u51FA\u3002\n   \uFF08\u515C\u5E95\u5C42\u6A21\u5F0F 2 \u5BF9 [class*="toolbar"/"actions"] \u5DF2\u5F3A\u5236 flex-wrap\u3002\uFF09 */\nhtml[data-dsh-mobile] .coi-toolbar,\nhtml[data-dsh-mobile] .coi-detail-actions,\nhtml[data-dsh-mobile] .coi-form-actions,\nhtml[data-dsh-mobile] .coi-card-head,\nhtml[data-dsh-mobile] .coi-meta-row {\n  flex-wrap: wrap;\n}\n\n/* \u6CE8\u5165\u8F68\u52FE\u9009\u884C\uFF08\u4E09\u4E2A checkbox \u6A2A\u5411\u6392\uFF09\uFF1A\u624B\u673A\u4E0A\u6536\u7D27\u95F4\u8DDD\u5E76\u5141\u8BB8\u6298\u884C\u3002 */\nhtml[data-dsh-mobile] .coi-inject-track-line {\n  gap: 10px;\n  flex-wrap: wrap;\n}\n\n/* \u7EDF\u8BA1\u5361\u7247\uFF1A\u684C\u9762 min-width 140px \u4E00\u884C\u653E 2~3 \u4E2A\uFF0C\u624B\u673A\u4E0A\u7F29\u5230 120px\n   \u4FDD\u8BC1\u4E00\u884C\u81F3\u5C11\u4E24\u4E2A\u3001\u4E0D\u6EA2\u51FA\u3002 */\nhtml[data-dsh-mobile] .coi-stat-card {\n  min-width: 120px;\n  flex-basis: 120px;\n}\n\n/* \u5185\u5BB9\u533A\u5185\u8FB9\u8DDD\u5FAE\u6536\u3002 */\nhtml[data-dsh-mobile] .coi-pane {\n  padding: 10px;\n}\n\n/* ================================================================\n * 5. \u4F1A\u8BDD\u5E7F\u64AD Tab\uFF08bb- \u7C7B\uFF0CBroadcastView\uFF09\n * ================================================================ */\n\n/* bb- \u7CFB\u5217\u6574\u4F53\u54CD\u5E94\u5F0F\u57FA\u7840\u597D\uFF08bb-row/bb-meta/bb-toolbar/bb-session-line\n   \u5747\u81EA\u5E26 flex-wrap\uFF09\uFF0C\u53EA\u9700\u6536\u7A84\u7559\u767D + \u653E\u5F00\u6D88\u606F\u5168\u6587\u9650\u9AD8\u3002 */\nhtml[data-dsh-mobile] .bb-pane {\n  padding: 4px 6px 16px;\n}\n\n/* \u623F\u95F4\u6D88\u606F\u533A\u5757\u5185\u8FB9\u8DDD\u5FAE\u6536\u3002 */\nhtml[data-dsh-mobile] .bb-room-msgs {\n  padding: 10px;\n}\n\n/* \u6D88\u606F\u5168\u6587\uFF08bb-content \u684C\u9762 max-height 320px \u5185\u6EDA\uFF09\uFF1A\u624B\u673A\u4E0A\u653E\u5F00\u9650\u9AD8\n   \u8BA9\u5168\u6587\u81EA\u7136\u5C55\u5F00\u968F\u9875\u9762\u6EDA\u52A8\uFF08\u5D4C\u5957\u6EDA\u52A8\u4F53\u9A8C\u5DEE\uFF09\u3002 */\nhtml[data-dsh-mobile] .bb-content {\n  max-height: none;\n}\n\n/* ================================================================\n * 6. \u4FBF\u7B7E Tab\uFF08sp- \u7C7B\uFF0CScratchView\uFF09\n * ================================================================ */\n\n/* sp- \u7CFB\u5217\u4E3B\u4F53\u672C\u6765\u5C31\u662F\u7EB5\u5411\u5E03\u5C40\uFF08\u6807\u9898\u884C + \u5168\u5BBD\u7F16\u8F91\u5668 + \u5DE5\u5177\u6761\uFF09\uFF0C\n   \u53EA\u9700\u4E24\u5904\u6A2A\u6392\u884C\u8865\u6362\u884C + \u6536\u7A84\u7559\u767D\u3002 */\nhtml[data-dsh-mobile] .sp-root {\n  padding: 10px;\n}\n\n/* \u5934\u90E8\u884C\uFF08\u8DEF\u5F84 + \u4FDD\u5B58\u65F6\u95F4\uFF09\uFF1A\u684C\u9762 baseline \u5355\u884C\uFF0C\u624B\u673A\u4E0A\u5141\u8BB8\u6298\u884C\uFF0C\n   \u957F\u8DEF\u5F84\u4E0D\u518D\u6324\u538B\u4FDD\u5B58\u65F6\u95F4\u3002 */\nhtml[data-dsh-mobile] .sp-head {\n  flex-wrap: wrap;\n}\n\n/* \u5DE5\u5177\u6761\uFF08\u6309\u94AE + \u72B6\u6001\uFF09\uFF1A\u624B\u673A\u4E0A\u5141\u8BB8\u6298\u884C\uFF0C\u6309\u94AE\u591A\u65F6\u6362\u884C\u6392\u5217\u3002\n   \uFF08\u515C\u5E95\u5C42\u6A21\u5F0F 2 \u5BF9 [class*="toolbar"] \u5DF2\u5F3A\u5236 flex-wrap + row-gap 8px\uFF0C\n   \u65B9\u5411\u4E00\u81F4\u3002\uFF09 */\nhtml[data-dsh-mobile] .sp-toolbar {\n  flex-wrap: wrap;\n  gap: 8px;\n}\n\n/* ================================================================\n * 7. \u63D0\u793A\u8BCD Tab\uFF08pm- \u7C7B\uFF0CPromptView\uFF09\n * ================================================================ */\n\n/* \u6839\u5BB9\u5668\uFF1A\u684C\u9762 overflow:hidden \u4E09\u680F\u5185\u90E8\u5404\u81EA\u6EDA\u52A8\uFF0C\u624B\u673A\u4E0A\u6539\u6574\u4F53\u53EF\u6EDA\u3002 */\nhtml[data-dsh-mobile] .pm-root {\n  padding: 6px;\n  overflow-y: auto;\n}\n\n/* \u9876\u680F\uFF08\u641C\u7D22 + \u7B5B\u9009\u4E0B\u62C9 + \u6309\u94AE\uFF09\uFF1A\u624B\u673A\u4E0A\u641C\u7D22\u6846\u5360\u6EE1\u6574\u884C\uFF0C\n   \u4E0B\u62C9\u4E0E\u6309\u94AE\u6298\u5230\u7B2C\u4E8C\u884C\u3002 */\nhtml[data-dsh-mobile] .pm-toolbar {\n  flex-wrap: wrap;\n}\nhtml[data-dsh-mobile] .pm-search {\n  flex-basis: 100%;\n}\n\n/* \u4E09\u680F\u4E3B\u4F53\u6539\u7EB5\u6392\uFF1Apm-body \u684C\u9762\uFF08\u5206\u7C7B\u6811 130px + \u5217\u8868 + \u8BE6\u60C5 42%\uFF09\uFF0C\n   \u624B\u673A\u4E0A\u4E0A\u4E0B\u5806\u53E0\u4E09\u6BB5\u2014\u2014\u5206\u7C7B\u6811\u9650\u9AD8 26vh\u3001\u5217\u8868\u9650\u9AD8 40vh\uFF08\u5185\u90E8\u6EDA\u52A8\uFF09\uFF0C\n   \u8BE6\u60C5\u8868\u5355\u7ED9\u8DB3 40vh\u3002\n   \uFF08\u515C\u5E95\u5C42\u6A21\u5F0F 2 \u5BF9 [class*="body"] \u5DF2\u5F3A\u5236 column\uFF0C\u65B9\u5411\u4E00\u81F4\u3002\uFF09 */\nhtml[data-dsh-mobile] .pm-body {\n  flex-direction: column;\n}\n/* \u5206\u7C7B\u6811\u9650\u9AD8 26vh \u5185\u90E8\u6EDA\u52A8\u3002\n   !important\uFF1A\u5BF9\u6297\u515C\u5E95\u5C42\u6A21\u5F0F 1 \u2014\u2014 \u515C\u5E95\u5BF9 [class*="pane"] \u94B3\u5236\n   max-height: calc(100dvh - 24px)\uFF08\u628A\u542B pane \u7684\u5143\u7D20\u5F53\u5F39\u5C42\u9632\u8D85\u9AD8\uFF09\uFF0C\n   \u6B64\u5904\u8981\u4FDD\u7559 26vh \u9650\u9AD8\uFF0C\u65B9\u5411\u76F8\u53CD\uFF0C\u5FC5\u987B !important\u3002 */\nhtml[data-dsh-mobile] .pm-pane-cats {\n  width: 100%;\n  flex: none;\n  max-height: 26vh !important;\n}\n/* \u5217\u8868\u9650\u9AD8 40vh \u5185\u90E8\u6EDA\u52A8\u3002\n   !important\uFF1A\u53CC\u91CD\u5BF9\u6297\u515C\u5E95 \u2014\u2014 \u2460 \u6A21\u5F0F 1 \u5BF9 [class*="pane"] \u94B3\u5236\n   max-height: calc(100dvh - 24px)\uFF1B\u2461 \u6A21\u5F0F 6 \u5BF9 [class*="list"] \u5F3A\u5236\n   max-height: none \u653E\u901A\u3002\u4E24\u5904\u65B9\u5411\u90FD\u76F8\u53CD\uFF0C\u5FC5\u987B !important\u3002 */\nhtml[data-dsh-mobile] .pm-pane-list {\n  flex: none;\n  max-height: 40vh !important;\n}\nhtml[data-dsh-mobile] .pm-pane-detail {\n  width: 100%;\n  min-width: 0;\n  flex: none;\n  min-height: 40vh;\n}\n\n/* \u6D6E\u5C42\uFF08\u6CE8\u5165\u4E2D / \u6765\u6E90\u5217\u8868\uFF0C\u684C\u9762 320px/420px \u56FA\u5B9A\u5BBD\uFF09\uFF1A\u624B\u673A\u4E0A\u6539\u8FD1\u5168\u5BBD\n   \u8D34\u8FB9\u6D6E\u5C42\uFF08\u5DE6\u53F3\u5404\u7559 8px\uFF09\uFF0C\u5185\u5BB9\u66F4\u6613\u8BFB\u3002\n   \uFF08\u515C\u5E95\u5C42\u6A21\u5F0F 1 \u5BF9 [class*="overlay"] \u94B3\u5236 max-width:\n   calc(100vw - 24px)\uFF0C\u4E0E"\u8FD1\u5168\u5BBD\u8D34\u8FB9"\u65B9\u5411\u4E00\u81F4\uFF0C\u5B9E\u9645\u5BBD\u5EA6\u53D7\u5176\u4FDD\u5E95\uFF0C\n   \u65E0\u9700 !important\u3002\uFF09 */\nhtml[data-dsh-mobile] .pm-overlay,\nhtml[data-dsh-mobile] .pm-overlay-wide {\n  left: 8px;\n  right: 8px;\n  width: auto;\n  max-width: none;\n}\n\n/* \u6CE8\u5165\u6309\u94AE\u7EC4\uFF1A\u5141\u8BB8\u6298\u884C\u3002 */\nhtml[data-dsh-mobile] .pm-inject-group {\n  flex-wrap: wrap;\n}\n\n/* ================================================================\n * 8. \u4E66\u7B7E Tab\uFF08bm- \u7C7B\uFF0CBookmarksView\uFF09\n * ================================================================ */\n\n/* bm- \u7CFB\u5217\u4E3B\u4F53\u7EB5\u5411\u5E03\u5C40\u5DF2\u9002\u914D\uFF0C\u53EA\u9700\u6536\u7A84\u7559\u767D + \u6761\u76EE\u5934\u8865\u6362\u884C\u3002\n   \uFF08\u5DE6\u53F3\u7559\u767D\u4F1A\u88AB\u515C\u5E95\u5C42\u6A21\u5F0F 7 \u4FDD\u5E95\u5230 \u226516px\uFF0C\u65B9\u5411\u4E00\u81F4\u3002\uFF09 */\nhtml[data-dsh-mobile] .bm-panel {\n  padding: 8px 10px;\n}\n\n/* \u6761\u76EE\u5934\uFF08\u540D\u79F0 + \u65F6\u95F4\uFF09\uFF1A\u684C\u9762 baseline \u5355\u884C\uFF0C\u624B\u673A\u4E0A\u5141\u8BB8\u6298\u884C\uFF0C\n   \u957F\u540D\u79F0\u4E0D\u518D\u6324\u538B\u53F3\u4FA7\u65F6\u95F4\u3002 */\nhtml[data-dsh-mobile] .bm-item-head {\n  flex-wrap: wrap;\n}\n\n/* ================================================================\n * 9. \u8BBE\u7F6E / \u6A21\u578B Tab\uFF08me- / mt-models- \u7C7B\uFF09\n * ================================================================ */\n\n/* \u8BBE\u7F6E Tab\uFF08SettingsTabView\uFF09\u4E0E UI \u8BBE\u7F6E\uFF08UiSettingsView\uFF09\u590D\u7528 me-panel /\n   me-form / me-field / me-block\uFF0C\u5DF2\u7531\u7B2C 0 \u8282\u901A\u7528\u89C4\u5219\u8986\u76D6\uFF0C\u65E0\u9700\u91CD\u590D\u3002 */\n\n/* \u6A21\u578B\u8868\u683C\u5BB9\u5668\uFF1A\u684C\u9762 flex:1 \u9650\u9AD8\u5185\u6EDA\uFF08\u7EB5\u5411\uFF09\uFF0C\u624B\u673A\u4E0A\u6539 flex:none\n   \u9AD8\u5EA6\u968F\u5185\u5BB9\uFF08\u7EB5\u5411\u968F\u9875\u9762\u6EDA\u52A8\uFF09\uFF0C\u6A2A\u5411\u6EDA\u52A8\u4FDD\u7559\uFF08\u8868\u683C\u5217\u591A\u65F6\u5DE6\u53F3\u6ED1\uFF09\u3002 */\nhtml[data-dsh-mobile] .mt-models-scroll {\n  flex: none;\n  overflow-x: auto;\n}\n\n/* \u6A21\u578B\u8868\u683C\uFF1A\u7ED9\u4E00\u4E2A\u6700\u5C0F\u5BBD\u5EA6\uFF08\u7EA6 640px\uFF09\uFF0C\u4FDD\u8BC1\u5217\u4E0D\u88AB\u538B\u6241\u3001\u6A2A\u5411\u6EDA\u52A8\n   \u5BB9\u5668\u771F\u6B63\u751F\u6548\uFF08\u684C\u9762 width:100% \u4F1A\u81EA\u52A8\u538B\u7F29\u5217\u5BBD\u5BFC\u81F4\u9605\u8BFB\u56F0\u96BE\uFF09\u3002\n   !important\uFF1A\u5BF9\u6297\u515C\u5E95\u5C42\u6A21\u5F0F 3 \u2014\u2014 \u515C\u5E95\u5BF9 [class*="table"] \u5F3A\u5236\n   min-width: 0\uFF08\u8BA9\u8868\u683C\u6536\u7F29\u56DE\u89C6\u53E3\u5BBD\u3001\u5185\u90E8\u6EDA\u52A8\uFF09\uFF0C\u6B64\u5904\u8981\u4FDD 640px\n   \u8868\u683C\u5BBD\u5EA6\uFF0C\u65B9\u5411\u76F8\u53CD\uFF0C\u5FC5\u987B !important\uFF08\u534F\u8BAE\u6587\u6863\u7AEF\u5230\u7AEF\u9A8C\u8BC1\u7B2C 12 \u9879\n   \u5373\u6B64\u573A\u666F\uFF09\u3002 */\nhtml[data-dsh-mobile] .mt-models-table {\n  min-width: 640px !important;\n}\n\n/* \u6A21\u578B\u884C\u5185\u601D\u8003\u7B49\u7EA7\u6807\u7B7E\u533A\uFF1Aflex-wrap \u5DF2\u81EA\u5E26\uFF0C\u65E0\u9700\u5904\u7406\u3002 */\n\n/* ================================================================\n * 10. DSH \u5BF9\u8BDD\u533A\uFF08\u4E2D\u5FC3\u5217\uFF0CConversationRoot/ChatView\uFF09\u2014\u2014\u6D88\u606F\u4E0E\u5C4F\u5E55\u7B49\u5BBD\n * ================================================================ */\n\n/* \u5BF9\u8BDD\u533A\u5360\u6EE1\u5C4F\u5BBD\uFF1ADSH \u5BF9\u8BDD\u533A\u5BBD\u5EA6\u7531 CSS \u53D8\u91CF --dsh-chat-content-width\n   \u63A7\u5236\uFF08ConversationRoot.module.css \u9ED8\u8BA4 748px \u684C\u9762\u7A84\u680F\uFF09\uFF0C\u624B\u673A\u4E0A\n   \u8986\u76D6\u4E3A 100%\u2014\u2014\u6D88\u606F\u5217\u3001\u7EDF\u8BA1\u884C\u3001\u5BA1\u6279\u9762\u677F\u5168\u90E8\u8DDF\u968F\uFF1B\u8F93\u5165\u6846\u6D3E\u751F\u53D8\u91CF\n   \uFF08= content + 32px\uFF09\u88AB\u5176\u81EA\u8EAB width: min(..., 100%) \u515C\u5E95\uFF0C\u4E0D\u4F1A\u6EA2\u51FA\u3002\n   !important\uFF1A\u5BF9\u6297 DSH UI \u8BBE\u7F6E\u6A21\u5757 wideChat \u529F\u80FD\uFF08html[data-dsh-ui-\n   wide-chat="on"] [data-phase] { --dsh-chat-content-width: 95% }\u2014\u2014\n   PC \u684C\u9762\u89C4\u5219\u5728\u7A84\u5C4F\u540C\u6837\u547D\u4E2D\uFF0C\u4E14\u7279\u5F02\u6027\u4E0E\u672C\u89C4\u5219\u76F8\u540C\u3001\u6E90\u987A\u5E8F\u4E0D\u786E\u5B9A\u8C01\n   \u8D62\uFF09\uFF0C\u624B\u673A\u9002\u914D\u534F\u8BAE\u4F18\u5148\u4E8E\u684C\u9762\u529F\u80FD\u5F00\u5173\uFF0C\u65B9\u5411\u76F8\u53CD\u5FC5\u987B !important\u3002 */\nhtml[data-dsh-mobile] [data-phase] {\n  --dsh-chat-content-width: 100% !important;\n}\n\n/* \u6CE8\u610F\uFF1A\u4E0D\u8981\u7ED9 [data-phase]\uFF08\u5BF9\u8BDD\u533A\u5BB9\u5668\uFF0C\u542B\u5E95\u90E8\u8F93\u5165\u6846\uFF09\u52A0 margin-left /\n   width \u8986\u76D6\u2014\u20142026-08-10 \u66FE\u8BEF\u52A0\u300C\u5DE6\u7559\u767D 10px\u300D\u5BFC\u81F4\u6574\u4E2A\u533A\u57DF\uFF08\u542B\u8F93\u5165\u6846\uFF09\n   \u5BBD\u5EA6\u88AB\u6539\uFF0C\u771F\u673A\u51FA\u73B0\u8F93\u5165\u6846\u5149\u6807\u4E0E\u6587\u5B57\u9519\u4F4D\u3001\u6587\u5B57\u95F4\u51FA\u73B0\u7A7A\u9699\uFF08\u7528\u6237\u5B9E\u6D4B\u53CD\u9988\uFF09\u3002\n   \u5BF9\u8BDD\u533A\u6EE1\u5BBD\u7531\u4E0A\u65B9 --dsh-chat-content-width: 100% \u89C4\u5219\u63A7\u5236\u5373\u53EF\uFF0C\u8F93\u5165\u6846\n   \u5BBD\u5EA6\u7531\u5176\u81EA\u8EAB width: min(..., 100%) \u515C\u5E95\uFF0C\u5BB9\u5668\u7EA7\u8986\u76D6\u4E00\u5F8B\u4E0D\u52A0\u3002 */\n\n/* \u7528\u6237\u6D88\u606F\u6C14\u6CE1\u6EE1\u5BBD\uFF1A\u9ED8\u8BA4 max-width: min(525px, 82%)\uFF08MessageItem.\n   module.css .bubble\uFF09\uFF0C\u624B\u673A\u4E0A\u653E\u5F00\u4E3A 100%\uFF0C\u6D88\u9664\u4E24\u4FA7\u7559\u767D\uFF1B\u77ED\u6D88\u606F\u4ECD\u6309\n   \u5185\u5BB9\u81EA\u9002\u5E94\uFF08max-width \u53EA\u8BBE\u4E0A\u9650\uFF0C\u4E0D\u5F3A\u5236\u6491\u6EE1\uFF09\u3002\u951A\u70B9\uFF1A\u7528\u6237\u6D88\u606F\u884C\n   userRow \u6709\u6052\u5B9A data-time-hover-root \u5C5E\u6027\uFF08MessageItem.tsx\uFF09\uFF0C\n   bubble \u6052\u4E3A\u5176**\u7B2C\u4E00\u4E2A div \u5B50\u5143\u7D20**\uFF08steering \u6807\u8BB0\u662F span\u3001\n   MessageIconActions \u662F\u7B2C\u4E8C\u4E2A div\uFF09\u2192 div:first-of-type \u552F\u4E00\u547D\u4E2D\u3002\n   !important\uFF1A\u540C\u4E0A\u5BF9\u6297 ui-settings wideBubble \u7684 80% \u89C4\u5219\n   \uFF08html[data-dsh-ui-wide-bubble="on"] [data-time-hover-root] >\n   div:first-of-type\uFF09\uFF0CPC \u89C4\u5219\u7A84\u5C4F\u540C\u6837\u547D\u4E2D\uFF0C\u65B9\u5411\u76F8\u53CD\u5FC5\u987B !important\u3002 */\nhtml[data-dsh-mobile] [data-time-hover-root] > div:first-of-type {\n  max-width: 100% !important;\n}\n\n/* \u52A9\u624B\u6D88\u606F\u65E0\u9700\u5355\u72EC\u89C4\u5219\uFF1AAssistantMarkdown \u672C\u6765\u5C31\u662F full-width\n   \uFF08\u65E0 max-width \u9650\u5236\uFF09\uFF0C\u5BBD\u5EA6\u53EA\u968F\u6D88\u606F\u5217\uFF08--dsh-chat-content-width\uFF09\n   \u8D70\uFF0C\u5217 100% \u5373\u6EE1\u5BBD\u3001\u65E0\u4E24\u4FA7\u8FB9\u8DDD\u3002 */\n\n/* \u6D88\u606F\u6EDA\u52A8\u5BB9\u5668\u5DE6\u53F3 padding \u5F52\u96F6\uFF08\u7528\u6237\u5B9E\u6D4B\u53CD\u9988\uFF1A\u5BF9\u8BDD\u533A\u5DF2\u6EE1\u5BBD\u4F46\u6D88\u606F\n   \u4ECD\u6709\u5DE6\u53F3\u7F29\u8FDB\u3001\u4E14\u53F3\u4FA7\u6BD4\u5DE6\u4FA7\u591A\u4E00\u5757\uFF09\uFF1A\n   DSH ChatView.module.css .scroll \u6709\u56FA\u5B9A padding: 16px calc(var(--dsh-\n   composer-side-clearance) + 16px) = \u5DE6\u53F3\u5404 32px\uFF08\u8BBE\u8BA1\u4E0A\u662F"\u8F93\u5165\u6846\u6BD4\n   \u6D88\u606F\u5217\u5BBD 32px"\u7684\u5171\u4EAB\u5BBD\u5EA6\u8F74\uFF09\u3002\u7C7B\u540D\u662F CSS modules \u54C8\u5E0C\uFF0C\u65E0\u6CD5\u76F4\u63A5\u9009\uFF0C\n   \u4F46\u6D88\u606F\u5217 .column \u6709\u7A33\u5B9A\u5C5E\u6027 data-chat-flow=""\uFF08ChatView.tsx\uFF09\uFF0C\n   .scroll \u6052\u4E3A\u5176**\u76F4\u63A5\u7236\u5143\u7D20** \u2192 `div:has(> [data-chat-flow])` \u552F\u4E00\u547D\u4E2D\u3002\n   \u4FDD\u7559\u7EB5\u5411 16px\uFF08\u6D88\u606F\u95F4\u547C\u5438\u611F\uFF09\uFF0C\u6A2A\u5411\u5F52\u96F6\u8BA9\u6D88\u606F\u771F\u6B63\u8D34\u6EE1\u5C4F\u5BBD\u3002\n   \uFF08:has() \u9700 Chrome 105+\uFF0C\u79FB\u52A8\u7AEF webview \u65E0\u95EE\u9898\u3002\uFF09 */\nhtml[data-dsh-mobile] [data-conversation-scroll] div:has(> [data-chat-flow]) {\n  padding: 16px 0;\n}\n\n/* \u5916\u5C42\u6EDA\u52A8\u4F53\u53F3\u4FA7\u6EDA\u52A8\u6761\u69FD\u4F4D\u53D6\u6D88\u9884\u7559\uFF08\u7528\u6237\u5B9E\u6D4B\uFF1A\u53F3\u4FA7\u95F4\u9699\u6BD4\u5DE6\u4FA7\u5927\n   \u4E00\u70B9\u70B9\u2014\u2014\u6B63\u662F\u8FD9\u4E2A gutter\uFF09\uFF1A\n   DSH ConversationRoot.module.css .scrollBody \u6709 scrollbar-gutter: stable\n   \u2014\u2014**\u65E0\u6761\u4EF6**\u4E3A\u6EDA\u52A8\u6761\u9884\u7559\u69FD\u4F4D\uFF08\u8FDE overlay \u6EDA\u52A8\u6761\u7684 webview \u4E5F\u9884\u7559\uFF0C\n   \u89C6\u89C9\u4E0A\u53F3\u4FA7\u6C38\u8FDC\u591A\u4E00\u5757\u7A7A\u767D\uFF09\u3002\u624B\u673A\u4E0A\u5173\u6389\u9884\u7559\uFF0C\u6EDA\u52A8\u6761\u51FA\u73B0\u65F6\u6309\u7CFB\u7EDF\n   \u9ED8\u8BA4\u884C\u4E3A\u81EA\u7136\u5360\u4F4D/\u60AC\u6D6E\uFF0C\u4E0D\u51FA\u73B0\u65F6\u7684\u7A7A\u767D\u968F\u4E4B\u6D88\u5931\u3002\n   \uFF08scrollbar-gutter \u5C5E\u6027\u65E0\u524D\u7F00\u652F\u6301\uFF1AChrome 94+ / Firefox 97+\u3002\uFF09 */\nhtml[data-dsh-mobile] [data-conversation-scroll] {\n  scrollbar-gutter: auto;\n}\n\n/* \u8F93\u5165\u680F\u5DE5\u5177\u680F\u300C\u4E0A\u62C9\u5F39\u7A97\u300D\u6536\u7EB3\uFF08\u7528\u6237\u62CD\u677F 2026-08-09\uFF0C\u6A21\u578B\u4E00\u5E76\u6536\u7EB3\uFF09\uFF1A\n   ---------------------------------------------------------------------------\n   \u7ED3\u6784\uFF08InputBar.tsx\uFF0C\u4E0D\u4F9D\u8D56 CSS modules \u54C8\u5E0C\u7C7B\u540D\uFF09\uFF1A\n     card[data-composer-card]\n       > [data-input-scroll]          \u2190 textarea \u6EDA\u52A8\u533A\n       > div                          \u2190 .row\uFF08scroll \u7684\u4E0B\u4E00\u4E2A\u5144\u5F1F\uFF09\n         > div:first-child            \u2190 .tools\uFF08\u52A0\u53F7 + \u6743\u9650\uFF09\n         > div:last-of-type           \u2190 .trailing\uFF08\u6A21\u578B + \u5706\u73AF + \u53D1\u9001\uFF09\n           > div:has(> button[aria-haspopup="menu"])  \u2190 ModelSelect \u6839\n             \uFF08ContextMeter \u662F span\u3001\u53D1\u9001\u662F button\uFF0C\u9009\u62E9\u5668\u4E0D\u4F1A\u8BEF\u4F24\uFF09\n         > button.dsh-mobile-more-btn \u2190 enhance \u6CE8\u5165\uFF0Corder:-1 \u6392\u6700\u5DE6\n\n   \u80CC\u666F\uFF1A\u624B\u673A\u4E0A .row = flex space-between\uFF0C.trailing\uFF08\u6A21\u578B\u540D\u8F83\u957F\uFF09flex:none\n   \u5360\u6EE1\uFF0C.tools \u88AB\u6324\u6CA1\uFF1B\u6A21\u578B\u4E5F\u5360\u6A2A\u5411\u7A7A\u95F4\u3002\u65B9\u6848\uFF1A\u624B\u673A\u9ED8\u8BA4\u9690\u85CF .tools + \u6A21\u578B\uFF0C\n   \u53EA\u5E38\u9A7B\u300C\u22EF\u300D+ \u5706\u73AF + \u53D1\u9001\uFF1B\u70B9\u300C\u22EF\u300D\u5207\u6362 html[data-dsh-mobile-sheet] \u2192\n   \u4E8C\u8005\u4EE5 fixed \u5E95\u680F\u51FA\u73B0\u5728\u8F93\u5165\u680F\u4E0A\u65B9\uFF08**\u4E0D\u79FB\u52A8/\u4E0D\u590D\u5236 DOM**\uFF0CReact \u4E8B\u4EF6\u4FDD\u7559\uFF09\u3002\n\n   \u5E95\u680F\u89C6\u89C9\uFF1A.tools \u63D0\u4F9B\u5B8C\u6574\u9762\u677F chrome\uFF08\u80CC\u666F/\u5706\u89D2/\u9634\u5F71\uFF09\uFF1B\u6A21\u578B\u7528\u540C\u5E95\u540C\u9AD8\n   \u7684\u900F\u660E fixed \u5C42\u53E0\u5728\u53F3\u4FA7\uFF08pointer-events \u53EA\u5F00\u81EA\u8EAB\uFF09\uFF0C\u770B\u8D77\u6765\u50CF\u540C\u4E00\u6761\u5E95\u680F\u3002\n   bottom \u7528 --dsh-composer-height\uFF08ConversationRoot \u5B9E\u65F6\u9AD8\u5EA6\uFF0C152px \u515C\u5E95\uFF09\u3002 */\n\n/* ---- \u9ED8\u8BA4\u9690\u85CF\uFF1A.tools + \u6A21\u578B\u9009\u62E9 ---- */\nhtml[data-dsh-mobile] [data-composer-card] > [data-input-scroll] + div > div:first-child {\n  display: none;\n}\n/* \u6A21\u578B\uFF1A.trailing \u5185\u300C\u76F4\u63A5\u5B50 button \u5E26 aria-haspopup=menu \u7684 div\u300D= ModelSelect */\nhtml[data-dsh-mobile] [data-composer-card] > [data-input-scroll] + div > div:last-of-type > div:has(> button[aria-haspopup="menu"]) {\n  display: none;\n}\n\n/* ---- sheet \u6253\u5F00\uFF1A.tools \u53D8 fixed \u5E95\u680F\uFF08\u9762\u677F chrome \u8F7D\u4F53\uFF09---- */\nhtml[data-dsh-mobile][data-dsh-mobile-sheet] [data-composer-card] > [data-input-scroll] + div > div:first-child {\n  display: flex;\n  position: fixed;\n  left: 12px;\n  right: 12px;\n  bottom: calc(var(--dsh-composer-height, 152px) + 8px);\n  z-index: 50;\n  flex-wrap: wrap;\n  align-items: center;\n  /* \u53F3\u4FA7\u7559\u7ED9\u6A21\u578B chip\uFF0C\u907F\u514D\u4E0E\u53E0\u5728\u4E0A\u9762\u7684\u6A21\u578B\u533A\u62A2\u4F4D */\n  gap: 12px;\n  padding: 10px 12px;\n  padding-right: min(48%, 200px);\n  border-radius: 14px;\n  background: var(--dsw-alias-bg-base, #1e1e1e);\n  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.25));\n  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.22);\n}\n\n/* ---- sheet \u6253\u5F00\uFF1A\u6A21\u578B\u53E0\u5728\u540C\u4E00\u5E95\u680F\u53F3\u4FA7\uFF08\u65E0\u72EC\u7ACB chrome\uFF0C\u501F .tools \u7684\u9762\u677F\uFF09---- */\nhtml[data-dsh-mobile][data-dsh-mobile-sheet] [data-composer-card] > [data-input-scroll] + div > div:last-of-type > div:has(> button[aria-haspopup="menu"]) {\n  display: flex;\n  position: fixed;\n  left: 12px;\n  right: 12px;\n  bottom: calc(var(--dsh-composer-height, 152px) + 8px);\n  z-index: 51; /* \u9AD8\u4E8E .tools \u9762\u677F\uFF0C\u786E\u4FDD\u53EF\u70B9 */\n  align-items: center;\n  justify-content: flex-end;\n  /* \u9AD8\u5EA6\u5BF9\u9F50 .tools \u5E95\u680F\u5185\u5BB9\u533A\uFF08padding 10*2 + \u63A7\u4EF6 28 \u2248 48\uFF09 */\n  min-height: 48px;\n  padding: 10px 12px;\n  /* \u900F\u660E\uFF1Achrome \u7531\u4E0B\u65B9 .tools \u9762\u677F\u63D0\u4F9B\uFF1Bpointer-events \u53EA\u5F00\u81EA\u8EAB\u5B50\u6811 */\n  background: transparent;\n  border: none;\n  box-shadow: none;\n  pointer-events: none; /* \u5DE6\u4FA7\u7A7A\u767D\u70B9\u7A7F\u5230 .tools */\n}\nhtml[data-dsh-mobile][data-dsh-mobile-sheet] [data-composer-card] > [data-input-scroll] + div > div:last-of-type > div:has(> button[aria-haspopup="menu"]) > * {\n  pointer-events: auto; /* \u6A21\u578B\u89E6\u53D1\u6309\u94AE + [role=menu] \u5747\u53EF\u70B9\uFF08\u76F4\u63A5\u5B50\uFF09 */\n}\n\n/* ---- ModelSelect \u4E00\u7EA7/\u4E8C\u7EA7\u83DC\u5355\u624B\u673A\u53EF\u89C1\u6027\uFF08v4 \xB7 \u771F\u673A\u4FEE\u590D 2026-08-10\uFF09----\n   ---------------------------------------------------------------------------\n   \u7ED3\u6784\uFF08ModelSelect.tsx\uFF0C\u4E0D\u4F9D\u8D56 CSS modules \u54C8\u5E0C\u7C7B\u540D\uFF09\uFF1A\n     \u6839 div\uFF08\u4E0A\u6761\u89C4\u5219\u5DF2 fixed \u6210\u5E95\u680F\u53F3\u4FA7 chip\uFF09\n       > button[aria-haspopup="menu"]     \u2190 trigger\n       > div[role="menu"]                 \u2190 \u552F\u4E00\u83DC\u5355\u8282\u70B9\uFF08\u4E00\u7EA7/\u4E8C\u7EA7\u5171\u7528\uFF09\n           pane=root   \uFF1A\u300C\u6A21\u578B\u300D\u300C\u601D\u8003\u5F3A\u5EA6\u300D\u4E24\u884C cell\uFF08~2\xD740px\uFF09\n           pane=model  \uFF1A\u6A21\u578B\u5206\u7EC4\u5217\u8868\n           pane=effort \uFF1A\u601D\u8003\u7B49\u7EA7\u5217\u8868\n   \uFF08\u6CA1\u6709\u72EC\u7ACB\u7684\u4E8C\u7EA7 DOM\u2014\u2014setPane \u53EA\u5207\u6362\u540C\u4E00 menu \u5185\u7684\u5185\u5BB9\u3002\uFF09\n\n   ## \u5386\u53F2\u5931\u8D25\uFF08\u52A1\u5FC5\u52FF\u56DE\u9000\uFF09\n   - v1\uFF08fixed + --dsh-composer-height \u951A\u5B9A bottom/max-height\uFF09\uFF1A\n     \u7A7A\u4F1A\u8BDD seat\u2248150\u2013250px \u770B\u8D77\u6765\u6B63\u5E38\uFF1B\u771F\u673A\u6B63\u5E38\u4F1A\u8BDD seat 300\u2013600px\n     \uFF08dock \u5361/\u7EDF\u8BA1\u884C/\u591A\u884C\u8349\u7A3F\u5168\u7B97\u8FDB --dsh-composer-height\uFF09\u2192\n     bottom = seat+64 \u628A\u83DC\u5355\u9876\u5230\u89C6\u53E3\u4E0A\u65B9\uFF0Cmax-height = 100dvh-seat-80\n     \u88AB\u538B\u5230 \u226460px\uFF08\u4E00\u7EA7\u4E24\u884C cell \u8981 ~88px\uFF09\u2192 \u7528\u6237\u611F\u77E5\u300C\u83DC\u5355\u6CA1\u51FA\u6765\u300D\u3002\n     \u6839\u56E0\uFF1A\u83DC\u5355\u51E0\u4F55\u7ED1\u6B7B\u4E86\u300C\u5EA7\u4F4D\u6574\u4F53\u9AD8\u5EA6\u300D\uFF0C\u4E0E\u300C\u5E95\u680F chip \u771F\u5B9E\u4F4D\u7F6E\u300D\u4E0D\u7B49\u4EF7\u3002\n   - v2\uFF08\u4F9D\u8D56 .row \u7684 container-type \u5F53 fixed \u5305\u542B\u5757 + absolute 100%\uFF09\uFF1A\n     \u771F\u673A webview \u4E0A container-type \u7684 fixed \u5305\u542B\u5757\u884C\u4E3A\u4E0D\u53EF\u9760\uFF0C\n     \u300C\u22EF\u300D\u6309\u94AE/\u5E95\u680F\u6574\u4F53\u65E0\u53CD\u5E94\u3002\u5DF2\u6574\u4F53\u56DE\u6EDA\uFF0C\u7981\u6B62\u590D\u7528\u3002\n\n   ## v3 \u771F\u673A\u6839\u56E0\n   1. v3 \u7EC4\u5408\u201Cposition:fixed \u7684 ModelSelect \u6839 + position:absolute \u7684\u83DC\u5355\u201D\uFF0C\n      \u628A\u83DC\u5355\u4F4D\u7F6E\u4EA4\u7ED9 WebView \u5728\u5D4C\u5957\u5B9A\u4F4D\u4E0A\u4E0B\u6587\u4E2D\u63A8\u5BFC\u3002headless Chrome \u7684\u5E03\u5C40\n      \u7ED3\u679C\u7A33\u5B9A\uFF0C\u4F46\u771F\u673A\u8FD8\u53E0\u52A0 visualViewport\u3001\u52A8\u6001\u5DE5\u5177\u680F/\u952E\u76D8\u548C\u7956\u5148\n      containment\uFF0Cabsolute \u83DC\u5355\u867D\u5DF2\u6302\u8F7D\uFF0C\u5374\u53EF\u80FD\u5408\u6210\u5230\u53EF\u89C6\u533A\u4E4B\u5916\u3002\n   2. enhance \u539F\u5148\u53EA\u5199 max-height\uFF0C\u6CA1\u6709\u660E\u786E\u5199\u83DC\u5355\u7684\u89C6\u53E3\u5750\u6807\uFF1B\u4E14\u591A composer\n      \u5E76\u5B58\u65F6\u6309\u201C\u6700\u9760\u4E0A\u53EF\u89C1\u6839\u201D\u6D4B\u91CF\uFF0C\u53EF\u80FD\u62FF\u5230\u7528\u6237\u6CA1\u6709\u5C55\u5F00\u7684\u5B9E\u4F8B\u3002\n   3. \u70B9\u51FB\u4E00\u7EA7\u884C\u540E React \u540C\u6B65 setPane \u5E76\u5378\u8F7D\u65E7\u6309\u94AE\uFF1Bdocument bubble click\n      \u624D\u7528 contains/closest \u5224\u65AD\u65F6\uFF0C\u771F\u673A\u4E0A\u7684 event.target \u5DF2\u53EF\u80FD\u8131\u79BB DOM\uFF0C\n      \u4E8E\u662F\u83DC\u5355\u5185\u70B9\u51FB\u88AB\u8BEF\u5224\u4E3A\u5916\u90E8\u70B9\u51FB\uFF0C\u6574\u4E2A sheet \u968F\u5373\u5173\u95ED\u3002\u4E8B\u4EF6\u4FEE\u590D\u8BE6\u89C1\n      mobile-input-sheet.ts \u7684 onDocClickCapture\u3002\n\n   ## v4 \u65B9\u6848\uFF08\u4E0E --dsh-composer-height\u3001\u5D4C\u5957 absolute \u5750\u6807\u5B8C\u5168\u89E3\u8026\uFF09\n   1. \u83DC\u5355\u7EDF\u4E00 position:fixed\u3002enhance \u5728 click capture\uFF08React \u66F4\u65B0\u524D\uFF09\u9501\u5B9A\n      \u5B9E\u9645 trigger\uFF0C\u5E76\u628A visualViewport \u7684 offset/width\u3001chip \u9876\u8FB9\u548C layout\n      viewport \u9AD8\u5EA6\u6362\u7B97\u4E3A --dsh-mobile-menu-left/width/top/bottom/max-h\u3002\n      \u6D4F\u89C8\u5668\u53EA\u6D88\u8D39\u660E\u786E\u5750\u6807\uFF0C\u4E0D\u518D\u8DE8 fixed/absolute \u5305\u542B\u5757\u81EA\u884C\u63A8\u5BFC\u3002\n   2. \u83DC\u5355\u6253\u5F00\u540E\u7684\u91CD\u6D4B\u53EA\u8BA4 aria-expanded=true \u7684\u5B9E\u4F8B\uFF1Bpane \u5207\u6362\u3001DOM \u53D8\u5316\u3001\n      \u65CB\u8F6C\u3001\u5730\u5740\u680F\u4E0E\u952E\u76D8\u53D8\u5316\u90FD\u4F1A\u91CD\u65B0\u8BA1\u7B97\u3002\n   3. \u6B63\u5E38\u6A21\u5F0F\u901A\u8FC7 bottom \u8D34 chip \u4E0A\u65B9 8px\uFF1B\u4E0A\u65B9\u4E0D\u8DB3\u4E00\u7EA7\u4E24\u884C\u65F6\uFF0C\u4EC5\u628A top\n      \u5207\u5230 visualViewport \u9876\u90E8\u5B89\u5168\u533A\u3001bottom \u5207\u4E3A auto\u3002\u4E24\u79CD\u6A21\u5F0F\u59CB\u7EC8\u5171\u7528\n      \u540C\u4E00\u4E2A fixed \u83DC\u5355\u89C4\u5219\uFF0C\u907F\u514D\u771F\u673A\u5C42\u53E0\u987A\u5E8F\u518D\u5206\u53C9\u3002\n   4. !important \u5BF9\u6297 dsh-android-edapp \u515C\u5E95\u6A21\u5F0F 1 \u5BF9 [role=menu]\n      \u7684 max-width/max-height: calc(100dvh - 24px) !important\uFF0C\u4EE5\u53CA\u539F\u751F\n      ModelSelect.module.css \u7684 absolute/right/bottom/width/max-height\u3002\n   5. \u4E0D\u79FB\u52A8/\u590D\u5236 DOM\uFF1B\u4E0D\u4F9D\u8D56 container-type\uFF1B\u5E95\u680F .tools \u4ECD\u7528 v1 \u7684\n      fixed + --dsh-composer-height\uFF08\u8BE5\u8DEF\u5F84\u5DF2\u9A8C\u8BC1\u300C\u22EF\u300D\u53EF\u70B9\uFF0C\u4E0D\u52A8\uFF09\u3002 */\n\n/* \u6839\uFF1A\u83DC\u5355\u5C55\u5F00\u65F6\u62AC\u9AD8\u6574\u5C42 stacking\uFF1Boverflow:visible \u540C\u65F6\u4FDD\u62A4\u65E0 JS \u9996\u5E27\u3002 */\nhtml[data-dsh-mobile][data-dsh-mobile-sheet] [data-composer-card] > [data-input-scroll] + div > div:last-of-type > div:has(> button[aria-haspopup="menu"]) {\n  overflow: visible;\n}\nhtml[data-dsh-mobile][data-dsh-mobile-sheet] [data-composer-card] > [data-input-scroll] + div > div:last-of-type > div:has(> button[aria-haspopup="menu"][aria-expanded="true"]) {\n  z-index: 900;\n}\n\n/* \u83DC\u5355\uFF1AJS \u660E\u786E\u5199\u5165\u89C6\u89C9\u89C6\u53E3\u51E0\u4F55\uFF1B\u4E00\u7EA7/\u4E8C\u7EA7\u590D\u7528\u540C\u4E00 fixed \u53EF\u6EDA\u8282\u70B9\u3002 */\nhtml[data-dsh-mobile][data-dsh-mobile-sheet] [data-composer-card] > [data-input-scroll] + div > div:last-of-type > div:has(> button[aria-haspopup="menu"]) > [role="menu"] {\n  /*\n   * position/left/right/top/bottom/width \u7684 !important\uFF1A\u538B\u8FC7\u539F\u751F\n   * ModelSelect.module.css `.menu` \u7684 absolute/right/bottom/width\uFF0C\u786E\u4FDD\u771F\u673A\n   * \u4E0D\u4F1A\u6DF7\u7528\u4E00\u534A\u539F\u751F\u5750\u6807\u3001\u4E00\u534A enhance \u5750\u6807\u3002\n   */\n  position: fixed !important;\n  left: var(--dsh-mobile-menu-left, 12px) !important;\n  right: auto !important;\n  top: var(--dsh-mobile-menu-top, 12px) !important;\n  bottom: var(--dsh-mobile-menu-bottom, auto) !important;\n  width: var(--dsh-mobile-menu-width, calc(100vw - 24px)) !important;\n  max-width: none !important;\n  /*\n   * max-height \u7684 !important\uFF1A\u4E13\u95E8\u538B\u8FC7 dsh-android-edapp \u6A21\u5F0F 1 \u5BF9\n   * [role=menu] \u7684 `calc(100dvh - 24px) !important`\u3002\u82E5\u8BA9\u90A3\u4E2A\u51E0\u4E4E\u6574\u5C4F\u7684\n   * \u9650\u9AD8\u8D62\u8FC7\u6765\uFF0C\u5411\u4E0A\u751F\u957F\u7684\u83DC\u5355\u4F1A\u518D\u6B21\u628A\u5185\u5BB9\u9876\u51FA\u53EF\u89C1\u533A\u3002\n   *\n   * \u672A\u5199\u53D8\u91CF\u7684\u6781\u77ED\u9996\u5E27\u5B89\u5168\u843D\u5728\u89C6\u53E3\u9876 12px\uFF1Bclick capture \u4F1A\u5728 React \u6302\u8F7D\n   * \u83DC\u5355\u524D\u9884\u5199\u6B63\u786E trigger \u5750\u6807\uFF0CMutationObserver \u4E0E viewport \u4E8B\u4EF6\u968F\u540E\u6821\u6B63\u3002\n   */\n  max-height: var(--dsh-mobile-menu-max-h, min(360px, 50dvh)) !important;\n  overflow-x: hidden !important;\n  overflow-y: auto !important;\n  z-index: 920 !important; /* \u9AD8\u4E8E\u5C55\u5F00\u6839 900 \u4E0E .tools \u5E95\u680F 50\uFF0C\u4FDD\u8BC1\u83DC\u5355\u53EF\u70B9 */\n  /* \u89E6\u63A7\u6EDA\u52A8\u60EF\u6027\uFF08iOS/WebView\uFF09 */\n  -webkit-overflow-scrolling: touch;\n  /* \u8868\u9762 token \u4E0E\u539F\u751F\u4E00\u81F4\uFF08\u663E\u5F0F\u5199\u51FA\uFF0C\u907F\u514D\u88AB\u5176\u5B83\u5C42\u53E0\u89C4\u5219\u51B2\u6DE1\u65F6\u65E0 fallback\uFF09 */\n  background: var(--dsw-specific-menu);\n  border: 1px solid var(--dsw-alias-border-inverted);\n  box-shadow: var(--dsw-shadow-lv3);\n  border-radius: 12px;\n  box-sizing: border-box;\n}\n\n/* data-dsh-mobile-menu-flip \u53EA\u4F5C\u4E3A\u53EF\u8BCA\u65AD\u72B6\u6001\u6807\u8BB0\uFF1B\u51E0\u4F55\u4ECD\u7531\u540C\u4E00\u7EC4 top/bottom\n   \u53D8\u91CF\u9A71\u52A8\uFF0C\u4E0D\u518D\u4E3A\u6781\u7AEF\u6A21\u5F0F\u590D\u5236\u7B2C\u4E8C\u5957 CSS \u89C4\u5219\u3002 */\n\n/* \u300C\u22EF\u300D\u5165\u53E3\u6309\u94AE\uFF08mobile-input-sheet.ts enhance \u6CE8\u5165\uFF0Cappend \u5728\u5DE5\u5177\u680F\n   \u884C\u5C3E + order:-1 \u89C6\u89C9\u6392\u6700\u5DE6\uFF09\uFF1A\u6837\u5F0F\u5BF9\u9F50 DSH \u539F\u751F\u52A0\u53F7\u6309\u94AE\uFF0828px \u5706\u5F62\u3001\n   selector \u586B\u5145\uFF09\u3002\u5FC5\u987B\u6302 html[data-dsh-mobile]\u2014\u2014\u4E0E\u534F\u8BAE\u5176\u5B83\u89C4\u5219\u4E00\u81F4\uFF0C\n   \u4E14\u88AB adapter \u518D\u5305\u4E00\u5C42 @media \u2264767px\uFF0C\u53CC\u4FDD\u9669\u684C\u9762\u96F6\u526F\u4F5C\u7528\u3002 */\nhtml[data-dsh-mobile] .dsh-mobile-more-btn {\n  display: grid;\n  place-items: center;\n  flex: none;\n  order: -1;\n  width: 28px;\n  height: 28px;\n  border: none;\n  border-radius: 999px;\n  background: var(--dsw-specific-selector);\n  color: var(--dsw-alias-label-primary);\n  cursor: pointer;\n  touch-action: manipulation;\n  transition: background 0.12s ease;\n}\nhtml[data-dsh-mobile] .dsh-mobile-more-btn:active {\n  background: var(--dsw-alias-interactive-bg-hover-solid);\n}\n/* sheet \u6253\u5F00\u65F6\u5165\u53E3\u6309\u94AE\u9AD8\u4EAE\uFF0C\u63D0\u793A"\u66F4\u591A\u5DF2\u5C55\u5F00" */\nhtml[data-dsh-mobile][data-dsh-mobile-sheet] .dsh-mobile-more-btn {\n  background: var(--dsw-alias-interactive-bg-hover-solid);\n  color: var(--dsw-alias-state-business-primary);\n}\n';

// src/client/mobile-input-sheet.ts
var SHEET_ATTR = "data-dsh-mobile-sheet";
var MORE_BTN_CLASS = "dsh-mobile-more-btn";
var MENU_MAX_H_VAR = "--dsh-mobile-menu-max-h";
var MENU_LEFT_VAR = "--dsh-mobile-menu-left";
var MENU_WIDTH_VAR = "--dsh-mobile-menu-width";
var MENU_TOP_VAR = "--dsh-mobile-menu-top";
var MENU_BOTTOM_VAR = "--dsh-mobile-menu-bottom";
var MENU_FLIP_ATTR = "data-dsh-mobile-menu-flip";
var MENU_COMFORT_MIN = 100;
var ROW_SELECTOR = "[data-composer-card] > [data-input-scroll] + div";
var MODEL_SELECTOR = `${ROW_SELECTOR} > div:last-of-type > div:has(> button[aria-haspopup="menu"])`;
var TOOLS_SELECTOR = `${ROW_SELECTOR} > div:first-child`;
var MORE_BTN_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="3" cy="8" r="1.5" fill="currentColor"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="13" cy="8" r="1.5" fill="currentColor"/></svg>';
var MENU_MAX_H_CAP = 360;
var MENU_TOP_MARGIN = 12;
var MENU_TRIGGER_GAP = 8;
function clearMenuGeometry() {
  const html = document.documentElement;
  html.style.removeProperty(MENU_MAX_H_VAR);
  html.style.removeProperty(MENU_LEFT_VAR);
  html.style.removeProperty(MENU_WIDTH_VAR);
  html.style.removeProperty(MENU_TOP_VAR);
  html.style.removeProperty(MENU_BOTTOM_VAR);
  html.removeAttribute(MENU_FLIP_ATTR);
}
function isSheetOpen() {
  return document.documentElement.hasAttribute(SHEET_ATTR);
}
function setSheetOpen(open) {
  const el = document.documentElement;
  if (open) el.setAttribute(SHEET_ATTR, "on");
  else el.removeAttribute(SHEET_ATTR);
}
function updateMenuGeometry(preferredRoot) {
  const html = document.documentElement;
  if (!isSheetOpen()) {
    clearMenuGeometry();
    return;
  }
  const activeRoot = preferredRoot ?? document.querySelector(
    `${MODEL_SELECTOR}:has(> button[aria-expanded="true"])`
  );
  if (activeRoot === null) {
    clearMenuGeometry();
    return;
  }
  const cs = getComputedStyle(activeRoot);
  const rect = activeRoot.getBoundingClientRect();
  if (cs.display === "none" || cs.visibility === "hidden" || rect.width <= 0 && rect.height <= 0) {
    clearMenuGeometry();
    return;
  }
  const vv = window.visualViewport;
  const viewTop = vv?.offsetTop ?? 0;
  const viewLeft = vv?.offsetLeft ?? 0;
  const viewWidth = vv?.width ?? window.innerWidth;
  const viewHeight = vv?.height ?? window.innerHeight;
  const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
  const menuBottomY = rect.top - MENU_TRIGGER_GAP;
  const available = Math.floor(menuBottomY - (viewTop + MENU_TOP_MARGIN));
  html.style.setProperty(MENU_LEFT_VAR, `${Math.round(viewLeft + MENU_TOP_MARGIN)}px`);
  html.style.setProperty(
    MENU_WIDTH_VAR,
    `${Math.max(1, Math.floor(viewWidth - MENU_TOP_MARGIN * 2))}px`
  );
  if (available >= MENU_COMFORT_MIN) {
    html.removeAttribute(MENU_FLIP_ATTR);
    html.style.setProperty(MENU_TOP_VAR, "auto");
    html.style.setProperty(
      MENU_BOTTOM_VAR,
      `${Math.max(0, Math.round(layoutHeight - menuBottomY))}px`
    );
    html.style.setProperty(MENU_MAX_H_VAR, `${Math.min(MENU_MAX_H_CAP, available)}px`);
    return;
  }
  html.setAttribute(MENU_FLIP_ATTR, "on");
  html.style.setProperty(MENU_TOP_VAR, `${Math.round(viewTop + MENU_TOP_MARGIN)}px`);
  html.style.setProperty(MENU_BOTTOM_VAR, "auto");
  html.style.setProperty(
    MENU_MAX_H_VAR,
    `${Math.max(1, Math.min(MENU_MAX_H_CAP, Math.floor(viewHeight - MENU_TOP_MARGIN * 2)))}px`
  );
}
function createInputSheetEnhance() {
  let disposed = false;
  let observer = null;
  let raf = 0;
  let geoRaf = 0;
  const insideSheetClicks = /* @__PURE__ */ new WeakSet();
  const scheduleMenuGeometry = () => {
    if (disposed || geoRaf !== 0) return;
    geoRaf = requestAnimationFrame(() => {
      geoRaf = 0;
      if (!disposed) updateMenuGeometry();
    });
  };
  const ensureButton = () => {
    if (disposed) return;
    const rows = document.querySelectorAll(ROW_SELECTOR);
    for (const row of rows) {
      if (row.querySelector(`.${MORE_BTN_CLASS}`) !== null) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = MORE_BTN_CLASS;
      btn.setAttribute("aria-label", "\u66F4\u591A\u64CD\u4F5C");
      btn.setAttribute("aria-haspopup", "true");
      btn.setAttribute("aria-expanded", isSheetOpen() ? "true" : "false");
      btn.innerHTML = MORE_BTN_SVG;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const next = !isSheetOpen();
        setSheetOpen(next);
        document.querySelectorAll(`.${MORE_BTN_CLASS}`).forEach((el) => {
          el.setAttribute("aria-expanded", next ? "true" : "false");
        });
        scheduleMenuGeometry();
      });
      row.appendChild(btn);
    }
    if (isSheetOpen()) scheduleMenuGeometry();
  };
  const scheduleEnsure = () => {
    if (disposed || raf !== 0) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!disposed) ensureButton();
    });
  };
  const onDocClickCapture = (e) => {
    if (!isSheetOpen()) return;
    let modelRoot;
    const inside = e.composedPath().some((node) => {
      if (!(node instanceof Element)) return false;
      if (node.classList.contains(MORE_BTN_CLASS)) return true;
      if (node.matches('[role="menu"], [role="listbox"], [role="dialog"]')) return true;
      if (node.matches(TOOLS_SELECTOR)) return true;
      if (node.matches(MODEL_SELECTOR)) {
        modelRoot = node;
        return true;
      }
      return false;
    });
    if (inside) insideSheetClicks.add(e);
    if (modelRoot !== void 0) updateMenuGeometry(modelRoot);
  };
  const onDocClick = (e) => {
    if (!isSheetOpen()) return;
    if (insideSheetClicks.has(e)) {
      scheduleMenuGeometry();
      return;
    }
    const target = e.target;
    if (target === null) return;
    const el = target instanceof Element ? target : target.parentElement;
    if (el === null) return;
    if (el.closest(`.${MORE_BTN_CLASS}`) !== null) return;
    for (const tools of document.querySelectorAll(TOOLS_SELECTOR)) {
      if (tools.contains(target)) return;
    }
    for (const model of document.querySelectorAll(MODEL_SELECTOR)) {
      if (model.contains(target)) return;
    }
    if (el.closest('[role="menu"], [role="listbox"], [role="dialog"]') !== null) return;
    setSheetOpen(false);
    document.querySelectorAll(`.${MORE_BTN_CLASS}`).forEach((b) => {
      b.setAttribute("aria-expanded", "false");
    });
    scheduleMenuGeometry();
  };
  const onViewportChange = () => {
    if (isSheetOpen()) scheduleMenuGeometry();
  };
  ensureButton();
  observer = new MutationObserver(scheduleEnsure);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("click", onDocClickCapture, true);
  document.addEventListener("click", onDocClick);
  window.addEventListener("resize", onViewportChange);
  window.visualViewport?.addEventListener("resize", onViewportChange);
  window.visualViewport?.addEventListener("scroll", onViewportChange);
  return () => {
    disposed = true;
    if (raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (geoRaf !== 0) {
      cancelAnimationFrame(geoRaf);
      geoRaf = 0;
    }
    if (observer !== null) observer.disconnect();
    document.removeEventListener("click", onDocClickCapture, true);
    document.removeEventListener("click", onDocClick);
    window.removeEventListener("resize", onViewportChange);
    window.visualViewport?.removeEventListener("resize", onViewportChange);
    window.visualViewport?.removeEventListener("scroll", onViewportChange);
    document.documentElement.removeAttribute(SHEET_ATTR);
    clearMenuGeometry();
    document.querySelectorAll(`.${MORE_BTN_CLASS}`).forEach((btn) => {
      btn.parentElement?.removeChild(btn);
    });
  };
}

// src/client/index.ts
var NS = "memory-evolve";
var zh = {
  "tab.label": "\u6280\u80FD\u7BA1\u7406\u5668",
  "tab.label.alt": "\u6280\u80FD\u7BA1\u7406\u5668",
  "header.title": "\u6280\u80FD\u7BA1\u7406\u5668",
  "header.subtitle": "\u7BA1\u7406\u5168\u90E8\u6280\u80FD \xB7 \u81EA\u5B9A\u4E49\u76EE\u5F55 \xB7 \u7981\u7528/\u542F\u7528 \xB7 \u67E5\u770B\u4E0E\u7F16\u8F91",
  "search.placeholder": "\u641C\u7D22\u6280\u80FD\u540D\u79F0\u3001\u63CF\u8FF0\u6216\u9002\u7528\u573A\u666F\u2026",
  "search.empty": "\u6CA1\u6709\u5339\u914D\u7684\u6280\u80FD",
  "filter.all": "\u5168\u90E8",
  "status.enabled": "\u53EF\u7528",
  "disable": "\u7981\u7528",
  "enable": "\u542F\u7528",
  "disabled.badge": "\u5DF2\u7981\u7528",
  "disabled.hint": "\u5DF2\u7981\u7528\uFF1A\u4E0D\u4F1A\u51FA\u73B0\u5728\u6A21\u578B\u7684\u6280\u80FD\u76EE\u5F55\u4E2D",
  "protected.badge": "\u7CFB\u7EDF",
  "protected.hint": "\u7CFB\u7EDF\u6280\u80FD\uFF08project \u6765\u6E90\uFF09\uFF0C\u4E0D\u53EF\u7981\u7528",
  "toggle.failed": "\u64CD\u4F5C\u5931\u8D25\uFF1A{message}",
  "manage.dirs": "\u7BA1\u7406\u81EA\u5B9A\u4E49\u6280\u80FD\u76EE\u5F55",
  "dirs.title": "\u81EA\u5B9A\u4E49\u6280\u80FD\u76EE\u5F55",
  "dirs.help": "\u6DFB\u52A0\u5305\u542B\u6280\u80FD\u7684\u76EE\u5F55\uFF08\u652F\u6301 <\u76EE\u5F55>/<\u6280\u80FD>/SKILL.md \u6216 <\u76EE\u5F55>/<\u6280\u80FD>.md \u5E03\u5C40\uFF09\u3002\u76EE\u5F55\u6C38\u4E45\u4FDD\u5B58\u5728\u63D2\u4EF6 state.json\uFF0C\u91CD\u542F\u540E\u81EA\u52A8\u52A0\u8F7D\uFF1B\u4E0E\u5DF2\u6709\u6280\u80FD\u6839\u76EE\u5F55\u91CD\u53E0\u7684\u8DEF\u5F84\u4F1A\u88AB\u62D2\u7EDD\u3002",
  "dirs.placeholder": "\u8F93\u5165\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u5982 ~/.hermes/skills/\u2026",
  "dirs.add": "\u6DFB\u52A0",
  "dirs.remove": "\u79FB\u9664",
  "dirs.empty": "\u8FD8\u6CA1\u6709\u81EA\u5B9A\u4E49\u76EE\u5F55",
  "dirs.missing": "\u76EE\u5F55\u4E0D\u5B58\u5728",
  "pager.prev": "\u4E0A\u4E00\u9875",
  "pager.next": "\u4E0B\u4E00\u9875",
  "pager.page": "{page} / {total} \u9875",
  "skills.count": "{count} \u4E2A\u6280\u80FD",
  "roots.count": "{count} \u4E2A\u76EE\u5F55",
  "pane.skills": "\u6280\u80FD",
  "pane.files": "\u6587\u4EF6",
  "pane.editor": "\u7F16\u8F91",
  "no.skill.selected": "\u4ECE\u5DE6\u4FA7\u9009\u62E9\u4E00\u4E2A\u6280\u80FD\u5F00\u59CB\u6D4F\u89C8",
  "no.root": "\u8BE5\u6280\u80FD\u6CA1\u6709\u53EF\u6D4F\u89C8\u7684\u672C\u5730\u76EE\u5F55",
  "no.entries": "\u7A7A\u76EE\u5F55",
  "no.file": "\u9009\u62E9\u4E00\u4E2A\u6587\u672C\u6587\u4EF6\u67E5\u770B\u6216\u7F16\u8F91",
  "not.text": "\u4E0D\u662F\u6587\u672C\u6587\u4EF6\uFF0C\u65E0\u6CD5\u9884\u89C8",
  "too.large": "\u6587\u4EF6\u8D85\u8FC7\u8BFB\u53D6\u4E0A\u9650\uFF08512 KiB\uFF09",
  "read.failed": "\u8BFB\u53D6\u5931\u8D25\uFF1A{message}",
  "write.failed": "\u4FDD\u5B58\u5931\u8D25\uFF1A{message}",
  "save": "\u4FDD\u5B58",
  "saving": "\u4FDD\u5B58\u4E2D\u2026",
  "saved": "\u5DF2\u4FDD\u5B58",
  "edit": "\u7F16\u8F91",
  "cancel": "\u53D6\u6D88",
  "discard": "\u653E\u5F03",
  "dirty.hint": "\u6709\u672A\u4FDD\u5B58\u7684\u4FEE\u6539",
  "readonly": "\u53EA\u8BFB",
  "bytes": "{size} B",
  "kib": "{size} KiB",
  "mib": "{size} MiB",
  "dir.up": "\u4E0A\u7EA7\u76EE\u5F55",
  "open.folder": "\u6253\u5F00\u76EE\u5F55",
  "source.badge": "{source}",
  "invocable": "\u53EF\u8C03\u7528",
  "when.to.use": "\u9002\u7528\u573A\u666F",
  "description": "\u63CF\u8FF0",
  "resource.directory": "\u76EE\u5F55",
  "resource.url": "\u94FE\u63A5",
  "resource.opaque": "\u8D44\u6E90",
  "refresh": "\u5237\u65B0",
  "loading.skills": "\u6B63\u5728\u52A0\u8F7D\u6280\u80FD\u2026",
  "loading.dir": "\u52A0\u8F7D\u4E2D\u2026",
  "tree.collapse": "\u6298\u53E0",
  "tree.expand": "\u5C55\u5F00",
  "path": "\u8DEF\u5F84",
  "root.label": "\u76EE\u5F55",
  "editor.placeholder": "\u5728\u5DE6\u4FA7\u6587\u4EF6\u6811\u4E2D\u9009\u62E9\u4E00\u4E2A\u6587\u672C\u6587\u4EF6\u5F00\u59CB\u7F16\u8F91\u3002",
  "status.ready": "\u5C31\u7EEA",
  "status.skill": "\u6280\u80FD",
  "status.file": "\u6587\u4EF6",
  "status.unsaved": "\u672A\u4FDD\u5B58",
  "status.saved": "\u5DF2\u4FDD\u5B58",
  "confirm.discard.title": "\u653E\u5F03\u672A\u4FDD\u5B58\u7684\u4FEE\u6539\uFF1F",
  "confirm.discard.body": "\u4F60\u5BF9 {name} \u7684\u4FEE\u6539\u5C1A\u672A\u4FDD\u5B58\uFF0C\u5207\u6362\u6587\u4EF6\u5C06\u4E22\u5931\u8FD9\u4E9B\u4FEE\u6539\u3002",
  "confirm.discard.ok": "\u653E\u5F03\u4FEE\u6539",
  "mtime.label": "\u4FEE\u6539\u4E8E {time}",
  "open.in.new.tab": "\u5728\u65B0\u6807\u7B7E\u9875\u6253\u5F00",
  "preview": "\u9884\u89C8",
  "memoryTab.label": "\u8BB0\u5FC6",
  "memoryTab.label.pending": "\u{1F534} \u8BB0\u5FC6 ({count})",
  "skillsTab.label": "\u6280\u80FD",
  "skillsTab.label.pending": "\u{1F534} \u6280\u80FD ({count})",
  "todosTab.label": "\u5F85\u529E",
  "todosTab.label.pending": "\u{1F534} \u5F85\u529E ({count})",
  "coiTab.label": "COI\u8C03\u5EA6",
  "coiTab.label.pending": "\u{1F534} COI\u8C03\u5EA6 ({count})",
  "broadcastTab.label": "\u4F1A\u8BDD\u5E7F\u64AD",
  "broadcast.tab.guide": "\u6307\u5357",
  "broadcast.tab.messages": "\u6D88\u606F",
  "broadcast.tab.rooms": "\u623F\u95F4",
  "broadcast.tab.settings": "\u8BBE\u7F6E",
  "broadcast.settings.wsCoord.title": "\u5DE5\u4F5C\u533A\u534F\u8C03\uFF08ws-coord\uFF09",
  "broadcast.settings.wsCoord.desc": '\u540C\u5DE5\u4F5C\u533A\u591A\u4F1A\u8BDD\u5E76\u884C\u65F6\u7684\u8D44\u6E90\u5360\u7528\u534F\u8C03\u2014\u2014\u58F0\u660E\u8981\u6539\u7684\u6587\u4EF6\uFF08de_ws_declare\uFF09\u3001\u5199\u540E\u81EA\u52A8\u767B\u8BB0\u5360\u7528\u3001\u5199\u524D\u51B2\u7A81\u68C0\u6D4B\uFF08\u8F6F\u6A21\u5F0F\u8B66\u544A / \u786C\u62E6\u622A\u53EF\u5207\u6362\uFF09\u3001de_ws_status \u67E5\u770B"\u8C01\u5728\u8DD1\u3001\u5728\u5E72\u4EC0\u4E48"\u3002\u4EE5\u4E0B\u5F00\u5173\u53EA\u63A7\u5236\u672C\u5B50\u529F\u80FD\uFF1B\u300C\u4F1A\u8BDD\u5E7F\u64AD\u300D\u5927\u5F00\u5173\u5728\u300CMemory Evolve \u8BBE\u7F6E\u300D\u2192\u300C\u914D\u7F6E\u300D\u91CC\u3002',
  "broadcast.settings.wsCoord.enabled": "\u542F\u7528\u5DE5\u4F5C\u533A\u534F\u8C03",
  "broadcast.settings.wsCoord.enabled.hint": "\u6CE8\u518C de_ws_declare / de_ws_status / de_ws_release \u5DE5\u5177 + \u5199\u524D\u51B2\u7A81\u68C0\u6D4B\u4E8B\u4EF6\u76D1\u542C + \u6D3B\u52A8\u611F\u77E5\u5FEB\u7167\u6BB5\u3002\u4F9D\u8D56\u300C\u4F1A\u8BDD\u5E7F\u64AD\u300D\u5927\u5F00\u5173\uFF08\u5E7F\u64AD\u5173\u95ED\u65F6\u672C\u529F\u80FD\u4E0D\u53EF\u7528\uFF09\u3002\u9ED8\u8BA4\u5173\u95ED",
  "broadcast.settings.wsCoord.snapshot": "\u6D3B\u52A8\u5FEB\u7167\u6BB5",
  "broadcast.settings.wsCoord.snapshot.hint": "\u5DE5\u4F5C\u533A\u6D3B\u8DC3\u4F1A\u8BDD \u22652 \u65F6\uFF0C\u6BCF\u56DE\u5408\u5FEB\u7167\u6CE8\u5165\u4E00\u884C\u3010\u5DE5\u4F5C\u533A\u6D3B\u52A8\u3011\uFF08\u5E26\u5F53\u524D\u65F6\u95F4\uFF0C\u542B\u5404\u4F1A\u8BDD\u5728\u505A\u4EC0\u4E48\uFF09\uFF1B0~1 \u4E2A\u4F1A\u8BDD\u65F6\u96F6\u5F00\u9500",
  "broadcast.settings.wsCoord.enforce": "\u786C\u62E6\u622A\u6A21\u5F0F",
  "broadcast.settings.wsCoord.enforce.hint": "\u9ED8\u8BA4\u5173\uFF08\u8F6F\u6A21\u5F0F\uFF1A\u5148\u4FE1\u4EFB AI\uFF0C\u51B2\u7A81\u53EA\u8B66\u544A\u4E0D\u62E6\u622A\uFF09\uFF1B\u6253\u5F00\u540E\u5347\u7EA7\u4E3A\u786C\u62E6\u622A\u2014\u2014\u5199\u5165\u4ED6\u4EBA\u5360\u7528\u4E2D\u7684\u6587\u4EF6\u4F1A\u88AB\u5DE5\u5177\u5C42\u76F4\u63A5\u62D2\u7EDD\uFF08deny\uFF09\uFF0CAI \u770B\u5230\u62D2\u7EDD\u539F\u56E0\u81EA\u4E3B\u8C03\u6574",
  "broadcast.guide.intro.title": "\u4F1A\u8BDD\u5E7F\u64AD\u662F\u4EC0\u4E48",
  "broadcast.guide.intro.body": "\u4F1A\u8BDD\u5E7F\u64AD = DSH \u4F1A\u8BDD\u4E4B\u95F4\u7684\u6D88\u606F\u901A\u9053\uFF1A\u7ED9\u5176\u4ED6\u4F1A\u8BDD\u53D1\u6D88\u606F\uFF08AI \u7528 de_broadcast send \u53D1\u9001\uFF09\uFF0C\u5BF9\u65B9\u4E0B\u6B21\u751F\u6210\u524D\u5FEB\u7167\u81EA\u52A8\u51FA\u73B0\u300C\u4F1A\u8BDD\u5E7F\u64AD\u300D\u63D0\u793A\uFF1B\u6D88\u606F\u6309\u6536\u4EF6\u7BB1\u7BA1\u7406\u2014\u2014\u4E3B\u9898 + \u7B80\u4ECB\uFF0C\u5168\u5458\u5DF2\u8BFB\u540E\u81EA\u52A8\u5220\u9664\u3002",
  "broadcast.guide.send.title": "\u600E\u4E48\u53D1\u6D88\u606F",
  "broadcast.guide.send.body": "\u76F4\u63A5\u5BF9 AI \u8BF4\u300C\u7ED9 XX \u4F1A\u8BDD\u53D1\u5E7F\u64AD\u2026\u300D\u5373\u53EF\uFF08\u9ED8\u8BA4\u4E00\u5BF9\u4E00\uFF0C\u6536\u4EF6\u4EBA=\u5BF9\u65B9\u7684\u4F1A\u8BDD ID\uFF09\uFF1A",
  "broadcast.guide.send.item1": "\u4E00\u5BF9\u4E00\uFF1A\u6307\u5B9A\u63A5\u6536\u65B9\u4F1A\u8BDD ID\uFF08\u628A\u300C\u590D\u5236\u4F1A\u8BDD ID\u300D\u7684\u7ED3\u679C\u53D1\u7ED9\u5BF9\u65B9\uFF0C\u5BF9\u65B9 AI \u5C31\u80FD\u7ED9\u4F60\u53D1\uFF09\uFF1B",
  "broadcast.guide.send.item2": "\u623F\u95F4\uFF1A\u591A\u4EBA\u804A\u5929\u5BA4\uFF0C\u8DE8\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u6210\u5458\u90FD\u80FD\u770B\u5230\uFF08\u53D1\u9001\u7ED9 room:<\u623F\u95F4id>\uFF09\uFF1B",
  "broadcast.guide.send.item3": "\u9879\u76EE\uFF1A\u8BE5\u5DE5\u4F5C\u76EE\u5F55\u5185\u6240\u6709\u4F1A\u8BDD\u53EF\u89C1\uFF08\u53D1\u9001\u7ED9 project:/\u7EDD\u5BF9\u8DEF\u5F84\uFF09\u3002",
  "broadcast.guide.inbox.title": "\u6536\u4EF6\u7BB1\uFF08\u6D88\u606F\u9875\uFF09",
  "broadcast.guide.inbox.body": "\u6D88\u606F\u5217\u8868\u9ED8\u8BA4\u53EA\u770B**\u672A\u8BFB**\u7684\u975E\u623F\u95F4\u6D88\u606F\uFF08\u5DF2\u8BFB\u81EA\u52A8\u9690\u85CF\uFF1B\u623F\u95F4\u6D88\u606F\u8FDB\u5BF9\u5E94\u623F\u95F4\u67E5\u770B\uFF09\uFF1A",
  "broadcast.guide.inbox.item1": "\u7B5B\u9009\uFF1A\u672A\u8BFB / \u5168\u90E8 / \u5DF2\u8BFB\uFF1B\u641C\u7D22\u4E3B\u9898\u3001\u53D1\u4EF6\u4EBA\u3001\u5185\u5BB9\uFF1B\u5206\u9875 20 \u6761/\u9875\uFF1B",
  "broadcast.guide.inbox.item2": "\u70B9\u300C\u5C55\u5F00\u5168\u6587\u300D\u770B\u5B8C\u6574\u5185\u5BB9\uFF1B\u7EA2\u8272\u300C\u5220\u9664\u300D= \u8D85\u7BA1\u5220\u9664\uFF08\u5BF9\u6240\u6709\u4EBA\u4E0D\u53EF\u89C1\uFF09\uFF1B",
  "broadcast.guide.inbox.item3": "\u4E00\u5BF9\u4E00\u6D88\u606F\u5168\u90E8\u63A5\u6536\u65B9\u5DF2\u8BFB\u540E\u81EA\u52A8\u5220\u9664\uFF08\u5DF2\u6D88\u8D39\uFF0C\u4E0D\u5360\u5217\u8868\uFF09\u3002",
  "broadcast.guide.room.title": "\u623F\u95F4\u9875",
  "broadcast.guide.room.body": "\u623F\u95F4 = \u591A\u4EBA\u534F\u4F5C\u804A\u5929\u5BA4\uFF1A",
  "broadcast.guide.room.item1": "\u5C55\u5F00\u623F\u95F4\u770B\u6210\u5458\u5728\u7EBF\u72B6\u6001\uFF1A\u{1F7E2} running=\u6B63\u5728\u751F\u6210\uFF08\u53EF\u7B49\u5B83/\u5B83\u56DE\u5408\u5185\u53EF\u89C1\uFF09\uFF0C\u26AA idle/unknown=\u5DF2\u7ED3\u675F\u56DE\u5408\u6216\u672A\u8BB0\u5F55\uFF08\u4E0D\u8981\u50BB\u7B49\uFF09\uFF1B",
  "broadcast.guide.room.item2": "\u623F\u95F4\u6D88\u606F\u4E0E\u6536\u4EF6\u7BB1\u540C\u6B3E\u7B5B\u9009/\u641C\u7D22/\u5206\u9875\uFF1B\u521B\u5EFA\u8005\u53EF\u8E22\u4EBA\u3001\u89E3\u6563\u623F\u95F4\uFF08\u89E6\u53D1\u7CFB\u7EDF\u901A\u77E5\uFF09\uFF1B",
  "broadcast.guide.room.item3": "\u5DF2\u89E3\u6563\u623F\u95F4\u4FDD\u7559\u8BB0\u5F55\u53EF\u8FFD\u6EAF\uFF0C\u6210\u5458\u4E0D\u80FD\u518D\u52A0\u5165/\u53D1\u6D88\u606F\u3002",
  "broadcast.guide.alias.title": "\u4F1A\u8BDD\u522B\u540D",
  "broadcast.guide.alias.body": "\u7ED9\u4F1A\u8BDD\u8BBE\u7F6E\u53CB\u597D\u540D\uFF08\u226410 \u5B57\uFF09\u2014\u2014\u5FEB\u7167\u3001\u5217\u8868\u3001\u6D88\u606F\u91CC\u90FD\u663E\u793A\u522B\u540D\uFF08\u77EDID\uFF09\uFF0C\u4E00\u773C\u8BA4\u51FA\u662F\u8C01\uFF1A",
  "broadcast.guide.alias.item1": "\u9876\u90E8\u300C\u6211\u7684\u4F1A\u8BDD\u300D\u884C\uFF1A\u590D\u5236\u4F1A\u8BDD ID / \u590D\u5236\u522B\u540D\uFF0C\u628A\u7ED3\u679C\u53D1\u7ED9\u5BF9\u65B9\u5C31\u80FD\u5F00\u804A\uFF1B",
  "broadcast.guide.alias.item2": "\u4F1A\u8BDD\u9875\u53F3\u4E0A\u89D2 \u29C9 \u590D\u5236\u4F1A\u8BDDID / \u270E \u522B\u540D \u6309\u94AE\u4E5F\u53EF\u8BBE\u7F6E\u3002",
  "broadcast.guide.switch.title": "\u5F00\u5173",
  "broadcast.guide.switch.body": "\u4F1A\u8BDD\u5E7F\u64AD\u9ED8\u8BA4\u5173\u95ED\uFF1A\u5728\u300C\u8BBE\u7F6E\u300DTab \u7684\u300C\u914D\u7F6E\u300D\u91CC\u6253\u5F00\u300C\u4F1A\u8BDD\u5E7F\u64AD\u300D\u5F00\u5173\uFF0C\u5237\u65B0\u540E\u672C Tab \u51FA\u73B0\u3002",
  "broadcast.mySessionId": "\u6211\u7684\u4F1A\u8BDD ID",
  "broadcast.copyId": "\u590D\u5236",
  "broadcast.copied": "\u5DF2\u590D\u5236",
  "broadcast.loading": "\u52A0\u8F7D\u4E2D\u2026",
  "broadcast.refresh": "\u5237\u65B0",
  "broadcast.messages.empty": "\uFF08\u6682\u65E0\u6D88\u606F\uFF09",
  "broadcast.messages.sender": "\u6765\u81EA",
  "broadcast.messages.to": "\u6536\u4EF6\u4EBA",
  "broadcast.messages.direct": "\u79C1\u4FE1",
  "broadcast.messages.room": "\u623F\u95F4",
  "broadcast.messages.project": "\u9879\u76EE",
  "broadcast.messages.unread": "\u672A\u8BFB",
  "broadcast.messages.long": "\u957F\u5185\u5BB9",
  "broadcast.message.expand": "\u5C55\u5F00\u5168\u6587",
  "broadcast.message.collapse": "\u6536\u8D77",
  "broadcast.message.delete": "\u5220\u9664",
  "broadcast.message.deleteConfirm": "\u5220\u9664\u8FD9\u6761\u6D88\u606F\uFF1F\uFF08\u8D85\u7BA1\u64CD\u4F5C\uFF0C\u6D88\u606F\u5BF9\u6240\u6709\u4EBA\u4E0D\u53EF\u89C1\uFF09\n\n{subject}",
  "broadcast.message.deleted": "\u5DF2\u5220\u9664",
  "broadcast.copyAlias": "\u590D\u5236\u522B\u540D",
  "broadcast.msg.unread": "\u672A\u8BFB",
  "broadcast.msg.read": "\u5DF2\u8BFB",
  "broadcast.filter.unread": "\u672A\u8BFB",
  "broadcast.filter.all": "\u5168\u90E8",
  "broadcast.filter.read": "\u5DF2\u8BFB",
  "broadcast.searchPh": "\u641C\u7D22\u4E3B\u9898/\u53D1\u4EF6\u4EBA/\u5185\u5BB9\u2026",
  "broadcast.pagePrev": "\u4E0A\u4E00\u9875",
  "broadcast.pageNext": "\u4E0B\u4E00\u9875",
  "broadcast.pageInfo": "{page}/{total} \u9875",
  "broadcast.room.detail": "\u8BE6\u60C5",
  "broadcast.room.messages": "\u623F\u95F4\u6D88\u606F",
  "broadcast.room.messages.empty": "\uFF08\u6682\u65E0\u623F\u95F4\u6D88\u606F\uFF09",
  "broadcast.messages.roomInRooms": "\u623F\u95F4\u6D88\u606F\u8BF7\u5728\u300C\u623F\u95F4\u300D\u9875\u8FDB\u5165\u5BF9\u5E94\u623F\u95F4\u67E5\u770B",
  "broadcast.rooms.empty": "\uFF08\u6682\u65E0\u623F\u95F4\uFF09",
  "broadcast.roomSearchPh": "\u641C\u7D22\u623F\u95F4\u540D\u2026",
  "broadcast.roomStatus.all": "\u5168\u90E8",
  "broadcast.roomStatus.active": "\u6D3B\u8DC3",
  "broadcast.roomStatus.dissolved": "\u5DF2\u89E3\u6563",
  "broadcast.roomDays.0": "\u5168\u90E8\u65F6\u95F4",
  "broadcast.roomDays.7": "\u6700\u8FD17\u5929",
  "broadcast.roomDays.30": "\u6700\u8FD130\u5929",
  "broadcast.room.status.active": "\u6D3B\u8DC3",
  "broadcast.room.status.idle": "\u7A7A\u95F2",
  "broadcast.room.status.dissolved": "\u5DF2\u89E3\u6563",
  "broadcast.room.online": "{online}/{total} \u5728\u7EBF",
  "broadcast.room.members": "\u6210\u5458",
  "broadcast.room.kick": "\u8E22\u51FA",
  "broadcast.room.kickConfirm": "\u8E22\u51FA\u6210\u5458 {member}\uFF1F\uFF08\u5C06\u53D1\u9001\u7CFB\u7EDF\u901A\u77E5\uFF0C\u8BE5\u4F1A\u8BDD\u5931\u53BB\u623F\u95F4\u8BBF\u95EE\uFF09",
  "broadcast.room.dissolve": "\u89E3\u6563",
  "broadcast.room.dissolveConfirm": "\u89E3\u6563\u623F\u95F4\u300C{name}\u300D\uFF1F\uFF08\u8F6F\u5220\u9664\uFF1A\u8BB0\u5F55\u4FDD\u7559\u53EF\u8FFD\u6EAF\uFF0C\u6210\u5458\u6536\u5230\u7CFB\u7EDF\u901A\u77E5\uFF0C\u4E4B\u540E\u65E0\u6CD5\u52A0\u5165/\u53D1\u6D88\u606F\uFF09",
  "broadcast.room.dissolved": "\u5DF2\u89E3\u6563",
  "broadcast.room.copyId": "\u590D\u5236\u623F\u95F4 id",
  "broadcast.room.lastActive": "\u6700\u540E\u6D3B\u52A8",
  "broadcast.room.created": "\u521B\u5EFA\u4E8E",
  "broadcast.room.presence.unknown": "unknown \xB7 \u65E0\u6D3B\u52A8\u8BB0\u5F55",
  "header.copySessionId": "\u29C9 \u590D\u5236\u4F1A\u8BDDID",
  "header.copySessionId.done": "\u2713 \u5DF2\u590D\u5236",
  "header.copySessionId.title": "\u590D\u5236\u5F53\u524D\u4F1A\u8BDD ID\uFF08\u53D1\u7ED9\u5176\u4ED6\u4F1A\u8BDD\uFF1A\u544A\u8BC9\u5BF9\u65B9 AI \u4F60\u7684\u4F1A\u8BDD ID\uFF0C\u8BA9\u5B83\u7528 de_broadcast \u7ED9\u4F60\u53D1\u5E7F\u64AD\uFF09",
  "header.setAlias": "\u270E \u522B\u540D",
  "header.setAlias.title": "\u8BBE\u7F6E\u4F1A\u8BDD\u522B\u540D\uFF08\u226410 \u5B57\uFF09\u2014\u2014\u5FEB\u7167/\u5E7F\u64AD\u9762\u677F/\u6D88\u606F\u4E2D\u663E\u793A\u4E3A\u4F60\u7684\u53CB\u597D\u540D\u79F0",
  "header.setAlias.placeholder": "\u8F93\u5165\u522B\u540D\uFF08\u226410 \u5B57\uFF09",
  "header.setAlias.save": "\u4FDD\u5B58",
  "header.setAlias.clear": "\u6E05\u9664",
  "header.setAlias.saved": "\u522B\u540D\u5DF2\u4FDD\u5B58",
  "header.setAlias.cleared": "\u522B\u540D\u5DF2\u6E05\u9664",
  "scratchTab.label": "\u4E34\u65F6\u4FE1\u606F",
  "promptTab.label": "\u63D0\u793A\u8BCD\u6CE8\u5165",
  "promptTab.label.active": "\u{1F534} \u63D0\u793A\u8BCD\u6CE8\u5165 ({count})",
  "settingsTab.label": "Memory Evolve \u8BBE\u7F6E",
  "settingsTab.feature.guide": "\u6307\u5357",
  "settingsTab.feature.config": "\u914D\u7F6E",
  "memoryTab.feature.guide": "\u6307\u5357",
  "memoryTab.feature.suggestions": "\u5F85\u786E\u8BA4\u8BB0\u5FC6\u5EFA\u8BAE",
  "skillsTab.feature.guide": "\u6307\u5357",
  "skillsTab.feature.skills": "\u5F85\u786E\u8BA4\u6280\u80FD\u5EFA\u8BAE",
  "skillsTab.feature.skillBrowser": "\u6280\u80FD\u7BA1\u7406",
  "todosTab.feature.guide": "\u6307\u5357",
  "todosTab.feature.todoSuggestions": "\u5F85\u786E\u8BA4\u5F85\u529E\u7BA1\u7406",
  "todosTab.feature.todo": "\u5F85\u529E",
  // 模型配置 Tab（models-hub）：表格展示 DSH 供应商/模型 + 每模型
  // 启用/备注/可用思考等级配置（对应 de_models 工具的 Web 数据面）：
  "modelsTab.label": "\u6A21\u578B\u914D\u7F6E",
  "modelsTab.feature.models": "\u6A21\u578B\u914D\u7F6E",
  "modelsTab.feature.guide": "\u6307\u5357",
  "modelsTab.guide.what.title": "\u6A21\u578B\u914D\u7F6E\u662F\u4EC0\u4E48",
  "modelsTab.guide.what.body": "\u4EE5\u8868\u683C\u5F62\u5F0F\u4E00\u89C8 DSH \u7684\u5168\u90E8\u4F9B\u5E94\u5546\u4E0E\u6A21\u578B\uFF0C\u5E76\u4E3A\u6BCF\u4E2A\u6A21\u578B\u7EF4\u62A4\u63D2\u4EF6\u4FA7\u914D\u7F6E\uFF08\u542F\u7528\u72B6\u6001\u3001\u5907\u6CE8\u3001\u601D\u8003\u7B49\u7EA7\uFF09\u2014\u2014\u6240\u6709\u914D\u7F6E\u5F52\u5C5E\u672C\u63D2\u4EF6\uFF08models.json\uFF09\uFF0C\u4E0D\u4FEE\u6539 DSH \u914D\u7F6E\u3001\u4E0D\u4E0E\u5176\u4ED6\u63D2\u4EF6\u8026\u5408\u3002",
  "modelsTab.guide.what.item1": "\u8868\u683C\u5217\uFF1A\u542F\u7528\u5F00\u5173\u3001\u4F9B\u5E94\u5546\uFF08\u542B DSH \u6FC0\u6D3B\u72B6\u6001\uFF09\u3001\u6A21\u578B\uFF08\u540D\u79F0 + ID\uFF09\u3001\u4E0A\u4E0B\u6587/\u8F93\u51FA\u5BB9\u91CF\u3001\u601D\u8003\u7B49\u7EA7\u3001\u5907\u6CE8\uFF1B\u652F\u6301\u641C\u7D22\u4E0E\u300C\u663E\u793A\u601D\u8003\u7B49\u7EA7\u300D\u5207\u6362\uFF1B",
  "modelsTab.guide.what.item2": "\u6BCF\u6A21\u578B\u53EF\u8BBE\u7F6E\uFF1A\u542F\u7528/\u7981\u7528\uFF08\u63D2\u4EF6\u53E3\u5F84\u7684\u53EF\u7528\u6027\u6807\u8BB0\uFF0C\u4E0D\u6539\u53D8 DSH \u5B9E\u9645\u8DEF\u7531\uFF09\u3001\u5907\u6CE8\u3001\u662F\u5426\u652F\u6301\u601D\u8003\u3001\u53EF\u7528\u601D\u8003\u7B49\u7EA7\u3001\u63A8\u8350\u601D\u8003\u7B49\u7EA7\u3001\u81EA\u5B9A\u4E49\u7B49\u7EA7\uFF1B",
  "modelsTab.guide.what.item3": "\u914D\u7F6E\u5199\u5165\u5373\u6301\u4E45\u5316\uFF08<memoryDir>/models.json\uFF09\uFF0C\u91CD\u542F\u4E0D\u4E22\uFF1B",
  "modelsTab.guide.config.title": "\u6BCF\u6A21\u578B\u914D\u7F6E\u9879",
  "modelsTab.guide.config.body": "\u5C55\u5F00\u4E00\u884C\uFF08\u300C\u914D\u7F6E\u7B49\u7EA7\u300D\uFF09\u5373\u53EF\u7F16\u8F91\u601D\u8003\u76F8\u5173\u914D\u7F6E\uFF1A",
  "modelsTab.guide.config.item1": "\u542F\u7528/\u7981\u7528\uFF1A\u51B3\u5B9A de_models \u5DE5\u5177\u9ED8\u8BA4\u5217\u51FA\u7684\u53EF\u7528\u6A21\u578B\uFF08\u9ED8\u8BA4\u5168\u90E8\u542F\u7528\uFF09\uFF1B",
  "modelsTab.guide.config.item2": "\u652F\u6301\u601D\u8003\uFF1A\u5173\u95ED\u540E\u8BE5\u6A21\u578B\u4E0D\u5141\u8BB8\u601D\u8003\uFF08\u4EC5 off \u7B49\u7EA7\u53EF\u7528\uFF09\uFF1B",
  "modelsTab.guide.config.item3": "\u63A8\u8350\u601D\u8003\u7B49\u7EA7\uFF1A\u9ED8\u8BA4\u300C\u81EA\u52A8\u300D\u8DDF\u968F\u6A21\u578B\u81EA\u8EAB\u63A8\u8350\uFF0C\u53EF\u624B\u52A8\u6307\u5B9A\u4EFB\u4E00\u53EF\u7528\u7B49\u7EA7\uFF1B",
  "modelsTab.guide.config.item4": "\u53EF\u7528\u601D\u8003\u7B49\u7EA7\uFF1A\u52FE\u9009\u54EA\u4E9B\u7B49\u7EA7\u5141\u8BB8\u4F7F\u7528\uFF08\u9ED8\u8BA4\u5168\u90E8\uFF09\uFF1B\u53EF\u6DFB\u52A0\u81EA\u5B9A\u4E49\u7B49\u7EA7\uFF08\u5982 ultra\uFF09\uFF0C\u79FB\u9664\u81EA\u5B9A\u4E49\u7B49\u7EA7\u3002",
  "modelsTab.guide.config.item5": "\u56FE\u7247\u8F93\u5165\u80FD\u529B\uFF1A\u6A21\u578B\u663E\u5F0F\u58F0\u660E\u652F\u6301\u56FE\u7247\u8F93\u5165\u65F6\u663E\u793A\u300C\u{1F5BC} \u56FE\u7247\u8F93\u5165\u300D\u6807\u8BB0\uFF08\u6765\u81EA DSH \u6A21\u578B\u80FD\u529B\u5143\u6570\u636E inputModalities\uFF0C\u53EA\u8BFB\u5C55\u793A\uFF09\uFF1B\u672A\u58F0\u660E=\u672A\u77E5\uFF0C\u4E0D\u663E\u793A\u3002",
  "modelsTab.guide.tool.title": "de_models \u5DE5\u5177\uFF08\u7ED9 AI \u7528\uFF09",
  "modelsTab.guide.tool.body": "\u672C\u6A21\u5757\u540C\u65F6\u6CE8\u518C de_models \u5DE5\u5177\uFF0CAI \u53EF\u4EE5\u76F4\u63A5\u67E5\u8BE2\u5F53\u524D\u53EF\u7528\u6A21\u578B\uFF08\u63A5\u53E3\uFF09\u6E05\u5355\uFF1A",
  "modelsTab.guide.tool.item1": "\u9ED8\u8BA4\u53EA\u8FD4\u56DE\u300C\u542F\u7528\u300D\u7684\u6A21\u578B\uFF08all=true \u67E5\u770B\u5168\u90E8\u542B\u7981\u7528\uFF09\uFF0C\u53EF\u6309\u4F9B\u5E94\u5546\u8FC7\u6EE4\uFF1B",
  "modelsTab.guide.tool.item2": "\u6BCF\u4E2A\u6A21\u578B\u8FD4\u56DE\uFF1A\u662F\u5426\u542F\u7528\u3001DSH \u662F\u5426\u6FC0\u6D3B\u3001\u662F\u5426\u652F\u6301\u56FE\u7247\u8F93\u5165\uFF08supportsImage\uFF1Atrue/false/null=\u672A\u77E5\uFF09\u3001\u662F\u5426\u652F\u6301\u601D\u8003\u3001\u53EF\u7528\u601D\u8003\u7B49\u7EA7\uFF08\u542B\u63A8\u8350\u7B49\u7EA7\u4E0E\u81EA\u5B9A\u4E49\u7B49\u7EA7\uFF09\u3001\u5907\u6CE8\u3002",
  "modelsTab.guide.switch.title": "\u5F00\u5173",
  "modelsTab.guide.switch.body": "\u6A21\u578B\u914D\u7F6E\u9ED8\u8BA4\u5F00\u542F\uFF1B\u53EF\u5728\u300CMemory Evolve \u8BBE\u7F6E\u300DTab \u7684\u300C\u914D\u7F6E\u300D\u91CC\u72EC\u7ACB\u5173\u95ED\uFF08\u4E0E\u5176\u4ED6\u6A21\u5757\u540C\u6B3E\u5F00\u5173\uFF09\u2014\u2014\u5173\u95ED\u540E\u672C Tab \u4E0E de_models \u5DE5\u5177\u9690\u85CF\uFF0C\u914D\u7F6E\u6570\u636E\u4FDD\u7559\u3002",
  "modelsTab.searchPh": "\u641C\u7D22\u4F9B\u5E94\u5546\u3001\u6A21\u578B\u6216\u5907\u6CE8\u2026",
  "modelsTab.showReasoning": "\u663E\u793A\u601D\u8003\u7B49\u7EA7",
  "modelsTab.refresh": "\u5237\u65B0",
  "modelsTab.loading": "\u52A0\u8F7D\u4E2D\u2026",
  "modelsTab.count": "\u5171 {total} \u4E2A\u6A21\u578B \xB7 {enabled} \u4E2A\u542F\u7528",
  "modelsTab.loadFailed": "\u52A0\u8F7D\u5931\u8D25\uFF1A{message}",
  "modelsTab.empty": "\uFF08\u6682\u65E0\u6A21\u578B\uFF09",
  "modelsTab.enabled": "\u542F\u7528",
  "modelsTab.enable": "\u542F\u7528",
  "modelsTab.disable": "\u7981\u7528",
  "modelsTab.provider": "\u4F9B\u5E94\u5546",
  "modelsTab.model": "\u6A21\u578B",
  "modelsTab.capacity": "\u4E0A\u4E0B\u6587/\u8F93\u51FA",
  "modelsTab.reasoning": "\u601D\u8003\u7B49\u7EA7",
  "modelsTab.note": "\u5907\u6CE8",
  "modelsTab.notePh": "\u8F93\u5165\u5907\u6CE8\u2026",
  "modelsTab.dormant": "\u672A\u6FC0\u6D3B",
  "modelsTab.thinking": "\u652F\u6301\u601D\u8003",
  "modelsTab.thinkingHint": "\u5173\u95ED\u540E\u8BE5\u6A21\u578B\u4E0D\u5141\u8BB8\u601D\u8003\uFF08\u4EC5 off \u7B49\u7EA7\u53EF\u7528\uFF09",
  "modelsTab.thinkingOff": "\u4E0D\u652F\u6301\u601D\u8003",
  "modelsTab.supportsImage": "\u{1F5BC} \u56FE\u7247\u8F93\u5165",
  "modelsTab.supportsImageHint": "\u8BE5\u6A21\u578B\u663E\u5F0F\u58F0\u660E\u652F\u6301\u56FE\u7247\u8F93\u5165\uFF08\u6765\u81EA DSH \u6A21\u578B\u80FD\u529B\u5143\u6570\u636E inputModalities\uFF09",
  "modelsTab.recommendedLevel": "\u63A8\u8350\u601D\u8003\u7B49\u7EA7",
  "modelsTab.recommendedAuto": "\u81EA\u52A8\uFF08\u8DDF\u968F\u6A21\u578B\u63A8\u8350\uFF09",
  "modelsTab.levelsNone": "\u5168\u90E8\u7981\u7528",
  "modelsTab.editLevels": "\u914D\u7F6E\u7B49\u7EA7",
  "modelsTab.closeEditor": "\u6536\u8D77",
  "modelsTab.editorTitle": "\u53EF\u7528\u601D\u8003\u7B49\u7EA7\uFF08\u52FE\u9009 = \u5141\u8BB8\u8BE5\u7B49\u7EA7\uFF1B\u63A8\u8350\u6765\u81EA\u6A21\u578B\u80FD\u529B\uFF09",
  "modelsTab.recommended": "\u63A8\u8350",
  "modelsTab.addLevel": "\u6DFB\u52A0",
  "modelsTab.removeLevel": "\u79FB\u9664",
  "modelsTab.levelIdPh": "\u7B49\u7EA7 ID\uFF08\u5982 ultra\uFF09",
  "modelsTab.levelNamePh": "\u663E\u793A\u540D\uFF08\u5982 Ultra\uFF09",
  "modelsTab.save": "\u4FDD\u5B58",
  "modelsTab.saving": "\u4FDD\u5B58\u4E2D\u2026",
  "modelsTab.cancel": "\u53D6\u6D88",
  // DSH UI 设置 Tab（ui-settings-hub）：「综合」= 各功能独立小开关（用户
  // 拍板：功能未定型前不精确分类，统一收「综合」）；「指南」= 精简简介
  // （用户拍板：不细讲每个小功能怎么用）。真正的功能注入是全局 DOM 增强
  // （session-filter.ts / wide-chat.ts），开关经事件广播由 apply 同步，
  // 不依赖本 Tab 打开。
  "uiSettingsTab.label": "DSH UI \u8BBE\u7F6E",
  "uiSettingsTab.feature.mixed": "\u7EFC\u5408",
  "uiSettingsTab.feature.guide": "\u6307\u5357",
  "uiSettingsTab.features.title": "\u529F\u80FD\u5F00\u5173",
  "uiSettingsTab.features.help": "\u6BCF\u4E2A\u529F\u80FD\u90FD\u6709\u72EC\u7ACB\u7684\u5C0F\u5F00\u5173\uFF0C**\u9ED8\u8BA4\u5168\u90E8\u5173\u95ED**\u3001\u7531\u4F60\u4E3B\u52A8\u5F00\u542F\uFF0C\u6539\u52A8\u5373\u65F6\u751F\u6548\uFF08\u529F\u80FD\u672A\u5B9A\u578B\u524D\u7EDF\u4E00\u6536\u5728\u300C\u7EFC\u5408\u300D\uFF0C\u540E\u7EED\u518D\u5206\u7C7B\uFF09\u3002",
  "uiSettingsTab.guide.what.title": "DSH UI \u8BBE\u7F6E\u662F\u4EC0\u4E48",
  "uiSettingsTab.guide.what.body": "\u7ED9 DSH web \u754C\u9762\u505A\u6837\u5F0F\u7EA7\u7684\u5C0F\u529F\u80FD\u2014\u2014\u4E0D\u6539\u6846\u67B6\u6E90\u7801\uFF0C\u7EAF\u5BA2\u6237\u7AEF\u6CE8\u5165\uFF08CSS + DOM \u589E\u5F3A\uFF09\uFF0C\u968F DSH \u66F4\u65B0\u4E0D\u6389\u529F\u80FD\uFF1B\u540E\u671F\u6269\u5C55\uFF08\u4E3B\u9898\u66F4\u6362\u7B49\uFF09\u90FD\u6536\u8FDB\u672C\u6A21\u5757\u3002",
  "uiSettingsTab.guide.switch.title": "\u5F00\u5173",
  "uiSettingsTab.guide.switch.body": "\u6A21\u5757\u5F00\u5173\u5728\u300CMemory Evolve \u8BBE\u7F6E\u300DTab \u7684\u300C\u914D\u7F6E\u300D\u91CC\uFF08\u9ED8\u8BA4\u5173\u95ED\uFF09\uFF1B\u672C Tab\u300C\u7EFC\u5408\u300D\u91CC\u662F\u5404\u529F\u80FD\u7684\u72EC\u7ACB\u5C0F\u5F00\u5173\uFF08\u9ED8\u8BA4\u4E5F\u5168\u90E8\u5173\u95ED\uFF0C\u7531\u4F60\u4E3B\u52A8\u5F00\u542F\uFF09\u3002",
  // 功能开关行文案（「综合」子 tab 渲染）。
  "uiSettings.feature.sessionFilter": "\u4F1A\u8BDD\u7B5B\u9009",
  "uiSettings.feature.sessionFilter.hint": "\u5DE6\u4FA7\u4F1A\u8BDD\u5217\u8868\u53EA\u663E\u793A\u8FDB\u884C\u4E2D\u7684\u4F1A\u8BDD\uFF08\u7EAF idle \u6298\u53E0\uFF0C\u53EF\u4E00\u952E\u5207\u56DE\u5168\u90E8\uFF09\uFF1B\u5F00\u542F\u540E\u624D\u51FA\u73B0\u7B5B\u9009\u6761",
  "uiSettings.feature.wideChat": "\u5BF9\u8BDD\u533A\u52A0\u5BBD",
  "uiSettings.feature.wideChat.hint": "\u628A\u4E2D\u95F4\u7684\u5BF9\u8BDD\u5386\u53F2/\u8F93\u5165\u6846\u533A\u57DF\u4ECE\u7EA6\u4E00\u534A\u5BBD\u5EA6\u6269\u5927\u5230\u53F3\u4FA7\u7EA6 95%\uFF08\u4E0E\u4E0A\u65B9 Tab \u5BFC\u822A\u6761\u5BF9\u9F50\uFF09",
  "uiSettings.feature.wideBubble": "\u6D88\u606F\u6C14\u6CE1\u52A0\u5BBD",
  "uiSettings.feature.wideBubble.hint": "\u7528\u6237\u63D0\u4EA4\u540E\u7684\u6D88\u606F\u6846\u4ECE\u9ED8\u8BA4\u4E0A\u9650 525px \u6269\u5927\u5230\u5360\u4E2D\u95F4\u5185\u5BB9\u6846\u7EA6 80%\uFF08\u914D\u5408\u300C\u5BF9\u8BDD\u533A\u52A0\u5BBD\u300D\u6548\u679C\u66F4\u660E\u663E\uFF09",
  "uiSettings.feature.contextWarn": "\u4E0A\u4E0B\u6587\u5360\u7528\u63D0\u9192",
  "uiSettings.feature.contextWarn.hint": "\u8F93\u5165\u6846\u53F3\u4E0B\u4FA7\u7684\u4E0A\u4E0B\u6587\u4F7F\u7528\u91CF\u5706\u73AF\uFF1A\u5360\u7528\u8D85\u8FC7 30% \u53D8\u9EC4\u3001\u8D85\u8FC7 40% \u53D8\u7EA2\u63D0\u9192\uFF0C\u4F4E\u4E8E\u9608\u503C\u6062\u590D\u539F\u8272",
  "uiSettings.feature.mermaidRender": "Mermaid \u56FE\u8868\u6E32\u67D3",
  "uiSettings.feature.mermaidRender.hint": "\u628A\u6D88\u606F\u91CC\u7684 mermaid \u4EE3\u7801\u5757\u6E32\u67D3\u6210\u56FE\u8868\uFF08DSH \u754C\u9762\u672C\u8EAB\u4E0D\u6E32\u67D3 mermaid\uFF09\uFF1B\u9996\u6B21\u89C1\u5230\u56FE\u65F6\u624D\u52A0\u8F7D\u6E32\u67D3\u5F15\u64CE\uFF0CPC \u4E0E\u624B\u673A\u7AEF\u540C\u65F6\u751F\u6548\uFF0C\u6E32\u67D3\u5931\u8D25\u81EA\u52A8\u9000\u56DE\u4EE3\u7801\u5757",
  // 筛选条按钮文案（session-filter.ts 注入 DOM 用）。
  "uiSettings.filter.on": "\u4EC5\u8FDB\u884C\u4E2D",
  "uiSettings.filter.off": "\u5168\u90E8",
  "uiSettings.running.label": "{count} \u8FD0\u884C\u4E2D",
  "uiSettings.ungrouped": "\u672A\u5206\u7EC4",
  // 会话书签（独立子模块，bookmarkEnabled 默认关）：
  "bookmarkTab.label": "\u4E66\u7B7E",
  "bookmark.tab.list": "\u5217\u8868",
  "bookmark.tab.guide": "\u6307\u5357",
  "bookmark.list.title": "\u672C\u4F1A\u8BDD\u4E66\u7B7E",
  "bookmark.list.help": "\u70B9\u51FB\u4E66\u7B7E\u8DF3\u8F6C\u5230\u5BF9\u5E94\u8F6E\u6B21\uFF1B\u8F6E\u5C3E \u2606 \u6253\u661F\u3001\u2605 \u5DF2\u6253\u661F\uFF08\u53EF\u6539\u540D/\u5220\u9664\uFF09\uFF1B\u5217\u8868\u53EF\u641C\u7D22\u3001\u53EF\u4ECE\u6B64\u8F6E\u521B\u5EFA\u5206\u652F\uFF08\u4E2D\u95F4\u8F6E\u7684\u5B98\u65B9\u5206\u652F\u6309\u94AE\u540C\u6837\u5DF2\u88AB Memory Evolve \u63A5\u7BA1\uFF09\u3002",
  "bookmark.refresh": "\u5237\u65B0",
  "bookmark.loading": "\u52A0\u8F7D\u4E2D\u2026",
  "bookmark.empty": "\uFF08\u6682\u65E0\u4E66\u7B7E\u2014\u2014\u5728\u5BF9\u8BDD\u8F6E\u5C3E\u70B9 \u2606 \u6253\u661F\uFF09",
  "bookmark.defaultLabel": "\u8F6E\u6B21 {n}",
  "bookmark.turn": "\u8F6E\u6B21 {n}",
  "bookmark.prompt.create": "\u4E66\u7B7E\u540D\u79F0\uFF08\u53EF\u6539\uFF09\uFF1A",
  "bookmark.prompt.rename": "\u65B0\u540D\u79F0\uFF1A",
  "bookmark.confirm.delete": "\u5220\u9664\u4E66\u7B7E\u300C{label}\u300D\uFF1F",
  "bookmark.noSession": "\u65E0\u6CD5\u786E\u5B9A\u5F53\u524D\u4F1A\u8BDD\uFF08\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5\uFF09",
  "bookmark.search.placeholder": "\u641C\u7D22\u4E66\u7B7E\u2026",
  "bookmark.search.empty": "\uFF08\u6CA1\u6709\u5339\u914D\u7684\u4E66\u7B7E\uFF09",
  "bookmark.star.title.off": "\u2606 \u6253\u4E66\u7B7E\uFF08Memory Evolve \u4F1A\u8BDD\u4E66\u7B7E\uFF09",
  "bookmark.star.title.on": "\u2605 \u5DF2\u6253\u4E66\u7B7E\uFF1A{label}\uFF08Memory Evolve\uFF0C\u70B9\u51FB\u6539\u540D/\u5220\u9664\uFF09",
  "bookmark.menu.rename": "\u6539\u540D",
  "bookmark.menu.delete": "\u5220\u9664",
  "bookmark.action.jump": "\u8DF3\u8F6C",
  "bookmark.action.fork": "\u5206\u652F",
  "bookmark.action.rename": "\u6539\u540D",
  "bookmark.action.delete": "\u5220\u9664",
  "bookmark.fork.title": "\u7531\u6B64\u8F6E\u521B\u5EFA\u5206\u652F\uFF08Memory Evolve \u589E\u5F3A\uFF09",
  "bookmark.fork.confirm": "\u5B98\u65B9\u4EC5\u652F\u6301\u4ECE\u6700\u540E\u4E00\u6761\u6D88\u606F\u521B\u5EFA\u5206\u652F\u3002\u662F\u5426\u4ECD\u8981\u4ECE\u8FD9\u4E00\u8F6E\uFF08seq {n}\uFF09\u521B\u5EFA\u5206\u652F\uFF1F\uFF08Memory Evolve \u589E\u5F3A\uFF09",
  "bookmark.fork.working": "\u6B63\u5728\u521B\u5EFA\u5206\u652F\u4F1A\u8BDD\u2026",
  "bookmark.fork.ok": "\u5DF2\u521B\u5EFA\u65B0\u4F1A\u8BDD {id}\uFF08\u53EF\u5728\u5DE6\u4FA7\u4F1A\u8BDD\u5217\u8868\u67E5\u770B\uFF09",
  "bookmark.jump.hint": "\u70B9\u51FB\u8DF3\u8F6C\u5230\u8BE5\u8F6E",
  "bookmark.jumping": "\u6B63\u5728\u5B9A\u4F4D\u2026",
  "bookmark.jump.ok": "\u5DF2\u5B9A\u4F4D\u5230\u300C{label}\u300D",
  "bookmark.jump.notFound": "\u672A\u627E\u5230\u300C{label}\u300D\u5BF9\u5E94\u6D88\u606F\uFF08\u53EF\u80FD\u5DF2\u88AB\u538B\u7F29/\u4E0D\u5728\u5F53\u524D\u5386\u53F2\u7A97\u53E3\uFF09",
  "bookmark.jump.noChat": "\u627E\u4E0D\u5230\u300C\u5BF9\u8BDD\u300DTab\uFF0C\u65E0\u6CD5\u8DF3\u8F6C",
  "bookmark.renamed": "\u5DF2\u6539\u540D",
  "bookmark.deleted": "\u5DF2\u5220\u9664",
  "bookmark.error": "\u5931\u8D25\uFF1A{message}",
  "bookmark.guide.what.title": "\u4F1A\u8BDD\u4E66\u7B7E\u662F\u4EC0\u4E48",
  "bookmark.guide.what.body": "\u7ED9\u5BF9\u8BDD\u7684\u6BCF\u4E00\u8F6E\u6253\u6807\u7B7E\uFF0C\u4E4B\u540E\u53EF\u4ECE\u5217\u8868\u4E00\u952E\u8DF3\u56DE\u8BE5\u8F6E\uFF0C\u6216\u76F4\u63A5\u4ECE\u4EFB\u610F\u4E00\u8F6E\u521B\u5EFA\u5B98\u65B9\u5206\u652F\u4F1A\u8BDD\u3002\u6570\u636E\u5B58\u5728\u63D2\u4EF6 sidecar\uFF08\u4E0D\u78B0\u5B98\u65B9\u4F1A\u8BDD\u65E5\u5FD7\uFF09\uFF1B\u4E2D\u95F4\u8F6E\u7684\u5B98\u65B9\u5206\u652F\u6309\u94AE\u5DF2\u88AB Memory Evolve \u63A5\u7BA1\uFF08\u70B9\u51FB\u5F39\u786E\u8BA4\u540E\u8D70\u5B98\u65B9 fork \u901A\u9053\uFF09\u3002",
  "bookmark.guide.star.title": "\u600E\u4E48\u6253\u661F",
  "bookmark.guide.star.body": "\u6BCF\u4E2A\u5DF2\u5B8C\u6210\u8F6E\u5C3E\u6709 \u2606 \u6309\u94AE\uFF1A\u70B9\u4E00\u4E0B\u53D6\u540D\uFF08\u9ED8\u8BA4\u300C\u8F6E\u6B21 N\u300D\uFF09\u5373\u6253\u661F\uFF1B\u2605 \u8868\u793A\u5DF2\u6253\u661F\uFF0C\u518D\u70B9\u53EF\u6539\u540D\u6216\u5220\u9664\u3002\u5C0F\u56FE\u6807\u4E0D\u5E72\u6270 Copy/Branch\u3002",
  "bookmark.guide.list.title": "\u5217\u8868\u4E0E\u8DF3\u8F6C",
  "bookmark.guide.list.body": "\u672C Tab \u5217\u51FA\u5F53\u524D\u4F1A\u8BDD\u5168\u90E8\u4E66\u7B7E\uFF08\u6807\u7B7E\u3001\u8F6E\u6B21\u3001\u65F6\u95F4\u3001\u6458\u8981\uFF09\u3002\u70B9\u51FB\u8DF3\u8F6C\uFF1A\u81EA\u52A8\u5207\u56DE\u300C\u5BF9\u8BDD\u300DTab\uFF0C\u6309 data-chat-anchor-key \u5B9A\u4F4D\uFF1B\u82E5\u5728\u672A\u52A0\u8F7D\u7684\u5386\u53F2\u7A97\u53E3\u4F1A\u5148\u62C9\u66F4\u65E9\u6D88\u606F\u518D\u5B9A\u4F4D\u3002",
  "bookmark.guide.switch.title": "\u5F00\u5173",
  "bookmark.guide.switch.body": "\u9ED8\u8BA4\u5173\u95ED\uFF1B\u5728\u300CMemory Evolve \u8BBE\u7F6E\u300D\u2192\u300C\u914D\u7F6E\u300D\u6253\u5F00\u300C\u4F1A\u8BDD\u4E66\u7B7E\u300D\u3002\u5173\u95ED\u540E\u661F\u6807\u4E0E\u672C Tab \u9690\u85CF\uFF0C\u5DF2\u5B58\u4E66\u7B7E\u6587\u4EF6\u4FDD\u7559\u3002",
  "panel.guide.bookmark.title": "\u4F1A\u8BDD\u4E66\u7B7E",
  "panel.guide.bookmark.desc": "\u7ED9\u6BCF\u8F6E\u6253\u661F\u6807\u8BB0\uFF0C\u5217\u8868\u4E00\u952E\u8DF3\u56DE\uFF0C\u5E76\u652F\u6301\u4ECE\u4EFB\u610F\u8F6E\u521B\u5EFA\u5B98\u65B9\u5206\u652F\uFF08\u542B\u63A5\u7BA1\u5B98\u65B9\u4E2D\u95F4\u8F6E\u5206\u652F\u6309\u94AE\uFF09\u3002\u72EC\u7ACB\u5F00\u5173\uFF0C\u9ED8\u8BA4\u5173\u3002",
  "panel.config.bookmarkEnabled": "\u4F1A\u8BDD\u4E66\u7B7E",
  "panel.config.bookmarkEnabled.hint": "\u542F\u7528\u4F1A\u8BDD\u4E66\u7B7E\uFF1A\u6BCF\u4E2A\u5DF2\u5B8C\u6210\u8F6E\u5C3E\u51FA\u73B0 \u2606 \u661F\u6807\u6309\u94AE + \u300C\u4E66\u7B7E\u300DTab \u5217\u8868\u4E0E\u8DF3\u8F6C\uFF1B\u652F\u6301\u4ECE\u4EFB\u610F\u8F6E\u521B\u5EFA\u5B98\u65B9\u5206\u652F\uFF08\u5217\u8868\u300C\u5206\u652F\u300D\u6309\u94AE\uFF0C\u6216\u76F4\u63A5\u70B9\u5B98\u65B9\u5206\u652F\u6309\u94AE\u2014\u2014\u4E2D\u95F4\u8F6E\u4F1A\u88AB\u63A5\u7BA1\u5E76\u5F39\u786E\u8BA4\uFF09\u3002\u6570\u636E\u5B58\u5728 <memoryDir>/session-bookmarks.json\uFF08\u6309\u4F1A\u8BDD\u9694\u79BB\uFF0C\u6309\u8F6E seq \u5B9A\u4F4D\uFF09\u3002**\u72EC\u7ACB\u5B50\u6A21\u5757**\uFF08\u9ED8\u8BA4\u5173\u95ED\uFF0C\u7EAF UI + \u5BBF\u4E3B API\uFF0C\u4E0D\u6CE8\u518C AI \u5DE5\u5177\uFF09\uFF1B\u5173\u95ED\u65F6\u661F\u6807\u4E0E Tab \u9690\u85CF\uFF0C\u6570\u636E\u6587\u4EF6\u4FDD\u7559\u3002",
  // 以下键保留兼容（旧 memory tab 合并布局的遗留，新 UI 不再引用）：
  "memoryTab.feature.config": "\u914D\u7F6E",
  "memoryTab.feature.todoSuggestions": "\u5F85\u786E\u8BA4\u5F85\u529E\u5EFA\u8BAE",
  "memoryTab.feature.skills": "\u5F85\u786E\u8BA4\u6280\u80FD\u5EFA\u8BAE",
  "memoryTab.feature.skillBrowser": "\u6280\u80FD\u7BA1\u7406",
  "memoryTab.feature.todo": "\u5F85\u529E",
  // 记忆 Tab 专属指南（「指南」子 Tab，详细介绍记忆功能本身）：
  "memoryTab.guide.tracks.title": "\u4E94\u8F68\u8BB0\u5FC6",
  "memoryTab.guide.tracks.body": "\u8BB0\u5FC6\u6309\u5C42\u7EA7\u5206\u4E94\u8F68\uFF0C\u6CE8\u5165\u8303\u56F4\u968F\u5C42\u7EA7\u6536\u7A84\u3001\u4E92\u4E0D\u6C61\u67D3\uFF1A",
  "memoryTab.guide.tracks.item1": "\u7528\u6237\u6863\u6848\uFF08user\uFF09\uFF1A\u4F60\u662F\u8C01\u3001\u504F\u597D\u3001\u6C9F\u901A\u65B9\u5F0F\u2014\u2014\u6BCF\u4F1A\u8BDD\u6CE8\u5165\uFF1B",
  "memoryTab.guide.tracks.item2": "\u957F\u671F\u8BB0\u5FC6\uFF08memory\uFF09\uFF1A\u73AF\u5883/\u5DE5\u5177/\u5168\u5C40\u60EF\u4F8B\u2014\u2014\u6BCF\u4F1A\u8BDD\u6CE8\u5165\uFF1B",
  "memoryTab.guide.tracks.item3": "\u9879\u76EE\u5173\u952E\u8BB0\u5FC6\uFF08key\uFF09\uFF1A\u5F53\u524D\u9879\u76EE\u7684\u957F\u671F\u4E8B\u5B9E\uFF08\u7EA6\u5B9A/\u51B3\u7B56/\u67B6\u6784/\u8E29\u5751\uFF09\u2014\u2014\u6CE8\u5165\u5F53\u524D\u9879\u76EE\u4F1A\u8BDD\uFF0C\u6309 git \u5206\u652F\u8FC7\u6EE4\uFF1B",
  "memoryTab.guide.tracks.item4": "\u9879\u76EE\u65E5\u5FD7\uFF08project\uFF09\uFF1A\u5F53\u524D\u9879\u76EE\u7684\u8FDB\u5C55\u6D41\u6C34\u2014\u2014\u4E0D\u6CE8\u5165\uFF0CAI \u6309\u9700\u8BFB\u53D6\uFF1B",
  "memoryTab.guide.tracks.item5": "\u4ECA\u65E5\u65E5\u5FD7\uFF08daily\uFF09\uFF1A\u6309\u5929\u8BB0\u5F55\u7684\u5F53\u5929\u8FDB\u5C55\u2014\u2014\u4E0D\u6CE8\u5165\uFF0CAI \u6309\u9700\u8BFB\u53D6\u3002",
  "memoryTab.guide.files.title": "\u6587\u4EF6\u9875\u7B7E",
  "memoryTab.guide.files.body": "\u672C Tab \u76F4\u63A5\u9884\u89C8 AGENTS.md \u4E0E\u5168\u90E8\u8BB0\u5FC6\u6587\u4EF6\uFF08\u53EA\u8BFB\u2014\u2014\u7F16\u8F91\u8BF7\u8D70 memory \u5DE5\u5177\u6216\u7CFB\u7EDF\u5DE5\u5177\uFF0C\u907F\u514D\u7834\u574F \xA7 \u5206\u9694\u683C\u5F0F\uFF09\uFF1A",
  "memoryTab.guide.files.item1": "\u7F8E\u89C2\u89C6\u56FE\uFF1A\xA7 \u6761\u76EE\u5361\u7247\uFF08\u65F6\u95F4/\u5206\u652F/\u6807\u7B7E\u5FBD\u6807 + \u5185\u5BB9\uFF09\uFF0C\u53EF\u641C\u7D22\u8FC7\u6EE4\u3001\u5207\u6362\u7EAF\u6587\u672C\u89C6\u56FE\uFF1B",
  "memoryTab.guide.files.item2": "KEY \u9875\u7B7E\u53EF\u624B\u52A8\u6DFB\u52A0\u957F\u671F\u9879\u76EE\u4E8B\u5B9E\uFF08\u53EF\u540C\u65F6\u9009\u62E9\u5206\u652F\u8303\u56F4\uFF09\uFF0C\u4FDD\u5B58\u540E\u4E0B\u4E00\u8F6E\u6CE8\u5165\uFF1B",
  "memoryTab.guide.files.item3": "\u6BCF\u6761\u8BB0\u5FC6\u53EF\u7F16\u8F91\uFF08\u6CE8\u5165\u8F68\u4FDD\u5B58\u9700\u786E\u8BA4\uFF09\u3001\u5220\u9664\uFF08\u5B8C\u6574\u6761\u76EE\u7CBE\u786E\u5339\u914D\uFF09\u3001\u5F52\u6863/\u79FB\u56DE\u4E3B\u8BB0\u5FC6\u3002",
  "memoryTab.guide.branch.title": "git \u5206\u652F\u611F\u77E5",
  "memoryTab.guide.branch.body": "\u540C\u4E00\u4E2A\u9879\u76EE\u7684\u4E0D\u540C\u5206\u652F\u53EF\u80FD\u6709\u5B8C\u5168\u4E0D\u540C\u7684\u7EA6\u5B9A\uFF0C\u9879\u76EE\u7EA7\u8BB0\u5FC6\u5168\u7A0B\u611F\u77E5\u5F53\u524D\u5206\u652F\uFF1A",
  "memoryTab.guide.branch.item1": "key \u6761\u76EE\u53EF\u5E26\u5206\u652F\u8303\u56F4\u6807\u8BB0\uFF08\u65E0\u6807\u8BB0 = \u5168\u90E8\u5206\u652F\u53EF\u89C1\uFF09\uFF1B\u6CE8\u5165\u65F6\u53EA\u6CE8\u5165\u300C\u65E0\u6807\u8BB0\u300D+\u300C\u8986\u76D6\u5F53\u524D\u5206\u652F\u300D\u7684\u6761\u76EE\uFF1B",
  "memoryTab.guide.branch.item2": "\u65E5\u5FD7\u6761\u76EE\u81EA\u52A8\u5E26\u6765\u6E90\u5206\u652F tag\uFF08[git \u5206\u652F\u540D]\uFF09\uFF0C\u8DE8\u5206\u652F\u56DE\u987E\u4E0D\u5F20\u51A0\u674E\u6234\u3002",
  "memoryTab.guide.maintain.title": "\u7F16\u8F91\u4E0E\u7EF4\u62A4",
  "memoryTab.guide.maintain.body": "\u8BB0\u5FC6\u7684\u7EF4\u62A4\u64CD\u4F5C\u90FD\u5728\u672C Tab \u5B8C\u6210\uFF1A",
  "memoryTab.guide.maintain.item1": "\u7F16\u8F91\u6B63\u6587\uFF1A\u53EA\u6539\u5185\u5BB9\uFF0C\u65F6\u95F4\u6233/\u5206\u652F/tag \u7531\u7A0B\u5E8F\u7EF4\u62A4\uFF1B",
  "memoryTab.guide.maintain.item2": "\u5220\u9664\uFF1A\u6309\u5B8C\u6574\u6761\u76EE\u7CBE\u786E\u5339\u914D\uFF08\u675C\u7EDD\u8BEF\u5220\u5305\u542B\u5173\u7CFB\u7684\u957F\u6761\u76EE\uFF09\uFF0C\u4E0D\u53EF\u6062\u590D\uFF1B",
  "memoryTab.guide.maintain.item3": "\u5F52\u6863/\u79FB\u56DE\uFF1Amemory/user/key \u2194 \u5F52\u6863\u6587\u4EF6\u53CC\u5411\u79FB\u52A8\uFF0C\u5F52\u6863\u4E0D\u518D\u6CE8\u5165\u3001\u53EF\u968F\u65F6\u8F6C\u6B63\u3002",
  "memoryTab.guide.suggestions.title": "\u5F85\u786E\u8BA4\u8BB0\u5FC6\u5EFA\u8BAE",
  "memoryTab.guide.suggestions.body": "\u540E\u53F0\u5BA1\u67E5\u4EA7\u51FA\u7684\u8BB0\u5FC6\u5EFA\u8BAE\u5148\u8FDB\u5F85\u786E\u8BA4\u961F\u5217\uFF08\u786E\u8BA4\u5236\u2014\u2014AI \u53EA\u63D0\u8BAE\uFF0C\u4F60\u51B3\u5B9A\uFF09\uFF1A",
  "memoryTab.guide.suggestions.item1": "\u91C7\u7EB3\uFF1A\u53EF\u5148\u4FEE\u6539\u6587\u672C\u3001\u53EF\u9009\u76EE\u6807\u8F68\uFF08\u8BB0\u5FC6/\u7528\u6237\u6863\u6848/\u9879\u76EE\u5173\u952E\u8BB0\u5FC6\uFF09\uFF0C\u5199\u5165\u540E\u968F\u5FEB\u7167\u6CE8\u5165\uFF1B",
  "memoryTab.guide.suggestions.item2": "\u5F52\u6863\uFF1A\u4E0D\u6CE8\u5165\u3001\u4EC5\u4FDD\u7559\u5907\u67E5\uFF0C\u9700\u8981\u65F6\u53EF\u79FB\u56DE\u4E3B\u8BB0\u5FC6\uFF1B\u62D2\u7EDD\uFF1A\u76F4\u63A5\u4E22\u5F03\u3002",
  "memoryTab.guide.confirm.title": "\u786E\u8BA4\u5236",
  "memoryTab.guide.confirm.body": "\u8BB0\u5FC6\u5199\u5165\u4F1A\u771F\u5B9E\u6539\u53D8 AI \u7684\u884C\u4E3A\uFF08\u8FDB\u5165\u4E0A\u4E0B\u6587\u3001\u5F71\u54CD\u540E\u7EED\u56DE\u590D\uFF09\uFF0C\u6240\u4EE5\u4E00\u5F8B\u5148\u7ECF\u4F60\u786E\u8BA4\u2014\u2014\u8FD9\u662F\u8BB0\u5FC6\u8FDB\u5316\u7684\u628A\u5173\u73AF\u8282\u3002",
  // 技能 Tab 专属指南（「指南」子 Tab，详细介绍技能功能本身）：
  "skillsTab.guide.what.title": "\u6280\u80FD\u662F\u4EC0\u4E48",
  "skillsTab.guide.what.body": "\u6280\u80FD = \u7ED9 AI \u7684\u65B9\u6CD5\u8BBA\u6587\u6863\uFF08SKILL.md\uFF1Afrontmatter name/description + \u6B63\u6587\uFF09\uFF1A\u6CE8\u5165\u6BCF\u4E2A\u4F1A\u8BDD\u7684\u7CFB\u7EDF\u63D0\u793A\u8BCD\uFF0CAI \u9047\u5230\u540C\u7C7B\u4EFB\u52A1\u76F4\u63A5\u6309\u6D41\u7A0B\u6267\u884C\u3002",
  "skillsTab.guide.what.item1": "\u6280\u80FD\u5E93\u9ED8\u8BA4\u5728 ~/.agents/skills\uFF08\u6BCF\u4E2A\u6280\u80FD\u4E00\u4E2A\u76EE\u5F55\uFF09\uFF1B",
  "skillsTab.guide.what.item2": "DSH \u8FD8\u626B\u63CF\u9879\u76EE\u6280\u80FD\u3001\u5185\u7F6E\u6280\u80FD\u4E0E\u81EA\u5B9A\u4E49\u76EE\u5F55\u2014\u2014\u5168\u90E8\u5728\u672C Tab \u53EF\u89C1\u3002",
  "skillsTab.guide.how.title": "\u6280\u80FD\u5982\u4F55\u6C89\u6DC0",
  "skillsTab.guide.how.body": "\u53CD\u590D\u8E29\u5751\u7684\u65B9\u6CD5\u8BBA\u53EF\u56FA\u5316\u4E3A\u6280\u80FD\uFF1A",
  "skillsTab.guide.how.item1": "\u540E\u53F0\u5BA1\u67E5\u521B\u5EFA\uFF1A\u65B0\u6280\u80FD\u5148\u8FDB\u300C\u5F85\u786E\u8BA4\u6280\u80FD\u5EFA\u8BAE\u300D\uFF0C\u91C7\u7EB3\u540E\u79FB\u5165\u6280\u80FD\u5E93\uFF1B",
  "skillsTab.guide.how.item2": "skill_manage \u5DE5\u5177\uFF1A\u6A21\u578B\u76F4\u63A5\u521B\u5EFA/\u66F4\u65B0\u6280\u80FD\uFF08read-before-write \u4FDD\u62A4\uFF09\uFF1B",
  "skillsTab.guide.how.item3": "\u521B\u5EFA\u4FDD\u6301\u514B\u5236\uFF1A\u53EA\u5EFA\u300C\u591A\u6B21\u8E29\u5751\u3001\u96BE\u5EA6\u5927\u3001\u540E\u7EED\u590D\u7528\u300D\u7684\u6280\u80FD\uFF0C\u907F\u514D\u6280\u80FD\u5E93\u81A8\u80C0\u3002",
  "skillsTab.guide.pending.title": "\u5F85\u786E\u8BA4\u6280\u80FD\u5EFA\u8BAE",
  "skillsTab.guide.pending.body": "\u5BA1\u67E5\u521B\u5EFA\u7684\u65B0\u6280\u80FD\u5728\u6B64\u786E\u8BA4\uFF1A",
  "skillsTab.guide.pending.item1": "\u91C7\u7EB3\uFF1A\u79FB\u5165\u6280\u80FD\u5E93\uFF08~/.agents/skills\uFF09\uFF0C\u968F\u7CFB\u7EDF\u63D0\u793A\u8BCD\u6CE8\u5165\u3001\u6240\u6709\u4F1A\u8BDD\u7ACB\u5373\u53EF\u7528\uFF1B",
  "skillsTab.guide.pending.item2": "\u62D2\u7EDD\uFF1A\u4E22\u5F03\u8BE5\u6280\u80FD\u3002",
  "skillsTab.guide.manager.title": "\u6280\u80FD\u7BA1\u7406",
  "skillsTab.guide.manager.body": "\u5B8C\u6574\u6280\u80FD\u7BA1\u7406\u5668\uFF08\u4E09\u680F\uFF1A\u6280\u80FD\u5217\u8868 / \u76EE\u5F55\u6811 / \u6587\u4EF6\u67E5\u770B\u7F16\u8F91\uFF09\uFF1A",
  "skillsTab.guide.manager.item1": "\u5168\u90E8\u6280\u80FD\u6309\u6765\u6E90\u5206\u5C42\u5C55\u793A\uFF08\u7528\u6237 user-* / \u81EA\u5B9A\u4E49 custom / \u5185\u7F6E bundled / \u9879\u76EE project-*\uFF09\uFF0C\u53EF\u641C\u7D22\u4E0E\u7B5B\u9009\uFF1B",
  "skillsTab.guide.manager.item2": "\u81EA\u5B9A\u4E49\u6280\u80FD\u76EE\u5F55\uFF1A\u6DFB\u52A0/\u79FB\u9664\u4EFB\u610F\u6280\u80FD\u76EE\u5F55\uFF08<\u76EE\u5F55>/<\u6280\u80FD>/SKILL.md \u6216 <\u76EE\u5F55>/<\u6280\u80FD>.md \u5E03\u5C40\uFF09\uFF1B",
  "skillsTab.guide.manager.item3": "\u6587\u4EF6\u6D4F\u89C8\u4E0E\u7F16\u8F91\uFF1A\u76EE\u5F55\u6811 + \u6587\u672C\u67E5\u770B/\u7F16\u8F91\uFF08\u9650\u6280\u80FD\u76EE\u5F55\u8303\u56F4\u5185\uFF0C\u8D8A\u754C/\u4E8C\u8FDB\u5236/\u8D85\u5927\u88AB\u62D2\uFF09\uFF1B",
  "skillsTab.guide.manager.item4": "\u7981\u7528\u5217\u8868\u4E0E\u81EA\u5B9A\u4E49\u76EE\u5F55\u6301\u4E45\u4FDD\u5B58\uFF0C\u91CD\u542F\u540E\u81EA\u52A8\u6062\u590D\u3002",
  "skillsTab.guide.disable.title": "\u7981\u7528 / \u542F\u7528",
  "skillsTab.guide.disable.body": "\u4E00\u952E\u7981\u7528\u628A\u6280\u80FD\u4ECE\u6A21\u578B\u6280\u80FD\u76EE\u5F55\u4E2D\u79FB\u9664\uFF08\u6CE8\u518C runtime shadow\uFF0C\u6A21\u578B\u4E0D\u518D\u770B\u5230\u3001skill \u5DE5\u5177\u62D2\u7EDD\u52A0\u8F7D\uFF09\uFF1A",
  "skillsTab.guide.disable.item1": "\u53EF\u968F\u65F6\u91CD\u65B0\u542F\u7528\uFF0C\u9009\u62E9\u6301\u4E45\u4FDD\u5B58\uFF1B",
  "skillsTab.guide.disable.item2": "\u7CFB\u7EDF\u6280\u80FD\uFF08project \u6765\u6E90\uFF09\u7ED3\u6784\u6027\u4E0D\u53EF\u7981\u7528\u3002",
  "skillsTab.guide.dirs.title": "\u81EA\u5B9A\u4E49\u6280\u80FD\u76EE\u5F55",
  "skillsTab.guide.dirs.body": "\u5728\u300C\u6280\u80FD\u7BA1\u7406\u300D\u91CC\u76F4\u63A5\u6DFB\u52A0/\u79FB\u9664\u4F60\u81EA\u5DF1\u7684\u6280\u80FD\u76EE\u5F55\uFF08\u5982 ~/.hermes/skills\uFF09\uFF0C\u4E0E\u5DF2\u6709\u6280\u80FD\u6839\u91CD\u53E0\u7684\u8DEF\u5F84\u4F1A\u88AB\u62D2\u7EDD\uFF1B\u6C38\u4E45\u4FDD\u5B58\u3001\u91CD\u542F\u540E\u81EA\u52A8\u52A0\u8F7D\u3002",
  "skillsTab.guide.restraint.title": "\u521B\u5EFA\u7EAA\u5F8B",
  "skillsTab.guide.restraint.body": "\u6280\u80FD\u4F1A\u6CE8\u5165\u6BCF\u4E2A\u4F1A\u8BDD\u7684\u7CFB\u7EDF\u63D0\u793A\u8BCD\u3001\u5F71\u54CD\u4E0A\u4E0B\u6587\u4E0E\u7F13\u5B58\u2014\u2014\u521B\u5EFA\u5FC5\u987B\u514B\u5236\uFF1A",
  "skillsTab.guide.restraint.item1": "\u53EA\u521B\u5EFA\u300C\u591A\u6B21\u5C1D\u8BD5\u4ECD\u96BE\u89E3\u51B3\u3001\u96BE\u5EA6\u5927\u3001\u540E\u7EED\u53EF\u80FD\u591A\u6B21\u590D\u7528\u300D\u7684\u6280\u80FD\uFF1B",
  "skillsTab.guide.restraint.item2": "\u4E00\u6B21\u6027\u3001\u7B80\u5355\u4EFB\u52A1\u4E0D\u521B\u5EFA\u6280\u80FD\u3002",
  // 待办 Tab 专属指南（「指南」子 Tab，详细介绍待办功能本身）：
  "todosTab.guide.tracks.title": "\u56DB\u8F68\u5F85\u529E",
  "todosTab.guide.tracks.body": "\u5F85\u529E\u6309\u76EE\u6807\u5206\u56DB\u8F68\uFF0C\u4E0E\u8BB0\u5FC6\u7CFB\u7EDF\u540C\u6784\uFF1A",
  "todosTab.guide.tracks.item1": "\u751F\u6D3B\uFF08life\uFF09\uFF1A\u4E2A\u4EBA\u7410\u4E8B\uFF1B",
  "todosTab.guide.tracks.item2": "\u5DE5\u4F5C\uFF08work\uFF09\uFF1A\u8DE8\u9879\u76EE\u7684\u6B63\u4E8B\uFF1B",
  "todosTab.guide.tracks.item3": "\u672C\u9879\u76EE\uFF08project\uFF09\uFF1A\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u7684\u5F85\u529E\uFF08\u6362\u4E2A\u76EE\u5F55\u770B\u4E0D\u5230\uFF0C\u6309 cwd \u9694\u79BB\uFF09\uFF1B",
  "todosTab.guide.tracks.item4": "\u4ECA\u65E5\uFF08daily\uFF09\uFF1A\u6309\u5929\u5206\u6587\u4EF6\u7684\u6BCF\u65E5\u5F85\u529E\uFF0C\u53EF\u56DE\u770B\u8FC7\u5F80\uFF08\u6309\u65E5\u671F\u5206\u7EC4\uFF09\u3002",
  "todosTab.guide.add.title": "\u5982\u4F55\u6DFB\u52A0",
  "todosTab.guide.add.body": "\u4E24\u79CD\u65B9\u5F0F\uFF1A",
  "todosTab.guide.add.item1": "\u5BF9 AI \u8BF4\u300C\u8BB0\u4F4F/\u6211\u8981\u505A X\u300D\uFF08\u53EF\u6307\u660E \u5DE5\u4F5C/\u751F\u6D3B/\u8FD9\u4E2A\u9879\u76EE/\u4ECA\u5929\uFF09\uFF0CAI \u6309\u7C7B\u522B\u76F4\u5199\u5BF9\u5E94\u8F68\uFF1B",
  "todosTab.guide.add.item2": "\u5728\u672C Tab \u8F93\u5165\u6846\u624B\u52A8\u6DFB\u52A0\uFF08\u53EF\u9009\u56DB\u8C61\u9650\u4E0E\u622A\u6B62\u65E5\u671F\uFF09\u3002",
  "todosTab.guide.pending.title": "\u5F85\u786E\u8BA4\u5F85\u529E\u7BA1\u7406",
  "todosTab.guide.pending.body": "AI \u81EA\u5EFA\u7684\u5F85\u529E\u5148\u8FDB\u5F85\u786E\u8BA4\u961F\u5217\u2014\u2014AI \u4E0D\u80FD\u81EA\u4F5C\u4E3B\u5F20\u7ED9\u4F60\u6D3E\u6D3B\uFF1A",
  "todosTab.guide.pending.item1": "\u91C7\u7EB3\uFF1A\u5199\u5165\u5BF9\u5E94\u5F85\u529E\u8F68\uFF08\u5F85\u529E\u6C38\u8FDC\u662F\u5F85\u529E\uFF0C\u4E0D\u53EF\u6539\u6210\u8BB0\u5FC6\uFF09\uFF1B",
  "todosTab.guide.pending.item2": "\u5F52\u6863\uFF1A\u4FDD\u7559\u5907\u67E5\uFF1B\u62D2\u7EDD\uFF1A\u4E22\u5F03\u3002",
  "todosTab.guide.attrs.title": "\u72B6\u6001\u4E0E\u5C5E\u6027",
  "todosTab.guide.attrs.body": "\u6BCF\u6761\u5F85\u529E\u5E26\u5B8C\u6574\u5143\u6570\u636E\uFF1A",
  "todosTab.guide.attrs.item1": "\u56DB\u8C61\u9650\uFF08q1 \u91CD\u8981\u7D27\u6025 ~ q4 \u4E0D\u91CD\u8981\u4E0D\u7D27\u6025\uFF09\u3001\u622A\u6B62\u65E5\u671F\u3001\u53EF\u9009\u5206\u7C7B\uFF1B",
  "todosTab.guide.attrs.item2": "\u72B6\u6001\uFF1A\u5F85\u529E / \u8FDB\u884C\u4E2D / \u5DF2\u5B8C\u6210\uFF08\u81EA\u52A8\u76D6\u5B8C\u6210\u65F6\u95F4\uFF09/ \u53D7\u963B / \u5DF2\u53D6\u6D88\uFF1B",
  "todosTab.guide.attrs.item3": "\u5217\u8868/\u770B\u677F\u4E24\u79CD\u89C6\u56FE\uFF1A\u5217\u8868\u6309\u8F68\u9875\u7B7E + \u72B6\u6001/\u8C61\u9650\u7B5B\u9009\uFF1B\u770B\u677F\u6309\u56DB\u8C61\u9650\u56DB\u5BAB\u683C\u5C55\u793A\uFF1B\u6BCF\u6761\u53EF\u5B8C\u6210/\u6062\u590D\u3001\u884C\u5185\u7F16\u8F91\u3001\u5220\u9664\uFF08\u786E\u8BA4\uFF09\uFF0C\u72B6\u6001\u5FBD\u6807\u53EF\u70B9\u51FB\u5FAA\u73AF\u5207\u6362\u3002",
  "todosTab.guide.view.title": "\u667A\u80FD\u89C6\u56FE",
  "todosTab.guide.view.body": "\u9ED8\u8BA4\u53EA\u663E\u793A\u9700\u8981\u5173\u6CE8\u7684\uFF08\u903E\u671F/\u4ECA\u65E5\u5230\u671F/\u5F53\u524D\u9879\u76EE/\u91CD\u8981\u7D27\u6025\uFF0C\u6700\u591A 8 \u6761\uFF09\uFF1A",
  "todosTab.guide.view.item1": "\u8FC7\u5F80\u6BCF\u65E5\u5F85\u529E\u6309\u9700\u8BFB\u53D6\u2014\u2014\u70B9\u300C\u8FC7\u5F80\u300D\u9875\u7B7E\u624D\u67E5\u8BE2\u5386\u53F2\uFF1B",
  "todosTab.guide.view.item2": "\u300C\u663E\u793A\u5DF2\u8FC7\u671F\u300D\u52FE\u9009\u540E\u624D\u5C55\u793A\u8FC7\u671F\u7684\u9057\u7559\uFF08\u9ED8\u8BA4\u9690\u85CF\uFF0C\u4E0D\u589E\u52A0\u8D1F\u62C5\uFF09\u3002",
  "todosTab.guide.remind.title": "\u5230\u671F\u63D0\u9192",
  "todosTab.guide.remind.body": "AI \u6BCF\u8F6E\u6536\u5C3E\u68C0\u67E5\u5F85\u529E\u5230\u671F\u60C5\u51B5\uFF0C\u6709\u5230\u671F\u672A\u5B8C\u6210\u9879\u5C31\u5728\u56DE\u590D\u672B\u5C3E\u63D0\u9192\u4F60\u2014\u2014\u4E0D\u7528\u81EA\u5DF1\u8BB0\u7740\u76EF\u3002",
  "todo.track.life": "\u751F\u6D3B",
  "todo.track.all": "\u5168\u90E8",
  "todo.track": "\u5F85\u529E\u8F68",
  "todo.track.work": "\u5DE5\u4F5C",
  "todo.track.project": "\u672C\u9879\u76EE",
  "todo.track.daily": "\u4ECA\u65E5",
  "todo.track.past": "\u8FC7\u5F80",
  "todo.projectHint": "\u5F53\u524D\u4F1A\u8BDD\u65E0\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u9879\u76EE\u5F85\u529E\u4E0D\u53EF\u7528\uFF08\u53EA\u6709 \u751F\u6D3B/\u5DE5\u4F5C/\u4ECA\u65E5\uFF09\u3002",
  "todo.help": "\u56DB\u8F68\u5F85\u529E\uFF1A\u751F\u6D3B=\u4E2A\u4EBA\u7410\u4E8B\uFF1B\u5DE5\u4F5C=\u8DE8\u9879\u76EE\u7684\u6B63\u4E8B\uFF1B\u672C\u9879\u76EE=\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u7684\u5F85\u529E\uFF08\u6362\u4E2A\u76EE\u5F55\u770B\u4E0D\u5230\uFF09\uFF1B\u4ECA\u65E5=\u4ECA\u5929\u8981\u505A\u7684\uFF08\u6309\u5929\u5206\u6587\u4EF6\uFF09\u3002\u6BCF\u65E5\u7684\u8FC7\u5F80\u5F85\u529E\uFF08\u4ECA\u5929\u4E4B\u524D\uFF09\u9ED8\u8BA4\u4E0D\u8BFB\u53D6\u2014\u2014\u70B9\u300C\u8FC7\u5F80\u300D\u9875\u7B7E\u6216\u52FE\u9009\u300C\u663E\u793A\u5DF2\u8FC7\u671F\u300D\u624D\u4F1A\u67E5\u8BE2\u5386\u53F2\uFF08\u5DF2\u8FC7\u671F\u7684\u9057\u7559\u9ED8\u8BA4\u9690\u85CF\uFF0C\u52FE\u9009\u540E\u5168\u90E8\u663E\u793A\uFF09\u3002\u6DFB\u52A0\uFF1A\u8F93\u5165\u5185\u5BB9\uFF0C\u53EF\u9009\u56DB\u8C61\u9650\uFF08\u91CD\u8981\xD7\u7D27\u6025\uFF09\u4E0E\u622A\u6B62\u65E5\u671F\uFF0C\u70B9\u300C\u6DFB\u52A0\u300D\uFF1B\u6216\u76F4\u63A5\u5BF9\u6211\u8BF4\u201C\u5E2E\u6211\u52A0\u4E2A\u5F85\u529E\uFF0C\u662F\u5DE5\u4F5C\u4E0A\u7684/\u751F\u6D3B\u4E2D\u7684/\u8FD9\u4E2A\u9879\u76EE\u7684/\u4ECA\u5929\u8981\u7684\u201D\u2014\u2014\u6211\u4F1A\u6309\u7C7B\u522B\u5199\u5165\u5BF9\u5E94\u8F68\u3002",
  "todo.showExpired": "\u663E\u793A\u5DF2\u8FC7\u671F",
  "todo.pastHint": "\u8FC7\u5F80\u5F85\u529E\u5927\u591A\u662F\u5DF2\u8FC7\u671F\u7684\u9057\u7559\uFF0C\u9ED8\u8BA4\u5DF2\u9690\u85CF\uFF1B\u52FE\u9009\u300C\u663E\u793A\u5DF2\u8FC7\u671F\u300D\u5373\u53EF\u67E5\u770B\u3002",
  "todo.addPlaceholder": "\u8F93\u5165\u5F85\u529E\u5185\u5BB9\uFF08\u53EF\u591A\u884C\uFF09\uFF0C\u9009\u62E9\u8C61\u9650/\u622A\u6B62\u540E\u6DFB\u52A0\u2026",
  "todo.add": "\u6DFB\u52A0",
  "todo.added": "\u5DF2\u6DFB\u52A0\u5F85\u529E",
  "todo.done": "\u5B8C\u6210",
  "todo.undone": "\u6062\u590D",
  "todo.edit": "\u7F16\u8F91",
  "todo.save": "\u4FDD\u5B58",
  "todo.cancel": "\u53D6\u6D88",
  "todo.updated": "\u5DF2\u66F4\u65B0",
  "todo.deleted": "\u5DF2\u5220\u9664",
  "todo.deleteConfirm": "\u786E\u5B9A\u5220\u9664\u8FD9\u6761\u5F85\u529E\uFF1F\u5220\u9664\u540E\u4E0D\u53EF\u6062\u590D\u3002\n\n{snippet}",
  "todo.due": "\u622A\u6B62",
  "todo.overdue": "\u903E\u671F",
  "todo.all": "\u5168\u90E8",
  "todo.filterStatus": "\u72B6\u6001",
  "todo.filterQuadrant": "\u8C61\u9650",
  "todo.status.active": "\u672A\u5B8C\u6210",
  "todo.status.pending": "\u5F85\u529E",
  "todo.status.doing": "\u8FDB\u884C\u4E2D",
  "todo.status.done": "\u5DF2\u5B8C\u6210",
  "todo.status.blocked": "\u53D7\u963B",
  "todo.status.cancelled": "\u5DF2\u53D6\u6D88",
  "todo.quadrant": "\u56DB\u8C61\u9650",
  "todo.quadrant.none": "\u672A\u5206\u7C7B",
  "todo.quadrant.q1": "\u91CD\u8981\u7D27\u6025",
  "todo.quadrant.q2": "\u91CD\u8981\u4E0D\u7D27\u6025",
  "todo.quadrant.q3": "\u7D27\u6025\u4E0D\u91CD\u8981",
  "todo.quadrant.q4": "\u4E0D\u91CD\u8981\u4E0D\u7D27\u6025",
  "todo.empty": "\uFF08\u6682\u65E0\u5F85\u529E\uFF0C\u6DFB\u52A0\u4E00\u6761\u5427\uFF09",
  // 列表 / 四象限看板视图切换
  "todo.view.mode": "\u89C6\u56FE",
  "todo.view.list": "\u5217\u8868",
  "todo.view.board": "\u770B\u677F",
  "todo.board.empty": "\u6B64\u8C61\u9650\u6682\u65E0\u5F85\u529E",
  "todo.board.cycleStatus": "\u70B9\u51FB\u5207\u6362\u72B6\u6001",
  "memoryTab.cwd": "\u5F53\u524D\u4F1A\u8BDD\u5DE5\u4F5C\u76EE\u5F55",
  "memoryTab.loading": "\u52A0\u8F7D\u4E2D\u2026",
  "memoryTab.warning": "\u4EE5\u4E0B\u6587\u4EF6\u4E3A \xA7 \u5206\u9694\u7684\u7ED3\u6784\u5316\u8BB0\u5FC6\uFF0C\u7528\u7CFB\u7EDF\u5DE5\u5177\u6253\u5F00\u540E\u8BF7\u8C28\u614E\u7F16\u8F91\uFF0C\u968F\u610F\u4FEE\u6539\u53EF\u80FD\u7834\u574F\u683C\u5F0F\u3001\u5BFC\u81F4\u8BB0\u5FC6\u8BFB\u53D6\u9519\u4E71\u3002",
  "memoryTab.readonly": "\u53EA\u8BFB",
  "memoryTab.open": "\u6253\u5F00\u6587\u4EF6",
  "memoryTab.opened": "\u5DF2\u7528\u7CFB\u7EDF\u5DE5\u5177\u6253\u5F00",
  "memoryTab.empty": "\uFF08\u6587\u4EF6\u4E0D\u5B58\u5728\u6216\u4E3A\u7A7A\uFF09",
  "memoryTab.noCwd": "\uFF08\u5F53\u524D\u4F1A\u8BDD\u65E0\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u65E0\u6CD5\u5B9A\u4F4D\u9879\u76EE\u8BB0\u5FC6\uFF09",
  "memoryTab.truncated": "\uFF08\u5185\u5BB9\u8FC7\u957F\uFF0C\u5DF2\u622A\u65AD\u663E\u793A\uFF09",
  "memoryTab.pagePrev": "\u4E0A\u4E00\u9875",
  "memoryTab.pageNext": "\u4E0B\u4E00\u9875",
  "memoryTab.pageInfo": "\u7B2C {page}/{total} \u9875 \xB7 \u5171 {count} \u6761",
  "memoryTab.viewPretty": "\u7F8E\u89C2\u89C6\u56FE",
  "memoryTab.viewRaw": "\u7EAF\u6587\u672C\u89C6\u56FE",
  "memoryTab.searchPlaceholder": "\u641C\u7D22\u5185\u5BB9\u3001\u65F6\u95F4\u6216\u6807\u7B7E\u2026",
  "memoryTab.noResults": "\u6CA1\u6709\u5339\u914D\u7684\u6761\u76EE\uFF0C\u6362\u4E2A\u5173\u952E\u8BCD\u8BD5\u8BD5\u3002",
  "memoryTab.projectTag": "\u9879\u76EE\u6807\u7B7E",
  "memoryTab.entryCount": "{count} \u6761",
  "memoryTab.keyAddHelp": "\u624B\u52A8\u6DFB\u52A0\u4E00\u6761\u957F\u671F\u6709\u6548\u7684\u9879\u76EE\u4E8B\u5B9E\uFF08\u7EA6\u5B9A/\u51B3\u7B56/\u67B6\u6784/\u8E29\u5751\uFF09\uFF0C\u4FDD\u5B58\u540E\u5199\u5165 KEY.md\uFF0C\u4E0B\u4E00\u8F6E\u81EA\u52A8\u6CE8\u5165\u4E0A\u4E0B\u6587\u3002",
  "memoryTab.keyAddPlaceholder": "\u8F93\u5165\u4E00\u6761\u9879\u76EE\u91CD\u8981\u8BB0\u5FC6\uFF0C\u4F8B\u5982\uFF1A\u672C\u9879\u76EE\u7EA6\u5B9A\u4F7F\u7528 pnpm workspaces\u2026",
  "memoryTab.keyAdd": "\u4FDD\u5B58",
  "memoryTab.keyAdded": "\u5DF2\u5199\u5165\u9879\u76EE\u5173\u952E\u8BB0\u5FC6\uFF0C\u4E0B\u4E00\u8F6E\u5C06\u6CE8\u5165\u4E0A\u4E0B\u6587",
  "memoryTab.delete": "\u5220\u9664",
  "memoryTab.deleteConfirm": "\u786E\u5B9A\u5220\u9664\u8FD9\u6761\u8BB0\u5FC6\uFF1F\u5220\u9664\u540E\u4E0D\u53EF\u6062\u590D\u3002\n\n{snippet}",
  "memoryTab.deleted": "\u5DF2\u5220\u9664\u8BE5\u6761\u76EE",
  "memoryTab.edit": "\u7F16\u8F91",
  "memoryTab.save": "\u4FDD\u5B58",
  "memoryTab.cancel": "\u53D6\u6D88",
  "memoryTab.updated": "\u5DF2\u66F4\u65B0\u8BE5\u6761\u76EE",
  "memoryTab.editHint": "\u53EA\u80FD\u4FEE\u6539\u5185\u5BB9\uFF1A\u65F6\u95F4\u6233\u4E0E\u5206\u652F\u7B49\u6807\u8BB0\u7531\u7A0B\u5E8F\u7EF4\u62A4\uFF0C\u4E0D\u80FD\u6539\u52A8\uFF1B\u5206\u9694\u7B26 \xA7 \u4E0D\u53EF\u8F93\u5165\u3002",
  "memoryTab.editConfirm": "\u8FD9\u6761\u8BB0\u5FC6\u4FDD\u5B58\u540E\u4F1A\u7ACB\u5373\u6CE8\u5165\u4F1A\u8BDD\u4E0A\u4E0B\u6587\uFF08\u8FDB\u5165\u540E\u7EED\u6A21\u578B\u7684\u63D0\u793A\u8BCD\uFF09\uFF0C\u786E\u5B9A\u4FDD\u5B58\uFF1F\n\n{snippet}",
  "memoryTab.archive": "\u5F52\u6863",
  "memoryTab.archiveConfirm": "\u5F52\u6863\u8FD9\u6761\u8BB0\u5FC6\uFF1F\u5C06\u4ECE\u4E3B\u8BB0\u5FC6\u79FB\u5165\u5F52\u6863\u6587\u4EF6\uFF0C\u4E0D\u518D\u6CE8\u5165\u4F1A\u8BDD\uFF1B\u9700\u8981\u65F6\u53EF\u968F\u65F6\u79FB\u56DE\u3002\n\n{snippet}",
  "memoryTab.archived": "\u5DF2\u5F52\u6863\uFF08\u4E0D\u518D\u6CE8\u5165\uFF0C\u53EF\u968F\u65F6\u79FB\u56DE\uFF09",
  "memoryTab.promote": "\u79FB\u56DE\u4E3B\u8BB0\u5FC6",
  "memoryTab.promoted": "\u5DF2\u79FB\u56DE\u4E3B\u8BB0\u5FC6\uFF08\u91CD\u65B0\u6CE8\u5165\u4F1A\u8BDD\uFF09",
  "memoryTab.keyScope": "\u5206\u652F\u8303\u56F4",
  "memoryTab.keyScopeLabel": "\u5206\u652F",
  "memoryTab.keyScopeAll": "\u5168\u90E8",
  "memoryTab.keyScopeAllHint": "\u5168\u90E8 = \u6240\u6709\u5206\u652F\u53EF\u89C1",
  "memoryTab.keyScopeAllWeight": "\uFF08\u52FE\u9009\u540E\u6E05\u7A7A\u5206\u652F\u9009\u62E9\uFF09",
  "memoryTab.keyScopeHint": "\u70B9\u51FB\u4FEE\u6539\u5206\u652F\u8303\u56F4",
  "memoryTab.keyScopeSaved": "\u5206\u652F\u8303\u56F4\u5DF2\u66F4\u65B0",
  "memoryTab.keyScopeSave": "\u4FDD\u5B58",
  "memoryTab.keyScopeCancel": "\u53D6\u6D88",
  "memoryTab.keyBranchInfo": "\u5F53\u524D\u5206\u652F\uFF1A{branch}\uFF0C\u4EC5\u6CE8\u5165\u65E0\u6807\u8BB0\u6216\u542B\u8BE5\u5206\u652F\u7684\u6761\u76EE",
  "memoryTab.gitBranch": "\u8BE5\u6761\u8BB0\u5F55\u6240\u5C5E\u7684 git \u5206\u652F",
  "memoryTab.dshOnly": "\u4EC5DSH",
  "memoryTab.dshOnlyHint": "\u8BE5\u6761\u76EE\u53EA\u6CE8\u5165 DSH \u81EA\u8EAB\u4F1A\u8BDD\uFF1B\u6CE8\u5165\u5916\u90E8\u6267\u884C\u5668\uFF08COI \u4EFB\u52A1\uFF09\u65F6\u81EA\u52A8\u8DF3\u8FC7\u2014\u2014\u7528\u4E8E\u5B58\u653E\u53EA\u5BF9 DSH \u6709\u610F\u4E49\u7684\u7EAA\u5F8B/\u89C4\u5219/\u67B6\u6784\u7C7B\u4E8B\u5B9E",
  "memoryTab.dshOnlyOn": "\u4EC5DSH",
  "memoryTab.dshOnlyOff": "\u53D6\u6D88\u4EC5DSH",
  "memoryTab.dshOnlySet": "\u5DF2\u6807\u8BB0\u4E3A\u4EC5 DSH \u9002\u7528\uFF08\u5916\u90E8\u6267\u884C\u5668\u6CE8\u5165\u65F6\u8DF3\u8FC7\uFF09",
  "memoryTab.dshOnlyRemoved": "\u5DF2\u53D6\u6D88\u4EC5 DSH \u6807\u8BB0\uFF08\u5916\u90E8\u6267\u884C\u5668\u53EF\u89C1\uFF09",
  "memoryTab.dshOnlyToggleHint": "\u5207\u6362\u300C\u4EC5 DSH\u300D\u6807\u8BB0\uFF1A\u8BE5\u6761\u76EE\u53EA\u6CE8\u5165 DSH \u81EA\u8EAB\uFF0C\u4E0D\u6CE8\u5165\u5916\u90E8\u6267\u884C\u5668\uFF08COI\uFF09",
  "memoryTab.dshOnlyAdd": "\u4EC5 DSH \u9002\u7528\uFF08\u4E0D\u6CE8\u5165\u5916\u90E8\u6267\u884C\u5668\uFF09",
  "memoryTab.desc.project": "\u9879\u76EE\u65E5\u5FD7\uFF1A\u6BCF\u56DE\u5408\u6536\u5C3E\u81EA\u52A8\u8BB0\u5F55\u672C\u56DE\u5408\u8FDB\u5C55\uFF1B\u4E0D\u6CE8\u5165\u4E0A\u4E0B\u6587\uFF0C\u6A21\u578B\u6309\u9700\u8BFB\u53D6\u3002",
  "memoryTab.desc.key": "\u9879\u76EE\u5173\u952E\u8BB0\u5FC6\uFF1A\u957F\u671F\u7EA6\u5B9A/\u51B3\u7B56/\u8E29\u5751\uFF0C\u81EA\u52A8\u6CE8\u5165\u5F53\u524D\u9879\u76EE\u4F1A\u8BDD\uFF1B\u6309\u91CD\u8981\u6027\u5199\u5165\uFF0C\u53EF\u624B\u52A8\u6DFB\u52A0\u6216\u5220\u9664\u3002",
  "memoryTab.desc.daily": "\u4ECA\u65E5\u65E5\u5FD7\uFF1A\u6309\u5929\u5206\u6587\u4EF6\u7684\u6D41\u6C34\u8BB0\u5F55\uFF0C\u7A0B\u5E8F\u81EA\u52A8\u6807\u6CE8\u9879\u76EE\u6807\u7B7E\uFF1B\u4E0D\u6CE8\u5165\u4E0A\u4E0B\u6587\uFF0C\u6A21\u578B\u6309\u9700\u8BFB\u53D6\u3002",
  "memoryTab.desc.user": "\u7528\u6237\u6863\u6848\uFF1A\u7528\u6237\u504F\u597D\u4E0E\u4E60\u60EF\uFF0C\u6CE8\u5165\u6240\u6709\u4F1A\u8BDD\uFF1B\u5199\u5165\u9700\u5BA1\u67E5\u5EFA\u8BAE\u5E76\u7ECF\u786E\u8BA4\u3002",
  "memoryTab.desc.memory": "\u957F\u671F\u8BB0\u5FC6\uFF1A\u5168\u5C40\u73AF\u5883\u4E0E\u9879\u76EE\u4E8B\u5B9E\uFF0C\u6CE8\u5165\u6240\u6709\u4F1A\u8BDD\uFF1B\u5199\u5165\u9700\u5BA1\u67E5\u5EFA\u8BAE\u5E76\u7ECF\u786E\u8BA4\u3002",
  "memoryTab.desc.archive-user": "\u5F52\u6863\u7528\u6237\uFF1A\u4E0D\u591F\u683C\u8FDB\u4E3B\u8BB0\u5FC6\u7684\u7528\u6237\u4E8B\u5B9E\uFF0C\u4E0D\u6CE8\u5165\u4EFB\u4F55\u4F1A\u8BDD\uFF1B\u53EF\u79FB\u56DE\u4E3B\u8BB0\u5FC6\u6216\u5220\u9664\u3002",
  "memoryTab.desc.archive-memory": "\u5F52\u6863\u8BB0\u5FC6\uFF1A\u4E0D\u591F\u683C\u8FDB\u4E3B\u8BB0\u5FC6\u7684\u5168\u5C40\u4E8B\u5B9E\uFF0C\u4E0D\u6CE8\u5165\u4EFB\u4F55\u4F1A\u8BDD\uFF1B\u53EF\u79FB\u56DE\u4E3B\u8BB0\u5FC6\u6216\u5220\u9664\u3002",
  "memoryTab.desc.archive-key": "\u9879\u76EE\u5173\u952E\u8BB0\u5FC6\u5F52\u6863\uFF1A\u4E0D\u591F\u683C\u8FDB\u4E3B\u8BB0\u5FC6\uFF08\u6216\u9700\u6682\u505C\u6CE8\u5165\uFF09\u7684\u9879\u76EE\u4E8B\u5B9E\uFF0C\u4E0D\u6CE8\u5165\u4EFB\u4F55\u4F1A\u8BDD\uFF1B\u53EF\u79FB\u56DE\u4E3B\u8BB0\u5FC6\u6216\u5220\u9664\u3002",
  "memoryTab.desc.agents": "\u5168\u5C40\u89C4\u5219\uFF1A\u8DE8\u4F1A\u8BDD\u751F\u6548\u7684\u7528\u6237\u89C4\u5219\uFF08AGENTS.md\uFF09\uFF0C\u968F\u7CFB\u7EDF\u63D0\u793A\u8BCD\u6CE8\u5165\u3002",
  "panel.suggestions.title": "\u5F85\u786E\u8BA4\u8BB0\u5FC6\u5EFA\u8BAE",
  "panel.suggestions.empty": "\u6CA1\u6709\u5F85\u786E\u8BA4\u7684\u5EFA\u8BAE\u3002",
  "panel.suggestions.help": "\u540E\u53F0\u5BA1\u67E5\u4EA7\u51FA\u7684\u5168\u5C40\u8BB0\u5FC6\u5EFA\u8BAE\uFF1A\u91C7\u7EB3\u540E\u5199\u5165\u8BB0\u5FC6\u6587\u4EF6\u5E76\u968F\u5FEB\u7167\u6CE8\u5165\uFF1B\u5F52\u6863\u4FDD\u7559\u5907\u67E5\uFF08\u4E0D\u6CE8\u5165\uFF09\uFF1B\u62D2\u7EDD\u4E22\u5F03\u3002",
  "panel.todoSuggestions.title": "\u5F85\u786E\u8BA4\u5F85\u529E\u5EFA\u8BAE",
  "panel.todoSuggestions.empty": "\u6CA1\u6709\u5F85\u786E\u8BA4\u7684\u5F85\u529E\u5EFA\u8BAE\u3002",
  "panel.todoSuggestions.help": "\u540E\u53F0\u5BA1\u67E5\u4EA7\u51FA\u7684\u5F85\u529E\u5EFA\u8BAE\uFF1A\u91C7\u7EB3\u540E\u5199\u5165\u5BF9\u5E94\u5F85\u529E\u8F68\uFF08\u5F85\u529E\u4E0D\u80FD\u53D8\u6210\u8BB0\u5FC6\uFF09\uFF1B\u5F52\u6863\u4FDD\u7559\u5907\u67E5\uFF1B\u62D2\u7EDD\u4E22\u5F03\u3002",
  "panel.guide.title": "\u4F7F\u7528\u6307\u5357",
  "panel.guide.intro": "memory_evolve \u662F\u300C\u8BB0\u5FC6\u4E0E\u81EA\u6211\u8FDB\u5316\u300D\u80FD\u529B\u96C6\u5408\uFF1A\u8BA9 AI \u628A\u5BF9\u8BDD\u6C89\u6DC0\u4E3A\u957F\u671F\u8BB0\u5FC6\u3001\u5F85\u529E\u548C\u6280\u80FD\u2014\u2014\u8D8A\u7528\u8D8A\u61C2\u4F60\uFF0C\u8DE8\u4F1A\u8BDD\u4E0D\u4E22\u4E0A\u4E0B\u6587\u3002",
  "panel.guide.memory.title": "\u8BB0\u5FC6\u8BFB\u5199\uFF08memory \u5DE5\u5177\uFF09",
  "panel.guide.memory.desc": "\u4E94\u8F68\u8BB0\u5FC6\uFF1A\u957F\u671F\u8BB0\u5FC6\uFF08\u5168\u5C40\uFF09\u3001\u7528\u6237\u6863\u6848\u3001\u9879\u76EE\u5173\u952E\u8BB0\u5FC6\uFF08\u81EA\u52A8\u6CE8\u5165\uFF0C\u4E14\u6309 git \u5206\u652F\u8FC7\u6EE4\u2014\u2014\u53EA\u6709\u5F53\u524D\u5206\u652F\u76F8\u5173\u7684\u5173\u952E\u8BB0\u5FC6\u8FDB\u5165 AI \u4E0A\u4E0B\u6587\uFF09\u3001\u9879\u76EE\u65E5\u5FD7\u3001\u4ECA\u65E5\u65E5\u5FD7\u3002\u6362\u9879\u76EE/\u9694\u5929\u7EE7\u7EED\u65F6\u76F4\u63A5\u95EE AI\uFF0C\u5B83\u67E5\u8BB0\u5FC6\u8854\u63A5\uFF0C\u4E0D\u7528\u4F60\u590D\u8FF0\u3002",
  "panel.guide.review.title": "\u8BB0\u5FC6\u5BA1\u67E5\uFF08\u81EA\u52A8\u8FDB\u5316\uFF09",
  "panel.guide.review.desc": "\u6BCF\u9694 N \u8F6E AI \u81EA\u52A8\u63D0\u70BC\u503C\u5F97\u8BB0\u4F4F\u7684\u4FE1\u606F\uFF0C\u63D0\u4EA4\u5230\u300C\u5F85\u786E\u8BA4\u8BB0\u5FC6\u5EFA\u8BAE\u300D\u7531\u4F60\u786E\u8BA4\u540E\u751F\u6548\u2014\u2014AI \u4E0D\u4F1A\u64C5\u81EA\u5F80\u8BB0\u5FC6\u91CC\u5199\u4E1C\u897F\u3002",
  "panel.guide.todo.title": "\u5F85\u529E\u7BA1\u7406\uFF08dtodo\uFF09",
  "panel.guide.todo.desc": '\u5BF9 AI \u8BF4"\u8BB0\u4F4F/\u6211\u8981\u505A X"\u5373\u843D\u6210\u7ED3\u6784\u5316\u5F85\u529E\uFF08\u81EA\u52A8\u5206\u751F\u6D3B/\u5DE5\u4F5C/\u9879\u76EE/\u6BCF\u65E5\uFF0C\u53EF\u8BBE\u91CD\u8981\u7D27\u6025\u4E0E\u622A\u6B62\uFF09\uFF0C\u5230\u671F AI \u4F1A\u63D0\u9192\u4F60\uFF1BAI \u81EA\u5EFA\u7684\u5F85\u529E\u5148\u8FDB\u300C\u5F85\u786E\u8BA4\u5F85\u529E\u5EFA\u8BAE\u300D\u7B49\u4F60\u786E\u8BA4\u3002',
  "panel.guide.skill.title": "\u6280\u80FD\u6C89\u6DC0\uFF08skill_manage\uFF09",
  "panel.guide.skill.desc": "\u53CD\u590D\u8E29\u5751\u7684\u65B9\u6CD5\u8BBA\u53EF\u56FA\u5316\u4E3A\u6280\u80FD\uFF0C\u540C\u7C7B\u4EFB\u52A1\u4E0B\u6B21\u76F4\u63A5\u6309\u6D41\u7A0B\u6267\u884C\uFF0C\u4E0D\u7528\u91CD\u65B0\u6478\u7D22\u3002\u521B\u5EFA\u4FDD\u6301\u514B\u5236\uFF0C\u53EA\u5EFA\u9AD8\u590D\u7528\u4EF7\u503C\u7684\uFF1B\u6280\u80FD\u5E93\u53EF\u5728\u300C\u6280\u80FD\u7BA1\u7406\u300D\u91CC\u6D4F\u89C8\u3001\u641C\u7D22\u5E76\u4E00\u952E\u542F\u7528/\u7981\u7528\uFF08\u7981\u7528\u540E AI \u4E0D\u518D\u52A0\u8F7D\uFF09\u3002",
  "panel.guide.search.title": "\u672C\u5730\u641C\u7D22\uFF08memory_evolve_search_local_files\uFF09",
  "panel.guide.search.desc": '\u8BB0\u5FC6\u91CC\u6CA1\u6709\u3001\u8981\u627E\u672C\u5730\u8D44\u6599\u65F6\uFF0CAI \u53EF\u6309\u6587\u4EF6\u540D\u641C\u7D22\uFF08\u4E0D\u6B62\u6587\u6863\uFF0C\u56FE\u7247/\u4EE3\u7801/\u914D\u7F6E\u90FD\u80FD\u627E\uFF1B\u9ED8\u8BA4\u53EA\u641C\u6587\u6863\u6269\u5C55\u540D\uFF0C\u53EF\u663E\u5F0F\u5168\u7C7B\u578B\u641C\u7D22\uFF09\uFF1B**\u4E5F\u53EF\u6309\u6587\u4EF6\u5185\u5BB9\u641C**\u2014\u2014"\u54EA\u4E2A\u6587\u6863\u91CC\u63D0\u8FC7 XX"\u76F4\u63A5\u95EE AI\uFF08contentQuery \u53C2\u6570\u5373\u5F00\u5185\u5BB9\u68C0\u7D22\uFF09\u3002**\u56DB\u6863\u6A21\u5F0F**\uFF08\u300C\u914D\u7F6E\u300D\u91CC\u9009\uFF09\uFF1A\u90FD\u542F\u7528\uFF08\u6587\u4EF6\u540D+\u5185\u5BB9\uFF09/ \u4EC5\u6587\u4EF6\u540D\u641C\u7D22 / \u4EC5\u5185\u5BB9\u641C\u7D22 / \u5173\u95ED\u2014\u2014\u5185\u5BB9\u68C0\u7D22\u6709\u4EBA\u53EF\u80FD\u7528\u81EA\u5DF1\u522B\u7684\u5B9E\u73B0\uFF0C\u53EF\u6309\u9700\u53EA\u7559\u6587\u4EF6\u540D\u6A21\u5F0F\u3002**\u9ED8\u8BA4\u5173\u95ED**\uFF1A\u5DE5\u5177\u5BF9\u6A21\u578B\u5B8C\u5168\u4E0D\u53EF\u89C1\u3002',
  "panel.guide.coi.title": "COI \u8C03\u5EA6\uFF08de_coi\uFF09",
  "panel.guide.coi.desc": '\u628A\u4EFB\u52A1\u6D3E\u7ED9\u5916\u90E8 CLI \u4EE3\u7406\uFF08kimi/codex/grok/hermes \u7B49\uFF09\uFF1A\u7EDF\u4E00\u8C03\u5EA6\u4E0D\u5361\u4E3B\u8FDB\u7A0B\u3001\u5B9E\u65F6\u770B\u8FDB\u5EA6\u3001\u4F1A\u8BDD\u81EA\u52A8\u5206\u5C42\u7BA1\u7406\u53EF\u4E00\u952E\u6062\u590D\u3001\u8DE8 COI \u63A5\u529B\u3001\u4EFB\u52A1\u7ED3\u679C\u7559\u6863\u5E76\u6C89\u6DC0\u5230\u8BB0\u5FC6\u3002\u8BF4"\u6D3E\u7ED9 kimi/codex \u505A XX"\u5373\u53EF\uFF0C\u6216\u6253\u5F00\u300CCOI \u8C03\u5EA6\u300DTab \u624B\u52A8\u53D1\u8D77\u3002**\u9ED8\u8BA4\u7981\u7528**\uFF1A\u4E0E\u672C\u5730\u641C\u7D22\u4E00\u6837\u6309\u9700\u542F\u7528\u2014\u2014\u5728\u300CMemory Evolve \u8BBE\u7F6E\u300DTab \u7684\u300C\u914D\u7F6E\u300D\u91CC\u6253\u5F00\u300CCOI \u8C03\u5EA6\u300D\u5F00\u5173\uFF08\u5DE5\u5177\u5373\u65F6\u751F\u6548\uFF0CTab \u5237\u65B0\u540E\u51FA\u73B0\uFF09\u3002',
  "panel.guide.prompt.title": "\u63D0\u793A\u8BCD\u7BA1\u7406\u5668\uFF08Prompt Manager\uFF09",
  "panel.guide.prompt.desc": "\u628A\u5E38\u7528\u7684\u5DE5\u4F5C\u8303\u5F0F\u56FA\u5316\u6210\u63D0\u793A\u8BCD\u8D44\u4EA7\uFF08\u5185\u7F6E\u7A0B\u5E8F\u5458\u793A\u4F8B\uFF1A\u4EE3\u7801\u5BA1\u67E5/\u8C03\u8BD5/\u67B6\u6784/\u6D4B\u8BD5\u7B49\uFF0C\u6765\u6E90\u4EE5\u81EA\u5199\u4E3A\u4E3B\uFF09\uFF1A\u9009\u4E2D\u4E00\u6761\u5373\u53EF\u6CE8\u5165\u2014\u2014**\u5199\u5165\u540E\u6A21\u578B\u4E0B\u4E00\u8F6E\u81EA\u52A8\u770B\u5230\u3001\u4E0D\u6253\u65AD\u56DE\u590D**\uFF1B\u652F\u6301\u4E00\u6B21\u6027\u3001\u6301\u7EED N \u8F6E\u3001\u6BCF M \u56DE\u5408\u63D0\u9192\u4E00\u6B21\uFF08\u6B21\u6570/\u95F4\u9694\u53EF\u8F93\u5165\u4EFB\u610F\u6570\u5B57\uFF0C\u6309\u5BF9\u8BDD\u56DE\u5408\u8BA1\u6570\u81EA\u52A8\u8FC7\u671F\uFF09\uFF0C\u300C\u6CE8\u5165\u4E2D\u300D\u53EF\u968F\u65F6\u505C\u6B62\uFF1B\u4E5F\u652F\u6301**\u4E34\u65F6\u6CE8\u5165**\uFF1A\u4E0D\u5EFA\u63D0\u793A\u8BCD\u76F4\u63A5\u8F93\u5165\u5185\u5BB9\u6CE8\u5165\uFF0C\u81EA\u52A8\u5B58\u5165\u63D0\u793A\u8BCD\u5E93\uFF08\u5206\u7C7B\u7559\u7A7A\u5F52\u5165\u300C\u4E34\u65F6\u300D\uFF09\u3002**\u9ED8\u8BA4\u7981\u7528**\uFF1A\u5728\u300CMemory Evolve \u8BBE\u7F6E\u300DTab \u7684\u300C\u914D\u7F6E\u300D\u91CC\u6253\u5F00\u300C\u63D0\u793A\u8BCD\u7BA1\u7406\u5668\u300D\u5F00\u5173\uFF0CTab \u5237\u65B0\u540E\u51FA\u73B0\u3002",
  "panel.guide.models.title": "\u6A21\u578B\u914D\u7F6E\uFF08de_models\uFF09",
  "panel.guide.models.desc": "\u300C\u6A21\u578B\u914D\u7F6E\u300DTab + `de_models` \u5DE5\u5177\uFF1A\u8868\u683C\u4E00\u89C8 DSH \u73B0\u6709\u4F9B\u5E94\u5546\u4E0E\u6A21\u578B\uFF0C\u7ED9\u6BCF\u4E2A\u6A21\u578B\u8BBE\u7F6E**\u63D2\u4EF6\u4FA7**\u7684\u542F\u7528\u72B6\u6001\u3001\u5907\u6CE8\u3001\u662F\u5426\u652F\u6301\u601D\u8003\u4E0E\u53EF\u7528/\u63A8\u8350\u601D\u8003\u7B49\u7EA7\uFF08\u53EF\u52FE\u9009\u7B49\u7EA7\u767D\u540D\u5355\u3001\u6DFB\u52A0\u81EA\u5B9A\u4E49\u7B49\u7EA7\uFF09\u2014\u2014**\u8FD9\u4E9B\u914D\u7F6E\u53EA\u5BF9\u672C\u63D2\u4EF6\u6709\u7528**\uFF08\u51B3\u5B9A de_models \u67E5\u8BE2\u53E3\u5F84\u4E0E Tab \u5C55\u793A\uFF09\uFF0C**\u4E0D\u4FEE\u6539\u3001\u4E5F\u4E0D\u5F71\u54CD DSH \u81EA\u8EAB\u7684\u6A21\u578B\u8BBE\u7F6E**\uFF08DSH \u7684\u6A21\u578B\u914D\u7F6E\u4ECD\u4EE5\u5B98\u65B9\u300C\u8BBE\u7F6E \u2192 \u6A21\u578B\u300D\u4E3A\u51C6\uFF09\u3002**\u9ED8\u8BA4\u7981\u7528**\uFF1A\u5728\u300C\u914D\u7F6E\u300D\u91CC\u6253\u5F00\u300C\u6A21\u578B\u914D\u7F6E\u300D\u5F00\u5173\u540E\uFF0CTab \u5237\u65B0\u51FA\u73B0\u3001de_models \u5DE5\u5177\u751F\u6548\u3002",
  "panel.guide.broadcast.title": "\u4F1A\u8BDD\u5E7F\u64AD\uFF08de_broadcast\uFF09",
  "panel.guide.broadcast.desc": 'DSH \u4F1A\u8BDD\u4E4B\u95F4\u4F20\u9012\u6D88\u606F\uFF1A\u5148\u590D\u5236\u672C\u4F1A\u8BDD ID\uFF08\u4F1A\u8BDD\u5934\u90E8\u300C\u29C9 \u590D\u5236\u4F1A\u8BDDID\u300D\u6309\u94AE\uFF09\uFF0C\u628A ID \u53D1\u7ED9\u53E6\u4E00\u4E2A\u4F1A\u8BDD\uFF0C\u8BA9\u5B83\u7684 AI \u7528 de_broadcast send \u628A\u5185\u5BB9\u5E7F\u64AD\u7ED9\u4F60\uFF08recipients \u53EF\u540C\u65F6\u586B\u591A\u4E2A\u4F1A\u8BDD ID\uFF0C\u9ED8\u8BA4\u4E00\u5BF9\u4E00\uFF09\u2014\u2014\u63A5\u6536\u65B9\u5FEB\u7167**\u5B9A\u70B9\u6CE8\u5165**\u672A\u8BFB\u63D0\u793A\uFF08\u6536\u4EF6\u7BB1\u5F0F\u5217\u51FA id+\u4E3B\u9898+\u53D1\u9001\u8005+\u65F6\u95F4\uFF0C\u53EA\u6709\u63A5\u6536\u8005\u770B\u5F97\u5230\uFF0C\u5176\u4ED6\u4F1A\u8BDD\u65E0\u611F\u77E5\uFF09\uFF0CAI \u7528 list/read \u67E5\u770B\u5168\u6587\u5904\u7406\uFF08\u663E\u5F0F\u63A5\u6536\u8005 read \u5373\u6D88\u8D39\u3001\u5168\u5458\u5DF2\u8BFB\u81EA\u52A8\u5220\u9664\uFF1B\u623F\u95F4/\u9879\u76EE\u6D88\u606F\u4FDD\u7559 30 \u5929\u4F9B\u56DE\u770B\uFF09\uFF1B\u8D85\u8FC7 8KB \u7684\u5185\u5BB9\u81EA\u52A8\u843D\u6587\u4EF6\u3002**\u623F\u95F4\uFF08\u804A\u5929\u5BA4\uFF09**\uFF1A\u591A\u4F1A\u8BDD\u534F\u4F5C\uFF08\u53EF\u8DE8\u5DE5\u4F5C\u76EE\u5F55\uFF09\u2014\u2014\u5EFA\u7FA4\uFF08room-create\uFF0C\u521B\u5EFA\u8005\u81EA\u52A8\u5165\u623F\uFF09\u2192 \u628A\u623F\u95F4 id \u544A\u8BC9\u5176\u4ED6\u4F1A\u8BDD\uFF08\u7C98\u8D34\u6216\u5E7F\u64AD\uFF09\u2192 \u5BF9\u65B9 room-join \u52A0\u5165 \u2192 \u4E4B\u540E\u8BF4"\u53D1\u5230\u7FA4\u91CC"\u5168\u5458\u540C\u65F6\u6536\u5230\uFF1Broom-leave \u9000\u51FA\u3001room-rm \u89E3\u6563\uFF08\u4EC5\u521B\u5EFA\u8005\uFF09\u3001room-list \u67E5\u7FA4\uFF1B\u623F\u95F4 30 \u5929\u65E0\u6D3B\u52A8\u81EA\u52A8\u5220\u9664\u3002**\u9879\u76EE\u7FA4**\uFF1Arecipients \u586B project:/\u8DEF\u5F84 \u53D1\u7ED9\u6574\u4E2A\u76EE\u5F55\uFF08\u6309 cwd \u5339\u914D\uFF09\u3002**\u5F00\u5173**\uFF1A\u72EC\u7ACB\u300C\u4F1A\u8BDD\u5E7F\u64AD\u300D\uFF08broadcastEnabled\uFF0C\u9ED8\u8BA4\u5173\uFF0C\u53EF\u5355\u72EC\u5F00\u542F\uFF0C\u4E0E COI \u8C03\u5EA6\u65E0\u5173\uFF09\u3002\u53E6\uFF1A\u5FEB\u7167\u6700\u524D\u9762\u6709**\u5E38\u9A7B\u300C\u4F60\u7684\u4F1A\u8BDD ID\u300D\u6BB5**\uFF08\u4E0D\u968F\u4EFB\u4F55\u5F00\u5173\uFF09\u2014\u2014AI \u7528\u5B83\u6BD4\u5BF9\u5404\u6A21\u5757\u6D88\u606F\u91CC\u7684 session id \u5224\u65AD\u6536\u53D1\u65B9\uFF0C\u56DE\u590D\u5E7F\u64AD\u65F6\u628A ID \u544A\u77E5\u5BF9\u65B9\u3002',
  "panel.guide.session.title": "\u4F1A\u8BDD\u641C\u7D22\uFF08de_session_search\uFF09",
  "panel.guide.session.desc": '\u8BA9 AI \u641C\u7D22**\u5176\u4ED6 AI \u5DE5\u5177\u7684\u5386\u53F2\u4F1A\u8BDD**\uFF08\u5F53\u524D\u652F\u6301 Codex\uFF1A`~/.codex/sessions` \u4E0E `archived_sessions` \u7684\u660E\u6587 JSONL\uFF0Crg \u9884\u7B5B\u540E\u6BEB\u79D2\u7EA7\uFF1BDSH \u4F1A\u8BDD\u6682\u4E0D\u652F\u6301\uFF09\u2014\u2014"\u4E4B\u524D Codex \u91CC\u505A\u8FC7 XX"\u76F4\u63A5\u95EE AI\uFF0C\u5B83\u6309\u5173\u952E\u8BCD\u641C\u51FA\u547D\u4E2D\u4F1A\u8BDD + \u6700\u5F3A\u6D88\u606F\u6458\u8981\uFF08snippet\uFF09+ \u4E0A\u4E0B\u6587\u7A97\u53E3\uFF1B\u5927\u5C0F\u5199\u4E0D\u654F\u611F\u7684\u5B57\u9762\u5339\u914D\uFF08\u4E2D\u82F1\u6587/\u6807\u70B9\u540C\u4E00\u89C4\u5219\uFF09\uFF0C\u53EA\u641C\u7528\u6237/\u52A9\u624B\u6D88\u606F\uFF08\u5DE5\u5177\u8F93\u51FA\u4E0D\u641C\uFF09\uFF1B\u53EF\u7528 cwd \u9650\u5B9A\u9879\u76EE\uFF08Codex \u4F1A\u8BDD\u8BB0\u5F55\u5DE5\u4F5C\u76EE\u5F55\uFF09\uFF0Csort/limit/window \u63A7\u5236\u7ED3\u679C\u89C4\u6A21\uFF1B**\u96F6\u5E38\u9A7B\u72B6\u6001**\u2014\u2014\u65E0\u7D22\u5F15\u3001\u65E0\u7F13\u5B58\uFF0C\u6BCF\u6B21\u8C03\u7528\u5B9E\u65F6\u53EA\u8BFB\u626B\u63CF\uFF0C\u4E0D\u4FEE\u6539\u4EFB\u4F55\u4F1A\u8BDD\u6587\u4EF6\u3002**\u5F00\u5173**\uFF1A\u72EC\u7ACB\u300C\u4F1A\u8BDD\u641C\u7D22\u300D\uFF08sessionSearchEnabled\uFF0C\u9ED8\u8BA4\u5173\uFF0C\u4E0E COI \u8C03\u5EA6/\u5E7F\u64AD\u65E0\u5173\uFF0C\u53EF\u5355\u72EC\u5F00\u542F\uFF09\u3002',
  "panel.guide.sessionOrch.title": "\u4F1A\u8BDD\u7F16\u6392\uFF08de_session\uFF09",
  "panel.guide.sessionOrch.desc": '\u8BA9 AI **\u7A0B\u5E8F\u5316\u521B\u5EFA/\u5524\u9192 DSH \u4F1A\u8BDD**\uFF08"\u4F1A\u8BDD\u542F\u52A8\u53E6\u4E00\u4E2A\u4F1A\u8BDD"\uFF09\u2014\u2014spawn\uFF1A\u65B0\u5EFA**\u6807\u51C6\u4F1A\u8BDD**\uFF08\u4E0E\u624B\u52A8\u6253\u5F00\u5B8C\u5168\u540C\u6784\uFF1A\u7CFB\u7EDF\u63D0\u793A\u8BCD/\u5DE5\u5177/\u8BB0\u5FC6\u5FEB\u7167/\u6301\u4E45\u5316\uFF0C\u51FA\u73B0\u5728\u5DE6\u4FA7\u4F1A\u8BDD\u5217\u8868\u53EF\u63A5\u7BA1\uFF09\uFF0Cprompt=**\u5B8C\u6574\u63D0\u793A\u8BCD**\uFF08\u89D2\u8272/\u4EFB\u52A1\u81EA\u7531\u7EC4\u5408\u7684\u957F\u6587\u672C\uFF0C\u5982"\u4F60\u662F\u7F8E\u5DE5\uFF0C\u8D1F\u8D23\u2026\u73B0\u5728\u5F00\u59CB\u6267\u884C\uFF1A\u2026"\uFF09\uFF0C\u521B\u5EFA\u540E\u7ACB\u5373\u81EA\u52A8\u5F00\u8DD1\uFF0C\u53EF\u9009 cwd/\u52A0\u5165\u5E7F\u64AD\u623F\u95F4\uFF08roomId\uFF09/\u8986\u76D6\u6A21\u578B\uFF08model\uFF09\uFF1Bwake\uFF1A\u5524\u9192\u5DF2\u6709\u4F1A\u8BDD\uFF08sessionId + \u63D0\u793A\u8BCD\uFF0C\u7B49\u4EF7\u66FF\u7528\u6237\u53D1\u6D88\u606F\uFF0C\u5BF9\u65B9 AI \u81EA\u52A8\u9192\u6765\u5904\u7406\uFF0C\u5FD9\u5219\u6392\u961F\uFF1B\u8FDB\u7A0B\u91CD\u542F\u540E\u81EA\u52A8\u6062\u590D\u518D\u5524\u9192\uFF09\uFF1Bstatus/list\uFF1A\u67E5\u72B6\u6001\uFF08running=\u6B63\u5728\u751F\u6210 / idle=\u5DF2\u505C\u6B62 / offline=\u4E0D\u5728\u672C\u8FDB\u7A0B\uFF0C\u9644 lastActiveAt \u6700\u540E\u6D3B\u52A8\u65F6\u95F4\uFF09\u3002**\u534F\u4F5C\u7EAA\u5F8B**\uFF1A\u4E0D\u4F1A\u81EA\u52A8\u5524\u9192\u4EFB\u4F55\u4F1A\u8BDD\u2014\u2014\u7531\u62CD\u677F\u4EBA\uFF08\u5982\u4EA7\u54C1\u7ECF\u7406\uFF09**\u6709\u610F\u8BC6\u5730** list/status \u67E5\u72B6\u6001\u3001\u53D1\u73B0\u5458\u5DE5\u505C\u6B62\u540E\u4E3B\u52A8 wake \u6D3E\u6D3B\uFF08\u907F\u514D\u7BA1\u7406\u6DF7\u4E71\uFF09\uFF1B**\u8FB9\u754C**\uFF1A\u4EC5\u540C\u8FDB\u7A0B\u4F1A\u8BDD\u53EF\u5524\u9192\uFF1B\u5524\u9192=\u66FF\u7528\u6237\u53D1\u6D88\u606F\uFF08\u5BF9\u65B9 GUI \u53EF\u89C1\u5168\u7A0B\uFF09\u3002**\u5F00\u5173**\uFF1A\u72EC\u7ACB\u300C\u4F1A\u8BDD\u7F16\u6392\u300D\uFF08sessionEnabled\uFF0C\u9ED8\u8BA4\u5173\uFF0C\u4E0E COI/\u5E7F\u64AD/\u641C\u7D22\u4E92\u4E0D\u5F71\u54CD\uFF0C\u53EF\u5355\u72EC\u5F00\u542F\uFF09\uFF1B\u5EFA\u8BAE\u914D\u5408\u300C\u4F1A\u8BDD\u5E7F\u64AD\u300D\u623F\u95F4\u4F7F\u7528\uFF08spawn \u5E26 roomId \u81EA\u52A8\u5165\u623F\uFF09\u3002',
  "panel.guide.uiSettings.title": "DSH UI \u8BBE\u7F6E",
  "panel.guide.uiSettings.desc": "\u7ED9 DSH web \u754C\u9762\u52A0\u6837\u5F0F\u7EA7\u5C0F\u529F\u80FD\uFF08\u7EAF\u5BA2\u6237\u7AEF\u6CE8\u5165\uFF0C\u4E0D\u6539\u6846\u67B6\uFF09\uFF1A\u5404\u529F\u80FD\u7684\u72EC\u7ACB\u5C0F\u5F00\u5173\u5728\u300CDSH UI \u8BBE\u7F6E\u300DTab \u7684\u300C\u7EFC\u5408\u300D\u91CC\u2014\u2014\u4F1A\u8BDD\u7B5B\u9009\uFF08\u5DE6\u4FA7\u5217\u8868\u53EA\u663E\u793A\u8FDB\u884C\u4E2D\uFF09\u3001\u5BF9\u8BDD\u533A\u52A0\u5BBD\uFF08\u4E2D\u95F4\u533A\u57DF\u6269\u5927\u5230\u7EA6 95%\uFF09\u7B49\uFF1B\u540E\u671F\u6269\u5C55\u4E3B\u9898\u66F4\u6362\u3002",
  "panel.guide.confirm.title": "\u786E\u8BA4\u5236\uFF08\u4E3A\u4EC0\u4E48 AI \u4E0D\u80FD\u76F4\u63A5\u5199\uFF09",
  "panel.guide.confirm.desc": "AI \u81EA\u5EFA\u7684\u8BB0\u5FC6\u3001\u5F85\u529E\u3001\u6280\u80FD\u90FD\u5148\u8FDB\u5F85\u786E\u8BA4\u961F\u5217\uFF0C\u7B49\u4F60\u786E\u8BA4\u624D\u751F\u6548\u3002\u56E0\u4E3A\u8FD9\u4E9B\u5199\u5165\u4F1A\u771F\u5B9E\u6539\u53D8 AI \u7684\u884C\u4E3A\uFF1A\u8BB0\u5FC6\u4F1A\u8FDB\u5165\u4E0A\u4E0B\u6587\u3001\u5F85\u529E\u662F\u7ED9\u4F60\u6D3E\u7684\u6D3B\u3001\u6280\u80FD\u4F1A\u6539\u53D8 AI \u7684\u80FD\u529B\u5E93\u2014\u2014\u5982\u679C AI \u64C5\u81EA\u5199\u5165\uFF0C\u53EF\u80FD\u628A\u5B83\u7684\u8BEF\u5224\u5F53\u4E8B\u5B9E\u6C89\u6DC0\u3001\u6216\u81EA\u4F5C\u4E3B\u5F20\u7ED9\u4F60\u6D3E\u6D3B\u3002\u4F60\u662F\u6700\u7EC8\u628A\u5173\u8005\uFF1AAI \u53EA\u63D0\u8BAE\uFF0C\u4F60\u51B3\u5B9A\u3002",
  "panel.guide.best.title": "\u600E\u4E48\u7528\u5F97\u6700\u597D",
  "panel.guide.best.1": '\u8DE8\u4F1A\u8BDD\u8854\u63A5\uFF1A\u9879\u76EE\u7EA6\u5B9A/\u8FDB\u5C55\u76F4\u63A5\u8BF4"\u67E5\u4E00\u4E0B\u8BB0\u5FC6"\uFF0CAI \u4ECE\u9879\u76EE\u65E5\u5FD7\u4E0E\u5173\u952E\u8BB0\u5FC6\u91CC\u63A5\u7EED\uFF0C\u4E0D\u91CD\u590D\u4EA4\u4EE3\u3002',
  "panel.guide.best.2": '\u53E3\u5934\u5373\u8BB0\uFF1A\u60F3\u5230\u4EC0\u4E48\u5C31\u8BF4"\u8BB0\u4F4F\u8FD9\u4E2A / \u8FD9\u4E2A\u8981\u8DDF\u8FDB"\uFF0CAI \u81EA\u52A8\u5206\u7C7B\u6C89\u6DC0\uFF1B\u9694\u51E0\u5929\u56DE\u6765\u8BF4\u4E00\u53E5\u5C31\u80FD\u63A5\u4E0A\u3002',
  "panel.guide.best.3": "\u5B9A\u671F\u786E\u8BA4\uFF1A\u5076\u5C14\u770B\u770B\u300C\u5F85\u786E\u8BA4\u8BB0\u5FC6\u5EFA\u8BAE\u300D\u300C\u5F85\u786E\u8BA4\u5F85\u529E\u5EFA\u8BAE\u300D\u4E24\u4E2A tab\uFF0C\u91C7\u7EB3\u6216\u62D2\u7EDD\u2014\u2014\u8FD9\u662F\u8BB0\u5FC6\u8FDB\u5316\u7684\u786E\u8BA4\u73AF\u8282\u3002",
  "panel.guide.best.4": "\u8DE8\u4F1A\u8BDD\u534F\u4F5C\uFF1A\u590D\u5236\u672C\u4F1A\u8BDD ID \u53D1\u7ED9\u53E6\u4E00\u4E2A\u4F1A\u8BDD\uFF0C\u8BA9\u5B83\u7684 AI \u7528 de_broadcast \u628A\u7ED3\u679C\u5E7F\u64AD\u7ED9\u4F60\uFF08\u53EF\u540C\u65F6\u53D1\u7ED9\u591A\u4E2A\u4F1A\u8BDD\uFF0C\u63A5\u6536\u65B9\u4E0B\u4E00\u8F6E\u81EA\u52A8\u770B\u5230\u672A\u8BFB\u63D0\u793A\uFF09\u3002",
  "panel.guide.loop": "\u95ED\u73AF\uFF1A\u804A \u2192 \u8BB0 \u2192 \u5BA1\u67E5 \u2192 \u6C89\u6DC0 \u2192 \u6267\u884C\u3002\u8FD9\u5957\u673A\u5236\u5C31\u662F AI \u7684\u957F\u671F\u5DE5\u4F5C\u8BB0\u5FC6\u3002",
  "panel.suggestions.approve": "\u91C7\u7EB3",
  "panel.suggestions.archive": "\u5F52\u6863",
  "panel.suggestions.archiveHint": "\u5F52\u6863\uFF1A\u4E0D\u6CE8\u5165\u4F1A\u8BDD\uFF0C\u4EC5\u4FDD\u7559\u5907\u67E5\uFF0C\u9700\u8981\u65F6\u53EF\u79FB\u56DE\u4E3B\u8BB0\u5FC6",
  "panel.suggestions.editHint": "\u91C7\u7EB3\u524D\u53EF\u4FEE\u6539\u6587\u672C\uFF0C\u4FEE\u6539\u540E\u7684\u5185\u5BB9\u5C06\u5199\u5165\u8BB0\u5FC6\u3002",
  "panel.suggestions.reject": "\u62D2\u7EDD",
  "panel.suggestions.approveAll": "\u5168\u90E8\u91C7\u7EB3",
  "panel.suggestions.rejectAll": "\u5168\u90E8\u62D2\u7EDD",
  "panel.suggestions.hits": "\u5DF2\u5EFA\u8BAE {count} \u6B21",
  "panel.suggestions.hitsHint": "\u8BE5\u5185\u5BB9\u5728\u591A\u8F6E\u5BA1\u67E5\u4E2D\u53CD\u590D\u51FA\u73B0\uFF0C\u503C\u5F97\u8BA4\u771F\u786E\u8BA4",
  "panel.suggestions.target.memory": "\u957F\u671F\u8BB0\u5FC6",
  "panel.suggestions.target.user": "\u7528\u6237\u6863\u6848",
  "panel.suggestions.target.key": "\u9879\u76EE\u5173\u952E\u8BB0\u5FC6",
  "panel.suggestions.targetHint": "\u91C7\u7EB3\u65F6\u5199\u5165\u7684\u8F68\uFF1A\u9ED8\u8BA4=AI \u63A8\u8350\u7684\u5206\u7C7B\uFF1B\u53EF\u6539\u4E3A\u66F4\u5408\u9002\u7684\uFF08\u8BB0\u5FC6/\u7528\u6237\u6863\u6848/\u9879\u76EE\u5173\u952E\u8BB0\u5FC6\u90FD\u4F1A\u7ACB\u5373\u6CE8\u5165\u4E0A\u4E0B\u6587\uFF09",
  "panel.suggestions.done": "\u64CD\u4F5C\u5B8C\u6210\uFF1A{text}",
  "panel.archive.title": "\u5DF2\u5F52\u6863\u8BB0\u5FC6",
  "panel.archive.empty": "\u6682\u65E0\u5F52\u6863\u6761\u76EE",
  "panel.archive.help": "\u5F52\u6863\u7684\u5EFA\u8BAE\u4E0D\u4F1A\u6CE8\u5165\u4F1A\u8BDD\uFF0C\u4EC5\u5728\u6B64\u4FDD\u7559\u5907\u67E5\u2014\u2014\u9700\u8981\u65F6\u53EF\u300C\u79FB\u56DE\u4E3B\u8BB0\u5FC6\u300D\uFF08\u5199\u5165\u5BF9\u5E94\u8BB0\u5FC6\u6587\u4EF6\uFF09\u6216\u300C\u5220\u9664\u300D\u3002",
  "panel.archive.promote": "\u79FB\u56DE\u4E3B\u8BB0\u5FC6",
  "panel.archive.delete": "\u5220\u9664",
  "panel.archive.promoted": "\u5DF2\u79FB\u56DE\u4E3B\u8BB0\u5FC6",
  "panel.archive.deleted": "\u5DF2\u5220\u9664\u5F52\u6863\u6761\u76EE",
  "panel.skills.title": "\u5F85\u786E\u8BA4\u6280\u80FD\u5EFA\u8BAE",
  "panel.skills.help": "\u540E\u53F0\u5BA1\u67E5\u4EA7\u51FA\u7684\u65B0\u6280\u80FD\uFF0C\u91C7\u7EB3\u540E\u79FB\u5165\u6280\u80FD\u5E93\uFF08~/.agents/skills\uFF09\u5E76\u968F\u7CFB\u7EDF\u63D0\u793A\u8BCD\u6CE8\u5165\u3002",
  "panel.skills.empty": "\u6CA1\u6709\u5F85\u786E\u8BA4\u7684\u6280\u80FD\u5EFA\u8BAE\u3002",
  "panel.skills.pending": "\u5F85\u91C7\u7EB3",
  "panel.skills.approve": "\u91C7\u7EB3",
  "panel.skills.reject": "\u62D2\u7EDD",
  "panel.skills.done": "\u5DF2{op}\u6280\u80FD",
  "panel.config.title": "\u914D\u7F6E",
  "panel.config.help": "\u4FEE\u6539\u7ACB\u5373\u751F\u6548\u5E76\u6301\u4E45\u5316\uFF08\u8986\u76D6 config.yaml \u7684\u5BF9\u5E94\u9879\uFF09\u3002",
  "panel.config.reviewEnabled": "\u540E\u53F0\u5BA1\u67E5",
  "panel.config.reviewEnabled.hint": "\u81EA\u52A8\u56DE\u987E\u4F1A\u8BDD\u5E76\u6C89\u6DC0\u7ECF\u9A8C\uFF1B\u5173\u95ED\u540E memory/skill \u5DE5\u5177\u4E0E\u8BB0\u5FC6\u5FEB\u7167\u4ECD\u53EF\u7528\uFF0C\u53EA\u662F\u4E0D\u518D\u81EA\u52A8\u5BA1\u67E5",
  "panel.config.reviewInterval": "\u5BA1\u67E5\u95F4\u9694\uFF08\u56DE\u5408\uFF09",
  "panel.config.reviewInterval.hint": "\u6BCF N \u4E2A\u7528\u6237\u56DE\u5408\u81EA\u52A8\u5BA1\u67E5\u4E00\u6B21",
  "panel.config.skillReviewEnabled": "\u6280\u80FD\u81EA\u52A8\u6C89\u6DC0",
  "panel.config.skillReviewEnabled.hint": "\u5173\uFF08\u9ED8\u8BA4\uFF09\uFF1A\u5BA1\u67E5\u521B\u5EFA\u7684\u65B0\u6280\u80FD\u8FDB\u5165\u5F85\u786E\u8BA4\u961F\u5217\uFF0C\u91C7\u7EB3\u540E\u624D\u8FDB\u5165\u6280\u80FD\u5E93\uFF1B\u5F00\uFF1A\u5BA1\u67E5\u76F4\u63A5\u521B\u5EFA\u6280\u80FD\uFF0C\u65E0\u9700\u786E\u8BA4\uFF08\u6280\u80FD\u6CE8\u5165\u6240\u6709\u4F1A\u8BDD\uFF0C\u8BF7\u8C28\u614E\u5F00\u542F\uFF09",
  "panel.config.perTurnProjectWrites": "\u6BCF\u56DE\u5408\u5199\u5165\u9879\u76EE\u8BB0\u5FC6",
  "panel.config.perTurnProjectWrites.hint": "\u8981\u6C42\u6A21\u578B\u6BCF\u4E2A\u56DE\u5408\u7ED3\u675F\u524D\u4E3B\u52A8\u68C0\u67E5\u5E76\u8BB0\u5F55\u9879\u76EE\u76F8\u5173\u65B0\u4E8B\u5B9E\uFF08\u5173\u952E\u51B3\u7B56/\u8FDB\u5C55/\u8E29\u5751\uFF09\uFF1B\u5173\u95ED\u540E\u9879\u76EE\u8BB0\u5FC6\u4EC5\u6309\u9700\u8BFB\u53D6\u3002\u26A0\uFE0F \u4F9D\u8D56 LLM \u6307\u4EE4\u9075\u5FAA\uFF0C\u5F31\u9075\u5FAA\u7684\u6A21\u578B\u4E0D\u4E00\u5B9A\u4F1A\u6267\u884C",
  "panel.config.perTurnDailyWrites": "\u6BCF\u56DE\u5408\u5199\u5165\u6BCF\u65E5\u65E5\u5FD7",
  "panel.config.perTurnDailyWrites.hint": "\u8981\u6C42\u6A21\u578B\u6BCF\u4E2A\u56DE\u5408\u7ED3\u675F\u524D\u4E3B\u52A8\u68C0\u67E5\u5E76\u8BB0\u5F55\u5F53\u5929\u8FDB\u5C55\uFF1B\u5173\u95ED\u540E\u6BCF\u65E5\u65E5\u5FD7\u4EC5\u6309\u9700\u8BFB\u53D6\u3002\u26A0\uFE0F \u4F9D\u8D56 LLM \u6307\u4EE4\u9075\u5FAA\uFF0C\u5F31\u9075\u5FAA\u7684\u6A21\u578B\u4E0D\u4E00\u5B9A\u4F1A\u6267\u884C",
  "panel.config.perTurnKeyWrites": "\u6BCF\u56DE\u5408\u68C0\u67E5\u9879\u76EE\u5173\u952E\u8BB0\u5FC6",
  "panel.config.perTurnKeyWrites.hint": "\u8981\u6C42\u6A21\u578B\u6BCF\u4E2A\u56DE\u5408\u7ED3\u675F\u524D\u5224\u65AD\u662F\u5426\u51FA\u73B0\u91CD\u8981\u9879\u76EE\u4E8B\u5B9E\uFF08\u957F\u671F\u7EA6\u5B9A/\u51B3\u7B56/\u67B6\u6784/\u8E29\u5751\uFF09\uFF0C\u6709\u5219\u5199\u5165 target=key\uFF08\u81EA\u52A8\u6CE8\u5165\u4E0A\u4E0B\u6587\uFF09\uFF0C\u6CA1\u6709\u5C31\u8DF3\u8FC7\uFF1B\u5173\u95ED\u540E key \u4EC5\u4FDD\u7559\u624B\u52A8\u6DFB\u52A0\u4E0E\u8BFB\u53D6\u3002\u26A0\uFE0F \u4F9D\u8D56 LLM \u6307\u4EE4\u9075\u5FAA",
  "panel.config.coiEnabled": "COI \u8C03\u5EA6",
  "panel.config.coiEnabled.hint": "\u542F\u7528 de_coi_* \u5DE5\u5177\u4E0E\u300CCOI \u8C03\u5EA6\u300DTab\uFF1A\u7EDF\u4E00\u8C03\u5EA6 kimi/codex/grok/hermes \u7B49 CLI \u4EE3\u7406\uFF08\u9ED8\u8BA4\u7981\u7528\u2014\u2014\u672C\u63D2\u4EF6\u7684\u672C\u804C\u662F\u8BB0\u5FC6/\u5F85\u529E/\u6280\u80FD\uFF0C\u8C03\u5EA6\u662F\u6309\u9700\u589E\u5F3A\uFF1B\u5173\u95ED\u65F6\u5DE5\u5177\u4E0E Tab \u5B8C\u5168\u4E0D\u53EF\u89C1\uFF09",
  "panel.config.scratchEnabled": "\u4E34\u65F6\u4FE1\u606F Tab",
  "panel.config.scratchEnabled.hint": "\u542F\u7528\u300C\u4E34\u65F6\u4FE1\u606F\u300DTab\uFF1A\u6301\u4E45\u5316 Markdown \u4FBF\u7B7E\uFF0C\u4E34\u65F6\u60F3\u6CD5\u968F\u624B\u8BB0\uFF08\u81EA\u52A8\u4FDD\u5B58\u5230 ~/.dsh/memories/scratch.md\uFF0C\u91CD\u542F\u4E0D\u4E22\uFF0C\u53EF\u968F\u65F6\u8FC1\u79FB\u6216\u5220\u9664\uFF09\u3002\u9ED8\u8BA4\u5173\u95ED\uFF1B\u5173\u95ED\u65F6 Tab \u5B8C\u5168\u4E0D\u53EF\u89C1",
  "panel.config.searchDocsEnabled": "\u672C\u5730\u6587\u4EF6\u641C\u7D22\u5DE5\u5177",
  "panel.config.searchDocsEnabled.hint": '\u8BA9\u6A21\u578B\u5728\u672C\u673A\u6240\u6709\u78C1\u76D8/\u76EE\u5F55\u4E2D\u641C\u7D22\u6587\u4EF6\u3002**\u56DB\u6863\u6A21\u5F0F**\uFF1A\u90FD\u542F\u7528 = \u6587\u4EF6\u540D + \u5185\u5BB9\u68C0\u7D22\u90FD\u53EF\u7528\uFF1B\u4EC5\u6587\u4EF6\u540D = content/contentQuery \u53C2\u6570\u88AB\u5FFD\u7565\uFF08\u4E0D\u8BFB\u4EFB\u4F55\u6587\u4EF6\u5185\u5BB9\uFF0C\u9002\u5408\u5185\u5BB9\u68C0\u7D22\u7528\u522B\u7684\u5B9E\u73B0\u7684\u4EBA\uFF09\uFF1B\u4EC5\u5185\u5BB9 = \u6BCF\u6B21\u8C03\u7528\u90FD\u505A\u5185\u5BB9\u5339\u914D\uFF08query \u89C6\u4E3A\u5185\u5BB9\u5173\u952E\u8BCD\uFF09\uFF1B\u5173\u95ED = \u5DE5\u5177\u5BF9\u6A21\u578B\u5B8C\u5168\u4E0D\u53EF\u89C1\u3002\u5185\u5BB9\u68C0\u7D22\uFF1AcontentQuery="\u5173\u952E\u8BCD" \u5373\u641C"\u54EA\u4E2A\u6587\u6863\u91CC\u63D0\u8FC7 XX"\uFF08rg \u5168\u6587\u5339\u914D\uFF0C\u8FD4\u56DE\u547D\u4E2D\u7247\u6BB5\uFF09\u3002\u9ED8\u8BA4\u5173\u95ED',
  "panel.config.searchDocsMode.all": "\u90FD\u542F\u7528\uFF08\u6587\u4EF6\u540D + \u5185\u5BB9\uFF09",
  "panel.config.searchDocsMode.filename": "\u4EC5\u6587\u4EF6\u540D\u641C\u7D22",
  "panel.config.searchDocsMode.content": "\u4EC5\u5185\u5BB9\u641C\u7D22",
  "panel.config.searchDocsMode.off": "\u5173\u95ED\uFF08\u5DE5\u5177\u4E0D\u53EF\u89C1\uFF09",
  "panel.config.broadcastEnabled": "\u4F1A\u8BDD\u5E7F\u64AD",
  "panel.config.broadcastEnabled.hint": "\u542F\u7528\u4F1A\u8BDD\u5E7F\u64AD\uFF08de_broadcast\uFF09\uFF1ADSH \u4F1A\u8BDD\u95F4\u6D88\u606F\u4F20\u9012\u2014\u2014\u5FEB\u7167\u300C\u4F1A\u8BDD\u5E7F\u64AD\u300D\u672A\u8BFB\u63D0\u793A\uFF08\u6536\u4EF6\u7BB1\u5F0F\u5217\u51FA id+\u4E3B\u9898+\u53D1\u9001\u8005+\u65F6\u95F4\uFF09+ de_broadcast \u5DE5\u5177\uFF08send/list/read\uFF0Cread \u5373\u6D88\u8D39\u3001\u5168\u8BFB\u540E\u81EA\u52A8\u5220\u9664\u30018KB \u843D\u6587\u4EF6\u300130 \u5929\u6E05\u7406\uFF09+ \u4F1A\u8BDD\u5E7F\u64AD\u7BA1\u7406\u9762\u677F Tab\u3002**\u72EC\u7ACB\u4E8E COI \u8C03\u5EA6**\uFF08\u9ED8\u8BA4\u5173\u95ED\uFF0C\u53EF\u5355\u72EC\u5F00\u542F\uFF09\uFF1B\u5173\u95ED\u65F6\u4EE5\u4E0A\u5168\u90E8\u4E0D\u53EF\u89C1\uFF1B\u300C\u4F60\u7684\u4F1A\u8BDD ID\u300D\u5E38\u9A7B\u5FEB\u7167\u6BB5\u4E0D\u53D7\u5F71\u54CD\uFF1B\u4F1A\u8BDD\u5934\u90E8\u300C\u29C9 \u590D\u5236\u4F1A\u8BDDID\u300D\u300C\u270E \u522B\u540D\u300D\u6309\u94AE\u5C5E\u300C\u4F1A\u8BDD\u7F16\u6392\u300D\u6A21\u5757\uFF08\u9762\u677F\u9876\u90E8\u53E6\u6709\u590D\u5236\u5165\u53E3\uFF09",
  "panel.config.notifyEnabled": "\u6E20\u9053\u901A\u77E5",
  "panel.config.notifyEnabled.hint": '\u542F\u7528\u6E20\u9053\u901A\u77E5\uFF08de_notify\uFF09\uFF1AAI \u5B8C\u6210\u4EFB\u52A1\u540E\u901A\u8FC7 IM \u6E20\u9053\uFF08\u4E00\u671F\uFF1A\u98DE\u4E66\uFF09**\u4E3B\u52A8\u53D1\u901A\u77E5**\u7ED9\u4F60\u2014\u2014de_notify \u624B\u52A8\u5DE5\u5177\uFF08\u968F\u65F6\u53EF\u53D1\u3001\u65E0\u9891\u7387\u9650\u5236\uFF09+ COI \u4EFB\u52A1\u5B8C\u6210\u81EA\u52A8\u901A\u77E5\uFF08COI \u8FD0\u884C\u65F6\u914D\u7F6E coiNotifyChannels \u9009\u6E20\u9053\uFF09\u3002**\u72EC\u7ACB\u5B50\u6A21\u5757\uFF0C\u9ED8\u8BA4\u5173\u95ED**\uFF1B\u4F9D\u8D56\u5BF9\u5E94\u6E20\u9053\u63D2\u4EF6\uFF08dsh-feishu \u7B49\uFF09\u5DF2\u5B89\u88C5\uFF08\u6E20\u9053\u672A\u88C5\u4F1A\u5982\u5B9E\u62A5"\u6E20\u9053\u4E0D\u53EF\u7528"\uFF0C\u4E0D\u5F71\u54CD\u4E3B\u63D2\u4EF6\uFF09\uFF1B\u5173\u95ED\u65F6\u5DE5\u5177\u4E0D\u6CE8\u518C\u3001COI \u81EA\u52A8\u901A\u77E5\u9759\u9ED8\u8DF3\u8FC7',
  "panel.config.sessionSearchEnabled": "\u4F1A\u8BDD\u641C\u7D22",
  "panel.config.sessionSearchEnabled.hint": "\u542F\u7528 de_session_search\uFF1A\u8BA9\u6A21\u578B\u641C\u7D22\u672C\u673A\u5176\u4ED6 AI \u5DE5\u5177\u7684\u5386\u53F2\u4F1A\u8BDD\uFF08\u5F53\u524D\u652F\u6301 Codex\uFF1A~/.codex/sessions \u4E0E archived_sessions \u7684\u660E\u6587 JSONL\u2014\u2014rg \u9884\u7B5B\u540E\u6BEB\u79D2\u7EA7\uFF1BDSH \u4F1A\u8BDD\u6682\u4E0D\u652F\u6301\uFF09\u3002\u5927\u5C0F\u5199\u4E0D\u654F\u611F\u7684\u5B57\u9762\u5339\u914D\uFF0C\u53EA\u641C\u7528\u6237/\u52A9\u624B\u6D88\u606F\uFF1B\u652F\u6301 cwd \u9879\u76EE\u8FC7\u6EE4\u3001relevance/newest/oldest \u6392\u5E8F\u3001limit/window \u63A7\u5236\u89C4\u6A21\u3002**\u72EC\u7ACB\u5B50\u6A21\u5757**\uFF08\u9ED8\u8BA4\u5173\u95ED\uFF0C\u53EF\u5355\u72EC\u5F00\u542F\uFF0C\u4E0E COI \u8C03\u5EA6/\u5E7F\u64AD\u65E0\u5173\uFF09\uFF1B\u96F6\u5E38\u9A7B\u72B6\u6001\uFF1A\u65E0\u7D22\u5F15\u3001\u65E0\u7F13\u5B58\uFF0C\u6BCF\u6B21\u8C03\u7528\u5B9E\u65F6\u53EA\u8BFB\u626B\u63CF\uFF0C\u4E0D\u4FEE\u6539\u4EFB\u4F55\u4F1A\u8BDD\u6587\u4EF6\uFF1B\u5173\u95ED\u65F6\u5DE5\u5177\u5BF9\u6A21\u578B\u5B8C\u5168\u4E0D\u53EF\u89C1",
  "panel.config.sessionEnabled": "\u4F1A\u8BDD\u7F16\u6392",
  "panel.config.sessionEnabled.hint": "\u542F\u7528\u4F1A\u8BDD\u7F16\u6392\uFF08de_session\uFF09\uFF1A\u8BA9 AI **\u7A0B\u5E8F\u5316\u521B\u5EFA/\u5524\u9192 DSH \u4F1A\u8BDD**\u2014\u2014spawn \u65B0\u5EFA\u6807\u51C6\u4F1A\u8BDD\uFF08\u4E0E\u624B\u52A8\u6253\u5F00\u5B8C\u5168\u540C\u6784\uFF1A\u7CFB\u7EDF\u63D0\u793A\u8BCD/\u5DE5\u5177/\u8BB0\u5FC6\u5FEB\u7167/\u6301\u4E45\u5316\uFF0C\u51FA\u73B0\u5728\u5DE6\u4FA7\u4F1A\u8BDD\u5217\u8868\u53EF\u63A5\u7BA1\uFF09\uFF0Cprompt=\u5B8C\u6574\u63D0\u793A\u8BCD\uFF08\u89D2\u8272/\u4EFB\u52A1\u81EA\u7531\u7EC4\u5408\u7684\u957F\u6587\u672C\uFF09\uFF0C\u521B\u5EFA\u540E\u7ACB\u5373\u81EA\u52A8\u5F00\u8DD1\uFF0C\u53EF\u9009 cwd/\u52A0\u5165\u5E7F\u64AD\u623F\u95F4/\u8986\u76D6\u6A21\u578B\uFF1Bwake \u5524\u9192\u5DF2\u6709\u4F1A\u8BDD\uFF08\u7B49\u4EF7\u66FF\u7528\u6237\u53D1\u6D88\u606F\uFF0C\u5BF9\u65B9 AI \u81EA\u52A8\u9192\u6765\u5904\u7406\uFF0C\u8FDB\u7A0B\u91CD\u542F\u540E\u81EA\u52A8\u6062\u590D\uFF09\uFF1Bstatus/list \u67E5\u72B6\u6001\uFF1B**\u4F1A\u8BDD\u5934\u90E8\u300C\u29C9 \u590D\u5236\u4F1A\u8BDDID\u300D\u300C\u270E \u522B\u540D\u300D\u6309\u94AE\u968F\u672C\u5F00\u5173**\uFF08\u4F1A\u8BDD\u8EAB\u4EFD\u529F\u80FD\uFF0C\u66FE\u8BEF\u6302\u5728\u5E7F\u64AD\u4E0B\uFF09\u3002**\u72EC\u7ACB\u5B50\u6A21\u5757**\uFF08\u9ED8\u8BA4\u5173\u95ED\uFF1B\u4F9D\u8D56 DSH agents \u670D\u52A1\uFF0C\u4EC5\u540C\u8FDB\u7A0B\u4F1A\u8BDD\u53EF\u5524\u9192\uFF1B\u5173\u95ED\u65F6\u5DE5\u5177\u5BF9\u6A21\u578B\u4E0D\u53EF\u89C1\uFF09",
  "panel.config.promptsEnabled": "\u63D0\u793A\u8BCD\u7BA1\u7406\u5668",
  "panel.config.promptsEnabled.hint": "\u542F\u7528\u300C\u63D0\u793A\u8BCD\u300DTab\uFF1A\u63D0\u793A\u8BCD\u5E93\uFF08\u7528\u6237\u81EA\u5199\u8303\u5F0F + \u5185\u7F6E\u793A\u4F8B\uFF09+ \u6CE8\u5165\u8F68\uFF08\u4E00\u6B21\u6027/\u6301\u7EED N \u8F6E/\u6BCF M \u56DE\u5408\u4E00\u6B21\uFF0C\u6B21\u6570\u4E0E\u95F4\u9694\u53EF\u8F93\u5165\u4EFB\u610F\u6570\u5B57\u2014\u2014\u5199\u5165\u540E\u6A21\u578B\u4E0B\u4E00\u8F6E\u81EA\u52A8\u770B\u5230\uFF0C\u56DE\u5408\u9012\u51CF\u81EA\u52A8\u8FC7\u671F\uFF0C\u53EF\u968F\u65F6\u505C\u6B62\uFF1B\u4E0D\u5EFA\u63D0\u793A\u8BCD\u4E5F\u80FD\u4E34\u65F6\u6CE8\u5165\uFF0C\u81EA\u52A8\u5165\u5E93\u5F52\u5165\u300C\u4E34\u65F6\u300D\u5206\u7C7B\uFF09\u3002\u9ED8\u8BA4\u5173\u95ED\uFF1B\u5173\u95ED\u65F6\u5FEB\u7167\u6BB5/\u4E8B\u4EF6\u76D1\u542C/API \u5168\u90E8\u5378\u8F7D\uFF0CTab \u5237\u65B0\u540E\u9690\u85CF",
  "panel.config.modelsEnabled": "\u6A21\u578B\u914D\u7F6E",
  "panel.config.modelsEnabled.hint": "\u542F\u7528\u300C\u6A21\u578B\u914D\u7F6E\u300DTab + de_models \u5DE5\u5177\uFF1A\u8868\u683C\u5C55\u793A DSH \u4F9B\u5E94\u5546/\u6A21\u578B\uFF0C\u7ED9\u6BCF\u4E2A\u6A21\u578B\u8BBE\u7F6E\u542F\u7528\u72B6\u6001\u3001\u5907\u6CE8\u3001\u662F\u5426\u652F\u6301\u601D\u8003\u3001\u53EF\u7528/\u63A8\u8350\u601D\u8003\u7B49\u7EA7\uFF08\u53EF\u52A0\u81EA\u5B9A\u4E49\u7B49\u7EA7\uFF09\uFF1Bde_models \u4F9B AI \u67E5\u8BE2\u53EF\u7528\u6A21\u578B\u6E05\u5355\u3002**\u9ED8\u8BA4\u5173\u95ED**\uFF08\u6CE8\u518C\u5373\u5360\u6A21\u578B\u5DE5\u5177\u5217\u8868\uFF0C\u9700\u8981\u65F6\u518D\u5F00\uFF09\uFF1B\u26A0\uFE0F \u672C\u6A21\u5757\u7684\u914D\u7F6E**\u53EA\u5BF9\u63D2\u4EF6\u81EA\u8EAB\u6709\u7528\uFF0C\u4E0D\u4FEE\u6539\u4E5F\u4E0D\u5F71\u54CD DSH \u7684\u6A21\u578B\u8BBE\u7F6E**\uFF08DSH \u4FA7\u4ECD\u4EE5\u5B98\u65B9\u300C\u8BBE\u7F6E \u2192 \u6A21\u578B\u300D\u4E3A\u51C6\uFF09\u3002\u5173\u95ED\u65F6 Tab \u4E0E\u5DE5\u5177\u9690\u85CF\u3001API \u62D2\u7EDD\u8BBF\u95EE\uFF0C\u914D\u7F6E\u6570\u636E\u4FDD\u7559",
  "panel.config.uiSettingsEnabled": "DSH UI \u8BBE\u7F6E",
  "panel.config.uiSettingsEnabled.hint": "\u542F\u7528\u300CDSH UI \u8BBE\u7F6E\u300D\u6A21\u5757\uFF1A\u5DE6\u4FA7\u4F1A\u8BDD\u5217\u8868\u9876\u90E8\u51FA\u73B0\u7B5B\u9009\u6761\uFF0C\u9ED8\u8BA4\u53EA\u663E\u793A\u8FDB\u884C\u4E2D\u7684\u4F1A\u8BDD\uFF08\u6B63\u5728\u751F\u6210/\u7B49\u5BA1\u6279/\u7B49\u56DE\u7B54/\u6709\u5B50\u4EE3\u7406\u5728\u8DD1/\u51FA\u9519/\u5DF2\u5B8C\u6210\u672A\u67E5\u770B\u2014\u2014\u7EAF idle \u7684\u6298\u53E0\u9690\u85CF\uFF09\uFF0C\u53EF\u4E00\u952E\u5207\u56DE\u5168\u90E8\uFF1B\u7EAF\u5BA2\u6237\u7AEF\u6837\u5F0F\u589E\u5F3A\uFF08CSS + DOM \u6CE8\u5165\uFF0C\u4E0D\u6539 DSH \u6846\u67B6\uFF09\uFF1B\u7B5B\u9009\u504F\u597D\u8BB0\u5728\u6D4F\u89C8\u5668\u672C\u5730\u3002**\u9ED8\u8BA4\u5173\u95ED**\uFF1B\u5173\u95ED\u65F6\u7B5B\u9009\u6761\u4E0E\u6CE8\u5165\u6837\u5F0F\u5168\u90E8\u79FB\u9664",
  "panel.config.save": "\u4FDD\u5B58\u914D\u7F6E",
  "panel.reveal.title": "\u6253\u5F00\u6587\u4EF6",
  "panel.reveal.help": "\u7528\u7CFB\u7EDF\u5DE5\u5177\u6253\u5F00\u8BB0\u5FC6\u76EE\u5F55\u4E0E\u8BB0\u5FC6\u6587\u4EF6\u3002\u26A0\uFE0F \u968F\u610F\u7F16\u8F91\u53EF\u80FD\u7834\u574F \xA7 \u5206\u9694\u683C\u5F0F\u3001\u5BFC\u81F4\u8BB0\u5FC6\u8BFB\u53D6\u9519\u4E71\uFF0C\u8BF7\u8C28\u614E\u4FEE\u6539\u3002",
  "panel.reveal.memoryDir": "\u8BB0\u5FC6\u76EE\u5F55",
  "panel.reveal.memoryFile": "\u5168\u5C40\u8BB0\u5FC6",
  "panel.reveal.userFile": "\u7528\u6237\u6863\u6848",
  "panel.reveal.archiveMemoryFile": "\u5F52\u6863\u8BB0\u5FC6",
  "panel.reveal.archiveUserFile": "\u5F52\u6863\u7528\u6237",
  "panel.reveal.dailyDir": "\u6BCF\u65E5\u65E5\u5FD7\u76EE\u5F55",
  "panel.reveal.dailyFile": "\u4ECA\u65E5\u65E5\u5FD7",
  "panel.reveal.projectsDir": "\u9879\u76EE\u8BB0\u5FC6\u76EE\u5F55",
  "panel.reveal.skillDir": "\u6280\u80FD\u76EE\u5F55",
  "panel.reveal.agentsFile": "\u5168\u5C40\u89C4\u5219 (AGENTS.md)",
  "panel.config.saved": "\u914D\u7F6E\u5DF2\u4FDD\u5B58\u5E76\u751F\u6548",
  "panel.config.failed": "\u64CD\u4F5C\u5931\u8D25\uFF1A{message}",
  "panel.loading": "\u52A0\u8F7D\u4E2D\u2026"
};
var en = {
  "tab.label": "Skill Manager",
  "tab.label.alt": "Skill Manager",
  "header.title": "Skill Manager",
  "header.subtitle": "Manage every skill \xB7 custom dirs \xB7 enable/disable \xB7 view & edit",
  "search.placeholder": "Search skills by name, description, or when-to-use\u2026",
  "search.empty": "No matching skills",
  "filter.all": "All",
  "status.enabled": "Enabled",
  "disable": "Disable",
  "enable": "Enable",
  "disabled.badge": "Disabled",
  "disabled.hint": "Disabled: excluded from the model skill catalog",
  "protected.badge": "System",
  "protected.hint": "System skill (project source) \u2014 cannot be disabled",
  "toggle.failed": "Toggle failed: {message}",
  "manage.dirs": "Manage custom skill directories",
  "dirs.title": "Custom Skill Directories",
  "dirs.help": "Add directories containing skills (<dir>/<skill>/SKILL.md or <dir>/<skill>.md layouts). Directories persist in the plugin state.json and reload automatically after restart; paths overlapping an existing skill root are rejected.",
  "dirs.placeholder": "Absolute path, e.g. ~/.hermes/skills/\u2026",
  "dirs.add": "Add",
  "dirs.remove": "Remove",
  "dirs.empty": "No custom directories yet",
  "dirs.missing": "Directory missing",
  "pager.prev": "Prev",
  "pager.next": "Next",
  "pager.page": "Page {page} / {total}",
  "skills.count": "{count} skills",
  "roots.count": "{count} roots",
  "pane.skills": "Skills",
  "pane.files": "Files",
  "pane.editor": "Editor",
  "no.skill.selected": "Select a skill on the left to start browsing",
  "no.root": "This skill has no browsable local directory",
  "no.entries": "Empty directory",
  "no.file": "Select a text file to view or edit",
  "not.text": "Not a text file \u2014 cannot preview",
  "too.large": "File exceeds the 512 KiB read cap",
  "read.failed": "Read failed: {message}",
  "write.failed": "Save failed: {message}",
  "save": "Save",
  "saving": "Saving\u2026",
  "saved": "Saved",
  "edit": "Edit",
  "cancel": "Cancel",
  "discard": "Discard",
  "dirty.hint": "Unsaved changes",
  "readonly": "Read-only",
  "bytes": "{size} B",
  "kib": "{size} KiB",
  "mib": "{size} MiB",
  "dir.up": "Parent directory",
  "open.folder": "Open directory",
  "source.badge": "{source}",
  "invocable": "Invocable",
  "when.to.use": "When to use",
  "description": "Description",
  "resource.directory": "Directory",
  "resource.url": "Link",
  "resource.opaque": "Resource",
  "refresh": "Refresh",
  "loading.skills": "Loading skills\u2026",
  "loading.dir": "Loading\u2026",
  "tree.collapse": "Collapse",
  "tree.expand": "Expand",
  "path": "Path",
  "root.label": "Root",
  "editor.placeholder": "Select a text file in the tree on the left to start editing.",
  "status.ready": "Ready",
  "status.skill": "Skill",
  "status.file": "File",
  "status.unsaved": "Unsaved",
  "status.saved": "Saved",
  "confirm.discard.title": "Discard unsaved changes?",
  "confirm.discard.body": "Your changes to {name} are not saved. Switching files will lose them.",
  "confirm.discard.ok": "Discard changes",
  "mtime.label": "Modified {time}",
  "open.in.new.tab": "Open in new tab",
  "preview": "Preview",
  "memoryTab.label": "Memory",
  "memoryTab.label.pending": "\u{1F534} Memory ({count})",
  "skillsTab.label": "Skills",
  "skillsTab.label.pending": "\u{1F534} Skills ({count})",
  "todosTab.label": "Todos",
  "todosTab.label.pending": "\u{1F534} Todos ({count})",
  "coiTab.label": "COI Dispatch",
  "coiTab.label.pending": "\u{1F534} COI Dispatch ({count})",
  "broadcastTab.label": "Broadcast",
  "broadcast.tab.guide": "Guide",
  "broadcast.tab.messages": "Messages",
  "broadcast.tab.rooms": "Rooms",
  "broadcast.tab.settings": "Settings",
  "broadcast.settings.wsCoord.title": "Workspace coordination (ws-coord)",
  "broadcast.settings.wsCoord.desc": 'Resource-occupancy coordination for parallel sessions in one workspace \u2014 declare files you will modify (de_ws_declare), auto-register writes, write-conflict detection (soft warning / hard block switchable), and de_ws_status to see "who is running and what they are doing". These switches only control this sub-feature; the "Session broadcast" master switch lives under Memory Evolve Settings \u2192 Config.',
  "broadcast.settings.wsCoord.enabled": "Enable workspace coordination",
  "broadcast.settings.wsCoord.enabled.hint": 'Registers de_ws_declare / de_ws_status / de_ws_release tools + write-conflict detection listeners + the activity snapshot section. Depends on the "Session broadcast" master switch (unavailable while broadcast is off). Off by default',
  "broadcast.settings.wsCoord.snapshot": "Activity snapshot section",
  "broadcast.settings.wsCoord.snapshot.hint": "When \u22652 sessions are active in the workspace, inject one \u3010Workspace activity\u3011 line into the per-turn snapshot (with the current time and what each session is doing); zero cost with 0-1 active sessions",
  "broadcast.settings.wsCoord.enforce": "Hard-block mode",
  "broadcast.settings.wsCoord.enforce.hint": "Off by default (soft mode: trust the AI \u2014 conflicts warn but never block); when on, writes to files occupied by other sessions are denied at the tool layer (deny), and the AI sees the reason and adjusts on its own",
  "broadcast.guide.intro.title": "What is Session Broadcast",
  "broadcast.guide.intro.body": 'Session broadcast = a message channel between DSH sessions: send messages to other sessions (AI sends them via the de_broadcast send tool), and the receiver sees a "Session broadcast" notice in its next snapshot. Messages are managed like an inbox \u2014 subject + summary, auto-deleted once every recipient has read them.',
  "broadcast.guide.send.title": "How to send",
  "broadcast.guide.send.body": `Just tell the AI "broadcast to session XX\u2026" (default is one-to-one; recipient = the other session's ID):`,
  "broadcast.guide.send.item1": 'One-to-one: specify the recipient session ID (send your "copy session ID" result to the other side so its AI can reach you);',
  "broadcast.guide.send.item2": "Room: multi-member chat room, cross-working-directory, visible to all members (send to room:<roomId>);",
  "broadcast.guide.send.item3": "Project: visible to all sessions in that working directory (send to project:/absolute/path).",
  "broadcast.guide.inbox.title": "Inbox (Messages tab)",
  "broadcast.guide.inbox.body": "The list shows only **unread** non-room messages by default (read ones are hidden; room messages live inside the room):",
  "broadcast.guide.inbox.item1": "Filters: unread / all / read; search by subject, sender, content; 20 per page;",
  "broadcast.guide.inbox.item2": '"Expand" shows the full content; red "Delete" = admin delete (invisible to everyone);',
  "broadcast.guide.inbox.item3": "One-to-one messages auto-delete once all recipients have read them (consumed, no clutter).",
  "broadcast.guide.room.title": "Rooms tab",
  "broadcast.guide.room.body": "Rooms = multi-member collaboration chat rooms:",
  "broadcast.guide.room.item1": "Expand a room to see member presence: \u{1F7E2} running = generating now (you may wait for it / it sees new messages this turn), \u26AA idle/unknown = turn finished or never seen (don't wait);",
  "broadcast.guide.room.item2": "Room messages support the same filter/search/pagination; creators can kick members and dissolve rooms (system notice sent);",
  "broadcast.guide.room.item3": "Dissolved rooms keep their records for audit; members can no longer join or send.",
  "broadcast.guide.alias.title": "Session aliases",
  "broadcast.guide.alias.body": "Give a session a friendly name (\u226410 chars) \u2014 shown in snapshots, lists and messages as alias (short ID):",
  "broadcast.guide.alias.item1": 'The "My session" row at top: copy session ID / copy alias, share it to start chatting;',
  "broadcast.guide.alias.item2": "Or use \u29C9 copy session ID / \u270E alias in the session header (top-right).",
  "broadcast.guide.switch.title": "Switch",
  "broadcast.guide.switch.body": 'Session broadcast is off by default: enable the "Session broadcast" toggle under "Config" in the "Settings" tab, then refresh to reveal this tab.',
  "broadcast.mySessionId": "My session ID",
  "broadcast.copyId": "Copy",
  "broadcast.copied": "Copied",
  "broadcast.loading": "Loading\u2026",
  "broadcast.refresh": "Refresh",
  "broadcast.messages.empty": "(no messages)",
  "broadcast.messages.sender": "From",
  "broadcast.messages.to": "To",
  "broadcast.messages.direct": "direct",
  "broadcast.messages.room": "room",
  "broadcast.messages.project": "project",
  "broadcast.messages.unread": "unread",
  "broadcast.messages.long": "long",
  "broadcast.message.expand": "Expand",
  "broadcast.message.collapse": "Collapse",
  "broadcast.message.delete": "Delete",
  "broadcast.message.deleteConfirm": "Delete this message? (admin action, invisible to everyone)\n\n{subject}",
  "broadcast.message.deleted": "Deleted",
  "broadcast.copyAlias": "Copy alias",
  "broadcast.msg.unread": "unread",
  "broadcast.msg.read": "read",
  "broadcast.filter.unread": "Unread",
  "broadcast.filter.all": "All",
  "broadcast.filter.read": "Read",
  "broadcast.searchPh": "Search subject/sender/content\u2026",
  "broadcast.pagePrev": "Prev",
  "broadcast.pageNext": "Next",
  "broadcast.pageInfo": "Page {page}/{total}",
  "broadcast.room.detail": "Details",
  "broadcast.room.messages": "Room messages",
  "broadcast.room.messages.empty": "(no room messages)",
  "broadcast.messages.roomInRooms": "Room messages live inside their room \u2014 open it from the Rooms view",
  "broadcast.rooms.empty": "(no rooms)",
  "broadcast.roomSearchPh": "Search room name\u2026",
  "broadcast.roomStatus.all": "All",
  "broadcast.roomStatus.active": "Active",
  "broadcast.roomStatus.dissolved": "Dissolved",
  "broadcast.roomDays.0": "Any time",
  "broadcast.roomDays.7": "Last 7 days",
  "broadcast.roomDays.30": "Last 30 days",
  "broadcast.room.status.active": "active",
  "broadcast.room.status.idle": "idle",
  "broadcast.room.status.dissolved": "dissolved",
  "broadcast.room.online": "{online}/{total} online",
  "broadcast.room.members": "Members",
  "broadcast.room.kick": "Kick",
  "broadcast.room.kickConfirm": "Kick member {member}? (a system notice is sent; the session loses room access)",
  "broadcast.room.dissolve": "Dissolve",
  "broadcast.room.dissolveConfirm": 'Dissolve room "{name}"? (soft delete: record kept for traceability, members get a system notice, no further joins/messages)',
  "broadcast.room.dissolved": "dissolved",
  "broadcast.room.copyId": "Copy room id",
  "broadcast.room.lastActive": "Last active",
  "broadcast.room.created": "Created",
  "broadcast.room.presence.unknown": "unknown \xB7 no activity recorded",
  "header.copySessionId": "\u29C9 Copy session ID",
  "header.copySessionId.done": "\u2713 Copied",
  "header.copySessionId.title": "Copy this session's ID (send it to another session: tell its AI your session ID so it can broadcast to you via de_broadcast)",
  "header.setAlias": "\u270E Alias",
  "header.setAlias.title": "Set a session alias (\u226410 chars) \u2014 shown as your friendly name in the snapshot / broadcast panel / messages",
  "header.setAlias.placeholder": "alias (\u226410 chars)",
  "header.setAlias.save": "Save",
  "header.setAlias.clear": "Clear",
  "header.setAlias.saved": "Alias saved",
  "header.setAlias.cleared": "Alias cleared",
  "scratchTab.label": "Scratch Pad",
  "promptTab.label": "Prompt Injection",
  "promptTab.label.active": "\u{1F534} Prompt Injection ({count})",
  "settingsTab.label": "Memory Evolve Settings",
  "settingsTab.feature.guide": "Guide",
  "settingsTab.feature.config": "Config",
  "memoryTab.feature.guide": "Guide",
  "memoryTab.feature.suggestions": "Memory suggestions",
  "skillsTab.feature.guide": "Guide",
  "skillsTab.feature.skills": "Skill suggestions",
  "skillsTab.feature.skillBrowser": "Skill manager",
  "todosTab.feature.guide": "Guide",
  "todosTab.feature.todoSuggestions": "Todo suggestions",
  "todosTab.feature.todo": "Todos",
  "modelsTab.label": "Models",
  "modelsTab.feature.models": "Models",
  "modelsTab.feature.guide": "Guide",
  "modelsTab.guide.what.title": "What is Model Config",
  "modelsTab.guide.what.body": "A table view of every DSH provider and model, with per-model plugin-side settings (enabled state, note, reasoning levels). All settings belong to this plugin (models.json) \u2014 DSH configuration is never touched and nothing couples to other plugins.",
  "modelsTab.guide.what.item1": 'Columns: enabled toggle, provider (with DSH active state), model (name + ID), context/output capacity, reasoning levels, note; search and a "show reasoning" toggle;',
  "modelsTab.guide.what.item2": "Per model: enable/disable (plugin-scope availability marker, does not change DSH routing), note, thinking support, allowed reasoning levels, recommended level, custom levels;",
  "modelsTab.guide.what.item3": "Settings persist immediately (<memoryDir>/models.json) and survive restarts;",
  "modelsTab.guide.config.title": "Per-model settings",
  "modelsTab.guide.config.body": 'Expand a row ("Configure levels") to edit reasoning settings:',
  "modelsTab.guide.config.item1": "Enable/disable: decides which models de_models lists by default (all enabled by default);",
  "modelsTab.guide.config.item2": "Support thinking: when off, the model cannot reason (only the off level stays available);",
  "modelsTab.guide.config.item3": 'Recommended level: defaults to "Auto" (follow the model), or pick any available level manually;',
  "modelsTab.guide.config.item4": "Allowed levels: check which levels may be used (all by default); custom levels (e.g. ultra) can be added and removed.",
  "modelsTab.guide.config.item5": 'Image input: models that explicitly declare image support show a "\u{1F5BC} Image input" badge (from DSH model capability metadata inputModalities, read-only); absent = unknown, no badge.',
  "modelsTab.guide.tool.title": "de_models tool (for AI)",
  "modelsTab.guide.tool.body": "This module also registers the de_models tool so the AI can query the available model (endpoint) list:",
  "modelsTab.guide.tool.item1": 'Only "enabled" models are listed by default (all=true shows everything including disabled); filterable by provider;',
  "modelsTab.guide.tool.item2": "Each model returns: enabled, DSH active, image input support (supportsImage: true/false/null=unknown), thinking support, usable reasoning levels (with recommended and custom levels), note.",
  "modelsTab.guide.switch.title": "Switch",
  "modelsTab.guide.switch.body": 'Model config is on by default; it can be turned off independently in the "Memory Evolve Settings" tab ("Config") like other modules \u2014 the tab and the de_models tool hide, settings data is kept.',
  "modelsTab.searchPh": "Search provider, model, or note\u2026",
  "modelsTab.showReasoning": "Show reasoning levels",
  "modelsTab.refresh": "Refresh",
  "modelsTab.loading": "Loading\u2026",
  "modelsTab.count": "{total} models \xB7 {enabled} enabled",
  "modelsTab.loadFailed": "Load failed: {message}",
  "modelsTab.empty": "(No models)",
  "modelsTab.enabled": "Enabled",
  "modelsTab.enable": "Enable",
  "modelsTab.disable": "Disable",
  "modelsTab.provider": "Provider",
  "modelsTab.model": "Model",
  "modelsTab.capacity": "Context/Output",
  "modelsTab.reasoning": "Reasoning",
  "modelsTab.note": "Note",
  "modelsTab.notePh": "Add a note\u2026",
  "modelsTab.dormant": "Inactive",
  "modelsTab.thinking": "Support thinking",
  "modelsTab.thinkingHint": "When off, this model cannot reason (only the off level stays available)",
  "modelsTab.thinkingOff": "Thinking off",
  "modelsTab.supportsImage": "\u{1F5BC} Image input",
  "modelsTab.supportsImageHint": "This model explicitly declares image input support (from DSH model capability metadata inputModalities)",
  "modelsTab.recommendedLevel": "Recommended level",
  "modelsTab.recommendedAuto": "Auto (follow model recommendation)",
  "modelsTab.levelsNone": "All disabled",
  "modelsTab.editLevels": "Configure levels",
  "modelsTab.closeEditor": "Collapse",
  "modelsTab.editorTitle": "Available reasoning levels (check = allowed; recommended comes from the model)",
  "modelsTab.recommended": "Recommended",
  "modelsTab.addLevel": "Add",
  "modelsTab.removeLevel": "Remove",
  "modelsTab.levelIdPh": "Level ID (e.g. ultra)",
  "modelsTab.levelNamePh": "Display name (e.g. Ultra)",
  "modelsTab.save": "Save",
  "modelsTab.saving": "Saving\u2026",
  "modelsTab.cancel": "Cancel",
  // DSH UI Settings tab (ui-settings-hub): module intro (guide sub-tab) +
  // future extension seat (themes etc.). The real feature (session filter)
  // is a global DOM enhancement independent of this tab; the feature
  // switches (uiSettings.feature.*) are consumed by the "General" sub-tab
  // and broadcast via event for apply() to sync DOM injection.
  "uiSettingsTab.label": "DSH UI Settings",
  "uiSettingsTab.feature.mixed": "General",
  "uiSettingsTab.feature.guide": "Guide",
  "uiSettingsTab.features.title": "Feature switches",
  "uiSettingsTab.features.help": 'Every feature has its own small switch, **all off by default** \u2014 you turn them on deliberately; changes apply immediately (features stay under "General" until they mature and get their own categories).',
  "uiSettingsTab.guide.what.title": "What is DSH UI Settings",
  "uiSettingsTab.guide.what.body": "Style-level tweaks for the DSH web GUI \u2014 no framework source changes, pure client-side injection (CSS + DOM enhancement) that survives DSH updates; future extensions (themes, etc.) all land in this module.",
  "uiSettingsTab.guide.switch.title": "Switches",
  "uiSettingsTab.guide.switch.body": 'The module switch lives in the "Config" sub-tab of the "Memory Evolve Settings" tab (off by default); the per-feature switches live in the "General" sub-tab of this tab \u2014 also all off by default, turned on deliberately.',
  // Feature-switch row labels (rendered by the "General" sub-tab).
  "uiSettings.feature.sessionFilter": "Session filter",
  "uiSettings.feature.sessionFilter.hint": "The left session list shows only active sessions (purely idle ones collapse; one click switches back to all); the filter bar appears only while this is on",
  "uiSettings.feature.wideChat": "Wide conversation area",
  "uiSettings.feature.wideChat.hint": "Widen the conversation transcript/input area from roughly half to about 95% of the right pane (aligned with the tabs bar above)",
  "uiSettings.feature.wideBubble": "Wide message bubble",
  "uiSettings.feature.wideBubble.hint": 'Widen the user message bubble from its 525px cap to about 80% of the content column (pairs well with "Wide conversation area")',
  "uiSettings.feature.contextWarn": "Context usage warning",
  "uiSettings.feature.contextWarn.hint": "The context-usage ring beside the input box turns yellow above 30% occupancy and red above 40%; back to its default color below the threshold",
  "uiSettings.feature.mermaidRender": "Mermaid diagram rendering",
  "uiSettings.feature.mermaidRender.hint": "Render mermaid code blocks in messages as diagrams (DSH itself does not render mermaid); the engine loads lazily on first diagram, works on PC and mobile alike, and falls back to the code block on failure",
  // Filter-bar button labels (consumed by session-filter.ts injected DOM).
  "uiSettings.filter.on": "Running only",
  "uiSettings.filter.off": "All",
  "uiSettings.running.label": "{count} running",
  "uiSettings.ungrouped": "Ungrouped",
  // Session bookmarks (independent submodule, bookmarkEnabled off by default):
  "bookmarkTab.label": "Bookmarks",
  "bookmark.tab.list": "List",
  "bookmark.tab.guide": "Guide",
  "bookmark.list.title": "Session bookmarks",
  "bookmark.list.help": "Click a bookmark to jump to that turn; star \u2606 at each turn tail to bookmark, \u2605 when bookmarked (rename/delete); searchable list; fork from any turn (official mid-turn branch buttons are taken over by Memory Evolve).",
  "bookmark.refresh": "Refresh",
  "bookmark.loading": "Loading\u2026",
  "bookmark.empty": "(No bookmarks yet \u2014 click \u2606 at a turn tail)",
  "bookmark.defaultLabel": "Turn {n}",
  "bookmark.turn": "Turn {n}",
  "bookmark.prompt.create": "Bookmark name (editable):",
  "bookmark.prompt.rename": "New name:",
  "bookmark.confirm.delete": 'Delete bookmark "{label}"?',
  "bookmark.noSession": "Cannot determine the current session (refresh the page and retry)",
  "bookmark.search.placeholder": "Search bookmarks\u2026",
  "bookmark.search.empty": "(No matching bookmarks)",
  "bookmark.star.title.off": "\u2606 Bookmark this turn (Memory Evolve session bookmarks)",
  "bookmark.star.title.on": "\u2605 Bookmarked: {label} (Memory Evolve \u2014 click to rename/delete)",
  "bookmark.menu.rename": "Rename",
  "bookmark.menu.delete": "Delete",
  "bookmark.action.jump": "Jump",
  "bookmark.action.fork": "Fork",
  "bookmark.action.rename": "Rename",
  "bookmark.action.delete": "Delete",
  "bookmark.fork.title": "Fork from this turn (Memory Evolve enhancement)",
  "bookmark.fork.confirm": "Officially you can only fork from the last message. Fork from this turn (seq {n}) anyway? (Memory Evolve enhancement)",
  "bookmark.fork.working": "Creating fork session\u2026",
  "bookmark.fork.ok": "New session created: {id} (see the session list on the left)",
  "bookmark.jump.hint": "Click to jump to this turn",
  "bookmark.jumping": "Locating\u2026",
  "bookmark.jump.ok": 'Jumped to "{label}"',
  "bookmark.jump.notFound": 'Could not find the message for "{label}" (may be compacted or outside the loaded window)',
  "bookmark.jump.noChat": "Chat tab not found \u2014 cannot jump",
  "bookmark.renamed": "Renamed",
  "bookmark.deleted": "Deleted",
  "bookmark.error": "Failed: {message}",
  "bookmark.guide.what.title": "What are session bookmarks",
  "bookmark.guide.what.body": "Tag any completed turn, then jump back from the list in one click, or fork an official branch session from any turn. Stored in a plugin sidecar (never touches official session logs); official mid-turn branch buttons are taken over by Memory Evolve (confirm dialog, then the official fork path).",
  "bookmark.guide.star.title": "How to star",
  "bookmark.guide.star.body": 'Each completed turn tail has a \u2606 button: click to name it (default "Turn N") and bookmark; \u2605 means bookmarked \u2014 click again to rename or delete. Small icon, does not crowd Copy/Branch.',
  "bookmark.guide.list.title": "List and jump",
  "bookmark.guide.list.body": "This tab lists all bookmarks for the current session (label, turn, time, summary). Click to jump: switches back to the Chat tab and scrolls to data-chat-anchor-key; if the target is outside the loaded history window it pulls older pages first.",
  "bookmark.guide.switch.title": "Switch",
  "bookmark.guide.switch.body": 'Off by default; enable "Session bookmarks" under Memory Evolve Settings \u2192 Config. When off, stars and this tab hide; the sidecar file is kept.',
  "panel.guide.bookmark.title": "Session bookmarks",
  "panel.guide.bookmark.desc": "Star any turn and jump back from the list; fork official branch sessions from any turn (including taking over official mid-turn branch buttons). Independent switch, off by default.",
  "panel.config.bookmarkEnabled": "Session bookmarks",
  "panel.config.bookmarkEnabled.hint": 'Enable session bookmarks: a \u2606 star on each completed turn tail + a Bookmarks tab for the list and jump; fork official branch sessions from any turn (list "Fork" button, or click the official branch button \u2014 mid-turn buttons are taken over with a confirm dialog). Data lives in <memoryDir>/session-bookmarks.json (per-session, keyed by turn seq). **Independent submodule** (off by default; pure UI + host API, no AI tools); when off, stars and the tab hide, the data file is kept.',
  // Legacy keys kept for compatibility (old merged memory-tab layout).
  "memoryTab.feature.config": "Config",
  "memoryTab.feature.todoSuggestions": "Todo suggestions",
  "memoryTab.feature.skills": "Skill suggestions",
  "memoryTab.feature.skillBrowser": "Skill manager",
  "memoryTab.feature.todo": "Todos",
  // Memory-tab guide (the "Guide" sub-tab: detailed intro of the memory feature itself).
  "memoryTab.guide.tracks.title": "Five memory tracks",
  "memoryTab.guide.tracks.body": "Memory is organized in five tracks; injection scope narrows by tier and tracks never pollute each other:",
  "memoryTab.guide.tracks.item1": "User profile (user): who you are, preferences, communication style \u2014 injected into every session;",
  "memoryTab.guide.tracks.item2": "Long-term memory (memory): environment/tools/global conventions \u2014 injected into every session;",
  "memoryTab.guide.tracks.item3": "Project key facts (key): long-lived facts of the current project (conventions/decisions/architecture/pitfalls) \u2014 injected into current-project sessions, filtered by git branch;",
  "memoryTab.guide.tracks.item4": "Project log (project): progress stream of the current project \u2014 never injected, read on demand by the AI;",
  "memoryTab.guide.tracks.item5": "Daily log (daily): per-day progress records \u2014 never injected, read on demand.",
  "memoryTab.guide.files.title": "File tabs",
  "memoryTab.guide.files.body": "This tab previews AGENTS.md and every memory file (read-only \u2014 edit via the memory tool or a system editor to avoid breaking the \xA7-delimited format):",
  "memoryTab.guide.files.item1": "Pretty view: \xA7 entry cards (time/branch/tag badges + content), searchable, switchable to raw text view;",
  "memoryTab.guide.files.item2": "The KEY tab can add long-lived project facts manually (branch scope selectable); they inject from the next turn;",
  "memoryTab.guide.files.item3": "Every entry can be edited (injected tracks require confirmation), deleted (exact whole-entry match), archived/promoted.",
  "memoryTab.guide.branch.title": "Git branch awareness",
  "memoryTab.guide.branch.body": "Different branches of the same project can carry completely different conventions; project-level memory tracks the current branch end to end:",
  "memoryTab.guide.branch.item1": 'Key entries can carry a branch-scope tag (untagged = visible on every branch); only "untagged + covering current branch" entries are injected;',
  "memoryTab.guide.branch.item2": "Log entries carry an automatic source-branch tag ([git branch]), so cross-branch reviews never mix things up.",
  "memoryTab.guide.maintain.title": "Edit & maintain",
  "memoryTab.guide.maintain.body": "All memory maintenance happens right here:",
  "memoryTab.guide.maintain.item1": "Edit content only \u2014 timestamps/branch/tags are program-maintained;",
  "memoryTab.guide.maintain.item2": "Delete by exact whole-entry match (never substring \u2014 no accidental deletion of longer entries containing it), irreversible;",
  "memoryTab.guide.maintain.item3": "Archive/promote: memory/user/key \u2194 archive files, both directions; archived entries are never injected and can be promoted back anytime.",
  "memoryTab.guide.suggestions.title": "Memory suggestions",
  "memoryTab.guide.suggestions.body": "Review-produced memory suggestions enter a pending queue first (confirmation system \u2014 the AI proposes, you decide):",
  "memoryTab.guide.suggestions.item1": "Approve: edit the text if needed, optionally pick the target track (memory/user/key), then it is written and injected with the snapshot;",
  "memoryTab.guide.suggestions.item2": "Archive: kept out of the injected memory, can be promoted back; Reject: dropped.",
  "memoryTab.guide.confirm.title": "Confirmation system",
  "memoryTab.guide.confirm.body": "Memory writes genuinely change the AI's behavior (they enter the context and affect later replies), so everything goes through your confirmation first \u2014 that is the gate of memory evolution.",
  // Skills-tab guide (the "Guide" sub-tab: detailed intro of the skill feature itself).
  "skillsTab.guide.what.title": "What a skill is",
  "skillsTab.guide.what.body": "A skill = a methodology document for the AI (SKILL.md: frontmatter name/description + body): injected into every session's system prompt, so the AI follows the process next time it meets the same kind of task.",
  "skillsTab.guide.what.item1": "The skill library lives in ~/.agents/skills by default (one directory per skill);",
  "skillsTab.guide.what.item2": "DSH also scans project skills, bundled skills and custom dirs \u2014 all visible in this tab.",
  "skillsTab.guide.how.title": "How skills form",
  "skillsTab.guide.how.body": "Methodologies learned the hard way can be solidified into skills:",
  "skillsTab.guide.how.item1": 'Background review creates them: new skills land in "Skill suggestions" first, approved ones move into the library;',
  "skillsTab.guide.how.item2": "The skill_manage tool: the model creates/updates skills directly (read-before-write protection);",
  "skillsTab.guide.how.item3": 'Creation stays restrained: only "repeatedly painful, hard, likely reused later" skills \u2014 keep the library lean.',
  "skillsTab.guide.pending.title": "Skill suggestions",
  "skillsTab.guide.pending.body": "New skills from review are confirmed here:",
  "skillsTab.guide.pending.item1": "Approve: moved into the skill library (~/.agents/skills), injected with the system prompt, available to every session;",
  "skillsTab.guide.pending.item2": "Reject: dropped.",
  "skillsTab.guide.manager.title": "Skill manager",
  "skillsTab.guide.manager.body": "The full skill manager (three panes: skill list / directory tree / file view-edit):",
  "skillsTab.guide.manager.item1": "Every skill grouped by source (user user-* / custom / bundled / project project-*), searchable and filterable;",
  "skillsTab.guide.manager.item2": "Custom skill dirs: add/remove any skill directory (<dir>/<skill>/SKILL.md or <dir>/<skill>.md layout);",
  "skillsTab.guide.manager.item3": "File browsing & editing: directory tree + text view/edit (scoped to the skill dir; out-of-scope/binary/oversized rejected);",
  "skillsTab.guide.manager.item4": "Disabled list and custom dirs persist and restore automatically after restart.",
  "skillsTab.guide.disable.title": "Disable / enable",
  "skillsTab.guide.disable.body": "One click removes a skill from the model's skill catalog (runtime shadow \u2014 the model no longer sees it and the skill tool refuses to load it):",
  "skillsTab.guide.disable.item1": "Re-enable anytime; the choice persists;",
  "skillsTab.guide.disable.item2": "System skills (project source) are structurally protected and cannot be disabled.",
  "skillsTab.guide.dirs.title": "Custom skill directories",
  "skillsTab.guide.dirs.body": 'Add/remove your own skill directories in "Skill manager" (e.g. ~/.hermes/skills); paths overlapping an existing skill root are rejected; persisted and reloaded after restart.',
  "skillsTab.guide.restraint.title": "Creation discipline",
  "skillsTab.guide.restraint.body": "Skills are injected into every session's system prompt and affect context/cache \u2014 create sparingly:",
  "skillsTab.guide.restraint.item1": 'Only create skills that are "hard to solve after repeated tries, high difficulty, likely reused later";',
  "skillsTab.guide.restraint.item2": "Never create skills for one-off or trivial tasks.",
  // Todos-tab guide (the "Guide" sub-tab: detailed intro of the todo feature itself).
  "todosTab.guide.tracks.title": "Four todo tracks",
  "todosTab.guide.tracks.body": "Todos are filed by target, isomorphic to the memory system:",
  "todosTab.guide.tracks.item1": "Life: personal errands;",
  "todosTab.guide.tracks.item2": "Work: cross-project tasks;",
  "todosTab.guide.tracks.item3": "This project: todos of the current working directory (invisible from other dirs \u2014 cwd-scoped);",
  "todosTab.guide.tracks.item4": "Today (daily): per-day todo files, with past days browsable (grouped by date).",
  "todosTab.guide.add.title": "How to add",
  "todosTab.guide.add.body": "Two ways:",
  "todosTab.guide.add.item1": 'Tell the AI "remember / I need to do X" (optionally work/life/this project/today) \u2014 it files the todo into the right track directly;',
  "todosTab.guide.add.item2": "Use the add box in this tab (quadrant and due date optional).",
  "todosTab.guide.pending.title": "Todo suggestions",
  "todosTab.guide.pending.body": "AI-proposed todos enter a pending queue first \u2014 the AI cannot assign you work on its own:",
  "todosTab.guide.pending.item1": "Approve: written into the matching track (a todo stays a todo \u2014 it can never become memory);",
  "todosTab.guide.pending.item2": "Archive: kept aside; Reject: dropped.",
  "todosTab.guide.attrs.title": "Status & attributes",
  "todosTab.guide.attrs.body": "Every todo carries full metadata:",
  "todosTab.guide.attrs.item1": "Quadrant (q1 important & urgent ~ q4 neither), due date, optional category;",
  "todosTab.guide.attrs.item2": "Status: pending / doing / done (done timestamp auto-stamped) / blocked / cancelled;",
  "todosTab.guide.attrs.item3": "List or board view: list filters by track + status/quadrant; board lays out the four Eisenhower quadrants; per-item done/restore, inline edit, delete (confirmed); status badge cycles on click.",
  "todosTab.guide.view.title": "Smart view",
  "todosTab.guide.view.body": "By default only items needing attention are shown (overdue / due today / current project / important-urgent, max 8):",
  "todosTab.guide.view.item1": 'Past daily todos load on demand \u2014 history is queried only when the "Past" tab is opened;',
  "todosTab.guide.view.item2": 'Expired leftovers stay hidden unless "Show expired" is ticked (no extra load).',
  "todosTab.guide.remind.title": "Due reminders",
  "todosTab.guide.remind.body": "The AI checks todos at the end of every turn and reminds you of overdue/due items in its reply \u2014 you never have to keep track yourself.",
  "todo.track.life": "Life",
  "todo.track.all": "All",
  "todo.track": "Track",
  "todo.track.work": "Work",
  "todo.track.project": "This project",
  "todo.track.daily": "Today",
  "todo.track.past": "Past",
  "todo.projectHint": "No working directory for this session \u2014 project todos unavailable (life/work/today only).",
  "todo.help": "Four tracks: Life=personal errands; Work=cross-project tasks; This project=the current working directory's todos (invisible from other dirs); Today=today's tasks (one file per day). Past daily todos (earlier days) are not loaded by default \u2014 open the \u201CPast\u201D tab or tick \u201CShow expired\u201D to query history (expired leftovers stay hidden until then). To add: type content, optionally pick a quadrant (important \xD7 urgent) and a due date, then hit Add \u2014 or just tell me \u201Cadd a todo, it's for work/life/this project/today\u201D and I will file it in the right track.",
  "todo.showExpired": "Show expired",
  "todo.pastHint": "Past daily todos are mostly expired leftovers and are hidden by default; tick \u201CShow expired\u201D to view them.",
  "todo.addPlaceholder": "Type a todo (multi-line ok), pick quadrant/due, add\u2026",
  "todo.add": "Add",
  "todo.added": "Todo added",
  "todo.done": "Done",
  "todo.undone": "Restore",
  "todo.edit": "Edit",
  "todo.save": "Save",
  "todo.cancel": "Cancel",
  "todo.updated": "Updated",
  "todo.deleted": "Deleted",
  "todo.deleteConfirm": "Delete this todo? This cannot be undone.\n\n{snippet}",
  "todo.due": "Due",
  "todo.overdue": "Overdue",
  "todo.all": "All",
  "todo.filterStatus": "Status",
  "todo.filterQuadrant": "Quadrant",
  "todo.status.active": "Active",
  "todo.status.pending": "Pending",
  "todo.status.doing": "Doing",
  "todo.status.done": "Done",
  "todo.status.blocked": "Blocked",
  "todo.status.cancelled": "Cancelled",
  "todo.quadrant": "Quadrant",
  "todo.quadrant.none": "Unclassified",
  "todo.quadrant.q1": "Important & urgent",
  "todo.quadrant.q2": "Important, not urgent",
  "todo.quadrant.q3": "Urgent, not important",
  "todo.quadrant.q4": "Neither",
  "todo.empty": "(No todos yet \u2014 add one)",
  // List / Eisenhower board view switch
  "todo.view.mode": "View",
  "todo.view.list": "List",
  "todo.view.board": "Board",
  "todo.board.empty": "No todos in this quadrant",
  "todo.board.cycleStatus": "Click to cycle status",
  "memoryTab.cwd": "Session working directory",
  "memoryTab.loading": "Loading\u2026",
  "memoryTab.warning": "These files are \xA7-delimited structured memory. If you open them with a system tool, edit with caution \u2014 careless changes can break the format and corrupt memory reads.",
  "memoryTab.readonly": "Read-only",
  "memoryTab.open": "Open file",
  "memoryTab.opened": "Opened with the system tool",
  "memoryTab.empty": "(missing or empty)",
  "memoryTab.noCwd": "(no working directory for this session \u2014 project memory unavailable)",
  "memoryTab.truncated": "(content truncated for display)",
  "memoryTab.pagePrev": "Previous",
  "memoryTab.pageNext": "Next",
  "memoryTab.pageInfo": "Page {page}/{total} \xB7 {count} entries",
  "memoryTab.viewPretty": "Pretty view",
  "memoryTab.viewRaw": "Raw text",
  "memoryTab.searchPlaceholder": "Search content, time or tag\u2026",
  "memoryTab.noResults": "No matching entries \u2014 try another keyword.",
  "memoryTab.projectTag": "Project tag",
  "memoryTab.entryCount": "{count} entries",
  "memoryTab.keyAddHelp": "Manually add a durable project fact (convention/decision/architecture/pitfall); it is written to KEY.md and injected into the context from the next turn on.",
  "memoryTab.keyAddPlaceholder": "Type a key project fact, e.g. this project uses pnpm workspaces\u2026",
  "memoryTab.keyAdd": "Save",
  "memoryTab.keyAdded": "Key fact saved \u2014 it will be injected from the next turn",
  "memoryTab.delete": "Delete",
  "memoryTab.deleteConfirm": "Delete this memory entry? This cannot be undone.\n\n{snippet}",
  "memoryTab.deleted": "Entry deleted",
  "memoryTab.edit": "Edit",
  "memoryTab.save": "Save",
  "memoryTab.cancel": "Cancel",
  "memoryTab.updated": "Entry updated",
  "memoryTab.editHint": "Content only: timestamps and branch tags are program-maintained and cannot be changed; the \xA7 delimiter cannot be typed.",
  "memoryTab.editConfirm": "This entry is injected into the session context (the model's prompt) right after saving. Save anyway?\n\n{snippet}",
  "memoryTab.archive": "Archive",
  "memoryTab.archiveConfirm": "Archive this entry? It leaves the main memory (no longer injected) and can be promoted back any time.\n\n{snippet}",
  "memoryTab.archived": "Archived (no longer injected; can be promoted back)",
  "memoryTab.promote": "Promote to memory",
  "memoryTab.promoted": "Promoted back into the main memory",
  "memoryTab.keyScope": "Branch scope",
  "memoryTab.keyScopeLabel": "Branch",
  "memoryTab.keyScopeAll": "All branches",
  "memoryTab.keyScopeAllHint": "All branches = visible everywhere",
  "memoryTab.keyScopeAllWeight": "(checking it clears branch picks)",
  "memoryTab.keyScopeHint": "Click to change the branch scope",
  "memoryTab.keyScopeSaved": "Branch scope updated",
  "memoryTab.keyScopeSave": "Save",
  "memoryTab.keyScopeCancel": "Cancel",
  "memoryTab.keyBranchInfo": "current branch: {branch} \u2014 only untagged entries or entries covering this branch are injected",
  "memoryTab.gitBranch": "The git branch this record belongs to",
  "memoryTab.dshOnly": "DSH-only",
  "memoryTab.dshOnlyHint": "This entry is injected into DSH sessions only; external executors (COI tasks) skip it \u2014 for DSH-specific discipline/rules/architecture facts",
  "memoryTab.dshOnlyOn": "DSH-only",
  "memoryTab.dshOnlyOff": "Unmark DSH-only",
  "memoryTab.dshOnlySet": "Marked DSH-only (skipped when injecting into external executors)",
  "memoryTab.dshOnlyRemoved": "DSH-only mark removed (visible to external executors)",
  "memoryTab.dshOnlyToggleHint": "Toggle the DSH-only mark: the entry reaches DSH sessions only, external executors (COI) skip it",
  "memoryTab.dshOnlyAdd": "DSH-only (do not inject into external executors)",
  "memoryTab.desc.project": "Project log: auto-recorded per turn; never injected, read on demand by the model.",
  "memoryTab.desc.key": "Key project facts: conventions/decisions/pitfalls, injected into this project's sessions; written when important, addable/deletable manually.",
  "memoryTab.desc.daily": "Daily log: per-day progress records with program-tagged project labels; never injected, read on demand.",
  "memoryTab.desc.user": "User profile: preferences and habits, injected into every session; writes need review + confirmation.",
  "memoryTab.desc.memory": "Long-term memory: global environment/project facts, injected into every session; writes need review + confirmation.",
  "memoryTab.desc.archive-user": "Archived user facts: not good enough for the main track, never injected; can be promoted back or deleted.",
  "memoryTab.desc.archive-memory": "Archived memory facts: not good enough for the main track, never injected; can be promoted back or deleted.",
  "memoryTab.desc.archive-key": "Archived key project facts: not good enough for the main track (or paused from injection), never injected; can be promoted back or deleted.",
  "memoryTab.desc.agents": "Global rules: cross-session user rules (AGENTS.md), injected with the system prompt.",
  "panel.suggestions.title": "Pending memory suggestions",
  "panel.suggestions.empty": "No pending suggestions.",
  "panel.suggestions.help": "Global-track suggestions produced by the background review: approve writes them into the memory files (injected with the snapshot); archive keeps them aside (never injected); reject drops them.",
  "panel.todoSuggestions.title": "Pending todo suggestions",
  "panel.todoSuggestions.empty": "No pending todo suggestions.",
  "panel.todoSuggestions.help": "Todo suggestions from the background review: approve writes into the matching todo track (a todo stays a todo); archive keeps aside; reject drops.",
  "panel.guide.title": "Guide",
  "panel.guide.intro": "memory_evolve is a \u201Cmemory & self-evolution\u201D toolkit: it turns conversations into durable memory, todos and skills \u2014 the AI gets to know you better over time and never loses context across sessions.",
  "panel.guide.memory.title": "Memory read/write (memory tool)",
  "panel.guide.memory.desc": "Five tracks: global memory, user profile, project key facts (auto-injected and git-branch aware \u2014 only key facts relevant to the current branch reach the AI\u2019s context), project log, daily log. When switching projects or resuming later, just ask the AI \u2014 it reads the memory and picks up where you left off.",
  "panel.guide.review.title": "Memory review (self-evolution)",
  "panel.guide.review.desc": "Every N turns the AI distills what is worth remembering and submits it as a suggestion for your confirmation \u2014 it never writes into the memory on its own.",
  "panel.guide.todo.title": "Todos (dtodo)",
  "panel.guide.todo.desc": "Just tell the AI \u201Cremember / I need to do X\u201D and it becomes a structured todo (auto-sorted into life/work/project/daily, with priority and due date); the AI reminds you when things are due. AI-proposed todos wait in the todo-suggestions tab for your confirmation.",
  "panel.guide.skill.title": "Skills (skill_manage)",
  "panel.guide.skill.desc": "Methodologies learned the hard way can be solidified into reusable skills, so the same kind of task runs on a proven process next time. Creation stays restrained: only high-reuse skills; the skill manager lets you browse, search and enable/disable any skill (disabled skills are never loaded by the AI).",
  "panel.guide.search.title": "Local search (memory_evolve_search_local_files)",
  "panel.guide.search.desc": 'When memory is not enough and local material is needed, the AI can search by file name \u2014 not just documents: images, code, configs, anything relevant to the project (documents only by default; full-type search available when explicitly requested). **Content search** is also available \u2014 ask "which document mentions XX" (contentQuery enables it). **Four modes** (under Config): all (name + content) / filename only / content only / off \u2014 some people prefer their own content-search implementation, so filename-only is a first-class mode. **Off by default**: the tool is invisible to the model.',
  "panel.guide.coi.title": "COI dispatch (de_coi)",
  "panel.guide.coi.desc": 'Dispatch tasks to external CLI agents (kimi/codex/grok/hermes\u2026): unified non-blocking scheduling, live progress, auto-tiered session management with one-click resume, cross-COI relay, archived results that also sink into memory. Just say \u201Chave kimi/codex do X\u201D, or open the CLI Dispatch tab to dispatch manually. **Disabled by default**: enable the COI dispatch toggle under "Config" in the "Memory Evolve Settings" tab (tools take effect immediately; the tab appears after a refresh).',
  "panel.guide.prompt.title": "Prompt manager",
  "panel.guide.prompt.desc": 'Turn recurring working paradigms into prompt assets (built-in programmer examples: code review/debugging/architecture/tests\u2026; write your own as the main source). Pick one and inject \u2014 the content becomes visible to the model next turn without interrupting the reply; supports one-shot, N consecutive turns, or once every M turns (count and cadence accept any integers, auto-expiring by turn counting), and can be stopped anytime. Quick inject is also supported: type content and inject without saving a prompt first \u2014 it is auto-saved to the library (empty category goes to Temp). **Disabled by default**: enable the prompt manager toggle under "Config" in the "Memory Evolve Settings" tab; the tab appears after a refresh.',
  "panel.guide.models.title": "Model config (de_models)",
  "panel.guide.models.desc": 'The "Model Config" tab + `de_models` tool: a table of every DSH provider and model, with **plugin-side** per-model settings (enabled state, note, thinking support, allowed/recommended reasoning levels \u2014 checkable level whitelist, custom levels). **These settings only affect this plugin** (they define the de_models query view and the tab display); **they do not modify or affect DSH\'s own model settings** \u2014 DSH model configuration remains whatever the official "Settings \u2192 Models" says. **Disabled by default**: turn on "Model config" under "Config" and the tab appears after a refresh, with the de_models tool active.',
  "panel.guide.broadcast.title": "Session broadcast (de_broadcast)",
  "panel.guide.broadcast.desc": `Pass messages between DSH sessions: copy this session's ID (the "\u29C9 Copy session ID" button in the session header), send the ID to another session, and let its AI broadcast content back to you via de_broadcast send (recipients can be an array of session IDs; one-to-one by default) \u2014 the receiver's snapshot gets a targeted unread hint (inbox-style: id + subject + sender + time; visible only to the receiver) and the AI reads/processes it with list/read (explicit-recipient messages are consumed on read and auto-deleted once every recipient read; room/project messages stay 30 days for review); content over 8 KB spills to a file. **Rooms (chat rooms)**: multi-session collaboration (cross-directory) \u2014 room-create (creator joins automatically) \u2192 share the room id (paste or broadcast) \u2192 others room-join \u2192 then just say "post to the room" and everyone gets it; room-leave to exit, room-rm to dissolve (creator only), room-list to view; idle rooms are auto-deleted after 30 days. **Project group**: recipients project:/path posts to the whole directory (matched by cwd). **Switch**: independent "Session broadcast" (broadcastEnabled, off by default, can be enabled alone \u2014 unrelated to COI dispatch). Also, the snapshot always leads with a persistent "Your session ID" section (regardless of any switch) \u2014 the AI uses it to tell who is who in message sender/recipients and shares its ID when replying to a broadcast.`,
  "panel.guide.session.title": "Session search (de_session_search)",
  "panel.guide.session.desc": 'Lets the AI search historical sessions of other local AI tools (Codex for now: plain JSONL under ~/.codex/sessions and archived_sessions \u2014 rg prefilter keeps it millisecond-fast; DSH sessions not supported yet) \u2014 just ask "did Codex do X before" and the AI finds matching sessions with the strongest message snippet and a context window; case-insensitive literal matching over user/assistant messages only (tool output excluded); cwd filters by project (Codex sessions record their working directory), sort/limit/window control result scale; **zero resident state** \u2014 no index, no cache, every call scans read-only in real time and never modifies session files. **Switch**: independent "Session search" (sessionSearchEnabled, off by default, unrelated to COI dispatch/broadcast, can be enabled alone).',
  "panel.guide.sessionOrch.title": "Session orchestration (de_session)",
  "panel.guide.sessionOrch.desc": 'Lets the AI **programmatically create/wake DSH sessions** ("a session starts another session") \u2014 spawn: creates a **standard session** (identical to one opened manually: system prompt/tools/memory snapshot/persistence; appears in the left session list and can be taken over), prompt = the **full instruction text** (role/task freely composed, e.g. "You are the designer\u2026 now execute: \u2026"), it starts running immediately; optional cwd / join a broadcast room (roomId) / model override (model); wake: wakes an existing session (sessionId + prompt, equivalent to sending a message on its behalf \u2014 its AI wakes up and processes it; queues while busy; auto-resumed after process restart); status/list: inspect state (running = generating / idle = stopped / offline = not in this process, with lastActiveAt). **Collaboration discipline**: nothing auto-wakes sessions \u2014 the decision-maker (e.g. a PM session) **deliberately** runs list/status and actively wakes stopped workers (avoids management chaos); **boundary**: only same-process sessions can be woken; waking = sending a message on their behalf (fully visible in their GUI). **Switch**: independent "Session orchestration" (sessionEnabled, off by default, unrelated to COI/broadcast/search, can be enabled alone); pairs well with "Session broadcast" rooms (spawn with roomId joins automatically).',
  "panel.guide.uiSettings.title": "DSH UI Settings",
  "panel.guide.uiSettings.desc": 'Style-level tweaks for the DSH web GUI (pure client-side injection, no framework changes): per-feature switches live in the "General" sub-tab of the "DSH UI Settings" tab \u2014 session filter (left list shows only active sessions), wide conversation area (~95% of the right pane), and more; themes come later.',
  "panel.guide.confirm.title": "Confirmation (why the AI cannot write directly)",
  "panel.guide.confirm.desc": "Anything the AI creates \u2014 memory, todos, skills \u2014 enters a pending queue first and only takes effect after your confirmation. These writes genuinely change the AI: memory enters the prompt, todos are tasks assigned to you, skills change the AI\u2019s toolbox. Unchecked auto-writes could silently enshrine the AI\u2019s misjudgments as facts or assign you work you never asked for. You are the final gatekeeper: the AI proposes, you decide.",
  "panel.guide.best.title": "Getting the most out of it",
  "panel.guide.best.1": "Pick up across sessions: say \u201Ccheck the memory\u201D about project conventions/progress \u2014 the AI continues from the project log and key facts instead of asking you to repeat.",
  "panel.guide.best.2": "Dictate as you think: \u201Cremember this / follow up on that\u201D \u2014 the AI files it automatically; a one-liner days later reconnects the thread.",
  "panel.guide.best.3": "Confirm periodically: glance at the memory/todo suggestion tabs and adopt or reject \u2014 that is the confirmation loop of memory evolution.",
  "panel.guide.best.4": "Cross-session collaboration: copy your session ID, send it to another session, and have its AI broadcast results back to you via de_broadcast (multiple recipients supported; the receiver sees an unread hint next turn).",
  "panel.guide.loop": "The loop: talk \u2192 remember \u2192 review \u2192 solidify \u2192 execute. This is the AI\u2019s long-term working memory.",
  "panel.suggestions.approve": "Approve",
  "panel.suggestions.archive": "Archive",
  "panel.suggestions.archiveHint": "Archive: kept out of the injected memory, can be promoted back later",
  "panel.suggestions.editHint": "You may edit the text before approving; the edited text is what gets written.",
  "panel.suggestions.reject": "Reject",
  "panel.suggestions.approveAll": "Approve all",
  "panel.suggestions.rejectAll": "Reject all",
  "panel.suggestions.hits": "Suggested {count}\xD7",
  "panel.suggestions.hitsHint": "This fact resurfaced across several reviews \u2014 worth a careful look",
  "panel.suggestions.target.memory": "Memory",
  "panel.suggestions.target.user": "User profile",
  "panel.suggestions.target.key": "Project key facts",
  "panel.suggestions.targetHint": "Track to write on approve: defaults to the AI-recommended one; re-classify if it fits better (memory/user/key are injected into the prompt immediately)",
  "panel.suggestions.done": "Done: {text}",
  "panel.archive.title": "Archived memory",
  "panel.archive.empty": "No archived entries.",
  "panel.archive.help": "Archived suggestions are never injected; they stay here for later \u2014 promote them back into the memory files when they matter, or delete them.",
  "panel.archive.promote": "Promote to memory",
  "panel.archive.delete": "Delete",
  "panel.archive.promoted": "Promoted to memory",
  "panel.archive.deleted": "Archived entry deleted",
  "panel.skills.title": "Pending skill suggestions",
  "panel.skills.help": "New skills produced by background review; approving moves them into the skill library (~/.agents/skills) where they are injected into system prompts.",
  "panel.skills.empty": "No pending skill suggestions.",
  "panel.skills.pending": "Pending",
  "panel.skills.approve": "Approve",
  "panel.skills.reject": "Reject",
  "panel.skills.done": "Skill {op}",
  "panel.config.title": "Config",
  "panel.config.help": "Changes apply immediately and persist (overriding the config.yaml entries).",
  "panel.config.reviewEnabled": "Background review",
  "panel.config.reviewEnabled.hint": "Automatically review sessions and harvest experience; when off, the memory/skill tools and the snapshot still work \u2014 only the automatic review stops",
  "panel.config.reviewInterval": "Review interval (turns)",
  "panel.config.reviewInterval.hint": "One automatic review per N user turns",
  "panel.config.skillReviewEnabled": "Skill auto-harvest",
  "panel.config.skillReviewEnabled.hint": "Off (default): new skills from review go to the pending queue and only install when approved; On: review creates skills directly without confirmation (skills are injected into every session \u2014 enable with care)",
  "panel.config.perTurnProjectWrites": "Per-turn project writes",
  "panel.config.perTurnProjectWrites.hint": "Require the model to check at the end of every turn and record project-related facts (decisions/progress/pitfalls); when off, project memory is read on demand only. \u26A0\uFE0F Relies on LLM instruction following \u2014 weaker models may not comply",
  "panel.config.perTurnDailyWrites": "Per-turn daily writes",
  "panel.config.perTurnDailyWrites.hint": "Require the model to check at the end of every turn and record the day's progress; when off, the daily log is read on demand only. \u26A0\uFE0F Relies on LLM instruction following \u2014 weaker models may not comply",
  "panel.config.perTurnKeyWrites": "Per-turn key-fact check",
  "panel.config.perTurnKeyWrites.hint": "Require the model to judge at the end of every turn whether an important project fact emerged (long-lived convention/decision/architecture/pitfall); if so, write it to target=key (injected into the context), otherwise skip. When off, key facts are only added manually or read. \u26A0\uFE0F Relies on LLM instruction following",
  "panel.config.coiEnabled": "COI dispatch",
  "panel.config.coiEnabled.hint": "Enable the de_coi_* tools and the CLI Dispatch tab: unified dispatch of CLI agents (kimi/codex/grok/hermes\u2026). Off by default \u2014 this plugin's core is memory/todos/skills, dispatch is an on-demand add-on; when off, the tools and the tab are completely invisible",
  "panel.config.scratchEnabled": "Scratch pad tab",
  "panel.config.scratchEnabled.hint": "Enable the Scratch Pad tab: a persistent Markdown note for temporary thoughts (auto-saves to ~/.dsh/memories/scratch.md, survives restarts, ready to migrate or delete anytime). Off by default; when off the tab is completely invisible",
  "panel.config.searchDocsEnabled": "Local file search tool",
  "panel.config.searchDocsEnabled.hint": 'Lets the model search files across all local disks/directories. **Four modes**: all = name + content search; filename only = content/contentQuery parameters are ignored (never reads file contents \u2014 for people who use their own content-search implementation); content only = every call does content matching (query acts as the content keyword); off = the tool is completely invisible to the model. Content search: contentQuery="keyword" answers "which document mentions XX" (rg full-text match, returns hit snippets). Off by default',
  "panel.config.searchDocsMode.all": "All (name + content)",
  "panel.config.searchDocsMode.filename": "Filename only",
  "panel.config.searchDocsMode.content": "Content only",
  "panel.config.searchDocsMode.off": "Off (tool invisible)",
  "panel.config.broadcastEnabled": "Session broadcast",
  "panel.config.broadcastEnabled.hint": 'Enable session broadcast (de_broadcast): inter-session messaging \u2014 the "Session broadcast" unread hint in the snapshot (inbox-style rows: id+subject+sender+time) + the de_broadcast tool (send/list/read; read consumes and auto-deletes once all recipients read; >8KB spills to a file; 30-day cleanup) + the broadcast management panel tab. **Independent of COI dispatch** (off by default, can be enabled alone); when off, all of the above are invisible; the persistent "Your session ID" snapshot section is unaffected; the header "\u29C9 Copy session ID" / "\u270E alias" buttons belong to "Session orchestration" (the panel top also has a copy entry)',
  "panel.config.notifyEnabled": "Channel notify",
  "panel.config.notifyEnabled.hint": 'Enable channel notify (de_notify): the AI proactively sends you a message over IM channels (phase 1: Feishu) when a task is done \u2014 the de_notify manual tool (send anytime, no frequency limit) + automatic COI completion notify (pick channels via the COI runtime config coiNotifyChannels). **Independent module, off by default**; requires the matching channel plugin (dsh-feishu etc.) to be installed (missing channels are reported honestly as "unavailable" without affecting the main plugin); when off, the tool is not registered and COI auto-notify silently skips',
  "panel.config.sessionSearchEnabled": "Session search",
  "panel.config.sessionSearchEnabled.hint": "Enable de_session_search: lets the model search historical sessions of other local AI tools (Codex for now: plain JSONL under ~/.codex/sessions and archived_sessions \u2014 rg prefilter keeps it millisecond-fast; DSH sessions not supported yet). Case-insensitive literal matching over user/assistant messages only; supports cwd project filter, relevance/newest/oldest sorting, and limit/window result control. **Independent submodule** (off by default, can be enabled alone \u2014 unrelated to COI dispatch/broadcast); zero resident state: no index, no cache, every call scans read-only in real time and never modifies session files; when off the tool is completely invisible to the model",
  "panel.config.sessionEnabled": "Session orchestration",
  "panel.config.sessionEnabled.hint": 'Enable session orchestration (de_session): lets AI **programmatically create/wake DSH sessions** \u2014 spawn creates a standard session (identical to one opened manually: system prompt/tools/memory snapshot/persistence, appears in the left session list and can be taken over), prompt = the full instruction text (role/task freely composed), it starts running immediately; optional cwd / join a broadcast room / model override; wake wakes an existing session (equivalent to sending a message on its behalf \u2014 its AI wakes up and processes it, auto-resumed after process restart); status/list inspect state; the header **"\u29C9 Copy session ID" / "\u270E alias" buttons follow this switch** (session-identity features, previously mis-housed under broadcast). **Independent submodule** (off by default; depends on the DSH agents service, only same-process sessions can be woken; when off the tool is invisible to the model)',
  "panel.config.promptsEnabled": "Prompt manager",
  "panel.config.promptsEnabled.hint": "Enable the Prompts tab: a prompt library (user-written paradigms + built-in examples) plus an injection track (once / N consecutive turns / every M turns \u2014 count and cadence accept any integers; injected content is visible to the model next turn, expires automatically by turn counting, and can be stopped anytime; quick inject works without saving a prompt first, auto-saved to the Temp category). Off by default; when off the snapshot section, event listener and API are fully uninstalled and the tab hides after refresh",
  "panel.config.modelsEnabled": "Model config",
  "panel.config.modelsEnabled.hint": `Enable the "Model Config" tab + de_models tool: a table of DSH providers/models with per-model settings (enabled, note, thinking support, allowed/recommended reasoning levels, custom levels); de_models lets the AI query the available model list. **Off by default** (registering takes a slot in the model tool list; turn it on when needed). \u26A0\uFE0F These settings **only affect this plugin and never modify or affect DSH's own model settings** (DSH side stays as the official "Settings \u2192 Models" says). When off the tab and tool hide and the API refuses access, settings data is kept`,
  "panel.config.uiSettingsEnabled": "DSH UI Settings",
  "panel.config.uiSettingsEnabled.hint": 'Enable the "DSH UI Settings" module: a filter bar appears above the left session list, showing only active sessions by default (generating / awaiting approval / awaiting answer / subagents running / error / finished-but-unviewed \u2014 purely idle ones collapse away), one click switches back to all; pure client-side styling (CSS + DOM injection, no DSH framework changes); the filter preference is remembered in the browser. **Off by default**; when off, the filter bar and injected styles are fully removed',
  "panel.config.save": "Save config",
  "panel.reveal.title": "Open files",
  "panel.reveal.help": "Open the memory directories and files with your system tools. \u26A0\uFE0F Careless edits can break the \xA7-delimited format and corrupt memory reads \u2014 edit with caution.",
  "panel.reveal.memoryDir": "Memory dir",
  "panel.reveal.memoryFile": "Global memory",
  "panel.reveal.userFile": "User profile",
  "panel.reveal.archiveMemoryFile": "Archived memory",
  "panel.reveal.archiveUserFile": "Archived user",
  "panel.reveal.dailyDir": "Daily log dir",
  "panel.reveal.dailyFile": "Today log",
  "panel.reveal.projectsDir": "Project memory dir",
  "panel.reveal.skillDir": "Skills dir",
  "panel.reveal.agentsFile": "Global rules (AGENTS.md)",
  "panel.config.saved": "Config saved and applied",
  "panel.config.failed": "Failed: {message}",
  "panel.loading": "Loading\u2026"
};
var BADGE_POLL_MS = 3e4;
var dshMobile = {
  /** 移动端 CSS 片段（字符串，构建时经 esbuild --loader:.css=text 原样内联）。 */
  css: mobile_default,
  /** 移动端 DOM 增强：输入栏上拉弹窗（注入「⋯」入口按钮 + 切换
   *  data-dsh-mobile-sheet 属性，mobile.css 据此把 .tools + 模型选择
   *  显示为 fixed 底栏；常驻保留发送/圆环/⋯）。协议约定：移动模式
   *  激活时调用一次，返回 dispose。 */
  enhance: createInputSheetEnhance
};
var inject = ["slots", "locale", "conversation"];
function apply(ctx) {
  const t2 = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "memory-evolve: dictionaries");
  ctx.effect(() => {
    if (typeof document === "undefined") return () => {
    };
    const existing = document.querySelector("style[data-memory-evolve-css]");
    if (existing !== null) return () => {
    };
    const tag = document.createElement("style");
    tag.dataset.memoryEvolveCss = "1";
    tag.textContent = styles_default;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "memory-evolve: stylesheet");
  ctx.effect(() => {
    if (typeof document === "undefined") return () => {
    };
    const existing = document.querySelector("style[data-skill-browser-css]");
    if (existing !== null) return () => {
    };
    const tag = document.createElement("style");
    tag.dataset.skillBrowserCss = "1";
    tag.textContent = styles_default2;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "memory-evolve: skill browser stylesheet");
  ctx.effect(() => {
    if (typeof document === "undefined") return () => {
    };
    const existing = document.querySelector("style[data-coi-css]");
    if (existing !== null) return () => {
    };
    const tag = document.createElement("style");
    tag.dataset.coiCss = "1";
    tag.textContent = coi_styles_default;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "memory-evolve: coi stylesheet");
  ctx.effect(() => {
    if (typeof document === "undefined") return () => {
    };
    const existing = document.querySelector("style[data-broadcast-css]");
    if (existing !== null) return () => {
    };
    const tag = document.createElement("style");
    tag.dataset.broadcastCss = "1";
    tag.textContent = broadcast_styles_default;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "memory-evolve: broadcast stylesheet");
  ctx.effect(() => {
    if (typeof document === "undefined") return () => {
    };
    const existing = document.querySelector("style[data-scratch-css]");
    if (existing !== null) return () => {
    };
    const tag = document.createElement("style");
    tag.dataset.scratchCss = "1";
    tag.textContent = scratch_styles_default;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "memory-evolve: scratch stylesheet");
  ctx.effect(() => {
    if (typeof document === "undefined") return () => {
    };
    const existing = document.querySelector("style[data-prompt-css]");
    if (existing !== null) return () => {
    };
    const tag = document.createElement("style");
    tag.dataset.promptCss = "1";
    tag.textContent = prompt_styles_default;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "memory-evolve: prompt stylesheet");
  ctx.effect(() => {
    if (typeof document === "undefined") return () => {
    };
    const existing = document.querySelector("style[data-ui-settings-css]");
    if (existing !== null) return () => {
    };
    const tag = document.createElement("style");
    tag.dataset.uiSettingsCss = "1";
    tag.textContent = ui_settings_styles_default;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "memory-evolve: ui-settings stylesheet");
  ctx.effect(() => {
    if (typeof document === "undefined") return () => {
    };
    const existing = document.querySelector("style[data-me-mermaid-css]");
    if (existing !== null) return () => {
    };
    const tag = document.createElement("style");
    tag.dataset.meMermaidCss = "1";
    tag.textContent = mermaid_render_default;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "memory-evolve: mermaid stylesheet");
  ctx.effect(() => {
    if (typeof document === "undefined") return () => {
    };
    const existing = document.querySelector("style[data-bookmark-css]");
    if (existing !== null) return () => {
    };
    const tag = document.createElement("style");
    tag.dataset.bookmarkCss = "1";
    tag.textContent = bookmark_styles_default;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "memory-evolve: bookmark stylesheet");
  let tabCancelled = false;
  let memoryBadgeCount = 0;
  let skillsBadgeCount = 0;
  let todosBadgeCount = 0;
  let disposeMemoryTab;
  let disposeSkillsTab;
  let disposeTodosTab;
  const registerMemoryTab = () => {
    disposeMemoryTab?.();
    disposeMemoryTab = ctx.slots.inject("conversation.view", () => ctx.slots.register({
      name: "conversation.view",
      id: "memory-files",
      order: 20,
      label: () => memoryBadgeCount > 0 ? t2("memoryTab.label.pending", { count: memoryBadgeCount }) : t2("memoryTab.label")
    }, (props) => MemoryTabView({ ...props, t: t2 })));
  };
  const registerSkillsTab = () => {
    disposeSkillsTab?.();
    disposeSkillsTab = ctx.slots.inject("conversation.view", () => ctx.slots.register({
      name: "conversation.view",
      id: "skills-hub",
      order: 21,
      label: () => skillsBadgeCount > 0 ? t2("skillsTab.label.pending", { count: skillsBadgeCount }) : t2("skillsTab.label")
    }, (props) => SkillsTabView({ ...props, t: t2 })));
  };
  const registerTodosTab = () => {
    disposeTodosTab?.();
    disposeTodosTab = ctx.slots.inject("conversation.view", () => ctx.slots.register({
      name: "conversation.view",
      id: "todos-hub",
      order: 22,
      label: () => todosBadgeCount > 0 ? t2("todosTab.label.pending", { count: todosBadgeCount }) : t2("todosTab.label")
    }, (props) => TodosTabView({ ...props, t: t2 })));
  };
  let disposeSettingsTab;
  const registerSettingsTab = () => {
    disposeSettingsTab?.();
    disposeSettingsTab = ctx.slots.inject("conversation.view", () => ctx.slots.register({
      name: "conversation.view",
      id: "settings-hub",
      order: 45,
      label: () => t2("settingsTab.label")
    }, (props) => SettingsTabView({ ...props, t: t2 })));
  };
  let disposeModelsTab;
  const registerModelsTab = () => {
    disposeModelsTab?.();
    disposeModelsTab = ctx.slots.inject("conversation.view", () => ctx.slots.register({
      name: "conversation.view",
      id: "models-hub",
      order: 23,
      label: () => t2("modelsTab.label")
    }, (props) => ModelsTabView({ ...props, t: t2 })));
  };
  const pollBadge = () => {
    if (tabCancelled || disposeMemoryTab === void 0) return;
    void fetch("/memory-evolve/api/badge").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((data) => {
      const suggestions = data.suggestions ?? 0;
      const skills = data.skills ?? 0;
      const todoSuggestions = data.todoSuggestions ?? 0;
      if (suggestions !== memoryBadgeCount) {
        memoryBadgeCount = suggestions;
        registerMemoryTab();
      }
      if (skills !== skillsBadgeCount) {
        skillsBadgeCount = skills;
        registerSkillsTab();
      }
      if (todoSuggestions !== todosBadgeCount) {
        todosBadgeCount = todoSuggestions;
        registerTodosTab();
      }
    }).catch(() => {
    });
  };
  void fetch("/memory-evolve/api/config").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((data) => {
    if (!tabCancelled && data.config?.modelsEnabled === true && disposeModelsTab === void 0) {
      registerModelsTab();
    }
    if (!scratchCancelled && data.config?.scratchEnabled === true && disposeScratchTab === void 0) {
      disposeScratchTab = ctx.slots.inject("conversation.view", () => ctx.slots.register({
        name: "conversation.view",
        id: "scratch-pad",
        order: 40,
        label: () => t2("scratchTab.label")
      }, (props) => ScratchView({ ...props, t: t2 })));
    }
    if (tabCancelled || data.config?.memoryTabEnabled !== true) return;
    registerMemoryTab();
    registerSkillsTab();
    registerTodosTab();
    registerSettingsTab();
    pollBadge();
    const timer = setInterval(pollBadge, BADGE_POLL_MS);
    ctx.effect(() => () => clearInterval(timer), "memory-evolve: memory tab badge poller");
    const onTabChanged = () => pollBadge();
    window.addEventListener("dsh-memory-evolve:badge-change", onTabChanged);
    ctx.effect(() => () => window.removeEventListener("dsh-memory-evolve:badge-change", onTabChanged), "memory-evolve: memory tab badge listener");
  }).catch(() => {
  });
  ctx.effect(() => () => {
    tabCancelled = true;
    disposeMemoryTab?.();
    disposeSkillsTab?.();
    disposeTodosTab?.();
    disposeSettingsTab?.();
  }, "memory-evolve: memory tabs");
  let scratchCancelled = false;
  let disposeScratchTab;
  ctx.effect(() => () => {
    scratchCancelled = true;
    disposeScratchTab?.();
  }, "memory-evolve: scratch tab");
  ctx.effect(() => () => {
    disposeModelsTab?.();
  }, "memory-evolve: models tab");
  let coiCancelled = false;
  let disposeCoiTab;
  let coiRunningCount = 0;
  let currentCoiSessionId;
  const registerCoiTab = () => {
    disposeCoiTab?.();
    disposeCoiTab = ctx.slots.inject("conversation.view", () => ctx.slots.register({
      name: "conversation.view",
      id: "coi-hub",
      order: 30,
      label: () => coiRunningCount > 0 ? t2("coiTab.label.pending", { count: coiRunningCount }) : t2("coiTab.label")
    }, (props) => {
      currentCoiSessionId = props.sessionId;
      return CoIView({ ...props, t: t2 });
    }));
  };
  const pollCoiRunning = () => {
    if (coiCancelled || disposeCoiTab === void 0) return;
    const q = currentCoiSessionId !== void 0 ? `?limit=200&sessionId=${encodeURIComponent(currentCoiSessionId)}` : "?limit=200";
    void fetch(`/memory-evolve/api/coi/tasks${q}`).then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((data) => {
      const running = (data.tasks ?? []).filter((t3) => t3.status === "running" || t3.status === "queued").length;
      if (running !== coiRunningCount) {
        coiRunningCount = running;
        registerCoiTab();
      }
    }).catch(() => {
    });
  };
  void fetch("/memory-evolve/api/coi/config").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then(() => {
    if (coiCancelled) return;
    registerCoiTab();
    pollCoiRunning();
    const coiTimer = setInterval(pollCoiRunning, BADGE_POLL_MS);
    ctx.effect(() => () => clearInterval(coiTimer), "memory-evolve: coi tab badge poller");
    const onCoiBadgeChange = () => pollCoiRunning();
    window.addEventListener("dsh-memory-evolve:badge-change", onCoiBadgeChange);
    ctx.effect(() => () => window.removeEventListener("dsh-memory-evolve:badge-change", onCoiBadgeChange), "memory-evolve: coi tab badge listener");
  }).catch(() => {
  });
  ctx.effect(() => () => {
    coiCancelled = true;
    disposeCoiTab?.();
  }, "memory-evolve: coi tab");
  let sessionHeaderCancelled = false;
  let disposeCopyId;
  void fetch("/memory-evolve/api/config").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((data) => {
    if (sessionHeaderCancelled || data.config?.sessionEnabled !== true) return;
    disposeCopyId = ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
      name: "conversation.session.header.actions",
      id: "copy-session-id",
      order: 0
    }, (props) => HeaderActions({ ...props, t: t2 })));
  }).catch(() => {
  });
  ctx.effect(() => () => {
    sessionHeaderCancelled = true;
    disposeCopyId?.();
  }, "memory-evolve: session header buttons");
  let broadcastTabCancelled = false;
  let disposeBroadcastTab;
  void fetch("/memory-evolve/api/broadcast/messages").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then(() => {
    if (broadcastTabCancelled) return;
    disposeBroadcastTab = ctx.slots.inject("conversation.view", () => ctx.slots.register({
      name: "conversation.view",
      id: "broadcast-hub",
      order: 32,
      label: () => t2("broadcastTab.label")
    }, (props) => BroadcastView({ ...props, t: t2 })));
  }).catch(() => {
  });
  ctx.effect(() => () => {
    broadcastTabCancelled = true;
    disposeBroadcastTab?.();
  }, "memory-evolve: broadcast tab");
  let uiSettingsCancelled = false;
  let disposeUiSettingsTab;
  let disposeSessionFilter;
  let disposeWideChat;
  let disposeWideBubble;
  let disposeContextMeterWarn;
  let disposeMermaidRender;
  void fetch("/memory-evolve/api/ui-settings/state").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((data) => {
    if (uiSettingsCancelled || data.enabled !== true) return;
    const sessionFilter = createSessionFilter({
      barTitle: t2("uiSettings.feature.sessionFilter"),
      on: t2("uiSettings.filter.on"),
      off: t2("uiSettings.filter.off"),
      runningLabel: t2("uiSettings.running.label"),
      ungroupedLabel: t2("uiSettings.ungrouped")
    });
    disposeSessionFilter = sessionFilter.dispose;
    const wideChat = createWideChat();
    disposeWideChat = wideChat.dispose;
    const wideBubble = createWideBubble();
    disposeWideBubble = wideBubble.dispose;
    const contextMeterWarn = createContextMeterWarn();
    disposeContextMeterWarn = contextMeterWarn.dispose;
    const mermaidRenderer = createMermaidRenderer();
    disposeMermaidRender = mermaidRenderer.dispose;
    const features = readFeatures();
    sessionFilter.setEnabled(features.sessionFilter);
    wideChat.setEnabled(features.wideChat);
    wideBubble.setEnabled(features.wideBubble);
    contextMeterWarn.setEnabled(features.contextWarn);
    mermaidRenderer.setEnabled(features.mermaidRender);
    const onFeaturesChanged = (event) => {
      const next = event.detail;
      if (next === void 0) return;
      sessionFilter.setEnabled(next.sessionFilter);
      wideChat.setEnabled(next.wideChat);
      wideBubble.setEnabled(next.wideBubble);
      contextMeterWarn.setEnabled(next.contextWarn);
      mermaidRenderer.setEnabled(next.mermaidRender);
    };
    window.addEventListener(FEATURES_EVENT, onFeaturesChanged);
    ctx.effect(() => () => window.removeEventListener(FEATURES_EVENT, onFeaturesChanged), "memory-evolve: ui-settings features listener");
    disposeUiSettingsTab = ctx.slots.inject("conversation.view", () => ctx.slots.register({
      name: "conversation.view",
      id: "ui-settings-hub",
      order: 46,
      label: () => t2("uiSettingsTab.label")
    }, (props) => UiSettingsTabView({ ...props, t: t2 })));
  }).catch(() => {
  });
  ctx.effect(() => () => {
    uiSettingsCancelled = true;
    disposeUiSettingsTab?.();
    disposeSessionFilter?.();
    disposeWideChat?.();
    disposeWideBubble?.();
    disposeContextMeterWarn?.();
    disposeMermaidRender?.();
  }, "memory-evolve: ui-settings tab");
  let promptCancelled = false;
  let disposePromptTab;
  let promptBadgeCount = 0;
  const registerPromptTab = () => {
    disposePromptTab?.();
    disposePromptTab = ctx.slots.inject("conversation.view", () => ctx.slots.register({
      name: "conversation.view",
      id: "prompt-hub",
      order: 35,
      label: () => promptBadgeCount > 0 ? t2("promptTab.label.active", { count: promptBadgeCount }) : t2("promptTab.label")
    }, (props) => PromptView({ ...props, t: t2 })));
  };
  const pollPromptBadge = () => {
    if (promptCancelled || disposePromptTab === void 0) return;
    void fetch("/memory-evolve/api/prompts/injections").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((data) => {
      const count = data.injections?.length ?? 0;
      if (count !== promptBadgeCount) {
        promptBadgeCount = count;
        registerPromptTab();
      }
    }).catch(() => {
    });
  };
  void fetch("/memory-evolve/api/prompts/sources").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then(() => {
    if (promptCancelled) return;
    registerPromptTab();
    pollPromptBadge();
    const promptBadgeTimer = setInterval(pollPromptBadge, BADGE_POLL_MS);
    ctx.effect(() => () => clearInterval(promptBadgeTimer), "memory-evolve: prompt tab badge poller");
    const onPromptBadgeChange = () => pollPromptBadge();
    window.addEventListener("dsh-memory-evolve:badge-change", onPromptBadgeChange);
    ctx.effect(() => () => window.removeEventListener("dsh-memory-evolve:badge-change", onPromptBadgeChange), "memory-evolve: prompt tab badge listener");
  }).catch(() => {
  });
  ctx.effect(() => () => {
    promptCancelled = true;
    disposePromptTab?.();
  }, "memory-evolve: prompt tab");
  let bookmarkCancelled = false;
  let disposeBookmarkTab;
  let disposeBookmarkCapture;
  let disposeBookmarkInjector;
  let currentBookmarkSessionId = "";
  let bookmarkInjectorStarted = false;
  void fetch("/memory-evolve/api/bookmarks/state").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((data) => {
    if (bookmarkCancelled || data.enabled !== true) return;
    disposeBookmarkCapture = ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
      name: "conversation.session.header.actions",
      id: "bookmark-session-catcher",
      order: 100
      // 末尾：隐藏 entry，零 UI
    }, (props) => {
      const sid = props.sessionId;
      if (typeof sid === "string" && sid !== "") currentBookmarkSessionId = sid;
      if (!bookmarkInjectorStarted) {
        bookmarkInjectorStarted = true;
        disposeBookmarkInjector = createBookmarkInjector(
          () => currentBookmarkSessionId,
          { t: t2 }
        ).dispose;
      }
      return null;
    }));
    disposeBookmarkTab = ctx.slots.inject("conversation.view", () => ctx.slots.register({
      name: "conversation.view",
      id: "bookmarks-hub",
      order: 33,
      label: () => t2("bookmarkTab.label")
    }, (props) => BookmarksView({ ...props, t: t2 })));
  }).catch(() => {
  });
  ctx.effect(() => () => {
    bookmarkCancelled = true;
    disposeBookmarkInjector?.();
    disposeBookmarkCapture?.();
    disposeBookmarkTab?.();
  }, "memory-evolve: bookmarks");
}
return module.exports; } });
