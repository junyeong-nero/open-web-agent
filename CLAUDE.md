# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Open Web Agent is a terminal-first web agent runtime. A CLI starts an in-process local Hono server (loopback only), the runtime drives a Playwright browser through typed tool calls, streams every run event over SSE to an OpenTUI terminal client, and persists JSONL traces for debugging/replay. It is an early-stage project; the default runtime uses model-backed agents and real browser automation.

## Commands

This is a **Bun** monorepo (not Node/npm). Use `bun`, never `npm`/`yarn`.

```bash
bun install                 # install workspace deps
bun run typecheck           # tsc -b across all package project references
bun test                    # run all tests (bun's built-in runner)
bun test packages/core/src/events/event-bus.test.ts   # single file
bun test -t "publishes events"                         # by test-name substring
```

Run the CLI directly from source (no build step — packages resolve via `main: ./src/index.ts`):

```bash
bun run packages/cli/src/index.ts                       # default: in-process server + TUI
bun run packages/cli/src/index.ts run "<prompt>"        # headless: one run, compact logs, exit
bun run packages/cli/src/index.ts serve --port 4096 --hostname 127.0.0.1   # server only
bun run packages/cli/src/index.ts --connect http://127.0.0.1:4096          # TUI only, attach
bun run packages/cli/src/index.ts eval --task <id> --combo agent/model/env # replay eval
# also: --continue (resume last session), --session <id>
```

`bun run dev` / `bun run owa` are aliases for the default CLI invocation.

There is no build/bundle step for development — `tsc -b` is **typecheck only** (composite projects emit declarations to `packages/*/dist`, which is gitignored). Always run `bun run typecheck` after changes; per-package strict TypeScript is enforced.

## Commit & PR conventions

Prefix every commit message and pull request title with a bracketed type tag: `[type] contents`.

- `[feat]` — new functionality
- `[fix]` — bug fixes
- `[refactor]` — code restructuring with no behavior change
- `[test]` — adding or updating tests
- `[docs]` — documentation-only changes (README, CLAUDE.md, etc.)
- `[chore]` — tooling, deps, and other non-functional changes

Example: `[fix] update TUI prompt footer metadata`. Keep the description lowercase and in the imperative mood after the tag, matching existing history.

## Architecture

### Execution flow (the core loop)

```
CLI command → in-process Hono server (127.0.0.1) → RunOrchestrator
  → AgentPlugin.step() → AgentDecision
      ├ "browser_actions" → BrowserAction[].toolCalls[] → BrowserEnvironment.execute(toolCall)
      └ "final_answer"    → AgentPlugin.finalize() → run.completed
  → ctx.emit(RunEvent) → EventBus → (SSE live stream + JSONL trace file)
```

`RunOrchestrator.executeRun` (`packages/core/src/orchestrator/run-orchestrator.ts`) owns the whole lifecycle: it resets the environment, captures an `observation.captured`, then loops up to `maxSteps` calling `agent.step()`. Every event flows through a single `emit()` closure that assigns a **monotonic per-run `sequence`**, appends to `events.jsonl`, and publishes to the `EventBus`. Cancellation is cooperative via `AbortController`/`AbortSignal` threaded through `RuntimeContext`.

### Contracts are the source of truth (`packages/core/src/contracts/`)

Every runtime boundary is a Zod schema with an inferred TypeScript type — `event.ts`, `browser.ts`, `agent.ts`, `model.ts`, `plugin.ts`. When changing what flows between agents, environments, the server, and the TUI, **edit the schema first**; types derive from it. Key shapes:

- `AgentDecision` — discriminated union on `type`: `browser_actions` or `final_answer`. There is intentionally **no top-level tool-call decision**; all browser ops nest under `browser_actions → BrowserAction → toolCalls[]`.
- `BrowserToolCall` — discriminated union on `type` (`navigate`, `click`, `type`, `scroll`, `wait`, `press_key`, `screenshot`, `extract_text`, `go_back`, `go_forward`).
- `RunEventType` — the closed enum of every event the system can emit; the TUI and JSONL store both depend on it.

