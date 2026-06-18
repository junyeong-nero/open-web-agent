import { describe, expect, it } from "bun:test"
import { OpenAICompatibleClient } from "./openai-compatible-client"

describe("OpenAICompatibleClient", () => {
  it("constructs chat completions requests and parses responses", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = new OpenAICompatibleClient({
      baseUrl: "https://provider.test/v1",
      apiKey: "key_123",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Response.json({
          id: "chatcmpl_1",
          choices: [{ message: { content: "hello" } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        })
      },
    })

    const response = await client.complete({
      model: "test-model",
      messages: [{ role: "user", content: "Say hello" }],
      temperature: 0,
      responseFormat: "json",
    })

    expect(calls[0]?.url).toBe("https://provider.test/v1/chat/completions")
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer key_123",
      "content-type": "application/json",
    })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "test-model",
      messages: [{ role: "user", content: "Say hello" }],
      temperature: 0,
      response_format: { type: "json_object" },
    })
    expect(response).toMatchObject({
      id: "chatcmpl_1",
      text: "hello",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    })
  })

  it("forwards optional model parameters to chat completions", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = new OpenAICompatibleClient({
      baseUrl: "https://provider.test/v1",
      apiKey: "key_123",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Response.json({
          id: "chatcmpl_2",
          choices: [{ message: { content: "hello" } }],
        })
      },
    })

    await client.complete({
      model: "test-model",
      messages: [{ role: "user", content: "Say hello" }],
      temperature: 0.4,
      topP: 0.9,
      maxTokens: 512,
      presencePenalty: 0.2,
      frequencyPenalty: -0.1,
      seed: 42,
      stop: ["<END>"],
      extraBody: { reasoning_effort: "low" },
      responseFormat: "text",
    })

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "test-model",
      messages: [{ role: "user", content: "Say hello" }],
      temperature: 0.4,
      top_p: 0.9,
      max_tokens: 512,
      presence_penalty: 0.2,
      frequency_penalty: -0.1,
      seed: 42,
      stop: ["<END>"],
      reasoning_effort: "low",
    })
  })

  it("forwards multimodal message content parts unchanged", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = new OpenAICompatibleClient({
      baseUrl: "https://provider.test/v1",
      apiKey: "key_123",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Response.json({
          id: "chatcmpl_3",
          choices: [{ message: { content: "screenshot answer" } }],
        })
      },
    })
    const content = [
      { type: "text", text: "Use the screenshot." },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]

    await client.complete({
      model: "test-model",
      messages: [{ role: "user", content }],
      temperature: 0,
      responseFormat: "text",
    })

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "test-model",
      messages: [{ role: "user", content }],
      temperature: 0,
    })
  })

  it("retries transient chat completion failures up to maxRetry", async () => {
    const statuses = [500, 429]
    const client = new OpenAICompatibleClient({
      baseUrl: "https://provider.test/v1",
      apiKey: "key_123",
      maxRetry: 2,
      fetch: async () => {
        const status = statuses.shift()
        if (status) return new Response(`failed ${status}`, { status })
        return Response.json({
          id: "chatcmpl_retry",
          choices: [{ message: { content: "after retry" } }],
        })
      },
    })

    const response = await client.complete({
      model: "test-model",
      messages: [{ role: "user", content: "retry" }],
      temperature: 0,
      responseFormat: "text",
    })

    expect(response.text).toBe("after retry")
    expect(statuses).toEqual([])
  })
})
