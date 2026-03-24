import { chromium, Locator, Page } from "playwright";
import path from "path";
import fs from "fs";
const { marked } = require("marked") as { marked: (src: string) => string };
import { getPlaywrightBrowserContextOptions, getUiplayConfig, resolveUploadFilePath, rootDir } from "./config";
import { resolveLocator } from "./locator-resolver";
import { loadTestCase, loadTestCaseFromContent, saveTestCase, listTestCases } from "./test-case-store";
import { evaluateVariables, isFullUrl, resolveNavigateUrl, substitute } from "./substitute";
import { getDebugRecorderScript } from "./debug-recorder-script";
import { getInteractiveHighlightInitScript } from "./debug-highlight-script";
import type { StepIntent, PlainTextTestCase, RecordedAction } from "./types";

export interface DebugRunOptions {
  /** When omitted, opens an empty session (no YAML); use Save in the UI to create tests/. */
  testId?: string;
  baseUrl?: string;
  env?: Record<string, string>;
  headless?: boolean;
  /** Per-strategy locator timeout in ms for debug (same meaning as discovery). */
  locatorTimeoutMs?: number;
}

type StepStatus = "pending" | "running" | "passed" | "failed";

interface DebugStepState {
  index: number;
  step: StepIntent;
  status: StepStatus;
  lastError?: string;
  /** When true, Run all pauses before executing this step. */
  breakpoint?: boolean;
  /** When false, Run all / Resume skip this step. */
  enabled?: boolean;
  /** Cached locator used only by the debugger for faster replays; not persisted. */
  cachedLocator?: string;
}

interface DebugSessionState {
  test: PlainTextTestCase;
  /** Raw value for the base URL field (templates allowed); env BASE_URL / baseUrl hold the substituted form. */
  baseUrl: string;
  env: Record<string, string>;
  steps: DebugStepState[];
  /** Index of the last step we executed, used for upload filechooser pairing. */
  lastExecutedIndex: number | null;
  /** When true, debug UI shows "Saved successfully." until another action clears it. */
  saveMessageVisible?: boolean;
  /** When true, user interactions on the app page are being recorded. */
  recording?: boolean;
  /** Number of recorded actions already appended as steps. */
  recordedCount?: number;
  /** Resolves when the background recorder poll loop has fully stopped (avoids stale UI render racing stop-record). */
  streamRecorderDone?: Promise<void>;
  /** Log lines for the debug log panel. */
  logs?: Array<{ text: string; isError?: boolean }>;
  /** When true, log panel is visible. */
  logPanelVisible?: boolean;
  /** When set, Run button shows as Resume and continues from this step index (after stop/breakpoint/failure). */
  resumableFromIndex?: number;
  /** Outline interactive elements on the app page on hover. Default true (see config.json debugUi). */
  highlightInteractiveElements?: boolean;
}

async function syncHighlightToAllFrames(appPage: Page, state: DebugSessionState): Promise<void> {
  const enabled = state.highlightInteractiveElements !== false;
  for (const frame of appPage.frames()) {
    try {
      await frame.evaluate(
        (e) => {
          const w = window as Window & {
            __UPLAY_HL_ENABLED_GLOBAL?: boolean;
            __uiplaySetHighlightEnabled?: (v: boolean) => void;
          };
          w.__UPLAY_HL_ENABLED_GLOBAL = e;
          if (typeof w.__uiplaySetHighlightEnabled === "function") {
            w.__uiplaySetHighlightEnabled(e);
          }
        },
        enabled
      );
    } catch {
      // cross-origin frame or document not ready
    }
  }
}

/**
 * Run an interactive debug session:
 * - Launch headed browser with an app page and a debug UI page.
 * - Allow the user to run individual steps or run-all from the UI.
 */
