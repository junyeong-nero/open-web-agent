# Open Web Agent

A small browser agent that is also a browser MCP server.

- **`owa mcp`**: exposes Playwright browser tools to any MCP client (Claude Code, Cursor, …) over stdio.
- **`owa run "<task>"`**: runs the built-in agent loop on the *same* tools and prints the answer.
- **`owa mcp --agent`**: also exposes `browser_task`. Your coding agent can hand off a whole web task to the built-in agent, running on a model you choose, and only the final answer comes back into its context.

Models plug in by **API format** (OpenAI Chat Completions or Anthropic Messages) or by a module you write yourself. No provider SDKs are involved. The runtime depends only on `playwright` and `zod`, and the runtime source is about 1.9k lines.

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
| `browser_tabs`, `browser_select_tab` | list open tabs and select one without reloading |
| `browser_navigate`, `browser_go_back` | open a URL / go back |
| `browser_snapshot` | accessibility snapshot with `[ref=eN]` element handles |
| `browser_click`, `browser_type`, `browser_select_option`, `browser_hover`, `browser_press_key`, `browser_scroll` | act on refs; each returns a fresh snapshot |
| `browser_wait_for` | wait for text to appear or disappear, or for a number of seconds |
| `browser_get_text` | visible text of the page or of one element; `offset` reads past the length limit |
| `browser_screenshot` | PNG of the viewport or full page |
| `browser_evaluate` | run JavaScript in the page (**opt-in**: `--caps unsafe`) |

The agent keeps only the newest snapshot and screenshot in its context. It stops when it runs out of steps, after repeated failed steps, or when it stops making progress. In each of these cases it makes one last call to get a best-effort answer.

Before an action or navigation returns its snapshot, it waits for the page to settle: the page's own
documents, scripts, styles and XHR/fetch requests started since the action have returned, a WebSocket of
its own that it wrote to has answered and gone quiet for a second, a new document has reached its load
event (or one second past DOMContentLoaded), and two checks 0.15 seconds apart see the same URL and the
same snapshot the model will get. A fetch counts as returned once its response arrives, since pages do not
always read the body. Requests to other sites (analytics, ads, maps, chat widgets), event streams, beacons,
`blob:` URLs and requests that were already open do not count, and neither does a timer that changes the
page later. An empty tree has not rendered yet. A static page waits about 0.15 seconds. The wait adds at
most 3 seconds (`BrowserOptions.settleTimeoutMs`; 0 turns it off), counted from the page's first answer to
a check, and an empty page may wait as long as an action. A page still changing then is returned with
`The page may still be changing.`

Navigation results report HTTP error statuses, for example `The server responded with HTTP 403.`, and keep the error page's snapshot. A navigation that turns into a file download fails with the file's content type and name instead of Playwright's `Download is starting`. That covers a PDF, or a bot wall that serves `application/blank`. Other failed actions keep Playwright's reason, such as the element that intercepted a click. Optional arguments sent as `null` count as omitted, and `browser_press_key` accepts key names in any case (`END`, `CTRL+A`).

If a browser action completes but its follow-up snapshot fails, the tool preserves the action's
success and reports that the current page state is unavailable. Call `browser_snapshot` for fresh
refs before taking another action; repeating a click or submission could duplicate its effects.
Action completion describes the browser operation, not verification that the website accepted it.

A ref whose element is gone does not wait for the action timeout. If the page replaced the element
with exactly one element of the same role and name (for example during hydration), the tool uses it
and says so. Otherwise it fails at once and returns a fresh snapshot.

Snapshots longer than 40,000 characters are cut. When one is cut, its open dialogs (`dialog`,
`alertdialog`) come first and the rest of the page fills the remaining space, so a modal rendered at
the end of the page stays visible and its refs work.

A checkbox or radio covered by its own label, as when a site hides the input under a styled label, is
clicked through that label at the same point instead of waiting for the action timeout, and the result
says so. Anything else on top, such as a dialog or a cookie banner, still fails the click with an error
that names it.

## Options

```
--headless                   OWA_HEADLESS=1
--locale <tag>               OWA_LOCALE, BCP 47 tag such as ko-KR
--browser chromium|firefox|webkit
--cdp http://127.0.0.1:9222  attach to your running Chrome instead of launching one
--user-data-dir <dir>        persistent profile (logins survive restarts)
--executable-path <path>
--caps core,unsafe
--max-steps <n>              default 30
--timeout-ms <n>             total agent deadline, default 300000
--trace run.jsonl            append agent events as JSONL
--json                       (run) print the full result as JSON
```

Locale applies to both `run` and `mcp`; `--locale` overrides `OWA_LOCALE`.
It sets the browser language and Accept-Language header for new and persistent contexts.
Omitting it preserves the current browser defaults. With `--cdp`, an existing context
keeps its locale. Library callers can set `BrowserOptions.locale`, for example
`new BrowserSession({ headless: true, locale: "ko-KR" })`.

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

[CLAUDE.md](CLAUDE.md) describes the issue, implementation and review workflow, including Claude Code cloud sessions. Open work and known limitations are in [docs/TODO.md](docs/TODO.md).

### Delegated task results

