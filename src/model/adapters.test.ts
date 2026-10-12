import { describe, expect, it } from "bun:test"
import { anthropicMessages } from "./anthropic"
import { openaiChat } from "./openai"
import { typesafeSystemOne } from "./typesafe"
import { type FetchLike, ModelHttpError, type ModelRequest } from "./types"

function recordingFetch(response: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(response), { status })
  }
  return { calls, fetchImpl }
}

const request: ModelRequest = {
  system: "sys",
  tools: [{ name: "browser_click", description: "Click", inputSchema: { type: "object", properties: {} } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "task" }] },
    { role: "assistant", text: "looking", toolCalls: [{ id: "c1", name: "browser_screenshot", arguments: {} }, { id: "c2", name: "browser_click", arguments: { ref: "e1" } }] },
    { role: "tool", toolCallId: "c1", name: "browser_screenshot", content: [{ type: "text", text: "shot" }, { type: "image", mimeType: "image/png", data: "AAA" }] },
    { role: "tool", toolCallId: "c2", name: "browser_click", content: [{ type: "text", text: "failed" }], isError: true },
  ],
}

describe("openaiChat", () => {
  it("maps messages, tools, and images to Chat Completions", async () => {
    const { calls, fetchImpl } = recordingFetch({
      choices: [{ message: { content: null, tool_calls: [{ id: "c3", function: { name: "browser_click", arguments: '{"ref":"e2"}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    })
    const model = openaiChat({ model: "m", baseUrl: "http://x/v1/", apiKey: "k", extraBody: { temperature: 0 }, fetch: fetchImpl })
    const response = await model.complete(request)

    expect(calls[0].url).toBe("http://x/v1/chat/completions")
    expect(calls[0].headers.authorization).toBe("Bearer k")
    const { body } = calls[0]
    expect(body.temperature).toBe(0)
    expect(body.tools[0].function.name).toBe("browser_click")
    expect(body.messages.map((message: any) => message.role)).toEqual(["system", "user", "assistant", "tool", "tool", "user"])
    expect(body.messages[2].tool_calls[1].function.arguments).toBe('{"ref":"e1"}')
    expect(body.messages[5].content[1].image_url.url).toBe("data:image/png;base64,AAA")
    expect(response).toEqual({
      text: undefined,
      toolCalls: [{ id: "c3", name: "browser_click", arguments: { ref: "e2" } }],
      usage: { inputTokens: 10, outputTokens: 2 },
    })
  })

  it("surfaces HTTP errors", async () => {
    const { fetchImpl } = recordingFetch({ error: "nope" }, 401)
    expect(openaiChat({ model: "m", fetch: fetchImpl }).complete(request)).rejects.toBeInstanceOf(ModelHttpError)
  })
})

describe("typesafeSystemOne", () => {
  const question: ModelRequest = {
    system: "Is the answer supported?",
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: "Task: t" }, { type: "image", mimeType: "image/png", data: "AAA" }, { type: "text", text: "Answer: a" }] }],
  }

  it("asks one yes/no question about the text of the messages and returns its probability", async () => {
    const { calls, fetchImpl } = recordingFetch({ model: "jev-1.13.0", answers: { answer: { type: "noul", noul: 0.82 } }, usage: { input_tokens: 296, output_tokens: 20 } })
    const response = await typesafeSystemOne({ model: "jev-latest", apiKey: "k", extraBody: { tag: "x" }, fetch: fetchImpl }).complete(question)
    expect(calls).toEqual([{
      url: "https://api.typesafe.ai/v1/systemone",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: { model: "jev-latest", state: "Task: t\n\nAnswer: a", questions: { answer: { type: "noul", instructions: "Is the answer supported?" } }, tag: "x" },
    }])
    expect(response).toEqual({ text: "0.82", toolCalls: [], model: "jev-1.13.0", usage: { inputTokens: 296, outputTokens: 20 } })
  })

  it("refuses requests with tools, fails without a yes/no answer, and redacts the key from HTTP errors", async () => {
    const answered = recordingFetch({ model: "jev-1.13.0", answers: { answer: { type: "noul", noul: 0.5 } } })
    await expect(typesafeSystemOne({ model: "jev-latest", fetch: answered.fetchImpl }).complete(request)).rejects.toThrow("only answers yes/no and choice questions; use it as the judge or checker model")
    expect(answered.calls).toHaveLength(0)
    await expect(typesafeSystemOne({ model: "jev-latest", fetch: recordingFetch({ answers: {} }).fetchImpl }).complete(question)).rejects.toThrow("returned no yes/no answer")

    const { fetchImpl } = recordingFetch({ detail: "Invalid API key test-secret-token" }, 401)
    const error = await typesafeSystemOne({ model: "jev-latest", apiKey: "test-secret-token", fetch: fetchImpl }).complete(question).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(ModelHttpError)
    expect(String(error)).toContain("typesafe-systemone:jev-latest request failed with HTTP 401")
    expect(String(error)).not.toContain("test-secret-token")
  })

  const choices = { content: "The page works.", access_denied: "A bot check or 'Access Denied' page." }
  const page = { url: "https://example.com/", browser_result: "Navigated to https://example.com/", accessibility_snapshot: "Page URL: https://example.com/\n- heading \"Access Denied\"" }

  it("asks one Choice question when the request has choices, with a JSON object message as the state", async () => {
    const { calls, fetchImpl } = recordingFetch({
      model: "jev-1.13.0",
      answers: { answer: { type: "choice", choice: "access_denied", confidence: 0.94, probabilities: { access_denied: 0.97, content: 0.03 } } },
      usage: { input_tokens: 896, output_tokens: 95 },
    })
    const model = typesafeSystemOne({ model: "jev-latest", apiKey: "k", extraBody: { tag: "x" }, fetch: fetchImpl })
    expect(model.answersChoices).toBe(true)
    const response = await model.complete({ system: "Which kind of page is it?", tools: [], choices, messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify(page) }] }] })
    expect(calls).toEqual([{
      url: "https://api.typesafe.ai/v1/systemone",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: { model: "jev-latest", state: page, questions: { answer: { type: "choice", instructions: "Which kind of page is it?", criteria: choices } }, tag: "x" },
    }])
    // The confidence is the probability of the choice, not the API's spread-based confidence.
    expect(response).toEqual({ text: '{"label":"access_denied","confidence":0.97}', toolCalls: [], model: "jev-1.13.0", usage: { inputTokens: 896, outputTokens: 95 } })

    // Text that is not a JSON object stays a string.
    await model.complete({ ...question, choices })
    expect(calls[1]!.body.state).toBe("Task: t\n\nAnswer: a")
  })

  it("fails a choice request without a choice and its probability", async () => {
    for (const answer of [{ type: "noul", noul: 0.9 }, { type: "choice", choice: "content" }, { type: "choice", choice: "content", probabilities: { content: "1" } }]) {
      const { fetchImpl } = recordingFetch({ answers: { answer } })
      await expect(typesafeSystemOne({ model: "jev-latest", fetch: fetchImpl }).complete({ ...question, choices })).rejects.toThrow("typesafe-systemone:jev-latest returned no choice")
    }
  })
})

