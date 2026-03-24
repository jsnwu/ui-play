#!/usr/bin/env node
/**
 * CLI for the plain-text-driven test framework.
 *
 * Commands:
 *   init-test <id> <title> "step1" "step2" ...   Create test case from step lines (Path A).
 *   discovery <testId>                     Run discovery: parse step lines, Playwright runs and records locators.
 *   run <testId>                           Run an established test using page objects only.
 *   run-all                                Run all established tests in tests/.
 *   debug [<testId>]                       Interactive debug runner (omit testId if only one test exists).
 *   list-tests                             List test case IDs.
 *   list-page-objects                      List page object IDs.
 */

import path from "path";
import { config as loadDotenv } from "dotenv";
import { runDiscovery } from "./engine/discovery-runner";
import { runEstablished } from "./engine/established-runner";
import { runDebug } from "./engine/debug-runner";
import { saveTestCase } from "./engine/test-case-store";
import { listTestCaseIds } from "./engine/test-case-store";
import { listPageObjectIds } from "./engine/page-object-store";
import { loadTestCase } from "./engine/test-case-store";
import { parseStepLine } from "./engine/step-line";

const rootDir = path.resolve(__dirname, "..");
loadDotenv({ path: path.join(rootDir, ".env") });
loadDotenv({ path: path.join(rootDir, "browser", ".env") });

const args = process.argv.slice(2);
const cmd = args[0];

async function main() {
  if (!cmd) {
  console.log(`
Usage:
  npx tsx src/cli.ts init-test <id> <title> "step1" "step2" ...
  npx tsx src/cli.ts discovery <testId> [--base-url=] [--headless]
  npx tsx src/cli.ts run <testId> [--headless]
  npx tsx src/cli.ts run-all [--headless]
  npx tsx src/cli.ts debug [<testId>] [--base-url=] [--headless] [--locator-timeout=MS]
  npx tsx src/cli.ts list-tests
  npx tsx src/cli.ts list-page-objects
`);
    process.exit(1);
  }

  switch (cmd) {
    case "init-test": {
      const id = args[1];
      const title = args[2];
      const stepLines = args.slice(3);
      if (!id || !title || stepLines.length === 0) {
        console.error("Usage: init-test <id> <title> \"step1\" \"step2\" ... (e.g. \"Navigate to {{baseUrl}}\" \"Click Sign in\")");
        process.exit(1);
      }
      const steps = stepLines.map((line) => parseStepLine(line));
      saveTestCase({
        id,
        title,
        steps,
        established: false,
      });
      console.log("Created test case:", id);
      break;
    }

    case "discovery": {
      const testId = args[1];
      const baseUrl = args.find((a) => a.startsWith("--base-url="))?.slice("--base-url=".length);
      const headless = args.includes("--headless");
      const debug = args.includes("--debug");
      const locatorTimeoutArg = args.find((a) =>
        a.startsWith("--locator-timeout=")
      );
      const locatorTimeoutMs = locatorTimeoutArg
        ? Number(locatorTimeoutArg.slice("--locator-timeout=".length)) || undefined
        : undefined;
      if (!testId) {
        console.error(
          "Usage: discovery <testId> [--base-url=URL] [--headless] [--debug] [--locator-timeout=MS]"
        );
        process.exit(1);
      }
      console.log("Running discovery for", testId, "...");
      const result = await runDiscovery({
        testId,
        baseUrl,
        headless,
        debug,
        locatorTimeoutMs,
      });
      if (result.success) {
        console.log("Discovery succeeded. Steps:", result.steps.length, "Page object:", result.pageObjectId);
      } else {
        console.error("Discovery failed:", result.error);
        process.exit(1);
      }
      break;
    }

    case "debug": {
      const positional = args.slice(1).filter((a) => !a.startsWith("--"));
      let testId = positional[0];
      const baseUrl = args.find((a) => a.startsWith("--base-url="))?.slice("--base-url=".length);
      const headless = args.includes("--headless");
      const locatorTimeoutArg = args.find((a) =>
        a.startsWith("--locator-timeout=")
      );
      const locatorTimeoutMs = locatorTimeoutArg
        ? Number(locatorTimeoutArg.slice("--locator-timeout=".length)) || undefined
        : undefined;
      if (!testId) {
        const fromEnv = process.env.UIPLAY_DEBUG_TEST?.trim();
        if (fromEnv) {
          testId = fromEnv;
          console.log(`Using test ID from UIPLAY_DEBUG_TEST: "${testId}".`);
        }
      }
      if (!testId) {
        const ids = listTestCaseIds();
        if (ids.length === 1) {
          testId = ids[0];
          console.log(`No test ID given; using "${testId}" (only test in tests/).`);
        } else if (ids.length === 0) {
          console.log(
            "No test cases in tests/; opening debug UI with an empty session. Save from the UI to create a YAML file."
          );
          await runDebug({
            baseUrl,
            headless,
            locatorTimeoutMs,
          });
          break;
        } else {
          const sorted = [...ids].sort();
          testId = sorted[0];
          console.log(
            `No test ID given; using "${testId}" (first of ${ids.length} tests, alphabetically). ` +
              `Pass a specific id: npm run uiplay:debug -- <testId> — or set UIPLAY_DEBUG_TEST in .env.`
          );
        }
      }
      if (testId) {
        console.log("Starting debug runner for", testId, "...");
      }
      await runDebug({
        testId,
        baseUrl,
        headless,
        locatorTimeoutMs,
      });
      break;
    }

    case "run": {
      const testId = args[1];
      const headless = args.includes("--headless");
      if (!testId) {
        console.error("Usage: run <testId> [--headless]");
        process.exit(1);
      }
      console.log("Running established test:", testId);
      const result = await runEstablished({ testId, headless });
      if (result.success) {
        console.log("Test passed.");
      } else {
        console.error("Test failed:", result.error);
        process.exit(1);
      }
      break;
    }

    case "run-all": {
      const headless = args.includes("--headless");
      const ids = listTestCaseIds();
      if (ids.length === 0) {
        console.log("No test cases found.");
        break;
      }
      console.log("Running all established tests:", ids.join(", "));
      let failures = 0;
      for (const id of ids) {
        const t = loadTestCase(id);
        if (!t?.established) {
          console.log(`Skipping ${id} (not established).`);
          continue;
        }
        console.log("\n---");
        console.log("Running established test:", id);
        const result = await runEstablished({ testId: id, headless });
        if (result.success) {
          console.log("Test passed:", id);
        } else {
          console.error("Test failed:", id, "-", result.error);
          failures++;
        }
      }
      if (failures > 0) {
        console.error(`\n${failures} test(s) failed.`);
        process.exit(1);
      } else {
        console.log("\nAll established tests passed.");
      }
      break;
    }

    case "list-tests": {
      const ids = listTestCaseIds();
      console.log("Test cases:", ids.length ? ids.join(", ") : "(none)");
      for (const id of ids) {
        const t = loadTestCase(id);
        console.log("  ", id, t?.established ? "[established]" : "[not established]", "-", t?.title ?? "");
      }
      break;
    }

    case "list-page-objects": {
      const ids = listPageObjectIds();
      console.log("Page objects:", ids.length ? ids.join(", ") : "(none)");
      break;
    }

    default:
      console.error("Unknown command:", cmd);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
