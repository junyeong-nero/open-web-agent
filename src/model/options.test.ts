import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { modelConfigFromEnv, parseModelOptions, resolveModel } from "./resolve"

const request = { system: "system", messages: [], tools: [] }

describe("model request options", () => {
  it("validates JSON objects without echoing supplied values", () => {
    expect(parseModelOptions(undefined)).toBeUndefined()
    expect(parseModelOptions('{}')).toEqual({})
    expect(modelConfigFromEnv({ OWA_MODEL_OPTIONS: '{"reasoning_effort":"none"}' }).extraBody).toEqual({ reasoning_effort: "none" })
    for (const input of ['', 'null', '[]', 'true', '42', '"secret-token"', '{"secret-token":']) {
      expect(() => parseModelOptions(input)).toThrow("must be a JSON object")
      try { parseModelOptions(input) } catch (error) {
        expect(String(error)).not.toContain("secret-token")
      }
    }
    for (const key of ['model', 'messages', 'tools', 'system', 'stream', 'api_key', 'apiKey', 'authorization', 'headers']) {
      expect(() => parseModelOptions(JSON.stringify({ [key]: 'secret-token' }))).toThrow(`cannot set "${key}"`)
    }
  })

  it("also rejects reserved options from library callers", async () => {
    await expect(resolveModel({ model: "ollama:local", extraBody: { tools: [] } }, {})).rejects.toThrow('cannot set "tools"')
  })

  it("passes options through both API formats and retains their defaults", async () => {
    const bodies: any[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(req) {
        return req.json().then(body => {
          bodies.push(body)
          return Response.json({ choices: [{ message: { content: "done" } }], content: [{ type: "text", text: "done" }] })
        })
      },
    })
    try {
      for (const api of ["openai", "anthropic"] as const) {
        const model = await resolveModel({ model: "local", api, baseUrl: `http://127.0.0.1:${server.port}`, extraBody: { temperature: 0, max_tokens: 123 } }, {})
        await model.complete(request)
        expect(bodies.at(-1)).toMatchObject({ model: "local", temperature: 0, max_tokens: 123 })
        const defaults = await resolveModel({ model: "local", api, baseUrl: `http://127.0.0.1:${server.port}` }, {})
        await defaults.complete(request)
        expect(bodies.at(-1).temperature).toBeUndefined()
        expect(bodies.at(-1).reasoning_effort).toBeUndefined()
        expect(bodies.at(-1).max_tokens).toBe(api === "anthropic" ? 4096 : undefined)
      }
    } finally { server.stop(true) }
  })

  it("lets CLI options replace even invalid env JSON, and {} clears env options", async () => {
    const bodies: any[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        bodies.push(await req.json())
        return Response.json({ choices: [{ message: { content: "done" } }] })
      },
    })
    const run = async (environment: string, options?: string) => {
      const proc = Bun.spawn([
        process.execPath, join(import.meta.dir, "..", "cli.ts"), "run", "Reply done", "--model", "local", "--api", "openai", "--base-url", `http://127.0.0.1:${server.port}`, "--json",
        ...(options === undefined ? [] : ["--model-options", options]),
      ], {
        env: { PATH: process.env.PATH, OWA_MODEL_OPTIONS: environment },
        stdout: "pipe", stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      expect(code).toBe(0)
      expect(stderr).not.toContain("secret-token")
      expect(JSON.parse(stdout).answer).toBe("done")
    }
    try {
      await run('{"temperature":0}')
      expect(bodies.at(-1).temperature).toBe(0)
      await run('{"temperature":0}', '{"reasoning_effort":"none"}')
      expect(bodies.at(-1).reasoning_effort).toBe("none")
      expect(bodies.at(-1).temperature).toBeUndefined()
      await run('invalid secret-token', '{"reasoning_effort":"none"}')
      expect(bodies.at(-1).reasoning_effort).toBe("none")
      await run('{"temperature":0}', '{}')
      expect(bodies.at(-1).temperature).toBeUndefined()
    } finally { server.stop(true) }
  })
})
