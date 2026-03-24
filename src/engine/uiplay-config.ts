import fs from "fs";
import path from "path";

const engineDir = path.resolve(__dirname);
const srcDir = path.resolve(engineDir, "..");
const rootDir = path.resolve(srcDir, "..");

const CONFIG_FILENAME = "config.json";

export interface UiplayPathsConfig {
  tests: string;
  pageObjects: string;
  uploadFiles: string;
}

export interface UiplayBrowserConfig {
  inheritViewportFromPlaywrightConfig: boolean;
  viewport: { width: number; height: number };
}

export interface UiplayDebugUiConfig {
  sidePanelWidth: number;
  /** When true, the app page shows a hover outline on interactive elements (buttons, links, inputs). Default true. */
  highlightInteractiveElements: boolean;
}

export interface UiplayTimeoutsConfig {
  page: {
    networkIdleMs: number;
    loadFallbackMs: number;
  };
  discovery: {
    locatorStrategyMs: number;
    betweenStepsMs: number;
  };
  player: {
    postNavigateMs: number;
    betweenStepsMs: number;
    tableReResolveLocatorMs: number;
  };
  debugRunner: {
    betweenStepsMs: number;
    postNavigateMs: number;
    recorderPollMs: number;
    /** Max time to poll for URL change after click/double-click; then domcontentloaded + networkidle if changed. */
    postClickUrlChangeDetectMs: number;
  };
  action: {
    uploadVisibleMs: number;
    assertVisibleMs: number;
    waitEnabledVisibleMs: number;
    waitEnabledTotalMs: number;
    waitEnabledPollMs: number;
  };
  locator: {
    defaultStrategyMs: number;
    dialogMinimumMs: number;
    frameStrategyMinimumMs: number;
    frameDomContentLoadedMs: number;
    childFrameReadyMs: number;
    childFramePollMs: number;
    frameUrlMatchMs: number;
    frameUrlPollMs: number;
  };
}

export interface UiplayConfig {
  paths: UiplayPathsConfig;
  browser: UiplayBrowserConfig;
  debugUi: UiplayDebugUiConfig;
  timeouts: UiplayTimeoutsConfig;
}

const DEFAULT_CONFIG: UiplayConfig = {
  paths: {
    tests: "tests",
    pageObjects: "src/page-objects",
    uploadFiles: "src/upload-files",
  },
  browser: {
    inheritViewportFromPlaywrightConfig: false,
    viewport: { width: 1500, height: 1100 },
  },
  debugUi: {
    sidePanelWidth: 800,
    highlightInteractiveElements: true,
  },
  timeouts: {
    page: {
      networkIdleMs: 15000,
      loadFallbackMs: 15000,
    },
    discovery: {
      locatorStrategyMs: 2000,
      betweenStepsMs: 500,
    },
    player: {
      postNavigateMs: 500,
      betweenStepsMs: 200,
      tableReResolveLocatorMs: 500,
    },
    debugRunner: {
      betweenStepsMs: 200,
      postNavigateMs: 300,
      recorderPollMs: 500,
      postClickUrlChangeDetectMs: 800,
    },
    action: {
      uploadVisibleMs: 10000,
      assertVisibleMs: 5000,
      waitEnabledVisibleMs: 10000,
      waitEnabledTotalMs: 10000,
      waitEnabledPollMs: 200,
    },
    locator: {
      defaultStrategyMs: 500,
      dialogMinimumMs: 2000,
      frameStrategyMinimumMs: 2000,
      frameDomContentLoadedMs: 5000,
      childFrameReadyMs: 12000,
      childFramePollMs: 300,
      frameUrlMatchMs: 15000,
      frameUrlPollMs: 200,
    },
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T extends Record<string, unknown>>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const k of Object.keys(patch)) {
    const pv = (patch as Record<string, unknown>)[k];
    const bv = out[k];
    if (isPlainObject(pv) && isPlainObject(bv)) {
      out[k] = deepMerge(bv as Record<string, unknown>, pv);
    } else if (pv !== undefined) {
      out[k] = pv;
    }
  }
  return out as T;
}

function readConfigFile(): unknown {
  const configPath = path.join(srcDir, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

let cached: UiplayConfig | null = null;

export function getUiplayConfig(): UiplayConfig {
  if (cached) return cached;
  const fileJson = readConfigFile();
  cached = deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, fileJson) as unknown as UiplayConfig;
  return cached;
}

/** Repo root (directory containing package.json / tests). */
export function getUiplayRootDir(): string {
  return rootDir;
}

/** Resolve path segments relative to repo root. */
export function resolveFromRoot(...segments: string[]): string {
  return path.resolve(rootDir, ...segments);
}

/** Resolve a relative upload path against `paths.uploadFiles`; absolute paths unchanged. */
export function resolveUploadFilePath(fileRef: string): string {
  const trimmed = (fileRef ?? "").trim();
  if (!trimmed) return "";
  if (path.isAbsolute(trimmed)) return trimmed;
  const cfg = getUiplayConfig();
  return path.resolve(rootDir, cfg.paths.uploadFiles, trimmed);
}
