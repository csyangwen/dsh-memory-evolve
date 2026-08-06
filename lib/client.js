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

// src/client/MemoryPanel.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
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
function MemoryPanel(props) {
  const { t, refresh } = props;
  const [entries, setEntries] = (0, import_react.useState)(null);
  const [skills, setSkills] = (0, import_react.useState)(null);
  const [edits, setEdits] = (0, import_react.useState)({});
  const [config, setConfig] = (0, import_react.useState)(null);
  const [draft, setDraft] = (0, import_react.useState)(null);
  const [notice, setNotice] = (0, import_react.useState)(null);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const load = () => {
    void Promise.all([
      api("/api/suggestions"),
      api("/api/pending-skills"),
      api("/api/config")
    ]).then(([s, sk, c]) => {
      const entries2 = [...s.entries].sort((a, b) => (b.hits ?? 1) - (a.hits ?? 1));
      setEntries(entries2);
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
      refresh();
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
      refresh();
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
      autoApproveGlobal: draft.autoApproveGlobal,
      memoryTabEnabled: draft.memoryTabEnabled,
      perTurnProjectWrites: draft.perTurnProjectWrites,
      perTurnDailyWrites: draft.perTurnDailyWrites
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
  const revealTargets = [
    ["memoryDir", t("panel.reveal.memoryDir")],
    ["memoryFile", t("panel.reveal.memoryFile")],
    ["userFile", t("panel.reveal.userFile")],
    ["dailyFile", t("panel.reveal.dailyFile")],
    ["dailyDir", t("panel.reveal.dailyDir")],
    ["projectsDir", t("panel.reveal.projectsDir")],
    ["skillDir", t("panel.reveal.skillDir")],
    ["agentsFile", t("panel.reveal.agentsFile")]
  ];
  const reveal = (target) => {
    void api("/api/reveal", { method: "POST", body: JSON.stringify({ target }) }).catch((error) => {
      setNotice({ kind: "error", text: t("panel.config.failed", { message: error.message }) });
    });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-panel", children: [
    notice !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: `me-notice me-notice-${notice.kind}`, children: notice.text }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "me-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-block-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "me-heading", children: t("panel.suggestions.title") }),
        entries !== null && entries.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-count", children: entries.length })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-help", children: t("panel.suggestions.help") }),
      entries === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-muted", children: t("panel.loading") }) : entries.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-empty", children: t("panel.suggestions.empty") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "me-list", children: entries.map((entry, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: "me-item", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-item-head", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-badge me-badge-target", children: entry.target }),
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
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "me-block", children: [
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
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "me-block", children: [
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
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-group", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
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
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t("panel.config.autoApproveGlobal"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t("panel.config.autoApproveGlobal.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                className: "me-switch",
                checked: draft.autoApproveGlobal,
                onChange: (event) => patchDraft({ autoApproveGlobal: event.target.checked })
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
              t("panel.config.memoryTabEnabled"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t("panel.config.memoryTabEnabled.hint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                className: "me-switch",
                checked: draft.memoryTabEnabled,
                onChange: (event) => patchDraft({ memoryTabEnabled: event.target.checked })
              }
            )
          ] })
        ] }),
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
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "me-actions", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "me-btn me-btn-primary", disabled: busy, onClick: saveConfig, children: t("panel.config.save") }) })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "me-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "me-block-head", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "me-heading", children: t("panel.reveal.title") }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-help", children: t("panel.reveal.help") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "me-reveal-grid", children: revealTargets.map(([target, label]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "me-btn me-btn-reveal", onClick: () => reveal(target), children: label }, target)) })
    ] })
  ] });
}

