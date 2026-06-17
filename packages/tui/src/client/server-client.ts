export interface PluginSummary {
  id: string
  name: string
}

export interface AgentPluginSummary extends PluginSummary {
  description: string
}

export interface PluginList {
  agents: AgentPluginSummary[]
  models: Array<PluginSummary & { provider: string }>
  environments: PluginSummary[]
}

export function createServerClient(baseUrl: string) {
  return {
    async health(): Promise<{ ok: true }> {
      return request(`${baseUrl}/health`)
    },
    async createSession(projectPath: string): Promise<{ sessionId: string }> {
      return request(`${baseUrl}/sessions`, { method: "POST", body: JSON.stringify({ projectPath }) })
    },
    async listSessions(): Promise<{ sessions: Array<{ id: string; projectPath: string; createdAt: string }> }> {
      return request(`${baseUrl}/sessions`)
    },
    async getSession(sessionId: string): Promise<{ id: string; projectPath: string; createdAt: string }> {
      return request(`${baseUrl}/sessions/${sessionId}`)
    },
    async submitRun(
      sessionId: string,
      prompt: string,
      options: { agentId?: string; modelId?: string | null; environmentId?: string } = {},
    ): Promise<{ runId: string }> {
      return request(`${baseUrl}/runs`, {
        method: "POST",
        body: JSON.stringify({
          sessionId,
          prompt,
          agentId: options.agentId,
          modelId: options.modelId ?? undefined,
          environmentId: options.environmentId,
        }),
      })
    },
    async cancelRun(runId: string): Promise<{ cancelled: boolean }> {
      return request(`${baseUrl}/runs/${runId}/cancel`, { method: "POST" })
    },
    async listPlugins(): Promise<PluginList> {
      return request(`${baseUrl}/plugins`)
    },
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  return response.json() as Promise<T>
}
