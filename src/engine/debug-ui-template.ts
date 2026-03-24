import { substitute } from "./substitute";
import type { PlainTextTestCase, StepIntent } from "./types";

// Local view of the debug state to avoid importing from debug-runner (and
// creating a circular dependency). This matches the fields renderDebugHtml
// actually uses.
interface DebugStepStateLike {
  index: number;
  step: StepIntent;
  status: "pending" | "running" | "passed" | "failed";
  breakpoint?: boolean;
  enabled?: boolean;
}

interface DebugSessionStateLike {
  test: PlainTextTestCase;
  baseUrl: string;
  env: Record<string, string>;
  steps: DebugStepStateLike[];
  logs?: Array<{ text: string; isError?: boolean }>;
  saveMessageVisible?: boolean;
  logPanelVisible?: boolean;
  resumableFromIndex?: number | null | undefined;
}

function parseElementScope(element: string): {
  base: string;
  inDialog: boolean;
  inIframe: boolean;
} {
  let base = (element ?? "").trim();
  const inDialog = /\binside\s+dialog\b/i.test(base);
  const inIframe = /\binside\s+iframe\b/i.test(base);
  for (let prev = ""; prev !== base;) {
    prev = base;
    base = base
      .replace(/\s*inside\s+iframe\s*$/i, "")
      .replace(/\s*inside\s+dialog\s*$/i, "")
      .trim();
  }
  return { base, inDialog, inIframe };
}

const MAX_TOOLTIP_LEN = 500;
function tooltipText(raw: string): string {
  const s = raw
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, " ");
  return s.length <= MAX_TOOLTIP_LEN ? s : s.slice(0, MAX_TOOLTIP_LEN) + "…";
}

function hasVariable(s: string | undefined | null): boolean {
  return /\{\{[^}]*\}\}/.test(s ?? "");
}