`owa run --json` and MCP `browser_task.structuredContent` return the same compact result:
`answer`, `status`, `stopReason`, `outcome`, `observedUrls`, `durationMs`, `steps`, and `usage`
(and `error` for a failed model request). MCP still returns readable text beginning with the answer.

`status: completed` only means the model produced a final answer. `stopReason` distinguishes
`final_answer`, `step_limit`, `no_progress`, `tool_failures`, `model_error`, `timeout`, and `cancelled`. The model is asked to write the
user-facing answer first, then a final line containing only
`{"outcome":"succeeded|partial|blocked","unfinished":["any remaining work"]}`.
This populates `outcome.status` and its `unfinished` list. When a final answer has no outcome
line, the agent sends one tool-less follow-up request for it and keeps the original answer.
Like runs that reach the step limit, runs that stop for `no_progress` or `tool_failures` make one
more tool-less request for the best answer and outcome so far; they still report `status: failed`.
Pure JSON replies with `answer`,
`outcome`, and `unfinished` remain supported; plain text or malformed metadata produces
`unknown`. Every outcome is explicitly `unverified`.
There is no independent success judge. `observedUrls` contains the last 20 distinct HTTP(S)
URLs the browser actually visited during the task, not verified citations supporting the answer.

Partial/blocked outcomes and execution limits/failures produce MCP `isError: true` and a nonzero
CLI exit code. An unknown outcome is not treated as an execution error, but is not proof of success.

For an explicit real-model evaluation (separate from unit tests), run `bun run eval --live --model
openai:gpt-6-luna --model-options '{"reasoning_effort":"none"}'`. See [evaluation instructions](docs/evaluation.md)
for cases, JSON reports and the direct-operation versus delegation comparison procedure. To compare
models on real websites, `bun run bench` runs a task file with several model configurations and
summarizes them side by side ([real-site benchmark](docs/evaluation.md#real-site-benchmark)).

### Usage and cost

Each model call's usage has the fields below. A value the provider did not send is left out, never
written as zero.

| field | meaning | OpenAI format `usage` (OpenAI, OpenRouter, Gemini, …) | Anthropic `usage` |
|---|---|---|---|
| `inputTokens` | all input tokens, cache reads and writes included | `prompt_tokens` | `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` |
| `outputTokens` | output tokens | `completion_tokens` | `output_tokens` |
| `cachedInputTokens` | input tokens read from the prompt cache | `prompt_tokens_details.cached_tokens` | `cache_read_input_tokens` |
| `cacheWriteTokens` | input tokens written to the prompt cache | `prompt_tokens_details.cache_write_tokens` (OpenRouter) | `cache_creation_input_tokens` |
| `cost` | what the provider charged, in its own unit (OpenRouter: US dollars) | `cost` (OpenRouter) | — |

Uncached input is `inputTokens - cachedInputTokens - cacheWriteTokens`. The task result's `usage`
(`owa run --json`, `browser_task.structuredContent`) sums the calls: `inputTokens` and `outputTokens`
are always present and count a call that reported nothing as zero, `cachedInputTokens` and
`cacheWriteTokens` add up the calls that reported them, and `cost` appears only when every call
reported one, because a sum that skipped calls would understate the bill.

`--trace` writes a `model` event for each model response with that call's `usage`, `durationMs` (the
call's wall-clock time) and `model`, the model the response named. `model` can differ from the
configured one: OpenAI may name a dated snapshot, and a router such as `openrouter:typesafe/jev-router`
names the model it chose. A failed call writes no `model` event.

### Task limits and cancellation

Agent tasks have a five-minute deadline by default. Set `--timeout-ms` for CLI runs or the MCP
server default; `browser_task` also accepts `timeoutMs`. Library callers can pass `timeoutMs`
and an `AbortSignal`. MCP `notifications/cancelled` is handled immediately, even for queued
requests. Results use `stopReason: timeout` or `cancelled` and retain already-collected usage,
observed URLs and any available partial model text. Stopping does not make another model call.

Cancellation during a browser operation closes the owned browser (or disconnects a CDP session)
and waits for the old operation to settle before releasing the queue. A subsequent task can reopen
the session. Cancellation cannot undo actions already performed; browser launch/cleanup can extend
past the requested deadline. Cancelling only a model request leaves the browser available.

Only the newest `browser_get_text` body is sent back to the model; older bodies become placeholders.
Three consecutive steps with identical actions and observed state stop with `no_progress`.
Waits, scrolling, failed tools and results without observed state are excluded to avoid treating
normal waiting as a loop. Cycles across pages are counted too: re-opening a page (same URL without
fragment, same title, at most a third new snapshot lines) is a repeat, and opening anything new resets
the counts, so returning to a list between new detail pages never adds up. A page's fourth repeat
stops the run with `no_progress`.

Tab snapshots include a stable `Page tab: tN` identifier. `browser_tabs` lists IDs, titles, URLs
and the selected tab; `browser_select_tab` accepts `{ "tabId": "t1" }`, preserves existing page
state, and returns a fresh snapshot. Use refs from that new snapshot for subsequent actions.
Unknown/closed IDs fail explicitly; IDs are not reused when the session restarts. New tabs still
become current automatically, and closing the current tab still selects another open tab.