describe("choices", () => {
  it("are left out of the chat adapters' requests", async () => {
    const withChoices: ModelRequest = { system: "Which kind of page is it?", tools: [], choices: { content: "The page works." }, messages: [{ role: "user", content: [{ type: "text", text: "page" }] }] }
    const openai = recordingFetch({ choices: [{ message: { content: '{"label":"content"}' } }] })
    const anthropic = recordingFetch({ content: [{ type: "text", text: '{"label":"content"}' }] })
    expect(openaiChat({ model: "m", fetch: openai.fetchImpl }).answersChoices).toBeUndefined()
    await openaiChat({ model: "m", fetch: openai.fetchImpl }).complete(withChoices)
    await anthropicMessages({ model: "m", fetch: anthropic.fetchImpl }).complete(withChoices)
    const { choices: _ignored, ...plain } = withChoices
    await openaiChat({ model: "m", fetch: openai.fetchImpl }).complete(plain)
    await anthropicMessages({ model: "m", fetch: anthropic.fetchImpl }).complete(plain)
    expect(openai.calls[0]!.body).toEqual(openai.calls[1]!.body)
    expect(anthropic.calls[0]!.body).toEqual(anthropic.calls[1]!.body)
  })
})

describe("anthropicMessages", () => {
  it("maps messages to the Messages API and merges tool results into one user turn", async () => {
    const { calls, fetchImpl } = recordingFetch({
      content: [{ type: "text", text: "done" }, { type: "tool_use", id: "t1", name: "browser_snapshot", input: {} }],
      usage: { input_tokens: 5, output_tokens: 1 },
    })
    const model = anthropicMessages({ model: "claude", apiKey: "k", fetch: fetchImpl })
    const response = await model.complete(request)

    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages")
    expect(calls[0].headers["x-api-key"]).toBe("k")
    const { body } = calls[0]
    expect(body.system).toBe("sys")
    expect(body.max_tokens).toBe(4096)
    expect(body.tools[0].input_schema.type).toBe("object")
    expect(body.messages.map((message: any) => message.role)).toEqual(["user", "assistant", "user"])
    expect(body.messages[1].content[2]).toEqual({ type: "tool_use", id: "c2", name: "browser_click", input: { ref: "e1" } })
    const [shot, failed] = body.messages[2].content
    expect(shot.content[1].source).toEqual({ type: "base64", media_type: "image/png", data: "AAA" })
    expect(failed.is_error).toBe(true)
    expect(response.text).toBe("done")
    expect(response.toolCalls).toEqual([{ id: "t1", name: "browser_snapshot", arguments: {} }])
  })
})

