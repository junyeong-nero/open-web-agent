import type { Hono } from "hono"
import type { PluginRegistry } from "@open-web-agent/core"
import { writeModelSelectionConfig } from "@open-web-agent/models"
import { UpdateModelConfigRequestSchema } from "../schemas/api"

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
    if (parsed.data.reasoningEffort && !model.reasoningEffort) {
      return c.json({ error: "Model does not support reasoning effort" }, 400)
    }

    const reasoningEffort = parsed.data.reasoningEffort ?? model.reasoningEffort ?? null
    if (parsed.data.reasoningEffort) model.reasoningEffort = parsed.data.reasoningEffort

    await writeModelSelectionConfig(
      { modelId: model.id, modelName: model.modelName ?? null, reasoningEffort },
      { configPath: deps.modelConfigPath },
    )

    return c.json({ modelId: model.id, modelName: model.modelName ?? null, reasoningEffort })
  })
}

async function readJson(request: { json(): Promise<unknown> }): Promise<unknown> {
  return request.json().catch(() => null)
}
