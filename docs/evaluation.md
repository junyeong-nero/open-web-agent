# Browser task evaluation

Run paid model evaluations explicitly, separately from the scripted/local `bun run test` suite:

```bash
bun run eval --live --model openai:gpt-6-luna \
  --model-options '{"reasoning_effort":"none"}' --output /tmp/luna-eval.json
```

Each case starts an isolated headless browser against local fixture pages. The six cases are
`price`, `search-filter`, `async-result`, `ref-recovery`, `tab-return`, and `lowest-price`. Use `--case` for a
subset, `--runs` (1–10) for repeats, and `--max-steps` (1–100) for a per-case budget.
Each agent run has a 120-second abort signal and a 5-second action timeout.
The action timeout covers navigation, snapshots and element actions, giving new renderer
processes time to initialize and draw text on slower machines. Refs that are not on the page
fail at once without this timeout and count as tool errors; runtime defaults remain unchanged.

The tab-return case captures the original missing tab-selection capability (#91) and now serves
as its regression check. Keep historical baseline failures when comparing versions.

The lowest-price case lists 30 products with a featured, more expensive first result and the
cheapest product at position 23, plus a client-side price sort. Its checks require the expected
product name and price. It is easier than real listing pages (see the lowest-price follow-up
below), so it serves as a regression check rather than a reproduction of that failure.

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

## Real-site benchmark

`bun run bench` compares model configurations, called arms, on real websites. It calls real model
APIs and costs money, so `bun run test` never runs it.

```bash
bun run bench --tasks ~/owa-bench/tasks.json --arms ~/owa-bench/arms.json \
  --out ~/owa-bench/2026-10-07 --runs 1 --parallel 4
```

The task file is a JSON array of `{ id, task }`. The task text goes to `owa run` unchanged, so it
must name the start URL when the task needs one. Other fields are ignored, so a converted dataset
can keep its metadata. Ids become directory names and must not contain `/`. Keep WebVoyager and
Online-Mind2Web tasks outside the repository until their licenses are checked.

```json
[
  { "id": "hn-top", "task": "Open https://news.ycombinator.com and report the title of the top story." },
  { "id": "python-release", "task": "On https://www.python.org, report the latest Python 3 version.", "site": "python.org" }
]
```

The arms file gives each arm a `name` and its `--model`. `modelOptions` (`--model-options`), `flags`
(more `owa run` flags) and `prices` (USD per million tokens) are optional:

```json
[
  { "name": "luna", "model": "openai:gpt-6-luna", "modelOptions": { "reasoning_effort": "none" },
    "prices": { "input": 0.10, "cachedInput": 0.01, "output": 0.50 } },
  { "name": "jev", "model": "openrouter:typesafe/jev-router" },
  { "name": "gemma", "model": "openrouter:google/gemma-4-26b-a4b-it", "flags": ["--max-steps", "30"] }
]
```

Each run calls `bun src/cli.ts run --json --headless --trace … --model … -- <task>`. Only the arm's
configuration applies: the runner removes `OWA_*` variables other than `OWA_API_KEY` from the CLI's
environment. `--runs` (default 1) repeats every task, and `--parallel` (default 1) runs that many at
once. Runs go task by task with the arms side by side, so the arms see each site at about the same
time. `--run-timeout` (default 600 seconds) stops a run that outlives the agent's own deadline
(`--timeout-ms`, default 300 seconds), and the run counts as `run_timeout`.

Each run keeps `result.json` (the `--json` output), `trace.jsonl`, `stderr.log` and `meta.json` (exit
code, seconds, timeout, CLI arguments) in `<out>/runs/<arm>/<task id>/<run>/`. Run the same command
again to resume. Finished runs are skipped. Runs stopped with Ctrl-C, and runs whose CLI failed
without a result (`cli_error`, such as a missing API key), run again. Delete a run's directory to
repeat it. An arm whose model, options or flags changed since its earlier runs is refused.

At the end the runner writes `summary.md` and `summary.json` to the output directory and prints the
overall table, which compares the arms side by side:

- results by `outcome.status` and `stopReason`, and steps
- wall time per run, median and total
- model calls, their mean and total time, and the models that served them, as each response named
  it (a router names the model it chose)
- input, cached input and output tokens, summed as in the task result's `usage` (see "Usage and
  cost" in the README). The provider's reported cost appears only when every run that called the
  model reported one. With `prices`, the summary also estimates the cost in US dollars, billing cache
  reads at `cachedInput` and all other input at `input`.
- tool errors by class: stale ref, click intercepted, not visible or outside the viewport,
  navigation failure, download, invalid arguments, and other

`summary.md` adds a per-task table with each run's outcome, median steps and wall time, input tokens
and tool errors. `summary.json` holds the full summary for every arm, overall and per task, and one
record per run with its answer. Outcomes remain the model's unverified assessment, so check answers
against references before claiming accuracy.

To try a [judge model](../README.md#checking-answers-with-a-judge-model), give it in an arm's flags, for example
`"flags": ["--judge-model", "gemini:gemini-3.1-flash-lite"]`; the runner removes `OWA_JUDGE_MODEL` like other `OWA_*`
variables. The summary then counts the judge's calls among the model calls, with their time and served model, but
its token sums and cost estimate cover only the result's `usage`, which leaves out the judge. Read `judgeUsage`,
`judgeError` and `outcome.judge` from each run's `result.json`.

To compare runs with and without [coordinate clicks](../README.md#clicking-by-coordinates-with-a-grounding-model),
give one arm `"flags": ["--caps", "vision", "--grounding-model", "openrouter:bytedance/ui-tars-1.5-7b"]` and leave
the other without them. The runner removes `OWA_GROUNDING_*` like other `OWA_*` variables. As with the judge, the
grounding model's calls count among the model calls but not in the token sums or the cost estimate; read
`groundingUsage` from each run's `result.json`. A failed `browser_locate` call counts as an `other` tool error.

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

## Lowest-price follow-up (2026-10-03)

On the real query "다나와에서 다이슨 에어랩 최저가 찾아줘", `gpt-6-luna` (`reasoning_effort: none`)
often reported a more prominent, more expensive listing; it picked the cheapest product in 1 of 4
earlier runs. With the prompt sentence for lowest/highest/newest questions it picked the cheapest
product in 4 of 4 runs (once by sorting by price), against 1 of 4 in an A/B run without it. The
`lowest-price` fixture case passed 4/4 in both arms. These are small live samples, not a reliability claim.
