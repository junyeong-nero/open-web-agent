# OpenCode TUI Compatibility Layer Design

Date: 2026-06-27

## Goal

Allow Open Web Agent to run either its existing native TUI or a lightly forked
OpenCode TUI against the same OWA runtime.

The integration should preserve OWA's server, orchestrator, browser runtime,
agent plugins, model plugins, trace persistence, and loopback-only security
boundary. OpenCode TUI should be treated as a client surface, not as the runtime
that owns sessions or model execution.

The target CLI shape is:

```bash
bun run packages/cli/src/index.ts --tui owa
bun run packages/cli/src/index.ts --tui opencode
bun run packages/cli/src/index.ts serve --port 4096 --hostname 127.0.0.1
bun run packages/cli/src/index.ts --connect http://127.0.0.1:4096 --tui opencode
```

## User Decisions

- Keep the current OWA TUI available.
- Add an OpenCode TUI option that talks to OWA's runtime.
- Prefer an OpenCode API compatibility layer over rewriting OpenCode TUI state
  and components around OWA's existing TUI contracts.
- Keep OWA's runtime identity and product boundaries.

## Current State

OWA already has a clean client/runtime split:

```text
packages/tui -> OWA HTTP/SSE API -> packages/server -> RunOrchestrator
```

The native TUI calls small OWA-specific endpoints:

- `GET /plugins`
- `GET /sessions`
- `POST /sessions`
- `PATCH /sessions/:id`
- `DELETE /sessions/:id`
- `POST /runs`
- `POST /runs/:id/cancel`
- `GET /events`
- `PATCH /config/*`

Every run event is an OWA `RunEvent`, emitted through the existing `EventBus`
and persisted as JSONL.

OpenCode TUI is different. Its public entrypoint is `@opencode-ai/tui.run()`,
but the UI expects the OpenCode SDK v2 server contract. It directly calls
OpenCode resources such as config, provider, app agents, session, message,
event, LSP, MCP, formatter, VCS, workspace, question, and permission APIs. It
also expects OpenCode global events like `session.updated`, `message.updated`,
`message.part.updated`, and `session.status`.

Reference source inspected during design:

- OpenCode repository: `https://github.com/anomalyco/opencode`
- Branch: `dev`
- Commit: `cd56c51e2d1fabe59e88d7128bb24e546a452053`

## Design Decision

Add an OpenCode compatibility API beside OWA's existing API. The native OWA TUI
continues to use the current OWA endpoints. The OpenCode TUI uses the
compatibility endpoints and receives OpenCode-shaped events derived from OWA
sessions, runs, and run events.

```text
OWA server
  ├─ OWA API             -> current packages/tui
  └─ OpenCode compat API -> forked @opencode-ai/tui
```

The compatibility layer is a translation boundary. It does not replace OWA
contracts. OWA core contracts remain the source of truth for runtime behavior,
while the compat layer projects those contracts into the subset of OpenCode SDK
v2 shapes required by the TUI.

## Alternatives Rejected

### Rewrite OpenCode TUI Around OWA Contracts

This would quickly diverge from upstream OpenCode. The initial screen might be
faster to show, but future updates would become manual component-by-component
porting.

### Replace OWA Runtime With OpenCode Runtime

This would undermine OWA's browser-agent architecture and storage/event design.
The desired feature is an alternate terminal UI, not a runtime replacement.

### Build Only an OpenCode-Looking Native OWA TUI

This already exists as a prior visual-shell direction. It improves appearance
but does not satisfy the requirement to fork and use OpenCode TUI itself.

## Package Layout

Add these packages:

```text
packages/opencode-tui/
packages/opencode-compat/
```

`packages/opencode-tui` owns the OpenCode fork integration. It should expose a
small OWA-facing function such as:

```ts
export interface LaunchOpenCodeTuiOptions {
  serverUrl: string
  projectPath: string
  prompt?: string
  continueLast?: boolean
  sessionId?: string
}

export function launchOpenCodeTui(options: LaunchOpenCodeTuiOptions): Promise<void>
```

