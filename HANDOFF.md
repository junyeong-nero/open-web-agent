# Hand-off: issue #157 (wait for the page to settle before an action's snapshot)

Delete this file before the PR is merged.

Read the issue first: `gh api repos/junyeong-nero/open-web-agent/issues/157 --jq .body` (Korean; it is the spec,
including the 개선 및 완료 기준 checklist). Follow CLAUDE.md (commit tags, scope, tests).

## Branch state

- Branch: `fix/157-settle-before-snapshot`. Commit and push only here; do not merge it yourself.
- `23b0996` `[fix] wip: settle the page before an action's snapshot`: the complete first draft (code, fixtures,
  tests, README paragraph).
- `d02ba76`: merge of `origin/main` at `135950e` (#152 covering-label clicks, #167, #168 usage fields, #169).
  No conflicts; `bun run typecheck` passed afterwards. main was expected to gain #170 (bench runner) soon, so
  merge `origin/main` again before opening the PR.
- Nothing uncommitted besides this file.

## What the draft does

### `src/browser.ts`

- `BrowserOptions.settleTimeoutMs?: number`: the cap on the extra wait (default 3000; 0, a negative number or
  NaN turns settling off). No CLI flag (the task called it optional; cli.ts was left untouched).

### `src/tools.ts`

- `SETTLE_REQUESTS = {document, stylesheet, script, xhr, fetch}`, `SETTLE_QUIET_MS = 600`, `SETTLE_POLL_MS = 150`.
- `watchSettling(session, page): Settling | undefined` returns `{ observe(), settle(), stop() }`:
  - Attaches page listeners right before the action: `request` (adds main-frame requests of the types above to a
    `pending` set; `request.frame()` throws for service-worker requests, hence the try/catch), `requestfinished`
    and `requestfailed` (remove and record activity), main-frame `framenavigated`, `domcontentloaded` and `load`
    (record activity). `activity` is a single "last thing happened" timestamp.
  - Returns `undefined` when the cap is not positive or `page.on` throws. The stub pages in
    `action-recovery.test.ts` and `tool-errors.test.ts` only have `waitForEvent`, so they take exactly the old
    path; that matters because those tests count `session.snapshot()` calls.
  - `run()` loop, once per iteration:
    - Past the deadline: return `"\nThe page may still be changing."`.
    - `current = await session.page()` (follows a tab the action opened; throws `Browser operation cancelled`
      when the session is cancelled, which ends the wait).
    - In deciding mode (after `settle()` set the deadline): `current.waitForLoadState("domcontentloaded")`,
      bounded by the deadline, so a document that a late navigation committed is waited for.
    - If not busy (`current !== page` or `pending` is empty): `current.ariaSnapshot({ mode: "ai", timeout })` with
      an explicit timeout (1 s while observing, the remaining time while deciding), and compare
      `url + "\n" + tree` with the previous poll; a change records activity. The first poll is only a baseline.
    - Settled when deciding, not busy, `now - activity >= quiet`, and the tree is non-empty or the URL is
      `about:blank`.
    - A `TimeoutError` (page busy) records activity and continues; any other error (closed page, cancelled
      session, detached frame, an evaluate error) returns `""`, so the final snapshot runs as before.
    - Sleeps until `activity + quiet` (at most `SETTLE_POLL_MS`), but at least as long as the last snapshot took
      (at most half the renderer's time on heavy pages), clamped with `Math.max(0, ...)` and to the deadline.
      `wake` lets `settle()` and `stop()` interrupt the sleep.
  - `quiet = Math.min(SETTLE_QUIET_MS, cap / 2)` so a small cap can still settle.
  - `observe()`: records activity (the action's end) and starts the loop in observing mode.
  - `settle()`: returns `""` if stopped; sets `deadline = now + cap`, wakes the loop, starts it if `observe()`
    never ran, awaits it, then `stop()` (removes listeners). It never rejects. Because it awaits the loop, no poll
    is in flight when the final `session.snapshot()` runs.
- `act()`: `watchSettling` before the action; on an action error, `stop()` and rethrow; `observe()` right after
  the action; then the unchanged 750 ms `framenavigated` window and 10 s DOMContentLoaded wait; then
  `snapshotAfterAction(session, summary, settling)`. Polling during the 750 ms window is why static clicks add
  almost nothing.
- `navigate()`: `watchSettling` after the existing response and download listeners and before `goto`/`goBack`, so the
  new document's requests are tracked; `stop()` in the action's catch; in the DOMContentLoaded-wait catch,
  `stop()` before the existing handling, so a page that is still loading after the action timeout gets "The page
  may still be loading." and no settling (the `/slow-body` test requires under 3 s with `actionTimeoutMs: 500`);
  then `snapshotAfterAction(session, summary, settling)`.
- `snapshotAfterAction(session, summary, settling?)`: `if (settling) summary += await settling.settle()`, then the
  unchanged snapshot and failure handling. `browser_select_tab` and `browser_wait_for` do not settle.

### `src/testing/fixture.ts`

- Pages: `/late-list` (empty body at DOMContentLoaded, list inserted after 800 ms: 재현 1), `/late-fetch` (button
  fetches `/late-data`, which answers after 800 ms: 재현 2), `/late-redirect` (500 ms after `load`,
  `history.replaceState` to `?rdr=1` and re-render the search box: 재현 3, modelled on Bing), `/interstitial`
  (text "Checking your browser", `location.replace("/pricing")` after 300 ms), `/never-settles` (text changes
  every 100 ms forever), `/live-connections` (opens an `EventSource` to `/stream`; its Save button sends a
  `navigator.sendBeacon` to `/slow-ack`).
- Server: a `later(ms, response)` helper that uses the existing `timers` set so `stop()` clears it; routes
  `/late-data` (800 ms), `/slow-ack` (2.5 s, 204), `/slow-page` (HTML after 1.2 s), `/stream` (an SSE stream that
  never ends). Finite delays were chosen on purpose: hanging endpoints plus keepalive beacons could exhaust
  Chromium's six connections per host.

### `src/settle.test.ts` (10 tests, one shared session warmed in `beforeAll`)

1. waits for a list rendered after DOMContentLoaded (also shows the list is missing with `settleTimeoutMs = 0`)
2. waits for results that a click fetches
3. returns refs that survive a late URL change and re-render (with settling off: wait for `?rdr=1`, then the old
   ref fails with "is no longer on the page"; with settling on: snapshot URL is `?rdr=1` and `browser_type` works)
4. and 5. returns the final page of a client-side redirect after `browser_navigate` and after `browser_click`
   (`linkTo()` injects a link with `page.evaluate`)
6. waits for a navigation that commits after the click's navigation window (`/slow-page`, 1.2 s)
7. returns within the cap, with a note, from a page that never settles (navigate >= 3000 and < 4500 ms; click
   < 5000 ms and its text starts with `Clicked eN\nThe page may still be changing.\n`)
8. stops waiting as soon as the task is cancelled (own `BrowserSession`, warmed with goto plus snapshot, abort
   300 ms after `load` of `/never-settles`, run must end in under 2000 ms, `browser.started` false). Never run yet.
9. adds little delay on static pages (navigate `/pricing` and click Search on `/`, each < 1500 ms, no note)
10. does not wait for event streams, beacons, or requests started before the action (navigate and click each
    < 1500 ms; the test opens a `fetch("/slow-ack")` long poll with `page.evaluate` before clicking)

Before the merge and before test 8 existed, `bun test src/settle.test.ts` passed 9/9 in about 23 s.

### `README.md`

One paragraph before "Navigation results report HTTP error statuses": what settling waits for and ignores, the
3 s cap, the option, and the note. It says "0.6 seconds", which the redesign below must change.

## Design decisions and why

- No page-world evaluate. Some sites replace `window.eval` (americanexpress.com); Playwright's `page.evaluate`
  runs `globalThis.eval` in the main world and fails there. `ariaSnapshot` runs in Playwright's utility world
  (`frame.utilityContext()`), and request events need no evaluate, so both keep working. An injected
  MutationObserver was rejected for that reason. main now has a `/toggles-no-eval` fixture that breaks eval the
  same way; a test that settles a late-rendering page with eval broken (for example `page.addInitScript` that
  replaces `window.eval` in a dedicated session, then `/late-list`) would guard this. Not written yet.
- Refs: Playwright's `aria-ref=` engine resolves against the most recent `ariaSnapshot` of the frame
  (`_lastAriaSnapshotForQuery`), whatever its mode, and default-mode snapshots carry no refs. So polls must use
  `mode: "ai"` (refs are cached per element, so they stay stable), and the final `session.snapshot()` must be the
  last snapshot taken. That is why `settle()` awaits the loop instead of racing it against a timer.
  `session.lastSnapshot` (used by the #133 re-identification) is only set by the final snapshot.
- Requests: only the main frame (ad iframes are noisy), only types that change the tree, and only requests that
  started after the action began (listeners are attached right before it). So an already open long poll,
  WebSockets (Playwright emits no `request` event for them), EventSource (`eventsource`), beacons (`ping`),
  images and fonts never hold the wait. Trade-off: a long poll that a newly loaded page opens is counted and
  makes that navigation wait the full cap; later actions on the page do not.
- A finished tracked request records activity, so the render that follows its response is waited for.
- Empty tree means not rendered yet. This alone covers the issue's evidence #1 (empty snapshots after
  navigating to Amazon, Booking, Google Maps, CalCareers, recreation.gov, weather.com). Only an exactly empty
  tree counts; a small threshold such as "under 5 lines" would make tiny real pages such as example.com wait the
  whole cap. `about:blank` is exempt (otherwise navigating to or going back to it waited 3 s and claimed the page
  was still changing). That is safe for new tabs because Playwright exposes a popup only after its first
  navigation commits.
- The tree comparison includes iframe content and the URL (the URL catches `replaceState`). Ad iframes that keep
  rotating can therefore hold ad-heavy pages (Allrecipes) until the cap; watch wall-clock time there.
- `act()` keeps its 750 ms navigation window and 10 s DOMContentLoaded wait unchanged (the task asked to keep the
  navigation detection working); polling runs during that window.
- The cap counts from where the old waits end (after the window and DOMContentLoaded for `act()`, after
  DOMContentLoaded for `navigate()`), so the extra wait is bounded by `settleTimeoutMs`.
- Never turn a completed action into a failure (#97, #111): `settle()` never throws; when the cap is hit the
  snapshot is returned with `\nThe page may still be changing.` (worded like the existing "The page may still
  be loading."). If watching fails, the old behavior applies.
- Cancellation: `BrowserSession.cancelPending` awaits the pending tool call, so the loop must exit quickly:
  `session.page()` throws once the session is interrupted, sleeps are at most 150 ms, and `stop()` wakes the loop.
- The final snapshot repeats the last poll. Passing the last tree into `session.snapshot()` would save one
  `ariaSnapshot` per action (5–45 ms on the fixtures, more on big pages) but changes `BrowserSession`'s API.
  Not done.

## Measurements (draft with the 600 ms quiet window)

Median of 5 runs, this container, headless Chromium 1194, through `callTool`, settling off
(`settleTimeoutMs = 0`) versus on:

| case | off | on | snapshot correct (off / on) |
|---|---|---|---|
| navigate `/pricing` (static) | 27 ms | 623 ms | yes / yes |
| navigate `/products` (30 items) | 32 | 637 | yes / yes |
| navigate `/trade-in` (300 rows) | 101 | 698 | yes / yes |
| navigate `/article` (long) | 129 | 767 | yes / yes |
| navigate `/late-list` | 32 | 1537 | no / yes |
| navigate `/late-redirect` | 31 | 1225 | no / yes |
| navigate `/interstitial` | 36 | 960 | no / yes |
| navigate `/never-settles` | 32 | 3023, note 5/5 | yes / yes |
| click Search on `/` | 758 | 761 | yes / yes |
| click Search on `/late-fetch` | 758 | 1429 | no / yes |
| click Start lookup on `/async` (1.5 s timer) | 757 | 761 | no / no (the eval case uses `browser_wait_for`) |
| type into Search on `/` | 758 | 760 | yes / yes |

- Raw `ariaSnapshot` cost: `/pricing` 1.7 ms, `/products` 5.4 ms, `/trade-in` 27.5 ms, `/article` 42.4 ms.
- Static clicks were 792 ms before `wake()` let `settle()` interrupt the observing loop's sleep; now about 761 ms.
- Other cases with settling on: a click that opens a new tab 823 ms (snapshot shows the new tab's loaded page);
  a click on a download link 762 ms; navigate `about:blank` 620 ms (3014 ms plus the note before the exemption);
  `browser_go_back` 626 ms; `/slow-body` with the default 10 s action timeout 5620 ms (DOMContentLoaded at 5 s plus
  quiet); `/forbidden` 624 ms; `browser_scroll` 911 ms (its built-in 300 ms wait sits inside the action, and quiet
  counts from the action's end); `browser_press_key` 758 ms; `browser_hover` 760 ms.
- The measurement scripts lived in the session scratchpad and are gone. To reproduce: one warmed
  `BrowserSession`, `callTool(selectTools(), session, name, args)` timed with `performance.now()`, toggling
  `session.options.settleTimeoutMs` between `0` and `undefined`.

Behavior probed in this environment (Playwright 1.61 with Chromium 1194):

- `ariaSnapshot({ mode: "ai" })` returns `""` for an empty body, an empty `<div id="root">`, a spinner div, and a
  `<noscript>`-only body.
- `history.replaceState` emits a main-frame `framenavigated`.
- Resource types: `fetch`, `xhr`, `ping` (sendBeacon), `image`, `eventsource`; a WebSocket only emits
  `page.on("websocket")`.
- `ariaSnapshot` retries at 1 s, 2 s, ... intervals while `document.body` is null, so polls need explicit timeouts.

## What is left

1. Redesign requested in review: static fixture navigations must take well under 300 ms (they take about 623 ms
   now). Requested rule: return as soon as no tracked request is pending and two successive checks a short
   interval apart (100–200 ms) show the same URL and tree; extend only while requests started by the action
   are in flight or the tree is still changing. Simplest change: replace `SETTLE_QUIET_MS` and `SETTLE_POLL_MS` with one
   constant of about 150 ms and keep everything else. Expected: static navigate about 180 ms on the fixtures;
   static click unchanged at about 760 ms (the 750 ms window dominates). The reviewer asked to keep the
   `about:blank` exemption and the `Math.max(0, ...)` clamp.
2. Consequences of the shorter interval for the fixtures:
   - `/late-list` still works (empty-tree rule), `/late-fetch` and `/slow-page` too (tracked requests), and
     `/never-settles` still hits the cap (it changes every 100 ms, so two checks 150 ms apart always differ).
   - `/interstitial` would settle at about 150 ms, before its 300 ms redirect, because it shows text. Make it an
     empty page (no title, no text), like the empty Amazon and Booking interstitials in the issue's evidence
     ("트리와 제목이 비어 있고"); the empty-tree rule then waits through the redirect.
   - `/late-redirect` (재현 3) will no longer be caught, and test 3 will fail. See the open question below.
   - Tighten the static-page thresholds in tests 9 and 10 (for example navigate < 500 ms) and keep a margin for
     macOS.
3. Update the README paragraph ("0.6 seconds").
4. Verification: `bun run typecheck`; `bun test src/settle.test.ts` plus every touched test file
   (`tools.test.ts`, `navigation.test.ts`, `action-recovery.test.ts`, `stale-ref.test.ts`, `tool-errors.test.ts`,
   `agent.test.ts`, `label-covered.test.ts`, `testing/evaluation.test.ts`); then `bun run test` once; rerun any
   failing files; if they still fail, run the same files on main (`git worktree add /tmp/main origin/main`) and
   report counts honestly. Never call real model APIs or open real sites; the reviewer runs the live checks.
5. The reviewer asked that these failures from the draft's full run pass, each with an explanation of what the
   settle wait changed: `agent.test.ts` "retains landing URLs and titles after action and explicit snapshots are
   omitted", `navigation.test.ts` "returns usable refs and a loading notice after a slow document commits,
   including same-URL reloads", and `stale-ref.test.ts` "clicks the identical element that replaced a stale ref
   within a second" and "reads a replacement…". My reading so far (see the next section): for the stale-ref tests
   the only deterministic change is that `beforeEach`'s navigate takes longer, because polling starts only after
   the action and `settle()` awaits it before the final snapshot, so the ref resolution and re-identification
   paths are untouched; for the landing-URL test the wait only changes navigate timing (its assertions use
   `toContain`, and a note appears only if the page changes or the cap is hit); for slow-body, settling is
   skipped when the DOMContentLoaded wait times out. This still has to be confirmed by rerunning the files.
6. Open the PR (task requirements): from `fix/157-settle-before-snapshot` into main, title
   `[fix] wait for the page to settle before an action's snapshot`, body with `Closes #157.`, a short description
   with the design choices, a Validation list with exact commands and pass/fail counts (including the main
   comparison if anything fails), the static-page latency measured on the fixtures, any acceptance criteria not
   met and why (the reviewer's live checks are not ours to meet), and an "Implemented by …" line naming who
   implemented it (the original task asked for `Implemented by Claude Code cloud session (claude-opus-5-5, effort
   max).`; adjust it to reflect the hand-off). The squash commit's first line must be
   `[fix] wait for the page to settle before an action's snapshot`. Do not merge. Delete this file first.
7. Optional: the eval-disabled test described above, and reusing the last poll as the final snapshot.

## Open questions

- 재현 3 (`/late-redirect`) versus the latency target. A timer that fires 500 ms after `load` on an otherwise idle
  page looks exactly like a static page until it fires. Without page-world hooks, pending timers cannot be
  seen (CDP tracing of TimerInstall events would show them, but it is Chromium-only and heavy), so catching it
  needs more than 500 ms of waiting after every navigation, which the review ruled out. Options:
  - (a) Keep the fixture as the issue specifies and mark the test `it.failing` (Bun 1.3.14 supports
    `test.failing`), documenting the limit.
  - (b) Model Bing more closely, with a request still in flight after load, so the re-render happens while the
    wait is running. This must be disclosed in the PR, because it changes the fixture the issue specified.
  - (c) Follow-up issue: let #133's re-identification in `withRef` accept a same-document URL change
    (`replaceState` or `pushState` on the same path). That fixes Bing's stale search-box refs (`e16`, 12 of 23
    stale-ref failures in r3) with no wait at all. `withRef` was outside #157's stated scope.

  The real Bing timing is unknown. The issue says refs changed within 1–3 s of the snapshot, so even 600 ms may
  not have caught it. Flag this in the PR, because the live stale-ref metric may not improve.
- Should a long poll that a new page opens during navigation count (the full cap on that navigation)? It is rare
  now that WebSockets and SSE are common; it is documented as a trade-off.
- Ad-heavy pages can hit the cap (rotating iframe content, main-frame ad and analytics XHRs). Excluding iframe
  subtrees from the comparison is possible but would miss real iframe content (consent dialogs, payment forms).
  Decide after the live wall-clock numbers.
- Whether to add a `--settle-timeout-ms` CLI flag so MCP and CLI users can turn the wait off. Not added, to keep the
  surface small.

## Known test failures and their causes

- main baseline (`621ae1d`), full `bun run test` in this container: 166 pass, 16 fail, 395 s.
  - `stale-ref.test.ts`: the first test hung for 30 s, and the shared session cascaded into the rest of the file
    plus an `afterAll` timeout.
  - `model/options.test.ts` "lets CLI options replace even invalid env JSON, and {} clears env options": a
    `Bun.spawn` of the CLI hung for 30 s; no browser is involved.
- Draft (600 ms, before the merge), full run: 172 pass, 21 fail, 2 errors, 554 s.
  - `agent.test.ts` "retains landing URLs and titles…" (43.9 s): navigate to `/pricing` returned both "The page
    may still be changing." and "follow-up snapshot failed: ariaSnapshot: Timeout 10000ms exceeded", so the
    renderer stopped answering for more than 13 s; the `afterEach` `session.close()` then timed out.
  - `navigation.test.ts` slow-body test (60 s): "Unhandled error between tests: Failed to connect" (syscall
    connect, ENOENT) from Playwright's `launchProcess` and `child_process.spawn`, so Chromium could not even be
    launched in `beforeEach`.
  - `stale-ref.test.ts`: the whole file, the same cascade as on main (the first `beforeEach` navigate returned
    "[Current page state unavailable…]").
  - `settle.test.ts`: tests 7, 9 and 10 and the `afterAll` hook (navigations to static local pages took 10 s,
    the `goto` action timeout, and snapshots were unavailable).
- Assessment: the browser stops responding during long full-suite runs in this container, the same pattern as on
  main. I have not proven the settle wait plays no part. Verify by rerunning the failing files alone, several
  times, on both the branch and a main worktree.
- One `TimeoutNegativeWarning` from the sleep appeared in that run; the `Math.max(0, ...)` clamp, already
  committed, fixes it.

## Environment notes

- Playwright 1.61 wants Chromium build 1228, but the SessionStart hook cannot download it (cdn.playwright.dev is
  blocked), so `findCachedChromium` falls back to `/opt/pw-browsers/chromium-1194`. Timing on the reviewer's
  machine will differ.
- Do not run browser-heavy probes while the full suite runs; it skews the timing tests.
- macOS notes from the task: a new renderer can stall about 2 s on its first text render, so warm it before
  timing anything (`settle.test.ts` does, in `beforeAll` and in the cancellation test). Never apply a short
  `actionTimeoutMs` to page loads or snapshots. Use `ControlOrMeta`, not `Control`, for select-all. Stubbed
  locators must implement `count()`.
- Scope from the task (other issues were being implemented in parallel): #157 owns `act()`, `navigate()` and
  `snapshotAfterAction()` in `src/tools.ts`, the `BrowserSession` option in `src/browser.ts`, and fixture pages.
  Leave `SYSTEM_PROMPT` and the agent loop (#158, #159), `src/model/*` and usage (#161), and `scripts/` and
  `package.json` (#162) alone.
