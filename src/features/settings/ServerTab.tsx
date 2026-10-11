// Settings > Server (#settings.server): connect this browser to the company's own First Twenty server.
// Opened from a file or inside the claude.ai artifact viewer, or where no server answers, it explains
// what the server is and how to set it up (docs/SERVER.md), with no sign-in form and no network call.
// Where a server answers it walks through sign-in, then Upload or Use the server's copy, and once
// connected shows the live sync status (useSyncStatus) with Sync now, Sign out and Disconnect.
import type { ReactNode } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { replaceRoute, useRoute } from '@/app/router'
import { fmtDateTime, fmtTime } from '@/lib/dates'
import {
  clearRefreshed,
  connect,
  disconnect,
  retryRejected,
  signOut,
  STORAGE_FULL_MESSAGE,
  syncNow,
  type SyncUser,
  useSyncStatus,
} from '@/sync'
import { Badge, Button, Callout, ConfirmButton, DescriptionList, Icon, Panel, toast } from '@/ui'
import { downloadBackup, StartFreshSheet } from './DataTab'
import { focusPanelTitle, focusSignInField } from './serverFocus'
import { Row, RowList } from './kit'
import {
  agoText,
  checkFailureText,
  classifyCheckFailure,
  detectHostContext,
  plural,
  retryIn,
  serverAddress,
  statusView,
} from './serverLogic'
import {
  BusyNote,
  busyText,
  ConnectPanel,
  connectedToast,
  FlowError,
  HoldPanel,
  SignInPanel,
  useBusy,
} from './serverParts'

type Check = { kind: 'checking' } | { kind: 'missing' } | { kind: 'unreachable'; message: string } | { kind: 'ready' }

function pageOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin
}

/** What Sync now ended with, read out after the button is pressed. */
function syncResultText(s: ReturnType<typeof useSyncStatus.getState>): string {
  switch (s.status) {
    case 'synced':
      if (s.rejected > 0) return 'Synced, except some changes your server refused. See below.'
      return s.lastSyncAt ? `Synced at ${fmtTime(s.lastSyncAt)}.` : 'Synced.'
    case 'offline':
      return 'Sync did not finish: your server cannot be reached right now. Changes stay in this browser.'
    case 'signed_out':
      return 'Sync did not finish: sign in again first.'
    case 'syncing':
      return 'Still sending changes. They go out on their own.'
    case 'error':
      return `Sync did not finish. ${s.lastError ?? ''}`.trim()
    case 'local':
      return statusView(s).sentence
  }
}

