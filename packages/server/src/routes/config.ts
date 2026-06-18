import type { Hono } from "hono"
import type { PluginRegistry } from "@open-web-agent/core"
import { writeAgentSelectionConfig, writeBrowserSelectionConfig, writeModelSelectionConfig } from "@open-web-agent/models"
import { UpdateAgentConfigRequestSchema, UpdateBrowserConfigRequestSchema, UpdateModelConfigRequestSchema } from "../schemas/api"

export interface ConfigRouteDeps {
  registry: PluginRegistry
  modelConfigPath?: string
}

export function registerConfigRoutes(app: Hono, deps: ConfigRouteDeps): void {
  app.patch("/config/model", async (c) => {
    const parsed = UpdateModelConfigRequestSchema.safeParse(await readJson(c.req))
    if (!parsed.success) return c.json({ error: "Invalid model config request" }, 400)

    const model = deps.registry.listModels().find((candidate) => candidate.id === parsed.data.modelId)
    if (!model) return c.json({ error: "Unknown model" }, 400)

    await writeModelSelectionConfig(
      { modelId: model.id, modelName: model.modelName ?? null },
      { configPath: deps.modelConfigPath },
    )

    return c.json({ modelId: model.id, modelName: model.modelName ?? null })
  })

  app.patch("/config/agent", async (c) => {
    const parsed = UpdateAgentConfigRequestSchema.safeParse(await readJson(c.req))
    if (!parsed.success) return c.json({ error: "Invalid agent config request" }, 400)

    const agent = deps.registry.listAgents().find((candidate) => candidate.id === parsed.data.agentId)
    if (!agent) return c.json({ error: "Unknown agent" }, 400)

    await writeAgentSelectionConfig({ agentId: agent.id }, { configPath: deps.modelConfigPath })

    return c.json({ agentId: agent.id })
  })

  app.patch("/config/browser", async (c) => {
    const parsed = UpdateBrowserConfigRequestSchema.safeParse(await readJson(c.req))
    if (!parsed.success) return c.json({ error: "Invalid browser config request" }, 400)

    const browser = deps.registry.listEnvironments().find((candidate) => candidate.id === parsed.data.browserId)
    if (!browser) return c.json({ error: "Unknown browser" }, 400)

    await writeBrowserSelectionConfig({ browserId: browser.id }, { configPath: deps.modelConfigPath })

    return c.json({ browserId: browser.id })
  })
}

async function readJson(request: { json(): Promise<unknown> }): Promise<unknown> {
  return request.json().catch(() => null)
}
