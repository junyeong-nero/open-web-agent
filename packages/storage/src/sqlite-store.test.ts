import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SQLiteStore } from "./sqlite-store"

async function store(): Promise<SQLiteStore> {
  const directory = await mkdtemp(join(tmpdir(), "owa-sqlite-"))
  const sqlite = new SQLiteStore(join(directory, "metadata.sqlite"))
  sqlite.migrate()
  return sqlite
}

describe("SQLiteStore", () => {
  it("persists sessions across store instances", async () => {
    const sqlite = await store()
    sqlite.upsertSession({
      id: "ses_1",
      projectPath: "/tmp/project",
      projectHash: "hash",
      environmentId: null,
      title: null,
      pinned: false,
      deletedAt: null,
      createdAt: "2026-06-17T00:00:00.000Z",
    })
    sqlite.close()

    const reopened = new SQLiteStore(sqlite.filePath)
    reopened.migrate()

    expect(reopened.getSession("ses_1")?.projectPath).toBe("/tmp/project")
    expect(reopened.listSessions().map((session) => session.id)).toEqual(["ses_1"])
    reopened.close()
  })

  it("persists session title, pinned state, and soft deletion", async () => {
    const sqlite = await store()
    sqlite.upsertSession({
      id: "ses_1",
      projectPath: "/tmp/project",
      projectHash: "hash",
      environmentId: null,
      title: null,
      pinned: false,
      deletedAt: null,
      createdAt: "2026-06-17T00:00:00.000Z",
    })

    sqlite.updateSession("ses_1", { title: "Repo commit check", pinned: true })

    expect(sqlite.getSession("ses_1")).toMatchObject({
      title: "Repo commit check",
      pinned: true,
      deletedAt: null,
    })

    sqlite.deleteSession("ses_1", "2026-06-17T00:02:00.000Z")

    expect(sqlite.getSession("ses_1")).toBeNull()
    expect(sqlite.listSessions()).toEqual([])
    sqlite.close()
  })

  it("persists runs and messages", async () => {
    const sqlite = await store()
    sqlite.upsertSession({
      id: "ses_1",
      projectPath: "/tmp/project",
      projectHash: "hash",
      environmentId: null,
      title: null,
      pinned: false,
      deletedAt: null,
      createdAt: "2026-06-17T00:00:00.000Z",
    })
    sqlite.upsertRun({
      id: "run_1",
      sessionId: "ses_1",
      status: "completed",
      finalAnswer: "done",
      createdAt: "2026-06-17T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:01.000Z",
    })
    sqlite.appendMessage({
      id: "msg_1",
      sessionId: "ses_1",
      role: "assistant",
      content: "done",
      createdAt: "2026-06-17T00:00:01.000Z",
    })

    expect(sqlite.listRuns("ses_1")[0]?.finalAnswer).toBe("done")
    expect(sqlite.listMessages("ses_1")[0]?.content).toBe("done")
    sqlite.close()
  })

  it("exports a session as Markdown", async () => {
    const sqlite = await store()
    sqlite.upsertSession({
      id: "ses_1",
      projectPath: "/tmp/project",
      projectHash: "hash",
      environmentId: null,
      title: "Greeting",
      pinned: false,
      deletedAt: null,
      createdAt: "2026-06-17T00:00:00.000Z",
    })
    sqlite.appendMessage({
      id: "msg_1",
      sessionId: "ses_1",
      role: "user",
      content: "hello",
      createdAt: "2026-06-17T00:00:01.000Z",
    })

    expect(sqlite.exportSessionMarkdown("ses_1")).toContain("## user")
    expect(sqlite.exportSessionMarkdown("ses_1")).toContain("hello")
    sqlite.close()
  })
})
