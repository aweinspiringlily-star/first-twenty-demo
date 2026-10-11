// A throwaway local copy of the whole stack for end-to-end testing: the built server (dist-server) with
// its own PGlite database, serving the built app (first-twenty.html) same-origin, the way production
// does, plus an admin login with a random password made for this run.
//
//   node scripts/e2e/stack.mjs start <port> <stateDir>   starts it in the background, waits until healthy
//   node scripts/e2e/stack.mjs stop <stateDir>           stops it
//
// Build first (npm run build:all). <stateDir> must be outside the repo; it gets the database (pg/), the
// server log (server.log), the process id (server.pid) and the test login (credentials.json: email,
// password, url). The password exists only in that file and in this local database. Never use it, or
// this script, against a real server.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const [command, ...rest] = process.argv.slice(2)
const die = (message) => {
  console.error(`stack: ${message}`)
  process.exit(1)
}

function stop(stateDir) {
  const pidFile = path.join(stateDir, 'server.pid')
  if (!existsSync(pidFile)) return console.log('stack: not running')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  try {
    process.kill(pid)
    console.log(`stack: stopped ${pid}`)
  } catch {
    console.log(`stack: ${pid} was not running`)
  }
  rmSync(pidFile, { force: true })
}

async function start(port, stateDir) {
  if (!/^\d{4,5}$/.test(port)) die('port must be a number such as 8901')
  if (path.resolve(stateDir).startsWith(root)) die('keep <stateDir> outside the repo')
  for (const f of ['dist-server/server.mjs', 'first-twenty.html']) {
    if (!existsSync(path.join(root, f))) die(`${f} is missing: run npm run build:all first`)
  }
  stop(stateDir)
  const pgDir = path.join(stateDir, 'pg')
  rmSync(pgDir, { recursive: true, force: true })
  mkdirSync(stateDir, { recursive: true })

  const url = `http://localhost:${port}`
  const credentials = { email: 'admin@e2e.test', password: randomBytes(18).toString('base64url'), url }
  writeFileSync(path.join(stateDir, 'credentials.json'), JSON.stringify(credentials, null, 2))
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    DATABASE_URL: `pglite:${pgDir}`,
    HOST: '127.0.0.1',
    PORT: port,
    PUBLIC_ORIGIN: url,
    SERVE_APP: 'true',
    APP_FILE: 'first-twenty.html',
    MIGRATE_ON_START: 'true',
    LOG_LEVEL: 'info',
  }
  delete env.ALLOWED_ORIGIN

  // PGlite allows one process at a time, so the admin is made before the server starts.
  const admin = spawnSync(process.execPath, ['server/src/cli/run.mjs', 'create-admin', '--email', credentials.email], {
    cwd: root,
    env: { ...env, ADMIN_PASSWORD: credentials.password },
    encoding: 'utf8',
  })
  if (admin.status !== 0) die(`create-admin failed: ${admin.stderr || admin.stdout}`)

  const log = openSync(path.join(stateDir, 'server.log'), 'a')
  const child = spawn(process.execPath, ['dist-server/server.mjs'], { cwd: root, env, detached: true, stdio: ['ignore', log, log] })
  child.unref()
  writeFileSync(path.join(stateDir, 'server.pid'), String(child.pid))

  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${url}/api/health`)
      if (res.ok) {
        console.log(`stack: ready at ${url} (pid ${child.pid}); login in ${path.join(stateDir, 'credentials.json')}`)
        return
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  stop(stateDir)
  die(`the server did not become healthy; see ${path.join(stateDir, 'server.log')}`)
}

if (command === 'start' && rest.length === 2) await start(rest[0], rest[1])
else if (command === 'stop' && rest.length === 1) stop(rest[0])
else die('usage: node scripts/e2e/stack.mjs start <port> <stateDir> | stop <stateDir>')
