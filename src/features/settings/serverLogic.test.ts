import { describe, expect, it } from 'vitest'
import { syncView } from '@/app/Header'
import {
  agoText,
  checkFailureText,
  classifyCheckFailure,
  compareWorkspaces,
  describeCounts,
  hostContext,
  retryIn,
  serverAddress,
  statusView,
  SYNC_KIND_TONE,
} from './serverLogic'

describe('hostContext', () => {
  it('treats a file opened from disk as file, even with a runtime', () => {
    expect(hostContext({ protocol: 'file:', hasClaudeRuntime: false })).toBe('file')
    expect(hostContext({ protocol: 'file:', hasClaudeRuntime: true })).toBe('file')
  })
  it('treats the artifact viewer as artifact', () => {
    expect(hostContext({ protocol: 'https:', hasClaudeRuntime: true })).toBe('artifact')
  })
  it('treats an ordinary web page as web', () => {
    expect(hostContext({ protocol: 'https:', hasClaudeRuntime: false })).toBe('web')
    expect(hostContext({ protocol: 'http:', hasClaudeRuntime: false })).toBe('web')
  })
})

describe('classifyCheckFailure', () => {
  it('reads a static host as no server', () => {
    expect(classifyCheckFailure('not_found')).toBe('missing')
    expect(classifyCheckFailure('bad_response')).toBe('missing')
    expect(classifyCheckFailure('forbidden')).toBe('missing')
  })
  it('reads network and server errors as unreachable', () => {
    expect(classifyCheckFailure('offline')).toBe('unreachable')
    expect(classifyCheckFailure('server')).toBe('unreachable')
    expect(classifyCheckFailure('rate_limited')).toBe('unreachable')
  })
})

describe('statusView', () => {
  const base = { hold: null, pending: 0, storageFull: false } as const
  it('gives every status a word and an icon', () => {
    for (const status of ['local', 'synced', 'syncing', 'offline', 'signed_out', 'error'] as const) {
      const v = statusView({ ...base, status })
      expect(v.word.length).toBeGreaterThan(0)
      expect(v.icon.length).toBeGreaterThan(0)
      expect(v.sentence).not.toMatch(/—/)
    }
  })
  it('counts waiting changes', () => {
    expect(statusView({ ...base, status: 'syncing', pending: 1 }).sentence).toBe('Sending 1 change to your server.')
    expect(statusView({ ...base, status: 'offline', pending: 3 }).sentence).toContain('3 changes are waiting')
  })
  it('names a hold as paused', () => {
    const v = statusView({ ...base, status: 'local', hold: 'sample' })
    expect(v.word).toBe('Paused')
    expect(v.sentence).toContain('sample company')
  })
  it('names the demo clock hold as a pause the person chose', () => {
    const v = statusView({ ...base, status: 'local', hold: 'demo_clock' })
    expect(v).toMatchObject({ word: 'Paused', tone: SYNC_KIND_TONE.paused })
    expect(v.sentence).toBe('Syncing is paused while the app pretends today is another day.')
  })
  it('does not call refused changes synced, and words them without a per-record count', () => {
    const v = statusView({ ...base, status: 'synced', rejected: 2 })
    expect(v.word).toBe('Needs attention')
    expect(v.tone).toBe('bad')
    expect(v.sentence).toContain('refused some changes')
  })
  it('says when the browser cannot save', () => {
    expect(statusView({ ...base, status: 'error', storageFull: true }).word).toBe('Not saving')
  })
})