// src/client/MemoryTabView.tsx
var import_react2 = require("react");
var import_jsx_runtime2 = require("react/jsx-runtime");
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
function MemoryTabView(props) {
  const { sessionId, t } = props;
  const [files, setFiles] = (0, import_react2.useState)(null);
  const [notice, setNotice] = (0, import_react2.useState)(null);
  const [cwd, setCwd] = (0, import_react2.useState)(null);
  const load = (0, import_react2.useCallback)(() => {
    setFiles(null);
    void api2(
      `/api/memory-files?sessionId=${encodeURIComponent(String(sessionId))}`
    ).then((res) => {
      setFiles(res.files);
      setCwd(res.cwd);
    }).catch((error) => {
      setNotice({ kind: "error", text: error.message });
      setFiles([]);
    });
  }, [sessionId]);
  (0, import_react2.useEffect)(() => {
    load();
  }, []);
  const flash = (text) => {
    setNotice({ kind: "ok", text });
    window.setTimeout(() => {
      setNotice((current) => current?.text === text ? null : current);
    }, 3500);
  };
  const openWithSystem = (row) => {
    const target = row.key === "memory" ? "memoryFile" : row.key === "user" ? "userFile" : row.key === "daily" ? "dailyFile" : row.key === "project" ? "projectsDir" : "agentsFile";
    void api2("/api/reveal", { method: "POST", body: JSON.stringify({ target }) }).then(() => flash(t("memoryTab.opened"))).catch((error) => setNotice({ kind: "error", text: error.message }));
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "mt-panel", children: [
    notice !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: `mt-notice mt-notice-${notice.kind}`, children: notice.text }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("p", { className: "mt-warning", children: [
      "\u26A0\uFE0F ",
      t("memoryTab.warning")
    ] }),
    cwd !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("p", { className: "mt-cwd", children: [
      t("memoryTab.cwd"),
      ": ",
      cwd
    ] }),
    files === null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "mt-muted", children: t("memoryTab.loading") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "mt-list", children: files.map((row) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "mt-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "mt-card-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "mt-card-title", children: row.title }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "mt-badge mt-badge-ro", children: t("memoryTab.readonly") }),
        row.path !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "mt-card-path", title: row.path, children: row.path }),
        row.available && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "mt-card-actions", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "mt-btn", onClick: () => openWithSystem(row), children: t("memoryTab.open") }) })
      ] }),
      !row.available ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "mt-muted", children: t("memoryTab.noCwd") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("pre", { className: "mt-content", children: row.exists ? row.content : t("memoryTab.empty") }),
      row.truncated && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "mt-muted", children: t("memoryTab.truncated") })
    ] }, row.key)) })
  ] });
}

