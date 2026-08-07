window.__ModuleLoader__.load({ id: "@dsh-local/dsh-memory-evolve", factory: (require) => {
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
  en: () => en,
  inject: () => inject,
  zh: () => zh
});
module.exports = __toCommonJS(index_exports);

// src/client/MemoryTabView.tsx
var import_react4 = require("react");

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
      coiEnabled: draft.coiEnabled,
      scratchEnabled: draft.scratchEnabled,
      promptsEnabled: draft.promptsEnabled
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
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: t2("panel.guide.best.3") })
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
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                className: "me-switch",
                checked: draft.searchDocsEnabled,
                onChange: (event) => patchDraft({ searchDocsEnabled: event.target.checked })
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
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "me-actions", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "me-btn me-btn-primary", disabled: busy, onClick: saveConfig, children: t2("panel.config.save") }) })
      ] })
    ] })
  ] });
}

// src/client/skills-browser/SkillsBrowser.tsx
var import_react2 = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime2 = require("react/jsx-runtime");
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
  if (rb?.kind === "directory") return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconFolderOpen16, { className: "sb-card-meta-icon" });
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconDataOutline16, { className: "sb-card-meta-icon" });
}
var PAGE_SIZE = 20;
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
  const filtered = (0, import_react2.useMemo)(() => {
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
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(Math.max(1, page), pageCount);
  const paged = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-section sb-section--skills", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-pane-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-pane-title", children: t2("pane.skills") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-count", children: t2("skills.count", { count: filtered.length }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-chips", children: [
      sourceCounts.length > 1 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
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
        sourceCounts.map(({ source, count }) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
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
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-chips-sep" })
      ] }),
      ["all", "enabled", "disabled"].map((status) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-list", children: [
      loading && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-note", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconLoadingOutline16, { className: "sb-spin" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t2("loading.skills") })
      ] }),
      !loading && error !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-note sb-note--error", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconWarningOutline16, {}),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: error }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "sb-btn sb-btn--ghost", onClick: onRetry, children: t2("refresh") })
      ] }),
      !loading && error === null && filtered.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-note", children: t2("search.empty") }),
      !loading && error === null && paged.map((skill) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
        "button",
        {
          type: "button",
          className: `sb-card${skill.name === selectedName ? " sb-card--active" : ""}${skill.disabled ? " sb-card--disabled" : ""}`,
          onClick: () => onSelect(skill),
          title: skill.disabled ? t2("disabled.hint") : void 0,
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "sb-card-top", children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-card-name", children: skill.name }),
              skill.disabled && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-badge sb-badge--disabled", children: t2("disabled.badge") }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: `sb-badge${sourceClass(skill.source)}`, children: t2("source.badge", { source: skill.source }) })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-card-desc", children: skill.description }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "sb-card-meta", children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ResourceIcon, { skill }),
              skill.whenToUse !== null && skill.whenToUse !== "" && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "sb-card-when", children: [
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-card-when-label", children: t2("when.to.use") }),
                skill.whenToUse
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-spacer" }),
              skill.protected ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-badge sb-badge--protected", title: t2("protected.hint"), children: t2("protected.badge") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
                  children: togglingName === skill.name ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconLoadingOutline16, { className: "sb-spin" }) : skill.disabled ? t2("enable") : t2("disable")
                }
              )
            ] })
          ]
        },
        skill.name
      ))
    ] }),
    pageCount > 1 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-pager", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          className: "sb-btn sb-btn--ghost",
          disabled: pageSafe <= 1,
          onClick: onPrevPage,
          children: t2("pager.prev")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-pager-info", children: t2("pager.page", { page: pageSafe, total: pageCount }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
      return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-tree-note", style: indent, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconLoadingOutline16, { className: "sb-spin" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t2("loading.dir") })
      ] });
    }
    const dirError = dirErrors.get(dirAbs);
    if (dirError !== void 0) {
      return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-tree-note sb-note--error", style: indent, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconWarningOutline16, {}),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-tree-errmsg", title: dirError, children: dirError }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "sb-tree-retry", onClick: () => onRetryDir(dirAbs), children: t2("refresh") })
      ] });
    }
    const entries = cache.get(dirAbs);
    if (entries === void 0) return null;
    if (entries.length === 0) {
      return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-tree-note", style: indent, children: t2("no.entries") });
    }
    return entries.map((entry) => {
      const abs = joinPath(dirAbs, entry.name);
      if (entry.type === "dir") {
        const isOpen = expanded.has(abs);
        return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
            "button",
            {
              type: "button",
              className: "sb-tree-row",
              style: indent,
              onClick: () => onToggleDir(abs),
              title: abs,
              children: [
                isOpen ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconChevronDownOutline14, {}) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconChevronRightOutline14, {}),
                isOpen ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconFolderOpen16, {}) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconFolderClose16, {}),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-tree-name", children: entry.name })
              ]
            }
          ),
          isOpen && renderEntries(abs, depth + 1)
        ] }, abs);
      }
      return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
        "button",
        {
          type: "button",
          className: `sb-tree-row sb-tree-row--file${abs === selectedPath ? " sb-tree-row--active" : ""}`,
          style: { paddingLeft: 8 + depth * 14 + 14 },
          onClick: () => onFileClick(abs),
          title: abs,
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-tree-name", children: entry.name }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-tree-size", children: formatSize(t2, entry.size) })
          ]
        },
        abs
      );
    });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-section sb-section--files", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-pane-head", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-pane-title", children: t2("pane.files") }) }),
    !hasSkill && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-note", children: t2("no.skill.selected") }),
    hasSkill && root === null && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-note", children: t2("no.root") }),
    hasSkill && root !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-root-bar", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-root-label", children: t2("root.label") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "select",
          {
            className: "sb-root-select",
            value: root,
            title: root,
            onChange: (e) => onRootChange(e.target.value),
            children: rootOptions.map((r) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: r, children: basename(r) }, r))
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-crumbs", children: crumbs.map((crumb, i) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "sb-crumb-seg", children: [
        i > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconChevronRightOutline14, { className: "sb-crumb-sep" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "sb-crumb", onClick: () => onJump(crumb.abs), children: crumb.label })
      ] }, crumb.abs)) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-tree", children: renderEntries(root, 0) })
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
  const gutterRef = (0, import_react2.useRef)(null);
  const shownText = editing ? draft : file?.content ?? "";
  const lineCount = (0, import_react2.useMemo)(() => shownText.split("\n").length, [shownText]);
  const lineNumbers = (0, import_react2.useMemo)(() => {
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
    body = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-editor-empty", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconLoadingOutline16, { className: "sb-spin" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t2("loading.dir") })
    ] });
  } else if (fileError !== null) {
    const msg = fileError.kind === "not.text" ? t2("not.text") : fileError.kind === "too.large" ? t2("too.large") : t2("read.failed", { message: fileError.message });
    body = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-editor-empty sb-note--error", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconWarningOutline16, {}),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: msg })
    ] });
  } else if (file === null) {
    body = /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-editor-empty", children: hasSelection ? t2("no.file") : t2("no.file") });
  } else if (editing) {
    body = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-editor-edit", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-gutter sb-gutter--edit", ref: gutterRef, "aria-hidden": true, children: lineNumbers.map((n) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { children: n }, n)) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
    body = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-editor-scroll", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-gutter", "aria-hidden": true, children: lineNumbers.map((n) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { children: n }, n)) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("pre", { className: "sb-pre", children: file.content })
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-main", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-editor-topbar", children: [
      file !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-editor-filename", children: basename(file.path) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-editor-path", title: `${t2("path")}: ${file.path}`, children: file.path })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-editor-path", children: t2("no.file") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-spacer" }),
      file !== null && !editing && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("button", { type: "button", className: "sb-btn", onClick: onEdit, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconEditOutline16, {}),
        t2("edit")
      ] }),
      editing && dirty && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-dirty-dot", title: t2("dirty.hint") }),
      editing && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
          "button",
          {
            type: "button",
            className: "sb-btn sb-btn--primary",
            onClick: onSave,
            disabled: saveState === "saving" || !dirty,
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconCheckOutline16, {}),
              saveState === "saving" ? t2("saving") : t2("save")
            ]
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "sb-btn sb-btn--ghost", onClick: onCancel, children: t2("cancel") })
      ] })
    ] }),
    body
  ] });
}
function DirsModal(props) {
  const { t: t2, dirs, loading, error, input, mutating, onInputChange, onAdd, onRemove, onClose } = props;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-modal-overlay", onClick: onClose, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-modal sb-modal--dirs", onClick: (e) => e.stopPropagation(), children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-modal-title", children: t2("dirs.title") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-modal-body", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "sb-dirs-help", children: t2("dirs.help") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-dirs-addrow", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
          "button",
          {
            type: "button",
            className: "sb-btn sb-btn--primary",
            disabled: mutating || input.trim() === "",
            onClick: onAdd,
            children: [
              mutating ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconLoadingOutline16, { className: "sb-spin" }) : null,
              t2("dirs.add")
            ]
          }
        )
      ] }),
      error !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-action-error", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconWarningOutline16, {}),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-action-error-text", children: error })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-dirs-list", children: [
        loading && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-note", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconLoadingOutline16, { className: "sb-spin" }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t2("loading.skills") })
        ] }),
        !loading && dirs.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-note", children: t2("dirs.empty") }),
        !loading && dirs.map((dir) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-dirs-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: `sb-dirs-path${dir.exists ? "" : " sb-dirs-path--missing"}`, title: dir.path, children: dir.path }),
          !dir.exists && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-badge sb-badge--disabled", children: t2("dirs.missing") }),
          dir.exists && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-count", children: t2("skills.count", { count: dir.skillCount }) }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-modal-actions", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "sb-btn", onClick: onClose, children: t2("cancel") }) })
  ] }) });
}
function SkillsBrowser({ t: t2 }) {
  const [skills, setSkills] = (0, import_react2.useState)([]);
  const [roots, setRoots] = (0, import_react2.useState)([]);
  const [skillsLoading, setSkillsLoading] = (0, import_react2.useState)(true);
  const [skillsError, setSkillsError] = (0, import_react2.useState)(null);
  const [query, setQuery] = (0, import_react2.useState)("");
  const [sourceFilter, setSourceFilter] = (0, import_react2.useState)("all");
  const [statusFilter, setStatusFilter] = (0, import_react2.useState)("all");
  const [page, setPage] = (0, import_react2.useState)(1);
  const [togglingName, setTogglingName] = (0, import_react2.useState)(null);
  const [actionError, setActionError] = (0, import_react2.useState)(null);
  const [selectedName, setSelectedName] = (0, import_react2.useState)(null);
  const [dirsOpen, setDirsOpen] = (0, import_react2.useState)(false);
  const [dirs, setDirs] = (0, import_react2.useState)([]);
  const [dirsLoading, setDirsLoading] = (0, import_react2.useState)(false);
  const [dirsError, setDirsError] = (0, import_react2.useState)(null);
  const [dirInput, setDirInput] = (0, import_react2.useState)("");
  const [dirMutating, setDirMutating] = (0, import_react2.useState)(false);
  const [root, setRoot] = (0, import_react2.useState)(null);
  const [expanded, setExpanded] = (0, import_react2.useState)(/* @__PURE__ */ new Set());
  const [cache, setCache] = (0, import_react2.useState)(/* @__PURE__ */ new Map());
  const [loadingDirs, setLoadingDirs] = (0, import_react2.useState)(/* @__PURE__ */ new Set());
  const [dirErrors, setDirErrors] = (0, import_react2.useState)(/* @__PURE__ */ new Map());
  const [selectedPath, setSelectedPath] = (0, import_react2.useState)(null);
  const [file, setFile] = (0, import_react2.useState)(null);
  const [fileLoading, setFileLoading] = (0, import_react2.useState)(false);
  const [fileError, setFileError] = (0, import_react2.useState)(null);
  const [editing, setEditing] = (0, import_react2.useState)(false);
  const [draft, setDraft] = (0, import_react2.useState)("");
  const [saveState, setSaveState] = (0, import_react2.useState)("idle");
  const [saveMessage, setSaveMessage] = (0, import_react2.useState)("");
  const [pendingAction, setPendingAction] = (0, import_react2.useState)(null);
  const [refreshing, setRefreshing] = (0, import_react2.useState)(false);
  const skillsAbort = (0, import_react2.useRef)(null);
  const fileAbort = (0, import_react2.useRef)(null);
  const fileSeq = (0, import_react2.useRef)(0);
  const browseCtrls = (0, import_react2.useRef)(/* @__PURE__ */ new Map());
  const savedTimer = (0, import_react2.useRef)(null);
  const restoredRef = (0, import_react2.useRef)(false);
  const dirty = editing && file !== null && draft !== file.content;
  const currentSkill = (0, import_react2.useMemo)(
    () => skills.find((s) => s.name === selectedName) ?? null,
    [skills, selectedName]
  );
  const sourceCounts = (0, import_react2.useMemo)(() => {
    const map = /* @__PURE__ */ new Map();
    for (const s of skills) map.set(s.source, (map.get(s.source) ?? 0) + 1);
    return [...map.entries()].map(([source, count]) => ({ source, count }));
  }, [skills]);
  (0, import_react2.useEffect)(() => {
    setPage(1);
  }, [query, sourceFilter, statusFilter]);
  const guardDirty = (0, import_react2.useCallback)(
    (action) => {
      if (dirty) setPendingAction(() => action);
      else action();
    },
    [dirty]
  );
  const loadSkills = (0, import_react2.useCallback)(async (silent = false) => {
    skillsAbort.current?.abort();
    const ctrl = new AbortController();
    skillsAbort.current = ctrl;
    if (!silent) setSkillsLoading(true);
    setSkillsError(null);
    try {
      const data = await request(`${API}/skills`, { signal: ctrl.signal });
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
  }, []);
  (0, import_react2.useEffect)(() => {
    void loadSkills();
    return () => {
      skillsAbort.current?.abort();
      fileAbort.current?.abort();
      for (const c of browseCtrls.current.values()) c.abort();
      if (savedTimer.current !== null) clearTimeout(savedTimer.current);
    };
  }, [loadSkills]);
  const handleToggleDisabled = (0, import_react2.useCallback)(
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
  const loadDirs = (0, import_react2.useCallback)(async () => {
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
  const handleAddDir = (0, import_react2.useCallback)(async () => {
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
  const handleRemoveDir = (0, import_react2.useCallback)(
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
  const fetchDir = (0, import_react2.useCallback)(async (rootPath, absDir) => {
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
        `${API}/browse?root=${encodeURIComponent(rootPath)}&path=${encodeURIComponent(rel)}`,
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
  }, []);
  (0, import_react2.useEffect)(() => {
    if (root !== null && !cache.has(root) && !loadingDirs.has(root)) void fetchDir(root, root);
  }, [root, cache, loadingDirs, fetchDir]);
  const handleToggleDir = (0, import_react2.useCallback)(
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
  const handleRetryDir = (0, import_react2.useCallback)(
    (absDir) => {
      if (root !== null) void fetchDir(root, absDir);
    },
    [root, fetchDir]
  );
  const loadFile = (0, import_react2.useCallback)(async (absPath) => {
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
      const data = await request(`${API}/read?path=${encodeURIComponent(absPath)}`, {
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
  }, []);
  const handleFileClick = (0, import_react2.useCallback)(
    (absPath) => {
      guardDirty(() => void loadFile(absPath));
    },
    [guardDirty, loadFile]
  );
  const applySkillSelection = (0, import_react2.useCallback)(
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
  const handleSelectSkill = (0, import_react2.useCallback)(
    (skill) => {
      if (skill.name === selectedName) return;
      guardDirty(() => applySkillSelection(skill));
    },
    [selectedName, guardDirty, applySkillSelection]
  );
  const handleRootChange = (0, import_react2.useCallback)(
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
  const focusDir = (0, import_react2.useMemo)(() => {
    if (root === null) return null;
    if (selectedPath !== null && relOf(root, selectedPath) !== "") {
      return selectedPath.slice(0, selectedPath.lastIndexOf("/"));
    }
    return root;
  }, [root, selectedPath]);
  const crumbs = (0, import_react2.useMemo)(() => {
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
  const handleJump = (0, import_react2.useCallback)(
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
  const handleEdit = (0, import_react2.useCallback)(() => {
    if (file === null) return;
    setDraft(file.content);
    setEditing(true);
    setSaveState("idle");
    setSaveMessage("");
  }, [file]);
  const handleCancelEdit = (0, import_react2.useCallback)(() => {
    guardDirty(() => {
      setEditing(false);
      if (file !== null) setDraft(file.content);
      setSaveState("idle");
      setSaveMessage("");
    });
  }, [guardDirty, file]);
  const handleSave = (0, import_react2.useCallback)(async () => {
    if (file === null || saveState === "saving" || !dirty) return;
    setSaveState("saving");
    setSaveMessage("");
    try {
      const data = await request(
        `${API}/write?path=${encodeURIComponent(file.path)}`,
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
  }, [file, draft, dirty, saveState]);
  const handleRefresh = (0, import_react2.useCallback)(async () => {
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
  (0, import_react2.useEffect)(() => {
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
  (0, import_react2.useEffect)(() => {
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
  const rootOptions = (0, import_react2.useMemo)(() => {
    const list = [];
    if (root !== null) list.push(root);
    for (const r of roots) if (!list.includes(r)) list.push(r);
    return list;
  }, [root, roots]);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-root", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-body", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-side", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-side-toolbar", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-search", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconSearchOutline16, { className: "sb-search-icon" }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
              "input",
              {
                className: "sb-search-input",
                type: "text",
                value: query,
                placeholder: t2("search.placeholder"),
                onChange: (e) => setQuery(e.target.value)
              }
            ),
            query !== "" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
              "button",
              {
                type: "button",
                className: "sb-search-clear",
                onClick: () => setQuery(""),
                "aria-label": t2("cancel"),
                children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconCloseOutline16, {})
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
              children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconFolderOpen16, {})
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "button",
            {
              type: "button",
              className: "sb-icon-btn",
              onClick: () => void handleRefresh(),
              disabled: refreshing,
              title: t2("refresh"),
              children: refreshing ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconLoadingOutline16, { className: "sb-spin" }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconRefreshOutline16, {})
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
        actionError !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-action-error", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconWarningOutline16, {}),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-action-error-text", children: actionError }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "button",
            {
              type: "button",
              className: "sb-btn sb-btn--ghost",
              onClick: () => setActionError(null),
              children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconCloseOutline16, {})
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
      (file !== null || fileLoading || fileError !== null) && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-statusbar sb-statusbar--panel", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "sb-status-item", children: [
        t2("status.skill"),
        ": ",
        selectedName ?? "-"
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "sb-status-item", children: [
        t2("status.file"),
        ": ",
        file !== null ? basename(file.path) : "-"
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-spacer" }),
      saveState === "error" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-status-item sb-status--error", children: t2("write.failed", { message: saveMessage }) }),
      dirty && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-status-item sb-status--dirty", children: t2("status.unsaved") }),
      saveState === "saved" && !dirty && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-status-item sb-status--saved", children: t2("status.saved") }),
      file !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-status-item", children: formatSize(t2, file.size) }),
      file !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-status-item", children: t2("mtime.label", { time: formatTime2(file.mtime) }) })
    ] }),
    dirsOpen && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
    pendingAction !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-modal-overlay", onClick: () => setPendingAction(null), children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-modal", onClick: (e) => e.stopPropagation(), children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-modal-title", children: t2("confirm.discard.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-modal-body", children: t2("confirm.discard.body", { name: file !== null ? basename(file.path) : "" }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-modal-actions", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "button",
          {
            type: "button",
            className: "sb-btn sb-btn--ghost",
            onClick: () => setPendingAction(null),
            children: t2("cancel")
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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

// src/client/TodoView.tsx
var import_react3 = require("react");
var import_jsx_runtime3 = require("react/jsx-runtime");
var TARGETS = ["life", "work", "project", "daily"];
var DONE_STATUSES = /* @__PURE__ */ new Set(["done", "cancelled"]);
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
function quadrantLabel(t2, quadrant) {
  if (quadrant === null) return t2("todo.quadrant.none");
  return t2(`todo.quadrant.${quadrant}`);
}
function dayLabel(day) {
  const [, month, date] = day.split("-");
  return `${Number(month)}\u6708${Number(date)}\u65E5`;
}
function TodoView(props) {
  const { t: t2, sessionId } = props;
  const [target, setTarget] = (0, import_react3.useState)("all");
  const [addTarget, setAddTarget] = (0, import_react3.useState)("work");
  const [items, setItems] = (0, import_react3.useState)(null);
  const [cwd, setCwd] = (0, import_react3.useState)(null);
  const [statusFilter, setStatusFilter] = (0, import_react3.useState)("active");
  const [quadFilter, setQuadFilter] = (0, import_react3.useState)("all");
  const [showExpired, setShowExpired] = (0, import_react3.useState)(false);
  const [draft, setDraft] = (0, import_react3.useState)("");
  const [draftQuad, setDraftQuad] = (0, import_react3.useState)("");
  const [draftDue, setDraftDue] = (0, import_react3.useState)("");
  const [editId, setEditId] = (0, import_react3.useState)(null);
  const [editDraft, setEditDraft] = (0, import_react3.useState)("");
  const [editQuad, setEditQuad] = (0, import_react3.useState)("");
  const [editDue, setEditDue] = (0, import_react3.useState)("");
  const [editStatus, setEditStatus] = (0, import_react3.useState)("");
  const [busy, setBusy] = (0, import_react3.useState)(false);
  const [notice, setNotice] = (0, import_react3.useState)(null);
  const load = (0, import_react3.useCallback)(() => {
    setItems(null);
    const params = new URLSearchParams({ sessionId, all: "1" });
    if (target === "past") params.set("target", "daily");
    else if (target !== "all") params.set("target", target);
    const wantPast = target === "past" || target === "all" && showExpired;
    if (wantPast) {
      params.set("past", "1");
      if (showExpired) params.set("expired", "1");
    }
    void api2(`/api/todo?${params.toString()}`).then((res) => {
      setItems(res.items);
      setCwd(res.cwd);
      setAddTarget((prev) => {
        if (target !== "all") return prev;
        return res.cwd ? "project" : "work";
      });
    }).catch((error) => setNotice({ kind: "error", text: error.message }));
  }, [sessionId, target, showExpired]);
  (0, import_react3.useEffect)(() => {
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
    void api2("/api/todo", {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        action: "add",
        target: addTrack,
        content,
        quadrant: draftQuad === "" ? void 0 : draftQuad,
        due: draftDue === "" ? void 0 : draftDue
      })
    }).then((res) => {
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
    void api2("/api/todo", {
      method: "POST",
      body: JSON.stringify({ sessionId, action: done ? "done" : "update", target: item.target, id: item.id, status: "pending" })
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
    void api2("/api/todo", {
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
    void api2("/api/todo", {
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
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "me-panel", children: [
    notice !== null && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: `me-notice me-notice-${notice.kind}`, children: notice.text }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "me-tabs", role: "tablist", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
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
      TARGETS.map((track) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
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
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
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
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "me-muted me-todo-help", children: t2("todo.help") }),
    target === "project" && cwd === null && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "me-muted", children: t2("todo.projectHint") }),
    target !== "past" && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "me-todo-add", children: [
      target === "all" && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        "select",
        {
          className: "me-todo-select",
          value: addTarget,
          onChange: (event) => setAddTarget(event.target.value),
          title: t2("todo.track"),
          children: TARGETS.map((track) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: track, children: t2(`todo.track.${track}`) }, track))
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
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
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
        "select",
        {
          className: "me-todo-select",
          value: draftQuad,
          onChange: (event) => setDraftQuad(event.target.value),
          title: t2("todo.quadrant"),
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "", children: t2("todo.quadrant.none") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q1", children: t2("todo.quadrant.q1") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q2", children: t2("todo.quadrant.q2") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q3", children: t2("todo.quadrant.q3") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q4", children: t2("todo.quadrant.q4") })
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        "input",
        {
          type: "date",
          className: "me-todo-date",
          value: draftDue,
          onChange: (event) => setDraftDue(event.target.value),
          title: t2("todo.due")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "me-btn me-btn-ok", disabled: busy || draft.trim() === "", onClick: addTodo, children: t2("todo.add") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "me-todo-filters", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { className: "me-todo-filter", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: t2("todo.filterStatus") }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("select", { value: statusFilter, onChange: (event) => setStatusFilter(event.target.value), children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "active", children: t2("todo.status.active") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "all", children: t2("todo.all") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "done", children: t2("todo.status.done") })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { className: "me-todo-filter", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: t2("todo.filterQuadrant") }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("select", { value: quadFilter, onChange: (event) => setQuadFilter(event.target.value), children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "all", children: t2("todo.all") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q1", children: t2("todo.quadrant.q1") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q2", children: t2("todo.quadrant.q2") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q3", children: t2("todo.quadrant.q3") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q4", children: t2("todo.quadrant.q4") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "none", children: t2("todo.quadrant.none") })
        ] })
      ] }),
      (target === "all" || target === "past") && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { className: "me-todo-filter me-todo-filter-check", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "input",
          {
            type: "checkbox",
            checked: showExpired,
            onChange: (event) => setShowExpired(event.target.checked)
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: t2("todo.showExpired") })
      ] })
    ] }),
    items === null ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "me-muted", children: t2("panel.loading") }) : visible.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("p", { className: "me-empty", children: [
      t2("todo.empty"),
      (target === "all" || target === "past") && !showExpired && ` ${t2("todo.pastHint")}`
    ] }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("ul", { className: "me-list", children: groups.map((group) => /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_react3.Fragment, { children: [
      group.day !== null && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("li", { className: "me-todo-day", children: dayLabel(group.day) }),
      group.items.map((item) => {
        const done = DONE_STATUSES.has(item.status);
        const overdue = item.due !== null && item.due < today && !done;
        return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("li", { className: `me-item me-todo-item${done ? " me-todo-item--done" : ""}`, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "me-item-head", children: [
            target === "all" && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "me-badge me-badge-target", children: item.past === true ? t2("todo.track.past") : t2(`todo.track.${item.target}`) }),
            item.past === true && target !== "all" && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "me-badge me-badge-day", children: dayLabel(item.day ?? "") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: `me-badge me-badge-quad me-badge-quad-${item.quadrant ?? "none"}`, children: quadrantLabel(t2, item.quadrant) }),
            item.due !== null && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: `me-badge ${overdue ? "me-badge-overdue" : "me-badge-due"}`, children: overdue ? `${t2("todo.overdue")} ${item.due}` : `${t2("todo.due")} ${item.due}` }),
            item.cat !== null && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "me-badge me-badge-target", children: item.cat }),
            done && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "me-badge me-badge-hits", children: t2("todo.status.done") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "me-item-time", children: item.time }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "me-item-actions", children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "me-btn me-btn-ok", disabled: busy, onClick: () => toggleDone(item), children: done ? t2("todo.undone") : t2("todo.done") }),
              editId !== item.id && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "me-btn", disabled: busy, onClick: () => startEdit(item), children: t2("todo.edit") }),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "me-btn me-btn-danger", disabled: busy, onClick: () => removeTodo(item), children: t2("memoryTab.delete") })
            ] })
          ] }),
          editId === item.id ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "me-todo-edit", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
              "textarea",
              {
                className: "me-item-edit",
                rows: 2,
                value: editDraft,
                onChange: (event) => setEditDraft(event.target.value)
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "me-todo-edit-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("select", { value: editQuad, onChange: (event) => setEditQuad(event.target.value), children: [
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "", children: t2("todo.quadrant.none") }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q1", children: t2("todo.quadrant.q1") }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q2", children: t2("todo.quadrant.q2") }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q3", children: t2("todo.quadrant.q3") }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q4", children: t2("todo.quadrant.q4") })
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                "input",
                {
                  type: "date",
                  value: editDue,
                  onChange: (event) => setEditDue(event.target.value)
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("select", { value: editStatus, onChange: (event) => setEditStatus(event.target.value), children: [
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "pending", children: t2("todo.status.pending") }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "doing", children: t2("todo.status.doing") }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "done", children: t2("todo.status.done") }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "blocked", children: t2("todo.status.blocked") }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "cancelled", children: t2("todo.status.cancelled") })
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "me-btn me-btn-ok", disabled: busy || editDraft.trim() === "", onClick: () => saveEdit(item), children: t2("todo.save") }),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "me-btn", disabled: busy, onClick: () => setEditId(null), children: t2("todo.cancel") })
            ] })
          ] }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "me-todo-text", children: item.text })
        ] }, item.id);
      })
    ] }, group.day ?? group.items[0].id)) })
  ] });
}

