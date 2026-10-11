import { afterAll, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { z } from "zod"
import { type AgentEvent, type AgentOptions, runAgent, SYSTEM_PROMPT } from "./agent"
import { BrowserSession } from "./browser"
import { typesafeSystemOne } from "./model/typesafe"
import { type FetchLike, type Message, ModelHttpError, type ModelRequest, type ModelResponse } from "./model/types"
import { PAGE_CHECK_PROMPT, PAGE_KINDS, pageCheckRequest, parsePageKind } from "./page-check"
import { startFixtureServer } from "./testing/fixture"
import { scriptedModel } from "./testing/scripted-model"
import type { BrowserTool, ToolResult } from "./tools"

type Reply = (request: ModelRequest) => ModelResponse | Promise<ModelResponse>
type Call = [tool: string, args?: { url?: string; fail?: boolean }]
type ModelEvent = Extract<AgentEvent, { type: "model" }>

const fixture = startFixtureServer()
afterAll(() => fixture.stop())

const SITE = "https://shop.test"

/** A page as BrowserSession.snapshot() shows it. */
const snapshotOf = (url: string, body = `- heading "${url}" [level=1] [ref=e1]`) => `Page URL: ${url}\nPage title: ${new URL(url).pathname}\nPage tab: t1\nSnapshot:\n${body}`
/** The text a fake tool returns after reaching `url`. */
const resultText = (tool: string, url: string) => `${tool} done\nLanding URL: ${url}`

/** Tools that move to `url` when given one and show that page; with `fail` the call fails after the page moved. */
function fakeTools(): BrowserTool[] {
  let current = `${SITE}/`
  const names = ["browser_navigate", "browser_go_back", "browser_click", "browser_scroll", "browser_wait_for", "browser_snapshot", "browser_get_text"]
  return names.map((name): BrowserTool => ({
    name, description: name, schema: z.object({ url: z.string().optional(), fail: z.boolean().optional() }), readOnly: false, capability: "core",
    async run(_session, { url, fail }): Promise<ToolResult> {
      if (url) current = url
      if (fail) return { text: `${name} failed`, isError: true, snapshot: snapshotOf(current) }
      if (name === "browser_get_text") return { pageText: true, text: `Text of ${current}` }
      return { text: resultText(name, current), snapshot: snapshotOf(current) }
    },
  }))
}

/** A session that never opens a browser; `snapshot()` answers from `next`. */
class SnapshotSession extends BrowserSession {
  snapshots = 0
  constructor(private readonly next: () => Promise<string>) {
    super({ headless: true })
  }
  override async snapshot(): Promise<string> {
    this.snapshots++
    return this.next()
  }
}

/** A checker reply naming `label`, with a probability when given one. */
const kind = (label: string, confidence?: number): Reply => () => ({
  text: JSON.stringify(confidence === undefined ? { label } : { label, confidence }), toolCalls: [], model: "checker-v1", usage: { inputTokens: 4700, outputTokens: 95 },
})

/** Runs one tool call per step on the fake tools, then a final answer, with a checker model named "fake-checker" when a checker script is given. */
async function run(calls: Call[], checker?: Reply[], options: Partial<AgentOptions> = {}) {
  const model = scriptedModel([
    ...calls.map(([name, args = {}], index): Reply => () => ({ toolCalls: [{ id: `${index + 1}`, name, arguments: args }] })),
    () => ({ text: 'done\n{"outcome":"succeeded","unfinished":[]}', toolCalls: [] }),
  ])
  const checkerModel = checker && { ...scriptedModel(checker), name: "fake-checker" }
  const events: AgentEvent[] = []
  const result = await runAgent({
    task: "t", model, checkerModel, browser: new BrowserSession({ headless: true }), tools: fakeTools(), onEvent: (event) => events.push(event), ...options,
  })
  return { model, checkerModel, events, result }
}

/** The text parts of the tool result that a request ends with. */
function lastResult(request: ModelRequest): string[] {
  const last = request.messages.at(-1)
  return last?.role === "tool" ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : []
}
const userText = (request: Omit<ModelRequest, "signal">) => request.messages.flatMap((message) => (message.role === "user" ? message.content : [])).map((part) => (part.type === "text" ? part.text : "")).join("\n")
const checkedUrls = (requests: ModelRequest[]) => requests.map((request) => JSON.parse(userText(request)).url)
const checkerEvents = (events: AgentEvent[]) => events.filter((event): event is ModelEvent => event.type === "model" && event.role === "checker")

const plain = (url: string, tool = "browser_navigate") => [resultText(tool, url), snapshotOf(url)]

it("checks the page after navigate, go back and an action that reached another URL, never after reads, waits, scrolls or failures", async () => {
  const { checkerModel, events, result } = await run([
    ["browser_navigate", { url: `${SITE}/a` }],
    ["browser_scroll"],
    ["browser_wait_for"],
    ["browser_snapshot"],
    ["browser_get_text"],
    // A click that stays on the page, or that only changes the fragment, opens nothing new.
    ["browser_click"],
    ["browser_click", { url: `${SITE}/b` }],
    ["browser_click", { url: `${SITE}/b#reviews` }],
    // Navigating opens a page even at the same URL.
    ["browser_navigate", { url: `${SITE}/b` }],
    ["browser_go_back", { url: `${SITE}/a` }],
    ["browser_click", { url: `${SITE}/c`, fail: true }],
    ["browser_scroll", { url: `${SITE}/d` }],
    // A page first seen in a failed result or a scroll is checked at the next action on it.
    ["browser_click"],
  ], Array(5).fill(kind("content", 1)))
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 14, checkerUsage: { inputTokens: 5 * 4700, outputTokens: 5 * 95 } })
  expect(checkedUrls(checkerModel!.requests)).toEqual([`${SITE}/a`, `${SITE}/b`, `${SITE}/b`, `${SITE}/a`, `${SITE}/d`])
  const checks = checkerEvents(events)
  expect(checks.map((event) => event.step)).toEqual([1, 7, 9, 10, 13])
  // Each check is traced right after the tool result it checked.
  for (const check of checks) expect(events[events.indexOf(check) - 1]).toMatchObject({ type: "tool", step: check.step })
})

