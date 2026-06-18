import { describe, expect, it } from "bun:test"
import { OPENAI_MODEL_POOL, OPENROUTER_MODEL_POOL, createOpenAIModelPool, createOpenRouterModelPool } from "./model-pool"

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
    const codex = models.find((model) => model.id === "openai:gpt-5.3-codex")

    expect(gpt).toMatchObject({
      name: "OpenAI",
      provider: "openai",
      modelName: "gpt-5.5",
      contextWindowTokens: 1_050_000,
    })
    expect(codex).toMatchObject({
      name: "OpenAI",
      provider: "openai",
      modelName: "gpt-5.3-codex",
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
        "openrouter:openrouter/fusion",
        "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
        "openrouter:openrouter/owl-alpha",
        "openrouter:openai/gpt-oss-120b:free",
      ]),
    )

    const claude = models.find((model) => model.id === "openrouter:anthropic/claude-sonnet-4.6")
    const nemotron = models.find((model) => model.id === "openrouter:nvidia/nemotron-3-super-120b-a12b:free")
    expect(claude).toMatchObject({
      name: "OpenRouter",
      provider: "openrouter",
      modelName: "anthropic/claude-sonnet-4.6",
      contextWindowTokens: 1_000_000,
    })
    expect(nemotron).toMatchObject({
      name: "OpenRouter",
      provider: "openrouter",
      modelName: "nvidia/nemotron-3-super-120b-a12b:free",
      contextWindowTokens: 128_000,
    })

    await nemotron?.complete(
      {
        model: "configured-default",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0,
        responseFormat: "text",
      },
      {} as never,
    )

    expect(bodies[0]).toMatchObject({ model: "nvidia/nemotron-3-super-120b-a12b:free" })
  })

  it("does not expose tilde aliases or duplicate direct OpenAI models in the static pools", () => {
    expect(OPENROUTER_MODEL_POOL.filter((definition) => definition.modelName.startsWith("~"))).toEqual([])

    const directOpenAIModelNames = new Set(OPENAI_MODEL_POOL.map((definition) => definition.modelName))
    const duplicatedOpenRouterModelNames = OPENROUTER_MODEL_POOL.map((definition) => definition.modelName)
      .filter((modelName) => modelName.startsWith("openai/"))
      .map((modelName) => modelName.replace(/^openai\//, ""))
      .filter((modelName) => directOpenAIModelNames.has(modelName))

    expect(duplicatedOpenRouterModelNames).toEqual([])
  })
})
