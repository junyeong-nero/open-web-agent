import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { eventsPath, hashProjectPath, resolveOwaHome, runPath, sessionPath } from "./paths"

describe("resolveOwaHome", () => {
  it("prefers OWA_HOME", () => {
    expect(resolveOwaHome({ OWA_HOME: "/tmp/open-web-agent-test" })).toBe("/tmp/open-web-agent-test")
  })

  it("falls back to ~/.open-web-agent", () => {
    expect(resolveOwaHome({})).toBe(join(homedir(), ".open-web-agent"))
  })
})

describe("hashProjectPath", () => {
  it("hashes the absolute path with SHA-256", () => {
    const input = "."
    const expected = createHash("sha256").update(resolve(input)).digest("hex")

    expect(hashProjectPath(input)).toBe(expected)
    expect(hashProjectPath(input)).toHaveLength(64)
  })
})

describe("storage paths", () => {
  it("builds session, run, and events paths under the project hash", () => {
    const home = "/tmp/owa"
    const projectHash = "abc123"
    const sessionId = "ses_1"
    const runId = "run_1"

    expect(sessionPath(home, projectHash, sessionId)).toBe("/tmp/owa/projects/abc123/sessions/ses_1")
    expect(runPath(home, projectHash, sessionId, runId)).toBe(
      "/tmp/owa/projects/abc123/sessions/ses_1/runs/run_1",
    )
    expect(eventsPath(home, projectHash, sessionId, runId)).toBe(
      "/tmp/owa/projects/abc123/sessions/ses_1/runs/run_1/events.jsonl",
    )
  })
})
