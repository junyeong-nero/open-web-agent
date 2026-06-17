# OpenCode-Style TUI Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the `open-web-agent` TUI into an OpenCode-style single transcript shell while keeping the `open-web-agent` product identity.

**Architecture:** Keep the existing server, SSE client, reducer, and slash-command data flow. Add a tested presentation view-model for session title, transcript rows, and prompt metadata, then wire thin OpenTUI/Solid components around that view-model. Replace the current side-by-side TUI layout with a vertical shell: compact header, transcript body, OpenCode-style prompt.

**Tech Stack:** Bun, TypeScript, SolidJS JSX via `@opentui/solid`, OpenTUI renderables, `bun:test`.

---

## File Structure

- Modify `packages/tui/src/theme/themes.ts`: add the OpenCode-style theme as the first built-in theme and keep the existing theme API.
- Modify `packages/tui/src/theme/themes.test.ts`: lock the OpenCode theme as the default fallback and verify key palette values.
- Modify `packages/tui/src/state/reducer.ts`: make the initial selected theme `opencode`.
- Modify `packages/tui/src/state/reducer.test.ts`: verify the initial selected theme.
- Create `packages/tui/src/components/session-shell-format.ts`: pure presentation helpers for session title, metadata, transcript row classification, and prompt labels.
- Create `packages/tui/src/components/session-shell-format.test.ts`: behavior tests for the pure presentation helpers.
- Create `packages/tui/src/components/session-shell-components.test.ts`: import smoke tests for the new TSX components, because this repo does not currently have an OpenTUI component renderer test harness.
- Create `packages/tui/src/components/session-header.tsx`: compact OpenCode-style session title row.
- Create `packages/tui/src/components/transcript-panel.tsx`: single transcript view over `state.runLog`.
- Modify `packages/tui/src/components/prompt-input.tsx`: restyle the prompt as an OpenCode-style left-accent composer and add `runStatus` metadata.
- Modify `packages/tui/src/app.tsx`: render the new header/transcript/prompt shell and stop rendering the persistent right-side browser panel.

Existing files `top-bar.tsx`, `conversation-panel.tsx`, and `browser-state-panel.tsx` can remain in the tree unused during this task. Removing them is not required for the requested UI and would create extra churn.

## Task 1: Add OpenCode Default Theme

**Files:**
- Modify: `packages/tui/src/theme/themes.test.ts`
- Modify: `packages/tui/src/theme/themes.ts`
- Modify: `packages/tui/src/state/reducer.test.ts`
- Modify: `packages/tui/src/state/reducer.ts`

- [ ] **Step 1: Write the failing theme tests**

Replace `packages/tui/src/theme/themes.test.ts` with:

```ts
import { describe, expect, it } from "bun:test"
import { getTheme, listThemes } from "./themes"

describe("themes", () => {
  it("lists the opencode theme first and falls back safely", () => {
    expect(listThemes().map((theme) => theme.id)).toEqual([
      "opencode",
      "terminal-cyan",
      "aurora-violet",
      "amber-ops",
      "matrix-green",
    ])
    expect(getTheme("opencode")).toMatchObject({
      id: "opencode",
      name: "OpenCode",
      surface: "#0a0a0a",
      panel: "#141414",
      panelAlt: "#1e1e1e",
      border: "#484848",
      text: "#eeeeee",
      textMuted: "#808080",
      accent: "#fab283",
      task: "#5c9cf5",
    })
    expect(getTheme("missing").id).toBe("opencode")
  })
})
```

Add this test to `packages/tui/src/state/reducer.test.ts` inside the existing `describe("reduceTuiEvent", () => { ... })` block:

```ts
  it("uses the opencode theme by default", () => {
    expect(createInitialState("/tmp/project").selectedThemeId).toBe("opencode")
  })
```

- [ ] **Step 2: Run the tests and verify they fail for the expected reason**

Run:

```bash
bun test packages/tui/src/theme/themes.test.ts packages/tui/src/state/reducer.test.ts
```

Expected: FAIL. `themes.test.ts` should show the built-in theme list still starts with `terminal-cyan`, and `reducer.test.ts` should show the initial theme is still `terminal-cyan`.

- [ ] **Step 3: Implement the OpenCode theme**

In `packages/tui/src/theme/themes.ts`, insert this object as the first element of `BUILT_IN_THEMES`:

```ts
  {
    id: "opencode",
    name: "OpenCode",
    surface: "#0a0a0a",
    surfaceAlt: "#141414",
    panel: "#141414",
    panelAlt: "#1e1e1e",
    border: "#484848",
    borderStrong: "#606060",
    text: "#eeeeee",
    textMuted: "#808080",
    accent: "#fab283",
    task: "#5c9cf5",
    reasoning: "#9d7cd8",
    tool: "#56b6c2",
    answer: "#fab283",
    success: "#7fd88f",
    warning: "#f5a742",
    danger: "#e06c75",
  },
```

In `packages/tui/src/state/reducer.ts`, change the default theme in `createInitialState`:

```ts
    selectedThemeId: "opencode",
```

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```bash
bun test packages/tui/src/theme/themes.test.ts packages/tui/src/state/reducer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add packages/tui/src/theme/themes.ts packages/tui/src/theme/themes.test.ts packages/tui/src/state/reducer.ts packages/tui/src/state/reducer.test.ts
git commit -m "[add] default tui to opencode theme"
```

## Task 2: Add Session Shell View-Model Helpers

**Files:**
- Create: `packages/tui/src/components/session-shell-format.test.ts`
- Create: `packages/tui/src/components/session-shell-format.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `packages/tui/src/components/session-shell-format.test.ts`:

```ts
import { describe, expect, it } from "bun:test"
import type { TuiState } from "../state/types"
import { createInitialState } from "../state/reducer"
import {
  promptHint,
  promptMeta,
  sessionMeta,
  sessionTitle,
  toTranscriptViewItem,
} from "./session-shell-format"

function stateWithLog(): TuiState {
  return {
    ...createInitialState("/work/open-web-agent"),
    selectedAgentId: "mock-agent",
    selectedModelId: null,
    selectedEnvironmentId: "mock-browser",
    runStatus: "completed",
    runLog: [
      {
        id: "run-started",
        sequence: 0,
        kind: "user.task",
        message: "Open example.com",
        accent: "task",
      },
      {
        id: "tool-result",
        sequence: 1,
        kind: "tool.result",
        message: "navigate ok navigated",
        accent: "tool",
      },
      {
        id: "answer",
        sequence: 2,
        kind: "agent.answer",
        message: "Example Domain",
        accent: "answer",
      },
    ],
  }
}

describe("session shell formatting", () => {
  it("uses the latest user task as the session title", () => {
    expect(sessionTitle(stateWithLog())).toBe("Open example.com")
    expect(sessionTitle(createInitialState("/work/open-web-agent"))).toBe("open-web-agent workflow")
  })

  it("formats compact session metadata", () => {
    expect(sessionMeta(stateWithLog())).toBe("completed · mock-agent · mock-browser")
  })

  it("classifies transcript rows for OpenCode-style rendering", () => {
    expect(toTranscriptViewItem(stateWithLog().runLog[0]!)).toMatchObject({
      block: "user",
      prefix: "",
      text: "Open example.com",
    })
    expect(toTranscriptViewItem(stateWithLog().runLog[1]!)).toMatchObject({
      block: "tool",
      prefix: "*",
      text: "navigate ok navigated",
    })
    expect(toTranscriptViewItem({ id: "failed", sequence: 3, kind: "run.failed", message: "boom", accent: "danger" })).toMatchObject({
      block: "status",
      prefix: "~",
      text: "failed boom",
    })
  })

  it("formats prompt metadata and hints", () => {
    expect(promptMeta("mock-agent", null)).toBe("Build mock-agent no-model open-web-agent")
    expect(promptMeta("plan-act-agent", "openrouter")).toBe("Build plan-act-agent openrouter open-web-agent")
    expect(promptHint("running")).toBe("esc interrupt  /theme themes  /agent agents  /help commands")
    expect(promptHint("idle")).toBe("esc exit  /theme themes  /agent agents  /help commands")
  })
})
```

- [ ] **Step 2: Run the test and verify it fails for the expected reason**

Run:

```bash
bun test packages/tui/src/components/session-shell-format.test.ts
```

Expected: FAIL with a module-not-found error for `./session-shell-format`.

- [ ] **Step 3: Implement the helper module**

Create `packages/tui/src/components/session-shell-format.ts`:

```ts
import type { RunLogItem } from "../log/run-log"
import type { TuiState } from "../state/types"
import type { ThemeAccent } from "../theme/themes"

export type TranscriptBlock = "user" | "assistant" | "tool" | "status" | "system"

export interface TranscriptViewItem {
  id: string
  sequence: number
  block: TranscriptBlock
  prefix: string
  text: string
  accent: ThemeAccent
}

export function sessionTitle(state: TuiState): string {
  const latestTask = [...state.runLog]
    .reverse()
    .find((item) => item.kind === "user.task" && item.message.trim().length > 0)

  if (latestTask) return latestTask.message.trim()

  const projectName = state.projectPath.split(/[\\/]/).filter(Boolean).at(-1)
  return projectName ? `${projectName} workflow` : "open-web-agent workflow"
}

