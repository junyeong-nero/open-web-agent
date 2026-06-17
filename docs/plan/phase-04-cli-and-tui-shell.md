# Phase 4: CLI And TUI Shell

[Back to plan index](../plan.md)

## Phase Summary

Goal: make `open-web-agent` usable as a terminal application with mock runs.

Implement:

```text
packages/cli/src/*
packages/tui/src/*
```

Verification:

```bash
bun test packages/cli packages/tui
bun run typecheck
```

Manual smoke:

```bash
bun run packages/cli/src/index.ts run "example.com에 접속해서 페이지 제목을 알려줘"
```

Expected result:

```text
The command prints compact run events.
The final stdout line contains: 페이지 제목은 "Example Domain"입니다.
```

## Sprint 1 Detailed Tasks

### Task 6: CLI Entrypoint

**Files:**

```text
Create: packages/cli/src/index.ts
Create: packages/cli/src/args.ts
Create: packages/cli/src/args.test.ts
Create: packages/cli/src/commands/default.ts
Create: packages/cli/src/commands/run.ts
Create: packages/cli/src/commands/serve.ts
Create: packages/cli/src/commands/connect.ts
Create: packages/cli/src/commands/run.test.ts
Modify: packages/cli/package.json
```

- [ ] Implement argument parsing.

Supported forms:

```text
open-web-agent
open-web-agent /path/to/project
open-web-agent run "<prompt>"
open-web-agent serve --port 4096 --hostname 127.0.0.1
open-web-agent --connect http://127.0.0.1:4096
```

Use this parse result shape:

```ts
export type CliArgs =
  | { mode: "default"; projectPath: string }
  | { mode: "run"; prompt: string; projectPath: string }
  | { mode: "serve"; hostname: string; port: number }
  | { mode: "connect"; serverUrl: string }
```

- [ ] Add package binary metadata.

```json
{
  "bin": {
    "open-web-agent": "./src/index.ts"
  }
}
```

`packages/cli/src/index.ts` starts with:

```ts
#!/usr/bin/env bun
```

- [ ] Implement default command for Sprint 1.

Required behavior:

```text
Starts in-process server on 127.0.0.1:0.
Creates a session for the selected project path.
Launches the OpenTUI/Solid app with { serverUrl, projectPath }.
When the TUI exits, stops the server.
```

- [ ] Implement `run` command for Sprint 1.

Required behavior:

```text
Starts in-process server.
Creates session for process.cwd().
Submits run.
Prints compact event lines.
Prints final answer.
Stops server.
```

The run command subscribes to EventBus before submitting the run, calls `orchestrator.startRun()` through the server route, and waits for the background run result before stopping the server.

Compact event format:

```text
[run.started] run_...
[browser.tool.completed] navigate https://example.com
[run.completed] 페이지 제목은 "Example Domain"입니다.
```

- [ ] Add CLI tests.

Test names:

```text
parseArgs recognizes default mode
parseArgs recognizes project path mode
parseArgs recognizes run mode
parseArgs recognizes serve mode
parseArgs recognizes connect mode
run command prints the Example Domain final answer
```

- [ ] Run verification.

```bash
bun test packages/cli
bun run typecheck
bun run packages/cli/src/index.ts run "example.com에 접속해서 페이지 제목을 알려줘"
```

Expected:

```text
CLI tests pass.
Manual run prints 페이지 제목은 "Example Domain"입니다.
```

- [ ] Commit.

```bash
git add packages/cli
git commit -m "[add] implement CLI entrypoint"
```

### Task 7: TUI State And Shell

**Files:**

```text
Create: packages/tui/src/state/types.ts
Create: packages/tui/src/state/reducer.ts
Create: packages/tui/src/state/reducer.test.ts
Create: packages/tui/src/commands/slash-commands.ts
Create: packages/tui/src/commands/slash-commands.test.ts
Create: packages/tui/src/keymap/keybindings.ts
Create: packages/tui/src/keymap/keybindings.test.ts
Create: packages/tui/src/client/server-client.ts
Create: packages/tui/src/client/event-source.ts
Create: packages/tui/src/app.tsx
Create: packages/tui/src/index.tsx
Create: packages/tui/src/components/top-bar.tsx
Create: packages/tui/src/components/conversation-panel.tsx
Create: packages/tui/src/components/timeline-panel.tsx
Create: packages/tui/src/components/inspector-panel.tsx
Create: packages/tui/src/components/browser-state-panel.tsx
Create: packages/tui/src/components/prompt-input.tsx
```

- [ ] Implement TUI reducer.

Required state updates:

```text
session.created sets activeSessionId.
run.started sets runStatus to running.
observation.captured updates browser state.
browser.action.started adds timeline item.
browser.tool.completed updates selected action summary.
run.completed sets runStatus to completed and appends final answer.
run.failed sets runStatus to failed.
run.cancelled sets runStatus to cancelled.
/details toggles inspector visibility.
```

Use this state shape:

```ts
import type { Observation, RunEvent } from "@open-web-agent/core"

export interface ConversationMessage {
  role: "user" | "assistant" | "system"
  content: string
}

export interface TimelineItem {
  eventId: string
  sequence: number
  type: RunEvent["type"]
  label: string
}

export interface TuiState {
  projectPath: string
  activeSessionId: string | null
  activeRunId: string | null
  runStatus: "idle" | "running" | "completed" | "failed" | "cancelled"
  inspectorVisible: boolean
  selectedEvent: RunEvent | null
  conversation: ConversationMessage[]
  timeline: TimelineItem[]
  browser: Observation
}
```

- [ ] Implement slash command parser.

Required commands:

```text
/help
/details
/new
/stop
/quit
```

- [ ] Implement keybinding mapping.

Required mappings:

```text
ctrl+x q -> quit
ctrl+x n -> new
ctrl+c -> cancel-or-quit
tab -> focus-next
enter -> submit
shift+enter -> newline
```

- [ ] Implement server client.

Required methods:

```text
createSession(projectPath)
submitRun(sessionId, prompt)
cancelRun(runId)
listPlugins()
health()
```

`packages/tui/src/client/server-client.ts`:

```ts
export function createServerClient(baseUrl: string) {
  return {
    async health(): Promise<{ ok: true }> {
      return request(`${baseUrl}/health`)
    },
    async createSession(projectPath: string): Promise<{ sessionId: string }> {
      return request(`${baseUrl}/sessions`, { method: "POST", body: JSON.stringify({ projectPath }) })
    },
    async submitRun(sessionId: string, prompt: string): Promise<{ runId: string }> {
      return request(`${baseUrl}/runs`, { method: "POST", body: JSON.stringify({ sessionId, prompt }) })
    },
    async cancelRun(runId: string): Promise<{ cancelled: boolean }> {
      return request(`${baseUrl}/runs/${runId}/cancel`, { method: "POST" })
    },
    async listPlugins(): Promise<unknown> {
      return request(`${baseUrl}/plugins`)
    }
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  return response.json() as Promise<T>
}
```

`packages/tui/src/client/event-source.ts` uses `fetch` streaming instead of assuming a global `EventSource`:

```ts
import { RunEventSchema, type RunEvent } from "@open-web-agent/core"

export interface EventStreamHandle {
  close(): void
}

export function createEventStream(baseUrl: string, onEvent: (event: RunEvent) => void): EventStreamHandle {
  const controller = new AbortController()

  void (async () => {
    const response = await fetch(`${baseUrl}/events`, { signal: controller.signal })
    if (!response.body) throw new Error("SSE response body is empty")

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""

    while (!controller.signal.aborted) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value

      const chunks = buffer.split("\n\n")
      buffer = chunks.pop() ?? ""

      for (const chunk of chunks) {
        const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "))
        if (dataLine) onEvent(RunEventSchema.parse(JSON.parse(dataLine.slice("data: ".length))))
      }
    }
  })().catch((error) => {
    if (!controller.signal.aborted) console.error(error)
  })

  return { close: () => controller.abort() }
}
```

- [ ] Implement OpenTUI/Solid shell.

Minimum visible panels:

```text
TopBar
ConversationPanel
TimelinePanel
InspectorPanel
BrowserStatePanel
PromptInput
```

- [ ] Add TUI tests.

Test names:

```text
reducer adds timeline item for browser action events
reducer appends final answer on run.completed
slash parser recognizes details command
slash parser rejects unknown command
keymap maps ctrl+x q to quit
```

- [ ] Implement actual OpenTUI/Solid launch.

`packages/tui/src/index.tsx`:

```tsx
import { render } from "@opentui/solid"
import { App } from "./app"

export interface LaunchTuiOptions {
  serverUrl: string
  projectPath: string
}

export async function launchTui(options: LaunchTuiOptions): Promise<void> {
  let resolved = false

  await new Promise<void>((resolve) => {
    const finish = () => {
      if (resolved) return
      resolved = true
      resolve()
    }

    void render(() => <App {...options} onExit={finish} />, {
      exitOnCtrlC: false,
      clearOnShutdown: true,
      onDestroy: finish
    })
  })
}
```

`packages/tui/src/app.tsx`:

```tsx
import { createSignal, onCleanup, onMount } from "solid-js"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { createInitialState, reduceTuiEvent } from "./state/reducer"
import { createServerClient } from "./client/server-client"
import { createEventStream } from "./client/event-source"
import { mapKeyEvent } from "./keymap/keybindings"
import { parseSlashCommand } from "./commands/slash-commands"
import { TopBar } from "./components/top-bar"
import { ConversationPanel } from "./components/conversation-panel"
import { TimelinePanel } from "./components/timeline-panel"
import { InspectorPanel } from "./components/inspector-panel"
import { BrowserStatePanel } from "./components/browser-state-panel"
import { PromptInput } from "./components/prompt-input"

export interface AppProps {
  serverUrl: string
  projectPath: string
  onExit(): void
}

export function App(props: AppProps) {
  const renderer = useRenderer()
  const client = createServerClient(props.serverUrl)
  const [state, setState] = createSignal(createInitialState(props.projectPath))
  const [prompt, setPrompt] = createSignal("")

  onMount(async () => {
    const session = await client.createSession(props.projectPath)
    setState((current) => reduceTuiEvent(current, { type: "session.created", sessionId: session.sessionId }))

    const stream = createEventStream(props.serverUrl, (event) => {
      setState((current) => reduceTuiEvent(current, { type: "run.event", event }))
    })

    onCleanup(() => stream.close())
  })

  useKeyboard((key) => {
    const action = mapKeyEvent(key)
    if (action === "quit") {
      renderer.destroy()
      props.onExit()
    }
    if (action === "submit") void submitPrompt()
  })

  async function submitPrompt() {
    const value = prompt().trim()
    if (value.length === 0) return

    const command = parseSlashCommand(value)
    if (command.kind === "quit") {
      renderer.destroy()
      props.onExit()
      return
    }
    if (command.kind === "details") {
      setState((current) => reduceTuiEvent(current, { type: "slash.details" }))
      setPrompt("")
      return
    }

    const activeSessionId = state().activeSessionId
    if (!activeSessionId) return

    setState((current) => ({
      ...current,
      conversation: [...current.conversation, { role: "user", content: value }]
    }))
    setPrompt("")
    await client.submitRun(activeSessionId, value)
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      <TopBar state={state()} />
      <box flexDirection="row" flexGrow={1}>
        <ConversationPanel state={state()} />
        <TimelinePanel state={state()} />
        {state().inspectorVisible ? <InspectorPanel state={state()} /> : null}
        <BrowserStatePanel state={state()} />
      </box>
      <PromptInput value={prompt()} onChange={setPrompt} onSubmit={submitPrompt} />
    </box>
  )
}
```

`PromptInput` must render a focused `<textarea>`:

```tsx
export interface PromptInputProps {
  value: string
  onChange(value: string): void
  onSubmit(): void
}

export function PromptInput(props: PromptInputProps) {
  return (
    <box border title="Prompt" height={5}>
      <textarea focused value={props.value} onContentChange={props.onChange} onSubmit={props.onSubmit} />
    </box>
  )
}
```

Manual TUI smoke:

```bash
bun run packages/cli/src/index.ts
```

Expected:

```text
The TUI opens in the terminal.
The top bar shows the current project path.
Typing the Example Domain prompt and pressing Enter starts a mock run.
The conversation panel shows 페이지 제목은 "Example Domain"입니다.
/quit exits and the CLI stops the in-process server.
```

- [ ] Run verification.

```bash
bun test packages/tui
bun run typecheck
```

Expected:

```text
TUI state tests pass.
OpenTUI app compiles.
```

- [ ] Commit.

```bash
git add packages/tui
git commit -m "[add] implement TUI shell state"
```

### Task 8: End-To-End Sprint 1 Smoke

**Files:**

```text
Create: packages/cli/src/e2e-smoke.test.ts
Modify: README.md
```

- [ ] Add a smoke test that runs the CLI headless command.

Required assertion:

```text
stdout contains 페이지 제목은 "Example Domain"입니다.
stdout contains [run.completed].
```

- [ ] Update README with Sprint 1 usage.

Required sections:

```text
What Open Web Agent is
Current Sprint 1 capability
Install
Run headless mock task
Run TUI
Run server only
Development commands
```

- [ ] Run final verification.

```bash
bun install
bun run typecheck
bun test
bun run packages/cli/src/index.ts run "example.com에 접속해서 페이지 제목을 알려줘"
bun run packages/cli/src/index.ts
```

Expected:

```text
All commands exit 0.
The final command prints 페이지 제목은 "Example Domain"입니다.
events.jsonl is created under OWA_HOME or ~/.open-web-agent.
The TUI command opens, accepts the Example Domain prompt, renders the final answer, and exits with /quit.
```

- [ ] Commit.

```bash
git add README.md packages/cli
git commit -m "[test] add sprint one smoke coverage"
```
