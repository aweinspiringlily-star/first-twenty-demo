// Offers, background checks and Hire (owned by the hiring-process builder).
// Exports keep the names and props the hiring core imports.
import type { ReactNode } from 'react'
import { useState } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { canApproveOffer, canDraftOffer, canSeeOffer } from '@/domain/access'
import { offerNudgeMessage } from '@/domain/hiring/messages'
import {
  approvalRequired,
  approveOffer,
  effectiveBand,
  extendOffer,
  markAccepted,
  markSent,
  offerEquitySummary,
  sendBlockers,
  submitForApproval,
} from '@/domain/hiring/offers'
import { dbHolidays, offersFor, outcomeReasonLabel } from '@/domain/hiring/util'
import { hirePreview } from '@/domain/lifecycle'
import { personNameById } from '@/domain/people'
import { ThresholdPreview } from '@/features/compliance'
import type { ID, Offer } from '@/domain/types'
import { fmtDay, nowISO, today } from '@/lib/dates'
import { num, pct } from '@/lib/format'
import { useDB } from '@/store/db'
import { Badge, Button, DescriptionList, EmptyState, IconButton, Menu, type MenuItem, Money, Private } from '@/ui'
import { act, SubPanel, copyWithToast, MoneyText, Note } from '../interviews/common'
import { expiryPhrase } from '../interviews/logic'
import { BandMeter } from './BandMeter'
import { HireDetails, hireNow, WelcomeBanner } from './HireFlow'
import { LetterSheet } from './LetterSheet'
import { approvalLine, extendOptions, OFFER_STATUS, peerBases, trimPeriod } from './logic'
import { OfferBuilder } from './OfferBuilder'
import { DeclineModal, RequestChangesModal, RescindModal } from './OfferDialogs'

export { CandidateBackground } from './Background'
export { OffersTab } from './OffersTab'
export { HireDetails, hireNow, WelcomeBanner } from './HireFlow'

type Dialog = { kind: 'decline' | 'rescind' | 'changes'; offerId: ID } | null

const CONTINGENCY_LABEL: Record<Offer['contingencies'][number], string> = { background_check: 'background check', i9: 'I-9', piia: 'PIIA' }
const BASIS_LABEL: Record<string, string> = {
  computer_professional: 'computer professional',
  professional: 'professional',
  administrative: 'administrative',
  executive: 'executive',
  outside_sales: 'outside sales',
}

