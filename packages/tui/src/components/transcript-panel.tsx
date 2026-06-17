import { For } from "solid-js"
import type { TuiState } from "../state/types"
import { themeColor, type TuiTheme } from "../theme/themes"
import { toTranscriptViewItem, type TranscriptViewItem } from "./session-shell-format"

export interface TranscriptPanelProps {
  state: TuiState
  theme: TuiTheme
}

export function TranscriptPanel(props: TranscriptPanelProps) {
  const items = () => props.state.runLog.map(toTranscriptViewItem)

  return (
    <box flexGrow={1} paddingX={2} paddingY={1} backgroundColor={props.theme.surface} rowGap={1}>
      {items().length === 0 ? (
        <text fg={props.theme.textMuted}>Waiting for a task. Type in the prompt below.</text>
      ) : (
        <For each={items()}>{(item) => renderTranscriptItem(item, props.theme)}</For>
      )}
    </box>
  )
}

function renderTranscriptItem(item: TranscriptViewItem, theme: TuiTheme) {
  if (item.block === "user") {
    return (
      <box border={["left"]} borderColor={theme.task} backgroundColor={theme.panel} paddingX={1} paddingY={1}>
        <text fg={theme.text} wrapMode="word">
          {item.text}
        </text>
      </box>
    )
  }

  if (item.block === "tool" || item.block === "system" || item.block === "status") {
    return (
      <text fg={item.block === "status" ? themeColor(theme, item.accent) : theme.textMuted} wrapMode="word">
        {`${item.prefix} ${item.text}`.trim()}
      </text>
    )
  }

  return (
    <text fg={themeColor(theme, item.accent)} wrapMode="word">
      {item.text}
    </text>
  )
}
