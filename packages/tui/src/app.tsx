/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useSelectionHandler } from "@opentui/solid"
import { PromptInput } from "./components/prompt-input"
import {
  RuntimeSelector,
  buildAgentSelectorSections,
  buildBrowserSelectorSections,
  buildModelSelectorSections,
  type RuntimeSelectorOption,
} from "./components/runtime-selector"
import { SessionHeader } from "./components/session-header"
import { filterSessions, scrollSessionIndexIntoView, SessionPalette, sessionDisplayName, type SessionPaletteMode } from "./components/session-palette"
import { TranscriptPanel } from "./components/transcript-panel"
import { createEventStream } from "./client/event-source"
import { createServerClient } from "./client/server-client"
import { copySelectionToClipboard, pasteSystemClipboardText } from "./clipboard/system-clipboard"
import { formatSlashCommandHelp, listSlashCommandSuggestions, parseSlashCommand } from "./commands/slash-commands"
import { mapKeyEvent } from "./keymap/keybindings"
import { defaultPromptHistoryStore, type PromptHistoryStore } from "./prompt-history"
import { createInitialState, reduceTuiEvent } from "./state/reducer"
import type { AgentSummary, EnvironmentSummary, ModelSummary, RuntimeSelectorKind, SessionSummary, TuiState } from "./state/types"
import { getTheme, listThemes, type TuiTheme } from "./theme/themes"
import { selectedAgentSummary, selectedModelSummary } from "./components/session-shell-format"

export interface AppProps {
  serverUrl: string
  projectPath: string
  continueLast?: boolean
  sessionId?: string
  promptHistory?: PromptHistoryStore
  initialPromptHistory?: string[]
  initialRuntimePlugins?: {
    agents: AgentSummary[]
    models: ModelSummary[]
    environments: EnvironmentSummary[]
  }
  onExit(): void
}

