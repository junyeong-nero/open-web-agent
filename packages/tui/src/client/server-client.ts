import type { Observation } from "@open-web-agent/core"

export interface PluginSummary {
  id: string
  name: string
}

export interface AgentPluginSummary extends PluginSummary {
  description: string
}

export interface PluginList {
  agents: AgentPluginSummary[]
  models: Array<
    PluginSummary & {
      provider: string
      modelName?: string
      reasoningEffort?: string | null
      contextWindowTokens?: number | null
    }
  >
  environments: PluginSummary[]
  defaults?: {
    agentId?: string | null
    modelId?: string | null
    environmentId?: string | null
    browserHeadless?: boolean | null
  }
}

export interface SessionSummary {
  id: string
  projectPath: string
  projectHash: string
  title: string | null
  pinned: boolean
  deletedAt: string | null
  createdAt: string
  runStatus: "idle" | "running" | "completed" | "failed" | "cancelled"
  environmentId?: string | null
  browser?: Observation | null
}

export function createServerClient(baseUrl: string) {
  return {
    async health(): Promise<{ ok: true }> {
      return request(`${baseUrl}/health`)
    },
    async createSession(projectPath: string, environmentId?: string): Promise<{ sessionId: string; session: SessionSummary }> {
      return request(`${baseUrl}/sessions`, { method: "POST", body: JSON.stringify({ projectPath, environmentId }) })
    },
    async listSessions(): Promise<{ sessions: SessionSummary[] }> {
      return request(`${baseUrl}/sessions`)
    },
    async getSession(sessionId: string): Promise<SessionSummary> {
      return request(`${baseUrl}/sessions/${sessionId}`)
    },
    async updateSession(sessionId: string, update: { title?: string | null; pinned?: boolean }): Promise<SessionSummary> {
      return request(`${baseUrl}/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify(update) })
    },
    async deleteSession(sessionId: string): Promise<void> {
      await request<void>(`${baseUrl}/sessions/${sessionId}`, { method: "DELETE" })
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
    async selectModel(modelId: string, reasoningEffort?: string): Promise<{ modelId: string; modelName: string | null; reasoningEffort: string | null }> {
      return request(`${baseUrl}/config/model`, {
        method: "PATCH",
        body: JSON.stringify({ modelId, ...(reasoningEffort ? { reasoningEffort } : {}) }),
      })
    },
    async selectAgent(agentId: string): Promise<{ agentId: string }> {
      return request(`${baseUrl}/config/agent`, {
        method: "PATCH",
        body: JSON.stringify({ agentId }),
      })
    },
    async selectBrowser(browserId: string): Promise<{ browserId: string }> {
      return request(`${baseUrl}/config/browser`, {
        method: "PATCH",
        body: JSON.stringify({ browserId }),
      })
    },
    async setBrowserHeadless(browserHeadless: boolean): Promise<{ browserHeadless: boolean }> {
      return request(`${baseUrl}/config/browser/headless`, {
        method: "PATCH",
        body: JSON.stringify({ browserHeadless }),
      })
    },
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
