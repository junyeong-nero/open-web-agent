import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { type AgentEvent, type AgentResult, runAgent } from "./agent"
import { BrowserSession } from "./browser"
import { main } from "./cli"
import { createMcpServer } from "./mcp"
import { type ModelAdapter, ModelHttpError, type ModelRequest, type ModelResponse } from "./model/types"
import { startFixtureServer } from "./testing/fixture"
import { lastToolText, scriptedModel } from "./testing/scripted-model"
import { type BrowserTool, callTool, groundingPoint, selectTools, TOOLS, type ToolOptions } from "./tools"

type Reply = (request: ModelRequest) => ModelResponse | Promise<ModelResponse>

const fixture = startFixtureServer()
// One browser for the whole file; every test opens the page it needs.
const session = new BrowserSession({ headless: true })
afterAll(async () => {
  await session.close()
  fixture.stop()
})

const usage = { inputTokens: 1300, outputTokens: 9, cost: 0.00014 }
/** A grounding model reply as UI-TARS on OpenRouter would send it, with the served model and usage. */
const reply = (text: string): Reply => () => ({ text, toolCalls: [], model: "ui-tars-test", usage })
const grounding = (...replies: Reply[]) => ({ ...scriptedModel(replies), name: "fake-grounding" })
const names = (tools: BrowserTool[]) => tools.map((tool) => tool.name)
const openCanvas = () => callTool(selectTools(), session, "browser_navigate", { url: `${fixture.url}/canvas` })
const status = async () => (await session.page()).locator("#status").innerText()

it("reads a point from each supported reply format", () => {
  const size = { width: 1280, height: 800 }
  // Every reply names the center of the Book button, (300, 240) in the 1280×800 screenshot.
  const replies: Array<[string, number?]> = [
    ['{"x": 300, "y": 240}'],
    ['```json\n{"x": 300.4, "y": 239.6}\n```'],
    ["x=300 y=240"],
    ["click(start_box='(300,240)')"],
    ["<|box_start|>(300,240)<|box_end|>"],
    ["Action: click(point='<point>300 240</point>')"],
    ["The Book button is at 300, 240."],
    // A box gives its center.
    ['[{"bbox_2d": [280, 220, 320, 260], "label": "Book"}]'],
    // Fractions of the screenshot.
    ['{"x": 0.234375, "y": 0.3}'],
    // A 0–1000 or 0–100 scale, as set by --grounding-scale.
    ["(234, 300)", 1000],
    ['{"point_2d": [234, 300]}', 1000],
    ['<point x="23.4375" y="30" alt="Book">Book</point>', 100],
    // Gemini answers [y, x] and [ymin, xmin, ymax, xmax] on a 0–1000 scale, with or without the setting.
    ['[{"box_2d": [275, 195, 325, 273], "label": "Book"}]'],
    ['[{"point": [300, 234], "label": "Book"}]'],
    ['```json\n[{"box_2d": [275, 195, 325, 273], "label": "Book"}]\n```', 1000],
  ]
  for (const [text, scale] of replies) expect({ text, point: groundingPoint(text, size, scale) }).toEqual({ text, point: { x: 300, y: 240 } })

  // A point on the far edge becomes the last pixel.
  expect(groundingPoint("(1000, 1000)", size, 1000)).toEqual({ x: 1279, y: 799 })
  for (const [text, scale] of [["not found"], [""], ["(1500, 240)"], ["(300, 900)"], ["(-5, 240)"], ["(1100, 240)", 1000]] as Array<[string, number?]>) {
    expect({ text, point: groundingPoint(text, size, scale) }).toEqual({ text, point: undefined })
  }
})

