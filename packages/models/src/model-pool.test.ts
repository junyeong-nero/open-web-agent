import { describe, expect, it } from "bun:test"
import { createOpenAIModelPool, createOpenRouterModelPool } from "./model-pool"

describe("model pools", () => {
  it("builds selectable OpenAI models that force the selected model slug", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const models = createOpenAIModelPool({
      apiKey: "openai-key",
      defaultParameters: { temperature: 0.2 },
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({ id: "res_1", choices: [{ message: { content: "ok" } }], usage: null })
      },
    })

    const gpt = models.find((model) => model.id === "openai:gpt-5.5")
    const codex = models.find((model) => model.id === "openai:gpt-5.3-codex-spark")

    expect(gpt).toMatchObject({
      name: "OpenAI",
      provider: "openai",
      modelName: "gpt-5.5",
      contextWindowTokens: 1_000_000,
    })
    expect(codex).toMatchObject({
      name: "OpenAI",
      provider: "openai",
      modelName: "gpt-5.3-codex-spark",
      contextWindowTokens: 400_000,
    })

    await gpt?.complete(
      {
        model: "configured-default",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0,
        responseFormat: "text",
      },
      {} as never,
    )

    expect(bodies[0]).toMatchObject({ model: "gpt-5.5", temperature: 0.2 })
  })

  it("builds selectable OpenRouter models for OpenAI, Claude, Gemini, and routers", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const models = createOpenRouterModelPool({
      apiKey: "openrouter-key",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({ id: "res_1", choices: [{ message: { content: "ok" } }], usage: null })
      },
    })

    expect(models.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        "openrouter:~openai/gpt-latest",
        "openrouter:~anthropic/claude-sonnet-latest",
        "openrouter:~google/gemini-pro-latest",
        "openrouter:openrouter/fusion",
      ]),
    )

    const claude = models.find((model) => model.id === "openrouter:~anthropic/claude-sonnet-latest")
    expect(claude).toMatchObject({
      name: "OpenRouter",
      provider: "openrouter",
      modelName: "~anthropic/claude-sonnet-latest",
      contextWindowTokens: 1_000_000,
    })

    await claude?.complete(
      {
        model: "configured-default",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0,
        responseFormat: "text",
      },
      {} as never,
    )

    expect(bodies[0]).toMatchObject({ model: "~anthropic/claude-sonnet-latest" })
  })
})