// src/client/MemoryTabView.tsx
var import_jsx_runtime4 = require("react/jsx-runtime");
var ENTRY_DELIMITER = "\n\xA7\n";
var BRANCH_TAG_RE = /(?:^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*)?\[branch:([^\]]*)\]\s*/;
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
    }
    entries.push({ time, tag, branch, text, branches, raw: rawText });
  }
  return entries;
}
function entryMatches(entry, q) {
  return entry.text.toLowerCase().includes(q) || (entry.time ?? "").toLowerCase().includes(q) || (entry.tag ?? "").toLowerCase().includes(q);
}
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
var persistedFeature = null;
var persistedFileKey = null;
function MemoryTabView(props) {
  const { sessionId, t: t2 } = props;
  const [files, setFiles] = (0, import_react4.useState)(null);
  const [notice, setNotice] = (0, import_react4.useState)(null);
  const [cwd, setCwd] = (0, import_react4.useState)(null);
  const [branch, setBranch] = (0, import_react4.useState)(null);
  const [branches, setBranches] = (0, import_react4.useState)([]);
  const [view, setView] = (0, import_react4.useState)("pretty");
  const [query, setQuery] = (0, import_react4.useState)("");
  const [activeKey, setActiveKey] = (0, import_react4.useState)(persistedFileKey);
  const [keyDraft, setKeyDraft] = (0, import_react4.useState)("");
  const [keySaving, setKeySaving] = (0, import_react4.useState)(false);
  const [keyScope, setKeyScope] = (0, import_react4.useState)([]);
  const [scopeEdit, setScopeEdit] = (0, import_react4.useState)(null);
  const [scopeDraft, setScopeDraft] = (0, import_react4.useState)([]);
  const [scopeSaving, setScopeSaving] = (0, import_react4.useState)(false);
  const [editEntryRaw, setEditEntryRaw] = (0, import_react4.useState)(null);
  const [editDraft, setEditDraft] = (0, import_react4.useState)("");
  const [editSaving, setEditSaving] = (0, import_react4.useState)(false);
  const [deleting, setDeleting] = (0, import_react4.useState)(false);
  const [feature, setFeature] = (0, import_react4.useState)(persistedFeature);
  const [badge, setBadge] = (0, import_react4.useState)({ suggestions: 0, todoSuggestions: 0, skills: 0 });
  const pollBadge = (0, import_react4.useCallback)(() => {
    void api3("/api/badge").then((data) => setBadge({
      suggestions: data.suggestions ?? 0,
      todoSuggestions: data.todoSuggestions ?? 0,
      skills: data.skills ?? 0
    })).catch(() => {
    });
  }, []);
  (0, import_react4.useEffect)(() => {
    pollBadge();
    const timer = window.setInterval(pollBadge, 3e4);
    return () => window.clearInterval(timer);
  }, [pollBadge]);
  (0, import_react4.useEffect)(() => {
    persistedFeature = feature;
  }, [feature]);
  (0, import_react4.useEffect)(() => {
    persistedFileKey = activeKey;
  }, [activeKey]);
  const load = (0, import_react4.useCallback)(() => {
    setFiles(null);
    void api3(
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
  (0, import_react4.useEffect)(() => {
    load();
  }, []);
  (0, import_react4.useEffect)(() => {
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
    void api3("/api/reveal", { method: "POST", body: JSON.stringify({ target }) }).then(() => flash(t2("memoryTab.opened"))).catch((error) => setNotice({ kind: "error", text: error.message }));
  };
  const saveKey = () => {
    const content = keyDraft.trim();
    if (content === "" || keySaving) return;
    setKeySaving(true);
    void api3("/api/memory/key", {
      method: "POST",
      body: JSON.stringify({ sessionId: String(sessionId), content, branches: keyScope })
    }).then(() => {
      setKeyDraft("");
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
    void api3("/api/key/scope", {
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
  const deleteEntry = (entry) => {
    if (activeRow === null || deleting) return;
    const snippet = entry.text.length > 60 ? `${entry.text.slice(0, 60)}\u2026` : entry.text;
    if (!window.confirm(t2("memoryTab.deleteConfirm", { snippet }))) return;
    setDeleting(true);
    void api3("/api/memory/delete", {
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
    void api3("/api/memory/update", {
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
    void api3(path, {
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
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-panel", children: [
    notice !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: `mt-notice mt-notice-${notice.kind}`, children: notice.text }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-file-tabs", role: "tablist", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
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
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "suggestions",
          className: feature === "suggestions" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature(feature === "suggestions" ? null : "suggestions"),
          children: [
            t2("memoryTab.feature.suggestions"),
            badge.suggestions > 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-feature-count", children: badge.suggestions })
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "todo-suggestions",
          className: feature === "todo-suggestions" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature(feature === "todo-suggestions" ? null : "todo-suggestions"),
          children: [
            t2("memoryTab.feature.todoSuggestions"),
            badge.todoSuggestions > 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-feature-count", children: badge.todoSuggestions })
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "skills",
          className: feature === "skills" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature(feature === "skills" ? null : "skills"),
          children: [
            t2("memoryTab.feature.skills"),
            badge.skills > 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-feature-count", children: badge.skills })
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "config",
          className: feature === "config" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature(feature === "config" ? null : "config"),
          children: t2("memoryTab.feature.config")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "skill-browser",
          className: feature === "skill-browser" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature(feature === "skill-browser" ? null : "skill-browser"),
          children: t2("memoryTab.feature.skillBrowser")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "todo",
          className: feature === "todo" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature(feature === "todo" ? null : "todo"),
          children: t2("memoryTab.feature.todo")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-tab-sep", role: "presentation" }),
      files !== null && (files ?? []).map((row) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": row.key === activeKey,
          className: row.key === activeKey ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => {
            setActiveKey(row.key);
            setFeature(null);
          },
          children: row.title
        },
        row.key
      ))
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("p", { className: "mt-warning", children: [
      "\u26A0\uFE0F ",
      t2("memoryTab.warning")
    ] }),
    cwd !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("p", { className: "mt-cwd", children: [
      t2("memoryTab.cwd"),
      ": ",
      cwd
    ] }),
    feature !== null ? feature === "skill-browser" ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(SkillsBrowser, { t: t2 }) : feature === "todo" ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(TodoView, { t: t2, sessionId: String(sessionId) }) : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      MemoryQueueView,
      {
        t: t2,
        feature,
        onChanged: () => {
          pollBadge();
          window.dispatchEvent(new CustomEvent("dsh-memory-evolve:badge-change"));
        }
      }
    ) : files === null ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "mt-muted", children: t2("memoryTab.loading") }) : /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(import_jsx_runtime4.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-toolbar", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-view-toggle", role: "group", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "button",
            {
              type: "button",
              className: view === "pretty" ? "mt-view-btn mt-view-btn-active" : "mt-view-btn",
              onClick: () => setView("pretty"),
              children: t2("memoryTab.viewPretty")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "button",
            {
              type: "button",
              className: view === "raw" ? "mt-view-btn mt-view-btn-active" : "mt-view-btn",
              onClick: () => setView("raw"),
              children: t2("memoryTab.viewRaw")
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "input",
          {
            type: "search",
            className: "mt-search",
            value: query,
            placeholder: t2("memoryTab.searchPlaceholder"),
            onChange: (event) => setQuery(event.target.value)
          }
        )
      ] }),
      q !== "" && activeHidden && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "mt-empty", children: t2("memoryTab.noResults") }),
      activeRow !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-card-head", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-card-title", children: activeRow.title }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-badge mt-badge-ro", children: t2("memoryTab.readonly") }),
          activeEntries !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-badge mt-badge-count", children: t2("memoryTab.entryCount", { count: activeEntries.length }) }),
          activeRow.path !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-card-path", title: activeRow.path, children: activeRow.path }),
          activeRow.available && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-card-actions", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "mt-btn", onClick: () => openWithSystem(activeRow), children: t2("memoryTab.open") }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("p", { className: "mt-card-desc", children: [
          t2(`memoryTab.desc.${activeRow.key}`),
          activeRow.key === "key" && branch !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "mt-card-desc-branch", children: [
            " ",
            t2("memoryTab.keyBranchInfo", { branch })
          ] })
        ] }),
        activeRow.key === "key" && activeRow.available && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-key-add", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "textarea",
            {
              className: "mt-key-input",
              rows: 2,
              value: keyDraft,
              placeholder: t2("memoryTab.keyAddPlaceholder"),
              onChange: (event) => setKeyDraft(event.target.value)
            }
          ),
          branches.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-key-scope", children: [
            /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "mt-key-scope-label", children: [
              t2("memoryTab.keyScope"),
              ":"
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("label", { className: "mt-scope-opt", children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                "input",
                {
                  type: "checkbox",
                  checked: keyScope.length === 0,
                  onChange: () => setKeyScope([])
                }
              ),
              t2("memoryTab.keyScopeAll")
            ] }),
            branches.map((b) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("label", { className: "mt-scope-opt", children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
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
          /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-key-add-foot", children: [
            /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-key-help", children: t2("memoryTab.keyAddHelp") }),
            /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
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
        !activeRow.available ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "mt-muted", children: t2("memoryTab.noCwd") }) : !activeRow.exists ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("pre", { className: "mt-content", children: t2("memoryTab.empty") }) : activeEntries === null ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("pre", { className: "mt-content", children: activeRow.content }) : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "mt-entries", children: [...activeEntries].reverse().map((entry, index) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-entry", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-entry-head", children: [
            entry.time !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-entry-time", children: entry.time }),
            entry.branch !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-entry-branch mt-entry-branch-tag", title: t2("memoryTab.gitBranch"), children: entry.branch }),
            entry.tag !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-entry-tag", title: t2("memoryTab.projectTag"), children: entry.tag }),
            activeRow.key === "key" && branches.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
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
            /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "mt-entry-ops", children: [
              (activeRow.key === "memory" || activeRow.key === "user" || activeRow.key === "key") && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
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
              (activeRow.key === "archive-memory" || activeRow.key === "archive-user" || activeRow.key === "archive-key") && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
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
              EDIT_KEYS.has(activeRow.key) && editEntryRaw !== entry.raw && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
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
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
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
          editEntryRaw === entry.raw ? /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-entry-edit", children: [
            /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
              "textarea",
              {
                className: "mt-item-edit",
                rows: 3,
                value: editDraft,
                onChange: (event) => setEditDraft(event.target.value.replaceAll("\xA7", ""))
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-entry-edit-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-entry-edit-hint", children: t2("memoryTab.editHint") }),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                "button",
                {
                  type: "button",
                  className: "mt-btn mt-btn-primary",
                  disabled: editSaving || editDraft.trim() === "",
                  onClick: saveEdit,
                  children: t2("memoryTab.save")
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "mt-btn", disabled: editSaving, onClick: () => setEditEntryRaw(null), children: t2("memoryTab.cancel") })
            ] })
          ] }) : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "mt-entry-text", children: entry.text }),
          activeRow.key === "key" && scopeEdit === entry.raw && branches.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-scope", children: [
            /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "mt-key-scope-label", children: [
              t2("memoryTab.keyScope"),
              ":"
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("label", { className: "mt-scope-opt", children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                "input",
                {
                  type: "checkbox",
                  checked: scopeDraft.length === 0,
                  onChange: () => setScopeDraft([])
                }
              ),
              t2("memoryTab.keyScopeAll"),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("em", { className: "mt-scope-all-hint", children: t2("memoryTab.keyScopeAllWeight") })
            ] }),
            branches.map((b) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("label", { className: "mt-scope-opt", children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                "input",
                {
                  type: "checkbox",
                  checked: scopeDraft.includes(b),
                  onChange: () => toggleScopeBranch(b)
                }
              ),
              b
            ] }, b)),
            /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "mt-scope-actions", children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                "button",
                {
                  type: "button",
                  className: "mt-btn mt-btn-primary",
                  disabled: scopeSaving,
                  onClick: saveScope,
                  children: t2("memoryTab.keyScopeSave")
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "mt-btn", disabled: scopeSaving, onClick: () => setScopeEdit(null), children: t2("memoryTab.keyScopeCancel") })
            ] })
          ] })
        ] }, index)) }),
        activeRow.truncated && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "mt-muted", children: t2("memoryTab.truncated") })
      ] })
    ] })
  ] });
}

