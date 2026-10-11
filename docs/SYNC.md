# Server and sync: contract

First Twenty stays local-first: it keeps working in the browser with no server, exactly as before. A
company that wants its data in its own database runs the **First Twenty server** next to Postgres on an
EC2 instance. The browser then syncs every change to the server, keeps working offline, and catches up
when the connection returns.

Decisions (from the user, October 2026):

- The API server runs **on the same EC2 instance as Postgres**. Postgres listens on localhost only; port
  5432 is never opened to the internet. The API is reached over HTTPS through Caddy on port 443.
- **One admin login** protects the data. Viewing as stays a preview (not security). Team logins with
  server-enforced roles can come later; the schema leaves room for them (`users.role`).
- **One table per record type, holding JSONB**: `people`, `candidates`, `jobs`, ... each with
  `(workspace_id, id, data jsonb, version, updated_at, updated_by)`.

## Pieces

| Piece | Where | Notes |
|---|---|---|
| API server | `server/src/**` (Fastify 5 + `pg`), built into `dist-server/server.mjs` with Vite SSR | Node 22+. Serves `/api/*` and, when `SERVE_APP=true`, the one-file app at `/`. |
| SQL migrations | `server/sql/NNN_name.sql`, applied by `npm run server:migrate` | Tracked in `schema_migrations`. |
| Shared collection list | `src/sync/collections.ts` | The single source of truth for which DB keys are record collections (one table each) and which are single documents. Server and client both import it. A test asserts it matches `src/domain/types.ts`. |
| Browser sync engine | `src/sync/**` | Diff, outbox, API client, pull/push loop, status store. No UI. |
| Sync UI | Settings > Server (`#settings.server`), a header status chip, sync banners under the header, the rail note | Opened from a file or the claude.ai artifact viewer, Settings > Server only explains the server and makes no request. |
| Deploy kit | `server/deploy/**` and `docs/SERVER.md` | EC2 setup script, systemd unit, Caddyfile, Postgres role and database SQL, backups, SSH tunnel for development. |
| Dev database | `DATABASE_URL=pglite:./.data/pg` (default when unset in development) | PGlite (real Postgres in WebAssembly) so development and tests need no Postgres install. Production always uses `pg`. |

## Data layout

- **Record collections**: every key of `DB` whose value is an array of `{ id }` records (people, comp,
  grants, contractors, documents, plan, jobs, candidates, applications, interviews, scorecards, offers,
  referrals, emailTemplates, checklistTemplates, checklists, timeOffPolicies, timeOffRequests,
  timeOffAdjustments, holidays, leaveCases, recurring, trainings, policies, acks, recordsRequests, activity,
  departments, locations, families, levels, bands). Table name = snake_case of the key
  (`timeOffRequests` -> `time_off_requests`). Columns: `workspace_id text`, `id text`, `data jsonb not null`,
  `version bigint not null`, `updated_at timestamptz not null`, `updated_by uuid null`;
  primary key `(workspace_id, id)`.
- **Versions** are the change-log `seq` of the write that produced them (migration 002). They never
  repeat within a workspace and only grow per record, across delete and re-create, a full replace and a
  restore, so a stale `baseVersion` can only match the write it was based on. Clients must treat them as
  opaque numbers up to 2^53 (they jump by a billion after a restore).
- **Documents** (non-array keys): `meta`, `company`, `equity`, `complianceStatus`, `inboxState`,
  `settings` live in `workspace_docs (workspace_id, key, data jsonb, version, updated_at, updated_by)`.
  In the protocol they use the collection name `$doc` and `id` = the key.
- `schemaVersion` is not stored per row; the snapshot sets it.
- **Change log** `change_log (seq bigserial primary key, workspace_id, collection, record_id, op, version,
  data jsonb null, at timestamptz, user_id uuid null)`: every accepted write appends a row. Pulls read it.
  Rows older than 120 days are pruned daily; a client whose `since` is older than the oldest kept row gets
  `resync: true`. Seqs in a pull need not be contiguous: applying a delete removes that record's earlier
  rows (the delete row stays), and a full replace removes every earlier row.
- **History id**: `workspaces.history_id uuid` names the current history. A full replace and
  `npm run server:after-restore` (run once after restoring a backup; it also moves the seq a billion
  ahead and sets `reset_seq` there) give it a new value.
