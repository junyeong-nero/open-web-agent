import { afterAll, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { Page } from "playwright"
import { z } from "zod"
import { type AgentEvent, type AgentOptions, type AgentResult, runAgent } from "./agent"
import { BrowserSession } from "./browser"
import { createMcpServer } from "./mcp"
import { type Message, ModelHttpError, type ModelRequest, type ModelResponse } from "./model/types"
import { needsScreenshotCheck, parseScreenshotVerdict, SCREENSHOT_CHECK_TIMEOUT_MS, SCREENSHOT_PROMPT, screenshotNote } from "./screenshot-check"
import { refFor, startFixtureServer } from "./testing/fixture"
import { lastToolText, scriptedModel } from "./testing/scripted-model"
import { type BrowserTool, selectTools, TOOLS, type ToolResult } from "./tools"

type Reply = (request: ModelRequest) => ModelResponse | Promise<ModelResponse>

const fixture = startFixtureServer()
afterAll(() => fixture.stop())

/** An action's snapshot whose tree has `lines` lines. */
const snapshot = (lines: number) =>
  `Page URL: https://shop.example/\nPage title: Shoes\nPage tab: t1\nSnapshot:\n${Array.from({ length: lines }, (_, index) => `- paragraph: Line ${index + 1} [ref=e${index + 1}]`).join("\n")}`
const intercepted = 'browser_click failed: click: Timeout 10000ms exceeded.\n- locator resolved to <button>Add to cart</button>\n- <div class="consent-backdrop"></div> intercepts pointer events\nTake a new browser_snapshot if the page may have changed.'
const tool = (name: string) => TOOLS.find((candidate) => candidate.name === name)

/** Fake tools named after the result they return; `peek` is read-only. */
const RESULTS: Record<string, ToolResult> = {
  intercepted: { text: intercepted, isError: true },
  sparse: { text: "Navigated to https://shop.example/", snapshot: snapshot(2) },
  full: { text: "Navigated to https://shop.example/list", snapshot: snapshot(12) },
  stale: { text: "ref e9 is not on the page, so nothing was done. Use a ref from this new snapshot.", snapshot: snapshot(12), isError: true },
  peek: { text: "Captured page snapshot", snapshot: snapshot(1) },
}
const fakeTools: BrowserTool[] = Object.entries(RESULTS).map(([name, result]) => ({
  name, description: "test", schema: z.object({}), readOnly: name === "peek", capability: "core", async run() { return result },
}))

const act = (...names: string[]): Reply => () => ({ toolCalls: names.map((name, index) => ({ id: `${name}-${index}`, name, arguments: {} })), usage: { inputTokens: 1000, outputTokens: 5 } })
const answer: Reply = () => ({ text: 'Added to cart.\n{"outcome":"succeeded","unfinished":[]}', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 20 } })
const verdict = (overlay = "none", loading = false, blocked = false): Reply => () => ({
  text: JSON.stringify({ overlay, loading, blocked }), toolCalls: [], model: "vision-v1", usage: { inputTokens: 900, outputTokens: 15 },
})
const note = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const visionEvents = (events: AgentEvent[]) => events.filter((event) => event.type === "model" && event.role === "vision")
const notes = (request: ModelRequest) => request.messages.filter((message) => message.role === "user" && message.content.some((part) => part.type === "text" && part.text.startsWith("Screenshot check:")))

/** A session with an open page and no browser. Its screenshots are fake JPEG bytes unless `screenshot` is replaced. */
class StubSession extends BrowserSession {
  readonly shots: unknown[] = []
  screenshot = async (options: unknown): Promise<Buffer> => {
    this.shots.push(options)
    return Buffer.from("fake jpeg")
  }
  override get currentUrl() { return "https://shop.example/" }
  override async page() { return { screenshot: (options: unknown) => this.screenshot(options) } as unknown as Page }
}

