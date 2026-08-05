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
function MemoryPanel(props) {
  const { t, refresh } = props;
  const [entries, setEntries] = (0, import_react.useState)(null);
  const [edits, setEdits] = (0, import_react.useState)({});
  const [config, setConfig] = (0, import_react.useState)(null);
  const [draft, setDraft] = (0, import_react.useState)(null);
  const [notice, setNotice] = (0, import_react.useState)(null);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const load = () => {
    void Promise.all([
      api("/api/suggestions"),
      api("/api/config")
    ]).then(([s, c]) => {
      setEntries(s.entries);
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
        body.contents = indices.map((index) => edits[index] ?? "");
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
  const saveConfig = () => {
    if (draft === null) return;
    setBusy(true);
    void api("/api/config", {
      method: "POST",
      body: JSON.stringify({ patch: draft })
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
    ["skillDir", t("panel.reveal.skillDir")]
  ];
  const reveal = (target) => {
    void api("/api/reveal", { method: "POST", body: JSON.stringify({ target }) }).catch((error) => {
      setNotice({ kind: "error", text: t("panel.config.failed", { message: error.message }) });
    });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-panel", children: [
    notice !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: `me-notice me-notice-${notice.kind}`, children: notice.text }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "me-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "me-heading", children: t("panel.suggestions.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-help", children: t("panel.suggestions.help") }),
      entries === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-muted", children: t("panel.loading") }) : entries.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-muted", children: t("panel.suggestions.empty") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "me-list", children: entries.map((entry, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: "me-item", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-item-head", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-badge me-badge-target", children: entry.target }),
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
                  className: "me-btn",
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
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-item-actions me-actions-bulk", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "me-btn me-btn-ok", disabled: busy, onClick: () => runSuggestions("approve-all"), children: t("panel.suggestions.approveAll") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "me-btn", disabled: busy, onClick: () => runSuggestions("reject-all"), children: t("panel.suggestions.rejectAll") })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "me-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "me-heading", children: t("panel.config.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-help", children: t("panel.config.help") }),
      draft === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-muted", children: t("panel.loading") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "me-form", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "me-field-label", children: [
            t("panel.config.reviewEnabled"),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { className: "me-field-hint", children: t("panel.config.reviewEnabled.hint") })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "checkbox",
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
              min: 1,
              value: draft.reviewInterval,
              onChange: (event) => patchDraft({ reviewInterval: Number(event.target.value) })
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-field-label", children: t("panel.config.reviewMode") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "select",
            {
              value: draft.reviewMode,
              onChange: (event) => patchDraft({ reviewMode: event.target.value }),
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "suggest", children: t("panel.config.reviewMode.suggest") }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "auto", children: t("panel.config.reviewMode.auto") })
              ]
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-field-label", children: t("panel.config.skillReviewEnabled") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "checkbox",
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
              checked: draft.autoApproveGlobal,
              onChange: (event) => patchDraft({ autoApproveGlobal: event.target.checked })
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-field-label", children: t("panel.config.injectProjectMemory") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "checkbox",
              checked: draft.injectProjectMemory,
              onChange: (event) => patchDraft({ injectProjectMemory: event.target.checked })
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "me-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "me-field-label", children: t("panel.config.injectDailySummary") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "checkbox",
              checked: draft.injectDailySummary,
              onChange: (event) => patchDraft({ injectDailySummary: event.target.checked })
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "me-actions", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "me-btn me-btn-primary", disabled: busy, onClick: saveConfig, children: t("panel.config.save") }) })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "me-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "me-heading", children: t("panel.reveal.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "me-help", children: t("panel.reveal.help") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "me-actions me-reveal-actions", children: revealTargets.map(([target, label]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "me-btn", onClick: () => reveal(target), children: label }, target)) })
    ] })
  ] });
}

