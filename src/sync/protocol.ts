// Wire types for the First Twenty server API (/api, JSON). docs/SYNC.md is the contract; keep the two in
// step. Pure types and constants only (no DOM, no store), so the server can import this file too.
import type { DB } from '@/domain/types'

export type ChangeOp = 'upsert' | 'delete'

/** One row of the server's change log, returned by GET /api/changes. */
export type Change = { seq: number; collection: string; id: string; op: ChangeOp; version: number; data?: unknown }

/** One change sent by POST /api/changes. baseVersion is the version the client last saw (null = new). */
export type ClientChange = { collection: string; id: string; op: ChangeOp; data?: unknown; baseVersion: number | null }

export type Applied = { collection: string; id: string; version: number }

/** The server kept its copy. serverData null means the record does not exist on the server. */
export type Conflict = { collection: string; id: string; serverVersion: number | null; serverData: unknown }

export type SyncUser = { id: string; email: string; role: string }

export type HealthResponse = { ok: true; db: 'up'; version: string }

export type WorkspaceSnapshot = {
  workspaceId: string
  /** Names the server's current history (absent from servers before history ids). */
  historyId?: string
  seq: number
  db: DB
  /** "collection:id" -> version. Documents use "$doc:<key>". */
  versions: Record<string, number>
}

export type PutWorkspaceResponse = { historyId?: string; seq: number; versions: Record<string, number> }

export type ChangesResponse = { resync: true } | { resync?: false; historyId?: string; seq: number; changes: Change[]; more?: boolean }

export type PostChangesResponse = { historyId?: string; seq: number; applied: Applied[]; conflicts: Conflict[] }

/** Most changes one POST /api/changes may carry. */
export const MAX_PUSH_CHANGES = 2000

/** Largest record the server accepts (bytes of JSON). */
export const MAX_RECORD_BYTES = 256 * 1024

/** "collection:id", the key of the versions map and of the outbox. */
export function recordKey(collection: string, id: string): string {
  return `${collection}:${id}`
}
