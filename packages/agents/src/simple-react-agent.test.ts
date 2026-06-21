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

function searchState(): AgentState {
  const next = state()
  next.prompt = "naver.com 에서 내일 날씨 검색해줘"
  next.lastObservation = {
    ...next.lastObservation!,
    url: "https://www.naver.com/",
    title: "NAVER",
    text: "검색",
    interactiveElements: [
      {
        id: "query",
        role: "combobox",
        name: "검색어를 입력해 주세요.",
        text: null,
        selector: "#query",
        xpath: null,
        boundingBox: null,
        attributes: { type: "search", name: "query" },
      },
      {
        id: "search-btn",
        role: "button",
        name: "",
        text: "검색",
        selector: "#search-btn",
        xpath: null,
        boundingBox: null,
        attributes: { type: "submit" },
      },
    ],
  }
  return next
}

const defaultBrowserTools: RuntimeContext["browserTools"] = [
  {
    type: "type",
    description: "Fill text into an editable element.",
    parameters: [
      { name: "target", type: "ActionTarget", required: true, description: "Editable element to fill." },
      { name: "value", type: "string", required: true, description: "Text to enter." },
    ],
    example: { id: "tool_1", type: "type", target: { selector: 'input[name="query"]' }, value: "tomorrow weather" },
  },
  {
    type: "click",
    description: "Click an interactive element.",
    parameters: [{ name: "target", type: "ActionTarget", required: true, description: "Element to click." }],
    example: { id: "tool_2", type: "click", target: { selector: 'button[type="submit"]' } },
  },
]

