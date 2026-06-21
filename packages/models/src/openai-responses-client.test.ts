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

  it("retries Responses API requests without temperature when the provider rejects it", async () => {
    const bodies: unknown[] = []
    const client = new OpenAIResponsesClient({
      baseUrl: "https://provider.test/v1",
      accessToken: "oauth-token",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")))
        if (bodies.length === 1) {
          return new Response(
            JSON.stringify({
              error: {
                message: "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
                type: "invalid_request_error",
                param: "temperature",
                code: "unsupported_value",
              },
            }),
            { status: 400 },
          )
        }
        return Response.json({
          id: "resp_no_temperature_retry",
          output_text: "after fallback",
        })
      },
    })

    const response = await client.complete({
      model: "gpt-test",
      messages: [{ role: "user", content: "Say hello" }],
      temperature: 0,
      responseFormat: "text",
    })

    expect(response.text).toBe("after fallback")
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toMatchObject({ temperature: 0 })
    expect(bodies[1]).not.toHaveProperty("temperature")
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

  it("passes abort signals to Responses API fetches without retrying aborts", async () => {
    const controller = new AbortController()
    let attempts = 0
    const client = new OpenAIResponsesClient({
      baseUrl: "https://provider.test/v1",
      accessToken: "oauth-token",
      maxRetry: 3,
      fetch: async (_url, init) => {
        attempts += 1
        if (init?.signal !== controller.signal) {
          throw new Error("signal not forwarded")
        }
        return new Promise<Response>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })
        })
      },
    })

    const response = client.complete(
      {
        model: "gpt-test",
        messages: [{ role: "user", content: "abort" }],
        responseFormat: "text",
      },
      { signal: controller.signal },
    )
    controller.abort(new DOMException("cancelled", "AbortError"))

    await expect(response).rejects.toThrow("cancelled")
    expect(attempts).toBe(1)
  })
})
