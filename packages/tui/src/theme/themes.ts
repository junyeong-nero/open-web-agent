export type ThemeAccent = "task" | "reasoning" | "tool" | "answer" | "success" | "warning" | "danger"

export interface TuiTheme {
  id: string
  name: string
  surface: string
  surfaceAlt: string
  panel: string
  panelAlt: string
  border: string
  borderStrong: string
  text: string
  textMuted: string
  accent: string
  task: string
  reasoning: string
  tool: string
  answer: string
  success: string
  warning: string
  danger: string
}

export const BUILT_IN_THEMES: TuiTheme[] = [
  {
    id: "opencode",
    name: "OpenCode",
    surface: "#0a0a0a",
    surfaceAlt: "#141414",
    panel: "#141414",
    panelAlt: "#1e1e1e",
    border: "#484848",
    borderStrong: "#606060",
    text: "#eeeeee",
    textMuted: "#808080",
    accent: "#fab283",
    task: "#5c9cf5",
    reasoning: "#9d7cd8",
    tool: "#56b6c2",
    answer: "#fab283",
    success: "#7fd88f",
    warning: "#f5a742",
    danger: "#e06c75",
  },
  {
    id: "terminal-cyan",
    name: "Terminal Cyan",
    surface: "#070a10",
    surfaceAlt: "#0d1119",
    panel: "#0a0e15",
    panelAlt: "#101620",
    border: "#27303d",
    borderStrong: "#384252",
    text: "#e8edf5",
    textMuted: "#7d8794",
    accent: "#18d5ff",
    task: "#18d5ff",
    reasoning: "#a78bfa",
    tool: "#7ee787",
    answer: "#8ab4ff",
    success: "#7ee787",
    warning: "#f5b84b",
    danger: "#ff7b72",
  },
  {
    id: "aurora-violet",
    name: "Aurora Violet",
    surface: "#090811",
    surfaceAlt: "#11101a",
    panel: "#0d0b16",
    panelAlt: "#171321",
    border: "#322d42",
    borderStrong: "#4c4264",
    text: "#eee9ff",
    textMuted: "#948ca8",
    accent: "#c084fc",
    task: "#c084fc",
    reasoning: "#22d3ee",
    tool: "#a7f3d0",
    answer: "#f0abfc",
    success: "#86efac",
    warning: "#fde68a",
    danger: "#fb7185",
  },
  {
    id: "amber-ops",
    name: "Amber Ops",
    surface: "#0d0a06",
    surfaceAlt: "#17110a",
    panel: "#120e08",
    panelAlt: "#1d160c",
    border: "#3b2f1f",
    borderStrong: "#5c472b",
    text: "#f5efe6",
    textMuted: "#9b8d7a",
    accent: "#f5b84b",
    task: "#f5b84b",
    reasoning: "#fb7185",
    tool: "#60a5fa",
    answer: "#facc15",
    success: "#86efac",
    warning: "#f5b84b",
    danger: "#f87171",
  },
  {
    id: "matrix-green",
    name: "Matrix Green",
    surface: "#06100c",
    surfaceAlt: "#0b1711",
    panel: "#08140f",
    panelAlt: "#102018",
    border: "#20362b",
    borderStrong: "#2f5140",
    text: "#e3f8ed",
    textMuted: "#7ea48d",
    accent: "#34d399",
    task: "#34d399",
    reasoning: "#a3e635",
    tool: "#67e8f9",
    answer: "#86efac",
    success: "#34d399",
    warning: "#fbbf24",
    danger: "#f87171",
  },
]

export function listThemes(): TuiTheme[] {
  return BUILT_IN_THEMES
}

export function getTheme(themeId: string | null | undefined): TuiTheme {
  return BUILT_IN_THEMES.find((theme) => theme.id === themeId) ?? BUILT_IN_THEMES[0]!
}

export function themeColor(theme: TuiTheme, accent: ThemeAccent): string {
  return theme[accent]
}
