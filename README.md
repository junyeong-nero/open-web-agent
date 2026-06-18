# Open Web Agent

Open Web Agent is a terminal-first web agent runtime. It starts from a project directory, exposes a local HTTP/SSE runtime boundary, streams run events to a TUI, and writes local traces for debugging.

## Current Capability

Open Web Agent can still run the deterministic mock browser task. The prompt `example.com에 접속해서 페이지 제목을 알려줘` produces browser action events, writes `events.jsonl`, and returns:

```text
페이지 제목은 "Example Domain"입니다.
```

Model-backed agents use the selected runtime model when `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, or `ANTHROPIC_API_KEY` is configured. The Playwright browser environment is available from the TUI with `/browser playwright-browser`.

## Install

```bash
bun install
```

## Run Headless Mock Task

```bash
bun run packages/cli/src/index.ts run "example.com에 접속해서 페이지 제목을 알려줘"
```

Select a project-local agent from `agents/<agent-id>/agent.yaml`. Model-backed external agents require a configured provider key:

```bash
OPENAI_API_KEY=sk-... bun run packages/cli/src/index.ts run --agent plan-act "Open example.com and summarize the page"
```

The `text-vision-mixed-grounding` example sends extracted text and a screenshot image to the selected model. Use it with a real screenshot-capable browser and a vision-capable model:

```text
/browser playwright-browser
/agent text-vision-mixed-grounding
Use mixed grounding on https://example.com
```

The headless `run` command currently uses `mock-browser` by default, so the TUI or server API is the right path for real vision grounding.

## Run TUI

```bash
bun run packages/cli/src/index.ts
```

## Run Server Only

```bash
bun run packages/cli/src/index.ts serve --port 4096 --hostname 127.0.0.1
```

## Configuration

Open Web Agent reads user-level runtime settings from `~/.openwebagents/config.yaml`.

```yaml
model: "nvidia/nemotron-3-super-120b-a12b:free"
model_provider: "openai"
agent: "see-act"
browser: "playwright-browser"
reasoning_effort: "medium"
context_window_tokens: 128000
max_retry: 2
openai_api_key: "sk-..."
openrouter_api_key: "sk-or-..."
gemini_api_key: "..."
anthropic_api_key: "sk-ant-..."
codex_auth_path: "~/.codex/auth.json"

parameters:
  temperature: 0
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

Set one or more provider keys. Environment variables still take precedence when present:
`OPEN_WEB_AGENT_MODEL`, `OPEN_WEB_AGENT_MODEL_PROVIDER`,
`OPEN_WEB_AGENT_AGENT`, `OPEN_WEB_AGENT_BROWSER`,
`OPEN_WEB_AGENT_REASONING_EFFORT`,
`OPEN_WEB_AGENT_CONTEXT_WINDOW_TOKENS`, `OPEN_WEB_AGENT_MAX_RETRY`,
`OPEN_WEB_AGENT_MODEL_TIMEOUT_MS`,
`OPEN_WEB_AGENT_CODEX_AUTH_PATH`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
`GEMINI_API_KEY`, and `ANTHROPIC_API_KEY`.

If Codex file-backed ChatGPT auth is available at `codex_auth_path`, or if
`CODEX_ACCESS_TOKEN` is set, the runtime also registers the `codex-oauth`
provider. Changing models from the TUI with `/model <id>` writes the selected
provider and provider model name back to `~/.openwebagents/config.yaml`.
Changing agents with `/agent <id>` or browsers with `/browser <id>` writes the
selected runtime IDs to the same file, so the next TUI session starts with the
same selections.

## Development Commands

```bash
bun run typecheck
bun test
bun run packages/cli/src/index.ts run "example.com에 접속해서 페이지 제목을 알려줘"
```

Trace output is written under `OWA_HOME` when set, otherwise `~/.open-web-agent`.
