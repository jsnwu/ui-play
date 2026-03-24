/**
 * Parse a single-line step (plain text with variables like {{baseUrl}}, {{env:VAR}})
 * into StepIntent, and format StepIntent back to a one-line string.
 */
import type { StepIntent } from "./types";

/**
 * `Click A with B` is only element+value when B looks like an intentional payload:
 * quoted string, or a single token. Otherwise "with" is part of the element name
 * (e.g. "Search with DuckDuckGo dropdown").
 */
function looksLikeClickWithPayload(raw: string): boolean {
  const v = raw.trim();
  if (!v) return false;
  if (v.startsWith('"') || v.startsWith("'")) return true;
  return /^\S+$/.test(v);
}

/**
 * `Fill … with …` — if the remainder starts with a quoted element, parse it first (element
 * may contain ` with `). Otherwise: one ` with ` splits element/value; multiple ` with ` →
 * split on the **last** ` with ` so unquoted names like "Search with DuckDuckGo dropdown"
 * work with value "ai tools".
 */
function parseFillElementAndValue(rest: string): { element: string; value: string } {
  const t = rest.trimStart();
  if (t.startsWith('"') || t.startsWith("'")) {
    const q = t[0];
    for (let i = 1; i < t.length; i++) {
      if (t[i] === "\\" && i + 1 < t.length) {
        i++;
        continue;
      }
      if (t[i] === q) {
        const el = t.slice(1, i);
        const after = t.slice(i + 1).trimStart();
        const wm = after.match(/^with\s+(.+)$/i);
        if (wm) return { element: el, value: wm[1].trim() };
        return { element: el, value: "" };
      }
    }
  }

  const matches = [...rest.matchAll(/\s+with\s+/gi)];
  if (matches.length === 0) {
    return { element: rest.trim(), value: "" };
  }
  if (matches.length === 1) {
    const sep = matches[0];
    const idx = sep.index ?? 0;
    return {
      element: rest.slice(0, idx).trim(),
      value: rest.slice(idx + sep[0].length).trim(),
    };
  }
  const sep = matches[matches.length - 1];
  const idx = sep.index ?? 0;
  return {
    element: rest.slice(0, idx).trim(),
    value: rest.slice(idx + sep[0].length).trim(),
  };
}

