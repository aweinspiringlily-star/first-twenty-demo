// Reads and writes the workspace (docs/SYNC.md, Data layout and Protocol).
//
// Invariants:
// - Every write transaction first locks the workspace row (SELECT ... FOR UPDATE). Writers are
//   serialized, so change_log seq values become visible in order and a pull never skips a seq.
// - workspaces.last_seq is the highest seq written; reset_seq marks the last full replace (or restore)
//   and pruned_seq the last pruned row. A pull whose `since` is older than either must resync.
// - A record's version is the change_log seq of the write that produced it. Versions therefore never
//   repeat within a workspace and only grow per record, across delete and re-create, a full replace and
//   a restore (afterRestore moves the sequence far ahead), so a stale baseVersion can only match the
//   write it was based on, and echo detection by version works.
// - workspaces.history_id names the current history; it changes on every full replace and restore.
//   A client that sends an older one is told to resync (pulls) or refused with 409 'resync' (pushes).
// - The change log forgets what was deleted: a delete removes the record's earlier log rows (keeping
//   the delete row), and a full replace removes every earlier row.
// - Each record keeps `pos` (its array index on upload; new records append), so the snapshot returns
//   arrays in the order the app keeps them.
import { DOC_COLLECTION, DOC_KEYS, RECORD_COLLECTIONS, tableName } from '../../src/sync/collections'
import type { Db, Queryable } from './db'
import { HttpError } from './errors'
import { WORKSPACE_ID } from './sqlgen'
import { LIMITS, type ValidChange, type ValidWorkspace } from './validate'

export type Change = { seq: number; collection: string; id: string; op: 'upsert' | 'delete'; version: number; data?: unknown }
/** existing: the server already held exactly this data, so nothing was written (a retried push). */
export type Applied = { collection: string; id: string; version: number; existing?: true }
/**
 * byYou: the server's copy (or, when it has none, the delete that removed it) was written by the user who
 * pushed. landed: the change log holds this exact upsert after baseVersion (an earlier attempt landed).
 */
export type Conflict = { collection: string; id: string; serverVersion: number | null; serverData: unknown | null; byYou?: true; landed?: true }

export type Snapshot = { workspaceId: string; historyId: string; seq: number; db: Record<string, unknown>; versions: Record<string, number> }
/** Whether the server holds a workspace, without its data (GET /api/workspace/status). */
export type WorkspaceStatus = { empty: true } | { empty: false; workspaceId: string; historyId: string; seq: number }
export type ReplaceResult = { historyId: string; seq: number; versions: Record<string, number> }
export type ChangesResult = { historyId: string; seq: number; changes: Change[]; more?: true } | { resync: true }
export type ApplyResult = { historyId: string; seq: number; applied: Applied[]; conflicts: Conflict[] }

/** How far afterRestore moves the change-log sequence: past any seq a browser saw before the restore. */
export const RESTORE_SEQ_JUMP = 1_000_000_000

/** The next change_log seq (also the version of the write that takes it). */
const NEXT_SEQ = "nextval(pg_get_serial_sequence('change_log', 'seq'))"

type WorkspaceRow = { initialized: boolean; lastSeq: number; resetSeq: number; prunedSeq: number; historyId: string }

const versionKey = (collection: string, id: string) => `${collection}:${id}`

