# How Open Web Agent Works

Open Web Agent is split across a Bun workspace. The CLI starts or connects to a loopback-only Hono server. The server owns runtime composition, sessions, runs, browser environments, event streaming, and persistence. The TUI is a client: it talks to the server only over HTTP and SSE.

## Runtime Flow

```text
CLI command -> in-process Hono server (127.0.0.1) -> RunOrchestrator
  -> AgentPlugin.step() -> AgentDecision
      | "browser_actions" -> BrowserAction[].toolCalls[] -> BrowserEnvironment.execute(toolCall)
      | "final_answer"    -> AgentPlugin.finalize() -> run.completed
  -> ctx.emit(RunEvent) -> EventBus -> SSE live stream + JSONL trace file
```

`RunOrchestrator.executeRun` owns a run lifecycle. It resets the environment, captures an initial `observation.captured` event, loops through `agent.step()` until completion or cancellation, and assigns a monotonic per-run `sequence` to every emitted event.

Cancellation is cooperative through `AbortController` and `AbortSignal` on the runtime context.

## Contracts

Runtime boundaries live in `packages/core/src/contracts/` and are defined as Zod schemas with inferred TypeScript types.

Key contracts:

- `AgentDecision` is a discriminated union on `type`: `browser_actions` or `final_answer`.
- Browser operations are nested under `browser_actions -> BrowserAction -> toolCalls[]`.
- `BrowserToolCall` is a discriminated union for `navigate`, `click`, `type`, `scroll`, `wait`, `press_key`, `screenshot`, `extract_text`, `go_back`, and `go_forward`.
- `RunEventType` is the closed enum of every event the runtime can emit.

When data crosses agent, environment, server, or TUI boundaries, update the schema first.

## Plugin Registry

`AgentPlugin`, `ModelPlugin`, and `BrowserEnvironment` implementations are registered by string `id` in `PluginRegistry`.

`startDefaultRuntime` in `packages/server/src/default-runtime.ts` is the composition root. It wires built-in agents, Playwright, provider-backed models, and project-local Python agent manifests.

Built-in runtime pieces include:

- Agents: `simple-react-agent`, `see-act`
- Browser environment: `playwright-browser`
- Model providers: OpenAI, OpenRouter, Gemini, Claude, and Codex OAuth when corresponding credentials are available

Agents do not hold provider clients directly. They call a `RuntimeSelectedModel` shim that dispatches to the selected model for the run and emits `model.called` and `model.completed` events.

## Package Boundaries

| Package | Role |
|---|---|
| `@open-web-agent/core` | Zod contracts, event bus, orchestrator, registry, JSONL store, path/id helpers |
| `@open-web-agent/server` | Hono app factory, routes, SSE, default runtime composition |
| `@open-web-agent/cli` | Argument parsing and `default`, `run`, `serve`, `connect`, `eval` commands |
| `@open-web-agent/tui` | OpenTUI + SolidJS terminal client |
| `@open-web-agent/browser` | Playwright browser environment |
| `@open-web-agent/agents` | ReAct, SeeAct, and Python agent adapters |
| `@open-web-agent/models` | Provider adapters and YAML/env config loader |
| `@open-web-agent/storage` | SQLite metadata store and artifact store |
| `@open-web-agent/eval` | Replay fixture comparison helpers |

Import across packages by workspace package name, not deep relative paths.

## Local Server Boundary

The local server exists so the TUI, headless CLI, and future clients share the same HTTP/SSE boundary. The default command starts the server in process on `127.0.0.1:0` and passes the generated URL to the TUI.

There is no auth layer in the current sprint. Loopback binding is the protection boundary, so the server should stay bound to loopback hosts.

## Server API

| Route | Purpose |
|---|---|
| `GET /health` | Health check. |
| `GET /plugins` | List agents, models, browser environments, and defaults. |
| `GET /events` | Live run-event SSE stream. |
| `POST /sessions` | Create a project session. |
| `GET /sessions` | List persisted sessions. |
| `GET /sessions/:sessionId` | Load or attach a session browser. |
| `PATCH /sessions/:sessionId` | Rename or pin a session. |
| `DELETE /sessions/:sessionId` | Soft-delete a session. |
| `POST /runs` | Start a run for a session. |
| `GET /runs/:runId` | Read run status. |
| `POST /runs/:runId/cancel` | Cancel a running run. |
| `PATCH /config/model` | Persist selected model and reasoning effort. |
| `PATCH /config/agent` | Persist selected agent. |
| `PATCH /config/browser` | Persist selected browser. |
| `PATCH /config/browser/headless` | Persist and apply browser headless mode. |
