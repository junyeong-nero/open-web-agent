import { startDefaultRuntime, type StartedDefaultRuntime } from "@open-web-agent/server"

export interface ServeCommandInput {
  hostname: string
  port: number
}

export interface ServeCommandOptions {
  stdout?: (line: string) => void
}

export async function serveCommand(
  input: ServeCommandInput,
  options: ServeCommandOptions = {},
): Promise<StartedDefaultRuntime> {
  const runtime = await startDefaultRuntime({ hostname: input.hostname, port: input.port })
  ;(options.stdout ?? ((line: string) => console.log(line)))(`open-web-agent server listening at ${runtime.url}`)
  return runtime
}
