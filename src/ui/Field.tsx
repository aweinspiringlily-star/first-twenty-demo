// Form controls. Native elements throughout (they work with keyboard, screen readers and
// input-automation tools); every control takes a stable id so labels and autofill stay wired.
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { useEffect, useId, useState } from 'react'
import { usePrefs } from '@/store/prefs'
import { cx } from './cx'
import { Icon } from './Icon'
import { rovingKeyDown, rovingTabIndex } from './roving'

const CONTROL =
  'w-full rounded-lg border border-control bg-surface px-3 text-[14.5px] text-ink placeholder:text-ink-3 ' +
  'transition-colors hover:border-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 ' +
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-3'

// Hook classes (docs/LOOKS.md): text-like inputs carry ft-input, selects ft-select, text areas ft-textarea.
const INPUT = 'ft-input ' + CONTROL

/** Label + control + hint/error. Pass the control as children; it receives the id via render prop. */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
  id: idProp,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  children: (id: string, describedBy: string | undefined) => ReactNode
  className?: string
  id?: string
}) {
  const auto = useId()
  const id = idProp ?? `f${auto.replace(/:/g, '')}`
  const hintId = hint || error ? `${id}-hint` : undefined
  const invalid = !!error
  // Expose required and invalid state on the control itself (screen readers announce them).
  useEffect(() => {
    const el = document.getElementById(id)
    if (!el || (!/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && el.getAttribute('role') !== 'radiogroup')) return
    if (required) el.setAttribute('aria-required', 'true')
    else el.removeAttribute('aria-required')
    if (invalid) el.setAttribute('aria-invalid', 'true')
    else el.removeAttribute('aria-invalid')
  })
  return (
    <div className={cx('ft-field flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={id} className="ft-field__label text-[13.5px] font-semibold text-ink-2">
        {label}
        {required && (
          <span className="ft-field__required ml-0.5 text-bad" aria-hidden>
            *
          </span>
        )}
      </label>
      {children(id, hintId)}
      {(hint || error) && (
        <p id={hintId} className={cx('text-[12.5px]', error ? 'ft-field__error font-semibold text-bad' : 'ft-field__hint text-ink-3')}>
          {error || hint}
        </p>
      )}
    </div>
  )
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="text" className={cx(INPUT, 'h-11', className)} {...rest} />
}

export function TextArea({ className, rows = 4, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={rows} className={cx('ft-textarea', CONTROL, 'py-2 leading-relaxed', className)} {...rest} />
}

export type Option<V extends string = string> = { value: V; label: string; disabled?: boolean }

export function Select<V extends string = string>({
  options,
  placeholder,
  className,
  value,
  onChange,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> & {
  options: Array<Option<V>>
  placeholder?: string
  value: V | '' | undefined | null
  onChange: (value: V) => void
}) {
  return (
    <div className="ft-select-wrap relative">
      <select
        className={cx('ft-select', CONTROL, 'h-11 cursor-pointer appearance-none pr-9', className)}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value as V)}
        {...rest}
      >
        {placeholder !== undefined && (
          <option value="" disabled={rest.required}>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon
        name="chevron-down"
        size={16}
        className="ft-select__chevron pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-3"
      />
    </div>
  )
}

/**
 * Classes that hide a control's typed value under the privacy blur (key B) but keep the box crisp,
 * the same treatment <Private> gives amounts in text.
 */
const BLURRED_VALUE = 'ft-input--blurred select-none text-transparent caret-ink [text-shadow:0_0_9px_var(--ink)]'
const BLUR_TITLE = 'Hidden by privacy blur (press B or the eye button to show)'

/** Number input that stores a number (or null when empty). */
export function NumberInput({
  value,
  onChange,
  className,
  prefix,
  suffix,
  step,
  min,
  max,
  sensitive,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'prefix'> & {
  value: number | null | undefined
  onChange: (value: number | null) => void
  prefix?: string
  suffix?: string
  /**
   * Pay, rate or share count: hidden by the privacy blur. Defaults to true for dollar amounts,
   * share or option counts and percent-of-base fields.
   */
  sensitive?: boolean
}) {
  const blurOn = usePrefs((s) => s.privacyBlur)
  const isSensitive =
    sensitive ?? (prefix === '$' || /option|share|of base/i.test(suffix ?? '') || (!suffix && Number(step) >= 500))
  const blurred = blurOn && isSensitive
  return (
    <div className="relative flex items-center">
      {prefix && <span className="pointer-events-none absolute left-3 text-[14.5px] text-ink-3">{prefix}</span>}
      <input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        className={cx(INPUT, 'num h-11', prefix && 'pl-7', suffix && 'pr-12', blurred && BLURRED_VALUE, className)}
        title={blurred ? BLUR_TITLE : rest.title}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        {...rest}
      />
      {suffix && <span className="pointer-events-none absolute right-3 text-[13.5px] text-ink-3">{suffix}</span>}
    </div>
  )
}

/** Whole-dollar amount with thousands separators while typing. */
export function MoneyInput({
  value,
  onChange,
  className,
  suffix,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: number | null | undefined
  onChange: (value: number | null) => void
  suffix?: string
}) {
  const [focused, setFocused] = useState(false)
  // Every money field follows the privacy blur, so a prefilled salary never shows while screen sharing.
  const blurred = usePrefs((s) => s.privacyBlur)
  const display = value == null ? '' : focused ? String(value) : value.toLocaleString('en-US')
  return (
    <div className="relative flex items-center">
      <span className="pointer-events-none absolute left-3 text-[14.5px] text-ink-3">$</span>
      <input
        type="text"
        inputMode="numeric"
        title={blurred ? BLUR_TITLE : rest.title}
        className={cx(INPUT, 'num h-11 pl-7', suffix && 'pr-14', blurred && BLURRED_VALUE, className)}
        value={display}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const digits = e.target.value.replace(/[^\d.]/g, '')
          onChange(digits === '' ? null : Math.round(Number(digits)))
        }}
        {...rest}
      />
      {suffix && <span className="pointer-events-none absolute right-3 text-[13.5px] text-ink-3">{suffix}</span>}
    </div>
  )
}

export function DateInput({
  value,
  onChange,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  value: string | null | undefined
  onChange: (value: string) => void
}) {
  return (
    <input
      type="date"
      className={cx(INPUT, 'num h-11', className)}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    />
  )
}

export function DateTimeInput({
  value,
  onChange,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  /** Full ISO timestamp. */
  value: string | null | undefined
  onChange: (iso: string) => void
}) {
  const local = value ? toLocalInput(value) : ''
  return (
    <input
      type="datetime-local"
      className={cx(INPUT, 'num h-11', className)}
      value={local}
      onChange={(e) => e.target.value && onChange(new Date(e.target.value).toISOString())}
      {...rest}
    />
  )
}

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Checkbox with a large hit area (the whole row is clickable). */
export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled,
  id: idProp,
  className,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
  id?: string
  className?: string
}) {
  const auto = useId()
  const id = idProp ?? `cb${auto.replace(/:/g, '')}`
  return (
    <label
      htmlFor={id}
      className={cx(
        'ft-checkbox-row flex min-h-11 cursor-pointer items-start gap-3 rounded-lg py-2',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <input
        id={id}
        type="checkbox"
        className="ft-checkbox mt-0.5 h-[18px] w-[18px] shrink-0 cursor-pointer accent-[var(--accent)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-[14.5px] text-ink">{label}</span>
        {description && <span className="mt-0.5 block text-[13px] text-ink-3">{description}</span>}
      </span>
    </label>
  )
}

/** On/off switch (role="switch"). */
export function Switch({
  checked,
  onChange,
  label,
  description,
  id: idProp,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  description?: ReactNode
  id?: string
  disabled?: boolean
}) {
  const auto = useId()
  const id = idProp ?? `sw${auto.replace(/:/g, '')}`
  const descId = description ? `${id}-desc` : undefined
  // The whole row is the hit target: clicking the label or the description toggles the switch.
  return (
    <div
      className={cx('ft-switch-row flex min-h-11 items-center justify-between gap-4 py-1.5', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}
      onClick={(e) => {
        if (disabled || (e.target as HTMLElement).closest('button,a,label')) return
        onChange(!checked)
      }}
    >
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-[14.5px] text-ink">
          {label}
        </label>
        {description && (
          <span id={descId} className="mt-0.5 block text-[13px] text-ink-3">
            {description}
          </span>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={descId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('ft-switch', checked && 'ft-switch--on', 'relative inline-flex h-10 w-12 shrink-0 items-center justify-center rounded-full disabled:opacity-50')}
      >
        <span
          aria-hidden
          className={cx(
            'ft-switch__track relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
            checked ? 'bg-accent' : 'bg-surface ring-[1.5px] ring-inset ring-control',
          )}
        >
          <span
            className={cx(
              'ft-switch__thumb inline-block h-[18px] w-[18px] rounded-full shadow transition-transform',
              checked ? 'translate-x-[22px] bg-white' : 'translate-x-[3px] bg-ink-3',
            )}
          />
        </span>
      </button>
    </div>
  )
}

/** Segmented control for 2-5 mutually exclusive options (radio group semantics). */
export function Segmented<V extends string>({
  value,
  onChange,
  options,
  label,
  size = 'md',
  className,
  disabled,
  describedBy,
}: {
  value: V
  onChange: (value: V) => void
  options: Array<{ value: V; label: ReactNode; count?: number }>
  label: string
  size?: 'sm' | 'md'
  className?: string
  /** Turns the whole control off (pair it with a visible reason, linked through describedBy). */
  disabled?: boolean
  /** Id of the element that explains the control (for example why it is off). */
  describedBy?: string
}) {
  const states = options.map((o) => ({ on: o.value === value, disabled }))
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-describedby={describedBy}
      onKeyDown={(e) => rovingKeyDown(e, { select: true })}
      className={cx('ft-segmented', `ft-segmented--${size}`, 'inline-flex max-w-full flex-wrap gap-1 rounded-xl bg-surface-2 p-1', className)}
    >
      {options.map((o, i) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={rovingTabIndex(i, states)}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cx(
              'ft-segmented__item',
              active && 'ft-segmented__item--on',
              'inline-flex items-center gap-1.5 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              size === 'sm' ? 'h-10 px-2.5 text-[13px]' : 'h-10 px-3.5 text-[14px]',
              // The selected option carries an accent bar, not only a lighter fill (WCAG 1.4.11).
              active ? 'bg-surface text-ink shadow-[inset_0_-2px_0_var(--accent),0_1px_2px_rgb(0_0_0/0.08)]' : 'text-ink-2 hover:text-ink',
            )}
          >
            {o.label}
            {o.count != null && <span className="num text-[12px] text-ink-3">{o.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Search box with a clear button. */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  className,
  id,
  autoFocus,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  id?: string
  autoFocus?: boolean
}) {
  return (
    <div className={cx('ft-searchbox relative', className)}>
      <Icon name="search" size={17} className="ft-searchbox__icon pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" />
      <input
        id={id}
        type="search"
        aria-label={placeholder}
        autoFocus={autoFocus}
        className={cx(INPUT, 'h-11 pr-11 pl-9 [&::-webkit-search-cancel-button]:hidden')}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          className="absolute top-1/2 right-0.5 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="x" size={15} />
        </button>
      )}
    </div>
  )
}

/**
 * After a failed submit, moves focus to the first control marked invalid, so keyboard users land on
 * what to fix. Call it right after setting the errors (Field marks controls aria-invalid).
 */
export function focusFirstInvalid(root?: ParentNode): void {
  setTimeout(() => (root ?? document).querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 30)
}

/** Two-column responsive grid for forms. */
export function FormGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('grid grid-cols-1 gap-4 sm:grid-cols-2', className)}>{children}</div>
}
