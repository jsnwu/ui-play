import * as readline from "readline";
import { chromium } from "playwright";
import { getPlaywrightBrowserContextOptions, getUiplayConfig, resolveUploadFilePath } from "./config";
import { applyStoredLocator, resolveLocator } from "./locator-resolver";
import {
  COMMON_PAGE_OBJECT_ID,
  findPageObjectForUrl,
  getLocatorString,
  loadAllPageObjects,
  loadPageObject,
} from "./page-object-store";
import { loadTestCase } from "./test-case-store";
import { evaluateVariables, isFullUrl, resolveNavigateUrl, substitute } from "./substitute";
import type { StepIntent } from "./types";

function waitForEnter(message: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

export interface EstablishedRunOptions {
  testId: string;
  baseUrl?: string;
  env?: Record<string, string>;
  headless?: boolean;
}

function stepToLocatorKey(step: StepIntent): string {
  const name = step.element ?? "";
  return name.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
}

export async function runEstablished(options: EstablishedRunOptions): Promise<{
  success: boolean;
  error?: string;
}> {
  const test = loadTestCase(options.testId);
  if (!test) throw new Error(`Test case not found: ${options.testId}`);
  if (!test.established || !test.steps?.length) {
    throw new Error(
      `Test ${options.testId} is not established (missing steps). Run discovery first.`
    );
  }

  const allPageObjects = loadAllPageObjects();
  const commonPo = loadPageObject(COMMON_PAGE_OBJECT_ID);

  const env = { ...process.env, ...test.env, ...options.env } as Record<string, string>;
  let baseUrlRaw = options.baseUrl ?? test.baseUrl ?? "";
  if (!baseUrlRaw || baseUrlRaw === "{{baseUrl}}") {
    baseUrlRaw = (env.PLAYWRIGHT_LOGIN_URL as string) ?? baseUrlRaw;
  }
  const baseUrl = baseUrlRaw ? substitute(baseUrlRaw, env) : "";
  env.BASE_URL = baseUrl;
  env.baseUrl = baseUrl;

  // Evaluate per-test variables and merge into env so they can be used in steps.
  const evaluatedVars = evaluateVariables(test.variables, env);
  Object.assign(env, evaluatedVars);

  const timeouts = getUiplayConfig().timeouts;

  const browser = await chromium.launch({ headless: options.headless ?? false });
  const contextOptions = await getPlaywrightBrowserContextOptions();
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  async function waitForPageStable() {
    try {
      // Use a longer timeout so long redirect chains or slow pages have time
      // to settle before we resolve elements from page objects.
      await page.waitForLoadState("networkidle", { timeout: timeouts.page.networkIdleMs });
    } catch {
      // Ignore; actions below still have explicit waits where needed.
    }
  }

  let lastError: string | undefined;
  let currentUrl = "";
  let currentPo = baseUrl ? findPageObjectForUrl(baseUrl) : null;

  function getStoredForStep(step: StepIntent): string | null {
    const k = stepToLocatorKey(step);
    let s: string | null = null;
    if (currentPo) s = getLocatorString(currentPo, k);
    if (!s) {
      for (const po of allPageObjects) {
        if (po.id === COMMON_PAGE_OBJECT_ID) continue;
        s = getLocatorString(po, k);
        if (s) break;
      }
    }
    if (!s && commonPo) s = getLocatorString(commonPo, k);
    return s;
  }

  try {
    for (let i = 0; i < test.steps.length; i++) {
      const step = test.steps[i];
      await waitForPageStable();
      if (step.action === "navigate") {
        const rawUrl = step.url ? substitute(step.url, env) : "";
        let url = resolveNavigateUrl(rawUrl, baseUrl);
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
          await page.goto(url, { waitUntil: "domcontentloaded" });
          currentUrl = await page.url();
          currentPo = findPageObjectForUrl(currentUrl);
        }
        await page.waitForTimeout(timeouts.player.postNavigateMs);
        continue;
      }

      if (step.action === "pause") {
        if (step.seconds != null) {
          await page.waitForTimeout(step.seconds * 1000);
        } else {
          await waitForEnter("Pause (indefinite). Press ENTER in terminal to continue...");
        }
        continue;
      }

      // Update current page object if URL changed (e.g. SPA navigation after click).
      const urlNow = await page.url();
      if (urlNow !== currentUrl) {
        currentUrl = urlNow;
        currentPo = findPageObjectForUrl(currentUrl);
      }

      const key = stepToLocatorKey(step);
      let stored: string | null = null;

      if (currentPo) {
        stored = getLocatorString(currentPo, key);
      }

      // Fallback: search all page objects if currentPo didn't have it.
      if (!stored) {
        for (const po of allPageObjects) {
          if (po.id === COMMON_PAGE_OBJECT_ID) continue;
          stored = getLocatorString(po, key);
          if (stored) break;
        }
      }

      // Shared/common page object as final fallback.
      if (!stored && commonPo) {
        stored = getLocatorString(commonPo, key);
      }

      // Upload without a specific element: use the visible file input (e.g. after clicking "New File(s)").
      if (!stored && step.action === "upload" && (key === "file_input" || step.element === "file input")) {
        stored = "file_input|";
      }

      if (!stored) {
        lastError = `No locator in page object for: ${step.element} (key: ${key})`;
        break;
      }

      // Default: use stored locator from page object (waits for iframe when stored uses frame|...).
      let loc = await applyStoredLocator(page, stored);

      // For table rows/cells whose text is driven by per-run variables (e.g. TASK_TITLE),
      // re-resolve the locator using the same logic as discovery so we target the row
      // that actually exists in this run.
      const isTableRoleLocator =
        stored.startsWith("role|row|") ||
        stored.startsWith("role|gridcell|") ||
        stored.startsWith("role|cell|");
      if (isTableRoleLocator) {
        const stepForResolve: StepIntent =
          step.element != null ? { ...step, element: substitute(step.element, env) } : step;
        try {
          const resolved = await resolveLocator(page, stepForResolve, {
            timeoutMs: timeouts.player.tableReResolveLocatorMs,
          });
          if (resolved) {
            loc = resolved.clickLocator ?? resolved.locator;
          }
        } catch {
          // Fall back to stored locator if re-resolution fails.
        }
      }

      switch (step.action) {
        case "click": {
          const rawFromStep = step.value ? substitute(step.value, env) : "";
          const filePathFromStep = rawFromStep ? resolveUploadFilePath(rawFromStep) : "";
          const nextStep = test.steps[i + 1];
          const nextIsUploadFileInput =
            !step.value &&
            nextStep?.action === "upload" &&
            (nextStep.element === "file input" || stepToLocatorKey(nextStep) === "file_input") &&
            nextStep.value;
          const filePath = filePathFromStep
            || (nextIsUploadFileInput
              ? resolveUploadFilePath(substitute(nextStep!.value ?? "", env))
              : "");
          if (filePath) {
            const [fileChooser] = await Promise.all([
              page.waitForEvent("filechooser"),
              loc.click(),
            ]);
            await fileChooser.setFiles(filePath);
            if (nextIsUploadFileInput) i++; // skip the upload step
          } else {
            await loc.click();
          }
          break;
        }
        case "dblclick":
          await loc.dblclick();
          break;
        case "fill": {
          const value = step.value ? substitute(step.value, env) : "";
          await loc.fill(value);
          break;
        }
        case "select": {
          const value = step.value ? substitute(step.value, env) : "";
          await loc.selectOption(value);
          break;
        }
        case "upload": {
          const rawPath = step.value ? substitute(step.value, env) : "";
          const filePath = rawPath ? resolveUploadFilePath(rawPath) : "";
          if (!filePath) {
            lastError = `Upload step is missing file path for element: ${step.element}`;
            break;
          }
          // Native file chooser: no DOM file input; previous click opens the dialog.
          const prevStep = i > 0 ? test.steps[i - 1] : null;
          const triggerStored =
            stored === "file_input|" && prevStep?.action === "click"
              ? getStoredForStep(prevStep)
              : null;
          if (triggerStored) {
            const triggerLoc = await applyStoredLocator(page, triggerStored);
            const [fileChooser] = await Promise.all([
              page.waitForEvent("filechooser"),
              triggerLoc.click(),
            ]);
            await fileChooser.setFiles(filePath);
            break;
          }
          // DOM file input: wait for it then setInputFiles.
          await loc.waitFor({ state: "visible", timeout: timeouts.action.uploadVisibleMs }).catch(() => {});
          const uploadInput = loc.locator('input[type="file"]').first();
          try {
            await uploadInput.setInputFiles(filePath);
          } catch {
            await loc.setInputFiles(filePath);
          }
          break;
        }
        case "hover":
          await loc.hover();
          break;
        case "press":
          await loc.press(step.key ?? "Enter");
          break;
        case "assert_visible":
          await loc.waitFor({ state: "visible", timeout: timeouts.action.assertVisibleMs });
          break;
        case "assert_text":
          await loc.waitFor({ state: "visible", timeout: timeouts.action.assertVisibleMs });
          break;
        case "wait_enabled": {
          await loc.waitFor({ state: "visible", timeout: timeouts.action.waitEnabledVisibleMs });
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
            enabled = await loc.evaluate(enabledCheck);
            if (enabled) break;
            await page.waitForTimeout(timeouts.action.waitEnabledPollMs);
          }
          if (!enabled) {
            lastError = `Element did not become enabled within ${timeouts.action.waitEnabledTotalMs}ms: ${step.element}`;
          }
          break;
        }
        default:
          lastError = `Unsupported action: ${step.action}`;
      }

      await page.waitForTimeout(timeouts.player.betweenStepsMs);
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  } finally {
    await browser.close();
  }

  return { success: !lastError, error: lastError };
}


