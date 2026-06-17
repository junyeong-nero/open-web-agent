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

## Run TUI

```bash
bun run packages/cli/src/index.ts
```

## Run Server Only

```bash
bun run packages/cli/src/index.ts serve --port 4096 --hostname 127.0.0.1
```

## Development Commands

```bash
bun run typecheck
bun test
bun run packages/cli/src/index.ts run "example.com에 접속해서 페이지 제목을 알려줘"
```

Trace output is written under `OWA_HOME` when set, otherwise `~/.open-web-agent`.
