# Hand-off: issue #165 (screenshot page-state check with an optional vision model)

Delete this file before the PR is merged.

Branch: `feat/165-screenshot-page-check`. Based on main `135950e`; origin/main was still `135950e` at hand-off, so no merge was needed yet. Merge `origin/main` again before finishing.

## Task as given (summary of the original instructions)

- Spec: issue #165 (Korean, includes the 개선 및 완료 기준 checklist). Shared principles: umbrella issue #160. Read with
  `gh api repos/junyeong-nero/open-web-agent/issues/165 --jq .body` (GraphQL `gh issue view` was blocked in the cloud session).
- Follow CLAUDE.md (commit tags, delegated-issue rules: stay scoped, focused tests) and docs/positioning.md: secondary models
  are opt-in, provider-neutral, and called from the agent loop, never inside tools. Do not change tools, tool results or the
  tool list; MCP and the agent must see the same tools.
- Only #165. Parallel sessions own #163 (`--escalate-model`, stall paths in agent.ts), #164 (`--judge-model`, final-answer
  path + small judge client), #166 (`--grounding-model`, a `vision` capability in tools.ts). Keep the diff minimal and local.
- Shared configuration shape for all four roles:
  - flag `--<role>-model <provider:model>` and optional `--<role>-model-options <json>`;
  - env `OWA_<ROLE>_MODEL`, `OWA_<ROLE>_MODEL_OPTIONS`;
  - resolve with the existing `resolveModel` / `parseModelOptions` (src/model/resolve.ts) so every provider shorthand works;
  - agent option `<role>Model?: ModelAdapter` in `AgentOptions`; unset means no change at all (no extra requests);
  - record each secondary call in the trace like other model calls; reuse `Usage` / `sumUsage` (#161); document how the
    secondary model's usage is reported.
- #165 specifics: triggers kept narrow (click interception error; non-error action result whose tree is nearly empty, e.g.
  fewer than 5 lines; optionally the first page of a new host). One viewport screenshot via Playwright `page.screenshot`
  (not page-world evaluate). Ask for a strict JSON verdict on three questions (overlay covering the page / still loading /
  bot check or access denied). Append one line to the transcript, e.g. `Screenshot check: a cookie banner covers the page.`
  Bound the request to a few seconds; failure or timeout is ignored. #157 (page settling) may land in parallel; the trigger
  must work either way. Test with a fake vision adapter: called only on triggers, failure ignored, note appears in the next
  model request.
- Tests must pass on the reviewer's macOS machine:
  - a new Chromium renderer can stall ~2 s on its first text render: never put a short `actionTimeoutMs` / default timeout
    on page loads or snapshots, only around the action under test;
  - use `ControlOrMeta`, not platform-specific keys; stubbed locators must implement `count()`;
  - some sites override `window.eval` (fixture `/toggles-no-eval`): no page-world evaluate on paths that run every action;
  - scripted/fake model adapters only (src/testing/scripted-model.ts); never call real model APIs, never run live evals.
- Verification: `bun run typecheck`, every added/touched test file, then `bun run test` once. On failures rerun the files; if
  still failing, run the same files on main in a separate checkout (`git worktree add /tmp/main origin/main`). Report counts
  honestly.
