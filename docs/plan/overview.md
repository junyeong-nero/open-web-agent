# Open Web Agent Plan Overview

[Back to plan index](../plan.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `open-web-agent`, a terminal-first web agent runtime that runs from a project directory, controls a browser through typed actions, streams every run event to a TUI, and persists local traces for debugging and replay.

**Architecture:** The product is split into a CLI, a local Hono server, a runtime core, and an OpenTUI/Solid client. Agents return `browser_actions`; each browser action contains concrete tool calls such as `navigate`, `click`, `type`, and `screenshot`, and the orchestrator executes those calls through the selected browser environment. The first sprint proves the architecture with mock runtime execution, SSE live events, JSONL traces, and a minimal TUI shell without real Playwright or real LLM calls.

**Tech Stack:** Bun, TypeScript, Hono, SSE, Zod, OpenTUI, `@opentui/solid`, JSONL trace files, Playwright in the browser phase, direct HTTP model adapters for OpenAI/OpenRouter-compatible providers.

---

## 1. Confirmed Decisions

These decisions are now fixed for implementation.

```text
Runtime/package manager: Bun
Language: TypeScript
Terminal UI: OpenTUI
TUI UI layer: SolidJS via @opentui/solid
Local API framework: Hono
Realtime stream: SSE live stream only in Sprint 1
Schema validation: Zod
Sprint 1 storage: JSONL trace files + in-memory metadata
Post-Sprint storage: SQLite metadata + filesystem artifacts
Browser automation: Playwright after the mock runtime proves the loop
Model integration: direct provider adapters, starting with OpenAI and OpenRouter
CLI package: packages/cli owns open-web-agent commands
Python skeleton: removed in Phase 0
Workspace package names: @open-web-agent/core, @open-web-agent/server, and the same scope for every package
Sprint 1 stubs: create future package files for models, storage, Playwright, and SimpleReActAgent as compiling stubs
Sprint 1 TUI: must actually launch, render panels, accept prompt input, and submit mock runs
Sprint 1 cancellation: use AbortController plus deterministic async delay so cancellation can be tested
Sprint 1 auth: no token/password/auth; loopback-only server is the entire protection boundary
Project hash: SHA-256 hex digest of the absolute project path
```

MVP explicitly excludes:

```text
FastAPI
Next.js
Python-first runtime
remote/cloud browser backend
plugin marketplace
distributed workers
enterprise auth
billing
long-term memory
SQLite in Sprint 1
real Playwright control in Sprint 1
real LLM calls in Sprint 1
SSE replay/backfill support
password or token authentication in Sprint 1
```

## 2. Why Keep A Local Server?

The local server is not strictly required to run a TUI. A direct `TUI -> runtime` call path would be simpler for the very first prototype. We keep the local server because this project is intended to become an opencode-like runtime with multiple clients and long-running observable runs.

Hono is not the browser runtime and it is not a web UI framework in this project. It is only the small local HTTP/SSE control surface that lets the terminal UI, headless CLI command, and future clients talk to the same runtime. Real browser automation still happens in `PlaywrightEnvironment`, which launches or connects to a browser process through Playwright.

The runtime shape is:

```text
Terminal TUI or headless CLI
  -> Hono local API on 127.0.0.1
  -> RunOrchestrator in the same Bun process
  -> PlaywrightEnvironment
  -> Playwright-controlled Chromium/WebKit/Firefox page
```

The server gives the project a stable boundary:

```text
TUI client
CLI headless command
future web client
future IDE extension
external automation
```

All of those clients can call the same local API instead of embedding runtime logic.

It also gives us a natural place for:

```text
SSE event streaming
run cancellation
session creation
run status lookup
plugin/model/environment listing
artifact lookup
future resume support
```

The tradeoff is more initial code. Sprint 1 keeps this manageable by running the local server in-process for the default `open-web-agent` command:

```text
open-web-agent
  -> CLI starts Hono server on 127.0.0.1:0
  -> CLI receives the random available port
  -> CLI starts TUI with the server URL
  -> TUI talks to the runtime only through HTTP/SSE
```

This preserves the API boundary without introducing child-process supervision in the first sprint.

Hono is chosen over raw `Bun.serve` because it gives route composition, request parsing, testable `app.fetch()` handlers, and SSE helpers without adding a heavy web application framework. If this boundary ever becomes too expensive, the fallback is to replace Hono with native `Bun.serve` while keeping the same local API contracts.

Server-only and connect modes still exist:

```bash
open-web-agent serve --port 4096 --hostname 127.0.0.1
open-web-agent --connect http://127.0.0.1:4096
```

Sprint 1 binds only to `127.0.0.1`. Non-local bind, password protection, and remote deployment are out of scope until there is a concrete remote-client requirement.

There is no authentication layer in Sprint 1. Do not add a local token, password prompt, cookie, or auth middleware. The only protection is that `serve` defaults to `127.0.0.1`, rejects non-loopback hostnames in Sprint 1, and is intended for local developer use.

## 3. Product Surface

### 3.1 Commands

```bash
open-web-agent
open-web-agent /path/to/project
open-web-agent run "example.com에 접속해서 페이지 제목을 알려줘"
open-web-agent serve --port 4096 --hostname 127.0.0.1
open-web-agent --connect http://127.0.0.1:4096
```

Sprint 1 command behavior:

```text
open-web-agent
  Starts an in-process local server, opens the TUI, creates a session, and runs mock prompts.

open-web-agent /path/to/project
  Same as open-web-agent, but the session projectPath is the provided absolute path.

open-web-agent run "<prompt>"
  Starts the in-process server, submits one mock run, prints compact event logs and final answer, then exits.

open-web-agent serve --port <port> --hostname 127.0.0.1
  Starts only the local HTTP/SSE server.

open-web-agent --connect <url>
  Starts only the TUI and connects to an already-running local server.
```

### 3.2 TUI Panels

Sprint 1 TUI is a functional shell, not a polished full application.

```text
Top Bar
  current project path
  selected agent/model/browser env
  current run status

Conversation Panel
  user messages
  assistant final answers
  compact browser action summaries

Run Timeline Panel
  run.started
  observation.captured
  agent.step.started
  agent.step.completed
  browser.action.started
  browser.action.completed
  run.completed
  run.failed
  run.cancelled

Inspector Panel
  selected event payload
  current browser action
  current tool call input/output

Browser State Panel
  current URL/title
  last screenshot path
  compact text observation
  interactive element count

Prompt Input
  multiline user input
  slash commands
  keyboard shortcuts
```

### 3.3 Sprint 1 Slash Commands

```text
/help       show available commands
/details    toggle inspector visibility
/new        create a new in-memory session
/stop       cancel current run
/quit       exit the TUI
```

Deferred until session/model/env implementations exist:

```text
/models
/agents
/env
/sessions
/export
```

### 3.4 Sprint 1 Keybindings

```text
ctrl+x q    quit
ctrl+x n    new session
ctrl+c      cancel current run; when idle, ask for quit confirmation
tab         move focus
enter       submit prompt
shift+enter newline
```

## 4. Runtime Architecture

### 4.1 Package Boundaries

```text
packages/cli
  binary entrypoint
  command parsing
  server lifecycle for default/headless/serve/connect modes
  handoff into TUI or compact headless logs

packages/core
  Zod schemas and inferred TypeScript types
  event bus
  run orchestrator
  plugin registry
  session/run in-memory state
  JSONL event store interface and implementation

packages/server
  Hono app factory
  local API routes
  SSE endpoint
  request/response schemas
  server start/stop helper for CLI

packages/tui
  OpenTUI + Solid app
  server client
  SSE client
  TUI state reducer
  slash command parser
  keybinding mapping
  panels/components

packages/browser
  MockEnvironment for Sprint 1
  PlaywrightEnvironment after Sprint 1
  observation extraction
  browser tool call execution

packages/models
  ModelPlugin interface implementations
  OpenAI direct HTTP adapter
  OpenRouter direct HTTP adapter
  provider config/auth loading

packages/agents
  MockAgent for Sprint 1
  SimpleReActAgent after real model integration

packages/storage
  SQLite metadata store after Sprint 1
  artifact store after browser screenshots/downloads exist
```

There is no separate `packages/tools` package in Sprint 1. Browser tool calls are part of the browser action contract and execute through `BrowserEnvironment`. Non-browser external tools can become a separate package when there is a real tool category that is not browser control.

### 4.2 Execution Flow

```text
Terminal TUI
  -> Hono Local Server API
  -> RunOrchestrator
  -> AgentPlugin.step()
  -> AgentDecision(type="browser_actions")
  -> BrowserAction[]
  -> BrowserAction.toolCalls[]
  -> BrowserEnvironment.execute(toolCall)
  -> Observation / ActionResult / RunEvent
  -> EventBus
  -> SSE live stream
  -> TUI realtime update
  -> JSONL event trace
```

### 4.3 Sprint 1 Mock Scenario

The first deterministic test prompt is:

```text
example.com에 접속해서 페이지 제목을 알려줘
```

The mock agent returns one browser action:

```text
BrowserAction
  id: action_0001
  kind: inspect_page_title
  toolCalls:
    1. navigate https://example.com
    2. screenshot
    3. extract_text
```

The mock environment returns:

```text
url: https://example.com/
title: Example Domain
text: Example Domain\nThis domain is for use in illustrative examples in documents.
screenshotPath: <run-dir>/screenshots/step-0001.txt
interactiveElements: []
```

The mock final answer is:

```text
페이지 제목은 "Example Domain"입니다.
```

## 5. Data Contracts

All runtime boundaries use Zod schemas and exported inferred types.

### 5.1 RunEvent

File: `packages/core/src/contracts/event.ts`

```ts
import { z } from "zod"

export const RunEventTypeSchema = z.enum([
  "server.connected",
  "session.created",
  "run.started",
  "run.cancelled",
  "run.failed",
  "run.completed",
  "observation.captured",
  "agent.step.started",
  "agent.step.completed",
  "browser.action.started",
  "browser.action.completed",
  "browser.tool.started",
  "browser.tool.completed",
  "model.called",
  "model.completed",
  "human.approval.requested",
])

export const RunEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  stepId: z.string().nullable(),
  sequence: z.number().int().nonnegative(),
  type: RunEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
})

export type RunEvent = z.infer<typeof RunEventSchema>
export type RunEventType = z.infer<typeof RunEventTypeSchema>
```

Sprint 1 requires monotonic in-memory `sequence` per run. SSE replay/backfill does not use it yet, but JSONL traces and tests do.

### 5.2 Browser Tool Calls And Actions

File: `packages/core/src/contracts/browser.ts`

```ts
import { z } from "zod"

export const BoundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})

export const ElementRefSchema = z.object({
  id: z.string(),
  role: z.string().nullable(),
  name: z.string().nullable(),
  text: z.string().nullable(),
  selector: z.string().nullable(),
  xpath: z.string().nullable(),
  boundingBox: BoundingBoxSchema.nullable(),
  attributes: z.record(z.string(), z.string()).default({}),
})

export const ActionTargetSchema = z.object({
  elementId: z.string().nullable().default(null),
  selector: z.string().nullable().default(null),
  text: z.string().nullable().default(null),
  role: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
  coordinates: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .nullable()
    .default(null),
})

export const BrowserToolCallSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string(), type: z.literal("navigate"), url: z.string().url() }),
  z.object({ id: z.string(), type: z.literal("click"), target: ActionTargetSchema }),
  z.object({ id: z.string(), type: z.literal("type"), target: ActionTargetSchema, value: z.string() }),
  z.object({ id: z.string(), type: z.literal("scroll"), deltaX: z.number().default(0), deltaY: z.number() }),
  z.object({ id: z.string(), type: z.literal("wait"), ms: z.number().int().positive() }),
  z.object({ id: z.string(), type: z.literal("press_key"), key: z.string() }),
  z.object({ id: z.string(), type: z.literal("screenshot") }),
  z.object({ id: z.string(), type: z.literal("extract_text") }),
  z.object({ id: z.string(), type: z.literal("go_back") }),
  z.object({ id: z.string(), type: z.literal("go_forward") }),
])

export const BrowserActionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  reason: z.string().nullable(),
  requiresApproval: z.boolean().default(false),
  toolCalls: z.array(BrowserToolCallSchema).min(1),
})

export const ObservationSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),
  text: z.string().nullable(),
  screenshotPath: z.string().nullable(),
  interactiveElements: z.array(ElementRefSchema),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export const ActionResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().nullable(),
  observation: ObservationSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export type BrowserToolCall = z.infer<typeof BrowserToolCallSchema>
export type BrowserAction = z.infer<typeof BrowserActionSchema>
export type Observation = z.infer<typeof ObservationSchema>
export type ActionResult = z.infer<typeof ActionResultSchema>
```

### 5.3 AgentDecision

File: `packages/core/src/contracts/agent.ts`

```ts
import { z } from "zod"
import { BrowserActionSchema } from "./browser"

export const AgentDecisionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("browser_actions"),
    thought: z.string().nullable(),
    actions: z.array(BrowserActionSchema).min(1),
  }),
  z.object({
    type: z.literal("final_answer"),
    thought: z.string().nullable(),
    finalAnswer: z.string(),
    confidence: z.number().min(0).max(1).nullable(),
  }),
])

export type AgentDecision = z.infer<typeof AgentDecisionSchema>
```

There is no top-level `tool_calls` decision in Sprint 1. Browser operations are always grouped under `browser_actions`. A future non-browser tool system must add a separate decision type only when the runtime has a concrete non-browser tool use case.

### 5.4 Plugin Interfaces

File: `packages/core/src/contracts/plugin.ts`

```ts
import type { AgentDecision } from "./agent"
import type { ActionResult, BrowserToolCall, Observation } from "./browser"
import type { ModelRequest, ModelResponse } from "./model"
import type { AgentState, RuntimeContext } from "../orchestrator/run-state"

export interface AgentPlugin {
  id: string
  name: string
  description: string
  initialize(ctx: RuntimeContext): Promise<void>
  step(state: AgentState, ctx: RuntimeContext): Promise<AgentDecision>
  finalize(state: AgentState, ctx: RuntimeContext): Promise<string>
}

export interface ModelPlugin {
  id: string
  name: string
  provider: string
  complete(request: ModelRequest, ctx: RuntimeContext): Promise<ModelResponse>
}

export interface BrowserEnvironment {
  id: string
  name: string
  reset(ctx: RuntimeContext): Promise<void>
  observe(ctx: RuntimeContext): Promise<Observation>
  execute(call: BrowserToolCall, ctx: RuntimeContext): Promise<ActionResult>
  close(ctx: RuntimeContext): Promise<void>
}
```

`RuntimeContext` carries per-run resources such as `runDir` and `abortSignal`, so browser environments do not need singleton mutable global state for screenshots or cancellation.

### 5.5 Model Request/Response

File: `packages/core/src/contracts/model.ts`

```ts
import { z } from "zod"

export const ModelMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
})

export const ModelRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ModelMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  responseFormat: z.enum(["text", "json"]).default("text"),
})

export const ModelUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
})

export const ModelResponseSchema = z.object({
  id: z.string().nullable(),
  text: z.string(),
  raw: z.unknown(),
  usage: ModelUsageSchema.nullable(),
  latencyMs: z.number().nonnegative(),
})

export type ModelRequest = z.infer<typeof ModelRequestSchema>
export type ModelResponse = z.infer<typeof ModelResponseSchema>
```

Model providers are direct HTTP adapters. `OpenAIModel` and `OpenRouterModel` share an internal OpenAI-compatible chat-completions client where possible, but the public runtime contract stays provider-neutral.

### 5.6 Runtime State And Context

File: `packages/core/src/orchestrator/run-state.ts`

```ts
import type { EventBus } from "../events/event-bus"
import type { AgentDecision } from "../contracts/agent"
import type { ActionResult, Observation } from "../contracts/browser"
import type { RunEvent, RunEventType } from "../contracts/event"

export interface SessionState {
  id: string
  projectPath: string
  projectHash: string
  createdAt: string
}

export interface AgentStepRecord {
  id: string
  decision: AgentDecision | null
  observation: Observation | null
  actionResults: ActionResult[]
}

export interface AgentState {
  session: SessionState
  runId: string
  prompt: string
  steps: AgentStepRecord[]
  lastObservation: Observation | null
  finalAnswer: string | null
}

export interface RuntimeContext {
  session: SessionState
  runId: string
  runDir: string
  eventBus: EventBus
  abortSignal: AbortSignal
  now(): Date
  emit(type: RunEventType, payload: Record<string, unknown>, stepId?: string | null): Promise<RunEvent>
}

export interface RunResult {
  runId: string
  status: "completed" | "failed" | "cancelled"
  finalAnswer: string | null
}

export function toIsoString(date: Date): string {
  return date.toISOString()
}
```

## 6. Local API

Sprint 1 routes:

```text
GET  /health
GET  /events

POST /sessions
GET  /sessions/:sessionId
POST /sessions/:sessionId/messages

POST /runs
GET  /runs/:runId
POST /runs/:runId/cancel

GET  /plugins
GET  /plugins/agents
GET  /plugins/models
GET  /plugins/environments
```

Deferred routes:

```text
GET  /sessions
GET  /runs/:runId/events
GET  /runs/:runId/artifacts
GET  /plugins/tools
POST /tui/append-prompt
POST /tui/submit-prompt
POST /tui/open-help
POST /tui/show-toast
```

`GET /events` is a live stream only in Sprint 1:

```text
Content-Type: text/event-stream
event: <RunEvent.type>
id: <RunEvent.sequence>
data: <RunEvent JSON>
```

No `Last-Event-ID` handling is required in Sprint 1. Persisted JSONL traces are the source for debugging after a run completes.

## 7. Storage

### 7.1 Sprint 1 Storage

Sprint 1 uses a file trace and in-memory metadata.

```text
OWA_HOME or ~/.open-web-agent/
  projects/
    <project-hash>/
      sessions/
        <session-id>/
          session.json
          runs/
            <run-id>/
              run.json
              events.jsonl
              screenshots/
                step-0001.txt
```

Tests must set `OWA_HOME` to a temporary directory so they never write into the developer's real home directory.

`<project-hash>` is the lowercase hex SHA-256 digest of the session's absolute project path:

```ts
import { createHash } from "node:crypto"
import { resolve } from "node:path"

export function hashProjectPath(projectPath: string): string {
  return createHash("sha256").update(resolve(projectPath)).digest("hex")
}
```

Use the full 64-character digest for the directory name. Do not truncate it in Sprint 1; collisions are not worth saving a few path characters.

### 7.2 Post-Sprint Storage

SQLite starts after Sprint 1.

```text
SQLite:
  sessions
  runs
  messages
  run summary metadata

JSONL:
  complete append-only run event stream

Filesystem:
  screenshots
  downloads
  extracted artifacts
```

## 8. Target Repository Structure

```text
open-web-agent/
  package.json
  bun.lock
  bunfig.toml
  tsconfig.json
  tsconfig.base.json
  README.md
  plan.md

  packages/
    cli/
      package.json
      tsconfig.json
      src/
        index.ts
        args.ts
        commands/
          default.ts
          run.ts
          serve.ts
          connect.ts

    core/
      package.json
      tsconfig.json
      src/
        index.ts
        contracts/
          agent.ts
          browser.ts
          event.ts
          model.ts
          plugin.ts
        events/
          event-bus.ts
        ids/
          ids.ts
        orchestrator/
          run-orchestrator.ts
          run-state.ts
        registry/
          plugin-registry.ts
        storage/
          jsonl-event-store.ts
          paths.ts

    server/
      package.json
      tsconfig.json
      src/
        index.ts
        app.ts
        start-server.ts
        routes/
          health.ts
          events.ts
          sessions.ts
          runs.ts
          plugins.ts
        schemas/
          api.ts

    tui/
      package.json
      tsconfig.json
      src/
        index.tsx
        app.tsx
        state/
          reducer.ts
          types.ts
        client/
          server-client.ts
          event-source.ts
        components/
          top-bar.tsx
          conversation-panel.tsx
          timeline-panel.tsx
          inspector-panel.tsx
          browser-state-panel.tsx
          prompt-input.tsx
        commands/
          slash-commands.ts
        keymap/
          keybindings.ts

    browser/
      package.json
      tsconfig.json
      src/
        index.ts
        mock-environment.ts
        playwright-environment.ts

    agents/
      package.json
      tsconfig.json
      src/
        index.ts
        mock-agent.ts
        simple-react-agent.ts

    models/
      package.json
      tsconfig.json
      src/
        index.ts
        openai-compatible-client.ts
        openai-model.ts
        openrouter-model.ts
        model-config.ts

    storage/
      package.json
      tsconfig.json
      src/
        index.ts
        sqlite-store.ts
        artifact-store.ts

  docs/
    architecture.md
    runtime-events.md
    tui.md
```

`turbo.json` is not part of Sprint 1. `tsc -b` and `bun test` are enough until the workspace needs a separate task runner.

All workspace packages use the `@open-web-agent/*` npm scope:

```text
packages/cli      -> @open-web-agent/cli
packages/core     -> @open-web-agent/core
packages/server   -> @open-web-agent/server
packages/tui      -> @open-web-agent/tui
packages/browser  -> @open-web-agent/browser
packages/agents   -> @open-web-agent/agents
packages/models   -> @open-web-agent/models
packages/storage  -> @open-web-agent/storage
```

Internal package dependencies use `"workspace:*"`. Do not import across packages with long relative paths such as `../../../core/src`; import from the package name.

## 11. Test Strategy

### Unit Tests

```text
Zod contract validation
EventBus publish/subscribe/unsubscribe
JsonlEventStore append/read
PluginRegistry lookup
MockAgent decisions
MockEnvironment tool call execution
Slash command parser
Keybinding mapping
TUI reducer
CLI arg parser
```

### Integration Tests

```text
RunOrchestrator + MockAgent + MockEnvironment
Hono app route tests with app.fetch()
SSE route subscription behavior where practical
CLI run command against in-process server
```

### Manual Smoke Tests

```bash
bun run packages/cli/src/index.ts run "example.com에 접속해서 페이지 제목을 알려줘"
bun run packages/cli/src/index.ts serve --port 4096 --hostname 127.0.0.1
bun run packages/cli/src/index.ts
```

The TUI manual smoke is acceptable for Sprint 1 because the highest-risk logic is state and event handling, which is covered by tests.

## 12. Permission And Safety Model

Sprint 1 mock runtime does not touch real websites or user files beyond trace output. The permission model becomes active in the Playwright phase.

Permission categories:

```text
browser.navigate
browser.click
browser.type
browser.download
browser.upload
external.network
human.sensitive_input
```

Default future policy:

```text
navigate/click/scroll/wait/screenshot: allowed by default
type into ordinary text fields: allowed by default
password/token-like fields: approval required
upload/download/external submit: approval required
payment/purchase/message sending: approval required
```

Approval is represented as:

```text
BrowserAction.requiresApproval = true
RunEvent.type = human.approval.requested
```

## 13. Risks And Responses

### OpenTUI Learning Cost

Risk:

```text
OpenTUI/Solid patterns may take time to stabilize.
```

Response:

```text
Keep Sprint 1 UI logic state-driven.
Test reducer/parser/keymap heavily.
Treat visual rendering as smoke-tested until the component patterns settle.
```

### Local Server Adds Initial Work

Risk:

```text
HTTP/SSE boundary is more code than direct TUI-to-runtime calls.
```

Response:

```text
Run server in-process for default command.
Keep Sprint 1 routes small.
Use the boundary to avoid rewriting clients later.
```

### Browser Action Contract Drift

Risk:

```text
BrowserAction, BrowserToolCall, ToolPlugin, and BrowserEnvironment can overlap.
```

Response:

```text
Sprint 1 has only BrowserAction with nested BrowserToolCall.
BrowserEnvironment executes BrowserToolCall.
No top-level tool_calls AgentDecision exists in Sprint 1.
```

### Model Provider Lock-In

Risk:

```text
Provider SDKs can shape runtime contracts too early.
```

Response:

```text
Use direct HTTP adapters behind ModelPlugin.
Keep ModelRequest and ModelResponse provider-neutral.
Share OpenAI-compatible request code where providers support it.
```

### Real Web Non-Determinism

Risk:

```text
Real websites have layout changes, cookie banners, bot detection, and timing variance.
```

Response:

```text
Start with deterministic mock runtime.
Move to local Playwright fixtures before broad public-web tasks.
Persist every event and artifact for debugging.
```

## 14. Current Open Questions

No blocking product questions remain for Sprint 1 after the June 17, 2026 planning review.

The following Sprint 1 implementation decisions are fixed:

```text
Create future-phase package/file stubs in Phase 0.
Install OpenTUI/Solid dependencies in Sprint 1.
Use @open-web-agent/* package names.
Make the TUI actually launch, render, accept input, submit runs, and exit.
Use AbortController plus deterministic async delay for cancellation tests.
Do not add authentication in Sprint 1.
Hash absolute project paths with full SHA-256 hex digests.
Expand implementation tasks with concrete TypeScript interfaces and test shapes.
```

Questions that can wait until their phase starts:

```text
Which concrete OpenAI/OpenRouter default models should ship in config?
Should SQLite use Drizzle ORM or direct bun:sqlite?
Should terminal image preview be supported after screenshot artifacts exist?
Should non-browser external tools become packages/tools or live under core plugins?
```

These do not block the Bun workspace, contracts, mock runtime, local server, CLI, or TUI shell.

## Sprint 1 Outcome

Sprint 1 target duration:

```text
1-2 weeks
```

Sprint 1 outcome:

```text
User runs open-web-agent.
TUI opens and connects to the local server.
User submits "example.com에 접속해서 페이지 제목을 알려줘".
Mock runtime emits live SSE events.
Timeline updates in the TUI.
events.jsonl is written.
Conversation shows: 페이지 제목은 "Example Domain"입니다.
```