it("counts the page open when the task starts as seen", async () => {
  class OpenSession extends BrowserSession {
    override get currentUrl(): string | undefined { return `${SITE}/#top` }
  }
  const { checkerModel } = await run([["browser_click"], ["browser_click", { url: `${SITE}/b` }]], [kind("content", 1)], { browser: new OpenSession({ headless: true }) })
  expect(checkedUrls(checkerModel!.requests)).toEqual([`${SITE}/b`])
})

const findings: Array<[string, string]> = [
  ["access_denied", "Page check: this page is a bot check or access denial, so the site is blocking this browser."],
  ["rate_limited", "Page check: the site is rate-limiting this browser."],
  ["not_found", "Page check: this page says the URL does not exist."],
  ["login_required", "Page check: the page asks to sign in before showing the content."],
  ["blocking_dialog", "Page check: a dialog or banner covers the page; close or answer it first."],
]

it.each(findings)("adds one fixed sentence to the result of a page the checker is sure is %s", async (label, sentence) => {
  // From 0.8 up, and without a probability, as chat models reply.
  for (const confidence of [0.8, 0.97, undefined]) {
    const { model, events } = await run([["browser_click", { url: `${SITE}/a` }]], [kind(label, confidence)])
    const text = `${resultText("browser_click", `${SITE}/a`)}\n${sentence}`
    expect(lastResult(model.requests[1]!)).toEqual([text, snapshotOf(`${SITE}/a`)])
    // The trace shows the result as the agent read it.
    expect(events.find((event) => event.type === "tool")).toMatchObject({ result: { text } })
  }
})

it("leaves the result as it was for content or below 0.8, without waiting on an empty results page", async () => {
  for (const reply of [kind("content", 1), kind("content"), kind("access_denied", 0.79), kind("empty_results", 0.79)]) {
    const browser = new SnapshotSession(async () => { throw new Error("no snapshot expected") })
    const { model, result } = await run([["browser_navigate", { url: `${SITE}/a` }]], [reply], { browser })
    expect(lastResult(model.requests[1]!)).toEqual(plain(`${SITE}/a`))
    expect(browser.snapshots).toBe(0)
    expect(result).not.toHaveProperty("checkerError")
  }
})

