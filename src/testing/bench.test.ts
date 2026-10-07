import { expect, it } from "bun:test"
import { join } from "node:path"
import { type BenchArm, compare, parseArms, parseTasks, planRuns, renderPerTask, renderSummary, type RunMeta, runRecord, type RunRecord, summarize, toolErrorClass } from "./bench"

const meta = (overrides: Partial<RunMeta> = {}): RunMeta => ({
  arm: "luna", task: "t1", run: 1, args: [], exitCode: 0, signal: null, timedOut: false, seconds: 12.3, startedAt: "2026-10-06T00:00:00.000Z", ...overrides,
})
const jsonl = (...events: object[]) => events.map((event) => JSON.stringify({ time: "2026-10-06T00:00:00.000Z", ...event })).join("\n") + "\n"
const result = (overrides: object = {}) => JSON.stringify({
  status: "completed", stopReason: "final_answer", answer: "$42 per month",
  outcome: { status: "succeeded", verification: "unverified", unfinished: [] }, observedUrls: [], durationMs: 11_000,
  steps: 2, usage: { inputTokens: 300, outputTokens: 20 }, ...overrides,
}, null, 2)
const step = (n: number) => ({ type: "step", step: n })
const model = (n: number, usage: object, served = "gpt-6-luna-2026-09-15") => ({ type: "model", step: n, toolCalls: [], model: served, durationMs: 1_500, usage })
const tool = (n: number, name: string, text: string, isError?: boolean) => ({ type: "tool", step: n, call: { id: String(n), name, arguments: {} }, result: { text, ...(isError ? { isError } : {}) } })
const intercepted = "browser_click failed: click: Timeout 1000ms exceeded.\n- waiting for locator('aria-ref=e2')\n- locator resolved to <button>Buy now</button>\n- <div id=\"overlay\"></div> intercepts pointer events\nTake a new browser_snapshot if the page may have changed."

it.each([
  ["ref e9 is not on the page, so nothing was done. Use a ref from this new snapshot.", "stale_ref"],
  ['ref e5 (button "Buy") is no longer on the page, so nothing was done. Use a ref from this new snapshot.', "stale_ref"],
  ['browser_select_tab failed: Unknown or closed tab "t9". Call browser_tabs for current tab IDs.', "stale_ref"],
  ["browser_click failed: click: Timeout 10000ms exceeded.\n- element was detached from the DOM, retrying", "stale_ref"],
  [intercepted, "click_intercepted"],
  ["browser_click failed: click: Timeout 1000ms exceeded.\n- element was detached from the DOM, retrying\n- <div></div> intercepts pointer events", "click_intercepted"],
  ["browser_click failed: click: Timeout 1000ms exceeded.\n- locator resolved to <button id=\"b\">Hide me</button>\n- element is not visible", "not_visible"],
  ["browser_click failed: click: Timeout 1000ms exceeded.\n- locator resolved to <button>Off screen</button>\n- element is outside of the viewport", "not_visible"],
  ["browser_navigate failed: goto: net::ERR_NAME_NOT_RESOLVED at http://example.invalid/\n- navigating to \"http://example.invalid/\", waiting until \"commit\"", "navigation"],
  ["browser_navigate failed: goto: Protocol error (Page.navigate): Cannot navigate to invalid URL", "navigation"],
  ["browser_go_back failed: goBack: Timeout 10000ms exceeded.", "navigation"],
  ["browser_navigate failed: The server sent a file (content-type `application/pdf`, filename `paper.pdf`) instead of a web page; the browser cannot display it.", "download"],
  ["Invalid arguments for browser_click: ✖ Invalid input: expected string, received undefined\n  → at ref", "invalid_arguments"],
  ['Unknown tool "browser_fly"', "invalid_arguments"],
  ['browser_click failed: "button" is not a snapshot ref (expected e.g. "e12"). Take a browser_snapshot and use a [ref=…] value.', "invalid_arguments"],
  ["No text at offset=999999: the text is 71 chars long.", "invalid_arguments"],
  ["browser_click failed: click: Timeout 1000ms exceeded.\n- element is not enabled", "other"],
  ["browser_wait_for failed: waitFor: Timeout 15000ms exceeded.", "other"],
  ["browser_navigate failed: browserType.launch: Executable doesn't exist at /cache/ms-playwright/chromium/chrome", "other"],
] as const)("classifies %p as %s", (text, kind) => {
  expect(toolErrorClass(text)).toBe(kind)
})

