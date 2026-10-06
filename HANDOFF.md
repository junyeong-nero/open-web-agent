# Hand-off: issue #166, an opt-in coordinate click backed by a grounding model

Delete this file before the PR is merged.

- Branch: `feat/166-grounded-coordinate-click`. It was created from main at `135950e`.
- Work so far: commit `9773a31` ("[feat] wip: hand off unfinished work for #166"), which changes only `src/tools.ts` and `src/agent.ts`.
- State: the core of the tool layer and the agent loop is written. It has **not been typechecked or tested** since the edits; see "Known test failures" below. The MCP server, the CLI, the fixture, the tests and the docs are still to do.
- Main: when work resumed, `git fetch origin && git merge origin/main` was a no-op, because `origin/main` was still `135950e` (`git ls-remote` agreed). Check again before opening the PR.

## 1. The task, as the user gave it

Read the issue first: `gh api repos/junyeong-nero/open-web-agent/issues/166 --jq .body` (`gh issue view` uses GraphQL, which was blocked in the cloud session). The umbrella issue is #160. The issue body is in Korean and is the spec, including its checklist "개선 및 완료 기준":

- [ ] Two tools behind a new capability (for example `vision`), off by default and exposed the same way to MCP and the agent:
  - a coordinate click (for example `browser_click_at {x, y}`);
  - a tool that finds coordinates from a description (for example `browser_locate {description}`), where a grounding model returns coordinates from a screenshot.