/** Candidate profile block: current offer (builder, approval, letter, sent/accepted), Hire button. */
export function CandidateOffer({ applicationId }: { applicationId: ID }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const [builder, setBuilder] = useState<{ offerId?: ID } | null>(null)
  const [letterFor, setLetterFor] = useState<ID | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [welcome, setWelcome] = useState<ID | null>(null)
  const app = db.applications.find((a) => a.id === applicationId)
  const job = app ? db.jobs.find((j) => j.id === app.jobId) : undefined
  const cand = app ? db.candidates.find((c) => c.id === app.candidateId) : undefined
  if (!app || !job || !cand || !canSeeOffer(viewer, db, app)) return null

  const offers = offersFor(db, app.id)
  const offer = offers[0]
  const date = today()
  const isAdmin = canApproveOffer(viewer)
  const canDraft = canDraftOffer(viewer, db, app) && app.status === 'active'
  const name = `${cand.firstName} ${cand.lastName}`
  const closed = !offer || offer.status === 'declined' || offer.status === 'rescinded'

  const sheets = (
    <>
      {builder && <OfferBuilder applicationId={app.id} {...(builder.offerId ? { offerId: builder.offerId } : {})} open onClose={() => setBuilder(null)} />}
      {letterFor && <LetterSheet offerId={letterFor} open onClose={() => setLetterFor(null)} />}
      {dialog?.kind === 'decline' && <DeclineModal offerId={dialog.offerId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rescind' && <RescindModal offerId={dialog.offerId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'changes' && <RequestChangesModal offerId={dialog.offerId} onClose={() => setDialog(null)} />}
    </>
  )

  if (!offer) {
    return (
      <SubPanel title="Offer" icon="send">
        <EmptyState
          compact
          icon="send"
          title="No offer yet"
          body={canDraft ? 'Level picks the band. Base, equity, a Monday start date and a 5-business-day expiry come prefilled.' : 'Offers show here once drafted.'}
          action={
            canDraft ? (
              <Button variant="primary" size="lg" icon="plus" onClick={() => setBuilder({})}>
                Make offer
              </Button>
            ) : undefined
          }
        />
        {sheets}
      </SubPanel>
    )
  }

  const st = OFFER_STATUS[offer.status]
  const needsApproval = approvalRequired(db, offer, date)
  const blockers = offer.status === 'draft' || offer.status === 'approved' ? sendBlockers(db, offer, date).filter((b) => !b.includes('Admin approval')) : []
  const band = effectiveBand(db, offer.familyId, offer.levelId, job)
  const base = offer.payType === 'hourly' ? Math.round((offer.hourlyRate ?? 0) * 2080) : (offer.salary ?? 0)
  const equity = offerEquitySummary(db, offer, date)
  const hired = offer.personId ? db.people.find((p) => p.id === offer.personId) : undefined
  const changes = [...offer.approvals].reverse().find((a) => a.decision === 'changes_requested')
  const drafter = offer.draftedById ? personNameById(db, offer.draftedById, 'someone') : undefined

  const run = (label: string, fn: Parameters<typeof act>[1]) => act(label, fn)
  const approve = () => viewer.personId && run(`Approved the offer for ${name}`, (d) => approveOffer(d, offer.id, { approverId: viewer.personId as ID, at: nowISO() }))
  const submit = () => run(`Sent the offer for ${name} for approval`, (d) => submitForApproval(d, offer.id, { date }))
  const send = () => run(`Marked the offer to ${name} sent`, (d) => markSent(d, offer.id, { date }))
  const accept = () => run(`Recorded that ${name} accepted the offer`, (d) => markAccepted(d, offer.id, { date }))
  const nudge = () => {
    const m = offerNudgeMessage(db, offer.id, viewer.personId ? { senderId: viewer.personId } : {})
    if (m) void copyWithToast(`Subject: ${m.subject}\n\n${m.body}`, `a nudge for ${cand.firstName}`)
  }
  const extendItems: MenuItem[] = extendOptions(offer.expiresOn, date, dbHolidays(db)).map((o) => ({
    label: `Extend to ${fmtDay(o.date)}`,
    hint: `+${o.days} business days`,
    icon: 'clock',
    onSelect: () => run(`Extended the offer for ${name} to ${fmtDay(o.date)}`, (d) => extendOffer(d, offer.id, o.date, { date })),
  }))

  const primary: ReactNode[] = []
  const more: MenuItem[] = []
  const letterBtn = (
    <Button key="letter" icon="file" onClick={() => setLetterFor(offer.id)}>
      Generate letter
    </Button>
  )
  switch (offer.status) {
    case 'draft':
      if (needsApproval && isAdmin)
        primary.push(
          <Button key="approve" variant="primary" icon="check" onClick={approve}>
            Approve
          </Button>,
        )
      else if (needsApproval)
        primary.push(
          <Button key="submit" variant="primary" icon="send" onClick={submit}>
            Submit for approval
          </Button>,
        )
      else
        primary.push(
          <Button key="send" variant="primary" icon="send" onClick={send}>
            Mark sent
          </Button>,
        )
      primary.push(
        <Button key="edit" icon="edit" onClick={() => setBuilder({ offerId: offer.id })}>
          Edit
        </Button>,
        letterBtn,
      )
      more.push({ label: 'Discard draft', icon: 'trash', danger: true, onSelect: () => setDialog({ kind: 'rescind', offerId: offer.id }) })
      break
    case 'awaiting_approval':
      if (isAdmin) {
        primary.push(
          <Button key="approve" variant="primary" size="lg" icon="check" onClick={approve}>
            Approve
          </Button>,
          <Button key="changes" onClick={() => setDialog({ kind: 'changes', offerId: offer.id })}>
            Ask for changes
          </Button>,
        )
      }
      primary.push(
        <Button key="edit" icon="edit" onClick={() => setBuilder({ offerId: offer.id })}>
          Edit
        </Button>,
        letterBtn,
      )
      if (isAdmin) more.push({ label: 'Discard offer', icon: 'trash', danger: true, onSelect: () => setDialog({ kind: 'rescind', offerId: offer.id }) })
      break
    case 'approved':
      primary.push(
        <Button key="send" variant="primary" icon="send" onClick={send}>
          Mark sent
        </Button>,
        letterBtn,
        <Button key="edit" icon="edit" onClick={() => setBuilder({ offerId: offer.id })}>
          Edit
        </Button>,
      )
      if (isAdmin) more.push({ label: 'Discard offer', icon: 'trash', danger: true, onSelect: () => setDialog({ kind: 'rescind', offerId: offer.id }) })
      break
    case 'sent':
      primary.push(
        <Button key="accept" variant="primary" icon="check" onClick={accept}>
          Mark accepted
        </Button>,
        <Button key="decline" onClick={() => setDialog({ kind: 'decline', offerId: offer.id })}>
          Declined
        </Button>,
        <Menu key="extend" label="Extend expiry" items={extendItems} trigger={(p) => <Button icon="clock" {...p}>Extend expiry</Button>} />,
      )
      more.push({ label: 'Copy a friendly nudge', icon: 'copy', onSelect: nudge }, { label: 'Generate letter', icon: 'file', onSelect: () => setLetterFor(offer.id) })
      if (isAdmin) more.push({ divider: true }, { label: 'Rescind offer', icon: 'x', danger: true, onSelect: () => setDialog({ kind: 'rescind', offerId: offer.id }) })
      break
    case 'accepted':
      if (!hired) {
        more.push({ label: 'Candidate backed out', icon: 'x', onSelect: () => setDialog({ kind: 'decline', offerId: offer.id }) })
        more.push({ label: 'Generate letter', icon: 'file', onSelect: () => setLetterFor(offer.id) })
      }
      break
    case 'expired':
      primary.push(<Menu key="extend" label="Extend expiry" items={extendItems} trigger={(p) => <Button variant="primary" icon="clock" {...p}>Extend and reopen</Button>} />)
      break
    default:
      break
  }
  if (closed && canDraft) {
    primary.push(
      <Button key="new" variant="primary" icon="plus" onClick={() => setBuilder({})}>
        Make a new offer
      </Button>,
    )
  }

  const preview = offer.status === 'accepted' && !hired ? hirePreview(db, offer.id) : null

  return (
    <SubPanel
      title="Offer"
      icon="send"
      subtitle={`Version ${offer.version}${drafter ? `, drafted by ${drafter}` : ''}${offer.createdOn ? ` on ${fmtDay(offer.createdOn)}` : ''}`}
      actions={
        <>
          <Badge tone={st.tone}>{offer.status === 'sent' ? `Out, ${expiryPhrase(offer.expiresOn, date).toLowerCase()}` : st.label}</Badge>
          {more.length > 0 && <Menu label="More offer actions" items={more} trigger={(p) => <IconButton icon="more" label="More offer actions" {...p} />} />}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {welcome && <WelcomeBanner personId={welcome} jobId={job.id} onDismiss={() => setWelcome(null)} />}
        {hired && !welcome && (
          <Note icon="check">
            Hired as employee #{hired.hireNumber}, starting {fmtDay(hired.startDate)}.{' '}
            <a href={links.person(hired.id)} className="font-semibold text-accent underline">
              Open profile
            </a>
          </Note>
        )}
        {offer.status === 'awaiting_approval' && !isAdmin && <Note icon="clock">Waiting for Admin approval. You can still edit it.</Note>}
        {offer.status === 'draft' && changes && (
          <Note icon="alert">
            {personNameById(db, changes.approverId, 'Admin')} asked for changes: <MoneyText text={changes.note ?? ''} />
          </Note>
        )}
        {(offer.status === 'declined' || offer.status === 'rescinded' || offer.status === 'expired') && (
          <Note icon="info">
            {offer.status === 'declined' ? (
              <MoneyText
                text={`Declined${offer.decidedOn ? ` ${fmtDay(offer.decidedOn)}` : ''}: ${outcomeReasonLabel(offer.declineReason).toLowerCase()}${offer.competingNote ? `. ${trimPeriod(offer.competingNote)}` : ''}.`}
              />
            )
              : offer.status === 'expired'
                ? `Expired ${fmtDay(offer.expiresOn)}. Extend it to reopen, or close the application.`
                : `Rescinded${offer.decidedOn ? ` ${fmtDay(offer.decidedOn)}` : ''}.`}
          </Note>
        )}
        <DescriptionList
          columns={2}
          items={[
            {
              label: 'Base',
              value: (
                <>
                  <Money value={offer.payType === 'hourly' ? offer.hourlyRate : offer.salary} /> {offer.payType === 'hourly' ? 'an hour' : 'a year'}
                </>
              ),
            },
            {
              label: 'Variable and sign-on',
              value: (
                <>
                  {offer.variablePct ? (
                    <>
                      <Private>{pct(offer.variablePct)}</Private> target (<Money value={Math.round(base * offer.variablePct)} />)
                    </>
                  ) : (
                    'No variable'
                  )}
                  {offer.signOnBonus ? (
                    <>
                      , <Money value={offer.signOnBonus} /> sign-on
                    </>
                  ) : null}
                </>
              ),
            },
            {
              label: 'Equity',
              value:
                offer.equityShares > 0 ? (
                  <>
                    <Private>{num(offer.equityShares)}</Private> {offer.equityType}s, <Private>{pct(equity.pctFD)}</Private> fully diluted
                  </>
                ) : (
                  'None'
                ),
            },
            { label: 'Start date', value: fmtDay(offer.startDate) },
            { label: 'Expires', value: `${fmtDay(offer.expiresOn)}${offer.status === 'sent' ? ` (${expiryPhrase(offer.expiresOn, date).toLowerCase()})` : ''}` },
            {
              label: 'Classification',
              value: offer.flsa === 'exempt' ? `Exempt${offer.exemptionBasis ? `, ${BASIS_LABEL[offer.exemptionBasis] ?? offer.exemptionBasis}` : ''}` : 'Non-exempt (2810.5 notice required)',
            },
            { label: 'Contingencies', value: offer.contingencies.length ? offer.contingencies.map((c) => CONTINGENCY_LABEL[c]).join(', ') : 'None' },
            { label: 'Approval', value: approvalLine(offer, needsApproval, (id) => personNameById(db, id, 'Admin')) },
            { label: 'Exception reason', value: <MoneyText text={offer.exceptionReason ?? ''} />, hidden: !offer.exceptionReason },
          ]}
        />
        {band && base > 0 && (
          <BandMeter compact band={band} offer={base} desired={cand.desiredPay ?? null} {...(isAdmin ? { peers: peerBases(db.people, db.comp, offer.familyId, offer.levelId, date, offer.personId ? [offer.personId] : []) } : {})} />
        )}
        {blockers.length > 0 && (
          <ul className="flex flex-col gap-1">
            {blockers.map((b) => (
              <li key={b}>
                <Note icon="alert">
                  <Private>{b}</Private>
                </Note>
              </li>
            ))}
          </ul>
        )}
        {preview && (
          <div className="flex flex-col gap-2 rounded-xl bg-surface-2 px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              {isAdmin ? (
                <Button
                  variant="primary"
                  size="lg"
                  icon="user-plus"
                  onClick={() => {
                    const personId = hireNow(offer.id, viewer.personId)
                    if (personId) setWelcome(personId)
                  }}
                >
                  Hire {cand.firstName}
                </Button>
              ) : (
                <span className="text-[14px] font-semibold text-ink">Admin records the hire.</span>
              )}
              <span className="text-[14px] text-ink-2">
                This hire takes you to <span className="num font-bold text-ink">{preview.headcountAfter}</span> on {fmtDay(preview.date)}
                {preview.crossesThresholds.length ? `, crossing ${preview.crossesThresholds.join(' and ')}` : ''}.
              </span>
            </div>
            <ThresholdPreview startDate={offer.startDate} />
            {isAdmin && <HireDetails offerId={offer.id} />}
          </div>
        )}
        {primary.length > 0 && <div className="flex flex-wrap gap-2">{primary}</div>}
        {offers.length > 1 && (
          <p className="text-[12.5px] text-ink-3">
            Earlier versions:{' '}
            <MoneyText
              text={offers
                .slice(1)
                .map((o) => `v${o.version} ${OFFER_STATUS[o.status].label.toLowerCase()}${o.declineReason ? ` (${outcomeReasonLabel(o.declineReason).toLowerCase()})` : ''}`)
                .join(', ')}
            />
          </p>
        )}
      </div>
      {sheets}
    </SubPanel>
  )
}
