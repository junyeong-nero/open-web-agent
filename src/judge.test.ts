import { afterAll, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { z } from "zod"
import { type AgentEvent, type AgentOptions, type AgentResult, runAgent, taskIncomplete } from "./agent"
import { BrowserSession } from "./browser"
import { JUDGE_PROMPT, judgeRequest, parseVerdict, relevantLines } from "./judge"
import { createMcpServer } from "./mcp"
import { resolveModel, roleModelConfig } from "./model/resolve"
import { ModelHttpError, type ModelRequest, type ModelResponse } from "./model/types"
import { startFixtureServer } from "./testing/fixture"
import { scriptedModel } from "./testing/scripted-model"
import type { BrowserTool } from "./tools"

type Reply = (request: ModelRequest) => ModelResponse | Promise<ModelResponse>

const fixture = startFixtureServer()
afterAll(() => fixture.stop())

const dateLine = "Today is Saturday, 2026-10-10 (Asia/Seoul)."
const clock = { now: new Date("2026-10-09T16:30:00Z"), timeZone: "Asia/Seoul" }

const price = "The Pro plan costs $42 per month."
const reply = (text: string, outcome = "succeeded"): Reply => () => ({ text: `${text}\n{"outcome":"${outcome}","unfinished":[]}`, toolCalls: [], usage: { inputTokens: 1000, outputTokens: 20 } })
const read: Reply = () => ({ toolCalls: [{ id: "r", name: "browser_get_text", arguments: {} }], usage: { inputTokens: 1000, outputTokens: 5 } })
const verdict = (supported: unknown, reason?: string): Reply => () => ({ text: JSON.stringify({ reason, supported }), toolCalls: [], usage: { inputTokens: 100, outputTokens: 10 } })
/** browser_get_text on a page that says `text`, without a browser. */
const readPage = (text: string): BrowserTool => ({ name: "browser_get_text", description: "test", schema: z.object({}), readOnly: true, capability: "core", async run() { return { pageText: true, text } } })
const userText = (request: ModelRequest) => request.messages.flatMap((message) => message.role === "user" ? message.content : []).map((part) => part.type === "text" ? part.text : "").join("\n")
const judgeEvents = (events: AgentEvent[]) => events.filter((event) => event.type === "model" && event.role === "judge")
const unsupported = "A check against the page evidence found the answer unsupported."

/** Runs the agent's script on a page that says `price`, with a judge model named "fake-judge" when a judge script is given. */
async function run(agent: Reply[], judge?: Reply[], options: Partial<AgentOptions> = {}) {
  const model = scriptedModel(agent)
  const judgeModel = judge && { ...scriptedModel(judge), name: "fake-judge" }
  const events: AgentEvent[] = []
  const result = await runAgent({
    task: "Find the Pro price", model, judgeModel, browser: new BrowserSession({ headless: true }), tools: [readPage(price)], onEvent: (event) => events.push(event), ...options,
  })
  return { model, judgeModel, events, result }
}

it("sends a wrong answer on the pricing page back once and judges the corrected answer", async () => {
  const browser = new BrowserSession({ headless: true })
  try {
    const task = `Find the Pro plan price on ${fixture.url}/pricing`
    const { model, judgeModel, events, result } = await run([
      () => ({ toolCalls: [{ id: "1", name: "browser_navigate", arguments: { url: `${fixture.url}/pricing` } }], usage: { inputTokens: 1000, outputTokens: 5 } }),
      reply("The Pro plan costs $24 per month."),
      read,
      reply(price),
    ], [
      () => ({ text: '{"reason":"The page says $42 per month, not $24.","supported":0.05}', toolCalls: [], model: "judge-v1", usage: { inputTokens: 300, outputTokens: 20 } }),
      () => ({ text: '```json\n{"reason":"The page text shows $42 per month.","supported":0.97}\n```', toolCalls: [], usage: { inputTokens: 320, outputTokens: 18 } }),
    ], { task, browser, tools: undefined, ...clock })

    expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", answer: price, steps: 4 })
    expect(result.outcome).toEqual({
      status: "succeeded", verification: "judged", unfinished: [], judge: { model: "fake-judge", supported: 0.97, reason: "The page text shows $42 per month." },
    })
    // The judge's tokens are reported apart from the agent's.
    expect(result.judgeUsage).toEqual({ inputTokens: 620, outputTokens: 38 })
    expect(result.usage).toEqual({ inputTokens: 4000, outputTokens: 50 })
    expect(result).not.toHaveProperty("judgeError")

    // One tool-less request per answer: the task, the answer without its outcome line, and the page it rests on.
    const [first, second] = judgeModel!.requests
    expect(judgeModel!.requests).toHaveLength(2)
    expect(first).toMatchObject({ system: JUDGE_PROMPT, tools: [] })
    expect(first!.messages).toHaveLength(1)
    expect(userText(first!)).toStartWith(`${dateLine}\n\nTask: ${task}\n\nAnswer: The Pro plan costs $24 per month.\n\nLatest page snapshot:\nPage URL: ${fixture.url}/pricing`)
    expect(userText(first!)).toContain(price)
    expect(userText(first!)).not.toContain("[ref=")
    expect(userText(first!)).not.toContain('"outcome"')
    expect(userText(second!)).toContain(`Answer: ${price}\n\nText the agent read last:\n`)

    // The agent hears why its answer was sent back, with its tools still offered.
    expect(model.requests).toHaveLength(4)
    const sentBack = model.requests[2]!
    expect(sentBack.tools.length).toBeGreaterThan(0)
    expect(sentBack.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: `${unsupported} Reason: The page says $42 per month, not $24.\nVerify the facts in the browser, then reply with your corrected final answer and the outcome line.` }],
    })

    // Each judge call is a model event marked with its role, at the step of the answer it judged.
    expect(judgeEvents(events)).toMatchObject([
      { type: "model", role: "judge", step: 2, model: "judge-v1", usage: { inputTokens: 300, outputTokens: 20 } },
      { type: "model", role: "judge", step: 4, usage: { inputTokens: 320, outputTokens: 18 } },
    ])
    expect(events.filter((event) => event.type === "model" && !event.role)).toHaveLength(4)
  } finally {
    await browser.close()
  }
}, 30_000)

