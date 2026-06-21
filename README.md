# Open Web Agent

Open Web Agent is a terminal-first web agent runtime. A CLI starts a loopback-only Hono server, the runtime drives a Playwright browser through typed browser actions, events stream to an OpenTUI terminal client over SSE, and each run writes JSONL traces for debugging and replay.

The project is still early-stage. It ships model-backed agents, a Playwright browser environment, persistent sessions, and project-local Python agent examples.

## Quick Start

Install workspace dependencies with Bun:

```bash
bun install
```

Run the terminal UI from the current project directory:

```bash
bun run packages/cli/src/index.ts
```

Run a model-backed headless task:

```bash
OPENAI_API_KEY=sk-... \
  bun run packages/cli/src/index.ts run "Open example.com and summarize the page"
```

Without provider credentials, headless runs report that no model is configured:

```text
[run.failed] No model selected.
```

Development aliases point at the same TUI entry:

```bash
bun run dev
bun run owa
```

## CLI

Open Web Agent runs directly from source. There is no build step for local development; workspace packages resolve through their `src/index.ts` entrypoints.

```bash
# TUI with an in-process local server
bun run packages/cli/src/index.ts

# TUI for a specific project path
bun run packages/cli/src/index.ts /path/to/project

# Headless one-shot run
bun run packages/cli/src/index.ts run "Open example.com and summarize the page"

# Resume the latest persisted session
bun run packages/cli/src/index.ts --continue
bun run packages/cli/src/index.ts run --continue "Continue the task"

# Open a specific session
bun run packages/cli/src/index.ts --session ses_...
bun run packages/cli/src/index.ts run --session ses_... "Continue this session"

# Run only the local server
bun run packages/cli/src/index.ts serve --port 4096 --hostname 127.0.0.1

# Attach a TUI to an already-running server
bun run packages/cli/src/index.ts --connect http://127.0.0.1:4096
```

The server is intended for local use and should stay bound to loopback hosts.

## TUI Commands

Inside the TUI, slash commands control runtime selection and session state:

```text
/help
/agent [id]
/model [id]
/browser [id]
/themes [id]
/theme [id]
/session
/new
/stop
/clear
/details
/quit
```

Selecting an agent, model, browser, or reasoning effort from the TUI persists the choice to `~/.openwebagents/config.yaml`, so the next TUI session starts with the same defaults.

## Runtime Options

Built-in agents and repository examples:

| ID | Notes |
|---|---|
| `simple-react-agent` | Model-backed browser-control agent. |
| `see-act` | Model-backed visual grounding agent. |
| `plan-act` | Repository example Python `jsonl` agent loaded from `agents/plan-act` when this repo is the active project. |
| `text-vision-mixed-grounding` | Repository example Python agent that combines extracted text and screenshots. |

Browser environments:

| ID | Notes |
|---|---|
| `playwright-browser` | Real Playwright browser environment. |

Model-backed agents use the selected runtime model. Models are registered only when the corresponding provider credentials are available through config or environment variables. Supported provider paths are OpenAI, OpenRouter, Gemini, Claude, and Codex OAuth.

Example model-backed headless run:

```bash
OPENAI_API_KEY=sk-... \
  bun run packages/cli/src/index.ts run --agent plan-act "Open example.com and summarize the page"
```

The headless `run` command uses the configured default browser, falling back to `playwright-browser`. For page interaction or screenshot grounding, select `playwright-browser` in config or use the TUI:

```text
/browser playwright-browser
/agent text-vision-mixed-grounding
Use mixed grounding on https://example.com
```

## Python Agents

Project-local Python agents live under `agents/<agent-id>/agent.yaml`. The default TUI and headless `run` commands load manifests from the active project path. The lower-level `serve` command does not take a project path today, so it uses the runtime default agents directory under `OWA_HOME`.

Minimal manifest shape:

```yaml
id: my-agent
name: My Agent
description: Optional description
language: python
entry: main.py
protocol: oneshot # or jsonl
```

