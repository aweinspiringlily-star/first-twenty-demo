// Starts the First Twenty server: load settings, open the database, migrate when MIGRATE_ON_START=true
// (the default for PGlite in development), listen on HOST:PORT and shut down cleanly on SIGTERM/SIGINT.
import { buildApp } from './app'
import { purgeSessions } from './auth'
import { type Config, loadConfig } from './config'
import { openDb } from './db'
import { ConfigError } from './errors'
import { migrate, unappliedMigrations } from './migrate'
import { pruneChangeLog } from './repo'

const DAY_MS = 86_400_000

function describeDb(config: Config): string {
  if (config.pgliteDir) return config.pgliteDir === 'memory' ? 'PGlite (in memory)' : `PGlite at ${config.pgliteDir}`
  try {
    const u = new URL(config.databaseUrl)
    return `Postgres at ${u.hostname}:${u.port || '5432'}${u.pathname}` // never the password
  } catch {
    return 'Postgres'
  }
}

async function main(): Promise<void> {
  let config: Config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[first-twenty] ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  const db = await openDb(config, (err) => console.error('[first-twenty] database connection error:', err.message))
  if (config.migrateOnStart) {
    const { applied } = await migrate(db, { log: (m) => console.log(`[first-twenty] ${m}`) })
    if (applied.length === 0) console.log('[first-twenty] Database schema is up to date.')
  } else {
    // Starts anyway (the schema owner may be about to migrate), but says so loudly; /api/health answers
    // 503 until the migrations are in.
    const pending = await unappliedMigrations(db).catch(() => [])
    if (pending.length > 0) {
      console.error(
        `[first-twenty] The database is missing ${pending.join(', ')}. Run "npm run server:migrate" (on EC2: ` +
          'bash server/deploy/with-env.sh npm run server:migrate), then restart. Sign-in fails until then.',
      )
    }
  }

  const app = await buildApp({ db, config })

  // Housekeeping once a day: expired sessions and change-log rows older than 120 days.
  const housekeeping = async () => {
    try {
      await purgeSessions(db, config)
      const pruned = await pruneChangeLog(db, 120)
      if (pruned > 0) app.log.info({ pruned }, 'pruned old change-log rows')
    } catch (err) {
      app.log.error({ err }, 'housekeeping failed')
    }
  }
  const timer = setInterval(housekeeping, DAY_MS)
  timer.unref()

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    app.log.info({ signal }, 'shutting down')
    clearInterval(timer)
    const force = setTimeout(() => process.exit(1), 10_000)
    force.unref()
    try {
      await app.close()
      await db.close()
      process.exit(0)
    } catch (err) {
      app.log.error({ err }, 'shutdown failed')
      process.exit(1)
    }
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  await app.listen({ host: config.host, port: config.port })
  app.log.info(
    { db: describeDb(config), serveApp: config.serveApp, env: config.nodeEnv },
    `First Twenty server listening on http://${config.host}:${config.port}`,
  )
  void housekeeping()
}

main().catch((err) => {
  console.error('[first-twenty] failed to start:', err instanceof Error ? err.message : err)
  process.exit(1)
})