- [ ] The grounding model is set with `--grounding-model <provider:model>`. Handle the coordinate systems (a 1280×800 viewport, the screenshot size) and the output formats that differ between models.
- [ ] After a click, return a fresh snapshot like other actions (follow #157's settle wait).
- [ ] A fixture test: a fake grounding result clicks a canvas button, and the page state changes.
- [ ] `bun run typecheck` and `bun run test` pass.
- [ ] The reviewer A/Bs live (#162). This is not ours to meet: `Google Flights--4/6/8/9`, `Booking--1/2` and Chase (`om2w-9ed3827266b3`) × 2 runs, with and without the capability, comparing success, steps and cost.
- [ ] Decide in `docs/positioning.md` whether to keep a vision capability.
- [ ] First check whether keyboard-settable widgets such as sliders can be handled without a model (for example focus, then Home or arrow keys), and write the result in the PR. See section 6.

Constraints from the user's task:

- **Scope.** Implement only #166. Other sessions are implementing these in parallel, so keep the diff minimal and local, and don't refactor unrelated code:
  - #163: escalate a stalled run to a stronger model (`--escalate-model`, stall paths in `src/agent.ts`)
  - #164: judge a succeeded answer (`--judge-model`, the final-answer path in `src/agent.ts`)
  - #165: a screenshot page-state check (`--vision-model`, a note added in the agent loop)
  - #166: this issue
- **Shared configuration shape**, so the parallel PRs merge cleanly:
  - Flag `--<role>-model <provider:model>` and optional `--<role>-model-options <json>`.
  - Environment variables `OWA_<ROLE>_MODEL` and `OWA_<ROLE>_MODEL_OPTIONS`.
  - Resolve with the existing `resolveModel` / `parseModelOptions` in `src/model/resolve.ts`, so every provider shorthand works. Add only your own role's flags.
  - The agent option is `<role>Model?: ModelAdapter` in `AgentOptions`. Unset means no change: no extra requests and no behavior change.
  - Record each secondary call in the trace like other model calls. Reuse `Usage` and `sumUsage` (#161), and document how the secondary model's usage is reported.
- **Positioning** (`docs/positioning.md`, #160 "원칙"): secondary models are opt-in and provider-neutral, and are called from the agent loop, not inside tools. #160 makes #166 the one exception that adds tools, behind an opt-in capability. See decision D4.
- **Grounding-model access from the tool layer**: pass it in the narrowest way, as a session or tool option set by the CLI, not a global.
- **Tests must also pass on the reviewer's macOS machine:**
  - There a new Chromium renderer can stall about 2 s on its first text render. Never apply a short `actionTimeoutMs` to page loads or snapshots; shorten it only around the action under test.
  - Avoid platform-specific keys (use `ControlOrMeta`).
  - Stubbed locators must implement `count()`.
  - Some sites override `window.eval`, which breaks Playwright's page-world `evaluate` (fixture `/toggles-no-eval`). Don't add page-world `evaluate` to paths that run on every action.
  - Use scripted or fake model adapters only (`src/testing/scripted-model.ts`). Never call real model APIs, and never run live evaluations or real-site runs.
- **Verification:**
  - Run `bun run typecheck` and every test file you added or touched, then `bun run test` once. Browser tests in the cloud container are known to time out intermittently, sometimes even on main.
  - If anything fails, rerun the failing files. If they still fail, run the same files on main in a separate checkout (`git worktree add /tmp/main origin/main`), and report the counts honestly.
- **Finish:**
  - The final commit's first line must be `[feat] add an opt-in coordinate click backed by a grounding model`. WIP commits are fine, because the PR is squash-merged.
  - Push only to `feat/166-grounded-coordinate-click`. Do not create other branches.
  - Open a PR from this branch into main with the same title. **Do not merge.**
  - The PR body has:
    - `Closes #166.`
    - a short description of the change and the design choices
    - a Validation list with the exact commands and pass/fail counts, including the main comparison if anything failed
    - any acceptance criteria not met, and why (the reviewer's live checks are not ours)
    - the slider note (section 6)
    - an "Implemented by …" attribution line. The original task named the cloud session; use whatever wording the user gives the finishing agent.
  - CLAUDE.md conventions apply: `[type] lowercase imperative` titles, `bun` only, and typecheck plus tests after changes.

## 2. Environment notes (cloud session)

- Chromium download fails: the SessionStart hook's `playwright install` gets `Download failure` from `cdn.playwright.dev`. Tests still run, because `BrowserSession` falls back to the cached `/opt/pw-browsers/chromium-1194` (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`). A local machine with Playwright's own Chromium is unaffected.
- Baseline before any change, on `135950e`:
  - `bun run typecheck`: clean.
  - `bun test --timeout 30000 src/tools.test.ts`: 10 pass, 0 fail, 73 `expect()` calls, 10.55 s.
- Bun 1.3.14, Node 22.22.0, Playwright 1.61.0.

## 3. What is done (commit `9773a31`)

### `src/tools.ts`

- **`Capability = "core" | "unsafe" | "vision"`.**
- **`ToolContext`**: `{ groundingModel?: ModelAdapter; groundingScale?: number; signal?: AbortSignal }`. It is what a tool call may use besides the browser, and the front door (the agent or the MCP server) sets it.
  - `BrowserTool.run(session, args, context)` and the `tool()` helper take it as a third argument. Existing tools ignore it.
  - `callTool(tools, session, name, args, context = {})` has a new optional fifth parameter. Existing callers are unchanged.
- **`ToolResult.modelCall?: ModelCall`**, with `ModelCall = { role: "grounding"; text?; model?; durationMs; usage?: Usage }`: a model request the tool made, which the agent records like its own model calls.
- **`groundingPrompt(size, scale?)`** (private) builds the system prompt. It asks for only `{"x": <x>, "y": <y>}`, in pixels of the W×H screenshot from its top-left corner, or on a 0–n scale when `groundingScale` is set, and says to reply "not found" if the element is absent. The prompt states whichever convention is configured.
- **`groundingPoint(reply, size, scale?)`** (exported) reads the point a reply names, in whole screenshot pixels, or returns `undefined`.
  - It tries these in order:
    1. `x` and `y` keys anywhere: JSON `{"x": 300, "y": 240}`, `x=300`, or `x="61.5"`.
    2. The first group of 2 or 4 numbers inside `(…)`, `[…]` or a tag (`>…<`), separated by commas or spaces. This covers UI-TARS `click(start_box='(300,240)')`, `<|box_start|>(300,240)<|box_end|>`, `<point>300 240</point>`, Qwen `{"point_2d": [x, y]}` and `{"bbox_2d": [x1, y1, x2, y2]}`. Four numbers are a box, and its center is taken.
    3. A bare `x, y`.
  - Fractions: when every value is ≤ 1 and at least one is non-integer, the values are fractions of the screenshot size.
  - Scale: with `scale` set, the values run 0–n on both axes. Otherwise they are pixels.
  - Bounds: points outside `[0, width] × [0, height]` give `undefined`. An edge point such as 1000 on a 0–1000 scale is clamped to the last pixel.
- **`browser_click_at {x, y, element?}`** (capability `vision`):
  - `x` and `y` are `z.number().min(0)`, in CSS pixels from the viewport's top-left corner.
  - It refuses points outside `page.viewportSize()`, when that is known, with an error result that clicks nothing, because `mouse.click` there silently reaches nothing.
  - Otherwise it runs `act(session, "Clicked <element >at x=…, y=…", page => page.mouse.click(x, y))`, so the result carries a fresh snapshot and #157's settle wait will apply automatically once #157 changes `act()`.
- **`browser_locate {description}`** (capability `vision`, `readOnly: true`):
  1. Without a grounding model in the context it returns an error result. This is normally unreachable, because `usableTools` hides the tool.
  2. It takes `page.screenshot({ type: "png", scale: "css" })` and reads the size from the PNG header (`readUInt32BE(16)` and `(20)`).
  3. It calls `groundingModel.complete({ system: groundingPrompt(...), messages: [user: [image part, text "Element: <description>"]], tools: [], signal })`.
  4. It builds a `modelCall` from the response (`text`, `model`, `durationMs`, `usage`).
  5. If `groundingPoint` reads nothing, it returns `isError` with the reply quoted (at most 200 characters), a hint to describe the element differently or scroll, **and** the `modelCall`, so usage is not lost.
  6. On success it returns the text `Located <description> at x=…, y=…. Pass these to browser_click_at.`, the `modelCall`, and `structuredContent: { x, y, model, durationMs, usage }` for MCP clients.
- **`usableTools(tools, { groundingModel })`** (exported) returns `tools`, minus `browser_locate` when there is no grounding model.
- The two tools are appended at the end of `TOOLS`, to keep the diff local.

### `src/agent.ts`

- **`AgentOptions.groundingModel?: ModelAdapter`** and **`groundingScale?: number`**.
- `runAgent` builds `const context: ToolContext = { groundingModel, groundingScale, signal }`, where `signal` is the run's combined deadline and cancel signal. Then `const tools = usableTools(options.tools ?? selectTools(), context)`. The same filtered list feeds both `specs` and `callTool`.
- `callTool(..., context)` inside the existing `interruptible(...)`.
- After each tool call, if `result.modelCall` is set:
  - its usage is pushed to `groundingCalls`;
  - the agent emits `{ type: "model", step, toolCalls: [], ...modelCall }`, a `model` event with `role: "grounding"`, before that call's `tool` event.
- `AgentEvent`'s `model` variant has a new optional `role?: "grounding"`, with a one-line doc comment above the union.
- **`AgentResult.groundingUsage?`** is `sumUsage(groundingCalls)`. `finish` sets it on a separate line, and only when at least one grounding call was made. `usage` still sums only the agent model's calls; the existing `usage` comment line was deliberately left untouched to avoid merge conflicts.
- No prompt changes.

## 4. Design decisions, and why

**D1. `vision` capability, off by default.**
- The issue and CLAUDE.md say risky or extra tools go behind a capability, and playwright-mcp also puts vision tools behind `--caps vision`.
- `--caps vision` adds `browser_click_at` always, and `browser_locate` only when a grounding model is configured.
- This keeps a useful case: an MCP client that does its own grounding (Claude Code, say) can use `browser_screenshot` plus `browser_click_at` without owa running any model. A vision-capable agent model can do the same.

**D2. `browser_locate` is hidden, not failing, when there is no grounding model.**
- A listed tool that always errors wastes agent steps and MCP client context.
- This mirrors the existing rule that `browser_task` exists only when an agent model is configured.

**D3. A call-time `ToolContext`, not a session option or a closure from `selectTools`.**
- The abort signal is per call anyway: without it, `cancelPending` would wait for an in-flight grounding HTTP request to finish.
- The shared shape puts `groundingModel` on `AgentOptions`, so a library caller writes it once: `runAgent({ tools: selectTools(["core", "vision"]), groundingModel })`. Filtering happens in the front doors (`usableTools`) for the same reason.
- A `BrowserSession` option would have mixed a model into the Playwright lifecycle class.

**D4. The one model call inside a tool.**
- `docs/positioning.md` and #160 avoid "LLM inside a tool", but #160 names #166 as the only issue that adds tools.
- MCP parity forces the call into the tool layer: an external MCP client has no agent loop of ours to hook.
- The grounding model only perceives. It maps a description to pixels; the agent still decides what to do.
- It is opt-in twice: the capability and a configured model.
- This rationale belongs in `docs/positioning.md` (still to write).

**D5. Coordinates.**
- The screenshot is taken with `scale: "css"`, so image pixels equal CSS pixels at any device scale factor. Those are what `page.mouse.click` takes.
- The size comes from the PNG header: no page-world evaluate, so it works on pages that replace `window.eval`; see the probe in section 5.
- Default convention: absolute pixels of the image the model was sent. This is what `bytedance/ui-tars-1.5-7b` did in the #160 probe: `(86,186)` inside the `/trade-in` modal's Close button.
- `groundingScale = n`: the model answers 0–n on both axes, for example 1000 for Gemini, Qwen3-VL and UI-TARS 1.0, or 100 for Molmo-style percentages.
- Fractions in 0–1 are auto-detected.
- The convention cannot be inferred from the values, since (500, 300) is valid both ways, and the codebase refuses to infer settings from model names ("No reasoning defaults are inferred from the model name"). Hence an explicit setting.
- Pairs are read as (x, y). Gemini's native `[y, x]` order is not supported unless the model follows the JSON prompt, which names x and y explicitly.
- Known small error, not compensated because it is model-specific: UI-TARS-1.5 and Qwen2.5-VL answer in their internally resized image (each side rounded to a multiple of 28; 1280×800 becomes 1288×812). That is at most about 8 px in x and 12 px in y at the far edges.
- Background from memory, not verified in this session: UI-TARS 1.0 and OS-Atlas use 0–1000; UI-TARS-1.5 and Qwen2.5-VL use absolute resized pixels; Qwen3-VL uses 0–1000; Gemini uses 0–1000 in `[y, x]` order; Molmo uses `<point x="61.5" y="40.6">` percentages.
- A hypothesis for the reviewer: `gemini-3.1-flash-lite` "missed by 40px" in the #160 probe. If it answered 0–1000 and the probe read that as pixels, (86, 186) px would have come back as about (67, 232), roughly 50 px off. Worth one A/B with `--grounding-scale 1000`.

**D6. Usage reporting.**
- The trace gets a `model` event per grounding call, with `role: "grounding"`, `text` (the raw reply, useful for debugging the parser), `model`, `durationMs` and `usage`.
- `groundingUsage` is separate from `usage`, because the two models are priced differently. `docs/evaluation.md` already says "Keep the per-model counts separate because prices differ."
- `groundingUsage` is present only when the run made at least one grounding call, and absent when no grounding model is set, so "unset changes nothing" holds.
- A grounding request that fails (HTTP error) writes no `model` event, matching the existing rule "A failed call writes no `model` event". The tool then fails through `callTool`'s catch as `browser_locate failed: …`.
- An unparseable reply still carries `modelCall`, so its usage is kept.
- Direct MCP calls have no trace, so `browser_locate`'s `structuredContent` carries `x`, `y`, `model`, `durationMs` and `usage`.

**D7. Repeat and stall detection are unchanged.**
- A step that includes `browser_locate`, which returns no snapshot, is excluded from the identical-step fingerprint, as `browser_tabs` is today. The step limit still bounds it.
- No agent.ts special-casing, which avoids conflicts with #163.

**D8. No system-prompt change.**
- Guidance lives in the tool descriptions (when to use them, how to describe an element, viewport only).
- Prompt changes need a live A/B, and the parallel PRs edit `src/agent.ts`.

## 5. Measurements: the probe (cloud, Playwright 1.61, cached Chromium 1194)

The script was in the session scratchpad, not the repo, so here it is in full. Run it from the repo root with `bun <file>`:

```ts
import { BrowserSession } from "/home/user/open-web-agent/src/browser.ts"

const PAGE = `<!doctype html><title>Probe</title>
<script>window.eval = () => { throw new Error("eval is disabled") }</script>
<h1>Probe</h1>
<canvas id="map" width="400" height="200" style="position: absolute; left: 100px; top: 150px"></canvas>
<p id="status" style="position: absolute; top: 400px">Idle</p>
<label style="position: absolute; top: 450px">Volume <input id="range" type="range" min="0" max="100" value="10" style="width: 300px"></label>
<div style="position: absolute; top: 500px; left: 20px; width: 300px; height: 20px; background: #ddd">
  <div id="thumb" role="slider" tabindex="0" aria-label="Retirement age" aria-valuemin="50" aria-valuemax="80" aria-valuenow="65"
    style="position: absolute; left: 150px; width: 20px; height: 20px; background: blue"></div>
  <div style="position: absolute; inset: 0"></div>
</div>
<script>
  const canvas = document.querySelector("#map")
  const context = canvas.getContext("2d")
  context.fillStyle = "#1a73e8"; context.fillRect(150, 70, 100, 40)
  context.fillStyle = "white"; context.font = "16px sans-serif"; context.fillText("Book", 180, 95)
  canvas.addEventListener("click", (event) => {
    const box = canvas.getBoundingClientRect()
    const x = event.clientX - box.left, y = event.clientY - box.top
    if (x >= 150 && x <= 250 && y >= 70 && y <= 110) document.querySelector("#status").textContent = "Seat booked"
  })
  const thumb = document.querySelector("#thumb")
  thumb.addEventListener("keydown", (event) => {
    const now = Number(thumb.getAttribute("aria-valuenow"))
    const next = { ArrowRight: now + 1, ArrowUp: now + 1, ArrowLeft: now - 1, ArrowDown: now - 1, Home: 50, End: 80 }[event.key]
    if (next !== undefined) thumb.setAttribute("aria-valuenow", String(Math.min(80, Math.max(50, next))))
  })
</script>`

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(PAGE, { headers: { "content-type": "text/html" } }) })
const session = new BrowserSession({ headless: true })
try {
  const page = await session.page()
  await page.goto(`http://127.0.0.1:${server.port}/`)
  console.log("evaluate:", await page.evaluate(() => 1).then(String, (error) => `rejects: ${String(error).split("\n")[0]}`))
  const tree = await page.ariaSnapshot({ mode: "ai" })
  console.log("snapshot:\n" + tree)
  const png = await page.screenshot({ type: "png", scale: "css" })
  console.log("screenshot css:", png.readUInt32BE(16), png.readUInt32BE(20), png.length, "bytes")
  const device = await page.screenshot({ type: "png" })
  console.log("screenshot device:", device.readUInt32BE(16), device.readUInt32BE(20))
  console.log("viewport:", JSON.stringify(page.viewportSize()))
  await page.mouse.click(300, 240)
  console.log("status after click_at:", await page.locator("#status").innerText())
  const range = page.locator("#range")
  console.log("range fill:", await range.fill("65").then(async () => await range.inputValue(), (error) => `fails: ${String(error).split("\n")[0]}`))
  const box = (await range.boundingBox())!
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2)
  console.log("range after track click at 90%:", await range.inputValue())
  const thumb = page.locator("#thumb")
  console.log("thumb click:", await thumb.click({ timeout: 1000 }).then(() => "clicked", (error) => `fails: ${String(error).split("\n")[0]}`))
  console.log("thumb press:", await thumb.press("ArrowRight", { timeout: 1000 }).then(async () => await thumb.getAttribute("aria-valuenow"), (error) => `fails: ${String(error).split("\n")[0]}`))
  await thumb.focus()
  await page.keyboard.press("Home")
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight")
  console.log("thumb after focus + Home + 5×ArrowRight:", await thumb.getAttribute("aria-valuenow"))
} finally {
  await session.close()
  server.stop(true)
}
```

Output:

```
evaluate: rejects: Error: evaluate: Error: eval is disabled
snapshot:
- generic [active] [ref=e1]:
  - heading "Probe" [level=1] [ref=e2]
  - paragraph [ref=e4]: Idle
  - generic [ref=e5]:
    - text: Volume
    - slider "Volume" [ref=e6]: "10"
  - slider "Retirement age" [ref=e8]
screenshot css: 1280 800 9310 bytes
screenshot device: 1280 800
viewport: {"width":1280,"height":800}
status after click_at: Seat booked
range fill: 65
range after track click at 90%: 92
thumb click: fails: TimeoutError: click: Timeout 1000ms exceeded.
thumb press: 66
thumb after focus + Home + 5×ArrowRight: 55
```

What this shows:

- On a page that replaces `window.eval`, page-world evaluate fails, but `ariaSnapshot`, `screenshot({ scale: "css" })`, `viewportSize()` and `mouse.click` all work. The vision tools use only these.
- The canvas button is not in the snapshot: no "Book", no button. A mouse click at its center, (300, 240), changes the page.
- The CSS-scale screenshot is 1280×800 (device scale factor 1 in headless).
- The snapshot shows the native range input's value (`"10"`) but no value for the `role=slider` div, even though it has `aria-valuenow`.

## 6. Slider note for the PR (the issue's last checklist item)

From the probe above:

- **Native `<input type=range>`:** settable today without a model. `browser_type` uses `locator.fill`, which sets a range input's value directly (`fill("65")` gave 65). A coordinate click on the track also works, approximately (90% of the track gave 92).
- **Custom ARIA sliders (`role=slider`)** that implement the WAI-ARIA keyboard pattern (arrows ±1 step, PageUp/PageDown, Home/End): settable without a model, and exactly. Focus plus Home plus 5×ArrowRight gave 55, even when an overlay intercepts clicks. `locator.click` timed out there, but `locator.press("ArrowRight")` worked (65 to 66), because `press` focuses without needing to receive pointer events.
- **But today's tools cannot do it.** `browser_press_key` takes no ref and presses on whatever is focused. The only way to focus is `browser_click`, which is what timed out four times on Chase (#166's evidence).
- **Model-free follow-up**, separate from this PR: an optional `ref` on `browser_press_key` implemented with `locator.press`.
- **Limits:**
  - Wide ranges (for example a balance from 0 to 1,000,000) can need many presses for an exact value.
  - The snapshot does not show a custom slider's current value, so the agent cannot check it.
  - Widgets that don't implement the keyboard pattern still need the coordinate click.
  - Date pickers are grids of buttons, which usually are in the snapshot. When they are canvas or unlabeled, `browser_locate` plus `browser_click_at` applies.

## 7. What is left, with sketches

### 7.1 `src/mcp.ts`

```ts
import { type BrowserTool, callTool, type ToolResult, toolSpec, usableTools } from "./tools"

export interface McpServerOptions {
  // …existing fields…
  /** Answers browser_locate (the vision capability), which is not offered without it. */
  groundingModel?: ModelAdapter
  /** See `ToolContext.groundingScale`. */
  groundingScale?: number
}

export function createMcpServer(options: McpServerOptions) {
  const offered = usableTools(options.tools, options)
  // listTools: options.tools.map(...) → offered.map(...)
  // callBrowserTask: runAgent({ …, tools: offered, groundingModel: options.groundingModel, groundingScale: options.groundingScale })
  //   and in its text, after "tokens: X in / Y out", when result.groundingUsage is set:
  //   `, grounding tokens: ${g.inputTokens} in / ${g.outputTokens} out`
  // callToolRequest: const context = { groundingModel: options.groundingModel, groundingScale: options.groundingScale, signal }
  //   use callTool(offered, options.session, name, args, context) in both the signal and the no-signal branches
}
```

`structuredContent` already passes through `callToolRequest`, so `browser_locate`'s point and usage reach MCP clients.

### 7.2 `src/cli.ts`

- Add these `parseArgs` options: `"grounding-model"`, `"grounding-model-options"` and `"grounding-scale"`, all `{ type: "string" }`.
- `parseCaps`: accept `vision` (today it throws `Unknown capability` for anything other than core and unsafe).
- Validate the scale near the `--max-steps` validation, so it fails early:

  ```ts
  const scaleValue = values["grounding-scale"] ?? process.env.OWA_GROUNDING_SCALE
  const groundingScale = scaleValue === undefined || scaleValue === "" ? undefined : Number(scaleValue)
  if (groundingScale !== undefined && !(Number.isFinite(groundingScale) && groundingScale > 0)) throw new Error("--grounding-scale must be a positive number")
  ```

- Resolve the model after `const tools = selectTools(caps)`, and import `parseModelOptions`:

  ```ts
  // The grounding model answers only browser_locate, so it is resolved only with the vision capability. It does not
  // inherit --base-url, --api or OWA_API_KEY, which configure the agent model.
  const groundingSpec = values["grounding-model"] ?? process.env.OWA_GROUNDING_MODEL
  const groundingModel = caps.includes("vision") && groundingSpec
    ? await resolveModel({ model: groundingSpec, extraBody: parseModelOptions(values["grounding-model-options"] ?? process.env.OWA_GROUNDING_MODEL_OPTIONS) })
    : undefined
  ```

- Pass `groundingModel` and `groundingScale` to `createMcpServer({...})` and to `runAgent({...})`.
- `logEvent` "done" line: append `; grounding in X, out Y` when `event.result.groundingUsage` is set.
- `HELP`:
  - Extend the `--caps` line: `vision (adds browser_click_at, and browser_locate with --grounding-model)`.
  - Add a block. The flag names are wider than the 29-character column, so put descriptions on the next line:

    ```
    Vision (with --caps vision; flag > env):
      --grounding-model <provider:model>
                                   OWA_GROUNDING_MODEL  answers browser_locate from a screenshot,
                                   e.g. openrouter:bytedance/ui-tars-1.5-7b
      --grounding-model-options <json>
                                   OWA_GROUNDING_MODEL_OPTIONS  extra API request fields (JSON object)
      --grounding-scale <n>        OWA_GROUNDING_SCALE  the model answers on a 0–n scale (e.g. 1000)
                                   instead of in screenshot pixels
    ```

- Chosen behavior, an open question in section 9: `--grounding-model` without `--caps vision` is silently unused and not resolved, so a missing key for an unused model can't fail a run. It also keeps the reviewer's A/B simple: toggle only `--caps vision`.

### 7.3 Optional: `src/model/resolve.ts`

`parseModelOptions` hard-codes the error `--model-options / OWA_MODEL_OPTIONS must be a JSON object`, which is misleading for a bad `--grounding-model-options`. A minimal fix is an optional label parameter with the current text as its default, passed on to `validateModelOptions`:

```ts
export function parseModelOptions(value: string | undefined, source = "--model-options / OWA_MODEL_OPTIONS")
// throw new Error(`${source} must be a JSON object`) in both places
```

Then pass `"--grounding-model-options / OWA_GROUNDING_MODEL_OPTIONS"` from the CLI. The parallel PRs may make the same change, which would be a trivial conflict. Skip it if the diff must stay minimal.

### 7.4 Fixture (`src/testing/fixture.ts`, add to `PAGES`)

```ts
  // A booking button drawn on a canvas is not in the accessibility tree. Like americanexpress.com, the page also
  // replaces window.eval, so the vision tools must work without Playwright's page-world evaluate.
  "/canvas": `<!doctype html><title>Seat map</title>
    <script>window.eval = () => { throw new Error("eval is disabled") }</script>
    <h1>Seat map</h1><p id="status">No seat booked</p>
    <canvas width="400" height="200" style="position: absolute; left: 100px; top: 150px"></canvas>
    <script>
      const canvas = document.querySelector("canvas")
      const context = canvas.getContext("2d")
      context.fillStyle = "#1a73e8"; context.fillRect(150, 70, 100, 40)
      context.fillStyle = "white"; context.font = "16px sans-serif"; context.fillText("Book", 182, 95)
      // The button covers x 250–350, y 220–260 of the viewport, centered at (300, 240).
      canvas.addEventListener("click", (event) => {
        const box = canvas.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top
        if (x >= 150 && x <= 250 && y >= 70 && y <= 110) document.querySelector("#status").textContent = "Seat booked"
      })
    </script>`,
```

Absolute positioning keeps the coordinates independent of fonts and OS. Read the status with `locator("#status").innerText()`, not `evaluate`.

### 7.5 Tests (new `src/vision.test.ts`)

These are planned and none are written. The expected values below were checked by hand against the regexes, not run.

1. **`groundingPoint`**, a pure unit test with size 1280×800, no browser. Each of these gives `{ x: 300, y: 240 }`:
   - `{"x": 300, "y": 240}`
   - a fenced block ` ```json\n{"x": 300.4, "y": 239.6}\n``` ` (rounds)
   - `click(start_box='(300,240)')`
   - `<|box_start|>(300,240)<|box_end|>`
   - `Action: click(point='<point>300 240</point>')`
   - `[{"bbox_2d": [280, 220, 320, 260], "label": "Book"}]` (box center)
   - `The Book button is at 300, 240.`
   - `{"x": 0.234375, "y": 0.3}` (fractions)
   - `(234, 300)` with scale 1000 (234 × 1.28 = 299.52, which rounds to 300)
   - `{"point_2d": [234, 300]}` with scale 1000

   These give `undefined`: `not found`, the empty string, `(1500, 240)`, `(300, 900)`, `(-5, 240)`, and `(1100, 240)` with scale 1000 (1408 > 1280). Edge case: `(1000, 1000)` with scale 1000 gives `{ x: 1279, y: 799 }`.
2. **Locate, then click the canvas button**, with a shared `BrowserSession({ headless: true })` and default timeouts:
   - Navigate to `/canvas`. The snapshot contains `No seat booked` and contains neither `Book` nor `button`. `page.evaluate(() => 1)` rejects with "eval is disabled".
   - A `scriptedModel` grounding reply `{"x": 300, "y": 240}`, with `model` and `usage` (with a `cost`) set.
   - `callTool(selectTools(["core", "vision"]), session, "browser_locate", { description }, { groundingModel })` gives the exact text, `modelCall: { role: "grounding", model, usage }` and `structuredContent` with x and y.
   - Check the recorded request:
     - `tools` is `[]`;
     - `system` contains `in pixels of the 1280×800 screenshot`;
     - the first message's content is `[image png, text "Element: …"]`, and the PNG header is 1280×800.
   - `browser_click_at { x: 300, y: 240, element: "Book button" }`: the text starts with `Clicked Book button at x=300, y=240\n`, and the snapshot contains `Seat booked`.
3. **Scale and viewport bounds:** with `groundingScale: 1000` and the reply `click(start_box='(234,300)')`, the text starts with `Located Book at x=300, y=240.` and `system` contains `on a 0–1000 scale`. `browser_click_at { x: 300, y: 900 }` gives exactly `{ text: "x=300, y=900 is outside the 1280×800 viewport, so nothing was clicked. Scroll the target into view and locate it again.", isError: true }`, and the status is still `No seat booked`.
4. **Unparseable reply** (`I cannot find that element.`, with usage): `isError`, the text ends with `The reply: "I cannot find that element."`, and `modelCall.usage` is kept.
5. **Availability:**
   - `selectTools()` and `selectTools(["core", "unsafe"])` lack both vision tools; `selectTools(["core", "vision"])` has both.
   - `usableTools(vision, {})` drops only `browser_locate`; with a grounding model it keeps it.
   - `callTool(selectTools(), session, "browser_click_at", …)` gives `Unknown tool "browser_click_at"`.
6. **Agent:**
   - A scripted agent model navigates to `/canvas`, calls `browser_locate`, then `browser_click_at` with the x and y parsed from `lastToolText`, then answers with an outcome line. Each call reports usage 10/2, 20/3, 30/4 and 40/5.
   - The fake grounding model reports 1300/9 with a cost.
   - Expected: `usage` is `{ inputTokens: 100, outputTokens: 14 }` (no grounding tokens), and `groundingUsage` is `{ inputTokens: 1300, outputTokens: 9, cost }`.
   - The `model` events' roles are `[undefined, undefined, "grounding", undefined, undefined]`, and the grounding event has `step: 2`, `text`, `model`, an integer `durationMs` and `toolCalls: []`.
   - Without `groundingModel`, `model.requests[0].tools` contains `browser_click_at` but not `browser_locate`, and the result has no `groundingUsage` property.
   - Assert on `model.requests` after the run, not inside script steps: a throw inside a step becomes a `model_error`.
7. **MCP, in-process:** `createMcpServer({ session, tools: vision })` lists `browser_click_at` but not `browser_locate`. With `groundingModel` it lists both, and `tools/call browser_locate` returns `isError: false`, the text, and `structuredContent` with x, y and usage.
8. **CLI:**
   - In-process `main([...])`:
     - `["run", "--caps", "vision", "--grounding-model", "ollama:ui-tars"]` rejects with `Usage: owa run "<task>"`.
     - Adding `--grounding-model-options "{"` makes it reject with the options error (the label text if 7.3 is done).
     - `--grounding-scale 0`, `-1` or `abc` rejects with `--grounding-scale must be a positive number`.
     - `--caps visual` rejects with `Unknown capability "visual"`.
   - Always pass `--grounding-model ollama:…` explicitly: the `ollama` preset needs no key and `resolveModel` makes no network call. The reviewer's shell might set `OWA_GROUNDING_MODEL`.
   - Stdio MCP via the SDK client, as in `src/mcp.test.ts`, with `OWA_GROUNDING_*` deleted from the env copy:
     - `mcp --headless --caps vision` lists `browser_click_at`, not `browser_locate`;
     - adding `--grounding-model ollama:x` lists both;
     - `--grounding-model ollama:x` without `--caps vision` lists neither.
     - Listing tools doesn't launch the browser.
   - The `run` path: write a temp module (as in `src/model/resolve.test.ts`) whose `complete` replies with `request.tools.map(t => t.name).join(",")` plus an outcome line. Run `owa run "t" --model-module <tmp> --caps vision --grounding-model ollama:x --json` and check that the answer lists both tools. The browser never starts, because no tool is called.

### 7.6 Docs

- **README:**
  - Tools table: add `browser_click_at` and `browser_locate` (**opt-in**: `--caps vision`).
  - Options block: `--caps core,unsafe,vision`, plus the three grounding flags.
  - A short "Vision" section covering:
    - when to use it;
    - the grounding model flags and env variables, with `openrouter:bytedance/ui-tars-1.5-7b` as an example;
    - the coordinates: CSS pixels, the screenshot at CSS scale, the supported reply formats, fractions, `--grounding-scale`, (x, y) order, and the smart-resize caveat;
    - that `browser_locate` is hidden without a model;
    - that `--grounding-model` is unused without `--caps vision`.
  - "Usage and cost": grounding calls write `model` events with `role: "grounding"`, `groundingUsage` sums them under the same rules and is left out of `usage`, and MCP `browser_locate` reports usage in `structuredContent`.
  - Maybe bump "about 1.9k lines" if the count changes noticeably.
- **`docs/positioning.md`:** record the decision from D4: keep `vision` as an opt-in capability, and `browser_locate` as the only tool that calls a model, with the reasons. Optionally add a "What we borrow" row: playwright-mcp's opt-in `vision` caps.
- **`docs/TODO.md`** (optional): under "Complex widgets", note that `--caps vision` (#166) adds coordinate clicks and that the live A/B is pending.
- `CLAUDE.md` and `AGENTS.md` were intentionally left alone, to reduce conflicts.

## 8. Known test failures

- **None known, and none run.** After the edits in `9773a31`, neither `bun run typecheck` nor any test has been run.
- Until 7.1 and 7.2 land:
  - `src/mcp.ts` doesn't filter or pass a context. If a caller passes vision tools to `createMcpServer` today, `browser_locate` is listed and returns "browser_locate needs a grounding model".
  - The CLI rejects `--caps vision`.
- Things to watch when you first typecheck:
  - `groundingPoint`'s ternary over `(string | undefined)[] | string[] | undefined` followed by `.map(Number)`;
  - the spread of `modelCall` into the `model` event;
  - the third parameter on `BrowserTool.run`.

  These look fine to me, but they are unverified.
- Expect the known cloud flakiness: browser tests sometimes time out in the container, even on main. Rerun the failing files once, then compare with main in `git worktree add /tmp/main origin/main`.

## 9. Open questions

1. **Capability name.** The issue suggests `vision`, which matches playwright-mcp. But #165 adds `--vision-model` (a screenshot page check), unrelated to `--caps vision`, which uses `--grounding-model`. Keep `vision` and document that the two are unrelated, or rename it (for example `coordinates`)?
2. **`--grounding-scale` name and shape.** It takes one number for a square 0–n range. A `WxH` form would let UI-TARS-1.5's resized space (1288×812) be exact, but invites model-specific tuning.
3. **`--grounding-model` without `--caps vision`.** Silently unused (current choice: A/B-friendly, and a key in the environment never fails a run), an error, or imply vision?
4. **Changing `src/model/resolve.ts`** for the options error label (7.3): yes or no, given the parallel PRs.
5. **`browser_screenshot` stays at device scale.** On a CDP-attached HiDPI Chrome, its pixels are twice the CSS pixels, so an MCP client reading coordinates from it would click at twice the position. It was left alone as out of scope. Mention it in the docs, or switch it to `scale: "css"` in a follow-up?
6. **`browser_click_at` options.** Only `{x, y, element}`, with no double-click or button. Enough?
7. **Follow-up issue:** an optional `ref` on `browser_press_key` (section 6).
8. **Expected merge conflicts with #163, #164 and #165**, all trivial:
   - the `AgentEvent` `role` literal union;
   - added `AgentResult` usage fields;
   - the `logEvent` done line;
   - `McpServerOptions`;
   - the `parseModelOptions` label, if several PRs add one.
