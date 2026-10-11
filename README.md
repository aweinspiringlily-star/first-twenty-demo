# First Twenty

**Live demo: https://unique-name27.github.io/first-twenty-demo/**

- **The app:** the full ATS and HCM with a fictional sample company, Ledgerlark. It runs entirely in
  your browser; nothing you type leaves it. Try Hiring, People, Comp and plan, and Compliance, or
  start fresh as a solo founder from Settings, Data.
- **Careers site:** https://unique-name27.github.io/first-twenty-demo/careers/ is generated from the
  app's own job postings (California pay-transparency ranges included). Its apply form is a demo and
  sends nothing.
- **Looks:** the Display menu (monitor icon, top right) switches between the default look, Trading
  desk, 1990s web and Comic book.

This repository is a snapshot of the source. The optional server (Fastify and Postgres, local-first
sync) and its EC2 deploy kit are included: see `docs/SERVER.md` and `docs/SYNC.md`.

---


A lightweight applicant tracking system (ATS) and people system (HCM) for a company growing from a solo
founder to about 20 employees. It runs entirely in your browser: no server, no accounts, nothing sent
anywhere. Data lives in this browser's storage; download a backup from Settings, Data.

It ships with **Ledgerlark**, a fictional seed-stage financial AI company in downtown San Jose, so every
screen has realistic work in it on day one. Start fresh as a solo founder from Settings, Data whenever
you are ready.

## Open it

- **No install:** double-click `first-twenty.html` (or `Launch First Twenty.bat`). Build it first with `npm run build` if the file is missing.
- **Develop:** `npm install`, then `npm run dev` and open http://127.0.0.1:8826.
- **Check everything:** `npm run verify` (typecheck, tests, one-file build).
- **Demo careers site:** `npm run build:careers` writes `dist-careers/`, a static careers site for the fictional sample company (its open jobs, each posting exactly as First Twenty generates it, and a demo apply form that sends nothing). It uses relative links only and expects the app one folder up, so publish it as a `careers/` folder beside the app; its "hiring side" links open the app's Jobs list and each job's pipeline. Rebuild it in the same publish step as the app, every time: the sample's dates move with the calendar (the app shifts them by whole weeks), so a careers build from an earlier day shows posted dates that no longer match the app. To link to an app somewhere else, add `-- --app-href <path or URL>`.

## Optional: your own server

A company that wants its data in its own Postgres database can run the First Twenty server next to
Postgres on an EC2 instance: the browser syncs every change to it, keeps working offline and catches up
later. One admin login protects the data. Step-by-step setup is in `docs/SERVER.md`; the protocol and
data layout are in `docs/SYNC.md`. Locally, `npm run server:dev` runs the server against PGlite (real
Postgres in WebAssembly, no install). The sign-in and sync screens in Settings, Data come next.

## What it does

| Area | Highlights |
|---|---|
| Home | "Tonight" header with a time estimate, an action inbox computed from your data (one big action per row, Undo, snooze; legal deadlines in red and never snoozed past due), next legal threshold, headcount vs plan, this week, hiring pulse, people cost. A First hire kit while it is just you. |
| Hiring | Jobs with planned rows from the headcount plan, pipeline board or list with keyboard moves (A, R, S, J) and Sweep mode, quick add by pasting, required next steps and SLAs, interview scheduling with .ics files and dual time zones, 4-point scorecards hidden until you submit yours, offer builder with band meter and exempt check, offer letter and wage notice, background checks with the Fair Chance Act steps, one-click Hire with a threshold preview. |
| People | Directory, org chart, the First twenty wall, profiles (job and pay history, equity, time off, checklists, emergency contacts), California-aware onboarding, offboarding with final pay deadlines, leave cases, contractors with the AB5 check. |
| Comp and plan | Headcount plan by quarter, levels and bands, comp table with compa-ratio, option pool and board consent queue, 409A history, fully loaded run-rate and runway. |
| Compliance | Milestones that switch on with headcount (5, 10 on site, 15, 20; 25 to 100 upcoming), each with "How we counted" and a citation; calendar; training tracker; notices and policies; SOC 2 people evidence; records retention. |
| Me | Self-service: pay and band, vesting, time off, tasks, profile, open roles and referrals. |
| Settings | Company, org, hiring defaults, checklist templates, time off and holidays, rules and rates with sources, link-outs, backup and import, start fresh, demo clock. |

**Viewing as** (left rail) previews the app as Admin, Hiring manager or Employee. It is a preview, not
security: anyone using this browser can switch.

**Looks** (Display menu, or type "look" in `Ctrl K`): Sleek (the default, light or dark), 1990s web, Comic book
and Trading desk. A look changes how the app looks, never what it says or does.

## Built for accessibility

Large targets, every action by keyboard, no drag-only actions, chips and defaults instead of typing,
text size up to 150%, reduced motion, light and dark themes. Single-key shortcuts (press `?`) can be
turned off in the Display menu; `Ctrl K` or `/` opens search.

## What it will not store

SSNs, dates of birth, bank details, home street addresses, ID scans, I-9 forms, background check
reports, medical details, salary history, or protected characteristics. Your payroll or PEO provider is
the system of record for those.

## Docs

- `ARCHITECTURE.md`: conventions, routes, data rules (read before changing code)
- `docs/LOOKS.md`: the look system (tokens, hook classes, decor) every screen and skin follows
- `docs/SPEC.md`: product spec
- `docs/LAW.md`: verified California, San Jose and federal facts behind the compliance features (October 2026)
- `docs/BENCHMARKS.md`: market data behind the sample company
- `docs/SAMPLE.md`: the Ledgerlark story
- `docs/SERVER.md`: run the optional server on EC2 next to Postgres (setup, updates, backups, restore)
- `docs/SYNC.md`: the server and sync contract (tables, `/api` protocol, sync engine, security rules)

Not legal advice. Laws and rates change every January; review Settings, Rules and rates each year and
confirm with counsel or your PEO.