/** Runs the agent's script on the fake tools, with a vision model named "fake-vision" when a vision script is given. */
async function run(agent: Reply[], vision?: Reply[], options: Partial<AgentOptions> = {}, browser = new StubSession()) {
  const model = scriptedModel(agent)
  const visionModel = vision && { ...scriptedModel(vision), name: "fake-vision" }
  const events: AgentEvent[] = []
  const result = await runAgent({
    task: "Add the shoes to the cart", model, visionModel, browser, tools: fakeTools, onEvent: (event) => events.push(event), ...options,
  })
  return { model, visionModel, browser, events, result }
}

it("calls for a check only after an intercepted action or an action that left a nearly empty snapshot", () => {
  const error = { text: intercepted, isError: true }
  expect(needsScreenshotCheck(tool("browser_click"), error)).toBe(true)
  expect(needsScreenshotCheck(tool("browser_hover"), error)).toBe(true)
  // Other failures explain themselves.
  expect(needsScreenshotCheck(tool("browser_click"), RESULTS.stale!)).toBe(false)
  expect(needsScreenshotCheck(tool("browser_navigate"), { text: "browser_navigate failed: page.goto: net::ERR_NAME_NOT_RESOLVED", isError: true })).toBe(false)
  // A tree of fewer than five lines, blank lines not counted.
  for (const lines of [0, 1, 4]) expect(needsScreenshotCheck(tool("browser_navigate"), { text: "Navigated", snapshot: snapshot(lines) })).toBe(true)
  expect(needsScreenshotCheck(tool("browser_click"), { text: "Clicked", snapshot: `${snapshot(4)}\n\n  \n` })).toBe(true)
  expect(needsScreenshotCheck(tool("browser_navigate"), { text: "Navigated", snapshot: snapshot(5) })).toBe(false)
  // No tree to count: a failed follow-up snapshot, or a result without a snapshot.
  expect(needsScreenshotCheck(tool("browser_click"), { text: "Clicked", snapshot: "[Current page state unavailable. Previous snapshot refs may be stale.]" })).toBe(false)
  expect(needsScreenshotCheck(tool("browser_evaluate"), { text: "42" })).toBe(false)
  // Looking at a page again calls for nothing, and neither does an unknown tool.
  expect(needsScreenshotCheck(tool("browser_snapshot"), { text: "Captured page snapshot", snapshot: snapshot(1) })).toBe(false)
  expect(needsScreenshotCheck(tool("browser_get_text"), error)).toBe(false)
  expect(needsScreenshotCheck(undefined, { text: "Navigated", snapshot: snapshot(1) })).toBe(false)
})

it("turns a verdict into one line of fixed phrases, and nothing when the check found nothing", () => {
  const line = (reply: string) => {
    const found = parseScreenshotVerdict(reply)
    return found && screenshotNote(found)
  }
  expect(line('{"overlay":"cookie banner","loading":false,"blocked":false}')).toBe("Screenshot check: a cookie banner covers the page.")
  expect(line('{"overlay":" Sign-in popup","loading":false,"blocked":false}')).toBe("Screenshot check: a sign-in popup covers the page.")
  expect(line('```json\n{"overlay":"popup","loading":true,"blocked":false}\n```')).toBe("Screenshot check: a popup covers the page; the page is still loading.")
  expect(line('The page: {"overlay":"none","loading":true,"blocked":false}')).toBe("Screenshot check: the page is still loading.")
  // A block page is all that matters, even while it spins or shows a banner.
  expect(line('{"overlay":"cookie banner","loading":true,"blocked":true}')).toBe("Screenshot check: the page is a bot check or an access-denied page.")
  expect(parseScreenshotVerdict('{"overlay":"none","loading":false,"blocked":false}')).toEqual({ overlay: "none", loading: false, blocked: false })
  expect(line('{"overlay":"none","loading":false,"blocked":false}')).toBeUndefined()
  for (const reply of [
    undefined, "", "null", "A cookie banner covers the page.", '{"overlay":"newsletter","loading":false,"blocked":false}',
    '{"overlay":"constructor","loading":false,"blocked":false}', '{"overlay":"none","loading":"false","blocked":false}',
    '{"overlay":"none","loading":false}', '{"overlay":"none","loading":false,"blocked":false} {"overlay":"popup"}',
  ]) {
    expect(parseScreenshotVerdict(reply)).toBeUndefined()
  }
})

