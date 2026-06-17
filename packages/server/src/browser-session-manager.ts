import type {
  EventBus,
  Observation,
  PluginRegistry,
  RunEvent,
  RunEventType,
  RuntimeContext,
  SessionState,
} from "@open-web-agent/core"

interface BrowserSessionBinding {
  session: SessionState
  environmentId: string
  lastObservation: Observation | null
}

export interface BrowserSessionManagerOptions {
  eventBus: EventBus
  registry: PluginRegistry
  defaultEnvironmentId: string
  now?: () => Date
}

export class BrowserSessionManager {
  private readonly bindings = new Map<string, BrowserSessionBinding>()
  private readonly now: () => Date

  constructor(private readonly options: BrowserSessionManagerOptions) {
    this.now = options.now ?? (() => new Date())
  }

  get defaultEnvironmentId(): string {
    return this.options.defaultEnvironmentId
  }

  getLastObservation(sessionId: string): Observation | null {
    return this.bindings.get(sessionId)?.lastObservation ?? null
  }

  async open(session: SessionState, environmentId?: string | null): Promise<Observation | null> {
    return this.prepareSession("open", session, environmentId)
  }

  async attach(session: SessionState, environmentId?: string | null): Promise<Observation | null> {
    return this.prepareSession("attach", session, environmentId)
  }

  async capture(session: SessionState, environmentId?: string | null): Promise<Observation | null> {
    const resolvedEnvironmentId = environmentId ?? session.environmentId ?? this.bindings.get(session.id)?.environmentId ?? this.defaultEnvironmentId
    const boundSession = { ...session, environmentId: resolvedEnvironmentId }
    const environment = this.options.registry.getEnvironment(resolvedEnvironmentId)
    const observation = await environment.observe(this.createContext(boundSession, resolvedEnvironmentId))
    this.bindings.set(session.id, {
      session: boundSession,
      environmentId: resolvedEnvironmentId,
      lastObservation: observation,
    })
    return observation
  }

  async close(session: SessionState): Promise<void> {
    const binding = this.bindings.get(session.id)
    const environmentId = binding?.environmentId ?? session.environmentId ?? this.defaultEnvironmentId
    const environment = this.options.registry.getEnvironment(environmentId)
    await environment.close(this.createContext(binding?.session ?? session, environmentId))
    this.bindings.delete(session.id)
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.bindings.values()].map((binding) => binding.session)
    await Promise.all(sessions.map((session) => this.close(session)))
  }

  private async prepareSession(
    mode: "open" | "attach",
    session: SessionState,
    environmentId?: string | null,
  ): Promise<Observation | null> {
    const resolvedEnvironmentId = environmentId ?? session.environmentId ?? this.bindings.get(session.id)?.environmentId ?? this.defaultEnvironmentId
    const existing = this.bindings.get(session.id)
    if (existing && existing.environmentId !== resolvedEnvironmentId) {
      await this.close(existing.session)
    }

    const boundSession = { ...session, environmentId: resolvedEnvironmentId }
    const environment = this.options.registry.getEnvironment(resolvedEnvironmentId)
    const ctx = this.createContext(boundSession, resolvedEnvironmentId)

    if (mode === "open" && environment.openSession) {
      await environment.openSession(ctx)
    } else if (mode === "attach" && environment.attachSession) {
      await environment.attachSession(ctx)
    } else {
      await environment.reset(ctx)
    }

    const observation = await environment.observe(ctx)
    this.bindings.set(session.id, {
      session: boundSession,
      environmentId: resolvedEnvironmentId,
      lastObservation: observation,
    })
    return observation
  }

  private createContext(session: SessionState, environmentId: string): RuntimeContext {
    const runId = `session_${session.id}`
    return {
      session,
      runId,
      runDir: "",
      environmentId,
      eventBus: this.options.eventBus,
      abortSignal: new AbortController().signal,
      now: this.now,
      emit: async (type: RunEventType, payload: Record<string, unknown>, stepId: string | null = null): Promise<RunEvent> => ({
        id: `evt_${runId}`,
        runId,
        sessionId: session.id,
        stepId,
        sequence: 0,
        type,
        payload,
        createdAt: this.now().toISOString(),
      }),
    }
  }
}