it("keeps a wrong succeeded answer unverified without a judge model", async () => {
  const { model, events, result } = await run([read, reply("The Pro plan costs $24 per month.")])
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", answer: "The Pro plan costs $24 per month." })
  expect(result.outcome).toEqual({ status: "succeeded", verification: "unverified", unfinished: [] })
  expect(result).not.toHaveProperty("judgeUsage")
  expect(result).not.toHaveProperty("judgeError")
  expect(model.requests).toHaveLength(2)
  expect(judgeEvents(events)).toHaveLength(0)
})

it.each([
  [false, "The page says $42 per month.", `${unsupported} Reason: The page says $42 per month.`],
  [0, undefined, unsupported],
])("marks an unsupported answer partial when no step is left (supported: %p)", async (supported, reason, finding) => {
  const { model, judgeModel, result } = await run([read, reply("The Pro plan costs $24 per month.")], [verdict(supported, reason)], { maxSteps: 2 })
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 2, answer: "The Pro plan costs $24 per month." })
  expect(result.outcome).toEqual({ status: "partial", verification: "judged", unfinished: [finding], judge: { model: "fake-judge", supported: 0, ...(reason ? { reason } : {}) } })
  expect(taskIncomplete(result)).toBe(true)
  expect(model.requests).toHaveLength(2)
  expect(judgeModel!.requests).toHaveLength(1)
})

