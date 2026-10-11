// The HTTP API (docs/SYNC.md, Protocol). buildApp returns a Fastify instance that is not listening yet,
// so tests drive it with app.inject() and index.ts calls listen().
//
// Every /api route lives in one encapsulated plugin (prefix /api) that carries the CORS, CSRF,
// cross-site and no-store hooks, so they apply by route match: a percent-encoded path such as
// /%61pi/auth/logout reaches the same route and the same guards. Routes that need a session check it
// in onRequest, before Fastify reads the body, and so does the answer for unknown paths and methods: an
// anonymous request gets a body read only by the two sign-in routes, within their small body limits. A
// request whose body never finishes arriving is dropped after REQUEST_TIMEOUT_MS.
import { readFileSync } from 'node:fs'
import fastifyCookie from '@fastify/cookie'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import {
  authCookies,
  checkCredentials,
  clientAddressKey,
  ConcurrencyGate,
  cookieCount,
  createSession,
  deleteSession,
  DEVICE_TRUST_DAYS,
  findSession,
  findTrustedDevice,
  GateFullError,
  LoginRateLimiter,
  loginEmail,
  MAX_PASSWORD_LENGTH,
  purgeSessions,
  type SessionUser,
  trustDevice,
} from './auth'
import type { Config } from './config'
import { API_CSP, appCsp, inlineScriptHashes } from './csp'
import type { Db } from './db'
import { badRequest, HttpError } from './errors'
import { unappliedMigrations } from './migrate'
import { markServed, SERVICE_WORKER_CSP, SERVICE_WORKER_JS, SERVICE_WORKER_PATH } from './offline'
import { applyChanges, changesSince, replaceWorkspace, snapshot, workspaceStatus } from './repo'
import { isPlainObject, parseHistoryId, parsePush, parseSince, parseWorkspace } from './validate'
import { serverVersion } from './version'

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null
  }
}

export const CSRF_HEADER = 'x-first-twenty'
export const BODY_LIMIT = 2 * 1024 * 1024
export const WORKSPACE_BODY_LIMIT = 10 * 1024 * 1024
/** {email, password}: a 254-character email and a 1,024-character password fit with room to spare. */
export const LOGIN_BODY_LIMIT = 8 * 1024
export const LOGOUT_BODY_LIMIT = 1024
/**
 * How long a request may take to arrive in full (Node's requestTimeout; Fastify's default is none, so a
 * body sent a byte at a time held its socket forever). Enough for a 10 MB workspace upload at about
 * 0.5 Mbit/s; Caddy's read_body timeout in server/deploy/Caddyfile matches it. Node checks every 30 s.
 */
export const REQUEST_TIMEOUT_MS = 180_000
/** How often the login rate limiter drops keys with no recent attempts. */
const LIMITER_SWEEP_MS = 60_000

export type BuildAppOptions = {
  db: Db
  config: Config
  /** Overrides the logger (tests pass false). Default: pino at config.logLevel, or off when 'silent'. */
  logger?: boolean | Record<string, unknown>
  limiter?: LoginRateLimiter
  /** Caps concurrent password checks (default: 2 running, 16 waiting). */
  passwordGate?: ConcurrencyGate
}

