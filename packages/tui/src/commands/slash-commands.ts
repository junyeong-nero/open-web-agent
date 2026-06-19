export type SlashCommand =
  | { kind: "prompt"; value: string }
  | { kind: "help" }
  | { kind: "clear" }
  | { kind: "details" }
  | { kind: "session" }
  | { kind: "agent"; agentId: string | null }
  | { kind: "model"; modelId: string | null }
  | { kind: "browser"; environmentId: string | null }
  | { kind: "theme"; themeId: string | null }
  | { kind: "new" }
  | { kind: "stop" }
  | { kind: "quit" }
  | { kind: "unknown"; command: string }

export interface SlashCommandSuggestion {
  name: string
  description: string
  argumentHint: string | null
}

interface SlashCommandDefinition extends SlashCommandSuggestion {
  kind: Exclude<SlashCommand["kind"], "prompt" | "unknown">
}

const commandDefinitions = [
  { name: "/help", kind: "help", description: "Show available commands", argumentHint: null },
  { name: "/clear", kind: "clear", description: "Clear the current session view", argumentHint: null },
  { name: "/details", kind: "details", description: "Toggle the details inspector", argumentHint: null },
  { name: "/session", kind: "session", description: "Open session manager", argumentHint: null },
  { name: "/agent", kind: "agent", description: "Switch agent", argumentHint: "[id]" },
  { name: "/model", kind: "model", description: "Switch model", argumentHint: "[id]" },
  { name: "/browser", kind: "browser", description: "Switch browser", argumentHint: "[id]" },
  { name: "/themes", kind: "theme", description: "Switch theme", argumentHint: "[id]" },
  { name: "/new", kind: "new", description: "Start a new session", argumentHint: null },
  { name: "/stop", kind: "stop", description: "Stop the current run", argumentHint: null },
  { name: "/quit", kind: "quit", description: "Exit the TUI", argumentHint: null },
] satisfies SlashCommandDefinition[]

const commandAliases = new Map<string, SlashCommandDefinition["kind"]>([["/theme", "theme"]])
const commands = new Map<string, SlashCommandDefinition["kind"]>([
  ...commandDefinitions.map((command) => [command.name, command.kind] as const),
  ...commandAliases,
])

export function formatSlashCommandHelp(): string {
  return commandDefinitions.map((command) => (command.argumentHint ? `${command.name} ${command.argumentHint}` : command.name)).join(" ")
}

export function listSlashCommandSuggestions(input: string): SlashCommandSuggestion[] {
  if (!input.startsWith("/") || /\s/.test(input)) return []

  return commandDefinitions
    .filter((command) => command.name.startsWith(input))
    .map(({ name, description, argumentHint }) => ({ name, description, argumentHint }))
}

export function completeSlashCommand(input: string): string | null {
  const suggestion = listSlashCommandSuggestions(input)[0]
  if (!suggestion) return null

  return suggestion.argumentHint ? `${suggestion.name} ` : suggestion.name
}

export function parseSlashCommand(input: string): SlashCommand {
  const value = input.trim()
  if (!value.startsWith("/")) return { kind: "prompt", value }
  if (value === "/") return { kind: "help" }

  const command = value.split(/\s+/, 1)[0] ?? value
  const kind = commands.get(command)
  if (!kind) return { kind: "unknown", command }
  if (kind === "agent") {
    const agentId = value.slice(command.length).trim()
    return { kind: "agent", agentId: agentId.length > 0 ? agentId : null }
  }
  if (kind === "model") {
    const modelId = value.slice(command.length).trim()
    return { kind: "model", modelId: modelId.length > 0 ? modelId : null }
  }
  if (kind === "browser") {
    const environmentId = value.slice(command.length).trim()
    return { kind: "browser", environmentId: environmentId.length > 0 ? environmentId : null }
  }
  if (kind === "theme") {
    const themeId = value.slice(command.length).trim()
    return { kind: "theme", themeId: themeId.length > 0 ? themeId : null }
  }
  return { kind } as SlashCommand
}