- **Auth**: `users (id uuid, email text unique (stored lowercase), password_hash text, role text default
  'admin', created_at, last_login_at)`, `sessions (token_hash text primary key, user_id, created_at,
  last_seen_at, expires_at, ip, user_agent)`, `trusted_devices (token_hash text primary key, user_id,
  created_at, expires_at)` (migration 003).
- One workspace per server for now: `workspace_id = 'default'` (a `workspaces` table holds it).

## Protocol (`/api`, JSON)

All requests are same-origin (the server serves the app, or the Vite dev server proxies `/api`).
Authentication is a session cookie: random 32 bytes, stored only as a SHA-256 hash, `HttpOnly`,
`SameSite=Strict`, and ended after 12 hours idle (`SESSION_IDLE_HOURS`). Over https it is
`__Host-ft_session` with `Secure` and `Path=/`; that is whenever `PUBLIC_ORIGIN` is https, and for any
request that reached Caddy over https (`X-Forwarded-Proto` from a trusted proxy) in any case. Browsers
refuse a `__Host-` cookie with a `Domain` or another path, so no other host can plant or shadow it, not
even a sibling under a shared parent domain like `*.sslip.io` (not a public suffix); the server never
reads the plain name in that mode. Over plain http (development, an SSH tunnel) it is `ft_session` with
`Path=/api`. When a request carries the session cookie's name twice, a failed session check does not
clear it, since the parser keeps the first, possibly planted, one. How long the session lives at most
depends on **Keep me signed in** (`remember` in the login body, default `false`):

- `remember: false` (or absent): a browser-session cookie (no `Max-Age` or `Expires`, so the browser drops
  it when it closes) and an absolute expiry of 12 hours on the server, even while the session is in use.
- `remember: true`: a cookie with `Max-Age` of `SESSION_MAX_DAYS` (7 days by default) and the same absolute
  expiry on the server.

Servers from before this option ignore `remember` and always give the 7-day cookie, so a client may send
it to any server.

A successful sign-in also sets a **trusted-device** cookie (`__Host-ft_device` over https, `ft_device`
over http, same attributes, `Max-Age` 180 days; only its SHA-256 is stored), replacing the one the browser
sent. It survives sign-out and grants nothing on its own: a later sign-in that carries it for the same
login skips the email and address limits and counts against the device's own limit instead (see the login
row). A user keeps at most 20; `server:create-admin` and `server:after-restore` forget them all.

Every non-GET request must send `X-First-Twenty: 1` (CSRF guard; browsers cannot set it cross-site
without a CORS preflight, which the server refuses). It is also refused when the browser's
`Sec-Fetch-Site` says anything but `same-origin` or `none`: under a shared parent domain, a sibling host's
requests are `same-site` and carry `SameSite=Strict` cookies. Clients that send no `Sec-Fetch-Site` (curl,
scripts) are not affected, and the development origin (`ALLOWED_ORIGIN`) is exempt.

| Method and path | Body | Response |
|---|---|---|
| `GET /api/health` | | `200 {ok: true, db: 'up', version}` or `503 {ok: false, db: 'down'}`. No auth. Never leaks details. |
| `POST /api/auth/login` | `{email, password, remember?: boolean}` (body limit 8 KB) | `200 {user: {id, email, role}}` + cookie (see `remember` above); `400` when `remember` is not a boolean; `401 {error: 'invalid_credentials'}`; `429 {error: 'rate_limited', retryAfter}` (per 15 minutes: 10 attempts per client address, IPv6 per /64; 10 per email from one address, cleared by a successful sign-in; 100 failures per email from all addresses; a sign-in with a valid trusted-device cookie for this login is held to none of these, only to 10 attempts per device, cleared by a successful sign-in, so failures from many addresses cannot lock its owner out); `429 {error: 'busy', retryAfter}` when too many password checks are waiting. The email is trimmed and lowercased once, and that one string is both the rate-limit key and the lookup (never cut short). A sign-in with no password check (empty email or password, an email over 254 characters after trimming, a password over 1,024 characters, or refused as busy) counts against the client address only. Each limit keeps at most 50,000 keys in memory. The two email limits never drop a key that holds a lockout; when every key of one holds one, a sign-in that needs a new email key gets `429 rate_limited` until the oldest lockout ends (filling them takes password checks, which run two at a time). Every sign-in adds an address key, even one with no password check, so when every address key holds a lockout the oldest one is forgotten instead: cheap sign-ins from many addresses cannot lock everyone else out. |
| `POST /api/auth/logout` | | `204`, session deleted and the cookie cleared (the trusted-device cookie stays). Clients treat `204` and `401` as "no session left"; anything else (no answer, `5xx`) means the session may still be open (see Sign-out below). |
| `GET /api/auth/me` | | `200 {user}` or `401`. |
| `GET /api/workspace` | | `200 {workspaceId, historyId, seq, db, versions}` where `versions` maps `"collection:id"` to version; `404 {error: 'empty'}` before the first upload. |
| `PUT /api/workspace` | `{db, confirmReplace?: boolean}` | Replaces everything in one transaction and starts a new history. Allowed without `confirmReplace` only when the server is empty. `200 {historyId, seq, versions}`. Used for the first upload, Import and Start fresh. Body limit 10 MB. |
| `GET /api/changes?since=<seq>&history=<historyId>` | | `200 {historyId, seq, changes: Change[]}` (oldest first, at most 5,000; `more: true` when truncated) or `200 {resync: true}`, also when `history` is given and is not the current history id. `history` is optional. |
| `POST /api/changes` | `{changes: ClientChange[], historyId?}` (at most 2,000) | `200 {historyId, seq, applied: Applied[], conflicts: Conflict[]}`. Applied in one transaction; each change independently accepted or rejected. `409 {error: 'resync'}` (nothing applied) when `historyId` is given and is not the current one: load the snapshot, rebase, then push again. |

