# OpenCode TUI Compatibility Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a selectable OpenCode TUI client path that can talk to the existing OWA runtime through an OpenCode SDK v2 compatibility API while preserving the native OWA TUI.

**Architecture:** Keep OWA core contracts, server routes, and orchestration as the source of truth. Add a small `@open-web-agent/opencode-compat` package for OpenCode-shaped projections, mount `/opencode/*` routes in `@open-web-agent/server`, and add CLI selection between the existing TUI and an OpenCode TUI launcher package. The first working milestone covers local bootstrap, session list/create/get, prompt submission, live event projection, and explicit unsupported responses for UI actions outside the milestone.

**Tech Stack:** Bun workspaces, TypeScript, Hono, Zod, OpenTUI/Solid, existing OWA `EventBus`, `RunOrchestrator`, `SQLiteStore`, and OpenCode TUI source from `anomalyco/opencode` branch `dev`.

---

## File Structure

- Create `packages/opencode-compat/package.json`: workspace package manifest for pure compatibility helpers.
- Create `packages/opencode-compat/tsconfig.json`: package TypeScript project reference.
- Create `packages/opencode-compat/src/index.ts`: public exports.
- Create `packages/opencode-compat/src/types.ts`: OpenCode-shaped local protocol types used by routes and tests.
- Create `packages/opencode-compat/src/projections.ts`: plugin, provider, agent, session, message, and model selection projection helpers.
- Create `packages/opencode-compat/src/projections.test.ts`: focused tests for projection behavior.
- Create `packages/opencode-compat/src/events.ts`: OWA `RunEvent` to OpenCode global event projection.
- Create `packages/opencode-compat/src/events.test.ts`: event projection tests.
- Modify `tsconfig.json`: add a root project reference for `packages/opencode-compat`.
- Modify `packages/server/package.json`: depend on `@open-web-agent/opencode-compat`.
- Create `packages/server/src/routes/opencode.ts`: `/opencode/*` Hono route registration.
- Modify `packages/server/src/app.ts`: register the OpenCode compatibility routes with the same runtime dependencies as existing OWA routes.
- Modify `packages/server/src/app.test.ts`: cover bootstrap endpoints, prompt submission, and event stream projection.
- Create `packages/server/src/run-submission.ts`: shared run submission helper used by OWA `/runs` and OpenCode `/session/:id/message`.
- Modify `packages/server/src/routes/runs.ts`: delegate run creation to `run-submission.ts`.
- Create `packages/opencode-tui/package.json`: launcher package for the OpenCode TUI integration.
- Create `packages/opencode-tui/tsconfig.json`: package TypeScript project reference.
- Create `packages/opencode-tui/src/index.ts`: `launchOpenCodeTui` public entrypoint.
- Modify `package.json`: add workspace dependencies required by `packages/opencode-tui` only after the OpenCode source is vendored.
- Modify `tsconfig.json`: add a root project reference for `packages/opencode-tui`.
- Modify `packages/cli/package.json`: depend on `@open-web-agent/opencode-tui`.
- Modify `packages/cli/src/args.ts`: parse `--tui owa|opencode` for interactive modes.
- Modify `packages/cli/src/args.test.ts`: cover TUI selector parsing.
- Modify `packages/cli/src/commands/default.ts`: launch selected TUI against the in-process server.
- Modify `packages/cli/src/commands/connect.ts`: launch selected TUI against an existing server.
- Modify `packages/cli/src/index.ts`: pass parsed TUI selection into commands.

## Task 1: Add the Compatibility Package Skeleton

**Files:**
- Create: `packages/opencode-compat/package.json`
- Create: `packages/opencode-compat/tsconfig.json`
- Create: `packages/opencode-compat/src/index.ts`
- Create: `packages/opencode-compat/src/types.ts`
- Modify: `tsconfig.json`
- Modify: `packages/server/package.json`

- [ ] **Step 1: Write the package manifest**

Create `packages/opencode-compat/package.json`:

```json
{
  "name": "@open-web-agent/opencode-compat",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@open-web-agent/core": "workspace:*",
    "@open-web-agent/storage": "workspace:*"
  }
}
```

- [ ] **Step 2: Write the package tsconfig**

Create `packages/opencode-compat/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../core" }, { "path": "../storage" }]
}
```

- [ ] **Step 3: Add the root project reference**

Modify the root `tsconfig.json` references so `opencode-compat` is checked before `server`:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/core" },
    { "path": "./packages/browser" },
    { "path": "./packages/agents" },
    { "path": "./packages/models" },
    { "path": "./packages/storage" },
    { "path": "./packages/eval" },
    { "path": "./packages/opencode-compat" },
    { "path": "./packages/server" },
    { "path": "./packages/tui" },
    { "path": "./packages/cli" }
  ]
}
```

- [ ] **Step 4: Add server dependency**

Modify `packages/server/package.json` dependencies:

```json
{
  "dependencies": {
    "@open-web-agent/agents": "workspace:*",
    "@open-web-agent/browser": "workspace:*",
    "@open-web-agent/core": "workspace:*",
    "@open-web-agent/models": "workspace:*",
    "@open-web-agent/opencode-compat": "workspace:*",
    "@open-web-agent/storage": "workspace:*",
    "hono": "4.12.25",
    "zod": "4.4.3"
  }
}
```

- [ ] **Step 5: Add the initial public types**

Create `packages/opencode-compat/src/types.ts`:

```ts
export interface OpenCodeModel {
  id: string
  name: string
  limit: {
    context: number
  }
  capabilities: {
    reasoning: boolean
  }
}

export interface OpenCodeProvider {
  id: string
  name: string
  source: "env" | "config" | "custom" | "api"
  env: string[]
  options: Record<string, unknown>
  models: Record<string, OpenCodeModel>
}

export interface OpenCodeProviderConfig {
  providers: OpenCodeProvider[]
  default: Record<string, string>
}

export interface OpenCodeProviderList {
  all: OpenCodeProvider[]
  default: Record<string, string>
  connected: string[]
}

export interface OpenCodeAgent {
  name: string
  description?: string
  mode: "subagent" | "primary" | "all"
  native?: boolean
  hidden?: boolean
  permission: []
  options: Record<string, unknown>
  model?: {
    providerID: string
    modelID: string
  }
}

export interface OpenCodeSession {
  id: string
  slug: string
  projectID: string
  directory: string
  title: string
  agent?: string
  model?: {
    id: string
    providerID: string
  }
  version: string
  time: {
    created: number
    updated: number
  }
}

export interface OpenCodeTextPart {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
  synthetic?: boolean
  time?: {
    start: number
    end?: number
  }
  metadata?: Record<string, unknown>
}

export interface OpenCodeUserMessage {
  id: string
  sessionID: string
  role: "user"
  time: {
    created: number
  }
  agent: string
  model: {
    providerID: string
    modelID: string
  }
}

export interface OpenCodeAssistantMessage {
  id: string
  sessionID: string
  role: "assistant"
  time: {
    created: number
    completed?: number
  }
  parentID: string
  modelID: string
  providerID: string
  mode: string
  agent: string
  path: {
    cwd: string
    root: string
  }
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
}

export type OpenCodeMessage = OpenCodeUserMessage | OpenCodeAssistantMessage

export interface OpenCodeMessageBundle {
  info: OpenCodeMessage
  parts: OpenCodeTextPart[]
}

export interface OpenCodeEvent {
  id: string
  type:
    | "session.updated"
    | "session.status"
    | "message.updated"
    | "message.part.updated"
  properties: Record<string, unknown>
}

export interface OpenCodeGlobalEvent {
  directory: string
  workspace?: string
  payload: OpenCodeEvent
}
```

- [ ] **Step 6: Export the package surface**

Create `packages/opencode-compat/src/index.ts`:

```ts
export type {
  OpenCodeAgent,
  OpenCodeAssistantMessage,
  OpenCodeEvent,
  OpenCodeGlobalEvent,
  OpenCodeMessage,
  OpenCodeMessageBundle,
  OpenCodeModel,
  OpenCodeProvider,
  OpenCodeProviderConfig,
  OpenCodeProviderList,
  OpenCodeSession,
  OpenCodeTextPart,
  OpenCodeUserMessage,
} from "./types"
```

- [ ] **Step 7: Verify the skeleton**

Run:

```bash
bun run typecheck
```

Expected: PASS. The new package is included in the TypeScript build and has no emitted runtime errors.

- [ ] **Step 8: Commit Task 1**

```bash
git add tsconfig.json packages/server/package.json packages/opencode-compat
git commit -m "[add] create opencode compat package"
```

## Task 2: Add Provider, Agent, Session, And Message Projections

**Files:**
- Create: `packages/opencode-compat/src/projections.ts`
- Create: `packages/opencode-compat/src/projections.test.ts`
- Modify: `packages/opencode-compat/src/index.ts`

- [ ] **Step 1: Write projection tests**

Create `packages/opencode-compat/src/projections.test.ts`:

```ts
import { describe, expect, it } from "bun:test"
import type { AgentPlugin, ModelPlugin, SessionState } from "@open-web-agent/core"
import type { StoredMessage, StoredSession } from "@open-web-agent/storage"
import {
  projectAgents,
  projectMessages,
  projectProviderConfig,
  projectProviderList,
  projectSession,
  resolveModelId,
} from "./projections"

const agents: AgentPlugin[] = [
  {
    id: "see-act",
    name: "SeeAct",
    description: "Visual browser agent",
    initialize: async () => {},
    step: async () => ({ type: "final_answer", thought: null, finalAnswer: "done", confidence: 1 }),
    finalize: async () => "done",
  },
  {
    id: "simple-react-agent",
    name: "Simple ReAct",
    description: "Text browser agent",
    initialize: async () => {},
    step: async () => ({ type: "final_answer", thought: null, finalAnswer: "done", confidence: 1 }),
    finalize: async () => "done",
  },
]