function loggerOptions(config: Config): boolean | Record<string, unknown> {
  if (config.logLevel === 'silent') return false
  return {
    level: config.logLevel,
    // The default serializers log method, url, host, remote address and status: never bodies or headers.
    // Redact anyway in case a header object is ever logged.
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]', 'password', '*.password'],
      censor: '[redacted]',
    },
  }
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { db, config } = options
  const limiter = options.limiter ?? new LoginRateLimiter()
  const passwordGate = options.passwordGate ?? new ConcurrencyGate()
  const version = serverVersion()

  // The served app is read once: its inline scripts are allowed by hash, and serving the same bytes
  // that were hashed keeps the two in step even while a deploy rebuilds the file (it restarts after).
  // It carries the served mark, so the app registers the offline worker (offline.ts) only here.
  const appHtml = config.serveApp ? Buffer.from(markServed(readFileSync(config.appFile, 'utf8')), 'utf8') : null
  const appPolicy = appHtml ? appCsp(inlineScriptHashes(appHtml.toString('utf8'))) : null

  // A build started before its migrations ran (MIGRATE_ON_START=false and no server:migrate yet) would
  // answer health checks while every sign-in fails on a missing table, so /api/health says 503 until the
  // schema catches up. Once current, it is not read again. A read that fails counts as current: the
  // check must never take a healthy server down.
  let schemaCurrent = false
  const schemaBehind = async (log: FastifyRequest['log']): Promise<boolean> => {
    if (schemaCurrent) return false
    try {
      const pending = await unappliedMigrations(db)
      if (pending.length === 0) {
        schemaCurrent = true
        return false
      }
      log.error({ pending }, 'the database schema is behind this build: run server:migrate, then restart')
      return true
    } catch (err) {
      log.warn({ err }, 'could not read schema_migrations')
      return false
    }
  }

  const app = Fastify({
    logger: options.logger ?? loggerOptions(config),
    bodyLimit: BODY_LIMIT,
    trustProxy: config.trustProxy,
    requestTimeout: REQUEST_TIMEOUT_MS,
    return503OnClosing: true,
    requestIdHeader: false,
  })

  app.decorateRequest('user', null)

  /**
   * Whether a request gets Secure cookies and HSTS: always when PUBLIC_ORIGIN is https, and also when it
   * reached Caddy over https (X-Forwarded-Proto, honoured from trustProxy addresses only, which is
   * loopback by default), so a PUBLIC_ORIGIN left at http:// never puts the session cookie on the wire
   * without Secure. The SSH tunnel to http://localhost keeps plain cookies while PUBLIC_ORIGIN is http.
   */
  const isSecure = (request: FastifyRequest) => config.secureCookies || request.protocol === 'https'

  // JSON bodies only (no forms, so no simple cross-site POSTs). An empty body counts as no body.
  const defaultJson = app.getDefaultJsonParser('error', 'error')
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (body === '' || (typeof body === 'string' && body.trim() === '')) {
      done(null, undefined)
      return
    }
    defaultJson(request, body as string, done)
  })
  app.removeContentTypeParser('text/plain')

  await app.register(fastifyCookie)

  // The login limiter forgets idle keys on a timer (never per request).
  const sweeper = setInterval(() => limiter.sweep(), LIMITER_SWEEP_MS)
  sweeper.unref()
  app.addHook('onClose', async () => clearInterval(sweeper))

  // ------------------------------------------------------------------------------------------
  // Security headers on every response
  // ------------------------------------------------------------------------------------------

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Cross-Origin-Opener-Policy', 'same-origin')
    reply.header('Cross-Origin-Resource-Policy', 'same-origin')
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
    if (isSecure(request)) reply.header('Strict-Transport-Security', 'max-age=31536000')
    // The app route sets its own policy (with its script hashes); everything else gets the strict one.
    if (!reply.hasHeader('content-security-policy')) {
      const type = String(reply.getHeader('content-type') ?? '')
      reply.header('Content-Security-Policy', type.startsWith('text/html') ? appCsp([]) : API_CSP)
    }
    return payload
  })

  // ------------------------------------------------------------------------------------------
  // Errors: never leak stack traces, SQL or driver messages
  // ------------------------------------------------------------------------------------------

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (err instanceof HttpError) {
      if (err.statusCode >= 500) request.log.error({ err }, 'request failed')
      return reply.code(err.statusCode).send({ error: err.code, ...(err.detail ? { detail: err.detail } : {}), ...err.extra })
    }
    const status = err.statusCode
    if (typeof status === 'number' && status >= 400 && status < 500) {
      request.log.info({ code: err.code, status }, 'request rejected')
      const code =
        status === 413 ? 'too_large' : status === 415 ? 'unsupported_media_type' : status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : 'bad_request'
      return reply.code(status).send({ error: code })
    }
    // Postgres data exceptions (class 22: bad text, unicode or number) mean the input cannot be stored.
    if (typeof err.code === 'string' && /^22[0-9A-Z]{3}$/.test(err.code)) {
      request.log.warn({ code: err.code }, 'data rejected by the database')
      return reply.code(400).send({ error: 'bad_request', detail: 'The data could not be stored.' })
    }
    request.log.error({ err }, 'request failed')
    return reply.code(500).send({ error: 'server_error' })
  })

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'not_found' })
  })

  // Unknown paths and methods are answered before anything reads the body: Fastify's not-found handlers
  // would otherwise buffer and parse up to BODY_LIMIT for anyone. Registered before the API plugin, so
  // it and both not-found handlers inherit it. A development CORS preflight lands on a not-found route
  // too (there are no OPTIONS routes), so it goes on to the API's CORS hook.
  app.addHook('onRequest', async (request, reply) => {
    if (request.is404 && !(config.allowedOrigin && request.method === 'OPTIONS')) {
      return reply.code(404).send({ error: 'not_found' })
    }
  })

  // ------------------------------------------------------------------------------------------
  // The API
  // ------------------------------------------------------------------------------------------

  /** The session's user, or null. A cookie that names no live session is cleared. */
  async function sessionUser(request: FastifyRequest, reply: FastifyReply): Promise<SessionUser | null> {
    const { session } = authCookies(isSecure(request))
    const token = request.cookies[session.name]
    const user = await findSession(db, token, config)
    // Two cookies of this name mean another host planted one (a browser sends one per domain and path,
    // and the parser keeps the first): clearing would delete the real one, not the planted one.
    if (!user && token && cookieCount(request.headers.cookie, session.name) === 1) reply.clearCookie(session.name, session.options)
    return user
  }

  /** onRequest hook: runs before the body is read, so anonymous requests are refused unparsed. */
  async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
    const user = await sessionUser(request, reply)
    if (!user) throw new HttpError(401, 'unauthorized', 'Sign in first.')
    request.user = user
  }

  const currentUser = (request: FastifyRequest): SessionUser => {
    if (!request.user) throw new HttpError(401, 'unauthorized', 'Sign in first.')
    return request.user
  }

  /** 429 for a sign-in that got no password check because too many are running or waiting. */
  const refuseBusy = (request: FastifyRequest, reply: FastifyReply) => {
    request.log.warn({ ip: request.ip }, 'login refused: too many password checks waiting')
    reply.header('Retry-After', '5')
    return reply.code(429).send({ error: 'busy', retryAfter: 5 })
  }

  async function apiRoutes(api: FastifyInstance) {
    // Guards: CORS (development only), CSRF header, cross-site requests.
    api.addHook('onRequest', async (request, reply) => {
      const origin = request.headers.origin
      if (config.allowedOrigin && origin === config.allowedOrigin) {
        reply.header('Access-Control-Allow-Origin', origin)
        reply.header('Access-Control-Allow-Credentials', 'true')
        reply.header('Vary', 'Origin')
        if (request.method === 'OPTIONS') {
          reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT')
          reply.header('Access-Control-Allow-Headers', 'Content-Type, X-First-Twenty')
          reply.header('Access-Control-Max-Age', '600')
          return reply.code(204).send()
        }
      }
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
        // Never relax this check. Under a shared parent domain that is not a public suffix (*.sslip.io),
        // every other host there is "same-site", so SameSite=Strict lets their requests carry the
        // cookie; this header, which no page can send cross-origin without a CORS preflight (refused
        // here), is what stops them.
        if (request.headers[CSRF_HEADER] !== '1') {
          return reply.code(403).send({ error: 'csrf', detail: 'Send the X-First-Twenty: 1 header.' })
        }
        // Browsers label where a request comes from: only the app's own pages (same-origin) may write.
        // 'same-site' is refused too, for the reason above; 'none' is a user action, and tools that send
        // no label at all (curl, scripts) still pass. An allowed dev origin is the one exception.
        const site = request.headers['sec-fetch-site']
        if (site !== undefined && site !== 'same-origin' && site !== 'none' && !(config.allowedOrigin && origin === config.allowedOrigin)) {
          return reply.code(403).send({ error: 'cross_site' })
        }
      }
    })

    api.addHook('onSend', async (_request, reply, payload) => {
      reply.header('Cache-Control', 'no-store')
      return payload
    })

    api.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: 'not_found' })
    })

    const authed = { onRequest: requireAuth }

    api.get('/health', async (request, reply) => {
      let timer: NodeJS.Timeout | undefined
      try {
        const behind = await Promise.race([
          db.query('SELECT 1').then(() => schemaBehind(request.log)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('health check timed out')), 3000)
          }),
        ])
        // The names stay in the log: this route answers anyone.
        if (behind) return reply.code(503).send({ ok: false, db: 'up', schema: 'behind' })
        return { ok: true, db: 'up', version }
      } catch (err) {
        request.log.warn({ err }, 'database health check failed')
        return reply.code(503).send({ ok: false, db: 'down' })
      } finally {
        clearTimeout(timer)
      }
    })

    api.post('/auth/login', { bodyLimit: LOGIN_BODY_LIMIT }, async (request, reply) => {
      const body = request.body
      if (!isPlainObject(body) || typeof body.email !== 'string' || typeof body.password !== 'string') {
        throw badRequest('Send {"email": "...", "password": "..."}.')
      }
      // Optional "Keep me signed in". Absent means false: a browser-session cookie and a 12-hour session.
      if (body.remember !== undefined && typeof body.remember !== 'boolean') {
        throw badRequest('remember must be true or false.')
      }
      const remember = body.remember === true
      const cookies = authCookies(isSecure(request))
      // Normalized once: this exact string is the rate-limit key and the lookup (null: no login has it).
      const email = loginEmail(body.email)
      const password = body.password
      const address = clientAddressKey(request.ip)
      const possible = email !== null && password.length > 0 && password.length <= MAX_PASSWORD_LENGTH
      // A browser that signed in as this login before (its trusted-device cookie) gets its own limit
      // instead of the email and address limits, so guessing from many addresses cannot lock it out.
      const device = possible ? await findTrustedDevice(db, request.cookies[cookies.device.name], email) : null
      // Checked right before run(), with no await in between, so run() cannot refuse it after all.
      const busy = possible && passwordGate.full
      const trusted = device !== null && !busy
      // A sign-in that cannot succeed, or gets no password check, counts against the address only, so
      // it adds no keys for an email and cannot push another email's count out of the limiter.
      const limit = trusted ? limiter.beginTrusted(device) : limiter.begin(possible && !busy ? email : null, address)
      if (!limit.ok) {
        reply.header('Retry-After', String(limit.retryAfter))
        return reply.code(429).send({ error: 'rate_limited', retryAfter: limit.retryAfter })
      }
      if (busy) return refuseBusy(request, reply)
      let user: SessionUser | null = null
      if (possible) {
        try {
          user = await passwordGate.run(() => checkCredentials(db, email, password))
        } catch (err) {
          if (!(err instanceof GateFullError)) throw err
          if (trusted) limiter.cancelledTrusted(device)
          else limiter.cancelled(email, address)
          return refuseBusy(request, reply)
        }
      }
      if (!user || !email) {
        request.log.info({ ip: request.ip, trusted }, 'login failed')
        return reply.code(401).send({ error: 'invalid_credentials' })
      }
      if (trusted) limiter.succeededTrusted(device)
      else limiter.succeeded(email, address)
      // A fresh session every sign-in; drop the one this browser had (session fixation) and stale ones.
      await deleteSession(db, request.cookies[cookies.session.name])
      await purgeSessions(db, config)
      const token = await createSession(db, user.id, config, { ip: request.ip, userAgent: request.headers['user-agent'] }, remember)
      // A fresh device token too, in place of the one this browser sent.
      const deviceToken = await trustDevice(db, user.id, request.cookies[cookies.device.name])
      await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id])
      // Remembered: the cookie outlives the browser for SESSION_MAX_DAYS. Otherwise no Max-Age or
      // Expires, so the browser drops it when it closes (the server ends it after 12 hours anyway).
      const { session, device: deviceCookie } = cookies
      reply.setCookie(session.name, token, remember ? { ...session.options, maxAge: config.sessionMaxDays * 86_400 } : session.options)
      // The device cookie outlasts sessions and sign-outs: on its own it grants nothing but its sign-in limit.
      reply.setCookie(deviceCookie.name, deviceToken, { ...deviceCookie.options, maxAge: DEVICE_TRUST_DAYS * 86_400 })
      request.log.info({ userId: user.id, remember, trusted }, 'login succeeded')
      return { user }
    })

    api.post('/auth/logout', { bodyLimit: LOGOUT_BODY_LIMIT }, async (request, reply) => {
      const { session } = authCookies(isSecure(request))
      // Clear the browser's cookie even when the database is unreachable, so a shared computer is never
      // left holding a live session token; the 503 tells the client to retry deleting the server row.
      reply.clearCookie(session.name, session.options)
      try {
        await deleteSession(db, request.cookies[session.name])
      } catch (err) {
        request.log.error({ err }, 'logout could not delete the session row')
        return reply.code(503).send({ error: 'unavailable' })
      }
      return reply.code(204).send()
    })

    api.get('/auth/me', authed, async (request) => ({ user: currentUser(request) }))

    // Who is signed in, for the app's checks on every page load: nobody is an answer here ({user: null}),
    // not a 401, which browsers log as an error. GET and no body, so it needs no guard of its own.
    api.get('/auth/session', async (request, reply) => ({ user: await sessionUser(request, reply) }))

    // 404 {error: 'empty'} before the first upload, by protocol (older apps rely on it).
    api.get('/workspace', authed, async (_request, reply) => {
      const snap = await snapshot(db)
      if (!snap) return reply.code(404).send({ error: 'empty' })
      return snap
    })

    // Whether the server holds a workspace, for the app's "is it empty?" checks: an empty server is an
    // answer here ({empty: true}), not a 404, which browsers log as an error. No records are read.
    api.get('/workspace/status', authed, async () => workspaceStatus(db))

    api.put('/workspace', { ...authed, bodyLimit: WORKSPACE_BODY_LIMIT }, async (request) => {
      const input = parseWorkspace(request.body)
      const user = currentUser(request)
      const result = await replaceWorkspace(db, input, user.id)
      request.log.info({ userId: user.id, seq: result.seq, replace: input.confirmReplace }, 'workspace replaced')
      return result
    })

    api.get('/changes', authed, async (request) => {
      const query = request.query as Record<string, unknown>
      const since = parseSince(query.since)
      return changesSince(db, since, { historyId: parseHistoryId(query.history) })
    })

    api.post('/changes', authed, async (request) => {
      const { changes, historyId } = parsePush(request.body)
      return applyChanges(db, changes, currentUser(request).id, { historyId })
    })
  }

  await app.register(apiRoutes, { prefix: '/api' })

  // ------------------------------------------------------------------------------------------
  // The one-file app (production: the server serves it; development: Vite does)
  // ------------------------------------------------------------------------------------------

  if (appHtml && appPolicy) {
    // Only these two paths: nothing else from the app's folder is ever served.
    const sendApp = (_request: FastifyRequest, reply: FastifyReply) =>
      reply.header('Cache-Control', 'no-cache').header('Content-Security-Policy', appPolicy).type('text/html; charset=utf-8').send(appHtml)
    app.get('/', sendApp)
    app.get('/index.html', sendApp)
    // The offline worker (offline.ts), from memory. no-cache: the browser checks it for updates on every
    // visit. Its own policy (a worker obeys the CSP of its script) allows only fetches to this origin.
    app.get(SERVICE_WORKER_PATH, (_request, reply) =>
      reply
        .header('Cache-Control', 'no-cache')
        .header('Content-Security-Policy', SERVICE_WORKER_CSP)
        .type('application/javascript; charset=utf-8')
        .send(SERVICE_WORKER_JS),
    )
  }

  return app
}
