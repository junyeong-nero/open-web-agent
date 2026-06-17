# Phase 1: Core Contracts And Event Bus

[Back to plan index](../plan.md)

## Phase Summary

Goal: lock runtime data boundaries before server/TUI work.

Implement:

```text
packages/core/src/contracts/*
packages/core/src/events/event-bus.ts
packages/core/src/storage/jsonl-event-store.ts
packages/core/src/storage/paths.ts
packages/core/src/ids/ids.ts
```

Verification:

```bash
bun test packages/core
bun run typecheck
```

Expected result:

```text
RunEvent schema accepts valid events and rejects invalid event types.
EventBus publishes to multiple subscribers in order.
JsonlEventStore appends one JSON event per line.
```

## Sprint 1 Detailed Tasks

### Task 2: Core Schemas

**Files:**

```text
Create: packages/core/src/contracts/event.ts
Create: packages/core/src/contracts/browser.ts
Create: packages/core/src/contracts/agent.ts
Create: packages/core/src/contracts/model.ts
Create: packages/core/src/contracts/plugin.ts
Modify: packages/core/src/index.ts
Create: packages/core/src/contracts/event.test.ts
Create: packages/core/src/contracts/browser.test.ts
Create: packages/core/src/contracts/agent.test.ts
```

- [ ] Add the schemas from Section 5.

- [ ] Export contracts from `packages/core/src/index.ts`.

```ts
export * from "./contracts/event"
export * from "./contracts/browser"
export * from "./contracts/agent"
export * from "./contracts/model"
export * from "./contracts/plugin"
```

- [ ] Add tests for valid and invalid `RunEvent`.

```ts
import { describe, expect, it } from "bun:test"
import { RunEventSchema } from "./event"

describe("RunEventSchema", () => {
  it("accepts a valid run event", () => {
    const parsed = RunEventSchema.parse({
      id: "evt_1",
      runId: "run_1",
      sessionId: "ses_1",
      stepId: null,
      sequence: 0,
      type: "run.started",
      payload: {},
      createdAt: "2026-06-17T00:00:00.000Z"
    })

    expect(parsed.type).toBe("run.started")
  })

  it("rejects an unknown event type", () => {
    expect(() =>
      RunEventSchema.parse({
        id: "evt_1",
        runId: "run_1",
        sessionId: "ses_1",
        stepId: null,
        sequence: 0,
        type: "run.unknown",
        payload: {},
        createdAt: "2026-06-17T00:00:00.000Z"
      })
    ).toThrow()
  })
})
```

- [ ] Add tests for `BrowserActionSchema` requiring at least one tool call.

```ts
import { describe, expect, it } from "bun:test"
import { BrowserActionSchema } from "./browser"

describe("BrowserActionSchema", () => {
  it("accepts a browser action with nested tool calls", () => {
    const parsed = BrowserActionSchema.parse({
      id: "action_1",
      kind: "inspect_page_title",
      reason: "Need to open the page before reading title.",
      requiresApproval: false,
      toolCalls: [{ id: "tool_1", type: "navigate", url: "https://example.com" }]
    })

    expect(parsed.toolCalls[0]?.type).toBe("navigate")
  })

  it("rejects a browser action with no tool calls", () => {
    expect(() =>
      BrowserActionSchema.parse({
        id: "action_1",
        kind: "empty",
        reason: null,
        requiresApproval: false,
        toolCalls: []
      })
    ).toThrow()
  })
})
```

- [ ] Add tests for `AgentDecisionSchema`.

```ts
import { describe, expect, it } from "bun:test"
import { AgentDecisionSchema } from "./agent"

describe("AgentDecisionSchema", () => {
  it("accepts browser_actions decisions", () => {
    const parsed = AgentDecisionSchema.parse({
      type: "browser_actions",
      thought: "Open the target page.",
      actions: [
        {
          id: "action_1",
          kind: "inspect_page_title",
          reason: null,
          requiresApproval: false,
          toolCalls: [{ id: "tool_1", type: "navigate", url: "https://example.com" }]
        }
      ]
    })

    expect(parsed.type).toBe("browser_actions")
  })

  it("does not accept top-level tool_calls decisions", () => {
    expect(() =>
      AgentDecisionSchema.parse({
        type: "tool_calls",
        thought: null,
        toolCalls: []
      })
    ).toThrow()
  })
})
```