describe("prompt caching", () => {
  const keyed: ModelRequest = { ...request, cacheKey: "run-1" }
  const breakpoint = { cache_control: { type: "ephemeral" } }
  const marks = (body: unknown) => JSON.stringify(body).split('"cache_control"').length - 1
  const answered = () => recordingFetch({ choices: [{ message: { content: "done" } }], content: [{ type: "text", text: "done" }] })

  it("sends a request's cache key as prompt_cache_key to OpenRouter only, and nothing else", async () => {
    for (const [baseUrl, sent] of [
      ["https://openrouter.ai/api/v1", true],
      // OpenAI's GPT-5.6 and later models route requests themselves; a key there would only keep runs from sharing a cache.
      [undefined, false],
      ["https://api.openai.com/v1", false],
      ["https://generativelanguage.googleapis.com/v1beta/openai", false],
      ["http://localhost:11434/v1", false],
      ["http://127.0.0.1:8000/v1", false],
    ] as const) {
      const { calls, fetchImpl } = answered()
      const model = openaiChat({ model: "m", baseUrl, fetch: fetchImpl })
      await model.complete(keyed)
      await model.complete(request)
      const [withKey, withoutKey] = calls.map((call) => call.body)
      expect(withKey.prompt_cache_key).toBe(sent ? "run-1" : undefined)
      const { prompt_cache_key: _key, ...rest } = withKey
      expect(rest).toEqual(withoutKey)
      expect(withoutKey).not.toHaveProperty("prompt_cache_key")
    }
  })

  it("passes a prompt_cache_key from the model options through as is", async () => {
    for (const baseUrl of ["https://api.openai.com/v1", "https://openrouter.ai/api/v1"]) {
      const { calls, fetchImpl } = answered()
      await openaiChat({ model: "m", baseUrl, extraBody: { prompt_cache_key: "mine" }, fetch: fetchImpl }).complete(keyed)
      expect(calls[0]!.body.prompt_cache_key).toBe("mine")
    }
  })

  it("marks the end of the system prompt and of the message before the newest turn for Anthropic", async () => {
    const { calls, fetchImpl } = answered()
    const model = anthropicMessages({ model: "claude", fetch: fetchImpl })
    await model.complete(keyed)
    await model.complete(request)
    const [cached, plain] = calls.map((call) => call.body)
    expect(cached.system).toEqual([{ type: "text", text: "sys", ...breakpoint }])
    // The newest turn holds the tool results; the assistant turn before it ends with the browser_click call.
    expect(cached.messages[1].content.at(-1)).toEqual({ type: "tool_use", id: "c2", name: "browser_click", input: { ref: "e1" }, ...breakpoint })
    expect(marks(cached)).toBe(2)
    // Without a key nothing is marked, and the marks are the only difference.
    expect(plain.system).toBe("sys")
    expect(marks(plain)).toBe(0)
    const unmarked = JSON.parse(JSON.stringify(cached, (key, value) => (key === "cache_control" ? undefined : value)))
    expect({ ...unmarked, system: "sys" }).toEqual(plain)
  })

  it("marks only the static prefix of a first request, on the last tool when the system prompt is empty", async () => {
    const { calls, fetchImpl } = answered()
    const model = anthropicMessages({ model: "claude", fetch: fetchImpl })
    const first: ModelRequest = { ...keyed, messages: [request.messages[0]!] }
    await model.complete(first)
    await model.complete({ ...first, system: "" })
    const [withSystem, withoutSystem] = calls.map((call) => call.body)
    expect(withSystem.system).toEqual([{ type: "text", text: "sys", ...breakpoint }])
    expect(marks(withSystem)).toBe(1)
    expect(withoutSystem.system).toBe("")
    expect(withoutSystem.tools).toEqual([{ name: "browser_click", description: "Click", input_schema: { type: "object", properties: {} }, ...breakpoint }])
    expect(marks(withoutSystem)).toBe(1)
  })

  it("adds no Anthropic breakpoints when the model options set cache_control", async () => {
    const { calls, fetchImpl } = answered()
    const automatic = { type: "ephemeral", ttl: "1h" }
    await anthropicMessages({ model: "claude", extraBody: { cache_control: automatic }, fetch: fetchImpl }).complete(keyed)
    expect(calls[0]!.body.cache_control).toEqual(automatic)
    expect(calls[0]!.body.system).toBe("sys")
    expect(marks(calls[0]!.body)).toBe(1)
  })

  it("leaves TypeSafe requests unchanged", async () => {
    const { calls, fetchImpl } = recordingFetch({ answers: { answer: { type: "noul", noul: 0.5 } } })
    const model = typesafeSystemOne({ model: "jev-latest", fetch: fetchImpl })
    const question: ModelRequest = { system: "Is it?", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "state" }] }] }
    await model.complete({ ...question, cacheKey: "run-1:judge" })
    await model.complete(question)
    expect(calls[0]!.body).toEqual(calls[1]!.body)
  })
})

