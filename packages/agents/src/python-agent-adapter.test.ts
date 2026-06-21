import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  EventBus,
  type AgentState,
  type BrowserToolDefinition,
  type ModelPlugin,
  type ModelRequest,
  type ModelResponse,
  type RunEvent,
  type RunEventType,
  type RuntimeContext,
} from "@open-web-agent/core"
import { PythonAgentAdapter } from "./python-agent-adapter"

const python = process.env.PYTHON ?? "python3"
const repoAgentsDir = resolve(import.meta.dir, "../../../agents")
const commonImportPrelude = `
import sys
sys.path.insert(0, ${JSON.stringify(repoAgentsDir)})
`

function state(): AgentState {
  return {
    session: {
      id: "ses_1",
      projectPath: "/tmp/project",
      projectHash: "hash",
      createdAt: "2026-06-17T00:00:00.000Z",
    },
    runId: "run_1",
    prompt: "Read example.com",
    steps: [],
    lastObservation: {
      url: "https://example.com/",
      title: "Example Domain",
      text: "Example Domain\nThis domain is for examples.",
      screenshotPath: "/tmp/run/screenshots/step-0001.txt",
      interactiveElements: [],
      metadata: {},
    },
    finalAnswer: null,
  }
}

function ctx(
  signalOrOptions:
    | AbortSignal
    | {
        signal?: AbortSignal
        browserTools?: BrowserToolDefinition[]
      } = new AbortController().signal,
): RuntimeContext & { emitted: Array<{ type: RunEventType; payload: Record<string, unknown> }> } {
  const emitted: Array<{ type: RunEventType; payload: Record<string, unknown> }> = []
  const session = state().session
  const signal = signalOrOptions instanceof AbortSignal ? signalOrOptions : (signalOrOptions.signal ?? new AbortController().signal)
  const browserTools = signalOrOptions instanceof AbortSignal ? [] : (signalOrOptions.browserTools ?? [])

  return {
    session,
    runId: "run_1",
    runDir: "/tmp/run",
    agentId: "python-test-agent",
    environmentId: "test-browser",
    browserTools,
    eventBus: new EventBus(),
    abortSignal: signal,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    emitted,
    async emit(type, payload, stepId = null): Promise<RunEvent> {
      emitted.push({ type, payload })
      return {
        id: `evt_${emitted.length}`,
        runId: "run_1",
        sessionId: session.id,
        stepId,
        sequence: emitted.length - 1,
        type,
        payload,
        createdAt: "2026-06-17T00:00:00.000Z",
      }
    },
  }
}

const defaultBrowserTools: BrowserToolDefinition[] = [
  {
    type: "navigate",
    description: "Open an absolute URL in the current browser page.",
    parameters: [{ name: "url", type: "string", required: true, description: "Absolute URL to open." }],
    example: { id: "tool_1", type: "navigate", url: "https://example.com" },
  },
  {
    type: "click",
    description: "Click an interactive element or coordinate on the current page.",
    parameters: [{ name: "target", type: "ActionTarget", required: true, description: "Element or coordinates to click." }],
    example: { id: "tool_2", type: "click", target: { selector: 'button[type="submit"]' } },
  },
]

async function writePythonScript(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "owa-python-agent-test-"))
  const path = join(dir, "agent.py")
  await writeFile(path, contents)
  return path
}

class FakeModel implements ModelPlugin {
  id = "fake-model"
  name = "Fake Model"
  provider = "fake"
  requests: ModelRequest[] = []

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request)
    return {
      id: "fake-response",
      text: "model delegated answer",
      raw: { ok: true },
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      latencyMs: 4,
    }
  }
}

function messageText(content: ModelRequest["messages"][number]["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content)
}

class SequenceModel extends FakeModel {
  constructor(private readonly responses: string[]) {
    super()
  }

  override async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request)
    return {
      id: `fake-response-${this.requests.length}`,
      text: this.responses.shift() ?? this.responses.at(-1) ?? "",
      raw: { ok: true },
      usage: null,
      latencyMs: 0,
    }
  }
}

