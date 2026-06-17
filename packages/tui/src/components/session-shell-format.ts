import type { RunLogItem } from "../log/run-log"
import type { TuiState } from "../state/types"
import type { ThemeAccent } from "../theme/themes"

export type TranscriptBlock = "user" | "assistant" | "tool" | "status" | "system"

export interface TranscriptViewItem {
  id: string
  sequence: number
  block: TranscriptBlock
  prefix: string
  text: string
  accent: ThemeAccent
}

export function sessionTitle(state: TuiState): string {
  const latestTask = [...state.runLog]
    .reverse()
    .find((item) => item.kind === "user.task" && item.message.trim().length > 0)

  if (latestTask) return latestTask.message.trim()

  const projectName = state.projectPath.split(/[\\/]/).filter(Boolean).at(-1)
  return projectName ? `${projectName} workflow` : "open-web-agent workflow"
}

export function sessionMeta(state: TuiState): string {
  return `${state.runStatus} · ${state.selectedAgentId} · ${state.selectedEnvironmentId}`
}

export function toTranscriptViewItem(item: RunLogItem): TranscriptViewItem {
  if (item.kind === "user.task") return viewItem(item, "user", "", item.message)
  if (item.kind === "agent.answer") return viewItem(item, "assistant", "", item.message)
  if (item.kind === "system") return viewItem(item, "system", "~", item.message)
  if (item.kind === "run.failed") return viewItem(item, "status", "~", `failed ${item.message}`.trim())
  if (item.kind === "run.cancelled") return viewItem(item, "status", "~", `cancelled ${item.message}`.trim())
  if (item.kind.startsWith("tool.")) return viewItem(item, "tool", "*", item.message)
  if (item.kind === "reasoning") return viewItem(item, "tool", "*", item.message)

  return viewItem(item, "assistant", "", item.message)
}

export function promptMeta(agentId: string, modelId: string | null): string {
  return `Build ${agentId} ${modelId ?? "no-model"} open-web-agent`
}

export function promptHint(runStatus: TuiState["runStatus"]): string {
  const escapeAction = runStatus === "running" ? "interrupt" : "exit"
  return `esc ${escapeAction}`
}

function viewItem(item: RunLogItem, block: TranscriptBlock, prefix: string, text: string): TranscriptViewItem {
  return {
    id: item.id,
    sequence: item.sequence,
    block,
    prefix,
    text,
    accent: item.accent,
  }
}