Types:

```ts
type Change = { seq: number; collection: string; id: string; op: 'upsert' | 'delete'; version: number; data?: unknown }
type ClientChange = { collection: string; id: string; op: 'upsert' | 'delete'; data?: unknown; baseVersion: number | null }
type Applied = { collection: string; id: string; version: number }
type Conflict = { collection: string; id: string; serverVersion: number | null; serverData: unknown | null }
```

Rules:

- `collection` must be a known record collection or `$doc` (with a known doc key); anything else is
  `400`. Records must have `data.id === id`. Each record is at most 256 KB.
- `baseVersion` is the version the client last saw (`null` = the client believes it is new). The server
  accepts when it matches the current version (or the record does not exist and `baseVersion` is `null`
  or the record was deleted). Otherwise it returns a conflict with the server's current copy.
- **The server wins conflicts.** The client replaces its copy with `serverData` (or removes it when
  `serverData` is null) and tells the user how many items were refreshed.
- Deletes are hard deletes in the record table plus a `delete` change in the log.
- Clients should send the `historyId` they last received with every pull and push. The server checks it
  only when it is sent, so older clients keep working; for them the seq-based versions and the
  `reset_seq` move after a restore still turn stale edits into conflicts.
- Requests that need a session are refused (`401`) before their bodies are read, and so are unknown paths
  and methods (`404 {error: 'not_found'}`). A request whose body has not arrived in full after 3 minutes
  is dropped (Node's `requestTimeout`; Caddy's `read_body` timeout matches it).

## Browser sync engine (`src/sync/**`)

- `connection` state per device (localStorage `first-twenty:sync:v1`): `{v: 1, mode: 'local' | 'server',
  workspaceId, seq, versions, outbox, rejected, lastSyncAt, user, sampleAllowed, hold, unconfirmed,
  bases, schema, storeMark, historyId}`. `bases` holds, per queued or refused key, a fingerprint of the
  server's copy the edit was made on (see Server lost its workspace). `historyId` is the server's history id from the last snapshot, replace or
  pull page (null for connections saved by older builds or servers without history ids; a pull page
  teaches it, a push answer never does). `schema` is a fingerprint of the shared collection list: a build whose list differs
  rebuilds from the server snapshot on start. `storeMark` must equal the counter in
  `first-twenty:sync:mark:v1`, written after the store is saved; when they differ (the tab died between
  the two saves) the engine also rebuilds from the snapshot before pushing. Queued edits survive both.
- **Connecting** offers "Upload this browser's workspace" (empty server, or `confirmReplace`) or "Use the
  server's copy". The sample company never syncs implicitly: loading it over a synced workspace puts the
  connection on **hold** (`'sample'`), and undoing back to the synced workspace resumes. Other holds:
  `'server_empty'` (the server lost its workspace, see below), `'replaced'` (the store swapped workspaces
  outside `replaceWorkspace()`) and `'demo_clock'` (see Demo clock). After Upload, Use the server's copy
  and a connected replace, the Undo history is cleared, so no step from before can swap the old workspace
  back over the server.
