# Single Playwright Browser Process

## Goal

Open Web Agent should keep at most one real Playwright browser process open per runtime instance. Switching sessions must not launch a new headed browser. Instead, the runtime should reuse the existing browser process and attach the active session to its preserved browser state.

The intended behavior is:

- The Playwright environment launches one browser process lazily.
- Each session keeps its own `BrowserContext` and `Page` inside that shared browser.
- Session switching reuses the existing process and selects the session's existing page.
- Runs continue to operate on the session-bound page and preserve cookies, storage, history, URL, and DOM state as much as Playwright contexts support.
- Closing a session closes only that session's context/page.
- Stopping the runtime closes the shared browser process.

`MockEnvironment` has no real browser process, so it should continue to keep independent observations per session.

## Current State

`BrowserSessionManager` tracks a binding per session and delegates lifecycle calls to the selected `BrowserEnvironment`.

`PlaywrightEnvironment` currently stores:

```ts
private runs = new Map<string, PlaywrightRunState>()
```

The key is `ctx.session.id`, and each state contains its own `Browser`, `BrowserContext`, and `Page`. As a result, multiple sessions can launch multiple real browser processes.

Existing tests also encode this older model with wording like "browser page bound one-to-one with the session." That expectation should be updated to distinguish the real browser process from the session-specific context/page.

## Design

Change `PlaywrightEnvironment` from "one browser per session" to "one browser per environment instance."

The environment should keep:

```ts
private browser: Browser | null
private sessions = new Map<string, PlaywrightSessionState>()
private openingBrowser: Promise<Browser> | null
```

`PlaywrightSessionState` should contain only session-scoped data:

```ts
interface PlaywrightSessionState {
  context: BrowserContext
  page: Page
  lastScreenshotPath: string | null
  screenshotCount: number
}
```

`ensureState(ctx)` should:

1. Return the existing session state if present.
2. Ensure the shared browser exists, launching it only once.
3. Create a new `BrowserContext` and `Page` for the session.
4. Store the session state under `ctx.session.id`.

`attachSession(ctx)` should ensure the session state and bring that session's page to the front unless focus prevention is enabled.

`reset(ctx)` should continue to attach instead of clearing browser state. This preserves the current session browser across consecutive runs.

`close(ctx)` should close only the session's page/context and remove that session from the map. It must not close the shared browser unless this is the final session. Closing the final session may close the shared browser to avoid leaving an idle process around.

Add a new environment-level cleanup method for process shutdown if needed. The existing `BrowserEnvironment.close(ctx)` contract is session-oriented, so the least invasive option is for `BrowserSessionManager.closeAll()` to close every tracked session, which naturally closes the shared browser when the last session closes.

## Data Flow

Session creation:

```text
POST /sessions
  -> BrowserSessionManager.open(session)
  -> PlaywrightEnvironment.openSession(ctx)
  -> ensure shared browser
  -> create session context/page
  -> observe session page
```

Session switch:

```text
GET /sessions/:id
  -> BrowserSessionManager.attach(session)
  -> PlaywrightEnvironment.attachSession(ctx)
  -> reuse shared browser
  -> reuse session context/page
  -> optionally bring page to front
```

Run:

```text
POST /runs
  -> BrowserSessionManager.attach(session)
  -> RunOrchestrator.executeRun()
  -> PlaywrightEnvironment.reset(ctx)
  -> tools execute against pageForTools(ctx)
```

Shutdown:

```text
runtime.stop()
  -> BrowserSessionManager.closeAll()
  -> close each session context/page
  -> close shared browser when no session contexts remain
```

## Error Handling

If the shared browser has been closed externally, the next operation should discard stale state and launch a fresh shared browser. Session states that depend on the old browser should be removed or recreated rather than reused.

If multiple sessions are opened concurrently, browser launch should be guarded by a single shared `openingBrowser` promise so concurrent `ensureState()` calls do not launch duplicate browser processes.

If creating a session context/page fails, the partially created context should be closed and the shared browser should remain available for other sessions unless the browser itself is no longer connected.

## Tests

Update or add tests around these contracts:

- `PlaywrightEnvironment` launches the browser once for multiple session ids.
- Each session gets an isolated context/page under the shared browser.
- Reattaching the same session reuses its page.
- Closing one session does not close the shared browser while another session remains open.
- Closing the final session closes the shared browser.
- Focus prevention still skips `bringToFront()`.
- Server route tests should describe session page/context binding without implying one browser process per session.

Run verification:

```bash
bun run typecheck
bun test
```

## Non-Goals

- Do not remove browser environment selection (`mock-browser`, `playwright-browser`).
- Do not collapse all sessions onto a single tab/page.
- Do not add auth, remote browser control, or non-loopback server behavior.
- Do not persist Playwright contexts across runtime restarts in this change.
