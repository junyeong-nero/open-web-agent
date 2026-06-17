import { Database } from "bun:sqlite"

export interface StoredSession {
  id: string
  projectPath: string
  projectHash: string
  createdAt: string
}

export interface StoredRun {
  id: string
  sessionId: string
  status: "running" | "completed" | "failed" | "cancelled"
  finalAnswer: string | null
  createdAt: string
  updatedAt: string
}

export interface StoredMessage {
  id: string
  sessionId: string
  role: "user" | "assistant" | "system"
  content: string
  createdAt: string
}

export class SQLiteStore {
  private readonly db: Database

  constructor(readonly filePath: string) {
    this.db = new Database(filePath, { create: true })
  }

  migrate(): void {
    this.db.exec(`
      create table if not exists sessions (
        id text primary key,
        project_path text not null,
        project_hash text not null,
        created_at text not null
      );

      create table if not exists runs (
        id text primary key,
        session_id text not null references sessions(id),
        status text not null,
        final_answer text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists messages (
        id text primary key,
        session_id text not null references sessions(id),
        role text not null,
        content text not null,
        created_at text not null
      );
    `)
  }

  upsertSession(session: StoredSession): void {
    this.db
      .query(
        `insert into sessions (id, project_path, project_hash, created_at)
         values (?, ?, ?, ?)
         on conflict(id) do update set
           project_path = excluded.project_path,
           project_hash = excluded.project_hash`,
      )
      .run(session.id, session.projectPath, session.projectHash, session.createdAt)
  }

  getSession(id: string): StoredSession | null {
    const row = this.db.query(`select * from sessions where id = ?`).get(id) as SessionRow | null
    return row ? toSession(row) : null
  }

  listSessions(): StoredSession[] {
    return (this.db.query(`select * from sessions order by created_at asc`).all() as SessionRow[]).map(toSession)
  }

  upsertRun(run: StoredRun): void {
    this.db
      .query(
        `insert into runs (id, session_id, status, final_answer, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(id) do update set
           status = excluded.status,
           final_answer = excluded.final_answer,
           updated_at = excluded.updated_at`,
      )
      .run(run.id, run.sessionId, run.status, run.finalAnswer, run.createdAt, run.updatedAt)
  }

  listRuns(sessionId: string): StoredRun[] {
    return (this.db.query(`select * from runs where session_id = ? order by created_at asc`).all(sessionId) as RunRow[]).map(toRun)
  }

  appendMessage(message: StoredMessage): void {
    this.db
      .query(
        `insert into messages (id, session_id, role, content, created_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run(message.id, message.sessionId, message.role, message.content, message.createdAt)
  }

  listMessages(sessionId: string): StoredMessage[] {
    return (this.db.query(`select * from messages where session_id = ? order by created_at asc`).all(sessionId) as MessageRow[]).map(toMessage)
  }

  exportSessionMarkdown(sessionId: string): string {
    const session = this.getSession(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)

    const messages = this.listMessages(sessionId)
    return [
      `# Open Web Agent Session ${session.id}`,
      "",
      `Project: ${session.projectPath}`,
      `Created: ${session.createdAt}`,
      "",
      ...messages.flatMap((message) => [`## ${message.role}`, "", message.content, ""]),
    ].join("\n")
  }

  close(): void {
    this.db.close()
  }
}

interface SessionRow {
  id: string
  project_path: string
  project_hash: string
  created_at: string
}

interface RunRow {
  id: string
  session_id: string
  status: StoredRun["status"]
  final_answer: string | null
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  session_id: string
  role: StoredMessage["role"]
  content: string
  created_at: string
}

function toSession(row: SessionRow): StoredSession {
  return {
    id: row.id,
    projectPath: row.project_path,
    projectHash: row.project_hash,
    createdAt: row.created_at,
  }
}

function toRun(row: RunRow): StoredRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    finalAnswer: row.final_answer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }
}
