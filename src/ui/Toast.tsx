// Lightweight toasts: toast('Offer sent') or toast({ text, tone, action, link }).
// An "Undo" action is bound to the change it was shown for: it only ever undoes that change, so an
// older toast can never undo a newer one, and a toast for a change that did nothing gets no Undo. A
// toast whose change has left the history (undone with Ctrl Z, or replaced by the server's copy after
// a sync conflict) goes away, so a stale Undo is never offered.
//
// Placement: bottom center. At phone width only the newest toast shows. While a sheet or dialog with a
// footer is open the stack sits just above that footer, and (in a sheet or on a page) it moves to the top
// when it would cover the focused control, so a toast never takes a tap meant for Save or a card's actions
// and never hides the field being filled in.
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { useDB } from '@/store/db'
import { cx } from './cx'
import { Icon } from './Icon'
import { restoreFocus } from './Overlay'

type ToastAction = { label: string; onClick: () => void }

type ToastItem = {
  id: number
  text: string
  tone: 'good' | 'neutral' | 'bad'
  action?: ToastAction
  /** A place to review what the change did ('Review in Training'). */
  link?: { label: string; href: string }
  /** True when the action is an Undo bound to one history entry (shows the Ctrl Z hint). */
  undo?: boolean
  /** The history entry the Undo is bound to. */
  entryId?: number
}

const useToasts = create<{ items: ToastItem[]; pushes: number; push: (t: Omit<ToastItem, 'id'>) => void; drop: (id: number) => void }>(
  (set) => ({
    items: [],
    pushes: 0,
    push: (t) => set((s) => ({ items: [...s.items.slice(-2), { ...t, id: Date.now() + Math.random() }], pushes: s.pushes + 1 })),
    drop: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  }),
)

/** History entries that already have an Undo toast, so a second toast for a no-op change cannot claim one. */
const claimed = new Set<number>()
/** A change counts as "just made" for this long after mutate; toasts are shown right after it. */
const FRESH_MS = 2500

/**
 * Binds an Undo action to the newest history entry. Returns null when there is no fresh, unclaimed
 * change (the action changed nothing), so the toast shows without an Undo button.
 */
function bindUndo(action: ToastAction): { action: ToastAction; entryId: number } | null {
  const { past } = useDB.getState()
  const top = past[past.length - 1]
  if (!top || claimed.has(top.id) || Date.now() - top.at > FRESH_MS) return null
  claimed.add(top.id)
  const entryId = top.id
  const label = top.label
  return {
    entryId,
    action: {
      label: action.label,
      onClick: () => {
        const now = useDB.getState().past
        const idx = now.findIndex((p) => p.id === entryId)
        if (idx === -1) {
          toast({ text: 'That change was already undone.', tone: 'neutral' })
          return
        }
        if (idx !== now.length - 1) {
          toast({ text: 'A newer change came after this one. Press Ctrl+Z to undo step by step.', tone: 'neutral' })
          return
        }
        const pushesBefore = useToasts.getState().pushes
        action.onClick()
        const after = useDB.getState().past
        // The feature's own handler may have undone it differently; make sure exactly this change is undone.
        if (after.some((p) => p.id === entryId)) useDB.getState().undoEntry(entryId)
        if (useToasts.getState().pushes === pushesBefore) toast({ text: `Undid: ${label}`, tone: 'neutral' })
      },
    },
  }
}

export function toast(
  t: string | { text: string; tone?: ToastItem['tone']; action?: ToastAction; link?: ToastItem['link'] },
): void {
  const item: Omit<ToastItem, 'id'> = typeof t === 'string' ? { text: t, tone: 'good' } : { tone: 'good', ...t }
  if (item.action && item.action.label === 'Undo') {
    const bound = bindUndo(item.action)
    if (bound) {
      item.action = bound.action
      item.entryId = bound.entryId
      item.undo = true
    } else delete item.action
  }
  useToasts.getState().push(item)
}

