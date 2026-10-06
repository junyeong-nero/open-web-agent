import { expect, it } from "bun:test"
import { join } from "node:path"
import { z } from "zod"
import { type AgentEvent, type AgentOptions, type Escalation, runAgent } from "./agent"
import { BrowserSession } from "./browser"
import { createMcpServer } from "./mcp"
import { resolveModel, roleModelConfig } from "./model/resolve"
import type { ModelRequest, ModelResponse, Usage } from "./model/types"
import { scriptedModel } from "./testing/scripted-model"
import type { BrowserTool } from "./tools"

type Reply = (request: ModelRequest) => ModelResponse

/** browser_click whose page after the nth click is `page(n)`; an Error fails the click. */
function clickTool(page: (click: number) => string | Error): BrowserTool {
  let clicks = 0
  return {
    name: "browser_click", description: "test", schema: z.object({ ref: z.string() }), readOnly: false, capability: "core",
    async run(_session, { ref }) {
      const next = page(++clicks)
      if (next instanceof Error) throw next
      return { text: `Clicked ${ref}`, snapshot: next }
    },
  }
}
const stuck = () => 'button "Next" [ref=e1]'
const failing = () => new Error("No element matches ref e1")
const moving = (click: number) => `button "Next ${click}" [ref=e1]`

const weakUsage = { inputTokens: 10, outputTokens: 1 }
const strongUsage = { inputTokens: 100, outputTokens: 5, cost: 0.01 }
const click = (usage: Usage): Reply => () => ({ toolCalls: [{ id: "c", name: "browser_click", arguments: { ref: "e1" } }], usage })
const reply = (text: string, usage: Usage, outcome = "succeeded"): Reply => () => ({ text: `${text}\n{"outcome":"${outcome}","unfinished":[]}`, toolCalls: [], usage })
const replies = (count: number, next: Reply) => Array<Reply>(count).fill(next)

/** Runs the first model's script, and the escalation model's when one is given (named "strong"). */
async function run(tool: BrowserTool, weak: Reply[], strong?: Reply[], options: Pick<AgentOptions, "maxSteps" | "maxRepeatedSteps"> = {}) {
  const model = scriptedModel(weak)
  const escalateModel = strong && { ...scriptedModel(strong), name: "strong" }
  const events: AgentEvent[] = []
  const result = await runAgent({ task: "t", browser: new BrowserSession({ headless: true }), tools: [tool], model, escalateModel, onEvent: event => events.push(event), ...options })
  return { model, escalateModel, events, result }
}

// signal, page after each click, step of the signal, step budget, note before the remaining steps
const signals: Array<[Escalation["signal"], (click: number) => string | Error, number, number, string]> = [
  ["no_progress", stuck, 3, 30, "The last steps made no progress."],
  ["tool_failures", failing, 3, 30, "Every browser action failed in the last 3 steps."],
  ["step_budget", moving, 4, 6, "4 of 6 steps are used."],
]
const stopReasons = { no_progress: "no_progress", tool_failures: "tool_failures", step_budget: "step_limit" } as const

it.each(signals)("hands the remaining steps and the same transcript to the escalation model on %s", async (signal, page, stalledAt, maxSteps, notice) => {
  const { model, escalateModel, events, result } = await run(clickTool(page), replies(stalledAt, click(weakUsage)), [reply("Done", strongUsage)], { maxSteps })
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: stalledAt + 1, answer: "Done" })
  // `usage` covers both models; the escalation model's share is reported on its own.
  expect(result.usage).toEqual({ inputTokens: 10 * stalledAt + 100, outputTokens: stalledAt + 5 })
  expect(result.escalation).toEqual({ step: stalledAt, signal, model: "strong", usage: strongUsage })
  expect(model.requests).toHaveLength(stalledAt)
  expect(escalateModel!.requests).toHaveLength(1)

  // The escalation model gets what the first model would have been sent next, plus a note.
  const handoff = escalateModel!.requests[0]!
  const reference = await run(clickTool(page), replies(stalledAt + 1, click(weakUsage)), undefined, { maxSteps })
  const next = reference.model.requests[stalledAt]!
  expect(handoff.system).toBe(next.system)
  expect(handoff.tools).toEqual(model.requests[0]!.tools)
  expect(handoff.messages.slice(0, -1)).toEqual(next.messages.slice(0, 1 + 2 * stalledAt))
  expect(handoff.messages.at(-1)).toEqual({
    role: "user",
    content: [{ type: "text", text: `${notice} Remaining steps: ${maxSteps - stalledAt}. If the current approach is not working, try a different one.` }],
  })

  // The trace marks the switch, and the calls after it.
  const kinds = events.map(event => (event.type === "model" && event.role ? `model:${event.role}` : event.type))
  expect(kinds.slice(-5)).toEqual(["tool", "escalate", "step", "model:escalate", "done"])
  expect(kinds.filter(kind => kind === "model")).toHaveLength(stalledAt)
  expect(events.find(event => event.type === "escalate")).toEqual({ type: "escalate", step: stalledAt, signal, model: "strong" })
})