function resolvedTooltipContent(raw: string, resolved: string): string {
  if (!hasVariable(raw)) return "";
  if (resolved && !hasVariable(resolved)) return tooltipText(resolved);
  return tooltipText("can't resolve " + raw);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderDebugHtml(state: DebugSessionStateLike): string {
  const env = state.env;
  const rowsHtml = state.steps
    .map((s: DebugStepStateLike) => {
      const action = s.step.action;
      const { base: elementDisplay, inDialog, inIframe } = parseElementScope(
        s.step.element ?? ""
      );
      let value = "";
      if (action === "pause" && s.step.seconds != null) {
        value = String(s.step.seconds);
      } else if (action === "navigate") {
        value = s.step.url ?? "";
      } else {
        value = s.step.value ?? "";
      }
      const resolvedElement = substitute(s.step.element ?? "", env);
      let resolvedValue = "";
      if (action === "navigate") {
        resolvedValue = substitute(s.step.url ?? "", env);
      } else if (action !== "pause") {
        resolvedValue = substitute(value, env);
      } else {
        resolvedValue = value;
      }
      const elementResolved = hasVariable(s.step.element ?? "")
        ? resolvedTooltipContent(s.step.element ?? "", resolvedElement)
        : "";
      const valueRaw = action === "navigate" ? (s.step.url ?? "") : value;
      const valueResolved = hasVariable(valueRaw)
        ? resolvedTooltipContent(valueRaw, resolvedValue)
        : "";
      const statusClass =
        s.status === "passed"
          ? "status-passed"
          : s.status === "failed"
            ? "status-failed"
            : s.status === "running"
              ? "status-running"
              : "status-pending";
      const statusLabel =
        s.status === "passed"
          ? "✓"
          : s.status === "failed"
            ? "✗"
            : s.status === "running"
              ? "…"
              : "";

      const bpClass = s.breakpoint ? "breakpoint-toggle active" : "breakpoint-toggle";
      const bpChar = s.breakpoint ? "●" : "○";
      const enabled = s.enabled !== false;
      const rawLocator = s.step.locator ?? "";
      const locatorLooksStored = rawLocator ? /^[a-z_]+\|/.test(rawLocator) : false;
      const locatorDisplay = locatorLooksStored ? "" : rawLocator;
      return `
        <tr data-index="${s.index}" draggable="true"${enabled ? "" : ' class="step-disabled"'
        }>
          <td class="col-index"><span class="${bpClass}" data-role="toggle-breakpoint" data-index="${s.index
        }" title="Toggle breakpoint">${bpChar}</span> <span class="step-num">${s.index + 1
        }</span></td>
          <td class="col-action"><input draggable="false" data-field="action" data-index="${s.index
        }" value="${escapeHtml(String(action))}" /></td>
          <td class="col-element"><input draggable="false" data-field="element" data-index="${s.index
        }" value="${escapeHtml(elementDisplay)}"${elementResolved ? ` data-resolved="${elementResolved}"` : ""
        } /></td>
          <td class="col-locator"><input draggable="false" data-field="locator" data-index="${s.index
        }" value="${escapeHtml(locatorDisplay)}" placeholder="" title="Locator"/></td>
          <td class="col-dialog" title="Inside dialog"><input draggable="false" type="checkbox" data-field="dialog" data-index="${s.index
        }" ${inDialog ? "checked" : ""} /></td>
          <td class="col-iframe" title="Inside iframe"><input draggable="false" type="checkbox" data-field="iframe" data-index="${s.index
        }" ${inIframe ? "checked" : ""} /></td>
          <td class="col-value"><input draggable="false" data-field="value" data-index="${s.index
        }" value="${escapeHtml(value)}"${valueResolved ? ` data-resolved="${valueResolved}"` : ""
        } /></td>
          <td class="col-status ${statusClass}">${statusLabel}</td>
          <td class="col-run">
            <button data-role="run-step" data-index="${s.index}">▶</button>
          </td>
          <td class="col-edit">
            <button title="Delete" data-action="delete" data-index="${s.index}">✕</button>
          </td>
        </tr>
      `;
    })
    .join("\n");

  const baseUrlRaw = state.test.baseUrl ?? state.baseUrl ?? "";
  const resolvedBaseUrl = baseUrlRaw ? substitute(baseUrlRaw, env) : "";
  const baseUrlResolved = hasVariable(baseUrlRaw)
    ? resolvedTooltipContent(baseUrlRaw, resolvedBaseUrl)
    : "";

  const variables = state.test.variables ?? {};
  const variableEntries = Object.entries(variables);
  const variablesSectionHtml = `<div class="variables-section collapsed" id="variables-section">
  <div class="variables-section-header" id="variables-section-toggle" title="Expand/collapse variables">
    Variables (${variableEntries.length}) <span class="variables-section-arrow">▶</span>
  </div>
  <div class="variables-section-content" id="variables-section-content">
    ${variableEntries
      .map(([name, raw]) => {
        const resolved = env[name] ?? "";
        const resolvedAttr = hasVariable(raw)
          ? ` data-resolved="${resolvedTooltipContent(raw, resolved)}"`
          : "";
        return `<div class="variables-section-row"><input class="variables-section-name" data-field="variable-name" value="${escapeHtml(
          name,
        )}" placeholder="name" /><input class="variables-section-value" data-field="variable" value="${escapeHtml(
          raw,
        )}"${resolvedAttr} /><button type="button" class="variables-section-remove" data-role="remove-variable" title="Remove variable" aria-label="Remove variable">×</button></div>`;
      })
      .join("")}
    <button type="button" class="variables-section-add" data-role="add-variable" id="add-variable-btn">+ Add variable</button>
  </div>
