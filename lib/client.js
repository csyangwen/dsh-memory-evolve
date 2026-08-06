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
var import_dsh_client_ui_slots = require("@deepseek-ai/dsh-client-ui-slots");

// src/client/MemoryTabView.tsx
var import_react4 = require("react");

// src/client/MemoryQueueView.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
function todoTargetLabel(t, target) {
  const track = target.slice(5);
  if (track === "life") return `\u5F85\u529E\xB7${t("todo.track.life")}`;
  if (track === "work") return `\u5F85\u529E\xB7${t("todo.track.work")}`;
  if (track === "project") return `\u5F85\u529E\xB7${t("todo.track.project")}`;
  if (track === "daily") return `\u5F85\u529E\xB7${t("todo.track.daily")}`;
  return target;
}
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
  const { t, feature, onChanged } = props;
  const [entries, setEntries] = (0, import_react.useState)(null);
  const [skills, setSkills] = (0, import_react.useState)(null);
  const [config, setConfig] = (0, import_react.useState)(null);
  const [draft, setDraft] = (0, import_react.useState)(null);
  const [edits, setEdits] = (0, import_react.useState)({});
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
      setConfig(c.config);
      setDraft((prev) => prev ?? c.config);
    }).catch((error) => {
      setNotice({ kind: "error", text: t("panel.config.failed", { message: error.message }) });
    });
  };
  (0, import_react.useEffect)(() => {
    load();
  }, []);
  const runSuggestions = (op, indices) => {
    setBusy(true);
    const body = {};
    if (indices !== void 0) {
      body.indices = indices;
      if (op === "approve") {
        const contents = indices.map((index) => edits[index] ?? "");
        if (contents.some((content) => content !== "")) body.contents = contents;
      }
    }
    void api(`/api/suggestions/${op}`, {
      method: "POST",
      body: JSON.stringify(body)
    }).then((report) => {
      setNotice({ kind: "ok", text: summarizeReport(report) });
      load();
      onChanged();
    }).catch((error) => {
      setNotice({ kind: "error", text: t("panel.config.failed", { message: error.message }) });
    }).finally(() => setBusy(false));
  };
  const runSkill = (op, name) => {
    setBusy(true);
    void api(`/api/pending-skills/${op}`, {
      method: "POST",
      body: JSON.stringify({ name })
    }).then(() => {
      setNotice({ kind: "ok", text: t("panel.skills.done", { op: op === "approve" ? t("panel.skills.approve") : t("panel.skills.reject") }) });
      load();
      onChanged();
    }).catch((error) => {
      setNotice({ kind: "error", text: t("panel.config.failed", { message: error.message }) });
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
      perTurnKeyWrites: draft.perTurnKeyWrites
    };
    void api("/api/config", {
      method: "POST",
      body: JSON.stringify({ patch })
    }).then((res) => {
      setConfig(res.config);
      setDraft(res.config);
      setNotice({ kind: "ok", text: t("panel.config.saved") });
    }).catch((error) => {
      setNotice({ kind: "error", text: t("panel.config.failed", { message: error.message }) });
    }).finally(() => setBusy(false));
  };
  const patchDraft = (patch) => {
    setDraft((prev) => prev === null ? prev : { ...prev, ...patch });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-panel", children: [
    notice !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: `me-notice me-notice-${notice.kind}`, children: notice.text }),
    feature === "suggestions" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "me-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-block-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "me-heading", children: t("panel.suggestions.title") }),
        entries !== null && entries.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-count", children: entries.length })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-help", children: t("panel.suggestions.help") }),
      entries === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-muted", children: t("panel.loading") }) : entries.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-empty", children: t("panel.suggestions.empty") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "me-list", children: entries.map((entry, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: "me-item", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-item-head", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-badge me-badge-target", children: entry.target.startsWith("todo-") ? todoTargetLabel(t, entry.target) : entry.target }),
            (entry.hits ?? 1) > 1 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-badge me-badge-hits", title: t("panel.suggestions.hitsHint"), children: t("panel.suggestions.hits", { count: entry.hits ?? 1 }) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-item-time", title: entry.time, children: formatTime(entry.time) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-item-actions", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  className: "me-btn me-btn-ok",
                  disabled: busy,
                  onClick: () => runSuggestions("approve", [index + 1]),
                  children: t("panel.suggestions.approve")
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  className: "me-btn me-btn-archive",
                  disabled: busy,
                  title: t("panel.suggestions.archiveHint"),
                  onClick: () => runSuggestions("archive", [index + 1]),
                  children: t("panel.suggestions.archive")
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  className: "me-btn me-btn-danger",
                  disabled: busy,
                  onClick: () => runSuggestions("reject", [index + 1]),
                  children: t("panel.suggestions.reject")
                }
              )
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "textarea",
            {
              className: "me-item-edit",
              rows: 3,
              value: edits[index + 1] ?? entry.content,
              onChange: (event) => setEdits((prev) => ({ ...prev, [index + 1]: event.target.value }))
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-item-reason", children: entry.reason !== void 0 && entry.reason !== "" ? entry.reason : t("panel.suggestions.editHint") })
        ] }, `${entry.time}-${index}`)) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-bulk", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "me-btn me-btn-ok", disabled: busy, onClick: () => runSuggestions("approve-all"), children: t("panel.suggestions.approveAll") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "me-btn me-btn-danger", disabled: busy, onClick: () => runSuggestions("reject-all"), children: t("panel.suggestions.rejectAll") })
        ] })
      ] })
    ] }),
    feature === "skills" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "me-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-block-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "me-heading", children: t("panel.skills.title") }),
        skills !== null && skills.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-count", children: skills.length })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-help", children: t("panel.skills.help") }),
      skills === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-muted", children: t("panel.loading") }) : skills.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-empty", children: t("panel.skills.empty") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "me-list", children: skills.map((skill) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: "me-item", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-item-head", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-badge me-badge-target", children: skill.name }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-item-time", children: t("panel.skills.pending") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-item-actions", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                className: "me-btn me-btn-ok",
                disabled: busy,
                onClick: () => runSkill("approve", skill.name),
                children: t("panel.skills.approve")
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                className: "me-btn me-btn-danger",
                disabled: busy,
                onClick: () => runSkill("reject", skill.name),
                children: t("panel.skills.reject")
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-item-reason", children: skill.description })
      ] }, skill.name)) })
    ] }),
    feature === "config" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "me-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "me-block-head", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "me-heading", children: t("panel.config.title") }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-help", children: t("panel.config.help") }),
      draft === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-muted", children: t("panel.loading") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-form", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-group", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t("panel.config.reviewEnabled"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t("panel.config.reviewEnabled.hint") })
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
              t("panel.config.reviewInterval"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t("panel.config.reviewInterval.hint") })
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
            t("panel.config.skillReviewEnabled"),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t("panel.config.skillReviewEnabled.hint") })
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
              t("panel.config.perTurnProjectWrites"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t("panel.config.perTurnProjectWrites.hint") })
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
              t("panel.config.perTurnDailyWrites"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t("panel.config.perTurnDailyWrites.hint") })
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
              t("panel.config.perTurnKeyWrites"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t("panel.config.perTurnKeyWrites.hint") })
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
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "me-actions", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "me-btn me-btn-primary", disabled: busy, onClick: saveConfig, children: t("panel.config.save") }) })
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
function formatSize(t, size) {
  if (size == null) return "";
  if (size < 1024) return t("bytes", { size });
  if (size < 1024 * 1024) return t("kib", { size: (size / 1024).toFixed(1) });
  return t("mib", { size: (size / 1024 / 1024).toFixed(1) });
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
    t,
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
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-pane-title", children: t("pane.skills") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-count", children: t("skills.count", { count: filtered.length }) })
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
              t("filter.all"),
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
          children: status === "all" ? t("filter.all") : status === "enabled" ? t("status.enabled") : t("disabled.badge")
        },
        status
      ))
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-list", children: [
      loading && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-note", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconLoadingOutline16, { className: "sb-spin" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("loading.skills") })
      ] }),
      !loading && error !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-note sb-note--error", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconWarningOutline16, {}),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: error }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "sb-btn sb-btn--ghost", onClick: onRetry, children: t("refresh") })
      ] }),
      !loading && error === null && filtered.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-note", children: t("search.empty") }),
      !loading && error === null && paged.map((skill) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
        "button",
        {
          type: "button",
          className: `sb-card${skill.name === selectedName ? " sb-card--active" : ""}${skill.disabled ? " sb-card--disabled" : ""}`,
          onClick: () => onSelect(skill),
          title: skill.disabled ? t("disabled.hint") : void 0,
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "sb-card-top", children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-card-name", children: skill.name }),
              skill.disabled && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-badge sb-badge--disabled", children: t("disabled.badge") }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: `sb-badge${sourceClass(skill.source)}`, children: t("source.badge", { source: skill.source }) })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-card-desc", children: skill.description }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "sb-card-meta", children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ResourceIcon, { skill }),
              skill.whenToUse !== null && skill.whenToUse !== "" && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "sb-card-when", children: [
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-card-when-label", children: t("when.to.use") }),
                skill.whenToUse
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-spacer" }),
              skill.protected ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-badge sb-badge--protected", title: t("protected.hint"), children: t("protected.badge") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                "span",
                {
                  className: `sb-toggle${skill.disabled ? " sb-toggle--disabled" : ""}`,
                  role: "button",
                  tabIndex: 0,
                  title: skill.disabled ? t("enable") : t("disable"),
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
                  children: togglingName === skill.name ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconLoadingOutline16, { className: "sb-spin" }) : skill.disabled ? t("enable") : t("disable")
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
          children: t("pager.prev")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-pager-info", children: t("pager.page", { page: pageSafe, total: pageCount }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          className: "sb-btn sb-btn--ghost",
          disabled: pageSafe >= pageCount,
          onClick: onNextPage,
          children: t("pager.next")
        }
      )
    ] })
  ] });
}
function FileTree(props) {
  const {
    t,
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
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("loading.dir") })
      ] });
    }
    const dirError = dirErrors.get(dirAbs);
    if (dirError !== void 0) {
      return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-tree-note sb-note--error", style: indent, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconWarningOutline16, {}),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-tree-errmsg", title: dirError, children: dirError }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "sb-tree-retry", onClick: () => onRetryDir(dirAbs), children: t("refresh") })
      ] });
    }
    const entries = cache.get(dirAbs);
    if (entries === void 0) return null;
    if (entries.length === 0) {
      return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-tree-note", style: indent, children: t("no.entries") });
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
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-tree-size", children: formatSize(t, entry.size) })
          ]
        },
        abs
      );
    });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-section sb-section--files", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-pane-head", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-pane-title", children: t("pane.files") }) }),
    !hasSkill && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-note", children: t("no.skill.selected") }),
    hasSkill && root === null && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-note", children: t("no.root") }),
    hasSkill && root !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-root-bar", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-root-label", children: t("root.label") }),
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
    t,
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
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("loading.dir") })
    ] });
  } else if (fileError !== null) {
    const msg = fileError.kind === "not.text" ? t("not.text") : fileError.kind === "too.large" ? t("too.large") : t("read.failed", { message: fileError.message });
    body = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-editor-empty sb-note--error", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconWarningOutline16, {}),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: msg })
    ] });
  } else if (file === null) {
    body = /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-editor-empty", children: hasSelection ? t("no.file") : t("no.file") });
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
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-editor-path", title: `${t("path")}: ${file.path}`, children: file.path })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-editor-path", children: t("no.file") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-spacer" }),
      file !== null && !editing && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("button", { type: "button", className: "sb-btn", onClick: onEdit, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconEditOutline16, {}),
        t("edit")
      ] }),
      editing && dirty && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-dirty-dot", title: t("dirty.hint") }),
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
              saveState === "saving" ? t("saving") : t("save")
            ]
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "sb-btn sb-btn--ghost", onClick: onCancel, children: t("cancel") })
      ] })
    ] }),
    body
  ] });
}
function DirsModal(props) {
  const { t, dirs, loading, error, input, mutating, onInputChange, onAdd, onRemove, onClose } = props;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-modal-overlay", onClick: onClose, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-modal sb-modal--dirs", onClick: (e) => e.stopPropagation(), children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-modal-title", children: t("dirs.title") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-modal-body", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "sb-dirs-help", children: t("dirs.help") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-dirs-addrow", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "input",
          {
            className: "sb-dirs-input",
            type: "text",
            value: input,
            placeholder: t("dirs.placeholder"),
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
              t("dirs.add")
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
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("loading.skills") })
        ] }),
        !loading && dirs.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-note", children: t("dirs.empty") }),
        !loading && dirs.map((dir) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-dirs-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: `sb-dirs-path${dir.exists ? "" : " sb-dirs-path--missing"}`, title: dir.path, children: dir.path }),
          !dir.exists && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-badge sb-badge--disabled", children: t("dirs.missing") }),
          dir.exists && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-count", children: t("skills.count", { count: dir.skillCount }) }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "button",
            {
              type: "button",
              className: "sb-btn sb-btn--ghost",
              disabled: mutating,
              onClick: () => onRemove(dir.path),
              children: t("dirs.remove")
            }
          )
        ] }, dir.path))
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-modal-actions", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "sb-btn", onClick: onClose, children: t("cancel") }) })
  ] }) });
}
function SkillsBrowser({ t }) {
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
          err instanceof Error ? err.message : t("toggle.failed", { message: String(err) })
        );
      } finally {
        setTogglingName(null);
      }
    },
    [togglingName, loadSkills, t]
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
                placeholder: t("search.placeholder"),
                onChange: (e) => setQuery(e.target.value)
              }
            ),
            query !== "" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
              "button",
              {
                type: "button",
                className: "sb-search-clear",
                onClick: () => setQuery(""),
                "aria-label": t("cancel"),
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
              title: t("manage.dirs"),
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
              title: t("refresh"),
              children: refreshing ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconLoadingOutline16, { className: "sb-spin" }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconRefreshOutline16, {})
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          SkillList,
          {
            t,
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
            t,
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
          t,
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
        t("status.skill"),
        ": ",
        selectedName ?? "-"
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "sb-status-item", children: [
        t("status.file"),
        ": ",
        file !== null ? basename(file.path) : "-"
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-spacer" }),
      saveState === "error" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-status-item sb-status--error", children: t("write.failed", { message: saveMessage }) }),
      dirty && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-status-item sb-status--dirty", children: t("status.unsaved") }),
      saveState === "saved" && !dirty && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-status-item sb-status--saved", children: t("status.saved") }),
      file !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-status-item", children: formatSize(t, file.size) }),
      file !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-status-item", children: t("mtime.label", { time: formatTime2(file.mtime) }) })
    ] }),
    dirsOpen && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      DirsModal,
      {
        t,
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
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-modal-title", children: t("confirm.discard.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-modal-body", children: t("confirm.discard.body", { name: file !== null ? basename(file.path) : "" }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-modal-actions", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "button",
          {
            type: "button",
            className: "sb-btn sb-btn--ghost",
            onClick: () => setPendingAction(null),
            children: t("cancel")
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
            children: t("confirm.discard.ok")
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
function quadrantLabel(t, quadrant) {
  if (quadrant === null) return t("todo.quadrant.none");
  return t(`todo.quadrant.${quadrant}`);
}
function TodoView(props) {
  const { t, sessionId } = props;
  const [target, setTarget] = (0, import_react3.useState)("all");
  const [addTarget, setAddTarget] = (0, import_react3.useState)("work");
  const [items, setItems] = (0, import_react3.useState)(null);
  const [cwd, setCwd] = (0, import_react3.useState)(null);
  const [statusFilter, setStatusFilter] = (0, import_react3.useState)("active");
  const [quadFilter, setQuadFilter] = (0, import_react3.useState)("all");
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
    if (target !== "all") params.set("target", target);
    void api2(`/api/todo?${params.toString()}`).then((res) => {
      setItems(res.items);
      setCwd(res.cwd);
      setAddTarget((prev) => {
        if (target !== "all") return prev;
        return res.cwd ? "project" : "work";
      });
    }).catch((error) => setNotice({ kind: "error", text: error.message }));
  }, [sessionId, target]);
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
      flash(t("todo.added"));
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
      flash(done ? t("todo.done") : t("todo.undone"));
    }).catch((error) => {
      setNotice({ kind: "error", text: error.message });
    }).finally(() => setBusy(false));
  };
  const removeTodo = (item) => {
    if (busy) return;
    const snippet = item.text.split("\n")[0].slice(0, 40);
    if (!window.confirm(t("todo.deleteConfirm", { snippet }))) return;
    setBusy(true);
    void api2("/api/todo", {
      method: "POST",
      body: JSON.stringify({ sessionId, action: "remove", target: item.target, id: item.id })
    }).then(() => {
      load();
      flash(t("todo.deleted"));
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
      flash(t("todo.updated"));
    }).catch((error) => {
      setNotice({ kind: "error", text: error.message });
    }).finally(() => setBusy(false));
  };
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const visible = (items ?? []).filter((item) => {
    if (statusFilter === "active" && DONE_STATUSES.has(item.status)) return false;
    if (statusFilter === "done" && !DONE_STATUSES.has(item.status)) return false;
    if (quadFilter === "none" && item.quadrant !== null) return false;
    if (quadFilter !== "all" && quadFilter !== "none" && item.quadrant !== quadFilter) return false;
    return true;
  });
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
          children: t("todo.track.all")
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
          children: t(`todo.track.${track}`)
        },
        track
      ))
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "me-muted me-todo-help", children: t("todo.help") }),
    target === "project" && cwd === null && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "me-muted", children: t("todo.projectHint") }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "me-todo-add", children: [
      target === "all" && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        "select",
        {
          className: "me-todo-select",
          value: addTarget,
          onChange: (event) => setAddTarget(event.target.value),
          title: t("todo.track"),
          children: TARGETS.map((track) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: track, children: t(`todo.track.${track}`) }, track))
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        "input",
        {
          type: "text",
          className: "me-todo-input",
          value: draft,
          placeholder: t("todo.addPlaceholder"),
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
          title: t("todo.quadrant"),
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "", children: t("todo.quadrant.none") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q1", children: t("todo.quadrant.q1") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q2", children: t("todo.quadrant.q2") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q3", children: t("todo.quadrant.q3") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q4", children: t("todo.quadrant.q4") })
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
          title: t("todo.due")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "me-btn me-btn-ok", disabled: busy || draft.trim() === "", onClick: addTodo, children: t("todo.add") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "me-todo-filters", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { className: "me-todo-filter", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: t("todo.filterStatus") }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("select", { value: statusFilter, onChange: (event) => setStatusFilter(event.target.value), children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "active", children: t("todo.status.active") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "all", children: t("todo.all") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "done", children: t("todo.status.done") })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { className: "me-todo-filter", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: t("todo.filterQuadrant") }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("select", { value: quadFilter, onChange: (event) => setQuadFilter(event.target.value), children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "all", children: t("todo.all") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q1", children: t("todo.quadrant.q1") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q2", children: t("todo.quadrant.q2") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q3", children: t("todo.quadrant.q3") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q4", children: t("todo.quadrant.q4") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "none", children: t("todo.quadrant.none") })
        ] })
      ] })
    ] }),
    items === null ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "me-muted", children: t("panel.loading") }) : visible.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "me-empty", children: t("todo.empty") }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("ul", { className: "me-list", children: visible.map((item) => {
      const done = DONE_STATUSES.has(item.status);
      const overdue = item.due !== null && item.due < today && !done;
      return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("li", { className: `me-item me-todo-item${done ? " me-todo-item--done" : ""}`, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "me-item-head", children: [
          target === "all" && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "me-badge me-badge-target", children: t(`todo.track.${item.target}`) }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: `me-badge me-badge-quad me-badge-quad-${item.quadrant ?? "none"}`, children: quadrantLabel(t, item.quadrant) }),
          item.due !== null && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: `me-badge ${overdue ? "me-badge-overdue" : "me-badge-due"}`, children: overdue ? `${t("todo.overdue")} ${item.due}` : `${t("todo.due")} ${item.due}` }),
          item.cat !== null && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "me-badge me-badge-target", children: item.cat }),
          done && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "me-badge me-badge-hits", children: t("todo.status.done") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "me-item-time", children: item.time }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "me-item-actions", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "me-btn me-btn-ok", disabled: busy, onClick: () => toggleDone(item), children: done ? t("todo.undone") : t("todo.done") }),
            editId !== item.id && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "me-btn", disabled: busy, onClick: () => startEdit(item), children: t("todo.edit") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "me-btn me-btn-danger", disabled: busy, onClick: () => removeTodo(item), children: t("memoryTab.delete") })
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
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "", children: t("todo.quadrant.none") }),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q1", children: t("todo.quadrant.q1") }),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q2", children: t("todo.quadrant.q2") }),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q3", children: t("todo.quadrant.q3") }),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "q4", children: t("todo.quadrant.q4") })
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
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "pending", children: t("todo.status.pending") }),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "doing", children: t("todo.status.doing") }),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "done", children: t("todo.status.done") }),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "blocked", children: t("todo.status.blocked") }),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "cancelled", children: t("todo.status.cancelled") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "me-btn me-btn-ok", disabled: busy || editDraft.trim() === "", onClick: () => saveEdit(item), children: t("todo.save") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: "me-btn", disabled: busy, onClick: () => setEditId(null), children: t("todo.cancel") })
          ] })
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "me-todo-text", children: item.text })
      ] }, item.id);
    }) })
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
  const { sessionId, t } = props;
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
  const [deleting, setDeleting] = (0, import_react4.useState)(false);
  const [feature, setFeature] = (0, import_react4.useState)(persistedFeature);
  const [badge, setBadge] = (0, import_react4.useState)({ suggestions: 0, skills: 0 });
  const pollBadge = (0, import_react4.useCallback)(() => {
    void api3("/api/badge").then((data) => setBadge({ suggestions: data.suggestions ?? 0, skills: data.skills ?? 0 })).catch(() => {
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
    void api3("/api/reveal", { method: "POST", body: JSON.stringify({ target }) }).then(() => flash(t("memoryTab.opened"))).catch((error) => setNotice({ kind: "error", text: error.message }));
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
      flash(t("memoryTab.keyAdded"));
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
      flash(t("memoryTab.keyScopeSaved"));
    }).catch((error) => {
      setNotice({ kind: "error", text: error.message });
    }).finally(() => setScopeSaving(false));
  };
  const deleteEntry = (entry) => {
    if (activeRow === null || deleting) return;
    const snippet = entry.text.length > 60 ? `${entry.text.slice(0, 60)}\u2026` : entry.text;
    if (!window.confirm(t("memoryTab.deleteConfirm", { snippet }))) return;
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
      flash(t("memoryTab.deleted"));
    }).catch((error) => {
      setNotice({ kind: "error", text: error.message });
    }).finally(() => setDeleting(false));
  };
  const moveEntry = (entry, op) => {
    if (activeRow === null || deleting) return;
    if (op === "archive") {
      const snippet = entry.text.length > 60 ? `${entry.text.slice(0, 60)}\u2026` : entry.text;
      if (!window.confirm(t("memoryTab.archiveConfirm", { snippet }))) return;
    }
    setDeleting(true);
    const path = op === "archive" ? "/api/memory/archive" : "/api/archive/promote";
    const target = op === "archive" ? activeRow.key : activeRow.key === "archive-memory" ? "memory" : activeRow.key === "archive-key" ? "key" : "user";
    void api3(path, {
      method: "POST",
      body: JSON.stringify({ sessionId: String(sessionId), target, match: entry.raw })
    }).then(() => {
      load();
      flash(op === "archive" ? t("memoryTab.archived") : t("memoryTab.promoted"));
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
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("p", { className: "mt-warning", children: [
      "\u26A0\uFE0F ",
      t("memoryTab.warning")
    ] }),
    cwd !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("p", { className: "mt-cwd", children: [
      t("memoryTab.cwd"),
      ": ",
      cwd
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-file-tabs", role: "tablist", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": feature === "suggestions",
          className: feature === "suggestions" ? "mt-file-tab mt-file-tab-active" : "mt-file-tab",
          onClick: () => setFeature(feature === "suggestions" ? null : "suggestions"),
          children: [
            t("memoryTab.feature.suggestions"),
            badge.suggestions > 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-feature-count", children: badge.suggestions })
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
            t("memoryTab.feature.skills"),
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
          children: t("memoryTab.feature.config")
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
          children: t("memoryTab.feature.skillBrowser")
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
          children: t("memoryTab.feature.todo")
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
    feature !== null ? feature === "skill-browser" ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(SkillsBrowser, { t }) : feature === "todo" ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(TodoView, { t, sessionId: String(sessionId) }) : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      MemoryQueueView,
      {
        t,
        feature,
        onChanged: () => {
          pollBadge();
          window.dispatchEvent(new CustomEvent("dsh-memory-evolve:badge-change"));
        }
      }
    ) : files === null ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "mt-muted", children: t("memoryTab.loading") }) : /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(import_jsx_runtime4.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-toolbar", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-view-toggle", role: "group", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "button",
            {
              type: "button",
              className: view === "pretty" ? "mt-view-btn mt-view-btn-active" : "mt-view-btn",
              onClick: () => setView("pretty"),
              children: t("memoryTab.viewPretty")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "button",
            {
              type: "button",
              className: view === "raw" ? "mt-view-btn mt-view-btn-active" : "mt-view-btn",
              onClick: () => setView("raw"),
              children: t("memoryTab.viewRaw")
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "input",
          {
            type: "search",
            className: "mt-search",
            value: query,
            placeholder: t("memoryTab.searchPlaceholder"),
            onChange: (event) => setQuery(event.target.value)
          }
        )
      ] }),
      q !== "" && activeHidden && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "mt-empty", children: t("memoryTab.noResults") }),
      activeRow !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-card-head", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-card-title", children: activeRow.title }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-badge mt-badge-ro", children: t("memoryTab.readonly") }),
          activeEntries !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-badge mt-badge-count", children: t("memoryTab.entryCount", { count: activeEntries.length }) }),
          activeRow.path !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-card-path", title: activeRow.path, children: activeRow.path }),
          activeRow.available && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-card-actions", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "mt-btn", onClick: () => openWithSystem(activeRow), children: t("memoryTab.open") }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("p", { className: "mt-card-desc", children: [
          t(`memoryTab.desc.${activeRow.key}`),
          activeRow.key === "key" && branch !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "mt-card-desc-branch", children: [
            " ",
            t("memoryTab.keyBranchInfo", { branch })
          ] })
        ] }),
        activeRow.key === "key" && activeRow.available && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-key-add", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "textarea",
            {
              className: "mt-key-input",
              rows: 2,
              value: keyDraft,
              placeholder: t("memoryTab.keyAddPlaceholder"),
              onChange: (event) => setKeyDraft(event.target.value)
            }
          ),
          branches.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-key-scope", children: [
            /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "mt-key-scope-label", children: [
              t("memoryTab.keyScope"),
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
              t("memoryTab.keyScopeAll")
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
            /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-key-help", children: t("memoryTab.keyAddHelp") }),
            /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
              "button",
              {
                type: "button",
                className: "mt-btn mt-btn-primary",
                disabled: keySaving || keyDraft.trim() === "",
                onClick: saveKey,
                children: t("memoryTab.keyAdd")
              }
            )
          ] })
        ] }),
        !activeRow.available ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "mt-muted", children: t("memoryTab.noCwd") }) : !activeRow.exists ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("pre", { className: "mt-content", children: t("memoryTab.empty") }) : activeEntries === null ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("pre", { className: "mt-content", children: activeRow.content }) : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "mt-entries", children: [...activeEntries].reverse().map((entry, index) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-entry", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-entry-head", children: [
            entry.time !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-entry-time", children: entry.time }),
            entry.branch !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-entry-branch mt-entry-branch-tag", title: t("memoryTab.gitBranch"), children: entry.branch }),
            entry.tag !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "mt-entry-tag", title: t("memoryTab.projectTag"), children: entry.tag }),
            activeRow.key === "key" && branches.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
              "button",
              {
                type: "button",
                className: entry.branches === null ? "mt-entry-branch mt-entry-branch-all" : "mt-entry-branch",
                title: entry.branches === null ? t("memoryTab.keyScopeAllHint") : t("memoryTab.keyScopeHint"),
                onClick: () => openScope(entry),
                children: [
                  t("memoryTab.keyScopeLabel"),
                  ": ",
                  entry.branches === null ? t("memoryTab.keyScopeAll") : entry.branches.join(", "),
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
                  title: t("memoryTab.archive"),
                  disabled: deleting,
                  onClick: () => moveEntry(entry, "archive"),
                  children: t("memoryTab.archive")
                }
              ),
              (activeRow.key === "archive-memory" || activeRow.key === "archive-user" || activeRow.key === "archive-key") && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                "button",
                {
                  type: "button",
                  className: "mt-btn mt-entry-op",
                  title: t("memoryTab.promote"),
                  disabled: deleting,
                  onClick: () => moveEntry(entry, "promote"),
                  children: t("memoryTab.promote")
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                "button",
                {
                  type: "button",
                  className: "mt-btn mt-entry-del",
                  title: t("memoryTab.delete"),
                  disabled: deleting,
                  onClick: () => deleteEntry(entry),
                  children: t("memoryTab.delete")
                }
              )
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "mt-entry-text", children: entry.text }),
          activeRow.key === "key" && scopeEdit === entry.raw && branches.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "mt-scope", children: [
            /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "mt-key-scope-label", children: [
              t("memoryTab.keyScope"),
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
              t("memoryTab.keyScopeAll"),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("em", { className: "mt-scope-all-hint", children: t("memoryTab.keyScopeAllWeight") })
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
                  children: t("memoryTab.keyScopeSave")
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: "mt-btn", disabled: scopeSaving, onClick: () => setScopeEdit(null), children: t("memoryTab.keyScopeCancel") })
            ] })
          ] })
        ] }, index)) }),
        activeRow.truncated && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "mt-muted", children: t("memoryTab.truncated") })
      ] })
    ] })
  ] });
}