async function readWorkspace(q: Queryable, workspaceId: string, lock: boolean): Promise<WorkspaceRow | null> {
  const r = await q.query<{ initialized_at: unknown; last_seq: unknown; reset_seq: unknown; pruned_seq: unknown; history_id: string }>(
    `SELECT initialized_at, last_seq, reset_seq, pruned_seq, history_id::text AS history_id FROM workspaces WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId],
  )
  const row = r.rows[0]
  if (!row) return null
  return {
    initialized: row.initialized_at !== null,
    lastSeq: Number(row.last_seq),
    resetSeq: Number(row.reset_seq),
    prunedSeq: Number(row.pruned_seq),
    historyId: row.history_id,
  }
}

/** Locks the workspace row for this transaction, creating it if it is missing. */
async function lockWorkspace(q: Queryable, workspaceId: string): Promise<WorkspaceRow> {
  const found = await readWorkspace(q, workspaceId, true)
  if (found) return found
  await q.query('INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [workspaceId])
  const created = await readWorkspace(q, workspaceId, true)
  if (!created) throw new Error('workspace row missing')
  return created
}

export async function isInitialized(db: Queryable, workspaceId = WORKSPACE_ID): Promise<boolean> {
  return (await readWorkspace(db, workspaceId, false))?.initialized ?? false
}

/** Whether a workspace was uploaded, and its history and seq: one row read, no records. */
export async function workspaceStatus(db: Queryable, workspaceId = WORKSPACE_ID): Promise<WorkspaceStatus> {
  const ws = await readWorkspace(db, workspaceId, false)
  if (!ws?.initialized) return { empty: true }
  return { empty: false, workspaceId, historyId: ws.historyId, seq: ws.lastSeq }
}

/** The whole workspace in the shape of src/domain/types.ts DB, or null before the first upload. */
export async function snapshot(db: Db, workspaceId = WORKSPACE_ID): Promise<Snapshot | null> {
  return db.tx(
    async (q) => {
      const ws = await readWorkspace(q, workspaceId, false)
      if (!ws?.initialized) return null
      const out: Record<string, unknown> = { schemaVersion: 1 }
      const versions: Record<string, number> = {}
      const docs = await q.query<{ key: string; data: unknown; version: unknown }>(
        'SELECT key, data, version FROM workspace_docs WHERE workspace_id = $1',
        [workspaceId],
      )
      const byKey = new Map(docs.rows.map((d) => [d.key, d]))
      for (const key of DOC_KEYS) {
        const d = byKey.get(key)
        if (!d) continue
        out[key] = d.data
        versions[versionKey(DOC_COLLECTION, key)] = Number(d.version)
      }
      for (const collection of RECORD_COLLECTIONS) {
        const rows = await q.query<{ id: string; data: unknown; version: unknown }>(
          `SELECT id, data, version FROM ${tableName(collection)} WHERE workspace_id = $1 ORDER BY pos, id`,
          [workspaceId],
        )
        out[collection] = rows.rows.map((r) => r.data)
        for (const r of rows.rows) versions[versionKey(collection, r.id)] = Number(r.version)
      }
      return { workspaceId, historyId: ws.historyId, seq: ws.lastSeq, db: out, versions }
    },
    { isolation: 'repeatable read', readOnly: true },
  )
}

/**
 * Replaces everything in one transaction: deletes the workspace's rows and its whole change log,
 * inserts every record and document (each version is the seq of its log row), logs them as upserts,
 * moves reset_seq so older clients resync and starts a new history id.
 * Without confirmReplace it only runs on an empty server (409 'not_empty' otherwise).
 */
export async function replaceWorkspace(
  db: Db,
  input: ValidWorkspace,
  userId: string | null,
  workspaceId = WORKSPACE_ID,
): Promise<ReplaceResult> {
  return db.tx(async (q) => {
    const ws = await lockWorkspace(q, workspaceId)
    if (ws.initialized && !input.confirmReplace) {
      throw new HttpError(409, 'not_empty', 'The server already holds a workspace. Send confirmReplace: true to replace it.')
    }
    await q.query('DELETE FROM workspace_docs WHERE workspace_id = $1', [workspaceId])
    for (const collection of RECORD_COLLECTIONS) {
      await q.query(`DELETE FROM ${tableName(collection)} WHERE workspace_id = $1`, [workspaceId])
    }
    // The replaced workspace's history goes too: deleted records and earlier values must not linger in
    // the log after Start fresh or an Import. Clients from before this point resync anyway.
    await q.query('DELETE FROM change_log WHERE workspace_id = $1', [workspaceId])

    const versions: Record<string, number> = {}
    for (const doc of input.docs) {
      const r = await q.query<{ version: unknown }>(
        `WITH s AS (SELECT ${NEXT_SEQ} AS v),
              logged AS (
                INSERT INTO change_log (seq, workspace_id, collection, record_id, op, version, data, user_id)
                SELECT v, $1, $5, $2, 'upsert', v, $3::jsonb, $4 FROM s
              )
         INSERT INTO workspace_docs (workspace_id, key, data, version, updated_by)
         SELECT $1, $2, $3::jsonb, v, $4 FROM s
         RETURNING version`,
        [workspaceId, doc.key, doc.json, userId, DOC_COLLECTION],
      )
      versions[versionKey(DOC_COLLECTION, doc.key)] = Number(r.rows[0].version)
    }
    for (const c of input.collections) {
      if (c.ids.length === 0) continue
      // One seq per record, in array order; the record and its log row share it as their version.
      const r = await q.query<{ id: string; version: unknown }>(
        `WITH e AS MATERIALIZED (
                SELECT x.value, x.ord, ${NEXT_SEQ} AS v
                  FROM (SELECT j.value, j.ord FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS j(value, ord) ORDER BY j.ord) x
              ),
              logged AS (
                INSERT INTO change_log (seq, workspace_id, collection, record_id, op, version, data, user_id)
                SELECT v, $1, $4, value->>'id', 'upsert', v, value, $3 FROM e
              )
         INSERT INTO ${c.table} (workspace_id, id, data, version, pos, updated_by)
         SELECT $1, value->>'id', value, v, ord - 1, $3 FROM e
         RETURNING id, version`,
        [workspaceId, c.json, userId, c.collection],
      )
      for (const row of r.rows) versions[versionKey(c.collection, row.id)] = Number(row.version)
    }

    const max = await q.query<{ seq: unknown }>('SELECT max(seq) AS seq FROM change_log WHERE workspace_id = $1', [workspaceId])
    const seq = Math.max(ws.lastSeq, Number(max.rows[0]?.seq ?? 0))
    const updated = await q.query<{ history_id: string }>(
      `UPDATE workspaces
          SET initialized_at = coalesce(initialized_at, now()), replaced_at = now(), last_seq = $2, reset_seq = $2,
              pruned_seq = greatest(pruned_seq, $3), history_id = gen_random_uuid()
        WHERE id = $1
        RETURNING history_id::text AS history_id`,
      [workspaceId, seq, ws.lastSeq],
    )
    return { historyId: updated.rows[0].history_id, seq, versions }
  })
}

export type ChangesOptions = {
  /** The history id the client last saw; a different one means resync. Null or absent: not checked. */
  historyId?: string | null
  workspaceId?: string
  /** Most changes per pull (5,000 by default). */
  limit?: number
}

/** Changes after `since`, oldest first, at most 5,000 (`more` when truncated), or resync. */
export async function changesSince(db: Db, since: number, options: ChangesOptions = {}): Promise<ChangesResult> {
  const workspaceId = options.workspaceId ?? WORKSPACE_ID
  const limit = options.limit ?? LIMITS.changesPerPull
  return db.tx(
    async (q) => {
      const ws = await readWorkspace(q, workspaceId, false)
      if (!ws?.initialized) return { resync: true as const }
      // From another history (replaced or restored since), older than the last full replace or the pruned
      // history, or from a log this server never wrote.
      if (options.historyId && options.historyId !== ws.historyId) return { resync: true as const }
      if (since < ws.resetSeq || since < ws.prunedSeq || since > ws.lastSeq) return { resync: true as const }
      const r = await q.query<{ seq: unknown; collection: string; record_id: string; op: 'upsert' | 'delete'; version: unknown; data: unknown }>(
        `SELECT seq, collection, record_id, op, version, data FROM change_log
          WHERE workspace_id = $1 AND seq > $2 AND seq <= $3
          ORDER BY seq LIMIT $4`,
        [workspaceId, since, ws.lastSeq, limit + 1],
      )
      const more = r.rows.length > limit
      const rows = more ? r.rows.slice(0, limit) : r.rows
      const changes: Change[] = rows.map((row) => {
        const change: Change = { seq: Number(row.seq), collection: row.collection, id: row.record_id, op: row.op, version: Number(row.version) }
        if (row.op === 'upsert') change.data = row.data
        return change
      })
      const seq = more ? changes[changes.length - 1].seq : ws.lastSeq
      return more ? { historyId: ws.historyId, seq, changes, more: true as const } : { historyId: ws.historyId, seq, changes }
    },
    { isolation: 'repeatable read', readOnly: true },
  )
}

type CurrentRow = { version: unknown; data: unknown; same: boolean | null; by_you: boolean }

/** The record's newest change-log row; byYou: `userId` wrote it. */
async function lastLogged(
  q: Queryable,
  workspaceId: string,
  collection: string,
  id: string,
  userId: string | null,
): Promise<{ op: string; version: number; byYou: boolean } | null> {
  const r = await q.query<{ op: string; version: unknown; by_you: boolean }>(
    `SELECT op, version, coalesce(user_id = $4::uuid, false) AS by_you FROM change_log
      WHERE workspace_id = $1 AND collection = $2 AND record_id = $3
      ORDER BY seq DESC LIMIT 1`,
    [workspaceId, collection, id, userId],
  )
  const row = r.rows[0]
  return row ? { op: row.op, version: Number(row.version), byYou: row.by_you === true } : null
}

/**
 * True when the change log holds an upsert of exactly this change's data for its record after `since`:
 * an earlier attempt of this change landed (its answer never reached the client). The log keeps upserts
 * until the record is deleted or the rows are pruned, so a false answer proves nothing.
 */
async function loggedAfter(q: Queryable, workspaceId: string, c: ValidChange, since: number): Promise<boolean> {
  if (c.op !== 'upsert' || c.json === null) return false
  const r = await q.query<{ found: boolean }>(
    `SELECT EXISTS (
        SELECT 1 FROM change_log
         WHERE workspace_id = $1 AND collection = $2 AND record_id = $3 AND op = 'upsert' AND seq > $4 AND data = $5::jsonb
      ) AS found`,
    [workspaceId, c.collection, c.id, since, c.json],
  )
  return r.rows[0]?.found === true
}

function conflict(c: ValidChange, serverVersion: number | null, serverData: unknown, flags: { byYou?: boolean; landed?: boolean } = {}): Conflict {
  const out: Conflict = { collection: c.collection, id: c.id, serverVersion, serverData }
  if (flags.byYou) out.byYou = true
  if (flags.landed) out.landed = true
  return out
}

export type ApplyOptions = {
  /** The history id the client last saw; a different one refuses the whole push (409 'resync'). */
  historyId?: string | null
  workspaceId?: string
}

/**
 * Applies client changes in one transaction, each accepted or rejected on its own:
 * - accepted when baseVersion equals the current version, or the record does not exist and baseVersion
 *   is null, or the record was deleted and baseVersion is at least the delete's version (a re-create by a
 *   client that saw the delete). An edit made on a copy from before the delete is a conflict: it would
 *   bring back a record another device removed. A missing document is always recreated;
 * - an upsert whose data already equals the server copy is reported as applied with `existing` (a
 *   retried push), and nothing is written;
 * - otherwise a conflict carrying the server's current copy (null when it does not exist), with `byYou`
 *   when the pushing user wrote that copy (or the delete), and `landed` when an earlier attempt of this
 *   very upsert is in the log after baseVersion (the client may then take the newer copy quietly).
 * Every accepted write takes the next change_log seq as its version.
 * Deletes are hard deletes plus a 'delete' row in the change log; the record's earlier log rows go.
 */
export async function applyChanges(db: Db, changes: ValidChange[], userId: string | null, options: ApplyOptions = {}): Promise<ApplyResult> {
  const workspaceId = options.workspaceId ?? WORKSPACE_ID
  return db.tx(async (q) => {
    const ws = await lockWorkspace(q, workspaceId)
    if (!ws.initialized) throw new HttpError(404, 'empty', 'The server has no workspace yet. Upload one first (PUT /api/workspace).')
    if (options.historyId && options.historyId !== ws.historyId) {
      throw new HttpError(409, 'resync', 'The server copy was replaced or restored since this browser last synced. Load it again, then push.')
    }
    const applied: Applied[] = []
    const conflicts: Conflict[] = []
    let seq = ws.lastSeq

    /** Appends the log row and returns its seq, which is the new version. */
    const log = async (c: ValidChange, op: 'upsert' | 'delete'): Promise<number> => {
      const r = await q.query<{ seq: unknown }>(
        `INSERT INTO change_log (seq, workspace_id, collection, record_id, op, version, data, user_id)
         SELECT s.v, $1, $2, $3, $4, s.v, $5::jsonb, $6 FROM (SELECT ${NEXT_SEQ} AS v) s
         RETURNING seq`,
        [workspaceId, c.collection, c.id, op, op === 'upsert' ? c.json : null, userId],
      )
      seq = Number(r.rows[0].seq)
      return seq
    }

    for (const c of changes) {
      const sameExpr = c.json === null ? 'NULL::boolean' : 'data = $4::jsonb'
      const params = c.json === null ? [workspaceId, c.id, userId] : [workspaceId, c.id, userId, c.json]
      const columns = `version, data, ${sameExpr} AS same, coalesce(updated_by = $3::uuid, false) AS by_you`
      const current: CurrentRow | undefined =
        c.table === null
          ? (await q.query<CurrentRow>(`SELECT ${columns} FROM workspace_docs WHERE workspace_id = $1 AND key = $2 FOR UPDATE`, params)).rows[0]
          : (await q.query<CurrentRow>(`SELECT ${columns} FROM ${c.table} WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, params)).rows[0]

      if (current) {
        const version = Number(current.version)
        if (c.baseVersion !== version) {
          if (c.op === 'upsert' && current.same === true) applied.push({ collection: c.collection, id: c.id, version, existing: true })
          else {
            const landed = await loggedAfter(q, workspaceId, c, c.baseVersion ?? 0)
            conflicts.push(conflict(c, version, current.data, { byYou: current.by_you === true, landed }))
          }
          continue
        }
        const next = await log(c, c.op)
        if (c.op === 'delete') {
          await q.query(`DELETE FROM ${c.table} WHERE workspace_id = $1 AND id = $2`, [workspaceId, c.id])
          // Keep only the delete row: earlier copies of a deleted record do not stay in the log.
          await q.query('DELETE FROM change_log WHERE workspace_id = $1 AND collection = $2 AND record_id = $3 AND seq < $4', [
            workspaceId,
            c.collection,
            c.id,
            next,
          ])
        } else if (c.table === null) {
          await q.query(
            'UPDATE workspace_docs SET data = $3::jsonb, version = $4, updated_at = now(), updated_by = $5 WHERE workspace_id = $1 AND key = $2',
            [workspaceId, c.id, c.json, next, userId],
          )
        } else {
          await q.query(
            `UPDATE ${c.table} SET data = $3::jsonb, version = $4, updated_at = now(), updated_by = $5 WHERE workspace_id = $1 AND id = $2`,
            [workspaceId, c.id, c.json, next, userId],
          )
        }
        applied.push({ collection: c.collection, id: c.id, version: next })
        continue
      }

      // Not on the server.
      const last = await lastLogged(q, workspaceId, c.collection, c.id, userId)
      if (c.op === 'delete') {
        // Already gone: nothing to do, the client's intent holds.
        applied.push({ collection: c.collection, id: c.id, version: last?.version ?? 0 })
        continue
      }
      // Documents always exist after an upload; a missing one is simply recreated. A record comes back
      // only from a client that believes it is new, or that saw it deleted (a base at least as new as the
      // delete): an edit made on a copy from before the delete loses to it, as to any newer change.
      const deleted = last?.op === 'delete' ? last : null
      if (c.table !== null && c.baseVersion !== null && !(deleted && c.baseVersion >= deleted.version)) {
        conflicts.push(conflict(c, null, null, { byYou: deleted?.byYou === true }))
        continue
      }
      const next = await log(c, 'upsert')
      if (c.table === null) {
        await q.query(
          'INSERT INTO workspace_docs (workspace_id, key, data, version, updated_by) VALUES ($1, $2, $3::jsonb, $4, $5)',
          [workspaceId, c.id, c.json, next, userId],
        )
      } else {
        await q.query(
          `INSERT INTO ${c.table} (workspace_id, id, data, version, pos, updated_by)
           VALUES ($1, $2, $3::jsonb, $4, (SELECT coalesce(max(pos), -1) + 1 FROM ${c.table} WHERE workspace_id = $1), $5)`,
          [workspaceId, c.id, c.json, next, userId],
        )
      }
      applied.push({ collection: c.collection, id: c.id, version: next })
    }

    if (seq !== ws.lastSeq) await q.query('UPDATE workspaces SET last_seq = $2 WHERE id = $1', [workspaceId, seq])
    return { historyId: ws.historyId, seq, applied, conflicts }
  })
}

