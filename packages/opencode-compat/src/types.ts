export interface OpenCodeModel {
  id: string
  name: string
  limit: {
    context: number
  }
  capabilities: {
    reasoning: boolean
  }
}

export interface OpenCodeProvider {
  id: string
  name: string
  source: "env" | "config" | "custom" | "api"
  env: string[]
  options: Record<string, unknown>
  models: Record<string, OpenCodeModel>
}

export interface OpenCodeProviderConfig {
  providers: OpenCodeProvider[]
  default: Record<string, string>
}

export interface OpenCodeProviderList {
  all: OpenCodeProvider[]
  default: Record<string, string>
  connected: string[]
}

export interface OpenCodeAgent {
  name: string
  description?: string
  mode: "subagent" | "primary" | "all"
  native?: boolean
  hidden?: boolean
  permission: []
  options: Record<string, unknown>
  model?: {
    providerID: string
    modelID: string
  }
}

export interface OpenCodeSession {
  id: string
  slug: string
  projectID: string
  directory: string
  title: string
  agent?: string
  model?: {
    id: string
    providerID: string
  }
  version: string
  time: {
    created: number
    updated: number
  }
}

export interface OpenCodeTextPart {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
  synthetic?: boolean
  time?: {
    start: number
    end?: number
  }
  metadata?: Record<string, unknown>
}

export interface OpenCodeUserMessage {
  id: string
  sessionID: string
  role: "user"
  time: {
    created: number
  }
  agent: string
  model: {
    providerID: string
    modelID: string
  }
}

export interface OpenCodeAssistantMessage {
  id: string
  sessionID: string
  role: "assistant"
  time: {
    created: number
    completed?: number
  }
  parentID: string
  modelID: string
  providerID: string
  mode: string
  agent: string
  path: {
    cwd: string
    root: string
  }
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
}

export type OpenCodeMessage = OpenCodeUserMessage | OpenCodeAssistantMessage

export interface OpenCodeMessageBundle {
  info: OpenCodeMessage
  parts: OpenCodeTextPart[]
}

export interface OpenCodeEvent {
  id: string
  type:
    | "session.updated"
    | "session.status"
    | "message.updated"
    | "message.part.updated"
  properties: Record<string, unknown>
}

export interface OpenCodeGlobalEvent {
  directory: string
  workspace?: string
  payload: OpenCodeEvent
}
