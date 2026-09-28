import { expect, it } from "bun:test"
import { join } from "node:path"
import { evaluateCase, EVALUATION_CASES, summarize } from "./evaluation"
import { refFor, startFixtureServer } from "./fixture"
import { lastToolText, scriptedModel } from "./scripted-model"

it("scores observed browser state and the answer rather than a success claim", async () => {
  const fixture = startFixtureServer()
  try {
    for (const [answer, passed] of [["$42 per month", true], ["$99 per month", false]] as const) {
      const model = scriptedModel([
        () => ({ toolCalls: [{ id: "1", name: "browser_navigate", arguments: { url: `${fixture.url}/pricing` } }], usage: { inputTokens: 10, outputTokens: 2 } }),
        () => ({ text: JSON.stringify({ answer, outcome: "succeeded", unfinished: [] }), toolCalls: [] }),
      ])
      const run = await evaluateCase(EVALUATION_CASES[0], model, fixture.url)
      expect(run.passed).toBe(passed)
      expect(run.checks.pricingVisited).toBe(true)
      expect(summarize([run])).toMatchObject({ runs: 1, passed: Number(passed), toolCalls: 1, inputTokens: 10, outputTokens: 2 })
    }
    const fabricated = await evaluateCase(EVALUATION_CASES[0], scriptedModel([() => ({ text: "$42 per month", toolCalls: [] })]), fixture.url)
    expect(fabricated.passed).toBe(false)
    expect(fabricated.checks.pricingVisited).toBe(false)
  } finally { fixture.stop() }
})

it("keeps an evaluation failure in the report instead of losing the batch", async () => {
  const run = await evaluateCase(EVALUATION_CASES[1], scriptedModel([() => { throw new Error("fake model unavailable") }]), "http://127.0.0.1")
  expect(run.passed).toBe(false)
  expect(run.result?.stopReason).toBe("model_error")
  expect(run.result?.error).toBe("fake model unavailable")
})

it("requires explicit live opt-in before resolving a model or launching a browser", async () => {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../../scripts/evaluate.ts")], { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" })
  const stderr = await new Response(proc.stderr).text()
  expect(await proc.exited).toBe(1)
  expect(stderr).toContain("Pass --live")
})


it("checks form, async and recovery tasks against actual browser state", async () => {
  const fixture = startFixtureServer()
  const tool = (id: string, name: string, args: Record<string, unknown>) => ({ toolCalls: [{ id, name, arguments: args }] })
  try {
    for (const id of ["search-filter", "async-result", "ref-recovery"]) {
      const script: Parameters<typeof scriptedModel>[0] = [() => tool("1", "browser_navigate", { url: fixture.url + (id === "async-result" ? "/async" : "/") })]
      if (id === "async-result") {
        script.push(req => tool("2", "browser_click", { ref: refFor(lastToolText(req.messages), /button "Start lookup"/) }),
          () => tool("3", "browser_wait_for", { text: "READY-314" }), () => ({ text: "READY-314", toolCalls: [] }))
      } else {
        if (id === "ref-recovery") script.push(() => tool("2", "browser_click", { ref: "e999999" }), () => tool("3", "browser_snapshot", {}))
        const query = id === "ref-recovery" ? "recovered" : "evaluation-query"
        script.push(req => tool("4", "browser_type", { ref: refFor(lastToolText(req.messages), /textbox "Search"/), text: query }),
          req => tool("5", "browser_click", { ref: refFor(lastToolText(req.messages), /button "Search"/) }))
        if (id === "search-filter") script.push(req => tool("6", "browser_select_option", { ref: refFor(lastToolText(req.messages), /combobox "Plan"/), values: ["pro"] }))
        script.push(() => ({ text: query, toolCalls: [] }))
      }
      const result = await evaluateCase(EVALUATION_CASES.find(c => c.id === id)!, scriptedModel(script), fixture.url)
      expect(result.passed).toBe(true)
      expect(result.toolErrors).toBe(id === "ref-recovery" ? 1 : 0)
    }
  } finally { fixture.stop() }
}, 30_000)