// src/client/CoIView.tsx
var import_react5 = require("react");
var import_jsx_runtime5 = require("react/jsx-runtime");
var DICT = {
  zh: {
    tab: "CLI\u8C03\u5EA6",
    guide: "\u6307\u5357",
    "guide.title": "COI \u8C03\u5EA6\u4F7F\u7528\u6307\u5357",
    "guide.intro": "COI \u8C03\u5EA6\u662F\u300C\u5916\u90E8 AI \u4EE3\u7406\u8C03\u5EA6\u5668\u300D\uFF1A\u628A\u4EFB\u52A1\u6D3E\u7ED9 kimi / codex / grok / hermes \u7B49 CLI \u4EE3\u7406\u2014\u2014\u7EDF\u4E00\u8C03\u5EA6\u4E0D\u5361\u4E3B\u8FDB\u7A0B\u3001\u5B9E\u65F6\u770B\u8FDB\u5EA6\u3001\u4F1A\u8BDD\u5206\u5C42\u7BA1\u7406\u53EF\u4E00\u952E\u6062\u590D\u3001\u8DE8 COI \u63A5\u529B\u3001\u4EFB\u52A1\u7ED3\u679C\u7559\u6863\u5E76\u81EA\u52A8\u6C89\u6DC0\u5230\u8BB0\u5FC6\u3002\u672C\u6A21\u5757\u9ED8\u8BA4\u7981\u7528\uFF08\u53EF\u5728\u300C\u8BB0\u5FC6\u6280\u80FD\u5F85\u529E\u300DTab \u7684\u8FD0\u884C\u65F6\u914D\u7F6E\u4E2D\u542F\u7528\uFF09\u3002",
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
    "launch.injectCtx": "\u6CE8\u5165 DSH \u8BB0\u5FC6\u4E0A\u4E0B\u6587",
    "launch.injectCtxHint": "\u628A\u957F\u671F\u8BB0\u5FC6/\u7528\u6237\u6863\u6848/\u672C\u9879\u76EE\u5173\u952E\u8BB0\u5FC6\uFF08\u6309\u5206\u652F\uFF09\u5E26\u7ED9 COI\uFF08\u4E0D\u542B AGENTS.md \u5168\u5C40\u89C4\u5219\uFF09\uFF0C\u8BA9\u5B83\u4E86\u89E3\u9879\u76EE\u7EA6\u5B9A\uFF08\u5185\u5BB9\u4F1A\u53D1\u7ED9\u5916\u90E8 COI \u670D\u52A1\uFF0C\u6CE8\u610F\u9690\u79C1\uFF09",
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
    "config.defaultInject": "\u9ED8\u8BA4\u6CE8\u5165\u8BB0\u5FC6\u4E0A\u4E0B\u6587",
    "config.defaultInjectHint": "\u65B0\u4EFB\u52A1\u9ED8\u8BA4\u628A DSH \u8BB0\u5FC6\uFF08\u957F\u671F\u8BB0\u5FC6/\u7528\u6237\u6863\u6848/\u672C\u9879\u76EE\u5173\u952E\u8BB0\u5FC6\u6309\u5206\u652F\uFF0C\u4E0D\u542B AGENTS.md\uFF09\u5E26\u7ED9 COI\uFF1B\u6BCF\u6B21\u53D1\u8D77\u65F6\u53EF\u5355\u72EC\u8986\u76D6\u3002\u9ED8\u8BA4\u5173\uFF08\u5185\u5BB9\u4F1A\u53D1\u7ED9\u5916\u90E8 COI \u670D\u52A1\uFF09",
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
    "launch.injectCtx": "Inject DSH memory context",
    "launch.injectCtxHint": "Hand long-term memory / user profile / this project's key facts (branch-filtered; no AGENTS.md) to the COI so it knows the project conventions (content is sent to external COI services \u2014 mind privacy)",
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
    "config.defaultInject": "Inject memory context by default",
    "config.defaultInjectHint": "New tasks carry the DSH memory (long-term memory / user profile / this project's key facts, branch-filtered; no AGENTS.md) to the COI; overridable per dispatch. Off by default (content is sent to external COI services)",
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
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: `coi-notice coi-notice-${props.notice.kind}`, children: props.notice.text });
}
function ErrorLine(props) {
  if (props.error === null) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-error", children: props.error });
}
function CoIView(props) {
  const sessionId = props.sessionId;
  const [sub, setSub] = (0, import_react5.useState)("tasks");
  const tabs = [
    { id: "guide", key: "guide" },
    { id: "tasks", key: "tasks" },
    { id: "sessions", key: "sessions" },
    { id: "adapters", key: "adapters" },
    { id: "templates", key: "templates" },
    { id: "stats", key: "stats" },
    { id: "config", key: "config" }
  ];
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-root", children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-tabs", role: "tablist", children: tabs.map((tab) => /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
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
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-body", children: [
      sub === "guide" && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(GuidePane, {}),
      sub === "tasks" && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(TasksPane, { dsSessionId: sessionId }),
      sub === "sessions" && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(SessionsPane, { dsSessionId: sessionId }),
      sub === "adapters" && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(AdaptersPane, {}),
      sub === "templates" && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(TemplatesPane, {}),
      sub === "stats" && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(StatsPane, {}),
      sub === "config" && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(ConfigPane, {})
    ] })
  ] });
}
function GuidePane() {
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-pane", children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-card-title", children: t("guide.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("p", { className: "coi-muted", children: t("guide.intro") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-card-title", children: [
        "\u{1F680} ",
        t("guide.use.title")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("p", { className: "coi-muted", children: t("guide.use.desc") }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("ul", { className: "coi-guide-list", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("strong", { children: t("guide.use.ai") }),
          t("guide.use.aiDesc")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("strong", { children: t("guide.use.slash") }),
          t("guide.use.slashDesc")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("strong", { children: t("guide.use.tab") }),
          t("guide.use.tabDesc")
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-card-title", children: [
        "\u{1F5C2}\uFE0F ",
        t("guide.scope.title")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("p", { className: "coi-muted", children: t("guide.scope.desc") }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("ul", { className: "coi-guide-list", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("strong", { children: t("scope.temporary") }),
          "\uFF1A",
          t("guide.scope.temp")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("strong", { children: t("scope.session") }),
          "\uFF1A",
          t("guide.scope.session")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("strong", { children: t("scope.project") }),
          "\uFF1A",
          t("guide.scope.project")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("strong", { children: t("scope.global") }),
          "\uFF1A",
          t("guide.scope.global")
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-card-title", children: [
        "\u{1F9ED} ",
        t("guide.skill.title")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("p", { className: "coi-muted", children: t("guide.skill.desc") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-card-title", children: [
        "\u{1F4A1} ",
        t("guide.tips.title")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("ul", { className: "coi-guide-list", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("li", { children: t("guide.tips.1") }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("li", { children: t("guide.tips.2") }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("li", { children: t("guide.tips.3") }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("li", { children: t("guide.tips.4") })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("p", { className: "coi-muted coi-pad", children: t("guide.loop") })
  ] });
}
function TasksPane({ dsSessionId }) {
  const visQs = (dsSessionId ?? "") !== "" ? `&sessionId=${encodeURIComponent(String(dsSessionId))}` : "";
  const [adapters, setAdapters] = (0, import_react5.useState)([]);
  const [templates, setTemplates] = (0, import_react5.useState)([]);
  const [sessions, setSessions] = (0, import_react5.useState)([]);
  const [refTasks, setRefTasks] = (0, import_react5.useState)([]);
  const [tasks, setTasks] = (0, import_react5.useState)(null);
  const [error, setError] = (0, import_react5.useState)(null);
  const [notice, setNotice] = (0, import_react5.useState)(null);
  const [adapterId, setAdapterId] = (0, import_react5.useState)("kimi");
  const [prompt, setPrompt] = (0, import_react5.useState)("");
  const [scope, setScope] = (0, import_react5.useState)("project");
  const [sessionId, setSessionId] = (0, import_react5.useState)("");
  const [templateId, setTemplateId] = (0, import_react5.useState)("");
  const [refTaskId, setRefTaskId] = (0, import_react5.useState)("");
  const [launching, setLaunching] = (0, import_react5.useState)(false);
  const [injectCtx, setInjectCtx] = (0, import_react5.useState)(false);
  const [ctxText, setCtxText] = (0, import_react5.useState)("");
  const [selectedId, setSelectedId] = (0, import_react5.useState)(null);
  const [detail, setDetail] = (0, import_react5.useState)(null);
  const [log, setLog] = (0, import_react5.useState)("");
  const [logError, setLogError] = (0, import_react5.useState)(null);
  const [copied, setCopied] = (0, import_react5.useState)(false);
  const [fullLog, setFullLog] = (0, import_react5.useState)(false);
  const [fullPrompt, setFullPrompt] = (0, import_react5.useState)(false);
  const [searchQ, setSearchQ] = (0, import_react5.useState)("");
  const logRef = (0, import_react5.useRef)(null);
  const fullLogRef = (0, import_react5.useRef)(null);
  const selectedRef = (0, import_react5.useRef)(null);
  (0, import_react5.useEffect)(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);
  const loadTasks = (0, import_react5.useCallback)(async () => {
    try {
      const q = searchQ.trim();
      const data = await fetchJson(`/tasks?limit=${TASK_LIMIT}${visQs}${q !== "" ? `&q=${encodeURIComponent(q)}` : ""}`);
      setTasks(data.tasks);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, [searchQ]);
  const loadDetail = (0, import_react5.useCallback)(async (id) => {
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
  const loadLog = (0, import_react5.useCallback)(async (id) => {
    try {
      const data = await fetchJson(`/tasks/${encodeURIComponent(id)}/log?tail=8000`);
      setLog(data.text);
      setLogError(null);
    } catch (err) {
      setLogError(errText(err));
    }
  }, []);
  (0, import_react5.useEffect)(() => {
    void loadTasks();
    const timer = setInterval(() => {
      void loadTasks();
      const id = selectedRef.current;
      if (id !== null) void loadDetail(id);
    }, TASKS_POLL_MS);
    return () => clearInterval(timer);
  }, [loadTasks, loadDetail]);
  (0, import_react5.useEffect)(() => {
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
  (0, import_react5.useEffect)(() => {
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
  (0, import_react5.useEffect)(() => {
    if (selectedId === null || !running) return;
    const timer = setInterval(() => {
      void loadLog(selectedId);
      void loadDetail(selectedId);
    }, LOG_POLL_MS);
    return () => clearInterval(timer);
  }, [selectedId, running, loadLog, loadDetail]);
  (0, import_react5.useEffect)(() => {
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
      const res = await postJson("/tasks", { ...body, dsSessionId: dsSessionId ?? "", injectContext: injectCtx || void 0, contextText: ctxText.trim() === "" ? void 0 : ctxText });
      setNotice({ kind: "ok", text: `${t("launch.ok")}${res.taskId !== void 0 ? `\uFF1A${res.taskId}` : ""}` });
      setPrompt("");
      setTemplateId("");
      setRefTaskId("");
      void loadTasks();
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
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-pane coi-tasks", children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-card-title", children: t("launch.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-form-grid", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("launch.adapter") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(
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
                adapters.map((a) => /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("option", { value: a.id, children: [
                  a.name,
                  "\uFF08",
                  a.id,
                  "\uFF09"
                ] }, a.id)),
                adapters.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("option", { value: adapterId, children: adapterId })
              ]
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("launch.scope") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("select", { className: "coi-select", value: scope, onChange: (e) => setScope(e.target.value), children: SCOPES.map((s) => /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("option", { value: s, children: t(`scope.${s}`) }, s)) })
        ] }),
        scope !== "temporary" && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("launch.session") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("select", { className: "coi-select", value: sessionId, onChange: (e) => setSessionId(e.target.value), children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("option", { value: "", children: t("launch.sessionNone") }),
            sessions.filter((s) => s.adapterId === adapterId).map((s) => /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("option", { value: s.id, children: [
              s.id,
              "\uFF08",
              s.adapterId,
              s.note !== null && s.note !== "" ? ` \xB7 ${trunc(s.note, 12)}` : "",
              "\uFF09"
            ] }, s.id)),
            sessions.filter((s) => s.adapterId === adapterId).length === 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("option", { value: "", disabled: true, children: t("launch.sessionEmpty") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("launch.template") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("select", { className: "coi-select", value: templateId, onChange: (e) => applyTemplate(e.target.value), children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("option", { value: "", children: t("launch.templateNone") }),
            templates.map((tpl) => /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("option", { value: tpl.id, children: [
              tpl.name,
              "\uFF08",
              tpl.id,
              "\uFF09"
            ] }, tpl.id))
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("launch.ref") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("select", { className: "coi-select", value: refTaskId, onChange: (e) => setRefTaskId(e.target.value), children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("option", { value: "", children: t("launch.refNone") }),
            refTasks.map((task) => /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("option", { value: task.id, children: [
              task.id,
              " \xB7 ",
              trunc(task.prompt, 24)
            ] }, task.id))
          ] })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("launch.prompt") }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
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
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field coi-field-wide", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: "coi-field-check", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("input", { type: "checkbox", checked: injectCtx, onChange: (e) => setInjectCtx(e.target.checked) }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("launch.injectCtx") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-muted coi-small", children: t("launch.injectCtxHint") })
      ] }),
      injectCtx && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field coi-field-wide", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("launch.ctxText") }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
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
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-form-actions", children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-primary", disabled: launching, onClick: () => void launch(), children: t("launch.submit") }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(NoticeLine, { notice }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-task-toolbar", children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
      "input",
      {
        className: "coi-input",
        placeholder: t("tasks.searchPh"),
        value: searchQ,
        onChange: (e) => setSearchQ(e.target.value)
      }
    ) }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-split", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-task-list", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(ErrorLine, { error }),
        tasks === null && error === null && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-muted coi-pad", children: t("loading") }),
        tasks !== null && tasks.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-muted coi-pad", children: t("tasks.empty") }),
        tasks?.map((task) => {
          const meta = statusMeta(task.status);
          return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(
            "button",
            {
              type: "button",
              className: `coi-task-row${selectedId === task.id ? " coi-task-row-active" : ""}`,
              onClick: () => setSelectedId(task.id),
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: `coi-task-status ${meta.cls}`, title: meta.label, children: meta.icon }),
                /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-mono coi-task-id", children: task.id }),
                /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-task-adapter", children: task.adapterId }),
                /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-task-prompt", title: task.prompt, children: trunc(task.prompt) }),
                /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-badge", children: t("scope." + task.scope) ?? task.scope }),
                /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-muted coi-task-time", children: fmtTime(task.createdAt) })
              ]
            },
            task.id
          );
        })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-detail", children: [
        selectedId === null && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-muted coi-pad", children: t("tasks.selectHint") }),
        selectedId !== null && detail === null && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-muted coi-pad", children: t("loading") }),
        detail !== null && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(import_jsx_runtime5.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-detail-meta", children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("tasks.status") }),
              /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: statusMeta(detail.status).cls, children: [
                statusMeta(detail.status).icon,
                " ",
                statusMeta(detail.status).label
              ] })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("tasks.adapter") }),
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { children: detail.adapterId })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("tasks.scope") }),
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-badge", children: t("scope." + detail.scope) ?? detail.scope })
            ] }),
            detail.branch !== null && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("tasks.branch") }),
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-mono", children: detail.branch })
            ] }),
            detail.sessionId !== null && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("tasks.sessionId") }),
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-mono coi-small", children: detail.sessionId }),
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => void copySession(detail.sessionId ?? ""), children: copied ? t("tasks.copied") : t("tasks.copy") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("tasks.created") }),
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { children: fmtTime(detail.createdAt) })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("tasks.duration") }),
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { children: fmtDur(detailDur(detail)) })
            ] }),
            running && detail.lastOutputAt != null && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("tasks.lastOutput") }),
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { children: fmtAgo(detail.lastOutputAt) })
            ] }),
            detail.exitCode !== null && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-meta-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("tasks.exitCode") }),
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-mono", children: detail.exitCode })
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-detail-actions", children: [
            running && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("button", { type: "button", className: "coi-btn coi-btn-danger", onClick: () => void kill(), children: [
              "\u{1F6D1} ",
              t("tasks.kill")
            ] }),
            !running && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("button", { type: "button", className: "coi-btn", onClick: () => void retry(), children: [
              "\u21BB ",
              t("tasks.retry")
            ] }),
            !running && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("button", { type: "button", className: "coi-btn coi-btn-danger", onClick: () => void removeTask(detail.id), children: [
              "\u{1F5D1} ",
              t("tasks.delete")
            ] })
          ] }),
          detail.error !== null && detail.error !== "" && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-error", children: [
            t("tasks.error"),
            "\uFF1A",
            detail.error
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-log-head", children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label coi-log-title", children: t("tasks.prompt") }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => setFullPrompt(true), children: [
              "\u26F6 ",
              t("tasks.logFull")
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("pre", { className: "coi-prompt-view", children: detail.prompt }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-log-head", children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label coi-log-title", children: t("tasks.log") }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => setFullLog(true), children: [
              "\u26F6 ",
              t("tasks.logFull")
            ] })
          ] }),
          logError !== null && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-error", children: logError }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("pre", { ref: logRef, className: "coi-log", children: log === "" ? t("tasks.logEmpty") : log })
        ] })
      ] })
    ] }),
    fullPrompt && detail !== null && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-modal", onClick: () => setFullPrompt(false), children: /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-modal-box", onClick: (e) => e.stopPropagation(), children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-modal-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: "coi-mono coi-small", children: [
          t("tasks.prompt"),
          " \u2014 ",
          detail.id
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => setFullPrompt(false), children: "\u2715" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("pre", { className: "coi-log coi-log-full coi-prompt-view-full", children: detail.prompt })
    ] }) }),
    fullLog && detail !== null && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-modal", onClick: () => setFullLog(false), children: /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-modal-box", onClick: (e) => e.stopPropagation(), children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-modal-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: "coi-mono coi-small", children: [
          t("tasks.log"),
          " \u2014 ",
          detail.id,
          "\uFF08",
          detail.adapterId,
          " ",
          t("scope." + detail.scope) ?? detail.scope,
          "\uFF09"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => setFullLog(false), children: "\u2715" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("pre", { ref: fullLogRef, className: "coi-log coi-log-full", children: log === "" ? t("tasks.logEmpty") : log })
    ] }) })
  ] });
}
function SessionsPane({ dsSessionId }) {
  const visQs = (dsSessionId ?? "") !== "" ? `&sessionId=${encodeURIComponent(String(dsSessionId))}` : "";
  const [sessions, setSessions] = (0, import_react5.useState)(null);
  const [error, setError] = (0, import_react5.useState)(null);
  const [notice, setNotice] = (0, import_react5.useState)(null);
  const [scopeFilter, setScopeFilter] = (0, import_react5.useState)("");
  const [q, setQ] = (0, import_react5.useState)("");
  const [editId, setEditId] = (0, import_react5.useState)(null);
  const [noteDraft, setNoteDraft] = (0, import_react5.useState)("");
  const load = (0, import_react5.useCallback)(async () => {
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
  (0, import_react5.useEffect)(() => {
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
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-pane", children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-toolbar", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("select", { className: "coi-select", value: scopeFilter, onChange: (e) => setScopeFilter(e.target.value), title: t("sessions.filterScope"), children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("option", { value: "", children: t("all") }),
        SCOPES.map((s) => /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("option", { value: s, children: t(`scope.${s}`) }, s))
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
        "input",
        {
          className: "coi-input",
          placeholder: t("sessions.searchPh"),
          value: q,
          onChange: (e) => setQ(e.target.value)
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn", onClick: () => void load(), children: t("refresh") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(NoticeLine, { notice }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(ErrorLine, { error }),
    sessions === null && error === null && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-muted coi-pad", children: t("loading") }),
    sessions !== null && sessions.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-muted coi-pad", children: t("sessions.empty") }),
    sessions?.map((s) => /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-row-line", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-mono coi-small", children: s.id }),
        s.activeTaskId !== null && s.activeTaskId !== "" && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { title: `${t("sessions.locked")}\uFF1A${s.activeTaskId}`, children: "\u{1F512}" }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-badge", children: t("scope." + s.scope) ?? s.scope }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { children: s.adapterId }),
        s.branch !== null && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-muted coi-mono coi-small", children: s.branch }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: "coi-muted coi-small", children: [
          t("sessions.lastSeen"),
          " ",
          fmtTime(s.lastSeen)
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-row-line", children: [
        editId === s.id ? /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(import_jsx_runtime5.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
            "input",
            {
              className: "coi-input coi-grow",
              value: noteDraft,
              onChange: (e) => setNoteDraft(e.target.value),
              placeholder: t("sessions.note")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => void saveNote(s.id), children: t("sessions.save") })
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(import_jsx_runtime5.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-muted coi-grow", children: s.note !== null && s.note !== "" ? s.note : "\u2014" }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
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
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini coi-btn-danger", onClick: () => void remove(s.id), children: t("sessions.delete") })
      ] })
    ] }, s.id))
  ] });
}
function AdaptersPane() {
  const [adapters, setAdapters] = (0, import_react5.useState)(null);
  const [error, setError] = (0, import_react5.useState)(null);
  const [notice, setNotice] = (0, import_react5.useState)(null);
  const [guideOpen, setGuideOpen] = (0, import_react5.useState)(null);
  const [skillEditId, setSkillEditId] = (0, import_react5.useState)(null);
  const [skillEditName, setSkillEditName] = (0, import_react5.useState)("");
  const [skillContent, setSkillContent] = (0, import_react5.useState)("");
  const [skillSaving, setSkillSaving] = (0, import_react5.useState)(false);
  const [skillError, setSkillError] = (0, import_react5.useState)(null);
  const [useCaseEditId, setUseCaseEditId] = (0, import_react5.useState)(null);
  const [useCaseDraft, setUseCaseDraft] = (0, import_react5.useState)("");
  const [fId, setFId] = (0, import_react5.useState)("");
  const [fName, setFName] = (0, import_react5.useState)("");
  const [fType, setFType] = (0, import_react5.useState)("ai-cli");
  const [fBinary, setFBinary] = (0, import_react5.useState)("");
  const [fArgs, setFArgs] = (0, import_react5.useState)("");
  const [fSkill, setFSkill] = (0, import_react5.useState)("");
  const [fUseCase, setFUseCase] = (0, import_react5.useState)("");
  const [fSkillContent, setFSkillContent] = (0, import_react5.useState)("");
  const [adding, setAdding] = (0, import_react5.useState)(false);
  const load = (0, import_react5.useCallback)(async () => {
    try {
      const data = await fetchJson("/adapters");
      setAdapters(data.adapters);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);
  (0, import_react5.useEffect)(() => {
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
      const skillContent2 = fSkill.trim() !== "" && fSkillContent.trim() !== "" ? fSkillContent : void 0;
      const res = await postJson("/adapters", { def, skillContent: skillContent2 });
      setNotice({ kind: "ok", text: res.skillMessage !== void 0 ? res.skillMessage : t("config.saved") });
      setFId("");
      setFName("");
      setFBinary("");
      setFArgs("");
      setFUseCase("");
      void load();
    } catch (err) {
      setNotice({ kind: "error", text: errText(err) });
    } finally {
      setAdding(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-pane", children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(NoticeLine, { notice }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(ErrorLine, { error }),
    adapters === null && error === null && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-muted coi-pad", children: t("loading") }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-cards", children: adapters?.map((a) => {
      const builtin = BUILTIN_ADAPTER_IDS.has(a.id);
      return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-card coi-adapter-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-row-line", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-strong", children: a.name }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-mono coi-small coi-muted", children: a.id }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-badge", children: a.type }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-badge", children: builtin ? t("adapters.builtin") : t("adapters.custom") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-grow" }),
          a.skillName !== void 0 && a.skillName !== "" && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: "coi-muted coi-small coi-skill-tag", title: t("adapters.skillHint"), children: [
            t("adapters.skill"),
            "\uFF1A",
            a.skillName
          ] }),
          a.skillName !== void 0 && a.skillName !== "" && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => void openSkillEdit(a), children: t("adapters.skillBtn") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
            "button",
            {
              type: "button",
              className: `coi-btn coi-btn-mini${a.enabled === false ? " coi-btn-danger" : ""}`,
              onClick: () => void toggleEnabled(a),
              children: a.enabled === false ? t("adapters.enable") : t("adapters.disable")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => void test(a.id), children: t("adapters.test") }),
          !builtin && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini coi-btn-danger", onClick: () => void remove(a.id), children: t("adapters.delete") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-row-line coi-muted coi-small", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-mono", children: a.binary }),
          a.args.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-mono", children: a.args.join(" ") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-row-line coi-muted coi-small", children: useCaseEditId === a.id ? /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(import_jsx_runtime5.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { children: "\u{1F3AF}" }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
            "input",
            {
              className: "coi-input coi-grow",
              value: useCaseDraft,
              onChange: (e) => setUseCaseDraft(e.target.value),
              placeholder: t("adapters.useCasePh")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini coi-btn-primary", onClick: () => void saveUseCase(a), children: t("adapters.saveUseCase") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => setUseCaseEditId(null), children: t("cancel") })
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(import_jsx_runtime5.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: "coi-grow", children: [
            "\u{1F3AF} ",
            a.useCase !== void 0 && a.useCase !== "" ? a.useCase : t("adapters.useCaseEmpty")
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
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
        a.enabled === false && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-row-line coi-error", children: /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { children: [
          "\u26D4 ",
          t("adapters.disabledHint")
        ] }) }),
        guideOpen === a.id && a.guide !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("pre", { className: "coi-guide", children: a.guide })
      ] }, a.id);
    }) }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-card-title", children: t("adapters.addTitle") }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-form-grid", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: "id" }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("input", { className: "coi-input", value: fId, onChange: (e) => setFId(e.target.value), placeholder: "my-cli" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("adapters.name") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("input", { className: "coi-input", value: fName, onChange: (e) => setFName(e.target.value) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("adapters.type") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("select", { className: "coi-select", value: fType, onChange: (e) => setFType(e.target.value), children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("option", { value: "ai-cli", children: "ai-cli" }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("option", { value: "plain-cli", children: "plain-cli" })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("adapters.binary") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("input", { className: "coi-input", value: fBinary, onChange: (e) => setFBinary(e.target.value), placeholder: "/usr/local/bin/my-cli" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field coi-field-wide", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("adapters.args") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("input", { className: "coi-input", value: fArgs, onChange: (e) => setFArgs(e.target.value), placeholder: t("adapters.argsPh") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field coi-field-wide", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("adapters.skillName") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("input", { className: "coi-input", value: fSkill, onChange: (e) => setFSkill(e.target.value), placeholder: t("adapters.skillNamePh") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field coi-field-wide", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("adapters.useCase") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("input", { className: "coi-input", value: fUseCase, onChange: (e) => setFUseCase(e.target.value), placeholder: t("adapters.useCasePh") })
        ] }),
        fSkill.trim() !== "" && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field coi-field-wide", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("adapters.skillContent") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
            "textarea",
            {
              className: "coi-textarea",
              rows: 5,
              value: fSkillContent,
              onChange: (e) => setFSkillContent(e.target.value),
              placeholder: t("adapters.skillContentPh")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-muted coi-small", children: t("adapters.skillContentHint") })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-form-actions", children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-primary", disabled: adding || fId.trim() === "" || fName.trim() === "" || fBinary.trim() === "", onClick: () => void add(), children: t("adapters.add") }) })
    ] }),
    skillEditId !== null && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-modal", onClick: () => setSkillEditId(null), children: /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-modal-box", onClick: (e) => e.stopPropagation(), children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-modal-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: "coi-small", children: [
          t("adapters.editSkillTitle"),
          "\uFF1A",
          skillEditName
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => setSkillEditId(null), children: "\u2715" })
      ] }),
      skillError !== null && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-error coi-pad", children: skillError }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-pad coi-muted coi-small", children: t("adapters.editSkillHint") }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
        "textarea",
        {
          className: "coi-textarea coi-skill-editor",
          value: skillContent,
          onChange: (e) => setSkillContent(e.target.value),
          placeholder: "# SKILL.md"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-modal-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini", onClick: () => setSkillEditId(null), children: t("cancel") }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-primary coi-btn-mini", disabled: skillSaving, onClick: () => void saveSkill(), children: skillSaving ? t("saving") : t("adapters.saveSkill") })
      ] })
    ] }) })
  ] });
}
function TemplatesPane() {
  const [templates, setTemplates] = (0, import_react5.useState)(null);
  const [adapters, setAdapters] = (0, import_react5.useState)([]);
  const [error, setError] = (0, import_react5.useState)(null);
  const [notice, setNotice] = (0, import_react5.useState)(null);
  const [fId, setFId] = (0, import_react5.useState)("");
  const [fName, setFName] = (0, import_react5.useState)("");
  const [fPrompt, setFPrompt] = (0, import_react5.useState)("");
  const [fAdapterId, setFAdapterId] = (0, import_react5.useState)("");
  const [adding, setAdding] = (0, import_react5.useState)(false);
  const load = (0, import_react5.useCallback)(async () => {
    try {
      const data = await fetchJson("/templates");
      setTemplates(data.templates);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);
  (0, import_react5.useEffect)(() => {
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
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-pane", children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(NoticeLine, { notice }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(ErrorLine, { error }),
    templates === null && error === null && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-muted coi-pad", children: t("loading") }),
    templates !== null && templates.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-muted coi-pad", children: t("templates.empty") }),
    templates?.map((tpl) => /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-row-line", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-strong", children: tpl.name }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-mono coi-small coi-muted", children: tpl.id }),
        tpl.adapterId !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-badge", children: tpl.adapterId }),
        BUILTIN_TEMPLATE_IDS.has(tpl.id) && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-badge", children: t("adapters.builtin") }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-grow" }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-mini coi-btn-danger", onClick: () => void remove(tpl.id), children: t("templates.delete") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-row-line coi-muted", title: tpl.prompt, children: trunc(tpl.prompt, 80) })
    ] }, tpl.id)),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-card-title", children: t("templates.addTitle") }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-form-grid", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("templates.name") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("input", { className: "coi-input", value: fName, onChange: (e) => setFName(e.target.value) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("templates.adapterOpt") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("select", { className: "coi-select", value: fAdapterId, onChange: (e) => setFAdapterId(e.target.value), children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("option", { value: "", children: t("none") }),
            adapters.map((a) => /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("option", { value: a.id, children: a.id }, a.id))
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field coi-field-wide", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("templates.idOpt") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("input", { className: "coi-input", value: fId, onChange: (e) => setFId(e.target.value), placeholder: "my-template" })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("templates.prompt") }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("textarea", { className: "coi-textarea", rows: 3, value: fPrompt, onChange: (e) => setFPrompt(e.target.value) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-form-actions", children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-primary", disabled: adding || fName.trim() === "" || fPrompt.trim() === "", onClick: () => void add(), children: t("templates.add") }) })
    ] })
  ] });
}
function StatsPane() {
  const [stats, setStats] = (0, import_react5.useState)(null);
  const [error, setError] = (0, import_react5.useState)(null);
  const load = (0, import_react5.useCallback)(async () => {
    try {
      const data = await fetchJson("/stats");
      setStats(data);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);
  (0, import_react5.useEffect)(() => {
    void load();
  }, [load]);
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-pane", children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-toolbar", children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn", onClick: () => void load(), children: t("refresh") }) }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(ErrorLine, { error }),
    stats === null && error === null && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-muted coi-pad", children: t("loading") }),
    stats !== null && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(import_jsx_runtime5.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-stat-grid", children: /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-stat-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-stat-num", children: stats.total }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-muted", children: t("stats.total") })
      ] }) }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-stat-grid", children: Object.entries(stats.byAdapter).map(([id, bucket]) => /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-stat-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-strong", children: id }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-stat-num", children: bucket.count }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-muted coi-small", children: [
          t("stats.count"),
          " \xB7 ",
          t("stats.hours"),
          " ",
          (bucket.totalMs / 36e5).toFixed(2),
          "h"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-row-line coi-small", children: Object.entries(bucket.byStatus).map(([status, count]) => {
          const meta = statusMeta(status);
          return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: meta.cls, title: meta.label, children: [
            meta.icon,
            " ",
            count
          ] }, status);
        }) })
      ] }, id)) }),
      Object.keys(stats.byAdapter).length === 0 && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-muted coi-pad", children: t("stats.empty") })
    ] })
  ] });
}
function ConfigPane() {
  const [loaded, setLoaded] = (0, import_react5.useState)(false);
  const [error, setError] = (0, import_react5.useState)(null);
  const [notice, setNotice] = (0, import_react5.useState)(null);
  const [notify, setNotify] = (0, import_react5.useState)("");
  const [retention, setRetention] = (0, import_react5.useState)("");
  const [timeoutH, setTimeoutH] = (0, import_react5.useState)("");
  const [defaultInject, setDefaultInject] = (0, import_react5.useState)(false);
  const [timeoutM, setTimeoutM] = (0, import_react5.useState)("");
  const [saving, setSaving] = (0, import_react5.useState)(false);
  (0, import_react5.useEffect)(() => {
    fetchJson("/config").then((data) => {
      setNotify(data.config.coiNotifyCommand ?? "");
      setRetention(String(data.config.coiRetentionDays ?? ""));
      const ms = data.config.coiTaskTimeoutMs ?? 0;
      setTimeoutH(String(Math.floor(ms / 36e5)));
      setTimeoutM(String(Math.round(ms % 36e5 / 6e4)));
      setDefaultInject(data.config.coiDefaultInjectContext === true);
      setLoaded(true);
    }).catch((err) => setError(errText(err)));
  }, []);
  const save = async () => {
    setSaving(true);
    try {
      const patch = { coiNotifyCommand: notify, coiDefaultInjectContext: defaultInject };
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
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-pane", children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(NoticeLine, { notice }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(ErrorLine, { error }),
    !loaded && error === null && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-muted coi-pad", children: t("loading") }),
    loaded && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("config.notify") }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("input", { className: "coi-input", value: notify, onChange: (e) => setNotify(e.target.value) }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-muted coi-small", children: t("config.notifyHint") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("config.retention") }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("input", { className: "coi-input", type: "number", min: 0, value: retention, onChange: (e) => setRetention(e.target.value) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("config.timeout") }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "coi-inline", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("input", { className: "coi-input", type: "number", min: 0, value: timeoutH, onChange: (e) => setTimeoutH(e.target.value), placeholder: "0" }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-muted coi-small", children: t("config.timeoutHours") }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("input", { className: "coi-input", type: "number", min: 0, max: 59, value: timeoutM, onChange: (e) => setTimeoutM(e.target.value), placeholder: "0" }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-muted coi-small", children: t("config.timeoutMinutes") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-muted coi-small", children: t("config.timeoutHint") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("label", { className: "coi-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: "coi-field-check", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("input", { type: "checkbox", checked: defaultInject, onChange: (e) => setDefaultInject(e.target.checked) }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-label", children: t("config.defaultInject") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "coi-muted coi-small", children: t("config.defaultInjectHint") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "coi-form-actions", children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: "coi-btn coi-btn-primary", disabled: saving, onClick: () => void save(), children: t("config.save") }) })
    ] })
  ] });
}

