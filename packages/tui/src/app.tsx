import { createSignal, onCleanup, onMount } from "solid-js"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { PromptInput } from "./components/prompt-input"
import { SessionHeader } from "./components/session-header"
import { TranscriptPanel } from "./components/transcript-panel"
import { createEventStream } from "./client/event-source"
import { createServerClient } from "./client/server-client"
import { formatSlashCommandHelp, parseSlashCommand } from "./commands/slash-commands"
import { mapKeyEvent } from "./keymap/keybindings"
import { createInitialState, reduceTuiEvent } from "./state/reducer"
import type { AgentSummary, EnvironmentSummary, ModelSummary } from "./state/types"
import { getTheme, listThemes, type TuiTheme } from "./theme/themes"
import { selectedModelSummary } from "./components/session-shell-format"

export interface AppProps {
  serverUrl: string
  projectPath: string
  continueLast?: boolean
  sessionId?: string
  onExit(): void
}

export function App(props: AppProps) {
  const renderer = useRenderer()
  const client = createServerClient(props.serverUrl)
  const [state, setState] = createSignal(createInitialState(props.projectPath))
  const [prompt, setPrompt] = createSignal("")
  const currentTheme = (): TuiTheme => getTheme(state().selectedThemeId)

  onMount(async () => {
    const sessionId = await resolveStartupSession()
    setState((current) => reduceTuiEvent(current, { type: "session.created", sessionId }))
    await loadPlugins()

    const stream = createEventStream(props.serverUrl, (event) => {
      setState((current) => reduceTuiEvent(current, { type: "run.event", event }))
    })

    onCleanup(() => stream.close())
  })

  async function resolveStartupSession(): Promise<string> {
    if (props.sessionId) {
      const session = await client.getSession(props.sessionId)
      return session.id
    }
    if (props.continueLast) {
      const sessions = await client.listSessions()
      const latest = sessions.sessions.at(-1)
      if (latest) return latest.id
    }

    const session = await client.createSession(props.projectPath)
    return session.sessionId
  }

  async function loadPlugins() {
    try {
      const plugins = await client.listPlugins()
      setState((current) =>
        reduceTuiEvent(current, {
          type: "plugins.loaded",
          agents: plugins.agents,
          models: plugins.models,
          environments: plugins.environments,
        }),
      )
    } catch (error) {
      setState((current) =>
        reduceTuiEvent(current, {
          type: "conversation.append",
          message: { role: "system", content: `Failed to load plugins: ${error instanceof Error ? error.message : String(error)}` },
        }),
      )
    }
  }

  useKeyboard((key) => {
    const action = mapKeyEvent(key)
    if (action === "quit") exit()
    if (action === "new") void createNewSession()
    if (action === "cancel-or-quit") void cancelOrExit()
    if (action === "submit") void submitPrompt()
  })

  async function createNewSession() {
    const session = await client.createSession(props.projectPath)
    setState(() => reduceTuiEvent(createInitialState(props.projectPath), { type: "session.created", sessionId: session.sessionId }))
  }

  async function cancelOrExit() {
    const current = state()
    if (current.runStatus === "running" && current.activeRunId) {
      await client.cancelRun(current.activeRunId)
      return
    }
    exit()
  }

  function exit() {
    renderer.destroy()
    props.onExit()
  }

  async function submitPrompt() {
    const value = prompt().trim()
    if (value.length === 0) return

    const command = parseSlashCommand(value)
    if (command.kind === "quit") {
      exit()
      return
    }
    if (command.kind === "details") {
      setState((current) => reduceTuiEvent(current, { type: "slash.details" }))
      setPrompt("")
      return
    }
    if (command.kind === "clear") {
      setState((current) => reduceTuiEvent(current, { type: "state.clear" }))
      setPrompt("")
      return
    }
    if (command.kind === "new") {
      setPrompt("")
      await createNewSession()
      return
    }
    if (command.kind === "stop") {
      setPrompt("")
      await cancelOrExit()
      return
    }
    if (command.kind === "help") {
      setState((current) =>
        reduceTuiEvent(current, {
          type: "conversation.append",
          message: { role: "system", content: formatSlashCommandHelp() },
        }),
      )
      setPrompt("")
      return
    }
    if (command.kind === "theme") {
      setPrompt("")
      if (!command.themeId) {
        setState((current) =>
          reduceTuiEvent(current, {
            type: "conversation.append",
            message: { role: "system", content: formatThemeStatus(current.selectedThemeId) },
          }),
        )
        return
      }

      const themeId = command.themeId
      const themes = listThemes()
      if (!themes.some((theme) => theme.id === themeId)) {
        setState((current) =>
          reduceTuiEvent(current, {
            type: "conversation.append",
            message: { role: "system", content: `Unknown theme: ${themeId}. ${formatAvailableThemes()}` },
          }),
        )
        return
      }

      setState((current) =>
        reduceTuiEvent(
          reduceTuiEvent(current, { type: "theme.selected", themeId }),
          {
            type: "conversation.append",
            message: { role: "system", content: `Theme set to ${themeId}` },
          },
        ),
      )
      return
    }
    if (command.kind === "model") {
      setPrompt("")
      if (!command.modelId) {
        setState((current) =>
          reduceTuiEvent(current, {
            type: "conversation.append",
            message: { role: "system", content: formatModelStatus(current.selectedModelId, current.availableModels) },
          }),
        )
        return
      }

      const modelId = command.modelId
      const models = state().availableModels
      if (models.length > 0 && !models.some((model) => model.id === modelId)) {
        setState((current) =>
          reduceTuiEvent(current, {
            type: "conversation.append",
            message: { role: "system", content: `Unknown model: ${modelId}. ${formatAvailableModels(models)}` },
          }),
        )
        return
      }

      setState((current) =>
        reduceTuiEvent(
          reduceTuiEvent(current, { type: "model.selected", modelId }),
          {
            type: "conversation.append",
            message: { role: "system", content: `Model set to ${modelId}` },
          },
        ),
      )
      return
    }
    if (command.kind === "browser") {
      setPrompt("")
      if (!command.environmentId) {
        setState((current) =>
          reduceTuiEvent(current, {
            type: "conversation.append",
            message: { role: "system", content: formatBrowserStatus(current.selectedEnvironmentId, current.availableEnvironments) },
          }),
        )
        return
      }

      const environmentId = command.environmentId
      const environments = state().availableEnvironments
      if (environments.length > 0 && !environments.some((environment) => environment.id === environmentId)) {
        setState((current) =>
          reduceTuiEvent(current, {
            type: "conversation.append",
            message: { role: "system", content: `Unknown browser: ${environmentId}. ${formatAvailableBrowsers(environments)}` },
          }),
        )
        return
      }

      setState((current) =>
        reduceTuiEvent(
          reduceTuiEvent(current, { type: "environment.selected", environmentId }),
          {
            type: "conversation.append",
            message: { role: "system", content: `Browser set to ${environmentId}` },
          },
        ),
      )
      return
    }
    if (command.kind === "agent") {
      setPrompt("")
      if (!command.agentId) {
        setState((current) =>
          reduceTuiEvent(current, {
            type: "conversation.append",
            message: { role: "system", content: formatAgentStatus(current.selectedAgentId, current.availableAgents) },
          }),
        )
        return
      }

      const agentId = command.agentId
      const agents = state().availableAgents
      if (agents.length > 0 && !agents.some((agent) => agent.id === agentId)) {
        setState((current) =>
          reduceTuiEvent(current, {
            type: "conversation.append",
            message: { role: "system", content: `Unknown agent: ${agentId}. ${formatAvailableAgents(agents)}` },
          }),
        )
        return
      }

      setState((current) =>
        reduceTuiEvent(
          reduceTuiEvent(current, { type: "agent.selected", agentId }),
          {
            type: "conversation.append",
            message: { role: "system", content: `Agent set to ${agentId}` },
          },
        ),
      )
      return
    }
    if (command.kind === "unknown") {
      setState((current) =>
        reduceTuiEvent(current, {
          type: "conversation.append",
          message: { role: "system", content: `Unknown command: ${command.command}` },
        }),
      )
      setPrompt("")
      return
    }

    const activeSessionId = state().activeSessionId
    if (!activeSessionId) return

    setState((current) =>
      reduceTuiEvent(current, {
        type: "conversation.append",
        message: { role: "user", content: command.value },
      }),
    )
    setPrompt("")
    await client.submitRun(activeSessionId, command.value, {
      agentId: state().selectedAgentId,
      modelId: state().selectedModelId,
      environmentId: state().selectedEnvironmentId,
    })
  }

  return (
    <box flexDirection="column" width="100%" height="100%" paddingX={2} paddingY={1} rowGap={1} backgroundColor={currentTheme().surface}>
      <SessionHeader state={state()} theme={currentTheme()} />
      <TranscriptPanel state={state()} theme={currentTheme()} />
      <PromptInput
        value={prompt()}
        model={selectedModelSummary(state())}
        modelActivity={state().modelActivity}
        runStatus={state().runStatus}
        theme={currentTheme()}
        onChange={setPrompt}
        onSubmit={submitPrompt}
      />
    </box>
  )
}

