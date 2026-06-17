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
})
