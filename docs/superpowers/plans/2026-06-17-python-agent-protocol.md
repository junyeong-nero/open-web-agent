# Python Agent Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add language-neutral Python agent support and ship a text-vision mixed grounding browser-only example agent.

**Architecture:** Keep the TypeScript runtime in charge of orchestration, browser execution, events, storage, cancellation, and schema validation. Python agents are external processes that receive one JSON request on stdin and return one JSON response on stdout; a TypeScript `PythonAgentAdapter` implements the existing `AgentPlugin` interface.

**Tech Stack:** Bun, TypeScript, Zod, Node child processes, YAML manifests, Python standard library.

---

### Task 1: Python Agent Adapter

**Files:**
- Create: `packages/agents/src/python-agent-adapter.ts`
- Test: `packages/agents/src/python-agent-adapter.test.ts`
- Modify: `packages/agents/src/index.ts`

- [ ] **Step 1: Write failing tests**

Add tests that create temporary Python scripts and assert:
- `initialize` sends an `initialize` request.
- `step` sends serializable agent state and parses an `AgentDecision`.
- stderr is included when the Python process exits non-zero.
- invalid JSON stdout fails with a clear error.
- aborting the runtime signal terminates the subprocess.

- [ ] **Step 2: Verify tests fail**

Run: `bun test packages/agents/src/python-agent-adapter.test.ts`

Expected: FAIL because `python-agent-adapter.ts` does not exist.

- [ ] **Step 3: Implement the adapter**

Implement `PythonAgentAdapter implements AgentPlugin` with options:

```ts
export interface PythonAgentAdapterOptions {
  id: string
  name: string
  description: string
  command: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}
```

Each lifecycle method calls the configured command with one JSON envelope on stdin and validates stdout using the existing `AgentDecisionSchema` for `step`.

- [ ] **Step 4: Verify adapter tests pass**

Run: `bun test packages/agents/src/python-agent-adapter.test.ts`

Expected: PASS.

### Task 2: Manifest Discovery

**Files:**
- Create: `packages/agents/src/python-agent-manifest.ts`
- Test: `packages/agents/src/python-agent-manifest.test.ts`
- Modify: `packages/agents/src/index.ts`

- [ ] **Step 1: Write failing tests**

Add tests that assert:
- A YAML manifest with `language: python` loads into a `PythonAgentAdapter`.
- `entry` resolves relative to the manifest directory.
- `command` may override the default command.
- Non-Python manifests are rejected with a useful error.
- Missing directories return an empty agent list.

- [ ] **Step 2: Verify tests fail**

Run: `bun test packages/agents/src/python-agent-manifest.test.ts`

Expected: FAIL because `python-agent-manifest.ts` does not exist.

- [ ] **Step 3: Implement manifest loading**

Support manifests named `agent.yaml` under child directories. Default command:

```text
python3 <entry>
```

The loader returns `PythonAgentAdapter[]`.

- [ ] **Step 4: Verify manifest tests pass**

Run: `bun test packages/agents/src/python-agent-manifest.test.ts`

Expected: PASS.

### Task 3: Default Runtime Registration

**Files:**
- Modify: `packages/server/src/default-runtime.ts`
- Test: `packages/server/src/default-runtime.test.ts`

- [ ] **Step 1: Write failing tests**

Add a test that creates an agents directory in a temp home, writes a Python manifest/script, starts the default runtime with that directory, and asserts `/plugins` lists the Python agent.

- [ ] **Step 2: Verify test fails**

Run: `bun test packages/server/src/default-runtime.test.ts`

Expected: FAIL because the default runtime does not scan Python agent manifests.

- [ ] **Step 3: Implement runtime registration**

Add `agentsDir?: string` to `StartDefaultRuntimeOptions`, defaulting to `<home>/agents`, and register agents returned by `loadPythonAgentManifests`.

- [ ] **Step 4: Verify default runtime tests pass**

Run: `bun test packages/server/src/default-runtime.test.ts`

Expected: PASS.

### Task 4: Mixed Grounding Example

**Files:**
- Create: `agents/text-vision-mixed-grounding/agent.yaml`
- Create: `agents/text-vision-mixed-grounding/main.py`
- Test: `packages/cli/src/commands/run.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing smoke test**

Add a CLI or runtime test that selects `text-vision-mixed-grounding`, runs against the mock browser, and asserts the final answer mentions both text and screenshot grounding.

- [ ] **Step 2: Verify smoke test fails**

Run: `bun test packages/cli/src/commands/run.test.ts`

Expected: FAIL because the example agent is not registered.

- [ ] **Step 3: Implement example**

The Python agent reads `lastObservation.text` and `lastObservation.screenshotPath`, emits only `browser_actions` or `final_answer`, and never executes browser tools directly.

- [ ] **Step 4: Verify smoke test passes**

Run: `bun test packages/cli/src/commands/run.test.ts`

Expected: PASS.

### Task 5: Final Verification and PR

**Files:**
- All changed files.

- [ ] Run `bun test`.
- [ ] Run `bun run typecheck`.
- [ ] Review `git diff`.
- [ ] Commit logical changes.
- [ ] Push `feat/python-agent-protocol`.
- [ ] Open a GitHub PR with verification evidence.
