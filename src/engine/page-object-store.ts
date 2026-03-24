import fs from "fs";
import path from "path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { PAGE_OBJECTS_DIR, ensureDirs } from "./config";
import type { PageObjectData } from "./types";

const YAML_EXT = ".yaml";
const JSON_EXT = ".json";

/** Reserved ID for shared/common locators used across multiple pages. */
export const COMMON_PAGE_OBJECT_ID = "common-page";

/** Derive a stable page object id from a URL (e.g. "home-page", "login-page"). */
export function derivePageObjectIdFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    if (path === "/" || path === "") return "home-page";
    const segments = path.split("/").filter(Boolean);
    const first = segments[0] || "page";
    const slug = first.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
    if (!slug) return "page";
    return `${slug}-page`;
  } catch {
    return null;
  }
}

export function getPageObjectPath(id: string, ext: ".yaml" | ".json" = ".yaml"): string {
  ensureDirs();
  return path.join(PAGE_OBJECTS_DIR, `${id}${ext}`);
}

function findPageObjectPath(id: string): string | null {
  ensureDirs();
  const yamlPath = getPageObjectPath(id, ".yaml");
  const jsonPath = getPageObjectPath(id, ".json");
  if (fs.existsSync(yamlPath)) return yamlPath;
  if (fs.existsSync(jsonPath)) return jsonPath;
  return null;
}

export function loadPageObject(id: string): PageObjectData | null {
  const filePath = findPageObjectPath(id);
  if (!filePath) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  if (filePath.endsWith(".yaml")) {
    const doc = yamlParse(raw) as PageObjectData;
    return doc?.id ? doc : null;
  }
  return JSON.parse(raw) as PageObjectData;
}

export function savePageObject(data: PageObjectData): void {
  ensureDirs();
  const filePath = getPageObjectPath(data.id, ".yaml");
  const out: PageObjectData = {
    ...data,
    updatedAt: new Date().toISOString(),
  };
  const yamlStr = yamlStringify(out, { lineWidth: 0 });
  fs.writeFileSync(filePath, yamlStr, "utf-8");
}

export function listPageObjectIds(): string[] {
  ensureDirs();
  if (!fs.existsSync(PAGE_OBJECTS_DIR)) return [];
  const ids = new Set<string>();
  for (const f of fs.readdirSync(PAGE_OBJECTS_DIR)) {
    if (f.endsWith(YAML_EXT) || f.endsWith(JSON_EXT)) {
      ids.add(path.basename(f, path.extname(f)));
    }
  }
  return Array.from(ids);
}

/** Load all page objects (YAML/JSON) from the page-objects directory. */
export function loadAllPageObjects(): PageObjectData[] {
  const ids = listPageObjectIds();
  const result: PageObjectData[] = [];
  for (const id of ids) {
    const po = loadPageObject(id);
    if (po) result.push(po);
  }
  return result;
}

/**
 * Resolve a key (from step element) to the stored locator string.
 * Checks locators[key], then aliases[key] -> locators[canonicalKey].
 */
export function getLocatorString(po: PageObjectData, key: string): string | null {
  if (po.locators[key]) return po.locators[key];
  const canonical = po.aliases?.[key];
  if (canonical && po.locators[canonical]) return po.locators[canonical];
  return null;
}

/** Find the best-matching page object for a given URL based on urlPattern.
 *  - Exact match wins over prefix.
 *  - Among prefixes, the longest urlPattern wins.
 *  - urlPattern of "*" matches anything as a weak fallback.
 */
export function findPageObjectForUrl(url: string): PageObjectData | null {
  const all = loadAllPageObjects();
  let best: PageObjectData | null = null;
  let bestScore = -1;

  for (const po of all) {
    const pattern = po.urlPattern;
    if (!pattern) continue;

    if (pattern === "*") {
      if (bestScore < 0) {
        best = po;
        bestScore = 0;
      }
      continue;
    }

    if (pattern === url) {
      // Exact match: highest possible score.
      return po;
    }

    if (url.startsWith(pattern)) {
      const score = pattern.length;
      if (score > bestScore) {
        best = po;
        bestScore = score;
      }
    }
  }

  return best;
}

/** Merge new locators into an existing page object (e.g. after discovery). */
export function mergeLocators(
  pageObjectId: string,
  locators: Record<string, string>,
  meta?: { name?: string; urlPattern?: string }
): PageObjectData {
  const existing = loadPageObject(pageObjectId);
  const next: PageObjectData = {
    id: pageObjectId,
    // Prefer an existing explicit name; otherwise fall back to provided meta
    // name or, as a last resort, the page object id itself.
    name: existing?.name ?? meta?.name ?? pageObjectId,
    urlPattern: meta?.urlPattern ?? existing?.urlPattern,
    locators: { ...existing?.locators, ...locators },
    aliases: existing?.aliases ? { ...existing.aliases } : undefined,
    updatedAt: new Date().toISOString(),
  };
  savePageObject(next);
  return next;
}


