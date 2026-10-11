// An in-memory First Twenty server for sync tests: implements the SyncApi contract from docs/SYNC.md
// (versions, conflicts, change log with seq, resync after pruning, history ids, one admin session) without
// HTTP.
// Versions work like server/src/repo.ts: every accepted write (and every row of a full replace) takes the
// next workspace-wide seq as its version, so a record's next version is rarely its old one plus 1.
// Test-only: nothing in the app imports it.
import type { DB } from '@/domain/types'
import type { ApiFailure, ApiResult, PushOptions, SyncApi } from '../api'
import { DOC_COLLECTION, DOC_KEYS, isDocKey, isRecordCollection, RECORD_COLLECTIONS } from '../collections'
import {
  type Applied,
  type Change,
  type ChangesResponse,
  type ClientChange,
  type Conflict,
  type HealthResponse,
  type PostChangesResponse,
  type PutWorkspaceResponse,
  recordKey,
  type SyncUser,
  type WorkspaceSnapshot,
} from '../protocol'

type Row = { collection: string; id: string; version: number; data: unknown }

const wire = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

export const TEST_ADMIN_EMAIL = 'admin@example.test'
/** A test-only value; the fake server has no real accounts. */
export const TEST_ADMIN_PASSWORD = 'test-only-not-a-secret'

export class FakeServer implements SyncApi {
  online = true
  signedIn = true
  hasWorkspace = false
  /** Most changes per GET /api/changes page. */
  pageSize = 5000
  /** The newest seq. Every accepted write takes the next one, and it is also that write's version. */
  seq = 0
  /** Log rows at or below this seq were pruned: a client asking from before it must resync. */
  minSeq = 0
  /** Names the current history; a full replace starts a new one. */
  historyId = 'history-1'
  /** False acts like a server from before history ids: none sent, none checked. */
  historyIds = true
  private histories = 1
  rows = new Map<string, Row>()
  lastVersion = new Map<string, number>()
  lastOp = new Map<string, 'upsert' | 'delete'>()
  log: Change[] = []
  /** Every call, in order, and when it was made (Date.now(), fake timers in tests). */
  calls: string[] = []
  callTimes: number[] = []
  /** Every POST /api/changes body, in order. */
  pushes: ClientChange[][] = []
  /** The history id each pull and push carried, in order (null: none). */
  sentHistory: Array<string | null> = []
  keepalivePushes = 0
  /** Forced failures, used up one per call. */
  failures: ApiFailure[] = []
  /** Record ids the server refuses (the whole POST answers 400 while one is in it). */
  refuseIds = new Set<string>()
  /** Hooks that run while a request is "on the wire" (to simulate edits made meanwhile). */
  onGetChanges: (() => void) | null = null
  onGetWorkspace: (() => void) | null = null
  readonly user: SyncUser = { id: '00000000-0000-4000-8000-000000000001', email: TEST_ADMIN_EMAIL, role: 'admin' }

  private gate<T>(name: string, auth: boolean, fn: () => ApiResult<T>): Promise<ApiResult<T>> {
    this.calls.push(name)
    this.callTimes.push(Date.now())
    if (!this.online) return Promise.resolve({ ok: false, kind: 'offline', status: null, error: null })
    const forced = this.failures.shift()
    if (forced) return Promise.resolve(forced)
    if (auth && !this.signedIn) return Promise.resolve({ ok: false, kind: 'signed_out', status: 401, error: 'unauthorized' })
    return Promise.resolve(fn())
  }

  health(): Promise<ApiResult<HealthResponse>> {
    return this.gate('health', false, () => ({ ok: true, status: 200, data: { ok: true, db: 'up', version: 'test' } }))
  }

  login(email: string, password: string): Promise<ApiResult<{ user: SyncUser }>> {
    return this.gate('login', false, () => {
      if (email.toLowerCase() !== TEST_ADMIN_EMAIL || password !== TEST_ADMIN_PASSWORD) {
        return { ok: false, kind: 'invalid_credentials', status: 401, error: 'invalid_credentials' }
      }
      this.signedIn = true
      return { ok: true, status: 200, data: { user: { ...this.user } } }
    })
  }

  logout(): Promise<ApiResult<null>> {
    return this.gate('logout', false, () => {
      this.signedIn = false
      return { ok: true, status: 204, data: null }
    })
  }

  me(): Promise<ApiResult<{ user: SyncUser }>> {
    return this.gate('me', true, () => ({ ok: true, status: 200, data: { user: { ...this.user } } }))
  }