it.each(signals)("does not switch without an escalation model on %s", async (signal, page, stalledAt, maxSteps) => {
  const steps = signal === "step_budget" ? maxSteps : stalledAt
  const { model, events, result } = await run(clickTool(page), [...replies(steps, click(weakUsage)), reply("Best effort", weakUsage, "partial")], undefined, { maxSteps })
  expect(result).toMatchObject({ stopReason: stopReasons[signal], steps, answer: "Best effort" })
  expect(result).not.toHaveProperty("escalation")
  expect(model.requests).toHaveLength(steps + 1)
  expect(model.requests.at(-1)!.tools).toEqual([])
  expect(events.some(event => event.type === "escalate" || (event.type === "model" && event.role))).toBe(false)
})

it.each(signals)("stops when the run stalls again after escalating on %s", async (signal, page, stalledAt, maxSteps) => {
  // Stall counts start fresh, so the escalation model gets the same three steps (or the rest of the budget).
  const strongSteps = signal === "step_budget" ? maxSteps - stalledAt : 3
  const { model, escalateModel, result } = await run(clickTool(page), replies(stalledAt, click(weakUsage)),
    [...replies(strongSteps, click(strongUsage)), reply("Best effort", strongUsage, "partial")], { maxSteps })
  expect(result).toMatchObject({ stopReason: stopReasons[signal], steps: stalledAt + strongSteps, answer: "Best effort" })
  expect(result.escalation).toMatchObject({ step: stalledAt, signal })
  expect(model.requests).toHaveLength(stalledAt)
  // The escalation model also writes the best-effort answer.
  expect(escalateModel!.requests).toHaveLength(strongSteps + 1)
  expect(escalateModel!.requests.at(-1)!.tools).toEqual([])
})

it("escalates on a page revisit cycle, and the escalation model's revisit counts start fresh", async () => {
  const navigate: BrowserTool = {
    name: "browser_navigate", description: "test", schema: z.object({ url: z.string() }), readOnly: false, capability: "core",
    async run(_session, { url }) {
      return { text: `Navigated to ${url}`, snapshot: `Page URL: ${url}\nPage title: ${url}\nPage tab: t1\nSnapshot:\n- paragraph: Content of ${url}` }
    },
  }
  const go = (url: string): Reply => () => ({ toolCalls: [{ id: "n", name: "browser_navigate", arguments: { url } }] })
  const cycle = ["a", "b", "a", "b", "a", "b", "a", "b", "a"].map(page => go(`https://site.test/${page}`))
  const { result } = await run(navigate, cycle, [go("https://site.test/a"), reply("Done", strongUsage)])
  expect(result).toMatchObject({ stopReason: "final_answer", steps: 11, escalation: { step: 9, signal: "no_progress" } })
})

it("stops as before when a stall leaves no step to hand over", async () => {
  const { escalateModel, result } = await run(clickTool(stuck), [...replies(2, click(weakUsage)), reply("Best effort", weakUsage, "partial")], [], { maxSteps: 2, maxRepeatedSteps: 2 })
  expect(result).toMatchObject({ stopReason: "no_progress", steps: 2, answer: "Best effort" })
  expect(result).not.toHaveProperty("escalation")
  expect(escalateModel!.requests).toHaveLength(0)
})

it("escalates to the same model when only its options differ", async () => {
  const bodies: Array<{ model: string; reasoning_effort?: string }> = []
  const endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      bodies.push(await request.json())
      const message = bodies.length <= 3
        ? { content: null, tool_calls: [{ id: `c${bodies.length}`, type: "function", function: { name: "browser_click", arguments: '{"ref":"e1"}' } }] }
        : { content: 'Done\n{"outcome":"succeeded","unfinished":[]}' }
      return Response.json({ model: "gpt-6-luna", choices: [{ message }] })
    },
  })
  try {
    const local = { api: "openai" as const, baseUrl: `http://127.0.0.1:${endpoint.port}` }
    const model = await resolveModel({ model: "gpt-6-luna", extraBody: { reasoning_effort: "none" }, ...local }, {})
    const escalate = roleModelConfig("escalate", { model: "gpt-6-luna", options: '{"reasoning_effort":"medium"}' }, {})!
    const escalateModel = await resolveModel({ ...escalate, ...local }, {})
    const result = await runAgent({ task: "t", browser: new BrowserSession({ headless: true }), tools: [clickTool(stuck)], model, escalateModel })
    expect(result).toMatchObject({ stopReason: "final_answer", answer: "Done", escalation: { step: 3, signal: "no_progress", model: "openai-chat:gpt-6-luna" } })
    expect(bodies.map(body => [body.model, body.reasoning_effort])).toEqual([...Array(3).fill(["gpt-6-luna", "none"]), ["gpt-6-luna", "medium"]])
  } finally { endpoint.stop(true) }
})

