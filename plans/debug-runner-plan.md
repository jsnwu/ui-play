## Debug runner feature plan

### High‑level overview

The **debug runner** is an interactive mode for `uiplay` that:

- Opens a **Playwright browser window** on the target app.
- Shows a **test case panel** with the parsed steps for a given test.
- Lets the user **run individual steps** (one at a time) via a run icon.
- Lets the user **run from a step to the end** or **run the whole test case**.
- Supports **pause/resume** behavior so the user can stop after an action, inspect the UI, then continue.
- Reuses the existing **discovery/established** execution logic so behavior matches normal runs.

This mode is similar to discovery mode, but with **manual run control** instead of always running the full test sequentially.

### Goals and non‑goals

- **Goals**
  - **Step‑level control**: run a single step, or a range of steps, to debug or iterate on locators and flows.
  - **Visual feedback**: always see the real browser while actions run.
  - **Accurate behavior**: reuse `runEstablished`/`runDiscovery` semantics for locator resolution, variable substitution, and waits.
  - **Low friction**: start from an existing YAML test with one CLI command.
  - **No silent mutations by default**: debug runs should not change test YAML or page objects unless explicitly requested.
  - **Live edit**: allow edit, add or delete an action, test it until desire result.

- **Non‑goals (initial version)**
  - No page objects edit from the UI.
  - No automatic self‑healing or LLM‑driven locator updates (beyond what discovery already does).
  - No multi‑test orchestration; debug is scoped to **one test case at a time**.

### User experience

#### CLI entrypoint

- **Command syntax**

```bash
npm run uiplay -- debug <testId> [--headless] [--base-url=...] [--start-step=N]
```

- **Behavior**
  - Loads the YAML test (`uiplay/tests/<id>.yaml`) via the existing test‑case store.
  - Launches Playwright in **headed** mode by default (debug mode implies visible browser).
  - Starts a small **debug UI server** (local HTTP server) or overlay and opens:
    - One browser context/page for the **app under test**.
    - One browser page (or side panel overlay) for the **debug UI**.

#### Debug UI layout

- **Left side: app window**
  - Standard Playwright‑driven page for the test’s app.
  - All actions (click/fill/etc.) are executed here.

- **Right side: test case panel**
  - Shows:
    - Test ID, title, `baseUrl`.
    - Evaluated variables (`variables` + env) for this run.
    - A **step table**:
      - Index (`#`), action, element, value, status, last error (if any).
      - A **run icon** button per row to run that single step.
      - (Optional later) breakpoint toggle per row.

- **Controls**
  - **Run all**: run from step 1 to the end (like `run`).
  - **Run from here**: run from the currently selected step to the end.
  - **Run step**: run only that row’s step.
  - **Pause after each step** (toggle):
    - When enabled, the runner pauses between steps until the user clicks “Continue”.
  - **Continue / Resume**:
    - When paused (due to the toggle or a failure), resumes from the next step.

### Execution model

- **Shared engine**
  - Implement a new engine module `uiplay/engine/debug-runner.ts`.
  - Reuse:
    - `resolveLocator` and locator strategies from `engine/locator-resolver`.
    - Variable substitution (`substitute`, `evaluateVariables`) from `engine/substitute`.
    - Test loading from `engine/test-case-store`.
    - Page objects and merge logic from `engine/page-object-store`.
  - The debug runner should behave like **“run with breakpoints”** on top of the existing `runEstablished` / discovery loops.

- **State machine**
  - Maintain a per‑session state object:
    - `currentStepIndex: number`
    - `steps: StepIntent[]`
    - `mode: "idle" | "running" | "paused" | "error"`
    - `lastError?: string`
    - `pendingCommand?: "run-step" | "run-from-here" | "run-all" | "resume"`
  - The debug UI sends commands; the debug runner consumes them and executes the appropriate subset of steps.

