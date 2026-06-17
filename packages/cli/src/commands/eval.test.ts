import { describe, expect, it } from "bun:test"
import { evalCommand } from "./eval"

describe("evalCommand", () => {
  it("prints the fixture comparison summary", () => {
    const lines: string[] = []

    evalCommand({ taskIds: ["example-domain-title"] }, { stdout: (line) => lines.push(line) })

    expect(lines.join("\n")).toContain("runs: 1")
    expect(lines.join("\n")).toContain("example-domain-title mock-agent/none/mock-browser success")
  })
})
