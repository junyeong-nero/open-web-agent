import { describe, expect, it } from "bun:test"
import { completeSlashCommand, formatSlashCommandHelp, listSlashCommandSuggestions, parseSlashCommand } from "./slash-commands"

describe("parseSlashCommand", () => {
  it("recognizes details command", () => {
    expect(parseSlashCommand("/details")).toEqual({ kind: "details" })
  })

  it("recognizes clear command", () => {
    expect(parseSlashCommand("/clear")).toEqual({ kind: "clear" })
  })

  it("recognizes session command", () => {
    expect(parseSlashCommand("/session")).toEqual({ kind: "session" })
  })

  it("recognizes agent command without an id", () => {
    expect(parseSlashCommand("/agent")).toEqual({ kind: "agent", agentId: null })
  })

  it("recognizes agent command with an id", () => {
    expect(parseSlashCommand("/agent plan-act")).toEqual({ kind: "agent", agentId: "plan-act" })
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

  it("recognizes themes alias with and without an id", () => {
    expect(parseSlashCommand("/themes")).toEqual({ kind: "theme", themeId: null })
    expect(parseSlashCommand("/themes opencode")).toEqual({ kind: "theme", themeId: "opencode" })
  })

  it("rejects unknown command", () => {
    expect(parseSlashCommand("/missing")).toEqual({ kind: "unknown", command: "/missing" })
  })

  it("shows help for a bare slash submission", () => {
    expect(parseSlashCommand("/")).toEqual({ kind: "help" })
  })
})

describe("listSlashCommandSuggestions", () => {
  it("lists available commands after typing a slash", () => {
    expect(listSlashCommandSuggestions("/").map((command) => command.name)).toEqual([
      "/help",
      "/clear",
      "/details",
      "/session",
      "/agent",
      "/model",
      "/browser",
      "/themes",
      "/new",
      "/stop",
      "/quit",
    ])
  })

  it("filters commands by the current slash token", () => {
    expect(listSlashCommandSuggestions("/cl")).toEqual([
      {
        name: "/clear",
        description: "Clear the current session view",
        argumentHint: null,
      },
    ])
  })

  it("hides suggestions for normal prompts and command arguments", () => {
    expect(listSlashCommandSuggestions("open example.com")).toEqual([])
    expect(listSlashCommandSuggestions("/theme ")).toEqual([])
    expect(listSlashCommandSuggestions("/theme opencode")).toEqual([])
  })
})

describe("completeSlashCommand", () => {
  it("completes the current slash token to the first displayed command", () => {
    expect(completeSlashCommand("/cl")).toBe("/clear")
    expect(completeSlashCommand("/ag")).toBe("/agent ")
  })

  it("returns null when no slash command suggestion is displayed", () => {
    expect(completeSlashCommand("open example.com")).toBeNull()
    expect(completeSlashCommand("/theme opencode")).toBeNull()
    expect(completeSlashCommand("/missing")).toBeNull()
  })
})

describe("formatSlashCommandHelp", () => {
  it("formats help text from displayed slash commands", () => {
    expect(formatSlashCommandHelp()).toBe(
      "/help /clear /details /session /agent [id] /model [id] /browser [id] /themes [id] /new /stop /quit",
    )
  })
})