- Finish: final commit first line `[feat] check page state from a screenshot with an optional vision model` (WIP commits are
  fine, the PR is squash-merged); push; open a PR from `feat/165-screenshot-page-check` into main with the same title. Body:
  `Closes #165.`, short description + design choices, a Validation list with exact commands and pass/fail counts (with the
  main comparison if anything failed), acceptance criteria not met and why (the reviewer's live A/B is not ours to meet), and
  the line `Implemented by Claude Code cloud session (claude-opus-5-5, effort max).` (that line was written for the cloud
  session; adjust it to whoever actually finishes the work). Do not merge.
- Commit attribution used in this session: trailer lines
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01Mw8FzAZJDZQnTf7XHosAXM`; PR descriptions end with
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Use your own session's attribution.

## Done

Commit `990395e` adds `src/screenshot-check.ts`. It is not wired in, has not been typechecked, and has no tests.

- `SCREENSHOT_CHECK_TIMEOUT_MS = 5_000`: one budget for the screenshot and the vision request together.
- `PROMPT` (private): asks for exactly `{"overlay":"none","loading":false,"blocked":false}` where `overlay` is one of
  `"cookie banner" | "sign-in popup" | "popup" | "none"`, and `loading` / `blocked` are booleans.
- `needsScreenshotCheck(tool, result)`: false for an unknown or read-only tool. For an error result: true only when the text
  contains `intercepts pointer events`. Otherwise: true when the snapshot has a tree (text after `\nSnapshot:\n`) with fewer
  than 5 non-blank lines. The "[Current page state unavailable…]" marker has no `\nSnapshot:\n`, so it never triggers.
- `screenshotRequest(jpeg, signal)`: `ModelRequest` with the prompt as `system`, one user message
  `[image (image/jpeg, base64), text "The current page."]`, `tools: []`.
- `screenshotNote(reply)`: takes the first `{` to the last `}` of the reply (tolerates code fences and prose), `JSON.parse`s
  it, then validates strictly: overlay must be one of the four values (trimmed, case-insensitive), `loading` / `blocked`
  must be real booleans. Note text comes only from fixed phrases:
  - blocked → `Screenshot check: the page is a bot check or an access-denied page.` (exclusive, see design)
  - otherwise clauses joined with `; `: `a cookie banner|a sign-in popup|a popup covers the page`, `the page is still loading`
  - nothing found, or anything invalid → `undefined` (no note).

Things to double-check when typechecking: the ternary in `screenshotNote` yields `string[] | (string | false)[]`
(`.filter(Boolean)` does not narrow), which should still allow `.length` / `.join`; `Buffer` relies on bun types.

## Left to do

1. agent.ts wiring (sketch below), 2. CLI flags, 3. MCP pass-through, 4. `parseModelOptions` label, 5. tests, 6. docs,
7. typecheck + tests + PR. Planned file list: `src/screenshot-check.ts` (exists), `src/agent.ts`, `src/cli.ts`, `src/mcp.ts`,
`src/model/resolve.ts`, new `src/screenshot-check.test.ts`, `README.md`, `CLAUDE.md` + `AGENTS.md` (architecture row).
Do not touch `src/tools.ts`, `SYSTEM_PROMPT` or `src/index.ts`.

### 1. agent.ts (suggested code, not compiled)

```ts
import { needsScreenshotCheck, SCREENSHOT_CHECK_TIMEOUT_MS, screenshotNote, screenshotRequest } from "./screenshot-check"

// AgentEvent "model" member gains two optional fields; agent calls keep neither, so traces without vision stay identical:
//   role?: "vision"; error?: string
// AgentResult gains:
//   /** Only with `visionModel`: its calls, summed like `usage` but kept apart because the models' prices differ. */
//   visionUsage?: AgentResult["usage"]
// AgentOptions gains:
//   /** Optional: after an intercepted click or an action that leaves a nearly empty snapshot, a vision model reads a
//    *  screenshot and its finding becomes one line in the transcript. */
//   visionModel?: ModelAdapter

const visionCallUsage: Array<Usage | undefined> = []   // next to callUsage

// finish(): after building `result` (separate statement keeps the long line untouched for easier merges):
if (options.visionModel) result.visionUsage = sumUsage(visionCallUsage)

/** Ask the vision model about a viewport screenshot and add its finding to the transcript. A failed or slow check is skipped. */
const checkScreenshot = async (vision: ModelAdapter) => {
  // No current page means nothing to show; page() would open one, which a check must not do.
  if (options.browser.currentUrl === undefined) return
  const expiry = new AbortController()
  const timer = setTimeout(() => expiry.abort(new Error(`Screenshot check took longer than ${SCREENSHOT_CHECK_TIMEOUT_MS}ms`)), SCREENSHOT_CHECK_TIMEOUT_MS)
  const checkSignal = AbortSignal.any([signal, expiry.signal])
  let requestedAt: number | undefined
  try {
    const page = await options.browser.page()
    // Playwright's own timeout ends a slow screenshot by itself; only the run's cancellation closes the browser, as for tools.
    const jpeg = await interruptible(() => page.screenshot({ type: "jpeg", scale: "css", timeout: SCREENSHOT_CHECK_TIMEOUT_MS }), signal, pending => options.browser.cancelPending(pending))
    requestedAt = performance.now()
    const response = await interruptible(() => vision.complete(screenshotRequest(jpeg, checkSignal)), checkSignal)
    visionCallUsage.push(response.usage)
    emit({ type: "model", role: "vision", step, text: response.text, toolCalls: response.toolCalls, model: response.model, durationMs: Math.round(performance.now() - requestedAt), usage: response.usage })
    const note = screenshotNote(response.text)
    if (note) entries.push({ role: "user", content: [{ type: "text", text: note }] })
  } catch (error) {
    // The run's own deadline or cancellation still ends the run.
    if (signal.aborted) throw error
    if (requestedAt !== undefined) emit({ type: "model", role: "vision", step, toolCalls: [], durationMs: Math.round(performance.now() - requestedAt), error: error instanceof Error ? error.message : String(error) })
  } finally {
    clearTimeout(timer)
  }
}

// In the step: decide per tool result, check once after the step's tool calls, before the fingerprint/stall checks.
let screenshotCheck = false
for (const call of response.toolCalls) {
  // ...existing body...
  if (options.visionModel && needsScreenshotCheck(tools.find((tool) => tool.name === call.name), result)) screenshotCheck = true
}
if (screenshotCheck && options.visionModel) await checkScreenshot(options.visionModel)
```

Edge case in the sketch: if the expiry fires right as a slow screenshot succeeds, `interruptible` throws before the request
is sent but `requestedAt` is already set, so an error event with ~0 ms is emitted. Harmless; set `requestedAt` inside the
`interruptible` callback if you want it exact.

### 2. cli.ts

- parseArgs: `"vision-model": { type: "string" }, "vision-model-options": { type: "string" }`.
- Resolve lazily per command so `owa mcp` without `--agent` never resolves it (mirrors how `--model` is ignored there):

```ts
const resolveVisionModel = async () => {
  const model = values["vision-model"] ?? process.env.OWA_VISION_MODEL
  if (!model) return undefined   // OWA_VISION_MODEL="" also means off
  const options = values["vision-model-options"] ?? process.env.OWA_VISION_MODEL_OPTIONS
  return resolveModel({ model, extraBody: parseModelOptions(options, "--vision-model-options / OWA_VISION_MODEL_OPTIONS") })
}
// mcp: const agentVisionModel = values.agent ? await resolveVisionModel() : undefined  → createMcpServer({ ..., agentVisionModel })
// run: const visionModel = await resolveVisionModel()                                  → runAgent({ ..., visionModel })
```

- Deliberately not passed to the vision config: `--api`, `--base-url`, `OWA_PROVIDER`, `OWA_BASE_URL`, `OWA_API_KEY`. They
  configure the main model; reusing `OWA_API_KEY` could send a private gateway key to another provider. The vision model
  therefore takes a provider shorthand (`gemini:…`, `openai:…`, `openrouter:…`, `anthropic:…`, `ollama:…`) with that
  provider's key variable, or a bare name, which means OpenAI. Known wart: `resolveModel`'s missing-key error says
  "set GEMINI_API_KEY or OWA_API_KEY", and the second half does not apply to the vision model. Left as is.
- HELP: add both flags with their env names (Model section or a new short section). Expect textual conflicts with
  #163/#164/#166 here; they are trivial.
- Optional, one line in `logEvent`, useful during live runs and shown in the bench runner's stderr.log:
  `if (event.type === "model" && event.role === "vision") log(`  · screenshot check ${event.error ? `failed: ${oneLine(event.error)}` : oneLine(event.text ?? "")}`)`
  Without it a misconfigured vision model (for example a wrong model name returning HTTP 404) is visible only in the trace.

### 3. mcp.ts

`McpServerOptions.agentVisionModel?: ModelAdapter` (naming follows `agentModel` / `agentMaxSteps` / `agentTimeoutMs`), passed
as `visionModel` to `runAgent` in `callBrowserTask`. `tools/list` is unchanged. `structuredContent` spreads the result, so it
gains `visionUsage` automatically. The text summary (`tokens: X in / Y out`) stays agent-only.

### 4. resolve.ts

Add an optional label so errors name the right flag (backward compatible; PR #170 calls `parseModelOptions(json)`):
`parseModelOptions(value, source = "--model-options / OWA_MODEL_OPTIONS")`, use `${source} must be a JSON object`, and pass
`source` into `validateModelOptions(value, source = …)`. Other role PRs may add the same parameter under another name; merge
them into one.

### 5. Tests (planned for `src/screenshot-check.test.ts`)

- Unit, `needsScreenshotCheck` (use `TOOLS` from tools.ts for real `readOnly` flags): interception error → true; other errors
  (`ref e9 is not on the page…`, plain timeout) → false; action with 4-line tree → true, 5 lines → false; empty tree → true;
  `browser_snapshot` (read-only) with a tiny tree → false; unavailable marker → false; unknown tool → false.
- Unit, `screenshotNote`: each overlay value; fenced JSON and JSON inside prose; all-negative → undefined; blocked+loading →
  blocked clause only; overlay+loading → both clauses joined by `; `; invalid (unknown overlay such as `"constructor"` or
  `"newsletter"`, `"false"` strings, missing fields, non-JSON, undefined) → undefined.
- Agent loop, no browser: subclass `BrowserSession`, override `get currentUrl()` to return a URL and `page()` to return
  `{ screenshot: async () => Buffer.from("jpeg") }` (count calls). Fake tools (`readOnly` false and true) return canned
  results such as interception error / 5-line tree / 2-line tree / non-interception error. `scriptedModel` for the agent and
  the vision model. Assert: vision called only after the triggering steps; at most once per step; the note is the last
  message of the next agent request (a `user` message); the vision request has `tools: []`, the system prompt and an
  `image/jpeg` part; `visionUsage` sums only vision calls and `usage` only agent calls; trace events carry `role: "vision"`.
  Run the same script without `visionModel`: no screenshot, no extra requests, no `visionUsage` key, no `role` on events.
  Note that a vision adapter that throws is swallowed by design, so assert `vision.requests.length` explicitly; the scripted
  model's "no reply for call N" error would otherwise go unnoticed.
- Failures ignored: vision throws (HTTP 503), replies with prose or invalid JSON, replies all-negative, hangs (5 s wait, the
  timeout is a constant). Run continues; no note; failed requests produce a `model` event with `error` and no usage.
- Run cancellation and deadline during a check: hung vision adapter, short `timeoutMs` (stopReason `timeout`) or an aborted
  controller (`cancelled`); `durationMs` well under 5 s, so the check does not swallow the run's own abort.
- Real browser, macOS-safe: wrap the real `browser_click` tool so `page.setDefaultTimeout(1_000)` applies only during the
  click and is restored to 10 000 afterwards; loads and snapshots keep the default. Sequence: navigate `/` (expected ≥5
  lines, no check), navigate `/pricing` (2 lines, check), navigate `/toggles-no-eval` (no check), click "Gift wrap" (its
  center is covered by `<label for="insurance">`, so the click is intercepted, see label-covered.test.ts; check), then the
  final answer. Assert two vision requests whose image data is a JPEG (base64 starts with `/9j/`), and the note in the
  request after the click. This also proves the screenshot works on a page that replaces `window.eval`. The line counts of
  `/` and `/pricing` are expectations from reading `src/testing/fixture.ts`; verify them. `/overlay` is only 1 line (a bare
  button), so navigating to it already triggers the nearly-empty check.
- CLI wiring: the vision model cannot be pointed at a local server (no `--base-url` for it; `ollama:` is fixed to
  `localhost:11434`). Plan: call `main([...])` in-process with `globalThis.fetch` patched and restored in `finally`: route
  `http://localhost:11434/v1/chat/completions` to vision replies and the main model's `--base-url` to agent replies; use
  `--headless`, `--vision-model ollama:owa-vision-test --vision-model-options '{"temperature":0}'`; let the agent navigate to
  fixture `/pricing` (triggers), then answer; assert the vision body has `temperature: 0` and an `image_url` JPEG data URL, and
  the agent's second body contains the note. Also assert `--vision-model-options '[]'` rejects with the vision label before
  any browser starts; give the main model a resolvable config (for example `--model local --api openai --base-url
  http://127.0.0.1:1`) so the main model's error does not fire first, and resolve the vision model before launching anything.
- MCP: `createMcpServer` with a stub session, fake tools, a scripted `agentModel` and `agentVisionModel`: `browser_task`
  uses the vision model (note reaches the agent, `structuredContent.visionUsage` present); `tools/list` names are identical
  with and without the vision model.

### 6. Docs

- README: a short "Screenshot check (optional)" subsection under Models. It covers: off by default and nothing changes
  without it; triggers; one JPEG viewport screenshot; the three questions; the note format; failures and the 5 s limit are
  skipped; tools unchanged so MCP clients see the same tools; options; provider shorthand only (`--api`, `--base-url` and
  `OWA_API_KEY` apply to `--model` only); `owa mcp` uses it only with `--agent`; library option `visionModel`.
- README "Usage and cost": `visionUsage` sums the vision calls the same way and is kept apart from `usage` because prices
  differ. In the trace a vision call is a `model` event with `role: "vision"`, and a failed vision request writes one with
  `error` instead of a reply. Change "A failed call writes no `model` event" to say *agent* call.
- README "Delegated task results": add `visionUsage` (with a vision model) to the listed fields.
- HELP text in cli.ts. CLAUDE.md and AGENTS.md (they mirror each other; only titles and intro lines differ): add an
  architecture row for `src/screenshot-check.ts`. Leave docs/TODO.md and docs/positioning.md alone; the reviewer updates them
  after the A/B (#160's completion criteria).

## Design decisions and why

- **Separate module `src/screenshot-check.ts`.** #163 and #164 edit agent.ts heavily, so keeping the prompt, trigger and
  parser out of it shrinks conflicts. The name avoids "vision" because #166 adds a `vision` capability (grounding) and might
  create a vision-named file. The flag, option, result field and trace role still say "vision" per the shared shape.
- **Triggers.** (a) Any action tool error containing `intercepts pointer events`, which also covers hover and scroll-with-ref,
  and matches the bench runner's `click_intercepted` class. (b) A non-error, non-read-only result whose tree has fewer than 5
  non-blank lines (the threshold #157 used to count early snapshots). Read-only tools (`browser_snapshot`,
  `browser_get_text`, `browser_tabs`, `browser_screenshot`) never trigger, so re-observing an empty page does not repeat
  checks. No dedupe across steps: rare enough, and re-checking a still-empty page is informative (loading versus not).
- **One check per step, after all of its tool calls.** The screenshot then shows the state the next request reasons about,
  and a user message may only follow the step's tool messages. In the OpenAI format tool messages must directly follow the
  assistant message; images from tool results are flushed as a user message first, which is fine. The Anthropic adapter merges
  consecutive user-side content into one turn, with the note after the `tool_result` blocks, which is valid. The check runs
  before the stall and failure checks, so a stopping run's best-effort request also sees the note.
- **First page of a new host: not implemented (the spec says optional).** Rough volume from the issues' numbers: about 27
  interceptions and 12–18 nearly empty action snapshots per 100 tasks, against about 1,398 model calls, so the two triggers
  fire on about 3% of steps. A first-page trigger would add about 2–4 checks per run and dominate cost and latency. It overlaps
  the nearly-empty trigger for block pages, and Booking's sign-in popup appears after load, so a first-page check would miss
  it. It might help Amtrak, whose cookie banner was in the snapshot but ignored. Open question for the A/B.
- **Verdict schema and note.** An enum for overlay plus two booleans, as the spec asks (three questions). The note is built
  only from fixed phrases because it enters the transcript as a *user* message: free text from a vision model reading a web
  page would be a prompt-injection path with user authority. `blocked` is exclusive: a Cloudflare "Just a moment…" page also
  shows a spinner, and "still loading" would invite waiting on a block page, against SYSTEM_PROMPT's rule to leave blocked
  sites. An all-negative verdict adds no note: fixture `/overlay`'s interceptor is a transparent full-page div, invisible in a
  screenshot, and "nothing covers the page" would mislead. A `Map`, not an object, so `"constructor"` and other prototype keys
  cannot match.
- **Request.** Neutral: the vision model is not told why the check runs, which would bias it toward "overlay". A short text
  part goes with the image in case a provider rejects image-only user content. JPEG (Playwright default quality 80) for a
  smaller upload; `scale: "css"` so a hi-DPI or `--cdp`-attached browser does not double the pixel count; viewport only.
- **Time budget: 5 s for screenshot plus request.** From the #160/#165 probes: `gemini-3.1-flash-lite` 1.5–1.9 s,
  `gpt-6-luna` 2.4–3.4 s, `gemma-4-26b` 3.3–4.5 s (borderline), `qwen3.7-flash` over 8 s without an answer (excluded by
  design). The screenshot uses Playwright's own `timeout`, so a vision timeout never closes the browser; only the run's abort
  does, through `interruptible` with `cancelPending`, exactly as for tool calls. The request runs under
  `AbortSignal.any([run signal, expiry])` inside `interruptible`, which also covers adapters that ignore abort. An
  `AbortController` plus `setTimeout`/`clearTimeout` gives a clear error message and no lingering timer. The budget is not
  configurable, to add no API surface; see open questions. On macOS the screenshot of an already-rendered page is fast; the
  2 s first-render stall happens at load, before the snapshot.
- **`page.screenshot` is safe on pages that replace `window.eval`.** Read in node_modules/playwright-core/lib/coreBundle.js
  around line 20,900: `_preparePageForScreenshot`, the `document.fonts.ready` wait and `_restorePageAfterScreenshot` all run
  in the `"utility"` world.
- **Usage reporting.** A separate `visionUsage`, present only when `visionModel` is set and zero when no check ran, which also
  tells the A/B that the arm was configured. `usage` keeps its meaning (agent calls only), so nothing changes without a vision
  model, and docs/evaluation.md says to "keep the per-model counts separate because prices differ".
- **Trace.** `type: "model"` with `role: "vision"`, so existing consumers count it. PR #170's bench runner counts `model`
  events for `modelCalls` / `modelMs` / `servedBy`, so the vision model shows up by name. A failed vision *request* emits an
  event with `error` and no usage. This deliberately departs from "a failed call writes no model event": a failed agent call
  ends the run and surfaces in `result.error`, while a failed vision call would otherwise be invisible. A screenshot that
  fails before any request emits nothing.
- **No SYSTEM_PROMPT change.** That would change runs without a vision model. The `Screenshot check:` prefix explains itself.

## Known test state and environment

- Baseline before any change, on `135950e` (identical to main), full `bun run test` in the cloud container: **196 pass,
  4 fail**, 200 tests in 26 files, 158 s. All four failures were in `src/label-covered.test.ts`, which shares one
  module-level `BrowserSession`:
  1. "still fails with the interception when an unrelated overlay covers the checkbox": hit the 30 s test timeout;
  2. "… when another checkbox's label covers the checkbox": failed after 10 s with
     `TypeError: undefined is not an object (evaluating 'snapshot.split')` at `refFor`
     (label-covered.test.ts:91). The `beforeEach` navigation returned no snapshot, so this cascades from (1);
  3. "… when a link inside its label covers the checkbox": failed after 10 s, the same cascade;
  4. "(unnamed)": a `beforeEach` / `afterEach` hook timed out after 30 s.
  Not root-caused and not rerun. The code is unchanged from main, so treat it as the container's known intermittent browser
  timeouts (the task said they happen even on main). Rerun once before blaming a change; compare with main if needed.
- Chromium: the SessionStart hook's download of Chromium 1228 (Playwright 1.61) fails here. `cdn.playwright.dev` is not
  allowed by the network policy, see CLAUDE.md. Tests ran on the preinstalled `/opt/pw-browsers/chromium-1194`
  (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`) through `withExecutableFallback` in browser.ts. A local run uses the real
  revision.
- `bun run typecheck` passed on the baseline. Not run since `src/screenshot-check.ts` was added.
- The local `main` branch in the cloud clone was stale; compare against `origin/main`.

## Measurements and evidence used (from the issues; nothing new was measured live)

- #154: 27 click interceptions in 17 of 100 runs, 19 caused by modals, overlays or cookie banners; 15 of those 19 had no
  dialog in the previous snapshot; each interception waits out the 10 s action timeout (about 4.5 min in total).
- #157: non-error action results with a tree under 5 lines: 18 (r2) and 12 (r3) per 100 tasks.
- #160: 1,398 model calls per 100 tasks, median 1.9 s per call; calling vision every step would nearly double step time.
- Vision probe (#165): `gemini-3.1-flash-lite` 4/4 correct, 1.5–1.9 s, about $0.0003 per image; `gemini-2.5-flash-lite`
  4/4; `gpt-6-luna` 4/4, 2.4–3.4 s; `gemma-4-26b` 3/4, about $0.00003 per image; `qwen3.7-flash` no answer within 8 s.
- Reviewer's A/B after #154/#157 merge (#162 runner): `Booking--2`, `Coursera--17`, `Apple--32`, `om2w-323bd85e3559`
  (Amtrak) × 2; metrics: wasted actions after an interception, steps, time, cost; drop the feature if it does not help.

## Related branches and PRs at hand-off

- `feat/163-escalate-stalled-runs`, `feat/164-judge-succeeded-answers`, `feat/166-grounded-coordinate-click` and
  `fix/157-settle-before-snapshot` had no commits beyond main. Check again before finishing and merge whatever has landed in
  main. Expect small textual conflicts in cli.ts (HELP, parseArgs, resolution), the agent.ts types and `finish()`, mcp.ts
  options and possibly `parseModelOptions`.
- #154 (fresh snapshot on interception errors) and #157 (settling): the trigger keys on the error text and on the final
  snapshot, so it works whether or not they land. After #154 the agent sees both the overlay in the fresh snapshot and the
  note.
- PR #170 (`test/162-bench-runner`, open) `src/testing/bench.ts`: per-run usage is `result.usage` (falling back to summing
  trace `model` events), so vision cost is not in its totals unless it also reads `visionUsage`. Mention this in the PR.
  `--vision-model` is not one of its `RUNNER_FLAGS`, and it strips `OWA_*` env vars except `OWA_API_KEY`, so arms must pass
  `flags: ["--vision-model", "gemini:gemini-3.1-flash-lite"]`.

## Open questions

1. Add the first-page-of-a-new-host trigger, or leave it to an A/B? Currently left out.
2. Keep the 5 s budget fixed, or add a library option such as `visionTimeoutMs` for slow local vision models?
3. Should notes stay purely factual (current plan, as in the issue's example), or add a nudge such as "close it before
   clicking behind it"? The TODO notes that models seldom close overlays even when the error names them. That is a prompt
   change to A/B separately.
4. Keep the `error` trace events for failed vision requests (a departure from the rule for agent calls), and add the
   one-line stderr log?
5. Show vision tokens in the CLI's final stderr line or in the MCP `browser_task` text? Currently planned: no; they are in
   `--json` / `structuredContent` and the trace.
6. `visionUsage` is present (with zeros) whenever a vision model is configured, even with no checks. Confirm that is wanted.
