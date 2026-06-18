import { describe, expect, it } from "bun:test"
import {
  copySelectionToClipboard,
  pasteSystemClipboardText,
  readSystemClipboardText,
  writeSystemClipboardText,
  type ClipboardCommandResult,
} from "./system-clipboard"

describe("copySelectionToClipboard", () => {
  it("copies selected text with OSC52", async () => {
    const copiedText: string[] = []
    const copied = await copySelectionToClipboard({
      getSelection: () => ({ getSelectedText: () => "selected text" }),
      copyToClipboardOSC52: (text) => {
        copiedText.push(text)
        return true
      },
    })

    expect(copied).toBe(true)
    expect(copiedText).toEqual(["selected text"])
  })

  it("does not copy empty selections", async () => {
    const copied = await copySelectionToClipboard({
      getSelection: () => ({ getSelectedText: () => "" }),
      copyToClipboardOSC52: () => {
        throw new Error("copy should not be called")
      },
    })

    expect(copied).toBe(false)
  })

  it("falls back to a system clipboard writer when OSC52 copy fails", async () => {
    const fallbackText: string[] = []
    const copied = await copySelectionToClipboard(
      {
        getSelection: () => ({ getSelectedText: () => "fallback copy" }),
        copyToClipboardOSC52: () => false,
      },
      async (text) => {
        fallbackText.push(text)
        return true
      },
    )

    expect(copied).toBe(true)
    expect(fallbackText).toEqual(["fallback copy"])
  })

  it("prefers a system clipboard writer for non-ASCII selections", async () => {
    const fallbackText: string[] = []
    const oscText: string[] = []
    const copied = await copySelectionToClipboard(
      {
        getSelection: () => ({ getSelectedText: () => "오늘 날씨" }),
        copyToClipboardOSC52: (text) => {
          oscText.push(text)
          return true
        },
      },
      async (text) => {
        fallbackText.push(text)
        return true
      },
    )

    expect(copied).toBe(true)
    expect(fallbackText).toEqual(["오늘 날씨"])
    expect(oscText).toEqual([])
  })
})

describe("readSystemClipboardText", () => {
  it("reads from pbpaste on macOS", async () => {
    const calls: Array<[string, string[]]> = []
    const text = await readSystemClipboardText({
      platform: "darwin",
      run: async (command, args): Promise<ClipboardCommandResult> => {
        calls.push([command, args])
        return { ok: true, stdout: "mac clipboard" }
      },
    })

    expect(text).toBe("mac clipboard")
    expect(calls).toEqual([["pbpaste", []]])
  })

  it("falls back between Linux clipboard commands", async () => {
    const calls: Array<[string, string[]]> = []
    const text = await readSystemClipboardText({
      platform: "linux",
      run: async (command, args): Promise<ClipboardCommandResult> => {
        calls.push([command, args])
        return command === "xclip" ? { ok: true, stdout: "linux clipboard" } : { ok: false, stdout: "" }
      },
    })

    expect(text).toBe("linux clipboard")
    expect(calls).toEqual([
      ["wl-paste", ["--no-newline"]],
      ["xclip", ["-selection", "clipboard", "-out"]],
    ])
  })
})

describe("writeSystemClipboardText", () => {
  it("writes to pbcopy on macOS", async () => {
    const calls: Array<[string, string[], string]> = []
    const copied = await writeSystemClipboardText("mac copy", {
      platform: "darwin",
      run: async (command, args, input) => {
        calls.push([command, args, input])
        return true
      },
    })

    expect(copied).toBe(true)
    expect(calls).toEqual([["pbcopy", [], "mac copy"]])
  })
})

describe("pasteSystemClipboardText", () => {
  it("injects clipboard text as a paste event", async () => {
    const pastedText: string[] = []
    const pasted = await pasteSystemClipboardText(
      {
        keyInput: {
          processPaste: (bytes) => {
            pastedText.push(new TextDecoder().decode(bytes))
          },
        },
      },
      async () => "clipboard paste",
    )

    expect(pasted).toBe(true)
    expect(pastedText).toEqual(["clipboard paste"])
  })

  it("does not inject empty clipboard text", async () => {
    const pasted = await pasteSystemClipboardText(
      {
        keyInput: {
          processPaste: () => {
            throw new Error("paste should not be called")
          },
        },
      },
      async () => "",
    )

    expect(pasted).toBe(false)
  })
})