export function sessionMeta(state: TuiState): string {
  return `${state.runStatus} · ${state.selectedAgentId} · ${state.selectedEnvironmentId}`
}

export function toTranscriptViewItem(item: RunLogItem): TranscriptViewItem {
  if (item.kind === "user.task") return viewItem(item, "user", "", item.message)
  if (item.kind === "agent.answer") return viewItem(item, "assistant", "", item.message)
  if (item.kind === "system") return viewItem(item, "system", "~", item.message)
  if (item.kind === "run.failed") return viewItem(item, "status", "~", `failed ${item.message}`.trim())
  if (item.kind === "run.cancelled") return viewItem(item, "status", "~", `cancelled ${item.message}`.trim())
  if (item.kind.startsWith("tool.")) return viewItem(item, "tool", "*", item.message)
  if (item.kind === "reasoning") return viewItem(item, "tool", "*", item.message)

  return viewItem(item, "assistant", "", item.message)
}

export function promptMeta(agentId: string, modelId: string | null): string {
  return `Build ${agentId} ${modelId ?? "no-model"} open-web-agent`
}

export function promptHint(runStatus: TuiState["runStatus"]): string {
  const escapeAction = runStatus === "running" ? "interrupt" : "exit"
  return `esc ${escapeAction}  /theme themes  /agent agents  /help commands`
}