- **Server lost its workspace** (`'server_empty'`: a push or pull answered `404 empty`, after a database
  reset or a restore from an empty backup): nothing is pushed or pulled, but edits keep queueing (and so do
  changes applied on load), so they count as pending and survive a reload. The engine looks at the server
  again on start, on window focus and on `online` (never on a timer). Once another computer has uploaded:
  the same workspace (`isWorkspaceSwap` false) is joined. The base versions of queued and refused edits
  belong to the copy the server lost, so each key is compared by content instead (`bases`): where the
  uploaded record is still the one the edit was made on, the edit stays on top and goes out on the
  server's current version; where it differs (another computer changed it, before the reset or during the
  hold), the server wins as in any conflict, the edit is dropped and the record counts in `refreshed`.
  Keys queued by older builds have no fingerprint and stay on top. A different workspace is taken whole, as under Replaced
  from another computer. `uploadLocal()` from this hold that gets `409 not_empty` does the same look and
  resolves `{ok: true, message}` (`JOINED_MESSAGE` or `SWITCHED_MESSAGE`). `useServerCopy()` from this hold
  joins the same workspace with the queued edits; for a different one it answers kind `'pending'` while
  edits are queued (`discardPending` then replaces). Settings > Server offers Upload, and after a
  `not_empty` it could not resolve, Use the server's copy and Replace the server's workspace.
- **Demo clock** ('Pretend today is', Settings > Data; `clockOverride` option, the app passes
  `getClockOverride`): a pretend date applies job changes and hand-offs that are not due yet when the
  page loads, marks them applied on that date and saves them, and activity rows get pretend timestamps.
  None of it may reach the server, so while the clock is on the connection holds (`'demo_clock'`): start
  queues nothing (no baseline diff) and fixes the queued entries with the data saved before that load,
  edits are not queued, nothing is pushed or pulled, and `uploadLocal`, `useServerCopy` and a connected
  `replaceWorkspace` refuse with kind `'demo_clock'` (`CLOCK_MESSAGE`). Decision: the records the pretend
  date touched (comp rows marked applied on a future date, the people they changed, hand-off
  reassignments) and edits made while pretending cannot be told apart from real data record by record, so
  none of them is kept; the promotion then takes effect on its real date like any other.
  The way back: the first start on a pretend date saves the workspace as saved before that load, with the
  connection as it was, under `first-twenty:sync:clock:v1`. It is kept apart from the connection, so a tab
  that stayed on the real date and saves its connection cannot erase it, and it is never replaced while it
  exists (a later pretend load already shows pretend data); a tab still pretending saves it again if
  another tab used it up. Going back to the real date reloads the page, and start rebuilds from that copy
  before the store is shown or anything is sent, even offline: the store and connection are as they were
  before the pretend date (queued edits included, on their old base versions, so a newer server copy still
  wins), changes due by the real date are applied and queued, the Undo history is cleared, and the copy is
  removed once the rebuilt store is saved. The next cycle catches up with the server the usual way.
  Without a usable copy (the browser refused to save it, or a hold from an older build), the hold stays
  shown, edits are not queued and `uploadLocal` refuses (`LEAVING_CLOCK_MESSAGE`) until the server's copy
  has replaced the store (edits queued before the clock was set and refused ones go back on top);
  Settings > Server says so. A browser that is not connected keeps what the pretend date applied (nothing
  to rebuild from), which the panel says.
- **Workspace identity**: `meta.workspaceId` (optional, `ws-<random>`) names one workspace. The engine sets
  it when a workspace is created through `replaceWorkspace()` (Start fresh, or Import of a backup without
  one; a backup that has one keeps it) and when a workspace without one is uploaded. It syncs like the rest
  of `meta` and is never set on load (`migrate`), so every copy of a workspace carries the same id.
  `isWorkspaceSwap(prev, next)` compares ids when either side has one (one with and one without counts as
  different), else the creation date and the sample flag (which two workspaces made the same day share).
- **Diff**: after every store change, compare the previous and next `DB` (Immer keeps unchanged
  objects identical): for each collection whose array changed, records added or replaced become upserts and
  records gone become deletes; changed documents become `$doc` upserts. Pure function `diffDB(prev, next)`.
  Changes the store applies on load (effective-dated job changes, hand-offs) are diffed against the saved
  copy and pushed too; the activity rows they log get content-based ids (`act-auto-<hash>`) so every
  device writes the same row.
