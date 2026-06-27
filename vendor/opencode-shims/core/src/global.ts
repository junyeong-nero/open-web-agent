import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"

const root = process.env.OWA_HOME ?? join(tmpdir(), "open-web-agent-opencode-tui")

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  const paths = {
    home: process.env.HOME ?? root,
    data: join(root, "data"),
    cache: join(root, "cache"),
    config: join(root, "config"),
    state: join(root, "state"),
    tmp: join(root, "tmp"),
    bin: join(root, "bin"),
    log: join(root, "log"),
    repos: join(root, "repos"),
    ...input,
  }
  for (const value of Object.values(paths)) mkdirSync(value, { recursive: true })
  return paths
}

export const Path = make()
export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export const layer = Layer.effect(Service, Effect.sync(() => Service.of(make())))
export const defaultLayer = layer
export const layerWith = (input: Partial<Interface>) => Layer.effect(Service, Effect.sync(() => Service.of(make(input))))
export const Global = { Service, make, Path, layer, defaultLayer, layerWith }