function viewItem(item: RunLogItem, block: TranscriptBlock, prefix: string, text: string): TranscriptViewItem {
  return {
    id: item.id,
    sequence: item.sequence,
    block,
    prefix,
    text,
    accent: item.accent,
  }
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
bun test packages/tui/src/components/session-shell-format.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add packages/tui/src/components/session-shell-format.ts packages/tui/src/components/session-shell-format.test.ts
git commit -m "[add] format opencode tui transcript"
```

## Task 3: Add Header And Transcript Components

**Files:**
- Create: `packages/tui/src/components/session-shell-components.test.ts`
- Create: `packages/tui/src/components/session-header.tsx`
- Create: `packages/tui/src/components/transcript-panel.tsx`

- [ ] **Step 1: Write the failing component import smoke test**

Create `packages/tui/src/components/session-shell-components.test.ts`:

```ts
import { describe, expect, it } from "bun:test"
import { SessionHeader } from "./session-header"
import { TranscriptPanel } from "./transcript-panel"

describe("session shell components", () => {
  it("exports the OpenCode-style shell components", () => {
    expect(typeof SessionHeader).toBe("function")
    expect(typeof TranscriptPanel).toBe("function")
  })
})
```

- [ ] **Step 2: Run the test and verify it fails for the expected reason**

Run:

```bash
bun test packages/tui/src/components/session-shell-components.test.ts
```

Expected: FAIL with module-not-found errors for `./session-header` and `./transcript-panel`.

- [ ] **Step 3: Implement `SessionHeader`**

Create `packages/tui/src/components/session-header.tsx`:

```tsx
import type { TuiState } from "../state/types"
import type { TuiTheme } from "../theme/themes"
import { sessionMeta, sessionTitle } from "./session-shell-format"

export interface SessionHeaderProps {
  state: TuiState
  theme: TuiTheme
}

export function SessionHeader(props: SessionHeaderProps) {
  return (
    <box
      height={3}
      paddingX={2}
      paddingY={1}
      backgroundColor={props.theme.panel}
      flexDirection="row"
      justifyContent="space-between"
      flexShrink={0}
    >
      <text fg={props.theme.text} wrapMode="none">
        {`# ${sessionTitle(props.state)}`}
      </text>
      <text fg={props.theme.textMuted} wrapMode="none">
        {sessionMeta(props.state)}
      </text>
    </box>
  )
}
```

- [ ] **Step 4: Implement `TranscriptPanel`**

Create `packages/tui/src/components/transcript-panel.tsx`:

```tsx
import { For } from "solid-js"
import type { TuiState } from "../state/types"
import { themeColor, type TuiTheme } from "../theme/themes"
import { toTranscriptViewItem, type TranscriptViewItem } from "./session-shell-format"

export interface TranscriptPanelProps {
  state: TuiState
  theme: TuiTheme
}

export function TranscriptPanel(props: TranscriptPanelProps) {
  const items = () => props.state.runLog.map(toTranscriptViewItem)

  return (
    <box flexGrow={1} paddingX={2} paddingY={1} backgroundColor={props.theme.surface} rowGap={1}>
      {items().length === 0 ? (
        <text fg={props.theme.textMuted}>Waiting for a task. Type in the prompt below.</text>
      ) : (
        <For each={items()}>{(item) => renderTranscriptItem(item, props.theme)}</For>
      )}
    </box>
  )
}

function renderTranscriptItem(item: TranscriptViewItem, theme: TuiTheme) {
  if (item.block === "user") {
    return (
      <box border={["left"]} borderColor={theme.task} backgroundColor={theme.panel} paddingX={1} paddingY={1}>
        <text fg={theme.text} wrapMode="word">
          {item.text}
        </text>
      </box>
    )
  }

  if (item.block === "tool" || item.block === "system" || item.block === "status") {
    return (
      <text fg={item.block === "status" ? themeColor(theme, item.accent) : theme.textMuted} wrapMode="word">
        {`${item.prefix} ${item.text}`.trim()}
      </text>
    )
  }

  return (
    <text fg={themeColor(theme, item.accent)} wrapMode="word">
      {item.text}
    </text>
  )
}
```

- [ ] **Step 5: Run the component import test and helper test**

Run:

```bash
bun test packages/tui/src/components/session-shell-components.test.ts packages/tui/src/components/session-shell-format.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add packages/tui/src/components/session-shell-components.test.ts packages/tui/src/components/session-header.tsx packages/tui/src/components/transcript-panel.tsx
git commit -m "[add] render opencode tui session shell"
```

## Task 4: Restyle Prompt Input

**Files:**
- Modify: `packages/tui/src/components/prompt-input.tsx`

- [ ] **Step 1: Run the existing prompt metadata helper tests before editing**

Run:

```bash
bun test packages/tui/src/components/session-shell-format.test.ts
```

Expected: PASS, including `promptMeta` and `promptHint`. These helper tests are the behavior guard for the prompt's visible metadata.

- [ ] **Step 2: Replace the prompt component implementation**

Replace `packages/tui/src/components/prompt-input.tsx` with:

```tsx
import type { TextareaRenderable } from "@opentui/core"
import type { KeyEvent } from "@opentui/core"
import type { TuiState } from "../state/types"
import type { TuiTheme } from "../theme/themes"
import { promptHint, promptMeta } from "./session-shell-format"

export interface PromptInputProps {
  value: string
  agentId: string
  modelId: string | null
  environmentId: string
  runStatus: TuiState["runStatus"]
  theme: TuiTheme
  onChange(value: string): void
  onSubmit(): void
}

export function PromptInput(props: PromptInputProps) {
  let textarea: (TextareaRenderable & { plainText?: string }) | undefined
  const keyBindings = [
    { name: "return", action: "submit" as const },
    { name: "enter", action: "submit" as const },
    { name: "linefeed", action: "submit" as const },
    { name: "return", shift: true, action: "newline" as const },
    { name: "enter", shift: true, action: "newline" as const },
    { name: "linefeed", shift: true, action: "newline" as const },
  ]

  const currentValue = () => textarea?.plainText ?? props.value
  const handleContentChange = (_event: unknown) => {
    props.onChange(currentValue())
  }
  const handleSubmit = () => {
    props.onChange(currentValue())
    textarea?.clear()
    props.onSubmit()
  }
  const handleKeyDown = (event: KeyEvent) => {
    if ((event.name === "return" || event.name === "enter" || event.name === "linefeed") && !event.shift) {
      event.preventDefault()
      handleSubmit()
    }
  }

  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={props.theme.surface}>
      <box border={["left"]} borderColor={props.theme.task} backgroundColor={props.theme.panelAlt} paddingX={2} paddingY={1}>
        <textarea
          ref={(node) => {
            textarea = node as TextareaRenderable & { plainText?: string }
          }}
          focused
          minHeight={1}
          maxHeight={6}
          initialValue={props.value}
          keyBindings={keyBindings}
          backgroundColor={props.theme.panelAlt}
          textColor={props.theme.text}
          focusedBackgroundColor={props.theme.panelAlt}
          focusedTextColor={props.theme.text}
          cursorColor={props.theme.text}
          placeholder={'Ask anything... "example.com page title"'}
          placeholderColor={props.theme.textMuted}
          onContentChange={handleContentChange}
          onKeyDown={handleKeyDown}
          onSubmit={handleSubmit}
        />
      </box>
      <box flexDirection="row" justifyContent="space-between" paddingX={2} paddingBottom={1} gap={2}>
        <text fg={props.theme.text} wrapMode="none">
          {promptMeta(props.agentId, props.modelId)}
        </text>
        <text fg={props.theme.textMuted} wrapMode="none">
          {promptHint(props.runStatus)}
        </text>
      </box>
    </box>
  )
}
```

The `environmentId` prop stays in the interface because `App` already passes browser selection data and external callers may depend on the prop shape. The OpenCode-style prompt metadata intentionally does not render the browser id in the first row.

- [ ] **Step 3: Run typecheck and focused tests**

Run:

```bash
bun test packages/tui/src/components/session-shell-format.test.ts packages/tui/src/components/session-shell-components.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit Task 4**

