// Lightweight toasts: toast('Offer sent') or toast({ text, tone, action }).
// An "Undo" action is bound to the change it was shown for: it only ever undoes that change, so an
// older toast can never undo a newer one, and a toast for a change that did nothing gets no Undo.
import { useEffect, useRef } from 'react'
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
  /** True when the action is an Undo bound to one history entry (shows the Ctrl Z hint). */
  undo?: boolean
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
function bindUndo(action: ToastAction): ToastAction | null {
  const { past } = useDB.getState()
  const top = past[past.length - 1]
  if (!top || claimed.has(top.id) || Date.now() - top.at > FRESH_MS) return null
  claimed.add(top.id)
  const entryId = top.id
  const label = top.label
  return {
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
  }
}

export function toast(t: string | { text: string; tone?: ToastItem['tone']; action?: ToastAction }): void {
  const item: Omit<ToastItem, 'id'> = typeof t === 'string' ? { text: t, tone: 'good' } : { tone: 'good', ...t }
  if (item.action && item.action.label === 'Undo') {
    const bound = bindUndo(item.action)
    if (bound) {
      item.action = bound
      item.undo = true
    } else delete item.action
  }
  useToasts.getState().push(item)
}

function ToastView({ item }: { item: ToastItem }) {
  const drop = useToasts((s) => s.drop)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hovered = useRef(false)
  const focused = useRef(false)
  const root = useRef<HTMLDivElement>(null)
  // Where focus was before it moved into the toast; it goes back there when the toast closes.
  const cameFrom = useRef<HTMLElement | null>(null)
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
      )}
    >
      <Icon
        name={item.tone === 'bad' ? 'alert' : item.tone === 'good' ? 'check' : 'info'}
        size={17}
        className={cx('ft-toast__icon shrink-0', item.tone === 'bad' ? 'text-bad' : item.tone === 'good' ? 'text-good' : 'text-ink-3')}
      />
      <span className="ft-toast__text min-w-0 text-[14px] font-medium text-ink">
        {item.text}
        {item.undo && <span className="sr-only">. Press Ctrl Z to undo.</span>}
      </span>
      {item.action && (
        <button
          type="button"
          className="ft-toast__action h-10 shrink-0 rounded-lg px-3 text-[13.5px] font-bold text-accent hover:bg-accent-soft"
          aria-keyshortcuts={item.undo ? 'Control+Z' : undefined}
          onClick={() => {
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

export function Toaster() {
  const items = useToasts((s) => s.items)
  return (
    <div
      aria-live="polite"
      className="ft-toaster pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      {items.map((i) => (
        <ToastView key={i.id} item={i} />
      ))}
    </div>
  )
}
