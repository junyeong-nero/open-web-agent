# Phase 2: Mock Runtime Loop

[Back to plan index](../plan.md)

## Phase Summary

Goal: prove orchestrator execution without a browser or LLM.

Implement:

```text
packages/core/src/orchestrator/run-orchestrator.ts
packages/core/src/orchestrator/run-state.ts
packages/core/src/registry/plugin-registry.ts
packages/browser/src/mock-environment.ts
packages/agents/src/mock-agent.ts
```

Required event sequence:

```text
session.created
run.started
observation.captured
agent.step.started
agent.step.completed
browser.action.started
browser.tool.started
browser.tool.completed
browser.tool.started
browser.tool.completed
browser.tool.started
browser.tool.completed
browser.action.completed
observation.captured
agent.step.started
agent.step.completed
run.completed
```

Verification:

```bash
bun test packages/core packages/browser packages/agents
```

Expected result:

```text
Mock prompt produces final answer: 페이지 제목은 "Example Domain"입니다.
events.jsonl contains the same sequence emitted by EventBus.
```

## Sprint 1 Detailed Tasks

### Task 4: Mock Runtime

**Files:**

```text
Create: packages/core/src/ids/ids.ts
Create: packages/core/src/orchestrator/run-state.ts
Create: packages/core/src/orchestrator/run-orchestrator.ts
Create: packages/core/src/orchestrator/run-orchestrator.test.ts
Create: packages/core/src/registry/plugin-registry.ts
Create: packages/core/src/registry/plugin-registry.test.ts
Create: packages/browser/src/mock-environment.ts
Create: packages/browser/src/mock-environment.test.ts
Create: packages/agents/src/mock-agent.ts
Create: packages/agents/src/mock-agent.test.ts
Modify: packages/core/src/index.ts
Modify: packages/browser/src/index.ts
Modify: packages/agents/src/index.ts
```

- [ ] Implement ID helpers.

Required prefixes:

```text
session IDs: ses_
run IDs: run_
event IDs: evt_
step IDs: step_
action IDs: action_
tool call IDs: tool_
```

Use this implementation shape:

```ts
import { randomUUID } from "node:crypto"

export type IdPrefix = "ses" | "run" | "evt" | "step" | "action" | "tool"

export function makeId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`
}

export const makeSessionId = () => makeId("ses")
export const makeRunId = () => makeId("run")
export const makeEventId = () => makeId("evt")
export const makeStepId = () => makeId("step")
export const makeActionId = () => makeId("action")
export const makeToolCallId = () => makeId("tool")
```

- [ ] Implement `PluginRegistry`.

Required behavior:

```text
registerAgent(plugin)
registerEnvironment(plugin)
registerModel(plugin)
getAgent(id)
getEnvironment(id)
getModel(id)
listAgents()
listEnvironments()
listModels()
```

Use maps and throw on duplicate IDs:

```ts
import type { AgentPlugin, BrowserEnvironment, ModelPlugin } from "../contracts/plugin"

export class PluginRegistry {
  private agents = new Map<string, AgentPlugin>()
  private environments = new Map<string, BrowserEnvironment>()
  private models = new Map<string, ModelPlugin>()

  registerAgent(plugin: AgentPlugin): void {
    this.register(this.agents, plugin)
  }

  registerEnvironment(plugin: BrowserEnvironment): void {
    this.register(this.environments, plugin)
  }

  registerModel(plugin: ModelPlugin): void {
    this.register(this.models, plugin)
  }

  getAgent(id: string): AgentPlugin {
    return this.get(this.agents, id, "agent")
  }

  getEnvironment(id: string): BrowserEnvironment {
    return this.get(this.environments, id, "environment")
  }

  getModel(id: string): ModelPlugin {
    return this.get(this.models, id, "model")
  }

  listAgents(): AgentPlugin[] {
    return [...this.agents.values()]
  }

  listEnvironments(): BrowserEnvironment[] {
    return [...this.environments.values()]
  }

  listModels(): ModelPlugin[] {
    return [...this.models.values()]
  }