describe("the vision capability", () => {
  it("locates a canvas button that the snapshot does not show, and clicks it", async () => {
    const opened = await openCanvas()
    expect(opened.snapshot).toContain("No seat booked")
    expect(opened.snapshot).not.toContain("Book")
    expect(opened.snapshot).not.toContain("button")
    // As on americanexpress.com, Playwright's page-world evaluate fails here; the vision tools do not use it.
    await expect((await session.page()).evaluate(() => 1)).rejects.toThrow("eval is disabled")

    const groundingModel = grounding(reply('{"x": 300, "y": 240}'))
    const tools = selectTools(["core", "vision"], { groundingModel })
    const located = await callTool(tools, session, "browser_locate", { description: "the Book button" })
    const call = { model: "ui-tars-test", durationMs: expect.any(Number), usage }
    expect(located).toEqual({
      text: "Located the Book button at x=300, y=240. Pass these to browser_click_at.",
      modelCall: { role: "grounding", text: '{"x": 300, "y": 240}', ...call },
      structuredContent: { x: 300, y: 240, ...call },
    })

    // One request without tools: the instructions, then the screenshot at the viewport's CSS size and the description.
    const [request] = groundingModel.requests
    expect(request!.tools).toEqual([])
    expect(request!.system).toContain("in pixels of the 1280×800 screenshot, counted from its top-left corner")
    expect(request!.messages).toHaveLength(1)
    const message = request!.messages[0]!
    const [image, text] = message.role === "user" ? message.content : []
    expect(text).toEqual({ type: "text", text: "Element: the Book button" })
    if (image?.type !== "image") throw new Error("The request has no image")
    expect(image.mimeType).toBe("image/png")
    const png = Buffer.from(image.data, "base64")
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1280, 800])

    const clicked = await callTool(tools, session, "browser_click_at", { x: 300, y: 240, element: "Book button" })
    expect(clicked.isError).toBeUndefined()
    expect(clicked.text).toStartWith("Clicked Book button at x=300, y=240\n")
    expect(clicked.snapshot).toContain("Seat booked")
  }, 30_000)

  it("scales normalized replies and refuses a point outside the viewport", async () => {
    await openCanvas()
    const groundingModel = grounding(reply("click(start_box='(234,300)')"), reply('[{"box_2d": [275, 195, 325, 273], "label": "Book"}]'))
    const tools = selectTools(["core", "vision"], { groundingModel, groundingScale: 1000 })
    // UI-TARS 1.0 answers on the scale it was given; Gemini's box_2d is on 0–1000 anyway.
    for (let index = 0; index < 2; index++) {
      expect((await callTool(tools, session, "browser_locate", { description: "Book" })).text).toBe("Located Book at x=300, y=240. Pass these to browser_click_at.")
    }
    expect(groundingModel.requests[0]!.system).toContain("on a 0–1000 scale on both axes, from the top-left corner (0, 0) to the bottom-right corner (1000, 1000)")

    expect(await callTool(tools, session, "browser_click_at", { x: 300, y: 800 })).toEqual({
      text: "x=300, y=800 is outside the 1280×800 viewport, so nothing was clicked. Scroll the target into view and locate it again.",
      isError: true,
    })
    expect((await callTool(tools, session, "browser_click_at", { x: -1, y: 240 })).text).toStartWith("Invalid arguments for browser_click_at")
    expect(await status()).toBe("No seat booked")
  }, 30_000)

  it("fails only the call, and says why, when the grounding model fails, hangs or names no point", async () => {
    await openCanvas()
    const locate = (groundingModel: ModelAdapter, options: ToolOptions = {}, signal?: AbortSignal) =>
      callTool(selectTools(["core", "vision"], { groundingModel, ...options }), session, "browser_locate", { description: "the Book button" }, signal)
    const failed = "The grounding model request failed, so nothing was located: "

    // A reply without a point still reports its usage.
    const prose = await locate(grounding(reply("I cannot find that element.")))
    expect(prose).toEqual({
      text: `No point inside the 1280×800 screenshot in the grounding model's reply. Describe the element another way, or scroll it into view first. The reply: "I cannot find that element."`,
      isError: true,
      modelCall: { role: "grounding", text: "I cannot find that element.", model: "ui-tars-test", durationMs: expect.any(Number), usage },
    })
    expect(await locate(grounding(reply("not found")))).toMatchObject({ isError: true, text: expect.stringMatching(/The reply: "not found"$/) })

    expect(await locate(grounding(() => { throw new ModelHttpError(503, "overloaded", "fake-grounding") }))).toEqual({
      text: `${failed}fake-grounding request failed with HTTP 503: overloaded`,
      isError: true,
    })

    // An adapter that ignores its abort signal is not waited for past the timeout, and its request is aborted.
    let requestSignal: AbortSignal | undefined
    const hung = await locate(grounding((request) => {
      requestSignal = request.signal
      return new Promise(() => {})
    }), { groundingTimeoutMs: 200 })
    expect(hung).toEqual({ text: `${failed}no reply within 0.2 s`, isError: true })
    expect(requestSignal?.aborted).toBe(true)

    // The caller's signal stops the request too, as MCP cancellation and the agent's deadline do.
    const cancelled = await locate(grounding(() => new Promise(() => {})), {}, AbortSignal.abort(new Error("Request cancelled by MCP client")))
    expect(cancelled).toEqual({ text: `${failed}Request cancelled by MCP client`, isError: true })
    expect(await status()).toBe("No seat booked")
  }, 30_000)

  it("offers the vision tools only with the capability, and browser_locate only with a grounding model", async () => {
    for (const tools of [selectTools(), selectTools(["core", "unsafe"]), selectTools(["core"], { groundingModel: grounding() })]) {
      expect(names(tools)).not.toContain("browser_click_at")
      expect(names(tools)).not.toContain("browser_locate")
    }
    expect(names(selectTools(["core", "vision"]))).toEqual([...names(selectTools()), "browser_click_at"])
    expect(names(selectTools(["core", "vision"], { groundingModel: grounding() }))).toEqual([...names(selectTools()), "browser_click_at", "browser_locate"])
    expect(await callTool(selectTools(), session, "browser_click_at", { x: 1, y: 1 })).toEqual({ text: 'Unknown tool "browser_click_at"', isError: true })
    // The registry's own browser_locate has no model to ask.
    expect(await callTool(TOOLS, session, "browser_locate", { description: "Book" })).toEqual({ text: "browser_locate needs a grounding model (--grounding-model).", isError: true })
  }, 30_000)
})

