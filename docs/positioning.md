# Positioning

Open Web Agent is being rebuilt as a small browser MCP server and CLI agent. This note explains that choice. It compares the project with the browser-agent projects people actually use today, as of September 2026, and lists what we copy from them, where there is a gap, and what we will not build.

## The landscape

| Project | Shape | Observation | Model story | Weight |
|---|---|---|---|---|
| **microsoft/playwright-mcp** | Tool-only MCP server (Node) | Accessibility snapshot with `[ref=eN]` refs | None: the MCP client *is* the agent | Around 70 tools, split into opt-in `--caps` groups (network, storage, devtools, vision, …). Implementation now lives inside `playwright-core` |
| **ChromeDevTools/chrome-devtools-mcp** | Tool-only MCP server + CLI (Puppeteer) | Snapshot + DevTools data | None | Focused on debugging and performance: traces, network, console, Lighthouse |
| **vercel-labs/agent-browser** | Native Rust CLI for agents, plus `mcp` subcommand | Snapshot with `@eN` refs | None (drive it from Claude Code/Codex via skills) | Very large surface: tool profiles, sessions, auth vault, HAR, React inspection, diffing |
| **browser-use/browser-use** | Full Python agent framework + cloud | Indexed DOM + screenshots | `BaseChatModel` protocol with about 15 provider adapters | The agent service alone is about 4k lines. Loop detection, message compaction, judge, cloud browsers |
| **browserbase/stagehand** | SDK (TS/Python/Go) with `act` / `extract` / `observe` / `agent` | DOM + a11y hybrid | AI SDK clients and a model gateway | Multi-language monorepo, Browserbase-first, action caching |
| **magnitudedev/magnitude** | *Pivoted*: now a local-inference engine | — | — | No longer a browser agent |

## What the landscape tells us

1. **Refs from accessibility snapshots won.** playwright-mcp, agent-browser, and chrome-devtools-mcp all give the model a YAML-like accessibility tree with stable element refs and act by ref. Playwright now exposes this publicly as `page.ariaSnapshot({ mode: "ai" })` plus the `aria-ref=<ref>` locator, and it covers iframes too. We don't need our own DOM walker any more; the old `observe()` in `packages/browser` can go.
2. **Tool-only servers push cost onto the calling agent.** Every snapshot a coding agent requests is added to *its* context window, which is expensive and uses a frontier model. None of the tool-only servers lets the caller hand off a whole web subtask to a cheaper model.
3. **Full agent frameworks are heavy and cloud-shaped.** browser-use and Stagehand are complete but large. Their business models pull them toward hosted browsers, stealth, and CAPTCHA solving, and you can't read either codebase in one sitting.
4. **Tool surfaces keep growing.** playwright-mcp and agent-browser both had to add capability profiles because the full tool list wastes the client's context. Starting small is itself a feature.

## Our position

> **The smallest hackable browser agent that works both as an MCP server and as its own agent, with models you can swap by API format.**

Concretely:

- **One tool registry, two front doors.** `owa mcp` exposes the browser tools over stdio MCP. `owa run "<task>"` gives the *same* tools to a built-in agent loop. What an external agent sees is exactly what our agent sees, so you can compare the two directly.
- **The agent is also a tool.** `owa mcp --agent` adds one `browser_task` tool. Claude Code, Cursor, or any other MCP client can hand off a whole web task (for example, "find the pricing of X and return JSON") to the built-in loop, which runs on a model you choose, often a cheaper one. Only the final answer goes back into the caller's context. None of the projects above offers this.
- **Models plug in by API format, not by vendor SDK.** There are two wire formats: OpenAI Chat Completions (which also covers OpenRouter, Gemini's OpenAI endpoint, Ollama, vLLM, LM Studio, …) and Anthropic Messages. A third option is any module that exports a `ModelAdapter`. Provider names such as `openai`, `openrouter`, `anthropic`, `gemini`, and `ollama` are shorthands for a format, a base URL, and an API-key environment variable. There are no provider SDK dependencies.
- **Small enough to read.** The runtime depends only on `playwright` and `zod`. The MCP stdio transport is written by hand in about 100 lines instead of pulling in `@modelcontextprotocol/sdk`, which brings express, ajv, and more. The source target is under about 1.5k lines.

## What we borrow

| From | Idea |
|---|---|
| playwright-mcp / agent-browser | Ref-based a11y snapshots. Action tools return a fresh snapshot so the model never acts on stale refs |
| playwright-mcp / agent-browser | A small default tool set; risky tools (`browser_evaluate`) are opt-in |
| browser-use | Context hygiene: keep only the latest snapshot or screenshot in the transcript and replace older ones with a placeholder. Stop after repeated failures |
| browser-use | A model protocol so users can plug in their own models |
| Stagehand | `extract`-style reading. `browser_get_text` returns the page's visible text for answer extraction without an LLM-inside-a-tool |
| playwright-mcp | Coordinate tools behind an opt-in `vision` capability |

## Decision: an opt-in vision capability

Refs reach most of what people click, but not all of it: a button drawn on a canvas, a custom slider that another element covers, some date pickers, a popup that is not exposed as a dialog. In the October 2026 benchmark runs (#160), Google Flights' date picker and the sliders of Chase's retirement calculator kept runs going until the step limit. `--caps vision` (#166) is for these widgets. We keep it, behind a capability, for these reasons:

- **It is small.** It adds two tools and no dependency. `browser_click_at` clicks viewport coordinates through the same action path as the other tools, and `browser_locate` asks a grounding model, any `provider:model` through the existing adapters, where a described element is in a screenshot.
- **It is off by default, twice.** Without `--caps vision`, the tool list, the requests and the results stay as they were. `browser_locate` exists only when a grounding model is configured, as `browser_task` exists only with an agent model.
- **It is the one tool that calls a model.** Elsewhere, secondary models such as the judge run in the agent loop, and tools stay free of LLMs (#160). Grounding has to be a tool, because an MCP client has no agent loop of ours to hook into and both front doors must see the same tools. The grounding model only perceives: it maps a description to a point, and the calling agent decides whether to click.
- **The keyboard comes first.** A native range input takes `browser_type`, and a custom slider that implements the ARIA keyboard pattern takes `browser_click` and then `browser_press_key` (Home, arrows), all without a model. Coordinates are for what neither reaches.
- **It has to earn its place.** The capability stays only if a live A/B on those tasks, with the benchmark runner from #162, shows a gain in success, steps or cost. If it shows none, we remove it.

## Non-goals

Cloud or remote browser fleets, stealth and CAPTCHA solving, credential vaults, DevTools and performance tooling, a TUI, multi-language SDKs, self-healing action caches, and plugin registries. Any of these can be layered on outside the core. None of them belongs in it.

## Shape of the implementation

```
src/
  browser.ts          Playwright lifecycle (launch or --cdp attach), snapshots, ref resolution
  tools.ts            Tool registry: zod schema + handler per tool, shared by MCP and the agent
  mcp.ts              Hand-written stdio MCP server (initialize / tools/list / tools/call / ping)
  agent.ts            Native function-calling loop with context hygiene and failure limits
  model/types.ts      Provider-neutral messages + the ModelAdapter interface
  model/openai.ts     OpenAI Chat Completions wire format
  model/anthropic.ts  Anthropic Messages wire format
  model/resolve.ts    provider:model shorthands, env/flag config, custom adapter modules
  trace.ts            Optional JSONL trace of agent events
  cli.ts              `owa run` / `owa mcp`
  index.ts            Library exports
```
