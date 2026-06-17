# Real External Agent Examples Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the model-backed plan-act pattern into project-local `agents/` and make the text-vision mixed grounding agent call the selected runtime model with extracted text plus screenshot image content.

**Architecture:** Keep the current Python one-shot protocol as the default, and add an opt-in `protocol: jsonl` mode for model-backed external agents. The TypeScript adapter handles `model.complete` command envelopes by delegating to the runtime-selected model, so provider config, events, timeouts, and traces remain centralized.

**Tech Stack:** Bun, TypeScript, Zod, Hono runtime tests, Python standard library, OpenAI-compatible chat-completions payloads.

---

### Task 1: Add Model-Capable Python Protocol

**Files:**
- Modify: `packages/core/src/contracts/model.ts`
- Modify: `packages/agents/src/python-agent-adapter.ts`
- Modify: `packages/agents/src/python-agent-manifest.ts`
- Modify: `packages/agents/src/python-agent-adapter.test.ts`
- Modify: `packages/agents/src/python-agent-manifest.test.ts`
- Modify: `packages/models/src/openai-compatible-client.test.ts`
- Test: `bun test packages/agents/src/python-agent-adapter.test.ts packages/agents/src/python-agent-manifest.test.ts packages/models/src/openai-compatible-client.test.ts`

- [ ] **Step 1: Write failing adapter test**

Add a test to `packages/agents/src/python-agent-adapter.test.ts` where a temporary Python script reads the lifecycle request from `stdin.readline()`, writes a `{"command":"model.complete"}` line, reads the adapter response, and returns a `final_answer` containing the model response text. Instantiate `PythonAgentAdapter` with `protocol: "jsonl"` and a fake `ModelPlugin`.

- [ ] **Step 2: Write failing manifest test**

Add a manifest test proving `protocol: jsonl` is parsed and the resulting adapter can execute a script that uses the line protocol.

- [ ] **Step 3: Write failing model content test**

Add a test to `packages/models/src/openai-compatible-client.test.ts` proving a user message with content parts is forwarded unchanged:

```ts
content: [
  { type: "text", text: "Use the screenshot." },
  { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
]
```

- [ ] **Step 4: Verify the new tests fail**

Run:

```bash
bun test packages/agents/src/python-agent-adapter.test.ts packages/agents/src/python-agent-manifest.test.ts packages/models/src/openai-compatible-client.test.ts
```

Expected: FAIL because `protocol`, model command handling, and multimodal content are not implemented.

- [ ] **Step 5: Implement model content contract**

Update `ModelMessageSchema` so `content` accepts either a string or an array of provider-compatible content part objects with a string `type`.

- [ ] **Step 6: Implement adapter `jsonl` protocol**

Add `model?: ModelPlugin` and `protocol?: "oneshot" | "jsonl"` to `PythonAgentAdapterOptions`. Keep the existing one-shot path unchanged for default agents. In the `jsonl` path, write the lifecycle request as one JSON line, parse stdout lines, handle `model.complete` commands by calling `this.model.complete(ModelRequestSchema.parse(command.request), ctx)`, write command responses to child stdin, and parse the final lifecycle response line exactly as today.

- [ ] **Step 7: Implement manifest parsing**

Add optional `protocol` to `PythonAgentManifestSchema`, pass it into `PythonAgentAdapter`, and extend `LoadPythonAgentManifestOptions` with `model?: ModelPlugin`.

- [ ] **Step 8: Verify task tests pass**

Run:

```bash
bun test packages/agents/src/python-agent-adapter.test.ts packages/agents/src/python-agent-manifest.test.ts packages/models/src/openai-compatible-client.test.ts
```

Expected: PASS.

### Task 2: Wire Runtime Model Into External Agents

**Files:**
- Modify: `packages/server/src/default-runtime.ts`
- Modify: `packages/server/src/default-runtime.test.ts`
- Test: `bun test packages/server/src/default-runtime.test.ts`

- [ ] **Step 1: Write failing runtime test**

Add a default runtime test that starts with a project-local `agents` directory containing a `protocol: jsonl` Python agent. Stub `globalThis.fetch` for provider calls, run the agent with `modelId: "openai"`, and assert a `model.called` event is emitted and the final answer comes from the fake provider response.

- [ ] **Step 2: Verify the runtime test fails**

Run:

```bash
bun test packages/server/src/default-runtime.test.ts
```

Expected: FAIL because loaded Python agents do not receive the runtime-selected model.

- [ ] **Step 3: Pass selected model into manifest loading**

In `startDefaultRuntime`, construct `RuntimeSelectedModel` before loading Python manifests and call `loadPythonAgentManifests(..., { model: selectedModel })`.

