import { launchOpenCodeTui } from "@open-web-agent/opencode-tui"
import { startDefaultRuntime } from "@open-web-agent/server"
import { launchTui } from "@open-web-agent/tui"
import { join } from "node:path"
import type { TuiKind } from "../args"

export interface DefaultCommandInput {
  projectPath: string
  continueLast?: boolean
  sessionId?: string
  tui?: TuiKind
}

export async function defaultCommand(input: DefaultCommandInput): Promise<void> {
  const runtime = await startDefaultRuntime({ agentsDir: join(input.projectPath, "agents") })

  try {
    const options = {
      serverUrl: runtime.url,
      projectPath: input.projectPath,
      continueLast: input.continueLast,
      sessionId: input.sessionId,
    }
    if (input.tui === "opencode") await launchOpenCodeTui(options)
    else await launchTui(options)
  } finally {
    await runtime.stop()
  }
}
