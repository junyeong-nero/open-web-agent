import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export function resolveOwaHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OWA_HOME && env.OWA_HOME.length > 0 ? env.OWA_HOME : join(homedir(), ".open-web-agent")
}

export function hashProjectPath(projectPath: string): string {
  return createHash("sha256").update(resolve(projectPath)).digest("hex")
}

export function sessionPath(home: string, projectHash: string, sessionId: string): string {
  return join(home, "projects", projectHash, "sessions", sessionId)
}

export function runPath(home: string, projectHash: string, sessionId: string, runId: string): string {
  return join(sessionPath(home, projectHash, sessionId), "runs", runId)
}

export function eventsPath(home: string, projectHash: string, sessionId: string, runId: string): string {
  return join(runPath(home, projectHash, sessionId, runId), "events.jsonl")
}