  getWorkspace(): Promise<ApiResult<WorkspaceSnapshot>> {
    return this.gate<WorkspaceSnapshot>('getWorkspace', true, () => {
      this.onGetWorkspace?.()
      if (!this.hasWorkspace) return { ok: false, kind: 'empty', status: 404, error: 'empty' }
      const snap: WorkspaceSnapshot = { workspaceId: 'default', seq: this.seq, db: this.snapshot(), versions: this.versions() }
      if (this.historyIds) snap.historyId = this.historyId
      return { ok: true, status: 200, data: snap }
    })
  }

  putWorkspace(db: DB, confirmReplace?: boolean): Promise<ApiResult<PutWorkspaceResponse>> {
    return this.gate<PutWorkspaceResponse>('putWorkspace', true, () => {
      if (this.hasWorkspace && !confirmReplace) return { ok: false, kind: 'not_empty', status: 409, error: 'not_empty' }
      const src = wire(db) as unknown as Record<string, unknown>
      // Like the real server, a replace forgets the old rows and their log, and every row it writes takes
      // the next seq (documents first, then each collection in order): versions keep growing.
      this.rows.clear()
      this.lastVersion.clear()
      this.lastOp.clear()
      for (const k of DOC_KEYS) if (src[k] !== undefined) this.write(DOC_COLLECTION, k, src[k])
      for (const c of RECORD_COLLECTIONS) {
        for (const r of (src[c] as Array<{ id: string }>) ?? []) this.write(c, r.id, r)
      }
      // A replace starts a new log: every other client has to resync.
      this.minSeq = this.seq
      this.log = []
      this.hasWorkspace = true
      this.newHistory()
      return { ok: true, status: 200, data: { ...this.history(), seq: this.seq, versions: this.versions() } }
    })
  }

  getChanges(since: number, historyId?: string | null): Promise<ApiResult<ChangesResponse>> {
    return this.gate<ChangesResponse>('getChanges', true, () => {
      this.onGetChanges?.()
      this.sentHistory.push(historyId ?? null)
      if (this.historyIds && historyId && historyId !== this.historyId) return { ok: true, status: 200, data: { resync: true } }
      if (!this.hasWorkspace || since < this.minSeq || since > this.seq) return { ok: true, status: 200, data: { resync: true } }
      const after = this.log.filter((c) => c.seq > since)
      const page = after.slice(0, this.pageSize)
      const more = after.length > page.length
      return { ok: true, status: 200, data: { ...this.history(), seq: more ? page[page.length - 1].seq : this.seq, changes: wire(page), more } }
    })
  }

  postChanges(changes: ClientChange[], opts?: PushOptions): Promise<ApiResult<PostChangesResponse>> {
    return this.gate<PostChangesResponse>('postChanges', true, () => {
      this.pushes.push(wire(changes))
      this.sentHistory.push(opts?.historyId ?? null)
      if (opts?.keepalive) this.keepalivePushes++
      if (this.historyIds && opts?.historyId && opts.historyId !== this.historyId) return { ok: false, kind: 'resync', status: 409, error: 'resync' }
      if (!this.hasWorkspace) return { ok: false, kind: 'empty', status: 404, error: 'empty' }
      for (const ch of changes) {
        const knownCollection = isRecordCollection(ch.collection) || (ch.collection === DOC_COLLECTION && isDocKey(ch.id))
        const badRecord =
          ch.op === 'upsert' && isRecordCollection(ch.collection) && (ch.data as { id?: unknown } | null)?.id !== ch.id
        if (!knownCollection || badRecord || this.refuseIds.has(ch.id)) {
          return { ok: false, kind: 'bad_request', status: 400, error: 'invalid_change' }
        }
      }
      const applied: Applied[] = []
      const conflicts: Conflict[] = []
      // The same rules as server/src/repo.ts applyChanges.
      for (const ch of changes) {
        const key = recordKey(ch.collection, ch.id)
        const row = this.rows.get(key)
        if (row) {
          if (ch.baseVersion !== row.version) {
            if (ch.op === 'upsert' && JSON.stringify(row.data) === JSON.stringify(ch.data)) applied.push({ collection: ch.collection, id: ch.id, version: row.version })
            else conflicts.push({ collection: ch.collection, id: ch.id, serverVersion: row.version, serverData: wire(row.data) })
            continue
          }
        } else {
          if (ch.op === 'delete') {
            // Already gone: the client's intent holds.
            applied.push({ collection: ch.collection, id: ch.id, version: this.lastVersion.get(key) ?? 0 })
            continue
          }
          const lastWasDelete = this.lastOp.get(key) === 'delete'
          if (ch.baseVersion !== null && !lastWasDelete && ch.collection !== DOC_COLLECTION) {
            conflicts.push({ collection: ch.collection, id: ch.id, serverVersion: null, serverData: null })
            continue
          }
        }
        const version = this.commit(ch.collection, ch.id, ch.op, ch.data)
        applied.push({ collection: ch.collection, id: ch.id, version })
      }
      return { ok: true, status: 200, data: { ...this.history(), seq: this.seq, applied, conflicts } }
    })
  }