The package should vendor or subtree the minimal OpenCode packages needed to run
the TUI. The preferred long-term source-management strategy is `git subtree`
under a `vendor/opencode` or package-local fork directory so upstream snapshots
can be pulled intentionally and reviewed in normal diffs.

`packages/opencode-compat` owns translation logic that can be unit tested
without rendering either TUI:

- OWA plugin summaries -> OpenCode provider/config/agent lists
- OWA sessions -> OpenCode sessions
- OWA run records/messages -> OpenCode messages and parts
- OWA `RunEvent` values -> OpenCode event stream payloads
- OpenCode `session.prompt` requests -> OWA session/run creation

The server package imports `packages/opencode-compat` and mounts the compat
routes when the default runtime is started.

## Server API Shape

Expose the OpenCode-compatible API under a namespaced prefix first:

```text
/opencode/*
```

The OpenCode SDK client receives `baseUrl = <owa-server-url>/opencode`. This
keeps compat routes from colliding with existing OWA routes and makes it clear
which surface a request is using.

The first supported subset should be enough for basic chat operation:

- app agents
- config get
- config providers
- provider list
- session list
- session get
- session create
- session messages
- session prompt
- session status
- session todo
- session diff
- global event stream

Return empty successful data for nonessential TUI bootstrap surfaces:

- commands: `[]`
- LSP status: `[]`
- MCP status: `{}`
- MCP resources: `{}`
- formatter status: `[]`
- provider auth: `{}`
- VCS info: `undefined`
- workspace sync/list/status: local-only empty or single-workspace responses
- questions and permissions: empty until OWA supports equivalent workflows

Unsupported mutating operations should return a typed 501-style JSON error
unless the TUI needs a no-op to stay functional. Prefer explicit unsupported
responses for actions that could mislead the user, such as sharing, forking,
workspace creation, or provider login.

## Data Mapping

### Providers And Models

OpenCode expects providers containing model maps. OWA stores model plugins as a
flat list. The compat layer groups OWA model summaries by provider:

```text
OWA ModelSummary {
  id,
  name,
  provider,
  modelName,
  reasoningEffort,
  contextWindowTokens
}
```

becomes:

```text
OpenCode Provider {
  id: provider,
  name: provider,
  models: {
    [modelId]: {
      id: modelId,
      name,
      limit.context,
      capabilities.reasoning
    }
  }
}
```

OpenCode model selections use `{ providerID, modelID }`. The compat layer
resolves that pair back to an OWA `modelId` before submitting a run.

### Agents

OWA agent plugins map to OpenCode agents:

- `id` -> `name`
- `name` -> display name
- `description` -> description
- mode defaults to a normal visible agent

Subagents and OpenCode-specific agent modes are out of scope for the first
slice.

### Sessions

OWA sessions map to OpenCode sessions with local directory information:

- OWA `SessionSummary.id` -> OpenCode `Session.id`
- `projectPath` -> `directory`
- `title` or latest user prompt -> `title`
- `createdAt` -> `time.created`
- latest run update or `createdAt` -> `time.updated`
- deleted sessions are omitted from list responses

The compat layer should not create a separate session store. It reads and writes
through OWA's existing session/storage mechanisms.

### Messages And Parts

OWA currently has persisted user/assistant messages plus run events. OpenCode
TUI renders message parts, so the compat layer projects a minimal transcript:

- submitted prompt -> user message with one text part
- final answer -> assistant message with one text part
- model/tool/browser events -> assistant message parts or compact tool parts

For the first implementation, message history can be reconstructed from OWA
storage and recent run events. If full streaming replay is not available for old
runs, old sessions may show user/final-answer history while live runs show the
full event-derived transcript.

### Events

OWA `RunEvent` values are converted to OpenCode-shaped global events:

- session creation/update -> `session.updated`
- run start -> `session.status` working plus user/message updates
- model call/completion -> assistant message metadata or status updates
- browser action/tool events -> `message.part.updated` tool-style parts
- observation captured -> compact assistant text/tool part
- plan created/updated -> compact assistant text/tool part
- run completed -> final assistant text part and idle status
- run failed/cancelled -> status event and error text part

