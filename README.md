# Open Web Agent

A small browser agent that is also a browser MCP server.

- **`owa mcp`**: exposes Playwright browser tools to any MCP client (Claude Code, Cursor, …) over stdio.
- **`owa run "<task>"`**: runs the built-in agent loop on the *same* tools and prints the answer.
- **`owa mcp --agent`**: also exposes `browser_task`. Your coding agent can hand off a whole web task to the built-in agent, running on a model you choose, and only the final answer comes back into its context.

Models plug in by **API format** (OpenAI Chat Completions or Anthropic Messages) or by a module you write yourself. No provider SDKs are involved. The runtime depends only on `playwright` and `zod`, and the source is about 1.3k lines.

Why this shape? See [docs/positioning.md](docs/positioning.md) for how it compares with playwright-mcp, agent-browser, browser-use, Stagehand, and others.

## Quick start

```bash
bun install
bunx playwright install chromium        # first time only

export OPENAI_API_KEY=...
bun run owa run "What is the top story on news.ycombinator.com right now?" --model openai:gpt-5-mini
```

`bun link` puts `owa` on your PATH.

### Use it as an MCP server

```bash
claude mcp add owa -- bun /path/to/open-web-agent/src/cli.ts mcp
# with delegation to a cheaper model:
claude mcp add owa -e OPENROUTER_API_KEY=... -- bun /path/to/open-web-agent/src/cli.ts mcp --agent --model openrouter:qwen/qwen3-coder
```

Any other MCP client can use the equivalent JSON config:

```json
{ "mcpServers": { "owa": { "command": "bun", "args": ["/path/to/open-web-agent/src/cli.ts", "mcp"] } } }
```

## Models

`--model provider:model` (or `OWA_MODEL`). Provider names are shorthands for an API format, a base URL, and a key environment variable:

| provider | API format | key env |
|---|---|---|
| `openai` | openai | `OPENAI_API_KEY` |
| `anthropic` | anthropic | `ANTHROPIC_API_KEY` |
| `openrouter` | openai | `OPENROUTER_API_KEY` |
| `gemini` | openai (Gemini's OpenAI endpoint) | `GEMINI_API_KEY` |
| `ollama` | openai (`localhost:11434`) | — |

To reach any other OpenAI- or Anthropic-compatible endpoint (vLLM, LM Studio, a gateway, …), pass the URL and the format:

```bash
owa run "..." --base-url http://localhost:8000/v1 --api openai --model my-model   # OWA_API_KEY for auth
```

Pass additional API request fields with `--model-options` or `OWA_MODEL_OPTIONS`:

```bash
owa run "Read the heading on https://example.com" --model openai:gpt-6-luna \
  --model-options '{"reasoning_effort":"none"}' --headless

export OWA_MODEL_OPTIONS='{"temperature":0}'
```

The CLI JSON object replaces the entire environment object; `{}` clears environment options.
Options also apply to `owa mcp --agent`. They pass unchanged to either API adapter (or
as `config.extraBody` to a custom module), so supported fields and values depend on your endpoint.
No reasoning defaults are inferred from the model name. For the library, pass `extraBody` to `resolveModel`.
Additional fields override adapter defaults such as Anthropic's `max_tokens`, but `model`,
`messages`, `tools`, `system`, `stream`, and authentication fields (`api_key`, `apiKey`,
`authorization`, `headers`) are reserved. Use the existing model and API key settings for these.
Invalid JSON and non-object values fail before making a model request without echoing their values.

To plug in anything else, write a module that default-exports a `ModelAdapter`, or a function that returns one:

```ts
// my-model.ts
import type { ModelAdapter } from "open-web-agent"

export default (config): ModelAdapter => ({
  name: "my-model",
  async complete({ system, messages, tools, signal }) {
    // call your model here; return { text?, toolCalls: [{ id, name, arguments }] }
  },
})
```

```bash
owa run "..." --model-module ./my-model.ts
```

## Tools

| tool | what it does |
|---|---|
| `browser_navigate`, `browser_go_back` | open a URL / go back |
| `browser_snapshot` | accessibility snapshot with `[ref=eN]` element handles |
| `browser_click`, `browser_type`, `browser_select_option`, `browser_hover`, `browser_press_key`, `browser_scroll` | act on refs; each returns a fresh snapshot |
| `browser_wait_for` | wait for text to appear or disappear, or for a number of seconds |
| `browser_get_text` | visible text of the page or of one element |
| `browser_screenshot` | PNG of the viewport or full page |
| `browser_evaluate` | run JavaScript in the page (**opt-in**: `--caps unsafe`) |

The agent keeps only the newest snapshot and screenshot in its context. It stops after repeated failed steps, and when it runs out of steps it makes one last call to get a best-effort answer.

## Options

```
--headless                   OWA_HEADLESS=1
--browser chromium|firefox|webkit
--cdp http://127.0.0.1:9222  attach to your running Chrome instead of launching one
--user-data-dir <dir>        persistent profile (logins survive restarts)
--executable-path <path>
--caps core,unsafe
--max-steps <n>              default 30
--trace run.jsonl            append agent events as JSONL
--json                       (run) print the full result as JSON
```

## Library

```ts
import { BrowserSession, runAgent, resolveModel } from "open-web-agent"

const browser = new BrowserSession({ headless: true })
const result = await runAgent({
  task: "Find the price of the Pro plan on example.com",
  model: await resolveModel({ model: "anthropic:claude-sonnet-5" }),
  browser,
})
await browser.close()
```

## Development

```bash
bun run typecheck
bun run test          # launches headless Chromium against a local fixture server
```

### Delegated task results

`owa run --json` and MCP `browser_task.structuredContent` return the same compact result:
`answer`, `status`, `stopReason`, `outcome`, `observedUrls`, `durationMs`, `steps`, and `usage`
(and `error` for a failed model request). MCP still returns readable text beginning with the answer.

`status: completed` only means the model produced a final answer. `stopReason` distinguishes
`final_answer`, `step_limit`, `tool_failures`, and `model_error`. The model reports an
`outcome.status` of `succeeded`, `partial`, or `blocked`, with an `unfinished` list; legacy plain
text or malformed final JSON produces `unknown`. Every outcome is explicitly `unverified`.
There is no independent success judge. `observedUrls` contains the last 20 distinct HTTP(S)
URLs the browser actually visited during the task, not verified citations supporting the answer.

Partial/blocked outcomes and execution limits/failures produce MCP `isError: true` and a nonzero
CLI exit code. An unknown outcome is not treated as an execution error, but is not proof of success.