describe("PythonAgentAdapter", () => {
  it("runs BaseAgent subclasses that return final answers", async () => {
    const script = await writePythonScript(`
${commonImportPrelude}
from _common.agent import BaseAgent

class FixtureAgent(BaseAgent):
    def step(self, ctx):
        return ctx.final_answer(f"handled: {ctx.prompt}", thought="fixture")

if __name__ == "__main__":
    FixtureAgent().run()
`)
    const agent = new PythonAgentAdapter({
      id: "python-base-agent",
      name: "Python Base Agent",
      description: "Uses BaseAgent",
      command: [python, script],
      protocol: "jsonl",
    })

    const decision = await agent.step(state(), ctx())

    expect(decision).toEqual({
      type: "final_answer",
      thought: "fixture",
      finalAnswer: "handled: Read example.com",
      confidence: 1,
    })
  })

  it("lets BaseAgent subclasses request JSON from the runtime model", async () => {
    class JsonModel extends FakeModel {
      override async complete(request: ModelRequest): Promise<ModelResponse> {
        this.requests.push(request)
        return {
          id: "json-response",
          text: JSON.stringify({ answer: "model json answer" }),
          raw: { ok: true },
          usage: null,
          latencyMs: 0,
        }
      }
    }
    const script = await writePythonScript(`
${commonImportPrelude}
from _common.agent import BaseAgent

class FixtureAgent(BaseAgent):
    def step(self, ctx):
        parsed = ctx.model.complete_json(
            system="Return JSON.",
            user=ctx.observation_text(),
        )
        return ctx.final_answer(parsed["answer"], thought="json")

if __name__ == "__main__":
    FixtureAgent().run()
`)
    const model = new JsonModel()
    const agent = new PythonAgentAdapter({
      id: "python-base-model-agent",
      name: "Python Base Model Agent",
      description: "Uses BaseAgent model helpers",
      command: [python, script],
      protocol: "jsonl",
      model,
    })

    const decision = await agent.step(state(), ctx())

    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]).toMatchObject({
      responseFormat: "json",
      messages: [
        { role: "system", content: "Return JSON." },
        { role: "user" },
      ],
    })
    expect(model.requests[0]).not.toHaveProperty("temperature")
    expect(decision).toMatchObject({ type: "final_answer", finalAnswer: "model json answer" })
  })

  it("lets BaseAgent model helpers explicitly request temperature", async () => {
    class JsonModel extends FakeModel {
      override async complete(request: ModelRequest): Promise<ModelResponse> {
        this.requests.push(request)
        return {
          id: "json-response",
          text: JSON.stringify({ answer: "model json answer" }),
          raw: { ok: true },
          usage: null,
          latencyMs: 0,
        }
      }
    }
    const script = await writePythonScript(`
${commonImportPrelude}
from _common.agent import BaseAgent

class FixtureAgent(BaseAgent):
    def step(self, ctx):
        parsed = ctx.model.complete_json(
            system="Return JSON.",
            user=ctx.observation_text(),
            temperature=0,
        )
        return ctx.final_answer(parsed["answer"], thought="json")

if __name__ == "__main__":
    FixtureAgent().run()
`)
    const model = new JsonModel()
    const agent = new PythonAgentAdapter({
      id: "python-base-model-agent",
      name: "Python Base Model Agent",
      description: "Uses BaseAgent model helpers",
      command: [python, script],
      protocol: "jsonl",
      model,
    })

    const decision = await agent.step(state(), ctx())

    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]).toMatchObject({ temperature: 0, responseFormat: "json" })
    expect(decision).toMatchObject({ type: "final_answer", finalAnswer: "model json answer" })
  })

  it("lets BaseAgent subclasses emit events and browser action decisions", async () => {
    const script = await writePythonScript(`
${commonImportPrelude}
from _common.agent import BaseAgent

class FixtureAgent(BaseAgent):
    def step(self, ctx):
        ctx.events.plan_created([
            {"id": "open", "title": "Open the page", "status": "active"},
        ])
        return ctx.actions.navigate("open_example", "https://example.com", reason="Open example.com")

if __name__ == "__main__":
    FixtureAgent().run()
`)
    const runtimeContext = ctx()
    const agent = new PythonAgentAdapter({
      id: "python-base-action-agent",
      name: "Python Base Action Agent",
      description: "Uses BaseAgent action helpers",
      command: [python, script],
      protocol: "jsonl",
    })

    const decision = await agent.step(
      { ...state(), lastObservation: { ...state().lastObservation!, url: "about:blank" } },
      runtimeContext,
    )

    expect(runtimeContext.emitted).toEqual([
      {
        type: "plan.created",
        payload: {
          items: [{ id: "open", title: "Open the page", status: "active" }],
        },
      },
    ])
    expect(decision).toEqual({
      type: "browser_actions",
      thought: "Open example.com",
      actions: [
        {
          id: "open_example",
          kind: "navigate",
          reason: "Open example.com",
          requiresApproval: false,
          toolCalls: [{ id: "open_example_tool", type: "navigate", url: "https://example.com" }],
        },
      ],
    })
  })

  it("sends lifecycle requests and parses step decisions", async () => {
    const logPath = join(await mkdtemp(join(tmpdir(), "owa-python-agent-log-")), "requests.jsonl")
    const script = await writePythonScript(`
import json
import os
import sys

request = json.load(sys.stdin)
with open(os.environ["REQUEST_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps(request, sort_keys=True) + "\\n")

if request["method"] == "step":
    print(json.dumps({
        "events": [
            {
                "type": "plan.created",
                "payload": {
                    "items": [
                        {"id": "grounding", "title": "Ground text and screenshot", "status": "completed"}
                    ]
                }
            }
        ],
        "decision": {
            "type": "final_answer",
            "thought": "Text and screenshot are both present.",
            "finalAnswer": "grounded",
            "confidence": 1
        }
    }))
elif request["method"] == "finalize":
    print(json.dumps({"finalAnswer": request["state"]["finalAnswer"] or "fallback"}))
else:
    print(json.dumps({"ok": True}))
`)
    const runtimeContext = ctx()
    const agent = new PythonAgentAdapter({
      id: "python-test-agent",
      name: "Python Test Agent",
      description: "Test adapter",
      command: [python, script],
      env: { REQUEST_LOG: logPath },
    })

    await agent.initialize(runtimeContext)
    const decision = await agent.step(state(), runtimeContext)
    const finalAnswer = await agent.finalize({ ...state(), finalAnswer: "grounded" }, runtimeContext)
    const requests = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))

    expect(requests.map((request) => request.method)).toEqual(["initialize", "step", "finalize"])
    expect(requests[1].state.lastObservation.screenshotPath).toBe("/tmp/run/screenshots/step-0001.txt")
    expect(requests[1].context.eventBus).toBeUndefined()
    expect(requests[1].context.abortSignal).toBeUndefined()
    expect(runtimeContext.emitted).toEqual([
      {
        type: "plan.created",
        payload: {
          items: [{ id: "grounding", title: "Ground text and screenshot", status: "completed" }],
        },
      },
    ])
    expect(decision).toEqual({
      type: "final_answer",
      thought: "Text and screenshot are both present.",
      finalAnswer: "grounded",
      confidence: 1,
    })
    expect(finalAnswer).toBe("grounded")
  })

  it("lets jsonl Python agents delegate model calls to the runtime model", async () => {
    const script = await writePythonScript(`
import json
import sys

request = json.loads(sys.stdin.readline())
print(json.dumps({
    "command": "model.complete",
    "id": "model_1",
    "request": {
        "model": "test-model",
        "messages": [{"role": "user", "content": "answer from model"}],
        "temperature": 0,
        "responseFormat": "text"
    }
}), flush=True)
model_response = json.loads(sys.stdin.readline())
print(json.dumps({
    "decision": {
        "type": "final_answer",
        "thought": request["method"],
        "finalAnswer": model_response["response"]["text"],
        "confidence": 1
    }
}), flush=True)
`)
    const model = new FakeModel()
    const agent = new PythonAgentAdapter({
      id: "python-model-agent",
      name: "Python Model Agent",
      description: "Delegates model calls",
      command: [python, script],
      protocol: "jsonl",
      model,
    })

    const decision = await agent.step(state(), ctx())

    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.messages[0]?.content).toBe("answer from model")
    expect(decision).toEqual({
      type: "final_answer",
      thought: "step",
      finalAnswer: "model delegated answer",
      confidence: 1,
    })
  })

  it("retries invalid step decisions with validation context", async () => {
    const logPath = join(await mkdtemp(join(tmpdir(), "owa-python-agent-retry-log-")), "requests.jsonl")
    const script = await writePythonScript(`
import json
import os
import sys

request = json.load(sys.stdin)
with open(os.environ["REQUEST_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps(request, sort_keys=True) + "\\n")

if "retry" not in request:
    print(json.dumps({
        "decision": {
            "type": "browser_actions",
            "thought": "Use a browser operation alias.",
            "actions": [
                {
                    "id": "search",
                    "kind": "search",
                    "reason": None,
                    "requiresApproval": False,
                    "toolCalls": [
                        {"id": "search_tool", "type": "open", "url": "https://example.com"}
                    ]
                }
            ]
        }
    }))
else:
    print(json.dumps({
        "decision": {
            "type": "final_answer",
            "thought": request["retry"]["previousError"],
            "finalAnswer": request["retry"]["previousResponse"]["decision"]["actions"][0]["toolCalls"][0]["type"],
            "confidence": 1
        }
    }))
`)
    const agent = new PythonAgentAdapter({
      id: "python-retry-agent",
      name: "Python Retry Agent",
      description: "Retries invalid decisions",
      command: [python, script],
      env: { REQUEST_LOG: logPath },
    })

    const decision = await agent.step(state(), ctx())
    const requests = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))

    expect(decision).toMatchObject({
      type: "final_answer",
      finalAnswer: "open",
    })
    expect(requests).toHaveLength(2)
    expect(requests[0]).not.toHaveProperty("retry")
    expect(requests[1].retry).toMatchObject({
      attempt: 1,
      previousResponse: {
        decision: {
          actions: [
            {
              toolCalls: [{ type: "open" }],
            },
          ],
        },
      },
    })
    expect(requests[1].retry.previousError).toContain("decision")
    expect(requests[1].retry.previousError).toContain("toolCalls")
  })

  it("exposes retry context to BaseAgent subclasses", async () => {
    const script = await writePythonScript(`
${commonImportPrelude}
from _common.agent import BaseAgent

class FixtureAgent(BaseAgent):
    def step(self, ctx):
        if not getattr(ctx, "retry", None):
            return {
                "type": "browser_actions",
                "thought": "Use an invalid browser tool.",
                "actions": [
                    {
                        "id": "invalid",
                        "kind": "invalid",
                        "reason": None,
                        "requiresApproval": False,
                        "toolCalls": [
                            {"id": "invalid_tool", "type": "open", "url": "https://example.com"}
                        ],
                    }
                ],
            }
        return ctx.final_answer(
            f"retry {ctx.retry_attempt}: {ctx.retry_previous_response['decision']['actions'][0]['toolCalls'][0]['type']}",
            thought=ctx.retry_previous_error,
        )

if __name__ == "__main__":
    FixtureAgent().run()
`)
    const agent = new PythonAgentAdapter({
      id: "python-base-retry-agent",
      name: "Python Base Retry Agent",
      description: "Uses BaseAgent retry context",
      command: [python, script],
      protocol: "jsonl",
    })

    const decision = await agent.step(state(), ctx())

    expect(decision).toMatchObject({
      type: "final_answer",
      finalAnswer: "retry 1: open",
    })
    expect(decision.thought).toContain("toolCalls")
  })

  it("lets plan-act correct invalid tool calls from adapter retry context", async () => {
    class PlanRetryModel extends FakeModel {
      decisionPrompts: string[] = []

      override async complete(request: ModelRequest): Promise<ModelResponse> {
        this.requests.push(request)
        const system = messageText(request.messages.find((message) => message.role === "system")?.content ?? "")
        const user = messageText(request.messages.find((message) => message.role === "user")?.content ?? "")
        if (system.includes("planning agent")) {
          return {
            id: "plan-response",
            text: JSON.stringify({
              items: [{ id: "search", title: "Search for schedule", status: "active" }],
            }),
            raw: {},
            usage: null,
            latencyMs: 0,
          }
        }

        this.decisionPrompts.push(user)
        if (user.includes("Previous response was invalid") && user.includes("toolCalls")) {
          return {
            id: "corrected-decision",
            text: JSON.stringify({
              type: "final_answer",
              thought: "Corrected after retry context.",
              finalAnswer: "corrected",
              confidence: 1,
            }),
            raw: {},
            usage: null,
            latencyMs: 0,
          }
        }

        return {
          id: "invalid-decision",
          text: JSON.stringify({
            type: "browser_actions",
            thought: "Use an invalid browser tool.",
            actions: [
              {
                id: "search",
                kind: "search",
                reason: null,
                requiresApproval: false,
                toolCalls: [{ id: "search_tool", type: "open", url: "https://example.com" }],
              },
            ],
          }),
          raw: {},
          usage: null,
          latencyMs: 0,
        }
      }
    }
    const model = new PlanRetryModel()
    const agent = new PythonAgentAdapter({
      id: "plan-act",
      name: "Plan Act",
      description: "Plan-act fixture",
      command: [python, resolve(repoAgentsDir, "plan-act/main.py")],
      protocol: "jsonl",
      model,
    })

    const decision = await agent.step(state(), ctx())

    expect(decision).toMatchObject({ type: "final_answer", finalAnswer: "corrected" })
    expect(model.decisionPrompts).toHaveLength(2)
    expect(model.decisionPrompts[1]).toContain("Previous response was invalid")
    expect(model.decisionPrompts[1]).toContain('"type":"open"')
  })

  it("lets plan-act retry model decisions that fail tool-call schema validation", async () => {
    const model = new SequenceModel([
      JSON.stringify({
        items: [{ id: "inspect", title: "Inspect the page", status: "active" }],
      }),
      JSON.stringify({
        type: "browser_actions",
        thought: "Wait before inspecting.",
        actions: [
          {
            id: "wait_for_page",
            kind: "wait",
            reason: "Give the page time to settle.",
            requiresApproval: false,
            toolCalls: [
              { id: "click_tool", type: "click" },
              { id: "wait_tool", type: "wait" },
              { id: "bad_tool", type: "input_text" },
            ],
          },
        ],
      }),
      JSON.stringify({
        type: "final_answer",
        thought: "Recovered after invalid wait.",
        finalAnswer: "done after retry",
        confidence: 1,
      }),
    ])
    const agent = new PythonAgentAdapter({
      id: "plan-act",
      name: "PlanAct",
      description: "Plans before acting",
      command: [python, resolve(repoAgentsDir, "plan-act/main.py")],
      protocol: "jsonl",
      model,
    })

    const decision = await agent.step(state(), ctx())

    expect(decision).toEqual({
      type: "final_answer",
      thought: "Recovered after invalid wait.",
      finalAnswer: "done after retry",
      confidence: 1,
    })
    expect(model.requests).toHaveLength(3)
    expect(model.requests[2]?.messages.at(-1)?.content).toContain("Previous response was invalid")
    expect(model.requests[2]?.messages.at(-1)?.content).toContain("decision.actions[0].toolCalls[0].target")
    expect(model.requests[2]?.messages.at(-1)?.content).toContain("decision.actions[0].toolCalls[1].ms")
    expect(model.requests[2]?.messages.at(-1)?.content).toContain("decision.actions[0].toolCalls[2].type")
  })

  it("includes runtime browser tool definitions in plan-act decision prompts", async () => {
    const model = new SequenceModel([
      JSON.stringify({
        items: [{ id: "inspect", title: "Inspect the page", status: "active" }],
      }),
      JSON.stringify({
        type: "final_answer",
        thought: "Tool prompt inspected.",
        finalAnswer: "done",
        confidence: 1,
      }),
    ])
    const agent = new PythonAgentAdapter({
      id: "plan-act",
      name: "PlanAct",
      description: "Plans before acting",
      command: [python, resolve(repoAgentsDir, "plan-act/main.py")],
      protocol: "jsonl",
      model,
    })

    await agent.step(state(), ctx({ browserTools: defaultBrowserTools }))

    const decisionRequest = model.requests.find((request) =>
      messageText(request.messages.find((message) => message.role === "system")?.content ?? "").includes(
        "browser-control agent",
      ),
    )
    const systemPrompt = messageText(decisionRequest?.messages.find((message) => message.role === "system")?.content ?? "")
    expect(systemPrompt).toContain("Available browser tools:")
    expect(systemPrompt).toContain("- navigate: Open an absolute URL in the current browser page.")
    expect(systemPrompt).toContain('Example: {"id":"tool_1","type":"navigate","url":"https://example.com"}')
    expect(systemPrompt).toContain("- click: Click an interactive element or coordinate on the current page.")
  })

  it("repairs plan-act elementId-only click targets from the current observation", async () => {
    const model = new SequenceModel([
      JSON.stringify({
        items: [{ id: "click_next", title: "Click Next", status: "active" }],
      }),
      JSON.stringify({
        type: "browser_actions",
        thought: "Click the observed button.",
        actions: [
          {
            id: "click_next",
            kind: "click",
            reason: "The observed element id identifies the Next button.",
            requiresApproval: false,
            toolCalls: [{ id: "click_next_tool", type: "click", target: { elementId: "element_1" } }],
          },
        ],
      }),
    ])
    const observedState = state()
    observedState.lastObservation = {
      ...observedState.lastObservation!,
      interactiveElements: [
        {
          id: "element_1",
          role: "button",
          name: null,
          text: "Next",
          selector: null,
          xpath: null,
          boundingBox: { x: 10, y: 20, width: 40, height: 20 },
          attributes: {},
        },
      ],
    }
    const agent = new PythonAgentAdapter({
      id: "plan-act",
      name: "PlanAct",
      description: "Plans before acting",
      command: [python, resolve(repoAgentsDir, "plan-act/main.py")],
      protocol: "jsonl",
      model,
    })

    const decision = await agent.step(observedState, ctx({ browserTools: defaultBrowserTools }))

    expect(decision).toMatchObject({
      type: "browser_actions",
      actions: [
        {
          toolCalls: [
            {
              type: "click",
              target: {
                elementId: "element_1",
                coordinates: { x: 30, y: 30 },
              },
            },
          ],
        },
      ],
    })
  })

  it("includes stderr when the process exits non-zero", async () => {
    const script = await writePythonScript(`
import sys
print("boom from python", file=sys.stderr)
sys.exit(7)
`)
    const agent = new PythonAgentAdapter({
      id: "python-error-agent",
      name: "Python Error Agent",
      description: "Test adapter errors",
      command: [python, script],
    })

    await expect(agent.step(state(), ctx())).rejects.toThrow("boom from python")
  })

  it("rejects invalid JSON stdout", async () => {
    const script = await writePythonScript('print("not-json")\n')
    const agent = new PythonAgentAdapter({
      id: "python-invalid-json-agent",
      name: "Python Invalid JSON Agent",
      description: "Test adapter JSON validation",
      command: [python, script],
    })

    await expect(agent.step(state(), ctx())).rejects.toThrow("invalid JSON")
  })

  it("terminates the process when the runtime abort signal fires", async () => {
    const script = await writePythonScript(`
import json
import sys
import time
json.load(sys.stdin)
time.sleep(5)
print(json.dumps({"decision": {"type": "final_answer", "thought": None, "finalAnswer": "late", "confidence": 1}}))
`)
    const controller = new AbortController()
    const agent = new PythonAgentAdapter({
      id: "python-slow-agent",
      name: "Python Slow Agent",
      description: "Test adapter cancellation",
      command: [python, script],
    })
    const promise = agent.step(state(), ctx(controller.signal))

    setTimeout(() => controller.abort(), 10)

    await expect(promise).rejects.toThrow("Run cancelled")
  })
})