function ToastView({ item, hidden }: { item: ToastItem; hidden: boolean }) {
  const drop = useToasts((s) => s.drop)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hovered = useRef(false)
  const focused = useRef(false)
  const root = useRef<HTMLDivElement>(null)
  // Where focus was before it moved into the toast; it goes back there when the toast closes.
  const cameFrom = useRef<HTMLElement | null>(null)
  // Set when this toast's own Undo ran, so its history entry leaving is expected.
  const undid = useRef(false)
  /** Removes the toast; when it held keyboard focus, focus returns where it came from (never <body>). */
  const close = () => {
    const hadFocus = !!root.current?.contains(document.activeElement)
    drop(item.id)
    if (hadFocus) restoreFocus(cameFrom.current)
  }
  // Toasts with an action stay 12 seconds and pause while pointed at or focused (WCAG 2.2.1).
  const ms = item.action ? 12000 : 4500
  const start = () => {
    if (timer.current) clearTimeout(timer.current)
    if (hovered.current || focused.current) return
    timer.current = setTimeout(() => drop(item.id), ms)
  }
  const stop = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => {
    start()
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])
  // A toast tucked away behind a newer one (phone width) gets no mouseleave: keep its clock running.
  useEffect(() => {
    if (!hidden || !hovered.current) return
    hovered.current = false
    start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden])
  // The change this Undo belongs to left the history some other way (Ctrl Z, or a sync conflict kept the
  // server's copy): the toast no longer describes the data, and its Undo must never touch a newer state.
  const entryGone = useDB((s) => item.entryId !== undefined && !s.past.some((p) => p.id === item.entryId))
  useEffect(() => {
    if (entryGone && !undid.current) close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryGone])
  return (
    <div
      role="status"
      onMouseEnter={() => {
        hovered.current = true
        stop()
      }}
      onMouseLeave={() => {
        hovered.current = false
        start()
      }}
      onFocus={(e) => {
        const from = e.relatedTarget as HTMLElement | null
        if (from && !e.currentTarget.contains(from)) cameFrom.current = from
        focused.current = true
        stop()
      }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        focused.current = false
        start()
      }}
      ref={root}
      className={cx(
        'ft-toast',
        `ft-toast--${item.tone}`,
        'anim-pop pointer-events-auto flex max-w-full items-center gap-3 rounded-xl border border-line bg-surface py-1.5 pr-1.5 pl-3.5 shadow-pop',
        // Never hide the toast that holds keyboard focus.
        hidden && !focused.current && 'hidden',
      )}
    >
      <Icon
        name={item.tone === 'bad' ? 'alert' : item.tone === 'good' ? 'check' : 'info'}
        size={17}
        className={cx('ft-toast__icon shrink-0', item.tone === 'bad' ? 'text-bad' : item.tone === 'good' ? 'text-good' : 'text-ink-3')}
      />
      <span className={cx('ft-toast__text min-w-0 text-[14px] font-medium text-ink', item.link && 'flex flex-col items-start')}>
        <span>
          {item.text}
          {item.undo && <span className="sr-only">. Press Ctrl Z to undo.</span>}
        </span>
        {item.link && (
          <a
            href={item.link.href}
            onClick={() => drop(item.id)}
            className="ft-link ft-toast__link inline-flex min-h-10 items-center font-bold text-accent underline underline-offset-2"
          >
            {item.link.label}
          </a>
        )}
      </span>
      {item.action && (
        <button
          type="button"
          className="ft-toast__action h-10 shrink-0 rounded-lg px-3 text-[13.5px] font-bold text-accent hover:bg-accent-soft"
          aria-keyshortcuts={item.undo ? 'Control+Z' : undefined}
          onClick={() => {
            undid.current = true
            item.action?.onClick()
            close()
          }}
        >
          {item.action.label}
        </button>
      )}
      {item.undo && (
        <span className="hidden shrink-0 items-center gap-0.5 text-[12px] text-ink-3 md:inline-flex" aria-hidden>
          or
          <kbd className="ft-kbd ml-1 rounded border border-line-strong bg-surface-2 px-1 font-mono text-[11px] text-ink-2">Ctrl</kbd>
          <kbd className="ft-kbd rounded border border-line-strong bg-surface-2 px-1 font-mono text-[11px] text-ink-2">Z</kbd>
        </span>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={close}
        className="ft-toast__dismiss inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2"
      >
        <Icon name="x" size={15} />
      </button>
    </div>
  )
}

