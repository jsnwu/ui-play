import type { Page, Frame, Locator } from "playwright";
import { getUiplayConfig } from "./uiplay-config";
import type { StepIntent } from "./types";

/** Target for locator resolution (page, frame, or a scoping locator such as dialog). */
type LocatorTarget = Page | Frame | Locator;

export interface ResolveLocatorOptions {
  debug?: boolean;
  /** Per-strategy wait timeout in ms (default: config.json timeouts.locator.defaultStrategyMs). */
  timeoutMs?: number;
  /**
   * When true and an explicit step.locator is provided but does not successfully
   * resolve within the timeout, fall back to the normal element-based resolver
   * instead of failing immediately. Intended primarily for discovery mode.
   */
  fallbackOnExplicitLocatorFailure?: boolean;
  /** When provided, capture debug logs here instead of/in addition to console.log. */
  onLog?: (msg: string) => void;
  /**
   * When this promise rejects (e.g. debug Stop), resolution aborts between strategy
   * batches instead of running the full timeout across all attempts.
   */
  abortPromise?: Promise<never>;
}

/** Runtime + stored locator for a single discovery step. */
export interface ResolvedLocatorForStep {
  /** Serialized form saved into the page object (e.g. role|button|..., text_input|Title). */
  stored: string;
  /** Default locator to use when executing the step during discovery. */
  locator: ReturnType<Page["locator"]>;
  /** Optional specialized locators for different actions. */
  clickLocator?: ReturnType<Page["locator"]>;
  fillLocator?: ReturnType<Page["locator"]>;
}

/** Normalize element string for matching:
 * - strip trailing " link"/" button"/" input"/" field"/" dropdown"/" option"
 * - strip optional surrounding quotes
 * - add inner quoted text as an additional candidate (e.g. `"jwu5 admin" option` → `jwu5 admin`)
 * - ORDERED from most-specific to least-specific so resolver tries the most likely text first.
 */
