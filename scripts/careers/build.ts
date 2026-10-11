// Static careers site for the First Twenty demo: the Ledgerlark sample's open jobs as plain HTML pages,
// one CSS file, one small script for the demo apply form, and the Archivo font. No external requests,
// relative links only, so the folder works under any GitHub Pages subpath (the app sits one level up).
//
// Run: npx tsx scripts/careers/build.ts --out <dir>     (npm run build:careers writes dist-careers/)
//
// Ledgerlark, Inc. is fictional (docs/SAMPLE.md). Every page says so, and the apply form sends nothing:
// it has no action, uses method="dialog" (which never navigates or submits anywhere) and its script
// only validates in the tab.
//
// The sample's dates move with the calendar (loadSample shifts them by whole weeks), so rebuild this
// site in the same publish step as the app or its posted dates drift away from the app's.
//
// --app-href <path or URL> points the "hiring side" links somewhere other than the app one folder up
// (a relative path is taken from the site root; the app's hash routes are appended either way).
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { links } from '@/app/router'
import { eeoStatement, fairChanceStatement, payRangeLine, postingText } from '@/domain/hiring/postings'
import { headcountOn } from '@/domain/people'
import type { DB, Job } from '@/domain/types'
import { fmtDate, type ISODate, today } from '@/lib/dates'
import { slug as slugify } from '@/lib/files'
import { loadSample } from '@/store/db'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const FONT_DIR = join(repoRoot, 'src/themes/sleek/fonts')
const FONT_FILE = 'archivo-latin-standard-normal.woff2'
const FONT_LICENSE = 'LICENSE-Archivo.txt'

export type CareerJob = {
  id: string
  slug: string
  title: string
  team: string
  teamId: string
  location: string
  workMode: string
  employment: string
  /** "$225,000 to $285,000", from the posting's own pay line; null when the job has no range. */
  payFigure: string | null
  /** "Base salary, plus equity" and the like, read from the posting's pay lines. */
  payNote: string
  postedOn: ISODate
  posting: string
  question: string
}

export type CareersBuild = { outDir: string; date: ISODate; company: string; jobs: CareerJob[]; files: string[] }

export type CareersOptions = {
  /** Where the First Twenty app lives. Default: index.html one folder above the site root. */
  appHref?: string
}

/** The app's default place: the careers folder sits beside the app's index.html. */
export const DEFAULT_APP_HREF = '../index.html'

// ---- Helpers --------------------------------------------------------------------------------------

/** Escapes text for HTML element content and double-quoted attributes. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

/** Prose lines end with punctuation; a tagline stored without a period gets one. */
export function sentence(s: string): string {
  const t = s.trim()
  return !t || /[.!?:;)"'”]$/.test(t) ? t : `${t}.`
}

/**
 * A link into the First Twenty app from a page `depth` folders below the site root, opening the
 * app's own hash route (links.hiring / links.job from src/app/router.ts). An absolute base (a URL or a
 * root path) is used as is; a relative one is resolved from the site root.
 */
export function appHref(depth: number, hash: string, base: string = DEFAULT_APP_HREF): string {
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(base) || base.startsWith('/')
  const path = (absolute ? base : '../'.repeat(depth) + base).replace(/#.*$/, '')
  return hash ? `${path}${hash.startsWith('#') ? hash : `#${hash}`}` : path
}

/** What the careers site lists: open, posted on or before the date, and not a request awaiting approval. */
export function isPublicJob(job: Job, date: ISODate): boolean {
  return job.status === 'open' && !!job.postedOn && job.postedOn <= date && job.requisition?.status !== 'pending'
}

/** One question per role family for the apply form. Never pay history, never criminal history. */
function roleQuestion(job: Job): string {
  switch (job.familyId) {
    case 'f-ml':
      return 'Tell us about an evaluation you designed that changed a decision about a model. What did it measure?'
    case 'f-eng':
      return 'Tell us about software you built that people trusted to be correct. How did you know it was?'
    case 'f-gtm':
      return 'Tell us about a deal you found and closed yourself. What made it close?'
    case 'f-acct':
      return 'Walk us through a close or reconciliation problem you untangled. What was the fix?'
    case 'f-solutions':
      return 'Tell us about a customer rollout that went sideways. What did you do next?'
    case 'f-product':
    case 'f-design':
      return 'Tell us about a product decision you changed your mind on, and why.'
    default:
      return 'What about this role made you want to apply?'
  }
}

// ---- Posting text -> HTML -------------------------------------------------------------------------

export type ParsedPosting = { title: string; location: string; workMode: string; employment: string; blocks: string[][] }

/** Splits postingText output: title, the location line, then blank-line blocks of trimmed lines. */
export function parsePosting(text: string): ParsedPosting {
  const lines = text.replace(/\r/g, '').trimEnd().split('\n')
  const title = (lines[0] ?? '').trim()
  const sub = (lines[1] ?? '').trim()
  const m = /^(.*) \((remote|on site|hybrid)\) \| (.+)$/.exec(sub)
  const blocks = lines
    .slice(2)
    .join('\n')
    .split(/\n\s*\n/)
    .map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean))
    .filter((b) => b.length > 0)
  return { title, location: m ? m[1] : sub, workMode: m ? m[2] : '', employment: m ? m[3] : '', blocks }
}

