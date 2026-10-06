# TODO

This file lists open work and known limitations. Most of it comes from real-site benchmark runs in October 2026.

- **Benchmark:** 100 tasks, 60 from WebVoyager and 40 from Online-Mind2Web.
- **Setup:** `gpt-6-luna` with `reasoning_effort: none`, headless.

Decided work is tracked in issues. Every other item here is an observation. Confirm it with traces or a live A/B before filing it as an issue, as [CLAUDE.md](../CLAUDE.md) describes.

## In progress

- **#148 / PR #152: click checkboxes and radios through the label that covers them.**
  - Review found a regression on pages that override `window.eval`, for example americanexpress.com.
  - On those pages Playwright's page-world `evaluate` fails, so every checkbox click failed at once.
  - The fix must rely on Playwright's utility-world APIs such as `click({ trial: true })`, `getAttribute` and label locators. When a helper cannot run, it must fall back to the normal click.

## Observed, not filed yet

- **Search loops after a blocked site.**
  - When a site is blocked, the agent can spend most of its steps on new search queries. Allrecipes--19 and Healthgrades ran 18 and 23 Bing searches on 2026-10-05.
  - Each query is a new URL, so the revisit check (#136) resets every time.
  - Options: a budget for consecutive searches that open no result page, or a prompt rule. Either needs a live A/B.
- **URL guessing persists on some sites.** After #149, `Apple--11` still guessed 6–7 URLs after a 404.
- **Cookie banners and late popups are rarely dismissed.**
  - Amtrak's cookie banner was in the snapshot, but the model clicked behind it.
  - Booking's sign-in popup appears after the snapshot is taken, and it is not exposed as a dialog.
  - The interception error names the covering element (#134), but the model seldom closes it.
- **Long text read in parts loses facts.**
  - `browser_get_text` can continue with `offset` (#138). The model used it in only 2 of 6 cut reads.
  - Only the newest text stays in context, so facts from earlier parts drop out unless the model notes them.
  - `ArXiv--6` still undercounts tables.
- **Snapshot budget.**
  - About a third of snapshots on real sites hit the 40,000-character cut.
  - Open dialogs now come first (#147), but on many pages navigation menus and footers still use most of the budget.
- **Complex widgets.** Date pickers (Google Flights, Booking) take many clicks, and runs there often reach the step limit.

## Maintenance

- **Runtime size.** The runtime source is about 1.9k lines, above the ~1.5k target in [positioning.md](positioning.md). `src/tools.ts`, at 437 lines, is the first place to look for consolidation.
- **Benchmark tasks.** `bun run bench` runs real-site comparisons, but its tasks stay outside the repository until the WebVoyager and Online-Mind2Web licenses are checked.
- **Cloud environment.**
  - In the October batches, the cloud environment blocked Chromium downloads from `cdn.playwright.dev`.
  - Sessions therefore tested on a preinstalled, older Chromium (1194) through the cached-browser fallback.
  - Check the environment's network access as CLAUDE.md describes.
- **Workflow docs.** CLAUDE.md's issue workflow still describes Codex delegation. Recent issues were implemented in Claude Code cloud sessions.

## Not planned

Bot blocks such as Akamai's "Access Denied", Cloudflare checks and Google's `/sorry` depend on the client IP. Stealth and CAPTCHA solving are non-goals (see [positioning.md](positioning.md)). The agent should recognize a block and move on, not get around it.
