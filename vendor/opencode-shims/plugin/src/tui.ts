export interface TuiPluginStatus {
  id: string
  enabled: boolean
  error?: string
}

export interface TuiPluginInstallOptions {
  enabled?: boolean
}

export type TuiPluginInstallResult = { ok: true } | { ok: false; message: string }

export type TuiAttentionSoundName = "default" | "question" | "permission" | "error" | "done" | "subagent_done"

export interface TuiDialogSelectOption {
  id: string
  label: string
  description?: string
}

export interface TuiRouteCurrent {
  type: string
}

export interface TuiSlotProps {
  children?: unknown
}

export interface TuiSlotContext {
  route?: TuiRouteCurrent
}

export type TuiSlotMap = Record<string, unknown>
export type TuiRouteDefinition = Record<string, unknown>
export type TuiCommand = Record<string, unknown>
export type TuiPluginApi = Record<string, unknown>
export type TuiPlugin = Record<string, unknown>
export type TuiPluginModule = Record<string, unknown>
