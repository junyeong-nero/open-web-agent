import { describe, expect, it } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveModel, roleModelConfig, splitModelSpec } from "./resolve"

describe("splitModelSpec", () => {
  it("only treats known providers as prefixes", () => {
    expect(splitModelSpec("openrouter:anthropic/claude-sonnet-5")).toEqual({ provider: "openrouter", model: "anthropic/claude-sonnet-5" })
    expect(splitModelSpec("ollama:qwen3:8b")).toEqual({ provider: "ollama", model: "qwen3:8b" })
    expect(splitModelSpec("qwen3:8b")).toEqual({ model: "qwen3:8b" })
  })
})

describe("resolveModel", () => {
  it("resolves provider presets by API format", async () => {
    expect((await resolveModel({ model: "anthropic:claude-sonnet-5" }, { ANTHROPIC_API_KEY: "k" })).name).toBe(
      "anthropic-messages:claude-sonnet-5",
    )
    expect((await resolveModel({ model: "gemini:gemini-2.5-flash" }, { GEMINI_API_KEY: "k" })).name).toBe(
      "openai-chat:gemini-2.5-flash",
    )
    expect((await resolveModel({ model: "ollama:qwen3:8b" }, {})).name).toBe("openai-chat:qwen3:8b")
    expect((await resolveModel({ model: "typesafe:jev-latest" }, { TYPESAFE_API_KEY: "k" })).name).toBe("typesafe-systemone:jev-latest")
  })

  it("supports custom endpoints with an explicit API format", async () => {
    const model = await resolveModel({ model: "local-model", baseUrl: "http://localhost:8000/v1", api: "anthropic" }, {})
    expect(model.name).toBe("anthropic-messages:local-model")
  })

  it("explains missing configuration", async () => {
    expect(resolveModel({}, {})).rejects.toThrow("No model configured")
    expect(resolveModel({ model: "openai:gpt-5-mini" }, {})).rejects.toThrow("OPENAI_API_KEY")
    expect(resolveModel({ model: "x", provider: "nope" }, {})).rejects.toThrow('Unknown provider "nope"')
    expect(resolveModel({ model: "typesafe:jev-latest" }, {})).rejects.toThrow("TYPESAFE_API_KEY")
  })

  it("loads adapters from a module", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-model-"))
    const path = join(dir, "model.ts")
    await writeFile(path, `export default (config) => ({ name: "custom:" + config.model, complete: async () => ({ toolCalls: [] }) })`)
    expect((await resolveModel({ module: path, model: "m" }, {})).name).toBe("custom:m")
  })
})

describe("roleModelConfig", () => {
  const optionsSetting = { flag: "--judge-model-options", env: "OWA_JUDGE_MODEL_OPTIONS" }

  it("reads --judge-model and its options before the environment", () => {
    const env = { OWA_JUDGE_MODEL: "gemini:gemini-3.1-flash-lite", OWA_JUDGE_MODEL_OPTIONS: '{"temperature":0}' }
    expect(roleModelConfig("judge", {}, {})).toBeUndefined()
    // The main model's settings never configure the judge.
    expect(roleModelConfig("judge", {}, { OWA_MODEL: "openai:gpt-6-luna", OWA_MODEL_OPTIONS: "{}", OWA_API_KEY: "k" })).toBeUndefined()
    expect(roleModelConfig("judge", {}, env)).toEqual({ model: "gemini:gemini-3.1-flash-lite", extraBody: { temperature: 0 }, optionsSetting })
    expect(roleModelConfig("judge", { model: "typesafe:jev-latest", options: '{"tag":"x"}' }, env)).toEqual({ model: "typesafe:jev-latest", extraBody: { tag: "x" }, optionsSetting })
    // As with --model-options, the flag's object replaces the environment's, and {} clears it.
    expect(roleModelConfig("judge", { options: "{}" }, env)).toEqual({ model: "gemini:gemini-3.1-flash-lite", extraBody: {}, optionsSetting })
    // An empty model turns the judge off.
    expect(roleModelConfig("judge", { model: "" }, env)).toBeUndefined()
  })

  it("rejects judge options that are invalid or have no model, without echoing them", () => {
    for (const options of ["invalid secret-token", "[]", '"secret-token"']) {
      const parse = () => roleModelConfig("judge", { model: "gemini:gemini-3.1-flash-lite", options }, {})
      expect(parse).toThrow("--judge-model-options / OWA_JUDGE_MODEL_OPTIONS must be a JSON object")
      try { parse() } catch (error) { expect(String(error)).not.toContain("secret-token") }
    }
    expect(() => roleModelConfig("judge", { model: "gemini:gemini-3.1-flash-lite", options: '{"tools":[]}' }, {})).toThrow('cannot set "tools"')
    expect(() => roleModelConfig("judge", {}, { OWA_JUDGE_MODEL_OPTIONS: "{}" })).toThrow("needs --judge-model or OWA_JUDGE_MODEL")
  })

  it("resolves only the provider shorthand, with that provider's own key", async () => {
    const judge = roleModelConfig("judge", {}, { OWA_JUDGE_MODEL: "typesafe:jev-latest" })!
    expect((await resolveModel(judge, { TYPESAFE_API_KEY: "k" })).name).toBe("typesafe-systemone:jev-latest")
    // OWA_API_KEY belongs to the main model, so it never reaches the judge's provider.
    expect(resolveModel(judge, { OWA_API_KEY: "k" })).rejects.toThrow("TYPESAFE_API_KEY")
    expect((await resolveModel(roleModelConfig("judge", { model: "ollama:qwen3:8b" }, {})!, {})).name).toBe("openai-chat:qwen3:8b")
  })
})