// src/client/ScratchView.tsx
var import_react6 = require("react");
var import_jsx_runtime6 = require("react/jsx-runtime");
var DEBOUNCE_MS = 800;
var RETRY_MS = 3e3;
var DICT2 = {
  zh: {
    help: "\u4E34\u65F6\u60F3\u6CD5\u3001\u968F\u624B\u8BB0\u90FD\u653E\u8FD9\u91CC\uFF08Markdown \u683C\u5F0F\uFF09\uFF1A\u5185\u5BB9\u81EA\u52A8\u4FDD\u5B58\u5230 ~/.dsh/memories/scratch.md\uFF0C\u91CD\u542F\u4E0D\u4E22\uFF1B\u6574\u7406\u5B8C\u6210\u540E\u8FC1\u79FB\u5230\u522B\u5904\u6216\u5220\u9664\u5373\u53EF\u3002",
    placeholder: "\u5199\u4E0B\u4E34\u65F6\u7684\u60F3\u6CD5\u2026\n\n\u652F\u6301 Markdown \u683C\u5F0F\uFF1B\u505C\u6B62\u8F93\u5165\u540E\u81EA\u52A8\u4FDD\u5B58\uFF0C\u968F\u65F6\u56DE\u6765\u7EE7\u7EED\u5199\u3002",
    saving: "\u4FDD\u5B58\u4E2D\u2026",
    dirty: "\u7F16\u8F91\u4E2D\uFF0C\u5373\u5C06\u81EA\u52A8\u4FDD\u5B58\u2026",
    saveFailed: "\u4FDD\u5B58\u5931\u8D25\uFF1A{message}\uFF08\u7A0D\u540E\u81EA\u52A8\u91CD\u8BD5\uFF09",
    loadFailed: "\u8BFB\u53D6\u5931\u8D25\uFF1A{message}",
    open: "\u7528\u7CFB\u7EDF\u5DE5\u5177\u6253\u5F00",
    openFailed: "\u6253\u5F00\u5931\u8D25\uFF1A{message}",
    savedAt: "\u5DF2\u4FDD\u5B58 {time}",
    neverSaved: "\u8FD8\u6CA1\u6709\u4FDD\u5B58\u8FC7"
  },
  en: {
    help: "Jot down temporary ideas (Markdown). Content auto-saves to ~/.dsh/memories/scratch.md and survives restarts; migrate it elsewhere or delete it once it has served its purpose.",
    placeholder: "Write temporary thoughts\u2026\n\nMarkdown is supported; auto-saves after you stop typing.",
    saving: "Saving\u2026",
    dirty: "Editing \u2014 will auto-save\u2026",
    saveFailed: "Save failed: {message} (will retry shortly)",
    loadFailed: "Load failed: {message}",
    open: "Open with system tool",
    openFailed: "Open failed: {message}",
    savedAt: "Saved {time}",
    neverSaved: "Never saved yet"
  }
};
function pick(zhText, enText) {
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("en") ? enText : zhText;
}
function errText2(err) {
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
  const [loaded, setLoaded] = (0, import_react6.useState)(false);
  const [error, setError] = (0, import_react6.useState)(null);
  const [content, setContent] = (0, import_react6.useState)("");
  const [savedContent, setSavedContent] = (0, import_react6.useState)("");
  const [path, setPath] = (0, import_react6.useState)(null);
  const [mtime, setMtime] = (0, import_react6.useState)(null);
  const [saving, setSaving] = (0, import_react6.useState)(false);
  const [saveError, setSaveError] = (0, import_react6.useState)(null);
  const [saveTick, setSaveTick] = (0, import_react6.useState)(0);
  const contentRef = (0, import_react6.useRef)(content);
  const savedContentRef = (0, import_react6.useRef)(savedContent);
  const pathRef = (0, import_react6.useRef)(path);
  (0, import_react6.useEffect)(() => {
    contentRef.current = content;
  }, [content]);
  (0, import_react6.useEffect)(() => {
    savedContentRef.current = savedContent;
  }, [savedContent]);
  (0, import_react6.useEffect)(() => {
    pathRef.current = path;
  }, [path]);
  const savingRef = (0, import_react6.useRef)(false);
  const pendingRef = (0, import_react6.useRef)(false);
  const load = (0, import_react6.useCallback)(async () => {
    try {
      const res = await fetch("/memory-evolve/api/scratch");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setContent(data.content);
      setSavedContent(data.content);
      setPath(data.path);
      setMtime(data.mtime);
      setError(null);
      setLoaded(true);
    } catch (err) {
      setError(errText2(err));
    }
  }, []);
  (0, import_react6.useEffect)(() => {
    void load();
  }, [load]);
  const save = (0, import_react6.useCallback)(async () => {
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
    } catch (err) {
      setSaveError(errText2(err));
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
  (0, import_react6.useEffect)(() => {
    if (contentRef.current === savedContentRef.current) return;
    const timer = setTimeout(() => void save(), saveError === null ? DEBOUNCE_MS : RETRY_MS);
    return () => clearTimeout(timer);
  }, [content, savedContent, saveError, saveTick, save]);
  (0, import_react6.useEffect)(() => {
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
    } catch (err) {
      setSaveError(pick(DICT2.zh.openFailed, DICT2.en.openFailed).replace("{message}", errText2(err)));
    }
  };
  const statusText = () => {
    if (saving) return pick(DICT2.zh.saving, DICT2.en.saving);
    if (saveError !== null) return saveError;
    if (dirty) return pick(DICT2.zh.dirty, DICT2.en.dirty);
    return mtime === null ? pick(DICT2.zh.neverSaved, DICT2.en.neverSaved) : pick(DICT2.zh.savedAt, DICT2.en.savedAt).replace("{time}", formatTime3(mtime));
  };
  const statusKind = saveError !== null ? "error" : saving || dirty ? "pending" : "ok";
  return /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "sp-root", children: [
    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "sp-head", children: /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("span", { className: "sp-path", title: path ?? "", children: [
      "\u{1F4DD} ",
      path ?? ""
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("p", { className: "sp-help", children: pick(DICT2.zh.help, DICT2.en.help) }),
    error !== null && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "sp-notice sp-notice-error", children: error }),
    loaded && /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(import_jsx_runtime6.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
        "textarea",
        {
          className: "sp-editor",
          value: content,
          onChange: (e) => setContent(e.target.value),
          placeholder: pick(DICT2.zh.placeholder, DICT2.en.placeholder),
          spellCheck: false
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "sp-toolbar", children: [
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: `sp-status sp-status-${statusKind}`, children: statusText() }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: "sp-spacer" }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("button", { type: "button", className: "sp-btn", onClick: () => void openFile(), title: path ?? "", children: pick(DICT2.zh.open, DICT2.en.open) })
      ] })
    ] }),
    !loaded && error === null && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "sp-loading", children: pick(DICT2.zh.saving, DICT2.en.saving) })
  ] });
}

// src/client/PromptView.tsx
var import_react7 = require("react");
var import_jsx_runtime7 = require("react/jsx-runtime");
var DICT3 = {
  zh: {
    search: "\u641C\u7D22\u540D\u79F0\u3001\u5206\u7C7B\u3001\u6807\u7B7E\u6216\u5185\u5BB9\u2026",
    new: "\u65B0\u5EFA\u63D0\u793A\u8BCD",
    all: "\u5168\u90E8",
    uncategorized: "\u672A\u5206\u7C7B",
    inject: "\u6CE8\u5165",
    injectRound: "\u6CE8\u5165 {n} \u6B21",
    injectOnce: "\u6CE8\u5165 1 \u6B21\uFF08\u4E00\u6B21\u6027\uFF09",
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
    selectHint: "\u4ECE\u5DE6\u4FA7\u9009\u62E9\u4E00\u4E2A\u63D0\u793A\u8BCD\u67E5\u770B\uFF0C\u6216\u70B9\u300C\u65B0\u5EFA\u63D0\u793A\u8BCD\u300D",
    formNew: "\u65B0\u5EFA\u63D0\u793A\u8BCD",
    formEdit: "\u7F16\u8F91\u63D0\u793A\u8BCD",
    name: "\u540D\u79F0",
    namePh: "\u5982\uFF1A\u4EE3\u7801\u5BA1\u67E5\uFF08Code Review\uFF09",
    category: "\u5206\u7C7B",
    categoryPh: "\u5982\uFF1A\u5F00\u53D1\u6D41\u7A0B\uFF08\u7559\u7A7A\u4E3A\u300C\u672A\u5206\u7C7B\u300D\uFF09",
    tags: "\u6807\u7B7E",
    tagsPh: "\u9017\u53F7\u5206\u9694\uFF0C\u5982\uFF1Areview, \u8D28\u91CF",
    content: "\u5185\u5BB9",
    contentPh: "\u5728\u8FD9\u91CC\u7F16\u5199\u63D0\u793A\u8BCD\u6B63\u6587\u2026\n\u652F\u6301 {{date}}\u3001{{time}} \u53D8\u91CF\uFF0C\u6CE8\u5165\u65F6\u81EA\u52A8\u5C55\u5F00\u3002",
    usage: "\u5DF2\u6CE8\u5165 {n} \u6B21",
    lastUsed: "\u6700\u8FD1\u6CE8\u5165\uFF1A{time}",
    neverUsed: "\u4ECE\u672A\u6CE8\u5165\u8FC7",
    rounds: "\u6B21\u6570",
    cadence: "\u95F4\u9694",
    error: "{message}",
    loadFailed: "\u52A0\u8F7D\u5931\u8D25\uFF1A{message}",
    injected: "\u5DF2\u6CE8\u5165\u300C{name}\u300D\uFF1A{rounds}\uFF0C{cadence}\uFF0C\u6A21\u578B\u4E0B\u4E00\u8F6E\u751F\u6548",
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
    search: "Search name, category, tags or content\u2026",
    new: "New prompt",
    all: "All",
    uncategorized: "Uncategorized",
    inject: "Inject",
    injectRound: "Inject {n} times",
    injectOnce: "Inject once",
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
    selectHint: 'Select a prompt to view, or click "New prompt"',
    formNew: "New prompt",
    formEdit: "Edit prompt",
    name: "Name",
    namePh: "e.g. Code Review",
    category: "Category",
    categoryPh: "e.g. workflow (empty = Uncategorized)",
    tags: "Tags",
    tagsPh: "Comma-separated, e.g. review, quality",
    content: "Content",
    contentPh: "Write the prompt body here\u2026\n{{date}} and {{time}} variables expand on inject.",
    usage: "Injected {n} times",
    lastUsed: "Last injected: {time}",
    neverUsed: "Never injected",
    rounds: "Count",
    cadence: "Cadence",
    error: "{message}",
    loadFailed: "Load failed: {message}",
    injected: 'Injected "{name}": {rounds}, {cadence} \u2014 visible to the model next turn',
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
function errText3(err) {
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
var ROUND_OPTIONS = [0, 1, 3, 5, 10];
var EVERY_OPTIONS = [1, 2, 3, 5, 10];
function PromptView(_props) {
  const lang = typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("en") ? "en" : "zh";
  const D = DICT3[lang];
  const say = (key) => D[key];
  const [prompts, setPrompts] = (0, import_react7.useState)([]);
  const [injections, setInjections] = (0, import_react7.useState)([]);
  const [sources, setSources] = (0, import_react7.useState)([]);
  const [categories, setCategories] = (0, import_react7.useState)([]);
  const [search, setSearch] = (0, import_react7.useState)("");
  const [category, setCategory] = (0, import_react7.useState)("\u5168\u90E8");
  const [selectedId, setSelectedId] = (0, import_react7.useState)(null);
  const [creating, setCreating] = (0, import_react7.useState)(false);
  const [showInjections, setShowInjections] = (0, import_react7.useState)(false);
  const [showSources, setShowSources] = (0, import_react7.useState)(false);
  const [error, setError] = (0, import_react7.useState)(null);
  const [notice, setNotice] = (0, import_react7.useState)(null);
  const [rounds, setRounds] = (0, import_react7.useState)(0);
  const [every, setEvery] = (0, import_react7.useState)(1);
  const [busy, setBusy] = (0, import_react7.useState)(false);
  const [addingCategory, setAddingCategory] = (0, import_react7.useState)(false);
  const [newCategoryName, setNewCategoryName] = (0, import_react7.useState)("");
  const [renamingCategory, setRenamingCategory] = (0, import_react7.useState)(null);
  const [renameValue, setRenameValue] = (0, import_react7.useState)("");
  const [name, setName] = (0, import_react7.useState)("");
  const [formCategory, setFormCategory] = (0, import_react7.useState)("");
  const [tags, setTags] = (0, import_react7.useState)("");
  const [content, setContent] = (0, import_react7.useState)("");
  const overlayRef = (0, import_react7.useRef)(null);
  (0, import_react7.useEffect)(() => {
    const onDown = (e) => {
      if (overlayRef.current === null || overlayRef.current.contains(e.target)) return;
      setShowInjections(false);
      setShowSources(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);
  const showError = (0, import_react7.useCallback)((err) => {
    setError(errText3(err));
  }, []);
  const showNotice = (0, import_react7.useCallback)((text) => {
    setNotice(text);
    window.setTimeout(() => setNotice(null), 4e3);
  }, []);
  const load = (0, import_react7.useCallback)(async () => {
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
      showError(say("loadFailed").replace("{message}", errText3(err)));
    }
  }, [showError]);
  (0, import_react7.useEffect)(() => {
    void load();
    void api4("/memory-evolve/api/prompts/sources").then((data) => setSources(data.sources)).catch(() => {
    });
  }, [load]);
  const displayCategories = (0, import_react7.useMemo)(() => {
    const promptCats = prompts.map((p) => p.category).filter((c) => c && c !== "\u672A\u5206\u7C7B");
    return [.../* @__PURE__ */ new Set([...categories, ...promptCats])].sort((a, b) => a.localeCompare(b, "zh"));
  }, [categories, prompts]);
  const uncategorizedCount = (0, import_react7.useMemo)(
    () => prompts.filter((p) => p.category === "\u672A\u5206\u7C7B").length,
    [prompts]
  );
  const filtered = (0, import_react7.useMemo)(() => {
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
    setFormCategory(p.category === "\u672A\u5206\u7C7B" ? "" : p.category);
    setTags(p.tags.join(", "));
    setContent(p.content);
  };
  const startCreate = () => {
    setSelectedId(null);
    setCreating(true);
    setName("");
    setFormCategory("");
    setTags("");
    setContent("");
    setError(null);
  };
  const savePrompt = async () => {
    if (busy) return;
    const body = {
      name,
      category: formCategory,
      tags: tags.split(/[,，]/).map((t2) => t2.trim()).filter(Boolean),
      content
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
      showError(errText3(err));
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
      showError(errText3(err));
    }
  };
  const injectPrompt = async () => {
    if (selectedId === null) return;
    try {
      const data = await api4(
        `/memory-evolve/api/prompts/${encodeURIComponent(selectedId)}/inject`,
        { method: "POST", body: JSON.stringify({ rounds, every }) }
      );
      const cadence = (data.injection.every ?? 1) === 1 ? say("everyTurn") : say("injectCadence").replace("{n}", String(data.injection.every));
      const times = data.injection.roundsLeft === null ? say("injectInfinite") : say("injectRound").replace("{n}", String(data.injection.roundsLeft));
      showNotice(say("injected").replace("{name}", data.injection.title).replace("{rounds}", times).replace("{cadence}", cadence));
      await load();
      setShowInjections(true);
      window.dispatchEvent(new CustomEvent("dsh-memory-evolve:badge-change"));
    } catch (err) {
      showError(errText3(err));
    }
  };
  const removeInjection = async (id) => {
    try {
      await api4(`/memory-evolve/api/prompts/injections/${encodeURIComponent(id)}`, { method: "DELETE" });
      showNotice(say("stoppedInjection"));
      await load();
      window.dispatchEvent(new CustomEvent("dsh-memory-evolve:badge-change"));
    } catch (err) {
      showError(errText3(err));
    }
  };
  const activeInjectionOf = (promptId) => injections.find((i) => i.sourcePromptId === promptId);
  const cadenceLabel = (inj) => (inj.every ?? 1) === 1 ? say("everyTurn") : say("injectCadence").replace("{n}", String(inj.every));
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
      showError(errText3(err));
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
      showError(errText3(err));
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
      showError(errText3(err));
    }
  };
  const copyPrompt = async () => {
    const text = selected?.content ?? "";
    try {
      await navigator.clipboard.writeText(text);
      showNotice(say("copied"));
    } catch (err) {
      showError(errText3(err));
    }
  };
  const summaryLine = (p) => {
    const first = p.content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    return first.length > 60 ? `${first.slice(0, 60)}\u2026` : first;
  };
  const selectedIsDirty = selected !== null && (name !== selected.name || (formCategory || "\u672A\u5206\u7C7B") !== selected.category || tags !== selected.tags.join(", ") || content !== selected.content);
  return /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-root", children: [
    /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-toolbar", children: [
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
        "input",
        {
          className: "pm-search",
          placeholder: say("search"),
          value: search,
          onChange: (e) => setSearch(e.target.value)
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
        "select",
        {
          className: "pm-select",
          value: category,
          onChange: (e) => setCategory(e.target.value),
          title: say("category"),
          children: categories.map((c) => /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("option", { value: c, children: c }, c))
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(
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
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
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
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("button", { type: "button", className: "pm-primary-btn", onClick: startCreate, children: say("new") })
    ] }),
    (error !== null || notice !== null) && /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: `pm-banner ${error !== null ? "pm-banner-error" : ""}`, children: [
      error !== null ? error : notice,
      error !== null && /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("button", { type: "button", className: "pm-banner-close", onClick: () => setError(null), children: "\xD7" })
    ] }),
    showInjections && /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-overlay", ref: overlayRef, children: [
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { className: "pm-overlay-title", children: say("injecting") }),
      injections.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { className: "pm-overlay-empty", children: say("noInjection") }),
      injections.map((inj) => /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-overlay-item", children: [
        /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-overlay-item-main", children: [
          /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-overlay-item-title", children: [
            "\u300C",
            inj.title,
            "\u300D"
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-overlay-item-sub", children: [
            remainingLabel(inj),
            " \xB7 ",
            cadenceLabel(inj)
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("button", { type: "button", className: "pm-danger-btn pm-overlay-remove", onClick: () => void removeInjection(inj.id), children: say("removeInjection") })
      ] }, inj.id))
    ] }),
    showSources && /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-overlay pm-overlay-wide", ref: overlayRef, children: [
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { className: "pm-overlay-title", children: say("sources") }),
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { className: "pm-overlay-sub", children: say("sourcesHint") }),
      sources.map((s) => /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-source-item", children: [
        /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("a", { className: "pm-source-link", href: s.url, target: "_blank", rel: "noreferrer", children: s.name }),
        /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { className: "pm-source-desc", children: s.desc })
      ] }, s.url))
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-body", children: [
      /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-pane-cats", children: [
        /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(
          "button",
          {
            type: "button",
            className: `pm-cat ${category === "\u5168\u90E8" ? "pm-cat-active" : ""}`,
            onClick: () => setCategory("\u5168\u90E8"),
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "pm-cat-name", children: say("all") }),
              /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "pm-cat-count", children: prompts.length })
            ]
          }
        ),
        displayCategories.map((c) => {
          const count = prompts.filter((p) => p.category === c).length;
          if (renamingCategory === c) {
            return /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-cat-row", children: [
              /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
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
              /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("button", { type: "button", className: "pm-cat-add-ok", onClick: () => void renameCategory(c), children: "\u2713" })
            ] }, c);
          }
          return /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-cat-row", children: [
            /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(
              "button",
              {
                type: "button",
                className: `pm-cat ${category === c ? "pm-cat-active" : ""}`,
                onClick: () => setCategory(c),
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "pm-cat-name", children: c }),
                  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "pm-cat-count", children: count })
                ]
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
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
            /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
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
        uncategorizedCount > 0 && /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(
          "button",
          {
            type: "button",
            className: `pm-cat ${category === "\u672A\u5206\u7C7B" ? "pm-cat-active" : ""}`,
            onClick: () => setCategory("\u672A\u5206\u7C7B"),
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "pm-cat-name", children: say("uncategorized") }),
              /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "pm-cat-count", children: uncategorizedCount })
            ]
          }
        ),
        addingCategory ? /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-cat-add", children: [
          /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
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
          /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("button", { type: "button", className: "pm-cat-add-ok", onClick: () => void addCategory(), children: "\u2713" })
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("button", { type: "button", className: "pm-cat-add-btn", onClick: () => setAddingCategory(true), children: [
          "\uFF0B ",
          say("newCategory")
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-pane-list", children: [
        prompts.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { className: "pm-pane-empty", children: say("empty") }),
        prompts.length > 0 && filtered.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { className: "pm-pane-empty", children: say("noMatch") }),
        filtered.map((p) => {
          const active = activeInjectionOf(p.id);
          return /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(
            "button",
            {
              type: "button",
              className: `pm-item ${selectedId === p.id && !creating ? "pm-item-active" : ""}`,
              onClick: () => selectPrompt(p.id),
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-item-row1", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "pm-item-name", children: p.name }),
                  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "pm-item-badge", children: p.category }),
                  active !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "pm-item-badge pm-item-badge-active", title: say("injectHint"), children: active.roundsLeft === null ? say("injectingBadgeInfinite") : say("injectingBadge").replace("{n}", String(active.roundsLeft)) })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { className: "pm-item-summary", children: summaryLine(p) }),
                /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-item-row3", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "pm-item-usage", children: say("usage").replace("{n}", String(p.usageCount ?? 0)) }),
                  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "pm-item-used", children: p.lastUsedAt !== null ? say("lastUsed").replace("{time}", formatTime4(p.lastUsedAt)) : say("neverUsed") })
                ] })
              ]
            },
            p.id
          );
        })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-pane-detail", children: [
        selected === null && !creating && /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { className: "pm-detail-hint", children: say("selectHint") }),
        (selected !== null || creating) && /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-form", children: [
          /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { className: "pm-form-title", children: creating ? say("formNew") : say("formEdit") }),
          /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("label", { className: "pm-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("span", { className: "pm-field-label", children: [
              say("name"),
              " *"
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
              "input",
              {
                className: "pm-input",
                placeholder: say("namePh"),
                value: name,
                onChange: (e) => setName(e.target.value)
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("label", { className: "pm-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "pm-field-label", children: say("category") }),
            /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
              "input",
              {
                className: "pm-input",
                list: "pm-category-list",
                placeholder: say("categoryPh"),
                value: formCategory,
                onChange: (e) => setFormCategory(e.target.value)
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("datalist", { id: "pm-category-list", children: displayCategories.map((c) => /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("option", { value: c }, c)) })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("label", { className: "pm-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "pm-field-label", children: say("tags") }),
            /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
              "input",
              {
                className: "pm-input",
                placeholder: say("tagsPh"),
                value: tags,
                onChange: (e) => setTags(e.target.value)
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("label", { className: "pm-field pm-field-grow", children: [
            /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("span", { className: "pm-field-label", children: [
              say("content"),
              " *"
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
              "textarea",
              {
                className: "pm-textarea",
                placeholder: say("contentPh"),
                value: content,
                onChange: (e) => setContent(e.target.value)
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-actions", children: [
            !creating && (() => {
              const active = selected !== null ? activeInjectionOf(selected.id) : void 0;
              if (active !== void 0) {
                return /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(import_jsx_runtime7.Fragment, { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("span", { className: "pm-inject-status", children: [
                    active.roundsLeft === null ? say("injectingBadgeInfinite") : say("injectingBadge").replace("{n}", String(active.roundsLeft)),
                    " ",
                    "\xB7 ",
                    cadenceLabel(active)
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("button", { type: "button", className: "pm-danger-btn", onClick: () => void removeInjection(active.id), children: say("removeInjection") })
                ] });
              }
              return /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(import_jsx_runtime7.Fragment, { children: [
                /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "pm-inject-group", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
                    "select",
                    {
                      className: "pm-select pm-rounds",
                      value: rounds,
                      onChange: (e) => setRounds(Number(e.target.value)),
                      title: say("rounds"),
                      children: ROUND_OPTIONS.map((r) => /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("option", { value: r, children: r === 0 ? say("injectInfinite") : r === 1 ? say("injectOnce") : say("injectRound").replace("{n}", String(r)) }, r))
                    }
                  ),
                  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
                    "select",
                    {
                      className: "pm-select pm-rounds",
                      value: every,
                      onChange: (e) => setEvery(Number(e.target.value)),
                      title: say("cadence"),
                      children: EVERY_OPTIONS.map((e) => /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("option", { value: e, children: e === 1 ? say("everyTurn") : say("injectCadence").replace("{n}", String(e)) }, e))
                    }
                  ),
                  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("button", { type: "button", className: "pm-primary-btn", onClick: () => void injectPrompt(), children: say("inject") })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("button", { type: "button", className: "pm-tool-btn", onClick: () => void copyPrompt(), children: say("copy") })
              ] });
            })(),
            /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("button", { type: "button", className: "pm-tool-btn", onClick: () => void savePrompt(), disabled: busy, children: busy ? say("saving") : say("save") }),
            !creating && /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("button", { type: "button", className: "pm-danger-btn", onClick: () => void deletePrompt(), children: say("delete") }),
            creating && /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("button", { type: "button", className: "pm-tool-btn", onClick: () => {
              setCreating(false);
              setSelectedId(null);
            }, children: say("cancel") })
          ] }),
          !creating && selected !== null && selectedIsDirty && /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { className: "pm-dirty-hint", children: pick2("\u6709\u672A\u4FDD\u5B58\u7684\u4FEE\u6539", "Unsaved changes") })
        ] })
      ] })
    ] })
  ] });
}