export async function runDebug(options: DebugRunOptions): Promise<void> {
  let test: PlainTextTestCase;
  if (options.testId) {
    const loaded = loadTestCase(options.testId);
    if (!loaded) throw new Error(`Test case not found: ${options.testId}`);
    test = loaded;
  } else {
    test = {
      id: "",
      title: "Untitled",
      steps: [],
      established: false,
    };
  }

  const env = { ...process.env, ...test.env, ...options.env } as Record<string, string>;
  let sessionBaseUrlRaw = options.baseUrl ?? test.baseUrl ?? "";
  if (!sessionBaseUrlRaw || sessionBaseUrlRaw === "{{baseUrl}}") {
    sessionBaseUrlRaw = (env.PLAYWRIGHT_LOGIN_URL as string) ?? sessionBaseUrlRaw;
  }
  const resolvedBaseUrl = sessionBaseUrlRaw ? substitute(sessionBaseUrlRaw, env) : "";
  env.BASE_URL = resolvedBaseUrl;
  env.baseUrl = resolvedBaseUrl;

  // Evaluate per-test variables and merge into env so they can be used in steps.
  const evaluatedVars = evaluateVariables(test.variables, env);
  Object.assign(env, evaluatedVars);

  const initialSteps: DebugStepState[] = (test.steps ?? []).map((s, i) => ({
    index: i,
    step: { ...s },
    status: "pending",
    breakpoint: false,
    enabled: true,
  }));

  const highlightCfg = getUiplayConfig().debugUi.highlightInteractiveElements;
  const state: DebugSessionState = {
    test,
    baseUrl: sessionBaseUrlRaw,
    env,
    steps: initialSteps,
    lastExecutedIndex: null,
    saveMessageVisible: false,
    recording: false,
    recordedCount: 0,
    logs: [],
    logPanelVisible: false,
    highlightInteractiveElements: highlightCfg !== false,
  };

  const contextOptions = await getPlaywrightBrowserContextOptions();
  const debugPanelWidth = getUiplayConfig().debugUi.sidePanelWidth;

  // Use two separate contexts in a single browser so the app and debug UI appear as separate windows.
  const browser = await chromium.launch({ headless: options.headless ?? false });
  const appContext = await browser.newContext(contextOptions);
  const uiViewport =
    contextOptions.viewport && typeof contextOptions.viewport.height === "number"
      ? { width: debugPanelWidth, height: contextOptions.viewport.height }
      : { width: debugPanelWidth, height: 600 };
  const uiContext = await browser.newContext({
    ...contextOptions,
    viewport: uiViewport,
  });

  const appPage = await appContext.newPage();
  const uiPage = await uiContext.newPage();

  const hlScript = getInteractiveHighlightInitScript();
  await appPage.addInitScript({ content: hlScript });
  try {
    await appPage.evaluate((code: string) => {
      (0, eval)(code);
    }, hlScript);
  } catch {
    // ignore if main frame cannot eval yet
  }
  await syncHighlightToAllFrames(appPage, state);
  appPage.on("framenavigated", () => {
    void syncHighlightToAllFrames(appPage, state);
  });

  // When the debug UI window/tab is closed, close the browser and terminate the process.
  uiPage.on("close", () => {
    browser.close().catch(() => { });
    process.exit(0);
  });

  // Render the initial debug UI.
  await renderDebugUI(uiPage, state);
  await uiPage.evaluate(() => {
    const el = document.getElementById("log-panel-content");
    if (el) el.scrollTop = el.scrollHeight;
  });

  // Expose a bridge for UI → Node commands.
  let busy = false;
  let stopRequested = false;
  let stopAbortReject: ((e?: Error) => void) | null = null;
  let readmePage: Page | null = null;
  await uiPage.exposeBinding(
    "uiplayDebugControl",
    async (_source, payload: unknown) => {
      const cmd = payload as { type?: string };
      if (cmd.type === "stop") {
        // Idle with Resume showing: second Stop clears resume and returns to Run.
        // While Run all / run-from is in progress (busy), Stop aborts playback and leaves Resume (first stop).
        if (!busy && state.resumableFromIndex != null) {
          state.resumableFromIndex = undefined;
          try {
            await clearCurrentStepHighlight(uiPage);
          } catch {
            // ignore if UI is gone
          }
          await renderDebugUI(uiPage, state);
          return { ok: true };
        }
        stopRequested = true;
        if (stopAbortReject) {
          stopAbortReject(new Error("Stopped"));
          stopAbortReject = null;
        }
        return { ok: true };
      }
      if (cmd.type === "open-readme") {
        if (readmePage && !readmePage.isClosed()) {
          await readmePage.bringToFront();
          return { ok: true };
        }
        const readmePath = path.join(rootDir, "README.md");
        const raw = fs.readFileSync(readmePath, "utf-8");
        const body = marked(raw);
        const html =
          `<!DOCTYPE html><html><head><meta charset="utf-8"><title>uiplay README</title>` +
          `<style>body{font-family:system-ui,sans-serif;max-width:800px;margin:24px auto;padding:0 16px;line-height:1.5;} code{background:#eee;padding:2px 6px;border-radius:4px;} pre{overflow:auto;background:#f5f5f5;padding:12px;border-radius:4px;} table{border-collapse:collapse;} th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;}</style></head><body>${body}</body></html>`;
        readmePage = await uiContext.newPage();
        await readmePage.setContent(html, { waitUntil: "load" });
        readmePage.on("close", () => {
          readmePage = null;
        });
        return { ok: true };
      }
      if (cmd.type === "clear-log") {
        state.logs = [];
        try {
          await uiPage.evaluate(() => {
            const logEl = document.getElementById("log-panel-content");
            if (logEl) {
              logEl.innerHTML = "";
              logEl.scrollTop = 0;
            }
          });
        } catch {
          // Ignore UI update errors (e.g., page closing) while clearing log.
        }
        return { ok: true };
      }
      if (cmd.type === "toggle-log") {
        state.logPanelVisible = !state.logPanelVisible;
        return { ok: true };
      }
      if (cmd.type === "toggle-highlight-interactive") {
        const p = payload as { enabled?: boolean };
        if (typeof p.enabled === "boolean") {
          state.highlightInteractiveElements = p.enabled;
          await syncHighlightToAllFrames(appPage, state);
        }
        return { ok: true };
      }
      if (busy) return { ok: false, error: "Runner is busy; try again shortly." };
      busy = true;
      try {
        type UiStepPayload = {
          action: string;
          element?: string;
          value?: string;
          locator?: string;
          originalIndex?: number;
        };

        const command = payload as (
          | {
            type: "run-step";
            index: number;
            stepOverride?: Partial<StepIntent>;
            steps?: UiStepPayload[];
          }
          | { type: "run-all"; steps?: UiStepPayload[] }
          | { type: "run-from"; index: number; steps?: UiStepPayload[] }
          | {
            type: "save-test";
            id: string;
            title: string;
            steps: UiStepPayload[];
            variables?: Record<string, string>;
          }
          | { type: "refresh" }
          | { type: "reset" }
          | { type: "open-test"; testId?: string; yamlContent?: string }
          | { type: "list-tests" }
          | { type: "start-record" }
          | { type: "stop-record" }
          | { type: "toggle-log" }
          | { type: "clear-log" }
          | { type: "toggle-breakpoint"; index: number }
          | { type: "stop" }
        ) & { baseUrl?: string };

        if (typeof command.baseUrl === "string") {
          const newBase = command.baseUrl.trim();
          state.baseUrl = newBase;
          let baseUrlToResolve = newBase;
          if (!baseUrlToResolve || baseUrlToResolve === "{{baseUrl}}") {
            baseUrlToResolve = state.env.PLAYWRIGHT_LOGIN_URL ?? baseUrlToResolve;
          }
          const resolvedBaseUrl = substitute(baseUrlToResolve, state.env);
          state.env.BASE_URL = resolvedBaseUrl;
          state.env.baseUrl = resolvedBaseUrl;
        }

        switch (command.type) {
          case "list-tests": {
            const tests = listTestCases();
            return { ok: true, tests };
          }
          case "run-step": {
            stopRequested = false;
            state.resumableFromIndex = undefined;
            state.saveMessageVisible = false;
            if (command.steps && command.steps.length) {
              applyUiStepsToState(state, command.steps);
            }
            const stopAbortForStep = new Promise<never>((_, reject) => {
              stopAbortReject = (e?: Error) => reject(e ?? new Error("Stopped"));
            });
            try {
              await runSingleStep(
                appPage,
                state,
                command.index,
                command.stepOverride,
                options,
                uiPage,
                stopAbortForStep
              );
            } finally {
              stopAbortReject = null;
            }
            break;
          }
          case "run-all": {
            stopRequested = false;
            const stopAbortPromise = new Promise<never>((_, reject) => {
              stopAbortReject = (e?: Error) => reject(e ?? new Error("Stopped"));
            });
            try {
              state.resumableFromIndex = undefined;
              state.saveMessageVisible = false;
              const uiSteps = command.steps ?? [];
              if (uiSteps.length) {
                applyUiStepsToState(state, uiSteps);
              }
              const count = state.steps.length;
              let stoppedEarly = false;
              for (let i = 0; i < count; i++) {
                const stepState = state.steps[i];
                // Skip disabled steps in Run all / Resume.
                if (stepState && stepState.enabled === false) {
                  continue;
                }
                if (stopRequested) {
                  state.resumableFromIndex = i;
                  await highlightCurrentStep(uiPage, i);
                  stoppedEarly = true;
                  break;
                }
                if (state.steps[i]?.breakpoint) {
                  state.resumableFromIndex = i;
                  await highlightCurrentStep(uiPage, i);
                  stoppedEarly = true;
                  break;
                }
                await highlightCurrentStep(uiPage, i);
                await runSingleStep(appPage, state, i, undefined, options, uiPage, stopAbortPromise);
                const status = state.steps[i]?.status;
                const stepFailed = status === "failed";
                const stepPending = status === "pending";
                if (stopRequested || stepFailed || stepPending) {
                  if (stepPending) {
                    // Step did not complete (e.g. stopped before action fired) – resume from it.
                    state.resumableFromIndex = i;
                  } else if (stepFailed && i + 1 < count) {
                    // On failure, resume from the *next* step.
                    state.resumableFromIndex = i + 1;
                  } else if (stopRequested && status === "passed" && i + 1 < count) {
                    // Stopped after the action completed (e.g. while waiting for page
                    // to stabilize) – resume from the next step.
                    state.resumableFromIndex = i + 1;
                  }
                  stoppedEarly = true;
                  break;
                }
              }
              if (!stoppedEarly) {
                state.resumableFromIndex = undefined;
                await clearCurrentStepHighlight(uiPage);
              }
            } finally {
              stopAbortReject = null;
            }
            break;
          }
          case "run-from": {
            stopRequested = false;
            const stopAbortPromise = new Promise<never>((_, reject) => {
              stopAbortReject = (e?: Error) => reject(e ?? new Error("Stopped"));
            });
            try {
              state.saveMessageVisible = false;
              const uiSteps = command.steps ?? [];
              if (uiSteps.length) {
                applyUiStepsToState(state, uiSteps);
              }
              let stoppedEarly = false;
              for (let i = command.index; i < state.steps.length; i++) {
                if (stopRequested) {
                  state.resumableFromIndex = i;
                  await highlightCurrentStep(uiPage, i);
                  stoppedEarly = true;
                  break;
                }
                // When resuming, do not stop at breakpoints — run the step and continue to next breakpoint/end.
                if (state.steps[i]?.breakpoint && command.index !== i) {
                  state.resumableFromIndex = i;
                  await highlightCurrentStep(uiPage, i);
                  stoppedEarly = true;
                  break;
                }
                await highlightCurrentStep(uiPage, i);
                await runSingleStep(appPage, state, i, undefined, options, uiPage, stopAbortPromise);
                const status = state.steps[i].status;
                const stepFailed = status === "failed";
                const stepPending = status === "pending";
                if (stopRequested || stepFailed || stepPending) {
                  if (stepPending) {
                    state.resumableFromIndex = i;
                  } else if (stepFailed && i + 1 < state.steps.length) {
                    state.resumableFromIndex = i + 1;
                  } else if (stopRequested && status === "passed" && i + 1 < state.steps.length) {
                    state.resumableFromIndex = i + 1;
                  }
                  await highlightCurrentStep(uiPage, i);
                  stoppedEarly = true;
                  break;
                }
              }
              if (!stoppedEarly) {
                state.resumableFromIndex = undefined;
                await clearCurrentStepHighlight(uiPage);
              }
            } finally {
              stopAbortReject = null;
            }
            break;
          }
          case "save-test": {
            const newId = command.id.trim();
            const newTitle = command.title.trim() || state.test.title || "(untitled)";
            if (!newId) {
              throw new Error("Test ID cannot be empty when saving.");
            }

            // Ensure no in-flight recorder UI refresh overwrites the table after stop-record (or recover if stop desynced).
            if (!state.recording && state.streamRecorderDone) {
              try {
                await state.streamRecorderDone;
              } catch {
                // ignore
              }
              state.streamRecorderDone = undefined;
            }

            applyUiStepsToState(state, command.steps);

            const newVariables = command.variables ?? state.test.variables;
            if (newVariables && typeof newVariables === "object") {
              const evaluated = evaluateVariables(newVariables, state.env);
              Object.assign(state.env, evaluated);
            }

            state.test = {
              ...state.test,
              id: newId,
              title: newTitle,
              baseUrl: state.baseUrl || state.test.baseUrl,
              steps: state.steps.map((s) => s.step),
              variables: newVariables ?? state.test.variables,
            };

            saveTestCase(state.test);
            state.saveMessageVisible = true;
            console.log(`[debug-runner] Saved test case "${newId}"`);
            break;
          }
          case "start-record": {
            if (!state.recording) {
              state.recording = true;
              state.recordedCount = 0;
              const script = getDebugRecorderScript();
              await appPage.addInitScript(script);
              // Inject into main frame and every existing iframe so actions inside iframes are captured.
              for (const frame of appPage.frames()) {
                try {
                  await frame.evaluate(script);
                  await frame.evaluate(
                    "if (Array.isArray(window.__recordedActions)) window.__recordedActions.length = 0;"
                  );
                } catch {
                  // ignore frames that don't accept script (e.g. cross-origin)
                }
              }
              // Background loop pulls new recorded actions and appends them in real time.
              state.streamRecorderDone = streamRecordedActions(appPage, uiPage, state);
            }
            break;
          }
          case "stop-record": {
            if (!state.recording) break;
            state.recording = false;
            if (state.streamRecorderDone) {
              try {
                await state.streamRecorderDone;
              } catch {
                // ignore stream errors (e.g. page closed)
              }
              state.streamRecorderDone = undefined;
            }
            const actions = await collectRecordedActionsFromAllFrames(appPage);
            const lastCount = state.recordedCount ?? 0;
            if (actions && actions.length > lastCount) {
              const newOnes = actions.slice(lastCount);
              const appended = appendRecordedActionsToState(state, newOnes);
              state.recordedCount = actions.length;
              console.log(
                `[debug-runner] Appended ${appended} recorded action(s) as new steps at the bottom of the test.`
              );
            }
            // Reset session counters; array itself will be cleared on the next start-record.
            state.recordedCount = 0;
            break;
          }
          case "open-test": {
            state.saveMessageVisible = false;
            const freshTest = command.yamlContent
              ? loadTestCaseFromContent(command.yamlContent)
              : loadTestCase((command.testId ?? "").trim());
            if (!freshTest) {
              const hint = command.yamlContent ? "Invalid or empty YAML." : `Test case not found: ${(command.testId ?? "").trim()}.`;
              throw new Error(hint);
            }
            if (!freshTest.steps) freshTest.steps = [];
            state.test = freshTest;
            const env = { ...process.env, ...freshTest.env, ...options.env } as Record<string, string>;
            let baseUrlRaw = options.baseUrl ?? freshTest.baseUrl ?? "";
            if (!baseUrlRaw || baseUrlRaw === "{{baseUrl}}") {
              baseUrlRaw = (env.PLAYWRIGHT_LOGIN_URL as string) ?? baseUrlRaw;
            }
            state.baseUrl = baseUrlRaw;
            const resolved = baseUrlRaw ? substitute(baseUrlRaw, env) : "";
            env.BASE_URL = resolved;
            env.baseUrl = resolved;
            const evaluatedVars = evaluateVariables(freshTest.variables ?? {}, env);
            Object.assign(env, evaluatedVars);
            state.env = env;
            state.steps = (freshTest.steps ?? []).map((s, i) => ({
              index: i,
              step: { ...s },
              status: "pending",
              breakpoint: false,
              enabled: true,
            }));
            state.lastExecutedIndex = null;
            state.resumableFromIndex = undefined;
            await appPage.context().clearCookies();
            await appPage.goto("about:blank");
            break;
          }
          case "toggle-log":
            state.logPanelVisible = !state.logPanelVisible;
            break;
          case "clear-log":
            state.logs = [];
            break;
          case "toggle-breakpoint": {
            const entry = state.steps[command.index];
            if (entry) entry.breakpoint = !entry.breakpoint;
            break;
          }
          case "reset": {
            state.saveMessageVisible = false;
            state.resumableFromIndex = undefined;
            state.logs = [];
            // If recording, stop it and reset counters so no further actions are streamed.
            if (state.recording) {
              state.recording = false;
              if (state.streamRecorderDone) {
                try {
                  await state.streamRecorderDone;
                } catch {
                  // ignore
                }
                state.streamRecorderDone = undefined;
              }
              state.recordedCount = 0;
              try {
                await appPage.evaluate(
                  "if (Array.isArray(window.__recordedActions)) window.__recordedActions.length = 0;"
                );
              } catch {
                // ignore if recorder script is not present
              }
            }
            // Reset session state while preserving the current in-memory test,
            // including any cached/resolved locators, enabled flags, and unsaved edits.
            // Only env, per-step status, breakpoints, and browser/session state are reset.
            const freshTest = state.test;
            if (freshTest) {
              const env = {
                ...process.env,
                ...freshTest.env,
                ...options.env,
              } as Record<string, string>;
              let baseUrlRaw = options.baseUrl ?? freshTest.baseUrl ?? "";
              if (!baseUrlRaw || baseUrlRaw === "{{baseUrl}}") {
                baseUrlRaw = (env.PLAYWRIGHT_LOGIN_URL as string) ?? baseUrlRaw;
              }
              state.baseUrl = baseUrlRaw;
              const resolvedReset = baseUrlRaw ? substitute(baseUrlRaw, env) : "";
              env.BASE_URL = resolvedReset;
              env.baseUrl = resolvedReset;
              const evaluatedVars = evaluateVariables(freshTest.variables ?? {}, env);
              Object.assign(env, evaluatedVars);
              state.env = env;
              state.steps = (freshTest.steps ?? []).map((s, i) => {
                const prev = state.steps[i];
                return {
                  index: i,
                  step: { ...s },
                  status: "pending",
                  breakpoint: false,
                  // Reset should re-enable all actions, regardless of prior disabled state.
                  enabled: true,
                  // Preserve cached locator so replay performance is unchanged.
                  cachedLocator: prev?.cachedLocator,
                };
              });
              state.lastExecutedIndex = null;
            }
            await appPage.context().clearCookies();
            await appPage.goto("about:blank");
            break;
          }
          case "refresh":
            state.resumableFromIndex = undefined;
            break;
          default:
            // No-op; UI just wants to re-render.
            break;
        }
        const scrollState = await uiPage.evaluate(() => {
          const actionsPanel = document.querySelector(".debug-actions-panel") as
            | HTMLElement
            | null;
          return {
            windowY: (window as any).scrollY ?? 0,
            actionsY: actionsPanel ? actionsPanel.scrollTop : 0,
          };
        });
        await renderDebugUI(uiPage, state);
        await uiPage.evaluate((state: { windowY: number; actionsY: number }) => {
          window.scrollTo(0, state.windowY);
          const actionsPanel = document.querySelector(
            ".debug-actions-panel"
          ) as HTMLElement | null;
          if (actionsPanel) actionsPanel.scrollTop = state.actionsY;
          const logEl = document.getElementById("log-panel-content");
          if (logEl) logEl.scrollTop = logEl.scrollHeight;
        }, scrollState);
        if (state.resumableFromIndex != null) {
          await highlightCurrentStep(uiPage, state.resumableFromIndex);
        }
        return { ok: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[debug-runner] command failed:", msg);
        return { ok: false, error: msg };
      } finally {
        busy = false;
      }
    }
  );

  const sessionLabel = test.id
    ? `"${test.id}" (${test.title})`
    : `new empty session (${test.title})`;
  console.log(
    `Debug runner started for ${sessionLabel}.` +
    `\n- App page URL will be driven by Navigate steps (baseUrl: ${resolvedBaseUrl || "(none)"}; set in UI if empty)` +
    `\n- Debug UI is open in the second Playwright tab.`
  );
}

/** Set visual highlight on the step row at index (for run-all/run-from). */
async function highlightCurrentStep(uiPage: Page, index: number): Promise<void> {
  await uiPage.evaluate((idx: number) => {
    const body = document.getElementById("steps-body");
    if (!body) return;
    body.querySelectorAll("tr[data-index]").forEach((tr) => {
      (tr as HTMLElement).classList.toggle("step-current", tr.getAttribute("data-index") === String(idx));
    });
  }, index);
}

/** Remove current-step highlight from all rows. */
async function clearCurrentStepHighlight(uiPage: Page): Promise<void> {
  await uiPage.evaluate(() => {
    document.querySelectorAll("#steps-body tr.step-current").forEach((tr) => (tr as HTMLElement).classList.remove("step-current"));
  });
}

/** Strip "inside dialog" / "inside iframe" from element and return base + flags for dialog/iframe columns. */
function parseElementScope(element: string): { base: string; inDialog: boolean; inIframe: boolean } {
  let base = (element ?? "").trim();
  const inDialog = /\binside\s+dialog\b/i.test(base);
  const inIframe = /\binside\s+iframe\b/i.test(base);
  for (let prev = ""; prev !== base;) {
    prev = base;
    base = base.replace(/\s*inside\s+iframe\s*$/i, "").replace(/\s*inside\s+dialog\s*$/i, "").trim();
  }
  return { base, inDialog, inIframe };
}

const MAX_TOOLTIP_LEN = 500;
function tooltipText(raw: string): string {
  const s = raw.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\n/g, " ");
  return s.length <= MAX_TOOLTIP_LEN ? s : s.slice(0, MAX_TOOLTIP_LEN) + "…";
}
function hasVariable(s: string): boolean {
  return /\{\{[^}]*\}\}/.test(s ?? "");
}
/** Tooltip content: resolved value only, or "can't resolve {{...}}" when raw has variables that didn't resolve. */
function resolvedTooltipContent(raw: string, resolved: string): string {
  if (!hasVariable(raw)) return "";
  if (resolved && !hasVariable(resolved)) return tooltipText(resolved);
  return tooltipText("can't resolve " + raw);
}

