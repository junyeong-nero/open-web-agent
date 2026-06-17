import { resolve } from "node:path"

export type CliArgs =
  | { mode: "default"; projectPath: string; continueLast?: boolean; sessionId?: string }
  | { mode: "run"; prompt: string; projectPath: string; continueLast?: boolean; sessionId?: string }
  | { mode: "serve"; hostname: string; port: number }
  | { mode: "eval"; taskIds: string[]; combinations?: Array<{ agentId: string; modelId: string; environmentId: string }> }
  | { mode: "connect"; serverUrl: string }

export function parseArgs(argv: string[], cwd = process.cwd()): CliArgs {
  if (argv.length === 0) return { mode: "default", projectPath: cwd }

  if (argv[0] === "--connect") {
    const serverUrl = argv[1]
    if (!serverUrl) throw new Error("--connect requires a server URL")
    return { mode: "connect", serverUrl }
  }

  if (argv[0] === "--continue") {
    return { mode: "default", projectPath: cwd, continueLast: true }
  }

  if (argv[0] === "--session") {
    const sessionId = argv[1]
    if (!sessionId) throw new Error("--session requires a session ID")
    return { mode: "default", projectPath: cwd, sessionId }
  }

  if (argv[0] === "run") {
    const { promptParts, continueLast, sessionId } = parseRunFlags(argv.slice(1))
    const prompt = promptParts.join(" ").trim()
    if (prompt.length === 0) throw new Error("run requires a prompt")
    return { mode: "run", prompt, projectPath: cwd, continueLast, sessionId }
  }

  if (argv[0] === "serve") {
    return parseServeArgs(argv.slice(1))
  }

  if (argv[0] === "eval") {
    return parseEvalArgs(argv.slice(1))
  }

  if (argv.length === 1) {
    return { mode: "default", projectPath: resolve(cwd, argv[0] ?? ".") }
  }

  throw new Error(`Unknown arguments: ${argv.join(" ")}`)
}

function parseEvalArgs(argv: string[]): CliArgs {
  const taskIds: string[] = []
  const combinations: Array<{ agentId: string; modelId: string; environmentId: string }> = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === "--task") {
      taskIds.push(requiredValue(argv, index, "--task"))
      index += 1
      continue
    }

    if (arg === "--combo") {
      combinations.push(parseCombination(requiredValue(argv, index, "--combo")))
      index += 1
      continue
    }

    throw new Error(`Unknown eval argument: ${arg}`)
  }

  return {
    mode: "eval",
    taskIds,
    ...(combinations.length > 0 ? { combinations } : {}),
  }
}

function parseCombination(value: string): { agentId: string; modelId: string; environmentId: string } {
  const [agentId, modelId, environmentId] = value.split("/")
  if (!agentId || !modelId || !environmentId) {
    throw new Error("--combo must use agent/model/environment")
  }

  return { agentId, modelId, environmentId }
}

function parseRunFlags(argv: string[]): { promptParts: string[]; continueLast?: boolean; sessionId?: string } {
  const promptParts: string[] = []
  let continueLast: boolean | undefined
  let sessionId: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--continue") {
      continueLast = true
      continue
    }
    if (arg === "--session") {
      sessionId = requiredValue(argv, index, "--session")
      index += 1
      continue
    }
    promptParts.push(arg)
  }

  return { promptParts, continueLast, sessionId }
}

function parseServeArgs(argv: string[]): CliArgs {
  let hostname = "127.0.0.1"
  let port = 0

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === "--hostname") {
      hostname = requiredValue(argv, index, "--hostname")
      index += 1
      continue
    }

    if (arg === "--port") {
      const parsed = Number(requiredValue(argv, index, "--port"))
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error("--port must be a nonnegative integer")
      port = parsed
      index += 1
      continue
    }

    throw new Error(`Unknown serve argument: ${arg}`)
  }

  return { mode: "serve", hostname, port }
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}
