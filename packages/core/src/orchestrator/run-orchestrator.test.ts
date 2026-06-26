import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentDecision } from "../contracts/agent"
import {
  BrowserToolCallSchema,
  type ActionResult,
  type BrowserCapability,
  type BrowserToolCall,
  type BrowserToolDefinition,
  type Observation,
} from "../contracts/browser"
import type { RunEvent } from "../contracts/event"
import type { AgentPlugin, BrowserEnvironment, ToolAdapter } from "../contracts/plugin"
import type { ModelToolCall, ModelToolResult } from "../contracts/model"
import { EventBus } from "../events/event-bus"
import { redactSensitiveData } from "../redaction/sensitive-data"
import { PluginRegistry } from "../registry/plugin-registry"
import { JsonlEventStore } from "../storage/jsonl-event-store"
import { eventsPath, hashProjectPath } from "../storage/paths"
import type { AgentState, RuntimeContext, SessionState } from "./run-state"
import { RunOrchestrator } from "./run-orchestrator"

const finalAnswer = '페이지 제목은 "Example Domain"입니다.'

class TestAgent implements AgentPlugin {
  id = "test-agent"
  name = "Test Agent"
  description = "Deterministic test agent."

  async initialize(): Promise<void> {}

  async step(state: AgentState): Promise<AgentDecision> {
    if (state.steps.length === 0) {
      return {
        type: "browser_actions",
        thought: "Inspect Example Domain.",
        actions: [
          {
            id: "action_0001",
            kind: "inspect_page_title",
            reason: null,
            requiresApproval: false,
            toolCalls: [
              { id: "tool_0001", type: "navigate", url: "https://example.com" },
              { id: "tool_0002", type: "screenshot" },
              { id: "tool_0003", type: "extract_text" },
            ],
          },
        ],
      }
    }

    return { type: "final_answer", thought: null, finalAnswer, confidence: 1 }
  }

  async finalize(state: AgentState): Promise<string> {
    return state.finalAnswer ?? finalAnswer
  }
}

class ToolResultCapturingAgent extends TestAgent {
  results: ModelToolResult[][] = []

  override async step(state: AgentState): Promise<AgentDecision> {
    this.results.push(state.steps.flatMap((step) => step.modelToolResults))
    return super.step(state)
  }
}

class TestEnvironment implements BrowserEnvironment {
  id = "test-browser"
  name = "Test Browser"
  observeCalls = 0
  private observation: Observation = {
    url: "about:blank",
    title: null,
    text: null,
    screenshotPath: null,
    interactiveElements: [],
    metadata: {},
  }

  constructor(private readonly delayMs = 0) {}

  async reset(): Promise<void> {
    this.observation = {
      url: "about:blank",
      title: null,
      text: null,
      screenshotPath: null,
      interactiveElements: [],
      metadata: {},
    }
  }

  async observe(): Promise<Observation> {
    this.observeCalls += 1
    return this.observation
  }

  async applyBrowserTool(call: BrowserToolCall, ctx: RuntimeContext): Promise<ActionResult> {
    await delay(this.delayMs, ctx.abortSignal)

    if (call.type === "navigate") {
      this.observation = {
        url: "https://example.com/",
        title: "Example Domain",
        text: "Example Domain\nThis domain is for use in illustrative examples in documents.",
        screenshotPath: null,
        interactiveElements: [],
        metadata: {},
      }
    }

    if (call.type === "screenshot") {
      this.observation = { ...this.observation, screenshotPath: join(ctx.runDir, "screenshots", "step-0001.txt") }
    }

    return { ok: true, message: call.type, observation: this.observation, metadata: { type: call.type } }
  }

  async close(): Promise<void> {}
}

class TestBrowserToolAdapter implements ToolAdapter {
  id = "test-browser-tools"
  name = "Test Browser Tools"
  environmentId = "test-browser"
  supportedCapabilities: BrowserCapability[] = ["core"]
  calls: BrowserToolCall[] = []

  constructor(
    protected readonly environment: TestEnvironment,
    private readonly tools: BrowserToolDefinition[] = coreToolDefinitions(),
  ) {}

  listTools(capabilities: BrowserCapability[]): BrowserToolDefinition[] {
    const enabled = new Set(capabilities)
    return this.tools.filter((tool) => enabled.has(tool.capability))
  }

