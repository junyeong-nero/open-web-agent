import { describe, expect, it } from "bun:test"
import { ModelRequestSchema } from "@open-web-agent/core"
import { OpenAIResponsesClient } from "./openai-responses-client"

describe("OpenAIResponsesClient", () => {
  it("constructs Responses API requests and parses output text", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = new OpenAIResponsesClient({
      baseUrl: "https://provider.test/v1",
      accessToken: "oauth-token",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Response.json({
          id: "resp_1",
          output_text: "hello",
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        })
      },
    })

    const response = await client.complete({
      model: "gpt-test",
      messages: [
        { role: "system", content: "Answer as JSON." },
        { role: "user", content: "Say hello" },
      ],
      temperature: 0.4,
      topP: 0.9,
      maxTokens: 512,
      extraBody: { service_tier: "flex" },
      responseFormat: "json",
    })

    expect(calls[0]?.url).toBe("https://provider.test/v1/responses")
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer oauth-token",
      "content-type": "application/json",
    })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "gpt-test",
      input: [{ role: "user", content: "Say hello" }],
      instructions: "Answer as JSON.",
      temperature: 0.4,
      top_p: 0.9,
      max_output_tokens: 512,
      service_tier: "flex",
      text: { format: { type: "json_object" } },
    })
    expect(response).toMatchObject({
      id: "resp_1",
      text: "hello",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    })
  })

  it("omits temperature from Responses API requests when it is not requested", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = new OpenAIResponsesClient({
      baseUrl: "https://provider.test/v1",
      accessToken: "oauth-token",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Response.json({
          id: "resp_no_temperature",
          output_text: "hello",
        })
      },
    })

    await client.complete(
      ModelRequestSchema.parse({
        model: "gpt-test",
        messages: [{ role: "user", content: "Say hello" }],
      }),
    )

    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body).toMatchObject({
      model: "gpt-test",
      input: [{ role: "user", content: "Say hello" }],
    })
    expect(body).not.toHaveProperty("temperature")
  })

  it("extracts text from output message content when output_text is absent", async () => {
    const client = new OpenAIResponsesClient({
      baseUrl: "https://provider.test/v1",
      accessToken: "oauth-token",
      fetch: async () =>
        Response.json({
          id: "resp_2",
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: "from output content" },
                { type: "refusal", refusal: "ignored" },
              ],
            },
          ],
        }),
    })

    const response = await client.complete({
      model: "gpt-test",
      messages: [{ role: "user", content: "Say hello" }],
      temperature: 0,
      responseFormat: "text",
    })

    expect(response.text).toBe("from output content")
  })

  it("retries transient Responses API failures up to maxRetry", async () => {
    let attempts = 0
    const client = new OpenAIResponsesClient({
      baseUrl: "https://provider.test/v1",
      accessToken: "oauth-token",
      maxRetry: 2,
      fetch: async () => {
        attempts += 1
        if (attempts < 3) return new Response("temporarily unavailable", { status: 503 })
        return Response.json({ id: "resp_retry", output_text: "after retry" })
      },
    })

    const response = await client.complete({
      model: "gpt-test",
      messages: [{ role: "user", content: "retry" }],
      temperature: 0,
      responseFormat: "text",
    })

    expect(response.text).toBe("after retry")
    expect(attempts).toBe(3)
  })
})