it("marks the corrected answer partial when the judge rejects it too", async () => {
  const { model, judgeModel, result } = await run(
    [read, reply("The Pro plan costs $24 per month."), reply("It is $24 per month.")],
    [verdict(0.1, "The page says $42."), verdict(0.15, "Still not $42.")],
    { maxSteps: 10 },
  )
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 3, answer: "It is $24 per month." })
  expect(result.outcome).toMatchObject({ status: "partial", verification: "judged", unfinished: [`${unsupported} Reason: Still not $42.`] })
  expect(model.requests).toHaveLength(3)
  expect(judgeModel!.requests).toHaveLength(2)
})

it.each([[1, "succeeded"], [0.21, "succeeded"], [0.2, "partial"]])("acts only when the judge is sure: supported %p gives %s", async (supported, status) => {
  const { result } = await run([read, reply(price)], [verdict(supported)], { maxSteps: 2 })
  expect(result.outcome).toMatchObject({ status, verification: "judged", judge: { model: "fake-judge", supported } })
})

it("reports the rejected answer as partial when the run ends before a corrected answer", async () => {
  const { result } = await run([read, reply("The Pro plan costs $24 per month."), () => { throw new Error("HTTP 500") }], [verdict(0, "The page says $42.")])
  expect(result).toMatchObject({ status: "failed", stopReason: "model_error", error: "HTTP 500", answer: "The Pro plan costs $24 per month." })
  expect(result.outcome).toEqual({ status: "partial", verification: "unverified", unfinished: [`${unsupported} Reason: The page says $42.`] })
})

const failures: Array<[string, Reply, string]> = [
  ["fails", () => { throw new ModelHttpError(503, "overloaded", "fake-judge") }, "fake-judge request failed with HTTP 503: overloaded"],
  ["replies in prose", () => ({ text: "The answer looks right.", toolCalls: [] }), "fake-judge replied without a verdict"],
  ["replies with nothing", () => ({ toolCalls: [] }), "fake-judge replied without a verdict"],
  ["gives a probability above 1", verdict(1.5), "fake-judge replied without a verdict"],
  ["gives a probability as a string", verdict("0.1"), "fake-judge replied without a verdict"],
  ["gives no probability", verdict(undefined, "Wrong price"), "fake-judge replied without a verdict"],
]

it.each(failures)("leaves the answer and outcome as they were when the judge %s", async (kind, judgeReply, judgeError) => {
  const { model, judgeModel, events, result } = await run([read, reply("The Pro plan costs $24 per month.")], [judgeReply])
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 2, answer: "The Pro plan costs $24 per month.", judgeError })
  expect(result.outcome).toEqual({ status: "succeeded", verification: "unverified", unfinished: [] })
  expect(result).not.toHaveProperty("error")
  expect(model.requests).toHaveLength(2)
  expect(judgeModel!.requests).toHaveLength(1)
  // A reply that came back is in the trace and in judgeUsage; a request that failed is in neither.
  const replied = kind !== "fails"
  expect(judgeEvents(events)).toHaveLength(replied ? 1 : 0)
  expect("judgeUsage" in result).toBe(replied)
})

it("stops waiting for the judge at the task deadline or on cancellation and keeps the answer", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController()
    let judgeSignal: AbortSignal | undefined
    const { result } = await run([reply(price)], [(request) => {
      judgeSignal = request.signal
      if (cancel) controller.abort(new Error("Cancelled"))
      // Simulate an adapter that ignores abort; runAgent must stop waiting.
      return new Promise(() => {})
    }], { signal: controller.signal, timeoutMs: cancel ? 5000 : 100 })
    expect(judgeSignal?.aborted).toBe(true)
    expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 1, answer: price, judgeError: cancel ? "Cancelled" : "Task deadline exceeded" })
    expect(result.outcome).toEqual({ status: "succeeded", verification: "unverified", unfinished: [] })
  }
})