/**
 * Deletes change-log rows older than `olderThanDays` (120 by default). Clients whose `since` predates
 * the pruned rows get `resync: true`. Returns how many rows were removed.
 */
export async function pruneChangeLog(db: Db, olderThanDays = 120, workspaceId = WORKSPACE_ID): Promise<number> {
  return db.tx(async (q) => {
    await lockWorkspace(q, workspaceId)
    const r = await q.query<{ seq: unknown }>(
      `SELECT max(seq) AS seq FROM change_log WHERE workspace_id = $1 AND at < now() - make_interval(days => $2::int)`,
      [workspaceId, olderThanDays],
    )
    const cutoff = r.rows[0]?.seq
    if (cutoff === null || cutoff === undefined) return 0
    const del = await q.query('DELETE FROM change_log WHERE workspace_id = $1 AND seq <= $2', [workspaceId, Number(cutoff)])
    await q.query('UPDATE workspaces SET pruned_seq = greatest(pruned_seq, $2) WHERE id = $1', [workspaceId, Number(cutoff)])
    return del.rowCount
  })
}

export type AfterRestoreResult = { seq: number; historyId: string; sessionsEnded: number }

/**
 * Run once after loading a backup (`npm run server:after-restore`, docs/SERVER.md). A restored database
 * reuses seqs and versions that browsers already saw in the history that was lost, so this:
 * - moves the change-log sequence RESTORE_SEQ_JUMP past anything it ever handed out, and sets last_seq
 *   and reset_seq there, so every browser's `since` is older than reset_seq and it resyncs, and every new
 *   version is larger than any version a browser could still hold;
 * - starts a new history id, so browsers that send theirs are told to resync before anything applies;
 * - ends every session and forgets every trusted device: the backup may hold sessions that were signed
 *   out, and devices that were forgotten (server:create-admin), after it was taken.
 */