it("reads a finished run from its result and trace", () => {
  const trace = jsonl(
    step(1), model(1, { inputTokens: 100, outputTokens: 10 }), tool(1, "browser_navigate", "Navigated to https://example.com"), tool(1, "browser_click", intercepted, true),
    step(2), model(2, { inputTokens: 200, outputTokens: 10 }),
    { type: "done", result: JSON.parse(result()) },
  )
  expect(runRecord(meta(), { stdout: result(), trace, stderr: "→ [1] browser_navigate\n" })).toEqual({
    arm: "luna", task: "t1", run: 1, stopReason: "final_answer", outcome: "succeeded", steps: 2, modelCalls: 2, modelMs: 3_000,
    servedBy: { "gpt-6-luna-2026-09-15": 2 }, usage: { inputTokens: 300, outputTokens: 20 }, seconds: 12.3, toolCalls: 2,
    toolErrors: { click_intercepted: 1 }, answer: "$42 per month",
  })
})

it("takes usage from the result, or else adds up the trace's model calls the way the agent does", () => {
  const usage = { inputTokens: 300, outputTokens: 20, cachedInputTokens: 150, cost: 0.003 }
  expect(runRecord(meta(), { stdout: result({ usage }) }).usage).toEqual(usage)
  // A router names the model it chose for each call. One call without a cost leaves the cost out.
  const trace = jsonl(
    step(1), model(1, { inputTokens: 100, outputTokens: 5, cachedInputTokens: 80, cost: 0.001 }, "openai/gpt-6-luna"),
    step(2), model(2, { inputTokens: 150, outputTokens: 5, cachedInputTokens: 100 }, "google/gemini-3.8-flash"),
    step(3), model(3, { inputTokens: 200, outputTokens: 5, cost: 0.002 }, "openai/gpt-6-luna"),
  )
  expect(runRecord(meta({ timedOut: true, exitCode: null, signal: "SIGKILL" }), { trace })).toMatchObject({
    usage: { inputTokens: 450, outputTokens: 15, cachedInputTokens: 180 },
    servedBy: { "openai/gpt-6-luna": 2, "google/gemini-3.8-flash": 1 },
    modelMs: 4_500,
  })
})

it("counts a run the runner stopped from its trace, ignoring a partly written last line", () => {
  const trace = jsonl(step(1), model(1, { inputTokens: 100, outputTokens: 5 }), tool(1, "browser_navigate", "Navigated"), step(2), model(2, { inputTokens: 150, outputTokens: 5 }), step(3))
    + '{"time":"2026-10-06T00:00:00.000Z","type":"mod'
  expect(runRecord(meta({ timedOut: true, exitCode: null, signal: "SIGKILL", seconds: 600 }), { stdout: "", trace })).toMatchObject({
    stopReason: "run_timeout", outcome: "none", steps: 3, modelCalls: 2, usage: { inputTokens: 250, outputTokens: 10 }, toolCalls: 1, seconds: 600,
  })
  // The CLI answers the runner's SIGINT with a cancelled result.
  const cancelled = result({ status: "failed", stopReason: "cancelled", answer: "", outcome: { status: "unknown", verification: "unverified", unfinished: [] }, error: "Interrupted" })
  expect(runRecord(meta({ timedOut: true, exitCode: 1 }), { stdout: cancelled })).toMatchObject({ stopReason: "run_timeout", outcome: "unknown", error: "Interrupted" })
})

it("keeps the agent's result from the trace when the run hung after finishing", () => {
  const trace = jsonl(step(1), model(1, { inputTokens: 100, outputTokens: 5 }), { type: "done", result: JSON.parse(result({ steps: 1, usage: { inputTokens: 100, outputTokens: 5 } })) })
  expect(runRecord(meta({ timedOut: true, exitCode: null, signal: "SIGKILL" }), { stdout: "", trace })).toMatchObject({
    stopReason: "final_answer", outcome: "succeeded", steps: 1, answer: "$42 per month",
  })
})

