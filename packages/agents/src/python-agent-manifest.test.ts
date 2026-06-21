import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  EventBus,
  type AgentState,
  type ModelPlugin,
  type ModelRequest,
  type ModelResponse,
  type RuntimeContext,
} from "@open-web-agent/core"
import { loadPythonAgentManifests } from "./python-agent-manifest"

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
    lastObservation: null,
    finalAnswer: null,
  }
}

function ctx(): RuntimeContext {
  return {
    session: state().session,
    runId: "run_1",
    runDir: "/tmp/run",
    browserTools: [],
    eventBus: new EventBus(),
    abortSignal: new AbortController().signal,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    async emit() {
      throw new Error("not used")
    },
  }
}

async function makeAgentsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "owa-python-agent-manifests-"))
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
      text: "manifest model answer",
      raw: {},
      usage: null,
      latencyMs: 0,
    }
  }
}

describe("loadPythonAgentManifests", () => {
  it("loads a Python agent manifest and resolves the entry relative to the manifest directory", async () => {
    const agentsDir = await makeAgentsDir()
    const agentDir = join(agentsDir, "yaml-agent")
    await mkdir(agentDir)
    await writeFile(
      join(agentDir, "agent.yaml"),
      [
        "id: yaml-agent",
        "name: YAML Agent",
        "description: Loaded from YAML",
        "language: python",
        "entry: main.py",
        "",
      ].join("\n"),
    )
    await writeFile(
      join(agentDir, "main.py"),
      [
        "import json",
        "import sys",
        "json.load(sys.stdin)",
        'print(json.dumps({"decision":{"type":"final_answer","thought":None,"finalAnswer":"manifest loaded","confidence":1}}))',
        "",
      ].join("\n"),
    )

    const agents = await loadPythonAgentManifests(agentsDir, { pythonCommand: python })
    const decision = await agents[0]?.step(state(), ctx())

    expect(agents.map((agent) => agent.id)).toEqual(["yaml-agent"])
    expect(agents[0]?.name).toBe("YAML Agent")
    expect(decision).toMatchObject({ type: "final_answer", finalAnswer: "manifest loaded" })
  })

  it("supports command overrides relative to the manifest directory", async () => {
    const agentsDir = await makeAgentsDir()
    const agentDir = join(agentsDir, "command-agent")
    await mkdir(agentDir)
    await writeFile(
      join(agentDir, "agent.yaml"),
      [
        "id: command-agent",
        "name: Command Agent",
        "description: Uses a custom command",
        "language: python",
        "command:",
        `  - ${JSON.stringify(python)}`,
        '  - custom.py',
        "",
      ].join("\n"),
    )
    await writeFile(
      join(agentDir, "custom.py"),
      [
        "import json",
        "import sys",
        "json.load(sys.stdin)",
        'print(json.dumps({"decision":{"type":"final_answer","thought":None,"finalAnswer":"custom command","confidence":1}}))',
        "",
      ].join("\n"),
    )

    const agents = await loadPythonAgentManifests(agentsDir, { pythonCommand: "unused-python" })
    const decision = await agents[0]?.step(state(), ctx())

    expect(decision).toMatchObject({ type: "final_answer", finalAnswer: "custom command" })
  })

  it("loads jsonl Python agents that delegate to the supplied runtime model", async () => {
    const agentsDir = await makeAgentsDir()
    const agentDir = join(agentsDir, "jsonl-agent")
    await mkdir(agentDir)
    await writeFile(
      join(agentDir, "agent.yaml"),
      [
        "id: jsonl-agent",
        "name: JSONL Agent",
        "description: Delegates model calls",
        "language: python",
        "entry: main.py",
        "protocol: jsonl",
        "",
      ].join("\n"),
    )
    await writeFile(
      join(agentDir, "main.py"),
      [
        "import json",
        "import sys",
        "json.loads(sys.stdin.readline())",
        'print(json.dumps({"command":"model.complete","id":"m1","request":{"model":"test","messages":[{"role":"user","content":"hi"}],"temperature":0,"responseFormat":"text"}}), flush=True)',
        "model_response = json.loads(sys.stdin.readline())",
        'print(json.dumps({"decision":{"type":"final_answer","thought":None,"finalAnswer":model_response["response"]["text"],"confidence":1}}), flush=True)',
        "",
      ].join("\n"),
    )
    const model = new FakeModel()

    const agents = await loadPythonAgentManifests(agentsDir, { pythonCommand: python, model })
    const decision = await agents[0]?.step(state(), ctx())

    expect(model.requests).toHaveLength(1)
    expect(decision).toMatchObject({ type: "final_answer", finalAnswer: "manifest model answer" })
  })

  it("rejects non-Python manifests", async () => {
    const agentsDir = await makeAgentsDir()
    const agentDir = join(agentsDir, "ts-agent")
    await mkdir(agentDir)
    await writeFile(
      join(agentDir, "agent.yaml"),
      [
        "id: ts-agent",
        "name: TypeScript Agent",
        "description: Wrong language",
        "language: typescript",
        "entry: index.ts",
        "",
      ].join("\n"),
    )

    await expect(loadPythonAgentManifests(agentsDir)).rejects.toThrow("language must be python")
  })

  it("returns an empty list when the agents directory is missing", async () => {
    const agents = await loadPythonAgentManifests(join(tmpdir(), "owa-missing-agents-dir"))

    expect(agents).toEqual([])
  })
})