const models: ModelPlugin[] = [
  {
    id: "openai:gpt-5.5",
    name: "OpenAI",
    provider: "openai",
    modelName: "gpt-5.5",
    reasoningEffort: "medium",
    contextWindowTokens: 1_000_000,
    complete: async () => ({ id: "resp", text: "ok", toolCalls: [] }),
  },
  {
    id: "openrouter:anthropic/claude-sonnet-4.6",
    name: "OpenRouter",
    provider: "openrouter",
    modelName: "anthropic/claude-sonnet-4.6",
    contextWindowTokens: 200_000,
    complete: async () => ({ id: "resp", text: "ok", toolCalls: [] }),
  },
]

describe("opencode projections", () => {
  it("groups OWA models into OpenCode providers", () => {
    expect(projectProviderConfig(models, "openai:gpt-5.5")).toEqual({
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          source: "env",
          env: [],
          options: {},
          models: {
            "openai:gpt-5.5": {
              id: "openai:gpt-5.5",
              name: "gpt-5.5",
              limit: { context: 1_000_000 },
              capabilities: { reasoning: true },
            },
          },
        },
        {
          id: "openrouter",
          name: "OpenRouter",
          source: "env",
          env: [],
          options: {},
          models: {
            "openrouter:anthropic/claude-sonnet-4.6": {
              id: "openrouter:anthropic/claude-sonnet-4.6",
              name: "anthropic/claude-sonnet-4.6",
              limit: { context: 200_000 },
              capabilities: { reasoning: false },
            },
          },
        },
      ],
      default: {
        openai: "openai:gpt-5.5",
        openrouter: "openrouter:anthropic/claude-sonnet-4.6",
      },
    })
  })

  it("builds the provider list shape expected by OpenCode TUI", () => {
    expect(projectProviderList(models, "openai:gpt-5.5")).toMatchObject({
      default: { openai: "openai:gpt-5.5" },
      connected: ["openai", "openrouter"],
    })
  })

  it("resolves OpenCode provider/model selections to OWA model ids", () => {
    expect(resolveModelId(models, { providerID: "openrouter", modelID: "openrouter:anthropic/claude-sonnet-4.6" })).toBe(
      "openrouter:anthropic/claude-sonnet-4.6",
    )
    expect(resolveModelId(models, { providerID: "openai", modelID: "missing" }, "openai:gpt-5.5")).toBe("openai:gpt-5.5")
  })

  it("projects agents as visible primary OpenCode agents", () => {
    expect(projectAgents(agents, "see-act")).toEqual([
      {
        name: "see-act",
        description: "Visual browser agent",
        mode: "primary",
        native: true,
        hidden: false,
        permission: [],
        options: {},
      },
      {
        name: "simple-react-agent",
        description: "Text browser agent",
        mode: "primary",
        native: true,
        hidden: false,
        permission: [],
        options: {},
      },
    ])
  })

  it("projects OWA sessions into OpenCode session objects", () => {
    const session: StoredSession = {
      id: "ses_123",
      projectPath: "/work/open-web-agent",
      projectHash: "hash",
      environmentId: "playwright-browser",
      title: "Example title",
      pinned: false,
      deletedAt: null,
      createdAt: "2026-06-27T00:00:00.000Z",
    }

    expect(projectSession(session, { defaultAgentId: "see-act", defaultModelId: "openai:gpt-5.5" })).toEqual({
      id: "ses_123",
      slug: "ses_123",
      projectID: "hash",
      directory: "/work/open-web-agent",
      title: "Example title",
      agent: "see-act",
      model: { id: "openai:gpt-5.5", providerID: "openai" },
      version: "owa",
      time: {
        created: Date.parse("2026-06-27T00:00:00.000Z"),
        updated: Date.parse("2026-06-27T00:00:00.000Z"),
      },
    })
  })

  it("projects stored user and assistant messages into OpenCode message bundles", () => {
    const session: SessionState = {
      id: "ses_123",
      projectPath: "/work/open-web-agent",
      projectHash: "hash",
      environmentId: "playwright-browser",
      title: null,
      pinned: false,
      deletedAt: null,
      createdAt: "2026-06-27T00:00:00.000Z",
    }
    const messages: StoredMessage[] = [
      {
        id: "msg_user",
        sessionId: "ses_123",
        role: "user",
        content: "Open example.com",
        createdAt: "2026-06-27T00:00:01.000Z",
      },
      {
        id: "msg_assistant",
        sessionId: "ses_123",
        role: "assistant",
        content: "Example Domain",
        createdAt: "2026-06-27T00:00:02.000Z",
      },
    ]

    expect(projectMessages(session, messages, { defaultAgentId: "see-act", defaultModelId: "openai:gpt-5.5" })).toEqual([
      {
        info: {
          id: "msg_user",
          sessionID: "ses_123",
          role: "user",
          time: { created: Date.parse("2026-06-27T00:00:01.000Z") },
          agent: "see-act",
          model: { providerID: "openai", modelID: "openai:gpt-5.5" },
        },
        parts: [
          {
            id: "part_msg_user_text",
            sessionID: "ses_123",
            messageID: "msg_user",
            type: "text",
            text: "Open example.com",
            time: { start: Date.parse("2026-06-27T00:00:01.000Z"), end: Date.parse("2026-06-27T00:00:01.000Z") },
          },
        ],
      },
      {
        info: {
          id: "msg_assistant",
          sessionID: "ses_123",
          role: "assistant",
          parentID: "msg_user",
          time: {
            created: Date.parse("2026-06-27T00:00:02.000Z"),
            completed: Date.parse("2026-06-27T00:00:02.000Z"),
          },
          modelID: "openai:gpt-5.5",
          providerID: "openai",
          mode: "build",
          agent: "see-act",
          path: { cwd: "/work/open-web-agent", root: "/work/open-web-agent" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: "part_msg_assistant_text",
            sessionID: "ses_123",
            messageID: "msg_assistant",
            type: "text",
            text: "Example Domain",
            time: { start: Date.parse("2026-06-27T00:00:02.000Z"), end: Date.parse("2026-06-27T00:00:02.000Z") },
          },
        ],
      },
    ])
  })
})
```

- [ ] **Step 2: Run the projection tests and verify they fail**

Run:

```bash
bun test packages/opencode-compat/src/projections.test.ts
```

Expected: FAIL with module resolution errors for `./projections`.

- [ ] **Step 3: Implement projections**

Create `packages/opencode-compat/src/projections.ts`:

```ts
import type { AgentPlugin, ModelPlugin, SessionState } from "@open-web-agent/core"
import type { StoredMessage, StoredSession } from "@open-web-agent/storage"
import type {
  OpenCodeAgent,
  OpenCodeAssistantMessage,
  OpenCodeMessageBundle,
  OpenCodeProvider,
  OpenCodeProviderConfig,
  OpenCodeProviderList,
  OpenCodeSession,
  OpenCodeUserMessage,
} from "./types"

export interface ProjectionDefaults {
  defaultAgentId?: string | null
  defaultModelId?: string | null
}

export interface OpenCodeModelSelection {
  providerID: string
  modelID?: string
  id?: string
}

export function projectProviderConfig(models: ModelPlugin[], defaultModelId?: string | null): OpenCodeProviderConfig {
  const providers = groupProviders(models)
  return {
    providers,
    default: Object.fromEntries(
      providers.flatMap((provider) => {
        const preferred = defaultModelId && provider.models[defaultModelId] ? defaultModelId : Object.keys(provider.models)[0]
        return preferred ? [[provider.id, preferred]] : []
      }),
    ),
  }
}

export function projectProviderList(models: ModelPlugin[], defaultModelId?: string | null): OpenCodeProviderList {
  const config = projectProviderConfig(models, defaultModelId)
  return {
    all: config.providers,
    default: config.default,
    connected: config.providers.map((provider) => provider.id),
  }
}

export function resolveModelId(
  models: ModelPlugin[],
  selection: OpenCodeModelSelection | undefined,
  fallbackModelId?: string | null,
): string | undefined {
  if (selection) {
    const requested = selection.modelID ?? selection.id
    const match = models.find((model) => model.provider === selection.providerID && model.id === requested)
    if (match) return match.id
  }
  if (fallbackModelId && models.some((model) => model.id === fallbackModelId)) return fallbackModelId
  return models[0]?.id
}

export function projectAgents(agents: AgentPlugin[], defaultAgentId?: string | null): OpenCodeAgent[] {
  return orderById(agents, defaultAgentId).map((agent) => ({
    name: agent.id,
    description: agent.description,
    mode: "primary",
    native: true,
    hidden: false,
    permission: [],
    options: {},
  }))
}

export function projectSession(session: StoredSession | SessionState, defaults: ProjectionDefaults): OpenCodeSession {
  const model = defaults.defaultModelId ? parseModel(defaults.defaultModelId) : undefined
  const time = Date.parse(session.createdAt)
  return {
    id: session.id,
    slug: session.id,
    projectID: session.projectHash,
    directory: session.projectPath,
    title: session.title ?? "New session",
    agent: defaults.defaultAgentId ?? undefined,
    model,
    version: "owa",
    time: {
      created: time,
      updated: time,
    },
  }
}

