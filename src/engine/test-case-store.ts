import fs from "fs";
import path from "path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { TESTS_DIR, ensureDirs } from "./config";
import { formatStepToLine, parseStepLine } from "./step-line";
import type { PlainTextTestCase, StepIntent } from "./types";

const YAML_EXT = ".yaml";
const JSON_EXT = ".json";

/** YAML shape: test_case at root with actions nested inside */
export interface TestCaseYaml {
  test_case: {
    id: string;
    title: string;
    established?: boolean;
    baseUrl?: string;
    pageObjectId?: string;
    env?: Record<string, string>;
    variables?: Record<string, string>;
    actions?: string[];
    /** @deprecated use actions; still read for backward compat */
    steps?: string[];
  };
  /** @deprecated use test_case.actions; still read for backward compat */
  steps?: string[];
}

function isCommentStepLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("#");
}

/**
 * Peel YAML list-item scalar wrapping (`"..."` or `'...'`) and strip trailing inline
 * comments only when `#` is followed by whitespace (not `#id` selectors).
 */
function normalizeRawListStepText(raw: string): string {
  let t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    t = t
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  } else if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    t = t.slice(1, -1).replace(/''/g, "'");
  }
  return t.replace(/\s+#\s+.*$/, "").trim();
}

/** Count leading whitespace; treat one tab as 2 spaces for indent comparison. */
function visualIndent(s: string): number {
  let n = 0;
  for (const c of s) {
    if (c === " ") n += 1;
    else if (c === "\t") n += 2;
    else break;
  }
  return n;
}

/** Extract the actions block from raw YAML (lines under "actions:" or "steps:" including comments). */
function extractActionsBlockFromRaw(
  rawContent: string
): { start: number; end: number; keyLineIndex: number; lines: string[] } | null {
  const lines = rawContent.split(/\r?\n/);
  let keyLineIndex = -1;
  let blockIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:actions|steps)\s*:/);
    if (m) {
      keyLineIndex = i;
      blockIndent = visualIndent(lines[i]);
      break;
    }
  }
  if (keyLineIndex < 0) return null;
  const blockLines: string[] = [];
  for (let i = keyLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const lineIndent = visualIndent(line);
    if (trimmed === "") {
      blockLines.push(line);
      continue;
    }
    if (lineIndent <= blockIndent && /^\S+:\s*$/.test(trimmed)) break;
    if (lineIndent >= blockIndent && (trimmed.startsWith("-") || trimmed.startsWith("#"))) {
      blockLines.push(line);
    } else if (lineIndent <= blockIndent) break;
  }
  const start = keyLineIndex + 1;
  const end = keyLineIndex + blockLines.length;
  return { start, end, keyLineIndex, lines: blockLines };
}

/** Merge executable steps into the raw step block (preserve comment lines). */
function mergeStepsBlock(
  blockLines: string[],
  steps: StepIntent[]
): string[] {
  const result: string[] = [];
  let stepIdx = 0;
  let stepIndent = "  ";

  for (const line of blockLines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#")) {
      result.push(line);
      continue;
    }
    if (trimmed.startsWith("-")) {
      if (stepIdx < steps.length) {
        const formatted = formatStepToLine(steps[stepIdx], { yamlListItem: true });
        stepIdx++;
        stepIndent = line.slice(0, line.length - trimmed.length);
        const trailingComment = trimmed.match(/\s+#\s+.*$/)?.[0] ?? "";
        result.push(stepIndent + (formatted ? `- ${formatted}${trailingComment}` : trimmed));
      }
      // Else: step was deleted in UI; skip this line so it is not written back
      continue;
    }
    result.push(line);
  }

  // Append remaining steps (newly added in debug panel) that weren't in the original block
  if (stepIdx < steps.length) {
    // Remove trailing blank lines so new steps follow directly after the last step
    while (result.length > 0 && result[result.length - 1].trim() === "") {
      result.pop();
    }
    for (let i = stepIdx; i < steps.length; i++) {
      const formatted = formatStepToLine(steps[i], { yamlListItem: true });
      if (formatted) {
        result.push(stepIndent + "- " + formatted);
      }
    }
  }

  return result;
}

