# Open Web Agent

Open Web Agent is a terminal-first web agent runtime. It starts from a project directory, exposes a local HTTP/SSE runtime boundary, streams run events to a TUI, and writes local traces for debugging.

## Current Sprint 1 Capability

Sprint 1 runs a deterministic mock browser task. The prompt `example.com에 접속해서 페이지 제목을 알려줘` produces browser action events, writes `events.jsonl`, and returns:

```text
페이지 제목은 "Example Domain"입니다.
```

Real Playwright control and real model providers are planned after the mock runtime is stable.

## Install

```bash
bun install
```

## Run Headless Mock Task

```bash
bun run packages/cli/src/index.ts run "example.com에 접속해서 페이지 제목을 알려줘"
```

Select a project-local agent from `agents/<agent-id>/agent.yaml`:

```bash
bun run packages/cli/src/index.ts run --agent text-vision-mixed-grounding "Use mixed grounding on example.com"
```

## Run TUI

```bash
bun run packages/cli/src/index.ts
```

## Run Server Only

```bash
bun run packages/cli/src/index.ts serve --port 4096 --hostname 127.0.0.1
```

## Configuration

Open Web Agent reads user-level model settings from `~/.openwebagents/config.yaml`.

```yaml
model: "gpt-4.1-mini"
reasoning_effort: "medium"
context_window_tokens: 128000
openai_api_key: "sk-..."
openrouter_api_key: "sk-or-..."

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

Set one or both provider keys. Environment variables still take precedence when present:
`OPEN_WEB_AGENT_MODEL`, `OPEN_WEB_AGENT_REASONING_EFFORT`,
`OPEN_WEB_AGENT_CONTEXT_WINDOW_TOKENS`, `OPENAI_API_KEY`, and
`OPENROUTER_API_KEY`.

## Development Commands

```bash
bun run typecheck
bun test
bun run packages/cli/src/index.ts run "example.com에 접속해서 페이지 제목을 알려줘"
```

Trace output is written under `OWA_HOME` when set, otherwise `~/.open-web-agent`.