it("checks a screenshot once per step that called for it and tells the agent what it found", async () => {
  const { model, visionModel, browser, events, result } = await run(
    [act("full"), act("peek"), act("stale"), act("intercepted", "sparse"), act("sparse"), answer],
    [verdict("cookie banner"), verdict()],
  )
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 6, answer: "Added to cart." })

  // Steps 1-3 (a full page, a read-only look at a sparse one, another failure) call for no check. Both results of
  // step 4 call for one, which runs once, and step 5 calls for one.
  expect(visionModel!.requests).toHaveLength(2)
  expect(browser.shots).toEqual(Array(2).fill({ type: "jpeg", scale: "css", timeout: SCREENSHOT_CHECK_TIMEOUT_MS }))
  expect(visionModel!.requests[0]).toEqual({
    system: SCREENSHOT_PROMPT,
    tools: [],
    messages: [{ role: "user", content: [{ type: "image", mimeType: "image/jpeg", data: Buffer.from("fake jpeg").toString("base64") }, { type: "text", text: "The current page." }] }],
  })

  // The finding follows the step's tool results in the next request. A check that found nothing adds nothing.
  expect(model.requests[4]!.messages.slice(-3)).toMatchObject([
    { role: "tool", name: "intercepted" }, { role: "tool", name: "sparse" }, note("Screenshot check: a cookie banner covers the page."),
  ])
  expect(model.requests[5]!.messages.at(-1)).toMatchObject({ role: "tool", name: "sparse" })
  expect(model.requests.map((request) => notes(request).length)).toEqual([0, 0, 0, 0, 1, 1])

  // The vision model's tokens are reported apart from the agent's.
  expect(result.usage).toEqual({ inputTokens: 6000, outputTokens: 45 })
  expect(result.visionUsage).toEqual({ inputTokens: 1800, outputTokens: 30 })

  // Each check is a model event marked with its role, after the tool events of its step.
  expect(visionEvents(events)).toMatchObject([
    { role: "vision", step: 4, text: '{"overlay":"cookie banner","loading":false,"blocked":false}', toolCalls: [], model: "vision-v1", usage: { inputTokens: 900, outputTokens: 15 } },
    { role: "vision", step: 5, text: '{"overlay":"none","loading":false,"blocked":false}', toolCalls: [], model: "vision-v1", usage: { inputTokens: 900, outputTokens: 15 } },
  ])
  for (const event of visionEvents(events)) {
    expect(event).not.toHaveProperty("error")
    expect(event).toHaveProperty("durationMs")
  }
  const step4 = events.filter((event) => "step" in event && event.step === 4).map((event) => event.type === "model" && event.role ? event.role : event.type)
  expect(step4).toEqual(["step", "model", "tool", "tool", "vision"])
  expect(events.filter((event) => event.type === "model" && !event.role)).toHaveLength(6)
})

it("takes no screenshot and sends no other request without a vision model", async () => {
  const { model, browser, events, result } = await run([act("intercepted"), act("sparse"), answer])
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 3 })
  expect(result).not.toHaveProperty("visionUsage")
  expect(browser.shots).toHaveLength(0)
  expect(model.requests).toHaveLength(3)
  expect(model.requests.map((request) => notes(request).length)).toEqual([0, 0, 0])
  expect(events.filter((event) => "role" in event)).toHaveLength(0)
})