  parseToolCall(call: ModelToolCall, capabilities: BrowserCapability[]): BrowserToolCall {
    const definition = this.listTools(capabilities).find((tool) => tool.name === call.name)
    if (!definition) throw new Error(`Unknown browser tool: ${call.name}`)
    return BrowserToolCallSchema.parse({
      id: call.id,
      type: definition.type,
      ...(isRecord(call.arguments) ? call.arguments : {}),
    })
  }

  validateToolCall(call: BrowserToolCall, capabilities: BrowserCapability[]): BrowserToolCall {
    const definition = this.listTools(capabilities).find((tool) => tool.type === call.type)
    if (!definition) throw new Error(`Unknown browser tool type: ${call.type}`)
    return BrowserToolCallSchema.parse(call)
  }

  modelToolName(call: BrowserToolCall): string {
    return this.tools.find((tool) => tool.type === call.type)?.name ?? `browser_${call.type}`
  }

  requiresApproval(call: BrowserToolCall): boolean {
    return this.tools.find((tool) => tool.type === call.type)?.requiresApproval ?? false
  }

  async execute(call: BrowserToolCall, ctx: RuntimeContext): Promise<ActionResult> {
    this.calls.push(call)
    return this.environment.applyBrowserTool(call, ctx)
  }
}

class ToolCatalogAgent implements AgentPlugin {
  id = "tool-catalog-agent"
  name = "Tool Catalog Agent"
  description = "Captures runtime browser tools."
  browserTools: BrowserToolDefinition[] = []

  async initialize(): Promise<void> {}

  async step(_state: AgentState, ctx: RuntimeContext): Promise<AgentDecision> {
    this.browserTools = ctx.browserTools
    return { type: "final_answer", thought: null, finalAnswer: "done", confidence: 1 }
  }

  async finalize(state: AgentState): Promise<string> {
    return state.finalAnswer ?? ""
  }
}

class RecoveringAgent implements AgentPlugin {
  id = "recovering-agent"
  name = "Recovering Agent"
  description = "Retries after a failed browser action."
  failedResultsSeen: number[] = []

  async initialize(): Promise<void> {}

  async step(state: AgentState): Promise<AgentDecision> {
    this.failedResultsSeen.push(state.steps.flatMap((step) => step.actionResults).filter((result) => !result.ok).length)

    if (state.steps.length === 0) {
      return {
        type: "browser_actions",
        thought: "Try the brittle selector first.",
        actions: [
          {
            id: "action_brittle",
            kind: "click_brittle_result",
            reason: null,
            requiresApproval: false,
            toolCalls: [{ id: "tool_brittle", type: "click", target: target("#missing-result") }],
          },
        ],
      }
    }

    if (state.steps.length === 1) {
      return {
        type: "browser_actions",
        thought: "Retry with a stable navigation.",
        actions: [
          {
            id: "action_retry",
            kind: "navigate_directly",
            reason: null,
            requiresApproval: false,
            toolCalls: [{ id: "tool_retry", type: "navigate", url: "https://example.com" }],
          },
        ],
      }
    }

    return { type: "final_answer", thought: null, finalAnswer, confidence: 1 }
  }

  async finalize(state: AgentState): Promise<string> {
    return state.finalAnswer ?? finalAnswer
  }
}

class SensitiveTypingAgent implements AgentPlugin {
  id = "sensitive-typing-agent"
  name = "Sensitive Typing Agent"
  description = "Types a sensitive value for redaction tests."

  async initialize(): Promise<void> {}

  async step(state: AgentState): Promise<AgentDecision> {
    if (state.steps.length === 0) {
      return {
        type: "browser_actions",
        thought: "Enter the password.",
        actions: [
          {
            id: "action_password",
            kind: "enter_password",
            reason: null,
            requiresApproval: false,
            toolCalls: [
              {
                id: "tool_password",
                type: "type",
                target: target("#password"),
                value: "new-secret",
              },
            ],
          },
        ],
      }
    }

    return { type: "final_answer", thought: null, finalAnswer: "done", confidence: 1 }
  }

  async finalize(state: AgentState): Promise<string> {
    return state.finalAnswer ?? ""
  }
}

class ApprovalRequiredAgent implements AgentPlugin {
  id = "approval-required-agent"
  name = "Approval Required Agent"
  description = "Requests an approval-gated browser action."
  failedResultsSeen: number[] = []

  async initialize(): Promise<void> {}

