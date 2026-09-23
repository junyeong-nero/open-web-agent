#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { type AgentEvent, runAgent } from "./agent"
import { BrowserSession } from "./browser"
import { createMcpServer, serveStdio } from "./mcp"
import { type ModelConfig, modelConfigFromEnv, parseApi, resolveModel } from "./model/resolve"
import { jsonlTrace } from "./trace"
import { type Capability, selectTools } from "./tools"
import { VERSION } from "./version"

const HELP = `owa ${VERSION}: a small browser agent and browser MCP server

Usage:
  owa run "<task>" [options]   Run the built-in agent once and print the answer
  owa mcp [options]            Serve the browser tools over stdio MCP
  owa mcp --agent [options]    …and also expose browser_task, backed by the built-in agent

Model (flag > env):
  --model <provider:model>     OWA_MODEL, e.g. openai:gpt-5-mini, anthropic:claude-sonnet-5,
                               openrouter:qwen/qwen3-coder, gemini:gemini-2.5-flash, ollama:qwen3:8b
  --api <openai|anthropic>     OWA_API       wire format for custom endpoints
  --base-url <url>             OWA_BASE_URL  any OpenAI- or Anthropic-compatible endpoint
  --model-module <path>        OWA_MODEL_MODULE  module default-exporting a ModelAdapter
  API keys: OWA_API_KEY, or OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY

Browser:
  --headless                   OWA_HEADLESS=1
  --browser <name>             chromium (default), firefox, webkit
  --cdp <url>                  attach to a running Chrome, e.g. http://127.0.0.1:9222
  --user-data-dir <dir>        persistent profile
  --executable-path <path>     browser binary
  --caps <list>                tool groups: core (default), unsafe (adds browser_evaluate)

Agent:
  --max-steps <n>              default 30
  --trace <file.jsonl>         append agent events as JSONL
  --json                       (run) print the result as JSON
`

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      model: { type: "string" },
      api: { type: "string" },
      "base-url": { type: "string" },
      "model-module": { type: "string" },
      headless: { type: "boolean" },
      browser: { type: "string" },
      cdp: { type: "string" },
      "user-data-dir": { type: "string" },
      "executable-path": { type: "string" },
      caps: { type: "string" },
      "max-steps": { type: "string" },
      trace: { type: "string" },
      json: { type: "boolean" },
      agent: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  })

  if (values.version) return print(VERSION)
  const [command, ...rest] = positionals
  if (values.help || !command) return print(HELP)

  const env = modelConfigFromEnv()
  const modelConfig: ModelConfig = {
    ...env,
    model: values.model ?? env.model,
    api: parseApi(values.api) ?? env.api,
    baseUrl: values["base-url"] ?? env.baseUrl,
    module: values["model-module"] ?? env.module,
  }
  const browserName = values.browser ?? "chromium"
  if (!["chromium", "firefox", "webkit"].includes(browserName)) throw new Error(`Unknown browser "${browserName}"`)
  const session = new BrowserSession({
    headless: values.headless ?? isTruthy(process.env.OWA_HEADLESS),
    browser: browserName as "chromium" | "firefox" | "webkit",
    cdpUrl: values.cdp,
    userDataDir: values["user-data-dir"],
    executablePath: values["executable-path"],
  })
  const tools = selectTools(parseCaps(values.caps))
  const maxSteps = values["max-steps"] ? Number.parseInt(values["max-steps"], 10) : undefined

  if (command === "mcp") {
    const agentModel = values.agent ? await resolveModel(modelConfig) : undefined
    const server = createMcpServer({ session, tools, agentModel, agentMaxSteps: maxSteps })
    const stop = () => void session.close().finally(() => process.exit(0))
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
    try {
      await serveStdio(server)
    } finally {
      await session.close()
    }
    return 0
  }

  if (command === "run") {
    const task = rest.join(" ").trim()
    if (!task) throw new Error('Usage: owa run "<task>"')
    const model = await resolveModel(modelConfig)
    const controller = new AbortController()
    process.once("SIGINT", () => controller.abort(new Error("Interrupted")))
    const trace = values.trace ? jsonlTrace(values.trace) : undefined

    try {
      const result = await runAgent({
        task,
        model,
        browser: session,
        tools,
        maxSteps,
        signal: controller.signal,
        onEvent: (event) => {
          trace?.(event)
          logEvent(event)
        },
      })
      print(values.json ? JSON.stringify(result, null, 2) : result.answer)
      return result.status === "completed" ? 0 : 1
    } finally {
      await session.close()
    }
  }

  throw new Error(`Unknown command "${command}". Run owa --help.`)
}

function logEvent(event: AgentEvent): void {
  const log = (line: string) => process.stderr.write(`${line}\n`)
  if (event.type === "model" && event.text && event.toolCalls.length > 0) log(`  · ${oneLine(event.text)}`)
  if (event.type === "tool") {
    const args = JSON.stringify(event.call.arguments)
    log(`${event.result.isError ? "✗" : "→"} [${event.step}] ${event.call.name} ${oneLine(args)}`)
    if (event.result.isError) log(`    ${oneLine(event.result.text)}`)
  }
  if (event.type === "done") {
    const { status, steps, usage } = event.result
    log(`■ ${status} in ${steps} steps (tokens in ${usage.inputTokens}, out ${usage.outputTokens})`)
  }
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function parseCaps(value: string | undefined): Capability[] {
  const caps = (value ?? "core").split(",").map((cap) => cap.trim()).filter(Boolean)
  for (const cap of caps) if (cap !== "core" && cap !== "unsafe") throw new Error(`Unknown capability "${cap}"`)
  return caps.includes("core") ? (caps as Capability[]) : ["core", ...(caps as Capability[])]
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes"].includes(value.toLowerCase())
}

function print(text: string): number {
  process.stdout.write(`${text}\n`)
  return 0
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`owa: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
