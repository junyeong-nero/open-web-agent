import { describe, expect, it } from "bun:test"
import { ModelRequestSchema } from "@open-web-agent/core"
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

  it("omits temperature from chat completions when it is not requested", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = new OpenAICompatibleClient({
      baseUrl: "https://provider.test/v1",
      apiKey: "key_123",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Response.json({
          id: "chatcmpl_no_temperature",
          choices: [{ message: { content: "hello" } }],
        })
      },
    })

    await client.complete(
      ModelRequestSchema.parse({
        model: "test-model",
        messages: [{ role: "user", content: "Say hello" }],
      }),
    )

    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body).toMatchObject({
      model: "test-model",
      messages: [{ role: "user", content: "Say hello" }],
    })
    expect(body).not.toHaveProperty("temperature")
  })

  it("retries chat completions without temperature when the provider rejects it", async () => {
    const bodies: unknown[] = []
    const client = new OpenAICompatibleClient({
      baseUrl: "https://provider.test/v1",
      apiKey: "key_123",
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
          id: "chatcmpl_no_temperature_retry",
          choices: [{ message: { content: "after fallback" } }],
        })
      },
    })

    const response = await client.complete({
      model: "test-model",
      messages: [{ role: "user", content: "Say hello" }],
      temperature: 0,
      responseFormat: "text",
    })

    expect(response.text).toBe("after fallback")
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toMatchObject({ temperature: 0 })
    expect(bodies[1]).not.toHaveProperty("temperature")
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

  it("serializes function tools and correlated tool conversation messages", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const client = new OpenAICompatibleClient({
      baseUrl: "https://provider.test/v1",
      apiKey: "key_123",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({
          id: "chatcmpl_1",
          choices: [{ message: { content: "done" } }],
        })
      },
    })

    await client.complete({
      model: "test-model",
      messages: [
        { role: "user", content: "Open example.com" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_1", name: "browser_navigate", arguments: { url: "https://example.com" } },
          ],
        },
        {
          role: "tool",
          content: '{"ok":true}',
          toolCallId: "call_1",
          name: "browser_navigate",
        },
      ],
      tools: [
        {
          name: "browser_navigate",
          description: "Navigate",
          inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
          strict: true,
        },
      ],
      toolChoice: "auto",
      responseFormat: "text",
    })

    expect(bodies[0]).toMatchObject({
      tools: [
        {
          type: "function",
          function: {
            name: "browser_navigate",
            description: "Navigate",
            parameters: { type: "object" },
            strict: true,
          },
        },
      ],
      tool_choice: "auto",
      messages: [
        { role: "user", content: "Open example.com" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "browser_navigate", arguments: '{"url":"https://example.com"}' },
            },
          ],
        },
        { role: "tool", content: '{"ok":true}', tool_call_id: "call_1", name: "browser_navigate" },
      ],
    })
  })

  it("parses multiple native tool calls and preserves malformed arguments for local validation", async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: "https://provider.test/v1",
      apiKey: "key_123",
      fetch: async () =>
        Response.json({
          id: "chatcmpl_tools",
          choices: [
            {
              message: {
                content: "Use the browser.",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "browser_navigate", arguments: '{"url":"https://example.com"}' },
                  },
                  {
                    id: "call_2",
                    type: "function",
                    function: { name: "browser_click", arguments: "{not-json" },
                  },
                ],
              },
            },
          ],
        }),
    })

    const response = await client.complete({
      model: "test-model",
      messages: [{ role: "user", content: "browse" }],
      responseFormat: "text",
    })

    expect(response.text).toBe("Use the browser.")
    expect(response.toolCalls).toEqual([
      { id: "call_1", name: "browser_navigate", arguments: { url: "https://example.com" } },
      { id: "call_2", name: "browser_click", arguments: "{not-json" },
    ])
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

  it("passes abort signals to chat completion fetches without retrying aborts", async () => {
    const controller = new AbortController()
    let attempts = 0
    const client = new OpenAICompatibleClient({
      baseUrl: "https://provider.test/v1",
      apiKey: "key_123",
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
        model: "test-model",
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
