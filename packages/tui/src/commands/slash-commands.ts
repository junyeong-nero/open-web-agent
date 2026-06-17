export type SlashCommand =
  | { kind: "prompt"; value: string }
  | { kind: "help" }
  | { kind: "clear" }
  | { kind: "details" }
  | { kind: "new" }
  | { kind: "stop" }
  | { kind: "quit" }
  | { kind: "unknown"; command: string }

const commands = new Map<string, SlashCommand["kind"]>([
  ["/help", "help"],
  ["/clear", "clear"],
  ["/details", "details"],
  ["/new", "new"],
  ["/stop", "stop"],
  ["/quit", "quit"],
])

export function parseSlashCommand(input: string): SlashCommand {
  const value = input.trim()
  if (!value.startsWith("/")) return { kind: "prompt", value }

  const command = value.split(/\s+/, 1)[0] ?? value
  const kind = commands.get(command)
  if (!kind) return { kind: "unknown", command }
  return { kind } as SlashCommand
}