// src/client/styles.css
var styles_default = "/**\n * dsh-memory-evolve panel styles \u2014 DSH design tokens, `me-` prefix.\n * Colors come exclusively from --dsw-alias-* / --dsw-static-* tokens so the\n * panel follows the light/dark theme automatically (no hardcoded colors).\n */\n\n/* ---------- Root ---------- */\n\n.me-panel {\n  height: 100%;\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: column;\n  gap: 20px;\n  overflow-y: auto;\n  padding: 4px 2px 28px;\n  font-family: var(--dsw-font-family, inherit);\n  color: var(--dsw-alias-label-primary);\n}\n\n/* ---------- Notice bar (success / error) ---------- */\n\n.me-notice {\n  flex: none;\n  display: flex;\n  align-items: flex-start;\n  gap: 8px;\n  padding: 8px 12px;\n  border-radius: 8px;\n  font-size: 12px;\n  line-height: 1.5;\n}\n\n.me-notice::before {\n  content: '';\n  flex: none;\n  width: 6px;\n  height: 6px;\n  margin-top: 6px;\n  border-radius: 50%;\n}\n\n.me-notice-ok {\n  color: var(--dsw-alias-state-success-primary);\n  background: var(--dsw-alias-state-success-tertiary);\n  border: 1px solid var(--dsw-alias-state-success-primary);\n}\n.me-notice-ok::before {\n  background: var(--dsw-alias-state-success-primary);\n}\n\n.me-notice-error {\n  color: var(--dsw-alias-state-error-primary);\n  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);\n  border: 1px solid var(--dsw-alias-state-error-secondary);\n}\n.me-notice-error::before {\n  background: var(--dsw-alias-state-error-primary);\n}\n\n/* ---------- Section cards ---------- */\n\n.me-block {\n  flex: none;\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  padding: 14px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  background: var(--dsw-alias-bg-layer-1);\n}\n\n.me-block-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n\n.me-heading {\n  margin: 0;\n  font-size: 13px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary);\n}\n\n.me-count {\n  flex: none;\n  min-width: 18px;\n  box-sizing: border-box;\n  padding: 1px 6px;\n  border-radius: 9px;\n  font-size: 11px;\n  line-height: 16px;\n  text-align: center;\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n.me-help {\n  margin: -4px 0 0;\n  font-size: 12px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.me-muted {\n  margin: 0;\n  padding: 8px 0;\n  font-size: 12px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n/* Friendly empty state */\n.me-empty {\n  margin: 0;\n  padding: 22px 12px;\n  border: 1px dashed var(--dsw-alias-border-l3);\n  border-radius: 10px;\n  font-size: 12px;\n  line-height: 1.5;\n  text-align: center;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n/* ---------- Suggestion list (own scroll area) ---------- */\n\n.me-list {\n  margin: 0;\n  padding: 0 2px 0 0;\n  list-style: none;\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  max-height: 380px;\n  overflow-y: auto;\n}\n\n.me-item {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  padding: 10px 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-base);\n  transition: border-color 120ms ease;\n}\n\n.me-item:hover {\n  border-color: var(--dsw-alias-border-l3);\n}\n\n.me-item-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n}\n\n.me-badge {\n  flex: none;\n  max-width: 45%;\n  padding: 1px 8px;\n  border-radius: 9px;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n.me-badge-hits {\n  color: var(--dsw-alias-state-warn-primary);\n  background: var(--dsw-alias-state-warn-tertiary);\n}\n\n.me-item-time {\n  flex: 1;\n  min-width: 0;\n  font-size: 11px;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.me-item-actions {\n  flex: none;\n  display: flex;\n  gap: 6px;\n}\n\n.me-item-edit {\n  width: 100%;\n  box-sizing: border-box;\n  padding: 8px 10px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  outline: none;\n  background: var(--dsw-alias-bg-layer-1);\n  color: var(--dsw-alias-label-primary);\n  font-family: var(--dsw-font-family, inherit);\n  font-size: 12px;\n  line-height: 1.6;\n  resize: vertical;\n  transition: border-color 120ms ease, background-color 120ms ease;\n}\n\n.me-item-edit:hover {\n  border-color: var(--dsw-alias-border-l3);\n}\n\n.me-item-edit:focus-visible {\n  border-color: var(--dsw-alias-state-business-primary);\n}\n\n.me-item-reason {\n  margin: 0;\n  padding-left: 8px;\n  border-left: 2px solid var(--dsw-alias-border-l3);\n  font-size: 11px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n/* Bulk actions: separated from the list by a hairline */\n.me-bulk {\n  display: flex;\n  gap: 8px;\n  padding-top: 10px;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n}\n\n/* ---------- Buttons ---------- */\n\n.me-btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  height: 26px;\n  padding: 0 10px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  white-space: nowrap;\n  cursor: pointer;\n  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;\n}\n\n.me-btn:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.me-btn:active:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.me-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n.me-btn-ok {\n  color: var(--dsw-alias-state-success-primary);\n  border-color: var(--dsw-alias-state-success-primary);\n}\n.me-btn-ok:hover:not(:disabled) {\n  background: var(--dsw-alias-state-success-tertiary);\n}\n\n.me-btn-danger {\n  color: var(--dsw-alias-state-error-primary);\n}\n.me-btn-danger:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n  border-color: var(--dsw-alias-state-error-secondary);\n}\n\n.me-btn-primary {\n  border-color: transparent;\n  background: var(--dsw-alias-button-primary-fill);\n  color: var(--dsw-alias-label-primary-inverted);\n  font-weight: 600;\n}\n.me-btn-primary:hover:not(:disabled) {\n  background: var(--dsw-alias-button-primary-hover);\n}\n.me-btn-primary:disabled {\n  background: var(--dsw-alias-button-primary-dimmed);\n}\n\n.me-btn:focus-visible,\n.me-switch:focus-visible,\n.me-input:focus-visible,\n.me-select:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary);\n  outline-offset: 1px;\n}\n\n/* ---------- Config form ---------- */\n\n.me-form {\n  display: flex;\n  flex-direction: column;\n}\n\n/* Visual grouping: value rows vs. toggle rows, hairline between groups */\n.me-group {\n  display: flex;\n  flex-direction: column;\n}\n.me-group + .me-group {\n  margin-top: 8px;\n  padding-top: 4px;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n}\n\n.me-field {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  padding: 7px 2px;\n  font-size: 13px;\n  color: var(--dsw-alias-label-primary);\n  cursor: pointer;\n}\n\n.me-field-label {\n  flex: 1;\n  min-width: 0;\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.me-field-hint {\n  font-style: normal;\n  font-size: 11px;\n  line-height: 1.4;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n/* Toggle switch (accent when on) */\n.me-switch {\n  appearance: none;\n  flex: none;\n  position: relative;\n  width: 36px;\n  height: 20px;\n  margin: 0;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 10px;\n  background: var(--dsw-alias-interactive-bg-active);\n  cursor: pointer;\n  transition: background-color 150ms ease, border-color 150ms ease;\n}\n\n.me-switch::after {\n  content: '';\n  position: absolute;\n  top: 2px;\n  left: 2px;\n  width: 14px;\n  height: 14px;\n  border-radius: 50%;\n  background: var(--dsw-static-neutral-00);\n  transition: transform 150ms ease;\n}\n\n.me-switch:hover {\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.me-switch:checked {\n  border-color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-primary);\n}\n\n.me-switch:checked::after {\n  transform: translateX(16px);\n}\n\n/* Number / select inputs, right-aligned and uniform width */\n.me-input,\n.me-select {\n  flex: none;\n  width: 120px;\n  height: 28px;\n  box-sizing: border-box;\n  padding: 0 8px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  border-radius: 6px;\n  outline: none;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  transition: border-color 120ms ease;\n}\n\n.me-input:hover,\n.me-select:hover {\n  border-color: var(--dsw-alias-border-l4);\n}\n\n.me-select {\n  cursor: pointer;\n}\n\n.me-actions {\n  display: flex;\n  justify-content: flex-end;\n  gap: 8px;\n  margin-top: 8px;\n  padding-top: 12px;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n}\n\n/* ---------- Open-files button grid ---------- */\n\n.me-reveal-grid {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));\n  gap: 8px;\n}\n\n.me-btn-reveal {\n  justify-content: flex-start;\n  height: 30px;\n  padding: 0 10px;\n  color: var(--dsw-alias-label-secondary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.me-btn-reveal:hover:not(:disabled) {\n  color: var(--dsw-alias-label-primary);\n  border-color: var(--dsw-alias-state-business-primary);\n}\n\n/* ---------- Scrollbars (token-driven, fall back to border color) ---------- */\n\n.me-panel::-webkit-scrollbar,\n.me-list::-webkit-scrollbar {\n  width: 8px;\n}\n\n.me-panel::-webkit-scrollbar-thumb,\n.me-list::-webkit-scrollbar-thumb {\n  border-radius: 4px;\n  background: var(--dsw-alias-scrollbar-bg-l1, var(--dsw-alias-border-l3));\n}\n\n.me-panel::-webkit-scrollbar-thumb:hover,\n.me-list::-webkit-scrollbar-thumb:hover {\n  background: var(--dsw-alias-scrollbar-hover-l1, var(--dsw-alias-border-l4));\n}\n\n.me-panel::-webkit-scrollbar-track,\n.me-list::-webkit-scrollbar-track {\n  background: transparent;\n}\n\n/* ---- memory tab (conversation.view) ---- */\n.mt-panel {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n  padding: 16px;\n  overflow-y: auto;\n  height: 100%;\n  box-sizing: border-box;\n}\n\n.mt-notice {\n  padding: 8px 12px;\n  border-radius: 8px;\n  font-size: 12px;\n  line-height: 1.5;\n}\n\n.mt-notice-ok {\n  color: var(--dsw-alias-state-success-primary);\n  background: var(--dsw-alias-state-success-tertiary);\n}\n\n.mt-notice-error {\n  color: var(--dsw-alias-state-error-primary);\n  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);\n  border: 1px solid var(--dsw-alias-state-error-secondary);\n}\n\n.mt-cwd {\n  margin: 0;\n  font-size: 11px;\n  color: var(--dsw-alias-label-dimmed);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.mt-muted {\n  margin: 0;\n  font-size: 12px;\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.mt-list {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n}\n\n.mt-card {\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  padding: 12px;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  background: var(--dsw-alias-bg-layer-1);\n}\n\n.mt-card-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n}\n\n.mt-card-title {\n  flex: none;\n  font-size: 13px;\n  font-weight: 600;\n}\n\n.mt-badge {\n  flex: none;\n  padding: 1px 8px;\n  border-radius: 9px;\n  font-size: 10px;\n  line-height: 16px;\n  font-weight: 600;\n}\n\n.mt-badge-ro {\n  color: var(--dsw-alias-label-dimmed);\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n.mt-card-path {\n  flex: 1;\n  min-width: 0;\n  font-size: 11px;\n  color: var(--dsw-alias-label-dimmed);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  direction: rtl;\n  text-align: left;\n}\n\n.mt-card-actions {\n  flex: none;\n}\n\n.mt-btn {\n  padding: 3px 10px;\n  border-radius: 6px;\n  border: 1px solid var(--dsw-alias-border-l3);\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font-size: 12px;\n  cursor: pointer;\n}\n\n.mt-btn:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n.mt-content {\n  margin: 0;\n  padding: 10px;\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n  border: 1px solid var(--dsw-alias-border-l3);\n  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n  font-size: 12px;\n  line-height: 1.6;\n  white-space: pre-wrap;\n  word-break: break-word;\n  max-height: 320px;\n  overflow-y: auto;\n}\n\n\n.mt-warning {\n  margin: 0;\n  font-size: 11px;\n  line-height: 1.5;\n  color: var(--dsw-alias-state-warn-primary);\n}\n";