  async step(state: AgentState): Promise<AgentDecision> {
    this.failedResultsSeen.push(state.steps.flatMap((step) => step.actionResults).filter((result) => !result.ok).length)

    if (state.steps.length === 0) {
      return {
        type: "browser_actions",
        thought: "Navigate only after human approval.",
        actions: [
          {
            id: "action_requires_approval",
            kind: "navigate_sensitive_page",
            reason: "Sensitive action requires explicit approval.",
            requiresApproval: false,
            toolCalls: [{ id: "tool_sensitive_nav", type: "navigate", url: "https://example.com" }],
          },
        ],
      }
    }

    return { type: "final_answer", thought: null, finalAnswer: "approval requested", confidence: 1 }
  }

  async finalize(state: AgentState): Promise<string> {
    return state.finalAnswer ?? "approval requested"
  }
}

function target(selector: string): Extract<BrowserToolCall, { type: "click" | "type" }>["target"] {
  return {
    elementId: null,
    selector,
    text: null,
    role: null,
    name: null,
    coordinates: null,
  }
}

function coreToolDefinitions(): BrowserToolDefinition[] {
  const definitions: Array<Pick<BrowserToolDefinition, "name" | "type" | "readOnly">> = [
    { name: "browser_navigate", type: "navigate", readOnly: false },
    { name: "browser_click", type: "click", readOnly: false },
    { name: "browser_type", type: "type", readOnly: false },
    { name: "browser_take_screenshot", type: "screenshot", readOnly: true },
    { name: "browser_extract_text", type: "extract_text", readOnly: true },
  ]
  return definitions.map((definition) => ({
    ...definition,
    capability: "core",
    description: definition.name,
    inputSchema: { type: "object" },
    requiresApproval: false,
    parameters: [],
    example: {},
  }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

class ThrowingBrowserToolAdapter extends TestBrowserToolAdapter {
  async execute(call: BrowserToolCall, ctx: RuntimeContext): Promise<ActionResult> {
    this.calls.push(call)
    if (call.type === "click") {
      throw new Error("locator.click: Timeout 30000ms exceeded")
    }
    return this.environment.applyBrowserTool(call, ctx)
  }
}

class FailedResultBrowserToolAdapter extends TestBrowserToolAdapter {
  async execute(call: BrowserToolCall, ctx: RuntimeContext): Promise<ActionResult> {
    this.calls.push(call)
    if (call.type === "click") {
      return {
        ok: false,
        message: "No matching click target found",
        observation: await this.environment.observe(),
        metadata: {},
      }
    }
    return this.environment.applyBrowserTool(call, ctx)
  }
}

class NullObservationBrowserToolAdapter extends TestBrowserToolAdapter {
  async execute(call: BrowserToolCall, ctx: RuntimeContext): Promise<ActionResult> {
    this.calls.push(call)
    const result = await this.environment.applyBrowserTool(call, ctx)
    return { ...result, observation: null }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Run cancelled", "AbortError"))
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout)
        reject(new DOMException("Run cancelled", "AbortError"))
      },
      { once: true },
    )
  })
}

function session(): SessionState {
  const projectPath = "/tmp/open-web-agent-test-project"
  return {
    id: "ses_1",
    projectPath,
    projectHash: hashProjectPath(projectPath),
    createdAt: "2026-06-17T00:00:00.000Z",
  }
}

async function orchestrator(delayMs = 0): Promise<{
  orchestrator: RunOrchestrator
  observedEvents: RunEvent[]
  toolAdapter: TestBrowserToolAdapter
  home: string
}> {
  const eventBus = new EventBus()
  const observedEvents: RunEvent[] = []
  eventBus.subscribe((event) => {
    observedEvents.push(event)
  })

  const registry = new PluginRegistry()
  const environment = new TestEnvironment(delayMs)
  const toolAdapter = new TestBrowserToolAdapter(environment)
  registry.registerAgent(new TestAgent())
  registry.registerEnvironment(environment)
  registry.registerToolAdapter(toolAdapter)

  const home = await mkdtemp(join(tmpdir(), "owa-orchestrator-"))

  return {
    orchestrator: new RunOrchestrator({
      home,
      eventBus,
      registry,
      agentId: "test-agent",
      environmentId: "test-browser",
      maxSteps: 4,
      now: () => new Date("2026-06-17T00:00:00.000Z"),
    }),
    observedEvents,
    toolAdapter,
    home,
  }
}

