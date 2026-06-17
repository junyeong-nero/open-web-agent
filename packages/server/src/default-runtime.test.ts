import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
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

  it("registers Python agents from a manifest directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "owa-default-runtime-"))
    const agentsDir = join(home, "agents")
    const agentDir = join(agentsDir, "python-fixture-agent")
    await mkdir(agentDir, { recursive: true })
    await writeFile(
      join(agentDir, "agent.yaml"),
      [
        "id: python-fixture-agent",
        "name: Python Fixture Agent",
        "description: Loaded by the default runtime",
        "language: python",
        "entry: main.py",
        "",
      ].join("\n"),
    )
    await writeFile(
      join(agentDir, "main.py"),
      [
        "import json",
        "import sys",
        "json.load(sys.stdin)",
        'print(json.dumps({"ok": True}))',
        "",
      ].join("\n"),
    )
    const runtime = await startDefaultRuntime({
      home,
      agentsDir,
      configPath: join(home, "missing-config.yaml"),
      env: {},
    })

    try {
      const plugins = await fetchPlugins(runtime.url)

      expect(plugins.agents.map((agent) => agent.id)).toContain("python-fixture-agent")
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
      expect(plugins.models[0]).toMatchObject({
        id: "openai",
        name: "OpenAI",
        provider: "openai",
        modelName: "config-model",
        reasoningEffort: "medium",
        contextWindowTokens: 128000,
      })
    } finally {
      await runtime.stop()
    }
  })

  it("emits model inference lifecycle events with usage metadata", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
        return originalFetch(input, init)
      }

      return Response.json({
        id: "chatcmpl_1",
        choices: [
          {
            message: {
              content: JSON.stringify({
                type: "final_answer",
                thought: null,
                finalAnswer: "Example Domain",
                confidence: 1,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 7200, completion_tokens: 40, total_tokens: 7240 },
      })
    }) as typeof fetch

    const home = await mkdtemp(join(tmpdir(), "owa-default-runtime-"))
    const runtime = await startDefaultRuntime({
      home,
      configPath: join(home, "missing-config.yaml"),
      env: {
        OPENAI_API_KEY: "test-openai-key",
        OPEN_WEB_AGENT_MODEL: "gpt-test",
        OPEN_WEB_AGENT_REASONING_EFFORT: "high",
        OPEN_WEB_AGENT_CONTEXT_WINDOW_TOKENS: "400000",
      },
    })

    try {
      const sessionResponse = await fetch(`${runtime.url}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectPath: "/tmp/project" }),
      })
      const session = (await sessionResponse.json()) as { sessionId: string }
      const events: string[] = []
      const completed = new Promise<void>((resolve) => {
        const unsubscribe = runtime.eventBus.subscribe((event) => {
          if (event.type === "run.completed" || event.type === "run.failed") {
            unsubscribe()
            resolve()
          }
        })
      })
      runtime.eventBus.subscribe((event) => {
        if (event.type === "model.called" || event.type === "model.completed") {
          events.push(JSON.stringify(event.payload))
        }
      })

      const runResponse = await fetch(`${runtime.url}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: session.sessionId,
          prompt: "introduce yourself",
          agentId: "simple-react-agent",
          modelId: "openai",
          environmentId: "mock-browser",
        }),
      })
      expect(runResponse.ok).toBe(true)
      await completed

      expect(events.map((payload) => JSON.parse(payload).modelId)).toEqual(["openai", "openai"])
      expect(JSON.parse(events[0]!)).toMatchObject({
        modelId: "openai",
        modelName: "gpt-test",
        provider: "openai",
        reasoningEffort: "high",
        contextWindowTokens: 400000,
      })
      expect(JSON.parse(events[1]!)).toMatchObject({
        response: {
          usage: { inputTokens: 7200, outputTokens: 40, totalTokens: 7240 },
        },
      })
    } finally {
      await runtime.stop()
      globalThis.fetch = originalFetch
    }
  })
})

async function fetchPlugins(url: string): Promise<{
  agents: Array<{ id: string }>
  models: Array<{
    id: string
    name: string
    provider: string
    modelName?: string
    reasoningEffort?: string
    contextWindowTokens?: number
  }>
  environments: Array<{ id: string }>
}> {
  const response = await fetch(`${url}/plugins`)
  expect(response.ok).toBe(true)
  return response.json()
}
