// Public API of the sync engine for the app and the sync UI (Settings > Data > Server, header chip).
// Importing this module has no side effects; nothing talks to a server until initSync() finds a saved
// server connection or the user goes through a connect flow.
//
//   initSync()                       call once at startup, before the first edit (main.tsx); a no-op in a
//                                    local-only install
//   useSyncStatus((s) => s.status)   'local' | 'synced' | 'syncing' | 'offline' | 'signed_out' | 'error'
//   connect.checkServer()            is a server answering at this origin, and are we signed in?
//   connect.signIn(email, password, {remember?})   remember: "Keep me signed in" (7 days instead of
//                                    ending with the browser or after 12 hours)
//   connect.inspectServer()          empty, or what the server holds (company name, counts)
//   connect.uploadLocal({confirmReplace?, includeSample?})   this browser's workspace -> server
//   connect.useServerCopy({discardPending?})                 server's workspace -> this browser
//   replaceWorkspace(db, label)      Import and Start fresh: use this instead of useDB.replace, so a
//                                    connected browser replaces the server's workspace as a whole
//   signOut()                        ends the session; this browser keeps an offline copy. Resolves
//                                    {confirmed, message}: confirmed false means the server could not be
//                                    reached; the browser stays signed out and ends the session later
//   signOut({forgetThisBrowser: true, discardPending?, keepServerSession?})   "Sign out and remove data
//                                    from this browser"; kind 'session_open' when the server could not end
//                                    the session (nothing removed) unless keepServerSession
//   disconnect({discardPending?})    resolves {confirmed, message} like signOut
//   syncNow(), clearRefreshed(), retryRejected()
//   getReplacedBackup(), clearReplacedRemotely()   the workspace shown before another computer replaced
//                                    the server's (status.replacedRemotely), for a backup download
// Other tabs: removing this browser's data or disconnecting in one tab stops the engine in the others
// (storage events plus a BroadcastChannel), so no tab writes the workspace or the connection back.
import { produce } from 'immer'
import { applyDueHandoffs } from '@/domain/handoff'
import { applyScheduledChanges } from '@/domain/lifecycle'
import type { DB } from '@/domain/types'
import { getClockOverride, today } from '@/lib/dates'
import { loadSample, migrate, stopPersisting, STORAGE_KEY, useDB } from '@/store/db'
import { createApi, type LoginOptions } from './api'
import { createSyncEngine, type SignOutOptions, type SyncEngine, type UploadOptions } from './engine'
import { defaultStorage, LOGOUT_PENDING_KEY, loadConnection, readLogoutPending, type StorageLike, SYNC_STORAGE_KEY } from './state'

export type { ApiErrorKind, ApiFailure, ApiResult, LoginOptions, SyncApi } from './api'
export { describeFailure } from './api'
export type {
  CheckServerResult,
  DisconnectResult,
  FlowFailure,
  FlowResult,
  InspectResult,
  SignInResult,
  SignOutOptions,
  SignOutResult,
  SyncEngine,
  UploadOptions,
} from './engine'
export {
  CLOCK_MESSAGE,
  DISCONNECTED_MESSAGE,
  DISCONNECTED_PENDING_MESSAGE,
  LEAVING_CLOCK_MESSAGE,
  LOGOUT_PENDING_MESSAGE,
  SAMPLE_MESSAGE,
  SESSION_OPEN_MESSAGE,
  SIGNED_OUT_MESSAGE,
  STORAGE_FULL_MESSAGE,
  SWITCHED_MESSAGE,
  JOINED_MESSAGE,
} from './engine'
export type { SyncUser } from './protocol'
export type { HoldReason, SyncMode } from './state'
export type { ReplacedRemotely, SyncStatus, SyncStatusState } from './status'
export { useSyncStatus } from './status'

/** Every key this app keeps in localStorage starts with this. */
export const APP_STORAGE_PREFIX = 'first-twenty:'

let engine: SyncEngine | null = null

/** The workspace as db.ts last saved it (before this load's effective-dated changes), or null. */
export function readSavedDB(storage: StorageLike | null): DB | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DB
    if (parsed?.schemaVersion !== 1 || !parsed.company) return null
    return migrate(parsed)
  } catch {
    return null
  }
}

