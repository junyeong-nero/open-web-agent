# OpenCode-Style TUI Shell Design

Date: 2026-06-17

## Goal

Make the `open-web-agent` TUI visually match the OpenCode TUI shell while keeping the product identity as `open-web-agent` / `OWA`.

The target is visual and layout parity, not full behavioral cloning. The existing runtime, server, SSE client, reducer behavior, and slash command semantics stay intact.

References:

- OpenCode TUI docs: https://opencode.ai/docs/tui/
- OpenCode official terminal screenshot: https://github.com/anomalyco/opencode/raw/dev/packages/web/src/assets/lander/screenshot.png
- OpenCode default theme source: https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/theme/assets/opencode.json
- Reference clone commit inspected during design: `10b6672`

## User Decisions

- Use the "visual/layout complete clone" scope.
- Keep the product name as `open-web-agent`, not `OpenCode`.
- Implement the "OpenCode-style TUI shell" approach: single transcript, bottom prompt, status/hint row, no persistent right-side browser panel.

## Current State

The current TUI uses an OpenTUI/Solid app with these visible regions:

- `TopBar`: project path, selected agent/model/browser/theme, run status.
- `ConversationPanel`: linear run log.
- `BrowserStatePanel`: persistent right-side browser/subgoals/observation panel.
- `PromptInput`: bordered chat box with metadata and textarea.

Theme support already exists in `packages/tui/src/theme/themes.ts`, with `selectedThemeId` stored in TUI state and changed through `/theme`.

## Target UI

The target screen is a single OpenCode-like session shell:

1. Full-screen dark background.
2. Compact top session title row that reads like:
   `# <session or task title>` with right-aligned run metadata.
3. One transcript area containing user messages, assistant messages, tool events, browser observations, plan updates, and final answers.
4. No always-visible right browser/subgoals panel.
5. Bottom prompt with:
   - left accent border,
   - dark input surface,
   - one or more input lines,
   - metadata row with agent/model/product labels,
   - right-aligned command hints.

Example bottom metadata:

```text
Build mock-agent no-model open-web-agent       esc interrupt  /theme themes  /agent agents  /help commands
```

## Theme Tokens

Add an OpenCode-like default theme using the OpenCode dark palette:

```text
background       #0a0a0a
backgroundPanel  #141414
backgroundInput  #1e1e1e
border           #484848
borderSubtle     #3c3c3c
text             #eeeeee
textMuted        #808080
primary          #fab283
secondary        #5c9cf5
accent           #9d7cd8
success          #7fd88f
warning          #f5a742
danger           #e06c75
info             #56b6c2
```

Map these into the existing `TuiTheme` shape rather than importing OpenCode's theme system.

The new default `selectedThemeId` should be the OpenCode-style theme so the TUI opens in the requested design without requiring `/theme`.

## Component Design

### Session Shell

Update `App` to render the TUI as a vertical session shell:

- root background from the selected theme,
- session header,
- transcript body,
- prompt composer.

The current side-by-side layout should be removed from the main screen.

### Header

Replace the current wide metadata-heavy top bar with a compact session title row:

- left: `# <latest user prompt or project/session label>`,
- right: token/run metadata available from current state, falling back to agent/browser status.

The header should use panel background and muted/right-side metadata, matching the OpenCode screenshot.

### Transcript

Create or adapt the conversation panel into a transcript component:

- user prompts render as highlighted blocks with a left secondary border,
- assistant/final answer text renders as plain transcript lines,
- tool/browser/action events render as muted rows prefixed with `*` or `->`,
- completed/failure/cancelled status renders as compact `~ completed`, `~ failed`, or `~ cancelled`,
- plan/subgoal updates render inline in the transcript instead of in a separate panel.

The existing `runLog` remains the primary source because reducer behavior already normalizes run events. Browser state can be summarized from `state.browser` only when useful, without keeping a separate panel.

### Prompt

Restyle `PromptInput` to match OpenCode's prompt region:

- left-only accent border,
- `backgroundElement` style input surface,
- metadata row below textarea,
- command hints aligned right,
- no visible "chat box" title.

Keep existing submit/newline behavior and slash-command parsing.

### Browser And Plan Detail

The old persistent `BrowserStatePanel` should not be rendered in the default shell.

The detail data remains available through state and existing `/details` behavior. If a details view is needed in this implementation, render it as inline transcript/detail content rather than reintroducing a persistent right panel.

## Data Flow

No server or runtime data contracts change.

Existing flow stays:

```text
server SSE events -> createEventStream -> reduceTuiEvent -> TuiState -> visual components
```

The change is only in how `TuiState` is presented.

## Error Handling

- Plugin load failures continue to append a system message.
- Unknown slash commands continue to append a system message.
- Run failure/cancel/cancel-or-exit behavior remains unchanged.
- If a state field is missing, render muted fallback text rather than blank panel chrome.

## Testing

Use test-first implementation for production changes.

Required tests:

- Theme tests prove the OpenCode-style theme is listed first/default and falls back safely.
- Reducer tests remain green for selected theme and run log behavior.
- Add component-oriented tests only if the existing test stack has a practical renderer path; otherwise verify rendering through typecheck plus manual TUI smoke because current TUI component coverage is limited.

Verification commands:

```bash
bun test packages/tui
bun run typecheck
```

Manual smoke:

```bash
bun run packages/cli/src/index.ts
```

Confirm the TUI opens with the OpenCode-style single transcript shell, accepts a prompt, streams run events, renders the final answer, and exits through `/quit`.

## Out Of Scope

- Recreating OpenCode's command palette.
- Implementing `ctrl+p`, `ctrl+t`, or `tab` behavior parity.
- Adding OpenCode session list, model variant, permission, or sidebar systems.
- Renaming the product to OpenCode.
- Changing server APIs, runtime contracts, persistence, or plugin loading.