async function renderDebugUI(page: Page, state: DebugSessionState): Promise<void> {
  const env = state.env;
  const rowsHtml = state.steps
    .map((s) => {
      const action = s.step.action;
      const { base: elementDisplay, inDialog, inIframe } = parseElementScope(s.step.element ?? "");
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
        <tr data-index="${s.index}" draggable="true"${enabled ? "" : ' class="step-disabled"'}>
          <td class="col-index"><span class="${bpClass}" data-role="toggle-breakpoint" data-index="${s.index}" title="Toggle breakpoint">${bpChar}</span> <span class="step-num">${s.index + 1}</span></td>
          <td class="col-action"><input draggable="false" data-field="action" data-index="${s.index}" value="${escapeHtml(
        String(action)
      )}" /></td>
          <td class="col-element"><input draggable="false" data-field="element" data-index="${s.index}" value="${escapeHtml(
        elementDisplay
      )}" ${elementResolved ? `data-resolved="${elementResolved}"` : ""} /></td>
          <td class="col-locator"><input draggable="false" data-field="locator" data-index="${s.index}" value="${escapeHtml(locatorDisplay)}" placeholder="" title="Locator"/></td>
          <td class="col-dialog" title="Inside dialog"><input draggable="false" type="checkbox" data-field="dialog" data-index="${s.index}" ${inDialog ? "checked" : ""} /></td>
          <td class="col-iframe" title="Inside iframe"><input draggable="false" type="checkbox" data-field="iframe" data-index="${s.index}" ${inIframe ? "checked" : ""} /></td>
          <td class="col-value"><input draggable="false" data-field="value" data-index="${s.index}" value="${escapeHtml(
        value
      )}" ${valueResolved ? `data-resolved="${valueResolved}"` : ""} /></td>
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

  const baseUrlRaw = state.baseUrl ?? "";
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
        return `<div class="variables-section-row"><input class="variables-section-name" data-field="variable-name" value="${escapeHtml(name)}" placeholder="name" /><input class="variables-section-value" data-field="variable" value="${escapeHtml(raw)}"${resolvedAttr} /><button type="button" class="variables-section-remove" data-role="remove-variable" title="Remove variable" aria-label="Remove variable">×</button></div>`;
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
      .meta label { font-weight: 600; margin-right: 2px; width: 70px; text-align: left; flex-shrink: 0; }
      .meta input { font-size: 13px; padding: 2px 4px; flex: 1 1 auto; min-width: 0; }
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
      /* Checkbox affordance: empty box off, box + green check when on */
      .toolbar-highlight-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 4px;
        font-size: 13px;
      }
      .toolbar-highlight-btn .highlight-checkbox {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .toolbar-highlight-btn .highlight-box {
        display: inline-block;
        width: 12px;
        height: 12px;
        border: 1px solid #555;
        border-radius: 2px;
        background: #fff;
        box-sizing: border-box;
        position: relative;
        vertical-align: middle;
      }
      .toolbar-highlight-btn .highlight-box.checked {
        border-color: #16a34a;
      }
      .toolbar-highlight-btn .highlight-box.checked::after {
        content: "\\2713";
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -58%);
        font-size: 10px;
        font-weight: 700;
        color: #16a34a;
        line-height: 1;
      }
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
      /* Row is draggable; keep native controls from starting a row drag (text selection, buttons). */
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
        border-bottom: 1px solid #444;
        cursor: pointer;
        user-select: none;
      }
      .log-panel-header span { font-weight: 600; }
      .log-panel-header button {
        margin-left: 6px;
        padding: 2px 6px;
        font-size: 12px;
        background: #444;
        color: #fff;
        border: none;
        border-radius: 2px;
        cursor: pointer;
      }
      .log-panel-header button:hover { background: #555; }
      .log-panel-resize-handle {
        height: 4px;
        background: #444;
        cursor: ns-resize;
        user-select: none;
      }
      #log-panel-content {
        height: 200px;
        min-height: 60px;
        max-height: 600px;
        overflow: auto;
        padding: 6px 8px;
        white-space: pre-wrap;
        word-break: break-all;
      }
      #log-panel-content .log-line { margin: 2px 0; }
      #log-panel-content .log-line.log-line-error { color: #c00; font-weight: 500; }
      .resolved-tooltip {
        position: fixed;
        z-index: 10000;
        max-width: 80vw;
        min-width: 200px;
        padding: 6px 10px;
        background: #333;
        color: #eee;
        border-radius: 4px;
        font-size: 12px;
        line-height: 1.4;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        pointer-events: none;
        display: none;
        word-break: break-all;
      }
      .resolved-tooltip.visible { display: block; }
      .test-picker-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 20000;
      }
      .test-picker-dialog {
        background: #fff;
        border-radius: 6px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.25);
        padding: 12px 14px;
        min-width: 360px;
        max-width: 520px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
      }
      .test-picker-title {
        font-weight: 600;
        margin-bottom: 4px;
      }
      .test-picker-subtitle {
        font-size: 12px;
        color: #666;
        margin-bottom: 8px;
      }
      .test-picker-list {
        overflow-y: auto;
        padding: 4px 0;
        margin-bottom: 8px;
      }
      .test-picker-file {
        font-weight: 600;
        font-size: 12px;
        color: #444;
        margin-top: 4px;
        margin-bottom: 2px;
      }
      .test-picker-item {
        width: 100%;
        text-align: left;
        padding: 3px 6px;
        margin-bottom: 2px;
        border-radius: 3px;
        border: 1px solid #ddd;
        background: #fafafa;
        cursor: pointer;
        font-size: 12px;
        box-sizing: border-box;
      }
      .test-picker-item:hover {
        background: #eef6ff;
        border-color: #66aaff;
      }
      .test-picker-actions {
        display: flex;
        justify-content: flex-end;
        margin-top: 4px;
      }
      .variables-section { margin-bottom: 6px; font-size: 13px; }
      .variables-section-header {
        cursor: pointer; user-select: none; color: #555; font-weight: 600;
        display: flex; align-items: center; gap: 4px;
        font-size: 13px;
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
    <div id="resolved-tooltip" class="resolved-tooltip" aria-hidden="true"></div>
    <div class="debug-top-panel">
      <div class="meta">
        <div class="meta-row">
          <label for="test-id-input">Test ID:</label>
          <input id="test-id-input" value="${escapeHtml(state.test.id)}" />
        </div>
        <div class="meta-row">
          <label for="test-title-input">Name:</label>
          <input id="test-title-input" value="${escapeHtml(state.test.title)}" />
        </div>
        <div class="meta-row">
          <label for="base-url-input">baseUrl:</label>
          <input id="base-url-input" value="${escapeHtml(
    baseUrlRaw
  )}" placeholder="Optional; used for {{baseUrl}} in steps" ${baseUrlResolved ? `data-resolved="${baseUrlResolved}"` : ""} />
        </div>