describe('statusView agrees with the header chip', () => {
  // The same state must read the same in the header chip and in Settings: word and seriousness.
  const chipWord: Record<keyof typeof SYNC_KIND_TONE, string> = {
    synced: 'Synced',
    syncing: 'Syncing',
    offline: 'Offline',
    'signed-out': 'Signed out',
    attention: 'Needs attention',
    paused: 'Paused',
  }
  type Case = Parameters<typeof statusView>[0]
  const base = { pending: 0, rejected: 0, storageFull: false, hold: null } as const
  const cases: Array<[string, Case]> = [
    ['synced', { ...base, status: 'synced' }],
    ['syncing', { ...base, status: 'syncing', pending: 2 }],
    ['offline', { ...base, status: 'offline', pending: 1 }],
    ['signed out', { ...base, status: 'signed_out' }],
    ['error', { ...base, status: 'error' }],
    ['refused', { ...base, status: 'synced', rejected: 2 }],
    ['sample hold', { ...base, status: 'local', hold: 'sample' }],
    ['demo clock hold', { ...base, status: 'local', hold: 'demo_clock' }],
    ['empty server hold', { ...base, status: 'local', hold: 'server_empty' }],
    ['replaced hold', { ...base, status: 'local', hold: 'replaced' }],
  ]
  for (const [name, c] of cases) {
    it(name, () => {
      const chip = syncView({
        status: c.status,
        mode: 'server',
        pending: c.pending,
        rejected: c.rejected ?? 0,
        lastSyncAt: null,
        lastError: null,
        hold: c.hold,
        user: null,
      })
      expect(chip).not.toBeNull()
      const v = statusView(c)
      expect(v.tone).toBe(SYNC_KIND_TONE[chip!.kind])
      expect(v.word).toBe(chipWord[chip!.kind])
    })
  }
})

describe('compareWorkspaces', () => {
  const server = { companyName: 'Acme', sample: false, counts: { people: 3, candidates: 4, jobs: 1 } }
  it('sees the sample first', () => {
    expect(compareWorkspaces({ ...server, sample: true }, server)).toBe('sample')
  })
  it('matches the company name only, ignoring case, and never claims more', () => {
    expect(compareWorkspaces({ ...server, companyName: ' acme ' }, server)).toBe('same_name')
    // Two fresh starts with one name: same counts, and still not called the same workspace.
    const fresh = { companyName: 'Delta Inc', sample: false, counts: { people: 1, candidates: 0, jobs: 0 } }
    expect(compareWorkspaces(fresh, { ...fresh })).toBe('same_name')
  })
  it('flags another company', () => {
    expect(compareWorkspaces({ ...server, companyName: 'Other' }, server)).toBe('different')
  })
})

describe('wording helpers', () => {
  it('describes counts with plurals', () => {
    expect(describeCounts({ people: 1, candidates: 0, jobs: 2 })).toBe('1 person, 2 jobs and 0 candidates')
  })
  it('says when the next retry runs', () => {
    expect(retryIn(null, 0)).toBeNull()
    expect(retryIn(1000, 0)).toBe('in a moment')
    expect(retryIn(40_000, 0)).toBe('in 40 seconds')
    expect(retryIn(60_000, 0)).toBe('in 1 minute')
    expect(retryIn(150_000, 0)).toBe('in 3 minutes')
  })
  it('says how long ago', () => {
    const now = Date.parse('2026-10-10T12:00:00Z')
    expect(agoText(null, now)).toBeNull()
    expect(agoText('2026-10-10T11:59:50Z', now)).toBe('just now')
    expect(agoText('2026-10-10T11:56:00Z', now)).toBe('4 minutes ago')
    expect(agoText('2026-10-10T10:00:00Z', now)).toBe('2 hours ago')
    expect(agoText('2026-10-08T10:00:00Z', now)).toBeNull()
  })
  it('falls back to the placeholder address', () => {
    expect(serverAddress('https://hr.example.com')).toBe('https://hr.example.com')
    expect(serverAddress('null')).toBe('https://your-domain')
    expect(serverAddress(undefined)).toBe('https://your-domain')
  })
})

describe('checkFailureText', () => {
  it('words a network error by whether the computer is online', () => {
    expect(checkFailureText({ kind: 'offline', status: null, message: '' }, false, 'https://a.test')).toContain('offline')
    expect(checkFailureText({ kind: 'offline', status: null, message: '' }, true, 'https://a.test')).toContain('Nothing answered at https://a.test')
  })
  it('tells a database outage from other server errors', () => {
    expect(checkFailureText({ kind: 'server', status: 503, message: '' }, true, '')).toContain('database')
    expect(checkFailureText({ kind: 'server', status: 502, message: '' }, true, '')).toContain('error 502')
  })
  it('keeps the engine text for anything else', () => {
    expect(checkFailureText({ kind: 'rate_limited', status: 429, message: 'Wait.' }, true, '')).toBe('Wait.')
  })
})
