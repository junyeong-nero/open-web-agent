import { launchOpenCodeTui } from "@open-web-agent/opencode-tui"
import { launchTui } from "@open-web-agent/tui"
import type { TuiKind } from "../args"

export interface ConnectCommandInput {
  serverUrl: string
  projectPath?: string
  tui?: TuiKind
}

export async function connectCommand(input: ConnectCommandInput): Promise<void> {
  const options = { serverUrl: input.serverUrl, projectPath: input.projectPath ?? process.cwd() }
  if (input.tui === "opencode") await launchOpenCodeTui(options)
  else await launchTui(options)
}