  // ------------------------------------------------------------------------------------------
  // Test controls: another device writing, pruning the log, reading the server's state.
  // ------------------------------------------------------------------------------------------

  /** Another device saves a record (always accepted). */
  serverUpsert(collection: string, id: string, data: unknown): number {
    return this.commit(collection, id, 'upsert', data)
  }

  serverDelete(collection: string, id: string): number {
    return this.commit(collection, id, 'delete')
  }

  /**
   * The next `n` POST /api/changes commit on the server, but the answer never reaches the browser (a
   * timeout, a dropped mobile connection, a page frozen after a keepalive flush).
   */
  loseResponses(n = 1): void {
    let left = n
    const real = FakeServer.prototype.postChanges.bind(this)
    this.postChanges = async (changes, opts) => {
      const res = await real(changes, opts)
      if (left <= 0) return res
      left -= 1
      return { ok: false, kind: 'offline', status: null, error: null }
    }
  }

  /** The server lost its workspace (its database was reset or rebuilt, or restored from an empty backup). */
  loseWorkspace(): void {
    this.hasWorkspace = false
    this.rows.clear()
    this.lastVersion.clear()
    this.lastOp.clear()
    this.log = []
    this.minSeq = this.seq
  }

  /** A restore (npm run server:after-restore): same rows, a new history, every client resyncs. */
  restore(): void {
    this.seq += 1
    this.minSeq = this.seq
    this.log = []
    this.newHistory()
  }

  private newHistory(): void {
    this.histories += 1
    this.historyId = `history-${this.histories}`
  }

  private history(): { historyId?: string } {
    return this.historyIds ? { historyId: this.historyId } : {}
  }

  /** Drops every log row so far: clients behind the current seq get resync. */
  prune(): void {
    this.minSeq = this.seq
    this.log = []
  }

  snapshot(): DB {
    const db: Record<string, unknown> = { schemaVersion: 1 }
    for (const c of RECORD_COLLECTIONS) db[c] = []
    for (const row of this.rows.values()) {
      if (row.collection === DOC_COLLECTION) db[row.id] = wire(row.data)
      // A collection a newer build added (serverUpsert lets tests write one).
      else ((db[row.collection] ??= []) as unknown[]).push(wire(row.data))
    }
    return db as unknown as DB
  }

  versions(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [key, row] of this.rows) out[key] = row.version
    return out
  }

  record(collection: string, id: string): unknown {
    return wire(this.rows.get(recordKey(collection, id))?.data)
  }

  callCount(name: string): number {
    return this.calls.filter((c) => c === name).length
  }

  /** When each call of this kind was made. */
  timesOf(name: string): number[] {
    return this.callTimes.filter((_t, i) => this.calls[i] === name)
  }

  /** Stores a row at the next seq, which is its version. */
  private write(collection: string, id: string, data: unknown): number {
    const key = recordKey(collection, id)
    const version = ++this.seq
    this.lastVersion.set(key, version)
    this.rows.set(key, { collection, id, version, data: wire(data) })
    return version
  }

  private commit(collection: string, id: string, op: 'upsert' | 'delete', data?: unknown): number {
    const key = recordKey(collection, id)
    let version: number
    this.lastOp.set(key, op)
    if (op === 'upsert') version = this.write(collection, id, data)
    else {
      version = ++this.seq
      this.lastVersion.set(key, version)
      this.rows.delete(key)
    }
    this.log.push(op === 'upsert' ? { seq: version, collection, id, op, version, data: wire(data) } : { seq: version, collection, id, op, version })
    this.hasWorkspace = true
    return version
  }
}

/** One device's own connection to a shared server, so one device can go offline while another stays on. */
export type DeviceLink = SyncApi & { online: boolean }

export function deviceLink(server: SyncApi): DeviceLink {
  const offline = <T>(): Promise<ApiResult<T>> => Promise.resolve({ ok: false, kind: 'offline', status: null, error: null })
  const link: DeviceLink = {
    online: true,
    health: () => (link.online ? server.health() : offline()),
    login: (email, password, opts) => (link.online ? server.login(email, password, opts) : offline()),
    logout: () => (link.online ? server.logout() : offline()),
    me: () => (link.online ? server.me() : offline()),
    getWorkspace: () => (link.online ? server.getWorkspace() : offline()),
    putWorkspace: (db, confirmReplace) => (link.online ? server.putWorkspace(db, confirmReplace) : offline()),
    getChanges: (since, historyId) => (link.online ? server.getChanges(since, historyId) : offline()),
    postChanges: (changes, opts) => (link.online ? server.postChanges(changes, opts) : offline()),
  }
  return link
}
