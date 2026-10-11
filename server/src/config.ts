// Server settings, read from environment variables (docs/SYNC.md). On EC2 they come from
// /etc/first-twenty/env (systemd EnvironmentFile); locally from an optional git-ignored .env file in the
// repo root. Nothing secret has a default: DATABASE_URL must be set in production.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError } from './errors'

export type NodeEnv = 'production' | 'development' | 'test'

export type Config = {
  nodeEnv: NodeEnv
  port: number
  host: string
  /** postgres://... (production) or pglite:<dir> / pglite:memory (development and tests). */
  databaseUrl: string
  /** Resolved PGlite data directory, or 'memory'. Null when databaseUrl is a Postgres URL. */
  pgliteDir: string | null
  pgSslMode: string | undefined
  publicOrigin: string | undefined
  /**
   * PUBLIC_ORIGIN is https: every response gets HSTS and every cookie is Secure, under its __Host- name.
   * (app.ts does the same for any request that reached Caddy over https, whatever PUBLIC_ORIGIN says.)
   */
  secureCookies: boolean
  serveApp: boolean
  appFile: string
  /** Development only: one extra origin allowed to call the API with credentials (CORS). */
  allowedOrigin: string | undefined
  sessionIdleHours: number
  sessionMaxDays: number
  migrateOnStart: boolean
  /** Fastify trustProxy: which proxies may set X-Forwarded-For (default: loopback, i.e. Caddy). */
  trustProxy: string | boolean
  logLevel: string
  rootDir: string
}

type Env = Record<string, string | undefined>

/** Parses a .env file: KEY=value lines, # comments, optional `export `, single or double quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    let value = m[2]
    if (value.startsWith('"')) {
      const end = findClosingQuote(value)
      value = value
        .slice(1, end === -1 ? undefined : end)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1)
      value = value.slice(1, end === -1 ? undefined : end)
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    out[key] = value
  }
  return out
}

function findClosingQuote(value: string): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === '\\') i++
    else if (value[i] === '"') return i
  }
  return -1
}

/** Loads `file` into `env` without overriding variables that are already set. Returns the keys loaded. */
export function loadDotEnv(file: string, env: Env = process.env): string[] {
  if (!existsSync(file)) return []
  const parsed = parseDotEnv(readFileSync(file, 'utf8'))
  const loaded: string[] = []
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined) {
      env[k] = v
      loaded.push(k)
    }
  }
  return loaded
}

/** The repo (or install) root: the nearest folder above this module with a package.json, else the cwd. */
export function findRootDir(start = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = start
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback
  return /^(1|true|yes|on)$/i.test(value.trim())
}

function positiveInt(env: Env, key: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0 || n > max) throw new ConfigError(`${key} must be a whole number between 1 and ${max} (got "${raw}").`)
  return n
}

function origin(env: Env, key: string): string | undefined {
  const raw = env[key]?.trim()
  if (!raw) return undefined
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol')
    return u.origin
  } catch {
    throw new ConfigError(`${key} must be an origin like https://hr.example.com (got "${raw}").`)
  }
}

export type LoadConfigOptions = {
  /** Read <root>/.env first (default true). Tests pass false. */
  dotenv?: boolean
  rootDir?: string
  /** Called with warnings (default console.warn). */
  warn?: (message: string) => void
}

