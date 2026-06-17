import type { TuiState } from "../state/types"

export interface ConversationPanelProps {
  state: TuiState
}

export function ConversationPanel(props: ConversationPanelProps) {
  const messages = () =>
    props.state.conversation.length === 0
      ? " "
      : props.state.conversation.map((message) => `${message.role}: ${message.content}`).join("\n")

  return (
    <box border title="Conversation" flexGrow={2} paddingX={1}>
      <text>{messages()}</text>
    </box>
  )
}