- **Outbox**: one entry per `collection:id` holding keys only (`{collection, id, op, rev}`); the data is
  read from the store when the push goes out (entries keep their data, `fixed`, only while a hold shows
  another workspace). Pushed after 800 ms of quiet, or at once with `keepalive` when the page is hidden.
  Failed pushes retry with backoff (2 s doubling to 60 s); the `online` event retries at once. Batches stay
  under 2,000 changes and about 900 KB. Nothing is lost when offline.
- **Unanswered pushes**: before each push the engine notes, per record, the base version and a fingerprint
  of what it sent (`unconfirmed`). If the answer is lost and a later push on the same base conflicts with a
  server copy that matches one of those fingerprints at a newer version, the engine treats it as its own
  write and rebases on it. Versions are workspace-wide seqs, so that write is rarely at base + 1 (another
  record in the batch, the activity row each edit logs, another device): only the order is checked, and
  the fingerprint is the evidence. The test server (`src/sync/testing/fakeServer.ts`) numbers versions the
  same way.
- **Refused changes**: a batch the server refuses with `400`/`413` is halved until the bad change is found;
  that change is set aside in `rejected` (still counted as pending; `retryRejected()` puts it back).
  After 3 refusals in a row the engine stops and backs off as a server error.
- **Pull**: every 30 seconds while visible, on window focus and after each push; applies remote changes
  straight into the store with `useDB.setState` (not through `mutate`, so they do not become Undo steps),
  updating `versions` and `seq`. Changes that echo this device's own pushes are skipped by version. A
  record with a queued or refused local change is never overwritten by a pull. `resync: true` rebuilds
  from the snapshot. The client sends its `historyId` with every pull (`&history=`) and push (body), so
  after a replace or restore a push is refused whole (`409 resync`): the engine loads the snapshot first,
  then pushes what is left.
- **Replaced from another computer**: when a rebuild from the snapshot finds a different workspace (another
  history, or one it cannot compare, and `isWorkspaceSwap` is true), the engine takes the server's
  workspace whole (no merge, Undo history cleared, queued and refused edits dropped from the outbox) and
  keeps what this browser showed in memory. The status gets `replacedRemotely: {companyName, previousName,
  at}`; `getReplacedBackup()` returns the copy for a backup download and `clearReplacedRemotely()` lets it
  go. The header shows a role=alert notice with Download backup, Copy backup and Dismiss. The same
  history (a pruned log) or the same workspace (a restore) rebases as before, keeping queued edits.
- **Replacing everything** (Import, Start fresh): `replaceWorkspace(db)` sends `PUT /api/workspace` with
  `confirmReplace` and only then sets the store; on failure nothing changes. Not connected, it is
  `useDB.replace`.
- **Sign-out**: `signOut()` keeps the offline copy and resolves `{ok: true, confirmed, message}`. The
  session cookie is `HttpOnly`, so only the server can end it: when `POST /api/auth/logout` gets no `204`
  or `401` (offline, `5xx`), `confirmed` is false and the engine writes `first-twenty:logout-pending`. While
  that key exists the engine never resumes from the cookie (focus, start, `checkServer`, other tabs), the
  connect flows answer `signed_out`, `checkServer` reports `signedIn: false`, and the engine posts the logout
  again on start, on focus, when the page is shown and on `online` until the server answers; a successful
  sign-in removes the key too (the server drops the old session on every sign-in). `disconnect()` does
  the same and resolves `{ok: true, confirmed, message}`; the key outlives the cleared connection, so
  `initSync()` starts the engine for it even in a browser that is local only now.
  `signOut({forgetThisBrowser: true})` sends queued changes first (counting any another tab saved), then
  needs the server to end the session: if it cannot, nothing is removed and the result is kind
  `'session_open'` (`SESSION_OPEN_MESSAGE`), unless `keepServerSession` is set (then the data goes, the key
  is written after the wipe, and the session stays valid until this browser reaches the server again).
  Otherwise it removes every `first-twenty:` localStorage key and reloads; if changes are still queued it
  removes nothing and returns kind `'pending'` (unless `discardPending`).