// src/client/styles.css
var styles_default = "/* dsh-memory-evolve panel styles \u2014 DSH design tokens, `me-` prefix. */\n.me-panel {\n  height: 100%;\n  display: flex;\n  flex-direction: column;\n  gap: 16px;\n  overflow-y: auto;\n  padding: 4px 0 24px;\n  color: var(--dsw-alias-text-primary, inherit);\n  font: var(--dsw-font-family, inherit);\n}\n\n.me-block {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.me-heading {\n  margin: 0;\n  font-size: 14px;\n  font-weight: 600;\n  color: var(--dsw-alias-text-primary, inherit);\n}\n\n.me-help {\n  margin: 0;\n  font-size: 12px;\n  line-height: 1.5;\n  color: var(--dsw-alias-text-tertiary, inherit);\n}\n\n.me-muted {\n  margin: 0;\n  font-size: 13px;\n  color: var(--dsw-alias-text-tertiary, inherit);\n}\n\n.me-notice {\n  padding: 8px 10px;\n  border-radius: 6px;\n  font-size: 12px;\n  line-height: 1.5;\n}\n.me-notice-ok {\n  background: var(--dsw-alias-success-bg, transparent);\n  color: var(--dsw-alias-success-text, inherit);\n  border: 1px solid var(--dsw-alias-success-border, transparent);\n}\n.me-notice-error {\n  background: var(--dsw-alias-danger-bg, transparent);\n  color: var(--dsw-alias-danger-text, inherit);\n  border: 1px solid var(--dsw-alias-danger-border, transparent);\n}\n\n.me-list {\n  margin: 0;\n  padding: 0;\n  list-style: none;\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n}\n\n.me-item {\n  border: 1px solid var(--dsw-alias-border-strong, transparent);\n  border-radius: 8px;\n  padding: 10px 12px;\n  background: var(--dsw-alias-surface-raised, transparent);\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n}\n\n.me-item-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n}\n\n.me-badge {\n  font-size: 11px;\n  padding: 2px 8px;\n  border-radius: 10px;\n  background: var(--dsw-alias-accent-bg, transparent);\n  color: var(--dsw-alias-accent-text, inherit);\n}\n\n.me-item-content {\n  margin: 0;\n  font-size: 13px;\n  line-height: 1.5;\n  word-break: break-word;\n  color: var(--dsw-alias-text-primary, inherit);\n}\n\n.me-item-reason {\n  margin: 0;\n  font-size: 12px;\n  color: var(--dsw-alias-text-tertiary, inherit);\n}\n\n.me-item-actions {\n  display: flex;\n  gap: 6px;\n  flex-shrink: 0;\n}\n\n.me-actions-bulk {\n  justify-content: flex-start;\n}\n\n.me-btn {\n  font-size: 12px;\n  padding: 4px 10px;\n  border-radius: 6px;\n  border: 1px solid var(--dsw-alias-border-strong, transparent);\n  background: var(--dsw-alias-surface-raised, transparent);\n  color: var(--dsw-alias-text-primary, inherit);\n  cursor: pointer;\n}\n.me-btn:disabled {\n  opacity: 0.5;\n  cursor: not-allowed;\n}\n.me-btn-ok {\n  border-color: var(--dsw-alias-success-border, transparent);\n  color: var(--dsw-alias-success-text, inherit);\n}\n.me-btn-primary {\n  border-color: var(--dsw-alias-accent-border, transparent);\n  background: var(--dsw-alias-accent-bg, transparent);\n  color: var(--dsw-alias-accent-text, inherit);\n  font-weight: 600;\n}\n\n.me-form {\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n}\n\n.me-field {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  font-size: 13px;\n  color: var(--dsw-alias-text-primary, inherit);\n}\n\n.me-field-label {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.me-field-hint {\n  font-style: normal;\n  font-size: 11px;\n  color: var(--dsw-alias-text-tertiary, inherit);\n}\n\n.me-field input[type='checkbox'] {\n  accent-color: var(--dsw-alias-accent-text, inherit);\n}\n\n.me-field input[type='number'],\n.me-field select {\n  min-width: 96px;\n  padding: 4px 8px;\n  border-radius: 6px;\n  border: 1px solid var(--dsw-alias-border-strong, transparent);\n  background: var(--dsw-alias-surface-raised, transparent);\n  color: var(--dsw-alias-text-primary, inherit);\n}\n\n.me-actions {\n  display: flex;\n  gap: 8px;\n  margin-top: 4px;\n}\n\n.me-item-edit {\n  width: 100%;\n  box-sizing: border-box;\n  padding: 6px 8px;\n  border-radius: 6px;\n  border: 1px solid var(--dsw-alias-border-strong, transparent);\n  background: var(--dsw-alias-surface-raised, transparent);\n  color: var(--dsw-alias-text-primary, inherit);\n  font-size: 13px;\n  line-height: 1.5;\n  resize: vertical;\n  font-family: var(--dsw-font-family, inherit);\n}\n\n.me-reveal-actions {\n  flex-wrap: wrap;\n}\n";

