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
    complete: async () => ({ id: "resp", text: "ok", toolCalls: [], raw: null, usage: null, latencyMs: 0 }),
  },
  {
    id: "openrouter:anthropic/claude-sonnet-4.6",
    name: "OpenRouter",
    provider: "openrouter",
    modelName: "anthropic/claude-sonnet-4.6",
    contextWindowTokens: 200_000,
    complete: async () => ({ id: "resp", text: "ok", toolCalls: [], raw: null, usage: null, latencyMs: 0 }),
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
