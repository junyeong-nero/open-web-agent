/** @jsxImportSource @opentui/solid */
import { For } from "solid-js"
import type { MouseEvent, ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import type { TuiState } from "../state/types"
import { themeColor, type TuiTheme } from "../theme/themes"
import { toTranscriptViewItem, type TranscriptViewItem } from "./session-shell-format"

export interface TranscriptPanelProps {
  state: TuiState
  theme: TuiTheme
  scrollRef?: (node: ScrollBoxRenderable) => void
  focused?: boolean
  onFocusRequest?: () => void
}

export function TranscriptPanel(props: TranscriptPanelProps) {
  const items = () => props.state.runLog.map(toTranscriptViewItem)

  return (
    <scrollbox
      id="transcript-scroll"
      ref={props.scrollRef}
      flexGrow={1}
      paddingX={1}
      paddingY={1}
      backgroundColor={props.theme.surface}
      contentOptions={{ rowGap: 1 }}
      focusable
      focused={props.focused}
      stickyScroll={true}
      stickyStart="bottom"
      scrollY={true}
      scrollX={false}
      onMouseDown={props.onFocusRequest}
      onMouseScroll={props.onFocusRequest}
    >
      {items().length === 0 ? (
        <text fg={props.theme.textMuted}>Waiting for a task. Type in the prompt below.</text>
      ) : (
        <For each={items()}>{(item) => renderTranscriptItem(item, props.theme, props.onFocusRequest)}</For>
      )}
    </scrollbox>
  )
}

function renderTranscriptItem(
  item: TranscriptViewItem,
  theme: TuiTheme,
  onFocusRequest?: () => void,
) {
  if (item.block === "user") {
    return renderChatBubble(item, theme, theme.task)
  }

  if (item.block === "assistant") {
    return renderChatBubble(item, theme, theme.answer)
  }

  if (item.block === "tool" && item.toolCall) {
    return <ToolCallTranscriptItem item={item} theme={theme} onFocusRequest={onFocusRequest} />
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

function renderChatBubble(item: TranscriptViewItem, theme: TuiTheme, borderColor: string) {
  return (
    <box id={`transcript-${item.block}-${item.id}`} border={["left"]} borderColor={borderColor} backgroundColor={theme.panelAlt} paddingX={2} paddingY={1}>
      <text fg={theme.text} wrapMode="word">
        {item.text}
      </text>
    </box>
  )
}

interface ToolCallTranscriptItemProps {
  item: TranscriptViewItem
  theme: TuiTheme
  onFocusRequest?: () => void
}

function ToolCallTranscriptItem(props: ToolCallTranscriptItemProps) {
  let toggleText: TextRenderable | undefined
  let argsText: TextRenderable | undefined
  let expanded = false

  const applyExpanded = (next: boolean) => {
    expanded = next
    if (toggleText) toggleText.content = expanded ? "-" : "+"
    if (argsText) argsText.visible = expanded
  }

  const handleToggle = (event: MouseEvent) => {
    if (event.type !== "down" || event.button !== 0) return
    props.onFocusRequest?.()
    applyExpanded(!expanded)
    event.stopPropagation()
  }

  return (
    <box
      id={`transcript-tool-${props.item.id}`}
      border={["left"]}
      borderColor={props.theme.tool}
      backgroundColor={props.theme.panel}
      paddingX={2}
      paddingY={0}
      flexDirection="column"
      rowGap={1}
      onMouseDown={handleToggle}
    >
      <box id={`transcript-tool-header-${props.item.id}`} flexDirection="row" gap={1} onMouseDown={handleToggle}>
        <text
          ref={(node) => {
            toggleText = node
            node.content = expanded ? "-" : "+"
          }}
          fg={props.theme.tool}
          wrapMode="none"
          content="+"
          onMouseDown={handleToggle}
        />
        <text fg={props.theme.text} wrapMode="none" content={props.item.toolCall?.action ?? props.item.text} onMouseDown={handleToggle} />
        <text
          fg={props.theme.textMuted}
          wrapMode="word"
          content={props.item.text === props.item.toolCall?.action ? "" : props.item.text}
          onMouseDown={handleToggle}
        />
      </box>
      <text
        id={`transcript-tool-args-${props.item.id}`}
        ref={(node) => {
          argsText = node
          node.visible = expanded
        }}
        visible={false}
        fg={props.theme.textMuted}
        wrapMode="word"
        content={props.item.toolCall?.argsJson ?? ""}
      />
    </box>
  )
}