it("waits 2 s on an empty results page and shows a new snapshot, or nothing new when it cannot take one", async () => {
  const url = `${SITE}/search?q=lamp`
  const fresh = snapshotOf(url, '- listitem "Desk lamp" [ref=e7]')
  const browser = new SnapshotSession(async () => fresh)
  const started = performance.now()
  const { model, events } = await run([["browser_click", { url }]], [kind("empty_results", 0.9)], { browser })
  expect(performance.now() - started).toBeGreaterThanOrEqual(1_900)
  expect(browser.snapshots).toBe(1)
  const text = `${resultText("browser_click", url)}\nPage check: the results area was empty, so the browser waited 2 s and took a new snapshot.`
  expect(lastResult(model.requests[1]!)).toEqual([text, fresh])
  expect(events.find((event) => event.type === "tool")).toMatchObject({ result: { text, snapshot: fresh } })

  const failing = new SnapshotSession(async () => { throw new Error("Target page, context or browser has been closed") })
  const second = await run([["browser_click", { url }]], [kind("empty_results", 0.9)], { browser: failing })
  expect(failing.snapshots).toBe(1)
  expect(lastResult(second.model.requests[1]!)).toEqual(plain(url, "browser_click"))
  expect(second.result).not.toHaveProperty("checkerError")
}, 15_000)

const failures: Array<[string, Reply, string]> = [
  ["fails", () => { throw new ModelHttpError(503, "overloaded", "fake-checker") }, "fake-checker request failed with HTTP 503: overloaded"],
  ["replies in prose", () => ({ text: "This page is blocked.", toolCalls: [] }), "fake-checker replied without a page kind"],
  ["names an unknown kind", kind("captcha", 1), "fake-checker replied without a page kind"],
  ["gives a probability above 1", kind("access_denied", 1.5), "fake-checker replied without a page kind"],
]

it.each(failures)("changes nothing when the checker %s", async (how, reply, checkerError) => {
  const { model, events, result } = await run([["browser_navigate", { url: `${SITE}/a` }]], [reply])
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 2, checkerError })
  expect(result).not.toHaveProperty("error")
  expect(lastResult(model.requests[1]!)).toEqual(plain(`${SITE}/a`))
  // Every call is traced with why it gave no kind; only a reply that came back counts in checkerUsage.
  expect(checkerEvents(events)).toMatchObject([{ step: 1, error: checkerError }])
  expect("checkerUsage" in result).toBe(how !== "fails")
})

it("goes on without a check that takes more than 5 s or that the run cancels", async () => {
  let checkerSignal: AbortSignal | undefined
  const started = performance.now()
  const slow = await run([["browser_navigate", { url: `${SITE}/a` }]], [(request) => {
    checkerSignal = request.signal
    // An adapter that ignores abort; the agent must stop waiting.
    return new Promise(() => {})
  }])
  expect(performance.now() - started).toBeGreaterThanOrEqual(4_900)
  expect(checkerSignal?.aborted).toBe(true)
  const timedOut = "fake-checker gave no page check within 5 s"
  expect(slow.result).toMatchObject({ status: "completed", stopReason: "final_answer", checkerError: timedOut })
  expect(slow.result).not.toHaveProperty("checkerUsage")
  expect(lastResult(slow.model.requests[1]!)).toEqual(plain(`${SITE}/a`))
  expect(checkerEvents(slow.events)).toMatchObject([{ step: 1, error: timedOut }])

  const controller = new AbortController()
  const cancelled = await run([["browser_navigate", { url: `${SITE}/a` }]], [() => {
    controller.abort(new Error("Cancelled"))
    return new Promise(() => {})
  }], { signal: controller.signal })
  expect(cancelled.result).toMatchObject({ status: "failed", stopReason: "cancelled", error: "Cancelled", checkerError: "Cancelled" })
  expect(cancelled.model.requests).toHaveLength(1)
}, 15_000)

it("sends the same requests without a checker model as with one that finds only content", async () => {
  const calls: Call[] = [["browser_navigate", { url: `${SITE}/a` }], ["browser_click", { url: `${SITE}/b` }]]
  const without = await run(calls)
  const checked = await run(calls, [kind("content", 1), kind("content", 1)])
  expect(checked.model.requests).toEqual(without.model.requests)
  expect(without.model.requests[0]!.system).toBe(SYSTEM_PROMPT)
  expect(checkerEvents(without.events)).toHaveLength(0)
  expect(without.result).not.toHaveProperty("checkerUsage")
  expect(without.result).not.toHaveProperty("checkerError")
  // The results differ only in the checker's usage and in time.
  const { durationMs: _withoutTime, ...withoutRest } = without.result
  const { durationMs: _checkedTime, checkerUsage, ...checkedRest } = checked.result
  expect(checkedRest).toEqual(withoutRest)
  expect(checkerUsage).toEqual({ inputTokens: 9400, outputTokens: 190 })
})