function normalizeElementForMatch(element: string): string[] {
  const t = element.trim();

  // Strip common suffixes like "link", "button", "table row", "radio button" first.
  const s = t
    .replace(/\s+link\s*$/i, "")
    .replace(/\s+radio\s+button\s*$/i, "")
    .replace(/\s+button\s*$/i, "")
    .replace(/\s+table\s+row\s*$/i, "")
    .trim();

  // Further strip generic input/dropdown/option/radio suffixes.
  const s2 = s
    .replace(/\s+(input|field|dropdown|option|radio)\s*$/i, "")
    .trim();

  // Remove surrounding quotes.
  const unquoted = s2.replace(/^["']|["']$/g, "").trim();

  // Inner quoted substring, e.g. `"jwu5 admin" option` -> jwu5 admin.
  const quotedMatch = s2.match(/"([^"]+)"|'([^']+)'/);
  const inner = quotedMatch ? (quotedMatch[1] ?? quotedMatch[2]).trim() : "";

  const ordered: string[] = [];

  // Most specific first.
  if (inner) ordered.push(inner);
  if (unquoted) ordered.push(unquoted);
  if (s2) ordered.push(s2);
  if (s) ordered.push(s);
  if (t) ordered.push(t);

  return [...new Set(ordered)];
}

const ROLE_PREFIX = "role|";
const PLACEHOLDER_PREFIX = "placeholder|";
const LABEL_PREFIX = "label|";
const TEXT_PREFIX = "text|";
const TEXT_INPUT_PREFIX = "text_input|";
const FILE_INPUT_PREFIX = "file_input|";
const FRAME_PREFIX = "frame|";
const DIALOG_PREFIX = "dialog|";

/** Return a locator for the dialog container: ARIA role="dialog" or div with class "dialog". */
function getDialogLocator(target: Page | Frame): Locator {
  return target.locator('[role="dialog"], .dialog, div.dialog, .modal, div.modal').first();
}

const UUID_SEGMENT_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Derive a stable substring from a frame URL for storage in page objects.
 * Uses base domain (e.g. linksquares.dev) and path without UUIDs so the same
 * locator matches across envs/tenants (e.g. linksquares.dev/unity/templates or draft/details).
 */
export function stableFrameUrlSubstring(frameUrl: string): string {
  try {
    const url = new URL(frameUrl);
    const hostParts = url.hostname.split(".");
    const baseDomain =
      hostParts.length >= 2
        ? hostParts.slice(-2).join(".")
        : url.hostname;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return baseDomain;

    const firstUuidIdx = segments.findIndex((s: string) =>
      UUID_SEGMENT_REGEX.test(s)
    );
    let pathPart: string;
    if (firstUuidIdx === -1) {
      pathPart = segments.slice(0, Math.min(3, segments.length)).join("/");
    } else if (firstUuidIdx > 0) {
      pathPart = segments.slice(0, firstUuidIdx).join("/");
    } else {
      let lastUuidIdx = -1;
      for (let i = segments.length - 1; i >= 0; i--) {
        if (UUID_SEGMENT_REGEX.test(segments[i])) {
          lastUuidIdx = i;
          break;
        }
      }
      pathPart =
        lastUuidIdx >= 0 && lastUuidIdx < segments.length - 1
          ? segments.slice(lastUuidIdx + 1).join("/")
          : segments.join("/");
    }
    const stable = pathPart ? `${baseDomain}/${pathPart}` : baseDomain;
    return stable;
  } catch {
    return frameUrl;
  }
}

/** Serialize role+name (and optional 0-based index) for replay. Index 0 or omitted = first; 1 = second, etc. */
export function serializeRoleLocator(
  role: string,
  name: string,
  index?: number
): string {
  if (index !== undefined && index > 0) {
    return `${ROLE_PREFIX}${role}|${name}|${index}`;
  }
  return `${ROLE_PREFIX}${role}|${name}`;
}

/** Parse trailing " (2)" or " [2]" (1-based) from element string. Returns stripped element and 0-based index (or 0). */
function parseElementIndex(element: string): { elementStripped: string; index: number } {
  const match = element.match(/^(.+?)\s*[(\[]\s*(\d+)\s*[)\]]\s*$/);
  if (!match) return { elementStripped: element.trim(), index: 0 };
  const oneBased = parseInt(match[2], 10);
  return { elementStripped: match[1].trim(), index: Math.max(0, oneBased - 1) };
}

/** Run up to BATCH_SIZE locator attempts in parallel; return first non-null result (in array order). */
const LOCATOR_BATCH_SIZE = 5;

async function raceAbort<T>(p: Promise<T>, abort?: Promise<never>): Promise<T> {
  if (!abort) return p;
  return Promise.race([p, abort]);
}

async function runAttemptBatch(
  attempts: Array<() => Promise<ResolvedLocatorForStep | null>>
): Promise<ResolvedLocatorForStep | null> {
  if (attempts.length === 0) return null;
  const results = await Promise.allSettled(attempts.map((fn) => fn()));
  for (const r of results) {
    if (r.status === "fulfilled" && r.value != null) return r.value;
  }
  return null;
}

/**
 * Try to resolve a step against a single target (page or frame). Returns null if not found.
 * Runs locator strategies in batches of LOCATOR_BATCH_SIZE concurrently; stops when one succeeds.
 */
async function tryResolveInTarget(
  target: LocatorTarget,
  step: StepIntent,
  namesToTry: string[],
  roles: string[],
  timeout: number,
  debug: boolean | undefined,
  elementIndex?: number,
  onLog?: (msg: string) => void,
  abortPromise?: Promise<never>
): Promise<ResolvedLocatorForStep | null> {
  const { action, element } = step;
  const log = (msg: string, ...args: unknown[]) => {
    if (!debug && !onLog) return;
    const full =
      args.length > 0
        ? msg + " " + args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")
        : msg;
    if (onLog) onLog(full);
    if (debug) console.log(msg, ...args);
  };
  const toSingle = <T extends { first: () => T; nth: (n: number) => T }>(loc: T) =>
    elementIndex !== undefined && elementIndex > 0 ? loc.nth(elementIndex) : loc.first();

  const escapeForAttrSelector = (value: string): string =>
    value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/]/g, "\\]");

  // When a role was prioritized by keyword (button, link, radio, input, option, etc.), try that role's strategies first.
  const preferredRole = roles[0];
  const clickOrHover = action === "click" || action === "hover" || action === "dblclick";
  const fillOrSelect = action === "fill" || action === "select";
  const preferredForClickHover = [
    "button",
    "link",
    "radio",
    "tab",
    "option",
    "menuitem",
    "row",
    "gridcell",
    "cell",
  ].includes(preferredRole ?? "");
  const preferredForFillSelect = ["textbox", "searchbox", "combobox"].includes(
    preferredRole ?? ""
  );
  const tryPreferredRoleFirst =
    preferredRole &&
    ((clickOrHover && preferredForClickHover) || (fillOrSelect && preferredForFillSelect));

  type Attempt = () => Promise<ResolvedLocatorForStep | null>;
  const attempts: Attempt[] = [];

  for (const name of namesToTry) {
    const nameRegex = new RegExp(
      name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
      "i"
    );
    const ciRegex = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    // For upload: "file input" / "file" targets the visible <input type="file"> (e.g. after clicking "New File(s)").
    if (action === "upload" && (name === "file input" || name === "file")) {
      attempts.push(async () => {
        try {
          const loc = target.locator('input[type="file"]').first();
          await loc.waitFor({ state: "visible", timeout });
          log("[discovery] matched by file input", JSON.stringify({ name }));
          return {
            stored: FILE_INPUT_PREFIX,
            locator: loc,
            clickLocator: loc,
            fillLocator: loc,
          };
        } catch {
          return null;
        }
      });
    }

    if (fillOrSelect) {
      attempts.push(async () => {
        try {
          const labelLike = target.getByText(name, { exact: false });
          const container = labelLike.locator(
            "xpath=parent::*[.//input or .//textarea or .//*[@contenteditable='true']][1]"
          );
          const inputLike = container
            .locator("input, textarea, [contenteditable='true']")
            .filter({ visible: true });
          const input = inputLike.first();
          await input.waitFor({ state: "visible", timeout });
          log("[discovery] matched by text+descendant-input (fill first)", JSON.stringify({ name }));
          return {
            stored: `${TEXT_INPUT_PREFIX}${name}`,
            locator: input,
            clickLocator: container.first(),
            fillLocator: input,
          };
        } catch {
          return null;
        }
      });
      attempts.push(async () => {
        try {
          const phRegex = new RegExp(name.replace(/\s+/g, "\\s+"), "i");
          const loc = target.getByPlaceholder(phRegex);
          await loc.waitFor({ state: "visible", timeout });
          log("[discovery] matched by placeholder (fill first)", JSON.stringify({ name }));
          return {
            stored: `${PLACEHOLDER_PREFIX}${name}`,
            locator: loc,
            clickLocator: loc,
            fillLocator: loc,
          };
        } catch {
          return null;
        }
      });
      attempts.push(async () => {
        try {
          const labelRegex = new RegExp(name.replace(/\s+/g, "\\s+"), "i");
          const loc = target.getByLabel(labelRegex);
          await loc.waitFor({ state: "visible", timeout });
          log("[discovery] matched by label (fill first)", JSON.stringify({ name }));
          return {
            stored: `${LABEL_PREFIX}${name}`,
            locator: loc,
            clickLocator: loc,
            fillLocator: loc,
          };
        } catch {
          return null;
        }
      });
    }

    // For click/hover on something like "User menu button" where the control's
    // main stable identifier is its title (e.g. <button title="User menu">),
    // try matching by [role="<role>"][title*="<name>"] as a fallback.
    if (clickOrHover) {
      for (const role of roles) {
        const r = role;
        const escaped = escapeForAttrSelector(name);
        attempts.push(async () => {
          try {
            const selector = `[role="${r}"][title*="${escaped}"]`;
            log(
              "[discovery] trying role+title attribute",
              JSON.stringify({ role: r, name, selector })
            );
            const base = target.locator(selector);
            const loc = toSingle(base);
            await loc.waitFor({ state: "visible", timeout });
            log(
              "[discovery] matched by role+title attribute",
              JSON.stringify({ role: r, name, selector })
            );
            return {
              stored: serializeRoleLocator(r, name, elementIndex),
              locator: loc,
              clickLocator: loc,
              fillLocator: loc,
            };
          } catch {
            return null;
          }
        });
      }
      // Also try any element whose title contains the name, regardless of role.
      const escapedName = escapeForAttrSelector(name);
      attempts.push(async () => {
        try {
          const selector = `[title*="${escapedName}"]`;
          log(
            "[discovery] trying title-only attribute",
            JSON.stringify({ name, selector })
          );
          const base = target.locator(selector);
          const loc = toSingle(base);
          await loc.waitFor({ state: "visible", timeout });
          log(
            "[discovery] matched by title-only attribute",
            JSON.stringify({ name, selector })
          );
          // Store the actual selector so established runs use the same
          // strategy (CSS [title*=...]) instead of pretending this was
          // a role+name locator.
          return {
            stored: selector,
            locator: loc,
            clickLocator: loc,
            fillLocator: loc,
          };
        } catch {
          return null;
        }
      });

      // Try data-testid-based selectors commonly used in React apps, using
      // both exact and wildcard matches derived from the logical name.
      const slug = name
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9_-]/g, "");
      const slugTooGeneric = slug === "icon" || slug === "-icon";
      if (slug && !slugTooGeneric) {
        const escapedSlug = escapeForAttrSelector(slug);
        // Exact data-testid match, e.g. data-testid="new-tag-button"
        attempts.push(async () => {
          try {
            const selector = `[data-testid="${escapedSlug}"]`;
            log(
              "[discovery] trying data-testid exact",
              JSON.stringify({ name, slug, selector })
            );
            const base = target.locator(selector);
            const loc = toSingle(base);
            await loc.waitFor({ state: "visible", timeout });
            log(
              "[discovery] matched by data-testid exact",
              JSON.stringify({ name, slug, selector })
            );
            return {
              stored: selector,
              locator: loc,
              clickLocator: loc,
              fillLocator: loc,
            };
          } catch {
            return null;
          }
        });
        // Wildcard data-testid match, e.g. data-testid*="new-tag"
        attempts.push(async () => {
          try {
            const selector = `[data-testid*="${escapedSlug}"]`;
            log(
              "[discovery] trying data-testid contains",
              JSON.stringify({ name, slug, selector })
            );
            const base = target.locator(selector);
            const loc = toSingle(base);
            await loc.waitFor({ state: "visible", timeout });
            log(
              "[discovery] matched by data-testid contains",
              JSON.stringify({ name, slug, selector })
            );
            return {
              stored: selector,
              locator: loc,
              clickLocator: loc,
              fillLocator: loc,
            };
          } catch {
            return null;
          }
        });
      }

      // Icon buttons (e.g. + icon, arrow-up icon): match by data-icon on element or descendant.
      // Map common icon-name phrases to specific icon slugs (e.g. "+" -> "plus", "arrow up" -> "arrow-up");
      // otherwise derive the slug directly from the name.
      const iconNameNorm = name.trim().toLowerCase();
      const iconSlug =
        // "+" icon variants.
        /^\s*\+\s*$|^\s*\+\s*icon\s*$|^\s*plus\s*icon\s*$|^\s*plus\s*$/.test(iconNameNorm)
          ? "plus"
          // "arrow up" icon variants (e.g. "arrow up", "arrow-up icon", "up arrow icon").
          : /^(arrow[-\s]*up|up[-\s]*arrow)(\s*icon\s*)?$/.test(iconNameNorm)
          ? "arrow-up"
          // Fallback: use the generic slug from the name if it isn't too generic, or normalize the raw name.
          : (slugTooGeneric ? "" : slug) ||
            iconNameNorm.replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
      const iconSlugTooGeneric = iconSlug === "icon" || iconSlug === "-icon";
      if (iconSlug && !iconSlugTooGeneric) {
        const escapedIcon = escapeForAttrSelector(iconSlug);
        // Prefer the clickable container (button) that contains the icon.
        attempts.push(async () => {
          try {
            const selector = `button:has([data-icon="${escapedIcon}"])`;
            log(
              "[discovery] trying button with data-icon",
              JSON.stringify({ name, iconSlug, selector })
            );
            const base = target.locator(selector);
            const loc = toSingle(base);
            await loc.waitFor({ state: "visible", timeout });
            log(
              "[discovery] matched by button with data-icon",
              JSON.stringify({ name, iconSlug, selector })
            );
            return {
              stored: selector,
              locator: loc,
              clickLocator: loc,
              fillLocator: loc,
            };
          } catch {
            return null;
          }
        });
        // Fallback: the icon element itself (e.g. svg[data-icon="plus"]); click often bubbles to button.
        attempts.push(async () => {
          try {
            const selector = `[data-icon="${escapedIcon}"]`;
            log(
              "[discovery] trying data-icon element",
              JSON.stringify({ name, iconSlug, selector })
            );
            const base = target.locator(selector);
            const loc = toSingle(base);
            await loc.waitFor({ state: "visible", timeout });
            log(
              "[discovery] matched by data-icon element",
              JSON.stringify({ name, iconSlug, selector })
            );
            return {
              stored: selector,
              locator: loc,
              clickLocator: loc,
              fillLocator: loc,
            };
          } catch {
            return null;
          }
        });
        // Icon slug contains (e.g. data-icon*="plus" for Font Awesome–style attributes).
        attempts.push(async () => {
          try {
            const selector = `button:has([data-icon*="${escapedIcon}"])`;
            log(
              "[discovery] trying button with data-icon contains",
              JSON.stringify({ name, iconSlug, selector })
            );
            const base = target.locator(selector);
            const loc = toSingle(base);
            await loc.waitFor({ state: "visible", timeout });
            log(
              "[discovery] matched by button with data-icon contains",
              JSON.stringify({ name, iconSlug, selector })
            );
            return {
              stored: selector,
              locator: loc,
              clickLocator: loc,
              fillLocator: loc,
            };
          } catch {
            return null;
          }
        });
      }
    }

    if (tryPreferredRoleFirst) {
      attempts.push(async () => {
        try {
          log(
            "[discovery] trying role+regex (preferred)",
            JSON.stringify({
              role: preferredRole,
              name,
              pattern: nameRegex.source,
            })
          );
          const base = target.getByRole(preferredRole as "button", { name: nameRegex });
          const loc = toSingle(base);
          await loc.waitFor({ state: "visible", timeout });
          log("[discovery] matched by role+regex (preferred)");
          return {
            stored: serializeRoleLocator(preferredRole, name, elementIndex),
            locator: loc,
            clickLocator: loc,
            fillLocator: loc,
          };
        } catch {
          return null;
        }
      });
      attempts.push(async () => {
        try {
          log(
            "[discovery] trying role+name (preferred)",
            JSON.stringify({ role: preferredRole, pattern: ciRegex.source })
          );
          const base = target.getByRole(preferredRole as "button", { name: ciRegex });
          const loc = toSingle(base);
          await loc.waitFor({ state: "visible", timeout });
          log("[discovery] matched by role+name (preferred)");
          return {
            stored: serializeRoleLocator(preferredRole, name, elementIndex),
            locator: loc,
            clickLocator: loc,
            fillLocator: loc,
          };
        } catch {
          return null;
        }
      });
      if (clickOrHover) {
        attempts.push(async () => {
          try {
            log(
              "[discovery] trying role+hasText (preferred)",
              JSON.stringify({ role: preferredRole, pattern: ciRegex.source })
            );
            const roleLoc = target
              .getByRole(preferredRole as "button")
              .filter({ hasText: ciRegex });
            const loc = toSingle(roleLoc);
            await loc.waitFor({ state: "visible", timeout });
            log("[discovery] matched by role+hasText (preferred)");
            return {
              stored: serializeRoleLocator(preferredRole, name, elementIndex),
              locator: loc,
              clickLocator: loc,
              fillLocator: loc,
            };
          } catch {
            return null;
          }
        });
      }
    }

    for (const role of roles) {
      const r = role;
      attempts.push(async () => {
        try {
          log(
            "[discovery] trying role+regex",
            JSON.stringify({ role: r, name, pattern: nameRegex.source })
          );
          const base = target.getByRole(r as "button", { name: nameRegex });
          const loc = toSingle(base);
          await loc.waitFor({ state: "visible", timeout });
          log("[discovery] matched by role+regex", JSON.stringify({ role: r, name }));
          return {
            stored: serializeRoleLocator(r, name, elementIndex),
            locator: loc,
            clickLocator: loc,
            fillLocator: loc,
          };
        } catch {
          return null;
        }
      });
    }

    for (const role of roles) {
      const r = role;
      const ci = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      attempts.push(async () => {
        try {
          log(
            "[discovery] trying role+name",
            JSON.stringify({ role: r, pattern: ci.source })
          );
          const base = target.getByRole(r as "button", { name: ci });
          const loc = toSingle(base);
          await loc.waitFor({ state: "visible", timeout });
          log("[discovery] matched by role+name", JSON.stringify({ role: r, name }));
          return {
            stored: serializeRoleLocator(r, name, elementIndex),
            locator: loc,
            clickLocator: loc,
            fillLocator: loc,
          };
        } catch {
          return null;
        }
      });
    }

    if (clickOrHover) {
      for (const name of namesToTry) {
        const n = name;
        attempts.push(async () => {
          try {
            const textRegex = new RegExp(
              n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
              "i"
            );
            const buttonLoc = target.getByRole("button").filter({ hasText: textRegex });
            const loc = toSingle(buttonLoc);
            await loc.waitFor({ state: "visible", timeout });
            log("[discovery] matched by button+hasText", JSON.stringify({ name }));
            return {
              stored: serializeRoleLocator("button", name, elementIndex),
              locator: loc,
              clickLocator: loc,
              fillLocator: loc,
            };
          } catch {
            return null;
          }
        });
      }
    }
  }

  const elementText = element;
  const shouldTryTextInputForClick =
    (action === "click" || action === "dblclick") &&
    typeof elementText === "string" &&
    /\b(input|field|dropdown)\b/i.test(elementText);

  if (action !== "fill" && action !== "select") {
    for (const name of namesToTry) {
      const n = name;
      attempts.push(async () => {
        try {
          const nameRegex = new RegExp(n.replace(/\s+/g, "\\s+"), "i");
          const loc = target.getByPlaceholder(nameRegex).first();
          await loc.waitFor({ state: "visible", timeout });
          log("[discovery] matched by placeholder", JSON.stringify({ name: n }));
          return {
            stored: `${PLACEHOLDER_PREFIX}${n}`,
            locator: loc,
            clickLocator: loc,
            fillLocator: loc,
          };
        } catch {
          return null;
        }
      });
    }
    for (const name of namesToTry) {
      const n = name;
      attempts.push(async () => {
        try {
          const nameRegex = new RegExp(n.replace(/\s+/g, "\\s+"), "i");
          const loc = target.getByLabel(nameRegex).first();
          await loc.waitFor({ state: "visible", timeout });
          log("[discovery] matched by label", JSON.stringify({ name: n }));
          return {
            stored: `${LABEL_PREFIX}${n}`,
            locator: loc,
            clickLocator: loc,
            fillLocator: loc,
          };
        } catch {
          return null;
        }
      });
    }
  }

  if (shouldTryTextInputForClick) {
    for (const name of namesToTry) {
      const n = name;
      attempts.push(async () => {
        try {
          const labelLike = target.getByText(n, { exact: false });
          const container = labelLike.locator(
            "xpath=parent::*[.//input or .//textarea or .//*[@contenteditable='true']][1]"
          );
          const inputLike = container
            .locator("input, textarea, [contenteditable='true']")
            .filter({ visible: true });
          const input = inputLike.first();
          await input.waitFor({ state: "visible", timeout });
          log(
            "[discovery] matched by text+descendant-input",
            JSON.stringify({ name: n })
          );
          return {
            stored: `${TEXT_INPUT_PREFIX}${n}`,
            locator: input,
            clickLocator: container.first(),
            fillLocator: input,
          };
        } catch {
          return null;
        }
      });
    }
  }

  if (action === "click" || action === "hover" || action === "dblclick") {
    for (const name of namesToTry) {
      const n = name;
      attempts.push(async () => {
        try {
          const textRegex = new RegExp(
            n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
            "i"
          );
          const loc = target.getByText(textRegex, { exact: true }).first();
          await loc.waitFor({ state: "visible", timeout });
          log("[discovery] matched by text-exact", JSON.stringify({ name: n }));
          return {
            stored: `${TEXT_PREFIX}${n}`,
            locator: loc,
            clickLocator: loc,
            fillLocator: loc,
          };
        } catch {
          return null;
        }
      });
      attempts.push(async () => {
        try {
          const ciContains = new RegExp(
            n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            "i"
          );
          const loc = target.getByText(ciContains).first();
          await loc.waitFor({ state: "visible", timeout });
          log("[discovery] matched by text", JSON.stringify({ name: n }));
          return {
            stored: `${TEXT_PREFIX}${n}`,
            locator: loc,
            clickLocator: loc,
            fillLocator: loc,
          };
        } catch {
          return null;
        }
      });
    }
  }

  // Run attempts in batches of LOCATOR_BATCH_SIZE; stop when one succeeds
  for (let i = 0; i < attempts.length; i += LOCATOR_BATCH_SIZE) {
    const batch = attempts.slice(i, i + LOCATOR_BATCH_SIZE);
    const result = await raceAbort(runAttemptBatch(batch), abortPromise);
    if (result) return result;
  }

  return null;
}