const BULLET = /^[-•*]\s+(.*)$/

function isHeading(line: string): boolean {
  return line.length <= 60 && !BULLET.test(line) && !/[.!?:;,]$/.test(line)
}

function renderLines(lines: string[]): string {
  const out: string[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length) out.push(`<ul class="ticks">\n${list.map((li) => `<li>${esc(li)}</li>`).join('\n')}\n</ul>`)
    list = []
  }
  for (const line of lines) {
    const bullet = BULLET.exec(line)
    if (bullet) {
      list.push(bullet[1])
      continue
    }
    flush()
    const fact = /^(Pay range|Equity|Benefits):\s+(.*)$/.exec(line)
    out.push(fact ? `<p><strong>${esc(fact[1])}:</strong> ${esc(sentence(fact[2]))}</p>` : `<p>${esc(sentence(line))}</p>`)
  }
  flush()
  return out.join('\n')
}

/**
 * The posting body as HTML. A block whose first line reads as a heading becomes a section with an h2.
 * The generated tail (sponsorship, background check, Fair Chance and EEO lines) sits under one
 * "Hiring practices" heading so it never reads as part of the section above it.
 */
export function postingBodyHtml(blocks: string[][], companyName: string): string {
  const legalLines = new Set([fairChanceStatement(companyName), eeoStatement(companyName)])
  const isLegal = (block: string[]) =>
    block.every(
      (l) =>
        legalLines.has(l) ||
        /^(We sponsor work visas|We are not able to sponsor|Visa sponsorship for this role)/.test(l) ||
        /^Offers depend on a background check/.test(l),
    )
  const parts: string[] = []
  const legal: string[] = []
  let sawLead = false
  let afterSection = false
  for (const block of blocks) {
    if (block.length > 1 && isHeading(block[0])) {
      parts.push(`<section class="psec">\n<h2 class="psec__h">${esc(block[0])}</h2>\n${renderLines(block.slice(1))}\n</section>`)
      afterSection = true
      continue
    }
    if (isLegal(block)) {
      legal.push(renderLines(block))
      continue
    }
    const cls = !sawLead ? 'pblock pblock--lead' : afterSection ? 'pblock pblock--after' : 'pblock'
    sawLead = true
    afterSection = false
    parts.push(`<div class="${cls}">\n${renderLines(block)}\n</div>`)
  }
  if (legal.length) parts.push(`<section class="psec psec--fine">\n<h2 class="psec__h">Hiring practices</h2>\n${legal.join('\n')}\n</section>`)
  return parts.join('\n')
}

// ---- Data -----------------------------------------------------------------------------------------