it("judges only a final answer that claims success", async () => {
  const runs: Reply[][] = [
    [reply("Only the Basic price is shown.", "partial")],
    [reply("The site blocked me.", "blocked")],
    // No outcome line, and the follow-up request for one gives nothing usable.
    [() => ({ text: price, toolCalls: [] }), () => ({ text: "", toolCalls: [] })],
    // The answer at the step limit claims success, but the run already reports that it did not finish.
    [read, reply(price)],
  ]
  for (const agent of runs) {
    const { judgeModel, result } = await run(agent, [verdict(0)], { maxSteps: 1 })
    expect(judgeModel!.requests).toHaveLength(0)
    expect(result.outcome.verification).toBe("unverified")
    expect(result).not.toHaveProperty("judgeUsage")
  }
})

it("builds one tool-less judge request from the task, the answer and the newest page content", () => {
  const format = 'Reply with only JSON: {"reason":"<one sentence>","supported":<probability from 0 to 1 that the answer is supported>}'
  expect(judgeRequest("Find the Pro price", "$42", {}, dateLine)).toEqual({
    system: JUDGE_PROMPT,
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: `${dateLine}\n\nTask: Find the Pro price\n\nAnswer: $42\n\nEvidence: none; the agent opened no page.\n\n${format}` }] }],
  })

  // Refs and cursor hints are left out of the snapshot.
  const both = judgeRequest("Find the Pro price", "$42", { text: price, snapshot: '- link "Pricing" [ref=e3] [cursor=pointer]\n- paragraph: The Pro plan costs $42 per month. [ref=e4]' }, dateLine)
  expect(userText(both)).toBe(
    `${dateLine}\n\nTask: Find the Pro price\n\nAnswer: $42\n\nText the agent read last:\n${price}\n\nLatest page snapshot:\n- link "Pricing"\n- paragraph: ${price}\n\n${format}`,
  )

  // A long page is cut to the lines that match the task and the answer.
  const filler = Array.from({ length: 2000 }, (_, index) => `Menu item ${index}`)
  const long = userText(judgeRequest("Find the Pro price", "$42 per month", { text: [...filler.slice(0, 1000), price, ...filler.slice(1000)].join("\n") }, dateLine))
  expect(long).toContain("Text the agent read last (excerpt; … marks skipped lines):\n…\n")
  expect(long).toContain(`\n${price}\n`)
  expect(long.length).toBeLessThan(16_500)
})

it("keeps the lines that match the answer and their neighbors, in page order", () => {
  const menu = Array.from({ length: 200 }, (_, index) => `- link "Dyson deals ${index}"`)
  const product = ['- heading "Dyson Airwrap Origin Multi Styler" [level=2]', "- paragraph: Price: 389,430 KRW", "- paragraph: In stock"]
  const page = [...menu.slice(0, 100), ...product, ...menu.slice(100)].join("\n")
  const query = "Find the lowest Dyson Airwrap price\nThe Dyson Airwrap Origin Multi Styler costs 389,430 KRW."
  // "Dyson" is on every menu line, so it does not count; the heading and the price line share the other terms.
  expect(relevantLines(page, query, 300)).toBe(['…', menu[99], ...product, '…'].join("\n"))
  expect(relevantLines("short page", query, 300)).toBe("short page")
  expect(relevantLines(page, "unrelated words", 50)).toBe(`${page.slice(0, 49)}…`)
})

it("reads a verdict from JSON, fenced JSON, a boolean or a bare probability", () => {
  expect(parseVerdict('{"reason":"The page says $42.","supported":0.05}')).toEqual({ supported: 0.05, reason: "The page says $42." })
  expect(parseVerdict('```json\n{"reason":"Matches.","supported":0.97}\n```')).toEqual({ supported: 0.97, reason: "Matches." })
  expect(parseVerdict('Verdict: {"supported": false, "reason": " Wrong price "}')).toEqual({ supported: 0, reason: "Wrong price" })
  expect(parseVerdict('{"supported":true,"reason":""}')).toEqual({ supported: 1 })
  expect(parseVerdict("0.82")).toEqual({ supported: 0.82 })
  for (const text of [undefined, "", "Looks right.", '{"supported":1.5}', '{"supported":"0.3"}', '{"reason":"x"}', "null", "-0.1", '{"supported":0.5} {"supported":0.1}']) {
    expect(parseVerdict(text)).toBeUndefined()
  }
})

