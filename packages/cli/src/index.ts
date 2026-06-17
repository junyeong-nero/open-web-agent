#!/usr/bin/env bun
import { parseArgs } from "./args"
import { connectCommand } from "./commands/connect"
import { defaultCommand } from "./commands/default"
import { runCommand } from "./commands/run"
import { serveCommand } from "./commands/serve"

export async function main(argv = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const args = parseArgs(argv, cwd)

  if (args.mode === "default") {
    await defaultCommand({ projectPath: args.projectPath })
    return
  }

  if (args.mode === "run") {
    await runCommand({ prompt: args.prompt, projectPath: args.projectPath })
    return
  }

  if (args.mode === "serve") {
    await serveCommand({ hostname: args.hostname, port: args.port })
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
