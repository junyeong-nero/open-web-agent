import type { TuiState } from "../state/types"

export interface BrowserStatePanelProps {
  state: TuiState
}

export function BrowserStatePanel(props: BrowserStatePanelProps) {
  const browser = () => props.state.browser
  const content = () =>
    [
      `URL: ${browser().url}`,
      `Title: ${browser().title ?? ""}`,
      `Screenshot: ${browser().screenshotPath ?? ""}`,
      `Elements: ${browser().interactiveElements.length}`,
      browser().text ?? "",
    ].join("\n")

  return (
    <box border title="Browser" flexGrow={1} paddingX={1}>
      <text>{content()}</text>
    </box>
  )
}