it("asks TypeSafe System One one Choice question per page", async () => {
  const bodies: unknown[] = []
  const fetchImpl: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)))
    return Response.json({
      model: "jev-1.13.0",
      answers: { answer: { type: "choice", choice: "access_denied", confidence: 0.95, probabilities: { access_denied: 0.97, content: 0.03 } } },
      usage: { input_tokens: 896, output_tokens: 95 },
    })
  }
  const checkerModel = typesafeSystemOne({ model: "jev-latest", apiKey: "k", fetch: fetchImpl })
  const { model, events, result } = await run([["browser_navigate", { url: `${SITE}/a` }]], undefined, { checkerModel })
  expect(bodies).toEqual([{
    model: "jev-latest",
    state: { url: `${SITE}/a`, browser_result: resultText("browser_navigate", `${SITE}/a`), accessibility_snapshot: snapshotOf(`${SITE}/a`) },
    questions: { answer: { type: "choice", instructions: PAGE_CHECK_PROMPT, criteria: PAGE_KINDS } },
  }])
  expect(lastResult(model.requests[1]!)[0]).toBe(`${resultText("browser_navigate", `${SITE}/a`)}\n${findings[0]![1]}`)
  expect(result.checkerUsage).toEqual({ inputTokens: 896, outputTokens: 95 })
  expect(checkerEvents(events)).toMatchObject([{ step: 1, text: '{"label":"access_denied","confidence":0.97}', model: "jev-1.13.0", usage: { inputTokens: 896, outputTokens: 95 } }])
})

it("builds one tool-less request with the page as a JSON object, listing the labels for models that ignore choices", () => {
  const page = { url: `${SITE}/a#top`, result: resultText("browser_navigate", `${SITE}/a#top`), snapshot: snapshotOf(`${SITE}/a#top`) }
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: JSON.stringify({ url: page.url, browser_result: page.result, accessibility_snapshot: page.snapshot }) }] }]
  expect(pageCheckRequest(page, { answersChoices: true })).toEqual({ system: PAGE_CHECK_PROMPT, choices: PAGE_KINDS, messages, tools: [] })
  const chat = pageCheckRequest(page, {})
  expect({ ...chat, system: "" }).toEqual({ system: "", choices: PAGE_KINDS, messages, tools: [] })
  expect(chat.system).toStartWith(`${PAGE_CHECK_PROMPT}\n\nLabels:\n- content: The site's normal content or controls are visible`)
  for (const [label, description] of Object.entries(PAGE_KINDS)) expect(chat.system).toContain(`\n- ${label}: ${description}\n`)
  expect(chat.system).toEndWith('\n\nReply with only JSON: {"label":"<one label>"}')

  // The labels keep the order of `kinds`, and the snapshot is cut at 40,000 characters.
  const kinds = { not_found: PAGE_KINDS.not_found!, content: PAGE_KINDS.content! }
  const rotated = pageCheckRequest({ ...page, snapshot: "x".repeat(50_000) }, {}, kinds)
  expect(Object.keys(rotated.choices!)).toEqual(["not_found", "content"])
  expect(rotated.system).toContain(`Labels:\n- not_found: ${kinds.not_found}\n- content: ${kinds.content}\n\n`)
  expect(JSON.parse(userText(rotated)).accessibility_snapshot).toBe("x".repeat(40_000))
})

it("reads the kind from JSON or fenced JSON, counting a missing probability as 1", () => {
  expect(parsePageKind('{"label":"not_found","confidence":0.93}')).toEqual({ label: "not_found", confidence: 0.93 })
  expect(parsePageKind('```json\n{"label":"blocking_dialog"}\n```')).toEqual({ label: "blocking_dialog", confidence: 1 })
  expect(parsePageKind('{"label":"content","confidence":0}')).toEqual({ label: "content", confidence: 0 })
  for (const text of [undefined, "", "content", "null", '{"label":"captcha"}', '{"label":"toString"}', '{"confidence":0.9}', '{"label":"content","confidence":1.2}', '{"label":"content","confidence":"0.9"}', '{"label":"content","confidence":null}']) {
    expect(parsePageKind(text)).toBeUndefined()
  }
})

