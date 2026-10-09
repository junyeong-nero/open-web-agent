import { expect, it } from "bun:test"
import { runAgent } from "./agent"
import { BrowserSession } from "./browser"
import { createMcpServer } from "./mcp"
import { scriptedModel } from "./testing/scripted-model"

const answer = () => ({ text: 'Done\n{"outcome":"succeeded","unfinished":[]}', toolCalls: [] })

it("fixes the date for the whole run and shares it with the judge before any page opens", async () => {
  const now = new Date("2026-10-09T16:30:00Z")
  const model = scriptedModel([
    () => {
      now.setUTCDate(11)
      return { toolCalls: [{ id: "1", name: "missing", arguments: {} }] }
    },
    answer,
  ])
  const judgeModel = scriptedModel([() => ({ text: '{"supported":0.9}', toolCalls: [] })])
  const result = await runAgent({ task: "t", browser: new BrowserSession(), model, judgeModel, now, timeZone: "Asia/Seoul" })
  expect(result.outcome.verification).toBe("judged")
  expect(model.requests).toHaveLength(2)
  expect(judgeModel.requests).toHaveLength(1)
  for (const request of [...model.requests, ...judgeModel.requests]) {
    expect(request.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringContaining("Today is Saturday, 2026-10-10 (Asia/Seoul).\n\nTask: t\n\n") }] })
  }
  expect(model.requests[0]!.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "Today is Saturday, 2026-10-10 (Asia/Seoul).\n\nTask: t\n\nThe browser has not opened any page yet." }] })
})

it("computes a new local date on each run", async () => {
  for (const [timeZone, expected] of [["Asia/Seoul", "Saturday, 2026-10-10"], ["America/Los_Angeles", "Friday, 2026-10-09"]]) {
    const model = scriptedModel([answer])
    await runAgent({ task: "t", browser: new BrowserSession(), model, now: new Date("2026-10-09T16:30:00Z"), timeZone })
    expect(model.requests[0]!.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringContaining(`Today is ${expected} (${timeZone}).\n\nTask: t`) }] })
  }
})

it("includes today's date in browser_task requests with the default clock", async () => {
  const model = scriptedModel([answer])
  const server = createMcpServer({ session: new BrowserSession(), tools: [], agentModel: model })
  await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_task", arguments: { task: "t" } } })
  expect(model.requests).toHaveLength(1)
  const first = model.requests[0]!.messages[0]
  const text = first?.role === "user" && first.content[0]?.type === "text" && first.content[0].text
  expect(text).toMatch(/^Today is [A-Za-z]+, \d{4}-\d{2}-\d{2} \(.+\)\.\n\nTask: t\n/)
  expect(text).toContain(`(${Intl.DateTimeFormat().resolvedOptions().timeZone}).`)
})