it("reports a CLI failure outside the agent with its error line", () => {
  const stderr = 'owa: Model provider "openrouter" needs an API key: set OPENROUTER_API_KEY or OWA_API_KEY.\n'
  expect(runRecord(meta({ exitCode: 1, seconds: 0.4 }), { stdout: "", stderr })).toEqual({
    arm: "luna", task: "t1", run: 1, stopReason: "cli_error", outcome: "none", steps: 0, modelCalls: 0, modelMs: 0, servedBy: {},
    usage: { inputTokens: 0, outputTokens: 0 }, seconds: 0.4, toolCalls: 0, toolErrors: {},
    error: 'owa: Model provider "openrouter" needs an API key: set OPENROUTER_API_KEY or OWA_API_KEY.',
  })
})

const record = (overrides: Partial<RunRecord>): RunRecord => ({
  arm: "luna", task: "t1", run: 1, stopReason: "final_answer", outcome: "succeeded", steps: 10, modelCalls: 10, modelMs: 15_000,
  servedBy: { "gpt-6-luna-2026-09-15": 10 }, usage: { inputTokens: 1_000_000, outputTokens: 2_000 }, seconds: 60, toolCalls: 9, toolErrors: {}, ...overrides,
})

it("summarizes counts, medians, totals and tool errors", () => {
  const summary = summarize([
    record({ steps: 4, seconds: 30, usage: { inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 1_000 }, toolErrors: { stale_ref: 2 } }),
    record({ outcome: "partial", stopReason: "step_limit", steps: 30, seconds: 200, usage: { inputTokens: 3_000_000, cachedInputTokens: 2_000_000, outputTokens: 3_000 }, toolErrors: { stale_ref: 1, other: 1 } }),
    record({ steps: 6, seconds: 40, usage: { inputTokens: 1_000_000, outputTokens: 1_000 } }),
  ], { input: 0.1, cachedInput: 0.01, output: 0.5 })
  expect(summary).toEqual({
    runs: 3,
    outcomes: { succeeded: 2, partial: 1 },
    stopReasons: { final_answer: 2, step_limit: 1 },
    steps: { median: 6, total: 40 },
    modelCalls: 30,
    modelMs: 45_000,
    servedBy: { "gpt-6-luna-2026-09-15": 30 },
    usage: { inputTokens: 5_000_000, cachedInputTokens: 2_800_000, outputTokens: 5_000 },
    // 2.2M uncached input at $0.10, 2.8M cached at $0.01 and 5k output at $0.50 per million.
    estimatedCost: expect.closeTo(0.22 + 0.028 + 0.0025, 10),
    seconds: { median: 40, total: 270 },
    toolCalls: 27,
    toolErrors: { stale_ref: 3, click_intercepted: 0, not_visible: 0, navigation: 0, download: 0, invalid_arguments: 0, other: 1 },
  })
  expect(summarize([record({ seconds: 10 }), record({ seconds: 20 })]).seconds.median).toBe(15)
  expect(summarize([])).toMatchObject({ runs: 0, steps: { median: 0, total: 0 }, usage: { inputTokens: 0, outputTokens: 0 } })
  expect(summarize([record({})])).not.toHaveProperty("estimatedCost")
})

it("totals the reported cost only when every run that called the model reported one", () => {
  const paid = (cost: number) => record({ usage: { inputTokens: 1_000, outputTokens: 10, cost } })
  const noCalls = record({ stopReason: "cli_error", outcome: "none", modelCalls: 0, servedBy: {}, usage: { inputTokens: 0, outputTokens: 0 } })
  expect(summarize([paid(0.5), paid(0.25), noCalls]).usage).toEqual({ inputTokens: 2_000, outputTokens: 20, cost: 0.75 })
  expect(summarize([paid(0.5), record({ usage: { inputTokens: 1_000, outputTokens: 10 } })]).usage).not.toHaveProperty("cost")
})