const failures: Array<[string, Reply | undefined, string, boolean]> = [
  ["the screenshot fails", undefined, "page.screenshot: Target page, context or browser has been closed", false],
  ["the vision request fails", () => { throw new ModelHttpError(503, "overloaded", "fake-vision") }, "fake-vision request failed with HTTP 503: overloaded", false],
  ["the vision model replies in prose", () => ({ text: "A cookie banner covers the page.", toolCalls: [] }), "fake-vision replied without a verdict", true],
  ["the vision model names an unknown overlay", () => ({ text: '{"overlay":"newsletter","loading":false,"blocked":false}', toolCalls: [] }), "fake-vision replied without a verdict", true],
  ["the vision model replies with nothing", () => ({ toolCalls: [] }), "fake-vision replied without a verdict", true],
]

it.each(failures)("goes on without a note when %s", async (_kind, reply, error, replied) => {
  const browser = new StubSession()
  if (!reply) browser.screenshot = async () => { throw new Error(error) }
  const { model, visionModel, events, result } = await run([act("intercepted"), answer], reply ? [reply] : [], {}, browser)
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 2, answer: "Added to cart." })
  expect(result).not.toHaveProperty("error")
  expect(visionModel!.requests).toHaveLength(reply ? 1 : 0)
  expect(model.requests).toHaveLength(2)
  expect(model.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", name: "intercepted" })
  // The trace says why the check gave no verdict. A reply that came back still counts in visionUsage.
  expect(visionEvents(events)).toMatchObject([{ role: "vision", step: 1, error }])
  expect("visionUsage" in result).toBe(replied)
})

it("gives up a check that outlasts its time bound and goes on", async () => {
  let visionSignal: AbortSignal | undefined
  const started = performance.now()
  // The adapter ignores the abort, so the agent must stop waiting by itself.
  const { model, events, result } = await run([act("intercepted"), answer], [(request) => {
    visionSignal = request.signal
    return new Promise(() => {})
  }])
  const elapsed = performance.now() - started
  expect(visionSignal?.aborted).toBe(true)
  expect(elapsed).toBeGreaterThanOrEqual(SCREENSHOT_CHECK_TIMEOUT_MS - 100)
  expect(elapsed).toBeLessThan(SCREENSHOT_CHECK_TIMEOUT_MS + 2_000)
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 2 })
  expect(result).not.toHaveProperty("visionUsage")
  expect(model.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", name: "intercepted" })
  expect(visionEvents(events)).toMatchObject([{ role: "vision", step: 1, error: `Screenshot check took longer than ${SCREENSHOT_CHECK_TIMEOUT_MS}ms` }])
}, 15_000)

it("still ends the run at its deadline or on cancellation during a check", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController()
    const { model, events, result } = await run([act("intercepted"), answer], [() => {
      if (cancel) controller.abort(new Error("Cancelled"))
      return new Promise(() => {})
    }], { signal: controller.signal, timeoutMs: cancel ? 10_000 : 300 })
    expect(result).toMatchObject({ status: "failed", stopReason: cancel ? "cancelled" : "timeout", steps: 1 })
    expect(result.durationMs).toBeLessThan(SCREENSHOT_CHECK_TIMEOUT_MS)
    expect(model.requests).toHaveLength(1)
    expect(visionEvents(events)).toMatchObject([{ role: "vision", step: 1, error: cancel ? "Cancelled" : "Task deadline exceeded" }])
  }
})

