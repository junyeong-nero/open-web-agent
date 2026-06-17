import type { TuiState } from "../state/types"

export interface InspectorPanelProps {
  state: TuiState
}

export function InspectorPanel(props: InspectorPanelProps) {
  const payload = () => (props.state.selectedEvent ? JSON.stringify(props.state.selectedEvent.payload, null, 2) : " ")
  const plan = () => {
    if (props.state.plan.length === 0) return ""

    return [
      "Plan",
      ...props.state.plan.map((item) => `${statusMarker(item.status)} ${item.title}`),
      "",
    ].join("\n")
  }

  return (
    <box border title="Inspector" flexGrow={1} paddingX={1}>
      <text>{`${plan()}${payload()}`}</text>
    </box>
  )
}

function statusMarker(status: "pending" | "active" | "completed"): string {
  if (status === "completed") return "[x]"
  if (status === "active") return "[>]"
  return "[ ]"
}
