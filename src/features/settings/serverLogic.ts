// Pure helpers for Settings > Server: where the app is running, what a server check means, how to word
// the sync status, and how this browser's workspace compares with the server's. No DOM, no store.
import type { HoldReason } from '@/sync'
import type { IconName, Tone } from '@/ui'

/** Where this copy of the app runs. Only 'web' can have a First Twenty server at its own origin. */
export type HostContext = 'file' | 'artifact' | 'web'

export function hostContext(env: { protocol: string; hasClaudeRuntime: boolean }): HostContext {
  if (env.protocol === 'file:') return 'file'
  if (env.hasClaudeRuntime) return 'artifact'
  return 'web'
}

/** Reads the real page (a no-op outside a browser). The artifact viewer gives pages `window.claude.use`. */
export function detectHostContext(): HostContext {
  if (typeof window === 'undefined') return 'web'
  let hasClaudeRuntime = false
  try {
    const claude = (window as unknown as { claude?: { use?: unknown } }).claude
    hasClaudeRuntime = !!claude && typeof claude === 'object' && claude.use !== undefined
  } catch {
    hasClaudeRuntime = false
  }
  return hostContext({ protocol: window.location.protocol, hasClaudeRuntime })
}

/**
 * What a failed server check means for the screen.
 * - missing: nothing at this address speaks the First Twenty API (a static host answers 404 or its
 *   own page), so show how to set a server up.
 * - unreachable: the address may well be a First Twenty server that is down, offline or broken right
 *   now, so say what went wrong and offer to check again (with the set-up guide below it).
 */
export function classifyCheckFailure(kind: string): 'missing' | 'unreachable' {
  return kind === 'not_found' || kind === 'bad_response' || kind === 'forbidden' ? 'missing' : 'unreachable'
}

export type StatusView = { word: string; icon: IconName; tone: Tone; sentence: string }

type StatusInput = {
  status: 'local' | 'synced' | 'syncing' | 'offline' | 'signed_out' | 'error'
  hold: HoldReason | null
  pending: number
  /** Changes the server refused (kept in this browser). Optional for callers that only show the word. */
  rejected?: number
  storageFull: boolean
}

/**
 * The kinds of state the header sync chip shows (src/app/Header.tsx, syncView) and the tone each one
 * has there. The Settings badge uses the same word and tone for the same state, so the two never
 * disagree about how serious it is (serverLogic.test.ts checks it against the chip).
 */
export const SYNC_KIND_TONE = {
  synced: 'good',
  syncing: 'neutral',
  offline: 'warn',
  'signed-out': 'warn',
  attention: 'bad',
  paused: 'neutral',
} as const satisfies Record<string, Tone>

/** The status word, icon, tone and one plain sentence (status is always a word plus a color). */
export function statusView(s: StatusInput): StatusView {
  const waiting = s.pending > 0 ? ` ${plural(s.pending, 'change is', 'changes are')} waiting in this browser.` : ''
  switch (s.status) {
    case 'synced':
      return s.rejected
        ? {
            word: 'Needs attention',
            icon: 'alert',
            tone: SYNC_KIND_TONE.attention,
            sentence: 'Your server refused some changes. Everything else is on your server.',
          }
        : { word: 'Synced', icon: 'check', tone: SYNC_KIND_TONE.synced, sentence: 'Every change in this browser is on your server.' }
    case 'syncing':
      return {
        word: 'Syncing',
        icon: 'rotate-ccw',
        tone: SYNC_KIND_TONE.syncing,
        sentence: s.pending > 0 ? `Sending ${plural(s.pending, 'change', 'changes')} to your server.` : 'Catching up with your server.',
      }
    case 'offline':
      return {
        word: 'Offline',
        icon: 'globe',
        tone: SYNC_KIND_TONE.offline,
        sentence: `Cannot reach your server. Keep working; changes sync when the connection returns.${waiting}`,
      }
    case 'signed_out':
      return {
        word: 'Signed out',
        icon: 'lock',
        tone: SYNC_KIND_TONE['signed-out'],
        sentence: `Sign in to keep syncing. This browser keeps an offline copy until then.${waiting}`,
      }
    case 'error':
      return s.storageFull
        ? { word: 'Not saving', icon: 'alert', tone: SYNC_KIND_TONE.attention, sentence: 'This browser cannot save changes that have not reached your server yet.' }
        : { word: 'Needs attention', icon: 'alert', tone: SYNC_KIND_TONE.attention, sentence: `Your server answered with an error. Syncing retries on its own.${waiting}` }
    case 'local':
      // The sample and the demo clock are pauses the person chose (Undo, or going back to the real date,
      // resumes them); an empty server or a replaced workspace needs a decision, which the chip calls
      // Needs attention.
      if (s.hold === 'sample' || s.hold === 'demo_clock') {
        return { word: 'Paused', icon: 'clock', tone: SYNC_KIND_TONE.paused, sentence: holdSentence(s.hold) }
      }
      if (s.hold) return { word: 'Needs attention', icon: 'alert', tone: SYNC_KIND_TONE.attention, sentence: holdSentence(s.hold) }
      return { word: 'Local only', icon: 'laptop', tone: 'neutral', sentence: 'This browser is not connected to a server.' }
  }
}