export function App(props: AppProps) {
  const renderer = useRenderer()
  const client = createServerClient(props.serverUrl)
  const promptHistoryStore = () => props.promptHistory ?? defaultPromptHistoryStore
  const initialState = props.initialRuntimePlugins
    ? reduceTuiEvent(createInitialState(props.projectPath), {
        type: "plugins.loaded",
        agents: props.initialRuntimePlugins.agents,
        models: props.initialRuntimePlugins.models,
        environments: props.initialRuntimePlugins.environments,
      })
    : createInitialState(props.projectPath)
  const [state, setState] = createSignal(initialState)
  const [prompt, setPrompt] = createSignal("")
  const [promptHistory, setPromptHistory] = createSignal<string[]>(props.initialPromptHistory ?? [])
  const [sessionPaletteOpen, setSessionPaletteOpen] = createSignal(false)
  const [sessionPaletteIndex, setSessionPaletteIndex] = createSignal(0)
  const [sessionPaletteQuery, setSessionPaletteQuery] = createSignal("")
  const [sessionPaletteMode, setSessionPaletteMode] = createSignal<SessionPaletteMode>("search")
  const [sessionRenameValue, setSessionRenameValue] = createSignal("")
  const [sessionLoadingPhase, setSessionLoadingPhase] = createSignal(0)
  const [activePane, setActivePane] = createSignal<"prompt" | "transcript">("prompt")
  let sessionPaletteScroll: ScrollBoxRenderable | undefined
  let transcriptScroll: ScrollBoxRenderable | undefined
  const currentTheme = (): TuiTheme => getTheme(state().selectedThemeId)
  const runtimeSelectorOpen = () => state().runtimeSelectorKind !== null
  let stream: ReturnType<typeof createEventStream> | undefined
  const runtimeSelectorConfig = createMemo(() => {
    const current = state()
    const query = current.runtimeSelectorQuery
    const kind = current.runtimeSelectorKind
    if (kind === "agent") {
      return {
        title: "Select agent",
        emptyMessage: "No matching agents",
        sections: buildAgentSelectorSections(current.availableAgents, current.selectedAgentId, query),
      }
    }
    if (kind === "browser") {
      return {
        title: "Select browser",
        emptyMessage: "No matching browsers",
        sections: buildBrowserSelectorSections(current.availableEnvironments, current.selectedEnvironmentId, query),
      }
    }
    return {
      title: "Select model",
      emptyMessage: "No matching models",
      sections: buildModelSelectorSections(current.availableModels, current.selectedModelId, query),
    }
  })
  const sessionSpinner = setInterval(() => setSessionLoadingPhase((phase) => (phase + 1) % 4), 140)

  onCleanup(() => clearInterval(sessionSpinner))
  onCleanup(() => stream?.close())

  onMount(() => {
    void initializeApp()
  })

  async function initializeApp() {
    promptHistoryStore()
      .load()
      .then(setPromptHistory)
      .catch((error) => appendSystemMessage(`Failed to load prompt history: ${formatError(error)}`))

    await loadPlugins()
    const session = await resolveStartupSession()
    setState((current) => activateSessionSummary(current, session))
    await refreshSessions()

    stream = createEventStream(props.serverUrl, (event) => {
      setState((current) => reduceTuiEvent(current, { type: "run.event", event }))
    })
  }

  async function resolveStartupSession(): Promise<SessionSummary> {
    if (props.sessionId) {
      return client.getSession(props.sessionId)
    }
    if (props.continueLast) {
      const sessions = await client.listSessions()
      const latest = sessions.sessions.at(-1)
      if (latest) return client.getSession(latest.id)
    }

    const session = await client.createSession(props.projectPath, state().selectedEnvironmentId || undefined)
    return session.session
  }

  async function refreshSessions() {
    const sessions = await client.listSessions()
    setState((current) => reduceTuiEvent(current, { type: "sessions.loaded", sessions: sessions.sessions }))
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
          defaultAgentId: plugins.defaults?.agentId,
          defaultModelId: plugins.defaults?.modelId,
          defaultEnvironmentId: plugins.defaults?.environmentId,
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
    if (action === "quit") {
      key.preventDefault()
      exit()
      return
    }

    if (sessionPaletteOpen()) {
      handleSessionPaletteKey(key)
      return
    }

    const text = printableKeyText(key)
    if (!runtimeSelectorOpen() && activePane() !== "prompt" && text) {
      key.preventDefault()
      setActivePane("prompt")
      setPrompt((value) => value + text)
      return
    }

    if (action === "new") void createNewSession()
    if (action === "copy") {
      key.preventDefault()
      void copySelectionToClipboard(renderer)
    }
    if (action === "paste") {
      key.preventDefault()
      void pasteSystemClipboardText(renderer)
    }
    if (action === "focus-next" || action === "focus-previous") {
      if (action === "focus-next" && activePane() === "prompt" && listSlashCommandSuggestions(prompt()).length > 0) return
      key.preventDefault()
      setActivePane((pane) => (pane === "prompt" ? "transcript" : "prompt"))
      return
    }
    if (action === "scroll-line-up" && activePane() === "transcript") {
      key.preventDefault()
      transcriptScroll?.scrollBy(-1, "content")
      return
    }
    if (action === "scroll-line-down" && activePane() === "transcript") {
      key.preventDefault()
      transcriptScroll?.scrollBy(1, "content")
      return
    }
    if (action === "reasoning-effort-decrease" || action === "reasoning-effort-increase") {
      if (prompt().length > 0 && activePane() === "prompt") return
      const changed = changeReasoningEffort(action === "reasoning-effort-increase" ? 1 : -1)
      if (changed) key.preventDefault()
      return
    }
    if (action === "cancel-or-quit") void cancelOrExit()
    if (action === "scroll-page-up") transcriptScroll?.scrollBy(-0.5, "viewport")
    if (action === "scroll-page-down") transcriptScroll?.scrollBy(0.5, "viewport")
    if (action === "scroll-top") transcriptScroll?.scrollBy(-1, "content")
    if (action === "scroll-bottom") transcriptScroll?.scrollBy(1, "content")
  })

  useSelectionHandler(() => {
    void copySelectionToClipboard(renderer)
  })

  async function createNewSession() {
    const session = await client.createSession(props.projectPath, state().selectedEnvironmentId || undefined)
    setState((current) => activateSessionSummary(current, session.session))
    await refreshSessions()
  }

  async function openSessionPalette() {
    setSessionPaletteOpen(true)
    setSessionPaletteMode("search")
    setSessionPaletteQuery("")
    setSessionPaletteIndex(0)
    await refreshSessions().catch((error) => appendSystemMessage(`Failed to load sessions: ${formatError(error)}`))
  }

  function closeSessionPalette() {
    setSessionPaletteOpen(false)
    setSessionPaletteMode("search")
    setSessionRenameValue("")
  }

  function visibleSessions(): SessionSummary[] {
    return filterSessions(state().sessions, sessionPaletteQuery())
  }

  function selectedPaletteSession(): SessionSummary | null {
    const sessions = visibleSessions()
    if (sessions.length === 0) return null
    return sessions[clampedSessionPaletteIndex()] ?? null
  }

  function clampedSessionPaletteIndex(): number {
    const count = visibleSessions().length
    if (count === 0) return 0
    return Math.min(sessionPaletteIndex(), count - 1)
  }

  function handleSessionPaletteKey(key: {
    name?: string
    ctrl?: boolean
    meta?: boolean
    super?: boolean
    sequence?: string
    preventDefault?: () => void
  }) {
    key.preventDefault?.()
    if (key.name === "escape" || key.name === "esc") {
      if (sessionPaletteMode() === "rename") {
        setSessionPaletteMode("search")
        setSessionRenameValue("")
        return
      }
      closeSessionPalette()
      return
    }

    if (sessionPaletteMode() === "rename") {
      if (key.name === "return" || key.name === "enter" || key.name === "linefeed") {
        void renameSelectedSession()
        return
      }
      if (key.name === "backspace" || key.sequence === "\u007f") {
        setSessionRenameValue((value) => value.slice(0, -1))
        return
      }
      const text = printableKeyText(key)
      if (text) setSessionRenameValue((value) => value + text)
      return
    }

    if (key.name === "up" || isControlKey(key, "p", "\u0010")) {
      moveSessionSelection(-1)
      return
    }
    if (key.name === "down") {
      moveSessionSelection(1)
      return
    }
    if (isControlKey(key, "d", "\u0004")) {
      void deleteSelectedSession()
      return
    }
    if (isControlKey(key, "f", "\u0006")) {
      void toggleSelectedSessionPin()
      return
    }
    if (isControlKey(key, "n", "\u000e")) {
      beginRenameSelectedSession()
      return
    }
    if (key.name === "return" || key.name === "enter" || key.name === "linefeed") {
      void selectPaletteSession()
      return
    }
    if (key.name === "backspace" || key.sequence === "\u007f") {
      setSessionPaletteQuery((query) => query.slice(0, -1))
      setSessionPaletteIndex(0)
      sessionPaletteScroll?.scrollTo(0)
      return
    }
    const text = printableKeyText(key)
    if (text) {
      setSessionPaletteQuery((query) => query + text)
      setSessionPaletteIndex(0)
      sessionPaletteScroll?.scrollTo(0)
    }
  }

  function moveSessionSelection(delta: number) {
    const count = visibleSessions().length
    if (count === 0) return
    let nextIndex = 0
    setSessionPaletteIndex((index) => {
      nextIndex = (index + delta + count) % count
      return nextIndex
    })
    scrollSessionIndexIntoView(sessionPaletteScroll, nextIndex, count)
  }

  async function selectPaletteSession() {
    const session = selectedPaletteSession()
    if (!session) return
    try {
      const latest = await client.getSession(session.id)
      setState((current) => activateSessionSummary(current, latest))
      closeSessionPalette()
    } catch (error) {
      appendSystemMessage(`Failed to open session: ${formatError(error)}`)
    }
  }

  function beginRenameSelectedSession() {
    const session = selectedPaletteSession()
    if (!session) return
    setSessionPaletteMode("rename")
    setSessionRenameValue(session.title ?? sessionDisplayName(session))
  }

  async function renameSelectedSession() {
    const session = selectedPaletteSession()
    if (!session) return
    const title = sessionRenameValue().trim()
    try {
      const updated = await client.updateSession(session.id, { title: title.length > 0 ? title : null })
      setState((current) => reduceTuiEvent(current, { type: "session.updated", session: updated }))
      setSessionPaletteMode("search")
      setSessionRenameValue("")
    } catch (error) {
      appendSystemMessage(`Failed to rename session: ${formatError(error)}`)
    }
  }

  async function toggleSelectedSessionPin() {
    const session = selectedPaletteSession()
    if (!session) return
    try {
      const updated = await client.updateSession(session.id, { pinned: !session.pinned })
      setState((current) => reduceTuiEvent(current, { type: "session.updated", session: updated }))
    } catch (error) {
      appendSystemMessage(`Failed to pin session: ${formatError(error)}`)
    }
  }

  async function deleteSelectedSession() {
    const session = selectedPaletteSession()
    if (!session) return
    try {
      await client.deleteSession(session.id)
      setState((current) => reduceTuiEvent(current, { type: "session.deleted", sessionId: session.id }))
      setSessionPaletteIndex((index) => Math.max(0, Math.min(index, visibleSessions().length - 1)))
    } catch (error) {
      appendSystemMessage(`Failed to delete session: ${formatError(error)}`)
    }
  }

  function appendSystemMessage(content: string) {
    setState((current) =>
      reduceTuiEvent(current, {
        type: "conversation.append",
        message: { role: "system", content },
      }),
    )
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

  async function submitPrompt(submittedValue?: string) {
    const value = (submittedValue ?? prompt()).trim()
    if (value.length === 0) return
    await recordPromptHistory(value)

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
    if (command.kind === "session") {
      setPrompt("")
      await openSessionPalette()
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
        openRuntimeSelector("model")
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

      await persistAndSelectModel(modelId)
      return
    }
    if (command.kind === "browser") {
      setPrompt("")
      if (!command.environmentId) {
        openRuntimeSelector("browser")
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

      await persistAndSelectBrowser(environmentId)
      return
    }
    if (command.kind === "agent") {
      setPrompt("")
      if (!command.agentId) {
        openRuntimeSelector("agent")
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

      await persistAndSelectAgent(agentId)
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
      agentId: state().selectedAgentId || undefined,
      modelId: state().selectedModelId,
      environmentId: state().selectedEnvironmentId || undefined,
    })
  }

  function openRuntimeSelector(kind: RuntimeSelectorKind) {
    setState((current) => ({ ...current, runtimeSelectorKind: kind, runtimeSelectorQuery: "" }))
  }

  function closeRuntimeSelector() {
    setState((current) => ({ ...current, runtimeSelectorKind: null, runtimeSelectorQuery: "" }))
  }

  async function selectRuntimeOption(option: RuntimeSelectorOption) {
    const kind = state().runtimeSelectorKind
    closeRuntimeSelector()
    if (kind === "agent") {
      await persistAndSelectAgent(option.id)
      return
    }
    if (kind === "browser") {
      await persistAndSelectBrowser(option.id)
      return
    }
    await persistAndSelectModel(option.id)
  }

  async function recordPromptHistory(value: string) {
    try {
      setPromptHistory(await promptHistoryStore().append(value))
    } catch (error) {
      appendSystemMessage(`Failed to save prompt history: ${formatError(error)}`)
    }
  }

  function changeReasoningEffort(delta: -1 | 1): boolean {
    const model = selectedModelSummary(state())
    if (!model?.reasoningEffort) return false

    const currentIndex = reasoningEfforts.indexOf(model.reasoningEffort)
    const baseIndex = currentIndex >= 0 ? currentIndex : reasoningEfforts.indexOf("medium")
    const nextEffort = reasoningEfforts[(baseIndex + delta + reasoningEfforts.length) % reasoningEfforts.length]
    if (!nextEffort || nextEffort === model.reasoningEffort) return false

    void persistAndSelectModel(model.id, { reasoningEffort: nextEffort, message: `Reasoning effort set to ${nextEffort}` })
    return true
  }

  async function persistAndSelectModel(modelId: string, options: { reasoningEffort?: string; message?: string } = {}) {
    try {
      await client.selectModel(modelId, options.reasoningEffort)
    } catch (error) {
      setState((current) =>
        reduceTuiEvent(current, {
          type: "conversation.append",
          message: { role: "system", content: `Failed to save model selection: ${formatError(error)}` },
        }),
      )
      return
    }

    setState((current) =>
      reduceTuiEvent(
        reduceTuiEvent(current, { type: "model.selected", modelId, reasoningEffort: options.reasoningEffort }),
        {
          type: "conversation.append",
          message: { role: "system", content: options.message ?? `Model set to ${modelId}` },
        },
      ),
    )
  }

  async function persistAndSelectAgent(agentId: string) {
    try {
      await client.selectAgent(agentId)
    } catch (error) {
      setState((current) =>
        reduceTuiEvent(current, {
          type: "conversation.append",
          message: { role: "system", content: `Failed to save agent selection: ${formatError(error)}` },
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
  }

  async function persistAndSelectBrowser(environmentId: string) {
    try {
      await client.selectBrowser(environmentId)
    } catch (error) {
      setState((current) =>
        reduceTuiEvent(current, {
          type: "conversation.append",
          message: { role: "system", content: `Failed to save browser selection: ${formatError(error)}` },
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
  }

  return (
    <box
      position="relative"
      flexDirection="column"
      width="100%"
      height="100%"
      paddingX={2}
      paddingY={1}
      rowGap={1}
      backgroundColor={currentTheme().surface}
    >
      <SessionHeader state={state()} theme={currentTheme()} />
      {sessionPaletteOpen() ? (
        <SessionPalette
          sessions={state().sessions}
          activeSessionId={state().activeSessionId}
          selectedIndex={clampedSessionPaletteIndex()}
          query={sessionPaletteQuery()}
          mode={sessionPaletteMode()}
          renameValue={sessionRenameValue()}
          loadingPhase={sessionLoadingPhase()}
          theme={currentTheme()}
          scrollRef={(node) => {
            sessionPaletteScroll = node
          }}
        />
      ) : null}
      <TranscriptPanel
        state={state()}
        theme={currentTheme()}
        scrollRef={(node) => {
          transcriptScroll = node
        }}
        focused={!sessionPaletteOpen() && !runtimeSelectorOpen() && activePane() === "transcript"}
        onFocusRequest={() => setActivePane("transcript")}
      />
      <PromptInput
        value={prompt()}
        agent={selectedAgentSummary(state())}
        model={selectedModelSummary(state())}
        modelActivity={state().modelActivity}
        runStatus={state().runStatus}
        theme={currentTheme()}
        history={promptHistory()}
        focused={!sessionPaletteOpen() && !runtimeSelectorOpen() && activePane() === "prompt"}
        onChange={setPrompt}
        onSubmit={submitPrompt}
        onFocusRequest={() => setActivePane("prompt")}
        onReasoningEffortChange={changeReasoningEffort}
      />
      {runtimeSelectorOpen() ? (
        <RuntimeSelector
          title={runtimeSelectorConfig().title}
          emptyMessage={runtimeSelectorConfig().emptyMessage}
          sections={runtimeSelectorConfig().sections}
          theme={currentTheme()}
          onQueryChange={(query) => setState((current) => ({ ...current, runtimeSelectorQuery: query }))}
          onSelect={selectRuntimeOption}
          onCancel={closeRuntimeSelector}
        />
      ) : null}
    </box>
  )
}

const reasoningEfforts = ["low", "medium", "high"]

function activateSessionSummary(state: TuiState, session: SessionSummary): TuiState {
  const selected = reduceTuiEvent(reduceTuiEvent(state, { type: "session.updated", session }), {
    type: "session.selected",
    sessionId: session.id,
  })
  return session.environmentId ? reduceTuiEvent(selected, { type: "environment.selected", environmentId: session.environmentId }) : selected
}

function formatAvailableAgents(agents: AgentSummary[]): string {
  if (agents.length === 0) return "Available agents: not loaded"
  return `Available agents: ${agents.map((agent) => agent.id).join(", ")}`
}

function formatAvailableModels(models: ModelSummary[]): string {
  if (models.length === 0) return "Available models: none configured"
  return `Available models: ${models.map((model) => model.id).join(", ")}`
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

function printableKeyText(key: { sequence?: string; ctrl?: boolean; meta?: boolean; super?: boolean }): string | null {
  if (key.ctrl || key.meta || key.super) return null
  if (!key.sequence || key.sequence.length !== 1) return null
  if (key.sequence < " " || key.sequence === "\u007f") return null
  return key.sequence
}

function isControlKey(key: { name?: string; ctrl?: boolean; sequence?: string }, name: string, sequence: string): boolean {
  return (key.ctrl === true && key.name === name) || key.sequence === sequence
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