export function projectMessages(
  session: StoredSession | SessionState,
  messages: StoredMessage[],
  defaults: ProjectionDefaults,
): OpenCodeMessageBundle[] {
  const defaultModel = parseMessageModel(defaults.defaultModelId)
  let lastUserMessageId = ""
  return messages.map((message) => {
    const created = Date.parse(message.createdAt)
    if (message.role === "user") {
      lastUserMessageId = message.id
      const info: OpenCodeUserMessage = {
        id: message.id,
        sessionID: message.sessionId,
        role: "user",
        time: { created },
        agent: defaults.defaultAgentId ?? "see-act",
        model: defaultModel,
      }
      return {
        info,
        parts: [textPart(message, created)],
      }
    }

    const info: OpenCodeAssistantMessage = {
      id: message.id,
      sessionID: message.sessionId,
      role: "assistant",
      parentID: lastUserMessageId,
      time: { created, completed: created },
      modelID: defaultModel.modelID,
      providerID: defaultModel.providerID,
      mode: "build",
      agent: defaults.defaultAgentId ?? "see-act",
      path: { cwd: session.projectPath, root: session.projectPath },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    return {
      info,
      parts: [textPart(message, created)],
    }
  })
}

function groupProviders(models: ModelPlugin[]): OpenCodeProvider[] {
  const providers = new Map<string, OpenCodeProvider>()
  for (const model of models) {
    const provider = providers.get(model.provider) ?? {
      id: model.provider,
      name: model.name,
      source: "env" as const,
      env: [],
      options: {},
      models: {},
    }
    provider.models[model.id] = {
      id: model.id,
      name: model.modelName ?? model.name,
      limit: { context: model.contextWindowTokens ?? 0 },
      capabilities: { reasoning: Boolean(model.reasoningEffort) },
    }
    providers.set(provider.id, provider)
  }
  return [...providers.values()]
}

function parseModel(modelId: string): { id: string; providerID: string } {
  return { id: modelId, providerID: modelId.split(":")[0] ?? modelId }
}

function parseMessageModel(modelId: string | null | undefined): { providerID: string; modelID: string } {
  const modelID = modelId ?? "no-model"
  return { providerID: modelID.split(":")[0] ?? modelID, modelID }
}

function textPart(message: StoredMessage, created: number) {
  return {
    id: `part_${message.id}_text`,
    sessionID: message.sessionId,
    messageID: message.id,
    type: "text" as const,
    text: message.content,
    time: { start: created, end: created },
  }
}

function orderById<T extends { id: string }>(items: T[], selectedId?: string | null): T[] {
  if (!selectedId) return items
  const selected = items.find((item) => item.id === selectedId)
  if (!selected) return items
  return [selected, ...items.filter((item) => item.id !== selectedId)]
}
```

- [ ] **Step 4: Export projections**

Modify `packages/opencode-compat/src/index.ts`:

```ts
export {
  projectAgents,
  projectMessages,
  projectProviderConfig,
  projectProviderList,
  projectSession,
  resolveModelId,
  type OpenCodeModelSelection,
  type ProjectionDefaults,
} from "./projections"
export type {
  OpenCodeAgent,
  OpenCodeAssistantMessage,
  OpenCodeEvent,
  OpenCodeGlobalEvent,
  OpenCodeMessage,
  OpenCodeMessageBundle,
  OpenCodeModel,
  OpenCodeProvider,
  OpenCodeProviderConfig,
  OpenCodeProviderList,
  OpenCodeSession,
  OpenCodeTextPart,
  OpenCodeUserMessage,
} from "./types"
```

- [ ] **Step 5: Run focused projection tests**

Run:

```bash
bun test packages/opencode-compat/src/projections.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add packages/opencode-compat/src
git commit -m "[add] project owa data into opencode shapes"
```

## Task 3: Add Run Event Projection

**Files:**
- Create: `packages/opencode-compat/src/events.ts`
- Create: `packages/opencode-compat/src/events.test.ts`
- Modify: `packages/opencode-compat/src/index.ts`

- [ ] **Step 1: Write event projection tests**

Create `packages/opencode-compat/src/events.test.ts`:

```ts
import { describe, expect, it } from "bun:test"
import type { RunEvent } from "@open-web-agent/core"
import { projectRunEvent } from "./events"

function event(type: RunEvent["type"], payload: Record<string, unknown> = {}): RunEvent {
  return {
    id: `evt_${type}`,
    runId: "run_123",
    sessionId: "ses_123",
    stepId: null,
    sequence: 7,
    type,
    payload,
    createdAt: "2026-06-27T00:00:03.000Z",
  }
}

describe("OpenCode event projection", () => {
  it("projects run start as working status", () => {
    expect(projectRunEvent(event("run.started"), { directory: "/work/open-web-agent" })).toEqual([
      {
        directory: "/work/open-web-agent",
        payload: {
          id: "owa_evt_run.started_status",
          type: "session.status",
          properties: {
            sessionID: "ses_123",
            status: { type: "busy" },
          },
        },
      },
    ])
  })

  it("projects browser tool completion as a synthetic assistant text part", () => {
    expect(
      projectRunEvent(
        event("browser.tool.completed", {
          toolCall: { id: "tool_1", type: "navigate" },
          result: { ok: true, message: "navigated" },
        }),
        { directory: "/work/open-web-agent" },
      ),
    ).toEqual([
      {
        directory: "/work/open-web-agent",
        payload: {
          id: "owa_evt_browser.tool.completed_part",
          type: "message.part.updated",
          properties: {
            sessionID: "ses_123",
            time: Date.parse("2026-06-27T00:00:03.000Z"),
            part: {
              id: "part_run_123_7",
              sessionID: "ses_123",
              messageID: "assistant_run_123",
              type: "text",
              text: "navigate: navigated",
              synthetic: true,
              time: {
                start: Date.parse("2026-06-27T00:00:03.000Z"),
                end: Date.parse("2026-06-27T00:00:03.000Z"),
              },
              metadata: { owaEventType: "browser.tool.completed" },
            },
          },
        },
      },
    ])
  })

  it("projects run completion as assistant message, final part, and idle status", () => {
    expect(projectRunEvent(event("run.completed", { finalAnswer: "Example Domain" }), { directory: "/work/open-web-agent" })).toEqual([
      {
        directory: "/work/open-web-agent",
        payload: {
          id: "owa_evt_run.completed_message",
          type: "message.updated",
          properties: {
            sessionID: "ses_123",
            info: {
              id: "assistant_run_123",
              sessionID: "ses_123",
              role: "assistant",
              parentID: "",
              time: {
                created: Date.parse("2026-06-27T00:00:03.000Z"),
                completed: Date.parse("2026-06-27T00:00:03.000Z"),
              },
              modelID: "no-model",
              providerID: "runtime",
              mode: "build",
              agent: "owa",
              path: { cwd: "/work/open-web-agent", root: "/work/open-web-agent" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          },
        },
      },
      {
        directory: "/work/open-web-agent",
        payload: {
          id: "owa_evt_run.completed_part",
          type: "message.part.updated",
          properties: {
            sessionID: "ses_123",
            time: Date.parse("2026-06-27T00:00:03.000Z"),
            part: {
              id: "part_run_123_final",
              sessionID: "ses_123",
              messageID: "assistant_run_123",
              type: "text",
              text: "Example Domain",
              synthetic: false,
              time: {
                start: Date.parse("2026-06-27T00:00:03.000Z"),
                end: Date.parse("2026-06-27T00:00:03.000Z"),
              },
              metadata: { owaEventType: "run.completed" },
            },
          },
        },
      },
      {
        directory: "/work/open-web-agent",
        payload: {
          id: "owa_evt_run.completed_status",
          type: "session.status",
          properties: {
            sessionID: "ses_123",
            status: { type: "idle" },
          },
        },
      },
    ])
  })
})
```

- [ ] **Step 2: Run event tests and verify they fail**

Run:

```bash
bun test packages/opencode-compat/src/events.test.ts
```

Expected: FAIL with module resolution errors for `./events`.

- [ ] **Step 3: Implement event projection**

Create `packages/opencode-compat/src/events.ts`:

```ts
import type { RunEvent } from "@open-web-agent/core"
import type { OpenCodeAssistantMessage, OpenCodeGlobalEvent, OpenCodeTextPart } from "./types"

export interface ProjectRunEventOptions {
  directory: string
  agentId?: string | null
  modelId?: string | null
}

export function projectRunEvent(event: RunEvent, options: ProjectRunEventOptions): OpenCodeGlobalEvent[] {
  if (event.type === "run.started") return [statusEvent(event, options, "busy")]
  if (event.type === "run.completed") {
    const time = Date.parse(event.createdAt)
    const answer = typeof event.payload.finalAnswer === "string" ? event.payload.finalAnswer : ""
    return [
      messageEvent(event, options, time),
      partEvent(event, options, finalTextPart(event, answer, time)),
      statusEvent(event, options, "idle"),
    ]
  }
  if (event.type === "run.failed" || event.type === "run.cancelled") return [statusEvent(event, options, "idle")]
  if (event.type === "browser.tool.completed") return [partEvent(event, options, syntheticTextPart(event, browserToolText(event), event.type))]
  if (event.type === "browser.action.completed") return [partEvent(event, options, syntheticTextPart(event, "browser action completed", event.type))]
  if (event.type === "observation.captured") return [partEvent(event, options, syntheticTextPart(event, observationText(event), event.type))]
  if (event.type === "plan.created" || event.type === "plan.updated") return [partEvent(event, options, syntheticTextPart(event, "plan updated", event.type))]
  return []
}

function statusEvent(event: RunEvent, options: ProjectRunEventOptions, type: "busy" | "idle"): OpenCodeGlobalEvent {
  return {
    directory: options.directory,
    payload: {
      id: `owa_${event.id}_status`,
      type: "session.status",
      properties: {
        sessionID: event.sessionId,
        status: { type },
      },
    },
  }
}

function messageEvent(event: RunEvent, options: ProjectRunEventOptions, time: number): OpenCodeGlobalEvent {
  return {
    directory: options.directory,
    payload: {
      id: `owa_${event.id}_message`,
      type: "message.updated",
      properties: {
        sessionID: event.sessionId,
        info: assistantMessage(event, options, time),
      },
    },
  }
}

function partEvent(event: RunEvent, options: ProjectRunEventOptions, part: OpenCodeTextPart): OpenCodeGlobalEvent {
  return {
    directory: options.directory,
    payload: {
      id: `owa_${event.id}_part`,
      type: "message.part.updated",
      properties: {
        sessionID: event.sessionId,
        time: Date.parse(event.createdAt),
        part,
      },
    },
  }
}

function assistantMessage(event: RunEvent, options: ProjectRunEventOptions, time: number): OpenCodeAssistantMessage {
  const modelID = options.modelId ?? "no-model"
  return {
    id: `assistant_${event.runId}`,
    sessionID: event.sessionId,
    role: "assistant",
    parentID: "",
    time: { created: time, completed: time },
    modelID,
    providerID: modelID === "no-model" ? "runtime" : modelID.split(":")[0] ?? "runtime",
    mode: "build",
    agent: options.agentId ?? "owa",
    path: { cwd: options.directory, root: options.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function finalTextPart(event: RunEvent, text: string, time: number): OpenCodeTextPart {
  return {
    id: `part_${event.runId}_final`,
    sessionID: event.sessionId,
    messageID: `assistant_${event.runId}`,
    type: "text",
    text,
    synthetic: false,
    time: { start: time, end: time },
    metadata: { owaEventType: event.type },
  }
}

function syntheticTextPart(event: RunEvent, text: string, owaEventType: RunEvent["type"]): OpenCodeTextPart {
  const time = Date.parse(event.createdAt)
  return {
    id: `part_${event.runId}_${event.sequence}`,
    sessionID: event.sessionId,
    messageID: `assistant_${event.runId}`,
    type: "text",
    text,
    synthetic: true,
    time: { start: time, end: time },
    metadata: { owaEventType },
  }
}

function browserToolText(event: RunEvent): string {
  const toolCall = readRecord(event.payload.toolCall)
  const result = readRecord(event.payload.result)
  const type = typeof toolCall.type === "string" ? toolCall.type : "browser tool"
  const message = typeof result.message === "string" ? result.message : "completed"
  return `${type}: ${message}`
}

function observationText(event: RunEvent): string {
  const observation = readRecord(event.payload.observation)
  const title = typeof observation.title === "string" ? observation.title : undefined
  const url = typeof observation.url === "string" ? observation.url : undefined
  return [title, url].filter(Boolean).join(" ") || "observation captured"
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}
```

- [ ] **Step 4: Export event projection**

Modify `packages/opencode-compat/src/index.ts`:

```ts
export { projectRunEvent, type ProjectRunEventOptions } from "./events"
export {
  projectAgents,
  projectMessages,
  projectProviderConfig,
  projectProviderList,
  projectSession,
  resolveModelId,
  type OpenCodeModelSelection,
  type ProjectionDefaults,
} from "./projections"
export type {
  OpenCodeAgent,
  OpenCodeAssistantMessage,
  OpenCodeEvent,
  OpenCodeGlobalEvent,
  OpenCodeMessage,
  OpenCodeMessageBundle,
  OpenCodeModel,
  OpenCodeProvider,
  OpenCodeProviderConfig,
  OpenCodeProviderList,
  OpenCodeSession,
  OpenCodeTextPart,
  OpenCodeUserMessage,
} from "./types"
```

- [ ] **Step 5: Run focused event tests**

Run:

```bash
bun test packages/opencode-compat/src/events.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run all compat tests**

Run:

```bash
bun test packages/opencode-compat/src
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add packages/opencode-compat/src
git commit -m "[add] translate owa events for opencode tui"
```

## Task 4: Mount Read-Only OpenCode Compatibility Routes

**Files:**
- Create: `packages/server/src/routes/opencode.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/app.test.ts`

- [ ] **Step 1: Add server tests for read-only compat endpoints**

Append tests to `packages/server/src/app.test.ts` inside the existing `describe` block:

```ts
  it("serves OpenCode bootstrap data from OWA runtime state", async () => {
    const { request } = await setup(0, undefined, true, true)

    expect(await (await request("/opencode/global/health")).json()).toEqual({ ok: true })
    expect(await (await request("/opencode/config")).json()).toEqual({})
    expect(await (await request("/opencode/agent")).json()).toEqual([
      expect.objectContaining({ name: "test-agent", mode: "primary" }),
      expect.objectContaining({ name: "alternate-agent", mode: "primary" }),
      expect.objectContaining({ name: "context-agent", mode: "primary" }),
    ])
    expect(await (await request("/opencode/config/providers")).json()).toMatchObject({
      providers: [expect.objectContaining({ id: "test-provider" })],
    })
    expect(await (await request("/opencode/provider")).json()).toMatchObject({
      connected: ["test-provider"],
    })
    expect(await (await request("/opencode/command")).json()).toEqual([])
    expect(await (await request("/opencode/lsp")).json()).toEqual([])
    expect(await (await request("/opencode/mcp")).json()).toEqual({})
    expect(await (await request("/opencode/formatter")).json()).toEqual([])
    expect(await (await request("/opencode/session/status")).json()).toEqual({})
  })

  it("lists and reads sessions through OpenCode routes", async () => {
    const { request } = await setup()
    const created = await request("/sessions", {
      method: "POST",
      body: JSON.stringify({ projectPath: "/tmp/project", title: "OWA session" }),
    }).then((response) => response.json() as Promise<{ sessionId: string }>)

    const list = await request("/opencode/session").then((response) => response.json())
    expect(list).toEqual([expect.objectContaining({ id: created.sessionId, title: "OWA session", directory: "/tmp/project" })])

    const session = await request(`/opencode/session/${created.sessionId}`).then((response) => response.json())
    expect(session).toMatchObject({ id: created.sessionId, title: "OWA session", directory: "/tmp/project" })

    expect(await request(`/opencode/session/${created.sessionId}/message`).then((response) => response.json())).toEqual([])
    expect(await request(`/opencode/session/${created.sessionId}/todo`).then((response) => response.json())).toEqual([])
    expect(await request(`/opencode/session/${created.sessionId}/diff`).then((response) => response.json())).toEqual([])
  })
```

If `TestModel` in `app.test.ts` uses a provider id other than `test-provider`, update the expected provider id to the provider value already defined in that class.

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/server/src/app.test.ts -t "OpenCode"
```

Expected: FAIL with 404 responses for `/opencode/*`.

- [ ] **Step 3: Implement OpenCode route registration**

Create `packages/server/src/routes/opencode.ts`:

```ts
import type { Hono } from "hono"
import type { EventBus, PluginRegistry, SessionState } from "@open-web-agent/core"
import {
  projectAgents,
  projectMessages,
  projectProviderConfig,
  projectProviderList,
  projectSession,
} from "@open-web-agent/opencode-compat"
import type { SQLiteStore } from "@open-web-agent/storage"
import type { RunRecord } from "./runs"

export interface OpenCodeRouteDeps {
  eventBus: EventBus
  registry: PluginRegistry
  sessions: Map<string, SessionState>
  runs: Map<string, RunRecord>
  storage?: SQLiteStore
  defaults?: {
    agentId?: string | null
    modelId?: string | null
    environmentId?: string | null
    browserHeadless?: boolean | null
  }
}

export function registerOpenCodeRoutes(app: Hono, deps: OpenCodeRouteDeps): void {
  app.get("/opencode/global/health", (c) => c.json({ ok: true }))
  app.get("/opencode/config", (c) => c.json({}))
  app.get("/opencode/config/providers", (c) =>
    c.json(projectProviderConfig(deps.registry.listModels(), deps.defaults?.modelId)),
  )
  app.get("/opencode/provider", (c) => c.json(projectProviderList(deps.registry.listModels(), deps.defaults?.modelId)))
  app.get("/opencode/provider/auth", (c) => c.json({}))
  app.get("/opencode/agent", (c) => c.json(projectAgents(deps.registry.listAgents(), deps.defaults?.agentId)))

  app.get("/opencode/command", (c) => c.json([]))
  app.get("/opencode/lsp", (c) => c.json([]))
  app.get("/opencode/mcp", (c) => c.json({}))
  app.get("/opencode/mcp/resource", (c) => c.json({}))
  app.get("/opencode/formatter", (c) => c.json([]))
  app.get("/opencode/vcs", (c) => c.json(null))
  app.get("/opencode/experimental/capabilities", (c) => c.json({ backgroundSubagents: false }))
  app.get("/opencode/experimental/console", (c) => c.json({ consoleManagedProviders: [], switchableOrgCount: 0 }))

  app.get("/opencode/session", (c) =>
    c.json(listSessions(deps).map((session) => projectSession(session, readDefaults(deps)))),
  )
  app.get("/opencode/session/status", (c) => c.json(readSessionStatuses(deps.runs)))
  app.get("/opencode/session/:sessionId", (c) => {
    const session = findSession(deps, c.req.param("sessionId"))
    if (!session) return c.json({ error: { message: "Unknown session" } }, 404)
    return c.json(projectSession(session, readDefaults(deps)))
  })
  app.get("/opencode/session/:sessionId/message", (c) => {
    const session = findSession(deps, c.req.param("sessionId"))
    if (!session) return c.json({ error: { message: "Unknown session" } }, 404)
    return c.json(projectMessages(session, deps.storage?.listMessages(session.id) ?? [], readDefaults(deps)))
  })
  app.get("/opencode/session/:sessionId/todo", (c) => {
    if (!findSession(deps, c.req.param("sessionId"))) return c.json({ error: { message: "Unknown session" } }, 404)
    return c.json([])
  })
  app.get("/opencode/session/:sessionId/diff", (c) => {
    if (!findSession(deps, c.req.param("sessionId"))) return c.json({ error: { message: "Unknown session" } }, 404)
    return c.json([])
  })
}

function readDefaults(deps: OpenCodeRouteDeps) {
  return {
    defaultAgentId: deps.defaults?.agentId,
    defaultModelId: deps.defaults?.modelId,
  }
}

function listSessions(deps: OpenCodeRouteDeps) {
  return deps.storage?.listSessions() ?? [...deps.sessions.values()].filter((session) => !session.deletedAt)
}

function findSession(deps: OpenCodeRouteDeps, sessionId: string) {
  return deps.sessions.get(sessionId) ?? deps.storage?.getSession(sessionId) ?? null
}

function readSessionStatuses(runs: Map<string, RunRecord>) {
  const statuses: Record<string, { type: "busy" | "idle" }> = {}
  for (const run of runs.values()) {
    if (run.status === "running") statuses[run.sessionId] = { type: "busy" }
  }
  return statuses
}
```

- [ ] **Step 4: Mount routes in `createApp`**

Modify `packages/server/src/app.ts` imports:

```ts
import { registerOpenCodeRoutes } from "./routes/opencode"
```

Call it after `registerPluginRoutes`:

```ts
  registerPluginRoutes(app, { registry: deps.registry, defaults: deps.runtimeDefaults })
  registerOpenCodeRoutes(app, {
    eventBus: deps.eventBus,
    registry: deps.registry,
    sessions: deps.sessions,
    runs,
    storage: deps.storage,
    defaults: deps.runtimeDefaults,
  })
```

- [ ] **Step 5: Run focused server route tests**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/server/src/app.test.ts -t "OpenCode"
```

Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add packages/server/src/app.ts packages/server/src/app.test.ts packages/server/src/routes/opencode.ts
git commit -m "[add] expose opencode compatibility bootstrap routes"
```

## Task 5: Share Run Submission And Implement OpenCode Prompt Routes

**Files:**
- Create: `packages/server/src/run-submission.ts`
- Modify: `packages/server/src/routes/runs.ts`
- Modify: `packages/server/src/routes/opencode.ts`
- Modify: `packages/server/src/app.test.ts`

- [ ] **Step 1: Add tests for OpenCode session create and prompt**

Append tests to `packages/server/src/app.test.ts`:

```ts
  it("creates sessions through the OpenCode route", async () => {
    const { request } = await setup()

    const response = await request("/opencode/session?directory=/tmp/project", {
      method: "POST",
      body: JSON.stringify({
        title: "OpenCode-created session",
        agent: "test-agent",
        model: { providerID: "runtime", id: "runtime-selected-model" },
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      id: expect.stringMatching(/^ses_/),
      title: "OpenCode-created session",
      directory: "/tmp/project",
    })
  })

  it("submits prompts through OpenCode message route", async () => {
    const { request } = await setup()
    const session = await request("/opencode/session?directory=/tmp/project", {
      method: "POST",
      body: JSON.stringify({ title: "Prompt session", agent: "test-agent" }),
    }).then((response) => response.json() as Promise<{ id: string }>)

    const response = await request(`/opencode/session/${session.id}/message`, {
      method: "POST",
      body: JSON.stringify({
        agent: "test-agent",
        model: { providerID: "runtime", modelID: "runtime-selected-model" },
        parts: [{ type: "text", text: "Open example.com" }],
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })

    const messages = await request(`/opencode/session/${session.id}/message`).then((result) => result.json())
    expect(messages).toEqual([
      expect.objectContaining({
        info: expect.objectContaining({ role: "user" }),
        parts: [expect.objectContaining({ text: "Open example.com" })],
      }),
    ])
  })
```

- [ ] **Step 2: Run prompt tests and verify they fail**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/server/src/app.test.ts -t "OpenCode"
```

Expected: FAIL because `POST /opencode/session` and `POST /opencode/session/:sessionId/message` are not registered.

- [ ] **Step 3: Extract shared run submission helper**

Create `packages/server/src/run-submission.ts`:

```ts
import { randomUUID } from "node:crypto"
import type { PluginRegistry, RunOrchestrator, RunResult, SessionState } from "@open-web-agent/core"
import type { SQLiteStore } from "@open-web-agent/storage"
import type { BrowserSessionManager } from "./browser-session-manager"

export interface RunRecord {
  runId: string
  sessionId: string
  status: "running" | RunResult["status"]
  finalAnswer: string | null
}

export interface SubmitRunDeps {
  orchestrator: RunOrchestrator
  registry: PluginRegistry
  sessions: Map<string, SessionState>
  runs: Map<string, RunRecord>
  storage?: SQLiteStore
  browserSessions: BrowserSessionManager
}

export interface SubmitRunInput {
  sessionId: string
  prompt: string
  agentId?: string
  modelId?: string
  environmentId?: string
}

export async function submitRun(deps: SubmitRunDeps, input: SubmitRunInput): Promise<{ runId: string }> {
  const session = deps.sessions.get(input.sessionId) ?? deps.storage?.getSession(input.sessionId)
  if (!session || session.deletedAt) throw httpError(404, "Unknown session")
  deps.sessions.set(session.id, session)
  if (hasRunningRun(session.id, deps.runs)) throw httpError(409, "Session has a running run")

  if (input.agentId && !deps.registry.listAgents().some((agent) => agent.id === input.agentId)) throw httpError(400, "Unknown agent")
  if (input.modelId && !deps.registry.listModels().some((model) => model.id === input.modelId)) throw httpError(400, "Unknown model")

  const environmentId = input.environmentId ?? session.environmentId ?? deps.browserSessions.defaultEnvironmentId
  if (!deps.registry.listEnvironments().some((environment) => environment.id === environmentId)) throw httpError(400, "Unknown browser")

  const runSession: SessionState = session.environmentId === environmentId ? session : { ...session, environmentId }
  if (runSession !== session) {
    deps.sessions.set(runSession.id, runSession)
    deps.storage?.upsertSession({
      id: runSession.id,
      projectPath: runSession.projectPath,
      projectHash: runSession.projectHash,
      environmentId: runSession.environmentId ?? null,
      title: runSession.title ?? null,
      pinned: runSession.pinned ?? false,
      deletedAt: runSession.deletedAt ?? null,
      createdAt: runSession.createdAt,
    })
  }

  const pendingRunId = `pending_${randomUUID().replaceAll("-", "")}`
  deps.runs.set(pendingRunId, { runId: pendingRunId, sessionId: runSession.id, status: "running", finalAnswer: null })

  let started: ReturnType<RunOrchestrator["startRun"]>
  try {
    await deps.browserSessions.attach(runSession, environmentId)
    started = deps.orchestrator.startRun({
      session: runSession,
      prompt: input.prompt,
      agentId: input.agentId,
      modelId: input.modelId,
      environmentId,
    })
  } catch (error) {
    deps.runs.delete(pendingRunId)
    throw error
  }

  deps.runs.delete(pendingRunId)
  deps.runs.set(started.runId, { runId: started.runId, sessionId: runSession.id, status: "running", finalAnswer: null })
  const createdAt = new Date().toISOString()
  deps.storage?.upsertRun({ id: started.runId, sessionId: runSession.id, status: "running", finalAnswer: null, createdAt, updatedAt: createdAt })
  deps.storage?.appendMessage({
    id: `msg_${randomUUID().replaceAll("-", "")}`,
    sessionId: runSession.id,
    role: "user",
    content: input.prompt,
    createdAt,
  })

  void started.result
    .then(async (result) => {
      await deps.browserSessions.capture(runSession, environmentId).catch(() => null)
      const updatedAt = new Date().toISOString()
      deps.runs.set(started.runId, { runId: started.runId, sessionId: runSession.id, status: result.status, finalAnswer: result.finalAnswer })
      deps.storage?.upsertRun({ id: started.runId, sessionId: runSession.id, status: result.status, finalAnswer: result.finalAnswer, createdAt, updatedAt })
      if (result.finalAnswer) {
        deps.storage?.appendMessage({
          id: `msg_${randomUUID().replaceAll("-", "")}`,
          sessionId: runSession.id,
          role: "assistant",
          content: result.finalAnswer,
          createdAt: updatedAt,
        })
      }
    })
    .catch(async (error) => {
      await deps.browserSessions.capture(runSession, environmentId).catch(() => null)
      const updatedAt = new Date().toISOString()
      const message = error instanceof Error ? error.message : String(error)
      deps.runs.set(started.runId, { runId: started.runId, sessionId: runSession.id, status: "failed", finalAnswer: message })
      deps.storage?.upsertRun({ id: started.runId, sessionId: runSession.id, status: "failed", finalAnswer: message, createdAt, updatedAt })
    })

  return { runId: started.runId }
}

export function hasRunningRun(sessionId: string, runs: Map<string, RunRecord>): boolean {
  for (const run of runs.values()) {
    if (run.sessionId === sessionId && run.status === "running") return true
  }
  return false
}

export function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number }
  error.status = status
  return error
}
```

- [ ] **Step 4: Refactor OWA run route to use the helper**

Modify `packages/server/src/routes/runs.ts`:

```ts
import type { Hono } from "hono"
import type { PluginRegistry, RunOrchestrator } from "@open-web-agent/core"
import type { SQLiteStore } from "@open-web-agent/storage"
import { CreateRunRequestSchema } from "../schemas/api"
import type { BrowserSessionManager } from "../browser-session-manager"
import { httpError, submitRun, type RunRecord } from "../run-submission"
import { readJsonBody } from "./json-body"

export type { RunRecord } from "../run-submission"

export interface RunRouteDeps {
  orchestrator: RunOrchestrator
  registry: PluginRegistry
  sessions: Parameters<typeof submitRun>[0]["sessions"]
  runs: Map<string, RunRecord>
  storage?: SQLiteStore
  browserSessions: BrowserSessionManager
}

export function registerRunRoutes(app: Hono, deps: RunRouteDeps): void {
  app.post("/runs", async (c) => {
    const body = await readJsonBody(c.req)
    if (!body.ok) return c.json({ error: body.error }, body.status)
    const parsed = CreateRunRequestSchema.safeParse(body.value)
    if (!parsed.success) return c.json({ error: "Invalid run request" }, 400)

    try {
      return c.json(await submitRun(deps, parsed.data))
    } catch (error) {
      if (isHttpError(error)) return c.json({ error: error.message }, error.status)
      throw error
    }
  })

  app.get("/runs/:runId", (c) => {
    const run = deps.runs.get(c.req.param("runId"))
    if (!run) return c.json({ error: "Unknown run" }, 404)
    return c.json(run)
  })

  app.post("/runs/:runId/cancel", (c) => c.json({ cancelled: deps.orchestrator.cancelRun(c.req.param("runId")) }))
}

function isHttpError(error: unknown): error is Error & { status: number } {
  return error instanceof Error && "status" in error && typeof error.status === "number"
}
```

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/server/src/app.test.ts -t "runs"
```

Expected: PASS. Existing `/runs` behavior still works.

- [ ] **Step 5: Add OpenCode POST routes**

Modify `packages/server/src/routes/opencode.ts` imports:

```ts
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { hashProjectPath, makeSessionId, type SessionState } from "@open-web-agent/core"
import { resolveModelId } from "@open-web-agent/opencode-compat"
import { httpError, submitRun } from "../run-submission"
import { readJsonBody } from "./json-body"
```

Add route dependencies:

```ts
  orchestrator: RunOrchestrator
  browserSessions: BrowserSessionManager
```

Add routes:

```ts
  app.post("/opencode/session", async (c) => {
    const body = await readJsonBody(c.req)
    if (!body.ok) return c.json({ error: { message: body.error } }, body.status)
    const input = isRecord(body.value) ? body.value : {}
    const directory = resolve(c.req.query("directory") ?? process.cwd())
    const environmentId = deps.defaults?.environmentId ?? deps.browserSessions.defaultEnvironmentId
    const session: SessionState = {
      id: makeSessionId(),
      projectPath: directory,
      projectHash: hashProjectPath(directory),
      environmentId,
      title: typeof input.title === "string" ? input.title : null,
      pinned: false,
      deletedAt: null,
      createdAt: new Date().toISOString(),
    }
    await deps.browserSessions.open(session, environmentId)
    deps.sessions.set(session.id, session)
    deps.storage?.upsertSession({
      id: session.id,
      projectPath: session.projectPath,
      projectHash: session.projectHash,
      environmentId: session.environmentId ?? null,
      title: session.title ?? null,
      pinned: false,
      deletedAt: null,
      createdAt: session.createdAt,
    })
    return c.json(projectSession(session, readDefaults(deps)))
  })

  app.post("/opencode/session/:sessionId/message", async (c) => {
    const session = findSession(deps, c.req.param("sessionId"))
    if (!session) return c.json({ error: { message: "Unknown session" } }, 404)
    const body = await readJsonBody(c.req)
    if (!body.ok) return c.json({ error: { message: body.error } }, body.status)
    const input = isRecord(body.value) ? body.value : {}
    const prompt = readPrompt(input)
    if (!prompt) return c.json({ error: { message: "Prompt text is required" } }, 400)
    const modelId = resolveModelId(deps.registry.listModels(), readModelSelection(input.model), deps.defaults?.modelId)
    try {
      await submitRun(deps, {
        sessionId: session.id,
        prompt,
        agentId: typeof input.agent === "string" ? input.agent : deps.defaults?.agentId ?? undefined,
        modelId,
        environmentId: session.environmentId ?? deps.defaults?.environmentId ?? undefined,
      })
      return c.json({ ok: true })
    } catch (error) {
      if (error instanceof Error && "status" in error && typeof error.status === "number") {
        return c.json({ error: { message: error.message } }, error.status)
      }
      throw error
    }
  })

function readPrompt(input: Record<string, unknown>): string {
  const parts = Array.isArray(input.parts) ? input.parts : []
  return parts
    .flatMap((part) => {
      if (!isRecord(part)) return []
      if (part.type !== "text") return []
      return typeof part.text === "string" ? [part.text] : []
    })
    .join("\n")
    .trim()
}

function readModelSelection(value: unknown) {
  if (!isRecord(value)) return undefined
  const providerID = typeof value.providerID === "string" ? value.providerID : undefined
  if (!providerID) return undefined
  return {
    providerID,
    modelID: typeof value.modelID === "string" ? value.modelID : undefined,
    id: typeof value.id === "string" ? value.id : undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
```

Pass new deps from `packages/server/src/app.ts`:

```ts
    orchestrator: deps.orchestrator,
    browserSessions,
```

- [ ] **Step 6: Run focused OpenCode route tests**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/server/src/app.test.ts -t "OpenCode"
```

Expected: PASS.

- [ ] **Step 7: Run full server tests**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/server/src
```

Expected: PASS.

- [ ] **Step 8: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit Task 5**

```bash
git add packages/server/src packages/opencode-compat/src
git commit -m "[add] submit opencode tui prompts through owa runs"
```

## Task 6: Add OpenCode Event Streams

**Files:**
- Modify: `packages/server/src/routes/opencode.ts`
- Modify: `packages/server/src/app.test.ts`

- [ ] **Step 1: Add an event stream test**

Append this test to `packages/server/src/app.test.ts`:

```ts
  it("streams OWA run events as OpenCode global events", async () => {
    const { eventBus, request } = await setup()
    const stream = await request("/opencode/global/event")
    expect(stream.status).toBe(200)
    expect(stream.headers.get("content-type")).toContain("text/event-stream")

    const reader = stream.body!.getReader()
    await eventBus.publish({
      id: "evt_run_started",
      runId: "run_123",
      sessionId: "ses_123",
      stepId: null,
      sequence: 0,
      type: "run.started",
      payload: {},
      createdAt: "2026-06-27T00:00:00.000Z",
    })

    const chunk = await reader.read()
    const text = new TextDecoder().decode(chunk.value)
    expect(text).toContain("event: event")
    expect(text).toContain('"type":"session.status"')
    await reader.cancel()
  })
```

- [ ] **Step 2: Run the event stream test and verify it fails**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/server/src/app.test.ts -t "streams OWA run events"
```

Expected: FAIL because `/opencode/global/event` is not registered as SSE.

- [ ] **Step 3: Implement SSE routes**

Modify `packages/server/src/routes/opencode.ts` imports:

```ts
import { streamSSE } from "hono/streaming"
import { projectRunEvent } from "@open-web-agent/opencode-compat"
```

Add both OpenCode event endpoints:

```ts
  app.get("/opencode/global/event", (c) =>
    streamSSE(c, async (stream) => {
      let unsubscribe: () => void = () => {}
      unsubscribe = deps.eventBus.subscribe(async (event) => {
        const session = findSession(deps, event.sessionId)
        const directory = session?.projectPath ?? process.cwd()
        for (const projected of projectRunEvent(event, {
          directory,
          agentId: deps.defaults?.agentId,
          modelId: deps.defaults?.modelId,
        })) {
          await stream.writeSSE({
            event: "event",
            id: projected.payload.id,
            data: JSON.stringify(projected),
          })
        }
      })
      stream.onAbort(unsubscribe)
      await stream.write(": connected\n\n")
      while (!stream.aborted && !stream.closed) await stream.sleep(1000)
      unsubscribe()
    }),
  )

  app.get("/opencode/event", (c) =>
    streamSSE(c, async (stream) => {
      let unsubscribe: () => void = () => {}
      unsubscribe = deps.eventBus.subscribe(async (event) => {
        const session = findSession(deps, event.sessionId)
        const directory = session?.projectPath ?? process.cwd()
        for (const projected of projectRunEvent(event, {
          directory,
          agentId: deps.defaults?.agentId,
          modelId: deps.defaults?.modelId,
        })) {
          await stream.writeSSE({
            event: "event",
            id: projected.payload.id,
            data: JSON.stringify(projected.payload),
          })
        }
      })
      stream.onAbort(unsubscribe)
      await stream.write(": connected\n\n")
      while (!stream.aborted && !stream.closed) await stream.sleep(1000)
      unsubscribe()
    }),
  )
```

- [ ] **Step 4: Run event stream tests**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/server/src/app.test.ts -t "streams OWA run events"
```

Expected: PASS.

- [ ] **Step 5: Run server tests**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/server/src
```

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

```bash
git add packages/server/src/routes/opencode.ts packages/server/src/app.test.ts
git commit -m "[add] stream opencode-compatible run events"
```

## Task 7: Add CLI TUI Selection With Native And OpenCode Launchers

**Files:**
- Create: `packages/opencode-tui/package.json`
- Create: `packages/opencode-tui/tsconfig.json`
- Create: `packages/opencode-tui/src/index.ts`
- Modify: `tsconfig.json`
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/src/args.ts`
- Modify: `packages/cli/src/args.test.ts`
- Modify: `packages/cli/src/commands/default.ts`
- Modify: `packages/cli/src/commands/connect.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Add CLI parsing tests**

Modify `packages/cli/src/args.test.ts`:

```ts
  it("recognizes default mode with opencode tui", () => {
    expect(parseArgs(["--tui", "opencode"], "/tmp/project")).toEqual({
      mode: "default",
      projectPath: "/tmp/project",
      tui: "opencode",
    })
  })

  it("recognizes connect mode with opencode tui", () => {
    expect(parseArgs(["--connect", "http://127.0.0.1:4096", "--tui", "opencode"], "/tmp/project")).toEqual({
      mode: "connect",
      serverUrl: "http://127.0.0.1:4096",
      tui: "opencode",
    })
  })

  it("rejects unknown tui ids", () => {
    expect(() => parseArgs(["--tui", "unknown"], "/tmp/project")).toThrow("--tui must be owa or opencode")
  })
```

- [ ] **Step 2: Run CLI parsing tests and verify they fail**

Run:

```bash
bun test packages/cli/src/args.test.ts
```

Expected: FAIL because `--tui` is not parsed.

- [ ] **Step 3: Add the OpenCode launcher package**

Create `packages/opencode-tui/package.json`:

```json
{
  "name": "@open-web-agent/opencode-tui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {}
}
```

Create `packages/opencode-tui/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

Create `packages/opencode-tui/src/index.ts`:

```ts
export interface LaunchOpenCodeTuiOptions {
  serverUrl: string
  projectPath: string
  continueLast?: boolean
  sessionId?: string
}

export async function launchOpenCodeTui(options: LaunchOpenCodeTuiOptions): Promise<void> {
  throw new Error(
    [
      "OpenCode TUI source is not vendored yet.",
      `Compat API is available at ${options.serverUrl}/opencode.`,
      "Run the OpenCode source vendor task before using --tui opencode interactively.",
    ].join(" "),
  )
}
```

This launcher intentionally fails with a clear message until Task 8 vendors the OpenCode TUI source. The compat API work remains testable before the source import.

- [ ] **Step 4: Add project references and dependencies**

Modify root `tsconfig.json` references:

```json
    { "path": "./packages/opencode-tui" },
    { "path": "./packages/cli" }
```

Modify `packages/cli/package.json` dependencies:

```json
    "@open-web-agent/opencode-tui": "workspace:*",
```

- [ ] **Step 5: Implement CLI argument parsing**

Modify `packages/cli/src/args.ts`:

```ts
export type TuiKind = "owa" | "opencode"

export type CliArgs =
  | { mode: "default"; projectPath: string; continueLast?: boolean; sessionId?: string; tui?: TuiKind }
  | { mode: "run"; prompt: string; projectPath: string; continueLast?: boolean; sessionId?: string; agentId?: string }
  | { mode: "serve"; hostname: string; port: number }
  | { mode: "eval"; taskIds: string[]; combinations?: Array<{ agentId: string; modelId: string; environmentId: string }> }
  | { mode: "connect"; serverUrl: string; tui?: TuiKind }
```

Add helpers:

```ts
function parseTuiValue(value: string): TuiKind {
  if (value === "owa" || value === "opencode") return value
  throw new Error("--tui must be owa or opencode")
}

function parseLeadingTui(argv: string[]): { tui?: TuiKind; rest: string[] } {
  const rest: string[] = []
  let tui: TuiKind | undefined
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--tui") {
      tui = parseTuiValue(requiredValue(argv, index, "--tui"))
      index += 1
      continue
    }
    rest.push(argv[index])
  }
  return { tui, rest }
}
```

At the start of `parseArgs`, normalize interactive args:

```ts
  const parsedTui = parseLeadingTui(argv)
  argv = parsedTui.rest
```

Include `tui: parsedTui.tui` in `default` and `connect` returns when set.

- [ ] **Step 6: Dispatch selected TUI in commands**

Modify `packages/cli/src/commands/default.ts`:

```ts
import { launchOpenCodeTui } from "@open-web-agent/opencode-tui"
import { startDefaultRuntime } from "@open-web-agent/server"
import { launchTui } from "@open-web-agent/tui"
import { join } from "node:path"
import type { TuiKind } from "../args"

export interface DefaultCommandInput {
  projectPath: string
  continueLast?: boolean
  sessionId?: string
  tui?: TuiKind
}

export async function defaultCommand(input: DefaultCommandInput): Promise<void> {
  const runtime = await startDefaultRuntime({ agentsDir: join(input.projectPath, "agents") })
  try {
    const options = {
      serverUrl: runtime.url,
      projectPath: input.projectPath,
      continueLast: input.continueLast,
      sessionId: input.sessionId,
    }
    if (input.tui === "opencode") await launchOpenCodeTui(options)
    else await launchTui(options)
  } finally {
    await runtime.stop()
  }
}
```

Modify `packages/cli/src/commands/connect.ts`:

```ts
import { launchOpenCodeTui } from "@open-web-agent/opencode-tui"
import { launchTui } from "@open-web-agent/tui"
import type { TuiKind } from "../args"

export interface ConnectCommandInput {
  serverUrl: string
  projectPath?: string
  tui?: TuiKind
}

export async function connectCommand(input: ConnectCommandInput): Promise<void> {
  const options = { serverUrl: input.serverUrl, projectPath: input.projectPath ?? process.cwd() }
  if (input.tui === "opencode") await launchOpenCodeTui(options)
  else await launchTui(options)
}
```

Modify `packages/cli/src/index.ts` so default and connect pass `args.tui`.

- [ ] **Step 7: Run CLI tests**

Run:

```bash
bun test packages/cli/src/args.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit Task 7**

```bash
git add tsconfig.json packages/cli packages/opencode-tui
git commit -m "[add] select owa or opencode tui from cli"
```

## Task 8: Vendor And Wire OpenCode TUI Source

**Files:**
- Add: `vendor/opencode/**`
- Create: `vendor/opencode-shims/core/package.json`
- Create: `vendor/opencode-shims/core/src/global.ts`
- Create: `vendor/opencode-shims/core/src/flag/flag.ts`
- Create: `vendor/opencode-shims/core/src/installation/version.ts`
- Create: `vendor/opencode-shims/core/src/util/flock.ts`
- Create: `vendor/opencode-shims/core/src/util/glob.ts`
- Create: `vendor/opencode-shims/core/src/util/which.ts`
- Create: `vendor/opencode-shims/plugin/package.json`
- Create: `vendor/opencode-shims/plugin/src/tui.ts`
- Create: `vendor/opencode-shims/ui/package.json`
- Add: `vendor/opencode-shims/ui/audio/*.mp3`
- Modify: `package.json`
- Modify: `packages/opencode-tui/package.json`
- Modify: `packages/opencode-tui/src/index.ts`

- [ ] **Step 1: Vendor the OpenCode source snapshot**

Run:

```bash
git subtree add --prefix vendor/opencode https://github.com/anomalyco/opencode.git dev --squash
```

Expected: the working tree contains the upstream source snapshot. OWA will use `vendor/opencode/packages/tui` and `vendor/opencode/packages/sdk/js` directly. OWA will not use upstream `vendor/opencode/packages/core` as a workspace package because it brings in the full OpenCode runtime graph.

Verify:

```bash
test -f vendor/opencode/packages/tui/package.json
test -f vendor/opencode/packages/sdk/js/package.json
```

Expected: all commands exit 0.

- [ ] **Step 2: Add shim packages for OpenCode TUI runtime imports**

Create `vendor/opencode-shims/core/package.json`:

```json
{
  "name": "@opencode-ai/core",
  "version": "1.17.11",
  "private": true,
  "type": "module",
  "exports": {
    "./global": "./src/global.ts",
    "./flag/flag": "./src/flag/flag.ts",
    "./installation/version": "./src/installation/version.ts",
    "./util/flock": "./src/util/flock.ts",
    "./util/glob": "./src/util/glob.ts",
    "./util/which": "./src/util/which.ts"
  },
  "dependencies": {
    "effect": "catalog:",
    "minimatch": "10.0.3",
    "which": "6.0.1"
  }
}
```

Create `vendor/opencode-shims/core/src/global.ts`:

```ts
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"

const root = process.env.OWA_HOME ?? join(tmpdir(), "open-web-agent-opencode-tui")

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export function make(input: Partial<Interface> = {}): Interface {
  const paths = {
    home: process.env.HOME ?? root,
    data: join(root, "data"),
    cache: join(root, "cache"),
    config: join(root, "config"),
    state: join(root, "state"),
    tmp: join(root, "tmp"),
    bin: join(root, "bin"),
    log: join(root, "log"),
    repos: join(root, "repos"),
    ...input,
  }
  for (const value of Object.values(paths)) mkdirSync(value, { recursive: true })
  return paths
}

export const layer = Layer.effect(Service, Effect.sync(() => Service.of(make())))
export const defaultLayer = layer
export const layerWith = (input: Partial<Interface>) => Layer.effect(Service, Effect.sync(() => Service.of(make(input))))
export const Global = { Service, make, layer, defaultLayer, layerWith }
```

Create `vendor/opencode-shims/core/src/flag/flag.ts`:

```ts
export const Flag = {
  OPENCODE_DISABLE_MOUSE: false,
  OPENCODE_DISABLE_TERMINAL_TITLE: false,
  OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT: process.platform === "win32",
  OPENCODE_EXPERIMENTAL_WORKSPACES: false,
  OPENCODE_SHOW_TTFD: false,
  OPENCODE_DISABLE_PROJECT_CONFIG: false,
  OPENCODE_EXPERIMENTAL_REFERENCES: false,
  OPENCODE_TUI_CONFIG: undefined,
  OPENCODE_CONFIG_DIR: undefined,
  OPENCODE_PURE: false,
  OPENCODE_PERMISSION: undefined,
  OPENCODE_PLUGIN_META_FILE: undefined,
  OPENCODE_CLIENT: "cli",
}
```

Create `vendor/opencode-shims/core/src/installation/version.ts`:

```ts
export const InstallationVersion = "owa-local"
export const InstallationChannel = "local"
export const InstallationLocal = true
```

Create `vendor/opencode-shims/core/src/util/flock.ts`:

```ts
export const Flock = {
  setGlobal(_input: { state: string }) {},
}
```

Create `vendor/opencode-shims/core/src/util/glob.ts`:

```ts
export const Glob = {
  match(pattern: string, value: string): boolean {
    if (pattern === value) return true
    if (pattern === "*") return true
    return false
  },
}
```

Create `vendor/opencode-shims/core/src/util/which.ts`:

```ts
import which from "which"

export { which }
```

Create `vendor/opencode-shims/plugin/package.json`:

```json
{
  "name": "@opencode-ai/plugin",
  "version": "1.17.11",
  "private": true,
  "type": "module",
  "exports": {
    "./tui": "./src/tui.ts"
  }
}
```

Create `vendor/opencode-shims/plugin/src/tui.ts`:

```ts
export interface TuiPluginStatus {
  id: string
  enabled: boolean
  error?: string
}

export interface TuiPluginInstallOptions {
  enabled?: boolean
}

export type TuiPluginInstallResult = { ok: true } | { ok: false; message: string }

export type TuiAttentionSoundName = "default" | "question" | "permission" | "error" | "done" | "subagent_done"

export interface TuiDialogSelectOption {
  id: string
  label: string
  description?: string
}

export interface TuiRouteCurrent {
  type: string
}

export interface TuiSlotProps {
  children?: unknown
}

export interface TuiSlotContext {
  route?: TuiRouteCurrent
}

export type TuiSlotMap = Record<string, unknown>
export type TuiRouteDefinition = Record<string, unknown>
export type TuiCommand = Record<string, unknown>
export type TuiPluginApi = Record<string, unknown>
export type TuiPlugin = Record<string, unknown>
export type TuiPluginModule = Record<string, unknown>
```

Create `vendor/opencode-shims/ui/package.json`:

```json
{
  "name": "@opencode-ai/ui",
  "version": "1.17.11",
  "private": true,
  "type": "module",
  "exports": {
    "./audio/*": "./audio/*"
  }
}
```

Copy the audio files imported by OpenCode TUI:

```bash
mkdir -p vendor/opencode-shims/ui/audio
cp vendor/opencode/packages/ui/src/assets/audio/bip-bop-01.mp3 vendor/opencode-shims/ui/audio/bip-bop-01.mp3
cp vendor/opencode/packages/ui/src/assets/audio/bip-bop-03.mp3 vendor/opencode-shims/ui/audio/bip-bop-03.mp3
cp vendor/opencode/packages/ui/src/assets/audio/staplebops-06.mp3 vendor/opencode-shims/ui/audio/staplebops-06.mp3
cp vendor/opencode/packages/ui/src/assets/audio/nope-03.mp3 vendor/opencode-shims/ui/audio/nope-03.mp3
cp vendor/opencode/packages/ui/src/assets/audio/yup-01.mp3 vendor/opencode-shims/ui/audio/yup-01.mp3
```

- [ ] **Step 3: Add vendored packages to workspace resolution**

Modify root `package.json` workspaces:

```json
  "workspaces": {
    "packages": [
      "packages/*",
      "vendor/opencode/packages/sdk/js",
      "vendor/opencode/packages/tui",
      "vendor/opencode-shims/core",
      "vendor/opencode-shims/plugin",
      "vendor/opencode-shims/ui"
    ],
    "catalog": {
      "@opentui/core": "0.3.4",
      "@opentui/keymap": "0.3.4",
      "@opentui/solid": "0.3.4",
      "@tsconfig/bun": "1.0.9",
      "@types/bun": "1.3.13",
      "@typescript/native-preview": "7.0.0-dev.20251207.1",
      "cross-spawn": "7.0.6",
      "diff": "8.0.2",
      "effect": "4.0.0-beta.83",
      "fuzzysort": "3.1.0",
      "opentui-spinner": "0.0.7",
      "remeda": "2.26.0",
      "solid-js": "1.9.10",
      "typescript": "5.8.2"
    }
  }
```

- [ ] **Step 4: Install workspace dependencies**

Run:

```bash
bun install
```

Expected: PASS. `bun.lock` updates to include vendored OpenCode workspace packages and their runtime dependencies.

- [ ] **Step 5: Wire the launcher to OpenCode TUI**

Modify `packages/opencode-tui/package.json`:

```json
{
  "dependencies": {
    "@opencode-ai/core": "workspace:*",
    "@opencode-ai/sdk": "workspace:*",
    "@opencode-ai/tui": "workspace:*",
    "effect": "catalog:"
  }
}
```

Modify `packages/opencode-tui/src/index.ts`:

```ts
import { Effect } from "effect"
import { run } from "@opencode-ai/tui"
import { Global } from "@opencode-ai/core/global"
import { TuiConfig } from "@opencode-ai/tui/config"
import type { TuiInput } from "@opencode-ai/tui"
import type { TuiPluginHost } from "@opencode-ai/tui/plugin/runtime"

export interface LaunchOpenCodeTuiOptions {
  serverUrl: string
  projectPath: string
  continueLast?: boolean
  sessionId?: string
}

export async function launchOpenCodeTui(options: LaunchOpenCodeTuiOptions): Promise<void> {
  const input: TuiInput = {
    url: `${options.serverUrl.replace(/\/$/, "")}/opencode`,
    directory: options.projectPath,
    args: {
      prompt: undefined,
      continue: options.continueLast,
      sessionID: options.sessionId,
      fork: false,
      model: undefined,
      agent: undefined,
    },
    config: TuiConfig.resolve({
      theme: "system",
      mouse: true,
    }, { terminalSuspend: false }),
    pluginHost: createNoopPluginHost(),
  }

  await Effect.runPromise(run(input).pipe(Effect.provide(Global.defaultLayer)))
}

function createNoopPluginHost(): TuiPluginHost {
  return {
    async start() {},
    async dispose() {},
  }
}
```

- [ ] **Step 6: Typecheck the launcher**

Run:

```bash
bun run typecheck
```

Expected: PASS. If vendored OpenCode package TypeScript settings conflict with OWA `tsc -b`, keep vendored packages out of root `tsconfig.json` references and rely on Bun workspace resolution for runtime imports.

- [ ] **Step 7: Commit Task 8**

```bash
git add package.json bun.lock packages/opencode-tui vendor/opencode vendor/opencode-shims
git commit -m "[add] vendor opencode tui source"
```

## Task 9: Add Unsupported Mutating Responses

**Files:**
- Modify: `packages/server/src/routes/opencode.ts`
- Modify: `packages/server/src/app.test.ts`

- [ ] **Step 1: Add tests for unsupported mutating routes**

Append to `packages/server/src/app.test.ts`:

```ts
  it("returns explicit unsupported errors for OpenCode actions outside the compat milestone", async () => {
    const { request } = await setup()
    const created = await request("/sessions", {
      method: "POST",
      body: JSON.stringify({ projectPath: "/tmp/project" }),
    }).then((response) => response.json() as Promise<{ sessionId: string }>)

    for (const [method, path] of [
      ["POST", `/opencode/session/${created.sessionId}/fork`],
      ["POST", `/opencode/session/${created.sessionId}/share`],
      ["POST", "/opencode/global/upgrade"],
      ["POST", "/opencode/provider/oauth"],
    ] as const) {
      const response = await request(path, { method, body: JSON.stringify({}) })
      expect(response.status).toBe(501)
      await expect(response.json()).resolves.toEqual({ error: { message: "Unsupported by OWA OpenCode compatibility layer" } })
    }
  })
```

- [ ] **Step 2: Run the unsupported route test and verify it fails**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/server/src/app.test.ts -t "unsupported errors"
```

Expected: FAIL with 404 responses.

- [ ] **Step 3: Add explicit unsupported handlers**

Modify `packages/server/src/routes/opencode.ts`:

```ts
  for (const route of [
    "/opencode/session/:sessionId/fork",
    "/opencode/session/:sessionId/share",
    "/opencode/global/upgrade",
    "/opencode/provider/oauth",
  ]) {
    app.post(route, (c) => unsupported(c))
  }

function unsupported(c: { json: (body: unknown, status?: number) => Response }) {
  return c.json({ error: { message: "Unsupported by OWA OpenCode compatibility layer" } }, 501)
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/server/src/app.test.ts -t "unsupported errors"
```

Expected: PASS.

- [ ] **Step 5: Run all source tests**

Run:

```bash
bun run test
```

Expected: PASS.

- [ ] **Step 6: Commit Task 9**

```bash
git add packages/server/src/routes/opencode.ts packages/server/src/app.test.ts
git commit -m "[add] report unsupported opencode tui actions"
```

## Task 10: Final Verification And Manual Smoke

**Files:**
- No source changes expected unless verification exposes a defect.

- [ ] **Step 1: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run all tests**

Run:

```bash
bun run test
```

Expected: PASS.

- [ ] **Step 3: Smoke native TUI selection**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun run packages/cli/src/index.ts --tui owa
```

Expected: native OWA TUI opens. Exit it with the existing quit command.

- [ ] **Step 4: Smoke server-only compat API**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun run packages/cli/src/index.ts serve --port 4096 --hostname 127.0.0.1
```

In a second terminal:

```bash
curl -s http://127.0.0.1:4096/opencode/global/health
curl -s http://127.0.0.1:4096/opencode/agent
curl -s http://127.0.0.1:4096/opencode/config/providers
```

Expected: health returns `{"ok":true}`, agents returns an array, providers returns an object with `providers` and `default`.

- [ ] **Step 5: Smoke OpenCode TUI selection**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun run packages/cli/src/index.ts --tui opencode
```

Expected: OpenCode TUI starts against `<runtime-url>/opencode`, displays the local OWA agents and models, accepts a prompt, and shows a final answer. Exit it with the OpenCode TUI quit flow.

- [ ] **Step 6: Commit verification fixes if any were needed**

If a verification command exposed a defect and a code fix was made:

```bash
git add <changed-files>
git commit -m "[fix] stabilize opencode tui compatibility"
```

If no changes were needed, do not create a verification-only commit.
