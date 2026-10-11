// Small dialogs on an offer: declined (reason chips), rescind (reason, confirm), request changes (Admin).
import { useState } from 'react'
import { useViewer } from '@/app/useViewer'
import { markDeclined, requestOfferChanges, rescindOffer } from '@/domain/hiring/offers'
import { candidateName, isOutcomeReason } from '@/domain/hiring/util'
import type { ID, OutcomeReason } from '@/domain/types'
import { nowISO, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Button, Checkbox, ChipGroup, ConfirmButton, Field, Modal, TextArea } from '@/ui'
import { act, DICTATION_HINT } from '../interviews/common'
import { declineReasonChoices, rescindReasonChoices } from './logic'

export function DeclineModal({ offerId, onClose }: { offerId: ID; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const offer = db.offers.find((o) => o.id === offerId)
  const [reason, setReason] = useState<string | null>(null)
  const [note, setNote] = useState('')
  if (!offer) return null
  const name = candidateName(db, offer.candidateId)
  const backedOut = offer.status === 'accepted'
  const save = () => {
    if (!reason) return
    const outcome: OutcomeReason = isOutcomeReason(reason) ? reason : reason.startsWith('Counteroffer') ? 'chose_other_offer' : 'other'
    const label = backedOut ? `Recorded that ${name} backed out` : `Recorded that ${name} declined the offer`
    const res = act(label, (d) => markDeclined(d, offer.id, reason, { date: today(), outcomeReason: outcome, ...(note.trim() ? { note: note.trim() } : {}) }))
    if (res) onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={backedOut ? `${name} backed out` : `${name} declined`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!reason} onClick={save}>
            Record decline
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[14px] text-ink-2">The reserved options go back to the pool and the application closes as withdrawn. You can undo this.</p>
        <ChipGroup label="Reason" value={reason} onChange={setReason} options={declineReasonChoices()} />
        <Field label="Details" hint={`Optional, for example the competing company or what would have changed their mind. ${DICTATION_HINT}`}>
          {(id, describedBy) => <TextArea id={id} rows={3} aria-describedby={describedBy} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  )
}

export function RescindModal({ offerId, onClose }: { offerId: ID; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const offer = db.offers.find((o) => o.id === offerId)
  const [reason, setReason] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [closeApp, setCloseApp] = useState(true)
  if (!offer) return null
  const name = candidateName(db, offer.candidateId)
  const unsent = offer.status === 'draft' || offer.status === 'awaiting_approval' || offer.status === 'approved'
  const fullReason = [reason, note.trim()].filter(Boolean).join(': ')
  const save = () => {
    if (!fullReason) return
    const res = act(unsent ? `Discarded the offer for ${name}` : `Rescinded the offer for ${name}`, (d) =>
      rescindOffer(d, offer.id, { date: today(), reason: fullReason, closeApplication: unsent ? false : closeApp }),
    )
    if (res) onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={unsent ? `Discard the offer for ${name}?` : `Rescind the offer for ${name}?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep the offer
          </Button>
          {unsent ? (
            <Button variant="primary" disabled={!fullReason} onClick={save}>
              Discard offer
            </Button>
          ) : (
            <ConfirmButton disabled={!fullReason} onConfirm={save} confirmLabel="Click again to rescind">
              Rescind offer
            </ConfirmButton>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!unsent && (
          <p className="text-[14px] text-ink-2">
            The candidate has this offer. Rescinding releases the reserved options. Talk to them first, and if the reason is a background check result, finish the Fair Chance steps instead.
          </p>
        )}
        <ChipGroup label="Reason" value={reason} onChange={setReason} options={rescindReasonChoices().map((r) => ({ value: r, label: r }))} />
        <Field label="Details" hint="Logged on the offer's history.">
          {(id, describedBy) => <TextArea id={id} rows={2} aria-describedby={describedBy} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        {!unsent && <Checkbox checked={closeApp} onChange={setCloseApp} label="Also close the application" description="Rejected with the reason above. Leave it open to make a new offer." />}
      </div>
    </Modal>
  )
}

export function RequestChangesModal({ offerId, onClose }: { offerId: ID; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const offer = db.offers.find((o) => o.id === offerId)
  const [chip, setChip] = useState<string | null>(null)
  const [note, setNote] = useState('')
  if (!offer) return null
  const name = candidateName(db, offer.candidateId)
  const text = [chip, note.trim()].filter(Boolean).join('. ')
  const save = () => {
    if (!text || !viewer.personId) return
    const approverId = viewer.personId
    const res = act(`Asked for changes to the offer for ${name}`, (d) => requestOfferChanges(d, offer.id, { approverId, at: nowISO(), note: text }))
    if (res) onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Ask for changes: ${name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!text} onClick={save}>
            Send back to draft
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ChipGroup
          label="What to change"
          value={chip}
          onChange={setChip}
          options={['Bring base inside the band', 'Lower the equity', 'Move the start date', 'Fix the level'].map((r) => ({ value: r, label: r }))}
        />
        <Field label="Note to the drafter" hint={DICTATION_HINT}>
          {(id, describedBy) => <TextArea id={id} rows={3} aria-describedby={describedBy} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  )
}
