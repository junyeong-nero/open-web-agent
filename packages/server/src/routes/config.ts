import type { Hono } from "hono"
import type { PluginRegistry } from "@open-web-agent/core"
import {
  writeAgentSelectionConfig,
  writeBrowserHeadlessConfig,
  writeBrowserSelectionConfig,
  writeModelSelectionConfig,
} from "@open-web-agent/models"
import {
  UpdateAgentConfigRequestSchema,
  UpdateBrowserConfigRequestSchema,
  UpdateBrowserHeadlessConfigRequestSchema,
  UpdateModelConfigRequestSchema,
} from "../schemas/api"

export interface ConfigRouteDeps {
  registry: PluginRegistry
  modelConfigPath?: string
  modelConfigEnv?: NodeJS.ProcessEnv
  onBrowserHeadlessChanged?: (browserHeadless: boolean) => void | Promise<void>
}

export function registerConfigRoutes(app: Hono, deps: ConfigRouteDeps): void {
  app.patch("/config/model", async (c) => {
    const parsed = UpdateModelConfigRequestSchema.safeParse(await readJson(c.req))
    if (!parsed.success) return c.json({ error: "Invalid model config request" }, 400)

    const model = deps.registry.listModels().find((candidate) => candidate.id === parsed.data.modelId)
    if (!model) return c.json({ error: "Unknown model" }, 400)
    if (parsed.data.reasoningEffort && !model.reasoningEffort) {
      return c.json({ error: "Model does not support reasoning effort" }, 400)
    }

    const reasoningEffort = parsed.data.reasoningEffort ?? model.reasoningEffort ?? null
    if (parsed.data.reasoningEffort) model.reasoningEffort = parsed.data.reasoningEffort

    await writeModelSelectionConfig(
      { modelId: model.id, modelName: model.modelName ?? null, reasoningEffort },
      { configPath: deps.modelConfigPath, env: deps.modelConfigEnv },
    )

    return c.json({ modelId: model.id, modelName: model.modelName ?? null, reasoningEffort })
  })

  app.patch("/config/agent", async (c) => {
    const parsed = UpdateAgentConfigRequestSchema.safeParse(await readJson(c.req))
    if (!parsed.success) return c.json({ error: "Invalid agent config request" }, 400)

    const agent = deps.registry.listAgents().find((candidate) => candidate.id === parsed.data.agentId)
    if (!agent) return c.json({ error: "Unknown agent" }, 400)

    await writeAgentSelectionConfig({ agentId: agent.id }, { configPath: deps.modelConfigPath, env: deps.modelConfigEnv })

    return c.json({ agentId: agent.id })
  })

  app.patch("/config/browser", async (c) => {
    const parsed = UpdateBrowserConfigRequestSchema.safeParse(await readJson(c.req))
    if (!parsed.success) return c.json({ error: "Invalid browser config request" }, 400)

    const browser = deps.registry.listEnvironments().find((candidate) => candidate.id === parsed.data.browserId)
    if (!browser) return c.json({ error: "Unknown browser" }, 400)

    await writeBrowserSelectionConfig({ browserId: browser.id }, { configPath: deps.modelConfigPath, env: deps.modelConfigEnv })

    return c.json({ browserId: browser.id })
  })

  app.patch("/config/browser/headless", async (c) => {
    const parsed = UpdateBrowserHeadlessConfigRequestSchema.safeParse(await readJson(c.req))
    if (!parsed.success) return c.json({ error: "Invalid browser headless config request" }, 400)

    await writeBrowserHeadlessConfig(
      { browserHeadless: parsed.data.browserHeadless },
      { configPath: deps.modelConfigPath, env: deps.modelConfigEnv },
    )
    await deps.onBrowserHeadlessChanged?.(parsed.data.browserHeadless)

    return c.json({ browserHeadless: parsed.data.browserHeadless })
  })
}

async function readJson(request: { json(): Promise<unknown> }): Promise<unknown> {
  return request.json().catch(() => null)
}