it("compares arms side by side, overall and per task", () => {
  const arms: BenchArm[] = [
    { name: "luna", model: "openai:gpt-6-luna", modelOptions: { reasoning_effort: "none" }, prices: { input: 0.1, cachedInput: 0.01, output: 0.5 } },
    { name: "jev", model: "openrouter:typesafe/jev-router", flags: ["--max-steps", "30"] },
  ]
  const tasks = [{ id: "Allrecipes--3", task: "…" }, { id: "a|b", task: "…" }]
  const jev = (overrides: Partial<RunRecord>) => record({ arm: "jev", modelMs: 30_000, servedBy: { "openai/gpt-6-luna": 10 }, ...overrides })
  const records = [
    record({ task: "Allrecipes--3", run: 1, steps: 8, seconds: 50, toolErrors: { not_visible: 1 } }),
    record({ task: "Allrecipes--3", run: 2, outcome: "partial", stopReason: "step_limit", steps: 30, seconds: 190, toolErrors: { not_visible: 1, other: 2 } }),
    record({ task: "a|b", run: 1, outcome: "blocked", steps: 3, seconds: 20 }),
    record({ task: "a|b", run: 2, outcome: "blocked", steps: 5, seconds: 30 }),
    jev({ task: "Allrecipes--3", run: 1, steps: 12, seconds: 70, usage: { inputTokens: 600_000, outputTokens: 900, cachedInputTokens: 500_000, cacheWriteTokens: 1_000, cost: 0.05 } }),
    jev({
      task: "Allrecipes--3", run: 2, outcome: "none", stopReason: "run_timeout", steps: 14, seconds: 600,
      servedBy: { "openai/gpt-6-luna": 7, "google/gemini-3.8-flash": 3 }, usage: { inputTokens: 700_000, outputTokens: 1_100, cachedInputTokens: 600_000, cost: 0.06 },
    }),
    jev({ task: "a|b", run: 1, outcome: "unknown", stopReason: "brand_new_reason", steps: 2, seconds: 10, usage: { inputTokens: 1_500, outputTokens: 50, cost: 0.0001 } }),
  ]
  const report = compare(arms, tasks, 2, records)
  expect(report.overall.jev).toMatchObject({ runs: 3, stopReasons: { final_answer: 1, run_timeout: 1, brand_new_reason: 1 } })
  expect(report.perTask["a|b"].luna).toMatchObject({ runs: 2, outcomes: { blocked: 2 }, steps: { median: 4, total: 8 } })

  const summary = renderSummary(report)
  expect(summary).toContain("2 tasks, 2 runs per task and arm.")
  expect(summary).toContain('- **luna**: `openai:gpt-6-luna`, model options `{"reasoning_effort":"none"}`, prices per million tokens: input $0.1, cached input $0.01, output $0.5')
  expect(summary).toContain("- **jev**: `openrouter:typesafe/jev-router`, flags `--max-steps 30`")
  expect(summary.slice(summary.indexOf("|  | luna | jev |")).split("\n")).toEqual([
    "|  | luna | jev |",
    "| --- | --- | --- |",
    "| finished runs | 4/4 | 3/4 |",
    "| outcome: succeeded | 1 | 1 |",
    "| outcome: partial | 1 | 0 |",
    "| outcome: blocked | 2 | 0 |",
    "| outcome: unknown | 0 | 1 |",
    "| outcome: none | 0 | 1 |",
    "| stop: final_answer | 3 | 1 |",
    "| stop: step_limit | 1 | 0 |",
    "| stop: run_timeout | 0 | 1 |",
    "| stop: brand_new_reason | 0 | 1 |",
    "| steps (median / total) | 6.5 / 46 | 12 / 28 |",
    "| wall time (median / total) | 40.0 s / 4.8 min | 1.2 min / 11.3 min |",
    "| model calls | 40 | 30 |",
    "| model call time (mean / total) | 1.5 s / 1.0 min | 3.0 s / 1.5 min |",
    "| served by | gpt-6-luna-2026-09-15 (40) | openai/gpt-6-luna (27), google/gemini-3.8-flash (3) |",
    "| input tokens | 4,000,000 | 1,301,500 |",
    "| cached input tokens | n/a | 1,100,000 |",
    "| cache write tokens | n/a | 1,000 |",
    "| output tokens | 8,000 | 2,050 |",
    "| cost reported by the provider | n/a | 0.1101 |",
    "| cost estimated from prices | $0.4040 | n/a |",
    "| tool calls | 36 | 27 |",
    "| tool errors: stale ref | 0 | 0 |",
    "| tool errors: click intercepted | 0 | 0 |",
    "| tool errors: not visible or outside the viewport | 2 | 0 |",
    "| tool errors: navigation failure | 0 | 0 |",
    "| tool errors: download | 0 | 0 |",
    "| tool errors: invalid arguments | 0 | 0 |",
    "| tool errors: other | 2 | 0 |",
  ])

  expect(renderPerTask(report).split("\n").slice(-4)).toEqual([
    "| task | luna | jev |",
    "| --- | --- | --- |",
    "| Allrecipes--3 | succeeded, partial (step_limit) · 19 steps · 2.0 min · 2.0M in · 4 tool errors | succeeded, run_timeout · 13 steps · 5.6 min · 1.3M in |",
    "| a\\|b | blocked, blocked · 4 steps · 25.0 s · 2.0M in | unknown (brand_new_reason) · 2 steps · 10.0 s · 2k in · 1/2 runs |",
  ])
})

