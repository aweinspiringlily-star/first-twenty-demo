// Generated documents for an offer: the offer letter (print to PDF, copy, e-sign link-out) and the
// Labor Code 2810.5 wage notice (required for non-exempt hires, optional for exempt ones).
import { useState } from 'react'
import { offerLetter, wageNotice2810_5 } from '@/domain/hiring/offers'
import { NOT_LEGAL_ADVICE } from '@/domain/compliance'
import type { ID } from '@/domain/types'
import { printHTML } from '@/lib/files'
import { links } from '@/app/router'
import { useDB } from '@/store/db'
import { Button, Callout, CitationChip, Segmented, Sheet, toast } from '@/ui'
import { copyWithToast } from '../interviews/common'
import { PrivateBlock } from './BandMeter'

export function LetterSheet({ offerId, open, onClose }: { offerId: ID; open: boolean; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const offer = db.offers.find((o) => o.id === offerId)
  const nonExempt = offer?.flsa === 'non_exempt'
  const [doc, setDoc] = useState<'letter' | 'notice'>('letter')
  if (!open || !offer) return null
  const letter = offerLetter(db, offerId)
  const notice = wageNotice2810_5(db, { offerId })
  const showing = doc === 'notice' ? notice : letter
  const title = doc === 'notice' ? 'Notice to employee (Labor Code 2810.5)' : (letter?.subject ?? 'Offer letter')
  const eSign = db.company.linkOuts.eSign

  const print = () => {
    if (!showing) return
    if (!printHTML(title, showing.html)) toast({ text: 'Pop-ups are blocked here. Use Copy text instead.', tone: 'bad' })
  }

  return (
    <Sheet
      open
      onClose={onClose}
      width={760}
      title={doc === 'notice' ? 'Wage notice' : 'Offer letter'}
      subtitle="Print to PDF, then send it for signature through your e-sign tool. The app keeps the status and date, never the file."
      footer={
        <>
          {eSign && (
            <a
              href={eSign}
              target="_blank"
              rel="noreferrer noopener"
              className="mr-auto inline-flex h-11 items-center gap-2 rounded-lg px-3 text-[14px] font-semibold text-accent hover:bg-accent-soft"
            >
              Open e-sign tool
            </a>
          )}
          <Button icon="copy" onClick={() => showing && void copyWithToast(showing.text, doc === 'notice' ? 'the wage notice' : 'the offer letter')}>
            Copy text
          </Button>
          <Button variant="primary" size="lg" icon="printer" onClick={print}>
            Print
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented
          label="Document"
          value={doc}
          onChange={setDoc}
          options={[
            { value: 'letter', label: 'Offer letter' },
            { value: 'notice', label: nonExempt ? 'Wage notice (required)' : 'Wage notice (optional)' },
          ]}
        />
        {doc === 'notice' && (
          <Callout tone={nonExempt ? 'warn' : 'neutral'} title={nonExempt ? 'Required for this non-exempt hire' : 'Optional for exempt hires'}>
            <span className="block">Give the Labor Code 2810.5 notice no later than the start date. {NOT_LEGAL_ADVICE}</span>
            <span className="mt-1.5 inline-flex">
              <CitationChip label="Labor Code 2810.5" url="https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=2810.5.&lawCode=LAB" />
            </span>
          </Callout>
        )}
        {doc === 'notice' && notice && notice.missing.length > 0 && (
          <Callout tone="warn" title="Add these details before you print">
            <ul className="mt-1 list-disc pl-5">
              {notice.missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            <a href={links.settings('company')} className="mt-1 inline-block font-semibold text-accent underline">
              Open Settings
            </a>
          </Callout>
        )}
        {doc === 'letter' && (
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
            <span>Built in:</span>
            <CitationChip label="Labor Code 2922 (at will)" url="https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=2922.&lawCode=LAB" />
            <CitationChip label="B&P Code 16600 (no noncompete)" url="https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=16600.&lawCode=BPC" />
            <CitationChip label="Labor Code 925 (CA law and venue)" url="https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=925.&lawCode=LAB" />
            <CitationChip label="Labor Code 2870 (PIIA notice)" url="https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=2870.&lawCode=LAB" />
            <span>{NOT_LEGAL_ADVICE}</span>
          </div>
        )}
        {showing ? (
          <PrivateBlock>
            <article
              aria-label={title}
              className="letter-preview rounded-xl border border-line bg-surface px-5 py-5 font-serif text-[14.5px] leading-relaxed text-ink [&_h1]:mb-4 [&_h1]:font-sans [&_h1]:text-[19px] [&_h1]:font-bold [&_h2]:mt-5 [&_h2]:mb-1.5 [&_h2]:font-sans [&_h2]:text-[15px] [&_h2]:font-bold [&_p]:mb-3 [&_.sig]:mt-8 [&_.sig]:grid [&_.sig]:grid-cols-1 [&_.sig]:gap-8 sm:[&_.sig]:grid-cols-2 [&_.sig>div]:border-t [&_.sig>div]:border-ink-3 [&_.sig>div]:pt-1.5 [&_.sig>div]:text-[13px]"
              // The domain builds this HTML from escaped text only (escapeHTML on every value).
              dangerouslySetInnerHTML={{ __html: showing.html }}
            />
          </PrivateBlock>
        ) : (
          <p className="text-[14px] text-ink-2">The document could not be built for this offer.</p>
        )}
      </div>
    </Sheet>
  )
}
