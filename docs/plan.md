# Open Web Agent Terminal Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `open-web-agent`, a terminal-first web agent runtime that runs from a project directory, controls a browser through typed actions, streams every run event to a TUI, and persists local traces for debugging and replay.

**Architecture:** The product is split into a CLI, a local Hono server, a runtime core, and an OpenTUI/Solid client. Agents return `browser_actions`; each browser action contains concrete tool calls such as `navigate`, `click`, `type`, and `screenshot`, and the orchestrator executes those calls through the selected browser environment. The first sprint proves the architecture with mock runtime execution, SSE live events, JSONL traces, and a minimal TUI shell without real Playwright or real LLM calls.

**Tech Stack:** Bun, TypeScript, Hono, SSE, Zod, OpenTUI, `@opentui/solid`, JSONL trace files, Playwright in the browser phase, direct HTTP model adapters for OpenAI/OpenRouter-compatible providers.

## Document Map

- [Overview, architecture, contracts, API, storage, tests, and risks](plan/overview.md)
- Phase documents below contain the phase summary and any matching Sprint 1 detailed tasks.

## Phases

| Phase | Document | Detail |
| --- | --- | --- |
| Phase 0 | [Bun Monorepo Conversion](plan/phase-00-bun-monorepo-conversion.md) | Task 1 |
| Phase 1 | [Core Contracts And Event Bus](plan/phase-01-core-contracts-and-event-bus.md) | Task 2, Task 3 |
| Phase 2 | [Mock Runtime Loop](plan/phase-02-mock-runtime-loop.md) | Task 4 |
| Phase 3 | [Local Server](plan/phase-03-local-server.md) | Task 5 |
| Phase 4 | [CLI And TUI Shell](plan/phase-04-cli-and-tui-shell.md) | Task 6, Task 7, Task 8 |
| Phase 5 | [Playwright Browser Environment](plan/phase-05-playwright-browser-environment.md) | Post-Sprint 1 overview only |
| Phase 6 | [Model Providers](plan/phase-06-model-providers.md) | Post-Sprint 1 overview only |
| Phase 7 | [SimpleReActAgent](plan/phase-07-simple-react-agent.md) | Post-Sprint 1 overview only |
| Phase 8 | [SQLite Persistence And Resume](plan/phase-08-sqlite-persistence-and-resume.md) | Post-Sprint 1 overview only |
| Phase 9 | [PlanActAgent](plan/phase-09-plan-act-agent.md) | Post-Sprint 1 overview only |
| Phase 10 | [Evaluation And Replay](plan/phase-10-evaluation-and-replay.md) | Post-Sprint 1 overview only |

## Sprint 1 Task Mapping

| Task | Phase document |
| --- | --- |
| Task 1: Convert To Bun Workspace | [Phase 0](plan/phase-00-bun-monorepo-conversion.md) |
| Task 2: Core Schemas | [Phase 1](plan/phase-01-core-contracts-and-event-bus.md) |
| Task 3: Event Bus And JSONL Store | [Phase 1](plan/phase-01-core-contracts-and-event-bus.md) |
| Task 4: Mock Runtime | [Phase 2](plan/phase-02-mock-runtime-loop.md) |
| Task 5: Hono Local Server | [Phase 3](plan/phase-03-local-server.md) |
| Task 6: CLI Entrypoint | [Phase 4](plan/phase-04-cli-and-tui-shell.md) |
| Task 7: TUI State And Shell | [Phase 4](plan/phase-04-cli-and-tui-shell.md) |
| Task 8: End-To-End Sprint 1 Smoke | [Phase 4](plan/phase-04-cli-and-tui-shell.md) |
