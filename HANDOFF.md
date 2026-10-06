# Hand-off: #163, hand a stalled run to a stronger model

> Work-in-progress notes from the Claude Code cloud session that started this issue. **Delete this file before the PR is merged.**

## Where things stand

- Branch: `feat/163-escalate-stalled-runs`. Push only here, and don't merge.
- Base: `135950e` ([fix] stop search-query loops after the task's site is blocked, #169).
  - That was still `origin/main` at the last check on 2026-10-06.
  - `git fetch origin && git merge origin/main` printed "Already up to date".
  - Check main again before opening the PR.
- Commits on the branch. WIP commits are fine because the PR is squash-merged.
  - `4c5f544` [feat] hand a stalled run to a stronger model (wip: core change): `src/agent.ts`, `src/cli.ts`, `src/mcp.ts`, `src/model/resolve.ts`
  - `2d6e13d` [feat] wip: hand off unfinished work for #163: `src/escalation.test.ts` (new), plus the final form of `roleModelConfig` in `src/model/resolve.ts`
  - The commit that adds this file
- Diff against the base: 5 files, +285 / −14.
  - Runtime: `src/agent.ts` +51/−6, `src/cli.ts` +15/−2, `src/mcp.ts` +3, `src/model/resolve.ts` +28/−6
  - Test: `src/escalation.test.ts` +202
- Not started: README and docs. No PR is open.

### Issue #163 checklist (개선 및 완료 기준) against this branch

| Checklist item | State |
|---|---|
| Optional setting that changes nothing when off: `--escalate-model`, `--escalate-model-options`, env vars, existing `provider:model` resolution | Implemented and tested |
| The first stall signal hands the remaining steps to the escalation model. Once per run, same transcript. A second stall stops with the #135 best-effort answer | Implemented and tested |
| Same model with a higher reasoning effort (`--escalate-model openai:gpt-6-luna --escalate-model-options '{"reasoning_effort":"medium"}'`) | Implemented. Tested through the real OpenAI adapter against a local fake endpoint |
| The result and trace record the escalation step and per-model usage (#161 format) | Implemented and tested. **README not written yet** |
| Tests with two scripted models: switch once on a signal, no switch when unset, stop after a second stall | Written. 15 of 17 cases pass; the 2 failures are in a different test (CLI wiring, see below) |
| `bun run typecheck` and `bun run test` pass | **Not yet.** One typecheck error and 2 failing cases, both in `src/escalation.test.ts`. The full suite has not been run since the change |
| Reviewer runs the live A/B (#162 runner) | The reviewer's job, not this PR's. Mention it under unmet criteria |

## Constraints from the original task prompt

Re-read these before finishing.

- **Scope: issue #163 only.** Other sessions are implementing #164 (judge, `--judge-model`), #165 (screenshot check, `--vision-model`) and #166 (grounding click, `--grounding-model`) in parallel.
  - Keep the diff minimal and local, and don't refactor unrelated code.
  - Merge conflicts with those PRs in `src/cli.ts` (`parseArgs` options, HELP), `src/mcp.ts`, `src/agent.ts` (`AgentOptions`, the `model` event) and `src/model/resolve.ts` are expected. They are line-level and trivial.
- **Shared configuration shape** for all four roles:
  - Flags `--<role>-model <provider:model>` and `--<role>-model-options <json>`.
  - Environment variables `OWA_<ROLE>_MODEL` and `OWA_<ROLE>_MODEL_OPTIONS`.
  - Models resolve through `resolveModel` / `parseModelOptions`.
  - The option is `<role>Model?: ModelAdapter` in `AgentOptions`. When it is unset, nothing changes.
  - Secondary calls are recorded in the trace like other model calls.
  - Reuse `Usage` and `sumUsage` from #161, and document how the secondary model's usage is reported.
- `docs/positioning.md`: secondary models are opt-in, provider-neutral, and called from the agent loop, never inside tools. This branch adds no tool, and the MCP and agent tool sets are unchanged.
- **Tests must also pass on the reviewer's macOS machine:**
  - A new Chromium renderer can stall about 2 s on its first text render, so never apply a short `actionTimeoutMs` to page loads or snapshots.
  - Use `ControlOrMeta`, not platform-specific keys.
  - Stubbed locators must implement `count()`.
  - Don't add page-world `evaluate` to paths that run on every action (fixture `/toggles-no-eval`).
  - The new tests launch no browser (fake tools, and the `BrowserSession` never starts), so none of these apply to them. Keep it that way.
- **Never call real model APIs** in tests, and run no live evaluations or real-site runs. Use scripted or fake adapters (`src/testing/scripted-model.ts`) or local `Bun.serve` endpoints.
- **Verification:**
  - Run `bun run typecheck` and every test file you added or touched.
  - Then run `bun run test` once. Browser tests in the cloud container time out intermittently, sometimes even on main.
  - Rerun any failing files. If they still fail, run the same files on main in a separate checkout (`git worktree add /tmp/main origin/main`).
  - Report the counts honestly.
- **Finish:**
  - The first line of the final commit is `[feat] hand a stalled run to a stronger model`.
  - Open a PR from `feat/163-escalate-stalled-runs` into `main` with the same title. Don't merge.
  - The PR body has these parts:
    - `Closes #163.`
    - A short description of the change and the design choices
    - A Validation list with the exact commands and pass/fail counts, plus the main comparison if anything failed
    - Any acceptance criteria not met, and why. The reviewer's live A/B is not ours to meet.
    - The implementation-credit line the original prompt specified. Ask the user for its exact wording, since the work is now being finished by a different agent.
- Commit and PR titles follow CLAUDE.md: `[type] lowercase imperative`.

## What is done, file by file

### `src/agent.ts`

- **`AgentOptions.escalateModel?: ModelAdapter`**, with a doc comment that lists the signals.
- **`AgentResult.escalation?: Escalation`**, from the exported `interface Escalation`:
  - `step`: the last step the first model ran, i.e. the step whose signal triggered the switch. `result.steps - escalation.step` is the number of steps the escalation model ran.
  - `signal`: `"no_progress"`, `"tool_failures"` or `"step_budget"`
  - `model`: the escalation adapter's `name`, e.g. `openai-chat:gpt-6-sol`
  - `usage`: `sumUsage` over the escalation model's calls only
  - The doc comment on `AgentResult.usage` now says it includes the escalated calls.
- **`AgentEvent`**:
  - New `{ type: "escalate", step, signal, model }`, typed as `{ type: "escalate" } & Omit<Escalation, "usage">`.
  - The `model` event gained `role?: "escalate"`, set on every call made after the switch.
- **In `runAgent`:**
  - New state: `let model = options.model`, `let escalation`, and `let escalatedCalls` (the index into `callUsage` where the switch happened). `visit` changed from `const` to `let`.
  - `ask()` calls `model.complete(...)` instead of `options.model.complete(...)`, so after the switch every call goes to the escalation model: steps, the outcome follow-up and the best-effort answer.
  - `finish()` adds `result.escalation = { ...escalation, usage: sumUsage(callUsage.slice(escalatedCalls)) }`.
  - New closure `escalate(stall, notice)`, at lines 153–166. The parameter is called `stall` so it doesn't shadow the abort `signal`. It returns `false` when there is no `escalateModel`, the run already escalated, or `step >= maxSteps`. Otherwise it:
    - switches `model`, records `escalation` and `escalatedCalls`, and emits the `escalate` event
    - pushes one user note: `` `${notice} Remaining steps: ${maxSteps - step}. If the current approach is not working, try a different one.` ``
    - resets the stall counts: `failures = 0`, `repeatedSteps = 0`, `previousState = ""`, `visit = pageVisits()`
    - returns `true`
  - The loop, at lines 216–225:
    - `if (stalled && !escalate("no_progress", "The last steps made no progress.")) return finish(... "no_progress" ...)`. This covers both the repeated-state check and the page-revisit check (#136), because both feed `stalled`.
    - ``if (failures >= maxFailures && !escalate("tool_failures", `Every browser action failed in the last ${failures} steps.`)) return finish(... "tool_failures" ...)``
    - ``if (step >= Math.ceil(maxSteps * 2 / 3)) escalate("step_budget", `${step} of ${maxSteps} steps are used.`)``, with the comment "Most stalled runs end at the step limit, where no steps would be left to hand over."
- **With `escalateModel` unset nothing changes.** `escalate()` returns `false` at once, so every stop path, request and event is exactly as before. No `role` field and no `escalation` field appear.

### `src/model/resolve.ts`

- New exported `roleModelConfig(role, { model?, options? }, env = process.env): ModelConfig | undefined`:
  - The model is `flags.model ?? env.OWA_<ROLE>_MODEL`.
  - Options are `flags.options ?? env.OWA_<ROLE>_MODEL_OPTIONS`. As with `--model-options`, the flag's object replaces the environment's, and `{}` clears it.
  - Options without any model throw `--<role>-model-options / OWA_<ROLE>_MODEL_OPTIONS need --<role>-model or OWA_<ROLE>_MODEL`.
  - An empty model (`--escalate-model ""` or `OWA_ESCALATE_MODEL=`) returns `undefined`, so escalation is off, and the options are not validated. This lets a user switch off an escalation set in the environment.
  - It returns `{ model, extraBody }` and nothing else. The main model's `baseUrl`, `api`, `provider`, `apiKey` (`OWA_API_KEY`) and `module` are deliberately not inherited; see design decision 11.
  - It is generic, so #164–#166 can reuse it as `roleModelConfig("judge", …)` and so on.
- `parseModelOptions(value, label = "--model-options / OWA_MODEL_OPTIONS")` and `validateModelOptions(value, label = …)` take an optional label, so errors name the right flag. Default behavior and messages are unchanged, and `src/model/options.test.ts` still passes.

### `src/cli.ts`

- `parseArgs` gained `"escalate-model"` and `"escalate-model-options"`.
- HELP lists both flags in the "Agent:" section, each on its own line with the description at column 31.
- `const escalateConfig = roleModelConfig("escalate", { model: values["escalate-model"], options: values["escalate-model-options"] })` is computed right after `modelConfig`, so option errors surface before anything else.
- `run`: `const escalateModel = escalateConfig && await resolveModel(escalateConfig)` comes after the main model, and the result is passed to `runAgent`.
- `mcp`: `const agentEscalateModel = values.agent && escalateConfig ? await resolveModel(escalateConfig) : undefined` is passed to `createMcpServer`. The escalation model, like `--model`, resolves only with `--agent`.
- `logEvent` writes `↑ [<step>] <signal>: escalating to <model>` to stderr on the `escalate` event.
- Both modes resolve at startup, so a missing key or bad options fails before any model request.

### `src/mcp.ts`

- `McpServerOptions.agentEscalateModel?: ModelAdapter`, named like `agentModel`, is passed to `runAgent` as `escalateModel`.
- The `browser_task` text summary is unchanged. `structuredContent` spreads the whole result, so it carries `escalation` without further changes.

### `src/escalation.test.ts`

New file: 10 tests, 17 cases.

- **No browser launch and no real APIs.** Fake tools mean the `BrowserSession` never starts. The first model is `scriptedModel(...)`; the escalation model is `{ ...scriptedModel(...), name: "strong" }`, which keeps the same `requests` array.
- **Helpers:**
  - `clickTool(page)` is a fake `browser_click` whose page after the nth click is `page(n)`; an `Error` fails the click.
  - Page functions: `stuck`, `failing` and `moving`.
  - Usages: `weakUsage = { inputTokens: 10, outputTokens: 1 }` and `strongUsage = { inputTokens: 100, outputTokens: 5, cost: 0.01 }`.
  - `run(tool, weak, strong?, options)` runs the agent and collects events.
  - The `signals` table: `no_progress` (stuck, stalls at step 3, budget 30), `tool_failures` (failing, step 3, budget 30) and `step_budget` (moving, step 4, budget 6, since `ceil(6·2/3) = 4`).

| Line | Test | Verifies | Last result |
|---|---|---|---|
| 53 | `hands the remaining steps and the same transcript to the escalation model on %s` (×3 signals) | <ul><li>Result: completed at `stalledAt + 1`.</li><li>`usage` totals both models and has no `cost`, because the first model reported none.</li><li>`escalation` equals `{ step, signal, model: "strong", usage: strongUsage }`.</li><li>Request counts per model.</li><li>The escalation model's first request has the same system prompt and tools, and the same messages the first model would have been sent next. A reference run without escalation provides those, compared through `slice(0, 1 + 2 * stalledAt)`.</li><li>The exact note text.</li><li>Trace order ends `tool, escalate, step, model:escalate, done`.</li><li>The `escalate` event content.</li></ul> | pass ×3 |
| 81 | `does not switch without an escalation model on %s` (×3) | <ul><li>Today's stop: `no_progress` or `tool_failures` at step 3, and `step_limit` after 6 steps for the budget case.</li><li>Best-effort answer, no `escalation` field, no `escalate` event and no `role`.</li></ul> | pass ×3 |
| 91 | `stops when the run stalls again after escalating on %s` (×3) | <ul><li>Fresh stall counts: the escalation model gets 3 more identical or failed steps, or the rest of the budget, before the run stops with the same stop reason as without escalation.</li><li>The escalation model writes the best-effort answer, in a tool-less request.</li></ul> | pass ×3 |
| 104 | `escalates on a page revisit cycle, and the escalation model's revisit counts start fresh` | <ul><li>An a/b navigate cycle stops at step 9 (#136) and escalates as `no_progress`.</li><li>The escalation model revisits `/a` and is not stopped, because the revisit tracker was reset; it then answers at step 11.</li></ul> | pass |
| 117 | `stops as before when a stall leaves no step to hand over` | <ul><li>With `maxSteps: 2, maxRepeatedSteps: 2` the stall is on the last step.</li><li>Result: `no_progress` with no escalation, and 0 calls to the escalation model.</li></ul> | pass |
| 124 | `escalates to the same model when only its options differ` | <ul><li>A local `Bun.serve` fake OpenAI endpoint, two adapters from `resolveModel` (one through `roleModelConfig`), both for model `gpt-6-luna`.</li><li>Request bodies carry `reasoning_effort` `none` ×3, then `medium`.</li><li>`escalation.model` is `openai-chat:gpt-6-luna`.</li></ul> | pass |
| 147 | `hands a stalled browser_task to the MCP server's escalation model` | In-process `createMcpServer({ agentModel, agentEscalateModel })` gives `structuredContent.escalation`. | pass |
| 158 | `reads --escalate-model and its options before the environment` | `roleModelConfig`: unset, env only, flag beats env, flag options replace env options (`{}` clears), and an empty model means off. | pass |
| 170 | `rejects escalation options that are invalid or have no model, without echoing them` | <ul><li>Invalid JSON, `[]` and a string all give the escalation label's "must be a JSON object", without echoing the value.</li><li>A reserved key (`model`) is rejected.</li><li>Options without a model give "need --escalate-model or OWA_ESCALATE_MODEL".</li></ul> | pass |
| 180 | `checks the escalation model before any model request: %s %s` (`run t`, `mcp --agent`) | <ul><li>Spawns `bun src/cli.ts` with `env: { PATH }` only, so no API keys, and a local fake main endpoint.</li><li>(1) `--escalate-model openai:gpt-6-sol` exits 1 with "set OPENAI_API_KEY".</li><li>(2) Invalid `--escalate-model-options` exits 1 with the label and without the value.</li><li>(3) `OWA_ESCALATE_MODEL_OPTIONS` without a model exits 1.</li><li>The endpoint gets 0 requests.</li></ul> | **fail ×2**, see below |

## What is left

1. **Fix the CLI test at line 180.** Both of its cases fail, and it causes the one typecheck error. Causes and fixes are in the next section.
2. **README.** Nothing written yet. Suggested text is in "Draft README text" below. Places to change:
   - `## Models`: a new "### Escalating stalled runs" subsection.
   - `## Options` block: the two flags.
   - `### Delegated task results`: add `escalation` to the result field list.
   - `### Usage and cost`: how `escalation.usage` and the trace report the escalation model's usage. The task asked for this explicitly.
   - Optional: one sentence near README line 106 ("It stops when it runs out of steps, …") and in "Task limits and cancellation", saying that with `--escalate-model` the first stall hands over instead of stopping.
   - CLAUDE.md, AGENTS.md and `docs/` don't need changes. Leaving them alone avoids conflicts with #164–#166.
3. **Verification.**
   - Run `bun run typecheck` and `bun test --timeout 30000 src/escalation.test.ts`.
   - Run the touched neighbours: `src/best-effort-answer.test.ts src/revisit.test.ts src/limits.test.ts src/usage.test.ts src/cli.test.ts src/model/options.test.ts src/model/resolve.test.ts src/empty-response.test.ts src/mcp.test.ts src/agent.test.ts`.
   - Then run `bun run test` once. Rerun failures, compare with main if needed, and record the counts for the PR.
4. **Final commit and PR** as described under the constraints. Delete this file in that final commit, or before the merge.

## Known failures and their causes

Last run: `bun run typecheck && bun test --timeout 30000 src/escalation.test.ts`, on content identical to `2d6e13d`.

### 1. Typecheck error

`src/escalation.test.ts(188,81): error TS2322: Type '(err?: unknown) => void' is not assignable to type 'string'.`

- **Cause.** Line 180 uses `it.each([["run", "t"], ["mcp", "--agent"]])(…, async (...command) => …)`, and line 188 spreads `...command` into the `Bun.spawn` argument array.
  - Bun's TypeScript typings for `it.each` include a `done` callback in the rest-parameter tuple.
  - At runtime only the row's two strings arrive. A scratch probe outside the repo printed `rest args: 2 [ "string", "string" ]`.
  - `src/cli.test.ts` uses a rest parameter too and typechecks. Its rows have different lengths (`["--max-steps", "5"]` and `[]`), which probably changes the inferred type. Not verified.
- **Fix.** Use named parameters, e.g. `async (name, arg) => { const command = [name, arg]; … }`. Or drop the parametrization and loop over the two commands inside one test.

### 2. Runtime failures in both cases of the line-180 test

```
198 |     expect(invalid.stderr).not.toContain("secret-token")
error: Received value must be an array type, or both received and expected values must be strings.
(fail) checks the escalation model before any model request: run t
(fail) checks the escalation model before any model request: mcp --agent
```

- **What passed before it.**
  - Line 195: the missing-key case, so `--escalate-model` reaches `resolveModel` and fails before running, in both modes.
  - Line 197: `expect(invalid).toMatchObject({ code: 1, stderr: expect.stringContaining("--escalate-model-options / OWA_ESCALATE_MODEL_OPTIONS must be a JSON object") })`. The label is right and the exit code is 1.
  - Lines 199–200 never ran: options without a model, and "endpoint got 0 requests".
- **Most likely cause (unverified).** Line 197 passed on the same object, and line 198 then found `invalid.stderr` not to be a string. So Bun's `toMatchObject`, with an asymmetric matcher (`expect.stringContaining`), most likely replaced the received object's `stderr` property with the matcher object. `cli()` itself always returns `{ code: number, stderr: string }`.
- **Fix.** Don't reuse an object after `toMatchObject` with asymmetric matchers. Assert the fields directly:
  ```ts
  const invalid = await cli([...])
  expect(invalid.code).toBe(1)
  expect(invalid.stderr).toContain("--escalate-model-options / OWA_ESCALATE_MODEL_OPTIONS must be a JSON object")
  expect(invalid.stderr).not.toContain("secret-token")
  ```
  Do the same for the other two `cli()` calls for consistency. Then confirm that lines 199–200 pass. They exercise `roleModelConfig`'s "need --escalate-model" error through the CLI, and the claim that nothing reached the endpoint.
- **Correction to the earlier chat hand-off.** It said the "empty model means off" refinement of `roleModelConfig` had not been tested. That was wrong. The refinement was edited in before this test run, and the two `roleModelConfig` tests (lines 158 and 170) passed with it.

## Design decisions and why

1. **Signals are exactly the issue's candidates.**
   - "no_progress 판정 직전" and "연속 실패 한도" are read as "at the point where the run would stop for `no_progress` or `tool_failures`, hand over instead of stopping". The task prompt says this too: "switch the remaining steps to the escalation adapter instead of stopping".
   - Escalating one step earlier, e.g. at 2 of 3 repeats, would change what `no_progress` means. It was not done.
   - `no_progress` covers both the repeated-state check and the page-revisit check (#136).
   - "step 예산의 일정 비율" is the `step_budget` signal.
2. **Why `step_budget` exists, and why two thirds.**
   - In the 2026-10-06 benchmark, 16 of the 20 stalled runs ended at the step limit. Escalating at the limit leaves no steps to hand over, so a signal before the limit is needed to reach most stalled runs.
   - `ceil(maxSteps × 2/3)`, which is step 20 of the default 30, leaves the escalation model a third of the budget. A run without an answer at step 20 is likely stuck.
   - Rough evidence, not measured: #160 reports 1,398 model calls over 100 tasks. The 20 stalled runs account for roughly 500–550 of them, which suggests the other runs averaged about 10–12 calls.
   - It is a constant with no flag ("keep the trigger simple"). The live A/B should settle the fraction, and changing it is one line (`src/agent.ts` line 225).
3. **Once per run, and fresh stall counts after the switch.**
   - Without the reset, the escalation model's first repeated action would end the run at once. `repeatedSteps` would already be 4 ≥ 3, and the revisit count 5 > 3.
   - The tests at lines 91 and 104 check that the escalation model gets the full thresholds.
   - The revisit tracker is reset by creating a new `pageVisits()`. That also forgets the `seen` lines and the current URL, so the first page after the switch counts as a first visit. This is slightly lenient and harmless.
4. **No escalation when no step remains** (`step >= maxSteps`). Otherwise a stall on the last step would become `step_limit`, and the escalation model would be called only for the best-effort answer. That would change today's stop reason. Tested at line 117.
5. **A note to the escalation model** (one user message after the tool results).
   - Without it, the stronger model sees "its own" loop in the transcript and may continue it, and it doesn't know the budget. The system prompt never mentions steps.
   - The note says why ("The last steps made no progress." / "Every browser action failed in the last N steps." / "N of M steps are used."), then `Remaining steps: K. If the current approach is not working, try a different one.`
   - `Remaining steps: K` avoids "1 steps remain".
   - Apart from the note the transcript is identical: the test at line 53 compares it with the first model's next request.
   - The Anthropic adapter merges the note into the tool-result user turn. The OpenAI adapter flushes deferred tool images before it.
   - The note is part of what the A/B measures and can't be switched off; see the open questions.
6. **After the switch, every call goes to the escalation model:** steps, the outcome-line follow-up, and the best-effort answer after a second stall or at the step limit.
7. **Usage reporting.**
   - `usage` keeps its meaning, "summed over the run's model calls", so it now includes the escalated calls.
   - `escalation.usage` is `sumUsage` over the escalation model's calls (`callUsage.slice(escalatedCalls)`).
   - The first model's token counts are the difference.
   - `cost` follows #161's rule in each sum: it appears only when every summed call reported one. A luna (no cost reported) to OpenRouter run therefore shows `cost` only in `escalation.usage`.
8. **Trace.**
   - The `escalate` event marks where and why.
   - `role: "escalate"` on later `model` events attributes each call even when a consumer filters events by type. This matters for same-model escalation, where the adapter `name` and the response `model` are identical for both models.
   - `role`, rather than `escalated: true`, was chosen so #164–#166 can tag their calls with the same field (`role: "judge"`, …).
9. **`escalation.step` is the last step of the first model.** `steps - escalation.step` is then the escalation model's step count.
10. **Resolve at startup,** not lazily, so a missing key or bad options fails before any model request. The line-180 test covers this.
11. **The escalation model takes a provider shorthand only.**
    - `--base-url`, `--api`, `--model-module`, `OWA_PROVIDER` and `OWA_API_KEY` are not inherited. With a different provider prefix, an inherited base URL would send requests to the wrong endpoint, and an inherited `OWA_API_KEY` would send one provider's key to another.
    - The escalation model reads its provider's key variable (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, …).
    - Consequence: a custom endpoint such as vLLM can't be the escalation target. Ollama works through `ollama:` at its default port.
    - A known wart: `resolveModel`'s missing-key message says "set OPENAI_API_KEY or OWA_API_KEY", and the `OWA_API_KEY` part doesn't apply to the escalation model. The README should say so.
12. **Options without a model are an error.** That matches the repository's strict-validation style and catches a forgotten `--escalate-model`. **An empty model means off**, so a user can override an environment setting without an error.
13. **MCP:** `agentEscalateModel` mirrors `agentModel`, and the `browser_task` text is unchanged to keep the diff small.
14. **No fallback when the escalation model fails.** If its call throws, for example on an outage, the run ends `model_error` with the partial answer and with `escalation` set. That is slightly worse than not escalating, but it only happens on misconfiguration or an outage. It could be a follow-up.
15. **Shared limits.** The escalation model shares the step budget and the deadline (`timeoutMs`, default 5 min). A slower model can end a run with `timeout`. Say this in the README.

## Draft README text

Adapt as needed.

New subsection under `## Models`:

````md
### Escalating stalled runs

`--escalate-model <provider:model>` (or `OWA_ESCALATE_MODEL`) sets an optional second model that takes over a run
that stalls. It is off by default; without it nothing changes. On the run's first stall signal, the remaining steps
go to the escalation model instead of the run stopping. The signals are:

- the run would stop for `no_progress` (identical steps or a page revisit cycle) or `tool_failures`;
- two thirds of the step budget are used without a final answer (step 20 of the default 30). Most stalled runs end at
  the step limit, where no steps would be left to hand over.

The escalation model continues the same transcript after a one-line note that gives the reason and the remaining
steps, and its stall counts start fresh. A run escalates at most once, and only while steps remain. Both models share
the step budget and the deadline. If the run stalls again, it stops as before and the escalation model writes the
best-effort answer.

`--escalate-model-options` (or `OWA_ESCALATE_MODEL_OPTIONS`) is a JSON object like `--model-options`, so the same
model with more reasoning works too:

```bash
owa run "..." --model openai:gpt-6-luna --model-options '{"reasoning_effort":"none"}' \
  --escalate-model openai:gpt-6-luna --escalate-model-options '{"reasoning_effort":"medium"}'
```

The escalation model takes a provider shorthand and reads that provider's key variable (`OPENAI_API_KEY`, …);
`--base-url`, `--api`, `--model-module` and `OWA_API_KEY` apply only to the main model. Escalation also works with
`owa mcp --agent`.
````

Addition to `### Usage and cost`:

```md
With `--escalate-model`, the result's `escalation` records `step` (the last step before the switch), `signal`
(`no_progress`, `tool_failures` or `step_budget`), `model` (the escalation adapter's name) and `usage`, the escalation
model's calls summed by the rules above. The result's `usage` still covers every call, so the first model's token
counts are the difference. In `--trace`, an `escalate` event marks the switch, and the escalation model's `model`
events carry `role: "escalate"`.
```

`## Options` block:

```
--escalate-model <provider:model>   OWA_ESCALATE_MODEL, takes over a stalled run once
--escalate-model-options <json>     OWA_ESCALATE_MODEL_OPTIONS
```

## Measurements

All are local scripted runs. No live or real-site runs were made, because the task forbids them.

| When | Command | Result |
|---|---|---|
| Baseline at `135950e`, before any change | `bun run typecheck` | clean |
| Baseline at `135950e` | `bun test --timeout 30000 src/best-effort-answer.test.ts src/revisit.test.ts src/usage.test.ts src/limits.test.ts src/cli.test.ts` | 34 pass, 0 fail (110 expects, 7.70 s) |
| After the core change (`4c5f544`'s content) | `bun run typecheck` | clean |
| After the core change | `bun test --timeout 30000 src/best-effort-answer.test.ts src/revisit.test.ts src/limits.test.ts src/usage.test.ts src/cli.test.ts src/model/options.test.ts src/model/resolve.test.ts src/empty-response.test.ts` | 53 pass, 0 fail (196 expects, 8.84 s) |
| With the new tests (`2d6e13d`'s content) | `bun run typecheck` | 1 error, in `src/escalation.test.ts` line 188 |
| With the new tests | `bun test --timeout 30000 src/escalation.test.ts` | 15 pass, 2 fail (17 tests, 92 expects, 1.97 s) |
| Not run yet | `bun run test` (full suite) and a main comparison | n/a |

Environment notes:

- The cloud SessionStart hook can't download Chromium v1228, because `cdn.playwright.dev` is blocked here.
- Browser tests fall back to the cached `/opt/pw-browsers/chromium-1194` through `findCachedChromium()` in `src/browser.ts`.
- The new tests don't use a browser.
- Other sessions have seen intermittent 30 s browser-test timeouts and one `EBADF … epoll_ctl` from a spawned CLI in `src/usage.test.ts`, which passed on rerun. If the full suite shows these, rerun before blaming the branch.

## Open questions for the reviewer or user

1. Is two thirds of the budget the right point for `step_budget`? Should it be configurable, or stay a constant until the A/B says otherwise?
2. Does the note help? The A/B arms (no escalation, `openai:gpt-6-sol`, luna medium) all include it when escalating. Isolating its effect would need a temporary code change.
3. Should a failing escalation model fall back to the first model (decision 14)?
4. Should the escalation model support custom endpoints, for example by inheriting `--base-url`/`--api` only when its spec has no provider prefix (decision 11)? And should the missing-key message drop "or OWA_API_KEY" for role models?
5. Should `escalation.step` instead mean the first step the escalation model ran (decision 9)?
6. Should the `browser_task` text summary mention the escalation, e.g. `escalated after step N to M`? Today only `structuredContent` has it.
7. The bench runner (#170, `test/162-bench-runner`) estimates cost with one price per arm. For the reviewer's A/B it should price `escalation.usage` at the escalation model's price, and the rest (`usage − escalation.usage`) at the first model's. The arm can pass `--escalate-model` through its `flags`, which the runner does not reject. It strips `OWA_*` variables except `OWA_API_KEY`, so `OWA_ESCALATE_MODEL` in the shell won't leak into arms.
8. The four role PRs will conflict on adjacent lines. `roleModelConfig` and the `role` field on `model` events are written so the other roles can reuse them. Whichever PR merges first sets the shape, as #160 says.
