import { expect, it } from "bun:test"
import { runAgent } from "./agent"
import { BrowserSession } from "./browser"
import { scriptedModel } from "./testing/scripted-model"
import { selectTools } from "./tools"

it.each(["browser_navigate", "browser_select_tab"])("replaces the initial snapshot after %s and preserves the task", async name => {
  class ExistingSession extends BrowserSession {
    override get started() { return true }
    override async snapshot() { return "INITIAL_PAGE_WITH_OLD_REFS " + "old body ".repeat(4_000) }
  }
  const task = "Find the price; retain this task instruction"
  const model = scriptedModel([
    request => {
      expect(JSON.stringify(request.messages)).toContain("INITIAL_PAGE_WITH_OLD_REFS")
      return { toolCalls: [{ id: "1", name, arguments: name === "browser_navigate" ? { url: "https://fixture.invalid/" } : { tabId: "t2" } }] }
    },
    request => {
      const messages = JSON.stringify(request.messages)
      expect(messages).not.toContain("INITIAL_PAGE_WITH_OLD_REFS")
      expect(messages).not.toContain("old body")
      expect(messages).toContain("older snapshot omitted")
      expect(messages).toContain("NEW_PAGE_WITH_FRESH_REFS")
      expect(messages).toContain(task)
      return { text: "done", toolCalls: [] }
    },
  ])
  const tools = selectTools().map(tool => tool.name === name ? { ...tool, run: async () => ({ text: "Navigated", snapshot: "NEW_PAGE_WITH_FRESH_REFS" }) } : tool)
  const result = await runAgent({ task, browser: new ExistingSession(), model, tools })
  expect(result.status).toBe("completed")
})

it("retains the initial snapshot until another snapshot replaces it", async () => {
  class ExistingSession extends BrowserSession {
    override get started() { return true }
    override async snapshot() { return "INITIAL_PAGE" }
  }
  const model = scriptedModel([
    () => ({ toolCalls: [{ id: "1", name: "missing", arguments: {} }] }),
    request => {
      expect(JSON.stringify(request.messages)).toContain("INITIAL_PAGE")
      return { text: "done", toolCalls: [] }
    },
  ])
  expect((await runAgent({ task: "t", browser: new ExistingSession(), model })).status).toBe("completed")
})
