import { describe, expect, it } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { readModelConfig, resolveModelConfigPath } from "./model-config"

describe("readModelConfig", () => {
  it("resolves the default user config path", () => {
    expect(resolveModelConfigPath()).toBe(join(homedir(), ".openwebagents", "config.yaml"))
  })

  it("reads provider keys and default model from env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-model-config-"))
    expect(
      readModelConfig(
        {
          OPENAI_API_KEY: "openai-key",
          OPENROUTER_API_KEY: "openrouter-key",
          OPEN_WEB_AGENT_MODEL: "custom-model",
        },
        { configPath: join(dir, "missing-config.yaml") },
      ),
    ).toEqual({
      defaultModel: "custom-model",
      openaiApiKey: "openai-key",
      openrouterApiKey: "openrouter-key",
      parameters: {},
    })
  })

  it("reads provider keys and default model from a YAML config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-model-config-"))
    const configPath = join(dir, "config.yaml")
    await writeFile(
      configPath,
      [
        'model: "yaml-model"',
        'openai_api_key: "yaml-openai-key"',
        'openrouter_api_key: "yaml-openrouter-key"',
        "",
      ].join("\n"),
    )

    expect(readModelConfig({}, { configPath })).toEqual({
      defaultModel: "yaml-model",
      openaiApiKey: "yaml-openai-key",
      openrouterApiKey: "yaml-openrouter-key",
      parameters: {},
    })
  })

  it("reads model parameters from a YAML config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-model-config-"))
    const configPath = join(dir, "config.yaml")
    await writeFile(
      configPath,
      [
        'model: "yaml-model"',
        "parameters:",
        "  temperature: 0.4",
        "  top_p: 0.9",
        "  max_tokens: 512",
        "  presence_penalty: 0.2",
        "  frequency_penalty: -0.1",
        "  seed: 42",
        "  stop:",
        '    - "<END>"',
        "  extra_body:",
        '    reasoning_effort: "low"',
        "",
      ].join("\n"),
    )

    expect(readModelConfig({}, { configPath })).toEqual({
      defaultModel: "yaml-model",
      openaiApiKey: null,
      openrouterApiKey: null,
      parameters: {
        temperature: 0.4,
        topP: 0.9,
        maxTokens: 512,
        presencePenalty: 0.2,
        frequencyPenalty: -0.1,
        seed: 42,
        stop: ["<END>"],
        extraBody: { reasoning_effort: "low" },
      },
    })
  })

  it("lets env override YAML config file values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-model-config-"))
    const configPath = join(dir, "config.yaml")
    await writeFile(
      configPath,
      [
        'default_model: "yaml-model"',
        'openai_api_key: "yaml-openai-key"',
        'openrouter_api_key: "yaml-openrouter-key"',
        "",
      ].join("\n"),
    )

    expect(
      readModelConfig(
        {
          OPENAI_API_KEY: "env-openai-key",
          OPEN_WEB_AGENT_MODEL: "env-model",
        },
        { configPath },
      ),
    ).toEqual({
      defaultModel: "env-model",
      openaiApiKey: "env-openai-key",
      openrouterApiKey: "yaml-openrouter-key",
      parameters: {},
    })
  })
})