/** Trim surrounding quotes from a value, unless the closing quote is escaped with backslash. */
function trimQuotedValue(raw: string): string {
  const s = raw.trim();
  if (s.length < 2) return s;
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === `"` || first === `'`) && last === first) {
    // Check if the closing quote is escaped (odd number of backslashes before it).
    let backslashes = 0;
    for (let i = s.length - 2; i >= 0 && s[i] === "\\"; i--) {
      backslashes++;
    }
    const closingEscaped = backslashes % 2 === 1;
    if (!closingEscaped) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Strip a trailing YAML-style inline comment only when `#` is followed by whitespace
 * (e.g. ` # note`). Do not treat `#id` in `with locator #foo` as a comment.
 */
function stripTrailingComment(line: string): string {
  return line.replace(/\s+#\s+.*$/, "").trim();
}

/** Parse one plain-text step line into StepIntent. Trailing `# comment` (hash + space) is stripped. */
export function parseStepLine(line: string): StepIntent {
  let t = stripTrailingComment(line.trim());
  if (!t) throw new Error("Empty step line");

  // Optional explicit locator override suffix:
  // e.g. 'Click New button with locator [data-testid="new-button"]'
  let locator: string | undefined;
  const locatorMatch = t.match(/\s+with\s+locator\s+(.+)$/i);
  if (locatorMatch) {
    locator = trimQuotedValue(locatorMatch[1]);
    t = t.slice(0, t.length - locatorMatch[0].length).trim();
  }

  const navigateMatch = t.match(/^(?:Navigate to|Go to)\s+(.+)$/i);
  if (navigateMatch)
    return {
      action: "navigate",
      url: navigateMatch[1].trim(),
      ...(locator ? { locator } : {}),
    };

  const fillLead = t.match(/^Fill\s+(.+)$/i);
  if (fillLead) {
    const { element, value } = parseFillElementAndValue(fillLead[1]);
    return {
      action: "fill",
      element: trimQuotedValue(element),
      value: trimQuotedValue(value),
      ...(locator ? { locator } : {}),
    };
  }

  const enterInMatch = t.match(/^Enter\s+(.+?)\s+in\s+(.+)$/i);
  if (enterInMatch)
    return {
      action: "fill",
      element: enterInMatch[2].trim(),
      value: trimQuotedValue(enterInMatch[1]),
      ...(locator ? { locator } : {}),
    };

  const dblclickMatch = t.match(/^Double[\s-]*clicks?\s+(.+)$/i);
  if (dblclickMatch)
    return {
      action: "dblclick",
      element: dblclickMatch[1].trim(),
      ...(locator ? { locator } : {}),
    };

  const clickWithMatch = t.match(/^Click\s+(.+?)\s+with\s+(.+)$/i);
  if (clickWithMatch && looksLikeClickWithPayload(clickWithMatch[2])) {
    return {
      action: "click",
      element: clickWithMatch[1].trim(),
      value: trimQuotedValue(clickWithMatch[2]),
      ...(locator ? { locator } : {}),
    };
  }

  const clickMatch = t.match(/^Click\s+(.+)$/i);
  if (clickMatch)
    return {
      action: "click",
      element: clickMatch[1].trim(),
      ...(locator ? { locator } : {}),
    };

  const selectMatch = t.match(/^Select\s+(.+?)(?:\s+in\s+(.+))?$/i);
  if (selectMatch)
    return {
      action: "select",
      element: (selectMatch[2] ?? selectMatch[1]).trim(),
      ...(selectMatch[2] && { value: trimQuotedValue(selectMatch[1]) }),
      ...(locator ? { locator } : {}),
    };

  const hoverMatch = t.match(/^Hover\s+(.+)$/i);
  if (hoverMatch)
    return {
      action: "hover",
      element: hoverMatch[1].trim(),
      ...(locator ? { locator } : {}),
    };

  const pressMatch = t.match(/^Press\s+(.+)$/i);
  if (pressMatch)
    return {
      action: "press",
      key: pressMatch[1].trim(),
      ...(locator ? { locator } : {}),
    };

  const assertVisibleMatch = t.match(/^Assert\s+visible\s+(.+)$/i);
  if (assertVisibleMatch)
    return {
      action: "assert_visible",
      element: assertVisibleMatch[1].trim(),
      ...(locator ? { locator } : {}),
    };

  const assertTextMatch = t.match(/^Assert\s+text\s+(.+)$/i);
  if (assertTextMatch)
    return {
      action: "assert_text",
      element: assertTextMatch[1].trim(),
      ...(locator ? { locator } : {}),
    };

  const waitEnabledMatch = t.match(/^Wait\s+for\s+(.+?)\s+to\s+be\s+enabled\s*$/i);
  if (waitEnabledMatch)
    return {
      action: "wait_enabled",
      element: waitEnabledMatch[1].trim(),
      ...(locator ? { locator } : {}),
    };

  // Upload patterns:
  // - "Upload <file>" (targets the visible file input, e.g. after clicking "New File(s)")
  // - "Upload <file> to <element>"
  // - "Upload <element> with <file>"
  let uploadMatch = t.match(/^Upload\s+(.+?)\s+to\s+(.+)$/i);
  if (uploadMatch) {
    const file = uploadMatch[1];
    const element = uploadMatch[2];
    return {
      action: "upload",
      element: element.trim(),
      value: trimQuotedValue(file),
      ...(locator ? { locator } : {}),
    };
  }
  uploadMatch = t.match(/^Upload\s+(.+?)\s+with\s+(.+)$/i);
  if (uploadMatch) {
    const element = uploadMatch[1];
    const file = uploadMatch[2];
    return {
      action: "upload",
      element: element.trim(),
      value: trimQuotedValue(file),
      ...(locator ? { locator } : {}),
    };
  }
  uploadMatch = t.match(/^Upload\s+(.+)$/i);
  if (uploadMatch) {
    const file = uploadMatch[1];
    return {
      action: "upload",
      element: "file input",
      value: trimQuotedValue(file),
      ...(locator ? { locator } : {}),
    };
  }

  // Pause / Wait for N seconds (must come after "Wait for X to be enabled")
  const waitForMatch = t.match(/^Wait\s+for\s+(\d+)\s*seconds?$/i);
  if (waitForMatch)
    return {
      action: "pause",
      seconds: parseInt(waitForMatch[1], 10),
      ...(locator ? { locator } : {}),
    };
  const pauseForMatch = t.match(/^Pause\s+for\s+(\d+)\s*seconds?$/i);
  if (pauseForMatch)
    return {
      action: "pause",
      seconds: parseInt(pauseForMatch[1], 10),
      ...(locator ? { locator } : {}),
    };
  if (/^Pause\s*$/i.test(t))
    return {
      action: "pause",
      ...(locator ? { locator } : {}),
    };

  throw new Error(`Could not parse step line: ${line}`);
}

function hasValue(v: string | undefined): boolean {
  return v != null && String(v).trim() !== "";
}

/**
 * In YAML block list items, a space before `#` starts an inline comment. Wrap the
 * locator in single quotes only when it contains `#` so the action line stays an
 * unquoted scalar for the rest of the text.
 */
function yamlSafeLocatorFragment(locator: string): string {
  if (!locator.includes("#")) return locator;
  return `'${locator.replace(/'/g, "''")}'`;
}

export interface FormatStepLineOptions {
  /** When saving to YAML, quote locator fragments that contain `#` for plain list items. */
  yamlListItem?: boolean;
}

/** Format StepIntent to a single plain-text line with variable placeholders. */
export function formatStepToLine(step: StepIntent, options?: FormatStepLineOptions): string {
  let core = "";
  switch (step.action) {
    case "navigate":
      core = step.url ? `Navigate to ${step.url}` : "Navigate to {{baseUrl}}";
      break;
    case "click":
      if (step.element && hasValue(step.value)) {
        const v = String(step.value).trim();
        const valuePart =
          /^["']/.test(v) || /^\S+$/.test(v)
            ? v
            : `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        core = `Click ${step.element} with ${valuePart}`;
      } else {
        core = step.element ? `Click ${step.element}` : "";
      }
      break;
    case "dblclick":
      core = step.element ? `Double click ${step.element}` : "";
      break;
    case "fill":
      if (step.element && hasValue(step.value)) {
        const el = String(step.element).trim();
        const v = String(step.value).trim();
        const elPart =
          /\s+with\s+/i.test(el) && !/^["']/.test(el)
            ? `"${el.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
            : el;
        const valPart =
          /^["']/.test(v) || /^\S+$/.test(v)
            ? v
            : `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        core = `Fill ${elPart} with ${valPart}`;
      } else {
        core = step.element ? `Fill ${step.element}` : "";
      }
      break;
    case "select":
      core =
        step.element && hasValue(step.value)
          ? `Select ${step.value} in ${step.element}`
          : step.element
            ? `Select ${step.element}`
            : "";
      break;
    case "hover":
      core = step.element ? `Hover ${step.element}` : "";
      break;
    case "press":
      core = step.key ? `Press ${step.key}` : "Press Enter";
      break;
    case "assert_visible":
      core = step.element ? `Assert visible ${step.element}` : "";
      break;
    case "assert_text":
      core = step.element ? `Assert text ${step.element}` : "";
      break;
    case "wait_enabled":
      core = step.element ? `Wait for ${step.element} to be enabled` : "";
      break;
    case "upload":
      if (step.element === "file input" && hasValue(step.value)) {
        core = `Upload ${step.value}`;
      } else {
        core =
          step.element && hasValue(step.value)
            ? `Upload ${step.element} with ${step.value}`
            : step.element
              ? `Upload ${step.element}`
              : "";
      }
      break;
    case "pause":
      core =
        step.seconds != null ? `Pause for ${step.seconds} seconds` : "Pause";
      break;
    default:
      core = "";
      break;
  }

  if (!core) return core;
  if (step.locator) {
    const loc =
      options?.yamlListItem === true
        ? yamlSafeLocatorFragment(step.locator)
        : step.locator;
    return `${core} with locator ${loc}`;
  }
  return core;
}