function yamlToTestCase(doc: TestCaseYaml, rawContent?: string): PlainTextTestCase {
  const tc = doc.test_case;
  let steps: StepIntent[] = [];
  let rawStepLines: string[] | undefined;

  // When raw content is available, parse steps from raw action lines so that
  // {{variable}} in step text is preserved (YAML parser can treat {{ }} as flow syntax and break the step).
  if (rawContent) {
    const block = extractActionsBlockFromRaw(rawContent);
    if (block && block.lines.length > 0) {
      rawStepLines = block.lines;
      for (const line of block.lines) {
        const trimmed = line.trimStart();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        if (!trimmed.startsWith("-")) continue;
        const stepText = normalizeRawListStepText(trimmed.slice(1).trim());
        if (!stepText) continue;
        try {
          steps.push(parseStepLine(stepText));
        } catch {
          // skip unparseable lines
        }
      }
    }
  }

  if (steps.length === 0) {
    const stepLines = tc.actions ?? tc.steps ?? doc.steps ?? [];
    for (const line of stepLines) {
      if (typeof line !== "string") continue;
      if (!line.trim()) continue;
      if (isCommentStepLine(line)) continue; // keep in rawStepLines only, do not parse
      try {
        steps.push(parseStepLine(line));
      } catch {
        // skip unparseable lines
      }
    }
    rawStepLines = stepLines.length > 0 && stepLines.every((l) => typeof l === "string") ? (stepLines as string[]) : undefined;
  }

  return {
    id: tc.id,
    title: tc.title,
    established: tc.established,
    baseUrl: tc.baseUrl,
    pageObjectId: tc.pageObjectId,
    env: tc.env,
    variables: tc.variables,
    steps: steps.length > 0 ? steps : undefined,
    rawStepLines: rawStepLines?.length ? rawStepLines : undefined,
  };
}

function testCaseToYaml(test: PlainTextTestCase): TestCaseYaml {
  const stepsOut: string[] = (test.steps ?? [])
    .map((s) => formatStepToLine(s, { yamlListItem: true }))
    .filter((s): s is string => Boolean(s && s.trim()));
  return {
    test_case: {
      id: test.id,
      title: test.title,
      ...(test.established != null && { established: test.established }),
      ...(test.baseUrl != null && { baseUrl: test.baseUrl }),
      ...(test.env != null && Object.keys(test.env).length > 0 && { env: test.env }),
      ...(test.variables != null &&
        Object.keys(test.variables).length > 0 && { variables: test.variables }),
      actions: stepsOut,
    },
  };
}

export function getTestCasePath(id: string, ext: ".yaml" | ".json" = ".yaml"): string {
  ensureDirs();
  return path.join(TESTS_DIR, `${id}${ext}`);
}

function findTestCasePath(id: string): string | null {
  ensureDirs();
  const yamlPath = getTestCasePath(id, ".yaml");
  const jsonPath = getTestCasePath(id, ".json");
  if (fs.existsSync(yamlPath)) return yamlPath;
  if (fs.existsSync(jsonPath)) return jsonPath;

  // Fallback: decouple test ID from filename by scanning all test files
  // and returning the one whose declared id matches.
  if (!fs.existsSync(TESTS_DIR)) return null;
  for (const f of fs.readdirSync(TESTS_DIR)) {
    const ext = path.extname(f);
    if (ext !== YAML_EXT && ext !== JSON_EXT) continue;
    const fullPath = path.join(TESTS_DIR, f);
    try {
      const raw = fs.readFileSync(fullPath, "utf-8");
      if (ext === YAML_EXT) {
        const doc = yamlParse(raw) as TestCaseYaml;
        const tcId = doc?.test_case?.id;
        if (tcId === id) return fullPath;
      } else if (ext === JSON_EXT) {
        const parsed = JSON.parse(raw) as
          | (PlainTextTestCase & { test_case?: { id?: string } })
          | TestCaseYaml;
        const tcId =
          (parsed as any)?.test_case?.id ?? (parsed as PlainTextTestCase).id;
        if (tcId === id) return fullPath;
      }
    } catch {
      // ignore parse errors and keep scanning
    }
  }

  return null;
}