  private register<T extends { id: string }>(map: Map<string, T>, plugin: T): void {
    if (map.has(plugin.id)) throw new Error(`Plugin already registered: ${plugin.id}`)
    map.set(plugin.id, plugin)
  }

  private get<T>(map: Map<string, T>, id: string, kind: string): T {
    const plugin = map.get(id)
    if (!plugin) throw new Error(`Unknown ${kind}: ${id}`)
    return plugin
  }
}
```

- [ ] Implement `MockAgent`.

Required behavior:

```text
First step returns browser_actions with navigate, screenshot, extract_text.
Second step returns final_answer with 페이지 제목은 "Example Domain"입니다.
```

Use deterministic state instead of prompt-dependent branching:

```ts
import type { AgentDecision } from "@open-web-agent/core"
import type { AgentPlugin } from "@open-web-agent/core"
import type { AgentState, RuntimeContext } from "@open-web-agent/core"

export class MockAgent implements AgentPlugin {
  id = "mock-agent"
  name = "Mock Agent"
  description = "Deterministic Sprint 1 agent for Example Domain."

  async initialize(_ctx: RuntimeContext): Promise<void> {}

  async step(state: AgentState, _ctx: RuntimeContext): Promise<AgentDecision> {
    if (state.steps.length === 0) {
      return {
        type: "browser_actions",
        thought: "Open Example Domain, capture a screenshot, and extract text.",
        actions: [
          {
            id: "action_0001",
            kind: "inspect_page_title",
            reason: "The prompt asks for the page title.",
            requiresApproval: false,
            toolCalls: [
              { id: "tool_0001", type: "navigate", url: "https://example.com" },
              { id: "tool_0002", type: "screenshot" },
              { id: "tool_0003", type: "extract_text" }
            ]
          }
        ]
      }
    }

    return {
      type: "final_answer",
      thought: "The mock observation contains the deterministic title.",
      finalAnswer: "페이지 제목은 \"Example Domain\"입니다.",
      confidence: 1
    }
  }

  async finalize(state: AgentState, _ctx: RuntimeContext): Promise<string> {
    return state.finalAnswer ?? "페이지 제목은 \"Example Domain\"입니다."
  }
}
```

- [ ] Implement `MockEnvironment`.

Required behavior:

```text
reset() sets empty page state.
execute(navigate) sets url/title/text to Example Domain fixture.
execute(screenshot) writes screenshots/step-0001.txt in the run directory.
execute(extract_text) returns current text in metadata.
observe() returns the current Observation.
execute() waits for delayMs before completing, so cancellation tests can abort active runs.
```

Use `RuntimeContext.runDir` for artifacts and `RuntimeContext.abortSignal` for cancellation:

```ts
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ActionResult, BrowserEnvironment, BrowserToolCall, Observation, RuntimeContext } from "@open-web-agent/core"

const EXAMPLE_OBSERVATION: Observation = {
  url: "https://example.com/",
  title: "Example Domain",
  text: "Example Domain\nThis domain is for use in illustrative examples in documents.",
  screenshotPath: null,
  interactiveElements: [],
  metadata: {}
}

export class MockEnvironment implements BrowserEnvironment {
  id = "mock-browser"
  name = "Mock Browser"
  private observation: Observation = { url: "about:blank", title: null, text: null, screenshotPath: null, interactiveElements: [], metadata: {} }

  constructor(private readonly delayMs = 25) {}

  async reset(_ctx: RuntimeContext): Promise<void> {
    this.observation = { url: "about:blank", title: null, text: null, screenshotPath: null, interactiveElements: [], metadata: {} }
  }

  async observe(_ctx: RuntimeContext): Promise<Observation> {
    return this.observation
  }

