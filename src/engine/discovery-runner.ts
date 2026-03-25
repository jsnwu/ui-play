import * as readline from "readline";
import { chromium } from "playwright";
import { getPlaywrightBrowserContextOptions, getUiplayConfig, resolveUploadFilePath } from "./config";
import { resolveLocator } from "./locator-resolver";
import { derivePageObjectIdFromUrl, mergeLocators } from "./page-object-store";
import { loadTestCase, saveTestCase } from "./test-case-store";
import { evaluateVariables, isFullUrl, resolveNavigateUrl, substitute } from "./substitute";
import type { PlainTextTestCase, StepIntent } from "./types";

function waitForEnter(message: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

export interface DiscoveryOptions {
  testId: string;
  baseUrl?: string;
  env?: Record<string, string>;
  headless?: boolean;
  pageObjectId?: string;
  debug?: boolean;
  /** Locator wait timeout in ms for discovery (per strategy). Default: config.json discovery.locatorStrategyMs. */
  locatorTimeoutMs?: number;
}

export async function runDiscovery(options: DiscoveryOptions): Promise<{
  success: boolean;
  steps: StepIntent[];
  pageObjectId: string;
  error?: string;
}> {
  const test = loadTestCase(options.testId);
  if (!test) {
    throw new Error(`Test case not found: ${options.testId}`);
  }

  const env = { ...process.env, ...test.env, ...options.env } as Record<string, string>;
  let baseUrlRaw = options.baseUrl ?? test.baseUrl ?? "";
  if (!baseUrlRaw || baseUrlRaw === "{{baseUrl}}") {
    baseUrlRaw = (env.PLAYWRIGHT_LOGIN_URL as string) ?? baseUrlRaw;
  }
  const baseUrl = baseUrlRaw ? substitute(baseUrlRaw, env) : "";
  env.BASE_URL = baseUrl;
  env.baseUrl = baseUrl;

  // Evaluate per-test variables (static or generated) and merge into env
  const evaluatedVars = evaluateVariables(test.variables, env);
  Object.assign(env, evaluatedVars);

  const steps = test.steps ?? [];
  if (steps.length === 0) {
    throw new Error(
      `Test ${options.testId} has no steps. Add step lines to the YAML (e.g. "Navigate to {{baseUrl}}", "Click Sign in button").`
    );
  }

  const derivedPoId = derivePageObjectIdFromUrl(baseUrl);
  const fallbackPoId = options.pageObjectId ?? test.pageObjectId ?? test.id;
  let currentPageObjectId: string | null = options.pageObjectId ?? derivedPoId ?? fallbackPoId;

  const timeouts = getUiplayConfig().timeouts;
  const locatorTimeoutMs = options.locatorTimeoutMs ?? timeouts.discovery.locatorStrategyMs;

  const cfg = getUiplayConfig();
  const browser = await chromium.launch({
    headless: options.headless ?? false,
    ...(cfg.browser.channel ? { channel: cfg.browser.channel as any } : {}),
    ...(Array.isArray(cfg.browser.args) && cfg.browser.args.length ? { args: cfg.browser.args } : {}),
  });
  const contextOptions = await getPlaywrightBrowserContextOptions();
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  async function waitForPageStable() {
    const start = Date.now();
    let urlBefore = "";
    try {
      urlBefore = page.url();
    } catch {
      // ignore
    }
    try {
      // Wait for network to be mostly idle; tolerate apps that keep some requests open.
      // Use a longer timeout so multi-redirect or slow-rendering pages have time to
      // settle before we start resolving elements.
      await page.waitForLoadState("networkidle", { timeout: timeouts.page.networkIdleMs });
      const elapsed = Date.now() - start;
      if (options.debug) {
        let urlNow = urlBefore;
        try {
          urlNow = page.url();
        } catch {
          /* keep urlBefore */
        }
        console.log(
          "[discovery] waitForPageStable: networkidle",
          JSON.stringify({ ms: elapsed, url: urlNow })
        );
      }
    } catch {
      const mid = Date.now();
      if (options.debug) {
        console.log(
          "[discovery] waitForPageStable: networkidle timeout",
          JSON.stringify({ ms: mid - start, url: urlBefore })
        );
      }
      try {
        await page.waitForLoadState("load", { timeout: timeouts.page.loadFallbackMs });
        const elapsed = Date.now() - mid;
        if (options.debug) {
          let urlNow = urlBefore;
          try {
            urlNow = page.url();
          } catch {
            /* keep urlBefore */
          }
          console.log(
            "[discovery] waitForPageStable: load",
            JSON.stringify({ ms: elapsed, url: urlNow })
          );
        }
      } catch {
        if (options.debug) {
          console.log(
            "[discovery] waitForPageStable: load timeout; continuing",
            JSON.stringify({ url: urlBefore })
          );
        }
      }
    }
  }

  const locatorsByPage: Record<string, Record<string, string>> = {};
  const urlByPage: Record<string, string> = {};
  let currentUrl = "";
  if (currentPageObjectId && baseUrl) {
    urlByPage[currentPageObjectId] = baseUrl;
    currentUrl = baseUrl;
  }
  let lastError: string | undefined;

  try {
    for (let i = 0; i < steps.length; i++) {
      await waitForPageStable();
      const step = steps[i];
      const logicalKey = step.element ?? `step_${i}`;
      const safeKey = logicalKey.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, "");

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
          let poIdFromUrl = derivePageObjectIdFromUrl(currentUrl);
          // Heuristic: treat transient "/u/..." auth redirects as part of the login page
          // so they don't create a separate "u-page.yaml". If we already have a login-page
          // entry, fold "u-page" into it.
          if (
            poIdFromUrl === "u-page" &&
            (urlByPage["login-page"] || derivedPoId === "login-page" || fallbackPoId === "login-page")
          ) {
            poIdFromUrl = "login-page";
          }
          if (poIdFromUrl) {
            currentPageObjectId = poIdFromUrl;
            urlByPage[poIdFromUrl] = currentUrl;
          }
        }
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

      // For matching, substitute variables in the element name (e.g. {{timestamp}}) so we search
      // for the actual rendered text, but keep the original element string for locator keys.
      const stepForResolve: StepIntent =
        step.element != null ? { ...step, element: substitute(step.element, env) } : step;

      // Upload "file input": no DOM file input; we use filechooser + previous step's click. Skip resolution.
      let resolved: Awaited<ReturnType<typeof resolveLocator>>;
      if (step.action === "upload" && (step.element === "file input" || safeKey === "file_input")) {
        resolved = { stored: "file_input|", locator: page.locator("body") };
      } else {
        resolved = await resolveLocator(page, stepForResolve, {
          debug: options.debug,
          timeoutMs: locatorTimeoutMs,
          fallbackOnExplicitLocatorFailure: true,
 });
      }
      if (!resolved) {
        lastError = `Could not resolve element for step ${i + 1}: ${step.element}`;
        break;
      }

      const poIdForStep = currentPageObjectId ?? derivedPoId ?? fallbackPoId;
      if (!locatorsByPage[poIdForStep]) {
        locatorsByPage[poIdForStep] = {};
      }
      // For dynamic table rows whose label is driven by a variable (e.g. TASK_TITLE),
      // store a templated locator using the original element text instead of the
      // fully-resolved label with timestamp, so the page object remains reusable.
      let stored = resolved.stored;
      const isTableRoleLocator =
        stored.startsWith("role|row|") ||
        stored.startsWith("role|gridcell|") ||
        stored.startsWith("role|cell|");
      if (isTableRoleLocator && step.element && step.element.includes("{{")) {
        const templateLabel = step.element.replace(/\s+table\s+row\s*$/i, "").trim();
        stored = stored.replace(
          /^role\|(row|gridcell|cell)\|.*$/i,
          (_m, role) => `role|${role}|${templateLabel}`
        );
      }
      locatorsByPage[poIdForStep][safeKey] = stored;
      const locForClick = resolved.clickLocator ?? resolved.locator;
      const locForFill = resolved.fillLocator ?? resolved.locator;
      const loc = resolved.locator;

      if (options.debug && step.action === "click") {
        console.log(
          "[discovery] executing click",
          JSON.stringify({
            stepIndex: i + 1,
            element: step.element,
            pageObjectId: poIdForStep,
            storedLocator: stored,
            locator: locForClick.toString?.() ?? "",
          })
        );
      }

      switch (step.action) {
        case "click": {
          const rawFromStep = step.value ? substitute(step.value, env) : "";
          const filePathFromStep = rawFromStep ? resolveUploadFilePath(rawFromStep) : "";
          const nextStep = steps[i + 1];
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
            const [fileChooser] = await Promise.all([
              page.waitForEvent("filechooser"),
              locForClick.click(),
            ]);
            await fileChooser.setFiles(filePath);
            if (nextIsUploadFileInput) {
              const nextSafeKey = (nextStep!.element ?? `step_${i + 2}`)
                .replace(/\s+/g, "_")
                .replace(/[^a-zA-Z0-9_]/g, "");
              const nextPoId = currentPageObjectId ?? derivedPoId ?? fallbackPoId;
              if (!locatorsByPage[nextPoId]) locatorsByPage[nextPoId] = {};
              locatorsByPage[nextPoId][nextSafeKey] = "file_input|";
              i++; // skip the upload step
            }
          } else {
            await locForClick.click();
          }
          break;
        }
        case "dblclick":
          await locForClick.dblclick();
          break;
        case "fill": {
          const value = step.value ? substitute(step.value, env) : "";
          await locForFill.fill(value);
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
          // Native file chooser: previous click opens the dialog; use waitForEvent('filechooser').
          const prevStep = i > 0 ? steps[i - 1] : null;
          const useFileChooser = stored === "file_input|" && prevStep?.action === "click";
          if (useFileChooser) {
            const prevStepForResolve: StepIntent =
              prevStep.element != null
                ? { ...prevStep, element: substitute(prevStep.element, env) }
                : prevStep;
            const prevResolved = await resolveLocator(page, prevStepForResolve, {
              debug: options.debug,
              timeoutMs: locatorTimeoutMs,
              fallbackOnExplicitLocatorFailure: true,
            });
            if (prevResolved) {
              const triggerLoc = prevResolved.clickLocator ?? prevResolved.locator;
              const [fileChooser] = await Promise.all([
                page.waitForEvent("filechooser"),
                triggerLoc.click(),
              ]);
              await fileChooser.setFiles(filePath);
              break;
            }
          }
          if (stored === "file_input|") {
            lastError =
              "Upload step (file input) requires the previous step to be a click that opens the file chooser.";
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
          // optional: assert text content
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
          lastError = `Unsupported action in discovery: ${step.action}`;
      }

      // After any non-navigate step, detect SPA-style URL changes and switch page object accordingly.
      try {
        const urlNow = await page.url();
        if (urlNow && urlNow !== currentUrl) {
          currentUrl = urlNow;
          let poIdFromUrl = derivePageObjectIdFromUrl(currentUrl);
          if (
            poIdFromUrl === "u-page" &&
            (urlByPage["login-page"] || derivedPoId === "login-page" || fallbackPoId === "login-page")
          ) {
            poIdFromUrl = "login-page";
          }
          if (poIdFromUrl) {
            currentPageObjectId = poIdFromUrl;
            if (!urlByPage[poIdFromUrl]) {
              urlByPage[poIdFromUrl] = currentUrl;
            }
          }
        }
      } catch {
        // ignore URL read errors
      }

      await page.waitForTimeout(timeouts.discovery.betweenStepsMs);
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  } finally {
    await browser.close();
  }

  // Persist locators into page objects, grouped by URL-derived page ID.
  for (const [poId, locators] of Object.entries(locatorsByPage)) {
    const urlPattern = urlByPage[poId] ?? baseUrl;
    mergeLocators(poId, locators, {
      urlPattern,
    });
  }

  const updatedTest: PlainTextTestCase = {
    ...test,
    steps,
    pageObjectId: currentPageObjectId ?? derivedPoId ?? test.pageObjectId ?? test.id,
    established: !lastError,
  };
  saveTestCase(updatedTest);

  const finalPageObjectId =
    currentPageObjectId ?? derivedPoId ?? test.pageObjectId ?? test.id;

  return {
    success: !lastError,
    steps,
    pageObjectId: finalPageObjectId,
    error: lastError,
  };
}


