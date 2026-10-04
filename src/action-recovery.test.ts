import { expect, it } from "bun:test"
import type { Locator, Page } from "playwright"
import { runAgent } from "./agent"
import { BrowserSession } from "./browser"
import { createMcpServer } from "./mcp"
import { lastToolText, scriptedModel } from "./testing/scripted-model"
import { callTool, selectTools } from "./tools"

const tools = selectTools()

/** Inject an observation failure after a counted action, without launching a browser. */
function actionSession() {
  const session = new BrowserSession({ headless: true })
  const state = { actions: 0, fills: 0, snapshots: 0, failAction: false, failSnapshot: true }
  const perform = async () => {
    if (state.failAction) throw new Error("Element is not actionable")
    state.actions++
  }
  session.page = async () => ({
    waitForEvent: async () => { throw new Error("No navigation") },
  }) as unknown as Page
  session.locator = async () => ({
    count: async () => 1,
    click: perform,
    fill: async () => { state.fills++ },
    press: perform,
  }) as unknown as Locator
  session.selectTab = perform
  session.snapshot = async () => {
    state.snapshots++
    if (state.failSnapshot) throw new Error("ariaSnapshot: Timeout 10000ms exceeded")
    return `Page URL: https://fixture.invalid/\nSnapshot:\n- button "Submit" [ref=e${state.snapshots}]`
  }
  return { session, state }
}

it.each([
  { name: "browser_click", args: { ref: "e1" }, summary: "Clicked e1" },
  { name: "browser_type", args: { ref: "e1", text: "order", submit: true }, summary: "Typed into e1 and submitted" },
  { name: "browser_select_tab", args: { tabId: "t1" }, summary: "Selected tab t1" },
])("preserves $name completion when only the snapshot fails", async ({ name, args, summary }) => {
  const { session, state } = actionSession()
  const result = await callTool(tools, session, name, args)
  expect(result.isError).not.toBe(true)
  expect(result.text).toStartWith(summary)
  expect(result.text).toContain("action completed")
  expect(result.text).toContain("ariaSnapshot: Timeout")
  expect(result.text).toContain("Do not repeat the action")
  expect(result.snapshot).toContain("Current page state unavailable")
  expect(state.actions).toBe(1)
  if (name === "browser_type") expect(state.fills).toBe(1)

  state.failSnapshot = false
  const recovered = await callTool(tools, session, "browser_snapshot", {})
  expect(recovered.isError).not.toBe(true)
  expect(recovered.snapshot).toContain('[ref=e2]')
  expect(state.actions).toBe(1)
})

it("keeps action failures and explicit snapshot failures as errors", async () => {
  const { session, state } = actionSession()
  state.failAction = true
  const action = await callTool(tools, session, "browser_click", { ref: "e1" })
  expect(action.isError).toBe(true)
  expect(action.text).toContain("Element is not actionable")
  expect(action.text).not.toContain("action completed")
  expect(state.actions).toBe(0)
  expect(state.snapshots).toBe(0)

  const snapshot = await callTool(tools, session, "browser_snapshot", {})
  expect(snapshot.isError).toBe(true)
  expect(snapshot.text).toContain("ariaSnapshot: Timeout")
})

it("returns action completion and snapshot recovery guidance over MCP", async () => {
  const { session, state } = actionSession()
  const server = createMcpServer({ session, tools })
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "browser_click", arguments: { ref: "e1" } },
  })
  const result = response?.result as { isError: boolean; content: Array<{ text: string }> }
  expect(result.isError).toBe(false)
  expect(result.content[0].text).toContain("Clicked e1\nThe browser action completed")
  expect(result.content[0].text).toContain("Call browser_snapshot")
  expect(result.content[0].text).toContain("Current page state unavailable")
  expect(state.actions).toBe(1)
})

it("lets the agent recover fresh refs without repeating a completed action", async () => {
  const { session, state } = actionSession()
  state.failSnapshot = false
  const model = scriptedModel([
    () => ({ toolCalls: [{ id: "1", name: "browser_snapshot", arguments: {} }] }),
    () => {
      state.failSnapshot = true
      return { toolCalls: [{ id: "2", name: "browser_click", arguments: { ref: "e1" } }] }
    },
    request => {
      expect(lastToolText(request.messages)).toContain("Do not repeat the action")
      const observations = request.messages.filter(message => message.role === "tool")
      expect(JSON.stringify(observations)).not.toContain('[ref=e1]')
      expect(JSON.stringify(observations)).toContain("Current page state unavailable")
      state.failSnapshot = false
      return { toolCalls: [{ id: "3", name: "browser_snapshot", arguments: {} }] }
    },
    request => {
      expect(lastToolText(request.messages)).toContain('[ref=e3]')
      return { text: "Observed the page after submitting once", toolCalls: [] }
    },
  ])
  const result = await runAgent({ task: "Submit once", browser: session, model, maxConsecutiveFailures: 1 })
  expect(result.status).toBe("completed")
  expect(result.answer).toBe("Observed the page after submitting once")
  expect(state.actions).toBe(1)
  expect(state.snapshots).toBe(3)
})
