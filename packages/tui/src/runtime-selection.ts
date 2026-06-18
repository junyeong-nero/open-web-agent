import { reduceTuiEvent } from "./state/reducer"
import type { TuiState } from "./state/types"

export type RuntimeSelectionSuccess =
  | { kind: "model"; modelId: string; reasoningEffort?: string }
  | { kind: "agent"; agentId: string }
  | { kind: "browser"; environmentId: string }

export function reduceRuntimeSelectionSuccess(state: TuiState, selection: RuntimeSelectionSuccess): TuiState {
  if (selection.kind === "model") {
    return reduceTuiEvent(state, {
      type: "model.selected",
      modelId: selection.modelId,
      reasoningEffort: selection.reasoningEffort,
    })
  }

  if (selection.kind === "agent") {
    return reduceTuiEvent(state, { type: "agent.selected", agentId: selection.agentId })
  }

  return reduceTuiEvent(state, { type: "environment.selected", environmentId: selection.environmentId })
}
