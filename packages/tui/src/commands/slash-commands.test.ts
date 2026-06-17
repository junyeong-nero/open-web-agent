import { describe, expect, it } from "bun:test"
import { parseSlashCommand } from "./slash-commands"

describe("parseSlashCommand", () => {
  it("recognizes details command", () => {
    expect(parseSlashCommand("/details")).toEqual({ kind: "details" })
  })

  it("recognizes clear command", () => {
    expect(parseSlashCommand("/clear")).toEqual({ kind: "clear" })
  })

  it("rejects unknown command", () => {
    expect(parseSlashCommand("/missing")).toEqual({ kind: "unknown", command: "/missing" })
  })
})