The translation must preserve monotonic ordering per OWA event sequence for a
single run. OpenCode event IDs do not need to match OWA event IDs, but the
mapping should be deterministic for tests.

## CLI Selection

Add a TUI selection option to CLI commands that launch an interactive client:

```text
--tui owa
--tui opencode
```

Default remains `owa` until the OpenCode path is stable. The `serve` command
does not launch a TUI, but it should expose both API surfaces from the same
server.

When `--connect` is used, the CLI only launches the selected TUI against the
remote loopback server. It must not start another runtime.

## Security

The compatibility API inherits Sprint-1's protection boundary:

- bind only to loopback by default;
- do not add auth middleware or bearer tokens;
- do not expose the server on non-loopback hosts as part of this work.

The compat prefix must not proxy arbitrary URLs or provide filesystem access
beyond what OWA runtime and storage already expose.

## Error Handling

- If OpenCode TUI requests an unsupported read endpoint needed during
  bootstrap, return an empty successful response.
- If OpenCode TUI requests an unsupported mutating endpoint, return a structured
  unsupported error unless a no-op is required to avoid a startup crash.
- If a model selection cannot be resolved to an OWA model, submit the run with
  OWA's default selected model when available; otherwise return an error that
  the TUI can show.
- If a run submission fails, emit an OpenCode-shaped session status/error event
  as well as preserving OWA's normal `run.failed` behavior.
- If OpenCode TUI crashes because a field is missing, add that field to the
  compat projection instead of changing OWA core contracts.

## Testing

Use focused compatibility tests before rendering tests.

Required test coverage:

- provider/model projection from OWA plugin summaries;
- agent projection from OWA agent summaries;
- session projection from OWA session records;
- OpenCode prompt request to OWA create-run request;
- run event to OpenCode event/message projection;
- unsupported endpoint behavior for empty read surfaces and mutating failures;
- CLI `--tui` selection dispatch;
- existing OWA TUI tests remain green.

Verification commands:

```bash
bun run typecheck
bun run test
```

Manual smoke for the first usable slice:

```bash
bun run packages/cli/src/index.ts --tui owa
bun run packages/cli/src/index.ts --tui opencode
bun run packages/cli/src/index.ts serve --port 4096 --hostname 127.0.0.1
bun run packages/cli/src/index.ts --connect http://127.0.0.1:4096 --tui opencode
```

The OpenCode TUI smoke passes when it can start, list/select an OWA agent and
model, create or resume a session, submit a prompt, show live progress, render a
final answer, and exit without leaving the server process running.

## Implementation Slices

### Slice 1: Source And Launch Boundary

Add the package boundary for launching OpenCode TUI and a CLI `--tui` selector.
This slice may use a stub launcher that reports the missing compat
surface, but the native OWA TUI must continue to work.

### Slice 2: Compat Route Skeleton

Mount `/opencode/*` routes and return bootstrap-safe empty responses for the
read-only endpoints OpenCode TUI needs before a prompt can be sent.

### Slice 3: Provider, Agent, And Session Projection

Project OWA plugins and sessions into OpenCode SDK v2 shapes. OpenCode TUI
should be able to start and show available agents/models without submitting a
prompt yet.

### Slice 4: Prompt Submission

Implement OpenCode `session.create` and `session.prompt` by creating or reusing
an OWA session and calling OWA's run submission path.

### Slice 5: Event Streaming And Live Transcript

Translate OWA run events into OpenCode global events and message parts. This is
the first slice where OpenCode TUI becomes genuinely useful.

### Slice 6: Polish And Unsupported Surface Audit

Audit every OpenCode TUI action reachable from the UI. Convert accidental 404s
into intentional empty/no-op/unsupported responses and document remaining gaps.

## Out Of Scope

- Replacing OWA's orchestrator with OpenCode's session runner.
- Implementing OpenCode provider authentication.
- Implementing OpenCode workspaces, worktrees, LSP, MCP, shell mode, sharing,
  forking, or timeline parity in the first usable slice.
- Binding the OWA server to non-loopback hosts.
- Removing the existing OWA TUI.
- Making both TUIs render in the same terminal process at the same time.