async function orchestratorWith(agent: AgentPlugin, environment: TestEnvironment, toolAdapter: ToolAdapter): Promise<{
  orchestrator: RunOrchestrator
  observedEvents: RunEvent[]
  home: string
}> {
  const eventBus = new EventBus()
  const observedEvents: RunEvent[] = []
  eventBus.subscribe((event) => {
    observedEvents.push(event)
  })

  const registry = new PluginRegistry()
  registry.registerAgent(agent)
  registry.registerEnvironment(environment)
  registry.registerToolAdapter(toolAdapter)

  const home = await mkdtemp(join(tmpdir(), "owa-orchestrator-"))

  return {
    orchestrator: new RunOrchestrator({
      home,
      eventBus,
      registry,
      agentId: agent.id,
      environmentId: environment.id,
      maxSteps: 4,
      now: () => new Date("2026-06-17T00:00:00.000Z"),
    }),
    observedEvents,
    home,
  }
}

describe("RunOrchestrator", () => {
  it("completes the deterministic Example Domain test run", async () => {
    const setup = await orchestrator()
    const runSession = session()
    const started = setup.orchestrator.startRun({
      session: runSession,
      prompt: "example.com에 접속해서 페이지 제목을 알려줘",
    })

    const result = await started.result

    expect(result.finalAnswer).toBe(finalAnswer)
    expect(setup.toolAdapter.calls.map((call) => call.type)).toEqual(["navigate", "screenshot", "extract_text"])
    expect(setup.observedEvents.map((event) => event.type)).toEqual([
      "session.created",
      "run.started",
      "observation.captured",
      "agent.step.started",
      "agent.step.completed",
      "browser.action.started",
      "browser.tool.started",
      "browser.tool.completed",
      "browser.tool.started",
      "browser.tool.completed",
      "browser.tool.started",
      "browser.tool.completed",
      "browser.action.completed",
      "observation.captured",
      "agent.step.started",
      "agent.step.completed",
      "run.completed",
    ])
    expect(setup.observedEvents.map((event) => event.sequence)).toEqual(Array.from({ length: 17 }, (_, index) => index))

    const persistedEvents = await new JsonlEventStore(
      eventsPath(setup.home, runSession.projectHash, runSession.id, started.runId),
    ).readAll()
    expect(persistedEvents.map((event) => event.type)).toEqual(setup.observedEvents.map((event) => event.type))
  })

  it("records one correlated model tool result per completed browser call", async () => {
    const environment = new TestEnvironment()
    const agent = new ToolResultCapturingAgent()
    const adapter = new TestBrowserToolAdapter(environment, coreToolDefinitions())
    const setup = await orchestratorWith(agent, environment, adapter)

    const result = await setup.orchestrator.startRun({ session: session(), prompt: "use tools" }).result

    expect(result.status).toBe("completed")
    expect(agent.results.at(-1)).toEqual([
      expect.objectContaining({ toolCallId: "tool_0001", name: "browser_navigate", isError: false }),
      expect.objectContaining({ toolCallId: "tool_0002", name: "browser_take_screenshot", isError: false }),
      expect.objectContaining({ toolCallId: "tool_0003", name: "browser_extract_text", isError: false }),
    ])
  })

  it("rejects a browser call that is absent from the active capability catalog", async () => {
    const environment = new TestEnvironment()
    const adapter = new TestBrowserToolAdapter(environment, [])
    const setup = await orchestratorWith(new TestAgent(), environment, adapter)

    const result = await setup.orchestrator.startRun({ session: session(), prompt: "blocked tool" }).result

    expect(result.status).toBe("failed")
    expect(adapter.calls).toEqual([])
    expect(setup.observedEvents.map((event) => event.type)).not.toContain("browser.tool.started")
  })

  it("includes capabilities and model tool names in run.started", async () => {
    const setup = await orchestrator()
    await setup.orchestrator.startRun({ session: session(), prompt: "metadata" }).result

    expect(setup.observedEvents.find((event) => event.type === "run.started")?.payload).toMatchObject({
      browserCapabilities: ["core"],
      browserTools: expect.arrayContaining(["browser_navigate"]),
    })
  })

  it("redacts model-facing browser_type arguments", () => {
    expect(
      redactSensitiveData({
        id: "call_1",
        name: "browser_type",
        arguments: { target: { selector: "#password" }, value: "new-secret" },
      }),
    ).toMatchObject({
      arguments: { value: "[redacted]" },
    })
  })

  it("reuses the final browser tool observation after an action batch", async () => {
    const environment = new TestEnvironment()
    const setup = await orchestratorWith(new TestAgent(), environment, new TestBrowserToolAdapter(environment))

    const result = await setup.orchestrator.startRun({
      session: session(),
      prompt: "reuse tool observation",
    }).result

    expect(result.status).toBe("completed")
    expect(environment.observeCalls).toBe(1)
    const captured = setup.observedEvents.filter((event) => event.type === "observation.captured")
    expect(captured).toHaveLength(2)
    expect(captured.at(-1)?.payload.observation).toMatchObject({
      url: "https://example.com/",
      title: "Example Domain",
    })
  })

  it("falls back to environment observation when tool results contain none", async () => {
    const environment = new TestEnvironment()
    const setup = await orchestratorWith(new TestAgent(), environment, new NullObservationBrowserToolAdapter(environment))

    const result = await setup.orchestrator.startRun({
      session: session(),
      prompt: "fallback observation",
    }).result

    expect(result.status).toBe("completed")
    expect(environment.observeCalls).toBe(2)
    const captured = setup.observedEvents.filter((event) => event.type === "observation.captured")
    expect(captured.at(-1)?.payload.observation).toMatchObject({
      url: "https://example.com/",
      title: "Example Domain",
    })
  })

  it("does not wait for live event subscribers before continuing the run", async () => {
    const eventBus = new EventBus()
    let releaseSubscriber: () => void = () => {}
    const subscriberRelease = new Promise<void>((resolve) => {
      releaseSubscriber = resolve
    })
    let subscriberCalls = 0
    eventBus.subscribe(async () => {
      subscriberCalls += 1
      await subscriberRelease
    })

    const registry = new PluginRegistry()
    const environment = new TestEnvironment()
    const toolAdapter = new TestBrowserToolAdapter(environment)
    registry.registerAgent(new TestAgent())
    registry.registerEnvironment(environment)
    registry.registerToolAdapter(toolAdapter)

    const home = await mkdtemp(join(tmpdir(), "owa-orchestrator-"))
    const runOrchestrator = new RunOrchestrator({
      home,
      eventBus,
      registry,
      agentId: "test-agent",
      environmentId: "test-browser",
      maxSteps: 4,
      now: () => new Date("2026-06-17T00:00:00.000Z"),
    })
    const started = runOrchestrator.startRun({
      session: session(),
      prompt: "example.com에 접속해서 페이지 제목을 알려줘",
    })
    let timeout: ReturnType<typeof setTimeout> | null = null

    try {
      const result = await Promise.race([
        started.result,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("run timed out waiting for event subscriber")), 500)
        }),
      ])

      expect(result.status).toBe("completed")
      expect(result.finalAnswer).toBe(finalAnswer)
      expect(subscriberCalls).toBeGreaterThan(0)
    } finally {
      if (timeout) clearTimeout(timeout)
      releaseSubscriber()
    }
  })

  it("injects the selected tool adapter catalog into runtime context", async () => {
    const agent = new ToolCatalogAgent()
    const environment = new TestEnvironment()
    const toolDefinitions: BrowserToolDefinition[] = [
      {
        name: "browser_navigate",
        type: "navigate",
        capability: "core",
        description: "Open an absolute URL.",
        inputSchema: { type: "object" },
        readOnly: false,
        requiresApproval: false,
        parameters: [{ name: "url", type: "string", required: true, description: "Absolute URL to open." }],
        example: { id: "tool_1", type: "navigate", url: "https://example.com" },
      },
    ]
    const setup = await orchestratorWith(agent, environment, new TestBrowserToolAdapter(environment, toolDefinitions))

    const result = await setup.orchestrator.startRun({ session: session(), prompt: "report tools" }).result

    expect(result.status).toBe("completed")
    expect(agent.browserTools).toEqual(toolDefinitions)
  })

  it("cancels an active delayed test run", async () => {
    const setup = await orchestrator(25)
    const started = setup.orchestrator.startRun({
      session: session(),
      prompt: "example.com에 접속해서 페이지 제목을 알려줘",
    })
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(setup.orchestrator.cancelRun(started.runId)).toBe(true)

    const result = await started.result
    expect(result.status).toBe("cancelled")
    expect(setup.observedEvents.map((event) => event.type)).toContain("run.cancelled")
  })

  it("continues to the next agent step after a browser tool throws", async () => {
    const environment = new TestEnvironment()
    const agent = new RecoveringAgent()
    const toolAdapter = new ThrowingBrowserToolAdapter(environment)
    const setup = await orchestratorWith(agent, environment, toolAdapter)
    const started = setup.orchestrator.startRun({
      session: session(),
      prompt: "retry after the first click fails",
    })

    const result = await started.result

    expect(result.status).toBe("completed")
    expect(result.finalAnswer).toBe(finalAnswer)
    expect(agent.failedResultsSeen).toEqual([0, 1, 1])
    expect(toolAdapter.calls.map((call) => call.type)).toEqual(["click", "navigate"])
    expect(setup.observedEvents.map((event) => event.type)).not.toContain("run.failed")
    expect(setup.observedEvents.map((event) => event.type)).toContain("run.completed")
    const failedToolEvent = setup.observedEvents.find((event) => {
      return event.type === "browser.tool.completed" && (event.payload.result as ActionResult | undefined)?.ok === false
    })
    expect(failedToolEvent?.payload.result).toMatchObject({
      ok: false,
      message: "locator.click: Timeout 30000ms exceeded",
    })
  })

  it("continues to the next agent step after a browser tool returns a failed result", async () => {
    const environment = new TestEnvironment()
    const agent = new RecoveringAgent()
    const toolAdapter = new FailedResultBrowserToolAdapter(environment)
    const setup = await orchestratorWith(agent, environment, toolAdapter)
    const started = setup.orchestrator.startRun({
      session: session(),
      prompt: "retry after the first click returns a failed result",
    })

    const result = await started.result

    expect(result.status).toBe("completed")
    expect(result.finalAnswer).toBe(finalAnswer)
    expect(agent.failedResultsSeen).toEqual([0, 1, 1])
    expect(toolAdapter.calls.map((call) => call.type)).toEqual(["click", "navigate"])
    expect(setup.observedEvents.map((event) => event.type)).not.toContain("run.failed")
  })

  it("redacts sensitive browser tool values from emitted and persisted events", async () => {
    const runSession = session()
    const environment = new TestEnvironment()
    const agent = new SensitiveTypingAgent()
    const toolAdapter = new TestBrowserToolAdapter(environment)
    const setup = await orchestratorWith(agent, environment, toolAdapter)
    const started = setup.orchestrator.startRun({
      session: runSession,
      prompt: "enter password",
    })

    const result = await started.result

    expect(result.status).toBe("completed")
    expect(toolAdapter.calls).toContainEqual({
      id: "tool_password",
      type: "type",
      target: target("#password"),
      value: "new-secret",
    })
    expect(JSON.stringify(setup.observedEvents)).not.toContain("new-secret")
    expect(JSON.stringify(setup.observedEvents)).toContain("[redacted]")

    const persistedEvents = await new JsonlEventStore(
      eventsPath(setup.home, runSession.projectHash, runSession.id, started.runId),
    ).readAll()
    expect(JSON.stringify(persistedEvents)).not.toContain("new-secret")
    expect(JSON.stringify(persistedEvents)).toContain("[redacted]")
  })

  it("requests human approval and skips browser tools for approval-gated actions", async () => {
    const environment = new TestEnvironment()
    const agent = new ApprovalRequiredAgent()
    const approvalTools = coreToolDefinitions().map((tool) =>
      tool.type === "navigate" ? { ...tool, requiresApproval: true } : tool,
    )
    const toolAdapter = new TestBrowserToolAdapter(environment, approvalTools)
    const setup = await orchestratorWith(agent, environment, toolAdapter)
    const started = setup.orchestrator.startRun({
      session: session(),
      prompt: "navigate only after approval",
    })

    const result = await started.result

    expect(result.status).toBe("completed")
    expect(result.finalAnswer).toBe("approval requested")
    expect(agent.failedResultsSeen).toEqual([0, 1])
    expect(toolAdapter.calls).toEqual([])

    const eventTypes = setup.observedEvents.map((event) => event.type)
    expect(eventTypes).toContain("human.approval.requested")
    expect(eventTypes).not.toContain("browser.tool.started")
    expect(eventTypes).not.toContain("browser.tool.completed")

    const approvalEvent = setup.observedEvents.find((event) => event.type === "human.approval.requested")
    expect(approvalEvent?.payload.action).toMatchObject({
      id: "action_requires_approval",
      requiresApproval: true,
    })

    const actionCompletedEvent = setup.observedEvents.find((event) => event.type === "browser.action.completed")
    expect(actionCompletedEvent?.payload.actionResults).toMatchObject([
      {
        ok: false,
        message: "Browser action requires human approval before tools can run.",
      },
    ])
  })
})