/** Below the sm breakpoint (38.75rem of body width, as in styles.css) only the newest toast shows. */
const NARROW_PX = 620

/** True while the app column is phone width, measured on the body (it honors the text size; matchMedia does not). */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const check = () => setNarrow(document.body.clientWidth < NARROW_PX)
    check()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(check)
    ro.observe(document.body)
    return () => ro.disconnect()
  }, [])
  return narrow
}

/** The footer of the topmost open sheet or dialog (where its Save or Cancel lives), if it has one. */
function openDialogFooter(): HTMLElement | null {
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')
  return dialogs[dialogs.length - 1]?.querySelector<HTMLElement>('[data-overlay-footer]') ?? null
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/**
 * Keeps the stack off the controls people are about to press: above an open dialog's footer, and at the
 * top of the window while at the bottom it would cover the focused control (a field low in a sheet, or on
 * a page). Runs only while toasts show; focus moves and scrolling place it again.
 */
function useToasterPlacement(ref: RefObject<HTMLDivElement | null>, active: boolean, shown: string) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const settle = (edge: 'bottom' | 'top', bottom = '') => {
      el.style.top = edge === 'top' ? '0px' : ''
      el.style.bottom = edge === 'top' ? 'auto' : bottom
      el.dataset.edge = edge
    }
    if (!active) {
      settle('bottom')
      return
    }
    let footer: HTMLElement | null = null
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => place())
    /** True when a visible toast sits over the focused control (focus inside a toast does not count). */
    function coversFocus(): boolean {
      const focusedEl = document.activeElement
      if (!el || !(focusedEl instanceof HTMLElement) || focusedEl === document.body || el.contains(focusedEl)) return false
      const box = focusedEl.getBoundingClientRect()
      return Array.from(el.children).some((t) => (t as HTMLElement).offsetParent !== null && overlaps(t.getBoundingClientRect(), box))
    }
    function place() {
      if (!el) return
      const foot = openDialogFooter()
      if (foot !== footer) {
        if (footer) ro?.unobserve(footer)
        if (foot) ro?.observe(foot)
        footer = foot
      }
      // Measure at the bottom edge, and calibrate CSS px against screen px (the text size zooms the page).
      el.style.top = 'auto'
      el.style.bottom = '0px'
      const atBottom = el.getBoundingClientRect().bottom
      if (foot) {
        el.style.bottom = '100px'
        const scale = (atBottom - el.getBoundingClientRect().bottom) / 100 || 1
        const lift = Math.max(0, atBottom - foot.getBoundingClientRect().top)
        settle('bottom', `${lift / scale}px`)
      } else settle('bottom')
      // Above the footer it can still sit on the focused control (a field low in the sheet): then it goes
      // to the top for as long as that control has focus.
      if (coversFocus()) settle('top')
    }
    place()
    // Sheets and dialogs render in portals at the end of <body>: watch them come and go.
    const mo = new MutationObserver(() => place())
    mo.observe(document.body, { childList: true })
    document.addEventListener('focusin', place)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      mo.disconnect()
      ro?.disconnect()
      document.removeEventListener('focusin', place)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [ref, active, shown])
}

export function Toaster() {
  const items = useToasts((s) => s.items)
  const ref = useRef<HTMLDivElement>(null)
  const narrow = useNarrow()
  // Placed again whenever the set of visible toasts changes.
  useToasterPlacement(ref, items.length > 0, `${items.map((i) => i.id).join(',')}:${narrow}`)
  // Padding on both ends (the strip itself is see-through and lets clicks pass), so it clears the safe
  // area at whichever edge it sits; useToasterPlacement moves it (data-edge="bottom" or "top").
  return (
    <div
      ref={ref}
      aria-live="polite"
      className="ft-toaster pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      {items.map((i, k) => (
        <ToastView key={i.id} item={i} hidden={narrow && k < items.length - 1} />
      ))}
    </div>
  )
}