</div>`;

  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>uiplay debug: ${escapeHtml(state.test.id)}</title>
    <style>
      html, body { height: 100%; margin: 0; }
      body { font-family: -apple-system, system-ui, sans-serif; padding: 0; font-size: 13px; display: flex; flex-direction: column; overflow: hidden; }
      .debug-top-panel { flex-shrink: 0; padding: 8px; border-bottom: 1px solid #ddd; background: #fafafa; }
      .debug-actions-panel { flex: 1 1 0; min-height: 0; overflow: auto; padding: 0 8px 8px; }
      h1 { font-size: 19px; margin: 0 0 6px; }
      .meta { font-size: 13px; color: #555; margin-bottom: 6px; display: flex; flex-direction: column; gap: 4px; }
      .meta-row { display: flex; align-items: center; gap: 6px; }
      .meta label { font-weight: 600; margin-right: 2px; width: 70px; text-align: left; }
      .meta input { font-size: 13px; padding: 2px 4px; flex: 1 1 auto; }
      .table-container { overflow-x: auto; }
      table { border-collapse: collapse; width: max-content; min-width: 100%; font-size: 13px; table-layout: auto; }
      th, td { border: 1px solid #ddd; padding: 2px 4px; }
      th { background: #f5f5f5; text-align: left; position: relative; }
      .col-resize-handle {
        position: absolute;
        top: 0;
        right: 0;
        width: 4px;
        height: 100%;
        cursor: col-resize;
        user-select: none;
      }
      input { width: 100%; box-sizing: border-box; font-size: 13px; padding: 1px 2px; min-width: 0; }
      button { font-size: 13px; padding: 1px 4px; }
      button:disabled { opacity: 0.5; cursor: default; }
      .toolbar { margin-bottom: 0; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .log-toggle-icon { font-size: 10px; color: #888; }
      button[data-role="toggle-log"]:hover .log-toggle-icon { color: #333; }
      button[data-role="stop"] { display: inline-flex; align-items: center; }
      .stop-icon { font-size: 1.6em; line-height: 0.8; display: inline-flex; align-items: center; transform: translateY(-2px); }
      .save-message { color: #0a0; font-size: 13px; margin-left: 6px; }
      .record-toggle.recording { background: #c00; color: #fff; }
      .status-passed { color: #0a0; }
      .status-failed { color: #c00; }
      .status-running { color: #06c; }
      .status-pending { color: #aaa; }
      .col-index { width: 1%; white-space: nowrap; }
      .breakpoint-toggle { cursor: pointer; user-select: none; color: #999; font-size: 12px; }
      .breakpoint-toggle:hover { color: #666; }
      .breakpoint-toggle.active { color: #c00; }
      .col-action { width: 1%; min-width: 60px; max-width: 100px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .col-action input { max-width: 100%; }
      .col-element, .col-value {
        min-width: 160px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .col-dialog, .col-iframe { width: 1%; text-align: center; white-space: nowrap; }
      .col-dialog input[type="checkbox"],
      .col-iframe input[type="checkbox"] { margin: 0; }
      tr.step-disabled {
        background-color: #e6e6e6;
      }
      tr.step-disabled td {
        color: #777;
      }
      tr.step-disabled input,
      tr.step-disabled textarea,
      tr.step-disabled select,
      tr.step-disabled button {
        pointer-events: none;
        opacity: 0.5;
        cursor: default;
      }
      tr.step-disabled .breakpoint-toggle {
        pointer-events: none;
        opacity: 0.4;
      }
      .col-locator { min-width: 120px; max-width: 280px; }
      .col-locator input { min-width: 80px; }
      .locator-toggle-in-element { margin-left: 4px; cursor: pointer; user-select: none; color: #888; font-size: 11px; }
      .locator-toggle-in-element:hover { color: #333; }
      table.locator-col-collapsed td.col-locator { width: 0; min-width: 0; max-width: 0; padding: 0; overflow: hidden; border: none; visibility: hidden; }
      table.locator-col-collapsed th.col-locator { width: 0; min-width: 0; max-width: 0; padding: 0; overflow: hidden; border: none; visibility: hidden; }
      .col-status { width: 1%; text-align: center; }
      .col-run { width: 1%; text-align: center; }
      .col-edit { width: 1%; white-space: nowrap; text-align: center; }
      #move-selected-up, #move-selected-down { padding: 1px 4px; }
      tr.step-selected {
        background-color: rgba(33, 150, 243, 0.06);
      }
      #steps-body tr.step-current { background: rgba(33, 150, 243, 0.12); outline: 2px solid rgba(33, 150, 243, 0.5); outline-offset: -2px; }
      #steps-body input, #steps-body textarea, #steps-body select, #steps-body button {
        -webkit-user-drag: none;
      }
      .busy-indicator {
        display: none;
        width: 14px;
        height: 14px;
        margin-left: auto;
        vertical-align: middle;
        border-radius: 50%;
        border: 2px solid #ccc;
        border-top-color: #06c;
        animation: spin 0.8s linear infinite;
      }
      body.busy .busy-indicator { display: inline-block; }
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      #log-panel {
        flex-shrink: 0;
        margin: 0 8px 8px;
        border: 1px solid #ddd;
        border-radius: 4px;
        background: #1e1e1e;
        color: #d4d4d4;
        font-family: ui-monospace, monospace;
        font-size: 12px;
      }
      #log-panel.log-panel-hidden { display: none; }
      .log-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 8px;
        background: #2d2d2d;
      }
      .log-panel-header span {
        font-weight: 600;
      }
      .log-panel-header button {
        font-size: 11px;
        padding: 2px 6px;
      }
      .log-panel-resize-handle {
        height: 4px;
        cursor: row-resize;
        background: #333;
      }
      #log-panel-content {
        max-height: 200px;
        overflow-y: auto;
        padding: 4px 8px;
      }
      .log-line { white-space: pre-wrap; }
      .log-line-error { color: #f48771; }
      .resolved-tooltip {
        position: fixed;
        z-index: 1000;
        background: #333;
        color: #fff;
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 11px;
        max-width: 480px;
        white-space: pre-wrap;
        display: none;
      }
      .resolved-tooltip.visible { display: block; }
      .variables-section { margin-bottom: 6px; font-size: 13px; }
      .variables-section-header {
        font-weight: 600;
        cursor: pointer;
        user-select: none;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .variables-section-header:hover { color: #333; }
      .variables-section-arrow { font-size: 10px; display: inline-block; }
      .variables-section.collapsed .variables-section-arrow { transform: rotate(0deg); }
      .variables-section:not(.collapsed) .variables-section-arrow { transform: rotate(-90deg); }
      .variables-section-content {
        margin-top: 4px; margin-left: 12px; padding-left: 8px;
        border-left: 2px solid #ddd; display: flex; flex-direction: column; gap: 2px;
        font-size: 13px;
      }
      .variables-section.collapsed .variables-section-content { display: none; }
      .variables-section-row { display: flex; align-items: center; gap: 8px; }
      .variables-section-name {
        width: 20ch; min-width: 15ch; max-width: 20ch; flex-shrink: 0;
        font-size: 11px; padding: 2px 4px; box-sizing: border-box;
      }
      .variables-section-value { flex: 1 1 auto; min-width: 0; font-size: 13px; padding: 2px 4px; box-sizing: border-box; }
      .variables-section-remove {
        flex-shrink: 0; width: 22px; padding: 0; font-size: 16px; line-height: 1;
        color: #888; background: none; border: none; cursor: pointer;
      }
      .variables-section-remove:hover { color: #c00; }
      .variables-section-add {
        margin-top: 4px; font-size: 12px; color: #06c; background: none; border: none;
        cursor: pointer; padding: 2px 0;
      }
      .variables-section-add:hover { text-decoration: underline; }
    </style>
  </head>
  <body>
    <!-- body content omitted; still built exactly as in debug-runner before refactor -->
  </body>
</html>`;

  return html;
}