### Plugins and the registry

`AgentPlugin`, `ModelPlugin`, and `BrowserEnvironment` (`contracts/plugin.ts`) are registered by string `id` in a `PluginRegistry`. `startDefaultRuntime` (`packages/server/src/default-runtime.ts`) is the composition root — it wires which concrete plugins exist:

- Agents: `simple-react-agent`, `see-act`
- Environments: `playwright-browser`
- Models: `OpenAIModel` / `OpenRouterModel` are registered **only if** the corresponding API key is present in config. With no key, model-backed agents fail at run time.

Real agents don't hold a model directly — they call a `RuntimeSelectedModel` shim that dispatches to `ctx.modelId` (selected per-run, e.g. via `/model`) and emits `model.called`/`model.completed` around the real provider call. `OpenAIModel` and `OpenRouterModel` share an internal OpenAI-compatible chat-completions client.

### Package boundaries (`@open-web-agent/*` workspace scope)

| package | role |
|---|---|
| `core` | Zod contracts, `EventBus`, `RunOrchestrator`, `PluginRegistry`, JSONL store, path/id helpers |
| `server` | Hono app factory + routes + SSE; `startDefaultRuntime` composition root |
| `cli` | arg parsing + the `default`/`run`/`serve`/`connect`/`eval` commands |
| `tui` | OpenTUI + SolidJS terminal client (talks to the server only over HTTP/SSE) |
| `browser` | `PlaywrightEnvironment` |
| `agents` | ReAct/SeeAct/PlanAct agents |
| `models` | provider adapters + YAML/env config loader |
| `storage` | SQLite metadata store + artifact store |

**Always import across packages by package name** (`@open-web-agent/core`), never deep relative paths like `../../../core/src`. Internal deps use `"workspace:*"`.

### Why the local server exists

The TUI never embeds runtime logic — it only speaks HTTP/SSE to the server, so the same boundary serves the headless CLI and future clients. The default command starts the server in-process on `127.0.0.1:0` (random port) and hands the URL to the TUI. **Sprint-1 has no auth of any kind; loopback binding is the entire protection boundary** — do not add tokens/passwords/auth middleware, and do not bind to non-loopback hosts.

### TUI specifics

OpenTUI rendered through SolidJS. `tsconfig` uses `jsx: "preserve"` with `jsxImportSource: "@opentui/solid"`, and `bunfig.toml` sets `preload = ["@opentui/solid/preload"]` — TUI entry/components are `.tsx`. State is managed through a reducer (`packages/tui/src/state/reducer.ts`) fed by SSE events; keep UI logic state-driven and unit-test the reducer/slash-command/keybinding modules rather than rendering.

## Configuration & local data

Model settings load from `~/.openwebagents/config.yaml` (note: `.openwebagents`, no hyphen), with **env vars taking precedence**: `OPEN_WEB_AGENT_MODEL`, `OPEN_WEB_AGENT_REASONING_EFFORT`, `OPEN_WEB_AGENT_CONTEXT_WINDOW_TOKENS`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`. See README for the full YAML shape.

Run traces and SQLite metadata are written under `OWA_HOME` (note: `.open-web-agent`, **with** hyphen — different dir from the config above), defaulting to `~/.open-web-agent`:

```
$OWA_HOME/projects/<sha256(absolute project path)>/sessions/<id>/runs/<id>/events.jsonl
```

The project hash is the full 64-char lowercase SHA-256 of the resolved absolute project path (`hashProjectPath`). **Tests that exercise the orchestrator/storage must set `OWA_HOME` to a temp dir** so they never write into the developer's real home.

## Planning docs

`docs/plan/` contains the phased build plan (`overview.md` + `phase-00..10`). It describes intended end-state and Sprint-1 scope boundaries; treat it as design intent, not a description of current code. `DESIGN.md` is a visual design-system spec consumed by the TUI theme, not architecture.
