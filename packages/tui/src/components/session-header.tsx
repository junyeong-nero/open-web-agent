/** @jsxImportSource @opentui/solid */
import { sessionMeta, sessionTitle } from "./session-shell-format"
import type { TuiState } from "../state/types"
import type { TuiTheme } from "../theme/themes"

export interface SessionHeaderProps {
  state: TuiState
  theme: TuiTheme
}

export function SessionHeader(props: SessionHeaderProps) {
  return (
    <box
      height={3}
      paddingX={2}
      paddingY={1}
      backgroundColor={props.theme.panel}
      flexDirection="row"
      justifyContent="space-between"
      flexShrink={0}
    >
      <text fg={props.theme.text} wrapMode="none">
        {`# ${sessionTitle(props.state)}`}
      </text>
      <text fg={props.theme.textMuted} wrapMode="none">
        {sessionMeta(props.state)}
      </text>
    </box>
  )
}
