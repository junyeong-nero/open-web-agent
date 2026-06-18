import { describe, expect, it } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { readCodexOAuthToken, resolveCodexAuthPath } from "./codex-auth"

describe("readCodexOAuthToken", () => {
  it("resolves the default Codex auth path", () => {
    expect(resolveCodexAuthPath()).toBe(join(homedir(), ".codex", "auth.json"))
  })

  it("prefers an explicit Codex access token from env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-codex-auth-"))

    expect(readCodexOAuthToken({ CODEX_ACCESS_TOKEN: "env-token" }, { authPath: join(dir, "missing-auth.json") })).toBe(
      "env-token",
    )
  })

  it("reads the ChatGPT OAuth access token from Codex auth storage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-codex-auth-"))
    const authPath = join(dir, "auth.json")
    await writeFile(
      authPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: { access_token: "oauth-token", refresh_token: "refresh-token" },
      }),
    )

    expect(readCodexOAuthToken({}, { authPath })).toBe("oauth-token")
  })

  it("returns null when Codex auth storage is missing or does not contain an access token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-codex-auth-"))

    expect(readCodexOAuthToken({}, { authPath: join(dir, "missing-auth.json") })).toBeNull()
  })
})
