import '@testing-library/jest-dom/vitest'

/**
 * jsdom does not implement `matchMedia`, and the theme hook uses it to follow
 * the system preference while the user has not chosen one.
 *
 * Stubbed as "prefers light" with working listener registration, so the default
 * in tests is the light theme and the subscribe/unsubscribe path still runs —
 * a stub that threw on `addEventListener` would hide a leak rather than expose
 * it.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

/**
 * jsdom does not implement the native `<dialog>` element's modal behaviour, so
 * `showModal()` and `close()` are missing and the redeem dialog would throw on
 * open.
 *
 * Stubbed to the parts the component actually depends on: `open` reflecting
 * state, and a `close` event firing so the parent's state stays in sync. This
 * only substitutes for what the browser provides — focus trapping and the
 * backdrop are real browser behaviour and are the reason the native element was
 * chosen, but they are not what these tests assert.
 */
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }

  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
}
