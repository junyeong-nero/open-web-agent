# Open Web Agent

Open Web Agent is a terminal-first web agent runtime. It runs a local loopback server, drives a Playwright browser through typed browser actions, streams run events to an OpenTUI terminal client, and stores JSONL traces for replay and debugging.

![Open Web Agent TUI and Playwright browser](docs/assets/open-web-agent-tui-browser.png)

## Quick Start

Install dependencies with Bun:

```bash
bun install
```

Start the TUI from the current project directory:

```bash
bun run packages/cli/src/index.ts
```

Run a headless one-shot task:

```bash
OPENAI_API_KEY=sk-... \
  bun run packages/cli/src/index.ts run "Open example.com and summarize the page"
```

Development aliases point at the same TUI entry:

```bash
bun run dev
bun run owa
```

Without provider credentials, model-backed runs report that no model is configured.

## Documentation

- [How it works](docs/how-it-works.md) - runtime flow, package boundaries, local server, and API routes.
- [CLI and TUI](docs/cli.md) - source commands, slash commands, agents, models, and browsers.
- [Configuration](docs/configuration.md) - YAML, environment variables, credentials, and local data paths.
- [Python agents](docs/python-agents.md) - project-local agent manifests and protocols.
- [Evaluation](docs/evaluation.md) - replay fixture comparisons.
- [Development](docs/development.md) - typecheck and test commands for contributors.

The phased build plan remains in [docs/plan/](docs/plan/).