it("screenshots a nearly empty page and an intercepted click, also on a page that replaces window.eval", async () => {
  const browser = new BrowserSession({ headless: true })
  // Only the click gets a short timeout, since a new renderer can stall about 2 s on its first text render.
  const click = tool("browser_click")!
  const tools = selectTools().map((candidate): BrowserTool => candidate !== click ? candidate : {
    ...click,
    async run(session, args) {
      const page = await session.page()
      page.setDefaultTimeout(1_000)
      try {
        return await click.run(session, args)
      } finally {
        page.setDefaultTimeout(10_000)
      }
    },
  })
  const navigate = (path: string): Reply => () => ({ toolCalls: [{ id: path, name: "browser_navigate", arguments: { url: `${fixture.url}${path}` } }] })
  try {
    const { model, visionModel, result } = await run([
      navigate("/pricing"),
      navigate("/toggles-no-eval"),
      // The Insurance label lies on top of the Gift wrap checkbox, so the click is intercepted.
      (request) => ({ toolCalls: [{ id: "c", name: "browser_click", arguments: { ref: refFor(lastToolText(request.messages), /checkbox "Gift wrap"/) } }] }),
      answer,
    ], [verdict(), verdict("popup")], { browser, tools })
    expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 4 })

    // The two-line pricing page and the intercepted click were checked; the toggles page was not.
    expect(visionModel!.requests).toHaveLength(2)
    for (const request of visionModel!.requests) {
      const [image] = request.messages[0]?.role === "user" ? request.messages[0].content : []
      expect(image).toMatchObject({ type: "image", mimeType: "image/jpeg" })
      // A JPEG starts with the bytes FF D8 FF.
      expect(image?.type === "image" ? image.data : "").toStartWith("/9j/")
    }
    expect(model.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", name: "browser_navigate" })
    expect(lastToolText(model.requests[3]!.messages)).toContain('<label for="insurance">Insurance</label> intercepts pointer events')
    expect(model.requests[3]!.messages.at(-1)).toEqual(note("Screenshot check: a popup covers the page."))
  } finally {
    await browser.close()
  }
}, 30_000)

it("checks the page during browser_task without changing the tool list", async () => {
  const session = new StubSession()
  const agentModel = scriptedModel([act("intercepted"), answer])
  const server = createMcpServer({ session, tools: fakeTools, agentModel, agentVisionModel: { ...scriptedModel([verdict("sign-in popup")]), name: "fake-vision" } })
  const plain = createMcpServer({ session, tools: fakeTools, agentModel })
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" }
  expect((await server.handle(list))?.result).toEqual((await plain.handle(list))?.result)

  const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_task", arguments: { task: "Add the shoes to the cart" } } })
  const result = response?.result as { isError: boolean; content: Array<{ text: string }>; structuredContent: AgentResult }
  expect(result.isError).toBe(false)
  expect(result.structuredContent).toMatchObject({ answer: "Added to cart.", visionUsage: { inputTokens: 900, outputTokens: 15 } })
  expect(result.content[0]!.text).toContain("tokens: 2000 in / 25 out, vision tokens: 900 in / 15 out]")
  expect(agentModel.requests[1]!.messages.at(-1)).toEqual(note("Screenshot check: a sign-in popup covers the page."))
})

