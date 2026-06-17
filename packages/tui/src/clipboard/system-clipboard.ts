import { spawn } from "node:child_process"

export interface ClipboardSelection {
  getSelectedText(): string
}

export interface ClipboardRenderer {
  getSelection(): ClipboardSelection | null
  copyToClipboardOSC52(text: string): boolean
}

export interface ClipboardCommandResult {
  ok: boolean
  stdout: string
}

export type ClipboardCommandRunner = (command: string, args: string[]) => Promise<ClipboardCommandResult>
export type ClipboardTextReader = () => Promise<string | null>
export type ClipboardTextWriter = (text: string) => Promise<boolean>
export type ClipboardWriteCommandRunner = (command: string, args: string[], input: string) => Promise<boolean>

export interface ClipboardPasteRenderer {
  keyInput: {
    processPaste(bytes: Uint8Array, metadata?: { mimeType?: string; kind?: "text" | "binary" | "unknown" }): void
  }
}

export interface ReadSystemClipboardOptions {
  platform?: NodeJS.Platform
  run?: ClipboardCommandRunner
}

export interface WriteSystemClipboardOptions {
  platform?: NodeJS.Platform
  run?: ClipboardWriteCommandRunner
}

export async function copySelectionToClipboard(
  renderer: ClipboardRenderer,
  write: ClipboardTextWriter = writeSystemClipboardText,
): Promise<boolean> {
  const text = renderer.getSelection()?.getSelectedText() ?? ""
  if (text.length === 0) return false
  if (renderer.copyToClipboardOSC52(text)) return true
  return write(text)
}

export async function readSystemClipboardText(options: ReadSystemClipboardOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform
  const run = options.run ?? runClipboardCommand

  for (const [command, args] of clipboardReadCommands(platform)) {
    const result = await run(command, args)
    if (result.ok) return result.stdout
  }

  return null
}

export async function pasteSystemClipboardText(renderer: ClipboardPasteRenderer, read: ClipboardTextReader = readSystemClipboardText): Promise<boolean> {
  const text = await read()
  if (!text) return false

  renderer.keyInput.processPaste(new TextEncoder().encode(text), { mimeType: "text/plain", kind: "text" })
  return true
}

export async function writeSystemClipboardText(text: string, options: WriteSystemClipboardOptions = {}): Promise<boolean> {
  const platform = options.platform ?? process.platform
  const run = options.run ?? runClipboardWriteCommand

  for (const [command, args] of clipboardWriteCommands(platform)) {
    if (await run(command, args, text)) return true
  }

  return false
}

export function clipboardReadCommands(platform: NodeJS.Platform): Array<[string, string[]]> {
  if (platform === "darwin") return [["pbpaste", []]]
  if (platform === "win32") {
    return [
      ["powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]],
      ["powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]],
    ]
  }
  if (platform === "linux") {
    return [
      ["wl-paste", ["--no-newline"]],
      ["xclip", ["-selection", "clipboard", "-out"]],
      ["xsel", ["--clipboard", "--output"]],
    ]
  }
  return []
}

export function clipboardWriteCommands(platform: NodeJS.Platform): Array<[string, string[]]> {
  if (platform === "darwin") return [["pbcopy", []]]
  if (platform === "win32") {
    return [
      ["powershell.exe", ["-NoProfile", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"]],
      ["powershell", ["-NoProfile", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"]],
    ]
  }
  if (platform === "linux") {
    return [
      ["wl-copy", []],
      ["xclip", ["-selection", "clipboard"]],
      ["xsel", ["--clipboard", "--input"]],
    ]
  }
  return []
}

async function runClipboardCommand(command: string, args: string[]): Promise<ClipboardCommandResult> {
  try {
    const child = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return { ok: exitCode === 0, stdout }
  } catch {
    return { ok: false, stdout: "" }
  }
}

async function runClipboardWriteCommand(command: string, args: string[], input: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (copied: boolean) => {
      if (settled) return
      settled = true
      resolve(copied)
    }

    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] })
    child.on("error", () => finish(false))
    child.on("close", (code) => finish(code === 0))
    child.stdin.on("error", () => undefined)
    try {
      child.stdin.end(input)
    } catch {
      finish(false)
    }
  })
}
