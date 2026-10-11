// Small building blocks shared by the Settings tabs: the commit helper (mutate + activity + Undo
// toast), a panel that shows a summary and switches to an edit form, an edit sheet for list items,
// list rows, a date picker with field-specific chips and a wrapper that blurs amounts while editing.
import type { Draft } from 'immer'
import type { ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import type { DB, EntityType } from '@/domain/types'
import { addDays, type ISODate, today } from '@/lib/dates'
import { logActivity, useDB } from '@/store/db'
import { usePrefs } from '@/store/prefs'
import { Button, cx, DateChips, Icon, type IconName, Panel, Sheet, toast } from '@/ui'
import { produce } from 'immer'

/**
 * Applies a settings change through the store with an activity row and an Undo toast.
 * Returns false (and says so) when the change would not alter anything.
 */
export function commit(
  label: string,
  recipe: (d: Draft<DB>) => void,
  opts: { entityType?: EntityType; entityId?: string; log?: string | false; quiet?: boolean } = {},
): boolean {
  const before = useDB.getState().db
  if (produce(before, recipe) === before) {
    if (!opts.quiet) toast({ text: 'Nothing changed', tone: 'neutral' })
    return false
  }
  useDB.getState().mutate(label, (d) => {
    recipe(d)
    if (opts.log !== false) {
      logActivity(d, {
        entityType: opts.entityType ?? 'settings',
        entityId: opts.entityId ?? 'settings',
        kind: 'settings_changed',
        text: typeof opts.log === 'string' ? opts.log : label,
      })
    }
  })
  toast({ text: label, action: { label: 'Undo', onClick: () => void useDB.getState().undo() } })
  return true
}

/** Focuses the first form control inside a container when `active` turns true. */
function useFocusFirst(ref: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active || !ref.current) return
    const el = ref.current.querySelector<HTMLElement>('input:not([type=hidden]),select,textarea,button[role=radio],button[role=switch]')
    el?.focus()
  }, [active, ref])
}

/**
 * A panel that shows a summary and switches to an edit form in place. The draft is a copy of `value`;
 * Save hands it to `onSave` (which commits it), Cancel throws it away.
 */
export function EditablePanel<T>({
  title,
  subtitle,
  icon,
  value,
  view,
  form,
  onSave,
  editLabel,
  saveLabel,
  validate,
  id,
  extraActions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  icon?: IconName
  value: T
  view: ReactNode
  form: (draft: T, set: (patch: Partial<T>) => void) => ReactNode
  onSave: (draft: T) => boolean | void
  editLabel: string
  saveLabel: string
  validate?: (draft: T) => string | null
  id?: string
  extraActions?: ReactNode
}) {
  const [draft, setDraft] = useState<T | null>(null)
  // Problems show once Save is tried, so a fresh form never opens in red.
  const [tried, setTried] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const editBtn = useRef<HTMLButtonElement>(null)
  const editing = draft !== null
  useFocusFirst(formRef, editing)
  const error = draft !== null && validate ? validate(draft) : null
  const close = () => {
    setDraft(null)
    setTried(false)
    setTimeout(() => editBtn.current?.focus(), 0)
  }
  return (
    <Panel
      id={id}
      title={title}
      subtitle={subtitle}
      icon={icon}
      actions={
        editing ? undefined : (
          <>
            {extraActions}
            <Button ref={editBtn} icon="edit" onClick={() => setDraft(structuredClone(value))}>
              {editLabel}
            </Button>
          </>
        )
      }
    >
      {draft === null ? (
        view
      ) : (
        <form
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault()
            if (error) {
              setTried(true)
              return
            }
            // A save that changes nothing still closes the form (commit says "Nothing changed").
            onSave(draft)
            close()
          }}
          className="flex flex-col gap-4"
        >
          {form(draft, (patch) => setDraft((d) => (d === null ? d : { ...d, ...patch })))}
          {tried && error && (
            <p role="alert" className="text-[13.5px] font-semibold text-bad">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-3">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" icon="check">
              {saveLabel}
            </Button>
          </div>
        </form>
      )}
    </Panel>
  )
}

/**
 * Side sheet with a form for one list item. Render it with a `key` per item so the draft resets.
 * Enter in a text field saves; Escape or Cancel closes without saving.
 */
