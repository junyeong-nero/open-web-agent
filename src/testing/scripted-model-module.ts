import { refFor } from "./fixture"
import { lastToolText, scriptedModel } from "./scripted-model"

/** Used by the MCP test via --model-module: opens the URL named in the task and reports the price. */
export default () =>
  scriptedModel([
    (request) => {
      const task = request.messages[0]?.role === "user" && request.messages[0].content[0]?.type === "text" ? request.messages[0].content[0].text : ""
      const url = task.match(/https?:\/\/\S+/)?.[0] ?? "about:blank"
      return { toolCalls: [{ id: "1", name: "browser_navigate", arguments: { url } }] }
    },
    (request) => ({ toolCalls: [{ id: "2", name: "browser_click", arguments: { ref: refFor(lastToolText(request.messages), /link "Pricing" \[/) } }] }),
    (request) => ({ text: lastToolText(request.messages).match(/\$\d+/)?.[0] ?? "unknown", toolCalls: [] }),
  ])