// src/client/styles.css
var styles_default = "/**\n * dsh-memory-evolve panel styles \u2014 DSH design tokens, `me-` prefix.\n * Colors come exclusively from --dsw-alias-* / --dsw-static-* tokens so the\n * panel follows the light/dark theme automatically (no hardcoded colors).\n */\n\n/* ---------- Root ---------- */\n\n.me-panel {\n  height: 100%;\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: column;\n  gap: 20px;\n  overflow-y: auto;\n  padding: 4px 2px 28px;\n  font-family: var(--dsw-font-family, inherit);\n  color: var(--dsw-alias-label-primary);\n}\n\n/* Inside the session memory tab: the panel is a sub-view, not a full-height\n   settings column \u2014 cap its height so the tab never grows the page. */\n.mt-panel .me-panel {\n  height: auto;\n  max-height: 62vh;\n}\n\n/* ---------- Notice bar (success / error) ---------- */\n\n.me-notice {\n  flex: none;\n  display: flex;\n  align-items: flex-start;\n  gap: 8px;\n  padding: 8px 12px;\n  border-radius: 8px;\n  font-size: 12px;\n  line-height: 1.5;\n}\n\n.me-notice::before {\n  content: '';\n  flex: none;\n  width: 6px;\n  height: 6px;\n  margin-top: 6px;\n  border-radius: 50%;\n}\n\n.me-notice-ok {\n  color: var(--dsw-alias-state-success-primary);\n  background: var(--dsw-alias-state-success-tertiary);\n  border: 1px solid var(--dsw-alias-state-success-primary);\n}\n.me-notice-ok::before {\n  background: var(--dsw-alias-state-success-primary);\n}\n\n.me-notice-error {\n  color: var(--dsw-alias-state-error-primary);\n  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);\n  border: 1px solid var(--dsw-alias-state-error-secondary);\n}\n.me-notice-error::before {\n  background: var(--dsw-alias-state-error-primary);\n}\n\n/* ---------- Section cards ---------- */\n\n.me-block {\n  flex: none;\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  padding: 14px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  background: var(--dsw-alias-bg-layer-1);\n}\n\n.me-block-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n\n.me-heading {\n  margin: 0;\n  font-size: 13px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-count {\n  flex: none;\n  min-width: 18px;\n  box-sizing: border-box;\n  padding: 1px 6px;\n  border-radius: 9px;\n  font-size: 11px;\n  line-height: 16px;\n  text-align: center;\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n.me-help {\n  margin: -4px 0 0;\n  font-size: 12px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.me-muted {\n  margin: 0;\n  padding: 8px 0;\n  font-size: 12px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n/* Friendly empty state */\n.me-empty {\n  margin: 0;\n  padding: 22px 12px;\n  border: 1px dashed var(--dsw-alias-border-l3);\n  border-radius: 10px;\n  font-size: 12px;\n  line-height: 1.5;\n  text-align: center;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n/* ---------- Suggestion list (own scroll area) ---------- */\n\n.me-list {\n  margin: 0;\n  padding: 0 2px 0 0;\n  list-style: none;\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  max-height: 380px;\n  overflow-y: auto;\n}\n\n.me-item {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  padding: 10px 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-base);\n  transition: border-color 120ms ease;\n}\n\n.me-item:hover {\n  border-color: var(--dsw-alias-border-l3);\n}\n\n.me-item-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n}\n\n.me-badge {\n  flex: none;\n  max-width: 45%;\n  padding: 1px 8px;\n  border-radius: 9px;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n.me-badge-hits {\n  color: var(--dsw-alias-state-warn-primary);\n  background: var(--dsw-alias-state-warn-tertiary);\n}\n\n/* \u5F85\u786E\u8BA4\u5EFA\u8BAE\u7684\u76EE\u6807\u5FBD\u6807\uFF1A\u6309\u8F68\u7740\u8272\uFF0C\u9192\u76EE\u533A\u5206\u8981\u5199\u5165\u54EA\u7C7B\u8BB0\u5FC6 */\n.me-badge-suggest {\n  border: 1px solid transparent;\n  font-size: 11px;\n  line-height: 18px;\n  padding: 1px 10px;\n}\n\n.me-badge-suggest-memory {\n  color: var(--dsw-static-blue-5, #3b82f6);\n  background: color-mix(in srgb, var(--dsw-static-blue-5, #3b82f6) 16%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-blue-5, #3b82f6) 45%, transparent);\n}\n\n.me-badge-suggest-user {\n  color: var(--dsw-static-green-5, #16a34a);\n  background: color-mix(in srgb, var(--dsw-static-green-5, #16a34a) 16%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-green-5, #16a34a) 45%, transparent);\n}\n\n.me-badge-suggest-key {\n  color: var(--dsw-static-amber-6, #d97706);\n  background: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 18%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 48%, transparent);\n}\n\n.me-badge-suggest-todo {\n  color: var(--dsw-static-purple-5, #9333ea);\n  background: color-mix(in srgb, var(--dsw-static-purple-5, #9333ea) 16%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-purple-5, #9333ea) 45%, transparent);\n}\n\n/* \u91C7\u7EB3\u76EE\u6807\u9009\u62E9\u4E0B\u62C9\uFF08\u9ED8\u8BA4=AI \u63A8\u8350\u8F68\uFF0C\u53EF\u6539\u5206\u7C7B\uFF09 */\n.me-pick-target {\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 6px;\n  padding: 2px 6px;\n  font-size: 11px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n}\n\n/* \u4F7F\u7528\u6307\u5357\u9762\u677F */\n.me-guide {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.me-guide-row {\n  display: flex;\n  gap: 10px;\n  align-items: flex-start;\n  padding: 8px 10px;\n  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-l2, rgba(128, 128, 128, 0.06));\n}\n\n.me-guide-icon {\n  flex: none;\n  font-size: 16px;\n  line-height: 20px;\n}\n\n.me-guide-body {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  min-width: 0;\n}\n\n.me-guide-body strong {\n  font-size: 12px;\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-guide-body span {\n  font-size: 12px;\n  line-height: 1.55;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.me-guide-sub {\n  margin: 14px 0 6px;\n  font-size: 12px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-guide-tips {\n  margin: 0;\n  padding-left: 18px;\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  font-size: 12px;\n  line-height: 1.55;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.me-guide-loop {\n  margin: 12px 0 0;\n  font-size: 12px;\n  font-weight: 600;\n  color: var(--dsw-static-blue-5, #3b82f6);\n}\n\n.me-item-time {\n  flex: 1;\n  min-width: 0;\n  font-size: 11px;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.me-item-actions {\n  flex: none;\n  display: flex;\n  gap: 6px;\n}\n\n.me-item-edit {\n  width: 100%;\n  box-sizing: border-box;\n  padding: 8px 10px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  outline: none;\n  background: var(--dsw-alias-bg-layer-1);\n  color: var(--dsw-alias-label-primary);\n  font-family: var(--dsw-font-family, inherit);\n  font-size: 12px;\n  line-height: 1.6;\n  resize: vertical;\n  transition: border-color 120ms ease, background-color 120ms ease;\n}\n\n.me-item-edit:hover {\n  border-color: var(--dsw-alias-border-l3);\n}\n\n.me-item-edit:focus-visible {\n  border-color: var(--dsw-alias-state-business-primary);\n}\n\n.me-item-reason {\n  margin: 0;\n  padding-left: 8px;\n  border-left: 2px solid var(--dsw-alias-border-l3);\n  font-size: 11px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n/* Bulk actions: separated from the list by a hairline */\n.me-bulk {\n  display: flex;\n  gap: 8px;\n  padding-top: 10px;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n}\n\n/* ---------- Buttons ---------- */\n\n.me-btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  height: 26px;\n  padding: 0 10px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  white-space: nowrap;\n  cursor: pointer;\n  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;\n}\n\n.me-btn:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.me-btn:active:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.me-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n.me-btn-archive {\n  border-color: var(--dsw-alias-border-l3);\n  color: var(--dsw-alias-label-secondary);\n}\n\n.me-btn-archive:hover:not(:disabled) {\n  border-color: var(--dsw-alias-interactive-fg-default);\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-archive-list {\n  max-height: 320px;\n  overflow-y: auto;\n}\n\n.me-archive-content {\n  margin: 0;\n  padding: 10px 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-layer-1);\n  font: inherit;\n  font-size: 12px;\n  line-height: 1.6;\n  white-space: pre-wrap;\n  word-break: break-word;\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-btn-ok {\n  color: var(--dsw-alias-state-success-primary);\n  border-color: var(--dsw-alias-state-success-primary);\n}\n.me-btn-ok:hover:not(:disabled) {\n  background: var(--dsw-alias-state-success-tertiary);\n}\n\n.me-btn-danger {\n  color: var(--dsw-alias-state-error-primary);\n}\n.me-btn-danger:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n  border-color: var(--dsw-alias-state-error-secondary);\n}\n\n.me-btn-primary {\n  border-color: transparent;\n  background: var(--dsw-alias-button-primary-fill);\n  color: var(--dsw-alias-label-primary-inverted);\n  font-weight: 600;\n}\n.me-btn-primary:hover:not(:disabled) {\n  background: var(--dsw-alias-button-primary-hover);\n}\n.me-btn-primary:disabled {\n  background: var(--dsw-alias-button-primary-dimmed);\n}\n\n.me-btn:focus-visible,\n.me-switch:focus-visible,\n.me-input:focus-visible,\n.me-select:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary);\n  outline-offset: 1px;\n}\n\n/* ---------- Config form ---------- */\n\n.me-form {\n  display: flex;\n  flex-direction: column;\n}\n\n/* Visual grouping: value rows vs. toggle rows, hairline between groups */\n.me-group {\n  display: flex;\n  flex-direction: column;\n}\n.me-group + .me-group {\n  margin-top: 8px;\n  padding-top: 4px;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n}\n\n.me-field {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  padding: 7px 2px;\n  font-size: 13px;\n  color: var(--dsw-alias-label-primary);\n  cursor: pointer;\n}\n\n.me-field-label {\n  flex: 1;\n  min-width: 0;\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.me-field-hint {\n  font-style: normal;\n  font-size: 11px;\n  line-height: 1.4;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n/* Toggle switch (accent when on) */\n.me-switch {\n  appearance: none;\n  flex: none;\n  position: relative;\n  width: 36px;\n  height: 20px;\n  margin: 0;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 10px;\n  background: var(--dsw-alias-interactive-bg-active);\n  cursor: pointer;\n  transition: background-color 150ms ease, border-color 150ms ease;\n}\n\n.me-switch::after {\n  content: '';\n  position: absolute;\n  top: 2px;\n  left: 2px;\n  width: 14px;\n  height: 14px;\n  border-radius: 50%;\n  background: var(--dsw-static-neutral-00);\n  transition: transform 150ms ease;\n}\n\n.me-switch:hover {\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.me-switch:checked {\n  border-color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-primary);\n}\n\n.me-switch:checked::after {\n  transform: translateX(16px);\n}\n\n/* Number / select inputs, right-aligned and uniform width */\n.me-input,\n.me-select {\n  flex: none;\n  width: 120px;\n  height: 28px;\n  box-sizing: border-box;\n  padding: 0 8px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 6px;\n  outline: none;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  transition: border-color 120ms ease;\n}\n\n.me-input:hover,\n.me-select:hover {\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.me-select {\n  cursor: pointer;\n}\n\n.me-actions {\n  display: flex;\n  justify-content: flex-end;\n  gap: 8px;\n  margin-top: 8px;\n  padding-top: 12px;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n}\n\n/* ---------- Open-files button grid ---------- */\n\n.me-reveal-grid {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));\n  gap: 8px;\n}\n\n.me-btn-reveal {\n  justify-content: flex-start;\n  height: 30px;\n  padding: 0 10px;\n  color: var(--dsw-alias-label-secondary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.me-btn-reveal:hover:not(:disabled) {\n  color: var(--dsw-alias-label-primary);\n  border-color: var(--dsw-alias-state-business-primary);\n}\n\n/* ---------- Scrollbars (token-driven, fall back to border color) ---------- */\n\n.me-panel::-webkit-scrollbar,\n.me-list::-webkit-scrollbar {\n  width: 8px;\n}\n\n.me-panel::-webkit-scrollbar-thumb,\n.me-list::-webkit-scrollbar-thumb {\n  border-radius: 4px;\n  background: var(--dsw-alias-scrollbar-bg-l1, var(--dsw-alias-border-l3));\n}\n\n.me-panel::-webkit-scrollbar-thumb:hover,\n.me-list::-webkit-scrollbar-thumb:hover {\n  background: var(--dsw-alias-scrollbar-hover-l1, var(--dsw-alias-border-l4));\n}\n\n.me-panel::-webkit-scrollbar-track,\n.me-list::-webkit-scrollbar-track {\n  background: transparent;\n}\n\n/* ---- memory tab (conversation.view) ---- */\n.mt-panel {\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  padding: 6px 12px 12px;\n  overflow-y: auto;\n  height: 100%;\n  box-sizing: border-box;\n}\n\n.mt-notice {\n  padding: 8px 12px;\n  border-radius: 8px;\n  font-size: 12px;\n  line-height: 1.5;\n}\n\n.mt-notice-ok {\n  color: var(--dsw-alias-state-success-primary);\n  background: var(--dsw-alias-state-success-tertiary);\n}\n\n.mt-notice-error {\n  color: var(--dsw-alias-state-error-primary);\n  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);\n  border: 1px solid var(--dsw-alias-state-error-secondary);\n}\n\n.mt-cwd {\n  margin: 0;\n  font-size: 11px;\n  color: var(--dsw-alias-label-dimmed);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.mt-muted {\n  margin: 0;\n  font-size: 12px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.mt-list {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n}\n\n.mt-card {\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  padding: 12px;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  background: var(--dsw-alias-bg-layer-1);\n}\n\n.mt-card-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n}\n\n/* \u6BCF\u4E2A\u6587\u4EF6\u9875\u7B7E\u9876\u90E8\u7684\u4E00\u884C\u5C0F\u5B57\u8BF4\u660E\uFF08\u4F5C\u7528\u4E0E\u673A\u5236\uFF09 */\n.mt-card-desc {\n  margin: 0;\n  font-size: 11px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.mt-card-title {\n  flex: none;\n  font-size: 13px;\n  font-weight: 600;\n}\n\n.mt-badge {\n  flex: none;\n  padding: 1px 8px;\n  border-radius: 9px;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n}\n\n.mt-badge-ro {\n  color: var(--dsw-alias-label-secondary);\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.mt-card-path {\n  flex: 1;\n  min-width: 0;\n  font-size: 11px;\n  color: var(--dsw-alias-label-dimmed);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  direction: rtl;\n  text-align: left;\n}\n\n.mt-card-actions {\n  flex: none;\n}\n\n.mt-btn {\n  padding: 3px 10px;\n  border-radius: 6px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font-size: 12px;\n  cursor: pointer;\n}\n\n.mt-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n/* ---- manual project KEY add box ---- */\n\n/* Branch-scope line in the KEY add box and in the per-entry scope editor. */\n.mt-key-scope {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 4px 12px;\n}\n\n.mt-key-scope-label {\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.mt-scope-opt {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  font-size: 12px;\n  cursor: pointer;\n}\n\n.mt-scope-opt input {\n  margin: 0;\n  accent-color: var(--dsw-alias-state-business-primary);\n}\n\n.mt-scope-all-hint {\n  font-style: normal;\n  font-size: 10px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n/* Per-entry branch-scope badge (click to edit). */\n.mt-entry-branch {\n  flex: none;\n  max-width: 45%;\n  padding: 1px 8px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 9px;\n  background: transparent;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--dsw-alias-state-business-primary);\n  cursor: pointer;\n}\n\n.mt-entry-branch:hover {\n  border-color: var(--dsw-alias-interactive-fg-default);\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.mt-entry-branch-all {\n  color: var(--dsw-alias-label-secondary);\n  font-weight: 500;\n}\n\n/* Static source-branch tag on daily/project log entries (not clickable). */\n.mt-entry-branch-tag {\n  color: var(--dsw-alias-state-success-primary);\n  cursor: default;\n  border-style: dashed;\n}\n\n/* Inline scope editor panel under a KEY entry. */\n.mt-scope {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 4px 12px;\n  padding: 8px 10px;\n  border: 1px dashed var(--dsw-alias-border-l4);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n}\n\n.mt-scope-actions {\n  margin-left: auto;\n  display: flex;\n  gap: 6px;\n}\n\n/* Current-branch suffix on the KEY tab description line. */\n.mt-card-desc-branch {\n  color: var(--dsw-alias-state-business-primary);\n  font-weight: 600;\n}\n\n.mt-key-add {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding: 10px;\n  margin-bottom: 10px;\n  border: 1px dashed var(--dsw-alias-border-l4);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n}\n\n.mt-key-input {\n  box-sizing: border-box;\n  width: 100%;\n  padding: 8px 10px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 8px;\n  outline: none;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  line-height: 1.5;\n  resize: vertical;\n  transition: border-color 120ms ease;\n}\n\n.mt-key-input:hover {\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.mt-key-input:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary);\n  outline-offset: 1px;\n}\n\n.mt-key-input::placeholder {\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.mt-key-add-foot {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 10px;\n}\n\n.mt-key-help {\n  font-size: 11px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.mt-btn-primary {\n  flex: none;\n  border-color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-primary);\n  color: var(--dsw-alias-label-on-primary, #fff);\n  font-weight: 600;\n}\n\n.mt-btn-primary:hover:not(:disabled) {\n  filter: brightness(1.1);\n}\n\n.mt-content {\n  margin: 0;\n  padding: 10px;\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n  border: 1px solid var(--dsw-alias-border-l3);\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n  font-size: 12px;\n  line-height: 1.6;\n  white-space: pre-wrap;\n  word-break: break-word;\n  max-height: 320px;\n  overflow-y: auto;\n}\n\n\n.mt-warning {\n  margin: 0;\n  font-size: 11px;\n  line-height: 1.5;\n  color: var(--dsw-alias-state-warn-primary);\n}\n\n/* ---- memory tab toolbar (view toggle + search) ---- */\n\n.mt-file-tabs {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 2px;\n  padding: 0;\n  border-bottom: 1px solid var(--dsw-alias-interactive-bg-hover);\n  margin-bottom: 10px;\n}\n\n.mt-file-tab {\n  appearance: none;\n  height: 32px;\n  padding: 0 12px;\n  border: none;\n  border-radius: 6px 6px 0 0;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  font: inherit;\n  font-size: 13px;\n  cursor: pointer;\n  transition: background-color 120ms ease, color 120ms ease;\n}\n\n.mt-file-tab:hover:not(.mt-file-tab-active) {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.mt-file-tab-active,\n.mt-file-tab-active:hover {\n  background: var(--dsw-alias-interactive-bg-active);\n  color: var(--dsw-alias-brand-primary);\n  font-weight: 600;\n}\n\n/* Vertical divider between the feature tabs and the file tabs. */\n.mt-tab-sep {\n  flex: none;\n  align-self: center;\n  width: 1px;\n  height: 16px;\n  margin: 0 4px;\n  background: var(--dsw-alias-border-l3);\n}\n\n/* Pending-count badge inside a feature tab (e.g. \u5F85\u786E\u8BA4\u8BB0\u5FC6\u5EFA\u8BAE (2)). */\n.mt-feature-count {\n  display: inline-block;\n  min-width: 14px;\n  margin-left: 6px;\n  padding: 0 4px;\n  border-radius: 8px;\n  font-size: 10px;\n  line-height: 16px;\n  text-align: center;\n  font-weight: 700;\n  color: var(--dsw-alias-label-on-primary, #fff);\n  background: var(--dsw-alias-state-error-primary);\n}\n\n.mt-toolbar {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  flex-wrap: wrap;\n}\n\n/* Segmented \u7F8E\u89C2/\u7EAF\u6587\u672C toggle */\n.mt-view-toggle {\n  flex: none;\n  display: inline-flex;\n  padding: 2px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n}\n\n.mt-view-btn {\n  padding: 3px 12px;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  font: inherit;\n  font-size: 12px;\n  white-space: nowrap;\n  cursor: pointer;\n  transition: background-color 120ms ease, color 120ms ease;\n}\n\n.mt-view-btn:hover {\n  color: var(--dsw-alias-label-primary);\n}\n\n.mt-view-btn-active,\n.mt-view-btn-active:hover {\n  background: var(--dsw-alias-interactive-bg-active);\n  color: var(--dsw-alias-label-primary);\n  font-weight: 600;\n}\n\n.mt-view-btn:focus-visible,\n.mt-search:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary);\n  outline-offset: 1px;\n}\n\n.mt-search {\n  flex: 1;\n  min-width: 160px;\n  height: 28px;\n  box-sizing: border-box;\n  padding: 0 10px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 8px;\n  outline: none;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  transition: border-color 120ms ease;\n}\n\n.mt-search:hover {\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.mt-search::placeholder {\n  color: var(--dsw-alias-label-dimmed);\n}\n\n/* Search hit count badge in the card head */\n.mt-badge-count {\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n/* Friendly empty state (no search results) */\n.mt-empty {\n  margin: 0;\n  padding: 22px 12px;\n  border: 1px dashed var(--dsw-alias-border-l3);\n  border-radius: 10px;\n  font-size: 12px;\n  line-height: 1.5;\n  text-align: center;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n/* ---- pretty view: \xA7 entry cards ---- */\n\n.mt-entries {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  max-height: 320px;\n  overflow-y: auto;\n}\n\n.mt-entry {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding: 10px 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-base);\n  transition: border-color 120ms ease, background-color 120ms ease;\n}\n\n.mt-entry:hover {\n  border-color: var(--dsw-alias-border-l3);\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.mt-entry-head {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  min-width: 0;\n}\n\n.mt-entry-time {\n  flex: none;\n  padding: 1px 8px;\n  border-radius: 9px;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n  font-variant-numeric: tabular-nums;\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.mt-entry-tag {\n  flex: none;\n  max-width: 60%;\n  padding: 1px 8px;\n  border-radius: 9px;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n/* Per-entry action buttons (pretty view): right-aligned group. */\n.mt-entry-ops {\n  flex: none;\n  margin-left: auto;\n  display: flex;\n  align-items: center;\n  gap: 4px;\n}\n\n/* Neutral action (archive / promote back). */\n.mt-entry-op {\n  padding: 1px 8px;\n  font-size: 11px;\n  line-height: 16px;\n  border-color: transparent;\n  color: var(--dsw-alias-label-secondary);\n  opacity: 0.8;\n}\n\n.mt-entry-op:hover:not(:disabled) {\n  opacity: 1;\n  border-color: var(--dsw-alias-border-l3);\n  color: var(--dsw-alias-label-primary);\n}\n\n/* Per-entry delete button (pretty view): danger tint. */\n.mt-entry-del {\n  padding: 1px 8px;\n  font-size: 11px;\n  line-height: 16px;\n  border-color: transparent;\n  color: var(--dsw-alias-state-error-primary);\n  opacity: 0.7;\n}\n\n.mt-entry-del:hover:not(:disabled) {\n  opacity: 1;\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n  border-color: var(--dsw-alias-state-error-secondary);\n}\n\n.mt-entry-text {\n  margin: 0;\n  font-size: 12px;\n  line-height: 1.6;\n  white-space: pre-wrap;\n  word-break: break-word;\n  color: var(--dsw-alias-label-primary);\n}\n\n/* \u6761\u76EE\u6B63\u6587\u7F16\u8F91\u6846\uFF08\u7F8E\u89C2\u89C6\u56FE\u300C\u7F16\u8F91\u300D\uFF09\uFF1A\u53EA\u6539\u5185\u5BB9\uFF0C\u6807\u8BB0\u7A0B\u5E8F\u7EF4\u62A4 */\n.mt-entry-edit {\n  margin-top: 6px;\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n}\n\n.mt-item-edit {\n  width: 100%;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  border-radius: 6px;\n  padding: 6px 8px;\n  font-size: 12px;\n  line-height: 1.5;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  resize: vertical;\n  min-height: 56px;\n}\n\n.mt-item-edit:focus-visible {\n  outline: 2px solid var(--dsw-static-blue-6, #2563eb);\n  outline-offset: 1px;\n}\n\n.mt-entry-edit-row {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex-wrap: wrap;\n}\n\n.mt-entry-edit-hint {\n  flex: 1 1 auto;\n  font-size: 11px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n/* Entry list scrollbar (token-driven, fall back to border color) */\n.mt-entries::-webkit-scrollbar {\n  width: 8px;\n}\n\n.mt-entries::-webkit-scrollbar-thumb {\n  border-radius: 4px;\n  background: var(--dsw-alias-scrollbar-bg-l1, var(--dsw-alias-border-l3));\n}\n\n.mt-entries::-webkit-scrollbar-thumb:hover {\n  background: var(--dsw-alias-scrollbar-hover-l1, var(--dsw-alias-border-l4));\n}\n\n.mt-entries::-webkit-scrollbar-track {\n  background: transparent;\n}\n\n/* ---------- Todo sub-tab ---------- */\n\n.me-tabs {\n  flex: none;\n  display: flex;\n  flex-wrap: wrap;\n  gap: 6px;\n}\n\n.me-tab {\n  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  border-radius: 6px;\n  padding: 4px 12px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary);\n  background: transparent;\n  cursor: pointer;\n}\n\n.me-tab:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.me-tab-active {\n  color: var(--dsw-alias-label-primary);\n  border-color: var(--dsw-alias-brand-primary);\n  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);\n}\n\n.me-todo-add {\n  flex: none;\n  display: flex;\n  gap: 8px;\n  align-items: center;\n}\n\n.me-todo-input {\n  flex: 1;\n  min-width: 0;\n  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  border-radius: 6px;\n  padding: 6px 10px;\n  font-size: 12px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-todo-select,\n.me-todo-date,\n.me-todo-filters select {\n  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  border-radius: 6px;\n  padding: 5px 8px;\n  font-size: 12px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-todo-filters {\n  flex: none;\n  display: flex;\n  gap: 16px;\n  align-items: center;\n}\n\n.me-todo-filter {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.me-todo-filter-check {\n  cursor: pointer;\n  user-select: none;\n}\n\n.me-todo-filter-check input {\n  accent-color: var(--dsw-static-blue-5, #3b82f6);\n}\n\n/* \u8FC7\u5F80 daily \u5F85\u529E\u7684\u5206\u7EC4\u6807\u9898\uFF08\u5982 8\u67085\u65E5\uFF09 */\n.me-todo-day {\n  list-style: none;\n  margin: 10px 0 2px;\n  font-size: 12px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-secondary);\n  border-bottom: 1px dashed var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  padding-bottom: 2px;\n}\n\n.me-badge-day {\n  color: var(--dsw-static-amber-7, #b45309);\n  background: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 14%, transparent);\n  border: 1px solid color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 40%, transparent);\n}\n\n.me-todo-item--done .me-todo-text {\n  opacity: 0.55;\n  text-decoration: line-through;\n}\n\n.me-todo-text {\n  margin: 4px 0 0;\n  font-size: 13px;\n  line-height: 1.5;\n  white-space: pre-wrap;\n  word-break: break-word;\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-todo-edit {\n  margin-top: 6px;\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n}\n\n.me-todo-edit-row {\n  display: flex;\n  gap: 8px;\n  align-items: center;\n  flex-wrap: wrap;\n}\n\n.me-todo-edit-row select,\n.me-todo-edit-row input {\n  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  border-radius: 6px;\n  padding: 4px 8px;\n  font-size: 12px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-badge-quad {\n  border: 1px solid transparent;\n}\n\n.me-badge-quad-q1 {\n  color: var(--dsw-static-red-5, #e5484d);\n  background: color-mix(in srgb, var(--dsw-static-red-5, #e5484d) 14%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-red-5, #e5484d) 40%, transparent);\n}\n\n.me-badge-quad-q2 {\n  color: var(--dsw-static-blue-5, #3b82f6);\n  background: color-mix(in srgb, var(--dsw-static-blue-5, #3b82f6) 14%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-blue-5, #3b82f6) 40%, transparent);\n}\n\n.me-badge-quad-q3 {\n  color: var(--dsw-static-amber-5, #f59e0b);\n  background: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 14%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 40%, transparent);\n}\n\n.me-badge-quad-q4 {\n  color: var(--dsw-static-neutral-5, #8b8d98);\n  background: color-mix(in srgb, var(--dsw-static-neutral-5, #8b8d98) 14%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-neutral-5, #8b8d98) 40%, transparent);\n}\n\n.me-badge-quad-none {\n  color: var(--dsw-alias-label-tertiary);\n  background: transparent;\n  border-color: var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n}\n\n.me-badge-overdue {\n  color: var(--dsw-static-red-5, #e5484d);\n  background: color-mix(in srgb, var(--dsw-static-red-5, #e5484d) 12%, transparent);\n}\n\n.me-badge-due {\n  color: var(--dsw-static-amber-5, #f59e0b);\n  background: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 12%, transparent);\n}\n\n.me-todo-help {\n  font-size: 11px;\n  line-height: 1.6;\n  color: var(--dsw-alias-label-dimmed);\n  margin: 0;\n}\n";