${variablesSectionHtml}
      </div>
      <input type="file" id="open-file-input" accept=".yaml" style="display:none" />
      <div class="toolbar">
        <button data-role="open-test" onclick="openTest()">Open</button>      
        <button data-role="run-all" data-resumable-from="${state.resumableFromIndex ?? ""}" onclick="runOrResume()">${state.resumableFromIndex != null ? "Resume" : "Run"} ▶</button>
        <button data-role="stop" onclick="stopPlayback()">Stop <span class="stop-icon">■</span></button>
        <button data-role="add-step" onclick="addStep()">Add step</button>
        <button data-role="move-selected-up" id="move-selected-up" onclick="moveSelectedStepUp()" title="Move selected step up">⬆</button>
        <button data-role="move-selected-down" id="move-selected-down" onclick="moveSelectedStepDown()" title="Move selected step down">⬇</button>
        <button data-role="record" id="record-toggle" onclick="toggleRecord()">Record</button>      
        <button data-role="save-test" onclick="saveTest()">Save</button>
        <button data-role="reset" onclick="resetSession()">Reset</button>
        <button
          type="button"
          id="highlight-interactive-btn"
          class="toolbar-highlight-btn"
          aria-pressed="${state.highlightInteractiveElements !== false ? "true" : "false"}"
          title="Toggle outline on interactive elements (hover + playback). Click to turn on or off."
          data-role="toggle-highlight"
          onclick="toggleHighlightInteractive()"
        >
          <span class="highlight-checkbox" aria-hidden="true"><span class="highlight-box${state.highlightInteractiveElements !== false ? " checked" : ""}"></span></span>Highlight
        </button>
        <button data-role="toggle-log" onclick="toggleLogPanel()">Log <span class="log-toggle-icon">${state.logPanelVisible ? "▼" : "▶"}</span></button>
        <button data-role="open-readme" onclick="openReadme()" title="Open README">?</button>
        <span id="save-message" class="save-message" style="display: ${state.saveMessageVisible ? "inline" : "none"}">${state.saveMessageVisible ? "Saved successfully." : ""}</span>
        <span id="busy-indicator" class="busy-indicator" aria-hidden="true"></span>
      </div>
    </div>
    <div class="debug-actions-panel">
      <div class="table-container">
      <table id="steps-table" class="locator-col-collapsed">
        <thead>
          <tr>
            <th class="col-index" data-col="index">#</th>
            <th class="col-action" data-col="action">action<div class="col-resize-handle"></div></th>
            <th class="col-element" data-col="element">element<div class="col-resize-handle"></div><span class="locator-toggle-in-element" id="locator-toggle-btn" title="Show/hide locator column">▶</span></th>
            <th class="col-locator" data-col="locator"><span class="locator-col-label">locator</span></th>
            <th class="col-dialog" data-col="dialog" title="Inside dialog">dialog</th>
            <th class="col-iframe" data-col="iframe" title="Inside iframe">iframe</th>
            <th class="col-value" data-col="value">value<div class="col-resize-handle"></div></th>
            <th class="col-status" data-col="status">status</th>
            <th class="col-run" data-col="run">run</th>
            <th class="col-edit" data-col="edit">edit</th>
          </tr>
        </thead>
        <tbody id="steps-body">