function ctx(browserTools: RuntimeContext["browserTools"] = defaultBrowserTools): RuntimeContext {
  return {
    session: state().session,
    runId: "run_1",
    runDir: "/tmp/run",
    browserTools,
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
    expect(model.requests[0]).not.toHaveProperty("temperature")
  })

  it("includes failed browser results in the model prompt", async () => {
    const failedState = state()
    failedState.steps.push({
      id: "step_1",
      decision: null,
      observation: failedState.lastObservation,
      actionResults: [
        {
          ok: false,
          message: "locator.click: Timeout 30000ms exceeded",
          observation: failedState.lastObservation,
          metadata: {},
        },
      ],
    })
    const model = new FakeModel([
      JSON.stringify({ type: "final_answer", thought: null, finalAnswer: "done", confidence: 1 }),
    ])

    await new SimpleReActAgent({ model, modelName: "fake" }).step(failedState, ctx())

    const prompt = model.requests[0]?.messages.at(-1)?.content
    expect(prompt).toContain("Failed browser results:")
    expect(prompt).toContain("locator.click: Timeout 30000ms exceeded")
  })

  it("describes concrete click and type target shapes in the model prompt", async () => {
    const model = new FakeModel([JSON.stringify({ type: "final_answer", thought: null, finalAnswer: "done", confidence: 1 })])

    await new SimpleReActAgent({ model, modelName: "fake" }).step(state(), ctx())

    const systemPrompt = model.requests[0]?.messages.find((message) => message.role === "system")?.content ?? ""
    expect(systemPrompt).toContain('"type":"type"')
    expect(systemPrompt).toContain('"target":{"selector":"input[name=\\"query\\"]"}')
    expect(systemPrompt).toContain('"value":"tomorrow weather"')
    expect(systemPrompt).toContain('"type":"click"')
    expect(systemPrompt).toContain('"target":{"selector":"button[type=\\"submit\\"]"}')
  })

  it("renders runtime browser tool definitions in the model prompt", async () => {
    const model = new FakeModel([JSON.stringify({ type: "final_answer", thought: null, finalAnswer: "done", confidence: 1 })])

    await new SimpleReActAgent({ model, modelName: "fake" }).step(
      state(),
      ctx([
        {
          type: "navigate",
          description: "Open an absolute URL in the current browser page.",
          parameters: [{ name: "url", type: "string", required: true, description: "Absolute URL to open." }],
          example: { id: "tool_1", type: "navigate", url: "https://example.com" },
        },
        {
          type: "screenshot",
          description: "Capture a full-page screenshot for visual inspection.",
          parameters: [],
          example: { id: "tool_2", type: "screenshot" },
        },
      ]),
    )

    const systemPrompt = model.requests[0]?.messages.find((message) => message.role === "system")?.content ?? ""
    expect(systemPrompt).toContain("Available browser tools:")
    expect(systemPrompt).toContain("- navigate: Open an absolute URL in the current browser page.")
    expect(systemPrompt).toContain("Parameters: url (string, required) - Absolute URL to open.")
    expect(systemPrompt).toContain('Example: {"id":"tool_1","type":"navigate","url":"https://example.com"}')
    expect(systemPrompt).toContain("- screenshot: Capture a full-page screenshot for visual inspection.")
    expect(systemPrompt).toContain("Parameters: none")
    expect(systemPrompt).toContain('Example: {"id":"tool_2","type":"screenshot"}')
  })

  it("normalizes OpenAI-style tool call arguments in model decisions", async () => {
    const model = new FakeModel([
      JSON.stringify({
        type: "browser_actions",
        thought: "Navigate first.",
        actions: [
          {
            id: "navigate_naver",
            kind: "navigate",
            reason: "Navigate to naver.com.",
            requiresApproval: false,
            toolCalls: [
              {
                type: "navigate",
                arguments: {
                  url: "https://www.naver.com",
                },
              },
            ],
          },
        ],
      }),
    ])

    const decision = await new SimpleReActAgent({ model, modelName: "fake" }).step(state(), ctx())

    expect(decision).toMatchObject({
      type: "browser_actions",
      actions: [
        {
          id: "navigate_naver",
          toolCalls: [
            {
              id: "navigate_naver_tool_1",
              type: "navigate",
              url: "https://www.naver.com",
            },
          ],
        },
      ],
    })
  })

  it("normalizes model args aliases in browser tool calls", async () => {
    const model = new FakeModel([
      JSON.stringify({
        type: "browser_actions",
        thought: "Navigate first.",
        actions: [
          {
            id: "navigate_naver",
            kind: "navigate",
            reason: "Navigate to naver.com.",
            requiresApproval: false,
            toolCalls: [
              {
                name: "navigate",
                args: {
                  url: "https://www.naver.com",
                },
              },
            ],
          },
        ],
      }),
    ])

    const decision = await new SimpleReActAgent({ model, modelName: "fake" }).step(state(), ctx())

    expect(decision).toMatchObject({
      type: "browser_actions",
      actions: [
        {
          id: "navigate_naver",
          toolCalls: [
            {
              id: "navigate_naver_tool_1",
              type: "navigate",
              url: "https://www.naver.com",
            },
          ],
        },
      ],
    })
  })

  it("normalizes OpenAI-style tool call names in model decisions", async () => {
    const model = new FakeModel([
      JSON.stringify({
        type: "browser_actions",
        thought: "Navigate first.",
        actions: [
          {
            id: "navigate_naver",
            kind: "navigate",
            reason: "Navigate to naver.com.",
            requiresApproval: false,
            toolCalls: [
              {
                name: "navigate",
                arguments: {
                  url: "https://www.naver.com",
                },
              },
            ],
          },
        ],
      }),
    ])

    const decision = await new SimpleReActAgent({ model, modelName: "fake" }).step(state(), ctx())

    expect(decision).toMatchObject({
      type: "browser_actions",
      actions: [
        {
          id: "navigate_naver",
          toolCalls: [
            {
              id: "navigate_naver_tool_1",
              type: "navigate",
              url: "https://www.naver.com",
            },
          ],
        },
      ],
    })
  })

  it("normalizes model ref and text aliases in browser tool calls", async () => {
    const model = new FakeModel([
      JSON.stringify({
        type: "browser_actions",
        thought: "Search Naver.",
        actions: [
          {
            id: "action_1",
            kind: "search",
            reason: "Enter query and submit.",
            requiresApproval: false,
            toolCalls: [
              {
                id: "tool_1",
                type: "type",
                ref: "query",
                text: "내일 날씨",
              },
              {
                id: "tool_2",
                type: "click",
                ref: "search-btn",
              },
            ],
          },
        ],
      }),
    ])

    const decision = await new SimpleReActAgent({ model, modelName: "fake" }).step(state(), ctx())

    expect(decision).toMatchObject({
      type: "browser_actions",
      actions: [
        {
          toolCalls: [
            {
              id: "tool_1",
              type: "type",
              target: { selector: "#query" },
              value: "내일 날씨",
            },
            {
              id: "tool_2",
              type: "click",
              target: { selector: "#search-btn" },
            },
          ],
        },
      ],
    })
  })

  it("normalizes model kind aliases in browser tool calls", async () => {
    const model = new FakeModel([
      JSON.stringify({
        type: "browser_actions",
        thought: "Search Naver.",
        actions: [
          {
            id: "action_1",
            kind: "search",
            reason: "Enter query and submit.",
            requiresApproval: false,
            toolCalls: [
              {
                id: "tool_1",
                kind: "type",
                ref: "query",
                text: "내일 날씨",
              },
              {
                id: "tool_2",
                kind: "click",
                ref: "search-btn",
              },
            ],
          },
        ],
      }),
    ])

    const decision = await new SimpleReActAgent({ model, modelName: "fake" }).step(state(), ctx())

    expect(decision).toMatchObject({
      type: "browser_actions",
      actions: [
        {
          toolCalls: [
            {
              id: "tool_1",
              type: "type",
              target: { selector: "#query" },
              value: "내일 날씨",
            },
            {
              id: "tool_2",
              type: "click",
              target: { selector: "#search-btn" },
            },
          ],
        },
      ],
    })
  })

  it("normalizes selector shorthand in browser tool calls", async () => {
    const model = new FakeModel([
      JSON.stringify({
        type: "browser_actions",
        thought: "네이버에 접속하여 내일 날씨를 검색하겠습니다.",
        actions: [
          {
            id: "1",
            kind: "navigate",
            reason: "네이버 메인 페이지 접속",
            requiresApproval: false,
            toolCalls: [{ type: "navigate", url: "https://www.naver.com" }],
          },
          {
            id: "2",
            kind: "type",
            reason: "네이버 검색창에 내일 날씨 입력",
            requiresApproval: false,
            toolCalls: [{ type: "type", selector: "input[name='query']", text: "내일 날씨" }],
          },
          {
            id: "3",
            kind: "click",
            reason: "검색 버튼 클릭",
            requiresApproval: false,
            toolCalls: [{ type: "click", selector: "button.spm" }],
          },
        ],
      }),
    ])

    const decision = await new SimpleReActAgent({ model, modelName: "fake", maxParseRetries: 0 }).step(state(), ctx())

    expect(decision).toMatchObject({
      type: "browser_actions",
      actions: [
        {
          toolCalls: [{ id: "1_tool_1", type: "navigate", url: "https://www.naver.com" }],
        },
        {
          toolCalls: [
            { id: "2_tool_1", type: "type", target: { selector: "input[name='query']" }, value: "내일 날씨" },
          ],
        },
        {
          toolCalls: [{ id: "3_tool_1", type: "click", target: { selector: "button.spm" } }],
        },
      ],
    })
  })

  it("normalizes navigate target URLs in browser tool calls", async () => {
    const model = new FakeModel([
      JSON.stringify({
        type: "browser_actions",
        thought: "Search today's KOSPI index on Naver.",
        actions: [
          {
            id: "action_1",
            kind: "navigate",
            reason: "Navigate to naver.com to search for KOSPI index",
            requiresApproval: false,
            toolCalls: [
              {
                type: "navigate",
                target: { url: "https://www.naver.com" },
              },
            ],
          },
        ],
      }),
    ])

    const decision = await new SimpleReActAgent({ model, modelName: "fake", maxParseRetries: 0 }).step(state(), ctx())

    expect(decision).toMatchObject({
      type: "browser_actions",
      actions: [
        {
          toolCalls: [
            {
              id: "action_1_tool_1",
              type: "navigate",
              url: "https://www.naver.com",
            },
          ],
        },
      ],
    })
  })

  it("repairs empty search targets from the current observation", async () => {
    const model = new FakeModel([
      JSON.stringify({
        type: "browser_actions",
        thought: "Search Naver.",
        actions: [
          {
            id: "action_1",
            kind: "type",
            reason: "검색창에 '내일 날씨' 입력",
            requiresApproval: false,
            toolCalls: [
              {
                id: "tool_1",
                type: "click",
                target: {},
              },
              {
                id: "tool_2",
                type: "type",
                target: {},
                value: "내일 날씨",
              },
            ],
          },
          {
            id: "action_2",
            kind: "click",
            reason: "검색 버튼 클릭",
            requiresApproval: false,
            toolCalls: [
              {
                id: "tool_3",
                type: "click",
                target: {},
              },
            ],
          },
        ],
      }),
    ])

    const decision = await new SimpleReActAgent({ model, modelName: "fake" }).step(searchState(), ctx())

    expect(decision).toMatchObject({
      type: "browser_actions",
      actions: [
        {
          toolCalls: [
            { id: "tool_1", type: "click", target: { selector: "#query" } },
            { id: "tool_2", type: "type", target: { selector: "#query" }, value: "내일 날씨" },
          ],
        },
        {
          toolCalls: [{ id: "tool_3", type: "click", target: { selector: "#search-btn" } }],
        },
      ],
    })
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

  it("includes validation errors when model decisions remain invalid", async () => {
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
            toolCalls: [{ id: "tool_1", type: "click" }],
          },
        ],
      }),
    ])

    await expect(
      new SimpleReActAgent({ model, modelName: "fake", maxParseRetries: 0 }).step(state(), ctx()),
    ).rejects.toThrow("Last error:")
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