/** What db.ts does to a workspace when it loads: effective-dated changes and hand-offs due by today. */
export function applyLoadChanges(db: DB): DB {
  return produce(db, (d) => {
    applyScheduledChanges(d, today())
    applyDueHandoffs(d, today())
  })
}

/**
 * Removes every key of this app from localStorage (the workspace, the sync state, preferences), except
 * the ones in `keep`.
 */
export function wipeAppStorage(storage?: Pick<Storage, 'length' | 'key' | 'removeItem'> | null, keep: readonly string[] = []): void {
  try {
    const s = storage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : storage
    if (!s) return
    const keys: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k?.startsWith(APP_STORAGE_PREFIX) && !keep.includes(k)) keys.push(k)
    }
    for (const k of keys) s.removeItem(k)
  } catch {
    /* storage blocked: nothing was saved there either */
  }
}

// ---------------------------------------------------------------------------------------------
// Other tabs of this browser
// ---------------------------------------------------------------------------------------------

/** BroadcastChannel name shared by every tab of the app on this origin. */
export const TAB_CHANNEL = 'first-twenty'

export type TabMessage = { type: 'forget' }

/**
 * What another tab's storage change means for this one:
 * - 'forget': the workspace key was removed (only Sign out and remove data does that);
 * - 'disconnect': the sync state was removed but the workspace stays (Disconnect);
 * - null: nothing to do. That includes storage.clear() (key null): another page on a shared origin (every
 *   page opened from disk shares one) may clear it, and this tab's copy may then be the only one left.
 */
export function storageChangeAction(e: { key: string | null; newValue: string | null }): 'forget' | 'disconnect' | null {
  if (e.key === null || e.newValue !== null) return null
  if (e.key === STORAGE_KEY) return 'forget'
  if (e.key === SYNC_STORAGE_KEY) return 'disconnect'
  return null
}

let tabChannel: BroadcastChannel | null = null
let tabsWired = false
let forgotten = false

/** Tells the other tabs that this browser's data is being removed. */
function announceForget(): void {
  try {
    tabChannel?.postMessage({ type: 'forget' } satisfies TabMessage)
  } catch {
    /* no channel: the storage events still reach them */
  }
}

/**
 * Another tab removed this browser's data: stop syncing, show the fresh workspace, remove anything this
 * tab may have written meanwhile (keeping a pending sign-out), and reload so nothing stays in memory. The
 * store stops saving first (stopPersisting), so nothing is written back on the way out.
 */
export function forgetInThisTab(o: { storage?: Pick<Storage, 'length' | 'key' | 'removeItem'> | null; reload?: () => void } = {}): void {
  if (forgotten) return
  forgotten = true
  stopPersisting()
  if (engine) engine.dropLocal()
  else useDB.setState({ db: loadSample(), past: [] })
  wipeAppStorage(o.storage, [LOGOUT_PENDING_KEY])
  const reload = o.reload ?? (() => typeof window !== 'undefined' && window.location.reload())
  reload()
}

