import type { TuiState } from "../state/types"

export interface TimelinePanelProps {
  state: TuiState
}

export function TimelinePanel(props: TimelinePanelProps) {
  const timeline = () =>
    props.state.timeline.length === 0
      ? " "
      : props.state.timeline.map((item) => `${item.sequence} ${item.type} ${item.label}`).join("\n")

  return (
    <box border title="Timeline" flexGrow={1} paddingX={1}>
      <text>{timeline()}</text>
    </box>
  )
}
