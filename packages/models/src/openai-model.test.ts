import { describe, expect, it } from "bun:test"
import type { RuntimeContext } from "@open-web-agent/core"
import { OpenAIModel } from "./openai-model"

describe("OpenAIModel", () => {
  it("uses the OpenAI chat completions endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const abort = new AbortController()
    const model = new OpenAIModel({
      apiKey: "openai-key",
      defaultModel: "gpt-test",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Response.json({ id: "res_1", choices: [{ message: { content: "ok" } }], usage: null })
      },
    })

    const response = await model.complete(
      { model: "gpt-test", messages: [{ role: "user", content: "hi" }], temperature: 0, responseFormat: "text" },
      { abortSignal: abort.signal } as RuntimeContext,
    )

    expect(model.id).toBe("openai")
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions")
    expect(calls[0]?.init.signal).toBe(abort.signal)
    expect(response.text).toBe("ok")
  })

  it("applies default model parameters to requests", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const model = new OpenAIModel({
      apiKey: "openai-key",
      defaultModel: "gpt-test",
      defaultParameters: { temperature: 0.4, topP: 0.9, maxTokens: 512 },
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({ id: "res_1", choices: [{ message: { content: "ok" } }], usage: null })
      },
    })

    await model.complete(
      { model: "gpt-test", messages: [{ role: "user", content: "hi" }], temperature: 0, responseFormat: "text" },
      {} as never,
    )

    expect(bodies[0]).toMatchObject({
      temperature: 0.4,
      top_p: 0.9,
      max_tokens: 512,
    })
  })

  it("forwards configured reasoning effort to OpenAI-compatible requests", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const model = new OpenAIModel({
      apiKey: "openai-key",
      defaultModel: "gpt-test",
      reasoningEffort: "high",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({ id: "res_1", choices: [{ message: { content: "ok" } }], usage: null })
      },
    })

    await model.complete(
      { model: "gpt-test", messages: [{ role: "user", content: "hi" }], temperature: 0, responseFormat: "text" },
      {} as never,
    )

    expect(bodies[0]).toMatchObject({
      model: "gpt-test",
      reasoning_effort: "high",
    })
  })
})