export function EditSheet<T>({
  open,
  title,
  subtitle,
  initial,
  onClose,
  onSave,
  saveLabel,
  validate,
  children,
  width,
  footerExtra,
}: {
  open: boolean
  title: ReactNode
  subtitle?: ReactNode
  initial: T
  onClose: () => void
  onSave: (draft: T) => boolean | void
  saveLabel: string
  validate?: (draft: T) => string | null
  children: (draft: T, set: (patch: Partial<T>) => void) => ReactNode
  width?: number
  footerExtra?: ReactNode
}) {
  const [draft, setDraft] = useState<T>(() => structuredClone(initial))
  const formId = `es${useId().replace(/:/g, '')}`
  const formRef = useRef<HTMLFormElement>(null)
  // Runs after the Sheet's own focus trap (child effects first), so the first field gets focus, not Close.
  useFocusFirst(formRef, open)
  const [tried, setTried] = useState(false)
  const error = validate ? validate(draft) : null
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      width={width}
      footer={
        <>
          {tried && error && (
            <p role="alert" className="mr-auto basis-full text-[13.5px] font-semibold text-bad sm:basis-auto">
              {error}
            </p>
          )}
          {footerExtra}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" icon="check">
            {saveLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault()
          if (error) {
            setTried(true)
            return
          }
          onSave(draft)
          onClose()
        }}
        className="flex flex-col gap-4"
      >
        {children(draft, (patch) => setDraft((d) => ({ ...d, ...patch })))}
      </form>
    </Sheet>
  )
}

/** A divided list of rows with content on the left and actions on the right (stacking on phones). */
export function RowList({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-line">
      {children}
    </ul>
  )
}

export function Row({
  title,
  meta,
  badges,
  actions,
  className,
}: {
  title: ReactNode
  meta?: ReactNode
  badges?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <li className={cx('flex flex-wrap items-center gap-x-4 gap-y-2 py-3', className)}>
      <div className="min-w-0 flex-1 basis-60">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold break-words text-ink">{title}</span>
          {badges}
        </div>
        {meta && <div className="mt-0.5 text-[13.5px] break-words text-ink-3">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </li>
  )
}

/** Chips for dates in the past (founded, closed, as of): Today, 1st of this month, Jan 1, then Pick. */
export function pastPresets(): Array<{ label: string; date: ISODate }> {
  const t = today()
  return [
    { label: 'Today', date: t },
    { label: 'Yesterday', date: addDays(t, -1) },
    { label: '1st of this month', date: `${t.slice(0, 8)}01` },
    { label: `Jan 1, ${t.slice(0, 4)}`, date: `${t.slice(0, 4)}-01-01` },
  ]
}

/** DateChips with a visible label (a group label plus a heading the chips sit under). */
export function DateField({
  label,
  value,
  onChange,
  presets,
  hint,
  min,
}: {
  label: string
  value: ISODate | null | undefined
  onChange: (d: ISODate) => void
  presets?: Array<{ label: string; date: ISODate }>
  hint?: ReactNode
  min?: ISODate
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[13.5px] font-semibold text-ink-2">{label}</span>
      <DateChips label={label} value={value} onChange={onChange} presets={presets} min={min} />
      {hint && <p className="text-[12.5px] text-ink-3">{hint}</p>}
    </div>
  )
}

/** Blurs amounts in edit forms while the privacy blur (B) is on; focusing a field reveals it. */
export function Blurrable({ children }: { children: ReactNode }) {
  const blur = usePrefs((s) => s.privacyBlur)
  return <div className={cx('ft-private-wrap', blur && 'ft-private-wrap--on blur-[5px] focus-within:blur-none')}>{children}</div>
}

/** A short "applies to new X only" note under list editors. */
export function NewOnlyNote({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-[13px] text-ink-3">{children}</p>
}

/**
 * A link that looks like a kit Button (same hooks and sizes: 44px md, 48px lg). For navigation only,
 * never for actions. Like Button, its height is a minimum and a long label wraps inside it.
 */
export function ButtonLink({
  href,
  children,
  icon,
  variant = 'secondary',
  size = 'md',
  className,
  describedBy,
}: {
  href: string
  children: ReactNode
  icon?: IconName
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'md' | 'lg'
  className?: string
  describedBy?: string
}) {
  return (
    <a
      href={href}
      aria-describedby={describedBy}
      className={cx(
        'ft-btn',
        `ft-btn--${variant}`,
        `ft-btn--${size}`,
        'inline-flex max-w-full shrink-0 items-center justify-center text-center leading-tight font-semibold transition-colors select-none',
        size === 'lg' ? 'min-h-12 gap-2 rounded-xl px-5 py-2 text-[15.5px]' : 'min-h-11 gap-2 rounded-lg px-4 py-1.5 text-[14.5px]',
        variant === 'primary'
          ? 'border border-transparent bg-accent text-accent-ink shadow-sm hover:bg-accent-hover'
          : variant === 'ghost'
            ? 'border border-transparent bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink'
            : 'border border-line-strong bg-surface text-ink hover:bg-surface-2',
        className,
      )}
    >
      {icon && <Icon name={icon} size={18} className="ft-btn__icon shrink-0" />}
      {children}
    </a>
  )
}