it("checks the page with --vision-model in owa run and with OWA_VISION_MODEL in owa mcp --agent", async () => {
  const requests: Array<{ path: string; authorization: string | null; body: Record<string, any> }> = []
  // A local stand-in for https://api.openai.com/v1 that sees a cookie banner on every screenshot.
  const endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), body: await request.json() as Record<string, any> })
      return Response.json({
        model: "vision-test-2026",
        choices: [{ message: { content: '{"overlay":"cookie banner","loading":false,"blocked":false}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 812, completion_tokens: 16 },
      })
    },
  })
  const directory = await mkdtemp(join(tmpdir(), "owa-vision-"))
  try {
    // The agent opens the two-line pricing page, then answers with the last message it got, which is the note.
    const module = join(directory, "model.ts")
    await Bun.write(module, `import { scriptedModel } from ${JSON.stringify(join(import.meta.dir, "testing/scripted-model.ts"))}
export default () => scriptedModel([
  () => ({ toolCalls: [{ id: "1", name: "browser_navigate", arguments: { url: ${JSON.stringify(`${fixture.url}/pricing`)} } }] }),
  (request) => {
    const last = request.messages.at(-1)
    const text = last?.role === "user" ? last.content.map((part) => part.type === "text" ? part.text : "").join("") : "no note"
    return { text: text + "\\n" + JSON.stringify({ outcome: "succeeded", unfinished: [] }), toolCalls: [] }
  },
])
`)
    // Role models take no base URL, so a preloaded helper sends the CLI's requests to the local endpoint. The test's own
    // OWA_* settings are left out so that they cannot turn on another model.
    const preload = ["--preload", join(import.meta.dir, "testing/redirect-fetch.ts")]
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !entry[0].startsWith("OWA_") && entry[1] !== undefined)),
      OPENAI_API_KEY: "test-key", OWA_TEST_FETCH_FROM: "https://api.openai.com/v1", OWA_TEST_FETCH_TO: `http://127.0.0.1:${endpoint.port}/v1`,
    }
    const trace = join(directory, "trace.jsonl")
    const proc = Bun.spawn([
      process.execPath, ...preload, join(import.meta.dir, "cli.ts"), "run", "Find the Pro price", "--json", "--headless", "--model-module", module,
      "--vision-model", "openai:vision-test", "--vision-model-options", '{"temperature":0}', "--trace", trace,
    ], { env, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect({ code, stderr }).toMatchObject({ code: 0 })
    expect(JSON.parse(stdout)).toMatchObject({
      answer: "Screenshot check: a cookie banner covers the page.", outcome: { status: "succeeded" }, visionUsage: { inputTokens: 812, outputTokens: 16 },
    })
    expect(stderr).toContain('  vision: {"overlay":"cookie banner","loading":false,"blocked":false}\n')
    expect(stderr).toContain("(tokens in 0, out 0; vision in 812, out 16)")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer test-key", body: { model: "vision-test", temperature: 0 } })
    expect(requests[0]!.body).not.toHaveProperty("tools")
    expect(requests[0]!.body.messages).toMatchObject([
      { role: "system", content: SCREENSHOT_PROMPT },
      { role: "user", content: [{ type: "image_url" }, { type: "text", text: "The current page." }] },
    ])
    expect(requests[0]!.body.messages[1].content[0].image_url.url).toStartWith("data:image/jpeg;base64,/9j/")
    const events = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(events.filter((event) => event.type === "model" && event.role === "vision")).toMatchObject([
      { step: 1, model: "vision-test-2026", usage: { inputTokens: 812, outputTokens: 16 } },
    ])

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...preload, join(import.meta.dir, "cli.ts"), "mcp", "--headless", "--agent", "--model-module", module],
      env: { ...env, OWA_VISION_MODEL: "openai:vision-test" },
      stderr: "inherit",
    })
    const client = new Client({ name: "owa-test", version: "0.0.0" })
    await client.connect(transport)
    try {
      const result = await client.callTool({ name: "browser_task", arguments: { task: "Find the Pro price" } })
      const content = (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n")
      expect(result.isError).toBe(false)
      expect(content).toStartWith("Screenshot check: a cookie banner covers the page.")
      expect(content).toContain("vision tokens: 812 in / 16 out]")
      expect(requests).toHaveLength(2)
    } finally {
      await client.close()
    }
  } finally {
    endpoint.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

it("rejects vision model settings that cannot work before the task starts", async () => {
  const cli = async (args: string[], env: Record<string, string> = {}) => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "run", "t", "--model", "local", "--api", "openai", "--base-url", "http://127.0.0.1:1", ...args], {
      env: { PATH: process.env.PATH ?? "", ...env }, stdin: "ignore", stdout: "ignore", stderr: "pipe",
    })
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    return { code, stderr }
  }
  expect(await cli(["--vision-model", "ollama:llava", "--vision-model-options", "not json"])).toEqual({
    code: 1, stderr: "owa: --vision-model-options / OWA_VISION_MODEL_OPTIONS must be a JSON object\n",
  })
  // The vision model reads its own provider's key.
  expect(await cli([], { OWA_VISION_MODEL: "gemini:gemini-3.1-flash-lite", OWA_API_KEY: "main-model-key" })).toMatchObject({ code: 1, stderr: expect.stringContaining("set GEMINI_API_KEY") })
})
