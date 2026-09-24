import { describe, expect, it } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveModel, splitModelSpec } from "./resolve"

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
  })

  it("supports custom endpoints with an explicit API format", async () => {
    const model = await resolveModel({ model: "local-model", baseUrl: "http://localhost:8000/v1", api: "anthropic" }, {})
    expect(model.name).toBe("anthropic-messages:local-model")
  })

  it("explains missing configuration", async () => {
    expect(resolveModel({}, {})).rejects.toThrow("No model configured")
    expect(resolveModel({ model: "openai:gpt-5-mini" }, {})).rejects.toThrow("OPENAI_API_KEY")
    expect(resolveModel({ model: "x", provider: "nope" }, {})).rejects.toThrow('Unknown provider "nope"')
  })

  it("loads adapters from a module", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-model-"))
    const path = join(dir, "model.ts")
    await writeFile(path, `export default (config) => ({ name: "custom:" + config.model, complete: async () => ({ toolCalls: [] }) })`)
    expect((await resolveModel({ module: path, model: "m" }, {})).name).toBe("custom:m")
  })
})
