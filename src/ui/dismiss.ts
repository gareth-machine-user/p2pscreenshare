// Closing a menu or popover on a click outside it, or Escape.
import type { Action } from 'svelte/action'

/**
 * `use:dismissable={open ? close : null}` on the element holding both the toggle button and the
 * menu: `close` runs on a pointerdown outside that element, or on Escape. A press on the toggle
 * button is inside, so it doesn't close the menu just before the button's click toggles it.
 * Pass null while closed, so one anchor's handler can't close (and then re-toggle) another's menu.
 */
export const dismissable: Action<HTMLElement, (() => void) | null> = (node, close) => {
  let current = close ?? null
  const onPointer = (e: PointerEvent) => {
    if (current && !node.contains(e.target as Node)) current()
  }
  const onKey = (e: KeyboardEvent) => {
    if (current && e.key === 'Escape') current()
  }
  document.addEventListener('pointerdown', onPointer)
  document.addEventListener('keydown', onKey)
  return {
    update(next) {
      current = next ?? null
    },
    destroy() {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    },
  }
}
