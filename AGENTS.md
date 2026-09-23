# AGENTS.md

Guidance for AI coding agents working in this repository. (Claude Code reads `CLAUDE.md`, which mirrors this file.)

## What this is

Open Web Agent is a small browser agent that is also a browser MCP server. There is one Bun package, `src/` holds everything, and the runtime depends only on `playwright` and `zod`. Keeping it small is the product: read `docs/positioning.md` before adding surface area.

## Commands

Use `bun`, never `npm`/`yarn`.

```bash
bun install
bun run typecheck                     # tsc --noEmit (strict)
bun run test                          # all tests; they launch headless Chromium
bun test src/tools.test.ts            # single file
bun test src -t "browser_task"        # by test-name substring

bun run src/cli.ts run "<task>" --model openai:gpt-5-mini
bun run src/cli.ts mcp [--agent --model <provider:model>]
```

There is no build step. Always run `bun run typecheck` and `bun run test` after changes.

## Commit & PR conventions

Prefix every commit message and pull request title with a bracketed type tag: `[type] contents`.

- `[feat]` — new functionality
- `[fix]` — bug fixes
- `[refactor]` — code restructuring with no behavior change
- `[test]` — adding or updating tests
- `[docs]` — documentation-only changes (README, CLAUDE.md, etc.)
- `[chore]` — tooling, deps, and other non-functional changes

Example: `[fix] keep snapshot refs stable across tabs`. After the tag, write the description in lowercase and in the imperative mood.

## Architecture

| file | role |
|---|---|
| `src/browser.ts` | `BrowserSession`: lazy launch (or `--cdp` attach / persistent profile), one context, the current page follows new tabs, `snapshot()` via `page.ariaSnapshot({ mode: "ai" })`, `locator(ref)` via `aria-ref=` |
| `src/tools.ts` | The single tool registry (`TOOLS`): zod schema + handler per tool. `callTool` validates and turns every failure into an `isError` result. Action tools go through `act()`, which waits for navigation and returns a fresh snapshot |
| `src/mcp.ts` | Hand-written MCP server (`initialize`, `ping`, `tools/list`, `tools/call`), newline-delimited JSON-RPC over stdio. Tool calls are serialized. `browser_task` exists only when an agent model is configured |
| `src/agent.ts` | `runAgent`: a native function-calling loop. A reply with no tool calls is the final answer. `render()` keeps only the newest snapshot and image in context |
| `src/model/types.ts` | Provider-neutral `Message` / `ModelAdapter`. This is the whole model boundary |
| `src/model/openai.ts`, `anthropic.ts` | Wire-format adapters written directly on `fetch` (no SDKs) |
| `src/model/resolve.ts` | `provider:model` shorthands (`PROVIDERS`), env/flag config, `--model-module` loading |
| `src/cli.ts` | `owa run` / `owa mcp`. In `mcp` mode stdout is reserved for JSON-RPC, so log to stderr |

Rules of thumb:

- The MCP server and the built-in agent must see the **same** tools. Add tools only to `TOOLS` in `src/tools.ts`, and keep risky ones behind a capability (`unsafe`).
- Adding a provider means adding a `PROVIDERS` entry when it speaks an existing API format. Write a new adapter only for a genuinely new wire format.
- Don't add runtime dependencies without a strong reason. The MCP transport is hand-written on purpose; `@modelcontextprotocol/sdk` is a dev dependency, used only to test interop.
- Tests use `src/testing/fixture.ts` (a local `Bun.serve` page) and `src/testing/scripted-model.ts` (a fake `ModelAdapter`). Never call real model APIs in tests.