it("reports the judge's verdict and usage in the browser_task result", async () => {
  for (const [supported, status] of [[0.1, "partial"], [0.9, "succeeded"]] as const) {
    const session = new BrowserSession({ headless: true })
    const server = createMcpServer({
      session, tools: [readPage(price)], agentMaxSteps: 2,
      agentModel: scriptedModel([read, reply("The Pro plan costs $24 per month.")]),
      agentJudgeModel: { ...scriptedModel([verdict(supported, "Checked the price.")]), name: "fake-judge" },
    })
    const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_task", arguments: { task: "Find the Pro price" } } })
    const result = response?.result as { isError: boolean; content: Array<{ text: string }>; structuredContent: AgentResult }
    expect(result.isError).toBe(status === "partial")
    expect(result.structuredContent).toMatchObject({
      outcome: { status, verification: "judged", judge: { model: "fake-judge", supported, reason: "Checked the price." } },
      judgeUsage: { inputTokens: 100, outputTokens: 10 },
    })
    const text = result.content[0]!.text
    expect(text).toContain(`outcome: ${status} (judged)`)
    expect(text).toContain("tokens: 2000 in / 25 out, judge tokens: 100 in / 10 out]")
    expect(text.includes(`Unfinished: ${unsupported} Reason: Checked the price.`)).toBe(status === "partial")
    await session.close()
  }
})

it("names the judge's own options flag when its endpoint rejects a reasoning setting", async () => {
  const endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => Response.json({ error: { message: "Unsupported value. Set reasoning_effort to 'none'." } }, { status: 400 }),
  })
  try {
    const local = { api: "openai" as const, baseUrl: `http://127.0.0.1:${endpoint.port}` }
    const judgeModel = await resolveModel({ ...roleModelConfig("judge", { model: "judge", options: '{"reasoning_effort":"low"}' }, {})!, ...local }, {})
    const result = await runAgent({ task: "t", model: scriptedModel([reply(price)]), judgeModel, browser: new BrowserSession({ headless: true }) })
    expect(result.outcome).toEqual({ status: "succeeded", verification: "unverified", unfinished: [] })
    expect(result.judgeError).toContain("openai-chat:judge request failed with HTTP 400")
    expect(result.judgeError).toContain(`Try --judge-model-options '{"reasoning_effort":"none"}' (or OWA_JUDGE_MODEL_OPTIONS)`)
  } finally {
    endpoint.stop(true)
  }
})

