import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { config as loadDotenv } from "dotenv";
import { getUiplayConfig } from "./uiplay-config";

// config lives under src/engine; parent dir is src/ (framework assets)
const frameworkDir = path.resolve(__dirname, "..");
export const rootDir = path.resolve(frameworkDir, "..");

loadDotenv({ path: path.join(rootDir, ".env") });
loadDotenv({ path: path.join(rootDir, "browser", ".env") });

const ui = getUiplayConfig();

export const FRAMEWORK_DIR = frameworkDir;
export const TESTS_DIR = path.resolve(rootDir, ui.paths.tests);
export const PAGE_OBJECTS_DIR = path.resolve(rootDir, ui.paths.pageObjects);
export const UPLOAD_FILES_DIR = path.resolve(rootDir, ui.paths.uploadFiles);

export function ensureDirs(): void {
  for (const dir of [PAGE_OBJECTS_DIR, TESTS_DIR, UPLOAD_FILES_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

export { getUiplayConfig, resolveUploadFilePath } from "./uiplay-config";

/**
 * Load browser context options (viewport). Controlled by config.json:
 * - If `browser.inheritViewportFromPlaywrightConfig` is true, viewport is read from playwright.config.ts when present.
 * - Otherwise `browser.viewport` from JSON is used.
 */
export async function getPlaywrightBrowserContextOptions(): Promise<{
  viewport: { width: number; height: number };
}> {
  const cfg = getUiplayConfig();
  if (!cfg.browser.inheritViewportFromPlaywrightConfig) {
    return { viewport: { ...cfg.browser.viewport } };
  }
  try {
    const configPath = path.join(rootDir, "playwright.config.ts");
    if (!fs.existsSync(configPath)) return { viewport: { ...cfg.browser.viewport } };
    const url = pathToFileURL(configPath).href;
    const mod = await import(url);
    const config = mod.default ?? {};
    const use = config.use ?? {};
    const viewport = use.viewport ?? cfg.browser.viewport;
    return { viewport };
  } catch {
    return { viewport: { ...cfg.browser.viewport } };
  }
}
