// Wire types for the First Twenty server API (/api, JSON). docs/SYNC.md is the contract; keep the two in
// step. Pure types and constants only (no DOM, no store), so the server can import this file too.
import type { DB } from '@/domain/types'

export type ChangeOp = 'upsert' | 'delete'

/** One row of the server's change log, returned by GET /api/changes. */
export type Change = { seq: number; collection: string; id: string; op: ChangeOp; version: number; data?: unknown }

/** One change sent by POST /api/changes. baseVersion is the version the client last saw (null = new). */
export type ClientChange = { collection: string; id: string; op: ChangeOp; data?: unknown; baseVersion: number | null }

/**
 * existing: the server already held exactly this data and wrote nothing (a retried push: the earlier
 * attempt landed). Absent from servers before the flag.
 */
export type Applied = { collection: string; id: string; version: number; existing?: true }

/**
 * The server kept its copy. serverData null means the record does not exist on the server. Both flags are
 * absent from servers before them:
 * - byYou: the signed-in user wrote that copy (or the delete that removed it), from this device or another;
 * - landed: an upsert whose exact data the server already took after baseVersion (its change log holds
 *   it): an earlier attempt of this change landed, and the copy above is newer than it.
 */
export type Conflict = { collection: string; id: string; serverVersion: number | null; serverData: unknown; byYou?: true; landed?: true }

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

/**
 * GET /api/workspace/status: whether the server holds a workspace, without its data. An empty server is
 * an answer here ({empty: true}), where GET /api/workspace answers 404 (which browsers log as an error).
 */
export type WorkspaceStatus = { empty: true } | { empty: false; workspaceId: string; historyId?: string; seq: number }

export type PutWorkspaceResponse = { historyId?: string; seq: number; versions: Record<string, number> }

export type ChangesResponse = { resync: true } | { resync?: false; historyId?: string; seq: number; changes: Change[]; more?: boolean }

export type PostChangesResponse = { historyId?: string; seq: number; applied: Applied[]; conflicts: Conflict[] }

/** Most changes one POST /api/changes may carry. */
export const MAX_PUSH_CHANGES = 2000

/** Largest record the server accepts (bytes of JSON). */
export const MAX_RECORD_BYTES = 256 * 1024

/**
 * The name of the <meta> tag the server adds to the app page it serves. The app registers the server's
 * offline worker (SERVICE_WORKER_URL) only when it is there: never from a file, the artifact viewer or the
 * Vite dev server.
 */
export const SERVED_MARKER = 'first-twenty-served'

/** Where the server serves its offline worker (server/src/offline.ts). */
export const SERVICE_WORKER_URL = '/sw.js'

/** "collection:id", the key of the versions map and of the outbox. */
export function recordKey(collection: string, id: string): string {
  return `${collection}:${id}`
}
