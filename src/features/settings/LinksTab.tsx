// Settings > Link-outs: where the real records live. The app stores status, dates and a link; payroll,
// background checks, signatures and the cap table stay in their own systems.
import type { Company, LinkOuts } from '@/domain/types'
import { useDB } from '@/store/db'
import { Badge, Field, FormGrid, Icon, Segmented, TextInput } from '@/ui'
import { commit, EditablePanel, RowList, Row } from './kit'
import { hostLabel, linkProblem, normalizeWebsite, payrollProviderName } from './logic'

type LinkKey = keyof LinkOuts

const LINKS: Array<{ key: LinkKey; label: string; what: string; placeholder: string }> = [
  { key: 'backgroundCheck', label: 'Background check vendor', what: 'Consent and FCRA and ICRAA disclosures go out from here. Only Clear or Consider comes back.', placeholder: 'https://' },
  { key: 'eSign', label: 'E-signature', what: 'Offer letters, PIIAs and policy acknowledgements are signed here.', placeholder: 'https://' },
  { key: 'capTable', label: 'Cap table tool', what: 'The source of truth for grants, exercises and 409A reports.', placeholder: 'https://' },
  { key: 'calendly', label: 'Scheduling link (Calendly)', what: 'Offered in interview scheduling messages.', placeholder: 'https://calendly.com/you' },
  { key: 'videoRoom', label: 'Video meeting room', what: 'Prefilled as the link for video interviews, in the confirmation message and the calendar files.', placeholder: 'https://meet.google.com/' },
  { key: 'training', label: 'Security training provider', what: 'Linked from security awareness training tasks.', placeholder: 'https://' },
  { key: 'handbook', label: 'Employee handbook', what: 'Linked from acknowledgements and Me.', placeholder: 'https://' },
  { key: 'benefits', label: 'Benefits summary', what: 'Shared on job postings and in onboarding.', placeholder: 'https://' },
]

type Draft = { providerName: string; providerKind: Company['payrollProvider']['kind']; providerUrl: string } & Record<LinkKey, string>

function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname
    const text = `${u.hostname.replace(/^www\./, '')}${path}`
    return text.length > 42 ? `${text.slice(0, 40)}...` : text
  } catch {
    return hostLabel(url) ?? url
  }
}

function ExternalLink({ url, label }: { url: string | undefined; label: string }) {
  if (!url) return <Badge tone="outline">Not set</Badge>
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`Open ${label} (new tab): ${shortUrl(url)}`}
      className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 font-semibold break-all text-accent underline decoration-accent/30 hover:decoration-accent"
    >
      {shortUrl(url)}
      <Icon name="external" size={14} />
    </a>
  )
}

export function LinksTab() {
  const company = useDB((s) => s.db.company)
  const providerName = payrollProviderName(company)
  // What the provider is called while it has no name.
  const providerLabel = providerName || 'Payroll or PEO provider'
  const value: Draft = {
    providerName,
    providerKind: company.payrollProvider.kind,
    providerUrl: company.payrollProvider.url || company.linkOuts.payroll || '',
    ...(Object.fromEntries(LINKS.map((l) => [l.key, company.linkOuts[l.key] ?? ''])) as Record<LinkKey, string>),
    payroll: company.linkOuts.payroll ?? '',
  }
  return (
    <EditablePanel<Draft>
      title="Link-outs"
      subtitle="Files never live here. Each checklist item and document links to where the real record is."
      icon="link"
      value={value}
      editLabel="Edit links"
      saveLabel="Save links"
      // A link typed without https:// ('secure.justworks.com') is saved with it, as Start fresh does.
      validate={(d) => {
        const bad = [d.providerUrl, ...LINKS.map((l) => d[l.key])].map(linkProblem).find(Boolean)
        return bad ? `One of the links needs fixing: ${bad}` : null
      }}
      onSave={(d) =>
        commit('Updated link-outs', (draft) => {
          const c = draft.company
          const providerUrl = normalizeWebsite(d.providerUrl)
          c.payrollProvider = { name: d.providerName.trim(), kind: d.providerKind, url: providerUrl }
          const next: LinkOuts = {}
          if (providerUrl) next.payroll = providerUrl
          for (const l of LINKS) {
            const v = normalizeWebsite(d[l.key])
            if (v) next[l.key] = v
          }
          c.linkOuts = next
        })
      }
      view={
        <RowList label="Link-outs">
          <Row
            title={providerName ? `Payroll or PEO: ${providerName}` : providerLabel}
            badges={<Badge>{company.payrollProvider.kind === 'PEO' ? 'PEO' : 'Payroll provider'}</Badge>}
            meta="Pay, taxes, W-2s, I-9s, benefits enrollment and the sensitive records this app never keeps."
            actions={<ExternalLink label={providerLabel} url={company.payrollProvider.url || company.linkOuts.payroll} />}
          />
          {LINKS.map((l) => (
            <Row key={l.key} title={l.label} meta={l.what} actions={<ExternalLink label={l.label} url={company.linkOuts[l.key]} />} />
          ))}
        </RowList>
      }
      form={(d, set) => (
        <>
          <fieldset className="flex flex-col gap-3 rounded-xl border border-line p-3">
            <legend className="px-1 text-[13.5px] font-semibold text-ink-2">Payroll or PEO</legend>
            <FormGrid>
              <Field label="Provider name">
                {(id) => (
                  <TextInput id={id} placeholder="Your payroll or PEO provider" value={d.providerName} onChange={(e) => set({ providerName: e.target.value })} />
                )}
              </Field>
              <Field label="Provider link" error={linkProblem(d.providerUrl)}>
                {(id, hint) => (
                  <TextInput id={id} aria-describedby={hint} inputMode="url" placeholder="https://" value={d.providerUrl} onChange={(e) => set({ providerUrl: e.target.value })} />
                )}
              </Field>
            </FormGrid>
            <Segmented
              label="Provider kind"
              value={d.providerKind}
              onChange={(v) => set({ providerKind: v })}
              options={[
                { value: 'PEO', label: 'PEO' },
                { value: 'Payroll', label: 'Payroll provider' },
              ]}
            />
          </fieldset>
          <FormGrid>
            {LINKS.map((l) => (
              <Field key={l.key} label={l.label} error={linkProblem(d[l.key])} hint={linkProblem(d[l.key]) ? undefined : l.what}>
                {(id, hint) => (
                  <TextInput
                    id={id}
                    aria-describedby={hint}
                    inputMode="url"
                    placeholder={l.placeholder}
                    value={d[l.key]}
                    onChange={(e) => set({ [l.key]: e.target.value } as Partial<Draft>)}
                  />
                )}
              </Field>
            ))}
          </FormGrid>
        </>
      )}
    />
  )
}
