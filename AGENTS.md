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

### Claude Code cloud sessions

In a cloud session (`CLAUDE_CODE_REMOTE=true`), the SessionStart hook in `.claude/settings.json` runs `scripts/cloud-setup.sh`. It installs dependencies and Chromium, and does nothing locally. Bun's package fetching is known to fail behind the cloud proxy, so the script falls back to `npm install`; that is the only place npm is used. Chromium downloads need `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`, which the default **Trusted** network level does not allow. Set the cloud environment's network access to **Custom**, add both domains, and keep the default list.

## Commit & PR conventions

Prefix every commit message and pull request title with a bracketed type tag: `[type] contents`.

- `[feat]` — new functionality
- `[fix]` — bug fixes
- `[refactor]` — code restructuring with no behavior change
- `[test]` — adding or updating tests
- `[docs]` — documentation-only changes (README, CLAUDE.md, etc.)
- `[chore]` — tooling, deps, and other non-functional changes

Example: `[fix] keep snapshot refs stable across tabs`. After the tag, write the description in lowercase and in the imperative mood.

## Issue workflow

Issues are resolved in three stages. An orchestrating agent files the issue, delegates the fix to Codex, then reviews and merges the PR. Codex implements.

1. **File the issue.** One problem per issue, with a `[type]` title as above. Write the body in Korean, like the existing issues, with these parts:
   - 우선순위
   - 문제와 근거: evidence, with permalinks to the base commit
   - 재현
   - 개선 및 완료 기준: a checklist
   - 검토 기준: the base commit
2. **Delegate to Codex, one issue at a time.**
   - Create a worktree and branch from the latest `origin/main`: `git worktree add -b <type>/<issue>-<slug> .worktrees/<issue>-<slug> origin/main`. `.worktrees/` is gitignored, and modules resolve from the root `node_modules`.
   - Run Codex in it, for example `codex-companion.mjs task --write --model gpt-6-astra --effort low --cwd .worktrees/<issue>-<slug> --prompt-file <prompt>` from the Codex plugin. The prompt carries:
     - the issue text and implementation notes
     - how to verify
     - a request for a summary, a commit message, and a PR description
   - Codex's sandbox has no network, so it cannot push or open PRs. It may also be unable to launch Chromium or bind ports. The orchestrator therefore commits, pushes, and opens the PR. The PR body has `Closes #N.`, a description, a Validation list, and "Implemented by Codex (…)".
3. **Review and merge.**
   - Check the diff against the issue's acceptance criteria and the rules of thumb below.
   - Outside the sandbox, run `bun run typecheck` and `bun run test` and compare with `main`. Rerun once before blaming the PR for a browser-test failure.
   - Scripted tests cannot show the effect of prompt or agent-behavior changes. For those:
     - Run a live check with a real model (`bun run eval --live …`, or the same real-site tasks before and after) and record the numbers in the PR.
     - When the issue makes a change conditional on improvement, A/B it and drop what does not help.
     - Live runs cost money, so keep them out of `bun run test`.
   - Small reviewer edits are fine, such as a comment, a doc sentence, or dropping a no-op assertion; mention them in the PR. Send anything larger back to Codex.
   - Post a short check comment (Korean), then `gh pr merge --squash`. Merge each PR before delegating the next issue, since issues often touch the same files. Remove the worktree afterwards.

When you are Codex working on a delegated issue:
- Stay in the given worktree and keep the change scoped to the issue.
- Add focused tests, and run `bun run typecheck` plus the test files you touched.
- Do not commit, push, or create branches.
- Finish with the summary, commit message, and PR description the prompt asks for.

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
