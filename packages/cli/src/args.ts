import { resolve } from "node:path"

export type CliArgs =
  | { mode: "default"; projectPath: string }
  | { mode: "run"; prompt: string; projectPath: string }
  | { mode: "serve"; hostname: string; port: number }
  | { mode: "connect"; serverUrl: string }

export function parseArgs(argv: string[], cwd = process.cwd()): CliArgs {
  if (argv.length === 0) return { mode: "default", projectPath: cwd }

  if (argv[0] === "--connect") {
    const serverUrl = argv[1]
    if (!serverUrl) throw new Error("--connect requires a server URL")
    return { mode: "connect", serverUrl }
  }

  if (argv[0] === "run") {
    const prompt = argv.slice(1).join(" ").trim()
    if (prompt.length === 0) throw new Error("run requires a prompt")
    return { mode: "run", prompt, projectPath: cwd }
  }

  if (argv[0] === "serve") {
    return parseServeArgs(argv.slice(1))
  }

  if (argv.length === 1) {
    return { mode: "default", projectPath: resolve(cwd, argv[0] ?? ".") }
  }

  throw new Error(`Unknown arguments: ${argv.join(" ")}`)
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
