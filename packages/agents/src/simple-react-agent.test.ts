import { describe, expect, it } from "bun:test"
import { EventBus, type AgentState, type ModelPlugin, type ModelRequest, type ModelResponse, type RuntimeContext } from "@open-web-agent/core"
import { formatObservationForPrompt, SimpleReActAgent } from "./simple-react-agent"

function state(): AgentState {
  return {
    session: {
      id: "ses_1",
      projectPath: "/tmp/project",
      projectHash: "hash",
      createdAt: "2026-06-17T00:00:00.000Z",
    },
    runId: "run_1",
    prompt: "Read the title",
    steps: [],
    lastObservation: {
      url: "https://example.com/",
      title: "Example Domain",
      text: "Example Domain\nExample text",
      screenshotPath: null,
      interactiveElements: [
        {
          id: "element_1",
          role: "button",
          name: "Continue",
          text: "Continue",
          selector: "#continue",
          xpath: null,
          boundingBox: null,
          attributes: {},
        },
      ],
      metadata: {},
    },
    finalAnswer: null,
  }
}

function ctx(): RuntimeContext {
  return {
    session: state().session,
    runId: "run_1",
    runDir: "/tmp/run",
    eventBus: new EventBus(),
    abortSignal: new AbortController().signal,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    async emit() {
      throw new Error("not used")
    },
  }
}

class FakeModel implements ModelPlugin {
  id = "fake-model"
  name = "Fake Model"
  provider = "test"
  requests: ModelRequest[] = []

  constructor(private readonly responses: string[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request)
    return {
      id: "response_1",
      text: this.responses.shift() ?? "",
      raw: {},
      usage: null,
      latencyMs: 0,
    }
  }
}

describe("formatObservationForPrompt", () => {
  it("includes URL, title, text, and interactive elements", () => {
    expect(formatObservationForPrompt(state().lastObservation)).toContain("URL: https://example.com/")
    expect(formatObservationForPrompt(state().lastObservation)).toContain("Title: Example Domain")
    expect(formatObservationForPrompt(state().lastObservation)).toContain("#continue")
  })
})

describe("SimpleReActAgent", () => {
  it("parses browser action model decisions", async () => {
    const model = new FakeModel([
      JSON.stringify({
        type: "browser_actions",
        thought: "Click continue.",
        actions: [
          {
            id: "action_1",
            kind: "continue",
            reason: null,
            requiresApproval: false,
            toolCalls: [
              {
                id: "tool_1",
                type: "click",
                target: { selector: "#continue" },
              },
            ],
          },
        ],
      }),
    ])
    const decision = await new SimpleReActAgent({ model, modelName: "fake" }).step(state(), ctx())

    expect(decision.type).toBe("browser_actions")
    expect(model.requests[0]?.responseFormat).toBe("json")
  })

  it("retries once after invalid JSON", async () => {
    const model = new FakeModel([
      "not json",
      JSON.stringify({ type: "final_answer", thought: null, finalAnswer: "done", confidence: 1 }),
    ])
    const decision = await new SimpleReActAgent({ model, modelName: "fake" }).step(state(), ctx())

    expect(decision).toMatchObject({ type: "final_answer", finalAnswer: "done" })
    expect(model.requests).toHaveLength(2)
  })

  it("throws with raw model output after retry failure", async () => {
    const model = new FakeModel(["not json", JSON.stringify({ type: "tool_calls", toolCalls: [] })])

    await expect(new SimpleReActAgent({ model, modelName: "fake" }).step(state(), ctx())).rejects.toThrow(
      "Invalid model decision",
    )
  })

  it("times out slow model calls", async () => {
    const model: ModelPlugin = {
      id: "slow",
      name: "Slow",
      provider: "test",
      complete: () => new Promise(() => {}),
    }

    await expect(new SimpleReActAgent({ model, modelName: "fake", timeoutMs: 5 }).step(state(), ctx())).rejects.toThrow(
      "timed out",
    )
  })
})