/**
 * Resolve a step intent (logical element name) to a Playwright locator string
 * that we can store and reuse. Prefer role+name for stability.
 * When debug is true, logs attempts and timings.
 */
export async function resolveLocator(
  page: Page,
  step: StepIntent,
  options?: ResolveLocatorOptions
): Promise<ResolvedLocatorForStep | null> {
  const locCfg = getUiplayConfig().timeouts.locator;
  const { action, element, locator } = step;
  const debug = options?.debug;
  const timeout = options?.timeoutMs ?? locCfg.defaultStrategyMs;
  const abortPromise = options?.abortPromise;
  const start = debug || options?.onLog ? Date.now() : 0;

  const doLog = (msg: string, ...rest: unknown[]) => {
    if (!debug && !options?.onLog) return;
    const full =
      rest.length > 0
        ? msg + " " + rest.map((r) => (typeof r === "object" ? JSON.stringify(r) : String(r))).join(" ")
        : msg;
    if (options?.onLog) options.onLog(full);
    if (debug) console.log(msg, ...rest);
  };

  doLog(
    "[discovery] resolving step",
    JSON.stringify({ action: step.action, element: step.element, value: step.value })
  );

  // If an explicit locator override is provided on the step, prefer it over
  // any logical-name-based resolution. The locator string is either:
  // - a plain Playwright selector (treated as CSS/xpath/role=, etc.), or
  // - one of our stored locator formats (role|..., placeholder|..., text_input|..., frame|..., dialog|...).
  if (locator && locator.trim()) {
    const selector = locator.trim();
    const clickOrHover = action === "click" || action === "hover" || action === "dblclick";
    const fillOrSelect = action === "fill" || action === "select";
    const looksStored =
      selector.startsWith(ROLE_PREFIX) ||
      selector.startsWith(PLACEHOLDER_PREFIX) ||
      selector.startsWith(LABEL_PREFIX) ||
      selector.startsWith(TEXT_PREFIX) ||
      selector.startsWith(TEXT_INPUT_PREFIX) ||
      selector === FILE_INPUT_PREFIX ||
      selector.startsWith(FRAME_PREFIX) ||
      selector.startsWith(DIALOG_PREFIX);
    try {
      // Probe that the explicit locator actually matches something visible.
      const baseLocator = looksStored
        ? await raceAbort(applyStoredLocator(page, selector), abortPromise)
        : page.locator(selector).first();
      await raceAbort(baseLocator.waitFor({ state: "visible", timeout }), abortPromise);
      doLog("[discovery] using explicit locator override", JSON.stringify({ selector, action }));
      return {
        stored: selector,
        locator: baseLocator,
        ...(clickOrHover ? { clickLocator: baseLocator } : {}),
        ...(fillOrSelect ? { fillLocator: baseLocator } : {}),
      };
    } catch (e) {
      if (e instanceof Error && e.message === "Stopped") throw e;
      if (!options?.fallbackOnExplicitLocatorFailure) {
        // Keep existing behavior for established/debug: invalid explicit locator is a hard failure.
        throw e;
      }
      doLog(
        "[discovery] explicit locator override failed, falling back to name-based resolver",
        JSON.stringify({ selector, action })
      );
      // fall through to element-based resolution below
    }
  }

  if (!element) {
    if (action === "navigate") return null;
    return null;
  }

  // When element mentions "inside iframe" or "inside dialog", strip both phrases (any order) for matching and scope resolution.
  const preferredInIframe = /\binside\s+iframe\b/i.test(element);
  const preferredInDialog = /\binside\s+dialog\b/i.test(element);
  let elementForMatch = element;
  for (let prev = ""; prev !== elementForMatch;) {
    prev = elementForMatch;
    if (preferredInIframe)
      elementForMatch = elementForMatch.replace(/\s*inside\s+iframe\s*$/i, "").trim() || elementForMatch;
    if (preferredInDialog)
      elementForMatch = elementForMatch.replace(/\s*inside\s+dialog\s*$/i, "").trim() || elementForMatch;
  }
  const { elementStripped: elementForMatchFinal, index: elementIndex } =
    parseElementIndex(elementForMatch);
  const stepForResolve: StepIntent = { ...step, element: elementForMatchFinal };

  const namesToTry = normalizeElementForMatch(elementForMatchFinal);
  doLog(
    "[discovery] candidate names:",
    namesToTry,
    preferredInIframe ? " (prefer iframe)" : "",
    preferredInDialog ? " (prefer dialog)" : ""
  );
  const roleMap: Record<string, string[]> = {
    click: [
      "radio", // input[type="radio"] with accessible name
      "button",
      "link",
      "menuitem",
      "tab",
      "option",
      "row",
      "gridcell",
      "cell",
    ],
    dblclick: [
      "radio",
      "button",
      "link",
      "menuitem",
      "tab",
      "option",
      "row",
      "gridcell",
      "cell",
    ],
    fill: ["textbox", "searchbox", "combobox"],
    select: ["combobox", "listbox"],
    hover: ["radio", "button", "link", "menuitem", "row", "gridcell", "cell"],
    wait_enabled: [
      "row",
      "gridcell",
      "cell",
      "radio",
      "button",
      "link",
      "menuitem",
      "tab",
      "option",
    ],
  };
  let roles = roleMap[action] ?? ["button", "link", "textbox", "searchbox"];

  // Prioritize roles by keywords in the element so we try the right control type first
  // (e.g. "Internal Review button" → try button before radio/link; "Manager link" → try link first).
  const KEYWORD_ROLES: Array<{ pattern: RegExp; roles: string[] }> = [
    { pattern: /\btable\s+row\b/i, roles: ["row", "gridcell", "cell"] },
    { pattern: /\bradio\b/i, roles: ["radio"] },
    { pattern: /\blink\b/i, roles: ["link"] },
    { pattern: /\bbutton\b/i, roles: ["button", "menuitem"] },
    { pattern: /\btab\b/i, roles: ["tab"] },
    { pattern: /\boption\b/i, roles: ["option"] },
    { pattern: /\bmenuitem\b/i, roles: ["menuitem"] },
    { pattern: /\b(input|field|textbox)\b/i, roles: ["textbox", "searchbox"] },
  ];
  for (const { pattern, roles: preferred } of KEYWORD_ROLES) {
    if (pattern.test(elementForMatchFinal)) {
      const preferredInList = preferred.filter((p) => roles.includes(p));
      if (preferredInList.length > 0) {
        roles = [...preferredInList, ...roles.filter((r) => !preferred.includes(r))];
      }
      break;
    }
  }

  const tryMainFirst = !preferredInIframe;
  const bothDialogAndIframe = preferredInDialog && preferredInIframe;

  // When "inside dialog" only (no iframe): resolve within dialog on main page (role="dialog" or .dialog).
  if (preferredInDialog && !preferredInIframe) {
    const dialogTarget = getDialogLocator(page);
    const result = await tryResolveInTarget(
      dialogTarget,
      stepForResolve,
      namesToTry,
      roles,
      Math.max(timeout, locCfg.dialogMinimumMs),
      debug,
      elementIndex,
      options?.onLog,
      abortPromise
    );
    if (result) {
      doLog("[discovery] matched inside dialog", JSON.stringify({ stored: result.stored }));
      return {
        ...result,
        stored: `${DIALOG_PREFIX}${result.stored}`,
      };
    }
  }

  // When preferring iframe, wait for at least one child frame to be ready (loaded) before resolving.
  if (preferredInIframe) {
    await raceAbort(waitForChildFrameReady(page, locCfg.childFrameReadyMs), abortPromise);
    doLog(
      "[discovery] child frames:",
      page
        .frames()
        .filter((f) => f !== page.mainFrame())
        .map((f) => f.url())
    );
  }

  // When both "inside dialog" and "inside iframe": resolve iframe first, then dialog inside that frame.
  if (bothDialogAndIframe) {
    const frameTimeout = Math.max(timeout, locCfg.frameStrategyMinimumMs);
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        await raceAbort(
          frame.waitForLoadState("domcontentloaded", { timeout: locCfg.frameDomContentLoadedMs }),
          abortPromise
        );
      } catch (e) {
        if (e instanceof Error && e.message === "Stopped") throw e;
        // continue; frame might still be usable
      }
      const dialogTarget = getDialogLocator(frame);
      const result = await tryResolveInTarget(
        dialogTarget,
        stepForResolve,
        namesToTry,
        roles,
        frameTimeout,
        debug,
        elementIndex,
        options?.onLog,
        abortPromise
      );
      if (result) {
        const frameUrl = frame.url();
        const stableSubstring = stableFrameUrlSubstring(frameUrl);
        doLog(
          "[discovery] matched inside iframe then inside dialog",
          JSON.stringify({ frameUrl, stableSubstring, stored: result.stored })
        );
        return {
          ...result,
          stored: `${FRAME_PREFIX}${stableSubstring}|${DIALOG_PREFIX}${result.stored}`,
        };
      }
    }
    doLog("[discovery] no dialog inside any iframe for step, continuing with other strategies");
  }

  if (tryMainFirst) {
    // Try main page first, then iframes
    let result = await tryResolveInTarget(
      page,
      stepForResolve,
      namesToTry,
      roles,
      timeout,
      debug,
      elementIndex,
      options?.onLog,
      abortPromise
    );
    if (result) return result;

    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      result = await tryResolveInTarget(
        frame,
        stepForResolve,
        namesToTry,
        roles,
        timeout,
        debug,
        elementIndex,
        options?.onLog,
        abortPromise
      );
      if (result) {
        const frameUrl = frame.url();
        const stableSubstring = stableFrameUrlSubstring(frameUrl);
        doLog(
          "[discovery] matched inside iframe",
          JSON.stringify({ frameUrl, stableSubstring })
        );
        return {
          ...result,
          stored: `${FRAME_PREFIX}${stableSubstring}|${result.stored}`,
        };
      }
    }
  } else {
    // "inside iframe" in step: try iframes first (each frame waited for load), then main page
    const frameTimeout = Math.max(timeout, locCfg.frameStrategyMinimumMs);
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        await raceAbort(
          frame.waitForLoadState("domcontentloaded", { timeout: locCfg.frameDomContentLoadedMs }),
          abortPromise
        );
      } catch (e) {
        if (e instanceof Error && e.message === "Stopped") throw e;
        // continue; frame might still be usable
      }
      const result = await tryResolveInTarget(
        frame,
        stepForResolve,
        namesToTry,
        roles,
        frameTimeout,
        debug,
        elementIndex,
        options?.onLog,
        abortPromise
      );
      if (result) {
        const frameUrl = frame.url();
        const stableSubstring = stableFrameUrlSubstring(frameUrl);
        doLog(
          "[discovery] matched inside iframe (preferred)",
          JSON.stringify({ frameUrl, stableSubstring })
        );
        return {
          ...result,
          stored: `${FRAME_PREFIX}${stableSubstring}|${result.stored}`,
        };
      }
    }

    const result = await tryResolveInTarget(
      page,
      stepForResolve,
      namesToTry,
      roles,
      timeout,
      debug,
      elementIndex,
      options?.onLog,
      abortPromise
    );
    if (result) return result;
  }

  doLog("[discovery] locator not found for step after", Date.now() - start, "ms");

  return null;
}