function careerJobs(db: DB, date: ISODate): CareerJob[] {
  const used = new Set<string>()
  const deptOrder = new Map(db.departments.map((d, i) => [d.id, i]))
  const jobs = db.jobs
    .filter((j) => isPublicJob(j, date))
    .sort(
      (a, b) =>
        (deptOrder.get(a.departmentId) ?? 99) - (deptOrder.get(b.departmentId) ?? 99) ||
        (b.postedOn ?? '').localeCompare(a.postedOn ?? '') ||
        a.title.localeCompare(b.title),
    )
  return jobs.map((job) => {
    const posting = postingText(db, job.id, date)
    const parsed = parsePosting(posting)
    let s = slugify(job.title) || slugify(job.id) || 'job'
    for (let n = 2; used.has(s); n++) s = `${slugify(job.title)}-${n}`
    used.add(s)
    const payLine = payRangeLine(job)
    const pm = payLine ? /^Pay range: (.+?) (base salary|an hour)\. /.exec(payLine) : null
    const hourly = pm?.[2] === 'an hour'
    const lines = posting.split('\n')
    const variable = lines.find((l) => l.startsWith('Plus variable pay'))
    const extras: string[] = []
    if (variable) extras.push(variable.includes('(commission)') ? 'commission' : 'variable pay')
    if (lines.some((l) => l.startsWith('Equity:'))) extras.push('equity')
    const basis = !pm ? 'Pay range available on request' : hourly ? 'Hourly' : 'Base salary'
    const dept = db.departments.find((d) => d.id === job.departmentId)
    // A hybrid job that also lists a remote location (San Jose or Remote (California)) is open to
    // remote people too, so the short work-mode label says both, as the posting's own text does.
    const remoteToo = job.workMode === 'hybrid' && job.locationIds.some((id) => db.locations.find((l) => l.id === id)?.kind === 'remote')
    return {
      id: job.id,
      slug: s,
      title: parsed.title || job.title,
      team: dept?.name ?? 'Team',
      teamId: dept?.id ?? 'team',
      location: parsed.location,
      workMode: remoteToo ? 'Hybrid or remote' : cap(parsed.workMode),
      employment: parsed.employment,
      payFigure: pm ? (hourly ? `${pm[1]} an hour` : pm[1]) : null,
      payNote: extras.length ? `${basis}, plus ${extras.join(' and ')}` : basis,
      postedOn: job.postedOn as ISODate,
      posting,
      question: roleQuestion(job),
    }
  })
}

// ---- Page shell -----------------------------------------------------------------------------------

type Shell = {
  title: string
  description: string
  depth: 0 | 1
  company: string
  body: string
  /** The masthead's app link: the hiring side for this page (the job's pipeline on a job page). */
  appLink: string
  /** The footer's app link: the hiring overview. */
  appHome: string
  script?: boolean
}