- [ ] Run verification.

```bash
bun test packages/core/src/contracts
bun run typecheck
```

Expected:

```text
All contract tests pass.
No TypeScript errors.
```

- [ ] Commit.

```bash
git add packages/core
git commit -m "[add] define core runtime contracts"
```

### Task 3: Event Bus And JSONL Store

**Files:**

```text
Create: packages/core/src/events/event-bus.ts
Create: packages/core/src/events/event-bus.test.ts
Create: packages/core/src/storage/jsonl-event-store.ts
Create: packages/core/src/storage/jsonl-event-store.test.ts
Create: packages/core/src/storage/paths.ts
Modify: packages/core/src/index.ts
```

- [ ] Implement `EventBus`.

Required behavior:

```text
subscribe(handler) returns unsubscribe()
publish(event) sends event to active subscribers in publish order
unsubscribe() prevents later events
```

Use this implementation shape:

```ts
import type { RunEvent } from "../contracts/event"

export type EventHandler = (event: RunEvent) => void | Promise<void>

export class EventBus {
  private handlers = new Set<EventHandler>()

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  async publish(event: RunEvent): Promise<void> {
    for (const handler of [...this.handlers]) {
      await handler(event)
    }
  }
}
```

- [ ] Implement `JsonlEventStore`.

Required behavior:

```text
append(event) creates parent directory when needed
append(event) writes exactly JSON.stringify(event) + "\n"
readAll() parses each non-empty line as RunEvent
```

Use this implementation shape:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { RunEventSchema, type RunEvent } from "../contracts/event"

export class JsonlEventStore {
  constructor(private readonly filePath: string) {}

  async append(event: RunEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(event)}\n`, { flag: "a" })
  }

  async readAll(): Promise<RunEvent[]> {
    const text = await readFile(this.filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })

    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => RunEventSchema.parse(JSON.parse(line)))
  }
}
```

- [ ] Implement storage path helper.

Required behavior:

```text
resolveOwaHome() uses process.env.OWA_HOME when set.
resolveOwaHome() otherwise uses ~/.open-web-agent.
runPath(home, projectHash, sessionId, runId) returns the run directory.
```

Use this implementation shape:

```ts
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export function resolveOwaHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OWA_HOME && env.OWA_HOME.length > 0 ? env.OWA_HOME : join(homedir(), ".open-web-agent")
}

export function hashProjectPath(projectPath: string): string {
  return createHash("sha256").update(resolve(projectPath)).digest("hex")
}

export function sessionPath(home: string, projectHash: string, sessionId: string): string {
  return join(home, "projects", projectHash, "sessions", sessionId)
}

export function runPath(home: string, projectHash: string, sessionId: string, runId: string): string {
  return join(sessionPath(home, projectHash, sessionId), "runs", runId)
}

export function eventsPath(home: string, projectHash: string, sessionId: string, runId: string): string {
  return join(runPath(home, projectHash, sessionId, runId), "events.jsonl")
}
```

- [ ] Add tests.

Test names:

```text
EventBus publishes events to multiple subscribers in order
EventBus unsubscribe stops future delivery
JsonlEventStore appends and reads run events
resolveOwaHome prefers OWA_HOME
hashProjectPath hashes the absolute path with SHA-256
```

Add the SHA-256 test exactly enough to lock behavior:

```ts
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { hashProjectPath } from "./paths"

describe("hashProjectPath", () => {
  it("hashes the absolute path with SHA-256", () => {
    const input = "."
    const expected = createHash("sha256").update(resolve(input)).digest("hex")

    expect(hashProjectPath(input)).toBe(expected)
    expect(hashProjectPath(input)).toHaveLength(64)
  })
})
```

- [ ] Run verification.

```bash
bun test packages/core/src/events packages/core/src/storage
bun run typecheck
```

Expected:

```text
All event/storage tests pass.
No test writes outside its temporary OWA_HOME.
```

- [ ] Commit.

```bash
git add packages/core
git commit -m "[add] implement event bus and JSONL traces"
```