/** Apply a stored locator string to a page or frame and return the Locator. Uses .first() when multiple elements match to avoid strict mode violations. */
function applyStoredLocatorToTarget(
  target: LocatorTarget,
  stored: string
): ReturnType<Page["locator"]> {
  if (stored.startsWith(ROLE_PREFIX)) {
    const rest = stored.slice(ROLE_PREFIX.length);
    const parts = rest.split("|");
    const role = parts[0];
    const last = parts[parts.length - 1];
    const numericLast = /^\d+$/.test(last);
    const name =
      numericLast && parts.length >= 3
        ? parts.slice(1, -1).join("|")
        : parts.slice(1).join("|");
    const index =
      numericLast && parts.length >= 3 ? parseInt(last, 10) : 0;
    const base = target.getByRole(role as "button", { name: name || undefined });
    return index > 0 ? base.nth(index) : base.first();
  }
  if (stored.startsWith(PLACEHOLDER_PREFIX)) {
    return target
      .getByPlaceholder(stored.slice(PLACEHOLDER_PREFIX.length))
      .first();
  }
  if (stored.startsWith(LABEL_PREFIX)) {
    return target.getByLabel(stored.slice(LABEL_PREFIX.length)).first();
  }
  if (stored.startsWith(TEXT_PREFIX)) {
    return target.getByText(stored.slice(TEXT_PREFIX.length)).first();
  }
  if (stored.startsWith(TEXT_INPUT_PREFIX)) {
    const label = stored.slice(TEXT_INPUT_PREFIX.length);
    const labelLike = target.getByText(label, { exact: false });
    const container = labelLike.locator(
      "xpath=parent::*[.//input or .//textarea or .//*[@contenteditable='true']][1]"
    );
    return container
      .locator("input, textarea, [contenteditable='true']")
      .first();
  }
  if (stored === FILE_INPUT_PREFIX) {
    return target.locator('input[type="file"]').first();
  }
  return target.locator(stored).first();
}

