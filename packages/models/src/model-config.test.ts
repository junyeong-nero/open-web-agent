import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "yaml"
import {
  readModelConfig,
  resolveModelConfigPath,
  resolveProviderDefaultModel,
  writeAgentSelectionConfig,
  writeBrowserSelectionConfig,
  writeModelSelectionConfig,
} from "./model-config"

describe("readModelConfig", () => {
  it("resolves the default user config path", () => {
    expect(resolveModelConfigPath()).toBe(join(homedir(), ".open-web-agent", "config.yaml"))
    expect(resolveModelConfigPath({}, "/tmp/owa-home")).toBe("/tmp/owa-home/.open-web-agent/config.yaml")
    expect(resolveModelConfigPath({ OWA_HOME: "/tmp/owa-custom" }, "/tmp/owa-home")).toBe(
      "/tmp/owa-custom/config.yaml",
    )
  })

  it("reads default config from OWA_HOME config.yaml", async () => {
    const home = await mkdtemp(join(tmpdir(), "owa-home-config-"))
    await writeFile(join(home, "config.yaml"), ['model: "owa-home-model"', ""].join("\n"))

    expect(readModelConfig({ OWA_HOME: home }, { homeDir: "/tmp/unused-home" }).defaultModel).toBe("owa-home-model")
  })

  it("falls back to legacy user config when the unified config does not exist", async () => {
    const home = await mkdtemp(join(tmpdir(), "owa-legacy-config-"))
    await mkdir(join(home, ".openwebagents"), { recursive: true })
    await writeFile(join(home, ".openwebagents", "config.yaml"), ['model: "legacy-model"', ""].join("\n"))

    expect(readModelConfig({}, { homeDir: home }).defaultModel).toBe("legacy-model")
  })

  it("uses OpenRouter Nemotron as the built-in default model", () => {
    expect(readModelConfig({}, { configPath: "/tmp/missing-open-web-agent-config.yaml" })).toMatchObject({
      defaultModel: "nvidia/nemotron-3-super-120b-a12b:free",
    })
  })

  it("maps the built-in default model to provider-specific direct API defaults", () => {
    const builtInDefault = "nvidia/nemotron-3-super-120b-a12b:free"

    expect(resolveProviderDefaultModel("openrouter", builtInDefault)).toBe(builtInDefault)
    expect(resolveProviderDefaultModel("openai", builtInDefault)).toBe("gpt-4.1-mini")
    expect(resolveProviderDefaultModel("gemini", builtInDefault)).toBe("gemini-3.5-flash")
    expect(resolveProviderDefaultModel("claude", builtInDefault)).toBe("claude-sonnet-4-6")
    expect(resolveProviderDefaultModel("gemini", "custom-model")).toBe("custom-model")
  })

  it("uses a persisted model name only for the selected runtime provider", () => {
    expect(resolveProviderDefaultModel("openai", "gpt-5.4-mini", "openai:gpt-5.4-mini")).toBe("gpt-5.4-mini")
    expect(resolveProviderDefaultModel("gemini", "gpt-5.4-mini", "openai:gpt-5.4-mini")).toBe("gemini-3.5-flash")
    expect(resolveProviderDefaultModel("claude", "gpt-5.4-mini", "openai:gpt-5.4-mini")).toBe("claude-sonnet-4-6")
    expect(resolveProviderDefaultModel("openrouter", "gpt-5.4-mini", "openai:gpt-5.4-mini")).toBe(
      "nvidia/nemotron-3-super-120b-a12b:free",
    )
  })

  it("reads provider keys and default model from env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-model-config-"))
    expect(
      readModelConfig(
        {
          OPENAI_API_KEY: "openai-key",
          OPENROUTER_API_KEY: "openrouter-key",
          GEMINI_API_KEY: "gemini-key",
          ANTHROPIC_API_KEY: "anthropic-key",
          OPEN_WEB_AGENT_MODEL: "custom-model",
          OPEN_WEB_AGENT_MODEL_PROVIDER: "codex-oauth",
          OPEN_WEB_AGENT_AGENT: "env-agent",
          OPEN_WEB_AGENT_BROWSER: "env-browser",
          OPEN_WEB_AGENT_BROWSER_HEADLESS: "true",
          OPEN_WEB_AGENT_BROWSER_PREVENT_FOCUS: "true",
          OPEN_WEB_AGENT_REASONING_EFFORT: "high",
          OPEN_WEB_AGENT_CONTEXT_WINDOW_TOKENS: "256000",
          OPEN_WEB_AGENT_MAX_RETRY: "3",
          OPEN_WEB_AGENT_CODEX_AUTH_PATH: "/tmp/codex-auth.json",
        },
        { configPath: join(dir, "missing-config.yaml") },
      ),
    ).toEqual({
      defaultModel: "custom-model",
      defaultModelProvider: "codex-oauth",
      defaultAgentId: "env-agent",
      defaultBrowserId: "env-browser",
      browserHeadless: true,
      browserPreventFocus: true,
      reasoningEffort: "high",
      contextWindowTokens: 256000,
      maxRetry: 3,
      openaiApiKey: "openai-key",
      openrouterApiKey: "openrouter-key",
      geminiApiKey: "gemini-key",
      anthropicApiKey: "anthropic-key",
      codexAuthPath: "/tmp/codex-auth.json",
      parameters: {},
    })
  })

  it("reads the browser headless preference from env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-model-config-"))

    expect(
      readModelConfig(
        {
          OPEN_WEB_AGENT_BROWSER_HEADLESS: "true",
        },
        { configPath: join(dir, "missing-config.yaml") },
      ).browserHeadless,
    ).toBe(true)

    expect(
      readModelConfig(
        {
          OPEN_WEB_AGENT_BROWSER_HEADLESS: "false",
        },
        { configPath: join(dir, "missing-config.yaml") },
      ).browserHeadless,
    ).toBe(false)
  })

  it("reads provider keys and default model from a YAML config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-model-config-"))
    const configPath = join(dir, "config.yaml")
    await writeFile(
      configPath,
      [
        'model: "yaml-model"',
        'model_provider: "codex-oauth"',
        'agent: "yaml-agent"',
        'browser: "yaml-browser"',
        "browser_headless: true",
        "browser_prevent_focus: true",
        'reasoning_effort: "low"',
        "context_window_tokens: 64000",
        "max_retry: 2",
        'openai_api_key: "yaml-openai-key"',
        'openrouter_api_key: "yaml-openrouter-key"',
        'gemini_api_key: "yaml-gemini-key"',
        'anthropic_api_key: "yaml-anthropic-key"',
        'codex_auth_path: "/tmp/yaml-codex-auth.json"',
        "",
      ].join("\n"),
    )

    expect(readModelConfig({}, { configPath })).toEqual({
      defaultModel: "yaml-model",
      defaultModelProvider: "codex-oauth",
      defaultAgentId: "yaml-agent",
      defaultBrowserId: "yaml-browser",
      browserHeadless: true,
      browserPreventFocus: true,
      reasoningEffort: "low",
      contextWindowTokens: 64000,
      maxRetry: 2,
      openaiApiKey: "yaml-openai-key",
      openrouterApiKey: "yaml-openrouter-key",
      geminiApiKey: "yaml-gemini-key",
      anthropicApiKey: "yaml-anthropic-key",
      codexAuthPath: "/tmp/yaml-codex-auth.json",
      parameters: {},
    })
  })

  it("reads the browser headless preference from a YAML config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-model-config-"))
    const configPath = join(dir, "config.yaml")
    await writeFile(configPath, ["browser_headless: true", ""].join("\n"))

    expect(readModelConfig({}, { configPath }).browserHeadless).toBe(true)
  })

  it("accepts headless as an alias for browser_headless", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-model-config-"))
    const configPath = join(dir, "config.yaml")
    await writeFile(configPath, ["headless: true", ""].join("\n"))

    expect(readModelConfig({}, { configPath }).browserHeadless).toBe(true)
  })

  it("expands a home-relative Codex auth path from YAML config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-model-config-"))
    const configPath = join(dir, "config.yaml")
    await writeFile(configPath, ['codex_auth_path: "~/.codex/custom-auth.json"', ""].join("\n"))

    expect(readModelConfig({}, { configPath }).codexAuthPath).toBe(join(homedir(), ".codex", "custom-auth.json"))
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
      defaultModelProvider: null,
      defaultAgentId: null,
      defaultBrowserId: null,
      browserHeadless: false,
      browserPreventFocus: false,
      reasoningEffort: "medium",
      contextWindowTokens: 128000,
      maxRetry: 0,
      openaiApiKey: null,
      openrouterApiKey: null,
      geminiApiKey: null,
      anthropicApiKey: null,
      codexAuthPath: join(homedir(), ".codex", "auth.json"),
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
        'agent: "yaml-agent"',
        'browser: "yaml-browser"',
        'reasoning_effort: "low"',
        "context_window_tokens: 64000",
        "max_retry: 1",
        'openai_api_key: "yaml-openai-key"',
        'openrouter_api_key: "yaml-openrouter-key"',
        'gemini_api_key: "yaml-gemini-key"',
        'anthropic_api_key: "yaml-anthropic-key"',
        'codex_auth_path: "/tmp/yaml-codex-auth.json"',
        "",
      ].join("\n"),
    )

    expect(
      readModelConfig(
        {
          OPENAI_API_KEY: "env-openai-key",
          GEMINI_API_KEY: "env-gemini-key",
          ANTHROPIC_API_KEY: "env-anthropic-key",
          OPEN_WEB_AGENT_MODEL: "env-model",
          OPEN_WEB_AGENT_MODEL_PROVIDER: "env-provider",
          OPEN_WEB_AGENT_AGENT: "env-agent",
          OPEN_WEB_AGENT_BROWSER: "env-browser",
          OPEN_WEB_AGENT_BROWSER_HEADLESS: "true",
          OPEN_WEB_AGENT_BROWSER_PREVENT_FOCUS: "true",
          OPEN_WEB_AGENT_REASONING_EFFORT: "medium",
          OPEN_WEB_AGENT_CONTEXT_WINDOW_TOKENS: "128000",
          OPEN_WEB_AGENT_MAX_RETRY: "4",
          OPEN_WEB_AGENT_CODEX_AUTH_PATH: "/tmp/env-codex-auth.json",
        },
        { configPath },
      ),
    ).toEqual({
      defaultModel: "env-model",
      defaultModelProvider: "env-provider",
      defaultAgentId: "env-agent",
      defaultBrowserId: "env-browser",
      browserHeadless: true,
      browserPreventFocus: true,
      reasoningEffort: "medium",
      contextWindowTokens: 128000,
      maxRetry: 4,
      openaiApiKey: "env-openai-key",
      openrouterApiKey: "yaml-openrouter-key",
      geminiApiKey: "env-gemini-key",
      anthropicApiKey: "env-anthropic-key",
      codexAuthPath: "/tmp/env-codex-auth.json",
      parameters: {},
    })
  })

  it("uses display defaults for reasoning effort and context window", () => {
    expect(readModelConfig({}, { configPath: "/tmp/missing-open-web-agent-config.yaml" })).toMatchObject({
      defaultModelProvider: null,
      defaultAgentId: null,
      defaultBrowserId: null,
      browserHeadless: false,
      browserPreventFocus: false,
      reasoningEffort: "medium",
      contextWindowTokens: 128000,
      maxRetry: 0,
    })
  })

  it("persists selected model provider and model name while preserving existing config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-model-config-"))
    const configPath = join(dir, ".open-web-agent", "config.yaml")
    await mkdir(join(dir, ".open-web-agent"), { recursive: true })
    await writeFile(
      configPath,
      [
        'openai_api_key: "yaml-openai-key"',
        "parameters:",
        "  temperature: 0.25",
        "unknown_key: keep-me",
        "",
      ].join("\n"),
    )

    await writeModelSelectionConfig({ modelId: "codex-oauth", modelName: "gpt-5.5", reasoningEffort: "high" }, { configPath })

    expect(parse(await readFile(configPath, "utf8"))).toMatchObject({
      model: "gpt-5.5",
      model_provider: "codex-oauth",
      reasoning_effort: "high",
      openai_api_key: "yaml-openai-key",
      parameters: { temperature: 0.25 },
      unknown_key: "keep-me",
    })
  })

  it("persists selected model provider to the unified config while preserving legacy config", async () => {
    const home = await mkdtemp(join(tmpdir(), "owa-legacy-write-config-"))
    const legacyConfigPath = join(home, ".openwebagents", "config.yaml")
    const configPath = join(home, ".open-web-agent", "config.yaml")
    await mkdir(join(home, ".openwebagents"), { recursive: true })
    await writeFile(
      legacyConfigPath,
      [
        'openai_api_key: "yaml-openai-key"',
        "parameters:",
        "  temperature: 0.25",
        "unknown_key: keep-me",
        "",
      ].join("\n"),
    )

    await writeModelSelectionConfig(
      { modelId: "codex-oauth", modelName: "gpt-5.5", reasoningEffort: "high" },
      { env: {}, homeDir: home },
    )

    expect(parse(await readFile(configPath, "utf8"))).toMatchObject({
      model: "gpt-5.5",
      model_provider: "codex-oauth",
      reasoning_effort: "high",
      openai_api_key: "yaml-openai-key",
      parameters: { temperature: 0.25 },
      unknown_key: "keep-me",
    })
  })

  it("persists selected agent and browser while preserving existing config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-runtime-config-"))
    const configPath = join(dir, ".open-web-agent", "config.yaml")
    await mkdir(join(dir, ".open-web-agent"), { recursive: true })
    await writeFile(
      configPath,
      [
        'model: "gpt-5.5"',
        'model_provider: "codex-oauth"',
        "parameters:",
        "  temperature: 0.25",
        "unknown_key: keep-me",
        "",
      ].join("\n"),
    )

    await writeAgentSelectionConfig({ agentId: "plan-act" }, { configPath })
    await writeBrowserSelectionConfig({ browserId: "playwright-browser" }, { configPath })

    expect(parse(await readFile(configPath, "utf8"))).toMatchObject({
      model: "gpt-5.5",
      model_provider: "codex-oauth",
      agent: "plan-act",
      browser: "playwright-browser",
      parameters: { temperature: 0.25 },
      unknown_key: "keep-me",
    })
    expect(readModelConfig({}, { configPath })).toMatchObject({
      defaultAgentId: "plan-act",
      defaultBrowserId: "playwright-browser",
    })
  })
})
