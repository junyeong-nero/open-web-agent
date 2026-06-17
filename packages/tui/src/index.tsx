import { render } from "@opentui/solid"
import { App } from "./app"

export interface LaunchTuiOptions {
  serverUrl: string
  projectPath: string
  continueLast?: boolean
  sessionId?: string
}

export async function launchTui(options: LaunchTuiOptions): Promise<void> {
  let resolved = false

  await new Promise<void>((resolve) => {
    const finish = () => {
      if (resolved) return
      resolved = true
      resolve()
    }

    void render(() => <App {...options} onExit={finish} />, {
      exitOnCtrlC: false,
      useMouse: true,
      enableMouseMovement: true,
      clearOnShutdown: true,
      onDestroy: finish,
    })
  })
}