export async function afterRestore(db: Db, workspaceId = WORKSPACE_ID): Promise<AfterRestoreResult> {
  return db.tx(async (q) => {
    const ws = await lockWorkspace(q, workspaceId)
    const top = await q.query<{ top: unknown }>(
      `SELECT greatest(
                $1::bigint,
                (SELECT coalesce(max(seq), 0) FROM change_log),
                (SELECT coalesce(max(last_seq), 0) FROM workspaces),
                coalesce(pg_sequence_last_value(pg_get_serial_sequence('change_log', 'seq')::regclass), 0)
              ) AS top`,
      [ws.lastSeq],
    )
    const seq = Number(top.rows[0].top) + RESTORE_SEQ_JUMP
    await q.query(`SELECT setval(pg_get_serial_sequence('change_log', 'seq'), $1::bigint)`, [seq])
    const updated = await q.query<{ history_id: string }>(
      `UPDATE workspaces SET last_seq = $2, reset_seq = $2, history_id = gen_random_uuid() WHERE id = $1 RETURNING history_id::text AS history_id`,
      [workspaceId, seq],
    )
    const sessions = await q.query('DELETE FROM sessions')
    await q.query('DELETE FROM trusted_devices')
    return { seq, historyId: updated.rows[0].history_id, sessionsEnded: sessions.rowCount }
  })
}