// src/client/index.ts
var NS = "memory-evolve";
var zh = {
  "tab.label": "\u8BB0\u5FC6\u7BA1\u7406",
  "tab.label.count": "\u8BB0\u5FC6\u7BA1\u7406 ({count})",
  "panel.suggestions.title": "\u5F85\u786E\u8BA4\u8BB0\u5FC6\u5EFA\u8BAE",
  "panel.suggestions.empty": "\u6CA1\u6709\u5F85\u786E\u8BA4\u7684\u5EFA\u8BAE\u3002",
  "panel.suggestions.help": "\u540E\u53F0\u5BA1\u67E5\u4EA7\u51FA\u7684\u5168\u5C40\u8BB0\u5FC6\u5EFA\u8BAE\uFF0C\u91C7\u7EB3\u540E\u5199\u5165\u8BB0\u5FC6\u6587\u4EF6\u5E76\u968F\u5FEB\u7167\u6CE8\u5165\u3002",
  "panel.suggestions.approve": "\u91C7\u7EB3",
  "panel.suggestions.editHint": "\u91C7\u7EB3\u524D\u53EF\u4FEE\u6539\u6587\u672C\uFF0C\u4FEE\u6539\u540E\u7684\u5185\u5BB9\u5C06\u5199\u5165\u8BB0\u5FC6\u3002",
  "panel.suggestions.reject": "\u62D2\u7EDD",
  "panel.suggestions.approveAll": "\u5168\u90E8\u91C7\u7EB3",
  "panel.suggestions.rejectAll": "\u5168\u90E8\u62D2\u7EDD",
  "panel.suggestions.done": "\u64CD\u4F5C\u5B8C\u6210\uFF1A{text}",
  "panel.config.title": "\u8FD0\u884C\u65F6\u914D\u7F6E",
  "panel.config.help": "\u4FEE\u6539\u7ACB\u5373\u751F\u6548\u5E76\u6301\u4E45\u5316\uFF08\u8986\u76D6 config.yaml \u7684\u5BF9\u5E94\u9879\uFF09\u3002",
  "panel.config.reviewEnabled": "\u540E\u53F0\u5BA1\u67E5",
  "panel.config.reviewEnabled.hint": "\u56DE\u5408\u7ED3\u675F/\u7EC8\u5C40/\u624B\u52A8\u89E6\u53D1\u5BA1\u67E5",
  "panel.config.reviewInterval": "\u5BA1\u67E5\u95F4\u9694\uFF08\u56DE\u5408\uFF09",
  "panel.config.reviewInterval.hint": "\u6BCF N \u4E2A\u7528\u6237\u56DE\u5408\u5BA1\u67E5\u4E00\u6B21",
  "panel.config.reviewMode": "\u5168\u5C40\u8BB0\u5FC6\u5199\u5165\u6A21\u5F0F",
  "panel.config.reviewMode.suggest": "\u5EFA\u8BAE\u786E\u8BA4\uFF08\u63A8\u8350\uFF09",
  "panel.config.reviewMode.auto": "\u81EA\u52A8\u5199\u5165\uFF08\u9700\u6279\u51C6\uFF09",
  "panel.config.autoApproveGlobal": "\u5168\u5C40\u8BB0\u5FC6\u81EA\u52A8\u6C89\u6DC0",
  "panel.config.autoApproveGlobal.hint": "\u5F00\u542F\u540E user/memory \u8F68\u4E0D\u518D\u9700\u8981\u786E\u8BA4\uFF08\u6CE8\u610F\u63D0\u793A\u6CE8\u5165\u98CE\u9669\uFF09",
  "panel.config.skillReviewEnabled": "\u6280\u80FD\u81EA\u52A8\u6C89\u6DC0",
  "panel.config.injectProjectMemory": "\u6CE8\u5165\u9879\u76EE\u8BB0\u5FC6",
  "panel.config.injectDailySummary": "\u6CE8\u5165\u4ECA\u65E5\u6458\u8981",
  "panel.config.save": "\u4FDD\u5B58\u914D\u7F6E",
  "panel.reveal.title": "\u6253\u5F00\u6587\u4EF6",
  "panel.reveal.help": "\u7528\u7CFB\u7EDF\u5DE5\u5177\u6253\u5F00\u8BB0\u5FC6\u76EE\u5F55\u4E0E\u8BB0\u5FC6\u6587\u4EF6\uFF0C\u4FBF\u4E8E\u76F4\u63A5\u67E5\u770B/\u7F16\u8F91\u3002",
  "panel.reveal.memoryDir": "\u8BB0\u5FC6\u76EE\u5F55",
  "panel.reveal.memoryFile": "\u5168\u5C40\u8BB0\u5FC6",
  "panel.reveal.userFile": "\u7528\u6237\u6863\u6848",
  "panel.reveal.dailyDir": "\u6BCF\u65E5\u65E5\u5FD7\u76EE\u5F55",
  "panel.reveal.dailyFile": "\u4ECA\u65E5\u65E5\u5FD7",
  "panel.reveal.projectsDir": "\u9879\u76EE\u8BB0\u5FC6\u76EE\u5F55",
  "panel.reveal.skillDir": "\u6280\u80FD\u76EE\u5F55",
  "panel.config.saved": "\u914D\u7F6E\u5DF2\u4FDD\u5B58\u5E76\u751F\u6548",
  "panel.config.failed": "\u64CD\u4F5C\u5931\u8D25\uFF1A{message}",
  "panel.loading": "\u52A0\u8F7D\u4E2D\u2026"
};
var en = {
  "tab.label": "Memory",
  "tab.label.count": "Memory ({count})",
  "panel.suggestions.title": "Pending memory suggestions",
  "panel.suggestions.empty": "No pending suggestions.",
  "panel.suggestions.help": "Global-track suggestions produced by the background review. Approving writes them into the memory files, injected with the snapshot.",
  "panel.suggestions.approve": "Approve",
  "panel.suggestions.editHint": "You may edit the text before approving; the edited text is what gets written.",
  "panel.suggestions.reject": "Reject",
  "panel.suggestions.approveAll": "Approve all",
  "panel.suggestions.rejectAll": "Reject all",
  "panel.suggestions.done": "Done: {text}",
  "panel.config.title": "Runtime config",
  "panel.config.help": "Changes apply immediately and persist (overriding the config.yaml entries).",
  "panel.config.reviewEnabled": "Background review",
  "panel.config.reviewEnabled.hint": "Review on interval / session end / manual trigger",
  "panel.config.reviewInterval": "Review interval (turns)",
  "panel.config.reviewInterval.hint": "One review per N user turns",
  "panel.config.reviewMode": "Global memory write mode",
  "panel.config.reviewMode.suggest": "Suggest (recommended)",
  "panel.config.reviewMode.auto": "Auto write (approval required)",
  "panel.config.autoApproveGlobal": "Auto-harvest global memory",
  "panel.config.autoApproveGlobal.hint": "When on, user/memory tracks skip confirmation (note the prompt-injection risk)",
  "panel.config.skillReviewEnabled": "Skill auto-harvest",
  "panel.config.injectProjectMemory": "Inject project memory",
  "panel.config.injectDailySummary": "Inject daily summary",
  "panel.config.save": "Save config",
  "panel.reveal.title": "Open files",
  "panel.reveal.help": "Open the memory directories and files with your system tools.",
  "panel.reveal.memoryDir": "Memory dir",
  "panel.reveal.memoryFile": "Global memory",
  "panel.reveal.userFile": "User profile",
  "panel.reveal.dailyDir": "Daily log dir",
  "panel.reveal.dailyFile": "Today log",
  "panel.reveal.projectsDir": "Project memory dir",
  "panel.reveal.skillDir": "Skills dir",
  "panel.config.saved": "Config saved and applied",
  "panel.config.failed": "Failed: {message}",
  "panel.loading": "Loading\u2026"
};
var BADGE_POLL_MS = 3e4;
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
}
return module.exports; } });