// Response bodies in each API's documented shape; 11,268 input tokens with 11,265 cached is the probe in #161.
describe("usage and serving model", () => {
  const toolCall = { id: "call_1", type: "function", function: { name: "browser_click", arguments: '{"ref":"e2"}' } }

  it("reads OpenAI cached tokens and reports no cost", async () => {
    const { fetchImpl } = recordingFetch({
      id: "chatcmpl-1", object: "chat.completion", created: 1791331200, model: "gpt-6-luna",
      choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [toolCall], refusal: null, annotations: [] }, logprobs: null, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 11268, completion_tokens: 26, total_tokens: 11294,
        prompt_tokens_details: { cached_tokens: 11265, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
      },
      service_tier: "default", system_fingerprint: null,
    })
    const response = await openaiChat({ model: "gpt-6-luna", fetch: fetchImpl }).complete(request)
    expect(response.model).toBe("gpt-6-luna")
    expect(response.usage).toStrictEqual({ inputTokens: 11268, outputTokens: 26, cachedInputTokens: 11265 })
  })

  it("reads the model a router chose, the cost and cache writes from OpenRouter", async () => {
    const routed = recordingFetch({
      id: "gen-1791331200-a", provider: "Azure", model: "openai/gpt-6-luna", object: "chat.completion", created: 1791331200,
      choices: [{ logprobs: null, finish_reason: "tool_calls", native_finish_reason: "tool_calls", index: 0, message: { role: "assistant", content: "", tool_calls: [toolCall] } }],
      usage: {
        prompt_tokens: 11268, completion_tokens: 26, total_tokens: 11294, cost: 0.00012595,
        cost_details: { upstream_inference_cost: null }, prompt_tokens_details: { cached_tokens: 11265, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    })
    const response = await openaiChat({ model: "typesafe/jev-router", fetch: routed.fetchImpl }).complete(request)
    expect(routed.calls[0].body.model).toBe("typesafe/jev-router")
    expect(response.model).toBe("openai/gpt-6-luna")
    expect(response.usage).toStrictEqual({ inputTokens: 11268, outputTokens: 26, cachedInputTokens: 11265, cost: 0.00012595 })

    // Models with explicit caching also report the tokens written to the cache. A reported zero stays zero.
    const written = recordingFetch({
      id: "gen-1791331200-b", provider: "Anthropic", model: "anthropic/claude-haiku-4.5", object: "chat.completion", created: 1791331200,
      choices: [{ logprobs: null, finish_reason: "tool_calls", native_finish_reason: "tool_use", index: 0, message: { role: "assistant", content: "", tool_calls: [toolCall] } }],
      usage: {
        prompt_tokens: 11268, completion_tokens: 26, total_tokens: 11294, cost: 0.01421425,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 11265, audio_tokens: 0 },
      },
    })
    expect((await openaiChat({ model: "anthropic/claude-haiku-4.5", fetch: written.fetchImpl }).complete(request)).usage)
      .toStrictEqual({ inputTokens: 11268, outputTokens: 26, cachedInputTokens: 0, cacheWriteTokens: 11265, cost: 0.01421425 })
  })

  it("adds Anthropic cache reads and writes to the input tokens", async () => {
    const { fetchImpl } = recordingFetch({
      id: "msg_01", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
      content: [{ type: "tool_use", id: "toolu_01", name: "browser_click", input: { ref: "e2" } }],
      stop_reason: "tool_use", stop_sequence: null,
      usage: {
        input_tokens: 3, cache_creation_input_tokens: 200, cache_read_input_tokens: 11065,
        cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 }, output_tokens: 26, service_tier: "standard",
      },
    })
    const response = await anthropicMessages({ model: "claude-haiku-4-5", fetch: fetchImpl }).complete(request)
    expect(response.model).toBe("claude-haiku-4-5-20251001")
    expect(response.usage).toStrictEqual({ inputTokens: 11268, outputTokens: 26, cachedInputTokens: 11065, cacheWriteTokens: 200 })
  })

  it("leaves out values an endpoint does not send instead of writing zeros", async () => {
    const replies = [
      // Gemini's OpenAI endpoint: no cache details or cost.
      { model: "gemini-3.1-flash-lite", usage: { prompt_tokens: 120, completion_tokens: 5, total_tokens: 125 } },
      // vLLM: details sent as null.
      { model: "Qwen/Qwen3-8B", usage: { prompt_tokens: 120, completion_tokens: 5, total_tokens: 125, prompt_tokens_details: null } },
    ]
    for (const reply of replies) {
      const { fetchImpl } = recordingFetch({ object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], ...reply })
      const response = await openaiChat({ model: "m", fetch: fetchImpl }).complete(request)
      expect(response.model).toBe(reply.model)
      expect(response.usage).toStrictEqual({ inputTokens: 120, outputTokens: 5 })
    }
    const { fetchImpl } = recordingFetch({ content: [{ type: "text", text: "done" }], usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: null, cache_creation_input_tokens: null } })
    const response = await anthropicMessages({ model: "m", fetch: fetchImpl }).complete(request)
    expect(response.model).toBeUndefined()
    expect(response.usage).toStrictEqual({ inputTokens: 7, outputTokens: 1 })
  })
})

