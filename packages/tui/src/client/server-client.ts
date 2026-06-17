export function createServerClient(baseUrl: string) {
  return {
    async health(): Promise<{ ok: true }> {
      return request(`${baseUrl}/health`)
    },
    async createSession(projectPath: string): Promise<{ sessionId: string }> {
      return request(`${baseUrl}/sessions`, { method: "POST", body: JSON.stringify({ projectPath }) })
    },
    async submitRun(sessionId: string, prompt: string): Promise<{ runId: string }> {
      return request(`${baseUrl}/runs`, { method: "POST", body: JSON.stringify({ sessionId, prompt }) })
    },
    async cancelRun(runId: string): Promise<{ cancelled: boolean }> {
      return request(`${baseUrl}/runs/${runId}/cancel`, { method: "POST" })
    },
    async listPlugins(): Promise<unknown> {
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
