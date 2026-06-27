import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"

const opencodeTuiModule = "@opencode-ai/tui"
const opencodeTuiBuiltinsModule = "@opencode-ai/tui/builtins"
const opencodeTuiConfigModule = "@opencode-ai/tui/config"

export interface LaunchOpenCodeTuiOptions {
  serverUrl: string
  projectPath: string
  continueLast?: boolean
  sessionId?: string
}

export async function launchOpenCodeTui(options: LaunchOpenCodeTuiOptions): Promise<void> {
  const [{ run }, { createBuiltinPlugins }, { TuiConfig }] = await Promise.all([
    import(opencodeTuiModule),
    import(opencodeTuiBuiltinsModule),
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
    pluginHost: createBuiltinPluginHost(createBuiltinPlugins),
  }

  await Effect.runPromise((run(input) as any).pipe(Effect.provide(Global.defaultLayer)))
}

type BuiltinPlugin = {
  id: string
  enabled?: boolean
  tui: (api: unknown, options: undefined, meta: Record<string, unknown>) => Promise<void>
}

type CreateBuiltinPlugins = (options: { experimentalEventSystem: boolean }) => BuiltinPlugin[]
type PluginRuntime = {
  setupSlots?: (api: unknown) => { register?: unknown; dispose?: () => void }
  update?: (input: {
    commands?: {
      activate: (id: string) => Promise<boolean>
      deactivate: (id: string) => Promise<boolean>
      add: (spec: string) => Promise<boolean>
      install: (spec: string, options?: { enabled?: boolean }) => Promise<{ ok: boolean; message?: string }>
    }
    status?: Array<{ id: string; enabled: boolean; error?: string }>
  }) => void
}

function createBuiltinPluginHost(createBuiltinPlugins: CreateBuiltinPlugins) {
  let dispose: (() => void) | undefined
  let disposeSlots: (() => void) | undefined
  return {
    async start(input?: {
      api: unknown
      runtime?: PluginRuntime
      dispose?: () => void
    }) {
      if (!input) return
      dispose = input.dispose
      const slots = input.runtime?.setupSlots?.(input.api)
      disposeSlots = slots?.dispose
      const api = slots ? { ...(input.api as Record<string, unknown>), slots } : input.api
      const status: Array<{ id: string; enabled: boolean; error?: string }> = []
      for (const plugin of createBuiltinPlugins({ experimentalEventSystem: false })) {
        if (plugin.enabled === false) {
          status.push({ id: plugin.id, enabled: false })
          continue
        }
        try {
          await plugin.tui(api, undefined, {
            id: plugin.id,
            enabled: true,
            source: "internal",
            state: "first",
            spec: plugin.id,
          })
          status.push({ id: plugin.id, enabled: true })
        } catch (error) {
          status.push({
            id: plugin.id,
            enabled: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      input.runtime?.update?.({
        commands: {
          async activate() {
            return false
          },
          async deactivate() {
            return false
          },
          async add() {
            return false
          },
          async install() {
            return { ok: false, message: "Plugin installation is not available in OWA compatibility mode." }
          },
        },
        status,
      })
    },
    async dispose() {
      try {
        dispose?.()
      } finally {
        disposeSlots?.()
      }
    },
  }
}