/** Listens for another tab removing this browser's data or disconnecting it. Once per page. */
function wireTabs(): void {
  if (tabsWired || typeof window === 'undefined') return
  tabsWired = true
  try {
    window.addEventListener('storage', (e: StorageEvent) => {
      if (forgotten) return
      try {
        if (e.storageArea && typeof localStorage !== 'undefined' && e.storageArea !== localStorage) return
      } catch {
        return
      }
      const action = storageChangeAction(e)
      if (action === 'forget') forgetInThisTab()
      else if (action === 'disconnect') engine?.disconnectedElsewhere()
    })
  } catch {
    /* no window events (tests): nothing to listen to */
  }
  try {
    const Channel = (window as unknown as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel
    if (typeof Channel === 'function') {
      tabChannel = new Channel(TAB_CHANNEL)
      tabChannel.onmessage = (e: MessageEvent) => {
        if ((e.data as TabMessage | null)?.type === 'forget') forgetInThisTab()
      }
    }
  } catch {
    tabChannel = null
  }
}

/** The app's one engine, created on first use. */
export function getSyncEngine(): SyncEngine {
  if (engine) return engine
  const storage = defaultStorage()
  engine = createSyncEngine({
    store: useDB,
    api: createApi(),
    storage,
    prepareSnapshot: migrate,
    // db.ts applies effective-dated changes before the engine starts and saves them only with the next
    // edit: the difference from the saved copy is queued on start, so those changes reach the server.
    baseline: () => readSavedDB(storage),
    onLoad: applyLoadChanges,
    // 'Pretend today is' (Settings, Data): while it is on, the connection holds and nothing syncs.
    clockOverride: getClockOverride,
    // The engine saves the store itself (db.ts waits 400 ms) right before it records server progress.
    persistStore: () => {
      if (!storage) return false
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(useDB.getState().db))
        return true
      } catch {
        return false
      }
    },
    // The other tabs drop their copy too (they would save it again on their next edit).
    // The store stops saving first: the engine puts the sample in it next, and db.ts would otherwise write
    // that back (debounced, or on the way out), leaving a first-twenty: key behind.
    wipeLocal: () => {
      stopPersisting()
      announceForget()
      wipeAppStorage()
    },
    // What a browser that never opened the app shows, until the reload.
    freshDB: loadSample,
    reload: () => {
      if (typeof window !== 'undefined') window.location.reload()
    },
  })
  return engine
}

/**
 * Starts syncing when this browser was connected to a server before. Safe to call in a local-only
 * install (including the one-file build opened from disk): it reads one localStorage key and returns.
 * Call it before the first edit, so changes made on load are told apart from the saved copy.
 */
export function initSync(): void {
  if (typeof window === 'undefined') return
  wireTabs()
  const storage = defaultStorage()
  // A sign-out the server never confirmed starts the engine too, even after Disconnect or removing this
  // browser's data: it ends that session before anything else (and never syncs from it).
  if (loadConnection(storage).mode !== 'server' && !readLogoutPending(storage)) return
  getSyncEngine().start()
}

export const connect = {
  checkServer: () => getSyncEngine().checkServer(),
  signIn: (email: string, password: string, opts?: LoginOptions) => getSyncEngine().signIn(email, password, opts),
  inspectServer: () => getSyncEngine().inspectServer(),
  uploadLocal: (opts?: UploadOptions) => getSyncEngine().uploadLocal(opts),
  useServerCopy: (opts?: { discardPending?: boolean }) => getSyncEngine().useServerCopy(opts),
}

/**
 * Import a backup or Start fresh. Not connected: useDB.replace (one Undo step). Connected: replaces the
 * server's workspace for every device first (no Undo step); on failure nothing changes and the result
 * says why (offline, signed out...).
 */
export function replaceWorkspace(db: DB, label?: string) {
  return getSyncEngine().replaceWorkspace(db, { label })
}

export function disconnect(opts?: { discardPending?: boolean }) {
  return getSyncEngine().disconnect(opts)
}

/**
 * Ends the server session. A plain sign-out keeps the workspace in this browser as an offline copy.
 * With forgetThisBrowser it also removes the workspace, the sync state and preferences from this browser
 * and reloads the page (use it on shared computers); queued changes are sent first, and if some cannot
 * be, nothing is removed (kind 'pending') unless discardPending is set.
 */
export function signOut(opts?: SignOutOptions) {
  return getSyncEngine().signOut(opts)
}

/** Push and pull now (a "Sync now" button). */
export function syncNow(): Promise<void> {
  return getSyncEngine().syncNow()
}

/** The UI showed "N items were refreshed from the server"; reset the count. */
export function clearRefreshed(): void {
  getSyncEngine().clearRefreshed()
}

export function retryRejected(): void {
  getSyncEngine().retryRejected()
}

/**
 * The workspace this browser showed before another computer replaced the server's (useSyncStatus
 * replacedRemotely), or null. Kept in memory only, until clearReplacedRemotely() or the tab closes.
 */
export function getReplacedBackup(): DB | null {
  return engine ? engine.getReplacedBackup() : null
}

/** Dismisses the replaced-from-another-computer notice and forgets the copy it offered. */
export function clearReplacedRemotely(): void {
  engine?.clearReplacedRemotely()
}