describe("model request diagnostics", () => {
  it("suggests explicit reasoning options for the reported compatibility error", async () => {
    const { fetchImpl } = recordingFetch({ error: { message: "Function tools with reasoning_effort are not supported. Set reasoning_effort to 'none'." } }, 400)
    await expect(openaiChat({ model: "m", fetch: fetchImpl }).complete(request)).rejects.toThrow(
      `Try --model-options '{"reasoning_effort":"none"}' (or OWA_MODEL_OPTIONS) if supported by this endpoint. No model options are changed automatically.`,
    )
    // A secondary model's hint names the setting that configured it.
    const judge = openaiChat({ model: "m", fetch: fetchImpl, optionsSetting: { flag: "--judge-model-options", env: "OWA_JUDGE_MODEL_OPTIONS" } })
    await expect(judge.complete(request)).rejects.toThrow(`Try --judge-model-options '{"reasoning_effort":"none"}' (or OWA_JUDGE_MODEL_OPTIONS) if supported`)
  })

  it("redacts API keys echoed by an endpoint from the error and its body", async () => {
    for (const create of [openaiChat, anthropicMessages]) {
      const { fetchImpl } = recordingFetch({ error: "Invalid key: test-secret-token" }, 401)
      try {
        await create({ model: "m", apiKey: "test-secret-token", fetch: fetchImpl }).complete(request)
        throw new Error("Expected request to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(ModelHttpError)
        expect(String(error)).not.toContain("test-secret-token")
        expect((error as ModelHttpError).body).not.toContain("test-secret-token")
        expect(String(error)).toContain("[redacted]")
      }
    }
  })
})