describe("grounding in the agent", () => {
  it("records each grounding call as a model event and reports its usage apart from the agent's", async () => {
    const groundingModel = grounding(reply('{"x": 300, "y": 240}'))
    const model = scriptedModel([
      () => ({ toolCalls: [{ id: "1", name: "browser_navigate", arguments: { url: `${fixture.url}/canvas` } }], usage: { inputTokens: 10, outputTokens: 2 } }),
      () => ({ toolCalls: [{ id: "2", name: "browser_locate", arguments: { description: "the Book button" } }], usage: { inputTokens: 20, outputTokens: 3 } }),
      (request) => {
        const [, x, y] = /x=(\d+), y=(\d+)/.exec(lastToolText(request.messages)) ?? []
        return { toolCalls: [{ id: "3", name: "browser_click_at", arguments: { x: Number(x), y: Number(y), element: "Book button" } }], usage: { inputTokens: 30, outputTokens: 4 } }
      },
      (request) => ({ text: `${lastToolText(request.messages).includes("Seat booked") ? "Booked the seat." : "Not booked."}\n{"outcome":"succeeded","unfinished":[]}`, toolCalls: [], usage: { inputTokens: 40, outputTokens: 5 } }),
    ])
    const events: AgentEvent[] = []
    const result = await runAgent({ task: "Book the seat", model, browser: session, tools: selectTools(["core", "vision"], { groundingModel }), onEvent: (event) => events.push(event) })

    expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", answer: "Booked the seat.", steps: 4 })
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 14 })
    expect(result.groundingUsage).toEqual(usage)
    // The agent model reads the located point; the screenshot goes only to the grounding model.
    expect(model.requests[2]!.messages.flatMap((message) => message.role === "tool" ? message.content : []).some((part) => part.type === "image")).toBe(false)

    // The grounding call is a model event with its role, written before its step's tool event.
    const stepTwo = events.flatMap((event) => event.type === "model" && event.step === 2 ? [`model:${event.role ?? "agent"}`] : event.type === "tool" && event.step === 2 ? [`tool:${event.call.name}`] : [])
    expect(stepTwo).toEqual(["model:agent", "model:grounding", "tool:browser_locate"])
    const groundingEvent = events.find((event) => event.type === "model" && event.role === "grounding")
    expect(groundingEvent).toEqual({ type: "model", role: "grounding", step: 2, text: '{"x": 300, "y": 240}', toolCalls: [], model: "ui-tars-test", durationMs: expect.any(Number), usage })
    expect(Number.isInteger((groundingEvent as { durationMs: number }).durationMs)).toBe(true)
  }, 30_000)

  it("continues the run after a grounding request fails", async () => {
    const groundingModel = grounding(() => { throw new ModelHttpError(503, "overloaded", "fake-grounding") })
    const model = scriptedModel([
      () => ({ toolCalls: [{ id: "1", name: "browser_locate", arguments: { description: "the Book button" } }] }),
      (request) => ({ text: `${lastToolText(request.messages)}\n{"outcome":"partial","unfinished":["Book the seat"]}`, toolCalls: [] }),
    ])
    const events: AgentEvent[] = []
    const result = await runAgent({ task: "Book the seat", model, browser: session, tools: selectTools(["core", "vision"], { groundingModel }), onEvent: (event) => events.push(event) })
    expect(result).toMatchObject({
      status: "completed", stopReason: "final_answer", steps: 2,
      answer: "The grounding model request failed, so nothing was located: fake-grounding request failed with HTTP 503: overloaded",
    })
    expect(result).not.toHaveProperty("error")
    expect(result).not.toHaveProperty("groundingUsage")
    expect(events.filter((event) => event.type === "model" && event.role === "grounding")).toHaveLength(0)
    expect(events.find((event) => event.type === "tool")).toMatchObject({ result: { isError: true } })
  }, 30_000)

  it("offers browser_click_at without a grounding model and reports no grounding usage", async () => {
    const model = scriptedModel([() => ({ text: 'done\n{"outcome":"succeeded","unfinished":[]}', toolCalls: [] })])
    const result = await runAgent({ task: "t", model, browser: session, tools: selectTools(["core", "vision"]) })
    expect(names(selectTools(["core", "vision"]))).toEqual(model.requests[0]!.tools.map((tool) => tool.name))
    expect(result).not.toHaveProperty("groundingUsage")
  }, 30_000)

  it("serves the same tools over MCP, with the point and usage in structuredContent", async () => {
    const groundingModel = grounding(reply('{"x": 300, "y": 240}'), reply('{"x": 300, "y": 240}'))
    const tools = selectTools(["core", "vision"], { groundingModel })
    const agentModel = scriptedModel([
      () => ({ toolCalls: [{ id: "1", name: "browser_locate", arguments: { description: "the Book button" } }], usage: { inputTokens: 10, outputTokens: 1 } }),
      () => ({ text: 'Located it.\n{"outcome":"succeeded","unfinished":[]}', toolCalls: [], usage: { inputTokens: 20, outputTokens: 2 } }),
    ])
    const server = createMcpServer({ session, tools, agentModel })
    const listed = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect((listed?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([...names(tools), "browser_task"])

    await openCanvas()
    const called = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_locate", arguments: { description: "the Book button" } } })
    expect(called?.result).toEqual({
      content: [{ type: "text", text: "Located the Book button at x=300, y=240. Pass these to browser_click_at." }],
      isError: false,
      structuredContent: { x: 300, y: 240, model: "ui-tars-test", durationMs: expect.any(Number), usage },
    })

    const delegated = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_task", arguments: { task: "Find the Book button" } } })
    const result = delegated?.result as { isError: boolean; content: Array<{ text: string }>; structuredContent: AgentResult }
    expect(result.isError).toBe(false)
    expect(result.content[0]!.text).toContain("tokens: 30 in / 3 out, grounding tokens: 1300 in / 9 out]")
    expect(result.structuredContent).toMatchObject({ usage: { inputTokens: 30, outputTokens: 3 }, groundingUsage: usage })
  }, 30_000)
})