function shell(p: Shell): string {
  const up = p.depth ? '../' : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<meta name="description" content="${esc(p.description)}">
<title>${esc(p.title)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${up}assets/careers.css">
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<header class="masthead">
<div class="wrap masthead__bar">
<a class="brand" href="${up}index.html"><span class="brand__mark" aria-hidden="true"></span><span class="brand__name">${esc(p.company)}</span><span class="brand__sub">Careers</span></a>
<nav class="masthead__nav" aria-label="Demo">
<a class="masthead__demo" href="${esc(p.appLink)}">See the hiring side in First Twenty<span aria-hidden="true">&nbsp;→</span></a>
</nav>
</div>
</header>
<main id="main" tabindex="-1">
<div class="wrap">
<p class="fiction"><span class="fiction__tag">Demo</span><span>${esc(p.company)} is a fictional company used to demo First Twenty. These jobs are not real, and applying sends nothing.</span></p>
${p.body}
</div>
</main>
<footer class="foot">
<div class="wrap">
<div class="foot__grid">
<p class="foot__note"><strong>${esc(p.company)} is fictional.</strong> Its people, jobs and investors are sample data in First Twenty, a hiring and HR app for a company's first twenty people. Nothing here is a real job, and the application form never sends or stores what you type.</p>
<ul class="foot__links">
<li><a href="${esc(p.appHome)}">See the hiring side in First Twenty</a></li>
<li><a href="${up}assets/${FONT_LICENSE}">Archivo typeface license (SIL OFL 1.1)</a></li>
</ul>
</div>
</div>
</footer>
${p.script ? `<script src="${up}assets/apply.js" defer></script>\n` : ''}</body>
</html>
`
}

// ---- Pages ----------------------------------------------------------------------------------------

function indexPage(db: DB, date: ISODate, jobs: CareerJob[], appBase: string): string {
  const c = db.company
  const hiring = appHref(0, links.hiring('jobs'), appBase)
  const name = c.name
  const teams: Array<{ id: string; name: string; jobs: CareerJob[] }> = []
  for (const j of jobs) {
    let t = teams.find((x) => x.id === j.teamId)
    if (!t) teams.push((t = { id: j.teamId, name: j.team, jobs: [] }))
    t.jobs.push(j)
  }
  const founded = (c.foundedOn ?? '').slice(0, 4)
  const people = headcountOn(db, date)
  const facts = [c.stage ? `${c.stage} stage` : '', c.hq?.city ? `Headquartered in ${c.hq.city}, ${c.hq.state}` : '', c.workweek ?? '']
    .filter(Boolean)
    .map((f) => `<li>${esc(f)}</li>`)
    .join('')
  const figure = (label: string, value: string) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`
  const roleRow = (j: CareerJob) => `<li class="role">
<div class="role__main">
<h4 class="role__title"><a class="role__link" href="jobs/${j.slug}.html">${esc(j.title)}</a></h4>
<p class="role__meta">${esc([j.location, j.workMode, j.employment].filter(Boolean).join(' · '))}</p>
</div>
<div class="role__side">
<p class="role__pay"><span class="vh">Pay range: </span>${esc(j.payFigure ?? 'Pay range on request')}</p>
<p class="role__note">${esc(j.payNote)}</p>
<p class="role__posted">Posted <time datetime="${j.postedOn}">${esc(fmtDate(j.postedOn))}</time></p>
</div>
</li>`
  // A per-team count only says something when some team has more than one role; it sits outside the
  // heading so the heading reads as the team's name alone.
  const showCounts = teams.some((t) => t.jobs.length > 1)
  const teamBlocks = teams.length
    ? teams
        .map(
          (t) => `<section class="team" aria-labelledby="team-${t.id}">
<div class="team__head">
<h3 class="team__name" id="team-${t.id}">${esc(t.name)}</h3>
${showCounts ? `<p class="team__count">${t.jobs.length} ${t.jobs.length === 1 ? 'role' : 'roles'}</p>\n` : ''}</div>
<ul class="roles">
${t.jobs.map(roleRow).join('\n')}
</ul>
</section>`,
        )
        .join('\n')
    : `<p class="empty">No open roles right now. Check back soon.</p>`
  const body = `<div class="pagehead">
<p class="kicker">Careers</p>
<h1 class="pagehead__title">Work at ${esc(name)}</h1>
${c.tagline?.trim() ? `<p class="lede">${esc(sentence(c.tagline))}</p>` : ''}
<ul class="facts-line">${facts}</ul>
<dl class="figures">
${figure('Open roles', String(jobs.length))}
${figure('Teams hiring', String(teams.length))}
${figure('People', String(people))}
${founded ? figure('Founded', founded) : ''}
</dl>
</div>
<section class="section" aria-labelledby="roles-h">
<div class="section__head"><h2 class="label" id="roles-h">Open roles</h2></div>
${teamBlocks}
</section>
<section class="section about" aria-labelledby="about-h">
<div class="section__head"><h2 class="label" id="about-h">About these pages</h2></div>
<div class="about__grid">
<p class="about__text">Every posting here is generated by First Twenty from the job record, with the pay range California requires, benefits, Fair Chance and equal opportunity language included. The apply form is a demo: nothing you type is sent or stored.</p>
<p class="about__action"><a class="btn btn--secondary btn--lg" href="${esc(hiring)}">See the hiring side in First Twenty<span aria-hidden="true">&nbsp;→</span></a></p>
</div>
</section>`
  return shell({
    title: `Careers at ${name} (demo)`,
    description: `Open roles at ${name}, a fictional company used to demo First Twenty.`,
    depth: 0,
    company: name,
    body,
    appLink: hiring,
    appHome: hiring,
  })
}

function jobPage(db: DB, j: CareerJob, appBase: string): string {
  const name = db.company.name
  const pipeline = appHref(1, links.job(j.id), appBase)
  const meta = [j.location, j.workMode, j.employment].filter(Boolean).join(' · ')
  const parsed = parsePosting(j.posting)
  const fact = (label: string, value: string, cls = '') => `<div${cls ? ` class="${cls}"` : ''}><dt>${esc(label)}</dt><dd>${value}</dd></div>`
  const field = (o: { id: string; label: string; type: string; auto?: string; mode?: string; optional?: boolean; hint?: string }) => {
    const described = [o.hint ? `${o.id}-hint` : '', `${o.id}-error`].filter(Boolean).join(' ')
    return `<div class="field">
<label class="field__label" for="${o.id}">${esc(o.label)}${o.optional ? ' <span class="opt">(optional)</span>' : ''}</label>
${o.hint ? `<p class="field__hint" id="${o.id}-hint">${esc(o.hint)}</p>\n` : ''}<input class="input" id="${o.id}" name="${o.id.slice(2)}" type="${o.type}"${o.auto ? ` autocomplete="${o.auto}"` : ''}${o.mode ? ` inputmode="${o.mode}"` : ''}${o.optional ? '' : ' required'} aria-describedby="${described}">
<p class="field__error" id="${o.id}-error" hidden></p>
</div>`
  }
  const body = `<p class="crumbs"><a class="back" href="../index.html"><span aria-hidden="true">←&nbsp;</span>All open roles</a></p>
<div class="pagehead pagehead--job">
<div class="pagehead__text">
<p class="kicker">${esc(j.team)}</p>
<h1 class="pagehead__title" id="job-title">${esc(j.title)}</h1>
<p class="subtitle">${esc(meta)}</p>
</div>
<a class="btn btn--primary btn--lg" href="#apply">Apply for this role</a>
</div>
<div class="job">
<aside class="facts" aria-labelledby="facts-h">
<div class="facts__inner">
<h2 class="label facts__h" id="facts-h">At a glance</h2>
<dl class="facts__list">
${fact('Pay range', `<span class="fig">${esc(j.payFigure ?? 'On request')}</span><span class="facts__sub">${esc(j.payNote)}</span>`, 'facts__pay')}
${fact('Location', esc(j.location))}
${fact('Work mode', esc(j.workMode))}
${fact('Employment', esc(j.employment))}
${fact('Team', esc(j.team))}
${fact('Posted', `<time datetime="${j.postedOn}">${esc(fmtDate(j.postedOn))}</time>`)}
${fact('Status', '<span class="status status--good"><span class="status__mark" aria-hidden="true"></span>Open</span>')}
</dl>
<p class="facts__apply"><a class="btn btn--primary btn--lg btn--block" href="#apply">Apply for this role</a></p>
</div>
</aside>
<article class="posting" aria-labelledby="job-title">
${postingBodyHtml(parsed.blocks, name)}
</article>
</div>
<section class="apply" id="apply" aria-labelledby="apply-h">
<div class="apply__grid">
<div class="apply__intro">
<div class="apply__sticky">
<h2 class="apply__h" id="apply-h"><span class="label">Apply</span><span class="vh"> for </span><span class="apply__title">${esc(j.title)}</span></h2>
<p class="apply__meta">${esc(meta)}</p>
<p class="apply__pay"><span class="vh">Pay range: </span><span class="fig">${esc(j.payFigure ?? 'Pay range on request')}</span><span class="facts__sub">${esc(j.payNote)}</span></p>
</div>
</div>
<div class="apply__body">
<div class="demo-note" id="apply-demo" role="note">
<p class="demo-note__lead">This is a demo. Nothing you enter here is sent or stored.</p>
<p>${esc(name)} is a fictional company, so this form goes nowhere. It checks your answers in this browser tab, shows a confirmation, and clears itself.</p>
</div>
<form class="form" id="apply-form" method="dialog" novalidate aria-describedby="apply-demo">
<div class="errors" id="apply-errors" role="group" aria-labelledby="apply-errors-h" tabindex="-1" hidden>
<h3 class="errors__title" id="apply-errors-h"></h3>
<ul class="errors__list"></ul>
</div>
<p class="form__req">All fields are required unless marked optional.</p>
${field({ id: 'f-name', label: 'Full name', type: 'text', auto: 'name' })}
${field({ id: 'f-email', label: 'Email', type: 'email', auto: 'email', mode: 'email' })}
${field({ id: 'f-phone', label: 'Phone', type: 'tel', auto: 'tel', mode: 'tel', optional: true })}
${field({ id: 'f-link', label: 'LinkedIn or portfolio', type: 'url', auto: 'url', mode: 'url', optional: true, hint: 'A web address, like linkedin.com/in/yourname' })}
<div class="field">
<label class="field__label" for="f-resume">Resume <span class="opt">(optional)</span></label>
<p class="field__hint" id="f-resume-hint">PDF, Word or text file, up to 10 MB. The demo looks at the file name and size in this tab and never uploads it.</p>
<input class="file" id="f-resume" name="resume" type="file" accept=".pdf,.doc,.docx,.txt,.rtf,.odt" aria-describedby="f-resume-hint f-resume-error">
<p class="field__error" id="f-resume-error" hidden></p>
</div>
<div class="field">
<label class="field__label" for="f-answer">${esc(j.question)}</label>
<p class="field__hint" id="f-answer-hint">A few sentences is plenty. If you need an accommodation to apply or interview, you can say so here too.</p>
<textarea class="input textarea" id="f-answer" name="answer" rows="6" maxlength="2000" required aria-describedby="f-answer-hint f-answer-error"></textarea>
<p class="field__error" id="f-answer-error" hidden></p>
</div>
<div class="selfid" role="note" aria-labelledby="selfid-h">
<h3 class="selfid__h" id="selfid-h">Voluntary self-identification</h3>
<p>${esc(name)} may invite applicants to share gender, race or ethnicity, veteran status and disability status. Answering is always voluntary and declining never affects your application. Answers are kept apart from your application, are not seen by the people making the hiring decision, and are used only for equal opportunity reporting under California and federal law. This demo form does not ask.</p>
</div>
<div class="form__actions">
<button class="btn btn--primary btn--lg" type="submit">Submit application</button>
<p class="form__fine">Demo: submitting shows a confirmation and sends nothing.</p>
</div>
<noscript><p class="form__fine">This demo form needs JavaScript to check your answers. Without it the button does nothing, and nothing is ever sent.</p></noscript>
</form>
<div class="done" id="apply-done" hidden>
<p class="status status--good done__status"><span class="status__mark" aria-hidden="true"></span>Demo complete</p>
<h3 class="done__title" id="apply-done-h" tabindex="-1">Nothing was sent or stored</h3>
<p id="apply-done-thanks">Thanks for trying the demo.</p>
<p>${esc(name)} is a fictional company used to demo First Twenty, so your application did not go to anyone. What you typed never left this browser tab, and the form has been cleared.</p>
<p>In a real First Twenty workspace, an application like this lands in the hiring team's pipeline for the job.</p>
<div class="done__actions">
<a class="btn btn--secondary btn--lg" href="${esc(pipeline)}">See this job's pipeline in First Twenty</a>
<button class="btn btn--ghost btn--lg" type="button" id="apply-again">Start over</button>
</div>
</div>
</div>
</div>
</section>`
  return shell({
    title: `${j.title} at ${name} (demo careers)`,
    description: `${j.title}, ${j.location}. ${j.payFigure ? `Pay range ${j.payFigure}. ` : ''}${name} is a fictional company used to demo First Twenty.`,
    depth: 1,
    company: name,
    body,
    appLink: pipeline,
    appHome: appHref(1, links.hiring('jobs'), appBase),
    script: true,
  })
}

// ---- Build ----------------------------------------------------------------------------------------

/** Builds the sample workspace for today (the app's own seed and date shift) and writes the site. */
export function buildCareers(outDir: string, options: CareersOptions = {}): CareersBuild {
  const appBase = options.appHref?.trim() || DEFAULT_APP_HREF
  const date = today()
  const db = loadSample()
  const jobs = careerJobs(db, date)
  const out = resolve(outDir)
  const jobsDir = join(out, 'jobs')
  const assets = join(out, 'assets')
  mkdirSync(jobsDir, { recursive: true })
  mkdirSync(assets, { recursive: true })
  // Drop job pages from an earlier build (a role that closed since); only .html files this tool writes.
  for (const f of readdirSync(jobsDir)) if (f.endsWith('.html')) rmSync(join(jobsDir, f))
  const files: string[] = []
  const write = (rel: string, text: string) => {
    writeFileSync(join(out, rel), text, 'utf8')
    files.push(rel)
  }
  const copy = (from: string, rel: string) => {
    if (!existsSync(from)) throw new Error(`Missing ${from}`)
    copyFileSync(from, join(out, rel))
    files.push(rel)
  }
  write('index.html', indexPage(db, date, jobs, appBase))
  for (const j of jobs) write(`jobs/${j.slug}.html`, jobPage(db, j, appBase))
  copy(join(here, 'careers.css'), 'assets/careers.css')
  copy(join(here, 'apply.js'), 'assets/apply.js')
  copy(join(FONT_DIR, FONT_FILE), `assets/${FONT_FILE}`)
  copy(join(FONT_DIR, FONT_LICENSE), `assets/${FONT_LICENSE}`)
  return { outDir: out, date, company: db.company.name, jobs, files }
}

function isMain(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return pathToFileURL(resolve(entry)).href.toLowerCase() === import.meta.url.toLowerCase()
}

if (isMain()) {
  const arg = (flag: string) => {
    const i = process.argv.indexOf(flag)
    return i > -1 ? process.argv[i + 1] : undefined
  }
  const outArg = arg('--out')
  if (!outArg) {
    console.error('Usage: npx tsx scripts/careers/build.ts --out <dir> [--app-href <path or URL>]')
    process.exit(1)
  }
  const result = buildCareers(outArg, { appHref: arg('--app-href') })
  console.log(`Careers site for ${result.company} (${result.date}): ${result.jobs.length} open roles, ${result.files.length} files in ${result.outDir}`)
}
