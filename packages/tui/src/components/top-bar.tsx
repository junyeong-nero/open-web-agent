import type { TuiState } from "../state/types"

export interface TopBarProps {
  state: TuiState
}

export function TopBar(props: TopBarProps) {
  return (
    <box border height={3} paddingX={1}>
      <text>{`${props.state.projectPath} | mock-agent | mock-browser | ${props.state.runStatus}`}</text>
    </box>
  )
}
