import { expect, it } from "bun:test"
import { z } from "zod"
import { type AgentOptions, runAgent } from "./agent"
import { BrowserSession } from "./browser"
import type { ModelRequest, ModelResponse } from "./model/types"
import { scriptedModel } from "./testing/scripted-model"
import type { BrowserTool } from "./tools"

type Reply = (request: ModelRequest) => ModelResponse | Promise<ModelResponse>

const note = "Saw two prices so far"
const stops = {
  no_progress: { notice: "made no progress", fallback: note, error: "Stopped after repeated identical actions and page state" },
  tool_failures: { notice: "every browser action failed in the last 3 steps", fallback: "Stopped after 3 consecutive steps where every browser action failed.", error: undefined },
}

/** Three steps that stop the run: the same click on an unchanged page, or clicks on a ref that does not exist. */
async function stoppedRun(stopReason: keyof typeof stops, final: Reply, options: Pick<AgentOptions, "signal" | "timeoutMs"> & { note?: string } = {}) {
  const tool: BrowserTool = { name: "browser_click", description: "test", schema: z.object({ ref: z.string() }), readOnly: false, capability: "core", async run(_session, { ref }) {
    if (stopReason === "tool_failures") throw new Error(`No element matches ref ${ref}`)
    return { text: `Clicked ${ref}`, snapshot: 'button "Next" [ref=e1]' }
  } }
  const click = (text?: string) => () => ({ text, toolCalls: [{ id: "1", name: "browser_click", arguments: { ref: stopReason === "no_progress" ? "e1" : "e999" } }] })
  const model = scriptedModel([click(options.note), click(), click(), final])
  const result = await runAgent({ task: "t", browser: new BrowserSession({ headless: true }), model, tools: [tool], signal: options.signal, timeoutMs: options.timeoutMs })
  return { model, result }
}

it.each(["no_progress", "tool_failures"])("asks once without tools for a best-effort answer after %s", async stopReason => {
  const { model, result } = await stoppedRun(stopReason, () => ({
    text: 'The first two prices are $10 and $12.\n{"outcome":"partial","unfinished":["Find the third price"]}',
    toolCalls: [],
    usage: { inputTokens: 5, outputTokens: 2 },
  }))
  expect(result).toMatchObject({
    status: "failed", stopReason, steps: 3, answer: "The first two prices are $10 and $12.", usage: { inputTokens: 5, outputTokens: 2 },
    outcome: { status: "partial", verification: "unverified", unfinished: ["Find the third price"] },
  })
  expect(result.error).toBe(stops[stopReason].error)
  // One extra tool-less request that says why the run stopped and asks for the outcome line.
  expect(model.requests.map(request => request.tools.length > 0)).toEqual([true, true, true, false])
  const notice = model.requests[3]!.messages.at(-1)
  const text = notice?.role === "user" && notice.content[0]?.type === "text" ? notice.content[0].text : ""
  expect(text).toContain(stops[stopReason].notice)
  expect(text).toContain("succeeded|partial|blocked")
})

const unusableReplies: Array<[string, Reply]> = [
  ["fails", () => { throw new Error("HTTP 503") }],
  ["is empty", () => ({ toolCalls: [] })],
  ["only calls tools", () => ({ toolCalls: [{ id: "4", name: "browser_click", arguments: { ref: "e1" } }] })],
]

it.each(unusableReplies)("falls back to the earlier answer when the best-effort reply %s", async (_reply, final) => {
  for (const stopReason of ["no_progress", "tool_failures"] as const) {
    const { model, result } = await stoppedRun(stopReason, final, { note })
    expect(result).toMatchObject({ status: "failed", stopReason, steps: 3, answer: stops[stopReason].fallback, outcome: { status: "unknown", unfinished: [] } })
    expect(result.error).toBe(stops[stopReason].error)
    expect(model.requests).toHaveLength(4)
  }
})

it("falls back when the deadline or cancellation interrupts the best-effort request", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController()
    let signal: AbortSignal | undefined
    const { model, result } = await stoppedRun("no_progress", request => {
      signal = request.signal
      if (cancel) controller.abort(new Error("Cancelled"))
      // Simulate an adapter that ignores abort; runAgent must stop waiting.
      return new Promise(() => {})
    }, { note, signal: controller.signal, timeoutMs: cancel ? 5_000 : 200 })
    expect(signal?.aborted).toBe(true)
    expect(result).toMatchObject({ status: "failed", stopReason: "no_progress", answer: note, error: stops.no_progress.error })
    expect(model.requests).toHaveLength(4)
  }
})
