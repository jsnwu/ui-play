/**
 * Interpreter for parameter and variable substitution in step values and URLs.
 * - Single braces {param_name}: substituted from env (see defaultParamMap or test env).
 * - Double braces {{baseUrl}}, {{env:VAR_NAME}}: existing substitution.
 */

/** Maps placeholder names (e.g. account_name) to env var names (e.g. PLAYWRIGHT_ACCOUNT_NAME). */
const DEFAULT_PARAM_MAP: Record<string, string> = {
  account_name: "PLAYWRIGHT_ACCOUNT_NAME",
  deploy_id: "PLAYWRIGHT_LOGIN_DEPLOY_ID",
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve only single-brace (and double-brace param) placeholders in a value (e.g. env var value). Used so {{env:VAR}} resolves to a value that has {param} already substituted. */
function substituteValueOnly(
  value: string,
  map: Record<string, string>,
  mergedEnv: Record<string, string>
): string {
  let s = value;
  for (const key of Object.keys(map)) {
    const envKey = map[key];
    const v = mergedEnv[envKey];
    const replacement = v != null ? String(v) : "";
    s = s.replace(new RegExp(`\\{\\{${escapeRegExp(key)}\\}\\}`, "g"), replacement);
    s = s.replace(new RegExp(`\\{${escapeRegExp(key)}\\}`, "g"), replacement);
  }
  return s;
}

/**
 * Substitute placeholders in a string using env.
 * - {param} or {{param}} → env[paramMap[param]] (e.g. {account_name} or {{account_name}} → env.PLAYWRIGHT_ACCOUNT_NAME)
 * - {{baseUrl}} → env.BASE_URL ?? env.baseUrl
 * - {{env:VAR}} or {{VAR}} → env[VAR]
 * Runs multiple passes so that values containing placeholders (e.g. PLAYWRIGHT_LOGIN_URL with {{account_name}}) get fully resolved.
 */
export function substitute(
  value: string,
  env: Record<string, string>,
  paramMap?: Record<string, string> | null
): string {
  const map = { ...DEFAULT_PARAM_MAP, ...paramMap };
  const mergedEnv = { ...process.env, ...env } as Record<string, string>;
  let s = value;
  let prev: string;
  let passes = 0;
  const maxPasses = 5;

  do {
    prev = s;

    // Params (single or double brace): {account_name}, {{account_name}} → from mergedEnv so process.env is used
    for (const key of Object.keys(map)) {
      const envKey = map[key];
      const v = mergedEnv[envKey];
      const replacement = v != null ? String(v) : "";
      s = s.replace(new RegExp(`\\{\\{${escapeRegExp(key)}\\}\\}`, "g"), replacement);
      s = s.replace(new RegExp(`\\{${escapeRegExp(key)}\\}`, "g"), replacement);
    }

    // Double-brace: {{env:VAR}}, {{VAR}}, {{baseUrl}}
    // When replacing {{env:VAR}}, resolve the value so single-brace vars (e.g. {account_name}) in it are substituted.
    for (const [k, v] of Object.entries(mergedEnv)) {
      const val = v != null ? String(v) : "";
      const resolvedVal = substituteValueOnly(val, map, mergedEnv);
      s = s.replace(new RegExp(`\\{\\{env:${escapeRegExp(k)}\\}\\}`, "gi"), resolvedVal);
      s = s.replace(new RegExp(`\\{\\{${escapeRegExp(k)}\\}\\}`, "gi"), resolvedVal);
    }
    s = s.replace(/\{\{baseUrl\}\}/gi, mergedEnv.BASE_URL ?? mergedEnv.baseUrl ?? "");

    passes++;
  } while (s !== prev && passes < maxPasses);

  return s;
}

/** Regex: string looks like a full absolute URL (http(s) with host, optional path/query/hash). */
const FULL_URL_REGEX = /^https?:\/\/\S+$/i;

/**
 * Returns true if the string looks like a full navigatable URL (has protocol and host).
 */
export function isFullUrl(urlString: string): boolean {
  const s = urlString.trim();
  return s.length > 0 && FULL_URL_REGEX.test(s);
}

/**
 * Resolve a navigate URL: if it is a partial path (e.g. /manager?tab=finalize-templates),
 * prepend baseUrl to form an absolute URL. Full URLs (matching protocol + host) are returned as-is.
 */
export function resolveNavigateUrl(urlString: string, baseUrl: string): string {
  const s = urlString.trim();
  if (!s) return baseUrl;
  if (isFullUrl(s)) return s;
  if (!baseUrl || !isFullUrl(baseUrl)) return s;
  try {
    return new URL(s, baseUrl).href;
  } catch {
    return s;
  }
}

/** Evaluate per-test variables into concrete values and merge into env.
 *  Supports generator macros inside variable values:
 *  - {{timestamp}}           → shared timestamp for this evaluation (ms since epoch)
 *  - {{randomInt}}           → random 6-digit integer
 *  - {{randomInt[N]}}        → random N-digit integer
 *  - {{randomStr}}           → random 8-char alphanumeric string
 *  - {{randomStr[N]}}        → random N-char alphanumeric string
 *
 * Variables can also reference other env/variables via {{VAR}} or {{env:VAR}}.
 */
export function evaluateVariables(
  variables: Record<string, string> | undefined,
  env: Record<string, string>
): Record<string, string> {
  if (!variables) return {};
  const result: Record<string, string> = {};
  const timestampSeed = Date.now();

  const randomDigits = (len: number): string => {
    let out = "";
    for (let i = 0; i < len; i++) {
      out += Math.floor(Math.random() * 10).toString();
    }
    return out;
  };

  const randomString = (len: number): string => {
    const chars =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let out = "";
    for (let i = 0; i < len; i++) {
      const idx = Math.floor(Math.random() * chars.length);
      out += chars[idx];
    }
    return out;
  };

  for (const [name, raw] of Object.entries(variables)) {
    let s = raw;

    // timestamp macro (case-insensitive)
    s = s.replace(/\{\{timestamp\}\}/gi, String(timestampSeed));

    // randomInt and randomInt[N]
    s = s.replace(
      /\{\{randomInt(?:\[(\d+)\])?\}\}/gi,
      (_m, digits: string | undefined) => {
        const len = digits ? parseInt(digits, 10) || 6 : 6;
        return randomDigits(len);
      }
    );

    // randomStr and randomStr[N]
    s = s.replace(
      /\{\{randomStr(?:\[(\d+)\])?\}\}/gi,
      (_m, lenStr: string | undefined) => {
        const len = lenStr ? parseInt(lenStr, 10) || 8 : 8;
        return randomString(len);
      }
    );

    // After macro expansion, run normal substitution so variables can reference env/other vars.
    const mergedEnv = { ...env, ...result };
    const finalVal = substitute(s, mergedEnv);
    result[name] = finalVal;
  }

  return result;
}

