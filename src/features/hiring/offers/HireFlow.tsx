// One-click Hire from an accepted offer: the threshold preview sits next to the button ('This hire
// takes you to 15'), and one click runs hireFromOffer, which creates employee #N (Pre-start) with job
// and pay records, the grant queued for board consent, the filled plan line, the referral bonus date
// and the onboarding checklist. Undo in the toast takes it back. Afterwards a calm welcome banner links
// to the person and their checklist and offers close-out notes for the job.
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { current409A } from '@/domain/equity'
import { closeOutRemaining } from '@/domain/hiring/jobs'
import { closeOutMessage } from '@/domain/hiring/messages'
import { candidateName } from '@/domain/hiring/util'
import { hireFromOffer, parseCityState } from '@/domain/lifecycle'
import { firstName, fullName, personNameById } from '@/domain/people'
import type { DB, ID, Offer } from '@/domain/types'
import { fmtDay, today } from '@/lib/dates'
import { num, plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { Button, Callout, Private } from '@/ui'
import { act, copyWithToast } from '../interviews/common'
import { checkCleared } from './logic'

/**
 * Records the hire from an accepted offer in one click; the toast offers Undo instead of a confirmation
 * step (the threshold preview already sits next to the button). Returns the new person's id.
 */
export function hireNow(offerId: ID, actorId: ID | null): ID | null {
  const db = useDB.getState().db
  const offer = db.offers.find((o) => o.id === offerId)
  if (!offer) return null
  const nextNumber = db.people.reduce((m, p) => Math.max(m, p.hireNumber), 0) + 1
  const res = act(`Hired ${candidateName(db, offer.candidateId)} as employee #${nextNumber}`, (d) => hireFromOffer(d, offerId, { date: today(), actorId }))
  return res ? res.value : null
}

/**
 * The state the hire will work in, read the way hireFromOffer reads it: remote hires work from their
 * own state (from their location), everyone else from the office's state.
 */
function hireWorkState(db: DB, offer: Offer): string {
  const office = (db.locations.find((l) => l.id === offer.locationId)?.state || 'CA').toUpperCase()
  if (offer.workMode !== 'remote') return office
  const cand = db.candidates.find((c) => c.id === offer.candidateId)
  return (parseCityState(cand?.location).state ?? office).toUpperCase()
}

/** What the onboarding line says: California dates, or the hire's state and whether it is new to the company. */
function onboardingLine(db: DB, offer: Offer): string {
  const st = hireWorkState(db, offer)
  if (st === 'CA') return 'Starts the onboarding checklist with California dates (I-9, DE 34, notices, trainings).'
  const setUp = db.people.some((p) => p.homeState.toUpperCase() === st && (!p.endDate || p.endDate >= offer.startDate))
  return setUp
    ? `Starts the onboarding checklist for work in ${st} (I-9, the ${st} new hire report). California-only steps are left out, and ${st} is already set up.`
    : `Starts the onboarding checklist for work in ${st} (I-9, the ${st} new hire report) and a new-state setup checklist, since nobody works in ${st} yet. California-only steps are left out.`
}

/** What Hire will do, shown under the Hire button: a background-check warning and an expandable list. */
export function HireDetails({ offerId }: { offerId: ID }) {
  const db = useDB((s) => s.db)
  const offer = db.offers.find((o) => o.id === offerId)
  if (!offer) return null
  const nextNumber = db.people.reduce((m, p) => Math.max(m, p.hireNumber), 0) + 1
  const job = db.jobs.find((j) => j.id === offer.jobId)
  const slot = db.plan.find((s) => (!!job?.planSlotId && s.id === job.planSlotId) || s.jobId === offer.jobId)
  const cand = db.candidates.find((c) => c.id === offer.candidateId)
  const otherOpen = db.offers.some((o) => o.jobId === offer.jobId && o.id !== offer.id && (o.status === 'draft' || o.status === 'awaiting_approval' || o.status === 'approved' || o.status === 'sent' || (o.status === 'accepted' && !o.personId)))
  const needsCheck = offer.contingencies.includes('background_check')
  const cleared = checkCleared(offer.backgroundCheck)
  return (
    <>
      {needsCheck && !cleared && (
        <Callout tone="warn" title="The background check has not cleared yet">
          You can record the hire now. The onboarding checklist keeps &quot;Background check cleared&quot; open, and it must be done before the start date (SOC 2 evidence).
        </Callout>
      )}
      <details>
        <summary className="flex min-h-10 cursor-pointer items-center text-[13.5px] font-semibold text-ink">What Hire does</summary>
        <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-[13.5px] text-ink-2">
          <li>
            Creates employee #{nextNumber}, {offer.title}, as Pre-start until {fmtDay(offer.startDate)}, reporting to {personNameById(db, offer.managerId, 'their manager')}.
          </li>
          <li>Writes the job and pay records, effective on the start date.</li>
          {offer.equityShares > 0 && (
            <li>
              Queues <Private>{num(offer.equityShares)}</Private> options for the next board consent{current409A(db, today()) ? ' at the current 409A.' : '. Add a 409A valuation before the board approves them.'}
            </li>
          )}
          <li>{onboardingLine(db, offer)}</li>
          {slot && <li>Fills the plan line {slot.title}.</li>}
          {cand?.referrerId && <li>Dates the referral bonus for {personNameById(db, cand.referrerId, 'the referrer')}, {db.settings.referralBonusPayableDays} days after the start.</li>}
          <li>{otherOpen ? 'Keeps the job open, because another offer on it is still out.' : 'Marks the job filled.'}</li>
          <li>Undo in the toast that follows takes it all back.</li>
        </ul>
      </details>
    </>
  )
}

/** Calm banner after a hire: links to the person and onboarding, plus close-out notes for the job. */
export function WelcomeBanner({ personId, jobId, onDismiss }: { personId: ID; jobId: ID; onDismiss: () => void }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const person = db.people.find((p) => p.id === personId)
  const job = db.jobs.find((j) => j.id === jobId)
  if (!person) return null
  const checklist = db.checklists.find((c) => c.personId === personId && c.kind === 'onboarding')
  const closeOut = job && job.status === 'filled' ? closeOutMessage(db, job.id, viewer.personId ? { senderId: viewer.personId } : {}) : null
  const remaining = job ? db.applications.filter((a) => a.jobId === job.id && a.status === 'active' && !a.conditionalOfferOn).length : 0
  return (
    <div className="rounded-2xl border border-good/30 bg-good-soft px-4 py-4" role="status">
      <p className="font-display text-[18px] font-bold text-ink">
        Welcome, {firstName(person)}. Employee #{person.hireNumber}
      </p>
      <p className="mt-0.5 text-[14px] text-ink-2">
        {fullName(person)} starts {fmtDay(person.startDate)}. Onboarding is running{checklist ? `, with ${plural(checklist.tasks.filter((t) => t.status === 'open').length, 'open task')}` : ''}.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a href={links.person(person.id)} className="ft-btn ft-btn--primary ft-btn--md inline-flex h-11 items-center rounded-lg bg-accent px-4 text-[14.5px] font-semibold text-accent-ink hover:bg-accent-hover">
          Open {firstName(person)}&apos;s profile
        </a>
        {checklist && (
          <a href={links.checklist(checklist.id)} className="ft-btn ft-btn--secondary ft-btn--md inline-flex h-11 items-center rounded-lg border border-line-strong bg-surface px-4 text-[14.5px] font-semibold text-ink hover:bg-surface-2">
            Open onboarding checklist
          </a>
        )}
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      {closeOut && closeOut.bcc.length > 0 && job && (
        <div className="mt-4 border-t border-good/20 pt-3">
          <p className="text-[14px] font-bold text-ink">Close the loop with the other candidates</p>
          <p className="text-[13.5px] text-ink-2">
            {plural(closeOut.bcc.length, 'person', 'people')} on {job.title} still need a note{remaining ? `, and ${plural(remaining, 'application')} ${remaining === 1 ? 'is' : 'are'} still open` : ''}.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" icon="copy" onClick={() => void copyWithToast(`Subject: ${closeOut.subject}\n\n${closeOut.body}`, 'the close-out note')}>
              Copy close-out note
            </Button>
            <Button size="sm" icon="copy" onClick={() => void copyWithToast(closeOut.bcc.join(', '), 'the BCC list')}>
              Copy BCC list
            </Button>
            <a href={closeOut.mailto} className="ft-btn ft-btn--secondary ft-btn--sm inline-flex h-10 items-center rounded-lg border border-line-strong bg-surface px-3 text-[13.5px] font-semibold text-ink hover:bg-surface-2">
              Open in mail app
            </a>
            {remaining > 0 && (
              <Button size="sm" onClick={() => act(`Closed out ${plural(remaining, 'candidate')} on ${job.title}`, (d) => closeOutRemaining(d, job.id, { date: today(), notified: true }) > 0)}>
                Close out {plural(remaining, 'candidate')} as notified
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
