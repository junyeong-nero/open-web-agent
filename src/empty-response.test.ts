import { expect, it } from "bun:test"
import { runAgent, taskIncomplete } from "./agent"
import { BrowserSession } from "./browser"
import { createMcpServer } from "./mcp"
import { anthropicMessages } from "./model/anthropic"
import { openaiChat } from "./model/openai"
import { scriptedModel } from "./testing/scripted-model"

it.each(["openai", "anthropic"])("rejects an empty %s completion and preserves its usage and finish reason", async api => {
  const model = api === "openai"
    ? openaiChat({ model: "fake", fetch: async () => Response.json({ choices: [{ message: { content: null }, finish_reason: "length" }], usage: { prompt_tokens: 7, completion_tokens: 3 } }) })
    : anthropicMessages({ model: "fake", fetch: async () => Response.json({ content: [], stop_reason: "max_tokens", usage: { input_tokens: 7, output_tokens: 3 } }) })
  const browser = new BrowserSession({ headless: true })
  const result = await runAgent({ browser, task: "Read a price", model })
  expect(result).toMatchObject({ status: "failed", stopReason: "model_error", answer: "", usage: { inputTokens: 7, outputTokens: 3 } })
  expect(result.error).toContain(api === "openai" ? "length" : "max_tokens")
  expect(taskIncomplete(result)).toBe(true)
  expect(browser.started).toBe(false)
})

it.each([undefined, "", " \n ", '{"answer":"","outcome":"succeeded","unfinished":[]}'])("rejects a missing or blank final answer: %p", async text => {
  const result = await runAgent({ browser: new BrowserSession(), task: "t", model: scriptedModel([() => ({ text, toolCalls: [] })]) })
  expect(result.status).toBe("failed")
  expect(result.error).toContain("no answer or tool calls")
})

it("preserves a previous partial answer when the final step-limit reply is empty", async () => {
  const result = await runAgent({ browser: new BrowserSession(), task: "t", maxSteps: 1, model: scriptedModel([
    () => ({ text: "Found a partial price", toolCalls: [{ id: "1", name: "missing", arguments: {} }] }),
    () => ({ toolCalls: [], finishReason: "length" }),
  ]) })
  expect(result).toMatchObject({ status: "max_steps", stopReason: "step_limit", answer: "Found a partial price" })
  expect(result.error).toBeUndefined()
})

it("marks an empty delegated response as an MCP error", async () => {
  const server = createMcpServer({ session: new BrowserSession(), tools: [], agentModel: scriptedModel([() => ({ toolCalls: [] })]) })
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_task", arguments: { task: "t" } } })
  expect(response?.result).toMatchObject({ isError: true, structuredContent: { status: "failed", stopReason: "model_error" } })
})

it.each(["A normal answer", '{"answer":"A normal answer","outcome":"succeeded","unfinished":[]}'])("continues to accept a nonempty reply: %s", async text => {
  const result = await runAgent({ browser: new BrowserSession(), task: "t", model: scriptedModel([() => ({ text, toolCalls: [] })]) })
  expect(result).toMatchObject({ status: "completed", answer: "A normal answer" })
  expect(taskIncomplete(result)).toBe(false)
})
