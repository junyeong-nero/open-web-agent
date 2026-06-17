import type { RunLogItem } from "../log/run-log"
import type { ModelActivity, ModelSummary, TuiState } from "../state/types"
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

export function selectedModelSummary(state: TuiState): ModelSummary | null {
  if (!state.selectedModelId) return null
  return state.availableModels.find((model) => model.id === state.selectedModelId) ?? null
}

export function promptMeta(model: ModelSummary | null): string {
  if (!model) return "Build · no model · medium"

  const modelName = model.modelName ?? model.name
  const provider = model.name || model.provider
  const reasoningEffort = model.reasoningEffort ?? "medium"
  return `Build · ${modelName} ${provider} · ${reasoningEffort}`
}

export function promptHint(runStatus: TuiState["runStatus"], contextUsage: string): string {
  const escapeAction = runStatus === "running" ? "interrupt" : "exit"
  return `${contextUsage}  esc ${escapeAction}`
}

export function formatContextUsage(activity: Pick<ModelActivity, "usage" | "contextWindowTokens">): string {
  const contextTokens =
    activity.usage?.inputTokens ??
    activity.usage?.totalTokens ??
    sumNullable(activity.usage?.inputTokens, activity.usage?.outputTokens) ??
    0
  const percentage = activity.contextWindowTokens ? Math.round((contextTokens / activity.contextWindowTokens) * 100) : 0
  return `${formatTokenCount(contextTokens)} (${percentage}%)`
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

function formatTokenCount(value: number): string {
  if (value < 1000) return String(value)
  if (value < 10000) return `${(value / 1000).toFixed(1)}K`
  return `${Math.round(value / 1000)}K`
}

function sumNullable(left: number | null | undefined, right: number | null | undefined): number | null {
  if (left == null && right == null) return null
  return (left ?? 0) + (right ?? 0)
}
