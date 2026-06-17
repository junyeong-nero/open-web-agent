import { For } from "solid-js"
import type { TuiState } from "../state/types"
import { themeColor, type TuiTheme } from "../theme/themes"

export interface ConversationPanelProps {
  state: TuiState
  theme: TuiTheme
}

export function ConversationPanel(props: ConversationPanelProps) {
  return (
    <box
      border
      title="linear run log"
      flexGrow={1}
      paddingX={1}
      paddingY={1}
      backgroundColor={props.theme.surface}
      borderColor={props.theme.border}
      titleColor={props.theme.textMuted}
    >
      {props.state.runLog.length === 0 ? (
        <text fg={props.theme.textMuted}>Waiting for a task. Type in the chat box below.</text>
      ) : (
        <For each={props.state.runLog}>
          {(item) => (
            <text fg={themeColor(props.theme, item.accent)} wrapMode="word">
              {`${String(item.sequence).padStart(2, "0")} ${item.kind.padEnd(12)} ${item.message}`}
            </text>
          )}
        </For>
      )}
    </box>
  )
}