// src/client/coi-styles.css
var coi_styles_default = '/**\n * dsh-memory-evolve \u2014 COI \u8C03\u5EA6 tab \u6837\u5F0F\uFF08coi- \u524D\u7F00\uFF0C\u7531 index.ts \u6CE8\u5165\uFF09\u3002\n * \u989C\u8272\u4E00\u5F8B\u8D70 DSH \u8BBE\u8BA1 token\uFF08--dsw-alias-* / --dsw-static-*\uFF09\uFF0C\u6DF1\u6D45\u8272\u81EA\u52A8\u9002\u914D\u3002\n */\n\n.coi-root {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n  height: 100%;\n  color: var(--dsw-alias-label-primary);\n  font-size: 13px;\n}\n\n/* ---- \u5B50 Tab \u6761 ---- */\n.coi-tabs {\n  display: flex;\n  gap: 4px;\n  padding: 8px 12px 0;\n  border-bottom: 1px solid var(--dsw-alias-interactive-bg-hover);\n  flex-shrink: 0;\n}\n\n.coi-tab {\n  appearance: none;\n  border: none;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  padding: 6px 12px;\n  cursor: pointer;\n  font-size: 13px;\n  border-radius: 6px 6px 0 0;\n}\n\n.coi-tab:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.coi-tab-active,\n.coi-tab-active:hover {\n  color: var(--dsw-alias-brand-primary);\n  background: var(--dsw-alias-interactive-bg-active);\n  font-weight: 600;\n}\n\n/* ---- \u5185\u5BB9\u533A ---- */\n.coi-body {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n}\n\n.coi-pane {\n  flex: 1;\n  min-height: 0;\n  overflow: auto;\n  padding: 12px;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.coi-tasks {\n  overflow: hidden;\n}\n\n/* ---- \u4EFB\u52A1\u89C6\u56FE\uFF1A\u5DE6\u5217\u8868 + \u53F3\u8BE6\u60C5 ---- */\n.coi-split {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  gap: 8px;\n}\n\n.coi-task-list {\n  flex: 0 0 46%;\n  min-width: 0;\n  overflow: auto;\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  padding: 4px;\n}\n\n.coi-task-row {\n  appearance: none;\n  border: none;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  padding: 6px 8px;\n  border-radius: 6px;\n  cursor: pointer;\n  text-align: left;\n  font-size: 12px;\n  width: 100%;\n}\n\n.coi-task-row:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.coi-task-row-active,\n.coi-task-row-active:hover {\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.coi-task-status {\n  flex-shrink: 0;\n}\n\n.coi-task-id {\n  flex-shrink: 0;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.coi-task-adapter {\n  flex-shrink: 0;\n  color: var(--dsw-alias-brand-primary);\n}\n\n.coi-task-prompt {\n  flex: 1;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.coi-task-time {\n  flex-shrink: 0;\n  font-size: 11px;\n}\n\n.coi-detail {\n  flex: 1;\n  min-width: 0;\n  overflow: auto;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  padding: 10px;\n}\n\n.coi-detail-meta {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n}\n\n.coi-meta-row {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n\n.coi-meta-row .coi-label {\n  min-width: 64px;\n}\n\n.coi-detail-actions {\n  display: flex;\n  gap: 8px;\n}\n\n.coi-log-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n}\n\n.coi-log-title {\n  margin-top: 4px;\n}\n\n.coi-log {\n  flex: 1;\n  min-height: 220px;\n  max-height: 45vh;\n  overflow: auto;\n  margin: 0;\n  padding: 8px;\n  border-radius: 6px;\n  background: var(--dsw-alias-markdown-code-block);\n  color: var(--dsw-alias-label-primary);\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n  font-size: 12px;\n  line-height: 1.5;\n  white-space: pre-wrap;\n  word-break: break-all;\n}\n\n.coi-guide {\n  margin: 4px 0 0;\n  padding: 8px;\n  border-radius: 6px;\n  background: var(--dsw-alias-markdown-code-block);\n  color: var(--dsw-alias-label-secondary);\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n  font-size: 12px;\n  line-height: 1.5;\n  white-space: pre-wrap;\n  word-break: break-word;\n  max-height: 40vh;\n  overflow: auto;\n}\n\n/* ---- \u5361\u7247 / \u8868\u5355 ---- */\n.coi-card {\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  padding: 10px;\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  flex-shrink: 0;\n}\n\n.coi-card-title {\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n}\n\n.coi-cards {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.coi-adapter-card {\n  gap: 4px;\n}\n\n.coi-form-grid {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 8px;\n}\n\n/* \u7EB5\u5411\u5361\u7247\u91CC\u7684\u5B57\u6BB5\uFF1Aflex-basis \u53EA\u7528\u4E8E\u6A2A\u5411\u7F51\u683C\uFF08\u5BBD\u5EA6\uFF09\uFF0C\n   \u7EB5\u5411\u6392\u5217\u65F6\u7981\u6B62\u6309 180px \u9AD8\u5EA6\u62C9\u4F38\uFF08\u5426\u5219\u6BCF\u4E2A\u5B57\u6BB5\u4E0B\u65B9\u7559\u5927\u7247\u7A7A\u767D\uFF09 */\n.coi-card > .coi-field {\n  flex: none;\n}\n\n.coi-field {\n  display: flex;\n  flex-direction: column;\n  gap: 3px;\n  flex: 1 1 180px;\n  min-width: 0;\n}\n\n.coi-field-wide {\n  flex-basis: 100%;\n}\n\n.coi-label {\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 12px;\n}\n\n.coi-input,\n.coi-select,\n.coi-textarea {\n  appearance: none;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  padding: 6px 8px;\n  font-size: 13px;\n  font-family: inherit;\n  outline: none;\n  min-width: 0;\n}\n\n.coi-input:focus,\n.coi-select:focus,\n.coi-textarea:focus {\n  border-color: var(--dsw-alias-brand-primary);\n}\n\n.coi-textarea {\n  resize: vertical;\n}\n\n.coi-form-actions {\n  display: flex;\n  gap: 8px;\n  justify-content: flex-end;\n}\n\n/* ---- \u6309\u94AE ---- */\n.coi-btn {\n  appearance: none;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: var(--dsw-alias-button-tool-bar-fill);\n  color: var(--dsw-alias-interactive-fg-default);\n  padding: 6px 14px;\n  font-size: 13px;\n  cursor: pointer;\n}\n\n.coi-btn:hover {\n  background: var(--dsw-alias-button-tool-bar-hover);\n}\n\n.coi-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n.coi-btn-primary {\n  background: var(--dsw-alias-button-primary-fill);\n  border-color: transparent;\n  color: var(--dsw-alias-label-primary-inverted);\n}\n\n.coi-btn-primary:hover {\n  background: var(--dsw-alias-button-primary-hover);\n}\n\n.coi-btn-danger {\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.coi-btn-danger:hover {\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n}\n\n.coi-btn-mini {\n  padding: 2px 8px;\n  font-size: 12px;\n}\n\n/* ---- \u5DE5\u5177\u6761 / \u5217\u8868\u884C ---- */\n.coi-toolbar {\n  display: flex;\n  gap: 8px;\n  align-items: center;\n  flex-shrink: 0;\n}\n\n.coi-toolbar .coi-input {\n  flex: 1;\n}\n\n.coi-row {\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  padding: 8px 10px;\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  flex-shrink: 0;\n}\n\n.coi-row-line {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n  flex-wrap: wrap;\n}\n\n.coi-grow {\n  flex: 1;\n  min-width: 0;\n}\n\n/* ---- \u5FBD\u6807 / \u72B6\u6001\u8272 ---- */\n.coi-badge {\n  display: inline-block;\n  padding: 1px 8px;\n  border-radius: 999px;\n  background: var(--dsw-alias-interactive-bg-active);\n  color: var(--dsw-alias-label-secondary);\n  font-size: 11px;\n  flex-shrink: 0;\n}\n\n.coi-status-queued {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.coi-status-running {\n  color: var(--dsw-alias-state-business-primary);\n}\n\n.coi-status-completed {\n  color: var(--dsw-alias-state-success-primary);\n}\n\n.coi-status-failed {\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.coi-status-killed {\n  color: var(--dsw-alias-state-warn-primary);\n}\n\n.coi-status-interrupted {\n  color: var(--dsw-alias-state-warn-primary);\n}\n\n/* ---- \u63D0\u793A ---- */\n.coi-notice {\n  padding: 6px 10px;\n  border-radius: 6px;\n  font-size: 12px;\n  flex-shrink: 0;\n}\n\n.coi-notice-ok {\n  background: var(--dsw-alias-state-success-tertiary);\n  color: var(--dsw-alias-state-success-primary);\n}\n\n.coi-notice-error {\n  /* \u80CC\u666F error-secondary \u4E0E\u6587\u5B57 error-primary \u5728\u6697\u8272\u4E3B\u9898\u4E0B\u540C\u8272\uFF08\u5747 red-400\uFF09\uFF0C\n     \u5FC5\u987B\u7528\u8DE8\u4E3B\u9898\u56FA\u5B9A\u7684\u6DF1\u7EA2\u505A\u6587\u5B57\u8272\uFF0C\u5426\u5219\u6587\u5B57\u4E0D\u53EF\u89C1\uFF08\u66FE\u8868\u73B0\u4E3A"\u7A7A\u7EA2\u6846"\uFF09\u3002 */\n  background: var(--dsw-alias-state-error-secondary);\n  color: var(--dsw-static-red-900);\n}\n\n.coi-error {\n  padding: 6px 10px;\n  border-radius: 6px;\n  background: var(--dsw-alias-state-error-secondary);\n  /* \u540C\u4E0A\uFF1A\u6697\u8272\u4E3B\u9898\u4E0B error-primary \u4E0E\u80CC\u666F\u540C\u8272\uFF0C\u56FA\u5B9A\u6DF1\u7EA2\u4FDD\u8BC1\u53EF\u8BFB */\n  color: var(--dsw-static-red-900);\n  font-size: 12px;\n  flex-shrink: 0;\n  white-space: pre-wrap;\n  word-break: break-word;\n}\n\n/* ---- \u7EDF\u8BA1 ---- */\n.coi-stat-grid {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 8px;\n  flex-shrink: 0;\n}\n\n.coi-stat-card {\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  padding: 12px;\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  min-width: 140px;\n  flex: 1 1 140px;\n}\n\n.coi-stat-num {\n  font-size: 24px;\n  font-weight: 700;\n  color: var(--dsw-alias-brand-primary);\n}\n\n/* ---- \u6742\u9879 ---- */\n.coi-mono {\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n}\n\n.coi-small {\n  font-size: 11px;\n}\n\n.coi-muted {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.coi-strong {\n  font-weight: 600;\n}\n\n.coi-pad {\n  padding: 12px;\n}\n\n/* ---- \u65E5\u5FD7\u5168\u5C4F\u5F39\u7A97 ---- */\n.coi-modal {\n  position: fixed;\n  inset: 0;\n  z-index: 1000;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: rgba(0, 0, 0, 0.5);\n}\n\n.coi-modal-box {\n  display: flex;\n  flex-direction: column;\n  width: 92vw;\n  height: 88vh;\n  max-width: 1400px;\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-overlay);\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  overflow: hidden;\n}\n\n.coi-modal-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n  padding: 8px 12px;\n  border-bottom: 1px solid var(--dsw-alias-interactive-bg-hover);\n  flex-shrink: 0;\n}\n\n.coi-log-full {\n  flex: 1;\n  min-height: 0;\n  max-height: none;\n  overflow: auto;\n  border-radius: 0;\n  margin: 0;\n}\n\n/* ---- \u5C0F\u65F6/\u5206\u949F\u6A2A\u6392 ---- */\n.coi-inline {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n\n.coi-inline .coi-input {\n  width: 88px;\n  flex-shrink: 0;\n}\n\n/* ---- \u53D1\u8D77\u4EFB\u52A1\u5927\u8F93\u5165\u6846 ---- */\n.coi-textarea-lg {\n  min-height: 130px;\n}\n\n/* ---- \u6280\u80FD\u7F16\u8F91\u5F39\u7A97\u7F16\u8F91\u5668 ---- */\n.coi-skill-editor {\n  flex: 1;\n  min-height: 0;\n  margin: 0 12px 12px;\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n  font-size: 12px;\n  line-height: 1.5;\n  white-space: pre;\n  overflow: auto;\n}\n\n.coi-skill-tag {\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n}\n\n/* ---- \u4EFB\u52A1\u5217\u8868\u641C\u7D22\u680F ---- */\n.coi-task-toolbar {\n  padding: 0 12px;\n  flex-shrink: 0;\n}\n\n.coi-task-toolbar .coi-input {\n  width: 100%;\n}\n\n/* ---- \u8BE6\u60C5\uFF1A\u4EFB\u52A1\u5185\u5BB9\uFF08\u53EA\u8BFB\uFF0C\u5C0F\u533A\u57DF\uFF0C\u53EF\u6EDA\u52A8\uFF09 ---- */\n.coi-prompt-view {\n  max-height: 120px;\n  overflow: auto;\n  margin: 0;\n  padding: 8px;\n  border-radius: 6px;\n  background: var(--dsw-alias-markdown-code-block);\n  color: var(--dsw-alias-label-primary);\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n  font-size: 12px;\n  line-height: 1.5;\n  white-space: pre-wrap;\n  word-break: break-all;\n}\n\n.coi-prompt-view-full {\n  white-space: pre-wrap;\n  word-break: break-all;\n}\n';

// src/client/scratch-styles.css
var scratch_styles_default = "/**\n * dsh-memory-evolve \u2014 \u4E34\u65F6\u4FE1\u606F tab \u6837\u5F0F\uFF08`sp-` \u524D\u7F00\uFF09\u3002\n * \u989C\u8272\u53EA\u7528 --dsw-alias-* token\uFF0C\u6DF1\u6D45\u8272\u81EA\u52A8\u9002\u914D\uFF08\u4E0E coi- \u4E00\u81F4\uFF09\u3002\n */\n\n.sp-root {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n  height: 100%;\n  box-sizing: border-box;\n  gap: 8px;\n  padding: 12px;\n  color: var(--dsw-alias-label-primary);\n  font-size: 13px;\n}\n\n.sp-head {\n  flex: none;\n  display: flex;\n  align-items: baseline;\n  gap: 10px;\n  min-width: 0;\n}\n\n.sp-path {\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary);\n  font-family: var(--dsw-font-family-mono, monospace);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.sp-saved-at {\n  flex: none;\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.sp-help {\n  flex: none;\n  margin: 0;\n  font-size: 12px;\n  line-height: 1.6;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.sp-editor {\n  flex: 1;\n  min-height: 0;\n  width: 100%;\n  box-sizing: border-box;\n  resize: none;\n  appearance: none;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  padding: 12px 14px;\n  font-family: var(--dsw-font-family-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace);\n  font-size: 13px;\n  line-height: 1.7;\n  outline: none;\n}\n\n.sp-editor:focus {\n  border-color: var(--dsw-alias-brand-primary);\n}\n\n.sp-editor::placeholder {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.sp-toolbar {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  min-height: 30px;\n}\n\n.sp-spacer {\n  flex: 1;\n}\n\n.sp-status {\n  font-size: 12px;\n  line-height: 1.4;\n}\n\n.sp-status-ok {\n  color: var(--dsw-alias-state-success-primary);\n}\n\n.sp-status-pending {\n  color: var(--dsw-alias-label-secondary);\n}\n\n.sp-status-error {\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.sp-notice {\n  font-size: 12px;\n  line-height: 1.4;\n  border-radius: 6px;\n  padding: 3px 8px;\n}\n\n.sp-notice-ok {\n  color: var(--dsw-alias-state-success-primary);\n  background: var(--dsw-alias-state-success-tertiary);\n}\n\n.sp-notice-error {\n  /* \u6697\u8272\u4E3B\u9898\u4E0B error-primary \u4E0E error-secondary \u540C\u8272\uFF08red-400\uFF09\uFF0C\n     \u56FA\u5B9A\u6DF1\u7EA2\u4FDD\u8BC1\u6587\u5B57\u5728\u7C89\u7EA2\u5E95\u4E0A\u53EF\u8BFB */\n  color: var(--dsw-static-red-900);\n  background: var(--dsw-alias-state-error-secondary);\n}\n\n.sp-loading {\n  padding: 12px 0;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.sp-btn {\n  flex: none;\n  appearance: none;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: var(--dsw-alias-button-tool-bar-fill);\n  color: var(--dsw-alias-interactive-fg-default);\n  padding: 5px 14px;\n  font-size: 13px;\n  cursor: pointer;\n}\n\n.sp-btn:hover {\n  background: var(--dsw-alias-button-tool-bar-hover);\n}\n\n.sp-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n";

