import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentDecision } from "../contracts/agent"
import type { ActionResult, BrowserToolCall, Observation } from "../contracts/browser"
import type { RunEvent } from "../contracts/event"
import type { AgentPlugin, BrowserEnvironment, ToolAdapter } from "../contracts/plugin"
import { EventBus } from "../events/event-bus"
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

class TestEnvironment implements BrowserEnvironment {
  id = "test-browser"
  name = "Test Browser"
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
  calls: BrowserToolCall[] = []

  constructor(private readonly environment: TestEnvironment) {}

  async execute(call: BrowserToolCall, ctx: RuntimeContext): Promise<ActionResult> {
    this.calls.push(call)
    return this.environment.applyBrowserTool(call, ctx)
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
})
