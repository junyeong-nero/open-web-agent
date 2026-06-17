import { startDefaultRuntime } from "@open-web-agent/server"
import { launchTui } from "@open-web-agent/tui"

export interface DefaultCommandInput {
  projectPath: string
  continueLast?: boolean
  sessionId?: string
}

export async function defaultCommand(input: DefaultCommandInput): Promise<void> {
  const runtime = await startDefaultRuntime()

  try {
    await launchTui({
      serverUrl: runtime.url,
      projectPath: input.projectPath,
      continueLast: input.continueLast,
      sessionId: input.sessionId,
    })
  } finally {
    await runtime.stop()
  }
}
