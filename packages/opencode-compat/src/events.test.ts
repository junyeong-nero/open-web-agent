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

  it("projects run completion with custom assistant metadata", () => {
    const projected = projectRunEvent(event("run.completed", { finalAnswer: "done" }), {
      directory: "/work/open-web-agent",
      agentId: "see-act",
      modelId: "openrouter:anthropic/claude-sonnet-4.6",
    })

    expect(projected[0]?.payload.type).toBe("message.updated")
    expect(projected[0]?.payload.properties.info).toMatchObject({
      agent: "see-act",
      modelID: "openrouter:anthropic/claude-sonnet-4.6",
      providerID: "openrouter",
    })
  })

  it("projects failed and cancelled runs as idle status", () => {
    expect(projectRunEvent(event("run.failed"), { directory: "/work/open-web-agent" })).toEqual([
      {
        directory: "/work/open-web-agent",
        payload: {
          id: "owa_evt_run.failed_status",
          type: "session.status",
          properties: {
            sessionID: "ses_123",
            status: { type: "idle" },
          },
        },
      },
    ])
    expect(projectRunEvent(event("run.cancelled"), { directory: "/work/open-web-agent" })).toEqual([
      {
        directory: "/work/open-web-agent",
        payload: {
          id: "owa_evt_run.cancelled_status",
          type: "session.status",
          properties: {
            sessionID: "ses_123",
            status: { type: "idle" },
          },
        },
      },
    ])
  })

  it("projects browser action, observation, and plan events as synthetic assistant text parts", () => {
    expect(projectRunEvent(event("browser.action.completed"), { directory: "/work/open-web-agent" })[0]?.payload.properties).toMatchObject({
      part: { text: "browser action completed", synthetic: true, metadata: { owaEventType: "browser.action.completed" } },
    })
    expect(
      projectRunEvent(
        event("observation.captured", {
          observation: { title: "Example Domain", url: "https://example.com" },
        }),
        { directory: "/work/open-web-agent" },
      )[0]?.payload.properties,
    ).toMatchObject({
      part: { text: "Example Domain https://example.com", synthetic: true, metadata: { owaEventType: "observation.captured" } },
    })
    expect(projectRunEvent(event("plan.updated"), { directory: "/work/open-web-agent" })[0]?.payload.properties).toMatchObject({
      part: { text: "plan updated", synthetic: true, metadata: { owaEventType: "plan.updated" } },
    })
    expect(projectRunEvent(event("plan.created"), { directory: "/work/open-web-agent" })[0]?.payload.properties).toMatchObject({
      part: { text: "plan updated", synthetic: true, metadata: { owaEventType: "plan.created" } },
    })
  })

  it("uses fallbacks for incomplete synthetic event payloads", () => {
    expect(projectRunEvent(event("browser.tool.completed"), { directory: "/work/open-web-agent" })[0]?.payload.properties).toMatchObject({
      part: { text: "browser tool: completed" },
    })
    expect(projectRunEvent(event("observation.captured"), { directory: "/work/open-web-agent" })[0]?.payload.properties).toMatchObject({
      part: { text: "observation captured" },
    })
  })

  it("ignores events without an OpenCode projection", () => {
    expect(projectRunEvent(event("agent.step.started"), { directory: "/work/open-web-agent" })).toEqual([])
  })
})
