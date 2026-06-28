export interface ProviderCapabilities {
  input: string[]
  output: string[]
}

export const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  openai:       { input: ["text", "image"], output: ["text"] },
  openrouter:   { input: ["text", "image"], output: ["text"] },
  gemini:       { input: ["text", "image"], output: ["text"] },
  claude:       { input: ["text", "image"], output: ["text"] },
  "codex-oauth": { input: ["text"], output: ["text"] },
}

export function getProviderCapabilities(provider: string): ProviderCapabilities {
  return PROVIDER_CAPABILITIES[provider] ?? { input: ["text"], output: ["text"] }
}
