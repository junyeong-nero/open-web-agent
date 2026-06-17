import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import { parseArgs } from "./args"

describe("parseArgs", () => {
  it("recognizes default mode", () => {
    expect(parseArgs([], "/tmp/project")).toEqual({ mode: "default", projectPath: "/tmp/project" })
  })

  it("recognizes project path mode", () => {
    expect(parseArgs(["../project"], "/tmp/current")).toEqual({
      mode: "default",
      projectPath: resolve("/tmp/current", "../project"),
    })
  })

  it("recognizes run mode", () => {
    expect(parseArgs(["run", "example.com에 접속해서 페이지 제목을 알려줘"], "/tmp/project")).toEqual({
      mode: "run",
      prompt: "example.com에 접속해서 페이지 제목을 알려줘",
      projectPath: "/tmp/project",
    })
  })

  it("recognizes serve mode", () => {
    expect(parseArgs(["serve", "--port", "4096", "--hostname", "127.0.0.1"], "/tmp/project")).toEqual({
      mode: "serve",
      hostname: "127.0.0.1",
      port: 4096,
    })
  })

  it("recognizes connect mode", () => {
    expect(parseArgs(["--connect", "http://127.0.0.1:4096"], "/tmp/project")).toEqual({
      mode: "connect",
      serverUrl: "http://127.0.0.1:4096",
    })
  })
})