- **Step execution**
  - For a **single step run**:
    - Use the same logic as the established runner (or discovery, depending on whether test is established) to:
      - Resolve the locator.
      - Wait for the right conditions.
      - Perform the action (click/fill/upload/etc.).
    - Update step status (`pending` → `running` → `passed` or `failed`) in the UI.
  - For **run from here / run all**:
    - Iterate from the selected index to the end:
      - Execute each step as above.
      - Respect the **Pause after each step** toggle:
        - If enabled, go to `paused` after each step and wait for a `resume` command.
      - Stop immediately on first failure; show error and keep the browser open.

### Integration with discovery vs established runs

- **Established tests (normal case)**
  - If `test.established === true` and has `steps`, debug runner should:
    - Default to using **established semantics** (page objects only where possible), mirroring `runEstablished`.
    - Optionally offer a “re‑resolve element like discovery” toggle for table rows / dynamic elements (using `resolveLocator`).

- **Non‑established tests**
  - If `established` is `false`:
    - Option 1 (initial): still allow debug, using **discovery‑style resolution** for each step without mutating page objects.
    - Option 2 (future): integrate with a “live discovery” mode that can write back locators alongside debug.

### Implementation phases

- **Phase 1 – Engine and CLI**
  - Add `engine/debug-runner.ts` with:
    - `DebugRunOptions { testId, baseUrl?, env?, headless?, startStepIndex? }`.
    - `runDebugSession(options): Promise<void>` that:
      - Loads the test and env.
      - Launches Playwright (headed).
      - Exposes a simple in‑memory command API (no UI yet) to:
        - Run single step.
        - Run from step.
        - Run all.
      - Logs step statuses to the console (MVP).
  - Add CLI command in `uiplay/cli.ts`:

    ```bash
    npm run uiplay -- debug <testId> [--base-url=] [--headless] [--start-step=N]
    ```

- **Phase 2 – Minimal web UI**
  - Add a small **debug UI server** in `engine/debug-runner.ts`:
    - Use a simple HTTP server (e.g. Node `http` / `express`) to serve:
      - An HTML/JS bundle that renders the step list and controls.
    - Expose a JSON API/WebSocket to:
      - Fetch test metadata and step status.
      - Send commands (`run-step`, `run-from-here`, `run-all`, `resume`).
  - Open the debug UI in:
    - Either the system browser (`open http://localhost:PORT`) or
    - A second Playwright page.

- **Phase 3 – UX polish**
  - Add:
    - Status icons for each step (pending/running/passed/failed/paused).
    - Display of last error and last run timestamp per step.
    - A way to jump `currentStepIndex` by clicking a row.
  - Optional:
    - Support **“breakpoints”**: click a gutter to mark a step that always pauses before/after.
    - “Reset” button to restart from step 0 while keeping the browser open.

- **Phase 4 – Optional enhancements**
  - Allow **saving** updated locators or modified steps from debug back into:
    - Page objects (when discovery‑like re‑resolution is used).
    - Test YAML (e.g. insert new steps or reorder).
  - Integrate with self‑healing:
    - When a step fails, let the user invoke an LLM‑assisted “repair step” that:
      - Suggests new locators.
      - Runs them in debug mode before committing.

### Open questions / decisions

- **UI placement**
  - Should the debug panel be:
    - A separate browser tab/window, or
    - An overlay injected into the app page (using `page.addInitScript`)?
  - Separate tab is simpler to build and reason about but means more window management.

- **Persistence**
  - For the first version, no automatic writes to tests/page objects.
  - Later versions may offer:
    - “Promote successful debug run to established” (update `established: true`).
    - “Update page object from debug session” options.

- **Headless vs headed**
  - Default to headed (`--headless` opt‑in) since this is a debug feature.

This plan should be implemented incrementally, starting with the engine‑only debug runner (Phase 1) to get step‑level control working in the console, then layering on the web‑based test case panel and per‑step run controls in Phase 2 and beyond.

