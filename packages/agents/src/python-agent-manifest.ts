import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { parse } from "yaml"
import { PythonAgentAdapter } from "./python-agent-adapter"

export interface LoadPythonAgentManifestOptions {
  pythonCommand?: string
}

const PythonAgentManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  language: z.string().refine((value) => value === "python", "language must be python"),
  entry: z.string().min(1).default("main.py"),
  command: z.array(z.string().min(1)).min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
})

export async function loadPythonAgentManifests(
  agentsDir: string,
  options: LoadPythonAgentManifestOptions = {},
): Promise<PythonAgentAdapter[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = await readdir(agentsDir, { withFileTypes: true })
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return []
    throw error
  }

  const agents: PythonAgentAdapter[] = []
  for (const entryName of entries
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort((a, b) => a.localeCompare(b))) {
    const manifestPath = join(agentsDir, entryName, "agent.yaml")
    const agent = await loadPythonAgentManifest(manifestPath, options)
    if (agent) agents.push(agent)
  }

  return agents
}

export async function loadPythonAgentManifest(
  manifestPath: string,
  options: LoadPythonAgentManifestOptions = {},
): Promise<PythonAgentAdapter | null> {
  let raw: string
  try {
    raw = await readFile(manifestPath, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null
    throw error
  }

  const parsed = parse(raw)
  const manifest = PythonAgentManifestSchema.parse(parsed)
  const agentDir = dirname(manifestPath)

  return new PythonAgentAdapter({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    command: manifest.command ?? [options.pythonCommand ?? "python3", manifest.entry],
    cwd: agentDir,
    env: manifest.env,
    timeoutMs: manifest.timeoutMs,
  })
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
