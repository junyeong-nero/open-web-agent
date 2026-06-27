import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"

const opencodeTuiModule = "@opencode-ai/tui"
const opencodeTuiConfigModule = "@opencode-ai/tui/config"

export interface LaunchOpenCodeTuiOptions {
  serverUrl: string
  projectPath: string
  continueLast?: boolean
  sessionId?: string
}

export async function launchOpenCodeTui(options: LaunchOpenCodeTuiOptions): Promise<void> {
  const [{ run }, { TuiConfig }] = await Promise.all([
    import(opencodeTuiModule),
    import(opencodeTuiConfigModule),
  ])
  const input = {
    url: `${options.serverUrl.replace(/\/$/, "")}/opencode`,
    directory: options.projectPath,
    args: {
      prompt: undefined,
      continue: options.continueLast,
      sessionID: options.sessionId,
      fork: false,
      model: undefined,
      agent: undefined,
    },
    config: TuiConfig.resolve(
      {
        theme: "system",
        mouse: true,
      },
      { terminalSuspend: false },
    ),
    pluginHost: createNoopPluginHost(),
  }

  await Effect.runPromise((run(input) as any).pipe(Effect.provide(Global.defaultLayer)))
}

function createNoopPluginHost() {
  return {
    async start(_input?: unknown) {},
    async dispose() {},
  }
}
