import { launchTui } from "@open-web-agent/tui"

export interface ConnectCommandInput {
  serverUrl: string
  projectPath?: string
}

export async function connectCommand(input: ConnectCommandInput): Promise<void> {
  await launchTui({ serverUrl: input.serverUrl, projectPath: input.projectPath ?? process.cwd() })
}