/** Re-renders every 15 seconds, for "4 minutes ago" and "next try in 30 seconds". */
function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function ServerTab() {
  const route = useRoute()
  const wantsFresh = route.segments[2] === 'fresh'
  const host = useMemo(detectHostContext, [])
  const mode = useSyncStatus((s) => s.mode)
  const hold = useSyncStatus((s) => s.hold)
  const status = useSyncStatus((s) => s.status)
  const statusUser = useSyncStatus((s) => s.user)
  const [check, setCheck] = useState<Check>(host === 'web' ? { kind: 'checking' } : { kind: 'missing' })
  const [session, setSession] = useState<SyncUser | null>(null)
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const runCheck = useCallback(
    async (focusAfter = false) => {
      // Never a network call where no server can live at this origin (a file, the artifact viewer).
      if (host !== 'web') return
      setCheck({ kind: 'checking' })
      const res = await connect.checkServer()
      if (res.ok) {
        setCheck({ kind: 'ready' })
        setSession(res.signedIn ? res.user : null)
        setNeedsSignIn(!res.signedIn)
      } else {
        const online = typeof navigator === 'undefined' ? true : navigator.onLine
        setCheck(
          classifyCheckFailure(res.kind) === 'missing'
            ? { kind: 'missing' }
            : { kind: 'unreachable', message: checkFailureText(res, online, pageOrigin()) },
        )
      }
      if (focusAfter) focusPanelTitle(res.ok ? (res.signedIn ? 'server-connect' : 'server-signin') : 'server-unreachable')
    },
    [host],
  )

  useEffect(() => {
    void runCheck()
  }, [runCheck])

  // Arriving from somewhere else (the banner's Sign in, the header chip, Settings, Data) leaves focus on
  // that link, far from what needs doing. Once the tab knows its state, focus moves to the next step:
  // the sign-in form's next field, or the title of a paused connection or of refused changes. Arriving
  // by the settings tab strip keeps focus on the tab, as tabs do, and so does the Start fresh sheet.
  const rejected = useSyncStatus((s) => s.rejected)
  const arrival = useRef<{ pending: boolean } | null>(null)
  useLayoutEffect(() => {
    if (arrival.current) return
    arrival.current = { pending: !wantsFresh && !document.activeElement?.closest('.ft-tabs-wrap') }
  }, [wantsFresh])
  const settled = mode === 'server' || host !== 'web' || check.kind !== 'checking'
  const signInShown = mode === 'server' ? status === 'signed_out' || needsSignIn : check.kind === 'ready' && (!session || !statusUser)
  useEffect(() => {
    const a = arrival.current
    if (!a?.pending || !settled) return
    a.pending = false
    if (signInShown) focusSignInField()
    else if (mode === 'server' && hold) focusPanelTitle('server-hold')
    else if (mode === 'server' && rejected > 0) focusPanelTitle('server-status')
  }, [settled, signInShown, mode, hold, rejected])

  const toSignIn = (text: string | null) => {
    setSession(null)
    setNeedsSignIn(true)
    setNotice(text)
    focusPanelTitle('server-signin')
  }

  const signedIn = (user: SyncUser) => {
    setSession(user)
    setNeedsSignIn(false)
    setNotice(null)
  }

  let content: ReactNode
  if (mode === 'server') {
    const showSignIn = signInShown
    const email = statusUser?.email ?? session?.email ?? null
    content = (
      <>
        {showSignIn && (
          <SignInPanel
            id="server-signin"
            title="Sign in to keep syncing"
            subtitle={
              notice ??
              'Your session on the server ended. Keep working: this browser keeps an offline copy and holds your changes until you sign in.'
            }
            // After a deliberate sign-out the engine forgets the user; SignInPanel falls back to the remembered email.
            defaultEmail={email ?? undefined}
            onSignedIn={(user) => {
              signedIn(user)
              toast({ text: 'Signed in. Syncing again.' })
              focusPanelTitle('server-status')
            }}
          />
        )}
        {hold && (
          <HoldPanel
            hold={hold}
            onSignedOut={() => toSignIn('Your session on the server ended. Sign in, then choose again.')}
            onResumed={(text) => {
              toast({ text })
              focusPanelTitle('server-status')
            }}
          />
        )}
        <StatusPanel email={showSignIn ? null : email} />
        <AccountPanel
          signedOut={showSignIn}
          onSignedOut={(message) => {
            // The engine's message says whether the server confirmed the sign-out (LOGOUT_PENDING_MESSAGE when not).
            toast({ text: message })
            toSignIn('You signed out. This browser keeps an offline copy; changes you make wait here until you sign in again.')
          }}
          onDisconnected={(message) => {
            toast({ text: message })
            toSignIn(null)
          }}
        />
      </>
    )
  } else if (host !== 'web') {
    content = <Explainer reason={host} />
  } else if (check.kind === 'checking') {
    content = (
      <Panel id="server-checking" title="Looking for your server" icon="globe">
        <p role="status" className="text-[14.5px] text-ink-2">
          Checking for a First Twenty server at {serverAddress(pageOrigin())}.
        </p>
      </Panel>
    )
  } else if (check.kind === 'missing') {
    content = <Explainer reason="missing" />
  } else if (check.kind === 'unreachable') {
    content = (
      <>
        <Panel id="server-unreachable" title="No working server here right now" icon="alert">
          <div className="flex flex-col gap-3">
            <div role="alert">
              <Callout tone="warn">{check.message}</Callout>
            </div>
            <div>
              <Button icon="rotate-ccw" onClick={() => void runCheck(true)}>
                Check again
              </Button>
            </div>
          </div>
        </Panel>
        <Explainer reason="unreachable" />
      </>
    )
  } else if (!session || !statusUser) {
    // statusUser drops to null the moment the engine ends the session (Disconnect, Sign out), before
    // this component hears back, so the connect step never flashes up (and never inspects) signed out.
    content = (
      <SignInPanel
        id="server-signin"
        title="Sign in to your server"
        subtitle={notice ?? `A First Twenty server answers at ${serverAddress(pageOrigin())}. Sign in with its admin login to choose what syncs.`}
        onSignedIn={(user) => {
          signedIn(user)
          focusPanelTitle('server-connect')
        }}
      />
    )
  } else {
    content = (
      <ConnectPanel
        email={session.email}
        onConnected={(how) => {
          connectedToast(how)
          focusPanelTitle('server-status')
        }}
        onSignedOut={() => toSignIn('Signed out. Sign in again to choose what syncs.')}
      />
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {content}
      {wantsFresh && (
        <StartFreshSheet
          onClose={() => replaceRoute('settings', 'server')}
          onDone={() => focusPanelTitle(useSyncStatus.getState().mode === 'server' ? 'server-status' : 'server-connect')}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Connected: status and account
// ---------------------------------------------------------------------------------------------

function StatusPanel({ email }: { email: string | null }) {
  const s = useSyncStatus()
  const now = useNow()
  const view = statusView(s)
  const { busy, run } = useBusy()
  // What the last Sync now (or Retry) ended with, and the state it described. Once the state moves on
  // (back online, signed in again, refusals cleared) the line would contradict the badge, so it goes.
  const [result, setResult] = useState<{ text: string; state: string } | null>(null)
  const stateKey = (x: { status: string; rejected: number }) => `${x.status}:${x.rejected > 0}`
  const current = stateKey(s)
  useEffect(() => {
    if (!busy && result && result.state !== current) setResult(null)
  }, [busy, result, current])
  const syncBtn = useRef<HTMLButtonElement>(null)
  const retry = retryIn(s.nextRetryAt, now)
  const ago = agoText(s.lastSyncAt, now)

  /** Sync now, then say how it went. `first` runs before the sync (Retry puts refused changes back). */
  const doSync = async (first?: () => void) => {
    if (busy) return
    setResult(null)
    await run('sync', async () => {
      first?.()
      await syncNow()
    })
    const after = useSyncStatus.getState()
    setResult({ text: syncResultText(after), state: stateKey(after) })
  }

  /** The button that removed itself is gone: land on Sync now (or the panel title while paused). */
  const afterRemoved = () => {
    setTimeout(() => {
      if (syncBtn.current?.isConnected) syncBtn.current.focus()
      else focusPanelTitle('server-status')
    }, 0)
  }

  return (
    <Panel
      id="server-status"
      title="Sync status"
      icon="globe"
      actions={
        !s.hold && (
          <Button ref={syncBtn} icon="rotate-ccw" onClick={() => void doSync()} aria-disabled={busy ? true : undefined}>
            {busy ? 'Syncing' : 'Sync now'}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Badge tone={view.tone} icon={view.icon} className="text-[13.5px]">
            {view.word}
          </Badge>
          <span className="min-w-0 text-[14.5px] text-ink">{view.sentence}</span>
        </div>
        <p role="status" className={result || busy ? 'text-[13.5px] text-ink-2' : 'sr-only'}>
          {busy ? busyText(busy) : (result?.text ?? '')}
        </p>
        <DescriptionList
          items={[
            { label: 'Server', value: serverAddress(pageOrigin()) },
            { label: 'Signed in as', value: email ?? 'Not signed in' },
            {
              label: 'Last synced',
              value: s.lastSyncAt ? `${fmtDateTime(s.lastSyncAt)}${ago ? ` (${ago})` : ''}` : 'Not yet',
            },
            {
              label: 'Changes waiting in this browser',
              value:
                s.pending + s.rejected === 0
                  ? 'None'
                  : [s.pending > 0 && plural(s.pending, 'change to send', 'changes to send'), s.rejected > 0 && `${s.rejected} refused`]
                      .filter(Boolean)
                      .join(', '),
            },
            { label: 'Next try', value: retry ? `Automatically ${retry}` : '', hidden: !retry },
          ]}
        />
        {/* Callout buttons sit under the text, never beside it, so a phone keeps full-width lines. */}
        {s.storageFull && (
          <Callout tone="bad" title="This browser is not saving">
            <p>{STORAGE_FULL_MESSAGE}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" icon="download" onClick={() => downloadBackup()}>
                Download backup
              </Button>
            </div>
          </Callout>
        )}
        {s.lastError && !s.storageFull && s.status === 'error' && (
          <Callout tone="bad" title="Your server reported a problem">
            {s.lastError}
            {retry ? ` Next try ${retry}, or press Sync now.` : ''}
          </Callout>
        )}
        {s.refreshed > 0 && (
          <Callout tone="accent" icon="rotate-ccw" title={`${plural(s.refreshed, 'item was', 'items were')} refreshed from your server`}>
            <p>
              {s.refreshed === 1 ? 'It was' : 'They were'} changed on another computer at the same time as here, and the server's version wins.
              This browser now shows what your server has, so check recent records if something you typed is missing.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  clearRefreshed()
                  afterRemoved()
                }}
              >
                Dismiss
              </Button>
            </div>
          </Callout>
        )}
        {s.rejected > 0 && (
          // Counts are saved records, and one edit can save two (the record and its activity log entry),
          // so the title says "some changes" and the number is explained where it appears.
          <Callout tone="bad" title="Your server refused some changes">
            <p>
              {plural(s.rejected, 'saved record stays', 'saved records stay')} in this browser and still {s.rejected === 1 ? 'counts' : 'count'}{' '}
              as waiting. One edit can save more than one record, such as the record and its activity log entry. A server refuses what it
              cannot accept, such as a very long note. Retry sends {s.rejected === 1 ? 'it' : 'them'} again. If the server keeps refusing,
              download a backup and ask whoever runs the server to check its log.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                icon="rotate-ccw"
                onClick={() =>
                  void doSync(() => {
                    retryRejected()
                    afterRemoved()
                  })
                }
                aria-disabled={busy ? true : undefined}
              >
                Retry
              </Button>
              <Button size="sm" variant="ghost" icon="download" onClick={() => downloadBackup()}>
                Download backup
              </Button>
            </div>
          </Callout>
        )}
      </div>
    </Panel>
  )
}

function AccountPanel({
  signedOut,
  onSignedOut,
  onDisconnected,
}: {
  signedOut: boolean
  onSignedOut: (message: string) => void
  onDisconnected: (message: string) => void
}) {
  const waiting = useSyncStatus((s) => s.pending + s.rejected)
  const { busy, run } = useBusy()
  const [error, setError] = useState<{ message: string; n: number } | null>(null)
  const [forgetBlocked, setForgetBlocked] = useState<{ message: string; n: number } | null>(null)
  // The server could not end the session, so nothing was removed (kind 'session_open').
  const [sessionOpen, setSessionOpen] = useState<{ message: string; n: number; discardPending: boolean } | null>(null)
  const [disconnectBlocked, setDisconnectBlocked] = useState<{ message: string; n: number } | null>(null)
  const guard = busy ? { 'aria-disabled': true as const } : {}

  const doSignOut = async () => {
    const res = await run('signout', () => signOut())
    if (!res) return
    if (res.ok) onSignedOut(res.message)
    else setError({ message: res.message, n: Date.now() })
  }
  const doForget = async (discardPending: boolean, keepServerSession = false) => {
    setDisconnectBlocked(null)
    setSessionOpen(null)
    setError(null)
    const res = await run('forget', () => signOut({ forgetThisBrowser: true, discardPending, keepServerSession }))
    if (!res || res.ok) return // the page reloads once this browser's data is gone
    if (res.kind === 'pending') setForgetBlocked({ message: res.message, n: Date.now() })
    else if (res.kind === 'session_open') {
      setForgetBlocked(null)
      setSessionOpen({ message: res.message, n: Date.now(), discardPending })
    } else setError({ message: res.message, n: Date.now() })
  }
  const doDisconnect = async (discardPending: boolean) => {
    setForgetBlocked(null)
    setSessionOpen(null)
    setError(null)
    const res = await run('disconnect', () => disconnect({ discardPending }))
    if (!res) return
    if (res.ok) onDisconnected(res.message)
    else if (res.kind === 'pending') setDisconnectBlocked({ message: res.message, n: Date.now() })
    else setError({ message: res.message, n: Date.now() })
  }

  return (
    <Panel id="server-account" title="Sign out or disconnect" icon="log-out">
      <div className="flex flex-col gap-3">
        <RowList label="Sign out or disconnect">
          {!signedOut && (
            <Row
              title="Sign out"
              meta="Ends your session on the server. This browser keeps an offline copy you can keep working in; changes wait here and sync when you sign in again."
              actions={
                <Button icon="log-out" onClick={() => !busy && void doSignOut()} {...guard}>
                  Sign out
                </Button>
              }
            />
          )}
          <Row
            title="Sign out and remove data from this browser"
            meta={
              <>
                For shared computers. Sends waiting changes first, then removes the workspace, the sync state and display preferences from
                this browser and reloads the page. Your server keeps everything that reached it.
                {waiting > 0 && (
                  <span className="mt-1 flex items-start gap-1.5 font-semibold text-warn">
                    <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
                    {plural(waiting, 'change has', 'changes have')} not reached the server yet.
                  </span>
                )}
              </>
            }
            actions={
              <ConfirmButton icon="trash" confirmLabel="Click again to remove this browser's data" onConfirm={() => !busy && void doForget(false)} {...guard}>
                Sign out and remove data
              </ConfirmButton>
            }
          />
          <Row
            title="Disconnect"
            meta="Stop syncing and go back to local only. This also signs you out. The workspace stays in this browser and your server keeps its copy. You can connect again any time."
            actions={
              <Button icon="x" onClick={() => !busy && void doDisconnect(false)} {...guard}>
                Disconnect
              </Button>
            }
          />
        </RowList>
        {forgetBlocked && waiting > 0 && (
          <div role="alert" key={forgetBlocked.n}>
            <Callout tone="bad" title="Nothing was removed">
              <p>{forgetBlocked.message}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button icon="rotate-ccw" onClick={() => !busy && void syncNow()} {...guard}>
                  Sync now
                </Button>
                <ConfirmButton icon="trash" confirmLabel="Click again to lose them" onConfirm={() => !busy && void doForget(true)} {...guard}>
                  Remove anyway and lose {waiting === 1 ? 'it' : 'them'}
                </ConfirmButton>
              </div>
            </Callout>
          </div>
        )}
        {sessionOpen && (
          <div role="alert" key={sessionOpen.n}>
            <Callout tone="bad" title="Nothing was removed">
              <p>{sessionOpen.message}</p>
              <p className="mt-1">
                Removing anyway clears this browser now, but its session on your server stays valid until this browser reaches the server
                again, or until the session goes 12 hours unused.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <ConfirmButton
                  icon="trash"
                  confirmLabel="Click again to remove this browser's data"
                  onConfirm={() => !busy && void doForget(sessionOpen.discardPending, true)}
                  {...guard}
                >
                  Remove anyway
                </ConfirmButton>
              </div>
            </Callout>
          </div>
        )}
        {disconnectBlocked && waiting > 0 && (
          <div role="alert" key={disconnectBlocked.n}>
            <Callout tone="warn" title="Still connected">
              <p>{disconnectBlocked.message}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button icon="rotate-ccw" onClick={() => !busy && void syncNow()} {...guard}>
                  Sync now
                </Button>
                <ConfirmButton icon="x" confirmLabel="Click again to disconnect" onConfirm={() => !busy && void doDisconnect(true)} {...guard}>
                  Disconnect anyway
                </ConfirmButton>
              </div>
            </Callout>
          </div>
        )}
        <FlowError error={error} title="That did not work" />
        <BusyNote text={busyText(busy)} />
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// No server here: what the server is and how to set it up (docs/SERVER.md in short)
// ---------------------------------------------------------------------------------------------

const SETUP_STEPS: Array<{ title: string; body: ReactNode }> = [
  {
    title: 'Get an EC2 instance with Postgres',
    body: (
      <>
        Postgres 13 or newer on Amazon Linux 2023 or Ubuntu, an Elastic IP, and a domain such as hr.example.com pointed at it. Open ports 443
        and 80 to everyone, 22 to your own address only, and never 5432.
      </>
    ),
  },
  {
    title: 'Create the database roles',
    body: (
      <>
        Run <Code>server/deploy/postgres-setup.sql</Code> as the Postgres superuser. It makes the first_twenty database and two logins
        that can only use it.
      </>
    ),
  },
  {
    title: 'Copy the code and run the setup script',
    body: (
      <>
        Clone or copy First Twenty to the instance, then from its folder run{' '}
        <Code>sudo bash server/deploy/setup-ec2.sh --domain hr.example.com</Code>. It installs Node.js, Caddy for HTTPS, the service and
        nightly backups, and leaves the code in /opt/first-twenty.
      </>
    ),
  },
  {
    title: 'Fill in the settings file',
    body: (
      <>
        Put the two database passwords in <Code>/etc/first-twenty/env</Code>. Only root can read it.
      </>
    ),
  },
  {
    title: 'Build and create your admin login',
    body: (
      <>
        In /opt/first-twenty, run these one at a time, with your own email in the last one: <CommandList
          commands={[
            'npm ci',
            'npm run build:all',
            'bash server/deploy/with-env.sh npm run server:migrate',
            'bash server/deploy/with-env.sh npm run server:create-admin -- --email you@company.com',
          ]}
        />
        The last one asks for the admin password twice. That one login protects the data.
      </>
    ),
  },
  {
    title: 'Start the server and bring your data',
    body: (
      <>
        Restart the first-twenty service and open https://your-domain. Download a backup here, import it there in Settings, Data, then sign
        in under Settings, Server and choose Upload this browser's workspace.
      </>
    ),
  },
]

function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[12.5px] break-words text-ink">{children}</code>
}

/** Commands to type, one per line, exactly as the server guide gives them (copy-paste works). */
function CommandList({ commands }: { commands: string[] }) {
  return (
    <ul className="my-1.5 flex flex-col gap-1" aria-label="Commands">
      {commands.map((c) => (
        <li key={c} className="rounded bg-surface-2 px-2 py-1">
          <Code>{c}</Code>
        </li>
      ))}
    </ul>
  )
}

function Explainer({ reason }: { reason: 'file' | 'artifact' | 'missing' | 'unreachable' }) {
  // A server that is only down right now needs no new setup: the steps stay behind a button there.
  const [showSetup, setShowSetup] = useState(reason !== 'unreachable')
  const where: Record<typeof reason, string | null> = {
    file: 'This copy was opened from a file on this computer, so it has no server to sync with.',
    artifact: 'This copy runs inside the claude.ai artifact viewer, so it has no server to sync with.',
    missing: `No First Twenty server answers at ${serverAddress(pageOrigin())}.`,
    unreachable: null,
  }
  const lead = where[reason]
  return (
    <>
      <Panel
        id="server-about"
        title="Sync with your own server"
        icon="globe"
        subtitle="Optional. First Twenty works fully in this browser without one."
      >
        <div className="flex flex-col gap-4">
          {lead && (
            <Callout tone="neutral" title={lead}>
              Syncing works when the app is opened from your First Twenty server's address, such as <strong>https://your-domain</strong>. Open
              that address, sign in under Settings, Server, and every change syncs from then on.
            </Callout>
          )}
          <p className="max-w-[75ch] text-[14.5px] text-ink">
            The First Twenty server is a small program that runs next to your Postgres database on an Amazon EC2 instance and serves this same
            app at your own address. With it, every change goes into your database, any computer you sign in from sees the same data, and the
            database is backed up every night. Offline keeps working: the browser keeps its own copy, holds changes and catches up when the
            connection returns. One admin login protects the data.
          </p>
          {reason === 'unreachable' && (
            <div>
              <Button
                variant="ghost"
                icon={showSetup ? 'chevron-up' : 'chevron-down'}
                aria-expanded={showSetup}
                aria-controls={showSetup ? 'server-setup' : undefined}
                onClick={() => setShowSetup((v) => !v)}
              >
                {showSetup ? 'Hide the setup steps' : 'Set up a server'}
              </Button>
            </div>
          )}
        </div>
      </Panel>
      {showSetup && (
        <Panel
          id="server-setup"
          title="Set up your server"
          icon="settings"
          subtitle="About an hour the first time. The full guide, with every command, is docs/SERVER.md in the First Twenty code."
        >
          <div className="flex flex-col gap-4">
            <ol className="flex flex-col gap-3.5" aria-label="Setup steps">
              {SETUP_STEPS.map((step, i) => (
                <li key={step.title} className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="ft-checkmark ft-checkmark--open num inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[13px] font-bold text-ink-2"
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14.5px] font-bold text-ink">
                      <span className="sr-only">Step {i + 1}: </span>
                      {step.title}
                    </p>
                    <div className="max-w-[75ch] text-[13.5px] text-ink-2">{step.body}</div>
                  </div>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-4">
              <Button icon="download" onClick={() => downloadBackup()}>
                Download a backup to bring along
              </Button>
              <span className="text-[13px] text-ink-3">
                Opened from your server's address, the app starts with the sample company, so bring this backup and import it there.
              </span>
            </div>
          </div>
        </Panel>
      )}
    </>
  )
}
