import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DB } from '@/domain/types'
import { CSRF_HEADER, createApi, describeFailure, type FetchLike } from './api'

type Call = { url: string; init: RequestInit }

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn: FetchLike = async (url, init = {}) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { fn, calls }
}

const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name]

afterEach(() => {
  vi.useRealTimers()
})

describe('createApi', () => {
  it('sends same-origin JSON requests, with the CSRF header on everything but GET', async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.endsWith('/api/changes')) return json(200, { seq: 3, applied: [], conflicts: [] })
      if (url.includes('/api/changes?')) return json(200, { seq: 3, changes: [] })
      return json(200, { seq: 1, versions: {} })
    })
    const api = createApi({ fetch: fn })
    await api.getChanges(0)
    await api.postChanges([{ collection: 'people', id: 'p-1', op: 'delete', baseVersion: 2 }])
    await api.putWorkspace({ schemaVersion: 1 } as DB)
    const [get, post, put] = calls
    expect(get.url).toBe('/api/changes?since=0')
    expect(get.init.method).toBe('GET')
    expect(get.init.credentials).toBe('same-origin')
    expect(header(get, CSRF_HEADER)).toBeUndefined()
    expect(get.init.body).toBeUndefined()
    expect(post.init.method).toBe('POST')
    expect(header(post, CSRF_HEADER)).toBe('1')
    expect(header(post, 'Content-Type')).toBe('application/json')
    expect(JSON.parse(post.init.body as string)).toEqual({ changes: [{ collection: 'people', id: 'p-1', op: 'delete', baseVersion: 2 }] })
    expect(post.init.keepalive).toBeUndefined()
    expect(put.init.method).toBe('PUT')
    expect(header(put, CSRF_HEADER)).toBe('1')
    expect(JSON.parse(put.init.body as string)).toEqual({ db: { schemaVersion: 1 } })
  })

  it('adds confirmReplace only when asked, and keepalive only for flushes', async () => {
    const { fn, calls } = fakeFetch((url) => (url.endsWith('/api/workspace') ? json(200, { seq: 1, versions: {} }) : json(200, { seq: 1, applied: [], conflicts: [] })))
    const api = createApi({ fetch: fn, baseUrl: 'https://hr.example.test/' })
    await api.putWorkspace({} as DB, true)
    await api.postChanges([], { keepalive: true })
    expect(calls[0].url).toBe('https://hr.example.test/api/workspace')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ db: {}, confirmReplace: true })
    expect(calls[1].init.keepalive).toBe(true)
  })

  it('maps network errors and timeouts to offline', async () => {
    const down = createApi({ fetch: fakeFetch(() => Promise.reject(new TypeError('Failed to fetch'))).fn })
    expect(await down.health()).toMatchObject({ ok: false, kind: 'offline', status: null })

    vi.useFakeTimers()
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    const slow = createApi({ fetch: hang, timeoutMs: 5000 })
    const pending = slow.getChanges(10)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toMatchObject({ ok: false, kind: 'offline' })
  })

  it('maps 401 to signed_out, except on login where it means wrong credentials', async () => {
    const api = createApi({ fetch: fakeFetch(() => json(401, { error: 'unauthorized' })).fn })
    expect(await api.me()).toMatchObject({ ok: false, kind: 'signed_out', status: 401 })
    expect(await api.getChanges(1)).toMatchObject({ ok: false, kind: 'signed_out' })
    expect(await api.login('a@example.test', 'x')).toMatchObject({ ok: false, kind: 'invalid_credentials', error: 'unauthorized' })
  })

  it('reports rate limits with the wait from the body or the Retry-After header', async () => {
    const body = createApi({ fetch: fakeFetch(() => json(429, { error: 'rate_limited', retryAfter: 120 })).fn })
    const r1 = await body.login('a@example.test', 'x')
    expect(r1).toMatchObject({ ok: false, kind: 'rate_limited', retryAfter: 120 })
    if (!r1.ok) expect(describeFailure(r1)).toBe('Too many sign-in attempts. Try again in 2 minutes.')
    const hdr = createApi({ fetch: fakeFetch(() => json(429, {}, { 'Retry-After': '30' })).fn })
    expect(await hdr.login('a@example.test', 'x')).toMatchObject({ kind: 'rate_limited', retryAfter: 30 })
  })

  it('maps the other statuses to specific kinds', async () => {
    const cases: Array<[Response, string]> = [
      [json(404, { error: 'empty' }), 'empty'],
      [json(404, { error: 'nope' }), 'not_found'],
      [json(409, { error: 'not_empty' }), 'not_empty'],
      [json(413, { error: 'too_large' }), 'too_large'],
      [json(403, { error: 'csrf' }), 'forbidden'],
      [json(400, { error: 'invalid_change' }), 'bad_request'],
      [json(500, { error: 'internal' }), 'server'],
      [json(503, { ok: false, db: 'down' }), 'server'],
      [new Response('<!doctype html><title>Vite</title>', { status: 200, headers: { 'Content-Type': 'text/html' } }), 'bad_response'],
      [json(200, { unexpected: true }), 'bad_response'],
    ]
    for (const [res, kind] of cases) {
      const api = createApi({ fetch: fakeFetch(() => res).fn })
      const r = await api.getWorkspace()
      expect(r, kind).toMatchObject({ ok: false, kind })
      if (!r.ok) expect(describeFailure(r)).not.toMatch(/—/)
    }
  })

  it('asks who is signed in with GET /api/auth/session: nobody is an answer, not a 401 (r2-48)', async () => {
    let signedIn = false
    const { fn, calls } = fakeFetch((url) => {
      if (url === '/api/auth/session') return json(200, { user: signedIn ? { id: 'u1', email: 'admin@example.test', role: 'admin' } : null })
      return json(500, {})
    })
    const api = createApi({ fetch: fn })
    expect(await api.session()).toEqual({ ok: true, status: 200, data: { user: null } })
    signedIn = true
    expect(await api.session()).toEqual({ ok: true, status: 200, data: { user: { id: 'u1', email: 'admin@example.test', role: 'admin' } } })
    expect(calls.map((c) => [c.url, c.init.method])).toEqual([
      ['/api/auth/session', 'GET'],
      ['/api/auth/session', 'GET'],
    ])
    const odd = createApi({ fetch: fakeFetch(() => json(200, { nobody: true })).fn })
    expect(await odd.session()).toMatchObject({ ok: false, kind: 'bad_response' })
    const down = createApi({ fetch: fakeFetch(() => Promise.reject(new TypeError('Failed to fetch'))).fn })
    expect(await down.session()).toMatchObject({ ok: false, kind: 'offline' })
  })

  it('falls back to /api/auth/me on a server from before /api/auth/session, and remembers', async () => {
    let signedIn = false
    const { fn, calls } = fakeFetch((url) => {
      if (url === '/api/auth/session') return json(404, { error: 'not_found' })
      return signedIn ? json(200, { user: { id: 'u1', email: 'admin@example.test', role: 'admin' } }) : json(401, { error: 'unauthorized' })
    })
    const api = createApi({ fetch: fn })
    expect(await api.session()).toEqual({ ok: true, status: 401, data: { user: null } })
    signedIn = true
    expect(await api.session()).toMatchObject({ ok: true, data: { user: { email: 'admin@example.test' } } })
    // The missing route is asked once per page.
    expect(calls.map((c) => c.url)).toEqual(['/api/auth/session', '/api/auth/me', '/api/auth/me'])
  })

  it('asks whether the server is empty with GET /api/workspace/status: empty is an answer, not a 404 (r3-06)', async () => {
    let empty = true
    const { fn, calls } = fakeFetch((url) => {
      if (url === '/api/workspace/status') return json(200, empty ? { empty: true } : { empty: false, workspaceId: 'default', historyId: 'h-1', seq: '42' })
      return json(500, {})
    })
    const api = createApi({ fetch: fn })
    expect(await api.workspaceStatus()).toEqual({ ok: true, status: 200, data: { empty: true } })
    empty = false
    expect(await api.workspaceStatus()).toEqual({ ok: true, status: 200, data: { empty: false, workspaceId: 'default', historyId: 'h-1', seq: 42 } })
    expect(calls.map((c) => [c.url, c.init.method])).toEqual([
      ['/api/workspace/status', 'GET'],
      ['/api/workspace/status', 'GET'],
    ])
    const signedOut = createApi({ fetch: fakeFetch(() => json(401, { error: 'unauthorized' })).fn })
    expect(await signedOut.workspaceStatus()).toMatchObject({ ok: false, kind: 'signed_out' })
    const odd = createApi({ fetch: fakeFetch(() => json(200, { empty: 'maybe' })).fn })
    expect(await odd.workspaceStatus()).toMatchObject({ ok: false, kind: 'bad_response' })
  })

  it('falls back to GET /api/workspace on a server from before the status route, and remembers', async () => {
    let hasWorkspace = false
    const snapshot = { workspaceId: 'default', historyId: 'h-2', seq: 7, db: { schemaVersion: 1 }, versions: {} }
    const { fn, calls } = fakeFetch((url) => {
      if (url === '/api/workspace/status') return json(404, { error: 'not_found' })
      if (url === '/api/workspace') return hasWorkspace ? json(200, snapshot) : json(404, { error: 'empty' })
      return json(500, {})
    })
    const api = createApi({ fetch: fn })
    expect(await api.workspaceStatus()).toEqual({ ok: true, status: 404, data: { empty: true } })
    hasWorkspace = true
    // The workspace it had to download comes along, so nobody fetches it twice.
    expect(await api.workspaceStatus()).toEqual({
      ok: true,
      status: 200,
      data: { empty: false, workspaceId: 'default', historyId: 'h-2', seq: 7, snapshot: { ...snapshot, db: { schemaVersion: 1 } } },
    })
    // Without the fallback (a cheap check on every page load) it says not_found and downloads nothing.
    expect(await api.workspaceStatus({ fallback: false })).toMatchObject({ ok: false, kind: 'not_found' })
    // The missing route is asked once per page.
    expect(calls.map((c) => c.url)).toEqual(['/api/workspace/status', '/api/workspace', '/api/workspace'])
    // Anything other than a missing route stays a failure.
    const down = createApi({ fetch: fakeFetch(() => json(503, { error: 'unavailable' })).fn })
    expect(await down.workspaceStatus()).toMatchObject({ ok: false, kind: 'server' })
  })

  it('reads the existing, byYou and landed flags of a push answer, and ignores anything else', async () => {
    const api = createApi({
      fetch: fakeFetch(() =>
        json(200, {
          seq: 9,
          applied: [
            { collection: 'activity', id: 'act-1', version: 4, existing: true },
            { collection: 'people', id: 'p-2', version: 9, existing: 'yes' },
          ],
          conflicts: [
            { collection: 'people', id: 'p-1', serverVersion: 8, serverData: { id: 'p-1' }, byYou: true, landed: true },
            { collection: 'jobs', id: 'j-1', serverVersion: null, serverData: null, byYou: 1 },
          ],
        }),
      ).fn,
    })
    expect(await api.postChanges([])).toEqual({
      ok: true,
      status: 200,
      data: {
        seq: 9,
        applied: [
          { collection: 'activity', id: 'act-1', version: 4, existing: true },
          { collection: 'people', id: 'p-2', version: 9 },
        ],
        conflicts: [
          { collection: 'people', id: 'p-1', serverVersion: 8, serverData: { id: 'p-1' }, byYou: true, landed: true },
          { collection: 'jobs', id: 'j-1', serverVersion: null, serverData: null },
        ],
      },
    })
  })

  it('parses health, login, me and logout', async () => {
    const { fn } = fakeFetch((url) => {
      if (url === '/api/health') return json(200, { ok: true, db: 'up', version: '0.1.0' })
      if (url === '/api/auth/logout') return new Response(null, { status: 204 })
      return json(200, { user: { id: 'u1', email: 'admin@example.test', role: 'admin' } })
    })
    const api = createApi({ fetch: fn })
    expect(await api.health()).toEqual({ ok: true, status: 200, data: { ok: true, db: 'up', version: '0.1.0' } })
    expect(await api.login('admin@example.test', 'x')).toMatchObject({ ok: true, data: { user: { id: 'u1', role: 'admin' } } })
    expect(await api.me()).toMatchObject({ ok: true, data: { user: { email: 'admin@example.test' } } })
    expect(await api.logout()).toEqual({ ok: true, status: 204, data: null })
  })

  it('sends remember with the sign-in, false unless asked', async () => {
    const { fn, calls } = fakeFetch(() => json(200, { user: { id: 'u1', email: 'admin@example.test', role: 'admin' } }))
    const api = createApi({ fetch: fn })
    await api.login('admin@example.test', 'x')
    await api.login('admin@example.test', 'x', { remember: true })
    await api.login('admin@example.test', 'x', { remember: false })
    expect(calls.map((c) => JSON.parse(c.init.body as string).remember)).toEqual([false, true, false])
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ email: 'admin@example.test', password: 'x', remember: true })
  })

  it('a 503 from health means the database is down', async () => {
    const api = createApi({ fetch: fakeFetch(() => json(503, { ok: false, db: 'down' })).fn })
    const r = await api.health()
    expect(r).toMatchObject({ ok: false, kind: 'server', status: 503 })
    if (!r.ok) expect(describeFailure(r)).toContain('database')
  })

  it('parses snapshots and change pages, accepting numeric strings and sorting by seq', async () => {
    const { fn } = fakeFetch((url) => {
      if (url === '/api/workspace') return json(200, { workspaceId: 'default', seq: '17', db: { schemaVersion: 1 }, versions: { 'people:p-1': '4' } })
      return json(200, {
        seq: '9',
        more: true,
        changes: [
          { seq: '9', collection: 'people', id: 'p-2', op: 'delete', version: 2 },
          { seq: 8, collection: 'people', id: 'p-1', op: 'upsert', version: 3, data: { id: 'p-1' } },
        ],
      })
    })
    const api = createApi({ fetch: fn })
    expect(await api.getWorkspace()).toMatchObject({ ok: true, data: { workspaceId: 'default', seq: 17, versions: { 'people:p-1': 4 } } })
    const page = await api.getChanges(7.9)
    expect(page).toEqual({
      ok: true,
      status: 200,
      data: {
        seq: 9,
        more: true,
        changes: [
          { seq: 8, collection: 'people', id: 'p-1', op: 'upsert', version: 3, data: { id: 'p-1' } },
          { seq: 9, collection: 'people', id: 'p-2', op: 'delete', version: 2 },
        ],
      },
    })
  })

  it('passes resync through and rejects malformed change pages', async () => {
    const resync = createApi({ fetch: fakeFetch(() => json(200, { resync: true })).fn })
    expect(await resync.getChanges(0)).toEqual({ ok: true, status: 200, data: { resync: true } })
    const bad = createApi({ fetch: fakeFetch(() => json(200, { seq: 1, changes: [{ seq: 1, collection: 'people', op: 'merge' }] })).fn })
    expect(await bad.getChanges(0)).toMatchObject({ ok: false, kind: 'bad_response' })
  })

  it('parses push results, including conflicts without server data', async () => {
    const { fn } = fakeFetch(() =>
      json(200, {
        seq: 12,
        applied: [{ collection: 'people', id: 'p-1', version: '5' }],
        conflicts: [
          { collection: 'people', id: 'p-2', serverVersion: 7, serverData: { id: 'p-2' } },
          { collection: 'people', id: 'p-3', serverVersion: null },
        ],
      }),
    )
    const api = createApi({ fetch: fn })
    expect(await api.postChanges([])).toEqual({
      ok: true,
      status: 200,
      data: {
        seq: 12,
        applied: [{ collection: 'people', id: 'p-1', version: 5 }],
        conflicts: [
          { collection: 'people', id: 'p-2', serverVersion: 7, serverData: { id: 'p-2' } },
          { collection: 'people', id: 'p-3', serverVersion: null, serverData: null },
        ],
      },
    })
  })

  it('sends and reads history ids, and maps a 409 resync', async () => {
    const { fn, calls } = fakeFetch((url, init) => {
      if (url.includes('/api/changes?')) return json(200, { historyId: 'h-2', seq: 3, changes: [] })
      if (url.endsWith('/api/changes') && init.method === 'POST') return json(409, { error: 'resync' })
      if (url.endsWith('/api/workspace') && init.method === 'PUT') return json(200, { historyId: 'h-3', seq: 1, versions: {} })
      return json(200, { workspaceId: 'default', historyId: 'h-1', seq: 1, db: {}, versions: {} })
    })
    const api = createApi({ fetch: fn })
    const page = await api.getChanges(2, 'h-1')
    expect(calls[0].url).toBe('/api/changes?since=2&history=h-1')
    expect(page).toMatchObject({ ok: true, data: { historyId: 'h-2', seq: 3 } })
    const push = await api.postChanges([{ collection: 'people', id: 'p-1', op: 'delete', baseVersion: 2 }], { historyId: 'h-1' })
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ changes: [{ collection: 'people', id: 'p-1', op: 'delete', baseVersion: 2 }], historyId: 'h-1' })
    expect(push).toMatchObject({ ok: false, kind: 'resync', status: 409 })
    if (!push.ok) expect(describeFailure(push)).toMatch(/replaced or restored/)
    expect(await api.putWorkspace({ schemaVersion: 1 } as DB, true)).toMatchObject({ ok: true, data: { historyId: 'h-3' } })
    expect(await api.getWorkspace()).toMatchObject({ ok: true, data: { historyId: 'h-1' } })
    // No history id known: none sent.
    await api.getChanges(0, null)
    expect(calls.at(-1)?.url).toBe('/api/changes?since=0')
  })
})