  async execute(call: BrowserToolCall, ctx: RuntimeContext): Promise<ActionResult> {
    await sleep(this.delayMs, ctx.abortSignal)

    if (call.type === "navigate") {
      this.observation = { ...EXAMPLE_OBSERVATION }
      return { ok: true, message: "navigated", observation: this.observation, metadata: { url: call.url } }
    }

    if (call.type === "screenshot") {
      const screenshotPath = join(ctx.runDir, "screenshots", "step-0001.txt")
      await mkdir(join(ctx.runDir, "screenshots"), { recursive: true })
      await writeFile(screenshotPath, "mock screenshot for Example Domain\n")
      this.observation = { ...this.observation, screenshotPath }
      return { ok: true, message: "screenshot captured", observation: this.observation, metadata: { screenshotPath } }
    }

    if (call.type === "extract_text") {
      return { ok: true, message: "text extracted", observation: this.observation, metadata: { text: this.observation.text } }
    }

    return { ok: false, message: `Unsupported mock tool: ${call.type}`, observation: this.observation, metadata: {} }
  }

  async close(_ctx: RuntimeContext): Promise<void> {}
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Run cancelled", "AbortError"))

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout)
        reject(new DOMException("Run cancelled", "AbortError"))
      },
      { once: true }
    )
  })
}
```

- [ ] Implement `RunOrchestrator`.

Required behavior:

```text
Creates run state.
Emits the required event sequence from Phase 2.
Persists every event to JsonlEventStore.
Stops with run.completed after final_answer.
Stops with run.cancelled when cancel is requested.
Stops with run.failed when maxSteps is exceeded.
```

Orchestrator public API:

```ts
export interface RunOrchestratorOptions {
  home: string
  eventBus: EventBus
  registry: PluginRegistry
  agentId: string
  environmentId: string
  maxSteps: number
  now?: () => Date
}

export interface StartRunInput {
  session: SessionState
  prompt: string
}

export interface StartedRun {
  runId: string
  result: Promise<RunResult>
}

export class RunOrchestrator {
  startRun(input: StartRunInput): StartedRun
  cancelRun(runId: string): boolean
}
```

Implementation requirements:

```text
startRun() creates runId synchronously, creates an AbortController, and stores it in activeRuns before starting async work.
startRun() returns { runId, result } immediately; result resolves when the run completes, fails, or is cancelled.
cancelRun(runId) aborts the active controller and returns true when found.
startRun() returns status "cancelled" and emits run.cancelled when an AbortError is caught.
startRun() removes the run from activeRuns in finally.
emit() increments sequence from 0 per run and appends the event to events.jsonl before publishing it.
```

- [ ] Export runtime modules from `packages/core/src/index.ts`.

```ts
export * from "./contracts/event"
export * from "./contracts/browser"
export * from "./contracts/agent"
export * from "./contracts/model"
export * from "./contracts/plugin"
export * from "./events/event-bus"
export * from "./ids/ids"
export * from "./orchestrator/run-state"
export * from "./orchestrator/run-orchestrator"
export * from "./registry/plugin-registry"
export * from "./storage/jsonl-event-store"
export * from "./storage/paths"
```

- [ ] Add integration test.

Test name:

```text
RunOrchestrator completes the deterministic Example Domain mock run
RunOrchestrator cancels an active delayed mock run
```

Assertions:

```text
finalAnswer equals 페이지 제목은 "Example Domain"입니다.
event types match the required Phase 2 sequence.
events.jsonl exists.
events.jsonl has the same number of events as EventBus observed.
```

Cancellation test structure:

```ts
import { describe, expect, it } from "bun:test"

describe("RunOrchestrator cancellation", () => {
  it("cancels an active delayed mock run", async () => {
    const started = orchestrator.startRun({ session, prompt: "example.com에 접속해서 페이지 제목을 알려줘" })
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(orchestrator.cancelRun(started.runId)).toBe(true)

    const result = await started.result
    expect(result.status).toBe("cancelled")
    expect(observedEvents.map((event) => event.type)).toContain("run.cancelled")
  })
})
```

- [ ] Run verification.

```bash
bun test packages/core packages/browser packages/agents
bun run typecheck
```

Expected:

```text
Mock runtime tests pass.
No TypeScript errors.
```

- [ ] Commit.

```bash
git add packages/core packages/browser packages/agents
git commit -m "[add] implement mock runtime loop"
```