// src/client/index.ts
var NS = "memory-evolve";
var zh = {
  "tab.label": "\u8BB0\u5FC6\u7BA1\u7406",
  "tab.label.count": "\u8BB0\u5FC6\u7BA1\u7406 ({count})",
  "memoryTab.label": "\u8BB0\u5FC6",
  "memoryTab.cwd": "\u5F53\u524D\u4F1A\u8BDD\u5DE5\u4F5C\u76EE\u5F55",
  "memoryTab.loading": "\u52A0\u8F7D\u4E2D\u2026",
  "memoryTab.warning": "\u4EE5\u4E0B\u6587\u4EF6\u4E3A \xA7 \u5206\u9694\u7684\u7ED3\u6784\u5316\u8BB0\u5FC6\uFF0C\u7528\u7CFB\u7EDF\u5DE5\u5177\u6253\u5F00\u540E\u8BF7\u8C28\u614E\u7F16\u8F91\uFF0C\u968F\u610F\u4FEE\u6539\u53EF\u80FD\u7834\u574F\u683C\u5F0F\u3001\u5BFC\u81F4\u8BB0\u5FC6\u8BFB\u53D6\u9519\u4E71\u3002",
  "memoryTab.readonly": "\u53EA\u8BFB",
  "memoryTab.open": "\u6253\u5F00\u6587\u4EF6",
  "memoryTab.opened": "\u5DF2\u7528\u7CFB\u7EDF\u5DE5\u5177\u6253\u5F00",
  "memoryTab.empty": "\uFF08\u6587\u4EF6\u4E0D\u5B58\u5728\u6216\u4E3A\u7A7A\uFF09",
  "memoryTab.noCwd": "\uFF08\u5F53\u524D\u4F1A\u8BDD\u65E0\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u65E0\u6CD5\u5B9A\u4F4D\u9879\u76EE\u8BB0\u5FC6\uFF09",
  "memoryTab.truncated": "\uFF08\u5185\u5BB9\u8FC7\u957F\uFF0C\u5DF2\u622A\u65AD\u663E\u793A\uFF09",
  "panel.suggestions.title": "\u5F85\u786E\u8BA4\u8BB0\u5FC6\u5EFA\u8BAE",
  "panel.suggestions.empty": "\u6CA1\u6709\u5F85\u786E\u8BA4\u7684\u5EFA\u8BAE\u3002",
  "panel.suggestions.help": "\u540E\u53F0\u5BA1\u67E5\u4EA7\u51FA\u7684\u5168\u5C40\u8BB0\u5FC6\u5EFA\u8BAE\uFF0C\u91C7\u7EB3\u540E\u5199\u5165\u8BB0\u5FC6\u6587\u4EF6\u5E76\u968F\u5FEB\u7167\u6CE8\u5165\u3002",
  "panel.suggestions.approve": "\u91C7\u7EB3",
  "panel.suggestions.editHint": "\u91C7\u7EB3\u524D\u53EF\u4FEE\u6539\u6587\u672C\uFF0C\u4FEE\u6539\u540E\u7684\u5185\u5BB9\u5C06\u5199\u5165\u8BB0\u5FC6\u3002",
  "panel.suggestions.reject": "\u62D2\u7EDD",
  "panel.suggestions.approveAll": "\u5168\u90E8\u91C7\u7EB3",
  "panel.suggestions.rejectAll": "\u5168\u90E8\u62D2\u7EDD",
  "panel.suggestions.hits": "\u5DF2\u5EFA\u8BAE {count} \u6B21",
  "panel.suggestions.hitsHint": "\u8BE5\u5185\u5BB9\u5728\u591A\u8F6E\u5BA1\u67E5\u4E2D\u53CD\u590D\u51FA\u73B0\uFF0C\u503C\u5F97\u8BA4\u771F\u786E\u8BA4",
  "panel.suggestions.done": "\u64CD\u4F5C\u5B8C\u6210\uFF1A{text}",
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
  "panel.config.autoApproveGlobal": "\u5168\u5C40\u8BB0\u5FC6\u81EA\u52A8\u6C89\u6DC0",
  "panel.config.autoApproveGlobal.hint": "\u5F00\u542F\u540E\uFF0C\u5BA1\u67E5\u53D1\u73B0\u503C\u5F97\u8BB0\u4F4F\u7684\u5168\u5C40\u4E8B\u5B9E\uFF08\u7528\u6237\u6863\u6848/\u5168\u5C40\u8BB0\u5FC6\uFF09\u4F1A\u76F4\u63A5\u5199\u5165\uFF0C\u4E0D\u518D\u9700\u8981\u9010\u6761\u786E\u8BA4\uFF08\u6CE8\u610F\u63D0\u793A\u6CE8\u5165\u98CE\u9669\uFF09",
  "panel.config.skillReviewEnabled": "\u6280\u80FD\u81EA\u52A8\u6C89\u6DC0",
  "panel.config.skillReviewEnabled.hint": "\u5173\uFF08\u9ED8\u8BA4\uFF09\uFF1A\u5BA1\u67E5\u521B\u5EFA\u7684\u65B0\u6280\u80FD\u8FDB\u5165\u5F85\u786E\u8BA4\u961F\u5217\uFF0C\u91C7\u7EB3\u540E\u624D\u8FDB\u5165\u6280\u80FD\u5E93\uFF1B\u5F00\uFF1A\u5BA1\u67E5\u76F4\u63A5\u521B\u5EFA\u6280\u80FD\uFF0C\u65E0\u9700\u786E\u8BA4\uFF08\u6280\u80FD\u6CE8\u5165\u6240\u6709\u4F1A\u8BDD\uFF0C\u8BF7\u8C28\u614E\u5F00\u542F\uFF09",
  "panel.config.memoryTabEnabled": "\u4F1A\u8BDD\u9875\u8BB0\u5FC6 Tab",
  "panel.config.memoryTabEnabled.hint": "\u5728\u4F1A\u8BDD\u9875\u9876\u90E8\u663E\u793A\u300C\u8BB0\u5FC6\u300DTab\uFF08\u5C55\u793A AGENTS.md \u4E0E\u56DB\u8F68\u8BB0\u5FC6\u6587\u4EF6\uFF0C\u5168\u90E8\u53EA\u8BFB\uFF09\uFF1B\u9ED8\u8BA4\u5173\u95ED\uFF0C\u5F00\u542F\u540E\u9700\u5237\u65B0\u9875\u9762\u751F\u6548",
  "panel.config.perTurnProjectWrites": "\u6BCF\u56DE\u5408\u5199\u5165\u9879\u76EE\u8BB0\u5FC6",
  "panel.config.perTurnProjectWrites.hint": "\u8981\u6C42\u6A21\u578B\u6BCF\u4E2A\u56DE\u5408\u7ED3\u675F\u524D\u4E3B\u52A8\u68C0\u67E5\u5E76\u8BB0\u5F55\u9879\u76EE\u76F8\u5173\u65B0\u4E8B\u5B9E\uFF08\u5173\u952E\u51B3\u7B56/\u8FDB\u5C55/\u8E29\u5751\uFF09\uFF1B\u5173\u95ED\u540E\u9879\u76EE\u8BB0\u5FC6\u4EC5\u6309\u9700\u8BFB\u53D6\u3002\u26A0\uFE0F \u4F9D\u8D56 LLM \u6307\u4EE4\u9075\u5FAA\uFF0C\u5F31\u9075\u5FAA\u7684\u6A21\u578B\u4E0D\u4E00\u5B9A\u4F1A\u6267\u884C",
  "panel.config.perTurnDailyWrites": "\u6BCF\u56DE\u5408\u5199\u5165\u6BCF\u65E5\u65E5\u5FD7",
  "panel.config.perTurnDailyWrites.hint": "\u8981\u6C42\u6A21\u578B\u6BCF\u4E2A\u56DE\u5408\u7ED3\u675F\u524D\u4E3B\u52A8\u68C0\u67E5\u5E76\u8BB0\u5F55\u5F53\u5929\u8FDB\u5C55\uFF1B\u5173\u95ED\u540E\u6BCF\u65E5\u65E5\u5FD7\u4EC5\u6309\u9700\u8BFB\u53D6\u3002\u26A0\uFE0F \u4F9D\u8D56 LLM \u6307\u4EE4\u9075\u5FAA\uFF0C\u5F31\u9075\u5FAA\u7684\u6A21\u578B\u4E0D\u4E00\u5B9A\u4F1A\u6267\u884C",
  "panel.config.save": "\u4FDD\u5B58\u914D\u7F6E",
  "panel.reveal.title": "\u6253\u5F00\u6587\u4EF6",
  "panel.reveal.help": "\u7528\u7CFB\u7EDF\u5DE5\u5177\u6253\u5F00\u8BB0\u5FC6\u76EE\u5F55\u4E0E\u8BB0\u5FC6\u6587\u4EF6\u3002\u26A0\uFE0F \u968F\u610F\u7F16\u8F91\u53EF\u80FD\u7834\u574F \xA7 \u5206\u9694\u683C\u5F0F\u3001\u5BFC\u81F4\u8BB0\u5FC6\u8BFB\u53D6\u9519\u4E71\uFF0C\u8BF7\u8C28\u614E\u4FEE\u6539\u3002",
  "panel.reveal.memoryDir": "\u8BB0\u5FC6\u76EE\u5F55",
  "panel.reveal.memoryFile": "\u5168\u5C40\u8BB0\u5FC6",
  "panel.reveal.userFile": "\u7528\u6237\u6863\u6848",
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
  "tab.label": "Memory",
  "tab.label.count": "Memory ({count})",
  "memoryTab.label": "Memory",
  "memoryTab.cwd": "Session working directory",
  "memoryTab.loading": "Loading\u2026",
  "memoryTab.warning": "These files are \xA7-delimited structured memory. If you open them with a system tool, edit with caution \u2014 careless changes can break the format and corrupt memory reads.",
  "memoryTab.readonly": "Read-only",
  "memoryTab.open": "Open file",
  "memoryTab.opened": "Opened with the system tool",
  "memoryTab.empty": "(missing or empty)",
  "memoryTab.noCwd": "(no working directory for this session \u2014 project memory unavailable)",
  "memoryTab.truncated": "(content truncated for display)",
  "panel.suggestions.title": "Pending memory suggestions",
  "panel.suggestions.empty": "No pending suggestions.",
  "panel.suggestions.help": "Global-track suggestions produced by the background review. Approving writes them into the memory files, injected with the snapshot.",
  "panel.suggestions.approve": "Approve",
  "panel.suggestions.editHint": "You may edit the text before approving; the edited text is what gets written.",
  "panel.suggestions.reject": "Reject",
  "panel.suggestions.approveAll": "Approve all",
  "panel.suggestions.rejectAll": "Reject all",
  "panel.suggestions.hits": "Suggested {count}\xD7",
  "panel.suggestions.hitsHint": "This fact resurfaced across several reviews \u2014 worth a careful look",
  "panel.suggestions.done": "Done: {text}",
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
  "panel.config.autoApproveGlobal": "Auto-harvest global memory",
  "panel.config.autoApproveGlobal.hint": "When on, global-track facts (user profile / global memory) found by the review are written directly without per-item confirmation (note the prompt-injection risk)",
  "panel.config.skillReviewEnabled": "Skill auto-harvest",
  "panel.config.skillReviewEnabled.hint": "Off (default): new skills from review go to the pending queue and only install when approved; On: review creates skills directly without confirmation (skills are injected into every session \u2014 enable with care)",
  "panel.config.memoryTabEnabled": "Session memory tab",
  "panel.config.memoryTabEnabled.hint": "Show the \u8BB0\u5FC6 tab in the session view ring (AGENTS.md + the four memory tracks, all read-only); off by default, takes effect after a page reload",
  "panel.config.perTurnProjectWrites": "Per-turn project writes",
  "panel.config.perTurnProjectWrites.hint": "Require the model to check at the end of every turn and record project-related facts (decisions/progress/pitfalls); when off, project memory is read on demand only. \u26A0\uFE0F Relies on LLM instruction following \u2014 weaker models may not comply",
  "panel.config.perTurnDailyWrites": "Per-turn daily writes",
  "panel.config.perTurnDailyWrites.hint": "Require the model to check at the end of every turn and record the day's progress; when off, the daily log is read on demand only. \u26A0\uFE0F Relies on LLM instruction following \u2014 weaker models may not comply",
  "panel.config.save": "Save config",
  "panel.reveal.title": "Open files",
  "panel.reveal.help": "Open the memory directories and files with your system tools. \u26A0\uFE0F Careless edits can break the \xA7-delimited format and corrupt memory reads \u2014 edit with caution.",
  "panel.reveal.memoryDir": "Memory dir",
  "panel.reveal.memoryFile": "Global memory",
  "panel.reveal.userFile": "User profile",
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
  let badgeCount = 0;
  const deferral = (0, import_dsh_client_ui_slots.deferRegistration)(ctx.slots, "settings.section", MemoryPanel, () => ctx.slots.register({
    name: "settings.section",
    id: "memory-evolve",
    order: 30,
    label: () => badgeCount > 0 ? t("tab.label.count", { count: badgeCount }) : t("tab.label"),
    inject: () => ({ t, refresh: () => pollBadge(true) })
  }, (props) => MemoryPanel(props)));
  const pollBadge = (force = false) => {
    void fetch("/memory-evolve/api/badge").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((data) => {
      const count = data.count ?? 0;
      if (force || count !== badgeCount) {
        badgeCount = count;
        deferral.refresh();
      }
    }).catch(() => {
    });
  };
  pollBadge();
  const timer = setInterval(() => pollBadge(), BADGE_POLL_MS);
  ctx.effect(() => () => {
    clearInterval(timer);
    deferral.dispose();
  }, "memory-evolve: badge poller");
  let tabCancelled = false;
  void fetch("/memory-evolve/api/config").then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))).then((data) => {
    if (tabCancelled || data.config?.memoryTabEnabled !== true) return;
    ctx.slots.register({
      name: "conversation.view",
      id: "memory-files",
      order: 20,
      label: () => t("memoryTab.label")
    }, (props) => MemoryTabView({ ...props, t }));
  }).catch(() => {
  });
  ctx.effect(() => () => {
    tabCancelled = true;
  }, "memory-evolve: memory tab");
}
return module.exports; } });