/**
 * Wait for at least one child frame to exist and reach domcontentloaded (so we can resolve locators inside it).
 * Polls until a non–about:blank child frame is present and has loaded, or timeout.
 */
async function waitForChildFrameReady(page: Page, timeoutMs?: number): Promise<void> {
  const L = getUiplayConfig().timeouts.locator;
  const deadline = Date.now() + (timeoutMs ?? L.childFrameReadyMs);
  const pollMs = L.childFramePollMs;
  while (Date.now() < deadline) {
    const childFrames = page.frames().filter((f) => f !== page.mainFrame());
    for (const frame of childFrames) {
      const url = frame.url();
      if (!url || url === "about:blank") continue;
      try {
        await frame.waitForLoadState("domcontentloaded", { timeout: L.frameDomContentLoadedMs });
        return;
      } catch {
        // try next frame or poll again
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Wait for a child frame whose URL contains the given substring (partial URL).
 * Uses polling so iframes that load after the page are found.
 */
async function waitForFrameWithUrlSubstring(
  page: Page,
  urlSubstring: string,
  timeoutMs?: number
): Promise<Frame> {
  const L = getUiplayConfig().timeouts.locator;
  const deadline = Date.now() + (timeoutMs ?? L.frameUrlMatchMs);
  const pollMs = L.frameUrlPollMs;
  while (Date.now() < deadline) {
    const frame = page
      .frames()
      .find(
        (f) =>
          f !== page.mainFrame() &&
          (f.url() === urlSubstring || f.url().includes(urlSubstring))
      );
    if (frame) return frame;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `Frame not found for URL (or substring): ${urlSubstring} after ${timeoutMs}ms. Available: ${page
      .frames()
      .map((f) => f.url())
      .join(", ")}`
  );
}

/** Apply a stored locator string to a page and return the Locator. Handles frame|url|..., frame|url|dialog|..., and dialog|... formats. */
export async function applyStoredLocator(
  page: Page,
  stored: string
): Promise<ReturnType<Page["locator"]>> {
  if (stored.startsWith(FRAME_PREFIX)) {
    const after = stored.slice(FRAME_PREFIX.length);
    const pipe = after.indexOf("|");
    const frameUrlSubstring = after.slice(0, pipe);
    const rest = after.slice(pipe + 1);
    const frame = await waitForFrameWithUrlSubstring(page, frameUrlSubstring);
    if (rest.startsWith(DIALOG_PREFIX)) {
      const innerStored = rest.slice(DIALOG_PREFIX.length);
      const dialog = getDialogLocator(frame);
      return applyStoredLocatorToTarget(dialog, innerStored);
    }
    return applyStoredLocatorToTarget(frame, rest);
  }
  if (stored.startsWith(DIALOG_PREFIX)) {
    const rest = stored.slice(DIALOG_PREFIX.length);
    const dialog = getDialogLocator(page);
    return applyStoredLocatorToTarget(dialog, rest);
  }
  return applyStoredLocatorToTarget(page, stored);
}


