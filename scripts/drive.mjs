// Headless Chrome driver over CDP for QA scenarios (works when the built-in browser pane is busy).
// Usage: OUT_DIR=<scratch dir> PROFILE=<name> node scripts/drive.mjs scenario.mjs [--fresh]
// OUT_DIR holds the Chrome profile and screenshots (default: next to this script; keep it outside the repo).
// A scenario exports default async ({ nav, hash, js, sleep, shot, key, logs, takeLogs, viewport, dark }) => {}
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
const scenarioPath = resolve(process.argv[2])
const outDir = process.env.OUT_DIR || here
mkdirSync(outDir, { recursive: true })
const profile = join(outDir, process.env.PROFILE || 'profile')
if (process.argv.includes('--fresh')) rmSync(profile, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })
// Set PORT when running several scenarios in parallel so they never share a Chrome.
const port = Number(process.env.PORT) || 9700 + Math.floor(Math.random() * 90)
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let wsUrl
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    if (page) { wsUrl = page.webSocketDebuggerUrl; break }
  } catch {}
  await sleep(200)
}
if (!wsUrl) { console.error('no chrome'); chrome.kill(); process.exit(1) }
const ws = new WebSocket(wsUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
let logs = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning' || m.params.type === 'assert'))
    logs.push(`[console.${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 600))
  if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 800))
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('[log] ' + m.params.entry.text + ' ' + (m.params.entry.url ?? ''))
})
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable')
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
const js = async (body) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return 'EVAL ERROR: ' + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
  return r.result?.result?.value
}
const nav = async (url, wait = 1800) => { await send('Page.navigate', { url }); await sleep(wait) }
const hash = async (h, wait = 700) => { await js(`location.hash = ${JSON.stringify(h)}`); await sleep(wait) }
const KEYS = { Enter: 13, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Escape: 27, Tab: 9, Home: 36, End: 35 }
const key = async (k, mods = 0) => {
  const code = KEYS[k] ?? k.toUpperCase().charCodeAt(0)
  const isChar = k.length === 1 || k === 'Enter'
  const text = k === 'Enter' ? '\r' : k
  await send('Input.dispatchKeyEvent', { type: isChar ? 'keyDown' : 'rawKeyDown', key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: code, ...(isChar && !mods ? { text } : {}), modifiers: mods })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: code, modifiers: mods })
  await sleep(250)
}
const shot = async (name, full = false) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full })
  writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64'))
  return join(outDir, name)
}
const viewport = async (w, h) => {
  if (!w) await send('Emulation.clearDeviceMetricsOverride')
  else await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 768 })
  await sleep(300)
}
const dark = async (on) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: on ? 'dark' : 'light' }] })
const takeLogs = () => { const l = logs; logs = []; return l }
try {
  const mod = await import(pathToFileURL(scenarioPath).href + '?t=' + Date.now())
  await mod.default({ send, js, nav, hash, sleep, shot, key, viewport, dark, takeLogs, here })
} catch (e) {
  console.error('SCENARIO ERROR', e)
}
const rest = takeLogs()
if (rest.length) console.log('== remaining logs:\n' + rest.join('\n'))
ws.close(); chrome.kill()
process.exit(0)