export function loadTestCase(id: string): PlainTextTestCase | null {
  const filePath = findTestCasePath(id);
  if (!filePath) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  if (filePath.endsWith(".yaml")) {
    const doc = yamlParse(raw) as TestCaseYaml;
    if (!doc?.test_case) return null;
    const test = yamlToTestCase(doc, raw);
    test.rawFileContent = raw;
    return test;
  }
  const legacy = JSON.parse(raw) as PlainTextTestCase & { plainText?: string };
  if (legacy.plainText != null) delete legacy.plainText;
  return legacy;
}

/** Load a test case from YAML string (e.g. from a file picker in the debug UI). */
export function loadTestCaseFromContent(yamlContent: string): PlainTextTestCase | null {
  const doc = yamlParse(yamlContent) as TestCaseYaml;
  if (!doc?.test_case) return null;
  const test = yamlToTestCase(doc, yamlContent);
  test.rawFileContent = yamlContent;
  return test;
}

export function saveTestCase(test: PlainTextTestCase): void {
  ensureDirs();
  const existingPath = findTestCasePath(test.id);
  const filePath =
    existingPath && existingPath.endsWith(".yaml")
      ? existingPath
      : getTestCasePath(test.id, ".yaml");

  // Always regenerate the YAML from the current test object so that
  // the actions list exactly matches test.steps, including deletions.
  const doc = testCaseToYaml(test);
  const yamlStr = yamlStringify(doc, { lineWidth: 0 }).replace(/\n+$/, "\n");
  fs.writeFileSync(filePath, yamlStr, "utf-8");
}

export function listTestCaseIds(): string[] {
  ensureDirs();
  if (!fs.existsSync(TESTS_DIR)) return [];
  const ids = new Set<string>();
  for (const f of fs.readdirSync(TESTS_DIR)) {
    if (f.endsWith(".yaml") || f.endsWith(".json")) {
      ids.add(path.basename(f, path.extname(f)));
    }
  }
  return Array.from(ids);
}

export interface TestCaseSummary {
  file: string;
  tests: { id: string; title: string }[];
}

/** List all test cases grouped by file name (sorted by file). */
export function listTestCases(): TestCaseSummary[] {
  ensureDirs();
  if (!fs.existsSync(TESTS_DIR)) return [];
  const files = fs
    .readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(YAML_EXT) || f.endsWith(JSON_EXT))
    .sort((a, b) => a.localeCompare(b));

  const result: TestCaseSummary[] = [];

  for (const file of files) {
    const ext = path.extname(file);
    const fullPath = path.join(TESTS_DIR, file);
    const tests: { id: string; title: string }[] = [];
    try {
      const raw = fs.readFileSync(fullPath, "utf-8");
      if (ext === YAML_EXT) {
        const doc = yamlParse(raw) as TestCaseYaml;
        const tc = doc?.test_case;
        if (tc?.id) {
          tests.push({
            id: tc.id,
            title: tc.title || tc.id,
          });
        }
      } else {
        const parsed = JSON.parse(raw) as
          | (PlainTextTestCase & { test_case?: { id?: string; title?: string } })
          | TestCaseYaml;
        const tc: { id?: string; title?: string } =
          (parsed as any).test_case ?? (parsed as any);
        if (tc.id) {
          tests.push({
            id: tc.id,
            title: tc.title || tc.id,
          });
        }
      }
    } catch {
      // Ignore parse errors for listing purposes.
    }

    if (tests.length > 0) {
      result.push({ file, tests });
    }
  }

  return result;
}