// src/client/styles.css
var styles_default = "/**\n * dsh-memory-evolve panel styles \u2014 DSH design tokens, `me-` prefix.\n * Colors come exclusively from --dsw-alias-* / --dsw-static-* tokens so the\n * panel follows the light/dark theme automatically (no hardcoded colors).\n */\n\n/* ---------- Root ---------- */\n\n.me-panel {\n  height: 100%;\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: column;\n  gap: 20px;\n  overflow-y: auto;\n  padding: 4px 2px 28px;\n  font-family: var(--dsw-font-family, inherit);\n  color: var(--dsw-alias-label-primary);\n}\n\n/* Inside the session memory tab: the panel is a sub-view, not a full-height\n   settings column \u2014 cap its height so the tab never grows the page. */\n.mt-panel .me-panel {\n  height: auto;\n  max-height: 62vh;\n}\n\n/* ---------- Notice bar (success / error) ---------- */\n\n.me-notice {\n  flex: none;\n  display: flex;\n  align-items: flex-start;\n  gap: 8px;\n  padding: 8px 12px;\n  border-radius: 8px;\n  font-size: 12px;\n  line-height: 1.5;\n}\n\n.me-notice::before {\n  content: '';\n  flex: none;\n  width: 6px;\n  height: 6px;\n  margin-top: 6px;\n  border-radius: 50%;\n}\n\n.me-notice-ok {\n  color: var(--dsw-alias-state-success-primary);\n  background: var(--dsw-alias-state-success-tertiary);\n  border: 1px solid var(--dsw-alias-state-success-primary);\n}\n.me-notice-ok::before {\n  background: var(--dsw-alias-state-success-primary);\n}\n\n.me-notice-error {\n  color: var(--dsw-alias-state-error-primary);\n  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);\n  border: 1px solid var(--dsw-alias-state-error-secondary);\n}\n.me-notice-error::before {\n  background: var(--dsw-alias-state-error-primary);\n}\n\n/* ---------- Section cards ---------- */\n\n.me-block {\n  flex: none;\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  padding: 14px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  background: var(--dsw-alias-bg-layer-1);\n}\n\n.me-block-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n\n.me-heading {\n  margin: 0;\n  font-size: 13px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-count {\n  flex: none;\n  min-width: 18px;\n  box-sizing: border-box;\n  padding: 1px 6px;\n  border-radius: 9px;\n  font-size: 11px;\n  line-height: 16px;\n  text-align: center;\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n.me-help {\n  margin: -4px 0 0;\n  font-size: 12px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.me-muted {\n  margin: 0;\n  padding: 8px 0;\n  font-size: 12px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n/* Friendly empty state */\n.me-empty {\n  margin: 0;\n  padding: 22px 12px;\n  border: 1px dashed var(--dsw-alias-border-l3);\n  border-radius: 10px;\n  font-size: 12px;\n  line-height: 1.5;\n  text-align: center;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n/* ---------- Suggestion list (own scroll area) ---------- */\n\n.me-list {\n  margin: 0;\n  padding: 0 2px 0 0;\n  list-style: none;\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  max-height: 380px;\n  overflow-y: auto;\n}\n\n.me-item {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  padding: 10px 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-base);\n  transition: border-color 120ms ease;\n}\n\n.me-item:hover {\n  border-color: var(--dsw-alias-border-l3);\n}\n\n.me-item-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n}\n\n.me-badge {\n  flex: none;\n  max-width: 45%;\n  padding: 1px 8px;\n  border-radius: 9px;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n.me-badge-hits {\n  color: var(--dsw-alias-state-warn-primary);\n  background: var(--dsw-alias-state-warn-tertiary);\n}\n\n.me-item-time {\n  flex: 1;\n  min-width: 0;\n  font-size: 11px;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.me-item-actions {\n  flex: none;\n  display: flex;\n  gap: 6px;\n}\n\n.me-item-edit {\n  width: 100%;\n  box-sizing: border-box;\n  padding: 8px 10px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  outline: none;\n  background: var(--dsw-alias-bg-layer-1);\n  color: var(--dsw-alias-label-primary);\n  font-family: var(--dsw-font-family, inherit);\n  font-size: 12px;\n  line-height: 1.6;\n  resize: vertical;\n  transition: border-color 120ms ease, background-color 120ms ease;\n}\n\n.me-item-edit:hover {\n  border-color: var(--dsw-alias-border-l3);\n}\n\n.me-item-edit:focus-visible {\n  border-color: var(--dsw-alias-state-business-primary);\n}\n\n.me-item-reason {\n  margin: 0;\n  padding-left: 8px;\n  border-left: 2px solid var(--dsw-alias-border-l3);\n  font-size: 11px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n/* Bulk actions: separated from the list by a hairline */\n.me-bulk {\n  display: flex;\n  gap: 8px;\n  padding-top: 10px;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n}\n\n/* ---------- Buttons ---------- */\n\n.me-btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  height: 26px;\n  padding: 0 10px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  white-space: nowrap;\n  cursor: pointer;\n  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;\n}\n\n.me-btn:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.me-btn:active:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.me-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n.me-btn-archive {\n  border-color: var(--dsw-alias-border-l3);\n  color: var(--dsw-alias-label-secondary);\n}\n\n.me-btn-archive:hover:not(:disabled) {\n  border-color: var(--dsw-alias-interactive-fg-default);\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-archive-list {\n  max-height: 320px;\n  overflow-y: auto;\n}\n\n.me-archive-content {\n  margin: 0;\n  padding: 10px 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-layer-1);\n  font: inherit;\n  font-size: 12px;\n  line-height: 1.6;\n  white-space: pre-wrap;\n  word-break: break-word;\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-btn-ok {\n  color: var(--dsw-alias-state-success-primary);\n  border-color: var(--dsw-alias-state-success-primary);\n}\n.me-btn-ok:hover:not(:disabled) {\n  background: var(--dsw-alias-state-success-tertiary);\n}\n\n.me-btn-danger {\n  color: var(--dsw-alias-state-error-primary);\n}\n.me-btn-danger:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n  border-color: var(--dsw-alias-state-error-secondary);\n}\n\n.me-btn-primary {\n  border-color: transparent;\n  background: var(--dsw-alias-button-primary-fill);\n  color: var(--dsw-alias-label-primary-inverted);\n  font-weight: 600;\n}\n.me-btn-primary:hover:not(:disabled) {\n  background: var(--dsw-alias-button-primary-hover);\n}\n.me-btn-primary:disabled {\n  background: var(--dsw-alias-button-primary-dimmed);\n}\n\n.me-btn:focus-visible,\n.me-switch:focus-visible,\n.me-input:focus-visible,\n.me-select:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary);\n  outline-offset: 1px;\n}\n\n/* ---------- Config form ---------- */\n\n.me-form {\n  display: flex;\n  flex-direction: column;\n}\n\n/* Visual grouping: value rows vs. toggle rows, hairline between groups */\n.me-group {\n  display: flex;\n  flex-direction: column;\n}\n.me-group + .me-group {\n  margin-top: 8px;\n  padding-top: 4px;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n}\n\n.me-field {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  padding: 7px 2px;\n  font-size: 13px;\n  color: var(--dsw-alias-label-primary);\n  cursor: pointer;\n}\n\n.me-field-label {\n  flex: 1;\n  min-width: 0;\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.me-field-hint {\n  font-style: normal;\n  font-size: 11px;\n  line-height: 1.4;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n/* Toggle switch (accent when on) */\n.me-switch {\n  appearance: none;\n  flex: none;\n  position: relative;\n  width: 36px;\n  height: 20px;\n  margin: 0;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 10px;\n  background: var(--dsw-alias-interactive-bg-active);\n  cursor: pointer;\n  transition: background-color 150ms ease, border-color 150ms ease;\n}\n\n.me-switch::after {\n  content: '';\n  position: absolute;\n  top: 2px;\n  left: 2px;\n  width: 14px;\n  height: 14px;\n  border-radius: 50%;\n  background: var(--dsw-static-neutral-00);\n  transition: transform 150ms ease;\n}\n\n.me-switch:hover {\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.me-switch:checked {\n  border-color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-primary);\n}\n\n.me-switch:checked::after {\n  transform: translateX(16px);\n}\n\n/* Number / select inputs, right-aligned and uniform width */\n.me-input,\n.me-select {\n  flex: none;\n  width: 120px;\n  height: 28px;\n  box-sizing: border-box;\n  padding: 0 8px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 6px;\n  outline: none;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  transition: border-color 120ms ease;\n}\n\n.me-input:hover,\n.me-select:hover {\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.me-select {\n  cursor: pointer;\n}\n\n.me-actions {\n  display: flex;\n  justify-content: flex-end;\n  gap: 8px;\n  margin-top: 8px;\n  padding-top: 12px;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n}\n\n/* ---------- Open-files button grid ---------- */\n\n.me-reveal-grid {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));\n  gap: 8px;\n}\n\n.me-btn-reveal {\n  justify-content: flex-start;\n  height: 30px;\n  padding: 0 10px;\n  color: var(--dsw-alias-label-secondary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.me-btn-reveal:hover:not(:disabled) {\n  color: var(--dsw-alias-label-primary);\n  border-color: var(--dsw-alias-state-business-primary);\n}\n\n/* ---------- Scrollbars (token-driven, fall back to border color) ---------- */\n\n.me-panel::-webkit-scrollbar,\n.me-list::-webkit-scrollbar {\n  width: 8px;\n}\n\n.me-panel::-webkit-scrollbar-thumb,\n.me-list::-webkit-scrollbar-thumb {\n  border-radius: 4px;\n  background: var(--dsw-alias-scrollbar-bg-l1, var(--dsw-alias-border-l3));\n}\n\n.me-panel::-webkit-scrollbar-thumb:hover,\n.me-list::-webkit-scrollbar-thumb:hover {\n  background: var(--dsw-alias-scrollbar-hover-l1, var(--dsw-alias-border-l4));\n}\n\n.me-panel::-webkit-scrollbar-track,\n.me-list::-webkit-scrollbar-track {\n  background: transparent;\n}\n\n/* ---- memory tab (conversation.view) ---- */\n.mt-panel {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n  padding: 16px;\n  overflow-y: auto;\n  height: 100%;\n  box-sizing: border-box;\n}\n\n.mt-notice {\n  padding: 8px 12px;\n  border-radius: 8px;\n  font-size: 12px;\n  line-height: 1.5;\n}\n\n.mt-notice-ok {\n  color: var(--dsw-alias-state-success-primary);\n  background: var(--dsw-alias-state-success-tertiary);\n}\n\n.mt-notice-error {\n  color: var(--dsw-alias-state-error-primary);\n  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);\n  border: 1px solid var(--dsw-alias-state-error-secondary);\n}\n\n.mt-cwd {\n  margin: 0;\n  font-size: 11px;\n  color: var(--dsw-alias-label-dimmed);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.mt-muted {\n  margin: 0;\n  font-size: 12px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.mt-list {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n}\n\n.mt-card {\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  padding: 12px;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  background: var(--dsw-alias-bg-layer-1);\n}\n\n.mt-card-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n}\n\n/* \u6BCF\u4E2A\u6587\u4EF6\u9875\u7B7E\u9876\u90E8\u7684\u4E00\u884C\u5C0F\u5B57\u8BF4\u660E\uFF08\u4F5C\u7528\u4E0E\u673A\u5236\uFF09 */\n.mt-card-desc {\n  margin: 0;\n  font-size: 11px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.mt-card-title {\n  flex: none;\n  font-size: 13px;\n  font-weight: 600;\n}\n\n.mt-badge {\n  flex: none;\n  padding: 1px 8px;\n  border-radius: 9px;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n}\n\n.mt-badge-ro {\n  color: var(--dsw-alias-label-secondary);\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.mt-card-path {\n  flex: 1;\n  min-width: 0;\n  font-size: 11px;\n  color: var(--dsw-alias-label-dimmed);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  direction: rtl;\n  text-align: left;\n}\n\n.mt-card-actions {\n  flex: none;\n}\n\n.mt-btn {\n  padding: 3px 10px;\n  border-radius: 6px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font-size: 12px;\n  cursor: pointer;\n}\n\n.mt-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n/* ---- manual project KEY add box ---- */\n\n/* Branch-scope line in the KEY add box and in the per-entry scope editor. */\n.mt-key-scope {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 4px 12px;\n}\n\n.mt-key-scope-label {\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.mt-scope-opt {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  font-size: 12px;\n  cursor: pointer;\n}\n\n.mt-scope-opt input {\n  margin: 0;\n  accent-color: var(--dsw-alias-state-business-primary);\n}\n\n.mt-scope-all-hint {\n  font-style: normal;\n  font-size: 10px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n/* Per-entry branch-scope badge (click to edit). */\n.mt-entry-branch {\n  flex: none;\n  max-width: 45%;\n  padding: 1px 8px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 9px;\n  background: transparent;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--dsw-alias-state-business-primary);\n  cursor: pointer;\n}\n\n.mt-entry-branch:hover {\n  border-color: var(--dsw-alias-interactive-fg-default);\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.mt-entry-branch-all {\n  color: var(--dsw-alias-label-secondary);\n  font-weight: 500;\n}\n\n/* Static source-branch tag on daily/project log entries (not clickable). */\n.mt-entry-branch-tag {\n  color: var(--dsw-alias-state-success-primary);\n  cursor: default;\n  border-style: dashed;\n}\n\n/* Inline scope editor panel under a KEY entry. */\n.mt-scope {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 4px 12px;\n  padding: 8px 10px;\n  border: 1px dashed var(--dsw-alias-border-l4);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n}\n\n.mt-scope-actions {\n  margin-left: auto;\n  display: flex;\n  gap: 6px;\n}\n\n/* Current-branch suffix on the KEY tab description line. */\n.mt-card-desc-branch {\n  color: var(--dsw-alias-state-business-primary);\n  font-weight: 600;\n}\n\n.mt-key-add {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding: 10px;\n  margin-bottom: 10px;\n  border: 1px dashed var(--dsw-alias-border-l4);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n}\n\n.mt-key-input {\n  box-sizing: border-box;\n  width: 100%;\n  padding: 8px 10px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 8px;\n  outline: none;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  line-height: 1.5;\n  resize: vertical;\n  transition: border-color 120ms ease;\n}\n\n.mt-key-input:hover {\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.mt-key-input:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary);\n  outline-offset: 1px;\n}\n\n.mt-key-input::placeholder {\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.mt-key-add-foot {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 10px;\n}\n\n.mt-key-help {\n  font-size: 11px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.mt-btn-primary {\n  flex: none;\n  border-color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-primary);\n  color: var(--dsw-alias-label-on-primary, #fff);\n  font-weight: 600;\n}\n\n.mt-btn-primary:hover:not(:disabled) {\n  filter: brightness(1.1);\n}\n\n.mt-content {\n  margin: 0;\n  padding: 10px;\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n  border: 1px solid var(--dsw-alias-border-l3);\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n  font-size: 12px;\n  line-height: 1.6;\n  white-space: pre-wrap;\n  word-break: break-word;\n  max-height: 320px;\n  overflow-y: auto;\n}\n\n\n.mt-warning {\n  margin: 0;\n  font-size: 11px;\n  line-height: 1.5;\n  color: var(--dsw-alias-state-warn-primary);\n}\n\n/* ---- memory tab toolbar (view toggle + search) ---- */\n\n.mt-file-tabs {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 6px;\n  margin-bottom: 12px;\n}\n\n.mt-file-tab {\n  height: 28px;\n  padding: 0 14px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 999px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  font: inherit;\n  font-size: 12px;\n  cursor: pointer;\n  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;\n}\n\n.mt-file-tab:hover:not(.mt-file-tab-active) {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.mt-file-tab-active {\n  background: var(--dsw-alias-interactive-bg-active);\n  border-color: var(--dsw-alias-interactive-fg-default);\n  color: var(--dsw-alias-label-primary);\n  font-weight: 600;\n}\n\n/* Vertical divider between the feature tabs and the file tabs. */\n.mt-tab-sep {\n  flex: none;\n  align-self: center;\n  width: 1px;\n  height: 16px;\n  margin: 0 4px;\n  background: var(--dsw-alias-border-l3);\n}\n\n/* Pending-count badge inside a feature tab (e.g. \u5F85\u786E\u8BA4\u8BB0\u5FC6\u5EFA\u8BAE (2)). */\n.mt-feature-count {\n  display: inline-block;\n  min-width: 14px;\n  margin-left: 6px;\n  padding: 0 4px;\n  border-radius: 8px;\n  font-size: 10px;\n  line-height: 16px;\n  text-align: center;\n  font-weight: 700;\n  color: var(--dsw-alias-label-on-primary, #fff);\n  background: var(--dsw-alias-state-error-primary);\n}\n\n.mt-toolbar {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  flex-wrap: wrap;\n}\n\n/* Segmented \u7F8E\u89C2/\u7EAF\u6587\u672C toggle */\n.mt-view-toggle {\n  flex: none;\n  display: inline-flex;\n  padding: 2px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n}\n\n.mt-view-btn {\n  padding: 3px 12px;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  font: inherit;\n  font-size: 12px;\n  white-space: nowrap;\n  cursor: pointer;\n  transition: background-color 120ms ease, color 120ms ease;\n}\n\n.mt-view-btn:hover {\n  color: var(--dsw-alias-label-primary);\n}\n\n.mt-view-btn-active,\n.mt-view-btn-active:hover {\n  background: var(--dsw-alias-interactive-bg-active);\n  color: var(--dsw-alias-label-primary);\n  font-weight: 600;\n}\n\n.mt-view-btn:focus-visible,\n.mt-search:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary);\n  outline-offset: 1px;\n}\n\n.mt-search {\n  flex: 1;\n  min-width: 160px;\n  height: 28px;\n  box-sizing: border-box;\n  padding: 0 10px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 8px;\n  outline: none;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  transition: border-color 120ms ease;\n}\n\n.mt-search:hover {\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.mt-search::placeholder {\n  color: var(--dsw-alias-label-dimmed);\n}\n\n/* Search hit count badge in the card head */\n.mt-badge-count {\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n/* Friendly empty state (no search results) */\n.mt-empty {\n  margin: 0;\n  padding: 22px 12px;\n  border: 1px dashed var(--dsw-alias-border-l3);\n  border-radius: 10px;\n  font-size: 12px;\n  line-height: 1.5;\n  text-align: center;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n/* ---- pretty view: \xA7 entry cards ---- */\n\n.mt-entries {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  max-height: 320px;\n  overflow-y: auto;\n}\n\n.mt-entry {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding: 10px 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-base);\n  transition: border-color 120ms ease, background-color 120ms ease;\n}\n\n.mt-entry:hover {\n  border-color: var(--dsw-alias-border-l3);\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.mt-entry-head {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  min-width: 0;\n}\n\n.mt-entry-time {\n  flex: none;\n  padding: 1px 8px;\n  border-radius: 9px;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n  font-variant-numeric: tabular-nums;\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.mt-entry-tag {\n  flex: none;\n  max-width: 60%;\n  padding: 1px 8px;\n  border-radius: 9px;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n/* Per-entry action buttons (pretty view): right-aligned group. */\n.mt-entry-ops {\n  flex: none;\n  margin-left: auto;\n  display: flex;\n  align-items: center;\n  gap: 4px;\n}\n\n/* Neutral action (archive / promote back). */\n.mt-entry-op {\n  padding: 1px 8px;\n  font-size: 11px;\n  line-height: 16px;\n  border-color: transparent;\n  color: var(--dsw-alias-label-secondary);\n  opacity: 0.8;\n}\n\n.mt-entry-op:hover:not(:disabled) {\n  opacity: 1;\n  border-color: var(--dsw-alias-border-l3);\n  color: var(--dsw-alias-label-primary);\n}\n\n/* Per-entry delete button (pretty view): danger tint. */\n.mt-entry-del {\n  padding: 1px 8px;\n  font-size: 11px;\n  line-height: 16px;\n  border-color: transparent;\n  color: var(--dsw-alias-state-error-primary);\n  opacity: 0.7;\n}\n\n.mt-entry-del:hover:not(:disabled) {\n  opacity: 1;\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n  border-color: var(--dsw-alias-state-error-secondary);\n}\n\n.mt-entry-text {\n  margin: 0;\n  font-size: 12px;\n  line-height: 1.6;\n  white-space: pre-wrap;\n  word-break: break-word;\n  color: var(--dsw-alias-label-primary);\n}\n\n/* Entry list scrollbar (token-driven, fall back to border color) */\n.mt-entries::-webkit-scrollbar {\n  width: 8px;\n}\n\n.mt-entries::-webkit-scrollbar-thumb {\n  border-radius: 4px;\n  background: var(--dsw-alias-scrollbar-bg-l1, var(--dsw-alias-border-l3));\n}\n\n.mt-entries::-webkit-scrollbar-thumb:hover {\n  background: var(--dsw-alias-scrollbar-hover-l1, var(--dsw-alias-border-l4));\n}\n\n.mt-entries::-webkit-scrollbar-track {\n  background: transparent;\n}\n\n/* ---------- Todo sub-tab ---------- */\n\n.me-tabs {\n  flex: none;\n  display: flex;\n  flex-wrap: wrap;\n  gap: 6px;\n}\n\n.me-tab {\n  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  border-radius: 6px;\n  padding: 4px 12px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary);\n  background: transparent;\n  cursor: pointer;\n}\n\n.me-tab:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.me-tab-active {\n  color: var(--dsw-alias-label-primary);\n  border-color: var(--dsw-alias-brand-primary);\n  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);\n}\n\n.me-todo-add {\n  flex: none;\n  display: flex;\n  gap: 8px;\n  align-items: center;\n}\n\n.me-todo-input {\n  flex: 1;\n  min-width: 0;\n  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  border-radius: 6px;\n  padding: 6px 10px;\n  font-size: 12px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-todo-select,\n.me-todo-date,\n.me-todo-filters select {\n  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  border-radius: 6px;\n  padding: 5px 8px;\n  font-size: 12px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-todo-filters {\n  flex: none;\n  display: flex;\n  gap: 16px;\n  align-items: center;\n}\n\n.me-todo-filter {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.me-todo-item--done .me-todo-text {\n  opacity: 0.55;\n  text-decoration: line-through;\n}\n\n.me-todo-text {\n  margin: 4px 0 0;\n  font-size: 13px;\n  line-height: 1.5;\n  white-space: pre-wrap;\n  word-break: break-word;\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-todo-edit {\n  margin-top: 6px;\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n}\n\n.me-todo-edit-row {\n  display: flex;\n  gap: 8px;\n  align-items: center;\n  flex-wrap: wrap;\n}\n\n.me-todo-edit-row select,\n.me-todo-edit-row input {\n  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n  border-radius: 6px;\n  padding: 4px 8px;\n  font-size: 12px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-badge-quad {\n  border: 1px solid transparent;\n}\n\n.me-badge-quad-q1 {\n  color: var(--dsw-static-red-5, #e5484d);\n  background: color-mix(in srgb, var(--dsw-static-red-5, #e5484d) 14%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-red-5, #e5484d) 40%, transparent);\n}\n\n.me-badge-quad-q2 {\n  color: var(--dsw-static-blue-5, #3b82f6);\n  background: color-mix(in srgb, var(--dsw-static-blue-5, #3b82f6) 14%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-blue-5, #3b82f6) 40%, transparent);\n}\n\n.me-badge-quad-q3 {\n  color: var(--dsw-static-amber-5, #f59e0b);\n  background: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 14%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 40%, transparent);\n}\n\n.me-badge-quad-q4 {\n  color: var(--dsw-static-neutral-5, #8b8d98);\n  background: color-mix(in srgb, var(--dsw-static-neutral-5, #8b8d98) 14%, transparent);\n  border-color: color-mix(in srgb, var(--dsw-static-neutral-5, #8b8d98) 40%, transparent);\n}\n\n.me-badge-quad-none {\n  color: var(--dsw-alias-label-tertiary);\n  background: transparent;\n  border-color: var(--dsw-alias-border-l, rgba(128, 128, 128, 0.3));\n}\n\n.me-badge-overdue {\n  color: var(--dsw-static-red-5, #e5484d);\n  background: color-mix(in srgb, var(--dsw-static-red-5, #e5484d) 12%, transparent);\n}\n\n.me-badge-due {\n  color: var(--dsw-static-amber-5, #f59e0b);\n  background: color-mix(in srgb, var(--dsw-static-amber-5, #f59e0b) 12%, transparent);\n}\n\n.me-todo-help {\n  font-size: 11px;\n  line-height: 1.6;\n  color: var(--dsw-alias-label-dimmed);\n  margin: 0;\n}\n";

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
  "memoryTab.feature.suggestions": "\u5F85\u786E\u8BA4\u8BB0\u5FC6\u5EFA\u8BAE",
  "memoryTab.feature.skills": "\u5F85\u786E\u8BA4\u6280\u80FD\u5EFA\u8BAE",
  "memoryTab.feature.config": "\u8FD0\u884C\u65F6\u914D\u7F6E",
  "memoryTab.feature.skillBrowser": "\u6280\u80FD\u7BA1\u7406",
  "memoryTab.feature.todo": "\u5F85\u529E",
  "todo.track.life": "\u751F\u6D3B",
  "todo.track.all": "\u5168\u90E8",
  "todo.track": "\u5F85\u529E\u8F68",
  "todo.track.work": "\u5DE5\u4F5C",
  "todo.track.project": "\u672C\u9879\u76EE",
  "todo.track.daily": "\u6BCF\u65E5",
  "todo.projectHint": "\u5F53\u524D\u4F1A\u8BDD\u65E0\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u9879\u76EE\u5F85\u529E\u4E0D\u53EF\u7528\uFF08\u53EA\u6709 \u751F\u6D3B/\u5DE5\u4F5C/\u6BCF\u65E5\uFF09\u3002",
  "todo.help": "\u56DB\u8F68\u5F85\u529E\uFF1A\u751F\u6D3B=\u4E2A\u4EBA\u7410\u4E8B\uFF1B\u5DE5\u4F5C=\u8DE8\u9879\u76EE\u7684\u6B63\u4E8B\uFF1B\u672C\u9879\u76EE=\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u7684\u5F85\u529E\uFF08\u6362\u4E2A\u76EE\u5F55\u770B\u4E0D\u5230\uFF09\uFF1B\u6BCF\u65E5=\u4ECA\u5929\u8981\u505A\u7684\uFF08\u6309\u5929\u5206\u6587\u4EF6\uFF09\u3002\u6DFB\u52A0\uFF1A\u8F93\u5165\u5185\u5BB9\uFF0C\u53EF\u9009\u56DB\u8C61\u9650\uFF08\u91CD\u8981\xD7\u7D27\u6025\uFF09\u4E0E\u622A\u6B62\u65E5\u671F\uFF0C\u70B9\u300C\u6DFB\u52A0\u300D\uFF1B\u6216\u76F4\u63A5\u5BF9\u6211\u8BF4\u201C\u5E2E\u6211\u52A0\u4E2A\u5F85\u529E\uFF0C\u662F\u5DE5\u4F5C\u4E0A\u7684/\u751F\u6D3B\u4E2D\u7684/\u8FD9\u4E2A\u9879\u76EE\u7684/\u4ECA\u5929\u8981\u7684\u201D\u2014\u2014\u6211\u4F1A\u6309\u7C7B\u522B\u5199\u5165\u5BF9\u5E94\u8F68\u3002",
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
  "panel.suggestions.approve": "\u91C7\u7EB3",
  "panel.suggestions.archive": "\u5F52\u6863",
  "panel.suggestions.archiveHint": "\u5F52\u6863\uFF1A\u4E0D\u6CE8\u5165\u4F1A\u8BDD\uFF0C\u4EC5\u4FDD\u7559\u5907\u67E5\uFF0C\u9700\u8981\u65F6\u53EF\u79FB\u56DE\u4E3B\u8BB0\u5FC6",
  "panel.suggestions.editHint": "\u91C7\u7EB3\u524D\u53EF\u4FEE\u6539\u6587\u672C\uFF0C\u4FEE\u6539\u540E\u7684\u5185\u5BB9\u5C06\u5199\u5165\u8BB0\u5FC6\u3002",
  "panel.suggestions.reject": "\u62D2\u7EDD",
  "panel.suggestions.approveAll": "\u5168\u90E8\u91C7\u7EB3",
  "panel.suggestions.rejectAll": "\u5168\u90E8\u62D2\u7EDD",
  "panel.suggestions.hits": "\u5DF2\u5EFA\u8BAE {count} \u6B21",
  "panel.suggestions.hitsHint": "\u8BE5\u5185\u5BB9\u5728\u591A\u8F6E\u5BA1\u67E5\u4E2D\u53CD\u590D\u51FA\u73B0\uFF0C\u503C\u5F97\u8BA4\u771F\u786E\u8BA4",
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
  "memoryTab.feature.suggestions": "Memory suggestions",
  "memoryTab.feature.skills": "Skill suggestions",
  "memoryTab.feature.config": "Runtime config",
  "memoryTab.feature.skillBrowser": "Skill manager",
  "memoryTab.feature.todo": "Todos",
  "todo.track.life": "Life",
  "todo.track.all": "All",
  "todo.track": "Track",
  "todo.track.work": "Work",
  "todo.track.project": "This project",
  "todo.track.daily": "Daily",
  "todo.projectHint": "No working directory for this session \u2014 project todos unavailable (life/work/daily only).",
  "todo.help": "Four tracks: Life=personal errands; Work=cross-project tasks; This project=the current working directory's todos (invisible from other dirs); Daily=today's tasks (one file per day). To add: type content, optionally pick a quadrant (important \xD7 urgent) and a due date, then hit Add \u2014 or just tell me \u201Cadd a todo, it's for work/life/this project/today\u201D and I will file it in the right track.",
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
  "panel.suggestions.approve": "Approve",
  "panel.suggestions.archive": "Archive",
  "panel.suggestions.archiveHint": "Archive: kept out of the injected memory, can be promoted back later",
  "panel.suggestions.editHint": "You may edit the text before approving; the edited text is what gets written.",
  "panel.suggestions.reject": "Reject",
  "panel.suggestions.approveAll": "Approve all",
  "panel.suggestions.rejectAll": "Reject all",
  "panel.suggestions.hits": "Suggested {count}\xD7",
  "panel.suggestions.hitsHint": "This fact resurfaced across several reviews \u2014 worth a careful look",
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
  const t = ctx.locale.bind(NS);
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
  let tabCancelled = false;
  let badgeCount = 0;
  let deferral = null;
  const pollBadge = () => {
    if (tabCancelled || deferral === null) return;
    void fetch("/memory-evolve/api/badge").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((data) => {
      const count = data.count ?? 0;
      if (count !== badgeCount) {
        badgeCount = count;
        deferral?.refresh();
      }
    }).catch(() => {
    });
  };
  void fetch("/memory-evolve/api/config").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((data) => {
    if (tabCancelled || data.config?.memoryTabEnabled !== true) return;
    deferral = (0, import_dsh_client_ui_slots.deferRegistration)(ctx.slots, "conversation.view", MemoryTabView, () => ctx.slots.register({
      name: "conversation.view",
      id: "memory-files",
      order: 20,
      label: () => badgeCount > 0 ? t("memoryTab.label.pending", { count: badgeCount }) : t("memoryTab.label")
    }, (props) => MemoryTabView({ ...props, t })));
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
    deferral?.dispose();
  }, "memory-evolve: memory tab");
}
return module.exports; } });
