// Focus helpers for Settings, Server and the Data tab's links into it: after a step changes what the
// tab shows, focus moves to where the next step starts, never to <body>.

/**
 * Moves focus to a panel's title once it is on screen (after a step changes what the tab shows), so
 * keyboard and screen reader users start at the new step. The title is not a control: no focus ring.
 * It waits up to `waitMs` for the panel (a server check may run first), and gives up if the person
 * moved focus somewhere else meanwhile.
 */
export function focusPanelTitle(panelId: string, waitMs = 700): void {
  focusWhenReady(() => {
    const el = document.querySelector<HTMLElement>(`#${panelId} .ft-panel__title`)
    if (el) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
      el.setAttribute('data-focus-target', '')
    }
    return el
  }, waitMs)
}

/**
 * Focuses what `find` returns as soon as it exists (checked every frame for up to `waitMs`). Skipped
 * when focus moved to another control in the meantime: only a focus that is gone (on the page, its
 * title, or an element that was removed) or still where it was is taken over.
 */
export function focusWhenReady(find: () => HTMLElement | null, waitMs = 700): void {
  if (typeof window === 'undefined') return
  const from = document.activeElement
  const start = Date.now()
  const attempt = () => {
    const el = find()
    if (el) {
      const now = document.activeElement
      const free = !now || now === document.body || now === from || !from?.isConnected || now.matches('#main h1, .ft-panel__title')
      if (free) el.focus()
      return
    }
    if (Date.now() - start < waitMs) requestAnimationFrame(attempt)
  }
  requestAnimationFrame(attempt)
}

/**
 * The sign-in form's next field: the password when the email is already filled in, else the email.
 * Used when someone arrives at Settings, Server to sign in again (from the banner or the header chip).
 */
export function focusSignInField(panelId = 'server-signin'): void {
  focusWhenReady(() => {
    const email = document.querySelector<HTMLInputElement>(`#${panelId} input[name="username"]`)
    if (!email) return null
    return email.value.trim() ? document.querySelector<HTMLInputElement>(`#${panelId} input[name="password"]`) : email
  })
}