describe("owa with --caps vision", () => {
  const variables = ["OWA_GROUNDING_MODEL", "OWA_GROUNDING_MODEL_OPTIONS", "OWA_GROUNDING_SCALE"]
  const saved = new Map<string, string | undefined>()
  // The reviewer's shell may set these; main() reads them from process.env.
  beforeEach(() => {
    for (const name of variables) {
      saved.set(name, process.env[name])
      delete process.env[name]
    }
  })
  afterEach(() => {
    for (const [name, value] of saved) if (value === undefined) delete process.env[name]
    else process.env[name] = value
  })
  /** Child processes get the environment without OWA_* settings, as the benchmark runner gives them. */
  const childEnv = (extra: Record<string, string> = {}) => ({
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !entry[0].startsWith("OWA_") && entry[1] !== undefined)),
    ...extra,
  })

  it.each([
    [["--grounding-scale=0"], "--grounding-scale / OWA_GROUNDING_SCALE must be a positive number"],
    [["--grounding-scale=-1"], "--grounding-scale / OWA_GROUNDING_SCALE must be a positive number"],
    [["--grounding-scale=abc"], "--grounding-scale / OWA_GROUNDING_SCALE must be a positive number"],
    [["--caps", "visual"], 'Unknown capability "visual"'],
    [["--grounding-model", "ollama:ui-tars", "--grounding-model-options", "{"], "--grounding-model-options / OWA_GROUNDING_MODEL_OPTIONS must be a JSON object"],
    [["--grounding-model-options", "{}"], "needs --grounding-model or OWA_GROUNDING_MODEL"],
    [["--caps", "vision", "--grounding-model", "openrouter:bytedance/ui-tars-1.5-7b"], "needs an API key: set OPENROUTER_API_KEY"],
  ])("rejects %p before running", async (flags, message) => {
    const key = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_API_KEY
    try {
      await expect(main(["run", "task", ...flags])).rejects.toThrow(message)
    } finally {
      if (key !== undefined) process.env.OPENROUTER_API_KEY = key
    }
  })

  it("accepts the vision capability and the grounding settings", async () => {
    // No task, so main stops at the usage check that follows the tool setup.
    await expect(main(["run", "--caps", "core,vision", "--grounding-model", "ollama:ui-tars", "--grounding-scale", "1000"])).rejects.toThrow('Usage: owa run "<task>"')
    // Without the vision capability the grounding model is not resolved, so a missing key does not matter.
    await expect(main(["run", "--grounding-model", "openrouter:bytedance/ui-tars-1.5-7b"])).rejects.toThrow('Usage: owa run "<task>"')
  })

  it("lists browser_locate over stdio MCP only with the capability and a grounding model", async () => {
    const list = async (...flags: string[]) => {
      const client = new Client({ name: "owa-test", version: "0.0.0" })
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "cli.ts"), "mcp", "--headless", ...flags], env: childEnv(), stderr: "inherit" }))
      try {
        return (await client.listTools()).tools.map((tool) => tool.name).filter((name) => ["browser_click_at", "browser_locate"].includes(name))
      } finally {
        await client.close()
      }
    }
    expect(await list("--caps", "vision")).toEqual(["browser_click_at"])
    expect(await list("--caps", "vision", "--grounding-model", "ollama:ui-tars")).toEqual(["browser_click_at", "browser_locate"])
    expect(await list("--grounding-model", "ollama:ui-tars")).toEqual([])
  }, 30_000)

  it("runs a grounding model through owa run, with its usage and trace kept apart", async () => {
    const requests: Array<{ path: string; authorization: string | null; body: Record<string, any> }> = []
    // A local stand-in for OpenRouter's chat completions endpoint.
    const endpoint = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), body: await request.json() as Record<string, any> })
        return Response.json({ model: "bytedance/ui-tars-1.5-7b", choices: [{ message: { content: "click(start_box='(300,240)')" } }], usage: { prompt_tokens: 1300, completion_tokens: 9, cost: 0.00014 } })
      },
    })
    const directory = await mkdtemp(join(tmpdir(), "owa-vision-"))
    try {
      const module = join(directory, "model.ts")
      await Bun.write(module, `import { lastToolText, scriptedModel } from ${JSON.stringify(join(import.meta.dir, "testing/scripted-model.ts"))}
export default () => scriptedModel([
  () => ({ toolCalls: [{ id: "1", name: "browser_navigate", arguments: { url: ${JSON.stringify(`${fixture.url}/canvas`)} } }] }),
  () => ({ toolCalls: [{ id: "2", name: "browser_locate", arguments: { description: "the Book button" } }] }),
  (request) => {
    const [, x, y] = /x=(\\d+), y=(\\d+)/.exec(lastToolText(request.messages)) ?? []
    return { toolCalls: [{ id: "3", name: "browser_click_at", arguments: { x: Number(x), y: Number(y) } }] }
  },
  (request) => ({ text: (lastToolText(request.messages).includes("Seat booked") ? "Booked the seat." : "Not booked.") + '\\n{"outcome":"succeeded","unfinished":[]}', toolCalls: [] }),
])
`)
      const trace = join(directory, "trace.jsonl")
      const proc = Bun.spawn([
        process.execPath, "--preload", join(import.meta.dir, "testing/redirect-fetch.ts"), join(import.meta.dir, "cli.ts"),
        "run", "Book the seat", "--json", "--headless", "--model-module", module, "--trace", trace,
        "--caps", "vision", "--grounding-model", "openrouter:bytedance/ui-tars-1.5-7b", "--grounding-model-options", '{"temperature":0}',
      ], {
        // Role models take no base URL, so a preloaded helper sends the adapter's requests to the local endpoint.
        env: childEnv({ OPENROUTER_API_KEY: "test-key", OWA_TEST_FETCH_FROM: "https://openrouter.ai/api/v1", OWA_TEST_FETCH_TO: `http://127.0.0.1:${endpoint.port}/v1` }),
        stdout: "pipe", stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      expect({ code, stderr }).toMatchObject({ code: 0 })
      expect(stderr).toContain("  grounding: click(start_box='(300,240)')\n")
      expect(stderr).toContain("(tokens in 0, out 0; grounding in 1300, out 9)")
      expect(JSON.parse(stdout)).toMatchObject({ answer: "Booked the seat.", usage: { inputTokens: 0, outputTokens: 0 }, groundingUsage: usage })

      // One OpenAI-format request without tools, with the grounding model's own key and options.
      expect(requests).toHaveLength(1)
      const [request] = requests
      expect(request).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer test-key", body: { model: "bytedance/ui-tars-1.5-7b", temperature: 0 } })
      expect(request!.body).not.toHaveProperty("tools")
      expect(request!.body.messages[0]).toMatchObject({ role: "system" })
      expect(request!.body.messages[1].content).toMatchObject([
        { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } },
        { type: "text", text: "Element: the Book button" },
      ])

      const events = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      expect(events.filter((event) => event.type === "model" && event.role === "grounding")).toMatchObject([
        { step: 2, text: "click(start_box='(300,240)')", model: "bytedance/ui-tars-1.5-7b", toolCalls: [], usage },
      ])
    } finally {
      endpoint.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
