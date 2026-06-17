import { For } from "solid-js"
import type { TuiState } from "../state/types"
import type { TuiTheme } from "../theme/themes"

export interface BrowserStatePanelProps {
  state: TuiState
  theme: TuiTheme
}

export function BrowserStatePanel(props: BrowserStatePanelProps) {
  const browser = () => props.state.browser
  const browserState = () =>
    [
      `URL: ${browser().url}`,
      `Title: ${browser().title ?? ""}`,
      `Screenshot: ${browser().screenshotPath ?? ""}`,
      `Elements: ${browser().interactiveElements.length}`,
    ].join("\n")
  const observation = () => browser().text ?? "No page text captured yet."

  return (
    <box
      border
      title="browser / subgoals"
      width={42}
      paddingX={1}
      paddingY={1}
      backgroundColor={props.theme.surfaceAlt}
      borderColor={props.theme.border}
      titleColor={props.theme.textMuted}
      rowGap={1}
    >
      <box border borderColor={props.theme.border} backgroundColor={props.theme.panel} paddingX={1} paddingY={1}>
        <text fg={props.theme.accent}>browser state</text>
        <text fg={props.theme.textMuted} wrapMode="word">
          {browserState()}
        </text>
      </box>
      <box border borderColor={props.theme.border} backgroundColor={props.theme.panel} paddingX={1} paddingY={1}>
        <text fg={props.theme.warning}>subgoals</text>
        {props.state.plan.length === 0 ? (
          <text fg={props.theme.textMuted}>No plan has been created yet.</text>
        ) : (
          <For each={props.state.plan}>
            {(item) => (
              <text fg={item.status === "completed" ? props.theme.success : item.status === "active" ? props.theme.warning : props.theme.textMuted}>
                {`${statusMarker(item.status)} ${item.title}`}
              </text>
            )}
          </For>
        )}
      </box>
      <box border borderColor={props.theme.border} backgroundColor={props.theme.panel} paddingX={1} paddingY={1} flexGrow={1}>
        <text fg={props.theme.reasoning}>current observation</text>
        <text fg={props.theme.textMuted} wrapMode="word">
          {observation()}
        </text>
      </box>
    </box>
  )
}

function statusMarker(status: "pending" | "active" | "completed"): string {
  if (status === "completed") return "[x]"
  if (status === "active") return "[>]"
  return "[ ]"
}
