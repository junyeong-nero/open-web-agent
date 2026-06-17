#!/usr/bin/env bun
import { parseArgs } from "./args"
import { connectCommand } from "./commands/connect"
import { defaultCommand } from "./commands/default"
import { evalCommand } from "./commands/eval"
import { runCommand } from "./commands/run"
import { serveCommand } from "./commands/serve"

export async function main(argv = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const args = parseArgs(argv, cwd)

  if (args.mode === "default") {
    await defaultCommand({ projectPath: args.projectPath, continueLast: args.continueLast, sessionId: args.sessionId })
    return
  }

  if (args.mode === "run") {
    await runCommand({
      prompt: args.prompt,
      projectPath: args.projectPath,
      continueLast: args.continueLast,
      sessionId: args.sessionId,
      agentId: args.agentId,
    })
    return
  }

  if (args.mode === "serve") {
    await serveCommand({ hostname: args.hostname, port: args.port })
    return
  }

  if (args.mode === "eval") {
    evalCommand({ taskIds: args.taskIds, combinations: args.combinations })
    return
  }

  await connectCommand({ serverUrl: args.serverUrl, projectPath: cwd })
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
