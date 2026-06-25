# Navigation-Stable Browser Observations

## Goal

Browser tools must return an observation from a stable document even when the tool triggers a main-frame navigation. Pressing Enter in a form, clicking a link, or using browser history must not fail a run with:

```text
evaluate: Execution context was destroyed, most likely because of a navigation
```

The runtime will continue to capture an observation after every browser tool. The final tool observation in a browser action batch will become the agent's next `lastObservation` without a second unconditional environment read.

## Root Cause

`PlaywrightBrowserToolAdapter` currently calls `page.keyboard.press()` and immediately calls `environment.observe()`. A form submission can schedule its navigation after `keyboard.press()` resolves. `readObservation()` then evaluates JavaScript in the old document while the browser commits the new document and destroys the old execution context.

The orchestrator also calls `environment.observe()` after all browser actions even though each tool result already contains an observation. This second read creates another race window and duplicates expensive DOM work.

The failure is timing-dependent:

```text
press Enter resolves
  -> tool observation starts against document A
  -> navigation commits and destroys document A
  -> page.evaluate() fails
```

An observation can also complete before navigation commits and return stale document A. Therefore, swallowing the error or retrying only the failed evaluation is insufficient by itself.

## Design

### Action-level navigation synchronization

Tool execution should use Playwright actions that participate in navigation auto-waiting whenever possible.

- `navigate`, `go_back`, and `go_forward` will continue to wait for `domcontentloaded`.
- Locator-based clicks will keep using `locator.click()`, which waits for navigations initiated by that action.
- `press_key` will press through the currently focused locator. Locator `press()` participates in Playwright navigation waiting, unlike `page.keyboard.press()`. If the main frame has no focused locator, the body locator will preserve page-level key behavior while retaining locator auto-waiting.
- Coordinate clicks will resolve the topmost element at the viewport coordinate and invoke an element click with an element-relative position. This preserves the requested click point while gaining Playwright actionability and navigation waiting. If no element can be resolved, the adapter will fall back to `page.mouse.click()`.
- Raw mouse fallback is the only path that cannot rely on locator auto-waiting. It will use a main-frame navigation watcher installed before the input action. The watcher will allow a 250 ms detection window after the mouse action resolves. When navigation is detected, the tool waits for the resulting document's `domcontentloaded` state before observing.

Navigation synchronization must remain abortable through the existing run `AbortSignal`. Production code must not use an unconditional post-action sleep. The 250 ms watcher timeout means "no navigation detected" and is not a tool failure. The timeout is a module constant rather than a new user-facing configuration option.

`domcontentloaded` is the stability boundary. The runtime will not wait for `networkidle`, because long-lived requests and analytics traffic would make browser tools unnecessarily slow or unreliable.

### Atomic observation capture

`readObservation()` will capture document-derived fields in one `page.evaluate()` call:

- URL
- title
- body text
- interactive elements

This ensures those fields come from one JavaScript execution context instead of mixing values from different documents through `Promise.all()`.

Session-owned values such as `lastScreenshotPath` remain outside the page evaluation and are combined with the document snapshot afterward.

### Navigation-aware observation retry

Observation will be a bounded retry operation with exactly one initial attempt and at most two retries, for three capture attempts total. The attempt limit is a module constant rather than a new user-facing configuration option.

If capture fails with a known transient navigation error, the environment will:

1. wait for the current main frame to reach `domcontentloaded`;
2. retry the complete atomic observation capture against the current document;
3. stop after three total attempts and throw the most recent capture error.

Retryable errors are limited to Playwright errors that indicate document replacement during evaluation, such as a destroyed or missing execution context caused by navigation. Generic JavaScript errors, closed pages, detached sessions, and invalid runtime state must not be hidden as navigation races.

The existing abort behavior remains authoritative. Cancellation during action synchronization or observation retry closes the session through the existing abort cleanup and returns `AbortError`.

### Single observation ownership

The browser tool adapter remains responsible for capturing the post-tool observation and placing it in `ActionResult.observation`. The public Zod contracts do not change.

`RunOrchestrator.executeBrowserActions()` will return the latest non-null tool observation. After the browser action batch:

- use the returned observation as `state.lastObservation`;
- emit one `observation.captured` event for that observation;
- call `environment.observe()` only as a fallback when no action result supplied an observation.

This preserves per-tool observations in `browser.tool.completed` events while removing the unconditional duplicate read after the action batch.

Failed tool results remain visible to agents through `actionResults`. If failure recovery captures a valid observation, that observation is eligible to become `lastObservation`. Approval-gated actions follow the same rule.

## Data Flow

Navigation-producing key press:

```text
press_key Enter
  -> resolve focused locator
  -> locator.press("Enter")
  -> Playwright waits for initiated navigation
  -> wait for current document domcontentloaded
  -> capture atomic observation
  -> ActionResult.observation
  -> orchestrator reuses result observation
  -> observation.captured
```

Navigation racing with observation:

```text
tool input action
  -> observation attempt on document A
  -> document A is replaced
  -> classify destroyed-context error as transient
  -> wait for document B domcontentloaded
  -> retry complete observation on document B
```

Non-navigation tool:

```text
tool action
  -> no navigation detected
  -> capture observation once
  -> orchestrator reuses result observation
```

## Error Handling

- A navigation detection timeout is treated as no detected navigation, not a failed browser tool.
- A transient context error is retried only within the observation attempt limit.
- Exhausted retries expose the most recent Playwright capture error as the tool failure.
- Non-navigation evaluation errors fail immediately.
- Page or browser closure is not retried as navigation.
- Abort signals take precedence over retry and timeout handling.

## Tests

Add regression coverage for:

- submitting a delayed fixture form with `press_key: Enter` returns an observation from the destination page;
- the tool does not emit `Execution context was destroyed` during that flow;
- observation retries when the first atomic evaluation is interrupted by main-frame navigation;
- observation stops retrying after the attempt limit;
- non-navigation evaluation failures are not retried;
- a non-navigation key press does not wait for a full navigation timeout;
- locator clicks that navigate return the destination observation;
- coordinate clicks preserve viewport positioning while using element action auto-waiting;
- raw mouse fallback waits for `domcontentloaded` when its navigation watcher detects navigation;
- cancellation during navigation synchronization or observation retry still returns `AbortError`;
- the orchestrator reuses the final `ActionResult.observation` instead of calling the environment again;
- the orchestrator falls back to `environment.observe()` when action results contain no observation;
- browser event and JSONL payloads still contain per-tool observations and redact sensitive values.

Run verification:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/browser/src/playwright-environment.test.ts
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/core/src/orchestrator/run-orchestrator.test.ts
bun run typecheck
bun run test
```

## Non-Goals

- Do not remove per-tool observations from `ActionResult`.
- Do not change browser or event Zod schemas.
- Do not wait for all network activity to become idle.
- Do not add fixed sleeps after every browser action.
- Do not retry arbitrary Playwright or page-evaluation errors.
- Do not add site-specific handling for Naver or other pages.
