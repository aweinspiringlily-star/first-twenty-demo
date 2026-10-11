import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, loadDotEnv, parseDotEnv } from './config'
import { ConfigError } from './errors'

const root = mkdtempSync(path.join(tmpdir(), 'ft-config-'))
const load = (env: Record<string, string | undefined>) => loadConfig(env, { dotenv: false, rootDir: root, warn: () => {} })

describe('parseDotEnv', () => {
  it('reads KEY=value lines with comments, export and quotes', () => {
    const text = [
      '# comment',
      'PORT=9000',
      'export HOST=0.0.0.0',
      'DATABASE_URL="postgres://first_twenty:CHANGE_ME@127.0.0.1:5432/first_twenty"',
      "SINGLE='a # not a comment'",
      'INLINE=value # trailing comment',
      'ESCAPED="line\\nnext"',
      'EMPTY=',
      'not a line',
    ].join('\r\n')
    expect(parseDotEnv(text)).toEqual({
      PORT: '9000',
      HOST: '0.0.0.0',
      DATABASE_URL: 'postgres://first_twenty:CHANGE_ME@127.0.0.1:5432/first_twenty',
      SINGLE: 'a # not a comment',
      INLINE: 'value',
      ESCAPED: 'line\nnext',
      EMPTY: '',
    })
  })

  it('never overrides variables that are already set', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ft-env-'))
    writeFileSync(path.join(dir, '.env'), 'PORT=9000\nHOST=0.0.0.0\n')
    const env: Record<string, string | undefined> = { PORT: '8000' }
    expect(loadDotEnv(path.join(dir, '.env'), env)).toEqual(['HOST'])
    expect(env).toEqual({ PORT: '8000', HOST: '0.0.0.0' })
  })
})

describe('loadConfig', () => {
  it('uses development defaults: PGlite in .data/pg, 127.0.0.1:8787, migrate on start', () => {
    const c = load({})
    expect(c.nodeEnv).toBe('development')
    expect(c.port).toBe(8787)
    expect(c.host).toBe('127.0.0.1')
    expect(c.pgliteDir).toBe(path.resolve(root, '.data/pg'))
    expect(c.migrateOnStart).toBe(true)
    expect(c.sessionIdleHours).toBe(12)
    expect(c.sessionMaxDays).toBe(7)
    expect(c.secureCookies).toBe(false)
    expect(c.appFile).toBe(path.join(root, 'first-twenty.html'))
    expect(c.trustProxy).toBe('loopback')
  })

  it('fails fast in production without DATABASE_URL', () => {
    expect(() => load({ NODE_ENV: 'production' })).toThrow(ConfigError)
    expect(() => load({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL is not set/)
  })

  it('refuses the CHANGE_ME placeholder in production', () => {
    expect(() => load({ NODE_ENV: 'production', DATABASE_URL: 'postgres://first_twenty:CHANGE_ME@127.0.0.1:5432/first_twenty' })).toThrow(
      /CHANGE_ME placeholder/,
    )
  })

  it('refuses PGlite and ALLOWED_ORIGIN in production', () => {
    expect(() => load({ NODE_ENV: 'production', DATABASE_URL: 'pglite:./x' })).toThrow(/development and tests only/)
    expect(() =>
      load({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u:placeholder@127.0.0.1/db', ALLOWED_ORIGIN: 'http://localhost:8826' }),
    ).toThrow(/development only/)
  })

  it('reads production settings', () => {
    const c = load({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://first_twenty:placeholder@127.0.0.1:5432/first_twenty',
      PUBLIC_ORIGIN: 'https://hr.example.com/',
      PORT: '9001',
      SESSION_IDLE_HOURS: '8',
      PGSSLMODE: 'disable',
    })
    expect(c.pgliteDir).toBeNull()
    expect(c.publicOrigin).toBe('https://hr.example.com')
    expect(c.secureCookies).toBe(true)
    expect(c.port).toBe(9001)
    expect(c.sessionIdleHours).toBe(8)
    expect(c.migrateOnStart).toBe(false)
    expect(c.pgSslMode).toBe('disable')
  })

  it('warns, but starts, in production while PUBLIC_ORIGIN is not https (the SSH-tunnel phase)', () => {
    const warnings: string[] = []
    const env = { NODE_ENV: 'production', DATABASE_URL: 'postgres://first_twenty:placeholder@127.0.0.1:5432/first_twenty' }
    const c = loadConfig({ ...env, PUBLIC_ORIGIN: 'http://localhost:8787' }, { dotenv: false, rootDir: root, warn: (m) => warnings.push(m) })
    expect(c.secureCookies).toBe(false)
    loadConfig(env, { dotenv: false, rootDir: root, warn: (m) => warnings.push(m) })
    expect(warnings).toEqual([
      expect.stringMatching(/^PUBLIC_ORIGIN is not https, so only requests that arrive through Caddy over https get Secure cookies and HSTS/),
      expect.stringMatching(/^PUBLIC_ORIGIN is not set, so only requests that arrive through Caddy over https/),
    ])
  })

  it('rejects malformed values with a clear message', () => {
    expect(() => load({ PORT: 'eighty' })).toThrow(/PORT must be a whole number/)
    expect(() => load({ DATABASE_URL: 'mysql://x' })).toThrow(/postgres:\/\//)
    expect(() => load({ PUBLIC_ORIGIN: 'hr.example.com' })).toThrow(/PUBLIC_ORIGIN/)
    expect(() => load({ SERVE_APP: 'true', APP_FILE: 'missing.html' })).toThrow(/does not exist/)
    expect(() => load({ PGSSLMODE: 'sometimes' })).toThrow(/PGSSLMODE/)
  })

  it('accepts pglite:memory', () => {
    expect(load({ DATABASE_URL: 'pglite:memory' }).pgliteDir).toBe('memory')
  })
})
