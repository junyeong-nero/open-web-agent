import { startDefaultRuntime } from "@open-web-agent/server"
import { resolveOwaHome, type BrowserToolCall, type RunEvent } from "@open-web-agent/core"
import { join } from "node:path"

export interface RunCommandInput {
  prompt: string
  projectPath: string
  continueLast?: boolean
  sessionId?: string
  agentId?: string
}

export interface RunCommandOptions {
  env?: NodeJS.ProcessEnv
  configPath?: string
  stdout?: (line: string) => void
}

export async function runCommand(input: RunCommandInput, options: RunCommandOptions = {}): Promise<void> {
  const stdout = options.stdout ?? ((line: string) => console.log(line))
  const runtime = await startDefaultRuntime({
    home: resolveOwaHome(options.env),
    agentsDir: join(input.projectPath, "agents"),
    env: options.env,
    configPath: options.configPath,
  })
  let resolveTerminalEvent: (event: RunEvent) => void = () => {}
  const terminalEvent = new Promise<RunEvent>((resolve) => {
    resolveTerminalEvent = resolve
  })
  const unsubscribe = runtime.eventBus.subscribe((event) => {
    const line = formatCompactEvent(event)
    if (line) stdout(line)
    if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") {
      resolveTerminalEvent(event)
    }
  })

  try {
    const session = await resolveSession(runtime.url, input)
    const run = await requestJson<{ runId: string }>(`${runtime.url}/runs`, {
      method: "POST",
      body: JSON.stringify({ sessionId: session.sessionId, prompt: input.prompt, agentId: input.agentId }),
    })

    await terminalEvent
    await waitForRunSettled(runtime.url, run.runId)
  } finally {
    unsubscribe()
    await runtime.stop()
  }
}

async function resolveSession(serverUrl: string, input: RunCommandInput): Promise<{ sessionId: string }> {
  if (input.sessionId) return { sessionId: input.sessionId }
  if (input.continueLast) {
    const sessions = await requestJson<{ sessions: Array<{ id: string }> }>(`${serverUrl}/sessions`)
    const latest = sessions.sessions.at(-1)
    if (latest) return { sessionId: latest.id }
  }

  return requestJson<{ sessionId: string }>(`${serverUrl}/sessions`, {
    method: "POST",
    body: JSON.stringify({ projectPath: input.projectPath }),
  })
}

export function formatCompactEvent(event: RunEvent): string | null {
  if (event.type === "run.started") return `[run.started] ${event.runId}`

  if (event.type === "browser.tool.completed") {
    const toolCall = event.payload.toolCall as BrowserToolCall | undefined
    if (!toolCall) return "[browser.tool.completed]"
    if (toolCall.type === "navigate") return `[browser.tool.completed] navigate ${toolCall.url}`
    return `[browser.tool.completed] ${toolCall.type}`
  }

  if (event.type === "run.completed") return `[run.completed] ${String(event.payload.finalAnswer ?? "")}`
  if (event.type === "run.failed") return `[run.failed] ${String(event.payload.message ?? "")}`
  if (event.type === "run.cancelled") return `[run.cancelled] ${String(event.payload.reason ?? "")}`

  return null
}

async function waitForRunSettled(serverUrl: string, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const run = await requestJson<{ status: string }>(`${serverUrl}/runs/${runId}`)
    if (run.status !== "running") return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error(`Timed out waiting for run ${runId} to settle`)
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  return response.json() as Promise<T>
}
