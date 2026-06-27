export interface LaunchOpenCodeTuiOptions {
  serverUrl: string
  projectPath: string
  continueLast?: boolean
  sessionId?: string
}

export async function launchOpenCodeTui(options: LaunchOpenCodeTuiOptions): Promise<void> {
  throw new Error(
    [
      "OpenCode TUI source is not vendored yet.",
      `Compat API is available at ${options.serverUrl}/opencode.`,
      "Run the OpenCode source vendor task before using --tui opencode interactively.",
    ].join(" "),
  )
}