${rowsHtml}
        </tbody>
      </table>
      </div>
    </div>
    <div id="log-panel" class="${state.logPanelVisible ? "" : "log-panel-hidden"}">
      <div class="log-panel-header" onclick="toggleLogPanel()">
        <span>Log</span>
        <div>
          <button onclick="event.stopPropagation(); clearLog()">Clear</button>
        </div>
      </div>
      <div class="log-panel-resize-handle" id="log-resize-handle"></div>
      <div id="log-panel-content">${(state.logs ?? []).map((l) => {
    const item = typeof l === "string" ? { text: l, isError: false } : l;
    const cls = item.isError ? "log-line log-line-error" : "log-line";
    return `<div class="${cls}">${escapeHtml(item.text)}</div>`;
  }).join("")}</div>
    </div>
    <script>
    window.__uiplayEnv = ${JSON.stringify(state.env).replace(/<\/script>/gi, "\\u003c/script\\u003e")};
    (function() {
      const bodyEl = document.getElementById("steps-body");
      const recordToggle = document.getElementById("record-toggle");
      const env = window.__uiplayEnv || {};
      function hasVariable(s) {
        if (s == null) return false;
        return /\{\{[^}]*\}\}/.test(String(s));
      }
      function escapeRegex(s) {
        return String(s).replace(/[.*+?^\\x24{}()|[\\]\\\\]/g, "\\\\$&");
      }
      function substituteClient(str, envObj) {
        if (str == null) return "";
        let s = String(str);
        const e = envObj || {};
        const baseUrl = e.BASE_URL != null ? String(e.BASE_URL) : (e.baseUrl != null ? String(e.baseUrl) : "");
        s = s.replace(/\\\\{\\\\{baseUrl\\\\}\\\\}/gi, baseUrl);
        const keys = Object.keys(e);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          const v = e[k] != null ? String(e[k]) : "";
          const ek = escapeRegex(k);
          s = s.replace(new RegExp("\\\\{\\\\{env:" + ek + "\\\\}\\\\}", "gi"), v);
          s = s.replace(new RegExp("\\\\{\\\\{" + ek + "\\\\}\\\\}", "gi"), v);
        }
        return s;
      }
      function tooltipContent(raw, resolved) {
        if (!hasVariable(raw)) return "";
        if (resolved && !hasVariable(resolved)) return resolved.length > 500 ? resolved.slice(0, 500) + "…" : resolved;
        return "can't resolve " + raw;
      }
      function isResolvableInput(el) {
        if (!el || el.tagName !== "INPUT") return false;
        const field = el.getAttribute("data-field");
        if (field === "element" || field === "value" || field === "variable" || field === "variable-name") return true;
        if (el.id === "base-url-input") return true;
        return false;
      }
      const tooltipEl = document.getElementById("resolved-tooltip");
      if (tooltipEl) {
        document.body.addEventListener("mouseover", function(e) {
          const el = e.target && e.target.closest && e.target.closest("input");
          let text = "";
          if (el && isResolvableInput(el)) {
            const raw = el.value || "";
            let resolved = "";
            if (el.getAttribute("data-field") === "variable") {
              const row = el.closest && el.closest(".variables-section-row");
              const name = row ? (row.querySelector('input[data-field="variable-name"]') || {}).value : null;
              resolved = (name && env[name] != null) ? String(env[name]) : substituteClient(raw, env);
            } else if (el.getAttribute("data-field") === "variable-name") {
              resolved = (raw && env[raw] != null) ? String(env[raw]) : "";
            } else {
              resolved = substituteClient(raw, env);
            }
            text = tooltipContent(raw, resolved);
          } else {
            const withAttr = e.target && e.target.closest && e.target.closest("[data-resolved]");
            if (withAttr) text = withAttr.getAttribute("data-resolved") || "";
          }
          if (!text) return;
          tooltipEl.textContent = text;
          const rect = (el || (e.target && e.target.closest && e.target.closest("[data-resolved]")))?.getBoundingClientRect();
          if (rect) {
            tooltipEl.style.left = rect.left + "px";
            tooltipEl.style.top = (rect.bottom + 4) + "px";
          }
          tooltipEl.classList.add("visible");
        });
        document.body.addEventListener("mouseout", function(e) {
          const el = e.target && e.target.closest && e.target.closest("input");
          const withAttr = e.target && e.target.closest && e.target.closest("[data-resolved]");
          const from = el && isResolvableInput(el) ? el : withAttr;
          if (!from) return;
          if (e.relatedTarget && from.contains(e.relatedTarget)) return;
          tooltipEl.classList.remove("visible");
        });
      }
      const variablesSection = document.getElementById("variables-section");
      const variablesSectionContent = document.getElementById("variables-section-content");
      const variablesSectionHeader = variablesSection && variablesSection.querySelector(".variables-section-header");
      function updateVariablesCount() {
        if (!variablesSectionHeader) return;
        const n = variablesSectionContent ? variablesSectionContent.querySelectorAll(".variables-section-row").length : 0;
        variablesSectionHeader.innerHTML = "Variables (" + n + ") <span class=\\"variables-section-arrow\\">▶</span>";
      }
      if (variablesSection) {
        const variablesToggle = document.getElementById("variables-section-toggle");
        if (variablesToggle) {
          variablesToggle.addEventListener("click", function() {
            variablesSection.classList.toggle("collapsed");
          });
        }
      }
      if (variablesSectionContent) {
        const addVariableBtn = document.getElementById("add-variable-btn");
        if (addVariableBtn) {
          addVariableBtn.addEventListener("click", function() {
            const row = document.createElement("div");
            row.className = "variables-section-row";
            const nameInput = document.createElement("input");
            nameInput.className = "variables-section-name";
            nameInput.setAttribute("data-field", "variable-name");
            nameInput.placeholder = "name";
            const valueInput = document.createElement("input");
            valueInput.className = "variables-section-value";
            valueInput.setAttribute("data-field", "variable");
            const removeBtn = document.createElement("button");
            removeBtn.type = "button";
            removeBtn.className = "variables-section-remove";
            removeBtn.setAttribute("data-role", "remove-variable");
            removeBtn.title = "Remove variable";
            removeBtn.setAttribute("aria-label", "Remove variable");
            removeBtn.textContent = "×";
            row.appendChild(nameInput);
            row.appendChild(valueInput);
            row.appendChild(removeBtn);
            variablesSectionContent.insertBefore(row, addVariableBtn);
            updateVariablesCount();
          });
        }
      }
      document.body.addEventListener("click", function(e) {
        const removeBtn = e.target && e.target.closest && e.target.closest("[data-role=\\"remove-variable\\"]");
        if (!removeBtn) return;
        const row = removeBtn.closest && removeBtn.closest(".variables-section-row");
        if (row && variablesSectionContent && row.parentNode === variablesSectionContent) {
          row.remove();
          updateVariablesCount();
        }
      });
      bodyEl.addEventListener("dblclick", function(e) {
        const row = e.target && e.target.closest && e.target.closest("tr[data-index]");
        if (!row) return;
        const target = e.target;
        // Do not toggle disable when double-clicking inside inputs or buttons:
        // let the default behavior (e.g. select text) occur instead.
        if (
          target &&
          target.closest &&
          (target.closest("input, textarea, select, button") ||
            target.closest("button[data-role=\\"run-step\\"], button[data-action=\\"delete\\"]"))
        ) {
          return;
        }
        row.classList.toggle("step-disabled");
      });
      const locatorToggleBtn = document.getElementById("locator-toggle-btn");
      if (locatorToggleBtn) {
        locatorToggleBtn.addEventListener("click", function(e) { e.stopPropagation(); toggleLocatorColumn(); });
      }
      // Next numeric index to assign to newly added steps so they can run immediately.
      let nextIndex = ${state.steps.length};

      function readStepFromInputs(index) {
        const key = String(index);
        const get = (field) =>
          document.querySelector('input[data-field="' + field + '"][data-index="' + key + '"]')?.value ?? "";
        const getCheck = (field) =>
          document.querySelector('input[data-field="' + field + '"][data-index="' + key + '"]')?.checked ?? false;
        const base = (get("element") || "").trim();
        const inDialog = getCheck("dialog");
        const inIframe = getCheck("iframe");
        const element = base + (inDialog ? " inside dialog" : "") + (inIframe ? " inside iframe" : "");
        const originalIndex = Number(key);
        const payload = {
          action: get("action"),
          element: element,
          value: get("value"),
        };
        if (!Number.isNaN(originalIndex) && originalIndex >= 0) {
          payload.originalIndex = originalIndex;
        }
        const locator = (get("locator") || "").trim();
        if (locator) payload.locator = locator;
        const row = bodyEl.querySelector('tr[data-index="' + key + '"]');
        const isDisabled = row && row.classList.contains("step-disabled");
        // Always send an explicit enabled flag so UI changes (via double-click)
        // override any previous cached value on the backend.
        payload.enabled = !isDisabled;
        return payload;
      }

      function toggleLocatorColumn() {
        const table = document.getElementById("steps-table");
        const toggleSpan = document.getElementById("locator-toggle-btn");
        if (table && toggleSpan) {
          table.classList.toggle("locator-col-collapsed");
          toggleSpan.textContent = table.classList.contains("locator-col-collapsed") ? "▶" : "▼";
        }
      }

      function renumberDisplay() {
        const rows = bodyEl.querySelectorAll("tr[data-index]");
        let displayIndex = 1;
        rows.forEach((tr) => {
          const indexCell = tr.querySelector(".col-index");
          if (!indexCell) return;
          const numSpan = indexCell.querySelector(".step-num");
          if (numSpan) numSpan.textContent = String(displayIndex++);
          else indexCell.textContent = String(displayIndex++);
        });
      }

      function findRow(index) {
        const key = String(index);
        return bodyEl.querySelector('tr[data-index="' + key + '"]');
      }

      function moveStepUp(index) {
        const row = findRow(index);
        if (!row) return;
        const prev = row.previousElementSibling;
        if (!prev) return;
        bodyEl.insertBefore(row, prev);
        renumberDisplay();
      }

      function moveStepDown(index) {
        const row = findRow(index);
        if (!row) return;
        const next = row.nextElementSibling;
        if (!next) return;
        bodyEl.insertBefore(next, row);
        renumberDisplay();
      }

      function deleteStep(index) {
        if (document.body.classList.contains("busy")) return;
        if (recordToggle && recordToggle.classList.contains("recording")) return;
        const row = findRow(index);
        if (!row) return;
        bodyEl.removeChild(row);
        renumberDisplay();
      }

      // Drag-and-drop reordering of steps.
      let dragRow = null;
      let selectedIndex = null;
      const ROW_DRAG_BLOCK_SEL =
        "input, textarea, select, button, [contenteditable='true']";
      let rowDragBlockFromControl = false;

      function eventPathTouchesRowDragBlock(e) {
        const path =
          typeof e.composedPath === "function" ? e.composedPath() : [e.target];
        for (let i = 0; i < path.length; i++) {
          const n = path[i];
          if (n instanceof Element && n.matches(ROW_DRAG_BLOCK_SEL)) return true;
        }
        return false;
      }

      function setSelectedIndex(idxAttr) {
        const rows = bodyEl.querySelectorAll("tr[data-index]");
        rows.forEach((tr) => {
          tr.classList.toggle(
            "step-selected",
            idxAttr != null && tr.getAttribute("data-index") === String(idxAttr)
          );
        });
        selectedIndex = idxAttr != null ? String(idxAttr) : null;
        const upBtn = document.getElementById("move-selected-up");
        const downBtn = document.getElementById("move-selected-down");
        const rowArray = Array.from(rows);
        if (upBtn && downBtn) {
          if (selectedIndex == null || rowArray.length === 0) {
            upBtn.disabled = true;
            downBtn.disabled = true;
          } else {
            const idx = rowArray.findIndex(
              (tr) => tr.getAttribute("data-index") === String(selectedIndex)
            );
            upBtn.disabled = idx <= 0;
            downBtn.disabled = idx < 0 || idx >= rowArray.length - 1;
          }
        }
      }

      // Initialize with no selection so toolbar arrows start disabled.
      setSelectedIndex(null);
      bodyEl.addEventListener("mousedown", function(e) {
        const t = e.target;
        rowDragBlockFromControl =
          t instanceof Element && !!t.closest(ROW_DRAG_BLOCK_SEL);
      }, true);
      bodyEl.addEventListener("mouseup", function() {
        rowDragBlockFromControl = false;
      }, true);
      bodyEl.addEventListener("dragstart", function(e) {
        if (
          rowDragBlockFromControl ||
          eventPathTouchesRowDragBlock(e)
        ) {
          e.preventDefault();
          return;
        }
        const tr = e.target && e.target.closest && e.target.closest("tr[data-index]");
        if (!tr) return;
        dragRow = tr;
        setSelectedIndex(tr.getAttribute("data-index"));
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          // Required for Firefox
          e.dataTransfer.setData("text/plain", tr.getAttribute("data-index") || "");
        }
      });
      bodyEl.addEventListener("dragover", function(e) {
        if (!dragRow) return;
        const tr = e.target && e.target.closest && e.target.closest("tr[data-index]");
        if (!tr || tr === dragRow) return;
        e.preventDefault();
        const rect = tr.getBoundingClientRect();
        const offset = e.clientY - rect.top;
        const before = offset < rect.height / 2;
        if (before) {
          bodyEl.insertBefore(dragRow, tr);
        } else {
          if (tr.nextSibling) {
            bodyEl.insertBefore(dragRow, tr.nextSibling);
          } else {
            bodyEl.appendChild(dragRow);
          }
        }
        renumberDisplay();
      });
      bodyEl.addEventListener("drop", function(e) {
        if (dragRow) {
          e.preventDefault();
        }
        dragRow = null;
      });
      bodyEl.addEventListener("dragend", function() {
        dragRow = null;
        rowDragBlockFromControl = false;
      });

      function moveSelectedStepUp() {
        if (selectedIndex == null) return;
        moveStepUp(selectedIndex);
        setSelectedIndex(selectedIndex);
      }

      function moveSelectedStepDown() {
        if (selectedIndex == null) return;
        moveStepDown(selectedIndex);
        setSelectedIndex(selectedIndex);
      }

      function clearSaveMessage() {
        const el = document.getElementById("save-message");
        if (el) {
          el.textContent = "";
          el.style.display = "none";
        }
      }

      function setStepPlaybackButtonsDisabled(disabled) {
        bodyEl.querySelectorAll(
          'button[data-role="run-step"], button[data-action="delete"]'
        ).forEach((b) => {
          b.disabled = disabled;
        });
      }

      function updateRecordButton(isOn) {
        if (!recordToggle) return;
        const toolbarButtons = document.querySelectorAll(
          '.toolbar button[data-role]'
        );
        if (isOn) {
          recordToggle.textContent = "Stop recording";
          recordToggle.classList.add("record-toggle", "recording");
          toolbarButtons.forEach((btnEl) => {
            const btn = btnEl;
            const role = btn.getAttribute("data-role");
            // While recording, only allow: Stop recording (record), Log, and ? (open-readme).
            const allowed =
              role === "record" ||
              role === "toggle-log" ||
              role === "toggle-highlight" ||
              role === "open-readme";
            if (!allowed) btn.disabled = true;
          });
          setStepPlaybackButtonsDisabled(true);
        } else {
          recordToggle.textContent = "Record";
          recordToggle.classList.remove("recording");
          toolbarButtons.forEach((btnEl) => {
            const btn = btnEl;
            const role = btn.getAttribute("data-role");
            // Re-enable all toolbar buttons when not recording; sendCommand will
            // still temporarily disable them during in-flight commands.
            // Do not override selection-based disabled state for move-selected arrows.
            if (role === "move-selected-up" || role === "move-selected-down") return;
            btn.disabled = false;
          });
          setStepPlaybackButtonsDisabled(false);
        }
      }

      function addStep() {
        clearSaveMessage();
        const id = nextIndex++;
        const tr = document.createElement("tr");
        tr.setAttribute("data-index", id);
        tr.draggable = true;
        tr.innerHTML =
          '<td class="col-index"><span class="breakpoint-toggle" data-role="toggle-breakpoint" data-index="' +
          id +
          '" title="Toggle breakpoint">○</span> <span class="step-num">' +
          (id + 1) +
          "</span></td>" +
          '<td class="col-action"><input draggable="false" data-field="action" data-index="' +
          id +
          '" value="click" /></td>' +
          '<td class="col-element"><input draggable="false" data-field="element" data-index="' +
          id +
          '" value="" /></td>' +
          '<td class="col-locator"><input draggable="false" data-field="locator" data-index="' +
          id +
          '" value="" placeholder="" /></td>' +
          '<td class="col-dialog" title="Inside dialog"><input draggable="false" type="checkbox" data-field="dialog" data-index="' +
          id +
          '" /></td>' +
          '<td class="col-iframe" title="Inside iframe"><input draggable="false" type="checkbox" data-field="iframe" data-index="' +
          id +
          '" /></td>' +
          '<td class="col-value"><input draggable="false" data-field="value" data-index="' +
          id +
          '" value="" /></td>' +
          '<td class="col-status status-pending"></td>' +
          '<td class="col-run"><button data-role="run-step" data-index="' +
          id +
          '">▶</button></td>' +
          '<td class="col-edit">' +
          '<button title="Delete" data-action="delete" data-index="' +
          id +
          '">✕</button>' +
          "</td>";
        bodyEl.appendChild(tr);
        renumberDisplay();
        if (recordToggle && recordToggle.classList.contains("recording")) {
          setStepPlaybackButtonsDisabled(true);
        }
      }

      async function sendCommand(cmd) {
        if (!window.uiplayDebugControl) {
          console.error("uiplayDebugControl binding is not available.");
          return;
        }
        const baseUrlInput = document.getElementById("base-url-input");
        const baseUrl =
          baseUrlInput && baseUrlInput instanceof HTMLInputElement
            ? baseUrlInput.value || ""
            : "";
        const fullCmd = Object.assign({ baseUrl }, cmd);
        // Disable run/save buttons while a command is in flight.
        const allButtons = document.querySelectorAll(
          'button[data-role="open-test"], button[data-role="add-step"], button[data-role="record"], button[data-role="run-step"], button[data-role="run-all"], button[data-role="save-test"], button[data-role="reset"], button[data-action="delete"]'
        );
        allButtons.forEach((b) => (b.disabled = true));
        document.body.classList.add("busy");
        try {
          const result = await window.uiplayDebugControl(fullCmd);
          if (!result?.ok && result?.error) {
            console.error("debug command failed:", result.error);
            alert(result.error);
          }
          return result;
        } catch (e) {
          console.error("debug command error:", e);
          alert(String(e));
        } finally {
          document.body.classList.remove("busy");
          allButtons.forEach((b) => (b.disabled = false));
          // sendCommand re-enabled toolbar run-all etc.; restore recording constraints if still active.
          if (recordToggle && recordToggle.classList.contains("recording")) {
            updateRecordButton(true);
          }
        }
      }

      async function runStep(index) {
        if (recordToggle && recordToggle.classList.contains("recording")) return;
        clearSaveMessage();
        const numericIndex = Number(index);
        if (Number.isNaN(numericIndex)) {
          console.error("Invalid step index", index);
          return;
        }
        const step = readStepFromInputs(index);
        const steps = [];
        const rows = document.querySelectorAll("tr[data-index]");
        rows.forEach((tr) => {
          const idxAttr = tr.getAttribute("data-index") || "";
          steps.push(readStepFromInputs(idxAttr));
        });
        await sendCommand({ type: "run-step", index: numericIndex, stepOverride: step, steps });
        // After command, Node will re-render this page with updated status.
      }

      function collectSteps() {
        const steps = [];
        const rows = document.querySelectorAll("tr[data-index]");
        rows.forEach((tr) => {
          const idxAttr = tr.getAttribute("data-index") || "";
          steps.push(readStepFromInputs(idxAttr));
        });
        return steps;
      }

      async function runAll() {
        clearSaveMessage();
        await sendCommand({ type: "run-all", steps: collectSteps() });
      }

      async function runOrResume() {
        clearSaveMessage();
        const btn = document.querySelector('button[data-role="run-all"]');
        const from = btn && btn.getAttribute("data-resumable-from");
        if (from !== "" && from !== null) {
          const index = parseInt(from, 10);
          if (!isNaN(index) && index >= 0) {
            await sendCommand({ type: "run-from", index, steps: collectSteps() });
            return;
          }
        }
        await runAll();
      }

      function stopPlayback() {
        if (!window.uiplayDebugControl) return;
        const baseUrlInput = document.getElementById("base-url-input");
        const baseUrl = baseUrlInput && baseUrlInput instanceof HTMLInputElement ? baseUrlInput.value || "" : "";
        window.uiplayDebugControl({ type: "stop", baseUrl });
      }

      async function resetSession() {
        clearSaveMessage();
        await sendCommand({ type: "reset" });
      }

      async function toggleRecord() {
        clearSaveMessage();
        const isOn = recordToggle && recordToggle.classList.contains("recording");
        updateRecordButton(!isOn);
        await sendCommand({ type: isOn ? "stop-record" : "start-record" });
      }

      function toggleLogPanel() {
        const panel = document.getElementById("log-panel");
        const btn = document.querySelector('button[data-role="toggle-log"]');
        if (!panel || !btn) return;
        const hidden = panel.classList.toggle("log-panel-hidden");
        const icon = btn.querySelector(".log-toggle-icon");
        if (icon) icon.textContent = hidden ? "▶" : "▼";

        // Also tell the server so future re-renders respect the current state.
        if (window.uiplayDebugControl) {
          const baseUrlInput = document.getElementById("base-url-input");
          const baseUrl =
            baseUrlInput && baseUrlInput instanceof HTMLInputElement
              ? baseUrlInput.value || ""
              : "";
          window.uiplayDebugControl({ type: "toggle-log", baseUrl });
        }
      }

      function toggleHighlightInteractive() {
        const btn = document.getElementById("highlight-interactive-btn");
        if (!btn || !(btn instanceof HTMLButtonElement) || !window.uiplayDebugControl) return;
        const wasOn = btn.getAttribute("aria-pressed") === "true";
        const next = !wasOn;
        btn.setAttribute("aria-pressed", next ? "true" : "false");
        const box = btn.querySelector(".highlight-box");
        if (box) box.classList.toggle("checked", next);
        window.uiplayDebugControl({ type: "toggle-highlight-interactive", enabled: next });
      }

      function openReadme() {
        if (!window.uiplayDebugControl) return;
        window.uiplayDebugControl({ type: "open-readme" });
      }

      async function clearLog() {
        // Clear log without affecting button disabled state during long-running commands.
        if (!window.uiplayDebugControl) return;
        const baseUrlInput = document.getElementById("base-url-input");
        const baseUrl =
          baseUrlInput && baseUrlInput instanceof HTMLInputElement
            ? baseUrlInput.value || ""
            : "";
        try {
          await window.uiplayDebugControl({ type: "clear-log", baseUrl });
        } catch (e) {
          console.error("clear-log command error:", e);
        }
      }

      async function openTest() {
        clearSaveMessage();

        // If the bridge is not available yet, fall back to the original file picker behavior.
        if (!window.uiplayDebugControl) {
          const fileInput = document.getElementById("open-file-input");
          if (!fileInput || !(fileInput instanceof HTMLInputElement)) return;
          fileInput.value = "";
          fileInput.onchange = async function() {
            if (!fileInput.files || fileInput.files.length === 0) return;
            const file = fileInput.files[0];
            const content = await file.text();
            fileInput.onchange = null;
            await sendCommand({ type: "open-test", yamlContent: content });
          };
          fileInput.click();
          return;
        }

        const result = await sendCommand({ type: "list-tests" });
        if (!result || !result.ok) return;
        const groups = (result && result.tests) ? result.tests : [];
        if (!Array.isArray(groups) || groups.length === 0) {
          alert("No test cases found in tests directory.");
          return;
        }

        const existing = document.getElementById("test-picker-overlay");
        if (existing && existing.parentElement) {
          existing.parentElement.removeChild(existing);
        }

        const overlay = document.createElement("div");
        overlay.id = "test-picker-overlay";
        overlay.className = "test-picker-overlay";

        const dialog = document.createElement("div");
        dialog.className = "test-picker-dialog";

        const title = document.createElement("div");
        title.className = "test-picker-title";
        title.textContent = "Open test case";
        dialog.appendChild(title);

        const subtitle = document.createElement("div");
        subtitle.className = "test-picker-subtitle";
        subtitle.textContent = "Tests from uiplay/tests (ordered by file name).";
        dialog.appendChild(subtitle);

        const list = document.createElement("div");
        list.className = "test-picker-list";

        groups.forEach((group) => {
          const fileHeader = document.createElement("div");
          fileHeader.className = "test-picker-file";
          fileHeader.textContent = group.file;
          list.appendChild(fileHeader);

          (group.tests || []).forEach((t) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "test-picker-item";
            item.textContent = t.id + (t.title ? " — " + t.title : "");
            item.addEventListener("click", async () => {
              if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
              await sendCommand({ type: "open-test", testId: t.id });
            });
            list.appendChild(item);
          });
        });

        dialog.appendChild(list);

        const actions = document.createElement("div");
        actions.className = "test-picker-actions";
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.textContent = "Close";
        closeBtn.addEventListener("click", () => {
          if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
        });
        actions.appendChild(closeBtn);
        dialog.appendChild(actions);

        overlay.appendChild(dialog);
        overlay.addEventListener("click", (e) => {
          if (e.target === overlay && overlay.parentElement) {
            overlay.parentElement.removeChild(overlay);
          }
        });

        document.body.appendChild(overlay);
      }

      async function saveTest() {
        const id = document.getElementById("test-id-input").value || "";
        const title = document.getElementById("test-title-input").value || "";
        const steps = [];
        const rows = document.querySelectorAll("tr[data-index]");
        rows.forEach((tr) => {
          const idxAttr = tr.getAttribute("data-index") || "";
          const step = readStepFromInputs(idxAttr);
          steps.push(step);
        });
        const variables = {};
        document.querySelectorAll(".variables-section-row").forEach((row) => {
          const nameInput = row.querySelector('input[data-field="variable-name"]');
          const valueInput = row.querySelector('input[data-field="variable"]');
          const name = nameInput && nameInput.value ? nameInput.value.trim() : "";
          if (name) variables[name] = (valueInput && valueInput.value) || "";
        });
        await sendCommand({ type: "save-test", id, title, steps, variables });
      }

      // Handle button clicks inside the steps table (run / move / delete / breakpoint).
      bodyEl.addEventListener("click", (e) => {
        const target = e.target;
        if (!target || !(target instanceof HTMLElement)) return;

        if (target.matches('[data-role="toggle-breakpoint"]')) {
          const idxAttr = target.getAttribute("data-index");
          if (idxAttr != null) {
            const idx = parseInt(idxAttr, 10);
            if (!isNaN(idx)) sendCommand({ type: "toggle-breakpoint", index: idx });
          }
          return;
        }

        if (target.matches('button[data-role="run-step"]')) {
          if (recordToggle && recordToggle.classList.contains("recording")) return;
          const idxAttr = target.getAttribute("data-index");
          if (!idxAttr) return;
          setSelectedIndex(idxAttr);
          runStep(idxAttr);
          return;
        }

        const row = target.closest && target.closest("tr[data-index]");
        if (row) {
          const idxAttr = row.getAttribute("data-index");
          if (idxAttr != null) setSelectedIndex(idxAttr);
        }

        const action = target.getAttribute("data-action");
        if (!action) return;
        const idxAttr = target.getAttribute("data-index");
        if (!idxAttr) return;
        if (action === "delete") {
          if (document.body.classList.contains("busy")) return;
          if (recordToggle && recordToggle.classList.contains("recording")) return;
          deleteStep(idxAttr);
          // Clear selection if the selected row was deleted.
          if (selectedIndex === idxAttr) setSelectedIndex(null);
        }
      });

      function setupColumnResizing() {
        const table = document.querySelector("table");
        if (!table) return;
        let startX = 0;
        let startWidth = 0;
        let activeCol = null;

        function onMouseMove(e) {
          if (!activeCol) return;
          const delta = e.clientX - startX;
          const newWidth = Math.max(60, startWidth + delta);
          const selector =
            '.col-' + activeCol + ', th[data-col="' + activeCol + '"]';
          document.querySelectorAll(selector).forEach((el) => {
            el.style.width = newWidth + "px";
            el.style.maxWidth = newWidth + "px";
          });
        }

        function onMouseUp() {
          activeCol = null;
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
        }

        table.addEventListener("mousedown", (e) => {
          const handle = e.target.closest(".col-resize-handle");
          if (!handle) return;
          e.preventDefault();
          const th = handle.parentElement;
          if (!th) return;
          const col = th.getAttribute("data-col");
          if (!col) return;
          activeCol = col;
          startX = e.clientX;
          startWidth = th.offsetWidth;
          document.addEventListener("mousemove", onMouseMove);
          document.addEventListener("mouseup", onMouseUp);
        });
      }

      setupColumnResizing();

      // Expose functions used in inline onclick attributes.
      // Use plain JS (no TS assertions) so this runs correctly in the browser.
      window.runStep = runStep;
      window.runAll = runAll;
      window.runOrResume = runOrResume;
      window.stopPlayback = stopPlayback;
      window.saveTest = saveTest;
      window.resetSession = resetSession;
      window.openTest = openTest;
      window.toggleRecord = toggleRecord;
      // Initialize record button based on server state.
      updateRecordButton(${state.recording ? "true" : "false"});
      window.moveStepUp = moveStepUp;
      window.moveStepDown = moveStepDown;
      window.deleteStep = deleteStep;
      window.addStep = addStep;
      window.toggleLogPanel = toggleLogPanel;
      window.toggleHighlightInteractive = toggleHighlightInteractive;
      window.openReadme = openReadme;
      window.clearLog = clearLog;
      window.moveSelectedStepUp = moveSelectedStepUp;
      window.moveSelectedStepDown = moveSelectedStepDown;

      function setupLogPanelResize() {
        const handle = document.getElementById("log-resize-handle");
        const content = document.getElementById("log-panel-content");
        if (!handle || !content) return;
        let startY = 0, startHeight = 0;
        handle.addEventListener("mousedown", function(e) {
          e.preventDefault();
          startY = e.clientY;
          startHeight = content.offsetHeight;
          document.addEventListener("mousemove", onMouseMove);
          document.addEventListener("mouseup", onMouseUp);
        });
        function onMouseMove(e) {
          const dy = e.clientY - startY;
          const newHeight = Math.max(60, Math.min(600, startHeight + dy));
          content.style.height = newHeight + "px";
        }
        function onMouseUp() {
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
        }
      }
      setupLogPanelResize();
    })();
    </script>
  </body>