Run:

```bash
git add packages/tui/src/components/prompt-input.tsx
git commit -m "[refactor] restyle tui prompt composer"
```

## Task 5: Integrate The New Shell In App

**Files:**
- Modify: `packages/tui/src/app.tsx`

- [ ] **Step 1: Run the current focused tests before integration**

Run:

```bash
bun test packages/tui/src/components/session-shell-format.test.ts packages/tui/src/components/session-shell-components.test.ts packages/tui/src/theme/themes.test.ts packages/tui/src/state/reducer.test.ts
```

Expected: PASS.

- [ ] **Step 2: Update App imports**

In `packages/tui/src/app.tsx`, replace these imports:

```ts
import { BrowserStatePanel } from "./components/browser-state-panel"
import { ConversationPanel } from "./components/conversation-panel"
import { TopBar } from "./components/top-bar"
```

with:

```ts
import { SessionHeader } from "./components/session-header"
import { TranscriptPanel } from "./components/transcript-panel"
```

- [ ] **Step 3: Replace the returned layout**

In `packages/tui/src/app.tsx`, replace the current returned JSX:

```tsx
  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={currentTheme().surface}>
      <TopBar state={state()} theme={currentTheme()} />
      <box flexDirection="row" flexGrow={1}>
        <ConversationPanel state={state()} theme={currentTheme()} />
        <BrowserStatePanel state={state()} theme={currentTheme()} />
      </box>
      <PromptInput
        value={prompt()}
        agentId={state().selectedAgentId}
        modelId={state().selectedModelId}
        environmentId={state().selectedEnvironmentId}
        theme={currentTheme()}
        onChange={setPrompt}
        onSubmit={submitPrompt}
      />
    </box>
  )
```

with:

```tsx
  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={currentTheme().surface}>
      <SessionHeader state={state()} theme={currentTheme()} />
      <TranscriptPanel state={state()} theme={currentTheme()} />
      <PromptInput
        value={prompt()}
        agentId={state().selectedAgentId}
        modelId={state().selectedModelId}
        environmentId={state().selectedEnvironmentId}
        runStatus={state().runStatus}
        theme={currentTheme()}
        onChange={setPrompt}
        onSubmit={submitPrompt}
      />
    </box>
  )
```

- [ ] **Step 4: Run typecheck and TUI tests**

Run:

```bash
bun test packages/tui
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

Run:

```bash
git add packages/tui/src/app.tsx
git commit -m "[refactor] switch tui to opencode shell layout"
```

## Task 6: Verify The Full TUI Behavior

**Files:**
- No planned file changes.

- [ ] **Step 1: Run all TUI tests**

Run:

```bash
bun test packages/tui
```

Expected: PASS.

- [ ] **Step 2: Run repository typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run the headless mock task**

Run:

```bash
bun run packages/cli/src/index.ts run "example.com에 접속해서 페이지 제목을 알려줘"
```

Expected output includes:

```text
페이지 제목은 "Example Domain"입니다.
```

- [ ] **Step 4: Run a manual TUI smoke**

Run:

```bash
bun run packages/cli/src/index.ts
```

Expected:

- The TUI opens with the `opencode` dark theme by default.
- The visible layout is a compact header, single transcript body, and bottom prompt.
- There is no persistent right-side browser/subgoals panel.
- Typing `example.com에 접속해서 페이지 제목을 알려줘` submits a run.
- The transcript shows user task, tool/status rows, and the final answer.
- `/quit` exits the TUI.

- [ ] **Step 5: Review final diff**

Run:

```bash
git diff --stat HEAD
git diff -- packages/tui/src/theme/themes.ts packages/tui/src/state/reducer.ts packages/tui/src/components packages/tui/src/app.tsx
```

Expected: only the planned TUI theme, presentation helper, component, and app integration files are changed.

- [ ] **Step 6: Commit verification notes only if files changed**

If no files changed during verification, do not create an empty commit. If a small verification fix was required, commit only the touched files with:

```bash
git add <touched-files>
git commit -m "[fix] verify opencode tui shell"
```
