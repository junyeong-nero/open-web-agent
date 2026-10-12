import { expect, it } from "bun:test"
import { z } from "zod"
import { runAgent } from "./agent"
import { BrowserSession } from "./browser"
import { anthropicMessages } from "./model/anthropic"
import type { FetchLike } from "./model/types"
import { scriptedModel } from "./testing/scripted-model"
import type { BrowserTool } from "./tools"

const snapshot = (url: string) => `Page URL: https://shop.test/${url}\nPage title: ${url}\nPage tab: t1\nSnapshot:\n- heading "${url}" [level=1] [ref=e1]`
const navigate: BrowserTool = {
  name: "browser_navigate", description: "test", schema: z.object({ url: z.string() }), readOnly: false, capability: "core",
  async run(_, { url }) { return { text: `Navigated to ${url}`, snapshot: snapshot(url) } },
}
const go = (id: string, url: string) => () => ({ toolCalls: [{ id, name: "browser_navigate", arguments: { url } }] })
const answer = () => ({ text: 'Done.\n{"outcome":"succeeded","unfinished":[]}', toolCalls: [] })

it("gives every request of a run one cache key, its judge and checker keys derived from it, and each run its own", async () => {
  const run = async () => {
    const model = scriptedModel([go("1", "a"), go("2", "b"), answer])
    const judgeModel = scriptedModel([() => ({ text: '{"supported":0.9}', toolCalls: [] })])
    const checkerModel = scriptedModel([() => ({ text: '{"label":"content"}', toolCalls: [] }), () => ({ text: '{"label":"content"}', toolCalls: [] })])
    await runAgent({ task: "t", model, judgeModel, checkerModel, browser: new BrowserSession({ headless: true }), tools: [navigate] })
    return { model, judgeModel, checkerModel }
  }
  const first = await run()
  const key = first.model.requests[0]!.cacheKey
  expect(key).toMatch(/^[\da-f-]{36}$/)
  expect(first.model.requests.map((request) => request.cacheKey)).toEqual([key, key, key])
  expect(first.judgeModel.requests.map((request) => request.cacheKey)).toEqual([`${key}:judge`])
  expect(first.checkerModel.requests.map((request) => request.cacheKey)).toEqual([`${key}:checker`, `${key}:checker`])
  expect((await run()).model.requests[0]!.cacheKey).not.toBe(key)
})

it("lets the next request read back the conversation an Anthropic request cached when each step brings a new snapshot", async () => {
  const model = scriptedModel([go("1", "a"), go("2", "b"), go("3", "c"), go("4", "d"), go("5", "e"), answer])
  await runAgent({ task: "t", model, browser: new BrowserSession({ headless: true }), tools: [navigate] })
  const bodies: any[] = []
  const fetchImpl: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)))
    return Response.json({ content: [{ type: "text", text: "ok" }] })
  }
  const adapter = anthropicMessages({ model: "claude", fetch: fetchImpl })
  for (const request of model.requests) await adapter.complete(request)
  const unmarked = (value: unknown) => JSON.parse(JSON.stringify(value, (key, field) => (key === "cache_control" ? undefined : field)))
  const breakpoints = bodies.map((body) => body.messages.findLastIndex((message: any) => message.content.some((block: any) => block.cache_control)))
  // A first request caches only the system prompt and tools; later ones also the turns before the newest.
  expect(breakpoints).toEqual([-1, 1, 3, 5, 7, 9])
  for (const [index, body] of bodies.slice(1, -1).entries()) {
    const next = bodies[index + 2]
    const end = breakpoints[index + 1]! + 1
    // Everything up to the breakpoint reaches the next request unchanged, so the entry written there is read back.
    expect(unmarked(next.messages.slice(0, end))).toEqual(unmarked(body.messages.slice(0, end)))
    expect(next.system).toEqual(body.system)
    expect(next.tools).toEqual(body.tools)
  }
})