/** A local stand-in for https://api.typesafe.ai/v1 that finds an access denial on every page, and the environment that sends a CLI's requests to it. */
function typesafeEndpoint() {
  const bodies: Array<Record<string, any>> = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      bodies.push(await request.json() as Record<string, any>)
      return Response.json({
        model: "jev-1.13.0",
        answers: { answer: { type: "choice", choice: "access_denied", confidence: 0.95, probabilities: { access_denied: 0.97, content: 0.03 } } },
        usage: { input_tokens: 896, output_tokens: 95 },
      })
    },
  })
  // No OWA_* settings or API keys from this shell: a checker or judge set there must not call a real API.
  const shell = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("OWA_") && !key.endsWith("_API_KEY"))) as Record<string, string>
  const env = { ...shell, TYPESAFE_API_KEY: "test-key", OWA_TEST_FETCH_FROM: "https://api.typesafe.ai/v1", OWA_TEST_FETCH_TO: `http://127.0.0.1:${server.port}/v1` }
  return { bodies, server, env }
}

const preload = ["--preload", join(import.meta.dir, "testing/redirect-fetch.ts")]

it("checks pages with TypeSafe System One through owa run and owa mcp --agent", async () => {
  const endpoint = typesafeEndpoint()
  const directory = await mkdtemp(join(tmpdir(), "owa-checker-"))
  try {
    // A model that opens the fixture's 403 page and answers with the page check it read.
    const module = join(directory, "model.ts")
    await Bun.write(module, `import { lastToolText, scriptedModel } from ${JSON.stringify(join(import.meta.dir, "testing/scripted-model.ts"))}
export default () => scriptedModel([
  () => ({ toolCalls: [{ id: "1", name: "browser_navigate", arguments: { url: ${JSON.stringify(`${fixture.url}/forbidden`)} } }] }),
  (request) => ({ text: lastToolText(request.messages).split("\\n").filter((line) => line.startsWith("Page check:")).join(" ") + "\\n" + ${JSON.stringify('{"outcome":"succeeded","unfinished":[]}')}, toolCalls: [] }),
])
`)
    const trace = join(directory, "trace.jsonl")
    const proc = Bun.spawn([
      process.execPath, ...preload, join(import.meta.dir, "cli.ts"), "run", "Find the price", "--json", "--headless", "--model-module", module,
      "--checker-model", "typesafe:jev-latest", "--checker-model-options", '{"tag":"owa-test"}', "--trace", trace,
    ], { env: endpoint.env, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect({ code, stderr }).toMatchObject({ code: 0 })
    expect(stderr).toMatch(/→ \[1\] browser_navigate [^\n]*\n {2}checker: \{"label":"access_denied","confidence":0\.97\}\n/)
    expect(stderr).toContain("(tokens in 0, out 0; checker in 896, out 95)")
    expect(JSON.parse(stdout)).toMatchObject({ answer: findings[0]![1], checkerUsage: { inputTokens: 896, outputTokens: 95 } })
    expect(endpoint.bodies).toHaveLength(1)
    expect(endpoint.bodies[0]).toMatchObject({
      model: "jev-latest", tag: "owa-test", state: { url: `${fixture.url}/forbidden` },
      questions: { answer: { type: "choice", instructions: PAGE_CHECK_PROMPT, criteria: PAGE_KINDS } },
    })
    expect(endpoint.bodies[0]!.state.browser_result).toContain("The server responded with HTTP 403.")
    const events = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(events.filter((event) => event.type === "model" && event.role === "checker")).toMatchObject([
      { step: 1, text: '{"label":"access_denied","confidence":0.97}', model: "jev-1.13.0", usage: { inputTokens: 896, outputTokens: 95 } },
    ])

    // owa mcp --agent reads the checker model from the environment.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...preload, join(import.meta.dir, "cli.ts"), "mcp", "--headless", "--agent", "--model-module", module],
      env: { ...endpoint.env, OWA_CHECKER_MODEL: "typesafe:jev-latest" },
      stderr: "inherit",
    })
    const client = new Client({ name: "owa-test", version: "0.0.0" })
    await client.connect(transport)
    try {
      const result = await client.callTool({ name: "browser_task", arguments: { task: "Find the price" } })
      const content = (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n")
      expect(content).toStartWith(findings[0]![1])
      expect(content).toContain("checker tokens: 896 in / 95 out]")
      expect(endpoint.bodies).toHaveLength(2)
    } finally {
      await client.close()
    }
  } finally {
    endpoint.server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

it.each([["run", "t"], ["mcp", "--agent"]])("checks the checker model's configuration before any model request: %s %s", async (command, argument) => {
  let requests = 0
  const endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch() {
      requests++
      return Response.json({ choices: [{ message: { content: 'done\n{"outcome":"succeeded","unfinished":[]}' } }] })
    },
  })
  const cli = async (args: string[], env: Record<string, string> = {}) => {
    const proc = Bun.spawn([
      process.execPath, join(import.meta.dir, "cli.ts"), command!, argument!, "--model", "local", "--api", "openai", "--base-url", `http://127.0.0.1:${endpoint.port}`, ...args,
    ], { env: { PATH: process.env.PATH ?? "", ...env }, stdin: "ignore", stdout: "ignore", stderr: "pipe" })
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    return { code, stderr }
  }
  const fails = async (message: string, args: string[], env?: Record<string, string>) => {
    const { code, stderr } = await cli(args, env)
    expect(code).toBe(1)
    expect(stderr).toContain(message)
    expect(stderr).not.toContain("secret-token")
  }
  try {
    // The checker reads its own provider's key; OWA_API_KEY belongs to the main model.
    await fails("set TYPESAFE_API_KEY", ["--checker-model", "typesafe:jev-latest"], { OWA_API_KEY: "secret-token" })
    await fails("set TYPESAFE_API_KEY", [], { OWA_CHECKER_MODEL: "typesafe:jev-latest" })
    await fails("--checker-model-options / OWA_CHECKER_MODEL_OPTIONS must be a JSON object", ["--checker-model", "ollama:qwen3:8b", "--checker-model-options", "invalid secret-token"])
    await fails("--checker-model-options / OWA_CHECKER_MODEL_OPTIONS needs --checker-model or OWA_CHECKER_MODEL", ["--checker-model-options", "{}"])
    await fails("--checker-model-options / OWA_CHECKER_MODEL_OPTIONS needs --checker-model or OWA_CHECKER_MODEL", [], { OWA_CHECKER_MODEL_OPTIONS: "{}" })
    expect(requests).toBe(0)
    // An empty flag turns off a checker model set in the environment.
    expect((await cli(["--checker-model", ""], { OWA_CHECKER_MODEL: "typesafe:jev-latest" })).code).toBe(0)
  } finally {
    endpoint.stop(true)
  }
}, 30_000)

it("measures a checker model on labeled pages with scripts/page-check-eval.ts", async () => {
  const orders: string[][] = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as { state: { url: string }; questions: { answer: { criteria: Record<string, string> } } }
      orders.push(Object.keys(body.questions.answer.criteria))
      const choice = body.state.url.endsWith("/sorry") ? "access_denied" : "content"
      return Response.json({ model: "jev-1.13.0", answers: { answer: { type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 0.95 } } }, usage: { input_tokens: 900, output_tokens: 95 } })
    },
  })
  const directory = await mkdtemp(join(tmpdir(), "owa-page-check-eval-"))
  try {
    const samples = join(directory, "samples.json")
    await Bun.write(samples, JSON.stringify([
      { id: "sorry", label: "access_denied", url: `${SITE}/sorry`, result: "Navigated", snapshot: snapshotOf(`${SITE}/sorry`) },
      { id: "gone", label: "not_found", url: `${SITE}/gone`, result: "Navigated", snapshot: snapshotOf(`${SITE}/gone`), note: "other fields are ignored" },
    ]))
    const proc = Bun.spawn([process.execPath, ...preload, join(import.meta.dir, "../scripts/page-check-eval.ts"), samples, "--checker-model", "typesafe:jev-latest"], {
      env: { PATH: process.env.PATH ?? "", TYPESAFE_API_KEY: "test-key", OWA_TEST_FETCH_FROM: "https://api.typesafe.ai/v1", OWA_TEST_FETCH_TO: `http://127.0.0.1:${server.port}/v1` },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toContain("accuracy 2/4 (given 1/2, rotated 1/2)")
    expect(stdout).toContain("acted on (a kind other than content at confidence 0.8 or more): 2 answers, 2 right")
    expect(stdout).toContain(`\n  ${"access_denied".padEnd(15)} access_denied 2\n  ${"not_found".padEnd(15)} content 2\n`)
    // Each sample is asked with the labels in their order and rotated by three.
    const labels = Object.keys(PAGE_KINDS)
    const rotated = [...labels.slice(3), ...labels.slice(0, 3)]
    expect(orders).toEqual([labels, labels, rotated, rotated])
  } finally {
    server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