function formatAgentStatus(selectedAgentId: string, agents: AgentSummary[]): string {
  return `Current agent: ${selectedAgentId}. ${formatAvailableAgents(agents)}`
}

function formatAvailableAgents(agents: AgentSummary[]): string {
  if (agents.length === 0) return "Available agents: not loaded"
  return `Available agents: ${agents.map((agent) => agent.id).join(", ")}`
}

function formatModelStatus(selectedModelId: string | null, models: ModelSummary[]): string {
  return `Current model: ${selectedModelId ?? "none"}. ${formatAvailableModels(models)}`
}

function formatAvailableModels(models: ModelSummary[]): string {
  if (models.length === 0) return "Available models: none configured"
  return `Available models: ${models.map((model) => model.id).join(", ")}`
}

function formatBrowserStatus(selectedEnvironmentId: string, environments: EnvironmentSummary[]): string {
  return `Current browser: ${selectedEnvironmentId}. ${formatAvailableBrowsers(environments)}`
}

function formatAvailableBrowsers(environments: EnvironmentSummary[]): string {
  if (environments.length === 0) return "Available browsers: not loaded"
  return `Available browsers: ${environments.map((environment) => environment.id).join(", ")}`
}

function formatThemeStatus(selectedThemeId: string): string {
  return `Current theme: ${selectedThemeId}. ${formatAvailableThemes()}`
}

function formatAvailableThemes(): string {
  return `Available themes: ${listThemes()
    .map((theme) => theme.id)
    .join(", ")}`
}
