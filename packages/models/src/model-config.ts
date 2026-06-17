export interface ModelConfig {
  defaultModel: string
  openaiApiKey: string | null
  openrouterApiKey: string | null
}

export function readModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  return {
    defaultModel: env.OPEN_WEB_AGENT_MODEL || "gpt-4.1-mini",
    openaiApiKey: env.OPENAI_API_KEY || null,
    openrouterApiKey: env.OPENROUTER_API_KEY || null,
  }
}