export function holdSentence(hold: HoldReason): string {
  switch (hold) {
    case 'sample':
      return 'Syncing is paused while this browser shows the sample company.'
    case 'demo_clock':
      return 'Syncing is paused while the app pretends today is another day.'
    case 'server_empty':
      return 'Syncing is paused because your server has no workspace.'
    case 'replaced':
      return 'Syncing is paused because this browser\'s workspace was replaced and never uploaded.'
  }
}

export type WorkspaceSummary = {
  companyName: string
  sample: boolean
  counts: { people: number; candidates: number; jobs: number }
}

/**
 * How this browser's workspace compares with the server's, for "Use the server's copy":
 * - sample: this browser shows the sample company (nothing of the company's is lost).
 * - same_name: a workspace with the server's company name. The name and a few counts cannot prove it
 *   is the same workspace (every fresh start is "1 person, 0 jobs and 0 candidates"), so the screen
 *   never calls it the same and still offers a backup first.
 * - different: another company name: using the server's copy replaces real local data.
 */
export function compareWorkspaces(local: WorkspaceSummary, server: WorkspaceSummary): 'sample' | 'same_name' | 'different' {
  if (local.sample) return 'sample'
  return local.companyName.trim().toLowerCase() === server.companyName.trim().toLowerCase() ? 'same_name' : 'different'
}

/** "3 people, 1 job and 12 candidates" */
export function describeCounts(c: { people: number; candidates: number; jobs: number }): string {
  return `${plural(c.people, 'person', 'people')}, ${plural(c.jobs, 'job', 'jobs')} and ${plural(c.candidates, 'candidate', 'candidates')}`
}

/** When the next automatic retry runs, in words ("in 40 seconds", "in 2 minutes"), or null. */
export function retryIn(nextRetryAt: number | null, now: number): string | null {
  if (nextRetryAt == null) return null
  const s = Math.max(0, Math.round((nextRetryAt - now) / 1000))
  if (s <= 1) return 'in a moment'
  if (s < 60) return `in ${s} seconds`
  const m = Math.round(s / 60)
  return `in ${m} ${m === 1 ? 'minute' : 'minutes'}`
}

/** "just now", "4 minutes ago", "2 hours ago"; past a day, null (show the date instead). */
export function agoText(at: string | null, now: number): string | null {
  if (!at) return null
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return null
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} ${m === 1 ? 'minute' : 'minutes'} ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`
  return null
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** The address to show for "your server": this page's origin, or the placeholder from the guide. */
export function serverAddress(origin: string | null | undefined): string {
  return origin && /^https?:\/\//.test(origin) ? origin : 'https://your-domain'
}

/**
 * Why the server check failed, worded for a browser that is not syncing yet (the engine's own texts
 * talk about queued changes, which do not exist before connecting).
 */
export function checkFailureText(f: { kind: string; status: number | null; message: string }, online: boolean, origin: string): string {
  if (f.kind === 'offline') {
    return online
      ? `Nothing answered at ${origin}. If your First Twenty server runs here, it may be stopped or restarting. Check again in a minute.`
      : 'This computer is offline. Connect to the internet, then check again.'
  }
  if (f.kind === 'server') {
    return f.status === 503
      ? 'A First Twenty server answers here, but its database does not. Check that Postgres is running, then check again.'
      : `The server at this address had a problem (error ${f.status ?? 500}). Check again in a minute. If it keeps happening, see Troubleshooting in the server guide.`
  }
  return f.message
}