it("hands a stalled browser_task to the MCP server's escalation model", async () => {
  const server = createMcpServer({
    session: new BrowserSession({ headless: true }), tools: [clickTool(stuck)],
    agentModel: scriptedModel(replies(3, click(weakUsage))), agentEscalateModel: { ...scriptedModel([reply("Done", strongUsage)]), name: "strong" },
  })
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_task", arguments: { task: "t" } } })
  expect((response?.result as { structuredContent: unknown }).structuredContent).toMatchObject({
    stopReason: "final_answer", answer: "Done", escalation: { step: 3, signal: "no_progress", model: "strong", usage: strongUsage },
  })
})

it("reads --escalate-model and its options before the environment", () => {
  const env = { OWA_ESCALATE_MODEL: "openai:gpt-6-sol", OWA_ESCALATE_MODEL_OPTIONS: '{"reasoning_effort":"high"}' }
  expect(roleModelConfig("escalate", {}, {})).toBeUndefined()
  expect(roleModelConfig("escalate", {}, env)).toEqual({ model: "openai:gpt-6-sol", extraBody: { reasoning_effort: "high" } })
  expect(roleModelConfig("escalate", { model: "openai:gpt-6-luna", options: '{"reasoning_effort":"medium"}' }, env))
    .toEqual({ model: "openai:gpt-6-luna", extraBody: { reasoning_effort: "medium" } })
  // As with --model-options, the flag's object replaces the environment's, and {} clears it.
  expect(roleModelConfig("escalate", { options: "{}" }, env)).toEqual({ model: "openai:gpt-6-sol", extraBody: {} })
  // An empty model turns escalation off.
  expect(roleModelConfig("escalate", { model: "" }, env)).toBeUndefined()
})

it("rejects escalation options that are invalid or have no model, without echoing them", () => {
  for (const options of ["invalid secret-token", "[]", '"secret-token"']) {
    const parse = () => roleModelConfig("escalate", { model: "openai:gpt-6-sol", options }, {})
    expect(parse).toThrow("--escalate-model-options / OWA_ESCALATE_MODEL_OPTIONS must be a JSON object")
    try { parse() } catch (error) { expect(String(error)).not.toContain("secret-token") }
  }
  expect(() => roleModelConfig("escalate", { model: "openai:gpt-6-sol", options: '{"model":"secret-token"}' }, {})).toThrow('cannot set "model"')
  expect(() => roleModelConfig("escalate", {}, { OWA_ESCALATE_MODEL_OPTIONS: "{}" })).toThrow("need --escalate-model or OWA_ESCALATE_MODEL")
})

it.each([["run", "t"], ["mcp", "--agent"]])("checks the escalation model before any model request: %s %s", async (...command) => {
  let requests = 0
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests++
    return Response.json({ choices: [{ message: { content: "done" } }] })
  } })
  const cli = async (args: string[], env: Record<string, string> = {}) => {
    const proc = Bun.spawn([
      process.execPath, join(import.meta.dir, "cli.ts"), ...command, "--model", "local", "--api", "openai", "--base-url", `http://127.0.0.1:${endpoint.port}`, ...args,
    ], { env: { PATH: process.env.PATH, ...env }, stdin: "ignore", stdout: "ignore", stderr: "pipe" })
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    return { code, stderr }
  }
  try {
    // Only a provider shorthand and that provider's key apply; this environment has no key.
    expect(await cli(["--escalate-model", "openai:gpt-6-sol"])).toMatchObject({ code: 1, stderr: expect.stringContaining("set OPENAI_API_KEY") })
    const invalid = await cli(["--escalate-model", "openai:gpt-6-sol", "--escalate-model-options", "invalid secret-token"])
    expect(invalid).toMatchObject({ code: 1, stderr: expect.stringContaining("--escalate-model-options / OWA_ESCALATE_MODEL_OPTIONS must be a JSON object") })
    expect(invalid.stderr).not.toContain("secret-token")
    expect(await cli([], { OWA_ESCALATE_MODEL_OPTIONS: "{}" })).toMatchObject({ code: 1, stderr: expect.stringContaining("need --escalate-model") })
    expect(requests).toBe(0)
  } finally { endpoint.stop(true) }
})
