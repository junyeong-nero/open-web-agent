# Browser task evaluation

Run paid model evaluations explicitly, separately from the scripted/local `bun run test` suite:

```bash
bun run eval --live --model openai:gpt-6-luna \
  --model-options '{"reasoning_effort":"none"}' --output /tmp/luna-eval.json
```

Each case starts an isolated headless browser against local fixture pages. The five cases are
`price`, `search-filter`, `async-result`, `ref-recovery`, and `tab-return`. Use `--case` for a
subset, `--runs` (1–10) for repeats, and `--max-steps` (1–100) for a per-case budget.
Each agent run has a 120-second abort signal and a 1-second element timeout.

The tab-return case captures the original missing tab-selection capability (#91) and now serves
as its regression check. Keep historical baseline failures when comparing versions.

Checks use DOM state and expected answers, never the model's self-reported success. The report
includes each verdict/check, execution result, input/output tokens, duration, tool calls/errors,
and an aggregate success rate. Failed checks/errors remain in the report and cause exit code 1.
JSON goes to stdout (and optionally a file); progress goes to stderr. Only a small allowlist of
option values is recorded. Keep a separate sanitized configuration record for other custom
options or endpoints if exact reproduction requires them. API keys are never report configuration.

## Comparing direct operation and delegation

Use the same fixture tasks, browser/tool capabilities, repeats, and budgets for both arms.
First compare models with this runner to establish task accuracy and model-loop usage. That alone
does **not** measure the cost of a calling coding agent or prove savings from delegation.

For an end-to-end comparison, keep a fixture server running, and give the same task to a calling
agent in two fresh contexts: (1) ordinary browser tools via `owa mcp`, (2) delegation using
`owa mcp --agent` and `browser_task`. Inspect the resulting DOM with the corresponding case checks
before closing each browser, and record the caller's token usage in both arms. For delegation,
add the worker's `structuredContent.usage` to the separately recorded caller usage. Keep the
per-model counts separate because prices differ. Report success rate, latency, and total cost per
successful task, including failed attempts. This runner does not automatically instrument an
external coding agent; store that comparison data alongside its baseline reports.

Do not convert tokens to money without recording the model prices, units, cache assumptions, and
price date used. Fixture results are reproducible checks of a small task set, not a claim about
arbitrary websites. Record external-site smoke tests separately.

## Recorded baseline (2026-09-28)

With `openai:gpt-6-luna`, `reasoning_effort: none`, 15 steps and one run per case:
price, search-filter, async-result and ref-recovery passed; tab-return failed (4/5).
The tab task's model claimed success, but the current browser page was still the pricing tab;
the original input was not accessible on that page. The DOM check correctly rejected the claim.
Total: 27,553 input / 624 output tokens, 19 tool calls (one deliberate stale-ref error),
41.2 seconds. These are a single local-fixture baseline, not a statistically reliable success
rate or a monetary-cost claim.


## Tab-selection follow-up (2026-09-28)

Adding tab selection alone still left a failure: the model alternated between tabs after older
snapshots were removed, then hit its step limit. The agent prompt now instructs it to read needed
facts with `browser_get_text` before leaving a page, and preserve earlier facts in a short note
before another text read. This uses the existing bounded context rather than retaining every tab's DOM.

Two consecutive live `gpt-6-luna` tab-return runs with the same options then passed all checks:
original tab selected, input preserved, pricing tab retained and the final answer correct. They used
6 and 8 tool calls respectively. These are regression smoke tests, not a broad reliability claim.

The final five-case live run also passed 5/5: 36,570 input / 702 output tokens, 22 tool calls, 42.2 seconds. The single tool error was the deliberately injected stale ref in the recovery case.