- [ ] **Step 4: Verify runtime test passes**

Run:

```bash
bun test packages/server/src/default-runtime.test.ts
```

Expected: PASS.

### Task 3: Add External Plan-Act Agent

**Files:**
- Create: `agents/_common/__init__.py`
- Create: `agents/_common/protocol.py`
- Create: `agents/plan-act/agent.yaml`
- Create: `agents/plan-act/main.py`
- Modify: `packages/server/src/default-runtime.test.ts`
- Test: `bun test packages/server/src/default-runtime.test.ts`

- [ ] **Step 1: Write failing registration/behavior test**

Add a test that starts the default runtime with `agentsDir` pointing at the repository `agents` directory, asserts `/plugins` contains `plan-act`, runs `agentId: "plan-act"` with a fake OpenAI response sequence for plan JSON then final-answer JSON, and asserts `plan.created` plus `run.completed` are emitted.

- [ ] **Step 2: Verify the test fails**

Run:

```bash
bun test packages/server/src/default-runtime.test.ts
```

Expected: FAIL because `agents/plan-act` does not exist.

- [ ] **Step 3: Add shared Python protocol helpers**

Create `agents/_common/protocol.py` with functions to read the lifecycle request, send a model command, read command response lines, emit final lifecycle JSON, format observations, parse JSON objects, and normalize common model tool-call aliases.

- [ ] **Step 4: Add `agents/plan-act` manifest and implementation**

Create `agents/plan-act/agent.yaml` with `language: python`, `entry: main.py`, and `protocol: jsonl`. Implement `main.py` to mirror the built-in plan-act flow: initialize returns `ok`, finalize returns `state.finalAnswer`, and step creates/updates a plan before asking the model for an `AgentDecision`.

- [ ] **Step 5: Verify runtime test passes**

Run:

```bash
bun test packages/server/src/default-runtime.test.ts
```

Expected: PASS.

### Task 4: Make Text-Vision Mixed Grounding Real

**Files:**
- Modify: `agents/text-vision-mixed-grounding/agent.yaml`
- Modify: `agents/text-vision-mixed-grounding/main.py`
- Modify: `packages/server/src/default-runtime.test.ts`
- Modify: `README.md`
- Test: `bun test packages/server/src/default-runtime.test.ts packages/cli/src/commands/run.test.ts`

- [ ] **Step 1: Write failing mixed-grounding model test**

Add a default runtime test that runs `text-vision-mixed-grounding` against `mock-browser` with a fake provider response. Assert the provider request includes a user message content array with one `text` part and one `image_url` part, and assert the run final answer is the fake provider text.

- [ ] **Step 2: Verify the mixed-grounding test fails**

Run:

```bash
bun test packages/server/src/default-runtime.test.ts
```

Expected: FAIL because the existing agent never sends a model command.

- [ ] **Step 3: Update manifest and implementation**

Set `protocol: jsonl` in `agents/text-vision-mixed-grounding/agent.yaml`. Update `main.py` so it navigates to a URL/domain found in the prompt, captures screenshot and text when missing, reads the screenshot artifact, builds a data URL, calls `model.complete` with multimodal message content, and returns the model text as `final_answer`.

- [ ] **Step 4: Update README**

Adjust the agent example docs to explain that model-backed external agents require an OpenAI/OpenRouter key and can be paired with `/browser playwright-browser` in the TUI for real screenshots.

- [ ] **Step 5: Verify targeted tests pass**

Run:

```bash
bun test packages/server/src/default-runtime.test.ts packages/cli/src/commands/run.test.ts
```

Expected: PASS.

### Task 5: Final Verification, Commit, Push, PR

**Files:**
- All changed files.

- [ ] **Step 1: Run full verification**

Run:

```bash
bun run typecheck
bun test
```

Expected: PASS.

- [ ] **Step 2: Review diff**

Run:

```bash
git diff --stat
git diff --check
git status --short
```

Expected: no whitespace errors and only intended files changed.

- [ ] **Step 3: Commit**

Commit with:

```bash
git add .
git commit -m "[feat] add real external agent examples"
```

- [ ] **Step 4: Push and create PR**

Run:

```bash
git push -u origin feat/agent-examples-real-grounding
gh pr create --title "[feat] add real external agent examples" --body "$(cat <<'EOF'
## Summary
- add jsonl Python agent protocol support for runtime model delegation
- add project-local plan-act and real text-vision mixed grounding agents
- allow multimodal model messages to flow through OpenAI-compatible providers

## Test Plan
- bun run typecheck
- bun test
EOF
)"
```