`oneshot` agents receive one lifecycle request on stdin and return one JSON response. `jsonl` agents can also request `model.complete` calls from the TypeScript runtime, so provider selection, model lifecycle events, cancellation, and traces stay owned by the runtime.

Shared Python helpers are available in `agents/_common`. The included examples demonstrate a plan-act model loop and mixed text/screenshot grounding.

## Configuration

Open Web Agent reads user-level runtime settings from:

```text
~/.openwebagents/config.yaml
```

Example:

```yaml
model: "nvidia/nemotron-3-super-120b-a12b:free"
model_provider: "openrouter"
agent: "see-act"
browser: "playwright-browser"
browser_prevent_focus: true
reasoning_effort: "medium"
context_window_tokens: 128000
max_retry: 2
codex_auth_path: "~/.codex/auth.json"

openai_api_key: "sk-..."
openrouter_api_key: "sk-or-..."
gemini_api_key: "..."
anthropic_api_key: "sk-ant-..."

parameters:
  # Leave temperature unset unless the selected model supports custom values.
  # temperature: 1
  # top_p: 1
  # max_tokens: 2048
  # presence_penalty: 0
  # frequency_penalty: 0
  # seed: 42
  # stop:
  #   - "<END>"
  # extra_body:
  #   reasoning_effort: "low"
```

Environment variables take precedence over YAML:

```text
OPEN_WEB_AGENT_MODEL
OPEN_WEB_AGENT_MODEL_PROVIDER
OPEN_WEB_AGENT_AGENT
OPEN_WEB_AGENT_BROWSER
OPEN_WEB_AGENT_BROWSER_PREVENT_FOCUS
OPEN_WEB_AGENT_REASONING_EFFORT
OPEN_WEB_AGENT_CONTEXT_WINDOW_TOKENS
OPEN_WEB_AGENT_MAX_RETRY
OPEN_WEB_AGENT_MODEL_TIMEOUT_MS
OPEN_WEB_AGENT_ALLOW_PRIVATE_NETWORK_NAVIGATION
OPEN_WEB_AGENT_CODEX_AUTH_PATH
OPENAI_API_KEY
OPENROUTER_API_KEY
GEMINI_API_KEY
ANTHROPIC_API_KEY
CODEX_ACCESS_TOKEN
```

`OPEN_WEB_AGENT_ALLOW_PRIVATE_NETWORK_NAVIGATION` defaults to false. Set it only for trusted local development or tests that intentionally navigate to loopback/private network fixtures.

If Codex file-backed ChatGPT auth is available at `codex_auth_path`, or if `CODEX_ACCESS_TOKEN` is set, the runtime registers the `codex-oauth` model provider.

## Local Data

Runtime data is stored under `OWA_HOME` when set, otherwise:

```text
~/.open-web-agent
```

Session metadata is stored in SQLite at `$OWA_HOME/metadata.sqlite`. Run traces are stored as JSONL under a project-hash directory:

```text
$OWA_HOME/projects/<sha256(project-path)>/sessions/<session-id>/runs/<run-id>/events.jsonl
```

The config directory (`~/.openwebagents`) and runtime data directory (`~/.open-web-agent`) are intentionally different.

## Server API

The TUI and headless CLI use the same local HTTP/SSE boundary:

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

## Eval

Replay fixture comparisons with:

```bash
bun run packages/cli/src/index.ts eval --task example-domain-title
```

Provide explicit runtime combinations with `agent/model/browser`:

```bash
bun run packages/cli/src/index.ts eval \
  --task example-domain-title \
  --combo simple-react-agent/openrouter/playwright-browser \
  --combo plan-act/openrouter:openai/gpt-5.2-codex/playwright-browser
```

The combo parser splits on the first and last slash, so model IDs may contain slashes.

## Development

This is a Bun monorepo. Use `bun`, not `npm` or `yarn`.

```bash
bun run typecheck
bun test
bun test packages/core/src/events/event-bus.test.ts
bun test -t "publishes events"
```

Always run `bun run typecheck` after changes. Tests that exercise orchestrator or storage paths should set `OWA_HOME` to a temp directory so local developer data is not touched.
