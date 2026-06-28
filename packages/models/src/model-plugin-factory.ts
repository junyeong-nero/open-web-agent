import type { ModelPlugin, ModelRequest, ModelResponse, RuntimeContext } from "@open-web-agent/core"

export interface ModelPluginOptions {
  id: string
  name: string
  provider: string
  modelName: string
  reasoningEffort?: string | null
  contextWindowTokens?: number | null
}

export function createModelPlugin(
  options: ModelPluginOptions,
  completeFn: (request: ModelRequest, ctx: RuntimeContext) => Promise<ModelResponse>,
): ModelPlugin {
  return {
    id: options.id,
    name: options.name,
    provider: options.provider,
    modelName: options.modelName,
    reasoningEffort: options.reasoningEffort ?? undefined,
    contextWindowTokens: options.contextWindowTokens ?? null,
    complete: completeFn,
  }
}
