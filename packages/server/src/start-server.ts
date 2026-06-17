import type { Hono } from "hono"

export interface StartServerOptions {
  app: Hono
  hostname?: string
  port?: number
}

export interface StartedServer {
  url: string
  hostname: string
  port: number
  stop(): Promise<void>
}

export async function startServer(options: StartServerOptions): Promise<StartedServer> {
  const hostname = options.hostname ?? "127.0.0.1"
  const port = options.port ?? 0

  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    throw new Error("Sprint 1 server only supports 127.0.0.1 or localhost")
  }

  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 255,
    fetch: (request) => options.app.fetch(request),
  })
  const resolvedPort = server.port
  if (typeof resolvedPort !== "number") {
    throw new Error("Bun did not report a bound server port")
  }

  return {
    url: `http://${hostname}:${resolvedPort}`,
    hostname,
    port: resolvedPort,
    async stop(): Promise<void> {
      await server.stop(true)
    },
  }
}