export function loadConfig(env: Env = process.env, options: LoadConfigOptions = {}): Config {
  const rootDir = options.rootDir ?? findRootDir()
  const warn = options.warn ?? ((m: string) => console.warn(`[first-twenty] ${m}`))
  if (options.dotenv !== false) loadDotEnv(path.join(rootDir, '.env'), env)

  const rawEnv = (env.NODE_ENV ?? 'development').trim()
  const nodeEnv: NodeEnv = rawEnv === 'production' ? 'production' : rawEnv === 'test' ? 'test' : 'development'
  const production = nodeEnv === 'production'

  let databaseUrl = env.DATABASE_URL?.trim() ?? ''
  if (!databaseUrl) {
    if (production) {
      throw new ConfigError(
        'DATABASE_URL is not set. In production it must point at Postgres, for example ' +
          'postgres://first_twenty:CHANGE_ME@127.0.0.1:5432/first_twenty (set it in /etc/first-twenty/env).',
      )
    }
    databaseUrl = 'pglite:./.data/pg'
  }

  let pgliteDir: string | null = null
  if (databaseUrl.startsWith('pglite:')) {
    if (production) {
      throw new ConfigError('DATABASE_URL uses PGlite, which is for development and tests only. Use a postgres:// URL in production.')
    }
    const dir = databaseUrl.slice('pglite:'.length).trim()
    pgliteDir = dir === '' || dir === 'memory' || dir === 'memory://' ? 'memory' : path.resolve(rootDir, dir)
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new ConfigError('DATABASE_URL must start with postgres:// or postgresql:// (or pglite: in development).')
  } else if (production && databaseUrl.includes('CHANGE_ME')) {
    throw new ConfigError('DATABASE_URL still contains the CHANGE_ME placeholder. Put the real database password in /etc/first-twenty/env.')
  }

  const publicOrigin = origin(env, 'PUBLIC_ORIGIN')
  const secureCookies = publicOrigin?.startsWith('https:') ?? false
  const onlyViaCaddy = 'only requests that arrive through Caddy over https get Secure cookies and HSTS'
  if (production && !publicOrigin) warn(`PUBLIC_ORIGIN is not set, so ${onlyViaCaddy}. Set it to https://your-domain.`)
  else if (production && !secureCookies) warn(`PUBLIC_ORIGIN is not https, so ${onlyViaCaddy}. Set it to https://your-domain once the site is public.`)

  const allowedOrigin = origin(env, 'ALLOWED_ORIGIN')
  if (production && allowedOrigin) {
    throw new ConfigError('ALLOWED_ORIGIN is for development only. Remove it in production: the server serves the app itself, same-origin.')
  }

  const serveApp = bool(env.SERVE_APP, false)
  const appFile = path.resolve(rootDir, env.APP_FILE?.trim() || 'first-twenty.html')
  if (serveApp && !existsSync(appFile)) {
    throw new ConfigError(`SERVE_APP=true but the app file ${appFile} does not exist. Run "npm run build" or set APP_FILE.`)
  }

  const trustRaw = env.TRUST_PROXY?.trim()
  const trustProxy: string | boolean =
    !trustRaw ? 'loopback' : /^(false|0|no|off)$/i.test(trustRaw) ? false : /^(true|yes|on)$/i.test(trustRaw) ? true : trustRaw

  const pgSslMode = env.PGSSLMODE?.trim() || undefined
  if (pgSslMode && !['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify'].includes(pgSslMode)) {
    throw new ConfigError(`PGSSLMODE "${pgSslMode}" is not recognized (use disable, require, verify-full or no-verify).`)
  }

  return {
    nodeEnv,
    port: positiveInt(env, 'PORT', 8787, 65535),
    host: env.HOST?.trim() || '127.0.0.1',
    databaseUrl,
    pgliteDir,
    pgSslMode,
    publicOrigin,
    secureCookies,
    serveApp,
    appFile,
    allowedOrigin,
    sessionIdleHours: positiveInt(env, 'SESSION_IDLE_HOURS', 12, 24 * 365),
    sessionMaxDays: positiveInt(env, 'SESSION_MAX_DAYS', 7, 365),
    migrateOnStart: bool(env.MIGRATE_ON_START, pgliteDir !== null),
    trustProxy,
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    rootDir,
  }
}

/** A config for tests and tools: in-memory PGlite, nothing served, development defaults. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    port: 8787,
    host: '127.0.0.1',
    databaseUrl: 'pglite:memory',
    pgliteDir: 'memory',
    pgSslMode: undefined,
    publicOrigin: undefined,
    secureCookies: false,
    serveApp: false,
    appFile: path.join(findRootDir(), 'first-twenty.html'),
    allowedOrigin: undefined,
    sessionIdleHours: 12,
    sessionMaxDays: 7,
    migrateOnStart: true,
    trustProxy: 'loopback',
    logLevel: 'silent',
    rootDir: findRootDir(),
    ...overrides,
  }
}
