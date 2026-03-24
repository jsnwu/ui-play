/**
 * Types for the plain-text-driven test framework.
 * Supports discovery (recording locators) and established runs (page objects only).
 */

/** Action types that map to Playwright/MCP operations */
export type StepAction =
  | "navigate"
  | "click"
  | "dblclick"
  | "fill"
  | "select"
  | "hover"
  | "press"
  | "assert_visible"
  | "assert_text"
  | "wait_enabled"
  | "upload"
  | "pause";

/** Single step intent: logical description for discovery or key into page object when established */
export interface StepIntent {
  action: StepAction;
  /** Logical name for the element (e.g. "Sign in button", "Email input") - used as page object key */
  element?: string;
  /**
   * Optional explicit locator override from the plain-text step, e.g.
   * "with locator [data-testid='new-button']". When present, runners
   * should prefer this over resolving from the logical element name.
   * If no engine-specific prefix is given (css=, xpath=, etc.), it is
   * treated as a plain Playwright selector string (CSS by default).
   */
  locator?: string;
  /** Value for fill/select/upload */
  value?: string;
  /** URL for navigate */
  url?: string;
  /** Key for press (e.g. "Enter") */
  key?: string;
  /** Optional page scope (e.g. "login", "dashboard") for page object lookup */
  page?: string;
  /** Seconds for pause (undefined = indefinite, wait for Enter in terminal) */
  seconds?: number;
}

/** A test case: steps are the source of truth (one-line plain text with variable substitution). */
export interface PlainTextTestCase {
  id: string;
  title: string;
  /** When set, this test is established and should run with page objects only */
  established?: boolean;
  /** Page object file key (e.g. "login") used when established */
  pageObjectId?: string;
  /** Steps: parsed from one-line strings (action/element/url/value on same line, {{baseUrl}}/{{env:VAR}} substituted at run) */
  steps?: StepIntent[];
  /** Original step lines from YAML (including commented-out lines) so they can be preserved on save */
  rawStepLines?: string[];
  /** Raw YAML file content when loaded from file; used to preserve comments when saving */
  rawFileContent?: string;
  /** Base URL or env var for navigation (e.g. "PLAYWRIGHT_LOGIN_URL") */
  baseUrl?: string;
  /** Env vars to substitute in steps */
  env?: Record<string, string>;
  /** Per-test variables (static or generated) merged into env before substitution. */
  variables?: Record<string, string>;
}

/** Stored page object: logical name -> Playwright locator string. Aliases map alternative keys to a locator key. */
export interface PageObjectData {
  id: string;
  /** Human-readable name (e.g. "Login page") */
  name?: string;
  /** URL pattern or page name this object is for */
  urlPattern?: string;
  /** Logical name -> locator (selector or getByRole-style) */
  locators: Record<string, string>;
  /** Alias -> canonical key in locators (e.g. "Sign in link" -> "Sign_in_to_the_LinkSquares_Platform") */
  aliases?: Record<string, string>;
  updatedAt?: string;
}

/** Recorded action from a manual walkthrough (Path B) */
export interface RecordedAction {
  action: StepAction;
  selector?: string;
  /**
   * Optional Playwright-style selector when stable (e.g. [data-testid="x"], #safeId).
   * Passed through to StepIntent.locator for discovery runs.
   */
  locator?: string;
  /** Resolved or inferred logical name */
  elementHint?: string;
  value?: string;
  url?: string;
  key?: string;
  timestamp?: number;
  /** True when the action was recorded inside an iframe (element will get " inside iframe" for resolver). */
  inIframe?: boolean;
}


