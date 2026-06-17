import type { TuiState } from "../state/types"
import type { TuiTheme } from "../theme/themes"

export interface TopBarProps {
  state: TuiState
  theme: TuiTheme
}

export function TopBar(props: TopBarProps) {
  return (
    <box
      border
      height={3}
      paddingX={1}
      backgroundColor={props.theme.surfaceAlt}
      borderColor={props.theme.border}
      titleColor={props.theme.textMuted}
    >
      <text fg={props.theme.text}>
        {`[owa] open-web-agent  ${props.state.projectPath}  ${props.state.selectedAgentId} | ${props.state.selectedModelId ?? "no-model"} | ${props.state.selectedEnvironmentId} | ${props.state.selectedThemeId} | ${props.state.runStatus}`}
      </text>
    </box>
  )
}
