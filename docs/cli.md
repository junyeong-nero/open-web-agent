# CLI and TUI

Open Web Agent runs directly from source. There is no local development build step; workspace packages resolve through `src/index.ts` entrypoints.

## CLI Commands

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

## TUI Slash Commands

```text
/help
/agent [id]
/model [id]
/browser [id]
/headless [on|off]
/themes [id]
/theme [id]
/session
/new
/stop
/clear
/details
/quit
```

Selecting an agent, model, browser, browser headless mode, or reasoning effort from the TUI persists the choice to `$OWA_HOME/config.yaml` or `~/.open-web-agent/config.yaml`.

## Runtime Options

Built-in agents and repository examples:

| ID | Notes |
|---|---|
| `simple-react-agent` | Model-backed browser-control agent. |
| `see-act` | Model-backed visual grounding agent. |
| `plan-act` | Repository example Python `jsonl` agent loaded from `agents/plan-act` when this repo is the active project. |
| `occam` | Repository example Python `jsonl` agent that uses compact AgentOccam-style observation/action commands. |
| `text-vision-mixed-grounding` | Repository example Python agent that combines extracted text and screenshots. |

Browser environments:

| ID | Notes |
|---|---|
| `playwright-browser` | Real Playwright browser environment. |

Model-backed agents use the selected runtime model. Models are registered only when the corresponding provider credentials are available through config or environment variables.

Example model-backed headless run:

```bash
OPENAI_API_KEY=sk-... \
  bun run packages/cli/src/index.ts run --agent plan-act "Open example.com and summarize the page"
```

The headless `run` command uses the configured default browser, falling back to `playwright-browser`.

For page interaction or screenshot grounding, select the Playwright browser in config or from the TUI:

```text
/browser playwright-browser
/agent text-vision-mixed-grounding
Use mixed grounding on https://example.com
```

