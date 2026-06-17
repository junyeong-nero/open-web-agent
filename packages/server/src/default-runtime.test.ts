import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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

  it("delegates jsonl Python agent model calls through the runtime-selected model", async () => {
    const originalFetch = globalThis.fetch
    const providerRequests: unknown[] = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
        return originalFetch(input, init)
      }

      providerRequests.push(JSON.parse(String(init?.body ?? "{}")))
      return Response.json({
        id: "chatcmpl_python_runtime",
        choices: [{ message: { content: "delegated runtime model answer" } }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      })
    }) as typeof fetch

    const home = await mkdtemp(join(tmpdir(), "owa-default-runtime-"))
    const agentsDir = join(home, "agents")
    const agentDir = join(agentsDir, "runtime-model-agent")
    await mkdir(agentDir, { recursive: true })
    await writeFile(
      join(agentDir, "agent.yaml"),
      [
        "id: runtime-model-agent",
        "name: Runtime Model Agent",
        "description: Delegates to runtime model",
        "language: python",
        "entry: main.py",
        "protocol: jsonl",
        "",
      ].join("\n"),
    )
    await writeFile(
      join(agentDir, "main.py"),
      [
        "import json",
        "import sys",
        "request = json.loads(sys.stdin.readline())",
        'if request["method"] == "initialize":',
        '    print(json.dumps({"ok": True}), flush=True)',
        "    raise SystemExit(0)",
        'if request["method"] == "finalize":',
        '    print(json.dumps({"finalAnswer": request["state"].get("finalAnswer") or ""}), flush=True)',
        "    raise SystemExit(0)",
        'print(json.dumps({"command":"model.complete","id":"model_1","request":{"model":"gpt-test","messages":[{"role":"user","content":request["state"]["prompt"]}],"temperature":0,"responseFormat":"text"}}), flush=True)',
        "model_response = json.loads(sys.stdin.readline())",
        'print(json.dumps({"decision":{"type":"final_answer","thought":None,"finalAnswer":model_response["response"]["text"],"confidence":1}}), flush=True)',
        "",
      ].join("\n"),
    )
    const runtime = await startDefaultRuntime({
      home,
      agentsDir,
      configPath: join(home, "missing-config.yaml"),
      env: {
        OPENAI_API_KEY: "test-openai-key",
        OPEN_WEB_AGENT_MODEL: "gpt-test",
      },
    })

    try {
      const modelEvents: string[] = []
      const completed = new Promise<{ type: string; payload: Record<string, unknown> }>((resolve) => {
        const unsubscribe = runtime.eventBus.subscribe((event) => {
          if (event.type === "model.called" || event.type === "model.completed") {
            modelEvents.push(event.type)
          }
          if (event.type === "run.completed" || event.type === "run.failed") {
            unsubscribe()
            resolve({ type: event.type, payload: event.payload })
          }
        })
      })
      const sessionResponse = await fetch(`${runtime.url}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectPath: "/tmp/project" }),
      })
      const session = (await sessionResponse.json()) as { sessionId: string }
      const runResponse = await fetch(`${runtime.url}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: session.sessionId,
          prompt: "delegate through runtime",
          agentId: "runtime-model-agent",
          modelId: "openai",
          environmentId: "mock-browser",
        }),
      })
      expect(runResponse.ok).toBe(true)

      const result = await completed

      expect(result).toEqual({
        type: "run.completed",
        payload: { finalAnswer: "delegated runtime model answer" },
      })
      expect(modelEvents).toEqual(["model.called", "model.completed"])
      expect((providerRequests[0] as { messages: Array<{ content: string }> }).messages[0]?.content).toBe(
        "delegate through runtime",
      )
    } finally {
      await runtime.stop()
      globalThis.fetch = originalFetch
    }
  })

  it("loads the project-local plan-act external agent and emits plan events", async () => {
    const originalFetch = globalThis.fetch
    const providerResponses = [
      JSON.stringify({
        items: [
          { id: "inspect", title: "Inspect the current page", status: "active" },
          { id: "answer", title: "Answer the user", status: "pending" },
        ],
      }),
      JSON.stringify({
        type: "final_answer",
        thought: "The page is already sufficient.",
        finalAnswer: "external plan-act answered",
        confidence: 1,
      }),
    ]
    globalThis.fetch = (async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
        return originalFetch(input, init)
      }

      return Response.json({
        id: "chatcmpl_plan_act",
        choices: [{ message: { content: providerResponses.shift() ?? providerResponses.at(-1) ?? "{}" } }],
      })
    }) as typeof fetch

    const home = await mkdtemp(join(tmpdir(), "owa-default-runtime-"))
    const runtime = await startDefaultRuntime({
      home,
      agentsDir: resolve(import.meta.dir, "../../../agents"),
      configPath: join(home, "missing-config.yaml"),
      env: {
        OPENAI_API_KEY: "test-openai-key",
        OPEN_WEB_AGENT_MODEL: "gpt-test",
      },
    })

    try {
      const plugins = await fetchPlugins(runtime.url)
      expect(plugins.agents.map((agent) => agent.id)).toContain("plan-act")

      const eventTypes: string[] = []
      const completed = new Promise<{ type: string; payload: Record<string, unknown> }>((resolveDone) => {
        const unsubscribe = runtime.eventBus.subscribe((event) => {
          if (event.type === "plan.created" || event.type === "run.completed" || event.type === "run.failed") {
            eventTypes.push(event.type)
          }
          if (event.type === "run.completed" || event.type === "run.failed") {
            unsubscribe()
            resolveDone({ type: event.type, payload: event.payload })
          }
        })
      })
      const sessionResponse = await fetch(`${runtime.url}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectPath: "/tmp/project" }),
      })
      const session = (await sessionResponse.json()) as { sessionId: string }
      const runResponse = await fetch(`${runtime.url}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: session.sessionId,
          prompt: "inspect and answer",
          agentId: "plan-act",
          modelId: "openai",
          environmentId: "mock-browser",
        }),
      })
      expect(runResponse.ok).toBe(true)

      const result = await completed

      expect(eventTypes).toEqual(["plan.created", "run.completed"])
      expect(result).toEqual({
        type: "run.completed",
        payload: { finalAnswer: "external plan-act answered" },
      })
    } finally {
      await runtime.stop()
      globalThis.fetch = originalFetch
    }
  })

  it("runs text-vision mixed grounding through the runtime model with text and screenshot content", async () => {
    const originalFetch = globalThis.fetch
    const providerRequests: unknown[] = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
        return originalFetch(input, init)
      }

      providerRequests.push(JSON.parse(String(init?.body ?? "{}")))
      return Response.json({
        id: "chatcmpl_text_vision",
        choices: [{ message: { content: "vision model grounded answer" } }],
      })
    }) as typeof fetch

    const home = await mkdtemp(join(tmpdir(), "owa-default-runtime-"))
    const runtime = await startDefaultRuntime({
      home,
      agentsDir: resolve(import.meta.dir, "../../../agents"),
      configPath: join(home, "missing-config.yaml"),
      env: {
        OPENAI_API_KEY: "test-openai-key",
        OPEN_WEB_AGENT_MODEL: "gpt-test",
      },
    })

    try {
      const completed = new Promise<{ type: string; payload: Record<string, unknown> }>((resolveDone) => {
        const unsubscribe = runtime.eventBus.subscribe((event) => {
          if (event.type === "run.completed" || event.type === "run.failed") {
            unsubscribe()
            resolveDone({ type: event.type, payload: event.payload })
          }
        })
      })
      const sessionResponse = await fetch(`${runtime.url}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectPath: "/tmp/project" }),
      })
      const session = (await sessionResponse.json()) as { sessionId: string }
      const runResponse = await fetch(`${runtime.url}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: session.sessionId,
          prompt: "Use mixed grounding on example.com",
          agentId: "text-vision-mixed-grounding",
          modelId: "openai",
          environmentId: "mock-browser",
        }),
      })
      expect(runResponse.ok).toBe(true)

      const result = await completed
      const providerBody = providerRequests[0] as { messages: Array<{ role: string; content: unknown }> } | undefined
      const userContent = providerBody?.messages.find((message) => message.role === "user")?.content
      const contentParts = Array.isArray(userContent) ? userContent : []
      const imagePart = contentParts.find((part) => isRecord(part) && part.type === "image_url")

      expect(result).toEqual({
        type: "run.completed",
        payload: { finalAnswer: "vision model grounded answer" },
      })
      expect(contentParts).toContainEqual(expect.objectContaining({ type: "text" }))
      expect(imagePart).toMatchObject({
        type: "image_url",
        image_url: { url: expect.stringContaining("data:") },
      })
    } finally {
      await runtime.stop()
      globalThis.fetch = originalFetch
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

  it("lets env configure model-backed agent call timeouts", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
        return originalFetch(input, init)
      }

      return new Promise<Response>(() => {})
    }) as typeof fetch

    const home = await mkdtemp(join(tmpdir(), "owa-default-runtime-"))
    const runtime = await startDefaultRuntime({
      home,
      configPath: join(home, "missing-config.yaml"),
      env: {
        OPENAI_API_KEY: "test-openai-key",
        OPEN_WEB_AGENT_MODEL: "gpt-test",
        OPEN_WEB_AGENT_MODEL_TIMEOUT_MS: "5",
      },
    })
    let runId: string | null = null
    let waitForSettled: Promise<void> = Promise.resolve()

    try {
      const sessionResponse = await fetch(`${runtime.url}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectPath: "/tmp/project" }),
      })
      const session = (await sessionResponse.json()) as { sessionId: string }
      waitForSettled = new Promise<void>((resolve) => {
        const unsubscribe = runtime.eventBus.subscribe((event) => {
          if (event.type === "run.failed" || event.type === "run.cancelled" || event.type === "run.completed") {
            unsubscribe()
            resolve()
          }
        })
      })
      const failed = new Promise<string>((resolve) => {
        const unsubscribe = runtime.eventBus.subscribe((event) => {
          if (event.type === "run.failed") {
            unsubscribe()
            resolve(String(event.payload.message ?? ""))
          }
        })
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
      runId = ((await runResponse.json()) as { runId: string }).runId

      const message = await Promise.race([
        failed,
        new Promise<string>((resolve) => setTimeout(() => resolve("run did not settle"), 200)),
      ])
      expect(message).toBe("Model call timed out after 5ms")
    } finally {
      if (runId) {
        await fetch(`${runtime.url}/runs/${runId}/cancel`, { method: "POST" }).catch(() => null)
        await Promise.race([waitForSettled, new Promise((resolve) => setTimeout(resolve, 200))])
      }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
