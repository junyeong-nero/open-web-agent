/** @jsxImportSource @opentui/solid */
import { For, createMemo } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { SessionSummary } from "../state/types"
import type { TuiTheme } from "../theme/themes"

export type SessionPaletteMode = "search" | "rename"

export interface SessionPaletteProps {
  sessions: SessionSummary[]
  activeSessionId: string | null
  selectedIndex: number
  query: string
  mode: SessionPaletteMode
  renameValue: string
  loadingPhase: number
  theme: TuiTheme
  scrollRef?: (node: ScrollBoxRenderable) => void
}

const maxVisibleSessionRows = 10

export interface SessionPaletteScrollTarget {
  scrollTop: number
  viewport: { height: number }
  scrollTo(top: number): void
}

export function scrollSessionIndexIntoView(scroll: SessionPaletteScrollTarget | undefined, index: number, count: number) {
  if (!scroll) return
  if (count === 0) {
    scroll.scrollTo(0)
    return
  }

  const rowIndex = clamp(index, 0, count - 1)
  const viewportHeight = Math.max(1, scroll.viewport.height)
  const scrollTop = scroll.scrollTop
  if (rowIndex < scrollTop) {
    scroll.scrollTo(rowIndex)
    return
  }
  if (rowIndex >= scrollTop + viewportHeight) {
    scroll.scrollTo(rowIndex - viewportHeight + 1)
  }
}

export function SessionPalette(props: SessionPaletteProps) {
  const visibleSessions = createMemo(() => filterSessions(props.sessions, props.query))
  const inputLabel = () => (props.mode === "rename" ? props.renameValue : props.query)
  const sessionListHeight = () => Math.max(1, Math.min(visibleSessions().length || 1, maxVisibleSessionRows))

  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={props.theme.panel} paddingX={2} paddingY={1} rowGap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={props.theme.text} wrapMode="none">
          Sessions
        </text>
        <text fg={props.theme.textMuted} wrapMode="none">
          esc
        </text>
      </box>
      <text fg={props.mode === "rename" ? props.theme.warning : props.theme.textMuted} wrapMode="none">
        {props.mode === "rename" ? `Rename ${inputLabel()}` : `Search ${inputLabel()}`}
      </text>
      <scrollbox
        id="session-palette-list"
        ref={(node) => {
          props.scrollRef?.(node as ScrollBoxRenderable)
        }}
        height={sessionListHeight()}
        backgroundColor={props.theme.panel}
        scrollY={true}
        scrollX={false}
        viewportCulling={true}
        contentOptions={{ flexDirection: "column" }}
      >
        <For each={visibleSessions()}>
          {(session, index) => {
            const selected = () => index() === props.selectedIndex
            const active = () => session.id === props.activeSessionId
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingX={selected() ? 1 : 0}
                backgroundColor={selected() ? props.theme.task : props.theme.panel}
              >
                <text
                  fg={selected() ? props.theme.surface : session.runStatus === "running" ? props.theme.reasoning : props.theme.textMuted}
                  wrapMode="none"
                >
                  {sessionLeftMark(session, props.loadingPhase)}
                </text>
                <text fg={selected() ? props.theme.surface : active() ? props.theme.task : props.theme.text} wrapMode="none">
                  {sessionDisplayName(session)}
                </text>
                <text fg={selected() ? props.theme.surface : props.theme.textMuted} wrapMode="none">
                  {sessionMeta(session, active())}
                </text>
              </box>
            )
          }}
        </For>
        <text visible={visibleSessions().length === 0} fg={props.theme.textMuted} wrapMode="none">
          No matching sessions
        </text>
      </scrollbox>
      <text fg={props.theme.textMuted} wrapMode="none">
        pin/unpin ctrl+f  delete ctrl+d  rename ctrl+n  enter open
      </text>
    </box>
  )
}

export function filterSessions(sessions: SessionSummary[], query: string): SessionSummary[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return sessions
  return sessions.filter((session) => sessionSearchText(session).includes(normalized))
}

export function sessionDisplayName(session: SessionSummary): string {
  const title = session.title?.trim()
  if (title) return title
  const projectName = session.projectPath.split(/[\\/]/).filter(Boolean).at(-1)
  return projectName ? `${projectName} ${session.id.slice(0, 8)}` : session.id
}

function sessionLeftMark(session: SessionSummary, phase: number): string {
  if (session.runStatus === "running") return ["|", "/", "-", "\\"][phase % 4] ?? "|"
  if (session.pinned) return "^"
  return " "
}

function sessionMeta(session: SessionSummary, active: boolean): string {
  const parts = []
  if (active) parts.push("active")
  if (session.pinned) parts.push("pin")
  if (session.runStatus !== "idle") parts.push(session.runStatus)
  return parts.join(" ")
}

function sessionSearchText(session: SessionSummary): string {
  return [session.id, session.title, session.projectPath, session.runStatus].filter(Boolean).join(" ").toLowerCase()
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}
