import { createSignal, onCleanup, onMount } from "solid-js"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { PromptInput } from "./components/prompt-input"
import { SessionHeader } from "./components/session-header"
import { TranscriptPanel } from "./components/transcript-panel"
import { createEventStream } from "./client/event-source"
import { createServerClient } from "./client/server-client"
import { parseSlashCommand } from "./commands/slash-commands"
import { mapKeyEvent } from "./keymap/keybindings"
import { createInitialState, reduceTuiEvent } from "./state/reducer"
import { getTheme, listThemes, type TuiTheme } from "./theme/themes"

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
          message: { role: "system", content: "/help /clear /details /theme [id] /new /stop /quit" },
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
      if (!listThemes().some((theme) => theme.id === themeId)) {
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
    await client.submitRun(activeSessionId, command.value)
  }

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={currentTheme().surface}>
      <SessionHeader state={state()} theme={currentTheme()} />
      <TranscriptPanel state={state()} theme={currentTheme()} />
      <PromptInput
        value={prompt()}
        agentId={state().selectedAgentId}
        modelId={state().selectedModelId}
        environmentId={state().selectedEnvironmentId}
        runStatus={state().runStatus}
        theme={currentTheme()}
        onChange={setPrompt}
        onSubmit={submitPrompt}
      />
    </box>
  )
}

function formatThemeStatus(selectedThemeId: string): string {
  return `Current theme: ${selectedThemeId}. ${formatAvailableThemes()}`
}

function formatAvailableThemes(): string {
  return `Available themes: ${listThemes()
    .map((theme) => theme.id)
    .join(", ")}`
}
