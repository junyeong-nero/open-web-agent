import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventBus, type AgentState, type RunEvent, type RunEventType, type RuntimeContext } from "@open-web-agent/core"
import { PythonAgentAdapter } from "./python-agent-adapter"

const python = process.env.PYTHON ?? "python3"

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

function ctx(signal = new AbortController().signal): RuntimeContext & { emitted: Array<{ type: RunEventType; payload: Record<string, unknown> }> } {
  const emitted: Array<{ type: RunEventType; payload: Record<string, unknown> }> = []
  const session = state().session

  return {
    session,
    runId: "run_1",
    runDir: "/tmp/run",
    agentId: "python-test-agent",
    environmentId: "mock-browser",
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

async function writePythonScript(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "owa-python-agent-test-"))
  const path = join(dir, "agent.py")
  await writeFile(path, contents)
  return path
}

describe("PythonAgentAdapter", () => {
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