it("judges with TypeSafe System One through owa run and owa mcp --agent", async () => {
  const requests: Array<{ path: string; authorization: string | null; body: Record<string, any> }> = []
  // A local stand-in for https://api.typesafe.ai/v1 that approves every answer; this test checks the wiring.
  const endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), body: await request.json() as Record<string, any> })
      return Response.json({ model: "jev-1.13.0", answers: { answer: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 296, output_tokens: 20 } })
    },
  })
  const directory = await mkdtemp(join(tmpdir(), "owa-judge-"))
  try {
    const module = join(directory, "model.ts")
    const text = `${price}\n{"outcome":"succeeded","unfinished":[]}`
    await Bun.write(module, `import { scriptedModel } from ${JSON.stringify(join(import.meta.dir, "testing/scripted-model.ts"))}\nexport default () => scriptedModel([() => ({ text: ${JSON.stringify(text)}, toolCalls: [] })])\n`)
    // Role models take no base URL, so a preloaded helper sends the client's requests to the local endpoint.
    const preload = ["--preload", join(import.meta.dir, "testing/redirect-fetch.ts")]
    const env = { PATH: process.env.PATH ?? "", TYPESAFE_API_KEY: "test-key", OWA_TEST_FETCH_FROM: "https://api.typesafe.ai/v1", OWA_TEST_FETCH_TO: `http://127.0.0.1:${endpoint.port}/v1` }
    const trace = join(directory, "trace.jsonl")

    const proc = Bun.spawn([
      process.execPath, ...preload, join(import.meta.dir, "cli.ts"), "run", "Find the Pro price", "--json", "--model-module", module,
      "--judge-model", "typesafe:jev-latest", "--judge-model-options", '{"tag":"owa-test"}', "--trace", trace,
    ], { env, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect({ code, stderr }).toMatchObject({ code: 0 })
    expect(stderr).toContain("  judge: 0.9\n")
    expect(stderr).toContain("(tokens in 0, out 0; judge in 296, out 20)")
    expect(JSON.parse(stdout)).toMatchObject({
      answer: price,
      outcome: { status: "succeeded", verification: "judged", unfinished: [], judge: { model: "typesafe-systemone:jev-latest", supported: 0.9 } },
      judgeUsage: { inputTokens: 296, outputTokens: 20 },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      path: "/v1/systemone",
      authorization: "Bearer test-key",
      body: { model: "jev-latest", questions: { answer: { type: "noul", instructions: JUDGE_PROMPT } }, tag: "owa-test" },
    })
    expect(requests[0]!.body.state).toStartWith("Today is ")
    expect(requests[0]!.body.state).toContain(`Task: Find the Pro price\n\nAnswer: ${price}\n\nEvidence: none`)
    const events = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(events.filter((event) => event.type === "model" && event.role === "judge")).toMatchObject([{ step: 1, text: "0.9", model: "jev-1.13.0" }])

    // owa mcp --agent reads the judge model from the environment.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...preload, join(import.meta.dir, "cli.ts"), "mcp", "--headless", "--agent", "--model-module", module],
      env: { ...env, OWA_JUDGE_MODEL: "typesafe:jev-latest" },
      stderr: "inherit",
    })
    const client = new Client({ name: "owa-test", version: "0.0.0" })
    await client.connect(transport)
    try {
      const result = await client.callTool({ name: "browser_task", arguments: { task: "Find the Pro price" } })
      const content = (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n")
      expect(result.isError).toBe(false)
      expect(content).toContain("outcome: succeeded (judged)")
      expect(content).toContain("judge tokens: 296 in / 20 out")
      expect(requests).toHaveLength(2)
    } finally {
      await client.close()
    }
  } finally {
    endpoint.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

it.each([["run", "t"], ["mcp", "--agent"]])("checks the judge model's configuration before any model request: %s %s", async (command, argument) => {
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
    // The judge reads its own provider's key; OWA_API_KEY belongs to the main model.
    await fails("set TYPESAFE_API_KEY", ["--judge-model", "typesafe:jev-latest"], { OWA_API_KEY: "secret-token" })
    await fails("set GEMINI_API_KEY", [], { OWA_JUDGE_MODEL: "gemini:gemini-3.1-flash-lite" })
    await fails("--judge-model-options / OWA_JUDGE_MODEL_OPTIONS must be a JSON object", ["--judge-model", "ollama:qwen3:8b", "--judge-model-options", "invalid secret-token"])
    await fails("needs --judge-model or OWA_JUDGE_MODEL", [], { OWA_JUDGE_MODEL_OPTIONS: "{}" })
    expect(requests).toBe(0)
    // An empty flag turns off a judge model set in the environment.
    expect((await cli(["--judge-model", ""], { OWA_JUDGE_MODEL: "typesafe:jev-latest" })).code).toBe(0)
  } finally {
    endpoint.stop(true)
  }
}, 30_000)
