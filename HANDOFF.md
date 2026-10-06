# Hand-off: #164, check a succeeded answer against the evidence with an optional judge model

Delete this file before the PR is merged.

## Status

- Branch: `feat/164-judge-succeeded-answers`. It is based on main `135950e`. At hand-off time `origin/main` was still `135950e`, so `git fetch origin && git merge origin/main` was a no-op. Merge main again before finishing, because #163, #165 and #166 may land first.
- Commits on the branch:
  - `fd2828e` `[feat] wip: judge succeeded answers with an optional judge model`: all runtime code.
  - `30a6e01` `[feat] wip: hand off unfinished work for #164`: `src/testing/redirect-fetch.ts`, a test helper that nothing uses yet.
  - The commit that adds this file.
- `bun run typecheck` passes at `fd2828e`.
- No new tests are written yet and the README is not updated.
- Nothing was pushed to any other branch. The cloud system prompt also named `claude/effort-max-nynuwb`; the user's instruction to use only `feat/164-judge-succeeded-answers` took precedence.

## Sources and constraints

- Spec: issue #164 (Korean, with the 개선 및 완료 기준 checklist). Umbrella: #160 (shared principles). Read them with `gh api repos/junyeong-nero/open-web-agent/issues/164 --jq .body`; `gh issue view` uses GraphQL, which was blocked in the cloud session.
- Also follow `CLAUDE.md` (commit conventions, the rules for an agent implementing a delegated issue) and `docs/positioning.md`. Secondary models must be opt-in and provider-neutral, and they are called from the agent loop, never inside tools.

### Orchestrator constraints, restated from the session prompt

