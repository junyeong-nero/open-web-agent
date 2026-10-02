import { expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { startFixtureServer } from "./testing/fixture"

for (const command of ["run", "mcp"]) {
  for (const flag of [undefined, "ko-KR"]) {
    it(`${command} uses ${flag ? "--locale over OWA_LOCALE" : "OWA_LOCALE"}`, async () => {
      const fixture = startFixtureServer()
      const directory = await mkdtemp(join(tmpdir(), "owa-locale-cli-"))
      const expected = flag ?? "fr-FR"
      const env = { ...process.env, OWA_LOCALE: "fr-FR" } as Record<string, string>
      const args = ["--headless", "--caps", "unsafe", ...(flag ? ["--locale", flag] : [])]
      const expression = '({ language: navigator.language, ...JSON.parse(document.body.innerText) })'
      const client = new Client({ name: "locale-test", version: "0.0.0" })
      let proc: ReturnType<typeof Bun.spawn> | undefined
      try {
        let result: { language: string; acceptLanguage: string }
        if (command === "mcp") {
          await client.connect(new StdioClientTransport({
            command: process.execPath,
            args: [join(import.meta.dir, "cli.ts"), "mcp", ...args],
            env,
            stderr: "inherit",
          }))
          const navigated = await client.callTool({ name: "browser_navigate", arguments: { url: `${fixture.url}/locale` } })
          expect(navigated.isError).toBe(false)
          const evaluated = await client.callTool({ name: "browser_evaluate", arguments: { expression } })
          expect(evaluated.isError).toBe(false)
          result = JSON.parse((evaluated.content as Array<{ text: string }>)[0].text)
        } else {
          const module = join(directory, "model.ts")
          await Bun.write(module, `
            import { scriptedModel, lastToolText } from ${JSON.stringify(join(import.meta.dir, "testing/scripted-model.ts"))}
            export default () => scriptedModel([
              () => ({ toolCalls: [{ id: "1", name: "browser_navigate", arguments: { url: ${JSON.stringify(`${fixture.url}/locale`)} } }] }),
              () => ({ toolCalls: [{ id: "2", name: "browser_evaluate", arguments: { expression: ${JSON.stringify(expression)} } }] }),
              (request) => ({ text: lastToolText(request.messages), toolCalls: [] }),
            ])
          `)
          const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "run", "Read the locale", ...args, "--model-module", module, "--json"], {
            env, stdout: "pipe", stderr: "pipe",
          })
          proc = child
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
          ])
          expect(stderr).not.toContain("owa:")
          expect(code).toBe(0)
          result = JSON.parse(JSON.parse(stdout).answer)
        }
        expect(result.language).toBe(expected)
        expect(result.acceptLanguage.split(",")[0]).toBe(expected)
      } finally {
        proc?.kill()
        await client.close()
        fixture.stop()
        await rm(directory, { recursive: true, force: true })
      }
    }, 30_000)
  }
}