- **Other tabs**: removing this browser's data posts `{type: 'forget'}` on the BroadcastChannel
  `first-twenty`, and every other tab also sees the storage events. A tab whose workspace key is removed
  (only this flow removes it; a `clear()` by another page on a shared origin is ignored, since this tab's
  copy may be the last one) stops its engine without saving again (`dropLocal()`), puts the sample in
  its store, removes what it may have written meanwhile (keeping a pending sign-out) and reloads. A tab
  whose sync key is removed while the workspace stays (Disconnect elsewhere) stops syncing without writing
  its connection back (`disconnectedElsewhere()`). A tab that finds `first-twenty:logout-pending` set when
  it is about to sync treats itself as signed out and helps end the session.
- **Status** (zustand store `useSyncStatus`): `status: 'local' | 'synced' | 'syncing' | 'offline' |
  'signed_out' | 'error'`, plus `mode`, `pending`, `rejected`, `lastSyncAt`, `lastError`, `nextRetryAt`,
  `user`, `hold`, `refreshed` (items the server's copy replaced), `storageFull` (the browser refused to
  save changes that have not reached the server; the page then warns before closing), `logoutPending` (a
  sign-out the server has not confirmed yet) and `replacedRemotely` (see above). `hold` is one of
  `'sample' | 'server_empty' | 'replaced' | 'demo_clock'` (status `'local'` while it is set). The UI shows
  it; the engine never renders UI.
- Undo keeps working: undoing produces a store change, which the diff turns into ordinary changes. Remote
  changes are applied to the Undo history too, so Undo only reverts this user's own edits.
- **Wiring** (done): `src/main.tsx` calls `initSync()` before the first render; Settings > Data calls
  `replaceWorkspace(db, label)` for Import and Start fresh; Settings > Server (`#settings.server`,
  `src/features/settings/ServerTab.tsx`) uses `connect.*` (`connect.signIn(email, password, {remember})`
  sends Keep me signed in; `remember` defaults to false), `signOut`, `disconnect`, `syncNow`, shows
  `res.message` after Sign out and Disconnect, and offers "Remove anyway" (`keepServerSession: true`) after
  kind `'session_open'`. Its hold panel shows the result's `message` when Upload joined or switched, and
  offers Go back to the real date for `'demo_clock'` (once back on the real date with no copy to rebuild
  from, it says this browser waits for the server's copy and that changes made until then are not kept); Settings > Data's Pretend today is says, while
  connected, that a pretend date pauses syncing (a second click confirms) and that going back takes the
  server's copy. The header chip, the sync banners and the rail note (`src/app/Header.tsx`,
  `Shell.tsx`) show `useSyncStatus`. Removing this browser's data calls `stopPersisting()` from
  `@/store/db` first, so the store never writes a workspace back on the way to the reload.
- Known limit: two tabs of one browser each run an engine on the same localStorage key; the saved outbox
  is last-writer-wins between them (a Web Locks leader tab would fix it). Removing this browser's data
  stops the other tabs (see Other tabs), but changes another tab queued and never saved are lost with it.

## Security rules

- Never put secrets in the repo or the app bundle. The server reads `DATABASE_URL` and other settings
  from environment variables (`/etc/first-twenty/env` on EC2, `.env` locally; `.env` is git-ignored).
- Passwords are hashed with scrypt (`node:crypto`, N=2^15, r=8, p=1, 16-byte salt); compared in constant
  time. The admin is created from the command line (`npm run server:create-admin -- --email you@company.com`),
  which asks for the password without echoing it. At most two password checks run at once (16 may wait).
- SQL uses parameters only; table names come from the collection whitelist, never from input.
- Security headers on every response (CSP for the served app, `X-Content-Type-Options`, `Referrer-Policy`,
  `Frame-Options`); no CORS by default (`ALLOWED_ORIGIN` only for development). The app's CSP allows its
  inline scripts by SHA-256 hash (computed from `APP_FILE` at startup, which is then served from memory),
  never `'unsafe-inline'` for scripts.
- Every `/api` route sits in one Fastify plugin whose hooks (CSRF header, cross-site refusal,
  `Cache-Control: no-store`) apply by route match, so percent-encoded paths get the same guards. Never
  relax the CSRF header: on a shared parent domain such as `*.sslip.io`, `SameSite` treats every sibling
  host as the same site, so the header (with the `Sec-Fetch-Site` check) is what keeps their pages from
  writing.
- Session and trusted-device cookies are `__Host-` cookies over https (see Protocol). Every https response
  carries HSTS once: the server sends it, and Caddy sets it again in place of the server's copy, so it is
  there even when `PUBLIC_ORIGIN` was left at http.
- Logs never include request bodies, cookies or passwords.