Shared configuration shape. The four parallel PRs (#163–#166) all use it so they merge cleanly:

- A flag `--<role>-model <provider:model>` and an optional `--<role>-model-options <json>`.
- Environment variables `OWA_<ROLE>_MODEL` and `OWA_<ROLE>_MODEL_OPTIONS`.
- Resolve the model with the existing `resolveModel` / `parseModelOptions` path, so every provider shorthand works. Add only your own role's flags.
- The agent option is `<role>Model?: ModelAdapter` in `AgentOptions`. When it is unset nothing changes: no extra requests and no behavior change.
- Record each secondary call in the trace like other model calls. Reuse `Usage` and `sumUsage` from #161, and document how the secondary model's usage is reported.

Parallel scope. Other sessions implement these, so keep this diff minimal and local:

- #163: escalate a stalled run to a stronger model (stall paths in `src/agent.ts`, `--escalate-model`).
- #165: a screenshot page-state check (a note after certain tool results, `--vision-model`).
- #166: an opt-in coordinate click backed by a grounding model (a `vision` capability in `src/tools.ts`, `--grounding-model`).

Notes for #164:

- The judge runs only when the final answer's outcome is `succeeded`. It sends one request with the task, the answer and the evidence: the newest page text or snapshot still in context, trimmed to what the judge needs.
- There are two backends:
  - Any chat model through the existing adapters, asked for a strict JSON verdict.
  - TypeSafe Jev (`POST https://api.typesafe.ai/v1/systemone`), called with plain `fetch`. Name it e.g. `typesafe:jev-latest` with `TYPESAFE_API_KEY`, and send one Noul or Choice question per request.
  - If both are too much code for the size budget in positioning.md, the orchestrator allowed shipping the chat backend plus a small interface for a later Jev client, as long as the PR says so. Both are implemented.
- When the answer is unsupported:
  - With steps left, continue once with the judge's finding.
  - With no steps left, downgrade the outcome to `partial` and add the reason to `unfinished`.
  - A judged run sets `outcome.verification` to `"judged"` and records the judge model.
  - Update the types, the MCP structured result and the README.
- A failed judge request never changes the answer or the outcome.
- Test with a fake judge adapter: supported, unsupported and judge failure.

Tests must also pass on the reviewer's macOS machine:

- A new Chromium renderer can stall about 2 s on its first text render. Never apply a short `actionTimeoutMs` to page loads or snapshots.
- Avoid platform-specific keyboard behavior; use `ControlOrMeta`.
- Stubbed locators must implement `count()`.
- Some sites override `window.eval` (fixture `/toggles-no-eval`). Do not add page-world `evaluate` to paths that run on every action.
- Use scripted or fake model adapters only. Never call real model APIs, and never run live evaluations or real-site runs; the reviewer does those in #162.

Verification:

- Run `bun run typecheck` and every test file added or touched, then `bun run test` once.
- If anything fails, rerun the failing files. If they still fail, run the same files on main in a separate checkout (`git worktree add /tmp/main origin/main`) and report the counts honestly.

Finish:

- WIP commits are fine because the PR is squash-merged. The first line of the final commit must be `[feat] check a succeeded answer against the evidence with an optional judge model`.
- Open a PR from `feat/164-judge-succeeded-answers` into main with the same title. Do not merge it.
- The PR body needs:
  - `Closes #164.`
  - A short description of the change and the design choices.
  - A Validation list with the exact commands and pass/fail counts, including the main comparison if anything failed.
  - The acceptance criteria not met, and why. The reviewer's live checks are not ours to meet.
  - The line `Implemented by Claude Code cloud session (claude-opus-5-5, effort max).` A different agent now finishes the work, so ask the user what this line should say (open question 17).

## What is done

### `src/judge.ts` (new, 91 lines)

This module is internal and not exported from `src/index.ts`.

- `JUDGE_PROMPT` is a yes/no question with three criteria lines:
  - Supported: the facts agree with the evidence and the answer does what the task asked.
  - Not supported: the evidence contradicts the answer, or shows it misses or misreads the task.
  - The evidence is only the latest content, possibly an excerpt, so a fact it does not mention may come from an earlier page and does not count against the answer.
  - The Jev adapter sends this text as the Noul `instructions`.
- `UNSUPPORTED_AT = 0.2`: the agent acts when `supported <= 0.2`. Live A/B runs (#162) should tune it.
- `EVIDENCE_CHARS = 16_000` (private): the evidence budget, split evenly between the parts present.
- `Verdict { supported: number; reason?: string }`.
- `judgeRequest(task, answer, pages)` returns `{ system: JUDGE_PROMPT, messages: [one user text message], tools: [] }`.
  - The user text joins these blocks with blank lines:
    - `Task: …`
    - `Answer: …`
    - The evidence parts.
    - The reply-format line: `Reply with only JSON: {"reason":"<one sentence>","supported":<probability from 0 to 1 that the answer is supported>}`.
  - Evidence parts:
    - `Text the agent read last`: the newest `browser_get_text` page text.
    - `Latest page snapshot`: the newest snapshot, with ` [ref=…]` and ` [cursor=…]` removed.
    - Each part goes through `relevantLines(part, task + "\n" + answer, 16000 / parts)`. A part that was cut gets ` (excerpt; … marks skipped lines)` in its label.
    - With neither part, the evidence block is `Evidence: none; the agent opened no page.`
- `parseVerdict(text)`:
  - It runs `JSON.parse` on the first `{…}` block in the text, or on the whole text when there is none. So code fences or prose around the JSON are tolerated.
  - `supported` may be a number in [0, 1] or a boolean (true becomes 1, false becomes 0).
  - A bare number such as `0.82`, which is what the TypeSafe adapter returns, also works.
  - `reason` is kept, trimmed, when it is a non-empty string.
  - Anything else returns `undefined`, which the agent treats as a judge failure.
- `relevantLines(text, query, max)`:
  - Text at or under `max` is returned unchanged.
  - Terms are lowercased `\p{N}+` numbers and `\p{L}{2,}` words, cut to their first 4 characters. "tables" and "table" both become `tabl`; a number like `389,430` becomes `389` and `430`.
  - A query term found on more than `max(5, lines/10)` lines is ignored, so menu words do not count.
  - Each line's score is `2 × its own rare-term hits + the hits of the line before + the hits of the line after`, so the heading above a price line comes along.
  - Lines are added greedily by score (ties go to the earlier line). Each line reserves its length plus 3 characters, and the total reserves 2 for the closing marker, so the output stays within `max`. Lines that do not fit are skipped.
  - The output keeps page order. A `…` line marks each gap, including gaps before the first and after the last kept line.
  - When nothing matches, the result is `text.slice(0, max - 1) + "…"`.

### `src/agent.ts`

Types:

- The `model` variant of `AgentEvent` gains `role?: "judge"`. Agent calls leave it out.
- `AgentResult.outcome.verification` is now `"unverified" | "judged"`.
- `AgentResult.outcome.judge?: { model: string; supported: number; reason?: string }` is set only when the verification is `judged`.
- `AgentResult.judgeUsage?: Usage & { inputTokens; outputTokens }`.
- `AgentOptions.judgeModel?: ModelAdapter`, with a doc comment.

`runAgent`:

- New state: a `judgeUsage` array and a `sentBack` flag.
- `finish()` adds `judgeUsage: sumUsage(judgeUsage)` when at least one judge call returned.
- The `judge(judgeModel, answer)` closure:
  - It calls `interruptible(() => judgeModel.complete({ ...judgeRequest(options.task, answer, latestPages(entries)), signal }), signal)`, so the task deadline and cancellation bound it.
  - It pushes the usage and emits `{ type: "model", role: "judge", step, text, toolCalls, model, durationMs, usage }`.
  - It returns `{ model: response.model ?? judgeModel.name, ...verdict }`, or `undefined` when the reply holds no verdict or anything throws.
- In the final-answer path, after the existing outcome follow-up request:
  - If the outcome is `succeeded` and `judgeModel` is set, the agent judges the clean answer, without the trailing outcome JSON.
  - A verdict sets `verification: "judged"` and `judge: verdict`.
  - If `supported <= 0.2`, the finding is `A check against the page evidence found the answer unsupported.`, followed by ` Reason: <reason>` when the judge gave one.
  - If `step < maxSteps && !sentBack`, the agent pushes the user message `${finding}\nVerify the facts in the browser, then reply with your corrected final answer and the outcome line.` and continues the loop, which uses one more step.
  - Otherwise the outcome becomes `partial` and the finding is appended to `unfinished`.
  - The run then finishes as `completed` / `final_answer`.
- `latestPages(entries)` scans the entries newest first. It returns the newest page-text result and the newest snapshot, from either the task message or a tool result. These are the same items `render()` keeps in context.

### `src/model/typesafe.ts` (new, 51 lines)

Exported from `src/index.ts`.

- `typesafeSystemOne({ model, baseUrl?, apiKey?, extraBody?, fetch? })` returns a `ModelAdapter` named `typesafe-systemone:<model>`.
- A request with tools throws `… only answers yes/no questions; use it as the judge model, not as the agent model`.
- Request:
  - `POST ${baseUrl ?? "https://api.typesafe.ai/v1"}/systemone` with `authorization: Bearer <key>`.
  - The body is `{ model, state, questions: { answer: { type: "noul", instructions: request.system } }, ...extraBody }`.
  - `state` joins the text parts of all messages with blank lines. Assistant text is included and images are dropped.
- Response:
  - `answers.answer.noul` must be a number, otherwise the adapter throws `… returned no yes/no answer`.
  - It returns `{ text: String(noul), toolCalls: [], model: json.model, usage }`, where usage comes from `usage.input_tokens` and `usage.output_tokens` via `reportedUsage`.
- The adapter uses `postJson`, so an HTTP error is a `ModelHttpError` with the bearer key redacted.

### `src/model/resolve.ts`

- A new `PROVIDERS.typesafe = { api: "systemone", baseUrl: "https://api.typesafe.ai/v1", keyEnv: "TYPESAFE_API_KEY" }`.
  - `ProviderPreset.api` is widened to `ApiFormat | "systemone"`.
  - `ApiFormat` and `parseApi` are unchanged, so `--api systemone` is still rejected for the agent model.
  - Library users can call `typesafeSystemOne({ baseUrl })` directly for a compatible server, for example an open Jev-compatible one.
- `resolveModel` branches on `api === "systemone"` and returns `typesafeSystemOne(...)`.
- `parseModelOptions(value, source = "--model-options / OWA_MODEL_OPTIONS")` and `validateModelOptions(value, source)` take a label for their error messages. The change is backward compatible.
- `resolveRoleModel(role, flags = {}, env = process.env)`:
  - The model is `flags.model ?? env.OWA_<ROLE>_MODEL`, and the function returns `undefined` when neither is set.
  - The options are `flags.options ?? env.OWA_<ROLE>_MODEL_OPTIONS`, parsed with the label `--<role>-model-options / OWA_<ROLE>_MODEL_OPTIONS`.
  - It then calls `resolveModel({ model, extraBody }, env)`.
  - It is role-generic on purpose, so #163, #165 and #166 can use it.

### `src/cli.ts`

- The help text has a new `Judge (optional, run and mcp --agent; flag > env):` section. Check its column alignment by eye.
- `parseArgs` gains `judge-model` and `judge-model-options`.
- A thunk `judgeModel = () => resolveRoleModel("judge", …)` is resolved only for `run`, and for `mcp` only with `--agent` (`judgeModel: agentModel && await judgeModel()`).
- `logEvent` prints `  judge: <verdict text>` for each judge call. The done line adds `; judge in X, out Y`.

### `src/mcp.ts`

- `McpServerOptions.judgeModel?: ModelAdapter` is passed to `runAgent`.
- The `browser_task` text now shows `outcome: <status> (<verification>)` instead of the hard-coded `(unverified)`, and adds `, judge tokens: X in / Y out` when `judgeUsage` exists.
- `structuredContent` is `{ ...result }`, so it already carries `outcome.verification`, `outcome.judge` and `judgeUsage`.

### `src/testing/redirect-fetch.ts` (new, not used yet)

- This file is for `bun --preload`. It rewrites `fetch` URLs that start with `OWA_TEST_FETCH_FROM` to `OWA_TEST_FETCH_TO`. Only string URLs are rewritten, which is all the adapters use.
- Why it exists: role models have no base-URL flag in the shared shape, so a CLI subprocess cannot otherwise point `--judge-model` at a local fake endpoint.
- Checked in the cloud session with Bun 1.3.14: `bun --preload ./pre.ts ./main.ts` patches the child's global `fetch`.
- The adapters capture `options.fetch ?? fetch` when they are created, which happens after the preload ran, so the patch applies.

## Design decisions and why

1. **Jev is a `ModelAdapter`, not a separate judge interface.**
   - The shared shape fixes `judgeModel?: ModelAdapter` and resolution through `resolveModel`, so `typesafe:jev-latest` must resolve like any provider.
   - CLAUDE.md allows a new adapter only for a genuinely new wire format, and `/v1/systemone` is one.
   - The mapping is generic: the system prompt becomes one Noul question, the message text becomes the `state`, and the reply text is the probability of yes.
   - The judge parser accepts that bare number. The only coupling is that `parseVerdict` takes a bare probability.
2. **The verdict is a probability (`supported`, 0–1) with the reason first.**
   - The same number works for both backends, so one threshold covers them, and the issue asks for a threshold set by A/B.
   - Asking for the reason before the number gives small chat models a moment to reason.
   - Booleans are accepted because some models answer with them.
3. **The threshold is `<= 0.2` and is a constant.**
   - The issue says to act only when the judge is sure (근거가 없다고 확실하면), and the A/B sets the value.
   - It is not an option: the shared shape has only model and options. Add `judgeThreshold` later if the A/B wants a different value per backend.
4. **The evidence is the newest page text and the newest snapshot, both when both exist, and never the agent's own notes.**
   - Both are still in the agent's context (see `render()`), and including both lowers false positives on multi-page answers.
   - Notes are the agent's claims, not evidence, so including them would let an invented note support an invented answer.
   - Refs and cursor hints are stripped because they only matter for acting on the page.
5. **Evidence is cut by relevance.**
   - #164 asks for "the relevant part" and to narrow the evidence because Jev is weak with long, irrelevant state. A head cut would mostly keep navigation menus.
   - The term scheme is crude but language-agnostic, and numbers carry most of the signal.
   - The 16k budget, about 4–8k tokens, keeps Jev well under its 32k-token state limit and keeps chat judges cheap.
6. **The judge runs even when the agent opened no page.**
   - The evidence then reads `Evidence: none; the agent opened no page.` and the judge decides.
   - The system prompt says to base answers on the browser, so an answer from memory should be caught.
   - This also keeps the code and tests simpler. The alternative is to skip the request when there is no evidence (open question 5).
7. **Only the `final_answer` path is judged.**
   - The best-effort answers at `step_limit`, `no_progress` and `tool_failures` already report an incomplete status, and the stall paths belong to #163.
   - The judge runs after the existing outcome follow-up request, so an answer whose outcome came from that follow-up is judged too.
8. **An answer is sent back at most once (`sentBack`).**
   - This bounds the extra cost and makes loops impossible.
   - The second judgment, of the revised answer, still runs. If it is also unsupported, the outcome becomes `partial`.
   - The send-back costs one step, and it happens only when `step < maxSteps`.
   - The finding text is shared by the send-back message and the `unfinished` entry.
9. **A failure changes nothing.**
   - A throw, an HTTP error, a deadline or cancellation, an unparseable reply, or an out-of-range value all leave the answer, the outcome and `verification: "unverified"` as they were. The answer stays `completed` / `final_answer`, which mirrors the existing outcome follow-up request.
   - A judge request that throws writes no trace event, which matches #161's rule that a failed call writes no `model` event.
   - An unparseable reply did return, so it emits a `model` event with its text and counts in `judgeUsage`. If it reported no usage, it counts as zeros.
10. **`judgeUsage` is kept apart from `usage`.**
    - The judge's tokens have another price.
    - `sumUsage` keeps `cost` only when every call reported one, so mixing in a judge on Gemini, which reports no cost, would erase the agent's OpenRouter cost.
    - `judgeUsage` uses `sumUsage` with the same rules.
11. **The trace uses `model` events with `role: "judge"`**, so code that sums `model` events can tell the calls apart.
12. **`outcome.judge.model` is the served model when the response names one** (as in the trace), otherwise the adapter name, e.g. `typesafe-systemone:jev-latest` or `openai-chat:<model>`.
13. **`resolveRoleModel` is generic and takes a label** so that the judge's error messages name `--judge-model-options / OWA_JUDGE_MODEL_OPTIONS`. The agent's own `OWA_MODEL` / `OWA_API_KEY` never configure the judge.
14. **The code is placed to keep merges with #163, #165 and #166 easy.**
    - Most of the logic is in the new `src/judge.ts`, and `agent.ts` changes only in the final-answer path, the types and one helper.
    - Expected conflicts: the type definitions in `agent.ts` (each PR adds a `<role>Model` option and maybe a usage or event field), the options and help text in `cli.ts`, and possibly a role-resolution helper in `resolve.ts`. Keep one helper.

## Provenance of the Jev wire format (unverified)

- docs.typesafe.ai was blocked by the cloud egress proxy, and so were apidog.com, flaviocopes.com, docs.litellm.ai, docs.rs and jev-agent.com.
- The shape comes from two independent secondary sources that agree:
  - Community notes at `raw.githubusercontent.com/codaaiteam/jev-typesafe-ai/main/README.md`, which were reachable.
  - Web-search snippets quoting the docs.
- Request: `{ "model": "jev-latest", "state": "<text>", "questions": { "<id>": { "type": "noul", "instructions": "…" } } }`. Choice questions add `"criteria": { "<option>": "<description>" }`.
- Response: `{ "model": "jev-1.13.0", "answers": { "<id>": { "type": "noul", "noul": 0.95 } }, "usage": { "input_tokens": 296, "output_tokens": 20 } }`. A Choice answer has `choice`, `confidence` and `probabilities`.
- Auth: `Authorization: Bearer $TYPESAFE_API_KEY`.
- Limits from #160: 64k tokens per request, 32k for the state and the longest question, 80 requests per second. Price: $0.042/M input tokens; output is free.
- Nobody has a TypeSafe key: not the cloud session, and per #160 not the reviewer either. The PR must say the Jev path is untested against the live API and was written from secondary sources.

## What is left

### Tests

Nothing below is written yet. Use `scriptedModel` for both models and give the judge its own name with `Object.assign(scriptedModel([...]), { name: "fake-judge" })`. For runs that need no browser, use a fake tool, as `best-effort-answer.test.ts` does:

```ts
const readPage = (text: string): BrowserTool => ({ name: "browser_get_text", description: "test", schema: z.object({}), readOnly: true, capability: "core", async run() { return { pageText: true, text } } })
```

With fake tools a `BrowserSession` is never launched, because `taskMessage` checks `browser.started`.

`src/judge.test.ts`:

1. **Reproduce #164 on `/pricing` with a real browser.** Keep the default `actionTimeoutMs`.
   - Agent script:
     1. `browser_navigate` to `${fixture.url}/pricing`.
     2. `The Pro plan costs $24 per month.\n{"outcome":"succeeded","unfinished":[]}`.
     3. `browser_get_text`.
     4. `The Pro plan costs $42 per month.` with the succeeded line.
   - Judge script:
     1. Assert `tools` is `[]`, `system` is `JUDGE_PROMPT`, and the user text contains `Task: …`, `Answer: The Pro plan costs $24 per month.` (no outcome JSON) and `The Pro plan costs $42 per month.`, and no `[ref=`. Return `{"reason":"The page says $42 per month, not $24.","supported":0.05}` with usage 300/20.
     2. Assert the text contains `Text the agent read last`. Return a fenced `{"reason":"…","supported":0.97}` with usage 320/18 and no `model`.
   - Expect:
     - `completed` / `final_answer`, the answer `$42 …`, `steps: 4`.
     - `outcome: { status: "succeeded", verification: "judged", unfinished: [], judge: { model: "fake-judge", supported: 0.97, reason } }`.
     - `judgeUsage` 620/38, with the agent's `usage` unaffected.
     - The agent's third request ends with a user message containing `found the answer unsupported` and `Reason: The page says $42 per month, not $24.`, and still offers tools.
     - Two `model` events with `role: "judge"`, at steps 2 and 4.
     - 4 agent requests and 2 judge requests.
2. **No step left gives `partial`.** Use fake tools and `maxSteps: 2` (read, then a `$24` answer); the judge returns `supported: 0` or `false`.
   - Expect the answer unchanged, `outcome { status: "partial", verification: "judged", unfinished: ["A check against the page evidence found the answer unsupported. Reason: …"] }`, `taskIncomplete` true, 2 agent requests and 1 judge request.
3. **A second rejection gives `partial`, even with steps left.** Use `maxSteps: 10`; the judge rejects twice. Expect `partial`, `steps: 3`, 3 agent requests and 2 judge requests.
4. **Failures change nothing.** Try each of: a throw (HTTP 503), prose, `{"supported":1.5}`, `{"reason":"x"}` and `{"supported":"0.3"}`.
   - Expect `outcome` to equal `{ status: "succeeded", verification: "unverified", unfinished: [] }` with no `judge` key, the answer unchanged, no send-back and no `error`.
   - `judgeUsage` is present for the replies that returned and absent for the throw.
5. **The deadline or cancellation during the judge request.** The judge returns `new Promise(() => {})`. Use `timeoutMs` 200 for the deadline case and abort a controller inside the judge call for the cancel case.
   - Expect `completed`, the original answer and outcome, and an aborted judge `request.signal`. This mirrors the follow-up test in `agent.test.ts`.
6. **Only succeeded answers are judged.** With `partial`, `blocked`, `unknown` (a plain answer whose follow-up gives nothing) and a step-limit best-effort answer, expect 0 judge requests and `unverified`.
7. **`judgeRequest` unit test.**
   - With no pages the text is exactly `Task: Find the Pro price\n\nAnswer: $42\n\nEvidence: none; the agent opened no page.\n\nReply with only JSON: {"reason":"<one sentence>","supported":<probability from 0 to 1 that the answer is supported>}`.
   - With text and a snapshot, both labels appear and refs and cursor hints are removed.
   - With 2,000 filler lines plus one `The Pro plan costs $42 per month.`, the label says `(excerpt; … marks skipped lines)`, the Pro line is kept, and the total stays under about 17k.
8. **`relevantLines` unit test, with a worked expectation.**
   - Build `menu = 200 × '- link "Dyson deals ${i}"'`, and insert after menu line 99 the lines `- heading "Dyson Airwrap Origin Multi Styler" [level=2]`, `- paragraph: Price: 389,430 KRW` and `- paragraph: In stock`.
   - Use the query `Find the lowest Dyson Airwrap price\nThe Dyson Airwrap Origin Multi Styler costs 389,430 KRW.` and `max` 300.
   - The exact result is:
     `…\n- link "Dyson deals 99"\n- heading "Dyson Airwrap Origin Multi Styler" [level=2]\n- paragraph: Price: 389,430 KRW\n- paragraph: In stock\n…`
   - Why: `dyso` appears on 201 lines and is ignored. The heading and price lines score 12, and their neighbors score 4. Menu line 100 scores 0 because its neighbor "In stock" has no hits. The kept lines total 144 characters including the reserve.
   - Also test that a short text comes back unchanged, and that a query with no match returns `text.slice(0, 49) + "…"` for `max` 50.
9. **`parseVerdict` table.**
   - `{"reason":"…","supported":0.05}`, fenced JSON, `Verdict: {"supported": false, "reason": " Wrong price "}` (gives 0 and the trimmed reason), `{"supported":true}` (gives 1) and `0.82` all parse.
   - `undefined`, `""`, prose, `{"supported":1.5}`, `{"supported":"0.3"}`, `{"reason":"x"}`, `null` and `-0.1` all give `undefined`.
10. **MCP in process.** Call `createMcpServer({ session, tools: [readPage(price)], agentModel, judgeModel, agentMaxSteps: 2 })` and then `server.handle(tools/call browser_task)`.
    - For an unsupported verdict expect `isError: true`, `structuredContent.outcome { status: "partial", verification: "judged", judge: { model: "fake-judge" } }` and `judgeUsage`. The text contains `outcome: partial (judged)`, `judge tokens: 100 in / 10 out` and `Unfinished: A check against the page evidence …`.
    - For a supported verdict expect `isError: false` and `(judged)`.
11. **The CLI and MCP front doors over stdio**, with the preload helper and a fake Jev endpoint (`Bun.serve`) that returns `{ model: "jev-1.13.0", answers: { answer: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 296, output_tokens: 20 } }`.
    - The agent is a temporary `--model-module` that answers at once: `The Pro plan costs $42.` with the succeeded line. Copy the pattern in `trailing-outcome.test.ts`.
    - Use `noul` 0.9. With a low value the agent sends the answer back, and the one-reply script then throws, giving `model_error`.
    - The spawn environment is `{ PATH, TYPESAFE_API_KEY: "test-key", OWA_TEST_FETCH_FROM: "https://api.typesafe.ai/v1", OWA_TEST_FETCH_TO: "http://127.0.0.1:<port>/v1" }`.
    - Run `bun --preload src/testing/redirect-fetch.ts src/cli.ts run "Find the Pro price" --json --model-module <tmp> --judge-model typesafe:jev-latest --judge-model-options '{"detail":"low"}' --trace <tmp>`.
    - Expect:
      - Exit code 0, and stderr contains `judge: 0.9`.
      - stdout JSON has `outcome { verification: "judged", judge: { model: "jev-1.13.0", supported: 0.9 } }` and `judgeUsage { inputTokens: 296, outputTokens: 20 }`.
      - The fake endpoint saw path `/v1/systemone`, `authorization: Bearer test-key`, and a body with `questions.answer = { type: "noul", instructions: JUDGE_PROMPT }`, `detail: "low"`, and a `state` containing `Answer: The Pro plan costs $42.`.
      - The trace has a `model` event with `role: "judge"`.
    - For `owa mcp --agent`, set `OWA_JUDGE_MODEL=typesafe:jev-latest` through the environment instead of the flag, so the environment path is covered too.
      - Use `StdioClientTransport({ command: process.execPath, args: ["--preload", <helper>, <cli>, "mcp", "--headless", "--agent", "--model-module", <tmp>], env })`. The `env` you pass replaces the whole environment, so include `PATH`.
      - Expect `browser_task` text containing `(judged)`.

`src/model/adapters.test.ts` (append a `describe`, reusing `recordingFetch`):

- The wire format:
  - The URL is `https://api.typesafe.ai/v1/systemone`.
  - The headers are exactly `{ "content-type": "application/json", authorization: "Bearer k" }`.
  - The body has `state: "Task: t\n\nAnswer: a"` for a user message whose parts are text, image, text. It has the Noul question with `instructions: request.system`, and the extraBody field merged in.
  - The response is exactly `{ text: "0.82", toolCalls: [], model: "jev-1.13.0", usage: { inputTokens: 296, outputTokens: 20 } }`.
- Errors:
  - A request with tools rejects with `only answers yes/no questions`.
  - `{ answers: {} }` rejects with `returned no yes/no answer`.
  - A 401 that echoes the key gives a `ModelHttpError` without the key.

`src/model/resolve.test.ts` (append):

- `resolveModel({ model: "typesafe:jev-latest" }, { TYPESAFE_API_KEY: "k" }).name` is `typesafe-systemone:jev-latest`. Without the key the error mentions `TYPESAFE_API_KEY`.
- `resolveRoleModel`:
  - It returns `undefined` when unset, including when only `OWA_MODEL` and `OPENAI_API_KEY` are set.
  - `OWA_JUDGE_MODEL: "ollama:qwen3:8b"` resolves to `openai-chat:qwen3:8b`.
  - A flag beats the environment, for the model and for the options.
  - Invalid options throw `--judge-model-options / OWA_JUDGE_MODEL_OPTIONS must be a JSON object` without echoing the value, and a reserved key such as `{"tools":[]}` is rejected.

### README

- `## Models`: add a provider-table row: `typesafe` | TypeSafe System One `/v1/systemone`, judge only | `TYPESAFE_API_KEY`.
- Add a new subsection, for example `### Checking answers with a judge model`, covering:
  - The flags and environment variables, with the examples `gemini:gemini-3.1-flash-lite` and `typesafe:jev-latest`.
  - What the judge receives: the task, the answer, and the newest page text and snapshot, cut to the relevant lines within 16k characters.
  - The verdict format, the threshold, the single send-back and the downgrade to `partial`.
  - That failures change nothing, that only `final_answer` runs with a `succeeded` outcome are judged, and that the A/B (#162) is pending.
  - That a custom judge adapter receives one tool-less request and replies with the JSON or a bare probability.
- `## Options` code block: add `--judge-model` and `--judge-model-options`.
- `### Delegated task results`:
  - Add `judgeUsage` to the list of fields.
  - Replace "Every outcome is explicitly `unverified`. There is no independent success judge." with the `unverified` / `judged` description, and mention `outcome.judge`.
- `### Usage and cost`: explain that `judgeUsage` sums the judge's calls with the same rules and is kept out of `usage` because its price differs. Judge calls appear in the trace as `model` events with `role: "judge"`. TypeSafe reports input and output tokens, bills only input, and reports no `cost`.
- Optional: rows for `src/judge.ts` and `src/model/typesafe.ts` in the architecture table of CLAUDE.md. If you change it, change AGENTS.md the same way, since the two files mirror each other.

### Finishing

1. Write the tests and the README changes.
2. Run `bun run typecheck`, then the touched test files, then `bun run test` once. Compare any failures with main as described in Verification above.
3. Delete HANDOFF.md.
4. Make the final commit with the required first line and push.
5. Open the PR with the required body. Do not merge.

## Known test failures and their causes

- Baseline on main `135950e` in the cloud container: `bun run test` gave 195 pass, 4 fail, 1 error (199 tests across 26 files, 104.97 s):
  - `src/limits.test.ts` › "cancels an in-flight browser wait and allows a fresh session afterward": `error: Failed to connect` (`syscall: "connect"`, `code: "ENOENT"`), thrown from `childProcess.spawn` in Playwright's `launchProcess`.
  - `src/limits.test.ts` › "does not leak a browser when cancellation arrives during launch": the same ENOENT.
  - `src/model/options.test.ts` › "model request options › lets CLI options replace even invalid env JSON, and {} clears env options": timed out at 30 s. The test spawns the CLI four times.
  - `src/testing/evaluation.test.ts` › "scores lowest-price answer Dyson Airwrap Origin+: 389,430 KRW as %s": the same ENOENT.
  - One unhandled error between tests: the same ENOENT.
- These come from the container. Browser processes fail to spawn intermittently, and CLAUDE.md warns that browser tests time out intermittently there.
- The SessionStart hook also cannot download Playwright's Chromium v1228 (`cdn.playwright.dev`: "Download failure"). `BrowserSession` falls back to the cached `/opt/pw-browsers/chromium-1194` (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`).
- None of the failing files is touched by this branch, and they are expected to pass on a normal machine.
- The raw baseline log was written to the cloud session's scratchpad and is not in the repository.
- On the branch, after the core change, the eight files that cover the touched paths passed: `src/model/*` (3 files), `usage`, `trailing-outcome`, `best-effort-answer`, `cli` and `empty-response`. That was 69 pass, 0 fail.
- The full suite has not been run on the branch.

## Measurements

- `bun run typecheck` at `fd2828e`: clean.
- `bun test --timeout 30000 src/model src/usage.test.ts src/trailing-outcome.test.ts src/best-effort-answer.test.ts src/cli.test.ts src/empty-response.test.ts` at `fd2828e`: 69 pass, 0 fail, 246 `expect()` calls, 8 files, 3.72 s.
- Runtime source size (all `src/**/*.ts` except `*.test.ts` and `src/testing/`) grew from 2,001 lines on main to 2,246 on the branch, +245.
  - New files: `judge.ts` 91 lines and `typesafe.ts` 51 lines.
  - `agent.ts` +69/−3, `cli.ts` +22/−4, `resolve.ts` +33/−6, `mcp.ts` +6/−2, `index.ts` +1.
  - The README still says "about 1.9k lines", which was already stale at 2.0k on main. positioning.md targets about 1.5k.
- No live measurements were taken; they are not allowed here, and the reviewer runs them in #162.

## Open questions

1. The Jev wire format is unverified (see above). The reviewer should check it against docs.typesafe.ai/api.md.
2. Jev receives `JUDGE_PROMPT` as its Noul instructions. The JSON reply-format line is in the user message, so Jev sees it as one line of noise inside `state`. Removing it for Jev would need the request builder to know the backend.
3. Chat models give poorly calibrated probabilities, and the 0.2 threshold is a guess. The A/B decides. Choice (supported / contradicted / not covered) was the alternative to a single Noul; Noul was picked for simplicity.
4. Leaving out the agent's notes may produce false positives on multi-page answers. The prompt line "a fact it does not mention may come from an earlier page" offsets that, but it also weakens the detection of invented facts. The A/B decides.
5. Should the judge be skipped when the agent opened no page? It currently runs.
6. A judge request that fails is invisible: no trace event, no stderr line. With a wrong key every run silently stays `unverified`. Options: a `model` event with an `error` field, or a CLI stderr line. That would break #161's no-event-on-failure rule.
7. Unparseable replies count in `judgeUsage` and emit a `model` event but change nothing. This seems right; confirm.
8. `outcome.judge.model` mixes the served name with the adapter-name fallback.
9. `judgeUsage` and `role: "judge"` naming: the other roles may add `escalateUsage`, `visionUsage` or a different event field. Reconcile them into one shape, for example a per-role usage map, when merging #163–#166.
10. `resolveRoleModel` may be duplicated by the parallel PRs. Keep one.
11. The missing-key error for `typesafe:` (from `resolveModel`) says "set TYPESAFE_API_KEY or OWA_API_KEY", but `OWA_API_KEY` does not apply to role models.
12. `--judge-model` without `--agent` in `owa mcp` is silently ignored, and `--judge-model-options` without a judge model is neither validated nor reported.
13. Edge cases of the send-back:
    - If the model then replies with nothing, the run ends as `model_error` (`failed`), with the first answer as `partialAnswer`.
    - The deadline can expire during the extra step and give `timeout` instead of the completed (wrong) answer.
    - The send-back uses one step.
14. Best-effort answers at the step limit and stall exits are not judged.
15. Size budget: +245 runtime lines. Consider trimming, and decide whether to update the README's line count. That line will conflict with the parallel PRs, so it may be better left to the orchestrator.
16. Limits of the relevance filter:
    - The 4-character stems miss Korean words with attached particles (에어랩의 vs 에어랩) and CJK text without spaces.
    - A single line longer than the budget is skipped.
    - Without any match, the head of the text is kept.
17. The PR line `Implemented by Claude Code cloud session (claude-opus-5-5, effort max).` came from the original instructions. A local agent now finishes the work, so ask the user what it should say.

## Environment notes

- Cloud egress allowed `gh api` and raw.githubusercontent.com and blocked the documentation sites listed above.
- At hand-off time, the remote branches `feat/163-…`, `feat/165-…` and `feat/166-…` all pointed at `135950e`, so no work had been pushed for them yet.
- `origin/test/162-bench-runner` holds an unmerged benchmark runner, which may later want to pass `judgeModel`.
- `origin/refactor/dynamic-models` is an old, unrelated branch with a `packages/` layout.
