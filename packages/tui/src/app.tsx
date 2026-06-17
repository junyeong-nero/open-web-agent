import { createSignal, onCleanup, onMount } from "solid-js"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { BrowserStatePanel } from "./components/browser-state-panel"
import { ConversationPanel } from "./components/conversation-panel"
import { InspectorPanel } from "./components/inspector-panel"
import { PromptInput } from "./components/prompt-input"
import { TimelinePanel } from "./components/timeline-panel"
import { TopBar } from "./components/top-bar"
import { createEventStream } from "./client/event-source"
import { createServerClient } from "./client/server-client"
import { parseSlashCommand } from "./commands/slash-commands"
import { mapKeyEvent } from "./keymap/keybindings"
import { createInitialState, reduceTuiEvent } from "./state/reducer"

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
          message: { role: "system", content: "/help /details /new /stop /quit" },
        }),
      )
      setPrompt("")
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
    <box flexDirection="column" width="100%" height="100%">
      <TopBar state={state()} />
      <box flexDirection="row" flexGrow={1}>
        <ConversationPanel state={state()} />
        <TimelinePanel state={state()} />
        {state().inspectorVisible ? <InspectorPanel state={state()} /> : null}
        <BrowserStatePanel state={state()} />
      </box>
      <PromptInput value={prompt()} onChange={setPrompt} onSubmit={submitPrompt} />
    </box>
  )
}
