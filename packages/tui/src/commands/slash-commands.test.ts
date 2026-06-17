import { describe, expect, it } from "bun:test"
import { parseSlashCommand } from "./slash-commands"

describe("parseSlashCommand", () => {
  it("recognizes details command", () => {
    expect(parseSlashCommand("/details")).toEqual({ kind: "details" })
  })

  it("recognizes clear command", () => {
    expect(parseSlashCommand("/clear")).toEqual({ kind: "clear" })
  })

  it("recognizes agent command without an id", () => {
    expect(parseSlashCommand("/agent")).toEqual({ kind: "agent", agentId: null })
  })

  it("recognizes agent command with an id", () => {
    expect(parseSlashCommand("/agent plan-act-agent")).toEqual({ kind: "agent", agentId: "plan-act-agent" })
  })

  it("recognizes model command with and without an id", () => {
    expect(parseSlashCommand("/model")).toEqual({ kind: "model", modelId: null })
    expect(parseSlashCommand("/model openai")).toEqual({ kind: "model", modelId: "openai" })
  })

  it("recognizes browser command with and without an id", () => {
    expect(parseSlashCommand("/browser")).toEqual({ kind: "browser", environmentId: null })
    expect(parseSlashCommand("/browser playwright-browser")).toEqual({ kind: "browser", environmentId: "playwright-browser" })
  })

  it("recognizes theme command with and without an id", () => {
    expect(parseSlashCommand("/theme")).toEqual({ kind: "theme", themeId: null })
    expect(parseSlashCommand("/theme opencode")).toEqual({ kind: "theme", themeId: "opencode" })
  })

  it("rejects unknown command", () => {
    expect(parseSlashCommand("/missing")).toEqual({ kind: "unknown", command: "/missing" })
  })
})
