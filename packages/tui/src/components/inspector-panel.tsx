import type { TuiState } from "../state/types"

export interface InspectorPanelProps {
  state: TuiState
}

export function InspectorPanel(props: InspectorPanelProps) {
  const payload = () => (props.state.selectedEvent ? JSON.stringify(props.state.selectedEvent.payload, null, 2) : " ")

  return (
    <box border title="Inspector" flexGrow={1} paddingX={1}>
      <text>{payload()}</text>
    </box>
  )
}