it("validates task files and keeps only id and task", () => {
  expect(parseTasks([{ id: "Google Flights--9", task: "Find a flight", web: "https://www.google.com/travel/flights" }])).toEqual([{ id: "Google Flights--9", task: "Find a flight" }])
  expect(() => parseTasks({ id: "a", task: "b" })).toThrow("non-empty JSON array")
  expect(() => parseTasks([])).toThrow("non-empty JSON array")
  expect(() => parseTasks([{ id: "a", task: "x" }, { id: "a", task: "y" }])).toThrow('Duplicate task id "a"')
  for (const id of ["a/b", "..", "", 7]) expect(() => parseTasks([{ id, task: "x" }])).toThrow('Task 1: "id" must be a string usable as a directory name')
  expect(() => parseTasks([{ id: "a", task: " " }])).toThrow('Task "a": "task" must be a non-empty string')
})

it("validates arms before anything runs", () => {
  const luna = { name: "luna", model: "openai:gpt-6-luna", modelOptions: { reasoning_effort: "none" }, flags: ["--max-steps", "30"], prices: { input: 0.1, output: 0.5 } }
  expect(parseArms([luna, { name: "gpt-6.1-sol", model: "openai:gpt-6.1-sol" }])).toEqual([luna, { name: "gpt-6.1-sol", model: "openai:gpt-6.1-sol" }])
  const fails = (arm: object, message: string) => expect(() => parseArms([arm])).toThrow(message)
  fails({ name: "a/b", model: "m" }, 'Arm 1: "name" must contain only letters')
  fails({ name: "..", model: "m" }, 'Arm 1: "name" must contain only letters')
  fails({ name: "luna", model_options: {}, model: "m" }, 'Arm "luna": unknown field "model_options"')
  fails({ name: "luna" }, 'Arm "luna": "model" must be a provider:model string')
  fails({ name: "luna", model: "m", modelOptions: { model: "other" } }, 'Arm "luna": Model options cannot set "model"')
  fails({ name: "luna", model: "m", modelOptions: [] }, 'Arm "luna": --model-options / OWA_MODEL_OPTIONS must be a JSON object')
  fails({ name: "luna", model: "m", flags: "--max-steps 30" }, 'Arm "luna": "flags" must be an array of strings')
  fails({ name: "luna", model: "m", flags: ["--model=other"] }, 'Arm "luna": the runner sets --model;')
  fails({ name: "luna", model: "m", flags: ["--trace", "t.jsonl"] }, 'Arm "luna": the runner sets --trace;')
  fails({ name: "luna", model: "m", prices: { input: -1, output: 1 } }, 'Arm "luna": "prices" must be { input, cachedInput?, output }')
  fails({ name: "luna", model: "m", prices: { input: 1, output: 1, cached: 0.1 } }, 'Arm "luna": "prices" must be { input, cachedInput?, output }')
  expect(() => parseArms([{ name: "a", model: "m" }, { name: "a", model: "n" }])).toThrow('Duplicate arm name "a"')
})

it("plans runs task by task with the arms side by side", () => {
  const arms = parseArms([{ name: "a", model: "m" }, { name: "b", model: "n" }])
  const tasks = parseTasks([{ id: "t1", task: "x" }, { id: "t2", task: "y" }])
  expect(planRuns(tasks, arms, 2).map(({ arm, task, run }) => `${run}:${task.id}:${arm.name}`)).toEqual([
    "1:t1:a", "1:t1:b", "1:t2:a", "1:t2:b", "2:t1:a", "2:t1:b", "2:t2:a", "2:t2:b",
  ])
})

it("prints usage and runs nothing without tasks, arms and an output directory", async () => {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../../scripts/bench.ts"), "--tasks", "missing.json"], { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" })
  expect(await proc.exited).toBe(1)
  expect(await new Response(proc.stdout).text()).toContain("bun run bench --tasks <tasks.json> --arms <arms.json> --out <dir>")
})