</html>`;

  await page.setContent(html, { waitUntil: "load" });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function runSingleStep(
  page: Page,
  state: DebugSessionState,
  index: number,
  stepOverride: Partial<StepIntent> | undefined,
  options: DebugRunOptions,
  uiPage: Page,
  stopAbortPromise?: Promise<never>
): Promise<void> {
  const logCallback = (msg: string) => {
    state.logs = state.logs ?? [];
    state.logs.push({ text: msg, isError: false });
    uiPage.evaluate(
      (m) => {
        const el = document.getElementById("log-panel-content");
        if (el) {
          const line = document.createElement("div");
          line.className = "log-line";
          line.textContent = m;
          el.appendChild(line);
          el.scrollTop = el.scrollHeight;
        }
      },
      msg
    ).catch(() => { });
  };
  let entry = state.steps[index];
  const original = entry?.step;

  const effectiveAction = (stepOverride?.action || original?.action || "click") as StepIntent["action"];

  // For pause steps, treat the "value" field in the UI as seconds.
  let seconds = original?.seconds;
  if (effectiveAction === "pause") {
    const rawSeconds = stepOverride?.value ?? (original?.value ?? "");
    const parsed = Number((rawSeconds ?? "").toString().trim());
    seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  const base: StepIntent = original ?? { action: effectiveAction };
  const step: StepIntent = {
    ...base,
    action: effectiveAction,
    seconds,
  };

  if (stepOverride?.element !== undefined) {
    step.element = stepOverride.element;
  }
  if (stepOverride?.value !== undefined) {
    if (effectiveAction === "navigate") {
      // For navigate, treat the value input as the URL (e.g. "{{baseUrl}}").
      step.url = stepOverride.value;
    } else {
      step.value = stepOverride.value;
    }
  }

  if (!entry) {
    // New step created only in the debug UI: add it to in-memory state so it can be run without saving.
    entry = {
      index,
      step,
      status: "pending",
      breakpoint: false,
      enabled: true,
    };
    state.steps[index] = entry;
  } else {
    entry.step = step;
    entry.status = "running";
    entry.lastError = undefined;
  }

  const progress = { actionPerformed: false };
  try {
    await executeStep(page, state, index, step, options, logCallback, stopAbortPromise, progress);
    entry.status = "passed";
    state.lastExecutedIndex = index;
  } catch (e) {
    if (e instanceof Error && e.message === "Stopped") {
      // If the core action for this step has already run (e.g. click fired) and we
      // were only waiting for page stabilization when Stop was pressed, treat the
      // step as passed so Run all/Resume moves on to the next step.
      if (entry && (progress as any).actionPerformed) {
        entry.status = "passed";
        state.lastExecutedIndex = index;
        return;
      }
      entry.status = "pending";
      return;
    }
    entry.status = "failed";
    entry.lastError = e instanceof Error ? e.message : String(e);
    console.error("[debug-runner] step failed:", entry.lastError);
    state.logPanelVisible = true;
    state.logs = state.logs ?? [];
    state.logs.push({ text: entry.lastError, isError: true });
  }
}

const PLAYBACK_HIGHLIGHT_REMOVE_MS = 1200;

/**
 * Green box + center dot on the resolved element during debug playback (matches “click target” affordance).
 * Uses overlay in the page; not Playwright’s default red inspector highlight.
 */
async function showGreenPlaybackHighlight(
  loc: Locator,
  raceStop: <T>(p: Promise<T>) => Promise<T>
): Promise<void> {
  const box = await raceStop(loc.boundingBox());
  if (!box || box.width < 1 || box.height < 1) return;
  const page = loc.page();
  await raceStop(
    page.evaluate(
      ({
        x,
        y,
        w,
        h,
        ms,
      }: {
        x: number;
        y: number;
        w: number;
        h: number;
        ms: number;
      }) => {
        const root = document.documentElement;
        if (!root) return;
        document.querySelectorAll("[data-uiplay-playback-highlight]").forEach((n) => n.remove());
        const layer = document.createElement("div");
        layer.setAttribute("data-uiplay-playback-highlight", "1");
        layer.style.cssText =
          "position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:visible";
        const boxEl = document.createElement("div");
        boxEl.style.cssText =
          "position:absolute;left:" +
          x +
          "px;top:" +
          y +
          "px;width:" +
          w +
          "px;height:" +
          h +
          "px;box-sizing:border-box;border:3px solid #22c55e;border-radius:4px;" +
          "background:rgba(34,197,94,0.14);box-shadow:0 0 0 1px rgba(34,197,94,0.45)";
        const dotR = 6;
        const dot = document.createElement("div");
        dot.style.cssText =
          "position:absolute;left:" +
          (x + w / 2 - dotR) +
          "px;top:" +
          (y + h / 2 - dotR) +
          "px;width:" +
          dotR * 2 +
          "px;height:" +
          dotR * 2 +
          "px;border-radius:50%;background:#16a34a;border:2px solid #fff;" +
          "box-shadow:0 1px 5px rgba(0,0,0,0.28)";
        layer.appendChild(boxEl);
        layer.appendChild(dot);
        root.appendChild(layer);
        setTimeout(() => layer.remove(), ms);
      },
      { x: box.x, y: box.y, w: box.width, h: box.height, ms: PLAYBACK_HIGHLIGHT_REMOVE_MS }
    )
  );
}

/**
 * Outline the target element during debug playback (Run step / Run all).
 * Pointer-move highlighting only runs for the user's mouse; automation needs this so clicks/fills are visible.
 */
async function highlightPlaybackTargetIfEnabled(
  loc: Locator,
  state: DebugSessionState,
  raceStop: <T>(p: Promise<T>) => Promise<T>
): Promise<void> {
  if (state.highlightInteractiveElements === false) return;
  try {
    await showGreenPlaybackHighlight(loc, raceStop);
  } catch {
    // detached node, strict violation, etc.
  }
}

async function executeStep(
  page: Page,
  state: DebugSessionState,
  index: number,
  step: StepIntent,
  options: DebugRunOptions,
  onLog?: (msg: string) => void,
  stopAbortPromise?: Promise<never>,
  progress?: { actionPerformed: boolean }
): Promise<void> {
  const env = state.env;
  const steps = state.steps.map((s) => s.step);
  const timeouts = getUiplayConfig().timeouts;
  const locatorTimeoutMs = options.locatorTimeoutMs ?? timeouts.discovery.locatorStrategyMs;

  async function raceStop<T>(p: Promise<T>): Promise<T> {
    if (!stopAbortPromise) return p;
    return Promise.race([p, stopAbortPromise]);
  }

  async function waitForPageStable() {
    try {
      // Use a longer timeout for debug runs so long redirects or slow-rendering
      // pages have a chance to finish loading before we resolve elements.
      await raceStop(page.waitForLoadState("networkidle", { timeout: timeouts.page.networkIdleMs }));
    } catch {
      // ignore; actions still have explicit waits
    }
  }

  /** After click/double-click, if the URL changes (e.g. search submit), wait for DOM + network idle so the next step resolves real elements. */
  async function postClickNavigationSettle(urlBeforeClick: string) {
    const maxMs = timeouts.debugRunner.postClickUrlChangeDetectMs ?? 800;
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      let u = urlBeforeClick;
      try {
        u = await page.url();
      } catch {
        return;
      }
      if (u !== urlBeforeClick) {
        if (onLog) {
          onLog(
            `[debug] URL changed after click; waiting for load + network idle before next step`
          );
        }
        await raceStop(
          page.waitForLoadState("domcontentloaded", {
            timeout: timeouts.page.loadFallbackMs,
          }).catch(() => {})
        );
        await raceStop(waitForPageStable());
        return;
      }
      await raceStop(page.waitForTimeout(30));
    }
  }

  // Only wait for page stability on the very first step or on explicit
  // navigate steps. For other actions (e.g. clicking a Continue button that
  // triggers a slow load), move on to the next step as soon as the action
  // itself has been performed rather than waiting for all background loading.
  let urlBefore = "";
  try {
    urlBefore = await page.url();
  } catch {
    // ignore URL read errors
  }
  if (index === 0 || step.action === "navigate") {
    if (onLog) onLog(`[debug] Waiting for page to stabilize before step ${index + 1} (action=${step.action})`);
    await raceStop(waitForPageStable());
  }

  const logicalKey = step.element ?? `step_${index}`;
  const safeKey = logicalKey.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, "");

  if (onLog) {
    onLog(`[debug] Executing step ${index + 1}: ${step.action} ${step.element ?? ""} ${step.value ?? ""}`.trim());
  }

  if (step.action === "navigate") {
    const rawUrl = step.url ? substitute(step.url, env) : "";
    const effectiveBaseUrl = state.baseUrl ? substitute(state.baseUrl, env) : "";
    let url = resolveNavigateUrl(rawUrl, effectiveBaseUrl);
    if (url && !isFullUrl(url)) {
      try {
        const current = page.url();
        if (current && current !== "about:blank") {
          url = new URL(url, current).href;
        }
      } catch {
        // keep url as-is
      }
    }
    if (url) {
      await raceStop(page.goto(url, { waitUntil: "domcontentloaded" }));
    }
    await raceStop(page.waitForTimeout(timeouts.debugRunner.postNavigateMs));
    return;
  }

  if (step.action === "pause") {
    const secs = typeof step.seconds === "number" ? step.seconds : undefined;
    if (secs && secs > 0) {
      await raceStop(page.waitForTimeout(secs * 1000));
    }
    // If no positive seconds are set, treat pause as a no-op in the debug panel.
    return;
  }

  // Prefer any explicit locator the user provided in the step; otherwise
  // use the debugger's cached locator for this row (if present).
  const rowState = state.steps[index];
  const effectiveLocator =
    (step.locator && step.locator.trim()) ||
    (rowState?.cachedLocator && rowState.cachedLocator.trim()) ||
    "";

  const stepForResolve: StepIntent =
    step.element != null
      ? {
          ...step,
          element: substitute(step.element, env),
          ...(effectiveLocator ? { locator: effectiveLocator } : {}),
        }
      : {
          ...step,
          ...(effectiveLocator ? { locator: effectiveLocator } : {}),
        };

  // Upload "file input": no DOM file input; we may delegate to previous click.
  let resolved = await raceStop(
    resolveLocator(page, stepForResolve, {
      debug: !!onLog,
      timeoutMs: locatorTimeoutMs,
      onLog,
      // When an explicit locator is present (including one populated by a previous
      // successful resolution in this debug session), prefer it but fall back to
      // the normal resolver if it no longer matches. This acts as a cache layer
      // while still allowing element-based strategies as a safety net.
      fallbackOnExplicitLocatorFailure: true,
      abortPromise: stopAbortPromise,
    })
  );
  if (!resolved) {
    throw new Error(
      `Could not resolve element for step ${index + 1}: ${step.element ?? "(no element)"}`
    );
  }

  if (onLog) {
    onLog(`[debug] Resolved locator: ${resolved.stored}`);
  }

  // Cache the resolved locator onto the debug step state only (not into the
  // StepIntent or YAML), so subsequent runs can reuse it without polluting
  // the locator column or saved test.
  const canonical = resolved.stored;
  const row = state.steps[index];
  if (row) {
    row.cachedLocator = canonical;
    state.steps[index] = row;
  }

  const locForClick = resolved.clickLocator ?? resolved.locator;
  const locForFill = resolved.fillLocator ?? resolved.locator;
  const loc = resolved.locator;

  switch (step.action) {
    case "click": {
      const urlBeforeClick = await page.url();
      const rawFromStep = step.value ? substitute(step.value, env) : "";
      const filePathFromStep = rawFromStep ? resolveUploadFilePath(rawFromStep) : "";
      const nextStep = steps[index + 1];
      const nextIsUploadFileInput =
        !step.value &&
        nextStep?.action === "upload" &&
        (nextStep.element === "file input" ||
          (nextStep.element ?? "")
            .replace(/\s+/g, "_")
            .replace(/[^a-zA-Z0-9_]/g, "") === "file_input") &&
        nextStep.value;
      const filePath = filePathFromStep
        || (nextIsUploadFileInput
          ? resolveUploadFilePath(substitute(nextStep!.value!, env))
          : "");
      if (filePath) {
        await highlightPlaybackTargetIfEnabled(locForClick, state, raceStop);
        const [fileChooser] = await raceStop(
          Promise.all([
            page.waitForEvent("filechooser"),
            locForClick.click(),
          ])
        );
        await raceStop(fileChooser.setFiles(filePath));
      } else {
        await highlightPlaybackTargetIfEnabled(locForClick, state, raceStop);
        await raceStop(locForClick.click());
      }
      if (progress) progress.actionPerformed = true;
      await postClickNavigationSettle(urlBeforeClick);
      break;
    }
    case "dblclick": {
      const urlBeforeDblClick = await page.url();
      await highlightPlaybackTargetIfEnabled(locForClick, state, raceStop);
      await raceStop(locForClick.dblclick());
      if (progress) progress.actionPerformed = true;
      await postClickNavigationSettle(urlBeforeDblClick);
      break;
    }
    case "fill": {
      const value = step.value ? substitute(step.value, env) : "";
      await highlightPlaybackTargetIfEnabled(locForFill, state, raceStop);
      await raceStop(locForFill.fill(value));
      if (progress) progress.actionPerformed = true;
      break;
    }
    case "select": {
      const value = step.value ? substitute(step.value, env) : "";
      await highlightPlaybackTargetIfEnabled(loc, state, raceStop);
      await raceStop(loc.selectOption(value));
      if (progress) progress.actionPerformed = true;
      break;
    }
    case "upload": {
      const rawPath = step.value ? substitute(step.value, env) : "";
      const filePath = rawPath ? resolveUploadFilePath(rawPath) : "";
      if (!filePath) {
        throw new Error(`Upload step is missing file path for element: ${step.element}`);
      }

      // If previous step was the click that opened a file chooser, try that first.
      const prevIndex = state.lastExecutedIndex ?? index - 1;
      const prevStep = prevIndex >= 0 ? steps[prevIndex] : null;
      if (prevStep?.action === "click") {
        const prevStepForResolve: StepIntent =
          prevStep.element != null
            ? { ...prevStep, element: substitute(prevStep.element, env) }
            : prevStep;
        const prevResolved = await raceStop(
          resolveLocator(page, prevStepForResolve, {
            debug: false,
            timeoutMs: locatorTimeoutMs,
            abortPromise: stopAbortPromise,
          })
        );
        if (prevResolved) {
          const triggerLoc = prevResolved.clickLocator ?? prevResolved.locator;
          await highlightPlaybackTargetIfEnabled(triggerLoc, state, raceStop);
          const [fileChooser] = await raceStop(
            Promise.all([
              page.waitForEvent("filechooser"),
              triggerLoc.click(),
            ])
          );
          await raceStop(fileChooser.setFiles(filePath));
          break;
        }
      }

      // Fallback: visible <input type="file"> on the page.
      await highlightPlaybackTargetIfEnabled(loc, state, raceStop);
      await raceStop(loc.waitFor({ state: "visible", timeout: timeouts.action.uploadVisibleMs }).catch(() => { }) as Promise<void>);
      const uploadInput = loc.locator('input[type="file"]').first();
      try {
        await raceStop(uploadInput.setInputFiles(filePath));
      } catch {
        await raceStop(loc.setInputFiles(filePath));
      }
      if (progress) progress.actionPerformed = true;
      break;
    }
    case "hover":
      await highlightPlaybackTargetIfEnabled(loc, state, raceStop);
      await raceStop(loc.hover());
      if (progress) progress.actionPerformed = true;
      break;
    case "press":
      await highlightPlaybackTargetIfEnabled(loc, state, raceStop);
      await raceStop(loc.press(step.key ?? "Enter"));
      if (progress) progress.actionPerformed = true;
      break;
    case "assert_visible":
      await highlightPlaybackTargetIfEnabled(loc, state, raceStop);
      await raceStop(loc.waitFor({ state: "visible", timeout: timeouts.action.assertVisibleMs }));
      break;
    case "assert_text":
      await highlightPlaybackTargetIfEnabled(loc, state, raceStop);
      await raceStop(loc.waitFor({ state: "visible", timeout: timeouts.action.assertVisibleMs }));
      break;
    case "wait_enabled": {
      await highlightPlaybackTargetIfEnabled(loc, state, raceStop);
      await raceStop(loc.waitFor({ state: "visible", timeout: timeouts.action.waitEnabledVisibleMs }));
      const enabledCheck = (el: Element) => {
        if (el.getAttribute("aria-selected") === "true") return true;
        if (el.hasAttribute("disabled")) return false;
        if (el.getAttribute("aria-disabled") === "true") return false;
        const cls =
          el.className && typeof el.className === "string" ? el.className : "";
        if (cls.includes("disabled")) return false;
        return true;
      };
      const deadline = Date.now() + timeouts.action.waitEnabledTotalMs;
      let enabled = false;
      while (Date.now() < deadline) {
        await raceStop(Promise.resolve());
        enabled = await loc.evaluate(enabledCheck);
        if (enabled) break;
        await raceStop(page.waitForTimeout(timeouts.action.waitEnabledPollMs));
      }
      if (!enabled) {
        throw new Error(
          `Element did not become enabled within ${timeouts.action.waitEnabledTotalMs}ms: ${step.element ?? "(no element)"}`
        );
      }
      break;
    }
    default:
      throw new Error(`Unsupported action in debug runner: ${step.action}`);
  }

  // Short buffer between steps (click/double-click may also run postClickNavigationSettle)
  await raceStop(page.waitForTimeout(timeouts.debugRunner.betweenStepsMs));
}

/** Collect recorded actions from main frame and all iframes, tagged with inIframe, merged and sorted by timestamp. */
async function collectRecordedActionsFromAllFrames(appPage: Page): Promise<RecordedAction[]> {
  const entries: { action: RecordedAction; timestamp: number }[] = [];
  for (const frame of appPage.frames()) {
    try {
      const result = (await frame.evaluate(() => {
        const w = window as Window & { __getRecordedActions?: () => unknown[]; __recordedActions?: unknown[]; __inIframe?: boolean };
        const raw = typeof w.__getRecordedActions === "function"
          ? w.__getRecordedActions()
          : w.__recordedActions || [];
        const inIframe = w.__inIframe === true;
        return { raw: Array.isArray(raw) ? raw : [], inIframe };
      })) as { raw: RecordedAction[]; inIframe: boolean };
      for (const a of result.raw) {
        entries.push({
          action: { ...a, inIframe: result.inIframe },
          timestamp: a.timestamp ?? 0,
        });
      }
    } catch {
      // ignore cross-origin or detached frames
    }
  }
  entries.sort((x, y) => x.timestamp - y.timestamp);
  return entries.map((e) => e.action);
}

async function streamRecordedActions(
  appPage: Page,
  uiPage: Page,
  state: DebugSessionState
): Promise<void> {
  let lastCount = state.recordedCount ?? 0;
  const recorderPollMs = getUiplayConfig().timeouts.debugRunner.recorderPollMs;

  // Poll for new recorded actions while recording is active (main frame + all iframes).
  while (state.recording) {
    let actions: RecordedAction[] = [];
    try {
      actions = await collectRecordedActionsFromAllFrames(appPage);
    } catch {
      actions = [];
    }

    if (actions.length > lastCount) {
      const newOnes = actions.slice(lastCount);
      lastCount = actions.length;
      state.recordedCount = lastCount;
      const appended = appendRecordedActionsToState(state, newOnes);
      if (appended > 0) {
        try {
          const scrollY =
            (await uiPage.evaluate(() => (window as any).scrollY ?? 0)) ?? 0;
          await renderDebugUI(uiPage, state);
          await uiPage.evaluate((y: number) => {
            window.scrollTo(0, y);
            const logEl = document.getElementById("log-panel-content");
            if (logEl) logEl.scrollTop = logEl.scrollHeight;
          }, scrollY);
        } catch {
          // Ignore UI update errors during polling (e.g., page closing).
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, recorderPollMs));
  }
}

type UiStepPayload = {
  action: string;
  element?: string;
  value?: string;
  locator?: string;
  originalIndex?: number;
  enabled?: boolean;
};

function applyUiStepsToState(state: DebugSessionState, uiSteps: UiStepPayload[]): void {
  const previousStates = state.steps;

  const updatedSteps: StepIntent[] = uiSteps.map((s) => {
    const originalIndex =
      typeof s.originalIndex === "number" && s.originalIndex >= 0 ? s.originalIndex : undefined;
    const original =
      originalIndex !== undefined && previousStates[originalIndex]
        ? previousStates[originalIndex].step
        : undefined;

    const actionRaw = (s.action || original?.action) as StepIntent["action"] | undefined;
    if (!actionRaw) {
      throw new Error("Each step must have an action.");
    }

    const base: StepIntent = { action: actionRaw };
    const element = s.element !== undefined ? s.element : original?.element;
    const value = s.value !== undefined ? s.value : original?.value;

    if (actionRaw === "pause") {
      const rawSeconds = (value ?? "").toString().trim();
      const parsed = Number(rawSeconds);
      base.seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    } else if (actionRaw === "navigate") {
      base.url = value !== undefined ? value : original?.url;
    } else {
      base.value = value !== undefined ? value : original?.value;
    }

    if (element !== undefined) base.element = element;
    if (original?.url && actionRaw !== "navigate") base.url = original.url;
    if (original?.key) base.key = original.key;
    if (original?.page) base.page = original.page;
    const locatorVal = s.locator != null ? String(s.locator).trim() : "";
    // Do not persist auto-generated/stored locators (e.g. role|..., placeholder|..., frame|...).
    // Keep only locators that look like plain selectors typed by the user in the locator column.
    const looksStored = locatorVal ? /^[a-z_]+\|/.test(locatorVal) : false;
    if (locatorVal && !looksStored) base.locator = locatorVal;

    return base;
  });

  state.test = {
    ...state.test,
    steps: updatedSteps,
  };

  state.steps = updatedSteps.map((step, idx) => {
    const previous = previousStates[idx];
    const fromUi = uiSteps[idx];
    const enabled =
      fromUi && typeof fromUi.enabled === "boolean"
        ? fromUi.enabled
        : previous?.enabled ?? true;
    return {
      index: idx,
      step,
      status: previous?.status ?? "pending",
      lastError: previous?.lastError,
      breakpoint: previous?.breakpoint,
      enabled,
      cachedLocator: previous?.cachedLocator,
    };
  });

  state.lastExecutedIndex = null;
}

function appendRecordedActionsToState(
  state: DebugSessionState,
  actions: RecordedAction[]
): number {
  if (!actions || actions.length === 0) return 0;
  const baseIndex = state.steps.length;
  const newSteps: StepIntent[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const idx = baseIndex + i;
    let elementHint = (a.elementHint ?? "").trim() || `step_${idx + 1}`;
    if (a.inIframe) elementHint = elementHint + " inside iframe";
    if (a.action === "navigate") {
      const url = a.url ?? state.baseUrl;
      if (url) newSteps.push({ action: "navigate", url });
      continue;
    }
    const loc = (a.locator ?? "").trim();
    const withLocator = <T extends StepIntent>(s: T): T =>
      loc ? { ...s, locator: loc } : s;

    if (a.action === "click") {
      newSteps.push(withLocator({ action: "click", element: elementHint }));
    } else if (a.action === "dblclick") {
      newSteps.push(withLocator({ action: "dblclick", element: elementHint }));
    } else if (a.action === "fill") {
      newSteps.push(
        withLocator({ action: "fill", element: elementHint, value: a.value ?? "" })
      );
    } else if (a.action === "select") {
      newSteps.push(
        withLocator({ action: "select", element: elementHint, value: a.value ?? "" })
      );
    }
  }
  if (newSteps.length === 0) return 0;

  const existingSteps = state.test.steps ?? state.steps.map((s) => s.step);
  const combined = existingSteps.concat(newSteps);
  state.test = {
    ...state.test,
    steps: combined,
  };
  state.steps = combined.map((step, index) => {
    const prev = state.steps[index];
    return {
      index,
      step,
      status: prev?.status ?? "pending",
      lastError: prev?.lastError,
      breakpoint: prev?.breakpoint ?? false,
      enabled: prev?.enabled ?? true,
    };
  });
  return newSteps.length;
}