// src/client/prompt-styles.css
var prompt_styles_default = "/**\n * dsh-memory-evolve \u2014 \u63D0\u793A\u8BCD tab \u6837\u5F0F\uFF08pm- \u524D\u7F00\uFF09\u3002\n * \u5E03\u5C40\uFF1A\u9876\u680F\uFF08\u641C\u7D22/\u7B5B\u9009/\u6309\u94AE\uFF09+ \u4E09\u680F\u4E3B\u4F53\uFF08\u5206\u7C7B\u6811 / \u5217\u8868 / \u8BE6\u60C5\u8868\u5355\uFF09\u3002\n * \u989C\u8272\u5168\u90E8\u4F7F\u7528 DSH \u8BBE\u8BA1 token\uFF08--dsw-alias-* / --dsw-static-*\uFF09\uFF0C\u6DF1\u6D45\u8272\n * \u81EA\u52A8\u9002\u914D\uFF1B\u9AD8\u5EA6\u94FA\u6EE1\u7236\u5BB9\u5668\uFF08conversation.view \u7684 tab \u5BB9\u5668\u662F flex \u5217\uFF09\u3002\n */\n\n.pm-root {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  padding: 8px;\n  box-sizing: border-box;\n  overflow: hidden;\n}\n\n/* ---------- \u9876\u680F ---------- */\n.pm-toolbar {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex-shrink: 0;\n}\n\n.pm-search {\n  flex: 1;\n  min-width: 0;\n  height: 30px;\n  padding: 0 10px;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font-size: 13px;\n  outline: none;\n}\n.pm-search:focus {\n  border-color: var(--dsw-alias-brand-primary);\n}\n.pm-search::placeholder {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.pm-select {\n  height: 30px;\n  padding: 0 8px;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font-size: 13px;\n  outline: none;\n  cursor: pointer;\n  max-width: 140px;\n}\n\n.pm-tool-btn {\n  height: 30px;\n  padding: 0 10px;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: var(--dsw-alias-button-tool-bar-fill);\n  color: var(--dsw-alias-label-primary);\n  font-size: 13px;\n  cursor: pointer;\n  white-space: nowrap;\n}\n.pm-tool-btn:hover {\n  background: var(--dsw-alias-button-tool-bar-hover);\n}\n.pm-tool-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n.pm-primary-btn {\n  height: 30px;\n  padding: 0 12px;\n  border: none;\n  border-radius: 6px;\n  background: var(--dsw-alias-brand-primary);\n  color: var(--dsw-alias-label-primary-inverted);\n  font-size: 13px;\n  cursor: pointer;\n  white-space: nowrap;\n}\n.pm-primary-btn:hover {\n  background: var(--dsw-alias-button-primary-hover);\n}\n\n.pm-danger-btn {\n  height: 30px;\n  padding: 0 10px;\n  border: 1px solid var(--dsw-alias-state-error-secondary);\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-state-error-primary);\n  font-size: 13px;\n  cursor: pointer;\n  white-space: nowrap;\n}\n.pm-danger-btn:hover {\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n}\n\n/* ---------- \u9876\u680F\u6D88\u606F\u6A2A\u5E45 ---------- */\n.pm-banner {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 6px 10px;\n  border-radius: 6px;\n  background: var(--dsw-alias-state-success-tertiary);\n  color: var(--dsw-alias-state-success-primary);\n  font-size: 12px;\n  flex-shrink: 0;\n}\n.pm-banner-error {\n  background: var(--dsw-alias-state-error-secondary);\n  color: var(--dsw-alias-state-error-primary);\n}\n.pm-banner-close {\n  margin-left: auto;\n  border: none;\n  background: transparent;\n  color: inherit;\n  font-size: 14px;\n  cursor: pointer;\n}\n\n/* ---------- \u6D6E\u5C42\uFF08\u6CE8\u5165\u4E2D / \u6765\u6E90\uFF09 ---------- */\n.pm-overlay {\n  position: absolute;\n  top: 46px;\n  right: 8px;\n  z-index: 50;\n  width: 320px;\n  max-width: calc(100vw - 48px);\n  max-height: 60vh;\n  overflow-y: auto;\n  padding: 10px;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-overlay);\n  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n.pm-overlay-wide {\n  width: 420px;\n}\n.pm-overlay-title {\n  font-size: 13px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n}\n.pm-overlay-sub {\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary);\n}\n.pm-overlay-empty {\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary);\n  padding: 4px 0;\n}\n.pm-overlay-item {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 6px 8px;\n  border-radius: 6px;\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n.pm-overlay-item-main {\n  flex: 1;\n  min-width: 0;\n}\n.pm-overlay-item-title {\n  font-size: 12px;\n  color: var(--dsw-alias-label-primary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.pm-overlay-item-sub {\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n}\n.pm-overlay-remove {\n  flex-shrink: 0;\n}\n.pm-source-item {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  padding: 6px 8px;\n  border-radius: 6px;\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n.pm-source-link {\n  font-size: 12px;\n  font-weight: 600;\n  color: var(--dsw-alias-brand-primary);\n  text-decoration: none;\n}\n.pm-source-link:hover {\n  text-decoration: underline;\n}\n.pm-source-desc {\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n/* ---------- \u4E09\u680F\u4E3B\u4F53 ---------- */\n.pm-body {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  gap: 8px;\n  position: relative;\n}\n\n/* \u5DE6\uFF1A\u5206\u7C7B\u6811 */\n.pm-pane-cats {\n  width: 130px;\n  flex-shrink: 0;\n  overflow-y: auto;\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  padding: 4px;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n}\n.pm-cat {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 6px;\n  padding: 6px 8px;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font-size: 12px;\n  cursor: pointer;\n  text-align: left;\n}\n.pm-cat:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n.pm-cat-active {\n  background: var(--dsw-alias-interactive-bg-active);\n  color: var(--dsw-alias-brand-primary);\n  font-weight: 600;\n}\n.pm-cat-name {\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.pm-cat-count {\n  font-size: 11px;\n  color: var(--dsw-alias-label-tertiary);\n  flex-shrink: 0;\n}\n\n/* \u5206\u7C7B\u884C\uFF08\u542B\u5220\u9664\u6309\u94AE\uFF09\u4E0E\u5206\u7C7B\u7BA1\u7406\uFF08\u6DFB\u52A0/\u5220\u9664\uFF09 */\n.pm-cat-row {\n  display: flex;\n  align-items: center;\n  gap: 2px;\n}\n.pm-cat-row .pm-cat {\n  flex: 1;\n  min-width: 0;\n}\n.pm-cat-del {\n  flex-shrink: 0;\n  width: 18px;\n  height: 18px;\n  border: none;\n  border-radius: 4px;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 12px;\n  line-height: 1;\n  cursor: pointer;\n  opacity: 0;\n}\n.pm-cat-row:hover .pm-cat-del {\n  opacity: 1;\n}\n.pm-cat-del:hover {\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n  color: var(--dsw-alias-state-error-primary);\n}\n.pm-cat-add-btn {\n  margin-top: 4px;\n  padding: 5px 8px;\n  border: 1px dashed var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12px;\n  cursor: pointer;\n  text-align: left;\n}\n.pm-cat-add-btn:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-brand-primary);\n}\n.pm-cat-add {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  margin-top: 4px;\n}\n.pm-cat-add-input {\n  flex: 1;\n  min-width: 0;\n  height: 24px;\n  padding: 0 6px;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 4px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font-size: 12px;\n  outline: none;\n}\n.pm-cat-add-input:focus {\n  border-color: var(--dsw-alias-brand-primary);\n}\n.pm-cat-add-ok {\n  width: 24px;\n  height: 24px;\n  border: none;\n  border-radius: 4px;\n  background: var(--dsw-alias-brand-primary);\n  color: var(--dsw-alias-label-primary-inverted);\n  font-size: 12px;\n  cursor: pointer;\n}\n\n/* \u4E2D\uFF1A\u5217\u8868 */\n.pm-pane-list {\n  flex: 1;\n  min-width: 0;\n  overflow-y: auto;\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  padding: 4px;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n}\n.pm-item {\n  display: flex;\n  flex-direction: column;\n  gap: 3px;\n  padding: 8px 10px;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  cursor: pointer;\n  text-align: left;\n}\n.pm-item:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n.pm-item-active {\n  background: var(--dsw-alias-interactive-bg-active);\n}\n.pm-item-row1 {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  min-width: 0;\n}\n.pm-item-name {\n  font-size: 13px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.pm-item-badge {\n  flex-shrink: 0;\n  padding: 1px 6px;\n  border-radius: 8px;\n  font-size: 10px;\n  color: var(--dsw-alias-label-secondary);\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n.pm-item-badge-active {\n  color: var(--dsw-alias-state-success-primary);\n  background: var(--dsw-alias-state-success-tertiary);\n  font-weight: 600;\n}\n.pm-inject-status {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  padding: 4px 10px;\n  border-radius: 6px;\n  font-size: 12px;\n  font-weight: 600;\n  color: var(--dsw-alias-state-success-primary);\n  background: var(--dsw-alias-state-success-tertiary);\n}\n.pm-item-summary {\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.pm-item-row3 {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 6px;\n}\n.pm-item-usage,\n.pm-item-used {\n  font-size: 10px;\n  color: var(--dsw-alias-label-tertiary);\n}\n.pm-pane-empty {\n  padding: 24px 12px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary);\n  text-align: center;\n}\n\n/* \u53F3\uFF1A\u8BE6\u60C5\u8868\u5355 */\n.pm-pane-detail {\n  width: 42%;\n  min-width: 260px;\n  flex-shrink: 0;\n  overflow-y: auto;\n  padding: 10px;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n}\n.pm-detail-hint {\n  padding: 24px 12px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary);\n  text-align: center;\n}\n.pm-form {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  height: 100%;\n}\n.pm-form-title {\n  font-size: 13px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n  flex-shrink: 0;\n}\n.pm-field {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  flex-shrink: 0;\n}\n.pm-field-grow {\n  flex: 1;\n  min-height: 0;\n}\n.pm-field-label {\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n}\n.pm-input {\n  height: 30px;\n  padding: 0 10px;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font-size: 13px;\n  outline: none;\n}\n.pm-input:focus {\n  border-color: var(--dsw-alias-brand-primary);\n}\n.pm-textarea {\n  flex: 1;\n  min-height: 120px;\n  padding: 8px 10px;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-interactive-bg-hover);\n  border-radius: 6px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font-size: 12px;\n  font-family: var(--dsw-font-family-mono);\n  line-height: 1.5;\n  resize: none;\n  outline: none;\n}\n.pm-textarea:focus {\n  border-color: var(--dsw-alias-brand-primary);\n}\n.pm-textarea::placeholder {\n  color: var(--dsw-alias-label-tertiary);\n}\n.pm-actions {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex-wrap: wrap;\n  flex-shrink: 0;\n}\n.pm-inject-group {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n.pm-rounds {\n  max-width: 170px;\n}\n.pm-dirty-hint {\n  font-size: 11px;\n  color: var(--dsw-alias-state-warn-primary);\n  flex-shrink: 0;\n}\n";

