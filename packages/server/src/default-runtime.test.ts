import { describe, expect, it } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startDefaultRuntime } from "./default-runtime"

describe("startDefaultRuntime", () => {
  it("registers selectable agents and browsers even without model keys", async () => {
    const home = await mkdtemp(join(tmpdir(), "owa-default-runtime-"))
    const runtime = await startDefaultRuntime({
      home,
      configPath: join(home, "missing-config.yaml"),
      env: {},
    })

    try {
      const plugins = await fetchPlugins(runtime.url)

      expect(plugins.agents.map((agent) => agent.id)).toEqual(["mock-agent", "simple-react-agent", "see-act", "plan-act-agent"])
      expect(plugins.models.map((model) => model.id)).toEqual([])
      expect(plugins.environments.map((environment) => environment.id)).toEqual(["mock-browser", "playwright-browser"])
    } finally {
      await runtime.stop()
    }
  })

  it("registers configured model providers", async () => {
    const home = await mkdtemp(join(tmpdir(), "owa-default-runtime-"))
    const runtime = await startDefaultRuntime({
      home,
      configPath: join(home, "missing-config.yaml"),
      env: {
        OPENAI_API_KEY: "test-openai-key",
        OPENROUTER_API_KEY: "test-openrouter-key",
        OPEN_WEB_AGENT_MODEL: "test-model",
      },
    })

    try {
      const plugins = await fetchPlugins(runtime.url)

      expect(plugins.models.map((model) => model.id)).toEqual(["openai", "openrouter"])
    } finally {
      await runtime.stop()
    }
  })

  it("registers model providers from YAML config", async () => {
    const home = await mkdtemp(join(tmpdir(), "owa-default-runtime-"))
    const configPath = join(home, "config.yaml")
    await writeFile(
      configPath,
      [
        'default_model: "config-model"',
        'openai_api_key: "config-openai-key"',
        'openrouter_api_key: "config-openrouter-key"',
        "",
      ].join("\n"),
    )

    const runtime = await startDefaultRuntime({
      home,
      configPath,
      env: {},
    })

    try {
      const plugins = await fetchPlugins(runtime.url)

      expect(plugins.models.map((model) => model.id)).toEqual(["openai", "openrouter"])
    } finally {
      await runtime.stop()
    }
  })
})

async function fetchPlugins(url: string): Promise<{
  agents: Array<{ id: string }>
  models: Array<{ id: string }>
  environments: Array<{ id: string }>
}> {
  const response = await fetch(`${url}/plugins`)
  expect(response.ok).toBe(true)
  return response.json()
}
