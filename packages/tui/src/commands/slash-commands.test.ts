import { describe, expect, it } from "bun:test"
import { parseSlashCommand } from "./slash-commands"

describe("parseSlashCommand", () => {
  it("recognizes details command", () => {
    expect(parseSlashCommand("/details")).toEqual({ kind: "details" })
  })

  it("rejects unknown command", () => {
    expect(parseSlashCommand("/missing")).toEqual({ kind: "unknown", command: "/missing" })
  })
})