// src/client/skills-browser/styles.css
var styles_default2 = "/**\n * Skill Browser \u5168\u90E8\u6837\u5F0F\uFF08\u666E\u901A CSS\uFF0C\u7C7B\u540D sb- \u524D\u7F00\uFF09\u3002\n * \u989C\u8272\u4E00\u5F8B\u8D70 DSH \u8BBE\u8BA1 token\uFF08--dsw-alias-*\uFF09\uFF0C\u9759\u6001\u8272\u677F\u7528 --dsw-static-* \u5E76\u5E26\n * alias \u515C\u5E95\uFF1B\u6DF1/\u6D45\u8272\u7531 body[data-ds-dark-theme] \u5207\u6362 token \u81EA\u52A8\u9002\u914D\u3002\n */\n\n/* ---------- \u5E03\u5C40\u9AA8\u67B6 ---------- */\n\n.sb-root {\n  flex: 1;\n  min-height: 0;\n  /* The settings `.options` container is a plain block scroll box (not a\n     flex parent), so flex:1 alone collapses the root to content height.\n     height:100% fills the determined parent height in both contexts. */\n  height: 100%;\n  display: flex;\n  flex-direction: column;\n  font-family: var(--dsw-font-family);\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-bg-base);\n  overflow: hidden;\n}\n\n.sb-body {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  overflow: hidden;\n}\n\n.sb-spacer {\n  flex: 1;\n  min-width: 8px;\n}\n\n/* ---------- \u5DE6\u680F\uFF1A\u5DE5\u5177\u6761 + \u4E0A\u4E0B\u5206\u533A ---------- */\n\n.sb-side {\n  flex: 1 1 0;\n  min-width: 0;\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n}\n\n.sb-side-toolbar {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 8px 12px;\n  border-bottom: 1px solid var(--dsw-alias-border-l);\n}\n\n.sb-search {\n  position: relative;\n  flex: 1;\n  min-width: 0;\n  display: flex;\n  align-items: center;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.sb-search-icon {\n  position: absolute;\n  left: 8px;\n  pointer-events: none;\n}\n\n.sb-search-input {\n  width: 100%;\n  height: 30px;\n  padding: 0 28px 0 28px;\n  font: inherit;\n  font-size: 12px;\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 6px;\n  outline: none;\n}\n\n.sb-search-input::placeholder {\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.sb-search-input:focus-visible {\n  border-color: var(--dsw-alias-brand-primary);\n  outline: 1px solid var(--dsw-alias-brand-primary);\n}\n\n.sb-search-clear {\n  position: absolute;\n  right: 4px;\n  display: flex;\n  align-items: center;\n  padding: 2px;\n  border: none;\n  border-radius: 4px;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  cursor: pointer;\n}\n\n.sb-search-clear:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-secondary);\n}\n\n.sb-icon-btn {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 30px;\n  height: 30px;\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n}\n\n.sb-icon-btn:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.sb-icon-btn:active:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.sb-icon-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n/* ---------- \u4E24\u680F\u5E03\u5C40\uFF1A\u5DE6\u680F 45/55 \u5206\u533A\uFF0C\u53F3\u680F\u7F16\u8F91\u5668 ---------- */\n\n.sb-section {\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  overflow: hidden;\n}\n\n/* \u4E0A\u90E8\uFF1A\u6280\u80FD\u5217\u8868\uFF0855%\uFF0C\u4E3B\u89C6\u56FE\uFF09\uFF0C\u4E0E\u4E0B\u90E8\u4EE5\u5206\u9694\u7EBF\u9694\u5F00 */\n.sb-section--skills {\n  flex: 55;\n  border-bottom: 1px solid var(--dsw-alias-border-l);\n}\n\n/* \u4E0B\u90E8\uFF1A\u9009\u4E2D\u6280\u80FD\u7684\u76EE\u5F55\u6811\uFF0845%\uFF09 */\n.sb-section--files {\n  flex: 45;\n}\n\n.sb-main {\n  flex: none;\n  width: 42%;\n  min-width: 320px;\n  max-width: 640px;\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  overflow: hidden;\n  border-left: 1px solid var(--dsw-alias-border-l);\n}\n\n/* \u7A84\u7A97\u53E3\uFF08\u5F39\u7A97 max-width: calc(100vw - 48px)\uFF09\uFF1A\u7F16\u8F91\u5668\u6536\u7A84\uFF0C\u5DE6\u680F\u8BA9\u4F4D */\n@media (max-width: 900px) {\n  .sb-main {\n    width: 50%;\n    min-width: 260px;\n  }\n}\n\n.sb-pane-head {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 8px 12px;\n  border-bottom: 1px solid var(--dsw-alias-border-l);\n}\n\n.sb-pane-title {\n  font-size: 12px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.sb-count {\n  font-size: 11px;\n  line-height: 16px;\n  padding: 0 6px;\n  border-radius: 8px;\n  color: var(--dsw-alias-label-tertiary);\n  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-overlay));\n}\n\n/* ---------- \u901A\u7528\u63D0\u793A / \u6309\u94AE / \u52A8\u753B ---------- */\n\n.sb-note {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  padding: 16px 12px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.sb-note--error {\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.sb-btn {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  height: 26px;\n  padding: 0 10px;\n  font: inherit;\n  font-size: 12px;\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  cursor: pointer;\n  white-space: nowrap;\n}\n\n.sb-btn:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.sb-btn:active:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.sb-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n.sb-btn--primary {\n  border-color: transparent;\n  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));\n  color: var(--dsw-alias-label-inverted, #fff);\n}\n\n.sb-btn--primary:hover:not(:disabled) {\n  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary));\n}\n\n.sb-btn--primary:disabled {\n  background: var(--dsw-alias-button-primary-dimmed, var(--dsw-alias-brand-primary));\n}\n\n.sb-btn--ghost {\n  border-color: transparent;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.sb-btn--ghost:active:not(:disabled) {\n  background: var(--dsw-alias-button-ghost-active-fill, var(--dsw-alias-interactive-bg-active));\n}\n\n.sb-btn--danger {\n  border-color: transparent;\n  background: var(--dsw-alias-state-error-primary);\n  color: var(--dsw-alias-label-inverted, #fff);\n}\n\n.sb-btn--danger:hover:not(:disabled) {\n  opacity: 0.88;\n}\n\n.sb-btn:focus-visible,\n.sb-icon-btn:focus-visible,\n.sb-card:focus-visible,\n.sb-tree-row:focus-visible,\n.sb-crumb:focus-visible,\n.sb-root-select:focus-visible,\n.sb-search-clear:focus-visible {\n  outline: 2px solid var(--dsw-alias-brand-primary);\n  outline-offset: -2px;\n}\n\n@keyframes sb-rotate {\n  from {\n    transform: rotate(0deg);\n  }\n  to {\n    transform: rotate(360deg);\n  }\n}\n\n.sb-spin {\n  animation: sb-rotate 0.9s linear infinite;\n}\n\n/* ---------- \u680F1 \u6280\u80FD\u5361\u7247 ---------- */\n\n.sb-list {\n  flex: 1;\n  min-height: 0;\n  overflow-y: auto;\n  padding: 8px;\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n}\n\n.sb-card {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  width: 100%;\n  padding: 8px 10px;\n  border: 1px solid transparent;\n  border-radius: 8px;\n  background: transparent;\n  font: inherit;\n  text-align: left;\n  cursor: pointer;\n  color: inherit;\n}\n\n.sb-card:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.sb-card--active,\n.sb-card--active:hover {\n  background: var(--dsw-alias-interactive-bg-hover-accent, var(--dsw-alias-interactive-bg-active));\n  border-color: var(--dsw-alias-brand-primary);\n}\n\n.sb-card-top {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n}\n\n.sb-card-name {\n  flex: 1;\n  min-width: 0;\n  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);\n  font-size: 12px;\n  font-weight: 600;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.sb-badge {\n  flex: none;\n  font-size: 10px;\n  line-height: 16px;\n  padding: 0 6px;\n  border-radius: 8px;\n  white-space: nowrap;\n}\n\n.sb-badge--user {\n  color: var(--dsw-static-deepseek-5, var(--dsw-alias-brand-primary));\n  background: color-mix(\n    in srgb,\n    var(--dsw-static-deepseek-5, var(--dsw-alias-brand-primary)) 14%,\n    transparent\n  );\n}\n\n.sb-badge--project {\n  color: var(--dsw-static-green-5, var(--dsw-alias-state-success-primary));\n  background: color-mix(\n    in srgb,\n    var(--dsw-static-green-5, var(--dsw-alias-state-success-primary)) 14%,\n    transparent\n  );\n}\n\n.sb-badge--bundled {\n  color: var(--dsw-static-neutral-5, var(--dsw-alias-label-tertiary));\n  background: color-mix(\n    in srgb,\n    var(--dsw-static-neutral-5, var(--dsw-alias-label-dimmed)) 16%,\n    transparent\n  );\n}\n\n.sb-badge--other {\n  color: var(--dsw-static-amber-5, var(--dsw-alias-state-warn-label));\n  background: color-mix(\n    in srgb,\n    var(--dsw-static-amber-5, var(--dsw-alias-state-warn-label)) 16%,\n    transparent\n  );\n}\n\n.sb-card-desc {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-secondary);\n  display: -webkit-box;\n  -webkit-line-clamp: 2;\n  -webkit-box-orient: vertical;\n  overflow: hidden;\n}\n\n.sb-card-meta {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  min-width: 0;\n  font-size: 11px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.sb-card-meta-icon {\n  flex: none;\n}\n\n.sb-card-when {\n  min-width: 0;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.sb-card-when-label {\n  margin-right: 4px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n/* ---------- \u680F2 \u76EE\u5F55\u6811 ---------- */\n\n.sb-root-bar {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 8px 12px 0;\n}\n\n.sb-root-label {\n  flex: none;\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.sb-root-select {\n  flex: 1;\n  min-width: 0;\n  height: 26px;\n  padding: 0 6px;\n  font: inherit;\n  font-size: 12px;\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 6px;\n  outline: none;\n  cursor: pointer;\n}\n\n.sb-crumbs {\n  flex: none;\n  display: flex;\n  align-items: center;\n  flex-wrap: wrap;\n  row-gap: 2px;\n  padding: 6px 12px;\n  border-bottom: 1px solid var(--dsw-alias-border-l);\n}\n\n.sb-crumb-seg {\n  display: inline-flex;\n  align-items: center;\n  min-width: 0;\n}\n\n.sb-crumb-sep {\n  margin: 0 2px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.sb-crumb {\n  padding: 1px 4px;\n  border: none;\n  border-radius: 4px;\n  background: transparent;\n  font: inherit;\n  font-size: 11px;\n  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  max-width: 160px;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.sb-crumb:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.sb-tree {\n  flex: 1;\n  min-height: 0;\n  overflow: auto;\n  padding: 4px 0 8px;\n}\n\n.sb-tree-row {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  width: 100%;\n  height: 24px;\n  padding-right: 8px;\n  border: none;\n  background: transparent;\n  font: inherit;\n  font-size: 12px;\n  color: var(--dsw-alias-label-primary);\n  cursor: pointer;\n  text-align: left;\n}\n\n.sb-tree-row:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.sb-tree-row--active,\n.sb-tree-row--active:hover {\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.sb-tree-row svg {\n  flex: none;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.sb-tree-name {\n  flex: 1;\n  min-width: 0;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.sb-tree-row--file .sb-tree-name {\n  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);\n}\n\n.sb-tree-size {\n  flex: none;\n  font-size: 11px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.sb-tree-note {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  padding-top: 4px;\n  padding-bottom: 4px;\n  padding-right: 8px;\n  font-size: 11px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.sb-tree-errmsg {\n  min-width: 0;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.sb-tree-retry {\n  flex: none;\n  padding: 0 4px;\n  border: none;\n  border-radius: 4px;\n  background: transparent;\n  font: inherit;\n  font-size: 11px;\n  color: var(--dsw-alias-brand-primary);\n  cursor: pointer;\n}\n\n.sb-tree-retry:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n/* ---------- \u680F3 \u67E5\u770B / \u7F16\u8F91\u5668 ---------- */\n\n.sb-editor-topbar {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  height: 40px;\n  padding: 0 12px;\n  border-bottom: 1px solid var(--dsw-alias-border-l);\n}\n\n.sb-editor-filename {\n  flex: none;\n  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);\n  font-size: 12px;\n  font-weight: 600;\n}\n\n.sb-editor-path {\n  min-width: 0;\n  font-size: 11px;\n  color: var(--dsw-alias-label-dimmed);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.sb-dirty-dot {\n  flex: none;\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  background: var(--dsw-alias-state-warn-label);\n}\n\n.sb-editor-empty {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 8px;\n  padding: 24px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary);\n  text-align: center;\n}\n\n/* \u53EA\u8BFB\u9884\u89C8\uFF1A\u884C\u53F7 + pre \u540C\u5728\u4E00\u4E2A\u6EDA\u52A8\u5BB9\u5668\uFF0C\u884C\u53F7\u6A2A\u5411\u5438\u4F4F */\n.sb-editor-scroll {\n  flex: 1;\n  min-height: 0;\n  overflow: auto;\n  display: flex;\n  align-items: flex-start;\n}\n\n.sb-gutter {\n  flex: none;\n  position: sticky;\n  left: 0;\n  padding: 8px 8px 8px 12px;\n  border-right: 1px solid var(--dsw-alias-border-l);\n  background: var(--dsw-alias-bg-base);\n  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);\n  font-size: 12px;\n  line-height: 20px;\n  text-align: right;\n  color: var(--dsw-alias-label-dimmed);\n  user-select: none;\n}\n\n.sb-pre {\n  flex: 1;\n  min-width: max-content;\n  margin: 0;\n  padding: 8px 12px;\n  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);\n  font-size: 12px;\n  line-height: 20px;\n  white-space: pre;\n  color: var(--dsw-alias-label-primary);\n}\n\n/* \u7F16\u8F91\u6A21\u5F0F\uFF1A\u72EC\u7ACB\u884C\u53F7\u5217\u4E0E textarea \u540C\u6B65\u6EDA\u52A8 */\n.sb-editor-edit {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  overflow: hidden;\n}\n\n.sb-gutter--edit {\n  position: static;\n  overflow: hidden;\n  border-right: 1px solid var(--dsw-alias-border-l);\n}\n\n.sb-textarea {\n  flex: 1;\n  min-width: 0;\n  padding: 8px 12px;\n  border: none;\n  outline: none;\n  resize: none;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);\n  font-size: 12px;\n  line-height: 20px;\n  white-space: pre;\n  overflow: auto;\n}\n\n/* \u72B6\u6001\u6761 */\n.sb-statusbar {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  height: 26px;\n  padding: 0 12px;\n  border-top: 1px solid var(--dsw-alias-border-l);\n  font-size: 11px;\n  color: var(--dsw-alias-label-tertiary);\n  overflow: hidden;\n  white-space: nowrap;\n}\n\n.sb-status-item {\n  flex: none;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.sb-status--dirty {\n  color: var(--dsw-alias-state-warn-label);\n}\n\n.sb-status--saved {\n  color: var(--dsw-alias-state-success-primary);\n}\n\n.sb-status--error {\n  color: var(--dsw-alias-state-error-primary);\n}\n\n/* \u9762\u677F\u7EA7\u72B6\u6001\u6761\uFF1A\u56FA\u5B9A\u5728\u9762\u677F\u5E95\u90E8\uFF0C\u7F16\u8F91\u5668\u9690\u85CF\u65F6\u4E5F\u53EF\u89C1 */\n.sb-statusbar--panel {\n  height: 28px;\n  border-top: 1px solid var(--dsw-alias-border-l);\n}\n\n/* \u7B5B\u9009 chips \u540C\u884C\u7684\u5206\u9694\u7AD6\u7EBF */\n.sb-chips-sep {\n  flex: none;\n  align-self: stretch;\n  width: 1px;\n  margin: 0 4px;\n  background: var(--dsw-alias-border-l);\n}\n\n/* ---------- \u653E\u5F03\u4FEE\u6539\u786E\u8BA4\u5F39\u7A97 ---------- */\n\n.sb-modal-overlay {\n  position: fixed;\n  inset: 0;\n  z-index: 100;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: rgba(0, 0, 0, 0.4);\n}\n\n.sb-modal {\n  width: 360px;\n  max-width: calc(100vw - 48px);\n  padding: 16px;\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-base));\n}\n\n.sb-modal-title {\n  font-size: 13px;\n  font-weight: 600;\n  line-height: 20px;\n}\n\n.sb-modal-body {\n  margin-top: 8px;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.sb-modal-actions {\n  margin-top: 16px;\n  display: flex;\n  justify-content: flex-end;\n  gap: 8px;\n}\n\n/* ---------- \u6EDA\u52A8\u6761\uFF08\u8DDF\u968F DSH token\uFF0C\u7F3A token \u65F6\u7528\u8FB9\u6846\u8272\u515C\u5E95\uFF09 ---------- */\n\n.sb-list::-webkit-scrollbar,\n.sb-tree::-webkit-scrollbar,\n.sb-editor-scroll::-webkit-scrollbar,\n.sb-textarea::-webkit-scrollbar {\n  width: 8px;\n  height: 8px;\n}\n\n.sb-list::-webkit-scrollbar-thumb,\n.sb-tree::-webkit-scrollbar-thumb,\n.sb-editor-scroll::-webkit-scrollbar-thumb,\n.sb-textarea::-webkit-scrollbar-thumb {\n  border-radius: 4px;\n  background: var(--dsw-alias-scrollbar-bg-l, var(--dsw-alias-border-l));\n}\n\n.sb-list::-webkit-scrollbar-thumb:hover,\n.sb-tree::-webkit-scrollbar-thumb:hover,\n.sb-editor-scroll::-webkit-scrollbar-thumb:hover,\n.sb-textarea::-webkit-scrollbar-thumb:hover {\n  background: var(--dsw-alias-scrollbar-hover-l, var(--dsw-alias-label-dimmed));\n}\n\n.sb-list::-webkit-scrollbar-track,\n.sb-tree::-webkit-scrollbar-track,\n.sb-editor-scroll::-webkit-scrollbar-track,\n.sb-textarea::-webkit-scrollbar-track {\n  background: transparent;\n}\n\n/* \u2500\u2500 settings panel enhancement (fullscreen / drag-resize) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n\n/* Fullscreen toggle button: pinned to the panel's top-right, left of the\n   framework's close button (36px wide), above the content stack. */\n.sb-panel-maximize {\n  position: absolute;\n  top: 10px;\n  right: 46px;\n  z-index: 20;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n  padding: 0;\n  border: none;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  transition: background-color 120ms ease, color 120ms ease;\n}\n\n.sb-panel-maximize:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.sb-panel-maximize:focus-visible {\n  outline: 2px solid var(--dsw-alias-brand-primary);\n  outline-offset: 1px;\n}\n\n/* Drag-resize handle: bottom-right corner grip. */\n.sb-panel-resize-handle {\n  position: absolute;\n  right: 0;\n  bottom: 0;\n  z-index: 20;\n  display: flex;\n  align-items: flex-end;\n  justify-content: flex-end;\n  width: 26px;\n  height: 26px;\n  padding: 0 5px 5px 0;\n  box-sizing: border-box;\n  cursor: nwse-resize;\n  border-radius: 0 0 24px 0;\n  color: var(--dsw-alias-label-secondary);\n  transition: color 120ms ease, background-color 120ms ease;\n}\n\n.sb-panel-resize-handle:hover,\n.sb-panel-resize-handle--active {\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n/* ---------- \u6280\u80FD\u6765\u6E90\u7B5B\u9009 chips ---------- */\n\n.sb-chips {\n  flex: none;\n  display: flex;\n  flex-wrap: wrap;\n  gap: 4px;\n  padding: 0 8px 6px;\n}\n\n.sb-chip {\n  height: 22px;\n  padding: 0 10px;\n  font: inherit;\n  font-size: 11px;\n  line-height: 22px;\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 11px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  white-space: nowrap;\n}\n\n.sb-chip:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.sb-chip--active {\n  border-color: var(--dsw-alias-brand-primary);\n  color: var(--dsw-alias-brand-primary);\n  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);\n}\n\n/* ---------- \u7981\u7528 / \u542F\u7528 ---------- */\n\n.sb-card--disabled .sb-card-name,\n.sb-card--disabled .sb-card-desc,\n.sb-card--disabled .sb-card-when {\n  opacity: 0.55;\n}\n\n.sb-badge--disabled {\n  color: var(--dsw-static-neutral-5, var(--dsw-alias-label-tertiary));\n  background: color-mix(\n    in srgb,\n    var(--dsw-static-neutral-5, var(--dsw-alias-label-tertiary)) 16%,\n    transparent\n  );\n}\n\n.sb-badge--protected {\n  color: var(--dsw-static-blue-5, var(--dsw-alias-label-secondary));\n  background: color-mix(\n    in srgb,\n    var(--dsw-static-blue-5, var(--dsw-alias-label-secondary)) 14%,\n    transparent\n  );\n}\n\n.sb-toggle {\n  flex: none;\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  height: 20px;\n  padding: 0 8px;\n  font: inherit;\n  font-size: 11px;\n  line-height: 20px;\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 10px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  white-space: nowrap;\n}\n\n.sb-toggle:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.sb-toggle--disabled {\n  border-color: var(--dsw-alias-state-warn-border, var(--dsw-alias-border-l));\n  color: var(--dsw-static-amber-5, var(--dsw-alias-state-warn-label));\n}\n\n/* \u5207\u6362\u64CD\u4F5C\u5931\u8D25\u63D0\u793A\u6761\uFF08\u5DE5\u5177\u6761\u4E0B\u65B9\uFF09 */\n\n.sb-action-error {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  margin: 0 8px 6px;\n  padding: 4px 8px;\n  font-size: 11px;\n  color: var(--dsw-static-red-5, var(--dsw-alias-state-danger-label));\n  background: color-mix(\n    in srgb,\n    var(--dsw-static-red-5, var(--dsw-alias-state-danger-label)) 10%,\n    transparent\n  );\n  border: 1px solid var(--dsw-alias-state-danger-border, var(--dsw-alias-border-l));\n  border-radius: 6px;\n}\n\n.sb-action-error-text {\n  flex: 1;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n/* ---------- \u5206\u9875\u6761 ---------- */\n\n.sb-pager {\n  flex: none;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 8px;\n  padding: 6px 8px;\n  border-top: 1px solid var(--dsw-alias-border-l);\n}\n\n.sb-pager-info {\n  font-size: 11px;\n  color: var(--dsw-alias-label-tertiary);\n  white-space: nowrap;\n}\n\n/* ---------- \u81EA\u5B9A\u4E49\u76EE\u5F55\u7BA1\u7406\u5F39\u7A97 ---------- */\n\n.sb-modal--dirs {\n  width: 560px;\n  max-width: calc(100vw - 48px);\n}\n\n.sb-dirs-help {\n  margin: 0 0 10px;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.sb-dirs-addrow {\n  display: flex;\n  gap: 8px;\n  margin-bottom: 10px;\n}\n\n.sb-dirs-input {\n  flex: 1;\n  min-width: 0;\n  height: 28px;\n  padding: 0 10px;\n  font: inherit;\n  font-size: 12px;\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 6px;\n  background: var(--dsw-alias-input-bg, transparent);\n  color: var(--dsw-alias-label-primary);\n}\n\n.sb-dirs-input:focus-visible {\n  outline: 2px solid var(--dsw-alias-brand-primary);\n  outline-offset: 1px;\n}\n\n.sb-dirs-list {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  max-height: 280px;\n  overflow-y: auto;\n}\n\n.sb-dirs-row {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 6px 8px;\n  border: 1px solid var(--dsw-alias-border-l);\n  border-radius: 6px;\n}\n\n.sb-dirs-path {\n  flex: 1;\n  min-width: 0;\n  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);\n  font-size: 12px;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--dsw-alias-label-primary);\n}\n\n.sb-dirs-path--missing {\n  color: var(--dsw-static-red-5, var(--dsw-alias-state-danger-label));\n  text-decoration: line-through;\n}\n\n/* ---------- dsh-memory-evolve integration ---------- */\n\n/* Inside the session memory tab, cap the height like the other feature\n   panels (62vh) so the skill manager never grows the page; the three panes\n   scroll internally. */\n.mt-panel .sb-root {\n  height: auto;\n  max-height: 62vh;\n  flex: none;\n}\n";

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
  "memoryTab.label": "\u8BB0\u5FC6\u6280\u80FD\u5F85\u529E",
  "memoryTab.label.pending": "\u{1F534} \u8BB0\u5FC6\u6280\u80FD\u5F85\u529E ({count})",
  "coiTab.label": "CLI\u8C03\u5EA6",
  "scratchTab.label": "\u4E34\u65F6\u4FE1\u606F",
  "promptTab.label": "\u63D0\u793A\u8BCD",
  "promptTab.label.active": "\u{1F534} \u63D0\u793A\u8BCD ({count})",
  "memoryTab.feature.guide": "\u4F7F\u7528\u6307\u5357",
  "memoryTab.feature.suggestions": "\u5F85\u786E\u8BA4\u8BB0\u5FC6\u5EFA\u8BAE",
  "memoryTab.feature.todoSuggestions": "\u5F85\u786E\u8BA4\u5F85\u529E\u5EFA\u8BAE",
  "memoryTab.feature.skills": "\u5F85\u786E\u8BA4\u6280\u80FD\u5EFA\u8BAE",
  "memoryTab.feature.config": "\u8FD0\u884C\u65F6\u914D\u7F6E",
  "memoryTab.feature.skillBrowser": "\u6280\u80FD\u7BA1\u7406",
  "memoryTab.feature.todo": "\u5F85\u529E",
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
  "memoryTab.cwd": "\u5F53\u524D\u4F1A\u8BDD\u5DE5\u4F5C\u76EE\u5F55",
  "memoryTab.loading": "\u52A0\u8F7D\u4E2D\u2026",
  "memoryTab.warning": "\u4EE5\u4E0B\u6587\u4EF6\u4E3A \xA7 \u5206\u9694\u7684\u7ED3\u6784\u5316\u8BB0\u5FC6\uFF0C\u7528\u7CFB\u7EDF\u5DE5\u5177\u6253\u5F00\u540E\u8BF7\u8C28\u614E\u7F16\u8F91\uFF0C\u968F\u610F\u4FEE\u6539\u53EF\u80FD\u7834\u574F\u683C\u5F0F\u3001\u5BFC\u81F4\u8BB0\u5FC6\u8BFB\u53D6\u9519\u4E71\u3002",
  "memoryTab.readonly": "\u53EA\u8BFB",
  "memoryTab.open": "\u6253\u5F00\u6587\u4EF6",
  "memoryTab.opened": "\u5DF2\u7528\u7CFB\u7EDF\u5DE5\u5177\u6253\u5F00",
  "memoryTab.empty": "\uFF08\u6587\u4EF6\u4E0D\u5B58\u5728\u6216\u4E3A\u7A7A\uFF09",
  "memoryTab.noCwd": "\uFF08\u5F53\u524D\u4F1A\u8BDD\u65E0\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u65E0\u6CD5\u5B9A\u4F4D\u9879\u76EE\u8BB0\u5FC6\uFF09",
  "memoryTab.truncated": "\uFF08\u5185\u5BB9\u8FC7\u957F\uFF0C\u5DF2\u622A\u65AD\u663E\u793A\uFF09",
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
  "panel.guide.search.desc": "\u8BB0\u5FC6\u91CC\u6CA1\u6709\u3001\u8981\u627E\u672C\u5730\u8D44\u6599\u65F6\uFF0CAI \u53EF\u6309\u6587\u4EF6\u540D\u641C\u7D22\u2014\u2014\u4E0D\u6B62\u6587\u6863\uFF0C\u56FE\u7247/\u4EE3\u7801/\u914D\u7F6E\u7B49\u4E00\u5207\u4E0E\u9879\u76EE\u76F8\u5173\u7684\u6587\u4EF6\u90FD\u80FD\u627E\uFF08\u9ED8\u8BA4\u53EA\u641C\u6587\u6863\u6269\u5C55\u540D\uFF0C\u9700\u8981\u65F6\u53EF\u663E\u5F0F\u5168\u7C7B\u578B\u641C\u7D22\uFF09\u3002**\u9ED8\u8BA4\u7981\u7528**\uFF1A\u9700\u8981\u65F6\u5728\u4E0B\u65B9\u300C\u8FD0\u884C\u65F6\u914D\u7F6E\u300D\u6253\u5F00\u5F00\u5173\uFF0C\u6216\u5BF9\u6211\u8BF4\u201C\u542F\u7528\u672C\u5730\u641C\u7D22\u201D\u3002",
  "panel.guide.coi.title": "COI \u8C03\u5EA6\uFF08de_coi\uFF09",
  "panel.guide.coi.desc": '\u628A\u4EFB\u52A1\u6D3E\u7ED9\u5916\u90E8 CLI \u4EE3\u7406\uFF08kimi/codex/grok/hermes \u7B49\uFF09\uFF1A\u7EDF\u4E00\u8C03\u5EA6\u4E0D\u5361\u4E3B\u8FDB\u7A0B\u3001\u5B9E\u65F6\u770B\u8FDB\u5EA6\u3001\u4F1A\u8BDD\u81EA\u52A8\u5206\u5C42\u7BA1\u7406\u53EF\u4E00\u952E\u6062\u590D\u3001\u8DE8 COI \u63A5\u529B\u3001\u4EFB\u52A1\u7ED3\u679C\u7559\u6863\u5E76\u6C89\u6DC0\u5230\u8BB0\u5FC6\u3002\u8BF4"\u6D3E\u7ED9 kimi/codex \u505A XX"\u5373\u53EF\uFF0C\u6216\u6253\u5F00\u300CCOI \u8C03\u5EA6\u300DTab \u624B\u52A8\u53D1\u8D77\u3002**\u9ED8\u8BA4\u7981\u7528**\uFF1A\u4E0E\u672C\u5730\u641C\u7D22\u4E00\u6837\u6309\u9700\u542F\u7528\u2014\u2014\u5728\u4E0B\u65B9\u300C\u8FD0\u884C\u65F6\u914D\u7F6E\u300D\u6253\u5F00\u300CCOI \u8C03\u5EA6\u300D\u5F00\u5173\uFF08\u5DE5\u5177\u5373\u65F6\u751F\u6548\uFF0CTab \u5237\u65B0\u540E\u51FA\u73B0\uFF09\u3002',
  "panel.guide.prompt.title": "\u63D0\u793A\u8BCD\u7BA1\u7406\u5668\uFF08Prompt Manager\uFF09",
  "panel.guide.prompt.desc": "\u628A\u5E38\u7528\u7684\u5DE5\u4F5C\u8303\u5F0F\u56FA\u5316\u6210\u63D0\u793A\u8BCD\u8D44\u4EA7\uFF08\u5185\u7F6E\u7A0B\u5E8F\u5458\u793A\u4F8B\uFF1A\u4EE3\u7801\u5BA1\u67E5/\u8C03\u8BD5/\u67B6\u6784/\u6D4B\u8BD5\u7B49\uFF0C\u6765\u6E90\u4EE5\u81EA\u5199\u4E3A\u4E3B\uFF09\uFF1A\u9009\u4E2D\u4E00\u6761\u5373\u53EF\u6CE8\u5165\u2014\u2014**\u5199\u5165\u540E\u6A21\u578B\u4E0B\u4E00\u8F6E\u81EA\u52A8\u770B\u5230\u3001\u4E0D\u6253\u65AD\u56DE\u590D**\uFF1B\u652F\u6301\u4E00\u6B21\u6027\u3001\u6301\u7EED N \u8F6E\u3001\u6BCF M \u56DE\u5408\u63D0\u9192\u4E00\u6B21\uFF08\u6309\u5BF9\u8BDD\u56DE\u5408\u8BA1\u6570\u81EA\u52A8\u8FC7\u671F\uFF09\uFF0C\u300C\u6CE8\u5165\u4E2D\u300D\u53EF\u968F\u65F6\u505C\u6B62\u3002**\u9ED8\u8BA4\u7981\u7528**\uFF1A\u5728\u4E0B\u65B9\u300C\u8FD0\u884C\u65F6\u914D\u7F6E\u300D\u6253\u5F00\u300C\u63D0\u793A\u8BCD\u7BA1\u7406\u5668\u300D\u5F00\u5173\uFF0CTab \u5237\u65B0\u540E\u51FA\u73B0\u3002",
  "panel.guide.confirm.title": "\u786E\u8BA4\u5236\uFF08\u4E3A\u4EC0\u4E48 AI \u4E0D\u80FD\u76F4\u63A5\u5199\uFF09",
  "panel.guide.confirm.desc": "AI \u81EA\u5EFA\u7684\u8BB0\u5FC6\u3001\u5F85\u529E\u3001\u6280\u80FD\u90FD\u5148\u8FDB\u5F85\u786E\u8BA4\u961F\u5217\uFF0C\u7B49\u4F60\u786E\u8BA4\u624D\u751F\u6548\u3002\u56E0\u4E3A\u8FD9\u4E9B\u5199\u5165\u4F1A\u771F\u5B9E\u6539\u53D8 AI \u7684\u884C\u4E3A\uFF1A\u8BB0\u5FC6\u4F1A\u8FDB\u5165\u4E0A\u4E0B\u6587\u3001\u5F85\u529E\u662F\u7ED9\u4F60\u6D3E\u7684\u6D3B\u3001\u6280\u80FD\u4F1A\u6539\u53D8 AI \u7684\u80FD\u529B\u5E93\u2014\u2014\u5982\u679C AI \u64C5\u81EA\u5199\u5165\uFF0C\u53EF\u80FD\u628A\u5B83\u7684\u8BEF\u5224\u5F53\u4E8B\u5B9E\u6C89\u6DC0\u3001\u6216\u81EA\u4F5C\u4E3B\u5F20\u7ED9\u4F60\u6D3E\u6D3B\u3002\u4F60\u662F\u6700\u7EC8\u628A\u5173\u8005\uFF1AAI \u53EA\u63D0\u8BAE\uFF0C\u4F60\u51B3\u5B9A\u3002",
  "panel.guide.best.title": "\u600E\u4E48\u7528\u5F97\u6700\u597D",
  "panel.guide.best.1": '\u8DE8\u4F1A\u8BDD\u8854\u63A5\uFF1A\u9879\u76EE\u7EA6\u5B9A/\u8FDB\u5C55\u76F4\u63A5\u8BF4"\u67E5\u4E00\u4E0B\u8BB0\u5FC6"\uFF0CAI \u4ECE\u9879\u76EE\u65E5\u5FD7\u4E0E\u5173\u952E\u8BB0\u5FC6\u91CC\u63A5\u7EED\uFF0C\u4E0D\u91CD\u590D\u4EA4\u4EE3\u3002',
  "panel.guide.best.2": '\u53E3\u5934\u5373\u8BB0\uFF1A\u60F3\u5230\u4EC0\u4E48\u5C31\u8BF4"\u8BB0\u4F4F\u8FD9\u4E2A / \u8FD9\u4E2A\u8981\u8DDF\u8FDB"\uFF0CAI \u81EA\u52A8\u5206\u7C7B\u6C89\u6DC0\uFF1B\u9694\u51E0\u5929\u56DE\u6765\u8BF4\u4E00\u53E5\u5C31\u80FD\u63A5\u4E0A\u3002',
  "panel.guide.best.3": "\u5B9A\u671F\u786E\u8BA4\uFF1A\u5076\u5C14\u770B\u770B\u300C\u5F85\u786E\u8BA4\u8BB0\u5FC6\u5EFA\u8BAE\u300D\u300C\u5F85\u786E\u8BA4\u5F85\u529E\u5EFA\u8BAE\u300D\u4E24\u4E2A tab\uFF0C\u91C7\u7EB3\u6216\u62D2\u7EDD\u2014\u2014\u8FD9\u662F\u8BB0\u5FC6\u8FDB\u5316\u7684\u786E\u8BA4\u73AF\u8282\u3002",
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
  "panel.config.title": "\u8FD0\u884C\u65F6\u914D\u7F6E",
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
  "panel.config.searchDocsEnabled.hint": "\u542F\u7528 memory_evolve_search_local_files\uFF1A\u8BA9\u6A21\u578B\u80FD\u5728\u672C\u673A\u6240\u6709\u78C1\u76D8/\u76EE\u5F55\u4E2D\u6309\u6587\u4EF6\u540D\u641C\u7D22\u6587\u4EF6\uFF08\u9ED8\u8BA4\u53EA\u641C\u6587\u6863 md/docx/pdf\u2026\uFF1B\u5168\u7C7B\u578B/\u6587\u4EF6\u5939\u9700\u663E\u5F0F\u53C2\u6570\u786E\u8BA4\uFF1B\u53EA\u5339\u914D\u6587\u4EF6\u540D\u4E0D\u8BFB\u5185\u5BB9\uFF09\u3002\u9ED8\u8BA4\u5173\u95ED\uFF1B\u5173\u95ED\u65F6\u5DE5\u5177\u5BF9\u6A21\u578B\u5B8C\u5168\u4E0D\u53EF\u89C1",
  "panel.config.promptsEnabled": "\u63D0\u793A\u8BCD\u7BA1\u7406\u5668",
  "panel.config.promptsEnabled.hint": "\u542F\u7528\u300C\u63D0\u793A\u8BCD\u300DTab\uFF1A\u63D0\u793A\u8BCD\u5E93\uFF08\u7528\u6237\u81EA\u5199\u8303\u5F0F + \u5185\u7F6E\u793A\u4F8B\uFF09+ \u6CE8\u5165\u8F68\uFF08\u4E00\u6B21\u6027/\u6301\u7EED N \u8F6E/\u6BCF M \u56DE\u5408\u4E00\u6B21\u2014\u2014\u5199\u5165\u540E\u6A21\u578B\u4E0B\u4E00\u8F6E\u81EA\u52A8\u770B\u5230\uFF0C\u56DE\u5408\u9012\u51CF\u81EA\u52A8\u8FC7\u671F\uFF0C\u53EF\u968F\u65F6\u505C\u6B62\uFF09\u3002\u9ED8\u8BA4\u5173\u95ED\uFF1B\u5173\u95ED\u65F6\u5FEB\u7167\u6BB5/\u4E8B\u4EF6\u76D1\u542C/API \u5168\u90E8\u5378\u8F7D\uFF0CTab \u5237\u65B0\u540E\u9690\u85CF",
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
  "memoryTab.label": "Memory, Skills & Todos",
  "memoryTab.label.pending": "\u{1F534} Memory, Skills & Todos ({count})",
  "coiTab.label": "CLI Dispatch",
  "scratchTab.label": "Scratch Pad",
  "promptTab.label": "Prompts",
  "promptTab.label.active": "\u{1F534} Prompts ({count})",
  "memoryTab.feature.guide": "Guide",
  "memoryTab.feature.suggestions": "Memory suggestions",
  "memoryTab.feature.todoSuggestions": "Todo suggestions",
  "memoryTab.feature.skills": "Skill suggestions",
  "memoryTab.feature.config": "Runtime config",
  "memoryTab.feature.skillBrowser": "Skill manager",
  "memoryTab.feature.todo": "Todos",
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
  "memoryTab.cwd": "Session working directory",
  "memoryTab.loading": "Loading\u2026",
  "memoryTab.warning": "These files are \xA7-delimited structured memory. If you open them with a system tool, edit with caution \u2014 careless changes can break the format and corrupt memory reads.",
  "memoryTab.readonly": "Read-only",
  "memoryTab.open": "Open file",
  "memoryTab.opened": "Opened with the system tool",
  "memoryTab.empty": "(missing or empty)",
  "memoryTab.noCwd": "(no working directory for this session \u2014 project memory unavailable)",
  "memoryTab.truncated": "(content truncated for display)",
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
  "panel.guide.search.desc": "When memory is not enough and local material is needed, the AI can search by file name \u2014 not just documents: images, code, configs, anything relevant to the project (documents only by default; full-type search available when explicitly requested). **Disabled by default**: toggle it on in the runtime config below, or tell the AI \u201Cenable local search\u201D.",
  "panel.guide.coi.title": "COI dispatch (de_coi)",
  "panel.guide.coi.desc": "Dispatch tasks to external CLI agents (kimi/codex/grok/hermes\u2026): unified non-blocking scheduling, live progress, auto-tiered session management with one-click resume, cross-COI relay, archived results that also sink into memory. Just say \u201Chave kimi/codex do X\u201D, or open the CLI Dispatch tab to dispatch manually. **Disabled by default**: enable the COI dispatch toggle in the runtime config below (tools take effect immediately; the tab appears after a refresh).",
  "panel.guide.prompt.title": "Prompt manager",
  "panel.guide.prompt.desc": "Turn recurring working paradigms into prompt assets (built-in programmer examples: code review/debugging/architecture/tests\u2026; write your own as the main source). Pick one and inject \u2014 the content becomes visible to the model next turn without interrupting the reply; supports one-shot, N consecutive turns, or once every M turns (auto-expiring by turn counting), and can be stopped anytime. **Disabled by default**: enable the prompt manager toggle in the runtime config below; the tab appears after a refresh.",
  "panel.guide.confirm.title": "Confirmation (why the AI cannot write directly)",
  "panel.guide.confirm.desc": "Anything the AI creates \u2014 memory, todos, skills \u2014 enters a pending queue first and only takes effect after your confirmation. These writes genuinely change the AI: memory enters the prompt, todos are tasks assigned to you, skills change the AI\u2019s toolbox. Unchecked auto-writes could silently enshrine the AI\u2019s misjudgments as facts or assign you work you never asked for. You are the final gatekeeper: the AI proposes, you decide.",
  "panel.guide.best.title": "Getting the most out of it",
  "panel.guide.best.1": "Pick up across sessions: say \u201Ccheck the memory\u201D about project conventions/progress \u2014 the AI continues from the project log and key facts instead of asking you to repeat.",
  "panel.guide.best.2": "Dictate as you think: \u201Cremember this / follow up on that\u201D \u2014 the AI files it automatically; a one-liner days later reconnects the thread.",
  "panel.guide.best.3": "Confirm periodically: glance at the memory/todo suggestion tabs and adopt or reject \u2014 that is the confirmation loop of memory evolution.",
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
  "panel.config.title": "Runtime config",
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
  "panel.config.searchDocsEnabled.hint": "Enable memory_evolve_search_local_files: lets the model search files by name across all local disks/directories (documents md/docx/pdf\u2026 by default; all types/folders require explicit parameter confirmation; name matching only, never reads contents). Off by default; when off the tool is completely invisible to the model",
  "panel.config.promptsEnabled": "Prompt manager",
  "panel.config.promptsEnabled.hint": "Enable the Prompts tab: a prompt library (user-written paradigms + built-in examples) plus an injection track (once / N consecutive turns / every M turns \u2014 injected content is visible to the model next turn, expires automatically by turn counting, and can be stopped anytime). Off by default; when off the snapshot section, event listener and API are fully uninstalled and the tab hides after refresh",
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
  let tabCancelled = false;
  let badgeCount = 0;
  let disposeTab;
  const registerTab = () => {
    disposeTab?.();
    disposeTab = ctx.slots.inject("conversation.view", () => ctx.slots.register({
      name: "conversation.view",
      id: "memory-files",
      order: 20,
      label: () => badgeCount > 0 ? t2("memoryTab.label.pending", { count: badgeCount }) : t2("memoryTab.label")
    }, (props) => MemoryTabView({ ...props, t: t2 })));
  };
  const pollBadge = () => {
    if (tabCancelled || disposeTab === void 0) return;
    void fetch("/memory-evolve/api/badge").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((data) => {
      const count = data.count ?? 0;
      if (count !== badgeCount) {
        badgeCount = count;
        registerTab();
      }
    }).catch(() => {
    });
  };
  void fetch("/memory-evolve/api/config").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((data) => {
    if (!scratchCancelled && data.config?.scratchEnabled === true && disposeScratchTab === void 0) {
      disposeScratchTab = ctx.slots.inject("conversation.view", () => ctx.slots.register({
        name: "conversation.view",
        id: "scratch-pad",
        order: 40,
        label: () => t2("scratchTab.label")
      }, (props) => ScratchView({ ...props, t: t2 })));
    }
    if (tabCancelled || data.config?.memoryTabEnabled !== true) return;
    registerTab();
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
    disposeTab?.();
  }, "memory-evolve: memory tab");
  let scratchCancelled = false;
  let disposeScratchTab;
  ctx.effect(() => () => {
    scratchCancelled = true;
    disposeScratchTab?.();
  }, "memory-evolve: scratch tab");
  let coiCancelled = false;
  let disposeCoiTab;
  void fetch("/memory-evolve/api/coi/config").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then(() => {
    if (coiCancelled) return;
    disposeCoiTab = ctx.slots.inject("conversation.view", () => ctx.slots.register({
      name: "conversation.view",
      id: "coi-hub",
      order: 30,
      label: () => t2("coiTab.label")
    }, (props) => CoIView({ ...props, t: t2 })));
  }).catch(() => {
  });
  ctx.effect(() => () => {
    coiCancelled = true;
    disposeCoiTab?.();
  }, "memory-evolve: coi tab");
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
}
return module.exports; } });
